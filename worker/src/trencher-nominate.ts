/**
 * NOMINATED COINS — the one thing a Telegram group may hand to trading.
 *
 * The contract is docs/tg-groups.md ("The coin flow", "Trencher readiness",
 * "Nomination caps"). A group message can nominate a coin, never order a
 * trade: what crosses is a validated `0x` + 40-hex address plus where it came
 * from, and this module is where that crossing is counted and bounded. The
 * Brain still decides, the existing trencher entry path still sizes, and
 * checkPolicy and the TrencherVault still bound it. Nothing here can make an
 * entry happen; it can only refuse one (claimEntry) or give a coin a place in
 * the review rotation (priority).
 *
 * PURE, ON PURPOSE. No I/O, no clock of its own, no trading imports. index.ts
 * owns the book and feeds it what the trading side saw (a review, a fill, an
 * exit); the durable day counters come in through `NominationCounters`, which
 * the tg-groups store implements. Keeping the book in memory is deliberate: a
 * restart forgets pending nominations, and the chat side's durable claim
 * (at-most-once per posted CA) means a forgotten nomination is dropped, never
 * replayed into a second look or a second buy.
 *
 * NAMING: the web room's name never appears in code here (see
 * worker/src/groupchat/boundary.test.ts). This is "Telegram groups".
 */
import type {
  CoinOutcome,
  NominateRefusal,
  NominateResult,
  Nomination,
  TrencherReadiness,
  TrencherReadinessKind,
} from "./telegram/tg-groups/types";

/**
 * The caps, all EXTRA caps on top of every existing limit — none of them can
 * raise anything the vault, the signed wall, energy or the breaker allow.
 */
export const NOMINATE = {
  /** A nomination with no outcome by now is reported `expired`. */
  ttlMs: 15 * 60_000,
  /**
   * How much longer than the TTL a nomination whose claimed entry is still in
   * flight waits for that entry's fill. A hard bound, counted from the
   * nomination, so an entry that never answers cannot hold its slot forever.
   */
  entryInFlightGraceMs: 10 * 60_000,
  /** Unresolved nominations the book holds at once, the one under review included. */
  queueMax: 5,
  perChatHour: 4,
  perSenderHour: 2,
  /** Per agent per UTC day, counted durably by the store. */
  perDay: 12,
  /** The same address is not looked at again this soon after a verdict. */
  reNominateMs: 6 * 3_600_000,
  /** Group-sourced ENTRIES per agent per UTC day (claim before, refund on no fill). */
  groupEntriesPerDay: 3,
  /** A post older than this (Telegram `date`) is recorded but never nominated. */
  staleMessageMs: 10 * 60_000,
  /** How long a bought-from-a-group coin may still get one "out of that one" line. */
  boughtMemoryMs: 7 * 86_400_000,
} as const;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const ZERO_ADDRESS = "0x" + "0".repeat(40);

/** A contract address as the chain spells one. Nothing looser: no 64-hex, no padding. */
export function isCaAddress(s: string): boolean {
  return typeof s === "string" && /^0x[0-9a-f]{40}$/i.test(s);
}

// ─── Readiness ──────────────────────────────────────────────────────────────

export interface ReadinessInput {
  strategy: string;
  assetMode: string;
  trencherFastEnabled: boolean;
  brainUrl?: string | null;
  brainToken?: string | null;
  paper: boolean;
  /** `grantTrencher(grant) !== null` — the grant carries the Autonomous Trencher permission. */
  hasTrencherGrant: boolean;
  trencherLiveEnabled: boolean;
}

/**
 * THE OWNER'S DM SENTENCES, one per row, each naming its fix.
 *
 * Plain words and no figures: this goes to the owner's DM (never a group), and
 * the fix is always a Settings act, because real-money switches are
 * dashboard-only. A reason that named a number would be a number the owner
 * could not act on from here anyway.
 */
