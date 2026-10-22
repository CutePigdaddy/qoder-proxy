/** Qoder application error codes mapped onto client-facing HTTP semantics. */
export const AUTH_ERROR_CODES = new Set<number>([105]);
export const QUOTA_ERROR_CODES = new Set<number>([110, 112, 113, 114, 115, 116, 117, 118, 119, 122]);
export const BUSY_ERROR_CODES = new Set<number>([10605]);

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class BusyError extends HttpError {
  constructor(retryAfter = 5) {
    super(429, 'Gateway is at capacity, retry shortly', retryAfter);
    this.name = 'BusyError';
  }
}

/**
 * Nothing is left to serve: the caller disconnected, or our own deadline fired
 * while the request was still queued. 499 is the de-facto "client closed
 * request" status; it must never be retried downstream.
 */
export class ClientGoneError extends HttpError {
  constructor(message = 'Client closed request') {
    super(499, message);
    this.name = 'ClientGoneError';
  }
}

/**
 * The account has exhausted its credits. Surfaces as 429 like rate limiting, but
 * it is *terminal*: no amount of back-off brings credits back, so the retry
 * loop must let it through untouched (see DESIGN.md §7). Kept as a distinct type
 * because status alone cannot tell the two apart.
 */
export class QuotaExhaustedError extends HttpError {
  constructor(message: string, retryAfter?: number) {
    super(429, message, retryAfter);
    this.name = 'QuotaExhaustedError';
  }
}

/**
 * The account tier has no capacity for this request right now.
 *
 * The upstream reports it with business code 10605, the same code it uses for
 * genuine congestion — but the payload says the opposite of "busy":
 * `queueCount: 0`, `isQueued: false`, `serviceAvailable: true`,
 * `subCode: "RESOURCE_LIMIT"`. Nothing is queued and nothing is broken: this
 * tier simply owns no share of the resources at this hour.
 *
 * A distinct type matters because retrying is pointless. Every attempt costs
 * the upstream's `retryAfterSeconds` (2s) and ends in the same refusal, which
 * is how one request used to burn 4–5s before surfacing an error. The
 * `Retry-After` we emit is deliberately far longer than the upstream hint, so
 * the client backs off instead of hammering a lane that has no capacity.
 */
export class ResourceLimitError extends HttpError {
  constructor(
    message: string,
    readonly detail: { tier?: string; queueCount?: number; subCode?: string },
    retryAfter = 60,
  ) {
    super(503, message, retryAfter);
    this.name = 'ResourceLimitError';
  }
}

/**
 * Upstream explicitly rejected our PAT-derived job token (HTTP 401/403 or
 * business code 105). Distinct from a client-side bad API key: callers may
 * recover by force-refreshing the credential and retrying once.
 */
export class CredentialRejectedError extends HttpError {
  constructor(
    message: string,
    readonly upstreamBody?: string,
  ) {
    super(401, message);
    this.name = 'CredentialRejectedError';
  }
}

export interface UpstreamFailure {
  status: number;
  body: string;
}

/** 失败环节：请求在网关的哪一层被拒。 */
export type ErrorStage = 'validate' | 'queue' | 'upstream';

/**
 * 失败的语义分类——比 HTTP 状态码更接近「为什么失败」。
 * 429 承载两种语义（限流 vs 配额耗尽）正是需要它的证明（见 DESIGN.md §7）。
 */
export type ErrorType =
  | 'quota' // QuotaExhaustedError：配额耗尽，终态
  | 'credential' // 凭据被上游拒绝（401/105）
  | 'busy' // 容量已满（网关排队或上游 503）
  | 'resource-limit' // 账号档位当前无资源份额（10605 + RESOURCE_LIMIT，重试无意义）
  | 'rate-limit' // 上游限流（瞬态）
  | 'timeout' // 我方 deadline 到期（排队或上游阶段）
  | 'client-gone' // 客户端断开（499）
  | 'invalid' // 请求本身无效（非 JSON / schema 不合）
  | 'input-limit' // 触发面板设置的网关输入上限
  | 'upstream'; // 其他上游错误

/**
 * 把「错误对象 + 最终 HTTP 状态」归入语义分类。
 * 类型判定优先于状态码：QuotaExhaustedError 虽然是 429，但它不是限流。
 * 504 的检查在 ClientGoneError 之前：排队超时抛的就是 ClientGoneError，
 * 区分「谁先放手」靠的是调用方传入的 status（499 = 客户端、504 = 我方）。
 */
export function classifyFailure(error: unknown, status: number): ErrorType {
  if (error instanceof QuotaExhaustedError) return 'quota';
  if (error instanceof CredentialRejectedError) return 'credential';
  if (error instanceof ResourceLimitError) return 'resource-limit';
  if (error instanceof BusyError) return 'busy';
  if (status === 504) return 'timeout';
  if (error instanceof ClientGoneError || status === 499) return 'client-gone';
  if (status === 400) return 'invalid';
  if (status === 429) return 'rate-limit';
  if (status === 503) return 'busy';
  return 'upstream';
}

