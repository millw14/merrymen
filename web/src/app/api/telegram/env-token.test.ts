/**
 * A SELF-HOSTED BOT CONFIGURED BY ENVIRONMENT STILL SHOWS ITS LINK CODE.
 *
 * README documents MERRYMEN_TELEGRAM_BOT_TOKEN, and the worker falls back to
 * it when settings.json has no token (worker/src/settings.ts str()). The
 * worker binds that bot and writes its id beside the code in telegram.json.
 * This route read the token from settings.json alone, so for such an install
 * there was no saved bot to hold the code against, and the code was hidden as
 * one minted for another bot on every screen, while the CLI doctor sent the
 * owner to the dashboard to find it.
 *
 * Driven through the real GET, self-hosted (the files ARE the store), with
 * getMe a stub. Hosted never reads the variable: bot-elsewhere.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type { TelegramStatus } from "./route";

const KEYS = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_TELEGRAM_BOT_TOKEN"] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
const ENV_TOKEN = "111:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
let home: string;
let GET: (req: Request) => Promise<Response>;
let POST: (req: Request) => Promise<Response>;
let asked: string[] = [];

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "merrymen-telegram-env-token-"));
  process.env.MERRYMEN_HOME = home;
  delete process.env.MERRYMEN_HOSTED;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const m = /^https:\/\/api\.telegram\.org\/bot(.+)\/getMe$/.exec(url);
    if (!m) throw new Error(`unexpected fetch ${url}`);
    asked.push(m[1]!);
    const id = Number(m[1]!.split(":")[0]);
    return Response.json({ ok: true, result: { id, is_bot: true, username: `bot${id}` } });
  }) as typeof fetch;
  // After the env: the route resolves its paths when it loads.
  ({ GET, POST } = await import("./route"));
});
beforeEach(() => {
  asked = [];
  process.env.MERRYMEN_TELEGRAM_BOT_TOKEN = ENV_TOKEN;
  writeFileSync(path.join(home, "settings.json"), JSON.stringify({ telegramEnabled: true }));
  // What the worker writes once it has bound the environment's bot.
  writeFileSync(path.join(home, "telegram.json"), JSON.stringify({ botId: "111", linkCode: "ABCDEF", ownerId: null }));
});
after(() => {
  globalThis.fetch = realFetch;
  for (const k of KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const status = async () => (await (await GET(new Request("http://localhost/api/telegram"))).json()) as TelegramStatus;

describe("GET /api/telegram, self-hosted, token from the environment", () => {
  it("THE CODE THE WORKER MINTED FOR THE ENVIRONMENT'S BOT IS SHOWN", async () => {
    const s = await status();
    assert.equal(s.linkCode, "ABCDEF");
    assert.equal(s.linkPending, false);
    assert.equal(s.hasToken, true);
    assert.equal(s.connected, true, "the same token the worker polls with is the one getMe is asked about");
    assert.equal(s.botUsername, "bot111");
    assert.deepEqual(asked, [ENV_TOKEN]);
  });

  it("a blank saved token falls back to the environment, as the worker's does", async () => {
    writeFileSync(path.join(home, "settings.json"), JSON.stringify({ telegramEnabled: true, telegramBotToken: "   " }));
    assert.equal((await status()).linkCode, "ABCDEF");
  });

  it("a saved token wins over the environment, as it does in the worker", async () => {
    writeFileSync(path.join(home, "settings.json"), JSON.stringify({ telegramEnabled: true, telegramBotToken: "222:saved-secret" }));
    const s = await status();
    assert.equal(s.linkCode, null, "the code on file is the environment bot's, not the saved one's");
    assert.equal(s.linkPending, true);
    assert.deepEqual(asked, ["222:saved-secret"]);
  });

  it("an environment token for another bot than the one on file shows no code: it would not link this one", async () => {
    process.env.MERRYMEN_TELEGRAM_BOT_TOKEN = "  333:other-secret  ";
    const s = await status();
    assert.equal(s.linkCode, null);
    assert.equal(s.linkPending, true);
    assert.deepEqual(asked, ["333:other-secret"], "trimmed, as the worker reads it");
  });

  it("no token anywhere: nothing, and no call to Telegram", async () => {
    delete process.env.MERRYMEN_TELEGRAM_BOT_TOKEN;
    const s = await status();
    assert.equal(s.hasToken, false);
    assert.equal(s.linkCode, null);
    assert.deepEqual(asked, []);
  });

  it("the test button checks the environment's token too, and the token never reaches an answer", async () => {
    const res = await POST(new Request("http://localhost/api/telegram", { method: "POST", body: JSON.stringify({ action: "test" }) }));
    assert.deepEqual(await res.json(), { ok: true, username: "bot111" });
    assert.equal(JSON.stringify(await status()).includes("AAHdqTcv"), false);
  });
});
