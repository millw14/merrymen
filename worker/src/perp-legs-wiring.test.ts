/**
 * WHERE THE ON-CHAIN PERP LEGS AND THE PAYOUT FOLD ARE WIRED IN main().
 *
 * perps/legs.test.ts runs the legs' pieces against a real ledger and
 * perps/payout-look.test.ts the payout step against flow inference; neither can
 * see main(), which a test cannot boot. So each fact about ORDER is pinned
 * here over index.ts with comments stripped, the energy-buy-wiring precedent —
 * each one the thing a plausible refactor would silently undo while every pure
 * test stayed green:
 *
 *   - a perp leg signed without its fence, or on a rail that is not live;
 *   - a deposit broadcast before its margin row exists, or landed without the
 *     margin row moving in the same db.tx;
 *   - the resolver or the orphan sweep booking a leg its receipt does not
 *     prove, or the sweep rewriting one of ours to `swap`;
 *   - a payout inferred as a deposit because the fold ran after the look, or a
 *     look inferring across a window whose payouts could not be read;
 *   - the payout cursor or the equity row losing the cash's block.
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
const CODE = codeOf(readFileSync(new URL("./index.ts", import.meta.url), "utf8"));

function body(name: string, kind: "async function" | "function" = "async function"): string {
  const at = CODE.indexOf(`  ${kind} ${name}(`);
  assert.ok(at > 0, `${name} must exist for this pin to mean anything`);
  const end = CODE.indexOf("\n  }\n", at);
  assert.ok(end > at);
  return CODE.slice(at, end);
}
function arrow(name: string): string {
  const at = CODE.indexOf(`  const ${name} = async (`);
  assert.ok(at > 0, `${name} must exist`);
  const end = CODE.indexOf("\n  };\n", at);
  assert.ok(end > at);
  return CODE.slice(at, end);
}
const inOrder = (hay: string, needles: string[]) => {
  let last = -1;
  for (const n of needles) {
    const at = hay.indexOf(n, last + 1);
    assert.ok(at > last, `missing or out of order: ${n}`);
    last = at;
  }
};

describe("processIntentLocked: the three legs ride the UserOp rail", () => {
  const locked = body("processIntentLocked");

  it("only a WITHDRAWAL (an L2 request) goes to the lane; deposit, claim and key go on to the EVM path", () => {
    inOrder(locked, [
      "const perpLeg = perpLegKind(intent);",
      'if (intent.kind === "perp-order" || (intent.kind === "perp-margin" && perpLeg === null)) {',
      "lastTradeOutcome = await perpLane.execute(intent, { equityUsdg, equityKnown }, state);",
      "const verdict = checkPolicy(intent, limits, state",
    ]);
    // The row's kind and target: the leg's own, the proxy's.
    assert.match(locked, /const rowKind: string = perpLeg \?\? intent\.kind;/);
    assert.match(locked, /intent\.kind === "perp-margin" \|\| intent\.kind === "perp-key"\s*\? LIGHTER_ROUTE_V1\.proxy/);
    assert.doesNotMatch(locked, /kind: intent\.kind,/, "every row this function writes carries rowKind");
  });

  it("a leg on a rail that is not live is refused with a row, BEFORE the refuse and paper arms", () => {
    assert.match(locked, /const execRail = perpLeg === "perp-claim" \? perpClaimExecMode\(execInputs\(\)\) : execMode\(\);/);
    const refuse = locked.indexOf('if (perpLeg !== null && execRail.mode !== "live") {');
    assert.ok(refuse > 0);
    assert.ok(refuse < locked.indexOf('if (execRail.mode === "refuse") {'));
    assert.ok(refuse < locked.indexOf('if (execRail.mode === "paper") {'));
    assert.match(locked.slice(refuse, refuse + 500), /status: "rejected",\s*reject_rule: execRail\.rule,\s*\}\);\s*return;/);
  });

  it("THE FENCE IS UNCONDITIONAL: calls built by perpLegCalls (builders + fence), refused with a row before anything is signed", () => {
    const at = locked.indexOf('} else if (intent.kind === "perp-margin" || intent.kind === "perp-key") {');
    assert.ok(at > 0 && at < locked.indexOf('} else if (intent.kind === "vault-withdraw") {'), "beside the vault deposit");
    const arm = locked.slice(at, locked.indexOf('} else if (intent.kind === "vault-withdraw") {'));
    inOrder(arm, [
      "grantPerp(active.grant)",
      'if (intent.kind === "perp-key") {',
      "await readLighterAccountIndex(chainClient,",
      "const built = perpLegCalls(intent, {",
      "if (!built.ok) {",
      "releaseBudget();",
      "await recordTrade({",
      "reject_rule: built.rule,",
      "return;",
      "exec = await send(built.calls);",
      "perpLegOfReceipt(exec.logs, executor.address, active.grant.chainId)",
      "perpLegMismatch(intent, perpLanded,",
      "throw new Error(",
    ]);
    assert.equal((arm.match(/await send\(/g) ?? []).length, 1, "one send, after the fence");
  });

  it("SUBMITTED BEFORE SEND: the pre-broadcast row and the deposit's margin row are one addTrade", () => {
    const hook = CODE.slice(CODE.indexOf("onSubmitted: async (userOpHash, op) => {"));
    assert.match(hook.slice(0, 700), /status: "submitted",[\s\S]*?\}, perpSubmittedWith\(userOpHash\)\);/);
    assert.match(locked, /const perpSubmittedWith = \(userOpHash: string\)[\s\S]{0,300}perpLegSubmittedTransfer\(intent, userOpHash\)[\s\S]{0,200}perpTransferWith\(\{ \.\.\.t, agentId, mode: "live" \}\)/);
  });

  it("LANDED: the margin row moves in the landed row's own transaction, and no platform fee is charged on a leg", () => {
    inOrder(locked, [
      "const perpLandedTransfer =",
      "perpLegLandedTransfer(perpLanded.leg, { userOpHash: exec.userOpHash, txHash, chainId: active.grant.chainId })",
      'status: "landed",',
      "perpLeg !== null || intent.kind === \"transfer\" || isEnergyIntent(intent)",
      "{ with: perpTransferWith({ ...perpLandedTransfer, agentId, mode: \"live\" }) }",
    ]);
  });
});

describe("perpetual return-home integration", () => {
  it("checks delayed payouts before spot market and strategy gates, while preserving claim authority", () => {
    const recover = body("recoverPerpPayout");
    inOrder(recover, ["grantPerp(a.grant)", "perpClaimExecMode(execInputs())", "await listSubmittedOps(a.agentId)",
      "await readLighterPendingAt(", "const amount = claimDue(", "active !== a", "await processIntentReporting(intent, 0n, false)"]);
    inOrder(body("tick"), ["await syncGrant()", "await recoverPerpPayout()", "await readMarketSafety()"]);
    inOrder(body("processIntentLocked"), ["row.kind === \"perp-claim\"", "const verdict = checkPolicy(", "perpClaimExecMode(execInputs())"]);
  });

  it("clears previous wallet venue facts before arming a new account", () => {
    const arm = body("syncGrant");
    inOrder(arm, ["if (perpAccountBinding !== nextPerpBinding)", "perpAccountIndex = null;", "perpTransit = null;",
      "perpVenueMicro = null;", "perpCashMicro = null;", "payoutCursor = null;", "foldedPayouts.clear();", "active = {", "await perpLane.armed()"]);
  });
});

describe("the stranded resolver and the orphan sweep: settled from the proxy's own event, or not at all", () => {
  it("the resolver's perp branch runs before the settlement is queued and the row written, and leaves the row submitted (continue) when unproven", () => {
    const r = arrow("resolveStrandedOps");
    inOrder(r, [
      "if (isPerpLegKind(row.kind)) {",
      "const res = perpLegResolution({",
      "if (!res.settle) {",
      "continue;",
      'if (row.kind === "perp-claim" && r.success) capitalBooked = false;',
      "perpWith = perpTransferWith({ ...res.transfer, agentId, mode: \"live\" })",
      "const explains = settlementDelta({ success: r.success, receiptUsdgDelta6: r.usdgDelta6, capitalBooked });",
      "const settledRow = await addTrade({",
      "perpWith === undefined ? undefined : { with: perpWith }",
    ]);
    // A leg whose margin row the ledger refused is said, and left counted.
    assert.match(r, /if \(!settledRow && perpWith !== undefined\) \{[\s\S]{0,400}continue;/);
  });

  it("the orphan sweep classifies a leg by its own logs before its safe default, and never rewrites one of ours to swap", () => {
    const sweep = arrow("reconcileInFlightAtArm");
    inOrder(sweep, [
      "const perpSubmitted = new Set(",
      "for (const o of orphans) {",
      "const perpOrphan = orphanChainId === null ? null : perpLegOrphan(o, smartAccount, orphanChainId);",
      "if (perpOrphan !== null) {",
      "target: LIGHTER_ROUTE_V1.proxy,",
      "{ with: perpTransferWith({ ...leg.transfer, agentId, mode: \"live\" }) }",
      "continue;",
      "if (perpSubmitted.has(o.userOpHash.toLowerCase())) {",
      "continue;",
      'kind: "swap",',
    ]);
  });
});

describe("Lighter payouts: folded between block-pinned reads, BEFORE the look", () => {
  it("the tick: the cash's block is kept, the payout step runs before the live perp term, and both the look and the equity row get the block", () => {
    const t = body("tick");
    assert.match(t, /cashReadBlock = bal\.cashReadBlock \?\? null;/);
    inOrder(t, [
      "payoutFold = await livePayoutStep(agentId, client, grant, cashReadBlock);",
      "const liveRead = await perpLane.refresh();",
      "const flows = await reconcileFlowsOrRetry(",
      "{ fold: payoutFold, block: cashReadBlock },",
    ]);
    assert.match(t, /\.\.\.\(!paper && cashReadBlock !== null \? \{ cashReadBlock \} : \{\}\),/);
    // A pending balance on the contract at the cash's block holds the ratchets (rule 12c).
    assert.match(t, /transitHeld =\s*pendingHeld \|\|/);
  });

  it("the steady look folds the payouts into its baseline, and an unread window holds", () => {
    const f = arrow("reconcileFlows");
    const steady = f.slice(f.lastIndexOf("const payoutsSince = payoutShift(payouts.fold, foldedPayouts);"));
    inOrder(steady, [
      "const l = lookAtCash({",
      "payoutShiftUsdg6: payoutsSince === null ? null : payoutsSince.shiftUsdg6,",
      "lastCashUsdg = l.baselineUsdg;",
      "for (const k of payoutsSince.keys) foldedPayouts.add(k);",
      "payoutCursor = payouts.block;",
      'if (l.verdict.action === "hold") {',
      'if (l.verdict.action === "infer") await record(',
    ]);
    // The look's end: the cursor is this reading's block.
    assert.match(f, /ledgerWritesAtSnapshot = ledgerWrites;[\s\S]{0,300}payoutCursor = payouts\.block;\s*return opsInFlight \? "held" : "settled";/);
  });

  it("the first look folds from the durable reading's (or the anchor's) block, and DOUBTS when it cannot", () => {
    const f = arrow("reconcileFlows");
    const first = f.slice(f.indexOf("} else if (lastCashUsdg === null) {"), f.lastIndexOf("const payoutsSince = payoutShift(payouts.fold, foldedPayouts);"));
    inOrder(first, [
      "if (opsInFlight) {",
      "const payoutsSince = payoutShift(payouts.fold, foldedPayouts);",
      "const settled = takeSettlements();",
      "const anchorShift = attributeSettlements(settled, anchorObservedAtSec);",
      "anchorShift.shiftUsdg6 += payoutsSince?.shiftUsdg6 ?? 0n;",
      "planFirstObservation({",
      'const payoutsUnread = payoutsSince === null && payouts.fold.kind === "unfoldable";',
      "doubtContributions(",
      'const payoutsDoubt = payoutsUnread && (plan.action === "resume-clean" || plan.action === "resume-with-drift") && anchorCashUsdg !== null;',
      "if (payoutsDoubt) await doubtUnreadPayouts();",
      "} else if (prior !== null && payoutsUnread) {",
      "await doubtUnreadPayouts();",
      "} else if (prior !== null) {",
      "payoutShiftUsdg6: payoutsSince?.shiftUsdg6 ?? 0n,",
    ]);
    // The cursor a first look folds from is the reading it judges against.
    const step = arrow("livePayoutStep");
    inOrder(step, [
      "if (lastCashUsdg !== null) cursor = payoutCursor;",
      'else if (accounting.openingBalanceLicence !== "self-hosted-local") cursor = anchorCashBlock;',
      "await lastKnownCashReadBlock(agentId);",
      "const step = await runPayoutStep({",
      "payoutCarry = step.carry;",
    ]);
    assert.match(CODE, /anchorCashBlock = l\.lastObservedCashBlock;/);
  });

  it("the gate is read on chain at arm, after the in-flight reconcile", () => {
    const at = CODE.indexOf("if (executor) await reconcileInFlightAtArm(agentId, client, grant.smartAccount as `0x${string}`);");
    assert.ok(at > 0);
    const after = CODE.slice(at, at + 900);
    assert.match(after, /perpAccountIndexStale = true;[\s\S]*await readLighterAccountIndex\(client,/);
  });
});
