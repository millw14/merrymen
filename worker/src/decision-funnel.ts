/**
 * WHERE A COIN STOPPED — the decision funnel, and the answer to "why did you
 * skip that coin?".
 *
 * The Trencher's path from a pool on the tape to a fill crosses a dozen
 * gates, and until this file most of them said nothing when they shut: the
 * volume screen, the discovery slice, a candidate missing its FDV, a vault
 * budget that could not be read, a Brain review dropped by `take()`, a gate
 * that forced a hold. The owner's report was the only measurement there was:
 * "Shogun says no to everything". From the outside, "nothing qualified",
 * "the gate refused the book" and "the order expired before the tick took it"
 * are the same silence, and they have three different remedies.
 *
 * So every exit is FILED, under the coin, in the vocabulary `FunnelStage`
 * (fomo/types.ts) fixes — with the precise original reason kept verbatim in
 * `detail`, because the stage says which department and the detail says
 * which rule. Nothing here re-decides anything: each classification is a
 * reading of a verdict some other module already reached, and no gate,
 * threshold or limit is read from or written to by this file.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────
 *
 * Not accounting and not a ledger. It lives in one process's memory, bounded
 * (a ring per coin, a bounded set of coins), and a restart forgets it. The
 * durable record of what was DECIDED is the decisions table; this is the
 * record of where candidates fell out between decisions, which no table
 * holds. Symbols and details that came from outside are sanitised on the way
 * in and are data, never instructions.
 *
 * ── HOW OTHER CODE READS IT ─────────────────────────────────────────────
 *
 * index.ts creates one recorder in main() and installs it here; a reader in
 * the same process (the Telegram chat tools) calls `decisionFunnel()` and
 * gets that instance or null — never a fresh empty one that would answer
 * "never seen" about a coin the desk looked at a minute ago.
 */
import type { FunnelStage } from "./fomo/types";
import { sanitizeText } from "./research/news";
import { recordedHoldKind, type ShadowOutcome } from "./brain-shadow";
import { highVolumePools, TRENCH_H1_VOLUME_MIN, TRENCH_VOLUME_MIN, type TrenchScreen } from "./trencher-brain";
import type { GeckoPool } from "./venues/geckoterminal";
import { CASH } from "../../packages/core/src/index";

/**
 * The stages, plus one that is not a stop.
 *
 * BRAIN_APPROVED marks a review that said BUY (or SELL) and handed an order
 * to the strategy tick. It is not where a coin stopped — something after it
 * always decides — and it is kept so that the something can be missing: an
 * approval with nothing filed after it is an order that vanished without a
 * word (see `FunnelSummary.approvalsWithoutOutcome`).
 */
export type FunnelStep = FunnelStage | "BRAIN_APPROVED";

/** A verdict, read into the funnel's vocabulary. `detail` is `code` or `code: original words`. */
export interface Classified {
  stage: FunnelStep;
  detail: string;
  paper?: boolean;
  decisionId?: string | null;
  candidateAction?: string | null;
  enforcedAction?: string | null;
}

/** The skips the Trencher candidate builder used to make in silence (index.ts trenchCandidates). */
export type CandidateSkip =
  | "not-watched"
  | "asset-allowlist"
  | "no-exit"
  | "missing-created-at"
  | "created-at-in-future"
  | "missing-fdv"
  | "autonomous-budget-spent"
  | "autonomous-budget-unread"
  | "token-paused";

/** Discovery's own screens: the tape screen, the verified slice, and the venue. */
export type DiscoveryScreen = TrenchScreen | "beyond-discovery-slice" | "pool-not-verified" | "venue-not-supported";

/** Whole-tick reasons no coin was reviewed or entered at all. */
export type TickBlock =
  | "brain-not-configured"
  | "book-incomplete"
  | "review-energy-spent"
  | "drawdown-breaker"
  | "entries-energy-spent";

export type FunnelInput =
  | {
      kind: "brain-decision";
      action: string;
      /** The kind the LEDGER records (brain-shadow.ts recordedHoldKind), not necessarily the Brain's. */
      holdKind?: string | null;
      gateVerdict?: string | null;
      proposedAction?: string | null;
      held?: boolean;
      decisionId?: string | null;
    }
  | { kind: "brain-refusal"; reason: string }
  | { kind: "brain-failure"; failure: "unreachable" | "malformed" }
  | { kind: "policy"; rule: string }
  | { kind: "execution"; rule: string }
  | { kind: "trade"; status: string; rejectRule?: string | null }
  | { kind: "take-drop"; reason: string }
  | { kind: "discovery"; screen: DiscoveryScreen; venue?: string | null }
  | { kind: "entry-screen"; why: string }
  | { kind: "candidate-skip"; skip: CandidateSkip }
  | { kind: "not-on-tape" }
  | { kind: "size-below-floor"; sizeUsdg6: bigint; floorUsdg6: bigint }
  | { kind: "tick-block"; block: TickBlock };

const DETAIL_MAX = 200;
const SYMBOL_MAX = 32;

/** `code: words`, bounded, with the words sanitised — they are often somebody else's. */
function detailOf(code: string, words?: string | null): string {
  const w = words ? sanitizeText(words, DETAIL_MAX) : "";
  return sanitizeText(w && w !== code ? `${code}: ${w}` : code, DETAIL_MAX);
}

