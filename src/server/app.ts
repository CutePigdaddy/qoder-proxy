import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { redactSecrets } from '../obs/logger.js';
import { authMiddleware } from './middleware/auth.js';
import { requestLogger } from './middleware/logging.js';
import { registerChat } from './routes/chat.js';
import { registerHealth } from './routes/health.js';
import { registerMetrics } from './routes/metrics.js';
import { registerModels } from './routes/models.js';
import { registerQuota } from './routes/quota.js';
import { registerRoot } from './routes/root.js';
import type { Deps } from './deps.js';

export function createApp(deps: Deps): Hono {
  const app = new Hono();

  app.use('*', requestLogger(deps.logger));

  // Probes and metrics stay unauthenticated so container healthchecks and
  // Prometheus scraping work without embedding the client key.
  registerHealth(app, deps);
  registerMetrics(app, deps);
  registerRoot(app);

  // Auth runs first: an unauthenticated caller should not get us to buffer a
  // body on its behalf. `BODY_LIMIT` is enforced above the route because the
  // whole conversation is buffered and re-sent upstream — without a cap, one
  // oversized paste is enough to hurt the process.
  app.use('/v1/*', authMiddleware(deps.config));
  app.use(
    '/v1/*',
    bodyLimit({
      maxSize: deps.config.bodyLimit,
      onError: (c) =>
        c.json(
          {
            error: {
              message: `Request body exceeds the configured ${deps.config.bodyLimit} bytes`,
              type: 'invalid_request_error',
            },
          },
          413,
        ),
    }),
  );
  registerChat(app, deps);
  registerModels(app, deps);
  registerQuota(app, deps);

  app.notFound((c) =>
    c.json(
      {
        error: {
          message: `No route for ${c.req.method} ${new URL(c.req.url).pathname}`,
          type: 'invalid_request_error',
        },
      },
      404,
    ),
  );

  app.onError((error, c) => {
    // The last-resort handler is exactly where an upstream URL or body full of
    // credential material is most likely to surface, so redact like the routes do.
    deps.logger.error({ err: redactSecrets(error.message) }, 'unhandled gateway error');
    return c.json({ error: { message: 'Internal gateway error', type: 'server_error' } }, 500);
  });

  return app;
}
