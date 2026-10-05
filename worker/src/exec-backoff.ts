/**
 * A BUY REFUSED BEFORE BROADCAST IS NOT RETRIED EVERY TICK — FOR A WHILE.
 *
 * `suppressedIntents` (index.ts) already does this for one kind of refusal: a
 * revert class retrying cannot fix closes its intent until the next arm. This
 * is the same mechanism, with an expiry, for the other kind — `GasRefused` and
 * `SponsorRefused`, the refusals our own checks make before anything is signed.
 * They are re-proposed every tick: live, 2026-10-03, agent 0xbba115 was
 * refused `enable-too-wide` every tick through several re-signs (the key
 * install that fixes it is tried at most once per half hour), and the
 * class-vault route is refused `gas-absurd` on every entry it proposes (its
 * 3M ceiling is kept on purpose, so the route stays effectively off). Each
 * attempt is two bundler estimates, a decision row and a rejected row saying
 * what the previous sixty said.
 *
 * AN EXPIRY, NOT A SUPPRESSION, because these are facts about the moment and
 * not about the trade. A gas estimate moves with the pool, a sponsor changes
 * its mind, an account gets funded; suppressing until the next arm would turn
 * a refusal we would sign tomorrow into a strategy that quietly stopped
 * working. So each hold has a time on it (BACKOFF_SCHEDULE_MIN), and a refusal
 * that repeats when it runs out waits longer the next time — unless it may be
 * a moment rather than a fact (NOT_ESCALATED), which never waits longer.
 *
 * WHAT IS NEVER HELD, and each of these is load-bearing:
 *
 *   - AN EXIT. A stop-loss that cannot wait is the whole reason the breaker
 *     exempts exits, and a backoff is a much weaker reason than a breaker.
 *     Exits are not held and do not start a hold (`backsOff` below).
 *   - A REFUSAL THAT SAYS IT WAS A READ WE COULD NOT MAKE, or a race with our
 *     own landing (NOT_BACKED_OFF). `enable-unverified` tells the owner "the
 *     next tick will ask again"; holding it would make that sentence false.
 *   - AN OWNER'S OR THE BRAIN'S ORDER. Asked for once, by somebody waiting on
 *     the answer, it is tried and hears the bundler's own word (index.ts
 *     tickEntries). A hold another intent started is about another size and
 *     another moment. When the order's OWN refusal starts a hold, its reply
 *     says when asking again can help (ExecBackoff.notedBy, heldReply).
 *   - ANYTHING SILENTLY. A strategy intent with no decision yet is skipped
 *     before ensureDecision (no row, no post — the hold's own `[backoff]` line
 *     said why). One that already has a decision — a strategist intent that
 *     journaled its own — reaches processIntentLocked and gets a `rejected`
 *     row carrying the rule that started the hold. A silent return there was
 *     considered and dropped: it breaks provenance and owner receipts.
 *
 * NEVER PERSISTED, and cleared at every arm, for the reason suppressedIntents
 * gives: a fresh arm has fresh information (a re-signed grant, a funded
 * account), and a hold outliving its reason is indistinguishable from a
 * strategy that stopped working.
 *
 * NOTHING HERE CAN MAKE A TRADE HAPPEN. Every function either withholds an
 * entry or answers a question; the wall, the caps and the gas ceilings are
 * untouched and still judge everything that is not held.
 */
import { isExitIntent, type AgentLimits, type TradeIntent } from "./policy";
import { suppressionKey, suppressionLegs } from "./revert";
import { rejectRuleLabel, rejectRuleRemedy } from "./thesis-policy";

/**
 * Minutes held after the 1st, 2nd, 3rd… refusal of one key in an arm; the last
 * step repeats. Short first, because the first refusal may be a bad moment and
 * not a bad trade; capped at an hour, because a hold is a guess about the
 * future and a long guess is the suppression this is not.
 */
export const BACKOFF_SCHEDULE_MIN: readonly number[] = Object.freeze([5, 15, 30, 60]);

