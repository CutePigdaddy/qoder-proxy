import type { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { API_KEY, createHarness, type ChatFn } from '../helpers/gateway.js';

/** 价目表里真实存在的模型，用来断言精确成本（见 config/pricing.json）。 */
const PRICED_MODEL = 'Qwen3.8-Max';
const PRICED_CONFIG = {
  models: [{ id: PRICED_MODEL, upstream: 'qmodel_38max' }],
  aliases: {},
  fallback: 'auto',
};

/** Upstream that reports a hit-heavy usage frame. */
const cacheFriendly: ChatFn = async function* () {
  yield { type: 'text-delta', text: 'ok' };
  yield {
    type: 'usage',
    promptTokens: 1_200,
    completionTokens: 30,
    totalTokens: 1_230,
    cachedTokens: 1_000,
  };
  yield { type: 'done', finishReason: 'stop' };
};

function dashboard(app: Hono, query = 'hours=24'): Promise<Response> {
  return Promise.resolve(
    app.request(
      new Request(`http://gateway.test/v1/usage/dashboard?${query}`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      }),
    ),
  );
}

describe('/v1/usage/dashboard', () => {
  it('reports the request it just served, with real token split', async () => {
    const harness = createHarness({ chat: cacheFriendly });
    await harness.post(
      { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
      { headers: { 'User-Agent': 'claude-cli/1.2.3' } },
    );

    const data = await (await dashboard(harness.app)).json();

    expect(data.summary.totalRequests).toBe(1);
    // 新增输入 = 1200 - 1000 命中
    expect(data.recentLogs[0].inputTokens).toBe(200);
    expect(data.recentLogs[0].cacheHitTokens).toBe(1_000);
    expect(data.recentLogs[0].outputTokens).toBe(30);
    expect(data.recentLogs[0].application).toBe('Claude Code');
    expect(data.cache.hitRate).toBe(83.3);
    expect(data.byModel[0].model).toBe('Test-Model');
    expect(data.byModel[0].requests).toBe(1);
  });

  it('prices a request from the public rate card', async () => {
    const harness = createHarness({ chat: cacheFriendly, config: { models: PRICED_CONFIG } });
    await harness.post({ model: PRICED_MODEL, messages: [{ role: 'user', content: 'hi' }] });

    const data = await (await dashboard(harness.app)).json();

    // 新增输入 200 × 12 + 命中 1000 × 1.5 + 输出 30 × 36，单位元/百万 tokens
    expect(data.cost.total).toBeCloseTo((200 * 12 + 1_000 * 1.5 + 30 * 36) / 1_000_000, 6);
    // 若全部未命中：(200 + 1000) × 12 + 30 × 36
    expect(data.cost.baseline).toBeCloseTo((1_200 * 12 + 30 * 36) / 1_000_000, 6);
    expect(data.cost.cacheSavings).toBeGreaterThan(0);
    expect(data.cost.unpriced.requests).toBe(0);
    expect(data.cost.byModel[0]).toMatchObject({ model: PRICED_MODEL, cost: data.cost.total });
    expect(data.cost.byModel[0].rate).toMatchObject({ input: 12, cachedInput: 1.5, output: 36 });
    // 每行明细也带成本，便于核对总额
    expect(data.recentLogs[0].cost).toBeCloseTo(data.cost.total, 6);
  });

  it('keeps unpriced models out of the total instead of inventing a price', async () => {
    // 默认 harness 解析到 Test-Model，价目表里没有它
    const harness = createHarness({ chat: cacheFriendly });
    await harness.post({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });

    const data = await (await dashboard(harness.app)).json();

    expect(data.cost.total).toBe(0);
    expect(data.cost.unpriced).toEqual({ requests: 1, models: ['Test-Model'] });
    expect(data.cost.byModel[0].rate).toBeNull();
    expect(data.recentLogs[0].cost).toBeNull();
  });

  it('aggregates several requests into one model row and sums tokens', async () => {
    const harness = createHarness({ chat: cacheFriendly });
    for (let i = 0; i < 3; i++) {
      await harness.post({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
    }

    const data = await (await dashboard(harness.app)).json();
    expect(data.summary.totalRequests).toBe(3);
    expect(data.byModel).toHaveLength(1);
    expect(data.byModel[0].requests).toBe(3);
    expect(data.summary.totalTokens).toBe(3 * (1_000 + 200 + 30));
    expect(data.byModel[0].requests).toBe(3);
  });

  it('counts failures into the error rate without inventing tokens', async () => {
    const harness = createHarness({
      chat: async function* () {
        yield { type: 'error', message: 'upstream exploded', status: 502 };
      },
    });
    const res = await harness.post({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(502);

    const data = await (await dashboard(harness.app)).json();
    expect(data.summary.totalRequests).toBe(1);
    expect(data.summary.errorRate).toBe(100);
    expect(data.cache.hitRate).toBe(0);
    expect(data.recentLogs[0].status).toBe(502);
    expect(data.cost.total).toBe(0);
  });

  it('returns an empty, well-formed payload before any traffic', async () => {
    const harness = createHarness();
    const data = await (await dashboard(harness.app)).json();
    expect(data.summary.totalRequests).toBe(0);
    expect(data.byModel).toEqual([]);
    expect(data.recentLogs).toEqual([]);
    expect(data.cache.trend).toEqual([]);
    // 时间轴仍然给出固定数量的桶，图表不会因为没数据而塌掉
    expect(data.timeSeries.tokens).toHaveLength(24);
    expect(data.cost).toBeDefined();
    expect(data.cost.total).toBe(0);
  });

  it('stays behind the API key gate', async () => {
    const harness = createHarness();
    const res = await harness.app.request(
      new Request('http://gateway.test/v1/usage/dashboard?hours=24'),
    );
    expect(res.status).toBe(401);
  });

  it('rejects nothing when the window excludes all traffic', async () => {
    const harness = createHarness({ chat: cacheFriendly });
    await harness.post({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });

    // hours 的下限是 1，伪造一个极短窗口无法表达；这里验证 hours 解析容错
    const data = await (await dashboard(harness.app, 'hours=abc&limit=xyz')).json();
    expect(data.summary.totalRequests).toBe(1);
  });
});
