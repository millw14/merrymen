/**
 * A SWEPT CLASS POSITION IS A WITHDRAWAL, NOT A SALE THAT RETURNED NOTHING.
 *
 * THE LIVE CASE. Shogun bought 1,063,408.141815259059579834 DOGGOS for exactly
 * 5.000000 USDG, never sold a token of it, and its owner took the whole holding
 * home through the Recover panel. The ledger recorded
 *
 *     state='closed'   cost_usdg='5000000'   proceeds_usdg='0'
 *
 * which says the position was liquidated and returned nothing — a total loss of
 * everything it cost. The owner was holding the tokens in their own wallet.
 *
 * NOTHING COMPUTED "-5". The damage was quieter than that and worse. While the
 * vault held the token its cost basis sat in `quarantine.totalCostUsdg`, the
 * fourth term of `composeEquityUsdg`. The sweep zeroed the balance, the row was
 * filtered out, and equity fell by the full 5.000000 in one tick with no flow
 * row anywhere to say where it went — so the high-water mark did not follow it,
 * and the drawdown the breaker judges widened by exactly that much. The same
 * failure `adjustAgentHwm` already describes for a USDG withdrawal, reached
 * through an asset the USDG flow scanner cannot see: the tokens left the VAULT,
 * as tokens, in a transaction the account's own log never mentions.
 *
 * The chain always said which it was. `foldClassEvents` has counted `Swept`
 * amounts since the class ledger shipped and then dropped them on the floor.
 *
 * PURE, so it runs without a chain or a database — the reconciler is where the
 * distinction is decided, and it is decided on evidence the fold already has.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconcileClassBook, scoutCostOf } from "./class-reconcile";
import { foldClassEvents, type ClassEvent } from "./venues/class-log";

const TOKEN = "0x15e498ff2dbca95e8648a1f025cbbd12c2525461" as `0x${string}`;
const CURVE = "0x2f0c6e73936c87c633135d3cb4876e2c2d680332" as `0x${string}`;
const BUY_TX = "0xd860ac4695000000000000000000000000000000000000000000000000000000" as `0x${string}`;
const SWEEP_TX = "0x06cd8dba8f00000000000000000000000000000000000000000000000000000" as `0x${string}`;

/** Shogun's actual fill: 5.000000 USDG in, 1,063,408.141815259059579834 out. */
const QTY = 1_063_408_141_815_259_059_579_834n;
const COST = 5_000_000n;

const buy: ClassEvent = {
  kind: "buy",
  token: TOKEN,
  curve: CURVE,
  quoteRaw: COST,
  tokenRaw: QTY,
  blockNumber: 61_171_816n,
  txHash: BUY_TX,
  logIndex: 3,
};

const sweep: ClassEvent = {
  kind: "swept",
  token: TOKEN,
  curve: null,
  // A sweep moves no quote, by construction — class-log.ts hard-codes this.
  quoteRaw: 0n,
  tokenRaw: QTY,
  blockNumber: 63_014_999n,
  txHash: SWEEP_TX,
  logIndex: 7,
};

const sell = (tokens: bigint, proceeds: bigint): ClassEvent => ({
  kind: "sell",
  token: TOKEN,
  curve: CURVE,
  quoteRaw: proceeds,
  tokenRaw: tokens,
  blockNumber: 62_000_000n,
  txHash: "0xabc0000000000000000000000000000000000000000000000000000000000001" as `0x${string}`,
  logIndex: 1,
});

/** Reconcile a fold against a balance, with the tape and balances complete. */
const reconcile = (events: ClassEvent[], balance: bigint) =>
  reconcileClassBook({
    folded: foldClassEvents(events),
    balances: new Map([[TOKEN, balance]]),
    cached: [TOKEN],
    logComplete: true,
    balancesComplete: true,
  }).positions[0]!;

describe("the reconciler tells a sweep from a sale", () => {
  it("SHOGUN'S POSITION: swept, not closed, and with NO proceeds figure", () => {
    const p = reconcile([buy, sweep], 0n);

    assert.equal(p.state, "swept", "the owner took it home — that is not a liquidation");
    assert.equal(
      p.proceedsRaw,
      null,
      "zero proceeds is a claim about a sale, and there was no sale — this must be UNKNOWN, not 0",
    );
    assert.equal(p.sweptRaw, QTY, "the swept quantity survives the fold");
    assert.equal(p.sweptCostRaw, COST, "and it carries the cost that left with it");
    assert.equal(p.sweptTx, SWEEP_TX, "keyed on the sweep's own transaction, so it books once");
    assert.equal(p.sweptLogIndex, 7);
  });

  it("A REAL LIQUIDATION IS STILL `closed`, with real proceeds", () => {
    // The control. Sell the lot back through the curve for 6.000000 — a profit,
    // and a genuine result the book is entitled to report.
    const p = reconcile([buy, sell(QTY, 6_000_000n)], 0n);
    assert.equal(p.state, "closed");
    assert.equal(p.proceedsRaw, 6_000_000n, "a sale has proceeds");
    assert.equal(p.sweptCostRaw, null, "and nothing was withdrawn");
  });

  it("a still-held position is untouched by any of this", () => {
    const p = reconcile([buy], QTY);
    assert.equal(p.state, "open");
    assert.equal(p.sweptRaw, 0n);
    assert.equal(p.sweptCostRaw, null, "nothing swept, nothing to price");
  });

  it("PART SOLD AND PART SWEPT: the proceeds are real and the sweep is pro-rata", () => {
    // Half sold for 3.000000, half taken home. The book must report a result on
    // the half that traded and a withdrawal on the half that did not, and it
    // must not conflate them — which one number for both would.
    const half = QTY / 2n;
    const p = reconcile([buy, sell(half, 3_000_000n), sweep2(half)], 0n);

    assert.equal(p.state, "swept", "any sweep makes the exit an owner withdrawal");
    assert.equal(p.proceedsRaw, 3_000_000n, "the half that SOLD has real proceeds");
    assert.equal(p.sweptRaw, half);
    assert.equal(
      p.sweptCostRaw,
      (COST * half) / QTY,
      "the withdrawal is the share of the basis that left, measured in tokens",
    );
    // Floor division keeps the dust in the book rather than withdrawing capital
    // it cannot account for.
    assert.ok(p.sweptCostRaw! <= COST / 2n, "flooring can only ever understate what left");
  });

  it("AN UNKNOWN BASIS IS NOT A FREE WITHDRAWAL", () => {
    // Tokens in the vault the tape never explains, then swept. There is no cost
    // to withdraw, and inventing one would move the figure the performance fee
    // is measured against.
    const p = reconcile([sweep], 0n);
    assert.equal(p.state, "swept");
    assert.equal(p.costRaw, null, "no buy was seen, so the basis is unknown");
    assert.equal(p.sweptCostRaw, null, "and an unpriceable withdrawal is reported, never estimated");
  });

  it("the scout budget treats a swept position as gone, like a closed one", () => {
    const swept = reconcile([buy, sweep], 0n);
    const held = reconcile([buy], QTY);
    assert.equal(scoutCostOf([swept]).spentRaw, 0n, "it holds nothing and bounds nothing");
    assert.equal(scoutCostOf([held]).spentRaw, COST, "the control: a held position still counts");
    assert.deepEqual(scoutCostOf([swept]).unknown, [], "and it is not reported as unpriceable either");
  });
});

/** A second sweep event for a partial quantity. */
function sweep2(tokens: bigint): ClassEvent {
  return { ...sweep, tokenRaw: tokens };
}
