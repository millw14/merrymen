import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { steadyBasketTick, type SteadyBasketConfig } from "./steady-basket";
import { takeTick, type Snapshot } from "./types";

/**
 * steadyBasketTick now returns its reasons alongside its intents. These tests
 * predate that and are about the intents, so they keep asserting on those.
 */
const sbTick = (...a: Parameters<typeof steadyBasketTick>) => takeTick(steadyBasketTick(...a)).intents;

const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const VAULT = "0x2222222222222222222222222222222222222222" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const AAPL = "0x4444444444444444444444444444444444444444" as const;
const MSFT = "0x5555555555555555555555555555555555555555" as const;

function cfg(over: Partial<SteadyBasketConfig> = {}): SteadyBasketConfig {
  return {
    legs: [
      { symbol: "AAPL", token: AAPL, weightBps: 5_000 },
      { symbol: "MSFT", token: MSFT, weightBps: 5_000 },
    ],
    buyPerTickUsdg: 20_000_000n, // 20 USDG per tick
    idleFloorUsdg: 50_000_000n, // keep 50 USDG liquid
    swapRouter: ROUTER,
    vault: VAULT,
    usdg: USDG,
    ...over,
  };
}

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    cashUsdg: 100_000_000n, // 100 USDG
    vaultUsdg: 0n,
    holdings: new Map(),
    prices: new Map(),
    pausedTokens: new Set<string>(),
    staleFeeds: new Set<string>(),
    sequencerUp: true,
    // Wide open by default: these fixtures predate cap-aware sizing, so the
    // headroom must not clamp them. Clamping is pinned in its own test.
    spendHeadroomUsdg: 1_000_000_000_000n,
    perTradeCapUsdg: 1_000_000_000_000n,
    ...over,
  };
}

/**
 * Regression: the vault sweep used to propose the WHOLE excess above the idle
 * floor. On a small grant that is over the daily cap, so checkPolicy rejected it
 * — and because the strategy is stateless, it re-proposed the identical
 * oversized deposit every single tick, forever: a rejected trade row and a warn
 * event each time, while the cash never actually reached the vault.
 *
 * The sweep is now sized to the headroom the wall will really accept. Reported
 * by @zeeonchain (PR #4), fixed here by sizing to the live cap rather than a
 * fixed constant, so it holds for every grant preset instead of just large ones.
 */
describe("steadyBasketTick — the vault sweep sizes itself to the policy wall", () => {
  const SCOUT_DAILY = 50_000_000n; // the shipped "scout" preset: 50 USDG/day

  it("clamps an oversized sweep to the remaining daily budget instead of proposing the lot", () => {
    // 500 USDG cash, 50 floor → wants to sweep 450, but scout allows 50/day.
    const intents = sbTick(
      cfg({ buyPerTickUsdg: 20_000_000n }),
      snap({ cashUsdg: 500_000_000n, spendHeadroomUsdg: SCOUT_DAILY }),
    );
    const deposit = intents.find((i) => i.kind === "vault-deposit");
    assert.ok(deposit, "still sweeps — the cash isn't stranded");
    // 50 headroom, minus the 20 committed to this tick's buys, minus one
    // tick's buy held BACK so the sleeve can trade again. The reserve is the
    // fix for nine agents whose parked cash exactly consumed their daily cap —
    // the fit was exact (vault 483.335 + positions 16.498 against a 500 cap)
    // and the sweep repeats daily, so they were capped permanently.
    assert.equal(deposit!.kind === "vault-deposit" && deposit!.amountUsdg, 10_000_000n,
      "50 headroom, minus 20 spent this tick, minus a 20 reserve for the next buy");
  });

  it("accounts for the buys it proposed in the same tick — they spend the same budget", () => {
    const intents = sbTick(
      cfg({ buyPerTickUsdg: 20_000_000n }),
      snap({ cashUsdg: 500_000_000n, spendHeadroomUsdg: 100_000_000n }),
    );
    const buys = intents.filter((i) => i.kind === "swap");
    const deposit = intents.find((i) => i.kind === "vault-deposit");
    const buyTotal = buys.reduce((s, i) => s + (i.kind === "swap" ? i.notionalUsdg : 0n), 0n);
    assert.equal(buyTotal, 20_000_000n);
    // 100 headroom - 20 spent this tick - 20 reserved for the next buy.
    assert.equal(deposit!.kind === "vault-deposit" && deposit!.amountUsdg, 60_000_000n);
    // The whole tick fits inside the budget AND leaves room to buy again.
    assert.ok(buyTotal + 60_000_000n <= 100_000_000n);
    assert.ok(100_000_000n - buyTotal - 60_000_000n >= 20_000_000n, "a buy still fits after the sweep");
  });

  it("proposes NO deposit when the daily budget is already spent — silence beats a guaranteed rejection", () => {
    const intents = sbTick(
      cfg({ buyPerTickUsdg: 20_000_000n }),
      snap({ cashUsdg: 500_000_000n, spendHeadroomUsdg: 20_000_000n }),
    );
    // The buys consume the last 20; nothing is left for the sweep this tick.
    assert.equal(intents.some((i) => i.kind === "vault-deposit"), false);
  });

  it("leaves a sweep that already fits completely alone", () => {
    const intents = sbTick(
      cfg({ buyPerTickUsdg: 20_000_000n }),
      snap({ cashUsdg: 100_000_000n, spendHeadroomUsdg: 500_000_000n }),
    );
    const deposit = intents.find((i) => i.kind === "vault-deposit");
    // 100 cash − 20 buys − 50 floor = 30, well inside the budget: unchanged.
    assert.equal(deposit!.kind === "vault-deposit" && deposit!.amountUsdg, 30_000_000n);
  });
});