/**
 * THE RULE TABLE: every refusal the wall (policy.ts), the rail
 * (exec-mode.ts RefuseRule) and the execution path (index.ts reject_rule)
 * can write, mapped once. Rules not listed fall to the context default
 * below rather than being guessed at.
 */
const RULE_STAGE: Readonly<Record<string, FunnelStage>> = {
  // The wall: what this key may touch at all.
  "asset-allowlist": "PERMISSION_BLOCKED",
  "target-allowlist": "PERMISSION_BLOCKED",
  "ticker-allowlist": "PERMISSION_BLOCKED",
  "curve-provenance": "PERMISSION_BLOCKED",
  "energy-not-granted": "PERMISSION_BLOCKED",
  expiry: "PERMISSION_BLOCKED",
  "transfer-not-permitted": "PERMISSION_BLOCKED",
  "transfer-recipient": "PERMISSION_BLOCKED",
  "transfer-recipient-allowlist": "PERMISSION_BLOCKED",
  // The rail: the agent is not in a state to trade for real.
  "not-armed": "PERMISSION_BLOCKED",
  "dead-policy": "PERMISSION_BLOCKED",
  "grant-too-wide": "PERMISSION_BLOCKED",
  "live-not-enabled": "PERMISSION_BLOCKED",
  "group-nomination-resolved": "PERMISSION_BLOCKED",
  // Money and counts: a limit that was reached, not a rule that forbids.
  "per-trade-cap": "BUDGET_EXHAUSTED",
  "deposit-cap": "BUDGET_EXHAUSTED",
  "daily-cap": "BUDGET_EXHAUSTED",
  "ops-cap": "BUDGET_EXHAUSTED",
  "scout-budget": "BUDGET_EXHAUSTED",
  "drawdown-breaker": "BUDGET_EXHAUSTED",
  "transfer-daily-cap": "BUDGET_EXHAUSTED",
  "no-cash": "BUDGET_EXHAUSTED",
  "energy-needs-live": "BUDGET_EXHAUSTED",
  "entry-energy-withheld": "BUDGET_EXHAUSTED",
  "group-entry-cap": "BUDGET_EXHAUSTED",
  // A size that is not a trade.
  "non-positive": "SIZE_BELOW_ECONOMIC_FLOOR",
  "order-amount": "SIZE_BELOW_ECONOMIC_FLOOR",
  "transfer-amount": "SIZE_BELOW_ECONOMIC_FLOOR",
  // No way in or no way out on a venue we can use.
  "no-exit": "UNSUPPORTED_ROUTE",
  "wrong-chain": "UNSUPPORTED_ROUTE",
  "no-route": "UNSUPPORTED_ROUTE",
  "impact-cap": "UNSUPPORTED_ROUTE",
  "impact-unknown": "UNSUPPORTED_ROUTE",
  "no-quote": "UNSUPPORTED_ROUTE",
  "router-migrated": "UNSUPPORTED_ROUTE",
  "no-curve-adapter": "UNSUPPORTED_ROUTE",
  "no-rialto-key": "UNSUPPORTED_ROUTE",
  "energy-no-quote": "UNSUPPORTED_ROUTE",
  "energy-tax": "UNSUPPORTED_ROUTE",
  "energy-tax-unreadable": "UNSUPPORTED_ROUTE",
  // The house failing to pay a fee is not the wall refusing.
  "sponsor-refused": "SPONSORSHIP_UNAVAILABLE",
  "sponsor-unreachable": "SPONSORSHIP_UNAVAILABLE",
  "sponsor-absurd": "SPONSORSHIP_UNAVAILABLE",
  // Built, then not sent (or not sendable).
  "no-gas": "SUBMISSION_FAILED",
  "no-executor": "SUBMISSION_FAILED",
  "not-recorded": "SUBMISSION_FAILED",
  "nonce-changed": "SUBMISSION_FAILED",
  // Sent, and its fate not yet read back.
  "receipt-unresolved": "SETTLEMENT_PENDING",
};

/**
 * A refusal rule into a stage. Policy rules are a closed list, so an unknown
 * one in policy context is named as unclassified under PERMISSION_BLOCKED;
 * anything else unknown arose after the wall approved — the gas pre-flight's
 * open vocabulary (`gas-*`, `enable-*`), a revert class re-applied by the
 * suppression map — and is a submission that did not happen.
 */
function ruleStage(rule: string, context: "policy" | "execution"): Classified {
  const r = typeof rule === "string" ? rule.trim() : "";
  const known = RULE_STAGE[r];
  if (known) return { stage: known, detail: detailOf(r) };
  if (r.startsWith("fence-")) return { stage: "SUBMISSION_FAILED", detail: detailOf(r) };
  if (r.startsWith("paper: ")) return { stage: "SUBMISSION_FAILED", detail: detailOf("paper-fill-refused", r.slice(7)), paper: true };
  if (r.startsWith("review: ")) return { stage: "SUBMISSION_FAILED", detail: detailOf("broker-review-refused", r.slice(8)) };
  if (context === "policy") return { stage: "PERMISSION_BLOCKED", detail: detailOf("unclassified-rule", r || "unknown") };
  return { stage: "SUBMISSION_FAILED", detail: detailOf(r || "unknown-rule") };
}

/**
 * `take()`'s drop reasons (trencher-brain.ts), each read to a code. Matched on
 * the words that function writes; decision-funnel.test.ts drives the real
 * `take()` so a reworded reason fails a test instead of landing as
 * `order-dropped`.
 */
