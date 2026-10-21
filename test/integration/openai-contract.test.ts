import { describe, expect, it } from 'vitest';
import type { IREvent } from '../../src/ir/types.js';
import { HttpError } from '../../src/util/errors.js';
import { chatBody, createHarness, sseEndsWithDone, sseEvents, sseFrames } from '../helpers/gateway.js';

/**
 * Wire-contract tests.
 *
 * These assert what an OpenAI-compatible client sees, because that is where
 * third-party integrations break: a missing `object` field, a usage frame after
 * the terminal frame, or an error that is not shaped like an error all surface
 * as opaque client-side failures rather than useful messages.
 */

const toolCallEvents = (): IREvent[] => [
  { type: 'tool-call-start', index: 0, id: 'call_1', name: 'get_weather' },
  { type: 'tool-call-args-delta', index: 0, delta: '{"city":' },
  { type: 'tool-call-args-delta', index: 0, delta: '"SG"}' },
  {
    type: 'tool-call-end',
    index: 0,
    id: 'call_1',
    name: 'get_weather',
    arguments: { city: 'SG' },
  },
  { type: 'done', finishReason: 'tool_calls' },
];

describe('chat.completion (non-stream)', () => {
  it('returns the full completion envelope', async () => {
    const harness = createHarness();
    const response = await harness.post(chatBody());
    const body = (await response.json()) as Record<string, unknown> & {
      choices: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(body.object).toBe('chat.completion');
    expect(body.id).toMatch(/^chatcmpl-[0-9a-f]{32}$/);
    expect(typeof body.created).toBe('number');
    expect(body.model).toBe('Test-Model');

    const choice = body.choices[0]!;
    expect(choice.index).toBe(0);
    expect(choice.finish_reason).toBe('stop');
    expect(choice.message).toMatchObject({ role: 'assistant', content: 'hi' });
    expect(body.usage).toMatchObject({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 });
  });

  it('reports tool calls with stringified arguments and null content', async () => {
    const harness = createHarness({
      chat: async function* tools() {
        for (const event of toolCallEvents()) yield event;
      },
    });
    const body = (await (await harness.post(chatBody())).json()) as {
      choices: Array<{ finish_reason: string; message: Record<string, unknown> }>;
    };

    const choice = body.choices[0]!;
    expect(choice.finish_reason).toBe('tool_calls');
    // OpenAI sends null content when the turn is purely tool calls; clients use
    // that to decide whether to render a bubble at all.
    expect(choice.message.content).toBeNull();
    expect(choice.message.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SG"}' } },
    ]);
  });

  it('passes reasoning text through for clients that read it', async () => {
    const harness = createHarness({
      chat: async function* reasoning() {
        yield { type: 'reasoning-delta', text: 'thinking' };
        yield { type: 'text-delta', text: 'answer' };
        yield { type: 'done', finishReason: 'stop' };
      },
    });
    const body = (await (await harness.post(chatBody())).json()) as {
      choices: Array<{ message: Record<string, unknown> }>;
    };

    expect(body.choices[0]!.message).toMatchObject({
      content: 'answer',
      reasoning_content: 'thinking',
    });
  });

  it('stays JSON even when the client sends stream_options', async () => {
    const harness = createHarness();
    const response = await harness.post(
      chatBody({ stream: false, stream_options: { include_usage: true } }),
    );

    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.object).toBe('chat.completion');
  });
});

