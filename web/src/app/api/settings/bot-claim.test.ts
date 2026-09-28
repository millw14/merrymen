/**
 * ONE BOT, ONE TENANT — through the real settings PUT.
 *
 * In the incident this came from, a second login saved the owner's bot token,
 * the save said "Changes saved", and from then on two agents fought over one
 * bot. Now the save claims the bot: another account's bot is refused with a
 * 409 that names nobody, "Move it here" re-sends the save with `moveBot`, and a
 * move needs Telegram to vouch for the token. A move carries nothing across:
 * the account the bot leaves keeps its settings, and the account it joins
 * keeps its own allowlist and links the bot with its own code.
 *
 * Hosted, over the file settings store and no DATABASE_URL, as
 * owner.test.ts runs; the bot claims are kept in node:sqlite through the
 * route's own seam, and getMe is a stubbed fetch.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it } from "node:test";

import { mintSession } from "@/lib/auth";
import { BOT_CLAIMED_TEXT, useBotClaimsDbForTest } from "@/lib/telegram-claims";
import { getSettingsStore, resetSettingsStoreForTest, useSettingsStoreForTest } from "@merrymen/settings-store";
import { wrapSqlite, type Db } from "../../../../../worker/src/db";
import { readBotClaims } from "../../../../../worker/src/telegram-claims";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const KEYS = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL"] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
let dir: string;
let PUT: (req: Request) => Promise<Response>;
let claims: Db;
/** Tokens getMe refuses (revoked, mistyped); any other `<id>:<secret>` answers for bot <id>. */
let refused = new Set<string>();
const getMeAsked: string[] = [];

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "merrymen-settings-bot-claim-"));
  process.env.MERRYMEN_HOME = dir;
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_SESSION_SECRET = randomBytes(32).toString("hex");
  delete process.env.DATABASE_URL;
  resetSettingsStoreForTest();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const m = /^https:\/\/api\.telegram\.org\/bot(.+)\/getMe$/.exec(url);
    if (!m) throw new Error(`unexpected fetch ${url}`);
    const token = m[1]!;
    getMeAsked.push(token);
    const id = /^(\d+):/.exec(token)?.[1];
    return Response.json(id && !refused.has(token) ? { ok: true, result: { id: Number(id), is_bot: true, username: `bot${id}` } } : { ok: false, error_code: 401 });
  }) as typeof fetch;
  ({ PUT } = await import("./route"));
});
beforeEach(() => {
  claims = wrapSqlite(new DatabaseSync(":memory:"));
  useBotClaimsDbForTest(claims);
  refused = new Set();
  getMeAsked.length = 0;
  resetSettingsStoreForTest();
  rmSync(path.join(dir, "tenant-settings"), { recursive: true, force: true });
});
after(() => {
  globalThis.fetch = realFetch;
  useBotClaimsDbForTest(null);
  for (const k of KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
  resetSettingsStoreForTest();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function put(session: `0x${string}`, body: Record<string, unknown>) {
  const res = await PUT(
    new Request("https://app.example.test/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: `mm_session=${mintSession(session)}` },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string; errors?: string[]; botMoved?: boolean; ignored?: string[] } };
}
const held = async () => Object.fromEntries(await readBotClaims(claims));

describe("PUT /api/settings claims the bot", () => {
  it("A SECOND ACCOUNT SAVING THE SAME BOT GETS 409 bot_claimed, NAMING NOBODY, AND NOTHING IS SAVED", async () => {
    assert.equal((await put(A, { telegramBotToken: "111:AAA-first-secret", telegramAllowlist: [777] })).status, 200);
    assert.deepEqual(await held(), { "111": A });
    // A re-issued secret for the same bot: the same bot.
    const res = await put(B, { telegramBotToken: "111:BBB-reissued-secret", telegramEnabled: true });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "bot_claimed");
    assert.deepEqual(res.body.errors, [BOT_CLAIMED_TEXT]);
    assert.ok(!JSON.stringify(res.body).includes(A.slice(2)), "the other account is not identified");
    assert.equal(await getSettingsStore().get(B), null, "a refusal writes nothing");
    assert.deepEqual(await held(), { "111": A });
  });

  it("A TOKEN TELEGRAM REFUSES IS SAVED AS TYPED AND CLAIMS NOTHING — a bot id alone takes no bot, and learns nothing", async () => {
    await put(A, { telegramBotToken: "111:AAA-first-secret" });
    // Anyone signed in can type another bot's public id with a made-up secret.
    refused.add("111:guessed-secret");
    const res = await put(B, { telegramBotToken: "111:guessed-secret" });
    assert.equal(res.status, 200, "the same answer it would get for a free bot");
    assert.equal(res.body.error, undefined);
    assert.deepEqual(await held(), { "111": A }, "the owner keeps the bot");
    assert.ok(getMeAsked.includes("111:guessed-secret"), "Telegram was asked before any claim");
  });

  it("MOVE IT HERE: getMe must confirm the token, the claim moves, and no allowlist or owner comes with it", async () => {
    await put(A, { telegramBotToken: "111:AAA-first-secret", telegramAllowlist: [777] });
    // B's own settings, saved before: its own allowlist.
    await put(B, { telegramAllowlist: [4242] });
    // Telegram does not vouch for the token: nothing moves, and nothing is saved.
    refused.add("111:BBB-reissued-secret");
    const unvouched = await put(B, { telegramBotToken: "111:BBB-reissued-secret", moveBot: true });
    assert.equal(unvouched.status, 409);
    assert.equal(unvouched.body.error, "bot_unconfirmed");
    assert.deepEqual(await held(), { "111": A });
    assert.equal((await getSettingsStore().get(B))?.telegramBotToken, undefined);

    refused.delete("111:BBB-reissued-secret");
    const moved = await put(B, { telegramBotToken: "111:BBB-reissued-secret", moveBot: true });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.botMoved, true);
    assert.equal(moved.body.ignored, undefined, "`moveBot` is not a setting, and not reported as one");
    assert.deepEqual(await held(), { "111": B });
    const b = (await getSettingsStore().get(B)) as Record<string, unknown>;
    assert.equal(b.telegramBotToken, "111:BBB-reissued-secret");
    assert.deepEqual(b.telegramAllowlist, [4242], "B's own allowlist, untouched: not A's, not merged, not cleared");
    assert.equal("moveBot" in b, false);
    assert.equal("ownerId" in b, false);
    const a = (await getSettingsStore().get(A)) as Record<string, unknown>;
    assert.equal(a.telegramBotToken, "111:AAA-first-secret", "the account it left keeps what its owner saved");
    assert.deepEqual(a.telegramAllowlist, [777]);
  });

  it("A SAVE THAT FAILS TAKES ITS CLAIM BACK", async () => {
    const real = getSettingsStore();
    const failing = Object.create(real) as typeof real;
    failing.put = async () => {
      throw new Error("store down");
    };
    useSettingsStoreForTest(failing);
    await assert.rejects(put(A, { telegramBotToken: "111:AAA-first-secret" }), /store down/);
    assert.deepEqual(await held(), {}, "no claim for a token that was never stored");
  });

  it("CLEARING THE TOKEN LETS GO OF THIS ACCOUNT'S CLAIM, AND ONLY ITS OWN", async () => {
    await put(A, { telegramBotToken: "111:AAA-first-secret" });
    await put(B, { telegramBotToken: "222:BBB-own-bot" });
    assert.equal((await put(B, { telegramBotToken: "" })).status, 200);
    assert.deepEqual(await held(), { "111": A });
    // Now free, the bot can be saved by B with no move.
    assert.equal((await put(B, { telegramBotToken: "222:BBB-own-bot" })).status, 200);
    assert.deepEqual(await held(), { "111": A, "222": B });
  });

  it("A SAVE THAT DOES NOT CARRY THE TOKEN ASKS NOTHING — even for an account whose bot is held elsewhere", async () => {
    await put(A, { telegramBotToken: "111:AAA-first-secret" });
    await getSettingsStore().put(B, { telegramBotToken: "111:BBB-from-before-claims" });
    const res = await put(B, { telegramEnabled: true, buyPerTickUsdg: 5 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(await held(), { "111": A });
  });
});
