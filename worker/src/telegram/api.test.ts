import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, mock } from "node:test";
import {
  BOT_COMMANDS,
  TG_CALL_TIMEOUT_MS,
  answerCallbackQuery,
  editMessageText,
  esc,
  getChatMember,
  getMe,
  getUpdates,
  leaveChat,
  sendChatAction,
  sendDocument,
  sendMessage,
  setMessageReaction,
  setMyCommands,
  publicBotCommands,
  type FetchLike,
} from "./api";
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
    assert.deepEqual(bot, { id: 42, username: "merryman_bot", isBot: true });
    assert.match(f.lastUrl!, /\/bot123:abc\/getMe$/);
  });

  it("says when the answer is not a bot's, so no other method's answer can pass for getMe's", async () => {
    // getChat on a private chat answers {id, username, type}: an id and a
    // username, and no is_bot. A bot claim asks for isBot.
    const f = fakeFetch(200, OK({ id: 111, username: "victimbot", type: "private" }));
    const { bot } = await getMe({ token: "123:abc", fetchFn: f });
    assert.equal(bot?.isBot, false);
  });

  it("NEVER SENDS A TOKEN THAT COULD STEER THE URL, whatever the far end would answer", async () => {
    // Resolved by the URL parser, these become calls on the sender's own bot,
    // or a download of a file they uploaded to it, whose answer carries the
    // id they chose.
    for (const token of [
      "111:x/../../bot222:own/getChat?chat_id=111&z=",
      "111:x/../../file/bot222:own/documents/file_0.json#",
      "111:x?y",
      "111:x#y",
      "111:x%2F..",
      "111:x y",
    ]) {
      const f = fakeFetch(200, OK({ id: 111, username: "victimbot", is_bot: true }));
      const { bot, reason } = await getMe({ token, fetchFn: f });
      assert.equal(bot, null, token);
      assert.match(reason!, /not a bot token/);
      assert.equal(f.lastUrl, undefined, `${token}: nothing was sent`);
    }
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

  it("a refusal carries Telegram's code; no answer carries none, so the two are never confused", async () => {
    const refused = fakeFetch(401, { ok: false, error_code: 401, description: "Unauthorized" });
    assert.deepEqual(await getMe({ token: "123:abc", fetchFn: refused }), { bot: null, reason: "Unauthorized", errorCode: 401 });
    const boom: FetchLike = async () => {
      throw new Error("ECONNRESET");
    };
    assert.deepEqual(await getMe({ token: "123:abc", fetchFn: boom }), { bot: null, reason: "request failed: ECONNRESET" });
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

  it("asks Telegram for button presses and its own membership changes, or they are never delivered", async () => {
    // PINNED ON PURPOSE. Telegram keeps this list server-side, and whatever it
    // leaves out is never delivered. callback_query carries button presses;
    // my_chat_member (added for Telegram groups, docs/tg-groups.md) is how the
    // bot learns it was added to a group, by whom, or removed. edited_message
    // stays out: edits are ignored.
    const f = fakeFetch(200, OK([]));
    await getUpdates({ token: "t", fetchFn: f }, 1);
    assert.match(f.lastBody!, /"allowed_updates":\["message","callback_query","my_chat_member"\]/);
  });

  it("returns a button press as a callback, never as a typed message", async () => {
    const f = fakeFetch(
      200,
      OK([
        {
          update_id: 40,
          callback_query: {
            id: "cbq-1",
            data: "mm:ok:ab12",
            from: { id: 555, username: "alice" },
            message: { message_id: 77, chat: { id: 555 } },
          },
        },
        { update_id: 41, message: { text: "hi", chat: { id: 555 }, from: { id: 555 } } },
      ]),
    );
    const { messages, callbacks, nextOffset } = await getUpdates({ token: "t", fetchFn: f }, 40);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.text, "hi");
    assert.deepEqual(callbacks, [
      { updateId: 40, id: "cbq-1", chatId: 555, fromId: 555, fromUsername: "alice", messageId: 77, data: "mm:ok:ab12", date: 0 },
    ]);
    assert.equal(nextOffset, 42);
  });

  it("drops a press whose message Telegram no longer returns — no chat, no owner to check", async () => {
    const f = fakeFetch(200, OK([{ update_id: 9, callback_query: { id: "x", data: "mm:ok:1", from: { id: 1 } } }]));
    const { messages, callbacks, nextOffset } = await getUpdates({ token: "t", fetchFn: f }, 9);
    assert.deepEqual(messages, []);
    assert.deepEqual(callbacks, []);
    assert.equal(nextOffset, 10);
  });
});

describe("sendMessage — inline buttons", () => {
  it("sends the keyboard in Telegram's wire shape and returns the message id", async () => {
    const f = fakeFetch(200, OK({ message_id: 314 }));
    const r = await sendMessage({ token: "t", fetchFn: f }, 1, "change it?", {
      keyboard: [[{ text: "Yes", callbackData: "mm:ok:1" }, { text: "Sign", url: "https://app.merrymen.dev/grant" }]],
    });
    assert.equal(r.ok, true);
    assert.equal(r.messageId, 314);
    const body = JSON.parse(f.lastBody!) as { reply_markup: { inline_keyboard: unknown[][] } };
    assert.deepEqual(body.reply_markup.inline_keyboard, [
      [
        { text: "Yes", callback_data: "mm:ok:1" },
        { text: "Sign", url: "https://app.merrymen.dev/grant" },
      ],
    ]);
  });

  it("a refused LINK button costs the button, never the message — the link moves into the text", async () => {
    const bodies: string[] = [];
    const f: FetchLike = async (_url, init) => {
      bodies.push(init?.body ?? "");
      const first = bodies.length === 1;
      return {
        ok: true,
        status: 200,
        json: async () =>
          first
            ? { ok: false, description: "Bad Request: inline keyboard button URL 'http://localhost:3100/grant' is invalid" }
            : OK({ message_id: 5 }),
      };
    };
    const r = await sendMessage({ token: "t", fetchFn: f }, 1, "sign please", {
      keyboard: [[{ text: "Sign now", url: "http://localhost:3100/grant" }], [{ text: "Later", callbackData: "mm:no:1" }]],
    });
    assert.equal(r.ok, true);
    assert.equal(bodies.length, 2);
    const retry = JSON.parse(bodies[1]!) as { text: string; reply_markup?: { inline_keyboard: unknown[][] } };
    assert.match(retry.text, /Sign now: http:\/\/localhost:3100\/grant/);
    assert.deepEqual(retry.reply_markup?.inline_keyboard, [[{ text: "Later", callback_data: "mm:no:1" }]]);
  });

  it("does not retry a failure that has nothing to do with the buttons", async () => {
    let calls = 0;
    const f: FetchLike = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ ok: false, description: "Forbidden: bot was blocked by the user" }) };
    };
    const r = await sendMessage({ token: "t", fetchFn: f }, 1, "x", { keyboard: [[{ text: "a", url: "https://x.y" }]] });
    assert.equal(r.ok, false);
    assert.equal(calls, 1);
  });
});

