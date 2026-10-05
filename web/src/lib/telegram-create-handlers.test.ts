import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it } from "node:test";
import { wrapSqlite, type Db } from "../../../worker/src/db";
import { sealSecret, openSecret } from "../../../worker/src/store-crypto";
import { TELEGRAM_BOT_CLAIMS_DDL } from "../../../worker/src/telegram-claims";
import { createTelegramHandlers } from "./telegram-create-handlers";
import { TELEGRAM_MANAGED_DDL } from "./telegram-managed-store";
import { TelegramManager } from "./telegram-manager";
import { useBotClaimsDbForTest } from "./telegram-claims";
import { mintSession } from "./auth";
import { GET as telegramStatus } from "../app/api/telegram/route";

const A = `0x${"a".repeat(40)}` as const, B = `0x${"b".repeat(40)}` as const;
const config = { token: "11111:manager_test_secret", username: "merrymen_manager_bot", webhookSecret: "h".repeat(32) };
const dek = Buffer.alloc(32, 9);
const beforeDek = process.env.MERRYMEN_STORE_DEK;
let raw: DatabaseSync, db: Db;
let telegramCalls: { method: string; body: unknown }[] = [];
let service: ReturnType<typeof createTelegramHandlers>;
const fakeFetch = (async (input, init) => {
  const method = String(input).split("/").at(-1)!;
  telegramCalls.push({ method, body: JSON.parse(String(init?.body)) });
  const result = method === "getManagedBotToken" ? "22222:managed_test_secret" :
    method === "getMe" && String(input).includes(config.token) ? { id: 11111, username: config.username, is_bot: true, can_manage_bots: true } :
    method === "getMe" ? { id: 22222, username: "my_merrymen_bot", is_bot: true } : true;
  return Response.json({ ok: true, result });
}) as typeof fetch;
before(() => { process.env.MERRYMEN_STORE_DEK = dek.toString("base64"); });
after(() => {
  if (beforeDek === undefined) delete process.env.MERRYMEN_STORE_DEK; else process.env.MERRYMEN_STORE_DEK = beforeDek;
  useBotClaimsDbForTest(null); raw?.close();
});
beforeEach(async () => {
  raw?.close(); raw = new DatabaseSync(":memory:"); db = wrapSqlite(raw);
  await db.exec(TELEGRAM_MANAGED_DDL);
  await db.exec(TELEGRAM_BOT_CLAIMS_DDL);
  await db.exec("CREATE TABLE tenant_settings (tenant TEXT PRIMARY KEY, sealed TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  await db.prepare("INSERT INTO tenant_settings VALUES (?, ?, ?)").run(A, sealSecret(JSON.stringify({ dailyBudgetUsdg: 14, telegramControl: false, telegramAllowlist: [-123] }), dek), 1);
  useBotClaimsDbForTest(db); telegramCalls = [];
  service = createTelegramHandlers({ config: () => config, db: async () => db,
    // Transport auth seam is exercised with explicit tenant, production uses signed wallet cookie.
    auth: req => req.headers.get("x-test-tenant") as typeof A | null,
    manager: c => new TelegramManager(c, fakeFetch) });
});
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
      const handlers = createTelegramHandlers({ config: () => config });
      const signed = mintSession(A);
      const get = (cookie: string, owner = A) => new Request(`http://localhost/api/telegram/create?owner=${owner}`, { headers: { cookie: `mm_session=${encodeURIComponent(cookie)}` } });
      assert.equal((await handlers.GET(get(signed))).status, 200);
      assert.equal((await handlers.GET(get(signed + "x"))).status, 401);
      assert.equal((await handlers.GET(get(mintSession(B)))).status, 409);
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
