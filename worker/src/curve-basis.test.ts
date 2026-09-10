/**
 * THE BONDING-CURVE VENUE NEVER BOOKED A COST BASIS.
 *
 * `receipt-basis.test.ts` fixed the quantity a SWAP books. This is the venue
 * next door, where the bug was one layer earlier and total: `fillPair` was
 * assigned in exactly one place — inside the Uniswap-quote branch — and every
 * downstream step is gated on it. `if (fillPair)` guards the receipt decode,
 * `liveFill` is only ever set in that same branch, and `bookFill` is called
 * only when `liveFill` is non-null. So for a curve trade the chain never
 * started: no receipt decode, no fallback, no `cost_basis` row, ever.
 *
 * What that costs is not an inaccuracy, it is a silence. The buy books nothing;
 * the sell then meets `prev.qtyRaw <= 0` in applyFill, which correctly refuses
 * to call unknown cost zero and returns `basisUnknown` with zero realized; the
 * row is written with `realized_pnl_usdg` NULL and `getRealizedPnlUsdg` excludes
 * it. A profitable round trip and a ruinous one produce the same figure, which
 * is no figure at all. And `stampFloorFor` is gated on `liveFill?.side === "buy"`
 * (index.ts), so the stop floor is never stamped either — both mechanical exits
 * are blind on every curve position.
 *
 * This predates the class route entirely and applies to the shipped Pons
 * adapter. The tests below run the REAL basis engine over a REAL curve receipt.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { applyFill, ZERO_BASIS } from "./basis";
import { fillFromDeltas, netTokenDeltas, type ReceiptLog } from "./fills";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ME = "0x00000000000000000000000000000000000000a1";
const ADAPTER = "0x00000000000000000000000000000000000000b2";
const CURVE = "0x00000000000000000000000000000000000000c3";
const USDG = "0x0000000000000000000000000000000000000dd0";
const PEPE = "0x0000000000000000000000000000000000000ee0";

const topic = (a: string) => `0x${"0".repeat(24)}${a.slice(2)}`;
const hex = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
const transfer = (token: string, from: string, to: string, value: bigint): ReceiptLog => ({
  address: token,
  topics: [TRANSFER, topic(from), topic(to)],
  data: hex(value),
});

const ONE = 10n ** 18n;
const usdg = (v: number) => BigInt(Math.round(v * 1e6));

const SPEND = usdg(25);
const BOUGHT = 400n * ONE;
const PROCEEDS = usdg(31);

/**
 * A real PonsSelfTrade round trip. The adapter pulls the input from the account
 * by transferFrom, spends it on the curve, and pays the output to msg.sender —
 * so BOTH legs touch the account and the account-scoped delta filter sees them.
 * That is what makes this venue bookable today with no other change.
 */
const buyReceipt = [
  transfer(USDG, ME, ADAPTER, SPEND),
  transfer(USDG, ADAPTER, CURVE, SPEND),
  transfer(PEPE, CURVE, ADAPTER, BOUGHT),
  transfer(PEPE, ADAPTER, ME, BOUGHT),
];
const sellReceipt = [
  transfer(PEPE, ME, ADAPTER, BOUGHT),
  transfer(PEPE, ADAPTER, CURVE, BOUGHT),
  transfer(USDG, CURVE, ADAPTER, PROCEEDS),
  transfer(USDG, ADAPTER, ME, PROCEEDS),
];

describe("a curve receipt is readable — the decode was never the problem", () => {
  it("nets both legs of a buy through the adapter", () => {
    // The adapter's own paired legs cancel; only what the ACCOUNT gained or lost
    // survives. This has always worked — it was simply never called.
    const deltas = netTokenDeltas(buyReceipt, ME);
    assert.equal(deltas.get(USDG.toLowerCase()), -SPEND);
    assert.equal(deltas.get(PEPE.toLowerCase()), BOUGHT);

    const fill = fillFromDeltas({ deltas, usdgToken: USDG, stockToken: PEPE, symbol: "PEPE" });
    assert.deepEqual(
      { side: fill?.side, qtyRaw: fill?.qtyRaw, cashUsdg: fill?.cashUsdg },
      { side: "buy", qtyRaw: BOUGHT, cashUsdg: SPEND },
    );
  });

  it("nets both legs of a sell", () => {
    const deltas = netTokenDeltas(sellReceipt, ME);
    const fill = fillFromDeltas({ deltas, usdgToken: USDG, stockToken: PEPE, symbol: "PEPE" });
    assert.deepEqual(
      { side: fill?.side, qtyRaw: fill?.qtyRaw, cashUsdg: fill?.cashUsdg },
      { side: "sell", qtyRaw: BOUGHT, cashUsdg: PROCEEDS },
    );
  });
});

