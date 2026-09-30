/**
 * THE ROOM'S THREE TABLES, AND THE ONLY CODE THAT READS OR WRITES THEM.
 *
 * The group chat keeps its own `groupchat_*` tables instead of the social
 * `posts` table because `posts` is a trading input (peer-theses.ts → peers.json
 * → Brain's social lens) and the chat must never be one — rule 1 of
 * docs/groupchat.md. Nothing here touches a ledger table, and nothing that
 * feeds a trading decision may import this module.
 *
 * ONE DIALECT, TWO DATABASES. Every statement is written in sqlite's spelling
 * and translated by db.ts — translateQuery for `prepare`, translateSchema for
 * `exec`. The sqlite test suite cannot see a Postgres-only failure, and such a
 * statement lies dormant until its first run in production, so everything below
 * keeps to shapes that are verified to translate:
 *   - inserts that need the new id say `RETURNING id` and read it through
 *     `.get()`, because PgDb.run reports lastInsertRowid as 0 — always;
 *   - "did it happen" is a RETURNING row or an UPDATE/DELETE `changes`, both of
 *     which mean the same thing on either backend;
 *   - result columns are snake_case, because Postgres folds an unquoted alias;
 *   - upserts name each column they set as `x = excluded.x`, and anything else
 *     on the right-hand side is qualified with the table name;
 *   - `?` appears only in `prepare`d SQL, because `exec` never renumbers it.
 *
 * WEB-SAFE. The web routes import this module as well as the orchestrator, so
 * it imports only a TYPE from db.ts and reads no environment: the caller opens
 * the connection and says which dialect it speaks.
 */
import type { Db } from "../db";
import type {
  AuthorKind,
  CallRef,
  Member,
  MessageKind,
  NewMessage,
  Presence,
  PublicMessage,
  RoomState,
  StoredMessage,
  TzSource,
} from "./types";

/**
 * The room's DDL, in sqlite's dialect.
 *
 * Every statement is `IF NOT EXISTS` so a second boot, or a second process, is
 * a no-op. Comments stay `--` style and free of placeholders and quotes, because
 * translateSchema rewrites this text blind and `exec` sends it as-is.
 */
export const GROUPCHAT_SCHEMA = `
CREATE TABLE IF NOT EXISTS groupchat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,   -- the poll cursor; has gaps, compare with >
  created_at_ms INTEGER NOT NULL,
  author_kind TEXT NOT NULL,              -- agent|owner|system
  tenant TEXT NOT NULL,                   -- INTERNAL: never selected by public reads
  agent_id TEXT,                          -- INTERNAL
  speaker_slug TEXT,
  speaker_name TEXT NOT NULL,
  body TEXT NOT NULL,
  reply_to INTEGER,                       -- no FK: may dangle after a prune
  kind TEXT NOT NULL DEFAULT 'chat',      -- chat|call|gm|gn|join
  call_side TEXT, call_symbol TEXT, call_name TEXT, call_token TEXT, call_paper INTEGER,
  call_decision_id TEXT,
  dedupe_key TEXT UNIQUE,                 -- NULL for free chat
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS groupchat_messages_tenant ON groupchat_messages (tenant, id);
CREATE TABLE IF NOT EXISTS groupchat_members (
  tenant TEXT PRIMARY KEY, tz TEXT, tz_source TEXT,
  muted INTEGER NOT NULL DEFAULT 0,
  joined_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS groupchat_room (
  k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
);
`;

/**
 * THE SCHEMA LOCK'S KEY. Distinct from every other transaction-scoped advisory
 * key in the repo (auth nonces 1_297_691_982, partner store 1_297_692_081..084):
 * a shared key would make unrelated first boots queue behind each other.
 */
const SCHEMA_LOCK = 1_297_692_090;

/** The public GET's page ceiling, and the floor that makes `start` meaningful. */
const PAGE_MAX = 200;

/** The one row groupchat_room holds today. */
const ROOM_KEY = "room";

