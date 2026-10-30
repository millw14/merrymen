/**
 * A PERPS WALLET'S WALL CARRIES NO SPOT AUTHORITY — WallOptions.perpsOnly.
 *
 * One owner key holds two Kernel accounts: Spot at index 0 and Perps at index
 * 1 (grant.ts accountIndexForPurpose). Neither's authority may reach the
 * other, and the wall is where that is true on chain rather than by argument.
 * A Perps wall keeps the perp route when a perp block is sealed, and the energy
 * buy when it is asked for, and nothing else: no stock or coin approve, no
 * swap, no adapter, no vault, no Rialto or v4 route, no USDG transfer out. A
 * paper Perps grant seals neither, so its wall is EMPTY (decision D5), and an
 * empty wall can do nothing on chain.
 *
 * And the Spot wall does not move. Every grant signed before Perps must keep
 * rebuilding as the wall it was signed over, key for key and byte for byte;
 * wall-reconstruction.test.ts and the canonical-wall fixtures pin that for the
 * whole matrix, and this file pins that the new option cannot reach it.
 *
 * Ported from the perps branch's web/src/lib/dedicated-perps-wall.test.ts (its
 * core cases; the signer and canonical-verifier cases arrive with the signer).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Address } from "viem";
import { CallPolicyVersion, toCallPolicy } from "@zerodev/permissions/policies";

import { buildCallPermissions, buildWallPolicies, grantWallOptions, type WallOptions } from "./wall";
import { wallShape } from "./first-enable-gas";
import { GRANT_SCOPED_SPENDERS, TRADEABLE_V2 } from "./grant";
import { ENERGY_ROUTE_V1, GRANT_ENERGY } from "./energy";
import { GRANT_PERP_LIGHTER, LIGHTER_ROUTE_V1 } from "./perps";
import { CASH } from "./tokens";

const CAPS = { perTradeUsdg: 10, dailyUsdg: 40, expiryDays: 14, maxDrawdownPct: 5, maxOpsPerDay: 24 };
const ACCOUNT = "0x00000000000000000000000000000000000a11ce" as Address;
/** A real Lighter API public key (the official signer's, from the spike), as wall-reconstruction.test.ts uses. */
const PERP_PK = "0x2427c4493c2df1a3ecdd750f1398b865e5428907c41065f0612cb3fa6b5ea0d7ac00465b07f3acd7" as const;
const PERP = { apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: PERP_PK } as const;
const PERP_BLOCK = { route: GRANT_PERP_LIGHTER, ...PERP, apiKeySealed: "aes-gcm-blob" };

/** Every Spot widening there is, at once: what a Perps wall must refuse to carry whatever it is handed. */
const EVERY_SPOT_OPTION: WallOptions = {
  extraTokens: [{ symbol: "C0", address: `0x${"a0".repeat(20)}` as Address, decimals: 18 }],
  withdrawalAddresses: ["0x9999999999999999999999999999999999999999"],
  allowRialto: true,
  allowUniswapV4: true,
  v4AdapterAddress: "0x6666666666666666666666666666666666666666",
  ponsAdapterAddress: "0x7777777777777777777777777777777777777777",
  ponsClassVaultAddress: "0x2222222222222222222222222222222222222222",
  ponsClassVaultFactoryAddress: "0x3333333333333333333333333333333333333333",
  trencherVaultAddress: "0x4444444444444444444444444444444444444444",
  trencherFactoryAddress: "0x5555555555555555555555555555555555555555",
  scopedSpenders: true,
};

const perms = (opts: WallOptions) => buildCallPermissions(CAPS, ACCOUNT, opts);
const lower = (a: string) => a.toLowerCase();
const VENUE_TARGETS = new Set([CASH.USDG, LIGHTER_ROUTE_V1.proxy, ENERGY_ROUTE_V1.router].map(lower));
const policyData = (opts: WallOptions) =>
  toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions: perms(opts) as never }).getPolicyData();

