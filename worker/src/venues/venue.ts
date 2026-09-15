/**
 * THE LAUNCHPAD SEAM — one shape, so Pons is an implementation rather than the
 * product.
 *
 * Every piece of this already existed and was wired directly into the tick:
 * `readClassLegs` verified a candidate, `curveBuyOut`/`curveSellOut` quoted it,
 * `simulateCurveTrade` rehearsed it, `buildClassBuyCalls`/`buildClassSellCalls`
 * encoded it, `readClassLog` rebuilt the position. The functions are good. What
 * was missing is a name for what they collectively ARE, so a second launchpad
 * can be added without the strategist, the policy or the UI learning about it.
 *
 * SHAPED TO WHAT EXISTS, NOT TO AN IDEAL. Every method here has a working Pons
 * implementation today and takes arguments those functions already take. An
 * interface invented ahead of its second implementor usually fits neither; this
 * one is a rename of a thing that runs, and the second venue is expected to bend
 * it. That is cheaper than bending the tick.
 *
 * WHAT THIS SEAM DELIBERATELY DOES NOT ABSTRACT.
 *
 *   The WALL. A venue describes how to reach a market; it never decides what a
 *   key may do. `buyCalls`/`sellCalls` return calls that the policy mirror still
 *   checks and the on-chain wall still enforces, and a venue that returned a
 *   call the wall refuses simply gets refused. No venue can widen a permission,
 *   and none may be given the chance to try.
 *
 *   CUSTODY. Pons class trades are held by a per-account vault the wall pins as
 *   a literal target. That is a property of THIS venue's safety model, not of
 *   launchpads in general — a second venue may hold positions in the account
 *   itself. `positionState` therefore reports where a position is, and callers
 *   must not assume a vault exists.
 *
 *   PRICE TRUTH. A venue quotes its own market and says so. Nothing here is a
 *   valuation: a curve mark is not a price the book may carry, and putting one
 *   into equity is what the drawdown breaker would read as a loss.
 */
import type { Call } from "../executor";

/** Which venue a row came from. One string, used as a key and shown to nobody. */
export type VenueId = "pons";

/**
 * A token the venue has discovered, before anything has been verified about it.
 *
 * `route` is the venue's own handle for how to trade this token — for Pons the
 * bonding curve address. It is opaque to every caller: the tick carries it from
 * `discover` to `quoteBuy` to `buyCalls` without interpreting it, which is what
 * keeps the curve/pool distinction inside the venue where it belongs.
 */
export interface VenueCandidate {
  venue: VenueId;
  token: `0x${string}`;
  symbol: string;
  decimals: number;
  /** Venue-opaque routing handle. Pons: the curve. */
  route: `0x${string}`;
  /** The asset this market is denominated in. Zero address means native. */
  quoteToken: `0x${string}`;
  /** Unix seconds the venue first saw it, or null when unknown. */
  firstSeen: number | null;
}

/**
 * A candidate the venue has VERIFIED it can currently trade, with the measured
 * numbers that verification produced.
 *
 * Everything here is a measurement, never an estimate, and every field that
 * could not be measured is null rather than zero — the rule this repo keeps
 * everywhere else about a failed read. A scorer that cannot tell "no depth"
 * from "depth unknown" will happily buy the second.
 */
export interface VenueLeg {
  venue: VenueId;
  token: `0x${string}`;
  symbol: string;
  decimals: number;
  route: `0x${string}`;
  quoteToken: `0x${string}`;
  /** REAL depth in the quote asset, 6dp. Never the reported reserve. */
  realDepthRaw: bigint;
  /** 0..10000. How far this market is toward graduating out of the venue. */
  graduationBps: number | null;
  /** Unix seconds since first seen, or null when the venue cannot say. */
  ageSec: number | null;
  /** Trades in the venue's recent window, or null when not measured. */
  recentTrades: number | null;
}

/**
 * Why a candidate was passed over, in the OWNER'S vocabulary.
 *
 * Not a slug. This string is shown to a person as the reason their agent did
 * nothing, so it must be a sentence they can act on — "only 41.00 USDG of real
 * depth" rather than `shallow`. The refusal vocabulary is the venue's
 * responsibility because only the venue knows what its numbers mean.
 */
export interface VenueRefusal {
  symbol: string;
  reason: string;
}

