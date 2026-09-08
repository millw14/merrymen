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
/** The order dispatch alone. */
const ORDER = CODE.slice(CODE.indexOf("async function runOrderCommand"), CODE.indexOf("async function runSelftestProbe"));
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
    // produce. Moving the call site would break the probe; the gate belongs
    // here.
    assert.match(ORDER, /if \(isPaused\(\)\)/);
    assert.match(ORDER, /you have me paused/);
    // And the probe is NOT gated, so the two really are separate decisions.
    const probe = CODE.slice(CODE.indexOf("async function runSelftestProbe"), CODE.indexOf("async function runSelftestProbe") + 2000);
    assert.ok(!/isPaused\(\)/.test(probe));
  });
});

describe("what an argument is allowed to be, proved a second time", () => {
  it("A SIDE IS BUY OR SELL", () => {
    assert.match(ORDER, /a\.side === "buy" \|\| a\.side === "sell" \? a\.side : null/);
    assert.match(ORDER, /is not a buy or a sell/);
  });

  it("A SIZE IS FINITE AND POSITIVE — NaN and Infinity die before usdg()", () => {
    // `usdg()` on a NaN is a BigInt throw, which makes the refusal a stack
    // trace instead of a sentence. And a negative size passes every cap in the
    // wall, because every cap is an upper bound.
    assert.match(ORDER, /if \(!Number\.isFinite\(size\) \|\| size <= 0\)/);
    const check = ORDER.indexOf("Number.isFinite(size)");
    const submit = ORDER.indexOf("submitChatTrade(");
    assert.ok(check > 0 && check < submit, "checked before anything is sized");
  });

  it("A SYMBOL IS A TICKER, not a sentence or a path", () => {
    assert.match(ORDER, /\/\^\[A-Z0-9\]\{1,12\}\$\/\.test\(symbol\)/);
  });

  it("AND THE OWNER'S CEILING IS APPLIED HERE TOO, not only in the route", () => {
    assert.match(ORDER, /cfg\.telegramMaxActionUsdg/);
    const ceiling = ORDER.indexOf("telegramMaxActionUsdg");
    assert.ok(ceiling < ORDER.indexOf("submitChatTrade("), "the ceiling is checked before the order is placed");
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
    assert.match(paper, /practised/);
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
    assert.match(submit, /sayTradeOutcome\(outcome, side, symbol, usdgAmount, sold \?\? usdgAmount\)/);
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
    assert.match(CODE, /type OrderReply = \{ ok: boolean; line: string \};/);
    assert.match(CODE, /const no = \(line: string\): OrderReply => \(\{ ok: false, line \}\);/);
    // Both submitters return the verdict, and the dispatch passes it straight
    // through rather than re-deriving one.
    const trade = CODE.slice(CODE.indexOf("async function submitChatTrade"), CODE.indexOf("async function submitChatTransfer"));
    assert.match(trade, /Promise<OrderReply>/);
    assert.match(CODE, /return submitChatTrade\(side, symbol, size\);/);
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
