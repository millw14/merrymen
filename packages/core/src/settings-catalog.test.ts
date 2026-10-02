import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CHAT_ROUTE_KEYS,
  PROPOSAL_MAX_CHANGES,
  SETTINGS_CATALOG,
  buildProposal,
  catalogEntry,
  catalogEntryFor,
  decodeProposalLink,
  encodeProposalLink,
  parseCatalogValue,
  proposalRoute,
  riskWarning,
  understandSettingsText,
  validCatalogValue,
} from "./settings-catalog";
import { RISK_PROFILES } from "./risk-level";

const entry = (k: string) => catalogEntry(k)!;
const parse = (k: string, raw: string) => parseCatalogValue(entry(k), raw, { symbols: ["NVDA", "QQQ", "TSLA", "AAPL"] });
const value = (k: string, raw: string) => {
  const r = parse(k, raw);
  assert.ok(r.ok, `${k} "${raw}": ${r.ok ? "" : r.reason}`);
  return r.value;
};

describe("the catalog", () => {
  it("names every setting once, with a place on the page and a way to approve it", () => {
    const keys = SETTINGS_CATALOG.map((s) => s.key);
    assert.equal(new Set(keys).size, keys.length, "no key twice");
    for (const s of SETTINGS_CATALOG) {
      assert.ok(s.label && s.help && s.where, s.key);
      assert.ok(["chat", "dashboard", "sealed", "secret"].includes(s.route), s.key);
      if (["usd", "pct", "int", "minutes", "seconds", "hoursAsSec", "hour"].includes(s.kind)) {
        assert.ok(s.min !== undefined && s.max !== undefined && s.min <= s.max, `${s.key} has bounds`);
      }
      if (s.kind === "enum") assert.ok(s.values?.length, `${s.key} has values`);
    }
  });

  it("the chat route is exactly the keys the Telegram chat could already change, and no real-money switch", () => {
    // Pinned against SETTING_SPECS in the worker (settings-catalog.test.ts
    // there); here, the property that matters most.
    for (const k of CHAT_ROUTE_KEYS) {
      const s = entry(k);
      assert.equal(s.risk, undefined, `${k} carries a risk and must not be approved from a chat`);
    }
    for (const k of ["liveTradingEnabled", "trencherLiveEnabled", "scoutEnabled", "classSnipeEnabled", "minPoolLiquidityUsdg", "telegramNotifyEnabled", "telegramTransferEnabled"]) {
      assert.equal(entry(k).route, "dashboard", k);
    }
  });

  it("finds a setting by key, label or the words owners use", () => {
    assert.equal(catalogEntryFor("buyPerTickUsdg")?.key, "buyPerTickUsdg");
    assert.equal(catalogEntryFor("Amount per buy")?.key, "buyPerTickUsdg");
    assert.equal(catalogEntryFor("stop loss")?.key, "strategistStopLossBps");
    assert.equal(catalogEntryFor("launchpad buying")?.key, "classSnipeEnabled");
    assert.equal(catalogEntryFor("real money")?.key, "liveTradingEnabled");
    assert.equal(catalogEntryFor("something else entirely"), null);
  });
});

