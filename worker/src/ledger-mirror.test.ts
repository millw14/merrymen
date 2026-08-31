import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { wrapSqlite } from "./db";
import { MIRROR_STATE_DDL, mirrorTenant } from "./ledger-mirror";

/**
 * THE HOLE THIS FILLS, and why exactly-once is the whole point.
 *
 * `childEnv` strips DATABASE_URL from every worker child, so a child writes
 * sqlite inside its own container while the web service reads a Postgres nothing
 * ever wrote to. The result was total and invisible: no tape, no positions, no
 * equity, no events and no reasoning on the hosted dashboard, for anyone,
 * whatever the agent was doing — while balances still showed, because the web
 * reads those from the chain. It looked like a working dashboard with a quiet
 * agent.
 *
 * Source ids are unique only WITHIN one child's database — two tenants both have
 * event id 1 — so the id cannot be the destination key. Rows and their watermark
 * therefore move in ONE transaction. Insert-then-save duplicates the trade tape
 * every time a deploy lands mid-copy, which on a ledger is worse than lagging.
 */

const SRC = [
  "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, level TEXT, message TEXT, created_at INTEGER);",
  "CREATE TABLE trades (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, kind TEXT, target TEXT, sell_token TEXT, buy_token TEXT, amount_usdg REAL, user_op_hash TEXT, tx_hash TEXT, status TEXT, reject_rule TEXT, decision_id TEXT, fill_side TEXT, fill_qty_raw TEXT, fill_price_usd REAL, realized_pnl_usdg REAL, basis_source TEXT, gas_wei TEXT, created_at INTEGER);",
  "CREATE TABLE equity (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, eth_wei TEXT, cash_usdg REAL, vault_usdg REAL, equity_usdg REAL, at INTEGER);",
  "CREATE TABLE decisions (id TEXT PRIMARY KEY, agent_id TEXT, source TEXT, strategy TEXT, provider TEXT, model TEXT, symbol TEXT, action TEXT, size_usdg REAL, reason TEXT, dropped_rule TEXT, signals_json TEXT, at INTEGER);",
  "CREATE TABLE agents (smart_account TEXT PRIMARY KEY, name TEXT, owner_address TEXT, session_key_address TEXT, chain_id INTEGER, caps TEXT, granted_at INTEGER, expires_at INTEGER, status TEXT, created_at INTEGER, mode TEXT, beat_at INTEGER);",
  "CREATE TABLE positions (agent_id TEXT, symbol TEXT, token TEXT, raw_balance TEXT, ui_multiplier TEXT, price_usd REAL, price_stale INTEGER, price_source TEXT DEFAULT 'chainlink', value_usdg REAL, updated_at INTEGER, PRIMARY KEY (agent_id, symbol));",
].join("\n");

/** The destination, with the same shape a Postgres ledger has. */
const DEST = SRC + MIRROR_STATE_DDL;

const mem = (ddl: string) => {
  const db = new DatabaseSync(":memory:");
  db.exec(ddl);
  return wrapSqlite(db);
};

const seedChild = () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(SRC);
  raw.exec("INSERT INTO agents VALUES ('0xagent','Robin','0xowner','0xsk',4663,'{}',1,2,'armed',3,'live',99)");
  for (let i = 1; i <= 5; i++) {
    raw.exec(
      `INSERT INTO events (agent_id, level, message, created_at) VALUES ('0xagent','ok','e${i}',${100 + i})`,
    );
    raw.exec(
      `INSERT INTO trades (agent_id, kind, target, amount_usdg, status, created_at) VALUES ('0xagent','swap','0xt',${i},'landed',${100 + i})`,
    );
  }
  raw.exec("INSERT INTO positions VALUES ('0xagent','PEPE','0xp','1','1',2.0,0,'curve',10.0,9)");
  raw.exec(
    "INSERT INTO decisions VALUES ('d1','0xagent','strategist',null,null,null,'PEPE','buy',5,'looked cheap',null,'{}',9)",
  );
  return wrapSqlite(raw);
};

const count = async (db: ReturnType<typeof mem>, table: string): Promise<number> => {
  const r = (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()) as { n: number };
  return Number(r.n);
};

