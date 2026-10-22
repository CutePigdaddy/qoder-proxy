import { describe, expect, it } from 'vitest';
import { estimatePromptTokens, estimateTextTokens } from '../../src/openai/inputBudget.js';
import type { IRRequest } from '../../src/ir/types.js';

const base: IRRequest = { model: 'Test-Model', messages: [] };

describe('estimateTextTokens', () => {
  it('counts English at roughly four characters per token', () => {
    const tokens = estimateTextTokens('a'.repeat(400));
    expect(tokens).toBeGreaterThan(95);
    expect(tokens).toBeLessThan(105);
  });

  it('counts CJK denser than ASCII', () => {
    const cjk = estimateTextTokens('中'.repeat(150));
    const ascii = estimateTextTokens('a'.repeat(150));
    expect(cjk).toBeGreaterThan(ascii * 2);
  });
});

describe('estimatePromptTokens', () => {
  it('includes the system prompt and tool schemas', () => {
    const bare = estimatePromptTokens({ ...base, messages: [{ role: 'user', content: 'hi' }] });
    const withTools = estimatePromptTokens({
      ...base,
      system: 'x'.repeat(4000),
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'search', description: 'y'.repeat(4000), parameters: { type: 'object' } }],
    });
    expect(withTools).toBeGreaterThan(bare + 1500);
  });

  it('does not count image base64 as text', () => {
    const image = estimatePromptTokens({
      ...base,
      messages: [
        {
          role: 'user',
          content: 'see image',
          parts: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(200_000) }],
        },
      ],
    });
    // 一张图按固定当量计，而不是把 200K 字符的 base64 算成 5 万 tokens
    expect(image).toBeLessThan(2000);
  });

  it('grows with conversation length', () => {
    const short = estimatePromptTokens({ ...base, messages: [{ role: 'user', content: 'hi' }] });
    const long = estimatePromptTokens({
      ...base,
      messages: Array.from({ length: 10 }, () => ({ role: 'user' as const, content: 'x'.repeat(4000) })),
    });
    expect(long).toBeGreaterThan(short * 10);
  });
});
