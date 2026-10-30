/**
 * The dashboard's read side of the ledger, behind the same driver seam the worker
 * writes through (worker/src/db.ts). Self-hosted opens the shared sqlite file
 * READ-ONLY per request, so the worker stays the single writer and a corrupt or
 * locked file degrades to an empty panel rather than a 500. Hosted (DATABASE_URL)
 * reads the shared Postgres the worker child wrote — a pooled driver, opened once.
 *
 * Both backends speak the store's sqlite dialect; db.ts translates it for Postgres.
 * The one thing the web queries must avoid is a sqlite-only builtin the translator
 * doesn't cover — hence `datetime(at,'unixepoch')` is gone from the SQL here and
 * timestamps are formatted from the raw epoch by fmtEpoch() instead.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { purposeHome } from "../../../worker/src/home";
import { wrapSqlite, makePgDb, type Db } from "../../../worker/src/db";
import { isGrantPurpose, type GrantPurpose } from "../../../packages/core/src/grant";

/**
 * Run `fn` against the ledger's read driver, or against `null` when there is no
 * ledger to read (no sqlite file yet, or an unopenable one). Never throws for a
 * missing/locked database — that is an empty dashboard, not an error.
 *
 * WHOSE LEDGER: `wallet`, named by every caller, with no default (as the stores
 * and `purposeHome` take it). Hosted, both wallets' rows live in the one shared
 * Postgres, told apart by the account every query already names, so the driver
 * is the same. Self-hosted, each wallet's worker writes its own home's
 * merrymen.db (`purposeHome`: Spot's where it has always been, Perps's under
 * accounts/perps), so a Perps read opens that file and never the Spot one —
 * absent, it is an empty panel, not the other wallet's book.
 */
export function createReadDb(openPostgres: (url: string) => Promise<Db> = makePgDb) {
  let pgDriver: Promise<Db> | null = null;
  return async function withReadDb<T>(fn: (db: Db | null) => Promise<T>, wallet: GrantPurpose): Promise<T> {
    // Thrown, never read as Spot: an unnamed wallet is the caller's bug.
    if (!isGrantPurpose(wallet)) throw new Error("Unrecognised wallet purpose");
    const url = process.env.DATABASE_URL;
    if (url) {
      // One pooled Postgres driver for the whole web process. The worker child is
      // the writer; this side only reads.
      if (!pgDriver) pgDriver = openPostgres(url).catch((error) => {
        pgDriver = null;
        throw error;
      });
      return fn(await pgDriver);
    }
    const file = path.join(purposeHome(wallet), "merrymen.db");
    if (!existsSync(file)) return fn(null);
    let raw: DatabaseSync;
    try {
      raw = new DatabaseSync(file, { readOnly: true });
    } catch {
      return fn(null);
    }
    try {
      return await fn(wrapSqlite(raw));
    } finally {
      raw.close();
    }
  };
}

export const withReadDb = createReadDb();

/**
 * Format unix seconds to the exact string sqlite's `datetime(x,'unixepoch')`
 * produced — `YYYY-MM-DD HH:MM:SS`, UTC, no zone suffix — so moving the formatting
 * out of SQL changes nothing the dashboard clients parse. A missing/NaN value
 * yields "" rather than "1970-…", which reads as "no timestamp" instead of a lie.
 */
export function fmtEpoch(sec: unknown): string {
  const n = typeof sec === "bigint" ? Number(sec) : Number(sec);
  if (!Number.isFinite(n)) return "";
  return new Date(n * 1000).toISOString().slice(0, 19).replace("T", " ");
}
