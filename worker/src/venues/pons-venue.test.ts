/**
 * PONS AS A VENUE — the properties that decide whether an autonomous position
 * can be got out of.
 *
 * Everything here is about the difference between a measured zero and an
 * unreadable one. On this route that difference is the whole safety margin: a
 * balance that would not read must not report as sold, and a curve that would
 * not answer must not report as sellable.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { graduationBpsOf, makePonsVenue, type PonsDiscoveryRow } from "./pons-venue";
import type { CurveReserves } from "./pons-price";

const TOKEN = "0x1111111111111111111111111111111111111111" as const;
const CURVE = "0x2222222222222222222222222222222222222222" as const;
const VAULT = "0x3333333333333333333333333333333333333333" as const;
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as const;

/** 40% of the threshold is a virtual seed; real depth is what is left. */
const THRESHOLD = 1_000_000_000n; // 1,000 USDG
const reserves = (realQuote: bigint): CurveReserves =>
  ({
    quoteRaw: realQuote + (THRESHOLD * 40n) / 100n,
    tokenRaw: 1_000_000_000_000_000_000_000n,
    graduationThresholdRaw: THRESHOLD,
    quoteDecimals: 6,
    tokenDecimals: 18,
  }) as unknown as CurveReserves;

const row = (over: Partial<PonsDiscoveryRow> = {}): PonsDiscoveryRow => ({
  address: TOKEN,
  symbol: "BONKER",
  decimals: 18,
  firstSeen: 1_000,
  curve: { curve: CURVE, quoteToken: USDG, graduationThresholdRaw: THRESHOLD.toString() },
  ...over,
});

describe("graduation progress is read from REAL depth", () => {
  it("is null when there is no threshold — depth that cannot be read as money is not progress", () => {
    assert.equal(graduationBpsOf(reserves(500_000_000n), 0n), null);
  });

  it("and is bounded to the 0..10000 range", () => {
    const bps = graduationBpsOf(reserves(500_000_000n), THRESHOLD);
    assert.ok(bps !== null && bps >= 0 && bps <= 10_000, `got ${bps}`);
  });
});

describe("discovery admits only rows the launch scan vouched for", () => {
  it("DROPS A ROW WITH NO CURVE — the provenance guarantee rests on one producer", () => {
    const venue = makePonsVenue({
      client: {} as never,
      discoverRows: async () => [row(), row({ address: "0x9999999999999999999999999999999999999999", curve: undefined })],
    });
    return venue.discover({ limit: 10 }).then((out) => {
      assert.equal(out.length, 1, "a row without a curve is not a Pons candidate at all");
      assert.equal(out[0]!.route, CURVE);
      assert.equal(out[0]!.venue, "pons");
    });
  });

  it("and reports an absent first-seen as null rather than zero", () => {
    const venue = makePonsVenue({ client: {} as never, discoverRows: async () => [row({ firstSeen: 0 })] });
    return venue.discover({ limit: 10 }).then((out) => {
      assert.equal(out[0]!.firstSeen, null, "0 would read as 1970 and make the token infinitely old");
    });
  });
});

describe("position state, where unknown must never read as safe", () => {
  const venueWith = (readContract: (a: { functionName: string }) => Promise<unknown>) =>
    makePonsVenue({
      client: { readContract } as never,
      discoverRows: async () => [],
    });

  it("RETURNS NULL WHEN THE BALANCE WILL NOT READ — a held position must not report as closed", () => {
    const venue = venueWith(async () => {
      throw new Error("rpc down");
    });
    return venue.positionState({ custody: VAULT, token: TOKEN, route: CURVE }).then((s) => {
      assert.equal(s, null, "zero here would tell the exit producer to stop trying");
    });
  });

  it("marks a position UNSELLABLE when the curve would not answer", () => {
    const venue = venueWith(async (a) => {
      if (a.functionName === "balanceOf") return 1_000n;
      throw new Error("curve unreadable");
    });
    return venue.positionState({ custody: VAULT, token: TOKEN, route: CURVE }).then((s) => {
      assert.equal(s!.sellable, false, "an exit planned against an unreadable curve reverts after paying gas");
      assert.match(s!.unsellableReason!, /would not answer/);
    });
  });

  it("and marks a GRADUATED position unsellable, naming the owner's remaining route", () => {
    const venue = venueWith(async (a) => (a.functionName === "balanceOf" ? 1_000n : true));
    return venue.positionState({ custody: VAULT, token: TOKEN, route: CURVE }).then((s) => {
      assert.equal(s!.sellable, false);
      assert.equal(s!.graduationBps, 10_000);
      assert.match(s!.unsellableReason!, /your own key can still move it out/);
    });
  });

  it("reports sellable only when the curve says, in so many words, that it is not graduated", () => {
    const venue = venueWith(async (a) => (a.functionName === "balanceOf" ? 1_000n : false));
    return venue.positionState({ custody: VAULT, token: TOKEN, route: CURVE }).then((s) => {
      assert.equal(s!.sellable, true);
      assert.equal(s!.unsellableReason, null);
    });
  });
});
