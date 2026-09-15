/**
 * AN OPEN CLASS POSITION MUST NOT MAKE THE BOOK UNVALUABLE.
 *
 * THE LIVE CASE. Shogun bought 1,006,167.866057921304348465 of 0x34d7…b4af for
 * exactly 5.000000 USDG at block 63155033. Every tick afterwards its book said:
 *
 *     book incomplete (0x34d7…b4af unpriced AND no cost on record)
 *       — equity, HWM, fee and breaker skipped this tick
 *
 * A class token has no price feed by design, so it lands in `unpricedByDesign`
 * and is carried at COST. But the cost came from `cost_basis`, which no class
 * buy writes — so it read as 0n, which is the one value meaning "we know neither
 * what it is worth nor what was paid", and the whole book went unvaluable. The
 * drawdown breaker was skipped on the one account that had just put real money
 * into a memecoin.
 *
 * The cost was never unknown. `ClassBuy.quoteIn` is on chain, it is exact, and
 * `writeClassLedger` persists it — and unlike a `cost_basis` row it is
 * re-derived from the vault's own events on every arm, so it survives the
 * container rebuild that wipes the child's sqlite.
 *
 * WHAT THIS PINS is the rule, against the real arithmetic: a basis row wins when
 * it exists, the chain's figure fills in when it does not, an unknown cost stays
 * unknown, and the scout budget counts the money once.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { quarantineOf } from "./quarantine";

/** Shogun's position, as `class_positions` holds it after the chain read. */
const SYMBOL = "0x34d7…b4af";
const COST = 5_000_000n; // 5.000000 USDG, ClassBuy.quoteIn

/**
 * The lookup the tick builds: `cost_basis` first, the class ledger second.
 *
 * Extracted here as the rule rather than copied from the tick, so what is
 * asserted is the decision and not a paraphrase of it. The tick applies exactly
 * this: a basis above zero wins, otherwise the chain-derived class cost.
 */
function costFor(
  symbol: string,
  basis: Map<string, bigint>,
  fromClass: Map<string, bigint>,
): { cost: bigint; countedFromClass: bigint } {
  const b = basis.get(symbol) ?? 0n;
  if (b > 0n) return { cost: b, countedFromClass: 0n };
  const c = fromClass.get(symbol) ?? 0n;
  return { cost: c, countedFromClass: c > 0n ? c : 0n };
}

const build = (basis: Map<string, bigint>, fromClass: Map<string, bigint>, symbols = [SYMBOL]) => {
  const qCost = new Map<string, bigint>();
  let classCostInQuarantine = 0n;
  for (const s of symbols) {
    const { cost, countedFromClass } = costFor(s, basis, fromClass);
    qCost.set(s, cost);
    classCostInQuarantine += countedFromClass;
  }
  const q = quarantineOf(
    symbols,
    (s) => qCost.get(s) ?? 0n,
    () => undefined,
  );
  const unknownCost = q.holdings.filter((h) => h.costUsdg === 0n).map((h) => h.symbol);
  return { q, unknownCost, bookIncomplete: unknownCost.length > 0, classCostInQuarantine };
};

