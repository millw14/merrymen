/**
 * WHAT A TAIL TELLS ITS OWNER — pure, code-written direct messages.
 *
 * An owner who tails a Fomo trader (store.ts fomo_tails) is told, in their own
 * Telegram DM, about the trader's buys, sells and theses that the shared live
 * feed recorded (the child file's tails block, contract.ts ChildTail), and once
 * when the tail ends. This module decides WHICH notices are due and WRITES
 * them; it reads nothing and sends nothing. tail-notifier.ts does the I/O.
 *
 * THE RULES, all pinned by tail-notices.test.ts:
 *
 *   coalescing    one notice per (trader, coin, kind) per 5 minutes: later
 *                 events in the window are covered by the first notice
 *   once          the durable sent log (TailSentLog) records each notice's
 *                 group, when it was told and the event time it covers from;
 *                 a group already told is never told again, across restarts
 *                 and redeploys (the notifier claims before sending), and an
 *                 entry outlives every event in the file it covers
 *   in the tail   an event whose own time is before the tail began is never
 *                 told (a late recovery of an old trade is not news of the tail)
 *   bounded       at most 30 notices per tail, 2 thesis reads per tail and 1
 *                 per (tail, coin); the end summary is said once per tail
 *   patient       a buy waits up to 3 minutes for an assessment of its coin,
 *                 so "my read" is a read, not a placeholder
 *   honest        coverage is said every time: the feed shows only larger
 *                 positions, the fleet watches it for Robinhood Chain (a
 *                 notice names each event's own chain), and no alert is not
 *                 proof they did not trade. A sell is a reason to re-check,
 *                 never an exit to copy. Their thesis is "their words,
 *                 unverified".
 *   safe text     third-party words are sanitised, clipped to 280
 *                 characters, links removed and every address shortened;
 *                 a notice that would still type an executable address
 *                 (chat.ts typesExecutable) drops the quote. Everything is
 *                 HTML-escaped; nothing here is written by a model.
 *
 * NEVER A PERMISSION. Nothing here sizes, orders, nominates or changes a
 * setting. The readiness line only REPORTS what the unchanged follow path
 * (fomo-child.ts followReadiness) would do with the trader's buy.
 */

import { createHash } from "node:crypto";
import { sanitizeText } from "../research/news";
import type { FollowReadiness, FollowBlocker } from "../fomo-child";
import { typesExecutable } from "./chat";
import type { ChildTail, ChildTailEvent } from "./contract";
import { redactExecutables } from "./dossier";
import { TAIL_COVERAGE_LINE } from "./render";
import { shortAddress } from "./identity";
import type { FollowAssessment, ResearchState, TokenIdentity } from "./types";

const MIN = 60_000;
const HOUR = 60 * MIN;

export const TAIL_NOTICE_LIMITS = Object.freeze({
  /** One notice per (trader, coin, kind) in this window. */
  coalesceMs: 5 * MIN,
  noticesPerTail: 30,
  /**
   * Notices one notifier pass sends (tail-notifier.ts): the first this many,
   * oldest first; the rest are left unclaimed for the next pass (15 s later),
   * so a burst never floods the owner's DM or holds up the notifier loop.
   */
  noticesPerPass: 4,
  /** A buy waits this long after it was observed for an assessment of its coin. */
  buyWaitsForReadMs: 3 * MIN,
  thesisReadsPerTail: 2,
  /** Reads one notifier pass may make (each up to 8 s, on the serial notifier loop). */
  thesisReadsPerPass: 2,
  /** A buy whose thesis read is still owed is sent without it after this long. */
  thesisWaitMs: 10 * MIN,
  /** Third-party words, in characters. */
  quoteChars: 280,
  /**
   * The sent log forgets an entry this long after it was TOLD (or claimed):
   * well past the child file's event window (2 h by when the fleet observed
   * an event, which is never after it was told), so nothing still in the file
   * can lose its entry by age.
   */
  logKeepMs: 8 * HOUR,
  logKeys: 200,
  /** Serialised log, in characters: inside the durable store's 15 KB wire limit with room. */
  logChars: 12_000,
});

