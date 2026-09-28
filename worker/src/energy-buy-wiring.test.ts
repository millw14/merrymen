/**
 * WHERE THE ENERGY BUY IS WIRED — AND WHERE IT MUST NEVER BE.
 *
 * Its arithmetic runs in energy-buy.test.ts, its calls and fence in
 * uniswap-v2-energy.test.ts and final-fence.test.ts, its booking against a real
 * ledger in energy-settle.integration.test.ts. What none of those can see is
 * main(): which path reaches the buy, in what order the refusals and the
 * booking sit around the send, and what the booking is kept away from. main()
 * cannot be booted by a test, so each of those facts is pinned here over
 * index.ts with comments stripped — prose about energy is not energy.
 *
 * Each pin is the one a plausible refactor would silently undo, and each would
 * leave every pure test green:
 *
 *   - a model or a Telegram message spending USDG on $MERRYMEN with no click;
 *   - a real buy judged on the paper book, or simulated onto the tape;
 *   - calldata signed without the byte-for-byte fence;
 *   - a landed purchase settled before it was booked (a crash between the two
 *     leaves a phantom drawdown no sweep ever books), or booked from the orphan
 *     sweep (the Shogun double-lowering);
 *   - the in-memory peaks moved mid-tick (a fee on principal).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { rejectRuleLabel, rejectRuleRemedy } from "./thesis-policy";

const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
const CODE = codeOf(read("./index.ts"));
const SETTLE = codeOf(read("./energy-settle.ts"));

/** A function declared in main() — two-space indent — up to its closing brace. */
function body(name: string, kind: "async function" | "function" = "async function"): string {
  const at = CODE.indexOf(`  ${kind} ${name}(`);
  assert.ok(at > 0, `${name} must exist for this pin to mean anything`);
  const end = CODE.indexOf("\n  }\n", at);
  assert.ok(end > at);
  return CODE.slice(at, end);
}
/** A `const name = async (` arrow in main(), up to its closing `};`. */
function arrow(name: string): string {
  const at = CODE.indexOf(`  const ${name} = async (`);
  assert.ok(at > 0, `${name} must exist`);
  const end = CODE.indexOf("\n  };\n", at);
  assert.ok(end > at);
  return CODE.slice(at, end);
}
const count = (hay: string, needle: string | RegExp) =>
  typeof needle === "string" ? hay.split(needle).length - 1 : (hay.match(new RegExp(needle, "g")) ?? []).length;

/** The energy arm of processIntentLocked, from its `else if` to the final `else`. */
function energyArm(): string {
  const locked = body("processIntentLocked");
  const at = locked.indexOf('} else if (intent.kind === "energy-buy") {');
  assert.ok(at > 0, "the energy arm must exist");
  const end = locked.indexOf("      } else {", at);
  assert.ok(end > at);
  return locked.slice(at, end);
}

