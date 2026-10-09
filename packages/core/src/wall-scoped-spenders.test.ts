/**
 * EACH SPENDER ONLY ON THE TOKENS IT PULLS — WallOptions.scopedSpenders.
 *
 * ── THE OWNER WHO COULD NOT HAVE ALL OF IT ──────────────────────────────
 *
 * An owner with the Autonomous Trencher and three custom tokens wanted UBIK,
 * which trades only on Uniswap v4. With the v4 adapter added the wall came to
 * ~15.75M bounded first-enable gas against the 14M product maximum, so the
 * signer refused it, and the choices they were offered were all losses: keep
 * Trencher and drop v4 (UBIK then refused as `no-route`), or keep v4 and drop
 * Trencher or a token.
 *
 * Most of that wall was reach nothing used. Every spender sat in the ONE_OF of
 * every approve — fourteen stocks and each custom token — though the Morpho,
 * class and Trencher vaults only ever pull USDG, and the v4 adapter's two legs
 * listed every stock though every tradeable stock has v3 depth. Scoped, the same
 * wall is ~13.11M and signs; a re-sign has room for a fourth coin.
 *
 * ── STRICTLY NARROWER, AND THE OLD WALL UNTOUCHED ───────────────────────
 *
 * Every call the scoped wall permits, the unscoped one permits too: same
 * permissions in the same order, each ONE_OF a subset, every scalar rule equal.
 * And without the marker nothing changes byte for byte, because every grant
 * signed before it must keep rebuilding as the wall it was signed over.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Address } from "viem";

import {
  buildCallPermissions,
  buildWallPolicies,
  grantV4AdapterAssets,
  grantV4AdapterReaches,
  grantWallOptions,
  v4AdapterAssets,
  type WallOptions,
} from "./wall";
import { firstEnableEnvelope, wallShape, wallSignable } from "./first-enable-gas";
import { GRANT_SCOPED_SPENDERS } from "./grant";
import { MORPHO, RIALTO, UNISWAP } from "./protocols";
import { CASH, STOCK_TOKENS, TRADEABLE_SYMBOLS } from "./tokens";
import { ENERGY_ROUTE_V1 } from "./energy";
import { LIGHTER_ROUTE_V1 } from "./perps";
import { CallPolicyVersion, toCallPolicy } from "@zerodev/permissions/policies";

const CAPS = { perTradeUsdg: 50, dailyUsdg: 200, expiryDays: 30, maxDrawdownPct: 20, maxOpsPerDay: 100 };
const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;
const CLASS_VAULT = "0x2222222222222222222222222222222222222222";
const CLASS_FACTORY = "0x3333333333333333333333333333333333333333";
const TRENCHER_VAULT = "0x4444444444444444444444444444444444444444";
const TRENCHER_FACTORY = "0x5555555555555555555555555555555555555555";
const V4_ADAPTER = "0x6666666666666666666666666666666666666666" as Address;
const PONS_ADAPTER = "0x7777777777777777777777777777777777777777" as Address;
const coin = (i: number) => ({
  symbol: `C${i}`,
  address: `0x${(0xa0 + i).toString(16).padStart(2, "0").repeat(20)}` as Address,
  decimals: 18,
});
const UBIK = coin(0);
/** A canonical Lighter API public key at the route's index — the key perps.test.ts and worker/src/wall.test.ts use. */
const PERP = {
  apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex,
  apiPublicKey: "0x2427c4493c2df1a3ecdd750f1398b865e5428907c41065f0612cb3fa6b5ea0d7ac00465b07f3acd7" as const,
};
const PROXY = LIGHTER_ROUTE_V1.proxy.toLowerCase();

/** class vault + Trencher + the v4 adapter + `n` coins — the owner's wall. */
const everything = (n: number): WallOptions => ({
  ponsClassVaultAddress: CLASS_VAULT,
  ponsClassVaultFactoryAddress: CLASS_FACTORY,
  trencherVaultAddress: TRENCHER_VAULT,
  trencherFactoryAddress: TRENCHER_FACTORY,
  v4AdapterAddress: V4_ADAPTER,
  extraTokens: Array.from({ length: n }, (_, i) => coin(i)),
});

