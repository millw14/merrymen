/** Local Spot/Perps authority changes share one crash-released OS writer lock. */
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export class LocalGrantBusyError extends Error {}

/**
 * @template T
 * @param {string} home The main home shared by the Spot and Perps accounts.
 * @param {() => Promise<T>} fn Re-read authority and perform the whole change here.
 * @returns {Promise<T>}
 */
export async function withLocalGrantLock(home, fn) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(home, ".grant-writers.lock.db"));
  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try { db.exec("BEGIN IMMEDIATE"); break; }
      catch (error) {
        if (!/database is locked|database is busy/i.test(String(error?.message))) throw error;
        if (Date.now() >= deadline) throw new LocalGrantBusyError("Another wallet permission change is still in progress. Try again.");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    try {
      const result = await fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* no active lock remains */ }
      throw error;
    }
  } finally { db.close(); }
}

/** @param {string} file @param {string} raw Publish only a complete grant. */
export async function replaceLocalGrant(file, raw) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(raw, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
    // Flush the rename on filesystems that support directory synchronization.
    let directory;
    try { directory = await open(path.dirname(file), "r"); await directory.sync(); }
    catch { /* Some platforms cannot open or sync a directory; the grant is whole. */ }
    finally { if (directory) await directory.close(); }
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}
