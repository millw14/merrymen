/**
 * WHERE THE TICK ASKS ABOUT ENERGY — AND WHERE IT MUST NEVER ASK.
 *
 * The throttle itself is pure and runs in energy.test.ts; main() cannot be
 * booted by a test. What can go wrong in main() is WIRING: a guard dropped, a
 * claim moved after the decision it was meant to precede, an exit sent through
 * the entry filter, or the owner's own order path learning that energy exists.
 * Each of those would leave every pure test green, so each is pinned here over
 * index.ts with comments stripped — prose about energy is not energy.
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

/** A function declared in main() — two-space indent — up to its closing brace. */
function body(name: string): string {
  const at = CODE.indexOf(`  async function ${name}(`);
  assert.ok(at > 0, `${name} must exist for this pin to mean anything`);
  const end = CODE.indexOf("\n  }\n", at);
  assert.ok(end > at);
  return CODE.slice(at, end);
}

describe("the forks that start NEW autonomous work ask", () => {
  it("THE BRAIN WAKE GUARD is closed while today's reviews are paced or spent", () => {
    assert.match(
      CODE,
      /cfg\.brainUrl && cfg\.brainToken && !bookIncomplete && plan\.brain && energyNow\.reviews\.open\) \{/,
    );
  });

  it("BOTH runShadow calls claim the review between the trigger and the paid call", () => {
    const trench = CODE.indexOf("return runShadow(brainConfig, inputs,");
    const regular = CODE.indexOf(": await runShadow(", trench);
    assert.ok(trench > 0 && regular > trench);
    assert.match(CODE.slice(trench, trench + 1200), /admit: claimReview,/);
    assert.match(CODE.slice(regular, regular + 600), /admit: claimReview \}/);
  });

  it("the strategist's paid window is claimed the same way", () => {
    const llm = CODE.slice(CODE.indexOf("llm: {\n        creds: resolveLlm(c),"));
    assert.match(llm.slice(0, 400), /claimWindow: claimReview,/);
  });

  it("A BRAIN BUY IS CLAIMED BEFORE '[brain] acting', and handed back if no trade came of it", () => {
    const claim = CODE.indexOf('const energyClaim = want.ok && want.order.side === "buy" ? await claimEntry() : null;');
    const acting = CODE.indexOf("[brain] acting");
    const submit = CODE.indexOf("await submitChatTrade(o.side, o.symbol, o.usdgAmount, {", acting);
    const refund = CODE.indexOf("if (!brainOrderAccepted) await refundEntry(energyClaim);", submit);
    assert.ok(claim > 0 && acting > claim, "the claim precedes the acting line");
    assert.ok(submit > acting && refund > submit, "and the refund follows the submit");
    const withheld = CODE.slice(claim, acting);
    assert.match(withheld, /\} else if \(energyClaim && !energyClaim\.ok\) \{[\s\S]*await withholdEntry\(agentId\);/);
    assert.doesNotMatch(withheld.slice(withheld.indexOf("energyClaim && !energyClaim.ok")), /recordDecisionRefusal/, "a withheld buy writes no refusal row");
  });

  it("THE STRATEGY LOOP: exits are asked by the breaker's own test, and a withheld entry never reaches ensureDecision", () => {
    const at = CODE.indexOf("for (const [proposedAt, intent] of proposed.entries()) {");
    const end = CODE.indexOf("\n    }\n", at);
    const loop = CODE.slice(at, end);
    assert.match(loop, /const entry = countsAsEntry\(intent\.kind, isExitIntent\(intent, active\.limits\), sellsHeldLeg\(intent, heldLegs\)\);/);
    const withheld = loop.indexOf("await withholdEntry(agentId);\n        continue;");
    const decided = loop.indexOf("await ensureDecision(");
    assert.ok(withheld > 0 && decided > withheld, "withheld with `continue` BEFORE any decision row exists");
    assert.match(loop, /if \(!tradeConsumesSnapshot\(facts\?\.status\)\) await refundEntry\(energyClaim\);/);
    assert.match(loop, /await processIntent\(intent, equityUsdg, !bookIncomplete\);/, "exits keep the path they always had");
  });

  it("THE CLASS ENTRIES: the same filter, and the gate is told when entries are closed", () => {
    const at = CODE.indexOf("const entries: Tick = await classGate.entries(async () => await proposeClassEntries());");
    const loop = CODE.slice(at, CODE.indexOf("\n    }\n", at));
    assert.match(loop, /countsAsEntry\(intent\.kind, isExitIntent\(intent, active\.limits\), sellsHeldLeg\(intent, heldLegs\)\)/);
    assert.ok(loop.indexOf("await withholdEntry(agentId);") < loop.indexOf("await ensureDecision("));
    assert.match(CODE, /entriesOpen: !energyNow\.enforce \|\| energyNow\.entries\.open,/);
  });

  it("A CURVE SALE OUT OF A HELD LEG is read from this tick's book, before either filter asks", () => {
    const held = CODE.indexOf("const heldLegs = heldCurveLegs({");
    assert.ok(held > 0 && held < CODE.indexOf("for (const [proposedAt, intent] of proposed.entries()) {"));
    assert.match(
      CODE.slice(held, held + 300),
      /positions,\s*curveLegs: lastCurveLegs,\s*classRows: await classPositions\(agentId\),\s*classBalances: lastClassBalances,/,
    );
  });

  it("THE CLASS EXITS NEVER ASK", () => {
    const at = CODE.indexOf("const exits = await proposeClassExits();");
    const loop = CODE.slice(at, CODE.indexOf("const entries: Tick", at));
    assert.doesNotMatch(loop, /claimEntry|energy/i);
  });

  it("the Snapshot carries the hint only while enforcing", () => {
    assert.match(CODE, /energy: energyNow\.enforce \? \{ entriesLeft: energyNow\.entries\.left \?\? 0 \} : null,/);
  });

  it("and the Brain's own entry review is braked by the same fact", () => {
    assert.match(CODE, /const entriesBraked = breakerTripped\(\{ drawdown: drawdownNow \}\) \|\| \(energyNow\.enforce && !energyNow\.entries\.open\);/);
  });
});

