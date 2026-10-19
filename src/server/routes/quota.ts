import type { Hono } from 'hono';
import { HttpError } from '../../util/errors.js';
import type { Deps } from '../deps.js';

/**
 * Credit balance for the single upstream account this gateway wraps.
 *
 * Lives under `/v1/` so it inherits the Bearer-key gate and the edge allowlist.
 * A cached answer is served by default; `?refresh=1` forces an upstream call,
 * which is what a dashboard's manual refresh button should use.
 */
export function registerQuota(app: Hono, deps: Deps): void {
  app.get('/v1/quota', async (c) => {
    const force = /^(1|true|yes)$/i.test(c.req.query('refresh') ?? '');
    try {
      const snapshot = await deps.quota.get(force);
      c.header('Cache-Control', 'no-store');
      c.header('X-Quota-Cached', snapshot.cached ? 'true' : 'false');
      return c.json(snapshot);
    } catch (error) {
      const message = error instanceof HttpError ? error.message : String(error);
      deps.logger.warn({ err: message }, 'quota lookup failed');
      return c.json(
        {
          error: {
            message,
            type: 'upstream_error',
            code: 'quota_unavailable',
          },
        },
        502,
      );
    }
  });
}
