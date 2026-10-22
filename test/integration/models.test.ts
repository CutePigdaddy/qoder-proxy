import { describe, expect, it } from 'vitest';
import type { ModelListEntry } from '../../src/openai/modelResolver.js';
import { API_KEY, chatBody, createHarness, modelListEntry } from '../helpers/gateway.js';

interface Row {
  id: string;
  upstream_model: string;
  upstream_display_name: string;
  context_window: number | null;
  context_windows: number[];
  capabilities: { reasoning: boolean; vision: boolean };
  pricing: { factor: number | null; originalFactor: number | null; free: boolean };
  promotion: { badge?: string; window?: string } | null;
  is_default: boolean;
  availability: string;
  input_limit: number | null;
  usage: {
    requests: number;
    inputTokens: number;
    cachedTokens: number;
    hitRate: number;
    peakPromptTokens: number;
  } | null;
  rate: {
    input: number;
    cachedInput: number;
    output: number;
    tiers: number;
    peak: { windows: string[]; multiplier: number } | null;
    confidence: 'official' | 'estimate';
    source: { label: string; url?: string } | null;
    note: string | null;
  } | null;
}

describe('GET /v1/models directory', () => {
  it('returns the metadata the model panel renders', async () => {
    const harness = createHarness({
      models: [
        modelListEntry({
          id: 'Qwen3.8-Max',
          upstream: 'qmodel_38max',
          contextWindow: 180000,
          contextWindows: [200000, 400000, 1000000],
          capabilities: { reasoning: true, vision: true },
          pricing: { factor: 0.2, originalFactor: 0.5, free: false },
          promotion: { active: true, badge: '错峰 4 折', discountFactor: 0.4, beforeFactor: 0.5, window: '22:00–08:00' },
        }),
        modelListEntry({ id: 'GLM-5.2', upstream: 'gm51model', availability: 'config-only' }),
      ],
    });

    const body = (await (await harness.get('/v1/models')).json()) as { data: Row[] };
    const qwen = body.data.find((row) => row.id === 'Qwen3.8-Max');

    expect(qwen).toMatchObject({
      upstream_model: 'qmodel_38max',
      context_window: 180000,
      capabilities: { reasoning: true, vision: true },
      pricing: { factor: 0.2, originalFactor: 0.5, free: false },
      availability: 'live',
      is_default: false,
    });
    expect(qwen?.promotion).toMatchObject({ badge: '错峰 4 折' });
    // 公开价目应该存在
    expect(qwen?.rate).toBeTruthy();
    expect(qwen?.rate?.input).toBe(12);
    expect(qwen?.rate?.output).toBe(36);
    expect(qwen?.rate?.cachedInput).toBe(1.5);
    expect(body.data.find((row) => row.id === 'GLM-5.2')).toMatchObject({ availability: 'config-only' });
  });

  it('attaches real usage per model', async () => {
    const harness = createHarness({ models: [modelListEntry({ id: 'Auto', upstream: 'auto' })] });
    const now = Date.now();
    const row = {
      ts: now,
      model: 'Auto',
      application: 'Claude Code',
      provider: 'Qoder CN',
      outputTokens: 10,
      durationMs: 900,
      status: 200,
    };
    harness.deps.usage.record({ ...row, inputTokens: 100, cachedTokens: 900 });
    harness.deps.usage.record({ ...row, inputTokens: 1000, cachedTokens: 0 });

    const body = (await (await harness.get('/v1/models?hours=24')).json()) as { data: Row[] };
    expect(body.data[0]?.usage).toMatchObject({ requests: 2, cachedTokens: 900, inputTokens: 1100 });
    // 900 / (900 + 1100)
    expect(body.data[0]?.usage?.hitRate).toBeCloseTo(45, 5);
  });

  it('leaves usage null for a model with no traffic', async () => {
    const harness = createHarness({ models: [modelListEntry({ id: 'Idle-Model' })] });
    const body = (await (await harness.get('/v1/models')).json()) as { data: Row[] };
    expect(body.data[0]?.usage).toBeNull();
  });

  it('forwards refresh=1 so the panel can bypass the catalog TTL', async () => {
    const harness = createHarness();
    const calls: Array<boolean | undefined> = [];
    const resolver = harness.deps.resolver as unknown as {
      list: (force?: boolean) => Promise<ModelListEntry[]>;
    };
    resolver.list = async (force?: boolean) => {
      calls.push(force);
      return [modelListEntry({ id: 'Auto', upstream: 'auto' })];
    };

    await harness.get('/v1/models?refresh=1');
    expect(calls).toEqual([true]);
  });
});

describe('gateway input limits', () => {
  const put = (harness: ReturnType<typeof createHarness>, body: unknown) =>
    harness.app.request('http://gateway.test/v1/models/limits', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('starts unrestricted and reflects a saved limit in the directory', async () => {
    const harness = createHarness({ models: [modelListEntry({ id: 'Auto', upstream: 'auto' })] });

    const before = (await (await harness.get('/v1/models')).json()) as { data: Row[] };
    expect(before.data[0]?.input_limit).toBeNull();

    expect((await put(harness, { limits: { Auto: 150_000 } })).status).toBe(200);

    const after = (await (await harness.get('/v1/models')).json()) as { data: Row[] };
    expect(after.data[0]?.input_limit).toBe(150_000);
  });

  it('clears a limit with null', async () => {
    const harness = createHarness({ models: [modelListEntry({ id: 'Auto', upstream: 'auto' })] });
    await put(harness, { limits: { Auto: 150_000 } });
    await put(harness, { limits: { Auto: null } });

    const body = (await (await harness.get('/v1/models')).json()) as { data: Row[] };
    expect(body.data[0]?.input_limit).toBeNull();
  });

  it('rejects the whole batch when one entry is invalid', async () => {
    const harness = createHarness();
    const response = await put(harness, { limits: { Auto: 1000, Broken: -1 } });
    expect(response.status).toBe(400);
    // 整批不落地，避免留下一半生效的中间状态
    expect(harness.deps.limits.all()).toEqual({});
  });

  it('rejects a request whose estimated input exceeds the limit', async () => {
    const harness = createHarness();
    harness.deps.limits.set('Test-Model', 1_000);

    const response = await harness.post(
      chatBody({ messages: [{ role: 'user', content: 'x'.repeat(8_000) }] }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('gateway limit');
  });

  it('leaves the same request alone when no limit is configured', async () => {
    const harness = createHarness();
    const response = await harness.post(
      chatBody({ messages: [{ role: 'user', content: 'x'.repeat(8_000) }] }),
    );
    expect(response.status).toBe(200);
  });

  it('passes a request that stays under the limit', async () => {
    const harness = createHarness();
    harness.deps.limits.set('Test-Model', 100_000);
    const response = await harness.post(
      chatBody({ messages: [{ role: 'user', content: 'x'.repeat(8_000) }] }),
    );
    expect(response.status).toBe(200);
  });
});
