/**
 * Deterministic policy layer — and its posture DEPENDS ON THE RAIL, which is
 * the single most important thing to understand about this file.
 *
 * ON THE EVM RAIL (swap / vault / transfer) it is a MIRROR of the on-chain
 * Kernel session-key policies: the on-chain caps are the hard wall; this layer
 * exists to reject bad intents cheaply and log WHY, before gas is spent. If
 * this code and the on-chain policy ever disagree, the on-chain policy wins
 * and that divergence is a bug to alert on. A mirror must never be stricter
 * than the chain — a stricter mirror rejects trades the wall would allow.
 *
 * ON THE BROKER RAIL (equity-order) there is NO on-chain policy to mirror.
 * Robinhood's Agentic account is custodial, its OAuth scope cannot be
 * restricted below full trading, and nothing re-checks amounts after this
 * function returns ok — so here this layer IS the wall, and the posture
 * inverts: deliberately conservative, because there is no backstop to defer
 * to. The only enforcement beneath it is Robinhood's own account-level
 * reserved budget. This is why processIntent runs checkPolicy TWICE on that
 * rail — once on the proposed notional and again on the terms review()
 * returns — where the EVM rail relies on the account contract for the
 * re-check. (spikes/robinhood-mcp/DESIGN.md §5.)
 *
 * ON THE PERP RAIL (perp-order, perp-margin) it is BOTH. The one EVM leg that
 * spends — the margin deposit — is a mirror of the wall's deposit permission,
 * held to the mirror's rule. The orders themselves are L2 transactions the
 * wall never sees, so for them this layer IS the wall (docs/perps.md rule 4),
 * with the broker rail's posture: conservative, run on proposed and reviewed
 * terms, and every question it cannot answer is a refusal. Its exits are the
 * one thing it may never refuse for a brake (rule 8) — see the perp branch.
 *
 * Nothing in this file may call an LLM, read agent memory, or take a string that
 * originated from a model. Intents come in typed; verdicts go out typed.
 */

import { scoutAllows, type ScoutLimits } from "./quarantine";
// THE PERP ARITHMETIC, FROM ITS ONE HOME. perps.ts imports nothing and talks
// to nothing — pure bigint functions of their arguments — so taking it here
// keeps this file's contract (no verdict may depend on something outside the
// intent, the limits and the state) while giving the perp branch the SAME
// notional, margin and liquidation figures the paper engine, protect.ts and
// the dashboard compute. A private copy here is how a cap judged on one
// rounding and a stop placed on another come to disagree by a tick, and that
// tick always lands on the side that lets something through. Imported from the
// file, not the core index: the index pulls viem and the wall builder in,
// which a judge has no business loading.
import {
  PERP_MAX_ORDER_PRICE,
  isolatedLiqPrice,
  isolatedMarginMicro,
  leverageTarget,
  notionalMicro,
  perpMarginFitsCap,
  perpMarketByKey,
  stopBeatsLiquidation,
  type PerpKey,
  type PerpMarketSpec,
} from "../../packages/core/src/perps";

/**
 * A 6dp USDG amount, written the way an owner reads it.
 *
 * LOCAL, four lines, rather than imported. This module's contract is to stay
 * import-light — it is the mirror of an on-chain policy and every dependency is
 * a thing that could make a verdict depend on something the chain cannot see.
 * A number formatter is not worth breaking that for, and `reasons.ts` (which
 * has its own) is a rendering layer this file must not reach into.
 *
 * `detail` strings from here are printed VERBATIM into the owner's event feed
 * by index.ts, which is why the units matter: `50000000` is what a 50 USDG
 * agent was being shown, and nobody reads that as fifty dollars.
 */
const money = (v: bigint) => `${(Number(v) / 1e6).toFixed(2)} USDG`;

export interface AgentLimits {
  /** Sealed autonomous vault, plus chain-verified candidates/holdings. */
  trencherVault?: string;
  knownTrencherAssets?: readonly string[];
  /** USDG (6dp) ceiling for a single trade. */
  perTradeUsdg: bigint;
  /** USDG (6dp) ceiling summed over a rolling 24h window. */
  dailyUsdg: bigint;
  /** Allowed target contracts (Rialto router via registry, Morpho vault, tokens for approvals). */
  allowedTargets: readonly `0x${string}`[];
  /** Allowed token addresses the agent may hold or trade. */
  allowedAssets: readonly `0x${string}`[];
  /**
   * Token addresses the SIGNED KEY can actually approve for a sell — i.e. what
   * it can get back OUT of. Distinct from allowedAssets, which is only what the
   * owner pointed the agent at.
   *
   * These diverge for a real and previously costly reason: approving USDG is a
   * single generic permission, so a BUY works for any token with a pool, while
   * a SELL needs a per-token approve baked into the signature at signing time.
   * A token in the first set but not the second is a one-way door.
   *
   * Undefined disables the check — for callers (backtests, fixtures) that have
   * no grant to reason about. Never leave it undefined on a live path.
   */
  sellableAssets?: readonly string[];
  /**
   * Curve addresses this agent has SEEN LAUNCH, from a factory-filtered scan.
   *
   * The curve is the one argument the wall cannot pin -- a new address per
   * token, hundreds an hour -- so wall.ts passes `null` for it and says so
   * outright. That makes this the only place a curve can be constrained at all.
   *
   * What made a curve trustworthy before this was INCIDENTAL: the launch scan
   * happens to filter on PONS_V2_FACTORY (pons.ts) and discovery copies the
   * value through. Any future producer that sourced a curve from somewhere else
   * -- an LLM proposal, a chat message, a poisoned tape -- would silently lose
   * that property, and nothing would have noticed.
   *
   * Optional, like sellableAssets, for fixtures. Absent means the rule cannot
   * run; it must never mean the rule passed.
   */
  knownCurves?: readonly string[];
  /**
   * The per-account CLASS VAULT this grant sealed, or absent.
   *
   * Its presence is what makes a curve trade a CLASS trade: the vault is the
   * only target that can reach a token nobody enumerated, so a trade aimed at
   * it is judged by different rules than one aimed at the adapter — see the
   * curve-trade branch. Read from the GRANT (grantPonsClassVault: marker AND
   * sealed address), never from settings, for the same reason every other
   * mirrored address is.
   *
   * ABSENT IS THE SECURE DEFAULT and means every curve trade is judged the old
   * way: both legs must be enumerated. A fixture that leaves this undefined
   * gets the strict rules, which is the direction a missing value should fail.
   */
  ponsClassVault?: string;
  /**
   * The QUOTE side of the book: USDG and the tradeable stock tokens.
   *
   * `builtinGrantTargets(grant)` -- deliberately NOT sellableAssets, which also
   * contains the owner's added extras and therefore the launched memecoins. The
   * two lists differ by exactly the tokens a curve trade might be ENTERING, so
   * using the wrong one turns the drawdown breaker's exit exemption into a
   * blanket exemption for the venue.
   *
   * Optional for fixtures. Absent means the exit test falls back to cashToken
   * alone -- narrower, which is the safe direction for an exemption.
   */
  quoteAssets?: readonly string[];
  /**
   * Tickers the agent may trade on the brokerage rail — the broker analog of
   * allowedAssets, since an equity order has no address for that list to
   * check. Optional for fixtures only (the sellableAssets rule); on a live
   * broker path this IS the asset wall, so never leave it undefined there.
   */
  allowedTickers?: readonly string[];
  /**
   * Addresses this grant's wall permits USDG transfers to, mirroring the
   * on-chain ONE_OF pin. An EMPTY array means the wall has no transfer
   * permission at all; UNDEFINED means the grant predates the allowlist and
   * still carries the old free-form permission — the two are different, and
   * conflating them would make this mirror stricter than the chain.
   */
  withdrawalAddresses?: readonly string[];
  /**
   * The cash token (USDG). Passed in rather than imported so this file stays
   * free of the token registry — it is a judge, not a market participant.
   *
   * Used to recognise a de-risking SELL: a swap whose buy side is cash is money
   * coming home, and the drawdown breaker must never block that. Undefined
   * disables that recognition, so a fixture without it keeps the old, stricter
   * behaviour rather than silently widening.
   */
  cashToken?: string;
  /**
   * THE ENERGY BUY THIS GRANT SEALED, or absent.
   *
   * From the GRANT and nowhere else (grantEnergyRoute: the GRANT_ENERGY marker
   * AND chain 4663), for the reason every mirrored address here is: the wall
   * built the permission from that marker, so it is the only record of what
   * the chain will honour.
   *
   * DELIBERATELY NOT IN allowedTargets. The router is a target only for the
   * one selector the wall pinned — swapExactTokensForTokensSupportingFee-
   * OnTransferTokens over the frozen USDG → VIRTUAL → $MERRYMEN path into the
   * account itself. Listing it with the other targets would let any `swap`
   * intent name it, and the swap builder would then route that intent through
   * a v3 router it never quoted: a mirror looser than the chain. So a `swap`
   * aimed at it stays `target-allowlist`, and only an `energy-buy` is judged
   * against this.
   *
   * ABSENT means the signature cannot buy energy at all (`energy-not-granted`).
   */
  energy?: {
    /** Uniswap v2 Router02 — the one address the wall pinned the energy swap on. */
    router: string;
    /** The reserve token the route ends at ($MERRYMEN). */
    token: string;
  };
  /**
   * THE LIGHTER ROUTE THIS GRANT SEALED, or absent (docs/perps.md rule 3).
   *
   * From `grantPerp(grant)` and NOWHERE ELSE — the marker, chain 4663, the
   * route's key index and a canonical public key, all four or nothing — for the
   * reason `energy` is: the wall built its four perp permissions from that
   * block, so it is the only record of what the chain will honour. Settings
   * never reach it; an owner who switches perps on without re-signing has a key
   * that can post no margin, and this says so (`perp-not-granted`) instead of
   * building a UserOp the chain refuses.
   *
   * `proxy` is DELIBERATELY NOT IN allowedTargets, on the energy precedent: the
   * wall reaches the proxy through three exact selectors (deposit to self,
   * changePubKey of the sealed key, withdrawPendingBalance to self) and the
   * USDG approve's ONE_OF spender list. Listing it with the generic targets
   * would let a `swap` or `vault-deposit` intent name it, and a builder would
   * then aim calldata at it that no permission covers — a mirror looser than
   * the chain. Only a `perp-margin` deposit is judged against it.
   *
   * No private key, sealed or otherwise, ever travels here: this struct is
   * logged, shown in the wall battery and passed to every producer.
   *
   * ABSENT means real perps cannot move money (`perp-not-granted`). Paper perps
   * never touch the chain and do not need it.
   */
  perp?: {
    /** The ZkLighter proxy (LIGHTER_ROUTE_V1.proxy) — the one deposit target the wall pinned. */
    proxy: `0x${string}`;
    /** The key index the wall pinned EQUAL in changePubKey (LIGHTER_ROUTE_V1.apiKeyIndex). */
    apiKeyIndex: number;
    /** The exact API public key sealed at signing, canonical `0x` + 80 hex. */
    apiPublicKey: `0x${string}`;
  };
  /** Drawdown (bps from high-water mark) at which the breaker pauses the agent. */
  maxDrawdownBps: number;
  /** Unix seconds after which the session key is dead regardless of anything. */
  expiresAt: number;
  /** Ops ceiling per rolling 24h — mirrors the on-chain rate-limit policy. */
  maxOpsPerDay: number;
}

