/**
 * THE ENERGY THROTTLE — what a low-energy agent may still do on its own today.
 *
 * The contract (thresholds, the report shape, the buy route) is
 * packages/core/src/energy.ts. This file is the worker's half: which balance
 * reading counts as full, how big a low day is, what counts against it, and
 * the plan index.ts reads at every fork of the tick. The sentences the owner
 * reads are energy-copy.ts.
 *
 * PURE, and on purpose. main() in index.ts cannot be booted by a test, and the
 * codebase's rule (command-wake.ts, class-entry-gate.ts, idle-notice.ts) is
 * that gating logic lives in functions a test can run, because an inline flag
 * in main() can be reverted with every test still green. So nothing here reads
 * a store, a chain, a clock or an environment variable: the tick hands those
 * in, and this decides.
 *
 * WHAT IT NEVER TOUCHES. Exit orders, stop-losses, take-profits, vault
 * housekeeping and anything the owner asked for — the app's chat, the web,
 * Telegram, MCP, the energy buy itself, kill, pause, recover. An allowance on
 * NEW autonomous work is not allowed to become a lock on the doors, the same
 * sentence the drawdown breaker and the ops cap are written under (policy.ts).
 * What it DOES pace is every paid AI review, including a review of a held
 * position — so an exit the AI would decide waits for the next one, and no
 * copy may say "selling is never limited" (energy-copy.ts STILL_RUNS).
 *
 * THE HOUSE SETS THE BASELINES, NEVER THE OWNER. "A tenth of your own normal"
 * computed from inputs the throttled owner controls is no throttle at all:
 * `llmIntervalMin` is tenant-settable down to one minute, and a grant's
 * `maxOpsPerDay` has no ceiling and can be changed at renewal. So each baseline is
 * the smaller of the owner's figure and a house one — an owner can make a low
 * day smaller, never larger.
 */

import { ENERGY, ENERGY_FULL_RAW, ENERGY_ROUTE_V1, SETTINGS_DEFAULTS, wholeTokens } from "../../packages/core/src/index";
import type { EnergyBuy, EnergyLevel, EnergyMeter, EnergyMode, EnergyStatus } from "../../packages/core/src/index";
import type { TradeIntent } from "./policy";

export type { EnergyLevel, EnergyMode } from "../../packages/core/src/index";

const DAY_SEC = 86_400;

/**
 * MERRYMEN_ENERGY_GATE, read once by settings.ts (hosted only).
 *
 * Unset, '0' and anything unrecognised are OFF: the gate is an operator
 * switch that defaults to doing nothing, and a typo must not throttle a fleet.
 * 'observe' computes and counts but withholds nothing and tells no owner, so an
 * operator can see what enforce WOULD do before turning it on.
 */
export function energyModeOf(raw: string | undefined): EnergyMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "1" || v === "enforce") return "enforce";
  if (v === "observe") return "observe";
  return "off";
}

/** The UTC calendar day of a moment, 'YYYY-MM-DD'. The allowance resets at 00:00 UTC. */
export function utcDay(nowSec: number): string {
  return new Date(Math.floor(nowSec) * 1000).toISOString().slice(0, 10);
}

/** Unix seconds of the next 00:00 UTC strictly after `nowSec`. */
export function nextUtcMidnight(nowSec: number): number {
  const s = Math.floor(nowSec);
  return s - (((s % DAY_SEC) + DAY_SEC) % DAY_SEC) + DAY_SEC;
}

// ── the level ─────────────────────────────────────────────────────────────

/**
 * The two balances that count (core energy.ts, D1), as circle.ts read them.
 *
 * THREE VALUES, THREE FACTS: a bigint is a balance that was read; `null` is a
 * read that FAILED, which says nothing about the wallet; `undefined` is no such
 * address — no linked wallet, or an agent account that does not count because
 * it is not on Robinhood Chain — which is a knowable zero.
 */
export interface BalanceParts {
  holder: bigint | null | undefined;
  account: bigint | null | undefined;
}

