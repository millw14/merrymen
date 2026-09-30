/**
 * OWNER-LOCAL TIME FOR THE GROUP CHAT — what hour it is for an agent's owner,
 * when that agent goes quiet, and what "today" means for it.
 *
 * WHY THE OWNER'S CLOCK AND NOT THE SERVER'S. Hosted runs in UTC. An agent that
 * says "gm" at 07:00 UTC is greeting a New York owner at 02:00, and a room that
 * sleeps on UTC goes dark for everyone at once. So every question here takes
 * the owner's IANA zone and hands it to Intl, which lets ICU do the DST
 * arithmetic. Nothing here computes an offset by hand, and nothing reads the
 * process clock: `nowMs` is always a parameter, so the tests are exact.
 *
 * UNKNOWN ZONE = NEVER SLEEPS. A null zone is not "UTC": guessing would invent a
 * fact about the owner, and defaulting everyone to one zone is the synchronised
 * blackout this module exists to avoid. `isAsleep(null, …)` is false; `phaseOf`
 * answers null so no template claims a time of day it does not know.
 *
 * THE SLEEP KEY IS THE LOWERCASED TENANT, on every side (conductor,
 * /api/groupchat/me, the screen). Two sides keying differently would show an
 * owner one set of quiet hours and run another. `sleepWindow` lowercases the key
 * itself too, so a caller that forgets cannot split the two.
 *
 * NOT A TRADING INPUT. The room is chat only; nothing here is read by any path
 * that decides a trade. An asleep agent keeps trading — it only stops talking.
 *
 * Pure: no I/O, no randomness. The only state is a bounded cache of formatters,
 * which changes speed, never answers.
 */

import { fnv1a } from "../memory/tokens";

const DAY_MIN = 1440;

/** IANA names are ASCII letters, digits, `_`, `+`, `-` and `/`. The longest real one is ~32 chars. */
const TZ_SHAPE = /^[A-Za-z0-9_+\-\/]+$/;
const TZ_MAX = 64;

/** The fleet's nominal quiet hours, before each agent's own jitter. */
const SLEEP_START = 23 * 60;
const SLEEP_END = 7 * 60;
/** Each end moves independently by up to this many minutes either way. */
const JITTER = 75;
const JITTER_SPAN = 2 * JITTER + 1;

/**
 * ONE FORMATTER PER ZONE, BOUNDED. Building an Intl.DateTimeFormat is the
 * expensive part (ICU loads the zone's rules), and the conductor asks about
 * every member every pass. The key is whatever string the caller passed, so
 * case variants of one zone are separate entries; the cap stops a stream of
 * distinct inputs from growing the map without limit. A rejected zone is cached
 * as null — ICU's zone table does not change while the process runs.
 */
const FORMATS = new Map<string, Intl.DateTimeFormat | null>();
const FORMATS_CAP = 512;

function shapeOk(tz: string): boolean {
  return tz.length > 0 && tz.length <= TZ_MAX && TZ_SHAPE.test(tz);
}

/**
 * The formatter for a zone, or null when the zone is not one canonicalTz would
 * accept. Every function in this file goes through here, so a zone that cannot
 * be stored can never quietly put an agent to sleep either.
 */
function zoneFormat(tz: string): Intl.DateTimeFormat | null {
  const hit = FORMATS.get(tz);
  if (hit !== undefined) return hit;
  // SHAPE BEFORE ICU. The string may be straight from a request body; only
  // something that already looks like a zone name reaches Intl or the cache.
  if (!shapeOk(tz)) return null;
  let fmt: Intl.DateTimeFormat | null;
  try {
    // hourCycle "h23", NEVER hour12:false — some engines map hour12:false to
    // h24 and print midnight as "24". The date fields ride along so localDay
    // shares the same cached formatter.
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    });
    // ICU ALSO ACCEPTS BARE OFFSETS ("+0530" resolves to "+05:30"). A fixed
    // offset has no DST and is not an IANA zone, so it is refused here rather
    // than stored as if it were one; the colon fails the shape check.
    if (!shapeOk(fmt.resolvedOptions().timeZone)) fmt = null;
  } catch {
    fmt = null; // RangeError: not a zone ICU knows.
  }
  if (FORMATS.size >= FORMATS_CAP) FORMATS.clear();
  FORMATS.set(tz, fmt);
  return fmt;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  /** Minutes past local midnight, 0..1439. */
  minutes: number;
}

