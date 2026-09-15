import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { BOT_COMMANDS, esc, getMe, getUpdates, sendMessage, setMyCommands, publicBotCommands, type FetchLike } from "./api";
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
  "start", // Telegram convention; /help covers it
  "grant", "restore", "recover", "reconnect", "fund", // wallet signpost synonyms
  "book", // positions
  "liquidity", "levels", // depth
  "digest", // report
  "send", "withdraw", // transfer
  "yes", "no", // confirm/cancel
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
