/**
 * REAL POSTGRES: HOSTED, ONE LOGIN'S TWO WALLETS SHARE ONE ORDER TABLE, AND A
 * `?wallet=perps` REQUEST WRITES AND READS ONLY THE PERPS ACCOUNT'S ROWS.
 * Opt-in, like worker/src/pg-upgrade.postgres.test.ts (see its header):
 *
 *   MERRYMEN_TEST_PG_URL=postgres://merrymen@localhost:55432/merrymen_pgtest \
 *     npx tsx --test web/src/app/api/orders/hosted-wallets.postgres.test.ts
 *
 * Skipped without it. A LOCAL Postgres only, in a schema of its own, dropped
 * after.
 *
 * WHY. Hosted is production, and there both wallets' orders are rows in the
 * one agent_commands table, told apart by nothing but the agent_id the route
 * resolved (hostedAgentFor(req, wallet)). The self-hosted tests
 * (dual-purpose.test.ts) give each wallet a home of its own, so a route that
 * resolved the Spot account for `?wallet=perps` hosted passed every one of
 * them. Driven here through the real POST and GET with a real session, the
 * real grant store and the real ledger over Postgres:
 *   - a Perps exit is a row bound to the Perps account, carrying the exit and
 *     its deadline and never the account it was reviewed for;
 *   - its deadline is the Perps worker's order window, from the Perps
 *     wallet's own settings, never Spot's;
 *   - each wallet's one-at-a-time slot is held only by its own rows;
 *   - each GET, latest or by id, answers only its own wallet's rows.
 * The Perps ceiling is not asserted: an exit carries no amount (owner-order.ts
 * readPerpExitOrder), so no ceiling, the Perps one or the Spot one, can
 * refuse one, and nothing a test could observe depends on which is read.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { MerrymenSettings, StoredGrant } from "@merrymen/core";
import { getGrantStore, resetGrantStoreForTest } from "@merrymen/grant-store";
import { resetSettingsStoreForTest, useSettingsStoreForTest } from "@merrymen/settings-store";
import { mintSession } from "@/lib/auth";
import { orderTtlMs } from "@/lib/order-state";
import { makePgDb } from "../../../../../worker/src/db";
import { recordFleetRecoveryHold } from "../../../../../worker/src/fleet-recovery";
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
const SPOT = `0x${"11".repeat(20)}`;
const PERPS = `0x${"22".repeat(20)}`;
const CLOSE = { purpose: "close-perp", side: "sell", symbol: "BTC-PERP", usdgAmount: 0, book: "paper" } as const;
const FLATTEN = { purpose: "flatten-perps", side: "sell", symbol: "ALL-PERPS", usdgAmount: 0 } as const;
const BUY = { side: "buy", symbol: "TSLA", usdgAmount: 5 } as const;
/** Each wallet's own stored settings: a different tick, so each order window says whose it was read from. */
const STORED: Record<"spot" | "perps", MerrymenSettings> = {
  spot: { tickSeconds: 60, telegramMaxActionUsdg: 71 } as MerrymenSettings,
  perps: { strategy: "perps-only", tickSeconds: 240, telegramMaxActionUsdg: 9 } as MerrymenSettings,
};