/**
 * THE `enable-too-wide` HOLD, AND THE KEY INSTALL'S RETRY, ARE ONE NUMBER.
 *
 * A wall too wide to install together with its trade is installed on its own
 * (index.ts installKeyAlone), at most once per executor per this long. Until
 * that lands, every entry riding on the enable is refused the same way, and
 * once it lands none of them is (ExecBackoff.clearRule). So the hold lasts
 * exactly until the next install attempt can happen, or until one succeeds —
 * whichever is first. index.ts reads its retry interval from here so the two
 * cannot drift apart.
 */
export const KEY_INSTALL_HOLD_MS = 30 * 60_000;

/**
 * Pre-broadcast refusals that are NOT held: each says that WE could not read
 * something, or that our own previous operation landed mid-check. The next
 * tick genuinely may differ, and holding them would put a wait on an answer
 * nobody has yet.
 */
const NOT_BACKED_OFF: ReadonlySet<string> = new Set([
  // executor.ts: a prior submitted enable landed while estimates ran.
  "nonce-changed",
  // executor.ts: "Nothing was signed, and the next tick will ask again."
  "enable-unverified",
  // gas-limits.ts checkPrefund: the balance or fee could not be read.
  "prefund-unverified",
  // paymaster.ts: the sponsor did not answer, which is not the sponsor saying no.
  "sponsor-unreachable",
  // executor.ts: the SDK's plugin-enable read failed open — "one flaky
  // eth_call" shapes an enable nothing needs. A read that failed, not a fact.
  "enable-redundant",
  // executor.ts: "That enable has already landed" — our own landing, the same
  // race as nonce-changed.
  "enable-replayed",
]);

/**
 * Refusals that MAY BE A MOMENT rather than a fact: held for the schedule's
 * first step and never longer, however often they come, and they add no
 * strike to their key — a later refusal that IS a fact starts where it would
 * have without them.
 *
 * Held at all, rather than NOT_BACKED_OFF, because during a bundler outage
 * every entry the tick proposes meets one, and a hold is what keeps that to
 * one attempt per pair per five minutes instead of one per tick. Not
 * escalated, because nothing about them says the next attempt will fail too:
 *
 *   - `gas-unreadable` reaches the ledger unrenamed only when the bundler's
 *     error was unclassified or retryable (executor.ts: "a transient bundler
 *     hiccup worth retrying"). A non-retryable cause is renamed to its class
 *     before it gets here, and that class does escalate.
 *   - `gas-unstable`: two estimates of the same calldata disagreed. The
 *     estimator disagreeing with itself is about the estimator.
 *
 * A DECISION FOR MILLA, recorded here: both reviewers of this module asked
 * whether these two should be held at all. This is the middle answer.
 */
const NOT_ESCALATED: ReadonlySet<string> = new Set(["gas-unreadable", "gas-unstable"]);

/** How long a refusal of `rule` holds its key, at this strike; null when it is not held at all. */
export function holdMsFor(rule: string, strikes: number): number | null {
  if (NOT_BACKED_OFF.has(rule)) return null;
  if (rule === "enable-too-wide") return KEY_INSTALL_HOLD_MS;
  if (NOT_ESCALATED.has(rule)) return BACKOFF_SCHEDULE_MIN[0]! * 60_000;
  const at = Math.min(Math.max(strikes, 1), BACKOFF_SCHEDULE_MIN.length) - 1;
  return BACKOFF_SCHEDULE_MIN[at]! * 60_000;
}

/** The three limits a hold reads: the exit test's two, and the class vault the grant sealed. */
export type BackoffLimits = Pick<AgentLimits, "cashToken" | "quoteAssets" | "ponsClassVault">;

const lc = (a: string) => a.toLowerCase();

