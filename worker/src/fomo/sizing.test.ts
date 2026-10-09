import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUTONOMOUS_ENTRY_CAP_6,
  CEILING_PARTS,
  ExplorationReservations,
  entryCeiling,
  formatUsdg6,
  microUsdgFloor,
  probeSize,
  type EntryCeilingInput,
  type ReservationSnapshot,
} from "./sizing";

/** Whole-cent test amounts only, so this helper never rounds. */
const U = (n: number) => BigInt(Math.round(n * 100)) * 10_000n;

const base = (over: Partial<EntryCeilingInput> = {}): EntryCeilingInput => ({
  perTradeLimit6: U(25),
  dailyHeadroom6: U(100),
  scout: { enabled: true, budget6: U(20), perToken6: U(10) },
  explorationHeldCost6: 0n,
  explorationPending6: 0n,
  realizedExplorationLoss6: 0n,
  tokenHeldCost6: 0n,
  tokenPending6: 0n,
  equity6: U(1000),
  maxExplorationShareBps: 1_000,
  routeCapacity6: U(50),
  minEconomic6: U(1),
  ...over,
});

describe("entryCeiling", () => {
  it("is the minimum of every bound, and names the one that bound", () => {
    const c = entryCeiling(base());
    assert.equal(c.ceiling6, U(10));
    assert.equal(c.binding, "per-token-remaining");
    assert.equal(c.economic, "ok");
    assert.equal(c.parts["exploration-remaining"], U(20));
    assert.equal(c.parts["exposure-headroom"], U(100));
    assert.ok(!("autonomous-cap" in c.parts), "absent autonomous cap is not a part");

    const auto = entryCeiling(base({ autonomousCap6: AUTONOMOUS_ENTRY_CAP_6 }));
    assert.equal(auto.ceiling6, 5_000_000n);
    assert.equal(auto.binding, "autonomous-cap");
  });

  it("every part can bind", () => {
    const cases: [Partial<EntryCeilingInput>, string][] = [
      [{ perTradeLimit6: U(2) }, "per-trade"],
      [{ dailyHeadroom6: U(2) }, "daily-headroom"],
      [{ explorationHeldCost6: U(18) }, "exploration-remaining"],
      [{ tokenHeldCost6: U(9) }, "per-token-remaining"],
      [{ equity6: U(20) }, "exposure-headroom"],
      [{ routeCapacity6: U(2) }, "route-capacity"],
      [{ autonomousCap6: U(2) }, "autonomous-cap"],
    ];
    for (const [over, binding] of cases) assert.equal(entryCeiling(base(over)).binding, binding, binding);
  });

  it("unknown is not permission: any null required input binds at 0", () => {
    const nulls: [Partial<EntryCeilingInput>, string][] = [
      [{ perTradeLimit6: null }, "unknown:per-trade"],
      [{ dailyHeadroom6: null }, "unknown:daily-headroom"],
      [{ scout: { enabled: true, budget6: null, perToken6: U(10) } }, "unknown:exploration-remaining"],
      [{ scout: { enabled: true, budget6: U(20), perToken6: null } }, "unknown:per-token-remaining"],
      [{ explorationHeldCost6: null }, "unknown:exploration-remaining"],
      [{ realizedExplorationLoss6: null }, "unknown:exploration-remaining"],
      [{ tokenHeldCost6: null }, "unknown:per-token-remaining"],
      [{ equity6: null }, "unknown:exposure-headroom"],
      [{ routeCapacity6: null }, "unknown:route-capacity"],
      [{ autonomousCap6: null }, "unknown:autonomous-cap"],
    ];
    for (const [over, binding] of nulls) {
      const c = entryCeiling(base(over));
      assert.equal(c.ceiling6, 0n, binding);
      assert.equal(c.binding, binding);
      assert.equal(c.economic, "below-floor");
    }
  });

  it("scout off means exploration is not authorised, whatever else is known", () => {
    const c = entryCeiling(base({ scout: { enabled: false, budget6: U(20), perToken6: U(10) } }));
    assert.equal(c.ceiling6, 0n);
    assert.equal(c.binding, "exploration-not-authorized");
  });

  it("negative amounts and a bad share are invalid, never permission", () => {
    assert.equal(entryCeiling(base({ explorationHeldCost6: -1n })).binding, "invalid:exploration-remaining");
    assert.equal(entryCeiling(base({ perTradeLimit6: -1n })).ceiling6, 0n);
    assert.equal(entryCeiling(base({ maxExplorationShareBps: 10_001 })).binding, "invalid:exposure-headroom");
    assert.equal(entryCeiling(base({ maxExplorationShareBps: 2.5 })).ceiling6, 0n);
    assert.equal(entryCeiling(base({ minEconomic6: -1n })).ceiling6, 0n);
  });

  it("below the economic floor is reported, not hidden", () => {
    const c = entryCeiling(base({ routeCapacity6: U(0.5) }));
    assert.equal(c.ceiling6, U(0.5));
    assert.equal(c.economic, "below-floor");
    assert.equal(c.floor6, U(1));
    assert.match(c.reason, /floor/);
  });

  it("rounds DOWN and never up past a limit", () => {
    // 333.333333 × 15% = 49.99999995 → 49.999999, never 50.
    const c = entryCeiling(base({ equity6: 333_333_333n, maxExplorationShareBps: 1_500, perTradeLimit6: U(60), scout: { enabled: true, budget6: U(60), perToken6: U(60) }, routeCapacity6: U(60) }));
    assert.equal(c.binding, "exposure-headroom");
    assert.equal(c.ceiling6, 49_999_999n);
    assert.equal(probeSize(7n, 5_000, 100n), 3n);
    assert.equal(probeSize(1n, 9_999, 100n), 0n);
    assert.equal(microUsdgFloor(1.005), 1_004_999n, "a float just under 1.005 floors; it is never rounded up");
    assert.equal(microUsdgFloor(25), 25_000_000n);
    assert.equal(microUsdgFloor(Number.NaN), null);
    assert.equal(microUsdgFloor(-1), null);
    assert.equal(formatUsdg6(1_250_000n), "1.250000");
    assert.equal(formatUsdg6(5n), "0.000005");
  });

  it("remaining figures are floored at zero when over-committed", () => {
    const c = entryCeiling(base({ explorationHeldCost6: U(30) }));
    assert.equal(c.parts["exploration-remaining"], 0n);
    assert.equal(c.ceiling6, 0n);
    assert.equal(c.economic, "below-floor");
  });
});