/** The last reading that decided the level, and when. Durable on energy_days. */
export interface LastGood {
  full: boolean;
  at: number;
}

/**
 * Full, low or unread — and whether this reading should be remembered.
 *
 *   - What WAS read reaches 100,000 → full. The parts that answered are a lower
 *     bound, so one failed read cannot hide a balance that clears it anyway.
 *   - Every present part answered and they fall short → low, decided.
 *   - A part failed and the rest fall short → the last decided reading stands,
 *     if it is no older than ENERGY.lastGoodMaxAgeSec. A holder is not
 *     throttled because the chain would not answer after a restart.
 *   - Otherwise → unread. Never "low": nobody knows, and "low" is the word
 *     that sends somebody to buy tokens they may already hold.
 *
 * `decided` is non-null only when THIS reading settled the question, and is
 * what the caller persists as the new last-good. A reading carried from
 * last-good is not re-stamped, or a stale answer would keep itself fresh.
 */
export function energyLevel(
  parts: BalanceParts,
  lastGood: LastGood | null,
  nowSec: number,
): { level: EnergyLevel; decided: boolean | null } {
  const got = [parts.holder, parts.account].filter((p): p is bigint => typeof p === "bigint");
  const okSum = got.reduce((a, b) => a + b, 0n);
  if (okSum >= ENERGY_FULL_RAW) return { level: "full", decided: true };
  const failed = parts.holder === null || parts.account === null;
  if (!failed) return { level: "low", decided: false };
  if (lastGood && nowSec - lastGood.at <= ENERGY.lastGoodMaxAgeSec && lastGood.at <= nowSec + 60) {
    return { level: lastGood.full ? "full" : "low", decided: null };
  }
  return { level: "unread", decided: null };
}

// ── the allowance ─────────────────────────────────────────────────────────

/**
 * The fast trencher's review interval, seconds. trencher-brain.ts owns the
 * constant (TRENCH_REVIEW_INTERVAL_MS); it is repeated here only so this file
 * stays pure, and energy.test.ts pins that the two agree.
 */
export const TRENCHER_REVIEW_SEC = 30;

/** max(1, ⌈lowBps/10000 × a day's reviews at this interval⌉). */
function lowReviews(intervalSec: number): number {
  return Math.max(1, Math.ceil((ENERGY.lowBps * DAY_SEC) / (10_000 * intervalSec)));
}

/**
 * Paid AI reviews a low-energy agent gets per UTC day, summed over the
 * reviewers that are actually running.
 *
 *   Brain (shadow or live, not the fast trencher): the operator's scheduled
 *     interval — env only, clamped 60..300 s — so 29 at the default 300 s.
 *   Fast trencher: its 30 s review clock, so 288.
 *   llm-strategist with a real model: max(the owner's interval, the house
 *     default of SETTINGS_DEFAULTS.llmIntervalMin), so 5 at 30 minutes. An
 *     owner who sets one minute gets the house figure, not 144.
 *
 * Nothing running → 0: a builtin without Brain is never consulted.
 */
export function reviewAllowance(r: {
  brain: boolean;
  trencher: boolean;
  strategistIntervalMin: number | null;
  brainIntervalSec: number;
  trencherIntervalSec?: number;
}): number {
  let total = 0;
  if (r.trencher) total += lowReviews(r.trencherIntervalSec ?? TRENCHER_REVIEW_SEC);
  else if (r.brain) {
    const sec = Number.isFinite(r.brainIntervalSec) && r.brainIntervalSec > 0 ? r.brainIntervalSec : 300;
    total += lowReviews(sec);
  }
  if (r.strategistIntervalMin !== null) {
    const own = Number.isFinite(r.strategistIntervalMin) ? r.strategistIntervalMin : 0;
    const house = SETTINGS_DEFAULTS.llmIntervalMin ?? 30;
    total += lowReviews(Math.max(own, house) * 60);
  }
  return total;
}

