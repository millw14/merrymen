/**
 * REAL POSTGRES: HOSTED, A PERPS PRACTICE RESET IS QUEUED ONLY FOR A BOOK A
 * PERPS WORKER CAN REACH. Opt-in, like worker/src/pg-upgrade.postgres.test.ts
 * (see its header):
 *
 *   MERRYMEN_TEST_PG_URL=postgres://merrymen@localhost:55432/merrymen_pgtest \
 *     npx tsx --test web/src/app/api/paper-reset/hosted.postgres.test.ts
 *
 * Skipped without it. A LOCAL Postgres only, in a schema of its own, dropped
 * after.
 *
 * WHY. A Perps practice book that will not restore starts no worker and no
 * hold process (orchestrator.ts spawnChild), and nothing honours a Perps reset
 * while it is held: held-reset.ts is the Spot book's way out, and judges
 * consent by a seven-day window that never reads a Perps reset's deadline. The
 * route answered 200 "queued" all the same, and the row waited, unclaimed, for
 * a worker that could not start. It now reads the hold the orchestrator
 * recorded for the Perps account (paper_recovery_health) and refuses the
 * reset while it says so (start-over.ts queuePaperReset). Driven through the
 * real POST with a real session, the real grant store and the real ledger:
 *   - a held Perps book: 409, no row;
 *   - a clear one, or a deployment with no record table yet: the row, bound to
 *     the Perps account, with its deadline;
 *   - a held Spot book: the Spot reset queued as it always was, because there
 *     it is the owner's way out.
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
import { makePgDb } from "../../../../../worker/src/db";
import { recordPaperRecoveryHealth } from "../../../../../worker/src/paper-checkpoint";
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

describe("hosted, a Perps practice reset and the book the orchestrator holds", { skip: !url }, () => {
  let home = "";
  let admin: PgClient;
  let schema = "";
  let route: typeof import("./route");
  let cookie = "";
  let shared: Awaited<ReturnType<typeof makePgDb>>;

  before(async () => {
    home = mkdtempSync(path.join(tmpdir(), "mm-reset-held-pg-"));
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
    // A settings store that answers nothing: the order window is the house's.
    for (const wallet of ["spot", "perps"] as const) {
      useSettingsStoreForTest({ get: async () => null, put: async () => { throw new Error("not written here"); } } as never, wallet);
    }

    schema = `reset_held_${randomBytes(6).toString("hex")}`;
    admin = new pg!.Client({ connectionString: url! });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url!);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    shared = await makePgDb(scoped.toString());
    await applyLedgerSchema(shared);
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

  beforeEach(async () => {
    await admin.query(`DELETE FROM ${schema}.agent_commands`);
    await admin.query(`DROP TABLE IF EXISTS ${schema}.paper_recovery_health`);
  });

  const reset = async (query: string) => {
    const res = await route.POST(new Request(`https://app.example.test/api/paper-reset${query}`, { method: "POST", headers: { cookie } }));
    return { status: res.status, body: (await res.json()) as { id?: string; queued?: boolean; expiresAt?: number; error?: string } };
  };
  const rows = async () =>
    (await admin.query(`SELECT id, LOWER(agent_id) AS agent, kind, args FROM ${schema}.agent_commands ORDER BY created_at, id`)).rows as {
      id: string; agent: string; kind: string; args: string | null;
    }[];

  it("A HELD PERPS BOOK: 409, and no row for a worker that cannot start", async () => {
    // What tryPaperRestore records when the Perps book will not restore.
    await recordPaperRecoveryHealth(shared, PERPS, true);
    const held = await reset("?wallet=perps");
    assert.equal(held.status, 409, JSON.stringify(held.body));
    assert.match(held.body.error ?? "", /practice book could not be restored, so it is being held .* No practice reset was queued/);
    assert.deepEqual(await rows(), []);
  });

  it("A CLEAR PERPS BOOK, OR NO RECORD TABLE YET: the row, bound to the Perps account, with its deadline", async () => {
    for (const record of ["absent", "clear"] as const) {
      await admin.query(`DELETE FROM ${schema}.agent_commands`);
      if (record === "clear") await recordPaperRecoveryHealth(shared, PERPS, false);
      const ok = await reset("?wallet=perps");
      assert.equal(ok.status, 200, `${record}: ${JSON.stringify(ok.body)}`);
      const [row] = await rows();
      assert.equal(row?.id, ok.body.id, record);
      assert.equal(row?.agent, PERPS, record);
      assert.equal(row?.kind, "paper-reset", record);
      assert.equal((JSON.parse(row?.args ?? "{}") as { expiresAt?: number }).expiresAt, ok.body.expiresAt, record);
    }
  });

  it("A HELD SPOT BOOK IS NOT LOOKED AT: its reset is queued as it always was, the owner's way out (held-reset.ts)", async () => {
    await recordPaperRecoveryHealth(shared, SPOT, true);
    await recordPaperRecoveryHealth(shared, PERPS, false);
    const spot = await reset("");
    assert.equal(spot.status, 200, JSON.stringify(spot.body));
    const [row] = await rows();
    assert.equal(row?.agent, SPOT);
    assert.equal(row?.args, null, "Spot's row is written as it always was, with no args");
    // And the Spot hold is not the Perps book's.
    assert.equal((await reset("?wallet=perps")).status, 200);
  });
});
