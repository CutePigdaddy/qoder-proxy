import { BusyError, ClientGoneError } from '../util/errors.js';

export type Release = () => void;

/**
 * Bounded concurrency plus a bounded wait queue.
 *
 * Every request must call the returned release function exactly once. When the
 * queue is full the caller receives a BusyError, which the HTTP layer renders as
 * 429 + Retry-After; that backpressure is what keeps a slow upstream from
 * exhausting memory.
 *
 * Waiting is bounded by `queueLimit` and by the caller's signal: a client that
 * disconnects while queued must not keep waiting for a slot it will never use.
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

  async enter(signal?: AbortSignal): Promise<Release> {
    if (this.active < this.limit && this.waiting === 0) {
      this.active++;
      return this.makeRelease();
    }
    if (this.waiting >= this.queueLimit) {
      throw new BusyError(Math.max(1, this.waiting));
    }
    if (signal?.aborted) throw new ClientGoneError();

    this.waiting++;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (finish: () => void): void => {
          if (settled) return;
          settled = true;
          finish();
        };
        const waiter = (): void => {
          signal?.removeEventListener('abort', onAbort);
          settle(resolve);
        };
        const onAbort = (): void => {
          // Leave the queue so the slot goes to someone who is still listening.
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          settle(() => reject(new ClientGoneError()));
        };
        this.waiters.push(waiter);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    } finally {
      this.waiting--;
    }
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
