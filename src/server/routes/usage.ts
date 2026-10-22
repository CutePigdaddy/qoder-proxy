import type { Hono } from 'hono';
import {
  EMPTY_RATE_CARD,
  priceUsage,
  rateFor,
  rateView,
  roundMoney,
  type RateCard,
  type RateView,
} from '../../obs/pricing.js';
import type { UsageRecord } from '../../obs/usageStore.js';
import type { Deps } from '../deps.js';

/** 请求明细（与 cc-switch 对齐）：时间 / 应用 / 供应商 / 模型 / 新增输入 / 输出 / 缓存命中 / 成本 */
export interface UsageRow {
  id: string;
  timestamp: number;
  application: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  status: number;
  /** 按公开价目折算的本条成本（元）；null = 该模型没有价目，未计入 */
  cost: number | null;
}

export interface TimeSeriesPoint {
  timestamp: number;
  value: number;
  label?: string;
}

export interface ModelStats {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  hitRate: number;
  avgDuration: number;
  /** 窗口内该模型折算成本（元）；0 也可能是「未定价」，看 rate */
  cost: number;
}

export interface CacheSummary {
  /** 命中率 = 缓存命中 /（缓存命中 + 新增输入） */
  hitRate: number;
  cacheHitTokens: number;
  inputTokens: number;
  outputTokens: number;
  /** 只含有流量的时间桶，避免空闲时段把曲线压到 0 */
  trend: TimeSeriesPoint[];
}

export interface CostModelRow {
  model: string;
  requests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  cost: number;
  /** 该模型窗口内的综合单价：元 / 百万 tokens（含缓存优惠） */
  blended: number;
  /** 占总成本的比例（0–100） */
  share: number;
  /** 缓存命中省下的钱：命中部分按未命中价计的差额 */
  cacheSavings: number;
  /** null = 价目表里没有这个模型，成本未计入总额 */
  rate: RateView | null;
}

export interface CostSummary {
  currency: 'CNY';
  /** 价目表版本：核对日期 + 条数，面板上要写清楚「按哪一天的价」 */
  priceTable: { retrievedAt: string; models: number };
  /** 窗口内总成本（元） */
  total: number;
  /** 若缓存全部未命中的成本；与 total 的差就是缓存抵扣 */
  baseline: number;
  cacheSavings: number;
  avgPerRequest: number;
  /** 没有价目的模型：只报请求数，金额一律不猜 */
  unpriced: { requests: number; models: string[] };
  /** 按成本降序；未定价模型排最后 */
  byModel: CostModelRow[];
  trend: TimeSeriesPoint[];
}

export interface DashboardData {
  summary: {
    totalRequests: number;
    totalTokens: number;
    avgDuration: number;
    errorRate: number;
  };
  cache: CacheSummary;
  cost: CostSummary;
  timeSeries: {
    requests: TimeSeriesPoint[];
    tokens: TimeSeriesPoint[];
    duration: TimeSeriesPoint[];
  };
  byModel: ModelStats[];
  recentLogs: UsageRow[];
}

const BUCKETS = 24;

export function registerUsage(app: Hono, deps: Deps): void {
  /**
   * 全部指标由 `UsageStore` 里的真实请求记录聚合而来，没有任何模拟数据：
   * 没有流量就是 0，模型列表也只反映实际跑过的模型。
   * 成本一栏额外依赖价目表（`config/pricing.json`），逐条按记录的时间戳计价，
   * 所以 DeepSeek 的峰谷价、Qwen 的阶梯价都能落在正确的那一档上。
   */
  app.get('/v1/usage/dashboard', (c) => {
    try {
      const hours = clamp(Number.parseInt(c.req.query('hours') || '24', 10), 1, 720, 24);
      const limit = clamp(Number.parseInt(c.req.query('limit') || '50', 10), 1, 200, 50);
      return c.json(
        aggregate(deps.usage.since(Date.now() - hours * 3_600_000), hours, limit, deps.pricing),
      );
    } catch (error) {
      deps.logger.error({ err: error }, 'usage dashboard failed');
      return c.json({ error: 'Failed to fetch usage data' }, 500);
    }
  });
}