describe("editMessageText + answerCallbackQuery", () => {
  it("edits by chat + message id, and an absent keyboard removes the buttons", async () => {
    const f = fakeFetch(200, OK(true));
    const r = await editMessageText({ token: "t", fetchFn: f }, 12, 34, "✅ done");
    assert.equal(r.ok, true);
    assert.match(f.lastUrl!, /\/editMessageText$/);
    const body = JSON.parse(f.lastBody!) as Record<string, unknown>;
    assert.equal(body.chat_id, 12);
    assert.equal(body.message_id, 34);
    assert.equal(body.reply_markup, undefined);
  });

  it("answers a press with an optional toast", async () => {
    const f = fakeFetch(200, OK(true));
    await answerCallbackQuery({ token: "t", fetchFn: f }, "cbq-9", "changed");
    assert.match(f.lastUrl!, /\/answerCallbackQuery$/);
    assert.deepEqual(JSON.parse(f.lastBody!), { callback_query_id: "cbq-9", text: "changed" });
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

  it("serializes a per-chat scope (full menu pushed to one allowlisted chat)", async () => {
    const f = fakeFetch(200, OK(true));
    await setMyCommands({ token: "123:abc", fetchFn: f }, undefined, { type: "chat", chat_id: -100111 });
    const body = JSON.parse(f.lastBody!) as { commands?: unknown; scope?: { type: string; chat_id?: number } };
    assert.deepEqual(body.commands, BOT_COMMANDS); // no list given → the full owner menu
    assert.deepEqual(body.scope, { type: "chat", chat_id: -100111 });
  });

  it("pushes exactly publicBotCommands when told (the stranger menu)", async () => {
    const f = fakeFetch(200, OK(true));
    await setMyCommands({ token: "123:abc", fetchFn: f }, publicBotCommands, { type: "all_private_chats" });
    const body = JSON.parse(f.lastBody!) as { commands: { command: string }[] };
    assert.deepEqual(body.commands, publicBotCommands);
    assert.ok(!body.commands.some((c) => c.command === "run"));
  });

  it("degrades gracefully on ok:false (bad token or unsupported)", async () => {
    const f = fakeFetch(200, { ok: false, description: "Unauthorized" });
    const { ok, reason } = await setMyCommands({ token: "bad", fetchFn: f });
    assert.equal(ok, false);
    assert.match(reason!, /Unauthorized/);
  });
});

/**
 * Command names parseSlash accepts that we deliberately do NOT advertise in
 * the "/" menu — synonyms and signposts where the canonical entry is listed
 * instead. Explicit on purpose: a NEW command landing in interpreter.ts hits
 * neither list, the reverse-drift test fails, and the author must choose
 * surface-or-hide consciously. This is what caught /depth going missing.
 */
const HIDDEN_ALIASES = new Set([
  "start", // Telegram convention and the deep-link carrier (/start <code>); /help covers the bare form
  "grant", "restore", "recover", "reconnect", "fund", // wallet signpost synonyms
  "book", // positions
  "liquidity", "levels", // depth
  "digest", // report
  "send", "withdraw", // transfer
  "yes", "no", // confirm/cancel
  "config", // settings
  "rename", // name
  "whoareyou", // soul
  "screenshot", "screen", // shot
  "see", // look
  "launch", // open
  "sysinfo", // sys
  "volume", // vol
  "play", "next", "prev", "previous", // media shortcuts
  "toast", // notify
  "dir", // ls
  "getfile", // get
  "sh", "shell", // run
  "hotkey", // key
]);

/** Every `case "x":` label inside parseSlash's switch (source-scraped so a NEW
 * case is caught automatically — the same trick cli/bin.mjs uses on tokens.ts). */
const PARSE_CASES: string[] = (() => {
  const src = readFileSync(new URL("./interpreter.ts", import.meta.url), "utf8");
  const start = src.indexOf("export function parseSlash");
  const end = src.indexOf("LLM front end", start);
  return [...src.slice(start, end).matchAll(/case "([a-z0-9_]+)":/g)]
    .map((m) => m[1])
    .filter((m): m is string => m !== undefined);
})();

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

describe("BOT_COMMANDS — every real command is in the menu (reverse drift)", () => {
  it("scraped a healthy set of parseSlash cases (sanity on the scraper itself)", () => {
    assert.ok(PARSE_CASES.includes("link"), "scraper missed parseSlash cases");
    assert.ok(PARSE_CASES.includes("unwatch"), "scraper truncated early");
    assert.ok(PARSE_CASES.length >= 45, `only ${PARSE_CASES.length} cases scraped`);
  });

  it("every top-level command parseSlash handles is advertised or an explicit hidden alias", () => {
    for (const cmd of PARSE_CASES) {
      const advertised = BOT_COMMANDS.some(({ command }) => command === cmd);
      assert.ok(
        advertised || HIDDEN_ALIASES.has(cmd),
        `/${cmd} parses but is in neither the menu nor HIDDEN_ALIASES — surface it in BOT_COMMANDS or hide it on purpose`,
      );
    }
  });

  it("the hidden-alias allowlist itself cannot rot", () => {
    for (const alias of HIDDEN_ALIASES) {
      assert.ok(
        PARSE_CASES.includes(alias),
        `HIDDEN_ALIASES lists /${alias} but parseSlash no longer handles it — remove the stale entry`,
      );
    }
  });

  it("every hidden alias resolves to a command the menu DOES advertise", () => {
    // An alias is only honest when its canonical entry exists; otherwise both
    // the alias and its meaning are invisible.
    const pairs: Record<string, string> = {
      start: "help", grant: "wallet", restore: "wallet", recover: "wallet",
      reconnect: "wallet", fund: "wallet", book: "positions", liquidity: "depth",
      levels: "depth", digest: "report", send: "transfer", withdraw: "transfer",
      yes: "confirm", no: "cancel", rename: "name", whoareyou: "soul",
      screenshot: "shot", screen: "shot", see: "look", launch: "open",
      sysinfo: "sys", volume: "vol", play: "media", next: "media",
      prev: "media", previous: "media", toast: "notify", dir: "ls",
      getfile: "get", sh: "run", shell: "run", hotkey: "key",
    };
    for (const [alias, canonical] of Object.entries(pairs)) {
      assert.ok(
        BOT_COMMANDS.some(({ command }) => command === canonical),
        `/hidden alias ${alias} points at /${canonical}, which is missing from the menu`,
      );
    }
  });
});

describe("publicBotCommands — what strangers see", () => {
  it("is exactly this safe subset (pinned — additions are a conscious choice)", () => {
    assert.deepEqual(
      publicBotCommands.map((c) => c.command).sort(),
      ["alerts", "brag", "depth", "help", "link", "pnl", "positions", "reminders", "report", "soul", "status", "trades", "wallet", "why"],
    );
  });

  it("never advertises the remote-control surface to strangers", () => {
    const forbidden = [
      "run", "type", "key", "shot", "look", "ls", "open", "sys", "vol", "media",
      "notify", "lock", "sleep", "shutdown", "get", "clip", "pc", "watch",
      "watchers", "unwatch", "agent",
    ];
    for (const c of publicBotCommands) {
      assert.ok(!forbidden.includes(c.command), `/${c.command} leaked into the public menu`);
    }
  });

  it("is strictly smaller than the full owner menu", () => {
    assert.ok(publicBotCommands.length < BOT_COMMANDS.length);
    for (const pub of publicBotCommands) {
      assert.ok(BOT_COMMANDS.includes(pub), `/${pub.command} missing from the full menu`);
    }
  });
});

describe("a refused request keeps Telegram's reason", () => {
  it("reads the description on an HTTP 400, so the plain-text retry actually runs", async () => {
    const bodies: string[] = [];
    const f: FetchLike = async (_url, init) => {
      bodies.push(init?.body ?? "");
      const first = bodies.length === 1;
      return {
        ok: !first,
        status: first ? 400 : 200,
        json: async () => (first ? { ok: false, description: "Bad Request: can't parse entities: unsupported start tag \"$0.01\"" } : OK({ message_id: 9 })),
      };
    };
    const r = await sendMessage({ token: "t", fetchFn: f }, 1, "sold X for <$0.01");
    assert.equal(r.ok, true, "the reply is delivered as plain text, not lost");
    assert.equal(bodies.length, 2);
  });

  it("still says HTTP <code> when there is no body to read", async () => {
    const f: FetchLike = async () => ({ ok: false, status: 502, json: async () => { throw new Error("html"); } });
    const { reason } = await getMe({ token: "t", fetchFn: f });
    assert.match(reason!, /HTTP 502/);
  });
});

describe("every update carries when it was sent", () => {
  it("a message has Telegram's date, and 0 when it came without one", async () => {
    const f = fakeFetch(
      200,
      OK([
        { update_id: 1, message: { text: "/status", date: 1_790_000_000, chat: { id: 5 }, from: { id: 5 } } },
        { update_id: 2, message: { text: "hi", chat: { id: 5 }, from: { id: 5 } } },
      ]),
    );
    const { messages } = await getUpdates({ token: "t", fetchFn: f }, 1);
    assert.deepEqual(
      messages.map((m) => m.date),
      [1_790_000_000, 0],
    );
  });

  it("a press has the date of the message its button sits on, and 0 when Telegram gives none", async () => {
    const press = (id: number, date?: number) => ({
      update_id: id,
      callback_query: {
        id: `cb${id}`,
        data: "mm:ok:1",
        from: { id: 5 },
        message: { message_id: 9, chat: { id: 5 }, ...(date === undefined ? {} : { date }) },
      },
    });
    const f = fakeFetch(200, OK([press(1, 1_790_000_100), press(2), press(3, 0)]));
    const { callbacks } = await getUpdates({ token: "t", fetchFn: f }, 1);
    assert.deepEqual(
      callbacks.map((c) => c.date),
      [1_790_000_100, 0, 0],
    );
  });
});

describe("every request is bounded", () => {
  /** A fetch that records what it was handed and never answers — not even to its signal. */
  const deaf = () => {
    const seen: { signal?: AbortSignal }[] = [];
    const f: FetchLike = (_url, init) => {
      seen.push({ signal: init?.signal });
      return new Promise(() => {});
    };
    return { f, seen };
  };
  const settled = <T>(p: Promise<T>) => {
    const box: { done: boolean; value?: T } = { done: false };
    void p.then((v) => {
      box.done = true;
      box.value = v;
    });
    return box;
  };
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  /**
   * Turn the loop until `ready()` holds. The upload loads node:fs and node:path
   * by dynamic import before it reaches fetch, and on Node 22 under tsx's loader
   * that takes real time, not a count of turns: CI's five were not enough, so
   * the result was read before the upload had even started. Bounded by the real
   * clock (only setTimeout is mocked here) so a state that never comes fails.
   */
  const waitFor = async (ready: () => boolean, what: string) => {
    const t0 = performance.now();
    while (!ready()) {
      if (performance.now() - t0 > 10_000) assert.fail(`never happened: ${what}`);
      await new Promise((r) => setImmediate(r));
    }
  };

  it("hands fetch an AbortSignal, on GET and POST alike", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const f: FetchLike = async (_url, init) => {
      seen.push(init?.signal);
      return { ok: true, status: 200, json: async () => OK({ id: 1, username: "b", message_id: 1 }) };
    };
    await getMe({ token: "1:a", fetchFn: f });
    await getUpdates({ token: "1:a", fetchFn: f }, 0);
    await sendMessage({ token: "1:a", fetchFn: f }, 5, "hi");
    assert.equal(seen.length, 3);
    for (const s of seen) assert.ok(s instanceof AbortSignal, "every call carries a signal");
    assert.ok(seen.every((s) => !s!.aborted), "and a call that answered in time is not aborted");
  });

  it(`a getUpdates that never answers comes back with a reason at its long-poll window plus ${TG_CALL_TIMEOUT_MS / 1000}s — 35s by default`, async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { f, seen } = deaf();
      const r = settled(getUpdates({ token: "1:a", fetchFn: f }, 7));
      mock.timers.tick(34_999);
      await flush();
      assert.equal(r.done, false, "still inside the window");
      mock.timers.tick(1);
      await flush();
      assert.equal(r.done, true, "abandoned at 35s, though the fetch ignored its signal");
      assert.equal(r.value!.reason, "request failed: timed out");
      assert.equal(r.value!.errorCode, undefined, "no code: the poll loop backs it off as a plain failure");
      assert.equal(r.value!.nextOffset, 7, "and the offset is kept, so nothing is skipped");
      assert.equal(seen[0]!.signal!.aborted, true, "the request itself was told to stop");
    } finally {
      mock.timers.reset();
    }
  });

  it(`any other method gets TG_CALL_TIMEOUT_MS, ${TG_CALL_TIMEOUT_MS / 1000} seconds`, async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { f } = deaf();
      const r = settled(sendMessage({ token: "1:a", fetchFn: f }, 5, "hi"));
      mock.timers.tick(TG_CALL_TIMEOUT_MS - 1);
      await flush();
      assert.equal(r.done, false);
      mock.timers.tick(1);
      await flush();
      assert.deepEqual(r.value, { ok: false, reason: "request failed: timed out" });
    } finally {
      mock.timers.reset();
    }
  });

  it("an upload gets 60 seconds, since it carries the file itself", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "merrymen-upload-"));
    const file = path.join(dir, "report.txt");
    writeFileSync(file, "hello");
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { f, seen } = deaf();
      const r = settled(sendDocument({ token: "1:a", fetchFn: f }, 5, file));
      await waitFor(() => seen.length === 1, "the upload reaches fetch");
      mock.timers.tick(59_999);
      await flush();
      assert.equal(r.done, false, "still inside the window");
      mock.timers.tick(1);
      await waitFor(() => r.done, "the upload gives up");
      assert.deepEqual(r.value, { ok: false, reason: "request failed: timed out" });
      assert.equal(seen[0]!.signal!.aborted, true);
    } finally {
      mock.timers.reset();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a caller's timeoutMs can raise an upload's 60 seconds, never cut it short", async () => {
    // One TelegramOpts serves JSON calls and uploads alike: a bound set short
    // to keep calls quick must not cut every photo and document to it.
    const dir = mkdtempSync(path.join(os.tmpdir(), "merrymen-upload-"));
    const file = path.join(dir, "report.txt");
    writeFileSync(file, "hello");
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      for (const [timeoutMs, gives] of [
        [20, 60_000],
        [90_000, 90_000],
      ] as const) {
        const { f, seen } = deaf();
        const r = settled(sendDocument({ token: "1:a", fetchFn: f, timeoutMs }, 5, file));
        await waitFor(() => seen.length === 1, `the upload reaches fetch (timeoutMs ${timeoutMs})`);
        mock.timers.tick(gives - 1);
        await flush();
        assert.equal(r.done, false, `timeoutMs ${timeoutMs}: still inside ${gives} ms`);
        mock.timers.tick(1);
        await waitFor(() => r.done, `timeoutMs ${timeoutMs}: the upload gives up at ${gives} ms`);
        assert.deepEqual(r.value, { ok: false, reason: "request failed: timed out" });
        assert.equal(seen[0]!.signal!.aborted, true);
      }
    } finally {
      mock.timers.reset();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a body that never finishes arriving is bounded too", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const f: FetchLike = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) });
      const r = settled(getMe({ token: "1:a", fetchFn: f }));
      mock.timers.tick(TG_CALL_TIMEOUT_MS);
      await flush();
      assert.equal(r.done, true);
      assert.equal(r.value!.reason, "request failed: timed out");
    } finally {
      mock.timers.reset();
    }
  });

  it("a caller's own timeoutMs bounds a call, and every request it cut is aborted", async () => {
    // A group send runs under its chat's lock: a call that never answered held
    // every later line of that chat (tg-groups/handler.ts).
    const { f, seen } = deaf();
    const opts = { token: "123:abc", fetchFn: f, timeoutMs: 20 };
    assert.deepEqual(await sendMessage(opts, -100, "hi"), { ok: false, reason: "request failed: timed out" });
    assert.equal((await sendChatAction(opts, -100, "typing")).ok, false);
    assert.equal((await setMessageReaction(opts, -100, 5, "👀")).ok, false);
    assert.equal(seen.length, 3);
    assert.ok(seen.every((s) => s.signal?.aborted === true), "every request was aborted");
  });

  it("an answer in time is not cut short, and nothing is left waiting", async () => {
    const f = fakeFetch(200, OK({ message_id: 9 }));
    assert.deepEqual(await sendMessage({ token: "t", fetchFn: f, timeoutMs: 5_000 }, -100, "hi"), { ok: true, messageId: 9 });
  });
});

