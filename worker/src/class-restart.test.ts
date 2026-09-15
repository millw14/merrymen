/**
 * A RESTART MUST NOT LEAVE A POSITION THAT CANNOT BE SOLD.
 *
 * `class_positions` has two producers. `upsertClassPosition` writes the
 * CANDIDATE columns — symbol, decimals, quote_token, first_seen — at buy time
 * from the intent. `writeClassLedger` writes the MONEY columns from the vault's
 * own events. A child rebuilds its sqlite on redeploy, and only the second one
 * runs on the way back up.
 *
 * So a restarted agent came back holding a position it could not exit:
 *
 *   quote_token NULL   proposeClassExits refuses the row outright — both legs
 *                      are needed to route a sell, and it says so in an event.
 *   first_seen  NOW    the column defaults to unixepoch(), so the six-hour hold
 *                      clock restarted on every redeploy. While deploys kept
 *                      happening the position could never age out.
 *
 * Both are recoverable because the chain still knows: the curve names its pair
 * token, the ERC-20 names its symbol and decimals, and the ClassBuy that opened
 * the position sits in a block with a timestamp.
 *
 * Asserted as source — `rehydrateClassRow` is a closure inside the tick with a
 * live client and store behind it, and there is no seam to call it through.
 * These pin the properties that would be silently lost.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(path.join(__dirname, "index.ts"), "utf8");
const CODE = RAW.replace(/\/\*[\s\S]*?\*\//g, " ")
  .split(/\r?\n/)
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
  .join("\n");
const STORE = readFileSync(path.join(__dirname, "store.ts"), "utf8");

const REHYDRATE = (() => {
  const start = CODE.indexOf("async function rehydrateClassRow(");
  assert.ok(start > 0, "the rehydrator must exist");
  return CODE.slice(start, CODE.indexOf("async function reconcileClassFromChain", start));
})();

describe("the reconciler restores what a rebuild lost", () => {
  it("IS CALLED for every reconciled position", () => {
    // Restoring only some rows would leave exactly the positions a restart
    // orphaned — the ones with no candidate row at all.
    assert.match(CODE, /await rehydrateClassRow\(agentId, p, client\)/);
    const write = CODE.indexOf("await writeClassLedger(agentId, {");
    const rehydrate = CODE.indexOf("await rehydrateClassRow(");
    assert.ok(write > 0 && rehydrate > write, "money columns first, then the candidate columns");
  });

  it("reads the quote token FROM THE CURVE, which is the authority", () => {
    assert.match(REHYDRATE, /functionName: "pairToken"/);
  });

  it("and never guesses one — an unreadable curve leaves it null for the next tick", () => {
    // proposeClassExits refuses a null quoteToken by name. A guessed quote asset
    // would route a sell against the wrong pair.
    const at = REHYDRATE.indexOf('functionName: "pairToken"');
    const after = REHYDRATE.slice(at, at + 400);
    assert.match(after, /catch/, "the read must be individually tolerant");
    assert.doesNotMatch(REHYDRATE, /quoteToken = ["'`]0x/, "no hard-coded fallback quote asset");
  });

  it("WRITES ONLY WHAT IS MISSING, so a buy-path row is not restated", () => {
    assert.match(REHYDRATE, /needsLegs/);
    assert.match(REHYDRATE, /if \(!needsLegs && !needsClock\) return;/);
  });

  it("and a failure here never costs the money columns", () => {
    // The caller has just reconciled cost, quantity and state from chain. A
    // throw from a repair step must not discard that.
    const tail = REHYDRATE.slice(REHYDRATE.lastIndexOf("} catch"));
    assert.match(tail, /catch/, "the whole rehydrate is wrapped");
  });
});

describe("the hold clock comes from the chain, not from the container", () => {
  it("detects a clock that is WRONG, not one that is missing", () => {
    // first_seen defaults to unixepoch(), so a rebuilt row stamps NOW and a
    // "is it absent" test would never fire.
    assert.match(STORE, /first_seen INTEGER NOT NULL DEFAULT \(unixepoch\(\)\)/);
    assert.match(REHYDRATE, /existing\.firstSeen - estimatedOpenedAt > CLASS_CLOCK_DRIFT_SEC/);
  });

  it("estimates first so a correct row costs no RPC", () => {
    assert.match(REHYDRATE, /estimatedOpenedAt/);
    const exact = REHYDRATE.indexOf("client.getBlock({ blockNumber");
    const guard = REHYDRATE.indexOf("needsClock");
    assert.ok(guard > 0 && exact > guard, "the exact block read must sit behind the estimate");
  });

  it("takes the timestamp of the block that OPENED the position", () => {
    assert.match(REHYDRATE, /client\.getBlock\(\{ blockNumber: p\.openedAtBlock \}\)/);
    assert.match(REHYDRATE, /setClassFirstSeen\(agentId, p\.token, Number\(block\.timestamp\)\)/);
  });

  it("and the clock can ONLY EVER MOVE EARLIER", () => {
    /**
     * Guarded in SQL rather than by the caller. A write that could move the
     * clock forward is a write that could postpone an exit, and the entire
     * point of a hold timer on an asset with no oracle is that it cannot be
     * postponed. Belt and braces: even a caller passing a bogus future
     * timestamp cannot extend a position's life.
     */
    assert.match(STORE, /UPDATE class_positions SET first_seen = \?/);
    assert.match(STORE, /AND first_seen > \?/, "the row is updated only when the new value is EARLIER");
  });

  it("and it is a separate function from the general upsert, deliberately", () => {
    // upsertClassPosition excludes the clock so a top-up cannot rejuvenate a
    // position past its exit. That rule stays; this is its one exception.
    assert.match(STORE, /export async function setClassFirstSeen/);
    const upsert = STORE.slice(STORE.indexOf("INSERT INTO class_positions (agent_id, token, symbol"));
    assert.doesNotMatch(upsert.slice(0, 400), /first_seen/, "the upsert must still not touch the clock");
  });
});

