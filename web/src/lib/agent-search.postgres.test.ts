/**
 * REAL POSTGRES: PUBLIC SEARCH'S WINDOW WITH THE HOSTED FLEET'S PERPS ROWS.
 * Opt-in, like the other web Postgres suites:
 *
 *   MERRYMEN_TEST_PG_URL=postgres://postgres@127.0.0.1:54329/merrymen_pgtest \
 *     npx tsx --test web/src/lib/agent-search.postgres.test.ts
 *
 * Skipped without it. A LOCAL Postgres only, in a schema of its own, dropped
 * after. Hosted, every Perps worker's `agents` row is in the shared ledger,
 * so this is where a window's worth of them would push a Spot agent out of
 * search (agent-search.test.ts says why).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { makePgDb } from "../../../worker/src/db";
import { recordPerpsWallet } from "../../../worker/src/perps-wallets";
import { applyLedgerSchema } from "../../../worker/src/store";
import { AGENT_SEARCH_WINDOW, readAgentSearchWindow } from "./agent-search";

const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;
interface PgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}
// LOADED ONLY WHEN A DATABASE IS NAMED: `pg` is not a dependency, so CI and a
// plain `npm test` skip cleanly.
const pg = (url ? createRequire(import.meta.url)("pg") : null) as { Client: new (c: { connectionString: string }) => PgClient } | null;

const NOW = 2_000_000_000;
const account = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;

test("Postgres: no Perps wallet takes a place in public search's window", { skip: !url, timeout: 60_000 }, async (t) => {
  const target = new URL(url!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "only a disposable LOCAL Postgres is allowed");
  const schema = `mm_agent_search_${randomBytes(6).toString("hex")}`;
  const admin = new pg!.Client({ connectionString: target.toString() });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    const scoped = new URL(target);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    const db = await makePgDb(scoped.toString());
    await applyLedgerSchema(db);
    const insert = (smartAccount: string, createdAt: number, name: string, mode: string) =>
      db
        .prepare(
          `INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, created_at, name, mode)
           VALUES (?, 'owner', 'key', 4663, '{}', 1, 2, ?, ?, ?)`,
        )
        .run(smartAccount, createdAt, name, mode);
    await insert(account(1), NOW - 10_000, "Shogun", "live");

    await t.test("before any Perps wallet: the table is absent and nothing reads it", async () => {
      assert.deepEqual((await readAgentSearchWindow(db)).map((r) => r.name), ["Shogun"]);
    });

    await t.test("a window's worth of newer Perps rows: the older Spot agent is still in it", async () => {
      for (let i = 0; i < AGENT_SEARCH_WINDOW; i++) {
        const a = account(1_000 + i);
        await insert(i % 2 ? `0x${a.slice(2).toUpperCase()}` : a, NOW - i, `Perps ${i}`, "paper");
        await recordPerpsWallet(db, { smartAccount: a, owner: account(9), chainId: 4663, nowSec: NOW });
      }
      assert.deepEqual((await readAgentSearchWindow(db)).map((r) => r.name), ["Shogun"]);
    });
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
});
