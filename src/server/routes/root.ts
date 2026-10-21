import type { Hono } from 'hono';

/**
 * Service descriptor for API discovery. `/` itself now serves the dashboard,
 * so the machine-readable index lives at `/service`. No secrets: paths only.
 */
export function registerRoot(app: Hono): void {
  app.get('/service', (c) =>
    c.json({
      service: 'qoder-proxy',
      status: 'ok',
      // `/metrics` is deliberately absent: it is unauthenticated and leaks model
      // names, request volume and remaining quota. Scrape it from inside the
      // compose network instead.
      endpoints: ['/health', '/v1/models', '/v1/chat/completions', '/v1/quota'],
    }),
  );
}
