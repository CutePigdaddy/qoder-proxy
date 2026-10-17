import type { Hono } from 'hono';
import type { Deps } from '../deps.js';

/**
 * Liveness endpoint. Deliberately does not call the upstream: a container probe
 * must not burn quota or fail because Qoder is briefly slow.
 */
export function registerHealth(app: Hono, deps: Deps): void {
  app.get('/health', (c) => {
    const snapshot = deps.credentials.snapshot;
    return c.json({
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - deps.startTime) / 1000),
      authConfigured: deps.config.authEnabled,
      credentials: snapshot ? 'cached' : 'pending',
      inFlight: deps.gate.inFlight,
      queued: deps.gate.depth,
    });
  });
}
