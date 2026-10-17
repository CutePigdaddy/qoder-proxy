import { Hono } from 'hono';
import { authMiddleware } from './middleware/auth.js';
import { requestLogger } from './middleware/logging.js';
import { registerChat } from './routes/chat.js';
import { registerHealth } from './routes/health.js';
import { registerMetrics } from './routes/metrics.js';
import { registerModels } from './routes/models.js';
import type { Deps } from './deps.js';

export function createApp(deps: Deps): Hono {
  const app = new Hono();

  app.use('*', requestLogger(deps.logger));

  // Probes and metrics stay unauthenticated so container healthchecks and
  // Prometheus scraping work without embedding the client key.
  registerHealth(app, deps);
  registerMetrics(app, deps);

  app.use('/v1/*', authMiddleware(deps.config));
  registerChat(app, deps);
  registerModels(app, deps);

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
    deps.logger.error({ err: error.message }, 'unhandled gateway error');
    return c.json({ error: { message: 'Internal gateway error', type: 'server_error' } }, 500);
  });

  return app;
}
