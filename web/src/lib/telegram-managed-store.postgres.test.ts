/**
 * Opt-in disposable LOCAL PostgreSQL only. No DATABASE_URL or production
 * credential is read. Exercises the real Db driver and transaction boundaries,
 * including races that SQLite's single connection necessarily serializes.
 *
 * MERRYMEN_TEST_PG_URL=postgres://merrymen@127.0.0.1:55441/managed_test \
 *   node --import tsx --test web/src/lib/telegram-managed-store.postgres.test.ts
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import { makePgDb, type Db, type Stmt } from "../../../worker/src/db";
import { openSecret, sealSecret } from "../../../worker/src/store-crypto";
import { ensureManagedTelegramSchema, ManagedTelegramError, ManagedTelegramStore } from "./telegram-managed-store";

const fixtureUrl = process.env.MERRYMEN_TEST_PG_URL;
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MANAGER = "9000", BOT = "1001", USER = 1234567;
const TOKEN = `${BOT}:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw`;
const DEK = Buffer.alloc(32, 91);
const NOW = 4_102_444_800_000; // Year 2100: verifies BIGINT millisecond storage.
const DATE = NOW / 1000;
type PgClient = {
  connect(): Promise<void>; end(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};

test("Postgres: managed bot intents, replay, claims and encrypted settings are atomic", { skip: !fixtureUrl, timeout: 60_000 }, async (t) => {
  const target = new URL(fixtureUrl!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "only a disposable loopback PostgreSQL fixture is allowed");
  assert.ok(["postgres:", "postgresql:"].includes(target.protocol), "fixture URL must be an explicit PostgreSQL URL");
  const pg = createRequire(import.meta.url)("pg") as { Client: new (options: { connectionString: string }) => PgClient };
  const schema = `mm_managed_test_${randomBytes(8).toString("hex")}`;
  assert.match(schema, /^mm_managed_test_[a-f0-9]{16}$/);
  const admin = new pg.Client({ connectionString: target.toString() });
  await admin.connect();
  const originalDek = process.env.MERRYMEN_STORE_DEK;
  process.env.MERRYMEN_STORE_DEK = DEK.toString("base64");
  const scopedUrl = (service: string) => {
    const u = new URL(target);
    u.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000`);
    u.searchParams.set("application_name", `managed-bot-fixture-${service}`);
    return u.toString();
  };
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const dbA = await makePgDb(scopedUrl("web-a"));
    const dbB = await makePgDb(scopedUrl("web-b"));
    // Nobody applies a migration: two web replicas (separate pools) make the
    // managed tables, and the bot claims, at the same moment on first use,
    // as they do after a deploy. The advisory lock must make that one creation.
    await Promise.all([ensureManagedTelegramSchema(dbA), ensureManagedTelegramSchema(dbB)]);
    // The documented SQL stays applicable over what the store made.
    await dbA.exec(readFileSync(new URL("../../../docs/migrations/2026-10-05-telegram-managed.sql", import.meta.url), "utf8"));
    await dbA.exec("CREATE TABLE tenant_settings (tenant TEXT PRIMARY KEY, sealed TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    const storeA = new ManagedTelegramStore(dbA), storeB = new ManagedTelegramStore(dbB);
    const scope = (tenant: string, intentId: string) => ({ tenant, intentId, managerBotId: MANAGER, now: NOW });
    const seed = async (tenant: string, value: Record<string, unknown>) => {
      await dbA.prepare(`INSERT INTO tenant_settings VALUES (?, ?, 1) ON CONFLICT(tenant)
        DO UPDATE SET sealed=excluded.sealed, updated_at=excluded.updated_at`).run(tenant, sealSecret(JSON.stringify(value), DEK));
    };
    const readSettings = async (tenant: string) => {
      const row = await dbA.prepare("SELECT sealed FROM tenant_settings WHERE tenant=?").get(tenant) as { sealed: string } | undefined;
      return row ? JSON.parse(openSecret(row.sealed, DEK)) as Record<string, unknown> : null;
    };
    const reset = async () => {
      for (const table of ["telegram_managed_updates", "telegram_managed_users", "telegram_managed_intents", "telegram_bot_claims", "tenant_settings"]) {
        await dbA.prepare(`DELETE FROM ${table}`).run();
      }
    };
    const prepare = async (store: ManagedTelegramStore, tenant: string, user: number, startId: number) => {
      const began = await store.begin({ tenant, managerBotId: MANAGER, now: NOW });
      assert.equal((await store.bind({ managerBotId: MANAGER, updateId: startId, telegramUserId: user, challenge: began.challenge, messageDate: DATE, now: NOW })).outcome, "bound");
      assert.equal((await store.candidate({ kind: "managed_bot_created", managerBotId: MANAGER, updateId: startId + 1, telegramUserId: user,
        botId: BOT, username: "personal_test_bot", messageDate: DATE, now: NOW })).outcome, "candidate");
      return began.intent;
    };

    await t.test("self-provisioned tables store all intent clocks as BIGINT", async () => {
      const columns = await admin.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='telegram_managed_intents'", [schema]);
      for (const field of ["created_at", "expires_at", "bound_at", "bound_message_date", "bound_update_id", "completed_at"]) {
        assert.equal(columns.rows.find((row) => row.column_name === field)?.data_type, "bigint");
      }
      const began = await storeA.begin({ tenant: A, managerBotId: MANAGER, now: NOW });
      assert.equal(began.intent.expiresAt, NOW + 600_000);
      await reset();
    });

    await t.test("competing tenants on separate pools can bind a private user only once", async () => {
      const [a, b] = await Promise.all([storeA.begin({ tenant: A, managerBotId: MANAGER, now: NOW }), storeB.begin({ tenant: B, managerBotId: MANAGER, now: NOW })]);
      const result = await Promise.all([
        storeA.bind({ managerBotId: MANAGER, updateId: 10, telegramUserId: USER, challenge: a.challenge, messageDate: DATE, now: NOW }),
        storeB.bind({ managerBotId: MANAGER, updateId: 11, telegramUserId: USER, challenge: b.challenge, messageDate: DATE, now: NOW }),
      ]);
      assert.deepEqual(result.map((r) => r.outcome).sort(), ["bound", "ignored"]);
      assert.equal((await dbA.prepare("SELECT COUNT(*) AS n FROM telegram_managed_intents WHERE telegram_user_id=? AND status='waiting_bot'").get(String(USER)) as { n: number }).n, 1);
      assert.equal((await dbA.prepare("SELECT COUNT(*) AS n FROM telegram_managed_users").get() as { n: number }).n, 1);
      await reset();
    });

    await t.test("competing Telegram senders for one challenge return first-wins outcomes, not an SQL constraint failure", async () => {
      const began = await storeA.begin({ tenant: A, managerBotId: MANAGER, now: NOW });
      const result = await Promise.all([
        storeA.bind({ managerBotId: MANAGER, updateId: 20, telegramUserId: USER, challenge: began.challenge, messageDate: DATE, now: NOW }),
        storeB.bind({ managerBotId: MANAGER, updateId: 21, telegramUserId: USER + 1, challenge: began.challenge, messageDate: DATE, now: NOW }),
      ]);
      assert.deepEqual(result.map((r) => r.outcome).sort(), ["bound", "ignored"]);
      assert.equal((await dbA.prepare("SELECT COUNT(*) AS n FROM telegram_managed_users").get() as { n: number }).n, 1);
      await reset();
    });

    await t.test("a creation update replays durably across pools and does not choose a second bot", async () => {
      const intent = await prepare(storeA, A, USER, 30);
      const creation = { kind: "managed_bot_created" as const, managerBotId: MANAGER, updateId: 31, telegramUserId: USER,
        botId: BOT, username: "personal_test_bot", messageDate: DATE, now: NOW };
      assert.equal((await storeB.candidate(creation)).outcome, "already_candidate");
      assert.equal((await storeB.candidate({ ...creation, updateId: 32, botId: "1002", username: "second_test_bot" })).outcome, "ignored");
      assert.equal((await storeB.get(scope(A, intent.id)))?.botId, BOT);
      await reset();
    });

    await t.test("two tenants confirming the same bot from separate pools cannot move its claim", async () => {
      const a = await prepare(storeA, A, USER, 40);
      const b = await prepare(storeB, B, USER + 1, 50);
      const result = await Promise.allSettled([
        storeA.complete({ ...scope(A, a.id), botId: BOT, token: TOKEN, confirmedBotId: BOT }),
        storeB.complete({ ...scope(B, b.id), botId: BOT, token: TOKEN, confirmedBotId: BOT }),
      ]);
      assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
      const refusal = result.find((r) => r.status === "rejected") as PromiseRejectedResult;
      assert.ok(refusal.reason instanceof ManagedTelegramError && refusal.reason.code === "bot_claimed");
      const holder = await dbA.prepare("SELECT tenant FROM telegram_bot_claims WHERE bot_id=?").get(BOT) as { tenant: string };
      assert.equal((await readSettings(holder.tenant))?.telegramBotToken, TOKEN);
      assert.equal(await readSettings(holder.tenant === A ? B : A), null);
      await reset();
    });

    await t.test("a settings writer committing after the read is preserved by compare-and-swap refusal", async () => {
      await seed(A, { telegramAllowlist: [555], signedDailyLimit: "before", unknownField: "before" });
      const intent = await prepare(storeA, A, USER, 60);
      const latest = { telegramAllowlist: [888], signedDailyLimit: "latest", paused: true, unknownField: { keep: "latest" } };
      let raced = false;
      const intercept: Db = {
        prepare: (sql) => dbA.prepare(sql), exec: (sql) => dbA.exec(sql),
        tx: (fn) => dbA.tx((db) => fn({
          exec: (sql) => db.exec(sql), tx: (nested) => db.tx(nested),
          prepare: (sql): Stmt => {
            const statement = db.prepare(sql);
            if (!sql.startsWith("UPDATE tenant_settings SET sealed")) return statement;
            return {
              get: (...params) => statement.get(...params), all: (...params) => statement.all(...params),
              run: async (...params) => {
                raced = true;
                await dbB.prepare("UPDATE tenant_settings SET sealed=?, updated_at=2 WHERE tenant=?")
                  .run(sealSecret(JSON.stringify(latest), DEK), A);
                return statement.run(...params);
              },
            };
          },
        })),
      };
      await assert.rejects(new ManagedTelegramStore(intercept).complete({ ...scope(A, intent.id), botId: BOT, token: TOKEN, confirmedBotId: BOT }),
        (e: unknown) => e instanceof ManagedTelegramError && e.code === "settings_changed");
      assert.equal(raced, true);
      assert.deepEqual(await readSettings(A), latest);
      assert.deepEqual(await dbA.prepare("SELECT * FROM telegram_bot_claims").all(), []);
      assert.equal((await storeA.get(scope(A, intent.id)))?.status, "confirm");
      await reset();
    });

    await t.test("late confirmation failure rolls back encrypted save and claim while preserving the creation receipt", async () => {
      const original = { telegramAllowlist: [555], paused: true, signedDailyLimit: "unchanged" };
      await seed(A, original);
      const intent = await prepare(storeA, A, USER, 70);
      await dbA.exec(`CREATE FUNCTION fail_managed_complete() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.status='connected' THEN RAISE EXCEPTION 'synthetic late completion failure'; END IF; RETURN NEW; END; $$;
        CREATE TRIGGER refuse_managed_complete BEFORE UPDATE OF status ON telegram_managed_intents
        FOR EACH ROW EXECUTE FUNCTION fail_managed_complete();`);
      await assert.rejects(storeA.complete({ ...scope(A, intent.id), botId: BOT, token: TOKEN, confirmedBotId: BOT }), /synthetic late completion failure/);
      assert.deepEqual(await readSettings(A), original);
      assert.deepEqual(await dbA.prepare("SELECT * FROM telegram_bot_claims").all(), []);
      assert.equal((await storeB.get(scope(A, intent.id)))?.status, "confirm");
      assert.equal((await dbA.prepare("SELECT COUNT(*) AS n FROM telegram_managed_users").get() as { n: number }).n, 1);
      const replay = await storeB.candidate({ kind: "managed_bot_created", managerBotId: MANAGER, updateId: 71, telegramUserId: USER,
        botId: BOT, username: "personal_test_bot", messageDate: DATE, now: NOW });
      assert.equal(replay.outcome, "already_candidate");
    });
  } finally {
    if (originalDek === undefined) delete process.env.MERRYMEN_STORE_DEK;
    else process.env.MERRYMEN_STORE_DEK = originalDek;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