describe("THE BUG: with no basis booked on the buy, the round trip reports nothing", () => {
  it("a sell against an unbooked position books NULL, not a loss and not a gain", () => {
    // This is what every curve round trip did. The buy wrote no basis, so the
    // sell starts from ZERO_BASIS.
    const exit = applyFill(ZERO_BASIS, { side: "sell", qtyRaw: BOUGHT, cashUsdg: PROCEEDS });
    assert.equal(exit.basisUnknown, true);
    assert.equal(exit.realizedUsdg, 0n);
    // applyFill is RIGHT to refuse — unknown cost is not zero cost, and booking
    // the proceeds as pure profit would report a loss as a gain. The defect is
    // upstream: nothing ever gave it a basis to work from.
  });

  it("and it reports the same nothing whether the trade doubled or halved the money", () => {
    const won = applyFill(ZERO_BASIS, { side: "sell", qtyRaw: BOUGHT, cashUsdg: usdg(50) });
    const lost = applyFill(ZERO_BASIS, { side: "sell", qtyRaw: BOUGHT, cashUsdg: usdg(1) });
    assert.deepEqual(
      { won: won.realizedUsdg, lost: lost.realizedUsdg },
      { won: 0n, lost: 0n },
      "a metric that cannot distinguish a win from a wipeout is not a metric",
    );
    assert.equal(won.basisUnknown, true);
    assert.equal(lost.basisUnknown, true);
  });
});

describe("THE FIX: booking the buy makes the exit report a real figure", () => {
  it("a curve round trip books realized P&L", () => {
    const deltas = netTokenDeltas(buyReceipt, ME);
    const measured = fillFromDeltas({ deltas, usdgToken: USDG, stockToken: PEPE, symbol: "PEPE" })!;
    const afterBuy = applyFill(ZERO_BASIS, {
      side: "buy",
      qtyRaw: measured.qtyRaw,
      cashUsdg: measured.cashUsdg,
    });
    assert.equal(afterBuy.basis.qtyRaw, BOUGHT);
    assert.equal(afterBuy.basis.costUsdg, SPEND);

    const exitDeltas = netTokenDeltas(sellReceipt, ME);
    const exitFill = fillFromDeltas({
      deltas: exitDeltas,
      usdgToken: USDG,
      stockToken: PEPE,
      symbol: "PEPE",
    })!;
    const exit = applyFill(afterBuy.basis, {
      side: "sell",
      qtyRaw: exitFill.qtyRaw,
      cashUsdg: exitFill.cashUsdg,
    });

    assert.equal(exit.basisUnknown, false, "the basis is known — it was booked on the buy");
    assert.equal(exit.realizedUsdg, PROCEEDS - SPEND);
    assert.equal(exit.basis.qtyRaw, 0n, "a full exit leaves nothing stranded");
    assert.equal(exit.basis.costUsdg, 0n);
  });

  it("and a losing round trip reports the loss", () => {
    const afterBuy = applyFill(ZERO_BASIS, { side: "buy", qtyRaw: BOUGHT, cashUsdg: SPEND });
    const exit = applyFill(afterBuy.basis, { side: "sell", qtyRaw: BOUGHT, cashUsdg: usdg(4) });
    assert.equal(exit.realizedUsdg, usdg(4) - SPEND);
    assert.ok(exit.realizedUsdg < 0n, "the sign has to survive — this is the whole point");
  });
});

/**
 * The call site, asserted as source. There is no seam through
 * `processIntentLocked` — it is one long function with a live executor, a
 * database and a bundler — and the failure was precisely that a wire was never
 * connected, which every type-level and unit-level test passes through. Same
 * lesson, and the same idiom, as curve-wiring.test.ts.
 */
describe("the curve arm actually attributes the fill", () => {
  const CODE = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

  /** The executor's curve-trade arm, from its dispatch to the next kind. */
  const ARM = (() => {
    const start = CODE.indexOf(`} else if (intent.kind === "curve-trade") {`);
    assert.ok(start > 0, "the curve-trade executor arm must exist");
    return CODE.slice(start, CODE.indexOf("buildCurveTradeCalls({", start));
  })();

  it("sets fillPair, which every downstream booking step is gated on", () => {
    // THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL BUG.
    assert.match(ARM, /fillPair = \{/, "the curve arm must attribute its fill");
  });

  it("sets the fallback liveFill too, for when the receipt cannot be parsed", () => {
    assert.match(ARM, /liveFill = \{/);
  });

  it("books cash from notionalUsdg, not from a leg amount", () => {
    // The producer computed the USDG-equivalent size; re-deriving it here from
    // an 18dp leg is the 10^12 error the swap branch refuses by name.
    assert.match(ARM, /cashUsdg = intent\.notionalUsdg/);
  });

  it("refuses to book a curve trade with no USDG leg rather than booking nonsense", () => {
    assert.match(ARM, /no USDG leg/);
  });

  it("passes NO quote for slippage — the floor must not be scored as the quote", () => {
    // `minAmountOutRaw` is the quote already cut by the owner's slippage
    // tolerance. Scoring the fill against it would report perfect execution on
    // every trade, and a metric that cannot fail is worse than an absent one.
    assert.match(ARM, /quotedOut: null/);
    assert.ok(
      !/quotedOut: intent\.minAmountOutRaw/.test(ARM),
      "the floor must never stand in for the quote",
    );
  });
});
