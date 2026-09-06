import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { TRADEABLE_CHAIN_ID } from "./preflight";
import { execModeOf, canTradeForReal, type ExecInputs, type ExecMode } from "./exec-mode";

/**
 * PAPER IS A CAPABILITY, and this is the function that decides it.
 *
 * The predecessor of this file modelled the rule and pinned the SOURCE against
 * the model with four regexes. That was the right instinct and it still missed
 * the bug, because it pinned where the rule was DEFINED and the bug was where
 * the rule was USED: the execution fork asked `!executor` — a fifth question
 * nobody had noticed was a separate question at all — and hosted, where the
 * house bundler key is always injected, it answered "live" for a fleet the tick
 * had already decided was paper.
 *
 * So the rule now lives in a real function and these tests call it. The source
 * pin at the bottom pins the CALL SITES, which is the half that was missing.
 */

const base: ExecInputs = {
  armed: true,
  executor: true,
  chainId: TRADEABLE_CHAIN_ID,
  cashUsdg: 100_000_000n,
  deadPolicy: false,
  paperTradingEnabled: true,
};

/** What every caller in index.ts derives. */
const isPaper = (a: ExecInputs) => execModeOf(a).mode === "paper";

test("THE REGRESSION THAT MATTERED: a funded mainnet agent trades for real", () => {
  // paperTradingEnabled defaults to TRUE. Reading it as a mode selector rather
  // than as permission would put every funded agent in the fleet into
  // simulation while its owner believed it was trading — the single worst
  // outcome available here, and an easy mistake to make while fixing the other
  // direction. First in the file because it is the one that must never break.
  assert.deepEqual(execModeOf(base), { mode: "live" });
  assert.equal(isPaper(base), false);
});

test("a testnet grant is paper, whatever the bundler key says", () => {
  assert.equal(isPaper({ ...base, chainId: 46630 }), true);
  assert.equal(
    isPaper({ ...base, chainId: 46630, executor: true }),
    true,
    "an executor does not make a dead chain tradeable",
  );
});

test("no signer is still paper — the original case, unbroken", () => {
  assert.equal(isPaper({ ...base, executor: false }), true);
});

test("an account read as empty is paper, because a swap needs something to sell", () => {
  assert.equal(isPaper({ ...base, cashUsdg: 0n }), true);
});

test("UNKNOWN IS NOT UNFUNDED", () => {
  // lastCashUsdg is null until the first balance read of the process. If null
  // counted as broke, every worker would spend its first tick simulating — and
  // worse, a funded agent whose balance read failed would quietly start writing
  // pretend fills. Only a READ zero counts.
  assert.equal(isPaper({ ...base, cashUsdg: null }), false);
});

test("paperTradingEnabled is permission to simulate, not a request to", () => {
  assert.equal(isPaper({ ...base, chainId: 46630, paperTradingEnabled: false }), false);
  assert.equal(isPaper({ ...base, executor: false, paperTradingEnabled: false }), false);
  assert.equal(isPaper({ ...base, paperTradingEnabled: false }), false);
});

test("nothing is paper when nothing is armed", () => {
  assert.equal(isPaper({ ...base, armed: false }), false);
  assert.equal(isPaper({ ...base, armed: false, executor: false }), false);
});

/**
 * THE HOLE THE OLD TESTS LEFT OPEN.
 *
 * They asserted such an agent was not PAPER. They never asserted it did not
 * TRADE — and it did: with paper trading off, the fork's `!executor` was false,
 * so a wrong-chain or empty account fell straight through to the live rail and
 * built a swap against a dead chain. "Not simulating" was silently read as
 * "fine to execute".
 */
test("paper OFF refuses — it does not fall through to the live rail", () => {
  assert.deepEqual(execModeOf({ ...base, executor: false, paperTradingEnabled: false }), {
    mode: "refuse",
    rule: "no-executor",
  });
  assert.deepEqual(execModeOf({ ...base, chainId: 46630, paperTradingEnabled: false }), {
    mode: "refuse",
    rule: "wrong-chain",
  });
  assert.deepEqual(execModeOf({ ...base, cashUsdg: 0n, paperTradingEnabled: false }), {
    mode: "refuse",
    rule: "no-cash",
  });
  assert.deepEqual(execModeOf({ ...base, armed: false }), { mode: "refuse", rule: "not-armed" });
  // Named ahead of no-executor, no-cash and wrong-chain, because it is the only
  // one of the five that funding, a bundler key and a chain switch all fail to
  // fix. A signature is frozen; only re-signing clears it.
  assert.deepEqual(execModeOf({ ...base, deadPolicy: true, paperTradingEnabled: false }), {
    mode: "refuse",
    rule: "dead-policy",
  });
  assert.deepEqual(
    execModeOf({ ...base, deadPolicy: true, executor: false, paperTradingEnabled: false }),
    { mode: "refuse", rule: "dead-policy" },
  );
});

