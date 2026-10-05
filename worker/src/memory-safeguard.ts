/**
 * One-off, reviewed predeploy backup. This is not an orchestrator job.
 * Capture reads only the public roster, five soul files, positive-ID DM turns,
 * group memory and forget journals. It never copies a raw database or grant.
 * Seed is insert-only and requires a quiescent, single-replica source: an old
 * live-writer snapshot is useful backup evidence, never a lossless handover.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readSync, readdirSync, rmSync, writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Db } from "./db";
import { wrapSqlite } from "./db";
import {
  capturePersonalMemoryExport, ensurePersonalMemorySchema, restorePersonalMemory,
  PERSONAL_MEMORY_MAX_BYTES,
} from "./personal-memory-ferry";
import { openSecret, sealSecret } from "./store-crypto";
import {
  ensureTgGroupsSchema, isTgGroupsText, restoreTgGroups, TG_GROUPS_FILE_NAME,
  TG_GROUPS_MAX_BYTES,
} from "./tg-groups-ferry";
import {
  applyForgets, parseTgForgets, parseTgGroupsState, TG_FORGET_LIMITS, TG_GROUPS_FORGET_FILE,
} from "./telegram/tg-groups/store";
import { cleanForget } from "./telegram/tg-groups/forget-file";

const MAX_TENANTS = 128;
const BACKUP_MAX_BYTES = 384 * 1024 * 1024;
const ENVELOPE = "memory-safeguard/v1\n";
const ADDRESS = /^0x[0-9a-f]{40}$/;
const silent = () => {};
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const refuse = () => new Error("Memory safeguard refused: source, identity, privacy journal or stored snapshot could not be verified.");
function canonical(v: unknown): string {
  const ordered = (x: unknown): unknown => Array.isArray(x) ? x.map(ordered)
    : x !== null && typeof x === "object" ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, ordered(value)])) : x;
  return JSON.stringify(ordered(v));
}
function personalContent(tenant: string, sealed: string, dek: Buffer): string {
  const head = `personal-memory/v1 ${tenant}\n`, plain = openSecret(sealed, dek);
  if (!plain.startsWith(head)) throw refuse();
  const raw = JSON.parse(plain.slice(head.length)) as { version: unknown; soul: unknown; chats: unknown; forgets: Array<Record<string, unknown>>; applied: unknown };
  // Restore completes pending privacy journal operations. The identity, scope,
  // timestamps, applied IDs and every actual memory byte must still match.
  return canonical({ ...raw, forgets: raw.forgets.map(({ completed, ...op }) => { void completed; return op; }) });
}

export interface MemorySource {
  deploymentId: string;
  gitCommit: string;
  orchestratorPid: number;
  orchestratorStart: string;
  quiescent: boolean;
  singleReplicaConfirmed: boolean;
}
export interface MemoryRosterEntry { tenant: string; smartAccount: string; updatedAt: string; rowVersion: string }
type PersonalExport = NonNullable<ReturnType<typeof capturePersonalMemoryExport>>;
interface GroupExport { sealed: string; bytes: number; rooms: number; sha256: string }
interface Entry extends MemoryRosterEntry {
  homeDev: string | null; homeIno: string | null;
  personal: PersonalExport | null;
  groups: GroupExport | null;
}
export interface MemoryBackup {
  version: 1;
  id: string;
  capturedAtMs: number;
  source: MemorySource;
  entries: Entry[];
  roster: MemoryRosterEntry[];
}
export interface MemoryBackupCounts {
  tenants: number; personalSnapshots: number; soulFiles: number; dmChats: number;
  dmTurns: number; groupSnapshots: number; groupRooms: number; rosterWithoutHome: number; historicalMemoryGaps: number;
}

/** Public projections only. No grant JSON, serialized key or ciphertext key is returned. */
export async function readMemoryRoster(shared: Db): Promise<MemoryRosterEntry[]> {
  const rows = await shared.prepare(
    "SELECT tenant, lower(grant_json->>'smartAccount') AS smart_account, updated_at::text AS updated_at, xmin::text AS row_version FROM grants ORDER BY tenant LIMIT 129",
  ).all() as Array<{ tenant?: unknown; smart_account?: unknown; updated_at?: unknown; row_version?: unknown }>;
  if (rows.length > MAX_TENANTS) throw refuse();
  const roster = rows.map(row => {
    if (typeof row.tenant !== "string" || !ADDRESS.test(row.tenant)
        || typeof row.smart_account !== "string" || !ADDRESS.test(row.smart_account)
        || typeof row.updated_at !== "string" || !/^\d{1,20}$/.test(row.updated_at)
        || typeof row.row_version !== "string" || !/^\d{1,20}$/.test(row.row_version)) throw refuse();
    return { tenant: row.tenant, smartAccount: row.smart_account, updatedAt: row.updated_at, rowVersion: row.row_version };
  });
  if (new Set(roster.map(row => row.tenant)).size !== roster.length) throw refuse();
  return roster;
}