describe("parseCatalogValue — the owner's words in, the stored value out", () => {
  it("reads dollars however they are written", () => {
    for (const raw of ["20", "$20", "20 usdg", "20 dollars", "$ 20"]) assert.equal(value("buyPerTickUsdg", raw), 20, raw);
    assert.equal(value("idleFloorUsdg", "1,500"), 1500);
    assert.equal(value("memecoinMinFdvUsd", "1.5m"), 1_500_000);
    assert.equal(value("memecoinMinFdvUsd", "250k"), 250_000);
  });

  it("stores percentages as basis points, and 'off' as 0 where 0 means off", () => {
    assert.equal(value("strategistStopLossBps", "8%"), 800);
    assert.equal(value("takeProfitBps", "25 percent"), 2500);
    assert.equal(value("slippageBps", "0.5%"), 50);
    assert.equal(value("takeProfitBps", "off"), 0);
  });

  it("reads times in the unit each setting stores", () => {
    assert.equal(value("telegramNotifyEveryMin", "once an hour"), 60);
    assert.equal(value("telegramNotifyEveryMin", "hourly"), 60);
    assert.equal(value("telegramNotifyEveryMin", "every 15 minutes"), 15);
    assert.equal(value("telegramNotifyEveryMin", "every trade"), 0);
    assert.equal(value("classMaxHoldSec", "6h"), 21_600);
    assert.equal(value("classMaxHoldSec", "2 days"), 172_800);
    assert.equal(value("tickSeconds", "30"), 30);
    assert.equal(value("tickSeconds", "1 minute"), 60);
    assert.equal(value("llmIntervalMin", "2h"), 120);
  });

  it("reads an hour of the day", () => {
    assert.equal(value("telegramDigestHour", "8am"), 8);
    assert.equal(value("telegramDigestHour", "8pm"), 20);
    assert.equal(value("telegramDigestHour", "12am"), 0);
  });

  it("reads switches, choices and baskets", () => {
    assert.equal(value("discoveryEnabled", "on"), true);
    assert.equal(value("discoveryEnabled", "Off"), false);
    assert.equal(value("assetMode", "only stocks"), "stocks");
    assert.equal(value("assetMode", "memecoins"), "crypto");
    assert.equal(value("strategy", "dip hunter"), "dip-hunter");
    assert.deepEqual(value("basketSymbols", "nvda, qqq and tsla"), ["NVDA", "QQQ", "TSLA"]);
  });

  it("REFUSES rather than clamps, and says why", () => {
    const tooSmall = parse("buyPerTickUsdg", "0");
    assert.equal(tooSmall.ok, false);
    assert.match(tooSmall.ok ? "" : tooSmall.reason, /can't go below \$1\.00/);
    assert.equal(parse("slippageBps", "50%").ok, false, "slippage tops out at 10%");
    assert.equal(parse("basketSymbols", "DOGEWIF").ok, false, "an unknown ticker");
    assert.equal(parse("discoveryEnabled", "maybe").ok, false);
    assert.equal(parse("tickSeconds", "5").ok, false, "15 seconds is the floor");
  });

  it("holds the agent's name to the rule /name applies", () => {
    assert.equal(value("agentName", "  Will   Scarlet "), "Will Scarlet");
    assert.equal(parse("agentName", "007").ok, false, "at least one letter");
    assert.equal(parse("agentName", "a name far longer than twenty-four").ok, false, "24 characters at most");
    assert.equal(validCatalogValue("agentName", "<b>x</b>"), false);
  });

  it("never takes a secret from a message", () => {
    const r = parse("llmApiKey", "sk-ant-api03-very-secret");
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.reason, /never taken from a message/);
  });
});

describe("understandSettingsText — the way owners actually say it", () => {
  const keys = (t: string) => Object.fromEntries(buildProposal(understandSettingsText(t), {}).rows.map((r) => [r.key, r.after]));

  it("several settings in one sentence", () => {
    assert.deepEqual(keys("make each buy $20 and stop loss at 8%, take profit 25%"), {
      buyPerTickUsdg: 20,
      strategistStopLossBps: 800,
      takeProfitBps: 2500,
    });
  });

  it("an intent becomes the bundle it means", () => {
    assert.deepEqual(keys("be more careful"), RISK_PROFILES.careful.settings);
    assert.deepEqual(keys("I want you to be more aggressive"), RISK_PROFILES.bold.settings);
  });

  it("a number the owner named beats the bundle's own", () => {
    const k = keys("be careful, but each buy $15");
    assert.equal(k.buyPerTickUsdg, 15);
    assert.equal(k.strategistStopLossBps, RISK_PROFILES.careful.settings.strategistStopLossBps);
  });

  it("what to trade, real money and messages, in plain words", () => {
    assert.deepEqual(keys("only buy stocks"), { assetMode: "stocks" });
    assert.deepEqual(keys("go live"), { liveTradingEnabled: true });
    assert.deepEqual(keys("stop using real money"), { liveTradingEnabled: false, paperTradingEnabled: true });
    assert.deepEqual(keys("trade messages once an hour"), { telegramNotifyEveryMin: 60 });
    assert.deepEqual(keys("you message me too many messages"), { telegramNotifyEveryMin: 60 });
    assert.deepEqual(keys("hunt memecoins"), { strategy: "trencher", assetMode: "crypto", discoveryEnabled: true });
  });

  it("the key=value shape a model is asked for", () => {
    assert.deepEqual(keys("buyPerTickUsdg=20; takeProfitBps=25%; classSnipeEnabled=on"), {
      buyPerTickUsdg: 20,
      takeProfitBps: 2500,
      classSnipeEnabled: true,
    });
  });

  it("skips what it cannot read, rather than guessing", () => {
    assert.deepEqual(keys("what's the weather like"), {});
    assert.deepEqual(keys("stop loss whenever you feel like it"), {});
  });
});

