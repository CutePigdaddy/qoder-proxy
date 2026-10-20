import crypto from 'node:crypto';
import type { IREvent, IRFinishReason } from '../ir/types.js';

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /**
   * Prompt-cache accounting. `cached_tokens` is the OpenAI-standard cache-hit
   * count (what clients need for cache hit rate); `cacheable_tokens` is a
   * Qoder extension counting the cache-miss portion of this call.
   */
  prompt_tokens_details?: {
    cached_tokens: number;
    cacheable_tokens?: number;
  };
}

/** Fold an IR usage event into the OpenAI usage shape, keeping cache details. */
export function toOpenAIUsage(event: Extract<IREvent, { type: 'usage' }>): OpenAIUsage {
  const hasDetails = event.cachedTokens !== undefined || event.cacheableTokens !== undefined;
  return {
    prompt_tokens: event.promptTokens,
    completion_tokens: event.completionTokens,
    total_tokens: event.totalTokens,
    ...(hasDetails
      ? {
          prompt_tokens_details: {
            cached_tokens: event.cachedTokens ?? 0,
            ...(event.cacheableTokens !== undefined
              ? { cacheable_tokens: event.cacheableTokens }
              : {}),
          },
        }
      : {}),
  };
}

interface ChunkChoice {
  index: number;
  delta: Record<string, unknown>;
  finish_reason: string | null;
}

/**
 * Emits OpenAI `chat.completion.chunk` objects.
 *
 * The encoder is intentionally stateless apart from the id: the route owns the
 * loop, this class only shapes frames.
 */
export class OpenAIStreamEncoder {
  readonly id = `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`;
  readonly created = Math.floor(Date.now() / 1000);
  private roleSent = false;

  constructor(private readonly model: string) {}

  private frame(choices: ChunkChoice[], extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices,
      ...extra,
    };
  }

  private delta(delta: Record<string, unknown>, finishReason: string | null = null): Record<string, unknown> {
    return this.frame([{ index: 0, delta, finish_reason: finishReason }]);
  }

  /** Some clients require an explicit assistant role before content deltas. */
  roleFrame(): Record<string, unknown> {
    this.roleSent = true;
    return this.delta({ role: 'assistant', content: '' });
  }

  ensureRole(): Record<string, unknown> | null {
    return this.roleSent ? null : this.roleFrame();
  }

  text(text: string): Record<string, unknown> {
    return this.delta({ content: text });
  }

  reasoning(text: string): Record<string, unknown> {
    return this.delta({ reasoning_content: text });
  }

  toolStart(index: number, id: string, name: string): Record<string, unknown> {
    return this.delta({
      tool_calls: [{ index, id, type: 'function', function: { name, arguments: '' } }],
    });
  }

  toolArguments(index: number, delta: string): Record<string, unknown> {
    return this.delta({ tool_calls: [{ index, function: { arguments: delta } }] });
  }

  finish(reason: IRFinishReason): Record<string, unknown> {
    const mapped = reason === 'tool_calls' ? 'tool_calls' : reason === 'length' ? 'length' : 'stop';
    return this.delta({}, mapped);
  }

  usage(usage: OpenAIUsage): Record<string, unknown> {
    return this.frame([], { usage });
  }
}
