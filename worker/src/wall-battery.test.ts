import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CASH,
  GRANT_V4,
  GRANT_PONS_CLASS,
  STOCK_TOKENS,
  TRADEABLE_V2,
  WITHDRAWAL_ALLOWLIST_LANDED_AT,
  grantHasTransfer,
  type StoredGrant,
} from "../../packages/core/src/index";
import { limitsFromGrant } from "./limits";
import { runWallBattery } from "./wall-battery";

const NOW = 1_800_000_000;
const PRIVATE_KEY = `0x${"11".repeat(32)}` as `0x${string}`;

/** The vault a class-enabled fixture sealed. Any address; what matters is that
 *  the marker and the field agree, because grantPonsClassVault demands both. */
const CLASS_VAULT = "0x00000000000000000000000000000000000000c0" as const;

function grant(grantFeatures: string[], grantedAt?: number, ponsClassVaultAddress?: string): StoredGrant {
  return {
    ...(ponsClassVaultAddress ? { ponsClassVaultAddress } : {}),
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
    grantedAt: grantedAt ?? NOW - 100,
    expiresAt: NOW + 100,
    chainId: 46630,
    grantFeatures,
    demoSessionPrivateKey: PRIVATE_KEY,
  };
}

describe("runWallBattery", () => {
  // THREE POPULATIONS, and the middle one is the trap. The transfer marker
  // means "this signature carries a USDG transfer permission" — but from
  // e950ea5 (2026-08-02) until 6cfeee6 (2026-08-26) both signers kept writing
  // it while passing no withdrawal address, so a whole generation of grants
  // claims a permission the wall never emitted. With a 14-day default expiry
  // that generation is most of the live population, and the genuinely
  // pre-allowlist grants the marker protects are mostly expired.
  //
  // Every fixture here used to be dated "now" AND carry the marker, which is
  // how the battery's first case went stale unnoticed: the suite stayed green
  // while the dashboard printed "⚠ BREACH" for a real grant on a wall that had
  // just got STRICTER. A battery whose fixtures are all legacy tests the past.
  const BEFORE_ALLOWLIST = WITHDRAWAL_ALLOWLIST_LANDED_AT - 86_400;
  for (const [name, features, grantedAt] of [
    ["pre-allowlist", ["transfer"], BEFORE_ALLOWLIST],
    ["pre-allowlist v2", ["transfer", TRADEABLE_V2, GRANT_V4], BEFORE_ALLOWLIST],
    // Carries the marker, but the wall it was signed against emitted no
    // transfer permission. The mirror must refuse, not trust the claim.
    ["stale-marker", ["transfer", TRADEABLE_V2], undefined],
    // What both signers mint today: no claim at all.
    ["modern", [TRADEABLE_V2, "multihop"], undefined],
  ] as const) {
    it(`holds every exact rule for an unexpired ${name} grant`, () => {
      const result = runWallBattery(grant([...features], grantedAt), NOW);
      assert.equal(result.allHeld, true);
      assert.equal(result.cases.length, 11);
      assert.deepEqual(
        result.cases.map((entry) => entry.rule ?? "approved"),
        [
          // The prompt-injected transfer. A pre-allowlist grant carries a
          // free-form transfer permission and is stopped by the cap; a grant
          // signed today has no transfer permission at all and is stopped
          // earlier and harder. Both are the wall holding — and this line is
          // exactly what the battery has to get right, because reporting the
          // wrong rule here reads as a BREACH on the dashboard.
          grantHasTransfer(grant([...features], grantedAt)) ? "per-trade-cap" : "transfer-not-permitted",
          "per-trade-cap",
          "target-allowlist",
          "asset-allowlist",
          "daily-cap",
          "ops-cap",
          "expiry",
          "drawdown-breaker",
          "approved",
          "no-exit",
          // NONE of these fixtures sealed a class vault, so the battery asks
          // the only honest class question they have: what a curve trade aimed
          // at a vault this signature never named actually does. It never
          // reaches the class rules at all — `target-allowlist` turns it back
          // first, which is the answer that should make anyone reading the
          // dashboard confident the route is genuinely absent rather than
          // merely untested.
          "target-allowlist",
        ],
      );
      assert.ok(result.cases.every((entry) => entry.held));
    });
  }

  it("exercises the real class rules once a grant actually seals a vault", () => {
    // The class route's three outcomes, on one grant, in one place:
    //   buy a token that did not exist at signing   → APPROVED (the capability)
    //   the same buy with no launch feed            → curve-provenance (the price)
    //   one un-enumerated token into another        → asset-allowlist (the bound)
    //
    // The middle one is the inversion worth staring at. Everywhere else in this
    // system an unreadable list means a rule could not run and the trade is
    // judged by the rules that could. Here it means refuse — because a class
    // trade's output leg is deliberately not in the grant, so provenance is the
    // ONLY thing left vouching for the token, and a check that did not run must
    // never read as one that passed.
    const classGrant = grant(
      [TRADEABLE_V2, GRANT_PONS_CLASS],
      undefined,
      CLASS_VAULT,
    );
    const result = runWallBattery(classGrant, NOW);

    assert.equal(result.allHeld, true);
    // 10 shared cases + the three class ones (the non-class fixtures get one).
    assert.equal(result.cases.length, 13);
    assert.deepEqual(
      result.cases.slice(-3).map((entry) => entry.rule ?? "approved"),
      ["approved", "curve-provenance", "asset-allowlist"],
    );
  });

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
