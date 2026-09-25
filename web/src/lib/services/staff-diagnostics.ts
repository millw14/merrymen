/**
 * Fleet-wide diagnostics for Merrymen operators, over the shared ledger and
 * the MCP tables.
 *
 * Everything here is an AGGREGATE. An operator needs to know that the fleet is
 * healthy, where executions fail and which providers are erroring; they do not
 * need to know whose agent it is. So an agent appears only as a short one-way
 * hash of its account (the caller supplies the hash, so it matches the
 * pseudonyms in the structured logs), and no address, slug, name, balance,
 * message text, chat id or tenant ever leaves this module. Free text (event
 * messages, free-form reject rules) is reduced to a pattern with numbers,
 * addresses, URLs, ids and quoted text stripped before it is counted; the raw
 * string is never returned, not even as a sample.
 *
 * Read-only: SELECTs over `agents`, `equity`, `trades`, `events`,
 * `mirror_state`, a two-field projection of `grants` (tenant and smart
 * account, never the sealed key or the serialized grant) and the MCP tables.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAddress, isAddress } from "viem";
import type { Db } from "../../../../worker/src/db";
import { REJECT_RULES, rejectRuleLabel } from "@/lib/thesis";
import { blockerView, freshWithin } from "./agent-status";

/** One-way hash that names an agent in staff output. Null for an empty input. */
export type Hasher = (value: string) => string | null;

// ── normalisation ───────────────────────────────────────────────────────────

/**
 * Reduce free text to a pattern that can be counted and shown to staff.
 *
 * Order matters: URLs and e-mail addresses go first (they contain dots and
 * digits the later rules would half-eat), then hex (addresses, hashes,
 * selectors), UUIDs and long id-like runs (API keys, base58 hashes), then
 * quoted text (model output and third-party strings are usually quoted), cash
 * tags, and finally every remaining number (amounts, chat ids, attempt
 * counters, status codes). What is left is the sentence a developer wrote.
 */
/** Longest input normalisePattern reads. Worker and provider messages are unbounded; a pattern needs the head only. */
export const PATTERN_INPUT_MAX = 2000;

/**
 * Producers whose tail is the OWNER'S OWN CONTENT. The Telegram remote-control
 * agent (worker/src/telegram/agent.ts, pc.ts) records, at warn level, the task
 * an owner typed ("task started — <task>"), the files, commands, URLs and
 * keystrokes it used on their machine, and why a task failed. No rule below
 * can tell a sentence an owner wrote from one a developer wrote (a task is
 * plain words), so these keep only the producer's own words.
 */
const OWNER_TAIL = /^(\s*Telegram(?: agent)?: (?:task started|failed|wrote|sent file|opened(?: app| URL)?|pressed|ran(?: shell)?))(?![A-Za-z])[^]*$/i;