export type TradeIntent = {
  /**
   * Opaque link to the `decisions` row that produced this intent — set upstream
   * (strategist / chat / tick fallback), stamped onto the trade for attribution.
   * checkPolicy MUST ignore it: this stays a numbers-only decision. It is NOT the
   * model's reason (that free text lives only in the decisions table, never here),
   * so the policy-purity rule above is preserved.
   */
  decisionId?: string;
} & ({
  kind: "swap";
  custody?: "trencher";
  target: `0x${string}`;
  sellToken: `0x${string}`;
  buyToken: `0x${string}`;
  /** Raw units of sellToken (USDG = 6dp, stock tokens = 18dp) — what executes. */
  sellAmountRaw: bigint;
  /** USDG-equivalent size (6dp) — what the caps judge. */
  notionalUsdg: bigint;
} | {
  kind: "vault-deposit" | "vault-withdraw";
  target: `0x${string}`;
  amountUsdg: bigint;
} | {
  /**
   * USDG leaving the wall to an external recipient (chat /transfer, confirmed).
   * target is the USDG token contract; the recipient is free-form but the
   * amount is capped on-chain by the grant's transfer permission and here by
   * the same per-trade/daily caps as any spend.
   */
  kind: "transfer";
  target: `0x${string}`;
  recipient: `0x${string}`;
  amountUsdg: bigint;
} | {
  /**
   * A brokerage equity order (the Robinhood venue). NO ADDRESS FIELDS on
   * purpose: there is no contract to target and no calldata to build, and
   * omitting `target` means the compiler forces every consumer that assumes an
   * EVM shape to decide what an equity order means to it — nothing falls
   * through an else-branch built for chains.
   */
  kind: "equity-order";
  /** Uppercase ticker as the broker knows it (AAPL), never an address. */
  ticker: string;
  side: "buy" | "sell";
  /** USD notional, 6dp — same unit as USDG, judged by the same caps. */
  notionalUsdg: bigint;
} | {
  /**
   * A trade on a Pons bonding curve, through the PonsSelfTrade adapter.
   *
   * ITS OWN KIND rather than a `swap`, for a reason that is about safety and
   * not tidiness. A curve has no fee tier, no path and no PoolKey, so it does
   * not fit the Quote that `swap` dispatches on — and forcing it through would
   * mean either inventing a sentinel for the native side or having
   * `asset-allowlist` reject the venue outright, which is a mirror STRICTER
   * than the chain. A distinct kind also makes the compiler ask every consumer
   * what a curve trade means to it, the same reasoning that leaves
   * `equity-order` without a `target`.
   *
   * `target` IS here, and it is the ADAPTER — never the curve. The curve is a
   * call argument the wall cannot pin (a new address per token, ~475 an hour),
   * so `target-allowlist` covers the one address that IS pinned, unchanged.
   */
  kind: "curve-trade";
  /** The PonsSelfTrade adapter. What the wall pinned and what gets called. */
  target: `0x${string}`;
  /** The bonding curve. An argument, vouched for by nobody — see wall.ts. */
  curve: `0x${string}`;
  assetIn: `0x${string}`;
  assetOut: `0x${string}`;
  /** Raw units of assetIn — what executes. */
  amountInRaw: bigint;
  /**
   * Slippage floor in assetOut units, from the SAME quote that sized this
   * intent. Carried on the intent rather than recomputed at execution time so
   * the number the trade is judged against and the number the chain enforces
   * cannot come from two different readings of a curve that moves 1,546 bps at
   * p99 over four minutes.
   *
   * checkPolicy ignores it, like every other execution detail here.
   */
  minAmountOutRaw: bigint;
  /** USDG-equivalent size (6dp) — what the caps judge. */
  notionalUsdg: bigint;
} | {
  /**
   * USDG spent buying the agent's own ENERGY ($MERRYMEN) over the one route the
   * grant sealed (core energy.ts ENERGY_ROUTE_V1), at the owner's request.
   *
   * ITS OWN KIND, NOT A `swap`, for three reasons that are about safety:
   *
   *   BUY-ONLY. The key can never sell $MERRYMEN — it has no approve for it
   *   anywhere in the wall — so `no-exit` would refuse every one of these, and
   *   carving an exemption into the swap branch (the most-travelled branch in
   *   this file) is how a looser mirror gets written by accident.
   *
   *   NOT A POSITION. It is never watched, never valued into equity and never
   *   sold by a strategy; `asset-allowlist` (the watch set) and the scout
   *   budget (unpriceable POSITIONS) are about something it is not.
   *
   *   CAPITAL OUT. Accounting books it as capital leaving the trading book,
   *   not a fill — and a `swap` would fall through to the v3, Rialto or
   *   approve-only executor arms, none of which can build this call.
   *
   * A new kind also makes the compiler ask every consumer that reads a
   * notional what this means to it, which is how curve-trade was added.
   *
   * `target` is the v2 router; the legs are USDG → $MERRYMEN (the VIRTUAL hop
   * is fixed by the route, not chosen here). `notionalUsdg` must EQUAL
   * `sellAmountRaw`: the input is USDG itself, so the two are the same number
   * and a difference could only be an intent built wrong.
   */
  kind: "energy-buy";
  target: `0x${string}`;
  sellToken: `0x${string}`;
  buyToken: `0x${string}`;
  /** Raw USDG (6dp) the router pulls — exactly the approve. */
  sellAmountRaw: bigint;
  /** The same figure, as the caps read it. */
  notionalUsdg: bigint;
} | {
  /**
   * OPENING A POSITION ON A LIGHTER PERP (docs/perps.md rules 6, 7, 8, 15).
   *
   * ONE KIND, DISCRIMINATED ON `effect`, and the discrimination is the safety
   * property rather than a tidy type. An open and a close are the same venue
   * transaction with different flags, and a close that went out WITHOUT
   * `ReduceOnly` could flip a long into a short the size of the position. So
   * the flag is not a field a producer sets beside the effect — it is fixed by
   * it: every open is `reduceOnly: false` and carries a stop; every reduce and
   * close is `reduceOnly: true` and carries none. `isExitIntent` keys on the
   * FLAG the venue enforces, not on the label alone, and the signer derives
   * `ReduceOnly` and `IsAsk` from this intent and nothing else.
   *
   * NO `target`, like equity-order, and for the same reason: an L2 order has
   * no contract and no calldata. Omitting it makes the compiler ask every
   * consumer that assumes an EVM shape what a perp order means to it.
   *
   * NO LEVERAGE FIELD. Lighter has none per order — leverage is per-(account,
   * market) venue state set by UpdateLeverage while the market is flat (rule
   * 6). `imfBp` is an ASSERTION of that state, which checkPolicy compares to
   * what the venue reads and to what settings imply; no model ever names it.
   *
   * PRICES AND SIZES ARE THE VENUE'S INTEGERS (`size × 10^sizeDecimals`,
   * `price × 10^priceDecimals`), never floats — the same numbers the signer
   * signs. `notionalUsdg` for an open is `baseAmount × max(worstPrice,
   * markPrice)` rounded up: the most the order can put on, judged at the worse
   * of the two prices it could plausibly fill against. A short is judged at
   * the mark too, not only at its lower worst price — a short filled low is a
   * short sized by its best fill, which is the cap under-counting exposure.
   */
  kind: "perp-order";
  venue: "lighter";
  /** `BTC-PERP` — never the bare venue symbol, which collides with spot tickers. */
  market: PerpKey;
  /** Lighter market_id. Must be the id LIGHTER_MARKETS_V1 pairs with `market`. */
  marketId: number;
  effect: "open";
  /** The side being OPENED. A short is never spelled "sell". */
  side: "long" | "short";
  reduceOnly: false;
  /** Venue base units. */
  baseAmount: bigint;
  /** The IOC's bound: a buy pays no more, a sell takes no less (worstPriceForTaker). */
  worstPrice: bigint;
  /** The venue's mark this order was sized against. */
  markPrice: bigint;
  /** micro-USDG: baseAmount × max(worstPrice, markPrice), rounded up. What the caps judge. */
  notionalUsdg: bigint;
  /** The initial margin fraction (1/10000) this open ASSERTS the venue holds for the market. */
  imfBp: number;
  /** The venue stop's trigger (mark), on the losing side of the entry. Required. */
  stopTrigger: bigint;
  /** The stop's IOC execution bound. Required; judged against liquidation. */
  stopPrice: bigint;
  /** Optional take-profit child — both present or both absent. */
  takeTrigger?: bigint;
  takePrice?: bigint;
} | {
  /**
   * REDUCING OR CLOSING ONE — an EXIT, always attemptable (rule 8).
   *
   * `side` is the side HELD, never the order's direction: a close of a long
   * sells, and the boundary maps (side, effect) to the venue's IsAsk so no
   * model ever supplies one. A side that differs from the position is refused
   * (`perp-side-mismatch`), never reinterpreted — reinterpreting it is how a
   * close becomes an open.
   *
   * NEVER A STOP. The stop belongs to the open that made the position; an exit
   * carrying one is an intent built wrong, and policy refuses it as such.
   *
   * Sized by the boundary, not here: a reduce is clamped to the venue-read
   * position, a remainder under the market minimum becomes a close, and a
   * close is always the full venue-read size. The caps never refuse one, and
   * ReduceOnly at the venue means a duplicate can never flip the position.
   */
  kind: "perp-order";
  venue: "lighter";
  market: PerpKey;
  marketId: number;
  effect: "reduce" | "close";
  /** The side HELD. */
  side: "long" | "short";
  reduceOnly: true;
  baseAmount: bigint;
  worstPrice: bigint;
  markPrice: bigint;
  /** Informational on an exit: nothing caps an exit, so nothing judges this. */
  notionalUsdg: bigint;
} | {
  /**
   * USDG POSTED FROM THE ACCOUNT INTO LIGHTER — the one perp leg that spends.
   *
   * An EVM leg through the wall: `USDG.approve(proxy, a)` then
   * `deposit(self, 3, 0, a)`, both pinned by the perp-lighter-v1 marker and
   * both capped at perTradeUsdg (the approve's ONE_OF usdgSpenders). `target`
   * is the proxy and must equal the one the grant sealed (AgentLimits.perp).
   *
   * Counted as SPEND against the daily cap, like a vault deposit: rule 4 is
   * explicit that this is exactly the money that can be lost at the venue. Not
   * an entry for the energy gate (the open it funds is), and not an exit.
   */
  kind: "perp-margin";
  direction: "deposit";
  /** The Lighter proxy. */
  target: `0x${string}`;
  amountUsdg: bigint;
} | {
  /**
   * MONEY COMING HOME FROM LIGHTER — an exit, never capped or halted.
   *
   *   withdraw — an L2 secure withdrawal, signed with the API key; the venue
   *              can pay it only to the account's own L1 address (rule 2).
   *   claim    — `withdrawPendingBalance(self, 3, a)` through the wall, after
   *              the venue's delay. It can only ever pay this account.
   *
   * NO `target`: a withdraw has no contract, and a claim's one target is the
   * sealed proxy, which the builder takes from the grant rather than from a
   * producer.
   */
  kind: "perp-margin";
  direction: "withdraw" | "claim";
  amountUsdg: bigint;
});

/** The perp order shapes, narrowed — for the perp lane and the policy branch below. */
export type PerpOrderIntent = Extract<TradeIntent, { kind: "perp-order" }>;
export type PerpOpenIntent = Extract<TradeIntent, { kind: "perp-order"; effect: "open" }>;
export type PerpExitIntent = Extract<TradeIntent, { kind: "perp-order"; reduceOnly: true }>;
export type PerpMarginIntent = Extract<TradeIntent, { kind: "perp-margin" }>;