describe("a refusal keeps what the poll loop backs off on", () => {
  it("a 429 carries its retry_after and code", async () => {
    const f = fakeFetch(429, {
      ok: false,
      error_code: 429,
      description: "Too Many Requests: retry after 7",
      parameters: { retry_after: 7 },
    });
    const r = await getUpdates({ token: "t", fetchFn: f }, 3);
    assert.equal(r.retryAfter, 7);
    assert.equal(r.errorCode, 429);
    assert.match(r.reason!, /Too Many Requests/);
    assert.equal(r.nextOffset, 3);
  });

  it("a revoked token is a 401, a second poller a 409", async () => {
    const revoked = await getUpdates({ token: "t", fetchFn: fakeFetch(401, { ok: false, error_code: 401, description: "Unauthorized" }) }, 0);
    assert.equal(revoked.errorCode, 401);
    assert.equal(revoked.retryAfter, undefined);
    const conflict = await getUpdates(
      {
        token: "t",
        fetchFn: fakeFetch(409, {
          ok: false,
          error_code: 409,
          description: "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
        }),
      },
      0,
    );
    assert.equal(conflict.errorCode, 409);
  });

  it("the HTTP status stands in when the body has no error_code", async () => {
    const r = await getUpdates({ token: "t", fetchFn: fakeFetch(502, null) }, 0);
    assert.equal(r.errorCode, 502);
    assert.equal(r.reason, "HTTP 502");
  });

  it("a network failure has a reason and no code", async () => {
    const r = await getUpdates({ token: "t", fetchFn: async () => { throw new TypeError("fetch failed"); } }, 0);
    assert.match(r.reason!, /fetch failed/);
    assert.equal(r.errorCode, undefined);
  });

  it("an answer that is not a list of updates is a failure, never a clean empty poll", async () => {
    const r = await getUpdates({ token: "t", fetchFn: fakeFetch(200, OK({ not: "a list" })) }, 4);
    assert.ok(r.reason);
    assert.equal(r.nextOffset, 4);
  });

  it("a 429 whose retry_after survives only in the description still backs the poll off (one reading, shared with the sends)", async () => {
    const r = await getUpdates({ token: "t", fetchFn: fakeFetch(429, { ok: false, error_code: 429, description: "Too Many Requests: retry after 12" }) }, 3);
    assert.equal(r.retryAfter, 12);
    assert.equal(r.errorCode, 429);
    const zero = await getUpdates({ token: "t", fetchFn: fakeFetch(429, { ok: false, error_code: 429, description: "x", parameters: { retry_after: 0 } }) }, 3);
    assert.equal(zero.retryAfter, undefined, "a retry_after of 0 asks for no wait");
  });

  it("a group send is bounded like any other, and a refusal inside the bound keeps retry_after and the new chat id", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const f: FetchLike = () => new Promise(() => {});
      let done: unknown;
      void sendMessage({ token: "1:a", fetchFn: f }, -1001, "hi", { replyToMessageId: 5, messageThreadId: 7 }).then((v) => (done = v));
      mock.timers.tick(TG_CALL_TIMEOUT_MS);
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      assert.deepEqual(done, { ok: false, reason: "request failed: timed out" });
    } finally {
      mock.timers.reset();
    }
    const moved = await sendMessage(
      {
        token: "1:a",
        fetchFn: fakeFetch(400, { ok: false, error_code: 400, description: "Bad Request: group chat was upgraded to a supergroup chat", parameters: { migrate_to_chat_id: -1002 } }),
      },
      -1001,
      "hi",
    );
    assert.equal(moved.migrateToChatId, -1002);
  });
});

