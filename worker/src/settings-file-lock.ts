import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { atomicWriteTarget } from "./atomic-write";

/** Match the atomic writer's destination, including a settings-file symlink. */
export function settingsLockFile(file: string): string {
  const target = atomicWriteTarget(file);
  return path.join(path.dirname(target), `.${path.basename(target)}.writers.lock.db`);
}

/**
 * Serialize short, synchronous settings mutations across processes. The
 * compare and the rename must hold the same OS lock as a kill's read/write;
 * an atomic rename alone does not make a read-modify-write atomic.
 *
 * No network, promise or user callback may wait inside this critical section.
 * Contention is bounded: callers report failure rather than claim a kill or
 * save succeeded. Process death releases SQLite's lock without stale-file
 * deletion. The empty database is only a lock, never a copy of the settings.
 */
export function withSettingsFileLock<T>(file: string, write: () => T): T {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(settingsLockFile(file));
  try {
    db.exec("PRAGMA busy_timeout = 1000");
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = write();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* close releases the OS lock */ }
      throw error;
    }
  } finally {
    db.close();
  }
}