const DROP_CODES: readonly [RegExp, FunnelStage, string][] = [
  [/whether it is held changed/, "RESEARCH_INCOMPLETE", "held-changed"],
  [/context changed/, "RESEARCH_INCOMPLETE", "context-changed"],
  [/past the \d+s a review stays valid/, "RESEARCH_INCOMPLETE", "order-expired"],
  [/no usable mark/, "RESEARCH_INCOMPLETE", "no-mark"],
  [/does not match the coin or agent/, "RESEARCH_INCOMPLETE", "identity-mismatch"],
  [/no usable price to compare/, "RESEARCH_INCOMPLETE", "no-review-price"],
  [/^price moved/, "RESEARCH_INCOMPLETE", "price-moved"],
  [/superseded by a newer review/, "RESEARCH_INCOMPLETE", "superseded"],
  [/portfolio gate did not permit/, "GATE_FORCED_HOLD", "gate-refused-order"],
  [/floor for a trade worth making|below the trade floor|rounds to nothing/, "SIZE_BELOW_ECONOMIC_FLOOR", "size-below-floor"],
  [/ceiling for this agent is zero/, "BUDGET_EXHAUSTED", "ceiling-zero"],
  [/sell of a coin that is not held/, "UNSUPPORTED_ROUTE", "short-unsupported"],
  [/unknown action|sizes a sell|sizes a buy|size is not a number|not a symbol I can look up|not finite valid amounts/, "RESEARCH_INCOMPLETE", "invalid-order"],
];

/** `shouldEnter`'s refusals (strategies/trencher.ts), read to codes. Unpriceable is the rest. */
const ENTRY_CODES: readonly [RegExp, string][] = [
  [/^incomplete market data/, "incomplete-market-data"],
  [/ deep$/, "liquidity-below-min"],
  [/nothing there yet/, "fdv-below-min"],
  [/priced past a new launch/, "fdv-above-max"],
  [/too early to read/, "too-young"],
  [/not a new pair any more/, "too-old"],
  [/price|priced|quote|venue|feed|watched|oracle/i, "unpriceable"],
];

const DISCOVERY_WORDS: Readonly<Record<DiscoveryScreen, string>> = {
  "quote-asset": "a cash or bridge asset, never an entry",
  "not-memecoin": "not a memecoin by instrument class",
  "volume-unknown": "24h volume not reported",
  "volume-below-min": `24h volume under $${TRENCH_VOLUME_MIN.toLocaleString("en-US")} and last hour under $${TRENCH_H1_VOLUME_MIN.toLocaleString("en-US")}`,
  "buyers-below-min": "fewer than 20 distinct buyers in 24h (or not reported)",
  "no-buys-24h": "no buys in 24h (or not reported)",
  "no-sells-24h": "no sells in 24h (or not reported)",
  "no-m5-volume": "no volume in the last 5 minutes (or not reported)",
  "beyond-discovery-slice": "ranked below the verified discovery slice",
  "pool-not-verified": "its pool did not pass on-chain verification (pair, quote asset or canonical factory)",
  "venue-not-supported": "no pool on the one venue autonomous entries use",
};

const SKIP_STAGE: Readonly<Record<CandidateSkip, FunnelStage>> = {
  "not-watched": "DISCOVERY_SCREENED_OUT",
  "asset-allowlist": "PERMISSION_BLOCKED",
  "no-exit": "UNSUPPORTED_ROUTE",
  "missing-created-at": "RESEARCH_INCOMPLETE",
  "created-at-in-future": "RESEARCH_INCOMPLETE",
  "missing-fdv": "RESEARCH_INCOMPLETE",
  "autonomous-budget-spent": "BUDGET_EXHAUSTED",
  // UNREAD IS NOT SPENT. The read failing excludes every autonomous coin —
  // fail closed, correctly — but the remedy is an RPC, not a day's wait.
  "autonomous-budget-unread": "RESEARCH_INCOMPLETE",
  "token-paused": "PERMISSION_BLOCKED",
};

const BLOCK_STAGE: Readonly<Record<TickBlock, FunnelStage>> = {
  "brain-not-configured": "RESEARCH_INCOMPLETE",
  "book-incomplete": "RESEARCH_INCOMPLETE",
  "review-energy-spent": "BUDGET_EXHAUSTED",
  "drawdown-breaker": "BUDGET_EXHAUSTED",
  "entries-energy-spent": "BUDGET_EXHAUSTED",
};

/** Micro-USDG as a decimal string. bigint throughout: a size is never a float here. */
function usdg6(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  return `${neg ? "-" : ""}${a / 1_000_000n}.${(a % 1_000_000n).toString().padStart(6, "0")}`;
}

/**
 * Map one verdict, in one of the existing vocabularies, onto a funnel step.
 * PURE, and total: every input has a stage.
 */
