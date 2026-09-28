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
 * THE FILE IS OPAQUE HERE, but for one thing. It checks that the text is a
 * JSON object with `version: 1` — on the way up so a torn or foreign file
 * never replaces a good copy, on the way down so a row that opens but is not
 * memory is never handed to a child — and it moves the exact bytes the child
 * wrote. The one thing: FORGET REQUESTS.
 *
 * A FORGET REACHES THE STORED COPY WHATEVER THE CHILD HOLDS. The child keeps
 * every /forget and /forgetme in a second file beside the memory
 * (TG_GROUPS_FORGET_FILE, store.ts). A child whose groups are held off started
 * empty, so a forget done there erases nothing, and the sealed row, which
 * still holds the person's lines, would come back at the next restore. So
 * the requests are applied (the store's own applyForgets) wherever the
 * memory is: to what a publish seals, to the stored row directly while a
 * child is held or its file cannot be published (forgetStoredTgGroups), and
 * to what a restore writes back. They are cleared from the home only after a
 * publish of a file that already reflected them, so the child's own memory
 * has caught up too. The row therefore carries every request the ferry has
 * read as its effect, and nothing else needs storing beside it.
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
 * child's memory file; a running child is its only writer. (The forget file
 * is taken away once it is carried, and only ever appended to; see
 * clearForgets.) Every read refuses anything that is not a plain file (a
 * symlink is not followed, a FIFO is never opened) because the home is
 * writable by the child and a read that blocked would stall the fleet loop
 * that supervises every tenant.
 *
 * GONE WITH THE GRANT, FROM THE HOME TOO. A tenant whose grant is gone while
 * no child of it runs here (a restart back-off, a crash-loop stand-down, a
 * fleet halt, a lost lease) still has its files in the home this container
 * keeps, and a re-grant by the same wallet would find them "present" and seal
 * them straight back into Postgres. forgetTgGroupsHome and
 * forgetTgGroupsInHomes remove them.
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
import { constants as fsc, lstatSync, readdirSync, rmSync, type Stats } from "node:fs";
import { link, lstat, open, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";

import type { Db } from "./db";
import { openSecret, sealSecret } from "./store-crypto";
import {
  TG_FORGET_LIMITS,
  TG_GROUPS_FORGET_FILE,
  applyForgets,
  parseTgForgets,
  parseTgGroupsState,
  type TgForgetOp,
} from "./telegram/tg-groups/store";

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
/**
 * Forget requests applied to the stored row in place (forgetStoredTgGroups).
 * An UPDATE that names the row it read, never an insert: a row deleted with
 * the grant meanwhile is not brought back, and one replaced meanwhile is
 * judged afresh on the next pass.
 */
const PATCH_SQL =
  "UPDATE tenant_tg_groups SET sealed = ?, bytes = ?, updated_at_ms = ? WHERE tenant = ? AND sealed = ?";
/**
 * The sweep's pair. Both carry the `updated_at_ms` bound so a row published
 * after the grant listing was read (a tenant granted since, armed by another
 * replica) is never taken for a removed one; see forgetUnwantedTgGroups.
 */
const SWEEP_SELECT_SQL = "SELECT tenant FROM tenant_tg_groups WHERE updated_at_ms < ?";
const SWEEP_DELETE_SQL = "DELETE FROM tenant_tg_groups WHERE tenant = ? AND updated_at_ms < ?";

/**
 * At most this many rows are deleted per reconcile pass. The sweep runs inside
 * the loop that supervises every child, so a backlog (the first deploy of the
 * sweep, a long outage) drains over a few passes instead of holding one.
 */
export const TG_GROUPS_FORGET_BATCH = 25;

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
export type TgGroupsForgetStored = "none" | "unchanged" | "applied" | "failed";

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
  /** Per tenant: the forget file version the stored row is known to reflect, so it is not patched again every pass. */
  stored: Map<string, string>;
}
const publishMemos = new WeakMap<Map<string, string>, PublishMemo>();

function memoOf(seen: Map<string, string>): PublishMemo {
  let m = publishMemos.get(seen);
  if (!m) {
    m = { logged: new Map(), refused: new Map(), stored: new Map() };
    publishMemos.set(seen, m);
  }
  return m;
}

// ── forget requests (store.ts TG_GROUPS_FORGET_FILE) ────────────────────────

const NO_FORGETS = "-";
const FORGETS_UNREADABLE = "?";

