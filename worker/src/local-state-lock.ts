import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

export const LOCAL_STATE_LOCK_FILE = ".state-writers.lock.db";

export class LocalStateBusyError extends Error {
  constructor() {
    super("Another request is changing this install's wallets. Please try again.");
    this.name = "LocalStateBusyError";
  }
}

/**
 * Serialize participating local-file writers across processes. Both wallets
 * use the install's root home, so checking the other wallet and replacing a
 * grant happen under one lock. Read network state before entering this lock.
 *
 * SQLite holds the OS lock; process death releases it without stale-lock
 * deletion. This serializes files but does not roll back their writes. A
 * caller must still archive before replacement and write files atomically.
 */
export async function withLocalStateLock<T>(home: string, write: () => Promise<T>, waitMs = 5_000): Promise<T> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(home, LOCAL_STATE_LOCK_FILE));
  try {
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        db.exec("BEGIN IMMEDIATE");
        break;
      } catch (error) {
        const { errcode, message } = error as { errcode?: number; message?: string };
        if (errcode !== 5 && errcode !== 6 && !/database is (locked|busy)/i.test(message ?? "")) throw error;
        if (Date.now() >= deadline) throw new LocalStateBusyError();
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    try {
      const result = await write();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* close also releases the lock */ }
      throw error;
    }
  } finally {
    db.close();
  }
}
