/**
 * THE AGENT COULD EXIT ITS LOSERS AND NOT ITS WINNERS.
 *
 * A trencher entry is 5 USDG against a 10 USDG per-trade cap. Hit the -35% stop
 * and the exit is worth ~3.25, passes the cap, and sells. Hit the +100%
 * take-profit and it is worth ~10.0x, is refused with `per-trade-cap`, and is
 * refused again every tick forever — so the one outcome the strategy exists to
 * capture was the one it could not act on. The exact inverse of "if it is happy
 * with its profit it sells", and it presented as a stuck position rather than as
 * an error.
 *
 * WHY THE FIX IS A MIRROR REPAIR AND NOT A LOOSENED RAIL, which is the only
 * question that matters here:
 *
 *   wall.ts caps the USDG approve — the leg that FUNDS A BUY — at perTradeUsdg.
 *   wall.ts emits the sell-side approve with `null` as its amount argument,
 *   under the comment "No amount condition".
 *
 * So the chain never bounded the size of a sell, and policy.ts was bounding it
 * anyway. policy.ts's own contract says a stricter mirror "rejects trades the
 * chain would happily allow (a real bug per this file's contract)".
 *
 * These tests read BOTH files, because the claim is about the relationship
 * between them: if the wall ever starts sizing a sell, the exemption becomes
 * wrong and this must fail.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const WALL = readFileSync(new URL("../../packages/core/src/wall.ts", import.meta.url), "utf8");
const POLICY = readFileSync(new URL("./policy.ts", import.meta.url), "utf8");

describe("what the chain actually sizes", () => {
  it("THE BUY LEG IS CAPPED — the USDG approve carries a limit", () => {
    const usdgApprove = WALL.slice(WALL.indexOf("target: CASH.USDG as Address"), WALL.indexOf("approve the TRADEABLE stock tokens"));
    assert.match(usdgApprove, /LESS_THAN_OR_EQUAL, value: usdgUnits\(caps\.perTradeUsdg\)/);
  });

  it("AND THE SELL LEG IS NOT — the token approve carries no amount condition", () => {
    // This is the fact the exemption rests on. If it ever changes, the
    // exemption is wrong and this test is how you find out.
    const sellApprove = WALL.slice(WALL.indexOf("approve the TRADEABLE stock tokens"), WALL.indexOf("Owner-added tokens, same shape"));
    assert.match(sellApprove, /No amount condition/);
    assert.match(sellApprove, /args: \[\{ condition: ParamCondition\.ONE_OF, value: spenders \}, null\]/);
  });

  it("and a TRANSFER genuinely is capped, which is why it stays capped here", () => {
    const transfer = WALL.slice(WALL.indexOf('functionName: "transfer"'));
    assert.match(transfer.slice(0, 400), /LESS_THAN_OR_EQUAL, value: usdgUnits\(caps\.perTradeUsdg\)/);
  });
});

describe("the exemption is exactly as wide as that fact", () => {
  it("A SELL INTO CASH AND A CURVE TRADE OUT ARE EXEMPT", () => {
    const pred = POLICY.slice(POLICY.indexOf("const isUnsizedExit ="), POLICY.indexOf("A RATE LIMIT MUST NOT BECOME"));
    assert.match(pred, /intent\.kind === "swap"/);
    assert.match(pred, /lc\(intent\.buyToken\) === lc\(limits\.cashToken\)/);
    assert.match(pred, /intent\.kind === "curve-trade"/);
  });

  it("AND NOTHING ELSE IS — not a transfer, not an equity order, not a buy", () => {
    // Deliberately narrower than the drawdown breaker's `isExit`, which rightly
    // treats a transfer as money coming home. The chain sizes a transfer, so
    // this must not exempt one; equity-order has no wall permission at all.
    const pred = POLICY.slice(POLICY.indexOf("const isUnsizedExit ="), POLICY.indexOf("A RATE LIMIT MUST NOT BECOME"));
    assert.ok(!/"transfer"/.test(pred), "the chain caps a transfer, so this must not exempt one");
    assert.ok(!/"equity-order"/.test(pred), "equity-order carries no wall permission to mirror");
    assert.ok(!/vault-deposit/.test(pred), "a deposit is not an exit");
  });

  it("and the BUY cap is untouched", () => {
    // The whole point. The cap that is real, on chain, and bounds what an agent
    // may spend stays exactly where it was.
    assert.match(POLICY, /if \(!isUnsizedExit && notional > perOpCap\)/);
    assert.match(POLICY, /rule: isDeposit \? "deposit-cap" : "per-trade-cap"/);
  });
});

describe("the two other brakes that were locking the doors", () => {
  it("THE DAY'S BUDGET BOUNDS SPENDING, and a sell spends nothing", () => {
    // An agent that used its budget entering could not leave until the day
    // rolled — on shipped defaults that is two ticks.
    assert.match(POLICY, /if \(!isUnsizedExit && state\.spentTodayUsdg \+ notional > limits\.dailyUsdg\)/);
  });

  it("and the ops cap is a brake on risk, not a lock on the doors", () => {
    // Purely off-chain: the rate-limit policy contract has no bytecode on 4663
    // and was removed from the wall for exactly that reason.
    assert.match(POLICY, /if \(!isUnsizedExit && state\.opsToday >= limits\.maxOpsPerDay\)/);
  });

  it("and the drawdown breaker's own wider exemption is still there", () => {
    // Two predicates, deliberately different widths, for two different
    // questions. The breaker asks "is money coming home"; this file's new one
    // asks "does the chain size this call".
    assert.match(POLICY, /const isExit =/);
    assert.match(POLICY, /rule: "drawdown-breaker"/);
    assert.ok(POLICY.indexOf("const isUnsizedExit =") < POLICY.indexOf("const isExit ="));
  });
});
