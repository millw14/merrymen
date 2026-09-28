import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, mock } from "node:test";
import { BOT_COMMANDS, answerCallbackQuery, editMessageText, esc, getMe, getUpdates, sendDocument, sendMessage, setMyCommands, publicBotCommands, type FetchLike } from "./api";
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

  it("asks Telegram for button presses, or they are never delivered", async () => {
    const f = fakeFetch(200, OK([]));
    await getUpdates({ token: "t", fetchFn: f }, 1);
    assert.match(f.lastBody!, /"allowed_updates":\["message","callback_query"\]/);
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

  it("a getUpdates that never answers comes back with a reason at its long-poll window plus 10s — 35s by default", async () => {
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
      assert.match(r.value!.reason!, /timed out after 35s/);
      assert.equal(r.value!.nextOffset, 7, "and the offset is kept, so nothing is skipped");
      assert.equal(seen[0]!.signal!.aborted, true, "the request itself was told to stop");
    } finally {
      mock.timers.reset();
    }
  });

  it("any other method gets 15 seconds", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { f } = deaf();
      const r = settled(sendMessage({ token: "1:a", fetchFn: f }, 5, "hi"));
      mock.timers.tick(14_999);
      await flush();
      assert.equal(r.done, false);
      mock.timers.tick(1);
      await flush();
      assert.deepEqual(r.value, { ok: false, reason: "request timed out after 15s" });
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
      await flush();
      mock.timers.tick(59_999);
      await flush();
      assert.equal(r.done, false, "still inside the window");
      mock.timers.tick(1);
      await flush();
      assert.deepEqual(r.value, { ok: false, reason: "upload timed out after 60s" });
      assert.equal(seen[0]!.signal!.aborted, true);
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
      mock.timers.tick(15_000);
      await flush();
      assert.equal(r.done, true);
      assert.match(r.value!.reason!, /timed out after 15s/);
    } finally {
      mock.timers.reset();
    }
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
});
