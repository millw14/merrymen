import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { wrapSqlite, type Db } from "../../../worker/src/db";
import { sealSecret, openSecret } from "../../../worker/src/store-crypto";
import { TELEGRAM_BOT_CLAIMS_DDL } from "../../../worker/src/telegram-claims";
import { createTelegramHandlers } from "./telegram-create-handlers";
import { TelegramManager } from "./telegram-manager";
import { useBotClaimsDbForTest } from "./telegram-claims";
import { mintSession } from "./auth";
import { GET as telegramStatus } from "../app/api/telegram/route";

const A = `0x${"a".repeat(40)}` as const, B = `0x${"b".repeat(40)}` as const;
const config = { token: "11111:manager_test_secret", username: "merrymen_manager_bot", webhookSecret: "h".repeat(32) };
const OURS = "https://app.merrymen.test/api/telegram/manager/webhook";
const dek = Buffer.alloc(32, 9);
const beforeDek = process.env.MERRYMEN_STORE_DEK;
let raw: DatabaseSync, db: Db;
let telegramCalls: { method: string; body: unknown }[] = [];
let service: ReturnType<typeof createTelegramHandlers>;
/** The manager's webhook as Telegram holds it, and whether getMe says it may manage bots. */
let telegramWebhook: string;
let canManage: boolean;
let logs: string[];
/** When set, another environment's setWebhook lands right after ours. */
let racingWebhook: string | null = null;
const fakeFetch = (async (input, init) => {
  const method = String(input).split("/").at(-1)!;
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  telegramCalls.push({ method, body });
  if (method === "setWebhook") telegramWebhook = racingWebhook ?? String(body.url);
  const result = method === "getManagedBotToken" ? "22222:managed_test_secret" :
    method === "getMe" && String(input).includes(config.token) ? { id: 11111, username: config.username, is_bot: true, can_manage_bots: canManage } :
    method === "getMe" ? { id: 22222, username: "my_merrymen_bot", is_bot: true } :
    method === "getWebhookInfo" ? { url: telegramWebhook, has_custom_certificate: false, pending_update_count: 0 } : true;
  return Response.json({ ok: true, result });
}) as typeof fetch;
before(() => { process.env.MERRYMEN_STORE_DEK = dek.toString("base64"); });
after(() => {
  if (beforeDek === undefined) delete process.env.MERRYMEN_STORE_DEK; else process.env.MERRYMEN_STORE_DEK = beforeDek;
  useBotClaimsDbForTest(null); raw?.close();
});
const handlers = (over: Partial<Parameters<typeof createTelegramHandlers>[0]> = {}) => createTelegramHandlers({ config: () => config, db: async () => db,
  // Transport auth seam is exercised with explicit tenant, production uses signed wallet cookie.
  auth: req => req.headers.get("x-test-tenant") as typeof A | null,
  manager: c => new TelegramManager(c, fakeFetch), webhookUrl: () => OURS, log: line => logs.push(line), ...over });