/**
 * A MEMBERS ROW THE ORCHESTRATOR HAS NOT JOINED YET.
 *
 * The web writes an owner's zone whenever a signed-in page loads, which can be
 * before the orchestrator has ever seen that owner's agent — and on the day the
 * room ships, before its first pass. If that insert looked like a join, the
 * owner's agent would never get its hello, and one early page load would make
 * the conductor's first pass greet the whole fleet instead of opening the room
 * silently. So a prefs-only row carries joined_at_ms = 0, `allMembers` skips
 * it, and `joinMember` claims it exactly once.
 */
const NOT_JOINED = 0;

const schemaReady = new WeakMap<Db, Promise<void>>();

/**
 * Create the tables once per Db for the life of the process.
 *
 * Memoised on the Db, and the entry is dropped on failure so a database that
 * was briefly unreachable is retried on the next pass instead of never. On
 * Postgres the DDL runs inside a transaction holding an advisory lock, because
 * web and orchestrator boot together and two concurrent CREATE TABLE IF NOT
 * EXISTS can still collide in the catalog (the auth-nonce-store pattern).
 */
export function ensureGroupchatSchema(db: Db, dialect: "postgres" | "sqlite"): Promise<void> {
  const existing = schemaReady.get(db);
  if (existing) return existing;
  const started = createSchema(db, dialect).catch((error: unknown) => {
    if (schemaReady.get(db) === started) schemaReady.delete(db);
    throw error;
  });
  schemaReady.set(db, started);
  return started;
}

async function createSchema(db: Db, dialect: "postgres" | "sqlite"): Promise<void> {
  if (dialect === "postgres") {
    await db.tx(async (tx) => {
      await tx.prepare("SELECT pg_advisory_xact_lock(?)").get(SCHEMA_LOCK);
      await tx.exec(GROUPCHAT_SCHEMA);
    });
  } else {
    await db.exec(GROUPCHAT_SCHEMA);
  }
}

// ── parameters ──────────────────────────────────────────────────────────────

/**
 * AN INTEGER POSTGRES WILL ACCEPT.
 *
 * pg sends a number to a BIGINT parameter as text, so 2.5 or 1e21 is a hard
 * error on Postgres that sqlite accepts silently — and `since`/`before` arrive
 * from a public query string. Round in the direction that keeps the comparison
 * the caller wrote, and clamp to the safe range (which BIGINT contains).
 */
function intParam(n: number, round: (x: number) => number): number {
  const r = round(n);
  if (Number.isNaN(r)) return 0;
  return Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, r));
}

/** A cursor the caller actually supplied. NaN (an unparsable query value) counts as absent. */
function cursorOf(v: number | null | undefined): number | null {
  return typeof v === "number" && !Number.isNaN(v) ? v : null;
}

function pageSize(limit: number): number {
  const n = Math.trunc(Number(limit));
  if (Number.isNaN(n)) return PAGE_MAX;
  return Math.min(PAGE_MAX, Math.max(1, n));
}

/** Tenants are lowercased owner wallets; normalising here keeps a checksummed caller from splitting one owner into two rows. */
function tenantKey(tenant: string | null | undefined): string {
  return String(tenant ?? "").toLowerCase();
}

// ── rows ────────────────────────────────────────────────────────────────────

const MESSAGE_COLUMNS =
  "id, created_at_ms, author_kind, tenant, agent_id, speaker_slug, speaker_name, body, reply_to, kind, " +
  "call_side, call_symbol, call_name, call_token, call_paper, call_decision_id, dedupe_key, hidden";

const MEMBER_COLUMNS = "tenant, tz, tz_source, muted, joined_at_ms, updated_at_ms";

/** Integer columns arrive as number (sqlite, pg with the int8 parser) or string/bigint (a pg without it). */
interface MessageRow {
  id: unknown;
  created_at_ms: unknown;
  author_kind: string;
  tenant: string | null;
  agent_id: string | null;
  speaker_slug: string | null;
  speaker_name: string;
  body: string;
  reply_to: unknown;
  kind: string;
  call_side: string | null;
  call_symbol: string | null;
  call_name: string | null;
  call_token: string | null;
  call_paper: unknown;
  call_decision_id: string | null;
  dedupe_key: string | null;
  hidden: unknown;
}

