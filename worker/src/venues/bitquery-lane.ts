/**
 * THE BITQUERY LANE — the fleet's one paid door to an indexer, held by the
 * orchestrator and by nothing else.
 *
 * WHY ONE PROCESS. The owner's plan is a monthly points allowance with a
 * per-minute and a concurrency ceiling, shared by everything that holds the
 * key. Handed to every child, it would be N pollers with N private ideas of
 * how much is left. Held here, there is one counter, one cooldown and one
 * cache, and a child that wants flow facts asks this process over IPC
 * (flow-broker.ts). The key is stripped from every child (CHILD_SECRET_STRIP),
 * and this module takes it as an argument: it never reads the environment, so
 * importing it into a child would hand that child nothing to spend.
 *
 * NAMED QUERIES ONLY. Callers pick a query from the catalogue below and pass a
 * token; the GraphQL text is fixed at module load and every variable is
 * built and clamped here. No caller can widen a window, raise a limit, or send
 * a query of its own — the gateway learned why (gateway/lib/core.mjs: "an open
 * GraphQL proxy is a blank cheque written against whoever runs it").
 *
 * BUDGETED BEFORE IT IS SPENT. Every request reserves its estimated points
 * against the day's allowance in SQLite BEFORE the network call, atomically, so
 * a crash between the two can overstate spend and never understate it. A
 * counter that cannot be read or written refuses the call: an uncountable
 * spend is not one this lane makes. Failed requests keep their reservation,
 * because a provider may bill a request that answered badly.
 *
 * DEGRADES TO A WORD, NEVER TO A STALL. Every path returns within the caller's
 * deadline with either an answer or one of the failure words in flow-facts.ts.
 * Nothing here throws at a caller, and nothing here can reach an order, a
 * grant, a cap or a guard: an indexer's count of trades is research.
 *
 * THE QUERY SHAPES, AND WHAT IS NOT YET PROVEN ABOUT THEM. Written from
 * Bitquery's documentation (docs.bitquery.io, Robinhood Chain and Trading API
 * pages, read 2026-10-12) and tested only against recorded-shape fixtures; this
 * module has never called the real API. Flow comes from the `Trading.Trades`
 * cube that Bitquery documents for Robinhood Chain (`NetworkBid
 * "bid:robinhood"`), whose `Side` is the trader's side of the base token —
 * "Buy" means the trader bought it — rather than from EVM `DEXTradeByTokens`,
 * whose `Side.Type` Bitquery's own example pages label in OPPOSITE directions.
 * A buy/sell inversion would silently invert the evidence, so the cube with one
 * documented reading of the word was chosen. Run each query in the Bitquery
 * IDE with the plan's key before enabling the lane (docs/bitquery-lane.md).
 *
 * DOLLARS FROM THE QUOTE LEG, COUNTS BY TRANSACTION. Bitquery's Trades API page
 * says `AmountsInUsd.Base` is the base amount times a SMOOTHED reference price,
 * not the executed one: about a quarter of rows diverge by more than 1%, with
 * outliers of orders of magnitude in sharp moves — which is a fresh memecoin's
 * whole first hour. It names `AmountsInUsd.Quote` the sound leg for volume, so
 * every sum and the largest-sells ordering here use it. The same page says one
 * transaction can produce several rows (and about 1% are exact duplicates of
 * one swap leg), so buys and sells are counted as distinct transaction hashes,
 * not rows, and the largest sells are de-duplicated before they are kept.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAddress } from "viem";
import { UNISWAP } from "../../../packages/core/src/index";
import { readBoundedJson } from "../bounded-read";
import {
  FLOW_LIMITS,
  FLOW_WINDOWS,
  flowNumber,
  flowSlug,
  type FlowFailure,
  type FlowSell,
  type FlowVenue,
  type FlowWindow,
} from "../flow-facts";
import { BITQUERY_DEFAULT_ENDPOINT, bitqueryAuthHeaders } from "./bitquery";

// ── knobs ───────────────────────────────────────────────────────────────────

export const BITQUERY_LANE_DEFAULTS = Object.freeze({
  /**
   * Points per UTC day. 25,000 x 30 = 750,000 a month. THE GATEWAY MAY SPEND
   * FROM THE SAME PLAN under its own, separate fleet-wide counter
   * (MERRYMEN_GATEWAY_BITQUERY_POINTS_PER_DAY, default 12,500 a day in
   * gateway/lib/core.mjs: 10,000 for the public memescope at its 45 s
   * refresh, 2,500 for holders). Neither counter sees the other's spend, so
   * the operator sizes both to the plan, leaving room for the estimates below
   * to be wrong.
   */
  pointsPerDay: 25_000,
  /** Requests started per rolling minute. The plan allows 90. */
  rpm: 60,
  /** Requests open at once. The plan allows 6; half is left for the gateway and the IDE. */
  maxConcurrency: 3,
  /** One HTTP request's own bound. */
  requestTimeoutMs: 12_000,
  /** How long a caller waits for a slot or a turn before the lane says so. */
  waitMs: 8_000,
  /**
   * NO REQUEST IS SENT WITH LESS THAN THIS LEFT. A turn that arrives with a
   * second to spare would reserve the points, take a rate start and send a
   * request that almost certainly times out — and may still be billed. Past
   * this line the caller is answered "timeout" with nothing reserved or sent.
   */
  minRequestMs: 3_000,
  /** A failed key is not asked again for this long (cooldowns aside). */
  failureTtlMs: 15_000,
  /**
   * Requests made as decision EVIDENCE for a child stop at this share of the
   * day's points, so a busy review can never starve the orchestrator's own
   * answers of the rest. Counted on evidence's own spend, not the day's: what
   * answers spend never comes out of it (orchestrator-flow.ts
   * answerReadingsPerDay keeps answers inside the rest).
   */
  evidenceShare: 0.8,
});

