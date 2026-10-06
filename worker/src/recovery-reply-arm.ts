/**
 * THE OWNER'S STOP REQUESTS, APPLIED BEFORE ANY WORKER ARMS.
 *
 * While the fleet was held (2026-10-04 onwards) nothing traded, and owners
 * kept talking to their bots. Some of what they said was a stop: /pause, or
 * /kill followed by /confirm. A worker that arms after the hold must not
 * trade over any of them. This file is the one place those requests are
 * turned into the two things a worker actually obeys:
 *
 *  - the `paused` file in the tenant's home (telegram/service.ts setPaused),
 *    which the tick loop honours and the owner's /resume removes;
 *  - a kill request (kill-request.ts), which the orchestrator carries out
 *    against the grant store exactly as it carries out a kill sent to a
 *    running child.
 *
 * WHERE THE REQUESTS COME FROM, three places, all read-only here:
 *
 *  1. PR #259's journal, `recovery_reply_controls`, which the recovery reply
 *     listener appends to in the same transaction as its bot offset. That PR
 *     is not merged and its table does not exist in production yet. A missing
 *     table (Postgres 42P01, sqlite "no such table") is read as NO controls,
 *     never as a failure, so this lands first and #259 plugs in without a
 *     change here (readRecoveryControls is the whole adapter).
 *  2. The `events` table, for the pauses a CHILD recorded before the incident
 *     ("Telegram: paused by chat …"). The pause file itself was in a home the
 *     03:18 deploy destroyed; the event survived in the mirror. It is
 *     restored by the same rule the dashboard's inactivity reader uses
 *     (web/src/lib/services/inactivity.ts): the newest pause/resume event is a
 *     pause, and the agent did nothing past the pause gate after it. Only into
 *     a home never armed here: in a home a worker has run in, its own `paused`
 *     file is the truth, and Postgres may not have its /resume yet.
 *  3. Kill-request files already in the home. Those are not read here: the
 *     orchestrator honours them on every pass (honourPendingKills, reconcile)
 *     and spawnChild refuses while one is pending (killRequested).
 *
 * WHAT IS NOT HERE, AND CANNOT BE. A /pause sent to the recovery listener
 * between 2026-10-04 21:49 UTC and #259's deploy was answered and recorded
 * nowhere: no journal existed yet, and no child was running to write the
 * file or the event. Nothing in the database says it happened, so nothing can
 * honour it. docs/fleet-resume.md says so and proposes a resume notice to
 * owners instead of guessing.
 *
 * EXACTLY ONCE, IN POSTGRES. Each control applied writes a receipt keyed
 * (bot_id, update_id) — #259's own key for the request, or ("legacy-events",
 * events.id) for a restored pause — in the SAME transaction as the durable
 * half of its effect (tenant_telegram.paused_at, telegram-store.ts) and an
 * events row saying what was done. The receipts live in Postgres, so they
 * survive a rebuilt home: a pause applied once is not applied again after the
 * owner has lifted it with /resume, and a pause applied once IS put back into
 * a home that was rebuilt underneath it (the durable stamp, below) — unless
 * the owner's /resume, mirrored into the events, is newer than it.
 *
 * ONLY RESTRICTIVE. Nothing here unpauses, re-signs, or writes a key. A kill
 * is carried out by deleting the stored grant (or, when the owner signed a
 * newer grant after the kill, by pausing instead — Milla's default, decision
 * 7 of the resume plan); a killed grant's key is never written into a home,
 * because this runs before writeGrantForChild and a pending kill request
 * blocks that write (kill-request.ts).
 *
 * MALFORMED HOLDS. A journal row that does not parse, a confirmation with no
 * request, a confirmation after its own deadline: the tenant stays held and
 * the supervisor says so. Reading such a journal as "no controls" would be the
 * one direction that fails open.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Db } from "./db";
import { writeFileAtomicSync } from "./atomic-write";
import { distinctTrades, OP_COPY_REACH_SEC } from "./distinct-trades";
import { clearDurablePause, ensureTelegramSchema, readDurablePause, recordDurablePause } from "./telegram-store";

/**
 * ONE ROW PER CONTROL APPLIED. The key is the request's own: #259's
 * (bot_id, update_id), unique per bot stream, or LEGACY_EVENTS_BOT and the
 * events row's id for a restored pause. Nonsecret: no token, no chat text, no
 * grant identity.
 *
 *  - `pause`: an owner /pause from the journal, applied.
 *  - `legacy-restore`: a pause restored from the events table, applied.
 *  - `kill-forwarded`: a confirmed /kill handed to honourKillRequest, AFTER it
 *    returned revoked or superseded (keyed on the /kill request's update id).
 *  - `kill-superseded-pause`: the pause added when that kill was superseded by
 *    a newer grant (keyed on the /confirm's update id).
 */
