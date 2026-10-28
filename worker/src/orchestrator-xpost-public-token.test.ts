import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { wrapSqlite } from "./db";
import { publicTokenForDecision } from "./orchestrator-xpost";
import { PUBLISHABLE_SOURCES } from "./thesis-policy";

const agent = { address: `0x${"aa".repeat(20)}`, chainId: 4663 };
const token = `0x${"bb".repeat(20)}`;
const hash = `0x${"12".repeat(32)}`;

test("public CA comes from the landed scoped decision, exact token side, and matching network", async (t) => {
  const raw = new DatabaseSync(":memory:");
  t.after(() => raw.close());
  const db = wrapSqlite(raw);
  await db.exec(`
    CREATE TABLE agents (smart_account TEXT, chain_id INTEGER, epoch INTEGER DEFAULT 1);
    CREATE TABLE decisions (id TEXT, agent_id TEXT, action TEXT, source TEXT);
    CREATE TABLE trades (id INTEGER PRIMARY KEY, decision_id TEXT, agent_id TEXT, kind TEXT, status TEXT, tx_hash TEXT, buy_token TEXT, sell_token TEXT,
      epoch INTEGER DEFAULT 1, basis_source TEXT DEFAULT 'receipt', fill_side TEXT DEFAULT 'buy', fill_qty_raw TEXT DEFAULT '1');
  `);
  await db.prepare("INSERT INTO agents (smart_account, chain_id) VALUES (?, ?)").run(agent.address, agent.chainId);
  await db.prepare("INSERT INTO decisions VALUES (?, ?, ?, ?)").run("d1", agent.address, "buy", PUBLISHABLE_SOURCES[0]!);
  await db.prepare("INSERT INTO trades (id, decision_id, agent_id, kind, status, tx_hash, buy_token, sell_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(1, "d1", agent.address, "swap", "landed", hash, token, agent.address);
  assert.deepEqual(await publicTokenForDecision(db, agent, "d1", "buy"), { address: token, chainId: 4663, txHash: hash });
  assert.equal(await publicTokenForDecision(db, { ...agent, chainId: 46630 }, "d1", "buy"), null);
  assert.equal(await publicTokenForDecision(db, { ...agent, address: token }, "d1", "buy"), null);
  assert.equal(await publicTokenForDecision(db, agent, "d1", "sell"), null);
  await db.prepare("UPDATE trades SET tx_hash = NULL").run();
  assert.equal(await publicTokenForDecision(db, agent, "d1", "buy"), null, "landed without execution hash is not proof");
  await db.prepare("UPDATE trades SET tx_hash = ?, status = 'reverted'").run(hash);
  assert.equal(await publicTokenForDecision(db, agent, "d1", "buy"), null);
  await db.prepare("UPDATE trades SET status = 'landed', agent_id = ?").run(token);
  assert.equal(await publicTokenForDecision(db, agent, "d1", "buy"), null, "a joined decision cannot borrow another agent's trade");
  await db.prepare("UPDATE trades SET agent_id = ?").run(agent.address);
  await db.prepare("UPDATE decisions SET action = 'sell'").run();
  await db.prepare("UPDATE trades SET fill_side = 'sell'").run();
  assert.deepEqual(await publicTokenForDecision(db, agent, "d1", "sell"), { ...agent, txHash: hash });
  for (const [column, value] of [["epoch", 0], ["basis_source", "quote"], ["fill_side", "buy"], ["fill_qty_raw", "0"], ["fill_qty_raw", null]] as const) {
    await db.prepare(`UPDATE trades SET ${column} = ?`).run(value);
    assert.equal(await publicTokenForDecision(db, agent, "d1", "sell"), null, `${column}=${value} is not current receipt proof`);
    await db.prepare("UPDATE trades SET epoch = 1, basis_source = 'receipt', fill_side = 'sell', fill_qty_raw = '1'").run();
  }
  await db.prepare("UPDATE trades SET status = 'paper', tx_hash = NULL").run();
  assert.equal(await publicTokenForDecision(db, agent, "d1", "sell"), null, "paper requires dedicated simulated basis");
  await db.prepare("UPDATE trades SET basis_source = 'paper'").run();
  assert.deepEqual(await publicTokenForDecision(db, agent, "d1", "sell"), { ...agent, txHash: null }, "paper has no transaction to link");
  await db.prepare("UPDATE decisions SET source = 'untrusted'").run();
  assert.equal(await publicTokenForDecision(db, agent, "d1", "sell"), null);
});
