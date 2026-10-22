import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IREvent, IRRequest, IRToolDef } from '../../src/ir/types.js';
import { CompletionAccumulator } from '../../src/openai/nonStreamAdapter.js';
import { toOpenAIUsage } from '../../src/openai/streamAdapter.js';
import { decodeQoderBody } from '../../src/qoder/bodyCodec.js';
import { QoderClient, type ResolvedModel } from '../../src/qoder/client.js';
import type { CredentialStore, Credentials } from '../../src/qoder/credentialStore.js';
import type { Endpoints } from '../../src/qoder/endpoints.js';
import { CredentialRejectedError, QuotaExhaustedError, ResourceLimitError } from '../../src/util/errors.js';

const endpoints: Endpoints = {
  gateway: 'https://gateway.example',
  openapi: 'https://openapi.example',
  chat: 'https://gateway.example/api/chat',
  modelList: 'https://gateway.example/api/models',
  exchange: 'https://openapi.example/api/v1/jobToken/exchange',
  refresh: 'https://openapi.example/api/v1/jobToken/refresh',
  userInfo: 'https://openapi.example/api/v1/userinfo',
  usage: 'https://openapi.example/api/v2/quota/usage',
};

const model: ResolvedModel = {
  key: 'qmodel_test',
  id: 'Test-Model',
  isReasoning: false,
  maxOutputTokens: 4096,
  matched: 'key',
};

const request: IRRequest = {
  model: 'Test-Model',
  messages: [{ role: 'user', content: 'hello' }],
  stream: true,
};

function fakeStore() {
  const creds: Credentials = {
    jobToken: 'job-token',
    jobRefreshToken: 'job-refresh',
    userID: 'user-1',
    name: 'tester',
    email: 'tester@example.com',
    machineID: 'machine-1',
    expiresAt: Date.now() + 3_600_000,
  };
  const spy = {
    snapshot: creds as Credentials | null,
    get: vi.fn(async () => creds),
    forceRefresh: vi.fn(async () => creds),
  };
  return { spy, store: spy as unknown as CredentialStore };
}

function sseFrame(inner: string, status = 200): string {
  return `data: ${JSON.stringify({ statusCodeValue: status, body: inner })}\n`;
}

function okStream(): Response {
  const payload =
    sseFrame(JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })) + 'data: [DONE]\n';
  return new Response(payload, { status: 200 });
}

function rejected(): Response {
  return new Response(JSON.stringify({ code: 105 }), { status: 401 });
}

