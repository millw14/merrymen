/**
 * TELEGRAM GROUP MEMORY, CARRIED ACROSS A HOSTED REDEPLOY.
 *
 * docs/tg-groups.md "Storage and the ferry" is the contract. A child keeps its
 * Telegram groups in one JSON file, `<MERRYMEN_HOME>/tg-groups.json`: rooms,
 * each chat's memory, the at-most-once coin claims and the daily allowances.
 * A hosted child home has no volume, so every redeploy (several a day) would
 * wipe it — the agent would forget every chat, re-answer coins it had already
 * claimed and get a fresh day's model and group-entry allowance. The
 * orchestrator is the one process that sees both a child's home and shared
 * Postgres, so it ferries the file: up on the mirror's clock, down at spawn.
 *
 * THE FILE IS OPAQUE HERE. This module never interprets the memory. It checks
 * only that the text is a JSON object with `version: 1` — on the way up so a
 * torn or foreign file never replaces a good copy, on the way down so a row
 * that opens but is not memory is never handed to a child — and it moves the
 * exact bytes the child wrote.
 *
 * SEALED, BECAUSE IT IS OTHER PEOPLE'S WORDS. The file holds what strangers
 * said in public groups, and notes about them. Shared Postgres is read by the
 * web and the orchestrator; neither has any business reading those lines, and
 * a database dump must not yield them. So the row holds only `sealSecret`
 * ciphertext under the store DEK, which lives in this process's environment
 * and is stripped from every child (CHILD_SECRET_STRIP).
 *
 * AND BOUND TO ITS TENANT. `sealSecret` authenticates the ciphertext but not
 * where it sits, so a row copied onto another tenant's key would still open.
 * The sealed text therefore starts with a header naming the tenant, and a
 * restore refuses a row whose header names anybody else: one agent's group
 * memory can never be handed to another agent's child, whoever edits the
 * table.
 *
 * READ ONLY ON THE WAY UP. Publishing never writes, renames or touches the
 * child's file; a running child is its only writer. The read refuses anything
 * that is not a plain file (a symlink is not followed, a FIFO is never opened)
 * because the home is writable by the child and a read that blocked would
 * stall the fleet loop that supervises every tenant.
 *
 * NEVER THROWS, NEVER SAYS WHAT IT HOLDS. Every function here is called from
 * the orchestrator's loop, so each one catches its own failures and logs them.
 * No log line carries the file's text, the sealed value or the DEK — and a
 * JSON parse error is never quoted, because V8 puts a snippet of the input in
 * its message.
 *
 * NEVER A TRADING INPUT. The row is read only to restore the child's file.
 * Nothing on a trading path reads `tenant_tg_groups`.
 */
