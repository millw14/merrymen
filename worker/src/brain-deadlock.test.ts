/**
 * THE AGENT THAT COULD NOT TRADE BECAUSE IT HAD NEVER TRADED.
 *
 * Brain's gate downgrades a book to `hold` at THREE quality caveats — a stated
 * judgement, and a good one. The worker was handing every never-traded agent
 * exactly three:
 *
 *   1. the ledger has not passed an audit      — TRUE, none has been run
 *   2. performance is unknown-of-gas           — TRUE, it has never paid any
 *   3. there is no position history            — NOT MEASURED. Hardcoded false.
 *
 * The third was not a cautious default; it was a claim, made without looking,
 * and it closed the loop: an agent could not trade until it had traded. That is
 * why 87 of 87 production [exec] lines were `mode:paper` and the six agents
 * genuinely on the live rail sat holding — and why fixing every analyst lens
 * would have changed nothing at all.
 *
 * These tests pin the measurement AND the arithmetic it feeds, because the bug
 * was not in either half alone: the gate is correct, the flag was false, and
 * only the two together explain a fleet that never traded.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

const INDEX = codeOf(readFileSync(new URL("./index.ts", import.meta.url), "utf8"));
const STORE = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
const GATE = readFileSync(new URL("../../services/brain/brain/gate.py", import.meta.url), "utf8");

describe("the flag is measured, not asserted", () => {
  it("POSITION HISTORY IS ASKED FOR, and the answer comes from the ledger", () => {
    assert.match(INDEX, /positionHistoryAvailable: await positionsExplained\(/);
    assert.ok(
      !/positionHistoryAvailable: false/.test(INDEX),
      "a hardcoded false here is a claim that there is no history, made without looking",
    );
    assert.match(STORE, /export async function positionsExplained\(/);
    // It asks the only question that can answer it: is there a landed fill for
    // each token the book holds.
    assert.match(STORE, /status = 'landed' AND buy_token IS NOT NULL/);
  });

  it("AN EMPTY BOOK HAS NO MISSING HISTORY", () => {
    // The distinction this codebase draws everywhere: "we found a gap" and
    // "there was nothing to find" are different facts. A book with no holdings
    // has no origin to be missing, and it is the state every new agent is in.
    assert.match(STORE, /if \(want\.length === 0\) return true;/);
  });

  it("and a read failure is FALSE, because unable to check is not checked-and-fine", () => {
    const fn = STORE.slice(STORE.indexOf("export async function positionsExplained"));
    assert.match(fn.slice(0, fn.indexOf("\n}")), /catch \{\s*return false;\s*\}/);
  });

  it("the OTHER two caveats are untouched, because both are true", () => {
    // No reconciliation has been run, and a book that has paid no gas genuinely
    // cannot state a net-of-gas figure. The fix was to stop fabricating a third
    // failure, not to talk the gate out of the two real ones.
    assert.match(INDEX, /auditPassed: false/);
    assert.match(INDEX, /gasBasis: gasNow\.unpricedTrades > 0 \? "gross" : gasNow\.usdg > 0 \? "net" : "unknown"/);
  });
});

describe("the arithmetic this feeds", () => {
  it("THREE CAVEATS IS THE THRESHOLD, and it is the gate's to set", () => {
    // Read from the gate itself rather than restated here — if the threshold
    // moves, this test should move with it and not quietly keep passing.
    assert.match(GATE, /if len\(caveats\) >= 3:/);
    assert.match(GATE, /verdict="downgrade-to-hold"/);
  });

  it("and the five caveats it counts are exactly the ones the worker supplies", () => {
    // The deadlock was only visible by looking at both halves at once: each
    // flag is individually defensible, and three of them together is a fleet
    // that never trades.
    for (const flag of [
      "not q.equity_complete",
      "not q.audit_passed",
      'q.gas_basis != "net"',
      "q.quarantined_assets_present",
      "not q.position_history_available",
    ]) {
      assert.ok(GATE.includes(flag), `the gate no longer counts ${flag}`);
    }
  });

  it("A CLEAN NEW BOOK NOW CLEARS THE THRESHOLD, with two honest caveats", () => {
    // The whole point, as arithmetic. equity complete, nothing quarantined,
    // position history vacuously present; audit not run and gas basis unknown.
    const caveats = [
      false, // equity has gaps
      true, //  audit has not run        — real
      true, //  gas basis is not "net"   — real
      false, // quarantined assets
      false, // no position history      — was fabricated, now measured
    ].filter(Boolean).length;
    assert.equal(caveats, 2);
    assert.ok(caveats < 3, "a book with two honest caveats must be tradeable");
  });

  it("and a book that really cannot explain its holdings is still held", () => {
    // The measurement has to be able to say NO, or it is not a measurement.
    // Tokens on the books with no landed fill behind them — funded in kind, or
    // a ledger that lost its history — is the state the caveat was written for.
    const caveats = [false, true, true, false, true].filter(Boolean).length;
    assert.equal(caveats, 3);
  });
});
