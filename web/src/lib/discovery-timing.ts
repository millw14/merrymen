/** Server-only diagnostics for the public directory; never carries request or row data. */
export type DiscoveryStage = "read-db" | "identities" | "heartbeat" | "registrations" | "perps-wallets" | "lifecycle" | "holds";
type Outcome = "ok" | "error";
export interface DiscoveryTimingEvent {
  stage: DiscoveryStage;
  durationMs: number;
  outcome: Outcome | "pending";
}
export type DiscoveryMeasure = <T>(stage: DiscoveryStage, read: () => Promise<T>) => Promise<T>;
export interface DiscoveryTiming {
  start(stage: DiscoveryStage): (outcome: Outcome) => void;
  measure: DiscoveryMeasure;
}

const SLOW_MS = 1_000;
interface TimingClock {
  now(): number;
  /** Returns cancellation, including when the timer already fired. */
  schedule(callback: () => void, delayMs: number): () => void;
}

export function createDiscoveryTiming(
  clock: TimingClock = {
    now: () => performance.now(),
    schedule(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return () => clearTimeout(timer);
    },
  },
  log: (event: DiscoveryTimingEvent) => void = event => console.warn("[public-discovery]", JSON.stringify(event)),
): DiscoveryTiming {
  const start: DiscoveryTiming["start"] = stage => {
    const began = clock.now();
    let finished = false;
    let reported = false;
    const report = (outcome: DiscoveryTimingEvent["outcome"]) => {
      // Logging cannot fail a read, and an exception's message/SQL is never an input.
      try { log({ stage, durationMs: Math.max(0, Math.round(clock.now() - began)), outcome }); } catch { /* diagnostics only */ }
    };
    const cancel = clock.schedule(() => {
      if (finished) return;
      reported = true;
      report("pending");
    }, SLOW_MS);
    return outcome => {
      if (finished) return;
      finished = true;
      cancel();
      if (reported || clock.now() - began >= SLOW_MS) report(outcome);
    };
  };
  return {
    start,
    async measure(stage, read) {
      const finish = start(stage);
      try {
        const result = await read();
        finish("ok");
        return result;
      } catch (error) {
        finish("error");
        throw error;
      }
    },
  };
}

export const discoveryTiming = createDiscoveryTiming();
