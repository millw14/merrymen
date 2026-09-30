/**
 * REAL POSTGRES: THE WEB'S ENERGY AND HOLDER READS, BEFORE AND AFTER THE
 * UPGRADE. Opt-in, like worker/src/pg-upgrade.postgres.test.ts (see its header):
 *
 *   MERRYMEN_TEST_PG_URL=postgres://merrymen@localhost:55432/merrymen_pgtest \
 *     npx tsx --test web/src/lib/energy-holder.postgres.test.ts
 *
 * Skipped without it. A LOCAL Postgres only, in a schema of its own, dropped
 * after.
 *
 * The web deploys beside the orchestrator and serves requests while the
 * orchestrator's first mirror pass has not yet added `agents.energy`. So
 * /api/grants and /api/chat must read "not said yet" (null) from production's
 * schema — never throw, never a zero — and the worker's report once it is
 * there, through the real read seam (createReadDb) and the real claims store
 * (holderWalletFor over PgSettingsStore).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makePgDb } from "../../../worker/src/db";
import { applyLedgerSchema } from "../../../worker/src/store";
import { PgSettingsStore, resetSettingsStoreForTest, useSettingsStoreForTest, type PgClientLike } from "../../../worker/src/settings-store";
import { createReadDb } from "./ledger";
import { readAgentEnergy } from "./agent-energy";
import { holderWalletFor } from "./holder-wallet";

const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;
interface PgClient extends PgClientLike {
  connect(): Promise<void>;
  end(): Promise<void>;
}
// LOADED ONLY WHEN A DATABASE IS NAMED. `pg` is not a dependency — the
// production image installs it at build time (Dockerfile) — so CI and a
// plain `npm test` have no driver. A top-level require failed the whole file
// there instead of skipping it.
const pg = (url ? createRequire(import.meta.url)("pg") : null) as { Client: new (c: { connectionString: string }) => PgClient } | null;
const FIXTURE = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..", "..", "..", "worker", "src", "testdata", "shared-schema-75995697.sql",
);

const T1 = "0x1111111111111111111111111111111111111111" as const;
const T2 = "0x2222222222222222222222222222222222222222" as const;
const W1 = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const A1 = "0xA1a1A1a1a1A1a1a1A1a1a1a1A1a1a1A1A1a1a1a1";
const REPORT = {
  v: 1, gated: true, mode: "enforce", level: "low", agentTokens: 12.5, holderTokens: 40_000, holderCounted: true,
  needTokens: 100_000, day: "2026-09-28", resetsAt: 1_790_640_000, reviews: { used: 2, allowed: 15 },
  entries: { used: 1, allowed: 2 }, spent: false, buy: "ready", estimateUsdg: 3.25, at: 1_790_560_000,
};

test("Postgres: the web's energy and holder reads across the upgrade", { skip: !url, timeout: 60_000 }, async (t) => {
  const target = new URL(url!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "only a disposable LOCAL Postgres is allowed");
  const schema = `mm_web_upgrade_test_${randomBytes(8).toString("hex")}`;
  assert.match(schema, /^mm_web_upgrade_test_[a-f0-9]{16}$/);
  const scoped = new URL(target);
  scoped.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=20000`);
  const saved = { db: process.env.DATABASE_URL, dek: process.env.MERRYMEN_STORE_DEK, home: process.env.MERRYMEN_HOME };
  const home = mkdtempSync(path.join(os.tmpdir(), "mm-web-upgrade-"));
  process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 9).toString("base64");
  process.env.MERRYMEN_HOME = home;
  // The web's read seam picks Postgres by DATABASE_URL: this run's schema only.
  process.env.DATABASE_URL = scoped.toString();

  const clients: PgClient[] = [];
  const connect = async (u: string): Promise<PgClient> => {
    const c = new pg!.Client({ connectionString: u });
    await c.connect();
    clients.push(c);
    return c;
  };
  const admin = await connect(target.toString());
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    await (await connect(scoped.toString())).query(readFileSync(FIXTURE, "utf8"));
    const shared = await makePgDb(scoped.toString());
    await shared
      .prepare(
        `INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, mode)
         VALUES (?, '0x9', '0x8', 4663, '{}', 1, 2, 'live')`,
      )
      .run(A1);
    const readDb = createReadDb(makePgDb);

    await t.test("before the mirror has migrated the ledger: null, never a throw", async () => {
      assert.equal(await readAgentEnergy(A1, readDb), null);
    });

    await t.test("after: the worker's report, and a never-reported agent is still null", async () => {
      await applyLedgerSchema(shared);
      assert.equal(await readAgentEnergy(A1, readDb), null, "migrated, not yet reported");
      await shared.prepare("UPDATE agents SET energy = ? WHERE smart_account = ?").run(JSON.stringify(REPORT), A1);
      const got = await readAgentEnergy(A1, readDb);
      assert.equal(got?.level, "low");
      assert.deepEqual(got?.entries, { used: 1, allowed: 2 });
      assert.equal(await readAgentEnergy("0x" + "cd".repeat(20), readDb), null);
    });

    await t.test("holderWalletFor over the Postgres claims store: linked while claimed, login otherwise", async () => {
      const store = new PgSettingsStore(scoped.toString(), connect);
      useSettingsStoreForTest(store);
      await store.put(T1, { holderProof: { address: W1, at: 1 } });
      assert.deepEqual(await holderWalletFor(T1), { address: T1, source: "login" }, "an unclaimed proof does not count");
      assert.deepEqual(await store.takeHolder(W1, T1), { ok: true, fresh: true });
      assert.deepEqual(await holderWalletFor(T1), { address: W1, source: "linked" });
      assert.deepEqual(await store.claimHolder(T2, T1), { ok: true, fresh: true });
      assert.deepEqual(await holderWalletFor(T2), { address: null, source: null }, "a login wallet another account claims counts for nobody here");
    });
  } finally {
    resetSettingsStoreForTest();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    for (const c of clients) await c.end().catch(() => {});
    rmSync(home, { recursive: true, force: true });
    for (const [k, v] of [["DATABASE_URL", saved.db], ["MERRYMEN_STORE_DEK", saved.dek], ["MERRYMEN_HOME", saved.home]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
