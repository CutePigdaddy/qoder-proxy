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
  /** 按公开价目折算的成本（元）；null = 该模型没有价目 */
  cost?: number | null;
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
  hitRate: number;
  cacheHitTokens: number;
  inputTokens: number;
  outputTokens: number;
  trend: TimeSeriesPoint[];
}

/** 成本视图：按模型汇总 */
export interface CostModelRow {
  model: string;
  requests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  cost: number;
  /** 综合单价：元 / 百万 tokens（含缓存优惠） */
  blended: number;
  /** 占总成本比例（0–100） */
  share: number;
  /** 缓存抵扣：命中部分按未命中价计的差额 */
  cacheSavings: number;
  /** null = 价目表里没有，成本未计入总额 */
  rate: RateView | null;
}

/** 公开人民币价目视图 */
export interface RateView {
  input: number;
  cachedInput: number;
  output: number;
  tiers: number;
  peak: { windows: string[]; multiplier: number } | null;
  confidence: 'official' | 'estimate';
  source: { label: string; url?: string } | null;
  note: string | null;
}
export interface CostSummary {
  currency: 'CNY';
  priceTable: { retrievedAt: string; models: number };
  total: number;
  baseline: number;
  cacheSavings: number;
  avgPerRequest: number;
  unpriced: { requests: number; models: string[] };
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

/** 失败环节：validate 网关校验 / queue 排队 / upstream 上游调用 */
export type ErrorStage = 'validate' | 'queue' | 'upstream';

/** 失败的语义分类：比 HTTP 状态码更接近「为什么失败」 */
export type ErrorType =
  | 'quota'
  | 'credential'
  | 'busy'
  | 'rate-limit'
  | 'timeout'
  | 'client-gone'
  | 'invalid'
  | 'input-limit'
  | 'upstream';

/** 错误明细行；与后端 routes/usage.ts 的 ErrorRow 对齐 */
export interface ErrorRow {
  id: string;
  timestamp: number;
  application: string;
  model: string;
  status: number;
  stage: ErrorStage;
  type: ErrorType;
  message: string;
  durationMs: number;
}

/** 日志页数据：请求与错误两份明细一次拉取 */
export interface LogsData {
  requests: UsageRow[];
  errors: ErrorRow[];
}

/** live：配置与上游都有；config-only：仅配置；upstream-only：上游新增未映射 */
export type ModelAvailability = 'live' | 'config-only' | 'upstream-only';

export interface ModelPromotion {
  active: boolean;
  badge?: string;
  description?: string;
  discountFactor?: number;
  beforeFactor?: number;
  window?: string;
}

export interface ModelUsage {
  requests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  hitRate: number;
  /** 窗口内单次最大输入 tokens */
  peakPromptTokens: number;
}

/** /v1/models 的一行，字段与后端 snake_case 对齐 */
export interface ModelEntry {
  id: string;
  upstream_model: string;
  upstream_display_name: string | null;
  context_window: number | null;
  context_windows: number[];
  max_output_tokens: number;
  capabilities: { reasoning: boolean; vision: boolean };
  pricing: { factor: number | null; originalFactor: number | null; free: boolean };
  promotion: ModelPromotion | null;
  is_default: boolean;
  availability: ModelAvailability;
  /** 网关侧输入上限；null 表示不限制 */
  input_limit: number | null;
  /** 公开人民币价目；null = 价目表里没有，面板显示「未定价」 */
  rate: RateView | null;
  usage: ModelUsage | null;
}

export interface ModelsResponse {
  object: 'list';
  data: ModelEntry[];
}
