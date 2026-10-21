import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * NodeNext source files import siblings as `./x.js` while the file on disk is
 * `./x.ts`. Vite does not rewrite that by default, so do it here.
 */
const resolveTsFromJs = {
  name: 'resolve-ts-from-js',
  enforce: 'pre' as const,
  resolveId(source: string, importer: string | undefined) {
    if (!importer || !source.startsWith('.') || !source.endsWith('.js')) return null;
    const base = importer.startsWith('file:') ? path.dirname(fileURLToPath(importer)) : path.dirname(importer);
    const target = path.resolve(base, source);
    const candidate = target.replace(/\.js$/, '.ts');
    return existsSync(candidate) ? candidate : null;
  },
};

export default defineConfig({
  plugins: [resolveTsFromJs],
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The default `forks` pool intermittently fails to write vitest's SSR module
    // cache on Windows (`EPERM ... \Temp\...\ssr\...`) and then silently drops a
    // whole test file from the run — the totals shrink while everything still
    // reports "passed". The `threads` pool has been stable across repeated runs,
    // and a suite that quietly skips files is worse than no suite.
    pool: 'threads',
  },
});
