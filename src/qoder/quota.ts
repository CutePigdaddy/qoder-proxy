import { SingleFlight } from '../concurrency/singleFlight.js';
import { metrics } from '../obs/metrics.js';
import { logger, redactSecrets } from '../obs/logger.js';
import { HttpError } from '../util/errors.js';
import type { CredentialStore } from './credentialStore.js';
import type { Endpoints } from './endpoints.js';

/** Which bucket a credit pool belongs to. */
export type QuotaPoolKind = 'subscription' | 'addon' | 'shared';

export interface QuotaPool {
  kind: QuotaPoolKind;
  /** `null` when the upstream omits the figure instead of reporting zero. */
  total: number | null;
  used: number | null;
  remaining: number;
  /** Derived locally: `used / total * 100`. `null` when total is unknown or 0. */
  percentUsed: number | null;
  unit: string;
  expiresAt: string | null;
  detailUrl?: string;
  available?: boolean;
}

export interface QuotaSnapshot {
  unit: string;
  plan: string | null;
  paidPlan: boolean | null;
  userType: string | null;
  /** True when the upstream says the account can no longer spend credits. */
  exceeded: boolean;
  prorated: boolean;
  /** End of the current quota period, when the upstream reports one. */
  periodEndAt: string | null;
  pools: QuotaPool[];
  /** Sum across pools. `null` only when no pool reported the figure at all. */
  total: number | null;
  used: number | null;
  remaining: number;
  percentUsed: number | null;
  upgradeUrl: string | null;
  fetchedAt: string;
  /** True when served from the in-process cache instead of a fresh upstream call. */
  cached: boolean;
  warning?: string;
}

/** Fields the CN OpenAPI nests its pools in, in display order. */
const POOL_FIELDS: Array<{ field: string; kind: QuotaPoolKind }> = [
  { field: 'userQuota', kind: 'subscription' },
  { field: 'addOnQuota', kind: 'addon' },
  { field: 'orgResourcePackage', kind: 'shared' },
];

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

/**
 * Upstream timestamps arrive as milliseconds, seconds, or RFC3339 strings.
 * `253402214400000` (year 9999) means "never" and is passed through as-is so
 * clients can decide; collapsing it to `null` would hide the distinction.
 */
function toIso(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
    const numeric = toNumber(value);
    return numeric === null ? null : toIso(numeric);
  }
  const numeric = toNumber(value);
  if (numeric === null || numeric <= 0) return null;
  const millis = numeric > 1e11 ? numeric : numeric * 1000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function percentOf(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) return null;
  return Math.round((used / total) * 1000) / 10;
}

function parsePool(kind: QuotaPoolKind, raw: unknown, unit: string): QuotaPool | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const object = raw as Record<string, unknown>;
  const remaining = toNumber(object.remaining);
  // Without `remaining` the pool tells us nothing usable; drop it rather than
  // inventing a zero that would read as "quota exhausted".
  if (remaining === null) return null;

  const total = toNumber(object.total);
  const used = toNumber(object.used);
  const available = typeof object.available === 'boolean' ? object.available : undefined;
  const pool: QuotaPool = {
    kind,
    total,
    used,
    remaining,
    percentUsed: percentOf(used, total),
    unit: typeof object.unit === 'string' && object.unit ? object.unit : unit,
    expiresAt: toIso(object.expiresAt ?? object.expireAt),
    ...(available === undefined ? {} : { available }),
  };
  if (typeof object.detailUrl === 'string' && object.detailUrl) pool.detailUrl = object.detailUrl;
  return pool;
}

/**
 * Normalize `/api/v2/quota/usage` (plus the optional plan payload) into one
 * snapshot. Pure function so the wire quirks stay testable without network.
 */
