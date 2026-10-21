import { describe, expect, it } from 'vitest';
import type { IREvent } from '../../src/ir/types.js';
import { chatBody, createHarness, sseEvents } from '../helpers/gateway.js';

/**
 * Tool-calling round trips.
 *
 * An agent client (Claude Code, Cursor, any LangChain agent) is only as good as
 * this path: arguments arrive in fragments, several calls can be in flight at
 * once, and the next turn has to echo them back in the exact wire shape the
 * upstream expects. A failure here is invisible in plain chat testing and
 * catastrophic in an agent loop.
 */

interface ToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** Collect every `tool_calls` delta, preserving stream order. */
function toolCallDeltas(raw: string): ToolCallDelta[] {
  return sseEvents(raw).flatMap((event) => {
    const choices = event.choices as Array<{ delta: { tool_calls?: ToolCallDelta[] } }> | undefined;
    return choices?.[0]?.delta.tool_calls ?? [];
  });
}

describe('streaming tool calls', () => {
  it('assembles arguments that arrive in fragments', async () => {
    const harness = createHarness({
      chat: async function* fragmented() {
        yield { type: 'tool-call-start', index: 0, id: 'call_1', name: 'get_weather' };
        yield { type: 'tool-call-args-delta', index: 0, delta: '{"city":' };
        yield { type: 'tool-call-args-delta', index: 0, delta: '"San' };
        yield { type: 'tool-call-args-delta', index: 0, delta: ' Francisco"}' };
        yield {
          type: 'tool-call-end',
          index: 0,
          id: 'call_1',
          name: 'get_weather',
          arguments: { city: 'San Francisco' },
        };
        yield { type: 'done', finishReason: 'tool_calls' };
      },
    });

    const raw = await (await harness.post(chatBody({ stream: true }))).text();
    const deltas = toolCallDeltas(raw);

    // The first frame must announce id/name/type; only the deltas may carry
    // bare argument fragments, which is what SDKs splice together.
    expect(deltas[0]).toMatchObject({
      index: 0,
      id: 'call_1',
      type: 'function',
      function: { name: 'get_weather' },
    });
    const joined = deltas.map((delta) => delta.function?.arguments ?? '').join('');
    expect(JSON.parse(joined)).toEqual({ city: 'San Francisco' });

    const finish = sseEvents(raw).at(-1) as {
      choices: Array<{ finish_reason: string }>;
    };
    expect(finish.choices[0]!.finish_reason).toBe('tool_calls');
  });

  it('keeps two parallel calls apart by index', async () => {
    const events: IREvent[] = [
      { type: 'tool-call-start', index: 0, id: 'call_a', name: 'read_file' },
      { type: 'tool-call-start', index: 1, id: 'call_b', name: 'grep' },
      { type: 'tool-call-args-delta', index: 0, delta: '{"path":' },
      { type: 'tool-call-args-delta', index: 1, delta: '{"q":' },
      { type: 'tool-call-args-delta', index: 0, delta: '"a.txt"}' },
      { type: 'tool-call-args-delta', index: 1, delta: '"needle"}' },
      { type: 'tool-call-end', index: 0, id: 'call_a', name: 'read_file', arguments: { path: 'a.txt' } },
      { type: 'tool-call-end', index: 1, id: 'call_b', name: 'grep', arguments: { q: 'needle' } },
      { type: 'done', finishReason: 'tool_calls' },
    ];
    const harness = createHarness({
      chat: async function* parallel() {
        for (const event of events) yield event;
      },
    });

    const raw = await (await harness.post(chatBody({ stream: true }))).text();
    const byIndex = new Map<number, string>();
    for (const delta of toolCallDeltas(raw)) {
      byIndex.set(delta.index, (byIndex.get(delta.index) ?? '') + (delta.function?.arguments ?? ''));
    }

    expect(JSON.parse(byIndex.get(0)!)).toEqual({ path: 'a.txt' });
    expect(JSON.parse(byIndex.get(1)!)).toEqual({ q: 'needle' });
  });

  it('summarises parallel calls in index order for non-stream clients', async () => {
    const harness = createHarness({
      chat: async function* parallel() {
        yield { type: 'tool-call-start', index: 1, id: 'call_b', name: 'second' };
        yield { type: 'tool-call-start', index: 0, id: 'call_a', name: 'first' };
        yield { type: 'tool-call-args-delta', index: 1, delta: '{"n":2}' };
        yield { type: 'tool-call-args-delta', index: 0, delta: '{"n":1}' };
        yield { type: 'tool-call-end', index: 1, id: 'call_b', name: 'second', arguments: { n: 2 } };
        yield { type: 'tool-call-end', index: 0, id: 'call_a', name: 'first', arguments: { n: 1 } };
        yield { type: 'done', finishReason: 'tool_calls' };
      },
    });

    const body = (await (await harness.post(chatBody())).json()) as {
      choices: Array<{ message: { tool_calls: Array<{ id: string; function: { arguments: string } }> } }>;
    };
    const calls = body.choices[0]!.message.tool_calls;

    expect(calls.map((call) => call.id)).toEqual(['call_a', 'call_b']);
    // Arguments must be a JSON string, never a nested object: the upstream and
    // every OpenAI SDK reject an object here.
    expect(typeof calls[0]!.function.arguments).toBe('string');
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ n: 1 });
  });
});

describe('tool results on the next turn', () => {
  it('forwards assistant tool calls and tool results to the upstream', async () => {
    const harness = createHarness();
    await harness.post(
      chatBody({
        messages: [
          { role: 'user', content: 'weather?' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"SG"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
        ],
      }),
    );

    const sent = harness.calls[0]!.req;
    expect(sent.messages[1]).toMatchObject({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'SG' } }],
    });
    expect(sent.messages[2]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_1',
      content: 'sunny',
    });
  });

  it('tolerates a tool result without tool_call_id', async () => {
    const harness = createHarness();
    const response = await harness.post(
      chatBody({
        messages: [
          { role: 'user', content: 'go' },
          { role: 'tool', content: 'result' },
        ],
      }),
    );

    // Missing ids are an upstream-shaped problem, not a reason to 400: the
    // gateway forwards an empty id and lets the upstream decide.
    expect(response.status).toBe(200);
    expect(harness.calls[0]!.req.messages[1]).toMatchObject({ role: 'tool', content: 'result' });
  });

  it('keeps tool results adjacent to the call they answer', async () => {
    const harness = createHarness();
    await harness.post(
      chatBody({
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'a', type: 'function', function: { name: 'one', arguments: '{}' } },
              { id: 'b', type: 'function', function: { name: 'two', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'a', content: 'first' },
          { role: 'tool', tool_call_id: 'b', content: 'second' },
        ],
      }),
    );

    const sent = harness.calls[0]!.req.messages;
    expect(sent.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
    expect(sent.slice(2).map((message) => message.toolCallId)).toEqual(['a', 'b']);
  });
});