describe('chat.completion.chunk (stream)', () => {
  it('emits role, content, finish and [DONE] in that order', async () => {
    const harness = createHarness();
    const response = await harness.post(chatBody({ stream: true }));
    const raw = await response.text();
    const events = sseEvents(raw);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(sseEndsWithDone(raw)).toBe(true);

    expect(events[0]!.choices).toEqual([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]);
    expect(events[1]!.choices).toEqual([{ index: 0, delta: { content: 'hi' }, finish_reason: null }]);
    expect(events[2]!.choices).toEqual([{ index: 0, delta: {}, finish_reason: 'stop' }]);

    // Every frame must carry the same envelope id and object name: SDKs key
    // their stream accumulator off it.
    const ids = new Set(events.map((event) => event.id));
    expect(ids.size).toBe(1);
    for (const event of events) {
      expect(event.object).toBe('chat.completion.chunk');
      expect(event.model).toBe('Test-Model');
    }
  });

  it('omits the usage frame unless the client asked for it', async () => {
    const harness = createHarness();
    const events = sseEvents(await (await harness.post(chatBody({ stream: true }))).text());

    expect(events.some((event) => 'usage' in event)).toBe(false);
  });

  it('places the usage frame after finish_reason, before [DONE]', async () => {
    const harness = createHarness();
    const events = sseEvents(
      await (
        await harness.post(chatBody({ stream: true, stream_options: { include_usage: true } }))
      ).text(),
    );

    const finishIndex = events.findIndex(
      (event) =>
        (event.choices as Array<{ finish_reason: string | null }>)[0]?.finish_reason === 'stop',
    );
    const usageIndex = events.findIndex((event) => 'usage' in event);

    expect(finishIndex).toBeGreaterThan(-1);
    expect(usageIndex).toBeGreaterThan(finishIndex);
    expect(events[usageIndex]!.choices).toEqual([]);
    expect(events[usageIndex]!.usage).toMatchObject({ prompt_tokens: 3, total_tokens: 4 });
  });

  it('keeps dashed and unicode content intact', async () => {
    const harness = createHarness({
      chat: async function* unicode() {
        yield { type: 'text-delta', text: '你好，世界 🌏' };
        yield { type: 'text-delta', text: '\n```js\nconst a = 1;\n```\n' };
        yield { type: 'done', finishReason: 'stop' };
      },
    });
    const raw = await (await harness.post(chatBody({ stream: true }))).text();
    const text = sseEvents(raw)
      .map((event) => (event.choices as Array<{ delta: { content?: string } }>)[0]?.delta.content ?? '')
      .join('');

    expect(text).toBe('你好，世界 🌏\n```js\nconst a = 1;\n```\n');
  });

  it('terminates the stream on an upstream failure instead of hanging', async () => {
    const harness = createHarness({
      chat: async function* boom() {
        yield { type: 'text-delta', text: 'partial' };
        throw new Error('socket closed');
      },
    });
    const raw = await (await harness.post(chatBody({ stream: true }))).text();
    const frames = sseFrames(raw);

    // No finish frame is allowed: it would tell the client the answer was
    // complete and silently truncate it. An error frame plus [DONE] ends it.
    expect(raw).toContain('"type":"upstream_error"');
    expect(raw).not.toContain('"finish_reason":"stop"');
    expect(frames[frames.length - 1]).toBe('[DONE]');
  });
});

describe('error envelope', () => {
  it.each([
    ['400 malformed body', () => createHarness().post('{not json')],
    ['401 wrong key', () => createHarness().post(chatBody(), { auth: 'Bearer nope' })],
    ['404 unknown route', () => createHarness().app.request('http://gateway.test/nope')],
  ])('%s is shaped like an OpenAI error', async (_label, run) => {
    const response = await run();
    const body = (await response.json()) as { error?: { message?: unknown; type?: unknown } };

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(typeof body.error?.message).toBe('string');
    expect(typeof body.error?.type).toBe('string');
  });

  it('maps an upstream failure to a 502 with the upstream message', async () => {
    const harness = createHarness({
      chat: async function* failing() {
        throw new Error('upstream exploded');
      },
    });
    const response = await harness.post(chatBody());
    const body = (await response.json()) as { error: { message: string; type: string } };

    expect(response.status).toBe(502);
    expect(body.error.type).toBe('upstream_error');
    expect(body.error.message).toContain('upstream exploded');
  });

  it('keeps Retry-After on a rate-limited non-stream request', async () => {
    const harness = createHarness({
      chat: async function* limited() {
        throw new HttpError(429, 'Upstream rate limited', 7);
      },
    });
    const response = await harness.post(chatBody());

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('7');
  });
});