export function aggregate(
  events: UsageRecord[],
  hours: number,
  limit: number,
  card: RateCard = EMPTY_RATE_CARD,
): DashboardData {
  const now = Date.now();
  const bucketMs = (hours * 3_600_000) / BUCKETS;

  const totals = events.reduce(
    (acc, e) => {
      acc.input += e.inputTokens;
      acc.cached += e.cachedTokens;
      acc.output += e.outputTokens;
      acc.duration += e.durationMs;
      if (e.status >= 400) acc.errors += 1;
      const rate = rateFor(card, e.model);
      if (rate) {
        const price = priceUsage(card, rate, e);
        acc.cost += price.cost;
        acc.baseline += price.baseline;
      } else {
        acc.unpricedRequests += 1;
        acc.unpricedModels.add(e.model);
      }
      return acc;
    },
    {
      input: 0,
      cached: 0,
      output: 0,
      duration: 0,
      errors: 0,
      cost: 0,
      baseline: 0,
      unpricedRequests: 0,
      unpricedModels: new Set<string>(),
    },
  );

  const billable = totals.input + totals.cached;

  // 时间桶：请求数/Token 用 0 填充保持曲线连续；命中率只保留有计费输入的桶。
  const buckets = Array.from({ length: BUCKETS }, (_, i) => {
    const start = now - (BUCKETS - i) * bucketMs;
    return {
      start,
      label: labelOf(start, hours),
      requests: 0,
      input: 0,
      cached: 0,
      output: 0,
      durationMs: 0,
      cost: 0,
      counted: 0,
    };
  });

  const origin = now - BUCKETS * bucketMs;
  for (const event of events) {
    const index = Math.min(
      BUCKETS - 1,
      Math.max(0, Math.floor((event.ts - origin) / bucketMs)),
    );
    const bucket = buckets[index];
    if (!bucket) continue;
    bucket.requests += 1;
    bucket.input += event.inputTokens;
    bucket.cached += event.cachedTokens;
    bucket.output += event.outputTokens;
    bucket.durationMs += event.durationMs;
    bucket.counted += 1;
    const rate = rateFor(card, event.model);
    // 未定价模型不进成本曲线：画 0 会让曲线看起来「这段时间很便宜」
    if (rate) bucket.cost += priceUsage(card, rate, event).cost;
  }

  const requests: TimeSeriesPoint[] = [];
  const tokens: TimeSeriesPoint[] = [];
  const duration: TimeSeriesPoint[] = [];
  const rate: TimeSeriesPoint[] = [];
  const cost: TimeSeriesPoint[] = [];

  for (const bucket of buckets) {
    requests.push({ timestamp: bucket.start, value: bucket.requests, label: bucket.label });
    tokens.push({
      timestamp: bucket.start,
      value: bucket.input + bucket.cached + bucket.output,
      label: bucket.label,
    });
    duration.push({
      timestamp: bucket.start,
      value: bucket.counted
        ? Number((bucket.durationMs / bucket.counted / 1000).toFixed(2))
        : 0,
      label: bucket.label,
    });
    cost.push({ timestamp: bucket.start, value: roundMoney(bucket.cost), label: bucket.label });
    const denom = bucket.input + bucket.cached;
    if (denom > 0) {
      rate.push({
        timestamp: bucket.start,
        value: Number(((bucket.cached / denom) * 100).toFixed(1)),
        label: bucket.label,
      });
    }
  }

  const byModel = groupByModel(events, card);

  return {
    summary: {
      totalRequests: events.length,
      totalTokens: billable + totals.output,
      avgDuration: events.length ? Number((totals.duration / events.length / 1000).toFixed(2)) : 0,
      errorRate: events.length ? Number(((totals.errors / events.length) * 100).toFixed(1)) : 0,
    },
    cache: {
      hitRate: billable ? Number(((totals.cached / billable) * 100).toFixed(1)) : 0,
      cacheHitTokens: totals.cached,
      inputTokens: totals.input,
      outputTokens: totals.output,
      trend: rate,
    },
    cost: {
      currency: 'CNY',
      priceTable: { retrievedAt: card.retrievedAt, models: Object.keys(card.models).length },
      total: roundMoney(totals.cost),
      baseline: roundMoney(totals.baseline),
      cacheSavings: roundMoney(Math.max(0, totals.baseline - totals.cost)),
      avgPerRequest: events.length ? roundMoney(totals.cost / events.length) : 0,
      unpriced: { requests: totals.unpricedRequests, models: [...totals.unpricedModels] },
      byModel: byModel.map(({ durationMs, ...row }) => row),
      trend: cost,
    },
    timeSeries: { requests, tokens, duration },
    byModel: byModel.map(({ durationMs, ...row }) => ({
      model: row.model,
      requests: row.requests,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheHitTokens: row.cachedTokens,
      hitRate:
        row.inputTokens + row.cachedTokens > 0
          ? Number(((row.cachedTokens / (row.inputTokens + row.cachedTokens)) * 100).toFixed(1))
          : 0,
      avgDuration: row.requests ? Number((durationMs / row.requests / 1000).toFixed(2)) : 0,
      cost: row.cost,
    })),
    recentLogs: events
      .slice(-limit)
      .reverse()
      .map((e, i) => {
        const price = rateFor(card, e.model);
        return {
          id: `${e.ts}-${i}-${e.model}`,
          timestamp: e.ts,
          application: e.application,
          provider: e.provider,
          model: e.model,
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
          cacheHitTokens: e.cachedTokens,
          status: e.status,
          cost: price ? roundMoney(priceUsage(card, price, e).cost) : null,
        };
      }),
  };
}

