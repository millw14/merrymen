/**
 * A FLOOR UNDER THE STRATEGY THE OWNER ACTUALLY RUNS.
 *
 * Every stop-loss in this repo belonged to `trencher`, and reaching one meant
 * abandoning the strategist entirely. So llm-strategist — the strategy that
 * thinks, and the one an owner picks when they want an agent rather than a
 * schedule — had NO mechanical exit of any kind. Whether a losing position was
 * ever sold depended on a model choosing to sell it, half an hour at a time.
 *
 * This is not a promise that nothing loses money. It cannot be: it measures
 * from ENTRY, not from a peak, so it does not catch a position that ran up and
 * gave it back; it fires one tick after the threshold at whatever the pool pays
 * then; and on a bonding curve, whose p99 move is 1,546 bps over four minutes,
 * a 20% floor can and will realise considerably worse. It bounds a loss. It
 * does not prevent one.
 *
 * TWO OF THESE TESTS GUARD AGAINST SILENT USELESSNESS. A floor that only runs
 * at the decision window, or one that gets clamped back to the strategist
 * ceiling, looks identical in the log to a working one — and would be worth
 * nothing at exactly the moment it mattered.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeLlmStrategist } from "./strategy";
import { renderWhy } from "../strategies/reasons";
import type { Snapshot } from "../strategies/types";

const TSLA = "0x0000000000000000000000000000000000000001" as const;
const NVDA = "0x0000000000000000000000000000000000000002" as const;
const USDG = "0x00000000000000000000000000000000000000dd" as const;
const ROUTER = "0x00000000000000000000000000000000000000ff" as const;

/** A driver that records whether it was asked, and never proposes anything. */
const spyDriver = () => {
  const calls: number[] = [];
  return {
    calls,
    driver: {
      name: "spy",
      propose: async () => {
        calls.push(Date.now());
        return { actions: [] };
      },
    },
  };
};

const held = (over: Partial<{ value: bigint; cost: bigint | null; stale: boolean }> = {}) =>
  new Map([
    [
      "TSLA",
      {
        token: TSLA,
        rawBalance: 5_000_000_000_000_000_000n,
        // 10 USDG paid, worth 7 now — a 30% loss.
        valueUsdg: over.value ?? 7_000_000n,
        priceStale: over.stale ?? false,
        costUsdg: over.cost === undefined ? 10_000_000n : over.cost,
      },
    ],
  ]);

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  cashUsdg: 100_000_000n,
  vaultUsdg: 0n,
  ethWei: 10n ** 16n,
  holdings: new Map(),
  prices: new Map(),
  pausedTokens: new Set(),
  staleFeeds: new Set(),
  sequencerUp: true,
  spendHeadroomUsdg: 1_000_000_000n,
  perTradeCapUsdg: 10_000_000n, // 10 USDG — the owner's real per-trade cap
  ...over,
});

const build = (stopLossBps: number, driver: { name: string; propose: () => Promise<unknown> }) =>
  makeLlmStrategist({
    driver: driver as never,
    universe: {
      legs: new Map([["TSLA", TSLA], ["NVDA", NVDA]]),
      swapRouter: ROUTER,
      usdg: USDG,
      // The ceiling that must NOT clamp the floor: 10 USDG, while the position
      // being exited is worth more than that in the sizing test below.
      maxPerActionUsdg: 10_000_000n,
      maxActionsPerTick: 4,
    },
    stopLossBps,
    decisionIntervalMs: 30 * 60_000,
    now: () => 1_000_000,
  });

const tickOf = async (s: ReturnType<typeof build>, sn: Snapshot) => {
  const r = await s.tick(sn);
  return Array.isArray(r) ? { intents: r, why: [] as unknown[] } : r;
};

describe("off by default, and off means off", () => {
  it("AT 0 BPS NOTHING CHANGES", async () => {
    const { driver } = spyDriver();
    const t = await tickOf(build(0, driver), snap({ holdings: held() }));
    assert.equal(t.intents.length, 0, "a 30% loser is untouched when no floor is armed");
  });
});

