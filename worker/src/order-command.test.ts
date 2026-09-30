/**
 * THE SECOND GATE — the one in the process that holds the key.
 *
 * Between the route that validated an order and this code, the order crossed a
 * shared Postgres table, an orchestrator that can see every tenant's home, and
 * a JSON file. The route's check is the one that gives an owner a good error;
 * this one is the one standing between a string and a signed UserOperation, and
 * it has to hold even if every layer above it is wrong. Same principle
 * chat-commands.ts states for settings: two independent gates, neither relying
 * on the other.
 *
 * Source-read, because the dispatch lives inside `main()`'s closure — it cannot
 * be imported without booting a worker, an RPC and a grant. What is being pinned
 * is the ORDER OF THE CHECKS and the fact that each exists at all, which is
 * exactly what words on the page can carry.
 *
 * THE GATES THEMSELVES ARE RUN NOW, not read. The reads, the pause, the
 * arguments and the owner's ceiling moved out of main() into order-gate.ts, and
 * order-gate.test.ts runs every one of them against a submitter that records
 * being called — so the source-reads of them that lived here are gone.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const SRC = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

const CODE = codeOf(SRC);
const RUN = CODE.slice(CODE.indexOf("async function runCommand"), CODE.indexOf("async function runOrderCommand"));

describe("an order that waited too long is not the order that was placed", () => {
  it("EXPIRY IS CHECKED BEFORE THE KIND, so it applies to everything", () => {
    // The claim already consumed the command; this decides what to write back.
    // A silently-vanished order and a never-delivered one must not read the
    // same to the person who clicked, so it answers with a sentence.
    const expiry = RUN.indexOf("isExpired(cmd, Date.now())");
    const kind = RUN.indexOf('cmd.kind === "selftest"');
    assert.ok(expiry > 0 && expiry < kind, "the clock is checked before anything else");
    assert.match(RUN, /line: `expired/);
  });

  it("and an unknown kind is RECORDED, never run", () => {
    // A typo must not look identical to a queue that is not being drained.
    assert.match(RUN, /unknown command '\$\{cmd\.kind\}'/);
  });
});

describe("pause is the owner's stop button and an order honours it", () => {
  it("THE GATE IS PER KIND, in the dispatch and not at the drain", () => {
    // The drain deliberately runs ABOVE the tick's own isPaused() return — you
    // want to be able to probe a paused agent. An order is the opposite: a
    // trade that executes through a pause is the worst surprise this app could
    // produce. The order's refusal is run in order-gate.test.ts; what is pinned
    // here is that the probe is NOT gated, so the two really are separate
    // decisions.
    const probe = CODE.slice(CODE.indexOf("async function runSelftestProbe"), CODE.indexOf("async function runSelftestProbe") + 2000);
    assert.ok(!/isPaused\(\)/.test(probe));
  });
});

describe("the receipt says what the ledger says", () => {
  it("A REFUSAL IS NOT REPORTED AS A SUBMISSION", () => {
    // It used to return "🏹 submitted" unconditionally while processIntent
    // absorbed every wall rejection and returned normally — so the owner
    // believed they held $25 of TSLA and did not. The absence of an exception
    // carries no information at all; the row does.
    assert.match(CODE, /function sayTradeOutcome\(/);
    assert.ok(!/🏹 submitted/.test(CODE), "the unconditional receipt is gone");
    for (const status of ["landed", "submitted", "paper", "reverted"]) {
      assert.ok(CODE.includes(`case "${status}"`), `${status} has no sentence of its own`);
    }
  });

  it("and PAPER is never reported as a fill", () => {
    // Paper is the fallback when the agent cannot trade for real. The useful
    // half of that sentence is why, not the practice trade.
    const say = CODE.slice(CODE.indexOf("function sayTradeOutcome"), CODE.indexOf("async function submitChatTrade"));
    const paper = say.slice(say.indexOf('case "paper"'), say.indexOf('case "reverted"'));
    assert.match(paper, /simulated/);
    assert.match(paper, /Your money did not move/);
    assert.ok(!/\bbought\b|\bsold\b/.test(paper));
  });

  it("AN INTENT REPORTS ITS OWN OUTCOME, not the last one that happened to run", () => {
    // Every early return in processIntentLocked leaves the PREVIOUS intent's
    // outcome standing, so a caller reading the global afterwards can be handed
    // somebody else's landed trade as the verdict on its own refusal. Cleared,
    // run and read inside the serialising chain.
    const fn = CODE.slice(CODE.indexOf("function processIntentReporting"), CODE.indexOf("async function processIntentLocked"));
    assert.match(fn, /lastTradeOutcome = null;\s*\n\s*await processIntentLocked/);
    assert.match(fn, /return lastTradeOutcome;/);
    assert.match(fn, /intentChain\.then\(step, step\)/);
    // And nothing reads the global straight after an await any more.
    assert.ok(!/await processIntent\([^)]*\);\s*\n\s*const outcome = lastTradeOutcome;/.test(CODE));
  });

  it("and a SELL whose size came out DIFFERENT says which way", () => {
    // "submitted sell 500 USDG NVDA" for a 12 USDG position is a claim the
    // ledger will never support — the trade row carries 12.
    //
    // AND IT CAN DIFFER UPWARD. A stock sell clamps DOWN to the position; a
    // bonding-curve sell discards the request and exits the whole holding,
    // which is usually MORE. The note used to be hard-coded as "less than you
    // asked for", so a full liquidation was annotated as though it had been
    // trimmed — asked and actual are now both passed and the direction derived.
    const submit = CODE.slice(CODE.indexOf("async function submitChatTrade"), CODE.indexOf("async function submitChatTransfer"));
    assert.match(submit, /if \(!partial\) sold = Number\(pos\.valueUsdg\) \/ 1e6;/);
    // `named` is the symbol as the watch set spells it (energy-buy.ts resolveOrderToken).
    assert.match(submit, /sayTradeOutcome\(outcome, side, named, usdgAmount, sold \?\? usdgAmount\)/);
    const curve = CODE.slice(CODE.indexOf("async function submitChatCurveTrade"), CODE.indexOf("function sayTradeOutcome"));
    assert.match(curve, /sayTradeOutcome\(outcome, side, symbol, usdgAmount, actual\)/);
    assert.match(CODE, /less than the \$\{asked\.toFixed\(2\)\} you asked for/);
    assert.match(CODE, /MORE than the \$\{asked\.toFixed\(2\)\} you asked for/);
  });
});

describe("the event feed names what actually happened", () => {
  it("A RESULT IS LABELLED BY ITS KIND, not always as a selftest", () => {
    // Every result used to be written into the owner's event feed as
    // `selftest: …` regardless of kind — a wrong claim about what the agent
    // did, in the one log an operator reads to work out what a fleet is doing.
    assert.match(CODE, /addEvent\(agentId, outcome\.ok \? "ok" : "err", `\$\{cmd\.kind\}: \$\{outcome\.line\}`\)/);
  });
});

describe("a verdict, not a sentence somebody reads a verdict out of", () => {
  it("EVERY PRE-WALL REFUSAL IS ok:false", () => {
    // The caller used to derive success with a regex over the first emoji of
    // the prose, which recognised three branches and missed every refusal that
    // returns before an intent is built — so all of them were recorded as
    // successes. `ok` is the sole input to the event LEVEL, and "ok" is a level
    // no surface in this app renders, so an owner refused for being paused,
    // expired, over their ceiling or in an unwatched symbol saw nothing at all.
    assert.ok(!/\/\^\(🧱\|🤔\|↩️\)\//.test(CODE), "the emoji sniff is gone");
    // The verdict rides beside `ok` as DATA (order-receipt.ts builds the
    // receipt from it); `ok` itself is still set by each path, never derived.
    assert.match(CODE, /type OrderReply = \{ ok: boolean; line: string; executionStatus\?: TradeRow\["status"\]; verdict\?: OrderVerdict \};/);
    assert.match(CODE, /const no = \(line: string\): OrderReply => \(\{ ok: false, line \}\);/);
    // Both submitters return the verdict, and the dispatch passes it straight
    // through rather than re-deriving one.
    const trade = CODE.slice(CODE.indexOf("async function submitChatTrade"), CODE.indexOf("async function submitChatTransfer"));
    assert.match(trade, /Promise<OrderReply>/);
    // (With the order's own source and deadline — order-gate.ts orderAsked.)
    assert.match(CODE, /return submitChatTrade\(side, symbol, size, asked\);/);
  });

  it("and PAPER is not a success either", () => {
    // The money did not move. An owner needs the reason more than a green tick,
    // and ok:false is what puts it on a surface they read.
    const say = CODE.slice(CODE.indexOf("function sayTradeOutcome"), CODE.indexOf("async function submitChatTrade"));
    const paper = say.slice(say.indexOf('case "paper"'), say.indexOf('case "reverted"'));
    assert.match(paper, /return no\(/);
    // Only two branches are successes, and both mean the ledger says something
    // happened: it landed, or it is genuinely in flight.
    assert.equal((say.match(/ok: true/g) ?? []).length, 2);
  });

  it("and Telegram still gets a sentence, from the same implementation", () => {
    // One implementation, adapted at the wiring — not duplicated.
    assert.match(CODE, /submitChatTrade\(side, symbol, usdg\)\.then\(\(r\) => r\.line\)/);
  });
});

describe("an unreadable market answers the order instead of starving it", () => {
  it("THE DRAIN RUNS ON A TICK THAT COULD NOT READ THE MARKET", () => {
    // The market-unreadable return sits a THOUSAND LINES above the normal
    // drain, so a queued order was not delayed by such a tick — it was skipped
    // entirely, and with the fleet rate-limited it was skipped on every tick
    // until it expired. The owner then got "never ran" eight minutes later,
    // about a problem that had nothing to do with their order. Watched exactly
    // that in production: "the market could not be read this tick (49 read(s)
    // failed)", four ticks running, over a queued buy.
    const at = CODE.indexOf("the market could not be read this tick");
    assert.ok(at > 0);
    const branch = CODE.slice(at, CODE.indexOf("return;", at) + 8);
    assert.match(branch, /const marketUnread = tickBook\.unread\("market"\);\s*if \(active\) await runQueuedCommand\(active\.agentId, marketUnread\)/);
    // The refusal those reads produce — by name, before the pause and before
    // anything is sized, with nothing reaching a submitter — is run in
    // order-gate.test.ts, and so is the same refusal for a Telegram order after
    // this tick. The reads are a required argument, and only the tick book can
    // make them (StatedReads), so a drain that states nothing to it does not
    // compile.
  });

  it("but the PROBE still runs, because it needs no market data at all", () => {
    // A pipeline probe proves the wall, the bundler and the paymaster. None of
    // that depends on a price, so an unreadable tick is no reason to refuse it.
    // The probe arm takes no flag; only the trade arm does.
    assert.match(RUN, /if \(cmd\.kind === "selftest"\) return runSelftestProbe\("dashboard"\);/);
    // The trade arm takes the tick's reads whole, and its reply is only
    // wrapped — the sentence and the verdict pass through orderOutcome untouched.
    assert.match(RUN, /if \(cmd\.kind === "trade"\) return orderOutcome\(cmd, await runOrderCommand\(cmd, reads\)\);/);
  });
});
