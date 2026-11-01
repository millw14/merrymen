/**
 * REAL POSTGRES: PERPS SAVES FOR MANY ACCOUNTS AT ONCE NEVER WEDGE THE WEB'S
 * POOL. Opt-in, like web/src/lib/start-over.postgres.test.ts (see its header):
 *
 *   MERRYMEN_TEST_PG_URL=postgres://merrymen@localhost:55432/merrymen_pgtest \
 *     npx tsx --test web/src/app/api/settings/perps-save-pool.postgres.test.ts
 *
 * Skipped without it. A LOCAL Postgres only, each test in a schema of its own
 * (so each starts with a cold pool and a cold pilot store), dropped after.
 *
 * WHY. A hosted Perps save holds its account's settings save lock: a session
 * advisory lock on ONE connection checked out of the web's shared pool
 * (makePgDb(DATABASE_URL), pg's default of ten, no connect timeout). Switching
 * paper entries on also asks the pilot store, which lives on that same pool.
 * Asked on a second connection, ten saves for ten accounts at once each held
 * one connection and waited for an eleventh that never came, and everything
 * else on the pool (exits, reads, sign-in, the kill) hung with them until the
 * process restarted. The pilot's reads, its admission transaction and, on a
 * cold process, its first initialization now run on the lock's own connection.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

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
const skip = !url && "set MERRYMEN_TEST_PG_URL to run";

/** More saves than pg's default pool holds, every one for a different account. */
const ACCOUNTS = 16;
/** pg's default pool size: the pool is full once this many saves hold their lock. */
const POOL_MAX = 10;
const tenant = (n: number) => `0x${(n + 1).toString(16).padStart(2, "0").repeat(20)}` as `0x${string}`;
const TENANTS = Array.from({ length: ACCOUNTS }, (_, n) => tenant(n));
const URL_PERPS = "https://app.example.test/api/settings?wallet=perps";
const URL_OFFERED = "https://app.example.test/api/perps/offered?wallet=perps";
/** Long enough for sixteen saves on a slow machine; a wedged pool never answers at all. */
const WEDGED_AFTER_MS = 30_000;

const KEYS = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "MERRYMEN_STORE_DEK", "DATABASE_URL", "MERRYMEN_PERPS", "MERRYMEN_PERPS_PAPER_TENANTS"] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let admin: PgClient | null = null;
let dir = "";
let schema = "";
let wedged = false;
let PUT: (req: Request) => Promise<Response>;
let GET: (req: Request) => Promise<Response>;
let OFFERED: (req: Request) => Promise<Response>;

before(async () => {
  if (!url || !pg) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  dir = mkdtempSync(path.join(tmpdir(), "merrymen-settings-pool-"));
  process.env.MERRYMEN_HOME = dir;
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_SESSION_SECRET = randomBytes(32).toString("hex");
  process.env.MERRYMEN_STORE_DEK = randomBytes(32).toString("base64");
  process.env.MERRYMEN_PERPS = "paper";
  // The pilot's one-time bootstrap: every account here is admitted.
  process.env.MERRYMEN_PERPS_PAPER_TENANTS = TENANTS.join(",");
  ({ PUT, GET } = await import("./route"));
  ({ GET: OFFERED } = await import("../perps/offered/route"));
});

/**
 * A schema of this test's own, and a DATABASE_URL naming it: a new URL is a
 * new pool and a new pilot store (both are cached by URL), so the test starts
 * cold. Its connections are named after it, so a wedged run's can be found.
 */
async function freshDatabase(): Promise<void> {
  schema = `settings_pool_${randomBytes(6).toString("hex")}`;
  await admin!.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(url!);
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  scoped.searchParams.set("application_name", schema);
  process.env.DATABASE_URL = scoped.toString();
  wedged = false;
  resetSettingsStoreForTest();
}

afterEach(async () => {
  if (!admin || !schema) return;
  // The settings store's own connection is never closed by the app; close it
  // so the run can exit. A wedged run's pooled connections are stuck checked
  // out for good, so they are ended from the server side.
  try {
    const store = getSettingsStore("perps") as unknown as { opened?: Promise<PgClient> | null };
    await store.opened?.then((c) => c.end()).catch(() => {});
  } catch { /* never opened */ }
  if (wedged) await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1", [schema]).catch(() => {});
  await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
  schema = "";
  resetSettingsStoreForTest();
});

