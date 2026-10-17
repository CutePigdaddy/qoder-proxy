import type { MiddlewareHandler } from 'hono';
import type { Logger } from 'pino';

/** One structured line per request. Never logs bodies or credentials. */
export function requestLogger(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const started = Date.now();
    await next();
    logger.info(
      {
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status: c.res.status,
        durationMs: Date.now() - started,
      },
      'request',
    );
  };
}