interface MemberRow {
  tenant: string;
  tz: string | null;
  tz_source: string | null;
  muted: unknown;
  joined_at_ms: unknown;
  updated_at_ms: unknown;
}

const AUTHOR_KINDS: ReadonlySet<string> = new Set<AuthorKind>(["agent", "owner", "system"]);
const MESSAGE_KINDS: ReadonlySet<string> = new Set<MessageKind>(["chat", "call", "gm", "gn", "join"]);

const nullableNumber = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function messageOf(r: MessageRow): StoredMessage {
  const side = r.call_side;
  return {
    id: Number(r.id),
    createdAtMs: Number(r.created_at_ms),
    // An unknown author is shown as the room's own voice rather than passed
    // off as an agent or an owner.
    authorKind: AUTHOR_KINDS.has(r.author_kind) ? (r.author_kind as AuthorKind) : "system",
    tenant: r.tenant ?? "",
    agentId: r.agent_id ?? null,
    speakerSlug: r.speaker_slug ?? null,
    speakerName: r.speaker_name,
    body: r.body,
    replyTo: nullableNumber(r.reply_to),
    kind: MESSAGE_KINDS.has(r.kind) ? (r.kind as MessageKind) : "chat",
    call:
      side === "buy" || side === "sell"
        ? {
            side,
            symbol: r.call_symbol ?? null,
            name: r.call_name ?? null,
            token: r.call_token ?? null,
            paper: Number(r.call_paper ?? 0) !== 0,
          }
        : null,
    callDecisionId: r.call_decision_id ?? null,
    dedupeKey: r.dedupe_key ?? null,
    hidden: Number(r.hidden ?? 0) !== 0,
  };
}

function memberOf(r: MemberRow): Member {
  const source = r.tz_source;
  return {
    tenant: r.tenant,
    tz: r.tz ?? null,
    tzSource: source === "owner" || source === "browser" ? source : null,
    muted: Number(r.muted ?? 0) !== 0,
    joinedAtMs: Number(r.joined_at_ms),
    updatedAtMs: Number(r.updated_at_ms),
  };
}

// ── messages ────────────────────────────────────────────────────────────────

/**
 * Insert one line. Returns its id, or null when `dedupeKey` was already used —
 * the line was "already said", which is how a call, a gm or a gn survives a
 * redeploy without repeating.
 *
 * ON CONFLICT … DO NOTHING RETURNING yields no row on a conflict on both
 * backends, so `.get()` is the whole answer; `INSERT OR IGNORE` would be
 * rewritten by translateQuery into a statement with no RETURNING slot.
 */
