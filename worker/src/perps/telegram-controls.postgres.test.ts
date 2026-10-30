/** Opt-in disposable LOCAL PostgreSQL: production SQL, BIGINTs and control transaction rollback. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { translateQuery, translateSchema, type Db } from "../db";
import { applyLedgerSchema } from "../store";
import { readDurablePause } from "../telegram-store";
import { applyPerpsBotControl } from "./telegram-controls";
import type { PerpsBotRequest } from "./telegram-bridge";

const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;
interface Client {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

test("Postgres: Perps owner controls preserve order, durable pauses and rollback", { skip: !url, timeout: 60_000 }, async t => {
  const target = new URL(url!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "only a disposable local PostgreSQL is allowed");
  const pg = createRequire(import.meta.url)("pg") as { Client: new (config: { connectionString: string }) => Client };
  const admin = new pg.Client({ connectionString: target.toString() });
  await admin.connect();
  const schema = `mm_perps_controls_${randomBytes(8).toString("hex")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(target);
  scoped.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=3000`);
  const connections: Client[] = [];
  const home = mkdtempSync(path.join(os.tmpdir(), "perps-controls-pg-"));
  const connect = async () => {
    const client = new pg.Client({ connectionString: scoped.toString() });
    await client.connect(); connections.push(client); return client;
  };
  const wrap = (client: Client, transaction = false): Db => ({
    prepare(sql) {
      return {
        async run(...args) { const result = await client.query(translateQuery(sql), args); return { changes: result.rowCount ?? 0, lastInsertRowid: 0 }; },
        async get(...args) { return (await client.query(translateQuery(sql), args)).rows[0]; },
        async all(...args) { return (await client.query(translateQuery(sql), args)).rows; },
      };
    },
    exec: async sql => { await client.query(translateSchema(sql)); },
    async tx(fn) {
      assert.equal(transaction, false);
      const tx = await connect();
      await tx.query("BEGIN");
      try { const result = await fn(wrap(tx, true)); await tx.query("COMMIT"); return result; }
      catch (error) { await tx.query("ROLLBACK"); throw error; }
    },
  });
  try {
    const db = wrap(await connect());
    await applyLedgerSchema(db);
    const tenant = "0x1111111111111111111111111111111111111111";
    const account = "0x2222222222222222222222222222222222222222";
    const now = Math.floor(Date.now() / 1000) * 1000;
    const paused = path.join(home, "paused");
    const request = (kind: "pause" | "resume", id: number): PerpsBotRequest => ({
      kind, expectedAccount: account, requestId: `tg-perps-123-${id}`, askedAtSec: now / 1000,
    });
    const apply = (r: PerpsBotRequest, mayWrite = () => true) => applyPerpsBotControl({ db, tenant, home, request: r, mayWrite, nowMs: now });
    await t.test("receipts are BIGINT-safe, sequential and replay-safe", async () => {
      assert.match(await apply(request("pause", 9)), /login is paused/);
      assert.equal(await readDurablePause(db, tenant), now / 1000);
      assert.match(await apply(request("resume", 8)), /stale/);
      assert.ok(existsSync(paused));
      assert.match(await apply(request("resume", 10)), /pause is lifted/);
      assert.equal(existsSync(paused), false);
      assert.match(await apply(request("pause", 9)), /already recorded/);
      assert.equal(existsSync(paused), false);
      await apply(request("pause", 11));
      assert.match(await apply(request("resume", 10)), /later owner control/);
      assert.ok(existsSync(paused));
    });
    await t.test("a lease lost before commit cannot clear the durable pause or marker", async () => {
      let calls = 0;
      await assert.rejects(apply(request("resume", 12), () => ++calls < 4), /lease/);
      assert.ok(existsSync(paused));
      assert.equal(await readDurablePause(db, tenant), now / 1000);
      const row = await db.prepare("SELECT request_id FROM perps_telegram_control_receipts WHERE tenant = ? AND request_id = ?")
        .get(tenant, request("resume", 12).requestId);
      assert.equal(row, undefined);
      assert.match(await apply(request("resume", 12)), /pause is lifted/);
    });
    await t.test("each owner has its own cursor and durable state", async () => {
      const other = "0x3333333333333333333333333333333333333333";
      const otherHome = path.join(home, "other");
      assert.match(await applyPerpsBotControl({ db, tenant: other, home: otherHome,
        request: request("pause", 1), mayWrite: () => true, nowMs: now }), /login is paused/);
      assert.equal(await readDurablePause(db, tenant), null);
      assert.equal(await readDurablePause(db, other), now / 1000);
    });
  } finally {
    await Promise.allSettled(connections.map(client => client.end()));
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    rmSync(home, { recursive: true, force: true });
  }
});
