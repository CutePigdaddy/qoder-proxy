import type { Hono } from 'hono';
import type { UsageRecord } from '../../obs/usageStore.js';
import type { Deps } from '../deps.js';

/** 请求明细（与 cc-switch 对齐）：时间 / 应用 / 供应商 / 模型 / 新增输入 / 输出 / 缓存命中 */
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

export interface DashboardData {
  summary: {
    totalRequests: number;
    totalTokens: number;
    avgDuration: number;
    errorRate: number;
  };
  cache: CacheSummary;
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
   */
  app.get('/v1/usage/dashboard', (c) => {
    try {
      const hours = clamp(Number.parseInt(c.req.query('hours') || '24', 10), 1, 720, 24);
      const limit = clamp(Number.parseInt(c.req.query('limit') || '50', 10), 1, 200, 50);
      return c.json(aggregate(deps.usage.since(Date.now() - hours * 3_600_000), hours, limit));
    } catch (error) {
      deps.logger.error({ err: error }, 'usage dashboard failed');
      return c.json({ error: 'Failed to fetch usage data' }, 500);
    }
  });
}

export function aggregate(events: UsageRecord[], hours: number, limit: number): DashboardData {
  const now = Date.now();
  const bucketMs = (hours * 3_600_000) / BUCKETS;

  const totals = events.reduce(
    (acc, e) => {
      acc.input += e.inputTokens;
      acc.cached += e.cachedTokens;
      acc.output += e.outputTokens;
      acc.duration += e.durationMs;
      if (e.status >= 400) acc.errors += 1;
      return acc;
    },
    { input: 0, cached: 0, output: 0, duration: 0, errors: 0 },
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
  }

  const requests: TimeSeriesPoint[] = [];
  const tokens: TimeSeriesPoint[] = [];
  const duration: TimeSeriesPoint[] = [];
  const rate: TimeSeriesPoint[] = [];

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
    const denom = bucket.input + bucket.cached;
    if (denom > 0) {
      rate.push({
        timestamp: bucket.start,
        value: Number(((bucket.cached / denom) * 100).toFixed(1)),
        label: bucket.label,
      });
    }
  }

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
    timeSeries: { requests, tokens, duration },
    byModel: groupByModel(events),
    recentLogs: events
      .slice(-limit)
      .reverse()
      .map((e, i) => ({
        id: `${e.ts}-${i}-${e.model}`,
        timestamp: e.ts,
        application: e.application,
        provider: e.provider,
        model: e.model,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        cacheHitTokens: e.cachedTokens,
        status: e.status,
      })),
  };
}

function groupByModel(events: UsageRecord[]): ModelStats[] {
  const buckets = new Map<
    string,
    { requests: number; input: number; cached: number; output: number; duration: number }
  >();

  for (const event of events) {
    let bucket = buckets.get(event.model);
    if (!bucket) {
      bucket = { requests: 0, input: 0, cached: 0, output: 0, duration: 0 };
      buckets.set(event.model, bucket);
    }
    bucket.requests += 1;
    bucket.input += event.inputTokens;
    bucket.cached += event.cachedTokens;
    bucket.output += event.outputTokens;
    bucket.duration += event.durationMs;
  }

  return [...buckets.entries()]
    .map(([model, b]) => {
      const denom = b.input + b.cached;
      return {
        model,
        requests: b.requests,
        inputTokens: b.input,
        outputTokens: b.output,
        cacheHitTokens: b.cached,
        hitRate: denom ? Number(((b.cached / denom) * 100).toFixed(1)) : 0,
        avgDuration: Number((b.duration / b.requests / 1000).toFixed(2)),
      };
    })
    .sort((a, b) => b.requests - a.requests);
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