function directory(file: string): { dev: string; ino: string } {
  const st = lstatSync(file, { bigint: true });
  if (!st.isDirectory()) throw refuse(); // lstat intentionally refuses symlink directories.
  return { dev: String(st.dev), ino: String(st.ino) };
}
function plainText(file: string, cap: number): string | null {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (e) { if ((e as { code?: unknown }).code === "ENOENT") return null; throw refuse(); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > cap) throw refuse();
    const buffer = Buffer.alloc(Math.min(st.size + 1, cap + 1));
    let n = 0;
    while (n < buffer.length) {
      const got = readSync(fd, buffer, n, buffer.length - n, n);
      if (!got) break;
      n += got;
    }
    if (n > cap) throw refuse();
    return buffer.subarray(0, n).toString("utf8");
  } finally { closeSync(fd); }
}
function groupsExport(tenant: string, text: string | null, forgetText: string | null, dek: Buffer): GroupExport | null {
  // A malformed or torn forget line cannot be silently discarded by the normal tolerant parser.
  if (forgetText !== null) for (const line of forgetText.split("\n")) {
    if (!line.trim()) continue;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { throw refuse(); }
    if (!cleanForget(raw)) throw refuse();
  }
  if (text === null) return null;
  if (!isTgGroupsText(text)) throw refuse();
  const ops = parseTgForgets(forgetText ?? "");
  if (ops.length) {
    const state = parseTgGroupsState(JSON.parse(text) as unknown);
    text = JSON.stringify(applyForgets(state, ops));
  }
  const bytes = Buffer.byteLength(text);
  if (bytes > TG_GROUPS_MAX_BYTES) throw refuse();
  const rooms = Object.keys(parseTgGroupsState(JSON.parse(text) as unknown).rooms).length;
  const sealed = sealSecret(`tg-groups/v1 ${tenant}\n${text}`, dek);
  return { sealed, bytes, rooms, sha256: digest(sealed) };
}
async function storedRow(shared: Db, table: "tenant_personal_memory" | "tenant_tg_groups", tenant: string): Promise<string | null> {
  try {
    const row = await shared.prepare(`SELECT sealed FROM ${table} WHERE tenant = ?`).get(tenant) as { sealed?: unknown } | undefined;
    if (!row) return null;
    if (typeof row.sealed !== "string" || row.sealed.length > PERSONAL_MEMORY_MAX_BYTES * 1.5 + 512) throw refuse();
    return row.sealed;
  } catch (e) {
    if ((e as { code?: unknown }).code === "42P01" || (e instanceof Error && /^no such table: tenant_(personal_memory|tg_groups)$/.test(e.message))) return null;
    throw refuse();
  }
}
function storedPersonalExport(tenant: string, sealed: string | null, dek: Buffer): PersonalExport | null {
  if (sealed === null) return null;
  const head = `personal-memory/v1 ${tenant}\n`, plain = openSecret(sealed, dek);
  if (!plain.startsWith(head)) throw refuse();
  const text = plain.slice(head.length), raw = JSON.parse(text) as { soul?: unknown; chats?: unknown };
  if (!raw.soul || typeof raw.soul !== "object" || !Array.isArray(raw.chats)) throw refuse();
  // The real restore below validates all fields and exact content, not only this count view.
  return { tenant, sealed, bytes: Buffer.byteLength(text), soulFiles: Object.keys(raw.soul).length,
    dmChats: raw.chats.length, dmTurns: raw.chats.reduce((n, c: { turns?: unknown }) => {
      if (!Array.isArray(c?.turns)) throw refuse(); return n + c.turns.length;
    }, 0), sha256: digest(sealed) };
}

