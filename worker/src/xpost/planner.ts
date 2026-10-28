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
 *     first thing on their timeline at 3am local, or a stale draft by morning.
 *     The one exception is an active agent's trade posts (PlanCadence
 *     .tradesAtNight, 2026-10-14): it trades around the clock, and its buys,
 *     sales and recaps go out when they happen;
 *   - plan anything but the intro before the intro has been dealt with — a
 *     coin post as the account's first ever post is how a timeline becomes a
 *     bot's, and it is the intro that says an AI trading agent is posting.
 *     "Dealt with" is: it went out, the owner skipped it, or it may have gone
 *     out (X's answer was unknown, or a duplicate). An intro that was
 *     cancelled for any other reason (switched off, disconnected, revoked),
 *     skipped by the gate, or refused by X is drafted AGAIN under a new key,
 *     at most three times per consent (introState);
 *   - use a coin label that could be derived from an address. A ticker like
 *     "T7631DACC21B" is an id, not a name anybody would tweet;
 *   - plan a kind the owner turned off (PlanInput.kinds), or more a day than
 *     the owner chose. The owner's cap counts their posts; the server's
 *     still counts the whole X account. The hello cannot be turned off.
 */
import type { XAccount, XPost, XPostPrefs, XPostStatus } from "./store";

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * THE REVIEW WINDOW. The owner was told every post waits under "Coming up" for
 * at least ten minutes, and can be skipped there. So no post of any kind is
 * due sooner than this after it is drafted — an intro drafted late, a buy
 * found late, a casual post at its slot — and the intro is due no sooner than
 * this after consent either. The one exception is not planned here: an active
 * agent's answer to a post that tagged it is due when drafted, and the reply
 * warning that turned answers on says so (orchestrator-xpost.ts writeAnswer).
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
/**
 * AN ACTIVE AGENT'S WIDER WINDOW (the owner's ask, 2026-10-14: "widen the
 * 2-hour window"). Its trades are posted while six hours fresh, and a single
 * post may go out up to ten hours after its fill: a morning burst is still
 * news that afternoon. A recap says trades up to RECAP_WINDOW_MS old when it
 * is drafted and goes stale as a single post does, so up to twelve.
 */
export const ACTIVE_TRADE_FRESH_MS = 6 * HOUR;
export const ACTIVE_TRADE_STALE_MS = 10 * HOUR;
/**
 * HOW LONG A DRAFTED ACTIVE TRADE POST MAY WAIT TO GO OUT (review of the
 * recap branch, 2026-10-14). Counted from the draft, as every staleness at
 * send time is: a post drafted up to six hours after its fill and sent four
 * hours after that is the ten hours ACTIVE_TRADE_STALE_MS promises, never the
 * sixteen a ten-hour send window would have let through.
 */
export const ACTIVE_TRADE_SEND_STALE_MS = ACTIVE_TRADE_STALE_MS - ACTIVE_TRADE_FRESH_MS;
/**
 * THE RECAP (planRecap). A single trade post planned to go out further
 * ahead than RECAP_HORIZON_MS is left for the recap instead. A recap is
 * planned when at least RECAP_MIN_UNPOSTED trades of the window were not
 * posted one by one, the newest of them at least RECAP_SETTLE_MS old (the
 * burst has paused) or RECAP_FLUSH_UNPOSTED of them waiting, and no recap
 * went out in RECAP_GAP_MS; or, gap allowing, at once when a trade not posted
 * one by one is past the freshness a single post needs (the recap is the
 * only post left that can say it). It covers every trade since the last
 * recap, at most RECAP_WINDOW_MS back, and goes out within RECAP_MAX_PUSH_MS.
 */
/** One gap: in a burst, one single post goes out soon and the recap after it says the rest (second review, 2026-10-14). */
export const RECAP_HORIZON_MS = 75 * MIN;
export const RECAP_MIN_UNPOSTED = 3;
export const RECAP_FLUSH_UNPOSTED = 8;
export const RECAP_SETTLE_MS = 20 * MIN;
/** Four hours: at most six a day, so a hundred recap lines last one active agent more than the gate's two weeks of memory (a second needs more lines: docs/x-posting.md). */
export const RECAP_GAP_MS = 4 * HOUR;
/**
 * Eight hours back at most: two hours past a single post's freshness, so a
 * trade the singles could not reach is still in the window when the gap
 * opens. The plan pass reads at least this much of the calls whether or not
 * it read mentions (orchestrator-xpost.ts planPass; third review, 2026-10-14:
 * without a mention batch it read six hours, and the window was six).
 */
export const RECAP_WINDOW_MS = 8 * HOUR;
/**
 * HOW MANY OF AN AGENT'S NEWEST FILLS THE PLAN PASS READS when an active
 * agent is in it (review of PR #334, 2026-10-14): the facts read keeps the
 * newest CALLS_PER_AGENT (180), and a paper basket filling three coins every
 * four minutes passes 180 in four hours, so the six-to-eight-hour-old trades
 * only a recap can say were cut before it saw them. Eight hours at twice that
 * pace, and under the figures line's 999 a count may say. A live agent's
 * operation cap keeps it far below either.
 */
export const RECAP_CALLS_PER_AGENT = 720;
/**
 * A recap planned further out than this is not planned: it must go out with a
 * gap's room to spare before it goes stale (ACTIVE_TRADE_SEND_STALE_MS less
 * the active gap), or one send-time deferral would skip it (second review of
 * the recap branch, 2026-10-14).
 */
export const RECAP_MAX_PUSH_MS = 2 * HOUR + 30 * MIN;
/** A reply waiting this long is no longer timely. */
export const REPLY_STALE_MS = 24 * HOUR;
export const REPLY_ROOT_MAX_AGE_MS = 72 * HOUR;
export const REPLIES_PER_ROOT = 2;
/**
 * An active agent's answers to tags: their own gap and day allowance, never
 * the cadence's. Twenty seconds apart: they go out as soon as they are
 * drafted, on the pass that read the tag, and mentions are read every fifteen
 * seconds, so a few people tagging at once are each answered within a pass or
 * two of each other.
 *
 * SIXTY A DAY (the owner's decision, 2026-10-12: whoever replies to it or
 * quotes it is asking, and a person should be able to actually chat with it):
 * up from 24, still a day allowance of its own per X account (taken at send
 * time, `answerday:<xUserId>:<local day>`), still under the fleet's day
 * ceiling (DEFAULT_FLEET_PER_DAY, 1000) and never spending the model
 * allowance any faster (ANSWER_DRAFTS_PER_DAY is unchanged: code's own lines
 * spend none). Answers exist only for the operator's active owners.
 */
export const ANSWER_GAP_MS = 20_000;
export const ANSWERS_PER_DAY = 60;
/**
 * An answer still waiting this long after it was drafted is no longer one:
 * the person was told it goes out right away, and a pause, an outage or the
 * day's allowance that held it this long would otherwise send it at an
 * arbitrary hour, on another day's allowance.
 */
export const ANSWER_STALE_MS = HOUR;
/** The least time between two posts of one account. The intro is exempt, both ways. */
export const GAP_MS = 3 * HOUR;
/** A casual post pushed further than this by the gap waits for another day instead; one held this long past due is stale. */
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

/**
 * HOW OFTEN ONE ACCOUNT POSTS. STANDARD_CADENCE is every owner's: three a day,
 * three hours apart, two trade posts and one casual afternoon post on most
 * days. ACTIVE_CADENCE is the operator's opt-in for named owners
 * (MERRYMEN_XPOST_ACTIVE_TENANTS): about ten a day, seventy-five minutes
 * apart, every buy posted, casual posts spread over the waking day and mostly about how it
 * trades. It never lifts the owner's own smaller choice, the fleet's day
 * ceiling, the model allowance, the review window, the night, or the gate.
 */
export interface PlanCadence {
  /** Posts per owner-local day, the X account's ceiling for this owner. */
  perDay: number;
  /** The least time between two non-intro posts of one X account. */
  gapMs: number;
  /** Buy and sale posts per owner-local day, together. */
  tradePerDay: number;
  /** Casual posts per owner-local day; their slots split the window evenly. */
  casualPerDay: number;
  /** The casual window in local minutes, and the same length in UTC when no zone is known. */
  casualWindowLocal: readonly [number, number];
  casualWindowUtc: readonly [number, number];
  /** Owner-local days in ten with no casual post at all. */
  casualQuietDaysInTen: number;
  /** Casual slots in ten handed how it trades rather than a passing thought (orchestrator casualInputs). */
  tradeTalkInTen: number;
  /**
   * One buy post, and one sale post, per coin in this long. 0 is no fold: a
   * rebuy of the same coin is posted again, still bounded by tradePerDay,
   * perDay and the gap. Checked when planned and claimed again at send time.
   */
  coinFoldMs: number;
  /**
   * TRADE POSTS THROUGH THE OWNER'S NIGHT (the owner's ask, 2026-10-14: "let
   * his trade posts through at night"). The night keeps a person's own
   * timeline quiet; an operator's trading agent trades around the clock, and
   * a buy it made at three in the morning was never posted at all (planned
   * only in the morning, by then past its freshness). True: buys, sales and
   * recaps are planned and sent at night; the intro and casual posts still
   * wait for morning.
   */
  tradesAtNight: boolean;
  /** A trade is posted about only while it is this fresh. */
  tradeFreshMs: number;
  /** A trade post that cannot go out within this of its fill is not planned. */
  tradeStaleMs: number;
  /** A drafted trade post (or recap) still waiting this long after it was drafted is stale (sendDecision). */
  sendStaleMs: number;
  /**
   * ONE RECAP FOR A BURST (the owner's ask, 2026-10-14): when more trades
   * come in than the gap lets it post one by one, the ones that could not
   * go out soon are said together in one recap post, instead of a queue of
   * single posts that goes stale (planRecap).
   */
  recap: boolean;
}

export const STANDARD_CADENCE: Readonly<PlanCadence> = Object.freeze({
  perDay: DEFAULT_PER_DAY,
  gapMs: GAP_MS,
  tradePerDay: BUY_PER_DAY,
  casualPerDay: 1,
  casualWindowLocal: CASUAL_WINDOW_LOCAL,
  casualWindowUtc: CASUAL_WINDOW_UTC,
  casualQuietDaysInTen: CASUAL_QUIET_DAYS_IN_TEN,
  tradeTalkInTen: 3,
  coinFoldMs: BUY_COIN_FOLD_MS,
  tradesAtNight: false,
  tradeFreshMs: BUY_FRESH_MS,
  tradeStaleMs: BUY_STALE_MS,
  sendStaleMs: BUY_STALE_MS,
  recap: false,
});

/**
 * Eight casual slots from 09:00 to 23:30 local, and a post for every buy and
 * completed sale on top — a rebuy of a coin it posted about yesterday too, so
 * no coin fold — up to twelve a day: the seventy-five minute gap over a
 * waking day is the real ceiling.
 */
export const ACTIVE_CADENCE: Readonly<PlanCadence> = Object.freeze({
  perDay: 12,
  gapMs: 75 * MIN,
  tradePerDay: 12,
  casualPerDay: 8,
  casualWindowLocal: [9 * 60, 23 * 60 + 30] as const,
  casualWindowUtc: [9 * 60, 23 * 60 + 30] as const,
  casualQuietDaysInTen: 0,
  tradeTalkInTen: 7,
  coinFoldMs: 0,
  tradesAtNight: true,
  tradeFreshMs: ACTIVE_TRADE_FRESH_MS,
  tradeStaleMs: ACTIVE_TRADE_STALE_MS,
  sendStaleMs: ACTIVE_TRADE_SEND_STALE_MS,
  recap: true,
});

/** More casual opportunities within the twelve-post ceiling the owner consented to. */
export const VARIED_CADENCE: Readonly<PlanCadence> = Object.freeze({ ...ACTIVE_CADENCE, casualPerDay: 10 });

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

export type SaleOutcome = "profit" | "loss" | "flat" | "unknown";

/** Receipt-backed completed sale; only the read-only result builder supplies these. */
export interface PlanSell extends PlanCall {
  side: "sell";
  operationKey: string;
  token: string;
  outcome: SaleOutcome;
  /** Measured gross gain on the evidenced cost, in percent; null when the cost is not evidenced. */
  gainPct?: number | null;
}

/**
 * A WIN: a sale its receipts measured as a profit, with a gain big enough to
 * show at one decimal (sale-outcome.ts gainFigure, never "+0%"). On a recap
 * cadence a win is posted alone, with its P&L card; every other sale is the
 * recap's to count (the owner's ask, 2026-10-14).
 */
export function isWin(s: Pick<PlanSell, "outcome" | "gainPct">): boolean {
  return s.outcome === "profit" && typeof s.gainPct === "number" && Number.isFinite(s.gainPct) && s.gainPct >= 0.05;
}

export type PlanIntent =
  /** `attempt` is 0 for the account's first hello, n for the n-th redraft. */
  | { kind: "intro"; dedupeKey: string; dueAtMs: number; attempt: number }
  | { kind: "buy"; dedupeKey: string; dueAtMs: number; call: PlanCall; coin: string; coinKey: string }
  | { kind: "sell"; dedupeKey: string; dueAtMs: number; call: PlanSell; coin: string; coinKey: string }
  /** `slot` is 0 for the day's first casual post; ACTIVE_CADENCE has more than one. */
  | { kind: "casual"; dedupeKey: string; dueAtMs: number; day: string; slot: number }
  /**
   * A RECAP of every trade since the last one (planRecap): its buys (calls)
   * and its sales (receipt-backed when trade results are on, else calls),
   * of the money it trades with now. `toSec` is the newest trade it covers,
   * in its key, so no later plan posts those trades one by one.
   */
  | { kind: "recap"; dedupeKey: string; dueAtMs: number; buys: PlanCall[]; sells: PlanSell[]; results: PlanSell[]; toSec: number;
      /** The single-post keys of every trade it says (buyKey, sellKey): stored on its row (recapCoverOf), never recapped again, nor posted alone but an active owner's win. */
      covers: string[] };

/** An intro row, as introState weighs it. */
export type IntroRow = Pick<XPost, "dedupeKey" | "status" | "reason" | "createdAtMs" | "updatedAtMs">;

export interface PlanInput {
  tenant: string;
  /** `connectedAtMs`, when given, counts as the owner acting again, like a new consent. */
  account: Pick<XAccount, "xUserId" | "consentAtMs"> & Partial<Pick<XAccount, "connectedAtMs">>;
  /** The owner's IANA zone, or null when never learned. */
  tz: string | null;
  nowMs: number;
  clock: PlanClock;
  /** EVERY intro row this owner ever wrote for this X account, any status, any age. */
  intros: readonly IntroRow[];
  /**
   * The X ACCOUNT's posts over at least the last four days, any status — from
   * every owner that posts on it, so one X account connected to two owners
   * still gets one cadence.
   */
  posts: readonly XPost[];
  /** The agent's recent calls. Only fresh buys after consent are weighed. */
  calls: readonly PlanCall[];
  /** Explicit owner opt-in; absent preserves the original buys-only behavior. */
  tradeResults?: boolean;
  sells?: readonly PlanSell[];
  /** Posts per owner-local day. */
  perDay?: number;
  /** Optional smaller allowance for this tenant, separate from the shared X account cap. */
  ownerPerDay?: number | null;
  /** Whether posts that need a model (buy, casual) may be planned at all. */
  model?: boolean;
  /** Active timeline pools can write without a model; buy drafting still requires one. */
  codeCasual?: boolean;
  /** The kinds the owner lets it post (XPostPrefs). Absent, or a field absent, is on. */
  kinds?: Partial<Pick<XPostPrefs, "buys" | "casual">>;
  /** How often this account posts. Absent is STANDARD_CADENCE; `perDay`, when given, still sets the ceiling. */
  cadence?: Readonly<PlanCadence>;
  /** The money it trades with now: a recap says only trades of it. Null (idle) or absent: no recap. */
  money?: "live" | "paper" | null;
  /**
   * THIS OWNER'S RECAP ROWS of at least the last RECAP_WINDOW_MS +
   * RECAP_GAP_MS, any status (store.ts recapPostsOf): what they covered and
   * when the last went out. Read apart from `posts`, which is capped at a few
   * hundred rows that a day of answers can fill. Absent: `posts`' own recaps.
   */
  recaps?: readonly XPost[];
}

// ── keys and dice ───────────────────────────────────────────────────────────

const key = (tenant: string) => String(tenant ?? "").trim().toLowerCase();

/** The intro's key: the first hello's is `intro:<tenant>:<xUserId>`, the n-th redraft's adds `:<n>`. */
export function introKey(tenant: string, xUserId: string, attempt = 0): string {
  const base = `intro:${key(tenant)}:${xUserId}`;
  return attempt > 0 ? `${base}:${attempt}` : base;
}
export function buyKey(decisionId: string): string {
  return `buy:${decisionId}`;
}
export function sellKey(tenant: string, operationKey: string): string {
  return `sell:${key(tenant)}:${operationKey.toLowerCase()}`;
}
/** Slot 0 keeps the historic `casual:<tenant>:<day>`; a later slot of an active day adds `:<slot>`. */
/** A recap's key: the newest trade it covers, so the next recap starts after it. */
export function recapKey(tenant: string, toSec: number, covers: readonly string[] = []): string {
  // THE SET IT COVERS IN THE KEY, not only its newest second (second review,
  // 2026-10-14): a later recap whose newest trade shares that second (late
  // trades decided before it) was blocked forever by the earlier one's key.
  const set = covers.length ? `:${hash32([...covers].sort().join(" ")).toString(36)}` : "";
  return `recap:${key(tenant)}:${Math.floor(toSec)}${set}`;
}
/**
 * WHAT A RECAP ROW COVERS: the single-post keys of the trades it said, kept
 * in its row's `coin` column (unused by a recap otherwise), space-separated,
 * written in the same insert as the recap so the two never disagree.
 * Covered BY KEY, never by a time (review of the recap branch, 2026-10-14):
 * a watermark at its newest trade dropped a trade that landed after the
 * recap but was decided before it, so that trade was never said at all.
 */
export function recapCoverText(keys: readonly string[]): string {
  return [...new Set(keys.filter((k) => typeof k === "string" && /^(?:buy|sell):\S+$/.test(k)))].join(" ");
}
export function recapCoverOf(coin: unknown): string[] {
  return typeof coin === "string" ? coin.split(" ").filter((k) => /^(?:buy|sell):\S+$/.test(k)) : [];
}
/**
 * A POST THAT IS OUT, ON ITS WAY, OR MAY BE OUT: what a recap's cover and gap
 * count (review of the recap branch, 2026-10-14). A send that ended
 * uncertain, interrupted or in our own fault may well be on X and is never
 * resent (sender.ts); its trades were said all the same.
 */
const MAYBE_OUT_REASONS: ReadonlySet<string> = new Set(["uncertain", "interrupted", "fault"]);
export function maybeOut(p: Pick<XPost, "status" | "reason">): boolean {
  return LIVE_STATUSES.has(p.status) || (p.status === "failed" && MAYBE_OUT_REASONS.has(p.reason ?? ""));
}
/**
 * WHEN A RECAP WENT OUT, OR MAY HAVE, OR WILL (second review, 2026-10-14), as
 * store.ts lastOutAt reads a post: posted, when it was sent; sending or a
 * send that may be out, when that send ended (a held send fails long after
 * its due time, and a gap from the due time could follow it minutes later);
 * still scheduled, its due time or now, whichever is later, so no second
 * recap is planned behind one that is waiting to go.
 */
export function recapOutAt(p: Pick<XPost, "status" | "sentAtMs" | "dueAtMs" | "updatedAtMs">, nowMs: number): number {
  if (p.status === "posted") return p.sentAtMs ?? p.updatedAtMs;
  if (p.status === "scheduled") return Math.max(p.dueAtMs, nowMs);
  return p.updatedAtMs;
}
export function casualKey(tenant: string, day: string, slot = 0): string {
  return slot > 0 ? `casual:${key(tenant)}:${day}:${slot}` : `casual:${key(tenant)}:${day}`;
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

// ── the intro ───────────────────────────────────────────────────────────────

/** Hellos drafted per consent before the account stays quiet until the owner acts again. */
export const INTRO_ATTEMPTS = 3;

/** A failed intro that may be on X all the same — never drafted again, so never said twice. */
const INTRO_MAYBE_OUT: ReadonlySet<string> = new Set(["uncertain", "interrupted", "duplicate", "fault"]);

export type IntroState =
  /** It went out, the owner skipped it, or it may have gone out: the rest may follow. */
  | { state: "done" }
  /** Drafted and not out yet: it holds everything else. */
  | { state: "waiting" }
  /** Draft one now, under this key. */
  | { state: "draft"; dedupeKey: string; attempt: number }
  /** Not dealt with, and not to be drafted now: everything else is held. */
  | { state: "held" };

function introDealtWith(r: IntroRow): boolean {
  if (r.status === "posted") return true;
  if (r.status === "cancelled" && r.reason === "owner") return true;
  return r.status === "failed" && INTRO_MAYBE_OUT.has(r.reason ?? "");
}

/**
 * HAS THIS ACCOUNT'S HELLO BEEN DEALT WITH — AND IF NOT, MAY ONE BE DRAFTED NOW?
 *
 * Each draft has its own key (the first is the historic `intro:<t>:<x>`, so
 * rows written before redrafts existed keep their meaning), because a key is
 * spent once written. A hello that did not go out for a reason the owner did
 * not choose — switched off before it was due, a disconnect or a revoke, the
 * gate or the template pool refusing it, X refusing the account — is drafted
 * again:
 *   - at once when the owner acted since it ended (consented again, or
 *     reconnected): a new consent is a new plan;
 *   - otherwise not before the owner's next local day, so an account X
 *     refused is not asked again every minute;
 *   - at most INTRO_ATTEMPTS times per consent. After that nothing else is
 *     planned either — a coin post is never the first post — until the owner
 *     acts again.
 */
export function introState(p: {
  tenant: string;
  account: PlanInput["account"];
  intros: readonly IntroRow[];
  nowMs: number;
  dayOf: (ms: number) => string;
}): IntroState {
  const base = introKey(p.tenant, p.account.xUserId);
  const mine = p.intros.filter((r) => r.dedupeKey === base || r.dedupeKey.startsWith(`${base}:`));
  if (mine.length === 0) return { state: "draft", dedupeKey: base, attempt: 0 };
  if (mine.some(introDealtWith)) return { state: "done" };
  if (mine.some((r) => r.status === "scheduled" || r.status === "sending")) return { state: "waiting" };
  const since = Math.max(p.account.consentAtMs ?? 0, p.account.connectedAtMs ?? 0);
  if (mine.filter((r) => r.createdAtMs >= since).length >= INTRO_ATTEMPTS) return { state: "held" };
  const lastEnded = Math.max(...mine.map((r) => r.updatedAtMs));
  const ownerActed = lastEnded < since;
  const nextDay = p.nowMs > lastEnded && p.dayOf(p.nowMs) !== p.dayOf(lastEnded);
  if (!ownerActed && !nextDay) return { state: "held" };
  const attempt = 1 + Math.max(...mine.map((r) => (r.dedupeKey === base ? 0 : Number.parseInt(r.dedupeKey.slice(base.length + 1), 10) || 0)));
  return { state: "draft", dedupeKey: introKey(p.tenant, p.account.xUserId, attempt), attempt };
}

// ── the plan ────────────────────────────────────────────────────────────────

/** A post that is out, or on its way: what caps, gaps and folds count. */
const LIVE_STATUSES: ReadonlySet<XPostStatus> = new Set(["scheduled", "sending", "posted"]);

interface Slot {
  tenant: string;
  kind: XPost["kind"];
  atMs: number;
  coin: string | null;
  createdAtMs: number;
}

function slotOf(p: XPost): Slot {
  return { tenant: key(p.tenant), kind: p.kind, atMs: p.sentAtMs ?? p.dueAtMs, coin: p.coin, createdAtMs: p.createdAtMs };
}

/** The owner's optional smaller ceiling never raises the server's ceiling. */
function ownerLimit(perDay: number, ownerPerDay?: number | null): number {
  return Number.isSafeInteger(ownerPerDay) && (ownerPerDay ?? 0) >= 1 ? Math.min(perDay, ownerPerDay!) : perDay;
}

/**
 * THE GAP, BY PUSHING LATER. Every other non-intro post of the account at or
 * near `due` moves it to three hours after that post, until none is within
 * three hours. Only ever later: a post is never moved earlier than the rule
 * that put it where it is.
 */
function pushedPast(due: number, slots: readonly Slot[], gapMs: number = GAP_MS): number {
  const times = slots.filter((s) => s.kind !== "intro").map((s) => s.atMs);
  let at = due;
  for (let moved = true, guard = 0; moved && guard < 64; guard++) {
    moved = false;
    for (const t of times) {
      if (Math.abs(at - t) < gapMs) {
        at = t + gapMs;
        moved = true;
      }
    }
  }
  return at;
}

/** A post of this kind about this coin within the cadence's fold, so this one is not planned. A fold of 0 folds nothing. */
function folded(slots: readonly Slot[], kind: "buy" | "sell", coin: string, now: number, foldMs: number): boolean {
  return foldMs > 0 && slots.some((s) => s.kind === kind && s.coin === coin && s.createdAtMs >= now - foldMs);
}

/**
 * WHAT TO DRAFT NOW. At most one intro, or else buys and one casual post, in
 * the order they would go out. Each is checked against the account's posts
 * AND the ones planned before it in this same call, so one pass cannot
 * overrun a cap it counted before it planned.
 */
export function planPosts(input: PlanInput): PlanIntent[] {
  const { tenant, account, tz, nowMs: now, clock } = input;
  const cadence = input.cadence ?? STANDARD_CADENCE;
  const perDay = Number.isFinite(input.perDay) && (input.perDay ?? 0) >= 1 ? Math.floor(input.perDay!) : cadence.perDay;
  const gap = cadence.gapMs;
  const ownerPerDay = ownerLimit(perDay, input.ownerPerDay);
  if (!account.xUserId || account.consentAtMs === null || account.consentAtMs === undefined) return [];
  // NOTHING IS PLANNED WHILE THE OWNER SLEEPS — the intro included — but an
  // active agent's trade posts (PlanCadence.tradesAtNight): its buys, sales
  // and recaps are planned at night too; its intro and casual posts are not.
  const asleep = clock.isAsleep(tz, key(tenant), now);
  if (asleep && !cadence.tradesAtNight) return [];

  const dayOf = (ms: number) => clock.localDay(tz, ms);

  // THE INTRO FIRST, AND ALONE.
  const intro = introState({ tenant, account, intros: input.intros, nowMs: now, dayOf });
  if (intro.state === "draft" && asleep) return [];
  if (intro.state === "draft") {
    return [{ kind: "intro", dedupeKey: intro.dedupeKey, attempt: intro.attempt, dueAtMs: Math.max(now + MIN_LEAD_MS, account.consentAtMs + INTRO_DELAY_MS) }];
  }
  if (intro.state !== "done") return [];
  // NO MODEL, NO SINGLE POST OR CASUAL ONE; A RECAP AND A WIN STILL (review of
  // the recap branch, 2026-10-14): a recap's words and figures are code's, and
  // so are a win's when the model cannot write them (sale-words.ts), so a spent
  // model allowance, or no model at all, never silences a burst or a win.
  const modelOk = input.model !== false;

  // An answer to a tag has its own lane: it neither spends nor waits on the cadence.
  const slots: Slot[] = input.posts.filter((p) => LIVE_STATUSES.has(p.status) && p.kind !== "answer").map(slotOf);
  const used = new Set(input.posts.map((p) => p.dedupeKey));
  const onDay = (day: string, kind?: XPost["kind"]) => slots.filter((s) => dayOf(s.atMs) === day && (!kind || s.kind === kind)).length;
  const ownerOnDay = (day: string) => slots.filter((s) => s.tenant === key(tenant) && dayOf(s.atMs) === day).length;
  /** Trade posts on a day: buys, sales and recaps share the trade allowance. */
  const tradesOnDay = (day: string) => onDay(day, "buy") + onDay(day, "sell") + onDay(day, "recap");
  const out: PlanIntent[] = [];
  const freshMs = cadence.tradeFreshMs, staleMs = cadence.tradeStaleMs;
  // EVERY TRADE A RECAP ALREADY SAID is never recapped again, nor posted one
  // by one after it but an active owner's win (which still goes out alone,
  // with its card): the keys this owner's recaps that are out, on their way or
  // may be out (maybeOut) covered (recapCoverOf). Only this owner's own
  // recaps: on a shared X account another owner's trades are another owner's.
  const ownRecaps = (input.recaps ?? input.posts).filter((p) => p.kind === "recap" && key(p.tenant) === key(tenant) && maybeOut(p));
  const covered = new Set(ownRecaps.flatMap((p) => recapCoverOf(p.coin)));
  // ON A RECAP CADENCE, A SINGLE POST GOES OUT SOON OR NOT AT ALL: one that
  // the gap would push past the horizon is left for the recap (planRecap),
  // so a burst is one post, not a queue of single posts going stale.
  // Only where a recap can pick it up: no recap (a standard cadence, buy posts
  // off, an idle agent), and every trade is posted one by one as before.
  const recaps = cadence.recap && input.kinds?.buys !== false && (input.money === "live" || input.money === "paper");
  const soonEnough = (due: number) => !recaps || due <= now + RECAP_HORIZON_MS;
  // NEVER PLANNED TO GO STALE (second review, 2026-10-14): a trade post due
  // past its send staleness is skipped at send time for certain; on the active
  // cadence, a gap's room is kept for one send-time deferral.
  const sendable = (due: number) => due - now <= cadence.sendStaleMs - (cadence.recap ? gap : 0);
  // THE DAY'S LAST POST IS THE RECAP'S (review of the wins branch,
  // 2026-10-14): wins, buys and casual posts took the day's allowance before
  // any recap, and the losses that day were never counted. On a recap
  // cadence, while the day has room for more than one post (second review:
  // an owner who chose one post a day got recaps only):
  //   - a single post (a win, a buy) never takes the day's last post: the
  //     recap does, and says whatever the day still has to say, wins that
  //     could not go alone included (Codex review of PR #336: twelve wins
  //     spent the day, a thirteenth could neither go alone nor be recapped,
  //     and by the next day's recap it was past the window);
  //   - a casual post takes it only while no trade waits for the recap (a
  //     quiet day keeps its casual posts).
  const liveNow = new Set(input.posts.filter((p) => maybeOut(p)).map((p) => p.dedupeKey));
  const recapFrom = Math.max(account.consentAtMs, now - RECAP_WINDOW_MS);
  const inRecapWindow = (atSec: number) => Number.isFinite(atSec) && atSec * 1000 > recapFrom && atSec * 1000 <= now;
  const unsaid = (k: string) => !covered.has(k) && !liveNow.has(k);
  // A trade waits for the recap when a recap will count it (planRecap's own
  // test, a postable name included: a coin with none is said by no post, and
  // held the day's last post for eight hours, third review of the wins
  // branch), and no post and no recap has said it yet; wins included.
  const recapHasWork = recaps && (
    input.calls.some((c) => c.side === "buy" && typeof c.decisionId === "string" && c.decisionId !== "" && c.paper === (input.money === "paper")
      && inRecapWindow(c.atSec) && coinOf(c) !== null && unsaid(buyKey(c.decisionId)))
    || (input.money === "live" && input.tradeResults === true && (input.sells ?? []).some((c) => c.side === "sell"
      && /^0x[0-9a-f]{64}$/i.test(c.operationKey) && c.paper === false && inRecapWindow(c.atSec) && coinOf(c) !== null && unsaid(sellKey(tenant, c.operationKey)))));
  const roomForMore = perDay > 1 && ownerPerDay > 1;
  const keepSingles = recaps && roomForMore ? 1 : 0;
  const keepCasual = recapHasWork && roomForMore ? 1 : 0;

  // Completed sales share the account and owner caps, trade-post allowance,
  // review window, freshness and gap. A separate explicit opt-in enables them.
  // ON A RECAP CADENCE ONLY A WIN GOES OUT ALONE (the owner's ask, 2026-10-14:
  // "where are the trade pnls"): every profitable sale gets its own post with
  // its P&L card, and every other sale is the recap's to count. A win needs no
  // model (code's own words when the model cannot, sale-words.ts) and is
  // planned ahead of the buys, inside the same single horizon (review of the
  // wins branch: booked further out, a stream of wins held every slot the
  // recap could reach until the losses aged out of its window). Only where
  // the recap can count the sales: they are live money, so a recap of paper
  // trades never would, and an agent trading paper posts its live sales as
  // before. An active owner's win needs no model however it posts, and a
  // recap that counted it never stops its own post (second review: a win
  // held back for its post while a recap went out, then past the next
  // recap's window, was never said at all; a recap now counts every win, and
  // the win still goes out alone, with its card).
  const winsAlone = recaps && input.money === "live";
  const sells = input.tradeResults === true ? (input.sells ?? [])
    .filter((c) => c.side === "sell" && c.paper === false && /^0x[0-9a-f]{64}$/i.test(c.operationKey) && /^0x[0-9a-f]{40}$/i.test(c.token))
    .filter((c) => Number.isFinite(c.atSec) && c.atSec * 1000 > account.consentAtMs! && c.atSec * 1000 <= now && now - c.atSec * 1000 <= freshMs)
    .filter((c) => (winsAlone ? isWin(c) : modelOk || (cadence.recap && isWin(c))))
    .sort((a, b) => a.atSec - b.atSec) : [];
  for (const call of sells) {
    const dedupeKey = sellKey(tenant, call.operationKey);
    if (used.has(dedupeKey) || (covered.has(dedupeKey) && !(cadence.recap && isWin(call)))) continue;
    const coin = coinOf(call);
    if (!coin) continue;
    if (folded(slots, "sell", call.token.toLowerCase(), now, cadence.coinFoldMs)) continue;
    const due = pushedPast(now + MIN_LEAD_MS, slots, gap);
    // A sale no recap can count is not held to the horizon that leaves trades for one.
    if (due > call.atSec * 1000 + staleMs || (winsAlone && !soonEnough(due)) || !sendable(due)) continue;
    const day = dayOf(due);
    if (tradesOnDay(day) >= cadence.tradePerDay - keepSingles || onDay(day) >= perDay - keepSingles || ownerOnDay(day) >= ownerPerDay - keepSingles) continue;
    out.push({ kind: "sell", dedupeKey, dueAtMs: due, call, coin: coin.label, coinKey: call.token.toLowerCase() });
    slots.push({ tenant: key(tenant), kind: "sell", atMs: due, coin: call.token.toLowerCase(), createdAtMs: now });
    used.add(dedupeKey);
  }

  // BUYS: fresh, after consent, one per coin in three days (every one on an
  // active cadence), two a day at most — and none at all when the owner
  // turned them off.
  const buys = !modelOk || input.kinds?.buys === false ? [] : input.calls
    .filter((c) => c.side === "buy" && Number.isFinite(c.atSec) && typeof c.decisionId === "string" && c.decisionId !== "")
    .filter((c) => c.atSec * 1000 > account.consentAtMs! && now - c.atSec * 1000 <= freshMs && c.atSec * 1000 <= now)
    .sort((a, b) => a.atSec - b.atSec);
  for (const call of buys) {
    const dedupeKey = buyKey(call.decisionId);
    if (used.has(dedupeKey) || covered.has(dedupeKey)) continue;
    const coin = coinOf(call);
    if (!coin) continue;
    if (folded(slots, "buy", coin.key, now, cadence.coinFoldMs)) continue;
    const fillMs = call.atSec * 1000;
    const jitter = BUY_JITTER_MIN + (hash32(`buy|${call.decisionId}`) % (BUY_JITTER_MAX - BUY_JITTER_MIN + 1));
    const due = pushedPast(Math.max(fillMs + jitter * MIN, now + MIN_LEAD_MS), slots, gap);
    if (due > fillMs + staleMs || !soonEnough(due) || !sendable(due)) continue;
    const day = dayOf(due);
    if (tradesOnDay(day) >= cadence.tradePerDay - keepSingles || onDay(day) >= perDay - keepSingles || ownerOnDay(day) >= ownerPerDay - keepSingles) continue;
    out.push({ kind: "buy", dedupeKey, dueAtMs: due, call, coin: coin.label, coinKey: coin.key });
    slots.push({ tenant: key(tenant), kind: "buy", atMs: due, coin: coin.key, createdAtMs: now });
    used.add(dedupeKey);
  }

  // THE RECAP, AFTER THE SINGLE POSTS AND BEFORE A CASUAL ONE: whatever
  // trades of the window the passes before and this one could not post one
  // by one (planRecap). Ahead of the casual post (third review, 2026-10-14):
  // planned after it, a casual post took the slot and pushed the recap past
  // its limit for the pass, small talk ahead of the trades the owner asked to
  // see; a casual post pushed out finds its slot again on a later pass.
  if (recaps && (input.money === "live" || input.money === "paper")) {
    // A single post out, on its way or that may be out already said its trade.
    const liveKeys = new Set(input.posts.filter((p) => maybeOut(p)).map((p) => p.dedupeKey));
    for (const i of out) liveKeys.add(i.dedupeKey);
    const recap = planRecap({ tenant, now, consentAtMs: account.consentAtMs, covered, money: input.money, calls: input.calls,
      // SALES ONLY FROM THE RECEIPT-BACKED RESULTS, AND ONLY WITH THE OWNER'S
      // OPT-IN TO SALE POSTS (review of the recap branch, 2026-10-14): a
      // recap never says a sale the owner did not choose to have posted.
      results: input.tradeResults === true ? input.sells ?? [] : [], liveKeys, used, freshMs,
      lastRecapAtMs: ownRecaps.reduce((m, p) => Math.max(m, recapOutAt(p, now)), 0) });
    if (recap) {
      const due = pushedPast(now + MIN_LEAD_MS, slots, gap);
      const day = dayOf(due);
      if (due - now <= Math.min(RECAP_MAX_PUSH_MS, cadence.sendStaleMs - gap) && tradesOnDay(day) < cadence.tradePerDay && onDay(day) < perDay && ownerOnDay(day) < ownerPerDay) {
        out.push({ ...recap, dueAtMs: due });
        slots.push({ tenant: key(tenant), kind: "recap", atMs: due, coin: null, createdAtMs: now });
      }
    }
  }

  // CASUAL POSTS, at the account's own slots in the owner's waking window,
  // most days. STANDARD_CADENCE has one slot in the afternoon; an active
  // account has several, splitting its window evenly, one planned per pass.
  // How many went out is counted on the owner's local day as the zone reads
  // NOW, not only by key: the key carries the day under whatever zone was
  // known when it was written, so learning or changing the zone could
  // otherwise give one local day an extra post under another key.
  const today = dayOf(now);
  const minutes = clock.localMinutes(tz, now);
  const slotsToday = Math.max(1, Math.floor(cadence.casualPerDay));
  if ((modelOk || input.codeCasual === true) && !asleep && input.kinds?.casual !== false && minutes !== null) {
    const [start, end] = tz ? cadence.casualWindowLocal : cadence.casualWindowUtc;
    const quiet = hash32(`casual|${key(tenant)}|${today}`) % 10 < cadence.casualQuietDaysInTen;
    const width = Math.floor((end - start) / slotsToday);
    for (let i = 0; !quiet && i < slotsToday && width > 30; i++) {
      const cKey = casualKey(tenant, today, i);
      if (used.has(cKey) || onDay(today, "casual") > i) continue;
      // Each slot leaves half an hour of its share after it, so a pass that lands late still finds it.
      const h = hash32(i === 0 ? `casual|${key(tenant)}|${today}` : `casual|${key(tenant)}|${today}|${i}`);
      const from = start + i * width;
      const slot = from + (Math.floor(h / 10) % (width - 30));
      if (minutes < slot || minutes >= from + width) continue;
      const lead = CASUAL_LEAD_MIN + (hash32(`casual-lead|${cKey}`) % (CASUAL_LEAD_MAX - CASUAL_LEAD_MIN + 1));
      const due = pushedPast(now + lead * MIN, slots, gap);
      const day = dayOf(due);
      // ON A RECAP CADENCE, A CASUAL POST TOO GOES OUT SOON OR NOT AT ALL
      // (third review, 2026-10-14): one reserved hours ahead held the slot a
      // trade's single post needed, every pass, until the trade went stale
      // unsaid. Within the horizon, the single posts, planned first, win.
      if (due - now <= CASUAL_MAX_PUSH_MS && soonEnough(due) && onDay(day) < perDay - keepCasual && ownerOnDay(day) < ownerPerDay - keepCasual) {
        out.push({ kind: "casual", dedupeKey: cKey, dueAtMs: due, day: today, slot: i });
        slots.push({ tenant: key(tenant), kind: "casual", atMs: due, coin: null, createdAtMs: now });
      }
      break;
    }
  }
  return out.sort((a, b) => a.dueAtMs - b.dueAtMs);
}

/**
 * WHICH TRADES A RECAP SAYS, OR NONE (the owner's ask, 2026-10-14: "post one
 * recap for a burst, like 'closed 6 trades this morning'"). Every trade no
 * earlier recap covered (`covered`, by key), after consent and within
 * RECAP_WINDOW_MS, of the money it trades with now: its buys from the calls,
 * its sales from the receipt-backed results (`results`: empty without the
 * owner's opt-in to sale posts), which carry each sale's measured outcome.
 * A recap is planned only when no recap went out in RECAP_GAP_MS, and at
 * least RECAP_MIN_UNPOSTED of those trades have no single post out, on its
 * way or maybe out (`liveKeys`), the newest trade RECAP_SETTLE_MS old or
 * RECAP_FLUSH_UNPOSTED waiting; or when any trade with no single post is
 * older than `freshMs`, the freshness a single post needs. Pure.
 */
export function planRecap(o: {
  tenant: string; now: number; consentAtMs: number; covered: ReadonlySet<string>; money: "live" | "paper";
  calls: readonly PlanCall[]; results: readonly PlanSell[]; liveKeys: ReadonlySet<string>; used: ReadonlySet<string>; lastRecapAtMs: number;
  freshMs: number;
}): Omit<Extract<PlanIntent, { kind: "recap" }>, "dueAtMs"> | null {
  if (o.lastRecapAtMs > 0 && o.now - o.lastRecapAtMs < RECAP_GAP_MS) return null;
  const fromMs = Math.max(o.consentAtMs, o.now - RECAP_WINDOW_MS);
  const inWindow = (c: PlanCall) => Number.isFinite(c.atSec) && c.atSec * 1000 > fromMs && c.atSec * 1000 <= o.now && c.paper === (o.money === "paper") && coinOf(c) !== null;
  const buys = o.calls.filter((c) => c.side === "buy" && typeof c.decisionId === "string" && c.decisionId !== "" && inWindow(c) && !o.covered.has(buyKey(c.decisionId)));
  // Every sale of the window a recap has not counted, wins included: a win
  // counted here still goes out alone (planPosts), so no win waits on its own
  // post to be counted (second review of the wins branch, 2026-10-14).
  const sells = (Array.isArray(o.results) ? o.results : []).filter((c) => c.side === "sell" && /^0x[0-9a-f]{64}$/i.test(c.operationKey) && inWindow(c)
    && !o.covered.has(sellKey(o.tenant, c.operationKey)));
  const trades = [...buys.map((c) => ({ key: buyKey(c.decisionId), atSec: c.atSec })), ...sells.map((c) => ({ key: sellKey(o.tenant, c.operationKey), atSec: c.atSec }))];
  const covers = trades.map((t) => t.key);
  const unposted = trades.filter((t) => !o.liveKeys.has(t.key));
  if (!unposted.length) return null;
  const newest = Math.max(...trades.map((t) => t.atSec));
  // THE LAST POST THAT CAN SAY IT (third review, 2026-10-14): a burst's tail
  // of one or two trades, left for the recap past the single horizon, was
  // never said once the singles drained too slowly: below the minimum, no
  // recap came, and past its freshness no single could. A trade with no
  // single post past that freshness is said now, few or mid-burst alike.
  const lastChance = unposted.some((t) => o.now - t.atSec * 1000 > o.freshMs);
  if (!lastChance && unposted.length < RECAP_MIN_UNPOSTED) return null;
  if (!lastChance && o.now - newest * 1000 < RECAP_SETTLE_MS && unposted.length < RECAP_FLUSH_UNPOSTED) return null;
  const dedupeKey = recapKey(o.tenant, newest, covers);
  if (o.used.has(dedupeKey)) return null;
  return { kind: "recap", dedupeKey, buys, sells, results: sells, toSec: newest, covers };
}

// ── sending ─────────────────────────────────────────────────────────────────

export type SendDecision =
  | { action: "send" }
  | { action: "wait" }
  | { action: "skip"; reason: "stale" }
  | { action: "cancel"; reason: "account-gone" | "account-changed" | "account-off" | "kind-off" };

/**
 * MAY THIS DUE POST GO OUT NOW?
 *
 *   cancel — the account it was written for is gone, is a different X
 *            account now, or no longer posts (switched off, revoked), or
 *            the owner turned this kind of post off. The web cancels
 *            drafts on each of those already; this is the backstop for a
 *            draft planned in the same instant.
 *   skip   — a buy post still waiting eight hours after it was drafted is
 *            news nobody asked for any more; a casual post held past the
 *            owner-local day it was due on, or more than six hours past due
 *            (a fleet pause, the fleet's ceiling, the owner's night, posting
 *            switched off fleet-wide for days), is yesterday's afternoon
 *            thought and would land at an arbitrary hour. A reply waiting a
 *            day is stale, and an answer to a tag an hour after it was
 *            drafted (ANSWER_STALE_MS). The intro never goes stale: a late
 *            hello is still the right first post.
 *   wait   — the owner is asleep, or it is not due yet.
 *   send   — otherwise.
 *
 * `dayOf` is the owner's local day, from the zone the glue reads; without
 * one (the zone could not be read) only the six hours apply.
 */
export function sendDecision(
  post: Pick<XPost, "kind" | "xUserId" | "createdAtMs" | "dueAtMs">,
  account: (Pick<XAccount, "xUserId" | "posting"> & { prefs?: Pick<XPostPrefs, "buys" | "casual"> }) | null,
  nowMs: number,
  asleep: boolean,
  dayOf?: (ms: number) => string,
  /** The owner's cadence's send staleness for trade posts (PlanCadence.sendStaleMs). Absent: BUY_STALE_MS. */
  opts: { tradeStaleMs?: number } = {},
): SendDecision {
  if (!account) return { action: "cancel", reason: "account-gone" };
  if (account.xUserId !== post.xUserId) return { action: "cancel", reason: "account-changed" };
  if (!account.posting) return { action: "cancel", reason: "account-off" };
  // A recap names the coins it bought: off with its buy posts.
  if (((post.kind === "buy" || post.kind === "recap") && account.prefs?.buys === false) || (post.kind === "casual" && account.prefs?.casual === false)) {
    return { action: "cancel", reason: "kind-off" };
  }
  const tradeStale = Number.isFinite(opts.tradeStaleMs) && (opts.tradeStaleMs ?? 0) > 0 ? opts.tradeStaleMs! : BUY_STALE_MS;
  if ((post.kind === "buy" || post.kind === "sell" || post.kind === "recap") && nowMs - post.createdAtMs > tradeStale) return { action: "skip", reason: "stale" };
  if (post.kind === "reply" && nowMs - post.createdAtMs > REPLY_STALE_MS) return { action: "skip", reason: "stale" };
  if (post.kind === "answer" && nowMs - post.createdAtMs > ANSWER_STALE_MS) return { action: "skip", reason: "stale" };
  if (post.kind === "casual" && post.dueAtMs <= nowMs) {
    if (nowMs - post.dueAtMs > CASUAL_MAX_PUSH_MS) return { action: "skip", reason: "stale" };
    if (dayOf && dayOf(nowMs) !== dayOf(post.dueAtMs)) return { action: "skip", reason: "stale" };
  }
  if (asleep || post.dueAtMs > nowMs) return { action: "wait" };
  return { action: "send" };
}

/** Replies share the account's post budget and gap, with a smaller thread cap. */
export function replyDueAt(input: {
  parent: XPost;
  authorId: string;
  commentAtMs: number;
  posts: readonly XPost[];
  tenant: string;
  xUserId: string;
  nowMs: number;
  tz: string | null;
  clock: PlanClock;
  perDay: number;
  ownerPerDay?: number | null;
}): number | null {
  const { parent, nowMs: now, clock, tz, posts } = input;
  if (parent.kind !== "buy" || parent.status !== "posted" || !parent.tweetId || parent.sentAtMs === null
    || parent.tenant !== input.tenant || parent.xUserId !== input.xUserId) return null;
  if (now - parent.sentAtMs > REPLY_ROOT_MAX_AGE_MS || parent.sentAtMs > input.commentAtMs
    || input.commentAtMs > now || now - input.commentAtMs > REPLY_STALE_MS) return null;
  if (clock.isAsleep(tz, input.tenant, now)) return null;
  // Count every attempted reply, including skips and ambiguous sends. A restart
  // or model refusal cannot turn one thread into an unlimited drafting loop.
  const thread = posts.filter((p) => p.kind === "reply" && p.replyRootTweetId === parent.tweetId);
  if (thread.length >= REPLIES_PER_ROOT || thread.some((p) => p.replyAuthorId === input.authorId)) return null;
  const slots = posts.filter((p) => p.kind !== "answer" && (LIVE_STATUSES.has(p.status)
    || (p.status === "failed" && ["uncertain", "interrupted", "fault"].includes(p.reason ?? "")))).map(slotOf);
  const due = pushedPast(now + MIN_LEAD_MS, slots);
  if (due - input.commentAtMs > REPLY_STALE_MS) return null;
  const day = clock.localDay(tz, due);
  if (slots.filter((s) => clock.localDay(tz, s.atMs) === day).length >= input.perDay) return null;
  if (slots.filter((s) => s.tenant === key(input.tenant) && clock.localDay(tz, s.atMs) === day).length >= ownerLimit(input.perDay, input.ownerPerDay)) return null;
  return due;
}
