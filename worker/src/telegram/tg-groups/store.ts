/**
 * Telegram groups — the durable per-agent store, `<MERRYMEN_HOME>/tg-groups.json`.
 * Contract: docs/tg-groups.md, "Memory" and "Storage and the ferry".
 *
 * ONE FILE, ONE WRITER. The child that polls Telegram is the only process that
 * writes this file; hosted, the orchestrator only ever READS it (the ferry
 * seals it into Postgres) and restores it before spawn. So there is no lock:
 * the in-memory state is the truth and the file is its durable copy.
 *
 * WHAT IS WRITTEN WHEN. Chat memory (lines, people, summaries, counters) is
 * debounced: losing the last two seconds of a chat's lines to a crash costs
 * nothing anyone would notice, and writing a few hundred KB per message would.
 * Things that decide whether money moves are written synchronously, before the
 * caller acts on them:
 *
 *   - `claim` (the at-most-once key for a posted coin). A claim that is only in
 *     memory is no claim at all after a crash: the redelivered update would find
 *     nothing and nominate the same coin again. AGENTS.md: "financial operations
 *     must not become replayable after a crash".
 *   - `takeNomination` / `takeGroupEntry`: the per-agent daily caps on group
 *     nominations and group-sourced entries. A cap that is consumed in memory and
 *     lost to a crash is a cap that hands out a fresh allowance on restart.
 *   - `setStatus` / `migrate`: whether a room is allowed to hear the agent at all.
 *   - `forgetChat` / `forgetPerson`: the agent says "done 🫡", so it must be done.
 *   - `recordForget`: the request itself, in its own file, so it reaches the
 *     memory even when this store is not holding it (TG_GROUPS_FORGET_FILE).
 *
 * When a synchronous write FAILS, the operation that needed it refuses (a claim
 * returns false, a cap take returns false): saying nothing about a coin is the
 * safe direction, acting on it twice is not.
 *
 * NEVER THROWS INTO CALLERS for I/O. A failed write is logged once, without any
 * content, and retried on the next change. Reads tolerate anything: a malformed
 * field drops that field or record, never the file; a file that is not JSON at
 * all is moved aside to `tg-groups.json.bad` so nothing is silently overwritten.
 *
 * NAMING: never write the web room's name (group + chat, joined or separated)
 * in code here. See types.ts.
 */

import {
  closeSync,
  constants as fsc,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import type {
  CoinVerdict,
  TgCoinMemo,
  TgGroupsState,
  TgLine,
  TgPerson,
  TgRoom,
  TgRoomStatus,
} from "./types";

export const TG_GROUPS_FILE = "tg-groups.json";

const DAY_MS = 24 * 60 * 60 * 1000;

export const TG_LIMITS = {
  chats: 30,
  lines: 60,
  lineChars: 400,
  people: 40,
  noteChars: 160,
  coins: 60,
  summaryChars: 900,
  nameChars: 40,
  lineMaxAgeMs: 14 * DAY_MS,
  coinMaxAgeMs: 14 * DAY_MS,
  leftKeepMs: 30 * DAY_MS,
  claimMaxAgeMs: 2 * DAY_MS,
  fileBytes: 512 * 1024,
} as const;

/** Telegram's own maximum for a chat title; the DM to the owner quotes it. */
const TITLE_CHARS = 128;
/** "group" | "supergroup" — anything longer is not a chat type. */
const KIND_CHARS = 20;
/** Brain decision ids are short; this only stops a malformed file carrying a novel. */
const DECISION_ID_CHARS = 128;

/**
 * CLAIMS PER ROOM, and how old a claim must be before pressure may drop it.
 *
 * Claims are the one thing in this file a busy chat can grow without bound:
 * every posted address is claimed before anything else happens, and the
 * nomination caps only apply after. Two days of a spammy chat is thousands of
 * them, which alone would blow the 512 KB bound. So a room holds at most 200.
 *
 * Under that pressure only claims older than an hour may go. The coin flow
 * never nominates a message older than 10 minutes (Telegram `date`), and a
 * claim is stamped no earlier than the message it claims, so a replay of
 * anything whose claim is over an hour old is already refused by age. A room
 * with 200 claims inside the last hour refuses new ones instead: the coin is
 * ignored, which is the direction at-most-once allows.
 */
const CLAIMS_PER_ROOM = 200;
const CLAIM_PRESSURE_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * A file bigger than this is not ours: the size bound keeps a healthy one
 * under 512 KB. Reading and parsing something enormous would only risk the
 * process, so it is moved aside like any other corrupt file.
 */
const MAX_READ_BYTES = 16 * 1024 * 1024;

const ROOM_STATUSES: readonly TgRoomStatus[] = ["approved", "pending", "left", "blocked"];

const VERDICTS: ReadonlySet<CoinVerdict> = new Set<CoinVerdict>([
  "bought",
  "passed",
  "skipped",
  "expired",
  "not-ready",
  "coins-off",
  "own",
  "cash",
  "energy",
  "stock",
  "wallet",
  "not-token",
  "curve",
  "v4-only",
  "no-pool",
  "too-new",
  "too-thin",
  "too-quiet",
  "held",
  "candidate",
  "unknown",
]);

const ADDRESS = /^0x[0-9a-f]{40}$/;
/**
 * Hex long enough to be (part of) an address. Checked on the name as given,
 * before clipping — a clipped address is still an address to a reader.
 */
const HEX_RUN = /0x[0-9a-f]{8,}/i;
const CLAIM_KEY = /^-?\d+:0x[0-9a-f]{40}$/;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}$/;

// ─── Small pure helpers ────────────────────────────────────────────────────

/** Outside Date's range `toISOString` throws; such a clock reads as the epoch instead. */
const isoOf = (ms: number): string =>
  new Date(Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? ms : 0).toISOString();

/** UTC day key, YYYY-MM-DD. */
export function utcDay(ms: number): string {
  return isoOf(ms).slice(0, 10);
}

/** UTC hour key, YYYY-MM-DDTHH. */
export function utcHour(ms: number): string {
  return isoOf(ms).slice(0, 13);
}

export function emptyTgGroupsState(): TgGroupsState {
  return {
    version: 1,
    rooms: {},
    llm: { day: "", used: 0 },
    nominations: { day: "", n: 0, entries: 0 },
  };
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Clip to `max` UTF-16 units without splitting a surrogate pair: a lone half
 * would be written to disk as U+FFFD and read back as a different string.
 */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/** A one-line label (a name, a title): no control characters, no line breaks. */
function label(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return clip(v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim(), max);
}

/** Free text (a line, a note, a summary): keeps newlines and tabs, drops other control characters. */
function prose(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return clip(v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""), max);
}

/**
 * A daily/hourly counter read from disk.
 *
 * A count that cannot be read, under a key that can, is treated as USED UP for
 * that key rather than as zero. These counters are allowances (model calls,
 * nominations, group-sourced entries); inventing a fresh allowance out of a
 * damaged number is the wrong direction for a cap. The key rolls over at the
 * next day or hour and the counter starts clean.
 */
function readCount(v: unknown): number {
  if (isNum(v) && v >= 0) return Math.min(Math.ceil(v), Number.MAX_SAFE_INTEGER);
  return Number.MAX_SAFE_INTEGER;
}

function parseWindow(v: unknown): { count: number; sinceMs: number } | undefined {
  if (!isObj(v) || !isNum(v.count) || v.count < 0 || !isNum(v.sinceMs)) return undefined;
  return { count: Math.ceil(v.count), sinceMs: v.sinceMs };
}

function parseDayCount(v: unknown): { day: string; n: number } | undefined {
  if (!isObj(v) || typeof v.day !== "string" || !DAY_KEY.test(v.day)) return undefined;
  return { day: v.day, n: isNum(v.n) && v.n >= 0 ? v.n : Number.MAX_SAFE_INTEGER };
}

