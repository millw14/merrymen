/** Conditional answers from public measurements. No wallet data or execution path. */
import type { TgDeskIntent, TgDeskThought } from "../telegram/tg-groups/types";
import { coinFloor, flowOf, latestCandle, type CoinMeasure } from "./evidence";
import { fmtInt, fmtPct, fmtPrice, fmtUsd, fmtX, utcClock } from "./format";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function levels(c: CoinMeasure): { support: number | null; resistance: number | null; next: number | null } {
  const t = c.tech;
  if (!t || !(t.last > 0)) return { support: null, resistance: null, next: null };
  // A rounded label equal to price cannot express a distinct risk boundary.
  const support = t.supports.find((l) => finite(l.price) && l.price > 0 && l.price < t.last && Number(fmtPrice(l.price)) < Number(fmtPrice(t.last)))?.price ?? null;
  const rs = t.resistances.filter((l) => finite(l.price) && l.price > t.last && Number(fmtPrice(l.price)) > Number(fmtPrice(t.last)));
  return { support, resistance: rs[0]?.price ?? null, next: rs.find((l) => rs[0] && l.price > rs[0].price && fmtPrice(l.price) !== fmtPrice(rs[0].price))?.price ?? null };
}

function measuredRewardRisk(c: CoinMeasure): { ratio: string; price: string; support: string; resistance: string } | null {
  const { support, resistance } = levels(c);
  const price = c.tech?.last;
  if (!finite(price) || support === null || resistance === null || !(support < price && price < resistance)) return null;
  const ratio = (resistance - price) / (price - support);
  if (!(ratio > 0) || !Number.isFinite(ratio) || ratio >= 100) return null;
  const rounded = fmtX(ratio);
  if (rounded === "0x" || Number.parseFloat(rounded) >= 100) return null;
  return { ratio: rounded, price: fmtPrice(price), support: fmtPrice(support), resistance: fmtPrice(resistance) };
}

export function coinIndicatorFloors(c: CoinMeasure): TgDeskEvidenceIndicators {
  const t = c.tech;
  const base = coinFloor(c);
  const map = (read: string): TgDeskThought => ({ read, stance: base.stance, watch: base.watch, invalidation: base.invalidation });
  const average = (name: "EMA20" | "EMA50", value: number | null | undefined): string => value !== null && value !== undefined && t
    ? `The hourly ${name} is ${fmtPrice(value)}, with price ${t.last >= value ? "above" : "below"} it. An average reclaim or loss needs a completed candle and participation; it isn't an entry trigger on its own.`
    : `I don't have enough valid hourly candles to verify ${name}. A shorter history cannot establish this average.`;
  return {
    rsi: map(t?.rsi14 !== null && t?.rsi14 !== undefined ? `Hourly RSI is ${Number(t.rsi14.toFixed(1))}${t.rsi14 >= 70 ? "; momentum is stretched" : t.rsi14 <= 30 ? "; weak momentum alone doesn't confirm a bottom" : "; it isn't an entry trigger on its own"}. RSI needs price structure and participation alongside it.` : "There aren't enough hourly candles to verify RSI; I can't establish whether momentum is overbought or oversold."),
    ema20: map(average("EMA20", t?.ema20)),
    ema50: map(average("EMA50", t?.ema50)),
    vwap: map(t?.vwap24h !== null && t?.vwap24h !== undefined ? `The measured daily VWAP is ${fmtPrice(t.vwap24h)}, with price ${t.last >= t.vwap24h ? "above" : "below"} it. It is a volume-weighted reference, not a guaranteed support or a precise scalp entry.` : "VWAP is unavailable because the hourly candles or their volume are insufficient. I can't confirm a VWAP reclaim or rejection."),
    atr: map(t?.atrPct !== null && t?.atrPct !== undefined ? `Measured hourly ATR is ${fmtPct(t.atrPct, false)} of price. It describes recent candle range, not a forecast, an executable stop distance or a guaranteed loss limit.` : "Hourly ATR is unavailable because there aren't enough valid candles. I can't establish a volatility-based price distance from this chart."),
  };
}

type TgDeskEvidenceIndicators = Partial<Record<"rsi" | "ema20" | "ema50" | "vwap" | "atr", TgDeskThought>>;