/** The forget file's version for a `seen` fingerprint: NO_FORGETS when there is none. Never throws. */
async function forgetsVersion(home: string): Promise<string> {
  try {
    return fingerprint(await lstat(path.join(home, TG_GROUPS_FORGET_FILE)));
  } catch (e) {
    return (e as { code?: unknown }).code === "ENOENT" ? NO_FORGETS : FORGETS_UNREADABLE;
  }
}

interface ForgetsRead {
  ops: TgForgetOp[];
  fp: string;
  ino: number;
  /** Bytes read up to the last complete record: what clearForgets may take away. */
  applied: number;
}

/**
 * The home's forget requests. null when there is no file; "failed" when
 * something is there that cannot be read as one (not a plain file, too big,
 * unreadable). Only complete records count: a record still being appended is
 * left for the next read. Never throws.
 */
async function readForgets(home: string): Promise<ForgetsRead | null | "failed"> {
  const file = path.join(home, TG_GROUPS_FORGET_FILE);
  let fh: FileHandle;
  try {
    // Same flags and reasons as the memory file's read.
    fh = await open(file, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0) | (fsc.O_NONBLOCK ?? 0));
  } catch (e) {
    return (e as { code?: unknown }).code === "ENOENT" ? null : "failed";
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return "failed";
    const buf = await readCapped(fh, TG_FORGET_LIMITS.readBytes + 1);
    if (buf.length > TG_FORGET_LIMITS.readBytes) return "failed";
    const applied = buf.lastIndexOf(0x0a) + 1;
    return { ops: parseTgForgets(buf.subarray(0, applied).toString("utf8")), fp: fingerprint(st), ino: st.ino, applied };
  } catch {
    return "failed";
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * The memory's text with these forget requests applied, or null when it
 * already reflects every one of them (nothing left to erase). `text` is
 * version 1 JSON (isTgGroupsText). Throws only on text that is not JSON.
 */
function forgotten(text: string, ops: readonly TgForgetOp[]): string | null {
  if (ops.length === 0) return null;
  const state = parseTgGroupsState(JSON.parse(text) as unknown);
  const next = JSON.stringify(applyForgets(state, ops));
  return next === JSON.stringify(state) ? null : next;
}

/**
 * Take away the forget file a publish has just carried: the version read,
 * and only it. It is renamed aside first, so the child's next record starts
 * a new file rather than landing in one being deleted, and whatever the child
 * appended after the read is appended back (store.ts appends too, so neither
 * write can overwrite the other). A record the child was writing just as the
 * file was taken, the child writes again itself (store.ts appendForget).
 * True when the file is gone and nothing had to be put back. Never throws.
 */
async function clearForgets(home: string, read: ForgetsRead, log: TgGroupsLog, tenant: string): Promise<boolean> {
  const file = path.join(home, TG_GROUPS_FORGET_FILE);
  const taken = path.join(home, `.${TG_GROUPS_FORGET_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.clear`);
  try {
    await rename(file, taken);
  } catch (e) {
    if ((e as { code?: unknown }).code === "ENOENT") return true;
    log(`tg-groups: ${tenant} forget requests not cleared — ${why(e)} (carried again next pass)`);
    return false;
  }
  try {
    let rest: Buffer = Buffer.alloc(0);
    const fh = await open(taken, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0) | (fsc.O_NONBLOCK ?? 0));
    try {
      const st = await fh.stat();
      if (st.isFile()) {
        const buf = await readCapped(fh, TG_FORGET_LIMITS.readBytes + 1);
        if (buf.length > TG_FORGET_LIMITS.readBytes) throw new Error("the forget file grew past its cap");
        // A different file (the child compacted it meanwhile) is put back whole.
        rest = st.ino === read.ino ? buf.subarray(Math.min(read.applied, buf.length)) : buf;
      }
    } finally {
      await fh.close().catch(() => {});
    }
    const kept = rest.toString("utf8").trim().length > 0;
    if (kept) {
      const out = await open(file, fsc.O_WRONLY | fsc.O_APPEND | fsc.O_CREAT | (fsc.O_NOFOLLOW ?? 0), 0o600);
      try {
        await out.write(Buffer.concat([Buffer.from("\n"), rest, Buffer.from("\n")]));
        await out.sync();
      } finally {
        await out.close().catch(() => {});
      }
    }
    await rm(taken, { force: true });
    return !kept;
  } catch (e) {
    // Put the taken file back where it was, unless the child has started a
    // new one meanwhile (link never replaces anything).
    try {
      await link(taken, file);
      await rm(taken, { force: true });
    } catch {
      /* both failed: said below */
    }
    log(`tg-groups: ${tenant} forget requests could not be put back after clearing — ${why(e)}`);
    return false;
  }
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
 * `seen` holds each tenant's last published file version (and the forget
 * file's beside it). It is written only after the upsert succeeded, so any
 * failure is simply tried again next pass.
 *
 * FORGET REQUESTS in the home are applied to what is sealed, so the row never
 * holds what someone asked to be forgotten, even when the child's file lags
 * the request. When the file already reflected every one of them, the child's
 * own memory has caught up and the forget file is cleared (clearForgets);
 * otherwise it stays, and is applied again to every publish until then.
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
    const forgetsAt = await forgetsVersion(o.home);
    if (o.seen.get(tenant) === `${fp}|${forgetsAt}`) return "unchanged";
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
    let text = buf.toString("utf8");
    if (!isTgGroupsText(text)) {
      // Never replace a good stored copy with something the next restore
      // would refuse. The child rewrites the file atomically, so this is a
      // foreign or broken file, not one caught mid-write.
      memo.refused.set(tenant, `bad:${fp}`);
      logOnce(memo, log, tenant, `bad:${fp}`, `tg-groups: ${tenant} memory file is not version 1 JSON — not published`);
      return "failed";
    }

    // THE FORGET REQUESTS, applied to what is sealed. An unreadable forget
    // file changes nothing here: the child did the forget in its own memory
    // too, so its file is published as written, and the file is never cleared.
    const forgets = forgetsAt === NO_FORGETS ? null : await readForgets(o.home);
    let reflected = true;
    if (forgets === "failed") {
      logOnce(memo, log, tenant, `forgets:${forgetsAt}`, `tg-groups: ${tenant} forget requests unreadable — memory published as the child wrote it`);
    } else if (forgets) {
      const next = forgotten(text, forgets.ops);
      if (next !== null) {
        text = next;
        reflected = false;
      }
    }
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > TG_GROUPS_MAX_BYTES) return "too-big";

    const sealed = sealSecret(envelope(tenant, text), o.dek);
    await o.shared.prepare(UPSERT_SQL).run(tenant, sealed, bytes, Date.now());
    // ONLY NOW. A version remembered before the upsert landed would never be
    // tried again, and the stored copy would silently stop following the file.
    o.seen.set(tenant, `${readFp}|${forgetsAt}`);
    memo.refused.delete(tenant);
    memo.logged.delete(tenant);
    if (forgets && forgets !== "failed") {
      // The row reflects these now, whichever way they got there.
      memo.stored.set(tenant, forgets.fp);
      // Cleared only once the child's own file reflected them: until then its
      // memory still holds what they erase, and a crash restart would open it.
      if (reflected && (await clearForgets(o.home, forgets, log, tenant))) o.seen.set(tenant, `${readFp}|${NO_FORGETS}`);
    }
    return "published";
  } catch (e) {
    logOnce(memo, log, tenant, "publish", `tg-groups: ${tenant} memory not published — ${why(e)}`);
    return "failed";
  }
}

