// Issue #96 PR-B1: the per-run judge semaphore (decision 12).

interface Holder {
  readonly admittedAt: number;
}

/**
 * The per-run semaphore (decision 12). A permit is released when the wrapped
 * call SETTLES (A-1), never when the scanner times out, so "at most four
 * live" holds while an aborted child exits. A waiter whose signal aborts is
 * removed by the abort LISTENER itself, synchronously (A-11).
 */
export class JudgeSlots {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly holders = new Set<Holder>();

  constructor(private readonly max: number) {}

  acquire(signal: AbortSignal | undefined, onAbandon: () => void): Promise<boolean> {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      if (signal?.aborted === true) {
        onAbandon();
        resolve(false);
        return;
      }
      const grant = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve(true);
      };
      const onAbort = (): void => {
        const at = this.queue.indexOf(grant);
        if (at >= 0) this.queue.splice(at, 1);
        onAbandon();
        resolve(false);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(grant);
    });
  }

  hold(admittedAt: number): Holder {
    const holder = { admittedAt };
    this.holders.add(holder);
    return holder;
  }

  release(holder?: Holder): void {
    if (holder !== undefined) this.holders.delete(holder);
    const next = this.queue.shift();
    if (next !== undefined) next();
    else this.active -= 1;
  }

  /** Every permit held by a call admitted at least `ms` before `now` (A-1, B-3: `>=`). */
  allHeldFor(now: number, ms: number): boolean {
    if (this.active < this.max || this.holders.size < this.max) return false;
    return [...this.holders].every((h) => now - h.admittedAt >= ms);
  }
}
