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
      // `/metrics` is deliberately absent: the edge only proxies `/`, `/health`
      // and `/v1/*`, so advertising it here would point clients at a 404. Scrape
      // it from inside the compose network instead.
      endpoints: ['/health', '/v1/models', '/v1/chat/completions'],
    }),
  );
}