type Perm = { target: string; functionName?: string; args?: readonly ({ condition: number; value: unknown } | null)[] };
const perms = (opts: WallOptions) => buildCallPermissions(CAPS, ACCOUNT, opts) as unknown as Perm[];
const lc = (a: readonly unknown[]) => a.map((x) => String(x).toLowerCase());
const approveOf = (ps: Perm[], token: string) =>
  ps.find((p) => p.functionName === "approve" && p.target.toLowerCase() === token.toLowerCase())!;
const spendersOf = (p: Perm) => lc(p.args![0]!.value as unknown[]);
const stocks = STOCK_TOKENS.filter((t) => (TRADEABLE_SYMBOLS as readonly string[]).includes(t.symbol)).map((t) => t.address);

describe("the owner's wall, signable at last", () => {
  for (const deploying of [false, true]) {
    it(`class + Trencher + v4 + three coins: refused unscoped, signed scoped (${deploying ? "first install" : "re-sign"})`, () => {
      const shape = (scoped: boolean) => wallShape(perms({ ...everything(3), scopedSpenders: scoped }) as never);
      assert.equal(wallSignable(shape(false), { deploying }).ok, false, "the wall the owner was refused");
      assert.equal(wallSignable(shape(true), { deploying }).ok, true, "the same wall, scoped");
      const saved = firstEnableEnvelope(shape(false), { deploying }).expectedBounded - firstEnableEnvelope(shape(true), { deploying }).expectedBounded;
      assert.ok(saved > 2_500_000n, `scoping saves ${saved} bounded gas`);
    });
  }

  it("a fourth coin on a re-sign, not on a first install, and never a fifth", () => {
    const fits = (n: number, deploying: boolean) =>
      wallSignable(wallShape(perms({ ...everything(n), scopedSpenders: true }) as never), { deploying }).ok;
    assert.equal(fits(3, true), true);
    // A first install of four coins predicts 13,937,573: 62,427 under the
    // maximum, which no operation, not even the bare install, can fit beside
    // it (KEY_INSTALL_RESERVE_BOUNDED). A re-sign pays no CREATE2 and has room.
    assert.equal(fits(4, true), false, "no operation could install it");
    assert.equal(fits(4, false), true);
    assert.equal(fits(5, false), false, "the 14M maximum did not move — the wall got smaller");
  });
});

describe("who is approved for what, scoped", () => {
  const all: WallOptions = { ...everything(2), ponsAdapterAddress: PONS_ADAPTER, energyBuy: true, scopedSpenders: true };
  const ps = perms(all);

  it("USDG: every spender, exactly as unscoped — every venue is funded in cash", () => {
    const unscoped = perms({ ...all, scopedSpenders: false });
    assert.deepEqual(spendersOf(approveOf(ps, CASH.USDG)), spendersOf(approveOf(unscoped, CASH.USDG)));
    for (const s of [UNISWAP.swapRouter02, MORPHO.steakhouseUsdgVault, V4_ADAPTER, PONS_ADAPTER, CLASS_VAULT, TRENCHER_VAULT, ENERGY_ROUTE_V1.router]) {
      assert.ok(spendersOf(approveOf(ps, CASH.USDG)).includes(s.toLowerCase()), `USDG approve names ${s}`);
    }
  });

  it("a stock: Router02 and nothing else", () => {
    for (const s of stocks) assert.deepEqual(spendersOf(approveOf(ps, s)), [UNISWAP.swapRouter02.toLowerCase()], s);
  });

  it("a custom coin: the routers that can sell it — Router02, the v4 adapter, the Pons adapter — and no vault", () => {
    assert.deepEqual(spendersOf(approveOf(ps, UBIK.address)), lc([UNISWAP.swapRouter02, V4_ADAPTER, PONS_ADAPTER]));
    for (const vault of [MORPHO.steakhouseUsdgVault, CLASS_VAULT, TRENCHER_VAULT]) {
      assert.ok(!spendersOf(approveOf(ps, UBIK.address)).includes(vault.toLowerCase()), `${vault} pulls USDG only`);
    }
  });

  it("the opt-in routers keep their place on every token", () => {
    const opted = perms({ ...all, allowRialto: true, allowUniswapV4: true });
    for (const t of [stocks[0]!, UBIK.address]) {
      const s = spendersOf(approveOf(opted, t));
      assert.ok(s.includes(RIALTO.routerSnapshot.toLowerCase()) && s.includes(UNISWAP.permit2.toLowerCase()), t);
    }
  });

  it("the v4 adapter trades cash and the owner's coins, never a stock", () => {
    const swap = ps.find((p) => p.functionName === "swapExactIn")!;
    const want = lc([CASH.USDG, coin(0).address, coin(1).address]);
    assert.deepEqual(lc(swap.args![0]!.value as unknown[]), want);
    assert.deepEqual(lc(swap.args![1]!.value as unknown[]), want);
    // ONE function for the wall and the worker's gate.
    assert.deepEqual(lc(v4AdapterAssets(all)), want);
  });

  it("Router02 still trades every stock", () => {
    const router = ps.find((p) => p.functionName === "exactInputSingle")!;
    for (const s of stocks) assert.ok(lc(router.args![0]!.value as unknown[]).includes(s.toLowerCase()), s);
  });
});

