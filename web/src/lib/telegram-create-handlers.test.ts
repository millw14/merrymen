import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { wrapSqlite, type Db } from "../../../worker/src/db";
import { sealSecret, openSecret } from "../../../worker/src/store-crypto";
import { TELEGRAM_BOT_CLAIMS_DDL } from "../../../worker/src/telegram-claims";
import { createTelegramHandlers } from "./telegram-create-handlers";
import { TelegramManager } from "./telegram-manager";
import { SAVE_BUSY, useBotClaimsDbForTest, withSettingsSaveLock } from "./telegram-claims";
import { mintSession } from "./auth";
import { GET as telegramStatus } from "../app/api/telegram/route";

const A = `0x${"a".repeat(40)}` as const, B = `0x${"b".repeat(40)}` as const;
const config = { token: "11111:manager_test_secret", username: "merrymen_manager_bot", webhookSecret: "h".repeat(32) };
const OURS = "https://app.merrymen.test/api/telegram/manager/webhook";
const dek = Buffer.alloc(32, 9);
const beforeDek = process.env.MERRYMEN_STORE_DEK;
let raw: DatabaseSync, db: Db;
/** Every Bot API call, and whether it was made inside a tenant's settings lock. */
let telegramCalls: { method: string; body: unknown; locked: boolean }[] = [];
/** The tenants whose settings lock was taken, in order, and how deep it is held now. */
let locks: string[];
let lockDepth = 0;
/** Bot API methods Telegram refuses (ok: false), as when it is unreachable or the message is unchanged. */
let failing: Set<string>;
let service: ReturnType<typeof createTelegramHandlers>;
/** The manager's webhook as Telegram holds it, the update types setWebhook last named for it, and whether getMe says it may manage bots. */
let telegramWebhook: string;
let telegramAllowed: unknown;
let canManage: boolean;
let logs: string[];
/** When set, another environment's setWebhook lands right after ours. */
let racingWebhook: string | null = null;
const fakeFetch = (async (input, init) => {
  const method = String(input).split("/").at(-1)!;
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  telegramCalls.push({ method, body, locked: lockDepth > 0 });
  if (failing.has(method)) return Response.json({ ok: false, error_code: 400, description: `Bad Request: refused ${config.token}` }, { status: 400 });
  if (method === "setWebhook") { telegramWebhook = racingWebhook ?? String(body.url); telegramAllowed = racingWebhook ? undefined : body.allowed_updates; }
  const result = method === "getManagedBotToken" ? "22222:managed_test_secret" :
    method === "getMe" && String(input).includes(config.token) ? { id: 11111, username: config.username, is_bot: true, can_manage_bots: canManage } :
    method === "getMe" ? { id: 22222, username: "my_merrymen_bot", is_bot: true } :
    method === "getWebhookInfo" ? { url: telegramWebhook, has_custom_certificate: false, pending_update_count: 0, ...(telegramAllowed ? { allowed_updates: telegramAllowed } : {}) } : true;
  return Response.json({ ok: true, result });
}) as typeof fetch;
before(() => { process.env.MERRYMEN_STORE_DEK = dek.toString("base64"); });
after(() => {
  if (beforeDek === undefined) delete process.env.MERRYMEN_STORE_DEK; else process.env.MERRYMEN_STORE_DEK = beforeDek;
  useBotClaimsDbForTest(null); raw?.close();
});
/** The real settings lock, watched: which tenant, and which Bot API calls happen while it is held. */
const watchedLock: typeof withSettingsSaveLock = (tenant, fn, waitMs) => withSettingsSaveLock(tenant, async claims => {
  locks.push(tenant); lockDepth++;
  try { return await fn(claims); } finally { lockDepth--; }
}, waitMs);
const handlers = (over: Partial<Parameters<typeof createTelegramHandlers>[0]> = {}) => createTelegramHandlers({ config: () => config, db: async () => db,
  // Transport auth seam is exercised with explicit tenant, production uses signed wallet cookie.
  auth: req => req.headers.get("x-test-tenant") as typeof A | null, saveLock: watchedLock,
  manager: c => new TelegramManager(c, fakeFetch), webhookUrl: () => OURS, log: line => logs.push(line), ...over });