describe("what it refuses to sell against", () => {
  it("A HOLDING WITH NO COST ON RECORD IS SKIPPED, not assumed a total loss", async () => {
    // `costUsdg: null` means the ledger has no basis. Reading null as zero would
    // make every holding look like a 100% loss and sell the whole book — the
    // accounting bug this codebase exists downstream of, as a liquidation.
    const { driver } = spyDriver();
    const t = await tickOf(build(2_000, driver), snap({ holdings: held({ cost: null }) }));
    assert.equal(t.intents.length, 0);
  });

  it("A STALE PRICE IS NOT A LOSS", async () => {
    // priceStale means that market is closed and the value is last session's
    // number. Selling against it realises a loss measured at a price nobody is
    // currently making.
    const { driver } = spyDriver();
    const t = await tickOf(build(2_000, driver), snap({ holdings: held({ stale: true }) }));
    assert.equal(t.intents.length, 0);
  });

  it("and a position that has not fallen far enough is left alone", async () => {
    const { driver } = spyDriver();
    // 10 paid, worth 9.5 — a 5% loss against a 20% floor.
    const t = await tickOf(build(2_000, driver), snap({ holdings: held({ value: 9_500_000n }) }));
    assert.equal(t.intents.length, 0);
  });

  it("and a paused token is not sold either", async () => {
    const { driver } = spyDriver();
    const t = await tickOf(
      build(2_000, driver),
      snap({ holdings: held(), pausedTokens: new Set([TSLA.toLowerCase()]) }),
    );
    assert.equal(t.intents.length, 0);
  });
});

describe("what it does when it fires", () => {
  it("SELLS THE WHOLE POSITION, BACK INTO CASH", async () => {
    const { driver } = spyDriver();
    const t = await tickOf(build(2_000, driver), snap({ holdings: held() }));
    const sell = t.intents[0];
    assert.ok(sell, "a 30% loser against a 20% floor must be sold");
    assert.equal(sell.kind === "swap" && sell.sellToken, TSLA);
    assert.equal(sell.kind === "swap" && sell.buyToken, USDG, "into cash");
    assert.equal(sell.kind === "swap" && sell.sellAmountRaw, 5_000_000_000_000_000_000n, "all of it");
  });

  it("IT IS NOT CLAMPED TO THE STRATEGIST CEILING", async () => {
    // THE ONE THAT WOULD SILENTLY REGRESS INTO USELESSNESS. The ceiling here is
    // 10 USDG. A floor routed through proposalsToIntents would be clamped to
    // that — so a position worth 40 USDG could never be fully exited by the
    // thing whose entire job is exiting it, and the log would look identical.
    const { driver } = spyDriver();
    const big = new Map([
      ["TSLA", { token: TSLA, rawBalance: 9n, valueUsdg: 40_000_000n, priceStale: false, costUsdg: 100_000_000n }],
    ]);
    const t = await tickOf(build(2_000, driver), snap({ holdings: big }));
    const sell = t.intents[0]!;
    assert.equal(sell.kind === "swap" && sell.notionalUsdg, 40_000_000n, "40 USDG, not clamped to 10");
    assert.equal(sell.kind === "swap" && sell.sellAmountRaw, 9n);
  });

  it("AND IT RUNS WITHOUT ASKING THE MODEL", async () => {
    // THE OTHER ONE. A model is consulted every decisionIntervalMs — half an
    // hour by default — and a stop that only ran then would have a
    // thirty-minute blind spot, which on this chain is most of a move.
    const spy = spyDriver();
    const s = build(2_000, spy.driver);
    // First tick opens the window and asks the model.
    await tickOf(s, snap());
    assert.equal(spy.calls.length, 1);
    // Second tick is INSIDE the interval — the model is not asked, and the
    // floor still fires.
    const t = await tickOf(s, snap({ holdings: held() }));
    assert.equal(spy.calls.length, 1, "no second model call");
    assert.equal(t.intents.length, 1, "and the floor still cut it");
  });

  it("and it says the machine cut it, in computed numbers", async () => {
    const { driver } = spyDriver();
    const t = await tickOf(build(2_000, driver), snap({ holdings: held() }));
    const why = (t.why as { code?: string }[])[0]!;
    assert.equal(why.code, "stop-floor");
    const said = renderWhy(why as never);
    assert.match(said, /TSLA is 30% below what it cost/);
    assert.match(said, /A floor, not a view: the rule fired, I did not change my mind/);
    assert.ok(said.length < 220, "must not truncate on any surface");
  });
});