export async function appendMessage(db: Db, m: NewMessage): Promise<number | null> {
  const call: CallRef | null = m.call ?? null;
  // A reply pointer is decoration: a malformed one must not cost the line.
  const replyTo = typeof m.replyTo === "number" && Number.isSafeInteger(m.replyTo) ? m.replyTo : null;
  const row = (await db
    .prepare(
      `INSERT INTO groupchat_messages (
         created_at_ms, author_kind, tenant, agent_id, speaker_slug, speaker_name, body, reply_to, kind,
         call_side, call_symbol, call_name, call_token, call_paper, call_decision_id, dedupe_key
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
    )
    .get(
      intParam(m.createdAtMs, Math.trunc),
      m.authorKind,
      tenantKey(m.tenant),
      m.agentId ?? null,
      m.speakerSlug ?? null,
      m.speakerName,
      m.body,
      replyTo,
      m.kind,
      call ? call.side : null,
      call ? call.symbol ?? null : null,
      call ? call.name ?? null : null,
      call ? call.token ?? null : null,
      call ? (call.paper ? 1 : 0) : null,
      m.callDecisionId ?? null,
      // "" would be a real key that every later keyless line collides with.
      m.dedupeKey ? m.dedupeKey : null,
    )) as { id: unknown } | undefined;
  return row ? Number(row.id) : null;
}

/**
 * One page of the room, ascending by id, hidden lines excluded.
 *
 *   since  → the lines after a cursor, oldest first (the poll); `start` is false
 *   before → the `limit` lines just older than `before` (load earlier)
 *   neither → the newest `limit` lines (first load)
 *
 * For the last two, `start` is true when the page came back short, i.e. it
 * reached the first visible line. `since` wins when both are given. `limit` is
 * clamped to 1..200. Ids have gaps (prunes, and on Postgres every dedupe
 * conflict burns a sequence value), so only ever compare them with < and >.
 */
export async function readMessages(
  db: Db,
  q: { since?: number; before?: number | null; limit: number },
): Promise<{ messages: StoredMessage[]; start: boolean }> {
  const limit = pageSize(q.limit);
  const since = cursorOf(q.since);
  if (since !== null) {
    const rows = (await db
      .prepare(`SELECT ${MESSAGE_COLUMNS} FROM groupchat_messages WHERE id > ? AND hidden = 0 ORDER BY id ASC LIMIT ?`)
      .all(intParam(since, Math.floor), limit)) as MessageRow[];
    return { messages: rows.map(messageOf), start: false };
  }
  const before = cursorOf(q.before);
  const rows = (
    before !== null
      ? await db
          .prepare(`SELECT ${MESSAGE_COLUMNS} FROM groupchat_messages WHERE id < ? AND hidden = 0 ORDER BY id DESC LIMIT ?`)
          .all(intParam(before, Math.ceil), limit)
      : await db
          .prepare(`SELECT ${MESSAGE_COLUMNS} FROM groupchat_messages WHERE hidden = 0 ORDER BY id DESC LIMIT ?`)
          .all(limit)
  ) as MessageRow[];
  const messages = rows.map(messageOf).reverse();
  return { messages, start: messages.length < limit };
}

/** The room's tail: the newest `limit` (clamped to 1..200) visible lines, ascending. */
export async function recentMessages(db: Db, limit: number): Promise<StoredMessage[]> {
  return (await readMessages(db, { limit })).messages;
}

/**
 * One line by id, INCLUDING a hidden one — the caller can see `hidden` and
 * decide (a reply to a line its owner has since hidden still needs to resolve).
 */
export async function messageById(db: Db, id: number): Promise<StoredMessage | null> {
  if (!Number.isSafeInteger(id)) return null;
  const row = (await db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM groupchat_messages WHERE id = ?`).get(id)) as
    | MessageRow
    | undefined;
  return row ? messageOf(row) : null;
}

/**
 * When each agent last spoke, said gm and said gn since `sinceMs`, keyed by
 * lowercased tenant.
 *
 * The conductor's schedule lives in memory and a redeploy wipes it; this is
 * how it learns, on its first step, who has already said good morning today
 * instead of greeting the room twice.
 */
export async function agentActivity(
  db: Db,
  sinceMs: number,
): Promise<Map<string, { lastMs: number; lastGmMs: number | null; lastGnMs: number | null }>> {
  const rows = (await db
    .prepare(
      `SELECT tenant,
              MAX(created_at_ms) AS last_ms,
              MAX(CASE WHEN kind = 'gm' THEN created_at_ms END) AS last_gm_ms,
              MAX(CASE WHEN kind = 'gn' THEN created_at_ms END) AS last_gn_ms
         FROM groupchat_messages
        WHERE author_kind = 'agent' AND created_at_ms >= ?
        GROUP BY tenant`,
    )
    .all(intParam(sinceMs, Math.ceil))) as { tenant: string; last_ms: unknown; last_gm_ms: unknown; last_gn_ms: unknown }[];
  const out = new Map<string, { lastMs: number; lastGmMs: number | null; lastGnMs: number | null }>();
  for (const r of rows) {
    out.set(r.tenant, { lastMs: Number(r.last_ms), lastGmMs: nullableNumber(r.last_gm_ms), lastGnMs: nullableNumber(r.last_gn_ms) });
  }
  return out;
}

/**
 * Hide a line for everyone — only when it is an OWNER line written by this
 * tenant. An owner can take back their own words; they can never silence an
 * agent, the room, or another owner. The check and the write are one
 * statement, so there is no read-then-write window.
 *
 * True when the line is (now) hidden and is theirs — hiding twice is still
 * true, so a retried DELETE does not read as "not yours".
 */
