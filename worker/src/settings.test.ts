import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { connectionKey, mergeSettings, perpsCeilingFor, perpsKey, strategyKey, telegramKey, stripHouseKeys, type ResolvedConfig } from "./settings";
import {
  HOSTED_FORBIDDEN_SETTING_FIELDS,
  HOUSE_KEY_FIELDS,
  PERPS_LIVE_CONSENT_VERSION,
  PERPS_NUM_BOUNDS,
  PERPS_SETTING_KEYS,
  SECRET_SETTING_KEYS,
  SETTINGS_DEFAULTS,
  TELEGRAM_GROUPS_CHATTINESS,
  isPerpKey,
  type MerrymenSettings,
  type PerpsNumKey,
} from "../../packages/core/src/index";

describe("mergeSettings — file > env > default", () => {
  it("fast Trencher is opt-in and rebuilds the strategy without enabling live trades", () => {
    const standard = mergeSettings({}, {});
    const fast = mergeSettings({ trencherFastEnabled: true }, {});
    assert.equal(standard.trencherFastEnabled, false);
    assert.equal(fast.trencherFastEnabled, true);
    assert.equal(fast.trencherLiveEnabled, false);
    assert.equal(fast.liveTradingEnabled, standard.liveTradingEnabled);
    assert.notEqual(strategyKey(standard), strategyKey(fast));
  });
  it("does not let an old slow tick setting silence decisions for more than five minutes", () => {
    assert.equal(mergeSettings({ tickSeconds: 300 }, {}).tickSeconds, 300);
    assert.ok(mergeSettings({ tickSeconds: 3600 }, {}).tickSeconds <= 300);
    assert.ok(mergeSettings({}, { MERRYMEN_TICK_SECONDS: "3600" }).tickSeconds <= 300);
  });
  it("defaults hold with nothing set", () => {
    const c = mergeSettings({}, {});
    assert.equal(c.strategy, "steady-basket");
    assert.equal(c.swapVenue, "uniswap");
    assert.equal(c.slippageBps, 100);
    assert.equal(c.perfFeeBps, 1000);
    assert.equal(c.tickSeconds, 60);
    assert.deepEqual(c.basketSymbols, ["QQQ", "NVDA", "TSLA"]);
    assert.equal(c.bundlerUrl, undefined);
    assert.equal(c.anthropicApiKey, undefined);
    assert.equal(c.rialtoApiKeyHeader, "x-api-key");
  });

  it("env fills what the file leaves empty", () => {
    const c = mergeSettings({}, {
      MERRYMEN_BUNDLER_URL: "https://bundler.example",
      ANTHROPIC_API_KEY: "sk-env",
      MERRYMEN_STRATEGY: "weekend-gap",
    });
    assert.equal(c.bundlerUrl, "https://bundler.example");
    assert.equal(c.anthropicApiKey, "sk-env");
    assert.equal(c.strategy, "weekend-gap");
  });

  it("the settings file (web UI) beats env", () => {
    const c = mergeSettings(
      { bundlerUrl: "https://from-ui.example", anthropicApiKey: "sk-ui", strategy: "llm-strategist" },
      { MERRYMEN_BUNDLER_URL: "https://from-env.example", ANTHROPIC_API_KEY: "sk-env", MERRYMEN_STRATEGY: "weekend-gap" },
    );
    assert.equal(c.bundlerUrl, "https://from-ui.example");
    assert.equal(c.anthropicApiKey, "sk-ui");
    assert.equal(c.strategy, "llm-strategist");
  });

  it("empty strings in the file do NOT shadow env — blank means unset", () => {
    const c = mergeSettings({ bundlerUrl: "  " }, { MERRYMEN_BUNDLER_URL: "https://env.example" });
    assert.equal(c.bundlerUrl, "https://env.example");
  });

  it("custom strategy names pass through; builtins resolve directly", () => {
    assert.equal(mergeSettings({ strategy: "my-momentum-bot" }, {}).strategy, "my-momentum-bot");
    assert.equal(mergeSettings({ strategy: "weekend-gap" }, {}).strategy, "weekend-gap");
  });

  it("junk is clamped to defaults, never trusted", () => {
    const c = mergeSettings(
      {
        strategy: "not a token!!" as never,
        swapVenue: "cex" as never,
        slippageBps: 99_999,
        tickSeconds: 1,
        basketSymbols: ["AAPL", "DOGE", 42 as never],
        breakerAddress: "not-an-address",
      },
      {},
    );
    assert.equal(c.strategy, "steady-basket");
    assert.equal(c.swapVenue, "uniswap");
    assert.equal(c.slippageBps, 100);
    assert.equal(c.tickSeconds, 60);
    assert.deepEqual(c.basketSymbols, ["AAPL"]); // unknown symbols dropped, known kept
    assert.equal(c.breakerAddress, undefined);
  });

  it("a valid breaker address passes through typed", () => {
    const c = mergeSettings({ breakerAddress: "0x" + "ab".repeat(20) }, {});
    assert.equal(c.breakerAddress, "0x" + "ab".repeat(20));
  });

  it("the v4 adapter address follows the same discipline: file over env, junk becomes undefined", () => {
    // Same stakes as the breaker: this string becomes a CALL TARGET. A junk
    // value must vanish rather than reach a wall or a warning path, and the
    // file must beat the environment so what the owner sees in /settings is
    // what the worker actually resolved.
    const file = mergeSettings({ v4AdapterAddress: "0x" + "cd".repeat(20) }, { MERRYMEN_V4_ADAPTER_ADDRESS: "0x" + "ef".repeat(20) });
    assert.equal(file.v4AdapterAddress, "0x" + "cd".repeat(20), "file wins over env");
    const env = mergeSettings({}, { MERRYMEN_V4_ADAPTER_ADDRESS: "0x" + "ef".repeat(20) });
    assert.equal(env.v4AdapterAddress, "0x" + "ef".repeat(20), "env fills in when the file is silent");
    const junk = mergeSettings({ v4AdapterAddress: "not-an-address" }, {});
    assert.equal(junk.v4AdapterAddress, undefined, "junk is UNDEFINED, never a call target");
    assert.equal(mergeSettings({}, {}).v4AdapterAddress, undefined, "absent by default");
  });

  it("all unknown basket symbols fall back to the default basket", () => {
    const c = mergeSettings({ basketSymbols: ["DOGE", "SHIB"] }, {});
    assert.deepEqual(c.basketSymbols, ["QQQ", "NVDA", "TSLA"]);
  });

  it("telegram fields resolve with sane defaults and validation", () => {
    const def = mergeSettings({}, {});
    assert.equal(def.telegramBotToken, undefined);
    assert.equal(def.telegramEnabled, false);
    assert.equal(def.telegramControlEnabled, true);
    assert.deepEqual(def.telegramAllowlist, []);
    assert.equal(def.telegramMaxActionUsdg, 25);

    const set = mergeSettings(
      {
        telegramBotToken: "123:abc",
        telegramEnabled: true,
        telegramControlEnabled: false,
        telegramAllowlist: [111, 222, "junk" as never, 333],
        telegramMaxActionUsdg: 40,
      },
      {},
    );
    assert.equal(set.telegramBotToken, "123:abc");
    assert.equal(set.telegramEnabled, true);
    assert.equal(set.telegramControlEnabled, false);
    assert.deepEqual(set.telegramAllowlist, [111, 222, 333]); // non-numbers dropped
    assert.equal(set.telegramMaxActionUsdg, 40);
  });

  it("telegram env fallbacks (enabled flag, comma allowlist)", () => {
    const c = mergeSettings(
      {},
      {
        MERRYMEN_TELEGRAM_BOT_TOKEN: "999:xyz",
        MERRYMEN_TELEGRAM_ENABLED: "true",
        MERRYMEN_TELEGRAM_ALLOWLIST: "5, 6 ,7",
      },
    );
    assert.equal(c.telegramBotToken, "999:xyz");
    assert.equal(c.telegramEnabled, true);
    assert.deepEqual(c.telegramAllowlist, [5, 6, 7]);
  });

  it("transfer/notify/digest fields: safe defaults, file + env resolution, hour clamp", () => {
    const def = mergeSettings({}, {});
    assert.equal(def.telegramTransferEnabled, false); // transfers are OPT-IN
    assert.equal(def.telegramTransferDailyUsdg, 100);
    assert.equal(def.telegramNotifyEnabled, true);
    assert.equal(def.telegramDigestHour, 18);

    const set = mergeSettings(
      { telegramTransferEnabled: true, telegramTransferDailyUsdg: 250, telegramNotifyEnabled: false, telegramDigestHour: 9 },
      {},
    );
    assert.equal(set.telegramTransferEnabled, true);
    assert.equal(set.telegramTransferDailyUsdg, 250);
    assert.equal(set.telegramNotifyEnabled, false);
    assert.equal(set.telegramDigestHour, 9);

    // Out-of-range digest hour falls back to the default.
    assert.equal(mergeSettings({ telegramDigestHour: 99 }, {}).telegramDigestHour, 18);
    // Env fallbacks work.
    const env = mergeSettings({}, { MERRYMEN_TELEGRAM_TRANSFER: "1", MERRYMEN_TELEGRAM_DIGEST_HOUR: "7" });
    assert.equal(env.telegramTransferEnabled, true);
    assert.equal(env.telegramDigestHour, 7);
  });
});

