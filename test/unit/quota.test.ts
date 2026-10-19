import { describe, expect, it, vi } from 'vitest';
import { QuotaService, parseQuota } from '../../src/qoder/quota.js';

/** Verbatim payload captured from /api/v2/quota/usage on a Free-plan account. */
const LIVE_USAGE = {
  userId: '01a0c2da-0593-775d-85df-b0c6541614d3',
  userType: 'personal_standard',
  usageType: 'credits',
  totalUsagePercentage: 0.1,
  isQuotaExceeded: false,
  expiresAt: 253402214400000,
  upgradeUrl: 'https://qoder.com.cn/pricing?client=qoder',
  outerProviders: [],
  userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: 'credits' },
  addOnQuota: {
    total: 400,
    used: 36,
    remaining: 364,
    percentage: 0.1,
    unit: 'credits',
    detailUrl: 'https://qoder.com.cn/account/usage',
  },
  isPlanQuotaProrated: false,
};

const LIVE_PLAN = {
  user_type: 'personal_standard',
  plan_tier_name: 'Free',
  is_personal_version: true,
  is_paid_plan: false,
  is_highest_tier: false,
  start_date: 1791185063627,
  end_date: 0,
};

const endpoints = {
  gateway: 'https://gateway.example',
  openapi: 'https://openapi.example',
  chat: 'https://gateway.example/chat',
  modelList: 'https://gateway.example/models',
  exchange: 'https://openapi.example/api/v1/jobToken/exchange',
  refresh: 'https://openapi.example/api/v1/jobToken/refresh',
  userInfo: 'https://openapi.example/api/v1/userinfo',
  usage: 'https://openapi.example/api/v2/quota/usage',
};

describe('parseQuota', () => {
  it('sums the subscription and add-on pools from a live payload', () => {
    const snapshot = parseQuota(LIVE_USAGE, LIVE_PLAN);
    expect(snapshot.unit).toBe('credits');
    expect(snapshot.plan).toBe('Free');
    expect(snapshot.paidPlan).toBe(false);
    expect(snapshot.exceeded).toBe(false);
    expect(snapshot.pools.map((p) => p.kind)).toEqual(['subscription', 'addon']);
    // The subscription pool is empty on a free plan; the add-on carries the balance.
    expect(snapshot.total).toBe(400);
    expect(snapshot.used).toBe(36);
    expect(snapshot.remaining).toBe(364);
    expect(snapshot.percentUsed).toBe(9);
  });

  it('keeps per-pool detail rather than flattening it away', () => {
    const snapshot = parseQuota(LIVE_USAGE, LIVE_PLAN);
    const addon = snapshot.pools.find((p) => p.kind === 'addon');
    expect(addon).toMatchObject({
      total: 400,
      used: 36,
      remaining: 364,
      unit: 'credits',
      detailUrl: 'https://qoder.com.cn/account/usage',
    });
    expect(snapshot.upgradeUrl).toContain('pricing');
  });

  it('treats a year-9999 expiry as a real value, not a parse failure', () => {
    const snapshot = parseQuota(LIVE_USAGE, LIVE_PLAN);
    // The subscription pool carries the period end; the account never expires.
    expect(snapshot.periodEndAt).toBe(new Date(253402214400000).toISOString());
  });

  it('honours isQuotaExceeded', () => {
    const snapshot = parseQuota({ ...LIVE_USAGE, isQuotaExceeded: true });
    expect(snapshot.exceeded).toBe(true);
  });

  it('drops unreadable pools and reports a warning', () => {
    const snapshot = parseQuota({ ...LIVE_USAGE, userQuota: 'n/a' }, LIVE_PLAN);
    expect(snapshot.pools.map((p) => p.kind)).toEqual(['addon']);
    expect(snapshot.warning).toContain('userQuota');
    expect(snapshot.remaining).toBe(364);
  });

  it('never invents a zero for a pool without a remaining figure', () => {
    const snapshot = parseQuota({ userQuota: { total: 100 } });
    expect(snapshot.pools).toEqual([]);
    expect(snapshot.remaining).toBe(0);
    expect(snapshot.total).toBeNull();
    expect(snapshot.warning).toContain('userQuota');
  });

  it('passes through a non-credits unit unchanged', () => {
    const snapshot = parseQuota({ usageType: 'tokens', userQuota: { total: 10, used: 5, remaining: 5 } });
    expect(snapshot.unit).toBe('tokens');
    expect(snapshot.pools[0]?.unit).toBe('tokens');
    expect(snapshot.percentUsed).toBe(50);
  });

  it('rejects a non-object payload with a 502', () => {
    expect(() => parseQuota('nope')).toThrowError(/unexpected payload/);
  });
});

describe('QuotaService', () => {
  const makeService = (responses: unknown[], ttlMs = 60_000) => {
    const fetchImpl = vi.fn(async () => {
      const body = responses.shift() ?? {};
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const service = new QuotaService({
      endpoints,
      credentials: { get: async () => ({ jobToken: 'job-token' }) as never },
      ttlMs,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    return { service, fetchImpl };
  };

  it('serves the second call from cache', async () => {
    const { service, fetchImpl } = makeService([LIVE_USAGE, LIVE_PLAN]);
    const first = await service.get();
    const second = await service.get();
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.remaining).toBe(364);
    // One usage call + one plan call; the cached read adds nothing.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('bypasses the cache when forced', async () => {
    const { service, fetchImpl } = makeService([LIVE_USAGE, LIVE_PLAN, LIVE_USAGE, LIVE_PLAN]);
    await service.get();
    const forced = await service.get(true);
    expect(forced.cached).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('survives a failing plan lookup and still returns credits', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/user/plan')) return new Response('boom', { status: 500 });
      return new Response(JSON.stringify(LIVE_USAGE), { status: 200 });
    });
    const service = new QuotaService({
      endpoints,
      credentials: { get: async () => ({ jobToken: 'job-token' }) as never },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const snapshot = await service.get();
    expect(snapshot.remaining).toBe(364);
    expect(snapshot.plan).toBeNull();
    expect(snapshot.warning).toContain('Plan details');
  });

  it('raises a 502 when the quota call itself fails', async () => {
    const service = new QuotaService({
      endpoints,
      credentials: { get: async () => ({ jobToken: 'job-token' }) as never },
      fetchImpl: (async () => new Response('upstream down', { status: 503 })) as unknown as typeof fetch,
    });
    await expect(service.get()).rejects.toMatchObject({ status: 502 });
  });
});