export type Verdict =
  | { ok: true }
  | { ok: false; rule: string; detail: string };

export interface AgentState {
  spentTodayUsdg: bigint;
  /** Executed operations in the trailing 24h — mirrors the on-chain rate limit. */
  opsToday: number;
  highWaterMarkUsdg: bigint;
  equityUsdg: bigint;
  /**
   * Is `equityUsdg` the WHOLE book? False when a held asset couldn't be valued
   * this tick, in which case the figure is a partial sum — lower than reality,
   * not equal to it.
   *
   * The drawdown rule must not run on a partial total. Doing so reads the
   * missing asset as a loss and rejects every intent, INCLUDING the sell that
   * would clear the position — the agent locks itself in precisely when the
   * owner most needs it to act. Absent = true, so existing callers keep today's
   * behaviour; only a caller that KNOWS the book is short passes false.
   */
  equityKnown?: boolean;
  /**
   * THE PERP VENUE COULD NOT BE READ THIS TICK (docs/perps.md rule 11).
   *
   * An unread Lighter account makes equity unknown (`equityKnown: false`), and
   * an unknown equity switches the drawdown rule below OFF — for every intent,
   * spot included. That was fine for a quarantined dust token; it is not fine
   * for a venue that may be carrying a leveraged loss the breaker cannot see.
   * So while this is true and the venue's last known money was not a proven
   * zero, every NON-EXIT intent is refused (`perp-unpriced`) and exits still go
   * out — the owner can always get out; nothing new goes on in the dark.
   *
   * False or absent for an agent with no perps: its venue term is a known zero
   * and Lighter is never read, so nothing here can refuse it.
   */
  perpVenueUnread?: boolean;
  /**
   * The venue's money (C + ΣM + ΣU + T, micro-USDG) at the last read that
   * succeeded. Only `0n` — a READ zero — lets a non-exit through while the
   * venue is unread; null (never read, or not known) is not zero.
   */
  perpLastKnownMicro?: bigint | null;
  /**
   * EVERYTHING THE PERP BRANCH JUDGES AN OPEN BY, supplied by the caller —
   * never by the intent, for the reason ScoutContext gives: a flag on the
   * intent saying "the venue reads isolated at this leverage" would be a flag
   * the producer could simply set.
   *
   * ABSENT means this agent has no perps lane this tick: every open and every
   * deposit is refused `perp-not-enabled`, and an exit is refused
   * `perp-no-position` because there is no venue-read position to size or
   * side it against. The perp lane builds this whenever anything is held at
   * the venue (rule 8a), whatever the mode, so an exit always has it.
   */
  perp?: PerpPolicyState;
  nowSec: number;
}

/**
 * THE PERPS LANE'S VIEW OF ITS OWN BOOK, as the policy branch reads it.
 *
 * Every map is keyed by Lighter market_id — the id the intent signs against —
 * and every money figure is bigint micro-USDG. UNKNOWN IS NEVER ZERO (rule
 * 11): a market whose terms were not read is ABSENT from `markets`, and an
 * absent market is refused, never assumed; the caller keeps the whole object
 * away (or marks the market absent) rather than inventing a figure.
 */
export interface PerpPolicyState {
  /**
   * The perps rail this tick (exec-mode.ts `perpsModeOf`). It decides OPENS
   * and DEPOSITS only — exits follow venue exposure (rule 8a), so no mode
   * here, including `off` and `refuse`, ever refuses one.
   */
  mode: "off" | "paper" | "live" | "refuse";
  /** perpsModeOf's rule when `mode` is refuse; null otherwise. */
  refuseRule: string | null;
  settings: {
    /** perpsMarkets — keys of LIGHTER_MARKETS_V1 the owner allowed. */
    markets: readonly string[];
    /** perpsMaxLeverage, 1..10. The target IMF is re-derived from it here. */
    maxLeverage: number;
    /** micro-USDG; already min(sealed perTradeUsdg, perpsPerTradeUsdg). */
    perTradeMicro: bigint;
    maxOpenNotionalMicro: bigint;
    /** perpsMaxCollateralUsdg: C + ΣM + T_in may not pass it. */
    maxCollateralMicro: bigint;
    maxOpensPerDay: number;
    /** perpsStopLossPct in bp: the FARTHEST a stop may sit from the mark. */
    stopLossBps: number;
    /** perpsStopSlipBps: the stop's execution bound vs its trigger. */
    stopSlipBps: number;
    /** perpsLiqBufferPct in bp: how far the stop's worst price must beat liquidation. */
    liqBufferBps: number;
    /** perpsMaxSlippageBps: the IOC's worst price vs mark. */
    maxSlippageBps: number;
  };
  /** Σ notional of open positions at mark, micro-USDG. */
  openNotionalMicro: bigint;
  /** C + ΣM_iso + T_in: USDG committed at the venue, micro-USDG. */
  committedCollateralMicro: bigint;
  /** Opens sent in the trailing 24h (perp_orders), paper or live per the rail. */
  opensToday: number;
  /** Venue-read positions (the ledger's, while unread), by market_id. */
  positions: ReadonlyMap<number, { side: "long" | "short"; baseAmount: bigint }>;
  /** Per-market venue terms and the account's per-market leverage state. */
  markets: ReadonlyMap<
    number,
    {
      status: "active" | "reduce-only" | "inactive";
      /** max(min_quote, min_base × price), micro-USDG (effectiveMinNotionalMicro). */
      effMinNotionalMicro: bigint;
      /** IMF_m the lane sets while flat: leverageTarget(maxLeverage, spec).imfBp. */
      imfBpTarget: number;
      /** What the venue reads for this account+market; null = no entry = unset. */
      venueImfBp: number | null;
      venueMarginMode: "isolated" | "cross" | null;
      /** The market's own maintenance fraction — fixed per market, not 60% of the chosen IMF. */
      mmfBp: number;
      spec: PerpMarketSpec;
    }
  >;
  /** Markets with a signed order whose outcome is not yet final. */
  unresolvedMarkets: ReadonlySet<number>;
  /** Markets with a reduce/close still in flight — no open until it is final (rule 9). */
  closeInFlightMarkets: ReadonlySet<number>;
  /** The durable perp-venue-incident flag (rule 16). */
  incident: boolean;
  /** MERRYMEN_HALT_PERP_ENTRIES or the owner's /flatten halt: opens off, exits on. */
  entriesHalted: boolean;
  /** The grant's expiry; null falls back to AgentLimits.expiresAt. */
  grantExpiresAtSec: number | null;
  nowSec: number;
}

/**
 * Everything the scout ceiling needs, supplied BY THE CALLER, never by the intent.
 *
 * That separation is the point. Intents come from strategies, including
 * user-written ones in ~/.merrymen/strategies, so a flag carried on the intent
 * saying "this token is priceable" would be a flag a strategy could simply set —
 * and the budget on unpriceable positions would be bypassable by the very code
 * it exists to bound. Only the tick knows what it managed to price, so only the
 * tick gets to say.
 *
 * Absent = no scout gating, matching the behaviour before scout mode existed.
 * That is right for backtests and fixtures, which have no live price map. NEVER
 * leave it absent on a live path: an unpriceable buy would then be limited only
 * by the per-trade cap, which is exactly the hole this closes.
 */
export interface ScoutContext {
  limits: ScoutLimits;
  /** Did the tick fail to price the token being BOUGHT this cycle? */
  buyUnpriceable: boolean;
  /** USDG (6dp) already sunk into that same token. */
  existingCostUsdg: bigint;
  /** USDG (6dp) total across every unpriceable position held. */
  quarantinedUsdg: bigint;
}

/**
 * IS THIS INTENT MONEY COMING HOME? The drawdown breaker's exit test, lifted
 * out of checkPolicy VERBATIM so the energy gate (worker/src/energy.ts,
 * index.ts) asks the one question the breaker asks, rather than a second copy
 * of it that could drift. checkPolicy still assigns its `isExit` from this,
 * on the line where the predicate always sat, so the breaker's behaviour is
 * unchanged by construction. The narrower `isUnsizedExit` above the caps
 * stays inline: it answers a different question (does the CHAIN size this
 * call), and exit-caps.test.ts pins it where it is.
 */
export function isExitIntent(
  intent: TradeIntent,
  limits: Pick<AgentLimits, "cashToken" | "quoteAssets">,
): boolean {
  const lc = (a: string) => a.toLowerCase();
  // AN EXIT MUST ALWAYS BE ATTEMPTABLE.
  //
  // The breaker is a brake on taking RISK, not a lock on the doors. Applied to
  // every kind, it rejected the sell that would clear the position, the vault
  // withdrawal that would pull cash back, and the transfer that would send
  // money home — while the high-water mark only ever ratchets up, so nothing
  // the agent could do would clear it. The account was locked in a losing
  // position until a human re-signed a looser grant or swept it with the owner
  // key, and the perverse escape the code actually offered was to DEPOSIT MORE
  // (which lifts the mark and shrinks the ratio).
  //
  // So the same shape `no-exit` already uses: judge the direction of travel by
  // what is being BOUGHT. Money coming home is never blocked.
  //   • vault-withdraw → cash returning from Morpho to the account
  //   • transfer       → to a recipient the wall already pinned at signing
  //   • swap into USDG → the de-risking sell itself
  // Buys stay blocked, which is the entire point of the breaker.
  //
  // A SWITCH WITH A `never` DEFAULT, NOT AN OR-CHAIN. The chain was a plain
  // disjunction, so a new kind was silently "not an exit" and nobody was asked:
  // `energy-buy` arrived that way, and a perp close would have too — the
  // breaker blocking a reduce-only close of a leveraged position in the middle
  // of a drawdown, which is the fastest road to a liquidation this codebase
  // could build. Now adding a kind does not compile until someone decides.
  // The answers for every kind that existed are unchanged (exit-intent.test.ts
  // reproduces the old expression and asks both).
  switch (intent.kind) {
    case "vault-withdraw":
    case "transfer":
      return true;
    case "swap":
      return limits.cashToken !== undefined && lc(intent.buyToken) === lc(limits.cashToken);
    case "equity-order":
      return intent.side === "sell";
    case "vault-deposit":
    case "energy-buy":
      return false;
    // A PERP EXIT IS THE FLAG THE VENUE ENFORCES, and the label with it (rule
    // 8). Keyed on `reduceOnly` because that is what makes a close unable to
    // flip into a new position; the effect alone is a word a producer chose.
    // An intent that says "close" without the flag is not an exit — it is an
    // intent built wrong, and the perp branch refuses it as one.
    case "perp-order":
      return intent.reduceOnly === true && (intent.effect === "reduce" || intent.effect === "close");
    // Money coming home from the venue, in either of its two steps. A deposit
    // is money GOING there and stays under every brake.
    case "perp-margin":
      return intent.direction === "withdraw" || intent.direction === "claim";
    case "curve-trade":
      break;
    default: {
      // A kind the type does not know is not an exit: the breaker stays on
      // for anything nobody has thought about.
      const unhandled: never = intent;
      void unhandled;
      return false;
    }
  }
  return (
    // A curve trade INTO cash is a de-risking exit, judged exactly as a swap
    // into cash is. Leaving it out would have the breaker block the one
    // direction it should never block — getting out of a memecoin — while a
    // drawdown is in progress, which is precisely when it matters most.
    // ANY curve trade out of the token and back into something the grant can
    // sell is an exit, not just one into cash. 42.8% of curves are quoted in a
    // stock token, so the cashToken-only test blocked the exit for nearly half
    // the venue during a drawdown -- the exact lock-in the comment above says
    // it prevents, for the positions most likely to be causing the drawdown.
    // ANY curve trade back into the QUOTE side is an exit, not just one into
    // cash. 42.8% of curves are quoted in a stock token, so a cashToken-only
    // test blocked the exit for nearly half the venue during a drawdown --
    // the exact lock-in the comment above says it prevents, for the positions
    // most likely to be causing the drawdown.
    //
    // QUOTE SIDE, NOT sellableAssets. The wall pins BOTH legs ONE_OF the same
    // sealed list, so `assetOut is sellable` is true of every curve trade ever
    // built, including buys -- testing it would mark the whole venue exempt and
    // switch the breaker off exactly where the risk is highest. The real
    // discriminator is that sellableAssets = builtinGrantTargets u grantTokens
    // (grant.ts:344): the launched memecoin arrives as an owner-added EXTRA,
    // while USDG and the tradeable stock tokens are BUILT IN. So trading out
    // into a builtin is an exit and trading out into an extra is an entry.
    (intent.kind === "curve-trade" &&
      ((limits.cashToken !== undefined && lc(intent.assetOut) === lc(limits.cashToken)) ||
        (limits.quoteAssets !== undefined && limits.quoteAssets.map(lc).includes(lc(intent.assetOut)))))
  );
}

