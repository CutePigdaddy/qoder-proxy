import { SingleFlight } from '../concurrency/singleFlight.js';
import { logger } from '../obs/logger.js';
import { buildCosyHeadersFor } from './cosySigner.js';
import type { CredentialStore } from './credentialStore.js';
import type { Endpoints } from './endpoints.js';

/** 上游的限时促销（错峰折扣），字段按需取用，原文保留在 API 之外。 */
export interface CatalogPromotion {
  active: boolean;
  /** 本地化短标，优先中文，例如「错峰 4 折」 */
  badge?: string;
  description?: string;
  /** 折后价系数，用于核对 priceFactor 是折后值 */
  discountFactor?: number;
  /** 打折前的系数，用于在界面上划掉原价 */
  beforeFactor?: number;
  /** 生效时段，例如 22:00–08:00 */
  window?: string;
}

export interface CatalogEntry {
  /** Wire key the chat endpoint expects. */
  key: string;
  displayName: string;
  isReasoning: boolean;
  maxOutputTokens: number;
  thinkingConfig?: unknown;
  contextConfig?: unknown;
  /** 单次请求可输入的最大 token；缺省时退化为 context_config 里最大档 */
  maxInputTokens?: number;
  /** context_config 暴露的上下文档位（升序），例如 [200000, 400000, 1000000] */
  contextWindows?: number[];
  isVision?: boolean;
  /** 计费系数，与上游口径一致（Auto 0.5、Kimi-K3 1.4） */
  priceFactor?: number | null;
  /** 促销前的系数；有值时说明 priceFactor 已是折后价 */
  originalPriceFactor?: number | null;
  isFree?: boolean;
  isDefault?: boolean;
  promotion?: CatalogPromotion | null;
}

const CACHE_TTL_MS = 10 * 60_000;
/** Hard ceiling on discovery latency; /v1/models must never hang on auth. */
const REMOTE_TIMEOUT_MS = 8_000;
/**
 * How long a failed fetch suppresses retries. Without it, every chat request
 * during a catalog outage pays the full timeout before falling back — the model
 * directory is resolved on the way to every completion.
 */
const FAILURE_TTL_MS = 30_000;
const DEFAULT_MAX_OUTPUT = 32_768;

/**
 * Conservative tiers used before the live catalog is reachable. These are real
 * wire keys the CN gateway accepts — inventing tier names here (`lite`,
 * `performance`) only produces `400` once the catalog fetch fails.
 */