/** Above these a knob is clamped, and the boot line says so. */
export const BITQUERY_LANE_CEILINGS = Object.freeze({ pointsPerDay: 100_000, rpm: 90 });

export interface BitqueryLaneConfig {
  apiKey: string;
  pointsPerDay: number;
  rpm: number;
}

export interface BitqueryLaneSetup {
  off: boolean;
  /** Said once at boot. Never contains the key, or any value that could be one. */
  lines: string[];
  config: BitqueryLaneConfig | null;
}

function knob(raw: string | undefined, name: string, fallback: number, ceiling: number, lines: string[]): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const s = raw.trim();
  if (!/^\d+$/.test(s) || Number(s) < 1) {
    // Described by its length, never echoed: a key pasted into the wrong
    // variable must not reach the log through this line.
    lines.push(`bitquery lane: ${name} is not a positive whole number (${s.length} characters); ${fallback} applies`);
    return fallback;
  }
  const n = Number(s);
  if (n > ceiling) {
    lines.push(`bitquery lane: ${name}=${n} is above the ceiling of ${ceiling}; ${ceiling} applies`);
    return ceiling;
  }
  return n;
}

/**
 * The lane's switches, read once on the orchestrator. ON ONLY WITH A KEY: no
 * MERRYMEN_BITQUERY_API_KEY means no lane, no SQLite file, no request, and
 * every flow question answers "unavailable". MERRYMEN_BITQUERY_LANE=0 turns it
 * off with the key still set — the way to stop spending without a redeploy of
 * secrets.
 */
export function bitqueryLaneSetup(env: Record<string, string | undefined>): BitqueryLaneSetup {
  if (env.MERRYMEN_BITQUERY_LANE?.trim() === "0") {
    return { off: true, lines: ["bitquery lane: off — MERRYMEN_BITQUERY_LANE=0"], config: null };
  }
  const apiKey = env.MERRYMEN_BITQUERY_API_KEY?.trim();
  if (!apiKey) {
    return { off: true, lines: ["bitquery lane: off — no MERRYMEN_BITQUERY_API_KEY on this process (set it on the orchestrator only)"], config: null };
  }
  const lines: string[] = [];
  const pointsPerDay = knob(env.MERRYMEN_BITQUERY_POINTS_PER_DAY, "MERRYMEN_BITQUERY_POINTS_PER_DAY", BITQUERY_LANE_DEFAULTS.pointsPerDay, BITQUERY_LANE_CEILINGS.pointsPerDay, lines);
  const rpm = knob(env.MERRYMEN_BITQUERY_RPM, "MERRYMEN_BITQUERY_RPM", BITQUERY_LANE_DEFAULTS.rpm, BITQUERY_LANE_CEILINGS.rpm, lines);
  lines.unshift(
    `bitquery lane: on — ${pointsPerDay} points/UTC day (${Math.floor(pointsPerDay * BITQUERY_LANE_DEFAULTS.evidenceShare)} for child evidence), ` +
      `${rpm} requests/min, ${BITQUERY_LANE_DEFAULTS.maxConcurrency} at once`,
  );
  return { off: false, lines, config: { apiKey, pointsPerDay, rpm } };
}

// ── the catalogue ───────────────────────────────────────────────────────────

const ROBINHOOD_BID = "bid:robinhood";

/**
 * Aggregates for one window, as GraphQL. Built from FLOW_WINDOWS at module
 * load: the text is a constant, and only the time variables change per call.
 */
function windowAggregates(m: number): string {
  const side = (s: "Buy" | "Sell") => `{Side: {is: "${s}"}, Block: {Time: {since: $t${m}}}}`;
  return [
    `buys${m}: count(distinct: TransactionHeader_Hash, if: ${side("Buy")})`,
    `sells${m}: count(distinct: TransactionHeader_Hash, if: ${side("Sell")})`,
    `buyUsd${m}: sum(of: AmountsInUsd_Quote, if: ${side("Buy")})`,
    `sellUsd${m}: sum(of: AmountsInUsd_Quote, if: ${side("Sell")})`,
    `buyers${m}: count(distinct: Trader_Address, if: ${side("Buy")})`,
    `sellers${m}: count(distinct: Trader_Address, if: ${side("Sell")})`,
  ].join("\n      ");
}

const TOKEN_WHERE = `Pair: {Market: {NetworkBid: {is: "${ROBINHOOD_BID}"}}, Token: {Address: {in: $tokens}}}, Block: {Time: {since: $t60}}`;

/**
 * Three cubes in one request: per-window totals, the venue split over the
 * hour, and the largest single sells. No trader address is selected anywhere
 * in it: the reading is about the coin, and a wallet list is not a fact this
 * lane hands out. The largest sells select their transaction hash for one
 * purpose — dropping a duplicated swap leg (parseTokenFlow) — and the hash
 * goes no further than the parser.
 */