/** Every scenario figure, including computed reward/risk, also licenses the numeric prose gate. */
export function coinScenarioBrief(c: CoinMeasure): string {
  const ratio = measuredRewardRisk(c);
  return [
    "SCENARIO LIMITS: the execution chart is hourly only; 5m indexed price change is not a minute candle series. No executable quote, verified contract-safety audit, private account state, historical reply snapshot or verified news feed is included.",
    ratio ? `HYPOTHETICAL LONG MAP: entry at current measured price ${ratio.price}; invalidation reference ${ratio.support}; first resistance ${ratio.resistance}; gross reward/risk ${ratio.ratio}. This assumes entry at the snapshot price and a stop at the support reference, not a placed order. Fees, slippage, gas, gaps and fill probability excluded; not a win probability.` : "HYPOTHETICAL LONG MAP: no usable ordered price, support and resistance set for a reward/risk ratio.",
  ].join("\n");
}

export function coinScenarioFloors(c: CoinMeasure): Partial<Record<TgDeskIntent, TgDeskThought>> {
  const base = coinFloor(c);
  const t = c.tech;
  const lastCandle = latestCandle(c);
  const { support, resistance, next } = levels(c);
  const s = support === null ? null : fmtPrice(support);
  const r = resistance === null ? null : fmtPrice(resistance);
  const fail = s ? `An hourly close below ${s} would invalidate that support-hold idea.` : "No measured support is available to define a price invalidation.";
  const confirm = r ? `A completed hourly close above ${r}, then a held retest with participation.` : "A held support test and improving participation; no measured breakout level is available.";
  const target = r ? `The first measured upside checkpoint is ${r}${next !== null ? `, then ${fmtPrice(next)}` : ""}; neither is a promised target.` : "There is no measured resistance above price in this window; I can't name an upside target.";
  const map = (read: string, watch = confirm, invalidation = fail): TgDeskThought => ({ read, stance: base.stance, watch, invalidation });
  const chartMissing = "I don't have enough hourly candles to verify an entry, support or resistance.";
  const entry = !t ? chartMissing
    : t.trend === "downtrend"
      ? `The hourly trend is down, so a cheaper price isn't a confirmed entry. ${r ? `A reclaim and held retest of ${r} would be the recovery setup to watch.` : "A higher low and a reclaim need to form before an entry setup is confirmed."} ${s ? `Support to test is ${s}.` : "No measured support is available."}`
      : `${s ? `A pullback that holds measured support at ${s} is the conditional entry setup to watch.` : "There is no measured support for a pullback entry in this window."} ${target}`;
  const scalp = !t ? `${chartMissing} A precise scalp also needs a fresh lower-timeframe execution chart.`
    : `For a scalp, ${s ? `I'd watch a hold of ${s}` : "there's no measured support to anchor an entry"}${r ? ` and a reclaim of ${r}` : ""}. ${t.trend === "downtrend" ? "The hourly trend is down, so that recovery is unconfirmed. " : ""}These are hourly levels; a precise scalp entry still needs fresh lower-timeframe candles and an executable quote.`;
  const ratio = measuredRewardRisk(c);
  const h1 = flowOf(c.pools, "h1");
  const flow = finite(h1.buys) && finite(h1.sells)
    ? `The measured hourly tape has ${fmtInt(h1.buys)} buys and ${fmtInt(h1.sells)} sells. ${h1.buys > h1.sells ? "Buy transactions lead" : h1.buys < h1.sells ? "Sell transactions lead" : "Transaction counts are balanced"}, but counts alone don't establish sustained demand or whale activity.`
    : "The hourly buy/sell counts are incomplete, so I can't confirm who is dominating participation.";
  const liquidity = c.pool.dex === "pons-v2"
    ? "This is still a bonding curve; listed reserves include virtual liquidity and cannot establish executable depth or slippage. A real quote and sellability check are needed before any size can be assessed."
    : `${finite(c.pool.reserveUsd) ? `Indexed main-pool liquidity is ${fmtUsd(c.pool.reserveUsd)}. ` : "Pool liquidity is missing. "}Reserves alone cannot establish the price impact of a trade; that needs a fresh executable quote for its size.`;
  const indicators = !t ? "The hourly chart is missing, so I can't verify RSI, averages or momentum."
    : `${t.rsi14 !== null ? `Hourly RSI is ${Number(t.rsi14.toFixed(1))}${t.rsi14 >= 70 ? "; momentum is stretched" : t.rsi14 <= 30 ? "; weak momentum alone doesn't confirm a bottom" : "; it is not an entry trigger on its own"}. ` : "There are too few candles to verify RSI. "}${t.ema20 !== null ? `Price is ${t.last >= t.ema20 ? "above" : "below"} the hourly EMA20 at ${fmtPrice(t.ema20)}.` : "The hourly EMA20 is unavailable."}`;
  return {
    scalp: map(scalp, confirm, fail),
    entry: map(entry, confirm, fail),
    invalidation: map(`${!t ? chartMissing : fail} A chart invalidation is not a placed stop, and gaps or thin liquidity can prevent an exit at that price.`, "Confirm the close and check fresh trading depth; a forming candle isn't confirmation.", fail),
    targets: map(target, r ? `Watch whether price can reach and hold ${r} with participation.` : "Wait for fresh structure to provide a measured resistance level.", fail),
    breakout: map(!t ? chartMissing : r ? `A breakout would need a completed hourly close above ${r} and a retest that holds with participation. A forming candle or wick above resistance isn't a confirmed break.` : "No measured resistance above price exists in this chart window, so I can't identify a verified breakout threshold.", confirm, fail),
    "risk-reward": map(ratio ? `Using the snapshot price ${ratio.price} as hypothetical entry, support ${ratio.support} as invalidation and resistance ${ratio.resistance} as the first checkpoint gives about ${ratio.ratio} gross reward/risk. Costs, gaps and fills are excluded; this isn't a win probability.` : "I can't establish reward/risk without distinct measured support below price and resistance above it. An entry and invalidation assumption are also required; inventing either would give false precision.", confirm, fail),
    timeframe: map(`This snapshot was fetched at ${utcClock(c.observedAtMs)} UTC. ${lastCandle ? `Its newest hourly candle opened ${lastCandle.openedUtc} UTC and is ${lastCandle.forming ? "still forming" : "a completed historical candle"}.` : "The newest candle time is unavailable, so execution-chart freshness isn't confirmed."} ${t ? `The hourly history covers ${t.hours}h` : "Hourly history is unavailable"}; it cannot verify a minute-scale scalp, daily trend or holding duration.`, "A fresh fetch alone doesn't establish fresh candles; check the execution timeframe.", "Lower-timeframe structure may disagree with the hourly map."),
    trend: map(`${base.read} This is a fresh current snapshot; I can't quantify what changed from an earlier reply without its measured snapshot.`, base.watch, base.invalidation),
    indicators: map(indicators, base.watch, base.invalidation),
    volume: map(flow, "Check whether participation and real depth persist beyond the forming candle.", "Fading participation or disappearing liquidity weakens the setup."),
    liquidity: map(liquidity, "Check a fresh executable quote and whether real liquidity remains available.", "A reserve drain or a failed sellability check would invalidate the execution premise."),
    safety: map("This chart cannot establish that the token is safe. Sellability, transfer taxes, ownership powers, an audit and a liquidity lock aren't verified here; price strength and buy/sell counts cannot substitute for those checks.", "Verify contract permissions, sellability and real execution depth separately.", "An unsafe contract permission or blocked exit defeats any attractive chart setup."),
    sizing: map("I can't choose a position size or leverage from this public chart. That needs the owner's loss budget, account balance, signed caps and an executable quote; indexed liquidity alone doesn't establish a safe size.", "Define the loss budget and invalidation, then verify costs and execution depth.", "If an exit cannot execute within the loss budget, the size assumption fails."),
    prediction: map(`${t ? `The hourly trend is ${t.trend === "uptrend" ? "up" : t.trend === "downtrend" ? "down" : "sideways"}. ` : "The chart history is incomplete. "}I can't establish an exact future price, win probability or confirmed bottom from this snapshot. ${r ? `A held reclaim of ${r} would improve the recovery case.` : "A confirmed structure change is needed before a recovery case strengthens."}`, confirm, fail),
    comparison: map("I only have this coin's measured snapshot here. I can't rank it against another token without that token's fresh structure, participation and executable depth; send the other coin or its contract so both can be checked.", "Compare matching time windows and real trading depth for both assets.", "A single chart or different observation times cannot establish relative strength."),
    news: map(c.lore ? "The published description explains the project's theme, but is a project-supplied claim. I don't have separate verified, timestamped news here, so I can't attribute this price move to a catalyst or verify the story's claims." : "I don't have a verified project story or separate timestamped news here. The trading snapshot can describe price and participation, but cannot establish a catalyst for the move.", "Check an attributed announcement and its timing against the price move.", "Promotional claims alone don't establish adoption, safety or a catalyst."),
    execution: map("This is public market analysis; it doesn't confirm a private account's orders or positions. I haven't placed an order through this answer, and a discussion of an entry cannot authorize a trade.", "Use the owner's private account view to check executed orders and trading readiness.", "A hypothetical chart setup is not an execution receipt."),
  };
}