/**
 * New trades a low-energy agent may start on its own per UTC day:
 * max(1, ⌊10% × min(the grant's maxOpsPerDay, ENERGY.baselineOpsPerDay)⌋).
 * 2 on the shipped 24-op preset, and still 2 on a grant signed for 10,000.
 * A count nobody can read is the house baseline, never zero.
 */
export function entryAllowance(maxOpsPerDay: number): number {
  const base = ENERGY.baselineOpsPerDay;
  const ops = Number.isFinite(maxOpsPerDay) ? Math.min(Math.max(0, maxOpsPerDay), base) : base;
  return Math.max(1, Math.floor((ops * ENERGY.lowBps) / 10_000));
}

/**
 * How many of today's reviews may have been used by now.
 *
 * QUOTA-THEN-STOP SPENDS A LOW DAY BEFORE BREAKFAST. Brain wakes every ≤300 s,
 * so 29 reviews would be gone by ~02:25 UTC — 20:00-22:30 in New York, when the
 * stock feeds are stale — and the agent would sit dark for 21 hours. So reviews
 * ACCRUE across the day: one at midnight, the whole allowance by 23:59:59.
 * Pure arithmetic on the clock; nothing to store. Entries are not paced:
 * trades are signal-driven, and a signal does not wait for the clock.
 */
export function pacedCap(allowed: number, nowSec: number): number {
  const into = ((Math.floor(nowSec) % DAY_SEC) + DAY_SEC) % DAY_SEC;
  return Math.min(allowed, 1 + Math.floor((allowed * into) / DAY_SEC));
}

// ── the plan ──────────────────────────────────────────────────────────────

/** Today's durable counters (energy_days). Zeros for a day with no row. */
export interface EnergyCounters {
  reviews: number;
  entries: number;
  toldAt: number | null;
}

/**
 * What the tick may do, decided once per tick and read at every fork.
 *
 * `used` is null when the counters could not be read. `left` is null when
 * entries are not limited at all — never 0, which would read as spent.
 */
export interface EnergyPlan {
  mode: EnergyMode;
  level: EnergyLevel;
  /** Not at full energy and the switch is not off: usage is counted. */
  throttled: boolean;
  /** Throttled AND enforcing: work is withheld. */
  enforce: boolean;
  day: string;
  resetsAt: number;
  reviews: { used: number | null; allowed: number; open: boolean };
  entries: { used: number | null; allowed: number; left: number | null; open: boolean };
  /** Today's owner notice has already been sent. */
  told: boolean;
}

/** Nothing limited, nothing counted — the plan whenever the switch is off. */
export const ENERGY_OFF: EnergyPlan = Object.freeze({
  mode: "off",
  level: "full",
  throttled: false,
  enforce: false,
  day: "1970-01-01",
  resetsAt: 0,
  reviews: Object.freeze({ used: null, allowed: 0, open: true }),
  entries: Object.freeze({ used: null, allowed: 0, left: null, open: true }),
  told: false,
}) as EnergyPlan;

export function energyPlan(i: {
  mode: EnergyMode;
  level: EnergyLevel;
  counters: EnergyCounters | null;
  reviewsAllowed: number;
  entriesAllowed: number;
  nowSec: number;
}): EnergyPlan {
  const throttled = i.mode !== "off" && i.level !== "full";
  const enforce = throttled && i.mode === "enforce";
  const c = i.counters;
  const reviewsUsed = c ? c.reviews : null;
  const entriesUsed = c ? c.entries : null;
  // FAIL CLOSED on an unreadable store, while enforcing — but only on NEW work.
  // Exits never consult this plan, so a broken counter cannot lock anyone in.
  const reviewsOpen = !enforce || (reviewsUsed !== null && reviewsUsed < pacedCap(i.reviewsAllowed, i.nowSec));
  const entriesOpen = !enforce || (entriesUsed !== null && entriesUsed < i.entriesAllowed);
  return {
    mode: i.mode,
    level: i.level,
    throttled,
    enforce,
    day: utcDay(i.nowSec),
    resetsAt: nextUtcMidnight(i.nowSec),
    reviews: { used: reviewsUsed, allowed: i.reviewsAllowed, open: reviewsOpen },
    entries: {
      used: entriesUsed,
      allowed: i.entriesAllowed,
      left: enforce ? (entriesUsed === null ? 0 : Math.max(0, i.entriesAllowed - entriesUsed)) : null,
      open: entriesOpen,
    },
    told: c?.toldAt != null,
  };
}

