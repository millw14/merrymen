import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOT_COMMANDS, esc, getMe, getUpdates, sendMessage, setMyCommands, type FetchLike } from "./api";
import { parseSlash } from "./interpreter";

/** Fake fetch capturing the last call, returning a canned envelope. */
function fakeFetch(status: number, body: unknown): FetchLike & { lastUrl?: string; lastBody?: string } {
  const f: FetchLike & { lastUrl?: string; lastBody?: string } = async (url, init) => {
    f.lastUrl = url;
    f.lastBody = init?.body;
    return { ok: status < 400, status, json: async () => body };
  };
  return f;
}

const OK = (result: unknown) => ({ ok: true, result });

describe("getMe", () => {
  it("returns the bot identity on a valid token", async () => {
    const f = fakeFetch(200, OK({ id: 42, username: "merryman_bot", is_bot: true }));
    const { bot, reason } = await getMe({ token: "123:abc", fetchFn: f });
    assert.equal(reason, undefined);
    assert.deepEqual(bot, { id: 42, username: "merryman_bot" });
    assert.match(f.lastUrl!, /\/bot123:abc\/getMe$/);
  });

  it("degrades on ok:false (bad token)", async () => {
    const f = fakeFetch(200, { ok: false, description: "Unauthorized" });
    const { bot, reason } = await getMe({ token: "bad", fetchFn: f });
    assert.equal(bot, null);
    assert.match(reason!, /Unauthorized/);
  });

  it("degrades on a network throw, never throws", async () => {
    const boom: FetchLike = async () => {
      throw new Error("ENOTFOUND");
    };
    const { bot, reason } = await getMe({ token: "x", fetchFn: boom });
    assert.equal(bot, null);
    assert.match(reason!, /ENOTFOUND/);
  });
});

describe("getUpdates", () => {
  it("extracts text messages and advances the offset", async () => {
    const f = fakeFetch(
      200,
      OK([
        {
          update_id: 100,
          message: { text: "/status", chat: { id: 555 }, from: { id: 555, username: "alice" } },
        },
        {
          update_id: 101,
          message: { text: "hi", chat: { id: 555 }, from: { id: 555 } },
        },
      ]),
    );
    const { messages, nextOffset } = await getUpdates({ token: "t", fetchFn: f }, 100);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]!.text, "/status");
    assert.equal(messages[0]!.chatId, 555);
    assert.equal(messages[0]!.fromUsername, "alice");
    assert.equal(nextOffset, 102); // max update_id + 1
    // request carries offset in the POST body
    assert.match(f.lastBody!, /"offset":100/);
  });

  it("ignores non-text updates (photos, joins) but still advances offset", async () => {
    const f = fakeFetch(
      200,
      OK([
        { update_id: 5, message: { chat: { id: 1 }, from: { id: 1 }, photo: [{}] } },
        { update_id: 6, edited_message: { text: "edit", chat: { id: 1 } } },
      ]),
    );
    const { messages, nextOffset } = await getUpdates({ token: "t", fetchFn: f }, 5);
    assert.deepEqual(messages, []);
    assert.equal(nextOffset, 7);
  });

  it("degrades to empty on error, keeping the offset", async () => {
    const f = fakeFetch(200, { ok: false, description: "flood" });
    const { messages, nextOffset, reason } = await getUpdates({ token: "t", fetchFn: f }, 9);
    assert.deepEqual(messages, []);
    assert.equal(nextOffset, 9);
    assert.match(reason!, /flood/);
  });
});

