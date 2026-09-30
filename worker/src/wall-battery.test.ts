import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CASH,
  ENERGY_ROUTE_V1,
  GRANT_ENERGY,
  GRANT_PERP_LIGHTER,
  GRANT_V4,
  LIGHTER_ROUTE_V1,
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
      assert.equal(result.cases.length, 13);
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
          // NONE of these fixtures sealed the energy route (it exists only on
          // chain 4663, under GRANT_ENERGY), so the energy buy is refused by
          // name — and the router it would use is still no generic swap venue.
          "energy-not-granted",
          "target-allowlist",
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
    // 10 shared cases + two energy ones (no route on this fixture) + five class
    // ones (a non-class fixture gets one).
    assert.equal(result.cases.length, 17);
    assert.deepEqual(
      result.cases.slice(-5).map((entry) => entry.rule ?? "approved"),
      // enter · the price of entering · the exit · the exit under a tripped
      // breaker · the bound
      ["approved", "curve-provenance", "approved", "approved", "asset-allowlist"],
    );
  });

  it("THE ENERGY BUY on a key that sealed it: the honest buy goes, an oversized one and a router swap do not", () => {
    // The route exists only on Robinhood Chain mainnet under GRANT_ENERGY
    // (grantEnergyRoute), so this fixture is the one grant here on 4663.
    const energyGrant = { ...grant([TRADEABLE_V2, GRANT_ENERGY]), chainId: 4663 };
    const result = runWallBattery(energyGrant, NOW);
    assert.equal(result.allHeld, true);
    const energy = result.cases.filter((c) => /energy/i.test(c.attempt));
    assert.deepEqual(
      energy.map((c) => c.rule ?? "approved"),
      ["approved", "per-trade-cap", "target-allowlist"],
    );
    // And the mirror really is sourced from the grant: the router is the
    // energy limit's and NOT an allowed target.
    const limits = limitsFromGrant(energyGrant);
    assert.equal(limits.energy?.router, ENERGY_ROUTE_V1.router);
    assert.ok(!limits.allowedTargets.map((a) => a.toLowerCase()).includes(ENERGY_ROUTE_V1.router));
  });

  it("PROVES THE EXIT, which three buy cases could not", () => {
    // A wall that can open a class position and never close one is the exact
    // trap PonsClassVault exists to remove — and a battery of buys would have
    // printed all-green over it. Asserted separately from the sequence above so
    // it cannot be lost in a reordering.
    const result = runWallBattery(grant([TRADEABLE_V2, GRANT_PONS_CLASS], undefined, CLASS_VAULT), NOW);
    const exits = result.cases.filter((c) => /exit/i.test(c.attempt));
    assert.equal(exits.length, 2, "the plain exit and the exit under a tripped breaker");
    for (const e of exits) {
      assert.equal(e.ok, true, `${e.attempt} — ${e.rule ?? ""} ${e.detail ?? ""}`);
    }
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

/**
 * FOR PERPETUALS THE BATTERY IS THE ORDER WALL ITSELF (docs/perps.md rule 4):
 * the chain bounds only the deposit, so every order rule an owner is shown
 * here is one checkPolicy enforces alone. Each case is pinned to its rule, and
 * the approved half proves no brake ever holds a close or a withdrawal shut.
 */
describe("runWallBattery — the perp cases", () => {
  /** A canonical Lighter API public key: five LE limbs, each < p, not all zero. */
  const PUB = `0x01${"00".repeat(39)}` as `0x${string}`;
  const perpGrant = (perTradeUsdg = 25, dailyUsdg = 100): StoredGrant => {
    const g = grant([TRADEABLE_V2, GRANT_PERP_LIGHTER]);
    return {
      ...g,
      caps: { ...g.caps, perTradeUsdg, dailyUsdg },
      chainId: 4663,
      perp: { route: GRANT_PERP_LIGHTER, apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: PUB },
    };
  };
  const PERP_RULES = [
    "approved", // the honest open
    "perp-leverage-mismatch", // 20x
    "perp-per-trade-cap",
    "perp-stop-required",
    "perp-stop-inside-liquidation", // 10x, stop past liquidation
    "perp-market-not-allowed",
    "drawdown-breaker",
    "perp-open-notional-cap",
    "perp-close-in-flight",
    "perp-not-granted", // the same open on a signature without the marker
    "perp-venue-incident",
    "target-allowlist", // a deposit aimed off the sealed proxy
    "approved", // close under the breaker
    "approved", // close at the daily cap
    "approved", // close at the ops cap
    "approved", // close after the session key expired
    "approved", // withdrawal under the breaker
  ];

  it("holds every exact rule, and the doors stay open", () => {
    const result = runWallBattery(perpGrant(), NOW);
    for (const c of result.cases) assert.equal(c.held, true, `${c.attempt}: ${c.rule ?? "approved"} ${c.detail ?? ""}`);
    assert.equal(result.allHeld, true);
    assert.deepEqual(
      result.cases.slice(-PERP_RULES.length).map((entry) => entry.rule ?? "approved"),
      PERP_RULES,
    );
  });

  it("holds on every per-trade cap a signer can seal — a small cap is not a false breach", () => {
    for (const perTrade of [1, 10, 25, 1000]) {
      const result = runWallBattery(perpGrant(perTrade, Math.max(100, perTrade)), NOW);
      assert.equal(result.allHeld, true, `per-trade ${perTrade}`);
      assert.deepEqual(result.cases.slice(-PERP_RULES.length).map((c) => c.rule ?? "approved"), PERP_RULES, `per-trade ${perTrade}`);
    }
  });

  it("the mirror is sourced from the grant: the proxy is the perp limit's and NOT an allowed target", () => {
    const limits = limitsFromGrant(perpGrant());
    assert.equal(limits.perp?.proxy, LIGHTER_ROUTE_V1.proxy);
    assert.equal(limits.perp?.apiKeyIndex, LIGHTER_ROUTE_V1.apiKeyIndex);
    assert.equal(limits.perp?.apiPublicKey, PUB);
    assert.ok(!limits.allowedTargets.map((a) => a.toLowerCase()).includes(LIGHTER_ROUTE_V1.proxy));
    // No private-key material rides the limits, sealed or otherwise.
    assert.ok(!("apiKeySealed" in (limits.perp ?? {})));
  });

  it("no perp cases for a signature that did not seal the route — marker absent, or the wrong chain", () => {
    const plain = runWallBattery(grant([TRADEABLE_V2, "multihop"]), NOW);
    assert.ok(!plain.cases.some((c) => /perp|Lighter/.test(c.attempt)));
    const offChain = runWallBattery({ ...perpGrant(), chainId: 46630 }, NOW);
    assert.ok(!offChain.cases.some((c) => /perp|Lighter/.test(c.attempt)), "grantPerp refuses a perp block off 4663");
    assert.equal(limitsFromGrant({ ...perpGrant(), chainId: 46630 }).perp, undefined);
  });
});
