import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CHAT_SETTING_KEYS, DASHBOARD_ONLY, formatSettingValue, parseSettingValue, specFor, stockSymbols, validStoredSetting, SETTING_SPECS } from "./setting-spec";
import { SETTING_CHOICES } from "./interpreter";

const spec = (k: string) => specFor(k)!;

describe("parseSettingValue — owner words in, stored value out", () => {
  it("reads dollars however they are written", () => {
    for (const raw of ["20", "$20", "20 usdg", "20.00", "$ 20 dollars"]) {
      assert.deepEqual(parseSettingValue(spec("buyPerTickUsdg"), raw), { ok: true, value: 20 }, raw);
    }
    assert.deepEqual(parseSettingValue(spec("idleFloorUsdg"), "1,500"), { ok: true, value: 1500 });
  });

  it("REFUSES out of range rather than clamping — the resolver would silently use the default", () => {
    const r = parseSettingValue(spec("buyPerTickUsdg"), "0");
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /can't go below \$1\.00/);
    assert.equal(parseSettingValue(spec("slippageBps"), "50%").ok, false, "slippage tops out at 10%");
  });

  it("stores percentages as basis points", () => {
    assert.deepEqual(parseSettingValue(spec("takeProfitBps"), "25%"), { ok: true, value: 2500 });
    assert.deepEqual(parseSettingValue(spec("strategistStopLossBps"), "7.5"), { ok: true, value: 750 });
    assert.equal(formatSettingValue(spec("takeProfitBps"), 2500), "25%");
    assert.equal(formatSettingValue(spec("strategistStopLossBps"), 0), "off (0%)");
  });

  it("reads on/off, and refuses anything else", () => {
    assert.deepEqual(parseSettingValue(spec("discoveryEnabled"), "on"), { ok: true, value: true });
    assert.deepEqual(parseSettingValue(spec("discoveryEnabled"), "Off"), { ok: true, value: false });
    assert.equal(parseSettingValue(spec("discoveryEnabled"), "maybe").ok, false);
  });

  it("stores hold time in seconds from hours, minutes or days", () => {
    assert.deepEqual(parseSettingValue(spec("classMaxHoldSec"), "6h"), { ok: true, value: 21_600 });
    assert.deepEqual(parseSettingValue(spec("classMaxHoldSec"), "30m"), { ok: true, value: 1_800 });
    assert.deepEqual(parseSettingValue(spec("classMaxHoldSec"), "2 days"), { ok: true, value: 172_800 });
    assert.equal(formatSettingValue(spec("classMaxHoldSec"), 21_600), "6h");
  });

  it("a whole-number setting refuses a fraction", () => {
    assert.equal(parseSettingValue(spec("classExitAtGraduationPct"), "2.5").ok, false);
  });

  it("the WHOLE text must be the value — a plausible misreading is refused, not stored", () => {
    for (const [k, raw] of [
      ["takeProfitBps", "50 bps"],
      ["takeProfitBps", "0,5%"],
      ["buyPerTickUsdg", "2x"],
      ["buyPerTickUsdg", "twenty is $20"],
      ["classMaxHoldSec", "6h then sell"],
    ] as const) {
      const r = parseSettingValue(spec(k), raw);
      assert.equal(r.ok, false, `${k} "${raw}" should be refused`);
      assert.match((r as { reason: string }).reason, /didn't understand/);
    }
  });

  it("minutes take the words people use for time", () => {
    assert.deepEqual(parseSettingValue(spec("telegramNotifyEveryMin"), "once an hour"), { ok: true, value: 60 });
    assert.deepEqual(parseSettingValue(spec("telegramNotifyEveryMin"), "every trade"), { ok: true, value: 0 });
    assert.deepEqual(parseSettingValue(spec("telegramNotifyEveryMin"), "2h"), { ok: true, value: 120 });
    assert.deepEqual(parseSettingValue(spec("llmIntervalMin"), "15 minutes"), { ok: true, value: 15 });
    assert.equal(parseSettingValue(spec("llmIntervalMin"), "every trade").ok, false, "0 is below this one's floor");
  });

  it("the report hour takes am/pm", () => {
    assert.deepEqual(parseSettingValue(spec("telegramDigestHour"), "6pm"), { ok: true, value: 18 });
    assert.deepEqual(parseSettingValue(spec("telegramDigestHour"), "12am"), { ok: true, value: 0 });
  });

  it("'max launch coins held' refuses 0 — stored 0 means NO limit", () => {
    const r = parseSettingValue(spec("classMaxPositions"), "0");
    assert.equal(r.ok, false);
  });

  it("the basket is stored in the spelling the resolver matches exactly", () => {
    assert.deepEqual(parseSettingValue(spec("basketSymbols"), "qqq and wbtc", ["QQQ", "wBTC"]), { ok: true, value: ["QQQ", "wBTC"] });
  });

  it("builds a basket only from tickers it can trade, and says which it could not", () => {
    const allowed = ["QQQ", "NVDA", "TSLA"];
    assert.deepEqual(parseSettingValue(spec("basketSymbols"), "qqq, nvda and $TSLA", allowed), {
      ok: true,
      value: ["QQQ", "NVDA", "TSLA"],
    });
    const r = parseSettingValue(spec("basketSymbols"), "QQQ, DOGE", allowed);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /DOGE/);
  });

  it("the basket's known tickers come from the stock-token table", () => {
    assert.ok(stockSymbols().length > 0);
  });
});

