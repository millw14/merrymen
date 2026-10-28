import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FIRST_ENABLE_HARD_MAX_BOUNDED,
  firstEnableEnvelope,
  wallShape,
  wallSignable,
  FIRST_ENABLE_GAS_MODEL,
} from "./first-enable-gas";
import { buildCallPermissions, energyBuyFits, perpFits } from "./wall";
import type { GrantCaps } from "./grant";
import { LIGHTER_ROUTE_V1 } from "./perps";

/**
 * THE WALL'S OWN SIZE DECIDES WHAT ITS FIRST OPERATION MAY COST.
 *
 * Two funded agents proposed trades autonomously, passed policy, and were
 * refused at the executor with `gas-absurd` on the one operation that installs
 * their permission wall. The ceiling was not broken: it was derived for the
 * DEFAULT 18-permission wall plus five custom tokens, and it budgets for nothing
 * else. Each optional capability widens the spender list, which is pinned as a
 * ONE_OF on EVERY approve permission — so enabling one costs about what the
 * whole five-token margin was worth.
 *
 * The tests below pin, in order: the size model against the recorded sweep, the
 * envelope derivation, that a narrow wall cannot inherit a wide wall's headroom,
 * and that the hard maximum still binds.
 */

const CAPS = {
  perTradeUsdg: 25,
  dailyUsdg: 100,
  maxOpsPerDay: 48,
  maxDrawdownBps: 2000,
  ttlDays: 14,
} as unknown as GrantCaps;

const ME = "0x1111111111111111111111111111111111111111" as `0x${string}`;

const token = (i: number) => ({
  symbol: `T${i}`,
  address: ("0x" + (i + 0x2000).toString(16).padStart(40, "0")) as `0x${string}`,
  decimals: 18,
});

const shapeFor = (opts: Record<string, unknown> = {}) =>
  wallShape(buildCallPermissions(CAPS, ME, opts as never) as never);

const withTokens = (n: number, rest: Record<string, unknown> = {}) =>
  shapeFor({ extraTokens: Array.from({ length: n }, (_, i) => token(i)), ...rest });

describe("the size model reproduces the recorded stub sweep", () => {
  /**
   * MEASURED, ON THIS CHAIN, AGAINST THIS BUNDLER — and recorded in the repo
   * before this module existed. If the wall's encoding ever changes, these fail
   * here rather than silently shifting every envelope downstream.
   */
  const RECORDED: Record<number, number> = {
    0: 10_932,
    1: 11_444,
    5: 13_492,
    15: 18_612,
    40: 31_412,
  };

  for (const [tokens, stub] of Object.entries(RECORDED)) {
    it(`${tokens} custom token(s) -> stub ${stub} bytes`, () => {
      assert.equal(withTokens(Number(tokens)).stubBytes, stub);
    });
  }

  it("COUNTS the wall rather than predicting it from options", () => {
    // A closed-form expression over WallOptions is a second description of the
    // wall, and two descriptions drift the moment a capability adds a
    // permission. These come from the objects the signature is made over.
    const s = withTokens(0);
    assert.equal(s.permissions, 18, "the documented default wall");
    assert.ok(s.rules > 0 && s.oneOfEntries > 0);
    assert.equal(
      s.policyBlobBytes,
      64 + 224 * s.permissions + 160 * s.rules + 32 * s.params,
      "the blob is a function of what was counted",
    );
  });

  it("a custom token costs 512 bytes on a default wall", () => {
    // The figure gas-limits.ts quotes, arrived at independently here: 512 bytes
    // × 700.945 gas/byte = 358,884, its stated per-token gas cost.
    assert.equal(withTokens(1).stubBytes - withTokens(0).stubBytes, 512);
    assert.equal(withTokens(6).stubBytes - withTokens(5).stubBytes, 512);
  });
});