describe("hosted, a login's Spot and Perps orders in the one shared table", { skip: !url }, () => {
  let home = "";
  let admin: PgClient;
  let schema = "";
  let route: typeof import("./route");
  let cookie = "";

  before(async () => {
    home = mkdtempSync(path.join(tmpdir(), "mm-hosted-wallets-pg-"));
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
    // the ledger: file-backed, so this test needs no store key. One owner key
    // for both wallets, as the store requires.
    const grant = (smartAccount: string, extra: object = {}) =>
      ({ smartAccount, chainId: 4663, serialized: "x", demoSessionPrivateKey: `0x${"11".repeat(32)}`, owner: TENANT, ...extra }) as unknown as StoredGrant;
    await getGrantStore("spot").put(TENANT, grant(SPOT));
    await getGrantStore("perps").put(TENANT, grant(PERPS, { purpose: "perps" }));
    // Each wallet's settings store answers its own blob, and refuses a write.
    for (const wallet of ["spot", "perps"] as const) {
      useSettingsStoreForTest({
        get: async (tenant: string) => (tenant.toLowerCase() === TENANT ? STORED[wallet] : null),
        put: async () => {
          throw new Error("not written here");
        },
      } as never, wallet);
    }

    schema = `hosted_wallets_${randomBytes(6).toString("hex")}`;
    admin = new pg!.Client({ connectionString: url! });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url!);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    await applyLedgerSchema(await makePgDb(scoped.toString()));
    // The Perps worker has reported its book: its agents row is in the shared
    // database, or no Perps exit or reset is queued (perps-book-reported.ts).
    await admin.query(
      `INSERT INTO ${schema}.agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at) VALUES ($1, $2, $2, 4663, '{}', 0, 0)`,
      [PERPS, TENANT],
    );
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
    resetSettingsStoreForTest();
    resetGrantStoreForTest();
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const post = async (query: string, body: object) => {
    const res = await route.POST(new Request(`https://app.example.test/api/orders${query}`, {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ ...body, owner: TENANT }),
    }));
    return { status: res.status, body: (await res.json()) as { id?: string; expiresInMs?: number; error?: string; code?: string } };
  };
  const look = async (query: string) =>
    (await (await route.GET(new Request(`https://app.example.test/api/orders${query}`, { headers: { cookie } }))).json()) as { id?: string; state: string };
  const row = async (id: string) =>
    (await admin.query(`SELECT agent_id, kind, args, created_at FROM ${schema}.agent_commands WHERE id = $1`, [id])).rows[0] as
      | { agent_id: string; kind: string; args: string; created_at: string | number }
      | undefined;
  const answer = (id: string) =>
    admin.query(`UPDATE ${schema}.agent_commands SET claimed_at = $1, done_at = $2, result = $3 WHERE id = $4`, [Date.now(), Date.now() + 1, JSON.stringify({ ok: true, line: "done" }), id]);

  it("each wallet's order is a row bound to its own account, with its own window, holding only its own slot, read back only by its own GET", async () => {
    // A Perps exit: the Perps account's row, the exit's own fields and its deadline, nothing reviewed or claimed beside them.
    const exit = await post("?wallet=perps", { ...CLOSE, expectedAccount: PERPS, note: "anything else" });
    assert.equal(exit.status, 200, JSON.stringify(exit.body));
    const exitId = exit.body.id!;
    const exitRow = await row(exitId);
    assert.ok(exitRow);
    assert.equal(exitRow.agent_id.toLowerCase(), PERPS, "bound to the Perps account, which is what the ferry joins on");
    assert.equal(exitRow.kind, "trade");
    const exitArgs = JSON.parse(exitRow.args) as Record<string, unknown>;
    const { expiresAt, ...exitFields } = exitArgs;
    assert.deepEqual(exitFields, { ...CLOSE }, "the exit and nothing else: no expectedAccount, no owner, no note");
    // THE PERPS WORKER'S WINDOW, from the Perps wallet's own settings (240 s), never Spot's (60 s: the five-minute floor).
    assert.equal(exit.body.expiresInMs, orderTtlMs(240));
    assert.equal(Number(expiresAt) - Number(exitRow.created_at), orderTtlMs(240));

    // A Spot order beside it: the Perps exit does not hold the Spot slot, and Spot's window is Spot's.
    const buy = await post("", BUY);
    assert.equal(buy.status, 200, JSON.stringify(buy.body));
    const buyId = buy.body.id!;
    assert.equal((await row(buyId))?.agent_id.toLowerCase(), SPOT);
    assert.equal(buy.body.expiresInMs, orderTtlMs(60));

    // Each slot is held by its own open row.
    const secondExit = await post("?wallet=perps", { ...FLATTEN, expectedAccount: PERPS });
    assert.equal(secondExit.status, 409, "the Perps exit holds the Perps slot");
    assert.notEqual(secondExit.body.code, "account-changed");
    assert.equal((await post("", { ...BUY, usdgAmount: 6 })).status, 409, "the Spot order holds the Spot slot");

    // Each GET reads its own account's rows: by latest (the Spot row is the newer one) and by id.
    assert.equal((await look("?wallet=perps")).id, exitId);
    assert.deepEqual(await look(`?wallet=perps&id=${buyId}`), { state: "none" });
    assert.equal((await look("")).id, buyId);
    assert.deepEqual(await look(`?id=${exitId}`), { state: "none" });

    // A Spot order still waiting does not hold back the next Perps exit once the first is answered.
    await answer(exitId);
    const next = await post("?wallet=perps", { ...FLATTEN, expectedAccount: PERPS });
    assert.equal(next.status, 200, JSON.stringify(next.body));
    assert.equal((await row(next.body.id!))?.agent_id.toLowerCase(), PERPS);
    // …and the reverse: the Perps exit now waiting does not hold the Spot slot once Spot's is answered.
    await answer(buyId);
    assert.equal((await post("", { ...BUY, usdgAmount: 7 })).status, 200);
    const counts = (await admin.query(`SELECT LOWER(agent_id) AS a, COUNT(*)::int AS n FROM ${schema}.agent_commands GROUP BY 1 ORDER BY 1`)).rows;
    assert.deepEqual(counts, [{ a: SPOT, n: 2 }, { a: PERPS, n: 2 }]);
  });

  /**
   * THE LOGIN'S FLEET RECOVERY HOLD IS ITS SPOT ACCOUNT'S (D11). The
   * orchestrator records a login's hold for its Spot grant's account only
   * (reportFleetSource returns for a Perps worker before writing), and the
   * check both wallets' orders pass (placeRecoveryCheckedOrder) reads the
   * account the row is bound to. So, through the real POST over Postgres, the
   * held login's Spot buy is refused and its Perps exit is queued — what the
   * route's header and docs/perps.md say, and not the "refuses a Perps exit
   * as it refuses any order" they used to.
   */
  it("held for its Spot account, the login's Spot order is refused 409 and its Perps exit is queued on the Perps account", async () => {
    await admin.query(`UPDATE ${schema}.agent_commands SET claimed_at = $1, done_at = $2, result = $3 WHERE done_at IS NULL`, [Date.now(), Date.now() + 1, JSON.stringify({ ok: true, line: "done" })]);
    const db = await makePgDb(process.env.DATABASE_URL!);
    await recordFleetRecoveryHold(db, { tenant: TENANT, smartAccount: SPOT, chainId: 4663 }, "source-continuity", Math.floor(Date.now() / 1000), () => true);
    const holds = (await admin.query(`SELECT LOWER(smart_account) AS account, held FROM ${schema}.fleet_recovery_health`)).rows;
    assert.deepEqual(holds.map((h) => ({ account: h.account, held: Number(h.held) })), [{ account: SPOT, held: 1 }], "set-up: the hold reportFleetSource records");

    const buy = await post("", { ...BUY, usdgAmount: 8 });
    assert.equal(buy.status, 409, JSON.stringify(buy.body));
    assert.match(buy.body.error ?? "", /No new order was queued/);

    const exit = await post("?wallet=perps", { ...CLOSE, expectedAccount: PERPS });
    assert.equal(exit.status, 200, JSON.stringify(exit.body));
    assert.equal((await row(exit.body.id!))?.agent_id.toLowerCase(), PERPS, "queued, bound to the Perps account the hold does not name");
  });
});
