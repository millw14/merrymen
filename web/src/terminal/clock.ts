import { useEffect, useState } from "react";
import type { StrategyId } from "./strategy";

export function useNow(stepMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = globalThis.setInterval(() => setNow(Date.now()), stepMs);
    return () => globalThis.clearInterval(id);
  }, [stepMs]);
  return now;
}

export interface Elapsed {
  value: number;
  unit: "s" | "m" | "h" | "d";
  text: string;
}

/**
 * BOTH ARGUMENTS ARE MILLISECONDS, and the parameter names now say so.
 *
 * They were `at` and `now`, and the omission was the whole of the `20688d`
 * defect: the rail handed this epoch SECONDS for `atMs` and milliseconds for
 * `nowMs`, so the subtraction produced roughly the current epoch and every row
 * in the feed printed the same ~56-year age. Nothing threw, nothing looked
 * empty, and the number was plausible enough to survive review.
 *
 * The repo's convention is unit suffixes in names — `nowSec`, `DAY_SEC`,
 * `lastBarAgeSec`, `LULL_MS`, `stepMs` — so this follows it rather than
 * inventing a branded type, of which there is no precedent here.
 */
export function elapsed(atMs: number, nowMs: number): Elapsed {
  const s = Math.max(0, Math.floor((nowMs - atMs) / 1000));
  if (s < 60) return { value: s, unit: "s", text: `${s}s` };
  const m = Math.floor(s / 60);
  if (m < 60) return { value: m, unit: "m", text: `${m}m` };
  const h = Math.floor(m / 60);
  if (h < 48) return { value: h, unit: "h", text: `${h}h` };
  const d = Math.floor(h / 24);
  return { value: d, unit: "d", text: `${d}d` };
}

export function countdown(ms: number): { text: string; unit: string } {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return { text: `${h}:${pad(m)}:${pad(s)}`, unit: "" };
  return { text: `${pad(m)}:${pad(s)}`, unit: "" };
}

/**
 * No schedule ships in the fixtures, so the next slot is the next whole
 * cadence on the wall clock. Every viewer sees the same countdown.
 */
const CADENCE_MS: Record<StrategyId, number> = {
  "steady-basket": 4 * 3_600_000,
  "even-keel": 6 * 3_600_000,
  "weekend-gap": 24 * 3_600_000,
  "dip-hunter": 2 * 3_600_000,
  trencher: 30 * 60_000,
  "llm-strategist": 12 * 3_600_000,
  custom: 3 * 3_600_000,
};

export function cadenceWords(id: StrategyId): string {
  const ms = CADENCE_MS[id];
  const h = ms / 3_600_000;
  if (h < 1) return `every ${Math.round(ms / 60_000)} minutes`;
  if (h === 24) return "once a day";
  return `every ${h} hours`;
}

export function nextRun(id: StrategyId, now: number): number {
  const step = CADENCE_MS[id];
  return Math.ceil((now + 1) / step) * step;
}

/** Share of the cadence still to run, 1 just after a slot and 0 at the next one. */
export function runLeft(id: StrategyId, now: number): number {
  return (nextRun(id, now) - now) / CADENCE_MS[id];
}

/**
 * How long ago, for the feed rail — "now" under a minute, else the figure.
 *
 * MOVED HERE FROM `wire.tsx`, AND THAT MOVE IS THE POINT. It was a private
 * function in a `.tsx` file, and the test runner globs `*.test.ts` only — there
 * is not one `.test.tsx` in the repo — so nothing in that file was reachable
 * from a test. The `20688d` bug lived in its one call site for as long as it
 * did because no test could have been written against it without this move.
 *
 * Milliseconds, like everything else in this module.
 */
export function whenOf(atMs: number, nowMs: number): string {
  const age = elapsed(atMs, nowMs);
  switch (age.unit) {
    case "s":
      return "now";
    case "m":
    case "h":
    case "d":
      return age.text;
    default: {
      const _x: never = age.unit;
      return _x;
    }
  }
}