/** The coverage floor, said with every notice: the tool answer's line (render.ts TAIL_COVERAGE_LINE), word for word. */
export const TAIL_COVERAGE = TAIL_COVERAGE_LINE;

/** Telegram callback data on a notice's buttons (handled by a later change): `ftl:stop:<userId>`, `ftl:ext:<userId>`. */
export const TAIL_CALLBACK_PREFIX = "ftl";

/**
 * THE DURABLE SENT LOG (fomo-child.ts FOMO_STATE_KEYS.tailNotified). Keys are
 * short hashes, never handles, coins or ids, so the log carries nothing a
 * reader could not already see and stays small.
 *
 *   sent      WHEN each entry was told or claimed, by the wall clock:
 *             `g:<hash>` a (trader, coin, kind) notice, `r:<hash>` a thesis
 *             read for a (tail, coin), `e:<hash>` a tail's end (per end
 *             time). The log forgets by this time and nothing else
 *   anchors   `g:<hash>` → the EVENT time the group's newest notice began at:
 *             events of the group at or before it, and up to 5 minutes after
 *             it, are covered. Kept exactly as long as its `sent` entry
 *   perTail   tail instance → notices told and thesis reads claimed
 *   floor     events OBSERVED at or before this time are never told (a log
 *             that could not be parsed restarts here: at most once, never
 *             twice; nothing observed later can have been told before it)
 *
 * WHY TWO TIMES. A provider's event time can be hours older than when the
 * fleet observed it (a recovery, a late alert), and the child file keeps an
 * event by when it was observed. A log that forgot by event time would drop
 * the entry while the event was still in the file and tell it again on every
 * pass; one that coalesced by told time would swallow new buys after a late
 * notice. v2: a v1 log (event times in `sent`) does not parse and restarts at
 * a floor of now.
 */
export interface TailSentLog {
  v: 2;
  floor: number;
  sent: Record<string, number>;
  anchors: Record<string, number>;
  perTail: Record<string, { notices: number; thesisReads: number; at: number }>;
}

export function emptyTailLog(floor = 0): TailSentLog {
  return { v: 2, floor, sent: {}, anchors: {}, perTail: {} };
}

/** A stored log, or null when it is not one (the caller then starts over at a floor of now). */
export function parseTailLog(text: string): TailSentLog | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 2 || !isTime(r.floor, true) || !isPlain(r.sent) || !isPlain(r.anchors) || !isPlain(r.perTail)) return null;
  const sent: Record<string, number> = {};
  for (const [k, v] of Object.entries(r.sent as Record<string, unknown>)) if (/^[ger]:[A-Za-z0-9_-]{1,32}$/.test(k) && isTime(v, false)) sent[k] = v as number;
  // An anchor without its told entry is dropped: it would outlive what the log forgets by.
  const anchors: Record<string, number> = {};
  for (const [k, v] of Object.entries(r.anchors as Record<string, unknown>)) if (k.startsWith("g:") && sent[k] !== undefined && isTime(v, false)) anchors[k] = v as number;
  const perTail: TailSentLog["perTail"] = {};
  for (const [k, v] of Object.entries(r.perTail as Record<string, unknown>)) {
    if (!/^t:[A-Za-z0-9_-]{1,32}$/.test(k) || !isPlain(v)) continue;
    const p = v as Record<string, unknown>;
    if (!count(p.notices) || !count(p.thesisReads) || !isTime(p.at, false)) continue;
    perTail[k] = { notices: p.notices as number, thesisReads: p.thesisReads as number, at: p.at as number };
  }
  return { v: 2, floor: r.floor as number, sent, anchors, perTail };
}

export function serializeTailLog(log: TailSentLog): string {
  return JSON.stringify(log);
}