/**
 * The cap a claim is made against, or null when no claim is needed at all.
 *
 *   not throttled → null: a full-energy agent makes no energy writes, so a
 *     holder whose read goes unread after a redeploy is not greeted by a
 *     day's worth of counts it ran up while it was full.
 *   observe → effectively unlimited: count, never refuse.
 *   enforce → reviews against the PACED cap, entries against the day's.
 *   enforce with a count nobody could read → 0, which claims nothing.
 *
 * WHY THE LAST ONE IS HERE AND NOT ONLY IN THE PLAN. The plan closes a day it
 * cannot read, but not every claim asks the plan first: the strategy loop's
 * hard filter and the class entries claim every proposed entry, and the
 * strategist's window claims its review, trusting the claim's own cap. A day
 * the store reads as unreadable while its table still takes writes — a
 * rebuilt child whose history the orchestrator could not put back
 * (energy-seed.ts) — would otherwise be claimed against an EMPTY row: a fresh
 * allowance, the exact thing the unreadable reading exists to withhold. A cap
 * of 0 never writes (claimEnergyDay), so the claim is refused and nothing is
 * counted. Exits never claim, so this can hold no door shut.
 */
export function claimCap(plan: EnergyPlan, field: "reviews" | "entries", nowSec: number): number | null {
  if (!plan.throttled) return null;
  if (plan.mode !== "enforce") return Number.MAX_SAFE_INTEGER;
  if (plan[field].used === null) return 0;
  return enforcedCap(plan, field, nowSec);
}

/** The cap enforce WOULD apply — what observe mode compares against to log "would withhold". */
export function enforcedCap(plan: EnergyPlan, field: "reviews" | "entries", nowSec: number): number {
  return field === "reviews" ? pacedCap(plan.reviews.allowed, nowSec) : plan.entries.allowed;
}

/**
 * Does this intent count against today's new trades?
 *
 * Exits never do — the breaker's own exit test decides (policy.ts
 * isExitIntent). Neither does a vault deposit: steady-basket's idle-cash sweep
 * is housekeeping, reversible, and would otherwise spend a two-entry day on
 * parking cash. Nor does a curve SALE out of a leg the book holds, back into
 * that leg's own quote (`sellsHeld`, from sellsHeldLeg below).
 */
export function countsAsEntry(kind: TradeIntent["kind"], isExit: boolean, sellsHeld = false): boolean {
  return !isExit && !sellsHeld && kind !== "vault-deposit";
}

/** A curve leg the book holds: the curve it trades on and the quote it sells back into, lowercase. */
export interface HeldCurveLeg {
  curve: string;
  quote: string;
}

/**
 * WHAT THE BOOK HOLDS ON A CURVE, keyed by the held token (lowercase).
 *
 * WHY ENERGY NEEDS ITS OWN ANSWER. isExitIntent calls a curve trade an exit
 * only when it pays out into cash or a BUILT-IN grant target
 * (limits.quoteAssets = builtinGrantTargets), because the breaker cannot tell
 * a sale from a buy by the assets alone — both legs of every curve trade are
 * sellable. On a LEGACY grant (no tradeable-v2 marker) the built-ins are USDG
 * and three stock tokens, so a curve quoted in any other stock token the owner
 * sealed as an extra has an exit the breaker reads as an entry. For the
 * breaker that mattered only in a drawdown; energy asks on every low day, and
 * would withhold the sale. The tick already knows which side is which: it
 * holds the leg, and it recorded the leg's curve and quote.
 *
 *   positions  — this tick's account holdings; a leg is held only with a
 *                non-zero balance, and its curve and quote come from this
 *                pricing pass's curve legs (index.ts lastCurveLegs, by symbol).
 *   class rows — the class vault's recorded positions, held only while the
 *                vault's balance is non-zero, with the curve and quote the
 *                entry recorded. A row missing either is not a known leg.
 *
 * The breaker's own test is NOT touched: this is the energy count's fact only.
 */
