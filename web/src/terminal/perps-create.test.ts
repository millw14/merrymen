import assert from "node:assert/strict";
import { test } from "node:test";
import { PERPS_STYLE_CATALOG } from "@merrymen/core";
import { perpsCreationSettings, PERPS_CREATE_PERMISSION_DAYS, PERPS_CREATE_TRADE_USDG } from "./perps-create";

test("every profile creates an owner-bound paper-only account, without enabling spot or live trading", () => {
  for (const profile of PERPS_STYLE_CATALOG) {
    const markets = ["BTC-PERP", "ETH-PERP"];
    const settings = perpsCreationSettings({ name: " Scout ", style: profile.id, markets, perTradeUsdg: 25, owner: "0xowner" });
    assert.equal(settings.owner, "0xowner");
    assert.equal(settings.agentName, "Scout");
    assert.equal(settings.strategy, "perps-only");
    assert.equal(settings.perpsStyle, profile.id);
    assert.equal(settings.perpsDriver, "perp-trend");
    assert.equal(settings.liveTradingEnabled, false);
    assert.equal(settings.perpsLiveEnabled, false);
    assert.equal(settings.paperTradingEnabled, true);
    assert.equal(settings.perpsEnabled, true);
    assert.equal(settings.scoutEnabled, false);
    assert.equal(settings.classSnipeEnabled, false);
    assert.equal(settings.perpsPerTradeUsdg, 25);
    assert.equal(settings.perpsMaxLeverage, 2);
    assert.equal(settings.perpsStopLossPct, 5);
    markets.push("SOL-PERP");
    assert.deepEqual(settings.perpsMarkets, ["BTC-PERP", "ETH-PERP"]);
    assert.ok(!("perpsLiveConsentVersion" in settings));
    assert.ok(PERPS_CREATE_PERMISSION_DAYS * 24 > profile.maxHoldHours, "new permission must leave room for this profile to enter before its full holding horizon");
    assert.equal(PERPS_CREATE_TRADE_USDG, settings.perpsPerTradeUsdg);
  }
});

test("invalid profile, unsupported or empty markets, and invalid risk values do not make a settings write", () => {
  const input = { name: "Scout", style: "swing-trend" as const, markets: ["BTC-PERP"], perTradeUsdg: 10, owner: null };
  for (const patch of [{ style: "invented" }, { markets: [] }, { markets: ["NVDA-PERP"] }, { markets: ["BTC-PERP", "BTC-PERP"] }, { perTradeUsdg: NaN }, { perTradeUsdg: 9 }, { perTradeUsdg: 10.001 }]) {
    assert.throws(() => perpsCreationSettings({ ...input, ...patch } as typeof input));
  }
});