describe("validStoredSetting — the promotion-time check", () => {
  it("accepts exactly what parseSettingValue produces for every setting", () => {
    const samples: Record<string, string> = {
      strategy: "trencher",
      assetMode: "stocks",
      basketSymbols: "QQQ",
      officialCoinsEnabled: "on",
      discoveryEnabled: "off",
      telegramNotifyEnabled: "on",
      takeProfitBps: "10%",
      strategistStopLossBps: "5%",
      slippageBps: "1%",
      classMaxHoldSec: "6h",
    };
    for (const s of SETTING_SPECS) {
      const raw = samples[s.key] ?? String(s.min ?? 1);
      const parsed = parseSettingValue(s, raw);
      assert.ok(parsed.ok, `${s.key} failed to parse "${raw}"`);
      assert.ok(validStoredSetting(s.key, (parsed as { value: unknown }).value), `${s.key} parsed to a value its own check refuses`);
    }
  });

  it("refuses keys it does not know", () => {
    assert.equal(validStoredSetting("liveTradingEnabled", true), false);
  });
});

describe("Telegram groups are asked about, never set, by text", () => {
  const GROUP_KEYS = ["telegramGroupsEnabled", "telegramGroupCoinsEnabled", "telegramGroupsChattiness"];

  it("none of the three is in the chat-settable table, so no value for one is ever valid to store", () => {
    // validStoredSetting is the check a promotion runs; a key outside the
    // table fails it whatever the value, which is what keeps a room from
    // reaching these through a child's chatSettings.
    for (const k of GROUP_KEYS) {
      assert.equal(specFor(k), null, `${k} became chat-settable`);
      assert.ok(!CHAT_SETTING_KEYS.includes(k), `${k} is in CHAT_SETTING_KEYS`);
      for (const v of [true, false, "quiet", "normal", "chatty"]) assert.equal(validStoredSetting(k, v), false, `${k}=${String(v)}`);
    }
  });

  it("one dashboard-only pseudo-key answers for all three, with the Settings path in its words", () => {
    const said = DASHBOARD_ONLY.telegramGroups;
    assert.ok(said, "DASHBOARD_ONLY.telegramGroups is missing");
    assert.match(said, /^Telegram groups are switched in Settings → Telegram/);
    // Nothing here is a real settings key, so the classifier cannot confuse a
    // refusal with a change.
    assert.equal(specFor("telegramGroups"), null);
  });

  it("the classifier may name it, so an owner's 'groups off' reaches the refusal rather than 'unknown'", () => {
    assert.ok(SETTING_CHOICES.includes("telegramGroups"));
    for (const k of GROUP_KEYS) assert.ok(!SETTING_CHOICES.includes(k), `${k} is a classifier choice`);
  });
});