interface FailureDetails {
  code?: number;
  retryAfter?: number;
  /** `RESOURCE_LIMIT` marks a tier-capacity refusal, not congestion. */
  subCode?: string;
  /** `p3` and friends: the priority lane the request was assigned to. */
  queueType?: string;
  queueCount?: number;
  isQueued?: boolean;
}

const MAX_MESSAGE_DEPTH = 5;

function toCode(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

/**
 * The gateway wraps business errors in layers of stringified JSON, e.g.
 * `{"code":"403","message":"{\"code\":\"10605\",\"message\":\"{...retryAfterSeconds...}\"}"}`
 * where the outer code just echoes the HTTP status and the real business code
 * (and back-off hint) hides two levels deep. Walk the whole chain; a known
 * business code always wins over the status echo.
 */
function collectFailureDetails(body: string): FailureDetails {
  const codes: number[] = [];
  let retryAfter: number | undefined;
  let subCode: string | undefined;
  let queueType: string | undefined;
  let queueCount: number | undefined;
  let isQueued: boolean | undefined;

  const walk = (raw: string, depth: number): void => {
    if (depth > MAX_MESSAGE_DEPTH) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const record = parsed as Record<string, unknown>;

    const code = toCode(record.code) ?? toCode(record.errorCode);
    if (code !== undefined) codes.push(code);

    const retry = record.retryAfterSeconds;
    if (retryAfter === undefined && typeof retry === 'number' && retry > 0) {
      retryAfter = retry;
    }

    // The resource-limit verdict sits two levels below the HTTP status echo.
    // First writer wins, so an outer placeholder cannot mask the real value.
    if (subCode === undefined && typeof record.subCode === 'string') subCode = record.subCode;
    if (queueType === undefined && typeof record.queueType === 'string') queueType = record.queueType;
    if (queueCount === undefined && typeof record.queueCount === 'number') {
      queueCount = record.queueCount;
    }
    if (isQueued === undefined && typeof record.isQueued === 'boolean') {
      isQueued = record.isQueued;
    }

    if (typeof record.message === 'string') walk(record.message, depth + 1);
  };

  walk(body, 0);

  const known = codes.find(
    (candidate) =>
      AUTH_ERROR_CODES.has(candidate) ||
      QUOTA_ERROR_CODES.has(candidate) ||
      BUSY_ERROR_CODES.has(candidate),
  );
  return { code: known ?? codes[0], retryAfter, subCode, queueType, queueCount, isQueued };
}

/**
 * Translate an upstream failure into the closest client-facing equivalent.
 * Bodies carrying a business code win over the HTTP status, because the Qoder
 * gateway often returns 200/400 with an embedded error code.
 */
export function mapUpstreamFailure({ status, body }: UpstreamFailure): HttpError {
  const { code, retryAfter, subCode, queueType, queueCount, isQueued } = collectFailureDetails(body);

  if (code !== undefined) {
    if (AUTH_ERROR_CODES.has(code)) {
      return new CredentialRejectedError(
        `Upstream rejected the credential (code ${code})`,
        body,
      );
    }
    if (QUOTA_ERROR_CODES.has(code)) {
      return new QuotaExhaustedError(`Upstream quota exhausted (code ${code})`, retryAfter);
    }
    if (BUSY_ERROR_CODES.has(code)) {
      // An empty queue plus an explicit resource-limit marker is not congestion:
      // a retry two seconds later is refused in exactly the same way, so the
      // only thing the wait buys is latency. Treat it as a terminal tier
      // refusal and tell the client to back off for much longer.
      const emptyQueue = queueCount === 0 && isQueued === false;
      if (subCode === 'RESOURCE_LIMIT' || (emptyQueue && queueType !== undefined)) {
        const parts = [`code ${code}`];
        if (queueType) parts.push(`tier ${queueType}`);
        if (subCode) parts.push(subCode);
        if (queueCount !== undefined) parts.push(`queue ${queueCount}`);
        return new ResourceLimitError(
          `Upstream resource limit: this account tier has no capacity right now (${parts.join(', ')})`,
          { tier: queueType, queueCount, subCode },
        );
      }
      return new HttpError(503, `Upstream is busy (code ${code})`, retryAfter ?? 30);
    }
  }

  if (status === 401 || status === 403) {
    return new CredentialRejectedError('Upstream rejected the credential', body);
  }
  if (status === 429) return new HttpError(429, 'Upstream rate limited', retryAfter);
  if (status >= 500) return new HttpError(502, `Upstream error ${status}`);
  return new HttpError(502, `Upstream request failed (${status})`);
}
