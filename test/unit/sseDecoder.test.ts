import { describe, expect, it } from 'vitest';
import { decodeQoderSse } from '../../src/qoder/sseDecoder.js';

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]) {
  const out = [];
  for await (const envelope of decodeQoderSse(streamFrom(chunks))) out.push(envelope);
  return out;
}

describe('decodeQoderSse', () => {
  it('unwraps data frames and skips [DONE]', async () => {
    const envelopes = await collect([
      'data: {"statusCodeValue":200,"body":"{\\"choices\\":[]}"}\n',
      ': keep-alive\n',
      'data: [DONE]\n',
      'data: {"statusCodeValue":200,"body":"{\\"choices\\":[]}"}\n',
    ]);
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]?.statusCodeValue).toBe(200);
    expect(envelopes[0]?.body).toBe('{"choices":[]}');
  });

  it('reassembles frames split across chunk boundaries', async () => {
    const line = 'data: {"statusCodeValue":200,"body":"x"}\n';
    const envelopes = await collect([line.slice(0, 12), line.slice(12, 30), line.slice(30)]);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.body).toBe('x');
  });

  it('tolerates CRLF line endings', async () => {
    const envelopes = await collect(['data: {"statusCodeValue":200,"body":"y"}\r\n']);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.body).toBe('y');
  });

  it('rejects a malformed JSON frame', async () => {
    await expect(collect(['data: {not json}\n'])).rejects.toThrow(/not valid JSON/);
  });
});
