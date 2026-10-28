/** Real Postgres regression for a basis CTE inlined inside every decision join.
 * Opt-in and LOCAL ONLY; CI discovers the database variable below automatically. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { applyLedgerSchema } from "../../../worker/src/store";
import { translateQuery, translateSchema, type Db } from "../../../worker/src/db";
import { readPeerTheses } from "../../../worker/src/peer-theses";
import { readTheses } from "./read-theses";

const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;
interface Client {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}
const pg = (url ? createRequire(import.meta.url)("pg") : null) as {
  Client: new (config: { connectionString: string }) => Client;
  types: { setTypeParser(oid: number, parse: (value: string) => number): void };
} | null;
type Statement = { sql: string; params: unknown[] };
type Plan = {
  Alias?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  Plans?: Plan[];
};

test("Postgres: full feed reads quote history once while retaining figures, gates and IDs", { skip: !url, timeout: 60_000 }, async (t) => {
  const target = new URL(url!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "only disposable local Postgres is allowed");
  const schema = `mm_thesis_basis_${randomBytes(8).toString("hex")}`;
  target.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=20000 -c lock_timeout=2000`);
  pg!.types.setTypeParser(20, Number);
  const c = new pg!.Client({ connectionString: target.toString() });
  await c.connect();
  await c.query(`CREATE SCHEMA ${schema}`);
  const captured: Statement[] = [];
  const driver = (materialized = true): Db => {
    const query = async (sql: string, params: unknown[] = []) => {
      const text = translateQuery(materialized ? sql : sql.replace("basis_quote AS MATERIALIZED", "basis_quote AS"));
      if (materialized && text.startsWith("WITH basis_read")) captured.push({ sql: text, params });
      return c.query(text, params);
    };
    return {
      prepare: sql => ({
        all: async (...params) => (await query(sql, params)).rows,
        get: async (...params) => (await query(sql, params)).rows[0],
        run: async (...params) => ({ changes: (await query(sql, params)).rowCount ?? 0, lastInsertRowid: 0 }),
      }),
      exec: async sql => { await c.query(translateSchema(sql)); },
      tx: async fn => {
        await c.query("BEGIN");
        try { const value = await fn(driver(materialized)); await c.query("COMMIT"); return value; }
        catch (error) { await c.query("ROLLBACK"); throw error; }
      },
    };
  };
  const db = driver();
  const oldDb = driver(false);
  const now = Math.floor(Date.now() / 1000);
  const agents = [1, 2, 3, 4].map(n => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`);
  const identities = async () => agents.map((account, i) => ({ tenant: account, accounts: [account], slug: `aaaaaaaaaaaaaaa${i + 1}`, createdAt: 1, updatedAt: 1 }));
  const settings = (publicBook: boolean) => (async () => ({ publicBook })) as never;
  try {
    await applyLedgerSchema(db);
    await c.query(`INSERT INTO agents(smart_account,name,owner_address,session_key_address,chain_id,caps,granted_at,expires_at,mode,beat_at)
      SELECT '0x'||lpad(to_hex(i),40,'0'),'Fixture '||i,'0x1','0x2',4663,'{}',$1-86400*40,$1+86400,'live',$1-30
      FROM generate_series(1,32)i`, [now]);
    await c.query(`INSERT INTO trades(agent_id,kind,target,sell_token,buy_token,amount_usdg,status,reject_rule,created_at)
      SELECT a.smart_account,'swap','0x0','USDG','TSLA',5,'rejected','per-trade-cap',$1-86400*30+i*400
      FROM agents a CROSS JOIN generate_series(1,6000)i`, [now]);
    await c.query(`INSERT INTO decisions(id,agent_id,source,action,symbol,size_usdg,reason,at)
      SELECT a.smart_account||'-s'||i,a.smart_account,'brain','sell','TSLA',5,'Selling TSLA, fixture reason '||i,$1-80000+i*1800
      FROM agents a CROSS JOIN generate_series(1,40)i`, [now]);
    await c.query(`INSERT INTO trades(agent_id,kind,target,sell_token,buy_token,amount_usdg,status,decision_id,fill_side,fill_price_usd,fill_cash_usdg,realized_pnl_usdg,basis_source,created_at)
      SELECT agent_id,'swap','0x0','TsLa','USDG',5,'landed',id,'sell',200,5,1,'receipt',at FROM decisions`);
    await c.query("ANALYZE agents; ANALYZE trades; ANALYZE decisions; ANALYZE posts");

    const first = await readTheses({}, fn => fn(db), identities, settings(false));
    assert.equal(first.theses.length, 40);
    assert.ok(first.theses.every(post => post.realizedPct === 25 && post.realizedUsd === null));
    const statement = captured[0]!;
    const { rows } = await c.query("EXPLAIN (ANALYZE, FORMAT JSON) " + statement.sql, statement.params);
    const plan = (rows[0]!["QUERY PLAN"] as { Plan: Plan }[])[0]!.Plan;
    let historyVisits = 0;
    const inspect = (node: Plan) => {
      if (node.Alias === "bq") historyVisits += ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) * (node["Actual Loops"] ?? 0);
      node.Plans?.forEach(inspect);
    };
    inspect(plan);
    // Counts actual table work, not elapsed milliseconds or a particular join
    // algorithm. Allow parallel EXPLAIN averaging; rescanning per sell fails.
    assert.ok(historyVisits <= 2 * 193_280, `quote history visited ${historyVisits} rows for 193,280 stored trades`);
    t.diagnostic(`quote-history visits: ${historyVisits}; stored trades: 193280`);
    // Keep the equivalence cases small; the larger no-quote distribution above
    // is what reproduces PostgreSQL's destructive inlining choice.
    await c.query("DELETE FROM trades WHERE NOT (agent_id = ANY($1))", [agents]);
    await c.query("DELETE FROM decisions WHERE NOT (agent_id = ANY($1))", [agents]);
    await c.query("DELETE FROM agents WHERE NOT (smart_account = ANY($1))", [agents]);
    await c.query("ANALYZE agents; ANALYZE trades; ANALYZE decisions");
    const full = await readTheses({ limit: 200 }, fn => fn(db), identities, settings(false));
    assert.equal(full.theses.length, 160);
    assert.deepEqual(full, await readTheses({ limit: 200 }, fn => fn(oldDb), identities, settings(false)));

    // Same account + mixed-case token: only sells after the quote lose figures.
    // Another account's quotes cannot taint receipt fills, and paper closes its
    // own book. An account outside the bounded basis read stays unread.
    await c.query(`INSERT INTO trades(agent_id,kind,target,sell_token,buy_token,amount_usdg,status,fill_side,basis_source,created_at)
      VALUES ($1,'swap','0x0','USDG','tSLA',5,'landed','buy','quote',$3-43000),
             ($2,'swap','0x0','USDG','TSLA',5,'landed','buy','quote',$3-86400)`, [agents[0], agents[1], now]);
    await c.query("UPDATE trades SET basis_source='paper',status='paper' WHERE agent_id=$1 AND fill_side='sell'", [agents[1]]);
    await c.query("UPDATE trades SET created_at=$2-86400*40 WHERE agent_id=$1 AND fill_side='sell'", [agents[3], now]);
    for (const published of [false, true]) {
      const candidate = await readTheses({ limit: 200 }, fn => fn(db), identities, settings(published));
      const original = await readTheses({ limit: 200 }, fn => fn(oldDb), identities, settings(published));
      assert.deepEqual(candidate, original, "same publication, amounts, outcomes, counts and post IDs");
      const of = (i: number) => candidate.theses.filter(post => post.slug === `aaaaaaaaaaaaaaa${i}`);
      for (let i = 1; i <= 4; i++) assert.equal(of(i).length, 40);
      assert.equal(of(1).filter(post => post.realizedPct === 25).length, 20);
      assert.equal(of(1).filter(post => post.realizedPct === null).length, 20);
      assert.ok(of(2).every(post => post.realizedPct === 25));
      assert.ok(of(3).every(post => post.realizedPct === 25));
      assert.ok(of(4).every(post => post.realizedPct === null));
      assert.ok(candidate.theses.every(post => post.realizedUsd === (published && post.realizedPct !== null ? 1 : null)));
      assert.ok(candidate.theses.every(post => post.postId));
    }
    const peers = await readPeerTheses(db, agents);
    const oldPeers = await readPeerTheses(oldDb, agents);
    assert.deepEqual(peers, oldPeers, "the shared helper preserves the worker peer publication too");
    assert.ok(peers.length > 0);
  } finally {
    await c.query(`DROP SCHEMA ${schema} CASCADE`);
    await c.end();
  }
});
