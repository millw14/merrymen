/**
 * THE TAPE WITH ITS NUMBERS LEFT ON — every curve trade on the chain, decoded,
 * and the windowed features that make "trending" a measurement.
 *
 * WHAT pons-activity.ts THROWS AWAY, AND WHY THIS MODULE EXISTS. The class
 * route's tape reader narrows each log to `{address, topics, transactionHash}`
 * at the parse boundary: `blockNumber` and `data` are dropped even though the
 * node already returned them. So the only per-curve figures the route has are
 * `{buys, sells, traders}` over one 9,000-block window. No window narrower than
 * the whole read is possible without block numbers; no volume, no buy/sell
 * imbalance by amount, no implied price and no per-trade size is possible
 * without the data words. Every velocity / acceleration / momentum signal the
 * trending Brain needs is derivable from exactly those two fields — and both
 * are free, because the RPC cost is in the query, not in the parse.
 *
 * This module does NOT replace `readCurveActivity`. That reader feeds a GATE
 * (`ACTIVITY_GATE`) whose all-or-nothing discipline is right for a gate: a
 * partial tape is a wrong trade count, not a smaller one. A rolling series
 * needs the opposite discipline — keep what was read, and say precisely which
 * blocks were NOT — so `readCurveTrades` reports holes instead of nulling.
 *
 * ONLY FACTORY CURVES COUNT. The query carries no address filter (that is what
 * makes one call cover ~58 active curves), which means any contract that emits
 * the same topic0 lands in the tape. pons-price.ts:200-209 names this as the
 * spoofing route. `windowFeatures` therefore takes the factory-filtered launch
 * set as an allow-list and a curve outside it is not a feature, it is noise.
 *
 * ACCELERATION, NOT VOLUME. The milestone brief is explicit: absolute volume
 * rewards whatever was already big. The figures below are RATES per window
 * (trades a minute, quote a minute) and RATIOS of short-window rate to
 * long-window rate, so a curve that just woke up outranks one that has been
 * steadily busy for an hour. Both rates are still carried, because a ratio on
 * three trades is a number and not a signal, and the ranker needs the floor.
 */
import type { PublicClient } from "viem";
import { ACTIVITY_CHUNK_BLOCKS, PONS_BUY_TOPIC, PONS_SELL_TOPIC } from "./pons-activity";

/** One decoded curve trade. Amounts are RAW units of the curve's own assets. */
export interface PonsTrade {
  /** Lowercased curve address — the log's emitter. */
  curve: string;
  side: "buy" | "sell";
  /** Lowercased trader, from the event's indexed topic1. */
  trader: string;
  /** Quote asset moved: quoteIn on a buy, quoteOut on a sell. Raw units. */
  quoteRaw: bigint;
  /** Token moved: tokensOut on a buy, tokensIn on a sell. Raw units. */
  tokenRaw: bigint;
  block: bigint;
  tx: string;
}

/** A log as the node returns it, with the two fields the old reader dropped. */
export interface TradeLog {
  address: string;
  topics: readonly string[];
  data: string;
  blockNumber: string | bigint | null;
  transactionHash: string | null;
}

function word(data: string, i: number): bigint | null {
  const start = 2 + i * 64;
  if (data.length < start + 64) return null;
  return BigInt(`0x${data.slice(start, start + 64)}`);
}

/**
 * Decode one curve trade log, or null for anything that is not one.
 *
 * Buy data words are (quoteIn, tokensOut, fee1, fee2); sell data words are
 * (tokensIn, quoteOut, fee1, fee2) — both verified on mainnet by
 * pons-activity.ts. A log with too few words is SKIPPED, not defaulted: a trade
 * with an invented zero amount would sit in every volume figure as a real
 * trade that moved nothing.
 */
