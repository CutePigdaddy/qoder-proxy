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

interface FailureDetails {
  code?: number;
  retryAfter?: number;
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

    if (typeof record.message === 'string') walk(record.message, depth + 1);
  };

  walk(body, 0);

  const known = codes.find(
    (candidate) =>
      AUTH_ERROR_CODES.has(candidate) ||
      QUOTA_ERROR_CODES.has(candidate) ||
      BUSY_ERROR_CODES.has(candidate),
  );
  return { code: known ?? codes[0], retryAfter };
}

/**
 * Translate an upstream failure into the closest client-facing equivalent.
 * Bodies carrying a business code win over the HTTP status, because the Qoder
 * gateway often returns 200/400 with an embedded error code.
 */
export function mapUpstreamFailure({ status, body }: UpstreamFailure): HttpError {
  const { code, retryAfter } = collectFailureDetails(body);

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