// ── perpetuals (docs/perps.md rules 6, 7, 8, 8a, 11, 16) ──────────────────
//
// FOR PERP ORDERS THIS FILE IS THE WALL, NOT A MIRROR OF ONE. The session-key
// wall bounds what reaches Lighter per call (the deposit, capped at
// perTradeUsdg); it cannot bound what the API key does once money is there —
// order size, leverage, market and rate are enforced by this code alone (rule
// 4). So the perp branch takes the broker rail's posture, not the EVM rail's:
// deliberately conservative, run on the proposed terms AND again on the
// reviewed ones by the caller, and every question it cannot answer is a
// refusal. The one EVM leg here — the deposit — is still a mirror, and is held
// to the mirror's rule: never stricter than the wall about what the wall bounds
// (target, per-call amount), and as strict as the contract about the rest.
//
// THE TWO HALVES ARE ASYMMETRIC ON PURPOSE (rule 8). Opens and deposits put
// money at risk and pass every brake there is: the rail, the incident flag,
// the halt, the market, the grant's remaining life, leverage as the venue reads
// it, a stop that beats liquidation, the owner's perp caps, and then the SHARED
// brakes every entry passes (ops, per-trade, daily, perp-unpriced, breaker).
// Exits — a reduce-only reduce or close, a withdrawal, a claim — are judged
// here and RETURNED before any of those brakes, and before the session key's
// expiry: an L2 close and an L2 withdrawal are signed with the Lighter key,
// and grant expiry is exactly when the stand-down needs them. They are refused
// only for being something other than an exit of what is held.

const PERP_DAY_SEC = 86_400;
const PERP_BP = 10_000n;

/** Does this exit-shaped perp order carry any open-only field? An exit never carries a stop. */
function perpExitCarriesStop(intent: PerpOrderIntent): boolean {
  const r = intent as unknown as Record<string, unknown>;
  return (
    r.stopTrigger !== undefined ||
    r.stopPrice !== undefined ||
    r.takeTrigger !== undefined ||
    r.takePrice !== undefined ||
    r.imfBp !== undefined
  );
}

/** A venue integer price the signer can carry: 1..2^32−1 (lighter-go MaxOrderPrice). */
function perpPriceInRange(p: unknown): p is bigint {
  return typeof p === "bigint" && p >= 1n && p <= PERP_MAX_ORDER_PRICE;
}

/**
 * THE PERPS RAIL, AS A REFUSAL — or null when it is paper or live.
 *
 * One literal per rule, rather than `rule: p.refuseRule`, so that
 * wall-vocabulary.test.ts (which reads this file's rule literals) sees every
 * slug perpsModeOf can hand an open, and so each gets a sentence of its own. A
 * refuse rule the switch does not name is the ACCOUNT's (execModeOf's
 * RefuseRule: not-armed, no-cash…), passed through as the account's own words.
 */
function perpRailRefusal(p: PerpPolicyState, limits: AgentLimits): Verdict | null {
  if (p.mode === "paper") return null;
  if (p.mode === "live") {
    // THE RAIL SAYS LIVE AND THE LIMITS SAY NO GRANT: the two were built from
    // different reads, and the limits are the grant's own. Real perps need
    // the sealed key and the deposit permission, so the stricter answer wins.
    if (!limits.perp) {
      return {
        ok: false,
        rule: "perp-not-granted",
        detail:
          "the signed permission does not include perpetuals, so nothing can be opened on Lighter for real. " +
          "Re-sign at /grant with perpetuals included.",
      };
    }
    return null;
  }
  if (p.mode === "refuse") {
    switch (p.refuseRule) {
      case "perp-live-not-enabled":
        return {
          ok: false,
          rule: "perp-live-not-enabled",
          detail:
            "this account trades for real, and real-money perpetuals are not switched on — a live account never " +
            "runs practice perps beside its real book. Switch them on in Settings, under Perpetuals.",
        };
      case "perp-not-granted":
        return {
          ok: false,
          rule: "perp-not-granted",
          detail:
            "the signed permission does not include perpetuals, so nothing can be opened on Lighter for real. " +
            "Re-sign at /grant with perpetuals included.",
        };
      case "perp-venue-unready":
        return {
          ok: false,
          rule: "perp-venue-unready",
          detail:
            "the agent's Lighter account is not ready to trade yet — its deposit, account index or trading key is " +
            "still being set up, or the venue could not be reached. Nothing new is opened until it is.",
        };
      case "perp-operator-off":
        return {
          ok: false,
          rule: "perp-operator-off",
          detail: "the operator of this server has perpetuals switched off here, so nothing new is opened.",
        };
      // THE BUILD, NOT THE OWNER (perps/lane.ts perpsRailOf): real-money perps
      // are not wired yet, so a live account with perps on trades none — and
      // never runs practice perps beside its real book (rule 14) either.
      case "perp-live-not-yet":
        return {
          ok: false,
          rule: "perp-live-not-yet",
          detail:
            "this account trades for real, and real-money perpetuals are not available in this version yet — a live " +
            "account never runs practice perps beside its real book, so nothing is opened on Lighter.",
        };
      default:
        return {
          ok: false,
          rule: p.refuseRule !== null && p.refuseRule !== "" ? p.refuseRule : "perp-not-enabled",
          detail: "the account is not trading right now, so nothing new is opened on Lighter either.",
        };
    }
  }
  // `off`, or anything a caller built wrong: the owner has not turned perps on.
  return {
    ok: false,
    rule: "perp-not-enabled",
    detail: "perpetuals are off for this agent. They are turned on in Settings, under Perpetuals, on the dashboard.",
  };
}

/** Does the grant expire inside a day? Opens stop 24 h before it does (rule 6). */
function perpGrantExpiring(p: PerpPolicyState, limits: AgentLimits): boolean {
  const exp = p.grantExpiresAtSec ?? limits.expiresAt;
  return !Number.isFinite(exp) || exp - p.nowSec < PERP_DAY_SEC;
}

/**
 * A REDUCE OR CLOSE — refused only for not being an exit of what is held.
 *
 * Not refused for its size (the boundary clamps it, and ReduceOnly at the
 * venue makes an oversized one harmless), for the market having left
 * perpsMarkets or gone reduce-only (that is exactly when the owner needs out),
 * for the rail, the incident flag, the halt, the grant's expiry, a cap, the
 * breaker or the venue being unread.
 */
function checkPerpExit(intent: PerpOrderIntent, state: AgentState): Verdict {
  const x = intent as PerpOrderIntent & Record<string, unknown>;
  if (
    x.venue !== "lighter" ||
    x.reduceOnly !== true ||
    (x.effect !== "reduce" && x.effect !== "close") ||
    (x.side !== "long" && x.side !== "short")
  ) {
    return {
      ok: false,
      rule: "perp-order-malformed",
      detail: "a perp exit must be a reduce-only reduce or close on Lighter that names the side held; this one is not.",
    };
  }
  if (perpExitCarriesStop(intent)) {
    return {
      ok: false,
      rule: "perp-order-malformed",
      detail: "a perp exit never carries a stop, a take-profit or a leverage — those belong to the open that made the position.",
    };
  }
  const listed = perpMarketByKey(intent.market);
  if (listed === null || listed.marketId !== intent.marketId) {
    return {
      ok: false,
      rule: "perp-order-malformed",
      detail: `${String(intent.market)} is not Lighter market ${intent.marketId} — the key and the id disagree.`,
    };
  }
  if (typeof intent.baseAmount !== "bigint" || intent.baseAmount <= 0n) {
    return { ok: false, rule: "non-positive", detail: `a ${intent.effect} of ${String(intent.baseAmount)} is not an order` };
  }
  if (!perpPriceInRange(intent.worstPrice)) {
    return {
      ok: false,
      rule: "perp-order-malformed",
      detail: "the exit's worst price is outside what a Lighter order can carry.",
    };
  }
  // THE POSITION IT EXITS, as the venue (or, while unread, the ledger) holds
  // it. No position is not something to close; and a side that differs from
  // the one held is refused, never re-read as the other side — re-reading it
  // is how a close becomes an open.
  const held = state.perp?.positions.get(intent.marketId);
  if (held === undefined || held.baseAmount === 0n) {
    return {
      ok: false,
      rule: "perp-no-position",
      detail: `there is no ${intent.market} position to ${intent.effect}.`,
    };
  }
  if (held.side !== intent.side) {
    return {
      ok: false,
      rule: "perp-side-mismatch",
      detail: `the ${intent.market} position is ${held.side}, and this ${intent.effect} names ${intent.side}.`,
    };
  }
  return { ok: true };
}

/**
 * MONEY COMING HOME — a withdrawal (L2, the API key) or a claim (the wall).
 * Neither is capped, halted or braked. A claim is a UserOp, so it needs the
 * permission the wall sealed and a key that is still alive; a withdrawal needs
 * neither, which is what lets a stand-down bring collateral home after expiry.
 */
function checkPerpMarginHome(intent: PerpMarginIntent, limits: AgentLimits, state: AgentState): Verdict {
  if (typeof intent.amountUsdg !== "bigint" || intent.amountUsdg <= 0n) {
    return { ok: false, rule: "non-positive", detail: `a ${intent.direction} of ${String(intent.amountUsdg)} is not money` };
  }
  if (intent.direction === "claim") {
    if (!limits.perp) {
      return {
        ok: false,
        rule: "perp-not-granted",
        detail:
          "claiming a Lighter payout is a call through the signed permission, and it carries no perpetuals. " +
          "Lighter's relayer usually claims it anyway, and `merrymen recover` can with the owner key.",
      };
    }
    if (state.nowSec >= limits.expiresAt) {
      return { ok: false, rule: "expiry", detail: "session key expired" };
    }
  }
  return { ok: true };
}

/**
 * A MARGIN DEPOSIT — the mirror of the wall's deposit permission, plus the
 * contract's bounds on what may sit at the venue. Returns null when the shared
 * brakes (ops, per-trade at perTradeUsdg, daily, perp-unpriced, breaker)
 * should judge it next.
 */
