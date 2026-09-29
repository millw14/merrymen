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
const { ensureLinkCode, tokenTagOf } = await import("./state");
const { makeChatTally } = await import("./poll-rules");

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
    offset: 0, botId: null, priorBots: [], tokenTag: null, boundAt: null, chatSettings: null, linkCode: "",
    linkRound: 0, ownerId: null, linkedAt: null,
    linkedChats: [], linkedChatAt: {}, messageCount: 0, lastNotifiedTradeId: -1, lastTradeDigestAt: 0, lastRemedyRule: null,
    firedAlerts: {}, signWatch: null, lastDigestDate: "", lastJournalDate: "", priceAlerts: [], reminders: [],
    watchers: [], nextId: 1, poll: null, ...over,
  };
}

const ok = (result: unknown): Reply => ({ body: { ok: true, result } });
const refused = (status: number, description: string, parameters?: Record<string, unknown>): Reply => ({
  status,
  body: { ok: false, error_code: status, description, ...(parameters ? { parameters } : {}) },
});
const text = (updateId: number, chatId: number, t: string, date = Math.floor(Date.now() / 1000)) => ({
  update_id: updateId,
  message: { text: t, date, chat: { id: chatId }, from: { id: chatId } },
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
  /** The owner's event feed (`note`, index.ts strategyNote). */
  notes: { level: string; message: string; at: number }[];
  /** The fleet's log, where the chat tally writes (poll-rules.ts makeChatTally). */
  logs: { level: string; message: string; at: number }[];
  cfg: { telegramEnabled: boolean; telegramBotToken: string; telegramAllowlist: number[]; telegramControlEnabled: boolean };
  /** While true, every read of the config throws, as an unreadable settings file would. */
  cfgBroken: boolean;
  trades: string[];
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
    /** Lets /buy and /sell run, recording each one; without it any trade fails the test. */
    trading?: boolean;
  },
  body: (h: Harness) => Promise<void>,
): Promise<void> {
  const calls: Call[] = [];
  const notes: { level: string; message: string; at: number }[] = [];
  const logs: { level: string; message: string; at: number }[] = [];
  const cfg = {
    telegramEnabled: true,
    telegramBotToken: opts.token,
    telegramAllowlist: opts.allowlist ?? [],
    telegramControlEnabled: opts.trading ?? false,
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
    logs,
    cfg,
    cfgBroken: false,
    trades: [],
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
    // A fresh object on every read, as resolveConfig() gives the real service:
    // a change made during a batch is not visible through the config read
    // before it.
    getCfg: () => {
      if (h.cfgBroken) throw new Error("settings unreadable");
      return { ...cfg, telegramAllowlist: [...cfg.telegramAllowlist] } as never;
    },
    stateRef: { get: () => state, set: (s) => { state = s; } },
    note: (level, message) => notes.push({ level, message, at: Date.now() }),
    // As index.ts hands one in: on the fleet's log, which here is `logs`.
    tally: makeChatTally((level, message) => logs.push({ level, message, at: Date.now() }), () => Math.floor(Date.now() / 1000)),
    buildStatusContext: () => ({}) as never,
    setStrategy: () => ({ ok: true }),
    grantPerTradeUsdg: () => undefined,
    grantHasTransfer: () => false,
    readDepth: async () => "",
    submitTrade: async (side, symbol, usdg) => {
      if (!opts.trading) throw new Error("no trade may run in this test");
      h.trades.push(`${side} ${symbol} ${usdg}`);
      return `${side} ${symbol} done`;
    },
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

const gaps = (xs: { at: number }[]) => xs.slice(1).map((x, i) => x.at - xs[i]!.at);
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
        assert.equal(warns(h, /getUpdates — request failed: timed out$/).length, 1);
        assert.match(h.state().poll?.err ?? "", /^failed: request failed: timed out/, "kept as a plain failure, which backs off");
      },
    );
  });

  it("a reply that never lands costs its 10 seconds, not every message after it", async () => {
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
        await h.advance(9_750);
        assert.equal(h.polls().length, 1, "the refusal to a stranger is still in flight");
        await h.advance(1_000);
        assert.equal(h.polls().length, 2, "abandoned at 10s and the next poll went out");
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
    const oldCode = ensureLinkCode(blankState()).linkCode;
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
        assert.match(h.sent()[5]!, /too many wrong codes/, "premise: the chat is locked out on the first bot");
        h.cfg.telegramBotToken = "222:b";
        await h.advance(1_000);
        assert.match(h.sent()[6]!, /you're linked/);
        assert.deepEqual(h.state().linkedChats, [999]);
        assert.equal(h.state().offset, 2, "the new bot's own update ids from here on");
      },
    );
  });

  it("the SAME bot with a new secret keeps its offset, but the code is re-minted", async () => {
    const code = ensureLinkCode(blankState()).linkCode;
    await withService({ token: "111:a", state: { offset: 500, botId: "111", tokenTag: tokenTagOf("111:a"), linkCode: code } }, async (h) => {
      assert.equal(h.polls()[0]!.body.offset, 500);
      assert.equal(h.state().linkCode, code, "nothing changes while the token does not");
      h.cfg.telegramBotToken = "111:b";
      await h.advance(1_000);
      const last = h.polls().at(-1)!;
      assert.equal(last.token, "111:b");
      assert.equal(last.body.offset, 500, "the same bot's updates are the same stream");
      assert.notEqual(h.state().linkCode, code, "a code issued under the replaced token is not kept");
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

/**
 * Telegram as it really behaves: an update is forgotten only when a later
 * getUpdates for THAT bot asks past it, so a batch handled just before the
 * token changed is still there to be handed over again.
 */
function realisticTelegram(pending: Record<string, ReturnType<typeof text>[]>) {
  const confirmed: Record<string, number> = {};
  return (c: Call): Reply | undefined => {
    if (c.method !== "getUpdates") return undefined;
    const bot = c.token.split(":")[0]!;
    confirmed[bot] = Math.max(confirmed[bot] ?? 0, Number(c.body.offset ?? 0));
    return ok((pending[bot] ?? []).filter((u) => u.update_id >= confirmed[bot]!));
  };
}

const EARLY_LINK = /that code reached me late, so I didn't use it/;
const EARLY_HELD = /just been connected to this bot/;
const sentTo = (h: Harness, chat: number) =>
  h.calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === chat).map((c) => String(c.body.text));

describe("a change of bot never runs a command twice, or one that was not sent to this agent", () => {
  it("A → B → A resumes A where it was left: its last batch is not handed over again, and its /buy runs once", async () => {
    const pending = { "111": [text(10, 555, "/buy NVDA 5")] };
    await withService(
      { token: "111:a", allowlist: [555], trading: true, state: { botId: "111", tokenTag: tokenTagOf("111:a") }, script: realisticTelegram(pending) },
      async (h) => {
        assert.deepEqual(h.trades, ["buy NVDA 5"], "premise: the first poll bought");
        // The token changes before the next poll of A asks past update 10, so
        // Telegram still holds it: a mistyped paste, or another bot's token.
        h.cfg.telegramBotToken = "222:b";
        await h.advance(1_000);
        assert.equal(h.polls().at(-1)!.token, "222:b");
        h.cfg.telegramBotToken = "111:a";
        await h.advance(1_000);
        const back = h.polls().filter((c) => c.token === "111:a");
        assert.equal(back[1]!.body.offset, 11, "A resumes past what it already handled");
        assert.deepEqual(h.trades, ["buy NVDA 5"], "the /buy did not run a second time");
        assert.equal(sentTo(h, 555).filter((t) => EARLY_HELD.test(t)).length, 0, "and was not even handed over again");
      },
    );
  });

  it("a new bot's backlog is answered once per chat and acted on never: no trade, no /kill, no /link compared or counted", async () => {
    const stale = Math.floor(T0 / 1000) - 3_600; // sent an hour before the switch
    let n = 0;
    await withService(
      {
        token: "222:b",
        allowlist: [555],
        trading: true,
        state: { botId: "111", offset: 900, tokenTag: tokenTagOf("111:a"), linkCode: "ABCDEF" },
        script: (c, h) => {
          if (c.method !== "getUpdates") return undefined;
          n += 1;
          if (n === 1) {
            return ok([
              // The incident: the owner's /link attempts at a code this bot's
              // dashboard never showed, waiting out a silence.
              ...[1, 2, 3, 4, 5, 6].map((i) => text(i, 999, `/link WRONG${i}`, stale)),
              // Commands the same owner sent while the bot served another agent.
              text(7, 555, "/buy NVDA 5", stale),
              text(8, 555, "/kill", stale),
              text(9, 555, "/reminders", stale),
              ...[10, 11, 12].map((i) => text(i, 777, "hey", stale)),
              {
                update_id: 13,
                callback_query: {
                  id: "cb1",
                  data: "c:y:abcdef",
                  from: { id: 555 },
                  message: { message_id: 4, chat: { id: 555 }, date: stale },
                },
              } as never,
            ]);
          }
          if (n === 2) return ok([text(14, 999, `/link ${h.state().linkCode}`)]);
          return undefined;
        },
      },
      async (h) => {
        await h.advance(1_000);
        assert.deepEqual(h.trades, [], "no trade from the backlog");
        assert.deepEqual(sentTo(h, 555), [sentTo(h, 555)[0]], "one answer to the owner, and nothing ran");
        assert.match(sentTo(h, 555)[0]!, EARLY_HELD);
        assert.deepEqual(sentTo(h, 777).length, 1, "one refusal to a stranger, not three");
        assert.match(sentTo(h, 777)[0]!, /not authorized/);
        const to999 = sentTo(h, 999);
        assert.match(to999[0]!, EARLY_LINK, "one resend prompt for six stale codes");
        assert.match(to999[1]!, /you're linked/, "and no lockout: the live code links");
        assert.equal(to999.length, 2);
        const pressed = h.calls.find((c) => c.method === "answerCallbackQuery");
        assert.equal(pressed?.body.text, "That button has expired.");
        assert.equal(h.polls()[1]!.body.offset, 14, "the backlog is consumed, not replayed");
      },
    );
  });

  it("the same bot, restarted with a new secret: a code issued under the replaced token no longer links", async () => {
    const leaked = "111:LEAKED";
    const derived = ensureLinkCode(blankState({ linkRound: 2 })).linkCode;
    let n = 0;
    await withService(
      {
        token: "111:FRESH",
        allowlist: [555],
        // What the process left on disk while it still ran on the leaked token.
        state: { botId: "111", tokenTag: tokenTagOf(leaked), offset: 500, linkRound: 2, linkCode: derived, ownerId: 555, linkedChats: [555] },
        script: (c) => (c.method === "getUpdates" && ++n === 1 ? ok([text(500, 666, `/link ${derived}`)]) : undefined),
      },
      async (h) => {
        assert.equal(h.polls()[0]!.body.offset, 500, "the same bot's stream");
        assert.notEqual(h.state().linkCode, derived);
        assert.equal(h.state().tokenTag, tokenTagOf("111:FRESH"));
        assert.deepEqual(h.state().linkedChats, [555], "the stranger was not linked");
        assert.match(sentTo(h, 666)[0]!, /bad or expired code/);
        assert.ok(h.notes.some((x) => /bot token renewed/.test(x.message)));
        assert.ok(!h.notes.some((x) => x.message.includes(h.state().linkCode) || x.message.includes("FRESH")));
      },
    );
  });

  it("the code on disk is never empty while the new bot's name is being looked up", async () => {
    await withService(
      {
        token: "222:x",
        state: { botId: "111", offset: 40, tokenTag: tokenTagOf("111:a"), linkCode: "ABCDEF" },
        script: (c) => (c.method === "getMe" ? "hang" : undefined),
      },
      async (h) => {
        assert.equal(h.polls().length, 0, "premise: getMe is still out");
        assert.equal(h.state().botId, "222");
        assert.match(h.state().linkCode, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/, "minted in the same write");
        assert.notEqual(h.state().linkCode, "ABCDEF");
        await h.advance(15_250);
        assert.equal(h.polls().length, 1, "and the poll goes ahead once getMe gives up");
        assert.ok(h.notes.some((x) => x.message === "Telegram: bot changed"));
      },
    );
  });
});

describe("the menu, the 409s, the crashes and the off switch", () => {
  it("a chat linked in this batch gets its full menu on this poll, not after the next long poll", async () => {
    let n = 0;
    await withService(
      {
        token: "111:a",
        script: (c, h) => {
          if (c.method === "getUpdates" && ++n === 1) return ok([text(1, 555, `/link ${h.state().linkCode}`)]);
          // What resolveConfig reads back once the link has patched settings.json.
          if (c.method === "sendMessage" && /you're linked/.test(String(c.body.text))) h.cfg.telegramAllowlist.push(555);
          return undefined;
        },
      },
      async (h) => {
        await h.advance(1_000);
        const full = h.calls.findIndex(
          (c) => c.method === "setMyCommands" && (c.body.scope as { chat_id?: number } | undefined)?.chat_id === 555,
        );
        const second = h.calls.indexOf(h.polls()[1]!);
        assert.ok(full > 0, "the owner's full menu was pushed");
        assert.ok(full < second, "before the next poll went out");
      },
    );
  });

  it("a 409 from a webhook says so, instead of blaming another program", async () => {
    let n = 0;
    await withService(
      {
        token: "111:a",
        script: (c) =>
          c.method === "getUpdates" && ++n === 1
            ? refused(409, "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first")
            : undefined,
      },
      async (h) => {
        await h.advance(10_500);
        assert.deepEqual(
          h.notes.filter((x) => x.level === "warn").map((x) => x.message),
          ["Telegram: this bot has a webhook set, so its updates can't be polled (409 Conflict)"],
        );
        assert.equal(gaps(h.polls())[0], 10_000);
      },
    );
  });

  it("a poll that throws, such as an unreadable config, backs off 2s, 4s, 8s … and recovers to a tight loop", async () => {
    await withService({ token: "111:a" }, async (h) => {
      h.cfgBroken = true;
      await h.advance(31_000);
      const crashes = h.notes.filter((x) => /poll loop — settings unreadable/.test(x.message));
      assert.deepEqual(gaps(crashes), [2_000, 4_000, 8_000, 16_000]);
      const before = h.polls().length;
      h.cfgBroken = false;
      await h.advance(6_000);
      const after = h.polls().slice(before);
      assert.ok(after.length >= 2, "polling again");
      assert.equal(gaps(after)[0], 500, "and the crash count starts over");
    });
  });

  it("time spent switched off is not counted into an outage", async () => {
    let n = 0;
    await withService(
      { token: "111:a", script: (c) => (c.method === "getUpdates" && ++n <= 2 ? "throw" : undefined) },
      async (h) => {
        assert.equal(warns(h, /getUpdates — request failed/).length, 1, "premise: an outage began");
        h.cfg.telegramEnabled = false;
        await h.advance(60_000);
        assert.equal(h.polls().length, 1, "nothing polled while off");
        h.cfg.telegramEnabled = true;
        await h.advance(12_000);
        assert.deepEqual(
          h.notes.filter((x) => /receiving updates again/.test(x.message)).map((x) => x.message),
          ["Telegram: receiving updates again after 2s"],
          "the outage is the one after switching on, not the minute it was off",
        );
      },
    );
  });
});

/**
 * WHAT THE LOOP LEAVES FOR THE ORCHESTRATOR AND THE LOG (plan §1.4, P5). The
 * dashboard's "listening" and the fleet's `[alert] telegram not polling` are
 * read from the record the loop keeps in telegram.json; the log is where a
 * refused stranger, a failed code and a reply that never arrived are counted.
 */
describe("the poll record and the log", () => {
  it("records each poll for the bot it was about: a good one's time, and a 409 kept beside it", async () => {
    let n = 0;
    const conflict = refused(409, "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running");
    await withService(
      { token: "111:a", script: (c) => (c.method === "getUpdates" && ++n === 2 ? conflict : undefined) },
      async (h) => {
        const t0 = Math.floor(T0 / 1000);
        assert.deepEqual(h.state().poll, { okAt: t0, err: null, errAt: null, botId: "111" }, "the first poll, at once");
        await h.advance(1_000);
        // In the same second as the good poll, so stamped a second after it:
        // the record must still say which came last.
        assert.deepEqual(h.state().poll, {
          okAt: t0,
          err: "conflict: another program is reading this bot's updates (409)",
          errAt: t0 + 1,
          botId: "111",
        });
        await h.advance(11_000);
        // Heard again: the success is written at once, and the conflict is
        // kept, older than it, so the record says the bot is heard now.
        const p = h.state().poll!;
        assert.ok(p.okAt! > p.errAt!, JSON.stringify(p));
        assert.equal(p.err, "conflict: another program is reading this bot's updates (409)");
      },
    );
  });

  it("a revoked token is recorded as refused, never with the token", async () => {
    await withService(
      { token: "111:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", script: (c) => (c.method === "getUpdates" ? refused(401, "Unauthorized") : undefined) },
      async (h) => {
        assert.equal(h.state().poll?.err, "refused: 401 Unauthorized");
        assert.ok(!JSON.stringify(h.state()).includes("AAHdq"));
      },
    );
  });

  it("A REPLY TELEGRAM WOULD NOT TAKE IS LOGGED, with the chat cut to four digits", async () => {
    let n = 0;
    await withService(
      {
        token: "111:a",
        allowlist: [123456789],
        script: (c) => {
          if (c.method === "getUpdates" && ++n === 1) return ok([text(10, 123456789, "/reminders")]);
          if (c.method === "sendMessage") return refused(403, "Forbidden: bot was blocked by the user");
          return undefined;
        },
      },
      async (h) => {
        await h.advance(1_000);
        const lost = h.logs.filter((x) => x.level === "warn" && /was not delivered/.test(x.message));
        assert.deepEqual(lost.map((x) => x.message), ["Telegram: a reply to chat …6789 was not delivered — Forbidden: bot was blocked by the user"]);
        assert.deepEqual(warns(h, /was not delivered/), [], "the fleet's log, not the owner's feed");
      },
    );
  });

  it("A STRANGER'S MESSAGES AND WRONG CODES ARE COUNTED, and the lockout is said with until when", async () => {
    let n = 0;
    const STRANGER = 987654321;
    await withService(
      {
        token: "111:a",
        script: (c) =>
          c.method === "getUpdates" && ++n === 1
            ? ok([
                text(10, STRANGER, "hello?"),
                text(11, STRANGER, "anyone?"),
                ...[12, 13, 14, 15, 16].map((id) => text(id, STRANGER, "/link WRONG1")),
              ])
            : undefined,
      },
      async (h) => {
        await h.advance(1_000);
        const lines = h.logs.map((x) => x.message).filter((m) => /…4321/.test(m));
        assert.deepEqual(lines, [
          "Telegram: message from unlisted chat …4321 refused (1 so far)",
          "Telegram: message from unlisted chat …4321 refused (2 so far)",
          "Telegram: /link from chat …4321 failed (wrong code) — 1 so far",
          "Telegram: /link from chat …4321 failed (wrong code) — 2 so far",
          "Telegram: /link from chat …4321 failed (wrong code) — 4 so far",
          `Telegram: chat …4321 locked out of /link until ${new Date(T0 + 600_000).toISOString().slice(11, 16)} UTC after 5 failed code(s)`,
        ]);
        assert.ok(!h.logs.some((x) => x.message.includes(String(STRANGER))), "never the whole chat id");
      },
    );
  });

  it("A STRANGER WRITES NOTHING INTO THE OWNER'S EVENT FEED", async () => {
    // The owner's notice slot shows the newest warning among their last
    // events, and some warnings are written once and never again. One
    // `/link x` from anyone who knows the bot's name used to land there as a
    // warning, over whatever real one was showing; a lockout line every ten
    // minutes kept it covered, and forty strangers filled the whole window.
    let n = 0;
    const strangers = Array.from({ length: 40 }, (_, i) => -1_000_000_000_000 - i);
    await withService(
      {
        token: "111:a",
        script: (c) =>
          c.method === "getUpdates" && ++n === 1
            ? ok([
                text(10, 555001234, "/link WRONG1"),
                ...[11, 12, 13, 14].map((id) => text(id, 555001234, "/link WRONG1")),
                ...strangers.map((chat, i) => text(20 + i, chat, "hello?")),
              ])
            : c.method === "sendMessage"
              ? refused(403, "Forbidden: bot was blocked by the user")
              : undefined,
      },
      async (h) => {
        await h.advance(1_000);
        assert.ok(h.logs.some((x) => /locked out of \/link/.test(x.message)), "premise: the log has the lockout");
        // The one line the owner's feed gets is the service's own, at start.
        assert.deepEqual(
          h.notes.map((x) => x.message),
          ["Telegram: connected as @bot111"],
          "and the owner's feed has nothing a stranger caused",
        );
      },
    );
  });
});