describe("sendMessage", () => {
  it("POSTs chat_id + text and reports ok", async () => {
    const f = fakeFetch(200, OK({ message_id: 1 }));
    const { ok } = await sendMessage({ token: "t", fetchFn: f }, 777, "the band rides");
    assert.equal(ok, true);
    assert.match(f.lastBody!, /"chat_id":777/);
    assert.match(f.lastBody!, /the band rides/);
  });

  it("truncates over-long text to Telegram's 4096 limit", async () => {
    const f = fakeFetch(200, OK({ message_id: 1 }));
    await sendMessage({ token: "t", fetchFn: f }, 1, "x".repeat(5000));
    const parsed = JSON.parse(f.lastBody!) as { text: string };
    assert.ok(parsed.text.length <= 4096);
  });

  it("reports failure without throwing", async () => {
    const f = fakeFetch(200, { ok: false, description: "chat not found" });
    const { ok, reason } = await sendMessage({ token: "t", fetchFn: f }, 1, "hi");
    assert.equal(ok, false);
    assert.match(reason!, /chat not found/);
  });

  it("sends with HTML parse mode so <b>/<code> render", async () => {
    const f = fakeFetch(200, OK({ message_id: 1 }));
    await sendMessage({ token: "t", fetchFn: f }, 1, "<b>bold</b>");
    assert.match(f.lastBody!, /"parse_mode":"HTML"/);
  });

  it("retries as plain text when Telegram rejects the entities — a reply is never lost", async () => {
    const bodies: string[] = [];
    let call = 0;
    const f: FetchLike = async (_url, init) => {
      bodies.push(init?.body ?? "");
      call += 1;
      return {
        ok: true,
        status: 200,
        json: async () =>
          call === 1 ? { ok: false, description: "Bad Request: can't parse entities" } : OK({ message_id: 2 }),
      };
    };
    const { ok } = await sendMessage({ token: "t", fetchFn: f }, 1, "<b>broken <tag");
    assert.equal(ok, true);
    assert.equal(bodies.length, 2);
    assert.ok(!bodies[1]!.includes("parse_mode")); // second attempt is plain
  });
});

describe("esc — HTML escaping for user-echoed content", () => {
  it("escapes the three HTML-significant characters", () => {
    assert.equal(esc("<script>&x</script>"), "&lt;script&gt;&amp;x&lt;/script&gt;");
    assert.equal(esc("plain text"), "plain text");
  });
});

describe("BOT_COMMANDS — the Telegram command menu", () => {
  it("is a non-empty, valid Telegram BotCommand list", () => {
    assert.ok(BOT_COMMANDS.length > 0);
    const seen = new Set<string>();
    for (const { command, description } of BOT_COMMANDS) {
      // command: 1-32 lowercase alnum/underscore, no leading slash, unique
      assert.match(command, /^[a-z][a-z0-9_]{0,31}$/);
      assert.ok(!command.startsWith("/"));
      assert.equal(seen.has(command), false, `duplicate command /${command}`);
      seen.add(command);
      // description: plain text, non-empty, within Telegram's 256-char cap
      assert.ok(description.length > 0 && description.length <= 256);
      assert.ok(!description.includes("<"), `description for /${command} must be plain text`);
    }
  });
});

describe("setMyCommands", () => {
  it("posts the command list to /bot<token>/setMyCommands and returns ok", async () => {
    const f = fakeFetch(200, OK(true));
    const { ok, reason } = await setMyCommands({ token: "123:abc", fetchFn: f });
    assert.equal(reason, undefined);
    assert.equal(ok, true);
    assert.match(f.lastUrl!, /\/bot123:abc\/setMyCommands$/);
    const body = JSON.parse(f.lastBody!) as { commands: unknown };
    assert.deepEqual(body.commands, BOT_COMMANDS);
  });

  it("omits the scope when none is given", async () => {
    const f = fakeFetch(200, OK(true));
    await setMyCommands({ token: "123:abc", fetchFn: f });
    const body = JSON.parse(f.lastBody!) as { scope?: unknown };
    assert.equal(body.scope, undefined);
  });

  it("sends the scope when one is given", async () => {
    const f = fakeFetch(200, OK(true));
    await setMyCommands({ token: "123:abc", fetchFn: f }, undefined, { type: "all_private_chats" });
    const body = JSON.parse(f.lastBody!) as { scope?: unknown };
    assert.deepEqual(body.scope, { type: "all_private_chats" });
  });

  it("degrades gracefully on ok:false (bad token or unsupported)", async () => {
    const f = fakeFetch(200, { ok: false, description: "Unauthorized" });
    const { ok, reason } = await setMyCommands({ token: "bad", fetchFn: f });
    assert.equal(ok, false);
    assert.match(reason!, /Unauthorized/);
  });
});

describe("BOT_COMMANDS — every menu entry is a real command", () => {
  it("parses each entry through parseSlash without hitting the unknown branch", () => {
    for (const { command } of BOT_COMMANDS) {
      // /agent is routed before parseSlash (a dedicated match in service.ts), so
      // parseSlash correctly reports it as unknown — it's still a real command.
      if (command === "agent") continue;
      const parsed = parseSlash(`/${command}`);
      assert.ok(parsed, `/${command} should parse`);
      if (parsed.kind === "unknown") {
        assert.ok(!/^unknown command/.test(parsed.text), `/${command} hit the unknown branch`);
      }
    }
  });

  it("includes /kill for parity with /help and CONTROL_KINDS", () => {
    assert.ok(BOT_COMMANDS.some(({ command }) => command === "kill"));
  });
});