export function classifyStage(input: FunnelInput): Classified {
  switch (input.kind) {
    case "brain-decision": {
      const action = String(input.action ?? "").toLowerCase();
      const id = input.decisionId ?? null;
      const proposed = input.proposedAction ?? null;
      if (action === "buy" || action === "sell") {
        // The two orders `launch` refuses before they become `ready`.
        if (action === "buy" && input.held) {
          return { stage: "UNSUPPORTED_ROUTE", detail: "add-to-position-unsupported", decisionId: id, candidateAction: "buy", enforcedAction: "hold" };
        }
        if (action === "sell" && input.held === false) {
          return { stage: "UNSUPPORTED_ROUTE", detail: "short-unsupported", decisionId: id, candidateAction: "sell", enforcedAction: "hold" };
        }
        return { stage: "BRAIN_APPROVED", detail: `brain-${action}`, decisionId: id, candidateAction: action, enforcedAction: action };
      }
      if (action !== "hold") return { stage: "RESEARCH_INCOMPLETE", detail: detailOf("invalid-action", action), decisionId: id };
      const gate = input.gateVerdict ?? null;
      const base = { decisionId: id, candidateAction: proposed, enforcedAction: "hold" };
      if (input.holdKind === "GATE_FORCED_HOLD") return { ...base, stage: "GATE_FORCED_HOLD", detail: detailOf("gate-forced-hold", gate ? `gate ${gate}` : null) };
      if (input.holdKind === "STALE_MARK_HOLD") return { ...base, stage: "RESEARCH_INCOMPLETE", detail: "stale-mark-hold" };
      if (input.holdKind === "MODEL_HOLD") return { ...base, candidateAction: proposed ?? "hold", stage: "MODEL_HOLD", detail: "model-hold" };
      // UNREPORTED IS NOT A MODEL HOLD. An older Brain build sends no kind;
      // the gate's own verdict, when present, settles it, and when it is not
      // the honest stage is that the record is incomplete — counting unknown
      // holds as the model's would report a healthy desk while it was gated.
      if (gate === "proceed") return { ...base, stage: "MODEL_HOLD", detail: "model-hold: kind unreported, gate proceed" };
      if (gate === "refuse" || gate === "downgrade-to-hold") return { ...base, stage: "GATE_FORCED_HOLD", detail: detailOf("gate-forced-hold", `kind unreported, gate ${gate}`) };
      return { ...base, stage: "RESEARCH_INCOMPLETE", detail: "hold-kind-unreported" };
    }
    case "brain-refusal": {
      const reason = /^[a-z0-9-]{1,48}$/.test(input.reason) ? input.reason : "unrecognised-reason";
      // Refused before any model call: the gate would not let this book be
      // reasoned about, which is a forced hold by another road.
      if (reason === "portfolio-quality-insufficient") return { stage: "GATE_FORCED_HOLD", detail: reason, enforcedAction: "hold" };
      // The run's MODEL budget, not the owner's money — still a budget.
      if (reason === "budget-exhausted") return { stage: "BUDGET_EXHAUSTED", detail: reason };
      return { stage: "RESEARCH_INCOMPLETE", detail: reason === "unrecognised-reason" ? reason : `brain-refused: ${reason}` };
    }
    case "brain-failure":
      return { stage: "RESEARCH_INCOMPLETE", detail: `brain-${input.failure}` };
    case "policy":
      return ruleStage(input.rule, "policy");
    case "execution":
      return ruleStage(input.rule, "execution");
    case "trade": {
      const rule = input.rejectRule ?? null;
      switch (input.status) {
        case "submitted":
          return { stage: "SETTLEMENT_PENDING", detail: "submitted" };
        case "landed":
          return { stage: "LANDED", detail: "landed" };
        case "paper":
          return { stage: "LANDED", detail: "paper-fill", paper: true };
        case "reverted":
          return { stage: "SUBMISSION_FAILED", detail: detailOf("reverted", rule) };
        case "dropped":
          return { stage: "SUBMISSION_FAILED", detail: detailOf("dropped", rule) };
        case "rejected":
          return rule ? ruleStage(rule, "execution") : { stage: "SUBMISSION_FAILED", detail: "rejected-without-rule" };
        default:
          return { stage: "SUBMISSION_FAILED", detail: detailOf("unknown-status", String(input.status)) };
      }
    }
    case "take-drop": {
      const reason = String(input.reason ?? "");
      for (const [re, stage, code] of DROP_CODES) if (re.test(reason)) return { stage, detail: detailOf(code, reason) };
      return { stage: "RESEARCH_INCOMPLETE", detail: detailOf("order-dropped", reason) };
    }
    case "discovery": {
      const words = DISCOVERY_WORDS[input.screen] ?? "screened out";
      const stage: FunnelStage = input.screen === "venue-not-supported" ? "UNSUPPORTED_ROUTE" : "DISCOVERY_SCREENED_OUT";
      return { stage, detail: detailOf(input.screen, input.venue ? `${words} (${input.venue})` : words) };
    }
    case "entry-screen": {
      const why = String(input.why ?? "");
      const code = ENTRY_CODES.find(([re]) => re.test(why))?.[1] ?? "entry-screen";
      return { stage: "DISCOVERY_SCREENED_OUT", detail: detailOf(code, why) };
    }
    case "candidate-skip":
      return { stage: SKIP_STAGE[input.skip] ?? "RESEARCH_INCOMPLETE", detail: input.skip };
    case "not-on-tape":
      return { stage: "NOT_DISCOVERED", detail: "not-on-tape" };
    case "size-below-floor":
      return { stage: "SIZE_BELOW_ECONOMIC_FLOOR", detail: `size-below-floor: ${usdg6(input.sizeUsdg6)} USDG < ${usdg6(input.floorUsdg6)} USDG` };
    case "tick-block":
      return { stage: BLOCK_STAGE[input.block] ?? "RESEARCH_INCOMPLETE", detail: input.block };
  }
}