export async function hideOwnMessage(db: Db, id: number, tenant: string): Promise<boolean> {
  const who = tenantKey(tenant);
  if (!who || !Number.isSafeInteger(id)) return false;
  const result = await db
    .prepare(`UPDATE groupchat_messages SET hidden = 1 WHERE id = ? AND tenant = ? AND author_kind = 'owner'`)
    .run(id, who);
  return result.changes > 0;
}

/**
 * An owner's lines since `sinceMs`, for the web's rate limit. Hidden lines
 * COUNT: otherwise post-then-hide would be a way around the limit.
 */
export async function countOwnerLinesSince(db: Db, tenant: string, sinceMs: number): Promise<number> {
  const row = (await db
    .prepare(`SELECT COUNT(*) AS n FROM groupchat_messages WHERE tenant = ? AND author_kind = 'owner' AND created_at_ms >= ?`)
    .get(tenantKey(tenant), intParam(sinceMs, Math.ceil))) as { n: unknown } | undefined;
  return row ? Number(row.n) : 0;
}

/**
 * Drop every line older than `beforeMs`. Returns how many went.
 *
 * Replies to a pruned line dangle by design (no FK); the UI shows them without
 * a quote. Dedupe keys go with their rows, which is safe because every keyed
 * line (call, gm, gn) is only ever re-attempted within hours, never weeks.
 */
export async function pruneMessages(db: Db, beforeMs: number): Promise<number> {
  const result = await db
    .prepare("DELETE FROM groupchat_messages WHERE created_at_ms < ?")
    .run(intParam(beforeMs, Math.ceil));
  return result.changes;
}

// ── members ─────────────────────────────────────────────────────────────────

/**
 * One tenant's row, joined or not. A row the web created before the agent was
 * joined reads `joinedAtMs: 0` — its prefs are real, its membership is not yet.
 */
export async function getMember(db: Db, tenant: string): Promise<Member | null> {
  const row = (await db.prepare(`SELECT ${MEMBER_COLUMNS} FROM groupchat_members WHERE tenant = ?`).get(tenantKey(tenant))) as
    | MemberRow
    | undefined;
  return row ? memberOf(row) : null;
}

/** Every member the orchestrator has joined. Prefs-only rows are not members yet (see NOT_JOINED). */
export async function allMembers(db: Db): Promise<Member[]> {
  const rows = (await db
    .prepare(`SELECT ${MEMBER_COLUMNS} FROM groupchat_members WHERE joined_at_ms > ? ORDER BY tenant`)
    .all(NOT_JOINED)) as MemberRow[];
  return rows.map(memberOf);
}

/**
 * Join a tenant to the room: insert it, or claim a prefs-only row the web made
 * first. True exactly once per tenant — the conductor's cue for a join line and
 * a hello — and never touches tz, tz_source or muted.
 *
 * The claim is conditional inside the upsert (DO UPDATE … WHERE), so two
 * replicas joining the same tenant cannot both see true.
 */
export async function joinMember(db: Db, tenant: string, nowMs: number): Promise<boolean> {
  // joined_at_ms 0 means "not joined", so a join stamped at the epoch (a
  // fake clock in a test) must still read as joined.
  const joinedAt = Math.max(1, intParam(nowMs, Math.trunc));
  const row = await db
    .prepare(
      `INSERT INTO groupchat_members (tenant, tz, tz_source, muted, joined_at_ms, updated_at_ms)
       VALUES (?, NULL, NULL, 0, ?, ?)
       ON CONFLICT (tenant) DO UPDATE SET joined_at_ms = excluded.joined_at_ms
       WHERE groupchat_members.joined_at_ms = ?
       RETURNING tenant`,
    )
    .get(tenantKey(tenant), joinedAt, joinedAt, NOT_JOINED);
  return row !== undefined && row !== null;
}

/**
 * Set an owner's room preferences, touching ONLY the fields supplied.
 *
 * `undefined` means "leave it"; `null` for tz/tzSource means "forget it". A
 * tz written from the owner's zone picker and a mute written from the chat
 * screen are separate calls, and neither may reset the other. Creates a
 * prefs-only row (not yet joined) when the tenant has none.
 *
 * A BROWSER CAPTURE NEVER OVERWRITES AN OWNER'S CHOICE. When tzSource is
 * "browser", tz and tz_source change only if the stored source is not
 * "owner". The web route checks this too, but only the statement itself is
 * atomic against a concurrent pick on the chat screen.
 */