/** No writes to live homes or shared storage, including no clearing forget journals. */
export async function captureFleetMemory(o: {
  childrenDir: string; shared: Db; dek: Buffer; source: MemorySource;
  assertSource: () => void | Promise<void>;
}): Promise<MemoryBackup> {
  await o.assertSource();
  directory(o.childrenDir);
  const roster = await readMemoryRoster(o.shared);
  const homes = new Set(readdirSync(o.childrenDir).filter(name => ADDRESS.test(name)));
  if (homes.size > MAX_TENANTS) throw refuse();
  const entries: Entry[] = [];
  for (const row of roster) {
    // Never invent a blank snapshot for a missing old home. Verify/backup any
    // existing durable row, and separately report historical absence if neither exists.
    const home = path.join(o.childrenDir, row.tenant);
    const st = homes.has(row.tenant) ? directory(home) : null;
    const personal = st ? capturePersonalMemoryExport({ tenant: row.tenant, home, dek: o.dek })
      : storedPersonalExport(row.tenant, await storedRow(o.shared, "tenant_personal_memory", row.tenant), o.dek);
    const localGroups = st ? plainText(path.join(home, TG_GROUPS_FILE_NAME), TG_GROUPS_MAX_BYTES) : null;
    const forgets = st ? plainText(path.join(home, TG_GROUPS_FORGET_FILE), TG_FORGET_LIMITS.readBytes) : null;
    // A held tenant may have no group file. Its stored ciphertext is then the source,
    // with the local privacy journal still applied before the backup is sealed.
    let groupText = localGroups;
    if (groupText === null) {
      const old = await storedRow(o.shared, "tenant_tg_groups", row.tenant);
      if (old !== null) {
        const header = `tg-groups/v1 ${row.tenant}\n`;
        const plain = openSecret(old, o.dek);
        if (!plain.startsWith(header)) throw refuse();
        groupText = plain.slice(header.length);
      }
    }
    const groups = groupsExport(row.tenant, groupText, forgets, o.dek);
    if (st) {
      const after = directory(home);
      if (after.dev !== st.dev || after.ino !== st.ino) throw refuse();
    }
    entries.push({ ...row, homeDev: st?.dev ?? null, homeIno: st?.ino ?? null, personal, groups });
  }
  await o.assertSource();
  if (JSON.stringify(roster) !== JSON.stringify(await readMemoryRoster(o.shared))) throw refuse();
  return { version: 1, id: randomUUID(), capturedAtMs: Date.now(), source: { ...o.source }, entries, roster };
}

export function memoryBackupCounts(backup: MemoryBackup): MemoryBackupCounts {
  return backup.entries.reduce((n, e) => ({
    tenants: n.tenants + 1, personalSnapshots: n.personalSnapshots + Number(!!e.personal),
    soulFiles: n.soulFiles + (e.personal?.soulFiles ?? 0), dmChats: n.dmChats + (e.personal?.dmChats ?? 0),
    dmTurns: n.dmTurns + (e.personal?.dmTurns ?? 0), groupSnapshots: n.groupSnapshots + Number(!!e.groups),
    groupRooms: n.groupRooms + (e.groups?.rooms ?? 0), rosterWithoutHome: n.rosterWithoutHome + Number(e.homeIno === null),
    historicalMemoryGaps: n.historicalMemoryGaps + Number(e.homeIno === null && !e.personal && !e.groups),
  }), { tenants: 0, personalSnapshots: 0, soulFiles: 0, dmChats: 0, dmTurns: 0, groupSnapshots: 0, groupRooms: 0,
    rosterWithoutHome: 0, historicalMemoryGaps: 0 });
}

