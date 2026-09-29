/**
 * WHAT THE BOT CAN HEAR IN A GROUP, FROM THE getMe THE ROUTE ALREADY MAKES.
 *
 * docs/tg-groups.md "What it can hear: privacy mode": with BotFather privacy
 * mode on (the default) a bot in a group hears only commands and replies to
 * itself, so it cannot join in, remember the chat or see a posted coin. getMe
 * says which — `can_read_all_group_messages` — and the Settings screen and the
 * phone's Telegram screen show the steps and the verdict from it.
 *
 * The property that matters most is the THIRD state. A getMe that failed, or
 * answered without the field, is UNKNOWN — the screens then show the steps
 * without a verdict — and must never read as "privacy mode is on", which comes
 * with instructions an owner would follow for nothing.
 *
 * Driven through the real GET, self-hosted (the settings file IS the store),
 * with the Bot API answered by a stub: no request leaves the machine.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type { TelegramStatus } from "./route";

const TOKEN = "123456:TEST-token-for-a-stub-only";
const saved = { home: process.env.MERRYMEN_HOME, hosted: process.env.MERRYMEN_HOSTED };
const realFetch = globalThis.fetch;
let home: string;
let GET: (req: Request) => Promise<Response>;
let POST: (req: Request) => Promise<Response>;
/** What the stubbed getMe answers next; a function so a test can throw. */
let getMe: () => unknown = () => ({ ok: false });
let calls: string[] = [];

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-telegram-group-flags-"));
  process.env.MERRYMEN_HOME = home;
  delete process.env.MERRYMEN_HOSTED;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (!url.startsWith("https://api.telegram.org/")) throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify(getMe()), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  // After the env: the route resolves its paths when it loads.
  ({ GET, POST } = await import("./route"));
});
after(() => {
  globalThis.fetch = realFetch;
  for (const [key, value] of [["MERRYMEN_HOME", saved.home], ["MERRYMEN_HOSTED", saved.hosted]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
beforeEach(() => {
  calls = [];
  writeFileSync(path.join(home, "settings.json"), JSON.stringify({ telegramBotToken: TOKEN, telegramEnabled: true }));
});

const status = async () => (await (await GET(new Request("http://localhost/api/telegram"))).json()) as TelegramStatus;
const me = (extra: Record<string, unknown>) => () => ({ ok: true, result: { id: 1, is_bot: true, username: "pine_merry_bot", ...extra } });

describe("GET /api/telegram — the privacy-mode flag", () => {
  it("privacy OFF: canReadAllGroupMessages is true, from the same single getMe", async () => {
    getMe = me({ can_read_all_group_messages: true, can_join_groups: true });
    const s = await status();
    assert.equal(s.connected, true);
    assert.equal(s.botUsername, "pine_merry_bot");
    assert.equal(s.canReadAllGroupMessages, true);
    assert.equal(s.canJoinGroups, true);
    assert.equal(calls.length, 1, "one getMe per status, not one per field");
    assert.ok(calls[0]!.endsWith("/getMe"));
  });

  it("privacy ON (the BotFather default): false, which is what shows the steps", async () => {
    getMe = me({ can_read_all_group_messages: false, can_join_groups: true });
    const s = await status();
    assert.equal(s.canReadAllGroupMessages, false);
    assert.equal(s.canJoinGroups, true);
  });

  it("joining groups switched off in BotFather reads as canJoinGroups false", async () => {
    getMe = me({ can_read_all_group_messages: false, can_join_groups: false });
    assert.equal((await status()).canJoinGroups, false);
  });

  it("A getMe THAT DID NOT SAY IS UNKNOWN, NOT 'ON'", async () => {
    // Missing, or not a real boolean: null. A string "false" is not Telegram
    // saying false.
    for (const extra of [{}, { can_read_all_group_messages: "false", can_join_groups: 0 }, { can_read_all_group_messages: null }]) {
      getMe = me(extra);
      const s = await status();
      assert.equal(s.connected, true, JSON.stringify(extra));
      assert.equal(s.canReadAllGroupMessages, null, JSON.stringify(extra));
      assert.equal(s.canJoinGroups, null, JSON.stringify(extra));
    }
  });

  it("a rejected token or an unreachable Telegram is unknown too, and not connected", async () => {
    for (const answer of [() => ({ ok: false, description: "Unauthorized" }), () => ({ ok: true, result: {} }), () => { throw new Error("offline"); }]) {
      getMe = answer;
      const s = await status();
      assert.equal(s.connected, false);
      assert.equal(s.botUsername, null);
      assert.equal(s.canReadAllGroupMessages, null);
      assert.equal(s.canJoinGroups, null);
    }
  });

  it("no token: no getMe at all, and the flags are unknown", async () => {
    writeFileSync(path.join(home, "settings.json"), JSON.stringify({}));
    getMe = me({ can_read_all_group_messages: true });
    const s = await status();
    assert.equal(calls.length, 0, "no token, no call to Telegram");
    assert.equal(s.hasToken, false);
    assert.equal(s.canReadAllGroupMessages, null);
    assert.equal(s.canJoinGroups, null);
  });

  it("the token still never reaches the answer", async () => {
    getMe = me({ can_read_all_group_messages: true, can_join_groups: true });
    const raw = JSON.stringify(await status());
    assert.equal(raw.includes(TOKEN), false);
    assert.equal(raw.includes("TEST-token"), false);
  });
});

describe("POST /api/telegram {action:'test'} is unchanged", () => {
  it("still answers with the username alone", async () => {
    getMe = me({ can_read_all_group_messages: true, can_join_groups: true });
    const res = await POST(new Request("http://localhost/api/telegram", { method: "POST", body: JSON.stringify({ action: "test" }) }));
    assert.deepEqual(await res.json(), { ok: true, username: "pine_merry_bot" });
  });

  it("and a getMe with no username is still a rejected token", async () => {
    getMe = () => ({ ok: true, result: { can_read_all_group_messages: true } });
    const res = await POST(new Request("http://localhost/api/telegram", { method: "POST", body: JSON.stringify({ action: "test" }) }));
    assert.deepEqual(await res.json(), { ok: false, reason: "token rejected by Telegram (getMe failed)" });
  });
});