function parseLine(v: unknown): TgLine | null {
  if (!isObj(v)) return null;
  if (!isInt(v.messageId) || !isInt(v.fromId) || !isNum(v.atMs) || typeof v.text !== "string") return null;
  const line: TgLine = {
    messageId: v.messageId,
    fromId: v.fromId,
    name: label(v.name, TG_LIMITS.nameChars),
    text: prose(v.text, TG_LIMITS.lineChars),
    atMs: v.atMs,
  };
  if (isInt(v.replyTo)) line.replyTo = v.replyTo;
  if (v.own === true) line.own = true;
  return line;
}

function parsePerson(v: unknown): TgPerson | null {
  if (!isObj(v) || !isInt(v.id)) return null;
  const p: TgPerson = {
    id: v.id,
    name: label(v.name, TG_LIMITS.nameChars),
    note: prose(v.note, TG_LIMITS.noteChars),
    lastSeenMs: isNum(v.lastSeenMs) ? v.lastSeenMs : 0,
  };
  const roasts = parseWindow(v.roasts);
  if (roasts) p.roasts = roasts;
  const answers = parseWindow(v.answers);
  if (answers) p.answers = answers;
  if (typeof v.greetedDay === "string" && DAY_KEY.test(v.greetedDay)) p.greetedDay = v.greetedDay;
  return p;
}

function parseCoin(v: unknown): TgCoinMemo | null {
  if (!isObj(v) || typeof v.address !== "string") return null;
  const address = v.address.toLowerCase();
  if (!ADDRESS.test(address)) return null;
  if (!isInt(v.byId) || !isInt(v.messageId) || !isNum(v.atMs)) return null;
  if (typeof v.verdict !== "string" || !VERDICTS.has(v.verdict as CoinVerdict)) return null;
  const memo: TgCoinMemo = {
    address,
    byId: v.byId,
    byName: label(v.byName, TG_LIMITS.nameChars),
    messageId: v.messageId,
    atMs: v.atMs,
    verdict: v.verdict as CoinVerdict,
  };
  // A display name is never address-shaped (types.ts); one that is would put
  // an address back into a line the writer might repeat.
  const name = label(v.name, TG_LIMITS.nameChars);
  if (name && typeof v.name === "string" && !HEX_RUN.test(v.name)) memo.name = name;
  const decisionId = label(v.decisionId, DECISION_ID_CHARS);
  if (decisionId) memo.decisionId = decisionId;
  if (v.paper === true) memo.paper = true;
  if (v.exitSaid === true) memo.exitSaid = true;
  return memo;
}

/** Newest `max` by `at`, in ascending order, stable for ties. */
function keepNewest<T>(items: T[], max: number, at: (x: T) => number): T[] {
  const sorted = items
    .map((x, i) => ({ x, i }))
    .sort((a, b) => at(a.x) - at(b.x) || a.i - b.i)
    .map((e) => e.x);
  return sorted.length > max ? sorted.slice(sorted.length - max) : sorted;
}

function dedupeLines(lines: TgLine[]): TgLine[] {
  // The later copy of a message id wins: it is the one written most recently.
  const byId = new Map<number, TgLine>();
  for (const l of lines) {
    byId.delete(l.messageId);
    byId.set(l.messageId, l);
  }
  return [...byId.values()];
}

function capLines(lines: TgLine[]): TgLine[] {
  return keepNewest(dedupeLines(lines), TG_LIMITS.lines, (l) => l.atMs);
}

function capPeople(people: TgPerson[]): TgPerson[] {
  const byId = new Map<number, TgPerson>();
  for (const p of people) {
    const prev = byId.get(p.id);
    if (!prev || p.lastSeenMs >= prev.lastSeenMs) byId.set(p.id, p);
  }
  return keepNewest([...byId.values()], TG_LIMITS.people, (p) => p.lastSeenMs);
}

function capCoins(coins: TgCoinMemo[]): TgCoinMemo[] {
  const byAddr = new Map<string, TgCoinMemo>();
  for (const c of coins) {
    const prev = byAddr.get(c.address);
    if (!prev || c.atMs >= prev.atMs) byAddr.set(c.address, c);
  }
  return keepNewest([...byAddr.values()], TG_LIMITS.coins, (c) => c.atMs);
}

/** Both chats knew the person: keep the newer record, and the other's note if the newer has none. */
function mergePeople(a: TgPerson[], b: TgPerson[]): TgPerson[] {
  const notes = new Map<number, string>();
  for (const p of [...a, ...b]) if (p.note && !notes.has(p.id)) notes.set(p.id, p.note);
  return capPeople([...a, ...b]).map((p) => (p.note ? p : { ...p, note: notes.get(p.id) ?? "" }));
}

function parseClaims(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObj(v)) return out;
  for (const [k, at] of Object.entries(v)) {
    const key = k.toLowerCase();
    if (CLAIM_KEY.test(key) && isNum(at)) out[key] = at;
  }
  return out;
}

function parseRoom(v: unknown, keyHint: string): TgRoom | null {
  if (!isObj(v)) return null;
  let chatId: number | null = isInt(v.chatId) ? v.chatId : null;
  if (chatId === null && /^-?\d+$/.test(keyHint) && Number.isSafeInteger(Number(keyHint))) chatId = Number(keyHint);
  if (chatId === null) return null;

  const room: TgRoom = {
    chatId,
    title: label(v.title, TITLE_CHARS),
    // An unreadable status reads as "pending": the one status in which the
    // agent says nothing in the room, so a damaged file can only make it quieter.
    status: ROOM_STATUSES.includes(v.status as TgRoomStatus) ? (v.status as TgRoomStatus) : "pending",
    kind: label(v.kind, KIND_CHARS) || "group",
    statusAtMs: isNum(v.statusAtMs) ? v.statusAtMs : 0,
    lines: capLines((Array.isArray(v.lines) ? v.lines : []).map(parseLine).filter((l): l is TgLine => l !== null)),
    sinceSummary: isNum(v.sinceSummary) && v.sinceSummary >= 0 ? Math.floor(v.sinceSummary) : 0,
    summary: prose(v.summary, TG_LIMITS.summaryChars),
    people: capPeople((Array.isArray(v.people) ? v.people : []).map(parsePerson).filter((p): p is TgPerson => p !== null)),
    coins: capCoins((Array.isArray(v.coins) ? v.coins : []).map(parseCoin).filter((c): c is TgCoinMemo => c !== null)),
    claims: parseClaims(v.claims),
  };
  if (v.isForum === true) room.isForum = true;
  if (isInt(v.addedById)) room.addedById = v.addedById;
  if (v.privacyHintSent === true) room.privacyHintSent = true;
  if (v.helloSaid === true) room.helloSaid = true;
  const ownerName = label(v.ownerName, TG_LIMITS.nameChars);
  if (ownerName) room.ownerName = ownerName;
  for (const k of [
    "addedAtMs",
    "askedOwnerAtMs",
    "shushedUntilMs",
    "lastOwnAtMs",
    "lastAmbientAtMs",
    "lastReadyAskAtMs",
    "lastReadyNudgeAtMs",
    "lastReadyDmAtMs",
    "lastCapLineAtMs",
    "lastDropCaAtMs",
    "lastCoinUnknownAtMs",
    "lastSummaryAtMs",
  ] as const) {
    const t = v[k];
    if (isNum(t)) room[k] = t;
  }
  const ambient = parseDayCount(v.ambient);
  if (ambient) room.ambient = ambient;
  const welcomes = parseDayCount(v.welcomes);
  if (welcomes) room.welcomes = welcomes;
  if (isObj(v.llmHour) && typeof v.llmHour.hour === "string" && HOUR_KEY.test(v.llmHour.hour)) {
    room.llmHour = { hour: v.llmHour.hour, n: readCount(v.llmHour.n) };
  }
  return room;
}