/**
 * COST BASIS AND REALISED P&L FOR A CLASS TRADE.
 *
 * `fillPair` gates on `symbolOfToken`, which covers the watch set and
 * STOCK_TOKENS — neither of which can contain a class token, since it postdates
 * the grant by definition. So it was undefined for every class trade, `fillPair`
 * stayed null, and `bookFill` was never called. Every bonding-curve round trip
 * this repo could produce booked NO cost basis: the sell then met
 * `prev.qtyRaw <= 0` in applyFill, returned basisUnknown, and wrote a NULL
 * realised P&L that getRealizedPnlUsdg excludes. The position was also invisible
 * to the stop floor and the take-profit.
 */
describe("a class round trip books a basis and a realised P&L", () => {
  it("ATTRIBUTES THE FILL instead of skipping it", () => {
    const at = CODE.indexOf("const curveToken = inIsUsdg ? intent.assetOut : intent.assetIn;");
    assert.ok(at > 0, "the curve fill-pair branch must exist");
    const block = CODE.slice(at, at + 400);
    assert.match(block, /symbolOfToken\(curveToken\) \?\? short\(curveToken\)/);
  });

  it("USING THE SAME KEY THE POSITION ROW USES", () => {
    /**
     * The basis is keyed by symbol. The buy path writes
     * `symbolOfToken(t) ?? short(t)` into class_positions. Any other spelling at
     * fill time books the buy under one key and looks for it under another, and
     * the realised P&L comes out as if the position appeared from nowhere.
     */
    assert.match(CODE, /symbol: symbolOfToken\(intent\.assetOut\) \?\? short\(intent\.assetOut\)/);
    const fill = CODE.indexOf("symbolOfToken(curveToken) ?? short(curveToken)");
    assert.ok(fill > 0, "and the fill path must use the identical expression");
  });

  it("and the rehydrator does NOT invent a third key from the token itself", () => {
    /**
     * A launch token's `symbol()` is attacker-controlled — it can call itself
     * USDC — and reading it here would give a rebuilt row a different key from
     * the one the buy booked under, splitting one position's basis across a
     * restart. `instrumentClassOf` is address-keyed for the same reason.
     */
    assert.match(REHYDRATE, /symbol = symbol \?\? short\(p\.token\)/);
    assert.doesNotMatch(REHYDRATE, /functionName: "symbol"/, "never read the token's own symbol");
  });

  it("and decimals stay the launchpad's shape on both producers", () => {
    assert.match(REHYDRATE, /decimals = existing\?\.decimals \?\? 18/);
    assert.match(CODE, /decimals: 18,\n\s*curve: intent\.curve/);
  });
});

/**
 * THE SELL'S LEGS MUST STILL BE CONFIRMABLE AFTER A RESTART.
 *
 * A class sell carries no asset words — the vault derives both from the curve —
 * so the mirror judges legs that are not in the calldata. `curveFor` consults
 * the official-coin constant and then `discovered_pools`, and its own docstring
 * says why that table cannot be an authority: wiped on every redeploy, pruned to
 * 5,000 rows against ~475 launches an hour. With OFFICIAL_COINS[4663] empty, a
 * restarted agent had NO confirming record and every sell was refused
 * `class-legs-unconfirmed` permanently.
 */
