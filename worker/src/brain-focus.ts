/**
 * WHAT IS THIS RUN ABOUT? And why an all-cash agent was never asked anything.
 *
 * The focus is chosen as "the largest holding", which quietly means Brain is
 * only ever asked one question: *should I keep or trim what I already have?*
 * An agent holding nothing has no largest holding, so the whole block is
 * skipped and it is never asked at all.
 *
 * That is backwards. An agent sitting on cash with no position is the one for
 * which the interesting question exists — *is anything worth opening?* — and it
 * is the question whose answer is a BUY. Measured on the live fleet: of 24
 * agents, exactly one had a position and could be shadowed; three more had
 * evidenced capital, no holdings, and could not be asked a thing. A cohort of
 * one, produced by a sort that returned undefined.
 *
 * So a book with nothing in it gets a CANDIDATE: an instrument from the agent's
 * own configured universe, which is what its grant already permits it to trade.
 * That is not a recommendation and it does not weaken any guard — the candidate
 * has to survive every check a holding would, and Brain remains free to say no.
 * It only means the question gets asked.
 *
 * THREE THINGS DISQUALIFY A CANDIDATE, and each is somebody else's rule:
 *
 *   paused          the token is halted; nothing may be opened in it
 *   unpriced        no quote at all — an instrument nobody can value is not a
 *                   question, it is a guess
 *   curve-priced    `PriceQuote.source` documents that a bonding-curve quote is
 *                   "good enough to value something already held; it is not
 *                   good enough to authorise a new buy". Offering one as an
 *                   opening candidate would launder that distinction.
 *
 * A STALE PRICE DOES NOT DISQUALIFY IT — it is preferred against, not excluded.
 * Brain is told the price is stale and refuses on it perfectly well by itself;
 * removing the instrument instead would hide the reasoning we are trying to
 * observe, and would silently re-create the empty cohort every evening.
 *
 * PURE. No chain, no clock, no environment.
 */

import { instrumentClassOf, tradesAroundTheClock } from "../../packages/core/src/index";

export interface HeldPosition {
  symbol: string;
  token: string;
  /** Micro-USDG. */
  valueUsdg: number;
  price8: bigint;
  priceStale: boolean;
  priceSource: string;
}

export interface UniverseToken {
  symbol: string;
  address: string;
}

export interface QuotedPrice {
  price8: bigint;
  stale: boolean;
  source: string;
}

export interface BrainFocus {
  symbol: string;
  token: string;
  price8: bigint;
  priceStale: boolean;
  priceSource: string;
  /** Micro-USDG currently held. Zero when this is a candidate to open. */
  heldUsdg: number;
  /**
   * Does the book already hold this?
   *
   * The prompt reads differently either way — "you hold 65% of the book in
   * this" and "you hold none of this" are different questions — and a run that
   * did not say which was which would let a model narrate a position that does
   * not exist.
   */
  held: boolean;
}

/** A bonding-curve quote may value a holding; it may not authorise an opening. */
const CANNOT_OPEN_ON = new Set(["curve"]);

/**
 * A stable index in [0, n) from an agent id. FNV-1a, the same hash the snapshot
 * id uses — deterministic, and nothing here needs it to be cryptographic.
 */
function stableIndex(agentId: string, n: number): number {
  if (n <= 1) return 0;
  let h = 0x811c9dc5;
  for (const ch of agentId.toLowerCase()) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % n;
}

/**
 * Pick the instrument this run is about. PURE.
 *
 * Held positions win outright: an existing exposure is a live risk and a
 * hypothetical opening is not, so nothing about an empty-book candidate should
 * ever displace a real one.
 */
export function chooseFocus(args: {
  /** Stable seed for the tiebreak. Different agents, different questions. */
  agentId: string;
  positions: readonly HeldPosition[];
  universe: readonly UniverseToken[];
  prices: ReadonlyMap<string, QuotedPrice>;
  paused: ReadonlySet<string>;
}): BrainFocus | null {
  const held = [...args.positions]
    .filter((p) => p.valueUsdg > 0)
    .sort((a, b) => b.valueUsdg - a.valueUsdg)[0];
  if (held) {
    return {
      symbol: held.symbol,
      token: held.token,
      price8: held.price8,
      priceStale: held.priceStale,
      priceSource: held.priceSource,
      heldUsdg: held.valueUsdg,
      held: true,
    };
  }

  const eligible = args.universe
    .map((t) => ({ t, q: args.prices.get(t.symbol) }))
    .filter((x): x is { t: UniverseToken; q: QuotedPrice } => {
      if (!x.q || x.q.price8 <= 0n) return false;
      if (args.paused.has(x.t.symbol)) return false;
      return !CANNOT_OPEN_ON.has(x.q.source);
    });
  if (eligible.length === 0) return null;

  // ORDERED, NOT RANDOM. A focus that changed between two otherwise identical
  // ticks would make the decision tape impossible to read: two runs would
  // differ for a reason that is not in the evidence.
  //
  // Fresh before stale, then continuous before market-hours — an instrument we
  // can ask about at any hour is more useful to observe.
  eligible.sort((a, b) => {
    if (a.q.stale !== b.q.stale) return a.q.stale ? 1 : -1;
    const ac = tradesAroundTheClock(a.t.address);
    const bc = tradesAroundTheClock(b.t.address);
    if (ac !== bc) return ac ? -1 : 1;
    return a.t.symbol.localeCompare(b.t.symbol);
  });

  // ── AND THEN, AMONG EQUALS, A DIFFERENT ONE PER AGENT ────────────────────
  //
  // Alphabetical alone would hand every agent sharing the default basket the
  // same symbol. Three agents in a cohort all reasoning about NVDA answers none
  // of the questions the cohort exists to ask — whether Brain forms
  // DIFFERENTIATED opinions across agents and assets, and whether confidence
  // moves with evidence rather than with the model's mood.
  //
  // So the tiebreak is seeded by the agent id: stable for one agent across
  // every tick, and different between agents. Deterministic, not random — the
  // same agent asked twice about the same eligible set gets the same question.
  const best = eligible.filter(
    (x) =>
      x.q.stale === eligible[0]!.q.stale &&
      tradesAroundTheClock(x.t.address) === tradesAroundTheClock(eligible[0]!.t.address),
  );
  const pick = best[stableIndex(args.agentId, best.length)]!;
  return {
    symbol: pick.t.symbol,
    token: pick.t.address,
    price8: pick.q.price8,
    priceStale: pick.q.stale,
    priceSource: pick.q.source,
    heldUsdg: 0,
    held: false,
  };
}

/** What kind of question this focus poses, for a log line. */
export function focusLabel(f: BrainFocus): string {
  const cls = instrumentClassOf(f.token);
  const when = tradesAroundTheClock(f.token) ? "24/7" : "24/5";
  return f.held
    ? `${f.symbol} (${cls}, ${when}, held)`
    : `${f.symbol} (${cls}, ${when}, candidate — the book holds none of it)`;
}
