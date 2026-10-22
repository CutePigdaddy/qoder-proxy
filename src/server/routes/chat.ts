import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Release } from '../../concurrency/admission.js';
import { outcomeOfFailure } from '../../obs/availability.js';
import { redactSecrets } from '../../obs/logger.js';
import { metrics } from '../../obs/metrics.js';
import { inferApplication } from '../../obs/usageStore.js';
import { CompletionAccumulator } from '../../openai/nonStreamAdapter.js';
import { estimatePromptTokens } from '../../openai/inputBudget.js';
import { parseChatRequest } from '../../openai/requestAdapter.js';
import { OpenAIStreamEncoder, toOpenAIUsage, type OpenAIUsage } from '../../openai/streamAdapter.js';
import { ClientGoneError, classifyFailure, HttpError, type ErrorStage, type ErrorType } from '../../util/errors.js';
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
    // Hoisted so every failure path can classify "who hung up first":
    // the caller's signal is knowable from the start, our own deadline is not.
    const clientSignal = c.req.raw.signal;
    const ua = c.req.header('user-agent');
    const application = inferApplication(ua);
    let deadlineFired = false;
    let release: Release | null = null;
    let cleanup: (() => void) | null = null;
    let modelKey = 'unknown';
    /**
     * 最近一帧 usage；上游一帧都没给时为 null。
     *
     * `credits` 三件套是**计费口径**（不是 token）：`FREE_INPUT` 通道理论上
     * 不写 credits，但「没这个字段」和「明确写了 0」在数据上是两回事，只有把
     * 它们原样落盘，才不用再靠 `/v2/quota/usage` 的差值去猜扣没扣费。
     */
    let tokens: {
      prompt: number;
      completion: number;
      cached: number;
      credits?: number;
      originalCredits?: number;
      billable?: boolean;
    } | null = null;

    /**
     * 一条请求的完整记录：用量行 + 一次可用性样本。
     *
     * 可用性从这里取数，是「被动观测」模式的唯一入口——不发任何额外请求，
     * 所以永远不会消耗上游配额。`error` 只用于区分失败原因（档位/配额/超时），
     * 不传也能按 status 归类。
     */
    const record = (status: string, error?: unknown): void => {
      metrics.requests.inc({ model: modelKey, status });
      const durationMs = Date.now() - started;
      metrics.duration.observe(durationMs / 1000);
      // One row per request for the dashboard. Cached tokens come from the
      // upstream usage frame, so "新增输入" is prompt minus cache hits.
      const prompt = tokens?.prompt ?? 0;
      const cached = tokens?.cached ?? 0;
      deps.usage.record({
        ts: Date.now(),
        model: modelKey,
        application,
        provider: 'Qoder CN',
        channel: 'free',
        inputTokens: Math.max(0, prompt - cached),
        cachedTokens: cached,
        outputTokens: tokens?.completion ?? 0,
        durationMs,
        status: Number(status) || 0,
        // 只有上游真的给了才写这三个键：失败请求/无 usage 帧的行保持旧格式，
        // 老记录也不会被反填成 0。
        ...(tokens?.credits !== undefined ? { credits: tokens.credits } : {}),
        ...(tokens?.originalCredits !== undefined ? { originalCredits: tokens.originalCredits } : {}),
        ...(tokens?.billable !== undefined ? { billable: tokens.billable } : {}),
        ...(ua ? { ua: ua.slice(0, 160) } : {}),
      });
      // `modelKey` 保持 'unknown' 说明请求在解析出模型之前就失败了，
      // 这种样本归不到任何模型，记录它只会污染每行的分母。
      if (modelKey !== 'unknown') {
        const outcome = outcomeOfFailure(error, Number(status) || 0);
        if (outcome) deps.probe?.observe(modelKey, outcome, durationMs);
      }
    };

    /**
     * One row per FAILED request for the error log. Message is already
     * redacted by the caller (the same string the client sees); truncation
     * keeps a single pathological upstream from bloating the JSONL.
     */
    /**
     * 中止类错误：客户端挂断，或我方 deadline 到期。它们是「谁先放手」，
     * 不是「上游为什么失败」——两者的分类不能混。
     */
    const isAbortLike = (error: unknown): boolean =>
      error instanceof ClientGoneError || (error instanceof Error && error.name === 'AbortError');

    const recordError = (
      status: number,
      stage: ErrorStage,
      message: string,
      opts: { type?: ErrorType; error?: unknown } = {},
    ): void => {
      // 根因优先。上游 503 之后客户端等不及断开时，`clientSignal.aborted` 已经
      // 为真——若据此归类，16 条同一原因的 503 会一半显示「容量已满」、一半显示
      // 「客户端断开」，既自相矛盾，又把排障方向指到客户端。只有中止本身是唯一
      // 原因时才归 client-gone / timeout。
      const aborted = clientSignal.aborted;
      const type =
        opts.type ??
        (isAbortLike(opts.error)
          ? deadlineFired
            ? 'timeout'
            : 'client-gone'
          : classifyFailure(opts.error, status));
      // 客户端确实断了，只是根因在别处：记进消息，别把这个事实丢掉。
      const note = aborted && type !== 'client-gone' ? '（客户端已断开）' : '';
      deps.errors.record({
        ts: Date.now(),
        model: modelKey,
        application,
        status,
        stage,
        type,
        message: `${message.slice(0, 300 - note.length)}${note}`,
        durationMs: Date.now() - started,
      });
    };

    try {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        recordError(400, 'validate', 'Request body must be valid JSON');
        return errorResponse(c, 400, 'Request body must be valid JSON');
      }

      const parsed = parseChatRequest(body);
      if (!parsed.ok) {
        // 校验失败不进用量统计（那会改变 errorRate 口径），但要在错误日志里可查。
        recordError(400, 'validate', parsed.error);
        return errorResponse(c, 400, parsed.error);
      }
      const req = parsed.value;

      const model = await deps.resolver.resolve(req.model);
      // Clients and metrics speak the readable name; only the upstream gets the key.
      modelKey = model.id;
      deps.logger.debug({ model: model.id, upstream: model.key, matched: model.matched }, 'model resolved');

      // 上游对输入长度不做拦截（实测标称 180K 的模型发 230K 也能过），所以闸门只能
      // 设在我们这一层。默认空表：没在面板里设过上限的模型完全不受影响。
      const inputLimit = deps.limits.get(model.id);
      if (inputLimit !== null) {
        const estimated = estimatePromptTokens(req);
        if (estimated > inputLimit) {
          const message =
            `Estimated input ${Math.round(estimated / 1000)}K tokens exceeds the gateway limit of ` +
            `${Math.round(inputLimit / 1000)}K set for ${model.id}. Adjust or clear it in the dashboard. ` +
            'The number is an estimate (upstream does not enforce a limit itself).';
          recordError(400, 'validate', message, { type: 'input-limit' });
          return errorResponse(c, 400, message);
        }
      }

      // Arm the deadline before queueing: a request that never gets a slot must
      // not be immortal. The same controller then covers the upstream call.
      const controller = new AbortController();
      const timer = setTimeout(() => {
        deadlineFired = true;
        controller.abort(new Error('request timeout'));
      }, deps.config.requestTimeoutMs);

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
          const message = gone
            ? 'Client closed the connection while queued'
            : 'Request timed out while queued';
          record(String(status), error);
          recordError(status, 'queue', message, { error });
          return errorResponse(c, status, message);
        }
        const retryAfter = error instanceof HttpError && error.retryAfter ? error.retryAfter : 5;
        record('429', error);
        recordError(429, 'queue', 'Gateway is at capacity, retry shortly', { error });
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
                    ...(event.credits !== undefined ? { credits: event.credits } : {}),
                    ...(event.originalCredits !== undefined ? { originalCredits: event.originalCredits } : {}),
                    ...(event.billable !== undefined ? { billable: event.billable } : {}),
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
            record(String(status), error);
            recordError(status, 'upstream', message, { error });
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
            ...(event.credits !== undefined ? { credits: event.credits } : {}),
            ...(event.originalCredits !== undefined ? { originalCredits: event.originalCredits } : {}),
            ...(event.billable !== undefined ? { billable: event.billable } : {}),
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
      record(String(status), error);
      recordError(status, 'upstream', message, { error });
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