async function collect(generator: AsyncGenerator<IREvent>): Promise<IREvent[]> {
  const events: IREvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('QoderClient credential rejection recovery', () => {
  it('force-refreshes the credential and retries once when rejected before streaming', async () => {
    const { spy, store } = fakeStore();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rejected())
      .mockResolvedValueOnce(okStream());
    vi.stubGlobal('fetch', fetchMock);

    const client = new QoderClient({ endpoints, credentials: store });
    const events = await collect(client.chat(request, model, new AbortController().signal));

    expect(spy.forceRefresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.type)).toEqual(['text-delta', 'done']);
  });

  it('gives up after a single retry', async () => {
    const { spy, store } = fakeStore();
    const fetchMock = vi.fn().mockResolvedValue(rejected());
    vi.stubGlobal('fetch', fetchMock);

    const client = new QoderClient({ endpoints, credentials: store });
    const run = collect(client.chat(request, model, new AbortController().signal));

    await expect(run).rejects.toBeInstanceOf(CredentialRejectedError);
    expect(spy.forceRefresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honours a short upstream back-off before failing', async () => {
    const { spy, store } = fakeStore();
    // Verbatim busy shape captured 2026-10-20, trimmed to the parsed fields.
    const busyBody = JSON.stringify({
      code: '403',
      message: JSON.stringify({
        code: '10605',
        message: JSON.stringify({ isQueued: false, retryAfterSeconds: 1 }),
      }),
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(sseFrame(busyBody, 403), { status: 200 }))
      .mockImplementation(async () => okStream());
    vi.stubGlobal('fetch', fetchMock);

    const client = new QoderClient({ endpoints, credentials: store });
    const events = await collect(client.chat(request, model, new AbortController().signal));

    expect(events.map((event) => event.type)).toEqual(['text-delta', 'done']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Busy pressure is not a credential problem: no token churn.
    expect(spy.forceRefresh).not.toHaveBeenCalled();
  });

  it('does not retry a tier resource limit', async () => {
    const { spy, store } = fakeStore();
    // Same business code as congestion, but the queue is empty and the service
    // is up: waiting two seconds cannot conjure a slot, so the request must
    // fail on the first attempt instead of burning the upstream's hint twice.
    const limitBody = JSON.stringify({
      code: '403',
      message: JSON.stringify({
        code: '10605',
        message: JSON.stringify({
          isQueued: false,
          queueCount: 0,
          queueType: 'p3',
          retryAfterSeconds: 2,
          serviceAvailable: true,
        }),
        subCode: 'RESOURCE_LIMIT',
      }),
    });
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => new Response(sseFrame(limitBody, 403), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new QoderClient({ endpoints, credentials: store });
    const run = collect(client.chat(request, model, new AbortController().signal));

    await expect(run).rejects.toBeInstanceOf(ResourceLimitError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spy.forceRefresh).not.toHaveBeenCalled();
  });

  it('retries rate limiting with back-off before surfacing 429', async () => {
    const { spy, store } = fakeStore();
    const rateLimited = (): Response =>
      new Response(JSON.stringify({ retryAfterSeconds: 1 }), { status: 429 });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(rateLimited())
      .mockImplementation(async () => okStream());
    vi.stubGlobal('fetch', fetchMock);

    const client = new QoderClient({ endpoints, credentials: store });
    const events = await collect(client.chat(request, model, new AbortController().signal));

    expect(events.map((event) => event.type)).toEqual(['text-delta', 'done']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(spy.forceRefresh).not.toHaveBeenCalled();
  });

  it('gives up after two rate-limit back-offs', async () => {
    const { store } = fakeStore();
    const rateLimited = (): Response =>
      new Response(JSON.stringify({ retryAfterSeconds: 1 }), { status: 429 });
    const fetchMock = vi.fn().mockImplementation(async () => rateLimited());
    vi.stubGlobal('fetch', fetchMock);

    const client = new QoderClient({ endpoints, credentials: store });
    const run = collect(client.chat(request, model, new AbortController().signal));

    await expect(run).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never retries quota exhaustion, which also surfaces as 429', async () => {
    const { spy, store } = fakeStore();
    // Business code 110 is a spent credit pool: terminal, unlike rate limiting.
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ code: 110 }), { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new QoderClient({ endpoints, credentials: store });
    const run = collect(client.chat(request, model, new AbortController().signal));

    await expect(run).rejects.toBeInstanceOf(QuotaExhaustedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spy.forceRefresh).not.toHaveBeenCalled();
  });

  it('cuts a back-off short when the caller disconnects', async () => {
    const { store } = fakeStore();
    const fetchMock = vi
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify({ retryAfterSeconds: 5 }), { status: 429 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const client = new QoderClient({ endpoints, credentials: store });
    const started = Date.now();
    const run = collect(client.chat(request, model, controller.signal));
    setTimeout(() => controller.abort(), 30);

    await expect(run).rejects.toMatchObject({ status: 429 });
    // The 5s wait must not be served in full: the slot has to be freed at once.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never retries once content has reached the caller', async () => {
    const { spy, store } = fakeStore();
    const midStreamRejection = new Response(
      sseFrame(JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })) +
        sseFrame(JSON.stringify({ code: 105 }), 401),
      { status: 200 },
    );
    const fetchMock = vi.fn().mockResolvedValue(midStreamRejection);
    vi.stubGlobal('fetch', fetchMock);

    const client = new QoderClient({ endpoints, credentials: store });
    const events: IREvent[] = [];
    const run = (async () => {
      for await (const event of client.chat(request, model, new AbortController().signal)) {
        events.push(event);
      }
    })();

    await expect(run).rejects.toBeInstanceOf(CredentialRejectedError);
    expect(spy.forceRefresh).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toEqual(['text-delta']);
  });
});

describe('QoderClient request identity', () => {
  it('mints a fresh session and record id for every request', async () => {
    const { store } = fakeStore();
    const fetchMock = vi.fn().mockImplementation(async () => okStream());
    vi.stubGlobal('fetch', fetchMock);

    const client = new QoderClient({ endpoints, credentials: store });
    await collect(client.chat(request, model, new AbortController().signal));
    await collect(client.chat(request, model, new AbortController().signal));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map(([, init]) =>
      JSON.parse(decodeQoderBody((init as RequestInit).body!.toString()).toString('utf8')) as {
        request_id: string;
        request_set_id: string;
        chat_record_id: string;
        session_id: string;
      },
    );

    // Identical payloads must never collide on conversation identity.
    expect(bodies[0]!.session_id).not.toBe(bodies[1]!.session_id);
    expect(bodies[0]!.chat_record_id).not.toBe(bodies[1]!.chat_record_id);
    expect(bodies[0]!.request_id).not.toBe(bodies[1]!.request_id);
    // Within one request the record ids stay coherent.
    expect(bodies[0]!.request_set_id).toBe(bodies[0]!.chat_record_id);
  });
});

describe('QoderClient upstream body shape', () => {
  it('rejects truncated tool arguments instead of forwarding them as text', async () => {
    const { store } = fakeStore();
    const payload =
      sseFrame(
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"city":' } }],
              },
            },
          ],
        }),
      ) + 'data: [DONE]\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(payload, { status: 200 })));

    const client = new QoderClient({ endpoints, credentials: store });
    const events: IREvent[] = [];
    const run = (async () => {
      for await (const event of client.chat(request, model, new AbortController().signal)) {
        events.push(event);
      }
    })();

    // Half a tool call must fail the turn: a silent text answer is worse than an
    // error, because the agent would act on a garbled argument set.
    await expect(run).rejects.toMatchObject({ status: 502 });
    expect(events.some((event) => event.type === 'tool-call-end')).toBe(false);
    expect(events.some((event) => event.type === 'text-delta')).toBe(false);
  });

  it('rejects a stream that carries usage but no content', async () => {
    const { store } = fakeStore();
    // The account is charged for the prompt either way, so a blank 200 would
    // look like a successful answer that silently ate quota.
    const payload =
      sseFrame(
        JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 0 } }),
      ) + 'data: [DONE]\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(payload, { status: 200 })));

    const client = new QoderClient({ endpoints, credentials: store });
    const run = collect(client.chat(request, model, new AbortController().signal));

    await expect(run).rejects.toMatchObject({ status: 502, message: expect.stringContaining('without producing any content') });
  });

  it('serialises tool definitions byte-identically regardless of client order', async () => {
    const { store } = fakeStore();
    const fetchMock = vi.fn().mockImplementation(async () => okStream());
    vi.stubGlobal('fetch', fetchMock);

    const tools: IRToolDef[] = [
      {
        name: 'zeta',
        description: 'z',
        parameters: { type: 'object', properties: { beta: { type: 'string' }, alpha: { type: 'number' } } },
      },
      { name: 'alpha', description: 'a', parameters: { type: 'object', properties: {} } },
    ];
    const reordered: IRToolDef[] = [
      {
        name: 'alpha',
        description: 'a',
        parameters: { properties: {}, type: 'object' },
      },
      {
        name: 'zeta',
        description: 'z',
        parameters: { properties: { alpha: { type: 'number' }, beta: { type: 'string' } }, type: 'object' },
      },
    ];

    const client = new QoderClient({ endpoints, credentials: store });
    await collect(client.chat({ ...request, tools }, model, new AbortController().signal));
    await collect(client.chat({ ...request, tools: reordered }, model, new AbortController().signal));

    const bodies = fetchMock.mock.calls.map(
      ([, init]) =>
        JSON.parse(decodeQoderBody((init as RequestInit).body!.toString()).toString('utf8')) as {
          tools: Array<{ function: { name: string } }>;
        },
    );

    // Tools sit at the head of the upstream prompt: any jitter here voids the
    // entire prompt cache, so the bytes — not just the meaning — must match.
    expect(JSON.stringify(bodies[0]!.tools)).toBe(JSON.stringify(bodies[1]!.tools));
    expect(bodies[0]!.tools.map((tool) => tool.function.name)).toEqual(['alpha', 'zeta']);
  });
});