function isPlain(v: unknown): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function isTime(v: unknown, zeroOk: boolean): boolean {
  return typeof v === "number" && Number.isSafeInteger(v) && (zeroOk ? v >= 0 : v > 0);
}
function count(v: unknown): boolean {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

const h = (s: string): string => createHash("sha256").update(s).digest("base64url").slice(0, 16);
const tailKeyOf = (t: ChildTail): string => `t:${h(`${t.userId}|${t.createdAt}`)}`;
const groupKey = (userId: string, tokenKey: string, kind: string): string => `g:${h(`${userId}|${tokenKey}|${kind}`)}`;
const readKey = (tailKey: string, tokenKey: string): string => `r:${h(`${tailKey}|${tokenKey}`)}`;
const endKey = (tailKey: string): string => `e:${h(tailKey)}`;
const coinKey = (e: ChildTailEvent): string => e.token?.key ?? "no-coin";
const NOTICE_KINDS: ReadonlySet<string> = new Set(["buy", "sell", "thesis"]);

function clone(log: TailSentLog): TailSentLog {
  return { v: 2, floor: log.floor, sent: { ...log.sent }, anchors: { ...log.anchors }, perTail: Object.fromEntries(Object.entries(log.perTail).map(([k, v]) => [k, { ...v }])) };
}

/** Record a told (trader, coin, kind) notice: when it was told, and the event time it covers from. */
function recordGroup(log: TailSentLog, group: string, eventAt: number, now: number): void {
  log.sent[group] = now;
  log.anchors[group] = Math.max(log.anchors[group] ?? 0, eventAt);
}

function forget(log: TailSentLog, key: string): void {
  delete log.sent[key];
  delete log.anchors[key];
}

/**
 * THE KEYS THE TAILS STILL IN THE FILE ARE CHECKED AGAINST: every group,
 * read and end key their events and ends could look up. The key and size
 * bounds forget other entries first, so a busy log cannot drop the entry of
 * an event it may see again (only a log made of nothing else could).
 */
function neededKeys(tails: readonly ChildTail[]): Set<string> {
  const out = new Set<string>();
  for (const t of tails) {
    const tk = tailKeyOf(t);
    if (t.ended) out.add(endKey(tk));
    for (const e of t.events) {
      if (!NOTICE_KINDS.has(e.kind)) continue;
      out.add(groupKey(t.userId, coinKey(e), e.kind));
      if (e.token) out.add(readKey(tk, e.token.key));
    }
  }
  return out;
}

/** Sent keys, the oldest told first, those the file no longer needs before those it does. */
function forgettable(log: TailSentLog, needed: ReadonlySet<string>): string[] {
  return Object.entries(log.sent)
    .sort((a, b) => Number(needed.has(a[0])) - Number(needed.has(b[0])) || a[1] - b[1])
    .map(([k]) => k);
}

/**
 * Entries told more than 8 h ago go (an event in the file was observed, so
 * told, within its last ~2 h); past the key bound the oldest go, those the
 * file no longer needs first; tails no longer listed and old go. Never grows
 * without bound.
 */
function pruned(log: TailSentLog, now: number, tails: readonly ChildTail[]): TailSentLog {
  const out = clone(log);
  const live = new Set(tails.map(tailKeyOf));
  const needed = neededKeys(tails);
  const horizon = now - TAIL_NOTICE_LIMITS.logKeepMs;
  for (const [k, at] of Object.entries(out.sent)) if (at < horizon && !needed.has(k)) forget(out, k);
  const order = forgettable(out, needed);
  while (order.length > TAIL_NOTICE_LIMITS.logKeys) forget(out, order.shift()!);
  for (const k of Object.keys(out.anchors)) if (out.sent[k] === undefined) delete out.anchors[k];
  for (const [k, p] of Object.entries(out.perTail)) if (!live.has(k) && p.at < horizon) delete out.perTail[k];
  return out;
}

/** Keep a serialised log inside its size bound by forgetting sent entries, the file's unneeded and oldest first (never the floor). */
function fitted(log: TailSentLog, tails: readonly ChildTail[]): TailSentLog {
  if (serializeTailLog(log).length <= TAIL_NOTICE_LIMITS.logChars) return log;
  const out = clone(log);
  const order = forgettable(out, neededKeys(tails));
  while (serializeTailLog(out).length > TAIL_NOTICE_LIMITS.logChars && order.length > 0) forget(out, order.shift()!);
  return out;
}

// ── inputs and outputs ──────────────────────────────────────────────────────

export interface TailNoticeInput {
  tails: readonly ChildTail[];
  log: TailSentLog;
  now: number;
  /** What following would do with a buy right now (fomo-child.ts followReadiness); null when unknown. */
  readiness: FollowReadiness | null;
  /** The child's latest assessment of a coin (by token key), or null. */
  assessmentOf(tokenKey: string): FollowAssessment | null;
  /** Whether the owner holds the coin now. Unknown is "no". */
  holds?(tokenKey: string): boolean;
  /**
   * What a thesis read found for (trader, coin): their newest excerpt, null
   * (read, nothing there), "failed" (the read did not answer), or undefined
   * (not read in this process).
   */
  thesisRead(userId: string, tokenKey: string): string | null | "failed" | undefined;
  /** False when no read can be made at all (no broker): thesis lines say so instead of waiting. */
  canRead?: boolean;
}

/** One thesis read the notifier should make: `fomo_get_token_theses {token, chain, trader, limit: 3}`. */
export interface TailThesisRead {
  userId: string;
  tokenKey: string;
  token: TokenIdentity;
}

export interface TailNoticeButton {
  text: string;
  /** `ftl:stop:<userId>` or `ftl:ext:<userId>`, at most 64 bytes. */
  data: string;
}

export interface TailNotice {
  /** The log entry this notice is recorded under (a short hash). */
  key: string;
  tailUserId: string;
  kind: "buy" | "sell" | "thesis" | "end";
  /** Telegram HTML, code-written and escaped; send with link previews off. */
  html: string;
  /** Stop and +1h for a running tail; none for an end summary. */
  buttons: TailNoticeButton[];
  /** The sent log with this notice (and every one before it) recorded: what the notifier claims before sending it. */
  logAfter: TailSentLog;
}

// ── the plan ────────────────────────────────────────────────────────────────

interface Due {
  tail: ChildTail;
  tailKey: string;
  ev: ChildTailEvent;
  group: string;
  /** Events this notice covers (same trader, coin and kind, inside the coalescing window). */
  covered: ChildTailEvent[];
}

/**
 * An event a tail can tell: a buy, sell or thesis observed after the log's
 * floor, whose own time is not before the tail began. A trade from before the
 * tail (a late recovery of an old alert) was not made while it was tailed: it
 * is never told, and never a trigger (orchestrator-fomo.ts drops it too).
 */
function tellable(tail: ChildTail, e: ChildTailEvent, floor: number): boolean {
  return NOTICE_KINDS.has(e.kind) && e.observedAt > floor && e.at >= tail.createdAt;
}

/**
 * Walk every tail's events oldest first, as the notices would be told, and
 * call `visit` for each one that is due (not told, not covered, tellable,
 * under the per-tail cap). `visit` returns whether it told it, so the walk
 * can record coverage (told now, from the event's time) and the cap as it goes.
 */
function walk(log: TailSentLog, tails: readonly ChildTail[], now: number, visit: (d: Due) => boolean): void {
  for (const tail of tails) {
    const tailKey = tailKeyOf(tail);
    const events = tail.events
      .filter((e) => tellable(tail, e, log.floor))
      .sort((a, b) => a.at - b.at || (a.eventKey < b.eventKey ? -1 : a.eventKey > b.eventKey ? 1 : 0));
    for (const ev of events) {
      const pt = log.perTail[tailKey];
      if (pt && pt.notices >= TAIL_NOTICE_LIMITS.noticesPerTail) break;
      const group = groupKey(tail.userId, coinKey(ev), ev.kind);
      const anchor = log.anchors[group];
      if (anchor !== undefined && ev.at <= anchor + TAIL_NOTICE_LIMITS.coalesceMs) continue;
      const covered = events.filter((x) => x.kind === ev.kind && coinKey(x) === coinKey(ev) && x.at >= ev.at && x.at <= ev.at + TAIL_NOTICE_LIMITS.coalesceMs);
      if (visit({ tail, tailKey, ev, group, covered })) recordGroup(log, group, ev.at, now);
    }
  }
}

/** The newest stream thesis with words, by this trader on this coin, in the tail's events. */
function streamThesis(tail: ChildTail, ev: ChildTailEvent): ChildTailEvent | null {
  let best: ChildTailEvent | null = null;
  for (const x of tail.events) {
    if (x.kind !== "thesis" || !x.text || coinKey(x) !== coinKey(ev)) continue;
    if (!best || x.at > best.at) best = x;
  }
  return best;
}

function perTail(log: TailSentLog, tailKey: string, now: number): { notices: number; thesisReads: number; at: number } {
  const p = (log.perTail[tailKey] ??= { notices: 0, thesisReads: 0, at: now });
  p.at = now;
  return p;
}

/**
 * THE READS A PASS SHOULD MAKE, and the log with them claimed. Only for a buy
 * that is due, whose coin has no thesis of theirs in the stream, that this
 * process has not read yet, under 1 per (tail, coin), 2 per tail and 2 per
 * pass, and only on a chain the theses route can be asked about without a
 * search. The notifier writes the returned log durably BEFORE reading, so a
 * crash can never re-spend a read.
 */
export function tailThesisReads(i: TailNoticeInput): { reads: TailThesisRead[]; log: TailSentLog } {
  const log = fitted(pruned(i.log, i.now, i.tails), i.tails);
  const scratch = clone(log);
  const reads: TailThesisRead[] = [];
  if (i.canRead === false) return { reads, log };
  walk(scratch, i.tails, i.now, (d) => {
    if (d.ev.kind !== "buy" || !d.ev.token || !d.ev.token.chain.slug) return true;
    if (streamThesis(d.tail, d.ev)) return true;
    const tokenKey = d.ev.token.key;
    if (i.thesisRead(d.tail.userId, tokenKey) !== undefined) return true;
    const rk = readKey(d.tailKey, tokenKey);
    const p = perTail(log, d.tailKey, i.now);
    if (log.sent[rk] !== undefined || p.thesisReads >= TAIL_NOTICE_LIMITS.thesisReadsPerTail || reads.length >= TAIL_NOTICE_LIMITS.thesisReadsPerPass) return true;
    log.sent[rk] = i.now;
    p.thesisReads++;
    reads.push({ userId: d.tail.userId, tokenKey, token: d.ev.token });
    return true;
  });
  return { reads, log: fitted(log, i.tails) };
}

/**
 * THE NOTICES DUE NOW, oldest first, each carrying the log to claim before it
 * is sent. A buy still waiting (for its assessment, up to 3 minutes; for an
 * owed thesis read, up to 10) is left for a later pass and recorded nowhere.
 */
export function tailNotices(i: TailNoticeInput): { notices: TailNotice[]; log: TailSentLog } {
  const log = fitted(pruned(i.log, i.now, i.tails), i.tails);
  const notices: TailNotice[] = [];
  const push = (n: Omit<TailNotice, "logAfter">): void => {
    notices.push({ ...n, logAfter: fitted(clone(log), i.tails) });
  };
  walk(log, i.tails, i.now, (d) => {
    const p = perTail(log, d.tailKey, i.now);
    const text = noticeFor(i, d, log);
    if (text === null) {
      // Still waiting: nothing recorded, so the next pass sees it again.
      if (p.notices === 0 && p.thesisReads === 0) delete log.perTail[d.tailKey];
      return false;
    }
    p.notices++;
    // Recorded before the snapshot below: the claim of this notice covers it.
    recordGroup(log, d.group, d.ev.at, i.now);
    if (text.coveredThesis) recordGroup(log, groupKey(d.tail.userId, coinKey(text.coveredThesis), "thesis"), text.coveredThesis.at, i.now);
    push({ key: d.group, tailUserId: d.tail.userId, kind: d.ev.kind as TailNotice["kind"], html: text.html, buttons: buttonsFor(d.tail, i.now) });
    return true;
  });
  for (const tail of i.tails) {
    if (!tail.ended) continue;
    const tailKey = tailKeyOf(tail);
    const ek = endKey(tailKey);
    if (log.sent[ek] !== undefined) continue;
    log.sent[ek] = i.now;
    push({ key: ek, tailUserId: tail.userId, kind: "end", html: endSummary(tail), buttons: [] });
  }
  return { notices, log };
}

// ── words ───────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** "14:05 UTC". */
function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

function who(tail: ChildTail): string {
  return tail.handle && /^[A-Za-z0-9_]{1,30}$/.test(tail.handle) ? tail.handle : "the trader you're tailing";
}

/** A coin by its ticker, or its address SHORTENED (never a full address). */
function coinName(ev: ChildTailEvent): string {
  const s = (sanitizeText(ev.label.symbol ?? "", 24).replace(/^\$/, "").match(/[A-Za-z0-9_-]+/g) ?? []).join("");
  if (s) return s.slice(0, 20);
  if (ev.token) return shortAddress(ev.token.address);
  return "a coin";
}

function chainWords(ev: ChildTailEvent): string {
  const slug = ev.token?.chain.slug;
  return slug === "robinhood" ? "Robinhood Chain" : slug ? sanitizeText(slug, 24) : "an unnamed chain";
}

function shortUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return `$${Math.round(n)}`;
}

