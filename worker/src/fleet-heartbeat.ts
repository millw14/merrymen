/**
 * ONE ROW THAT SAYS THE FLEET IS ALIVE, AND WHAT IT IS DOING.
 *
 * Everything the orchestrator knows about its own health was in its log: the
 * `fleet:` line, the rails, the autonomy funnel, BROKEN. A log is read by
 * somebody who already suspects a problem, and a process that has died or
 * wedged writes nothing at all — so "is it running, which build, halted or
 * not, and is anything landing" could only be answered by opening the
 * container's log by hand. Which is how a fleet that had stopped could stay
 * stopped unnoticed.
 *
 * So the same snapshot the log prints is also published, every minute, as ONE
 * ROW PER ROLE in `fleet_heartbeat`, and the web serves it to an operator's
 * check behind a token (web/src/app/api/ops/heartbeat). A dead-man check then
 * needs no state of its own: an old `beat_at` IS the alarm.
 *
 * ONE ROW PER ROLE, NOT ONE ROW. The reply-only listener beats beside the
 * orchestrator during a pilot; sharing one row, its beats would hide the
 * orchestrator's silence — the one thing this row exists to show. Each writer
 * overwrites only its own.
 *
 * AGGREGATES ONLY, BY CONSTRUCTION. Counts, enums and a commit hash: no
 * account, no amount, no name, no rule text (an old reject_rule can carry
 * free text). What is written is built from the snapshot field by field
 * (heartbeatCounts), and what is served is rebuilt from the row the same way
 * (publicHeartbeat), so a value nobody meant to publish cannot ride along
 * inside a JSON column.
 *
 * NOTHING HERE TOUCHES THE LEDGER. One operational table, written by the
 * processes that own it; no trade, grant, lease, limit or accounting row is
 * read for writing or written. Best-effort everywhere: a heartbeat that fails
 * to write is a missed beat, never a stopped fleet loop.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { translateSchema, type Db } from "./db";
import type { AutonomyFunnel, FleetRails, RailFunnel } from "./autonomy-funnel";

/**
 * Created by the orchestrator, its first writer. Every other writer (the
 * reply-only listener) only upserts, and skips its beat while the table is
 * missing rather than creating schema from a process that has no business
 * doing so.
 */
export const FLEET_HEARTBEAT_DDL = `CREATE TABLE IF NOT EXISTS fleet_heartbeat (
  role TEXT PRIMARY KEY,
  commit_sha TEXT,
  started_at INTEGER NOT NULL,
  beat_at INTEGER NOT NULL,
  halted INTEGER NOT NULL,
  rollout TEXT,
  counts TEXT,
  last_shutdown TEXT
);`;

/** A minute: well inside the ten an outside check allows before calling a beat stale. */
export const FLEET_HEARTBEAT_EVERY_MS = 60_000;

export type HeartbeatRole = "orchestrator" | "recovery-replies";
const ROLES: ReadonlySet<string> = new Set<HeartbeatRole>(["orchestrator", "recovery-replies"]);

/**
 * WHO THE ROLLOUT ADMITS, AT WHAT LEVEL — counts only, never the tenants.
 * `scope` is the rollout's own name for itself ("none", "all", "3 named").
 * Null when the writer has no rollout to report, which is also what an
 * outside check reads as "no expected-state suppression".
 */
export interface RolloutSummary {
  scope: string;
  levels: Record<string, number>;
}

/**
 * HOW THE PREVIOUS PROCESS ENDED, from the receipt its drain leaves in the
 * home. Null is "no receipt": a first boot of an image that drains, or a
 * previous process that never finished its drain — which an outside check
 * should treat as unclean.
 */
export interface LastShutdown {
  clean: boolean;
  at: number | null;
}

/**
 * WHAT ONE PASS OF THE FLEET LOOKED LIKE: what the `fleet:` and `autonomy|`
 * lines print, and what the heartbeat publishes. Collected by the
 * orchestrator (collectFleetSnapshot). Null fields are reads that FAILED,
 * which is never the same as zero.
 */
export interface FleetSnapshot {
  /** Unix seconds the snapshot was taken at. */
  at: number;
  byStatus: Record<string, number>;
  total: number;
  /** Agents whose status is `error`: what the BROKEN alert counts. */
  broken: number;
  rails: FleetRails | null;
  /** The last hour. */
  funnel: AutonomyFunnel | null;
  holds: { kind: string; n: number | string }[] | null;
  /** The last six hours, when asked for (the heartbeat asks; the log does not). */
  funnel6h: AutonomyFunnel | null;
}

/**
 * A window of the funnel, as published: the per-rail totals, every field a
 * count, with the admission gate's refusals apart from them.
 */
