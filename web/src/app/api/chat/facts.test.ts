/** Actual dashboard POST route, disk grant resolution and read-only SQLite ledger. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, mock, test } from "node:test";
import { POST } from "./route";

const OWNER = `0x${"a".repeat(40)}`;
const OTHER = `0x${"b".repeat(40)}`;
const NOW = Date.parse("2026-10-01T12:00:00Z") / 1000;
const DAY = Date.parse("2026-10-01T00:00:00Z") / 1000;
const home = mkdtempSync(path.join(os.tmpdir(), "merrymen-chat-facts-route-"));
const envKeys = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "DATABASE_URL"] as const;
const saved = new Map(envKeys.map(key => [key, process.env[key]]));
let fetches = 0;

before(() => {
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_HOSTED = "0";
  delete process.env.DATABASE_URL;
  mock.method(Date, "now", () => NOW * 1000);
  mock.method(globalThis, "fetch", async () => {
    fetches++;
    throw new Error("the factual route must not call a model or external service");
  });
  writeFileSync(path.join(home, "grant.json"), JSON.stringify({ smartAccount: OWNER }), "utf8");
  const db = new DatabaseSync(path.join(home, "merrymen.db"));
  try {
    // Modern run/fill metadata is present, including recorded receipt cash.
    db.exec(`
      CREATE TABLE agents (
        smart_account TEXT PRIMARY KEY, name TEXT NOT NULL, owner_address TEXT NOT NULL,
        session_key_address TEXT NOT NULL, chain_id INTEGER NOT NULL, caps TEXT NOT NULL,
        granted_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL,
        epoch INTEGER NOT NULL, energy TEXT
      );
      CREATE TABLE decisions (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, symbol TEXT, display_name TEXT,
        reason TEXT, source TEXT
      );
      CREATE TABLE trades (
        id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, epoch INTEGER NOT NULL,
        kind TEXT NOT NULL, target TEXT NOT NULL, buy_token TEXT, sell_token TEXT,
        amount_usdg REAL NOT NULL, user_op_hash TEXT, tx_hash TEXT,
        status TEXT NOT NULL, reject_rule TEXT, created_at INTEGER NOT NULL,
        decision_id TEXT, fill_side TEXT, fill_symbol TEXT, fill_cash_usdg REAL,
        fill_qty_raw TEXT, basis_source TEXT, realized_pnl_usdg REAL
      );
    `);
    const agent = db.prepare("INSERT INTO agents VALUES (?, 'Shogun', ?, ?, 4663, '{}', ?, ?, 'armed', 3, NULL)");
    agent.run(OWNER, OWNER, OWNER, DAY - 1000, NOW + 86400);
    agent.run(OTHER, OTHER, OTHER, DAY - 1000, NOW + 86400);
    const decision = db.prepare("INSERT INTO decisions VALUES (?, ?, ?, ?, ?, 'brain')");
    decision.run("own-live", OWNER, "PRISM", "Prism", "momentum strengthened");
    decision.run("own-paper", OWNER, "FROG", "Frog", "paper liquidity improved");
    decision.run("foreign", OTHER, "FOREIGN", "Foreign", "foreign private reason");
    decision.run("old-run", OWNER, "OLD_RUN", "Old run", "old run private reason");
    decision.run("pending", OWNER, "PENDING", "Pending", "pending proposal reason");
    decision.run("refused", OWNER, "REFUSED", "Refused", "refused proposal reason");
    decision.run("yesterday", OWNER, "YESTERDAY", "Yesterday", "yesterday reason");
    const fill = db.prepare(`INSERT INTO trades
      (id, agent_id, epoch, kind, target, buy_token, sell_token, amount_usdg,
       user_op_hash, tx_hash, status, reject_rule, created_at, decision_id,
       fill_side, fill_symbol, fill_cash_usdg, fill_qty_raw, basis_source)
      VALUES (?, ?, ?, 'curve-trade', 'curve', 'coin', 'cash', 9999, ?, ?, ?, NULL, ?, ?, 'buy', ?, ?, '100', ?)`);
    fill.run(1, OWNER, 3, "op1", "tx1", "landed", DAY + 10, "own-live", "PRISM", 5, "receipt");
    fill.run(2, OWNER, 3, null, null, "paper", DAY + 20, "own-paper", "FROG", 7, "paper");
    fill.run(3, OTHER, 3, "op3", "tx3", "landed", DAY + 30, "foreign", "FOREIGN", 300, "receipt");
    fill.run(4, OWNER, 2, "op4", "tx4", "landed", DAY + 40, "old-run", "OLD_RUN", 400, "receipt");
    fill.run(5, OWNER, 3, "op5", null, "submitted", DAY + 50, "pending", "PENDING", 500, "quote");
    fill.run(6, OWNER, 3, null, null, "rejected", DAY + 60, "refused", "REFUSED", 600, "quote");
    fill.run(7, OWNER, 3, "op7", "tx7", "landed", DAY - 10, "yesterday", "YESTERDAY", 700, "receipt");
    // Reconciliation re-recorded yesterday's operation today. It must remain
    // yesterday's operation when the actual route resolves the day's history.
    db.prepare(`INSERT INTO trades
      (id,agent_id,epoch,kind,target,buy_token,sell_token,amount_usdg,user_op_hash,
       status,created_at,decision_id,fill_side,fill_symbol,fill_cash_usdg,basis_source)
      VALUES (8,?,3,'swap',?,'coin','cash',9999,'op7','landed',?,NULL,NULL,NULL,NULL,NULL)`)
      .run(OWNER, OWNER, DAY + 70);
  } finally { db.close(); }
});

after(() => {
  mock.restoreAll();
  for (const key of envKeys) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

async function ask(message: string, stream = false): Promise<{ response: Response; body: { reply?: unknown; command?: unknown; why?: unknown } }> {
  const response = await POST(new Request("http://localhost:3100/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", ...(stream ? { accept: "text/event-stream" } : {}) },
    body: JSON.stringify({
      message,
      expectedTenant: OTHER,
      state: { smartAccount: OTHER, name: "Forged agent", moves: [{ symbol: "FAKE_BROWSER_TRADE", sizeUsdg: 123456, reason: "forged browser reason", outcome: "landed" }] },
    }),
  }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /application\/json/);
  return { response, body: await response.json() };
}

test("POST reads the disk agent's current-run completed fills, ignoring forged browser state", async () => {
  const { body } = await ask("what did you trade today?");
  assert.equal(typeof body.reply, "string");
  const reply = body.reply as string;
  assert.match(reply, /since 00:00 UTC/);
  assert.match(reply, /bought PRISM for 5 USDG/);
  assert.match(reply, /Paper: bought FROG for 7 USDG/);
  assert.doesNotMatch(reply, /FAKE_BROWSER_TRADE|forged|FOREIGN|OLD_RUN|PENDING|REFUSED|YESTERDAY|9999|123456|trade #(?:3|4|5|6|7|8)\b/);
  assert.equal(body.command, undefined);
  assert.equal(fetches, 0, "no model or external service is needed for ledger facts");
});

test("POST why uses the exact own fill's recorded decision reason", async () => {
  const { body } = await ask("why trade #1?");
  assert.match(body.reply as string, /trade #1/);
  assert.match(body.reply as string, /Recorded reason: momentum strengthened/);
  assert.doesNotMatch(body.reply as string, /paper liquidity improved|foreign private reason|old run private reason|forged browser reason|trade #(?:2|3|4|5|6|7|8)\b/);
  assert.equal(body.command, undefined);
  assert.equal(fetches, 0);
});

test("POST requested as SSE still returns factual JSON without reaching a model", async () => {
  const normal = await ask("what did you trade today?");
  const streamed = await ask("what did you trade today?", true);
  assert.equal(streamed.body.reply, normal.body.reply);
  assert.equal(streamed.body.command, undefined);
  assert.equal(fetches, 0);
});
