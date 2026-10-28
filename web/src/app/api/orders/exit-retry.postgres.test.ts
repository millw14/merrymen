/**
 * REAL POSTGRES: AN OWNER'S EXIT ASKED AGAIN IN THE SAME MINUTE, HOSTED, IS A
 * SECOND ROW THE FERRY DELIVERS — never "already queued" with nothing queued.
 * Opt-in, like worker/src/pg-upgrade.postgres.test.ts (see its header):
 *
 *   MERRYMEN_TEST_PG_URL=postgres://merrymen@localhost:55432/merrymen_pgtest \
 *     npx tsx --test web/src/app/api/orders/exit-retry.postgres.test.ts
 *
 * Skipped without it. A LOCAL Postgres only, in a schema of its own, dropped
 * after.
 *
 * WHY. Hosted, an order is a row in agent_commands keyed on its id, and an
 * insert that hits that key is answered 200 `duplicate` with no row added
 * (order-state.ts placeHostedOrder). The minute-bucket id made every exit in
 * one minute the same key (its fields never vary), so a Close all asked again
 * after a first one came back "1 practice position remains open" collided with
 * the ANSWERED row: nothing was inserted, the ferry had nothing to deliver, and
 * GET for the id returned the first attempt's failure as the second's result.
 * Driven through the real POST and GET with a real session, the real grant
 * store and the real ledger over Postgres (placeRecoveryCheckedOrder, under the
 * account's recovery lock); the ferry's claim and the child's answer are the
 * UPDATE the orchestrator makes when it lands a result.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { StoredGrant } from "@merrymen/core";
import { getGrantStore, resetGrantStoreForTest } from "@merrymen/grant-store";
import { resetSettingsStoreForTest } from "@merrymen/settings-store";
import { mintSession } from "@/lib/auth";
import { makePgDb } from "../../../../../worker/src/db";
import { applyLedgerSchema } from "../../../../../worker/src/store";

const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;
interface PgClient {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}
// LOADED ONLY WHEN A DATABASE IS NAMED: `pg` is not a dependency (see
// worker/src/pg-upgrade.postgres.test.ts), so CI and a plain `npm test` skip cleanly.
const pg = (url ? createRequire(import.meta.url)("pg") : null) as { Client: new (c: { connectionString: string }) => PgClient } | null;

const KEYS = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SETTINGS_FILE", "DATABASE_URL", "MERRYMEN_SESSION_SECRET", "MERRYMEN_PERPS", "MERRYMEN_TICK_SECONDS"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const TENANT = `0x${"aa".repeat(20)}` as const;
const PERPS = `0x${"22".repeat(20)}`;
const CLOSE_ALL = { purpose: "flatten-perps", side: "sell", symbol: "ALL-PERPS", usdgAmount: 0, book: "paper", expectedAccount: PERPS };
const FIRST_ANSWER = "1 practice position remains open after the close attempts, with its stop. New practice positions are paused until you reset the practice book.";

describe("hosted, a Close all asked again in the same minute after its answer", { skip: !url }, () => {
  let home = "";
  let admin: PgClient;
  let schema = "";
  let route: typeof import("./route");
  let cookie = "";

  before(async () => {
    home = mkdtempSync(path.join(tmpdir(), "mm-exit-retry-pg-"));
    process.env.MERRYMEN_HOME = home;
    process.env.MERRYMEN_HOSTED = "1";
    process.env.MERRYMEN_PERPS = "paper";
    process.env.MERRYMEN_SESSION_SECRET = "a".repeat(64);
    process.env.MERRYMEN_SETTINGS_FILE = path.join(home, "settings.json");
    delete process.env.DATABASE_URL;
    delete process.env.MERRYMEN_TICK_SECONDS;
    resetSettingsStoreForTest();
    resetGrantStoreForTest();
    // The grant store is chosen (and cached) here, before DATABASE_URL names
    // the ledger: file-backed, so this test needs no store key.
    await getGrantStore("perps").put(TENANT, {
      smartAccount: PERPS, chainId: 4663, serialized: "x", demoSessionPrivateKey: `0x${"11".repeat(32)}`, purpose: "perps", owner: TENANT,
    } as unknown as StoredGrant);

    schema = `exit_retry_${randomBytes(6).toString("hex")}`;
    admin = new pg!.Client({ connectionString: url! });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url!);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    await applyLedgerSchema(await makePgDb(scoped.toString()));
    process.env.DATABASE_URL = scoped.toString();
    route = await import("./route");
    cookie = `mm_session=${mintSession(TENANT)}`;
  });

  after(async () => {
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const post = () =>
    route.POST(new Request("https://app.example.test/api/orders?wallet=perps", {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(CLOSE_ALL),
    }));
  const look = async (id: string) =>
    (await (await route.GET(new Request(`https://app.example.test/api/orders?wallet=perps&id=${id}`, { headers: { cookie } }))).json()) as {
      state: string; result: string | null; ok: boolean | null;
    };
  const rows = async () =>
    (await admin.query(`SELECT id, claimed_at IS NOT NULL AS claimed, done_at IS NOT NULL AS done FROM ${schema}.agent_commands ORDER BY created_at, id`)).rows;

  it("is a second row, delivered and followed as its own — and a third ask while it is open is refused", async (t) => {
    // Held still, so both asks are certainly in one clock minute: the case the
    // minute-bucket id got wrong.
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const first = await post();
    assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
    const firstId = ((await first.json()) as { id: string }).id;
    // The ferry claims the row, and the child's answer is landed on it.
    const at = Date.now();
    await admin.query(`UPDATE ${schema}.agent_commands SET claimed_at = $1, done_at = $2, result = $3 WHERE id = $4`,
      [at, at + 1, JSON.stringify({ ok: false, line: FIRST_ANSWER }), firstId]);
    assert.equal((await look(firstId)).state, "done");

    const again = await post();
    assert.equal(again.status, 200);
    const body = (await again.json()) as { id: string; duplicate?: true };
    assert.notEqual(body.id, firstId, "a second ask is a second exit");
    assert.equal(body.duplicate, undefined, "never 'already queued' off the answered row");
    const now = await rows();
    assert.equal(now.length, 2, JSON.stringify(now));
    const waiting = (await admin.query(`SELECT id FROM ${schema}.agent_commands WHERE kind = 'trade' AND claimed_at IS NULL`)).rows;
    assert.deepEqual(waiting.map((r) => r.id), [body.id], "the ferry has the retry to deliver");
    assert.equal((await look(body.id)).state, "queued", "GET follows the retry, not the first answer");
    assert.equal((await look(firstId)).result, FIRST_ANSWER, "and the first attempt keeps its own");

    // One click is still one exit: the retry holds the Perps wallet's slot.
    assert.equal((await post()).status, 409);
    assert.equal((await rows()).length, 2);
  });
});
