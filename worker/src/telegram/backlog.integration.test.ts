/**
 * A STALE BACKLOG MUST NOT LOCK ANYONE OUT, OR RUN ANYTHING BUT A BRAKE.
 *
 * The incident: a hosted owner's bot went silent for days. The owner kept
 * sending "/link NTE49D" into the silence. When a child finally polled the bot,
 * Telegram handed over the whole backlog at once, and the service handled it
 * as if it had just been typed: five stale /link attempts were compared
 * against a code minted seconds earlier, counted as five wrong guesses, and
 * locked the owner's chat out the moment the bot came back. The same rule
 * would have bought a day-old /buy at today's price.
 *
 * Also here, because they are the same path: /start <code> deep links (the
 * apps' "open in Telegram" button) are /link with the same counting and
 * lockout; a stranger's bare /start is told how to link, with their chat id;
 * the lockout reply says for how long; the offset is saved before each update
 * runs, so a crash cannot replay a trade; and the config is read per update
 * while the batch keeps the token it was fetched with.
 *
 * Driven end to end through the real startTelegram over a scripted
 * globalThis.fetch and a mocked clock, as in poll-bounded.integration.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it, mock } from "node:test";

import type { TelegramState } from "./state";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-backlog-"));
process.env.MERRYMEN_HOME = HOME; // the soul files, a /link's settings patch and the pause marker land here
after(() => rmSync(HOME, { recursive: true, force: true }));

const { startTelegram, isPaused, setPaused } = await import("./service");

const T0 = Date.parse("2026-09-28T12:00:00Z");
const NOW = Math.floor(T0 / 1000);
const HOURS_AGO = (h: number) => NOW - h * 3_600;
const ADDRESS = "0x1111111111111111111111111111111111111111";

const LATE_CODE = /^that code reached me after I'd been offline, so I didn't use it — send the code shown in Settings → Telegram now\.$/;
const SUMMARY = /^(I was offline|I've just come back online); /;
/** The note after a start from no saved offset: it cannot know the backlog was never acted on (service.ts staleSummaryText). */
const MAY_HAVE_RUN = /I haven't acted on (it|them) since, but (it|some) may have gone through just before I went offline — check \/status and \/trades before you resend a trade or a transfer\.$/;
const LOCKED = /too many wrong codes from this chat — try again in about \d+ min \(after \d\d:\d\d UTC\)\. Use the code in Settings → Telegram\./;
const LINKED = /you're linked/;

interface Call {
  method: string;
  token: string;
  body: Record<string, unknown>;
  at: number;
}
/** `delayMs`: answered that long after it was asked, on the mocked clock, as a long poll is. */
type Reply = { status?: number; body: unknown; delayMs?: number } | "hang";

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
/** A message, dated now (live) unless told otherwise. */
const text = (updateId: number, chatId: number, t: string, date = Math.floor(Date.now() / 1000)) => ({
  update_id: updateId,
  message: { text: t, date, chat: { id: chatId }, from: { id: chatId } },
});
const press = (updateId: number, chatId: number, date: number) => ({
  update_id: updateId,
  callback_query: { id: `cb${updateId}`, data: "mm:y:abcdefghjk", from: { id: chatId }, message: { message_id: 4, chat: { id: chatId }, date } },
});

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
  notes: string[];
  cfg: {
    telegramEnabled: boolean;
    telegramBotToken: string;
    telegramAllowlist: number[];
  };
  trades: string[];
  transfers: string[];
  kills: number;
  state: () => TelegramState;
  polls: () => Call[];
  sentTo: (chat: number) => string[];
  /** Tick the mocked clock `ms`, `step` at a time, letting everything due run between ticks. */
  advance: (ms: number, step?: number) => Promise<void>;
  /** Called from inside the grant-cap read, which every allowlisted message makes before its command runs. */
  onGrantRead?: () => void;
  /** What submitTrade does, when a test wants it to do more than record. */
  onTrade?: () => Promise<string>;
  /** Every write of telegram.json throws while this is set, as on a full disk. */
  stateWriteFails?: boolean;
}

/**
 * The real service over the fake. Unlike poll-bounded's harness, trades,
 * transfers and the kill switch are live and recorded, because the point here
 * is to show which of them a backlog can and cannot reach.
 */