describe("perps: the Lighter proxy pulls USDG and nothing else, scoped or not", () => {
  // The proxy joins `usdgSpenders`, never `spenders`, so scoping has nothing to
  // filter it out of and nothing to add it to. Pinned on both shapes because
  // an old grant still rebuilds unscoped, and an uncapped allowance over the
  // book for an upgradeable venue contract is wrong on either.
  const all: WallOptions = { ...everything(2), ponsAdapterAddress: PONS_ADAPTER, energyBuy: true, perpLighter: PERP };
  const shapes = { unscoped: perms({ ...all, scopedSpenders: false }), scoped: perms({ ...all, scopedSpenders: true }) };
  const onProxy = (ps: Perm[]) => ps.filter((p) => p.target.toLowerCase() === PROXY);

  it("the proxy is on the USDG approve, and that approve is the same on both shapes", () => {
    for (const [shape, ps] of Object.entries(shapes)) {
      assert.ok(spendersOf(approveOf(ps, CASH.USDG)).includes(PROXY), `${shape}: USDG approve names the proxy`);
    }
    assert.deepEqual(spendersOf(approveOf(shapes.scoped, CASH.USDG)), spendersOf(approveOf(shapes.unscoped, CASH.USDG)));
  });

  it("and on no stock or custom-coin approve, on either shape", () => {
    for (const [shape, ps] of Object.entries(shapes)) {
      for (const t of [...stocks, coin(0).address, coin(1).address]) {
        assert.ok(!spendersOf(approveOf(ps, t)).includes(PROXY), `${shape}: ${t} approve must not name the proxy`);
      }
      // And no approve at all other than USDG's — the explicit list above is
      // the case that matters; this catches any token a later change adds.
      for (const p of ps.filter((p) => p.functionName === "approve" && p.target.toLowerCase() !== CASH.USDG.toLowerCase())) {
        assert.ok(!spendersOf(p).includes(PROXY), `${shape}: ${p.target} approve must not name the proxy`);
      }
    }
  });

  it("the three proxy permissions are the same on both shapes", () => {
    // deposit, changePubKey, withdrawPendingBalance — scoping is about who may
    // pull which token, and none of these is an approve.
    assert.deepEqual(
      onProxy(shapes.scoped).map((p) => p.functionName),
      ["deposit", "changePubKey", "withdrawPendingBalance"],
    );
    assert.deepEqual(onProxy(shapes.scoped), onProxy(shapes.unscoped));
  });
});

