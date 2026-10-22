import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ErrorStore, type ErrorRecord } from '../../src/obs/errorStore.js';

const NOW = Date.now();
const HOUR = 3_600_000;

function event(overrides: Partial<ErrorRecord> = {}): ErrorRecord {
  return {
    ts: NOW - 60_000,
    model: 'Auto',
    application: 'Claude Code',
    status: 502,
    stage: 'upstream',
    type: 'upstream',
    message: 'Upstream error 500',
    durationMs: 2_400,
    ...overrides,
  };
}

const dirs: string[] = [];
const stores: ErrorStore[] = [];

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-errors-'));
  dirs.push(dir);
  return join(dir, 'errors.jsonl');
}

/** 记录要写盘，测试结束前必须等队列落定，否则 Windows 上删目录会失败。 */
function newStore(options: ConstructorParameters<typeof ErrorStore>[0]): ErrorStore {
  const store = new ErrorStore(options);
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

describe('ErrorStore', () => {
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
    first.record(event({ type: 'quota', status: 429, message: 'Upstream quota exhausted (code 110)' }));

    // 等待追加写队列落盘
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = newStore({ path });
    await second.load();
    expect(second.size).toBe(1);
    expect(second.since(0)[0]?.type).toBe('quota');
    expect(second.since(0)[0]?.message).toContain('code 110');
  });

  it('trims the in-memory ring to the cap', async () => {
    const store = newStore({ path: await tempPath(), cap: 3 });
    // 按时间递增写入，模拟真实顺序
    for (let i = 0; i < 5; i++) store.record(event({ ts: NOW + i * 1_000 }));
    expect(store.size).toBe(3);
    expect(store.since(0).map((e) => e.ts)).toEqual([NOW + 2_000, NOW + 3_000, NOW + 4_000]);
  });

  it('compacts the file when it grows past the byte budget', async () => {
    const path = await tempPath();
    const store = newStore({ path, cap: 2, maxBytes: 200 });
    for (let i = 0; i < 8; i++) store.record(event({ ts: NOW - i * 1_000 }));

    await store.flush();

    const text = await readFile(path, 'utf8');
    expect(text.split('\n').filter(Boolean).length).toBeLessThanOrEqual(2);
  });

  it('skips malformed lines and fills unknown classifications with safe defaults', async () => {
    const path = await tempPath();
    await writeFile(
      path,
      [
        JSON.stringify(event()),
        'not json',
        '{"ts":"nope"}',
        // 老版本/手改的行：未知 stage/type 不能污染界面，回退到 upstream
        JSON.stringify({ ts: NOW, status: 500, stage: 'weird', type: 'weird' }),
      ].join('\n') + '\n',
    );

    const store = newStore({ path });
    await store.load();
    expect(store.size).toBe(2);
    expect(store.since(0)[1]).toMatchObject({ stage: 'upstream', type: 'upstream', model: 'unknown' });
  });

  it('starts empty when the file is missing', async () => {
    const store = newStore({ path: join(tmpdir(), `missing-errors-${Date.now()}.jsonl`) });
    await store.load();
    expect(store.size).toBe(0);
  });
});
