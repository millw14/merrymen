/**
 * A SERVER THAT HAS NEVER HAD A PERPS WALLET GROWS NO PERPS TABLE FROM A READ.
 *
 * GET /api/settings?wallet=perps is answered whatever MERRYMEN_PERPS says (D1),
 * and where Perps are not offered a PUT may still switch things off. Both read
 * the Perps wallet's settings first (readPerpsStoredStrict →
 * PgSettingsStore.getVersioned), and that read went through the store's
 * client(), which makes every table it names: so any signed-in login's GET, or
 * an off-only PUT with nothing to turn off, ran CREATE TABLE
 * perps_tenant_settings on the shared database of a fleet that had never had
 * a Perps wallet. That broke the rule docs/perps.md states ("Nothing creates a
 * Perps table or directory until the first Perps write"), could not be taken
 * back (tables are never dropped), and sent every kill after it past its
 * no-table catalog look to a SELECT. A Perps read now answers empty by a
 * catalog look on a connection that has run no DDL (settings-store.ts
 * PgSettingsStore.reading), as the grant store keeps perps_grants.
 *
 * Driven through the real GET and PUT, hosted, over the Postgres store's own
 * SQL run on sqlite (as perps-kill-race.test.ts runs it), with every statement
 * logged: no CREATE reaches the database until a Perps save that writes.
 * worker/src/perps-kill-settings.postgres.test.ts pins the same store on a
 * real Postgres.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { mintSession } from "@/lib/auth";
import { PgSettingsStore, resetSettingsStoreForTest, useSettingsStoreForTest } from "@merrymen/settings-store";

const OWNER = `0x${"cd".repeat(20)}` as const;
const KEYS = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_PERPS", "MERRYMEN_STORE_DEK"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let home: string;
let route: typeof import("./route");

/** sqlite standing in for Postgres, every statement logged: `$n` → `?n`, and to_regclass as sqlite says it. */
function sqliteClient() {
  const db = new DatabaseSync(":memory:");
  const log: string[] = [];
  return {
    log,
    hasPerpsTable: () => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'perps_tenant_settings'").get() !== undefined,
    client: {
      async query(sql: string, params: unknown[] = []) {
        log.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
        if (/to_regclass/.test(sql)) {
          const found = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(String(params[0]));
          return { rows: [{ found: found !== undefined }] };
        }
        const stmt = db.prepare(sql.replace(/\$(\d+)/g, "?$1"));
        if (/^\s*SELECT|RETURNING/i.test(sql)) return { rows: stmt.all(...(params as string[])) as Record<string, unknown>[] };
        stmt.run(...(params as string[]));
        return { rows: [] };
      },
    },
  };
}

let pg: ReturnType<typeof sqliteClient>;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-perps-no-table-"));
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_SESSION_SECRET = randomBytes(32).toString("hex");
  process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 5).toString("base64");
  delete process.env.DATABASE_URL;
  route = await import("./route");
});
beforeEach(() => {
  process.env.MERRYMEN_HOSTED = "1";
  // Production today: no Perps wallet is offered.
  delete process.env.MERRYMEN_PERPS;
  resetSettingsStoreForTest();
  pg = sqliteClient();
  useSettingsStoreForTest(new PgSettingsStore("postgres://stand-in", "perps", async () => pg.client), "perps");
});
afterEach(() => resetSettingsStoreForTest());
after(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const signedIn = { cookie: `mm_session=${mintSession(OWNER)}` };
const get = async () => {
  const res = await route.GET(new Request("https://app.example.test/api/settings?wallet=perps", { headers: signedIn }));
  return { status: res.status, body: (await res.json()) as { values?: Record<string, unknown>; error?: string } };
};
const put = async (body: Record<string, unknown>) => {
  const res = await route.PUT(
    new Request("https://app.example.test/api/settings?wallet=perps", {
      method: "PUT",
      headers: { "content-type": "application/json", ...signedIn },
      body: JSON.stringify({ ...body, owner: OWNER }),
    }),
  );
  return { status: res.status, body: (await res.json()) as { ok?: boolean; errors?: string[]; code?: string } };
};
const created = () => pg.log.filter((s) => /^(CREATE|ALTER)\b/i.test(s));

describe("hosted, a fleet with no Perps table: the Perps settings reads make none, only a Perps write does", () => {
  it("GET ?wallet=perps from a signed-in login answers the defaults by a catalog look, and makes nothing", async () => {
    const r = await get();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.values?.strategy, "perps-only");
    assert.ok(pg.log.some((s) => /to_regclass/.test(s)), `the read reached the store: ${JSON.stringify(pg.log)}`);
    assert.deepEqual(created(), [], "no DDL ran");
    assert.equal(pg.hasPerpsTable(), false, "perps_tenant_settings was not made");
  });

  it("an off-only PUT with nothing on to turn off answers ok and makes nothing; a refused one makes nothing either", async () => {
    const off = await put({ perpsEnabled: false, liveTradingEnabled: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    const refused = await put({ perpsMaxLeverage: 3 });
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "perps-wallet-not-offered");
    assert.deepEqual(created(), [], `no DDL ran: ${JSON.stringify(pg.log)}`);
    assert.equal(pg.hasPerpsTable(), false);
    // And the next read still finds nothing, and still makes nothing.
    assert.equal((await get()).status, 200);
    assert.equal(pg.hasPerpsTable(), false);
  });

  it("THE FIRST PERPS WRITE MAKES IT (MERRYMEN_PERPS=paper), and a read after it finds the row", async () => {
    process.env.MERRYMEN_PERPS = "paper";
    assert.equal((await get()).status, 200);
    assert.equal(pg.hasPerpsTable(), false, "a read is still only a look");
    const r = await put({ perpsMaxLeverage: 3 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(pg.hasPerpsTable(), true, "made by the write");
    assert.equal((await get()).body.values?.perpsMaxLeverage, 3);
  });
});