describe("it does not sell the same thing twice", () => {
  it("A FIRED FLOOR IS LATCHED UNTIL THE POSITION LEAVES THE BOOK", async () => {
    // A fill takes a tick or two to land. Without the latch the same holding is
    // re-proposed every tick in between, and the agent sells it repeatedly.
    const { driver } = spyDriver();
    const s = build(2_000, driver);
    assert.equal((await tickOf(s, snap({ holdings: held() }))).intents.length, 1);
    assert.equal((await tickOf(s, snap({ holdings: held() }))).intents.length, 0, "not proposed twice");
  });

  it("and the latch releases once it is gone, so it can arm again", async () => {
    const { driver } = spyDriver();
    const s = build(2_000, driver);
    await tickOf(s, snap({ holdings: held() }));
    await tickOf(s, snap({ holdings: new Map() })); // filled — book is empty
    assert.equal((await tickOf(s, snap({ holdings: held() }))).intents.length, 1, "re-armed");
  });
});

/**
 * THE LEVEL IS NOW THE POSITION'S, THE PERMISSION IS STILL THE OWNER'S.
 *
 * A single floor swept across a book fires on the venue under a launchpad coin
 * and takes a third of the owner's money under an equity. So each position
 * carries a level graded at its own entry — and nothing else about the rule
 * changes: the owner's `stopLossBps` still decides whether a floor exists at
 * all, still applies unchanged to everything ungraded, and a grade can never
 * arm a stop on a book that armed none.
 */
const heldWith = (over: { value?: bigint; cost?: bigint; floor?: number | null; why?: string | null } = {}) =>
  new Map([
    [
      "TSLA",
      {
        token: TSLA,
        rawBalance: 5_000_000_000_000_000_000n,
        valueUsdg: over.value ?? 7_000_000n, // 10 paid, worth 7 — a 30% loss
        priceStale: false,
        costUsdg: over.cost === undefined ? 10_000_000n : over.cost,
        stopFloorBps: over.floor === undefined ? null : over.floor,
        stopFloorWhy: over.why ?? null,
      },
    ],
  ]);

describe("a floor graded to this position", () => {
  it("A TIGHTER GRADE FIRES WHERE THE OWNER'S NUMBER WOULD NOT", async () => {
    const { driver } = spyDriver();
    // 10 paid, worth 8.5 — a 15% loss. Under the owner's 25% it holds; under a
    // 12% grade it goes.
    const book = heldWith({ value: 8_500_000n, floor: 1_200 });
    const t = await tickOf(build(2_500, driver), snap({ holdings: book }));
    assert.equal(t.intents.length, 1, "the graded floor must fire at its own level");
  });

  it("AND A WIDER GRADE HOLDS WHERE THE OWNER'S NUMBER WOULD FIRE", async () => {
    // The half that is easy to get wrong: a graded level must be able to be
    // LOOSER than the setting, or the grade is decoration on a book of
    // memecoins where 25% is inside four minutes of ordinary movement.
    const { driver } = spyDriver();
    const t = await tickOf(build(2_500, driver), snap({ holdings: heldWith({ floor: 3_500 }) }));
    assert.equal(t.intents.length, 0, "a 30% loss is inside a 35% graded floor");
  });

  it("AN UNGRADED POSITION IS EXACTLY AS IT WAS", async () => {
    const { driver } = spyDriver();
    const t = await tickOf(build(2_000, driver), snap({ holdings: heldWith({ floor: null }) }));
    assert.equal(t.intents.length, 1, "the owner's own number still applies unchanged");
  });

  it("AND A GRADE CANNOT ARM A FLOOR THE OWNER DID NOT", async () => {
    // The load-bearing one. `stopLossBps: 0` is off, and a stamped level must
    // never be read as permission to sell somebody's position.
    const { driver } = spyDriver();
    const t = await tickOf(build(0, driver), snap({ holdings: heldWith({ floor: 500 }) }));
    assert.equal(t.intents.length, 0, "off means off, whatever is stamped");
  });

  it("and a zero or negative stamp falls back rather than disarming", async () => {
    // A bad row must not be able to switch a position's protection off.
    const { driver } = spyDriver();
    for (const bad of [0, -100]) {
      const t = await tickOf(build(2_000, driver), snap({ holdings: heldWith({ floor: bad }) }));
      assert.equal(t.intents.length, 1, `a stamp of ${bad} must fall back to the owner's floor`);
    }
  });

  it("and it says the level was graded, in the sentence that costs money", async () => {
    const { driver } = spyDriver();
    const t = await tickOf(
      build(2_500, driver),
      snap({ holdings: heldWith({ value: 8_500_000n, floor: 1_200, why: "12% — 3 analysts had real material on this" }) }),
    );
    const said = renderWhy((t.why as never[])[0]!);
    assert.match(said, /A floor, not a view/, "the sentence an owner already knows is unchanged");
    assert.match(said, /Its floor was graded when I bought it — 12% — 3 analysts/);
  });

  it("and an ungraded exit says exactly what it always said", async () => {
    // No graded clause, no change in length, nothing new to read.
    const { driver } = spyDriver();
    const t = await tickOf(build(2_000, driver), snap({ holdings: heldWith({ floor: null }) }));
    const said = renderWhy((t.why as never[])[0]!);
    assert.ok(!said.includes("graded"), "an ungraded floor must not mention grading");
    assert.ok(said.length < 220, "must not truncate on any surface");
  });
});

