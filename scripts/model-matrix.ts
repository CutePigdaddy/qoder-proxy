/**
 * Diagnostic: probe every model the live catalog advertises and report which
 * ones this account can actually use.
 *
 *   npx tsx scripts/model-matrix.ts
 *
 * Prints key / display name / gating metadata / latency / error.
 */
import { loadEnvFile } from '../src/env.js';
import { CredentialStore } from '../src/qoder/credentialStore.js';
import { QoderClient } from '../src/qoder/client.js';
import { resolveEndpoints } from '../src/qoder/endpoints.js';
import { buildCosyHeadersFor } from '../src/qoder/cosySigner.js';
import { ModelCatalog } from '../src/qoder/modelCatalog.js';

loadEnvFile();

const pat = process.env.QODERCN_PAT?.trim();
if (!pat) {
  console.error('QODERCN_PAT is required');
  process.exit(2);
}

const endpoints = resolveEndpoints();
const credentials = new CredentialStore({ pat, cachePath: '.cache/tokens.json', endpoints });

async function rawCatalog(): Promise<unknown> {
  const creds = await credentials.get();
  const headers = buildCosyHeadersFor(null, endpoints.modelList, creds);
  const response = await fetch(endpoints.modelList, {
    headers: { ...headers, Accept: 'application/json', 'Accept-Encoding': 'identity' },
    signal: AbortSignal.timeout(20_000),
  });
  return response.json();
}

async function main(): Promise<void> {
  const raw = await rawCatalog();
  const list = (raw as { chat?: unknown[] }).chat ?? [];
  console.log(`raw catalog entries: ${list.length}\n`);
  for (const item of list) {
    const record = item as Record<string, unknown>;
    console.log(
      [
        `key=${String(record.key)}`,
        `name=${String(record.display_name)}`,
        `enable=${String(record.enable)}`,
        `minimal_version=${JSON.stringify(record.minimal_version ?? null)}`,
        `price_factor=${String(record.price_factor)}`,
      ].join('  '),
    );
  }

  const catalog = new ModelCatalog({ endpoints, credentials });
  const entries = await catalog.list(true);
  const client = new QoderClient({ endpoints, credentials });

  console.log(`\n--- live call matrix (${entries.length} entries) ---`);
  for (const entry of entries) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    let text = '';
    let status = 'ok';
    try {
      for await (const event of client.chat(
        {
          model: entry.key,
          messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
          maxTokens: 2048,
          stream: true,
        },
        {
          key: entry.key,
          id: entry.displayName,
          isReasoning: entry.isReasoning,
          maxOutputTokens: entry.maxOutputTokens,
        },
        controller.signal,
      )) {
        if (event.type === 'text-delta') text += event.text;
      }
    } catch (error) {
      status = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }
    const ms = Date.now() - started;
    const suffix = status === 'ok' ? `OK  ${text.trim().slice(0, 24)}` : `FAIL ${status.slice(0, 160)}`;
    console.log(
      `${entry.key.padEnd(16)} ${String(entry.displayName).padEnd(18)} ${String(ms).padStart(6)}ms  ${suffix}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
