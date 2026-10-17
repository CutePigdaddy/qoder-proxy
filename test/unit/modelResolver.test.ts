import { describe, expect, it } from 'vitest';
import { ModelResolver } from '../../src/openai/modelResolver.js';
import type { CatalogEntry, ModelCatalog } from '../../src/qoder/modelCatalog.js';

const entries: CatalogEntry[] = [
  { key: 'auto', displayName: 'Auto', isReasoning: false, maxOutputTokens: 32768 },
  { key: 'performance', displayName: 'Performance', isReasoning: false, maxOutputTokens: 65536 },
  { key: 'ultimate', displayName: 'Ultimate', isReasoning: true, maxOutputTokens: 131072 },
  { key: 'qmodel_latest', displayName: 'Qwen 3.7 Max', isReasoning: true, maxOutputTokens: 262144 },
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
    aliases: { 'gpt-4o': 'auto', 'claude-sonnet-4-5': 'performance' },
    fallback: 'auto',
  });

  it('passes a real wire key straight through', async () => {
    const resolved = await resolver.resolve('qmodel_latest');
    expect(resolved.key).toBe('qmodel_latest');
    expect(resolved.isReasoning).toBe(true);
    expect(resolved.maxOutputTokens).toBe(262144);
  });

  it('maps a configured alias', async () => {
    const resolved = await resolver.resolve('claude-sonnet-4-5');
    expect(resolved.key).toBe('performance');
  });

  it('maps a catalog display name onto its wire key', async () => {
    const resolved = await resolver.resolve('Qwen 3.7 Max');
    expect(resolved.key).toBe('qmodel_latest');
    expect(resolved.matched).toBe('display');
  });

  it('ignores case and separators when matching keys and aliases', async () => {
    expect((await resolver.resolve('QWEN-3.7-MAX')).key).toBe('qmodel_latest');
    expect((await resolver.resolve('Qmodel_Latest')).key).toBe('qmodel_latest');
    expect((await resolver.resolve('GPT-4O')).key).toBe('auto');
  });

  it('falls back for unknown names instead of failing', async () => {
    const resolved = await resolver.resolve('gpt-9-ultra');
    expect(resolved.key).toBe('auto');
    expect(resolved.matched).toBe('fallback');
  });

  it('falls back when an alias points outside the catalog', async () => {
    const local = new ModelResolver({
      catalog: fakeCatalog(),
      aliases: { 'gpt-4': 'phantom-tier' },
      fallback: 'auto',
    });
    const resolved = await local.resolve('gpt-4');
    expect(resolved.key).toBe('auto');
    expect(resolved.matched).toBe('fallback');
  });

  it('lists the live catalog', async () => {
    const list = await resolver.list();
    expect(list.map((entry) => entry.id)).toContain('ultimate');
  });
});
