/**
 * THE POLL LOOP IS BOUNDED, BACKS OFF, AND KNOWS WHICH BOT IT IS POLLING.
 *
 * A hosted owner's bot went silent for days. Nothing here explains all of that
 * on its own, but every piece of it made the silence longer or quieter: a
 * request that never answered held the strictly serial loop for good, a
 * revoked token was asked again twice a second, a 429 was retried inside its
 * own retry_after, a second poller turned into two processes taking the bot's
 * updates from each other, and a change of bot kept the old bot's offset (so
 * getUpdates returned nothing, ever) and the old bot's link code.
 *
 * Driven end to end through the real startTelegram, with Telegram's API
 * replaced by a scripted fake on globalThis.fetch and the clock mocked
 * (setTimeout and Date), in the style of energy-alert-redeploy.integration.
 * The fake answers from plain objects, so every step is a promise and one
 * settle() lets the loop run until it is waiting on a timer again.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it, mock } from "node:test";

import type { TelegramState } from "./state";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-poll-bounded-"));
process.env.MERRYMEN_HOME = HOME; // the soul files and a /link's settings patch land here
after(() => rmSync(HOME, { recursive: true, force: true }));

const { startTelegram } = await import("./service");
const { ensureLinkCode } = await import("./state");

const T0 = Date.parse("2026-09-28T12:00:00Z");
const CONFLICT_LINE = "Telegram: another program is reading this bot's updates (409 Conflict)";

interface Call {
  method: string;
  token: string;
  body: Record<string, unknown>;
  at: number;
}
/** What the fake answers one request with. `hang` never answers, not even to an abort. */
type Reply = { status?: number; body: unknown } | "throw" | "hang";

function blankState(over: Partial<TelegramState> = {}): TelegramState {
  return {
    offset: 0, botId: null, chatSettings: null, linkCode: "", linkRound: 0, ownerId: null, linkedAt: null,
    linkedChats: [], messageCount: 0, lastNotifiedTradeId: -1, lastTradeDigestAt: 0, lastRemedyRule: null,
    firedAlerts: {}, signWatch: null, lastDigestDate: "", lastJournalDate: "", priceAlerts: [], reminders: [],
    watchers: [], nextId: 1, ...over,
  };
}

const ok = (result: unknown): Reply => ({ body: { ok: true, result } });
const refused = (status: number, description: string, parameters?: Record<string, unknown>): Reply => ({
  status,
  body: { ok: false, error_code: status, description, ...(parameters ? { parameters } : {}) },
});
const text = (updateId: number, chatId: number, t: string) => ({
  update_id: updateId,
  message: { text: t, date: Math.floor(Date.now() / 1000), chat: { id: chatId }, from: { id: chatId } },
});

