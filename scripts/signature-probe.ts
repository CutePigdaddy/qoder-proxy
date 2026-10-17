/**
 * Signature probe — run this before building anything else on top of the wire
 * layer. It validates, in order:
 *   1. PAT -> job token exchange
 *   2. identity lookup (userID is required for signing)
 *   3. COSY signing against a real gateway endpoint (model/list)
 *
 * If step 3 returns 200, the signer and endpoint set are correct and the rest of
 * the gateway can trust them. If it fails, the problem is isolated to roughly
 * one hundred lines instead of the whole stack.
 *
 * This never prints a token.
 */
import { loadConfig } from '../src/config.js';
import { loadEnvFile } from '../src/env.js';
import { logger } from '../src/obs/logger.js';
import { buildCosyHeadersFor } from '../src/qoder/cosySigner.js';
import { CredentialStore } from '../src/qoder/credentialStore.js';
import { resolveEndpoints } from '../src/qoder/endpoints.js';

async function main(): Promise<void> {
  loadEnvFile();

  const config = loadConfig();
  if (/REPLACE|YOUR_PAT|xxxx/i.test(config.pat)) {
    console.error('QODERCN_PAT still looks like a placeholder.');
    console.error('Create a PAT at https://qoder.com.cn/account/integrations and put it in .env');
    process.exit(1);
  }
  const endpoints = resolveEndpoints();
  const credentials = new CredentialStore({
    pat: config.pat,
    cachePath: config.tokenCachePath,
    endpoints,
  });

  console.log('1/3  PAT -> job token');
  const creds = await credentials.get();
  console.log(`     ok  userId=${creds.userID}  expires=${new Date(creds.expiresAt).toISOString()}`);

  console.log('2/3  signing GET model/list');
  const headers = buildCosyHeadersFor(null, endpoints.modelList, creds);
  console.log(`     sigpath=${headers['Cosy-Sigpath']}  bodylength=${headers['Cosy-Bodylength']}`);

  const response = await fetch(endpoints.modelList, {
    headers: { ...headers, Accept: 'application/json', 'Accept-Encoding': 'identity' },
    signal: AbortSignal.timeout(20_000),
  });

  console.log(`3/3  HTTP ${response.status} ${response.statusText}`);
  const text = await response.text();
  console.log(`     body: ${text.slice(0, 600) || '(empty)'}`);

  if (!response.ok) {
    console.error('\nFAILED — the signer or endpoint set is wrong. Check:');
    console.error('  - QODERCN_PAT is a `pt-...` token for the CN site');
    console.error('  - QODER_CN_BASE_URL points at the gateway (not the dashboard host)');
    console.error('  - the COSY constants in src/qoder/cosySigner.ts still match the current client');
    process.exit(1);
  }

  let models: unknown = null;
  try {
    models = JSON.parse(text);
  } catch {
    // A non-JSON 200 still proves the signature was accepted.
  }
  const entries = Array.isArray(models)
    ? models
    : models && typeof models === 'object'
      ? ((models as Record<string, unknown>).data ?? (models as Record<string, unknown>).models ?? null)
      : null;
  console.log(`\nOK — signature accepted. catalog entries: ${Array.isArray(entries) ? entries.length : 'unknown'}`);
}

main().catch((error: unknown) => {
  logger.error({ err: error instanceof Error ? error.message : String(error) }, 'probe failed');
  process.exit(1);
});
