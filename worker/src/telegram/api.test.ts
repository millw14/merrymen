import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { answerCallbackQuery, editMessageText, esc, getMe, getUpdates, sendMessage, type FetchLike } from "./api";

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
    // request carries offset AND subscribes to callback queries in the POST body
    assert.match(f.lastBody!, /"offset":100/);
    assert.match(f.lastBody!, /"callback_query"/);
  });

  it("extracts callback_query taps (inline buttons) into callbacks", async () => {
    const f = fakeFetch(
      200,
      OK([
        {
          update_id: 201,
          callback_query: {
            id: "q1",
            from: { id: 777 },
            message: { chat: { id: 555 }, message_id: 42 },
            data: "confirm",
          },
        },
        { update_id: 202, message: { text: "/status", chat: { id: 555 }, from: { id: 555 } } },
      ]),
    );
    const { messages, callbacks, nextOffset } = await getUpdates({ token: "t", fetchFn: f }, 201);
    assert.equal(callbacks.length, 1);
    assert.deepEqual(callbacks[0], {
      updateId: 201,
      chatId: 555,
      fromId: 777,
      messageId: 42,
      data: "confirm",
      queryId: "q1",
    });
    assert.equal(messages.length, 1); // message updates still parsed alongside
    assert.equal(nextOffset, 203);
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

  it("attaches an inline keyboard (confirm/cancel) when markup is given", async () => {
    const f = fakeFetch(200, OK({ message_id: 3 }));
    const markup = {
      inline_keyboard: [[{ text: "✅ Confirm", callback_data: "confirm" }, { text: "✖ Cancel", callback_data: "cancel" }]],
    };
    const { ok } = await sendMessage({ token: "t", fetchFn: f }, 777, "confirm?", markup);
    assert.equal(ok, true);
    const parsed = JSON.parse(f.lastBody!) as { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } };
    assert.equal(parsed.reply_markup.inline_keyboard[0]![0]!.callback_data, "confirm");
    assert.equal(parsed.reply_markup.inline_keyboard[0]![1]!.callback_data, "cancel");
  });
});

describe("editMessageText — in-place resolution of a parked confirm", () => {
  it("replaces the message and clears the inline keyboard", async () => {
    const f = fakeFetch(200, OK({ message_id: 42 }));
    const { ok } = await editMessageText({ token: "t", fetchFn: f }, 777, 42, "done ✓");
    assert.equal(ok, true);
    const parsed = JSON.parse(f.lastBody!) as { chat_id: number; message_id: number; text: string; reply_markup: { inline_keyboard: unknown[] } };
    assert.equal(parsed.chat_id, 777);
    assert.equal(parsed.message_id, 42);
    assert.equal(parsed.text, "done ✓");
    assert.deepEqual(parsed.reply_markup.inline_keyboard, []); // buttons removed
  });

  it("retries as plain text when the HTML entities are rejected", async () => {
    let call = 0;
    const f: FetchLike = async () => {
      call += 1;
      return {
        ok: true,
        status: 200,
        json: async () => (call === 1 ? { ok: false, description: "can't parse entities: <b>" } : OK(true)),
      };
    };
    const { ok } = await editMessageText({ token: "t", fetchFn: f }, 1, 1, "<b>bold</b>");
    assert.equal(ok, true);
    assert.equal(call, 2);
  });
});

describe("answerCallbackQuery", () => {
  it("acknowledges the tap with the callback_query_id", async () => {
    const f = fakeFetch(200, OK(true));
    const { ok } = await answerCallbackQuery({ token: "t", fetchFn: f }, "q1", { text: "Confirmed ✓" });
    assert.equal(ok, true);
    assert.match(f.lastBody!, /"callback_query_id":"q1"/);
    assert.match(f.lastBody!, /Confirmed/);
  });

  it("degrades on a network throw, never throws", async () => {
    const boom: FetchLike = async () => {
      throw new Error("ECONNRESET");
    };
    const { ok, reason } = await answerCallbackQuery({ token: "t", fetchFn: boom }, "q1");
    assert.equal(ok, false);
    assert.match(reason!, /ECONNRESET/);
  });
});

describe("esc — HTML escaping for user-echoed content", () => {
  it("escapes the three HTML-significant characters", () => {
    assert.equal(esc("<script>&x</script>"), "&lt;script&gt;&amp;x&lt;/script&gt;");
    assert.equal(esc("plain text"), "plain text");
  });
});
