/**
 * Hosted owner memory, sealed and bound to its tenant before leaving a child.
 * Only the five soul documents and positive-ID DM chat_turns cross this seam;
 * grants, settings, keys and financial tables never do. The orchestrator holds
 * the tenant lease, restores before any writer starts, and ferries on its
 * mirror clock and before retirement. Failed restore MUST refuse that spawn.
 *
 * /forget is write-ahead journalled, then completed after the local wipe. A
 * snapshot records which operation IDs it reflects. Pending operations erase
 * the backed-up scope; completed operations permit newer local memories. This
 * avoids resurrecting private facts and avoids dropping a new DM turn written
 * in the same second as a forget (SQLite timestamps have second precision).
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants as fsc, fstatSync, fsyncSync, lstatSync,
  linkSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, writeSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Db } from "./db";
import { merrymenHome } from "./home";
import { openSecret, sealSecret } from "./store-crypto";

export const PERSONAL_MEMORY_FILES = ["IDENTITY.md", "OWNER.md", "NOTES.md", "JOURNAL.md", "ARCHIVE.md"] as const;
type SoulFile = typeof PERSONAL_MEMORY_FILES[number];
export const PERSONAL_MEMORY_MAX_BYTES = 1024 * 1024;
export const PERSONAL_MEMORY_MAX_CHATS = 64;
export const PERSONAL_MEMORY_TURNS_KEPT = 40;
export const PERSONAL_MEMORY_FORGET_FILE = ".personal-memory-forget.jsonl";
export const PERSONAL_MEMORY_RESTORE_FILE = ".personal-memory-restore.pending";
export const PERSONAL_MEMORY_ERASE_FILE = ".personal-memory-erasure.pending";
export const PERSONAL_MEMORY_SCHEMA_LOCK = 1_297_692_121;
export const PERSONAL_MEMORY_TABLE_SQL = `CREATE TABLE IF NOT EXISTS tenant_personal_memory (
  tenant TEXT PRIMARY KEY, sealed TEXT NOT NULL, bytes INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
);`;
const UPSERT = "INSERT INTO tenant_personal_memory (tenant, sealed, bytes, updated_at_ms) VALUES (?, ?, ?, ?) ON CONFLICT (tenant) DO UPDATE SET sealed = excluded.sealed, bytes = excluded.bytes, updated_at_ms = excluded.updated_at_ms";
const SELECT = "SELECT sealed FROM tenant_personal_memory WHERE tenant = ?";
const PATCH = "UPDATE tenant_personal_memory SET sealed = ?, bytes = ?, updated_at_ms = ? WHERE tenant = ? AND sealed = ?";
const ENVELOPE = "personal-memory/v1";
const MAX_FORGETS = 500;
const JOURNAL_CAP = 256 * 1024;
const CHAT_SCHEMA = `CREATE TABLE IF NOT EXISTS chat_turns (
 id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, role TEXT NOT NULL,
 content TEXT NOT NULL, memory_ids TEXT, at INTEGER NOT NULL DEFAULT (unixepoch())
); CREATE INDEX IF NOT EXISTS chat_turns_chat_time ON chat_turns (chat_id, id DESC);`;
export type PersonalMemoryLog = (line: string) => void;
export type PersonalMemoryPublish = "published" | "unchanged" | "absent" | "too-big" | "failed";
export type PersonalMemoryRestore = "restored" | "present" | "none" | "unreadable" | "failed";
export type PersonalMemoryForgetStored = "none" | "unchanged" | "applied" | "failed";
type ForgetScope = { kind: "owner" } | { kind: "chat"; chatId: number };
export type PersonalMemoryForget = ForgetScope & { id: string; atMs: number; completed: boolean };
interface Turn { role: "user" | "assistant"; content: string; memoryIds?: string[]; at: number }
interface Chat { chatId: number; turns: Turn[] }
interface Snapshot {
  version: 1;
  soul: Partial<Record<SoulFile, string>>;
  chats: Chat[];
  forgets: PersonalMemoryForget[];
  applied: Record<string, string>;
}
interface Pending { version: 1; tenant: string; digest: string; files: SoulFile[]; chats: number[] }
const logDefault: PersonalMemoryLog = (line) => console.log(`[orchestrator] ${line}`);
const schemaReady = new WeakMap<Db, Promise<void>>();
const key = (s: string) => /^0x[0-9a-f]{40}$/.test(s.trim().toLowerCase()) ? s.trim().toLowerCase() : null;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const scope = (o: ForgetScope) => o.kind === "owner" ? "owner" : `chat:${o.chatId}`;
const validChat = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const reason = (e: unknown) => {
  const code = (e as { code?: unknown } | null)?.code;
  // Error messages can contain SQL values, file text or JSON parse snippets.
  return typeof code === "string" && /^[A-Z0-9_]{1,48}$/.test(code) ? code : "operation failed";
};
function fail(log: PersonalMemoryLog, tenant: string, action: string, e?: unknown): void {
  log(`personal-memory: ${tenant} ${action}${e === undefined ? "" : ` (${reason(e)})`}`);
}

export async function ensurePersonalMemorySchema(db: Db, dialect: "sqlite" | "postgres"): Promise<void> {
  const old = schemaReady.get(db);
  if (old) return old;
  const started = (async () => {
    if (dialect === "postgres") await db.tx(async (tx) => {
      await tx.prepare("SELECT pg_advisory_xact_lock(?)").get(PERSONAL_MEMORY_SCHEMA_LOCK);
      await tx.exec(PERSONAL_MEMORY_TABLE_SQL);
    });
    else await db.exec(PERSONAL_MEMORY_TABLE_SQL);
  })().catch((e: unknown) => { schemaReady.delete(db); throw e; });
  schemaReady.set(db, started);
  return started;
}

function plainDirectory(dir: string): boolean {
  try { return lstatSync(dir).isDirectory(); } catch { return false; }
}
function present(file: string): boolean {
  try { lstatSync(file); return true; }
  catch (e) { if ((e as { code?: unknown }).code === "ENOENT") return false; throw e; }
}
function readPlain(file: string, cap: number): string | null {
  if (!present(file)) return null;
  const fd = openSync(file, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0) | (fsc.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > cap) throw new Error("not a bounded plain file");
    const buf = Buffer.alloc(Math.min(st.size + 1, cap + 1));
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got);
      if (!n) break;
      got += n;
    }
    if (got > cap) throw new Error("file grew beyond cap");
    return buf.subarray(0, got).toString("utf8");
  } finally { closeSync(fd); }
}
function syncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeAtomic(file: string, text: string, replace: boolean): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | (fsc.O_NOFOLLOW ?? 0), 0o600);
  try {
    const buf = Buffer.from(text, "utf8");
    let at = 0;
    while (at < buf.length) at += writeSync(fd, buf, at, buf.length - at);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    if (replace) renameSync(tmp, file);
    else { linkSync(tmp, file); rmSync(tmp); }
    syncDir(path.dirname(file));
  } finally { rmSync(tmp, { force: true }); }
}
function validForget(v: unknown): v is PersonalMemoryForget {
  return isObj(v) && (v.kind === "owner" || (v.kind === "chat" && validChat(v.chatId)))
    && typeof v.id === "string" && /^[0-9a-f-]{36}$/.test(v.id)
    && typeof v.atMs === "number" && Number.isSafeInteger(v.atMs) && v.atMs >= 0
    && typeof v.completed === "boolean";
}
function mergeForgets(...lists: readonly PersonalMemoryForget[][]): PersonalMemoryForget[] {
  const byScope = new Map<string, PersonalMemoryForget>();
  for (const list of lists) for (const op of list) {
    const old = byScope.get(scope(op));
    if (!old || op.atMs > old.atMs || (op.atMs === old.atMs && op.id > old.id)) byScope.set(scope(op), { ...op });
    else if (op.id === old.id && op.completed) old.completed = true;
  }
  if (byScope.size > MAX_FORGETS) throw new Error("forget scope cap");
  return [...byScope.values()].sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
}
function readForgets(home: string): PersonalMemoryForget[] {
  const text = readPlain(path.join(home, PERSONAL_MEMORY_FORGET_FILE), JOURNAL_CAP);
  if (text === null) return [];
  const records: PersonalMemoryForget[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    // A torn or unknown record must fail closed, not erase the privacy request.
    const op: unknown = JSON.parse(line);
    if (!validForget(op)) throw new Error("invalid forget journal");
    records.push(op);
  }
  return mergeForgets(records);
}
function appendForget(home: string, op: PersonalMemoryForget): void {
  if (!plainDirectory(home)) throw new Error("memory home missing");
  const file = path.join(home, PERSONAL_MEMORY_FORGET_FILE);
  const old = readForgets(home);
  const compacted = mergeForgets(old, [op]);
  // Single local writer; the ferry never clears this journal concurrently.
  writeAtomic(file, compacted.map((o) => JSON.stringify(o)).join("\n") + "\n", true);
}

/** Must succeed before changing any private local memory or acknowledging /forget. */
export function recordPersonalMemoryForget(wanted: ForgetScope, home = merrymenHome()): PersonalMemoryForget {
  if (wanted.kind === "chat" && !validChat(wanted.chatId)) throw new Error("personal memory is DM only");
  mkdirSync(home, { recursive: true });
  const ops = readForgets(home);
  const last = ops.find((o) => scope(o) === scope(wanted));
  const op: PersonalMemoryForget = { ...wanted, id: randomUUID(), atMs: Math.max(Date.now(), (last?.atMs ?? -1) + 1), completed: false };
  appendForget(home, op);
  return op;
}
/** Only after the actual local mutation succeeded. Failure remains conservative. */
export function completePersonalMemoryForget(op: PersonalMemoryForget, home = merrymenHome()): void {
  appendForget(home, { ...op, completed: true });
}