describe("a capability costs what several tokens cost", () => {
  it("enabling one venue widens every approve permission at once", () => {
    // THE FINDING THAT EXPLAINS THE INCIDENT. The spender list is pinned as a
    // ONE_OF on each of the 15+ approve permissions, so one more spender adds an
    // entry to every one of them.
    const plain = withTokens(0);
    const rialto = shapeFor({ allowRialto: true });
    const grew = rialto.stubBytes - plain.stubBytes;
    assert.ok(grew > 0, "a capability must cost something");
    assert.ok(
      grew >= 512,
      `one capability should cost at least a token's worth; grew ${grew} bytes`,
    );
  });

  it("so a wall can exceed the old flat ceiling with almost no custom tokens", () => {
    // Which is exactly what production showed: an agent refused as gas-absurd
    // whose wall carried a single custom token and several capabilities.
    const wide = withTokens(1, {
      allowRialto: true,
      allowUniswapV4: true,
      v4AdapterAddress: "0x" + "a".repeat(40),
      ponsAdapterAddress: "0x" + "b".repeat(40),
    });
    assert.ok(
      firstEnableEnvelope(wide).expectedBounded > 12_000_000n,
      "this shape is what the old 12,000,000 ceiling refused",
    );
  });
});

describe("the energy buy costs what it was measured to cost, and is sealed only when it fits", () => {
  /**
   * 1,408 BYTES, AND NOT A BYTE MORE. One permission (224), six EQUAL rules
   * (6 × 160 + 6 × 32) and ONE spender entry on the USDG approve (32).
   *
   * The figure is pinned because each of the two mistakes it would catch is a
   * silent widening that still passes every functional test: the router joining
   * the GLOBAL spender list (+448 on a default wall, one entry on each of the
   * fourteen stock approves — an uncapped allowance over the book), or a w0
   * amountIn pin (+192, redundant under the capped USDG approve).
   */
  it("adds exactly 1,408 stub bytes to the default wall", () => {
    assert.equal(withTokens(0, { energyBuy: true }).stubBytes - withTokens(0).stubBytes, 1_408);
    assert.equal(withTokens(0, { energyBuy: true }).permissions, 19, "the default 18, plus one");
  });

  it("and the cost does not grow with the basket — the router is not a spender on any token's approve", () => {
    for (const n of [1, 5, 9]) {
      assert.equal(
        withTokens(n, { energyBuy: true }).stubBytes - withTokens(n).stubBytes,
        1_408,
        `n=${n}: a per-token cost would mean the router joined the extras' approves`,
      );
    }
  });

  const CLASS = {
    ponsClassVaultAddress: "0x3fcdde6e011769ca05f0115f1543290862473216",
    ponsClassVaultFactoryAddress: "0x48a5603712d3d4f4e6e4e1cbd4f4f5d1c9e6ab3d",
  };
  const TRENCHER = {
    trencherVaultAddress: "0x" + "d".repeat(40),
    trencherFactoryAddress: "0x" + "e".repeat(40),
  };
  const tokens = (n: number) => Array.from({ length: n }, (_, i) => token(i));
  const fits = (chainId: number, deploying: boolean, opts: Record<string, unknown>) =>
    energyBuyFits(CAPS, ME, chainId, deploying, opts as never);

  it("ONLY ON 4663 — off mainnet the router is codeless and a buy would land having bought nothing", () => {
    assert.equal(fits(4663, true, {}), true, "the default wall with no tokens has room");
    assert.equal(fits(46630, true, {}), false, "testnet never seals it, whatever the room");
    assert.equal(fits(46630, false, {}), false);
    assert.equal(fits(1, true, {}), false);
  });

  it("ONLY WHEN IT FITS — a class+Trencher wall with a token has no room for it", () => {
    // Not even on a renewal: with the energy buy this wall predicts 13,961,815
    // re-signed, 38,185 under the maximum. That is less than the sponsor's own
    // limits, so no operation could ever install it — it was signable only
    // while signing ignored the operation that has to carry it
    // (KEY_INSTALL_RESERVE_BOUNDED).
    assert.equal(fits(4663, true, { ...CLASS, ...TRENCHER, extraTokens: tokens(1) }), false);
    assert.equal(fits(4663, false, { ...CLASS, ...TRENCHER, extraTokens: tokens(1) }), false);
    // The hosted default (class vault sealed) keeps room for a few tokens.
    assert.equal(fits(4663, true, { ...CLASS }), true);
  });

  it("`deploying` is a fact about the account, not a constant", () => {
    // A renewal pays no CREATE2, and that is exactly the room the energy buy
    // needs here.
    assert.equal(fits(4663, true, { ...CLASS, extraTokens: tokens(3) }), false);
    assert.equal(fits(4663, false, { ...CLASS, extraTokens: tokens(3) }), true);
  });

  it("IS the signing policy, one permission wider — never a second arithmetic", () => {
    for (const deploying of [true, false]) {
      for (const base of [{}, CLASS, { ...CLASS, ...TRENCHER }]) {
        for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 9]) {
          const opts = { ...base, extraTokens: tokens(n) };
          assert.equal(
            fits(4663, deploying, opts),
            wallSignable(shapeFor({ ...opts, energyBuy: true }), { deploying }).ok,
            `n=${n} deploying=${deploying}: energyBuyFits and wallSignable disagree`,
          );
        }
      }
    }
    // And the caller's own `energyBuy: false` cannot talk it out of measuring
    // the wider wall — it asks about the wall WITH the permission.
    assert.equal(fits(4663, true, { energyBuy: false }), fits(4663, true, {}));
  });
});

