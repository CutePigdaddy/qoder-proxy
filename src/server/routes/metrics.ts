import type { Hono } from 'hono';
import { renderMetrics } from '../../obs/metrics.js';
import type { Deps } from '../deps.js';

export function registerMetrics(app: Hono, deps: Deps): void {
  app.get('/metrics', (c) => {
    deps.updateGauges();
    return c.text(renderMetrics(), 200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    });
  });
}