/**
 * MAY THIS INTENT BE HELD AT ALL? Only a buy, judged by what it SPENDS.
 *
 * TWO TESTS, AND NEITHER IS REDUNDANT.
 *
 * `isExitIntent` first — the breaker's own test, so anything the breaker calls
 * an exit is never held. It is the ONLY thing between a stock sale into cash
 * and a hold: a basket agent's positions ARE built-in stock tokens, which sit
 * on the quote side, so the second test alone would hold a TSLA stop-loss
 * into USDG. Do not drop it as covered by the test below; it is not.
 *
 * The second test covers what the first gets wrong the other way: it can read
 * a curve SALE as an entry, on a legacy grant whose curve is quoted in an
 * owner-added stock token (energy.ts sellsHeldLeg exists for exactly that),
 * and the tick knows held legs where processIntentLocked does not. So a swap
 * or curve trade is held only when it spends from the QUOTE side — cash, or a
 * token the grant built in (limits.quoteAssets). No sale out of a token that
 * is not built in — every memecoin, every owner-added extra — qualifies.
 *
 * What both let through is a swap ROTATING one built-in into another (TSLA →
 * NVDA): held, as the breaker blocks it, because it is not a way out. The way
 * out of a stock, a swap into cash, is an exit and never held. A buy this
 * misses is merely not held, which is today's behaviour; the error can only
 * fall that way.
 *
 * Every other kind is never held: transfers and withdrawals are money coming
 * home, a vault deposit is housekeeping, an equity order never meets the gas
 * checks, and the energy buy is the owner's own click on its own route.
 */
export function backsOff(intent: TradeIntent, limits: BackoffLimits): boolean {
  if (intent.kind !== "swap" && intent.kind !== "curve-trade") return false;
  if (isExitIntent(intent, limits)) return false;
  const spends = lc(intent.kind === "swap" ? intent.sellToken : intent.assetIn);
  const quoteSide = [...(limits.cashToken !== undefined ? [limits.cashToken] : []), ...(limits.quoteAssets ?? [])].map(lc);
  return quoteSide.includes(spends);
}

/**
 * The keys one intent is held under: its token pair, exactly as
 * suppressedIntents keys it (one derivation — see revert.ts suppressionLegs),
 * and, for a curve trade into the class vault the grant sealed, the ROUTE.
 *
 * WHY THE VAULT GETS A ROUTE-WIDE KEY. `gas-absurd` there is not about the
 * token: every class entry is a vault call the same 3M ceiling refuses, so
 * holding one pair at a time would re-learn the same refusal once for every
 * launch the route proposes, and launches arrive by the hundred an hour.
 * Keyed on (kind, target) instead, the first refusal holds the route. Only `gas-absurd` writes it (ExecBackoff.note); any other
 * rule on the vault is still about its pair.
 */
function keysOf(intent: TradeIntent, limits: BackoffLimits): { pair: string; route: string | null } {
  const pair = suppressionKey(intent.kind, ...suppressionLegs(intent));
  const vault = limits.ponsClassVault;
  const route =
    intent.kind === "curve-trade" && vault !== undefined && lc(intent.target) === lc(vault)
      ? `${intent.kind}@${lc(vault)}`
      : null;
  return { pair, route };
}

export interface Hold {
  key: string;
  /** The refusal that started it — the rule a held intent's row carries. */
  rule: string;
  untilMs: number;
  /** Refusals of this key this arm, counting this one — all but those that may be transient (NOT_ESCALATED). */
  strikes: number;
}

/**
 * The holds for one arm of one agent. index.ts keeps one beside
 * suppressedIntents and clears it in the same breath.
 *
 * `log` is where the `[backoff]` line goes — one per CHANGE (a hold started or
 * lengthened, holds cleared), never one per skip, which would be the per-tick
 * noise this exists to remove.
 */
export class ExecBackoff {
  private readonly holds = new Map<string, Hold>();
  /** The hold each intent's own refusal last wrote — for its reply (notedBy), never for holding anything. */
  private readonly noted = new WeakMap<TradeIntent, Hold>();

  constructor(private readonly log: (line: string) => void = (line) => console.log(line)) {}

  /**
   * A pre-broadcast refusal of `intent` under `rule`. Starts or lengthens its
   * hold and returns it, or null when nothing is held (an exit, a kind that is
   * never held, or a rule NOT_BACKED_OFF).
   *
   * A REFUSAL AFTER A HOLD RAN OUT COUNTS AS THE NEXT STRIKE: the entry is kept
   * past its expiry for exactly that, until the arm clears it.
   */
  note(intent: TradeIntent, limits: BackoffLimits, rule: string, nowMs: number): Hold | null {
    if (!backsOff(intent, limits)) return null;
    const { pair, route } = keysOf(intent, limits);
    const key = rule === "gas-absurd" && route !== null ? route : pair;
    const escalates = !NOT_ESCALATED.has(rule);
    const strikes = (this.holds.get(key)?.strikes ?? 0) + (escalates ? 1 : 0);
    const ms = holdMsFor(rule, strikes);
    if (ms === null) return null;
    const hold: Hold = { key, rule, untilMs: nowMs + ms, strikes };
    this.holds.set(key, hold);
    this.noted.set(intent, hold);
    this.log(
      `[backoff] holding ${key} for ${Math.round(ms / 60_000)}m after ${rule} ` +
        `(${escalates ? `refusal ${strikes} this arm` : "may be transient, not escalated"})`,
    );
    return hold;
  }