describe("perps cost what the wall says they cost, and are sealed only when they fit", () => {
  /**
   * 2,816 BYTES. Three permissions (3 × 224), eleven rules (deposit 4,
   * changePubKey 5, claim 2: 11 × 160 + 11 × 32) and ONE spender entry on the
   * USDG approve (32). Twice the energy buy — about 2.5M bounded gas — which is
   * why a wide wall has no room for it.
   *
   * Pinned for the energy buy's reason: the proxy joining the GLOBAL spender
   * list would add 32 bytes per stock and extra approve (an uncapped allowance
   * over the book), and pinning w0 of changePubKey — the account index nobody
   * knows at signing — would add a rule that matches nothing. Both are silent
   * in every functional test.
   */
  const PK = "0x2427c4493c2df1a3ecdd750f1398b865e5428907c41065f0612cb3fa6b5ea0d7ac00465b07f3acd7" as const;
  const PK2 = "0x3fba6f2e6d1cc97965c00bcb9032ffbd408f77cfb929db0a49d4abd0b090426efb651217ad43f02d" as const;
  const PERP = { apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: PK };
  const CLASS = {
    ponsClassVaultAddress: "0x3fcdde6e011769ca05f0115f1543290862473216",
    ponsClassVaultFactoryAddress: "0x48a5603712d3d4f4e6e4e1cbd4f4f5d1c9e6ab3d",
  };
  const TRENCHER = {
    trencherVaultAddress: "0x" + "d".repeat(40),
    trencherFactoryAddress: "0x" + "e".repeat(40),
  };
  // The shape every signer seals today (WallOptions.scopedSpenders). The
  // unscoped walls above and below are the legacy shape: what a grant signed
  // before the marker still rebuilds as, so they stay pinned too.
  const SCOPED = { scopedSpenders: true };
  const tokens = (n: number) => Array.from({ length: n }, (_, i) => token(i));
  const fits = (chainId: number, deploying: boolean, opts: Record<string, unknown>) =>
    perpFits(CAPS, ME, chainId, deploying, opts as never);

  it("adds exactly 2,816 stub bytes, whatever the basket", () => {
    for (const n of [0, 1, 5, 9]) {
      assert.equal(
        withTokens(n, { perpLighter: PERP }).stubBytes - withTokens(n).stubBytes,
        2_816,
        `n=${n}: a per-token cost would mean the proxy joined the extras' approves`,
      );
      // The same on the scoped wall: scoping filters who may pull a stock or a
      // coin, and the proxy was never on those lists, so it has nothing to
      // take away and nothing to add.
      assert.equal(
        withTokens(n, { ...SCOPED, perpLighter: PERP }).stubBytes - withTokens(n, SCOPED).stubBytes,
        2_816,
        `n=${n}, scoped: the proxy must sit on the USDG approve alone on this shape too`,
      );
    }
    assert.equal(withTokens(0, { perpLighter: PERP }).permissions, 21, "the default 18, plus three");
  });

  it("the size does not depend on WHICH key — so sizing before keygen is exact", () => {
    assert.deepEqual(withTokens(3, { perpLighter: PERP }), withTokens(3, { perpLighter: { ...PERP, apiPublicKey: PK2 } }));
    for (const deploying of [true, false]) {
      for (const base of [{}, CLASS, { ...CLASS, ...TRENCHER }, { ...CLASS, ...SCOPED }, { ...CLASS, ...TRENCHER, ...SCOPED }]) {
        for (const n of [0, 1, 2, 5]) {
          const opts = { ...base, extraTokens: tokens(n) };
          assert.equal(fits(4663, deploying, opts), fits(4663, deploying, { ...opts, perpLighter: PERP }), `n=${n}`);
        }
      }
    }
  });

  it("ONLY ON 4663 — there is no Lighter anywhere else, and a CALL to a codeless proxy 'succeeds'", () => {
    assert.equal(fits(4663, true, {}), true, "the default wall has room");
    assert.equal(fits(46630, true, {}), false, "testnet never seals it, whatever the room");
    assert.equal(fits(46630, false, { perpLighter: PERP }), false);
    assert.equal(fits(1, false, {}), false);
  });

  it("ONLY WHEN IT FITS — and on the legacy unscoped shape a class+Trencher wall has no room for it at all", () => {
    // Measured on the UNSCOPED wall only, where every vault sits in the ONE_OF
    // of every stock and coin approve: there the class vault and Trencher
    // together leave no room even with an empty basket, deploying or not. No
    // signer seals that shape any more (they all set scopedSpenders), so this
    // is not a promise about the walls owners sign today. The scoped figures
    // are pinned in the next test.
    assert.equal(fits(4663, true, { ...CLASS, ...TRENCHER }), false);
    assert.equal(fits(4663, false, { ...CLASS, ...TRENCHER }), false);
    // Unscoped, the class vault alone leaves room for perps with no tokens; a
    // renewal, which pays no CREATE2, has room for one.
    assert.equal(fits(4663, true, { ...CLASS }), true);
    assert.equal(fits(4663, true, { ...CLASS, extraTokens: tokens(1) }), false);
    assert.equal(fits(4663, false, { ...CLASS, extraTokens: tokens(1) }), true);
  });

  it("ON THE SCOPED WALL EVERY SIGNER SEALS — class+Trencher has room with an empty basket, the class vault for two coins", () => {
    // Scoping takes the three USDG-only vaults off every stock and coin
    // approve, and that is the room perps need. Measured, not derived:
    //   - class + Trencher with no coins predicts 13,824,076 bounded on a
    //     first install, 25,924 under the 13,850,000 wall maximum
    //     (FIRST_ENABLE_WALL_MAX_BOUNDED). So it fits, and one coin does not,
    //     deploying or not. An owner with Trencher who wants perps can hold no
    //     custom coin; that refusal is the signers' to word.
    assert.equal(fits(4663, true, { ...CLASS, ...TRENCHER, ...SCOPED }), true);
    assert.equal(fits(4663, true, { ...CLASS, ...TRENCHER, ...SCOPED, extraTokens: tokens(1) }), false);
    assert.equal(fits(4663, false, { ...CLASS, ...TRENCHER, ...SCOPED }), true);
    assert.equal(fits(4663, false, { ...CLASS, ...TRENCHER, ...SCOPED, extraTokens: tokens(1) }), false);
    //   - the class vault alone (the hosted default) carries perps with two
    //     coins on a first install and refuses a third; a renewal, which pays
    //     no CREATE2, carries three and refuses a fourth.
    assert.equal(fits(4663, true, { ...CLASS, ...SCOPED, extraTokens: tokens(2) }), true);
    assert.equal(fits(4663, true, { ...CLASS, ...SCOPED, extraTokens: tokens(3) }), false);
    assert.equal(fits(4663, false, { ...CLASS, ...SCOPED, extraTokens: tokens(3) }), true);
    assert.equal(fits(4663, false, { ...CLASS, ...SCOPED, extraTokens: tokens(4) }), false);
  });

  it("IS the signing policy, three permissions wider — never a second arithmetic", () => {
    for (const deploying of [true, false]) {
      for (const base of [
        {},
        CLASS,
        { ...CLASS, ...TRENCHER },
        { energyBuy: true },
        { ...CLASS, ...SCOPED },
        { ...CLASS, ...TRENCHER, ...SCOPED },
        { ...CLASS, ...SCOPED, energyBuy: true },
      ]) {
        for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 9]) {
          const opts = { ...base, extraTokens: tokens(n) };
          assert.equal(
            fits(4663, deploying, opts),
            wallSignable(shapeFor({ ...opts, perpLighter: PERP }), { deploying }).ok,
            `n=${n} deploying=${deploying}: perpFits and wallSignable disagree`,
          );
        }
      }
    }
  });

  it("a key in hand is validated — a non-canonical key throws rather than being sized", () => {
    assert.throws(() => fits(4663, true, { perpLighter: { ...PERP, apiPublicKey: `0x${"0".repeat(80)}` } }), /canonical/);
    assert.throws(() => fits(4663, true, { perpLighter: { ...PERP, apiKeyIndex: 0 } }), /key index/);
  });

  it("perps and the energy buy together: perps are asked first, energy over the wall that carries them", () => {
    // The droppable capability gives way. A wall with room for perps but not
    // both keeps perps and loses energy — never the other way round.
    for (const [shape, opts] of Object.entries({ unscoped: { ...CLASS }, scoped: { ...CLASS, ...SCOPED } })) {
      assert.equal(fits(4663, true, opts), true, shape);
      assert.equal(energyBuyFits(CAPS, ME, 4663, true, { ...opts, perpLighter: PERP } as never), false, shape);
      assert.equal(energyBuyFits(CAPS, ME, 4663, true, opts as never), true, `${shape}: energy alone would have fitted`);
    }
  });
});