beforeEach(async () => {
  // No managed tables: every flow below starts on a database nobody migrated.
  raw?.close(); raw = new DatabaseSync(":memory:"); db = wrapSqlite(raw);
  await db.exec(TELEGRAM_BOT_CLAIMS_DDL);
  await db.exec("CREATE TABLE tenant_settings (tenant TEXT PRIMARY KEY, sealed TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  await db.prepare("INSERT INTO tenant_settings VALUES (?, ?, ?)").run(A, sealSecret(JSON.stringify({ dailyBudgetUsdg: 14, telegramControl: false, telegramAllowlist: [-123] }), dek), 1);
  useBotClaimsDbForTest(db); telegramCalls = []; telegramWebhook = ""; telegramAllowed = undefined; canManage = true; logs = []; racingWebhook = null;
  locks = []; lockDepth = 0; failing = new Set(); presses = 0;
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
const webhook = (body: unknown, secret: string = config.webhookSecret, h = service) => h.webhook(new Request("http://localhost/api/telegram/manager/webhook", {
  method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(body),
}));
const date = () => Math.floor(Date.now() / 1000);
const message = (extra: object = {}) => ({ date: date(), from: { id: 54321, is_bot: false }, chat: { id: 54321, type: "private" }, ...extra });
const created = (bot = { id: 22222, is_bot: true, username: "my_merrymen_bot" }) => message({ managed_bot_created: { bot } });
/** A setup with its bot made: begun on the page, /start (update `first`) and the creation (`first + 1`) in Telegram. */
async function readyCandidate(first = 10) {
  const begun = await begin(); const challenge = new URL(begun.telegramUrl).searchParams.get("start")!;
  assert.equal((await webhook({ update_id: first, message: message({ text: `/start ${challenge}` }) })).status, 200);
  assert.equal((await webhook({ update_id: first + 1, message: created() })).status, 200);
  return { ...begun, challenge };
}
type Sent = { chat_id: number; message_id?: number; text: string; callback_query_id?: string;
  reply_markup?: { keyboard?: unknown; inline_keyboard?: { text: string; callback_data?: string; url?: string }[][] } };
const bodies = (method: string) => telegramCalls.filter(c => c.method === method).map(c => c.body as Sent);
/** The Connect and Not this bot buttons of the manager's last "ready" message. */
function buttons() {
  const ready = bodies("sendMessage").filter(m => m.reply_markup?.inline_keyboard && / is ready\./.test(m.text)).at(-1);
  assert.ok(ready, "the manager offered the bot");
  return { connect: ready.reply_markup!.inline_keyboard![0]![0]!.callback_data!, cancel: ready.reply_markup!.inline_keyboard![1]![0]!.callback_data!, markup: ready.reply_markup };
}
const BACK = { inline_keyboard: [[{ text: "Back to Merrymen", url: "https://app.merrymen.test" }]] };
const CONNECTED = "✅ Connected @my_merrymen_bot to your Merrymen agent.\n@my_merrymen_bot replies once your agent is running. Merrymen then shows \"Open my bot\" to link your chat with it. If your agent is paused for recovery, that waits until it resumes.";
let presses = 0;
/** A press of a manager button, as Telegram delivers it: by default the bound user, in their private chat with the manager. */
function pressOf(data: string, over: { from?: object; chat?: object; inline?: boolean } = {}) {
  presses++;
  return { update_id: 1000 + presses, callback_query: {
    id: `cbq-${presses}`, chat_instance: "-42", data,
    from: { id: 54321, is_bot: false, first_name: "Owner", ...over.from },
    ...(over.inline ? { inline_message_id: "AAAAAQ" } : { message: { message_id: 77, date: date(), chat: { id: 54321, type: "private", ...over.chat }, text: "✅ @my_merrymen_bot is ready." } }),
  } };
}
/** Nothing the manager sends, answers, edits or logs carries a token, the webhook secret, the challenge or the tenant. */
function assertNothingSecret(challenge: string, more: string[] = []) {
  const said = JSON.stringify([telegramCalls.filter(c => c.method !== "setWebhook").map(c => c.body), logs]);
  for (const secret of [config.token, "manager_test_secret", "managed_test_secret", config.webhookSecret, challenge, A, A.slice(2), ...more]) {
    assert.ok(!said.includes(secret), `${secret} was said`);
  }
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
    assert.deepEqual(telegramCalls[2].body, { url: OURS, secret_token: config.webhookSecret, allowed_updates: ["message", "managed_bot", "callback_query"] });
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
  it("sets its own webhook again at any probe while it lacks an update type the buttons need, and never one pointing elsewhere", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
    // As #313 left it: this deployment's URL, delivering no callback_query.
    telegramWebhook = OURS; telegramAllowed = ["message", "managed_bot"];
    assert.equal((await availability()).available, true);
    assert.deepEqual(methods(), ["getMe", "getWebhookInfo", "setWebhook", "getWebhookInfo"]);
    assert.deepEqual(telegramAllowed, ["message", "managed_bot", "callback_query"]);
    // A replica still running the old code sets the old types back during the deploy.
    telegramAllowed = ["message", "managed_bot"];
    mock.timers.tick(6 * 60_000); telegramCalls = [];
    assert.equal((await availability()).available, true);
    assert.deepEqual(methods(), ["getMe", "getWebhookInfo", "setWebhook", "getWebhookInfo"], "set again, though this process set it once already");
    assert.deepEqual(telegramAllowed, ["message", "managed_bot", "callback_query"]);
    mock.timers.tick(6 * 60_000); telegramCalls = [];
    assert.equal((await availability()).available, true);
    assert.deepEqual(methods(), ["getMe", "getWebhookInfo"], "and not again while it has them");
    // Another environment's webhook is never touched, however few types it has.
    const elsewhere = "https://staging.merrymen.test/api/telegram/manager/webhook";
    telegramWebhook = elsewhere; telegramAllowed = ["message"];
    mock.timers.tick(6 * 60_000); telegramCalls = [];
    assert.equal((await availability()).available, false);
    assert.deepEqual(methods(), ["getMe", "getWebhookInfo"]);
    assert.equal(telegramWebhook, elsewhere);
    assert.deepEqual(telegramAllowed, ["message"]);
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
describe("the next step in Telegram, once the bot is made", () => {
  it("offers Connect and Not this bot at once, says it once, and Telegram's redelivery says nothing", async () => {
    const begun = await begin(); const challenge = new URL(begun.telegramUrl).searchParams.get("start")!;
    await webhook({ update_id: 10, message: message({ text: `/start ${challenge}` }) });
    const creation = { update_id: 11, message: created() };
    assert.deepEqual(await (await webhook(creation)).json(), { ok: true });
    const offers = bodies("sendMessage").filter(m => m.reply_markup?.inline_keyboard);
    assert.deepEqual(offers, [{ chat_id: 54321, text: "✅ @my_merrymen_bot is ready.\nConnect it to your Merrymen agent?", reply_markup: { inline_keyboard: [
      [{ text: "Connect @my_merrymen_bot", callback_data: `mc:${begun.intent.id}:22222` }],
      [{ text: "Not this bot", callback_data: `mx:${begun.intent.id}:22222` }],
    ] } }]);
    for (const row of offers[0]!.reply_markup!.inline_keyboard!) for (const button of row) assert.ok(Buffer.byteLength(button.callback_data!) <= 64);
    const count = telegramCalls.length;
    assert.equal((await webhook(creation)).status, 200);
    assert.equal(telegramCalls.length, count, "a redelivered creation is not offered twice");
    assert.ok(!methods().includes("getManagedBotToken"), "offering the bot connects nothing");
    assert.equal((await availability(service, begun.intent.id)).intent?.status, "confirm", "and the page offers it too");
    assertNothingSecret(challenge);
  });
  it("still offers a bot made fifteen minutes into its setup, which the ten-minute window lost (begun 03:09, made 03:24)", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
    const begun = await begin(); const challenge = new URL(begun.telegramUrl).searchParams.get("start")!;
    await webhook({ update_id: 10, message: message({ text: `/start ${challenge}` }) });
    mock.timers.tick(15 * 60_000);
    await webhook({ update_id: 11, message: created() });
    assert.equal(buttons().connect, `mc:${begun.intent.id}:22222`);
    assert.equal((await availability(service, begun.intent.id)).intent?.status, "confirm");
  });
  it("tells the maker of a bot whose setup had expired, or never began, once each, and a redelivery says nothing", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
    const begun = await begin(); const challenge = new URL(begun.telegramUrl).searchParams.get("start")!;
    await webhook({ update_id: 10, message: message({ text: `/start ${challenge}` }) });
    mock.timers.tick(31 * 60_000);
    const creation = { update_id: 11, message: created() };
    await webhook(creation);
    const expired = "Your bot @my_merrymen_bot was created, but this Merrymen setup had expired, so it wasn't connected. Start again from Merrymen and create the bot within 30 minutes.";
    assert.deepEqual(bodies("sendMessage").filter(m => m.reply_markup?.inline_keyboard), [{ chat_id: 54321, text: expired, reply_markup: BACK }]);
    const count = telegramCalls.length;
    assert.equal((await webhook(creation)).status, 200);
    assert.equal(telegramCalls.length, count, "Telegram's redelivery is not a second creation");
    // Somebody with no setup at all, using a creation button from an old chat.
    const stranger = { ...created({ id: 33333, is_bot: true, username: "stray_merrymen_bot" }), from: { id: 77777, is_bot: false }, chat: { id: 77777, type: "private" } };
    await webhook({ update_id: 12, message: stranger });
    await webhook({ update_id: 12, message: stranger });
    assert.deepEqual(bodies("sendMessage").filter(m => m.chat_id === 77777).map(m => m.text), [expired.replace("my_merrymen_bot", "stray_merrymen_bot")]);
    assert.ok(!methods().includes("getManagedBotToken"));
    assert.equal((await availability(service, begun.intent.id)).intent?.status, "expired");
    assertNothingSecret(challenge);
  });
  it("logs a message Telegram refuses, and neither asks for redelivery nor undoes the setup", async () => {
    const begun = await begin(); const challenge = new URL(begun.telegramUrl).searchParams.get("start")!;
    await webhook({ update_id: 10, message: message({ text: `/start ${challenge}` }) });
    failing.add("sendMessage");
    const res = await webhook({ update_id: 11, message: created() });
    assert.equal(res.status, 200, "a redelivery would be a replay, and say nothing anyway");
    assert.equal((await availability(service, begun.intent.id)).intent?.status, "confirm", "the page still offers the bot");
    assert.deepEqual(logs, ["the manager's Connect message could not be sent"]);
    assertNothingSecret(challenge);
  });
});
describe("the Connect and Not this bot buttons", () => {
  it("connects from Telegram with the web's own completion, under the settings lock, and edits the message to say so", async () => {
    const begun = await readyCandidate(); const { connect } = buttons();
    telegramCalls = []; locks = [];
    assert.deepEqual(await (await webhook(pressOf(connect))).json(), { ok: true });
    assert.deepEqual(telegramCalls.map(c => [c.method, c.locked]), [["getManagedBotToken", true], ["getMe", true], ["answerCallbackQuery", false], ["editMessageText", false]]);
    assert.deepEqual(locks, [A], "the bound user's tenant, found by the store, not by anything in the press");
    assert.deepEqual(telegramCalls[2]!.body, { callback_query_id: "cbq-1" });
    assert.deepEqual(telegramCalls[3]!.body, { chat_id: 54321, message_id: 77, text: CONNECTED, reply_markup: BACK });
    const row = raw.prepare("SELECT sealed FROM tenant_settings WHERE tenant=?").get(A) as { sealed: string };
    assert.deepEqual(JSON.parse(openSecret(row.sealed, dek)), { dailyBudgetUsdg: 14, telegramControl: false, telegramAllowlist: [-123], telegramBotToken: "22222:managed_test_secret", telegramEnabled: true });
    assert.equal((await availability(service, begun.intent.id)).intent?.status, "connected", "the page reads it connected");
    assertNothingSecret(begun.challenge);
  });
  it("is safe to press twice, or to have Telegram redeliver the press: nothing is fetched, claimed or saved again", async () => {
    const begun = await readyCandidate(); const { connect } = buttons();
    const first = pressOf(connect);
    await webhook(first);
    const saved = raw.prepare("SELECT * FROM tenant_settings").all();
    const claims = raw.prepare("SELECT * FROM telegram_bot_claims").all();
    telegramCalls = [];
    // Telegram refuses an answer to an old press and an edit that changes nothing: neither is an error here.
    failing.add("answerCallbackQuery"); failing.add("editMessageText");
    assert.equal((await webhook(first)).status, 200);
    assert.equal((await webhook(pressOf(connect))).status, 200);
    assert.deepEqual(methods(), ["answerCallbackQuery", "editMessageText", "answerCallbackQuery", "editMessageText"]);
    assert.ok(bodies("editMessageText").every(m => m.text === CONNECTED));
    assert.deepEqual(raw.prepare("SELECT * FROM tenant_settings").all(), saved);
    assert.deepEqual(raw.prepare("SELECT * FROM telegram_bot_claims").all(), claims);
    // The page's own Connect afterwards: connected as it stands, and no second Connected message.
    const res = await service.POST(req({ action: "confirm", owner: A, intentId: begun.intent.id, botId: "22222" }));
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { intent: { status: string } }).intent.status, "connected");
    assert.ok(!methods().includes("sendMessage") && !methods().includes("getManagedBotToken"));
  });
  it("refuses a press from anyone but the Telegram user the setup bound, or from anywhere but that private chat", async () => {
    const begun = await readyCandidate(); const { connect, cancel } = buttons();
    telegramCalls = []; locks = [];
    const refusals = [
      pressOf(connect, { from: { id: 99999 }, chat: { id: 99999 } }),
      pressOf(cancel, { from: { id: 99999 }, chat: { id: 99999 } }),
      pressOf(connect, { from: { is_bot: true } }),
      pressOf(connect, { chat: { id: -5, type: "group" } }),
      pressOf(connect, { chat: { id: 99999 } }),
      pressOf(connect, { inline: true }),
      pressOf(`mc:${begun.intent.id}:33333`),
      pressOf(`${connect}9`),
      pressOf("mc:00000000-0000-4000-8000-000000000000:22222"),
      pressOf("mc:short:22222"),
      pressOf(""),
    ];
    for (const update of refusals) assert.deepEqual(await (await webhook(update)).json(), { ok: true });
    assert.deepEqual(methods(), refusals.map(() => "answerCallbackQuery"), "each press answered, none acted on or edited");
    assert.ok(bodies("answerCallbackQuery").every(m => typeof (m as { text?: unknown }).text === "string"), "each with a short reason");
    assert.equal(bodies("answerCallbackQuery")[0]!.text, "This setup isn't available. Start again from Merrymen.");
    assert.deepEqual(locks, [], "no settings lock taken, nothing completed or cancelled");
    assert.equal((await availability(service, begun.intent.id)).intent?.status, "confirm");
    const row = raw.prepare("SELECT sealed FROM tenant_settings WHERE tenant=?").get(A) as { sealed: string };
    assert.ok(!openSecret(row.sealed, dek).includes("managed_test_secret"));
    assertNothingSecret(begun.challenge);
  });
  it("answers a press on a setup that expired, was cancelled or was replaced, and connects nothing", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
    const begun = await readyCandidate(); const { connect } = buttons();
    mock.timers.tick(31 * 60_000);
    telegramCalls = [];
    await webhook(pressOf(connect));
    assert.deepEqual(methods(), ["answerCallbackQuery", "editMessageText"]);
    assert.equal(bodies("answerCallbackQuery")[0]!.text, "This setup expired.");
    assert.deepEqual(bodies("editMessageText")[0], { chat_id: 54321, message_id: 77, text: "This setup expired. Start again from Merrymen.", reply_markup: BACK });
    assert.equal((await availability(service, begun.intent.id)).intent?.status, "expired");

    // Cancelled on the page, then Connect pressed in Telegram.
    const cancelled = await readyCandidate(20); const old = buttons();
    await service.POST(req({ action: "cancel", owner: A, intentId: cancelled.intent.id }));
    telegramCalls = [];
    await webhook(pressOf(old.connect));
    assert.ok(!methods().includes("getManagedBotToken"));
    assert.match(bodies("editMessageText")[0]!.text, /^Cancelled\. Start again from Merrymen when you're ready\./);

    // Replaced: a new setup begun on the page, then the old message's Connect.
    const replaced = await readyCandidate(30); const stale = buttons();
    const next = await begin();
    telegramCalls = [];
    await webhook(pressOf(stale.connect));
    assert.ok(!methods().includes("getManagedBotToken"));
    assert.match(bodies("editMessageText")[0]!.text, /^Cancelled\./);
    assert.equal((await availability(service, replaced.intent.id)).intent?.status, "cancelled");
    assert.equal((await availability(service, next.intent.id)).intent?.status, "waiting_telegram", "the new setup is untouched");
    const row = raw.prepare("SELECT sealed FROM tenant_settings WHERE tenant=?").get(A) as { sealed: string };
    assert.ok(!openSecret(row.sealed, dek).includes("managed_test_secret"));
  });
  it("Not this bot cancels the setup from Telegram, frees its user to begin again, and points to @BotFather", async () => {
    const begun = await readyCandidate(); const { connect, cancel } = buttons();
    telegramCalls = []; locks = [];
    await webhook(pressOf(cancel));
    assert.deepEqual(locks, [A], "under the settings lock, as the page's cancel");
    assert.deepEqual(methods(), ["answerCallbackQuery", "editMessageText"]);
    assert.deepEqual(bodies("editMessageText")[0], { chat_id: 54321, message_id: 77, reply_markup: BACK,
      text: "Cancelled. Start again from Merrymen when you're ready.\nIf you don't need @my_merrymen_bot, you can delete it in @BotFather." });
    assert.equal((await availability(service, begun.intent.id)).intent?.status, "cancelled");
    telegramCalls = [];
    await webhook(pressOf(connect));
    assert.ok(!methods().includes("getManagedBotToken"), "Connect on the same message afterwards connects nothing");
    const next = await begin(); const challenge = new URL(next.telegramUrl).searchParams.get("start");
    await webhook({ update_id: 20, message: message({ text: `/start ${challenge}` }) });
    assert.equal((await availability(service, next.intent.id)).intent?.status, "waiting_bot", "the user's lease was let go");
    assertNothingSecret(begun.challenge);
  });
  it("Not this bot after a connection leaves the connection as it is, and says so", async () => {
    const begun = await readyCandidate(); const { connect, cancel } = buttons();
    await webhook(pressOf(connect));
    telegramCalls = [];
    await webhook(pressOf(cancel));
    assert.equal(bodies("answerCallbackQuery")[0]!.text, "Already connected, so nothing was cancelled.");
    assert.equal(bodies("editMessageText")[0]!.text, CONNECTED);
    assert.equal((await availability(service, begun.intent.id)).intent?.status, "connected");
  });
  it("says so when the agent already has a bot, and saves nothing", async () => {
    const begun = await readyCandidate(); const { connect } = buttons();
    const existing = { dailyBudgetUsdg: 14, telegramBotToken: "33333:existing_test_secret", telegramEnabled: false };
    raw.prepare("UPDATE tenant_settings SET sealed=? WHERE tenant=?").run(sealSecret(JSON.stringify(existing), dek), A);
    telegramCalls = [];
    await webhook(pressOf(connect));
    assert.equal(bodies("answerCallbackQuery")[0]!.text, "Your agent already has a bot.");
    assert.deepEqual(bodies("editMessageText")[0], { chat_id: 54321, message_id: 77, reply_markup: BACK,
      text: "Your Merrymen agent already has a Telegram bot, so @my_merrymen_bot wasn't connected. To use @my_merrymen_bot instead, replace the bot in Settings on Merrymen." });
    const row = raw.prepare("SELECT sealed FROM tenant_settings WHERE tenant=?").get(A) as { sealed: string };
    assert.deepEqual(JSON.parse(openSecret(row.sealed, dek)), existing);
    assert.equal((await availability(service, begun.intent.id)).intent?.status, "confirm");
    assertNothingSecret(begun.challenge, ["existing_test_secret"]);
  });
  it("says so when another agent holds the bot, without saying whose", async () => {
    const begun = await readyCandidate(); const { connect } = buttons();
    raw.prepare("INSERT INTO telegram_bot_claims VALUES (?, ?, 1)").run("22222", B);
    telegramCalls = [];
    await webhook(pressOf(connect));
    assert.deepEqual(bodies("editMessageText")[0], { chat_id: 54321, message_id: 77, reply_markup: BACK,
      text: "@my_merrymen_bot is already connected to another Merrymen agent, so it wasn't connected to yours." });
    assert.deepEqual({ ...raw.prepare("SELECT bot_id, tenant FROM telegram_bot_claims").get() as object }, { bot_id: "22222", tenant: B });
    assertNothingSecret(begun.challenge, [B, B.slice(2)]);
  });
  it("keeps the buttons to try again when Telegram or the settings lock cannot connect it now, then connects", async () => {
    const begun = await readyCandidate(); const { connect, markup } = buttons();
    failing.add("getManagedBotToken");
    telegramCalls = [];
    assert.equal((await webhook(pressOf(connect))).status, 200);
    assert.equal(bodies("answerCallbackQuery")[0]!.text, "Couldn't connect right now. Try again.");
    assert.deepEqual(bodies("editMessageText")[0], { chat_id: 54321, message_id: 77, text: "Couldn't connect right now. Try again, or connect from Merrymen.", reply_markup: markup });
    assert.deepEqual(logs, ["a Connect button in Telegram failed (Bot API)"]);
    failing.clear();
    const held = handlers({ saveLock: (async () => SAVE_BUSY) as unknown as typeof withSettingsSaveLock });
    telegramCalls = [];
    await webhook(pressOf(connect), config.webhookSecret, held);
    assert.equal(bodies("editMessageText")[0]!.text, "Couldn't connect right now. Try again, or connect from Merrymen.");
    assert.equal(logs.at(-1), "a Connect button in Telegram failed (busy)");
    assert.equal((await availability(service, begun.intent.id)).intent?.status, "confirm");
    telegramCalls = [];
    await webhook(pressOf(connect));
    assert.equal(bodies("editMessageText")[0]!.text, CONNECTED);
    assertNothingSecret(begun.challenge);
  });
  it("answers a press it cannot look up, and changes nothing", async () => {
    const begun = await readyCandidate(); const { connect } = buttons();
    const down = handlers({ db: async () => { throw new Error(`database down ${config.token}`); } });
    telegramCalls = [];
    assert.equal((await webhook(pressOf(connect), config.webhookSecret, down)).status, 200);
    assert.deepEqual(methods(), ["answerCallbackQuery"]);
    assert.equal(bodies("answerCallbackQuery")[0]!.text, "Couldn't do that right now. Try again.");
    assert.deepEqual(logs, ["a manager button press could not be checked"]);
    assertNothingSecret(begun.challenge);
  });
});
describe("a connection made on the page", () => {
  it("is said in Telegram too, once, after the settings lock is let go", async () => {
    const begun = await readyCandidate();
    const confirm = { action: "confirm", owner: A, intentId: begun.intent.id, botId: "22222" };
    telegramCalls = [];
    assert.equal((await service.POST(req(confirm))).status, 200);
    assert.deepEqual(telegramCalls.map(c => [c.method, c.locked]), [["getManagedBotToken", true], ["getMe", true], ["sendMessage", false]]);
    assert.deepEqual(telegramCalls[2]!.body, { chat_id: 54321, text: CONNECTED, reply_markup: BACK });
    assert.equal((await service.POST(req(confirm))).status, 200);
    assert.equal(bodies("sendMessage").length, 1, "a repeated confirmation says nothing again");
    assertNothingSecret(begun.challenge);
  });
  it("stands when that message cannot be sent", async () => {
    const begun = await readyCandidate();
    failing.add("sendMessage");
    const res = await service.POST(req({ action: "confirm", owner: A, intentId: begun.intent.id, botId: "22222" }));
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { intent: { status: string } }).intent.status, "connected");
    assert.deepEqual(logs, ["the manager's Connected message could not be sent"]);
  });
});
