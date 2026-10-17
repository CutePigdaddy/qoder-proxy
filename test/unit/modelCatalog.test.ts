import { describe, expect, it } from 'vitest';
import { parseCatalogPayload } from '../../src/qoder/modelCatalog.js';

/** Trimmed copy of a real CN `model/list` response. */
const liveShape = {
  chat: [
    {
      key: 'auto',
      format: 'openai',
      source: 'system',
      enable: true,
      display_name: 'Auto',
      is_reasoning: true,
      is_default: true,
      max_input_tokens: 200000,
      context_config: { '200K': { token_count: 200000, is_default: true } },
    },
    {
      key: 'qmodel_38max',
      enable: true,
      display_name: 'Qwen3.8-Max',
      is_reasoning: true,
      max_input_tokens: 180000,
    },
    {
      key: 'retired-model',
      enable: false,
      display_name: 'Retired',
    },
  ],
};

describe('parseCatalogPayload', () => {
  it('reads the live `chat` envelope', () => {
    const entries = parseCatalogPayload(liveShape);
    expect(entries.map((entry) => entry.key)).toEqual(['auto', 'qmodel_38max']);
  });

  it('preserves display names and reasoning flags', () => {
    const auto = parseCatalogPayload(liveShape).find((entry) => entry.key === 'auto');
    expect(auto?.displayName).toBe('Auto');
    expect(auto?.isReasoning).toBe(true);
  });

  it('skips disabled models', () => {
    const keys = parseCatalogPayload(liveShape).map((entry) => entry.key);
    expect(keys).not.toContain('retired-model');
  });

  it('still accepts the other envelope spellings', () => {
    expect(parseCatalogPayload({ data: [{ key: 'a' }] })).toHaveLength(1);
    expect(parseCatalogPayload({ models: [{ key: 'b' }] })).toHaveLength(1);
    expect(parseCatalogPayload([{ key: 'c' }])).toHaveLength(1);
  });

  it('returns an empty list for junk', () => {
    expect(parseCatalogPayload(null)).toEqual([]);
    expect(parseCatalogPayload({})).toEqual([]);
    expect(parseCatalogPayload({ chat: [{}] })).toEqual([]);
  });
});