describe("change fingerprints", () => {
  it("connection key moves only on connection fields", () => {
    const a = mergeSettings({}, {});
    const b = mergeSettings({ bundlerUrl: "https://x" }, {});
    const cSame = mergeSettings({ slippageBps: 250 }, {});
    assert.notEqual(connectionKey(a), connectionKey(b));
    assert.equal(connectionKey(a), connectionKey(cSame));
  });

  it("strategy key moves on strategy fields and on key rotation", () => {
    const a = mergeSettings({}, {});
    const b = mergeSettings({ strategy: "weekend-gap" }, {});
    assert.notEqual(strategyKey(a), strategyKey(b));

    const k1 = mergeSettings({ anthropicApiKey: "sk-1" }, {});
    const k2 = mergeSettings({ anthropicApiKey: "sk-2" }, {});
    assert.notEqual(strategyKey(k1), strategyKey(k2)); // rotated key = rebuilt driver
    assert.notEqual(strategyKey(a), strategyKey(k1)); // gaining a key = rebuild
  });

  it("strategy key moves on the four fields makeStrategy bakes in, so a change applies without a restart", () => {
    const a = mergeSettings({}, {});
    for (const patch of [
      { takeProfitBps: 2_500 },
      { strategistStopLossBps: 500 },
      { deskEnabled: true },
      { deskMaxSteps: 7 },
    ]) {
      assert.notEqual(strategyKey(a), strategyKey(mergeSettings(patch, {})), JSON.stringify(patch));
    }
  });

  it("telegram key moves on token, enable, allowlist — not on unrelated fields", () => {
    const a = mergeSettings({ telegramBotToken: "t", telegramEnabled: true, telegramAllowlist: [1] }, {});
    const tokenChanged = mergeSettings({ telegramBotToken: "t2", telegramEnabled: true, telegramAllowlist: [1] }, {});
    const allowChanged = mergeSettings({ telegramBotToken: "t", telegramEnabled: true, telegramAllowlist: [1, 2] }, {});
    const disabled = mergeSettings({ telegramBotToken: "t", telegramEnabled: false, telegramAllowlist: [1] }, {});
    const unrelated = mergeSettings({ telegramBotToken: "t", telegramEnabled: true, telegramAllowlist: [1], slippageBps: 300 }, {});
    assert.notEqual(telegramKey(a), telegramKey(tokenChanged));
    assert.notEqual(telegramKey(a), telegramKey(allowChanged));
    assert.notEqual(telegramKey(a), telegramKey(disabled));
    assert.equal(telegramKey(a), telegramKey(unrelated));
  });
});

/**
 * The basket may name an owner-added token. Filtering selections against the
 * shipped registry alone silently dropped every memecoin here — so a strategy
 * never received it as a leg no matter what the owner selected, and nothing
 * anywhere said why. Resolution order matters: customTokens must be parsed
 * before the basket that is allowed to reference them.
 */