export function decodeTradeLog(log: TradeLog): PonsTrade | null {
  const topic = log.topics[0]?.toLowerCase();
  const isBuy = topic === PONS_BUY_TOPIC;
  const isSell = topic === PONS_SELL_TOPIC;
  if (!isBuy && !isSell) return null;
  const who = log.topics[1];
  if (!who || who.length < 42) return null;
  if (log.blockNumber === null || log.blockNumber === undefined) return null;
  const w0 = word(log.data, 0);
  const w1 = word(log.data, 1);
  if (w0 === null || w1 === null) return null;
  const block = typeof log.blockNumber === "bigint" ? log.blockNumber : BigInt(log.blockNumber);
  return {
    curve: log.address.toLowerCase(),
    side: isBuy ? "buy" : "sell",
    trader: `0x${who.slice(-40)}`.toLowerCase(),
    quoteRaw: isBuy ? w0 : w1,
    tokenRaw: isBuy ? w1 : w0,
    block,
    tx: log.transactionHash ?? "",
  };
}

/** A block range the read could not cover. Inclusive on both ends. */
export interface TapeHole {
  from: bigint;
  to: bigint;
  why: "capped" | "rpc-error";
}

export interface TapeRead {
  trades: PonsTrade[];
  /** The range that was ASKED for. Coverage is this minus `holes`. */
  from: bigint;
  to: bigint;
  holes: TapeHole[];
}

/**
 * Read every curve trade in a block range, in chunks the node will answer.
 *
 * Same chunking as `readCurveActivity` (3,000 blocks ≈ 2,550 logs at the
 * measured density, 10,000 is the node's cap). A chunk that comes back AT the
 * cap is recorded as a hole rather than trusted: the node truncates silently at
 * exactly 10,000 and a truncated chunk is a wrong count. A chunk the RPC
 * refuses is a hole too. Either way the caller gets everything else and a
 * precise statement of what it does not have, which is what a rolling series
 * needs and what a gate must never accept — which is why this is not the gate's
 * reader.
 */
export async function readCurveTrades(
  client: Pick<PublicClient, "request">,
  range: { from: bigint; to: bigint },
  chunkBlocks: bigint = ACTIVITY_CHUNK_BLOCKS,
): Promise<TapeRead> {
  const trades: PonsTrade[] = [];
  const holes: TapeHole[] = [];
  const from = range.from < 0n ? 0n : range.from;
  for (let lo = from; lo <= range.to; lo += chunkBlocks) {
    const hi = lo + chunkBlocks - 1n > range.to ? range.to : lo + chunkBlocks - 1n;
    let raw: TradeLog[];
    try {
      raw = (await client.request({
        method: "eth_getLogs",
        params: [
          {
            fromBlock: `0x${lo.toString(16)}`,
            toBlock: `0x${hi.toString(16)}`,
            topics: [[PONS_BUY_TOPIC, PONS_SELL_TOPIC]],
          },
        ],
      } as never)) as TradeLog[];
    } catch {
      holes.push({ from: lo, to: hi, why: "rpc-error" });
      continue;
    }
    if (raw.length >= 10_000) {
      holes.push({ from: lo, to: hi, why: "capped" });
      continue;
    }
    for (const l of raw) {
      const t = decodeTradeLog(l);
      if (t) trades.push(t);
    }
  }
  return { trades, from, to: range.to, holes };
}

/** What one curve did inside one window. Every amount is raw quote units. */
export interface WindowTally {
  /** Window length in seconds — the label, e.g. 300 / 900 / 3600. */
  sec: number;
  trades: number;
  buys: number;
  sells: number;
  /** Distinct trader addresses in the window, both sides. */
  traders: number;
  /** Traders in this window who had NOT traded this curve earlier in the tape. */
  newTraders: number;
  quoteIn: bigint;
  quoteOut: bigint;
  /** quoteIn + quoteOut. */
  volume: bigint;
  /** (buys − sells) / trades, −1..1. Null when no trades. */
  imbalanceCount: number | null;
  /** (quoteIn − quoteOut) / volume, −1..1. Null when no volume. */
  imbalanceQuote: number | null;
  /** Trades per minute over the window. */
  tradesPerMin: number;
  /** Quote per minute over the window, as a JS number of RAW units. */
  quotePerMin: number;
  /** Implied fill price of the first and last trade in the window (quote/token, raw ratio). */
  firstPrice: number | null;
  lastPrice: number | null;
  /** lastPrice / firstPrice − 1. Null when either side is missing. */
  momentum: number | null;
  /** True when any hole overlaps this window — the figures are a floor, not a count. */
  incomplete: boolean;
}