export function heldCurveLegs(i: {
  positions: readonly { symbol: string; token: string; rawBalance: bigint }[];
  curveLegs: ReadonlyMap<string, { curve: string; quoteToken: string }>;
  classRows: readonly { token: string; curve: string | null; quoteToken: string | null }[] | null;
  classBalances: ReadonlyMap<string, bigint>;
}): Map<string, HeldCurveLeg> {
  const held = new Map<string, HeldCurveLeg>();
  for (const p of i.positions) {
    if (p.rawBalance <= 0n) continue;
    const leg = i.curveLegs.get(p.symbol);
    if (!leg) continue;
    held.set(p.token.toLowerCase(), { curve: leg.curve.toLowerCase(), quote: leg.quoteToken.toLowerCase() });
  }
  for (const r of i.classRows ?? []) {
    if (!r.curve || !r.quoteToken) continue;
    const token = r.token.toLowerCase();
    if ((i.classBalances.get(token) ?? 0n) <= 0n) continue;
    if (!held.has(token)) held.set(token, { curve: r.curve.toLowerCase(), quote: r.quoteToken.toLowerCase() });
  }
  return held;
}

/**
 * A curve trade that SELLS a held leg back into its own quote, on its own
 * curve. Direction is read from what is held, never from the assets' names:
 * a curve BUY pays in a quote asset (USDG, or a stock token the book may well
 * hold), and what it pays with is not a leg of THAT curve — so a buy cannot
 * pass for a sale here, however much of its quote the book holds. All three
 * must match: the token held, the curve it was recorded on, and its quote.
 */
export function sellsHeldLeg(intent: TradeIntent, held: ReadonlyMap<string, HeldCurveLeg>): boolean {
  if (intent.kind !== "curve-trade") return false;
  const leg = held.get(intent.assetIn.toLowerCase());
  return leg !== undefined && leg.curve === intent.curve.toLowerCase() && leg.quote === intent.assetOut.toLowerCase();
}

/**
 * Tell the owner now? Only when enforcing, only when an entry was actually
 * withheld — the moment the limit cost them a trade, not a pacing refusal —
 * and only if today's notice has not gone yet (the durable claim decides the
 * race; this is the cheap pre-check). shouldTellOwnerSpent is the other
 * moment: the day's new trades used up, withheld or not.
 *
 * NOT ON A DAY NOBODY CAN READ. An entry withheld because the count is
 * unreadable was withheld by the fail-closed plan, not by a spent day, and the
 * notice says the day is spent — the same guess shouldTellOwnerSpent refuses.
 * It is also the one day whose notice stamp is unknown: a rebuilt child whose
 * history could not be put back (energy-seed.ts) would claim told_at on its
 * empty row and send a notice the owner may already have had today.
 */
export function shouldTellOwner(plan: EnergyPlan, withheldEntry: boolean): boolean {
  return plan.enforce && withheldEntry && plan.entries.used !== null && !plan.told;
}

/**
 * Tell the owner now because today's new trades are USED UP — whether or not
 * an entry has been withheld yet.
 *
 * WITHHELD ALONE IS NOT ENOUGH. Most agents stop proposing entries once the
 * day is spent, before any reaches a withhold site: the fast Trencher's
 * candidate list empties, the Brain's universe shrinks to what it holds, the
 * strategist drops its buys before journaling them, and the class gate
 * closes. Waiting for a withheld entry told those owners nothing, and on iOS
 * and Android the dated warn event is the ONLY place they learn why the agent
 * went quiet. So the moment the counters reach the allowance is a moment to
 * tell them too — the same condition the report's `spent` and the Telegram
 * alert use, and the same once-a-day claim decides the race.
 *
 * A count nobody could read (`used` null) is not "spent": the fail-closed plan
 * withholds on it, but the sentence would be a guess.
 */
