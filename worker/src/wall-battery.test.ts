import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CASH,
  GRANT_V4,
  STOCK_TOKENS,
  TRADEABLE_V2,
  type StoredGrant,
} from "../../packages/core/src/index";
import { limitsFromGrant } from "./limits";
import { runWallBattery } from "./wall-battery";

const NOW = 1_800_000_000;
const PRIVATE_KEY = `0x${"11".repeat(32)}` as `0x${string}`;

function grant(grantFeatures: string[]): StoredGrant {
  return {
    smartAccount: "0x0000000000000000000000000000000000000001",
    owner: "0x0000000000000000000000000000000000000002",
    sessionKeyAddress: "0x0000000000000000000000000000000000000003",
    serialized: "test-only",
    caps: {
      perTradeUsdg: 25,
      dailyUsdg: 100,
      expiryDays: 14,
      maxDrawdownPct: 15,
      maxOpsPerDay: 4,
    },
    grantedAt: NOW - 100,
    expiresAt: NOW + 100,
    chainId: 46630,
    grantFeatures,
    demoSessionPrivateKey: PRIVATE_KEY,
  };
}

describe("runWallBattery", () => {
  for (const [name, features] of [
    ["legacy", ["transfer"]],
    ["current", ["transfer", TRADEABLE_V2, GRANT_V4]],
  ] as const) {
    it(`holds every exact rule for an unexpired ${name} grant`, () => {
      const result = runWallBattery(grant([...features]), NOW);
      assert.equal(result.allHeld, true);
      assert.equal(result.cases.length, 9);
      assert.deepEqual(
        result.cases.map((entry) => entry.rule ?? "approved"),
        [
          "per-trade-cap",
          "per-trade-cap",
          "target-allowlist",
          "asset-allowlist",
          "daily-cap",
          "expiry",
          "drawdown-breaker",
          "approved",
          "no-exit",
        ],
      );
      assert.ok(result.cases.every((entry) => entry.held));
    });
  }

  it("uses the requested watchlist as allowedAssets without widening sell permissions", () => {
    const aapl = STOCK_TOKENS.find((token) => token.symbol === "AAPL")!;
    const legacy = grant(["transfer"]);
    const limits = limitsFromGrant(legacy, [aapl]);

    assert.deepEqual(
      limits.allowedAssets.map((address) => address.toLowerCase()),
      [CASH.USDG.toLowerCase(), aapl.address.toLowerCase()],
    );
    assert.equal(
      limits.sellableAssets?.some((address) => address.toLowerCase() === aapl.address.toLowerCase()),
      false,
      "selecting AAPL must not pretend a legacy signature can sell it",
    );
  });
});
