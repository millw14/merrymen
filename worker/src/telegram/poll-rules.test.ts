/**
 * WHAT A FAILED POLL LEAVES BEHIND, AND WHAT THE LOG SAYS ABOUT STRANGERS.
 *
 * Both were missing in the incident behind plan §1.4 and P5. Nothing recorded
 * whether the owner's bot was being heard, so the dashboard said "connected"
 * for days in which nothing polled it. And an owner's chat was refused a
 * day's messages and locked out of /link without one line in any log saying
 * so. These are the pieces the child and the hold process share
 * (poll-rules.ts), run directly.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeChatTally, pollErrKind, pollErrText, pollFailure, redactChat } from "./poll-rules";

describe("a failed poll, as it is kept and published", () => {
  it("names its kind first, so the dashboard and the orchestrator need not parse prose", () => {
    assert.equal(pollFailure({ errorCode: 409, reason: "Conflict: terminated by other getUpdates request" }, 1).err,
      "conflict: another program is reading this bot's updates (409)");
    assert.equal(pollFailure({ errorCode: 409, reason: "Conflict: can't use getUpdates method while webhook is active" }, 1).err,
      "conflict: this bot has a webhook set (409)");
    assert.equal(pollFailure({ errorCode: 401, reason: "Unauthorized" }, 1).err, "refused: 401 Unauthorized");
    assert.equal(pollFailure({ reason: "request timed out after 35s" }, 3).err, "failed: request timed out after 35s");
    for (const r of [{ errorCode: 409 }, { errorCode: 404 }, { errorCode: 502 }, {}]) {
      const f = pollFailure(r, 1);
      assert.equal(pollErrKind(f.err), f.kind);
    }
  });

  it("NEVER CARRIES THE TOKEN: it leaves the home for the shared database and the dashboard", () => {
    // Telegram's own descriptions never hold it, but a transport error names
    // the URL it was asking, and the token is in that URL's path.
    const err = pollErrText(
      "failed",
      "request failed: Failed to parse URL from https://api.telegram.org/bot8123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/getUpdates",
    );
    assert.ok(!err.includes("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"), err);
    assert.match(err, /bot<token>\/getUpdates/);
    assert.ok(!pollErrText("failed", "8123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw").includes("AAHdq"));
  });

  it("is one clipped line", () => {
    const err = pollErrText("failed", `<html>\n${"x".repeat(500)}\n</html>`);
    assert.ok(err.length <= 160);
    assert.ok(!/[\n\r]/.test(err));
    assert.equal(pollErrText("failed", "   "), "failed: unknown error");
  });

  it("reads back only the three kinds it writes", () => {
    assert.equal(pollErrKind("conflict: x"), "conflict");
    assert.equal(pollErrKind("refused: 401 Unauthorized"), "refused");
    assert.equal(pollErrKind("failed: x"), "failed");
    for (const junk of [null, undefined, "", "conflict", "conflictX: y", ": conflict", "revoked: x"]) {
      assert.equal(pollErrKind(junk), null, String(junk));
    }
  });
});

describe("what the log says about strangers, codes and lost replies", () => {
  const rig = () => {
    const lines: { level: string; message: string }[] = [];
    let t = 1_790_000_000;
    const tally = makeChatTally((level, message) => lines.push({ level, message }), () => t);
    return { tally, lines, at: (s: number) => { t = s; } };
  };

  it("A CHAT ID IS CUT TO ITS LAST FOUR DIGITS", () => {
    assert.equal(redactChat(123456789), "…6789");
    assert.equal(redactChat(-1001234567890), "…7890", "a group's minus sign is not a digit");
    const { tally, lines } = rig();
    tally.refused(123456789);
    tally.linkFailed(123456789, { locked: false, justLocked: false });
    tally.sendFailed(123456789, "Forbidden: bot was blocked by the user");
    assert.equal(lines.length, 3);
    for (const l of lines) {
      assert.ok(!l.message.includes("123456789"), l.message);
      assert.match(l.message, /…6789/);
    }
  });

  it("counts every refusal and logs the 1st, 2nd, 4th, 8th …: a stranger hammering the bot costs a handful of lines", () => {
    const { tally, lines } = rig();
    for (let i = 0; i < 100; i++) tally.refused(555_0001);
    assert.deepEqual(
      lines.map((l) => /\((\d+) so far\)/.exec(l.message)?.[1]),
      ["1", "2", "4", "8", "16", "32", "64"],
    );
    // Per chat: another chat starts its own count.
    tally.refused(666_0002);
    assert.match(lines.at(-1)!.message, /…0002 refused \(1 so far\)/);
  });

  it("A LOCKOUT IS ALWAYS LOGGED, with until when", () => {
    // The one an owner asks about: in the incident, five stale codes locked
    // the owner out, and nothing said so.
    const { tally, lines } = rig();
    for (let i = 1; i <= 4; i++) tally.linkFailed(4242, { locked: false, justLocked: false });
    tally.linkFailed(4242, { locked: false, justLocked: true, lockedUntil: Date.parse("2026-09-22T14:46:00Z") / 1000 });
    const last = lines.at(-1)!;
    assert.equal(last.level, "warn");
    assert.equal(last.message, "Telegram: chat …4242 locked out of /link until 14:46 UTC after 5 failed code(s)");
    assert.deepEqual(
      lines.slice(0, -1).map((l) => l.message),
      [
        "Telegram: /link from chat …4242 failed (wrong code) — 1 so far",
        "Telegram: /link from chat …4242 failed (wrong code) — 2 so far",
        "Telegram: /link from chat …4242 failed (wrong code) — 4 so far",
      ],
    );
  });

  it("a reply Telegram would not take is logged once an hour per chat and reason", () => {
    const { tally, lines, at } = rig();
    tally.sendFailed(4242, "Forbidden: bot was blocked by the user");
    tally.sendFailed(4242, "Forbidden: bot was blocked by the user");
    tally.sendFailed(4242, "Bad Request: message is too long");
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!.message, "Telegram: a reply to chat …4242 was not delivered — Forbidden: bot was blocked by the user");
    at(1_790_000_000 + 3_600);
    tally.sendFailed(4242, "Forbidden: bot was blocked by the user");
    assert.equal(lines.length, 3);
  });
});