describe("steadyBasketTick", () => {
  it("emits nothing when the sequencer is down", () => {
    assert.deepEqual(sbTick(cfg(), snap({ sequencerUp: false })), []);
  });

  it("splits the tick budget across legs by weight", () => {
    const intents = sbTick(cfg(), snap());
    const swaps = intents.filter((i) => i.kind === "swap");
    assert.equal(swaps.length, 2);
    for (const s of swaps) {
      assert.equal(s.kind === "swap" && s.sellAmountRaw, 10_000_000n);
      assert.equal(s.kind === "swap" && s.notionalUsdg, 10_000_000n);
      assert.equal(s.target, ROUTER);
    }
  });

  it("skips paused tokens but still buys the rest", () => {
    const intents = sbTick(
      cfg(),
      snap({ pausedTokens: new Set([AAPL.toLowerCase()]) }),
    );
    const swaps = intents.filter((i) => i.kind === "swap");
    assert.equal(swaps.length, 1);
    assert.equal(swaps[0]!.kind === "swap" && swaps[0]!.buyToken, MSFT);
  });

  it("skips legs with a stale price feed", () => {
    const intents = sbTick(cfg(), snap({ staleFeeds: new Set(["MSFT"]) }));
    const swaps = intents.filter((i) => i.kind === "swap");
    assert.equal(swaps.length, 1);
    assert.equal(swaps[0]!.kind === "swap" && swaps[0]!.buyToken, AAPL);
  });

  it("does not buy when cash is below the tick budget", () => {
    const intents = sbTick(cfg(), snap({ cashUsdg: 19_000_000n }));
    assert.equal(intents.filter((i) => i.kind === "swap").length, 0);
  });

  it("sweeps idle cash above the floor into the vault", () => {
    // 100 cash - 20 buys = 80 idle, floor 50 → deposit 30
    const intents = sbTick(cfg(), snap());
    const deposit = intents.find((i) => i.kind === "vault-deposit");
    assert.ok(deposit);
    assert.equal(deposit.kind === "vault-deposit" && deposit.amountUsdg, 30_000_000n);
    // Narrowed access: equity orders carry no target, so the union no longer
    // exposes it un-narrowed — which is the point of the variant's shape.
    assert.equal(deposit.kind === "vault-deposit" && deposit.target, VAULT);
  });

  it("leaves cash alone when at or below the idle floor", () => {
    const intents = sbTick(cfg(), snap({ cashUsdg: 70_000_000n }));
    // 70 - 20 = 50 idle, exactly at floor → no deposit
    assert.equal(intents.find((i) => i.kind === "vault-deposit"), undefined);
  });

  it("withdraws from the vault when cash cannot cover a buy", () => {
    const intents = sbTick(
      cfg(),
      snap({ cashUsdg: 5_000_000n, vaultUsdg: 200_000_000n }),
    );
    // Withdraw-only tick: top cash up to buyPerTick (20) + floor (50) = 70 → need 65
    assert.equal(intents.length, 1);
    const w = intents[0]!;
    assert.equal(w.kind, "vault-withdraw");
    assert.equal(w.kind === "vault-withdraw" && w.amountUsdg, 65_000_000n);
  });

  it("withdrawal is capped at the vault balance", () => {
    const intents = sbTick(
      cfg(),
      snap({ cashUsdg: 0n, vaultUsdg: 12_000_000n }),
    );
    assert.equal(intents.length, 1);
    assert.equal(intents[0]!.kind === "vault-withdraw" && intents[0]!.amountUsdg, 12_000_000n);
  });

  it("does not withdraw when the vault is empty", () => {
    const intents = sbTick(cfg(), snap({ cashUsdg: 5_000_000n, vaultUsdg: 0n }));
    assert.deepEqual(intents, []);
  });
});

