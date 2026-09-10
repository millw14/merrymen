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