/**
 * FORGET REQUESTS INTO THE STORED ROW, when no publish carries them: the
 * child's groups are held off (its file is not its memory, and nothing of it
 * is published; see tgGroupsHeldOff), or its file was not published this pass
 * (absent, refused, failed). The row is opened, the home's requests applied
 * (applyForgets), and the result sealed back in place, so a /forgetme reaches
 * durable storage even while publishing is held. Called under the same lease
 * gate as publishing: the caller's.
 *
 * Nothing is taken from the home: the child's own memory has not been seen
 * to catch up (clearing is publishTgGroups', once it has). `seen` is the
 * publish map; its memo remembers which forget file version the row already
 * reflects, so a pass with nothing new costs one read of a small file.
 *
 *   none      — no forget file, nothing in it, or no stored row to forget from
 *               (none, or one that will not open, which no restore uses either)
 *   unchanged — the row already reflects every request in the file
 *   applied   — the row was rewritten without what they asked to forget
 *   failed    — the file or the row could not be read, or the write did not
 *               land; logged once, tried again next pass
 */
export async function forgetStoredTgGroups(o: {
  tenant: string;
  home: string;
  shared: Db;
  dek: Buffer;
  seen: Map<string, string>;
  log?: TgGroupsLog;
}): Promise<TgGroupsForgetStored> {
  const log = o.log ?? defaultLog;
  const memo = memoOf(o.seen);
  const tenant = tenantKey(o.tenant);
  if (!tenant) {
    log("tg-groups: forget skipped — not a tenant address");
    return "failed";
  }
  try {
    const read = await readForgets(o.home);
    if (read === null) {
      memo.stored.delete(tenant);
      return "none";
    }
    if (read === "failed") {
      logOnce(memo, log, tenant, "forgets", `tg-groups: ${tenant} forget requests unreadable — not applied to the stored memory`);
      return "failed";
    }
    if (memo.stored.get(tenant) === read.fp) return "unchanged";
    if (read.ops.length === 0) {
      memo.stored.set(tenant, read.fp);
      return "none";
    }
    const row = (await o.shared.prepare(SELECT_SQL).get(tenant)) as { sealed?: unknown } | undefined;
    const text = row ? openRow(tenant, row.sealed, o.dek) : null;
    if (!row || text === null) {
      if (row) logOnce(memo, log, tenant, "forget-unreadable", `tg-groups: ${tenant} stored memory is unreadable — no forget requests to apply to it`);
      memo.stored.set(tenant, read.fp);
      return "none";
    }
    const next = forgotten(text, read.ops);
    if (next === null) {
      memo.stored.set(tenant, read.fp);
      return "unchanged";
    }
    const sealed = sealSecret(envelope(tenant, next), o.dek);
    const r = await o.shared.prepare(PATCH_SQL).run(sealed, Buffer.byteLength(next, "utf8"), Date.now(), tenant, row.sealed);
    if (r?.changes !== 1) {
      logOnce(memo, log, tenant, "forget-raced", `tg-groups: ${tenant} stored memory changed while forget requests were applied — tried again next pass`);
      return "failed";
    }
    memo.stored.set(tenant, read.fp);
    log(`tg-groups: ${tenant} forget requests applied to the stored memory`);
    return "applied";
  } catch (e) {
    logOnce(memo, log, tenant, "forget", `tg-groups: ${tenant} forget requests not applied to the stored memory — ${why(e)} (tried again next pass)`);
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
 * `shared` may be a function that opens the database. It is called only once
 * the home is known to have no file, so a database that cannot be reached
 * never turns a home that kept its file into `failed`: `failed` always means
 * there was no file, which is what tgGroupsHeldOff relies on.
 *
 * The home's forget requests (TG_GROUPS_FORGET_FILE) are applied to what is
 * written, so a forget made while the row could not follow never comes back.
 *
 *   restored   — written (temp file then rename, mode 0600)
 *   present    — the home already has the file; nothing written
 *   none       — no stored copy; nothing written
 *   unreadable — a stored copy that will not open under this DEK for this
 *                tenant, or opens to something that is not version 1 JSON;
 *                nothing written, and the child's next publish replaces it
 *   failed     — the home had no file and the read or the write failed,
 *                or its forget requests could not be read; nothing written
 */
export async function restoreTgGroups(o: {
  tenant: string;
  home: string;
  shared: Db | (() => Promise<Db>);
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
    const shared = typeof o.shared === "function" ? await o.shared() : o.shared;
    const row = (await shared.prepare(SELECT_SQL).get(tenant)) as { sealed?: unknown } | undefined;
    if (!row) return "none";
    sealed = row.sealed;
  } catch (e) {
    log(`tg-groups: ${tenant} stored memory could not be read — ${why(e)} (the child starts without its groups)`);
    return "failed";
  }

  let text = openRow(tenant, sealed, o.dek);
  if (text === null) {
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

  // THE CHILD'S FORGET REQUESTS, applied before the memory goes back: a
  // /forgetme made while its groups were held off, or one the stored row has
  // not caught up with yet. Requests that cannot be read hold the memory
  // back: what they ask to forget would come back with it.
  const forgets = await readForgets(o.home);
  if (forgets === "failed") {
    log(`tg-groups: ${tenant} forget requests in the home are unreadable — memory not restored`);
    return "failed";
  }
  if (forgets) text = forgotten(text, forgets.ops) ?? text;

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

/**
 * A stored row's file text, or null when it will not open under this DEK for
 * this tenant, or opens to something that is not version 1 JSON under the cap.
 */
function openRow(tenant: string, sealed: unknown, dek: Buffer): string | null {
  let text: string | null = null;
  if (typeof sealed === "string" && sealed.length <= SEALED_MAX_CHARS) {
    try {
      text = unwrap(tenant, openSecret(sealed, dek));
    } catch {
      // A tampered tag, another key, or a malformed row. openSecret's message
      // says nothing we hold, but there is nothing in it worth printing either.
      text = null;
    }
  }
  if (text === null || Buffer.byteLength(text, "utf8") > TG_GROUPS_MAX_BYTES || !isTgGroupsText(text)) return null;
  return text;
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

/**
 * MUST THIS CHILD RUN WITH ITS GROUPS HELD OFF? Decided at each spawn from the
 * restore's answer and whether the previous spawn held them off. While held,
 * the orchestrator spawns the child with MERRYMEN_TG_GROUPS=0 and publishes
 * nothing for it, so the stored row stands until a spawn can put it back.
 *
 * FAILED: the home has no file and the row could not be brought down. A child
 * started on an empty memory would write that memory, and the next mirror pass
 * would seal it over the good row: owner-approved rooms back to pending (then
 * asked about and left), and today's model, nomination and entry allowances
 * handed out afresh. Off, it can do none of that.
 *
 * PRESENT, WHILE HELD: the file is the held child's own. The switch still
 * lets it record who added or removed it (docs/tg-groups.md "Operator
 * switch"), so a held child can write a nearly empty file; were that file
 * taken as the child's memory, it would be published over the row the hold
 * exists to protect. It stays held until a spawn finds the home without it —
 * the next redeploy at the latest — and restores the row.
 *
 * Anything else lets go: restored and none leave nothing to protect, and
 * unreadable is a row the child's next publish is meant to replace.
 */
export function tgGroupsHeldOff(r: TgGroupsRestore, heldBefore: boolean): boolean {
  if (r === "failed") return true;
  if (r === "present") return heldBefore;
  return false;
}

// ── the kill switch ─────────────────────────────────────────────────────────

/**
 * Forget a tenant's stored group memory. The kill switch calls this beside
 * removing the child's home, and when a /kill removes the grant or a spawn
 * finds none (beside forgetTgGroupsHome): an agent whose grant is gone must
 * not leave strangers' words behind in shared Postgres.
 * forgetUnwantedTgGroups catches whatever these miss. Never throws.
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

/** Every entry of a home that is Telegram group memory: the file, the forget requests, their temp and set-aside copies. */
const TG_GROUPS_ENTRY = /^\.?tg-groups/;

/**
 * Remove a tenant's Telegram group files from its home: `tg-groups.json`,
 * the forget file, and any temp, set-aside or restore copy of either (every
 * entry named `tg-groups…` or `.tg-groups…`). Nothing else in the home is
 * touched. For a home whose child is NOT running here: a running child is
 * its files' writer, and the kill switch removes its whole home once it is
 * stood down. Synchronous, so no spawn can start between the caller's check
 * and the removal.
 *
 * `before`: only entries last modified before it, so a file a newer grant's
 * child has just been given (see forgetTgGroupsInHomes) is left alone.
 * Returns how many entries went. Never throws.
 */
export function forgetTgGroupsHome(home: string, log: TgGroupsLog = defaultLog, before = Infinity): number {
  let names: string[];
  try {
    names = readdirSync(home);
  } catch {
    return 0; // no home, nothing to remove
  }
  let n = 0;
  for (const name of names) {
    if (!TG_GROUPS_ENTRY.test(name)) continue;
    const full = path.join(home, name);
    try {
      if (before !== Infinity && lstatSync(full).mtimeMs >= before) continue;
      // Recursive only so a directory planted under the name goes too; a
      // symlink is removed itself, never followed.
      rmSync(full, { recursive: true, force: true });
      n++;
    } catch (e) {
      log(`tg-groups: group memory left in a home could not be deleted — ${why(e)} (tried again next pass)`);
    }
  }
  return n;
}

/**
 * THE KILL SWITCH, FOLLOWING THE GRANT STORE INTO THE HOMES. Remove the
 * group files (forgetTgGroupsHome) from the home of every tenant under
 * `childrenDir` that `keep` refuses: the reconcile keeps those it still
 * wants and those running here, so what is left is a grant that is gone.
 *
 * The row sweep cannot do this: it visits only tenants that still have a row,
 * and a home outlives its row. A grant discarded while its child was not
 * running here (a restart back-off, a crash-loop stand-down, a fleet halt, a
 * lost lease, an aborted spawn) left the file, and a re-grant by the same
 * wallet found it "present", used it, and published it back into Postgres.
 *
 * `before` is when the grant listing was requested, as for the row sweep:
 * files written since belong to a newer grant's spawn and are the next
 * pass's to judge. Bounded: at most `max` homes lose files per pass (a home
 * with nothing left costs one directory read). Returns those tenants. Never
 * throws.
 */
export function forgetTgGroupsInHomes(o: {
  childrenDir: string;
  keep: (tenant: string) => boolean;
  before: number;
  max?: number;
  log?: TgGroupsLog;
}): string[] {
  const log = o.log ?? defaultLog;
  const max = o.max ?? TG_GROUPS_FORGET_BATCH;
  let names: string[];
  try {
    names = readdirSync(o.childrenDir);
  } catch {
    return [];
  }
  const gone: string[] = [];
  for (const name of names) {
    if (gone.length >= max) break;
    // Only a home childHome could have made: lowercased 0x + 40 hex.
    if (!/^0x[0-9a-f]{40}$/.test(name) || o.keep(name)) continue;
    if (forgetTgGroupsHome(path.join(o.childrenDir, name), log, o.before) > 0) {
      gone.push(name);
      log(`tg-groups: ${name} grant is gone — group memory left in its home deleted`);
    }
  }
  return gone;
}

/**
 * Which stored rows belong to a tenant the grant store no longer lists. Pure.
 * Only keys the ferry could have written (tenantKey), each once, at most
 * `max`. A malformed key is skipped rather than retried every pass: no
 * publish wrote it, so it holds nothing of an agent's.
 */
export function tgGroupsToForget(
  stored: readonly unknown[],
  wanted: ReadonlySet<string>,
  max: number = TG_GROUPS_FORGET_BATCH,
): string[] {
  const keep = new Set<string>();
  for (const w of wanted) keep.add(tenantKey(w) ?? String(w));
  const out: string[] = [];
  for (const s of stored) {
    if (out.length >= max) break;
    const key = typeof s === "string" ? tenantKey(s) : null;
    if (!key || keep.has(key) || out.includes(key)) continue;
    out.push(key);
  }
  return out;
}

/**
 * THE KILL SWITCH, FOLLOWING THE GRANT STORE. Delete every stored row whose
 * tenant is not in `wanted`, the grant store's own list, read this pass.
 *
 * Deleting beside the home only reached a child running on this replica at
 * that moment. A grant discarded during a redeploy, a restart back-off, a
 * crash-loop stand-down or a fleet halt, or a delete that failed once, left
 * strangers' words sealed in shared Postgres for good, and a later grant by
 * the same wallet restored them. The listing is fleet-wide, so this is right
 * on any replica, and whatever fails here is simply tried on the next pass.
 *
 * `listedAtMs` is when the listing was requested. Only rows last written
 * before it are touched: a row published since belongs to a child armed from a
 * newer listing (a tenant granted a moment ago, running on another replica)
 * and is not this listing's to judge. A removed tenant's child that is still
 * publishing somewhere is caught by a later pass, once it has been stood down.
 *
 * Returns the tenants whose rows were deleted. Never throws.
 */
export async function forgetUnwantedTgGroups(o: {
  shared: Db;
  wanted: ReadonlySet<string>;
  listedAtMs: number;
  log?: TgGroupsLog;
  max?: number;
}): Promise<string[]> {
  const log = o.log ?? defaultLog;
  let doomed: string[];
  try {
    const rows = (await o.shared.prepare(SWEEP_SELECT_SQL).all(o.listedAtMs)) as { tenant?: unknown }[];
    doomed = tgGroupsToForget(
      rows.map((r) => r?.tenant),
      o.wanted,
      o.max,
    );
  } catch (e) {
    log(`tg-groups: stored memory of removed agents not swept this pass — ${why(e)}`);
    return [];
  }
  const gone: string[] = [];
  for (const tenant of doomed) {
    try {
      await o.shared.prepare(SWEEP_DELETE_SQL).run(tenant, o.listedAtMs);
      gone.push(tenant);
      log(`tg-groups: ${tenant} grant is gone — stored memory deleted`);
    } catch (e) {
      log(`tg-groups: ${tenant} stored memory could not be deleted — ${why(e)} (tried again next pass)`);
    }
  }
  return gone;
}
