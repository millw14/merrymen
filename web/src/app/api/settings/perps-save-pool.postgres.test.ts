/**
 * REAL POSTGRES: PERPS SAVES FOR MANY ACCOUNTS AT ONCE NEVER WEDGE THE WEB'S
 * POOL. Opt-in, like web/src/lib/start-over.postgres.test.ts (see its header):
 *
 *   MERRYMEN_TEST_PG_URL=postgres://merrymen@localhost:55432/merrymen_pgtest \
 *     npx tsx --test web/src/app/api/settings/perps-save-pool.postgres.test.ts
 *
 * Skipped without it. A LOCAL Postgres only, in a schema of its own, dropped
 * after.
 *
 * WHY. A hosted Perps save holds its account's settings save lock: a session
 * advisory lock on ONE connection checked out of the web's shared pool
 * (makePgDb(DATABASE_URL), pg's default of ten, no connect timeout). Switching
 * paper entries on also asks the pilot store, which lives on that same pool.
 * Asked on a second connection, ten saves for ten accounts at once each held
 * one connection and waited for an eleventh that never came, and everything
 * else on the pool (exits, reads, sign-in, the kill) hung with them until the
 * process restarted. The pilot's reads and its admission transaction now run on
 * the lock's own connection.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { mintSession } from "@/lib/auth";
import { getSettingsStore, resetSettingsStoreForTest } from "@merrymen/settings-store";

const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;
interface PgClient {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}
// LOADED ONLY WHEN A DATABASE IS NAMED: `pg` is not a dependency, so CI and a
// plain `npm test` skip cleanly.
const pg = (url ? createRequire(import.meta.url)("pg") : null) as { Client: new (c: { connectionString: string }) => PgClient } | null;

/** More saves than pg's default pool holds, every one for a different account. */
const ACCOUNTS = 16;
const tenant = (n: number) => `0x${(n + 1).toString(16).padStart(2, "0").repeat(20)}` as `0x${string}`;
const TENANTS = Array.from({ length: ACCOUNTS }, (_, n) => tenant(n));
const URL_PERPS = "https://app.example.test/api/settings?wallet=perps";
/** Long enough for sixteen saves on a slow machine; a wedged pool never answers at all. */
const WEDGED_AFTER_MS = 30_000;

const KEYS = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "MERRYMEN_STORE_DEK", "DATABASE_URL", "MERRYMEN_PERPS", "MERRYMEN_PERPS_PAPER_TENANTS"] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const schema = `settings_pool_${randomBytes(6).toString("hex")}`;
let admin: PgClient | null = null;
let dir = "";
let wedged = false;
let PUT: (req: Request) => Promise<Response>;
let GET: (req: Request) => Promise<Response>;

before(async () => {
  if (!url || !pg) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(url);
  // Every connection this test opens is in its own schema, and named, so a
  // wedged run's can be found and closed afterwards.
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  scoped.searchParams.set("application_name", schema);
  dir = mkdtempSync(path.join(tmpdir(), "merrymen-settings-pool-"));
  process.env.MERRYMEN_HOME = dir;
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_SESSION_SECRET = randomBytes(32).toString("hex");
  process.env.MERRYMEN_STORE_DEK = randomBytes(32).toString("base64");
  process.env.MERRYMEN_PERPS = "paper";
  // The pilot's one-time bootstrap: every account here is admitted.
  process.env.MERRYMEN_PERPS_PAPER_TENANTS = TENANTS.join(",");
  process.env.DATABASE_URL = scoped.toString();
  resetSettingsStoreForTest();
  ({ PUT, GET } = await import("./route"));
});

after(async () => {
  if (admin) {
    // The settings store's own connection is never closed by the app; close it
    // so the run can exit. A wedged run's pooled connections are stuck checked
    // out for good, so they are ended from the server side.
    try {
      const store = getSettingsStore("perps") as unknown as { opened?: Promise<PgClient> | null };
      await store.opened?.then((c) => c.end()).catch(() => {});
    } catch { /* never opened */ }
    if (wedged) await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1", [schema]).catch(() => {});
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
  for (const k of KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
  resetSettingsStoreForTest();
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const cookie = (t: string) => `mm_session=${mintSession(t)}`;

async function versionOf(t: `0x${string}`): Promise<string> {
  const res = await GET(new Request(URL_PERPS, { headers: { cookie: cookie(t) } }));
  assert.equal(res.status, 200);
  const version = ((await res.json()) as { version?: unknown }).version;
  assert.equal(typeof version, "string");
  return version as string;
}

test(
  `${ACCOUNTS} ACCOUNTS SWITCH PAPER ENTRIES ON AT ONCE: every save answers, and every switch is stored`,
  { skip: !url && "set MERRYMEN_TEST_PG_URL to run" },
  async () => {
    for (const t of TENANTS) await getSettingsStore("perps").put(t, { strategy: "perps-only" });
    const versions = new Map<string, string>();
    for (const t of TENANTS) versions.set(t, await versionOf(t));

    const saves = Promise.all(
      TENANTS.map(async (t) => {
        const res = await PUT(new Request(URL_PERPS, {
          method: "PUT",
          headers: { "content-type": "application/json", cookie: cookie(t) },
          body: JSON.stringify({ expectedVersion: versions.get(t), perpsEnabled: true, owner: t }),
        }));
        return { tenant: t, status: res.status, body: await res.json() as unknown };
      }),
    );
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"wedged">((resolve) => { timer = setTimeout(() => resolve("wedged"), WEDGED_AFTER_MS); });
    const answered = await Promise.race([saves, timeout]);
    clearTimeout(timer);
    if (answered === "wedged") {
      wedged = true;
      assert.fail(`no answer within ${WEDGED_AFTER_MS / 1000}s from ${ACCOUNTS} concurrent Perps saves: the pool is wedged`);
    }
    for (const r of answered) assert.equal(r.status, 200, `${r.tenant}: ${JSON.stringify(r.body)}`);
    for (const t of TENANTS) assert.equal((await getSettingsStore("perps").get(t))?.perpsEnabled, true, t);
  },
);