/** The complete artifact is encrypted, even its per-tenant manifest and counters. */
export function sealMemoryBackup(backup: MemoryBackup, dek: Buffer): string {
  const text = JSON.stringify(backup);
  if (Buffer.byteLength(text) > BACKUP_MAX_BYTES / 1.5) throw refuse();
  return sealSecret(ENVELOPE + text, dek) + "\n";
}
export function openMemoryBackup(sealed: string, dek: Buffer): MemoryBackup {
  try {
    if (Buffer.byteLength(sealed) > BACKUP_MAX_BYTES) throw refuse();
    const plain = openSecret(sealed.trim(), dek);
    if (!plain.startsWith(ENVELOPE)) throw refuse();
    const b = JSON.parse(plain.slice(ENVELOPE.length)) as MemoryBackup;
    if (b?.version !== 1 || !/^[0-9a-f-]{36}$/.test(b.id) || !Number.isSafeInteger(b.capturedAtMs)
        || !b.source || !Array.isArray(b.entries) || !Array.isArray(b.roster)
        || b.entries.length > MAX_TENANTS || b.roster.length > MAX_TENANTS) throw refuse();
    if (new Set(b.entries.map(e => e.tenant)).size !== b.entries.length) throw refuse();
    for (const e of b.entries) {
      if (!ADDRESS.test(e.tenant) || !ADDRESS.test(e.smartAccount) || !/^\d{1,20}$/.test(e.updatedAt)
          || !((e.homeDev === null && e.homeIno === null) || (typeof e.homeDev === "string" && typeof e.homeIno === "string" && /^\d+$/.test(e.homeDev) && /^\d+$/.test(e.homeIno)))
          || !/^\d{1,20}$/.test(e.rowVersion)
          || !b.roster.some(r => JSON.stringify(r) === JSON.stringify({ tenant: e.tenant, smartAccount: e.smartAccount, updatedAt: e.updatedAt, rowVersion: e.rowVersion }))) throw refuse();
      if (e.personal && (e.personal.tenant !== e.tenant || e.personal.bytes > PERSONAL_MEMORY_MAX_BYTES
          || digest(e.personal.sealed) !== e.personal.sha256)) throw refuse();
      if (e.groups && (e.groups.bytes > TG_GROUPS_MAX_BYTES || digest(e.groups.sealed) !== e.groups.sha256)) throw refuse();
    }
    return b;
  } catch { throw refuse(); }
}

/** Actual production restore functions verify every encrypted tenant row in disposable homes. */
export async function verifyMemoryBackup(backup: MemoryBackup, dek: Buffer): Promise<MemoryBackupCounts> {
  const temp = mkdtempSync(path.join(os.tmpdir(), "mm-memory-verify-"));
  const raw = new DatabaseSync(":memory:");
  const shared = wrapSqlite(raw);
  try {
    await ensurePersonalMemorySchema(shared, "sqlite");
    await ensureTgGroupsSchema(shared, "sqlite");
    for (const e of backup.entries) {
      const home = path.join(temp, e.tenant); mkdirSync(home, { mode: 0o700 });
      if (e.personal) {
        await shared.prepare("INSERT INTO tenant_personal_memory VALUES (?, ?, ?, ?)").run(e.tenant, e.personal.sealed, e.personal.bytes, backup.capturedAtMs);
        const restored = await restorePersonalMemory({ tenant: e.tenant, home, shared, dek, log: silent });
        if (restored !== "restored" && restored !== "present") throw refuse();
        const check = capturePersonalMemoryExport({ tenant: e.tenant, home, dek });
        if (!check || check.soulFiles !== e.personal.soulFiles || check.dmChats !== e.personal.dmChats || check.dmTurns !== e.personal.dmTurns
            || personalContent(e.tenant, check.sealed, dek) !== personalContent(e.tenant, e.personal.sealed, dek)) throw refuse();
      }
      if (e.groups) {
        await shared.prepare("INSERT INTO tenant_tg_groups VALUES (?, ?, ?, ?)").run(e.tenant, e.groups.sealed, e.groups.bytes, backup.capturedAtMs);
        if (await restoreTgGroups({ tenant: e.tenant, home, shared, dek, log: silent }) !== "restored") throw refuse();
        const restored = plainText(path.join(home, TG_GROUPS_FILE_NAME), TG_GROUPS_MAX_BYTES);
        const expected = openSecret(e.groups.sealed, dek), header = `tg-groups/v1 ${e.tenant}\n`;
        if (!expected.startsWith(header) || restored !== expected.slice(header.length) || Buffer.byteLength(restored) !== e.groups.bytes
            || Object.keys(parseTgGroupsState(JSON.parse(restored) as unknown).rooms).length !== e.groups.rooms) throw refuse();
      }
    }
    return memoryBackupCounts(backup);
  } finally { raw.close(); rmSync(temp, { recursive: true, force: true }); }
}

