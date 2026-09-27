import assert from "node:assert/strict";
import test from "node:test";
import { limitsFromGrant } from "./limits";
import { checkPolicy, type AgentState, type TradeIntent } from "./policy";
import {
  CASH,
  ENERGY_ROUTE_V1,
  GRANT_ENERGY,
  MERRYMEN_TOKEN,
  buildCallPermissions,
  grantWallOptions,
  usdgUnits,
  type GrantCaps,
  type StoredGrant,
} from "../../packages/core/src/index";

/**
 * THE ENERGY MIRROR — the wall and the worker asserted against each other, the
 * v4-adapter-mirror idiom.
 *
 * Both directions matter and this file holds both. LOOSER than the chain: a
 * mirror that admits an energy buy the wall never sealed builds a UserOp the
 * account contract refuses — gas spent to be told no — or, worse, lets a
 * generic `swap` name the v2 router and routes it through a v3 builder that
 * never quoted it. STRICTER than the chain: a mirror that refuses what the
 * wall grants kills the owner's energy buy off-chain, and the route looks
 * granted and never fires.
 *
 * The load-bearing choice under test: limits.energy comes from the GRANT via
 * grantEnergyRoute (the GRANT_ENERGY marker AND chain 4663) — the same marker
 * grantWallOptions rebuilds the permission from — and never enters
 * allowedTargets.
 */

const CAPS: GrantCaps = { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 14, maxDrawdownPct: 5, maxOpsPerDay: 24 };
const SELF = "0x00000000000000000000000000000000000000a9" as const;
const NOW = Math.floor(Date.now() / 1000);

const grantWith = (over: Partial<StoredGrant>): StoredGrant =>
  ({
    smartAccount: SELF,
    owner: "0x00000000000000000000000000000000000000b1",
    sessionKeyAddress: "0x00000000000000000000000000000000000000c1",
    serialized: "x",
    caps: CAPS,
    grantedAt: 1_800_000_000,
    expiresAt: NOW + 86_400,
    chainId: 4663,
    grantFeatures: ["tradeable-v2", "multihop", GRANT_ENERGY],
    ...over,
  }) as unknown as StoredGrant;

const CALM: AgentState = {
  spentTodayUsdg: 0n,
  opsToday: 0,
  equityUsdg: 1_000_000_000n,
  highWaterMarkUsdg: 1_000_000_000n,
  nowSec: NOW,
};

const buy = (amount: bigint, over: Partial<Extract<TradeIntent, { kind: "energy-buy" }>> = {}): TradeIntent => ({
  kind: "energy-buy",
  target: ENERGY_ROUTE_V1.router,
  sellToken: CASH.USDG as `0x${string}`,
  buyToken: MERRYMEN_TOKEN.address as `0x${string}`,
  sellAmountRaw: amount,
  notionalUsdg: amount,
  ...over,
});

type Perm = { target: string; functionName?: string; args?: unknown[] };

/** The wall the grant's own marker rebuilds, from the real builder. */
function wallOf(grant: StoredGrant): Perm[] {
  return buildCallPermissions(grant.caps, SELF, grantWallOptions(grant)) as unknown as Perm[];
}
const routerPerms = (perms: Perm[]) =>
  perms.filter(
    (p) =>
      p.target.toLowerCase() === ENERGY_ROUTE_V1.router &&
      p.functionName === "swapExactTokensForTokensSupportingFeeOnTransferTokens",
  );

test("marker on 4663: the wall seals the swap AND the mirror admits an honest buy", () => {
  const grant = grantWith({});
  assert.equal(routerPerms(wallOf(grant)).length, 1, "the chain half: exactly one energy permission");
  const limits = limitsFromGrant(grant);
  assert.deepEqual(limits.energy, { router: ENERGY_ROUTE_V1.router, token: ENERGY_ROUTE_V1.path[2] });
  assert.equal(limits.energy!.token, MERRYMEN_TOKEN.address.toLowerCase());
  assert.deepEqual(checkPolicy(buy(usdgUnits(CAPS.perTradeUsdg)), limits, CALM), { ok: true });
});

