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

describe('buildMessages totalTokensReminder markers', () => {
  const systemWithMarkers =
    'stable head\n\n<total_tokens>15000000 tokens left</total_tokens>\n\n' +
    '<total_tokens>14990448 tokens left</total_tokens>';

  it('move: strips markers from system and appends the latest to the last tool message', () => {
    const built = buildMessages(
      {
        model: 'auto',
        system: systemWithMarkers,
        messages: [
          { role: 'user', content: 'run it' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'Bash', arguments: {} }] },
          { role: 'tool', content: 'done', toolCallId: 'c1' },
        ],
        stream: false,
        includeUsage: false,
      },
      { tokenMarkerMode: 'move' },
    );

    expect((built.messages[0] as { content: string }).content).toBe('stable head');
    expect(built.messages[3]).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: 'done\n\n<total_tokens>14990448 tokens left</total_tokens>',
    });
  });

  it('move: appends to the last text part of a user message with parts', () => {
    const built = buildMessages(
      {
        model: 'auto',
        system: systemWithMarkers,
        messages: [
          {
            role: 'user',
            content: '',
            parts: [{ type: 'text', text: 'hello' }],
          },
        ],
        stream: false,
        includeUsage: false,
      },
      { tokenMarkerMode: 'move' },
    );

    expect(built.messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hello\n\n<total_tokens>14990448 tokens left</total_tokens>' }],
    });
  });

  it('strip: removes markers without re-attaching them', () => {
    const built = buildMessages(
      {
        model: 'auto',
        system: systemWithMarkers,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        includeUsage: false,
      },
      { tokenMarkerMode: 'strip' },
    );

    expect((built.messages[0] as { content: string }).content).toBe('stable head');
    expect(built.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('keep: passes markers through unchanged', () => {
    const built = buildMessages(
      {
        model: 'auto',
        system: systemWithMarkers,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        includeUsage: false,
      },
      { tokenMarkerMode: 'keep' },
    );

    expect((built.messages[0] as { content: string }).content).toBe(systemWithMarkers);
    expect(built.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('leaves unrelated whitespace in the system prompt alone', () => {
    // Only the line the marker occupied may be touched: a proxy must not rewrite
    // user content it was not asked to clean up.
    const built = buildMessages(
      {
        model: 'auto',
        system: 'first\n\n\n\nsecond\n\n<total_tokens>100 tokens left</total_tokens>',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        includeUsage: false,
      },
      { tokenMarkerMode: 'move' },
    );

    expect((built.messages[0] as { content: string }).content).toBe('first\n\n\n\nsecond');
  });

  it('keeps marker-free prompts byte-identical in every mode', () => {
    for (const tokenMarkerMode of ['move', 'strip', 'keep'] as const) {
      const built = buildMessages(
        {
          model: 'auto',
          system: 'stable head',
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
          includeUsage: false,
        },
        { tokenMarkerMode },
      );

      expect((built.messages[0] as { content: string }).content).toBe('stable head');
      expect(built.messages[1]).toEqual({ role: 'user', content: 'hi' });
    }
  });
});