/**
 * THEIR WORDS, MADE SAFE TO SHOW: sanitised, every address shortened (never
 * typed out in full), links and @mentions removed, clipped to 280 characters.
 * Null when nothing is left, or when it would still type something executable.
 */
export function theirWords(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let t = sanitizeText(raw, 2_000);
  t = t
    .replace(/0x[0-9a-fA-F]{40,64}/g, (m) => shortAddress(m))
    .replace(/\b[0-9a-fA-F]{64}\b/g, (m) => shortAddress(m))
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,}\b/g, (m) => shortAddress(m));
  t = redactExecutables(t).replace(/\[link\]/g, "").replace(/\s+/g, " ").trim();
  t = t.replace(/["“”]/g, "'").replace(/`/g, "'");
  if (t.length > TAIL_NOTICE_LIMITS.quoteChars) t = `${t.slice(0, TAIL_NOTICE_LIMITS.quoteChars - 1).trimEnd()}…`;
  if (!t || typesExecutable(t)) return null;
  return t;
}

/** Plain words for a follow blocker: a closed map, nothing else is ever said. */
export const BLOCKER_WORDS: Readonly<Record<FollowBlocker, string>> = {
  "follow-off": "following is off",
  "not-fast-trencher": "you're not on the fast Trencher strategy",
  "scout-off": "your scout budget is off or 0",
  paused: "entries are paused",
  "live-not-allowed": "live follow isn't enabled for this agent",
  "rail-refused": "trading is held right now",
  "no-vault": "your agent has no Trencher vault, which every follow entry needs",
};

/** Reason codes an owner is told about, in words: a closed map; other codes are not said. */
export const REASON_WORDS: Readonly<Record<string, string>> = {
  "price-move-unknown": "the price moved before I could quote it",
  "quote-missing": "I have no price for it yet",
  "stale-quote": "my price for it is stale",
  "dossier-stale": "my research on it is stale",
  "dossier-missing": "I have no research on it yet",
  "route-too-thin": "it's too thin to trade",
  "route-unverified": "its route isn't verified yet",
  "route-depth-unknown": "I can't see its depth yet",
  "ran-past-limit": "it already ran too far",
  "setup-expired": "the setup is too old",
  "verified-objection": "there's a verified objection to it",
  "thin-thesis": "the case for it is thin",
  "cohort-flow-mixed": "tracked traders are selling it too",
  "conflicting-opinions": "opinions on it conflict",
  "words-vs-actions": "someone's words and trades disagree on it",
  "awaiting-cohort-buyer": "no other tracked trader is buying it",
  "awaiting-second-buyer": "I'm waiting for a second buyer",
  "below-economic-floor": "the size would be too small to be worth it",
  "entries-paused": "entries are paused",
  "follow-disabled": "following is off",
  "live-follow-not-allowed": "live follow isn't enabled",
  "rail-refused": "trading is held",
  "permission-missing": "my vault doesn't cover it",
};

const STATE_WORDS: Readonly<Record<ResearchState, string>> = {
  WATCH: "watching, not entering yet",
  PROBE_CANDIDATE: "worth a small look; it goes to my normal review",
  ENTRY_CANDIDATE: "a candidate; it goes to my normal review",
  ADD_CANDIDATE: "we hold it; adding would go to my normal review",
  HOLD_POSITION: "we hold it, and I'm holding",
  REDUCE_CANDIDATE: "we hold it; my own review is looking at trimming",
  EXIT_CANDIDATE: "we hold it; my own review is looking at exiting",
  REJECT_SETUP: "not for us",
  RESEARCH_ONLY: "research only",
};

function myRead(a: FollowAssessment | null): string {
  if (!a) return "My read: I haven't assessed this coin yet.";
  const base = STATE_WORDS[a.state] ?? "no read yet";
  const reason = a.state === "PROBE_CANDIDATE" || a.state === "ENTRY_CANDIDATE" ? undefined : a.reasonCodes.map((c) => REASON_WORDS[c]).find(Boolean);
  return `My read: ${base}${reason ? ` (${reason})` : ""}.`;
}

function readinessLine(tail: ChildTail, r: FollowReadiness | null): string {
  if (!tail.consider) return "You asked me to tell you only; I won't trade on it.";
  if (!r) return "You asked me to consider their buys, but I can't tell right now whether following can act, so this only informs you.";
  if (r.mode !== "off" && r.blockers.length === 0) {
    return "Their buy is one signal into my normal review; I only enter if my own checks and the Brain agree, inside your scout budget.";
  }
  const words = [...new Set(r.blockers.map((b) => BLOCKER_WORDS[b]).filter(Boolean))];
  return `You asked me to consider their buys, but following can't act right now (${words.join("; ") || "following is off"}), so this only informs you.`;
}

function buttonsFor(tail: ChildTail, now: number): TailNoticeButton[] {
  if (tail.ended || tail.expiresAt <= now) return [];
  const stop = `${TAIL_CALLBACK_PREFIX}:stop:${tail.userId}`;
  const ext = `${TAIL_CALLBACK_PREFIX}:ext:${tail.userId}`;
  // Telegram's callback data is at most 64 bytes; a user id too long for it gets no buttons rather than a cut one.
  if (Buffer.byteLength(stop, "utf8") > 64 || !/^[A-Za-z0-9_-]+$/.test(tail.userId)) return [];
  return [
    { text: "Stop tail", data: stop },
    { text: "+1h", data: ext },
  ];
}

/** Why a buy's notice goes without a thesis read: a closed set, each said as it is. */
export type NoReadReason = "no-reader" | "no-chain" | "tail-reads-spent" | "too-late";

export const NO_READ_WORDS: Readonly<Record<NoReadReason, string>> = {
  "no-reader": "I can't look theses up right now",
  "no-chain": "this alert doesn't say which chain the coin is on",
  "tail-reads-spent": "I read at most two per tail",
  "too-late": "I couldn't get to it in time",
};

/**
 * Why no read is coming for this buy, or null while one is owed (and the
 * notice should wait for it). In this order, so the line names the reason
 * that actually applies: no broker at all, a coin whose chain the theses
 * route cannot be asked about, the tail's two reads spent, or the wait for a
 * read (10 minutes, or the tail's end) ran out first.
 */
function whyNoRead(i: TailNoticeInput, d: Due, log: TailSentLog, age: number): NoReadReason | null {
  if (i.canRead === false) return "no-reader";
  if (!d.ev.token?.chain.slug) return "no-chain";
  if ((log.perTail[d.tailKey]?.thesisReads ?? 0) >= TAIL_NOTICE_LIMITS.thesisReadsPerTail) return "tail-reads-spent";
  if (age >= TAIL_NOTICE_LIMITS.thesisWaitMs || d.tail.ended) return "too-late";
  return null;
}

interface Written {
  html: string;
  /** A stream thesis this notice quoted: its own thesis notice is then covered too. */
  coveredThesis?: ChildTailEvent;
}

/** The notice for one due event, or null while it should wait. */
function noticeFor(i: TailNoticeInput, d: Due, log: TailSentLog): Written | null {
  const { tail, ev } = d;
  const name = esc(who(tail));
  const coin = esc(coinName(ev));
  const at = clock(ev.at);
  const tailEnds = tail.ended ? `Tail ended ${clock(tail.expiresAt)}.` : `Tail ends ${clock(tail.expiresAt)}.`;
  const more = d.covered.length > 1 ? ` (${d.covered.length} ${ev.kind === "thesis" ? "posts" : ev.kind === "buy" ? "buys" : "sells"} in 5 min)` : "";

  if (ev.kind === "sell") {
    const held = !!ev.token && i.holds?.(ev.token.key) === true;
    return {
      html: [
        `👀 <b>${name}</b> sold <b>${coin}</b> on Fomo (${esc(chainWords(ev))}) · ${at}${more}`,
        `A seller is a reason for me to re-check, never an exit to copy.${held ? " We hold it; my own review decides." : ""}`,
        esc(TAIL_COVERAGE),
        tailEnds,
      ].join("\n"),
    };
  }

  if (ev.kind === "thesis") {
    const words = theirWords(ev.text);
    return {
      html: [
        `👀 <b>${name}</b> posted a thesis on <b>${coin}</b> on Fomo · ${at}${more}`,
        words ? `Their words, unverified: “${esc(words)}”` : "Their thesis had no words I can show.",
        myRead(ev.token ? i.assessmentOf(ev.token.key) : null),
        readinessLine(tail, i.readiness),
        esc(TAIL_COVERAGE),
        tailEnds,
      ].join("\n"),
    };
  }

  // A buy: wait (briefly) for my read of the coin, and for their thesis.
  const tokenKey = ev.token?.key ?? null;
  const assessment = tokenKey ? i.assessmentOf(tokenKey) : null;
  const age = i.now - ev.observedAt;
  if (!(assessment && assessment.createdAt >= ev.observedAt) && age < TAIL_NOTICE_LIMITS.buyWaitsForReadMs && !tail.ended) return null;
  let thesisLine: string;
  let coveredThesis: ChildTailEvent | undefined;
  const stream = streamThesis(tail, ev);
  const streamWords = stream ? theirWords(stream.text) : null;
  if (stream && streamWords) {
    thesisLine = `Their thesis (their words, unverified): “${esc(streamWords)}”`;
    coveredThesis = stream;
  } else {
    const r = tokenKey ? i.thesisRead(tail.userId, tokenKey) : undefined;
    const claimed = tokenKey ? log.sent[readKey(d.tailKey, tokenKey)] !== undefined : false;
    if (typeof r === "string" && r !== "failed") {
      const w = theirWords(r);
      thesisLine = w ? `Their thesis (their words, unverified): “${esc(w)}”` : "Their thesis had no words I can show.";
    } else if (r === null) {
      thesisLine = "No thesis from them on this coin that I could find.";
    } else if (r === "failed") {
      thesisLine = "I couldn't read their theses just now.";
    } else if (claimed) {
      // Claimed in an earlier process whose answer is gone: never read twice.
      thesisLine = "I couldn't read their theses just now.";
    } else {
      const why = whyNoRead(i, d, log, age);
      if (why === null) return null; // a read is owed (tailThesisReads claims it); wait for it
      thesisLine = `I didn't look up their thesis on this coin (${NO_READ_WORDS[why]}).`;
    }
  }
  const position = typeof ev.positionValueUsd === "number" && ev.positionValueUsd > 0 ? `Their position after it: about ${shortUsd(ev.positionValueUsd)} (their whole position, not this buy).` : null;
  return {
    html: [
      `👀 <b>${name}</b> bought <b>${coin}</b> on Fomo (${esc(chainWords(ev))}) · ${at}${more}`,
      ...(position ? [position] : []),
      thesisLine,
      myRead(assessment),
      readinessLine(tail, i.readiness),
      esc(TAIL_COVERAGE),
      tailEnds,
    ].join("\n"),
    coveredThesis,
  };
}

function endSummary(tail: ChildTail): string {
  const name = esc(who(tail));
  const t = tail.totals;
  const counts = t
    ? `The feed showed ${t.buys} ${t.buys === 1 ? "buy" : "buys"}, ${t.sells} ${t.sells === 1 ? "sell" : "sells"} and ${t.theses} ${t.theses === 1 ? "thesis" : "theses"} across ${t.coins} ${t.coins === 1 ? "coin" : "coins"}${t.capped ? " (at least: I counted the first 500)" : ""}.`
    : "I couldn't count what the feed showed for it.";
  return [`Tail on <b>${name}</b> ended at ${clock(tail.expiresAt)}.`, counts, "Anything I entered came as a normal trade receipt.", esc(TAIL_COVERAGE)].join("\n");
}
