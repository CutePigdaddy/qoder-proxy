import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CredentialStore } from '../../src/qoder/credentialStore.js';
import type { Endpoints } from '../../src/qoder/endpoints.js';
import { ModelCatalog, parseCatalogPayload } from '../../src/qoder/modelCatalog.js';

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
    expect(entries.map((entry) => entry.key)).toEqual(['auto', 'qmodel_38max', 'retired-model']);
  });

  it('preserves display names and reasoning flags', () => {
    const auto = parseCatalogPayload(liveShape).find((entry) => entry.key === 'auto');
    expect(auto?.displayName).toBe('Auto');
    expect(auto?.isReasoning).toBe(true);
  });

  it('keeps disabled models but marks them as not enabled', () => {
    // 2026-10-22 实测推翻了旧假设：`enable:false` 只表示「客户端下拉里默认不
    // 显示」，这些模型同样能调用（Teams 账号下 10 个 enable:false 的模型全部
    // 返回 200）。丢弃它们会把可用模型误标成「仅配置」。
    const entries = parseCatalogPayload(liveShape);
    const retired = entries.find((entry) => entry.key === 'retired-model');
    expect(retired).toBeDefined();
    expect(retired?.enabled).toBe(false);
    expect(entries.find((entry) => entry.key === 'auto')?.enabled).toBe(true);
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

  it('keeps the pricing, vision and context metadata the panel shows', () => {
    const [entry] = parseCatalogPayload({
      chat: [
        {
          key: 'qmodel_38max',
          display_name: 'Qwen3.8-Max',
          is_vl: true,
          is_reasoning: true,
          price_factor: 0.2,
          is_free: false,
          is_default: false,
          max_input_tokens: 180000,
          context_config: {
            '1M': { token_count: 1000000 },
            '200K': { token_count: 200000, is_default: true },
            '400K': { token_count: 400000 },
          },
          promotion: {
            active: true,
            badge: { zh: '错峰 4 折', en: 'Off-Peak 60% off' },
            description: { zh: '错峰时段4折优惠' },
            discount_factor: 0.4,
            before_promotion_price_factor: 0.5,
            window_start: '22:00',
            window_end: '08:00',
          },
        },
      ],
    });

    expect(entry?.isVision).toBe(true);
    expect(entry?.priceFactor).toBe(0.2);
    expect(entry?.maxInputTokens).toBe(180000);
    // 档位去重升序，便于界面上列出来给用户选
    expect(entry?.contextWindows).toEqual([200000, 400000, 1000000]);
    expect(entry?.promotion).toMatchObject({
      active: true,
      badge: '错峰 4 折',
      discountFactor: 0.4,
      beforeFactor: 0.5,
      window: '22:00–08:00',
    });
  });

  it('ignores an inactive promotion and falls back to the largest context tier', () => {
    const [entry] = parseCatalogPayload({
      chat: [
        {
          key: 'free-one',
          is_free: true,
          price_factor: 0,
          original_price_factor: 0.1,
          context_config: { '96K': { token_count: 96000 } },
          promotion: { active: false, badge: { zh: '不该出现' } },
        },
      ],
    });

    expect(entry?.promotion).toBeNull();
    expect(entry?.isFree).toBe(true);
    expect(entry?.priceFactor).toBe(0);
    expect(entry?.originalPriceFactor).toBe(0.1);
    // 上游没给 max_input_tokens 时退化为 context_config 的最大档
    expect(entry?.maxInputTokens).toBe(96000);
  });
});

const endpoints: Endpoints = {
  gateway: 'https://gateway.example',
  openapi: 'https://openapi.example',
  chat: 'https://gateway.example/api/chat',
  modelList: 'https://gateway.example/api/models',
  exchange: 'https://openapi.example/api/v1/jobToken/exchange',
  refresh: 'https://openapi.example/api/v1/jobToken/refresh',
  userInfo: 'https://openapi.example/api/v1/userinfo',
  usage: 'https://openapi.example/api/v2/quota/usage',
};

const credentials = {
  get: async () => ({
    jobToken: 'job-token',
    jobRefreshToken: 'job-refresh',
    userID: 'user-1',
    name: 'tester',
    email: 'tester@example.com',
    machineID: 'machine-1',
    expiresAt: Date.now() + 3_600_000,
  }),
} as unknown as CredentialStore;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ModelCatalog failure handling', () => {
  it('falls back and stops retrying for the negative TTL window', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = new ModelCatalog({ endpoints, credentials });

    const first = await catalog.list();
    // Static table still carries real wire keys, so requests keep working.
    expect(first.map((entry) => entry.key)).toContain('auto');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Chat requests resolve a model on the way in: the outage must not cost
    // each of them a fresh timeout.
    await catalog.list();
    await catalog.list();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('lets an explicit refresh bypass the negative cache', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = new ModelCatalog({ endpoints, credentials });

    await catalog.list();
    await catalog.list(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
