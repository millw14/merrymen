/**
 * THE WORKER'S PUBLISH AND THE DASHBOARD'S READ, AGAINST ONE TABLE (plan §3.1).
 *
 * The orchestrator writes tenant_telegram (worker telegram-store.ts
 * publishTelegramRuntime, publishTenantChildState) and GET /api/telegram reads
 * it (lib/telegram-runtime.ts readTelegramRuntime). Nothing tied the two but
 * column names in two files. A column renamed on one side fails the full
 * read, the route falls back to the legacy read, and every tenant's code is
 * back on screen with no check of which bot it was minted for: the frozen
 * code for another bot that locked an owner out. No test would have failed.
 *
 * So these run the real publish into node:sqlite (the worker's own wrapper,
 * as the mirror's tests do) and the route's real read and decision over it.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { wrapSqlite, type Db } from "../../../worker/src/db";
import { TELEGRAM_BOT_CLAIMS_DDL } from "../../../worker/src/telegram-claims";
import {
  TELEGRAM_LIVENESS_DDL,
  TELEGRAM_STATE_DDL,
  livenessFor,
  publishTelegramRuntime,
  publishTenantChildState,
  readTenantTelegram,
} from "../../../worker/src/telegram-store";
import type { PollHealth } from "../../../worker/src/telegram/state";
import { telegramListening } from "./telegram-listening";
import { readTelegramRuntime } from "./telegram-runtime";

const NOW = Math.floor(Date.now() / 1000);
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const TOKEN = "111:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
const CODE = { linkCode: "K7M2QX", ownerId: null, linkedAt: null };

/** The shared database as the orchestrator leaves it; `liveness: false` is one whose ALTERs have not run. */
async function shared(o: { liveness?: boolean } = {}): Promise<Db> {
  const db = wrapSqlite(new DatabaseSync(":memory:"));
  await db.exec(TELEGRAM_STATE_DDL);
  if (o.liveness !== false) for (const ddl of TELEGRAM_LIVENESS_DDL) await db.exec(ddl);
  await db.exec(TELEGRAM_BOT_CLAIMS_DDL);
  return db;
}

const heard = (botId: string, over: Partial<PollHealth> = {}): PollHealth => ({ okAt: NOW - 20, err: null, errAt: null, botId, ...over });

/**
 * What the dashboard would say for `tenant`, whose owner has saved `token`:
 * the route's read, then its decision. The route asks the claims only about
 * a bot getMe has just confirmed for the token (route.ts confirmedBot);
 * `confirmed: false` is a token Telegram did not vouch for.
 */
async function dashboard(db: Db, tenant: `0x${string}`, token: string | null = TOKEN, o: { confirmed?: boolean } = {}) {
  const confirmedBot = token && o.confirmed !== false ? token.slice(0, token.indexOf(":")) : null;
  return telegramListening(await readTelegramRuntime(db, tenant, confirmedBot), token, NOW);
}

const claim = (db: Db, bot: string, tenant: string) =>
  db.prepare("INSERT INTO telegram_bot_claims (bot_id, tenant, claimed_at) VALUES (?, ?, ?)").run(bot, tenant, Date.now());

