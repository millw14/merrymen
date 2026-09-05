import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findRoundAt, MAX_ROUND_LAG_SEC, priceGasAtRound, type FeedRound } from "./gas-backfill";

/**
 * GROSS AND NET ARE NOT THE SAME NUMBER, and on this book they are barely the
 * same order of magnitude.
 *
 * The canary burned 0.002595505 ETH across four fills on a book that only ever
 * deployed 6.666 USDG. Gross of gas it is down 0.127 USDG; net of gas it is down
 * 6.649. The whole reason this module exists is that a NULL `gas_usdg` silently
 * publishes the first figure while an owner reads it as the second.
 */

const round = (roundId: bigint, priceUsd: number, updatedAt: number): FeedRound => ({
  roundId,
  priceUsd,
  updatedAt,
});

// The real trade, from the receipt: the first-enable op, which burned 73% of all
// the gas the canary has ever spent.
const FIRST_FILL = { gasWei: 1_898_579_000_000_000n, tradeAtSec: 1_788_473_326 };

describe("G1 — pricing gas against the round in force", () => {
  it("prices the canary's first fill from a round published before it", () => {
    const r = priceGasAtRound({
      ...FIRST_FILL,
      round: round(1n, 2512.65, FIRST_FILL.tradeAtSec - 29 * 60),
    });
    assert.equal(r.kind, "priced");
    if (r.kind !== "priced") return;
    // 0.001898579 ETH × $2512.65
    assert.ok(Math.abs(r.usdg - 4.77046) < 0.0001, `got ${r.usdg}`);
    assert.equal(r.lagSec, 29 * 60);
  });

  it("REPORTS THE LAG rather than hiding it", () => {
    // A Chainlink round updates on a deviation threshold or a heartbeat, so "the
    // price in force" is the last PUBLISHED round, not the price at the instant
    // of the trade. Saying so is what keeps this an honest reconstruction of what
    // the row should have held rather than a claim to better data than the live
    // path had.
    const r = priceGasAtRound({ ...FIRST_FILL, round: round(1n, 2512.65, FIRST_FILL.tradeAtSec - 41 * 60) });
    assert.equal(r.kind === "priced" && r.lagSec, 41 * 60);
  });

  it("REFUSES a round published AFTER the trade", () => {
    // That is not the price that was in force, and accepting it would let a
    // search bug become a wrong number instead of a caught one.
    const r = priceGasAtRound({ ...FIRST_FILL, round: round(1n, 2512.65, FIRST_FILL.tradeAtSec + 1) });
    assert.equal(r.kind, "no-round");
  });

  it("REFUSES a feed that had stopped tracking the market", () => {
    const r = priceGasAtRound({
      ...FIRST_FILL,
      round: round(1n, 2512.65, FIRST_FILL.tradeAtSec - MAX_ROUND_LAG_SEC - 1),
    });
    assert.equal(r.kind, "too-stale");
    // The row stays as it was. A backfill that cannot do better must not pretend.
    assert.match(r.kind === "too-stale" ? r.why : "", /stays unpriced rather than priced badly/);
  });

  it("an unset round is not a zero price", () => {
    assert.equal(priceGasAtRound({ ...FIRST_FILL, round: round(1n, 2512.65, 0) }).kind, "no-round");
    assert.equal(priceGasAtRound({ ...FIRST_FILL, round: null }).kind, "no-round");
    assert.equal(
      priceGasAtRound({ ...FIRST_FILL, round: round(1n, 0, FIRST_FILL.tradeAtSec - 60) }).kind,
      "no-round",
    );
  });

  it("THE CANARY'S FOUR FILLS, priced as they were measured on chain", () => {
    // All four fell inside one round — the feed had not moved between 22:08 and
    // 22:21 — which is why they share a price.
    const fills = [1_898_579_000_000_000n, 154_023_000_000_000n, 274_022_000_000_000n, 268_881_000_000_000n];
    const total = fills.reduce((sum, gasWei) => {
      const r = priceGasAtRound({
        gasWei,
        tradeAtSec: FIRST_FILL.tradeAtSec,
        round: round(1n, 2512.65, FIRST_FILL.tradeAtSec - 29 * 60),
      });
      return sum + (r.kind === "priced" ? r.usdg : 0);
    }, 0);
    assert.ok(Math.abs(total - 6.52159) < 0.0005, `total gas ${total}`);

    // And what that does to the published figure. NAV 9.873005 against 10.00
    // contributed: −0.127 gross, −6.649 net. Same book, same four trades.
    const nav = 9.873005;
    assert.ok(Math.abs(nav - 10 - 0 - -0.126995) < 0.0001, "gross");
    assert.ok(Math.abs(nav - 10 - total - -6.648585) < 0.0005, "net");
  });
});

