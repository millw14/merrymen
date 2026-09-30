/**
 * "CONNECTED TO ANOTHER AGENT" IS SAID ONLY ABOUT A BOT TELEGRAM VOUCHES FOR.
 *
 * `botElsewhere` tells an owner that the bot of their saved token is held by
 * another Merrymen agent. It was asked of the claims by the saved token's bot
 * id alone, and a token Telegram does not confirm is saved as typed (the
 * settings PUT's rule, lib/telegram-claims.ts decideBotClaim). A bot id is
 * public. So any signed-in account could save `<id>:garbage` for a bot it
 * named, read this route, and learn whether a Merrymen agent held that bot:
 * silently, while that agent was offline, with neither the bot nor its owner
 * seeing the question. The very disclosure decideBotClaim runs getMe first to
 * deny.
 *
 * And the other way: a tenant whose confirmed bot is held elsewhere, and
 * which has no row (it is never handed the token, so it never mints a code),
 * was told "your agent mints a code on its next pass" for ever.
 *
 * Driven through the real GET, hosted, over the file settings store and the
 * sqlite file the route's read opens (no DATABASE_URL), with getMe a stub.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it } from "node:test";

import { mintSession } from "@/lib/auth";
import { getSettingsStore, resetSettingsStoreForTest } from "@merrymen/settings-store";
import { wrapSqlite, type Db } from "../../../../../worker/src/db";
import { TELEGRAM_BOT_CLAIMS_DDL } from "../../../../../worker/src/telegram-claims";
import {
  TELEGRAM_LIVENESS_DDL,
  TELEGRAM_STATE_DDL,
  livenessFor,
  publishTelegramRuntime,
  publishTenantChildState,
} from "../../../../../worker/src/telegram-store";
import type { TelegramStatus } from "./route";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const HOLDER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const STRANGER = "0x5555555555555555555555555555555555555555" as const;
const KEYS = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_TELEGRAM_BOT_TOKEN"] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
const NOW = Math.floor(Date.now() / 1000);
let home: string;
let GET: (req: Request) => Promise<Response>;
let raw: DatabaseSync;
let db: Db;
/** What getMe answers for a token; the default confirms `<id>:…` as bot <id>. */
let getMe: (token: string) => unknown;
const confirmAll = (token: string) => {
  const id = Number(token.split(":")[0]);
  return { ok: true, result: { id, is_bot: true, username: `bot${id}` } };
};

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "merrymen-telegram-elsewhere-"));
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_SESSION_SECRET = randomBytes(32).toString("hex");
  delete process.env.DATABASE_URL;
  // Set, to show a hosted read never stands the web's environment in for a tenant's token.
  process.env.MERRYMEN_TELEGRAM_BOT_TOKEN = "999:ENV-token-of-the-web-container";
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const m = /^https:\/\/api\.telegram\.org\/bot(.+)\/getMe$/.exec(url);
    if (!m) throw new Error(`unexpected fetch ${url}`);
    return Response.json(getMe(m[1]!));
  }) as typeof fetch;
  ({ GET } = await import("./route"));
});
beforeEach(async () => {
  getMe = confirmAll;
  resetSettingsStoreForTest();
  rmSync(path.join(home, "tenant-settings"), { recursive: true, force: true });
  raw?.close();
  rmSync(path.join(home, "merrymen.db"), { force: true });
  // The shared database as the orchestrator leaves it: the route opens this
  // file read-only for each request (lib/ledger.ts withReadDb).
  raw = new DatabaseSync(path.join(home, "merrymen.db"));
  db = wrapSqlite(raw);
  await db.exec(TELEGRAM_STATE_DDL);
  for (const ddl of TELEGRAM_LIVENESS_DDL) await db.exec(ddl);
  await db.exec(TELEGRAM_BOT_CLAIMS_DDL);
});
after(() => {
  globalThis.fetch = realFetch;
  raw?.close();
  for (const k of KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
  resetSettingsStoreForTest();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const claim = (bot: string, tenant: string) =>
  db.prepare("INSERT INTO telegram_bot_claims (bot_id, tenant, claimed_at) VALUES (?, ?, ?)").run(bot, tenant, Date.now());
const heard = (botId: string) => ({ okAt: NOW - 20, err: null, errAt: null, botId });
const save = (tenant: `0x${string}`, token: string) =>
  getSettingsStore().put(tenant, { telegramBotToken: token, telegramEnabled: true });
async function status(tenant: `0x${string}`): Promise<TelegramStatus> {
  const res = await GET(new Request("https://app.example.test/api/telegram", { headers: { cookie: `mm_session=${mintSession(tenant)}` } }));
  return (await res.json()) as TelegramStatus;
}

describe("GET /api/telegram — botElsewhere", () => {
  it("A STRANGER SAVING `<another agent's bot>:garbage` LEARNS NOTHING: the answer is the one a free bot gets", async () => {
    // The owner's agent holds bot 111. The stranger once ran a bot of its
    // own (555), so it has a row. It saves `111:garbage`, the right shape,
    // which the PUT stores unclaimed; Telegram refuses it.
    claim("111", OWNER);
    await publishTelegramRuntime(db, STRANGER, { linkCode: "S0S0S0", ownerId: null, linkedAt: null }, livenessFor({ botId: "555", poll: heard("555") }, "555", "trading"));
    getMe = () => ({ ok: false, error_code: 401, description: "Unauthorized" });
    await save(STRANGER, "111:garbage");
    const held = await status(STRANGER);
    await save(STRANGER, "222:garbage");
    const free = await status(STRANGER);
    assert.equal(held.botElsewhere, false);
    assert.deepEqual(held, free, "a claimed bot and a free one read alike");
  });

  it("nor from a getMe that answers for another bot, or for something that is not a bot", async () => {
    claim("111", OWNER);
    await publishTelegramRuntime(db, STRANGER, { linkCode: "S0S0S0", ownerId: null, linkedAt: null }, livenessFor({ botId: "555", poll: heard("555") }, "555", "trading"));
    await save(STRANGER, "111:garbage");
    for (const answer of [
      { ok: true, result: { id: 555, is_bot: true, username: "bot555" } },
      { ok: true, result: { id: 111, is_bot: false, username: "someone" } },
      { ok: true, result: { id: 111, username: "bot111" } },
    ]) {
      getMe = () => answer;
      assert.equal((await status(STRANGER)).botElsewhere, false, JSON.stringify(answer));
    }
  });

  it("THE OWNER WHOSE BOT MOVED holds a live token for it, so they are still told where it went", async () => {
    // Their agent is no longer handed the token, so what it publishes names no bot.
    await publishTelegramRuntime(db, OWNER, { linkCode: "K7M2QX", ownerId: null, linkedAt: null }, livenessFor({ botId: "111", poll: heard("111") }, null, "trading"));
    claim("111", HOLDER);
    await save(OWNER, "111:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw");
    const s = await status(OWNER);
    assert.equal(s.connected, true);
    assert.equal(s.botElsewhere, true);
    assert.equal(s.linkCode, null);
    assert.ok(!JSON.stringify(s).includes(HOLDER.slice(2)), "and never which account has it");
  });

  it("A TENANT WITH NO ROW whose confirmed bot is held elsewhere is told so, not to check back shortly", async () => {
    // Never handed the token, it never wrote a telegram.json: only whether
    // it trades is published, which makes no row.
    await publishTenantChildState(db, OWNER, "trading");
    claim("111", HOLDER);
    await save(OWNER, "111:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw");
    const s = await status(OWNER);
    assert.equal(s.botElsewhere, true);
    assert.equal(s.linkPending, false);
    assert.equal(s.linkCode, null);
    // The same tenant with getMe out of reach: nothing is claimed either way.
    getMe = () => ({ ok: false });
    const blind = await status(OWNER);
    assert.equal(blind.botElsewhere, false);
    assert.equal(blind.linkPending, false);
  });

  it("hosted, the web container's MERRYMEN_TELEGRAM_BOT_TOKEN is nobody's token", async () => {
    // No token saved: no token, whatever the environment holds.
    await getSettingsStore().put(OWNER, { telegramEnabled: true });
    const s = await status(OWNER);
    assert.equal(s.hasToken, false);
    assert.equal(s.connected, false);
    assert.equal(s.linkCode, null);
    // And a request with no session reads nothing at all.
    const res = await GET(new Request("https://app.example.test/api/telegram"));
    const anon = (await res.json()) as TelegramStatus;
    assert.equal(anon.hasToken, false);
    assert.equal(anon.linkCode, null);
  });
});