describe("what the orchestrator publishes is what the dashboard reads", () => {
  it("A HEARD BOT READS BACK LIVE, with its code", async () => {
    const db = await shared();
    const failed = await publishTelegramRuntime(db, A, CODE, livenessFor({ botId: "111", poll: heard("111") }, "111", "trading"));
    assert.equal(failed, null);
    const seen = await dashboard(db, A);
    assert.deepEqual(seen.listening, { state: "live", lastOkAt: NOW - 20, reason: null });
    assert.equal(seen.linkCode, "K7M2QX");
    assert.equal(seen.linkPending, false);
    assert.equal(seen.tradingHeld, null);
  });

  it("a failure is published with its time, and read as the owner's remedy", async () => {
    const db = await shared();
    const poll = heard("111", { okAt: NOW - 3_600, err: "refused: 401 Unauthorized", errAt: NOW - 30 });
    await publishTelegramRuntime(db, A, CODE, livenessFor({ botId: "111", poll }, "111", "trading"));
    assert.deepEqual((await dashboard(db, A)).listening, { state: "revoked", lastOkAt: NOW - 3_600, reason: "401 Unauthorized" });
  });

  it("A POLL RECORD ABOUT ANOTHER BOT PUBLISHES NULLS: nothing heard on this one yet", async () => {
    const db = await shared();
    await publishTelegramRuntime(db, A, CODE, livenessFor({ botId: "111", poll: heard("999") }, "111", "trading"));
    const seen = await dashboard(db, A);
    assert.equal(seen.listening.state, "unknown");
    assert.equal(seen.linkCode, "K7M2QX", "the code is this bot's");
  });

  it("A PROCESS NO LONGER HANDED THE BOT'S TOKEN PUBLISHES NO BOT, so its code is never shown for it", async () => {
    // The bot was moved to B's claim. A's telegram.json still names it and
    // holds a code for it, heard a minute ago; A's owner still has the token
    // saved. That code will never work again.
    const db = await shared();
    await publishTelegramRuntime(db, A, CODE, livenessFor({ botId: "111", poll: heard("111") }, null, "trading"));
    const pending = await dashboard(db, A);
    assert.equal(pending.linkCode, null);
    assert.equal(pending.listening.state, "unknown", "and nothing heard is claimed for it");
    // With the claim naming B, the dashboard says where it went, not "wait".
    await claim(db, "111", B);
    const elsewhere = await dashboard(db, A);
    assert.equal(elsewhere.linkCode, null);
    assert.equal(elsewhere.linkPending, false);
    assert.equal(elsewhere.botElsewhere, true);
    assert.ok(!JSON.stringify(elsewhere).includes(B), "and which tenant has it is never said");
  });

  it("a bot this tenant's own claim names is not elsewhere", async () => {
    const db = await shared();
    await publishTelegramRuntime(db, A, CODE, livenessFor({ botId: "111", poll: heard("111") }, "111", "trading"));
    await db.prepare("INSERT INTO telegram_bot_claims (bot_id, tenant, claimed_at) VALUES (?, ?, ?)").run("111", A.toUpperCase().replace("0X", "0x"), Date.now());
    const seen = await dashboard(db, A);
    assert.equal(seen.botElsewhere, false);
    assert.equal(seen.linkCode, "K7M2QX");
  });

  it("THE CODE IS STILL PUBLISHED WHEN THE LIVENESS COLUMNS ARE MISSING, and read the old way", async () => {
    const db = await shared({ liveness: false });
    const failed = await publishTelegramRuntime(db, A, CODE, livenessFor({ botId: "111", poll: heard("111") }, "111", "trading"));
    assert.ok(failed instanceof Error, "the liveness half failed, and said so");
    const seen = await dashboard(db, A);
    assert.equal(seen.linkCode, "K7M2QX");
    assert.equal(seen.listening.state, "unknown");
  });

  it("each tenant reads its own row", async () => {
    const db = await shared();
    await publishTelegramRuntime(db, A, CODE, livenessFor({ botId: "111", poll: heard("111") }, "111", "trading"));
    await publishTelegramRuntime(db, B, { ...CODE, linkCode: "B0BC0D" }, livenessFor({ botId: "111", poll: heard("111") }, "111", "trading"));
    assert.equal((await dashboard(db, A)).linkCode, "K7M2QX");
    assert.equal((await dashboard(db, B)).linkCode, "B0BC0D");
  });
});

