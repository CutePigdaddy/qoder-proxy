import { describe, expect, it } from 'vitest';
import type { ModelMapping } from '../../src/config.js';
import { ModelResolver } from '../../src/openai/modelResolver.js';
import type { CatalogEntry, ModelCatalog } from '../../src/qoder/modelCatalog.js';

const entries: CatalogEntry[] = [
  { key: 'auto', displayName: 'Auto', isReasoning: true, maxOutputTokens: 32768 },
  { key: 'qmodel_38max', displayName: 'Qwen3.8-Max', isReasoning: true, maxOutputTokens: 180000 },
  { key: 'qmodel_latest', displayName: 'Qwen3.7-Max', isReasoning: true, maxOutputTokens: 262144 },
  { key: 'dmodel', displayName: 'DeepSeek-V4-Pro', isReasoning: true, maxOutputTokens: 131072 },
  // Advertised by the account but not curated in config/models.json.
  { key: 'brandnew', displayName: 'Some-New-Model', isReasoning: false, maxOutputTokens: 65536 },
];

const mappings: ModelMapping[] = [
  { id: 'Auto', upstream: 'auto' },
  { id: 'Qwen3.7-Max', upstream: 'qmodel_latest' },
  { id: 'DeepSeek-V4-Pro', upstream: 'dmodel' },
];

function fakeCatalog(): ModelCatalog {
  return {
    find: async (key: string) => entries.find((entry) => entry.key === key),
    list: async () => entries,
  } as unknown as ModelCatalog;
}

describe('ModelResolver', () => {
  const resolver = new ModelResolver({
    catalog: fakeCatalog(),
    models: mappings,
    aliases: { 'gpt-4o': 'Auto', o3: 'dmodel' },
    fallback: 'Auto',
  });

  it('forwards a curated display name to its wire key', async () => {
    const resolved = await resolver.resolve('DeepSeek-V4-Pro');
    expect(resolved.key).toBe('dmodel');
    expect(resolved.id).toBe('DeepSeek-V4-Pro');
    expect(resolved.matched).toBe('mapped');
  });

  it('accepts separator and case variants of a display name', async () => {
    for (const name of ['deepseek-v4-pro', 'DeepSeek V4 Pro', 'DEEPSEEK_V4_PRO', 'deepseekv4pro']) {
      const resolved = await resolver.resolve(name);
      expect(resolved.key).toBe('dmodel');
      expect(resolved.id).toBe('DeepSeek-V4-Pro');
    }
  });

  it('still accepts the raw wire key and reports the readable id', async () => {
    const resolved = await resolver.resolve('qmodel_latest');
    expect(resolved.key).toBe('qmodel_latest');
    expect(resolved.id).toBe('Qwen3.7-Max');
    expect(resolved.isReasoning).toBe(true);
    expect(resolved.maxOutputTokens).toBe(262144);
  });

  it('resolves an alias that points at a display name', async () => {
    const resolved = await resolver.resolve('gpt-4o');
    expect(resolved.key).toBe('auto');
    expect(resolved.id).toBe('Auto');
    expect(resolved.matched).toBe('alias');
  });

  it('resolves an alias that points at a wire key', async () => {
    const resolved = await resolver.resolve('o3');
    expect(resolved.key).toBe('dmodel');
    expect(resolved.id).toBe('DeepSeek-V4-Pro');
  });

  it('falls back to catalog display names for uncurated models', async () => {
    const resolved = await resolver.resolve('Some-New-Model');
    expect(resolved.key).toBe('brandnew');
    expect(resolved.id).toBe('Some-New-Model');
    expect(resolved.matched).toBe('display');
  });

  it('falls back for unknown names instead of failing', async () => {
    const resolved = await resolver.resolve('gpt-9-ultra');
    expect(resolved.key).toBe('auto');
    expect(resolved.id).toBe('Auto');
    expect(resolved.matched).toBe('fallback');
  });

  it('falls back when an alias points outside the catalog', async () => {
    const local = new ModelResolver({
      catalog: fakeCatalog(),
      aliases: { 'gpt-4': 'phantom-tier' },
      fallback: 'Auto',
    });
    const resolved = await local.resolve('gpt-4');
    expect(resolved.key).toBe('auto');
    expect(resolved.matched).toBe('fallback');
  });

  it('lists curated names first, then uncurated catalog entries', async () => {
    const list = await resolver.list();
    expect(list[0]?.id).toBe('Auto');
    expect(list.find((entry) => entry.id === 'DeepSeek-V4-Pro')?.upstream).toBe('dmodel');
    expect(list.find((entry) => entry.id === 'Some-New-Model')?.upstream).toBe('brandnew');
  });

  it('never exposes a wire key as a model id', async () => {
    const list = await resolver.list();
    const ids = list.map((entry) => entry.id);
    expect(ids).not.toContain('dmodel');
    expect(ids).not.toContain('qmodel_latest');
    expect(ids.filter((id) => id.toLowerCase() === 'auto')).toHaveLength(1);
  });
});