describe('usage cache accounting', () => {
  it('passes upstream cache details through to the final usage', async () => {
    const { store } = fakeStore();
    // Verbatim usage shape captured 2026-10-20 from the live gateway.
    const upstreamUsage = {
      choices: [],
      usage: {
        prompt_tokens: 1703,
        completion_tokens: 1,
        total_tokens: 1704,
        prompt_tokens_details: { cacheable_tokens: 0, cached_tokens: 1695 },
      },
    };
    const payload =
      sseFrame(JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })) +
      sseFrame(JSON.stringify(upstreamUsage)) +
      'data: [DONE]\n';
    const fetchMock = vi.fn().mockImplementation(async () => new Response(payload, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new QoderClient({ endpoints, credentials: store });
    const events = await collect(client.chat(request, model, new AbortController().signal));

    const usage = events.find((event) => event.type === 'usage');
    expect(usage).toMatchObject({ promptTokens: 1703, cachedTokens: 1695, cacheableTokens: 0 });

    // OpenAI shape keeps the details so clients can compute cache hit rate.
    const openai = toOpenAIUsage(usage as Extract<IREvent, { type: 'usage' }>);
    expect(openai.prompt_tokens_details).toEqual({ cached_tokens: 1695, cacheable_tokens: 0 });

    // The non-stream accumulator preserves them end to end.
    const accumulator = new CompletionAccumulator();
    for (const event of events) accumulator.apply(event);
    expect(accumulator.toCompletion(model.id).usage).toMatchObject({
      prompt_tokens: 1703,
      prompt_tokens_details: { cached_tokens: 1695, cacheable_tokens: 0 },
    });
  });

  it('omits the details object when the upstream reports none', () => {
    const openai = toOpenAIUsage({
      type: 'usage',
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
    });
    expect(openai).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
  });
});