/**
 * THE DAY'S BUDGET WAS BINDING ON THE SWEEP AND NOT ON THE BUYS.
 *
 * The buy loop consulted `cashUsdg` and nothing else, so once the daily cap was
 * spent it proposed the same legs every tick and checkPolicy refused every one.
 * On shipped defaults that is not an edge case: 25 USDG a tick at 60s against a
 * 50 USDG daily cap spends the whole allowance in TWO MINUTES and then refuses
 * for the remaining 1,438 — three refusals a tick, roughly 4,300 a day.
 *
 * The second half matters as much as the first. `bought` goes true whenever the
 * loop pushes anything, and `bought` true means `idle` is never set — so the
 * machine built to say why nothing happened could not fire in the commonest way
 * for nothing to happen.
 */
describe("the daily budget binds the buy loop", () => {
  it("proposes nothing when the day's budget is spent, however much cash is on hand", () => {
    // 900 USDG of cash and no permission to spend any of it. Before the clamp
    // this returned two swaps that the wall refused, every tick, all day.
    const out = takeTick(
      steadyBasketTick(cfg(), snap({ cashUsdg: 900_000_000n, spendHeadroomUsdg: 0n })),
    );
    assert.deepEqual(
      out.intents.filter((i) => i.kind === "swap"),
      [],
      "a buy the wall will certainly refuse must not be proposed",
    );
  });

  it("and SAYS SO, which it structurally could not before", () => {
    const out = takeTick(
      steadyBasketTick(cfg(), snap({ cashUsdg: 900_000_000n, spendHeadroomUsdg: 0n })),
    );
    assert.equal(out.idle?.code, "budget-spent");
  });

  it("does not blame the cash when the cash is fine", () => {
    // `under-one-buy` reads "you have X and one buy costs Y" — a baffling thing
    // to be told while holding 900 USDG. Ordering is the whole fix.
    const out = takeTick(
      steadyBasketTick(cfg(), snap({ cashUsdg: 900_000_000n, spendHeadroomUsdg: 0n })),
    );
    assert.notEqual(out.idle?.code, "under-one-buy");
  });

  it("clamps a partial budget instead of proposing the full tick", () => {
    // 20 USDG a tick across two 50% legs, with only 6 USDG of headroom left.
    // Gating on `headroom > 0` alone would still propose 10 + 10 and be refused.
    const intents = sbTick(cfg(), snap({ spendHeadroomUsdg: 6_000_000n }));
    const spent = intents
      .filter((i) => i.kind === "swap")
      .reduce((sum, i) => sum + (i.kind === "swap" ? i.notionalUsdg : 0n), 0n);
    assert.ok(spent > 0n, "a partial budget still buys something");
    assert.ok(spent <= 6_000_000n, `proposed ${spent} against 6 USDG of headroom`);
  });

  it("never proposes a zero-sized leg when the budget runs out mid-basket", () => {
    // The first leg takes the last of it; the second must be dropped, not
    // pushed at zero for `non-positive` to refuse.
    const intents = sbTick(cfg(), snap({ spendHeadroomUsdg: 10_000_000n }));
    for (const i of intents) {
      if (i.kind === "swap") assert.ok(i.notionalUsdg > 0n, "a zero-sized buy is not a trade");
    }
  });

  it("an ample budget is unchanged — this must not throttle a healthy agent", () => {
    const intents = sbTick(cfg(), snap());
    const swaps = intents.filter((i) => i.kind === "swap");
    assert.equal(swaps.length, 2);
    const spent = swaps.reduce((sum, i) => sum + (i.kind === "swap" ? i.notionalUsdg : 0n), 0n);
    assert.equal(spent, 20_000_000n, "the full per-tick size still goes out");
  });
});
