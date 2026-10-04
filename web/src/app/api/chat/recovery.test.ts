/** Actual authenticated route and read-only SQLite recovery report, with only the model transport stubbed. */
import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, mock, test } from "node:test";
import type { StoredGrant } from "@merrymen/core";
import { getGrantStore, resetGrantStoreForTest } from "@merrymen/grant-store";
import { mintSession, SESSION_COOKIE } from "@/lib/auth";
import { FLEET_RECOVERY_SCHEMA } from "../../../../../worker/src/fleet-recovery";
import { POST } from "./route";

const TENANT_A = `0x${"a".repeat(40)}` as `0x${string}`;
const TENANT_B = `0x${"b".repeat(40)}` as `0x${string}`;
const ACCOUNT_A = `0x${"c".repeat(40)}`;
const ACCOUNT_B = `0x${"d".repeat(40)}`;
const NOW = Date.parse("2026-10-04T12:00:00Z") / 1000;
const home = mkdtempSync(path.join(os.tmpdir(), "merrymen-chat-recovery-"));
const keys = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_LLM_PROVIDER",
  "MERRYMEN_LLM_API_KEY", "MERRYMEN_LLM_PROVIDER_MODEL", "ANTHROPIC_API_KEY", "GROQ_API_KEY"] as const;
const saved = new Map(keys.map(key => [key, process.env[key]]));
let db: DatabaseSync;
let seen: { system: string; prompt: string }[] = [];
let grantReads: string[] = [];