export const CONTROL_RECEIPTS_SCHEMA = `CREATE TABLE IF NOT EXISTS recovery_reply_control_receipts (
  bot_id TEXT NOT NULL, update_id BIGINT NOT NULL,
  tenant TEXT NOT NULL, smart_account TEXT NOT NULL, chain_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pause','legacy-restore','kill-forwarded','kill-superseded-pause')),
  applied_at_ms BIGINT NOT NULL,
  PRIMARY KEY (bot_id, update_id)
)`;

/** The receipt "bot" of a pause restored from the events table; its update id is the events row's id. */
export const LEGACY_EVENTS_BOT = "legacy-events";

/**
 * Every events row this file writes ends with this, and the legacy reader
 * skips such rows: the row for a restored pause is itself a "Telegram: paused
 * by chat" row, and reading it back as a NEW pause to restore would apply a
 * second receipt on every arm, forever.
 */
export const RECORDED_DURING_UPGRADE = "(recorded during upgrade)";

/**
 * WHEN THIS HOME LAST HAD ITS CONTROLS APPLIED. Written at the end of every
 * arm, 0600. Its absence is what marks a REBUILT home — a new volume, or the
 * empty home a resume archive leaves (ledger-resume.ts) when nothing was
 * carried — and only a rebuilt home has its durable pause put back. A home
 * that has been armed before and has no `paused` file had it lifted by its
 * owner, and that /resume stands.
 */
export const CONTROLS_ARMED_FILE = "controls-armed.json";

/** The pause marker, as telegram/service.ts setPaused writes it, so the owner's /resume removes it. */
export const PAUSED_FILE = "paused";
const PAUSED_TEXT = "paused";

export interface ControlScope {
  tenant: string;
  smartAccount: string;
  chainId: number;
}

type Kind = "pause" | "kill-request" | "kill-confirm" | "kill-cancel";
const KINDS: ReadonlySet<string> = new Set(["pause", "kill-request", "kill-confirm", "kill-cancel"]);

/** One journal row, parsed. Every field is checked: the journal is read back from another service. */
interface ControlRow {
  botId: string;
  updateId: number;
  kind: Kind;
  requestUpdateId: number | null;
  messageAtSec: number;
  expiresAtMs: number | null;
  chatId: number | null;
}

/** What the journal says the owner asked for, across every bot, token, claim, account and chain of one tenant. */
export interface ControlFold {
  /** /pause requests. Every one is restrictive; none is ever lifted here. */
  pauses: Array<{ botId: string; updateId: number; atSec: number; chatId: number | null }>;
  /** /kill requests the same owner confirmed in time. */
  confirmedKills: Array<{ botId: string; requestUpdateId: number; confirmUpdateId: number; confirmAtSec: number; chatId: number | null }>;
  /** /kill requests still inside their /confirm window: nothing arms until each is confirmed, cancelled or expired. */
  pendingKills: number;
  /** Why the journal cannot be trusted, or null. Non-null holds the tenant. */
  malformed: string | null;
}

const safeInt = (v: unknown): number | null => {
  if (typeof v === "bigint") return v >= 0n && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v === "string" && /^(0|[1-9][0-9]{0,15})$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
};

function parseRow(raw: unknown): ControlRow | string {
  if (!raw || typeof raw !== "object") return "a control row is not an object";
  const r = raw as Record<string, unknown>;
  const botId = typeof r.bot_id === "string" && /^[0-9]{1,20}$/.test(r.bot_id) ? r.bot_id : null;
  const updateId = safeInt(r.update_id);
  const kind = typeof r.kind === "string" && KINDS.has(r.kind) ? (r.kind as Kind) : null;
  const request = r.request_update_id === null || r.request_update_id === undefined ? null : safeInt(r.request_update_id);
  const at = safeInt(r.message_at_sec);
  const expires = r.expires_at_ms === null || r.expires_at_ms === undefined ? null : safeInt(r.expires_at_ms);
  const chat = r.chat_id === null || r.chat_id === undefined ? null : Number(r.chat_id);
  if (botId === null || updateId === null || kind === null || at === null || at <= 0) return "a control row has an unreadable key, kind or time";
  if ((kind === "kill-confirm" || kind === "kill-cancel") !== (request !== null)) return "a control row's request link does not match its kind";
  if (r.request_update_id !== null && r.request_update_id !== undefined && request === null) return "a control row names an unreadable request";
  if ((kind === "kill-request") !== (expires !== null)) return "a control row's expiry does not match its kind";
  if (r.expires_at_ms !== null && r.expires_at_ms !== undefined && expires === null) return "a control row has an unreadable expiry";
  return { botId, updateId, kind, requestUpdateId: request, messageAtSec: at, expiresAtMs: expires, chatId: Number.isSafeInteger(chat) ? chat : null };
}

