/**
 * A STRATEGY THAT PROPOSES WHAT ITS OWN KEY REFUSES IS NOT A QUIET AGENT.
 *
 * `snap.perTradeCapUsdg` is the ceiling sealed into the owner's signature and
 * the wall enforces it on every buy. steady-basket has honoured it since it was
 * added and trencher skips any candidate above it; even-keel and dip-hunter
 * consulted neither it nor `spendHeadroomUsdg`.
 *
 * The cost is not a rounding error. A default three-leg basket seeded at the
 * "bold" size is 16.67 USDG a leg against a default signed cap of 10, so every
 * intent was refused — on the first tick and on every tick after it, for the
 * life of the grant. Nothing in the product reads as "your own key refuses
 * this": the tape fills with rejected rows and the agent looks fussy rather
 * than mis-sized.
 *
 * AND THE SELL SIDE MUST NOT BE CLAMPED, which is the half that needs a test
 * more than the buy side does. policy.ts exempts an exit from the per-trade cap
 * outright, because the chain's own sell permission "carries no amount
 * condition" — so a strategy that capped its own exits would be stricter than
 * the wall, which that file calls a real bug in as many words, and would
 * rebuild the failure it records: an agent "structurally able to exit its
 * losers and structurally unable to exit its winners".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evenKeelTick } from "./even-keel";
import { makeDipHunter } from "./dip-hunter";
import type { Snapshot, Tick } from "./types";

const USDG = "0x0000000000000000000000000000000000000001" as const;
const ROUTER = "0x0000000000000000000000000000000000000002" as const;
const tok = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;

const snap = (over: Partial<Snapshot> = {}): Snapshot =>
  ({
    sequencerUp: true,
    pausedTokens: new Set<string>(),
    staleFeeds: new Set<string>(),
    holdings: new Map(),
    prices: new Map(),
    cashUsdg: 1_000_000_000n,
    vaultUsdg: 0n,
    spendHeadroomUsdg: 1_000_000_000n,
    perTradeCapUsdg: 10_000_000n, // 10 USDG, the default signed cap
    ...over,
  }) as unknown as Snapshot;

const legs = [1, 2, 3].map((i) => ({ symbol: `S${i}`, token: tok(i) }));

/** Strategy.tick may return bare intents; narrow to the Tick shape the tests read. */
const asTick = (t: unknown): Tick => (Array.isArray(t) ? { intents: t, why: [] } : (t as Tick));

describe("even-keel sizes to the signature", () => {
  const cfg = {
    legs,
    swapRouter: ROUTER,
    usdg: USDG,
    maxTradeUsdg: 1_000_000_000n,
    bandBps: 500,
    seedBudgetUsdg: 50_000_000n, // 50 USDG over 3 legs = 16.67 each
  };

  it("THE COLD-START SEED IS CLAMPED, so the wall does not refuse every tick", () => {
    const t = evenKeelTick(cfg, snap());
    assert.equal(t.intents.length, 3);
    for (const i of t.intents) {
      assert.ok(
        (i as { notionalUsdg: bigint }).notionalUsdg <= 10_000_000n,
        "a seed leg above the signed cap is refused by the owner's own key",
      );
    }
  });

  it("and the day's remaining budget binds too", () => {
    const t = evenKeelTick(cfg, snap({ spendHeadroomUsdg: 4_000_000n }));
    for (const i of t.intents) {
      assert.ok((i as { notionalUsdg: bigint }).notionalUsdg <= 4_000_000n);
    }
  });

  it("A TRIM IS NEVER CLAMPED, because the wall does not cap an exit", () => {
    // One leg far ahead of the other two. The trim is worth more than the
    // per-trade cap, and it must still be proposed at full size: policy.ts
    // exempts it, and a winner is exactly the position that outgrows the cap.
    const holdings = new Map([
      ["S1", { valueUsdg: 900_000_000n, rawBalance: 900n }],
      ["S2", { valueUsdg: 50_000_000n, rawBalance: 50n }],
      ["S3", { valueUsdg: 50_000_000n, rawBalance: 50n }],
    ]);
    const t = evenKeelTick(cfg, snap({ holdings: holdings as never, spendHeadroomUsdg: 0n }));
    const sell = t.intents.find((i) => (i as { sellToken: string }).sellToken === tok(1));
    assert.ok(sell, "the overweight leg must still be trimmed");
    assert.ok(
      (sell as { notionalUsdg: bigint }).notionalUsdg > 10_000_000n,
      "an exit clamped to the per-trade cap is stricter than the wall — the documented bug",
    );
  });

  it("A SPENT DAY PROPOSES NOTHING, not one zero-sized swap per leg", () => {
    /*
     * The guard tested the value BEFORE the clamp. `withinCap` also clamps to
     * `spendHeadroomUsdg`, so once the day's budget was spent the seed size
     * came out 0 while `budget` and `per` were still positive — and the
     * cold-start branch proposed a zero-sized swap for every tradable leg. The
     * wall refused each as non-positive and wrote a warn event and a rejected
     * trade row per leg PER TICK, with nothing de-duplicating any of it.
     *
     * Note this is the seed path — no holdings — which is what distinguishes it
     * from the trim test above, where the same zero headroom is correct to
     * ignore because an exit is exempt from the cap entirely.
     */
    const t = evenKeelTick(cfg, snap({ spendHeadroomUsdg: 0n }));
    assert.equal(t.intents.length, 0, "a zero-sized intent is not a proposal, it is a row about nothing");
    assert.equal(t.idle?.code, "under-one-buy", "and the owner is told which dial it was");
  });

  it("a buy the WALL shrank says so; one the owner's own settings shrank does not", () => {
    // The clause must name the signature only when the signature is the reason,
    // or it sends somebody to re-sign a grant that was never the constraint.
    const tight = evenKeelTick(cfg, snap({ perTradeCapUsdg: 1_000_000n }));
    const seed = tight.why.find((w) => w?.code === "keel-seed") as { capped?: boolean } | undefined;
    assert.ok(seed, "the seed still proposes");
    assert.equal(seed?.capped, true, "the per-trade cap was the binding constraint");

    const roomy = evenKeelTick(cfg, snap({ perTradeCapUsdg: 10n ** 12n, spendHeadroomUsdg: 10n ** 12n }));
    const free = roomy.why.find((w) => w?.code === "keel-seed") as { capped?: boolean } | undefined;
    assert.ok(free, "and so does an uncapped one");
    assert.notEqual(free?.capped, true, "nothing here was cut by the wall, so nothing may blame it");
  });

  it("THE TRIM'S REASON NEVER CARRIES `capped`, because a trim is never capped", () => {
    const holdings = new Map([
      ["S1", { valueUsdg: 900_000_000n, rawBalance: 900n }],
      ["S2", { valueUsdg: 50_000_000n, rawBalance: 50n }],
      ["S3", { valueUsdg: 50_000_000n, rawBalance: 50n }],
    ]);
    const t = evenKeelTick(cfg, snap({ holdings: holdings as never, spendHeadroomUsdg: 0n }));
    const trim = t.why.find((w) => w?.code === "keel-trim");
    assert.ok(trim, "the trim is proposed");
    assert.ok(!("capped" in (trim as object)), "the exit path must not even carry the field");
  });
});

