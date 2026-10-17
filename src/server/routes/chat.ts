import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Release } from '../../concurrency/admission.js';
import { redactSecrets } from '../../obs/logger.js';
import { metrics } from '../../obs/metrics.js';
import { CompletionAccumulator } from '../../openai/nonStreamAdapter.js';
import { parseChatRequest } from '../../openai/requestAdapter.js';
import { OpenAIStreamEncoder } from '../../openai/streamAdapter.js';
import { HttpError } from '../../util/errors.js';
import type { Deps } from '../deps.js';

function errorResponse(c: Context, status: number, message: string): Response {
  const type =
    status === 401
      ? 'authentication_error'
      : status === 429
        ? 'rate_limit_error'
        : status >= 500
          ? 'upstream_error'
          : 'invalid_request_error';
  return c.json({ error: { message, type } }, status as ContentfulStatusCode);
}

export function registerChat(app: Hono, deps: Deps): void {
  app.post('/v1/chat/completions', async (c) => {
    const started = Date.now();
    let release: Release | null = null;
    let cleanup: (() => void) | null = null;
    let modelKey = 'unknown';

    const record = (status: string): void => {
      metrics.requests.inc({ model: modelKey, status });
      metrics.duration.observe((Date.now() - started) / 1000);
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
      modelKey = model.key;

      try {
        release = await deps.gate.enter();
      } catch (error) {
        const retryAfter = error instanceof HttpError && error.retryAfter ? error.retryAfter : 5;
        c.header('Retry-After', String(retryAfter));
        record('429');
        return errorResponse(c, 429, 'Gateway is at capacity, retry shortly');
      }
      deps.updateGauges();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('request timeout')), deps.config.requestTimeoutMs);

      const clientSignal = c.req.raw.signal;
      if (clientSignal.aborted) controller.abort();
      else clientSignal.addEventListener('abort', () => controller.abort(), { once: true });

      cleanup = () => {
        clearTimeout(timer);
        release?.();
        release = null;
        deps.updateGauges();
      };

      if (req.stream) {
        return streamSSE(c, async (stream) => {
          stream.onAbort(() => controller.abort());
          const encoder = new OpenAIStreamEncoder(model.key);

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
                  await stream.writeSSE({
                    data: JSON.stringify(
                      encoder.usage({
                        prompt_tokens: event.promptTokens,
                        completion_tokens: event.completionTokens,
                        total_tokens: event.totalTokens,
                      }),
                    ),
                  });
                  break;
                case 'done':
                  await stream.writeSSE({ data: JSON.stringify(encoder.finish(event.finishReason)) });
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
        accumulator.apply(event);
      }

      record('200');
      cleanup();
      return c.json(accumulator.toCompletion(model.key));
    } catch (error) {
      cleanup?.();
      const status = error instanceof HttpError ? error.status : 502;
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      metrics.upstreamErrors.inc({ status: String(status) });
      record(String(status));
      deps.logger.warn({ err: message, model: modelKey, status }, 'request failed');
      return errorResponse(c, status, message);
    }
  });
}