function cleanSnapshot(raw: unknown): Snapshot | null {
  if (!isObj(raw) || raw.version !== 1 || !isObj(raw.soul) || !Array.isArray(raw.chats)
      || raw.chats.length > PERSONAL_MEMORY_MAX_CHATS || !Array.isArray(raw.forgets)
      || raw.forgets.length > MAX_FORGETS || !raw.forgets.every(validForget) || !isObj(raw.applied)) return null;
  const soul: Partial<Record<SoulFile, string>> = {};
  for (const [name, text] of Object.entries(raw.soul)) {
    if (!PERSONAL_MEMORY_FILES.includes(name as SoulFile) || typeof text !== "string"
        || Buffer.byteLength(text) > PERSONAL_MEMORY_MAX_BYTES) return null;
    soul[name as SoulFile] = text;
  }
  const ids = new Set<number>();
  const chats: Chat[] = [];
  for (const c of raw.chats) {
    if (!isObj(c) || !validChat(c.chatId) || ids.has(c.chatId) || !Array.isArray(c.turns)
        || c.turns.length > PERSONAL_MEMORY_TURNS_KEPT) return null;
    ids.add(c.chatId);
    const turns: Turn[] = [];
    for (const t of c.turns) {
      if (!isObj(t) || (t.role !== "user" && t.role !== "assistant") || typeof t.content !== "string"
          || Buffer.byteLength(t.content) > 16 * 1024 || typeof t.at !== "number" || !Number.isSafeInteger(t.at) || t.at < 0
          || (t.memoryIds !== undefined && (!Array.isArray(t.memoryIds) || t.memoryIds.length > 64
            || !t.memoryIds.every((id) => typeof id === "string" && id.length <= 256)))) return null;
      turns.push({ role: t.role, content: t.content, at: t.at, ...(t.memoryIds === undefined ? {} : { memoryIds: t.memoryIds as string[] }) });
    }
    chats.push({ chatId: c.chatId, turns });
  }
  const forgets = mergeForgets(raw.forgets);
  const applied: Record<string, string> = {};
  for (const [s, id] of Object.entries(raw.applied)) {
    if (!forgets.some((op) => scope(op) === s && op.id === id)) return null;
    applied[s] = id as string;
  }
  return { version: 1, soul, chats, forgets, applied };
}
function applyForgets(snapshot: Snapshot, ops: PersonalMemoryForget[]): Snapshot {
  const next: Snapshot = { ...snapshot, soul: { ...snapshot.soul }, chats: snapshot.chats.map((c) => ({ ...c, turns: [...c.turns] })),
    forgets: mergeForgets(snapshot.forgets, ops), applied: { ...snapshot.applied } };
  for (const op of next.forgets) {
    const s = scope(op);
    if (next.applied[s] === op.id) continue;
    if (op.kind === "owner") {
      next.soul["OWNER.md"] = "";
      // Archive mixes evicted owner facts and notes. Privacy wins over retaining notes here.
      next.soul["ARCHIVE.md"] = "";
    } else next.chats = next.chats.filter((c) => c.chatId !== op.chatId);
    next.applied[s] = op.id;
  }
  // Completion in a sealed snapshot means its DATA reflects the operation;
  // only the local journal's completion records attest the local wipe.
  next.forgets = next.forgets.map((op) => ({ ...op, completed: true }));
  return next;
}
function openSnapshot(tenant: string, sealed: unknown, dek: Buffer): Snapshot | null {
  if (typeof sealed !== "string" || sealed.length > PERSONAL_MEMORY_MAX_BYTES * 1.5 + 512) return null;
  try {
    const head = `${ENVELOPE} ${tenant}\n`;
    const plain = openSecret(sealed, dek);
    if (!plain.startsWith(head) || Buffer.byteLength(plain) > PERSONAL_MEMORY_MAX_BYTES + 128) return null;
    return cleanSnapshot(JSON.parse(plain.slice(head.length)));
  } catch { return null; }
}
function sealedSnapshot(tenant: string, snapshot: Snapshot, dek: Buffer): { sealed: string; bytes: number } {
  const text = JSON.stringify(snapshot);
  const bytes = Buffer.byteLength(text);
  if (bytes > PERSONAL_MEMORY_MAX_BYTES) throw new Error("snapshot cap");
  return { sealed: sealSecret(`${ENVELOPE} ${tenant}\n${text}`, dek), bytes };
}
function dbPlain(home: string, create: boolean): DatabaseSync | null {
  const file = path.join(home, "merrymen.db");
  if (!present(file) && !create) return null;
  if (present(file) && !lstatSync(file).isFile()) throw new Error("not a plain database");
  const db = new DatabaseSync(file, { readOnly: !create });
  db.exec("PRAGMA busy_timeout = 250");
  return db;
}
function readChats(db: DatabaseSync | null): Chat[] {
  if (!db || !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_turns'").get()) return [];
  const rows = db.prepare(`SELECT chat_id, role, content, memory_ids, at FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY id DESC) AS memory_row FROM chat_turns WHERE chat_id > 0
  ) WHERE memory_row <= ? ORDER BY chat_id, id LIMIT ?`).all(PERSONAL_MEMORY_TURNS_KEPT, PERSONAL_MEMORY_MAX_CHATS * PERSONAL_MEMORY_TURNS_KEPT + 1);
  const byChat = new Map<number, Chat>();
  for (const r of rows) {
    const id = Number(r.chat_id);
    let chat = byChat.get(id);
    if (!chat) { chat = { chatId: id, turns: [] }; byChat.set(id, chat); }
    chat.turns.push({ role: r.role as Turn["role"], content: r.content as string, at: Number(r.at),
      ...(r.memory_ids === null ? {} : { memoryIds: JSON.parse(r.memory_ids as string) as string[] }) });
  }
  if (byChat.size > PERSONAL_MEMORY_MAX_CHATS || rows.length > PERSONAL_MEMORY_MAX_CHATS * PERSONAL_MEMORY_TURNS_KEPT) throw new Error("chat cap");
  return [...byChat.values()];
}
function localSnapshot(home: string, forgets: PersonalMemoryForget[]): Snapshot {
  if (!plainDirectory(home)) throw new Error("home missing");
  const soulDir = path.join(home, "soul");
  if (present(soulDir) && !plainDirectory(soulDir)) throw new Error("soul is not a directory");
  const soul: Partial<Record<SoulFile, string>> = {};
  for (const name of PERSONAL_MEMORY_FILES) {
    const text = readPlain(path.join(soulDir, name), PERSONAL_MEMORY_MAX_BYTES);
    if (text !== null) soul[name] = text;
  }
  const db = dbPlain(home, false);
  let chats: Chat[];
  try { chats = readChats(db); } finally { db?.close(); }
  const applied = Object.fromEntries(forgets.filter((o) => o.completed).map((o) => [scope(o), o.id]));
  const snapshot = cleanSnapshot({ version: 1, soul, chats, forgets, applied });
  if (!snapshot) throw new Error("invalid local memory");
  return applyForgets(snapshot, forgets);
}

function pendingLocalForgetsAreClear(home: string, ops: PersonalMemoryForget[]): boolean {
  const pending = ops.filter((op) => !op.completed);
  if (!pending.length) return true;
  const soulDir = path.join(home, "soul");
  if (present(soulDir) && !plainDirectory(soulDir)) return false;
  for (const op of pending) if (op.kind === "owner") {
    for (const name of ["OWNER.md", "ARCHIVE.md"] as const) {
      const text = readPlain(path.join(soulDir, name), PERSONAL_MEMORY_MAX_BYTES);
      if (text !== null && text !== "") return false;
    }
  }
  if (pending.some((op) => op.kind === "chat")) {
    const db = dbPlain(home, false);
    let chats: Chat[];
    try { chats = readChats(db); } finally { db?.close(); }
    if (pending.some((op) => op.kind === "chat" && chats.some((c) => c.chatId === op.chatId))) return false;
  }
  return true;
}

/** Read-only whitelist capture for a predeploy rescue. Only ciphertext may leave the container. */
export function capturePersonalMemoryExport(o: { tenant: string; home: string; dek: Buffer }): {
  tenant: string; sealed: string; bytes: number; soulFiles: number; dmChats: number; dmTurns: number; sha256: string;
} | null {
  const tenant = key(o.tenant);
  if (!tenant) throw new Error("invalid personal-memory tenant");
  try {
    if (present(path.join(o.home, PERSONAL_MEMORY_RESTORE_FILE)) || present(path.join(o.home, PERSONAL_MEMORY_ERASE_FILE))) throw new Error("restore/erase pending");
    const snapshot = localSnapshot(o.home, readForgets(o.home));
    if (!Object.keys(snapshot.soul).length && !snapshot.chats.length && !snapshot.forgets.length) return null;
    const row = sealedSnapshot(tenant, snapshot, o.dek);
    return { tenant, ...row, soulFiles: Object.keys(snapshot.soul).length,
      dmChats: snapshot.chats.length, dmTurns: snapshot.chats.reduce((n, c) => n + c.turns.length, 0), sha256: hash(row.sealed) };
  } catch { throw new Error("personal-memory export refused: unsafe, unavailable or oversized source"); }
}

export async function publishPersonalMemory(o: {
  tenant: string; home: string; shared: Db; dek: Buffer; seen: Map<string, string>; log?: PersonalMemoryLog;
}): Promise<PersonalMemoryPublish> {
  const tenant = key(o.tenant); const log = o.log ?? logDefault;
  if (!tenant) return "failed";
  try {
    if (present(path.join(o.home, PERSONAL_MEMORY_RESTORE_FILE)) || present(path.join(o.home, PERSONAL_MEMORY_ERASE_FILE))) return "failed";
    const forgets = readForgets(o.home);
    let snapshot = localSnapshot(o.home, forgets);
    if (!Object.keys(snapshot.soul).length && !snapshot.chats.length && !snapshot.forgets.length) return "absent";
    const previous = await o.shared.prepare(SELECT).get(tenant) as { sealed?: unknown } | undefined;
    if (previous) {
      const old = openSnapshot(tenant, previous.sealed, o.dek);
      if (!old) { fail(log, tenant, "stored memory unreadable — publish refused"); return "failed"; }
      // Stored tombstones may outlive this home. Do not discard their privacy effect.
      snapshot = applyForgets(snapshot, old.forgets);
    }
    const text = JSON.stringify(snapshot);
    if (Buffer.byteLength(text) > PERSONAL_MEMORY_MAX_BYTES) return "too-big";
    const digest = hash(text);
    if (o.seen.get(tenant) === digest) return "unchanged";
    const row = sealedSnapshot(tenant, snapshot, o.dek);
    await o.shared.prepare(UPSERT).run(tenant, row.sealed, row.bytes, Date.now());
    o.seen.set(tenant, digest);
    return "published";
  } catch (e) { fail(log, tenant, "publish refused; stored memory retained", e); return "failed"; }
}

export async function forgetStoredPersonalMemory(o: {
  tenant: string; home: string; shared: Db; dek: Buffer; log?: PersonalMemoryLog;
}): Promise<PersonalMemoryForgetStored> {
  const tenant = key(o.tenant); const log = o.log ?? logDefault;
  if (!tenant) return "failed";
  try {
    const ops = readForgets(o.home);
    if (!ops.length) return "none";
    const previous = await o.shared.prepare(SELECT).get(tenant) as { sealed?: unknown } | undefined;
    if (!previous) return "none";
    const old = openSnapshot(tenant, previous.sealed, o.dek);
    if (!old) return "failed";
    const next = applyForgets(old, ops);
    if (JSON.stringify(old) === JSON.stringify(next)) return "unchanged";
    const row = sealedSnapshot(tenant, next, o.dek);
    const r = await o.shared.prepare(PATCH).run(row.sealed, row.bytes, Date.now(), tenant, previous.sealed);
    return r.changes > 0 ? "applied" : "failed";
  } catch (e) { fail(log, tenant, "forget not yet applied; will retry", e); return "failed"; }
}

/** Missing components only. A pending marker makes partial restores retryable and unpublishable. */
export async function restorePersonalMemory(o: {
  tenant: string; home: string; shared: Db | (() => Promise<Db>); dek: Buffer; log?: PersonalMemoryLog;
}): Promise<PersonalMemoryRestore> {
  const tenant = key(o.tenant); const log = o.log ?? logDefault;
  if (!tenant) return "failed";
  const markerFile = path.join(o.home, PERSONAL_MEMORY_RESTORE_FILE);
  try {
    if (!plainDirectory(o.home)) return "failed";
    if (present(path.join(o.home, PERSONAL_MEMORY_ERASE_FILE))) return "failed";
    // Check local privacy even before the first shared snapshot exists. A
    // first-rollout/no-row restart must not expose an unfinished local forget.
    const localOps = readForgets(o.home);
    if (!pendingLocalForgetsAreClear(o.home, localOps)) return "failed";
    const shared = typeof o.shared === "function" ? await o.shared() : o.shared;
    const row = await shared.prepare(SELECT).get(tenant) as { sealed?: unknown } | undefined;
    if (!row) {
      if (present(markerFile)) return "failed";
      // The scope is provably empty and there is no older sealed copy. Complete
      // that request before admitting fresh messages, so they are not erased.
      for (const op of localOps.filter((o) => !o.completed)) completePersonalMemoryForget(op, o.home);
      return "none";
    }
    const stored = openSnapshot(tenant, row.sealed, o.dek);
    if (!stored) { fail(log, tenant, "restore refused: unreadable ciphertext"); return "unreadable"; }
    const snapshot = applyForgets(stored, localOps);
    const digest = hash(JSON.stringify(snapshot));
    const soulDir = path.join(o.home, "soul");
    if (present(soulDir) && !plainDirectory(soulDir)) return "failed";
    const markerText = readPlain(markerFile, 16 * 1024);
    let pending: Pending;
    if (markerText !== null) {
      const p: unknown = JSON.parse(markerText);
      if (!isObj(p) || p.version !== 1 || p.tenant !== tenant || p.digest !== digest
          || !Array.isArray(p.files) || p.files.length > PERSONAL_MEMORY_FILES.length || !p.files.every((f) => PERSONAL_MEMORY_FILES.includes(f as SoulFile))
          || !Array.isArray(p.chats) || p.chats.length > PERSONAL_MEMORY_MAX_CHATS || !p.chats.every(validChat)) return "failed";
      pending = p as unknown as Pending;
    } else {
      const db = dbPlain(o.home, false);
      let existing: Chat[];
      try { existing = readChats(db); } finally { db?.close(); }
      // A remote forget unknown to this home may not be acknowledged over existing stale memory.
      for (const op of snapshot.forgets) if (!localOps.some((l) => l.id === op.id)) {
        if (op.kind === "chat" && existing.some((c) => c.chatId === op.chatId)) return "failed";
        if (op.kind === "owner") for (const name of ["OWNER.md", "ARCHIVE.md"] as const) {
          const text = readPlain(path.join(soulDir, name), PERSONAL_MEMORY_MAX_BYTES);
          if (text !== null && text !== (snapshot.soul[name] ?? "")) return "failed";
        }
      }
      pending = { version: 1, tenant, digest,
        files: PERSONAL_MEMORY_FILES.filter((f) => snapshot.soul[f] !== undefined && !present(path.join(soulDir, f))),
        chats: snapshot.chats.filter((c) => !existing.some((e) => e.chatId === c.chatId)).map((c) => c.chatId) };
      writeAtomic(markerFile, JSON.stringify(pending), false);
    }
    if (pending.files.length) mkdirSync(soulDir, { recursive: true });
    for (const name of pending.files) {
      const wanted = snapshot.soul[name];
      if (wanted === undefined) return "failed";
      const file = path.join(soulDir, name);
      const existing = readPlain(file, PERSONAL_MEMORY_MAX_BYTES);
      if (existing === null) writeAtomic(file, wanted, false);
      else if (existing !== wanted) return "failed";
    }
    if (pending.chats.length) {
      const db = dbPlain(o.home, true)!;
      try {
        db.exec(CHAT_SCHEMA);
        db.exec("BEGIN IMMEDIATE");
        for (const chatId of pending.chats) {
          const wanted = snapshot.chats.find((c) => c.chatId === chatId);
          if (!wanted) throw new Error("missing restore chat");
          const existing = readChats(db).find((c) => c.chatId === chatId);
          if (existing) {
            if (JSON.stringify(existing) !== JSON.stringify(wanted)) throw new Error("restore chat changed");
          } else for (const t of wanted.turns) db.prepare("INSERT INTO chat_turns (chat_id, role, content, memory_ids, at) VALUES (?, ?, ?, ?, ?)")
            .run(chatId, t.role, t.content, t.memoryIds === undefined ? null : JSON.stringify(t.memoryIds), t.at);
        }
        db.exec("COMMIT");
      } catch (e) { try { db.exec("ROLLBACK"); } catch { /* not active */ } throw e; }
      finally { db.close(); }
    }
    // The restored data now reflects every stored/local operation. Carry those
    // completed IDs into this new home before it can publish or accept turns.
    if (snapshot.forgets.length) writeAtomic(path.join(o.home, PERSONAL_MEMORY_FORGET_FILE),
      mergeForgets(readForgets(o.home), snapshot.forgets).map((op) => JSON.stringify({ ...op, completed: true })).join("\n") + "\n", true);
    rmSync(markerFile); syncDir(o.home);
    return pending.files.length || pending.chats.length ? "restored" : "present";
  } catch (e) { fail(log, tenant, "restore incomplete; spawn must wait", e); return "failed"; }
}

export async function deletePersonalMemory(tenant: string, shared: Db, log: PersonalMemoryLog = logDefault): Promise<void> {
  const t = key(tenant); if (!t) return;
  try { await shared.prepare("DELETE FROM tenant_personal_memory WHERE tenant = ?").run(t); }
  catch (e) { fail(log, t, "delete failed; will retry", e); }
}

/** Explicit removal also clears a stopped local home, so re-grant cannot republish it. */
export function forgetPersonalMemoryHome(home: string, log: PersonalMemoryLog = logDefault, before = Infinity): number {
  if (!plainDirectory(home)) return 0;
  let removed = 0;
  let complete = true;
  const barrier = path.join(home, PERSONAL_MEMORY_ERASE_FILE);
  const removeOlder = (file: string) => {
    try {
      const st = lstatSync(file);
      if (st.mtimeMs >= before) return;
      rmSync(file, { force: true }); removed++;
    } catch (e) { if ((e as { code?: unknown }).code !== "ENOENT") { complete = false; fail(log, "home", "local forget incomplete; will retry", e); } }
  };
  try {
    const dir = path.join(home, "soul");
    const files = plainDirectory(dir)
      ? readdirSync(dir).filter((name) => /^\.?(IDENTITY|OWNER|NOTES|JOURNAL|ARCHIVE)\.md(?:\.|$)/.test(name)).map((name) => path.join(dir, name))
      : present(dir) ? [dir] : [];
    files.push(...readdirSync(home).filter((name) => /^\.personal-memory-(forget\.jsonl|restore\.pending)(?:\.|$)/.test(name)).map((name) => path.join(home, name)));
    const file = path.join(home, "merrymen.db");
    // A stale roster must not partially erase a home refreshed since it was read.
    if ([...files, ...(present(file) ? [file] : [])].some((f) => lstatSync(f).mtimeMs >= before)) return 0;
    writeAtomic(barrier, JSON.stringify({ version: 1 }), true);
    if (present(file) && !lstatSync(file).isFile()) throw new Error("not a plain database");
    if (present(file) && lstatSync(file).isFile() && lstatSync(file).mtimeMs < before) {
      const db = dbPlain(home, true)!;
      try {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_turns'").get()) {
          removed += Number(db.prepare("DELETE FROM chat_turns WHERE chat_id > 0").run().changes);
        }
      } finally { db.close(); }
    }
    for (const file of files) removeOlder(file);
    if (complete) { rmSync(barrier, { force: true }); syncDir(home); }
  } catch (e) { fail(log, "home", "local forget incomplete; erasure barrier retained", e); }
  return removed;
}

