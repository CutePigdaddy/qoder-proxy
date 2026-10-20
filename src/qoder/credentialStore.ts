import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SingleFlight } from '../concurrency/singleFlight.js';
import { logger, redactSecrets } from '../obs/logger.js';
import { metrics } from '../obs/metrics.js';
import { HttpError } from '../util/errors.js';
import { getOrCreateMachineId } from './cosySigner.js';
import type { Endpoints } from './endpoints.js';

/** Refresh this long before the token actually expires. */
const REFRESH_SKEW_MS = 5 * 60_000;
const DEFAULT_TTL_MS = 24 * 60 * 60_000;

export interface Credentials {
  jobToken: string;
  jobRefreshToken: string;
  userID: string;
  name: string;
  email: string;
  machineID: string;
  expiresAt: number;
}

interface CachedFile extends Credentials {
  version: 1;
}

/** A token endpoint failure that may or may not mean "this credential is dead". */
class TokenEndpointError extends Error {
  constructor(
    readonly status: number,
    readonly fatal: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'TokenEndpointError';
  }
}

function isFatalAuthFailure(status: number, body: string): boolean {
  if (status === 401 || status === 403) return true;
  if (status !== 400) return false;
  return /\b(?:ExpiredTokenError|InvalidTokenError|InvalidRefreshTokenError|TOKEN_EXPIRED?)\b/.test(body);
}

interface TokenResponse {
  token?: string;
  refresh_token?: string;
  expires_at?: string;
  expires_in?: number;
}

function parseTokenResponse(data: TokenResponse, previousRefresh: string): {
  jobToken: string;
  jobRefreshToken: string;
  expiresAt: number;
} {
  if (!data.token) throw new TokenEndpointError(502, false, 'Token endpoint returned no job token');

  let expiresAt = Date.now() + DEFAULT_TTL_MS;
  if (data.expires_at) {
    const parsed = Date.parse(data.expires_at);
    if (!Number.isNaN(parsed)) expiresAt = parsed;
  } else if (typeof data.expires_in === 'number' && data.expires_in > 0) {
    // The CN OpenAPI reports expires_in in milliseconds.
    expiresAt = Date.now() + data.expires_in;
  }

  return {
    jobToken: data.token,
    // The refresh token rotates on every use; always persist the new one.
    jobRefreshToken: data.refresh_token || previousRefresh,
    expiresAt,
  };
}

/**
 * Single-account credential manager.
 *
 * Refresh order is deliberate: try the job refresh token, fall back to a PAT
 * exchange only when the server *explicitly* rejects the token (401/403 or a
 * known error body). A network blip must never consume a single-use refresh
 * token or spam the exchange endpoint.
 *
 * The PAT is read from the environment, held in memory, and never written to
 * disk. Only the short-lived job token pair and identity are cached.
 */
export class CredentialStore {
  private current: Credentials | null = null;
  private readonly flight = new SingleFlight<Credentials>();
  private readonly machineID: string;

  constructor(
    private readonly opts: {
      pat: string;
      cachePath: string;
      endpoints: Endpoints;
    },
  ) {
    this.machineID = getOrCreateMachineId(dirname(opts.cachePath));
    this.current = this.readCache();
  }

  get snapshot(): Credentials | null {
    return this.current;
  }

  async get(): Promise<Credentials> {
    if (this.isFresh(this.current)) return this.current as Credentials;
    return this.flight.run(() => this.reload());
  }

  /**
   * Invalidate the cached job token and reload immediately, even if the token
   * has not expired locally. Used when the upstream rejects the credential
   * mid-flight (the token may have been revoked server-side). Concurrent
   * callers share the same reload through the single-flight.
   */
  async forceRefresh(): Promise<Credentials> {
    if (this.current) this.current = { ...this.current, expiresAt: 0 };
    return this.flight.run(() => this.reload());
  }

  private isFresh(value: Credentials | null): boolean {
    return value !== null && value.expiresAt - Date.now() > REFRESH_SKEW_MS;
  }

