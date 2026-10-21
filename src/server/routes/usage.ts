import type { Hono } from 'hono';
import type { Deps } from '../deps.js';

/**
 * 请求明细（与 cc-switch 对齐）：时间 / 应用 / 供应商 / 模型 / 新增输入 / 输出 / 缓存命中
 */
export interface UsageRow {
  id: string;
  /** Unix 毫秒时间戳 */
  timestamp: number;
  /** 发起调用的客户端 */
  application: string;
  /** 上游供应商 */
  provider: string;
  model: string;
  /** 本轮新增（未命中缓存）的输入 token */
  inputTokens: number;
  /** 输出 token */
  outputTokens: number;
  /** 命中缓存的输入 token */
  cacheHitTokens: number;
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
  /** 命中率 = cacheHitTokens / (cacheHitTokens + inputTokens) */
  hitRate: number;
  cacheHitTokens: number;
  inputTokens: number;
  outputTokens: number;
  /** 命中率趋势 */
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

const MOCK_APPLICATIONS = ['Claude Code', 'Codex', 'Cursor'];
const MOCK_PROVIDERS = ['Qoder CN'];
const MOCK_MODELS = ['Kimi-K3', 'Auto', 'DeepSeek-V3'];

function pick<T>(list: readonly T[], i: number, fallback: T): T {
  return list[i % list.length] ?? fallback;
}

export function registerUsage(app: Hono, deps: Deps): void {
  /** 仪表盘汇总：指标 + 缓存 + 趋势 + 分模型 + 明细，一次请求取全。 */
  app.get('/v1/usage/dashboard', (c) => {
    try {
      const hours = Number.parseInt(c.req.query('hours') || '24', 10);
      const limit = Number.parseInt(c.req.query('limit') || '50', 10);
      return c.json(
        buildDashboard(
          Number.isFinite(hours) ? hours : 24,
          Number.isFinite(limit) ? limit : 50,
        ),
      );
    } catch (error) {
      deps.logger.error({ err: error }, 'usage dashboard failed');
      return c.json({ error: 'Failed to fetch usage data' }, 500);
    }
  });
}

/**
 * Mock 数据：真实持久化接上之前，用于验证前端形状与交互。
 * 命中率取长上下文会话的真实量级（85%~99%），避免演示时出现不合理的 0%。
 */
function buildDashboard(hours: number, limit: number): DashboardData {
  const now = Date.now();
  const buckets = Math.min(Math.max(hours, 1), 24);
  const step = (hours * 3_600_000) / buckets;

  const trend: TimeSeriesPoint[] = Array.from({ length: buckets }, (_, i) => {
    const ts = now - (buckets - 1 - i) * step;
    return {
      timestamp: ts,
      value: Number((85 + Math.random() * 14).toFixed(1)),
      label: labelOf(ts, hours),
    };
  });

  const recentLogs: UsageRow[] = Array.from({ length: Math.min(limit, 50) }, (_, i) => {
    const ts = now - i * 90_000;
    return {
      id: `req-${ts}-${i}`,
      timestamp: ts,
      application: pick(MOCK_APPLICATIONS, i, 'Claude Code'),
      provider: pick(MOCK_PROVIDERS, i, 'Qoder CN'),
      model: pick(MOCK_MODELS, i, 'Auto'),
      inputTokens:
        Math.random() > 0.75 ? 200 + Math.floor(Math.random() * 6_000) : Math.floor(Math.random() * 1_500),
      outputTokens: 100 + Math.floor(Math.random() * 4_000),
      cacheHitTokens: 8_000 + Math.floor(Math.random() * 120_000),
    };
  });

  const inputTokens = recentLogs.reduce((n, r) => n + r.inputTokens, 0);
  const outputTokens = recentLogs.reduce((n, r) => n + r.outputTokens, 0);
  const cacheHitTokens = recentLogs.reduce((n, r) => n + r.cacheHitTokens, 0);
  const billableInput = inputTokens + cacheHitTokens;

  const byModel: ModelStats[] = MOCK_MODELS.map((model) => {
    const rows = recentLogs.filter((r) => r.model === model);
    const hit = rows.reduce((n, r) => n + r.cacheHitTokens, 0);
    const fresh = rows.reduce((n, r) => n + r.inputTokens, 0);
    return {
      model,
      requests: rows.length,
      inputTokens: fresh,
      outputTokens: rows.reduce((n, r) => n + r.outputTokens, 0),
      cacheHitTokens: hit,
      hitRate: hit + fresh === 0 ? 0 : Number(((hit / (hit + fresh)) * 100).toFixed(1)),
      avgDuration: Number((1.2 + Math.random() * 2.5).toFixed(2)),
    };
  });

  return {
    summary: {
      totalRequests: recentLogs.length + Math.floor(Math.random() * 200),
      totalTokens: billableInput + outputTokens,
      avgDuration: Number((1.4 + Math.random() * 1.6).toFixed(2)),
      errorRate: Number((Math.random() * 1.8).toFixed(1)),
    },
    cache: {
      hitRate: billableInput === 0 ? 0 : Number(((cacheHitTokens / billableInput) * 100).toFixed(1)),
      cacheHitTokens,
      inputTokens,
      outputTokens,
      trend,
    },
    timeSeries: {
      requests: series(buckets, step, now, hours, () => 20 + Math.floor(Math.random() * 60)),
      tokens: series(buckets, step, now, hours, () => 40_000 + Math.floor(Math.random() * 260_000)),
      duration: series(buckets, step, now, hours, () => Number((1.2 + Math.random() * 2).toFixed(2))),
    },
    byModel,
    recentLogs,
  };
}

function series(
  buckets: number,
  step: number,
  now: number,
  hours: number,
  value: () => number,
): TimeSeriesPoint[] {
  return Array.from({ length: buckets }, (_, i) => {
    const ts = now - (buckets - 1 - i) * step;
    return { timestamp: ts, value: value(), label: labelOf(ts, hours) };
  });
}

function labelOf(ts: number, hours: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours <= 24
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `${d.getMonth() + 1}/${d.getDate()}`;
}