const OWNER_REASON: Record<TrencherReadinessKind, string> = {
  "off": "I'm not in Trencher mode, so I can't look at coins from your groups: open Settings and press Prepare Trencher mode.",
  "stocks-only": "I'm set to trade stocks only, so I can't look at coins from your groups: switch what I trade to crypto in Settings.",
  "slow": "Fast Trencher is off, and it's the Brain-reviewed path that looks at coins from your groups: turn on fast Trencher exits in Settings.",
  "no-brain": "Trencher needs Brain connected: add your Brain URL and token in Settings.",
  "no-vault": "Trencher can't look at coins without the Autonomous Trencher permission, on paper or for real: update your trading permission from Settings and select Autonomous Trencher.",
  "live-off": "Trencher isn't allowed to trade for real yet: turn on let trencher trade for real in Settings.",
  "ready-paper": "Trencher mode is ready, and coins from your groups are traded on paper.",
  "ready-live": "Trencher mode is ready, and coins from your groups can be traded for real.",
};

const present = (s: string | null | undefined) => typeof s === "string" && s.trim().length > 0;

/**
 * THE FIRST FAILING ROW WINS, in the table's order.
 *
 * The order is the order an owner fixes things in: there is no point asking
 * for a vault permission for a strategy that is not trencher. `slow` sits
 * above the Brain rows because the fast path is the only one that reviews a
 * nominated coin; without it the legacy discovery path trades on rules alone
 * and a nomination would have nothing to wait for. Paper needs the vault
 * permission too: trencher discovery — the only thing that turns a posted
 * address into a coin the Brain can review — runs only for a grant that
 * carries it (index.ts refreshAutoTrench), so a paper agent without it would
 * be told "ready" and every nomination would quietly expire. Paper does not
 * need the live switch: nothing it does reaches the chain.
 */
export function trencherReadiness(i: ReadinessInput): TrencherReadiness {
  const kind = ((): TrencherReadinessKind => {
    if (i.strategy !== "trencher") return "off";
    if (i.assetMode === "stocks") return "stocks-only";
    if (i.trencherFastEnabled !== true) return "slow";
    if (!present(i.brainUrl) || !present(i.brainToken)) return "no-brain";
    // Anything but an explicit `true` is live: paper is the claim that must be
    // proven, because a live agent read as paper would skip the live rows.
    if (i.hasTrencherGrant !== true) return "no-vault";
    if (i.paper === true) return "ready-paper";
    if (i.trencherLiveEnabled !== true) return "live-off";
    return "ready-live";
  })();
  return { kind, ownerReason: OWNER_REASON[kind] };
}

const READY: ReadonlySet<TrencherReadinessKind> = new Set(["ready-paper", "ready-live"]);

// ─── Notes: the Brain's words, reduced to ideas that carry no figure ────────

/**
 * A LINK IS MASKED BEFORE ANYTHING IS SPLIT. The clause breaks include `/`,
 * and a URL is made of slashes: split first and "x.com" or "robinhood" would
 * come out as clean-looking clauses of their own. So every link-shaped run is
 * replaced by a sentinel the clause filter always drops, and the clause that
 * carried it goes with it. Bare domains (pump.fun, t.me/x) count as links; the
 * price of that is the odd "node.js" dropped, which is the right side to err on.
 */
const LINKY = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*|\b(?:[a-z0-9-]+\.)+[a-z]{2,24}(?:\/\S*)?/gi;
const MASK = "\u0000";

/** Sentence ends, `;`, `/`, dashes used as breaks, and line breaks. */
const CLAUSE_BREAK = /(?<=[.!?…])\s+|[;/—–|\r\n]+|\s+-\s+/;

/**
 * SPELLED-OUT QUANTITIES ARE STILL QUANTITIES — the same list social-post.ts's
 * admitPost refuses, plus multipliers. "One" is left off for the reason given
 * there: as a pronoun ("this one") it is everywhere and carries no figure.
 */