describe("mergeSettings — the basket can name an owner-added token", () => {
  const CATE = { symbol: "CATE", address: "0x00000000000000000000000000000000000000c1", decimals: 18 };

  it("keeps a selected custom symbol instead of dropping it", () => {
    const c = mergeSettings({ basketSymbols: ["NVDA", "CATE"], customTokens: [CATE] }, {});
    assert.deepEqual(c.basketSymbols, ["NVDA", "CATE"]);
  });

  it("still drops a symbol that resolves to nothing at all", () => {
    const c = mergeSettings({ basketSymbols: ["NVDA", "NOPE"], customTokens: [CATE] }, {});
    assert.deepEqual(c.basketSymbols, ["NVDA"]);
  });

  it("drops a custom symbol once its token is removed from settings", () => {
    const c = mergeSettings({ basketSymbols: ["NVDA", "CATE"], customTokens: [] }, {});
    assert.deepEqual(c.basketSymbols, ["NVDA"]);
  });

  it("a malformed custom token doesn't make its symbol selectable", () => {
    const bad = { symbol: "CATE", address: "0x123", decimals: 18 };
    const c = mergeSettings({ basketSymbols: ["NVDA", "CATE"], customTokens: [bad] }, {});
    assert.deepEqual(c.basketSymbols, ["NVDA"]);
  });

  it("falls back to the default basket when nothing selected survives", () => {
    const c = mergeSettings({ basketSymbols: ["NOPE"] }, {});
    assert.deepEqual(c.basketSymbols, [...SETTINGS_DEFAULTS.basketSymbols]);
  });
});

/**
 * THE ENERGY GATE IS THE OPERATOR'S SWITCH, AND ONLY ON THE HOSTED SERVICE.
 *
 * A tenant must not be able to switch off the throttle they are under, so the
 * file is never read for it; and self-hosted it is always off, whatever the
 * environment says — the owner there pays their own model and runs open code.
 */
describe("energyGate — env only, hosted only", () => {
  const withHosted = <T>(on: boolean, fn: () => T): T => {
    const before = process.env.MERRYMEN_HOSTED;
    if (on) process.env.MERRYMEN_HOSTED = "1";
    else delete process.env.MERRYMEN_HOSTED;
    try {
      return fn();
    } finally {
      if (before === undefined) delete process.env.MERRYMEN_HOSTED;
      else process.env.MERRYMEN_HOSTED = before;
    }
  };

  it("SELF-HOSTED IS OFF even with MERRYMEN_ENERGY_GATE=1", () => {
    withHosted(false, () => {
      assert.equal(mergeSettings({}, { MERRYMEN_ENERGY_GATE: "1" }).energyGate, "off");
      assert.equal(mergeSettings({}, { MERRYMEN_ENERGY_GATE: "enforce" }).energyGate, "off");
    });
  });

  it("hosted: unset is off; 'observe' and '1' parse", () => {
    withHosted(true, () => {
      assert.equal(mergeSettings({}, {}).energyGate, "off", "default off in code — the operator flips it");
      assert.equal(mergeSettings({}, { MERRYMEN_ENERGY_GATE: "observe" }).energyGate, "observe");
      assert.equal(mergeSettings({}, { MERRYMEN_ENERGY_GATE: "1" }).energyGate, "enforce");
      assert.equal(mergeSettings({}, { MERRYMEN_ENERGY_GATE: "0" }).energyGate, "off");
    });
  });

  it("A FILE KEY IS IGNORED — the throttled party cannot set their own switch", () => {
    withHosted(true, () => {
      const file = { energyGate: "off", MERRYMEN_ENERGY_GATE: "0" } as unknown as Parameters<typeof mergeSettings>[0];
      assert.equal(mergeSettings(file, { MERRYMEN_ENERGY_GATE: "1" }).energyGate, "enforce");
      const upgrade = { energyGate: "enforce" } as unknown as Parameters<typeof mergeSettings>[0];
      assert.equal(mergeSettings(upgrade, {}).energyGate, "off", "nor switch one on for somebody else to be billed");
    });
  });
});

