import { describe, expect, it } from 'vitest';
import { AdmissionGate } from '../../src/concurrency/admission.js';
import { QuotaExhaustedError } from '../../src/util/errors.js';
import { API_KEY, createHarness, type ChatFn } from '../helpers/gateway.js';

/** 与 dashboard 测试同一份价目来源，避免日志页的请求行与成本口径脱节。 */
const PRICED_MODEL = 'Qwen3.8-Max';
const PRICED_CONFIG = {
  models: [{ id: PRICED_MODEL, upstream: 'qmodel_38max' }],
  aliases: {},
  fallback: 'auto',
};

async function logs(harness: ReturnType<typeof createHarness>, query = 'hours=24') {
  const res = await harness.get(`/v1/usage/logs?${query}`);
  expect(res.status).toBe(200);
  return res.json();
}

describe('/v1/usage/logs', () => {
  it('records an upstream failure with stage, type and the client-facing message', async () => {
    const harness = createHarness({
      chat: async function* () {
        yield { type: 'error', message: 'upstream exploded', status: 502 };
      },
    });

    const res = await harness.post({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(502);

    const body = await logs(harness);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toMatchObject({
      status: 502,
      stage: 'upstream',
      type: 'upstream',
      message: 'upstream exploded',
      model: 'Test-Model',
    });
    // 同一次失败在请求明细里也有（用量口径不变），日志页两栏能对上
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]).toMatchObject({ status: 502, model: 'Test-Model' });
  });

  it('classifies a 429 quota exhaustion as quota, not rate limiting', async () => {
    const harness = createHarness({
      chat: async function* () {
        throw new QuotaExhaustedError('Upstream quota exhausted (code 110)');
      },
    });

    const res = await harness.post({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(429);

    const body = await logs(harness);
    expect(body.errors[0]).toMatchObject({ status: 429, type: 'quota', stage: 'upstream' });
    expect(body.errors[0].message).toContain('code 110');
  });

  it('logs validation rejections without touching usage statistics', async () => {
    const harness = createHarness();
    const res = await harness.post('{ not json');
    expect(res.status).toBe(400);

    const body = await logs(harness);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toMatchObject({
      status: 400,
      stage: 'validate',
      type: 'invalid',
      message: 'Request body must be valid JSON',
    });
    // 请求明细 / 用量统计保持原口径：非法 JSON 不计入 totalRequests 与 errorRate
    expect(body.requests).toEqual([]);
    const dashboard = await (await harness.get('/v1/usage/dashboard?hours=24')).json();
    expect(dashboard.summary.totalRequests).toBe(0);
  });

  it('labels a gateway input-limit rejection as input-limit', async () => {
    const harness = createHarness();
    // 8 token 的上限，任何真实消息都会超
    harness.deps.limits.set('Test-Model', 8);

    const res = await harness.post({
      model: 'auto',
      messages: [{ role: 'user', content: 'x'.repeat(200) }],
    });
    expect(res.status).toBe(400);

    const body = await logs(harness);
    expect(body.errors[0]).toMatchObject({
      status: 400,
      stage: 'validate',
      type: 'input-limit',
      model: 'Test-Model',
    });
    expect(body.errors[0].message).toContain('exceeds the gateway limit');
  });

  it('marks queue saturation as stage queue / type busy', async () => {
    const gate = new AdmissionGate(1, 0);
    const harness = createHarness({ gate });
    // 占住唯一槽位，队列长度为 0 → 下一个请求直接 429
    const release = await gate.enter(new AbortController().signal);

    try {
      const res = await harness.post({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
      expect(res.status).toBe(429);

      const body = await logs(harness);
      expect(body.errors[0]).toMatchObject({ status: 429, stage: 'queue', type: 'busy' });
      expect(body.errors[0].message).toBe('Gateway is at capacity, retry shortly');
      // 排队失败没有 upstream 调用，也就没有 usage 帧
      expect(body.requests[0]).toMatchObject({ status: 429, inputTokens: 0, outputTokens: 0 });
    } finally {
      release();
    }
  });

  it('distinguishes our own queue deadline (504) from a client hang-up', async () => {
    const gate = new AdmissionGate(1, 8);
    const harness = createHarness({ gate, config: { requestTimeoutMs: 120 } });
    const release = await gate.enter(new AbortController().signal);

    try {
      const res = await harness.post({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
      expect(res.status).toBe(504);

      const body = await logs(harness);
      expect(body.errors[0]).toMatchObject({
        status: 504,
        stage: 'queue',
        type: 'timeout',
        message: 'Request timed out while queued',
      });
    } finally {
      release();
    }
  });

  it('serves request rows through the same cost mapping as the dashboard', async () => {
    const harness = createHarness({
      config: { models: PRICED_CONFIG },
      chat: async function* () {
        yield { type: 'text-delta', text: 'ok' };
        yield { type: 'usage', promptTokens: 300, completionTokens: 10, totalTokens: 310, cachedTokens: 100 };
        yield { type: 'done', finishReason: 'stop' };
      },
    });
    await harness.post({ model: PRICED_MODEL, messages: [{ role: 'user', content: 'hi' }] });

    const body = await logs(harness);
    expect(body.requests[0]).toMatchObject({
      model: PRICED_MODEL,
      inputTokens: 200, // 300 - 100 命中
      cacheHitTokens: 100,
      outputTokens: 10,
      status: 200,
    });
    // 新增输入 200 × 12 + 命中 100 × 1.5 + 输出 10 × 36（元/百万 tokens）
    expect(body.requests[0].cost).toBeCloseTo((200 * 12 + 100 * 1.5 + 10 * 36) / 1_000_000, 6);
  });

  it('returns newest first and honours the limit', async () => {
    const harness = createHarness({
      chat: async function* () {
        yield { type: 'error', message: 'boom', status: 502 };
      },
    });
    await harness.post({ model: 'auto', messages: [{ role: 'user', content: '1' }] });
    await harness.post({ model: 'auto', messages: [{ role: 'user', content: '2' }] });
    await harness.post({ model: 'auto', messages: [{ role: 'user', content: '3' }] });

    const body = await logs(harness, 'hours=24&limit=2');
    expect(body.errors).toHaveLength(2);
    expect(body.requests).toHaveLength(2);
    expect(body.errors[0].id).not.toBe(body.errors[1].id);
  });

  it('returns an empty, well-formed payload before any traffic', async () => {
    const harness = createHarness();
    const body = await logs(harness);
    expect(body).toEqual({ requests: [], errors: [] });
  });

  it('tolerates junk query parameters', async () => {
    const harness = createHarness({
      chat: async function* () {
        yield { type: 'error', message: 'boom', status: 502 };
      },
    });
    await harness.post({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });

    const body = await logs(harness, 'hours=abc&limit=xyz');
    expect(body.errors).toHaveLength(1);
  });

  it('stays behind the API key gate', async () => {
    const harness = createHarness();
    const res = await harness.app.request(
      new Request('http://gateway.test/v1/usage/logs?hours=24', {
        headers: { Authorization: `Bearer ${API_KEY}` },
      }),
    );
    expect(res.status).toBe(200);

    const anon = await harness.app.request(
      new Request('http://gateway.test/v1/usage/logs?hours=24'),
    );
    expect(anon.status).toBe(401);
  });
});