/**
 * THE FOLD: what every recorded control for one tenant comes to, now. Pure.
 * Spans every bot, token tag, claim stamp, grant tag, account and chain the
 * rows carry: a token rotation, a re-sign or a new account does not lift a
 * pause, and a second bot cannot hide a kill.
 *
 * A /kill is confirmed only by a /confirm that links to it, in the same bot
 * stream, later in that stream, and dated inside the request's own window
 * (the listener measures the window from the original /kill message, so a
 * delayed batch cannot widen it; this re-checks rather than trusts that). A
 * /cancel ends a request and lifts nothing else. A request with no answer is
 * pending until its window closes, and then it is nothing: the owner never
 * confirmed it.
 */
export function foldRecoveryControls(rows: readonly unknown[], nowMs: number): ControlFold {
  const fold: ControlFold = { pauses: [], confirmedKills: [], pendingKills: 0, malformed: null };
  const parsed: ControlRow[] = [];
  for (const raw of rows) {
    const row = parseRow(raw);
    if (typeof row === "string") return { ...fold, malformed: row };
    parsed.push(row);
  }
  const key = (bot: string, update: number) => `${bot}:${update}`;
  const requests = new Map<string, ControlRow>();
  const answers = new Map<string, ControlRow>();
  const seen = new Set<string>();
  for (const row of parsed) {
    const k = key(row.botId, row.updateId);
    if (seen.has(k)) return { ...fold, malformed: "two control rows share one bot update" };
    seen.add(k);
    if (row.kind === "kill-request") requests.set(k, row);
  }
  for (const row of parsed) {
    if (row.kind === "pause") fold.pauses.push({ botId: row.botId, updateId: row.updateId, atSec: row.messageAtSec, chatId: row.chatId });
    if (row.kind !== "kill-confirm" && row.kind !== "kill-cancel") continue;
    const k = key(row.botId, row.requestUpdateId!);
    const request = requests.get(k);
    if (!request) return { ...fold, malformed: "a /confirm or /cancel names no /kill in this scope" };
    if (answers.has(k)) return { ...fold, malformed: "a /kill has two answers" };
    if (row.updateId <= request.updateId || row.messageAtSec < request.messageAtSec) return { ...fold, malformed: "a /kill was answered before it was asked" };
    if (row.kind === "kill-confirm" && row.messageAtSec * 1000 > request.expiresAtMs!) return { ...fold, malformed: "a /kill was confirmed after its window closed" };
    answers.set(k, row);
  }
  for (const [k, request] of requests) {
    const answer = answers.get(k);
    if (answer?.kind === "kill-confirm") {
      fold.confirmedKills.push({
        botId: request.botId, requestUpdateId: request.updateId, confirmUpdateId: answer.updateId,
        confirmAtSec: answer.messageAtSec, chatId: answer.chatId ?? request.chatId,
      });
    } else if (!answer && nowMs <= request.expiresAtMs!) {
      fold.pendingKills += 1;
    }
  }
  const order = (a: { botId: string }, b: { botId: string }) => a.botId.localeCompare(b.botId);
  fold.pauses.sort((a, b) => order(a, b) || a.updateId - b.updateId);
  fold.confirmedKills.sort((a, b) => order(a, b) || a.requestUpdateId - b.requestUpdateId);
  return fold;
}

const missingTable = (e: unknown): boolean => {
  const err = e as { code?: unknown; message?: unknown };
  return err?.code === "42P01" || /no such table: (?:main\.)?recovery_reply_controls\b/.test(String(err?.message ?? ""));
};

/** The most rows one tenant's journal may hold before it is read as malformed rather than truncated. */
const MAX_CONTROL_ROWS = 10_000;

