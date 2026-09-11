import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FIRST_ENABLE_HARD_MAX_BOUNDED,
  firstEnableEnvelope,
  wallShape,
  wallSignable,
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

  it("a wall at the cliff cannot be signed", () => {
    const v = wallSignable(withTokens(40));
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.match(v.why, /too wide/);
      assert.match(v.why, /Remove some custom tokens|turn off a venue/);
    }
  });

  it("and the refusal tells the owner which way to narrow it", () => {
    // "Too wide" with no remedy is a dead end. The sentence has to name both
    // levers, because the cost grows with tokens AND capabilities together.
    const v = wallSignable(withTokens(40));
    assert.equal(v.ok, false);
    if (!v.ok) assert.ok(v.why.includes("custom tokens") && v.why.includes("venue"));
  });

  it("an ordinary wall is signable", () => {
    for (const n of [0, 1, 5]) assert.equal(wallSignable(withTokens(n)).ok, true, `n=${n}`);
  });

  it("THE SIGNING CAP AND THE EXECUTOR CAP ARE THE SAME FUNCTION", () => {
    // The defect this whole change exists to close: the product minted grants
    // whose first operation the executor was already designed to refuse. If
    // these two could disagree, that comes straight back.
    for (const n of [0, 5, 9, 20, 40]) {
      const s = withTokens(n);
      const signable = wallSignable(s).ok;
      const deployable = firstEnableEnvelope(s).withinHardMax;
      assert.equal(signable, deployable, `n=${n}: signing and execution disagree`);
    }
  });
});