describe("mergeSettings — Telegram groups (docs/tg-groups.md \"Settings\")", () => {
  const withHosted = (on: boolean, run: () => void) => {
    const before = process.env.MERRYMEN_HOSTED;
    if (on) process.env.MERRYMEN_HOSTED = "1";
    else delete process.env.MERRYMEN_HOSTED;
    try {
      run();
    } finally {
      if (before === undefined) delete process.env.MERRYMEN_HOSTED;
      else process.env.MERRYMEN_HOSTED = before;
    }
  };

  it("defaults: on, coins on, normal — and the defaults are core's, not a second copy", () => {
    const c = mergeSettings({}, {});
    assert.equal(c.telegramGroupsEnabled, true);
    assert.equal(c.telegramGroupCoinsEnabled, true);
    assert.equal(c.telegramGroupsChattiness, "normal");
    assert.equal(SETTINGS_DEFAULTS.telegramGroupsEnabled, true);
    assert.equal(SETTINGS_DEFAULTS.telegramGroupCoinsEnabled, true);
    assert.equal(SETTINGS_DEFAULTS.telegramGroupsChattiness, "normal");
    assert.deepEqual([...TELEGRAM_GROUPS_CHATTINESS], ["quiet", "normal", "chatty"]);
  });

  it("env fills what the file leaves empty", () => {
    const c = mergeSettings({}, {
      MERRYMEN_TELEGRAM_GROUPS: "0",
      MERRYMEN_TELEGRAM_GROUP_COINS: "false",
      MERRYMEN_TELEGRAM_GROUPS_CHATTINESS: "quiet",
    });
    assert.equal(c.telegramGroupsEnabled, false);
    assert.equal(c.telegramGroupCoinsEnabled, false);
    assert.equal(c.telegramGroupsChattiness, "quiet");
    const on = mergeSettings({}, { MERRYMEN_TELEGRAM_GROUPS: "true", MERRYMEN_TELEGRAM_GROUP_COINS: "1", MERRYMEN_TELEGRAM_GROUPS_CHATTINESS: "chatty" });
    assert.equal(on.telegramGroupsEnabled, true);
    assert.equal(on.telegramGroupCoinsEnabled, true);
    assert.equal(on.telegramGroupsChattiness, "chatty");
  });

  it("the settings file (the dashboard) beats env, in both directions", () => {
    const env = { MERRYMEN_TELEGRAM_GROUPS: "0", MERRYMEN_TELEGRAM_GROUP_COINS: "0", MERRYMEN_TELEGRAM_GROUPS_CHATTINESS: "quiet" };
    const c = mergeSettings({ telegramGroupsEnabled: true, telegramGroupCoinsEnabled: true, telegramGroupsChattiness: "chatty" }, env);
    assert.equal(c.telegramGroupsEnabled, true);
    assert.equal(c.telegramGroupCoinsEnabled, true);
    assert.equal(c.telegramGroupsChattiness, "chatty");
    const off = mergeSettings(
      { telegramGroupsEnabled: false, telegramGroupCoinsEnabled: false, telegramGroupsChattiness: "quiet" },
      { MERRYMEN_TELEGRAM_GROUPS: "1", MERRYMEN_TELEGRAM_GROUP_COINS: "1", MERRYMEN_TELEGRAM_GROUPS_CHATTINESS: "chatty" },
    );
    assert.equal(off.telegramGroupsEnabled, false, "an owner's off is not overridden by the house turning it on");
    assert.equal(off.telegramGroupCoinsEnabled, false);
    assert.equal(off.telegramGroupsChattiness, "quiet");
  });

  it("a chattiness it does not know falls back — to env if env is valid, else to normal, never to anything louder", () => {
    for (const bad of ["loud", "CHATTY", "Quiet", "", " normal", 3, true, null]) {
      const file = { telegramGroupsChattiness: bad } as unknown as Parameters<typeof mergeSettings>[0];
      assert.equal(mergeSettings(file, {}).telegramGroupsChattiness, "normal", `file ${JSON.stringify(bad)}`);
      assert.equal(mergeSettings(file, { MERRYMEN_TELEGRAM_GROUPS_CHATTINESS: "quiet" }).telegramGroupsChattiness, "quiet", `file ${JSON.stringify(bad)} with env`);
    }
    assert.equal(mergeSettings({}, { MERRYMEN_TELEGRAM_GROUPS_CHATTINESS: "rowdy" }).telegramGroupsChattiness, "normal");
  });

  it("a non-boolean switch in the file is not read as one — env or the default decides", () => {
    // `bool()` takes only a real boolean from the file: the string "false" is
    // truthy to any reader that forgets `=== true`.
    const file = { telegramGroupsEnabled: "false", telegramGroupCoinsEnabled: 0 } as unknown as Parameters<typeof mergeSettings>[0];
    const c = mergeSettings(file, {});
    assert.equal(c.telegramGroupsEnabled, true);
    assert.equal(c.telegramGroupCoinsEnabled, true);
    assert.equal(mergeSettings(file, { MERRYMEN_TELEGRAM_GROUP_COINS: "0" }).telegramGroupCoinsEnabled, false);
  });

  it("HOSTED, a tenant's own choices stand — these are not house keys and not remote execution", () => {
    withHosted(true, () => {
      const c = mergeSettings(
        { telegramGroupsEnabled: false, telegramGroupCoinsEnabled: false, telegramGroupsChattiness: "quiet" },
        { MERRYMEN_TELEGRAM_GROUPS: "1", MERRYMEN_TELEGRAM_GROUP_COINS: "1", MERRYMEN_TELEGRAM_GROUPS_CHATTINESS: "chatty" },
      );
      assert.equal(c.telegramGroupsEnabled, false);
      assert.equal(c.telegramGroupCoinsEnabled, false);
      assert.equal(c.telegramGroupsChattiness, "quiet");
      const d = mergeSettings({}, {});
      assert.equal(d.telegramGroupsEnabled, true);
      assert.equal(d.telegramGroupsChattiness, "normal");
    });
    for (const k of ["telegramGroupsEnabled", "telegramGroupCoinsEnabled", "telegramGroupsChattiness"]) {
      assert.ok(!(HOSTED_FORBIDDEN_SETTING_FIELDS as readonly string[]).includes(k), `${k} is hosted-forbidden`);
      assert.ok(!(SECRET_SETTING_KEYS as readonly string[]).includes(k), `${k} is masked as a secret`);
    }
  });

  it("the switches do not rebuild the strategy or re-arm the executor", () => {
    // Group behaviour is read live by the Telegram poller on every poll; it is
    // not a trading field, so flipping it must not look like a strategy change.
    const a = mergeSettings({}, {});
    const b = mergeSettings({ telegramGroupsEnabled: false, telegramGroupCoinsEnabled: false, telegramGroupsChattiness: "chatty" }, {});
    assert.equal(strategyKey(a), strategyKey(b));
    assert.equal(connectionKey(a), connectionKey(b));
  });
});

/**
 * PERPETUALS (docs/perps.md "Settings" and rule 1).
 *
 * The owner's fields come from the owner's file and nowhere else; the
 * operator's three come from env and can only take capability away. The
 * numbers are clamped to core's PERPS_NUM_BOUNDS — the same table the settings
 * PUT refuses against (web spec-coverage.test.ts drives it at the same bounds).
 */