/** What a trade of a given size would return, measured against live state. */
export interface VenueQuote {
  /** Units out, in the destination asset's own decimals. */
  amountOutRaw: bigint;
  /**
   * Cost of the round trip in bps against a frictionless fill, or null when it
   * could not be computed. Null is not zero: a trade whose cost is unknown has
   * not been shown to be cheap.
   */
  costBps: number | null;
}

/** A rehearsal of the real call, against real state. */
export interface VenueSimulation {
  ok: boolean;
  /** What the rehearsal returned, when it returned. */
  amountOutRaw: bigint | null;
  /** Owner-facing reason when `ok` is false. */
  reason: string | null;
}

/**
 * Where a position is and what can be done with it.
 *
 * `sellable` is the field this whole milestone turns on. A Pons class position
 * stops being sellable through its vault the moment its curve graduates — and
 * graduation is the SUCCESS case, so the better a trade goes the sooner this
 * flips. A caller that reads `sellable: false` is looking at a position whose
 * exit has closed, and must say so rather than keep waiting.
 */
export interface VenuePositionState {
  venue: VenueId;
  token: `0x${string}`;
  /** Units held, in the token's own decimals. Zero means gone. */
  balanceRaw: bigint;
  /** Can this venue still sell it right now? */
  sellable: boolean;
  /** Why not, in the owner's vocabulary. Null when sellable. */
  unsellableReason: string | null;
  /** 0..10000 toward graduation, or null when unknown. */
  graduationBps: number | null;
  /** Where the tokens actually sit — a vault, or the account itself. */
  custody: "vault" | "account";
}

/**
 * A launchpad, as the tick needs it.
 *
 * Read methods take a chain reader and may fail; they return empty or null
 * rather than throwing, because one venue having a bad minute must not stop the
 * others or abort the tick. Call builders are PURE and throw on nonsense input —
 * an unbuildable call is a programming error, not a market condition.
 */
export interface LaunchVenue {
  readonly id: VenueId;

  /**
   * Tokens this venue has seen recently. Cheap, and deliberately unfiltered:
   * discovery says what exists, `verify` says what is tradable, and keeping
   * them apart is what lets the funnel report how many were dropped and why.
   */
  discover(opts: { limit: number }): Promise<VenueCandidate[]>;

  /**
   * Which candidates can actually be traded right now, and the measured numbers
   * behind that answer — plus, for everyone else, a sentence saying why not.
   *
   * `maxReads` is a hard ceiling on chain calls: discovery is continuous and an
   * unbounded verify would spend the RPC budget on tokens nobody will buy.
   */
  verify(opts: {
    candidates: readonly VenueCandidate[];
    quoteToken: `0x${string}`;
    minRealDepthRaw: bigint;
    maxReads: number;
  }): Promise<{ legs: VenueLeg[]; refused: VenueRefusal[] }>;

  quoteBuy(opts: { leg: VenueLeg; quoteInRaw: bigint }): VenueQuote | null;
  quoteSell(opts: { leg: VenueLeg; tokensInRaw: bigint }): VenueQuote | null;

  /**
   * Rehearse the REAL calls against live state, sending nothing.
   *
   * Takes everything a call needs — the account it runs as, the custody address
   * and the deadline — because a rehearsal built from anything less is a
   * rehearsal of a different trade. The first version of this took only a size
   * and returned curve arithmetic, which would have reported "simulated" in the
   * funnel for a chain call that never happened.
   */
  simulate(opts: {
    leg: VenueLeg;
    side: "buy" | "sell";
    amountInRaw: bigint;
    minOutRaw: bigint;
    /** The account the calls execute as — the smart account in production. */
    account: `0x${string}`;
    custody: `0x${string}`;
    deadline: bigint;
  }): Promise<VenueSimulation>;

  /** The calls that perform a buy. Pure. Throws on unbuildable input. */
  buyCalls(opts: {
    custody: `0x${string}`;
    leg: Pick<VenueLeg, "route" | "quoteToken">;
    quoteInRaw: bigint;
    minOutRaw: bigint;
    deadline: bigint;
  }): Call[];

  /** The calls that perform a sell. Pure. Throws on unbuildable input. */
  sellCalls(opts: {
    custody: `0x${string}`;
    leg: Pick<VenueLeg, "route">;
    tokensInRaw: bigint;
    minOutRaw: bigint;
    deadline: bigint;
  }): Call[];

  positionState(opts: {
    custody: `0x${string}`;
    token: `0x${string}`;
    route: `0x${string}`;
  }): Promise<VenuePositionState | null>;
}