before(() => {
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_SESSION_SECRET = "test-chat-recovery-session-secret-32-characters";
  delete process.env.DATABASE_URL;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.MERRYMEN_LLM_PROVIDER = "groq";
  process.env.MERRYMEN_LLM_API_KEY = "test-recovery-model-key";
  process.env.GROQ_API_KEY = "test-recovery-model-key";
  process.env.MERRYMEN_LLM_PROVIDER_MODEL = "test-model";
  resetGrantStoreForTest();
  mock.method(Date, "now", () => NOW * 1000);
  mock.method(getGrantStore(), "get", async (tenant: string) => {
    grantReads.push(tenant);
    // The browser's declared account and agents.owner_address are never consulted.
    return { smartAccount: tenant === TENANT_A ? ACCOUNT_A : ACCOUNT_B, chainId: 4663 } as StoredGrant;
  });
  mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    assert.match(String(input), /chat\/completions$/);
    const request = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    seen.push({ system: request.messages.find(m => m.role === "system")!.content,
      prompt: request.messages.find(m => m.role === "user")!.content });
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "I can explain the records." } }] }),
      { status: 200, headers: { "content-type": "application/json" } });
  });
  db = new DatabaseSync(path.join(home, "merrymen.db"));
  db.exec(`${FLEET_RECOVERY_SCHEMA}
    CREATE TABLE trades (id INTEGER PRIMARY KEY, agent_id TEXT, epoch INTEGER, kind TEXT, target TEXT,
      buy_token TEXT, sell_token TEXT, amount_usdg REAL, user_op_hash TEXT, tx_hash TEXT, status TEXT,
      reject_rule TEXT, created_at INTEGER, decision_id TEXT, fill_side TEXT, fill_symbol TEXT,
      fill_cash_usdg REAL, fill_qty_raw TEXT, basis_source TEXT, realized_pnl_usdg REAL);
    CREATE TABLE decisions (id TEXT PRIMARY KEY, agent_id TEXT, symbol TEXT, display_name TEXT, reason TEXT, source TEXT);
    CREATE TABLE posts (agent_id TEXT);
    CREATE TABLE flows (agent_id TEXT);
    CREATE TABLE agents (smart_account TEXT PRIMARY KEY, owner_address TEXT, status TEXT, energy TEXT, epoch INTEGER);`);
  db.prepare("INSERT INTO fleet_recovery_health VALUES (?,?,4663,1,'persistent-source',?,?)").run(TENANT_A, ACCOUNT_A, NOW - 10, NOW);
  db.prepare("INSERT INTO posts VALUES (?)").run(ACCOUNT_A);
  const energy = { v: 1, gated: true, mode: "enforce", level: "low", agentTokens: 0, holderTokens: 0, needTokens: 100000,
    day: "2026-10-04", resetsAt: NOW + 3600, at: NOW, reviews: { used: 3, allowed: 3 }, entries: { used: 2, allowed: 2 },
    spent: true, buy: "resign", estimateUsdg: 25 };
  db.prepare("INSERT INTO agents VALUES (?,?, 'armed',?,1)").run(ACCOUNT_A, TENANT_B, JSON.stringify(energy));
  db.prepare("INSERT INTO agents VALUES (?,?, 'armed',NULL,1)").run(ACCOUNT_B, TENANT_B);
  const decision = db.prepare("INSERT INTO decisions VALUES (?,?,?,NULL,?,'brain')");
  decision.run("own-decision", ACCOUNT_A, "EXAMPLE", "own recorded reason");
  decision.run("foreign-decision", ACCOUNT_B, "FOREIGN", "foreign private reason");
  const trade = db.prepare(`INSERT INTO trades (id,agent_id,epoch,kind,target,buy_token,sell_token,amount_usdg,
    user_op_hash,tx_hash,status,created_at,decision_id,fill_side,fill_symbol,fill_cash_usdg,basis_source)
    VALUES (?,?,1,'curve-trade','curve','coin','cash',5,?,?,'landed',?,?,'buy',?,5,'receipt')`);
  trade.run(201, ACCOUNT_A, "own-op", "own-tx", NOW - 5, "own-decision", "EXAMPLE");
  trade.run(202, ACCOUNT_B, "foreign-op", "foreign-tx", NOW - 4, "foreign-decision", "FOREIGN");
});
after(() => {
  db?.close();
  mock.restoreAll();
  resetGrantStoreForTest();
  for (const key of keys) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

async function ask(tenant: `0x${string}`, expected = tenant, message = "why are you quiet after I renewed?") {
  return POST(new Request("https://app.merrymen.dev/api/chat", { method: "POST",
    headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${mintSession(tenant)}` },
    body: JSON.stringify({ expectedTenant: expected, message,
      state: JSON.stringify({ smartAccount: ACCOUNT_A, chainId: 1, name: "Example Robin", workerStatus: "LIVE",
        liveTradingEnabled: true, liveBlocker: "dead-policy", stopped: false, equity: 120, cashUsd: 95,
        positions: [{ symbol: "EXAMPLE", valueUsd: 25 }], recovery: { tradingPaused: false, state: "ready" } }) }) }));
}

test("POST uses the cookie tenant and its current grant's exact chain/account hold, overriding client and stale worker claims", async () => {
  const response = await ask(TENANT_A);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { reply: string }).reply, "I can explain the records.");
  assert.equal(grantReads.at(-1), TENANT_A);
  const request = seen.at(-1)!;
  assert.match(request.prompt, /RECOVERY \(authenticated server report — authoritative\)/);
  assert.doesNotMatch(request.prompt, /ENERGY \(|"state":"ready"/);
  const state = JSON.parse(request.prompt.split("STATE:\n")[1]!.split("\n\n")[0]!);
  assert.equal(state.workerStatus, "Trading paused for recovery");
  assert.equal(state.liveTradingEnabled, null);
  assert.equal(state.liveBlocker, null);
  assert.equal(state.equity, null);
  assert.equal(state.lastRecorded.equity, 120);
  assert.equal(state.recovery.history, "available");
  assert.equal(state.recovery.memory, "unknown");
});

test("another authenticated tenant cannot inherit a hold by naming its account in browser state", async () => {
  const response = await ask(TENANT_B);
  assert.equal(response.status, 200);
  assert.equal(grantReads.at(-1), TENANT_B);
  const request = seen.at(-1)!;
  assert.doesNotMatch(request.prompt, /RECOVERY \(/);
  assert.doesNotMatch(request.system, /AUTHENTICATED RECOVERY OVERRIDES/);
});

test("a changed session is refused before recovery, ledger or model reads", async () => {
  const beforeReads = grantReads.length, beforeModels = seen.length;
  const response = await ask(TENANT_B, TENANT_A);
  assert.equal(response.status, 409);
  assert.equal(grantReads.length, beforeReads);
  assert.equal(seen.length, beforeModels);
});

test("held factual replies qualify only the authenticated account's history and never disclose another tenant's decision", async () => {
  const beforeModels = seen.length;
  const ownResponse = await ask(TENANT_A, TENANT_A, "why trade #201?");
  assert.equal(ownResponse.status, 200);
  const own = await ownResponse.json() as { reply: string; command?: unknown };
  assert.match(own.reply, /trading is paused for recovery/);
  assert.match(own.reply, /saved records may be incomplete and do not confirm the current portfolio/);
  assert.match(own.reply, /Recorded reason: own recorded reason/);
  assert.doesNotMatch(own.reply, /FOREIGN|foreign private reason/);
  assert.equal(own.command, undefined);
  const foreignResponse = await ask(TENANT_A, TENANT_A, "why trade #202?");
  const foreign = await foreignResponse.json() as { reply: string; command?: unknown };
  assert.match(foreign.reply, /trading is paused for recovery/);
  assert.doesNotMatch(foreign.reply, /FOREIGN|foreign private reason|own recorded reason/);
  assert.equal(foreign.command, undefined);
  assert.equal(seen.length, beforeModels, "fact qualification remains deterministic and read-only");
});

test("unreadable recovery health fails without a normal-running narration; missing health stays compatible", async () => {
  db.prepare("UPDATE fleet_recovery_health SET held=7 WHERE tenant=?").run(TENANT_A);
  const beforeModels = seen.length;
  const refused = await ask(TENANT_A);
  assert.equal(refused.status, 503);
  assert.equal((await refused.json() as { why: string }).why, "recovery-unavailable");
  assert.equal(seen.length, beforeModels);
  db.exec("DROP TABLE fleet_recovery_health");
  const oldServer = await ask(TENANT_A);
  assert.equal(oldServer.status, 200);
  assert.doesNotMatch(seen.at(-1)!.prompt, /RECOVERY \(/);
});

test("a hosted grant without an available ledger driver cannot fall back to stale live narration", async () => {
  const database = path.join(home, "merrymen.db"), heldAside = path.join(home, "unavailable-test.db");
  renameSync(database, heldAside);
  try {
    const beforeModels = seen.length;
    const response = await ask(TENANT_A);
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { why: string }).why, "recovery-unavailable");
    assert.equal(seen.length, beforeModels);
  } finally { renameSync(heldAside, database); }
});
