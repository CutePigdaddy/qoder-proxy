import { describe, expect, it } from 'vitest';
import { AdmissionGate } from '../../src/concurrency/admission.js';
import { BusyError } from '../../src/util/errors.js';

describe('AdmissionGate', () => {
  it('admits up to the concurrency limit without queueing', async () => {
    const gate = new AdmissionGate(2, 5);
    const a = await gate.enter();
    const b = await gate.enter();
    expect(gate.inFlight).toBe(2);
    expect(gate.depth).toBe(0);
    a();
    b();
    expect(gate.inFlight).toBe(0);
  });

  it('rejects when the queue is full', async () => {
    const gate = new AdmissionGate(1, 0);
    const release = await gate.enter();
    await expect(gate.enter()).rejects.toBeInstanceOf(BusyError);
    release();
  });

  it('hands a released slot to the next waiter', async () => {
    const gate = new AdmissionGate(1, 2);
    const first = await gate.enter();
    const queued = gate.enter();
    expect(gate.depth).toBe(1);

    first();
    const second = await queued;
    expect(gate.inFlight).toBe(1);
    expect(gate.depth).toBe(0);

    second();
    expect(gate.inFlight).toBe(0);
  });

  it('is idempotent on double release', async () => {
    const gate = new AdmissionGate(1, 1);
    const release = await gate.enter();
    release();
    release();
    expect(gate.inFlight).toBe(0);
  });
});