/**
 * A completed Brain review, read into the funnel. Null when there is nothing
 * to file: a trigger that did not fire was not a review and not a refusal.
 *
 * The hold kind is the one the LEDGER records (`recordedHoldKind`): a hold on
 * a stale mark is the model describing an absent market, and is filed as an
 * incomplete record rather than as the model's view.
 */
export function classifyReview(outcome: ShadowOutcome, ctx: { held: boolean; priceStale: boolean }): Classified | null {
  if (!outcome.ran) {
    if (/^energy/.test(outcome.why)) return { stage: "BUDGET_EXHAUSTED", detail: detailOf("review-energy-spent", outcome.why) };
    if (/not configured/.test(outcome.why)) return { stage: "RESEARCH_INCOMPLETE", detail: "brain-not-configured" };
    if (!outcome.trigger.fire) return null;
    return { stage: "RESEARCH_INCOMPLETE", detail: detailOf("review-not-run", outcome.why) };
  }
  const r = outcome.result;
  if (!r.ok) {
    return r.kind === "refused"
      ? classifyStage({ kind: "brain-refusal", reason: r.reason })
      : classifyStage({ kind: "brain-failure", failure: r.kind });
  }
  const d = r.decision;
  return classifyStage({
    kind: "brain-decision",
    action: d.action,
    holdKind: recordedHoldKind(d, { priceStale: ctx.priceStale }) ?? null,
    gateVerdict: d.gate_verdict ?? null,
    proposedAction: d.proposed_action ?? null,
    held: ctx.held,
    decisionId: typeof d.decision_id === "string" && d.decision_id.trim() ? d.decision_id : null,
  });
}

/**
 * Which of the candidate builder's silent skips applied — the SAME tests in
 * the SAME order as its one-line condition (index.ts trenchCandidates), so the
 * name is the rule that actually fired. Null when none did.
 */
export function candidateSkipOf(c: {
  watched: boolean;
  autonomous: boolean;
  allowed: boolean;
  createdAt: number | null | undefined;
  fdvUsd: number | null | undefined;
  nowSec: number;
}): CandidateSkip | null {
  if (!c.watched) return "not-watched";
  if (!c.autonomous && !c.allowed) return "asset-allowlist";
  if (!c.createdAt) return "missing-created-at";
  if (c.createdAt > c.nowSec) return "created-at-in-future";
  if (!c.fdvUsd) return "missing-fdv";
  return null;
}

/**
 * Why no Trencher review can run this tick, in the order index.ts's guard
 * asks. Null when it can run — or when this is not a review tick at all,
 * which is the ordinary state of a command tick and not a block.
 */
export function trenchReviewBlock(t: {
  brainConfigured: boolean;
  bookIncomplete: boolean;
  brainTick: boolean;
  reviewsOpen: boolean;
}): TickBlock | null {
  if (!t.brainTick) return null;
  if (!t.brainConfigured) return "brain-not-configured";
  if (t.bookIncomplete) return "book-incomplete";
  if (!t.reviewsOpen) return "review-energy-spent";
  return null;
}

/** The venue autonomous discovery verifies (trencher-discovery.ts). */
const AUTONOMOUS_VENUE = "uniswap-v3-robinhood";

/**
 * WHY A COIN ON THE SCREENED TAPE NEVER REACHED THE VERIFIED UNIVERSE.
 *
 * Discovery reads only the busiest DISCOVERY_SLICE coins on one venue (plus
 * nominations) and keeps those whose pool verifies on chain; the candidate
 * builder then drops everything else without a word. This names the reason
 * per coin from the same ranking discovery uses — a READING of the current
 * tape, which may have turned over since discovery last ran, so it is the
 * best account available rather than discovery's own record.
 *
 * Coins with ANY qualified pool are not explained: they are candidates.
 */
export function unqualifiedReasons(args: {
  tape: readonly GeckoPool[];
  qualified: readonly Pick<GeckoPool, "tokenAddress">[];
  nominated: Iterable<string>;
  slice: number;
}): Map<string, Classified> {
  const qualified = new Set(args.qualified.map(q => q.tokenAddress.toLowerCase()));
  const nominated = new Set([...args.nominated].map(a => String(a).toLowerCase()));
  const venues = new Map<string, Set<string>>();
  for (const p of args.tape) {
    const t = p.tokenAddress.toLowerCase();
    if (qualified.has(t)) continue;
    const seen = venues.get(t) ?? new Set<string>();
    seen.add(p.dex);
    venues.set(t, seen);
  }
  const ranked = highVolumePools(args.tape.filter(p => p.dex === AUTONOMOUS_VENUE)).map(p => p.tokenAddress.toLowerCase());
  const out = new Map<string, Classified>();
  for (const [token, dexes] of venues) {
    if (!dexes.has(AUTONOMOUS_VENUE)) {
      out.set(token, classifyStage({ kind: "discovery", screen: "venue-not-supported", venue: [...dexes].sort().join(", ").slice(0, 80) }));
      continue;
    }
    const rank = ranked.indexOf(token);
    const beyond = rank >= args.slice && !nominated.has(token);
    out.set(token, classifyStage({ kind: "discovery", screen: beyond ? "beyond-discovery-slice" : "pool-not-verified" }));
  }
  return out;
}

/**
 * The coin an ENTRY intent buys, or null. The funnel is about entries: an
 * exit is mechanical (trencher.ts "exits first, always") and is not a place a
 * candidate can stop. An entry is a swap or curve trade out of cash.
 */
