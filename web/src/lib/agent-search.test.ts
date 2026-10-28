/**
 * PUBLIC SEARCH LOOKS THROUGH THE NEWEST AGENTS THAT COULD EVER BE A HIT.
 * A Perps wallet never is one (D2: no public slug), so its `agents` row takes
 * no place in that window. Dropped only after the LIMIT, a window's worth of
 * newer Perps rows pushed an older Spot agent out of search altogether.
 * agent-search.postgres.test.ts runs the same read on Postgres, where the
 * hosted fleet's rows are.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { wrapSqlite, type Db } from "../../../worker/src/db";
import { recordPerpsWallet } from "../../../worker/src/perps-wallets";
import { applyLedgerSchema } from "../../../worker/src/store";
import { AGENT_SEARCH_WINDOW, readAgentSearchWindow } from "./agent-search";

const NOW = 2_000_000_000;
const account = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;

async function fixture() {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db);
  const insert = raw.prepare(
    `INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, created_at, name, mode)
     VALUES (?, 'owner', 'key', 4663, '{}', 1, 2, ?, ?, ?)`,
  );
  // The Spot agent a visitor looks for, older than everything added after it.
  insert.run(account(1), NOW - 10_000, "Shogun", "live");
  return { raw, db, insert };
}

test("a fleet that never had a Perps wallet: the newest live and paper agents, and no statement against a table it does not have", async () => {
  const f = await fixture();
  try {
    const queries: string[] = [];
    const watched: Pick<Db, "prepare"> = { prepare: (sql) => (queries.push(sql), f.db.prepare(sql)) };
    assert.deepEqual((await readAgentSearchWindow(watched)).map((r) => r.name), ["Shogun"]);
    assert.ok(queries.every((sql) => !/FROM perps_wallets/.test(sql)));
  } finally {
    f.raw.close();
  }
});

test("A WINDOW'S WORTH OF NEWER PERPS WALLETS TAKES NO PLACE IN IT: the older Spot agent is still found", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < AGENT_SEARCH_WINDOW; i++) {
      const a = account(1_000 + i);
      // The record is lowercase; an agents row need not be.
      f.insert.run(i % 2 ? `0x${a.slice(2).toUpperCase()}` : a, NOW - i, `Perps ${i}`, "paper");
      await recordPerpsWallet(f.db, { smartAccount: a, owner: account(9), chainId: 4663, nowSec: NOW });
    }
    f.insert.run(account(2), NOW - 20_000, "Older spot", "paper");
    assert.deepEqual((await readAgentSearchWindow(f.db)).map((r) => r.name), ["Shogun", "Older spot"]);
  } finally {
    f.raw.close();
  }
});

test("a Perps wallets record that cannot be read throws: the route answers no agent hits rather than risk one", async () => {
  const f = await fixture();
  try {
    await recordPerpsWallet(f.db, { smartAccount: account(1_000), owner: account(9), chainId: 4663, nowSec: NOW });
    const denied: Pick<Db, "prepare"> = {
      prepare: (sql) => {
        if (/FROM perps_wallets/.test(sql)) throw new Error("permission denied for table perps_wallets");
        return f.db.prepare(sql);
      },
    };
    await assert.rejects(readAgentSearchWindow(denied), /permission denied/);
  } finally {
    f.raw.close();
  }
});

test("the search route reads its agents through readAgentSearchWindow and runs no agents query of its own", () => {
  const route = readFileSync(path.join(import.meta.dirname, "..", "app", "api", "search", "route.ts"), "utf8");
  assert.match(route, /const rows = await readAgentSearchWindow\(db\);/);
  assert.doesNotMatch(route, /FROM agents/);
});
