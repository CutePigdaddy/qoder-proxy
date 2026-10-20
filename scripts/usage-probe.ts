/**
 * Raw upstream usage probe.
 *
 * Sends the same chat request twice per model through the production wire
 * layer (CredentialStore + COSY signing + WAF body codec) and prints the
 * unmodified usage payloads, so we can see whether the Qoder gateway reports
 * prompt-cache statistics (cached tokens / cache read / cache creation) in any
 * form. Prints no secrets.
 *
 * Usage: npx tsx scripts/usage-probe.ts
 */
import crypto from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { loadEnvFile } from '../src/env.js';
import { encodeQoderBody } from '../src/qoder/bodyCodec.js';
import { buildCosyHeadersFor } from '../src/qoder/cosySigner.js';
import { CredentialStore } from '../src/qoder/credentialStore.js';
import { resolveEndpoints } from '../src/qoder/endpoints.js';
import { decodeQoderSse } from '../src/qoder/sseDecoder.js';

const MODEL_KEYS = ['dfmodel', 'qmodel_38max'] as const;

/** ~1.2k tokens of stable prefix so prompt caching has something to latch onto. */
function longSystem(): string {
  const filler =
    'The cache probe keeps this system prompt byte-identical across requests. ';
  return filler.repeat(120);
}

function shortId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 32);
}

function buildBody(modelKey: string, stream: boolean): Record<string, unknown> {
  const lastUserText = 'Reply with the word ok.';
  const recordId = shortId();
  return {
    request_id: crypto.randomUUID(),
    request_set_id: recordId,
    chat_record_id: recordId,
    session_id: shortId(),
    stream,
    chat_task: 'FREE_INPUT',
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    session_type: 'qodercli',
    agent_id: 'agent_common',
    task_id: 'common',
    code_language: '',
    chat_prompt: '',
    image_urls: null,
    aliyun_user_type: '',
    messages: [
      { role: 'system', content: longSystem() },
      { role: 'user', content: lastUserText },
    ],
    tools: [],
    parameters: { max_tokens: 32 },
    chat_context: {
      chatPrompt: '',
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: { key: modelKey, is_reasoning: false },
        originalContent: lastUserText,
      },
      features: [],
      text: lastUserText,
    },
    model_config: { key: modelKey, is_reasoning: false },
    business: {
      product: 'cli',
      version: '1.0.0',
      type: 'agent',
      stage: 'start',
      id: crypto.randomUUID(),
      name: 'usage probe',
      begin_at: Date.now(),
    },
  };
}

interface Creds {
  jobToken: string;
  machineID: string;
}

async function send(
  endpoints: ReturnType<typeof resolveEndpoints>,
  creds: Creds,
  modelKey: string,
  stream: boolean,
): Promise<void> {
  const body = buildBody(modelKey, stream);
  const encoded = encodeQoderBody(Buffer.from(JSON.stringify(body)));
  const bytes = Buffer.from(encoded, 'utf8');
  const headers = buildCosyHeadersFor(bytes, endpoints.chat, creds as never);

  const response = await fetch(endpoints.chat, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: stream ? 'text/event-stream' : 'application/json',
      'Cache-Control': 'no-cache',
      'Accept-Encoding': 'identity',
      'X-Model-Key': modelKey,
      'X-Model-Source': 'system',
      ...headers,
    },
    body: bytes,
    signal: AbortSignal.timeout(120_000),
  });

  console.log(`\n=== ${modelKey} stream=${stream} HTTP ${response.status}`);

  if (!stream) {
    const text = await response.text();
    console.log(text.slice(0, 2500) || '(empty body)');
    return;
  }

  if (!response.body) {
    console.log('(no body)');
    return;
  }
  for await (const envelope of decodeQoderSse(response.body)) {
    if (!envelope.body || envelope.body === '[DONE]') continue;
    // Only print payloads that carry usage or error information.
    if (/usage|error|code/i.test(envelope.body)) {
      console.log(`envelope[${envelope.statusCodeValue}]: ${envelope.body.slice(0, 1200)}`);
    }
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const endpoints = resolveEndpoints();
  const store = new CredentialStore({
    pat: config.pat,
    cachePath: config.tokenCachePath,
    endpoints,
  });
  const creds = await store.get();
  console.log(`credentials ready (userId=${creds.userID})`);

  for (const modelKey of MODEL_KEYS) {
    // Two identical prompts over the only mode the gateway accepts (stream);
    // round 2 is where prompt cache should hit.
    await send(endpoints, creds, modelKey, true);
    await send(endpoints, creds, modelKey, true);
  }

  // One streaming pass to see whether SSE carries usage at all.
  await send(endpoints, creds, MODEL_KEYS[0], true);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
