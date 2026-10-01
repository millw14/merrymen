/** Real notifier passes over a private home, with Telegram and timers replaced. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
import type { TelegramState } from "./state";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-drawdown-alert-"));
process.env.MERRYMEN_HOME = HOME;
process.env.MERRYMEN_GRANT_FILE = path.join(HOME, "grant.json");
process.env.MERRYMEN_DASHBOARD_URL = "https://app.merrymen.dev";
after(() => rmSync(HOME, { recursive: true, force: true }));
afterEach(() => mock.restoreAll());

const { startNotifier } = await import("./notifier");
const { makeChatTally } = await import("./poll-rules");

const NOW = Math.floor(Date.parse("2026-10-01T15:00:00Z") / 1000);
const OWNER = 123_456_789;
const KEY = "drawdown-halted:500";
const RETRY_SEC = 30 * 60;
const COOLDOWN_SEC = 6 * 3600;
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const GRANT = JSON.stringify({
  smartAccount: ACCOUNT,
  owner: "0x2222222222222222222222222222222222222222",
  sessionKeyAddress: "0x3333333333333333333333333333333333333333",
  serialized: "test-only-permission",
  chainId: 4663,
  grantedAt: NOW,
  expiresAt: NOW + 14 * 86400,
  caps: { perTradeUsdg: 25, dailyUsdg: 100, expiryDays: 14, maxDrawdownPct: 5, maxOpsPerDay: 20 },
});
type Send = { at: number; url: string; body: { chat_id: number; text: string; reply_markup?: unknown } };
type DeliveryChange = "owner" | "unlink" | "notifications" | "token";

async function withNotifier(
  drawdownBps: number,
  accepted: boolean,
  check: (h: {
    sends: Send[];
    logs: string[];
    state: () => TelegramState;
    setAccepted: (value: boolean) => void;
    advance: (seconds: number) => Promise<void>;
    assertCapsUnchanged: () => void;
  }) => Promise<void>,
  deliveryChange?: DeliveryChange,
) {
  const maxActionUsdg = deliveryChange ? 1 : 25;
  const settings = JSON.stringify({ llmMaxActionUsdg: maxActionUsdg, telegramMaxActionUsdg: 25 });
  writeFileSync(path.join(HOME, "grant.json"), GRANT);
  writeFileSync(path.join(HOME, "settings.json"), settings);
  let time = NOW;
  const sends: Send[] = [];
  const logs: string[] = [];
  const notes: string[] = [];
  let state: TelegramState = {
    offset: 0, botId: "123", priorBots: [], tokenTag: null, boundAt: null,
    chatSettings: null, linkCode: "", linkRound: 0, ownerId: OWNER, linkedAt: null,
    linkedChats: [], linkedChatAt: {}, messageCount: 0, lastNotifiedTradeId: 0,
    lastTradeDigestAt: 0, lastRemedyRule: null, firedAlerts: {}, signWatch: null,
    lastDigestDate: "", lastJournalDate: "", priceAlerts: [], reminders: [],
    watchers: [], nextId: 1, poll: null,
  };
  const initialCfg = {
    telegramEnabled: true, telegramBotToken: "123:TEST", telegramNotifyEnabled: true,
    telegramNotifyEveryMin: 0, telegramDigestHour: 99, tickSeconds: 60,
    customTokens: [], telegramPcControlEnabled: false, telegramCapabilities: [],
    llmMaxActionUsdg: maxActionUsdg, telegramMaxActionUsdg: 25,
  };
  let cfg = Object.freeze(initialCfg);
  mock.method(console, "log", (...args: unknown[]) => void logs.push(args.map(String).join(" ")));
  mock.method(globalThis, "fetch", async (url: unknown, init?: { body?: string }) => {
    assert.match(String(url), /^https:\/\/api\.telegram\.org\/bot(?:123|456):TEST\/sendMessage$/, "only the fake Telegram API is used");
    sends.push({ at: time, url: String(url), body: JSON.parse(init?.body ?? "{}") as Send["body"] });
    if (sends.length === 1 && deliveryChange) {
      // The owner changes delivery settings while the first condition awaits
      // Telegram. The later drawdown alert must not use the old pass's scope.
      await new Promise((resolve) => setImmediate(resolve));
      if (deliveryChange === "owner") state = { ...state, ownerId: OWNER + 1 };
      if (deliveryChange === "unlink") state = { ...state, ownerId: null };
      if (deliveryChange === "notifications") cfg = Object.freeze({ ...cfg, telegramNotifyEnabled: false });
      if (deliveryChange === "token") cfg = Object.freeze({ ...cfg, telegramBotToken: "456:TEST" });
    }
    return new Response(JSON.stringify(accepted
      ? { ok: true, result: { message_id: sends.length } }
      : { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }),
    { status: accepted ? 200 : 403 });
  });
  mock.timers.enable({ apis: ["setTimeout"] });
  const settle = async () => {
    for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(notes, [], "the notifier pass completes without an exception");
  };
  const handle = startNotifier({
    getCfg: () => cfg as never,
    note: (_level, message) => notes.push(message),
    stateRef: { get: () => state, set: (next) => { state = next; } },
    buildStatusContext: () => ({
      name: "Robin", strategy: "s", venue: "v", paused: false,
      workerAliveSec: 0, grant: null, chainId: 4663, telegramMaxActionUsdg: 25,
    }),
    getAlertInputs: () => ({
      grantExpiresAt: NOW + 14 * 86400, maxActionUsdg, cashUsdg: 100,
      drawdownBps, breakerBps: 500, gasWei: null,
    }),
    getChainId: () => 4663,
    getAgentId: () => ACCOUNT,
    tally: makeChatTally((_level, message) => logs.push(message), () => time),
    now: () => time,
  });
  try {
    await settle();
    await check({
      sends, logs, state: () => state,
      setAccepted: (value) => { accepted = value; },
      advance: async (seconds) => {
        time += seconds;
        mock.timers.tick(seconds * 1000);
        await settle();
      },
      assertCapsUnchanged: () => {
        assert.equal(readFileSync(path.join(HOME, "grant.json"), "utf8"), GRANT, "the signed grant remains byte-for-byte unchanged");
        assert.equal(readFileSync(path.join(HOME, "settings.json"), "utf8"), settings, "the configured action limits remain unchanged");
        assert.equal(cfg.llmMaxActionUsdg, maxActionUsdg);
        assert.equal(cfg.telegramMaxActionUsdg, 25);
        assert.equal(state.chatSettings, null, "notification cannot queue a settings change");
      },
    });
  } finally {
    handle.stop();
    mock.timers.reset();
  }
}

describe("drawdown alerts through the real notifier", () => {
  it("explains how the 5% halt clears without suggesting a wider limit or changing the grant", async () => {
    await withNotifier(1561, true, async (h) => {
      assert.equal(h.sends.length, 1);
      const sent = h.sends[0]!.body;
      const text = sent.text.replace(/<[^>]*>/g, "");
      assert.equal(sent.chat_id, OWNER);
      assert.match(text, /stopped buying/);
      assert.match(text, /15\.6%/);
      assert.match(text, /below 5\.0%/i, "recovery only needs to take drawdown below the configured threshold");
      assert.match(text, /\/grant#resign/);
      assert.match(text, /review[^.]*drawdown limit/i);
      assert.match(text, /renew[^.]*(?:same|unchanged)[^.]*limit[^.]*(?:won.t|does not) clear/i);
      assert.match(text, /(?:this )?drawdown (?:rule|limit)[^.]*SELL/i, "SELL exemption is scoped to this drawdown rule");
      assert.doesNotMatch(text, /exits are unaffected|I can still SELL|all sells|above the high-water mark/i);
      assert.doesNotMatch(text, /(?:wider|higher) drawdown limit|(?:raise|widen|increase)[^.]*limit/i);
      assert.equal(h.state().firedAlerts[KEY], NOW);
      h.assertCapsUnchanged();
    });
  });

  it("halts at exactly 500 bps and keeps the six-hour successful-send cooldown", async () => {
    await withNotifier(500, true, async (h) => {
      assert.equal(h.sends.length, 1);
      assert.match(h.sends[0]!.body.text, /stopped buying/);
      assert.equal(h.state().firedAlerts[KEY], NOW);
      await h.advance(COOLDOWN_SEC - 15);
      assert.equal(h.sends.length, 1, "no repeat before six hours");
      await h.advance(15);
      assert.equal(h.sends.length, 2, "still halted at equality, so the six-hour reminder is sent");
      assert.equal(h.state().firedAlerts[KEY], NOW + COOLDOWN_SEC);
      h.assertCapsUnchanged();
    });
  });

  it("warns without claiming a halt at 499 bps", async () => {
    await withNotifier(499, true, async (h) => {
      assert.equal(h.sends.length, 1);
      assert.match(h.sends[0]!.body.text, /drawdown warning/i);
      assert.doesNotMatch(h.sends[0]!.body.text, /stopped buying/i);
      assert.equal(h.state().firedAlerts[KEY], undefined);
      assert.equal(h.state().firedAlerts.drawdown, NOW);
      h.assertCapsUnchanged();
    });
  });

  it("retries a refused alert after 30 minutes and starts six hours only from delivery", async () => {
    await withNotifier(1561, false, async (h) => {
      assert.equal(h.sends.length, 1, "Telegram refused the first attempt");
      assert.equal(h.state().firedAlerts[KEY], undefined, "a refused attempt is not recorded as sent");
      assert.ok(h.logs.some((line) => /not delivered/.test(line)));
      assert.ok(!h.logs.some((line) => line.includes(`condition alert sent — ${KEY}`)), "no false success log");

      h.setAccepted(true);
      await h.advance(15);
      assert.equal(h.sends.length, 1, "do not retry on the next notifier pass");
      await h.advance(RETRY_SEC - 30);
      assert.equal(h.sends.length, 1, "still waiting fifteen seconds before retry");
      assert.equal(h.state().firedAlerts[KEY], undefined);
      await h.advance(15);
      assert.equal(h.sends.length, 2, "retry at exactly thirty minutes succeeds");
      const deliveredAt = NOW + RETRY_SEC;
      assert.equal(h.sends[1]!.at, deliveredAt);
      assert.equal(h.state().firedAlerts[KEY], deliveredAt, "record the actual successful delivery time");
      assert.equal(h.logs.filter((line) => line.includes(`condition alert sent — ${KEY}`)).length, 1);

      await h.advance(COOLDOWN_SEC - RETRY_SEC);
      assert.equal(h.sends.length, 2, "six hours from the failed attempt is too soon");
      await h.advance(RETRY_SEC - 15);
      assert.equal(h.sends.length, 2, "the success cooldown is still active");
      await h.advance(15);
      assert.equal(h.sends.length, 3, "repeat six hours after actual delivery");
      assert.equal(h.state().firedAlerts[KEY], deliveredAt + COOLDOWN_SEC);
      h.assertCapsUnchanged();
    });
  });

  for (const change of ["owner", "unlink", "notifications", "token"] as const) {
    it(`does not send or stamp later conditions after ${change} changes during delivery`, async () => {
      await withNotifier(1561, true, async (h) => {
        assert.equal(h.sends.length, 1, "only the earlier condition was already in flight");
        assert.match(h.sends[0]!.body.text, /per-trade limit/i);
        assert.deepEqual(h.state().firedAlerts, {}, "the old scope's delivery does not stamp the current scope");
        assert.ok(!h.logs.some((line) => /condition alert sent/.test(line)));
        await h.advance(15);
        if (change === "owner" || change === "token") {
          assert.equal(h.sends.length, 3, "both conditions can reach the new recipient on its first pass");
          const next = h.sends.slice(1);
          assert.ok(next.every((send) => send.body.chat_id === (change === "owner" ? OWNER + 1 : OWNER)));
          assert.ok(next.every((send) => send.url.includes(change === "token" ? "bot456:TEST/" : "bot123:TEST/")));
          assert.equal(h.state().firedAlerts[KEY], NOW + 15);
          assert.equal(h.state().firedAlerts["action-ceiling:1"], NOW + 15);
        } else {
          assert.equal(h.sends.length, 1, "unlinking or disabling notifications stops later sends");
          assert.deepEqual(h.state().firedAlerts, {});
        }
        h.assertCapsUnchanged();
      }, change);
    });
  }
});
