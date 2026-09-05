import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GAS_FLOOR_USDG, preflight, rank, verdict, type PreflightInput } from "./preflight";
import { STOCK_TOKENS } from "../../packages/core/src/index";

const NOW = 1_800_000_000;
const ACCOUNT = "0x00000000000000000000000000000000000000a1";

/** A ready-to-trade install. Each test spoils exactly one thing. */
function ready(over: Partial<PreflightInput> = {}): PreflightInput {
  return {
    settings: { bundlerApiKey: "pim_x", basketSymbols: ["QQQ"], buyPerTickUsdg: 50, idleFloorUsdg: 10_000 },
    grant: {
      smartAccount: ACCOUNT,
      chainId: 4663,
      expiresAt: NOW + 10 * 86_400,
      grantFeatures: ["transfer", "tradeable-v2", "multihop"],
    } as never,
    nowSec: NOW,
    usdg: 500,
    ethWei: 10n ** 16n, // 0.01 ETH
    bundlerReachable: true,
    missingPolicyContracts: [],
    deadPolicy: false,
    accountDeployed: true,
    ...over,
  };
}

const idsAt = (input: PreflightInput, level: string) =>
  preflight(input)
    .filter((c) => c.level === level)
    .map((c) => c.id);

describe("preflight — a ready install", () => {
  it("has no blockers", () => {
    const v = verdict(preflight(ready()));
    assert.equal(v.ready, true, JSON.stringify(idsAt(ready(), "blocker")));
    assert.equal(v.blockers, 0);
  });
});

describe("preflight — the things that stop a trade", () => {
  it("no bundler is a BLOCKER, not a note about paper mode", () => {
    // doctor reports this as ok ("running in paper mode"), which is the right
    // answer to a different question.
    const input = ready({ settings: { basketSymbols: ["QQQ"], buyPerTickUsdg: 50 }, bundlerReachable: null });
    assert.ok(idsAt(input, "blocker").includes("bundler"));
  });

  it("a bundler that doesn't answer is a blocker even though the key is present", () => {
    assert.ok(idsAt(ready({ bundlerReachable: false }), "blocker").includes("bundler"));
  });

  it("a TESTNET grant is a blocker — doctor prints the chain id inside an ok()", () => {
    const input = ready({ grant: { ...ready().grant!, chainId: 46630 } as never });
    const chain = preflight(input).find((c) => c.id === "chain")!;
    assert.equal(chain.level, "blocker");
    assert.match(chain.detail!, /practice only/i);
  });

  it("A DEAD POLICY IS A BLOCKER, and it is not the same check as the contract probe", () => {
    // The gap this closes. `missingPolicyContracts` probes the addresses this
    // code seals TODAY, and every one of them is deployed — so a grant carrying
    // the removed rate-limit policy passed preflight green while being unable to
    // land a single UserOperation. Measured 2026-08-30: RATE_LIMIT_POLICY_CONTRACT
    // has zero bytes on 4663 AND 46630.
    //
    // Both facts are asserted together on purpose: the contracts check must stay
    // `ok` here, because that is exactly the shape that fooled the command.
    const input = ready({ deadPolicy: true });
    const checks = preflight(input);
    const dead = checks.find((c) => c.id === "dead-policy")!;
    assert.equal(dead.level, "blocker");
    assert.equal(checks.find((c) => c.id === "policy-contracts")!.level, "ok");
    assert.equal(verdict(checks).ready, false);
    // The remedy is the whole value of the message: an owner who reads a
    // funding instruction and acts on it has spent money on a dead account.
    assert.match(dead.detail!, /re-sign/i);
  });

  it("an expired grant is a blocker", () => {
    const input = ready({ grant: { ...ready().grant!, expiresAt: NOW - 1 } as never });
    assert.ok(idsAt(input, "blocker").includes("expiry"));
  });

  it("ZERO ETH is a blocker, and says USDG cannot pay for it", () => {
    const gas = preflight(ready({ ethWei: 0n })).find((c) => c.id === "gas")!;
    assert.equal(gas.level, "blocker");
    assert.match(gas.detail!, /USDG is capital/);
    // The first op also deploys the account — people size for one swap.
    assert.match(gas.detail!, /deploy/);
  });

  it("an UNREADABLE balance is a warning, not a blocker — unknown is not zero", () => {
    assert.ok(idsAt(ready({ ethWei: null }), "warn").includes("gas"));
    assert.ok(idsAt(ready({ usdg: null }), "warn").includes("cash"));
  });

  it("no USDG is a blocker", () => {
    assert.ok(idsAt(ready({ usdg: 0 }), "blocker").includes("cash"));
  });

  it("a basket the key cannot SELL is a blocker — the one-way door", () => {
    // A legacy grant can sell only QQQ/NVDA/TSLA; AAPL is in the current set.
    const legacy = ready({
      settings: { bundlerApiKey: "k", basketSymbols: ["AAPL"], buyPerTickUsdg: 50 },
      grant: { ...ready().grant!, grantFeatures: ["transfer"] } as never,
    });
    const sell = preflight(legacy).find((c) => c.id === "sellable")!;
    assert.equal(sell.level, "blocker");
    assert.match(sell.detail!, /no-exit/);
  });

  it("blockers sort to the top, because that is what gets read", () => {
    const ranked = rank(preflight(ready({ ethWei: 0n, usdg: 0 })));
    assert.equal(ranked[0]!.level, "blocker");
    assert.equal(ranked[ranked.length - 1]!.level, "ok");
  });
});