export function entryTokenOf(intent: { kind: string; sellToken?: string; buyToken?: string }): string | null {
  if ((intent.kind !== "swap" && intent.kind !== "curve-trade") || !intent.sellToken || !intent.buyToken) return null;
  const sell = intent.sellToken.toLowerCase();
  if (sell !== CASH.USDG.toLowerCase() && sell !== CASH.WETH.toLowerCase()) return null;
  return intent.buyToken.toLowerCase();
}

/** The desk's own name for a discovered coin — the derivation trencher-discovery.ts uses. */
export function trencherSymbol(address: string): string {
  return `T${address.toLowerCase().slice(-11).toUpperCase()}`;
}

// ── the recorder ─────────────────────────────────────────────────────────

export interface FunnelEntry {
  /** Lowercased address. */
  token: string;
  symbol: string;
  stage: FunnelStep;
  detail: string;
  decisionId: string | null;
  candidateAction: string | null;
  enforcedAction: string | null;
  paper: boolean;
  /** ms epoch: first and latest of the identical observations folded into this entry. */
  firstAt: number;
  lastAt: number;
  /** How many identical consecutive observations this entry stands for. */
  count: number;
}

export interface FunnelRecord {
  token: string;
  symbol?: string | null;
  stage: FunnelStep;
  detail: string;
  decisionId?: string | null;
  candidateAction?: string | null;
  enforcedAction?: string | null;
  paper?: boolean;
  /** ms epoch; defaults to the recorder's clock. */
  at?: number;
}

export interface FunnelTrace {
  token: string;
  symbol: string | null;
  /** Where it last stopped; NOT_DISCOVERED when this process never filed it. */
  stage: FunnelStep;
  latest: FunnelEntry | null;
  /** Oldest first. Copies: changing them changes nothing here. */
  entries: FunnelEntry[];
}

export interface FunnelSummary {
  sinceMs: number;
  /** Coins with anything filed since `sinceMs`. */
  tokens: number;
  /** Coins whose LATEST entry is at each step — where candidates currently stop. */
  latest: Partial<Record<FunnelStep, number>>;
  /** Entries (identical repeats folded) seen since, per step. */
  entries: Partial<Record<FunnelStep, number>>;
  /** The commonest detail codes among the `latest` coins, per step, busiest first. */
  reasons: Partial<Record<FunnelStep, { code: string; tokens: number }[]>>;
  /** Whole-tick blocks since, busiest first. */
  blocks: { stage: FunnelStage; detail: string; count: number }[];
  /**
   * Brain approvals older than the grace period with nothing filed after them
   * for the same decision — orders that vanished. See BRAIN_APPROVED.
   */
  approvalsWithoutOutcome: number;
}

export interface FunnelRecorderOptions {
  now?: () => number;
  /** Coins kept. Screened-out coins are evicted first. */
  maxTokens?: number;
  /** Entries kept per coin. */
  perToken?: number;
  /** At most one `logLine` per this many ms. */
  logEveryMs?: number;
  /** An approval with nothing after it this long is counted as vanished. */
  approvalGraceMs?: number;
}

const EARLY: ReadonlySet<FunnelStep> = new Set(["DISCOVERY_SCREENED_OUT", "NOT_DISCOVERED"]);
const MAX_BLOCK_KEYS = 64;
const codeOf = (detail: string) => detail.split(":")[0]!.trim();
const ADDRESS = /^0x[0-9a-f]{40}$/;
const STEPS_ORDER: readonly FunnelStep[] = [
  "NOT_DISCOVERED", "DISCOVERY_SCREENED_OUT", "RESEARCH_INCOMPLETE", "MODEL_HOLD", "GATE_FORCED_HOLD",
  "PERMISSION_BLOCKED", "UNSUPPORTED_ROUTE", "SIZE_BELOW_ECONOMIC_FLOOR", "SPONSORSHIP_UNAVAILABLE",
  "BUDGET_EXHAUSTED", "BRAIN_APPROVED", "SUBMISSION_FAILED", "SETTLEMENT_PENDING", "LANDED",
];

/**
 * A bounded ring per coin, in one process. See the file header.
 *
 * IDENTICAL REPEATS FOLD. The candidate builder runs on every tick and twice
 * on a review tick, so "missing-fdv" for one coin would otherwise fill its
 * ring in seconds and push out the review that mattered. A repeat of the
 * coin's latest entry (same step, detail, decision and rail) bumps its count
 * and time instead.
 *
 * SCREENED-OUT COINS ARE EVICTED FIRST. The tape is a hundred-odd pools a
 * minute and most fail the screen; a plain LRU would let that churn evict the
 * few coins that reached the Brain, which are exactly the ones an owner asks
 * about.
 */
export class FunnelRecorder {
  private readonly now: () => number;
  private readonly maxTokens: number;
  private readonly perToken: number;
  private readonly logEveryMs: number;
  private readonly approvalGraceMs: number;
  private rings = new Map<string, FunnelEntry[]>();
  private blocks = new Map<string, { stage: FunnelStage; detail: string; count: number; firstAt: number; lastAt: number }>();
  private lastLogAt: number;
  private scopeKey: string | null = null;

