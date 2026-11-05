/**
 * THE TICK'S WIRING FOR A HELD COIN WHOSE BALANCE DID NOT READ.
 *
 * The decisions are pure and tested in unread-held.test.ts, policy's in
 * holding-unread.test.ts. What no test can boot is main() in index.ts, so its
 * wiring is pinned here over the source with comments stripped: prose about
 * the gate is not the gate. Each pin is one way the freeze, or its opposite (a
 * buy with the breaker off), comes back.
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

/** The index of a needle that must occur exactly once. */
const once = (needle: string): number => {
  const at = CODE.indexOf(needle);
  assert.ok(at >= 0, `missing: ${needle}`);
  assert.equal(CODE.indexOf(needle, at + 1), -1, `more than once: ${needle}`);
  return at;
};

describe("a Trencher vault row that fails is one coin, not the whole read", () => {
  it("THE VAULT IS READ ONCE — the raw balanceOf multicall that failed the whole read is gone", () => {
    assert.doesNotMatch(CODE, /client\.multicall\(\{\s*contracts:\s*watchTokens\.map/);
    assert.doesNotMatch(CODE, /posRead\.readFailed\s*=\s*true/, "no single row may fail the whole positions read");
    once("autoTrenchBalances = new Map(custodyRead.balances);");
    // Whole failures of either read still join; per-row failures are per token.
    once("posRead.readFailed ||= custodyRead.readFailed;");
    once("posRead.unreadBalances.push(...custodyRead.unreadBalances);");
  });

  it("the vault's cost() read is caught and seeds nothing, never a zero", () => {
    assert.match(
      CODE,
      /functionName:"cost",args:\[p\.token\]\}\)\s*\.catch\(\(\) => null\);\s*if \(cost === null\) \{/,
    );
  });

  it("the vault's USDG read is caught and becomes a NAMED gap that holds the tick", () => {
    assert.match(CODE, /functionName:"balanceOf",args:\[autoTrench\.custody\.vault\]\}\)\s*\.catch\(\(\) => null\);/);
    once("if (vaultCash === null) trencherCashUnread = true;");
  });
});

describe("an unread held coin makes the book incomplete, and leaves it whole", () => {
  it("STRIPPED BEFORE ANYTHING VALUES IT — before the unpriced set is published and before the quarantine", () => {
    const strip = once("withoutUnreadHeld({ positions, missingPrice, unpricedByDesign }, unreadHeld)");
    assert.ok(strip < once("lastUnpricedSymbols = new Set(unpricedByDesign);"));
    assert.ok(strip < once("const quarantine = quarantineOf("));
  });

  it("THE WALL'S SET IS ASSIGNED ONCE PER TICK, BEFORE EITHER EARLY RETURN", () => {
    const assign = once("heldUnreadNow = heldUnreadOf(unreadHeld, watchTokens);");
    assert.ok(assign < once("if (unreadBook.length) {"));
    assert.ok(assign < once("if (missingPrice.length) {"));
    assert.ok(assign > CODE.indexOf("const gaps = classifyBookGaps({"), "after the gaps are classified");
  });

  it("EVERY INTENT IS JUDGED AGAINST IT — both AgentState builders carry it", () => {
    assert.equal(CODE.match(/heldUnread: heldUnreadNow,/g)?.length, 2, "perpAgentState and processIntentLocked");
  });

  it("the strategies are told, and the durable row is kept", () => {
    once("...(unreadHeld.length > 0 ? { unreadHeld: new Set(unreadHeld) } : {}),");
    // setPositions' trailing `keep` is the unread set.
    assert.match(CODE, /valueUsdg: usdgNum\(p\.valueUsdg\),\s*\}\)\),\s*unreadHeld,\s*\);/);
    once("tgNoteHeld(positions, [...missingPrice, ...unpricedByDesign, ...unreadHeld]);");
  });

  it("LAST LIVE HELD IS LIVE ONLY, and never read from the positions table", () => {
    once("if (!paper) lastLiveHeld = new Set([...positions.map((p) => p.symbol), ...unpricedByDesign, ...unreadHeld]);");
    assert.doesNotMatch(CODE, /lastLiveHeld = [^;]*getPositions/);
  });

  it("the heartbeat and the shown figure go through the pure helpers", () => {
    once("shownEquity = shownEquityOf({");
    once("drawdownBps: heartbeatDrawdownBps({");
  });
});

describe("an order for the unread coin is refused before it is sized", () => {
  it("submitChatTrade asks unreadHoldingOrder before the kept row is read and before a curve is tried", () => {
    const start = once("async function submitChatTrade(");
    const ask = once("const unreadSale = unreadHoldingOrder(side, named, heldUnreadNow.symbols);");
    assert.ok(ask > start);
    assert.ok(ask < CODE.indexOf("if (await curveFor(token)) return submitChatCurveTrade(", start));
    assert.ok(ask < CODE.indexOf("readPositionRaw(active.agentId, named, usdg)", start));
    // energy-buy-wiring.test.ts looks for this literal.
    assert.ok(CODE.indexOf("tickBook.judge(side)", start) < ask);
  });
});
