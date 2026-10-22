import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelLimits } from '../../src/obs/modelLimits.js';

const dirs: string[] = [];

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-limits-'));
  dirs.push(dir);
  return join(dir, 'model-limits.json');
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ModelLimits', () => {
  it('starts empty when the file is missing', async () => {
    const store = new ModelLimits({ path: await tempPath() });
    await store.load();
    expect(store.all()).toEqual({});
    expect(store.get('Auto')).toBeNull();
  });

  it('survives a restart', async () => {
    const path = await tempPath();
    const first = new ModelLimits({ path });
    first.set('Qwen3.8-Max', 200_000);
    await first.flush();

    const second = new ModelLimits({ path });
    await second.load();
    expect(second.get('Qwen3.8-Max')).toBe(200_000);
  });

  it('clears a limit with null and rewrites the file', async () => {
    const path = await tempPath();
    const store = new ModelLimits({ path });
    store.set('Auto', 100_000);
    store.set('Auto', null);
    await store.flush();

    const persisted = JSON.parse(await readFile(path, 'utf8')) as { limits: Record<string, number> };
    expect(persisted.limits).toEqual({});
    expect(store.get('Auto')).toBeNull();
  });

  it('ignores junk values on load instead of failing', async () => {
    const path = await tempPath();
    const store = new ModelLimits({ path });
    store.set('Ok-Model', 50_000);
    await store.flush();

    const second = new ModelLimits({ path });
    const raw = JSON.parse(await readFile(path, 'utf8')) as { limits: Record<string, unknown> };
    raw.limits['bad'] = 'nope';
    raw.limits['negative'] = -5;
    await (await import('node:fs/promises')).writeFile(path, JSON.stringify(raw));
    await second.load();

    expect(second.all()).toEqual({ 'Ok-Model': 50_000 });
  });
});