const QUANTITY_WORDS =
  /\b(?:zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|dozens?|hundreds?|thousands?|millions?|billions?|trillions?|percent|percentage|per cent|bps|basis points?|half|halved?|halving|doubled?|doubling|tripled?|tripling|quadrupled?|(?:two|three|four|five|ten|hundred|thousand|many)fold)\b/i;

/**
 * Trading's own vocabulary that happens to start with a number word. "Two-sided
 * flow" is the persona's phrase for real buying and selling, not a figure, and
 * dropping it would drop the very clause a buy line is grounded in. Named one
 * by one: a general hyphen exemption would let "hundred-dollar" through.
 */
const NOT_A_QUANTITY = /\b(?:one|two)-(?:sided|way)\b/gi;

/**
 * What drops a clause whole. The contract names digits, `$`, `%`, `0x` hex,
 * base58 runs, links and handles; the rest here are the same things in other
 * spellings (any script's numerals, any currency sign, a full-width percent,
 * an email, a hashtag, an `rh:` instrument id, a quantity in words).
 */
const FORBIDDEN: readonly RegExp[] = [
  new RegExp(MASK),
  /\p{N}/u,
  /[\p{Sc}%‰‱٪﹪％]/u,
  /0x[0-9a-f]/i,
  /[1-9A-HJ-NP-Za-km-z]{26,}/,
  /[@＠]/,
  /#\w/,
  /\brh:/i,
];

const forbidden = (clause: string) =>
  FORBIDDEN.some((re) => re.test(clause)) || QUANTITY_WORDS.test(clause.replace(NOT_A_QUANTITY, " "));

/**
 * BRAIN TEXT, REDUCED TO NOTES THE GROUP WRITER MAY THINK WITH.
 *
 * Split into clauses; a clause carrying anything figure- or address-shaped is
 * DROPPED, never repaired — cutting "5%" out of "down 5% today" leaves "down
 * today", which is a different claim. Survivors are trimmed, deduplicated
 * (case-insensitive, first spelling kept), kept in order, and the list stops
 * at the first clause that would take the total past `maxChars` (counted as
 * if joined by single spaces). Nothing is clipped mid-clause.
 *
 * Invisible format characters are removed first: a zero-width space inside a
 * mint would otherwise break it into two runs too short to catch.
 */
