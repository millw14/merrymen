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

export function elapsed(at: number, now: number): Elapsed {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return { value: s, unit: "s", text: `${s}s` };
  const m = Math.floor(s / 60);
  if (m < 60) return { value: m, unit: "m", text: `${m}m` };
  const h = Math.floor(m / 60);
  if (h < 48) return { value: h, unit: "h", text: `${h}h` };
  const d = Math.floor(h / 24);
  return { value: d, unit: "d", text: `${d}d` };
}

/** Plain words, not `4h 30m`. Used where a stretch of quiet is the subject. */
export function spellSpan(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} minutes`;
  const h = Math.round(m / 60);
  if (h < 48) return h === 1 ? "an hour" : `${h} hours`;
  const d = Math.round(h / 24);
  return d === 1 ? "a day" : `${d} days`;
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