  constructor(opts: FunnelRecorderOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.maxTokens = Math.max(1, opts.maxTokens ?? 400);
    this.perToken = Math.max(1, opts.perToken ?? 20);
    this.logEveryMs = Math.max(0, opts.logEveryMs ?? 10 * 60_000);
    this.approvalGraceMs = Math.max(0, opts.approvalGraceMs ?? 90_000);
    // The first line is due one interval after start, not at boot: an empty
    // summary of a process that has not ticked yet says nothing.
    this.lastLogAt = this.now();
  }

  /**
   * Forget everything when the subject changes (another agent armed in this
   * process). A trace must never answer for a different agent's desk.
   */
  scope(key: string): void {
    if (this.scopeKey === key) return;
    if (this.scopeKey !== null) this.clear();
    this.scopeKey = key;
  }

  clear(): void {
    this.rings.clear();
    this.blocks.clear();
  }

  /**
   * File one observation. False when the token is not an address (nothing is
   * filed). NEVER THROWS, nor do note() and block(): they are called on the
   * trading path, one of them right before a fill's ledger row is written, and
   * a reading aid must never be what costs a trade its record.
   */
  record(r: FunnelRecord): boolean {
    try {
      return this.recordUnguarded(r);
    } catch {
      return false;
    }
  }

  private recordUnguarded(r: FunnelRecord): boolean {
    const token = typeof r.token === "string" ? r.token.toLowerCase() : "";
    if (!ADDRESS.test(token) || !STEPS_ORDER.includes(r.stage)) return false;
    const at = typeof r.at === "number" && Number.isFinite(r.at) ? r.at : this.now();
    const symbol = sanitizeText(r.symbol ?? "", SYMBOL_MAX) || trencherSymbol(token);
    const detail = sanitizeText(r.detail, DETAIL_MAX) || "unspecified";
    const clean = (v: string | null | undefined, max: number) => (typeof v === "string" && v.trim() ? sanitizeText(v, max) : null);
    const entry: FunnelEntry = {
      token, symbol, stage: r.stage, detail,
      decisionId: clean(r.decisionId, 80),
      candidateAction: clean(r.candidateAction, 16),
      enforcedAction: clean(r.enforcedAction, 16),
      paper: r.paper === true,
      firstAt: at, lastAt: at, count: 1,
    };
    const ring = this.rings.get(token) ?? [];
    const last = ring[ring.length - 1];
    if (last && last.stage === entry.stage && last.detail === entry.detail && last.decisionId === entry.decisionId && last.paper === entry.paper) {
      last.count++;
      last.lastAt = Math.max(last.lastAt, at);
      last.symbol = symbol;
    } else {
      ring.push(entry);
      while (ring.length > this.perToken) ring.shift();
    }
    // Re-insert at the back: Map order is recency.
    this.rings.delete(token);
    this.rings.set(token, ring);
    this.evict();
    return true;
  }

  /** `record` from a classification; a null classification files nothing. Never throws. */
  note(token: string, symbol: string | null | undefined, c: Classified | null, at?: number): boolean {
    try {
      if (!c) return false;
      return this.record({ token, symbol, stage: c.stage, detail: c.detail, decisionId: c.decisionId, candidateAction: c.candidateAction, enforcedAction: c.enforcedAction, paper: c.paper, at });
    } catch {
      return false;
    }
  }

  /** A whole tick that reviewed or entered nothing, and why. Not per coin. Never throws. */
  block(block: TickBlock | null, at?: number): void {
    try {
      this.blockUnguarded(block, at);
    } catch {
      // a reading aid; the tick goes on
    }
  }

  private blockUnguarded(block: TickBlock | null, at?: number): void {
    if (!block) return;
    const c = classifyStage({ kind: "tick-block", block });
    const t = typeof at === "number" && Number.isFinite(at) ? at : this.now();
    const key = `${c.stage}|${c.detail}`;
    const prior = this.blocks.get(key);
    if (prior) {
      prior.count++;
      prior.lastAt = Math.max(prior.lastAt, t);
      return;
    }
    this.blocks.set(key, { stage: c.stage as FunnelStage, detail: c.detail, count: 1, firstAt: t, lastAt: t });
    while (this.blocks.size > MAX_BLOCK_KEYS) {
      let oldest: string | null = null;
      let oldestAt = Infinity;
      for (const [k, v] of this.blocks) if (v.lastAt < oldestAt) { oldest = k; oldestAt = v.lastAt; }
      if (oldest === null) break;
      this.blocks.delete(oldest);
    }
  }

  private evict(): void {
    while (this.rings.size > this.maxTokens) {
      let victim: string | undefined;
      // Oldest-touched first (Map order), preferring a coin that only ever
      // got as far as the screen.
      for (const [token, ring] of this.rings) {
        const latest = ring[ring.length - 1];
        if (!latest || EARLY.has(latest.stage)) { victim = token; break; }
      }
      victim ??= this.rings.keys().next().value as string | undefined;
      if (victim === undefined) break;
      this.rings.delete(victim);
    }
  }

  /** Everything filed about one coin. "Why did you skip that coin?" starts here. */
  traceFor(address: string): FunnelTrace {
    const token = typeof address === "string" ? address.toLowerCase() : "";
    const ring = this.rings.get(token) ?? [];
    const entries = ring.map(e => ({ ...e }));
    const latest = entries[entries.length - 1] ?? null;
    return { token, symbol: latest?.symbol ?? null, stage: latest?.stage ?? "NOT_DISCOVERED", latest, entries };
  }