describe("mergeSettings — perpetuals (docs/perps.md \"Settings\")", () => {
  const withHosted = <T>(on: boolean, fn: () => T): T => {
    const before = process.env.MERRYMEN_HOSTED;
    if (on) process.env.MERRYMEN_HOSTED = "1";
    else delete process.env.MERRYMEN_HOSTED;
    try {
      return fn();
    } finally {
      if (before === undefined) delete process.env.MERRYMEN_HOSTED;
      else process.env.MERRYMEN_HOSTED = before;
    }
  };
  const file = (f: Record<string, unknown>) => f as MerrymenSettings;
  /** A complete, current consent record — what the PUT writes when the owner consents. */
  const CONSENT = { perpsLiveEnabled: true, perpsLiveConsentVersion: PERPS_LIVE_CONSENT_VERSION, perpsRegionAttested: true, perpsLiveConsentAt: 1_790_000_000_000 };
  const NUM_KEYS = Object.keys(PERPS_NUM_BOUNDS) as PerpsNumKey[];
  /** Every owner-side perps field of a resolved config (the operator's three excluded). */
  const ownerPerps = (c: ResolvedConfig) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c)) if (k.startsWith("perps") && !["perpsOperatorCeiling", "perpsLiveTenants", "perpsEntriesHalted"].includes(k)) out[k] = v;
    return out;
  };

  it("defaults are the contract's table, exactly — and core's, not a second copy", () => {
    const c = mergeSettings({}, {});
    assert.equal(c.perpsEnabled, false);
    assert.equal(c.perpsLiveEnabled, false);
    assert.equal(c.perpsLiveConsentStale, false);
    assert.equal(c.perpsLiveConsentVersion, null);
    assert.equal(c.perpsLiveConsentAt, null);
    assert.equal(c.perpsRegionAttested, false);
    assert.equal(c.perpsDriver, "perp-trend");
    assert.deepEqual(c.perpsMarkets, ["BTC-PERP", "ETH-PERP"]);
    assert.equal(c.perpsMaxLeverage, 2);
    assert.equal(c.perpsPerTradeUsdg, 25);
    assert.equal(c.perpsMaxOpenNotionalUsdg, 50);
    assert.equal(c.perpsMaxCollateralUsdg, 30);
    assert.equal(c.perpsMaxOpensPerDay, 4);
    assert.equal(c.perpsStopLossPct, 5);
    assert.equal(c.perpsStopSlipBps, 200);
    assert.equal(c.perpsTakeProfitPct, 0);
    assert.equal(c.perpsLiqBufferPct, 2);
    assert.equal(c.perpsMaxSlippageBps, 50);
    for (const k of NUM_KEYS) assert.equal(c[k], SETTINGS_DEFAULTS[k], k);
    // Every default sits inside its own bounds and on its own grid, and every
    // default market is a real key — a default the PUT would refuse is a bug.
    for (const k of NUM_KEYS) {
      const b = PERPS_NUM_BOUNDS[k];
      assert.ok(SETTINGS_DEFAULTS[k] >= b.min && SETTINGS_DEFAULTS[k] <= b.max, k);
    }
    for (const m of SETTINGS_DEFAULTS.perpsMarkets) assert.ok(isPerpKey(m), m);
  });

  it("the bounds are the contract's table", () => {
    assert.deepEqual(
      Object.fromEntries(NUM_KEYS.map((k) => [k, [PERPS_NUM_BOUNDS[k].min, PERPS_NUM_BOUNDS[k].max]])),
      {
        perpsMaxLeverage: [1, 10],
        perpsPerTradeUsdg: [10, 100_000],
        perpsMaxOpenNotionalUsdg: [10, 100_000],
        perpsMaxCollateralUsdg: [5, 100_000],
        perpsMaxOpensPerDay: [1, 50],
        perpsStopLossPct: [1, 25],
        perpsStopSlipBps: [50, 450],
        perpsTakeProfitPct: [0, 500],
        perpsLiqBufferPct: [1, 50],
        perpsMaxSlippageBps: [5, 300],
      },
    );
    for (const k of ["perpsMaxLeverage", "perpsMaxOpensPerDay", "perpsStopSlipBps", "perpsMaxSlippageBps"] as const) {
      assert.equal(PERPS_NUM_BOUNDS[k].decimals, 0, `${k} is whole`);
    }
  });

  it("each number is taken at both of its bounds, and refused (to the default, never the nearest bound) just past either", () => {
    for (const k of NUM_KEYS) {
      const { min, max, decimals } = PERPS_NUM_BOUNDS[k];
      const step = decimals === 0 ? 1 : 0.01;
      // The per-trade cap is read no higher than the open-notional cap, so test
      // it with room above it.
      const room = k === "perpsPerTradeUsdg" ? { perpsMaxOpenNotionalUsdg: 100_000 } : {};
      assert.equal(mergeSettings(file({ ...room, [k]: min }), {})[k], min, `${k}=${min}`);
      assert.equal(mergeSettings(file({ ...room, [k]: max }), {})[k], max, `${k}=${max}`);
      for (const bad of [min - step, max + step]) {
        assert.equal(mergeSettings(file({ ...room, [k]: bad }), {})[k], SETTINGS_DEFAULTS[k], `${k}=${bad} is the default`);
      }
      for (const junk of ["5", null, true, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.equal(mergeSettings(file({ ...room, [k]: junk }), {})[k], SETTINGS_DEFAULTS[k], `${k}=${String(junk)}`);
      }
    }
  });

  it("off the grid is refused too: whole leverage, counts and bps; hundredths of a percent or a USDG", () => {
    assert.equal(mergeSettings(file({ perpsMaxLeverage: 2.5 }), {}).perpsMaxLeverage, 2);
    assert.equal(mergeSettings(file({ perpsMaxOpensPerDay: 3.2 }), {}).perpsMaxOpensPerDay, 4);
    assert.equal(mergeSettings(file({ perpsStopSlipBps: 100.5 }), {}).perpsStopSlipBps, 200);
    assert.equal(mergeSettings(file({ perpsMaxSlippageBps: 30.1 }), {}).perpsMaxSlippageBps, 50);
    assert.equal(mergeSettings(file({ perpsStopLossPct: 2.345 }), {}).perpsStopLossPct, 5);
    assert.equal(mergeSettings(file({ perpsMaxCollateralUsdg: 25.001 }), {}).perpsMaxCollateralUsdg, 30);
    // Hundredths are fine, including the ones binary floating point cannot spell.
    assert.equal(mergeSettings(file({ perpsStopLossPct: 2.35 }), {}).perpsStopLossPct, 2.35);
    assert.equal(mergeSettings(file({ perpsLiqBufferPct: 1.29 }), {}).perpsLiqBufferPct, 1.29);
    assert.equal(mergeSettings(file({ perpsMaxCollateralUsdg: 30.07 }), {}).perpsMaxCollateralUsdg, 30.07);
  });

  it("NO ENVIRONMENT TERM FOR ANY OWNER FIELD — not the switches, not the consent, not a limit", () => {
    // The liveTradingEnabled precedent, not trencherLiveEnabled's: a deploy
    // variable must never be the house consenting to leverage for every owner.
    const env = {
      MERRYMEN_PERPS: "live",
      MERRYMEN_PERPS_LIVE_TENANTS: "0x" + "ab".repeat(20),
      MERRYMEN_PERPS_ENABLED: "1",
      MERRYMEN_PERPS_LIVE: "1",
      MERRYMEN_PERPS_LIVE_ENABLED: "true",
      MERRYMEN_PERPS_LIVE_CONSENT_VERSION: String(PERPS_LIVE_CONSENT_VERSION),
      MERRYMEN_PERPS_LIVE_CONSENT_AT: "1790000000000",
      MERRYMEN_PERPS_REGION_ATTESTED: "1",
      MERRYMEN_PERPS_DRIVER: "strategist",
      MERRYMEN_PERPS_MARKETS: "SOL-PERP,TSLA-PERP",
      MERRYMEN_PERPS_MAX_LEVERAGE: "10",
      MERRYMEN_PERPS_PER_TRADE_USDG: "100000",
      MERRYMEN_PERPS_MAX_OPEN_NOTIONAL_USDG: "100000",
      MERRYMEN_PERPS_MAX_COLLATERAL_USDG: "100000",
      MERRYMEN_PERPS_MAX_OPENS_PER_DAY: "50",
      MERRYMEN_PERPS_STOP_LOSS_PCT: "25",
      MERRYMEN_PERPS_STOP_SLIP_BPS: "450",
      MERRYMEN_PERPS_TAKE_PROFIT_PCT: "500",
      MERRYMEN_PERPS_LIQ_BUFFER_PCT: "1",
      MERRYMEN_PERPS_MAX_SLIPPAGE_BPS: "300",
      MERRYMEN_LIVE_TRADING: "true",
    };
    for (const hosted of [false, true]) {
      withHosted(hosted, () => {
        assert.deepEqual(ownerPerps(mergeSettings({}, env)), ownerPerps(mergeSettings({}, {})), `hosted=${hosted}: env moved an owner field`);
        const c = mergeSettings({}, env);
        assert.equal(c.perpsEnabled, false);
        assert.equal(c.perpsLiveEnabled, false);
        assert.equal(c.liveTradingEnabled, false);
        // And env cannot complete a record the owner only half gave.
        const half = mergeSettings(file({ perpsEnabled: true, perpsLiveEnabled: true }), env);
        assert.equal(half.perpsLiveEnabled, false);
        assert.equal(half.perpsLiveConsentStale, true);
      });
    }
  });

  it("the consent counts only as a whole, current record", () => {
    const on = mergeSettings(file({ ...CONSENT }), {});
    assert.equal(on.perpsLiveEnabled, true);
    assert.equal(on.perpsLiveConsentStale, false);
    assert.equal(on.perpsLiveConsentVersion, PERPS_LIVE_CONSENT_VERSION);
    assert.equal(on.perpsLiveConsentAt, CONSENT.perpsLiveConsentAt);
    assert.equal(on.perpsRegionAttested, true);
    // Real perps never switch on paper perps, and the consent never switches on
    // the account's own rail: each is its own term.
    assert.equal(on.perpsEnabled, false);
    assert.equal(on.liveTradingEnabled, false);

    for (const [why, patch] of [
      ["an older consent text", { perpsLiveConsentVersion: PERPS_LIVE_CONSENT_VERSION - 1 }],
      ["a newer build's text", { perpsLiveConsentVersion: PERPS_LIVE_CONSENT_VERSION + 1 }],
      ["no version", { perpsLiveConsentVersion: undefined }],
      ["a stringy version", { perpsLiveConsentVersion: String(PERPS_LIVE_CONSENT_VERSION) }],
      ["no attestation", { perpsRegionAttested: undefined }],
      ["an attestation withdrawn", { perpsRegionAttested: false }],
      ["a stringy attestation", { perpsRegionAttested: "true" }],
      ["no stamp", { perpsLiveConsentAt: undefined }],
      ["a junk stamp", { perpsLiveConsentAt: "yesterday" }],
      ["a zero stamp", { perpsLiveConsentAt: 0 }],
    ] as const) {
      const c = mergeSettings(file({ ...CONSENT, ...patch }), {});
      assert.equal(c.perpsLiveEnabled, false, why);
      assert.equal(c.perpsLiveConsentStale, true, `${why}: the owner is told to re-confirm, not that it is off`);
    }
    for (const junk of ["true", 1, null]) {
      const c = mergeSettings(file({ ...CONSENT, perpsLiveEnabled: junk }), {});
      assert.equal(c.perpsLiveEnabled, false, `perpsLiveEnabled=${JSON.stringify(junk)}`);
      assert.equal(c.perpsLiveConsentStale, false, "a switch that was never turned on is not a stale consent");
    }
    // Off stays off whatever record is lying beside it.
    const off = mergeSettings(file({ ...CONSENT, perpsLiveEnabled: false }), {});
    assert.equal(off.perpsLiveEnabled, false);
    assert.equal(off.perpsLiveConsentStale, false);
  });

  it("markets: unknown and repeated keys dropped, the owner's order kept, capped at 8 — and never widened to the default", () => {
    assert.deepEqual(mergeSettings(file({ perpsMarkets: ["SOL-PERP", "BTC-PERP"] }), {}).perpsMarkets, ["SOL-PERP", "BTC-PERP"]);
    assert.deepEqual(mergeSettings(file({ perpsMarkets: ["SOL-PERP", "FOO-PERP", "BTC", "SOL-PERP", 3] }), {}).perpsMarkets, ["SOL-PERP"]);
    const nine = ["BTC-PERP", "ETH-PERP", "SOL-PERP", "HYPE-PERP", "XRP-PERP", "SUI-PERP", "TSLA-PERP", "NVDA-PERP", "SPY-PERP"];
    assert.deepEqual(mergeSettings(file({ perpsMarkets: nine }), {}).perpsMarkets, nine.slice(0, 8));
    // A list that names nothing valid is NO markets, not BTC and ETH.
    assert.deepEqual(mergeSettings(file({ perpsMarkets: ["btc-perp", "BTC", "TSLA"] }), {}).perpsMarkets, []);
    assert.deepEqual(mergeSettings(file({ perpsMarkets: [] }), {}).perpsMarkets, []);
    // Only an absent (or non-list) field takes the default.
    assert.deepEqual(mergeSettings({}, {}).perpsMarkets, ["BTC-PERP", "ETH-PERP"]);
    assert.deepEqual(mergeSettings(file({ perpsMarkets: "SOL-PERP" }), {}).perpsMarkets, ["BTC-PERP", "ETH-PERP"]);
  });

  it("driver: absent is perp-trend; a value this build does not know is manual, never an autonomous producer", () => {
    assert.equal(mergeSettings({}, {}).perpsDriver, "perp-trend");
    for (const d of ["perp-trend", "brain", "strategist", "manual"] as const) assert.equal(mergeSettings(file({ perpsDriver: d }), {}).perpsDriver, d);
    for (const junk of ["future-driver", "Strategist", "", null, 7]) {
      assert.equal(mergeSettings(file({ perpsDriver: junk }), {}).perpsDriver, "manual", JSON.stringify(junk));
    }
  });

  it("a per-trade cap above the open-notional cap is read as the open-notional cap", () => {
    const c = mergeSettings(file({ perpsPerTradeUsdg: 80, perpsMaxOpenNotionalUsdg: 40 }), {});
    assert.equal(c.perpsPerTradeUsdg, 40);
    assert.equal(c.perpsMaxOpenNotionalUsdg, 40);
    const fine = mergeSettings(file({ perpsPerTradeUsdg: 40, perpsMaxOpenNotionalUsdg: 80 }), {});
    assert.equal(fine.perpsPerTradeUsdg, 40);
  });

  it("perps fields are the tenant's own: not secret, not house keys, not hosted-forbidden", () => {
    for (const k of PERPS_SETTING_KEYS) {
      assert.ok(!(HOSTED_FORBIDDEN_SETTING_FIELDS as readonly string[]).includes(k), `${k} is hosted-forbidden`);
      assert.ok(!(HOUSE_KEY_FIELDS as readonly string[]).includes(k), `${k} is a house key`);
      assert.ok(!(SECRET_SETTING_KEYS as readonly string[]).includes(k), `${k} is masked as a secret`);
    }
    withHosted(true, () => {
      const f = file({ ...CONSENT, perpsEnabled: true, perpsMaxLeverage: 3, perpsMarkets: ["SOL-PERP"] });
      assert.deepEqual(stripHouseKeys(f), f);
      const c = mergeSettings(f, {});
      assert.equal(c.perpsEnabled, true);
      assert.equal(c.perpsLiveEnabled, true);
      assert.equal(c.perpsMaxLeverage, 3);
      assert.deepEqual(c.perpsMarkets, ["SOL-PERP"]);
    });
  });
});