import { randomBytes } from "node:crypto";
import { constants as fsc, type Stats } from "node:fs";
import { lstat, open, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";

import type { Db } from "./db";
import { openSecret, sealSecret } from "./store-crypto";

/** In the child's home, beside merrymen.db. The child's store writes it; this only reads it (and restores it before spawn). */
export const TG_GROUPS_FILE_NAME = "tg-groups.json";

/**
 * Past this the file is not the store's: its own caps keep a real one under
 * 512 KB (docs/tg-groups.md), so double that is a bug or a hostile child, and
 * sealing it every pass would be a cost the fleet loop pays for nothing.
 */
export const TG_GROUPS_MAX_BYTES = 1024 * 1024;

/**
 * The one shared table, in the sqlite dialect (db.ts translates INTEGER to
 * BIGINT for Postgres). One row per tenant, replaced whole: the file is the
 * unit, there is nothing to merge.
 */
export const TG_GROUPS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS tenant_tg_groups (
  tenant TEXT PRIMARY KEY,
  sealed TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);`;

/**
 * THE SCHEMA LOCK'S KEY. Distinct from every single-key advisory lock in the
 * repo (auth nonces 1_297_691_982, partner store 1_297_692_081, the room's
 * schema 1_297_692_090, MCP 1_297_692_101, X 1_297_692_110) and from the
 * two-key namespaces (1_297_692_082..084, 091, 103, 111, 112): a shared key
 * would make unrelated first boots queue behind each other.
 */
export const TG_GROUPS_SCHEMA_LOCK = 1_297_692_120;

/**
 * `?` placeholders only in prepared statements (PgDb.exec does not translate
 * them), no quotes in comments, and an upsert that names every column it
 * sets so the conflict branch can never touch anything else.
 */
const UPSERT_SQL =
  "INSERT INTO tenant_tg_groups (tenant, sealed, bytes, updated_at_ms) VALUES (?, ?, ?, ?) " +
  "ON CONFLICT (tenant) DO UPDATE SET sealed = excluded.sealed, bytes = excluded.bytes, updated_at_ms = excluded.updated_at_ms";
const SELECT_SQL = "SELECT sealed FROM tenant_tg_groups WHERE tenant = ?";
const DELETE_SQL = "DELETE FROM tenant_tg_groups WHERE tenant = ?";

/** What the sealed text starts with: the format and the tenant it belongs to, then a newline, then the file. */
const ENVELOPE = "tg-groups/v1";

/** A sealed row is base64 of at most TG_GROUPS_MAX_BYTES plus the header; anything far past it is not ours. */
const SEALED_MAX_CHARS = Math.ceil((TG_GROUPS_MAX_BYTES + 256) * 1.4) + 64;

/** A repeated publish failure is said once per this long per tenant, not once per fifteen-second pass. */
const FAILURE_LOG_EVERY_MS = 20 * 60_000;

export type TgGroupsLog = (line: string) => void;

const defaultLog: TgGroupsLog = (line) => console.log(`[orchestrator] ${line}`);

export type TgGroupsPublish = "unchanged" | "published" | "absent" | "too-big" | "failed";
export type TgGroupsRestore = "restored" | "present" | "none" | "unreadable" | "failed";

// ── schema ──────────────────────────────────────────────────────────────────

const schemaReady = new WeakMap<Db, Promise<void>>();

/**
 * Create the table once per Db for the life of the process.
 *
 * Memoised on the Db, and the entry is dropped on failure so a database that
 * was briefly unreachable is retried on the next call instead of never. On
 * Postgres the DDL runs inside a transaction holding an advisory lock, because
 * two replicas (or a replica and a restart) can boot together and concurrent
 * CREATE TABLE IF NOT EXISTS can still collide in the catalog. Rejects on
 * failure; the orchestrator's callers catch it.
 */
export async function ensureTgGroupsSchema(db: Db, dialect: "postgres" | "sqlite"): Promise<void> {
  const existing = schemaReady.get(db);
  if (existing) return existing;
  const started = (async () => {
    if (dialect === "postgres") {
      await db.tx(async (tx) => {
        await tx.prepare("SELECT pg_advisory_xact_lock(?)").get(TG_GROUPS_SCHEMA_LOCK);
        await tx.exec(TG_GROUPS_TABLE_SQL);
      });
    } else {
      await db.exec(TG_GROUPS_TABLE_SQL);
    }
  })().catch((error: unknown) => {
    if (schemaReady.get(db) === started) schemaReady.delete(db);
    throw error;
  });
  schemaReady.set(db, started);
  return started;
}

// ── small helpers ───────────────────────────────────────────────────────────

/**
 * The row key: the owner's wallet, lowercased, as `childHome` spells it. An
 * id of any other shape is refused rather than stored — it would be a key no
 * later spawn could find, and it is spliced into the sealed header.
 */
function tenantKey(tenant: string): string | null {
  const t = String(tenant ?? "").trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(t) ? t : null;
}

/** A short, content-free reason: an error code or a clipped message, never a value we hold. */
function why(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  const msg = e instanceof Error ? e.message : String(e);
  const line = msg.replace(/\s+/g, " ").slice(0, 160);
  return typeof code === "string" && code && !line.includes(code) ? `${code}: ${line}` : line;
}

/**
 * Which version of the file this is. The inode is in it as well as mtime and
 * size because the child replaces the file by rename: a new file written in
 * the same millisecond with the same length would otherwise read as the old
 * one and never be published.
 */
function fingerprint(st: Stats): string {
  return `${st.ino}:${st.mtimeMs}:${st.size}`;
}

/** A JSON object with `version: 1`. Never throws, and never reports what failed to parse. */
export function isTgGroupsText(text: string): boolean {
  try {
    const v = JSON.parse(text) as unknown;
    return !!v && typeof v === "object" && !Array.isArray(v) && (v as { version?: unknown }).version === 1;
  } catch {
    return false;
  }
}

function envelope(tenant: string, text: string): string {
  return `${ENVELOPE} ${tenant}\n${text}`;
}

/** The file's text from an opened envelope, or null when the envelope is not this tenant's. */
function unwrap(tenant: string, plain: string): string | null {
  const head = `${ENVELOPE} ${tenant}\n`;
  return plain.startsWith(head) ? plain.slice(head.length) : null;
}

/** Read at most `cap` bytes from an open file, so a file growing under us cannot make the read unbounded. */
async function readCapped(fh: FileHandle, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const buf = Buffer.alloc(Math.min(64 * 1024, cap - total));
    if (buf.length === 0) break;
    const { bytesRead } = await fh.read(buf, 0, buf.length, total);
    if (bytesRead === 0) break;
    chunks.push(buf.subarray(0, bytesRead));
    total += bytesRead;
  }
  return Buffer.concat(chunks, total);
}

/**
 * Per `seen` map (one per orchestrator; one per test): which failures were
 * already logged, and which file versions were already refused for what they
 * are, so a bad file costs one lstat per pass rather than a read and a parse.
 */
interface PublishMemo {
  logged: Map<string, { what: string; atMs: number }>;
  refused: Map<string, string>;
}
const publishMemos = new WeakMap<Map<string, string>, PublishMemo>();

function memoOf(seen: Map<string, string>): PublishMemo {
  let m = publishMemos.get(seen);
  if (!m) {
    m = { logged: new Map(), refused: new Map() };
    publishMemos.set(seen, m);
  }
  return m;
}

function logOnce(memo: PublishMemo, log: TgGroupsLog, tenant: string, what: string, line: string): void {
  const now = Date.now();
  const last = memo.logged.get(tenant);
  if (last && last.what === what && now - last.atMs < FAILURE_LOG_EVERY_MS) return;
  memo.logged.set(tenant, { what, atMs: now });
  log(line);
}

// ── up: the child's file to the shared row ──────────────────────────────────

/**
 * Seal the child's file into `tenant_tg_groups` when it changed since the last
 * successful publish. Called on the mirror's clock, only for a tenant whose
 * lease this replica holds healthily — the caller's gate, the same one the
 * ledger mirror uses, because a stale home left in this container by a child
 * that now runs elsewhere must never overwrite the live copy.
 *
 * `seen` holds each tenant's last published file version. It is written only
 * after the upsert succeeded, so any failure is simply tried again next pass.
 *
 *   unchanged — the file is the version already published
 *   published — sealed and upserted
 *   absent    — the child has no file (yet); the stored copy is left alone
 *   too-big   — over TG_GROUPS_MAX_BYTES; refused, the stored copy stands
 *   failed    — not a plain file, not version 1 JSON, or the read, seal or
 *               upsert failed; logged, the stored copy stands
 */
export async function publishTgGroups(o: {
  tenant: string;
  home: string;
  shared: Db;
  dek: Buffer;
  seen: Map<string, string>;
  log?: TgGroupsLog;
}): Promise<TgGroupsPublish> {
  const log = o.log ?? defaultLog;
  const memo = memoOf(o.seen);
  const tenant = tenantKey(o.tenant);
  if (!tenant) {
    log("tg-groups: publish skipped — not a tenant address");
    return "failed";
  }
  try {
    const file = path.join(o.home, TG_GROUPS_FILE_NAME);
    let st: Stats;
    try {
      st = await lstat(file);
    } catch (e) {
      if ((e as { code?: unknown }).code === "ENOENT") {
        // Nothing to carry, and NOT a reason to delete the stored copy: a
        // child whose restore failed has not written yet, and the copy is what
        // its next spawn will want.
        o.seen.delete(tenant);
        return "absent";
      }
      logOnce(memo, log, tenant, "stat", `tg-groups: ${tenant} memory file unreadable — ${why(e)}`);
      return "failed";
    }
    const fp = fingerprint(st);
    if (o.seen.get(tenant) === fp) return "unchanged";
    const refused = memo.refused.get(tenant);
    if (refused === `too-big:${fp}`) return "too-big";
    if (refused === `bad:${fp}`) return "failed";
    if (!st.isFile()) {
      memo.refused.set(tenant, `bad:${fp}`);
      logOnce(memo, log, tenant, `bad:${fp}`, `tg-groups: ${tenant} memory file is not a plain file — not published`);
      return "failed";
    }
    if (st.size > TG_GROUPS_MAX_BYTES) {
      memo.refused.set(tenant, `too-big:${fp}`);
      logOnce(memo, log, tenant, `too-big:${fp}`, `tg-groups: ${tenant} memory file is ${st.size} bytes, over the ${TG_GROUPS_MAX_BYTES} cap — not published`);
      return "too-big";
    }

    // O_NOFOLLOW: the path was a plain file a moment ago, but the home is the
    // child's to change. O_NONBLOCK: a FIFO swapped in since the lstat must
    // fail the isFile check below, not hang this open until a writer appears.
    let buf: Buffer;
    let readFp: string;
    const fh = await open(file, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0) | (fsc.O_NONBLOCK ?? 0));
    try {
      const fst = await fh.stat();
      readFp = fingerprint(fst);
      if (!fst.isFile()) {
        memo.refused.set(tenant, `bad:${fp}`);
        logOnce(memo, log, tenant, `bad:${fp}`, `tg-groups: ${tenant} memory file is not a plain file — not published`);
        return "failed";
      }
      buf = await readCapped(fh, TG_GROUPS_MAX_BYTES + 1);
    } finally {
      await fh.close().catch(() => {});
    }
    if (buf.length > TG_GROUPS_MAX_BYTES) {
      memo.refused.set(tenant, `too-big:${fp}`);
      logOnce(memo, log, tenant, `too-big:${fp}`, `tg-groups: ${tenant} memory file grew past the ${TG_GROUPS_MAX_BYTES} cap — not published`);
      return "too-big";
    }
    const text = buf.toString("utf8");
    if (!isTgGroupsText(text)) {
      // Never replace a good stored copy with something the next restore
      // would refuse. The child rewrites the file atomically, so this is a
      // foreign or broken file, not one caught mid-write.
      memo.refused.set(tenant, `bad:${fp}`);
      logOnce(memo, log, tenant, `bad:${fp}`, `tg-groups: ${tenant} memory file is not version 1 JSON — not published`);
      return "failed";
    }

    const sealed = sealSecret(envelope(tenant, text), o.dek);
    await o.shared.prepare(UPSERT_SQL).run(tenant, sealed, buf.length, Date.now());
    // ONLY NOW. A version remembered before the upsert landed would never be
    // tried again, and the stored copy would silently stop following the file.
    o.seen.set(tenant, readFp);
    memo.refused.delete(tenant);
    memo.logged.delete(tenant);
    return "published";
  } catch (e) {
    logOnce(memo, log, tenant, "publish", `tg-groups: ${tenant} memory not published — ${why(e)}`);
    return "failed";
  }
}

// ── down: the shared row to a fresh child's home ────────────────────────────

/**
 * Put the stored copy back into a child's home, BEFORE the child starts.
 *
 * ONLY WHEN THE HOME HAS NO FILE. A home that kept its file (a crash restart
 * in the same container) holds the newest copy there is — the stored one lags
 * it by up to a mirror pass — and the child is the authority on its own
 * memory. This restores a lost file, never overwrites one.
 *
 * NEVER CREATES THE HOME. The spawn path has made it by the time this runs; a
 * home that is gone belongs to a tenant being removed, and writing would bring
 * the directory back holding its groups.
 *
 *   restored   — written (temp file then rename, mode 0600)
 *   present    — the home already has the file; nothing written
 *   none       — no stored copy; nothing written
 *   unreadable — a stored copy that will not open under this DEK for this
 *                tenant, or opens to something that is not version 1 JSON;
 *                nothing written, and the child's next publish replaces it
 *   failed     — the read or the write failed; nothing written
 */
export async function restoreTgGroups(o: {
  tenant: string;
  home: string;
  shared: Db;
  dek: Buffer;
  log?: TgGroupsLog;
}): Promise<TgGroupsRestore> {
  const log = o.log ?? defaultLog;
  const tenant = tenantKey(o.tenant);
  if (!tenant) {
    log("tg-groups: restore skipped — not a tenant address");
    return "failed";
  }
  const file = path.join(o.home, TG_GROUPS_FILE_NAME);
  if (await exists(file, log, tenant)) return "present";

  let sealed: unknown;
  try {
    const row = (await o.shared.prepare(SELECT_SQL).get(tenant)) as { sealed?: unknown } | undefined;
    if (!row) return "none";
    sealed = row.sealed;
  } catch (e) {
    log(`tg-groups: ${tenant} stored memory could not be read — ${why(e)} (the child starts without its groups)`);
    return "failed";
  }

  let text: string | null = null;
  if (typeof sealed === "string" && sealed.length <= SEALED_MAX_CHARS) {
    try {
      text = unwrap(tenant, openSecret(sealed, o.dek));
    } catch {
      // A tampered tag, another key, or a malformed row. openSecret's message
      // says nothing we hold, but there is nothing in it worth printing either.
      text = null;
    }
  }
  if (text === null || Buffer.byteLength(text, "utf8") > TG_GROUPS_MAX_BYTES || !isTgGroupsText(text)) {
    log(`tg-groups: ${tenant} stored memory is unreadable (tampered, another key or another tenant's) — not restored`);
    return "unreadable";
  }

  // Never mkdir: see above.
  let homeOk = false;
  try {
    homeOk = (await lstat(o.home)).isDirectory();
  } catch {
    homeOk = false;
  }
  if (!homeOk) {
    log(`tg-groups: ${tenant} home is gone — memory not restored`);
    return "failed";
  }

  // A fresh random name opened exclusively, so nothing already at that path
  // (a symlink left by an earlier run of the child included) is followed.
  const tmp = path.join(o.home, `.${TG_GROUPS_FILE_NAME}.${process.pid}.${randomBytes(6).toString("hex")}.restore`);
  try {
    await writeFile(tmp, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    // One more look: a file that appeared meanwhile is the child's own, and
    // this must never replace it.
    if (await exists(file, log, tenant)) {
      await rm(tmp, { force: true });
      return "present";
    }
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    log(`tg-groups: ${tenant} memory could not be written back — ${why(e)}`);
    return "failed";
  }
  return "restored";
}

/** Anything at the path — a plain file, a link, anything — counts as there. An unreadable path counts too: never write over what cannot be seen. */
async function exists(file: string, log: TgGroupsLog, tenant: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (e) {
    if ((e as { code?: unknown }).code === "ENOENT") return false;
    log(`tg-groups: ${tenant} memory file could not be checked — ${why(e)}`);
    return true;
  }
}

// ── the kill switch ─────────────────────────────────────────────────────────

/**
 * Forget a tenant's stored group memory. The kill switch calls this beside
 * removing the child's home: an agent whose grant is gone must not leave
 * strangers' words behind in shared Postgres. Never throws.
 */
export async function deleteTgGroups(tenant: string, shared: Db, log: TgGroupsLog = defaultLog): Promise<void> {
  const key = tenantKey(tenant);
  if (!key) {
    log("tg-groups: delete skipped — not a tenant address");
    return;
  }
  try {
    await shared.prepare(DELETE_SQL).run(key);
  } catch (e) {
    log(`tg-groups: ${key} stored memory could not be deleted — ${why(e)}`);
  }
}