test("the refusal names the most fundamental broken leg first", () => {
  // A missing signer cannot be fixed by funding, and a dead chain cannot be
  // fixed by either. Telling an owner to deposit when the grant is on the wrong
  // chain sends them to do work that will not help.
  assert.deepEqual(
    execModeOf({ ...base, executor: false, chainId: 46630, cashUsdg: 0n, paperTradingEnabled: false }),
    { mode: "refuse", rule: "no-executor" },
  );
  assert.deepEqual(execModeOf({ ...base, chainId: 46630, cashUsdg: 0n, paperTradingEnabled: false }), {
    mode: "refuse",
    rule: "wrong-chain",
  });
});

test("every input lands in exactly one mode — there is no fourth state", () => {
  // The old fork HAD a fourth state (fall through to live) and nothing noticed,
  // because no test enumerated the space. This one does.
  const modes = new Set<ExecMode["mode"]>();
  for (const armed of [true, false]) {
    for (const executor of [true, false]) {
      for (const chainId of [TRADEABLE_CHAIN_ID, 46630]) {
        for (const cashUsdg of [100_000_000n, 0n, null]) {
          for (const deadPolicy of [false, true]) {
            for (const paperTradingEnabled of [true, false]) {
              const a: ExecInputs = {
                armed,
                executor,
                chainId,
                cashUsdg,
                deadPolicy,
                paperTradingEnabled,
              };
              const m = execModeOf(a);
              assert.ok(
                m.mode === "paper" || m.mode === "live" || m.mode === "refuse",
                "unreachable mode",
              );
              // live and canTradeForReal are the same claim; if they ever part,
              // the fork's executor invariant becomes reachable at runtime.
              assert.equal(m.mode === "live", canTradeForReal(a));
              // A DEAD POLICY IS NEVER LIVE, whatever else is true. This is the
              // whole point of the field: the grant that carries it arms, prices
              // and looks healthy, and every operation it signs fails validation
              // against an address with no code.
              if (deadPolicy) assert.notEqual(m.mode, "live", "a dead policy cannot trade");
              modes.add(m.mode);
            }
          }
        }
      }
    }
  }
  assert.deepEqual([...modes].sort(), ["live", "paper", "refuse"], "all three modes are reachable");
});

test("THE FORK AND THE TICK ASK THE SAME FUNCTION", () => {
  // The half the old source pins missed. They asserted the DEFINITION of
  // paperActive; the bug was a second, different definition at the use site.
  const src = readFileSync("worker/src/index.ts", "utf8");

  assert.match(src, /const paperActive = \(\) => execMode\(\)\.mode === "paper";/);
  assert.match(src, /const execRail = execMode\(\);/, "the fork resolves the mode");
});

test("a paper tick never publishes its fabricated ETH balance", () => {
  // balances.ethWei is hardcoded to 0n on the paper branch. Copying that into
  // lastGasWei published a fabricated zero as the account's real balance, and
  // the gas pre-flight refuses on exactly that value — so every paper intent
  // died on `no-gas` for ETH it did not need and was never asked to hold.
  //
  // Still true, and now stated as the property rather than as one line of
  // source: the paper arm must not read `balances` at all, because on that
  // rail `balances` IS the simulated book.
  const src = readFileSync("worker/src/index.ts", "utf8");
  assert.match(src, /if \(!paper\) \{[^}]*lastGasWei = balances\.ethWei;/);
  const paperArm = src.slice(src.indexOf("} else if (active && Date.now() - lastRealGasReadAt"));
  const armEnd = paperArm.indexOf("\n    }");
  assert.ok(armEnd > 0, "the paper arm must be findable");
  assert.doesNotMatch(
    paperArm.slice(0, armEnd),
    /balances\./,
    "the paper arm must never take a number from the simulated book",
  );
});

test("BUT IT KEEPS WATCHING THE REAL ACCOUNT, or it can never come back", () => {
  // Live-only made this a latch. `lastGasWei` is the rail's only view of the
  // account's gas, so a simulating agent stopped observing its own ETH and
  // could not notice the owner topping it up. Harmless while gas is not a leg
  // of canTradeForReal; the moment it is, the agent loses its way back to the
  // live rail until the process restarts.
  const src = readFileSync("worker/src/index.ts", "utf8");
  assert.match(src, /lastRealGasReadAt/, "the paper rail must re-read on its own clock");
  assert.match(src, /getBalance\(\{ address: active\.grant\.smartAccount/, "and it must read the CHAIN, not the book");
  // A refused read is not a zero balance.
  const arm = src.slice(src.indexOf("lastRealGasReadAt > REAL_GAS_READ_EVERY_MS"));
  assert.doesNotMatch(arm.slice(0, 600), /lastGasWei = 0n/, "a failed read must not become a zero");
});

test("a curve trade with no adapter leaves a row, not just an event", () => {
  // Otherwise the decision has no trade to join and the public feed says "no
  // trade came of it" — true, and silent about the one fact that explains it.
  const src = readFileSync("worker/src/index.ts", "utf8");
  assert.match(src, /reject_rule: "no-curve-adapter"/);
});