describe("the operator's perps levers only ever take capability away", () => {
  const withHosted = <T>(on: boolean, fn: () => T): T => {
    const before = process.env.MERRYMEN_HOSTED;
    if (on) process.env.MERRYMEN_HOSTED = "1";
    else delete process.env.MERRYMEN_HOSTED;
    try {
      return fn();
    } finally {
      if (before === undefined) delete process.env.MERRYMEN_HOSTED;
      else process.env.MERRYMEN_HOSTED = before;
    }
  };
  const A = "0x" + "a1".repeat(20);
  const B = "0x" + "b2".repeat(20);

  it("MERRYMEN_PERPS: unset is paper hosted and live self-hosted; anything unrecognised is off", () => {
    withHosted(false, () => {
      assert.equal(mergeSettings({}, {}).perpsOperatorCeiling, "live");
      assert.equal(mergeSettings({}, { MERRYMEN_PERPS: "" }).perpsOperatorCeiling, "live");
      assert.equal(mergeSettings({}, { MERRYMEN_PERPS: "paper" }).perpsOperatorCeiling, "paper");
      assert.equal(mergeSettings({}, { MERRYMEN_PERPS: " OFF " }).perpsOperatorCeiling, "off");
    });
    withHosted(true, () => {
      assert.equal(mergeSettings({}, {}).perpsOperatorCeiling, "paper");
      assert.equal(mergeSettings({}, { MERRYMEN_PERPS: "Live" }).perpsOperatorCeiling, "live");
      assert.equal(mergeSettings({}, { MERRYMEN_PERPS: "off" }).perpsOperatorCeiling, "off");
    });
    for (const hosted of [false, true]) {
      withHosted(hosted, () => {
        for (const typo of ["lvie", "1", "true", "on", "yes", "paper,live"]) {
          assert.equal(mergeSettings({}, { MERRYMEN_PERPS: typo }).perpsOperatorCeiling, "off", `hosted=${hosted} ${typo}`);
        }
      });
    }
  });

  it("the settings file cannot set, lift or halt any of the three", () => {
    const f = { MERRYMEN_PERPS: "live", perpsOperatorCeiling: "live", perpsLiveTenants: [A], perpsEntriesHalted: false, MERRYMEN_HALT_PERP_ENTRIES: "0" } as unknown as MerrymenSettings;
    withHosted(true, () => {
      const c = mergeSettings(f, { MERRYMEN_HALT_PERP_ENTRIES: "1" });
      assert.equal(c.perpsOperatorCeiling, "paper");
      assert.deepEqual(c.perpsLiveTenants, []);
      assert.equal(c.perpsEntriesHalted, true);
      assert.equal(perpsCeilingFor(c, A), "paper");
    });
    const halt = { perpsEntriesHalted: true } as unknown as MerrymenSettings;
    assert.equal(mergeSettings(halt, {}).perpsEntriesHalted, false, "nor halt a tenant from their own file — it is the operator's switch");
  });

  it("the live allowlist is hosted only: none listed means nobody live, and it never lifts a lower ceiling", () => {
    withHosted(true, () => {
      const none = mergeSettings({}, { MERRYMEN_PERPS: "live" });
      assert.deepEqual(none.perpsLiveTenants, []);
      assert.equal(perpsCeilingFor(none, A), "paper");
      const listed = mergeSettings({}, { MERRYMEN_PERPS: "live", MERRYMEN_PERPS_LIVE_TENANTS: ` ${A.toUpperCase().replace("0X", "0x")} , not-an-address,${A}` });
      assert.deepEqual(listed.perpsLiveTenants, [A]);
      assert.equal(perpsCeilingFor(listed, A), "live");
      assert.equal(perpsCeilingFor(listed, A.toUpperCase().replace("0X", "0x")), "live", "addresses compare case-insensitively");
      assert.equal(perpsCeilingFor(listed, B), "paper");
      assert.equal(perpsCeilingFor(listed, null), "paper", "an account we cannot name is not on the list");
      for (const ceiling of ["paper", "off"] as const) {
        const lower = mergeSettings({}, { MERRYMEN_PERPS: ceiling, MERRYMEN_PERPS_LIVE_TENANTS: A });
        assert.equal(perpsCeilingFor(lower, A), ceiling, `a listed tenant stays at ${ceiling}`);
      }
    });
    withHosted(false, () => {
      const c = mergeSettings({}, { MERRYMEN_PERPS_LIVE_TENANTS: B });
      assert.equal(c.perpsLiveTenants, null, "ignored self-hosted");
      assert.equal(perpsCeilingFor(c, A), "live");
      assert.equal(perpsCeilingFor(mergeSettings({}, { MERRYMEN_PERPS: "paper" }), A), "paper");
    });
  });

  it("MERRYMEN_HALT_PERP_ENTRIES halts on anything but an explicit no", () => {
    for (const v of ["1", "true", "yes", "halt", "on"]) assert.equal(mergeSettings({}, { MERRYMEN_HALT_PERP_ENTRIES: v }).perpsEntriesHalted, true, v);
    for (const v of [undefined, "", "0", "false", "no", "off", " OFF "]) assert.equal(mergeSettings({}, { MERRYMEN_HALT_PERP_ENTRIES: v }).perpsEntriesHalted, false, String(v));
  });

  it("no lever moves an owner field: the owner's switches, consent and limits read the same under every operator setting", () => {
    const owner = {
      perpsEnabled: true,
      perpsLiveEnabled: true,
      perpsLiveConsentVersion: PERPS_LIVE_CONSENT_VERSION,
      perpsRegionAttested: true,
      perpsLiveConsentAt: 1_790_000_000_000,
      perpsMaxLeverage: 3,
      perpsMarkets: ["SOL-PERP"],
    } as MerrymenSettings;
    const strip = (c: ResolvedConfig) => {
      const { perpsOperatorCeiling: _a, perpsLiveTenants: _b, perpsEntriesHalted: _c, ...rest } = c;
      return rest;
    };
    for (const hosted of [false, true]) {
      withHosted(hosted, () => {
        const base = strip(mergeSettings(owner, {}));
        for (const env of [
          { MERRYMEN_PERPS: "off" },
          { MERRYMEN_PERPS: "paper" },
          { MERRYMEN_PERPS: "live", MERRYMEN_PERPS_LIVE_TENANTS: A },
          { MERRYMEN_HALT_PERP_ENTRIES: "1" },
        ]) {
          assert.deepEqual(strip(mergeSettings(owner, env)), base, `hosted=${hosted} ${JSON.stringify(env)}`);
        }
      });
    }
  });
});

