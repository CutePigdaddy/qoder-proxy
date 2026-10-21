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
  hitRate: number;
  cacheHitTokens: number;
  inputTokens: number;
  outputTokens: number;
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
}

/** /v1/models 的一行，字段与后端 snake_case 对齐 */
export interface ModelEntry {
  id: string;
  upstream_model: string;
  upstream_display_name: string;
  context_window: number | null;
  context_windows: number[];
  max_output_tokens: number;
  capabilities: { reasoning: boolean; vision: boolean };
  pricing: { factor: number | null; originalFactor: number | null; free: boolean };
  promotion: ModelPromotion | null;
  is_default: boolean;
  availability: ModelAvailability;
  usage: ModelUsage | null;
}

export interface ModelsResponse {
  object: 'list';
  data: ModelEntry[];
}
