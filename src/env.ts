import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Load a `.env` file into process.env for local development.
 *
 * Docker injects variables via `env_file`, but `npm run dev` / `npm run probe`
 * start from a plain shell. Node 22 ships `process.loadEnvFile`, so use it when
 * present and fall back to a minimal parser otherwise.
 *
 * Real environment variables always win: the file only fills in the gaps.
 */
export function loadEnvFile(path = resolve(process.cwd(), '.env')): void {
  if (!existsSync(path)) return;

  const nativeLoader = (process as unknown as { loadEnvFile?: (file: string) => void }).loadEnvFile;
  if (typeof nativeLoader === 'function') {
    try {
      nativeLoader.call(process, path);
      return;
    } catch {
      // Fall through to the parser below.
    }
  }

  const content = readFileSync(path, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (!key) continue;

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) process.env[key] = value;
  }
}
