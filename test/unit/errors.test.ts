import { describe, expect, it } from 'vitest';
import {
  BusyError,
  CredentialRejectedError,
  HttpError,
  mapUpstreamFailure,
} from '../../src/util/errors.js';

describe('mapUpstreamFailure', () => {
  it('maps an auth code to 401', () => {
    const mapped = mapUpstreamFailure({ status: 400, body: JSON.stringify({ code: 105 }) });
    expect(mapped.status).toBe(401);
  });

  it('maps auth rejections to CredentialRejectedError with the upstream body', () => {
    const byCode = mapUpstreamFailure({ status: 200, body: JSON.stringify({ code: 105 }) });
    expect(byCode).toBeInstanceOf(CredentialRejectedError);
    expect(byCode).toBeInstanceOf(HttpError);
    expect((byCode as CredentialRejectedError).upstreamBody).toContain('105');

    const byStatus = mapUpstreamFailure({ status: 403, body: 'denied' });
    expect(byStatus).toBeInstanceOf(CredentialRejectedError);
    expect((byStatus as CredentialRejectedError).upstreamBody).toBe('denied');
  });

  it('does not tag non-auth failures as credential rejections', () => {
    expect(mapUpstreamFailure({ status: 500, body: '' })).not.toBeInstanceOf(
      CredentialRejectedError,
    );
    expect(mapUpstreamFailure({ status: 429, body: '' })).not.toBeInstanceOf(
      CredentialRejectedError,
    );
  });

  it('maps quota codes to 429', () => {
    for (const code of [110, 112, 119, 122]) {
      const mapped = mapUpstreamFailure({ status: 200, body: JSON.stringify({ code }) });
      expect(mapped.status).toBe(429);
    }
  });

  it('maps a busy code to 503 with a default retry', () => {
    const mapped = mapUpstreamFailure({ status: 200, body: JSON.stringify({ code: 10605 }) });
    expect(mapped.status).toBe(503);
    expect(mapped.retryAfter).toBe(30);
  });

  it('honours an explicit retryAfterSeconds', () => {
    const mapped = mapUpstreamFailure({
      status: 200,
      body: JSON.stringify({ code: 10605, retryAfterSeconds: 12 }),
    });
    expect(mapped.retryAfter).toBe(12);
  });

  it('falls back to status when no code is present', () => {
    expect(mapUpstreamFailure({ status: 401, body: '' }).status).toBe(401);
    expect(mapUpstreamFailure({ status: 429, body: '' }).status).toBe(429);
    expect(mapUpstreamFailure({ status: 500, body: '<html>' }).status).toBe(502);
    expect(mapUpstreamFailure({ status: 418, body: '' }).status).toBe(502);
  });
});

describe('BusyError', () => {
  it('is a 429 with retry semantics', () => {
    const error = new BusyError(7);
    expect(error.status).toBe(429);
    expect(error.retryAfter).toBe(7);
  });
});
