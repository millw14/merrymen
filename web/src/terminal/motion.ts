/**
 * WHICH WAY A FIGURE JUST MOVED — for the flip a price or a balance plays when
 * it changes.
 *
 * Only a change between two READINGS is a move. A figure drawn for the first
 * time did not move, and neither did one that went from a number to unknown or
 * back: `null` is a read that failed or has not happened, and animating it as a
 * rise or a fall would be the screen asserting a price change nobody measured.
 */
import { useState } from "react";

export type Trend = "up" | "down" | null;

const reading = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

export function trendOf(prev: number | null | undefined, next: number | null | undefined): Trend {
  if (!reading(prev) || !reading(next) || prev === next) return null;
  return next > prev ? "up" : "down";
}

/**
 * The direction of the LAST change this component SHOWED, or null until it has
 * shown one. Remembered from the previous render rather than an effect, so the
 * flip plays in the same frame the new figure is drawn in.
 *
 * A MOVE IS ONLY A MOVE WHEN THE TEXT MOVED. The value carries more precision
 * than the figure prints: a quote mid going from 250.1212 to 250.1234 is up, and
 * "$250.12" both times. Driven by the value alone, the same figure switched to
 * the up class and the stylesheet played a slide and a green tint over digits
 * that had not changed — and a turn in the fourth decimal played a fall. So
 * while the text stands still the trend stands still too: nothing on the figure
 * changes, and nothing plays. The value is still remembered, so the next move
 * that does reach the digits is measured from the latest reading.
 */
export function useTrend(value: number | null, text: string): Trend {
  const [seen, setSeen] = useState<{ value: number | null; text: string; trend: Trend }>({ value, text, trend: null });
  if (seen.text !== text) {
    const trend = trendOf(seen.value, value);
    setSeen({ value, text, trend });
    return trend;
  }
  if (!Object.is(seen.value, value)) setSeen({ ...seen, value });
  return seen.trend;
}
