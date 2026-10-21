import crypto from 'node:crypto';
import type { IREvent, IRRequest } from '../ir/types.js';
import { logger, redactSecrets } from '../obs/logger.js';
import { CredentialRejectedError, HttpError, QuotaExhaustedError, mapUpstreamFailure } from '../util/errors.js';
import { encodeQoderBody } from './bodyCodec.js';
import { buildCosyHeadersFor } from './cosySigner.js';
import type { CredentialStore } from './credentialStore.js';
import type { Endpoints } from './endpoints.js';
import { buildMessages, type TokenMarkerMode } from './messageBuilder.js';
import { decodeQoderSse } from './sseDecoder.js';

export interface ResolvedModel {
  /** Wire key sent as `model_config.key` and `X-Model-Key`. */
  key: string;
  /** Client-facing name echoed back to the caller, e.g. `DeepSeek-V4-Pro`. */
  id: string;
  isReasoning: boolean;
  maxOutputTokens: number;
  /** How the key was chosen, for logging and debugging clients. */
  matched?: 'key' | 'mapped' | 'display' | 'alias' | 'fallback';
}

interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/**
 * Rebuild a value with object keys sorted and tool entries ordered by name,
 * so the tool block serialises byte-identically regardless of client-side
 * key order or array order. The upstream renders tools at the head of the
 * prompt — any serialisation jitter there voids the entire prompt cache.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = canonicalize(record[key]);
    return out;
  }
  return value;
}

interface QoderDelta {
  content?: string;
  reasoning_content?: string;
  tool_calls?: ToolCallDelta[];
}

interface QoderInner {
  choices?: Array<{ delta?: QoderDelta; finish_reason?: string }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      cacheable_tokens?: number;
    };
  };
}

function stableId(prefix: string, ...parts: string[]): string {
  const hash = crypto.createHash('sha256').update(prefix);
  for (const part of parts) {
    hash.update('\u0000');
    hash.update(part);
  }
  return hash.digest('hex').slice(0, 32);
}

/** Back-off attempts for transient upstream refusal (429 rate limit / 503 busy). */
const MAX_BUSY_RETRIES = 2;
const DEFAULT_RETRY_MAX_WAIT_MS = 30_000;

/**
 * Transient upstream refusal: worth another attempt. 429 also carries the
 * terminal quota signal, which must pass straight through — retrying it only
 * delays an error the caller needs to see (`DESIGN.md` §7).
 */
function isTransientBusy(error: unknown): error is HttpError {
  return (
    error instanceof HttpError &&
    !(error instanceof QuotaExhaustedError) &&
    (error.status === 429 || error.status === 503)
  );
}

/**
 * Wait `ms`, or stop as soon as the caller disconnects. Returns false when the
 * wait was cut short — the caller is gone, so there is nothing left to retry.
 */