  private async reload(): Promise<Credentials> {
    // A racing caller may have refreshed while we queued behind the flight.
    if (this.isFresh(this.current)) return this.current as Credentials;

    const previous = this.current;
    if (previous?.jobRefreshToken) {
      try {
        const refreshed = await this.refreshWithJobToken(previous);
        const next: Credentials = { ...previous, ...refreshed, machineID: this.machineID };
        this.commit(next);
        metrics.tokenRefresh.inc({ result: 'jrt' });
        logger.info({ userId: next.userID, expiresAt: next.expiresAt }, 'job token refreshed');
        return next;
      } catch (error) {
        const fatal = error instanceof TokenEndpointError && error.fatal;
        metrics.tokenRefresh.inc({ result: fatal ? 'jrt_rejected' : 'jrt_error' });
        if (!fatal) {
          throw new HttpError(502, redactSecrets(`Could not refresh job token: ${String(error)}`));
        }
        logger.warn({ userId: previous.userID }, 'job refresh rejected, falling back to PAT exchange');
      }
    }

    const exchanged = await this.exchangePat();
    const identity = await this.fetchUserInfo(exchanged.jobToken);
    if (!identity.userID) {
      throw new HttpError(502, 'Qoder did not return a user id for this PAT');
    }

    const next: Credentials = {
      ...exchanged,
      userID: identity.userID,
      name: identity.name,
      email: identity.email,
      machineID: this.machineID,
    };
    this.commit(next);
    metrics.tokenRefresh.inc({ result: 'pat' });
    logger.info({ userId: next.userID, expiresAt: next.expiresAt }, 'PAT exchanged for job token');
    return next;
  }

  private async exchangePat(): Promise<{ jobToken: string; jobRefreshToken: string; expiresAt: number }> {
    let response: Response;
    try {
      response = await fetch(this.opts.endpoints.exchange, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'qoder-proxy/0.1',
          'Cosy-Version': '1.0.1',
          'Cosy-ClientType': '5',
        },
        body: JSON.stringify({ personal_token: this.opts.pat }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new HttpError(502, redactSecrets(`PAT exchange failed: ${String(error)}`));
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new HttpError(
        401,
        redactSecrets(`PAT exchange rejected (${response.status}): ${body.slice(0, 200)}`),
      );
    }

    const data = (await response.json()) as TokenResponse;
    return parseTokenResponse(data, '');
  }

  private async refreshWithJobToken(
    previous: Credentials,
  ): Promise<{ jobToken: string; jobRefreshToken: string; expiresAt: number }> {
    let response: Response;
    try {
      response = await fetch(this.opts.endpoints.refresh, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'qoder-proxy/0.1',
          'Cosy-Version': '1.0.1',
          'Cosy-ClientType': '5',
        },
        body: JSON.stringify({ refresh_token: previous.jobRefreshToken }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new TokenEndpointError(0, false, redactSecrets(`job token refresh failed: ${String(error)}`));
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new TokenEndpointError(
        response.status,
        isFatalAuthFailure(response.status, body),
        redactSecrets(`job token refresh rejected (${response.status}): ${body.slice(0, 200)}`),
      );
    }

    const data = (await response.json()) as TokenResponse;
    return parseTokenResponse(data, previous.jobRefreshToken);
  }

  private async fetchUserInfo(jobToken: string): Promise<{ userID: string; name: string; email: string }> {
    try {
      const response = await fetch(this.opts.endpoints.userInfo, {
        headers: {
          Authorization: `Bearer ${jobToken}`,
          Accept: 'application/json',
          'User-Agent': 'qoder-proxy/0.1',
          'Cosy-Version': '1.0.1',
          'Cosy-ClientType': '5',
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return { userID: '', name: '', email: '' };
      const info = (await response.json()) as {
        id?: string;
        uid?: string;
        email?: string;
        name?: string;
        username?: string;
      };
      return {
        userID: info.id ?? info.uid ?? '',
        name: info.name ?? info.username ?? '',
        email: info.email ?? '',
      };
    } catch {
      return { userID: '', name: '', email: '' };
    }
  }

  private readCache(): Credentials | null {
    if (!existsSync(this.opts.cachePath)) return null;
    try {
      const raw = JSON.parse(readFileSync(this.opts.cachePath, 'utf8')) as Partial<CachedFile>;
      if (!raw.jobToken || !raw.userID) return null;
      return {
        jobToken: raw.jobToken,
        jobRefreshToken: raw.jobRefreshToken ?? '',
        userID: raw.userID,
        name: raw.name ?? '',
        email: raw.email ?? '',
        machineID: raw.machineID ?? this.machineID,
        expiresAt: typeof raw.expiresAt === 'number' ? raw.expiresAt : 0,
      };
    } catch {
      return null;
    }
  }

  private commit(value: Credentials): void {
    this.current = value;
    try {
      mkdirSync(dirname(this.opts.cachePath), { recursive: true });
      const payload: CachedFile = { version: 1, ...value };
      writeFileSync(this.opts.cachePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    } catch (error) {
      logger.warn({ err: redactSecrets(String(error)) }, 'could not persist credential cache');
    }
  }
}