describe("a class position is valued at what the chain says it cost", () => {
  it("SHOGUN'S TICK: no basis row, but the chain knows — the book is valuable", () => {
    const r = build(new Map(), new Map([[SYMBOL, COST]]));
    assert.equal(r.bookIncomplete, false, "equity, HWM, fee and breaker all run again");
    assert.deepEqual(r.unknownCost, []);
    assert.equal(r.q.totalCostUsdg, COST, "carried at its actual fill, 5.000000 USDG");
  });

  it("THE FAILURE IT REPLACES: with neither, the book is correctly unvaluable", () => {
    // The control, and it must keep working. A cost that is genuinely unknown
    // still stops the tick — the fallback may only ever fill in a figure the
    // chain actually stated.
    const r = build(new Map(), new Map());
    assert.equal(r.bookIncomplete, true);
    assert.deepEqual(r.unknownCost, [SYMBOL]);
  });

  it("a real cost_basis row still wins — the fallback never overrides one", () => {
    const r = build(new Map([[SYMBOL, 7_000_000n]]), new Map([[SYMBOL, COST]]));
    assert.equal(r.q.totalCostUsdg, 7_000_000n, "the ledger's own basis is authoritative");
    assert.equal(r.classCostInQuarantine, 0n, "and nothing is attributed to the fallback");
  });

  it("THE BUDGET COUNTS THE MONEY ONCE", () => {
    // `lastQuarantinedUsdg = quarantine.totalCostUsdg + curveCostUsdg
    //                        + lastClassCostUsdg − classCostInQuarantine`
    // When the fallback supplied every held class cost, the last two cancel and
    // the ceiling is exactly what it was before this change.
    const r = build(new Map(), new Map([[SYMBOL, COST]]));
    const lastClassCostUsdg = COST; // what scoutCostOf returns for the same rows
    const budget = r.q.totalCostUsdg + 0n + lastClassCostUsdg - r.classCostInQuarantine;
    assert.equal(budget, COST, "5.000000 of unpriceable money, counted once");
  });

  it("and when the class book could not be read, the budget is untouched", () => {
    // Nothing reaches `unpricedByDesign`, so the fallback contributes nothing
    // and the subtrahend is zero — the pre-change arithmetic, exactly.
    const r = build(new Map(), new Map(), []);
    assert.equal(r.classCostInQuarantine, 0n);
    const budget = r.q.totalCostUsdg + 0n + COST - r.classCostInQuarantine;
    assert.equal(budget, COST);
  });

  it("A RESTART CHANGES NOTHING, because the chain is the source", () => {
    // A redeploy wipes the child's sqlite: `cost_basis` is gone, and so is any
    // row the executor might have written. `class_positions` is rebuilt from the
    // vault's own ClassBuy events on the next arm, so the same figure comes
    // back — which is the whole reason the fallback reads the class ledger and
    // not some cached copy of the basis.
    const beforeRestart = build(new Map([[SYMBOL, COST]]), new Map([[SYMBOL, COST]]));
    const afterRestart = build(new Map(), new Map([[SYMBOL, COST]]));
    assert.equal(afterRestart.q.totalCostUsdg, beforeRestart.q.totalCostUsdg, "same cost basis");
    assert.equal(afterRestart.bookIncomplete, false, "and still a valuable book");
  });
});

/**
 * AND THE TICK ACTUALLY APPLIES IT.
 *
 * Everything above is the rule in isolation, which is testable and is also
 * exactly the shape that can pass while the product does the old thing. The tick
 * lives in a ~10.5k-line closure with no export, so the honest way to tie the
 * two together is to assert on its source — the same technique
 * `class-restart.test.ts` uses for the same reason.
 *
 * These are deliberately about the two decisions, not about formatting: that the
 * fallback is consulted only when the basis is absent, and that the budget
 * subtracts what the fallback contributed.
 */