export function shouldTellOwnerSpent(plan: EnergyPlan): boolean {
  return plan.enforce && plan.entries.used !== null && plan.entries.used >= plan.entries.allowed && !plan.told;
}

// ── the report ────────────────────────────────────────────────────────────

/** Whole tokens from a part, or null. Unread is null — never 0. */
function tokensOf(p: bigint | null | undefined): number | null {
  return typeof p === "bigint" ? wholeTokens(p) : null;
}

/**
 * The worker's own report, as the agents row carries it (core EnergyStatus).
 *
 * Written every tick while armed, whatever the mode, so a later report always
 * supersedes an earlier one: the mirror keeps the last non-null value, and a
 * stale "spent" from an enforce day must be replaced by an honest `gated:
 * false`, not left to stand. Every surface ignores a report whose `gated` is
 * false.
 */
export function energyStatus(i: {
  plan: EnergyPlan;
  parts: BalanceParts;
  /** True when there is a paid reviewer at all; false leaves the reviews meter null. */
  hasReviewer: boolean;
  buy: EnergyBuy;
  estimateUsdg: number | null;
  nowSec: number;
}): EnergyStatus {
  const { plan } = i;
  const meter = (m: { used: number | null; allowed: number }): EnergyMeter => ({ used: m.used, allowed: m.allowed });
  const spent = plan.enforce && plan.entries.used !== null && plan.entries.used >= plan.entries.allowed;
  return {
    v: 1,
    gated: plan.mode === "enforce",
    mode: plan.mode,
    level: plan.level,
    agentTokens: tokensOf(i.parts.account),
    holderTokens: tokensOf(i.parts.holder),
    // undefined is "no such wallet" (BalanceParts): nothing to count, which is
    // not the same as a read that failed — the desk says "couldn't read" only
    // for the second.
    holderCounted: i.parts.holder !== undefined,
    needTokens: ENERGY.fullTokens,
    day: plan.day,
    resetsAt: plan.resetsAt,
    reviews: plan.throttled && i.hasReviewer ? meter(plan.reviews) : null,
    entries: plan.throttled ? meter(plan.entries) : null,
    spent,
    buy: i.buy,
    estimateUsdg: i.estimateUsdg,
    at: Math.floor(i.nowSec),
  };
}

/**
 * Can the agent buy its own energy right now, as the worker sees it?
 * Order matters: a non-mainnet account can never buy, whatever else is true.
 */
export function energyBuyOf(i: { chainId: number; live: boolean; hasRoute: boolean }): EnergyBuy {
  if (i.chainId !== ENERGY_ROUTE_V1.chainId) return "not-mainnet";
  if (!i.live) return "paper";
  if (!i.hasRoute) return "resign";
  return "ready";
}

/**
 * The raw $MERRYMEN still missing for full energy, or null when that is not
 * known. Only a reading where EVERY present part answered can say how far
 * short it is; a lower bound from a half-read would overstate the shortfall,
 * and the estimate built on it would ask the owner for more than they need.
 */
export function energyShortfallRaw(parts: BalanceParts): bigint | null {
  if (parts.holder === null || parts.account === null) return null;
  const held = (parts.holder ?? 0n) + (parts.account ?? 0n);
  return held >= ENERGY_FULL_RAW ? 0n : ENERGY_FULL_RAW - held;
}

/** Raw USDG (6dp) → whole USDG, rounded UP to the cent: an estimate never under-asks. */
export function usdgCentsUp(raw: bigint): number {
  if (raw <= 0n) return 0;
  const cents = (raw + 9_999n) / 10_000n;
  return Number(cents) / 100;
}

// ── durability: the rows the mirror carries up and the seed carries back ─

/** One energy_days row, as both sides store it. */
export interface EnergyDayRow {
  day: string;
  reviews: number;
  /** Entry claims made — gross. The day's use is entries − entriesRefunded. */
  entries: number;
  /** Entry claims handed back unused. Monotonic like `entries`, so a refund survives every copy. */
  entriesRefunded: number;
  toldAt: number | null;
  readAt: number | null;
  readFull: boolean | null;
}