describe("strictly narrower, and the old wall untouched", () => {
  const combos: WallOptions[] = [
    {},
    { extraTokens: [coin(0)] },
    everything(3),
    { ...everything(1), ponsAdapterAddress: PONS_ADAPTER, energyBuy: true },
    { v4AdapterAddress: V4_ADAPTER, allowRialto: true },
    { ...everything(1), ponsAdapterAddress: PONS_ADAPTER, energyBuy: true, perpLighter: PERP },
  ];

  it("without the flag, byte for byte what was built before it existed", () => {
    for (const o of combos) assert.deepEqual(perms({ ...o, scopedSpenders: false }), perms(o));
  });

  it("with it, the same permissions in the same order, every list a subset, every scalar equal", () => {
    for (const o of combos) {
      const wide = perms(o);
      const narrow = perms({ ...o, scopedSpenders: true });
      assert.deepEqual(
        narrow.map((p) => [p.target.toLowerCase(), p.functionName]),
        wide.map((p) => [p.target.toLowerCase(), p.functionName]),
      );
      narrow.forEach((p, i) => {
        const w = wide[i]!;
        (p.args ?? []).forEach((a, j) => {
          const b = w.args![j];
          if (a === null || b === null) return assert.equal(a, b);
          assert.equal(a.condition, b!.condition);
          if (Array.isArray(a.value)) {
            const wider = new Set(lc(b!.value as unknown[]));
            for (const x of lc(a.value)) assert.ok(wider.has(x), `${p.functionName} on ${p.target}: ${x} is new`);
          } else assert.deepEqual(a.value, b!.value);
        });
      });
    }
  });

  it("buildWallPolicies seals the scoped wall it was asked for — the option is not dropped on the way", () => {
    // The trap wall.ts names four times before this: an option the signer
    // sizes with (buildCallPermissions) but buildWallPolicies does not forward
    // is a signature over a different wall from the one that was checked.
    const opts = { ...everything(3), scopedSpenders: true };
    const sealed = buildWallPolicies({ caps: CAPS, smartAccount: ACCOUNT, now: 1, ...opts }).policies[1]!;
    const expected = toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions: perms(opts) as never });
    const unscoped = toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions: perms({ ...opts, scopedSpenders: false }) as never });
    assert.equal(sealed.getPolicyData(), expected.getPolicyData());
    assert.notEqual(sealed.getPolicyData(), unscoped.getPolicyData());
  });

  it("and seals perps together with it — neither option is dropped for the other", () => {
    // Both are forwarded by name in buildWallPolicies. Dropping perps would sign
    // `perp-lighter-v1` over a wall with no deposit; dropping scoping would sign
    // the wall the signer had sized as too large.
    const base = { ...everything(3), scopedSpenders: true };
    const opts = { ...base, perpLighter: PERP };
    const data = (o: WallOptions) =>
      toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions: perms(o) as never }).getPolicyData();
    const sealed = buildWallPolicies({ caps: CAPS, smartAccount: ACCOUNT, now: 1, ...opts }).policies[1]!;
    assert.equal(sealed.getPolicyData(), data(opts));
    assert.notEqual(sealed.getPolicyData(), data(base), "perps dropped");
    assert.notEqual(sealed.getPolicyData(), data({ ...opts, scopedSpenders: false }), "scoping dropped");
  });
});

describe("the marker, and the worker's v4 gate", () => {
  const legacy = { grantTokens: [UBIK.address], grantFeatures: ["tradeable-v2", "v4-adapter"] };
  const scoped = { ...legacy, grantFeatures: [...legacy.grantFeatures, GRANT_SCOPED_SPENDERS] };

  it("grantWallOptions rebuilds the shape that was signed", () => {
    assert.equal(grantWallOptions(legacy).scopedSpenders, false);
    assert.equal(grantWallOptions(scoped).scopedSpenders, true);
  });

  it("an old grant's adapter still reaches stocks; a scoped one's does not", () => {
    const aapl = stocks[0]!;
    assert.equal(grantV4AdapterReaches(legacy, CASH.USDG, aapl), true);
    assert.equal(grantV4AdapterReaches(scoped, CASH.USDG, aapl), false);
    assert.equal(grantV4AdapterAssets(scoped).has(aapl.toLowerCase()), false);
  });

  it("UBIK, sealed, reaches v4 both ways on either shape — the buy the owner wanted", () => {
    for (const g of [legacy, scoped]) {
      assert.equal(grantV4AdapterReaches(g, CASH.USDG, UBIK.address.toUpperCase().replace("0X", "0x")), true);
      assert.equal(grantV4AdapterReaches(g, UBIK.address, CASH.USDG), true);
    }
  });

  it("a coin added after signing is on no leg, so v4 is never quoted for it", () => {
    for (const g of [legacy, scoped]) assert.equal(grantV4AdapterReaches(g, CASH.USDG, coin(9).address), false);
  });
});