describe('ModelResolver.list metadata', () => {
  const catalogEntries: CatalogEntry[] = [
    {
      key: 'auto',
      displayName: 'Auto',
      isReasoning: true,
      maxOutputTokens: 32768,
      maxInputTokens: 200000,
      isVision: true,
      priceFactor: 0.5,
      isDefault: true,
    },
    {
      key: 'mmodel',
      displayName: 'MiniMax-M3.1-Flash',
      isReasoning: false,
      maxOutputTokens: 8192,
      maxInputTokens: 180000,
      isVision: true,
      priceFactor: 0.1,
    },
    { key: 'dmodel', displayName: 'DeepSeek-V4-Pro', isReasoning: true, maxOutputTokens: 131072 },
    { key: 'extra', displayName: 'Upstream-Only', isReasoning: false, maxOutputTokens: 4096, priceFactor: 0.8 },
  ];

  const resolver = new ModelResolver({
    catalog: { list: async () => catalogEntries } as unknown as ModelCatalog,
    models: [
      { id: 'Auto', upstream: 'auto' },
      // 配置里的名字与上游显示名不同，同一个 wire key
      { id: 'MiniMax-M2.7', upstream: 'mmodel' },
      // 配置里有、上游目录没有
      { id: 'Qwen3.7-Max', upstream: 'qmodel_latest' },
      { id: 'DeepSeek-V4-Pro', upstream: 'dmodel' },
    ],
    aliases: {},
    fallback: 'Auto',
  });

  it('dedupes by wire key and keeps the curated name', async () => {
    const rows = (await resolver.list()).filter((entry) => entry.upstream === 'mmodel');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('MiniMax-M2.7');
    // 上游叫 M3.1-Flash，配置叫 M2.7，两个名字都要能查到
    expect(rows[0]?.upstreamDisplayName).toBe('MiniMax-M3.1-Flash');
  });

  it('marks models the upstream does not list as config-only', async () => {
    const missing = (await resolver.list()).find((entry) => entry.upstream === 'qmodel_latest');
    expect(missing?.availability).toBe('config-only');
    expect(missing?.contextWindow).toBeNull();
    // 上游没这个 key，名字就是未知，不能把 wire key 伪装成上游显示名
    expect(missing?.upstreamDisplayName).toBeNull();
  });

  it('marks uncurated upstream models as upstream-only', async () => {
    const extra = (await resolver.list()).find((entry) => entry.upstream === 'extra');
    expect(extra?.availability).toBe('upstream-only');
  });

  it('carries pricing, capabilities and context through', async () => {
    const auto = (await resolver.list()).find((entry) => entry.id === 'Auto');
    expect(auto?.contextWindow).toBe(200000);
    expect(auto?.capabilities).toEqual({ reasoning: true, vision: true });
    expect(auto?.pricing.factor).toBe(0.5);
    expect(auto?.isDefault).toBe(true);
  });

  it('forwards the force flag so the panel refresh bypasses the TTL', async () => {
    const seen: boolean[] = [];
    const local = new ModelResolver({
      catalog: {
        list: async (force = false) => {
          seen.push(force);
          return catalogEntries;
        },
      } as unknown as ModelCatalog,
      aliases: {},
      fallback: 'Auto',
    });
    await local.list(true);
    expect(seen).toEqual([true]);
  });
});
