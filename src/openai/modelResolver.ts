import type { ModelMapping } from '../config.js';
import type { ResolvedModel } from '../qoder/client.js';
import type { CatalogEntry, CatalogPromotion, ModelCatalog } from '../qoder/modelCatalog.js';

/**
 * live: 配置与上游目录都有；config-only: 只在配置里，上游目录没有（调用可能被拒）；
 * upstream-only: 上游新增、配置未映射，只能用 wire key 调用。
 */
export type ModelAvailability = 'live' | 'config-only' | 'upstream-only';

export interface ModelListEntry {
  /** Name clients send as `model`. */
  id: string;
  displayName: string;
  /** Upstream wire key this id forwards to. */
  upstream: string;
  /** 上游自己的显示名；null 表示上游目录里没有这个 key（仅配置），名字未知 */
  upstreamDisplayName: string | null;
  /** 单次请求可输入的最大 token；上游没给就为 null */
  contextWindow: number | null;
  /** 上游 context_config 暴露的档位（升序） */
  contextWindows: number[];
  maxOutputTokens: number;
  capabilities: { reasoning: boolean; vision: boolean };
  /** factor 是当前生效系数（促销后），originalFactor 是促销前 */
  pricing: { factor: number | null; originalFactor: number | null; free: boolean };
  promotion: CatalogPromotion | null;
  isDefault: boolean;
  availability: ModelAvailability;
}

const DEFAULT_MAX_OUTPUT = 32_768;

/**
 * Loose comparison key: lowercase with separators removed, so
 * `Qwen3.8-Max`, `qwen 3.8 max`, `qwen3-8-max` and `QWEN38MAX` all collapse.
 */
function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function fromEntry(entry: CatalogEntry, matched: NonNullable<ResolvedModel['matched']>): ResolvedModel {
  return {
    key: entry.key,
    id: entry.displayName || entry.key,
    isReasoning: entry.isReasoning,
    maxOutputTokens: entry.maxOutputTokens,
    matched,
  };
}

function fromMapping(
  mapping: ModelMapping,
  entries: CatalogEntry[],
  matched: NonNullable<ResolvedModel['matched']>,
): ResolvedModel {
  const entry =
    entries.find((e) => e.key === mapping.upstream) ??
    entries.find((e) => normalise(e.key) === normalise(mapping.upstream));
  return {
    key: mapping.upstream,
    id: mapping.id,
    // The curated table is authoritative for naming; the catalog only supplies
    // metadata when it happens to list the same key.
    isReasoning: mapping.isReasoning ?? entry?.isReasoning ?? false,
    maxOutputTokens: mapping.maxOutputTokens ?? entry?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
    matched,
  };
}

/** 目录行：把上游元数据与配置表合并成客户端可读的一条记录。 */
function toListEntry(
  id: string,
  upstream: string,
  entry: CatalogEntry | undefined,
  availability: ModelAvailability,
  mapping?: ModelMapping,
): ModelListEntry {
  return {
    id,
    displayName: id,
    upstream,
    upstreamDisplayName: entry?.displayName ?? null,
    contextWindow: entry?.maxInputTokens ?? null,
    contextWindows: entry?.contextWindows ?? [],
    maxOutputTokens: mapping?.maxOutputTokens ?? entry?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
    capabilities: {
      reasoning: mapping?.isReasoning ?? entry?.isReasoning ?? false,
      vision: entry?.isVision ?? false,
    },
    pricing: {
      factor: entry?.priceFactor ?? null,
      originalFactor: entry?.originalPriceFactor ?? entry?.promotion?.beforeFactor ?? null,
      free: entry?.isFree ?? false,
    },
    promotion: entry?.promotion ?? null,
    isDefault: entry?.isDefault ?? false,
    availability,
  };
}

/**
 * Maps a client-supplied model name onto a Qoder wire key.
 *
 * The wire keys the upstream expects (`qmodel_38max`, `dmodel`, `kmodel_latest`)
 * are unusable as client-facing names, so `config/models.json` carries a curated
 * display-name -> key table. Clients speak display names; this class translates.
 *
 * Resolution order, each step tolerant of case and separators:
 *   1. exact upstream key        (`dmodel`)            - kept for scripts
 *   2. curated mapping id        (`DeepSeek-V4-Pro`)
 *   3. normalised key            (`DeepSeekV4Pro`, `dmodel`)
 *   4. normalised mapping id     (`deepseek-v4-pro`)
 *   5. configured alias          (`gpt-4o` -> `auto`)
 *   6. live catalog display name (`DeepSeek-V4-Pro` on accounts we did not curate)
 *   7. configured fallback       (`auto`)
 */
