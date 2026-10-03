import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mock, test } from "node:test";
import {
  REFUSAL_KEYS_KEPT,
  REFUSAL_REMIND_LATER_SEC,
  REFUSAL_REMIND_SEC,
  refusalCountLine,
  refusalKey,
  refusalVerdict,
  sweepRefusals,
  startNotifier,
  tradeDigestLine,
  tradeLine,
} from "./notifier";
import { loadTelegramState, parseRefusalRepeats, type RefusalRepeat } from "./state";
import type { ResolvedConfig } from "../settings";

const NOTIFY_OWNER = 123_456_789;
const NOTIFY_AGENT = "0x00000000000000000000000000000000000000aa";
const NOTIFY_OTHER = "0x00000000000000000000000000000000000000bb";
const NOTIFY_NOW = Math.floor(Date.parse("2026-10-03T12:00:00Z") / 1000);
const NOTIFY_PERIOD_MIN = 5;

interface NotifyTradeExtra {
  fillCash?: number | null;
  fillSide?: string | null;
  decisionId?: string;
  opHash?: string;
  createdAt?: number;
}

/** Exercise the real read-only ledger query, cursor writes and scheduled passes. */
async function withNotifier(
  run: (h: {
    add: (id: number, agent: string, kind: string, status: string, amount?: number, extra?: NotifyTradeExtra) => void;
    decision: (id: string, agent: string, symbol: string, reason: string) => void;
    start: () => Promise<void>;
    nextPeriod: () => Promise<void>;
    state: () => ReturnType<typeof loadTelegramState>;
    sends: Array<{ chatId: number; text: string }>;
    prompts: string[];
  }) => Promise<void>,
  options: { agentId?: string | null; immediate?: boolean; narrate?: boolean } = {},
): Promise<void> {
  const home = mkdtempSync(path.join(tmpdir(), "merrymen-notifier-digest-"));
  const priorHome = process.env.MERRYMEN_HOME;
  const priorFetch = globalThis.fetch;
  process.env.MERRYMEN_HOME = home;
  const db = new DatabaseSync(path.join(home, "merrymen.db"));
  db.exec(`CREATE TABLE trades (
    id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
    amount_usdg REAL NOT NULL, reject_rule TEXT, tx_hash TEXT, decision_id TEXT, target TEXT,
    fill_side TEXT, fill_cash_usdg REAL, realized_pnl_usdg REAL, sell_token TEXT, buy_token TEXT,
    user_op_hash TEXT, created_at INTEGER NOT NULL
  ); CREATE TABLE agents (smart_account TEXT PRIMARY KEY, live_blocker TEXT);
  CREATE TABLE decisions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, symbol TEXT, action TEXT, reason TEXT);`);
  let clock = NOTIFY_NOW;
  let state: ReturnType<typeof loadTelegramState> = { ...loadTelegramState(), ownerId: NOTIFY_OWNER, lastNotifiedTradeId: 0 };
  const sends: Array<{ chatId: number; text: string }> = [];
  const prompts: string[] = [];
  const notes: string[] = [];
  globalThis.fetch = (async (url, init) => {
    if (String(url) === "https://model.test/v1/chat/completions") {
      assert.ok(options.narrate, "a model is used only by the narration fixture");
      prompts.push(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "I followed the recorded reason." } }] }), { status: 200 });
    }
    assert.match(String(url), /^https:\/\/api\.telegram\.org\/bot123:TEST\/sendMessage$/u, "only the fake Telegram transport is used");
    const body = JSON.parse(String(init?.body)) as { chat_id: number; text: string };
    sends.push({ chatId: body.chat_id, text: body.text });
    return new Response(JSON.stringify({ ok: true, result: { message_id: sends.length } }), { status: 200 });
  }) as typeof fetch;
  const cfg = {
    telegramEnabled: true, telegramBotToken: "123:TEST", telegramNotifyEnabled: true,
    telegramNotifyEveryMin: options.immediate ? 0 : NOTIFY_PERIOD_MIN, telegramDigestHour: 99, tickSeconds: 60,
    customTokens: [], telegramPcControlEnabled: false, telegramCapabilities: [],
    ...(options.narrate ? { llmProvider: "custom", llmApiKey: "TEST-KEY", llmBaseUrl: "https://model.test/v1", llmProviderModel: "test" } : {}),
  } as unknown as ResolvedConfig;
  let handle: ReturnType<typeof startNotifier> | undefined;
  const settle = async () => {
    for (let i = 0; i < 50; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(notes, [], "the notifier pass completed without swallowing a query failure");
  };
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await run({
      add: (id, agent, kind, status, amount = 0, extra = {}) => {
        const cash = extra.fillCash === undefined ? status === "landed" || status === "paper" ? amount : null : extra.fillCash;
        const side = extra.fillSide === undefined ? kind === "swap" && (status === "landed" || status === "paper") ? "buy" : null : extra.fillSide;
        db.prepare("INSERT INTO trades (id, agent_id, kind, status, amount_usdg, fill_cash_usdg, decision_id, fill_side, user_op_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(id, agent, kind, status, amount, cash, extra.decisionId ?? null, side, extra.opHash ?? null, extra.createdAt ?? clock);
      },
      decision: (id, agent, symbol, reason) => {
        db.prepare("INSERT INTO decisions (id, agent_id, symbol, action, reason) VALUES (?, ?, ?, 'buy', ?)").run(id, agent, symbol, reason);
      },
      start: async () => {
        assert.equal(handle, undefined, "one notifier per fixture");
        handle = startNotifier({
          getCfg: () => cfg,
          stateRef: { get: () => state, set: (next) => { state = next; } },
          note: (_level, message) => notes.push(message),
          buildStatusContext: () => ({ name: "Robin", strategy: "s", venue: "v", paused: false, workerAliveSec: 0, grant: null, chainId: 4663, telegramMaxActionUsdg: 25 }),
          getAlertInputs: () => ({ grantExpiresAt: null, maxActionUsdg: null, cashUsdg: null, drawdownBps: null, breakerBps: null, gasWei: null }),
          getChainId: () => null,
          getAgentId: () => options.agentId === undefined ? NOTIFY_AGENT : options.agentId,
          now: () => clock,
        });
        await settle();
      },
      nextPeriod: async () => {
        assert.ok(handle);
        clock += NOTIFY_PERIOD_MIN * 60;
        mock.timers.tick(15_000);
        await settle();
      },
      state: () => state,
      sends,
      prompts,
    });
  } finally {
    handle?.stop();
    mock.timers.reset();
    globalThis.fetch = priorFetch;
    if (priorHome === undefined) delete process.env.MERRYMEN_HOME;
    else process.env.MERRYMEN_HOME = priorHome;
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
}

test("quiet notifier counts real trades in a mixed batch, excludes key installs and another tenant, and does not replay them", async () => {
  await withNotifier(async (h) => {
    h.add(1, NOTIFY_AGENT, "key-install", "landed");
    h.add(2, NOTIFY_AGENT, "swap", "landed", 25);
    h.add(3, NOTIFY_AGENT, "swap", "paper", 7.5);
    h.add(4, NOTIFY_AGENT, "swap", "rejected", 9);
    h.add(5, NOTIFY_AGENT, "swap", "reverted", 3);
    h.add(6, NOTIFY_OTHER, "swap", "landed", 999);
    h.add(7, NOTIFY_OTHER, "key-install", "landed");
    await h.start();
    assert.equal(h.sends.length, 1);
    assert.equal(h.sends[0]!.chatId, NOTIFY_OWNER);
    assert.match(h.sends[0]!.text, /1× landed \(25\.00 USDG\)/u);
    assert.match(h.sends[0]!.text, /1× paper \(7\.50 USDG\)/u);
    assert.match(h.sends[0]!.text, /1× turned back/u);
    assert.match(h.sends[0]!.text, /1× didn't go through/u);
    assert.doesNotMatch(h.sends[0]!.text, /key-install|permissions|999|2× landed|0\.00 USDG/u);
    assert.equal(h.state().lastNotifiedTradeId, 7, "the global high-water advances past filtered rows too");
    assert.equal(h.state().lastTradeDigestAt, NOTIFY_NOW);
    await h.nextPeriod();
    assert.equal(h.sends.length, 1, "a scheduled pass does not replay the batch");
    assert.equal(h.state().lastTradeDigestAt, NOTIFY_NOW + NOTIFY_PERIOD_MIN * 60);
  });
});

test("quiet notifier consumes install-only batches without a trade summary and later retains a real trade", async () => {
  await withNotifier(async (h) => {
    h.add(1, NOTIFY_AGENT, "key-install", "landed");
    h.add(2, NOTIFY_AGENT, "key-install", "rejected");
    h.add(3, NOTIFY_OTHER, "swap", "landed", 999);
    await h.start();
    assert.equal(h.sends.length, 0);
    assert.equal(h.state().lastNotifiedTradeId, 3);
    assert.equal(h.state().lastTradeDigestAt, NOTIFY_NOW);
    h.add(4, NOTIFY_AGENT, "key-install", "landed");
    await h.nextPeriod();
    assert.equal(h.sends.length, 0);
    assert.equal(h.state().lastNotifiedTradeId, 4);
    h.add(5, NOTIFY_AGENT, "swap", "landed", 6.25);
    await h.nextPeriod();
    assert.equal(h.sends.length, 1);
    assert.match(h.sends[0]!.text, /1× landed \(6\.25 USDG\)/u);
    assert.doesNotMatch(h.sends[0]!.text, /2× landed|3× landed|permissions|999/u);
    assert.equal(h.state().lastNotifiedTradeId, 5);
  });
});

test("an unarmed quiet notifier never digests another tenant's trades", async () => {
  await withNotifier(async (h) => {
    h.add(1, NOTIFY_AGENT, "swap", "landed", 25);
    h.add(2, NOTIFY_OTHER, "swap", "paper", 999);
    await h.start();
    assert.deepEqual(h.sends, []);
    assert.equal(h.state().lastNotifiedTradeId, 2);
    h.add(3, NOTIFY_OTHER, "swap", "landed", 888);
    await h.nextPeriod();
    assert.deepEqual(h.sends, []);
    assert.equal(h.state().lastNotifiedTradeId, 3);
  }, { agentId: null });
});

test("quiet notifier sums measured live and paper cash, marking missing fill cash unknown rather than spent", async () => {
  await withNotifier(async (h) => {
    h.add(1, NOTIFY_AGENT, "key-install", "landed");
    h.add(2, NOTIFY_AGENT, "swap", "landed", 25, { fillCash: 20 });
    h.add(3, NOTIFY_AGENT, "swap", "landed", 777, { fillCash: null });
    h.add(4, NOTIFY_AGENT, "swap", "landed", 8, { fillCash: 0 });
    h.add(5, NOTIFY_AGENT, "swap", "paper", 35, { fillCash: 7.5 });
    h.add(6, NOTIFY_AGENT, "swap", "paper", 888, { fillCash: null });
    h.add(7, NOTIFY_AGENT, "swap", "rejected", 9);
    h.add(8, NOTIFY_OTHER, "swap", "landed", 999);
    await h.start();
    assert.equal(h.sends.length, 1);
    assert.match(h.sends[0]!.text, /3× landed \(20\.00 USDG measured; 1 amount unknown\)/u);
    assert.match(h.sends[0]!.text, /2× paper \(7\.50 USDG measured; 1 amount unknown\)/u);
    assert.match(h.sends[0]!.text, /1× turned back/u);
    assert.doesNotMatch(h.sends[0]!.text, /25\.00|35\.00|777|888|999/u);
    assert.equal(h.state().lastNotifiedTradeId, 8);
    h.add(9, NOTIFY_AGENT, "swap", "landed", 111, { fillCash: null });
    await h.nextPeriod();
    assert.equal(h.sends.length, 2);
    assert.match(h.sends[1]!.text, /1× landed \(amount unknown\)/u);
    assert.doesNotMatch(h.sends[1]!.text, /0\.00 USDG|111/u, "missing fill evidence is not a zero or the requested amount");
  });
});

test("the immediate notifier never narrates a foreign decision attached to an own fill", async () => {
  await withNotifier(async (h) => {
    h.decision("foreign-decision", NOTIFY_OTHER, "SECRET", "PRIVATE_FOREIGN_PLAN");
    h.decision("own-decision", NOTIFY_AGENT.toUpperCase(), "OWN", "OWN_RECORDED_REASON");
    h.add(1, NOTIFY_AGENT, "swap", "landed", 25, { decisionId: "foreign-decision" });
    h.add(2, NOTIFY_AGENT, "swap", "paper", 7, { decisionId: "own-decision" });
    h.add(3, NOTIFY_OTHER, "swap", "landed", 999, { decisionId: "foreign-decision" });
    await h.start();
    assert.equal(h.sends.length, 2, "the own receipts remain available, including the orphaned decision link");
    assert.ok(h.sends.every((send) => send.chatId === NOTIFY_OWNER));
    assert.equal(h.prompts.length, 1, "the mismatched decision cannot supply narration evidence");
    assert.match(h.prompts[0]!, /OWN_RECORDED_REASON/u);
    assert.doesNotMatch(JSON.stringify({ sends: h.sends, prompts: h.prompts }), /PRIVATE_FOREIGN_PLAN|SECRET|999/u);
    assert.equal(h.state().lastNotifiedTradeId, 2);
  }, { immediate: true, narrate: true });
});

test("quiet notifier collapses mixed-case operation copies before excluding installs and retains independent paper fills and refusals", async () => {
  await withNotifier(async (h) => {
    h.add(1, NOTIFY_AGENT, "key-install", "landed", 0, { opHash: "0xABCD10" });
    h.add(2, NOTIFY_AGENT, "swap", "landed", 0, { opHash: "0xabcd10", fillSide: null, fillCash: null });
    h.add(3, NOTIFY_AGENT, "swap", "landed", 25, { opHash: "0xABCD20", fillCash: 20 });
    h.add(4, NOTIFY_AGENT, "swap", "landed", 25, { opHash: "0xabcd20", fillSide: null, fillCash: null });
    h.add(5, NOTIFY_AGENT, "swap", "paper", 7);
    h.add(6, NOTIFY_AGENT, "swap", "paper", 9);
    h.add(7, NOTIFY_AGENT, "swap", "rejected", 5);
    h.add(8, NOTIFY_AGENT, "swap", "rejected", 5);
    h.add(9, NOTIFY_OTHER, "swap", "landed", 999, { opHash: "0xABCD20" });
    await h.start();
    assert.equal(h.sends.length, 1);
    assert.match(h.sends[0]!.text, /1× landed \(20\.00 USDG\)/u);
    assert.match(h.sends[0]!.text, /2× paper \(16\.00 USDG\)/u);
    assert.match(h.sends[0]!.text, /2× turned back/u);
    assert.doesNotMatch(h.sends[0]!.text, /unknown|999|2× landed|3× landed|4× landed/u);
    assert.equal(h.state().lastNotifiedTradeId, 9, "the cursor consumes physical copies without counting them");
  });
});

test("late bare swap copies of a notified fill and install cannot create another quiet digest", async () => {
  await withNotifier(async (h) => {
    h.add(1, NOTIFY_AGENT, "key-install", "landed", 0, { opHash: "0xABCD10" });
    h.add(2, NOTIFY_AGENT, "swap", "landed", 25, { opHash: "0xABCD20", fillCash: 20 });
    await h.start();
    assert.equal(h.sends.length, 1);
    assert.match(h.sends[0]!.text, /1× landed \(20\.00 USDG\)/u);
    assert.equal(h.state().lastNotifiedTradeId, 2);
    const restartedAt = NOTIFY_NOW + NOTIFY_PERIOD_MIN * 60;
    h.add(3, NOTIFY_AGENT, "swap", "landed", 0, { opHash: "0xabcd10", fillSide: null, fillCash: null, createdAt: restartedAt });
    h.add(4, NOTIFY_AGENT, "swap", "landed", 25, { opHash: "0xabcd20", fillSide: null, fillCash: null, createdAt: restartedAt });
    h.add(5, NOTIFY_AGENT, "swap", "submitted", 25, { opHash: "0xAbCd20", fillSide: null, fillCash: null, createdAt: restartedAt });
    await h.nextPeriod();
    assert.equal(h.sends.length, 1, "collapse reaches back before the cursor and keeps the original kind/status");
    assert.equal(h.state().lastNotifiedTradeId, 5);
    h.add(6, NOTIFY_AGENT, "swap", "paper", 3);
    h.add(7, NOTIFY_AGENT, "swap", "paper", 3);
    h.add(8, NOTIFY_AGENT, "swap", "rejected", 9);
    h.add(9, NOTIFY_AGENT, "swap", "rejected", 9);
    await h.nextPeriod();
    assert.equal(h.sends.length, 2);
    assert.match(h.sends[1]!.text, /2× paper \(6\.00 USDG\)/u);
    assert.match(h.sends[1]!.text, /2× turned back/u);
    assert.doesNotMatch(h.sends[1]!.text, /landed/u);
    assert.equal(h.state().lastNotifiedTradeId, 9);
  });
});

test("immediate notifier emits one receipt per canonical operation and ignores later copies", async () => {
  await withNotifier(async (h) => {
    h.add(1, NOTIFY_AGENT, "key-install", "landed", 0, { opHash: "0xABCD10" });
    h.add(2, NOTIFY_AGENT, "swap", "landed", 0, { opHash: "0xabcd10", fillSide: null, fillCash: null });
    h.add(3, NOTIFY_AGENT, "swap", "landed", 25, { opHash: "0xABCD20", fillCash: 20 });
    h.add(4, NOTIFY_AGENT, "swap", "landed", 25, { opHash: "0xabcd20", fillSide: null, fillCash: null });
    await h.start();
    assert.equal(h.sends.length, 2);
    assert.match(h.sends[0]!.text, /Installed your trading key/u);
    assert.match(h.sends[1]!.text, /20\.00/u);
    assert.equal(h.state().lastNotifiedTradeId, 3);
    h.add(5, NOTIFY_AGENT, "swap", "landed", 0, { opHash: "0xAbCd10", fillSide: null, fillCash: null });
    h.add(6, NOTIFY_AGENT, "swap", "landed", 25, { opHash: "0xAbCd20", fillSide: null, fillCash: null });
    await h.nextPeriod();
    assert.equal(h.sends.length, 2);
    h.add(7, NOTIFY_AGENT, "swap", "paper", 5);
    await h.nextPeriod();
    assert.equal(h.sends.length, 3);
    assert.match(h.sends[2]!.text, /Practice trade.*no real money moved/u);
    assert.equal(h.state().lastNotifiedTradeId, 7);
  }, { immediate: true });
});

test("tradeDigestLine summarises only the non-empty status buckets", () => {
  const line = tradeDigestLine(
    [
      { status: "paper", c: 12, s: 75 },
      { status: "rejected", c: 3, s: 22.5 },
    ],
    15,
  );
  assert.match(line, /last 15m/);
  assert.match(line, /12× paper \(75\.00 USDG\)/);
  assert.match(line, /3× turned back/);
  assert.doesNotMatch(line, /landed/); // no landed bucket → not shown
});

test("tradeDigestLine labels periods nicely (m / h / d)", () => {
  assert.match(tradeDigestLine([{ status: "paper", c: 1, s: 6.25 }], 5), /last 5m/);
  assert.match(tradeDigestLine([{ status: "paper", c: 1, s: 6.25 }], 60), /last 1h/);
  assert.match(tradeDigestLine([{ status: "paper", c: 1, s: 6.25 }], 1440), /last 1d/);
});

test("tradeDigestLine with nothing new reads as quiet", () => {
  assert.match(tradeDigestLine([], 30), /quiet/);
});

/**
 * WHO GETS BLAMED when a trade does not go out.
 *
 * The wall is the owner's OWN sealed policy. Saying it turned a trade back when
 * the real cause was the house's gas sponsor declining sends them looking
 * through their settings for a fault that is not theirs — and there is nothing
 * they could change that would fix it.
 *
 * SponsorRefused carries a fixed three-word vocabulary, all prefixed `sponsor-`,
 * so the distinction is a prefix test rather than a guess at the text.
 */
test("a sponsor failure is not reported as the wall refusing", () => {
  for (const rule of ["sponsor-refused", "sponsor-unreachable", "sponsor-absurd"]) {
    const line = tradeLine(
      { id: 1, kind: "swap", amount_usdg: 25, status: "rejected", reject_rule: rule, tx_hash: null },
      null,
    );
    assert.doesNotMatch(line, /the wall/, `${rule} must not be blamed on the wall`);
    assert.match(line, /gas sponsor declined/);
    assert.match(line, /ours to fix/);
  }
});

test("OUR GAS CHECK IS NOT THE WALL — the ORBIO line an owner was sent", () => {
  // Reported: "🛡 the wall turned back a buy of ORBIO (gas-absurd) — 5.00 USDG
  // stayed home". The product declining to sign, blamed on the owner's own
  // sealed policy, with the slug as the whole explanation.
  const row = { id: 9, kind: "swap", amount_usdg: 5, status: "rejected", reject_rule: "gas-absurd", tx_hash: null };
  const line = tradeLine(row, null, false, { label: "ORBIO", side: "buy" });
  assert.doesNotMatch(line, /the wall/, "not the owner's wall");
  assert.match(line, /^⛽ a buy of ORBIO wasn't sent — its network fee estimate was far above what this trade should cost\. Nothing was spent\./);
  assert.match(line, /5\.00 USDG stayed home \(gas-absurd\)$/, "the slug survives for support");

  for (const rule of ["gas-unstable", "gas-unreadable", "gas-paymaster-unexpected", "enable-replayed", "enable-redundant", "enable-unverified", "prefund-unverified"]) {
    const l = tradeLine({ ...row, reject_rule: rule }, null, true);
    assert.doesNotMatch(l, /the wall/, rule);
    assert.doesNotMatch(l, /\/grant/, `${rule} has no owner remedy, so none is invented`);
    assert.match(l, new RegExp(`\\(${rule}\\)$`), rule);
  }
});

test("a wall too wide to install with its trade says the key installs itself, once", () => {
  // The old remedy sent the owner to re-sign, which seals the same wall: one
  // owner re-signed several times and was refused every tick regardless.
  const row = { id: 10, kind: "swap", amount_usdg: 5, status: "rejected", reject_rule: "enable-too-wide", tx_hash: null };
  const first = tradeLine(row, null, true, { label: "ORBIO", side: "buy" });
  assert.match(first, /too wide to install together with this trade/);
  assert.match(first, /No action needed: your agent installs its new permissions on their own first/);
  assert.doesNotMatch(first, /seals a narrower permission set that leaves room/, "the promise that was not true");
  assert.doesNotMatch(tradeLine(row, null, false), /\/grant/, "repeats carry no instruction");
});

test("a key installed on its own is said for what it is: no trade, nothing moved", () => {
  const row = { id: 12, kind: "key-install", amount_usdg: 0, status: "landed", reject_rule: null, tx_hash: "0xabc" };
  const line = tradeLine(row, "https://explorer.example", false, null);
  assert.match(line, /^🔑 Installed your trading key's permissions on their own\./);
  assert.match(line, /nothing was traded and nothing moved/);
  assert.match(line, /explorer\.example\/tx\/0xabc/);
  assert.doesNotMatch(line, /\$0\.00|key-install/, "not a trade of nothing, and not the slug");
});

test("NOR IS THE MARKET — the UBIK line an owner was sent", () => {
  // Reported: "🛡 the wall turned back a buy of UBIK — no route to trade it.
  // 10.00 USDG stayed home (no-route)". UBIK trades only on Uniswap v4, and the
  // owner's key did not carry the v4 adapter — a fact about where the coin
  // trades, which the line blamed on the permissions they signed.
  const row = { id: 11, kind: "swap", amount_usdg: 10, status: "rejected", reject_rule: "no-route", tx_hash: null };
  const first = tradeLine(row, null, true, { label: "UBIK", side: "buy" });
  assert.doesNotMatch(first, /the wall/, "not the owner's wall");
  assert.match(first, /^🚫 a buy of UBIK didn't go out — no route to trade it\. Nothing was spent\./);
  assert.match(first, /If it trades only on Uniswap v4 and your key doesn't carry the v4 adapter yet, save the V4SelfSwap adapter in \/settings and re-sign at \/grant/);
  assert.match(first, /10\.00 USDG stayed home \(no-route\)$/);
  assert.doesNotMatch(tradeLine(row, null, false, { label: "UBIK", side: "buy" }), /\/grant/, "repeats carry no instruction");

  for (const rule of ["no-quote", "no-liquidity", "slippage", "curve-graduated", "insufficient-balance"]) {
    const l = tradeLine({ ...row, reject_rule: rule }, null, true);
    assert.doesNotMatch(l, /the wall/, rule);
    assert.doesNotMatch(l, /\/grant/, `${rule} has no owner remedy, so none is invented`);
    assert.match(l, new RegExp(`\\(${rule}\\)$`), rule);
  }
});

test("a real wall refusal still says so, and now says WHAT", () => {
  // The unsponsored path, and the overwhelmingly common one. It must still
  // blame the wall — but it used to interpolate the raw rule, so this assertion
  // pinned `(per-trade-cap)` as the whole explanation. That is the bare slug
  // this channel was reported for.
  const line = tradeLine(
    { id: 2, kind: "swap", amount_usdg: 25, status: "rejected", reject_rule: "per-trade-cap", tx_hash: null },
    null,
  );
  assert.match(line, /the wall turned back a swap/);
  assert.match(line, /past the per-trade cap/, "the sentence, not the slug");
  assert.match(line, /\(per-trade-cap\)/, "the slug survives for support triage");
  assert.doesNotMatch(line, /sponsor/);
});

/**
 * THE REPORT THIS CHANNEL WAS ACTUALLY FIXED FOR.
 *
 * A beta owner pasted `refused: no-exit` and asked what it meant "if my agent
 * tries to buy some custom token i added". The chat arm in index.ts was
 * converted to the vocabulary; this one was not — and the chat arm only fires
 * when the owner TYPES an order. His question was about the autonomous tick,
 * which writes a rejected row that the poller turns into this push. So the one
 * surface that had been fixed was the one his question does not reach.
 */
test("DAVE'S CASE — an autonomous no-exit refusal explains itself and says how to fix it", () => {
  const row = {
    id: 3,
    kind: "swap",
    amount_usdg: 25,
    status: "rejected",
    reject_rule: "no-exit",
    tx_hash: null,
  };
  const first = tradeLine(row, null, true);
  assert.doesNotMatch(
    first,
    /turned back a swap \(no-exit\)/,
    "the bare slug as the whole explanation is the bug",
  );
  assert.match(first, /cannot sell that token/, "what went wrong, in words");
  assert.match(first, /\/grant/, "and what to do about it — this is the owner's own bot");
  assert.match(first, /\(no-exit\)/, "slug kept for triage");
  assert.match(first, /stayed home/, "and it still says nothing was spent");

  // REPEATS MUST NOT REPEAT THE INSTRUCTION. The strategist re-proposes the
  // same uncovered leg every tick, so the refusal recurs; telling him to
  // re-sign every time turns a fix into a flood.
  const again = tradeLine(row, null, false);
  assert.match(again, /cannot sell that token/, "still explains itself");
  assert.doesNotMatch(again, /\/grant/, "but the remedy is said once per rule");
});

test("an unknown rule still reaches the owner rather than vanishing", () => {
  // A rule minted next year has no entry. It must degrade to the old shape,
  // not to silence or to an empty sentence.
  const line = tradeLine(
    { id: 4, kind: "swap", amount_usdg: 5, status: "rejected", reject_rule: "a-rule-from-next-year", tx_hash: null },
    null,
    true,
  );
  assert.match(line, /a-rule-from-next-year/);
  assert.match(line, /stayed home/);
});

/**
 * THE ALERT FOR AN AGENT THAT IS WORKING PERFECTLY AND DOING NOTHING.
 *
 * A tester watched a funded, unblocked, live agent propose nothing for days and
 * reported it as broken. It was not: its effective ceiling —
 * `min(llmMaxActionUsdg, the per-trade cap sealed into the grant)` — was $1
 * against $46.75 of cash, so every window it correctly concluded there was
 * nothing worth buying at that size. The strategist wrote the reason out each
 * time ("the max action size ($1) is barely bigger than the position itself")
 * and it went only into prose nobody acts on.
 *
 * Every other condition alert reports something broken. This one reports a
 * setting quietly making a working agent look dead, which is why it needed
 * writing at all.
 */
const NOTIFIER = readFileSync(new URL("./notifier.ts", import.meta.url), "utf8");

test("the ceiling alert fires on the RATIO, not on a fixed floor", () => {
  // $1 is fine on a $20 book and absurd on a $50 one. The test is whether a
  // single action could move the book at all.
  assert.match(NOTIFIER, /inputs\.cashUsdg >= 20 \* inputs\.maxActionUsdg/);
});

test("it does not fire on paper, or when it cannot tell", () => {
  // Paper fabricates its numbers, and an unarmed agent has no ceiling — both
  // would be claims about something nobody measured.
  const block = NOTIFIER.slice(NOTIFIER.indexOf("A CEILING SO LOW"));
  const cond = block.slice(0, block.indexOf("await fire("));
  assert.match(cond, /!inputs\.paper/, "paper numbers are fabricated");
  assert.match(cond, /inputs\.maxActionUsdg !== null/);
  assert.match(cond, /inputs\.cashUsdg !== null/);
  assert.match(cond, /inputs\.maxActionUsdg > 0/, "a zero ceiling is a different problem");
});

test("the key carries the ceiling, so raising it and still stalling re-alerts", () => {
  // Keyed on the value rather than a bare name: an owner who raises $1 to $2 and
  // hits the same wall must hear about it, not be swallowed by a 6h cooldown
  // started by the message they already acted on.
  assert.match(NOTIFIER, /`action-ceiling:\$\{inputs\.maxActionUsdg\}`/);
});

test("the message names BOTH places the cap can live, and says nothing is broken", () => {
  // Whichever of the two is lower is the one that binds, and an owner told to
  // fix one of them may change it and see no difference at all.
  const msg = NOTIFIER.slice(NOTIFIER.indexOf("action-ceiling:"));
  const body = msg.slice(0, msg.indexOf("`,\n      );"));
  assert.match(body, /\/grant/, "the signed cap");
  assert.match(body, /LLM max per action/, "and the settings ceiling");
  assert.match(body, /whichever is lower/i, "because only one of them binds");
  assert.match(body, /[Nn]othing is broken/, "an agent behaving correctly must not read as a fault");
  assert.match(body, /renewal revokes old permissions and requires network fees/, "the owner must know renewal includes a paid on-chain revocation");
  assert.doesNotMatch(body, /\bfree\b|nothing moves/i);
});

test("the ceiling reported is the one that BINDS, not whichever is handier", () => {
  // The whole defect is that the binding cap can live in either of two places.
  // Dave's is $1 in a SIGNED GRANT — reporting `llmMaxActionUsdg` alone would
  // have told him a number he could not have changed by changing it, and
  // reporting the grant alone would lie to an owner whose settings are lower.
  const INDEX = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const supply = INDEX.slice(INDEX.indexOf("maxActionUsdg: active"));
  const expr = supply.slice(0, supply.indexOf("cashUsdg:"));
  assert.match(expr, /Math\.min\(/, "the lower of the two, or it is not the binding one");
  assert.match(expr, /cfg\.llmMaxActionUsdg/);
  assert.match(expr, /active\.limits\.perTradeUsdg/, "the signed cap is the half nobody could see");
  // Unarmed means no signed cap exists yet, so there is no binding ceiling to
  // report — null, not the settings value standing in for one.
  assert.match(expr, /active\s*\?/, "an unarmed agent has no ceiling to report");
  assert.match(expr, /:\s*null/);
});

/**
 * APPROACHING THE BREAKER AND HAVING ALREADY HIT IT ARE NOT ONE EVENT.
 *
 * Below the line the agent is still buying and the owner is being warned.
 * At or above it the agent has STOPPED buying — and its OWNER was never told.
 * The `drawdown-breaker` refusal writes a rejected row and logs
 * `[policy] REJECTED ...` for an operator, but raises no event and sends no
 * message. An operator log is not a notification: from the owner's side an
 * agent refusing every entry looks exactly like one with nothing to do.
 *
 * Measured on a live canary: it proposed a qualifying trade every tick for an
 * afternoon, each refused at 17.59% against a 5% cap, and the only thing its
 * owner ever saw was the same "drawdown warning" already read at 2.5%.
 */
test("a TRIPPED breaker gets its own message, not the same warning as 2.5%", () => {
  const block = NOTIFIER.slice(NOTIFIER.indexOf("APPROACHING THE BREAKER"));
  const arm = block.slice(0, block.indexOf("} else if"));
  assert.match(arm, /inputs\.drawdownBps >= inputs\.breakerBps\b/, "the halt arm tests the full cap");
  assert.match(arm, /stopped buying/i, "and says plainly that buying has stopped");
  // The warning arm must still exist, at half, and must not have been widened.
  const warn = block.slice(block.indexOf("} else if"));
  assert.match(warn, /inputs\.breakerBps \/ 2/, "the early warning still fires at half");
  assert.match(warn, /drawdown warning/);
});

test("the halt message describes recovery inside the signed limit without recommending a wider one", () => {
  const block = NOTIFIER.slice(NOTIFIER.indexOf("drawdown-halted:"));
  const body = block.slice(0, block.indexOf("`,\n        );"));
  assert.match(body, /high-water mark/, "names the reference");
  assert.match(body, /\/grant#resign/, "where the owner can review the current limit");
  assert.match(body, /Drawdown must fall below/, "policy clears strictly inside the cap");
  assert.match(body, /full recovery to the high-water mark is not required/);
  assert.match(body, /Renewing an unchanged limit does not clear/);
  assert.doesNotMatch(body, /re-signing a wider|Nothing is broken|exits are unaffected/);
  // Exits are exempt in policy.ts, so the message must not claim trading has
  // stopped outright — an owner who believes they cannot sell may panic.
  assert.match(body, /drawdown rule still permits SELL attempts/, "exemption is only from this rule, not a guarantee of execution");
});

test("the halt key carries the cap, so re-signing and still halting re-alerts", () => {
  assert.match(NOTIFIER, /`drawdown-halted:\$\{inputs\.breakerBps\}`/);
});

test("every condition alert that fires is observable", () => {
  // An alert that fires invisibly cannot be verified by anyone: asked whether
  // an owner had actually been told, there was nothing to look at but the
  // absence of a complaint. The KEY only — never the message body, which is
  // chat content.
  const end = NOTIFIER.indexOf(`// ── "SIGN NOW"`);
  assert.ok(end > 0, "the slice's end marker moved — re-anchor this test");
  const fire = NOTIFIER.slice(NOTIFIER.indexOf("const fire = "), end);
  assert.match(fire, /console\.log\(`\[notify\] condition alert sent — \$\{key\}`\)/);
  assert.doesNotMatch(fire, /console\.log\([^)]*\$\{message\}/, "the message body must not reach the log");
});

test("a dollar figure is escaped — '<$0.01' is a tag to Telegram's HTML parser", () => {
  const row = {
    id: 5, kind: "swap", amount_usdg: 0.003, status: "landed", reject_rule: null, tx_hash: null,
    fill_side: "sell", fill_cash_usdg: 0.003, realized_pnl_usdg: -4.997,
  };
  const line = tradeLine(row, null, false, { label: "RUG", side: "sell" });
  assert.doesNotMatch(line, /<\$/, "a raw '<$' would make Telegram refuse the whole message");
  assert.match(line, /&lt;\$0\.01/);
});

test("a near-total loss is never called a leftover", () => {
  const row = {
    id: 6, kind: "swap", amount_usdg: 0.003, status: "landed", reject_rule: null, tx_hash: null,
    fill_side: "sell", fill_cash_usdg: 0.003, realized_pnl_usdg: -4.997,
  };
  const line = tradeLine(row, null, false, { label: "RUG", side: "sell" });
  assert.doesNotMatch(line, /leftover/);
  assert.match(line, /Sold RUG for &lt;\$0\.01 \(−\$5\.00\)/);
});

test("with no coin, a ping says what KIND of move it was — a transfer is never 'a trade'", () => {
  const transfer = { id: 7, kind: "transfer", amount_usdg: 20, status: "landed", reject_rule: null, tx_hash: null };
  assert.match(tradeLine(transfer, null), /A transfer out of your account went through — \$20\.00/);
  const deposit = { ...transfer, kind: "vault-deposit" };
  assert.match(tradeLine(deposit, null), /move into your savings vault/);
});

/**
 * TWO HUNDRED OF THE SAME LINE. Reported 2026-10-02: "⛽ a buy of LARP wasn't
 * sent — its permission set is too wide to install together with this trade
 * … (enable-too-wide)", once per tick. Repeats of one refusal are counted, and
 * the count is what reaches the chat.
 */
const LARP = "0x00000000000000000000000000000000000000aa";
const larpRefusal = {
  id: 20, kind: "swap", amount_usdg: 20, status: "rejected", reject_rule: "enable-too-wide", tx_hash: null,
  target: "0xRouter", sell_token: "0xUSDG", buy_token: LARP,
};
const rec = (over: Partial<RefusalRepeat> = {}): RefusalRepeat => ({
  rule: "enable-too-wide", what: "buy of LARP", pushedAt: 1_000, lastAt: 1_000, held: 0, reminded: 0, ...over,
});

test("the same refusal re-sized next tick is still the same refusal", () => {
  const k = refusalKey(larpRefusal);
  assert.ok(k);
  assert.equal(refusalKey({ ...larpRefusal, id: 21, amount_usdg: 19.4 }), k, "size is not part of it");
  assert.equal(refusalKey({ ...larpRefusal, buy_token: LARP.replace("aa", "AA") }), k, "address case is not");
  assert.notEqual(refusalKey({ ...larpRefusal, reject_rule: "no-exit" }), k, "another rule is another refusal");
  assert.notEqual(refusalKey({ ...larpRefusal, buy_token: "0xbb" }), k, "another coin is another refusal");
  assert.notEqual(
    refusalKey({ ...larpRefusal, sell_token: LARP, buy_token: "0xUSDG" }),
    k,
    "selling it is not buying it",
  );
});

test("only a refusal is ever counted — fills and reverts are each sent", () => {
  for (const status of ["landed", "paper", "reverted", "submitted"]) {
    assert.equal(refusalKey({ ...larpRefusal, status }), null, status);
  }
});

test("the first row is sent; repeats are counted until the run has been quiet an hour", () => {
  assert.equal(refusalVerdict(undefined, 1_000), "send");
  assert.equal(refusalVerdict(rec(), 1_001), "count");
  // A slow strategist's next window is still the same run: counted, not re-sent.
  assert.equal(refusalVerdict(rec(), 1_000 + 40 * 60), "count");
  assert.equal(refusalVerdict(rec({ held: 3 }), 1_000 + 5 * REFUSAL_REMIND_SEC), "count", "an unsaid count is never dropped");
  assert.equal(refusalVerdict(rec(), 1_000 + REFUSAL_REMIND_SEC), "send", "nothing counted, an hour quiet: a new run");
});

test("a count is due an hour after the first line, then every six hours", () => {
  const at = (now: number, r: RefusalRepeat) => sweepRefusals({ k: r }, now);

  assert.deepEqual(at(1_000 + REFUSAL_REMIND_SEC - 1, rec({ held: 59 })).due, [], "not yet");
  const first = at(1_000 + REFUSAL_REMIND_SEC, rec({ held: 59, lastAt: 1_000 + REFUSAL_REMIND_SEC - 30 }));
  assert.deepEqual(first.due.map((r) => r.held), [59]);
  assert.deepEqual(first.keep.k, {
    ...rec({ lastAt: 1_000 + REFUSAL_REMIND_SEC - 30 }),
    pushedAt: 1_000 + REFUSAL_REMIND_SEC,
    reminded: 1,
  }, "reset, and the next one waits longer");

  const later = rec({ held: 7, reminded: 1, lastAt: 2_000 });
  assert.deepEqual(at(1_000 + REFUSAL_REMIND_SEC, later).due, [], "six hours after the last count, not one");
  assert.deepEqual(at(1_000 + REFUSAL_REMIND_LATER_SEC, later).due.map((r) => r.held), [7]);
});

test("a record with nothing to say is forgotten after a quiet hour; one with a count never is", () => {
  const now = 1_000 + 10 * REFUSAL_REMIND_SEC;
  const { keep } = sweepRefusals(
    {
      fresh: rec({ lastAt: now - 60, pushedAt: now - 60 }),
      quiet: rec({ lastAt: now - REFUSAL_REMIND_SEC }),
      owed: rec({ held: 2, reminded: 1, pushedAt: now - 60 }),
    },
    now,
  );
  assert.deepEqual(Object.keys(keep).sort(), ["fresh", "owed"]);
});

test("past the cap the oldest count is said, not lost", () => {
  const recs: Record<string, RefusalRepeat> = {};
  for (let i = 0; i <= REFUSAL_KEYS_KEPT; i += 1) recs[`k${i}`] = rec({ held: 1, lastAt: 10_000 + i, pushedAt: 10_000 });
  const { keep, due } = sweepRefusals(recs, 10_000 + REFUSAL_KEYS_KEPT + 1);
  assert.equal(Object.keys(keep).length, REFUSAL_KEYS_KEPT);
  assert.ok(!("k0" in keep), "the oldest goes");
  assert.equal(due.length, 1, "and its count is said");
});

test("the count line says how many, over how long, how recently — and how to fix it", () => {
  const now = 1_000 + REFUSAL_REMIND_SEC;
  const line = refusalCountLine(rec({ held: 59, lastAt: now - 20 }), now);
  assert.ok(
    line.startsWith("↻ the buy of LARP was refused 59 more times in the last 60 min (enable-too-wide), the last just now. "),
    line,
  );
  // Repeats mean installing the key alone did not clear it, so the line still
  // carries the one fix that is left.
  assert.match(line, /If this keeps repeating, re-sign at \/grant with fewer custom tokens or capabilities/);
  const stopped = refusalCountLine(rec({ held: 1, lastAt: 1_000 + 5 * 60 }), 1_000 + REFUSAL_REMIND_LATER_SEC);
  assert.match(stopped, /refused 1 more time in the last 6 hours \(enable-too-wide\), the last 6 hours ago\./);
  assert.doesNotMatch(
    refusalCountLine(rec({ held: 2, rule: "gas-absurd", what: "buy of ORBIO" }), now),
    /\/grant/,
    "no fix is invented for a rule that has none",
  );
});

test("a counted record read back from a file keeps only well-formed entries", () => {
  const good = rec({ held: 4 });
  assert.deepEqual(parseRefusalRepeats({ a: good, b: { ...good, held: -1 }, c: { ...good, what: 7 }, d: null }), { a: good });
  assert.deepEqual(parseRefusalRepeats(undefined), {});
  assert.deepEqual(parseRefusalRepeats([good]), {});
});