// ─── Telegram groups (docs/tg-groups.md) ──────────────────────────────────

type Call = { url: string; body: Record<string, unknown> | null };

/**
 * Fake fetch that answers each call from `answers` in turn (the last one
 * repeats) and records every request, parsed.
 */
function scripted(...answers: { status?: number; body: unknown }[]): FetchLike & { calls: Call[] } {
  const f = (async (url: string, init?: { body?: string }) => {
    f.calls.push({ url, body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null });
    const a = answers[Math.min(f.calls.length - 1, answers.length - 1)]!;
    const status = a.status ?? 200;
    return { ok: status < 400, status, json: async () => a.body };
  }) as FetchLike & { calls: Call[] };
  f.calls = [];
  return f;
}

const BOT_ID = 9001;
const GROUP = -1001234567890;

describe("getUpdates — group messages", () => {
  it("a group message with a caption, entities, a reply and a topic parses fully", async () => {
    const caption = "@pine_bot Bo look at this chart";
    const f = fakeFetch(
      200,
      OK([
        {
          update_id: 500,
          message: {
            message_id: 91,
            date: 1_790_000_000,
            chat: { id: GROUP, type: "supergroup", title: "frog pond", is_forum: true },
            from: { id: 42, is_bot: false, first_name: "Ann", username: "ann" },
            message_thread_id: 7,
            is_topic_message: true,
            photo: [{ file_id: "p" }],
            caption,
            caption_entities: [
              { type: "mention", offset: 0, length: 9 },
              { type: "text_mention", offset: 10, length: 2, user: { id: 77, is_bot: false, first_name: "Bo" } },
              { type: "text_link", offset: 26, length: 5, url: "https://dexscreener.com/robinhood/0xabc" },
            ],
            reply_to_message: {
              message_id: 88,
              date: 1_789_999_990,
              chat: { id: GROUP, type: "supergroup" },
              from: { id: BOT_ID, is_bot: true, first_name: "Pine" },
              text: "gm",
            },
          },
        },
      ]),
    );
    const { messages, service, members } = await getUpdates({ token: "t", fetchFn: f }, 500);
    assert.deepEqual(service, []);
    assert.deepEqual(members, []);
    assert.deepEqual(messages, [
      {
        updateId: 500,
        chatId: GROUP,
        fromId: 42,
        fromUsername: "ann",
        text: caption,
        voiceFileId: undefined,
        date: 1_790_000_000,
        messageId: 91,
        dateSec: 1_790_000_000,
        chatType: "supergroup",
        chatTitle: "frog pond",
        isForum: true,
        fromIsBot: false,
        fromFirstName: "Ann",
        messageThreadId: 7,
        isTopicMessage: true,
        entities: [
          { type: "mention", offset: 0, length: 9 },
          { type: "text_mention", offset: 10, length: 2, userId: 77 },
          { type: "text_link", offset: 26, length: 5, url: "https://dexscreener.com/robinhood/0xabc" },
        ],
        replyTo: { messageId: 88, fromId: BOT_ID, fromIsBot: true, text: "gm" },
      },
    ]);
    // Offsets index the caption (UTF-16, like JS strings).
    const [mention, textMention] = messages[0]!.entities!;
    assert.equal(caption.slice(mention!.offset, mention!.offset + mention!.length), "@pine_bot");
    assert.equal(caption.slice(textMention!.offset, textMention!.offset + textMention!.length), "Bo");
  });

  it("text entities come from `entities` (never the caption's), and malformed ones are dropped, not guessed", async () => {
    const f = fakeFetch(
      200,
      OK([
        {
          update_id: 1,
          message: {
            message_id: 2,
            date: 3,
            chat: { id: -55, type: "group", title: "g" },
            from: { id: 4, is_bot: false, first_name: "Cy" },
            text: "🐸 /help@pine_bot",
            entities: [
              { type: "bot_command", offset: 3, length: 14 },
              { type: "mention", offset: -1, length: 3 },
              { type: "mention", offset: 1.5, length: 3 },
              { offset: 0, length: 1 },
              "junk",
              null,
            ],
            caption_entities: [{ type: "url", offset: 0, length: 1 }],
          },
        },
      ]),
    );
    const { messages } = await getUpdates({ token: "t", fetchFn: f }, 1);
    assert.deepEqual(messages[0]!.entities, [{ type: "bot_command", offset: 3, length: 14 }]);
    const e = messages[0]!.entities![0]!;
    // The frog is two UTF-16 units, and the offset counts them that way.
    assert.equal(messages[0]!.text.slice(e.offset, e.offset + e.length), "/help@pine_bot");
    assert.equal(messages[0]!.chatType, "group");
    assert.equal(messages[0]!.isForum, undefined);
  });

  it("a text message with no entities array has no `entities` key; an empty one is kept empty", async () => {
    const f = fakeFetch(
      200,
      OK([
        { update_id: 1, message: { message_id: 1, date: 1, chat: { id: -5, type: "group" }, from: { id: 4 }, text: "hi" } },
        { update_id: 2, message: { message_id: 2, date: 1, chat: { id: -5, type: "group" }, from: { id: 4 }, text: "yo", entities: [] } },
      ]),
    );
    const { messages } = await getUpdates({ token: "t", fetchFn: f }, 1);
    assert.equal("entities" in messages[0]!, false);
    assert.deepEqual(messages[1]!.entities, []);
  });

  it("a private message parses exactly as before — the legacy shape has exactly the old keys, plus its date", async () => {
    const f = fakeFetch(
      200,
      OK([
        { update_id: 100, message: { text: "/status", chat: { id: 555 }, from: { id: 555, username: "alice" } } },
        { update_id: 101, message: { chat: { id: 555 }, from: { id: 555 }, voice: { file_id: "v1" } } },
      ]),
    );
    const { messages, members, service } = await getUpdates({ token: "t", fetchFn: f }, 100);
    assert.deepEqual(messages, [
      { updateId: 100, chatId: 555, fromId: 555, fromUsername: "alice", text: "/status", voiceFileId: undefined, date: 0 },
      { updateId: 101, chatId: 555, fromId: 555, fromUsername: undefined, text: "", voiceFileId: "v1", date: 0 },
    ]);
    // `date` is always there (0 when Telegram sent none): the poll loop's
    // backlog rule reads it on every message. Nothing else is added.
    for (const m of messages) {
      assert.deepEqual(Object.keys(m).sort(), ["chatId", "date", "fromId", "fromUsername", "text", "updateId", "voiceFileId"]);
    }
    assert.deepEqual(members, []);
    assert.deepEqual(service, []);
  });

  it("a real private message keeps every old field as it was, and only adds what Telegram sent", async () => {
    const f = fakeFetch(
      200,
      OK([
        {
          update_id: 7,
          message: {
            message_id: 12,
            date: 1_700_000_000,
            chat: { id: 555, type: "private", first_name: "Alice", username: "alice" },
            from: { id: 555, is_bot: false, first_name: "Alice", username: "alice", language_code: "en" },
            text: "hi",
          },
        },
      ]),
    );
    const { messages } = await getUpdates({ token: "t", fetchFn: f }, 7);
    assert.deepEqual(messages, [
      {
        updateId: 7,
        chatId: 555,
        fromId: 555,
        fromUsername: "alice",
        text: "hi",
        voiceFileId: undefined,
        date: 1_700_000_000,
        messageId: 12,
        dateSec: 1_700_000_000,
        chatType: "private",
        fromIsBot: false,
        fromFirstName: "Alice",
      },
    ]);
  });

  it("a topic message's implicit reply to the topic opener is not reported as a reply", async () => {
    const f = fakeFetch(
      200,
      OK([
        {
          update_id: 1,
          message: {
            message_id: 40,
            date: 1,
            chat: { id: GROUP, type: "supergroup", is_forum: true },
            from: { id: 4, is_bot: false, first_name: "Di" },
            message_thread_id: 30,
            is_topic_message: true,
            text: "first!",
            reply_to_message: {
              message_id: 30,
              date: 0,
              chat: { id: GROUP, type: "supergroup" },
              from: { id: BOT_ID, is_bot: true, first_name: "Pine" },
              forum_topic_created: { name: "coins", icon_color: 1 },
            },
          },
        },
      ]),
    );
    const { messages } = await getUpdates({ token: "t", fetchFn: f }, 1);
    assert.equal(messages[0]!.replyTo, undefined);
    assert.equal("replyTo" in messages[0]!, false);
    assert.equal(messages[0]!.messageThreadId, 30);
  });

  it("a reply without a sender (e.g. to a channel post) keeps just the message id; a reply without an id is none", async () => {
    const f = fakeFetch(
      200,
      OK([
        { update_id: 1, message: { chat: { id: -5, type: "group" }, from: { id: 4 }, text: "a", reply_to_message: { message_id: 3 } } },
        { update_id: 2, message: { chat: { id: -5, type: "group" }, from: { id: 4 }, text: "b", reply_to_message: { from: { id: 9 } } } },
      ]),
    );
    const { messages } = await getUpdates({ token: "t", fetchFn: f }, 1);
    assert.deepEqual(messages[0]!.replyTo, { messageId: 3 });
    assert.equal("replyTo" in messages[1]!, false);
  });

  it("a reply carries the text Telegram quoted (else its caption), so a question under a coin post can find the coin", async () => {
    const CA = "0x7a3c0d5e11b2f4c6a8e9d0b1c2d3e4f5a6b7c8d9";
    const f = fakeFetch(
      200,
      OK([
        { update_id: 1, message: { chat: { id: -5, type: "group" }, from: { id: 4 }, text: "wdyt", reply_to_message: { message_id: 3, from: { id: 9, is_bot: false }, text: CA } } },
        { update_id: 2, message: { chat: { id: -5, type: "group" }, from: { id: 4 }, text: "this?", reply_to_message: { message_id: 7, caption: `chart ${CA}` } } },
        { update_id: 3, message: { chat: { id: -5, type: "group" }, from: { id: 4 }, text: "long", reply_to_message: { message_id: 8, text: "x".repeat(5_000) } } },
      ]),
    );
    const { messages } = await getUpdates({ token: "t", fetchFn: f }, 1);
    assert.deepEqual(messages[0]!.replyTo, { messageId: 3, fromId: 9, fromIsBot: false, text: CA });
    assert.deepEqual(messages[1]!.replyTo, { messageId: 7, text: `chart ${CA}` });
    assert.equal(messages[2]!.replyTo?.text?.length, 4096, "never longer than a Telegram message");
  });

  it("an anonymous admin's line carries sender_chat; `from` is Telegram's placeholder and says is_bot", async () => {
    const f = fakeFetch(
      200,
      OK([
        {
          update_id: 1,
          message: {
            message_id: 5,
            date: 1,
            chat: { id: GROUP, type: "supergroup", title: "frog pond" },
            from: { id: 1087968824, is_bot: true, first_name: "Group", username: "GroupAnonymousBot" },
            sender_chat: { id: GROUP, type: "supergroup", title: "frog pond" },
            text: "hello from nobody",
          },
        },
      ]),
    );
    const { messages } = await getUpdates({ token: "t", fetchFn: f }, 1);
    assert.equal(messages[0]!.senderChatId, GROUP);
    assert.equal(messages[0]!.fromIsBot, true);
    assert.equal(messages[0]!.fromId, 1087968824);
  });

  it("an unknown chat type is left out rather than guessed", async () => {
    const f = fakeFetch(200, OK([{ update_id: 1, message: { chat: { id: -5, type: "megagroup" }, from: { id: 4 }, text: "x" } }]));
    const { messages } = await getUpdates({ token: "t", fetchFn: f }, 1);
    assert.equal(messages.length, 1);
    assert.equal("chatType" in messages[0]!, false);
  });
});

