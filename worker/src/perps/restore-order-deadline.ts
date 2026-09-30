/** Preserve the earliest known owner send cutoff without retaining a history in memory. */
import { randomUUID } from "node:crypto";
import type { Db } from "../db";

type Row = Record<string, unknown>;
export class OrderDeadlineFloor {
  private table = `perp_deadline_floor_${randomUUID().replaceAll("-", "")}`;
  private constructor(private db: Db) {}
  static async create(db: Db): Promise<OrderDeadlineFloor> {
    const floor = new OrderDeadlineFloor(db);
    await db.exec(`CREATE TEMP TABLE ${floor.table} (id TEXT, agent_id TEXT NOT NULL, mode TEXT NOT NULL,
      account_index INTEGER, api_key_index INTEGER, nonce INTEGER, deadline INTEGER NOT NULL);
      CREATE INDEX ${floor.table}_id ON ${floor.table}(agent_id, mode, id);
      CREATE INDEX ${floor.table}_nonce ON ${floor.table}(agent_id, mode, account_index, api_key_index, nonce);`);
    await db.exec("PRAGMA temp.cache_size=-1024;");
    return floor;
  }
  async remember(row: Row): Promise<void> {
    if (row.send_not_after_ms == null) return;
    if (!Number.isSafeInteger(row.send_not_after_ms) || Number(row.send_not_after_ms) <= 0) throw new Error("financial recovery order deadline is invalid");
    await this.db.prepare(`INSERT INTO ${this.table} VALUES (?,?,?,?,?,?,?)`).run(row.id ?? null,
      String(row.agent_id).toLowerCase(), row.mode, row.account_index ?? null, row.api_key_index ?? null, row.nonce ?? null, row.send_not_after_ms);
  }
  async rememberLedger(account: string, liveOnly: boolean): Promise<void> {
    await this.db.prepare(`INSERT INTO ${this.table} SELECT id,lower(agent_id),mode,account_index,api_key_index,nonce,send_not_after_ms
      FROM perp_orders WHERE lower(agent_id) = ? AND send_not_after_ms IS NOT NULL${liveOnly ? " AND mode = 'live'" : ""}`).run(account.toLowerCase());
  }
  async apply<T extends Row>(row: T): Promise<T> {
    const held = await this.db.prepare(`SELECT MIN(deadline) AS deadline FROM ${this.table} WHERE agent_id = ? AND mode = ?
      AND (id = ? OR (account_index = ? AND api_key_index = ? AND nonce = ?))`).get(String(row.agent_id).toLowerCase(), row.mode,
        row.id ?? null, row.account_index ?? null, row.api_key_index ?? null, row.nonce ?? null) as { deadline: number | null };
    if (row.send_not_after_ms != null && (!Number.isSafeInteger(row.send_not_after_ms) || Number(row.send_not_after_ms) <= 0)) throw new Error("financial recovery order deadline is invalid");
    if (held.deadline == null) return row;
    return { ...row, send_not_after_ms: row.send_not_after_ms == null ? held.deadline : Math.min(held.deadline, Number(row.send_not_after_ms)) };
  }
  /** After a warm checkpoint validates, tighten its surviving local order rows atomically. */
  async tightenLedger(db: Db): Promise<void> {
    await db.exec(`UPDATE perp_orders SET send_not_after_ms = (
      SELECT MIN(deadline) FROM ${this.table} d WHERE d.agent_id = lower(perp_orders.agent_id) AND d.mode = perp_orders.mode
      AND (d.id = perp_orders.id OR (d.account_index = perp_orders.account_index AND d.api_key_index = perp_orders.api_key_index AND d.nonce = perp_orders.nonce)))
      WHERE EXISTS (SELECT 1 FROM ${this.table} d WHERE d.agent_id = lower(perp_orders.agent_id) AND d.mode = perp_orders.mode
      AND (d.id = perp_orders.id OR (d.account_index = perp_orders.account_index AND d.api_key_index = perp_orders.api_key_index AND d.nonce = perp_orders.nonce))
      AND (perp_orders.send_not_after_ms IS NULL OR d.deadline < perp_orders.send_not_after_ms));`);
  }
  async close(): Promise<void> { await this.db.exec(`DROP TABLE ${this.table}`); }
}
