/**
 * REAL POSTGRES: THE HEARTBEAT ROW AND THE FUNNEL'S QUERIES. Opt-in, like
 * fleet-recovery.postgres.test.ts:
 *
 *   MERRYMEN_TEST_PG_URL=postgres://merrymen@localhost:55432/merrymen_pgtest \
 *     npx tsx --test worker/src/fleet-heartbeat.postgres.test.ts
 *
 * Skipped without it. A disposable LOCAL Postgres only, in a schema of its
 * own, dropped after; never DATABASE_URL.
 *
 * What only Postgres can say: that the translated DDL and the upsert's
 * `ON CONFLICT … WHERE` run, and that the funnel's `GROUP BY` names resolve
 * to the output aliases they mean (Postgres prefers an input column of the
 * same name, which sqlite does not).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { makePgDb } from "./db";
import { AUTONOMY_HOLDS_SQL, AUTONOMY_TRADE_FUNNEL_SQL, FLEET_RAILS_SQL } from "./autonomy-funnel";
import { readFleetHeartbeats, writeFleetHeartbeat, type FleetHeartbeat } from "./fleet-heartbeat";

const url = process.env.MERRYMEN_TEST_PG_URL;

test("Postgres: the heartbeat upsert and the funnel's grouped reads", { skip: !url, timeout: 40_000 }, async (t) => {
  const target = new URL(url!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "disposable LOCAL PostgreSQL only");
  const pg = createRequire(import.meta.url)("pg");
  const admin = new pg.Client({ connectionString: target.toString() });
  await admin.connect();
  const schema = `mm_fleet_heartbeat_${randomBytes(8).toString("hex")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(target);
  scoped.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=10000`);
  const db = await makePgDb(scoped.toString());
  const beat = (over: Partial<FleetHeartbeat>): FleetHeartbeat => ({
    role: "orchestrator", commit: null, startedAt: 100, beatAt: 200, halted: false,
    rollout: null, counts: null, lastShutdown: null, ...over,
  });
  try {
    await t.test("one row per role, created once, never moving backwards", async () => {
      assert.equal(await writeFleetHeartbeat(db, beat({ role: "recovery-replies" }), { create: false }), false, "no table: skipped");
      await writeFleetHeartbeat(db, beat({ beatAt: 200, halted: true }), { create: true });
      await writeFleetHeartbeat(db, beat({ beatAt: 260, halted: false }), { create: true });
      await writeFleetHeartbeat(db, beat({ beatAt: 230, halted: true }), { create: false });
      await writeFleetHeartbeat(db, beat({ role: "recovery-replies", beatAt: 250 }), { create: false });
      const rows = await readFleetHeartbeats(db, 300);
      assert.deepEqual(rows.map((h) => [h.role, h.beatAt, h.halted, h.beatAgeSec]), [
        ["orchestrator", 260, false, 40],
        ["recovery-replies", 250, false, 50],
      ]);
    });

    await t.test("the funnel's GROUP BY names are the aliases, not same-named columns", async () => {
      await db.exec(`CREATE TABLE trades (agent_id TEXT NOT NULL, status TEXT NOT NULL, reject_rule TEXT, created_at BIGINT NOT NULL);
        CREATE TABLE decisions (source TEXT NOT NULL, action TEXT, hold_kind TEXT, at BIGINT NOT NULL);
        CREATE TABLE agents (smart_account TEXT PRIMARY KEY, mode TEXT, live_blocker TEXT, beat_at BIGINT)`);
      const trade = db.prepare("INSERT INTO trades (agent_id, status, reject_rule, created_at) VALUES (?, ?, ?, ?)");
      await trade.run("0xa", "rejected", null, 2000);
      await trade.run("0xa", "rejected", "", 2000);
      await trade.run("0xa", "rejected", "no-exit", 2000);
      await trade.run("0xa", "rejected", "no-exit", 1000);
      const t1 = (await db.prepare(AUTONOMY_TRADE_FUNNEL_SQL).all(1500)) as { status: string; rule: string; n: unknown }[];
      assert.deepEqual(
        t1.map((r) => [r.rule, Number(r.n)]).sort(),
        [["", 2], ["no-exit", 1]],
        "NULL and '' are one rule, grouped by the coalesced alias",
      );
      const decision = db.prepare("INSERT INTO decisions (source, action, hold_kind, at) VALUES (?, ?, ?, ?)");
      await decision.run("market-review", "hold", null, 2000);
      await decision.run("research-unavailable", "hold", null, 2000);
      await decision.run("brain", "hold", null, 2000);
      await decision.run("brain", "hold", "MODEL_HOLD", 2000);
      const h = (await db.prepare(AUTONOMY_HOLDS_SQL).all(1500)) as { kind: string; n: unknown }[];
      assert.deepEqual(
        Object.fromEntries(h.map((r) => [r.kind, Number(r.n)])),
        { QUIET_REVIEW: 2, unreported: 1, MODEL_HOLD: 1 },
      );
      await db.prepare("INSERT INTO agents (smart_account, mode, beat_at) VALUES (?, ?, ?)").run("0xa", "live", 2000);
      assert.equal(((await db.prepare(FLEET_RAILS_SQL).all()) as unknown[]).length, 1);
    });
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
