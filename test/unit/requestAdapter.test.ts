import { describe, expect, it } from 'vitest';
import { parseChatRequest } from '../../src/openai/requestAdapter.js';

describe('parseChatRequest', () => {
  it('accepts a minimal request', () => {
    const result = parseChatRequest({
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.model).toBe('auto');
    expect(result.value.stream).toBe(false);
    expect(result.value.messages).toHaveLength(1);
    expect(result.value.messages[0]?.content).toBe('hi');
  });

  it('hoists system messages out of the message list', () => {
    const result = parseChatRequest({
      model: 'auto',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'developer', content: 'no emoji' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.system).toBe('be terse\n\nno emoji');
    expect(result.value.messages).toHaveLength(1);
  });

  it('parses assistant tool calls and tool results', () => {
    const result = parseChatRequest({
      model: 'auto',
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Hangzhou"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"temp":22}' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const assistant = result.value.messages[1];
    expect(assistant?.toolCalls?.[0]?.name).toBe('get_weather');
    expect(assistant?.toolCalls?.[0]?.arguments).toEqual({ city: 'Hangzhou' });
    expect(result.value.messages[2]?.toolCallId).toBe('call_1');
  });

  it('extracts image parts from data urls', () => {
    const result = parseChatRequest({
      model: 'auto',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const message = result.value.messages[0];
    expect(message?.content).toBe('what is this');
    expect(message?.parts).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
    ]);
  });

  it('passes tools and token limits through', () => {
    const result = parseChatRequest({
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 128,
      reasoning_effort: 'high',
      tools: [
        {
          type: 'function',
          function: { name: 'lookup', description: 'find', parameters: { type: 'object', properties: {} } },
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.maxTokens).toBe(128);
    expect(result.value.reasoningEffort).toBe('high');
    expect(result.value.tools?.[0]?.name).toBe('lookup');
  });

  it('reads stream_options.include_usage', () => {
    const without = parseChatRequest({
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    expect(without.ok && without.value.includeUsage).toBe(false);

    const withUsage = parseChatRequest({
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(withUsage.ok && withUsage.value.includeUsage).toBe(true);
  });

  it('rejects malformed payloads', () => {
    expect(parseChatRequest(null).ok).toBe(false);
    expect(parseChatRequest({ messages: [] }).ok).toBe(false);
    expect(parseChatRequest({ model: 'auto' }).ok).toBe(false);
    expect(parseChatRequest({ model: 'auto', messages: [] }).ok).toBe(false);
    expect(
      parseChatRequest({ model: 'auto', messages: [{ role: 'wizard', content: 'hi' }] }).ok,
    ).toBe(false);
  });
});

describe('parseChatRequest client quirks', () => {
  it('treats developer messages like system messages', () => {
    // OpenAI's newer role name; SDKs send it for o-series style prompts.
    const result = parseChatRequest({
      model: 'auto',
      messages: [
        { role: 'developer', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.system).toBe('be terse');
    expect(result.value.messages).toHaveLength(1);
  });

  it('prefers max_completion_tokens over the deprecated max_tokens', () => {
    const result = parseChatRequest({
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      max_completion_tokens: 2048,
    });

    expect(result.ok && result.value.maxTokens).toBe(2048);
  });

  it('accepts assistant messages with null content and tool calls', () => {
    const result = parseChatRequest({
      model: 'auto',
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.messages[1]).toMatchObject({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'f', arguments: {} }],
    });
  });

  it('reads input_text parts used by newer clients', () => {
    const result = parseChatRequest({
      model: 'auto',
      messages: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.messages[0]?.content).toBe('hello');
  });

  it('keeps the text when an image is not a base64 data url', () => {
    // Remote URLs cannot be forwarded, so the image is dropped — but the turn
    // must still reach the model instead of failing the whole request.
    const result = parseChatRequest({
      model: 'auto',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          ],
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.messages[0]?.content).toBe('what is this?');
    expect(result.value.messages[0]?.parts).toBeUndefined();
  });

  it('ignores parameters it does not implement instead of rejecting', () => {
    const result = parseChatRequest({
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
      top_p: 0.9,
      n: 1,
      stop: ['\n'],
      presence_penalty: 0.1,
      user: 'abc',
    });

    // Every SDK sends a different subset of these; 400-ing would break clients
    // for features that are simply not forwarded.
    expect(result.ok).toBe(true);
  });

  it('keeps an empty system prompt out of the wire list', () => {
    const result = parseChatRequest({
      model: 'auto',
      messages: [
        { role: 'system', content: '' },
        { role: 'user', content: 'hi' },
      ],
    });

    expect(result.ok && result.value.system).toBeUndefined();
  });
});
