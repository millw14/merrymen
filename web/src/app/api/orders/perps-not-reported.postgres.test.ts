/**
 * REAL POSTGRES: HOSTED, NO PERPS OWNER COMMAND IS QUEUED BEFORE THE PERPS
 * WORKER HAS REPORTED ITS BOOK. Opt-in, like
 * worker/src/pg-upgrade.postgres.test.ts (see its header):
 *
 *   MERRYMEN_TEST_PG_URL=postgres://merrymen@localhost:55432/merrymen_pgtest \
 *     npx tsx --test web/src/app/api/orders/perps-not-reported.postgres.test.ts
 *
 * Skipped without it. A LOCAL Postgres only, in a schema of its own, dropped
 * after.
 *
 * WHY. An agent_commands row is ledger history (ledger-import.ts
 * sharedLedgerHistory), and the orchestrator starts a Perps worker for the
 * first time only on an account with none (registerLedgerSource's new-book
 * branch). A Close, a Close all or a practice reset queued for a Perps wallet
 * before that first start therefore refused the start on every pass after,
 * told the owner nothing (reportFleetSource records no hold for a Perps
 * worker), and nothing ever removed the row. Driven here through the real
 * POSTs with a real session, the real grant store and the real ledger:
 *   - before the Perps account's agents row exists: each of the three is
 *     refused 409, no row is written, and the account still has no history a
 *     first start would refuse on;
 *   - the Spot wallet is not asked: its order and its reset are queued as
 *     they always were;
 *   - once the agents row is there (itself the history): queued as before;
 *   - an agents read that fails is a 503, never a queued command.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type { StoredGrant } from "@merrymen/core";
import { getGrantStore, resetGrantStoreForTest } from "@merrymen/grant-store";
import { resetSettingsStoreForTest, useSettingsStoreForTest } from "@merrymen/settings-store";
import { mintSession } from "@/lib/auth";
import { PERPS_EXIT_NOT_REPORTED, PERPS_RESET_NOT_REPORTED } from "@/lib/perps-book-reported";
import { makePgDb } from "../../../../../worker/src/db";
import { sharedLedgerHistory } from "../../../../../worker/src/ledger-import";
import { MIRROR_STATE_DDL } from "../../../../../worker/src/ledger-mirror";
import { ensurePaperCheckpointSchema } from "../../../../../worker/src/paper-checkpoint";
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
/** With letters in it, so the agents row below can be spelled in another case from the one the routes are given. */
const PERPS = `0x${"2b".repeat(20)}`;
/** The Perps worker's key, as the orchestrator names its tenant (workerKey). */
const PERPS_TENANT = `${TENANT}:perps`;
const CLOSE = { purpose: "close-perp", side: "sell", symbol: "BTC-PERP", usdgAmount: 0, book: "paper" } as const;
const FLATTEN = { purpose: "flatten-perps", side: "sell", symbol: "ALL-PERPS", usdgAmount: 0 } as const;
const BUY = { side: "buy", symbol: "TSLA", usdgAmount: 5 } as const;

