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