describe("perps fingerprints", () => {
  const base = mergeSettings({}, {});
  const changes: Record<string, unknown>[] = [
    { perpsEnabled: true },
    { perpsLiveEnabled: true, perpsLiveConsentVersion: PERPS_LIVE_CONSENT_VERSION, perpsRegionAttested: true, perpsLiveConsentAt: 1 },
    { perpsLiveEnabled: true },
    { perpsDriver: "manual" },
    { perpsMarkets: ["SOL-PERP"] },
    { perpsMaxLeverage: 3 },
    { perpsPerTradeUsdg: 30 },
    { perpsMaxOpenNotionalUsdg: 60 },
    { perpsMaxCollateralUsdg: 40 },
    { perpsMaxOpensPerDay: 5 },
    { perpsStopLossPct: 4 },
    { perpsStopSlipBps: 300 },
    { perpsTakeProfitPct: 10 },
    { perpsLiqBufferPct: 3 },
    { perpsMaxSlippageBps: 60 },
  ];

  it("perpsKey moves on every perps field, so no change waits for a restart", () => {
    for (const patch of changes) {
      assert.notEqual(perpsKey(mergeSettings(patch as MerrymenSettings, {})), perpsKey(base), JSON.stringify(patch));
    }
    for (const env of [{ MERRYMEN_PERPS: "off" }, { MERRYMEN_HALT_PERP_ENTRIES: "1" }]) {
      assert.notEqual(perpsKey(mergeSettings({}, env)), perpsKey(base), JSON.stringify(env));
    }
    // And EVERY ResolvedConfig perps field is in it, found by name rather than
    // listed here: a field added later and left out of the key fails this.
    const perpsFields = Object.keys(base).filter((k) => k.startsWith("perps"));
    assert.ok(perpsFields.length >= 21);
    for (const k of perpsFields) {
      const v = (base as unknown as Record<string, unknown>)[k];
      const moved =
        typeof v === "boolean" ? !v
        : typeof v === "number" ? v + 1
        : typeof v === "string" ? `${v}-moved`
        : v === null ? (k === "perpsLiveTenants" ? [] : 1)
        : Array.isArray(v) ? [...v, "moved"]
        : assert.fail(`${k}: no way to move a ${typeof v}`);
      assert.notEqual(perpsKey({ ...base, [k]: moved } as ResolvedConfig), perpsKey(base), `${k} is not in perpsKey`);
    }
  });

  it("perpsKey does not move on a spot field", () => {
    assert.equal(perpsKey(mergeSettings({ slippageBps: 250, strategy: "trencher" }, {})), perpsKey(base));
  });

  it("strategyKey moves on what the strategist is built with — perps on, driver, markets — and not on a cap", () => {
    for (const patch of [{ perpsEnabled: true }, { perpsDriver: "strategist" }, { perpsMarkets: ["SOL-PERP"] }]) {
      assert.notEqual(strategyKey(mergeSettings(patch as MerrymenSettings, {})), strategyKey(base), JSON.stringify(patch));
    }
    for (const patch of [{ perpsMaxLeverage: 3 }, { perpsPerTradeUsdg: 30 }, { perpsStopLossPct: 4 }]) {
      assert.equal(strategyKey(mergeSettings(patch as MerrymenSettings, {})), strategyKey(base), JSON.stringify(patch));
    }
    assert.equal(connectionKey(mergeSettings({ perpsEnabled: true, perpsMaxLeverage: 3 }, {})), connectionKey(base));
  });
});

it("perps profiles retain all execution switches and caps, and unknown profiles disable autonomous entries", () => {
  const baseline = mergeSettings({}, {});
  const scalp = mergeSettings({ perpsStyle: "scalp-breakout" }, {});
  assert.equal(scalp.perpsStyle, "scalp-breakout");
  assert.equal(scalp.perpsMaxLeverage, baseline.perpsMaxLeverage);
  assert.equal(scalp.perpsPerTradeUsdg, baseline.perpsPerTradeUsdg);
  assert.equal(scalp.liveTradingEnabled, baseline.liveTradingEnabled);
  assert.equal(scalp.perpsEnabled, baseline.perpsEnabled);
  assert.equal(scalp.perpsLiveEnabled, baseline.perpsLiveEnabled);
  assert.notEqual(perpsKey(scalp), perpsKey(baseline));
  assert.equal(mergeSettings({ perpsStyle: "future-mode" } as never, {}).perpsDriver, "manual");
});
