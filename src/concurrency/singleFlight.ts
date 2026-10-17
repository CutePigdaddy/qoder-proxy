/**
 * Collapse concurrent calls into a single in-flight execution.
 *
 * This is load-bearing for credential refresh: Qoder job refresh tokens are
 * single-use, so two simultaneous refreshes would invalidate each other and
 * break the whole token chain.
 */
export class SingleFlight<T> {
  private inFlight: Promise<T> | null = null;

  async run(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight) return this.inFlight;
    const started = (async () => fn())();
    this.inFlight = started;
    try {
      return await started;
    } finally {
      if (this.inFlight === started) this.inFlight = null;
    }
  }

  get busy(): boolean {
    return this.inFlight !== null;
  }
}
