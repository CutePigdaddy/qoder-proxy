// 请求日志接口
export interface RequestLog {
  id: string;
  timestamp: number;
  model: string;
  status: number;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// 时间序列数据点
export interface TimeSeriesPoint {
  timestamp: number;
  value: number;
  label?: string;
}

// 按模型统计的数据
export interface ModelStats {
  model: string;
  requests: number;
  totalTokens: number;
  avgDuration: number;
  successRate: number;
}

// 仪表盘汇总数据
export interface DashboardData {
  summary: {
    totalRequests: number;
    totalTokens: number;
    avgDuration: number;
    errorRate: number;
  };
  timeSeries: {
    requests: TimeSeriesPoint[];
    tokens: TimeSeriesPoint[];
    duration: TimeSeriesPoint[];
  };
  byModel: ModelStats[];
  recentLogs: RequestLog[];
}