export const TOKEN_FLOW_QUERY = `query MerrymenTokenFlow($tokens: [String!], ${FLOW_WINDOWS.map((m) => `$t${m}: DateTime`).join(", ")}, $sellLimit: Int, $venueLimit: Int) {
  Trading {
    totals: Trades(where: {${TOKEN_WHERE}}) {
      ${FLOW_WINDOWS.map(windowAggregates).join("\n      ")}
    }
    venues: Trades(
      where: {${TOKEN_WHERE}}
      orderBy: {descendingByField: "trades"}
      limit: {count: $venueLimit}
    ) {
      Pair { Market { Protocol ProtocolFamily } }
      trades: count(distinct: TransactionHeader_Hash)
      buys: count(distinct: TransactionHeader_Hash, if: {Side: {is: "Buy"}})
      sells: count(distinct: TransactionHeader_Hash, if: {Side: {is: "Sell"}})
      buyUsd: sum(of: AmountsInUsd_Quote, if: {Side: {is: "Buy"}})
      sellUsd: sum(of: AmountsInUsd_Quote, if: {Side: {is: "Sell"}})
    }
    bigSells: Trades(
      where: {${TOKEN_WHERE}, Side: {is: "Sell"}}
      orderBy: {descending: AmountsInUsd_Quote}
      limit: {count: $sellLimit}
    ) {
      Block { Time }
      TransactionHeader { Hash }
      AmountsInUsd { Quote }
      Pair { Market { Protocol } }
    }
  }
}`;

/**
 * Did the launcher's address sell, or move tokens out at all? Two cubes: DEX
 * sells by that address, and every token transfer out of it (which also
 * catches a launcher who moves supply to a fresh wallet and sells from there).
 * The address is resolved by the ORCHESTRATOR from the launchpad factory's own
 * launch event, never supplied by a child and never taken from the token's
 * word about itself (orchestrator-flow.ts).
 */
export const CREATOR_FLOW_QUERY = `query MerrymenCreatorFlow($tokens: [String!], $creators: [String!], $since: DateTime) {
  Trading {
    creatorSells: Trades(
      where: {Pair: {Market: {NetworkBid: {is: "${ROBINHOOD_BID}"}}, Token: {Address: {in: $tokens}}}, Trader: {Address: {in: $creators}}, Side: {is: "Sell"}, Block: {Time: {since: $since}}}
    ) {
      sells: count(distinct: TransactionHeader_Hash)
      sellUsd: sum(of: AmountsInUsd_Quote)
    }
  }
  EVM(network: robinhood) {
    creatorOut: Transfers(
      where: {Transfer: {Currency: {SmartContract: {in: $tokens}}, Sender: {in: $creators}}, Block: {Time: {since: $since}}}
    ) {
      transfers: count
      usd: sum(of: Transfer_AmountInUSD)
    }
  }
}`;

/**
 * Uniswap v3 pools created for a token, from the factory's own PoolCreated
 * events — the factory pinned in the query AND checked again on the way out,
 * so a look-alike event from any other contract is not a pool. Realtime events
 * are kept for hours, not weeks: this is a source for an EARLY book, not a
 * directory. A pool here is a candidate to verify on chain (factory getPool),
 * never a route by itself.
 */
export const V3_POOLS_QUERY = `query MerrymenV3Pools($factory: [String!], $tokens: [String!], $since: DateTime, $limit: Int) {
  EVM(network: robinhood) {
    Events(
      limit: {count: $limit}
      orderBy: {descending: Block_Time}
      where: {
        LogHeader: {Address: {in: $factory}}
        Log: {Signature: {Name: {is: "PoolCreated"}}}
        Block: {Time: {since: $since}}
        any: [
          {Arguments: {includes: {Name: {is: "token0"}, Value: {Address: {in: $tokens}}}}}
          {Arguments: {includes: {Name: {is: "token1"}, Value: {Address: {in: $tokens}}}}}
        ]
      }
    ) {
      Block { Time }
      Transaction { Hash }
      LogHeader { Address }
      Arguments {
        Name
        Value {
          ... on EVM_ABI_Address_Value_Arg { address }
          ... on EVM_ABI_Integer_Value_Arg { integer }
          ... on EVM_ABI_BigInt_Value_Arg { bigInteger }
        }
      }
    }
  }
}`;

export type LaneQueryName = "tokenFlow" | "creatorFlow" | "v3Pools";

/**
 * Points each named query is reserved at. Bitquery documents a flat 5 points
 * per cube on the realtime dataset, whatever the record count; the Trading
 * cube's price is not documented, so it is assumed the same. Reconcile against
 * the plan's usage page after the first day (docs/bitquery-lane.md) — the
 * daily default leaves a third of the plan as headroom for exactly this.
 */
export const LANE_POINTS: Readonly<Record<LaneQueryName, number>> = Object.freeze({ tokenFlow: 15, creatorFlow: 10, v3Pools: 5 });

/** How long one answer is served from the fleet cache. */
export const LANE_TTL_MS: Readonly<Record<LaneQueryName, number>> = Object.freeze({ tokenFlow: 60_000, creatorFlow: 120_000, v3Pools: 300_000 });

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** A lowercase address, or null. Zero is not a token. */
function addressOf(v: unknown): `0x${string}` | null {
  if (typeof v !== "string" || !ADDRESS.test(v) || /^0x0{40}$/i.test(v)) return null;
  return v.toLowerCase() as `0x${string}`;
}

/**
 * BOTH SPELLINGS. Which case an index stores an address in is a detail no
 * page documents for this cube, and the failure is silent: a lowercase `is`
 * against checksummed rows matches nothing, which reads as "no trades".
 * `in` with both costs nothing and removes the question.
 */
function spellings(a: `0x${string}`): string[] {
  return [...new Set([a, getAddress(a)])];
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback;
  return Math.min(max, Math.max(min, n));
}

const iso = (ms: number): string => new Date(ms).toISOString();

export interface TokenFlowInput { token: string; sellLimit?: number }
export interface CreatorFlowInput { token: string; creator: string; windowMin?: number }
export interface V3PoolsInput { token: string; sinceHours?: number; limit?: number }