export async function setMemberPrefs(
  db: Db,
  tenant: string,
  p: { tz?: string | null; tzSource?: TzSource | null; muted?: boolean },
  nowMs: number,
): Promise<void> {
  const guarded = p.tzSource === "browser";
  const keepOwnerChoice = (column: "tz" | "tz_source") =>
    guarded
      ? `${column} = CASE WHEN groupchat_members.tz_source = 'owner' THEN groupchat_members.${column} ELSE excluded.${column} END`
      : `${column} = excluded.${column}`;
  const sets: string[] = [];
  if (p.tz !== undefined) sets.push(keepOwnerChoice("tz"));
  if (p.tzSource !== undefined) sets.push(keepOwnerChoice("tz_source"));
  if (p.muted !== undefined) sets.push("muted = excluded.muted");
  if (sets.length === 0) return;
  sets.push("updated_at_ms = excluded.updated_at_ms");
  await db
    .prepare(
      `INSERT INTO groupchat_members (tenant, tz, tz_source, muted, joined_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant) DO UPDATE SET ${sets.join(", ")}`,
    )
    .run(tenantKey(tenant), p.tz ?? null, p.tzSource ?? null, p.muted ? 1 : 0, NOT_JOINED, intParam(nowMs, Math.trunc));
}

// ── the room summary ────────────────────────────────────────────────────────

/**
 * Copy exactly the RoomState fields, or null when the shape is wrong.
 *
 * The public GET serves this verbatim to every visitor, so a field that is not
 * in the type — whatever put it there — must never reach the row or the reply.
 */
function roomOf(raw: unknown): RoomState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null);
  const members = count(r.members);
  const awake = count(r.awake);
  const asleep = count(r.asleep);
  const updatedAtMs = count(r.updatedAtMs);
  if (members === null || awake === null || asleep === null || updatedAtMs === null || !Array.isArray(r.presence)) return null;
  const presence: Presence[] = [];
  for (const item of r.presence as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (typeof e.name !== "string" || (e.state !== "awake" && e.state !== "asleep")) continue;
    presence.push({ slug: typeof e.slug === "string" ? e.slug : null, name: e.name, state: e.state });
  }
  return { members, awake, asleep, presence, updatedAtMs };
}

export async function writeRoom(db: Db, room: RoomState): Promise<void> {
  const clean = roomOf(room);
  if (!clean) throw new Error("groupchat: refusing to write a malformed room summary");
  await db
    .prepare(
      `INSERT INTO groupchat_room (k, v, updated_at_ms) VALUES (?, ?, ?)
       ON CONFLICT (k) DO UPDATE SET v = excluded.v, updated_at_ms = excluded.updated_at_ms`,
    )
    .run(ROOM_KEY, JSON.stringify(clean), clean.updatedAtMs);
}

/** The last summary the orchestrator wrote, or null when there is none or it no longer parses. */
export async function readRoom(db: Db): Promise<RoomState | null> {
  const row = (await db.prepare("SELECT v FROM groupchat_room WHERE k = ?").get(ROOM_KEY)) as { v: string } | undefined;
  if (!row) return null;
  try {
    return roomOf(JSON.parse(row.v));
  } catch {
    return null;
  }
}

// ── the public shape ────────────────────────────────────────────────────────

/**
 * A stored line as the session-free GET may show it.
 *
 * Built field by field rather than by deleting from a copy, so a field added
 * to StoredMessage later stays private until somebody decides otherwise. The
 * call is rebuilt too, for the same reason.
 */
export function toPublic(m: StoredMessage): PublicMessage {
  return {
    id: m.id,
    at: m.createdAtMs,
    author: m.authorKind,
    slug: m.speakerSlug,
    name: m.speakerName,
    body: m.body,
    replyTo: m.replyTo,
    kind: m.kind,
    call: m.call
      ? { side: m.call.side, symbol: m.call.symbol, name: m.call.name, token: m.call.token, paper: m.call.paper }
      : null,
  };
}