/** Exclusive creation, fsynced before acknowledgement; never overwrites an earlier backup. */
export function writeMemoryBackupArtifact(file: string, sealed: string): string {
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const bytes = Buffer.from(sealed);
    let n = 0;
    while (n < bytes.length) n += writeSync(fd, bytes, n, bytes.length - n);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    linkSync(tmp, file); // EXCL final publication: EEXIST refuses, including symlinks.
    const parent = openSync(path.dirname(file), "r");
    try { fsyncSync(parent); } finally { closeSync(parent); }
    return digest(sealed);
  } finally { rmSync(tmp, { force: true }); }
}

export function readMemoryBackupArtifact(file: string): string {
  const text = plainText(file, BACKUP_MAX_BYTES);
  if (text === null) throw refuse();
  return text;
}

/** No updates or deletes: an existing different memory row is a conflict, never overwritten. */
export async function seedMemoryBackup(o: {
  backup: MemoryBackup; childrenDir: string; shared: Db; dek: Buffer;
  assertSource: () => void | Promise<void>;
}): Promise<{ inserted: number; alreadySeeded: number }> {
  const b = o.backup;
  if (!b.source.quiescent || !b.source.singleReplicaConfirmed
      || Date.now() - b.capturedAtMs > 5 * 60_000 || b.capturedAtMs > Date.now() + 10_000) throw refuse();
  await o.assertSource();
  await verifyMemoryBackup(b, o.dek);
  if (JSON.stringify(b.roster) !== JSON.stringify(await readMemoryRoster(o.shared))) throw refuse();
  for (const e of b.entries) {
    if (e.homeIno === null) continue;
    const st = directory(path.join(o.childrenDir, e.tenant));
    if (st.dev !== e.homeDev || st.ino !== e.homeIno) throw refuse();
  }
  await ensurePersonalMemorySchema(o.shared, "postgres");
  return o.shared.tx(async tx => {
    let inserted = 0, alreadySeeded = 0;
    for (const e of b.entries) {
      // Lock the public roster row so a concurrent explicit deletion cannot be
      // followed by this transaction inserting a snapshot for that deleted tenant.
      const current = await tx.prepare("SELECT tenant FROM grants WHERE tenant = ? AND lower(grant_json->>'smartAccount') = ? AND updated_at::text = ? AND xmin::text = ? FOR SHARE")
        .get(e.tenant, e.smartAccount, e.updatedAt, e.rowVersion);
      if (!current) throw refuse();
      // Already durable no-home rows were verified; leave them byte-for-byte unchanged.
      if (e.homeIno === null) continue;
      if (!e.personal) continue;
      const r = await tx.prepare("INSERT INTO tenant_personal_memory (tenant, sealed, bytes, updated_at_ms) VALUES (?, ?, ?, ?) ON CONFLICT (tenant) DO NOTHING")
        .run(e.tenant, e.personal.sealed, e.personal.bytes, Date.now());
      const actual = await tx.prepare("SELECT sealed FROM tenant_personal_memory WHERE tenant = ?").get(e.tenant) as { sealed?: unknown } | undefined;
      if (actual?.sealed !== e.personal.sealed) throw refuse();
      if (r.changes) inserted++; else alreadySeeded++;
    }
    await o.assertSource();
    return { inserted, alreadySeeded };
  });
}
