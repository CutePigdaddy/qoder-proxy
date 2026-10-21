import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Release } from '../../concurrency/admission.js';
import { redactSecrets } from '../../obs/logger.js';
import { metrics } from '../../obs/metrics.js';
import { inferApplication } from '../../obs/usageStore.js';
import { CompletionAccumulator } from '../../openai/nonStreamAdapter.js';
import { parseChatRequest } from '../../openai/requestAdapter.js';
import { OpenAIStreamEncoder, toOpenAIUsage, type OpenAIUsage } from '../../openai/streamAdapter.js';
import { ClientGoneError, HttpError } from '../../util/errors.js';
import type { Deps } from '../deps.js';

function errorResponse(c: Context, status: number, message: string, retryAfter?: number): Response {
  const type =
    status === 401
      ? 'authentication_error'
      : status === 429
        ? 'rate_limit_error'
        : status >= 500
          ? 'upstream_error'
          : 'invalid_request_error';
  // Only meaningful on the two statuses clients back off on, and only when the
  // upstream actually supplied a hint.
  if (retryAfter !== undefined && (status === 429 || status === 503)) {
    c.header('Retry-After', String(retryAfter));
  }
  return c.json({ error: { message, type } }, status as ContentfulStatusCode);
}

export function registerChat(app: Hono, deps: Deps): void {
  app.post('/v1/chat/completions', async (c) => {
    const started = Date.now();
    let release: Release | null = null;
    let cleanup: (() => void) | null = null;
    let modelKey = 'unknown';
    /** Last usage frame seen for this request; null when the upstream never sent one. */
    let tokens: { prompt: number; completion: number; cached: number } | null = null;

    const record = (status: string): void => {
      metrics.requests.inc({ model: modelKey, status });
      const durationMs = Date.now() - started;
      metrics.duration.observe(durationMs / 1000);
      // One row per request for the dashboard. Cached tokens come from the
      // upstream usage frame, so "新增输入" is prompt minus cache hits.
      const prompt = tokens?.prompt ?? 0;
      const cached = tokens?.cached ?? 0;
      const ua = c.req.header('user-agent');
      deps.usage.record({
        ts: Date.now(),
        model: modelKey,
        application: inferApplication(ua),
        provider: 'Qoder CN',
        inputTokens: Math.max(0, prompt - cached),
        cachedTokens: cached,
        outputTokens: tokens?.completion ?? 0,
        durationMs,
        status: Number(status) || 0,
        ...(ua ? { ua: ua.slice(0, 160) } : {}),
      });
    };

    try {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return errorResponse(c, 400, 'Request body must be valid JSON');
      }

      const parsed = parseChatRequest(body);
      if (!parsed.ok) return errorResponse(c, 400, parsed.error);
      const req = parsed.value;

      const model = await deps.resolver.resolve(req.model);
      // Clients and metrics speak the readable name; only the upstream gets the key.
      modelKey = model.id;
      deps.logger.debug({ model: model.id, upstream: model.key, matched: model.matched }, 'model resolved');

      // Arm the deadline before queueing: a request that never gets a slot must
      // not be immortal. The same controller then covers the upstream call.
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error('request timeout')),
        deps.config.requestTimeoutMs,
      );

      const clientSignal = c.req.raw.signal;
      if (clientSignal.aborted) controller.abort();
      else clientSignal.addEventListener('abort', () => controller.abort(), { once: true });

      cleanup = () => {
        clearTimeout(timer);
        release?.();
        release = null;
        deps.updateGauges();
      };

      try {
        release = await deps.gate.enter(controller.signal);
      } catch (error) {
        cleanup();
        if (error instanceof ClientGoneError) {
          // Distinguish "caller hung up" from "our own deadline expired".
          const gone = clientSignal.aborted;
          const status = gone ? 499 : 504;
          record(String(status));
          return errorResponse(
            c,
            status,
            gone ? 'Client closed the connection while queued' : 'Request timed out while queued',
          );
        }
        const retryAfter = error instanceof HttpError && error.retryAfter ? error.retryAfter : 5;
        record('429');
        return errorResponse(c, 429, 'Gateway is at capacity, retry shortly', retryAfter);
      }
      deps.updateGauges();

      if (req.stream) {
        return streamSSE(c, async (stream) => {
          stream.onAbort(() => controller.abort());
          const encoder = new OpenAIStreamEncoder(model.id);
          // OpenAI sends usage only when asked, and only after finish_reason.
          let pendingUsage: OpenAIUsage | null = null;

          try {
            await stream.writeSSE({ data: JSON.stringify(encoder.roleFrame()) });

            for await (const event of deps.client.chat(req, model, controller.signal)) {
              switch (event.type) {
                case 'text-delta':
                  await stream.writeSSE({ data: JSON.stringify(encoder.text(event.text)) });
                  break;
                case 'reasoning-delta':
                  await stream.writeSSE({ data: JSON.stringify(encoder.reasoning(event.text)) });
                  break;
                case 'tool-call-start':
                  await stream.writeSSE({
                    data: JSON.stringify(encoder.toolStart(event.index, event.id, event.name)),
                  });
                  break;
                case 'tool-call-args-delta':
                  await stream.writeSSE({
                    data: JSON.stringify(encoder.toolArguments(event.index, event.delta)),
                  });
                  break;
                case 'usage':
                  pendingUsage = toOpenAIUsage(event);
                  tokens = {
                    prompt: event.promptTokens,
                    completion: event.completionTokens,
                    cached: event.cachedTokens ?? 0,
                  };
                  break;
                case 'done':
                  await stream.writeSSE({ data: JSON.stringify(encoder.finish(event.finishReason)) });
                  if (req.includeUsage && pendingUsage) {
                    await stream.writeSSE({ data: JSON.stringify(encoder.usage(pendingUsage)) });
                  }
                  break;
                case 'error':
                  throw new HttpError(event.status ?? 502, event.message);
              }
            }

            await stream.writeSSE({ data: '[DONE]' });
            record('200');
          } catch (error) {
            const message = redactSecrets(error instanceof Error ? error.message : String(error));
            const status = error instanceof HttpError ? error.status : 502;
            metrics.upstreamErrors.inc({ status: String(status) });
            record(String(status));
            deps.logger.warn({ err: message, model: modelKey, status }, 'stream failed');

            try {
              await stream.writeSSE({
                data: JSON.stringify({ error: { message, type: 'upstream_error' } }),
              });
              await stream.writeSSE({ data: '[DONE]' });
            } catch {
              // The client is already gone; nothing left to send.
            }
          } finally {
            cleanup?.();
          }
        });
      }

      const accumulator = new CompletionAccumulator();
      for await (const event of deps.client.chat(req, model, controller.signal)) {
        if (event.type === 'error') throw new HttpError(event.status ?? 502, event.message);
        if (event.type === 'usage') {
          tokens = {
            prompt: event.promptTokens,
            completion: event.completionTokens,
            cached: event.cachedTokens ?? 0,
          };
        }
        accumulator.apply(event);
      }

      record('200');
      cleanup();
      return c.json(accumulator.toCompletion(model.id));
    } catch (error) {
      cleanup?.();
      const status = error instanceof HttpError ? error.status : 502;
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      metrics.upstreamErrors.inc({ status: String(status) });
      record(String(status));
      deps.logger.warn({ err: message, model: modelKey, status }, 'request failed');
      return errorResponse(
        c,
        status,
        message,
        error instanceof HttpError ? error.retryAfter : undefined,
      );
    }
  });
}