export function normalizePattern(text: string | null | undefined, max = 140, scrub?: (s: string) => string): string | null {
  if (typeof text !== "string") return null;
  // Bounded before any regex runs: the name scrubber alone is thousands of
  // alternatives per position.
  let s = text.slice(0, PATTERN_INPUT_MAX).replace(/[\u0000-\u001f\u007f]/g, " ");
  s = s.replace(OWNER_TAIL, "$1 …");
  s = s.replace(/\b(?:https?|wss?):\/\/[^\s"'<>)\]]+/gi, "<url>");
  s = s.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>");
  // Telegram / X handles: an owner's (or a stranger's) account name.
  s = s.replace(/(?<![\w.@<])@[A-Za-z0-9_]{2,32}\b/g, "@<handle>");
  s = s.replace(/\b(?:[a-z0-9-]+\.)+(?:com|io|dev|net|org|xyz|app|ai|co|sh|cloud|network|gg|so|tech|finance|eth)\b(?::\d+)?(?:\/[^\s"'<>)\]]*)?/gi, "<host>");
  s = s.replace(/0x[0-9a-fA-F]+/g, "<hex>");
  s = s.replace(/\brh:[A-Za-z0-9_-]+/g, "<account>");
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>");
  s = s.replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{16,}\b/g, "<id>");
  // Quoted text, paired first. The input is bounded, so the runs need no cap;
  // a capped run let a long quotation through whole.
  s = s.replace(/"[^"]*"|“[^”]*”|‘[^’]*’|(?<![A-Za-z])'[^']{1,400}'(?![A-Za-z])|`[^`]*`/g, "<text>");
  // An opening quote with no partner (the message was cut, by us or by the
  // producer) quotes to the end: drop the rest rather than echo it.
  s = s.replace(/["“`][^]*$/, "<text>");
  if (scrub) s = scrub(s);
  s = s.replace(/\$[A-Za-z][A-Za-z0-9._-]{0,19}/g, () => "$<sym>");
  // A sign is kept with the number only where it cannot be a hyphen
  // ("chat -100…", not "no-gas-2"); digits glued to letters go too.
  s = s.replace(/(?:(?<=^|[\s(\[=:,])[-+])?\d+(?:[,_]\d{3})*(?:\.\d+)?(?:e[-+]?\d+)?/gi, "<n>");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Replace the fleet's agent names with <name>. A name is something an owner
 * typed and worker messages sometimes include it; the rules above cannot know
 * a word is a name, so the names themselves are the list. Names shorter than
 * three characters are skipped (they would eat ordinary words).
 */
export function nameScrubber(names: readonly (string | null | undefined)[]): ((s: string) => string) | undefined {
  const list = [...new Set(names.filter((n): n is string => typeof n === "string").map((n) => n.trim()).filter((n) => n.length >= 3))]
    .sort((a, b) => b.length - a.length)
    .slice(0, 2000)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!list.length) return undefined;
  const re = new RegExp(`(?<![A-Za-z0-9])(?:${list.join("|")})(?![A-Za-z0-9])`, "gi");
  return (s) => s.replace(re, "<name>");
}

/**
 * The fleet's agent names, for nameScrubber. Bounded. A failed read PROPAGATES:
 * the names are what keeps an owner-chosen name out of the patterns, so a read
 * error must fail the call rather than publish unscrubbed text. (`agents` is
 * created with `events` and `trades` by the same schema, so there is no
 * legitimate "no agents table" case here.)
 */
async function readAgentNames(db: Db): Promise<string[]> {
  const rows = await db.prepare("SELECT DISTINCT name FROM agents WHERE name IS NOT NULL LIMIT 5000").all() as Array<{ name: string | null }>;
  return rows.map((r) => r.name).filter((n): n is string => typeof n === "string");
}

const CODE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
/** "couldn't submit: <raw error>", "preflight: …", "paper: …", "review: <model reason>". */
const PREFIXED = /^([a-z][a-z' ]{0,30}[a-z]):\s*\S/i;

/**
 * A reject rule as a countable key. Rules from the product's vocabulary are
 * kebab-case slugs and pass through; the few producers that append free text
 * (a bundler exception, a model's review reason) are collapsed to their
 * prefix, because the tail is unbounded and may quote a provider URL or a
 * third party's words. Anything else is pattern-normalised.
 */
export function normalizeRule(rule: string | null | undefined, scrub?: (s: string) => string): string | null {
  if (typeof rule !== "string") return null;
  const r = rule.trim();
  if (!r) return null;
  if (r.length <= 48 && CODE.test(r)) return r;
  // Names first, so an owner-chosen name can never survive as a "prefix".
  const scrubbed = scrub ? scrub(r) : r;
  const m = PREFIXED.exec(scrubbed);
  if (m) return `${m[1]!.toLowerCase()}: …`;
  return normalizePattern(scrubbed, 60);
}

const KNOWN_REJECT_RULES = new Set(REJECT_RULES);

// ── small helpers ───────────────────────────────────────────────────────────

const iso = (sec: number) => new Date(sec * 1000).toISOString();

function isoOrNull(sec: number | null | undefined): string | null {
  return typeof sec === "number" && Number.isFinite(sec) && sec > 0 ? iso(sec) : null;
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i]!;
}

/** The spellings an account's rows may carry: the mirror copies agent_id as the child wrote it. */
function spellings(raw: string): string[] {
  const lower = raw.toLowerCase();
  const out = new Set([raw, lower]);
  if (isAddress(lower, { strict: false })) out.add(getAddress(lower));
  return [...out];
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("aborted");
}

const STATUSES = ["armed", "active", "killed", "expired", "error"] as const;
const MODES = ["paper", "live", "idle"] as const;
type StatusKey = (typeof STATUSES)[number] | "unknown";
type ModeKey = (typeof MODES)[number] | "unknown";

const statusOf = (s: unknown): StatusKey => (STATUSES as readonly string[]).includes(String(s)) ? (s as StatusKey) : "unknown";
const modeOf = (m: unknown): ModeKey => (MODES as readonly string[]).includes(String(m)) ? (m as ModeKey) : "unknown";

// ── fleet health ────────────────────────────────────────────────────────────

export interface FleetHealthOptions {
  now: number;
  hash: Hasher;
  /** The owner's configured tick in seconds, when known. Null (or a throw) means the default tick. */
  tickFor?: (tenant: `0x${string}`) => Promise<number | null>;
  /** Most agent rows read. */
  limit?: number;
  /** Most distinct owners whose tick is looked up; the rest use the default. */
  tickLookups?: number;
  signal?: AbortSignal;
}

export interface FleetHealth {
  agents: {
    rows_read: number;
    truncated: boolean;
    current: number;
    without_current_grant: number;
    by_status: Record<StatusKey, number>;
    by_mode: Record<ModeKey, number>;
  };
  heartbeat: {
    fresh: number;
    stale: number;
    never_beat: number;
    frozen: { expired: number; killed: number; error: number };
    stale_age_histogram: Array<{ bucket: string; count: number }>;
    tick_seconds: { from_settings: number; defaulted: number; default_fresh_within_s: number };
    stale_agents: Array<{ agent: string | null; heartbeat_age_s: number; fresh_within_s: number; status: StatusKey; mode: ModeKey }>;
    rule: string;
  };
  live_blockers: { none: number; rules: Array<{ rule: string; count: number; is_fault: boolean }> };
  equity_marks: {
    agents_considered: number;
    with_mark: number;
    without_mark: number;
    newest_mark_age_s: number | null;
    median_mark_age_s: number | null;
    oldest_mark_age_s: number | null;
    latest_mark_book: { paper: number; live: number; unknown: number };
    note: string;
  };
  mirror: {
    tables: Array<{ table: string; tenants: number; never_copied: number; lag_s: { min: number | null; median: number | null; p90: number | null; max: number | null } }>;
    /** mirror_state rows of owners with no current grant: no longer mirrored, so their lag only grows. Excluded above. */
    rows_without_current_grant: number;
    note: string;
  } | null;
  observed_at: string;
  warnings: string[];
}

const STALE_BUCKETS: Array<[string, number]> = [
  ["<=15m", 900], ["<=1h", 3600], ["<=6h", 21_600], ["<=24h", 86_400], ["<=7d", 604_800], [">7d", Infinity],
];

interface AgentRow {
  smart_account: string;
  status: string | null;
  mode: string | null;
  beat_at: number | string | null;
  live_blocker: string | null;
  expires_at: number | string | null;
}

/**
 * Current accounts from the grants table: tenant → smart account, read through
 * a JSON projection so the sealed session key and the serialized grant never
 * leave the database. Null when the table cannot be read.
 */
async function readCurrentAccounts(db: Db, limit: number): Promise<{ byAccount: Map<string, `0x${string}`>; tenants: Set<string>; truncated: boolean } | null> {
  try {
    const rows = await db.prepare(`SELECT tenant, grant_json->>'smartAccount' AS smart_account FROM grants ORDER BY tenant LIMIT ?`).all(limit + 1) as Array<{ tenant: string; smart_account: string | null }>;
    const byAccount = new Map<string, `0x${string}`>();
    const tenants = new Set<string>();
    for (const r of rows.slice(0, limit)) {
      const account = typeof r.smart_account === "string" ? r.smart_account.toLowerCase() : "";
      const tenant = typeof r.tenant === "string" ? r.tenant.toLowerCase() : "";
      if (!/^0x[0-9a-f]{40}$/.test(tenant)) continue;
      tenants.add(tenant);
      if (account) byAccount.set(account, tenant as `0x${string}`);
    }
    return { byAccount, tenants, truncated: rows.length > limit };
  } catch {
    // No grants table (a fresh database) cannot tell current from retired.
    return null;
  }
}

export async function readFleetHealth(db: Db, o: FleetHealthOptions): Promise<FleetHealth> {
  const limit = o.limit ?? 1000;
  const warnings: string[] = [];
  const raw = await db.prepare(`SELECT smart_account, status, mode, beat_at, live_blocker, expires_at FROM agents ORDER BY smart_account LIMIT ?`).all(limit + 1) as AgentRow[];
  const truncated = raw.length > limit;
  if (truncated) warnings.push(`More than ${limit} agent rows exist; only the first ${limit} were read.`);

  // The mirror keys agents on the account as the child spelled it; fold
  // spellings so one account is one agent, keeping the newest heartbeat.
  const byAccount = new Map<string, AgentRow>();
  for (const r of raw.slice(0, limit)) {
    const key = String(r.smart_account).toLowerCase();
    const prev = byAccount.get(key);
    if (!prev || (num(r.beat_at) ?? 0) > (num(prev.beat_at) ?? 0)) byAccount.set(key, r);
  }

  const grants = await readCurrentAccounts(db, limit * 2);
  const current = grants?.byAccount ?? null;
  if (!grants) warnings.push("The grants table could not be read, so every agent row is treated as current (retired accounts may inflate the stale count).");
  else if (grants.truncated) warnings.push(`More than ${limit * 2} grants exist; agents beyond them are counted as without a current grant.`);

  const byStatus: Record<StatusKey, number> = { armed: 0, active: 0, killed: 0, expired: 0, error: 0, unknown: 0 };
  const byMode: Record<ModeKey, number> = { paper: 0, live: 0, idle: 0, unknown: 0 };
  const frozen = { expired: 0, killed: 0, error: 0 };
  let fresh = 0, stale = 0, neverBeat = 0, nonCurrent = 0, currentCount = 0, tickKnown = 0, tickDefaulted = 0, noBlocker = 0;
  const staleAges: number[] = [];
  const staleAgents: FleetHealth["heartbeat"]["stale_agents"] = [];
  const blockers = new Map<string, { count: number; is_fault: boolean }>();
  const ticks = new Map<string, number | null>();
  const tickLookups = o.tickLookups ?? 200;
  const marks: Array<{ age: number; book: "paper" | "live" | "unknown" }> = [];
  let considered = 0;

  for (const [account, r] of byAccount) {
    checkAborted(o.signal);
    const tenant = current?.get(account) ?? null;
    if (current && !tenant) {
      // A retired account (the owner re-signed onto a new one) or a grant the
      // kill switch removed: its row stops updating by design.
      nonCurrent += 1;
      continue;
    }
    currentCount += 1;
    const status = statusOf(r.status);
    const mode = modeOf(r.mode);
    byStatus[status] += 1;
    byMode[mode] += 1;

    // After expiry, a kill or an arm error the worker stops publishing, so
    // beat_at and live_blocker freeze where they were. That is not a stale
    // worker, and counting it as one hides the agents that really are wedged.
    const expiresAt = num(r.expires_at);
    const frozenWhy = status === "expired" || (expiresAt !== null && expiresAt > 0 && expiresAt <= o.now) ? "expired"
      : status === "killed" ? "killed" : status === "error" ? "error" : null;
    if (frozenWhy) {
      frozen[frozenWhy] += 1;
      continue;
    }

    let tick: number | null = null;
    if (tenant && o.tickFor) {
      if (!ticks.has(tenant) && ticks.size < tickLookups) {
        ticks.set(tenant, await o.tickFor(tenant).then((t) => (typeof t === "number" && t > 0 ? t : null), () => null));
      }
      tick = ticks.get(tenant) ?? null;
    }
    if (tick === null) tickDefaulted += 1;
    else tickKnown += 1;
    const within = freshWithin(tick);

    const beat = num(r.beat_at);
    if (beat === null || beat <= 0) {
      neverBeat += 1;
    } else {
      const age = Math.max(0, o.now - beat);
      if (age <= within) fresh += 1;
      else {
        stale += 1;
        staleAges.push(age);
        staleAgents.push({ agent: o.hash(account), heartbeat_age_s: age, fresh_within_s: within, status, mode });
      }
    }

    if (!r.live_blocker) noBlocker += 1;
    else {
      const v = blockerView(r.live_blocker)!;
      const rule = CODE.test(v.rule) ? v.rule : "other";
      const b = blockers.get(rule) ?? { count: 0, is_fault: v.is_fault };
      b.count += 1;
      blockers.set(rule, b);
    }

    // The newest equity mark is the best evidence of a completed cycle (a
    // heartbeat is written at tick START). Indexed lookup per spelling.
    considered += 1;
    const sp = spellings(r.smart_account);
    const mark = await db.prepare(`SELECT at, mode FROM equity WHERE agent_id IN (${sp.map(() => "?").join(", ")}) ORDER BY at DESC LIMIT 1`).get(...sp) as { at: number | string; mode: string | null } | undefined;
    const at = num(mark?.at);
    if (at !== null) marks.push({ age: Math.max(0, o.now - at), book: mark?.mode === "paper" || mark?.mode === "live" ? mark.mode : "unknown" });
  }

  const histogram = STALE_BUCKETS.map(([bucket]) => ({ bucket, count: 0 }));
  for (const age of staleAges) {
    const i = STALE_BUCKETS.findIndex(([, max]) => age <= max);
    histogram[i === -1 ? histogram.length - 1 : i]!.count += 1;
  }
  staleAgents.sort((a, b) => b.heartbeat_age_s - a.heartbeat_age_s);

  const ages = marks.map((m) => m.age).sort((a, b) => a - b);
  const book = { paper: 0, live: 0, unknown: 0 };
  for (const m of marks) book[m.book] += 1;

  return {
    agents: { rows_read: Math.min(raw.length, limit), truncated, current: currentCount, without_current_grant: nonCurrent, by_status: byStatus, by_mode: byMode },
    heartbeat: {
      fresh,
      stale,
      never_beat: neverBeat,
      frozen,
      stale_age_histogram: histogram,
      tick_seconds: { from_settings: tickKnown, defaulted: tickDefaulted, default_fresh_within_s: freshWithin(null) },
      stale_agents: staleAgents.slice(0, 20),
      rule: "Fresh = heartbeat younger than max(180 s, 2 × tick + 90 s), the orchestrator watchdog's rule, with the owner's tick when set and the default otherwise. The heartbeat is written at tick start and freezes when an agent expires, is killed or fails to arm, so those count as frozen, not stale.",
    },
    live_blockers: {
      none: noBlocker,
      rules: [...blockers].map(([rule, b]) => ({ rule, count: b.count, is_fault: b.is_fault })).sort((a, b) => b.count - a.count),
    },
    equity_marks: {
      agents_considered: considered,
      with_mark: marks.length,
      without_mark: considered - marks.length,
      newest_mark_age_s: ages[0] ?? null,
      median_mark_age_s: quantile(ages, 0.5),
      oldest_mark_age_s: ages.length ? ages[ages.length - 1]! : null,
      latest_mark_book: book,
      note: "Current agents that are not frozen. An equity mark is written only after a complete valuation, so its age is how long since the last successful cycle; paper and live marks are counted by the book of each agent's latest mark.",
    },
    mirror: await readMirrorLag(db, o.now, warnings, grants?.tenants ?? null),
    observed_at: iso(o.now),
    warnings,
  };
}

const MIRROR_ROWS_MAX = 20_000;

/**
 * Lag per mirrored table, over owners with a CURRENT grant only. The
 * orchestrator mirrors only tenants it runs a child for; once a grant is gone
 * (kill switch, departed owner) its mirror_state rows stay behind with an
 * updated_at that never moves again, so counting them would pin max and p90
 * at "weeks" for good and hide a live stall. `currentTenants` null (grants
 * unreadable) counts every row; the caller has already warned about that.
 */
async function readMirrorLag(db: Db, now: number, warnings: string[], currentTenants: ReadonlySet<string> | null): Promise<FleetHealth["mirror"]> {
  let rows: Array<{ tenant: string | null; table_name: string; updated_at: number | string | null }>;
  try {
    rows = await db.prepare("SELECT tenant, table_name, updated_at FROM mirror_state ORDER BY table_name, tenant LIMIT ?").all(MIRROR_ROWS_MAX + 1) as typeof rows;
  } catch {
    // The orchestrator creates mirror_state on its first pass; before that
    // there is no lag to report, which is not the same as zero lag. (Any other
    // read failure lands here too, so the warning does not claim which.)
    warnings.push("mirror_state could not be read (the orchestrator has not created it yet, or the read failed), so mirror lag is unknown.");
    return null;
  }
  if (rows.length > MIRROR_ROWS_MAX) {
    rows = rows.slice(0, MIRROR_ROWS_MAX);
    warnings.push(`More than ${MIRROR_ROWS_MAX} mirror_state rows exist; only the first ${MIRROR_ROWS_MAX} were read.`);
  }
  let withoutGrant = 0;
  const byTable = new Map<string, { tenants: number; never: number; lags: number[] }>();
  for (const r of rows) {
    if (currentTenants && !currentTenants.has(String(r.tenant ?? "").toLowerCase())) {
      withoutGrant += 1;
      continue;
    }
    const table = typeof r.table_name === "string" && CODE.test(r.table_name) && r.table_name.length <= 40 ? r.table_name : "other";
    const t = byTable.get(table) ?? { tenants: 0, never: 0, lags: [] };
    t.tenants += 1;
    const at = num(r.updated_at);
    if (at === null || at <= 0) t.never += 1;
    else t.lags.push(Math.max(0, now - at));
    byTable.set(table, t);
  }
  return {
    tables: [...byTable].map(([table, t]) => {
      const lags = t.lags.sort((a, b) => a - b);
      return {
        table,
        tenants: t.tenants,
        never_copied: t.never,
        lag_s: { min: lags[0] ?? null, median: quantile(lags, 0.5), p90: quantile(lags, 0.9), max: lags.length ? lags[lags.length - 1]! : null },
      };
    }),
    rows_without_current_grant: withoutGrant,
    note: "Lag is now minus mirror_state.updated_at per owner and table, over owners with a current grant (rows of owners without one are no longer mirrored and are counted in rows_without_current_grant instead). The cursor advances only when rows were copied, so a quiet agent shows a large lag on its log tables without anything being wrong; a large lag on a busy table (trades, equity) is the signal.",
  };
}

// ── execution failures ──────────────────────────────────────────────────────

const TRADE_STATUSES = ["landed", "paper", "submitted", "rejected", "reverted"] as const;
type TradeStatusKey = (typeof TRADE_STATUSES)[number] | "other";
const tradeStatusOf = (s: unknown): TradeStatusKey => (TRADE_STATUSES as readonly string[]).includes(String(s)) ? (s as TradeStatusKey) : "other";

/** Which book a trade status belongs to. A rejection never reached a book: it was refused before anything was sent. */
const BOOK_OF: Record<TradeStatusKey, "live" | "paper" | "none" | "unknown"> = {
  landed: "live", submitted: "live", reverted: "live", paper: "paper", rejected: "none", other: "unknown",
};

/** The mirror re-reads a submitted operation's outcome for this long (ledger-mirror.ts RESYNC_WINDOW_SEC). */
export const RESYNC_WINDOW_SEC = 6 * 3600;
export const UNRECONCILED_AFTER_SEC = 30 * 60;

/** Characters of a reject rule grouped on and read back. Enough for every prefix and the normalised head. */
const RULE_READ_CHARS = 200;
/** Characters of an event message read back. */
const MESSAGE_READ_CHARS = 1000;

export interface ExecutionFailures {
  window_hours: number;
  since: string;
  by_status: Array<{ status: TradeStatusKey; book: "live" | "paper" | "none" | "unknown"; count: number; with_tx_hash: number }>;
  by_rule: Array<{ status: TradeStatusKey; rule: string; known: boolean; label: string | null; count: number }>;
  reverted_by_rule: Array<{ rule: string; known: boolean; label: string | null; count: number }>;
  rules_complete: boolean;
  unreconciled: {
    older_than_s: number;
    operations: number;
    rows: number;
    oldest_age_s: number | null;
    beyond_resync_window_operations: number;
    agents_total: number;
    agents: Array<{ agent: string | null; operations: number; oldest_age_s: number }>;
    note: string;
  };
  observed_at: string;
  notes: string[];
}

export async function readExecutionFailures(db: Db, o: { now: number; windowHours: number; hash: Hasher; ruleGroupLimit?: number; signal?: AbortSignal }): Promise<ExecutionFailures> {
  const since = o.now - o.windowHours * 3600;
  const statusRows = await db.prepare(`SELECT status, COUNT(*) AS n, COUNT(reject_rule) AS with_rule, COUNT(tx_hash) AS with_tx FROM trades WHERE created_at > ? GROUP BY status LIMIT 100`).all(since) as Array<{ status: string; n: number | string; with_rule: number | string; with_tx: number | string }>;
  const byStatus = new Map<TradeStatusKey, { n: number; withRule: number; withTx: number }>(TRADE_STATUSES.map((s) => [s, { n: 0, withRule: 0, withTx: 0 }]));
  byStatus.set("other", { n: 0, withRule: 0, withTx: 0 });
  for (const r of statusRows) {
    const s = byStatus.get(tradeStatusOf(r.status))!;
    s.n += num(r.n) ?? 0;
    s.withRule += num(r.with_rule) ?? 0;
    s.withTx += num(r.with_tx) ?? 0;
  }
  checkAborted(o.signal);

  // Grouped in SQL by the head of the rule, then collapsed here: free-form
  // rules have unbounded cardinality (and length: a bundler exception runs to
  // kilobytes), so only the head is read and the cap can drop some tail
  // groups. rules_complete says whether every rule-bearing row was attributed.
  const ruleRows = await db.prepare(`SELECT status, substr(reject_rule, 1, ${RULE_READ_CHARS}) AS reject_rule, COUNT(*) AS n FROM trades
    WHERE created_at > ? AND reject_rule IS NOT NULL
    GROUP BY status, substr(reject_rule, 1, ${RULE_READ_CHARS}) ORDER BY n DESC LIMIT ?`).all(since, o.ruleGroupLimit ?? 5000) as Array<{ status: string; reject_rule: string; n: number | string }>;
  const scrub = nameScrubber(await readAgentNames(db));
  const rules = new Map<string, { status: TradeStatusKey; rule: string; count: number }>();
  let attributed = 0;
  for (const r of ruleRows) {
    const status = tradeStatusOf(r.status);
    const rule = normalizeRule(r.reject_rule, scrub) ?? "other";
    const n = num(r.n) ?? 0;
    attributed += n;
    const key = `${status}\u0000${rule}`;
    const e = rules.get(key) ?? { status, rule, count: 0 };
    e.count += n;
    rules.set(key, e);
  }
  const withRuleTotal = [...byStatus.values()].reduce((a, s) => a + s.withRule, 0);
  const describe = (rule: string) => ({ known: KNOWN_REJECT_RULES.has(rule), label: rejectRuleLabel(rule) });
  const sortedRules = [...rules.values()].sort((a, b) => b.count - a.count);
  checkAborted(o.signal);

  // Operations, not rows: one operation can write several trade rows (the
  // worker's own and the reconciler's copy), and the mirror carries both the
  // account and the hash in whatever case the child wrote them, so both are
  // folded to lowercase IN SQL: grouping by the raw spelling counted one
  // operation once per spelling. A row without a user-op hash is its own
  // operation.
  const pending = await db.prepare(`SELECT lower(agent_id) AS agent_id, COUNT(*) AS n,
      COUNT(DISTINCT COALESCE(lower(user_op_hash), 'row:' || CAST(id AS TEXT))) AS ops,
      COUNT(DISTINCT CASE WHEN created_at < ? THEN COALESCE(lower(user_op_hash), 'row:' || CAST(id AS TEXT)) END) AS beyond,
      MIN(created_at) AS oldest
    FROM trades WHERE status = 'submitted' AND created_at < ? GROUP BY lower(agent_id) LIMIT 5000`).all(o.now - RESYNC_WINDOW_SEC, o.now - UNRECONCILED_AFTER_SEC) as Array<{ agent_id: string; n: number | string; ops: number | string; beyond: number | string; oldest: number | string }>;
  const perAgent = new Map<string, { ops: number; oldest: number }>();
  let rows = 0, ops = 0, beyond = 0, oldest: number | null = null;
  for (const r of pending) {
    const key = String(r.agent_id);
    const first = num(r.oldest) ?? o.now;
    const n = num(r.ops) ?? 0;
    rows += num(r.n) ?? 0;
    ops += n;
    beyond += num(r.beyond) ?? 0;
    oldest = oldest === null ? first : Math.min(oldest, first);
    const a = perAgent.get(key) ?? { ops: 0, oldest: first };
    a.ops += n;
    a.oldest = Math.min(a.oldest, first);
    perAgent.set(key, a);
  }
  const agents = [...perAgent]
    .map(([account, a]) => ({ agent: o.hash(account), operations: a.ops, oldest_age_s: Math.max(0, o.now - a.oldest) }))
    .sort((a, b) => b.operations - a.operations || b.oldest_age_s - a.oldest_age_s);

  return {
    window_hours: o.windowHours,
    since: iso(since),
    by_status: [...byStatus].map(([status, s]) => ({ status, book: BOOK_OF[status], count: s.n, with_tx_hash: s.withTx })),
    by_rule: sortedRules.slice(0, 60).map((r) => ({ status: r.status, rule: r.rule, ...describe(r.rule), count: r.count })),
    reverted_by_rule: sortedRules.filter((r) => r.status === "reverted").slice(0, 60).map((r) => ({ rule: r.rule, ...describe(r.rule), count: r.count })),
    rules_complete: attributed >= withRuleTotal,
    unreconciled: {
      older_than_s: UNRECONCILED_AFTER_SEC,
      operations: ops,
      rows,
      oldest_age_s: oldest === null ? null : Math.max(0, o.now - oldest),
      beyond_resync_window_operations: beyond,
      agents_total: agents.length,
      agents: agents.slice(0, 25),
      note: "Live operations still 'submitted' more than 30 minutes after they were recorded, across the whole ledger (not just the window). The mirror re-reads a submitted operation's outcome for 6 hours; past that it stays 'submitted' in the shared ledger even if it landed or reverted on chain, so check the chain before calling one lost.",
    },
    observed_at: iso(o.now),
    notes: [
      "Only a 'landed' row that carries a tx hash (with_tx_hash) is a confirmed live trade. 'submitted' is sent and unresolved, 'reverted' reached the chain and failed (gas spent), 'rejected' was refused before anything was sent, and 'paper' is a simulated fill in the paper book.",
      "Free-form rules are collapsed to their prefix (\"couldn't submit: …\"); the raw error text is never returned.",
    ],
  };
}

// ── provider errors ─────────────────────────────────────────────────────────

export interface ProviderErrors {
  window_hours: number;
  since: string;
  totals: { warn: number; err: number };
  scanned: number;
  complete: boolean;
  patterns: Array<{ level: "warn" | "err"; pattern: string; count: number; agents: number; first_at: string | null; last_at: string | null }>;
  pattern_groups_total: number;
  observed_at: string;
}

/**
 * COST: `events` has no index on created_at alone (events_agent_time leads on
 * agent_id), so both queries below scan the table. The tool's budget is sized
 * for that; a fleet-wide `events (created_at)` index in store.ts's ALTER list
 * would make it a range read.
 */
export async function readProviderErrors(db: Db, o: { now: number; windowHours: number; scanLimit?: number; signal?: AbortSignal }): Promise<ProviderErrors> {
  const since = o.now - o.windowHours * 3600;
  const scanLimit = o.scanLimit ?? 5000;
  const totalsRows = await db.prepare(`SELECT level, COUNT(*) AS n FROM events WHERE level IN ('warn', 'err') AND created_at > ? GROUP BY level`).all(since) as Array<{ level: string; n: number | string }>;
  const totals = { warn: 0, err: 0 };
  for (const r of totalsRows) if (r.level === "warn" || r.level === "err") totals[r.level] += num(r.n) ?? 0;
  checkAborted(o.signal);

  // Only the head of each message is read: raw provider errors can run to
  // kilobytes, and nothing past the pattern's own length is ever shown.
  const rows = await db.prepare(`SELECT agent_id, level, substr(message, 1, ${MESSAGE_READ_CHARS}) AS message, created_at FROM events
    WHERE level IN ('warn', 'err') AND created_at > ? ORDER BY created_at DESC LIMIT ?`).all(since, scanLimit) as Array<{ agent_id: string; level: "warn" | "err"; message: string; created_at: number | string }>;
  const scrub = nameScrubber(await readAgentNames(db));
  const groups = new Map<string, { level: "warn" | "err"; pattern: string; count: number; agents: Set<string>; first: number; last: number }>();
  for (const r of rows) {
    const pattern = normalizePattern(r.message, 140, scrub) ?? "(empty)";
    const level = r.level === "err" ? "err" : "warn";
    const at = num(r.created_at) ?? 0;
    const key = `${level}\u0000${pattern}`;
    const g = groups.get(key) ?? { level, pattern, count: 0, agents: new Set<string>(), first: at, last: at };
    g.count += 1;
    g.agents.add(String(r.agent_id).toLowerCase());
    g.first = Math.min(g.first, at);
    g.last = Math.max(g.last, at);
    groups.set(key, g);
  }
  const patterns = [...groups.values()].sort((a, b) => b.count - a.count || b.last - a.last);
  return {
    window_hours: o.windowHours,
    since: iso(since),
    totals,
    scanned: rows.length,
    complete: rows.length >= totals.warn + totals.err,
    patterns: patterns.slice(0, 60).map((g) => ({
      level: g.level, pattern: g.pattern, count: g.count, agents: g.agents.size, first_at: isoOrNull(g.first), last_at: isoOrNull(g.last),
    })),
    pattern_groups_total: patterns.length,
    observed_at: iso(o.now),
  };
}

// ── deployment ──────────────────────────────────────────────────────────────

/**
 * The root package's version. Same lookup as /api/version (the web process
 * runs with cwd = web/, so the root manifest is one level up), plus the cwd
 * itself for processes started at the repo root. Only a manifest named
 * "merrymen" counts, so a stray package.json is never reported as ours.
 */
export async function readPackageVersion(cwd: string = process.cwd()): Promise<string | null> {
  for (const file of [join(cwd, "..", "package.json"), join(cwd, "package.json")]) {
    try {
      const pkg = JSON.parse(await readFile(file, "utf8")) as { name?: unknown; version?: unknown };
      if (pkg.name === "merrymen" && typeof pkg.version === "string" && /^\d+\.\d+\.\d+[\w.+-]{0,40}$/.test(pkg.version)) return pkg.version;
    } catch {
      /* try the next location */
    }
  }
  return null;
}

export interface DeploymentInputs {
  env: Record<string, string | undefined>;
  serverVersion: string;
  packageVersion: string | null;
  uptimeSec: number;
  nodeVersion: string;
  now: number;
  mcp: { enabled: boolean; disabledWhy: string | null; issuer: string; resource: string };
}

export interface Deployment {
  mcp_server_version: string;
  package_version: string | null;
  commit: string | null;
  node_version: string;
  process_started_at: string;
  uptime_s: number;
  mcp: { enabled: boolean; disabled_why: string | null; issuer: string | null; resource: string | null };
  observed_at: string;
  warnings: string[];
}

export function describeDeployment(i: DeploymentInputs): Deployment {
  const sha = (i.env.RAILWAY_GIT_COMMIT_SHA ?? "").trim().toLowerCase();
  const commit = /^[0-9a-f]{7,64}$/.test(sha) ? sha.slice(0, 12) : null;
  const uptime = Math.max(0, Math.floor(i.uptimeSec));
  const warnings: string[] = [];
  if (!commit) warnings.push("RAILWAY_GIT_COMMIT_SHA is not set (not a Railway build, or the variable was not exposed), so the commit is unknown.");
  if (!i.packageVersion) warnings.push("The root package.json could not be read, so the package version is unknown.");
  return {
    mcp_server_version: i.serverVersion,
    package_version: i.packageVersion,
    commit,
    node_version: i.nodeVersion,
    process_started_at: iso(i.now - uptime),
    uptime_s: uptime,
    mcp: { enabled: i.mcp.enabled, disabled_why: i.mcp.disabledWhy, issuer: i.mcp.issuer || null, resource: i.mcp.resource || null },
    observed_at: iso(i.now),
    warnings,
  };
}

// ── MCP usage (the MCP tables, no tenants) ──────────────────────────────────

export interface McpUsage {
  audit_24h: Array<{ action: string; outcome: string; count: number }>;
  audit_24h_total: number;
  connections: { active: number; oauth: number; personal: number; owners: number; used_24h: number };
  clients: Array<{ kind: string; count: number }>;
}

const AUDIT_KEY = /^[a-z0-9_.:-]{1,80}$/i;

/** COST: mcp_audit is indexed by (tenant, at) and (connection_id, at) only, so the fleet-wide 24 h count scans it. */
export async function readMcpUsage(db: Db, o: { now: number }): Promise<McpUsage> {
  const since = o.now - 86_400;
  const audit = await db.prepare(`SELECT action, outcome, COUNT(*) AS n FROM mcp_audit WHERE at > ? GROUP BY action, outcome ORDER BY n DESC LIMIT 300`).all(since) as Array<{ action: string; outcome: string; n: number | string }>;
  const auditTotal = await db.prepare("SELECT COUNT(*) AS n FROM mcp_audit WHERE at > ?").get(since) as { n: number | string };
  const conns = await db.prepare(`SELECT kind, COUNT(*) AS n, COUNT(DISTINCT tenant) AS owners, SUM(CASE WHEN last_used_at > ? THEN 1 ELSE 0 END) AS used
    FROM mcp_connections WHERE status = 'active' GROUP BY kind`).all(since) as Array<{ kind: string; n: number | string; owners: number | string; used: number | string | null }>;
  const owners = await db.prepare("SELECT COUNT(DISTINCT tenant) AS n FROM mcp_connections WHERE status = 'active'").get() as { n: number | string };
  const clients = await db.prepare("SELECT kind, COUNT(*) AS n FROM mcp_clients GROUP BY kind ORDER BY kind LIMIT 20").all() as Array<{ kind: string; n: number | string }>;

  const merged = new Map<string, { action: string; outcome: string; count: number }>();
  for (const r of audit) {
    const action = AUDIT_KEY.test(String(r.action)) ? String(r.action) : "other";
    const outcome = AUDIT_KEY.test(String(r.outcome)) ? String(r.outcome) : "other";
    const key = `${action}\u0000${outcome}`;
    const e = merged.get(key) ?? { action, outcome, count: 0 };
    e.count += num(r.n) ?? 0;
    merged.set(key, e);
  }
  const connections = { active: 0, oauth: 0, personal: 0, owners: num(owners.n) ?? 0, used_24h: 0 };
  for (const c of conns) {
    const n = num(c.n) ?? 0;
    connections.active += n;
    connections.used_24h += num(c.used) ?? 0;
    if (c.kind === "personal") connections.personal += n;
    else connections.oauth += n;
  }
  return {
    audit_24h: [...merged.values()].sort((a, b) => b.count - a.count),
    audit_24h_total: num(auditTotal.n) ?? 0,
    connections,
    clients: [...clients.reduce((m, c) => {
      const kind = c.kind === "cimd" || c.kind === "dcr" ? c.kind : "other";
      return m.set(kind, (m.get(kind) ?? 0) + (num(c.n) ?? 0));
    }, new Map<string, number>())].map(([kind, count]) => ({ kind, count })),
  };
}