describe("the envelope comes from the shape, never from the estimate", () => {
  it("a narrow wall gets a narrow allowance, well under the product cap", () => {
    const narrow = firstEnableEnvelope(withTokens(0));
    assert.ok(
      narrow.allowedMaxBounded < FIRST_ENABLE_HARD_MAX_BOUNDED,
      "the default wall must be bounded by its own size, not by the product cap",
    );
    // The allowance is the prediction plus the stated tolerance — never the
    // prediction alone (an estimate is allowed to be a little above the fit)
    // and never the product cap (which would hand a small wall a large wall's
    // headroom).
    assert.ok(narrow.allowedMaxBounded > narrow.expectedBounded);
  });

  it("AN ANOMALOUS ESTIMATE FOR A NARROW WALL IS STILL REFUSED", () => {
    // The property the old flat ceiling had and must not lose. A wall that
    // should cost ~9.7M may not be signed for 13M just because something said
    // so — its own envelope binds first, well below the hard maximum.
    const narrow = firstEnableEnvelope(withTokens(0));
    const anomalous = 13_000_000n;
    assert.ok(anomalous < FIRST_ENABLE_HARD_MAX_BOUNDED, "under the product cap");
    assert.ok(anomalous > narrow.allowedMaxBounded, "but over THIS wall's allowance");
  });

  it("a wider wall costs more, and only because it is wider", () => {
    // Monotonicity is asserted on the PREDICTION. The allowance is the
    // prediction plus tolerance, capped — so it is monotone until the cap binds
    // and flat after, which is the cap doing its job rather than a defect.
    const a = firstEnableEnvelope(withTokens(0)).expectedBounded;
    const b = firstEnableEnvelope(withTokens(5)).expectedBounded;
    const c = firstEnableEnvelope(withTokens(9)).expectedBounded;
    assert.ok(a < b && b < c, "expected cost must be monotone in wall size");
    for (const [x, y] of [[0, 5], [5, 9], [9, 40]] as const) {
      assert.ok(
        firstEnableEnvelope(withTokens(x)).allowedMaxBounded <=
          firstEnableEnvelope(withTokens(y)).allowedMaxBounded,
        `allowance must never shrink as the wall grows (${x} -> ${y})`,
      );
    }
  });

  it("the allowance is always the MIN of tolerated cost and the hard maximum", () => {
    for (const n of [0, 1, 5, 9, 15, 40]) {
      const e = firstEnableEnvelope(withTokens(n));
      const tolerated = (e.expectedBounded * 12_000n) / 10_000n;
      const expected =
        tolerated < FIRST_ENABLE_HARD_MAX_BOUNDED ? tolerated : FIRST_ENABLE_HARD_MAX_BOUNDED;
      assert.equal(e.allowedMaxBounded, expected, `n=${n}`);
      assert.ok(
        e.allowedMaxBounded <= FIRST_ENABLE_HARD_MAX_BOUNDED,
        `n=${n}: nothing may exceed the product maximum`,
      );
    }
  });

  it("a renewal is cheaper than a deploy, because it pays no CREATE2", () => {
    const s = withTokens(5);
    assert.ok(
      firstEnableEnvelope(s, { deploying: false }).expectedRaw <
        firstEnableEnvelope(s, { deploying: true }).expectedRaw,
    );
  });
});