export function parseQuota(usage: unknown, plan?: unknown): QuotaSnapshot {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    throw new HttpError(502, 'Quota endpoint returned an unexpected payload');
  }
  const raw = usage as Record<string, unknown>;
  const unit = typeof raw.usageType === 'string' && raw.usageType ? raw.usageType : 'credits';

  const pools: QuotaPool[] = [];
  let warning: string | undefined;
  for (const { field, kind } of POOL_FIELDS) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    const parsed = parsePool(kind, value, unit);
    if (parsed) pools.push(parsed);
    else warning = `Ignored unreadable "${field}" block; check the official usage page.`;
  }

  const knownTotals = pools.map((p) => p.total).filter((v): v is number => v !== null);
  const knownUsed = pools.map((p) => p.used).filter((v): v is number => v !== null);
  const total = knownTotals.length > 0 ? knownTotals.reduce((a, b) => a + b, 0) : null;
  const used = knownUsed.length > 0 ? knownUsed.reduce((a, b) => a + b, 0) : null;
  const remaining = pools.reduce((sum, pool) => sum + pool.remaining, 0);

  const subscription = pools.find((pool) => pool.kind === 'subscription');
  const planRaw =
    plan && typeof plan === 'object' && !Array.isArray(plan) ? (plan as Record<string, unknown>) : null;

  return {
    unit,
    plan: planRaw && typeof planRaw.plan_tier_name === 'string' ? planRaw.plan_tier_name : null,
    paidPlan: planRaw && typeof planRaw.is_paid_plan === 'boolean' ? planRaw.is_paid_plan : null,
    userType: typeof raw.userType === 'string' ? raw.userType : null,
    exceeded: raw.isQuotaExceeded === true,
    prorated: raw.isPlanQuotaProrated === true,
    periodEndAt: subscription?.expiresAt ?? toIso(raw.expiresAt),
    pools,
    total,
    used,
    remaining,
    percentUsed: percentOf(used, total),
    upgradeUrl: typeof raw.upgradeUrl === 'string' && raw.upgradeUrl ? raw.upgradeUrl : null,
    fetchedAt: new Date().toISOString(),
    cached: false,
    ...(warning ? { warning } : {}),
  };
}

const DEFAULT_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Cached view over the upstream quota endpoints.
 *
 * A dashboard polls this, so a page refresh must not become an upstream hit:
 * results are reused for `ttlMs` and concurrent callers share one flight.
 */
export class QuotaService {
  private snapshot: QuotaSnapshot | null = null;
  private fetchedAtMs = 0;
  private readonly flight = new SingleFlight<QuotaSnapshot>();
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly opts: {
      endpoints: Endpoints;
      credentials: Pick<CredentialStore, 'get'>;
      ttlMs?: number;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.ttlMs = opts.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Last known snapshot without touching the network. */
  peek(): QuotaSnapshot | null {
    return this.snapshot;
  }

  async get(force = false): Promise<QuotaSnapshot> {
    if (!force && this.snapshot && Date.now() - this.fetchedAtMs < this.ttlMs) {
      return { ...this.snapshot, cached: true };
    }
    return this.flight.run(async () => {
      // A queued caller may have refreshed while we waited on the flight.
      if (!force && this.snapshot && Date.now() - this.fetchedAtMs < this.ttlMs) {
        return { ...this.snapshot, cached: true };
      }
      return this.load();
    });
  }

  private async load(): Promise<QuotaSnapshot> {
    const credentials = await this.opts.credentials.get();
    let snapshot: QuotaSnapshot;
    try {
      const usage = await this.fetchJson(this.opts.endpoints.usage, credentials.jobToken);
      let plan: unknown = null;
      try {
        plan = await this.fetchJson(`${this.opts.endpoints.openapi}/api/v2/user/plan`, credentials.jobToken);
      } catch (error) {
        // Plan metadata is cosmetic; the credits themselves already succeeded.
        logger.debug({ err: String(error) }, 'quota plan lookup failed');
      }
      snapshot = parseQuota(usage, plan);
      if (!snapshot.plan) {
        snapshot.warning = snapshot.warning ?? 'Plan details are unavailable; credits are still accurate.';
      }
    } catch (error) {
      metrics.quotaFetch.inc({ result: 'error' });
      throw error;
    }

    this.snapshot = snapshot;
    this.fetchedAtMs = Date.now();
    metrics.quotaFetch.inc({ result: 'ok' });
    metrics.quotaRemaining.set(snapshot.remaining);
    if (snapshot.total !== null) metrics.quotaTotal.set(snapshot.total);
    if (snapshot.used !== null) metrics.quotaUsed.set(snapshot.used);
    return snapshot;
  }

  private async fetchJson(url: string, token: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'User-Agent': 'qoder-proxy/0.1',
          'Cosy-Version': '1.0.1',
          'Cosy-ClientType': '5',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new HttpError(502, redactSecrets(`Quota lookup failed: ${String(error)}`));
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new HttpError(
        502,
        redactSecrets(`Quota lookup rejected (${response.status}): ${body.slice(0, 200)}`),
      );
    }

    try {
      return await response.json();
    } catch {
      throw new HttpError(502, 'Quota endpoint returned non-JSON');
    }
  }
}