describe("G2 — finding the round in force", () => {
  /** A feed with rounds every 10 minutes, and some ids never published. */
  const feed = (n: number, start: number, gapSec = 600) => {
    const rounds = new Map<string, FeedRound>();
    for (let i = 0; i < n; i++) {
      // Leave every seventh id unset, the way a phase boundary leaves gaps.
      if (i % 7 === 6) continue;
      rounds.set(String(i), round(BigInt(i), 2000 + i, start + i * gapSec));
    }
    let reads = 0;
    return {
      reads: () => reads,
      read: async (id: bigint) => {
        reads++;
        return rounds.get(String(id)) ?? round(id, 0, 0);
      },
      latest: round(BigInt(n - 1), 2000 + n - 1, start + (n - 1) * gapSec),
    };
  };

  it("finds the newest round at or before the moment", async () => {
    const f = feed(500, 1_000_000);
    // Ask for a time that lands between round 100 and 101.
    const want = 1_000_000 + 100 * 600 + 5;
    const r = await findRoundAt(want, f.latest, f.read);
    assert.equal(r?.roundId, 100n);
    assert.ok(r!.updatedAt <= want, "never a round published after the moment");
  });

  it("STEPS OVER UNSET ROUNDS instead of stopping at them", async () => {
    // Round ids on a proxy are (phase << 64) | round, so they are monotonic
    // within a phase but not dense across one. Treating an unset round as an
    // endpoint would end the walk at the first gap.
    const f = feed(500, 1_000_000);
    const want = 1_000_000 + 6 * 600 + 5; // round 6 is deliberately unset
    const r = await findRoundAt(want, f.latest, f.read);
    assert.equal(r?.roundId, 5n, "falls back to the newest PUBLISHED round before it");
  });

  it("returns the latest round directly when the moment is now", async () => {
    const f = feed(50, 1_000_000);
    const r = await findRoundAt(f.latest.updatedAt + 1, f.latest, f.read);
    assert.equal(r?.roundId, f.latest.roundId);
    assert.equal(f.reads(), 0, "and costs no RPC calls at all");
  });

  it("is logarithmic, not linear — this runs against a live RPC", async () => {
    const f = feed(4000, 1_000_000);
    await findRoundAt(1_000_000 + 3000 * 600 + 1, f.latest, f.read);
    assert.ok(f.reads() < 40, `expected a binary search, took ${f.reads()} reads`);
  });

  it("SEARCHES THE AGGREGATOR ROUND, NOT THE RAW PROXY ID", async () => {
    // A Chainlink proxy id is (phase << 64) | aggregatorRound. The live feed's
    // latest is 18446744073709553622, which is phase 1 round 2006 — enormous and
    // sparse on the outside, small and dense on the inside.
    //
    // Bisecting the raw id searches a mostly-empty 2^64 space and leaves the
    // hole-stepping to do the work: measured against the live chain, 822 RPC
    // calls to price four trades. After decomposing, the same four take fifty.
    const PHASE = 1n;
    const proxy = (agg: bigint) => (PHASE << 64n) | agg;
    const start = 1_000_000;
    const rounds = new Map<string, FeedRound>();
    for (let i = 1n; i <= 2006n; i++) {
      rounds.set(String(proxy(i)), round(proxy(i), 2000 + Number(i), start + Number(i) * 600));
    }
    let reads = 0;
    const read = async (rid: bigint) => {
      reads++;
      return rounds.get(String(rid)) ?? round(rid, 0, 0);
    };
    const latest = rounds.get(String(proxy(2006n)))!;

    const want = start + 1000 * 600 + 5;
    const r = await findRoundAt(want, latest, read);
    assert.equal(r?.roundId, proxy(1000n), "must find the round inside the phase");
    assert.ok(r!.updatedAt <= want);
    assert.ok(
      reads < 40,
      `expected a search over ~2006 dense rounds, took ${reads} reads — it is bisecting the proxy id`,
    );
  });

  it("returns null rather than guessing when nothing precedes the moment", async () => {
    const f = feed(50, 2_000_000);
    assert.equal(await findRoundAt(1_000_000, f.latest, f.read), null);
  });

  it("a read that throws is treated as unset, not as a failure of the whole search", async () => {
    const f = feed(200, 1_000_000);
    const flaky = async (id: bigint) => {
      if (id % 3n === 0n) throw new Error("RPC 429");
      return f.read(id);
    };
    const want = 1_000_000 + 100 * 600 + 5;
    const r = await findRoundAt(want, f.latest, flaky);
    assert.ok(r !== null, "a flaky RPC must not silently produce 'no round'");
    assert.ok(r!.updatedAt <= want);
  });
});
