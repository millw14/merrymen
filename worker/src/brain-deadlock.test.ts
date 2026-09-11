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

  it("the other two caveats are now ENCODED honestly — one real, one that never was", () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and the reason is worth keeping.
    //
    // It read: "No reconciliation has been run, and a book that has paid no gas
    // genuinely cannot state a net-of-gas figure. The fix was to stop
    // fabricating a third failure, not to talk the gate out of the two real
    // ones." The first clause was right. The second was wrong, and looking
    // again at WHY the fleet still never traded is what found it.
    //
    // An audit that has not run is real — but `false` does not say that. It
    // says the ledger was recomputed and did not match, which was a claim made
    // about every agent without recomputing anything. Null says the true thing,
    // and gate.py still charges a caveat for it.
    //
    // The gas caveat was not real at all. Gas here is SPONSORED: the paymaster
    // settles with the EntryPoint and the account never handles ETH, so its
    // trading gas costs the owner exactly zero — and zero subtracted is
    // subtracted correctly. "Performance is unknown-of-gas, trading costs are
    // not subtracted" was false of every sponsored book in the fleet.
    //
    // So the margin was never two honest caveats. It was one honest caveat and
    // one mis-encoding, and the fleet sat one real problem from a forced hold.
    // The threshold is untouched; a caveat now has to be earned.
    assert.ok(!/auditPassed: false/.test(INDEX), "the hardcoded false is a claim, not a default");
    assert.match(INDEX, /auditPassed: null/);
    assert.match(INDEX, /gasBasis: gasBasisOf\(gasNow\)/);
    assert.ok(
      !/gasNow\.usdg > 0 \? "net"/.test(INDEX),
      "deriving basis from whether the number is non-zero is the bug; it must key on whether it was READ",
    );
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

  it("A CLEAN SPONSORED BOOK NOW CLEARS THE THRESHOLD WITH ROOM, on one honest caveat", () => {
    // The whole point, as arithmetic — and the count is now 1, not 2, because
    // the gas caveat was never true of a sponsored book. See the correction
    // above. The threshold did not move; the inputs stopped lying.
    const caveats = [
      false, // equity has gaps
      true, //  audit has not run        — real, and now SAID as "not run"
      false, // gas basis is not "net"   — was a mis-encoded measured zero
      false, // quarantined assets
      false, // no position history      — fabricated once, now measured
    ].filter(Boolean).length;
    assert.equal(caveats, 1);
    assert.ok(caveats < 3, "a clean sponsored book must be tradeable");
    // TWO REAL PROBLEMS ARE STILL SURVIVABLE, THREE ARE STILL NOT. This is the
    // margin the correction bought: two, where it used to be one.
    assert.ok(caveats + 1 < 3, "one more real problem must still leave it sizeable");
    assert.ok(caveats + 2 >= 3, "two more real problems must still force a hold");
  });

  it("and a book that really cannot explain its holdings is still held", () => {
    // The measurement has to be able to say NO, or it is not a measurement.
    // Tokens on the books with no landed fill behind them — funded in kind, or
    // a ledger that lost its history — is the state the caveat was written for.
    const caveats = [false, true, true, false, true].filter(Boolean).length;
    assert.equal(caveats, 3);
  });
});

describe("Brain can tell a winner from a loser", () => {
  it("THE SNAPSHOT CARRIES WHAT EACH POSITION COST", () => {
    // This was a hard-coded `costBasisUsdg: null`, so the reasoner could see a
    // position is worth 8 USDG and had no way to know whether that was up 300%
    // or down 60%. "Should I take this profit" and "should I cut this loss"
    // were questions it was being asked while unable to answer either.
    assert.match(INDEX, /costBasisUsdg: \(\(\) => \{/);
    assert.match(INDEX, /const c = basisBySymbol\.get\(pp\.symbol\);/);
    assert.ok(!/costBasisUsdg: null,/.test(INDEX), "the hard-coded null is gone");
  });

  it("AND NULL STAYS NULL when the ledger has no basis", () => {
    // The snapshot type allows null and core refuses on it, which is the honest
    // answer for a position whose origin is genuinely unknown. Zero would say
    // it was free — the accounting bug in miniature, handed to a reasoner.
    assert.match(INDEX, /return c === null \|\| c === undefined \? null : Number\(c\);/);
  });

  it("and the basis is read BEFORE the brain, not after it", () => {
    // A temporal-dead-zone bug rather than a type error: `basisBySymbol` is a
    // const in the same function scope, so referencing it from a block that
    // runs earlier compiles cleanly and throws at runtime.
    const read = INDEX.indexOf("const basisBySymbol = new Map<string, bigint | null>()");
    const brain = INDEX.indexOf("if (shadowBrainEnabledFor(agentId)");
    assert.ok(read > 0 && brain > 0, "both must exist");
    assert.ok(read < brain, "the basis must be built before its first consumer");
  });
});