export interface FunnelTotals {
  live: RailFunnel;
  paper: RailFunnel;
  /** rollout-hold and draining refusals: never in the totals above. */
  admissionHeld: number;
}

export interface HeartbeatCounts {
  agents: number;
  byStatus: Record<string, number>;
  broken: number;
  rails: Record<string, number> | null;
  /** Workers and hold processes THIS replica runs. */
  children: number;
  holders: number;
  holds1h: Record<string, number> | null;
  funnel1h: FunnelTotals | null;
  funnel6h: FunnelTotals | null;
}

export interface FleetHeartbeat {
  role: HeartbeatRole;
  commit: string | null;
  startedAt: number;
  beatAt: number;
  halted: boolean;
  rollout: RolloutSummary | null;
  /** Null when the writer could not read the fleet this beat: still a beat. */
  counts: HeartbeatCounts | null;
  lastShutdown: LastShutdown | null;
}

const totalsOf = (f: AutonomyFunnel | null): FunnelTotals | null =>
  f ? { live: { ...f.live }, paper: { ...f.paper }, admissionHeld: f.admissionHeld } : null;

/**
 * THE COUNTS A SNAPSHOT PUBLISHES, field by field. Not the snapshot itself:
 * its funnel carries the refusal RULES, and an old rule can be free text.
 */
export function heartbeatCounts(s: FleetSnapshot, local: { children: number; holders: number }): HeartbeatCounts {
  let holds1h: Record<string, number> | null = null;
  if (s.holds) {
    holds1h = {};
    for (const h of s.holds) holds1h[String(h.kind)] = (holds1h[String(h.kind)] ?? 0) + Number(h.n);
  }
  return {
    agents: s.total,
    byStatus: { ...s.byStatus },
    broken: s.broken,
    rails: s.rails ? { ...s.rails.counts } : null,
    children: local.children,
    holders: local.holders,
    holds1h,
    funnel1h: totalsOf(s.funnel),
    funnel6h: totalsOf(s.funnel6h),
  };
}

/** The deployed commit, as Railway names it; null off Railway or when it is not a hash. */
export function commitOf(env: Record<string, string | undefined>): string | null {
  const sha = (env.RAILWAY_GIT_COMMIT_SHA ?? "").trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/.test(sha) ? sha : null;
}

/** Where a drain leaves its receipt, under the fleet home. */
export const LAST_SHUTDOWN_FILE = path.join("ops", "last-shutdown.json");

/**
 * The receipt's two facts the heartbeat carries, or null. Only `clean` (a
 * boolean) and `at` (unix seconds or ms) are read; anything else the receipt
 * holds stays in the home.
 */
export function lastShutdownOf(value: unknown): LastShutdown | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.clean !== "boolean") return null;
  const at = typeof o.at === "number" && Number.isFinite(o.at) && o.at > 0 ? (o.at > 1e12 ? Math.floor(o.at / 1000) : Math.floor(o.at)) : null;
  return { clean: o.clean, at };
}

/** Read once at boot, before this process can leave a receipt of its own. */
export function readLastShutdown(home: string): LastShutdown | null {
  try {
    const raw = readFileSync(path.join(home, LAST_SHUTDOWN_FILE), "utf8");
    // A receipt is a few lines. Anything larger is not one.
    if (raw.length > 64 * 1024) return null;
    return lastShutdownOf(JSON.parse(raw));
  } catch {
    return null;
  }
}

const missingTable = (error: unknown): boolean => {
  const e = error as { code?: string; message?: string };
  return e?.code === "42P01" || /no such table: (?:main\.)?fleet_heartbeat\b/.test(e?.message ?? "");
};

/**
 * WRITE THIS ROLE'S BEAT. `create` is for the orchestrator alone; without it a
 * missing table is a skipped beat (false), not an error and not new schema.
 *
 * NEVER BACKWARDS: an older beat (a replica that is shutting down while its
 * replacement beats) never overwrites a newer one.
 */
export async function writeFleetHeartbeat(db: Db, hb: FleetHeartbeat, opts: { create: boolean }): Promise<boolean> {
  if (!ROLES.has(hb.role)) throw new Error("Unknown heartbeat role.");
  if (opts.create) await db.exec(translateSchema(FLEET_HEARTBEAT_DDL));
  try {
    await db
      .prepare(
        `INSERT INTO fleet_heartbeat (role, commit_sha, started_at, beat_at, halted, rollout, counts, last_shutdown)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (role) DO UPDATE SET
           commit_sha = excluded.commit_sha, started_at = excluded.started_at, beat_at = excluded.beat_at,
           halted = excluded.halted, rollout = excluded.rollout, counts = excluded.counts,
           last_shutdown = excluded.last_shutdown
         WHERE fleet_heartbeat.beat_at <= excluded.beat_at`,
      )
      .run(
        hb.role,
        hb.commit,
        hb.startedAt,
        hb.beatAt,
        hb.halted ? 1 : 0,
        hb.rollout ? JSON.stringify(hb.rollout) : null,
        hb.counts ? JSON.stringify(hb.counts) : null,
        hb.lastShutdown ? JSON.stringify(hb.lastShutdown) : null,
      );
    return true;
  } catch (error) {
    if (!opts.create && missingTable(error)) return false;
    throw error;
  }
}

