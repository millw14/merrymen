/**
 * The database the MCP server keeps its own state in: shared Postgres when
 * hosted (the same database as the ledger mirror and the partner store), and a
 * SQLite handle injected by tests. The MCP tables are created once per process.
 *
 * The ledger tables are READ through the same handle but never written: MCP
 * writes only its own tables (mcp_*, notify_*), plus the owner-order queue
 * through the existing order helper when an owner approves a trade on a
 * Merrymen page.
 */
import { makePgDb, type Db } from "../../../worker/src/db";
import { ensureMcpSchema } from "../../../worker/src/mcp/schema";

export interface McpDb {
  db: Db;
  dialect: "postgres" | "sqlite";
}

let ready: Promise<McpDb> | null = null;
let override: McpDb | null = null;

export function mcpDb(): Promise<McpDb> {
  if (override) return Promise.resolve(override);
  if (!ready) {
    const url = process.env.DATABASE_URL;
    if (!url) return Promise.reject(new Error("MCP requires DATABASE_URL"));
    ready = makePgDb(url)
      .then(async (db) => {
        await ensureMcpSchema(db, "postgres");
        return { db, dialect: "postgres" as const };
      })
      .catch((error) => {
        ready = null;
        throw error;
      });
  }
  return ready;
}

/** Test seam: route every MCP read and write to the given database (already schema'd). */
export function setMcpDbForTest(value: McpDb | null): void {
  override = value;
  ready = null;
}

/** `FOR UPDATE` where the dialect has row locks; SQLite serialises writers on its own. */
export function lockSuffix(d: McpDb): string {
  return d.dialect === "postgres" ? " FOR UPDATE" : "";
}
