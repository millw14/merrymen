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
  "CREATE TABLE trades (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, kind TEXT, target TEXT, sell_token TEXT, buy_token TEXT, amount_usdg REAL, user_op_hash TEXT, tx_hash TEXT, status TEXT, reject_rule TEXT, decision_id TEXT, fill_side TEXT, fill_qty_raw TEXT, fill_price_usd REAL, realized_pnl_usdg REAL, basis_source TEXT, gas_wei TEXT, sponsored_gas_wei TEXT, gas_usdg REAL, fill_cash_usdg REAL, epoch INTEGER DEFAULT 1, created_at INTEGER);",
  "CREATE TABLE equity (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, eth_wei TEXT, cash_usdg REAL, vault_usdg REAL, positions_usdg REAL, equity_usdg REAL, epoch INTEGER DEFAULT 1, at INTEGER);",
  "CREATE TABLE flows (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, direction TEXT, amount_usdg REAL, tx_hash TEXT, block_number INTEGER, log_index INTEGER, source TEXT, epoch INTEGER DEFAULT 1, at INTEGER);",
  "CREATE TABLE fee_accruals (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, profit_usdg REAL, fee_usdg REAL, hwm_before_usdg REAL, hwm_after_usdg REAL, epoch INTEGER DEFAULT 1, at INTEGER);",
  "CREATE TABLE decisions (id TEXT PRIMARY KEY, agent_id TEXT, source TEXT, strategy TEXT, provider TEXT, model TEXT, symbol TEXT, action TEXT, size_usdg REAL, reason TEXT, dropped_rule TEXT, signals_json TEXT, at INTEGER);",
  "CREATE TABLE agents (smart_account TEXT PRIMARY KEY, name TEXT, owner_address TEXT, session_key_address TEXT, chain_id INTEGER, caps TEXT, granted_at INTEGER, expires_at INTEGER, status TEXT, created_at INTEGER, mode TEXT, beat_at INTEGER, sponsor_gas INTEGER, x_handle TEXT, epoch INTEGER DEFAULT 1, hwm_usdg REAL DEFAULT 0, accrued_fee_usdg REAL DEFAULT 0, contributions_known INTEGER, contributions_why TEXT, gas_accounting TEXT, quality_at INTEGER);",
  "CREATE TABLE positions (agent_id TEXT, symbol TEXT, token TEXT, raw_balance TEXT, ui_multiplier TEXT, price_usd REAL, price_stale INTEGER, price_source TEXT DEFAULT 'chainlink', value_usdg REAL, updated_at INTEGER, PRIMARY KEY (agent_id, symbol));",
  "CREATE TABLE cost_basis (agent_id TEXT, mode TEXT, symbol TEXT, qty_raw TEXT, cost_usdg TEXT, updated_at INTEGER, PRIMARY KEY (agent_id, mode, symbol));",
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
  // Columns named rather than positional: this row grew three fields and a
  // positional INSERT would have to be rewritten for each one.
  //
  // EPOCH 2 ON PURPOSE. The agent is on its second run, so a mirror that drops
  // the column leaves the shared row at its DEFAULT 1 — which is exactly the
  // failure this fixture has to be able to see.
  raw.exec(
    `INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps,
                         granted_at, expires_at, status, created_at, mode, beat_at, sponsor_gas,
                         x_handle, epoch, hwm_usdg, accrued_fee_usdg)
     VALUES ('0xagent','Robin','0xowner','0xsk',4663,'{}',1,2,'armed',3,'live',99,1,'much_miller',2,150.5,7.25)`,
  );
  for (let i = 1; i <= 5; i++) {
    raw.exec(
      `INSERT INTO events (agent_id, level, message, created_at) VALUES ('0xagent','ok','e${i}',${100 + i})`,
    );
    raw.exec(
      `INSERT INTO trades (agent_id, kind, target, amount_usdg, status, gas_usdg, epoch, created_at)
       VALUES ('0xagent','swap','0xt',${i},'landed',0.25,2,${100 + i})`,
    );
  }
  raw.exec("INSERT INTO positions VALUES ('0xagent','PEPE','0xp','1','1',2.0,0,'curve',10.0,9)");
  raw.exec("INSERT INTO cost_basis VALUES ('0xagent','live','PEPE','1','6.0',9)");
  raw.exec(
    "INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, at)" +
      " VALUES ('0xagent','1000',90.0,0.0,10.0,100.0,2,120)",
  );
  // A deposit and a withdrawal. Without these the shared ledger has no flow
  // term at all, contributions read as UNKNOWN, and P&L is null forever.
  raw.exec(
    "INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, at)" +
      " VALUES ('0xagent','in',80.0,'0xdeadbeef',555,4,'chain-log',2,110)",
  );
  raw.exec(
    "INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, source, epoch, at)" +
      " VALUES ('0xagent','out',5.0,'0xfeedface',556,'transfer-intent',2,111)",
  );
  raw.exec(
    "INSERT INTO fee_accruals (agent_id, profit_usdg, fee_usdg, hwm_before_usdg, hwm_after_usdg, epoch, at)" +
      " VALUES ('0xagent',20.0,2.0,130.5,150.5,2,115)",
  );
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
    // Zero, not absent. An absent count is indistinguishable from a table
    // nobody looked at, which is exactly how a stalled cursor hid in
    // production for as long as it did.
    assert.equal(second.copied.events, 0, "nothing new to copy, and it says so");
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
    // A table that does not EXIST is a failure, not an empty one — the SELECT
    // throws — so it has no count and is named in `failed` instead. That
    // distinction is the point: "could not read" and "nothing to read" must
    // never render the same, here or anywhere else in this codebase.
    assert.equal(r.copied.trades, undefined);
    assert.ok(r.failed?.trades, "an unreadable table is reported as failed");
  });

  it("CARRIES THE FLOW TERM — without it a deposit reads as a gain", async () => {
    // `flows` was never in LOG_TABLES, and the shared database HAS the table
    // because applyLedgerSchema creates it. So the contributions query succeeded,
    // returned zero rows, and equity.ts — which refuses to publish a number it
    // cannot back — returned null. Every hosted agent's P&L was a dash, forever,
    // and no error was raised anywhere to say so.
    const shared = mem(DEST);
    const r = await mirrorTenant({ tenant: "0xten", child: seedChild(), shared });
    assert.equal(r.copied.flows, 2, "both the deposit and the withdrawal must travel");

    const net = (await shared
      .prepare(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END), 0) AS net
           FROM flows WHERE agent_id = ?`,
      )
      .get("0xagent")) as { n: number; net: number };
    // n > 0 is the whole point: it is what turns contributions from UNKNOWN into
    // a figure, which is what turns P&L from null into a number.
    assert.equal(Number(net.n), 2);
    assert.equal(Number(net.net), 75);

    // The tx hash is what makes a flow evidence rather than an inference.
    const dep = (await shared
      .prepare("SELECT tx_hash, block_number, log_index, source FROM flows WHERE direction = 'in'")
      .get()) as { tx_hash: string; block_number: number; log_index: number; source: string };
    assert.equal(dep.tx_hash, "0xdeadbeef");
    assert.equal(Number(dep.block_number), 555);
    // Without the index a re-read of the final block cannot tell this transfer
    // from another in the same transaction.
    assert.equal(Number(dep.log_index), 4);
    assert.equal(dep.source, "chain-log");
  });

  it("carries who pays the gas, which only the worker knows", async () => {
    // The dashboard cannot resolve this for itself: sponsorship is worker config
    // and hosted the web service is a different container with a different
    // environment. A web-side guess reads false on a fleet whose deploy docs say
    // the web service needs no bundler key — telling every sponsored owner to go
    // send ETH they do not need. Same class of bug as `mode`, same fix.
    const shared = mem(DEST);
    await mirrorTenant({ tenant: "0xten", child: seedChild(), shared });
    const a = (await shared
      .prepare("SELECT sponsor_gas FROM agents WHERE smart_account = ?")
      .get("0xagent")) as { sponsor_gas: number | null };
    assert.equal(Number(a.sponsor_gas), 1);
  });

  it("carries the owner's handle, so a public page can credit somebody", async () => {
    // It rides the agents row rather than tenant settings, which are sealed — a
    // public feed must never decrypt a tenant to render a name.
    const shared = mem(DEST);
    await mirrorTenant({ tenant: "0xten", child: seedChild(), shared });
    const a = (await shared
      .prepare("SELECT x_handle FROM agents WHERE smart_account = ?")
      .get("0xagent")) as { x_handle: string | null };
    assert.equal(a.x_handle, "much_miller");
  });

  it("carries the agent's epoch, high-water mark and accrued fee", async () => {
    // All three were dropped. `epoch` is the dangerous one: both web routes
    // filter every query on it, and while nothing carried it the shared row sat
    // at DEFAULT 1 and so did every mirrored trade — so the filter matched
    // everything and two separate runs were spliced into one book. The other two
    // are read with COALESCE(..., 0), so an absent high-water mark and accrued
    // fee did not render as unknown; they rendered as a confident zero.
    const shared = mem(DEST);
    await mirrorTenant({ tenant: "0xten", child: seedChild(), shared });
    const a = (await shared
      .prepare("SELECT epoch, hwm_usdg, accrued_fee_usdg FROM agents WHERE smart_account = ?")
      .get("0xagent")) as { epoch: number; hwm_usdg: number; accrued_fee_usdg: number };
    assert.equal(Number(a.epoch), 2, "the agent is on its SECOND run — 1 here is the default, not the truth");
    assert.equal(Number(a.hwm_usdg), 150.5);
    assert.equal(Number(a.accrued_fee_usdg), 7.25);

    // And the rows must agree with it, or the epoch filter finds nothing.
    const t = (await shared
      .prepare("SELECT COUNT(*) AS n FROM trades WHERE agent_id = ? AND epoch = ?")
      .get("0xagent", 2)) as { n: number };
    assert.equal(Number(t.n), 5);
    const e = (await shared
      .prepare("SELECT COUNT(*) AS n FROM equity WHERE agent_id = ? AND epoch = ?")
      .get("0xagent", 2)) as { n: number };
    assert.equal(Number(e.n), 1);
  });

  it("carries gas priced in USDG, so 'net of gas' is a claim we can back", async () => {
    // gas_wei travelled and gas_usdg did not, so hosted summed 0.00 of gas AND
    // counted every landed fill as unpriceable — a warning stamped on every book
    // that was really about our own missing column.
    const shared = mem(DEST);
    await mirrorTenant({ tenant: "0xten", child: seedChild(), shared });
    const g = (await shared
      .prepare(
        `SELECT COALESCE(SUM(gas_usdg), 0) AS usdg,
                SUM(CASE WHEN gas_wei IS NOT NULL AND gas_usdg IS NULL THEN 1 ELSE 0 END) AS unpriced
           FROM trades WHERE agent_id = ? AND status = 'landed'`,
      )
      .get("0xagent")) as { usdg: number; unpriced: number };
    assert.equal(Number(g.usdg), 1.25, "5 fills at 0.25");
    assert.equal(Number(g.unpriced), 0);
  });

  it("carries what a position COST, not just what it is worth", async () => {
    // positions says the holding is worth 10.00 now; without the basis there is
    // no entry price and no P&L, so a feed can say an agent holds something and
    // not whether that is up or down.
    const shared = mem(DEST);
    const r = await mirrorTenant({ tenant: "0xten", child: seedChild(), shared });
    assert.equal(r.copied.cost_basis, 1);
    const b = (await shared
      .prepare("SELECT qty_raw, cost_usdg FROM cost_basis WHERE agent_id = ? AND symbol = ?")
      .get("0xagent", "PEPE")) as { qty_raw: string; cost_usdg: string };
    assert.equal(String(b.cost_usdg), "6.0");
  });

  it("drops a basis whose position closed", async () => {
    // Deleted at the source, so an upsert alone would leave it here forever and
    // the feed would show P&L on something the agent no longer holds.
    const child = seedChild();
    const shared = mem(DEST);
    await mirrorTenant({ tenant: "0xten", child, shared });
    await child.prepare("DELETE FROM cost_basis WHERE symbol = ?").run("PEPE");
    await mirrorTenant({ tenant: "0xten", child, shared });
    assert.equal(await count(shared, "cost_basis"), 0);
  });

  it("A LIVE FILL DOES NOT FREEZE AT 'submitted'", async () => {
    // The bug: a live trade is written as `submitted` when the UserOp goes out,
    // then UPDATED IN PLACE when it lands. The log-table watermark is on id, so
    // the first write was copied and the second never was — the row keeps its
    // id and the cursor is already past it. Hosted, every successful trade
    // stayed "sent, waiting on the chain" forever, and since the scoreboard and
    // the feed both filter status = 'landed', every fill was invisible to them.
    const child = seedChild();
    const shared = mem(DEST);
    const now = Math.floor(Date.now() / 1000);
    await child
      .prepare(
        `INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, status, epoch, created_at)
         VALUES ('0xagent','swap','0xt',42,'0xop1','submitted',2,?)`,
      )
      .run(now);
    await mirrorTenant({ tenant: "0xten", child, shared });
    const before = (await shared
      .prepare("SELECT status FROM trades WHERE user_op_hash = ?")
      .get("0xop1")) as { status: string };
    assert.equal(before.status, "submitted", "it arrives unresolved, as it should");

    // It lands at the source, in place, keeping its id.
    await child
      .prepare("UPDATE trades SET status = 'landed', tx_hash = ?, gas_usdg = ? WHERE user_op_hash = ?")
      .run("0xtx1", 0.31, "0xop1");
    const r = await mirrorTenant({ tenant: "0xten", child, shared });

    const after = (await shared
      .prepare("SELECT status, tx_hash, gas_usdg FROM trades WHERE user_op_hash = ?")
      .get("0xop1")) as { status: string; tx_hash: string; gas_usdg: number };
    assert.equal(after.status, "landed");
    assert.equal(after.tx_hash, "0xtx1");
    assert.equal(Number(after.gas_usdg), 0.31);
    assert.equal(r.copied.trades_resolved, 1);
  });

  it("the resolution pass is idempotent and never rewrites a settled row", async () => {
    // `AND status = 'submitted'` on the destination is the entire correctness
    // argument: it is the same key and guard addTrade uses at the source, so
    // this pass can only convert a submitted row into its resolution. Drop it
    // and every pass starts overwriting settled history from a rolling window.
    const child = seedChild();
    const shared = mem(DEST);
    const now = Math.floor(Date.now() / 1000);
    await child
      .prepare(
        `INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, status, epoch, created_at)
         VALUES ('0xagent','swap','0xt',42,'0xop2','submitted',2,?)`,
      )
      .run(now);
    await mirrorTenant({ tenant: "0xten", child, shared });
    await child
      .prepare("UPDATE trades SET status = 'landed', tx_hash = ? WHERE user_op_hash = ?")
      .run("0xtx2", "0xop2");

    const first = await mirrorTenant({ tenant: "0xten", child, shared });
    assert.equal(first.copied.trades_resolved, 1);

    const second = await mirrorTenant({ tenant: "0xten", child, shared });
    assert.equal(second.copied.trades_resolved, undefined, "nothing left to resolve");
    assert.equal(await count(shared, "trades"), 6, "and nothing was duplicated");
  });

  it("KEEPS EVERY DECISION — the tape is not a top-500 sample any more", async () => {
    // decisions used to copy `ORDER BY at DESC LIMIT 500` with no cursor, so a
    // child that wrote more than a batch between passes lost the overflow
    // permanently. That was dashboard furniture once. It is now the content
    // other agents read, and a dropped thesis is a peer input that never
    // arrives — so completeness is a correctness property, not a nicety.
    const child = seedChild();
    const shared = mem(DEST);
    for (let i = 0; i < 600; i++) {
      await child
        .prepare("INSERT INTO decisions VALUES (?, '0xagent','strategist',null,null,null,'PEPE','buy',5,?,null,'{}',?)")
        .run(`x${i}`, `reason ${i}`, 1000 + i);
    }
    // Two passes: the first fills a batch, the second collects the rest.
    await mirrorTenant({ tenant: "0xten", child, shared });
    await mirrorTenant({ tenant: "0xten", child, shared });
    assert.equal(await count(shared, "decisions"), 601, "600 seeded plus the fixture's d1");
  });

  it("the decisions cursor re-reads its own second, so a tie is never skipped", async () => {
    // `at` is not unique. A cursor resuming exactly at its watermark would drop
    // every row sharing that second with the last one it copied.
    const child = seedChild();
    const shared = mem(DEST);
    await child
      .prepare("INSERT INTO decisions VALUES ('t1','0xagent','strategist',null,null,null,'A','buy',1,'first',null,'{}',5000)")
      .run();
    await mirrorTenant({ tenant: "0xten", child, shared });
    // A second decision written in the SAME second, after the cursor moved.
    await child
      .prepare("INSERT INTO decisions VALUES ('t2','0xagent','strategist',null,null,null,'B','buy',1,'same second',null,'{}',5000)")
      .run();
    await mirrorTenant({ tenant: "0xten", child, shared });
    const got = (await shared.prepare("SELECT COUNT(*) AS n FROM decisions WHERE at = 5000").get()) as { n: number };
    assert.equal(Number(got.n), 2, "both rows from that second survived");
  });

  it("RECOVERS WHEN THE CHILD LEDGER IS REBUILT BENEATH THE WATERMARK", async () => {
    // The bug this pins cost the entire fleet its trade tape, indefinitely, and
    // reported success the whole time.
    //
    // mirror_state lives in shared Postgres; `last_id` is an id in the CHILD's
    // sqlite. Those two do not have the same lifetime — a child home sits on the
    // orchestrator container's own filesystem with no volume behind it, so a
    // redeploy destroys the ledger and AUTOINCREMENT restarts at 1 under a
    // watermark that still reads five. `id > from` then matches nothing for
    // ever, and the empty path recorded neither a count nor a failure.
    //
    // Nothing in this suite could have caught it: all the other cases reuse one
    // seedChild(), so the source is never reborn.
    const shared = mem(DEST);
    await mirrorTenant({ tenant: "0xten", child: seedChild(), shared });
    assert.equal(await count(shared, "trades"), 5, "the first incarnation arrived");

    // The redeploy: a brand-new ledger, ids restarting at 1.
    const rebornRaw = new DatabaseSync(":memory:");
    rebornRaw.exec(SRC);
    for (let i = 1; i <= 2; i++) {
      rebornRaw.exec(
        `INSERT INTO trades (agent_id, kind, target, amount_usdg, status, epoch, created_at)
         VALUES ('0xagent','swap','0xt',${i},'paper',1,${900 + i})`,
      );
    }
    const reborn = wrapSqlite(rebornRaw);

    const r = await mirrorTenant({ tenant: "0xten", child: reborn, shared });
    assert.equal(r.copied.trades, 2, "rows written after the rebuild must arrive");
    assert.equal(r.restarted?.trades?.was, 5, "and the rewind is reported, not silent");
    assert.equal(await count(shared, "trades"), 7);

    // And still exactly-once against the NEW ledger.
    const again = await mirrorTenant({ tenant: "0xten", child: reborn, shared });
    assert.equal(again.copied.trades, 0, "no second delivery");
    assert.equal(await count(shared, "trades"), 7);
  });

  it("does NOT rewind while the ledger is merely idle", async () => {
    // The rewind must be impossible to trigger within one incarnation: this
    // file's exactly-once property rests solely on the watermark, so a spurious
    // rewind duplicates the tape — and a trade shown twice is worse than one
    // shown late.
    const child = seedChild();
    const shared = mem(DEST);
    await mirrorTenant({ tenant: "0xten", child, shared });
    const second = await mirrorTenant({ tenant: "0xten", child, shared });
    assert.equal(second.restarted, undefined, "an idle pass is not a rebuild");
    assert.equal(await count(shared, "trades"), 5, "and nothing was copied twice");
  });

  it("carries the positions leg of the equity identity", async () => {
    const shared = mem(DEST);
    await mirrorTenant({ tenant: "0xten", child: seedChild(), shared });
    const e = (await shared
      .prepare("SELECT cash_usdg, vault_usdg, positions_usdg, equity_usdg FROM equity")
      .get()) as { cash_usdg: number; vault_usdg: number; positions_usdg: number; equity_usdg: number };
    assert.equal(Number(e.positions_usdg), 10);
    // The mirrored row must still decompose into the numbers that made it.
    assert.equal(
      Number(e.cash_usdg) + Number(e.vault_usdg) + Number(e.positions_usdg),
      Number(e.equity_usdg),
    );
  });
});
