import type { Db } from "./db";

/** Resolve only tables visible on this connection's search path, as the DDL does. */
async function existingColumns(db: Db): Promise<{ columns: Set<string>; sqlite: boolean }> {
  let rows: unknown[];
  let sqlite = false;
  try {
    rows = await db.prepare(`SELECT c.relname AS table_name, a.attname AS column_name
      FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p')
        AND pg_table_is_visible(c.oid)`).all();
  } catch (error) {
    // Only SQLite's absent PostgreSQL catalogue selects the other dialect.
    // Connection, permission and catalog failures must stop schema setup.
    if (!/^no such table: pg_catalog\.pg_attribute$/i.test((error as Error)?.message ?? "")) throw error;
    sqlite = true;
    rows = await db.prepare(`SELECT m.name AS table_name, p.name AS column_name
      FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table'`).all();
  }
  const columns = new Set<string>();
  for (const row of rows) {
    const { table_name: table, column_name: column } = row as { table_name?: unknown; column_name?: unknown };
    if (typeof table !== "string" || typeof column !== "string") throw new Error("Could not read ledger column catalog");
    columns.add(`${table}.${column}`);
  }
  return { columns, sqlite };
}

/**
 * IF NOT EXISTS still takes PostgreSQL's AccessExclusiveLock, even for an
 * existing column. The mirror runs this on every pass: behind a long reader,
 * that unnecessary lock queues every later reader of the same table.
 *
 * Read the catalog afresh on each pass. Only proven-present additions are
 * skipped; a missing column still uses the driver's ADD COLUMN IF NOT EXISTS
 * so concurrent initializers remain safe. Never cache a successful migration
 * across databases, schema changes, failed setup or a later software upgrade.
 */
/**
 * The line said when a non-ALTER migration throws, by its index alone: the statement's text and the
 * driver's message can quote table contents. Such a migration is still skipped, as before; said, its
 * failure (an open-time fold that stopped folding, say) is no longer silent.
 */
export const ledgerMigrationSkipped = (index: number) =>
  `[warn] ledger migration #${index} failed and was skipped; the ledger opened without it`;

/**
 * A MISSING COLUMN'S ONE ADD, WITHOUT A QUEUE BEHIND IT (PostgreSQL).
 *
 * The catalog check above makes an ADD COLUMN happen once per database, at the
 * deploy that brings it. That once still needs an AccessExclusiveLock, and a
 * lock request waits behind every reader already on the table and blocks every
 * reader that arrives after it: behind one long query on `equity`, the whole
 * app stalls for as long as that query runs. So the ADD waits at most
 * `waitMs` for its lock, pauses and asks again, `tries` times. A table that
 * stays busy past all of them still fails setup (55P03), as an unmigrated
 * ledger must; a reader is never queued behind it for longer than one wait.
 *
 * ONE QUERY, NOT A TRANSACTION THE CALLER MUST OFFER: `SET LOCAL lock_timeout;
 * ALTER …` sent together runs as one implicit transaction on one connection,
 * so the timeout binds the ALTER, ends with it, and never stays on a pooled
 * connection for an unrelated query. Every Db can run it, including one that
 * cannot open a transaction of its own (a caller's or a test's wrapper).
 */
export interface AddColumnLock {
  waitMs: number;
  tries: number;
  pauseMs: number;
}
export const ADD_COLUMN_LOCK: Readonly<AddColumnLock> = Object.freeze({ waitMs: 2_000, tries: 5, pauseMs: 1_000 });

async function addColumn(db: Db, ddl: string, sqlite: boolean, lock: Readonly<AddColumnLock>): Promise<void> {
  if (sqlite) return db.exec(ddl);
  for (let attempt = 1; ; attempt++) {
    try {
      await db.exec(`SET LOCAL lock_timeout = '${Math.max(1, Math.floor(lock.waitMs))}ms'; ${ddl}`);
      return;
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "55P03" || attempt >= lock.tries) throw error;
      await new Promise((resolve) => setTimeout(resolve, lock.pauseMs));
    }
  }
}

export async function applyLedgerMigrations(db: Db, migrations: readonly string[],
  log: (line: string) => void = (line) => console.error(line), lock: Readonly<AddColumnLock> = ADD_COLUMN_LOCK): Promise<void> {
  const { columns, sqlite } = await existingColumns(db);
  for (const [index, ddl] of migrations.entries()) {
    const add = /^ALTER TABLE ([a-z_][a-z0-9_]*) ADD COLUMN ([a-z_][a-z0-9_]*)\s/i.exec(ddl);
    if (add) {
      const key = `${add[1]!.toLowerCase()}.${add[2]!.toLowerCase()}`;
      if (columns.has(key)) continue;
      try {
        await addColumn(db, ddl, sqlite, lock);
      } catch (error) {
        // SQLite has no ADD COLUMN IF NOT EXISTS. Another initializer can add
        // it after the snapshot; accept only that error AND a confirmed column.
        if (!sqlite || !/^duplicate column name:/i.test((error as Error)?.message ?? "")
          || !(await existingColumns(db)).columns.has(key)) throw error;
      }
      columns.add(key);
    } else {
      if (/^ALTER TABLE\b/i.test(ddl)) throw new Error("Unsupported ledger column migration");
      // Preserve the existing compatibility handling for the non-column
      // migrations in this list. Required read indexes are checked separately.
      try { await db.exec(ddl); } catch { log(ledgerMigrationSkipped(index)); }
    }
  }
}
