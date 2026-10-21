import type { Hono } from 'hono';
import type { Deps } from '../deps.js';

/**
 * 请求日志存储接口
 */
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

/**
 * 时间序列数据点
 */
export interface TimeSeriesPoint {
  timestamp: number;
  value: number;
  label?: string;
}

/**
 * 按模型统计的数据
 */
export interface ModelStats {
  model: string;
  requests: number;
  totalTokens: number;
  avgDuration: number;
  successRate: number;
}

/**
 * 仪表盘汇总数据
 */
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

/**
 * 请求参数
 */
export interface QueryParams {
  hours?: number;
  limit?: number;
}

export function registerUsage(app: Hono, deps: Deps): void {
  // 获取仪表盘统计数据
  app.get('/v1/usage/dashboard', async (c) => {
    try {
      const hours = parseInt(c.req.query('hours') || '24', 10);
      const limit = parseInt(c.req.query('limit') || '50', 10);

      // TODO: 从持久化存储读取数据
      // 目前生成模拟数据用于演示
      const data = generateMockData(hours, limit);

      return c.json(data);
    } catch (error) {
      deps.logger.error({ err: error }, 'usage dashboard failed');
      return c.json(
        { error: 'Failed to fetch usage data' },
        500,
      );
    }
  });

  // 获取请求日志列表
  app.get('/v1/usage/logs', async (c) => {
    try {
      const hours = parseInt(c.req.query('hours') || '24', 10);
      const limit = parseInt(c.req.query('limit') || '100', 10);
      const model = c.req.query('model');

      // TODO: 从持久化存储读取数据
      const logs = generateMockLogs(hours, limit, model);

      return c.json({ logs });
    } catch (error) {
      deps.logger.error({ err: error }, 'usage logs failed');
      return c.json(
        { error: 'Failed to fetch logs' },
        500,
      );
    }
  });

  // 获取按模型的统计
  app.get('/v1/usage/models', async (c) => {
    try {
      const hours = parseInt(c.req.query('hours') || '24', 10);

      // TODO: 从持久化存储聚合数据
      const models = await getModelStats(hours);

      return c.json(models);
    } catch (error) {
      deps.logger.error({ err: error }, 'usage models failed');
      return c.json(
        { error: 'Failed to fetch model stats' },
        500,
      );
    }
  });
}

/**
 * 生成模拟数据（开发阶段使用）
 * TODO: 替换为真实数据存储和查询逻辑
 */
function generateMockData(hours: number, limit: number): DashboardData {
  const now = Date.now();
  const interval = (hours * 3600 * 1000) / 24; // 每小时一个点

  // 汇总统计
  const totalRequests = Math.floor(Math.random() * 1000) + 500;
  const totalTokens = totalRequests * Math.floor(Math.random() * 2000) + 1000;

  return {
    summary: {
      totalRequests,
      totalTokens,
      avgDuration: Math.random() * 3 + 1,
      errorRate: Math.random() * 5,
    },
    timeSeries: {
      requests: Array.from({ length: 24 }, (_, i) => ({
        timestamp: now - (23 - i) * interval,
        value: Math.floor(Math.random() * 50) + 20,
        label: new Date(now - (23 - i) * interval).toLocaleTimeString('zh-CN'),
      })),
      tokens: Array.from({ length: 24 }, (_, i) => ({
        timestamp: now - (23 - i) * interval,
        value: Math.floor(Math.random() * 50000) + 20000,
        label: new Date(now - (23 - i) * interval).toLocaleTimeString('zh-CN'),
      })),
      duration: Array.from({ length: 24 }, (_, i) => ({
        timestamp: now - (23 - i) * interval,
        value: Number((Math.random() * 3 + 1).toFixed(2)),
        label: new Date(now - (23 - i) * interval).toLocaleTimeString('zh-CN'),
      })),
    },
    byModel: [
      {
        model: 'kimi-k3',
        requests: 600,
        totalTokens: 800000,
        avgDuration: 2.5,
        successRate: 98.9,
      },
      {
        model: 'qwen-plus',
        requests: 200,
        totalTokens: 300000,
        avgDuration: 2.0,
        successRate: 97.5,
      },
      {
        model: 'deepseek-v3',
        requests: 150,
        totalTokens: 250000,
        avgDuration: 1.8,
        successRate: 96.8,
      },
    ],
    recentLogs: Array.from({ length: Math.min(limit, 20) }, (_, i) => ({
      id: `log-${now - i * 60000}`,
      timestamp: now - i * 60000,
      model: ['kimi-k3', 'qwen-plus', 'deepseek-v3'][i % 3],
      status: Math.random() > 0.03 ? 200 : 429,
      durationMs: Math.floor(Math.random() * 5000) + 500,
      promptTokens: Math.floor(Math.random() * 2000) + 100,
      completionTokens: Math.floor(Math.random() * 3000) + 200,
      totalTokens: Math.floor(Math.random() * 5000) + 300,
    })),
  };
}

/**
 * 生成模拟日志
 */
function generateMockLogs(hours: number, limit: number, modelFilter?: string): RequestLog[] {
  const now = Date.now();
  const logs: RequestLog[] = [];

  for (let i = 0; i < limit; i++) {
    const model = modelFilter || ['kimi-k3', 'qwen-plus', 'deepseek-v3'][i % 3];
    logs.push({
      id: `log-${now - i * 60000}`,
      timestamp: now - i * 60000,
      model,
      status: Math.random() > 0.03 ? 200 : 429,
      durationMs: Math.floor(Math.random() * 5000) + 500,
      promptTokens: Math.floor(Math.random() * 2000) + 100,
      completionTokens: Math.floor(Math.random() * 3000) + 200,
      totalTokens: Math.floor(Math.random() * 5000) + 300,
    });
  }

  return logs;
}

/**
 * 获取模型统计（TODO: 实现真实查询）
 */
async function getModelStats(hours: number): Promise<ModelStats[]> {
  const now = Date.now();
  const interval = (hours * 3600 * 1000) / 24;

  return [
    {
      model: 'kimi-k3',
      requests: Math.floor(Math.random() * 500) + 300,
      totalTokens: Math.floor(Math.random() * 500000) + 300000,
      avgDuration: Number((Math.random() * 2 + 1.5).toFixed(2)),
      successRate: Number((Math.random() * 2 + 97).toFixed(1)),
    },
    {
      model: 'qwen-plus',
      requests: Math.floor(Math.random() * 300) + 100,
      totalTokens: Math.floor(Math.random() * 300000) + 150000,
      avgDuration: Number((Math.random() * 1.5 + 1).toFixed(2)),
      successRate: Number((Math.random() * 2 + 96).toFixed(1)),
    },
    {
      model: 'deepseek-v3',
      requests: Math.floor(Math.random() * 200) + 50,
      totalTokens: Math.floor(Math.random() * 200000) + 100000,
      avgDuration: Number((Math.random() * 1 + 0.8).toFixed(2)),
      successRate: Number((Math.random() * 2 + 95).toFixed(1)),
    },
  ];
}
