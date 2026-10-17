import { loadConfig } from './config.js';
import { loadEnvFile } from './env.js';
import { buildCosyHeadersFor } from './qoder/cosySigner.js';
import { CredentialStore } from './qoder/credentialStore.js';
import { resolveEndpoints } from './qoder/endpoints.js';

/**
 * End-to-end verification of the two things that cannot be unit tested:
 * credential exchange and COSY signing against the live gateway.
 *
 * Runs the same code path the server uses, so a green result here means the
 * wire layer is sound. Prints no secrets.
 *
 * @returns process exit code (0 = signature accepted).
 */
export async function runProbe(): Promise<number> {
  loadEnvFile();

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Hint: run this from the project root, or make sure .env exists.');
    return 1;
  }

  if (/REPLACE|YOUR_PAT|xxxx/i.test(config.pat)) {
    console.error('QODERCN_PAT still looks like a placeholder.');
    console.error('Create a PAT at https://qoder.com.cn/account/integrations and put it in .env');
    return 1;
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
    console.error('\nFAILED — the signer or the endpoint set is wrong. Check:');
    console.error('  - QODERCN_PAT is a `pt-...` token issued by the CN site');
    console.error('  - QODER_CN_BASE_URL points at the gateway, not the dashboard host');
    console.error('  - the COSY constants in src/qoder/cosySigner.ts still match the client');
    return 1;
  }

  let models: unknown = null;
  try {
    models = JSON.parse(text);
  } catch {
    // A non-JSON 200 still proves the signature was accepted.
  }
  const record = models !== null && typeof models === 'object' ? (models as Record<string, unknown>) : null;
  const entries = Array.isArray(models) ? models : (record?.chat ?? record?.data ?? record?.models ?? null);
  console.log(`\nOK — signature accepted. catalog entries: ${Array.isArray(entries) ? entries.length : 'unknown'}`);
  return 0;
}