/** Whatever the script does not answer: every method succeeds, and getUpdates is empty. */
function defaultReply(c: Call): Reply {
  if (c.method === "getMe") return ok({ id: Number(c.token.split(":")[0]), username: `bot${c.token.split(":")[0]}` });
  if (c.method === "getUpdates") return ok([]);
  if (c.method === "sendMessage") return ok({ message_id: 1 });
  return ok(true);
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

interface Harness {
  calls: Call[];
  notes: { level: string; message: string }[];
  cfg: { telegramBotToken: string; telegramAllowlist: number[] };
  state: () => TelegramState;
  polls: () => Call[];
  sent: () => string[];
  /** Move the mocked clock on, letting the loop run at every step. */
  advance: (ms: number) => Promise<void>;
}

/**
 * Start the real service over the fake, run `body`, and always stop it, the
 * mock clock and the fake. `script` sees each request as it is made.
 */
async function withService(
  opts: {
    token: string;
    allowlist?: number[];
    state?: Partial<TelegramState>;
    script?: (c: Call, h: Harness) => Reply | undefined;
  },
  body: (h: Harness) => Promise<void>,
): Promise<void> {
  const calls: Call[] = [];
  const notes: { level: string; message: string }[] = [];
  const cfg = {
    telegramEnabled: true,
    telegramBotToken: opts.token,
    telegramAllowlist: opts.allowlist ?? [],
    telegramControlEnabled: false,
    telegramTransferEnabled: false,
    telegramPcControlEnabled: false,
    telegramAgentEnabled: false,
    telegramCapabilities: [],
    telegramMaxActionUsdg: 25,
    customTokens: [],
  };
  let state = blankState(opts.state);
  const h: Harness = {
    calls,
    notes,
    cfg,
    state: () => state,
    polls: () => calls.filter((c) => c.method === "getUpdates"),
    sent: () => calls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text)),
    advance: async (ms) => {
      for (let t = 0; t < ms; t += 250) {
        mock.timers.tick(Math.min(250, ms - t));
        await settle();
      }
    },
  };
  const realFetch = globalThis.fetch;
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    const m = /\/bot([^/]+)\/(\w+)$/.exec(String(url));
    assert.ok(m, `unexpected url ${String(url)}`);
    const call: Call = {
      token: m[1]!,
      method: m[2]!,
      body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      at: Date.now(),
    };
    calls.push(call);
    const r = opts.script?.(call, h) ?? defaultReply(call);
    if (r === "throw") throw new TypeError("fetch failed");
    if (r === "hang") return new Promise(() => {});
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.body };
  }) as typeof fetch;
  const svc = startTelegram({
    getCfg: () => cfg as never,
    stateRef: { get: () => state, set: (s) => { state = s; } },
    note: (level, message) => notes.push({ level, message }),
    buildStatusContext: () => ({}) as never,
    setStrategy: () => ({ ok: true }),
    grantPerTradeUsdg: () => undefined,
    grantHasTransfer: () => false,
    readDepth: async () => "",
    submitTrade: async () => { throw new Error("no trade may run in this test"); },
    submitTransfer: async () => { throw new Error("no transfer may run in this test"); },
    kill: () => ({ ok: false, reason: "not in this test" }) as never,
  });
  try {
    await settle();
    await body(h);
  } finally {
    svc.stop();
    mock.timers.reset();
    globalThis.fetch = realFetch;
  }
}

const gaps = (calls: Call[]) => calls.slice(1).map((c, i) => c.at - calls[i]!.at);
const warns = (h: Harness, re: RegExp) => h.notes.filter((n) => n.level === "warn" && re.test(n.message));

describe("bounded I/O: nothing Telegram does can hold the loop", () => {
  it("a getUpdates that never answers is abandoned at 35s, and the loop polls again", async () => {
    let n = 0;
    await withService(
      { token: "111:a", script: (c) => (c.method === "getUpdates" && ++n === 1 ? "hang" : undefined) },
      async (h) => {
        await h.advance(34_750);
        assert.equal(h.polls().length, 1, "still waiting on the first");
        await h.advance(2_500);
        assert.equal(h.polls().length, 2, "given up at 35s, then 2s of backoff");
        assert.equal(h.polls()[1]!.at - T0, 37_000);
        assert.equal(warns(h, /getUpdates — request timed out after 35s/).length, 1);
      },
    );
  });

  it("a reply that never lands costs its 15 seconds, not every message after it", async () => {
    let n = 0;
    await withService(
      {
        token: "111:a",
        script: (c) => {
          if (c.method === "getUpdates" && ++n === 1) return ok([text(10, 999, "hey")]);
          if (c.method === "sendMessage") return "hang";
          return undefined;
        },
      },
      async (h) => {
        await h.advance(14_750);
        assert.equal(h.polls().length, 1, "the refusal to a stranger is still in flight");
        await h.advance(1_000);
        assert.equal(h.polls().length, 2, "abandoned at 15s and the next poll went out");
        assert.equal(h.polls()[1]!.body.offset, 11, "past the message it could not answer");
      },
    );
  });
});

