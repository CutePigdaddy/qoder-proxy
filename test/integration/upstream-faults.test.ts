import { describe, expect, it, vi } from 'vitest';
import type { IREvent } from '../../src/ir/types.js';
import { chatBody, createHarness } from '../helpers/gateway.js';

/**
 * Failure and lifecycle tests.
 *
 * The common production incidents are not "wrong answer" but "the request never
 * ends": a client that closes the tab, an upstream that goes quiet, a slot that
 * is never given back. Each of those is invisible until the gateway wedges, so
 * they are asserted here rather than discovered in an incident.
 */

describe('connection lifecycle', () => {
  it('aborts the upstream call when the client disconnects', async () => {
    const signals: AbortSignal[] = [];
    const harness = createHarness({
      chat: async function* slow(_req, _model, signal) {
        signals.push(signal);
        // Register the abort promise *before* yielding: an abort can land while
        // the generator is suspended between yields, and a listener added after
        // that point would never fire.
        const gone = new Promise<never>((_resolve, reject) => {
          if (signal.aborted) reject(new Error('client went away'));
          signal.addEventListener('abort', () => reject(new Error('client went away')), {
            once: true,
          });
        });
        gone.catch(() => undefined);
        yield { type: 'text-delta', text: 'partial' };
        await gone;
      },
    });

    const controller = new AbortController();
    const response = await harness.post(chatBody({ stream: true }), { signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();

    // A real client keeps draining until EOF. Hono's SSE body is a
    // TransformStream with backpressure, so a reader that stops consuming would
    // block the route inside writeSSE and make this assertion meaningless.
    const draining = (async () => {
      try {
        while (!(await reader.read()).done) {
          /* discard */
        }
      } catch {
        /* the stream may be torn down mid-flight */
      }
    })();

    controller.abort();

    // Two invariants: the upstream stops burning the account's quota, and the
    // concurrency slot comes back instead of staying pinned until the timeout.
    await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true));
    await vi.waitFor(() => expect(harness.gate.inFlight).toBe(0));
    await draining;
  });

  it('gives up on a silent upstream when the request deadline expires', async () => {
    const signals: AbortSignal[] = [];
    const harness = createHarness({
      config: { requestTimeoutMs: 150 },
      chat: async function* hang(_req, _model, signal) {
        signals.push(signal);
        yield* [] as IREvent[];
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('request timeout')), { once: true });
        });
      },
    });

    const started = Date.now();
    const response = await harness.post(chatBody());
    const elapsed = Date.now() - started;

    // Without the deadline this request would hang for as long as the upstream
    // does; clients would rather see a failure they can retry.
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(elapsed).toBeLessThan(3_000);
    expect(signals[0]?.aborted).toBe(true);
    await vi.waitFor(() => expect(harness.gate.inFlight).toBe(0));
  });

  it('releases the slot exactly once when a stream fails after it started', async () => {
    const harness = createHarness({
      chat: async function* broken() {
        yield { type: 'text-delta', text: 'a' };
        yield { type: 'text-delta', text: 'b' };
        throw new Error('upstream reset');
      },
    });

    const raw = await (await harness.post(chatBody({ stream: true }))).text();

    expect(raw).toContain('"type":"upstream_error"');
    // A double release would drive the counter negative and let a slot leak
    // into a permanent over-admission.
    expect(harness.gate.inFlight).toBe(0);
  });
});

describe('upstream payload faults', () => {
  it('honours an explicit error event from the upstream client', async () => {
    const harness = createHarness({
      chat: async function* errorEvent() {
        yield { type: 'error', message: 'upstream is busy (code 10605)', status: 503 };
      },
    });

    const response = await harness.post(chatBody());
    const body = (await response.json()) as { error: { message: string; type: string } };

    // The IR carries a status so a mapped failure keeps its meaning instead of
    // collapsing into a generic 502.
    expect(response.status).toBe(503);
    expect(body.error.type).toBe('upstream_error');
    expect(body.error.message).toContain('10605');
  });

  it('keeps the error frame when the upstream dies before the first token', async () => {
    const harness = createHarness({
      chat: async function* dead() {
        yield* [] as IREvent[];
        throw new Error('connection refused');
      },
    });

    const raw = await (await harness.post(chatBody({ stream: true }))).text();
    expect(raw).toContain('"type":"upstream_error"');
    expect(raw.trimEnd().endsWith('[DONE]')).toBe(true);
  });

  it('redacts credential-shaped strings before they reach the client', async () => {
    const harness = createHarness({
      chat: async function* leaky() {
        throw new Error('upstream rejected pt-abcdef123456 while exchanging');
      },
    });
    const response = await harness.post(chatBody());
    const body = (await response.json()) as { error: { message: string } };

    // Error text travels to third-party clients and into their logs; a token
    // echoed by the upstream must never survive that trip.
    expect(body.error.message).toContain('[redacted]');
    expect(body.error.message).not.toContain('pt-abcdef123456');
  });
});