describe("exploration consumption", () => {
  it("a realised loss does not refill the allowance when the losing position closes", () => {
    // Open: 8 USDG in exploration. Budget 20, so 12 remain.
    const open = entryCeiling(base({ explorationHeldCost6: U(8), perTradeLimit6: U(100), scout: { enabled: true, budget6: U(20), perToken6: U(100) } }));
    assert.equal(open.parts["exploration-remaining"], U(12));
    // Closed for 5: held 0, realised loss 3. The 5 recovered returns; the 3 lost does not.
    const closed = entryCeiling(base({ explorationHeldCost6: 0n, realizedExplorationLoss6: U(3), perTradeLimit6: U(100), scout: { enabled: true, budget6: U(20), perToken6: U(100) } }));
    assert.equal(closed.parts["exploration-remaining"], U(17));
    assert.ok(closed.parts["exploration-remaining"]! < U(20), "the loss stays consumed");
  });

  it("a profitable close never lifts the allowance above the authorised budget", () => {
    const c = entryCeiling(base({ realizedExplorationLoss6: -U(50), scout: { enabled: true, budget6: U(20), perToken6: U(100) } }));
    assert.equal(c.parts["exploration-remaining"], U(20));
  });

  it("no martingale: a bigger loss never gives a bigger next ceiling", () => {
    const at = (loss: bigint) =>
      entryCeiling(
        base({
          perTradeLimit6: U(100),
          dailyHeadroom6: U(100),
          scout: { enabled: true, budget6: U(20), perToken6: U(100) },
          realizedExplorationLoss6: loss,
          // The same loss comes out of equity too.
          equity6: U(200) - loss,
          maxExplorationShareBps: 1_000,
          routeCapacity6: U(100),
        }),
      ).ceiling6;
    const before = at(0n);
    let prev = before;
    for (let cents = 1; cents <= 3_000; cents += 37) {
      const next = at(BigInt(cents) * 10_000n);
      assert.ok(next <= prev, `loss ${cents}c raised the ceiling ${prev} → ${next}`);
      assert.ok(next <= before);
      prev = next;
    }
  });

  it("no averaging down: what a token already holds counts against its own cap", () => {
    const fresh = entryCeiling(base());
    const heldUnderwater = entryCeiling(base({ tokenHeldCost6: U(6) }));
    assert.equal(heldUnderwater.ceiling6, U(4));
    assert.ok(heldUnderwater.ceiling6 < fresh.ceiling6);
    assert.equal(entryCeiling(base({ tokenHeldCost6: U(10) })).ceiling6, 0n);
  });

  it("probe size is bounded by the ceiling and its own cap", () => {
    assert.equal(probeSize(U(10), 5_000, U(2.5)), U(2.5));
    assert.equal(probeSize(U(4), 5_000, U(2.5)), U(2));
    assert.equal(probeSize(U(1), 10_000, U(2.5)), U(1));
    assert.equal(probeSize(0n, 5_000, U(2.5)), 0n);
    assert.equal(probeSize(U(10), 0, U(2.5)), 0n);
    assert.equal(probeSize(U(10), 5_000, 0n), 0n);
    for (let c = 0n; c < 200n; c += 7n) assert.ok(probeSize(c, 7_777, 50n) <= c);
  });

  it("the ceiling parts are the documented set", () => {
    assert.deepEqual([...CEILING_PARTS], [
      "per-trade",
      "daily-headroom",
      "exploration-remaining",
      "per-token-remaining",
      "exposure-headroom",
      "route-capacity",
      "autonomous-cap",
    ]);
  });
});