export class ModelResolver {
  constructor(
    private readonly opts: {
      catalog: ModelCatalog;
      models?: ModelMapping[];
      aliases: Record<string, string>;
      fallback: string;
    },
  ) {}

  async resolve(requested: string): Promise<ResolvedModel> {
    const wanted = requested.trim();
    const entries = await this.opts.catalog.list();
    const mappings = this.opts.models ?? [];

    const exactKey = entries.find((entry) => entry.key === wanted);
    if (exactKey) return fromEntry(exactKey, 'key');

    const exactMapping = mappings.find((mapping) => mapping.id === wanted);
    if (exactMapping) return fromMapping(exactMapping, entries, 'mapped');

    const wantedNorm = normalise(wanted);
    if (wantedNorm) {
      const keyed = entries.find((entry) => normalise(entry.key) === wantedNorm);
      if (keyed) return fromEntry(keyed, 'key');

      const mapped = mappings.find((mapping) => normalise(mapping.id) === wantedNorm);
      if (mapped) return fromMapping(mapped, entries, 'mapped');

      const aliasTarget = this.lookupAlias(wanted);
      if (aliasTarget) {
        const aliased = this.matchTarget(aliasTarget, entries, mappings, 'alias');
        if (aliased) return aliased;
      }

      const byDisplay = entries.find((entry) => normalise(entry.displayName) === wantedNorm);
      if (byDisplay) return fromEntry(byDisplay, 'display');
    }

    const fallback = this.matchTarget(this.opts.fallback, entries, mappings, 'fallback');
    return (
      fallback ?? {
        key: this.opts.fallback,
        id: this.opts.fallback,
        isReasoning: false,
        maxOutputTokens: DEFAULT_MAX_OUTPUT,
        matched: 'fallback',
      }
    );
  }

  /** Resolve an alias target or the fallback tier to a concrete model. */
  private matchTarget(
    target: string,
    entries: CatalogEntry[],
    mappings: ModelMapping[],
    matched: NonNullable<ResolvedModel['matched']>,
  ): ResolvedModel | undefined {
    const entry = entries.find((e) => e.key === target);
    if (entry) return fromEntry(entry, matched);

    const mapping = mappings.find((m) => m.id === target);
    if (mapping) return fromMapping(mapping, entries, matched);

    const norm = normalise(target);
    const keyed = entries.find((e) => normalise(e.key) === norm);
    if (keyed) return fromEntry(keyed, matched);

    const mapped = mappings.find((m) => normalise(m.id) === norm);
    if (mapped) return fromMapping(mapped, entries, matched);

    const byUpstream = mappings.find((m) => normalise(m.upstream) === norm);
    if (byUpstream) return fromMapping(byUpstream, entries, matched);

    const byDisplay = entries.find((e) => normalise(e.displayName) === norm);
    return byDisplay ? fromEntry(byDisplay, matched) : undefined;
  }

  /** Alias table lookup, tolerant of case and separators. */
  private lookupAlias(requested: string): string | undefined {
    const exact = this.opts.aliases[requested];
    if (exact) return exact;

    const wanted = normalise(requested);
    for (const [name, target] of Object.entries(this.opts.aliases)) {
      if (normalise(name) === wanted) return target;
    }
    return undefined;
  }

  /**
   * The catalog as clients should see it: curated display names first, then any
   * key the upstream added that we have not mapped yet.
   *
   * 去重按 **wire key** 而不是显示名：同一个 key 在配置和上游可能有两个名字
   * （`mmodel` 既是配置里的 MiniMax-M2.7，也是上游的 MiniMax-M3.1-Flash），
   * 按名字去重会把同一个模型列出两遍。
   */
  async list(force = false): Promise<ModelListEntry[]> {
    const entries = await this.opts.catalog.list(force);
    const out: ModelListEntry[] = [];
    const seen = new Set<string>();

    const push = (
      id: string,
      upstream: string,
      entry: CatalogEntry | undefined,
      availability: ModelAvailability,
      mapping?: ModelMapping,
    ) => {
      if (seen.has(upstream)) return;
      seen.add(upstream);
      out.push(toListEntry(id, upstream, entry, availability, mapping));
    };

    for (const mapping of this.opts.models ?? []) {
      const entry =
        entries.find((e) => e.key === mapping.upstream) ??
        entries.find((e) => normalise(e.key) === normalise(mapping.upstream));
      push(mapping.id, mapping.upstream, entry, entry ? 'live' : 'config-only', mapping);
    }

    for (const entry of entries) {
      push(entry.displayName || entry.key, entry.key, entry, 'upstream-only');
    }

    return out;
  }
}