/**
 * THE ADAPTER FOR #259: every journal row for one tenant, or `absent` when the
 * table does not exist (the listener that writes it is not deployed). Any
 * other error throws: an unreadable journal is not an empty one. Run outside
 * any transaction, so a missing table cannot abort one (Postgres).
 *
 * EVERY ACCOUNT AND CHAIN THE TENANT'S JOURNAL NAMES, not only the current
 * grant's. The tenant is the owner, and a stop belongs to the owner's home,
 * not to one account: the legacy reader below already spans every account the
 * owner has had (ownerAccounts), as the dashboard's inactivity reader does.
 * Read under the current account alone, a /pause the listener journalled
 * while the owner's grant named account A was silently dropped once the owner
 * re-signed on account B before admission. A confirmed /kill journalled under
 * A reaches B's arm the same way, and honourKillRequest decides it against
 * the grant the store holds now (a grant signed after the kill is kept and
 * paused, decision 7). Receipts are keyed by the request's own (bot, update),
 * so exactly-once is unchanged.
 */
export async function readRecoveryControls(db: Db, scope: ControlScope): Promise<{ rows: unknown[] } | { absent: true }> {
  try {
    const rows = await db
      .prepare(
        `SELECT bot_id, update_id, kind, request_update_id, message_at_sec, expires_at_ms, chat_id
           FROM recovery_reply_controls WHERE tenant = ?
          ORDER BY bot_id, update_id LIMIT ${MAX_CONTROL_ROWS + 1}`,
      )
      .all(scope.tenant.toLowerCase());
    if (rows.length > MAX_CONTROL_ROWS) throw new Error("recovery control journal is too large to fold");
    return { rows };
  } catch (e) {
    if (missingTable(e)) return { absent: true };
    throw e;
  }
}

/** A pause a CHILD recorded in the events table before its home was lost, still standing. */
export interface LegacyPause {
  eventId: number;
  atSec: number;
}

const FILL_KINDS = ["swap", "curve-trade"] as const;
/** Every account this owner has had, newest grant's included: the pause belonged to the owner's home, not to one account. */
async function ownerAccounts(db: Db, scope: ControlScope): Promise<string[]> {
  const rows = (await db
    .prepare("SELECT DISTINCT lower(smart_account) AS a FROM agents WHERE lower(owner_address) = ? LIMIT 65")
    .all(scope.tenant.toLowerCase())) as Array<{ a: unknown }>;
  if (rows.length > 64) throw new Error("too many accounts under one owner to restore a pause");
  const out = new Set<string>([scope.smartAccount.toLowerCase()]);
  for (const r of rows) if (typeof r.a === "string" && /^0x[0-9a-f]{40}$/.test(r.a)) out.add(r.a);
  return [...out].sort();
}

/**
 * THE PAUSE THE EVENTS SAY IS STILL STANDING, or null — the inactivity
 * reader's rule (web/src/lib/services/inactivity.ts), read from Postgres:
 *
 *  - the newest of "Telegram: paused by chat", "Telegram: resumed by chat" and
 *    "Telegram: KILL by chat … kept the grant … paused instead" across every
 *    account this owner has had is a pause;
 *  - it is not one this file wrote (RECORDED_DURING_UPGRADE): that pause has
 *    already been applied, and it is its receipt that stands;
 *  - and nothing past the pause gate happened after it: no decision from a
 *    source the pause stops (the Brain decides before the gate, and an owner's
 *    chat transfer never consults it, so neither proves a resume), and no fill,
 *    one row per operation (a redeploy re-records old operations stamped at the
 *    restart, and a copy is not the agent acting again).
 */
export async function readLegacyPause(db: Db, scope: ControlScope): Promise<LegacyPause | null> {
  try {
    return await readLegacyPauseFrom(db, scope);
  } catch (e) {
    // A database with no events, agents, decisions or trades table has never
    // recorded a pause (a fresh self-hosted install, a test's stand-in). Any
    // other failure throws: unreadable events are not an absent pause.
    const err = e as { code?: unknown; message?: unknown };
    if (err?.code === "42P01" || /no such table: (?:main\.)?(?:events|agents|decisions|trades)\b/.test(String(err?.message ?? ""))) return null;
    throw e;
  }
}

/**
 * The newest "Telegram: paused by chat", "Telegram: resumed by chat" or "KILL
 * by chat … kept the grant" row across `accounts`, this file's own rows
 * included. A tie in the second goes to the row written later: the mirror
 * gives each copied row a new id, so a /resume mirrored after a pause this
 * file applied is the later row.
 */
