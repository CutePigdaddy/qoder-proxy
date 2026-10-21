import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageStore, inferApplication, type UsageRecord } from '../../src/obs/usageStore.js';
import { aggregate } from '../../src/server/routes/usage.js';

const NOW = Date.now();
const HOUR = 3_600_000;

function event(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    ts: NOW - 60_000,
    model: 'Auto',
    application: 'Claude Code',
    provider: 'Qoder CN',
    inputTokens: 100,
    cachedTokens: 900,
    outputTokens: 50,
    durationMs: 2_000,
    status: 200,
    ...overrides,
  };
}

const dirs: string[] = [];
const stores: UsageStore[] = [];

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-usage-'));
  dirs.push(dir);
  return join(dir, 'usage.jsonl');
}

/** 记录要写盘，测试结束前必须等队列落定，否则 Windows 上删目录会失败。 */
function newStore(options: ConstructorParameters<typeof UsageStore>[0]): UsageStore {
  const store = new UsageStore(options);
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.flush()));
  await Promise.all(
    dirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
    ),
  );
});

describe('aggregate', () => {
  it('derives the hit rate from cached and fresh input, not from request counts', () => {
    const data = aggregate([event({ inputTokens: 100, cachedTokens: 900 })], 24, 50);
    expect(data.cache.hitRate).toBe(90);
    expect(data.cache.cacheHitTokens).toBe(900);
    expect(data.cache.inputTokens).toBe(100);
    expect(data.summary.totalTokens).toBe(1_050); // 900 + 100 + 50
  });

  it('reports zero rather than NaN when there is no traffic', () => {
    const data = aggregate([], 24, 50);
    expect(data.summary.totalRequests).toBe(0);
    expect(data.cache.hitRate).toBe(0);
    expect(data.summary.avgDuration).toBe(0);
    expect(data.byModel).toEqual([]);
    expect(data.recentLogs).toEqual([]);
    expect(data.cache.trend).toEqual([]);
  });

  it('counts 4xx/5xx rows into the error rate but keeps their tokens at zero', () => {
    const data = aggregate(
      [
        event({ status: 200 }),
        event({ status: 429, inputTokens: 0, cachedTokens: 0, outputTokens: 0 }),
      ],
      24,
      50,
    );
    expect(data.summary.errorRate).toBe(50);
    expect(data.summary.totalRequests).toBe(2);
    // 命中率只由有 token 的那条决定
    expect(data.cache.hitRate).toBe(90);
  });

  it('orders models by request count and computes per-model hit rate', () => {
    const data = aggregate(
      [
        event({ model: 'Auto' }),
        event({ model: 'Auto' }),
        event({ model: 'Qwen3.8-Max', inputTokens: 800, cachedTokens: 200 }),
      ],
      24,
      50,
    );
    expect(data.byModel.map((m) => m.model)).toEqual(['Auto', 'Qwen3.8-Max']);
    expect(data.byModel[1]?.hitRate).toBe(20);
    expect(data.byModel[0]?.requests).toBe(2);
  });

  it('returns the newest rows first and honours the limit', () => {
    const data = aggregate(
      [
        event({ ts: NOW - 3_000 }),
        event({ ts: NOW - 2_000 }),
        event({ ts: NOW - 1_000 }),
      ],
      24,
      2,
    );
    expect(data.recentLogs).toHaveLength(2);
    expect(data.recentLogs[0]?.timestamp).toBe(NOW - 1_000);
    expect(data.recentLogs[1]?.timestamp).toBe(NOW - 2_000);
  });

  it('buckets events into the requested window and reports one point per bucket', () => {
    const data = aggregate([event({ ts: NOW - HOUR })], 24, 50);
    expect(data.timeSeries.requests).toHaveLength(24);
    expect(data.timeSeries.requests.reduce((n, p) => n + p.value, 0)).toBe(1);
  });
});

describe('UsageStore', () => {
  it('returns only records inside the window', async () => {
    const store = newStore({ path: await tempPath() });
    store.record(event({ ts: NOW - 5 * HOUR }));
    store.record(event({ ts: NOW - 1_000 }));

    expect(store.since(NOW - HOUR)).toHaveLength(1);
    expect(store.since(NOW - 10 * HOUR)).toHaveLength(2);
  });

  it('persists to disk and reloads after a restart', async () => {
    const path = await tempPath();
    const first = newStore({ path });
    first.record(event({ model: 'Qwen3.8-Max', cachedTokens: 1_234 }));

    // 等待追加写队列落盘
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = newStore({ path });
    await second.load();
    expect(second.size).toBe(1);
    expect(second.since(0)[0]?.model).toBe('Qwen3.8-Max');
    expect(second.since(0)[0]?.cachedTokens).toBe(1_234);
  });

  it('trims the in-memory ring to the cap', async () => {
    const store = newStore({ path: await tempPath(), cap: 3 });
    // 按时间递增写入，模拟真实顺序
    for (let i = 0; i < 5; i++) store.record(event({ ts: NOW + i * 1_000 }));
    expect(store.size).toBe(3);
    // 淘汰最旧的，保留最近写入的三条
    expect(store.since(0).map((e) => e.ts)).toEqual([NOW + 2_000, NOW + 3_000, NOW + 4_000]);
  });

  it('compacts the file when it grows past the byte budget', async () => {
    const path = await tempPath();
    const store = newStore({ path, cap: 2, maxBytes: 200 });
    for (let i = 0; i < 8; i++) store.record(event({ ts: NOW - i * 1_000 }));

    await new Promise((resolve) => setTimeout(resolve, 100));

    const text = await readFile(path, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it('skips malformed lines instead of failing the whole load', async () => {
    const path = await tempPath();
    await writeFile(path, `${JSON.stringify(event())}\nnot json\n{"ts":"nope"}\n`);

    const store = newStore({ path });
    await store.load();
    expect(store.size).toBe(1);
  });

  it('starts empty when the file is missing', async () => {
    const store = newStore({ path: join(tmpdir(), `missing-${Date.now()}.jsonl`) });
    await store.load();
    expect(store.size).toBe(0);
  });
});

describe('inferApplication', () => {
  it('maps known clients and falls back to a neutral label', () => {
    expect(inferApplication('claude-cli/1.2.3')).toBe('Claude Code');
    expect(inferApplication('codex-cli/0.9')).toBe('Codex');
    expect(inferApplication('Mozilla/5.0 Cursor/0.42')).toBe('Cursor');
    expect(inferApplication('OpenAI/Python 1.40.0')).toBe('Python SDK');
    expect(inferApplication('curl/8.4.0')).toBe('curl');
    expect(inferApplication('something-else')).toBe('其他客户端');
    expect(inferApplication(undefined)).toBe('未知');
  });
});
