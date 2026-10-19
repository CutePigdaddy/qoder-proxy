import { describe, expect, it } from 'vitest';
import { buildMessages } from '../../src/qoder/messageBuilder.js';

describe('buildMessages', () => {
  it('puts the system prompt first so upstream does not discard it', () => {
    const built = buildMessages({
      model: 'auto',
      system: 'be terse',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      includeUsage: false,
    });

    expect(built.messages).toHaveLength(2);
    expect(built.messages[0]).toEqual({ role: 'system', content: 'be terse' });
    expect(built.messages[1]).toEqual({ role: 'user', content: 'hi' });
    expect(built.system).toBe('be terse');
  });

  it('omits the system message entirely when there is no prompt', () => {
    const built = buildMessages({
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      includeUsage: false,
    });

    expect(built.messages).toHaveLength(1);
    expect(built.messages[0]).toEqual({ role: 'user', content: 'hi' });
    expect(built.system).toBe('');
  });

  it('joins multiple system fragments with a blank line', () => {
    const built = buildMessages({
      model: 'auto',
      system: 'first',
      messages: [
        { role: 'system', content: 'second' },
        { role: 'user', content: 'hi' },
      ],
      stream: false,
      includeUsage: false,
    });

    expect(built.messages[0]).toEqual({ role: 'system', content: 'first\n\nsecond' });
  });

  it('maps assistant tool calls and tool results into the wire shape', () => {
    const built = buildMessages({
      model: 'auto',
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'SG' } }],
        },
        { role: 'tool', content: 'sunny', toolCallId: 'call_1' },
      ],
      stream: false,
      includeUsage: false,
    });

    expect(built.messages).toHaveLength(3);
    expect(built.messages[1]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SG"}' } },
      ],
    });
    expect(built.messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'sunny' });
  });

  it('keeps the last user turn for upstream metadata', () => {
    const built = buildMessages({
      model: 'auto',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'second' },
      ],
      stream: false,
      includeUsage: false,
    });

    expect(built.lastUserText).toBe('second');
  });

  it('expands image parts into image_url content', () => {
    const built = buildMessages({
      model: 'auto',
      messages: [
        {
          role: 'user',
          content: '',
          parts: [
            { type: 'text', text: 'what is this' },
            { type: 'image', mimeType: 'image/png', data: 'AAAA' },
          ],
        },
      ],
      stream: false,
      includeUsage: false,
    });

    expect(built.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    });
  });
});