async function newestPauseOrResume(db: Db, accounts: readonly string[]): Promise<{ id: number; at: number; message: string } | null> {
  const holes = accounts.map(() => "?").join(", ");
  const newest = (await db
    .prepare(
      `SELECT id, message, created_at FROM events WHERE lower(agent_id) IN (${holes})
         AND (message LIKE 'Telegram: paused by chat%' OR message LIKE 'Telegram: resumed by chat%'
              OR message LIKE 'Telegram: KILL by chat % kept the grant %')
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(...accounts)) as { id: unknown; message: unknown; created_at: unknown } | undefined;
  if (!newest) return null;
  const id = safeInt(newest.id), at = safeInt(newest.created_at);
  if (id === null || at === null || at <= 0) throw new Error("a pause event is unreadable");
  return { id, at, message: String(newest.message) };
}

async function readLegacyPauseFrom(db: Db, scope: ControlScope): Promise<LegacyPause | null> {
  const accounts = await ownerAccounts(db, scope);
  const holes = accounts.map(() => "?").join(", ");
  const inList = `lower(agent_id) IN (${holes})`;
  const newest = await newestPauseOrResume(db, accounts);
  if (!newest) return null;
  const { id, at, message } = newest;
  if (message.includes(RECORDED_DURING_UPGRADE)) return null;
  const paused = message.startsWith("Telegram: paused by chat") || (message.startsWith("Telegram: KILL by chat") && message.includes("paused instead"));
  if (!paused) return null;
  const decided = (await db
    .prepare(
      `SELECT MAX(at) AS at FROM decisions WHERE ${inList} AND at > ?
         AND source NOT IN ('brain', 'brain-shadow', 'chat') AND COALESCE(provenance, '') NOT IN ('brain', 'owner-command')`,
    )
    .get(...accounts, at)) as { at: unknown } | undefined;
  if (decided?.at !== null && decided?.at !== undefined) return null;
  const kinds = FILL_KINDS.map(() => "?").join(", ");
  const filled = (await db
    .prepare(`SELECT MAX(t.created_at) AS at FROM ${distinctTrades(`${inList} AND created_at >= ?`)} WHERE t.created_at > ? AND t.kind IN (${kinds})`)
    .get(...accounts, at - OP_COPY_REACH_SEC, at, ...FILL_KINDS)) as { at: unknown } | undefined;
  if (filled?.at !== null && filled?.at !== undefined) return null;
  return { eventId: id, atSec: at };
}

/**
 * HAS THE OWNER'S OWN /resume, ALREADY IN POSTGRES, LIFTED THE DURABLE PAUSE
 * STAMPED AT `pausedAtSec`?
 *
 * True only when the newest pause/resume event across every account the
 * owner has had is a "Telegram: resumed by chat" row — the one a child writes
 * on /resume, carried up by a mirror pass — dated at or after the stamp.
 * Every pause this file applies writes its own "paused by chat … (recorded
 * during upgrade)" row in the stamp's transaction, so a pause applied after
 * the resume is the newer row and wins, and a resume from before the stamp is
 * never the newest; a pause the child itself recorded after the resume wins
 * the same way.
 *
 * Asked only where the durable pause would otherwise be put back: a home with
 * no `paused` file and no arm record from after the stamp. That is the home
 * lost after the owner's /resume with no respawn in between to see its file
 * gone, and without this the stamp paused an owner whose /resume Postgres
 * already held. A /resume the mirror had not carried up before the home was
 * lost is in no table, and the pause is put back, as it always was.
 *
 * It decides only whether a pause is put back; it never removes one. A
 * database with no events or agents table holds no resume (false); any other
 * failure throws, and the arm holds.
 */
export async function durablePauseLifted(db: Db, scope: ControlScope, pausedAtSec: number): Promise<boolean> {
  try {
    const newest = await newestPauseOrResume(db, await ownerAccounts(db, scope));
    return newest !== null && newest.message.startsWith("Telegram: resumed by chat") && newest.at >= pausedAtSec;
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown };
    if (err?.code === "42P01" || /no such table: (?:main\.)?(?:events|agents)\b/.test(String(err?.message ?? ""))) return false;
    throw e;
  }
}

/**
 * WHAT B7's EVIDENCE BINDS FOR CONTROLS (ledger-resume.ts): the fold and the
 * standing legacy pause, as one digest. `readable` false is the journal or
 * the events refusing to be read, or a malformed journal; a preview reports
 * it and an admission refuses on it.
 */
export async function readControlsEvidence(db: Db, scope: ControlScope, nowMs: number): Promise<{
  readable: boolean; why: string | null; digest: string; fold: ControlFold | null; legacy: LegacyPause | null; journal: "present" | "absent";
}> {
  try {
    const journal = await readRecoveryControls(db, scope);
    const fold = foldRecoveryControls("absent" in journal ? [] : journal.rows, nowMs);
    const legacy = await readLegacyPause(db, scope);
    const body = {
      journal: "absent" in journal ? "absent" : "present",
      pauses: fold.pauses.map((p) => `${p.botId}:${p.updateId}`),
      kills: fold.confirmedKills.map((k) => `${k.botId}:${k.requestUpdateId}:${k.confirmUpdateId}`),
      pending: fold.pendingKills,
      malformed: fold.malformed,
      legacy: legacy ? `${legacy.eventId}:${legacy.atSec}` : null,
    };
    const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    return { readable: fold.malformed === null, why: fold.malformed, digest, fold, legacy, journal: body.journal as "present" | "absent" };
  } catch (e) {
    const kind = e instanceof Error && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "Error";
    return { readable: false, why: `controls unreadable (${kind})`, digest: "unreadable", fold: null, legacy: null, journal: "absent" };
  }
}

export type KillForward = "revoked" | "superseded" | "failed" | "none";

export interface ArmControlsOptions {
  scope: ControlScope;
  home: string;
  shared: Db;
  /** Still this replica's tenant: the same lease, healthy. Asked before every write. */
  mayWrite: () => boolean;
  /**
   * Leave a kill request in the home for a confirmed /kill dated `killedAtSec`
   * and carry it out NOW (the orchestrator's honourKill, so honourKillRequest
   * decides revoked or superseded from the stored grant's own updated_at).
   * `tag` names the request; it is never a grant identity, so a superseded
   * request cannot latch a newer grant (kill-request.ts mayArm).
   */
  forwardKill: (killedAtSec: number, tag: string) => Promise<KillForward>;
  nowMs?: number;
  log?: (line: string) => void;
}

export type ArmControlsOutcome =
  | { ok: true; paused: boolean; applied: string[] }
  | { ok: false; hold: "malformed" | "kill-awaiting-confirm" | "kill-not-carried-out" | "revoked" | "lost-writer"; why: string };

const lost = () => new Error("The owner-control arm lost its tenant lease; nothing further was applied.");
/** Databases whose receipts table and paused_at column this process has already ensured: once each, not once per spawn. */
const schemaReady = new WeakSet<Db>();

function writePaused(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileAtomicSync(path.join(home, PAUSED_FILE), PAUSED_TEXT, 0o600, { durable: true });
}

function readArmedAtMs(home: string): number | null {
  try {
    const v = JSON.parse(readFileSync(path.join(home, CONTROLS_ARMED_FILE), "utf8")) as { armedAtMs?: unknown };
    return typeof v.armedAtMs === "number" && Number.isSafeInteger(v.armedAtMs) && v.armedAtMs > 0 ? v.armedAtMs : null;
  } catch {
    return null;
  }
}

/**
 * Apply one pause, once: its receipt, the durable stamp, the events row and
 * the file, together. The file is written inside the transaction, before the
 * commit, so the only state a crash can leave is a paused home with no
 * receipt yet — the restrictive one — and the next arm writes the receipt
 * over a file that is already there. Returns whether this call applied it.
 */
async function applyPause(o: ArmControlsOptions, botId: string, updateId: number, kind: "pause" | "legacy-restore" | "kill-superseded-pause",
  message: string, nowMs: number, also?: { botId: string; updateId: number; kind: "kill-forwarded" }): Promise<boolean> {
  const s = o.scope, nowSec = Math.floor(nowMs / 1000);
  return o.shared.tx(async (tx) => {
    if (!o.mayWrite()) throw lost();
    const insert = tx.prepare(`INSERT INTO recovery_reply_control_receipts (bot_id, update_id, tenant, smart_account, chain_id, kind, applied_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (bot_id, update_id) DO NOTHING`);
    if (also) await insert.run(also.botId, also.updateId, s.tenant.toLowerCase(), s.smartAccount.toLowerCase(), s.chainId, also.kind, nowMs);
    const r = await insert.run(botId, updateId, s.tenant.toLowerCase(), s.smartAccount.toLowerCase(), s.chainId, kind, nowMs);
    if (r.changes !== 1) return false;
    await recordDurablePause(tx, s.tenant, nowSec);
    await tx.prepare("INSERT INTO events (agent_id, level, message, created_at) VALUES (?, 'warn', ?, ?)").run(s.smartAccount, message, nowSec);
    if (!o.mayWrite()) throw lost();
    writePaused(o.home);
    return true;
  });
}

/**
 * APPLY EVERY RECORDED OWNER CONTROL FOR THIS TENANT, BEFORE ITS WORKER ARMS.
 *
 * Called by spawnChild under the tenant's lease, after the persistent-home
 * proof and any resume archive (ledger-resume.ts), and before the grant is
 * written into the home. `ok: false` holds the tenant this pass: nothing is
 * spawned, the lease and home are kept, and the next pass asks again.
 */
export async function armOwnerControls(o: ArmControlsOptions): Promise<ArmControlsOutcome> {
  const nowMs = o.nowMs ?? Date.now(), s = o.scope;
  const say = o.log ?? (() => {});
  if (!o.mayWrite()) return { ok: false, hold: "lost-writer", why: "lease lost before the owner controls were read" };
  if (!schemaReady.has(o.shared)) {
    await o.shared.exec(CONTROL_RECEIPTS_SCHEMA);
    await ensureTelegramSchema(o.shared);
    schemaReady.add(o.shared);
  }
  // Read before anything below writes the arm record: whether THIS home has
  // ever been armed decides whether a pre-incident pause event may be restored.
  const neverArmed = readArmedAtMs(o.home) === null;
  const journal = await readRecoveryControls(o.shared, s);
  const fold = foldRecoveryControls("absent" in journal ? [] : journal.rows, nowMs);
  if (fold.malformed) return { ok: false, hold: "malformed", why: fold.malformed };
  if (fold.pendingKills > 0) return { ok: false, hold: "kill-awaiting-confirm", why: "a recorded /kill is still inside its /confirm window" };
  const receipts = new Set(
    ((await o.shared.prepare("SELECT bot_id, update_id FROM recovery_reply_control_receipts WHERE tenant = ?").all(s.tenant.toLowerCase())) as
      Array<{ bot_id: unknown; update_id: unknown }>).map((r) => `${String(r.bot_id)}:${String(safeInt(r.update_id))}`),
  );
  const applied: string[] = [];

  // KILLS FIRST. A kill that removes the grant ends the arm: nothing is paused
  // over a tenant that no longer has a key.
  for (const k of fold.confirmedKills) {
    if (receipts.has(`${k.botId}:${k.requestUpdateId}`)) continue;
    if (!o.mayWrite()) return { ok: false, hold: "lost-writer", why: "lease lost before a recorded kill was carried out" };
    const outcome = await o.forwardKill(k.confirmAtSec, `${k.botId}:${k.requestUpdateId}`);
    const chat = k.chatId === null ? "" : ` ${k.chatId}`;
    if (outcome === "revoked") {
      await o.shared.tx(async (tx) => {
        await tx.prepare(`INSERT INTO recovery_reply_control_receipts (bot_id, update_id, tenant, smart_account, chain_id, kind, applied_at_ms)
          VALUES (?, ?, ?, ?, ?, 'kill-forwarded', ?) ON CONFLICT (bot_id, update_id) DO NOTHING`)
          .run(k.botId, k.requestUpdateId, s.tenant.toLowerCase(), s.smartAccount.toLowerCase(), s.chainId, nowMs);
        await tx.prepare("INSERT INTO events (agent_id, level, message, created_at) VALUES (?, 'warn', ?, ?)")
          .run(s.smartAccount, `Telegram: KILL by chat${chat} confirmed while trading was held — carried out: the stored grant is removed ${RECORDED_DURING_UPGRADE}`, Math.floor(nowMs / 1000));
      });
      say(`${s.tenant}: a /kill its owner confirmed while trading was held is carried out — the stored grant is removed`);
      return { ok: false, hold: "revoked", why: "the owner's recorded kill removed the stored grant" };
    }
    if (outcome === "superseded") {
      // MILLA'S DEFAULT (decision 7): the owner signed a newer grant after the
      // kill, so that grant is theirs to keep, and trading stays PAUSED until
      // they say /resume. Told through the events row, which the dashboard
      // reads; no message is sent from here.
      const message = `Telegram: paused by chat${chat} — a /kill confirmed while trading was held was superseded by a grant signed after it, so trading stays paused until /resume ${RECORDED_DURING_UPGRADE}`;
      if (await applyPause(o, k.botId, k.confirmUpdateId, "kill-superseded-pause", message, nowMs,
        { botId: k.botId, updateId: k.requestUpdateId, kind: "kill-forwarded" })) applied.push(`kill-superseded-pause ${k.botId}:${k.confirmUpdateId}`);
      say(`[alert] ${s.tenant}: a recorded /kill was superseded by a newer grant — that grant is kept and trading is paused until the owner says /resume`);
      continue;
    }
    // Not carried out this pass. The request file is pending in the home, so
    // nothing arms there (killRequested) until honourKill gets through.
    return { ok: false, hold: "kill-not-carried-out", why: "a recorded kill could not be carried out yet" };
  }

  for (const p of fold.pauses) {
    if (receipts.has(`${p.botId}:${p.updateId}`)) continue;
    const chat = p.chatId === null ? "" : ` ${p.chatId}`;
    if (await applyPause(o, p.botId, p.updateId, "pause", `Telegram: paused by chat${chat} — sent while trading was held ${RECORDED_DURING_UPGRADE}`, nowMs)) {
      applied.push(`pause ${p.botId}:${p.updateId}`);
    }
  }

  // A PRE-INCIDENT PAUSE, ONLY INTO A HOME NEVER ARMED HERE: a rebuilt home,
  // or the fresh one a resume archive leaves, which is exactly the home whose
  // `paused` file the events outlived. A home armed before is a home a worker
  // ran in, and its own `paused` file is the truth: on every crash-restart
  // this runs again, BEFORE finalMirrorBeforeAnchor carries the book's tail
  // up, so Postgres can still show the owner's /pause and not yet the /resume
  // that followed it — and restoring from that would undo the resume.
  const legacy = neverArmed ? await readLegacyPause(o.shared, s) : null;
  if (legacy && !receipts.has(`${LEGACY_EVENTS_BOT}:${legacy.eventId}`)) {
    const when = new Date(legacy.atSec * 1000).toISOString();
    if (await applyPause(o, LEGACY_EVENTS_BOT, legacy.eventId, "legacy-restore",
      `Telegram: paused by chat — the pause recorded at ${when} is restored ${RECORDED_DURING_UPGRADE}`, nowMs)) {
      applied.push(`legacy-restore ${legacy.eventId}`);
    }
  }

  // THE DURABLE HALF. A rebuilt home (never armed here) gets its pause back;
  // a home armed AFTER the pause was applied, whose pause file is gone, was
  // resumed by its owner (a child ran there and its /resume removed the
  // file), and the stamp that would pause it again on the next rebuild is
  // lifted. Only the stamp that was read is cleared, so a pause applied
  // meanwhile stands. Anything in between — an arm record older than the
  // pause it should have seen — is not proof of a resume, and pauses again.
  //
  // EXCEPT WHERE POSTGRES ALREADY HOLDS THAT PROOF: the owner's /resume,
  // mirrored, newer than the pause (durablePauseLifted). An owner who
  // resumed, and whose home was then lost before any arm ran there again,
  // comes back to a home with no arm record at all; putting the pause back
  // over their /resume is the one thing this must not do. The stamp is
  // lifted as it would have been by that respawn, and nothing is unpaused.
  const durable = await readDurablePause(o.shared, s.tenant);
  if (durable !== null && !existsSync(path.join(o.home, PAUSED_FILE))) {
    const armedAt = readArmedAtMs(o.home);
    if (!o.mayWrite()) return { ok: false, hold: "lost-writer", why: "lease lost before the durable pause was checked" };
    if (armedAt !== null && armedAt >= durable * 1000) {
      await clearDurablePause(o.shared, s.tenant, durable);
    } else if (await durablePauseLifted(o.shared, s, durable)) {
      if (!o.mayWrite()) return { ok: false, hold: "lost-writer", why: "lease lost before the durable pause was lifted" };
      await clearDurablePause(o.shared, s.tenant, durable);
      say(`${s.tenant}: the durable pause is not put back — its owner's /resume, in Postgres, is newer than it`);
    } else {
      writePaused(o.home);
      applied.push("durable-pause-restored");
    }
  }
  if (!o.mayWrite()) return { ok: false, hold: "lost-writer", why: "lease lost before the arm was recorded" };
  mkdirSync(o.home, { recursive: true, mode: 0o700 });
  writeFileAtomicSync(path.join(o.home, CONTROLS_ARMED_FILE), JSON.stringify({ version: 1, armedAtMs: nowMs }), 0o600);
  for (const a of applied) say(`${s.tenant}: owner control applied before arm — ${a}`);
  return { ok: true, paused: existsSync(path.join(o.home, PAUSED_FILE)), applied };
}
