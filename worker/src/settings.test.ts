import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { connectionKey, mergeSettings, strategyKey, telegramKey } from "./settings";

describe("mergeSettings — file > env > default", () => {
  it("defaults hold with nothing set", () => {
    const c = mergeSettings({}, {});
    assert.equal(c.strategy, "steady-basket");
    assert.equal(c.swapVenue, "uniswap");
    assert.equal(c.slippageBps, 100);
    assert.equal(c.perfFeeBps, 1000);
    assert.equal(c.tickSeconds, 60);
    assert.deepEqual(c.basketSymbols, ["AAPL", "MSFT", "QQQ"]);
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

  it("all unknown basket symbols fall back to the default basket", () => {
    const c = mergeSettings({ basketSymbols: ["DOGE", "SHIB"] }, {});
    assert.deepEqual(c.basketSymbols, ["AAPL", "MSFT", "QQQ"]);
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
