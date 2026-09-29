/**
 * WHAT THE DASHBOARD MAY SAY ABOUT THE OWNER'S BOT, AND WHICH CODE IT MAY SHOW
 * (plan §3.1).
 *
 * In the incident behind this, the Telegram panel said "connected" and showed
 * the code NTE49D for days in which nothing polled the bot, and by the end
 * the bot answered to another agent's code. The owner sent NTE49D five times
 * and was locked out. Every case below is one of the things that page said
 * that it could not have known, written out.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LIVE_WITHIN_SEC, heldClass, telegramListening, type TelegramRuntime } from "./telegram-listening";

const NOW = 1_790_000_000;
const TOKEN = "111:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
const row = (over: Partial<TelegramRuntime> = {}): TelegramRuntime => ({
  linkCode: "K7M2QX",
  ownerId: null,
  botId: "111",
  pollOkAt: NOW - 20,
  pollErr: null,
  pollErrAt: null,
  childState: "trading",
  ...over,
});

describe("listening", () => {
  it("live when a poll of this bot worked within three minutes", () => {
    const r = telegramListening(row(), TOKEN, NOW);
    assert.deepEqual(r.listening, { state: "live", lastOkAt: NOW - 20, reason: null });
    assert.equal(telegramListening(row({ pollOkAt: NOW - LIVE_WITHIN_SEC }), TOKEN, NOW).listening.state, "live");
  });

  it("A STALE POLL IS NOT-LISTENING, whatever getMe says", () => {
    const r = telegramListening(row({ pollOkAt: NOW - 3 * 86_400 }), TOKEN, NOW);
    assert.deepEqual(r.listening, { state: "not-listening", lastOkAt: NOW - 3 * 86_400, reason: null });
    // With the failure that is going on, when there is one.
    const failing = telegramListening(row({ pollOkAt: NOW - 3_600, pollErr: "failed: HTTP 502", pollErrAt: NOW - 10 }), TOKEN, NOW);
    assert.deepEqual(failing.listening, { state: "not-listening", lastOkAt: NOW - 3_600, reason: "HTTP 502" });
  });

  it("a refused token is revoked, and a 409 is a conflict: the owner's two remedies", () => {
    const revoked = telegramListening(row({ pollOkAt: NOW - 3_600, pollErr: "refused: 401 Unauthorized", pollErrAt: NOW - 30 }), TOKEN, NOW);
    assert.deepEqual(revoked.listening, { state: "revoked", lastOkAt: NOW - 3_600, reason: "401 Unauthorized" });
    const conflict = telegramListening(
      row({ pollOkAt: NOW - 25, pollErr: "conflict: another program is reading this bot's updates (409)", pollErrAt: NOW - 5 }),
      TOKEN,
      NOW,
    );
    assert.equal(conflict.listening.state, "conflict");
    assert.equal(conflict.listening.reason, "another program is reading this bot's updates (409)");
  });

  it("A FAILURE A LATER POLL OVERTOOK SAYS NOTHING ABOUT NOW", () => {
    // One 409 while a redeploy hands over, then polls that work: live, not a
    // warning that sends the owner looking for a program that is not there.
    const r = telegramListening(
      row({ pollOkAt: NOW - 20, pollErr: "conflict: another program is reading this bot's updates (409)", pollErrAt: NOW - 90 }),
      TOKEN,
      NOW,
    );
    assert.equal(r.listening.state, "live");
  });

  it("A HELD TENANT IS HELD, with its reason class", () => {
    const r = telegramListening(row({ childState: "held:trades newer than the last valuation" }), TOKEN, NOW);
    assert.deepEqual(r.listening, { state: "held", lastOkAt: NOW - 20, reason: "trades newer than the last valuation" });
    // The hold process links chats, so the code stays.
    assert.equal(r.linkCode, "K7M2QX");
    assert.equal(heldClass("held:"), "restore error", "a class that went missing still reads as held");
    assert.equal(heldClass("trading"), null);
  });

  it("but a held tenant whose bot nothing hears is reported as the bot's state: that is what the owner can act on", () => {
    const r = telegramListening(row({ childState: "held:the saved book is unreadable", pollOkAt: NOW - 86_400 }), TOKEN, NOW);
    assert.equal(r.listening.state, "not-listening");
  });

  it("unknown is not a verdict: nothing polled yet, no row, or a deployment that does not publish these", () => {
    assert.equal(telegramListening(row({ pollOkAt: null }), TOKEN, NOW).listening.state, "unknown");
    assert.deepEqual(telegramListening(null, TOKEN, NOW), {
      listening: { state: "unknown", lastOkAt: null, reason: null },
      linkCode: null,
      linkPending: false,
    });
  });
});

describe("the code belongs to a bot", () => {
  it("A BOT ID THAT DOES NOT MATCH THE SAVED TOKEN NULLS THE CODE, and says the agent has not picked the bot up", () => {
    // The owner saved a new bot; the code on file was minted for the old one,
    // and the worker re-mints on a change of bot. Showing it is how a dead
    // code gets sent into a live bot.
    const r = telegramListening(row({ botId: "999" }), TOKEN, NOW);
    assert.equal(r.linkCode, null);
    assert.equal(r.linkPending, true);
    // And what was heard on the old bot says nothing about this one.
    assert.equal(r.listening.state, "unknown");
  });

  it("no bot bound yet (a home restored after a redeploy, not yet polled) is pending too", () => {
    const r = telegramListening(row({ botId: null, pollOkAt: null }), TOKEN, NOW);
    assert.equal(r.linkCode, null);
    assert.equal(r.linkPending, true);
  });

  it("the id is the number before the ':' and nothing else of the token", () => {
    assert.equal(telegramListening(row(), "0111:other-secret", NOW).linkCode, "K7M2QX");
    assert.equal(telegramListening(row(), `  ${TOKEN}  `, NOW).linkCode, "K7M2QX", "a saved token with spaces round it");
  });

  it("no usable token: no code, and nothing pending", () => {
    for (const token of [undefined, null, "", "not-a-token", "111:has/slash"]) {
      const r = telegramListening(row(), token, NOW);
      assert.equal(r.linkCode, null, String(token));
      assert.equal(r.linkPending, false, String(token));
    }
  });

  it("THE CODE STAYS VISIBLE WHILE THE BOT IS NOT HEARD: it works once it is", () => {
    const r = telegramListening(row({ pollOkAt: NOW - 86_400 }), TOKEN, NOW);
    assert.equal(r.listening.state, "not-listening");
    assert.equal(r.linkCode, "K7M2QX");
  });

  it("A DEPLOYMENT THAT DOES NOT PUBLISH THE BOT YET shows the code as it always did", () => {
    // The web can be deployed before the orchestrator adds the columns; a
    // missing column must not take every tenant's code away.
    const legacy: TelegramRuntime = { linkCode: "K7M2QX", ownerId: null };
    assert.deepEqual(telegramListening(legacy, TOKEN, NOW), {
      listening: { state: "unknown", lastOkAt: null, reason: null },
      linkCode: "K7M2QX",
      linkPending: false,
    });
  });

  it("never puts the token in a reason", () => {
    const r = telegramListening(row({ pollOkAt: NOW - 3_600, pollErr: "failed: request failed: bot<token>/getUpdates", pollErrAt: NOW }), TOKEN, NOW);
    assert.ok(!JSON.stringify(r).includes("AAHdq"));
  });
});