after(async () => {
  await admin?.end().catch(() => {});
  for (const k of KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
  resetSettingsStoreForTest();
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const cookie = (t: `0x${string}`) => `mm_session=${mintSession(t)}`;

/** Every account's Perps settings stored, and the version its settings screen would send. */
async function seed(): Promise<Map<string, string>> {
  for (const t of TENANTS) await getSettingsStore("perps").put(t, { strategy: "perps-only" });
  const versions = new Map<string, string>();
  for (const t of TENANTS) {
    const res = await GET(new Request(URL_PERPS, { headers: { cookie: cookie(t) } }));
    assert.equal(res.status, 200);
    const version = ((await res.json()) as { version?: unknown }).version;
    assert.equal(typeof version, "string");
    versions.set(t, version as string);
  }
  return versions;
}

function enableAll(versions: Map<string, string>) {
  return Promise.all(
    TENANTS.map(async (t) => {
      const res = await PUT(new Request(URL_PERPS, {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: cookie(t) },
        body: JSON.stringify({ expectedVersion: versions.get(t), perpsEnabled: true, owner: t }),
      }));
      return { tenant: t, status: res.status, body: await res.json() as unknown };
    }),
  );
}

async function answeredOrWedged<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"wedged">((resolve) => { timer = setTimeout(() => resolve("wedged"), WEDGED_AFTER_MS); });
  const answered = await Promise.race([work, timeout]);
  clearTimeout(timer);
  if (answered === "wedged") {
    wedged = true;
    assert.fail(`no answer within ${WEDGED_AFTER_MS / 1000}s from ${what}: the pool is wedged`);
  }
  return answered;
}

async function assertAllEnabled(answered: Array<{ tenant: string; status: number; body: unknown }>) {
  for (const r of answered) assert.equal(r.status, 200, `${r.tenant}: ${JSON.stringify(r.body)}`);
  for (const t of TENANTS) assert.equal((await getSettingsStore("perps").get(t))?.perpsEnabled, true, t);
}

/** Session advisory locks held by this test's connections: one per save holding its lock. */
async function locksHeld(): Promise<number> {
  // The admin connection is inside the table lock's transaction, where the
  // activity view is a snapshot taken once: drop it so each look is current.
  await admin!.query("SELECT pg_stat_clear_snapshot()");
  const { rows } = await admin!.query(
    "SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.locktype = 'advisory' AND a.application_name = $1",
    [schema],
  );
  return Number(rows[0]?.n ?? 0);
}

test(`${ACCOUNTS} ACCOUNTS SWITCH PAPER ENTRIES ON AT ONCE: every save answers, and every switch is stored`, { skip }, async () => {
  await freshDatabase();
  const versions = await seed();
  await assertAllEnabled(await answeredOrWedged(enableAll(versions), `${ACCOUNTS} concurrent Perps saves`));
});

test(
  "A COLD PILOT STORE FIRST TOUCHED BY A READ THAT HOLDS NOTHING, WHILE SAVES FILL THE POOL: the saves never wait on it",
  { skip },
  async () => {
    await freshDatabase();
    const versions = await seed();
    // Hold every save inside its lock, at its first settings read, until the
    // pool is full of them. Then the offered read (no lock, no connection held)
    // is the pilot store's first caller: its initialization queues for an
    // eleventh connection. Only then are the saves let go, to reach the pilot.
    let offered: Promise<{ status: number; body: unknown }> | null = null;
    let released = false;
    await admin!.query("BEGIN");
    try {
      await admin!.query(`LOCK TABLE ${schema}.perps_tenant_settings IN ACCESS EXCLUSIVE MODE`);
      const saves = enableAll(versions);
      for (let i = 0; i < 200 && (await locksHeld()) < POOL_MAX; i++) await delay(25);
      assert.equal(await locksHeld() >= POOL_MAX, true, "the saves never filled the pool");
      offered = OFFERED(new Request(URL_OFFERED, { headers: { cookie: cookie(TENANTS[0]!) } }))
        .then(async (res) => ({ status: res.status, body: await res.json() as unknown }));
      await delay(200);
      await admin!.query("COMMIT"); released = true;
      await assertAllEnabled(await answeredOrWedged(saves, `${ACCOUNTS} concurrent Perps saves with a cold pilot store`));
      const read = await answeredOrWedged(offered, "the offered read");
      assert.equal(read.status, 200, JSON.stringify(read.body));
    } finally {
      if (!released) await admin!.query("ROLLBACK").catch(() => {});
    }
  },
);
