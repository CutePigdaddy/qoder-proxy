/** One frame of Qoder's outer SSE envelope. `body` is itself JSON. */
export interface QoderEnvelope {
  statusCodeValue?: number;
  body?: string;
}

/** Parse one `data:` line. Returns null for comments, blanks and `[DONE]`. */
function parseDataLine(line: string): QoderEnvelope | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;

  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error('Upstream SSE frame was not valid JSON');
  }
  return parsed && typeof parsed === 'object' ? (parsed as QoderEnvelope) : null;
}

/**
 * Parse the outer SSE layer line by line.
 *
 * Qoder wraps every chunk twice: the SSE `data:` frame is an envelope object
 * whose `body` string holds the actual OpenAI-shaped payload. This generator
 * only unwraps the first layer; the client parses the second.
 *
 * Two upstream habits are handled explicitly: a connection that closes without
 * the terminating newline (the tail is flushed rather than discarded — dropping
 * it silently truncates an answer), and a mid-stream parse failure (the reader
 * is cancelled so the socket does not linger).
 */
export async function* decodeQoderSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<QoderEnvelope> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let drained = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        drained = true;
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');

        const envelope = parseDataLine(line);
        if (envelope) yield envelope;
      }
    }

    // A frame left in the buffer is still usable when the gateway closes early.
    const tail = buffer.replace(/\r$/, '');
    buffer = '';
    if (tail.trim()) {
      let envelope: QoderEnvelope | null = null;
      try {
        envelope = parseDataLine(tail);
      } catch {
        // A frame cut mid-JSON cannot be recovered: drop the fragment.
      }
      if (envelope) yield envelope;
    }
  } finally {
    if (!drained) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