test("the mirror's per-trade cap IS the wall's USDG approve cap — the only allowance the router can pull", () => {
  const grant = grantWith({});
  const approve = wallOf(grant).find(
    (p) => p.target.toLowerCase() === (CASH.USDG as string).toLowerCase() && p.functionName === "approve",
  )!;
  const [spenders, amount] = approve.args as [{ value: string[] }, { value: bigint }];
  assert.ok(spenders.value.map((s) => s.toLowerCase()).includes(ENERGY_ROUTE_V1.router), "the router rides the USDG approve");
  assert.equal(amount.value, limitsFromGrant(grant).perTradeUsdg, "LTE bound on chain == per-trade cap in the mirror");
});

test("no marker, or the marker off mainnet: no permission, no energy limit, energy-not-granted", () => {
  for (const grant of [
    grantWith({ grantFeatures: ["tradeable-v2", "multihop"] }),
    grantWith({ chainId: 46630 }),
    grantWith({ chainId: undefined as unknown as number }),
  ]) {
    const limits = limitsFromGrant(grant);
    assert.equal(limits.energy, undefined);
    const v = checkPolicy(buy(1_000_000n), limits, CALM);
    assert.equal(!v.ok && v.rule, "energy-not-granted");
  }
  // And on a marker-less mainnet grant the wall really has no such permission.
  assert.equal(routerPerms(wallOf(grantWith({ grantFeatures: ["tradeable-v2"] }))).length, 0);
});

test("THE ROUTER IS NEVER A GENERIC TARGET: a `swap` aimed at it is target-allowlist on every grant", () => {
  for (const grant of [grantWith({}), grantWith({ grantFeatures: ["tradeable-v2"] })]) {
    const limits = limitsFromGrant(grant);
    assert.ok(!limits.allowedTargets.map((a) => a.toLowerCase()).includes(ENERGY_ROUTE_V1.router));
    const v = checkPolicy(
      {
        kind: "swap",
        target: ENERGY_ROUTE_V1.router,
        sellToken: CASH.USDG as `0x${string}`,
        buyToken: MERRYMEN_TOKEN.address as `0x${string}`,
        sellAmountRaw: 1_000_000n,
        notionalUsdg: 1_000_000n,
      },
      limits,
      CALM,
    );
    assert.equal(!v.ok && v.rule, "target-allowlist");
  }
});

test("the budgets bind: per-trade, daily, ops; and the size must be a size", () => {
  const limits = limitsFromGrant(grantWith({}));
  const rule = (i: TradeIntent, s: AgentState = CALM) => {
    const v = checkPolicy(i, limits, s);
    return v.ok ? "ok" : v.rule;
  };
  assert.equal(rule(buy(usdgUnits(CAPS.perTradeUsdg) + 1n)), "per-trade-cap");
  assert.equal(rule(buy(usdgUnits(5)), { ...CALM, spentTodayUsdg: usdgUnits(46) }), "daily-cap");
  assert.equal(rule(buy(usdgUnits(4)), { ...CALM, spentTodayUsdg: usdgUnits(46) }), "ok");
  assert.equal(rule(buy(1n), { ...CALM, opsToday: CAPS.maxOpsPerDay }), "ops-cap");
  assert.equal(rule(buy(0n)), "non-positive");
  assert.equal(rule(buy(1_000_000n, { notionalUsdg: 999_999n })), "non-positive");
});

test("no asset-allowlist from the watch set and no no-exit: $MERRYMEN is neither watched nor sellable", () => {
  const limits = limitsFromGrant(grantWith({}), []);
  assert.ok(!limits.allowedAssets.map((a) => a.toLowerCase()).includes(MERRYMEN_TOKEN.address.toLowerCase()));
  assert.ok(!(limits.sellableAssets ?? []).map((a) => a.toLowerCase()).includes(MERRYMEN_TOKEN.address.toLowerCase()));
  assert.deepEqual(checkPolicy(buy(1_000_000n), limits, CALM), { ok: true });
});