export function safeNotes(texts: ReadonlyArray<string | null | undefined>, maxChars = 400): string[] {
  const out: string[] = [];
  if (!Array.isArray(texts) || !Number.isFinite(maxChars) || maxChars <= 0) return out;
  const seen = new Set<string>();
  let used = 0;
  for (const text of texts) {
    if (typeof text !== "string" || text.length === 0) continue;
    const cleaned = text
      .replace(/\p{Cf}/gu, "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
      .replace(LINKY, MASK);
    for (const raw of cleaned.split(CLAUSE_BREAK)) {
      const clause = raw
        .replace(/\s+/g, " ")
        .replace(/^[\s\-*•·,:]+/, "")
        .replace(/[\s.,:!?…]+$/, "")
        .trim();
      if (!clause || !/\p{L}/u.test(clause)) continue;
      if (forbidden(clause)) continue;
      const key = clause.toLowerCase();
      if (seen.has(key)) continue;
      const cost = clause.length + (out.length ? 1 : 0);
      if (used + cost > maxChars) return out;
      seen.add(key);
      out.push(clause);
      used += cost;
    }
  }
  return out;
}

// ─── The book ───────────────────────────────────────────────────────────────

/**
 * The durable day counters, implemented by the tg-groups store over
 * `TgGroupsState.nominations`. Each take is a claim: it returns false at the
 * limit and writes before it returns true. A take that throws is read as a
 * refusal here — new work fails closed.
 */
export interface NominationCounters {
  takeNomination(day: string, limit: number): boolean;
  takeGroupEntry(day: string, limit: number): boolean;
  /** Give back one entry claimed on `day`. A day that is no longer current should give back nothing. */
  refundGroupEntry(day: string): void;
}

/**
 * What `claimEntry` answers. Only `taken` wrote a claim, and only a `taken`
 * may later be refunded.
 */
export type EntryClaim = "taken" | "cap" | "not-nominated";

/** What index.ts saw a Brain review decide about a nominated coin's token. */
export interface ReviewedDecision {
  action: "buy" | "sell" | "hold";
  decisionId: string;
  holdKind?: string | null;
  thesis?: string | null;
  bullCase?: string | null;
  bearCase?: string | null;
  risks?: ReadonlyArray<string> | null;
}

/**
 * Holds that are not market views: a shut portfolio gate, or a stale price.
 * thesis-policy.ts keeps both private, and the group must not hear them voiced
 * as a take — they are reported as `skipped`.
 */
const NOT_A_VIEW: ReadonlySet<string> = new Set(["GATE_FORCED_HOLD", "STALE_MARK_HOLD"]);

/** `submitted` is the one trade status that is not an answer yet. */
const IN_FLIGHT: ReadonlySet<string> = new Set(["submitted"]);

interface Pending {
  n: Nomination;
  queuedAtMs: number;
  /** Set once the Brain answered BUY: the review is done and a fill is awaited. */
  awaitingFill: boolean;
  /**
   * When a group-entry claim was `taken` for THIS nomination, until its
   * refund. Money may be on its way into the coin, so neither the TTL nor a
   * reset may end the nomination before the fill says how it went, up to
   * `entryInFlightGraceMs` past the TTL (see `sweep`; past the TTL it can
   * start nothing new, see `open`). Kept on the nomination, not read off
   * `claims`: an older unspent claim for the same address belongs to an
   * earlier nomination and must not keep a new one alive.
   */
  entryInFlightAtMs?: number;
}

interface BuyReview {
  pending: Pending;
  thesis: string | null;
  bullCase: string | null;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const lower = (a: unknown) => (typeof a === "string" ? a.toLowerCase() : "");
const refuse = (reason: NominateRefusal): NominateResult => ({ ok: false, reason });
const validId = (id: unknown): id is string => typeof id === "string" && id.trim().length > 0;

/**
 * THE NOMINATIONS ONE AGENT IS HOLDING, and every cap on them.
 *
 * One review runs at a time; every nomination still waiting for one is in the
 * priority hint, in queue order, and a held position's overdue review still
 * wins (`chooseFocus` is unchanged). Outcomes are keyed by ADDRESS for
 * reviews and by DECISION ID for fills — never by "the latest decision" —
 * because the review rotation may well have picked a different coin in
 * between.
 *
 * Every nomination gets exactly one outcome: a review, a fill, the TTL or a
 * reset resolves it and removes it, and nothing after that can speak for it
 * again. Expired nominations found by any call are parked in an outbox that
 * `expire()` drains, so a sweep inside some other call never loses one.
 */
export class NominationBook {
  private queue: Pending[] = [];
  private outbox: CoinOutcome[] = [];
  private chatWindow = new Map<number, number[]>();
  private senderWindow = new Map<number, number[]>();
  /** Address → when its last verdict (bought / passed / skipped) was given. */
  private verdictAt = new Map<string, number>();
  /** Address → the nomination a group-sourced buy came from, for one exit line. */
  private bought = new Map<string, { chatId: number; messageId: number; atMs: number }>();
  /** Brain decision id → the nomination it answered with BUY. */
  private buys = new Map<string, BuyReview>();
  /** Address → group-entry claims not yet spent or refunded, newest last. */
  private claims = new Map<string, { day: string; atMs: number }[]>();

  constructor(
    private readonly counters: NominationCounters,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * THE ORDER OF THE REFUSALS IS THE ORDER OF THEIR COST.
   *
   * Everything that can be decided from what the book already holds is
   * decided before the durable daily counter is touched, so a refusal never
   * spends a day's nomination — including `busy`, which is checked before the
   * counter although it is reported after it in the contract. Rolling windows
   * count only nominations that were accepted: a refused spammer is answered
   * with silence, and does not lock the chat out for the next hour.
   *
   * A full queue refuses the newcomer rather than dropping the oldest: a burst
   * of CAs cannot flush a coin someone else posted first.
   *
   * A replay of the same post is refused: while it is pending, or within
   * `reNominateMs` of its verdict, as `recent`; after that its message is long
   * past `staleMessageMs`, so as `invalid`. It never consumes a counter.
   */
  nominate(n: Nomination, readiness: TrencherReadinessKind): NominateResult {
    const address = lower(n?.address);
    if (
      !isCaAddress(address) || address === ZERO_ADDRESS ||
      !Number.isSafeInteger(n.chatId) || !Number.isSafeInteger(n.messageId) ||
      !Number.isSafeInteger(n.senderId) || !Number.isFinite(n.atMs)
    ) return refuse("invalid");
    if (!READY.has(readiness)) return refuse("not-ready");
    const t = this.now();
    if (!Number.isFinite(t)) return refuse("invalid");
    // Future-dated by more than the stale window is not a clock worth trusting either.
    if (t - n.atMs > NOMINATE.staleMessageMs || n.atMs - t > NOMINATE.staleMessageMs) return refuse("invalid");
    this.sweep(t);
    if (this.find(address) || this.recentVerdict(address, t)) return refuse("recent");
    if (inWindow(this.chatWindow, n.chatId) >= NOMINATE.perChatHour) return refuse("chat-rate");
    if (inWindow(this.senderWindow, n.senderId) >= NOMINATE.perSenderHour) return refuse("sender-rate");
    if (this.queue.length >= NOMINATE.queueMax) return refuse("busy");
    let took = false;
    try {
      took = this.counters.takeNomination(utcDay(t), NOMINATE.perDay) === true;
    } catch {
      took = false;
    }
    if (!took) return refuse("daily");
    this.queue.push({
      n: { address, chatId: n.chatId, messageId: n.messageId, senderId: n.senderId, atMs: n.atMs },
      queuedAtMs: t,
      awaitingFill: false,
    });
    push(this.chatWindow, n.chatId, t);
    push(this.senderWindow, n.senderId, t);
    return { ok: true };
  }

  /** The nomination under review: the oldest one still waiting for its review. */
  active(): Nomination | null {
    const t = this.now();
    this.sweep(t);
    const p = this.queue.find((q) => this.waiting(q, t));
    return p ? { ...p.n } : null;
  }

  /**
   * EVERY NOMINATION STILL WAITING FOR ITS REVIEW (lowercased addresses), in
   * queue order, for the review rotation. Not just the oldest: the chat-side
   * look does not pre-screen depth, flow or discovery's verification, so the
   * head of the queue may be a coin the tick never finds eligible, and a hint
   * naming only it would leave every coin queued behind it competing with the
   * whole tape until its TTL ran out. The reviewer (trencher-brain.ts
   * `candidate`) takes the first of these that is eligible, and spaces them so
   * nominations hold at most every other review slot; held positions' overdue
   * reviews keep priority over all of them in `chooseFocus`.
   */
  priority(): ReadonlySet<string> {
    const t = this.now();
    this.sweep(t);
    return new Set(
      this.queue.filter((q) => this.waiting(q, t)).slice(0, NOMINATE.queueMax).map((q) => q.n.address),
    );
  }

  /**
   * The unresolved nomination for this address (waiting or awaiting its
   * fill) that is still inside its TTL, if any. One kept past the TTL only for
   * its in-flight entry's fill is not it: see `open`.
   */
  nominated(address: string): Nomination | null {
    const t = this.now();
    this.sweep(t);
    const p = this.open(lower(address), t);
    return p ? { ...p.n } : null;
  }

  /**
   * A BRAIN REVIEW OF A NOMINATED COIN'S TOKEN.
   *
   * BUY says nothing yet: a buy is only said once a fill lands, so the
   * decision id is remembered for `onFill` and the TTL keeps running (until
   * an entry is claimed for it: see `claimEntry`). Once a
   * BUY is recorded, a later HOLD or SELL for the same coin is ignored — a
   * trade for the first decision may be in flight, and "passed" followed by a
   * fill would be a lie told first. A later BUY adds its id, so whichever
   * decision the entry path takes can still be matched.
   *
   * A BUY without a decision id can never be taken (the review's take()
   * refuses one), so it is `skipped` rather than left to occupy the slot.
   */
  onReviewed(address: string, d: ReviewedDecision): CoinOutcome | null {
    const t = this.now();
    this.sweep(t);
    const p = this.open(lower(address), t);
    if (!p || !d) return null;
    const where = { address: p.n.address, chatId: p.n.chatId, messageId: p.n.messageId };
    if (d.action === "buy") {
      if (!validId(d.decisionId)) {
        return p.awaitingFill ? null : this.resolve(p, { kind: "skipped", ...where }, t);
      }
      p.awaitingFill = true;
      this.buys.set(d.decisionId, { pending: p, thesis: d.thesis ?? null, bullCase: d.bullCase ?? null });
      return null;
    }
    if (p.awaitingFill) return null;
    if (d.action !== "hold" && d.action !== "sell") return null;
    const decisionId = validId(d.decisionId) ? d.decisionId : undefined;
    if (d.action === "hold" && typeof d.holdKind === "string" && NOT_A_VIEW.has(d.holdKind)) {
      return this.resolve(p, decisionId ? { kind: "skipped", ...where, decisionId } : { kind: "skipped", ...where }, t);
    }
    let notes = safeNotes([d.bearCase, ...(Array.isArray(d.risks) ? d.risks : [])]);
    if (notes.length === 0) notes = safeNotes([d.thesis]);
    return this.resolve(p, { kind: "passed", ...where, decisionId: decisionId ?? "", notes }, t);
  }

  /**
   * A TRADE RESULT FOR A BRAIN DECISION ID.
   *
   * `landed` and `paper` are the only fills (social-post.ts's postableStatus
   * makes the same cut). `submitted` is not an answer yet. Anything else —
   * reverted, rejected, dropped, or a word this module has never seen — is
   * `skipped`: the chat hears "gonna sit this one out", never the reason.
   *
   * Paper is said if EITHER the status or the caller says paper: telling a
   * group a practice fill was real is the mistake that must not happen.
   */
  onFill(decisionId: string, status: string, paper: boolean): CoinOutcome | null {
    const t = this.now();
    this.sweep(t);
    if (!validId(decisionId)) return null;
    const b = this.buys.get(decisionId);
    if (!b || !this.queue.includes(b.pending)) return null;
    if (IN_FLIGHT.has(status)) return null;
    const p = b.pending;
    const where = { address: p.n.address, chatId: p.n.chatId, messageId: p.n.messageId };
    if (status === "landed" || status === "paper") {
      this.bought.set(p.n.address, { chatId: p.n.chatId, messageId: p.n.messageId, atMs: t });
      // The claim for this entry is spent: a refund arriving after a fill must
      // not hand the day's group-entry slot back.
      this.spendClaim(p.n.address);
      return this.resolve(p, {
        kind: "bought", ...where, paper: status === "paper" || paper === true, decisionId,
        notes: safeNotes([b.thesis, b.bullCase]),
      }, t);
    }
    return this.resolve(p, { kind: "skipped", ...where, decisionId }, t);
  }

  /**
   * CLAIM A GROUP-SOURCED ENTRY, before the entry path starts one for a
   * nominated coin. Claim first, refund on no fill (`refundEntry`), the
   * energy-entry pattern: a crash in between under-spends by one, never
   * over-spends.
   *
   * Three answers, because "nothing was taken" is not one thing:
   *   - `taken`: a claim was written, and it is the one a no-fill refund gives back;
   *   - `cap`: the day's group entries are used up (or the counter could not answer);
   *   - `not-nominated`: this address has no unresolved nomination NOW — never
   *     nominated, or its TTL ran out since the caller last looked. Nothing is
   *     taken. It is kept apart from `taken` on purpose: read as a claim, the
   *     entry would go uncounted, and its no-fill refund would pop an OLDER
   *     entry's claim for the same coin (one that may have become a trade)
   *     and hand that slot back.
   *
   * A `taken` marks the nomination as having an entry in flight, so the TTL
   * cannot end it between the claim and the fill (`sweep`): a buy that lands
   * a moment past the TTL is still told as a buy, not as "sat this one out".
   * That grace is for the entry already claimed, never for a new one: past
   * its TTL the nomination answers `not-nominated` here like an expired one.
   */
  claimEntry(address: string): EntryClaim {
    const t = this.now();
    this.sweep(t);
    const a = lower(address);
    const p = this.open(a, t);
    if (!p) return "not-nominated";
    let day = "";
    let ok = false;
    try {
      day = utcDay(t);
      ok = this.counters.takeGroupEntry(day, NOMINATE.groupEntriesPerDay) === true;
    } catch {
      ok = false;
    }
    if (!ok) return "cap";
    push(this.claims, a, { day, atMs: t });
    p.entryInFlightAtMs = t;
    return "taken";
  }

  /**
   * Give back a group-entry claim whose entry produced no fill. It returns to
   * the day it was taken from; an address with no outstanding claim gives
   * back nothing, so a stray refund can never create an entry.
   *
   * Only after a `taken`: claims are a stack per address, newest last, so the
   * claim popped here is the one this entry's own claimEntry pushed. After a
   * `cap` or `not-nominated` there is no claim of this entry's to give back,
   * and the one on top would belong to a different entry.
   *
   * No fill is coming, so the nomination's entry is no longer in flight: the
   * TTL applies to it again from here.
   */
  refundEntry(address: string): void {
    const a = lower(address);
    const p = this.find(a);
    if (p) p.entryInFlightAtMs = undefined;
    const c = this.spendClaim(a);
    if (!c) return;
    try {
      this.counters.refundGroupEntry(c.day);
    } catch {
      // A refund that did not write under-spends by one; that is the safe side.
    }
  }

  /** The TTL sweep: every nomination past its TTL, plus any a previous call already found. */
  expire(): CoinOutcome[] {
    this.sweep(this.now());
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  /**
   * AN EXIT OF A COIN BOUGHT THROUGH A NOMINATION — at most one line, ever.
   *
   * Only for a buy this book reported within `boughtMemoryMs`. The memory is
   * consumed by the first call whether or not it was still in time, so a
   * second exit (a re-entry sold later) never speaks for the old post.
   */
  onExit(address: string, notes?: string[]): CoinOutcome | null {
    const t = this.now();
    this.sweep(t);
    const a = lower(address);
    const b = this.bought.get(a);
    if (!b) return null;
    this.bought.delete(a);
    if (t - b.atMs >= NOMINATE.boughtMemoryMs) return null;
    return { kind: "exited", address: a, chatId: b.chatId, messageId: b.messageId, notes: safeNotes(notes ?? []) };
  }

  /**
   * A CONTEXT CHANGE (paper/live flip, new grant, new Brain): the review state
   * that would have answered these is gone (TrenchBrainReview.reset), so every
   * pending nomination is `expired` now rather than left to time out in
   * silence.
   *
   * The caps are NOT reset: rolling windows, the re-nominate memory and
   * outstanding entry claims all survive, so flipping a setting never hands
   * out fresh allowance.
   *
   * A nomination whose claimed entry is in flight is the exception: its
   * order was already taken, so the reset review state is not what answers
   * it — the entry's trade row is. It stays for that fill, under the same hard
   * bound as the TTL gives it.
   */
  reset(): CoinOutcome[] {
    const t = this.now();
    this.sweep(t);
    for (const p of [...this.queue]) {
      if (p.entryInFlightAtMs !== undefined) continue;
      this.outbox.push({ kind: "expired", address: p.n.address, chatId: p.n.chatId, messageId: p.n.messageId });
      this.retire(p);
    }
    return this.expire();
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private find(address: string): Pending | undefined {
    return address ? this.queue.find((p) => p.n.address === address) : undefined;
  }

  /**
   * The nomination for this address while it is inside its TTL: the one a
   * review may answer and an entry may be claimed against. Past the TTL a
   * nomination still held for its in-flight entry is only waiting for that
   * fill; it can start nothing new.
   */
  private open(address: string, t: number): Pending | undefined {
    const p = this.find(address);
    return p && t - p.queuedAtMs < NOMINATE.ttlMs ? p : undefined;
  }

  /** Still waiting for its review: not answered BUY, and inside its TTL. */
  private waiting(p: Pending, t: number): boolean {
    return !p.awaitingFill && t - p.queuedAtMs < NOMINATE.ttlMs;
  }

  private recentVerdict(address: string, t: number): boolean {
    const at = this.verdictAt.get(address);
    return at !== undefined && t - at < NOMINATE.reNominateMs;
  }

  /** Remove a nomination and every decision id that pointed at it. */
  private retire(p: Pending): void {
    this.queue = this.queue.filter((q) => q !== p);
    for (const [id, b] of this.buys) if (b.pending === p) this.buys.delete(id);
  }

  /** Remove it with its outcome; a reviewed outcome starts the re-nominate clock. */
  private resolve(p: Pending, o: CoinOutcome, t: number): CoinOutcome {
    this.retire(p);
    if (o.kind !== "expired") this.verdictAt.set(p.n.address, t);
    return o;
  }

  private spendClaim(address: string): { day: string; atMs: number } | undefined {
    const list = this.claims.get(address);
    const c = list?.pop();
    if (list && list.length === 0) this.claims.delete(address);
    return c;
  }

  /**
   * Move every nomination past its TTL to the outbox, and forget whatever has
   * aged out of every window. Called at the top of every public method with
   * that call's one reading of the clock.
   *
   * A nomination whose claimed entry is still in flight is not ended by the
   * TTL: the fill that follows (landed, paper, or a final status) resolves it,
   * and ending it first would tell the group "sat this one out" about a coin
   * it had just bought and forget the buy. `entryInFlightGraceMs` past the TTL
   * it expires anyway, so an entry that never answers cannot hold its slot.
   */
  private sweep(t: number): void {
    for (const p of [...this.queue]) {
      const age = t - p.queuedAtMs;
      if (age < NOMINATE.ttlMs) continue;
      if (p.entryInFlightAtMs !== undefined && age < NOMINATE.ttlMs + NOMINATE.entryInFlightGraceMs) continue;
      this.outbox.push({ kind: "expired", address: p.n.address, chatId: p.n.chatId, messageId: p.n.messageId });
      this.retire(p);
    }
    pruneWindow(this.chatWindow, t);
    pruneWindow(this.senderWindow, t);
    for (const [a, at] of this.verdictAt) if (t - at >= NOMINATE.reNominateMs) this.verdictAt.delete(a);
    for (const [a, b] of this.bought) if (t - b.atMs >= NOMINATE.boughtMemoryMs) this.bought.delete(a);
    // No entry takes a day to resolve; a claim older than that can no longer
    // be refunded into a counter that has since moved on.
    for (const [a, list] of this.claims) {
      const kept = list.filter((c) => t - c.atMs < DAY_MS);
      if (kept.length) this.claims.set(a, kept);
      else this.claims.delete(a);
    }
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/** Entries still inside the rolling hour. Callers sweep first, so this is a length. */
function inWindow(m: Map<number, number[]>, k: number): number {
  return m.get(k)?.length ?? 0;
}

/** A rolling hour: a stamp exactly an hour old has left the window. */
function pruneWindow(m: Map<number, number[]>, t: number): void {
  for (const [k, list] of m) {
    const kept = list.filter((at) => t - at < HOUR_MS);
    if (kept.length) m.set(k, kept);
    else m.delete(k);
  }
}