function checkPerpDeposit(intent: PerpMarginIntent, limits: AgentLimits, state: AgentState): Verdict | null {
  const p = state.perp;
  if (!p) {
    return {
      ok: false,
      rule: "perp-not-enabled",
      detail: "perpetuals are off for this agent, so no margin goes to Lighter.",
    };
  }
  const rail = perpRailRefusal(p, limits);
  if (rail) return rail;
  // A DEPOSIT MOVES REAL USDG, and only a live rail has any business moving
  // it: the paper book draws its collateral from paper cash, never the chain.
  if (p.mode !== "live") {
    return {
      ok: false,
      rule: "perp-live-not-enabled",
      detail: "a margin deposit moves real USDG to Lighter, and this agent's perpetuals are paper.",
    };
  }
  if (!limits.perp) {
    return {
      ok: false,
      rule: "perp-not-granted",
      detail: "the signed permission has no deposit to Lighter. Re-sign at /grant with perpetuals included.",
    };
  }
  const target = (intent as { target?: unknown }).target;
  if (typeof target !== "string" || target.toLowerCase() !== limits.perp.proxy.toLowerCase()) {
    return { ok: false, rule: "target-allowlist", detail: `target ${String(target)} is not the sealed Lighter proxy` };
  }
  if (typeof intent.amountUsdg !== "bigint" || intent.amountUsdg <= 0n) {
    return { ok: false, rule: "non-positive", detail: `a deposit of ${String(intent.amountUsdg)} is not money` };
  }
  // Lighter's own floor (assetConfigs(3).minDepositTicks): a smaller deposit
  // reverts after the approve has already spent gas.
  if (intent.amountUsdg < 1_000_000n) {
    return {
      ok: false,
      rule: "perp-below-min",
      detail: `a ${money(intent.amountUsdg)} deposit is under Lighter's 1.00 USDG minimum, which reverts on chain.`,
    };
  }
  // MONEY GOING TO A VENUE THAT MAY BE COMPROMISED, PAUSED OR ABOUT TO BE
  // STOOD DOWN goes nowhere: a deposit exists only to fund an open, and each
  // of these already refuses the open it would fund.
  if (p.incident) {
    return {
      ok: false,
      rule: "perp-venue-incident",
      detail: "Lighter shows activity on the agent's account that the agent did not do, so no more USDG goes there.",
    };
  }
  if (p.entriesHalted) {
    return {
      ok: false,
      rule: "perp-entries-halted",
      detail: "new perpetual positions are paused, so no margin goes to Lighter to fund one.",
    };
  }
  if (perpGrantExpiring(p, limits)) {
    return {
      ok: false,
      rule: "perp-grant-expiring",
      detail: "the signed permission expires within a day; nothing new goes to Lighter before the stand-down.",
    };
  }
  // core perpMarginFitsCap: the same test the producers and depositToFund
  // size against, so what they propose is what this admits.
  if (!perpMarginFitsCap(p.committedCollateralMicro, intent.amountUsdg, p.settings.maxCollateralMicro)) {
    return {
      ok: false,
      rule: "perp-collateral-cap",
      detail:
        `${money(p.committedCollateralMicro)} is already committed at Lighter; ${money(intent.amountUsdg)} more ` +
        `would pass the ${money(p.settings.maxCollateralMicro)} most you allowed there.`,
    };
  }
  return null;
}

/**
 * AN OPEN. Returns null when it passed every perp rule and the shared brakes
 * should judge it next. The order below is STABLE and is the order the rules
 * are documented and tested in: the rail, the account-wide stops (incident,
 * halt), the market, time, what is already there, the venue's leverage, the
 * shape of the order, its stop, then the size caps.
 */
function checkPerpOpen(intent: PerpOrderIntent, limits: AgentLimits, state: AgentState): Verdict | null {
  const p = state.perp;
  if (!p) {
    return {
      ok: false,
      rule: "perp-not-enabled",
      detail: "perpetuals are off for this agent. They are turned on in Settings, under Perpetuals, on the dashboard.",
    };
  }
  const rail = perpRailRefusal(p, limits);
  if (rail) return rail;

  const o = intent as PerpOpenIntent;
  const x = intent as PerpOrderIntent & Record<string, unknown>;
  if (x.venue !== "lighter" || x.reduceOnly !== false || (x.side !== "long" && x.side !== "short")) {
    return {
      ok: false,
      rule: "perp-order-malformed",
      detail: "an open must be a non-reduce-only order on Lighter for a long or a short; this one is not.",
    };
  }
  if (
    typeof o.baseAmount !== "bigint" ||
    typeof o.notionalUsdg !== "bigint" ||
    o.baseAmount <= 0n ||
    o.notionalUsdg <= 0n
  ) {
    return {
      ok: false,
      rule: "non-positive",
      detail: `an open sized ${String(o.baseAmount)} / ${String(o.notionalUsdg)} micro-USDG is not a trade`,
    };
  }
  if (!perpPriceInRange(o.worstPrice) || !perpPriceInRange(o.markPrice) || !Number.isSafeInteger(o.imfBp) || o.imfBp < 1 || o.imfBp > 10_000) {
    return {
      ok: false,
      rule: "perp-order-malformed",
      detail: "the open's prices or margin fraction are outside what a Lighter order can carry.",
    };
  }

  if (p.incident) {
    return {
      ok: false,
      rule: "perp-venue-incident",
      detail:
        "Lighter shows activity on the agent's account that the agent did not do. Nothing new is opened, and open " +
        "positions are being closed, until the key is replaced and the alert is cleared on the dashboard.",
    };
  }
  if (p.entriesHalted) {
    return {
      ok: false,
      rule: "perp-entries-halted",
      detail: "new perpetual positions are paused. Closes and stops still run.",
    };
  }

  // THE MARKET: in the frozen table under this exact key and id, allowed by
  // the owner, and read active this tick. A market whose terms were not read is
  // not active — unknown is never "probably fine".
  const listed = perpMarketByKey(o.market);
  if (listed === null || listed.marketId !== o.marketId || !p.settings.markets.includes(o.market)) {
    return {
      ok: false,
      rule: "perp-market-not-allowed",
      detail: `${String(o.market)} is not one of the perpetual markets you allowed in Settings.`,
    };
  }
  const m = p.markets.get(o.marketId);
  if (m === undefined || m.spec.marketId !== o.marketId || m.status !== "active") {
    return {
      ok: false,
      rule: "perp-market-inactive",
      detail:
        m === undefined
          ? `${o.market}'s venue terms could not be read this tick, so it is not known to be open for trading.`
          : `${o.market} is ${m.status} on Lighter, so nothing new is opened there.`,
    };
  }

  if (perpGrantExpiring(p, limits)) {
    return {
      ok: false,
      rule: "perp-grant-expiring",
      detail: "the signed permission expires within a day, so no new positions are opened. Closes and stops still run.",
    };
  }

  // NEVER ADDS, NEVER FLIPS (rule 6). An open on a market that already holds
  // a position is either an add — one stop sized to the first fill guarding a
  // bigger position — or, on the other side, a reduce wearing an open's clothes.
  const held = p.positions.get(o.marketId);
  if (held !== undefined && held.baseAmount !== 0n) {
    return {
      ok: false,
      rule: "perp-add-to-position",
      detail: `there is already a ${held.side} ${o.market} position; an open never adds to one or flips it.`,
    };
  }
  // NOTHING NEW WHILE THE LAST THING IS UNSETTLED (rule 9): a close still in
  // flight could land after this open and cut it, and an order whose outcome
  // is unknown may already be a position.
  if (p.closeInFlightMarkets.has(o.marketId)) {
    return {
      ok: false,
      rule: "perp-close-in-flight",
      detail: `a close on ${o.market} is not final yet, so nothing new is opened there until it is.`,
    };
  }
  if (p.unresolvedMarkets.has(o.marketId)) {
    return {
      ok: false,
      rule: "perp-close-in-flight",
      detail: `an order on ${o.market} has no final outcome yet, so nothing new is opened there until it does.`,
    };
  }

  // LEVERAGE IS VENUE STATE, NEVER AN ORDER FIELD (rule 6). The venue must
  // read this market ISOLATED at exactly the IMF the owner's setting implies,
  // and the intent must assert that same IMF. The target is re-derived here
  // from the setting and the market's own minimum rather than trusted from the
  // lane: `imfBpTarget` is one more number somebody else computed, and a
  // leverage chosen anywhere but perpsMaxLeverage is a leverage the owner did
  // not choose. Cross margin is refused outright — under cross a loss draws on
  // the whole account and the per-position liquidation below means nothing.
  if (m.venueImfBp === null || m.venueMarginMode !== "isolated") {
    return {
      ok: false,
      rule: "perp-leverage-unset",
      detail:
        `Lighter does not read ${o.market} as isolated margin at a known leverage for this account yet; it is ` +
        `set while the market is flat, and nothing is opened until it reads back.`,
    };
  }
  let targetImf: number | null;
  try {
    targetImf = leverageTarget(p.settings.maxLeverage, m.spec).imfBp;
  } catch {
    targetImf = null;
  }
  if (targetImf === null || o.imfBp !== m.venueImfBp || o.imfBp !== m.imfBpTarget || m.imfBpTarget !== targetImf) {
    return {
      ok: false,
      rule: "perp-leverage-mismatch",
      detail:
        `this open asserts a margin fraction of ${o.imfBp} bp on ${o.market}; the venue reads ${m.venueImfBp} bp and ` +
        `your leverage setting means ${targetImf ?? "none"}. Leverage is changed only while the market is flat.`,
    };
  }

  // THE ORDER'S OWN SHAPE, now that the market's decimals are known. The
  // notional must be at least base × max(worst, mark) — the figure every cap
  // below judges — and the IOC's bound must sit on the right side of the mark
  // and inside the owner's slippage. Either failing is an intent built wrong;
  // judging caps on a number that understates the order is judging a
  // different order.
  const ref = o.worstPrice > o.markPrice ? o.worstPrice : o.markPrice;
  let floorNotional: bigint | null;
  try {
    floorNotional = notionalMicro(o.baseAmount, ref, m.spec, "ceil");
  } catch {
    floorNotional = null;
  }
  if (floorNotional === null || o.notionalUsdg < floorNotional) {
    return {
      ok: false,
      rule: "perp-order-malformed",
      detail: `the open states a notional below its size at the worse of its worst price and the mark.`,
    };
  }
  const maxSlip = BigInt(Number.isSafeInteger(p.settings.maxSlippageBps) && p.settings.maxSlippageBps >= 0 ? p.settings.maxSlippageBps : 0);
  const slipOk =
    o.side === "long"
      ? o.worstPrice >= o.markPrice && (o.worstPrice - o.markPrice) * PERP_BP <= o.markPrice * maxSlip
      : o.worstPrice <= o.markPrice && (o.markPrice - o.worstPrice) * PERP_BP <= o.markPrice * maxSlip;
  if (!slipOk) {
    return {
      ok: false,
      rule: "perp-order-malformed",
      detail: `the open's worst price is on the wrong side of the mark or beyond your ${p.settings.maxSlippageBps} bp slippage.`,
    };
  }

  // EVERY OPEN CARRIES ITS OWN STOP (rule 7): present, on the losing side of
  // both the mark and the worst price, executing no farther from its trigger
  // than perpsStopSlipBps, and triggering no farther from the mark than
  // perpsStopLossPct. The distance is measured from the MARK, the more lenient
  // of the two references a stop can be built from (a long's worst price sits
  // above the mark, a short's below), so the check never refuses a stop built
  // exactly to the owner's setting — and never admits one wider than it.
  // A take-profit, when present, is held to the mirror image.
  const sl = p.settings.stopLossBps;
  const slip = p.settings.stopSlipBps;
  const st = (o as { stopTrigger?: unknown }).stopTrigger;
  const sp = (o as { stopPrice?: unknown }).stopPrice;
  const settingsOk = Number.isSafeInteger(sl) && sl > 0 && sl < 10_000 && Number.isSafeInteger(slip) && slip >= 0 && slip < 10_000;
  let stopOk = false;
  if (settingsOk && perpPriceInRange(st) && perpPriceInRange(sp)) {
    const SL = BigInt(sl);
    const SLIP = BigInt(slip);
    if (o.side === "long") {
      const lo = o.worstPrice < o.markPrice ? o.worstPrice : o.markPrice;
      stopOk = st < lo && sp <= st && (st - sp) * PERP_BP <= st * SLIP && st * PERP_BP >= o.markPrice * (PERP_BP - SL);
    } else {
      const hi = o.worstPrice > o.markPrice ? o.worstPrice : o.markPrice;
      stopOk = st > hi && sp >= st && (sp - st) * PERP_BP <= st * SLIP && st * PERP_BP <= o.markPrice * (PERP_BP + SL);
    }
  }
  const tt = (o as { takeTrigger?: unknown }).takeTrigger;
  const tp = (o as { takePrice?: unknown }).takePrice;
  let takeOk = true;
  if (tt !== undefined || tp !== undefined) {
    takeOk = false;
    if (settingsOk && perpPriceInRange(tt) && perpPriceInRange(tp)) {
      const SLIP = BigInt(slip);
      if (o.side === "long") {
        const hi = o.worstPrice > o.markPrice ? o.worstPrice : o.markPrice;
        takeOk = tt > hi && tp <= tt && (tt - tp) * PERP_BP <= tt * SLIP;
      } else {
        const lo = o.worstPrice < o.markPrice ? o.worstPrice : o.markPrice;
        takeOk = tt < lo && tp >= tt && (tp - tt) * PERP_BP <= tt * SLIP;
      }
    }
  }
  if (!stopOk || !takeOk) {
    return {
      ok: false,
      rule: "perp-stop-required",
      detail:
        (!stopOk
          ? `every open carries its own stop at the venue, on the losing side of the entry, no more than ` +
            `${sl / 100}% from the mark; this one's stop is missing or out of place.`
          : `this open's take-profit is not on the winning side of the entry, or its bound is past your stop slippage.`),
    };
  }

  // THE STOP MUST FIRE BEFORE THE VENUE LIQUIDATES (rule 7), by the owner's
  // buffer, judged on the stop's WORST price (what it fills at, at worst)
  // against the isolated liquidation price estimated at the IOC's worst price
  // (the entry the position can actually get). Margin is taken at that entry
  // and rounded DOWN: less margin puts liquidation nearer the entry, which is
  // the direction that refuses sooner. The maintenance fraction is the
  // market's own constant. Anything the arithmetic cannot judge is refused.
  let beats = false;
  try {
    const notionalAtWorst = notionalMicro(o.baseAmount, o.worstPrice, m.spec, "floor");
    const am = (notionalAtWorst * BigInt(o.imfBp)) / PERP_BP;
    const liq = isolatedLiqPrice({
      side: o.side,
      entryPrice: o.worstPrice,
      baseAmount: o.baseAmount,
      allocatedMarginMicro: am,
      mmfBp: m.mmfBp,
      spec: m.spec,
    });
    beats = stopBeatsLiquidation({
      side: o.side,
      stopPrice: o.stopPrice,
      liqPrice: liq,
      entryPrice: o.worstPrice,
      bufferBps: p.settings.liqBufferBps,
    });
  } catch {
    beats = false;
  }
  if (!beats) {
    return {
      ok: false,
      rule: "perp-stop-inside-liquidation",
      detail:
        `at this leverage Lighter could liquidate ${o.market} before the stop fills — the stop has to beat the ` +
        `liquidation price by your ${p.settings.liqBufferBps / 100}% buffer. A tighter stop or lower leverage fits.`,
    };
  }

  // THE VENUE'S MINIMUM IS NEVER REACHED BY RELAXING A CAP (rule 6). An open
  // too small for the market is refused, and the dashboard says which markets
  // the signed cap can reach.
  if (o.notionalUsdg < m.effMinNotionalMicro || o.baseAmount < m.spec.minBaseAmount) {
    return {
      ok: false,
      rule: "perp-below-min",
      detail: `${money(o.notionalUsdg)} is under Lighter's ${money(m.effMinNotionalMicro)} minimum order on ${o.market}.`,
    };
  }
  // THE CAPS JUDGE EXPOSURE, NOT MARGIN (rule 6). The per-trade figure is the
  // lower of the sealed cap and the owner's perp cap — taken again here from
  // the limits, so a lane that forgot the min() cannot widen it.
  const perTrade = p.settings.perTradeMicro < limits.perTradeUsdg ? p.settings.perTradeMicro : limits.perTradeUsdg;
  if (o.notionalUsdg > perTrade) {
    return {
      ok: false,
      rule: "perp-per-trade-cap",
      detail:
        `this ${money(o.notionalUsdg)} position is over the ${money(perTrade)} most one perp open may be — ` +
        `measured on its full size, not its margin.`,
    };
  }
  if (p.openNotionalMicro + o.notionalUsdg > p.settings.maxOpenNotionalMicro) {
    return {
      ok: false,
      rule: "perp-open-notional-cap",
      detail:
        `${money(p.openNotionalMicro)} is already open across perps; ${money(o.notionalUsdg)} more would pass ` +
        `your ${money(p.settings.maxOpenNotionalMicro)} limit.`,
    };
  }
  // The open's margin judged as NEW commitment: the state does not split free
  // cross collateral from what is committed, so the conservative reading is
  // that none of it is free. Stricter than C + ΣM + T ≤ cap by at most this
  // one margin — the direction that refuses.
  // The producers size to core perpOpenMarginBudgetMicro, which is this very
  // test solved for the margin (S3-COLLATERAL-SIZING-MISMATCH): one
  // arithmetic, so an open sized to the view's room is an open this admits.
  const margin = isolatedMarginMicro(o.notionalUsdg, o.imfBp);
  if (!perpMarginFitsCap(p.committedCollateralMicro, margin, p.settings.maxCollateralMicro)) {
    return {
      ok: false,
      rule: "perp-collateral-cap",
      detail:
        `${money(p.committedCollateralMicro)} is committed at Lighter and this open needs ${money(margin)} of margin, ` +
        `past the ${money(p.settings.maxCollateralMicro)} most you allowed there.`,
    };
  }
  if (!Number.isSafeInteger(p.opensToday) || p.opensToday >= p.settings.maxOpensPerDay) {
    return {
      ok: false,
      rule: "perp-max-opens",
      detail: `${p.opensToday} perp opens in the last 24 hours is your limit of ${p.settings.maxOpensPerDay}.`,
    };
  }
  return null;
}

