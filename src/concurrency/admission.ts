import { BusyError } from '../util/errors.js';

export type Release = () => void;

/**
 * Bounded concurrency plus a bounded wait queue.
 *
 * Every request must call the returned release function exactly once. When the
 * queue is full the caller receives a BusyError, which the HTTP layer renders as
 * 429 + Retry-After; that backpressure is what keeps a slow upstream from
 * exhausting memory.
 */
export class AdmissionGate {
  private active = 0;
  private waiting = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly limit: number,
    private readonly queueLimit: number,
  ) {}

  get inFlight(): number {
    return this.active;
  }

  get depth(): number {
    return this.waiting;
  }

  async enter(): Promise<Release> {
    if (this.active < this.limit && this.waiting === 0) {
      this.active++;
      return this.makeRelease();
    }
    if (this.waiting >= this.queueLimit) {
      throw new BusyError(Math.max(1, this.waiting));
    }
    this.waiting++;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.waiting--;
    return this.makeRelease();
  }

  private makeRelease(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next();
      } else {
        this.active--;
      }
    };
  }
}