beforeEach(async () => {
  // No managed tables: every flow below starts on a database nobody migrated.
  raw?.close(); raw = new DatabaseSync(":memory:"); db = wrapSqlite(raw);
  await db.exec(TELEGRAM_BOT_CLAIMS_DDL);
  await db.exec("CREATE TABLE tenant_settings (tenant TEXT PRIMARY KEY, sealed TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  await db.prepare("INSERT INTO tenant_settings VALUES (?, ?, ?)").run(A, sealSecret(JSON.stringify({ dailyBudgetUsdg: 14, telegramControl: false, telegramAllowlist: [-123] }), dek), 1);
  useBotClaimsDbForTest(db); telegramCalls = []; telegramWebhook = ""; canManage = true; logs = []; racingWebhook = null;
  service = handlers();
});
afterEach(() => { mock.timers.reset(); });
const availability = async (h = service, intent?: string) => {
  const res = await h.GET(new Request(`http://localhost/api/telegram/create?owner=${A}${intent ? `&intent=${intent}` : ""}`, { headers: { "x-test-tenant": A } }));
  assert.equal(res.status, 200, await res.clone().text());
  return await res.json() as { available: boolean; intent?: { id: string; status: string } };
};
const methods = () => telegramCalls.map(c => c.method);
const req = (body: unknown, tenant: string | null = A, origin = "http://localhost") => new Request("http://localhost/api/telegram/create", {
  method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...(tenant ? { "x-test-tenant": tenant } : {}) }, body: JSON.stringify(body),
});
async function begin() {
  const res = await service.POST(req({ action: "begin", owner: A })); assert.equal(res.status, 200, await res.clone().text());
  return await res.json() as { intent: { id: string; status: string }; telegramUrl: string };
}
const webhook = (body: unknown, secret: string = config.webhookSecret) => service.webhook(new Request("http://localhost/api/telegram/manager/webhook", {
  method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(body),
}));
const date = () => Math.floor(Date.now() / 1000);
const message = (extra: object = {}) => ({ date: date(), from: { id: 54321, is_bot: false }, chat: { id: 54321, type: "private" }, ...extra });
async function readyCandidate() {
  const begun = await begin(); const challenge = new URL(begun.telegramUrl).searchParams.get("start");
  assert.equal((await webhook({ update_id: 10, message: message({ text: `/start ${challenge}` }) })).status, 200);
  assert.equal((await webhook({ update_id: 11, message: message({ managed_bot_created: { bot: { id: 22222, is_bot: true, username: "my_merrymen_bot" } } }) })).status, 200);
  return begun;
}
describe("web bot creation account boundary", () => {
  it("uses the signed wallet cookie and rejects forged or stale-account cookies", async () => {
    const saved = { hosted: process.env.MERRYMEN_HOSTED, secret: process.env.MERRYMEN_SESSION_SECRET };
    process.env.MERRYMEN_HOSTED = "1"; process.env.MERRYMEN_SESSION_SECRET = "synthetic-local-auth-secret-32-plus-characters";
    try {
      // The real cookie auth; no public origin, so the probe stops before any database or Bot API call.
      const cookied = createTelegramHandlers({ config: () => config, webhookUrl: () => null, log: () => {} });
      const signed = mintSession(A);
      const get = (cookie: string, owner = A) => new Request(`http://localhost/api/telegram/create?owner=${owner}`, { headers: { cookie: `mm_session=${encodeURIComponent(cookie)}` } });
      assert.equal((await cookied.GET(get(signed))).status, 200);
      assert.equal((await cookied.GET(get(signed + "x"))).status, 401);
      assert.equal((await cookied.GET(get(mintSession(B)))).status, 409);
      assert.equal((await telegramStatus(new Request(`http://localhost/api/telegram?owner=${A}`, { headers: { cookie: `mm_session=${encodeURIComponent(mintSession(B))}` } }))).status, 409);
      assert.equal(telegramCalls.length, 0);
    } finally {
      if (saved.hosted === undefined) delete process.env.MERRYMEN_HOSTED; else process.env.MERRYMEN_HOSTED = saved.hosted;
      if (saved.secret === undefined) delete process.env.MERRYMEN_SESSION_SECRET; else process.env.MERRYMEN_SESSION_SECRET = saved.secret;
    }
  });
  it("requires an authenticated tenant before any Bot API call or write", async () => {
    assert.equal((await service.POST(req({ action: "begin", owner: A }, null))).status, 401);
    assert.equal(telegramCalls.length, 0);
  });
  it("refuses a stale wallet and foreign origin", async () => {
    assert.equal((await service.POST(req({ action: "begin", owner: A }, B))).status, 409);
    assert.equal((await service.POST(req({ action: "begin", owner: A }, A, "https://foreign.example"))).status, 403);
    assert.equal(telegramCalls.length, 0);
  });
  it("accepts the configured public origin behind a proxy and the actual loopback Host", async () => {
    const saved = process.env.MERRYMEN_PUBLIC_ORIGIN;
    const request = (url: string, origin: string, host: string) => new Request(url, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Host: host, "x-test-tenant": A },
      body: JSON.stringify({ action: "begin", owner: A }),
    });
    try {
      process.env.MERRYMEN_PUBLIC_ORIGIN = "https://app.merrymen.test";
      assert.equal((await service.POST(request("http://internal:3000/api/telegram/create", "https://app.merrymen.test", "internal:3000"))).status, 200);
      delete process.env.MERRYMEN_PUBLIC_ORIGIN;
      assert.equal((await service.POST(request("http://localhost/api/telegram/create", "http://127.0.0.1", "127.0.0.1"))).status, 200);
    } finally { if (saved === undefined) delete process.env.MERRYMEN_PUBLIC_ORIGIN; else process.env.MERRYMEN_PUBLIC_ORIGIN = saved; }
  });
  it("keeps intent and candidate lookups scoped to their tenant", async () => {
    const { intent } = await readyCandidate();
    const res = await service.GET(new Request(`http://localhost/api/telegram/create?owner=${B}&intent=${intent.id}`, { headers: { "x-test-tenant": B } }));
    assert.equal(res.status, 404); assert.ok(!(await res.text()).includes("my_merrymen_bot"));
    assert.equal((await service.POST(req({ action: "confirm", owner: B, intentId: intent.id, botId: "22222" }, B))).status, 404);
  });
  it("defaults to disabled without operator configuration", async () => {
    const disabled = createTelegramHandlers({ config: () => null, auth: () => A });
    assert.deepEqual(await (await disabled.GET(new Request(`http://localhost/?owner=${A}`))).json(), { available: false });
    assert.equal((await disabled.POST(req({ action: "begin", owner: A }))).status, 503);
    assert.equal(telegramCalls.length, 0);
  });
});
describe("readiness: the button shows only when creation can work", () => {
  it("makes the tables, checks the manager, sets an unset webhook to this deployment's own, then says available", async () => {
    assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name='telegram_managed_intents'").get(), undefined);
    assert.deepEqual(await availability(), { available: true });
    assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE name='telegram_managed_intents'").get(), "tables made by the probe");
    assert.deepEqual(methods(), ["getMe", "getWebhookInfo", "setWebhook", "getWebhookInfo"]);
    assert.deepEqual(telegramCalls[2].body, { url: OURS, secret_token: config.webhookSecret, allowed_updates: ["message", "managed_bot"] });
    assert.equal(telegramWebhook, OURS);
    await availability(); await begin();
    assert.deepEqual(methods().slice(4), [], "a passed probe is cached: polls and begin call Telegram no more");
    assert.deepEqual(logs, []);
  });
  it("re-asserts its own URL once per process, since Telegram cannot report the secret, and not again while it stays", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
    telegramWebhook = OURS;
    assert.equal((await availability()).available, true);
    assert.deepEqual(methods(), ["getMe", "getWebhookInfo", "setWebhook", "getWebhookInfo"]);
    mock.timers.tick(6 * 60_000);
    telegramCalls = [];
    assert.equal((await availability()).available, true);
    assert.deepEqual(methods(), ["getMe", "getWebhookInfo"], "after the cache expires: checked, not set again");
    telegramWebhook = "";
    mock.timers.tick(6 * 60_000);
    telegramCalls = [];
    assert.equal((await availability()).available, true);
    assert.deepEqual(methods(), ["getMe", "getWebhookInfo", "setWebhook", "getWebhookInfo"], "a webhook someone deleted is set again");
  });
  it("never overwrites a webhook pointing at another environment: unavailable, one log line, no secret in it", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
    const elsewhere = "https://staging.merrymen.test/api/telegram/manager/webhook";
    telegramWebhook = elsewhere;
    assert.deepEqual(await availability(), { available: false });
    assert.equal((await service.POST(req({ action: "begin", owner: A }))).status, 503);
    assert.equal(telegramWebhook, elsewhere);
    assert.ok(!methods().includes("setWebhook"));
    assert.deepEqual(methods(), ["getMe", "getWebhookInfo"], "a failed probe is cached briefly too");
    mock.timers.tick(31_000);
    assert.equal((await availability()).available, false);
    assert.equal(logs.length, 1, "said once, not once per probe");
    assert.match(logs[0], /webhook points at another URL/);
    for (const secret of [config.token, config.webhookSecret, "manager_test_secret", elsewhere]) assert.ok(!logs[0].includes(secret));
    assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM telegram_managed_intents").get() as { n: number }).n, 0);
    telegramWebhook = "";
    mock.timers.tick(31_000);
    assert.equal((await availability()).available, true, "recovers once the other webhook is gone");
    assert.match(logs.at(-1)!, /available$/);
  });
  it("refuses a webhook another environment took while ours was being set, and never sets it twice", async () => {
    const elsewhere = "https://staging.merrymen.test/api/telegram/manager/webhook";
    racingWebhook = elsewhere;
    assert.deepEqual(await availability(), { available: false });
    assert.deepEqual(methods(), ["getMe", "getWebhookInfo", "setWebhook", "getWebhookInfo"]);
    assert.equal(telegramWebhook, elsewhere, "the other environment's webhook is left as it is");
    assert.match(logs[0], /changed while it was being set/);
  });
  it("answers availability with a bare boolean: no token, secret, URL or reason reaches the browser", async () => {
    canManage = false;
    const res = await service.GET(new Request(`http://localhost/api/telegram/create?owner=${A}`, { headers: { "x-test-tenant": A } }));
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { available: false });
    for (const secret of [config.token, config.webhookSecret, OURS, "Bot Management"]) assert.ok(!text.includes(secret));
  });
  it("is unavailable without an https public origin, before any Bot API call", async () => {
    assert.deepEqual(await availability(handlers({ webhookUrl: () => null })), { available: false });
    assert.deepEqual(telegramCalls, []);
    assert.match(logs[0], /MERRYMEN_PUBLIC_ORIGIN/);
  });
  it("is unavailable while the manager cannot manage bots, and sets no webhook for it", async () => {
    canManage = false;
    assert.deepEqual(await availability(), { available: false });
    assert.deepEqual(methods(), ["getMe"]);
    assert.match(logs[0], /Bot Management Mode/);
  });
  it("is unavailable when the database cannot make the tables", async () => {
    assert.deepEqual(await availability(handlers({ db: async () => { throw new Error("database down"); } })), { available: false });
    assert.deepEqual(telegramCalls, []);
  });
  it("still reads a setup underway when creation is not ready, so a candidate can be confirmed", async () => {
    const { intent } = await readyCandidate();
    const notReady = handlers();
    telegramWebhook = "https://staging.merrymen.test/api/telegram/manager/webhook";
    const read = await availability(notReady, intent.id);
    assert.equal(read.available, false);
    assert.equal(read.intent?.status, "confirm");
    const confirmed = await notReady.POST(req({ action: "confirm", owner: A, intentId: intent.id, botId: "22222" }));
    assert.equal(confirmed.status, 200, await confirmed.clone().text());
  });
});
describe("manager delivery and credential save", () => {
  it("rejects forged webhook secrets before processing", async () => {
    assert.equal((await webhook({ update_id: 10 }, "wrong")).status, 401);
    assert.equal(telegramCalls.length, 0);
  });
  it("never consumes a generic token rotation/owner event as creation", async () => {
    const { intent } = await begin();
    await webhook({ update_id: 10, managed_bot: { user: { id: 54321 }, bot: { id: 22222, is_bot: true, username: "my_merrymen_bot" } } });
    assert.equal((await service.POST(req({ action: "confirm", owner: A, intentId: intent.id, botId: "22222" }))).status, 409);
    assert.ok(!telegramCalls.some(c => c.method === "getManagedBotToken"));
  });
  it("rejects public chats, sender mismatch, bot senders and stale messages", async () => {
    const begun = await begin(); const challenge = new URL(begun.telegramUrl).searchParams.get("start");
    for (const extra of [{ chat: { id: -5, type: "group" } }, { chat: { id: 99999, type: "private" } }, { from: { id: 54321, is_bot: true } }, { date: date() - 601 }]) {
      await webhook({ update_id: 10, message: message({ text: `/start ${challenge}`, ...extra }) });
    }
    assert.ok(!telegramCalls.some(c => c.method === "sendMessage"));
  });
  it("requires explicit web confirmation, seals token and preserves risk/controls", async () => {
    const { intent } = await readyCandidate();
    assert.ok(!telegramCalls.some(c => c.method === "getManagedBotToken"));
    const before = raw.prepare("SELECT sealed FROM tenant_settings WHERE tenant=?").get(A) as { sealed: string };
    assert.ok(!openSecret(before.sealed, dek).includes("managed_test_secret"));
    const confirm = { action: "confirm", owner: A, intentId: intent.id, botId: "22222" };
    assert.equal((await service.POST(req({ ...confirm, botId: "99999" }))).status, 409);
    const res = await service.POST(req(confirm)); assert.equal(res.status, 200, await res.clone().text());
    const text = await res.text(); assert.ok(!text.includes("managed_test_secret")); assert.ok(!text.includes("54321"));
    const row = raw.prepare("SELECT sealed FROM tenant_settings WHERE tenant=?").get(A) as { sealed: string };
    assert.ok(!row.sealed.includes("managed_test_secret"));
    assert.deepEqual(JSON.parse(openSecret(row.sealed, dek)), { dailyBudgetUsdg: 14, telegramControl: false, telegramAllowlist: [-123], telegramBotToken: "22222:managed_test_secret", telegramEnabled: true });
    const calls = telegramCalls.length;
    assert.equal((await service.POST(req(confirm))).status, 200);
    assert.equal(telegramCalls.length, calls, "lost response retry does not fetch, claim or write again");
  });
  it("fails closed without the shared settings lock database", async () => {
    const begun = await readyCandidate(); useBotClaimsDbForTest(null);
    const beforeUrl = process.env.DATABASE_URL; delete process.env.DATABASE_URL;
    try { assert.equal((await service.POST(req({ action: "confirm", owner: A, intentId: begun.intent.id, botId: "22222" }))).status, 503); }
    finally { if (beforeUrl !== undefined) process.env.DATABASE_URL = beforeUrl; }
  });
});