/** The newest moment anything happened in a room — the eviction order. */
function lastActivity(r: TgRoom): number {
  let t = r.statusAtMs;
  for (const x of [r.addedAtMs, r.lastOwnAtMs, r.lastAmbientAtMs]) if (x !== undefined && x > t) t = x;
  for (const l of r.lines) if (l.atMs > t) t = l.atMs;
  for (const c of r.coins) if (c.atMs > t) t = c.atMs;
  for (const at of Object.values(r.claims)) if (at > t) t = at;
  return t;
}

/**
 * Which rooms go first when there are too many. Left rooms first: the agent
 * is not in them. Then pending ones, which nobody has decided about. Blocked
 * and approved rooms are the OWNER'S DECISIONS (a Leave that must keep undoing
 * a stranger's re-add, a Stay with its memory), so they go last, blocked
 * before approved. Anyone can add a bot to a group; thirty strangers' groups
 * must not be able to push the owner's own groups out.
 */
const EVICT_TIER: Record<TgRoomStatus, number> = { left: 0, pending: 1, blocked: 2, approved: 3 };

/** A room nobody has decided to keep: the only kind a stranger's new room may push out. */
const undecided = (r: TgRoom): boolean => r.status === "left" || r.status === "pending";

/**
 * Room keys in the order they are evicted (see EVICT_TIER), and within a
 * tier: left and blocked rooms longest gone first, the rest quietest for
 * longest first.
 */
function evictionOrder(rooms: Record<string, TgRoom>): string[] {
  const entries = Object.entries(rooms).map(([key, r]) => ({
    key,
    tier: EVICT_TIER[r.status] ?? EVICT_TIER.pending,
    at: r.status === "left" || r.status === "blocked" ? r.statusAtMs : lastActivity(r),
  }));
  entries.sort((a, b) => a.tier - b.tier || a.at - b.at || Number(a.key) - Number(b.key));
  return entries.map((e) => e.key);
}

/**
 * Evict until at most `max` rooms remain, only rooms `may` allows. False, with
 * nothing evicted, when that is not enough to get under `max`.
 */
function capRooms(rooms: Record<string, TgRoom>, max: number, may: (r: TgRoom) => boolean = () => true): boolean {
  const over = Object.keys(rooms).length - max;
  if (over <= 0) return true;
  const keys = evictionOrder(rooms).filter((k) => may(rooms[k]!));
  if (keys.length < over) return false;
  for (const key of keys.slice(0, over)) delete rooms[key];
  return true;
}

/**
 * Read a TgGroupsState out of anything. NEVER THROWS.
 *
 * Field by field: a malformed room, line, person or coin is dropped on its
 * own; a malformed optional field is dropped from its record; every string is
 * clipped to its limit and every list to its cap. An unknown `version` is a
 * file this build does not understand, and reads as empty rather than as a
 * guess.
 */
export function parseTgGroupsState(raw: unknown): TgGroupsState {
  const state = emptyTgGroupsState();
  try {
    if (!isObj(raw) || raw.version !== 1) return state;
    if (isObj(raw.rooms)) {
      for (const [k, v] of Object.entries(raw.rooms)) {
        const room = parseRoom(v, k);
        if (!room) continue;
        const key = String(room.chatId);
        // Two entries for one chat: keep the one that saw activity last.
        const prev = state.rooms[key];
        if (!prev || lastActivity(room) >= lastActivity(prev)) state.rooms[key] = room;
      }
      capRooms(state.rooms, TG_LIMITS.chats);
    }
    if (isObj(raw.llm) && typeof raw.llm.day === "string" && DAY_KEY.test(raw.llm.day)) {
      state.llm = { day: raw.llm.day, used: readCount(raw.llm.used) };
    }
    if (isObj(raw.llm) && isNum(raw.llm.pausedUntilMs)) state.llm.pausedUntilMs = raw.llm.pausedUntilMs;
    if (isObj(raw.nominations) && typeof raw.nominations.day === "string" && DAY_KEY.test(raw.nominations.day)) {
      state.nominations = {
        day: raw.nominations.day,
        n: readCount(raw.nominations.n),
        entries: readCount(raw.nominations.entries),
      };
    }
    return state;
  } catch {
    // Unreachable for JSON input; here so a hostile object (a throwing getter)
    // still cannot throw through the "never throws" promise.
    return emptyTgGroupsState();
  }
}

/** Serialized size in bytes, as it will be on disk. */
const bytesOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), "utf8");

/**
 * Bring the serialized state under `maxBytes`, oldest first. Returns true when
 * it removed anything.
 *
 * Tiers, each only reached when the one before is exhausted and the file is
 * still too big: lines (the bulk, and the cheapest to lose — the summary keeps
 * their gist), coin memos, people, summaries, and last claims older than the
 * pressure age (never younger ones; see CLAIMS_PER_ROOM). Within a tier the
 * size is estimated per item and re-measured after, so this is linear rather
 * than one full serialization per dropped line.
 */
function fitToBytes(s: TgGroupsState, maxBytes: number, nowMs: number): boolean {
  let bytes = bytesOf(s);
  if (bytes < maxBytes) return false;
  const rooms = Object.values(s.rooms);

  type Item = { at: number; size: number; drop: () => void };
  const tiers: Array<() => Item[]> = [
    () =>
      rooms.flatMap((r) =>
        r.lines.map((l) => ({
          at: l.atMs,
          size: bytesOf(l) + 1,
          drop: () => void (r.lines = r.lines.filter((x) => x !== l)),
        })),
      ),
    () =>
      rooms.flatMap((r) =>
        r.coins.map((c) => ({
          at: c.atMs,
          size: bytesOf(c) + 1,
          drop: () => void (r.coins = r.coins.filter((x) => x !== c)),
        })),
      ),
    () =>
      rooms.flatMap((r) =>
        r.people.map((p) => ({
          at: p.lastSeenMs,
          size: bytesOf(p) + 1,
          drop: () => void (r.people = r.people.filter((x) => x !== p)),
        })),
      ),
    () =>
      rooms
        .filter((r) => r.summary.length > 0)
        .map((r) => ({
          at: r.lastSummaryAtMs ?? 0,
          size: bytesOf(r.summary) - 2,
          drop: () => void (r.summary = ""),
        })),
    () =>
      rooms.flatMap((r) =>
        Object.entries(r.claims)
          .filter(([, at]) => nowMs - at > CLAIM_PRESSURE_MIN_AGE_MS)
          .map(([k, at]) => ({
            at,
            size: bytesOf(k) + bytesOf(at) + 2,
            drop: () => void delete r.claims[k],
          })),
      ),
  ];

  let changed = false;
  for (const tier of tiers) {
    for (;;) {
      const items = tier().sort((a, b) => a.at - b.at);
      if (items.length === 0) break;
      for (const it of items) {
        it.drop();
        changed = true;
        bytes -= it.size;
        if (bytes < maxBytes) break;
      }
      bytes = bytesOf(s);
      if (bytes < maxBytes) return changed;
    }
  }
  return changed;
}

// ─── Forget requests, kept apart from the memory they erase ───────────────

/**
 * Beside tg-groups.json: every `/forget` and `/forgetme`, one JSON record per
 * line, appended and fsynced before the agent says "done".
 *
 * WHY A SECOND FILE. The memory file is not always the memory. Hosted, a
 * child whose memory could not be brought back at spawn runs with its groups
 * held off (docs/tg-groups.md "Storage and the ferry"): its store starts
 * empty, nothing it writes is published, and the sealed copy its next spawn
 * restores still holds everything. A forget done on that empty store erases
 * nothing, and the restore would hand the person's lines back. This file
 * keeps the request itself, so whoever holds the real memory can apply it:
 * the ferry to the sealed copy (tg-groups-ferry.ts), the restore before it
 * writes the file back, and this store when it opens.
 *
 * APPEND-ONLY, BECAUSE IT HAS TWO WRITERS. The child appends. The ferry takes
 * the file away once a publish shows the child's own memory reflects it, and
 * appends back whatever arrived meanwhile. Appends never overwrite each
 * other, so neither side can lose the other's record. Each record sits
 * between newlines, so one torn by a crash never swallows the next.
 */