export interface CurveTrend {
  curve: string;
  /** Keyed by window seconds, in the order they were asked for. */
  windows: WindowTally[];
  /**
   * Short-window trade rate over long-window trade rate. >1 means the curve is
   * getting busier than its hour says it was; null when the long window is empty.
   */
  tradeAcceleration: number | null;
  /** Same ratio for quote volume. */
  volumeAcceleration: number | null;
  /** Net quote flow into the curve over the LONGEST window (buys − sells), raw. */
  netQuoteFlow: bigint;
  /** First and last block this curve traded in the tape. */
  firstBlock: bigint;
  lastBlock: bigint;
}

function ratio(num: bigint, den: bigint): number | null {
  if (den <= 0n) return null;
  // Signed ratio at 1e6 resolution — enough for a −1..1 figure.
  return Number((num * 1_000_000n) / den) / 1_000_000;
}

function impliedPrice(t: PonsTrade): number | null {
  if (t.tokenRaw <= 0n || t.quoteRaw <= 0n) return null;
  // quote per token in raw units, as a double. Precision is not the point
  // here — momentum is a ratio of two of these, and both carry the same scale.
  return Number(t.quoteRaw) / Number(t.tokenRaw);
}

/**
 * Windowed features per curve, PURE.
 *
 * `windowsSec` are measured back from `head` using `secPerBlock`; the tape is
 * assumed to reach at least as far as the longest window (the caller sized the
 * read). Holes make a window `incomplete` when they overlap it; the tally is
 * still returned because a floor is useful to a ranker and useless to a gate,
 * and this feeds the ranker.
 *
 * `allow` restricts emitters to curves from the factory-filtered launch set.
 * A curve not in it is dropped entirely — see the header on spoofing.
 */
