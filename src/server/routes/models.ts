import type { Hono } from 'hono';
import type { Deps } from '../deps.js';

export function registerModels(app: Hono, deps: Deps): void {
  app.get('/v1/models', async (c) => {
    const entries = await deps.resolver.list();
    return c.json({
      object: 'list',
      data: entries.map((entry) => ({
        id: entry.id,
        object: 'model',
        created: 0,
        owned_by: 'qoder',
        display_name: entry.displayName,
      })),
    });
  });
}