const FALLBACK_ENTRIES: CatalogEntry[] = [
  { key: 'auto', displayName: 'Auto', isReasoning: false, maxOutputTokens: DEFAULT_MAX_OUTPUT, contextWindows: [] },
  {
    key: 'qmodel_latest',
    displayName: 'Qwen3.7-Max',
    isReasoning: true,
    maxOutputTokens: DEFAULT_MAX_OUTPUT,
    contextWindows: [],
  },
  {
    key: 'qmodel',
    displayName: 'Qwen3.7-Plus',
    isReasoning: false,
    maxOutputTokens: DEFAULT_MAX_OUTPUT,
    contextWindows: [],
  },
  {
    key: 'q37fmodel',
    displayName: 'Qwen3.7-Flash',
    isReasoning: false,
    maxOutputTokens: DEFAULT_MAX_OUTPUT,
    contextWindows: [],
  },
  {
    key: 'dmodel',
    displayName: 'DeepSeek-V4-Pro',
    isReasoning: true,
    maxOutputTokens: DEFAULT_MAX_OUTPUT,
    contextWindows: [],
  },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Pull the entry array out of whichever envelope the gateway used today. */
function extractEntries(json: unknown, depth = 0): unknown[] {
  if (Array.isArray(json)) return json;
  if (depth > 3) return [];
  const record = asRecord(json);
  if (!record) return [];
  // The live CN gateway wraps entries in `chat`; accept the other spellings too.
  for (const key of ['chat', 'data', 'models', 'list', 'result', 'items']) {
    const value = record[key];
    if (Array.isArray(value)) return value;
    if (value !== undefined) {
      const nested = extractEntries(value, depth + 1);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 上游文案是 {zh, en} 结构，取中文优先，退化到英文或原字符串。 */
function pickLocalised(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ['zh', 'zh-CN', 'zh_cn', 'en']) {
    const text = record[key];
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return undefined;
}

/** context_config 是 { '200K': { token_count: 200000 }, ... }，只关心档位数值。 */
function extractContextWindows(raw: unknown): number[] {
  const record = asRecord(raw);
  if (!record) return [];
  const sizes = new Set<number>();
  for (const value of Object.values(record)) {
    const entry = asRecord(value);
    const size = asNumber(entry?.token_count ?? entry?.tokenCount ?? value);
    if (size !== null && size > 0) sizes.add(size);
  }
  return [...sizes].sort((a, b) => a - b);
}

function toPromotion(raw: unknown): CatalogPromotion | null {
  const record = asRecord(raw);
  if (!record || record.active !== true) return null;
  const start = typeof record.window_start === 'string' ? record.window_start : undefined;
  const end = typeof record.window_end === 'string' ? record.window_end : undefined;
  return {
    active: true,
    badge: pickLocalised(record.badge),
    description: pickLocalised(record.description),
    discountFactor: asNumber(record.discount_factor) ?? undefined,
    beforeFactor: asNumber(record.before_promotion_price_factor) ?? undefined,
    window: start && end ? `${start}–${end}` : undefined,
  };
}

function toEntry(raw: unknown): CatalogEntry | null {
  const record = asRecord(raw);
  if (!record) return null;

  if (record.enable === false) return null;

  const keyCandidate = record.key ?? record.model ?? record.model_key ?? record.id ?? record.name;
  if (typeof keyCandidate !== 'string' || !keyCandidate.trim()) return null;
  const key = keyCandidate.trim();

  const display = record.display_name ?? record.displayName ?? record.name ?? key;
  const maxOut = Number(record.max_output_tokens ?? record.maxOutputTokens ?? 0);
  const contextWindows = extractContextWindows(record.context_config ?? record.contextConfig);
  const maxInput = asNumber(record.max_input_tokens ?? record.maxInputTokens) ?? contextWindows.at(-1) ?? null;

  return {
    key,
    displayName: typeof display === 'string' && display.trim() ? display.trim() : key,
    isReasoning: Boolean(record.is_reasoning ?? record.isReasoning ?? false),
    maxOutputTokens: Number.isFinite(maxOut) && maxOut > 0 ? maxOut : DEFAULT_MAX_OUTPUT,
    thinkingConfig: record.thinking_config ?? record.thinkingConfig,
    contextConfig: record.context_config ?? record.contextConfig,
    maxInputTokens: maxInput ?? undefined,
    contextWindows,
    isVision: Boolean(record.is_vl ?? record.isVision ?? false),
    priceFactor: asNumber(record.price_factor ?? record.priceFactor),
    originalPriceFactor: asNumber(record.original_price_factor ?? record.originalPriceFactor),
    isFree: Boolean(record.is_free ?? record.isFree ?? false),
    isDefault: Boolean(record.is_default ?? record.isDefault ?? false),
    promotion: toPromotion(record.promotion),
  };
}

/**
 * Normalise a raw `model/list` payload into catalog entries.
 * Exported so the real gateway shape can be locked down by a unit test.
 */
export function parseCatalogPayload(json: unknown): CatalogEntry[] {
  return extractEntries(json)
    .map(toEntry)
    .filter((entry): entry is CatalogEntry => entry !== null);
}

/** Live model directory with a TTL cache and a static fallback. */
export class ModelCatalog {
  private entries: CatalogEntry[] | null = null;
  private fetchedAt = 0;
  private failedAt = 0;
  private readonly flight = new SingleFlight<CatalogEntry[]>();

  constructor(
    private readonly opts: {
      endpoints: Endpoints;
      credentials: CredentialStore;
    },
  ) {}

  async list(force = false): Promise<CatalogEntry[]> {
    if (!force) {
      const now = Date.now();
      if (this.entries && now - this.fetchedAt < CACHE_TTL_MS) return this.entries;
      // Back off after a failure instead of paying the timeout on every request.
      if (this.failedAt !== 0 && now - this.failedAt < FAILURE_TTL_MS) return this.fallback();
    }
    try {
      return await this.flight.run(() => this.fetchRemote());
    } catch (error) {
      this.failedAt = Date.now();
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'model catalog unavailable; falling back to the static table',
      );
      return this.fallback();
    }
  }

  /** Last good catalog, or the conservative built-in table. */
  private fallback(): CatalogEntry[] {
    return this.entries ?? FALLBACK_ENTRIES;
  }

  async find(key: string): Promise<CatalogEntry | undefined> {
    const entries = await this.list();
    return entries.find((e) => e.key === key);
  }

  async has(key: string): Promise<boolean> {
    return (await this.find(key)) !== undefined;
  }

  private async fetchRemote(): Promise<CatalogEntry[]> {
    const creds = await this.opts.credentials.get();
    const headers = buildCosyHeadersFor(null, this.opts.endpoints.modelList, creds);

    // Single timeout source of truth: the previous split (8s outer race over a
    // 15s fetch) left the request running for 7s after we had already given up.
    const response = await fetch(this.opts.endpoints.modelList, {
      headers: { ...headers, Accept: 'application/json', 'Accept-Encoding': 'identity' },
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`model catalog returned ${response.status}`);

    const entries = parseCatalogPayload(await response.json());

    if (entries.length === 0) throw new Error('model catalog was empty');

    this.entries = entries;
    this.fetchedAt = Date.now();
    this.failedAt = 0;
    return entries;
  }
}
