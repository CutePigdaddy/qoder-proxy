import type { Hono } from 'hono';
import type { Deps } from '../deps.js';

const HOURS_DEFAULT = 24;
const HOURS_MAX = 720;

interface ModelUsage {
  requests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  hitRate: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 按模型聚合窗口内的真实用量。目录页要回答两个问题：这个模型最近在用吗、
 * 命中率如何，所以直接把 usageStore 的窗口快照聚合成一行。
 */
function usageByModel(deps: Deps, hours: number): Map<string, ModelUsage> {
  const map = new Map<string, ModelUsage>();
  for (const row of deps.usage.since(Date.now() - hours * 3_600_000)) {
    const current =
      map.get(row.model) ??
      ({ requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, hitRate: 0 } satisfies ModelUsage);
    current.requests += 1;
    current.inputTokens += row.inputTokens;
    current.cachedTokens += row.cachedTokens;
    current.outputTokens += row.outputTokens;
    map.set(row.model, current);
  }
  for (const value of map.values()) {
    const billable = value.cachedTokens + value.inputTokens;
    value.hitRate = billable > 0 ? (value.cachedTokens / billable) * 100 : 0;
  }
  return map;
}

export function registerModels(app: Hono, deps: Deps): void {
  app.get('/v1/models', async (c) => {
    // refresh=1 绕过目录的 10 分钟缓存，供面板上的「刷新」按钮使用
    const refresh = c.req.query('refresh') === '1';
    const hours = clamp(Number(c.req.query('hours') ?? HOURS_DEFAULT) || HOURS_DEFAULT, 1, HOURS_MAX);

    const usage = usageByModel(deps, hours);
    const entries = await deps.resolver.list(refresh);

    return c.json({
      object: 'list',
      data: entries.map((entry) => ({
        id: entry.id,
        object: 'model',
        created: 0,
        owned_by: 'qoder',
        display_name: entry.displayName,
        // The key actually sent upstream, so operators can trace a request.
        upstream_model: entry.upstream,
        // 上游自己的名字；与 display_name 不同说明配置里改过名
        upstream_display_name: entry.upstreamDisplayName,
        context_window: entry.contextWindow,
        context_windows: entry.contextWindows,
        max_output_tokens: entry.maxOutputTokens,
        capabilities: entry.capabilities,
        pricing: entry.pricing,
        promotion: entry.promotion,
        is_default: entry.isDefault,
        // live / config-only / upstream-only：配置与上游目录是否对得上
        availability: entry.availability,
        usage: usage.get(entry.displayName) ?? null,
      })),
    });
  });
}
