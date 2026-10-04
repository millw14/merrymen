/**
 * Durable age boundary for delivered financial command files, not activation.
 * The caller proves source/grant/lease ownership and excludes all writers before
 * publishing, clearing health or forking. This guard does not prove an old intent
 * never executed and never deletes commands or .running markers.
 * An orphan lock is never stolen: an operator must first verify the original
 * source and that all writers are stopped before reviewing that lock.
 */
import fs, { type BigIntStats } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const RECOVERY_COMMAND_BARRIER_FILE = "recovery-command-barrier.json";
export const RECOVERY_COMMAND_BARRIER_LOCK = ".recovery-command-barrier.lock";
export const RECOVERY_COMMAND_BARRIER_MAX_BYTES = 1024;
export interface RecoveryCommandScope { smartAccount: string; chainId: number }
interface Barrier extends RecoveryCommandScope { version: 1; notBeforeMs: number }
interface Snapshot { value: Barrier; stat: BigIntStats }
const FINANCIAL_KINDS = new Set(["trade", "selftest", "paper-reset"]);
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const refuse = () => new Error("Recovery command barrier refused; preserve the home and verify the boundary and writer ownership.");

function scope(value: RecoveryCommandScope): RecoveryCommandScope {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 2 || !Object.hasOwn(value, "smartAccount") || !Object.hasOwn(value, "chainId")
      || typeof value.smartAccount !== "string" || !ADDRESS.test(value.smartAccount)
      || !Number.isSafeInteger(value.chainId) || value.chainId <= 0 || value.chainId > 0xffff_ffff) throw refuse();
  return { smartAccount: value.smartAccount.toLowerCase(), chainId: value.chainId };
}
function timestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw refuse();
}
function plain(st: BigIntStats): boolean {
  return st.isFile() && st.nlink === 1n && (st.mode & 0o7777n) === 0o600n
    && (!process.geteuid || st.uid === BigInt(process.geteuid()));
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  return plain(b) && a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function fileStat(file: string): BigIntStats | null {
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
function plainHome(home: string, requirePrivate = true): BigIntStats {
  if (!path.isAbsolute(home) || path.resolve(home) !== home) throw refuse();
  const st = fs.lstatSync(home, { bigint: true });
  if (!st.isDirectory() || (requirePrivate && (st.mode & 0o7777n) !== 0o700n)
      || (process.geteuid && st.uid !== BigInt(process.geteuid()))) throw refuse();
  for (let dir = home; ; dir = path.dirname(dir)) {
    if (!fs.lstatSync(dir).isDirectory()) throw refuse();
    if (dir === path.dirname(dir)) break;
  }
  return st;
}
/** The verified caller may tighten its own old 0755 home; never chmod by path. */
function preparePrivateHome(home: string): BigIntStats {
  const before = plainHome(home, false);
  const fd = fs.openSync(home, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_DIRECTORY ?? 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true }), current = plainHome(home, false);
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.uid !== before.uid || current.dev !== opened.dev || current.ino !== opened.ino
        || (process.geteuid && opened.uid !== BigInt(process.geteuid()))) throw refuse();
    if ((opened.mode & 0o7777n) !== 0o700n) fs.fchmodSync(fd, 0o700);
    fs.fsyncSync(fd);
    const confirmed = plainHome(home);
    if (confirmed.dev !== opened.dev || confirmed.ino !== opened.ino) throw refuse();
    return confirmed;
  } finally { fs.closeSync(fd); }
}
function sameHome(home: string, before: BigIntStats): void {
  const current = plainHome(home);
  if (current.dev !== before.dev || current.ino !== before.ino) throw refuse();
}
function canonical(value: Barrier): string {
  return JSON.stringify({ version: 1, smartAccount: value.smartAccount, chainId: value.chainId, notBeforeMs: value.notBeforeMs });
}
function readBarrier(home: string): Snapshot | null {
  const file = path.join(home, RECOVERY_COMMAND_BARRIER_FILE), before = fileStat(file);
  if (before === null) return null; // Only ENOENT is the legacy absent-file case.
  const homeStat = plainHome(home);
  if (!plain(before) || before.size <= 0n || before.size > BigInt(RECOVERY_COMMAND_BARRIER_MAX_BYTES)) throw refuse();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    if (!same(before, fs.fstatSync(fd, { bigint: true }))) throw refuse();
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const got = fs.readSync(fd, bytes, count, bytes.length - count, count);
      if (got === 0) break;
      count += got;
    }
    if (count !== Number(before.size) || !same(before, fs.fstatSync(fd, { bigint: true }))) throw refuse();
    const text = bytes.subarray(0, count).toString("utf8"), raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw refuse();
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).length !== 4 || value.version !== 1 || !Object.hasOwn(value, "notBeforeMs")) throw refuse();
    const normalized = scope({ smartAccount: value.smartAccount as string, chainId: value.chainId as number });
    timestamp(value.notBeforeMs as number);
    const barrier: Barrier = { version: 1, ...normalized, notBeforeMs: value.notBeforeMs as number };
    // Canonical bytes also reject duplicate keys, extra whitespace and alternate encodings.
    if (text !== canonical(barrier) && text !== `${canonical(barrier)}\n`) throw refuse();
    const final = fileStat(file);
    if (!final || !same(before, final)) throw refuse();
    sameHome(home, homeStat);
    return { value: barrier, stat: before };
  } finally { fs.closeSync(fd); }
}
function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text);
  let at = 0;
  while (at < bytes.length) {
    const written = fs.writeSync(fd, bytes, at, bytes.length - at);
    if (written <= 0) throw refuse();
    at += written;
  }
}
function syncHome(home: string): void {
  const fd = fs.openSync(home, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_DIRECTORY ?? 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function lockPresent(home: string): boolean {
  // Even a foreign/malformed lock is a refusal, not permission to steal it.
  return fileStat(path.join(home, RECOVERY_COMMAND_BARRIER_LOCK)) !== null;
}

/** Private atomic publication under an exclusive never-stolen file lock. */
export function writeRecoveryCommandBarrier(home: string, inputScope: RecoveryCommandScope, notBeforeMs: number): void {
  let lockFd: number | null = null, tempFd: number | null = null;
  let lockStat: BigIntStats | null = null, tempStat: BigIntStats | null = null;
  let lock = "", file = "", temp = "";
  let failed = false;
  try {
    const bound = scope(inputScope); timestamp(notBeforeMs);
    const homeStat = preparePrivateHome(home);
    lock = path.join(home, RECOVERY_COMMAND_BARRIER_LOCK);
    file = path.join(home, RECOVERY_COMMAND_BARRIER_FILE);
    temp = path.join(home, `.${RECOVERY_COMMAND_BARRIER_FILE}.${randomUUID()}.tmp`);
    lockFd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    fs.fchmodSync(lockFd, 0o600);
    writeAll(lockFd, `${randomUUID()}\n`); fs.fsyncSync(lockFd);
    lockStat = fs.fstatSync(lockFd, { bigint: true });
    if (!plain(lockStat)) throw refuse();
    syncHome(home);
    const old = readBarrier(home);
    if (old && (old.value.smartAccount !== bound.smartAccount || old.value.chainId !== bound.chainId)) throw refuse();
    const value: Barrier = { version: 1, ...bound, notBeforeMs: Math.max(notBeforeMs, old?.value.notBeforeMs ?? 0) };
    tempFd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    fs.fchmodSync(tempFd, 0o600);
    tempStat = fs.fstatSync(tempFd, { bigint: true });
    writeAll(tempFd, `${canonical(value)}\n`); fs.fsyncSync(tempFd);
    fs.closeSync(tempFd); tempFd = null;
    sameHome(home, homeStat);
    const heldLock = fileStat(lock);
    if (!heldLock || !same(lockStat, heldLock)) throw refuse();
    const current = fileStat(file);
    if (old ? !current || !same(old.stat, current) : current !== null) throw refuse();
    fs.renameSync(temp, file); tempStat = null;
    syncHome(home);
    const confirmed = readBarrier(home);
    if (!confirmed || canonical(confirmed.value) !== canonical(value)) throw refuse();
  } catch { failed = true; }
  finally {
    try {
      if (tempFd !== null) fs.closeSync(tempFd);
      if (tempStat) {
        const current = fileStat(temp);
        if (current && current.dev === tempStat.dev && current.ino === tempStat.ino) fs.unlinkSync(temp);
      }
      if (lockStat) {
        const current = fileStat(lock);
        if (!current || !same(lockStat, current)) throw refuse();
        fs.unlinkSync(lock); syncHome(home);
      }
      // A lock whose write/sync never completed stays held for operator review.
    } catch { failed = true; }
    finally { if (lockFd !== null) { try { fs.closeSync(lockFd); } catch { failed = true; } } }
  }
  if (failed) throw refuse();
}

/** Equal-millisecond intents are held too; at alone cannot prove later delivery. */
export function recoveryCommandRefused(home: string, inputScope: RecoveryCommandScope, cmd: { kind: string; at: number }): boolean {
  try {
    if (!cmd || typeof cmd !== "object") return true;
    if (!FINANCIAL_KINDS.has(cmd.kind)) return false;
    const bound = scope(inputScope); timestamp(cmd.at);
    if (lockPresent(home)) return true;
    const saved = readBarrier(home);
    if (!saved) return lockPresent(home); // Absent only by ENOENT; any read error is caught below.
    if (saved.value.smartAccount !== bound.smartAccount || saved.value.chainId !== bound.chainId || cmd.at <= saved.value.notBeforeMs) return true;
    if (lockPresent(home)) return true;
    const current = fileStat(path.join(home, RECOVERY_COMMAND_BARRIER_FILE));
    return !current || !same(saved.stat, current);
  } catch { return true; }
}