describe("getUpdates — service messages", () => {
  it("joins, leaves and migrations land in `service`, never in `messages`", async () => {
    const chat = { id: -555, type: "group", title: "frog pond" };
    const f = fakeFetch(
      200,
      OK([
        {
          update_id: 10,
          message: {
            message_id: 1,
            date: 100,
            chat,
            from: { id: 42, is_bot: false, first_name: "Ann" },
            new_chat_members: [
              { id: BOT_ID, is_bot: true, first_name: "Pine", username: "pine_bot" },
              { id: 43, is_bot: false, first_name: "Bo" },
              { is_bot: false, first_name: "no id" },
            ],
            new_chat_member: { id: BOT_ID, is_bot: true, first_name: "Pine" },
            new_chat_participant: { id: BOT_ID, is_bot: true, first_name: "Pine" },
          },
        },
        {
          update_id: 11,
          message: { message_id: 2, date: 101, chat, from: { id: 43 }, left_chat_member: { id: 43, is_bot: false, first_name: "Bo" } },
        },
        {
          update_id: 12,
          message: { message_id: 3, date: 102, chat, from: { id: 42 }, migrate_to_chat_id: GROUP },
        },
        {
          update_id: 13,
          message: {
            message_id: 1,
            date: 102,
            chat: { id: GROUP, type: "supergroup", title: "frog pond" },
            from: { id: 1087968824, is_bot: true, first_name: "Group" },
            sender_chat: { id: GROUP },
            migrate_from_chat_id: -555,
          },
        },
        { update_id: 14, message: { message_id: 4, date: 103, chat, from: { id: 42, first_name: "Ann" }, text: "welcome pine" } },
      ]),
    );
    const { messages, service, members, nextOffset } = await getUpdates({ token: "t", fetchFn: f }, 10);
    assert.deepEqual(members, []);
    assert.deepEqual(service, [
      {
        updateId: 10,
        chatId: -555,
        chatType: "group",
        chatTitle: "frog pond",
        messageId: 1,
        dateSec: 100,
        fromId: 42,
        newChatMembers: [
          { id: BOT_ID, isBot: true, firstName: "Pine", username: "pine_bot" },
          { id: 43, isBot: false, firstName: "Bo" },
        ],
      },
      { updateId: 11, chatId: -555, chatType: "group", chatTitle: "frog pond", messageId: 2, dateSec: 101, fromId: 43, leftChatMember: { id: 43, isBot: false } },
      { updateId: 12, chatId: -555, chatType: "group", chatTitle: "frog pond", messageId: 3, dateSec: 102, fromId: 42, migrateToChatId: GROUP },
      { updateId: 13, chatId: GROUP, chatType: "supergroup", chatTitle: "frog pond", messageId: 1, dateSec: 102, fromId: 1087968824, migrateFromChatId: -555 },
    ]);
    // Only the line someone actually typed is a message.
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.text, "welcome pine");
    assert.equal(nextOffset, 15);
  });

  it("a service message without a sender still lands, with no fromId", async () => {
    const f = fakeFetch(
      200,
      OK([{ update_id: 1, message: { message_id: 9, date: 5, chat: { id: -5, type: "group" }, left_chat_member: { id: BOT_ID, is_bot: true } } }]),
    );
    const { service } = await getUpdates({ token: "t", fetchFn: f }, 1);
    assert.deepEqual(service, [{ updateId: 1, chatId: -5, chatType: "group", messageId: 9, dateSec: 5, leftChatMember: { id: BOT_ID, isBot: true } }]);
  });

  it("a service message that cannot be parsed is dropped from both lists — never typed text — and the offset still advances", async () => {
    const f = fakeFetch(
      200,
      OK([
        // no chat type
        { update_id: 20, message: { message_id: 1, date: 1, chat: { id: -5 }, from: { id: 4 }, new_chat_members: [{ id: 6, first_name: "E" }] } },
        // no message id
        { update_id: 21, message: { date: 1, chat: { id: -5, type: "group" }, from: { id: 4 }, left_chat_member: { id: 6 } } },
        // nothing usable in the service fields
        { update_id: 22, message: { message_id: 3, date: 1, chat: { id: -5, type: "group" }, from: { id: 4 }, new_chat_members: [], migrate_to_chat_id: "x" } },
        // a service field AND text: still not a typed line
        { update_id: 23, message: { message_id: 4, date: 1, chat: { id: -5 }, from: { id: 4 }, text: "sneaky", left_chat_member: { id: 6 } } },
      ]),
    );
    const { messages, service, nextOffset } = await getUpdates({ token: "t", fetchFn: f }, 20);
    assert.deepEqual(messages, []);
    assert.deepEqual(service, []);
    assert.equal(nextOffset, 24);
  });

  it("other service messages (pins, titles, photos) are dropped as before", async () => {
    const chat = { id: -5, type: "group" };
    const f = fakeFetch(
      200,
      OK([
        { update_id: 1, message: { message_id: 1, date: 1, chat, from: { id: 4 }, new_chat_title: "new name" } },
        { update_id: 2, message: { message_id: 2, date: 1, chat, from: { id: 4 }, pinned_message: { message_id: 1, date: 1, chat, text: "pinned" } } },
        { update_id: 3, message: { message_id: 3, date: 1, chat, from: { id: 4 }, sticker: { file_id: "s" } } },
      ]),
    );
    const { messages, service, nextOffset } = await getUpdates({ token: "t", fetchFn: f }, 1);
    assert.deepEqual(messages, []);
    assert.deepEqual(service, []);
    assert.equal(nextOffset, 4);
  });
});