export const TG_GROUPS_FORGET_FILE = "tg-groups-forget.json";

/**
 * Past `fileBytes`, the next record compacts the file first: one record per
 * chat and person (the latest), at most `ops`, newest kept. A record is under
 * 100 bytes, so a compacted file is well under `fileBytes`. A file past
 * `readBytes` was not written by this store or the ferry.
 */
export const TG_FORGET_LIMITS = { ops: 500, fileBytes: 64 * 1024, readBytes: 256 * 1024 } as const;

/**
 * One forget request. `userId` "*" is the owner's `/forget` (the chat's whole
 * memory); a number is that person's `/forgetme`. `atMs` is when it was asked,
 * on the store's clock. Only what the chat remembered by then is erased, so
 * applying the request again later never erases what was said after it.
 */
export interface TgForgetOp {
  chatId: number;
  userId: number | "*";
  atMs: number;
}

function cleanForget(v: unknown): TgForgetOp | null {
  if (!isObj(v) || !isInt(v.chatId) || !isNum(v.atMs)) return null;
  const userId = v.userId === "*" ? "*" : isInt(v.userId) ? v.userId : null;
  if (userId === null) return null;
  return { chatId: v.chatId, userId, atMs: v.atMs };
}

/**
 * One request per chat and person, the latest: erasing up to a later moment
 * erases everything an earlier request for the same person would have. At
 * most TG_FORGET_LIMITS.ops, newest kept, oldest first.
 */
function compactForgets(ops: readonly TgForgetOp[]): TgForgetOp[] {
  const byKey = new Map<string, TgForgetOp>();
  for (const op of ops) {
    const key = `${op.chatId}:${op.userId}`;
    const prev = byKey.get(key);
    if (!prev || op.atMs > prev.atMs) byKey.set(key, op);
  }
  return keepNewest([...byKey.values()], TG_FORGET_LIMITS.ops, (o) => o.atMs);
}

/** The forget requests in a forget file's text: well-formed records only, compacted. Never throws. */
export function parseTgForgets(text: string): TgForgetOp[] {
  const ops: TgForgetOp[] = [];
  for (const row of String(text ?? "").split("\n")) {
    const t = row.trim();
    if (!t) continue;
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch {
      continue; // a record torn by a crash, or not ours
    }
    const op = cleanForget(v);
    if (op) ops.push(op);
  }
  return compactForgets(ops);
}

/** One record as it is written: between newlines (see TG_GROUPS_FORGET_FILE). */
const forgetRecord = (op: TgForgetOp): string => `\n${JSON.stringify({ chatId: op.chatId, userId: op.userId, atMs: op.atMs })}\n`;

const NAME_EDGE_BEFORE = "(?<![\\p{L}\\p{N}_])";
const NAME_EDGE_AFTER = "(?![\\p{L}\\p{N}_])";
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a summary names any of these (whole words, NFKC, any case), the way
 * /forgetme judges it. A name that cannot be matched counts as named: the
 * summary is rebuilt from what is left, never kept by doubt.
 */
function summaryNames(summary: string, names: readonly string[]): boolean {
  const s = summary.normalize("NFKC").toLowerCase();
  return names.some((n) => {
    try {
      return new RegExp(`${NAME_EDGE_BEFORE}${escapeRe(n.normalize("NFKC").toLowerCase().trim())}${NAME_EDGE_AFTER}`, "u").test(s);
    } catch {
      return true;
    }
  });
}

/**
 * `/forget` on one room, for what it remembered by `atMs` (Infinity: all of
 * it): lines, people, coins and the summary. Status, title and claims stay:
 * the first two are whether and where it is, the last is at-most-once, and
 * none of them is memory of what was said.
 */
function wipeRoom(room: TgRoom, atMs: number): void {
  const lines = room.lines.filter((l) => l.atMs > atMs);
  if (lines.length !== room.lines.length) {
    room.lines = lines;
    room.sinceSummary = Math.min(room.sinceSummary, lines.filter((l) => !l.own).length);
  }
  room.people = room.people.filter((p) => p.lastSeenMs > atMs);
  room.coins = room.coins.filter((c) => c.atMs > atMs);
  if ((room.lastSummaryAtMs ?? -Infinity) <= atMs) {
    room.summary = "";
    delete room.lastSummaryAtMs;
  }
}

/**
 * `/forgetme` on one room, for what it remembered of `userId` by `atMs`
 * (Infinity: all of it). Their lines and person entry go. Their coin posts
 * keep the coin and its verdict (an outcome may still be on its way to that
 * memo) but no longer say who posted it: the name goes, and so does the user
 * id, which names them just as well. A summary that names them is dropped
 * whole; the next memory pass rebuilds it from the lines that are left.
 * Returns how many lines went.
 */
function forgetPersonIn(room: TgRoom, userId: number, atMs: number): number {
  const theirs = (l: TgLine): boolean => l.fromId === userId && l.atMs <= atMs;
  const names = [room.people.find((p) => p.id === userId)?.name, ...room.lines.filter(theirs).map((l) => l.name)].filter(
    (n): n is string => typeof n === "string" && [...n.trim()].length >= 2,
  );
  const before = room.lines.length;
  room.lines = room.lines.filter((l) => !theirs(l));
  room.people = room.people.filter((p) => !(p.id === userId && p.lastSeenMs <= atMs));
  for (const c of room.coins) {
    if (c.byId === userId && c.atMs <= atMs) {
      c.byId = 0;
      c.byName = "";
    }
  }
  if ((room.lastSummaryAtMs ?? -Infinity) <= atMs && summaryNames(room.summary, names)) room.summary = "";
  return before - room.lines.length;
}

/**
 * What `/forget` and `/forgetme` do, applied to a whole state: the store's
 * own `forgetChat` and `forgetPerson` (the coin memos and the summary
 * included), bounded by each request's `atMs`. A chat the state does not have
 * is skipped.
 *
 * PURE: `state` is not changed. The result is a fresh copy, read the way a
 * file is read (parseTgGroupsState), so a caller holding a file's text can
 * compare the two to learn whether anything was left to erase.
 */
export function applyForgets(state: TgGroupsState, ops: readonly TgForgetOp[]): TgGroupsState {
  const s = parseTgGroupsState(state);
  const clean = compactForgets((Array.isArray(ops) ? ops : []).map(cleanForget).filter((o): o is TgForgetOp => o !== null));
  for (const op of clean) {
    const room = s.rooms[String(op.chatId)];
    if (!room) continue;
    if (op.userId === "*") wipeRoom(room, op.atMs);
    else forgetPersonIn(room, op.userId, op.atMs);
  }
  return s;
}

/** The last `max` bytes of a file (all of it when smaller). A partial first record is dropped by the parser. */
function readTail(file: string, max: number): string {
  const fd = openSync(file, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return "";
    const len = Math.min(st.size, max);
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, st.size - len + got);
      if (n === 0) break;
      got += n;
    }
    return buf.subarray(0, got).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** The forget requests in `home`, or none. Never throws. */
function readForgetFile(home: string): TgForgetOp[] {
  try {
    return parseTgForgets(readTail(path.join(home, TG_GROUPS_FORGET_FILE), TG_FORGET_LIMITS.readBytes));
  } catch {
    return [];
  }
}

