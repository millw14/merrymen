import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { connectionKey, mergeSettings, strategyKey } from "./settings";

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

  it("junk is clamped to defaults, never trusted", () => {
    const c = mergeSettings(
      {
        strategy: "yolo-mode" as never,
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
});