describe("preflight — the things that make a trade pointless", () => {
  it("warns when a leg is below the gas floor, with the number", () => {
    // The default shape: 25 per tick over 3 symbols is 8.33 a leg.
    const input = ready({
      settings: { bundlerApiKey: "k", basketSymbols: ["QQQ", "NVDA", "TSLA"], buyPerTickUsdg: 25, idleFloorUsdg: 10_000 },
    });
    const leg = preflight(input).find((c) => c.id === "leg-size")!;
    assert.equal(leg.level, "warn");
    assert.match(leg.title, /8\.33 USDG per leg/);
    assert.match(leg.detail!, new RegExp(String(GAS_FLOOR_USDG)));
  });

  it("is happy once a leg clears the floor", () => {
    const leg = preflight(ready()).find((c) => c.id === "leg-size")!;
    assert.equal(leg.level, "ok");
  });

  it("warns that idle cash is swept to the vault on the first tick", () => {
    // Default idleFloorUsdg of 50 against a 500 deposit: ~400 leaves at once,
    // and a vault deposit counts against the DAILY spend cap.
    const input = ready({
      settings: { bundlerApiKey: "k", basketSymbols: ["QQQ"], buyPerTickUsdg: 50, idleFloorUsdg: 50 },
    });
    const sweep = preflight(input).find((c) => c.id === "idle-sweep")!;
    assert.equal(sweep.level, "warn");
    assert.match(sweep.detail!, /daily spend cap/);
  });

  it("says nothing about the sweep when the floor is above the deposit", () => {
    assert.equal(preflight(ready()).find((c) => c.id === "idle-sweep"), undefined);
  });

  it("warns that a legacy grant is narrow, and names what re-signing adds", () => {
    const input = ready({ grant: { ...ready().grant!, grantFeatures: ["transfer"] } as never });
    const f = preflight(input).find((c) => c.id === "grant-features")!;
    assert.equal(f.level, "warn");
    // AAPL is in the current set and not the legacy three.
    assert.match(f.detail!, /AAPL/);
  });

  it("warns that single-hop-only puts most memecoins out of reach", () => {
    const input = ready({
      grant: { ...ready().grant!, grantFeatures: ["transfer", "tradeable-v2"] } as never,
    });
    const hop = preflight(input).find((c) => c.id === "multihop")!;
    assert.equal(hop.level, "warn");
    assert.match(hop.detail!, /memecoin/);
  });
});

describe("preflight — no grant", () => {
  it("stops at the grant rather than reporting on a book that does not exist", () => {
    const checks = preflight(ready({ grant: null }));
    assert.ok(checks.some((c) => c.id === "grant" && c.level === "blocker"));
    assert.equal(checks.find((c) => c.id === "cash"), undefined);
  });
});

describe("the symbol lists this depends on", () => {
  it("every basket symbol the default install uses exists in the registry", () => {
    // Guards the sellable check: an unknown symbol is treated as uncovered, so
    // a typo in DEFAULT_BASKET_SYMBOLS would read as a blocker rather than a bug.
    for (const sym of ["QQQ", "NVDA", "TSLA"]) {
      assert.ok(STOCK_TOKENS.some((t) => t.symbol === sym), `${sym} missing from the registry`);
    }
  });
});

describe("preflight — when a sponsor pays the gas", () => {
  it("zero ETH stops being a blocker, because it stops being true", () => {
    // Unsponsored this is the one condition that guarantees failure. Sponsored,
    // the account trades perfectly well on an empty ETH balance, and failing the
    // whole preflight over it would report a working install as broken.
    const gas = preflight(ready({ ethWei: 0n, sponsored: true })).find((c) => c.id === "gas")!;
    assert.equal(gas.level, "warn");
    assert.equal(verdict(preflight(ready({ ethWei: 0n, sponsored: true }))).ready, true);
  });

  it("still says it, because the way OUT is not sponsored", () => {
    // Recovery pays its own fee from the balance it is sweeping, so an owner who
    // never adds any ETH can trade for months and then find they cannot
    // withdraw. This is the only screen that will ever mention that.
    const gas = preflight(ready({ ethWei: 0n, sponsored: true })).find((c) => c.id === "gas")!;
    assert.match(gas.title, /moving money OUT is not/i);
    assert.match(gas.detail!, /withdraw/i);
    assert.doesNotMatch(gas.detail!, /there is no paymaster/);
  });

  it("does NOT excuse having nothing to trade with", () => {
    // With the fee covered, no USDG is the only real blocker left — and it is
    // still a blocker.
    const v = verdict(preflight(ready({ ethWei: 0n, usdg: 0, sponsored: true })));
    assert.equal(v.ready, false);
    assert.ok(idsAt(ready({ ethWei: 0n, usdg: 0, sponsored: true }), "blocker").includes("cash"));
  });

  it("UNSPONSORED is untouched — zero ETH is still a blocker", () => {
    // The default, and every install that has not opted in.
    for (const [label, over] of [
      ["sponsored absent", { ethWei: 0n }],
      ["sponsored false", { ethWei: 0n, sponsored: false }],
    ] as const) {
      const gas = preflight(ready(over)).find((c) => c.id === "gas")!;
      assert.equal(gas.level, "blocker", label);
      assert.match(gas.detail!, /there is no paymaster/);
    }
  });

  it("an UNREADABLE balance is still a warning, sponsored or not", () => {
    // Sponsorship says nothing about whether the RPC answered.
    assert.ok(idsAt(ready({ ethWei: null, sponsored: true }), "warn").includes("gas"));
  });
});