async function withService(
  opts: {
    token?: string;
    allowlist?: number[];
    /** When the process starts, on the mocked clock; T0 unless a test runs a second process later. */
    startAt?: number;
    state?: Partial<TelegramState>;
    script?: (c: Call, h: Harness) => Reply | undefined;
    /** A message that says "you're linked" puts its chat on the allowlist, as settings.json read back would. */
    linkAllows?: boolean;
  },
  body: (h: Harness) => Promise<void>,
): Promise<void> {
  const calls: Call[] = [];
  const notes: string[] = [];
  const cfg = {
    telegramEnabled: true,
    telegramBotToken: opts.token ?? "111:a",
    telegramAllowlist: opts.allowlist ?? [],
    telegramControlEnabled: true,
    telegramTransferEnabled: true,
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
    trades: [],
    transfers: [],
    kills: 0,
    state: () => state,
    polls: () => calls.filter((c) => c.method === "getUpdates"),
    sentTo: (chat) => calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === chat).map((c) => String(c.body.text)),
    advance: async (ms, step = 250) => {
      for (let t = 0; t < ms; t += step) {
        mock.timers.tick(Math.min(step, ms - t));
        await settle();
      }
    },
  };
  const realFetch = globalThis.fetch;
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: opts.startAt ?? T0 });
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
    if (opts.linkAllows && call.method === "sendMessage" && LINKED.test(String(call.body.text))) {
      h.cfg.telegramAllowlist.push(call.body.chat_id as number);
    }
    const r = opts.script?.(call, h) ?? defaultReply(call);
    if (r === "hang") return new Promise(() => {});
    if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.body };
  }) as typeof fetch;
  const svc = startTelegram({
    getCfg: () => ({ ...cfg, telegramAllowlist: [...cfg.telegramAllowlist] }) as never,
    stateRef: {
      get: () => state,
      set: (s) => {
        if (h.stateWriteFails) throw new Error("ENOSPC: no space left on device, write telegram.json");
        state = s;
      },
    },
    note: (_level, message) => notes.push(message),
    buildStatusContext: () => ({}) as never,
    setStrategy: () => ({ ok: true }),
    grantPerTradeUsdg: () => {
      h.onGrantRead?.();
      return undefined;
    },
    grantHasTransfer: () => true,
    readDepth: async () => "",
    submitTrade: async (side, symbol, usdg) => {
      h.trades.push(`${side} ${symbol} ${usdg}`);
      return h.onTrade ? h.onTrade() : `${side} ${symbol} done`;
    },
    submitTransfer: async (to, usdg) => {
      h.transfers.push(`${to} ${usdg}`);
      return "sent";
    },
    kill: () => {
      h.kills += 1;
      return { ok: true };
    },
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

/** The first getUpdates gets `batch`; every later one gets `then`, or nothing. */
function firstPoll(batch: (h: Harness) => unknown[], then?: (n: number, h: Harness) => unknown[] | undefined) {
  let n = 0;
  return (c: Call, h: Harness): Reply | undefined => {
    if (c.method !== "getUpdates") return undefined;
    n += 1;
    if (n === 1) return ok(batch(h));
    const more = then?.(n, h);
    return more ? ok(more) : undefined;
  };
}

beforeEach(() => setPaused(false));

describe("the backlog rule (a message dated before this process started listening)", () => {
  it("1. five day-old /link attempts are never counted: the live code links, and the owner is heard", async () => {
    await withService(
      {
        linkAllows: true,
        script: firstPoll((h) => [
          ...[1, 2, 3, 4, 5].map((i) => text(i, 999, `/link WRONG${i}`, HOURS_AGO(20))),
          text(6, 999, `/link ${h.state().linkCode}`),
          text(7, 999, "hey"),
        ]),
      },
      async (h) => {
        const to999 = h.sentTo(999);
        assert.equal(to999.filter((t) => LATE_CODE.test(t)).length, 1, "one late-code notice for five stale codes");
        assert.match(to999[1]!, LINKED, "the live code links: the stale ones did not lock the chat");
        assert.ok(!to999.some((t) => LOCKED.test(t)));
        assert.deepEqual(h.state().linkedChats, [999]);
        assert.equal(to999.length, 3);
        assert.doesNotMatch(to999[2]!, /not authorized/, "\"hey\", read against the allowlist as it is after the link");
      },
    );
  });

  it("2. a stale /link with the CURRENT code is not used either: not linked, code unchanged, one prompt", async () => {
    await withService(
      {
        state: { linkCode: "ABCDEF" },
        script: firstPoll(() => [text(1, 999, "/link ABCDEF", HOURS_AGO(3)), text(2, 999, "/link ABCDEF", HOURS_AGO(2))]),
      },
      async (h) => {
        assert.deepEqual(h.state().linkedChats, []);
        assert.equal(h.state().ownerId, null);
        assert.equal(h.state().linkCode, "ABCDEF", "not spent: the owner can still send it live");
        assert.equal(h.sentTo(999).length, 1);
        assert.match(h.sentTo(999)[0]!, LATE_CODE);
      },
    );
  });

  it("3. five LIVE wrong codes still lock the chat, and the reply says for how long and until when", async () => {
    await withService(
      {
        script: firstPoll((h) => [
          ...[1, 2, 3, 4, 5].map((i) => text(i, 999, `/link WRONG${i}`)),
          text(6, 999, `/link ${h.state().linkCode}`),
        ]),
      },
      async (h) => {
        assert.equal(
          h.sentTo(999)[5],
          "couldn't link: too many wrong codes from this chat — try again in about 10 min (after 12:10 UTC). Use the code in Settings → Telegram.",
        );
        assert.deepEqual(h.state().linkedChats, []);
      },
    );
  });

  it("4. a live /link handled five minutes late still counts: there is no age threshold", async () => {
    let served = false;
    await withService(
      {
        script: (c, h) => {
          if (c.method !== "getUpdates" || served || c.at < T0 + 300_000) return undefined;
          served = true;
          // Sent a second after listening began, handled 300s later.
          return ok([
            ...[1, 2, 3, 4, 5].map((i) => text(i, 999, `/link WRONG${i}`, NOW + 1)),
            text(6, 999, `/link ${h.state().linkCode}`, NOW + 1),
          ]);
        },
      },
      async (h) => {
        assert.equal(h.polls()[0]!.at, T0, "premise: listening began at T0");
        await h.advance(301_000);
        assert.ok(served, "premise: the batch was handed over");
        assert.match(h.sentTo(999)[5]!, LOCKED, "late is not stale: the guess limit holds");
        assert.ok(!h.sentTo(999).some((t) => LATE_CODE.test(t)));
      },
    );
  });

  it("4b. a /link typed while the first long poll was out is live: listening began when that poll was SENT", async () => {
    // Telegram holds a long poll open until something arrives. One sent at T0
    // that comes back at +20s with a message typed at +10s delivered it the
    // moment it was typed. Arming at the answer would call it late, and a
    // guess made then would be neither compared nor counted.
    let asked = 0;
    await withService(
      {
        script: (c, h) => {
          if (c.method !== "getUpdates" || ++asked > 1) return undefined;
          return {
            ...(ok([
              ...[1, 2, 3, 4, 5].map((i) => text(i, 999, `/link WRONG${i}`, NOW + 10)),
              text(6, 999, `/link ${h.state().linkCode}`, NOW + 10),
            ]) as { body: unknown }),
            delayMs: 20_000,
          };
        },
      },
      async (h) => {
        assert.equal(h.sentTo(999).length, 0, "premise: the first poll is still out");
        await h.advance(21_000);
        assert.equal(h.polls()[0]!.at, T0, "premise: sent at T0");
        assert.equal(h.sentTo(999).length, 6);
        assert.ok(!h.sentTo(999).some((t) => LATE_CODE.test(t)), "compared, not held");
        assert.match(h.sentTo(999)[5]!, LOCKED, "and counted");
      },
    );
  });

  it("5. an allowlisted chat's stale /buy, /transfer and /confirm never run; one summary; a stale /pause does", async () => {
    await withService(
      {
        allowlist: [555],
        script: firstPoll(() => [
          text(1, 555, "/buy NVDA 5", HOURS_AGO(20)),
          text(2, 555, `/transfer ${ADDRESS} 5`, HOURS_AGO(19)),
          text(3, 555, "/confirm", HOURS_AGO(19)),
          text(4, 555, "/pause", HOURS_AGO(18)),
          text(5, 555, "what's my balance?", HOURS_AGO(18)),
          // Live, after the backlog: nothing was parked by the stale /transfer.
          text(6, 555, "/confirm"),
        ]),
      },
      async (h) => {
        assert.deepEqual(h.trades, [], "no trade from the backlog");
        assert.deepEqual(h.transfers, [], "no transfer from the backlog");
        const to555 = h.sentTo(555);
        assert.equal(to555.filter((t) => SUMMARY.test(t)).length, 1, "one summary for the chat");
        // A first poll from no saved offset: a redeploy's, which may be handed
        // back the batch the process before it ran (test 5d).
        assert.equal(
          to555[0],
          "I've just come back online; 4 messages arrived late (oldest Sep 27 16:00 UTC). I haven't acted on them since, but some may have gone through just before I went offline — check /status and /trades before you resend a trade or a transfer.",
        );
        assert.equal(isPaused(), true, "the stale /pause ran");
        assert.match(to555[1]!, /paused/);
        assert.equal(to555[2], "nothing pending to confirm.", "the live /confirm finds nothing parked");
        assert.equal(to555.length, 3);
      },
    );
  });

  it("5b. a stale /kill only asks, and a stale /confirm cannot answer it; a live one can", async () => {
    await withService(
      {
        allowlist: [555],
        script: firstPoll(
          () => [text(1, 555, "/kill", HOURS_AGO(1)), text(2, 555, "/confirm", HOURS_AGO(1))],
          (n) => (n === 2 ? [text(3, 555, "/confirm")] : undefined),
        ),
      },
      async (h) => {
        const to555 = h.sentTo(555);
        assert.match(to555[0]!, /confirm kill/);
        assert.match(to555[1]!, /^I've just come back online; 1 message arrived late \(oldest 11:00 UTC\)\./);
        assert.match(to555[1]!, MAY_HAVE_RUN);
        assert.equal(h.kills, 0, "nothing killed by the backlog");
        await h.advance(1_000);
        assert.equal(h.kills, 1, "the owner's live /confirm does it");
      },
    );
  });

  it("5c. with an offset saved, the same backlog is known never to have run, and is told so", async () => {
    // The offset is saved past each update before it runs (test 7), so what
    // Telegram hands back past it was never handled by anything.
    await withService(
      {
        allowlist: [555],
        state: { offset: 1, botId: "111" },
        script: firstPoll(() => [text(1, 555, "/buy NVDA 5", HOURS_AGO(20)), text(2, 555, "hey", HOURS_AGO(19))]),
      },
      async (h) => {
        assert.deepEqual(h.trades, []);
        assert.deepEqual(h.sentTo(555), [
          "I was offline; 2 messages arrived late (oldest Sep 27 16:00 UTC). I didn't act on them — resend anything you still need.",
        ]);
      },
    );
  });

  it("5d. A /buy RUN JUST BEFORE A REDEPLOY AND HANDED BACK AFTER IT is not run again, and the owner is not told to resend it", async () => {
    // Telegram confirms an update only when the next getUpdates asks past
    // it. The redeploy lands after the /buy has filled and before that
    // poll, wipes the home and the offset in it, and the next process asks
    // from 0 and is handed the /buy again.
    const buy = text(1, 555, "/buy NVDA 5", NOW);
    await withService({ allowlist: [555], script: firstPoll(() => [buy]) }, async (h) => {
      assert.deepEqual(h.trades, ["buy NVDA 5"], "premise: it filled");
    });
    await withService(
      { allowlist: [555], startAt: T0 + 60_000, script: firstPoll(() => [buy]) },
      async (h) => {
        assert.deepEqual(h.trades, [], "not a second time");
        const said = h.sentTo(555);
        assert.equal(said.length, 1);
        assert.doesNotMatch(said[0]!, /didn't act|resend anything/, "not the claim that would have bought it twice");
        assert.match(said[0]!, MAY_HAVE_RUN);
      },
    );
  });

  it("6. three stale messages from a stranger get exactly one refusal, and nothing about the outage", async () => {
    await withService(
      { script: firstPoll(() => [1, 2, 3].map((i) => text(i, 777, `hello ${i}`, HOURS_AGO(4)))) },
      async (h) => {
        assert.deepEqual(h.sentTo(777), [
          "🚫 not authorized — your chat id is 777. Ask the owner to add you, or send /link &lt;code&gt; with the code shown in Settings → Telegram.",
        ]);
      },
    );
  });

  it("7. the offset is saved past an update BEFORE it runs: a handler that throws, or never returns, is not run again", async () => {
    // The first update's handler throws before its command runs (the grant
    // read happens while its capabilities are built).
    let seen: number | null = null;
    let reads = 0;
    await withService(
      {
        allowlist: [555],
        script: firstPoll((h) => {
          h.onGrantRead = () => {
            reads += 1;
            if (reads === 1) {
              seen = h.state().offset;
              throw new Error("boom");
            }
          };
          return [text(41, 555, "/reminders"), text(42, 555, "/reminders")];
        }),
      },
      async (h) => {
        assert.equal(seen, 42, "saved past update 41 before its handler ran");
        assert.ok(h.notes.includes("Telegram: error handling message — boom"));
        assert.equal(h.sentTo(555).length, 1);
        assert.match(h.sentTo(555)[0]!, /no reminders set/, "and the next update still ran");
        await h.advance(1_000);
        assert.equal(h.polls()[1]!.body.offset, 43);
      },
    );

    // The crash: a trade whose submit never returns, as if the process died
    // mid-trade. What is on disk already says it was taken, so a restart asks
    // past it and the trade cannot run twice.
    let onDisk: TelegramState | null = null;
    await withService(
      {
        allowlist: [555],
        script: firstPoll((h) => {
          h.onTrade = () => new Promise<string>(() => {});
          return [text(50, 555, "/buy NVDA 5")];
        }),
      },
      async (h) => {
        assert.deepEqual(h.trades, ["buy NVDA 5"], "premise: the trade is in flight");
        assert.equal(h.state().offset, 51);
        onDisk = h.state();
      },
    );
    await withService({ allowlist: [555], state: onDisk! }, async (h) => {
      assert.equal(h.polls()[0]!.body.offset, 51, "the restart does not ask for the /buy again");
    });
  });

  it("a stale button press is answered as expired and runs nothing", async () => {
    await withService(
      { allowlist: [555], script: firstPoll(() => [press(1, 555, HOURS_AGO(1))]) },
      async (h) => {
        const pressed = h.calls.find((c) => c.method === "answerCallbackQuery");
        assert.equal(pressed?.body.text, "That button has expired.");
        assert.equal(h.kills + h.trades.length + h.transfers.length, 0);
      },
    );
  });

  it("what was sent while Telegram was switched off is backlog when it is switched back on", async () => {
    let served = false;
    await withService(
      {
        allowlist: [555],
        script: (c) => {
          if (c.method !== "getUpdates" || served || c.at < T0 + 60_000) return undefined;
          served = true;
          return ok([text(1, 555, "/buy NVDA 5", NOW + 30)]);
        },
      },
      async (h) => {
        h.cfg.telegramEnabled = false;
        await h.advance(50_000);
        h.cfg.telegramEnabled = true; // /buy was sent at +30s, while nobody listened
        await h.advance(20_000);
        assert.ok(served);
        assert.deepEqual(h.trades, []);
        assert.match(h.sentTo(555)[0]!, SUMMARY);
      },
    );
  });
});

const HOUR_MS = 3_600_000;
const BAD_GATEWAY: Reply = { status: 502, body: { ok: false, error_code: 502, description: "Bad Gateway" } };
const REVOKED: Reply = { status: 401, body: { ok: false, error_code: 401, description: "Unauthorized" } };

/**
 * What the owner sent into an hour-long silence, the way it arrives when the
 * bot is heard again: five guesses at codes long gone and a /buy, all dated
 * inside the silence, then the code the dashboard shows now, typed live.
 */
const silenceBatch = (h: Harness) => [
  ...[1, 2, 3, 4, 5].map((i) => text(i, 999, `/link WRONG${i}`, NOW + 3_600)),
  text(6, 555, "/buy NVDA 5", NOW + 3_600),
  text(7, 999, `/link ${h.state().linkCode}`),
];

/** Neither half of the incident: nothing bought, one summary, one late-code notice, and the live code links. */
function assertHeldAndLinked(h: Harness): void {
  assert.deepEqual(h.trades, [], "no trade from the silence");
  const to555 = h.sentTo(555);
  assert.equal(to555.length, 1);
  // Past an offset this process asked from before the silence, or after a
  // first poll that came back: nothing in it can have run, and it says so.
  assert.equal(to555[0], "I was offline; 1 message arrived late (oldest 13:00 UTC). I didn't act on it — resend anything you still need.");
  const to999 = h.sentTo(999);
  assert.equal(to999.filter((t) => LATE_CODE.test(t)).length, 1, "one late-code notice for five guesses");
  assert.ok(!to999.some((t) => LOCKED.test(t)), "the guesses from the silence counted toward nothing");
  assert.match(to999.at(-1)!, LINKED);
  assert.deepEqual(h.state().linkedChats, [999]);
}

describe("a silence inside this process re-arms the backlog boundary", () => {
  it("hours of 502s: what waited through them is backlog, not live", async () => {
    let served = false;
    await withService(
      {
        allowlist: [555],
        script: (c, h) => {
          if (c.method !== "getUpdates") return undefined;
          if (c.at === T0) return ok([]); // listening, armed at T0
          if (c.at < T0 + 2 * HOUR_MS) return BAD_GATEWAY;
          if (served) return undefined;
          served = true;
          return ok(silenceBatch(h));
        },
      },
      async (h) => {
        await h.advance(2 * HOUR_MS + 90_000, 1_000);
        assert.ok(served, "premise: the backlog was handed over");
        assert.ok(h.notes.some((n) => /receiving updates again after 2h/.test(n)), "premise: an outage, in this process");
        assertHeldAndLinked(h);
      },
    );
  });

  it("a revoked token's 401s, then a renewed secret for the same bot: the 401s were the silence", async () => {
    // 0xfe0db6 in the plan: a token revoked in BotFather loops on 401 until
    // the owner pastes the new one.
    let served = false;
    await withService(
      {
        allowlist: [555],
        script: (c, h) => {
          if (c.method !== "getUpdates") return undefined;
          if (c.token === "111:a") return c.at === T0 ? ok([]) : REVOKED;
          if (served) return undefined;
          served = true;
          return ok(silenceBatch(h));
        },
      },
      async (h) => {
        await h.advance(2 * HOUR_MS, 1_000);
        h.cfg.telegramBotToken = "111:b";
        await h.advance(20_000);
        assert.ok(served, "premise: the renewed secret polled");
        assert.equal(h.polls().at(-1)!.token, "111:b");
        assertHeldAndLinked(h);
      },
    );
  });

  it("a poll loop that throws for minutes (telegram.json unwritable) is a silence too", async () => {
    let served = false;
    await withService(
      {
        allowlist: [555],
        script: (c) => {
          if (c.method !== "getUpdates") return undefined;
          if (c.at === T0 || served) return undefined;
          served = true;
          return ok([text(1, 555, "/buy NVDA 5", NOW + 60)]);
        },
      },
      async (h) => {
        h.stateWriteFails = true;
        await h.advance(180_000);
        assert.ok(h.notes.some((n) => /^Telegram: poll loop — ENOSPC/.test(n)), "premise: the loop threw");
        assert.equal(h.polls().length, 1, "premise: nothing was heard while it did");
        h.stateWriteFails = false;
        await h.advance(70_000);
        assert.ok(served);
        assert.deepEqual(h.trades, []);
        assert.match(h.sentTo(555)[0]!, SUMMARY);
      },
    );
  });

  it("a blip the backoff retries within seconds is not a silence: what was typed into it runs", async () => {
    // Whoever typed it is still waiting for the answer. Holding it would only
    // make them type it again.
    let failed = false;
    let served = false;
    await withService(
      {
        allowlist: [555],
        script: (c) => {
          if (c.method !== "getUpdates" || c.at === T0) return undefined;
          if (!failed) {
            failed = true;
            return BAD_GATEWAY;
          }
          if (served) return undefined;
          served = true;
          return ok([text(1, 555, "/buy NVDA 5", NOW + 1)]);
        },
      },
      async (h) => {
        await h.advance(5_000);
        assert.ok(failed && served);
        assert.deepEqual(h.trades, ["buy NVDA 5"]);
        assert.ok(!h.sentTo(555).some((t) => SUMMARY.test(t)));
      },
    );
  });

  it("one read of settings.json caught half-written is not Telegram switched off", async () => {
    // The orchestrator rewrites the file every 15 seconds, and a torn read
    // parses as the defaults, Telegram off. Taken at its word, the owner's
    // /buy in the idle gap after it was held as if the bot had been off.
    let served = false;
    await withService(
      {
        allowlist: [555],
        script: (c) => {
          if (c.method !== "getUpdates" || c.at === T0 || served) return undefined;
          served = true;
          return ok([text(1, 555, "/buy NVDA 5", NOW + 3)]);
        },
      },
      async (h) => {
        h.cfg.telegramEnabled = false;
        await h.advance(600); // one poll reads it
        h.cfg.telegramEnabled = true;
        await h.advance(9_000);
        assert.ok(served, "premise: the next poll came after the idle gap");
        assert.ok(h.polls()[1]!.at >= T0 + 8_000, "premise: that one read did idle the loop");
        assert.deepEqual(h.trades, ["buy NVDA 5"]);
        assert.ok(!h.sentTo(555).some((t) => SUMMARY.test(t)));
      },
    );
  });
});

describe("the config is read per update; the batch keeps its token", () => {
  it("a chat removed on the dashboard mid-batch is refused from its next message", async () => {
    const poll = firstPoll(() => [text(1, 555, "/reminders"), text(2, 555, "/reminders")]);
    await withService(
      {
        allowlist: [555],
        script: (c, h) => {
          if (c.method === "sendMessage" && c.body.chat_id === 555) h.cfg.telegramAllowlist = [];
          return poll(c, h);
        },
      },
      async (h) => {
        assert.match(h.sentTo(555)[0]!, /no reminders set/);
        assert.match(h.sentTo(555)[1]!, /not authorized — your chat id is 555/);
      },
    );
  });

  it("a token changed mid-batch stops the batch; the rest is asked for again and answered through the new token", async () => {
    const pending = [text(1, 555, "/reminders"), text(2, 555, "/reminders")];
    let confirmed = 0;
    await withService(
      {
        allowlist: [555],
        script: (c, h) => {
          if (c.method === "sendMessage" && c.token === "111:a") h.cfg.telegramBotToken = "111:b";
          if (c.method !== "getUpdates") return undefined;
          // Telegram as it behaves: forgotten only once a later poll asks past it.
          confirmed = Math.max(confirmed, Number(c.body.offset ?? 0));
          return ok(pending.filter((u) => u.update_id >= confirmed));
        },
      },
      async (h) => {
        await h.advance(1_000);
        const replies = h.calls.filter((c) => c.method === "sendMessage");
        assert.deepEqual(
          replies.map((c) => c.token),
          ["111:a", "111:b"],
          "update 2 was not answered through the old token",
        );
        assert.equal(h.polls()[1]!.body.offset, 2, "saved past update 1 only");
        assert.equal(h.polls()[1]!.token, "111:b");
      },
    );
  });
});

describe("/start <code>, the deep link", () => {
  it("from a chat not on the allowlist, the current code links it, and the code rotates", async () => {
    let code = "";
    await withService(
      {
        script: firstPoll((h) => {
          code = h.state().linkCode;
          return [text(1, 999, `/start ${code}`)];
        }),
      },
      async (h) => {
        assert.match(h.sentTo(999)[0]!, LINKED);
        assert.deepEqual(h.state().linkedChats, [999]);
        assert.equal(h.state().ownerId, 999);
        assert.notEqual(h.state().linkCode, code);
      },
    );
  });

  it("five wrong deep links lock the chat like five wrong /link", async () => {
    await withService(
      {
        script: firstPoll((h) => [
          ...[1, 2, 3, 4, 5].map((i) => text(i, 999, `/start WRONG${i}`)),
          text(6, 999, `/start ${h.state().linkCode}`),
        ]),
      },
      async (h) => {
        assert.equal(h.sentTo(999).length, 6);
        assert.match(h.sentTo(999)[5]!, LOCKED);
        assert.deepEqual(h.state().linkedChats, []);
      },
    );
  });

  it("from an allowlisted chat it is help, and a wrong payload counts toward nothing", async () => {
    await withService(
      {
        allowlist: [555],
        script: firstPoll((h) => [
          ...[1, 2, 3, 4, 5].map((i) => text(i, 555, `/start WRONG${i}`)),
          text(6, 555, `/link ${h.state().linkCode}`),
        ]),
      },
      async (h) => {
        const to555 = h.sentTo(555);
        assert.equal(to555.length, 6);
        for (const t of to555.slice(0, 5)) assert.doesNotMatch(t, /couldn't link/);
        assert.match(to555[5]!, LINKED, "five payloads later, the chat is not locked");
      },
    );
  });

  it("a bare /start or /help from a stranger gets the way in, with their chat id and nothing about the agent", async () => {
    await withService({ script: firstPoll(() => [text(1, 999, "/start"), text(2, 998, "/help")]) }, async (h) => {
      assert.deepEqual(h.sentTo(999), [
        "This is a private Merrymen bot. If it's yours, send the /link code shown in Settings → Telegram. Your chat id is 999.",
      ]);
      assert.deepEqual(h.sentTo(998), [
        "This is a private Merrymen bot. If it's yours, send the /link code shown in Settings → Telegram. Your chat id is 998.",
      ]);
    });
  });

  it("a stale deep link is a late code like a stale /link: not used, not counted", async () => {
    await withService(
      { state: { linkCode: "ABCDEF" }, script: firstPoll(() => [text(1, 999, "/start ABCDEF", HOURS_AGO(6))]) },
      async (h) => {
        assert.match(h.sentTo(999)[0]!, LATE_CODE);
        assert.deepEqual(h.state().linkedChats, []);
        assert.equal(h.state().linkCode, "ABCDEF");
      },
    );
  });
});

describe("a stranger's voice note", () => {
  it("gets the same refusal as a typed message: their chat id and where the code is", async () => {
    const voice = { update_id: 1, message: { voice: { file_id: "v1" }, date: NOW, chat: { id: 777 }, from: { id: 777 } } };
    await withService({ script: firstPoll(() => [voice]) }, async (h) => {
      assert.deepEqual(h.sentTo(777), [
        "🚫 not authorized — your chat id is 777. Ask the owner to add you, or send /link &lt;code&gt; with the code shown in Settings → Telegram.",
      ]);
    });
  });
});

describe("a code from before random codes", () => {
  it("is retired on the way up: the code the old scheme derived from this token, printed into the logs, links nobody", async () => {
    // U8D9W3 is what 350d0882 minted for "111:a" at round 0, and what index.ts
    // printed into the fleet's logs for a tenant that had not linked. The
    // orchestrator restores it from the mirror like any other code.
    await withService(
      { state: { linkCode: "U8D9W3" }, script: firstPoll(() => [text(1, 4242, "/link U8D9W3")]) },
      async (h) => {
        assert.deepEqual(h.sentTo(4242), ["couldn't link: bad or expired code"]);
        assert.equal(h.state().ownerId, null);
        assert.deepEqual(h.state().linkedChats, []);
        assert.match(h.state().linkCode, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
        assert.notEqual(h.state().linkCode, "U8D9W3");
        assert.ok(h.notes.includes("Telegram: the link code was one derived from the bot token, so it was re-minted"));
        assert.ok(!h.notes.some((n) => n.includes(h.state().linkCode) || n.includes("U8D9W3")), "and neither code is logged");
      },
    );
  });

  it("a random code restored the same way is kept, and links", async () => {
    await withService(
      { state: { linkCode: "ABCDEF" }, script: firstPoll(() => [text(1, 4242, "/link ABCDEF")]) },
      async (h) => {
        assert.match(h.sentTo(4242)[0]!, LINKED);
        assert.equal(h.state().ownerId, 4242);
        assert.ok(!h.notes.some((n) => /re-minted/.test(n)));
      },
    );
  });
});
