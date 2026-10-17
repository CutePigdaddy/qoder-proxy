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

export interface UpstreamFailure {
  status: number;
  body: string;
}

/**
 * Translate an upstream failure into the closest client-facing equivalent.
 * Bodies carrying a business code win over the HTTP status, because the Qoder
 * gateway often returns 200/400 with an embedded error code.
 */
export function mapUpstreamFailure({ status, body }: UpstreamFailure): HttpError {
  let code: number | undefined;
  let retryAfter: number | undefined;

  try {
    const json = JSON.parse(body) as {
      code?: unknown;
      errorCode?: unknown;
      retryAfterSeconds?: unknown;
    };
    if (typeof json.code === 'number') code = json.code;
    else if (typeof json.errorCode === 'number') code = json.errorCode;
    if (typeof json.retryAfterSeconds === 'number' && json.retryAfterSeconds > 0) {
      retryAfter = json.retryAfterSeconds;
    }
  } catch {
    // Non-JSON bodies fall through to status-based mapping.
  }

  if (code !== undefined) {
    if (AUTH_ERROR_CODES.has(code)) {
      return new HttpError(401, `Upstream rejected the credential (code ${code})`);
    }
    if (QUOTA_ERROR_CODES.has(code)) {
      return new HttpError(429, `Upstream quota exhausted (code ${code})`, retryAfter);
    }
    if (BUSY_ERROR_CODES.has(code)) {
      return new HttpError(503, `Upstream is busy (code ${code})`, retryAfter ?? 30);
    }
  }

  if (status === 401 || status === 403) return new HttpError(401, 'Upstream rejected the credential');
  if (status === 429) return new HttpError(429, 'Upstream rate limited', retryAfter);
  if (status >= 500) return new HttpError(502, `Upstream error ${status}`);
  return new HttpError(502, `Upstream request failed (${status})`);
}
