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

  it('flushes a final frame that arrives without a terminating newline', async () => {
    // The gateway can close the connection right after the last chunk; dropping
    // that frame silently truncates the answer or zeroes the usage.
    const envelopes = await collect(['data: {"statusCodeValue":200,"body":"a"}\n\n', 'data: {"body":"b"}']);
    expect(envelopes.map((envelope) => envelope.body)).toEqual(['a', 'b']);
  });

  it('cancels the upstream reader when a frame cannot be parsed', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {not json}\n'));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(
      (async () => {
        for await (const envelope of decodeQoderSse(stream)) void envelope;
      })(),
    ).rejects.toThrow(/not valid JSON/);
    expect(cancelled).toBe(true);
  });
});

function streamFromBytes(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collectBytes(chunks: Uint8Array[]) {
  const out = [];
  for await (const envelope of decodeQoderSse(streamFromBytes(chunks))) out.push(envelope);
  return out;
}

describe('decodeQoderSse chunk boundaries', () => {
  it('keeps a multibyte character split across chunks intact', async () => {
    // A 4-byte emoji straddling a TCP segment boundary is the classic way to
    // corrupt content with a naive per-chunk toString().
    const bytes = new TextEncoder().encode('data: {"body":"🌏"}\n\n');
    const emojiStart = bytes.indexOf(0xf0); // first byte of the 4-byte sequence
    const split = emojiStart + 2;

    const envelopes = await collectBytes([bytes.slice(0, split), bytes.slice(split)]);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.body).toBe('🌏');
  });

  it('accepts data lines without the optional space', async () => {
    const envelopes = await collect(['data:{"body":"x"}\n']);
    expect(envelopes[0]?.body).toBe('x');
  });

  it('ignores event, id and comment lines', async () => {
    const envelopes = await collect([
      ': keep-alive\n',
      'event: message\n',
      'id: 42\n',
      'data: {"body":"a"}\n',
      '\n',
    ]);
    expect(envelopes.map((envelope) => envelope.body)).toEqual(['a']);
  });

  it('reassembles a frame far larger than the chunk size', async () => {
    const payload = JSON.stringify({ body: 'x'.repeat(200_000) });
    const bytes = new TextEncoder().encode(`data: ${payload}\n\n`);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 1024) chunks.push(bytes.slice(i, i + 1024));

    const envelopes = await collectBytes(chunks);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.body).toBe('x'.repeat(200_000));
  });
});