describe("backoff: a failing poll waits, and says so once", () => {
  it("a 429 is not asked again before its retry_after", async () => {
    let n = 0;
    await withService(
      {
        token: "111:a",
        script: (c) =>
          c.method === "getUpdates" && ++n === 1
            ? refused(429, "Too Many Requests: retry after 7", { retry_after: 7 })
            : undefined,
      },
      async (h) => {
        await h.advance(6_750);
        assert.equal(h.polls().length, 1, "no getUpdates inside the 7 seconds");
        await h.advance(500);
        assert.equal(h.polls().length, 2);
        assert.equal(h.polls()[1]!.at - h.polls()[0]!.at, 7_000);
      },
    );
  });

  it("network failures wait 2s, 4s, 8s … capped at 60s; one line for the outage, and one when it ends", async () => {
    let n = 0;
    await withService(
      { token: "111:a", script: (c) => (c.method === "getUpdates" && ++n <= 7 ? "throw" : undefined) },
      async (h) => {
        await h.advance(183_000);
        assert.deepEqual(gaps(h.polls()).slice(0, 7), [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
        assert.equal(warns(h, /getUpdates — request failed: fetch failed/).length, 1, "logged once, not per poll");
        assert.deepEqual(
          h.notes.filter((x) => /receiving updates again/.test(x.message)).map((x) => x.message),
          ["Telegram: receiving updates again after 3m 2s"],
        );
        assert.equal(gaps(h.polls())[7], 500, "and back to a tight loop once it works");
      },
    );
  });

  it("a revoked token (401) is asked again after five minutes, not twice a second", async () => {
    await withService(
      { token: "111:a", script: (c) => (c.method === "getUpdates" ? refused(401, "Unauthorized") : undefined) },
      async (h) => {
        await h.advance(299_750);
        assert.equal(h.polls().length, 1);
        await h.advance(500);
        assert.equal(h.polls().length, 2);
        assert.equal(h.polls()[1]!.at - T0, 300_000);
        assert.equal(warns(h, /bot token was refused \(401 Unauthorized\)/).length, 1);
        assert.equal(
          h.calls.filter((c) => c.method === "setMyCommands").length,
          0,
          "and no menu is pushed for a bot that cannot even be polled",
        );
      },
    );
  });

  it("…but a token fixed on the dashboard is used within seconds, not after the rest of the wait", async () => {
    await withService(
      {
        token: "111:old",
        script: (c) => (c.method === "getUpdates" && c.token === "111:old" ? refused(404, "Not Found") : undefined),
      },
      async (h) => {
        await h.advance(60_000);
        assert.equal(h.polls().length, 1, "a 404 waits like a 401");
        h.cfg.telegramBotToken = "111:new";
        await h.advance(5_000);
        assert.equal(h.polls().length, 2);
        assert.equal(h.polls()[1]!.token, "111:new");
        assert.ok(h.notes.some((x) => x.message === "Telegram: receiving updates again after 1m 5s"));
      },
    );
  });

  it("a 409 is logged once as another poller, polled again every 10s, and not re-logged when it flaps", async () => {
    let n = 0;
    const conflict = refused(409, "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running");
    await withService(
      {
        token: "111:a",
        // Three conflicts, one clean poll, one more conflict: two pollers trading the bot.
        script: (c) => (c.method === "getUpdates" && [1, 2, 3, 5].includes(++n) ? conflict : undefined),
      },
      async (h) => {
        await h.advance(45_000);
        assert.deepEqual(gaps(h.polls()).slice(0, 5), [10_000, 10_000, 10_000, 500, 10_000]);
        assert.deepEqual(
          h.notes.filter((x) => x.level === "warn").map((x) => x.message),
          [CONFLICT_LINE],
        );
        assert.equal(
          h.notes.filter((x) => /receiving updates again/.test(x.message)).length,
          1,
          "the second, unlogged conflict gets no recovery line either",
        );
      },
    );
  });
});

describe("the command menu waits for the messages, and gives up politely", () => {
  it("is pushed after the batch is answered; three tries per fingerprint, then every 10 minutes; 'chat not found' is not retried", async () => {
    let n = 0;
    await withService(
      {
        token: "111:a",
        allowlist: [555, 777],
        script: (c) => {
          if (c.method === "getUpdates" && ++n === 1) return ok([text(1, 555, "/reminders")]);
          if (c.method === "setMyCommands") {
            const chat = (c.body.scope as { chat_id?: number } | undefined)?.chat_id;
            if (chat === 555) return refused(400, "Bad Request: something transient");
            if (chat === 777) return refused(400, "Bad Request: chat not found");
          }
          return undefined;
        },
      },
      async (h) => {
        const firstMenu = h.calls.findIndex((c) => c.method === "setMyCommands");
        const reply = h.calls.findIndex((c) => c.method === "sendMessage");
        assert.ok(reply > 0 && firstMenu > reply, "the owner's answer went out before any menu push");
        assert.match(h.sent()[0]!, /no reminders set/);

        const tries = (chat: number) =>
          h.calls.filter((c) => c.method === "setMyCommands" && (c.body.scope as { chat_id?: number } | undefined)?.chat_id === chat);
        await h.advance(5_000);
        assert.equal(tries(555).length, 3, "three polls, three tries");
        assert.equal(tries(777).length, 1, "the bot has no chat with 777; asking again cannot change that");
        await h.advance(590_000);
        assert.equal(tries(555).length, 3, "then quiet");
        await h.advance(10_000);
        assert.equal(tries(555).length, 4, "and once more ten minutes after the third");
        assert.equal(tries(777).length, 1);
        assert.equal(warns(h, /command menu/).length, 1);
      },
    );
  });
});

describe("the offset and the link code belong to one bot", () => {
  it("a DIFFERENT bot starts from offset 0 with a new code, and says so without the token or the code", async () => {
    const oldCode = ensureLinkCode(blankState(), "111:a").linkCode;
    await withService({ token: "222:x", state: { offset: 900_000_000, botId: "111", linkCode: oldCode } }, async (h) => {
      assert.equal(h.polls()[0]!.body.offset, 0, "the old bot's offset would have hidden every update");
      assert.equal(h.polls()[0]!.token, "222:x");
      assert.equal(h.state().botId, "222");
      assert.notEqual(h.state().linkCode, oldCode);
      assert.match(h.state().linkCode, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
      assert.ok(h.notes.some((x) => x.message === "Telegram: bot changed to @bot222"));
      for (const x of h.notes) {
        assert.ok(!x.message.includes("222:x"), "no token in the log");
        assert.ok(!x.message.includes(h.state().linkCode), "no code in the log");
      }
    });
  });

  it("a DIFFERENT bot forgives link lockouts, which counted guesses at a code that no longer exists", async () => {
    let n111 = 0;
    let n222 = 0;
    await withService(
      {
        token: "111:a",
        state: { botId: "111" },
        script: (c, h) => {
          if (c.method !== "getUpdates") return undefined;
          if (c.token === "111:a" && ++n111 === 1) {
            return ok([
              ...[1, 2, 3, 4, 5].map((i) => text(i, 999, `/link WRONG${i}`)),
              text(6, 999, `/link ${h.state().linkCode}`),
            ]);
          }
          if (c.token === "222:b" && ++n222 === 1) return ok([text(1, 999, `/link ${h.state().linkCode}`)]);
          return undefined;
        },
      },
      async (h) => {
        assert.match(h.sent()[5]!, /too many attempts/, "premise: the chat is locked out on the first bot");
        h.cfg.telegramBotToken = "222:b";
        await h.advance(1_000);
        assert.match(h.sent()[6]!, /you're linked/);
        assert.deepEqual(h.state().linkedChats, [999]);
        assert.equal(h.state().offset, 2, "the new bot's own update ids from here on");
      },
    );
  });

  it("the SAME bot with a new secret keeps its offset, but the code is re-minted", async () => {
    const code = ensureLinkCode(blankState(), "111:a").linkCode;
    await withService({ token: "111:a", state: { offset: 500, botId: "111", linkCode: code } }, async (h) => {
      assert.equal(h.polls()[0]!.body.offset, 500);
      assert.equal(h.state().linkCode, code, "nothing changes while the token does not");
      h.cfg.telegramBotToken = "111:b";
      await h.advance(1_000);
      const last = h.polls().at(-1)!;
      assert.equal(last.token, "111:b");
      assert.equal(last.body.offset, 500, "the same bot's updates are the same stream");
      assert.notEqual(h.state().linkCode, code, "the code was derived from the replaced token");
      assert.ok(h.notes.some((x) => /bot token renewed/.test(x.message)));
      assert.ok(!h.notes.some((x) => /bot changed/.test(x.message)));
    });
  });

  it("a file with NO bot recorded adopts the current one and resets nothing", async () => {
    await withService({ token: "222:x", state: { offset: 900_000_000, botId: null, linkCode: "ABCDEF" } }, async (h) => {
      assert.equal(h.polls()[0]!.body.offset, 900_000_000);
      assert.equal(h.state().botId, "222");
      assert.equal(h.state().linkCode, "ABCDEF", "the code the dashboard may be showing still works");
      assert.ok(!h.notes.some((x) => /bot changed|renewed/.test(x.message)));
    });
  });

  it("a token that is not <digits>:<secret> is never written down as a bot id", async () => {
    await withService({ token: "not-a-token", state: { offset: 12 } }, async (h) => {
      assert.equal(h.state().botId, null);
      assert.equal(h.polls()[0]!.body.offset, 12);
    });
  });
});
