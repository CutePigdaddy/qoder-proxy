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