/** 按模型聚合：token、成本、耗时一次算完，成本视图与命中率视图共用同一份分组。 */
function groupByModel(events: UsageRecord[], card: RateCard): Array<CostModelRow & { durationMs: number }> {
  const buckets = new Map<
    string,
    {
      requests: number;
      input: number;
      cached: number;
      output: number;
      durationMs: number;
      cost: number;
      baseline: number;
      rate: ReturnType<typeof rateFor>;
    }
  >();

  for (const event of events) {
    let bucket = buckets.get(event.model);
    if (!bucket) {
      bucket = {
        requests: 0,
        input: 0,
        cached: 0,
        output: 0,
        durationMs: 0,
        cost: 0,
        baseline: 0,
        rate: rateFor(card, event.model),
      };
      buckets.set(event.model, bucket);
    }
    bucket.requests += 1;
    bucket.input += event.inputTokens;
    bucket.cached += event.cachedTokens;
    bucket.output += event.outputTokens;
    bucket.durationMs += event.durationMs;
    if (bucket.rate) {
      const price = priceUsage(card, bucket.rate, event);
      bucket.cost += price.cost;
      bucket.baseline += price.baseline;
    }
  }

  const totalCost = [...buckets.values()].reduce((sum, b) => sum + b.cost, 0);

  return [...buckets.entries()]
    .map(([model, b]) => {
      const tokens = b.input + b.cached + b.output;
      return {
        model,
        requests: b.requests,
        inputTokens: b.input,
        cachedTokens: b.cached,
        outputTokens: b.output,
        durationMs: b.durationMs,
        cost: roundMoney(b.cost),
        blended: tokens > 0 ? roundMoney((b.cost / tokens) * 1_000_000) : 0,
        share: totalCost > 0 ? Number(((b.cost / totalCost) * 100).toFixed(1)) : 0,
        cacheSavings: roundMoney(Math.max(0, b.baseline - b.cost)),
        rate: b.rate ? rateView(b.rate) : null,
      };
    })
    // 成本降序；未定价模型（cost 恒为 0）自然沉到后面，按请求数排
    .sort((a, b) => b.cost - a.cost || b.requests - a.requests || a.model.localeCompare(b.model));
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function labelOf(ts: number, hours: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours <= 24
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `${d.getMonth() + 1}/${d.getDate()}`;
}
