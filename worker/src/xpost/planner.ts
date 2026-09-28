/**
 * WHEN A MERRYMAN POSTS ON X — the cadence of docs/x-posting.md "What gets
 * posted, and when", as pure decisions.
 *
 * PURE, AND THE CLOCK IS INJECTED. No Date.now, no database, no model: the
 * caller hands in the instant, the owner's zone, a clock that answers "what
 * local day / minute is it there, and is the owner asleep", this account's
 * recent posts and its fresh calls. So every rule below is exact under a held
 * clock in a test — midnight, a day with no zone, a cap reached at 23:59.
 *
 * WHAT IT DECIDES:
 *   - planPosts: which posts to draft now, under which dedupe key, due when.
 *   - sendDecision: whether a due post goes out now, waits, is skipped as
 *     stale, or is cancelled because the account it was written for is gone.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   - write anything. A plan is an intent; the glue drafts it, gates it and
 *     writes it under its UNIQUE dedupe key, which is what makes a second
 *     plan of the same thing (another replica, the next minute) a no-op;
 *   - plan while the owner is asleep. A post drafted at night would be the
 *     first thing on their timeline at 3am local, or a stale draft by morning;
 *   - plan anything but the intro before the intro has been dealt with — a
 *     coin post as the account's first ever post is how a timeline becomes a
 *     bot's;
 *   - use a coin label that could be derived from an address. A ticker like
 *     "T7631DACC21B" is an id, not a name anybody would tweet.
 */
import type { XAccount, XPost, XPostStatus } from "./store";

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * THE REVIEW WINDOW. The owner was told every post waits under "Coming up" for
 * at least ten minutes, and can be skipped there. So no post of any kind is
 * due sooner than this after it is drafted — an intro drafted late, a buy
 * found late, a casual post at its slot — and the intro is due no sooner than
 * this after consent either.
 */
export const MIN_LEAD_MS = 10 * MIN;
/** The intro goes out this long after consent, so the owner sees it drafted first. */
export const INTRO_DELAY_MS = MIN_LEAD_MS;
/** A buy is posted about only while it is this fresh. */
export const BUY_FRESH_MS = 2 * HOUR;
/** One buy post per coin in this long: a basket re-buying the same stock is not a feed of the same post. */
export const BUY_COIN_FOLD_MS = 72 * HOUR;
export const BUY_PER_DAY = 2;
/** A buy post goes out this long after the fill, by the decision's own hash. */
export const BUY_JITTER_MIN = 10;
export const BUY_JITTER_MAX = 40;
/** A buy post still waiting this long after it was drafted is stale; one that could not go out within this of the fill is not planned. */
export const BUY_STALE_MS = 8 * HOUR;
/** The least time between two posts of one account. The intro is exempt, both ways. */
export const GAP_MS = 3 * HOUR;
/** A casual post pushed further than this by the gap waits for another day instead. */
export const CASUAL_MAX_PUSH_MS = 6 * HOUR;
/** The owner's afternoon, in local minutes; with no known zone, the same length of UTC afternoon. */
export const CASUAL_WINDOW_LOCAL = [12 * 60, 20 * 60] as const;
export const CASUAL_WINDOW_UTC = [14 * 60, 22 * 60] as const;
/** How many days in ten have no casual post at all. */
export const CASUAL_QUIET_DAYS_IN_TEN = 3;
/** A casual post is due this many minutes after it is drafted, by the account's own dice: always inside the review window's promise. */
export const CASUAL_LEAD_MIN = 20;
export const CASUAL_LEAD_MAX = 45;
export const DEFAULT_PER_DAY = 3;

/** What the planner asks of time. The glue binds it to the owner-local clock the room also uses. */
export interface PlanClock {
  /** "YYYY-MM-DD" in `tz`, UTC when tz is null or unusable. */
  localDay(tz: string | null, ms: number): string;
  /** Minutes past local midnight in `tz`, UTC when tz is null; null when the zone cannot be read. */
  localMinutes(tz: string | null, ms: number): number | null;
  /** The owner's quiet hours. An unknown zone is never asleep. */
  isAsleep(tz: string | null, key: string, ms: number): boolean;
}

/** A fill as the planner weighs it — the room's call facts, narrowed. No size, no price, no reason. */
export interface PlanCall {
  decisionId: string;
  side: "buy" | "sell";
  symbol: string | null;
  name: string | null;
  paper: boolean;
  /** Unix seconds the decision was taken. */
  atSec: number;
}

export type PlanIntent =
  | { kind: "intro"; dedupeKey: string; dueAtMs: number }
  | { kind: "buy"; dedupeKey: string; dueAtMs: number; call: PlanCall; coin: string; coinKey: string }
  | { kind: "casual"; dedupeKey: string; dueAtMs: number; day: string };