describe("dip-hunter sizes to the signature", () => {
  const cfg = {
    legs,
    swapRouter: ROUTER,
    usdg: USDG,
    buyPerTickUsdg: 25_000_000n, // 25 USDG against a 10 USDG signed cap
    minDipBps: 100,
  };

  const priced = (dipped: boolean) =>
    new Map(
      legs.map((l, i) => [
        l.symbol,
        { price8: dipped && i === 0 ? 50_000_000n : 100_000_000n, stale: false },
      ]),
    );

  it("THE BUY IS CLAMPED TO THE SIGNED CAP", () => {
    const s = makeDipHunter(cfg as never);
    // First tick establishes the highs; the second sees the dip.
    s.tick(snap({ prices: priced(false) as never }));
    const t = asTick(s.tick(snap({ prices: priced(true) as never })));
    assert.equal(t.intents.length, 1);
    assert.ok((t.intents[0] as { notionalUsdg: bigint }).notionalUsdg <= 10_000_000n);
  });

  it("and the reason quotes the size actually proposed, not the setting", () => {
    const s = makeDipHunter(cfg as never);
    s.tick(snap({ prices: priced(false) as never }));
    const t = asTick(s.tick(snap({ prices: priced(true) as never })));
    const why = t.why[0] as { usdgRaw: bigint };
    assert.equal(why.usdgRaw, (t.intents[0] as { notionalUsdg: bigint }).notionalUsdg);
  });
});

describe("dip-hunter says why it is idle", () => {
  const cfg = { legs, swapRouter: ROUTER, usdg: USDG, buyPerTickUsdg: 5_000_000n, minDipBps: 100 };

  it("NOTHING PRICED IS NOT 'NO DIP WAS DEEP ENOUGH'", () => {
    const s = makeDipHunter(cfg as never);
    const t = asTick(s.tick(snap({ staleFeeds: new Set(["S1", "S2", "S3"]), prices: new Map() as never })));
    assert.equal(t.idle?.code, "all-legs-stale");
  });

  it("but a real pass stays quiet, because that is the strategy working", () => {
    const s = makeDipHunter(cfg as never);
    const flat = new Map(legs.map((l) => [l.symbol, { price8: 100_000_000n, stale: false }]));
    const t = asTick(s.tick(snap({ prices: flat as never })));
    assert.equal(t.idle, undefined);
  });

  it("and below one buy it names the balance and the vault", () => {
    const s = makeDipHunter(cfg as never);
    const t = asTick(s.tick(snap({ cashUsdg: 1_000_000n, vaultUsdg: 7_000_000n })));
    assert.equal(t.idle?.code, "under-one-buy");
    assert.equal((t.idle as { vaultRaw: bigint }).vaultRaw, 7_000_000n);
  });
});