function localParts(fmt: Intl.DateTimeFormat, nowMs: number): LocalParts | null {
  if (!Number.isFinite(nowMs)) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = fmt.formatToParts(nowMs);
  } catch {
    return null; // a finite value past Date's ±8.64e15 range
  }
  let year = NaN;
  let month = NaN;
  let day = NaN;
  let hour = NaN;
  let minute = NaN;
  for (const p of parts) {
    if (p.type === "year") year = Number(p.value);
    else if (p.type === "month") month = Number(p.value);
    else if (p.type === "day") day = Number(p.value);
    else if (p.type === "hour") hour = Number(p.value);
    else if (p.type === "minute") minute = Number(p.value);
  }
  if (![year, month, day, hour, minute].every(Number.isInteger)) return null;
  // % 24 as a belt over hourCycle: an engine that still says "24" means midnight.
  return { year, month, day, minutes: (hour % 24) * 60 + minute };
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/**
 * A stored-safe IANA zone, or null.
 *
 * Aliases are accepted (Asia/Calcutta, US/Eastern) and case is folded
 * ("america/new_york"). The returned spelling is RUNTIME-DEPENDENT: Node 22
 * answers "Asia/Calcutta" for "Asia/Kolkata", while newer engines hand an alias
 * back as given. Both spellings drive the same clock, so a string mismatch
 * between a stored zone and a browser's is not evidence the owner moved.
 */
export function canonicalTz(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const fmt = zoneFormat(raw.trim());
  return fmt ? fmt.resolvedOptions().timeZone : null;
}

/** Minutes past local midnight in `tz` (0..1439), or null when the zone or instant is unusable. */
export function localMinutes(tz: string, nowMs: number): number | null {
  if (typeof tz !== "string") return null;
  const fmt = zoneFormat(tz);
  if (!fmt) return null;
  return localParts(fmt, nowMs)?.minutes ?? null;
}

/**
 * This agent's quiet hours as local minutes: `startMin` inclusive, `endMin`
 * exclusive, wrapping past midnight.
 *
 * STAGGERED ON PURPOSE. A fleet on one 23:00–07:00 window would say "gn" in one
 * burst and "gm" in another. Each end is moved by up to ±75 minutes, and the two
 * moves come from different parts of the hash so a late sleeper is not forced to
 * be a late riser. Deterministic in the key, so the hours an owner sees on the
 * screen are the hours the conductor runs.
 */
export function sleepWindow(key: string): { startMin: number; endMin: number } {
  // fnv1a answers base 36; back to its uint32. That is ~uniform over 2^32 ≫ 151²,
  // so the remainder and the quotient below are independent draws.
  const h = Number.parseInt(fnv1a(String(key).trim().toLowerCase()), 36);
  const startJitter = (h % JITTER_SPAN) - JITTER;
  const endJitter = (Math.floor(h / JITTER_SPAN) % JITTER_SPAN) - JITTER;
  return {
    startMin: mod(SLEEP_START + startJitter, DAY_MIN),
    endMin: mod(SLEEP_END + endJitter, DAY_MIN),
  };
}

/** True while the agent's owner is inside its quiet hours. An unknown or unusable zone is never asleep. */
export function isAsleep(tz: string | null, key: string, nowMs: number): boolean {
  if (!tz) return false;
  const m = localMinutes(tz, nowMs);
  if (m === null) return false;
  const { startMin, endMin } = sleepWindow(key);
  // The window wraps midnight unless the start itself was pushed past 00:00.
  return startMin <= endMin ? m >= startMin && m < endMin : m >= startMin || m < endMin;
}

/**
 * "YYYY-MM-DD" in the owner's zone — the unit of "gm once per local day".
 *
 * UTC when the zone is null or unusable: the day is only a dedupe bucket, and a
 * bucket that exists beats one that throws. A non-finite instant gets
 * "0000-00-00", which can never collide with a real day.
 */
export function localDay(tz: string | null, nowMs: number): string {
  const fmt = (tz ? zoneFormat(tz) : null) ?? zoneFormat("UTC");
  const p = fmt ? localParts(fmt, nowMs) : null;
  if (!p) return "0000-00-00";
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return `${pad(p.year, 4)}-${pad(p.month, 2)}-${pad(p.day, 2)}`;
}

/**
 * The owner's part of the day, for tone only — a template may sound like
 * morning, but never states a time or a place. Null when the zone is unknown.
 */
export function phaseOf(tz: string | null, nowMs: number): "morning" | "day" | "evening" | "night" | null {
  if (!tz) return null;
  const m = localMinutes(tz, nowMs);
  if (m === null) return null;
  if (m >= 5 * 60 && m < 12 * 60) return "morning";
  if (m >= 12 * 60 && m < 17 * 60) return "day";
  if (m >= 17 * 60 && m < 22 * 60) return "evening";
  return "night";
}

/** Local minutes as "HH:MM" (425 → "07:05"), wrapped into one day. */
export function fmtHm(min: number): string {
  if (!Number.isFinite(min)) return "--:--";
  const m = mod(Math.floor(min), DAY_MIN);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