describe("the position record can confirm a sell's legs", () => {
  // Anchored on CODE, which has comments stripped — so the slice must start at
  // a real statement rather than at the prose that explains it.
  const ARM = (() => {
    const from = CODE.indexOf("const confirms = (r:");
    assert.ok(from > 0, "the leg-confirmation helper must exist");
    return CODE.slice(from, CODE.indexOf("class-legs-unconfirmed", from) + 600);
  })();

  it("falls back to this vault's own position row", () => {
    assert.match(ARM, /classPositions\(agentId\)/);
    assert.match(ARM, /row\?\.curve && row\.quoteToken/, "both legs or nothing");
  });

  it("and the check is not weakened — both must match curve AND quote", () => {
    assert.match(ARM, /r\.curve\.toLowerCase\(\) === intent\.curve\.toLowerCase\(\)/);
    assert.match(ARM, /r\.quoteToken\.toLowerCase\(\) === intent\.assetOut\.toLowerCase\(\)/);
  });

  it("and neither record confirming is still a refusal", () => {
    assert.match(ARM, /if \(!confirms\(ref\) && !confirms\(held\)\)/);
  });
});

/**
 * REAL ACTIVITY, AND THE DIFFERENCE BETWEEN QUIET AND UNREADABLE.
 *
 * The scorer's contract is that a null signal is a refusal. That is right for a
 * per-token measurement and wrong for a whole-tape one: if the tape query is
 * refused, NOTHING is known about ANY curve, and refusing every candidate on a
 * transient RPC error would be fail-closed in form and broken in effect.
 *
 * So the floor applies only to a tape that was actually read. A curve missing
 * from a tape we HAVE is a measured zero and is refused; a curve we could not
 * measure at all leaves the floor stood down, and the funnel says so.
 */
describe("the activity floor gates only on a tape that was read", () => {
  const ENTRY = (() => {
    const start = CODE.indexOf("async function proposeClassEntries()");
    return CODE.slice(start, CODE.indexOf("async function proposeClassExits", start));
  })();

  it("IS ALWAYS ENFORCED — an unreadable tape does not stand it down", () => {
    /**
     * The first version stood the floor down when the tape could not be read,
     * reasoning that refusing every candidate on a transient RPC error was
     * broken in effect. That was wrong, and the asymmetry is why: NOT buying is
     * always a safe action. An agent that declines for five minutes has lost
     * nothing; an agent that buys because a required check disappeared has
     * bought something nobody verified.
     */
    assert.match(ENTRY, /minRecentTrades: ACTIVITY_GATE\.minTrades/);
    assert.doesNotMatch(ENTRY, /minRecentTrades: classActivity === null \? 0/);
  });

  it("counts a curve absent from a READ tape as zero, not unknown", () => {
    assert.match(ENTRY, /classActivity === null\s*\?\s*null/);
    assert.match(ENTRY, /return a \? a\.buys \+ a\.sells : 0;/);
  });

  it("is BOUNDED and cached, so the cost is per pass and not per token", () => {
    assert.match(ENTRY, /readCurveActivity\(active\.client, MAX_ACTIVITY_BLOCKS\)/);
    assert.match(ENTRY, /CLASS_ACTIVITY_TTL_SEC/);
    assert.match(CODE, /const CLASS_ACTIVITY_TTL_SEC = 300;/);
  });

  it("and a failed refresh CLEARS the tape rather than keeping a stale one", () => {
    // Keeping the previous tally would let a buy proceed on a signal this pass
    // could not confirm.
    assert.match(ENTRY, /classActivity = tape;/);
    assert.doesNotMatch(ENTRY, /if \(tape !== null\) \{/);
  });

  it("and the owner is told the signal is UNVERIFIED, not that the market was quiet", () => {
    // When the tape is unreadable EVERY candidate is refused on activity,
    // however deep or cheap it was — so naming depth or impact would report a
    // reason that did not stop it.
    assert.match(RAW, /Still scanning — recent market activity could not be verified yet\./);
    assert.match(CODE, /activityUnknown/);
  });

  it("and that sentence is reached BEFORE the depth and impact arms", () => {
    const unknown = CODE.indexOf("a.activityUnknown");
    const depth = CODE.indexOf("passedDepth <= 0");
    assert.ok(unknown > 0 && depth > 0 && unknown < depth, "the true reason must win");
  });
});