describe("the hard maximum binds, and is derived from a measured failure point", () => {
  it("is 14,000,000 — half the measured AA23 cliff", () => {
    // The recorded cliff: ~40 custom tokens, stub 31,412 bytes, which this model
    // puts at 27,834,594 bounded. A 2x margin to a point where validation
    // PROVABLY fails, rather than a number chosen to fit existing walls.
    assert.equal(FIRST_ENABLE_HARD_MAX_BOUNDED, 14_000_000n);
    const cliff = firstEnableEnvelope(withTokens(40));
    assert.ok(
      cliff.expectedBounded > FIRST_ENABLE_HARD_MAX_BOUNDED * 2n - 2_000_000n,
      "the cap should sit near half the cliff",
    );
  });

  /** Every caller now states the account's real deployment state. */
  const signableNow = (shape: Parameters<typeof wallSignable>[0], deploying = true) =>
    wallSignable(shape, { deploying });

  it("a wall at the cliff cannot be signed", () => {
    const v = signableNow(withTokens(40));
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.why, /too large to sign safely/);
  });

  it("AND THE REFUSAL NAMES THE OWNER'S OWN NUMBER, not a general principle", () => {
    // "Remove some custom tokens, or turn off a venue you are not using" was
    // true and useless: it named no figure, and on 4663 the largest removable
    // item — the class vault — CANNOT be turned off, so the one lever it
    // pointed at was the one lever the owner did not have.
    const v = wallSignable(withTokens(40), {
      deploying: true,
      basket: { count: 40, shapeWith: (n) => withTokens(n) },
    });
    assert.equal(v.ok, false);
    if (v.ok) return;
    assert.ok(typeof v.maxTokens === "number" && v.maxTokens > 0, "a real maximum, from the builder");
    assert.equal(v.removeAtLeast, 40 - (v.maxTokens as number));
    assert.match(v.why, /You have 40 custom tokens/);
    assert.match(v.why, new RegExp(`the most that fits with the features you have enabled is ${v.maxTokens}`));
    assert.match(v.why, new RegExp(`Remove at least ${v.removeAtLeast} custom tokens`));
    // AND IT NO LONGER SENDS THEM AT A LEVER THEY DO NOT HAVE.
    assert.doesNotMatch(v.why, /venue/);
  });

  it("the maximum it reports actually fits, and one more does not", () => {
    // The number is only worth printing if it is the true boundary. Checked
    // against the same builder rather than against the sentence.
    const v = wallSignable(withTokens(40), {
      deploying: true,
      basket: { count: 40, shapeWith: (n) => withTokens(n) },
    });
    assert.equal(v.ok, false);
    if (v.ok || v.maxTokens === null) return;
    assert.equal(signableNow(withTokens(v.maxTokens)).ok, true, "the reported maximum must fit");
    assert.equal(signableNow(withTokens(v.maxTokens + 1)).ok, false, "and it must be the LAST that fits");
  });

  it("an ordinary wall is signable", () => {
    for (const n of [0, 1, 5]) assert.equal(signableNow(withTokens(n)).ok, true, `n=${n}`);
  });

  describe("a re-sign is not charged for a deployment it will never pay", () => {
    it("UNDEPLOYED: the allowance is included", () => {
      const s = withTokens(5);
      assert.equal(
        firstEnableEnvelope(s, { deploying: true }).expectedRaw -
          firstEnableEnvelope(s, { deploying: false }).expectedRaw,
        BigInt(FIRST_ENABLE_GAS_MODEL.deployAllowanceRaw),
        "a first install pays CREATE2 and initCode",
      );
    });

    it("DEPLOYED: the allowance is excluded, and it is worth 316,250 bounded", () => {
      // The measured size of the bug: an owner sitting anywhere in this band
      // was refused a wall that fits. A beta user was told to delete a fifth
      // token when four was the true answer.
      const s = withTokens(6);
      const a = firstEnableEnvelope(s, { deploying: true }).expectedBounded;
      const b = firstEnableEnvelope(s, { deploying: false }).expectedBounded;
      assert.equal(a - b, 316_250n);
    });

    it("and it changes the ANSWER, not just the arithmetic", () => {
      // The whole point. There must exist a wall that is refused as a first
      // install and signable as a re-sign, or the flag would be cosmetic.
      // ROB'S ACTUAL SHAPE: class vault sealed, which is every grant on 4663
      // because `sealedClassFactory` falls back to the chain's own factory.
      const asRob = (n: number) =>
        withTokens(n, {
          ponsClassVaultAddress: "0x3fcdde6e011769ca05f0115f1543290862473216",
          ponsClassVaultFactoryAddress: "0x48a5603712d3d4f4e6e4e1cbd4f4f5d1c9e6ab3d",
        });
      const straddling = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 30, 40].filter(
        (n) => !signableNow(asRob(n), true).ok && signableNow(asRob(n), false).ok,
      );
      assert.ok(straddling.length > 0, "no token count straddles the ceiling — the flag would be inert");
      // And it is the count the beta owner was sitting on.
      assert.ok(straddling.includes(6), `expected 6 tokens to straddle, got ${straddling.join(",")}`);
    });
  });

  it("THE SIGNING CAP AND THE EXECUTOR CAP ARE THE SAME FUNCTION", () => {
    // The defect this whole change exists to close: the product minted grants
    // whose first operation the executor was already designed to refuse. If
    // these two could disagree, that comes straight back. Checked in BOTH
    // deployment states, because the flag now moves the boundary.
    for (const deploying of [true, false]) {
      for (const n of [0, 5, 9, 20, 40]) {
        const s = withTokens(n);
        assert.equal(
          signableNow(s, deploying).ok,
          firstEnableEnvelope(s, { deploying }).withinHardMax,
          `n=${n} deploying=${deploying}: signing and execution disagree`,
        );
      }
    }
  });
});