function waitForRetry(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function parseToolArguments(raw: string, identity: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(502, `Upstream tool call arguments were not valid JSON (${identity})`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(502, `Upstream tool call arguments were not an object (${identity})`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Hash grids over the wire conversation, for one-off prompt-cache forensics
 * (`CACHE_DIAGNOSTICS=1`). The first mismatching segment between two calls is
 * what voids the whole prefix match, so a dense grid localises the culprit.
 *
 * Off by default: it re-serialises the entire conversation and runs ~144 SHA-256
 * passes per usage event, which is real work on a multi-megabyte prompt. It must
 * also never log raw prompt text — grids over a stable prefix are enough.
 */
function cacheDiagnostics(
  messages: unknown[],
  tools: Array<{ function: { name: string } }>,
  prompt: number,
  completion: number,
  details: { cached_tokens?: number; cacheable_tokens?: number } | undefined,
): Record<string, unknown> {
  const wire = JSON.stringify(messages);
  const hash = (text: string): string => crypto.createHash('sha256').update(text).digest('hex').slice(0, 6);
  const seg = (start: number, len: number): string => hash(wire.slice(start, start + len));
  const grid: string[] = [];
  for (let i = 0; i < 64; i += 1) grid.push(seg(i * 1024, 1024)); // dense 0-64 KiB
  const far: string[] = [];
  for (let i = 0; i < 40; i += 1) far.push(seg(65_536 + i * 32_768, 32_768)); // coarse tail
  const toolsJson = JSON.stringify(tools);
  const tgrid: string[] = [];
  for (let i = 0; i < 8; i += 1) tgrid.push(hash(toolsJson.slice(i * 256, i * 256 + 256)));
  const mgrid: string[] = []; // fine grid over the 128-192 KiB band
  for (let i = 0; i < 32; i += 1) mgrid.push(seg(131_072 + i * 2048, 2048));

  return {
    promptTokens: prompt,
    completionTokens: completion,
    cachedTokens: details?.cached_tokens ?? 0,
    cacheableTokens: details?.cacheable_tokens ?? 0,
    msgCount: messages.length,
    promptChars: wire.length,
    toolsN: tools.length,
    toolsNameHash: hash(tools.map((tool) => tool.function.name).join(',')),
    toolsFullHash: hash(toolsJson),
    grid: grid.join(','),
    far: far.join(','),
    tgrid: tgrid.join(','),
    mgrid: mgrid.join(','),
  };
}

/**
 * Upstream client for the Qoder CN chat gateway.
 *
 * The whole wire contract lives here: body shape, WAF encoding, COSY signing,
 * double-layer SSE unwrapping, and translation into neutral IR events.
 */
export class QoderClient {
  private readonly retryMaxWaitMs: number;

  constructor(
    private readonly opts: {
      endpoints: Endpoints;
      credentials: CredentialStore;
      tokenMarkerMode?: TokenMarkerMode;
      /** Upper bound for a single back-off wait, in milliseconds. */
      retryMaxWaitMs?: number;
      /** Emit the prompt-cache hash grids on the usage event (`CACHE_DIAGNOSTICS=1`). */
      cacheDiagnostics?: boolean;
    },
  ) {
    this.retryMaxWaitMs = opts.retryMaxWaitMs ?? DEFAULT_RETRY_MAX_WAIT_MS;
  }

  /**
   * Stream one chat completion. Before anything has been streamed to the
   * caller, absorb transient upstream refusals internally instead of surfacing
   * them: credential rejections trigger one forced refresh, rate limiting and
   * queue pressure (429/503) are retried after a short back-off (up to twice,
   * capped at `retryMaxWaitMs` per wait). Clients that retry on 429 in a tight
   * loop would otherwise hammer a rate-limited upstream into permanent
   * rejection.
   *
   * Quota exhaustion also arrives as 429 but is terminal, so it is never
   * retried; and the back-off wait aborts with the caller, so a disconnected
   * client never keeps a concurrency slot pinned for the full wait.
   */
  async *chat(req: IRRequest, model: ResolvedModel, signal: AbortSignal): AsyncGenerator<IREvent> {
    let credentialRetries = 0;
    let busyRetries = 0;
    for (;;) {
      let yielded = false;
      try {
        for await (const event of this.runChat(req, model, signal)) {
          yielded = true;
          yield event;
        }
        return;
      } catch (error) {
        if (yielded || signal.aborted) throw error;

        if (error instanceof CredentialRejectedError && credentialRetries < 1) {
          credentialRetries += 1;
          logger.warn(
            {
              model: model.key,
              upstream: redactSecrets(error.upstreamBody ?? '').slice(0, 200),
            },
            'upstream rejected the credential; refreshing and retrying once',
          );
          await this.opts.credentials.forceRefresh();
          continue;
        }

        if (isTransientBusy(error) && busyRetries < MAX_BUSY_RETRIES) {
          busyRetries += 1;
          const waitMs = Math.min((error.retryAfter ?? busyRetries * 2) * 1000, this.retryMaxWaitMs);
          logger.warn(
            { model: model.key, status: error.status, waitMs, busyRetries },
            'upstream rate limited or busy before streaming; backing off and retrying',
          );
          // A caller that walked away must not keep the slot for the whole wait.
          if (!(await waitForRetry(waitMs, signal))) throw error;
          continue;
        }

        throw error;
      }
    }
  }

  private async *runChat(
    req: IRRequest,
    model: ResolvedModel,
    signal: AbortSignal,
  ): AsyncGenerator<IREvent> {
    const creds = await this.opts.credentials.get();
    const { messages, lastUserText } = buildMessages(req, {
      tokenMarkerMode: this.opts.tokenMarkerMode,
    });

    const tools = (req.tools ?? [])
      .map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }))
      .sort((a, b) => (a.function.name < b.function.name ? -1 : a.function.name > b.function.name ? 1 : 0))
      .map((tool) => canonicalize(tool)) as Array<{
      type: string;
      function: { name: string; description?: string; parameters?: unknown };
    }>;

    const maxTokens =
      req.maxTokens && req.maxTokens > 0
        ? Math.min(req.maxTokens, model.maxOutputTokens)
        : model.maxOutputTokens;

    // Per-request nonce: identical (or retried) payloads must never reuse the
    // same session/record ids — the upstream treats id collisions across
    // concurrent requests as replay and rejects them with credential errors.
    const nonce = crypto.randomUUID();
    const sessionId = stableId('qoder-session', creds.userID, model.key, nonce);
    const recordId = stableId(
      'qoder-record',
      model.key,
      nonce,
      JSON.stringify(messages),
      JSON.stringify(tools),
      String(maxTokens),
    );

    const body: Record<string, unknown> = {
      request_id: crypto.randomUUID(),
      request_set_id: recordId,
      chat_record_id: recordId,
      session_id: sessionId,
      stream: true,
      chat_task: 'FREE_INPUT',
      is_reply: true,
      is_retry: false,
      source: 1,
      version: '3',
      session_type: 'qodercli',
      agent_id: 'agent_common',
      task_id: 'common',
      code_language: '',
      chat_prompt: '',
      image_urls: null,
      aliyun_user_type: '',
      messages,
      tools,
      parameters: {
        max_tokens: maxTokens,
        ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
      },
      chat_context: {
        chatPrompt: '',
        imageUrls: null,
        extra: {
          context: [],
          modelConfig: { key: model.key, is_reasoning: model.isReasoning },
          originalContent: lastUserText,
        },
        features: [],
        text: lastUserText,
      },
      model_config: { key: model.key, is_reasoning: model.isReasoning },
      business: {
        product: 'cli',
        version: '1.0.0',
        type: 'agent',
        stage: 'start',
        id: crypto.randomUUID(),
        name: lastUserText.slice(0, 30),
        begin_at: Date.now(),
      },
    };

    const encodedBody = encodeQoderBody(Buffer.from(JSON.stringify(body)));
    const encodedBytes = Buffer.from(encodedBody, 'utf8');
    const headers = buildCosyHeadersFor(encodedBytes, this.opts.endpoints.chat, creds);

    let response: Response;
    try {
      response = await fetch(this.opts.endpoints.chat, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Accept-Encoding': 'identity',
          'X-Model-Key': model.key,
          'X-Model-Source': 'system',
          ...headers,
        },
        body: encodedBytes,
        signal,
      });
    } catch (error) {
      if (signal.aborted) return;
      throw new HttpError(502, `Upstream request failed: ${String(error)}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw mapUpstreamFailure({ status: response.status, body: text });
    }
    if (!response.body) {
      throw new HttpError(502, 'Upstream returned an empty body');
    }

    const toolsInFlight = new Map<number, { id: string; name: string; arguments: string }>();
    let sawContent = false;

    for await (const envelope of decodeQoderSse(response.body)) {
      if (typeof envelope.statusCodeValue === 'number' && envelope.statusCodeValue !== 200) {
        throw mapUpstreamFailure({
          status: envelope.statusCodeValue,
          body: envelope.body ?? '',
        });
      }
      if (!envelope.body || envelope.body === '[DONE]') continue;

      let inner: QoderInner;
      try {
        inner = JSON.parse(envelope.body) as QoderInner;
      } catch {
        throw new HttpError(502, 'Upstream SSE payload was not valid JSON');
      }

      if (inner.usage) {
        const prompt = inner.usage.prompt_tokens ?? inner.usage.input_tokens ?? 0;
        const completion = inner.usage.completion_tokens ?? inner.usage.output_tokens ?? 0;
        const details = inner.usage.prompt_tokens_details;
        logger.info(
          {
            model: model.id,
            promptTokens: prompt,
            completionTokens: completion,
            cachedTokens: details?.cached_tokens ?? 0,
            cacheableTokens: details?.cacheable_tokens ?? 0,
            msgCount: messages.length,
            toolsN: tools.length,
          },
          'usage',
        );
        if (this.opts.cacheDiagnostics) {
          logger.debug(cacheDiagnostics(messages, tools, prompt, completion, details), 'usage-cache');
        }
        yield {
          type: 'usage',
          promptTokens: prompt,
          completionTokens: completion,
          totalTokens: inner.usage.total_tokens ?? prompt + completion,
          cachedTokens: details?.cached_tokens,
          cacheableTokens: details?.cacheable_tokens,
        };
      }

      const delta = inner.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.reasoning_content) {
        sawContent = true;
        yield { type: 'reasoning-delta', text: delta.reasoning_content };
      }

      if (delta.content) {
        sawContent = true;
        yield { type: 'text-delta', text: delta.content };
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const index = call.index ?? 0;
          let state = toolsInFlight.get(index);
          if (!state) {
            state = {
              id: call.id || `call_${crypto.randomUUID().slice(0, 8)}`,
              name: call.function?.name ?? '',
              arguments: '',
            };
            toolsInFlight.set(index, state);
            sawContent = true;
            yield { type: 'tool-call-start', index, id: state.id, name: state.name };
          }
          if (call.id) state.id = call.id;
          if (call.function?.name) state.name = call.function.name;

          const argsDelta = call.function?.arguments ?? '';
          if (argsDelta) {
            state.arguments += argsDelta;
            yield { type: 'tool-call-args-delta', index, delta: argsDelta };
          }
        }
      }
    }

    if (signal.aborted) return;

    for (const [index, state] of [...toolsInFlight.entries()].sort((a, b) => a[0] - b[0])) {
      yield {
        type: 'tool-call-end',
        index,
        id: state.id,
        name: state.name,
        arguments: parseToolArguments(state.arguments, state.name || state.id),
      };
    }

    if (!sawContent) {
      throw new HttpError(502, 'Upstream completed without producing any content');
    }

    yield { type: 'done', finishReason: toolsInFlight.size > 0 ? 'tool_calls' : 'stop' };
  }
}