  /**
   * Is `intent` held right now? The hold that ends LAST when both its pair and
   * its route are held, so "retry after" is never sooner than the truth. Null
   * for anything `backsOff` refuses — an exit is never held, whatever is
   * recorded.
   */
  held(intent: TradeIntent, limits: BackoffLimits, nowMs: number): Hold | null {
    if (!backsOff(intent, limits)) return null;
    const { pair, route } = keysOf(intent, limits);
    let found: Hold | null = null;
    for (const key of route !== null ? [route, pair] : [pair]) {
      const h = this.holds.get(key);
      if (h && h.untilMs > nowMs && (found === null || h.untilMs > found.untilMs)) found = h;
    }
    return found;
  }

  /**
   * The hold `intent`'s OWN refusal started or lengthened, while it is still
   * the one in force for its key. Null once it ran out, was cleared (a key
   * install landed, the agent re-armed) or a later refusal replaced it, and
   * null for an intent that started none.
   *
   * For the reply to an order that is never held: it was tried, refused, and
   * its own refusal is what now holds the tick's entries. Asking `held` there
   * instead would answer with whatever hold the pair carries, including one
   * another intent started for a reason this order never met.
   */
  notedBy(intent: TradeIntent, nowMs: number): Hold | null {
    const h = this.noted.get(intent);
    return h !== undefined && this.holds.get(h.key) === h && h.untilMs > nowMs ? h : null;
  }

  /** Drop every hold started by `rule` — strikes too, because its reason is gone. */
  clearRule(rule: string, why: string): number {
    let n = 0;
    for (const [key, h] of this.holds) {
      if (h.rule !== rule) continue;
      this.holds.delete(key);
      n++;
    }
    if (n > 0) this.log(`[backoff] cleared ${n} ${rule} hold${n === 1 ? "" : "s"}: ${why}`);
    return n;
  }

  /** Drop everything. At arm, beside suppressedIntents.clear(). */
  clear(why: string): number {
    const n = this.holds.size;
    this.holds.clear();
    if (n > 0) this.log(`[backoff] cleared ${n} hold${n === 1 ? "" : "s"}: ${why}`);
    return n;
  }
}

/** Whole minutes until a hold ends, rounded up and never below one: "retry after 0m" is not a time. */
export function retryAfterMin(hold: Pick<Hold, "untilMs">, nowMs: number): number {
  return Math.max(1, Math.ceil((hold.untilMs - nowMs) / 60_000));
}

/**
 * WHAT AN OWNER'S OR THE BRAIN'S ORDER HEARS WHEN ITS OWN REFUSAL STARTED A
 * HOLD — the rule, and when asking again can help. The order itself was tried
 * (orders are never held); the time is how long the tick will leave this pair
 * alone, and asking sooner most likely meets the same answer.
 *
 * The rule as the slug, because that is what the row carries and what support
 * triages on; its sentence and the owner's remedy beside it when the
 * vocabulary has them (thesis-policy.ts), because "retry after 15m" is no
 * answer to `prefund-short` without "send a little ETH". Nothing was signed,
 * so nothing was spent, and the reply says that rather than leaving it to be
 * guessed.
 */
export function heldReply(hold: Pick<Hold, "rule" | "untilMs">, nowMs: number): string {
  const label = rejectRuleLabel(hold.rule);
  const remedy = rejectRuleRemedy(hold.rule);
  return (
    `⏳ not sent: ${hold.rule}, retry after ${retryAfterMin(hold, nowMs)}m` +
    `${label ? ` — ${label}` : ""}.${remedy ? ` ${remedy}` : ""} Nothing was signed and nothing was spent.`
  );
}