/**
 * Two copies of one day, merged the way the mirror and the seed both merge:
 * counters take the larger (a copy never un-spends — nor un-refunds: the
 * refunds are a counter of their own for exactly this reason), the first
 * notice stands, and the newer read wins. Symmetric, so it does not matter
 * which side is "ours".
 */
export function mergeEnergyDay(a: EnergyDayRow, b: EnergyDayRow): EnergyDayRow {
  const aRead = a.readAt ?? 0;
  const bRead = b.readAt ?? 0;
  const newer = bRead > aRead ? b : a;
  return {
    day: a.day,
    reviews: Math.max(a.reviews, b.reviews),
    entries: Math.max(a.entries, b.entries),
    entriesRefunded: Math.max(a.entriesRefunded, b.entriesRefunded),
    toldAt: a.toldAt ?? b.toldAt,
    readAt: newer.readAt,
    readFull: newer.readFull,
  };
}

/**
 * What to write into a rebuilt child's energy_days before it arms.
 *
 * A redeploy empties the child's sqlite; without this every deploy would hand
 * out a fresh day's allowance and forget the last good balance read, so a
 * holder would sit on the reduced allowance after every restart until the
 * chain answered. Only today and yesterday travel — anything older can no
 * longer change a decision — and a malformed row is dropped rather than
 * written as zeros.
 */
export function planEnergySeed(i: {
  /** Rows from shared — database rows or parsed ones; malformed rows are dropped. */
  shared: readonly unknown[];
  child?: readonly unknown[];
  sinceDay: string;
}): EnergyDayRow[] {
  const byDay = new Map<string, EnergyDayRow>();
  for (const raw of i.child ?? []) {
    const r = energyDayRowOf(raw);
    if (r) byDay.set(r.day, byDay.has(r.day) ? mergeEnergyDay(byDay.get(r.day)!, r) : r);
  }
  for (const raw of i.shared) {
    const r = energyDayRowOf(raw);
    if (!r || r.day < i.sinceDay) continue;
    const have = byDay.get(r.day);
    byDay.set(r.day, have ? mergeEnergyDay(have, r) : r);
  }
  return [...byDay.values()].filter((r) => r.day >= i.sinceDay).sort((a, b) => (a.day < b.day ? -1 : 1));
}

const count = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
};
const stamp = (v: unknown): number | null | undefined => (v === null || v === undefined ? null : (count(v) ?? undefined));

/**
 * A row → EnergyDayRow, or null. Accepts a database row (snake_case, either
 * backend's number spelling) OR an already-parsed EnergyDayRow, so a caller
 * cannot lose a column by handing over the wrong one of the two — which is
 * exactly how told_at and the last read once vanished between the mirror and
 * the seed in energy-durability.test.ts.
 */
export function energyDayRowOf(raw: unknown): EnergyDayRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const col = (snake: string, camel: string): unknown => (snake in o ? o[snake] : o[camel]);
  if (typeof o.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.day)) return null;
  const reviews = count(o.reviews);
  const entries = count(o.entries);
  // ABSENT is zero: a table from before the refund counter kept `entries`
  // already net of its refunds. PRESENT BUT UNREADABLE drops the row, as any
  // other bad count does — never a guess at how many were handed back.
  const rawRefunded = col("entries_refunded", "entriesRefunded");
  const entriesRefunded = rawRefunded === undefined || rawRefunded === null ? 0 : count(rawRefunded);
  const toldAt = stamp(col("told_at", "toldAt"));
  const readAt = stamp(col("read_at", "readAt"));
  if (reviews === null || entries === null || entriesRefunded === null || toldAt === undefined || readAt === undefined) return null;
  const rf = col("read_full", "readFull");
  const readFull = rf === null || rf === undefined ? null : rf === true || rf === 1 || rf === "1" || rf === 1n;
  return { day: o.day, reviews, entries, entriesRefunded, toldAt, readAt, readFull: readAt === null ? null : readFull };
}