describe("getUpdates — my_chat_member", () => {
  it("the bot's own membership changes land in `members`, with who made them", async () => {
    const f = fakeFetch(
      200,
      OK([
        {
          update_id: 30,
          my_chat_member: {
            chat: { id: GROUP, type: "supergroup", title: "frog pond", is_forum: true },
            from: { id: 42, is_bot: false, first_name: "Ann", username: "ann" },
            date: 1_790_000_000,
            old_chat_member: { status: "left", user: { id: BOT_ID, is_bot: true, first_name: "Pine" } },
            new_chat_member: { status: "member", user: { id: BOT_ID, is_bot: true, first_name: "Pine" } },
          },
        },
        {
          update_id: 31,
          my_chat_member: {
            chat: { id: -555, type: "group", title: "old pond" },
            from: { id: 43, is_bot: false, first_name: "Bo" },
            date: 1_790_000_100,
            old_chat_member: { status: "member", user: { id: BOT_ID } },
            new_chat_member: { status: "kicked", until_date: 0, user: { id: BOT_ID } },
          },
        },
        {
          update_id: 32,
          my_chat_member: {
            chat: { id: 555, type: "private", first_name: "Alice" },
            from: { id: 555, is_bot: false, first_name: "Alice" },
            date: 1_790_000_200,
            old_chat_member: { status: "member", user: { id: BOT_ID } },
            new_chat_member: { status: "kicked", until_date: 0, user: { id: BOT_ID } },
          },
        },
        {
          update_id: 33,
          my_chat_member: {
            chat: { id: GROUP, type: "supergroup", title: "frog pond" },
            from: { id: 42, first_name: "Ann" },
            date: 1_790_000_300,
            old_chat_member: { status: "member", user: { id: BOT_ID } },
            new_chat_member: { status: "restricted", is_member: false, can_send_messages: false, user: { id: BOT_ID } },
          },
        },
      ]),
    );
    const { members, messages, callbacks, service, nextOffset } = await getUpdates({ token: "t", fetchFn: f }, 30);
    assert.deepEqual(messages, []);
    assert.deepEqual(callbacks, []);
    assert.deepEqual(service, []);
    assert.deepEqual(members, [
      {
        updateId: 30,
        chatId: GROUP,
        chatType: "supergroup",
        chatTitle: "frog pond",
        isForum: true,
        fromId: 42,
        fromUsername: "ann",
        fromFirstName: "Ann",
        oldStatus: "left",
        newStatus: "member",
        dateSec: 1_790_000_000,
      },
      { updateId: 31, chatId: -555, chatType: "group", chatTitle: "old pond", fromId: 43, fromFirstName: "Bo", oldStatus: "member", newStatus: "kicked", dateSec: 1_790_000_100 },
      // A private-chat block arrives too; the group code filters on chatType.
      { updateId: 32, chatId: 555, chatType: "private", fromId: 555, fromFirstName: "Alice", oldStatus: "member", newStatus: "kicked", dateSec: 1_790_000_200 },
      {
        updateId: 33,
        chatId: GROUP,
        chatType: "supergroup",
        chatTitle: "frog pond",
        fromId: 42,
        fromFirstName: "Ann",
        oldStatus: "member",
        newStatus: "restricted",
        newIsMember: false,
        dateSec: 1_790_000_300,
      },
    ]);
    assert.equal(nextOffset, 34);
  });

  it("a membership change without who made it, a status or a known chat type is dropped — never guessed", async () => {
    const base = {
      chat: { id: -5, type: "group" },
      from: { id: 42 },
      date: 1,
      old_chat_member: { status: "left" },
      new_chat_member: { status: "member" },
    };
    const f = fakeFetch(
      200,
      OK([
        { update_id: 1, my_chat_member: { ...base, from: undefined } },
        { update_id: 2, my_chat_member: { ...base, chat: { id: -5 } } },
        { update_id: 3, my_chat_member: { ...base, new_chat_member: {} } },
        { update_id: 4, my_chat_member: { ...base, date: undefined } },
        { update_id: 5, my_chat_member: "junk" },
      ]),
    );
    const { members, messages, nextOffset } = await getUpdates({ token: "t", fetchFn: f }, 1);
    assert.deepEqual(members, []);
    assert.deepEqual(messages, []);
    assert.equal(nextOffset, 6);
  });

  it("a failed poll returns empty members and service, keeping the offset", async () => {
    const f = fakeFetch(502, null);
    const r = await getUpdates({ token: "t", fetchFn: f }, 9);
    assert.deepEqual(r, { messages: [], callbacks: [], members: [], service: [], nextOffset: 9, reason: "HTTP 502", errorCode: 502 });
  });
});