describe("a Perps wall", () => {
  it("is EMPTY with no perp block and no energy buy — the paper Perps wallet", () => {
    assert.deepEqual(perms({ perpsOnly: true }), []);
    assert.deepEqual(perms({ perpsOnly: true, ...EVERY_SPOT_OPTION }), [], "every Spot option is dropped, not sealed");
    assert.equal(wallShape(perms({ perpsOnly: true })).permissions, 0);
    // Still a policy set a signer can make: the expiry and an empty call policy.
    assert.doesNotThrow(() => buildWallPolicies({ caps: CAPS, smartAccount: ACCOUNT, perpsOnly: true }));
  });

  it("never carries a Spot permission, whatever it is handed beside the perp route and the energy buy", () => {
    const wall = perms({ ...EVERY_SPOT_OPTION, perpsOnly: true, perpLighter: PERP, energyBuy: true });
    assert.ok(wall.length > 1);
    for (const p of wall) assert.ok(VENUE_TARGETS.has(lower(p.target)), `a Spot target survived: ${p.target} ${p.functionName}`);
    assert.ok(!wall.some((p) => ["transfer", "exactInputSingle", "tradeExactIn", "createVault", "execute"].includes(p.functionName ?? "")));
    // ONE USDG permission, the approve, naming the venue and the router alone, capped at one trade.
    const usdg = wall.filter((p) => lower(p.target) === lower(CASH.USDG));
    assert.equal(usdg.length, 1);
    assert.equal(usdg[0]!.functionName, "approve");
    const [spender, amount] = usdg[0]!.args as unknown as [{ value: readonly string[] }, { value: bigint }];
    assert.deepEqual(spender.value, [ENERGY_ROUTE_V1.router, LIGHTER_ROUTE_V1.proxy]);
    assert.equal(amount.value, 10_000_000n);
  });

  it("names only what it carries in the USDG approve: the venue alone, or the router alone", () => {
    const spenders = (opts: WallOptions) => {
      const approve = perms({ perpsOnly: true, ...opts }).find((p) => lower(p.target) === lower(CASH.USDG));
      return (approve?.args as unknown as [{ value: readonly string[] }] | undefined)?.[0].value;
    };
    assert.deepEqual(spenders({ perpLighter: PERP }), [LIGHTER_ROUTE_V1.proxy]);
    assert.deepEqual(spenders({ energyBuy: true }), [ENERGY_ROUTE_V1.router]);
    assert.equal(spenders({}), undefined);
  });

  it("keeps each venue permission byte for byte as the Spot wall seals it — one description per route", () => {
    const opts: WallOptions = { ...EVERY_SPOT_OPTION, perpLighter: PERP, energyBuy: true };
    const route = (p: { target: string }) => [LIGHTER_ROUTE_V1.proxy, ENERGY_ROUTE_V1.router].map(lower).includes(lower(p.target));
    assert.deepEqual(perms({ ...opts, perpsOnly: true }).filter(route), perms(opts).filter(route));
  });

  it("is what buildWallPolicies seals — the option is not dropped on the way", () => {
    // The trap wall.ts names five times over: an option the signer sizes with
    // (buildCallPermissions) that buildWallPolicies does not forward is a
    // signature over a different wall — here, the Spot wall at the Perps address.
    const opts: WallOptions = { ...EVERY_SPOT_OPTION, perpsOnly: true, energyBuy: true };
    const sealed = buildWallPolicies({ caps: CAPS, smartAccount: ACCOUNT, now: 1, ...opts }).policies[1]!;
    assert.equal(sealed.getPolicyData(), policyData(opts));
    assert.notEqual(sealed.getPolicyData(), policyData({ ...opts, perpsOnly: false }), "perpsOnly dropped");
  });
});

describe("the Spot wall does not move", () => {
  it("absent, or false, is the wall it always was", () => {
    for (const opts of [{}, EVERY_SPOT_OPTION, { ...EVERY_SPOT_OPTION, perpLighter: PERP, energyBuy: true }] as WallOptions[]) {
      assert.deepEqual(perms({ ...opts, perpsOnly: false }), perms(opts));
      assert.equal(policyData({ ...opts, perpsOnly: false }), policyData(opts));
    }
  });
});

describe("grantWallOptions takes perpsOnly from the signed purpose, and only from it", () => {
  const spot = { grantFeatures: [TRADEABLE_V2, GRANT_ENERGY], chainId: 4663 };

  it("Spot, absent or named, keeps exactly the keys it always had", () => {
    for (const g of [spot, { ...spot, purpose: "spot" }]) {
      const opts = grantWallOptions(g);
      assert.equal("perpsOnly" in opts, false);
      assert.deepEqual(Object.keys(opts).sort(), ["allowRialto", "allowUniswapV4", "energyBuy", "extraTokens", "scopedSpenders"]);
    }
  });

  it("a Perps grant rebuilds the Perps wall; a paper one (no perp block, no energy) rebuilds the empty one", () => {
    assert.equal(grantWallOptions({ purpose: "perps" }).perpsOnly, true);
    assert.deepEqual(perms(grantWallOptions({ purpose: "perps", grantFeatures: [], chainId: 4663 })), []);
    // Spot markers on a Perps grant still rebuild no Spot permission.
    const dressed = { purpose: "perps", grantFeatures: [TRADEABLE_V2, "rialto", "v4", GRANT_SCOPED_SPENDERS], grantTokens: [`0x${"a0".repeat(20)}`], chainId: 4663 };
    assert.deepEqual(perms(grantWallOptions(dressed)), []);
    const live = { purpose: "perps", grantFeatures: [GRANT_PERP_LIGHTER, GRANT_ENERGY], chainId: 4663, perp: PERP_BLOCK };
    const wall = perms(grantWallOptions(live));
    assert.ok(wall.length > 1);
    for (const p of wall) assert.ok(VENUE_TARGETS.has(lower(p.target)), p.target);
  });

  it("a purpose that names no wallet is refused, never rebuilt as Spot", () => {
    for (const purpose of ["Perps", "", "solana", 1, null]) {
      assert.throws(() => grantWallOptions({ ...spot, purpose }), /wallet purpose/, String(purpose));
    }
  });
});
