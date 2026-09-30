/**
 * The coin's name reaches the shared ledger, and is never erased there.
 *
 * The child writes `fill_symbol` with the fill (store.ts fillSymbolOfRow). The
 * mirror must carry it on the ordinary copy AND on the resolution pass that
 * lands a shared row copied while still 'submitted' — and, like every evidence
 * column there, only ever add it: a child row that lost its name (a stranded
 * op resolved from its receipt) must not blank the shared one.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { wrapSqlite } from "./db";
import { MIRROR_STATE_DDL, mirrorTenant } from "./ledger-mirror";

const TRADES =
  "CREATE TABLE trades (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, kind TEXT, target TEXT, sell_token TEXT, buy_token TEXT, amount_usdg REAL, user_op_hash TEXT, tx_hash TEXT, status TEXT, reject_rule TEXT, decision_id TEXT, fill_side TEXT, fill_symbol TEXT, fill_qty_raw TEXT, fill_price_usd REAL, realized_pnl_usdg REAL, basis_source TEXT, gas_wei TEXT, sponsored_gas_wei TEXT, gas_usdg REAL, gas_units TEXT, fill_cash_usdg REAL, epoch INTEGER DEFAULT 1, created_at INTEGER);";

const mem = (ddl: string) => {
  const db = new DatabaseSync(":memory:");
  db.exec(ddl);
  return wrapSqlite(db);
};
const now = Math.floor(Date.now() / 1000);

describe("the mirror carries the coin's name", () => {
  it("on the ordinary copy", async () => {
    const child = mem(TRADES);
    const shared = mem(TRADES + MIRROR_STATE_DDL);
    await child
      .prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, status, fill_side, fill_symbol, epoch, created_at) VALUES ('0xagent','swap','0xt',5,'paper','buy','AAPL',2,?)`)
      .run(now);
    await mirrorTenant({ tenant: "0xten", child, shared });
    assert.equal(((await shared.prepare("SELECT fill_symbol FROM trades").get()) as { fill_symbol: string }).fill_symbol, "AAPL");
  });

  it("when a row copied while 'submitted' lands with a name", async () => {
    const child = mem(TRADES);
    const shared = mem(TRADES + MIRROR_STATE_DDL);
    await child
      .prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, status, epoch, created_at) VALUES ('0xagent','swap','0xt',5,'0xop1','submitted',2,?)`)
      .run(now);
    await mirrorTenant({ tenant: "0xten", child, shared });
    await child.prepare(`UPDATE trades SET status='landed', tx_hash='0xtx1', fill_side='buy', fill_symbol='CASHCAT' WHERE user_op_hash='0xop1'`).run();
    const r = await mirrorTenant({ tenant: "0xten", child, shared });
    // Only trades exist in this ledger; the other tables failing is expected.
    assert.equal(r.failed?.trades, undefined);
    assert.equal(r.failed?.trades_resolved, undefined);
    const row = (await shared.prepare("SELECT status, fill_symbol FROM trades WHERE user_op_hash='0xop1'").get()) as Record<string, unknown>;
    assert.deepEqual({ ...row }, { status: "landed", fill_symbol: "CASHCAT" });
  });

  it("and a resolution that lost the name never erases it", async () => {
    const child = mem(TRADES);
    const shared = mem(TRADES + MIRROR_STATE_DDL);
    await child
      .prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, status, fill_symbol, epoch, created_at) VALUES ('0xagent','swap','0xt',5,'0xop2','submitted','PEPE2',2,?)`)
      .run(now);
    await mirrorTenant({ tenant: "0xten", child, shared });
    await child.prepare(`UPDATE trades SET status='landed', tx_hash='0xtx2', fill_symbol=NULL WHERE user_op_hash='0xop2'`).run();
    await mirrorTenant({ tenant: "0xten", child, shared });
    const row = (await shared.prepare("SELECT status, fill_symbol FROM trades WHERE user_op_hash='0xop2'").get()) as Record<string, unknown>;
    assert.deepEqual({ ...row }, { status: "landed", fill_symbol: "PEPE2" });
  });
});
