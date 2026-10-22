import type { Hono } from 'hono';
import { priceUsage, rateFor, rateView } from '../../obs/pricing.js';
import type { Deps } from '../deps.js';

const HOURS_DEFAULT = 24;
const HOURS_MAX = 720;

interface ModelUsage {
  requests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  hitRate: number;
  /** 窗口内按公开价目折算的成本（元）；模型无价目时恒为 0 */
  cost: number;
  /** 窗口内单次最大输入（新增 + 命中），用来判断哪些请求真的顶到了上下文 */
  peakPromptTokens: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 按模型聚合窗口内的真实用量。目录页要回答三个问题：这个模型最近在用吗、
 * 命中率如何、单次最大吃了多少上下文，以及这段时间它花掉多少钱。
 */
function usageByModel(deps: Deps, hours: number): Map<string, ModelUsage> {
  const map = new Map<string, ModelUsage>();
  for (const row of deps.usage.since(Date.now() - hours * 3_600_000)) {
    const current =
      map.get(row.model) ??
      ({
        requests: 0,
        inputTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
        hitRate: 0,
        cost: 0,
        peakPromptTokens: 0,
      } satisfies ModelUsage);
    current.requests += 1;
    current.inputTokens += row.inputTokens;
    current.cachedTokens += row.cachedTokens;
    current.outputTokens += row.outputTokens;
    current.peakPromptTokens = Math.max(current.peakPromptTokens, row.inputTokens + row.cachedTokens);
    const rate = rateFor(deps.pricing, row.model);
    if (rate) current.cost += priceUsage(deps.pricing, rate, row).cost;
    map.set(row.model, current);
  }
  for (const value of map.values()) {
    const billable = value.cachedTokens + value.inputTokens;
    value.hitRate = billable > 0 ? (value.cachedTokens / billable) * 100 : 0;
    value.cost = Math.round(value.cost * 1e6) / 1e6;
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
      // 当日探测预算；null = 探测关闭或未设上限。面板据此提示「探测已停」
      probe_budget: deps.probe?.budget() ?? null,
      data: entries.map((entry) => {
        const rate = rateFor(deps.pricing, entry.displayName);
        return {
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
          // 网关侧输入上限：null = 不限制（上游本身不拦，这个闸门是我们自己设的）
          input_limit: deps.limits.get(entry.displayName),
          // 公开人民币价目（元 / 百万 tokens）；null = 价目表里没有，面板显示「未定价」
          rate: rate ? rateView(rate) : null,
          // 最近 5 分钟实测可用性（每 30s 探一次）。null = 探测关闭或还没有样本
          probe: deps.probe?.summary(entry.displayName) ?? null,
          usage: usage.get(entry.displayName) ?? null,
        };
      }),
    });
  });

  /**
   * 设置 / 清除网关侧的每模型输入上限。
   * 请求体：{ "limits": { "Qwen3.8-Max": 200000, "GLM-5.3": null } }
   */
  app.put('/v1/models/limits', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { message: 'Request body must be valid JSON', type: 'invalid_request_error' } }, 400);
    }

    const updates = (body as { limits?: unknown }).limits;
    if (updates === null || typeof updates !== 'object' || Array.isArray(updates)) {
      return c.json(
        { error: { message: 'Expected {"limits":{"<model>": <tokens|null>}}', type: 'invalid_request_error' } },
        400,
      );
    }

    // 先整批校验再落盘：避免一半改成功、一半报错，留下中间状态
    const parsed: Array<{ id: string; limit: number | null }> = [];
    for (const [id, value] of Object.entries(updates as Record<string, unknown>)) {
      if (value === null) {
        parsed.push({ id, limit: null });
        continue;
      }
      const limit = Number(value);
      if (!Number.isFinite(limit) || limit <= 0) {
        return c.json(
          {
            error: {
              message: `Invalid limit for ${id}: expected a positive token count or null`,
              type: 'invalid_request_error',
            },
          },
          400,
        );
      }
      parsed.push({ id, limit: Math.floor(limit) });
    }

    for (const item of parsed) deps.limits.set(item.id, item.limit);
    return c.json({ limits: deps.limits.all() });
  });
}