export function windowFeatures(
  tape: TapeRead,
  args: {
    head: bigint;
    secPerBlock: number;
    windowsSec: readonly number[];
    allow: ReadonlySet<string>;
  },
): Map<string, CurveTrend> {
  const windows = [...args.windowsSec].sort((a, b) => a - b);
  const startBlockFor = (sec: number): bigint => {
    const blocks = BigInt(Math.max(1, Math.round(sec / Math.max(1e-9, args.secPerBlock))));
    return args.head > blocks ? args.head - blocks + 1n : 0n;
  };
  const starts = windows.map(startBlockFor);

  // Group by curve, oldest first. The tape comes back per chunk in block order
  // already, but a sort costs little and the first/last price depends on it.
  const byCurve = new Map<string, PonsTrade[]>();
  for (const t of tape.trades) {
    if (!args.allow.has(t.curve)) continue;
    const arr = byCurve.get(t.curve);
    if (arr) arr.push(t);
    else byCurve.set(t.curve, [t]);
  }

  const out = new Map<string, CurveTrend>();
  for (const [curve, trades] of byCurve) {
    trades.sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));
    const tallies: WindowTally[] = [];
    for (let i = 0; i < windows.length; i++) {
      const sec = windows[i]!;
      const start = starts[i]!;
      const seenBefore = new Set<string>();
      const inWindow = new Set<string>();
      let buys = 0;
      let sells = 0;
      let quoteIn = 0n;
      let quoteOut = 0n;
      let newTraders = 0;
      let first: number | null = null;
      let last: number | null = null;
      for (const t of trades) {
        if (t.block < start) {
          seenBefore.add(t.trader);
          continue;
        }
        if (t.side === "buy") {
          buys++;
          quoteIn += t.quoteRaw;
        } else {
          sells++;
          quoteOut += t.quoteRaw;
        }
        if (!inWindow.has(t.trader)) {
          inWindow.add(t.trader);
          if (!seenBefore.has(t.trader)) newTraders++;
        }
        const p = impliedPrice(t);
        if (p !== null) {
          if (first === null) first = p;
          last = p;
        }
      }
      const n = buys + sells;
      const volume = quoteIn + quoteOut;
      const minutes = sec / 60;
      const incomplete = tape.holes.some((h) => h.to >= start && h.from <= args.head);
      tallies.push({
        sec,
        trades: n,
        buys,
        sells,
        traders: inWindow.size,
        newTraders,
        quoteIn,
        quoteOut,
        volume,
        imbalanceCount: n === 0 ? null : (buys - sells) / n,
        imbalanceQuote: ratio(quoteIn - quoteOut, volume),
        tradesPerMin: n / minutes,
        quotePerMin: Number(volume) / minutes,
        firstPrice: first,
        lastPrice: last,
        momentum: first !== null && last !== null && first > 0 ? last / first - 1 : null,
        incomplete,
      });
    }
    const short = tallies[0]!;
    const long = tallies[tallies.length - 1]!;
    // A curve whose only trades predate the longest window is not part of
    // this hour. Emitting a row of zeros for it would put a dead curve in the
    // universe with a score of nothing — and a universe entry is a reserves
    // read someone pays for.
    if (long.trades === 0) continue;
    out.set(curve, {
      curve,
      windows: tallies,
      tradeAcceleration: long.tradesPerMin > 0 ? short.tradesPerMin / long.tradesPerMin : null,
      volumeAcceleration: long.quotePerMin > 0 ? short.quotePerMin / long.quotePerMin : null,
      netQuoteFlow: long.quoteIn - long.quoteOut,
      firstBlock: trades[0]!.block,
      lastBlock: trades[trades.length - 1]!.block,
    });
  }
  return out;
}

/**
 * ONE NUMBER FOR "IS THIS CURVE WAKING UP", profile-independent.
 *
 * This is the TRENDING UNIVERSE selector — it decides which curves are worth a
 * reserves read at all, before any agent's taste is consulted. It is
 * deliberately blunt: log-scaled activity so a 300-trade curve does not drown
 * everything, times an acceleration term so a curve whose last five minutes
 * beat its hour rises above one that is merely large, times a participation
 * term so one address looping cannot manufacture it. The per-agent ranker
 * (trading-profile.ts) is where preferences live; this is where the candidate
 * list comes from, and it is the same list for every agent by construction.
 */
export function trendingScore(t: CurveTrend): number {
  const short = t.windows[0]!;
  const mid = t.windows[Math.min(1, t.windows.length - 1)]!;
  const long = t.windows[t.windows.length - 1]!;
  const activity = Math.log10(1 + mid.trades) * 10;
  // ACCELERATION NEEDS A BASELINE. Two trades in the last five minutes on a
  // curve that has two trades all hour is a 12x "acceleration" on nothing —
  // measured on the live tape, that is exactly what a two-minute-old launch
  // with one wash round trip looks like. Below a floor of hourly trades the
  // ratio is carried as data but does not multiply the score.
  const accel =
    long.trades >= MIN_TRADES_FOR_ACCELERATION
      ? Math.min(4, Math.max(0.25, t.tradeAcceleration ?? 0.25))
      : 1;
  const crowd = Math.log10(1 + short.traders) * 5;
  const buyers = short.imbalanceCount === null ? 1 : 1 + Math.max(-0.5, short.imbalanceCount) * 0.5;
  return Math.round((activity * accel + crowd) * buyers * 100) / 100;
}

/** Hourly trades below which an acceleration ratio is noise, not a signal. */
export const MIN_TRADES_FOR_ACCELERATION = 12;
