import type { ModelMapping } from '../config.js';
import type { ResolvedModel } from '../qoder/client.js';
import type { CatalogEntry, ModelCatalog } from '../qoder/modelCatalog.js';

export interface ModelListEntry {
  /** Name clients send as `model`. */
  id: string;
  displayName: string;
  /** Upstream wire key this id forwards to. */
  upstream: string;
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
   */
  async list(): Promise<ModelListEntry[]> {
    const entries = await this.opts.catalog.list();
    const seen = new Set<string>();
    const out: ModelListEntry[] = [];

    const push = (id: string, upstream: string): void => {
      const marker = normalise(id);
      if (!marker || seen.has(marker)) return;
      seen.add(marker);
      out.push({ id, displayName: id, upstream });
    };

    for (const mapping of this.opts.models ?? []) push(mapping.id, mapping.upstream);
    for (const entry of entries) push(entry.displayName || entry.key, entry.key);

    return out;
  }
}