describe("the ceiling this strategy never had", () => {
  const up = (gain: bigint) =>
    new Map([
      [
        "TSLA",
        {
          token: TSLA,
          rawBalance: 5_000_000_000_000_000_000n,
          valueUsdg: gain,
          priceStale: false,
          costUsdg: 10_000_000n,
        },
      ],
    ]);

  const withTp = (stopBps: number, takeProfitBps: number, driver: { name: string; propose: () => Promise<unknown> }) =>
    makeLlmStrategist({
      driver: driver as never,
      universe: {
        legs: new Map([["TSLA", TSLA], ["NVDA", NVDA]]),
        swapRouter: ROUTER,
        usdg: USDG,
        maxPerActionUsdg: 10_000_000n,
        maxActionsPerTick: 4,
      },
      stopLossBps: stopBps,
      takeProfitBps,
      decisionIntervalMs: 30 * 60_000,
      now: () => 1_000_000,
    });

  it("TAKES A PROFIT AT THE LEVEL THE OWNER SET", async () => {
    // `takeProfitBps` was saved in settings, shown in the UI, and described by
    // agents to their owners — and registry.ts forwarded it only to
    // steady-basket, so on this strategy it was read by nothing at all.
    const { driver } = spyDriver();
    const t = await tickOf(withTp(2_500, 2_000, driver), snap({ holdings: up(12_500_000n) }));
    assert.equal(t.intents.length, 1, "up 25% against a 20% ceiling must sell");
    const sell = t.intents[0]!;
    assert.equal(sell.kind === "swap" && sell.buyToken, USDG, "into cash");
    assert.equal(sell.kind === "swap" && sell.sellAmountRaw, 5_000_000_000_000_000_000n, "all of it");
    assert.match(renderWhy((t.why as never[])[0]!), /is up 25% on what it cost/);
  });

  it("and it is off at zero, which is the shipped default", async () => {
    const { driver } = spyDriver();
    assert.equal((await tickOf(withTp(2_500, 0, driver), snap({ holdings: up(50_000_000n) }))).intents.length, 0);
  });

  it("and a position that has not run far enough is left alone", async () => {
    const { driver } = spyDriver();
    assert.equal((await tickOf(withTp(2_500, 2_000, driver), snap({ holdings: up(11_000_000n) }))).intents.length, 0);
  });

  it("AND IT IS NOT CLAMPED TO THE STRATEGIST CEILING EITHER", async () => {
    // Same trap as the floor: routed through proposalsToIntents a 40 USDG
    // winner could never be fully sold by the rule whose job is selling it.
    const { driver } = spyDriver();
    const big = new Map([
      ["TSLA", { token: TSLA, rawBalance: 9n, valueUsdg: 40_000_000n, priceStale: false, costUsdg: 10_000_000n }],
    ]);
    const t = await tickOf(withTp(2_500, 2_000, driver), snap({ holdings: big }));
    assert.equal(t.intents[0]!.kind === "swap" && t.intents[0]!.notionalUsdg, 40_000_000n, "40 USDG, not clamped to 10");
  });

  it("and it runs without asking the model, like the floor", async () => {
    const spy = spyDriver();
    const s = withTp(2_500, 2_000, spy.driver);
    await tickOf(s, snap());
    assert.equal(spy.calls.length, 1);
    const t = await tickOf(s, snap({ holdings: up(12_500_000n) }));
    assert.equal(spy.calls.length, 1, "no second model call");
    assert.equal(t.intents.length, 1, "and it still took the profit");
  });
});