describe("hosted, a Perps owner command and a Perps book that has not reported", { skip: !url }, () => {
  let home = "";
  let admin: PgClient;
  let schema = "";
  let orders: typeof import("./route");
  let resets: typeof import("../paper-reset/route");
  let cookie = "";
  let shared: Awaited<ReturnType<typeof makePgDb>>;

  before(async () => {
    home = mkdtempSync(path.join(tmpdir(), "mm-perps-not-reported-pg-"));
    process.env.MERRYMEN_HOME = home;
    process.env.MERRYMEN_HOSTED = "1";
    process.env.MERRYMEN_PERPS = "paper";
    process.env.MERRYMEN_SESSION_SECRET = "a".repeat(64);
    process.env.MERRYMEN_SETTINGS_FILE = path.join(home, "settings.json");
    delete process.env.DATABASE_URL;
    delete process.env.MERRYMEN_TICK_SECONDS;
    resetSettingsStoreForTest();
    resetGrantStoreForTest();
    // File-backed grants, chosen before DATABASE_URL names the ledger; one owner key for both wallets.
    const grant = (smartAccount: string, extra: object = {}) =>
      ({ smartAccount, chainId: 4663, serialized: "x", demoSessionPrivateKey: `0x${"11".repeat(32)}`, owner: TENANT, ...extra }) as unknown as StoredGrant;
    await getGrantStore("spot").put(TENANT, grant(SPOT));
    await getGrantStore("perps").put(TENANT, grant(PERPS, { purpose: "perps" }));
    // A settings store that answers nothing: the order window and ceiling are the house's.
    for (const wallet of ["spot", "perps"] as const) {
      useSettingsStoreForTest({ get: async () => null, put: async () => { throw new Error("not written here"); } } as never, wallet);
    }

    schema = `perps_unreported_${randomBytes(6).toString("hex")}`;
    admin = new pg!.Client({ connectionString: url! });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url!);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    shared = await makePgDb(scoped.toString());
    await applyLedgerSchema(shared);
    // The mirror's cursors and the paper checkpoints, which sharedLedgerHistory reads beside the book.
    await shared.exec(MIRROR_STATE_DDL);
    await ensurePaperCheckpointSchema(shared);
    process.env.DATABASE_URL = scoped.toString();
    orders = await import("./route");
    resets = await import("../paper-reset/route");
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

  beforeEach(async () => {
    await admin.query(`DELETE FROM ${schema}.agent_commands`);
    await admin.query(`DELETE FROM ${schema}.agents`);
  });

  type Answer = { status: number; body: { id?: string; queued?: boolean; error?: string } };
  const order = async (query: string, body: object): Promise<Answer> => {
    const res = await orders.POST(new Request(`https://app.example.test/api/orders${query}`, {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ ...body, owner: TENANT }),
    }));
    return { status: res.status, body: (await res.json()) as Answer["body"] };
  };
  const exit = (body: object) => order("?wallet=perps", { ...body, expectedAccount: PERPS });
  const reset = async (query: string): Promise<Answer> => {
    const res = await resets.POST(new Request(`https://app.example.test/api/paper-reset${query}`, { method: "POST", headers: { cookie } }));
    return { status: res.status, body: (await res.json()) as Answer["body"] };
  };
  const rows = async () =>
    (await admin.query(`SELECT LOWER(agent_id) AS agent, kind FROM ${schema}.agent_commands ORDER BY created_at, id`)).rows as { agent: string; kind: string }[];
  const reported = (account: string) =>
    admin.query(
      `INSERT INTO ${schema}.agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at) VALUES ($1, $2, $2, 4663, '{}', 0, 0)`,
      [account, TENANT],
    );

  it("BEFORE THE PERPS WORKER HAS REPORTED: a Close, a Close all and a practice reset are each refused 409, no row is written, and the account has no history its first start would refuse on", async () => {
    const asks: [string, () => Promise<Answer>, string][] = [
      ["close", () => exit(CLOSE), PERPS_EXIT_NOT_REPORTED],
      ["close all", () => exit(FLATTEN), PERPS_EXIT_NOT_REPORTED],
      ["reset", () => reset("?wallet=perps"), PERPS_RESET_NOT_REPORTED],
    ];
    for (const [what, ask, sentence] of asks) {
      const out = await ask();
      assert.equal(out.status, 409, `${what}: ${JSON.stringify(out.body)}`);
      assert.equal(out.body.error, sentence, what);
    }
    assert.deepEqual(await rows(), []);
    assert.equal(await sharedLedgerHistory(shared, PERPS_TENANT, PERPS), null, "registerLedgerSource's new-book branch still finds nothing to refuse on");
  });

  it("THE SPOT WALLET IS NOT ASKED: its order and its reset are queued as they always were, with no agents row anywhere", async () => {
    const buy = await order("", BUY);
    assert.equal(buy.status, 200, JSON.stringify(buy.body));
    const spotReset = await reset("");
    assert.equal(spotReset.status, 200, JSON.stringify(spotReset.body));
    assert.deepEqual((await rows()).map((r) => r.agent), [SPOT, SPOT]);
  });

  it("ONCE ITS agents ROW IS THERE — itself the history a first start refuses on — the exit and the reset are queued as before, on the Perps account", async () => {
    // Spelled in another case from the account the routes are given (the
    // worker's own spelling is viem's checksummed one, another case again):
    // the look is by the account, never its case.
    await reported(`0x${PERPS.slice(2).toUpperCase()}`);
    assert.equal(await sharedLedgerHistory(shared, PERPS_TENANT, PERPS), "agents", "set-up: the row a command would add to is already there");
    const close = await exit(CLOSE);
    assert.equal(close.status, 200, JSON.stringify(close.body));
    const again = await reset("?wallet=perps");
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(await rows(), [{ agent: PERPS, kind: "trade" }, { agent: PERPS, kind: "paper-reset" }]);
  });

  it("AN agents READ THAT FAILS IS A 503 for the exit and the reset alike: never a queued command", async () => {
    await admin.query(`ALTER TABLE ${schema}.agents RENAME TO agents_away`);
    try {
      for (const [what, out] of [["close all", await exit(FLATTEN)], ["reset", await reset("?wallet=perps")]] as const) {
        assert.equal(out.status, 503, `${what}: ${JSON.stringify(out.body)}`);
        assert.match(out.body.error ?? "", /couldn't queue it/, what);
      }
    } finally {
      await admin.query(`ALTER TABLE ${schema}.agents_away RENAME TO agents`);
    }
    assert.deepEqual(await rows(), []);
  });
});