export interface PlanInput {
  tenant: string;
  account: Pick<XAccount, "xUserId" | "consentAtMs">;
  /** The owner's IANA zone, or null when never learned. */
  tz: string | null;
  nowMs: number;
  clock: PlanClock;
  /** The status the intro's key was written with, or null when it is unused. */
  introStatus: XPostStatus | null;
  /** This account's posts over at least the last four days, any status. */
  posts: readonly XPost[];
  /** The agent's recent calls. Only fresh buys after consent are weighed. */
  calls: readonly PlanCall[];
  /** Posts per owner-local day. */
  perDay?: number;
  /** Whether posts that need a model (buy, casual) may be planned at all. */
  model?: boolean;
}

// ── keys and dice ───────────────────────────────────────────────────────────

const key = (tenant: string) => String(tenant ?? "").trim().toLowerCase();

export function introKey(tenant: string, xUserId: string): string {
  return `intro:${key(tenant)}:${xUserId}`;
}
export function buyKey(decisionId: string): string {
  return `buy:${decisionId}`;
}
export function casualKey(tenant: string, day: string): string {
  return `casual:${key(tenant)}:${day}`;
}

/** FNV-1a, 32 bits, with a murmur finaliser: the same dice on every replica and after every redeploy. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// ── coins ───────────────────────────────────────────────────────────────────

/** A display name a person would type: letters, with spaces, apostrophes or hyphens inside. No digit, no dot. */
const CLEAN_NAME = /^[A-Za-z](?:[A-Za-z '-]{0,22}[A-Za-z])?$/;
/** A ticker made of letters only. The ledger's address-derived ids ("T7631DACC21B") carry digits and never pass. */
const CLEAN_TICKER = /^[A-Za-z]{2,10}$/;

/**
 * The coin as a post may name it, and the key its three-day fold is kept
 * under — or null when it has no name worth tweeting.
 */
export function coinOf(call: Pick<PlanCall, "name" | "symbol">): { label: string; key: string } | null {
  const name = typeof call.name === "string" ? call.name.trim() : "";
  const symbol = typeof call.symbol === "string" ? call.symbol.trim() : "";
  const label = CLEAN_NAME.test(name) ? name : CLEAN_TICKER.test(symbol) ? symbol : null;
  if (!label) return null;
  return { label, key: (name || symbol).toLowerCase() };
}

// ── the plan ────────────────────────────────────────────────────────────────

/** A post that is out, or on its way: what caps, gaps and folds count. */
const LIVE_STATUSES: ReadonlySet<XPostStatus> = new Set(["scheduled", "sending", "posted"]);

interface Slot {
  kind: XPost["kind"];
  atMs: number;
  coin: string | null;
  createdAtMs: number;
}

function slotOf(p: XPost): Slot {
  return { kind: p.kind, atMs: p.sentAtMs ?? p.dueAtMs, coin: p.coin, createdAtMs: p.createdAtMs };
}

/**
 * THE GAP, BY PUSHING LATER. Every other non-intro post of the account at or
 * near `due` moves it to three hours after that post, until none is within
 * three hours. Only ever later: a post is never moved earlier than the rule
 * that put it where it is.
 */
function pushedPast(due: number, slots: readonly Slot[]): number {
  const times = slots.filter((s) => s.kind !== "intro").map((s) => s.atMs);
  let at = due;
  for (let moved = true, guard = 0; moved && guard < 64; guard++) {
    moved = false;
    for (const t of times) {
      if (Math.abs(at - t) < GAP_MS) {
        at = t + GAP_MS;
        moved = true;
      }
    }
  }
  return at;
}

/**
 * WHAT TO DRAFT NOW. At most one intro, or else buys and one casual post, in
 * the order they would go out. Each is checked against the account's posts
 * AND the ones planned before it in this same call, so one pass cannot
 * overrun a cap it counted before it planned.
 */
export function planPosts(input: PlanInput): PlanIntent[] {
  const { tenant, account, tz, nowMs: now, clock } = input;
  const perDay = Number.isFinite(input.perDay) && (input.perDay ?? 0) >= 1 ? Math.floor(input.perDay!) : DEFAULT_PER_DAY;
  if (!account.xUserId || account.consentAtMs === null || account.consentAtMs === undefined) return [];
  // NOTHING IS PLANNED WHILE THE OWNER SLEEPS — the intro included.
  if (clock.isAsleep(tz, key(tenant), now)) return [];

  // THE INTRO FIRST, AND ALONE.
  if (input.introStatus === null) {
    return [{ kind: "intro", dedupeKey: introKey(tenant, account.xUserId), dueAtMs: Math.max(now + MIN_LEAD_MS, account.consentAtMs + INTRO_DELAY_MS) }];
  }
  if (input.introStatus === "scheduled" || input.introStatus === "sending") return [];
  if (input.model === false) return [];

  const slots: Slot[] = input.posts.filter((p) => LIVE_STATUSES.has(p.status)).map(slotOf);
  const used = new Set(input.posts.map((p) => p.dedupeKey));
  const dayOf = (ms: number) => clock.localDay(tz, ms);
  const onDay = (day: string, kind?: XPost["kind"]) => slots.filter((s) => dayOf(s.atMs) === day && (!kind || s.kind === kind)).length;
  const out: PlanIntent[] = [];

  // BUYS: fresh, after consent, one per coin in three days, two a day at most.
  const buys = input.calls
    .filter((c) => c.side === "buy" && Number.isFinite(c.atSec) && typeof c.decisionId === "string" && c.decisionId !== "")
    .filter((c) => c.atSec * 1000 > account.consentAtMs! && now - c.atSec * 1000 <= BUY_FRESH_MS && c.atSec * 1000 <= now)
    .sort((a, b) => a.atSec - b.atSec);
  for (const call of buys) {
    const dedupeKey = buyKey(call.decisionId);
    if (used.has(dedupeKey)) continue;
    const coin = coinOf(call);
    if (!coin) continue;
    if (slots.some((s) => s.kind === "buy" && s.coin === coin.key && s.createdAtMs >= now - BUY_COIN_FOLD_MS)) continue;
    const fillMs = call.atSec * 1000;
    const jitter = BUY_JITTER_MIN + (hash32(`buy|${call.decisionId}`) % (BUY_JITTER_MAX - BUY_JITTER_MIN + 1));
    const due = pushedPast(Math.max(fillMs + jitter * MIN, now + MIN_LEAD_MS), slots);
    if (due > fillMs + BUY_STALE_MS) continue;
    const day = dayOf(due);
    if (onDay(day, "buy") >= BUY_PER_DAY || onDay(day) >= perDay) continue;
    out.push({ kind: "buy", dedupeKey, dueAtMs: due, call, coin: coin.label, coinKey: coin.key });
    slots.push({ kind: "buy", atMs: due, coin: coin.key, createdAtMs: now });
    used.add(dedupeKey);
  }

  // ONE CASUAL POST, at the account's own slot in the owner's afternoon, most days.
  const today = dayOf(now);
  const cKey = casualKey(tenant, today);
  const minutes = clock.localMinutes(tz, now);
  if (!used.has(cKey) && minutes !== null) {
    const [start, end] = tz ? CASUAL_WINDOW_LOCAL : CASUAL_WINDOW_UTC;
    const h = hash32(`casual|${key(tenant)}|${today}`);
    const quiet = h % 10 < CASUAL_QUIET_DAYS_IN_TEN;
    // The slot leaves half an hour of window after it, so a pass that lands late still finds it.
    const slot = start + (Math.floor(h / 10) % (end - start - 30));
    if (!quiet && minutes >= slot && minutes < end) {
      const lead = CASUAL_LEAD_MIN + (hash32(`casual-lead|${cKey}`) % (CASUAL_LEAD_MAX - CASUAL_LEAD_MIN + 1));
      const due = pushedPast(now + lead * MIN, slots);
      const day = dayOf(due);
      if (due - now <= CASUAL_MAX_PUSH_MS && onDay(day) < perDay) {
        out.push({ kind: "casual", dedupeKey: cKey, dueAtMs: due, day: today });
        slots.push({ kind: "casual", atMs: due, coin: null, createdAtMs: now });
      }
    }
  }
  return out.sort((a, b) => a.dueAtMs - b.dueAtMs);
}

// ── sending ─────────────────────────────────────────────────────────────────

export type SendDecision =
  | { action: "send" }
  | { action: "wait" }
  | { action: "skip"; reason: "stale" }
  | { action: "cancel"; reason: "account-gone" | "account-changed" | "account-off" };

/**
 * MAY THIS DUE POST GO OUT NOW?
 *
 *   cancel — the account it was written for is gone, is a different X
 *            account now, or no longer posts (switched off, revoked). The
 *            web cancels drafts on each of those already; this is the
 *            backstop for a draft planned in the same instant.
 *   skip   — a buy post still waiting eight hours after it was drafted is
 *            news nobody asked for any more.
 *   wait   — the owner is asleep, or it is not due yet.
 *   send   — otherwise.
 */
export function sendDecision(post: Pick<XPost, "kind" | "xUserId" | "createdAtMs" | "dueAtMs">, account: Pick<XAccount, "xUserId" | "posting"> | null, nowMs: number, asleep: boolean): SendDecision {
  if (!account) return { action: "cancel", reason: "account-gone" };
  if (account.xUserId !== post.xUserId) return { action: "cancel", reason: "account-changed" };
  if (!account.posting) return { action: "cancel", reason: "account-off" };
  if (post.kind === "buy" && nowMs - post.createdAtMs > BUY_STALE_MS) return { action: "skip", reason: "stale" };
  if (asleep || post.dueAtMs > nowMs) return { action: "wait" };
  return { action: "send" };
}