/**
 * The perp branch: a final verdict, or null for an entry that passed every
 * perp rule and now meets the shared brakes. Exits never return null.
 */
function checkPerpIntent(intent: PerpOrderIntent | PerpMarginIntent, limits: AgentLimits, state: AgentState): Verdict | null {
  if (intent.kind === "perp-margin") {
    if (intent.direction === "withdraw" || intent.direction === "claim") return checkPerpMarginHome(intent, limits, state);
    if (intent.direction === "deposit") return checkPerpDeposit(intent, limits, state);
    return {
      ok: false,
      rule: "perp-order-malformed",
      detail: "a perp margin move is a deposit, a withdrawal or a claim; this one is none of them.",
    };
  }
  return intent.effect === "open" ? checkPerpOpen(intent, limits, state) : checkPerpExit(intent, state);
}

export function checkPolicy(
  intent: TradeIntent,
  limits: AgentLimits,
  state: AgentState,
  scout?: ScoutContext,
): Verdict {
  // PERPS FIRST — before the session key's expiry, which is the one brake here
  // an L2 exit must never meet (rule 8: grant expiry is when the stand-down
  // needs a close and a withdrawal most). Exits get their final verdict now;
  // an open or a deposit that passes its own rules falls through to the shared
  // brakes below, expiry included, exactly as any other entry does.
  if (intent.kind === "perp-order" || intent.kind === "perp-margin") {
    const perpVerdict = checkPerpIntent(intent, limits, state);
    if (perpVerdict !== null) return perpVerdict;
  }

  if (state.nowSec >= limits.expiresAt) {
    return { ok: false, rule: "expiry", detail: "session key expired" };
  }

  const lc = (a: string) => a.toLowerCase();
  // Equity orders have no contract target — their allowlist is tickers, below.
  // An energy buy's one target is judged in its own branch against the route
  // the grant sealed, which is deliberately NOT in allowedTargets (see
  // AgentLimits.energy) — so a `swap` naming the v2 router still stops here.
  // Perp intents were judged above: an L2 order has no target at all, and the
  // one perp leg that does — the deposit — was held to the SEALED proxy, which
  // is deliberately not in allowedTargets (AgentLimits.perp).
  if (
    intent.kind !== "equity-order" &&
    intent.kind !== "energy-buy" &&
    intent.kind !== "perp-order" &&
    intent.kind !== "perp-margin" &&
    !limits.allowedTargets.map(lc).includes(lc(intent.target))
  ) {
    return { ok: false, rule: "target-allowlist", detail: `target ${intent.target} not allowed` };
  }

  // ── the energy buy ──────────────────────────────────────────────────────
  //
  // A MIRROR OF ONE PERMISSION, rule for rule. The wall seals the swap on the
  // router, with the path pinned USDG → VIRTUAL → $MERRYMEN and the output
  // pinned to the account, and funds it through the ONE capped USDG approve —
  // so the questions here are: did the grant seal it at all, is this that
  // router, are these those legs, and is the size a size. What it does NOT ask
  // is stated as carefully, because each would make this mirror STRICTER than
  // the chain:
  //
  //   asset-allowlist (the watch set) — $MERRYMEN is never watched, by design;
  //   no-exit — the key can never sell it, by design (recover moves it);
  //   scout — the budget on unpriceable POSITIONS, and this is not one.
  //
  // The caps below it (ops, per-trade, daily) and the drawdown breaker DO apply
  // — it is a spend, and not an exit — exactly as they would to any buy.
  if (intent.kind === "energy-buy") {
    if (!limits.energy) {
      return {
        ok: false,
        rule: "energy-not-granted",
        detail:
          "this signed key has no energy route — it was signed before the energy buy existed, off Robinhood Chain, " +
          "or without room for it. Re-sign at /grant, or send $MERRYMEN to the account directly.",
      };
    }
    if (lc(intent.target) !== lc(limits.energy.router)) {
      return { ok: false, rule: "target-allowlist", detail: `target ${intent.target} is not the sealed energy router` };
    }
    if (
      limits.cashToken === undefined ||
      lc(intent.sellToken) !== lc(limits.cashToken) ||
      lc(intent.buyToken) !== lc(limits.energy.token)
    ) {
      return {
        ok: false,
        rule: "asset-allowlist",
        detail: `the energy route is USDG → $MERRYMEN only; ${intent.sellToken} → ${intent.buyToken} is not it`,
      };
    }
    // POSITIVITY, and the one identity this kind has: its input IS USDG, so the
    // notional the caps judge and the amount the router pulls are one number.
    // A difference could only be an intent built wrong — and the caps would
    // then be judging a figure the chain never sees.
    if (intent.sellAmountRaw <= 0n || intent.notionalUsdg !== intent.sellAmountRaw) {
      return {
        ok: false,
        rule: "non-positive",
        detail: `energy buy sized ${intent.sellAmountRaw} raw / ${intent.notionalUsdg} USDG is not a trade`,
      };
    }
  }

  if (intent.kind === "equity-order") {
    if (intent.notionalUsdg <= 0n) {
      return { ok: false, rule: "order-amount", detail: "order notional must be positive" };
    }
    // Ticker allowlist — the broker rail's analog of allowedAssets. Optional
    // for the same reason sellableAssets is (backtests and fixtures have no
    // grant to reason about); NEVER leave it undefined on a live broker path.
    // Step 4 of the adapter plan makes it a first-class part of the retyped
    // limits — until then this is the whole asset wall on this rail.
    if (limits.allowedTickers) {
      const up = intent.ticker.toUpperCase();
      if (!limits.allowedTickers.some((t) => t.toUpperCase() === up)) {
        return { ok: false, rule: "ticker-allowlist", detail: `ticker ${intent.ticker} not allowed` };
      }
    }
  }

  // ── curve trades ────────────────────────────────────────────────────────
  //
  // THIS BLOCK EXISTS BECAUSE THE MIRROR WAS LOOSER THAN THE CHAIN.
  //
  // Every asset rule below used to sit inside `if (intent.kind === "swap")`,
  // so a curve trade reached the bundler having passed no asset check at all.
  // The chain would still refuse it -- wall.ts pins both legs ONE_OF the
  // sealed list -- but limits.ts:27-41 records that the mirror going LOOSER
  // than the chain is the one direction that is never safe, and the cost of
  // discovering it on chain is a wasted UserOp and a `gas-unreadable` refusal
  // that names nothing.
  //
  // GATED ON sellableAssets, NOT allowedAssets, and the distinction is the
  // whole point. allowedAssets is [USDG, ...watchTokens] and watchTokens comes
  // from SETTINGS (limits.ts:78), which hot-reload with no signature.
  // sellableAssets comes from the GRANT (grant.ts:344), which is what the wall
  // actually sealed. Checking the settings-derived list here would reproduce
  // exactly the bug this block is closing: an owner adds a token in /settings,
  // does not re-sign, and gets a curve buy that passes every off-chain check
  // and reverts at the wall.
  if (intent.kind === "curve-trade") {
    // Positivity. equity-order has one of these; curve-trade did not, so a zero
    // or negative size would sail through every cap below (they are all upper
    // bounds) and be signed.
    if (intent.amountInRaw <= 0n || intent.notionalUsdg <= 0n) {
      return {
        ok: false,
        rule: "non-positive",
        detail: `curve trade sized ${intent.amountInRaw} raw / ${intent.notionalUsdg} USDG is not a trade`,
      };
    }

    // IS THIS A CLASS TRADE? The TARGET decides, and nothing else does.
    //
    // A class trade is one aimed at the per-account vault the grant sealed. The
    // vault is the only target that can hold a token nobody enumerated and still
    // sell it back — see PonsClassVault.sol — so the asset rule below reads
    // differently for it. `target-allowlist` above has already established that
    // this address is one the grant permits at all; this only asks WHICH of the
    // permitted targets it is.
    //
    // Absent `ponsClassVault` (no class marker, or a grant signed before the
    // feature existed) this is false for every trade and the strict both-legs
    // rule is the only rule there is.
    const isClassTrade =
      limits.ponsClassVault !== undefined && lc(intent.target) === lc(limits.ponsClassVault);

    if (limits.sellableAssets) {
      const sellable = limits.sellableAssets.map(lc);
      const unenumerated = [intent.assetIn, intent.assetOut].filter(
        (token) => !sellable.includes(lc(token)),
      );

      if (!isClassTrade && unenumerated.length > 0) {
        return {
          ok: false,
          rule: "asset-allowlist",
          detail:
            `asset ${unenumerated[0]} is not in the signed grant, so the wall will refuse this ` +
            `trade. Add it at /settings and re-sign the grant at /grant to cover it.`,
        };
      } else if (isClassTrade && unenumerated.length > 1) {
        // A CLASS TRADE MAY LEAVE EXACTLY ONE LEG UN-ENUMERATED — the class
        // token itself, which by definition did not exist when the grant was
        // signed and so could never have been named in it.
        //
        // The other leg is the anchor, and it stays enumerated on BOTH shapes:
        // on a buy it is the funding asset, which the wall pins ONE_OF the
        // sealed list (wall.ts, the class `buy` permission); on a sell the wall
        // pins nothing at all, because the vault can only sell what it holds
        // and can only pay its own owner — so requiring the proceeds to be a
        // sealed asset here is a mirror STRICTER than the chain, which is the
        // one direction that is always safe.
        //
        // Both legs un-enumerated is the case that has no honest reading: it is
        // either funding a class buy out of another class token, or selling one
        // into another, and both end with the account holding something no rule
        // above ever vouched for.
        return {
          ok: false,
          rule: "asset-allowlist",
          detail:
            `neither ${intent.assetIn} nor ${intent.assetOut} is in the signed grant. A class ` +
            `trade may leave the class token itself un-enumerated, but the other leg has to be ` +
            `an asset the grant sealed — otherwise nothing in this trade is anchored to it.`,
        };
      }
    }

    // CURVE PROVENANCE. `intent.target` is the adapter and is covered by the
    // target allowlist above; `intent.curve` is covered by nothing, on chain or
    // off. This turns the incidental factory-filter property into an enforced
    // one, before any producer exists that could source a curve elsewhere.
    if (limits.knownCurves) {
      if (!limits.knownCurves.map(lc).includes(lc(intent.curve))) {
        return {
          ok: false,
          rule: "curve-provenance",
          detail:
            `curve ${intent.curve} was not seen in a factory-filtered launch, so nothing vouches ` +
            `for it being a Pons curve at all. The wall cannot pin this argument, which is exactly ` +
            `why it is checked here.`,
        };
      }
    } else if (isClassTrade) {
      // FAIL CLOSED, and only here does the inversion matter enough to state.
      //
      // Everywhere else in this file an absent list means "the rule cannot run"
      // and the trade is judged by the rules that can — safe, because some other
      // rule still names every asset involved. A class trade is the one shape
      // where that is not true: its output leg is deliberately un-enumerated, so
      // the factory-filtered launch feed is the ONLY thing that vouches for the
      // token existing at all. With `knownCurves` undefined, a class trade has
      // exactly zero provenance, and skipping the check would turn the missing
      // list into a pass.
      return {
        ok: false,
        rule: "curve-provenance",
        detail:
          `a class trade cannot be judged without the launch feed: its output leg is not in the ` +
          `grant by design, so the curve's provenance is the only thing vouching for it. ` +
          `knownCurves is unreadable, which is not the same as this curve being known.`,
      };
    }
  }

  if (intent.kind === "swap") {
    // POSITIVITY, AND IT IS NOT DECORATION.
    //
    // curve-trade, equity-order and transfer each carry this guard; `swap` —
    // the oldest and most-travelled branch — never got the line, because until
    // now every swap was sized by a strategy rather than by a person. An
    // owner-typed order changes that: a caller now chooses the number.
    //
    // A negative size passes EVERY cap below, because every cap below is an
    // upper bound: `-25000000n > perTradeUsdg` is false, and it goes on to
    // REDUCE the day's spend against the daily cap — so the accounting is what
    // gets fooled, not just the trade. It would die eventually in viem's
    // uint256 encoding, which makes the refusal a stack trace instead of a
    // rule, on a path where the rule is what the owner is shown.
    if (intent.sellAmountRaw <= 0n || intent.notionalUsdg <= 0n) {
      return {
        ok: false,
        rule: "non-positive",
        detail: `swap sized ${intent.sellAmountRaw} raw / ${intent.notionalUsdg} USDG is not a trade`,
      };
    }

    const autonomous = intent.custody === "trencher";
    if (autonomous) {
      const cash = limits.cashToken?.toLowerCase();
      const selling = lc(intent.buyToken) === cash;
      const buying = lc(intent.sellToken) === cash;
      const asset = selling ? intent.sellToken : intent.buyToken;
      if (!limits.trencherVault || lc(intent.target) !== lc(limits.trencherVault) || selling === buying ||
          !limits.knownTrencherAssets?.map(lc).includes(lc(asset))) {
        return {ok:false,rule:"asset-allowlist",detail:"Autonomous trade requires the sealed vault and a chain-verified asset"};
      }
      if (buying && (intent.sellAmountRaw > 5_000_000n || intent.notionalUsdg !== intent.sellAmountRaw)) {
        return {ok:false,rule:"per-trade-cap",detail:"Autonomous entry exceeds its cash bound"};
      }
    }
    for (const token of autonomous ? [] : [intent.sellToken, intent.buyToken]) {
      if (!limits.allowedAssets.map(lc).includes(lc(token))) {
        return { ok: false, rule: "asset-allowlist", detail: `asset ${token} not allowed` };
      }
    }

    // NEVER ENTER A POSITION THE KEY CANNOT EXIT.
    //
    // Buying spends USDG, which every grant can approve generically; selling
    // needs a per-token approve sealed into the signature. So a token with a
    // live pool but no approve permission buys fine and can never be sold —
    // the exit reverts at the wall, and no cap or breaker helps, because the
    // owner's money is in an asset the agent has no way to give back.
    //
    // This is checked here rather than left to the on-chain policy on purpose:
    // on-chain, the failure lands on the SELL, long after the buy succeeded and
    // the position exists. Refusing the buy is the only moment it's still free.
    //
    // Sells are never blocked by this rule — an exit must always be attemptable.
    if (!autonomous && limits.sellableAssets) {
      const sellable = limits.sellableAssets.map(lc);
      if (!sellable.includes(lc(intent.buyToken))) {
        return {
          ok: false,
          rule: "no-exit",
          detail:
            `refusing to buy ${intent.buyToken}: this key can't approve it for a sell, ` +
            `so the position could be opened and never closed. Re-sign the grant at /grant to cover it.`,
        };
      }
    }

  }

  // BUYING SOMETHING NOBODY CAN PRICE — AT EITHER VENUE.
  //
  // A token the tick couldn't value is one whose worth is genuinely unknown:
  // its pool is too new or too thin for a TWAP anyone should trust. The
  // drawdown breaker cannot protect that money, because protecting it would
  // mean believing the price it just refused. So the scout BUDGET is the only
  // control there is, and it has to bite here — before the position exists.
  //
  // OUT OF THE SWAP BRANCH, where it used to live. A curve trade skipped it
  // entirely, which was survivable only while the sole producer of one was an
  // owner typing it into chat — a person spending their own money, deliberately.
  // The moment the strategist can emit one, this is the difference between a
  // budgeted buy and an autonomous unbudgeted buy into the least priceable
  // assets on the chain. A curve mark is also barred from ratcheting the
  // high-water mark, so the breaker measures that book from a lower reference
  // and cannot be the backstop instead.
  //
  // Sells are untouched at both venues: the caller only ever reports
  // `buyUnpriceable` about the asset being ACQUIRED, so getting out of an
  // unpriceable position is never blocked by this.
  //
  // THAT SENTENCE WAS ONCE FALSE. The caller decided "class buy" from the
  // target alone, so a vault SELL arrived here flagged unpriceable and its
  // proceeds were budgeted as a purchase. The side is now judged from the
  // intent's assets in class-side.ts (`scoutFlagsFor`), and class-side.test.ts
  // drives that classifier into this rule — so the invariant above is enforced
  // upstream rather than assumed here.
  // The two venues that ACQUIRE an asset. Named explicitly rather than relying
  // on `scout` being undefined elsewhere: a vault movement has no notional to
  // judge, and a future kind that does should have to opt in here on purpose.
  // `energy-buy` has not, deliberately: $MERRYMEN is never a position, so a
  // budget on unpriceable POSITIONS has nothing to say about it.
  if (scout?.buyUnpriceable && (intent.kind === "swap" || intent.kind === "curve-trade")) {
    const verdict = scoutAllows(
      {
        spendUsdg: intent.notionalUsdg,
        existingCostUsdg: scout.existingCostUsdg,
        quarantinedUsdg: scout.quarantinedUsdg,
      },
      scout.limits,
    );
    if (!verdict.ok) return { ok: false, rule: "scout-budget", detail: verdict.reason };
  }

  if (intent.kind === "transfer") {
    // Must at least be a plausible address — garbage never reaches calldata.
    if (!/^0x[0-9a-fA-F]{40}$/.test(intent.recipient)) {
      return { ok: false, rule: "transfer-recipient", detail: `recipient ${intent.recipient} is not an address` };
    }
    // MIRROR of the on-chain withdrawal allowlist. The wall now pins the USDG
    // transfer recipient to the addresses the owner registered at signing, and
    // carries no transfer permission at all when none were. Checking it here
    // too costs nothing and turns an opaque on-chain revert into a sentence
    // that says what to do — the same reason the rest of this file exists.
    //
    // Undefined means "this grant predates the allowlist", NOT "allow
    // anything": such a grant genuinely has the old free-form permission, and
    // a mirror stricter than the chain would reject trades the wall permits.
    if (limits.withdrawalAddresses) {
      if (limits.withdrawalAddresses.length === 0) {
        return {
          ok: false,
          rule: "transfer-not-permitted",
          detail:
            "this wall carries no transfer permission — no withdrawal addresses were registered when it was signed. " +
            "Re-sign the grant with a destination, or move funds with your owner key (`merrymen recover`).",
        };
      }
      const to = intent.recipient.toLowerCase();
      if (!limits.withdrawalAddresses.some((a) => a.toLowerCase() === to)) {
        return {
          ok: false,
          rule: "transfer-recipient-allowlist",
          detail: `${intent.recipient} is not one of the registered withdrawal addresses on this wall`,
        };
      }
    }
    if (intent.amountUsdg <= 0n) {
      return { ok: false, rule: "transfer-amount", detail: "transfer amount must be positive" };
    }
  }

  // ── THE ONE EXIT THE CHAIN DOES NOT SIZE ────────────────────────────────
  //
  // Computed here rather than below because the SIZE caps need it too, and
  // this is the narrower question than the breaker's `isExit` further down.
  //
  // WHY THIS IS A MIRROR FIX AND NOT A LOOSENED RAIL. The comment under this
  // one states this file's contract: the per-op ceiling "mirrors the on-chain
  // call policy EXACTLY, because a stricter mirror rejects trades the chain
  // would happily allow (a real bug per this file's contract)". It then lists
  // "swaps & transfers → approve/transfer USDG capped at the PER-TRADE limit",
  // which is true of the USDG approve — the BUY leg. The SELL leg is a
  // different permission, and wall.ts emits it with an explicit `null` amount
  // argument under the comment "No amount condition". So the chain does not
  // bound the size of a sell, and this file was bounding it anyway.
  //
  // WHAT THAT COST. A trencher entry is 5 USDG against a 10 USDG per-trade cap.
  // Hit the -35% stop and the exit is worth ~3.25 and passes; hit the +100%
  // take-profit and it is worth ~10.0x and is refused with `per-trade-cap`,
  // every tick, forever. The agent was structurally able to exit its losers and
  // structurally unable to exit its winners — the exact inverse of what an
  // owner asks for, and it would have been invisible as a stuck position rather
  // than as an error.
  //
  // DELIBERATELY NARROWER THAN `isExit` BELOW. A `transfer` is genuinely capped
  // on chain (wall.ts:421-425, LESS_THAN_OR_EQUAL perTradeUsdg) and an
  // `equity-order` has no wall permission at all, so neither is exempt here
  // even though the breaker rightly treats both as exits. The exemption is only
  // where the chain's own permission carries no amount condition. Buys are
  // untouched: that cap is real, it is on chain, and it stays.
  //
  // PERP EXITS BELONG HERE TOO, and never actually arrive: the perp branch at
  // the top returns their verdict before any cap. They are named anyway so
  // that no refactor that routes one through this block can cap it — a
  // reduce-only close and a withdrawal are L2 requests no wall permission
  // sizes, and a claim's withdrawPendingBalance amount is pinned open.
  const isUnsizedExit =
    (intent.kind === "swap" &&
      limits.cashToken !== undefined &&
      lc(intent.buyToken) === lc(limits.cashToken)) ||
    (intent.kind === "curve-trade" &&
      ((limits.cashToken !== undefined && lc(intent.assetOut) === lc(limits.cashToken)) ||
        (limits.quoteAssets !== undefined && limits.quoteAssets.map(lc).includes(lc(intent.assetOut))))) ||
    (intent.kind === "perp-order" && intent.reduceOnly === true) ||
    (intent.kind === "perp-margin" && (intent.direction === "withdraw" || intent.direction === "claim"));

  // A RATE LIMIT MUST NOT BECOME A LOCK ON THE DOORS — the same sentence the
  // drawdown breaker below is written under. This one is purely off-chain: the
  // rate-limit policy contract has no bytecode on 4663 and was removed from the
  // wall for that reason, so it is a worker-side brake on taking risk. On the
  // shipped defaults (25 USDG a tick against 24 ops a day) an agent that spent
  // its budget buying could not sell until the day rolled.
  if (!isUnsizedExit && state.opsToday >= limits.maxOpsPerDay) {
    return { ok: false, rule: "ops-cap", detail: `${state.opsToday} ops in 24h >= ${limits.maxOpsPerDay}` };
  }

  // Per-op size ceiling — mirrors the on-chain call policy EXACTLY, because a
  // stricter mirror rejects trades the chain would happily allow (a real bug per
  // this file's contract). On-chain (web/src/lib/session.ts):
  //   • swaps & transfers  → approve/transfer USDG capped at the PER-TRADE limit
  //   • vault deposits      → capped at the DAILY limit (parking idle cash in the
  //                           Morpho vault isn't a market spend; it's reversible)
  //   • vault withdrawals   → unsized (funds return to the account)
  // The old mirror capped deposits at the per-trade limit, so a large idle-cash
  // sweep (e.g. 80 USDG with a 30-USDG per-trade cap) was rejected every tick
  // while the chain would have accepted it.
  if (intent.kind !== "vault-withdraw") {
    // Equity orders count on BOTH sides, like swaps: a sell is still an op and
    // still market exposure, and on this rail these caps are the only wall.
    //
    // AN ENERGY BUY is judged against the per-trade cap because that IS its
    // on-chain ceiling: the router pulls USDG through the one USDG approve,
    // which the wall caps LESS_THAN_OR_EQUAL perTradeUsdg — so an amount
    // exactly at the cap passes here as it passes there.
    //
    // A PERP OPEN reaches this line only after its own branch passed it, and
    // is judged on its full notional (rule 6: caps judge exposure, not
    // margin). A perp exit never reaches it. A MARGIN DEPOSIT is judged on its
    // amount against perTradeUsdg — the approve the wall caps it with — and
    // counts toward the day's spend like a vault deposit: it is the money that
    // can be lost at the venue (rule 4).
    const notional =
      intent.kind === "swap" ||
      intent.kind === "equity-order" ||
      intent.kind === "curve-trade" ||
      intent.kind === "energy-buy" ||
      intent.kind === "perp-order"
        ? intent.notionalUsdg
        : intent.amountUsdg;
    const isDeposit = intent.kind === "vault-deposit";
    const perOpCap = isDeposit ? limits.dailyUsdg : limits.perTradeUsdg;
    // See isUnsizedExit: the chain caps the USDG approve that funds a BUY, and
    // emits the sell-side approve with no amount condition at all. Capping a
    // sell here was the mirror being stricter than the chain, which this file's
    // own contract calls a real bug — and it refused every winning exit.
    if (!isUnsizedExit && notional > perOpCap) {
      return {
        ok: false,
        rule: isDeposit ? "deposit-cap" : "per-trade-cap",
        detail:
          `this ${money(notional)} ${isDeposit ? "deposit" : "trade"} is over the ` +
          `${money(perOpCap)} ${isDeposit ? "daily" : "per-trade"} cap. That cap is sealed into ` +
          `the signature — raising it means re-signing at /grant.`,
      };
    }
    // The day's budget is a bound on what may be SPENT. A sell spends nothing —
    // it returns cash — so counting it against the same allowance meant an
    // agent that used its budget entering could not leave until the day rolled,
    // which is the lock-in the breaker below refuses by name.
    if (!isUnsizedExit && state.spentTodayUsdg + notional > limits.dailyUsdg) {
      // WRITTEN FOR THE PERSON WHO HAS TO READ IT. This said
      // `would exceed daily cap 50000000` — a raw 6dp bigint, no units, no
      // remaining balance, no reset — and index.ts prints the detail verbatim
      // into the owner's feed. "Fifty million" is what an owner of a 50 USDG
      // agent saw, up to three times a tick, all day.
      //
      // The numbers that answer the actual question are all right here: what
      // has gone, what the allowance was, and what this trade would have added.
      return {
        ok: false,
        rule: "daily-cap",
        detail:
          `spent ${money(state.spentTodayUsdg)} of the ${money(limits.dailyUsdg)} daily budget; ` +
          `this ${money(notional)} buy would go over it. Exits are never blocked by this — ` +
          `the budget bounds what may be SPENT, and it rolls 24h from the first spend.`,
      };
    }
  }

  // AN EXIT MUST ALWAYS BE ATTEMPTABLE — see isExitIntent above checkPolicy,
  // where the predicate and its reasons now live so the energy gate asks the
  // same question the breaker does.
  const isExit = isExitIntent(intent, limits);

  // THE BREAKER'S STAND-IN WHILE THE VENUE IS DARK (rule 11; see
  // AgentState.perpVenueUnread). Beside the breaker and after the caps on
  // purpose: a trade that breaks a cap still says so, because that is the more
  // useful fact about it, and an exit is judged by the same `isExit` the
  // breaker uses — so the sell that clears a position is never the thing an
  // outage at Lighter blocks.
  // Only a READ zero lets a non-exit through; undefined and null are not zero.
  if (!isExit && state.perpVenueUnread === true && state.perpLastKnownMicro !== 0n) {
    return {
      ok: false,
      rule: "perp-unpriced",
      detail:
        "Lighter could not be read this tick, and money was at the venue when it last was — without it the book " +
        "cannot be totalled or its drawdown judged, so nothing new is opened until it reads. Exits still go out.",
    };
  }

  if (!isExit && state.highWaterMarkUsdg > 0n && state.equityKnown !== false) {
    const drawdownBps = Number(
      ((state.highWaterMarkUsdg - state.equityUsdg) * 10_000n) / state.highWaterMarkUsdg,
    );
    if (drawdownBps >= limits.maxDrawdownBps) {
      return { ok: false, rule: "drawdown-breaker", detail: `${drawdownBps}bps >= ${limits.maxDrawdownBps}bps` };
    }
  }

  return { ok: true };
}