// ── READ SIDE (the web's ops route) ─────────────────────────────────────────

/** What an operator's check is served: the row, rebuilt from known fields only. */
export interface PublicHeartbeat {
  role: HeartbeatRole;
  commit: string | null;
  startedAt: number | null;
  beatAt: number;
  beatAgeSec: number;
  halted: boolean;
  rollout: { scope: string; levels: Record<string, number> } | null;
  counts: Record<string, unknown> | null;
  lastShutdown: LastShutdown | null;
}

/**
 * A KEY THAT CAN BE PUBLISHED: a word from a fixed vocabulary — a status, a
 * rail, a hold kind, a funnel field. Never anything that starts like a number,
 * holds an `0x`, or carries a long hex run, so an account cannot arrive as a
 * key any more than as a value.
 */
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9 _()-]{0,47}$/;
const noAccount = (k: string): boolean => !/0x/i.test(k) && !/[0-9a-f]{16,}/i.test(k);
const safeKey = (k: string): boolean => SAFE_KEY.test(k) && noAccount(k);
/** The rollout's name for itself — "none", "all", "3 named" — under the same rule. */
const safeScope = (k: string): boolean => /^[A-Za-z0-9][A-Za-z0-9 _()-]{0,47}$/.test(k) && noAccount(k);

/**
 * NUMBERS, AND OBJECTS OF NUMBERS — nothing else survives. A string, an
 * array, a negative or fractional count, a key outside the vocabulary: each is
 * dropped rather than passed on. Depth-bounded, since the shape is known.
 */
export function numbersOnly(value: unknown, depth = 0): unknown {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value) || depth > 3) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!safeKey(k)) continue;
    const kept = numbersOnly(v, depth + 1);
    if (kept !== undefined) out[k] = kept;
  }
  return out;
}

const json = (text: unknown): unknown => {
  if (typeof text !== "string" || text.length > 64 * 1024) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const unixSec = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** One stored row, as it may be served; null for a row that is not one of ours. */
export function publicHeartbeat(row: Record<string, unknown>, nowSec: number): PublicHeartbeat | null {
  const role = String(row.role ?? "");
  const beatAt = unixSec(row.beat_at);
  if (!ROLES.has(role) || beatAt === null) return null;
  const commit = typeof row.commit_sha === "string" && /^[0-9a-f]{7,64}$/.test(row.commit_sha) ? row.commit_sha : null;
  const halted = Number(row.halted);

  let rollout: PublicHeartbeat["rollout"] = null;
  const r = json(row.rollout) as { scope?: unknown; levels?: unknown } | null;
  if (r && typeof r === "object" && typeof r.scope === "string" && safeScope(r.scope)) {
    const levels = numbersOnly(r.levels);
    rollout = { scope: r.scope, levels: levels && typeof levels === "object" ? (levels as Record<string, number>) : {} };
  }
  const counts = numbersOnly(json(row.counts));

  return {
    role: role as HeartbeatRole,
    commit,
    startedAt: unixSec(row.started_at),
    beatAt,
    beatAgeSec: Math.max(0, nowSec - beatAt),
    halted: halted === 1,
    rollout,
    counts: counts && typeof counts === "object" ? (counts as Record<string, unknown>) : null,
    lastShutdown: lastShutdownOf(json(row.last_shutdown)),
  };
}

/** Every role's row, served aggregates-only. No table yet is no heartbeat yet: an empty list. */
export async function readFleetHeartbeats(db: Pick<Db, "prepare">, nowSec: number): Promise<PublicHeartbeat[]> {
  let rows: Record<string, unknown>[];
  try {
    rows = (await db
      .prepare(
        `SELECT role, commit_sha, started_at, beat_at, halted, rollout, counts, last_shutdown
           FROM fleet_heartbeat ORDER BY role LIMIT 8`,
      )
      .all()) as Record<string, unknown>[];
  } catch (error) {
    if (missingTable(error)) return [];
    throw error;
  }
  return rows.map((row) => publicHeartbeat(row, nowSec)).filter((h): h is PublicHeartbeat => h !== null);
}
