import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { wrapSqlite, type Db } from "../../../worker/src/db";
import { TELEGRAM_BOT_CLAIMS_DDL } from "../../../worker/src/telegram-claims";
import { TELEGRAM_STATE_DDL, TELEGRAM_LIVENESS_DDL } from "../../../worker/src/telegram-store";
import { openSecret, sealSecret } from "../../../worker/src/store-crypto";
import {
  MANAGED_INTENT_TTL_MS,
  ManagedTelegramError,
  ManagedTelegramStore,
  TELEGRAM_MANAGED_DDL,
} from "./telegram-managed-store";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MANAGER = "9000";
const OTHER_MANAGER = "9001";
const USER = 1234567;
const BOT = "1001";
const TOKEN = `${BOT}:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw`;
const NOW = 1_800_000_000_000;
const DATE = NOW / 1000;
const DEK = Buffer.alloc(32, 73);

let originalDek: string | undefined;
before(() => {
  originalDek = process.env.MERRYMEN_STORE_DEK;
  process.env.MERRYMEN_STORE_DEK = DEK.toString("base64");
});
after(() => {
  if (originalDek === undefined) delete process.env.MERRYMEN_STORE_DEK;
  else process.env.MERRYMEN_STORE_DEK = originalDek;
});

async function fixture(settings?: Record<string, unknown>, o: { managed?: boolean; claims?: boolean } = {}) {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await db.exec("CREATE TABLE tenant_settings (tenant TEXT PRIMARY KEY, sealed TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  if (o.managed !== false) await db.exec(TELEGRAM_MANAGED_DDL);
  if (o.claims !== false) await db.exec(TELEGRAM_BOT_CLAIMS_DDL);
  await db.exec(TELEGRAM_STATE_DDL);
  for (const ddl of TELEGRAM_LIVENESS_DDL) await db.exec(ddl);
  if (settings) await seedSettings(db, A, settings);
  return { db, raw, store: new ManagedTelegramStore(db) };
}

async function seedSettings(db: Db, tenant: string, settings: Record<string, unknown>) {
  await db.prepare(`INSERT INTO tenant_settings VALUES (?, ?, ?) ON CONFLICT(tenant) DO UPDATE SET sealed=excluded.sealed, updated_at=excluded.updated_at`)
    .run(tenant, sealSecret(JSON.stringify(settings), DEK), 123);
}
async function settingsOf(db: Db, tenant = A) {
  const row = await db.prepare("SELECT sealed FROM tenant_settings WHERE tenant=?").get(tenant) as { sealed: string } | undefined;
  return row ? JSON.parse(openSecret(row.sealed, DEK)) as Record<string, unknown> : null;
}
const scoped = (id: string, over: { tenant?: string; managerBotId?: string; now?: number } = {}) =>
  ({ tenant: A, intentId: id, managerBotId: MANAGER, now: NOW, ...over });
async function ready(store: ManagedTelegramStore, over: { tenant?: string; managerBotId?: string; telegramUserId?: number; startId?: number; botId?: string; now?: number } = {}) {
  const tenant = over.tenant ?? A, managerBotId = over.managerBotId ?? MANAGER;
  const user = over.telegramUserId ?? USER, startId = over.startId ?? 10, now = over.now ?? NOW;
  const began = await store.begin({ tenant, managerBotId, now });
  assert.equal((await store.bind({ managerBotId, updateId: startId, challenge: began.challenge, telegramUserId: user, messageDate: Math.floor(now / 1000), now })).outcome, "bound");
  assert.equal((await store.candidate({ kind: "managed_bot_created", managerBotId, updateId: startId + 1, telegramUserId: user,
    botId: over.botId ?? BOT, username: "personal_test_bot", messageDate: Math.floor(now / 1000), now })).outcome, "candidate");
  return began.intent;
}
const errorCode = (code: string) => (e: unknown) => e instanceof ManagedTelegramError && e.code === code;

describe("managed bot intent authority", () => {
  it("stores only the hash of a random, tenant-bound, ten-minute /start challenge", async () => {
    const { db, store } = await fixture();
    const first = await store.begin({ tenant: A.toUpperCase().replace("0X", "0x"), managerBotId: MANAGER, now: NOW });
    assert.match(first.challenge, /^mm_[A-Za-z0-9_-]{43}$/);
    assert.equal(first.intent.expiresAt, NOW + MANAGED_INTENT_TTL_MS);
    assert.deepEqual(Object.keys(first.intent).sort(), ["botId", "botUsername", "expiresAt", "id", "status"]);
    const rows = await db.prepare("SELECT * FROM telegram_managed_intents").all();
    assert.equal((rows[0] as { challenge_hash: string }).challenge_hash, createHash("sha256").update(first.challenge).digest("hex"));
    assert.ok(!JSON.stringify(rows).includes(first.challenge));
    assert.equal(await store.get(scoped(first.intent.id, { tenant: B })), null);
    assert.equal(await store.get(scoped(first.intent.id, { managerBotId: OTHER_MANAGER })), null);
    assert.equal(await store.cancel(scoped(first.intent.id, { tenant: B })), null);
    const replacement = await store.begin({ tenant: A, managerBotId: MANAGER, now: NOW });
    assert.notEqual(first.challenge, replacement.challenge);
    assert.equal((await store.get(scoped(first.intent.id)))?.status, "cancelled");
    assert.equal((await store.bind({ managerBotId: MANAGER, updateId: 1, telegramUserId: USER, challenge: first.challenge, now: NOW })).outcome, "ignored");
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM telegram_managed_intents WHERE status='waiting_telegram'").get() as { n: number }).n, 1);
  });

  it("fails closed without the migration and never runs boot DDL", async () => {
    const { db, store } = await fixture(undefined, { managed: false });
    await assert.rejects(store.begin({ tenant: A, managerBotId: MANAGER, now: NOW }), /no such table/);
    assert.equal(await db.prepare("SELECT name FROM sqlite_master WHERE name='telegram_managed_intents'").get(), undefined);
    assert.equal(await settingsOf(db), null);
  });

  it("refuses an existing token before allocating another bot intent", async () => {
    const before = { telegramBotToken: TOKEN, telegramEnabled: false, telegramAllowlist: [77], customRisk: "unchanged" };
    const { db, store } = await fixture(before);
    await assert.rejects(store.begin({ tenant: A, managerBotId: MANAGER, now: NOW }), errorCode("bot_already_configured"));
    assert.deepEqual(await db.prepare("SELECT * FROM telegram_managed_intents").all(), []);
    assert.deepEqual(await settingsOf(db), before);
  });

  it("does not continue if hosted encryption is unavailable or the saved blob is unreadable", async () => {
    const { db, store } = await fixture();
    delete process.env.MERRYMEN_STORE_DEK;
    try { await assert.rejects(store.begin({ tenant: A, managerBotId: MANAGER, now: NOW }), /cannot store secrets in the clear/); }
    finally { process.env.MERRYMEN_STORE_DEK = DEK.toString("base64"); }
    await db.prepare("INSERT INTO tenant_settings VALUES (?, ?, 0)").run(A, "not-a-sealed-settings-value");
    await assert.rejects(store.begin({ tenant: A, managerBotId: MANAGER, now: NOW }), errorCode("settings_unreadable"));
    assert.deepEqual(await db.prepare("SELECT * FROM telegram_managed_intents").all(), []);
  });

  it("binds one verified private Telegram user once, durably replays the exact update, and rejects a changed replay", async () => {
    const { db, store } = await fixture();
    const { intent, challenge } = await store.begin({ tenant: A, managerBotId: MANAGER, now: NOW });
    const start = { managerBotId: MANAGER, updateId: 5, telegramUserId: USER, challenge, messageDate: DATE, now: NOW };
    assert.equal((await store.bind(start)).outcome, "bound");
    assert.equal((await new ManagedTelegramStore(db).bind(start)).outcome, "already_bound");
    await assert.rejects(store.bind({ ...start, telegramUserId: USER + 1 }), errorCode("update_conflict"));
    assert.equal((await store.bind({ ...start, updateId: 6, telegramUserId: USER + 1 })).outcome, "ignored");
    assert.equal((await store.get(scoped(intent.id)))?.status, "waiting_bot");
    assert.ok(!JSON.stringify(await store.get(scoped(intent.id))).includes(String(USER)), "public status never reveals private user ID");
    assert.ok(!JSON.stringify(await db.prepare("SELECT * FROM telegram_managed_updates").all()).includes(challenge));
    await assert.rejects(store.bind({ ...start, updateId: 7, telegramUserId: -100 }), errorCode("invalid_telegram_id"));
  });

  it("one user cannot bind two tenants, including concurrent requests and different managers; cancellation releases the lease", async () => {
    const { store } = await fixture();
    const a = await store.begin({ tenant: A, managerBotId: MANAGER, now: NOW });
    const b = await store.begin({ tenant: B, managerBotId: OTHER_MANAGER, now: NOW });
    const [aa, bb] = await Promise.all([
      store.bind({ managerBotId: MANAGER, updateId: 10, telegramUserId: USER, challenge: a.challenge, now: NOW }),
      store.bind({ managerBotId: OTHER_MANAGER, updateId: 10, telegramUserId: USER, challenge: b.challenge, now: NOW }),
    ]);
    assert.deepEqual([aa.outcome, bb.outcome].sort(), ["bound", "ignored"]);
    assert.equal(aa.outcome, "bound");
    assert.equal((await store.cancel(scoped(a.intent.id)))?.status, "cancelled");
    assert.equal((await store.bind({ managerBotId: OTHER_MANAGER, updateId: 11, telegramUserId: USER, challenge: b.challenge, now: NOW })).outcome, "bound");
  });

  it("two Telegram senders competing for one challenge grant only the first user", async () => {
    const { db, store } = await fixture();
    const began = await store.begin({ tenant: A, managerBotId: MANAGER, now: NOW });
    const results = await Promise.all([USER, USER + 1].map((user, index) => store.bind({ managerBotId: MANAGER, updateId: 10 + index,
      telegramUserId: user, challenge: began.challenge, now: NOW })));
    assert.deepEqual(results.map((r) => r.outcome), ["bound", "ignored"]);
    assert.deepEqual((await db.prepare("SELECT telegram_user_id FROM telegram_managed_users").all()).map((r) => (r as { telegram_user_id: string }).telegram_user_id), [String(USER)]);
  });

  it("accepts creation service messages only, after the bind's date and update ID; the first candidate is immutable", async () => {
    const { store } = await fixture();
    const began = await store.begin({ tenant: A, managerBotId: MANAGER, now: NOW });
    await store.bind({ managerBotId: MANAGER, updateId: 20, telegramUserId: USER, challenge: began.challenge, messageDate: DATE, now: NOW });
    const creation = { kind: "managed_bot_created" as const, managerBotId: MANAGER, telegramUserId: USER, botId: BOT,
      username: "personal_test_bot", messageDate: DATE, now: NOW };
    assert.equal((await store.candidate({ ...creation, updateId: 19 })).outcome, "ignored");
    assert.equal((await store.candidate({ ...creation, updateId: 21, messageDate: DATE - 1 })).outcome, "ignored");
    assert.equal((await store.candidate({ ...creation, updateId: 22, telegramUserId: USER + 1 })).outcome, "ignored");
    assert.equal((await store.candidate({ ...creation, updateId: 23, managerBotId: OTHER_MANAGER })).outcome, "ignored");
    assert.equal((await store.candidate({ ...creation, updateId: 24, kind: "managed_bot" as "managed_bot_created" })).outcome, "ignored");
    assert.equal((await store.candidate({ ...creation, updateId: 25 })).outcome, "candidate");
    assert.equal((await store.candidate({ ...creation, updateId: 25 })).outcome, "already_candidate");
    assert.equal((await store.candidate({ ...creation, updateId: 26, botId: "1002", username: "second_test_bot" })).outcome, "ignored");
    assert.deepEqual(await store.get(scoped(began.intent.id)), { id: began.intent.id, status: "confirm", expiresAt: NOW + MANAGED_INTENT_TTL_MS, botId: BOT, botUsername: "personal_test_bot" });
  });

  it("expires at ten minutes, never accepts stale creation, and frees a user's expired pending lease", async () => {
    const { db, store } = await fixture();
    const intent = await ready(store);
    const late = NOW + MANAGED_INTENT_TTL_MS;
    assert.equal((await store.get(scoped(intent.id, { now: late })))?.status, "expired");
    await assert.rejects(store.complete({ ...scoped(intent.id, { now: late }), botId: BOT, token: TOKEN, confirmedBotId: BOT }), errorCode("intent_expired"));
    assert.equal(await settingsOf(db), null);
    assert.deepEqual(await db.prepare("SELECT * FROM telegram_bot_claims").all(), []);
    const b = await store.begin({ tenant: B, managerBotId: MANAGER, now: late });
    assert.equal((await store.bind({ managerBotId: MANAGER, updateId: 30, telegramUserId: USER, challenge: b.challenge, now: late })).outcome, "bound");
    await assert.rejects(store.candidate({ kind: "managed_bot_created", managerBotId: MANAGER, updateId: 31, telegramUserId: USER, botId: BOT,
      username: "personal_test_bot", messageDate: DATE, now: late }), errorCode("stale_message"));
  });

  it("never assigns the manager itself to a tenant bot or poller, even if a candidate row is corrupted", async () => {
    const { db, store } = await fixture();
    const began = await store.begin({ tenant: A, managerBotId: MANAGER, now: NOW });
    await store.bind({ managerBotId: MANAGER, updateId: 10, telegramUserId: USER, challenge: began.challenge, now: NOW });
    await assert.rejects(store.candidate({ kind: "managed_bot_created", managerBotId: MANAGER, updateId: 11, telegramUserId: USER,
      botId: MANAGER, username: "manager_test_bot", messageDate: DATE, now: NOW }), errorCode("manager_bot_reserved"));
    assert.equal((await store.get(scoped(began.intent.id)))?.status, "waiting_bot");
    await db.prepare("UPDATE telegram_managed_intents SET status='confirm', bot_id=?, bot_username='manager_test_bot' WHERE id=?")
      .run(MANAGER, began.intent.id);
    await assert.rejects(store.complete({ ...scoped(began.intent.id), botId: MANAGER,
      token: `${MANAGER}:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw`, confirmedBotId: MANAGER }), errorCode("manager_bot_reserved"));
    assert.equal(await settingsOf(db), null);
    assert.deepEqual(await db.prepare("SELECT * FROM telegram_bot_claims").all(), []);
  });
});

describe("atomic managed bot confirmation", () => {
  it("preserves the latest complete settings and existing mirror; changes no owner, allowlist, risk or pause authority", async () => {
    const { db, store } = await fixture({ telegramAllowlist: [], strategy: "before" });
    const intent = await ready(store);
    const latest = { telegramAllowlist: [-222, 555], telegramEnabled: false, telegramCommands: false, strategy: "latest", paused: true,
      dailyUsdg: "12", signedDailyLimit: "unaltered", futureSetting: { nested: [true, null, "safe"] }, telegramMaxActionUsdg: "0" };
    await seedSettings(db, A, latest);
    await db.prepare(`INSERT INTO tenant_telegram (tenant, link_code, owner_id, linked_at, updated_at, bot_id, child_state)
      VALUES (?, 'ORIGINAL', 555, 123, 456, NULL, 'held:unchanged')`).run(A);
    const mirror = await db.prepare("SELECT * FROM tenant_telegram").all();
    const result = await store.complete({ ...scoped(intent.id), botId: BOT, token: TOKEN, confirmedBotId: BOT });
    assert.equal(result.status, "connected");
    assert.deepEqual(await settingsOf(db), { ...latest, telegramEnabled: true, telegramBotToken: TOKEN });
    assert.deepEqual(await db.prepare("SELECT * FROM tenant_telegram").all(), mirror);
    assert.deepEqual((await db.prepare("SELECT bot_id, tenant FROM telegram_bot_claims").all()).map((r) => ({ ...r as object })), [{ bot_id: BOT, tenant: A }]);
    const publicJson = JSON.stringify(result);
    assert.ok(!publicJson.includes(TOKEN) && !publicJson.includes(String(USER)) && !publicJson.includes("signedDailyLimit"));
    const sealed = (await db.prepare("SELECT sealed FROM tenant_settings WHERE tenant=?").get(A) as { sealed: string }).sealed;
    assert.ok(!sealed.includes(TOKEN) && !sealed.includes("futureSetting"));
    assert.deepEqual(await db.prepare("SELECT * FROM telegram_managed_users").all(), []);
    const saved = await db.prepare("SELECT * FROM tenant_settings").all();
    assert.equal((await store.complete({ ...scoped(intent.id, { now: NOW + 2 * MANAGED_INTENT_TTL_MS }), botId: BOT })).status, "connected");
    assert.deepEqual(await db.prepare("SELECT * FROM tenant_settings").all(), saved, "completion replay does not re-seal/re-save or need a token");
  });

  it("requires tenant/manager/candidate match and a live token confirmed for exactly that bot", async () => {
    const { db, store } = await fixture();
    const intent = await ready(store);
    const ask = { ...scoped(intent.id), botId: BOT, token: TOKEN, confirmedBotId: BOT };
    await assert.rejects(store.complete({ ...ask, tenant: B }), errorCode("intent_not_found"));
    await assert.rejects(store.complete({ ...ask, managerBotId: OTHER_MANAGER }), errorCode("intent_not_found"));
    await assert.rejects(store.complete({ ...ask, botId: "1002" }), errorCode("candidate_mismatch"));
    await assert.rejects(store.complete({ ...ask, confirmedBotId: null }), errorCode("bot_unconfirmed"));
    await assert.rejects(store.complete({ ...ask, token: TOKEN.replace("1001:", "1002:") }), errorCode("bot_unconfirmed"));
    await assert.rejects(store.complete({ ...ask, token: `${BOT}:x/../../getChat` }), errorCode("bot_unconfirmed"));
    assert.equal(await settingsOf(db), null);
    assert.deepEqual(await db.prepare("SELECT * FROM telegram_bot_claims").all(), []);
    assert.equal((await store.get(scoped(intent.id)))?.status, "confirm");
  });

  it("never replaces a token saved while creation was underway", async () => {
    const { db, store } = await fixture();
    const intent = await ready(store);
    const existing = { telegramBotToken: "1002:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", telegramEnabled: false, telegramAllowlist: [100] };
    await seedSettings(db, A, existing);
    await assert.rejects(store.complete({ ...scoped(intent.id), botId: BOT, token: TOKEN, confirmedBotId: BOT }), errorCode("bot_already_configured"));
    assert.deepEqual(await settingsOf(db), existing);
    assert.deepEqual(await db.prepare("SELECT * FROM telegram_bot_claims").all(), []);
  });

  it("never moves a claimed bot and preserves its holder without exposing it", async () => {
    const { db, store } = await fixture();
    const intent = await ready(store);
    await db.prepare("INSERT INTO telegram_bot_claims VALUES (?, ?, 123)").run(BOT, B);
    await assert.rejects(store.complete({ ...scoped(intent.id), botId: BOT, token: TOKEN, confirmedBotId: BOT }), errorCode("bot_claimed"));
    assert.deepEqual({ ...await db.prepare("SELECT * FROM telegram_bot_claims").get() as object }, { bot_id: BOT, tenant: B, claimed_at: 123 });
    assert.equal(await settingsOf(db), null);
    assert.equal((await store.get(scoped(intent.id)))?.status, "confirm");
  });

  it("rolls back claim, encrypted save, completion and user lease on a late database failure", async () => {
    const before = { telegramAllowlist: [888], signedDailyLimit: "unchanged", paused: true };
    const { db, store } = await fixture(before);
    const intent = await ready(store);
    await db.exec(`CREATE TRIGGER refuse_complete BEFORE UPDATE OF status ON telegram_managed_intents
      WHEN NEW.status='connected' BEGIN SELECT RAISE(ABORT, 'test late completion failure'); END;`);
    await assert.rejects(store.complete({ ...scoped(intent.id), botId: BOT, token: TOKEN, confirmedBotId: BOT }), /test late completion failure/);
    assert.deepEqual(await settingsOf(db), before);
    assert.deepEqual(await db.prepare("SELECT * FROM telegram_bot_claims").all(), []);
    assert.equal((await store.get(scoped(intent.id)))?.status, "confirm");
    assert.equal((await db.prepare("SELECT intent_id FROM telegram_managed_users").get() as { intent_id: string }).intent_id, intent.id);
  });

  it("missing claims schema fails closed and is not added automatically", async () => {
    const { db, store } = await fixture(undefined, { claims: false });
    const intent = await ready(store);
    await assert.rejects(store.complete({ ...scoped(intent.id), botId: BOT, token: TOKEN, confirmedBotId: BOT }), /no such table/);
    assert.equal(await settingsOf(db), null);
    assert.equal(await db.prepare("SELECT name FROM sqlite_master WHERE name='telegram_bot_claims'").get(), undefined);
    assert.equal((await store.get(scoped(intent.id)))?.status, "confirm");
  });

  it("serializes competing confirmation attempts with a single final saved bot", async () => {
    const { db, store } = await fixture();
    const intent = await ready(store);
    const ask = { ...scoped(intent.id), botId: BOT, token: TOKEN, confirmedBotId: BOT };
    const both = await Promise.all([store.complete(ask), new ManagedTelegramStore(db).complete(ask)]);
    assert.deepEqual(both.map((r) => r.status), ["connected", "connected"]);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM telegram_bot_claims").get() as { n: number }).n, 1);
    assert.equal((await settingsOf(db))?.telegramBotToken, TOKEN);
  });
});
