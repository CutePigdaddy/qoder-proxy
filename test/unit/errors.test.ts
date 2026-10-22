import { describe, expect, it } from 'vitest';
import {
  BusyError,
  ClientGoneError,
  classifyFailure,
  CredentialRejectedError,
  HttpError,
  mapUpstreamFailure,
  QuotaExhaustedError,
  ResourceLimitError,
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

  it('classifies an empty-queue refusal as a tier resource limit, not congestion', () => {
    // Verbatim shape captured 2026-10-22: the outer code echoes the HTTP
    // status as a string; the real business code, subCode and queue state hide
    // two levels deep. Empty queue + not queued + service available means the
    // tier owns no capacity — retrying buys latency, never a slot.
    const body = JSON.stringify({
      code: '403',
      message: JSON.stringify({
        code: '10605',
        message: JSON.stringify({
          isQueued: false,
          modelKey: 'qmodel_38max',
          queueCount: 0,
          queueType: 'p3',
          retryAfterSeconds: 2,
          serviceAvailable: true,
        }),
        subCode: 'RESOURCE_LIMIT',
      }),
    });
    const mapped = mapUpstreamFailure({ status: 403, body });
    expect(mapped).toBeInstanceOf(ResourceLimitError);
    expect(mapped.status).toBe(503);
    // 对外仍给长 Retry-After（客户端别在空队列上猛打），但上游的 2s 要留在
    // detail 里 —— 网关内部按它决定等一轮还是立刻放弃。
    expect(mapped.retryAfter).toBe(60);
    expect((mapped as ResourceLimitError).detail.upstreamRetryAfter).toBe(2);
    expect(mapped).not.toBeInstanceOf(CredentialRejectedError);
    expect(mapped.message).toContain('10605');
    // `queueType` 是「被分到哪条队列」，不是「账号档位」：企业版 p1 一样会撞到。
    expect(mapped.message).toContain('queue p3');
    expect(mapped.message).toContain('RESOURCE_LIMIT');
    expect((mapped as ResourceLimitError).detail.tier).toBe('p3');
  });

  it('keeps a genuinely congested queue retryable', () => {
    const body = JSON.stringify({
      code: '10605',
      subCode: 'QUEUE_FULL',
      queueType: 'p1',
      queueCount: 14,
      isQueued: true,
      retryAfterSeconds: 3,
    });
    const mapped = mapUpstreamFailure({ status: 200, body });
    expect(mapped).not.toBeInstanceOf(ResourceLimitError);
    expect(mapped.status).toBe(503);
    // Real congestion: the upstream hint is meaningful, so honour it.
    expect(mapped.retryAfter).toBe(3);
  });

  it('accepts numeric-string codes at the top level', () => {
    const mapped = mapUpstreamFailure({ status: 200, body: JSON.stringify({ code: '105' }) });
    expect(mapped).toBeInstanceOf(CredentialRejectedError);
    expect(mapped.status).toBe(401);
  });

  it('prefers a known business code over the outer status echo', () => {
    const body = JSON.stringify({
      code: '401',
      message: JSON.stringify({ code: '110', retryAfterSeconds: 5 }),
    });
    const mapped = mapUpstreamFailure({ status: 401, body });
    expect(mapped.status).toBe(429);
    expect(mapped.retryAfter).toBe(5);
    expect(mapped).not.toBeInstanceOf(CredentialRejectedError);
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

describe('classifyFailure', () => {
  it('reads the error type before the status, because 429 carries two meanings', () => {
    expect(classifyFailure(new QuotaExhaustedError('out of credits'), 429)).toBe('quota');
    expect(classifyFailure(new HttpError(429, 'Upstream rate limited'), 429)).toBe('rate-limit');
    expect(classifyFailure(new BusyError(3), 429)).toBe('busy');
    // 503 有两种含义：真正的容量已满，和「档位没有资源份额」。
    // 后者必须先判类型，否则会被状态码吞成 busy，重试策略也会跟着错。
    expect(classifyFailure(new ResourceLimitError('tier capped', {}), 503)).toBe('resource-limit');
  });

  it('separates "client hung up" from "our deadline fired" while queued', () => {
    // 499/504 的分叉点：同一个 ClientGoneError，按最终状态区分谁先放手
    expect(classifyFailure(new ClientGoneError(), 499)).toBe('client-gone');
    expect(classifyFailure(new ClientGoneError(), 504)).toBe('timeout');
  });

  it('maps plain statuses when no error object is available', () => {
    expect(classifyFailure(undefined, 400)).toBe('invalid');
    expect(classifyFailure(undefined, 401)).toBe('upstream');
    expect(classifyFailure(undefined, 503)).toBe('busy');
    expect(classifyFailure(undefined, 502)).toBe('upstream');
    expect(classifyFailure('boom', 500)).toBe('upstream');
  });

  it('tags credential rejections distinctly from generic 401s', () => {
    expect(classifyFailure(new CredentialRejectedError('rejected'), 401)).toBe('credential');
  });
});
