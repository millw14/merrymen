import {
  closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

type DeploymentManifest = Record<string, Record<string, unknown>>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function manifestPath(file: string): string {
  // Directory aliases must share a lock. A symlink at the manifest itself
  // would be replaced by rename, so reject it instead of locking its target.
  const resolved = path.join(realpathSync(path.dirname(file)), path.basename(file));
  try {
    if (lstatSync(resolved).isSymbolicLink()) throw new Error(`Deployment manifest must not be a symlink: ${file}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return resolved;
}

/** Missing is an empty manifest; unreadable or malformed existing records must survive. */
export function readDeploymentManifest(file: string): DeploymentManifest {
  file = manifestPath(file);
  let source: string;
  try { source = readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const book: unknown = JSON.parse(source);
  if (!object(book) || !Object.values(book).every(object)) {
    throw new Error(`Invalid deployment manifest: ${file}`);
  }
  return book as DeploymentManifest;
}

function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * All deployment scripts use this one lock and re-read only after acquiring it.
 * A crashed writer leaves the lock in place: never steal a lock by age or PID.
 * An operator must establish that no writer remains before removing that lock.
 */
export async function recordDeployment(
  file: string,
  chainId: number,
  contract: string,
  entry: Record<string, unknown>,
  options: { replaceExisting?: boolean; lockWaitMs?: number } = {},
): Promise<void> {
  file = manifestPath(file);
  const lock = `${file}.lock`;
  const deadline = Date.now() + (options.lockWaitMs ?? 10_000);
  let lockFd: number;
  for (;;) {
    try { lockFd = openSync(lock, "wx", 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Deployment manifest is locked: ${lock}. Inspect the existing writer before manual recovery.`);
      }
      await delay(20);
    }
  }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(lockFd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n");
    fsyncSync(lockFd);
    syncDirectory(path.dirname(file));
    const book = readDeploymentManifest(file);
    const chainKey = String(chainId);
    const chain = book[chainKey] ?? {};
    if (!options.replaceExisting && Object.hasOwn(chain, contract)) {
      throw new Error(`${contract} deployment is already recorded for chain ${chainId}; verify/reuse it instead of overwriting.`);
    }
    book[chainKey] = { ...chain, [contract]: entry };
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(book, null, 2) + "\n");
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, file);
    syncDirectory(path.dirname(file));
  } finally {
    // A failed write must not strand a temporary file; the old manifest is
    // intact unless the atomic replacement already succeeded.
    try { unlinkSync(temporary); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    finally {
      try { closeSync(lockFd); } finally { unlinkSync(lock); }
    }
  }
}