/** Bounded stale-home cleanup; the caller excludes every child/holder still running here. */
export function forgetPersonalMemoryInHomes(o: {
  childrenDir: string; wanted: ReadonlySet<string>; running: ReadonlySet<string>; before: number; log?: PersonalMemoryLog;
}): number {
  if (!plainDirectory(o.childrenDir) || !Number.isFinite(o.before)) return 0;
  const wanted = new Set([...o.wanted].map((s) => s.toLowerCase()));
  const running = new Set([...o.running].map((s) => s.toLowerCase()));
  let touched = 0;
  try {
    for (const name of readdirSync(o.childrenDir)) {
      const tenant = key(name);
      if (!tenant || wanted.has(tenant) || running.has(tenant)) continue;
      if (touched >= 25) break;
      if (forgetPersonalMemoryHome(path.join(o.childrenDir, name), o.log, o.before) > 0) touched++;
    }
  } catch (e) { fail(o.log ?? logDefault, "sweep", "local forget unavailable; will retry", e); }
  return touched;
}

/** Roster membership includes expired/replacement grants. Only actual deletion removes memory. */
export async function forgetUnwantedPersonalMemory(o: {
  shared: Db; wanted: ReadonlySet<string>; listedAtMs: number; log?: PersonalMemoryLog;
}): Promise<number> {
  const log = o.log ?? logDefault;
  if (!Number.isFinite(o.listedAtMs)) return 0;
  try {
    const rows = await o.shared.prepare("SELECT tenant FROM tenant_personal_memory WHERE updated_at_ms < ?").all(o.listedAtMs) as { tenant?: unknown }[];
    let removed = 0;
    const wanted = new Set([...o.wanted].map((t) => t.toLowerCase()));
    for (const row of rows) {
      if (removed >= 25) break;
      if (typeof row.tenant !== "string" || !key(row.tenant) || wanted.has(row.tenant.toLowerCase())) continue;
      removed += (await o.shared.prepare("DELETE FROM tenant_personal_memory WHERE tenant = ? AND updated_at_ms < ?").run(row.tenant, o.listedAtMs)).changes;
    }
    return removed;
  } catch (e) { fail(log, "sweep", "delete pass failed", e); return 0; }
}
