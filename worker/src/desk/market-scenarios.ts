/** Market-board follow-ups stay within this board's measurements and timestamps. */
import type { TgDeskEvidence, TgDeskIntent, TgDeskThought } from "../telegram/tg-groups/types";
import { marketFloor, marketStats, type MarketMeasure } from "./evidence";
import { fmtPct } from "./format";

type BoardIntent = "timeframe" | "news" | "prediction";

function observedUtc(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 16).replace("T", " ") : null;
}

export function marketObservationBrief(ms: number): string {
  const observed = observedUtc(ms);
  return observed ? `BOARD OBSERVATION: ${observed} UTC; the observation time does not verify every underlying trade or candle time.` : "BOARD OBSERVATION: time unavailable; market-data freshness cannot be established.";
}

/** Also usable for older public evidence that has metadata but no scenario map. */
export function marketFallbackScenario(e: Pick<TgDeskEvidence, "observedAtMs" | "floor">, intent: TgDeskIntent, partial = false): TgDeskThought | undefined {
  const observed = observedUtc(e.observedAtMs);
  const coverage = partial ? " Coverage is partial; activity outside the available list is unknown." : " The sampled board does not cover every coin or trade.";
  const map = (read: string, watch: string, invalidation: string): TgDeskThought => ({ read, stance: e.floor.stance, watch, invalidation });
  if (intent === "timeframe") return map(`${observed ? `This market snapshot was observed ${observed} UTC.` : "The market observation time is unavailable, so its freshness cannot be established."} Its indexed hourly and daily windows do not verify the latest trade or candle time for every pool.${coverage}`, "Refresh the board and check each source's underlying update time before using it for execution.", "An old underlying update or missing coverage prevents treating this as a current execution view.");
  if (intent === "news") return map(`I don't have verified, timestamped market news here, so I can't establish what news is moving the market. This board measures indexed price, volume and participation; those movements alone cannot establish a news catalyst.${coverage}`, "Check attributed news and its publication time against the market move.", "Price movement without verified, timed news does not establish a catalyst.");
  if (intent === "prediction") return map(`I can't predict whether or when the market will recover from this snapshot. Widening hourly breadth with sustained participation would strengthen a recovery case; it would remain conditional.${coverage}`, "Watch for broader hourly gains with participation across more than the leaders.", "Narrow gains, weakening breadth or fading participation would weaken the recovery case.");
  return undefined;
}

export function marketScenarioFloors(m: MarketMeasure): Record<BoardIntent, TgDeskThought> {
  const base = marketFloor(m);
  const metadata = { observedAtMs: m.observedAtMs, floor: base };
  const partial = !!m.missingFeeds?.length;
  const prediction = marketFallbackScenario(metadata, "prediction", partial)!;
  const s = marketStats(m);
  const breadth = `${s.up24} of ${s.count} sampled coins are green over the day${s.median24 !== null ? `, with median change ${fmtPct(s.median24)}` : ""}`;
  return {
    timeframe: marketFallbackScenario(metadata, "timeframe", partial)!,
    news: marketFallbackScenario(metadata, "news", partial)!,
    prediction: { ...prediction, read: `I can't predict whether or when the market will recover. ${breadth}. Widening hourly breadth with sustained participation would strengthen a conditional recovery case.${partial ? " Coverage is partial; activity outside the available list is unknown." : " This sample does not cover the whole market."}` },
  };
}