describe("sendMessage — group options", () => {
  const OPTS = { replyToMessageId: 91, messageThreadId: 7, disableNotification: true, disablePreview: true } as const;

  it("sends reply_parameters, message_thread_id, disable_notification and link_preview_options", async () => {
    const f = scripted({ body: OK({ message_id: 92 }) });
    const r = await sendMessage({ token: "t", fetchFn: f }, GROUP, "lol same", OPTS);
    assert.deepEqual(r, { ok: true, messageId: 92 });
    assert.deepEqual(f.calls[0]!.body, {
      chat_id: GROUP,
      text: "lol same",
      parse_mode: "HTML",
      reply_parameters: { message_id: 91, allow_sending_without_reply: true },
      message_thread_id: 7,
      disable_notification: true,
      link_preview_options: { is_disabled: true },
    });
  });

  it("a DM send's request body is byte-for-byte what it was", async () => {
    const bodies: (string | undefined)[] = [];
    const f: FetchLike = async (_url, init) => {
      bodies.push(init?.body);
      return { ok: true, status: 200, json: async () => OK({ message_id: 1 }) };
    };
    await sendMessage({ token: "t", fetchFn: f }, 555, "<b>hi</b>");
    await sendMessage({ token: "t", fetchFn: f }, 555, "q?", { keyboard: [[{ text: "Yes", callbackData: "mm:ok:1" }]] });
    await sendMessage({ token: "t", fetchFn: f }, 555, "x", { disableNotification: false, disablePreview: false });
    assert.equal(bodies[0], '{"chat_id":555,"text":"<b>hi</b>","parse_mode":"HTML"}');
    assert.equal(bodies[1], '{"chat_id":555,"text":"q?","parse_mode":"HTML","reply_markup":{"inline_keyboard":[[{"text":"Yes","callback_data":"mm:ok:1"}]]}}');
    assert.equal(bodies[2], '{"chat_id":555,"text":"x","parse_mode":"HTML"}');
  });

  it("the plain-text retry keeps every option — a reply never lands loose or in the wrong topic", async () => {
    const f = scripted({ status: 400, body: { ok: false, error_code: 400, description: "Bad Request: can't parse entities" } }, { body: OK({ message_id: 93 }) });
    const r = await sendMessage({ token: "t", fetchFn: f }, GROUP, "<b>broken <tag", OPTS);
    assert.deepEqual(r, { ok: true, messageId: 93 });
    assert.equal(f.calls.length, 2);
    const retry = f.calls[1]!.body!;
    assert.equal(retry.parse_mode, undefined);
    assert.deepEqual(retry.reply_parameters, { message_id: 91, allow_sending_without_reply: true });
    assert.equal(retry.message_thread_id, 7);
    assert.equal(retry.disable_notification, true);
    assert.deepEqual(retry.link_preview_options, { is_disabled: true });
  });

  it("the links-into-text retry keeps every option too", async () => {
    const f = scripted(
      { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: inline keyboard button URL 'http://localhost:3100/x' is invalid" } },
      { body: OK({ message_id: 94 }) },
    );
    const r = await sendMessage({ token: "t", fetchFn: f }, GROUP, "look", { ...OPTS, keyboard: [[{ text: "Open", url: "http://localhost:3100/x" }]] });
    assert.equal(r.ok, true);
    const retry = f.calls[1]!.body!;
    assert.match(String(retry.text), /Open: http:\/\/localhost:3100\/x/);
    assert.equal(retry.reply_markup, undefined);
    assert.deepEqual(retry.reply_parameters, { message_id: 91, allow_sending_without_reply: true });
    assert.equal(retry.message_thread_id, 7);
  });

  it("ids that are not positive integers are not sent", async () => {
    const f = scripted({ body: OK({ message_id: 1 }) });
    await sendMessage({ token: "t", fetchFn: f }, GROUP, "x", { replyToMessageId: 0, messageThreadId: Number.NaN });
    await sendMessage({ token: "t", fetchFn: f }, GROUP, "x", { replyToMessageId: -3, messageThreadId: 1.5 });
    for (const c of f.calls) {
      assert.equal(c.body!.reply_parameters, undefined);
      assert.equal(c.body!.message_thread_id, undefined);
    }
  });

  it("a 429 surfaces retryAfterSec from ResponseParameters, and is not retried", async () => {
    const f = scripted({
      status: 429,
      body: { ok: false, error_code: 429, description: "Too Many Requests: retry after 17", parameters: { retry_after: 17 } },
    });
    const r = await sendMessage({ token: "t", fetchFn: f }, GROUP, "x", { keyboard: [[{ text: "a", url: "https://x.y" }]] });
    assert.deepEqual(r, { ok: false, reason: "Too Many Requests: retry after 17", retryAfterSec: 17 });
    assert.equal(f.calls.length, 1);
  });

  it("ResponseParameters win over the description; the description is only a fallback", async () => {
    const withParams = scripted({ status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests: retry after 3", parameters: { retry_after: 40 } } });
    assert.equal((await sendMessage({ token: "t", fetchFn: withParams }, GROUP, "x")).retryAfterSec, 40);
    const without = scripted({ status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests: retry after 5" } });
    assert.equal((await sendMessage({ token: "t", fetchFn: without }, GROUP, "x")).retryAfterSec, 5);
    const bogus = scripted({ status: 429, body: { ok: false, description: "Too Many Requests", parameters: { retry_after: -1 } } });
    assert.equal("retryAfterSec" in (await sendMessage({ token: "t", fetchFn: bogus }, GROUP, "x")), false);
  });

  it("a 429 on the plain-text retry surfaces too", async () => {
    const f = scripted(
      { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: can't parse entities" } },
      { status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests: retry after 9", parameters: { retry_after: 9 } } },
    );
    const r = await sendMessage({ token: "t", fetchFn: f }, GROUP, "<b>x");
    assert.deepEqual(r, { ok: false, reason: "Too Many Requests: retry after 9", retryAfterSec: 9 });
  });

  it("migrate_to_chat_id surfaces — the group became a supergroup", async () => {
    const f = scripted({
      status: 400,
      body: { ok: false, error_code: 400, description: "Bad Request: group chat was upgraded to a supergroup chat", parameters: { migrate_to_chat_id: GROUP } },
    });
    const r = await sendMessage({ token: "t", fetchFn: f }, -555, "hi");
    assert.deepEqual(r, { ok: false, reason: "Bad Request: group chat was upgraded to a supergroup chat", migrateToChatId: GROUP });
    assert.equal(f.calls.length, 1);
  });

  it("an ordinary refusal carries no next-step fields", async () => {
    const f = scripted({ status: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot was kicked from the supergroup chat" } });
    assert.deepEqual(await sendMessage({ token: "t", fetchFn: f }, GROUP, "x"), {
      ok: false,
      reason: "Forbidden: bot was kicked from the supergroup chat",
    });
  });

  it("never throws on a network failure", async () => {
    const boom: FetchLike = async () => {
      throw new Error("ECONNRESET");
    };
    const r = await sendMessage({ token: "t", fetchFn: boom }, GROUP, "x", OPTS);
    assert.equal(r.ok, false);
    assert.match(r.reason!, /ECONNRESET/);
  });
});

describe("sendChatAction", () => {
  it("a DM's typing body is unchanged", async () => {
    const f = fakeFetch(200, OK(true));
    await sendChatAction({ token: "t", fetchFn: f }, 555);
    assert.match(f.lastUrl!, /\/sendChatAction$/);
    assert.equal(f.lastBody, '{"chat_id":555,"action":"typing"}');
  });

  it("shows typing in the forum topic it is answering in", async () => {
    const f = fakeFetch(200, OK(true));
    await sendChatAction({ token: "t", fetchFn: f }, GROUP, "typing", 7);
    assert.deepEqual(JSON.parse(f.lastBody!), { chat_id: GROUP, action: "typing", message_thread_id: 7 });
  });

  it("never throws", async () => {
    const boom: FetchLike = async () => {
      throw new Error("down");
    };
    const r = await sendChatAction({ token: "t", fetchFn: boom }, GROUP, "typing", 7);
    assert.equal(r.ok, false);
    assert.match(r.reason!, /down/);
  });

  it("says whether the chat can be written to: ok when Telegram took it", async () => {
    assert.deepEqual(await sendChatAction({ token: "t", fetchFn: fakeFetch(200, OK(true)) }, 555), { ok: true });
  });

  it("a person who never opened a DM, or blocked the bot, is not ok, with Telegram's reason", async () => {
    const notFound = fakeFetch(400, { ok: false, error_code: 400, description: "Bad Request: chat not found" });
    assert.deepEqual(await sendChatAction({ token: "t", fetchFn: notFound }, 555), { ok: false, reason: "Bad Request: chat not found" });
    const blocked = fakeFetch(403, { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" });
    assert.deepEqual(await sendChatAction({ token: "t", fetchFn: blocked }, 555), { ok: false, reason: "Forbidden: bot was blocked by the user" });
  });
});

describe("setMessageReaction / leaveChat / getChatMember", () => {
  it("sets one emoji reaction", async () => {
    const f = scripted({ body: OK(true) });
    assert.deepEqual(await setMessageReaction({ token: "t", fetchFn: f }, GROUP, 91, "🔥"), { ok: true });
    assert.match(f.calls[0]!.url, /\/setMessageReaction$/);
    assert.deepEqual(f.calls[0]!.body, { chat_id: GROUP, message_id: 91, reaction: [{ type: "emoji", emoji: "🔥" }] });
  });

  it("null clears our reaction", async () => {
    const f = scripted({ body: OK(true) });
    await setMessageReaction({ token: "t", fetchFn: f }, GROUP, 91, null);
    assert.deepEqual(f.calls[0]!.body, { chat_id: GROUP, message_id: 91, reaction: [] });
  });

  it("a refused reaction reports why, and a 429 its wait", async () => {
    const refused = scripted({ status: 400, body: { ok: false, error_code: 400, description: "Bad Request: REACTION_INVALID" } });
    assert.deepEqual(await setMessageReaction({ token: "t", fetchFn: refused }, GROUP, 91, "🦖"), { ok: false, reason: "Bad Request: REACTION_INVALID" });
    const flood = scripted({ status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests: retry after 6", parameters: { retry_after: 6 } } });
    assert.deepEqual(await setMessageReaction({ token: "t", fetchFn: flood }, GROUP, 91, "👀"), {
      ok: false,
      reason: "Too Many Requests: retry after 6",
      retryAfterSec: 6,
    });
  });

  it("leaves a chat", async () => {
    const f = scripted({ body: OK(true) });
    assert.deepEqual(await leaveChat({ token: "t", fetchFn: f }, GROUP), { ok: true });
    assert.match(f.calls[0]!.url, /\/leaveChat$/);
    assert.deepEqual(f.calls[0]!.body, { chat_id: GROUP });
    const gone = scripted({ status: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot is not a member of the supergroup chat" } });
    const r = await leaveChat({ token: "t", fetchFn: gone }, GROUP);
    assert.equal(r.ok, false);
    assert.match(r.reason!, /not a member/);
  });

  it("reads a member's status, and says null — unknown — when Telegram will not", async () => {
    const f = scripted({ body: OK({ status: "administrator", user: { id: 42, is_bot: false, first_name: "Ann" }, can_manage_chat: true }) });
    assert.deepEqual(await getChatMember({ token: "t", fetchFn: f }, GROUP, 42), { status: "administrator" });
    assert.match(f.calls[0]!.url, /\/getChatMember$/);
    assert.deepEqual(f.calls[0]!.body, { chat_id: GROUP, user_id: 42 });

    const refused = scripted({ status: 400, body: { ok: false, error_code: 400, description: "Bad Request: user not found" } });
    assert.equal(await getChatMember({ token: "t", fetchFn: refused }, GROUP, 42), null);
    const odd = scripted({ body: OK({ user: { id: 42 } }) });
    assert.equal(await getChatMember({ token: "t", fetchFn: odd }, GROUP, 42), null);
    const boom: FetchLike = async () => {
      throw new Error("down");
    };
    assert.equal(await getChatMember({ token: "t", fetchFn: boom }, GROUP, 42), null);
  });
});

describe("getMe — group flags", () => {
  it("exposes can_join_groups and can_read_all_group_messages", async () => {
    const f = fakeFetch(200, OK({ id: 42, is_bot: true, first_name: "Pine", username: "pine_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false }));
    const { bot } = await getMe({ token: "t", fetchFn: f });
    assert.deepEqual(bot, { id: 42, username: "pine_bot", isBot: true, firstName: "Pine", canJoinGroups: true, canReadAllGroupMessages: false });
  });

  it("privacy off reads as true", async () => {
    const f = fakeFetch(200, OK({ id: 42, username: "pine_bot", can_read_all_group_messages: true }));
    const { bot } = await getMe({ token: "t", fetchFn: f });
    assert.equal(bot!.canReadAllGroupMessages, true);
    assert.equal("canJoinGroups" in bot!, false);
  });
});

describe("token hygiene", () => {
  const TOKEN = "123456789:AAH-secretsecretsecretsecretsecret";

  it("a fetch error that quotes the URL does not carry the token into the reason", async () => {
    const quoting: FetchLike = async (url) => {
      throw new TypeError(`Failed to parse URL from ${url}`);
    };
    const me = await getMe({ token: TOKEN, fetchFn: quoting });
    assert.ok(!me.reason!.includes(TOKEN), me.reason);
    assert.ok(!me.reason!.includes("AAH-secret"), me.reason);
    assert.match(me.reason!, /Failed to parse URL/);
    const sent = await sendMessage({ token: TOKEN, fetchFn: quoting }, GROUP, "x");
    assert.ok(!sent.reason!.includes(TOKEN), sent.reason);
    const up = await getUpdates({ token: TOKEN, fetchFn: quoting }, 1);
    assert.ok(!up.reason!.includes(TOKEN), up.reason);
  });
});