  /** Where candidates stopped since `sinceMs`. */
  summary(sinceMs: number): FunnelSummary {
    const now = this.now();
    const latest: Partial<Record<FunnelStep, number>> = {};
    const entries: Partial<Record<FunnelStep, number>> = {};
    const codes = new Map<FunnelStep, Map<string, number>>();
    let tokens = 0;
    let approvalsWithoutOutcome = 0;
    for (const ring of this.rings.values()) {
      const recent = ring.filter(e => e.lastAt >= sinceMs);
      if (recent.length === 0) continue;
      tokens++;
      for (const e of recent) entries[e.stage] = (entries[e.stage] ?? 0) + 1;
      const last = ring[ring.length - 1]!;
      latest[last.stage] = (latest[last.stage] ?? 0) + 1;
      const byCode = codes.get(last.stage) ?? new Map<string, number>();
      byCode.set(codeOf(last.detail), (byCode.get(codeOf(last.detail)) ?? 0) + 1);
      codes.set(last.stage, byCode);
      ring.forEach((e, i) => {
        if (e.stage !== "BRAIN_APPROVED" || e.lastAt < sinceMs || now - e.lastAt < this.approvalGraceMs) return;
        const after = ring.slice(i + 1);
        const resolved = e.decisionId ? after.some(x => x.decisionId === e.decisionId) : after.length > 0;
        if (!resolved) approvalsWithoutOutcome++;
      });
    }
    const reasons: Partial<Record<FunnelStep, { code: string; tokens: number }[]>> = {};
    for (const [stage, byCode] of codes) {
      reasons[stage] = [...byCode].map(([code, n]) => ({ code, tokens: n })).sort((a, b) => b.tokens - a.tokens || a.code.localeCompare(b.code));
    }
    const blocks = [...this.blocks.values()]
      .filter(b => b.lastAt >= sinceMs)
      .map(b => ({ stage: b.stage, detail: b.detail, count: b.count }))
      .sort((a, b) => b.count - a.count || a.detail.localeCompare(b.detail));
    return { sinceMs, tokens, latest, entries, reasons, blocks, approvalsWithoutOutcome };
  }

  /**
   * One aggregated line, at most once per `logEveryMs` — counted, not
   * per-coin, so it can run on every tick. Null when not yet due. Coin
   * identities stay out of it: the per-coin story is `traceFor`.
   */
  logLine(): string | null {
    const now = this.now();
    if (now - this.lastLogAt < this.logEveryMs) return null;
    const since = this.lastLogAt;
    this.lastLogAt = now;
    return formatSummary(this.summary(since), now);
  }
}

/** A summary as the one line an operator scans. */
export function formatSummary(s: FunnelSummary, nowMs: number): string {
  const mins = Math.max(1, Math.round((nowMs - s.sinceMs) / 60_000));
  const parts: string[] = [];
  for (const stage of STEPS_ORDER) {
    const n = s.latest[stage];
    if (!n) continue;
    const top = (s.reasons[stage] ?? []).slice(0, 3).map(r => `${r.code} ${r.tokens}`).join(", ");
    parts.push(`${stage} ${n}${top ? ` (${top})` : ""}`);
  }
  const blocks = s.blocks.slice(0, 4).map(b => `${b.detail} x${b.count}`).join(", ");
  return `[funnel] last ${mins}m: ${s.tokens} coin${s.tokens === 1 ? "" : "s"}` +
    (parts.length ? ` · stopped at ${parts.join(" · ")}` : " · none filed") +
    (blocks ? ` · whole-tick blocks: ${blocks}` : "") +
    (s.approvalsWithoutOutcome ? ` · ${s.approvalsWithoutOutcome} Brain approval(s) with no recorded outcome` : "");
}

/**
 * A trace as a sentence, for "why did you skip that coin?". Plain words and
 * the original rule; the symbol and details were sanitised on the way in.
 */
export function describeTrace(t: FunnelTrace, nowMs: number): string {
  if (!t.latest) {
    return "No record: this coin was not on the tape this desk has read since it started, or it has aged out of memory (NOT_DISCOVERED).";
  }
  const ago = (ms: number) => {
    const s = Math.max(0, Math.round((nowMs - ms) / 1000));
    return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
  };
  const e = t.latest;
  const wanted = e.candidateAction && e.enforcedAction && e.candidateAction !== e.enforcedAction
    ? ` The model proposed ${e.candidateAction}; ${e.enforcedAction} was enforced.` : "";
  const earlier = t.entries.slice(0, -1).slice(-3).reverse()
    .map(x => `${x.stage} (${codeOf(x.detail)}${x.count > 1 ? ` x${x.count}` : ""})`).join("; ");
  return `${t.symbol ?? t.token}: last stopped at ${e.stage} — ${e.detail}${e.count > 1 ? ` (x${e.count})` : ""}, ${ago(e.lastAt)}${e.paper ? " (paper)" : ""}.` +
    wanted + (earlier ? ` Before that: ${earlier}.` : "");
}

// ── the process's recorder ───────────────────────────────────────────────

let installed: FunnelRecorder | null = null;

/** index.ts main() installs the one recorder this process files into. */
export function installDecisionFunnel(r: FunnelRecorder | null): void {
  installed = r;
}

/**
 * The recorder index.ts installed, or null in a process that runs no desk.
 * Read-only use is the point: a chat tool answering "why did you skip X?"
 * calls `decisionFunnel()?.traceFor(address)` and `describeTrace`.
 */
export function decisionFunnel(): FunnelRecorder | null {
  return installed;
}
