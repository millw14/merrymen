/** One elapsed-time budget for a lookup, including optional chart work. */
export const DESK_LOOKUP_MS = 10_000;

export interface DeskReadOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function lookupTimeout(timeoutMs?: number): number {
  return timeoutMs === undefined || !Number.isFinite(timeoutMs)
    ? DESK_LOOKUP_MS
    : Math.max(0, Math.min(DESK_LOOKUP_MS, Math.floor(timeoutMs)));
}

export class DeskBudget {
  private readonly deadline: number;

  constructor(timeoutMs?: number) {
    this.deadline = performance.now() + lookupTimeout(timeoutMs);
  }

  remaining(): number {
    return Math.max(0, Math.floor(this.deadline - performance.now()));
  }

  /** A hung dependency cannot extend the budget; its eventual result is ignored. */
  async run<T>(work: (options: DeskReadOptions) => Promise<T>, fallback: T, maxMs = Infinity): Promise<T> {
    const timeoutMs = Math.floor(Math.min(this.remaining(), maxMs));
    if (timeoutMs < 1) return fallback;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(fallback);
      }, timeoutMs);
    });
    try {
      const result = Promise.resolve().then(() => work({ timeoutMs, signal: controller.signal })).catch(() => fallback);
      return await Promise.race([result, timeout]);
    } finally {
      clearTimeout(timer!);
      controller.abort();
    }
  }
}