describe("whether another agent holds the bot is said only to a token Telegram confirms", () => {
  it("A STRANGER NAMING ANOTHER AGENT'S BOT WITH A MADE-UP SECRET LEARNS NOTHING", async () => {
    // B's agent holds bot 111. S has a row of its own (it once ran a bot,
    // 555) and saves `111:garbage`: the right shape, so the PUT stores it
    // unclaimed, and getMe refuses it. What S's dashboard says must be the
    // same whether or not anybody holds 111, or the claim is an oracle.
    const db = await shared();
    await claim(db, "111", B);
    const S = "0x5555555555555555555555555555555555555555" as const;
    await publishTelegramRuntime(db, S, { ...CODE, linkCode: "S0S0S0" }, livenessFor({ botId: "555", poll: heard("555") }, "555", "trading"));
    const held = await dashboard(db, S, "111:garbage", { confirmed: false });
    const free = await dashboard(db, S, "222:garbage", { confirmed: false });
    assert.equal(held.botElsewhere, false);
    assert.deepEqual(held, free, "a held bot and a free one read alike");
    // And with no row at all.
    const T = "0x7777777777777777777777777777777777777777" as const;
    assert.deepEqual(await dashboard(db, T, "111:garbage", { confirmed: false }), await dashboard(db, T, "222:garbage", { confirmed: false }));
    assert.equal(await readTelegramRuntime(db, T, null), null);
  });

  it("the owner whose bot moved still holds a live token for it, and is still told where it went", async () => {
    const db = await shared();
    await publishTelegramRuntime(db, A, CODE, livenessFor({ botId: "111", poll: heard("111") }, null, "trading"));
    await claim(db, "111", B);
    assert.equal((await dashboard(db, A)).botElsewhere, true);
    assert.equal((await dashboard(db, A, TOKEN, { confirmed: false })).botElsewhere, false, "not without getMe's word");
  });

  it("A TENANT WITH NO ROW WHOSE CONFIRMED BOT IS HELD ELSEWHERE IS TOLD SO, not \"check back shortly\" for ever", async () => {
    // Its token is stripped at every spawn (the claim names B), so it never
    // writes a telegram.json and never gets a row: no code is minted
    // without a token. Only whether it trades is published, which inserts
    // nothing for "trading".
    const db = await shared();
    await publishTenantChildState(db, A, "trading");
    await claim(db, "111", B);
    const seen = await dashboard(db, A);
    assert.equal(seen.botElsewhere, true);
    assert.equal(seen.linkCode, null);
    assert.equal(seen.linkPending, false);
    assert.equal(seen.listening.state, "unknown");
    assert.ok(!JSON.stringify(seen).includes(B.slice(2)), "and which tenant has it is never said");
  });

  it("no row, and the bot is this tenant's or nobody's: still nothing to say", async () => {
    const db = await shared();
    assert.equal(await readTelegramRuntime(db, A, "111"), null, "nobody's");
    await claim(db, "111", A);
    assert.equal(await readTelegramRuntime(db, A, "111"), null, "its own");
    const seen = await dashboard(db, A);
    assert.equal(seen.linkPending, false, "unknown, not \"picking up\"");
    assert.equal(seen.botElsewhere, false);
  });
});

describe("a held tenant with no bot", () => {
  it("IS TOLD ITS TRADING IS HELD: the row says that and nothing else", async () => {
    // No telegram.json, so no code and no owner to publish; and no bot to
    // carry a hold reply or a direct message. The dashboard is all there is.
    const db = await shared();
    await publishTenantChildState(db, A, "held:trades newer than the last valuation");
    const seen = await dashboard(db, A, null);
    assert.equal(seen.tradingHeld, "trades newer than the last valuation");
    assert.equal(seen.linkCode, null);
    const row = (await db.prepare("SELECT link_code, owner_id, bot_id FROM tenant_telegram WHERE tenant = ?").get(A)) as Record<string, unknown>;
    assert.deepEqual({ ...row }, { link_code: null, owner_id: null, bot_id: null });
  });

  it("AND THAT ROW IS NO LINK to anything that reads links", async () => {
    // readTenantTelegram is how the orchestrator restores a link, finds the
    // recipient of a direct message, and how the MCP tool tells "never
    // linked" from "linked once, then unlinked". A row made only to say the
    // tenant is held must read as no link at all, not as an unlinked one.
    const db = await shared();
    await publishTenantChildState(db, A, "held:trades newer than the last valuation");
    assert.equal(await readTenantTelegram(db, A), null);
    // A row a child published is a link as it always was, held or not.
    await publishTelegramRuntime(db, B, CODE, livenessFor({ botId: "111", poll: heard("111") }, "111", "trading"));
    await publishTenantChildState(db, B, "held:the saved book is unreadable");
    assert.deepEqual(await readTenantTelegram(db, B), { linkCode: "K7M2QX", ownerId: null, linkedAt: null });
  });

  it("and it clears when the tenant trades again", async () => {
    const db = await shared();
    await publishTenantChildState(db, A, "held:trades newer than the last valuation");
    await publishTenantChildState(db, A, "trading");
    assert.equal((await dashboard(db, A, null)).tradingHeld, null);
  });

  it("a hold on a tenant with a published code keeps the code", async () => {
    const db = await shared();
    await publishTelegramRuntime(db, A, CODE, livenessFor({ botId: "111", poll: heard("111") }, "111", "trading"));
    await publishTenantChildState(db, A, "held:the saved book is unreadable");
    const seen = await dashboard(db, A);
    assert.equal(seen.linkCode, "K7M2QX");
    assert.equal(seen.tradingHeld, "the saved book is unreadable");
  });

  it("A TENANT THAT NEVER HAD A BOT OR A HOLD GETS NO ROW", async () => {
    const db = await shared();
    await publishTenantChildState(db, A, "trading");
    assert.equal(await readTelegramRuntime(db, A, null), null);
  });
});