describe("the ledger mirror", () => {
  it("carries price_source across — a curve mark must not arrive as an oracle", async () => {
    // The positions SELECT omitted price_source, and the destination schema
    // defaults it to 'chainlink'. So the weakest mark this system produces — a
    // bonding-curve price — arrived in the shared ledger wearing an oracle's
    // name and rendered on the dashboard as oracle-grade. The whole point of the
    // column is that the three sources are NOT equally good evidence.
    const shared = mem(DEST);
    await mirrorTenant({ tenant: "0xten", child: seedChild(), shared });
    const row = (await shared.prepare("SELECT price_source FROM positions").get()) as {
      price_source: string;
    };
    assert.equal(row.price_source, "curve");
  });

  it("copies a child's ledger up", async () => {
    const shared = mem(DEST);
    const r = await mirrorTenant({ tenant: "0xten", child: seedChild(), shared });
    assert.equal(r.copied.events, 5);
    assert.equal(r.copied.trades, 5);
    assert.equal(r.copied.decisions, 1);
    assert.equal(r.copied.positions, 1);
    assert.equal(await count(shared, "events"), 5);
  });

  it("IS EXACTLY-ONCE — running twice does not duplicate the tape", async () => {
    // The property the whole design turns on. A trade shown twice is worse than
    // a trade shown late, and the orchestrator runs this every 15 seconds.
    const child = seedChild();
    const shared = mem(DEST);
    await mirrorTenant({ tenant: "0xten", child, shared });
    const second = await mirrorTenant({ tenant: "0xten", child, shared });
    assert.equal(second.copied.events, undefined, "nothing new to copy");
    assert.equal(await count(shared, "events"), 5, "events must not double");
    assert.equal(await count(shared, "trades"), 5, "trades must not double");
  });

  it("picks up only what is NEW on the next pass", async () => {
    const child = seedChild();
    const shared = mem(DEST);
    await mirrorTenant({ tenant: "0xten", child, shared });
    await child
      .prepare("INSERT INTO events (agent_id, level, message, created_at) VALUES (?,?,?,?)")
      .run("0xagent", "warn", "e6", 200);
    const r = await mirrorTenant({ tenant: "0xten", child, shared });
    assert.equal(r.copied.events, 1);
    assert.equal(await count(shared, "events"), 6);
  });

  it("keeps two tenants' ledgers apart despite colliding source ids", async () => {
    // Both children have event id 1. If the source id were the destination key
    // the second tenant's tape would collide with the first's — which is why
    // the watermark is keyed by (tenant, table) and the id is not carried over.
    const shared = mem(DEST);
    await mirrorTenant({ tenant: "0xaaa", child: seedChild(), shared });
    await mirrorTenant({ tenant: "0xbbb", child: seedChild(), shared });
    assert.equal(await count(shared, "events"), 10, "both tenants' events must survive");
  });

  it("REPLACES positions rather than merging — a closed position is gone", async () => {
    // An upsert alone would leave a sold coin on the dashboard forever, because
    // the source DELETES the row rather than zeroing it.
    const child = seedChild();
    const shared = mem(DEST);
    await mirrorTenant({ tenant: "0xten", child, shared });
    await child.prepare("DELETE FROM positions WHERE symbol = ?").run("PEPE");
    await mirrorTenant({ tenant: "0xten", child, shared });
    assert.equal(await count(shared, "positions"), 0, "a closed position must disappear too");
  });

  it("carries a renamed agent forward", async () => {
    const child = seedChild();
    const shared = mem(DEST);
    await mirrorTenant({ tenant: "0xten", child, shared });
    await child.prepare("UPDATE agents SET name = ? WHERE smart_account = ?").run("Little John", "0xagent");
    await mirrorTenant({ tenant: "0xten", child, shared });
    const row = (await shared
      .prepare("SELECT name FROM agents WHERE smart_account = ?")
      .get("0xagent")) as { name: string };
    assert.equal(row.name, "Little John");
  });

  it("survives a table that is missing at the source", async () => {
    // A child mid-migration, or an older worker. One table's worth of lag is
    // not a reason to abandon the rest of that tenant's ledger.
    const raw = new DatabaseSync(":memory:");
    raw.exec(
      "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, level TEXT, message TEXT, created_at INTEGER);",
    );
    raw.exec("INSERT INTO events (agent_id, level, message, created_at) VALUES ('0xa','ok','only',1)");
    const r = await mirrorTenant({ tenant: "0xten", child: wrapSqlite(raw), shared: mem(DEST) });
    assert.equal(r.copied.events, 1);
    assert.equal(r.copied.trades, undefined);
  });
});
