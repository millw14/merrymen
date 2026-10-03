/**
 * One read pass at a time, with one follow-up for evidence that arrived while
 * it was running. A provider failure keeps that follow-up behind the retry
 * delay rather than turning a burst of requests into a retry loop.
 */
export class CoalescedRefresh {
  private running = false;
  private wanted = false;
  private retryAt = 0;
  private timer: unknown = null;

  constructor(private readonly d: {
    run: () => Promise<boolean>;
    now?: () => number;
    retryMs?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
  }) {}

  busy(): boolean { return this.running || this.timer !== null; }

  request(): void {
    this.wanted = true;
    this.start();
  }

  private now(): number { return (this.d.now ?? Date.now)(); }

  private start(): void {
    if (this.running || !this.wanted) return;
    const wait = this.retryAt - this.now();
    if (wait > 0) {
      if (this.timer === null) {
        const set = this.d.setTimer ?? ((fn, ms) => {
          const timer = setTimeout(fn, ms);
          timer.unref();
          return timer;
        });
        this.timer = set(() => { this.timer = null; this.start(); }, wait);
      }
      return;
    }
    if (this.timer !== null) {
      (this.d.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.timer);
      this.timer = null;
    }
    this.wanted = false;
    this.running = true;
    void Promise.resolve().then(this.d.run).catch(() => false).then((ok) => {
      if (!ok) this.retryAt = this.now() + (this.d.retryMs ?? 60_000);
      this.running = false;
      this.start();
    });
  }
}