/**
 * THE GATE'S OWN SYMBOLS, not the word. The owner's energy BUY legitimately
 * runs through the order path (a refusal in submitChatTrade, an arm in
 * processIntentLocked) and may say "energy"; what must never appear there is
 * anything that could WITHHOLD an owner's order: the plan, a claim, a refund.
 */
const GATE = /\benergyNow\b|\benergyWithheld\b|\bclaimEntry\b|\bclaimReview\b|\brefundEntry\b|\bwithholdEntry\b|\btellEnergySpent\b|\bclaimEnergy(For|Notice)?\b|\bgetEnergyDay\b/;

describe("THE OWNER'S PATHS ARE UNTOUCHED BY THE GATE", () => {
  for (const name of ["submitChatTrade", "submitChatTransfer", "runQueuedCommand", "processIntentLocked"]) {
    it(`${name} consults no part of the throttle`, () => {
      assert.doesNotMatch(body(name), GATE, `${name} reaches the energy gate`);
    });
  }

  it("and the pattern does catch the gate where it is meant to be", () => {
    assert.match(body("refreshEnergy"), GATE);
    assert.match(CODE.slice(CODE.indexOf("for (const [proposedAt, intent] of proposed.entries()) {")), GATE);
  });

  it("no second copy of the exit test lives in index.ts", () => {
    assert.doesNotMatch(CODE, /buyToken\) === lc\(limits\.cashToken/);
  });
});

