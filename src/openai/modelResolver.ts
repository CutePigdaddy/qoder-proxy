import type { ResolvedModel } from '../qoder/client.js';
import type { CatalogEntry, ModelCatalog } from '../qoder/modelCatalog.js';

export interface ModelListEntry {
  id: string;
  displayName: string;
}

const DEFAULT_MAX_OUTPUT = 32_768;

/**
 * Loose comparison key: lowercase with separators removed, so
 * `Qwen3.8-Max`, `qwen 3.8 max` and `QWEN3.8MAX` all collapse together.
 */
function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function toResolved(entry: CatalogEntry, matched: NonNullable<ResolvedModel['matched']>): ResolvedModel {
  return {
    key: entry.key,
    isReasoning: entry.isReasoning,
    maxOutputTokens: entry.maxOutputTokens,
    matched,
  };
}

/**
 * Maps a client-supplied model name onto a Qoder wire key.
 *
 * Order:
 *   1. exact catalog key          (`dmodel`)
 *   2. case-insensitive key       (`DModel`)
 *   3. configured alias           (`gpt-4o` -> `auto`)
 *   4. catalog display name       (`DeepSeek-V4-Pro` -> `dmodel`)
 *   5. configured fallback        (`auto`)
 *
 * Step 4 matters because the catalog advertises friendly names while the chat
 * endpoint only accepts wire keys; forwarding a display name upstream yields
 * `400 该模型当前未对账号开放`. Unknown names still never 404 — the gateway
 * answers from `auto` rather than making every client a configuration exercise.
 */
export class ModelResolver {
  constructor(
    private readonly opts: {
      catalog: ModelCatalog;
      aliases: Record<string, string>;
      fallback: string;
    },
  ) {}

  async resolve(requested: string): Promise<ResolvedModel> {
    const wanted = requested.trim();
    const entries = await this.opts.catalog.list();

    const direct = entries.find((entry) => entry.key === wanted);
    if (direct) return toResolved(direct, 'key');

    const wantedNorm = normalise(wanted);
    if (wantedNorm) {
      const keyed = entries.find((entry) => normalise(entry.key) === wantedNorm);
      if (keyed) return toResolved(keyed, 'key');

      const aliasTarget = this.lookupAlias(wanted);
      if (aliasTarget) {
        const aliased =
          entries.find((entry) => entry.key === aliasTarget) ??
          entries.find((entry) => normalise(entry.key) === normalise(aliasTarget)) ??
          entries.find((entry) => normalise(entry.displayName) === normalise(aliasTarget));
        // An alias that points outside the live catalog would only be rejected
        // upstream, so fall through to the display-name and fallback stages.
        if (aliased) return toResolved(aliased, 'alias');
      }

      const byDisplay = entries.find((entry) => normalise(entry.displayName) === wantedNorm);
      if (byDisplay) return toResolved(byDisplay, 'display');
    }

    const fallback =
      entries.find((entry) => entry.key === this.opts.fallback) ??
      entries.find((entry) => normalise(entry.key) === normalise(this.opts.fallback));
    return fallback
      ? toResolved(fallback, 'fallback')
      : { key: this.opts.fallback, isReasoning: false, maxOutputTokens: DEFAULT_MAX_OUTPUT, matched: 'fallback' };
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

  async list(): Promise<ModelListEntry[]> {
    const entries = await this.opts.catalog.list();
    return entries.map((entry) => ({ id: entry.key, displayName: entry.displayName }));
  }
}
