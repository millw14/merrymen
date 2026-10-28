/** Deterministic trend profiles. These select measured signal rules, never execution authority or risk caps. */
export const PERPS_STYLE_CATALOG = [
  { id: "scalp-breakout", label: "Scalp breakout", family: "scalp", timeframe: "5m", candleMs: 300_000, entryChannel: 12, maxHoldHours: 0.5, description: "Five-minute channel breaks with a thirty-minute time exit." },
  { id: "scalp-confirmed", label: "Scalp confirmed", family: "scalp", timeframe: "15m", candleMs: 900_000, entryChannel: 24, maxHoldHours: 1, description: "Fifteen-minute bars must clear a longer channel; one-hour time exit." },
  { id: "day-breakout", label: "Day breakout", family: "day", timeframe: "1h", candleMs: 3_600_000, entryChannel: 12, maxHoldHours: 8, description: "Hourly trend breaks with an eight-hour time exit." },
  { id: "day-patient", label: "Day patient", family: "day", timeframe: "1h", candleMs: 3_600_000, entryChannel: 24, maxHoldHours: 12, description: "A longer hourly channel filters entries; twelve-hour time exit." },
  { id: "swing-trend", label: "Swing trend", family: "swing", timeframe: "4h", candleMs: 14_400_000, entryChannel: 12, maxHoldHours: 168, description: "The original four-hour trend rule, with a seven-day time exit." },
  { id: "swing-patient", label: "Swing patient", family: "swing", timeframe: "4h", candleMs: 14_400_000, entryChannel: 24, maxHoldHours: 168, description: "A longer four-hour breakout channel with the same seven-day ceiling." },
  { id: "scalp-selective", label: "Scalp selective", family: "scalp", timeframe: "15m", candleMs: 900_000, entryChannel: 36, maxHoldHours: 1, description: "A thirty-six-bar channel demands a wider breakout before a one-hour hold." },
  { id: "day-selective", label: "Day selective", family: "day", timeframe: "1h", candleMs: 3_600_000, entryChannel: 36, maxHoldHours: 12, description: "An hourly close must escape the prior thirty-six bars; twelve-hour time exit." },
  { id: "swing-selective", label: "Swing selective", family: "swing", timeframe: "4h", candleMs: 14_400_000, entryChannel: 36, maxHoldHours: 168, description: "A six-day breakout channel on four-hour bars; seven-day time exit." },
] as const;
export type PerpsStyleId = (typeof PERPS_STYLE_CATALOG)[number]["id"];
export const DEFAULT_PERPS_STYLE: PerpsStyleId = "swing-trend";
export function isPerpsStyle(value: unknown): value is PerpsStyleId {
  return typeof value === "string" && PERPS_STYLE_CATALOG.some(s => s.id === value);
}
export function getPerpsStyle(id: PerpsStyleId = DEFAULT_PERPS_STYLE) {
  return PERPS_STYLE_CATALOG.find(s => s.id === id)!;
}
/** Legacy absence is the original rule. Unknown values never select a strategy. */
export function perpsStyleForDriver(style: PerpsStyleId | undefined, driver: string): boolean {
  return (style === undefined || isPerpsStyle(style)) && (driver === "perp-trend" || driver === "manual" || style === undefined || style === DEFAULT_PERPS_STYLE);
}
