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
 * The model has no capacity for this request right now (10605 + RESOURCE_LIMIT).
 *
 * 语义订正（2026-10-22，对照 qoder2api-hub 的长期实测与官方客户端行为）：
 * 这条错误**不是**「账号档位没有份额」。`queueType`（p1 / p3）表示请求被分到
 * 哪条队列，不代表准入资格——企业版 p1 账号同样会撞到 10605。`queueCount: 0`
 * 只说明此刻队列里没有积压的排号，`serviceAvailable: true` 只说明服务在运行，
 * 两者都不意味着「你能立刻拿到槽位」。上游的真实意思是「这个模型现在没有
 * 给你容量，过几秒再来」，官方客户端为此专门有一套 `/ask/queue/status`
 * 轮询协议，默认肯等 60 分钟。
 *
 * 所以这个类型的作用是**分离语义**（区别于真拥堵的 busy），不是「判死」：
 * 调用方可以按 `detail.upstreamRetryAfter`（上游给的 retryAfterSeconds）等一轮
 * 再试。对外仍发一个较长的 `Retry-After`，避免客户端在同一个空队列上猛打。
 */
export class ResourceLimitError extends HttpError {
  constructor(
    message: string,
    readonly detail: {
      tier?: string;
      queueCount?: number;
      subCode?: string;
      /** 上游错误体里的 `retryAfterSeconds`，单位秒；缺省时按 2s 处理 */
      upstreamRetryAfter?: number;
    },
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
  | 'resource-limit' // 模型当前无容量（10605 + RESOURCE_LIMIT，可等 retryAfterSeconds 重试）
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
      // 同一业务码承载两种情形，必须分开：
      //   1. 真拥堵 —— 队列里确实排着人（`isQueued` / `queueCount > 0`），
      //      上游给的 retryAfterSeconds 是有意义的，按它退避重试；
      //   2. 模型此刻没容量 —— 队列是空的、服务在跑，但也没给槽位
      //      （`RESOURCE_LIMIT`）。这**不是**「账号没资格」：企业版 p1 同样会
      //      撞到，`queueType` 只是被分到哪条队列。早期实现把它读成终态，
      //      于是 0.17s 就判死；现在归到 ResourceLimitError，允许等一小段。
      const genuinelyCongested = isQueued === true || (queueCount ?? 0) > 0;
      if (!genuinelyCongested && (subCode === 'RESOURCE_LIMIT' || queueType !== undefined)) {
        const parts = [`code ${code}`];
        if (queueType) parts.push(`queue ${queueType}`);
        if (subCode) parts.push(subCode);
        if (queueCount !== undefined) parts.push(`pending ${queueCount}`);
        return new ResourceLimitError(
          `Upstream model queue: no capacity for this model right now (${parts.join(', ')})`,
          { tier: queueType, queueCount, subCode, upstreamRetryAfter: retryAfter },
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