describe("the tick applies the rule these tests describe", () => {
  const CODE = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

  it("consults the class ledger only when there is no basis row", () => {
    assert.match(
      CODE,
      /const basis = \(await getBasis\(agentId, qMode, s\)\)\.costUsdg;[\s\S]{0,120}if \(basis > 0n\) \{/,
      "a real basis must short-circuit before the fallback is reached",
    );
    assert.match(
      CODE,
      /const fromClass = classCostBySymbol\.get\(s\) \?\? 0n;/,
      "and the fallback must read the chain-derived class cost",
    );
  });

  it("subtracts what the fallback contributed, so the budget counts once", () => {
    assert.match(
      CODE,
      /quarantine\.totalCostUsdg \+ curveCostUsdg \+ lastClassCostUsdg - classCostInQuarantine/,
      "without the subtrahend the same class money is added twice",
    );
  });

  it("builds the cost map from HELD rows with a known cost, never from all rows", () => {
    // A row with a zero balance is sold or swept; its cost must not prop up an
    // equity figure. A row with a null cost is unknown and must stay unknown.
    assert.match(CODE, /classCostBySymbol = new Map\(\s*classHeldRows[\s\S]{0,160}r\.costRaw !== null/);
  });
});

/**
 * THE QUOTE ASSET IN THE VAULT IS CASH.
 *
 * The moment the real position started valuing correctly, Shogun's book failed
 * on the other token in its vault:
 *
 *     book incomplete (0x5fc5…d168 unpriced AND no cost on record)
 *
 * 0x5fc5…d168 is USDG. As a "position" it is nonsense in both directions: it has
 * no ClassBuy so it has no basis and reads as unknown, and it has no price feed
 * to look up because it IS the unit everything else is priced in.
 *
 * Excluding it without counting it would be the opposite error — that is the
 * owner's money at an address `readAccountBalances` does not cover.
 */
describe("USDG left in the class vault is cash, not an unpriceable position", () => {
  const CODE = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

  it("is kept out of the set the quarantine values", () => {
    assert.match(
      CODE,
      /symbols: classHeldRows\s*\.filter\(\(r\) => r\.token\.toLowerCase\(\) !== CASH\.USDG\.toLowerCase\(\)\)/,
      "the cash token must not reach unpricedByDesign",
    );
  });

  it("AND IS ADDED TO EQUITY AT FACE VALUE, not dropped", () => {
    assert.match(
      CODE,
      /cashUsdg: balances\.cashUsdg \+ classCashUsdg,/,
      "dropping it would understate the book by the owner's own money",
    );
    assert.match(
      CODE,
      /classCashUsdg = classHeldRows[\s\S]{0,200}CASH\.USDG\.toLowerCase\(\)[\s\S]{0,160}classRead\.balances\.get/,
      "and it is the vault's real balance, not a cost",
    );
  });

  it("the class LEDGER still records it — only the valuation changes", () => {
    // The filter is at the valuation, not at `reconcileClassBook`. The ledger
    // should go on knowing every token the vault holds; a recovery disclosure
    // that stopped listing stranded USDG is exactly the defect that shipped
    // once already.
    assert.doesNotMatch(
      CODE,
      /reconcileClassBook\([\s\S]{0,400}CASH\.USDG/,
      "the reconciler must stay ignorant of which token is the unit",
    );
  });
});

/**
 * THE SELL MUST BE PRICEABLE AFTER A REDEPLOY.
 *
 * A class buy DOES write a `cost_basis` row. But `cost_basis` lives in the
 * child's sqlite, which a container rebuild discards, and unlike
 * `class_positions` nothing re-derives it. A position bought before a redeploy
 * is therefore held afterwards with no basis at all, and the consequence lands
 * exactly where it hurts:
 *
 *   `applyFill` meets `prev.qtyRaw <= 0` on the sell, returns
 *   `basisUnknown: true` and `realizedUsdg: 0n`, and `bookFill` writes a NULL
 *   `realized_pnl_usdg` that `getRealizedPnlUsdg` excludes. The round trip
 *   completes, the money moves, and the book records no result for it.
 *
 * Shogun is holding 1,006,167.866057921304348465 of 0x34d7…b4af bought for
 * 5.000000 USDG, across several redeploys, with an exit due on its own clock.
 */
describe("the cost basis a class sell is measured against is restorable", () => {
  /** The rule `restoreClassCostBasis` applies, as arithmetic. */
  const restore = (costRaw: bigint | null, boughtRaw: bigint | null, balanceRaw: bigint) => {
    if (balanceRaw <= 0n) return null;
    if (costRaw === null || boughtRaw === null || boughtRaw <= 0n) return null;
    const held = balanceRaw > boughtRaw ? boughtRaw : balanceRaw;
    return { qtyRaw: held, costUsdg: (costRaw * held) / boughtRaw };
  };

  const BOUGHT = 1_006_167_866_057_921_304_348_465n;

  it("SHOGUN'S POSITION: the whole basis comes back", () => {
    const b = restore(COST, BOUGHT, BOUGHT);
    assert.deepEqual(b, { qtyRaw: BOUGHT, costUsdg: COST }, "5.000000 USDG against the full quantity");
  });

  it("PART-SOLD: pro-rata, so the missing part is not booked as profit", () => {
    // Half sold before the rebuild. Restoring the WHOLE 5.000000 against the
    // remaining half would make the next sell report the other half's cost as
    // gain — the exact error a naive restore makes.
    const half = BOUGHT / 2n;
    const b = restore(COST, BOUGHT, half)!;
    assert.equal(b.qtyRaw, half);
    // 2499999, not 2500000: BOUGHT is odd, so `half` floors and the pro-rata
    // floors again. One micro-unit LOW, which understates profit — the only
    // direction a rounding error in a cost basis is allowed to go.
    assert.equal(b.costUsdg, 2_499_999n);
    assert.ok(b.costUsdg <= COST / 2n, "never more than the share it represents");
  });

  it("floors, so a restored basis is never too HIGH", () => {
    // Too high understates profit; too low overstates it. Floor division picks
    // the direction that cannot flatter the book.
    const odd = restore(7n, 3n, 2n)!;
    assert.equal(odd.costUsdg, 4n, "7 * 2 / 3 = 4.67 floored to 4");
  });

  it("AN UNKNOWN COST STAYS UNKNOWN — no basis is invented", () => {
    // An invented basis would turn the entire proceeds of the next sell into
    // reported profit. Nothing is worse than a confident zero here.
    assert.equal(restore(null, BOUGHT, BOUGHT), null);
    assert.equal(restore(COST, null, BOUGHT), null);
    assert.equal(restore(COST, 0n, BOUGHT), null);
  });

  it("a position that is gone gets nothing", () => {
    assert.equal(restore(COST, BOUGHT, 0n), null);
  });

  it("and the tick never overwrites a live basis", () => {
    const CODE = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    assert.match(
      CODE,
      /const existing = await getBasis\(agentId, "live", symbol\);\s*\n\s*if \(existing\.qtyRaw > 0n\) return;/,
      "applyFill maintains that row through partial fills and knows more than a chain summary",
    );
    // ONE KEY FOR BOTH DIRECTIONS. The restore and the clear resolve the symbol
    // once, before either branch, so a basis can never be restored under one
    // spelling and cleared under another.
    assert.match(
      CODE,
      /const key = stored0\?\.symbol \?\? short\(p\.token\);/,
      "and it must key on the same address-derived symbol the buy wrote",
    );
    assert.match(CODE, /const symbol = key;/);
  });
});

/**
 * A BASIS MUST NOT OUTLIVE ITS POSITION.
 *
 * The other direction of the same reconciliation. A cost basis carried against a
 * position the vault no longer holds is not inert: it is what a re-entry into
 * the same token starts from, so the next buy inherits a cost it never paid and
 * the next sell reports a loss that already happened.
 *
 * Shogun's sold-out position still carried 5.000000 USDG of basis after the
 * round trip completed, with the tick-level stranded sweep having logged closing
 * it. The chain says the position is gone; that is the authority.
 */
describe("a position the chain says is gone carries no basis", () => {
  const CODE = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const fn = CODE.slice(
    CODE.indexOf("async function restoreClassCostBasis("),
    CODE.indexOf("async function bookClassSweepWithdrawal("),
  );

  it("clears it when nothing is held", () => {
    assert.ok(fn.length > 400, "the function must be found");
    assert.match(
      fn,
      /if \(p\.balanceRaw <= 0n\) \{[\s\S]*setBasis\(agentId, "live", key, \{ qtyRaw: 0n, costUsdg: 0n \}\)/,
      "a zero balance must clear the basis, not merely skip the restore",
    );
  });

  it("only when there is something to clear, so it is not a write per tick", () => {
    assert.match(fn, /if \(left\.qtyRaw > 0n \|\| left\.costUsdg > 0n\) \{/);
  });

  it("and it uses the SAME key the restore and the buy use", () => {
    // Three spellings of this symbol would be three chances to clear the wrong
    // row — or to leave the right one standing.
    assert.match(fn, /const key = stored0\?\.symbol \?\? short\(p\.token\);/);
    assert.match(fn, /const symbol = key;/);
  });
});
