/** One frame of Qoder's outer SSE envelope. `body` is itself JSON. */
export interface QoderEnvelope {
  statusCodeValue?: number;
  body?: string;
}

/**
 * Parse the outer SSE layer line by line.
 *
 * Qoder wraps every chunk twice: the SSE `data:` frame is an envelope object
 * whose `body` string holds the actual OpenAI-shaped payload. This generator
 * only unwraps the first layer; the client parses the second.
 */
export async function* decodeQoderSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<QoderEnvelope> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');

        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          throw new Error('Upstream SSE frame was not valid JSON');
        }
        if (parsed && typeof parsed === 'object') {
          yield parsed as QoderEnvelope;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
