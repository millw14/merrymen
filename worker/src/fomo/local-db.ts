/**
 * THE SELF-HOSTED FOMO DATABASE — one sqlite file both local processes open.
 *
 * Hosted, Fomo state lives in the shared Postgres the web and the orchestrator
 * already hold. Self-hosted there is no Postgres and no orchestrator: the
 * worker and the dashboard are two processes on one machine. The ledger
 * (merrymen.db) has exactly one writer by design — the web opens it
 * read-only — and Fomo must not change that. So Fomo gets its OWN file,
 * opened read-write by both: caches, the cohort, conversation subject memory
 * and watches are written by whichever process answered the question.
 *
 * WAL lets one writer and many readers proceed together, and the busy timeout
 * turns a momentary lock into a short wait instead of an error. Nothing in
 * this file is accounting; losing it loses research caches and memory, never
 * money.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite, type Db } from "../db";
import { merrymenHome } from "../home";

export const LOCAL_FOMO_DB_FILE = "fomo.sqlite";

const opened = new Map<string, Db>();

/** The path of the self-hosted Fomo database under a home directory. */
export function localFomoDbPath(home: string = merrymenHome()): string {
  return path.join(home, LOCAL_FOMO_DB_FILE);
}

/**
 * Open (once per process and path) the self-hosted Fomo database. The schema
 * is NOT created here: callers run ensureFomoSchema(db, "sqlite"), which is
 * memoised per Db.
 */
export function openLocalFomoDb(home: string = merrymenHome()): Db {
  const file = localFomoDbPath(home);
  const existing = opened.get(file);
  if (existing) return existing;
  mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  const db = wrapSqlite(raw);
  opened.set(file, db);
  return db;
}

/** Tests only: forget opened handles so a temp home can be removed. */
export function closeLocalFomoDbsForTest(): void {
  opened.clear();
}