describe("deciding and telling", () => {
  it("THE PLAN IS DECIDED FROM THE $MERRYMEN READ, before anything this tick could spend it", () => {
    const read = CODE.indexOf("const holderRead = await readHolderStatusResult(cfg.rpcMainnet, cfg.holderAddress, energyAccount);");
    const refresh = CODE.indexOf("await refreshEnergy(agentId, grant, holderRead.parts, holderStanding);");
    const guard = CODE.indexOf("plan.brain && energyNow.reviews.open");
    assert.ok(read > 0 && refresh > read && guard > refresh);
  });

  it("THE LAST GOOD READING IS THE LEDGER'S, per account — loaded once, remembered only when a read decided it", () => {
    // Kept by holderStandingFor in every mode (the Circle gate reads it too);
    // refreshEnergy takes the standing it produced and loads nothing itself.
    const standing = body("holderStandingFor");
    assert.match(standing, /if \(energyLastGood\?\.agentId !== agentId\) \{/, "a re-signed account does not inherit another's reading");
    assert.match(standing, /await lastEnergyRead\(agentId, now - ENERGY\.lastGoodMaxAgeSec\)/);
    assert.match(standing, /if \(decided !== null\) \{[\s\S]*await noteEnergyRead\(agentId, utcDay\(now\), decided, now\);/);
    const refresh = body("refreshEnergy");
    assert.match(refresh, /const \{ level \} = standing;/, "observe and enforce decide on that standing");
    assert.doesNotMatch(refresh, /lastEnergyRead|noteEnergyRead/, "one keeper of the reading");
  });

  it("the agent's account counts only on Robinhood Chain", () => {
    assert.match(CODE, /const energyAccount = grant\.chainId === MERRYMEN_TOKEN\.chainId \? \(grant\.smartAccount as `0x\$\{string\}`\) : undefined;/);
  });

  it("the report is published every tick, whatever the mode, on its own statement", () => {
    const refresh = body("refreshEnergy");
    assert.match(refresh, /void setAgentEnergy\(agentId, JSON\.stringify\(energyReport\)\);/);
    assert.match(refresh, /if \(mode === "off"\) \{/);
    // The heartbeat's pinned argument list is not touched (exec-mode-publish.test.ts).
    assert.match(CODE, /setAgentMode\(active\.agentId, mode, at, sponsorGas, blocking\)/);
  });

  it("the estimate is priced over the tick's own client, and only for a Robinhood Chain grant not at full", () => {
    const refresh = body("refreshEnergy");
    assert.match(refresh, /grant\.chainId === MERRYMEN_TOKEN\.chainId && level !== "full"/);
    assert.match(refresh, /now - energyEstimate\.at < ENERGY\.estimateEverySec/);
    assert.match(refresh, /estimateEnergyUsdg\(client, parts\)/);
  });

  it("THE ESTIMATE IS SIZED BY THE PLANNER'S OWN RULE — margin and tax at the expected rate, never the bare shortfall", () => {
    const e = body("estimateEnergyUsdg");
    assert.match(e, /energyAmountInFor\(client, energyGrossFor\(shortRaw, tax\)\)/);
    assert.doesNotMatch(e, /slippage/i, "the owner's tolerance is the router's floor, never the size");
    assert.match(e, /usdgCentsUp\(energyAskFor\(amountIn\)\)/, "rounded and floored as the ask is");
    assert.doesNotMatch(CODE, /grossNeededFor\(/, "no second copy of the sizing lives in index.ts");
  });

  it("THE CLAIM ON TODAY'S NOTICE PRECEDES THE MESSAGE — at most once, even across a crash", () => {
    const w = body("tellEnergySpent");
    const claim = w.indexOf("await claimEnergyNotice(agentId, day, now)");
    const told = w.indexOf("await addEvent(");
    assert.ok(claim > 0 && told > claim);
    assert.match(w, /if \(!claimed\) return;/);
    assert.match(w, /"warn",\s*energyNotice\(/, "a warn — the owner's register, never a post");
  });

  it("THE NOTICE IS WRITTEN IN ONE PLACE, and both moments reach it", () => {
    assert.equal(CODE.split("await claimEnergyNotice(").length - 1, 1, "one claim site");
    assert.equal(CODE.split("energyNotice({").length - 1, 1, "one sentence site");
    const w = body("withholdEntry");
    assert.match(w, /shouldTellOwner\(energyNow, energyWithheld\)/);
    assert.match(w, /await tellEnergySpent\(agentId\);/);
    assert.doesNotMatch(w, /claimEnergyNotice|addEvent\(/, "withholdEntry no longer writes its own copy");
  });

  it("REFRESHENERGY TELLS THE OWNER WHEN THE DAY'S NEW TRADES ARE USED UP — after the report it quotes", () => {
    // Most agents stop proposing entries once spent, so a withheld entry may
    // never come; without this the iOS/Android owner is never told.
    const r = body("refreshEnergy");
    const report = r.indexOf("energyReport = energyStatus({");
    const tell = r.indexOf("if (shouldTellOwnerSpent(energyNow)) await tellEnergySpent(agentId);");
    assert.ok(report > 0 && tell > report, "told after this tick's report is decided");
  });

  it("observe counts and never refuses; enforce refuses at the cap", () => {
    const c = body("claimEnergyFor");
    assert.match(c, /if \(plan\.mode !== "enforce"\) \{[\s\S]*return \{ ok: true,/);
    assert.match(c, /return \{ ok: claimed,/);
  });

  it("THE CIRCLE LINES NAME THE COMBINED BALANCE, and keep their pinned halves", () => {
    assert.match(CODE, /Merry Circle — no \$MERRYMEN between your wallet and my account; standard platform fee applies/);
    // The Circle note is written in circle-gate.ts now (run in circle-gate.test.ts).
    const gate = readFileSync(new URL("./circle-gate.ts", import.meta.url), "utf8");
    assert.match(gate, /hold \$\{count\(ENERGY\.fullTokens\)\} \$MERRYMEN \$\{where\} /);
    assert.match(gate, /"between your wallet and my account"/);
    // The gate unlocks on the exact tier OR the standing energy reads (a
    // restart's failed first read must not lock a Merry Man out — the pins
    // and the restart are in circle-gate.test.ts); the line is the same one.
    assert.match(CODE, /circleStanding\(\{ tierUnlocks: holderTier\.bonusStrategies, level: holderStanding\.level \}\)/);
    assert.match(CODE, /isCircleStrategy\(strategy\.name\) && !circle\.unlocked/);
  });
});
