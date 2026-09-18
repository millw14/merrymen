import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FIRST_ENABLE_HARD_MAX_BOUNDED,
  firstEnableEnvelope,
  wallShape,
  wallSignable,
  FIRST_ENABLE_GAS_MODEL,
} from "./first-enable-gas";
import { buildCallPermissions } from "./wall";
import type { GrantCaps } from "./grant";

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
   *
   * Re-measured with the native-input rule present (default wall): +1,248
   * bytes fixed for the rule itself, +32 per custom token for its ONE_OF
   * adapterAssets entry — verified linear across 0/1/5/15/40 tokens.
   */
  const RECORDED: Record<number, number> = {
    0: 12_180,
    1: 12_724,
    5: 14_900,
    15: 20_340,
    40: 33_940,
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
    assert.equal(s.permissions, 19, "the documented default wall plus the native-input rule");
    assert.ok(s.rules > 0 && s.oneOfEntries > 0);
    assert.equal(
      s.policyBlobBytes,
      64 + 224 * s.permissions + 160 * s.rules + 32 * s.params,
      "the blob is a function of what was counted",
    );
  });

  it("a custom token costs 544 bytes on a default wall", () => {
    // 512 bytes of base wall per token (the figure gas-limits.ts quotes,
    // arrived at independently here) + 32 for the native rule's ONE_OF
    // adapterAssets entry, which grows with the same list.
    assert.equal(withTokens(1).stubBytes - withTokens(0).stubBytes, 544);
    assert.equal(withTokens(6).stubBytes - withTokens(5).stubBytes, 544);
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
    // should cost ~10.9M may not be signed for 13.5M just because something
    // said so — its own envelope binds first, well below the hard maximum.
    // (Threshold moved with the native rule: narrow allowance is now ~13.08M.)
    const narrow = firstEnableEnvelope(withTokens(0));
    const anomalous = 13_500_000n;
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
      // The native rule widened every wall, so the straddle point moved from
      // the 6 the beta owner was sitting on to 4. Same property, new calibration.
      assert.ok(straddling.includes(4), `expected 4 tokens to straddle, got ${straddling.join(",")}`);
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
