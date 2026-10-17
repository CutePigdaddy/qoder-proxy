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
  },
});