describe("WHO CAN REACH THE BUY", () => {
  it("submitChatTrade resolves BY ADDRESS against the watch set, and refuses the reserve before the book or anything else", () => {
    const trade = body("submitChatTrade");
    const resolve = trade.indexOf("const resolved = resolveOrderToken(symbol, watchTokens);");
    const refuse = trade.indexOf('if (resolved.kind === "reserve") return no(ENERGY_NOT_AN_ORDER);');
    assert.ok(resolve > 0 && refuse > resolve, "resolved first, then the reserve refused");
    for (const later of ["if (!active)", "tickBook.judge(side)", "curveFor(", "ensureDecision("]) {
      const at = trade.indexOf(later);
      assert.ok(at > refuse, `${later} must come after the reserve refusal`);
    }
    // NEVER BY NAME: a watched lookalike called MERRYMEN is an ordinary token
    // (resolveOrderToken is run in energy-buy.test.ts).
    assert.doesNotMatch(trade, /isEnergySymbol\(|watchTokens\.find\(/);
    assert.match(trade, /const token = resolved\.address;/);
    // AND THE NAME THE WATCH SET GAVE IT from there on: an order upper-cased by
    // the app or Telegram must still find a mixed-case position to sell.
    const after = trade.slice(trade.indexOf("const token = resolved.address;"));
    assert.match(after, /const named = resolved\.symbol;/);
    assert.match(after, /readPositionRaw\(active\.agentId, named, usdg\)/);
    assert.match(after, /submitChatCurveTrade\(side, named, token,/);
    assert.doesNotMatch(after, /readPositionRaw\(active\.agentId, symbol,/);
  });

  it("the sentence points to the app chat and never to /settings", async () => {
    const { ENERGY_NOT_AN_ORDER, isEnergySymbol } = await import("./energy-buy");
    assert.match(ENERGY_NOT_AN_ORDER, /get my energy/);
    assert.match(ENERGY_NOT_AN_ORDER, /Merrymen app chat/);
    assert.doesNotMatch(ENERGY_NOT_AN_ORDER, /\/settings|Add it in/i);
    for (const s of ["MERRYMEN", "merrymen", " $MERRYMEN ", "$merrymen"]) assert.equal(isEnergySymbol(s), true, s);
    for (const s of ["MERRY", "MERRYMENX", "", "TSLA"]) assert.equal(isEnergySymbol(s), false, s);
  });

  it("submitEnergyBuy is called from runOrderCommand's submit closure and NOWHERE else", () => {
    assert.equal(count(CODE, "submitEnergyBuy("), 2, "one definition, one call");
    const order = body("runOrderCommand");
    // ROUTED ON THE MARKER placeOrder decided (order-gate.ts orderRoute, run in
    // order-gate.test.ts), never on the symbol: a buy card, a snipe or an MCP
    // proposal naming MERRYMEN reaches submitChatTrade like any order.
    assert.match(order, /\(side, symbol, size, route\) => \{/);
    assert.match(order, /if \(route === "energy"\) \{\s*if \(!isEnergySymbol\(symbol\)\) \{[\s\S]*?\}\s*return submitEnergyBuy\(side, size, asked\);/);
    assert.doesNotMatch(order, /symbol === MERRYMEN_TOKEN\.symbol|isEnergyReserveToken/, "no symbol decides the route");
    assert.match(order, /return submitChatTrade\(side, symbol, size, asked\);/, "every unmarked order is an ordinary one");
    assert.match(order, /\.\.\.orderAsked\(cmd\.args, side, symbol, size\),/, "filed under the order's own source and reason");
    // Routed BEFORE the ordinary submitter, inside placeOrder's submit closure
    // — so its reads, pause, shape and ceiling gates run first.
    assert.ok(order.indexOf("submitEnergyBuy(") < order.indexOf("return submitChatTrade("));
    assert.ok(order.indexOf("placeOrder(") < order.indexOf("submitEnergyBuy("));
    // Not the Brain's path, not Telegram's deps, not the transfer path.
    for (const other of ["submitChatTrade", "submitChatTransfer", "runQueuedCommand", "processIntentLocked"]) {
      assert.doesNotMatch(body(other), /submitEnergyBuy|energyBuyLocked/, other);
    }
    const tg = CODE.slice(CODE.indexOf("startTelegram({"), CODE.indexOf("notifierHandle = startNotifier({"));
    assert.doesNotMatch(tg, /submitEnergyBuy|energyBuyLocked/);
  });

  it("its decision is filed under the ORDER's source and reason, never a literal", () => {
    assert.match(body("energyBuyLocked"), /await ensureDecision\(intent, asked\.source, `\$\{asked\.reason\}, /);
  });

  it("an energy intent is BUILT in exactly one place — the locked body of submitEnergyBuy", () => {
    const built = [...CODE.matchAll(/kind: "energy-buy",/g)];
    assert.equal(built.length, 1, "one construction site");
    assert.ok(body("energyBuyLocked").includes('kind: "energy-buy",'));
  });

  it("the whole ask runs inside energyLock, and the lock never holds a rejection", () => {
    const outer = body("submitEnergyBuy");
    assert.match(outer, /const step = \(\) => energyBuyLocked\(side, maxUsdg, asked\);/);
    assert.match(outer, /const run = energyLock\.then\(step, step\);/);
    assert.match(outer, /energyLock = run\.catch\(\(\) => \{\}\);/);
    assert.equal(count(CODE, "energyBuyLocked("), 2, "only the lock calls the body");
  });

  it("the buy never passes through any fork of the energy THROTTLE", () => {
    const GATE = /\benergyNow\b|\benergyWithheld\b|\bclaimEntry\b|\bclaimReview\b|\brefundEntry\b|\bwithholdEntry\b|\bclaimEnergy(For|Notice)?\b|\bgetEnergyDay\b/;
    assert.doesNotMatch(body("submitEnergyBuy"), GATE);
    assert.doesNotMatch(body("energyBuyLocked"), GATE);
  });

  it("submitEnergyBuy sits AFTER submitChatTransfer, so the order-command slices are unchanged", () => {
    assert.ok(CODE.indexOf("async function submitEnergyBuy(") > CODE.indexOf("async function submitChatTransfer("));
  });
});

describe("THE ASK'S OWN REFUSALS, in order, before anything is read", () => {
  it("sell, pause, chain, book, live rail, permission — then the pinned reads, then the plan", () => {
    const b = body("energyBuyLocked");
    const order = [
      'if (side !== "buy") return no(ENERGY_NO_SELL);',
      "if (isPaused())",
      "if (grant.chainId !== MERRYMEN_TOKEN.chainId) return no(ENERGY_NOT_MAINNET);",
      'const judged = tickBook.judge("buy");',
      'if (rail.mode !== "live") return no(energyNeedsLiveLine(liveBlockerText(rail.rule)));',
      "if (!route || !limits.energy) return no(ENERGY_RESIGN);",
      "energyBuysInFlight(agentId,",
      "await planEnergyBuy(",
      "await ensureDecision(",
      "await processIntentReporting(intent, judged.equityUsdg, judged.equityKnown, asked.notAfterMs)",
      "sayEnergyOutcome(outcome, plan, heldAfter)",
    ].map((s) => {
      const at = b.indexOf(s);
      assert.ok(at > 0, `missing: ${s}`);
      return at;
    });
    assert.deepEqual([...order].sort((x, y) => x - y), order, "in this order");
  });

  it("the balances are read PINNED no earlier than the last landing, and after it lands again", () => {
    const b = body("energyBuyLocked");
    assert.match(b, /const atLeast = lastEnergyLandedBlock \?\? 0n;/);
    assert.match(b, /readHolderStatusResult\(cfg\.rpcMainnet, cfg\.holderAddress, grant\.smartAccount as `0x\$\{string\}`, \{\s*atLeastBlock: atLeast,/);
    assert.match(b, /blockNumber: head > atLeast \? head : atLeast,/, "the cash read is pinned the same way");
    assert.match(b, /if \(outcome\?\.status === "landed"\) \{[\s\S]*atLeastBlock: lastEnergyLandedBlock \?\? 0n,/);
  });

  it("the owner's number is only ever a ceiling on the size", () => {
    const b = body("energyBuyLocked");
    assert.match(b, /ownerMaxRaw: usdg\(maxUsdg\),/);
    assert.match(b, /sellAmountRaw: plan\.amountInRaw,\s*notionalUsdg: plan\.amountInRaw,/);
  });

  it("no energy code constructs exec inputs with liveTradingEnabled: true", () => {
    for (const src of [CODE, SETTLE, codeOf(read("./energy-buy.ts"))]) {
      assert.doesNotMatch(src, /liveTradingEnabled:\s*true/);
    }
  });
});

describe("THE EXECUTOR", () => {
  it("energy-needs-live is refused BEFORE the refuse and paper arms, with a row", () => {
    const locked = body("processIntentLocked");
    const live = locked.indexOf('if (intent.kind === "energy-buy" && execRail.mode !== "live") {');
    assert.ok(live > 0);
    assert.ok(live < locked.indexOf('if (execRail.mode === "refuse") {'));
    assert.ok(live < locked.indexOf('if (execRail.mode === "paper") {'));
    assert.match(locked.slice(live, live + 400), /reject_rule: "energy-needs-live",\s*\}\);\s*return;/);
  });

  it("the arm re-reads the tax, re-quotes, probes impact, and floors AFTER the tax — never trusting the plan", () => {
    const arm = energyArm();
    const steps = [
      "grantEnergyRoute(active.grant)",
      "await readEnergyTaxBps(active.client)",
      "taxBps > ENERGY.maxTaxBps",
      "await quoteEnergyOut(active.client, intent.sellAmountRaw)",
      "energyMinOut(gross, taxBps, cfg.slippageBps)",
      "judgeImpact({ bps: impact, maxBps: cfg.maxImpactBps, isExit: false })",
      "BigInt(Math.floor(Date.now() / 1000) + ENERGY.deadlineSec)",
      "buildEnergyCalls({",
      "checkEnergySwapCalls(calls, {",
      "exec = await send(calls);",
    ].map((s) => {
      const at = arm.indexOf(s);
      assert.ok(at > 0, `missing: ${s}`);
      return at;
    });
    assert.deepEqual([...steps].sort((x, y) => x - y), steps);
  });

  it("THE FENCE IS UNCONDITIONAL: called on every build, not inside any other branch, before the one send", () => {
    const arm = energyArm();
    assert.equal(count(arm, "checkEnergySwapCalls("), 1);
    assert.equal(count(arm, "send("), 1);
    const fence = arm.indexOf("const energyFence = checkEnergySwapCalls(calls, {");
    assert.ok(fence > 0, "assigned at the arm's own level");
    // Between the build and the fence there is no branch that could skip it.
    const build = arm.indexOf("const calls = buildEnergyCalls({");
    assert.doesNotMatch(arm.slice(build, fence), /\bif \(|\?\s/);
    const refused = arm.slice(fence, arm.indexOf("exec = await send(calls);"));
    assert.match(refused, /if \(!energyFence\.ok\) \{[\s\S]*reject_rule: `fence-\$\{energyFence\.rule\}`[\s\S]*return;/);
    // And the v3 fence is never asked about an energy buy.
    assert.doesNotMatch(arm, /checkV3SwapCalls/);
  });

  it("every return in the arm writes a row and visibly releases the reservation", () => {
    const arm = energyArm();
    const returns = count(arm, "return;");
    assert.ok(returns >= 5);
    assert.equal(count(arm, "releaseBudget();"), returns);
    assert.equal(count(arm, "await recordTrade({"), returns);
  });

  it("the landing block is remembered only AFTER the send came back", () => {
    const arm = energyArm();
    assert.ok(arm.indexOf("noteEnergyLanded(exec.blockNumber);") > arm.indexOf("exec = await send(calls);"));
  });

  it("THE PIN HAS ONE WRITER, which only moves it forward — fed by the executor, the resolver and the arm's ledger seed", () => {
    // It lived in memory, written by the executor alone: a restart, or a
    // landing only the stranded resolver saw, left the next ask's balance
    // reads unpinned (the in-flight guard matches only 'submitted' rows).
    assert.equal(count(CODE, "lastEnergyLandedBlock = "), 1, "one assignment");
    const note = CODE.slice(CODE.indexOf("const noteEnergyLanded = "), CODE.indexOf("const noteEnergyLanded = ") + 400);
    assert.match(note, /if \(block === null \|\| block === undefined \|\| block <= 0n\) return;\s*if \(lastEnergyLandedBlock === null \|\| block > lastEnergyLandedBlock\) lastEnergyLandedBlock = block;/);
    assert.equal(count(CODE, "noteEnergyLanded("), 3, "three callers: the executor, the resolver, the arm");
    // The resolver pins a purchase it settled as landed — after its booking decided.
    const r = arrow("resolveStrandedOps");
    const settle = r.indexOf("await settleEnergyLanding(");
    assert.ok(r.indexOf("noteEnergyLanded(r.blockNumber);") > settle);
    // The arm seeds it from the ledger AFTER the stranded resolver ran, and before the budget.
    const reconcile = CODE.indexOf("if (executor) await reconcileInFlightAtArm(agentId, client, grant.smartAccount as `0x${string}`);");
    const seeded = CODE.indexOf("await energyLandedBlockAtArm({", reconcile);
    assert.ok(reconcile > 0 && seeded > reconcile && seeded < CODE.indexOf("await refreshBudget(agentId);", reconcile));
    assert.match(CODE.slice(seeded, seeded + 300), /newest: \(\) => newestLandedEnergyBuy\(agentId\),/);
  });

  it("tokenLegs names the energy legs, so the pre-broadcast 'submitted' row carries them", () => {
    const legs = body("tokenLegs", "function");
    assert.match(legs, /if \(intent\.kind === "energy-buy"\) return \{ sell_token: intent\.sellToken, buy_token: intent\.buyToken \};/);
    const hooks = CODE.slice(CODE.indexOf("onSubmitted: async (userOpHash, op) => {"));
    assert.match(hooks.slice(0, 400), /\.\.\.tokenLegs\(intent\),/);
  });

  it("its decision is filed under its OWN action word, never 'buy' — so it is never narrated as a position", () => {
    // maybePost builds an agent post only for action buy/sell; the energy buy
    // is not a trade view and must never become one in the agent's voice.
    const describe_ = body("describeIntent", "function");
    assert.match(describe_, /if \(intent\.kind === "energy-buy"\) \{\s*return \{ action: "energy-buy", symbol: MERRYMEN_TOKEN\.symbol,/);
    assert.match(CODE, /const act = d\?\.action === "buy" \? "enter" : d\?\.action === "sell" \? "exit" : null;/);
  });

  it("delivery is checked for the energy buy, into the account itself", () => {
    const at = CODE.indexOf("const acquired: { token:");
    assert.match(CODE.slice(at, at + 1400), /intent\.kind === "energy-buy"\s*\?\s*\{ token: intent\.buyToken,[^\n]*holder: executor\.address \}/);
  });

  it("NEVER A FILL: fillPair and liveFill are cleared for an energy intent before the receipt decode and bookFill", () => {
    const locked = body("processIntentLocked");
    const clear = locked.indexOf("if (isEnergyIntent(intent)) {\n        fillPair = null;\n        liveFill = null;\n      }");
    assert.ok(clear > 0);
    assert.ok(clear > locked.indexOf("exec = await send(calls);"), "after every arm has run");
    assert.ok(clear < locked.indexOf("const deltas = netTokenDeltas("));
    assert.ok(clear < locked.indexOf("await bookFill(agentId, \"live\", liveFill, basisSource)"));
  });

  it("NO TRADE FEE: the fee spread exempts an energy purchase beside a transfer", () => {
    const at = CODE.indexOf("trade_fee_usdg: usdgNum(tradeFeeUsdg(");
    assert.match(CODE.slice(at - 200, at), /intent\.kind === "transfer" \|\| isEnergyIntent\(intent\)\s*\?\s*\{\}/);
  });
});

describe("THE BOOKING (review-accounting's nine pins)", () => {
  it("(1) it books through bookCapitalFlow and never through addFlow/adjustAgentHwm", () => {
    assert.match(SETTLE, /await d\.book\(\{/);
    assert.doesNotMatch(SETTLE, /addFlow\(|adjustAgentHwm\(/);
    const deps = CODE.slice(CODE.indexOf("const energySettleDeps = "), CODE.indexOf("const energySettleDeps = ") + 900);
    assert.match(deps, /book: \(flow\) => bookCapitalFlow\(flow\),/);
    assert.equal(count(CODE, "bookCapitalFlow("), 1, "the deps are the one caller in main()");
    assert.doesNotMatch(CODE, /source: "energy-buy"/, "index.ts never writes an energy flow by hand");
  });

  it("(2) the booking sits BEFORE the landed row in processIntentLocked", () => {
    const locked = body("processIntentLocked");
    const book = locked.indexOf("await bookEnergyPurchase(");
    const landed = locked.indexOf('status: "landed",');
    assert.ok(book > 0 && landed > book, "booked, then written landed");
    assert.match(locked.slice(book - 80, book + 300), /if \(isEnergyIntent\(intent\)\) \{[\s\S]*logs: exec\.logs, blockNumber: exec\.blockNumber/);
    assert.match(locked.slice(book, book + 400), /if \(energyBooked === "booked"\) capitalPeakDirty = true;/);
  });

  it("(3) the trade_fee ternary includes isEnergyIntent (above) and (4) fills are guarded (above)", () => {
    assert.ok(CODE.includes('intent.kind === "transfer" || isEnergyIntent(intent)'));
  });

  it("(5) resolveStrandedOps books BEFORE addTrade, and leaves the row 'submitted' (continue) when it cannot", () => {
    const r = arrow("resolveStrandedOps");
    const settle = r.indexOf("await settleEnergyLanding(energySettleDeps(agentId, grant, chain), r.txHash as `0x${string}`);");
    const add = r.indexOf("await addTrade({");
    assert.ok(settle > 0 && add > settle);
    assert.match(r, /const energyRow = isEnergyRow\(row\);\s*let capitalBooked: boolean \| null = null;\s*if \(energyRow && r\.success\) \{/);
    assert.match(r.slice(settle, add), /if \(!settled\.proceed\) \{[\s\S]*continue;/);
    assert.match(r.slice(settle, add), /if \(settled\.settled === "booked"\) capitalPeakDirty = true;/);
    assert.match(r.slice(add, add + 600), /\.\.\.\(energyRow \? \{ sell_token: row\.sellToken, buy_token: row\.buyToken \} : \{\}\),/);
  });

  it("(5b) A SETTLEMENT EXPLAINS ONLY ITS OWN CASH: the look holds first, folds the queued settlements, and a held tick accrues no fee and moves no lifetime peak while the breaker still observes (flow-inference.integration.test.ts runs this shape)", () => {
    // A stranded purchase was booked twice (inferred, then by the resolver);
    // the fix for that bumped ledgerWrites on every settlement, which closed
    // the whole held interval — deposits, transfers home, reverts — as
    // "explained". Now the resolver queues the op's own movement.
    const f = arrow("reconcileFlows");
    const listed = f.indexOf("const listedAt = Math.floor(Date.now() / 1000);");
    assert.match(f.slice(listed), /^const listedAt = Math\.floor\(Date\.now\(\) \/ 1000\);\s*const opsInFlight = opsHoldInference\(await listSubmittedOps\(agentId\), \{\s*epoch: await getAgentEpoch\(agentId\),\s*nowSec: listedAt,/);
    // The queue is taken only AFTER the ledger read (the resolver queues before its row write).
    assert.ok(f.indexOf("takeSettlements()") > f.indexOf("await listSubmittedOps(agentId)"));
    // The steady look: hold before the write rule is pure (lookAtCash); the fold is kept; a hold returns "held" before any record().
    const steady = f.slice(f.lastIndexOf("const l = lookAtCash({"));
    assert.match(steady, /baselineUsdg: lastCashUsdg,\s*since: baselineSince,\s*unattributed: baselineUnattributed,\s*settled: takeSettlements\(\),\s*cashUsdg,\s*opsInFlight,\s*writesInInterval: ledgerWrites !== ledgerWritesAtSnapshot,/);
    const fold = steady.indexOf("lastCashUsdg = l.baselineUsdg;");
    const hold = steady.indexOf('if (l.verdict.action === "hold") {');
    const infer = steady.indexOf('if (l.verdict.action === "infer") await record(l.verdict.deltaUsdg, "no trade explains this");');
    assert.ok(fold > 0 && hold > fold && infer > hold);
    assert.match(steady.slice(hold, infer), /return "held";/);
    assert.match(f, /lastCashUsdg = cashUsdg;\s*baselineSince = listedAt;\s*baselineUnattributed = false;\s*ledgerWritesAtSnapshot = ledgerWrites;/);
    // The resolver never moves the write count; it queues, once per op, BEFORE the row is written.
    const r = arrow("resolveStrandedOps");
    assert.doesNotMatch(r, /ledgerWrites\s*\+?=/);
    const queue = r.indexOf("settlementQueue.push({ userOpHash: r.userOpHash, createdAt: row.createdAt, usdgDelta6: explains.usdgDelta6 });");
    assert.ok(queue > r.indexOf("await settleEnergyLanding(") && queue < r.indexOf("await addTrade({"));
    assert.match(r, /const explains = settlementDelta\(\{ success: r\.success, receiptUsdgDelta6: r\.usdgDelta6, capitalBooked \}\);\s*if \(explains\.queue && !settlementsQueued\.has\(r\.userOpHash\)\) \{\s*settlementsQueued\.add\(r\.userOpHash\);/);
    // A capital op's movement is read before it is booked.
    assert.match(r, /if \(energyRow && r\.success\) \{[\s\S]*?if \(r\.usdgDelta6 === null\) \{[\s\S]*?continue;[\s\S]*?await settleEnergyLanding\(/);
    // The tick: a held look (or an aborted one) accrues no fee and moves no
    // lifetime peak — but the breaker observes the held figure, never the raw
    // equity, and the valuation is written flagged.
    const t = body("tick");
    assert.match(t, /const flows = await reconcileFlowsOrRetry\(/);
    assert.match(
      t,
      /if \(flows === "held"\) \{\s*ratchet = tickRatchets\(plan, \{\s*incomplete: bookIncomplete,\s*curveMarked: curveMarked\.length,\s*held: true,\s*breakerObservationUsdg: heldBreakerObservationUsdg\(\{\s*equityUsdg,\s*cashUsdg: balances\.cashUsdg,\s*expectedCashUsdg: await heldCashBaseline\(agentId\),\s*\}\),\s*\}\);\s*\}/,
    );
    assert.ok(t.indexOf('if (flows === "held") {') < t.indexOf("const riskPeak = await ratchet.riskPeak("));
    // The breaker's lift moves after the mark, from the mark on either side of the accrual.
    const accrue = t.indexOf("highWaterMarkUsdg = await ratchet.accrue(accrual, highWaterMarkUsdg, async () => {");
    assert.ok(t.indexOf("const markBeforeAccrual = highWaterMarkUsdg;") < accrue);
    assert.ok(t.indexOf("heldBreakerLiftUsdg = ratchet.breakerLift(heldBreakerLiftUsdg, markBeforeAccrual, highWaterMarkUsdg);") > accrue);
    assert.match(t, /await ratchet\.equityRow\(\(\{ flowsHeld \}\) =>\s*addEquity\(agentId, \{[\s\S]{0,300}flowsHeld,/);
    // Every breaker read takes the lift when no risk period stands.
    assert.match(CODE, /const lifetimeBreakerPeak = \(\) => highWaterMarkUsdg \+ heldBreakerLiftUsdg;/);
    assert.match(CODE, /const drawdownPeak = \(\) => paperActive\(\) \? highWaterMarkUsdg : \(riskHighWaterMarkUsdg \?\? lifetimeBreakerPeak\(\)\);/);
    assert.match(CODE, /highWaterMarkUsdg: paperActive\(\) \? highWaterMarkUsdg : usdg\(\(await getRiskPeriodPeak\(agentId\)\) \?\? usdgNum\(lifetimeBreakerPeak\(\)\)\),/);
    // The expected cash: the kept baseline with the queue folded (read, not taken).
    const expected = arrow("heldCashBaseline");
    assert.match(expected, /if \(lastCashUsdg !== null\) return expectedCashUsdg\(\{ cashUsdg: lastCashUsdg, since: baselineSince \}, settlementQueue\);/);
    assert.doesNotMatch(expected, /takeSettlements\(\)/);
    const retry = arrow("reconcileFlowsOrRetry");
    assert.match(retry, /catch \(e\) \{[\s\S]*return "held";/);
  });

  it("(5c) THE FIRST LOOK AFTER A RESTART holds the same way and takes the same settlements (flow-inference.integration.test.ts runs this shape)", () => {
    // Self-hosted, a stranded purchase was booked as money "changed while the
    // worker was stopped" AND by the resolver; any settled op (even a revert)
    // silently dropped the whole downtime delta; hosted, it read as drift.
    const f = arrow("reconcileFlows");
    const first = f.slice(f.indexOf("} else if (lastCashUsdg === null) {"), f.lastIndexOf("const l = lookAtCash({"));
    const hold = first.indexOf("if (opsInFlight) {");
    assert.ok(hold > 0 && hold < first.indexOf("planFirstObservation({"));
    assert.match(first.slice(hold, hold + 200), /return "held";/);
    // Durable reads BEFORE the queue is taken, and the queue put back if the look throws.
    const take = first.indexOf("const settled = takeSettlements();");
    assert.ok(first.indexOf("await lastKnownCashReading(agentId)") < take && first.indexOf("await landedOpsBetween(agentId, prior.at, processStartedSec + 1)") < take);
    assert.match(first, /catch \(e\) \{\s*settlementQueue = \[\.\.\.settled, \.\.\.settlementQueue\];\s*throw e;/);
    // Hosted: the anchor is shifted by what settled after it.
    assert.match(first, /const anchorShift = attributeSettlements\(settled, anchorObservedAtSec\);/);
    assert.match(first, /anchorCashUsdg: anchorCashUsdg === null \? null : anchorCashUsdg \+ anchorShift\.shiftUsdg6,/);
    // Self-hosted: the steady look against the durable reading; the old bare delta is gone.
    assert.match(first, /baselineUsdg: usdg\(prior\.cashUsdg\),\s*since: prior\.at,\s*unattributed: false,\s*settled,\s*cashUsdg,\s*opsInFlight: false,\s*writesInInterval: ledgerWrites > 0 \|\| wroteSince\(earlierLanded, settlementsQueued\),/);
    assert.match(first, /if \(l\.verdict\.action === "infer"\) await record\(l\.verdict\.deltaUsdg, "changed while the worker was stopped"\);/);
    assert.doesNotMatch(first, /record\(cashUsdg - usdg\(prior\)/);
    assert.doesNotMatch(first, /ledgerWrites === 0/);
    // The durable reading is dated by its READ: the tick takes the time before
    // its balance read and stamps the row with it (store.ts cash_read_at), so a
    // mid-tick op is after the reading's `since`, not "already in" its cash.
    const t = body("tick");
    const readAt = t.indexOf("const cashReadAtSec = Math.floor(Date.now() / 1000);");
    assert.ok(readAt > 0 && readAt < t.indexOf("readAccountBalances(client, grant.smartAccount)") && readAt < t.indexOf("getPaperBook(agentId, cfg.paperStartUsdg)"));
    assert.match(t, /await ratchet\.equityRow\(\(\{ flowsHeld \}\) =>\s*addEquity\(agentId, \{[\s\S]{0,400}cashReadAt: cashReadAtSec,/);
  });

  it("(5d) A STRANDED TRANSFER HOME is booked by the resolver BEFORE its row is settled, and left 'submitted' when it cannot be", () => {
    const r = arrow("resolveStrandedOps");
    const branch = r.indexOf('} else if (row.kind === "transfer" && r.success) {');
    const settle = r.indexOf("await settleTransferLanding(energySettleDeps(agentId, grant, chain), r.txHash as `0x${string}`);");
    const add = r.indexOf("await addTrade({");
    assert.ok(branch > 0 && settle > branch && add > settle);
    assert.match(r.slice(settle, add), /if \(!settled\.proceed\) \{[\s\S]*continue;/);
    assert.match(r.slice(settle, add), /capitalBooked = settled\.settled === "booked" \|\| settled\.settled === "already";/);
    assert.match(r.slice(branch, settle), /if \(r\.usdgDelta6 === null\) \{[\s\S]*continue;/);
    // Through the one bookCapitalFlow caller, and it can see the executor's own booking.
    const deps = CODE.slice(CODE.indexOf("const energySettleDeps = "), CODE.indexOf("const energySettleDeps = ") + 1200);
    assert.match(deps, /flowBookedForTx: \(txHash\) => hasFlowForTx\(agentId, txHash\),/);
    assert.match(SETTLE, /source: "transfer-intent",/);
  });

  it("(5e) A DROPPED OP IS WRITTEN OFF ON PROOF, after the pass has settled what it could — nothing queued, nothing booked (flow-inference.integration.test.ts runs this shape)", () => {
    // A userOp the bundler dropped held flow inference for the resolver's whole
    // 26-hour window. The pre-broadcast row now records the nonce it was signed
    // with, and the resolver writes the op off once another op of ours spent it.
    const hooks = CODE.slice(CODE.indexOf("onSubmitted: async (userOpHash, op) => {"));
    assert.match(hooks.slice(0, 700), /\.\.\.\(op\.nonce !== null \? \{ user_op_nonce: op\.nonce\.toString\(\) \} : \{\}\),\s*status: "submitted",/);
    const r = arrow("resolveStrandedOps");
    const settledLoop = r.indexOf("for (const r of resolved) {");
    const suspects = r.indexOf("const unsettled = mine.filter((m) => m.nonce !== undefined && !resolved.some((r) => r.userOpHash === m.userOpHash));");
    const find = r.indexOf("dropped = await findDroppedOps({");
    assert.ok(settledLoop > 0 && suspects > settledLoop && find > suspects, "after every op the chain answered for is settled");
    assert.match(r.slice(suspects, find), /const rivals = await opsSignedWithNonce\(agentId, m\.nonce!, m\.userOpHash\);/);
    const writeOff = r.slice(find, r.indexOf("const unresolved = mine.length - resolved.length - dropped.length;"));
    assert.match(writeOff, /status: "dropped",[\s\S]*if \(!wrote\) continue;/);
    assert.doesNotMatch(writeOff, /settlementQueue|bookCapitalFlow|settleEnergyLanding|settleTransferLanding|ledgerWrites/, "it moved nothing: no settlement, no booking, no write");
  });

  it("(6) the orphan sweep NEVER books", () => {
    const arm = arrow("reconcileInFlightAtArm");
    const orphans = arm.slice(arm.indexOf("const orphans = await findOrphanOps({"));
    assert.doesNotMatch(orphans, /bookCapitalFlow|bookEnergyPurchase|settleEnergyLanding|energySettleDeps/);
    // And the resolver that DOES book runs before it, so a hash is settled once.
    assert.ok(arm.indexOf("await resolveStrandedOps(") < arm.indexOf("const orphans = await findOrphanOps({"));
  });

  it("(7) energy intents are built only in the command drain's path (see WHO CAN REACH THE BUY)", () => {
    assert.doesNotMatch(body("submitChatTrade"), /kind: "energy-buy"/);
    const tg = CODE.slice(CODE.indexOf("startTelegram({"), CODE.indexOf("notifierHandle = startNotifier({"));
    assert.doesNotMatch(tg, /energy-buy/);
  });

  it("(8) the booking never assigns the in-memory peaks or the cash baseline", () => {
    assert.doesNotMatch(SETTLE, /highWaterMarkUsdg|riskHighWaterMarkUsdg|lastCashUsdg/);
    const locked = body("processIntentLocked");
    const book = locked.indexOf("if (isEnergyIntent(intent)) {\n        const energyBooked");
    const site = locked.slice(book, locked.indexOf("await recordTrade({", book));
    assert.doesNotMatch(site, /highWaterMarkUsdg\s*=|riskHighWaterMarkUsdg\s*=|lastCashUsdg\s*[-+]?=/);
  });

  it("(9) the capitalPeakDirty refresh runs at the top of the tick, BEFORE the book read", () => {
    const t = body("tick");
    const armed = t.indexOf("if (!armed || !active) return;");
    const refresh = t.indexOf("if (capitalPeakDirty && !paperActive()) {");
    const balances = t.indexOf("readAccountBalances(client, grant.smartAccount)");
    assert.ok(armed > 0 && refresh > armed && balances > refresh);
    assert.match(t.slice(refresh, refresh + 400), /highWaterMarkUsdg = usdg\(\(await getAgentFinancials\(agentId\)\)\.hwmUsdg\);[\s\S]*capitalPeakDirty = false;/);
  });

  it("the settle deps key the agent EXACTLY and read the breaker's persisted peak", () => {
    const deps = CODE.slice(CODE.indexOf("const energySettleDeps = "), CODE.indexOf("const energySettleDeps = ") + 900);
    assert.match(deps, /account: grant\.smartAccount,/);
    assert.match(deps, /chainId: grant\.chainId,/);
    assert.match(deps, /breakerPeakUsdg: \(\) => getRiskPeriodPeak\(agentId\),/);
  });

  it("net contributions reach the gates as a 6dp bigint, rounded the one way", () => {
    assert.match(SETTLE, /const usdg6 = \(v: number\) => BigInt\(Math\.round\(v \* 1e6\)\);/);
    assert.match(body("energyBuyLocked"), /netContributionsUsdg: net,/);
  });

  it("DURABLE FIRST: the planner, the booking gate and the Brain snapshot all read durableNetContributions, never the child's local sum", () => {
    // A redeployed hosted child's flows table is empty: the local sum refused
    // every energy buy as "no record", and the anchor alone never saw a
    // purchase booked after arm (net-contributions.integration.test.ts).
    assert.match(body("energyBuyLocked"), /durableNetContributions\(agentId\)\.catch\(\(\) => undefined\),/);
    const deps = CODE.slice(CODE.indexOf("const energySettleDeps = "), CODE.indexOf("const energySettleDeps = ") + 900);
    assert.match(deps, /netContributionsUsdg: async \(\) => \{\s*const net = await durableNetContributions\(agentId\);\s*return net === null \? null : Number\(net\) \/ 1e6;/);
    assert.match(CODE, /const netContrib = await durableNetContributions\(agentId\);/);
    assert.match(CODE, /netContributionsUsdg: netContrib === null \? null : Number\(netContrib\),/);
    assert.doesNotMatch(CODE, /getNetContributionsUsdg\(/, "no consumer in the child reads the local sum alone");
    assert.doesNotMatch(CODE, /\? Number\(anchorNetContributionsUsdg\)/, "nor the arm-time anchor alone");
    const helper = body("durableNetContributions");
    assert.match(helper, /getNetContributionsSince\(agentId, anchorWrittenAtSec \?\? 0\)/);
    assert.match(helper, /anchorNetUsdg6: anchorNetContributionsUsdg,\s*anchorEpoch,/);
    assert.match(CODE, /anchorWrittenAtSec = verdict\.kind === "valid" \? verdict\.state\.generatedAt : null;/);
  });
});

describe("THE EXCLUSIONS", () => {
  it("trencher discovery never adds the reserve to the watch set", () => {
    assert.match(CODE, /const discovered = autoTrench\.tokens\.filter\([^;]*&&!isEnergyReserveToken\(t\.address\)\);/);
  });
  it("the deposit scan is told the grant's chain (which reserve tokens make a purchase reserve-out)", () => {
    const at = CODE.indexOf("flows = await findTransferFlows({");
    assert.match(CODE.slice(at, at + 1200), /\.\.\.\(s\.grant \? \{ chainId: s\.grant\.chainId \} : \{\}\),/);
  });
});

describe("EVERY ENERGY RULE A ROW CAN CARRY HAS WORDS", () => {
  it("each energy-* reject_rule written in index.ts has a label, and the owner-actionable ones a remedy", () => {
    const rules = new Set<string>();
    for (const m of CODE.matchAll(/"(energy-[a-z-]+)"/g)) {
      if (m[1] !== "energy-buy") rules.add(m[1]!);
    }
    for (const r of ["energy-needs-live", "energy-not-granted", "energy-tax", "energy-tax-unreadable", "energy-no-quote"]) {
      assert.ok(rules.has(r), `${r} is written by index.ts`);
    }
    // And the planner's own energy-* rules, read off its union.
    const planner = /export type EnergyPlanRule =([\s\S]*?);/.exec(codeOf(read("./energy-buy.ts")));
    assert.ok(planner, "EnergyPlanRule must stay a union of literals");
    for (const m of planner[1]!.matchAll(/"(energy-[a-z-]+)"/g)) rules.add(m[1]!);
    for (const r of ["energy-unreadable", "energy-in-flight", "energy-too-small"]) assert.ok(rules.has(r), r);
    for (const r of rules) assert.ok(rejectRuleLabel(r), `${r} has no label`);
    for (const r of ["energy-needs-live", "energy-not-granted", "energy-tax"]) assert.ok(rejectRuleRemedy(r), `${r} has no remedy`);
    // Utility words only — nothing about price or returns, no percentages.
    for (const r of rules) {
      const words = `${rejectRuleLabel(r)} ${rejectRuleRemedy(r) ?? ""}`;
      assert.doesNotMatch(words, /price|returns?\b|profit|investment|\d+\s*%/i, r);
    }
  });
});