describe("ExplorationReservations", () => {
  const clock = (start = 1_000_000) => {
    let t = start;
    return { now: () => t, set: (v: number) => (t = v), tick: (d: number) => (t += d) };
  };
  const snap = (asOf: number, over: Partial<ReservationSnapshot> = {}): ReservationSnapshot => ({
    asOf,
    enabled: true,
    budget6: U(10),
    perToken6: U(6),
    explorationHeldCost6: 0n,
    realizedExplorationLoss6: 0n,
    tokenHeldCost6: 0n,
    ...over,
  });
  const yieldTimes = async (n: number) => {
    for (let k = 0; k < n; k++) await new Promise<void>((r) => setImmediate(r));
  };

  it("interleaved async signals cannot overspend shared headroom", async () => {
    const c = clock();
    const book = new ExplorationReservations({ now: c.now });
    const s = snap(c.now()); // every task holds the SAME snapshot, read before any reserved
    const tokens = ["t:a", "t:b", "t:c", "t:d", "t:e", "t:f", "t:g", "t:h"];
    const results = await Promise.all(
      tokens.map(async (tok, k) => {
        await yieldTimes((k * 3) % 5); // scramble the order the checks run in
        return book.reserve(`r${k}`, tok, U(3), s);
      }),
    );
    assert.equal(results.filter(Boolean).length, 3, "3 × 3 fits a 10 budget; a fourth would not");
    assert.ok(book.outstanding().total6 <= U(10));
  });

  it("per-token headroom holds across concurrent signals for one coin", async () => {
    const c = clock();
    const book = new ExplorationReservations({ now: c.now });
    const s = snap(c.now(), { budget6: U(100) });
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map(async (k) => {
        await yieldTimes(5 - k);
        return book.reserve(`r${k}`, "t:same", U(2), s);
      }),
    );
    assert.equal(results.filter(Boolean).length, 3);
    assert.equal(book.outstanding().byToken["t:same"], U(6));
  });

  it("release gives headroom back; a committed fill keeps counting until a snapshot includes it", () => {
    const c = clock();
    const book = new ExplorationReservations({ now: c.now });
    const s0 = snap(c.now());
    assert.equal(book.reserve("a", "t:a", U(5), s0), true);
    assert.equal(book.reserve("b", "t:b", U(5), s0), true);
    assert.equal(book.reserve("c", "t:c", U(1), s0), false);
    assert.equal(book.release("b"), true);
    assert.equal(book.release("b"), false, "a release is not repeatable");
    c.tick(1_000);
    assert.equal(book.commit("a"), true);
    const committedAt = c.now();
    assert.equal(book.release("a"), false, "money that left cannot be released");
    c.tick(1_000);
    // A snapshot read BEFORE the fill does not include it: the fill still counts.
    assert.equal(book.reserve("d", "t:d", U(6), snap(committedAt - 500)), false);
    // A snapshot read after it shows the cost as held; the reservation stops double counting.
    assert.equal(book.reserve("d", "t:d", U(5), snap(committedAt, { explorationHeldCost6: U(5) })), true);
    // And an older snapshot presented later still sees the fill.
    assert.equal(book.reserve("e", "t:e", U(1), snap(committedAt - 500)), false);
  });

  it("a realised loss in the snapshot is not refilled by releasing", () => {
    const c = clock();
    const book = new ExplorationReservations({ now: c.now });
    const s = snap(c.now(), { realizedExplorationLoss6: U(7) });
    assert.equal(book.reserve("a", "t:a", U(4), s), false);
    assert.equal(book.reserve("a", "t:a", U(3), s), true);
    assert.equal(book.release("a"), true);
    assert.equal(book.reserve("b", "t:b", U(4), s), false);
  });

  it("refuses unknowns, stale snapshots, reuse of an id and non-positive amounts", () => {
    const c = clock();
    const book = new ExplorationReservations({ now: c.now, maxSnapshotAgeMs: 60_000 });
    assert.equal(book.reserve("a", "t:a", U(1), snap(c.now(), { budget6: null })), false);
    assert.equal(book.reserve("a", "t:a", U(1), snap(c.now(), { tokenHeldCost6: null })), false);
    assert.equal(book.reserve("a", "t:a", U(1), snap(c.now(), { enabled: false })), false);
    assert.equal(book.reserve("a", "t:a", U(1), snap(c.now() - 61_000)), false);
    assert.equal(book.reserve("a", "t:a", 0n, snap(c.now())), false);
    assert.equal(book.reserve("a", "t:a", U(1), snap(c.now())), true);
    assert.equal(book.reserve("a", "t:b", U(1), snap(c.now())), false);
  });

  it("pendingAgainst feeds entryCeiling so a second signal sees the first", () => {
    const c = clock();
    const book = new ExplorationReservations({ now: c.now });
    assert.equal(book.reserve("a", "t:a", U(4), snap(c.now())), true);
    const p = book.pendingAgainst(c.now(), "t:a");
    assert.equal(p.exploration6, U(4));
    assert.equal(p.token6, U(4));
    const ceiling = entryCeiling(base({ explorationPending6: p.exploration6, tokenPending6: p.token6 }));
    assert.equal(ceiling.ceiling6, U(6), "per-token 10 − 4 pending");
  });

  it("a restart forgets every reservation (in memory by design)", () => {
    const c = clock();
    const a = new ExplorationReservations({ now: c.now });
    assert.equal(a.reserve("a", "t:a", U(4), snap(c.now())), true);
    const b = new ExplorationReservations({ now: c.now });
    assert.equal(b.outstanding().count, 0);
  });
});