/** Write all of `data` at the end of an open file: a short write is a failed one, never half a record left unsaid. */
function writeAll(fd: number, data: Buffer): void {
  let off = 0;
  while (off < data.length) {
    const n = writeSync(fd, data, off, data.length - off);
    if (n <= 0) throw new Error("short write");
    off += n;
  }
}

/**
 * Append one record to `home`'s forget file, synchronously and durably. The
 * ferry may take the file away between our open and our write (it renames a
 * file it has finished with aside, then deletes it); a record written into
 * the taken file could go with it, so when the name no longer points at the
 * file just written, the record is written again where it does. A second copy
 * is harmless: requests are compacted when read.
 */
function appendForget(home: string, op: TgForgetOp): void {
  const file = path.join(home, TG_GROUPS_FORGET_FILE);
  mkdirSync(home, { recursive: true });
  let size = 0;
  try {
    size = lstatSync(file).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (size >= TG_FORGET_LIMITS.fileBytes) {
    // Compacted by temp file and rename. Only a flood of requests nobody
    // cleared gets here; everything it held is in what replaces it.
    const body = Buffer.from(compactForgets([...readForgetFile(home), op]).map(forgetRecord).join(""), "utf8");
    const tmp = `${file}.tmp`;
    rmSync(tmp, { force: true });
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeAll(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    syncDir(home);
    return;
  }
  const record = Buffer.from(forgetRecord(op), "utf8");
  for (let attempt = 0; attempt < 5; attempt++) {
    const fd = openSync(file, fsc.O_WRONLY | fsc.O_APPEND | fsc.O_CREAT | (fsc.O_NOFOLLOW ?? 0), 0o600);
    let ino: number;
    try {
      writeAll(fd, record);
      fsyncSync(fd);
      ino = fstatSync(fd).ino;
    } finally {
      closeSync(fd);
    }
    syncDir(home);
    let now: number | null = null;
    try {
      now = lstatSync(file).ino;
    } catch {
      now = null;
    }
    if (now === ino) return;
  }
  throw new Error("the forget file kept being taken away");
}

// ─── The store ─────────────────────────────────────────────────────────────

export interface TgGroupsStoreOptions {
  /** Clock. Everything in the store (days, hours, ages, stamps) reads this. */
  now?: () => number;
  /** How long ordinary changes wait to be written. Default 2000 ms. */
  debounceMs?: number;
  /**
   * NO FERRY WILL CARRY THE FORGET FILE: this store clears it itself, once the
   * memory file on disk reflects every request in it. Self-hosted only.
   * Hosted, the orchestrator must see each request first (it applies them to
   * the sealed copy it keeps), so there the ferry clears the file and this
   * stays false. Left alone, the file would keep the Telegram id of everyone
   * who ever ran /forgetme — the one thing they asked not to be kept.
   */
  ownsForgets?: boolean;
}

export class TgGroupsStore {
  /** The file this store writes, `<home>/tg-groups.json`. */
  readonly file: string;
  private s: TgGroupsState;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private warned = false;
  private forgetWarned = false;
  private closed = false;
  /**
   * How many times each chat's memory was wiped (/forget, /forgetme) in this
   * process. A memory pass reads the lines, waits seconds for the model, then
   * writes a summary: one built from lines wiped meanwhile must not be written
   * back (memory.ts applyMemoryPass). In memory only: a pass never outlives
   * the process that started it.
   */
  private readonly wipes = new Map<string, number>();
  private readonly ownsForgets: boolean;

  /**
   * Open `<home>/tg-groups.json`. Absent → empty. Not JSON, not an object, an
   * unknown version, or absurdly large → moved to `tg-groups.json.bad` and
   * empty: kept for a human to look at, never overwritten by the next save.
   */
  static open(home: string, opts: TgGroupsStoreOptions = {}): TgGroupsStore {
    const file = path.join(home, TG_GROUPS_FILE);
    let initial: unknown = emptyTgGroupsState();
    let text: string | null = null;
    try {
      if (statSync(file).size > MAX_READ_BYTES) {
        TgGroupsStore.setAside(file, "too large");
      } else {
        text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
      }
    } catch (e) {
      // Present but unreadable is set aside too: starting empty and then
      // saving would rename over it and lose it for good.
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") TgGroupsStore.setAside(file, `unreadable (${code ?? "error"})`);
    }
    if (text !== null) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (isObj(parsed) && parsed.version === 1) initial = parsed;
      else TgGroupsStore.setAside(file, "unreadable");
    }
    const store = new TgGroupsStore(file, initial as TgGroupsState, opts);
    store.applyForgetFile(home);
    store.prune();
    return store;
  }

  /**
   * Every forget request on file, applied to what was just read. The file is
   * written before the memory is (recordForget comes first), so a crash or a
   * failed write between the two, or a memory file from before the request,
   * must not bring the forgotten lines back. A request already reflected
   * changes nothing and costs no write.
   */
  private applyForgetFile(home: string): void {
    const ops = readForgetFile(home);
    if (ops.length === 0) return;
    const next = applyForgets(this.s, ops);
    if (JSON.stringify(next) === JSON.stringify(this.s)) return;
    this.s = next;
    this.touch();
  }

  /**
   * Self-hosted: drop the forget file once the memory just written (and the
   * directory entry for it, synced above) reflects every request in it. One
   * process writes both files and recordForget is synchronous, so no request
   * can arrive between the read and the removal. A request not yet reflected
   * keeps the file until a later write reflects it.
   */
  private clearReflectedForgets(home: string): void {
    const file = path.join(home, TG_GROUPS_FORGET_FILE);
    try {
      const ops = readForgetFile(home);
      if (ops.length === 0) {
        rmSync(file, { force: true });
        return;
      }
      if (JSON.stringify(applyForgets(this.s, ops)) !== JSON.stringify(this.s)) return;
      rmSync(file, { force: true });
    } catch (e) {
      if (!this.forgetWarned) {
        this.forgetWarned = true;
        console.warn(`[tg-groups] could not clear ${TG_GROUPS_FORGET_FILE} (${(e as NodeJS.ErrnoException).code ?? "error"})`);
      }
    }
  }

  private static setAside(file: string, why: string): void {
    try {
      renameSync(file, `${file}.bad`);
      console.warn(`[tg-groups] ${TG_GROUPS_FILE} was ${why}; moved to ${TG_GROUPS_FILE}.bad and starting empty`);
    } catch (e) {
      console.warn(`[tg-groups] ${TG_GROUPS_FILE} was ${why} and could not be moved aside (${(e as NodeJS.ErrnoException).code ?? "error"})`);
    }
  }

  /**
   * `initial` goes through the same tolerant parse as a file does, so a caller
   * handing in a hand-built state gets the same caps and clipping.
   */
  constructor(path: string, initial: TgGroupsState, opts: TgGroupsStoreOptions = {}) {
    this.file = path;
    this.s = parseTgGroupsState(initial);
    this.now = opts.now ?? Date.now;
    this.debounceMs = Math.max(0, opts.debounceMs ?? 2000);
    this.ownsForgets = opts.ownsForgets === true;
  }

  /**
   * The live state. Read it; change it only through the methods below (or
   * `update`), which is what schedules the write.
   */
  get state(): Readonly<TgGroupsState> {
    return this.s;
  }

  room(chatId: number): TgRoom | undefined {
    return this.s.rooms[String(chatId)];
  }

  rooms(): TgRoom[] {
    return Object.values(this.s.rooms);
  }

  /**
   * The room for `chatId`, created `pending` if new. An existing room keeps its
   * status; its title, kind and forum flag follow what Telegram says now
   * (groups get renamed).
   *
   * At the 30-chat cap a new room evicts one in EVICT_TIER order: the
   * longest-gone left room, then the quietest pending one. Only the owner's
   * own act (`owner`: the owner added it, spoke in it, or linked it) may push
   * out a blocked or an approved room. For anyone else, a store holding
   * nothing but the owner's decisions has no room for a new chat, and this
   * returns undefined without creating one.
   */
  ensureRoom(chatId: number, init: { title: string; kind: string; isForum?: boolean }, opts: { owner?: boolean } = {}): TgRoom | undefined {
    const key = String(chatId);
    const title = label(init.title, TITLE_CHARS);
    const kind = label(init.kind, KIND_CHARS);
    const existing = this.s.rooms[key];
    if (existing) {
      let changed = false;
      if (title && existing.title !== title) {
        existing.title = title;
        changed = true;
      }
      if (kind && existing.kind !== kind) {
        existing.kind = kind;
        changed = true;
      }
      if (init.isForum !== undefined && Boolean(existing.isForum) !== init.isForum) {
        if (init.isForum) existing.isForum = true;
        else delete existing.isForum;
        changed = true;
      }
      if (changed) this.touch();
      return existing;
    }
    if (!capRooms(this.s.rooms, TG_LIMITS.chats - 1, opts.owner === true ? undefined : undecided)) return undefined;
    const room: TgRoom = {
      chatId,
      title,
      status: "pending",
      kind: kind || "group",
      statusAtMs: this.now(),
      lines: [],
      sinceSummary: 0,
      summary: "",
      people: [],
      coins: [],
      claims: {},
    };
    if (init.isForum) room.isForum = true;
    this.s.rooms[key] = room;
    this.touch();
    return room;
  }

  /**
   * Change a room in place and schedule the write. The limits are re-applied
   * afterwards (a model-written summary cannot outgrow 900 chars this way), and
   * the room's chat id cannot be changed through here — `migrate` does that.
   */
  update(chatId: number, fn: (r: TgRoom) => void, opts: { flush?: boolean } = {}): void {
    const room = this.room(chatId);
    if (!room) return;
    try {
      fn(room);
    } finally {
      room.chatId = chatId;
      this.clampRoom(room);
      if (opts.flush) {
        this.dirty = true;
        this.write();
      } else {
        this.touch();
      }
    }
  }

  /**
   * Set a room's status, written before returning. `statusAtMs` moves only on
   * a real change, so a repeated membership update does not restart the
   * pending room's 24 h clock. `byId` is who added the agent: it is recorded
   * with an `approved` or `pending` change and ignored otherwise.
   *
   * A real change also clears `askedOwnerAtMs`. That stamp is the owner's
   * Stay/Leave question for ONE pending spell, and its 24 h clock is what
   * leaves the group unanswered. Carried into a later spell (asked, Stay,
   * removed, re-added two hours later), it would skip the new question and
   * leave the group the owner said Stay to, a day after the first ask.
   */
  setStatus(chatId: number, status: TgRoomStatus, byId?: number): void {
    const room = this.room(chatId);
    if (!room || !ROOM_STATUSES.includes(status)) return;
    if (room.status !== status) {
      const at = this.now();
      room.status = status;
      room.statusAtMs = at;
      delete room.askedOwnerAtMs;
      if (byId !== undefined && isInt(byId) && (status === "approved" || status === "pending")) {
        room.addedById = byId;
        room.addedAtMs = at;
      }
    }
    this.dirty = true;
    this.write();
  }

  /**
   * Remember a line. False when the room is unknown or the message id is
   * already remembered (a redelivered update). Text and name are clipped;
   * human lines count towards the next memory pass; the newest 60 are kept.
   */
  addLine(chatId: number, line: TgLine): boolean {
    const room = this.room(chatId);
    if (!room) return false;
    const clean = parseLine(line);
    if (!clean) return false;
    if (room.lines.some((l) => l.messageId === clean.messageId)) return false;
    const last = room.lines[room.lines.length - 1];
    room.lines.push(clean);
    if (last && clean.atMs < last.atMs) room.lines = keepNewest(room.lines, TG_LIMITS.lines, (l) => l.atMs);
    else if (room.lines.length > TG_LIMITS.lines) room.lines.splice(0, room.lines.length - TG_LIMITS.lines);
    if (!clean.own) room.sinceSummary += 1;
    this.touch();
    return true;
  }

  /**
   * Create or update what it knows about a person in one chat. Fields not
   * given are kept; `lastSeenMs` defaults to now, because this is called on
   * seeing them. Passing a field as `undefined` explicitly clears it. At the
   * 40-person cap the person seen longest ago makes room. Returns the stored
   * record (for an unknown room, a detached copy that is not stored).
   */
  upsertPerson(chatId: number, p: { id: number; name: string } & Partial<TgPerson>): TgPerson {
    const room = this.room(chatId);
    let person = room?.people.find((x) => x.id === p.id);
    const fresh = !person;
    if (!person) person = { id: p.id, name: "", note: "", lastSeenMs: 0 };
    const name = label(p.name, TG_LIMITS.nameChars);
    if (name) person.name = name;
    if (typeof p.note === "string") person.note = prose(p.note, TG_LIMITS.noteChars);
    person.lastSeenMs = isNum(p.lastSeenMs) ? p.lastSeenMs : this.now();
    for (const k of ["roasts", "answers"] as const) {
      if (!has(p, k)) continue;
      const w = parseWindow(p[k]);
      if (w) person[k] = w;
      else delete person[k];
    }
    if (has(p, "greetedDay")) {
      if (typeof p.greetedDay === "string" && DAY_KEY.test(p.greetedDay)) person.greetedDay = p.greetedDay;
      else delete person.greetedDay;
    }
    if (!room || !isInt(person.id)) return person;
    if (fresh) {
      while (room.people.length >= TG_LIMITS.people) {
        let oldest = 0;
        for (let i = 1; i < room.people.length; i++) {
          if (room.people[i]!.lastSeenMs < room.people[oldest]!.lastSeenMs) oldest = i;
        }
        room.people.splice(oldest, 1);
      }
      room.people.push(person);
    }
    this.touch();
    return person;
  }

  person(chatId: number, id: number): TgPerson | undefined {
    return this.room(chatId)?.people.find((p) => p.id === id);
  }

  /**
   * AT-MOST-ONCE: claim `(chatId, messageId, address)` before anything is done
   * about a posted coin. True exactly once, and only after the claim is on disk.
   *
   * False — "do nothing" — when it was claimed before, when the address or
   * message id is not well-formed, when the room is unknown, when the room is
   * flooded with fresh claims, or when the write failed. In that last case the
   * claim still stands in memory, so this process will not act on it later
   * either; the next write carries it to disk.
   */
  claim(chatId: number, messageId: number, address: string): boolean {
    const room = this.room(chatId);
    if (!room || !isInt(messageId) || typeof address !== "string") return false;
    const addr = address.toLowerCase();
    if (!ADDRESS.test(addr)) return false;
    const key = `${messageId}:${addr}`;
    if (has(room.claims, key)) return false;

    const now = this.now();
    for (const [k, at] of Object.entries(room.claims)) {
      if (now - at > TG_LIMITS.claimMaxAgeMs) delete room.claims[k];
    }
    let entries = Object.entries(room.claims);
    if (entries.length >= CLAIMS_PER_ROOM) {
      const droppable = entries
        .filter(([, at]) => now - at > CLAIM_PRESSURE_MIN_AGE_MS)
        .sort((a, b) => a[1] - b[1]);
      for (const [k] of droppable.slice(0, entries.length - CLAIMS_PER_ROOM + 1)) delete room.claims[k];
      entries = Object.entries(room.claims);
      if (entries.length >= CLAIMS_PER_ROOM) return false;
    }

    room.claims[key] = now;
    this.dirty = true;
    return this.write({ durable: true });
  }

  /** Remember a coin posted here; a memo for the same address is replaced. */
  rememberCoin(chatId: number, memo: TgCoinMemo): void {
    const room = this.room(chatId);
    const clean = parseCoin(memo);
    if (!room || !clean) return;
    room.coins = capCoins([...room.coins.filter((c) => c.address !== clean.address), clean]);
    this.touch();
  }

  /** The memo for `address` in this chat, if it was posted within `withinMs` (any age when omitted). */
  coin(chatId: number, address: string, withinMs?: number): TgCoinMemo | undefined {
    if (typeof address !== "string") return undefined;
    const addr = address.toLowerCase();
    const memo = this.room(chatId)?.coins.find((c) => c.address === addr);
    if (!memo) return undefined;
    if (withinMs !== undefined && this.now() - memo.atMs > withinMs) return undefined;
    return memo;
  }

  /**
   * Patch a memo in place (the address itself cannot change). A patch that
   * would make the memo malformed — an unknown verdict, say — is ignored whole.
   * Passing an optional field as `undefined` clears it.
   */
  updateCoin(chatId: number, address: string, patch: Partial<TgCoinMemo>): void {
    const memo = this.coin(chatId, address);
    if (!memo) return;
    const clean = parseCoin({ ...memo, ...patch, address: memo.address });
    if (!clean) return;
    for (const k of Object.keys(memo) as Array<keyof TgCoinMemo>) delete (memo as Partial<TgCoinMemo>)[k];
    Object.assign(memo, clean);
    this.touch();
  }

  /** The coin a Brain decision was about, across chats (the newest if several). */
  findCoinByDecision(decisionId: string): { chatId: number; memo: TgCoinMemo } | undefined {
    if (typeof decisionId !== "string" || decisionId === "") return undefined;
    let found: { chatId: number; memo: TgCoinMemo } | undefined;
    for (const room of this.rooms()) {
      for (const memo of room.coins) {
        if (memo.decisionId === decisionId && (!found || memo.atMs > found.memo.atMs)) {
          found = { chatId: room.chatId, memo };
        }
      }
    }
    return found;
  }

  /**
   * `/forget`: wipe what it remembers of the chat — lines, summary, people,
   * coins. Status, title and claims stay: the first two are whether and where
   * it is, the last is at-most-once, and none of them is memory of what was
   * said. Written before returning.
   */
  forgetChat(chatId: number): void {
    const room = this.room(chatId);
    if (!room) return;
    // The same code applyForgets runs, so a request carried by the forget
    // file erases exactly what this did.
    wipeRoom(room, Infinity);
    room.sinceSummary = 0;
    this.wiped(chatId);
    this.dirty = true;
    this.write();
  }

  /**
   * `/forgetme`: remove one person's lines and their entry from one chat,
   * blank their name and user id on that chat's coin memos, and drop a
   * summary that names them (forgetPersonIn, which applyForgets runs too).
   * Returns how many lines went. Written before returning.
   */
  forgetPerson(chatId: number, userId: number): number {
    const room = this.room(chatId);
    if (!room) return 0;
    const removed = forgetPersonIn(room, userId, Infinity);
    this.wiped(chatId);
    this.dirty = true;
    this.write();
    return removed;
  }

  /**
   * Put a forget request on disk (TG_GROUPS_FORGET_FILE) before anything is
   * said about it. Call it first, then `forgetChat` / `forgetPerson`: this is
   * what carries the request to the memory when this store is not holding it
   * (a hosted child whose groups are held off starts empty), so it is
   * recorded whatever the switches say and whether or not this store knows
   * the chat. Synchronous: appended and fsynced. True once it is on disk;
   * false for a malformed request or a failed write (logged once, without
   * content).
   */
  recordForget(op: TgForgetOp): boolean {
    const clean = cleanForget(op);
    if (!clean) return false;
    try {
      appendForget(path.dirname(this.file), clean);
      this.forgetWarned = false;
      return true;
    } catch (e) {
      if (!this.forgetWarned) {
        this.forgetWarned = true;
        console.warn(
          `[tg-groups] could not save ${TG_GROUPS_FORGET_FILE} (${(e as NodeJS.ErrnoException).code ?? "error"})`,
        );
      }
      return false;
    }
  }

  /**
   * How many times this chat's memory has been wiped in this process (see
   * `wipes`). Read it before a slow memory pass and compare after: a
   * different number means what the pass read has been forgotten since.
   */
  forgetGen(chatId: number): number {
    return this.wipes.get(String(chatId)) ?? 0;
  }

  private wiped(chatId: number): void {
    const key = String(chatId);
    this.wipes.set(key, (this.wipes.get(key) ?? 0) + 1);
  }

  /**
   * A group became a supergroup (`migrate_to_chat_id`): move its state to the
   * new id, keeping its status. Written before returning.
   *
   * The new chat may already have a room — its first message can arrive before
   * the migration notice, and that message created it `pending`. The migrated
   * room's status wins and the two memories are merged.
   *
   * The old chat's lines keep their text but their message ids are negated:
   * the supergroup numbers its messages afresh, and an old id equal to a new
   * one would make `addLine` reject a real new message as a duplicate. Telegram
   * never uses negative message ids, so the two ranges cannot meet. Claims keep
   * their keys: a collision there refuses a coin, the safe direction.
   */
  migrate(fromChatId: number, toChatId: number): void {
    if (fromChatId === toChatId || !isInt(toChatId)) return;
    const src = this.room(fromChatId);
    if (!src) return;
    const dst = this.room(toChatId);
    delete this.s.rooms[String(fromChatId)];

    src.chatId = toChatId;
    src.kind = "supergroup";
    src.lines = src.lines.map((l) => {
      const moved: TgLine = { ...l, messageId: -Math.abs(l.messageId) };
      if (l.replyTo !== undefined) moved.replyTo = -Math.abs(l.replyTo);
      return moved;
    });
    if (dst) {
      if (dst.title) src.title = dst.title;
      if (dst.isForum) src.isForum = true;
      src.lines = capLines([...src.lines, ...dst.lines]);
      src.people = mergePeople(src.people, dst.people);
      src.coins = capCoins([...src.coins, ...dst.coins]);
      src.claims = { ...src.claims, ...dst.claims };
      src.sinceSummary += dst.sinceSummary;
      if (!src.summary) src.summary = dst.summary;
      if (dst.ownerName) src.ownerName = dst.ownerName;
    }
    this.s.rooms[String(toChatId)] = src;
    this.clampRoom(src);
    this.dirty = true;
    this.write();
  }

  // ─── Allowances ──────────────────────────────────────────────────────────

  /**
   * One group model call from today's per-agent allowance. Resets on a new UTC
   * day. Does NOT consult the pause: check `llmPausedUntil()` as well.
   */
  takeLlm(limit: number): boolean {
    if (!isNum(limit) || limit <= 0) return false;
    const day = utcDay(this.now());
    const llm = this.s.llm;
    // A clock that went back across midnight gets no fresh allowance.
    if (day < llm.day) return false;
    if (day !== llm.day) {
      llm.day = day;
      llm.used = 0;
    }
    if (llm.used >= limit) return false;
    llm.used += 1;
    this.touch();
    return true;
  }

  /** When the model pause ends, or 0 when it is not paused. */
  llmPausedUntil(): number {
    const until = this.s.llm.pausedUntilMs ?? 0;
    return until > this.now() ? until : 0;
  }

  /** Pause group model calls until `untilMs`. Never shortens a longer pause already set. */
  pauseLlm(untilMs: number): void {
    if (!isNum(untilMs)) return;
    const cur = this.s.llm.pausedUntilMs ?? 0;
    if (untilMs <= cur) return;
    this.s.llm.pausedUntilMs = untilMs;
    this.touch();
  }

  /** One model call from this chat's hourly allowance (UTC hour). False for an unknown room. */
  takeRoomLlm(chatId: number, perHour: number): boolean {
    const room = this.room(chatId);
    if (!room || !isNum(perHour) || perHour <= 0) return false;
    const hour = utcHour(this.now());
    if (room.llmHour && hour < room.llmHour.hour) return false;
    if (!room.llmHour || room.llmHour.hour !== hour) room.llmHour = { hour, n: 0 };
    if (room.llmHour.n >= perHour) return false;
    room.llmHour.n += 1;
    this.touch();
    return true;
  }

  /**
   * One group nomination from `day`'s per-agent cap. Written before returning
   * true; a failed write refuses and gives the take back.
   */
  takeNomination(day: string, limit: number): boolean {
    return this.takeDaily(day, limit, "n");
  }

  /**
   * One group-sourced entry from `day`'s per-agent cap (at most 3 by contract),
   * claimed before the entry. Written before returning true; a failed write
   * refuses. Give it back with `refundGroupEntry` when the entry does not land.
   */
  takeGroupEntry(day: string, limit: number): boolean {
    return this.takeDaily(day, limit, "entries");
  }

  /**
   * Give back one group-sourced entry for `day`. Never below zero, and a refund
   * for a day that is no longer current returns nothing to today.
   */
  refundGroupEntry(day: string): void {
    const nom = this.s.nominations;
    if (nom.day !== day || nom.entries <= 0) return;
    nom.entries -= 1;
    this.touch();
  }

  /**
   * The shared day logic of the two caps. `day` comes from the caller (the
   * nomination book keys its caps by UTC day). A day later than the stored one
   * starts a clean count; an EARLIER one is refused outright — resetting to it
   * would hand a stale day a fresh allowance and wipe today's count.
   */
  private takeDaily(day: string, limit: number, field: "n" | "entries"): boolean {
    if (typeof day !== "string" || !DAY_KEY.test(day) || !isNum(limit) || limit <= 0) return false;
    const nom = this.s.nominations;
    if (day < nom.day) return false;
    const prev = { ...nom };
    if (day !== nom.day) {
      nom.day = day;
      nom.n = 0;
      nom.entries = 0;
    }
    if (nom[field] >= limit) {
      Object.assign(nom, prev);
      return false;
    }
    nom[field] += 1;
    this.dirty = true;
    if (this.write({ durable: true })) return true;
    Object.assign(nom, prev);
    return false;
  }

  // ─── Pruning and writing ─────────────────────────────────────────────────

  /**
   * Age everything out, then bound the size. Lines and coin memos older than
   * 14 days, left/blocked rooms gone for 30 days, claims older than 2 days;
   * then, while the serialized file is 512 KB or more, the oldest lines across
   * all rooms (and past those, see `fitToBytes`). Schedules a write when
   * anything changed.
   */
  prune(): void {
    const now = this.now();
    let changed = false;
    for (const [key, room] of Object.entries(this.s.rooms)) {
      if ((room.status === "left" || room.status === "blocked") && now - room.statusAtMs > TG_LIMITS.leftKeepMs) {
        delete this.s.rooms[key];
        changed = true;
        continue;
      }
      const lines = room.lines.filter((l) => now - l.atMs <= TG_LIMITS.lineMaxAgeMs);
      if (lines.length !== room.lines.length) {
        room.lines = lines;
        changed = true;
      }
      const coins = room.coins.filter((c) => now - c.atMs <= TG_LIMITS.coinMaxAgeMs);
      if (coins.length !== room.coins.length) {
        room.coins = coins;
        changed = true;
      }
      for (const [k, at] of Object.entries(room.claims)) {
        if (now - at > TG_LIMITS.claimMaxAgeMs) {
          delete room.claims[k];
          changed = true;
        }
      }
    }
    if (fitToBytes(this.s, TG_LIMITS.fileBytes, now)) changed = true;
    if (changed) this.touch();
  }

  /** Write now, synchronously, if anything is unsaved. Never throws. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.dirty) this.write();
  }

  /** Flush and stop the timer. Changes after close are written synchronously. */
  close(): void {
    this.closed = true;
    this.flush();
  }

  /**
   * Re-apply the limits to one room after a caller changed it freely. Lists
   * are only rebuilt when something in them is out of bounds, so the records
   * callers hold on to stay the stored ones in the ordinary case.
   */
  private clampRoom(r: TgRoom): void {
    r.title = label(r.title, TITLE_CHARS);
    r.summary = prose(r.summary, TG_LIMITS.summaryChars);
    if (r.ownerName !== undefined) {
      const name = label(r.ownerName, TG_LIMITS.nameChars);
      if (name) r.ownerName = name;
      else delete r.ownerName;
    }
    if (!isNum(r.sinceSummary) || r.sinceSummary < 0) r.sinceSummary = 0;
    if (!Array.isArray(r.lines)) r.lines = [];
    if (!Array.isArray(r.people)) r.people = [];
    if (!Array.isArray(r.coins)) r.coins = [];
    if (!isObj(r.claims)) r.claims = {};
    const lineOk = (l: unknown) =>
      isObj(l) && typeof l.text === "string" && l.text.length <= TG_LIMITS.lineChars &&
      typeof l.name === "string" && l.name.length <= TG_LIMITS.nameChars;
    if (r.lines.length > TG_LIMITS.lines || !r.lines.every(lineOk)) {
      r.lines = capLines(r.lines.map(parseLine).filter((l): l is TgLine => l !== null));
    }
    const personOk = (p: unknown) =>
      isObj(p) && typeof p.note === "string" && p.note.length <= TG_LIMITS.noteChars &&
      typeof p.name === "string" && p.name.length <= TG_LIMITS.nameChars;
    if (r.people.length > TG_LIMITS.people || !r.people.every(personOk)) {
      r.people = capPeople(r.people.map(parsePerson).filter((p): p is TgPerson => p !== null));
    }
    if (r.coins.length > TG_LIMITS.coins || !r.coins.every((c) => isObj(c) && typeof c.address === "string")) {
      r.coins = capCoins(r.coins.map(parseCoin).filter((c): c is TgCoinMemo => c !== null));
    }
  }

  /**
   * Schedule the debounced write. Coalescing, not resetting: the first change
   * starts the clock and later ones ride along, so a chat that never pauses
   * still gets written every `debounceMs` instead of never.
   */
  private touch(): void {
    this.dirty = true;
    if (this.closed) {
      this.write();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /**
   * Temp file + fsync + rename: a reader (the ferry, or this store after a
   * crash) sees the old file or the new one, never half of either. Mode 0600
   * like every file in a child home. `durable` also syncs the directory, so the
   * rename itself survives a power cut, for the writes an action waits on.
   * Returns whether the state is on disk.
   */
  private write(opts: { durable?: boolean } = {}): boolean {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const tmp = `${this.file}.tmp`;
    try {
      let json = JSON.stringify(this.s);
      if (Buffer.byteLength(json, "utf8") >= TG_LIMITS.fileBytes && fitToBytes(this.s, TG_LIMITS.fileBytes, this.now())) {
        json = JSON.stringify(this.s);
      }
      const dir = path.dirname(this.file);
      mkdirSync(dir, { recursive: true });
      // A tmp left by a crashed write may have another mode; `mode` below only
      // applies to a file being created.
      rmSync(tmp, { force: true });
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeFileSync(fd, json, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.file);
      if (opts.durable || this.ownsForgets) syncDir(dir);
      this.dirty = false;
      this.warned = false;
      if (this.ownsForgets) this.clearReflectedForgets(dir);
      return true;
    } catch (e) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* nothing more to do */
      }
      if (!this.warned) {
        this.warned = true;
        console.warn(
          `[tg-groups] could not save ${TG_GROUPS_FILE} (${(e as NodeJS.ErrnoException).code ?? "error"}); will retry on the next change`,
        );
      }
      return false;
    }
  }
}

/** Best effort: not every platform lets a directory be opened for fsync. */
function syncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    /* the file itself is already synced */
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}