type LaneInput = { tokenFlow: TokenFlowInput; creatorFlow: CreatorFlowInput; v3Pools: V3PoolsInput };

/** The logical, clamped request: what the cache is keyed on (no clock in it). */
type Clamped =
  | { name: "tokenFlow"; token: `0x${string}`; sellLimit: number }
  | { name: "creatorFlow"; token: `0x${string}`; creator: `0x${string}`; windowMin: number }
  | { name: "v3Pools"; token: `0x${string}`; sinceHours: number; limit: number };

/** Validate and clamp a caller's input, or null when it does not name a token. Exported for tests. */
export function clampLaneInput<N extends LaneQueryName>(name: N, input: LaneInput[N]): Clamped | null {
  const token = addressOf(input?.token);
  if (!token) return null;
  switch (name) {
    case "tokenFlow":
      return { name, token, sellLimit: clampInt((input as TokenFlowInput).sellLimit, 1, FLOW_LIMITS.largestSells, 5) };
    case "creatorFlow": {
      const creator = addressOf((input as CreatorFlowInput).creator);
      if (!creator || creator === token) return null;
      return { name, token, creator, windowMin: clampInt((input as CreatorFlowInput).windowMin, 5, 240, 60) };
    }
    case "v3Pools":
      return { name, token, sinceHours: clampInt((input as V3PoolsInput).sinceHours, 1, 24, 24), limit: clampInt((input as V3PoolsInput).limit, 1, 20, 10) };
  }
  return null;
}

/** The GraphQL request for a clamped input at `now`. Exported for tests. */
export function buildLaneRequest(c: Clamped, now: number): { query: string; variables: Record<string, unknown> } {
  switch (c.name) {
    case "tokenFlow": {
      // TWICE THE ROWS KEPT: a duplicated swap leg must not cost a slot in the
      // list (parseTokenFlow drops it). The cube's price does not depend on it.
      const variables: Record<string, unknown> = { tokens: spellings(c.token), sellLimit: 2 * c.sellLimit, venueLimit: FLOW_LIMITS.venues };
      for (const m of FLOW_WINDOWS) variables[`t${m}`] = iso(now - m * 60_000);
      return { query: TOKEN_FLOW_QUERY, variables };
    }
    case "creatorFlow":
      return { query: CREATOR_FLOW_QUERY, variables: { tokens: spellings(c.token), creators: spellings(c.creator), since: iso(now - c.windowMin * 60_000) } };
    case "v3Pools":
      return { query: V3_POOLS_QUERY, variables: { factory: spellings(UNISWAP.v3Factory as `0x${string}`), tokens: spellings(c.token), since: iso(now - c.sinceHours * 3_600_000), limit: c.limit } };
  }
}

