/**
 * Thin wrapper so `npm run probe` works during development.
 * The real implementation lives in src/probe.ts and is also reachable in
 * production images via `node dist/index.js --probe`.
 */
import { runProbe } from '../src/probe.js';

runProbe()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
