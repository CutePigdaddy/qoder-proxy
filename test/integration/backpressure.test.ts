import { describe, expect, it, vi } from 'vitest';
import { AdmissionGate } from '../../src/concurrency/admission.js';
import type { IREvent } from '../../src/ir/types.js';
import { chatBody, createHarness } from '../helpers/gateway.js';

/**
 * Concurrency and backpressure.
 *
 * The upstream account is rate limited and the gateway shares one token chain,
 * so the admission gate is a correctness mechanism, not an optimisation. These
 * tests assert that it actually serialises work, that it never loses a slot, and
 * that a caller stuck in the queue is not stranded there forever.
 */

interface Tracker {
  active: number;
  peak: number;
}

function trackedChat(delayMs: number, tracker: Tracker) {
  return async function* slow(): AsyncGenerator<IREvent> {
    tracker.active += 1;
    tracker.peak = Math.max(tracker.peak, tracker.active);
    try {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      yield { type: 'text-delta', text: 'ok' };
      yield { type: 'done', finishReason: 'stop' };
    } finally {
      tracker.active -= 1;
    }
  };
}

describe('admission control', () => {
  it('never runs more upstream calls than the configured limit', async () => {
    const tracker: Tracker = { active: 0, peak: 0 };
    const harness = createHarness({
      config: { concurrency: 2, queueLimit: 10 },
      chat: trackedChat(20, tracker),
    });

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => harness.post(chatBody())),
    );

    expect(responses.map((response) => response.status)).toEqual(Array(6).fill(200));
    expect(tracker.peak).toBeLessThanOrEqual(2);
    // Every slot must come back, however the requests interleaved.
    expect(harness.gate.inFlight).toBe(0);
    expect(harness.gate.depth).toBe(0);
  });

  it('rejects with 429 + Retry-After once the queue is full, without leaking slots', async () => {
    // A deferred upstream keeps the first request inside the gate for as long as
    // the test needs, instead of relying on a delay racing the poll interval.
    let openUpstream!: () => void;
    const upstreamGate = new Promise<void>((resolve) => {
      openUpstream = resolve;
    });
    const harness = createHarness({
      config: { concurrency: 1, queueLimit: 1 },
      chat: async function* held() {
        await upstreamGate;
        yield { type: 'text-delta', text: 'ok' };
        yield { type: 'done', finishReason: 'stop' };
      },
    });

    const first = harness.post(chatBody());
    await vi.waitFor(() => expect(harness.gate.inFlight).toBe(1));

    const queued = harness.post(chatBody());
    await vi.waitFor(() => expect(harness.gate.depth).toBe(1));

    const rejected = await harness.post(chatBody());
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get('retry-after')).toBeTruthy();

    openUpstream();

    // The rejected request must not have consumed a slot, and the two admitted
    // ones must still finish normally.
    expect((await first).status).toBe(200);
    expect((await queued).status).toBe(200);
    expect(harness.gate.inFlight).toBe(0);
  });

  it('stops waiting for a slot when the request deadline expires', async () => {
    const gate = new AdmissionGate(1, 4);
    const held = await gate.enter();
    const harness = createHarness({ config: { concurrency: 1, requestTimeoutMs: 80 }, gate });

    const started = Date.now();
    const response = await harness.post(chatBody());

    // 504 rather than 429: the gateway gave up, the client did nothing wrong.
    expect(response.status).toBe(504);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(harness.gate.depth).toBe(0);

    held();
    expect(gate.inFlight).toBe(0);
  });

  it('drops a queued request when its client disconnects', async () => {
    const gate = new AdmissionGate(1, 4);
    const held = await gate.enter();
    const harness = createHarness({ config: { concurrency: 1, requestTimeoutMs: 10_000 }, gate });

    const controller = new AbortController();
    const pending = harness.post(chatBody(), { signal: controller.signal });
    await vi.waitFor(() => expect(harness.gate.depth).toBe(1));

    controller.abort();

    const response = await pending;
    expect(response.status).toBe(499);
    // The abandoned waiter must not keep occupying queue capacity.
    await vi.waitFor(() => expect(harness.gate.depth).toBe(0));
    expect(harness.calls).toHaveLength(0);

    held();
    expect(gate.inFlight).toBe(0);
  });
});