// ── parsing (third-party JSON on its way to a trading agent) ───────────────

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);
const at = (v: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((o, k) => (isRec(o) ? o[k] : undefined), v);

/** An aggregate-only cube's one row; an EMPTY list is the index saying "no rows", read as zeros. */
function aggregateRow(v: unknown): Rec | "none" | null {
  if (!Array.isArray(v)) return null;
  if (v.length === 0) return "none";
  return isRec(v[0]) ? v[0] : null;
}

const countOf = (row: Rec | "none", k: string): number | null => (row === "none" ? 0 : flowNumber(row[k], true));
const usdOf = (row: Rec | "none", k: string): number | null => (row === "none" ? 0 : flowNumber(row[k]));

export interface TokenFlowRead {
  windows: FlowWindow[];
  venues: FlowVenue[];
  largestSells: FlowSell[];
}

/**
 * The flow query's data → windows, venues and sells, or null when the shape is
 * not the one asked for. A MISSING aggregate is null (unknown), never zero; an
 * empty aggregate list is the index answering "none", which is zero.
 */
export function parseTokenFlow(data: unknown, sellLimit = 5): TokenFlowRead | null {
  const trading = at(data, "Trading");
  if (!isRec(trading)) return null;
  const totals = aggregateRow(trading.totals);
  if (totals === null || !Array.isArray(trading.venues) || !Array.isArray(trading.bigSells)) return null;
  const windows: FlowWindow[] = FLOW_WINDOWS.map((m) => ({
    minutes: m,
    buyUsd: usdOf(totals, `buyUsd${m}`),
    sellUsd: usdOf(totals, `sellUsd${m}`),
    buys: countOf(totals, `buys${m}`),
    sells: countOf(totals, `sells${m}`),
    buyers: countOf(totals, `buyers${m}`),
    sellers: countOf(totals, `sellers${m}`),
  }));
  const venues: FlowVenue[] = [];
  for (const v of trading.venues.slice(0, FLOW_LIMITS.venues)) {
    if (!isRec(v)) continue;
    const protocol = flowSlug(at(v, "Pair", "Market", "Protocol"));
    if (!protocol) continue;
    venues.push({
      protocol,
      family: flowSlug(at(v, "Pair", "Market", "ProtocolFamily")),
      buyUsd: flowNumber(v.buyUsd),
      sellUsd: flowNumber(v.sellUsd),
      buys: flowNumber(v.buys, true),
      sells: flowNumber(v.sells, true),
    });
  }
  const largestSells: FlowSell[] = [];
  // ONE SWAP LEG, ONE ENTRY. The indexer can return the same leg twice; the
  // pair (transaction, quote-side dollars) names a leg, and a second sighting
  // of it is dropped rather than ranked as another big sell. A row with no
  // hash is still kept: it is unconfirmed as a duplicate, not confirmed as one.
  const legs = new Set<string>();
  for (const s of trading.bigSells) {
    const usd = flowNumber(at(s, "AmountsInUsd", "Quote"));
    const time = at(s, "Block", "Time");
    const sec = typeof time === "string" ? Math.floor(Date.parse(time) / 1000) : NaN;
    if (usd === null || !Number.isSafeInteger(sec) || sec <= 0) continue;
    const hash = at(s, "TransactionHeader", "Hash");
    if (typeof hash === "string" && hash !== "") {
      const leg = `${hash.toLowerCase()}|${usd}`;
      if (legs.has(leg)) continue;
      legs.add(leg);
    }
    // The hash stops here: a FlowSell is a size, a time and a venue.
    largestSells.push({ usd, at: sec, protocol: flowSlug(at(s, "Pair", "Market", "Protocol")) });
  }
  largestSells.sort((a, b) => b.usd - a.usd);
  return { windows, venues, largestSells: largestSells.slice(0, Math.min(sellLimit, FLOW_LIMITS.largestSells)) };
}

export interface CreatorFlowRead {
  sells: number | null;
  sellUsd: number | null;
  transfersOut: number | null;
  transferOutUsd: number | null;
}

/** The creator query's data, or null when either half is missing its list. */
export function parseCreatorFlow(data: unknown): CreatorFlowRead | null {
  const sells = aggregateRow(at(data, "Trading", "creatorSells"));
  const out = aggregateRow(at(data, "EVM", "creatorOut"));
  if (sells === null || out === null) return null;
  return {
    sells: countOf(sells, "sells"),
    sellUsd: usdOf(sells, "sellUsd"),
    transfersOut: countOf(out, "transfers"),
    transferOutUsd: usdOf(out, "usd"),
  };
}

export interface V3PoolCandidate {
  pool: `0x${string}`;
  token0: `0x${string}`;
  token1: `0x${string}`;
  fee: number;
  tickSpacing: number | null;
  /** Unix seconds. */
  createdAt: number;
}

/**
 * PoolCreated events → candidates that name `token` on one side, came from the
 * pinned factory, and carry a pool address and a fee in range. Anything else
 * is dropped, never repaired.
 */
export function parseV3Pools(data: unknown, token: string): V3PoolCandidate[] | null {
  const events = at(data, "EVM", "Events");
  if (!Array.isArray(events)) return null;
  const want = token.toLowerCase();
  const factory = UNISWAP.v3Factory.toLowerCase();
  const out: V3PoolCandidate[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    if (!isRec(ev)) continue;
    const emitter = at(ev, "LogHeader", "Address");
    if (emitter !== undefined && (typeof emitter !== "string" || emitter.toLowerCase() !== factory)) continue;
    const args = new Map<string, Rec>();
    for (const a of Array.isArray(ev.Arguments) ? ev.Arguments : []) {
      if (isRec(a) && typeof a.Name === "string" && isRec(a.Value)) args.set(a.Name, a.Value);
    }
    const token0 = addressOf(args.get("token0")?.address);
    const token1 = addressOf(args.get("token1")?.address);
    const pool = addressOf(args.get("pool")?.address);
    const feeRaw = args.get("fee");
    const fee = Number(feeRaw?.integer ?? feeRaw?.bigInteger);
    const tsRaw = args.get("tickSpacing");
    const tick = tsRaw ? Number(tsRaw.integer ?? tsRaw.bigInteger) : NaN;
    const time = at(ev, "Block", "Time");
    const createdAt = typeof time === "string" ? Math.floor(Date.parse(time) / 1000) : NaN;
    if (!token0 || !token1 || !pool || token0 === token1 || (token0 !== want && token1 !== want)) continue;
    if (!Number.isSafeInteger(fee) || fee <= 0 || fee >= 1_000_000 || !Number.isSafeInteger(createdAt) || createdAt <= 0) continue;
    if (seen.has(pool)) continue;
    seen.add(pool);
    out.push({ pool, token0, token1, fee, tickSpacing: Number.isSafeInteger(tick) && Math.abs(tick) < 2 ** 23 ? tick : null, createdAt });
  }
  return out;
}

function parseFor(c: Clamped, data: unknown): unknown {
  switch (c.name) {
    case "tokenFlow":
      return parseTokenFlow(data, c.sellLimit);
    case "creatorFlow":
      return parseCreatorFlow(data);
    case "v3Pools":
      return parseV3Pools(data, c.token);
  }
}

// ── the lane ────────────────────────────────────────────────────────────────

export interface LaneClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const REAL_CLOCK: LaneClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export type LaneAnswer<T> = { ok: true; data: T; observedAt: number; servedFrom: "live" | "cache" } | { ok: false; failure: FlowFailure };

/** Who the answer is for: the orchestrator's own answers, or a child's decision evidence. */
export type LanePurpose = "answer" | "evidence";

export interface LaneCallOptions {
  purpose?: LanePurpose;
  /**
   * Absolute ms by which the caller needs an answer. Clamped to waitMs +
   * requestTimeoutMs from now. Less than minRequestMs away and nothing is
   * asked: the answer is "timeout", with nothing reserved or sent.
   */
  deadline?: number;
}

export interface BitqueryLaneOptions {
  /** Directory under the fleet home that holds the lane's SQLite file. */
  dir: string;
  config: BitqueryLaneConfig;
  fetch?: typeof fetch;
  clock?: LaneClock;
  log?: (line: string) => void;
  requestTimeoutMs?: number;
  waitMs?: number;
  maxConcurrency?: number;
}

/** "2026-10-12" — the budget's day is UTC, like the provider's own usage page. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Never an address or a key-shaped run in a log line. */
function scrub(text: string): string {
  return text
    .replace(/0x[0-9a-fA-F]{40}/g, "0x…")
    .replace(/\b(?:ory_at_|BQY)[A-Za-z0-9._-]*/g, "***")
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

function retryAfterMs(res: Response, now: number): number {
  const raw = res.headers.get("retry-after");
  if (!raw) return 0;
  const secs = Number(raw);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(raw) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 3_600_000) : 0;
}

export class BitqueryLane {
  private readonly db: DatabaseSync;
  private readonly clock: LaneClock;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;
  private readonly requestTimeoutMs: number;
  private readonly waitMs: number;
  /** Never above the request's own bound, so a lane built with a short one can still ask. */
  private readonly minRequestMs: number;
  private readonly maxConcurrency: number;
  private inFlight = 0;
  private starts: number[] = [];
  private readonly pending = new Map<string, Promise<LaneAnswer<unknown>>>();
  private readonly failed = new Map<string, { failure: FlowFailure; until: number }>();
  /** Credential refusals cool in memory only: a fixed key arrives by redeploy, and must not wait out an old one. */
  private authCooldownUntil = 0;
  private writes = 0;
  private readonly said = new Set<string>();
  private closed = false;

  constructor(private readonly o: BitqueryLaneOptions) {
    this.clock = o.clock ?? REAL_CLOCK;
    this.fetchImpl = o.fetch ?? fetch;
    this.log = o.log ?? (() => {});
    this.requestTimeoutMs = o.requestTimeoutMs ?? BITQUERY_LANE_DEFAULTS.requestTimeoutMs;
    this.waitMs = o.waitMs ?? BITQUERY_LANE_DEFAULTS.waitMs;
    this.minRequestMs = Math.min(BITQUERY_LANE_DEFAULTS.minRequestMs, this.requestTimeoutMs);
    this.maxConcurrency = Math.max(1, Math.min(BITQUERY_LANE_DEFAULTS.maxConcurrency, o.maxConcurrency ?? BITQUERY_LANE_DEFAULTS.maxConcurrency));
    mkdirSync(o.dir, { recursive: true });
    this.db = new DatabaseSync(path.join(o.dir, "lane.sqlite"));
    this.db.exec(`PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS answers (key TEXT PRIMARY KEY, payload TEXT NOT NULL, observed_at REAL NOT NULL, expires REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS spend (day TEXT PRIMARY KEY, points INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, refused INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS cooldown (id INTEGER PRIMARY KEY CHECK (id = 1), until_ms REAL NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO cooldown(id, until_ms, failures) VALUES (1, 0, 0);`);
    this.ensureEvidenceColumn();
  }

  /**
   * EVIDENCE'S OWN SPEND, beside the day's (`spend.evidence_points`). A lane
   * file from before it counts all of each day it kept as evidence: that
   * overstates evidence's spend for the rest of today, never understates it.
   */
  private ensureEvidenceColumn(): void {
    const has = () => (this.db.prepare("PRAGMA table_info(spend)").all() as { name: string }[]).some((c) => c.name === "evidence_points");
    if (has()) return;
    try {
      this.db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE spend ADD COLUMN evidence_points INTEGER NOT NULL DEFAULT 0;
        UPDATE spend SET evidence_points = points;
        COMMIT;`);
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Nothing was open to roll back.
      }
      // Another lane on the same directory added it first.
      if (!has()) throw e;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
      // Already closed or never opened; nothing to give back.
    }
  }

  tokenFlow(token: string, opts?: LaneCallOptions & { sellLimit?: number }): Promise<LaneAnswer<TokenFlowRead>> {
    return this.run("tokenFlow", { token, sellLimit: opts?.sellLimit }, opts) as Promise<LaneAnswer<TokenFlowRead>>;
  }

  creatorFlow(token: string, creator: string, opts?: LaneCallOptions & { windowMin?: number }): Promise<LaneAnswer<CreatorFlowRead>> {
    return this.run("creatorFlow", { token, creator, windowMin: opts?.windowMin }, opts) as Promise<LaneAnswer<CreatorFlowRead>>;
  }

  v3Pools(token: string, opts?: LaneCallOptions & { sinceHours?: number; limit?: number }): Promise<LaneAnswer<V3PoolCandidate[]>> {
    return this.run("v3Pools", { token, sinceHours: opts?.sinceHours, limit: opts?.limit }, opts) as Promise<LaneAnswer<V3PoolCandidate[]>>;
  }

  /** Today's spend, for a status line. Null when the counter cannot be read. */
  spentToday(): { day: string; points: number; calls: number; refused: number } | null {
    try {
      const day = utcDay(this.clock.now());
      const row = this.db.prepare("SELECT points, calls, refused FROM spend WHERE day = ?").get(day) as { points: number; calls: number; refused: number } | undefined;
      return { day, points: row?.points ?? 0, calls: row?.calls ?? 0, refused: row?.refused ?? 0 };
    } catch {
      return null;
    }
  }

  private sayOnce(key: string, line: string): void {
    if (this.said.has(key) || this.said.size > 64) return;
    this.said.add(key);
    this.log(`bitquery lane: ${line}`);
  }

  private async run<N extends LaneQueryName>(name: N, input: LaneInput[N], opts: LaneCallOptions = {}): Promise<LaneAnswer<unknown>> {
    if (this.closed) return { ok: false, failure: "unavailable" };
    const c = clampLaneInput(name, input);
    if (!c) return { ok: false, failure: "invalid-request" };
    const key = JSON.stringify(c);
    const purpose: LanePurpose = opts.purpose ?? "answer";
    const now = this.clock.now();
    const deadline = Math.min(opts.deadline ?? Number.POSITIVE_INFINITY, now + this.waitMs + this.requestTimeoutMs);

    const cached = this.cached(key, now);
    if (cached) return cached;
    // SHARED BY PURPOSE, ONE WAY. Evidence may join an answer's request: it
    // spends nothing extra, and an answer's refusal is one evidence would have
    // had too. An answer never joins evidence's: evidence stops at its share of
    // the day, and a "budget" earned there must not become the orchestrator's
    // own answer while the rest of the day is still unspent.
    const shared = this.pending.get(`answer|${key}`) ?? (purpose === "evidence" ? this.pending.get(`evidence|${key}`) : undefined);
    if (shared) return shared;
    const recent = this.failed.get(key);
    if (recent && recent.until > now) return { ok: false, failure: recent.failure };
    // TWO BOUNDS, KEPT APART. A turn is waited for at most waitMs, and only
    // while a request could still get minRequestMs of the caller's deadline.
    const turnBy = Math.min(now + this.waitMs, deadline - this.minRequestMs);
    if (turnBy < now) return { ok: false, failure: "timeout" };

    const pendingKey = `${purpose}|${key}`;
    const p = this.live(c, key, purpose, turnBy, deadline).finally(() => this.pending.delete(pendingKey));
    this.pending.set(pendingKey, p);
    return p;
  }

  private cached(key: string, now: number): LaneAnswer<unknown> | null {
    try {
      const row = this.db.prepare("SELECT payload, observed_at, expires FROM answers WHERE key = ?").get(key) as { payload: string; observed_at: number; expires: number } | undefined;
      if (!row || row.expires <= now) return null;
      return { ok: true, data: JSON.parse(row.payload) as unknown, observedAt: row.observed_at, servedFrom: "cache" };
    } catch {
      // An unreadable cache row is a miss; the budget below still decides whether to ask.
      return null;
    }
  }

  private coolingUntil(): number | null {
    try {
      const row = this.db.prepare("SELECT until_ms FROM cooldown WHERE id = 1").get() as { until_ms: number } | undefined;
      return Math.max(row?.until_ms ?? 0, this.authCooldownUntil);
    } catch {
      return null;
    }
  }

  /**
   * Wait for a concurrency slot and a rate turn until `turnBy`, or say which
   * one ran out. `turnBy` is the earlier of waitMs from the call and the last
   * moment a request still gets minRequestMs (run()), so a turn that arrives
   * later is refused here — before a rate start is taken or a point reserved.
   */
  private async takeTurn(turnBy: number): Promise<FlowFailure | null> {
    for (;;) {
      const now = this.clock.now();
      while (this.starts.length > 0 && now - this.starts[0]! >= 60_000) this.starts.shift();
      const rateOk = this.starts.length < this.o.config.rpm;
      const slotOk = this.inFlight < this.maxConcurrency;
      if (now > turnBy) return rateOk ? "timeout" : "budget";
      if (rateOk && slotOk) {
        this.inFlight++;
        this.starts.push(now);
        return null;
      }
      const wait = rateOk ? 50 : this.starts[0]! + 60_000 - now;
      await this.clock.sleep(Math.max(1, Math.min(wait, turnBy - now, 250)));
    }
  }

  /**
   * Reserve the query's points against today, atomically, or refuse. False on
   * a full day; null when the counter itself could not be used — and an
   * uncountable spend is refused too.
   *
   * EVIDENCE IS WEIGHED ON ITS OWN SPEND. Evidence fits when what evidence
   * spent today stays inside its share AND the day's total inside the day;
   * an answer only the second. So points answers spend never count toward
   * evidence's share: answers first, then evidence, and evidence still gets
   * its whole share as long as answers kept to the rest.
   */
  private reserve(points: number, purpose: LanePurpose): boolean | null {
    const dayCap = this.o.config.pointsPerDay;
    const share = Math.floor(dayCap * BITQUERY_LANE_DEFAULTS.evidenceShare);
    try {
      const day = utcDay(this.clock.now());
      this.db.prepare("INSERT OR IGNORE INTO spend(day, points, calls, refused) VALUES (?, 0, 0, 0)").run(day);
      const r = purpose === "evidence"
        ? this.db.prepare(`UPDATE spend SET points = points + ?, evidence_points = evidence_points + ?, calls = calls + 1
            WHERE day = ? AND evidence_points + ? <= ? AND points + ? <= ?`).run(points, points, day, points, share, points, dayCap)
        : this.db.prepare("UPDATE spend SET points = points + ?, calls = calls + 1 WHERE day = ? AND points + ? <= ?").run(points, day, points, dayCap);
      if (Number(r.changes) > 0) return true;
      this.db.prepare("UPDATE spend SET refused = refused + 1 WHERE day = ?").run(day);
      this.sayOnce(`budget:${day}:${purpose}`, purpose === "evidence"
        ? `the day's evidence share (${share}) or points (${dayCap}) are spent; answering evidence "budget" until ${day} ends (UTC)`
        : `the day's points (${dayCap}) are spent; answering "budget" until ${day} ends (UTC)`);
      return false;
    } catch {
      this.sayOnce("counter", "the points counter could not be used; refusing to spend what it cannot count");
      return null;
    }
  }

  private noteFailure(key: string, failure: FlowFailure): void {
    if (this.failed.size >= 512) this.failed.delete(this.failed.keys().next().value!);
    this.failed.set(key, { failure, until: this.clock.now() + BITQUERY_LANE_DEFAULTS.failureTtlMs });
  }

  private coolDown(status: number, res: Response): void {
    const now = this.clock.now();
    try {
      if (status === 429) {
        const row = this.db.prepare("UPDATE cooldown SET failures = MIN(failures + 1, 5) WHERE id = 1 RETURNING failures").get() as { failures: number };
        const backoff = Math.min(900_000, 60_000 * 2 ** Math.max(0, row.failures - 1));
        this.db.prepare("UPDATE cooldown SET until_ms = MAX(until_ms, ?) WHERE id = 1").run(now + Math.max(backoff, retryAfterMs(res, now)));
      } else if (status === 402) {
        // The plan's points are gone on the provider's side. Asking again in a
        // minute buys nothing but another refusal.
        this.db.prepare("UPDATE cooldown SET until_ms = MAX(until_ms, ?) WHERE id = 1").run(now + 3_600_000);
      }
    } catch {
      // The counter is unwritable: hold off in memory instead, for the same span.
      this.authCooldownUntil = Math.max(this.authCooldownUntil, now + 60_000);
    }
    if (status === 401 || status === 403) this.authCooldownUntil = Math.max(this.authCooldownUntil, now + 900_000);
    this.sayOnce(`http-${status}`, `the provider answered ${status}${status === 401 || status === 403 ? " — check MERRYMEN_BITQUERY_API_KEY" : status === 402 ? " — the plan's points look spent" : ""}; holding off`);
  }

  private store(key: string, data: unknown, observedAt: number, ttlMs: number): void {
    try {
      this.db.prepare("INSERT INTO answers(key, payload, observed_at, expires) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, observed_at = excluded.observed_at, expires = excluded.expires")
        .run(key, JSON.stringify(data), observedAt, observedAt + ttlMs);
      if (++this.writes % 50 === 0) {
        const now = this.clock.now();
        this.db.prepare("DELETE FROM answers WHERE expires < ?").run(now - 3_600_000);
        this.db.prepare("DELETE FROM spend WHERE day < ?").run(utcDay(now - 40 * 86_400_000));
      }
    } catch {
      // A cache that cannot be written costs a repeat request, which the budget still bounds.
    }
  }

  private async live(c: Clamped, key: string, purpose: LanePurpose, turnBy: number, deadline: number): Promise<LaneAnswer<unknown>> {
    const cooling = this.coolingUntil();
    if (cooling === null) return { ok: false, failure: "unavailable" };
    if (cooling > this.clock.now()) return { ok: false, failure: "provider-cooldown" };
    const turn = await this.takeTurn(turnBy);
    if (turn) return { ok: false, failure: turn };
    try {
      // Another request may have been refused while this one waited its turn.
      const after = this.coolingUntil();
      if (after === null) return { ok: false, failure: "unavailable" };
      if (after > this.clock.now()) return { ok: false, failure: "provider-cooldown" };
      // Checked again where it is spent: nothing is reserved for a request
      // that could not be given its floor.
      const observedAt = this.clock.now();
      if (deadline - observedAt < this.minRequestMs) return { ok: false, failure: "timeout" };
      const reserved = this.reserve(LANE_POINTS[c.name], purpose);
      if (reserved === null) return { ok: false, failure: "unavailable" };
      if (!reserved) return { ok: false, failure: "budget" };
      const out = await this.request(c, observedAt, Math.min(this.requestTimeoutMs, deadline - observedAt));
      if (!out.ok) {
        if (out.failure !== "provider-cooldown") this.noteFailure(key, out.failure);
        return out;
      }
      try {
        this.db.prepare("UPDATE cooldown SET failures = 0 WHERE id = 1 AND until_ms <= ?").run(this.clock.now());
      } catch {
        // Only the backoff ladder's memory; the next 429 starts it a rung high.
      }
      this.store(key, out.data, observedAt, LANE_TTL_MS[c.name]);
      return { ok: true, data: out.data, observedAt, servedFrom: "live" };
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
    }
  }

  private async request(c: Clamped, now: number, timeoutMs: number): Promise<{ ok: true; data: unknown } | { ok: false; failure: FlowFailure }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(BITQUERY_DEFAULT_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...bitqueryAuthHeaders(this.o.config.apiKey) },
        body: JSON.stringify(buildLaneRequest(c, now)),
        signal: controller.signal,
      });
      if (!res.ok) {
        // The body is not read: an auth refusal can quote the request.
        if ([401, 402, 403, 429].includes(res.status)) this.coolDown(res.status, res);
        return { ok: false, failure: `http-${res.status}` as FlowFailure };
      }
      const read = await readBoundedJson<{ data?: unknown; errors?: { message?: unknown }[] }>(res, 512 * 1024);
      if (!read.ok) return { ok: false, failure: "invalid-body" };
      const errors = Array.isArray(read.value?.errors) ? read.value.errors : [];
      if (errors.length > 0) {
        // A GraphQL refusal arrives as a 200: the QUERY is what it disliked,
        // and the reason is the only thing that tells an operator which one.
        const why = errors.map((e) => (typeof e?.message === "string" ? e.message : "?")).join("; ");
        this.sayOnce(`errors:${c.name}`, `${c.name} was refused by the provider: ${scrub(why)}`);
        return { ok: false, failure: "invalid-body" };
      }
      const parsed = parseFor(c, read.value?.data);
      if (parsed === null) {
        this.sayOnce(`shape:${c.name}`, `${c.name} answered in a shape this lane does not read`);
        return { ok: false, failure: "invalid-shape" };
      }
      return { ok: true, data: parsed };
    } catch (e) {
      return { ok: false, failure: controller.signal.aborted || (e instanceof Error && e.name === "AbortError") ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
  }
}
