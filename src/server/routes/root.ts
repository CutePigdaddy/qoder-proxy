import type { Hono } from 'hono';

/**
 * Landing route. A bare 404 on `/` reads as "the deployment is broken" to
 * anyone opening the domain in a browser, so answer with a service descriptor
 * instead. No secrets: paths only.
 */
export function registerRoot(app: Hono): void {
  app.get('/', (c) =>
    c.json({
      service: 'qoder-proxy',
      status: 'ok',
      endpoints: ['/health', '/metrics', '/v1/models', '/v1/chat/completions'],
    }),
  );
}