describe("buildProposal", () => {
  const current = { buyPerTickUsdg: 25, strategistStopLossBps: 0, liveTradingEnabled: false, assetMode: "all" };

  it("says before and after in the owner's words", () => {
    const p = buildProposal([{ key: "buyPerTickUsdg", raw: "$20" }, { key: "strategistStopLossBps", raw: "8%" }], current);
    assert.deepEqual(p.rows.map((r) => [r.key, r.beforeText, r.afterText]), [
      ["buyPerTickUsdg", "$25.00", "$20.00"],
      ["strategistStopLossBps", "off", "8%"],
    ]);
    assert.equal(proposalRoute(p.rows), "chat");
  });

  it("one dashboard-only change sends the whole proposal to the dashboard", () => {
    const p = buildProposal([{ key: "buyPerTickUsdg", raw: "$20" }, { key: "liveTradingEnabled", raw: "on" }], current);
    assert.equal(proposalRoute(p.rows), "dashboard");
    const live = p.rows.find((r) => r.key === "liveTradingEnabled")!;
    assert.equal(riskWarning(live.risk, live.after), "This lets the agent spend real money.");
  });

  it("refuses secrets, sealed limits and lists, each with where to go", () => {
    const p = buildProposal([{ key: "llmApiKey", raw: "sk-123" }, { key: "perTradeCap", raw: "50" }, { key: "customTokens", raw: "0xabc" }], current);
    assert.equal(p.rows.length, 0);
    assert.deepEqual(p.refused.map((r) => r.route), ["secret", "sealed", "dashboard"]);
    assert.match(p.refused[0]!.reason, /never send/);
    assert.match(p.refused[1]!.reason, /new signature/);
  });

  it("drops a change to what it already is, and a self-hosted-only switch on hosted", () => {
    assert.equal(buildProposal([{ key: "assetMode", raw: "everything" }], current).rows.length, 0);
    const p = buildProposal([{ key: "telegramAgentEnabled", raw: "on" }], current, { hosted: true });
    assert.equal(p.rows.length, 0);
    assert.match(p.refused[0]!.reason, /self-hosted/);
  });
});

describe("the dashboard approval link", () => {
  it("round-trips the changes it carries", () => {
    const rows = [{ key: "buyPerTickUsdg", after: 20 }, { key: "liveTradingEnabled", after: true }, { key: "basketSymbols", after: ["NVDA"] }];
    assert.deepEqual(decodeProposalLink(encodeProposalLink(rows)), rows.map((r) => ({ key: r.key, value: r.after })));
  });

  it("drops anything a hand-made link could slip in: secrets, bad values, unknown keys, duplicates", () => {
    const forged = Buffer.from(JSON.stringify({ v: 1, changes: [
      ["llmApiKey", "sk-steal"],
      ["buyPerTickUsdg", 0],
      ["slippageBps", 50_000],
      ["notASetting", true],
      ["takeProfitBps", 2500],
      ["takeProfitBps", 9999],
    ] })).toString("base64url");
    assert.deepEqual(decodeProposalLink(forged), [{ key: "takeProfitBps", value: 2500 }]);
    assert.deepEqual(decodeProposalLink("not-base64-json"), []);
    assert.deepEqual(decodeProposalLink(null), []);
  });

  it("never encodes a secret, and carries at most a handful of changes", () => {
    assert.equal(validCatalogValue("telegramBotToken", "123:abc"), false);
    const many = SETTINGS_CATALOG.filter((s) => s.kind === "bool").map((s) => ({ key: s.key, after: true }));
    assert.ok(decodeProposalLink(encodeProposalLink(many)).length <= PROPOSAL_MAX_CHANGES);
  });
});
