/**
 * THE CLASS EXECUTOR ARM, asserted as source.
 *
 * There is no seam through `processIntentLocked` — one long function with a live
 * executor, a database and a bundler — and the failures this arm can have are
 * precisely the ones that pass every type check and every unit test: a wire that
 * was never connected, a guard in the wrong order, a cached flag standing in for
 * a fresh read. Same idiom as curve-wiring.test.ts, and for the same reason.
 *
 * Each assertion below corresponds to a specific way the class route goes wrong
 * silently rather than loudly.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const RAW = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
/** Comments stripped, so a phrase in prose cannot satisfy an assertion. */
const CODE = RAW.replace(/\/\*[\s\S]*?\*\//g, " ")
  .split(/\r?\n/)
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
  .join("\n");

/** The class arm: from its dispatch condition to the adapter arm that follows. */
const ARM = (() => {
  const start = CODE.indexOf("grantPonsClassVault(active.grant) !== null &&");
  assert.ok(start > 0, "the class dispatch must exist");
  const end = CODE.indexOf(`} else if (intent.kind === "curve-trade") {`, start);
  assert.ok(end > start, "the adapter arm must still follow it");
  return CODE.slice(start, end);
})();

describe("the fork is on the target, from the grant", () => {
  it("dispatches on grantPonsClassVault, the same accessor the mirror uses", () => {
    // policy.ts decides "is this a class trade" from limits.ponsClassVault,
    // whose only source is this accessor. If the executor asked a different
    // question, a trade could be judged by one set of rules and routed by the
    // other.
    assert.match(ARM, /grantPonsClassVault\(active\.grant\)/);
    assert.match(ARM, /intent\.target\.toLowerCase\(\) === grantPonsClassVault/);
  });

  it("routes class trades AWAY from the adapter builder", () => {
    // buildCurveTradeCalls encodes tradeExactIn — six words, a different
    // selector, and it would match no permission the class grant carries.
    assert.ok(!/buildCurveTradeCalls/.test(ARM), "a class trade must not reach the adapter builder");
    assert.match(ARM, /buildClassBuyCalls|buildClassSellCalls/);
  });
});

describe("the side is derived, then confirmed", () => {
  it("reads the side from which leg is un-enumerated", () => {
    // The intent carries no `side`, and a class trade may leave exactly one leg
    // out of the grant — that leg is the class token.
    assert.match(ARM, /const isBuy = inEnum/);
  });

  it("refuses when both or neither leg is enumerated", () => {
    // Both means it should have gone to the adapter; neither means checkPolicy
    // should already have refused. A merrymen fault either way, and refused
    // rather than guessed.
    assert.match(ARM, /class-side-ambiguous/);
  });

  it("cross-checks a SELL against the launch record before building", () => {
    // `sell` carries no asset words — the vault derives both from the curve — so
    // the mirror judged legs that are not in the calldata. A mis-derived sell
    // would read a USDG figure as a count of class-token units.
    assert.match(ARM, /curveFor\(intent\.assetIn\)/);
    assert.match(ARM, /class-legs-unconfirmed/);
  });
});

describe("whether the vault exists is read fresh, and fails closed", () => {
  it("calls getCode inside the arm", () => {
    assert.match(ARM, /getCode\(\{ address: vault \}\)/);
  });

  it("does NOT consult the arm-time flag", () => {
    // A flag read at arm time goes stale the moment the first class buy of the
    // arm lands — and the direction it goes stale in is the dangerous one.
    assert.ok(
      !/classVaultDeployed/.test(ARM),
      "a cached deployment flag must never decide whether to prepend the deploy",
    );
  });

  it("an unreadable getCode SENDS NOTHING", () => {
    // The failure this prevents is a silent success: a CALL to a codeless
    // address returns empty success, so a buy against a vault that might not
    // exist would approve the USDG, no-op, and report `landed`.
    assert.match(ARM, /class-vault-unreadable/);
    const at = ARM.indexOf("class-vault-unreadable");
    const send = ARM.indexOf("exec = await send(");
    assert.ok(at < send, "the unreadable refusal must come before anything is sent");
  });

  it("a SELL never prepends a deploy", () => {
    // Nothing to sell, and creating an empty vault would not help — a different
    // remedy, so a different rule.
    assert.match(ARM, /class-sell-needs-vault/);
    assert.match(ARM, /deployed \|\| !isBuy \? \[\] : \[buildClassVaultDeployCall/);
  });

  it("an undeployed vault with no sealed factory is refused, not attempted", () => {
    assert.match(ARM, /no-class-vault/);
  });
});

describe("every refusal writes a row, then releases", () => {
  it("the shared helper writes the row", () => {
    const helper = ARM.slice(ARM.indexOf("const refuse ="), ARM.indexOf("const sellableNow"));
    assert.match(helper, /recordTrade\(\{/);
    assert.match(helper, /status: "rejected"/);
  });

  it("and every refusal releases the reservation WHERE THE ANALYSER CAN SEE IT", () => {
    // recordTrade releases on every path, so these calls are unreachable
    // bookkeeping — and they stay anyway. budget-reservation.invariant.test.ts
    // walks every `return` in this function, finds its enclosing block, and
    // demands a release it can read. A helper it cannot see through would pass
    // the exact leak that test was written for: an op pinned in inFlightOps for
    // the life of the arm, compounding once per tick.
    const refusals = [...ARM.matchAll(/await refuse\(/g)];
    assert.ok(refusals.length >= 5, `expected the arm's refusals, found ${refusals.length}`);
    for (const m of refusals) {
      const after = ARM.slice(m.index!, m.index! + 500);
      const release = after.indexOf("releaseBudget()");
      const ret = after.indexOf("return;");
      assert.ok(release > 0 && release < ret, "each refusal must release before it returns");
    }
  });

  it("carries the token legs so the row is joinable to a decision", () => {
    assert.match(ARM, /\.\.\.tokenLegs\(intent\)/);
  });
});

describe("the position is remembered, because the vault cannot be asked", () => {
  it("a buy writes a class_positions row", () => {
    // The contract has no enumeration — that is what "tokens the owner never
    // enumerated" means. This record IS the enumeration: for the custody read,
    // for the provenance union that keeps the exit reachable, and for recovery.
    assert.match(ARM, /upsertClassPosition\(agentId, \{/);
  });

  it("and stores the curve with it", () => {
    // discovered_pools is pruned to 5,000 rows; a position must outlive its
    // launch row or the mirror refuses its own exit.
    const write = ARM.slice(ARM.indexOf("upsertClassPosition"));
    assert.match(write, /curve: intent\.curve/);
  });

  it("a sell does not", () => {
    // The row is keyed by token and the balance read decides what is held, so a
    // sell needs no write — the position leaves the book when the chain says it
    // is gone, not when we think it should be.
    const write = ARM.slice(ARM.indexOf("if (isBuy) {"));
    assert.ok(write.indexOf("upsertClassPosition") > 0, "the write is inside the isBuy branch");
  });
});

describe("the arm stays where its idempotency argument holds", () => {
  it("is inside processIntentLocked", () => {
    // One fresh getCode suffices ONLY because processIntentLocked is serialized
    // by intentChain and `send` awaits the receipt inside that lock. Move this
    // arm out and the second intent of an arm reads before the first has
    // settled, and both prepend a deploy — the second reverting the whole batch.
    const lock = CODE.indexOf("async function processIntentLocked");
    const arm = CODE.indexOf("grantPonsClassVault(active.grant) !== null &&");
    assert.ok(lock > 0 && arm > lock, "the class arm must live inside the serialized path");
  });
});

/**
 * THE OPT-IN, which is a SEPARATE decision from the signature.
 *
 * Sealing a class vault at /grant says "this key could reach class tokens".
 * `classSnipeEnabled` says "go and do it". Keeping them apart is the same
 * invariant curveLegsNow was fixed to respect one level down — an owner's "know
 * about this" must never be read as "trade this" — and here the stakes are
 * higher, because the assets in question are ones nobody named at all.
 */
describe("three layers must hold before an agent reaches for a class token", () => {
  const PRODUCER = (() => {
    const start = CODE.indexOf("async function proposeClassEntries()");
    assert.ok(start > 0, "the class producer must exist");
    return CODE.slice(start, CODE.indexOf("function curveLegsNow()", start));
  })();

  it("the SETTINGS switch is checked, not just the signature", () => {
    // The assertion that stops "the wall allows it" being read as "the owner
    // asked for it".
    assert.match(PRODUCER, /if \(!cfg\.classSnipeEnabled\) return \[\]/);
  });

  it("a zero size proposes nothing", () => {
    // Two closed doors rather than one: enabling the route and forgetting the
    // size is a no-op; setting a size and forgetting the route is not.
    assert.match(PRODUCER, /cfg\.classPerEntryUsdg <= 0/);
  });

  it("the SIGNATURE is checked too, from the grant", () => {
    assert.match(PRODUCER, /grantPonsClassVault\(active\.grant\)/);
  });

  it("paper proposes nothing, and refuses rather than simulating", () => {
    // A simulated class fill needs a price for a token with no oracle and no
    // pool — necessarily the curve's own reserves, which curve-prices.ts says
    // are good enough to VALUE something held and not to AUTHORISE a buy.
    assert.match(PRODUCER, /if \(paperActive\(\)\) return \[\]/);
  });

  it("an unreadable position count proposes nothing", () => {
    // Null must not read as zero, or the position ceiling frees itself exactly
    // when the book is unknown.
    assert.match(PRODUCER, /if \(held === null\) return \[\]/);
  });

  it("candidates come from the factory-filtered launch feed and nowhere else", () => {
    // curve-provenance.invariant.test.ts pins that recordCandidate has exactly
    // one curve-writing producer and that it is the Pons launch scan. For a
    // class trade that provenance is the ONLY thing vouching for the output
    // token, so any other source breaks the rule checkPolicy rests on.
    assert.match(PRODUCER, /recentCandidates\(/);
    assert.ok(
      !/poolsOnly/.test(PRODUCER),
      "poolsOnly filters out exactly the curve rows this path needs",
    );
    for (const forbidden of ["cfg.customTokens", "watchTokens", "basketSymbols"]) {
      assert.ok(!PRODUCER.includes(forbidden), `${forbidden} must not select a class candidate`);
    }
  });

  it("sizes against the per-trade cap as well as the setting", () => {
    assert.match(PRODUCER, /active\.limits\.perTradeUsdg/);
  });

  it("checks impact and a slippage floor where the reserves are", () => {
    // In the producer, because that is where the reserves live — the executor
    // holds only an intent. Every existing curve producer does the same three
    // in the same order.
    assert.match(PRODUCER, /curveBuyImpactBps\(/);
    assert.match(PRODUCER, /curveMinOut\(/);
  });

  it("refuses a curve whose immediate round trip loses too much", () => {
    // The on-ramp check `no-exit` provides everywhere else. Here the key CAN
    // sell, so the question is whether selling would return anything.
    assert.match(PRODUCER, /curveSellOut\(/);
    assert.match(PRODUCER, /CLASS_MAX_ROUND_TRIP_BPS/);
  });

  it("proposes at most ONE entry per tick", () => {
    // The caps would bound a burst anyway; one proposal keeps the decision
    // legible instead of producing a wall of refusals from a batch that could
    // only ever have filled its first member.
    assert.match(PRODUCER, /const leg = legs\[0\]!/);
  });

  it("targets the sealed vault, so the executor's fork and the mirror agree", () => {
    assert.match(PRODUCER, /target: vault/);
  });
});

/**
 * PROVENANCE MUST BE A LIVE READ, NOT AN ARM-TIME SNAPSHOT.
 *
 * `curve-provenance` is the ONLY thing vouching for a class token — its output
 * leg is deliberately un-enumerated, so no wall and no allowlist names it. The
 * rule checks `limits.knownCurves`, and `limitsFromGrant` built that list at
 * ARM TIME and refreshed it only when strategy settings changed.
 *
 * So the one route whose entire purpose is trading a launch that did not exist
 * at signing could only ever have traded a launch that DID. On a hosted child
 * it was total rather than narrow: `discovered_pools` lives in the child's
 * ephemeral home, so the table is EMPTY when the agent arms, the snapshot was
 * empty, and every class buy was refused `curve-provenance` for ever.
 *
 * Observed on the live canary: the producer found candidates from the
 * factory-filtered scan, sized one, proposed it, and policy refused the very
 * curve the scan had written minutes earlier.
 */
describe("class provenance is re-read every tick", () => {
  const SRC = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const BLOCK = SRC.slice(SRC.indexOf("PROVENANCE IS RE-READ HERE, EVERY TICK"), SRC.indexOf("await proposeClassExits()"));

  it("refreshes before the producers run, not at arm time only", () => {
    assert.ok(BLOCK.length > 300, "the refresh moved — re-point this test, do not delete it");
    assert.match(BLOCK, /provenanceCurves\(await knownCurves\(\), await classPositionCurves\(active\.agentId\)\)/);
  });

  it("replaces the list WHOLE, never patches it", () => {
    // provenanceCurves returns undefined if either read failed, and undefined
    // means the rule cannot run — which for a class trade is a refusal. A
    // partial list would silently refuse exactly the positions it dropped,
    // including a position's own exit.
    assert.match(BLOCK, /if \(fresh\) active\.limits = \{ \.\.\.active\.limits, knownCurves: fresh \};/);
  });

  it("keeps the old list when the read fails, rather than emptying it", () => {
    // An empty list is not a safe default here: it refuses every class trade
    // including an exit. Keeping the previous answer is the conservative one.
    assert.doesNotMatch(BLOCK, /knownCurves: fresh \?\? \[\]/);
    assert.doesNotMatch(BLOCK, /knownCurves: \[\]/);
  });
});
