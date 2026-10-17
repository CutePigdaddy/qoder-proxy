import type { ResolvedModel } from '../qoder/client.js';
import type { ModelCatalog } from '../qoder/modelCatalog.js';

export interface ModelListEntry {
  id: string;
  displayName: string;
}

/**
 * Maps a client-supplied model name onto a Qoder wire key.
 *
 * Order: exact catalog key -> configured alias -> configured fallback. Unknown
 * names never 404: the gateway would rather answer from `auto` than make every
 * new client a configuration exercise.
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
    const direct = await this.opts.catalog.find(requested);
    if (direct) {
      return { key: direct.key, isReasoning: direct.isReasoning, maxOutputTokens: direct.maxOutputTokens };
    }

    const aliasTarget = this.opts.aliases[requested];
    if (aliasTarget) {
      const aliased = await this.opts.catalog.find(aliasTarget);
      if (aliased) {
        return { key: aliased.key, isReasoning: aliased.isReasoning, maxOutputTokens: aliased.maxOutputTokens };
      }
      return { key: aliasTarget, isReasoning: false, maxOutputTokens: 32_768 };
    }

    const fallback = await this.opts.catalog.find(this.opts.fallback);
    return fallback
      ? { key: fallback.key, isReasoning: fallback.isReasoning, maxOutputTokens: fallback.maxOutputTokens }
      : { key: this.opts.fallback, isReasoning: false, maxOutputTokens: 32_768 };
  }

  async list(): Promise<ModelListEntry[]> {
    const entries = await this.opts.catalog.list();
    return entries.map((entry) => ({ id: entry.key, displayName: entry.displayName }));
  }
}
