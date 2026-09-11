/**
 * A CLASS POSITION CAN BE CLOSED. Before this, none could.
 *
 * `proposeClassEntries` was the ONLY producer in the repo that could set an
 * intent's `target` to the class vault, and it only ever builds a buy —
 * verified by grepping every `kind: "curve-trade"` producer and every
 * `target:` assignment. `buildClassSellCalls` and the executor's sell arm both
 * existed and were reachable only from a test. So the route could open a
 * position that nothing in the system could ever close.
 *
 * That is not an unfinished feature, it is a trapdoor, and these tests exist so
 * it cannot be reopened. They are read against the source because the producer
 * is a closure over worker state that a unit test cannot construct; what can be
 * pinned is that the exit exists, that it is driven, and that each of its
 * refusals fails in the safe direction.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { SETTINGS_DEFAULTS } from "../../packages/core/src/index";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(path.join(__dirname, "index.ts"), "utf8");
const STORE = readFileSync(path.join(__dirname, "store.ts"), "utf8");

/** The body of a top-level function in index.ts, comments stripped. */
function bodyOf(decl: string, endMarker: string): string {
  const at = INDEX.indexOf(decl);
  assert.ok(at > -1, `${decl} must exist`);
  const end = INDEX.indexOf(endMarker, at);
  assert.ok(end > at, `could not bound ${decl}`);
  return INDEX.slice(at, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const EXIT = bodyOf("async function proposeClassExits", "\n  function curveLegsNow");

describe("the exit exists and is driven", () => {
  it("there is a producer that targets the vault with a SELL", () => {
    assert.match(EXIT, /kind:\s*"curve-trade"/, "the exit must emit a curve trade");
    assert.match(EXIT, /target:\s*vault/, "it must target the class vault, not the adapter");
    // assetIn is the held TOKEN and assetOut is the quote — the opposite of the
    // entry. Getting these round the wrong way would read a memecoin balance as
    // a USDG amount.
    assert.match(EXIT, /assetIn:\s*p\.token/, "the input leg is the token being sold");
    assert.match(EXIT, /assetOut:\s*p\.quoteToken/, "the output leg is the quote asset");
  });

  it("the tick actually calls it — an unreferenced producer is the bug repeated", () => {
    // curveLegsNow spent weeks declared, forwarded and never supplied. The
    // lesson is in curve-wiring.test.ts and applies exactly here.
    assert.match(INDEX, /for \(const intent of await proposeClassExits\(\)\)/, "exits must be driven from the tick");
  });

  it("exits run BEFORE entries, because only one of them has a deadline", () => {
    // Both draw on the same per-tick, daily and ops budgets. A tick that spends
    // its allowance opening a position cannot then close one whose curve is
    // about to graduate — and after graduation the vault can never sell it.
    const exitAt = INDEX.indexOf("await proposeClassExits()");
    const entryAt = INDEX.indexOf("await proposeClassEntries()");
    assert.ok(exitAt > -1 && entryAt > -1);
    assert.ok(exitAt < entryAt, "the way out must be attempted first");
  });

  it("sells the WHOLE balance, not a slice", () => {
    // A partial exit leaves a rump to be closed later against a thinner curve.
    assert.match(EXIT, /amountInRaw:\s*balance/, "the exit is all-or-nothing");
  });
});

describe("the two triggers are both price-free", () => {
  it("uses a clock and a graduation cliff, not a stop-loss", () => {
    // A class token has no oracle, and a rugged one has no price at all — so
    // any price-based exit is unreachable exactly when it matters most.
    assert.match(EXIT, /heldSec\s*>=\s*maxHold/, "the clock must be a trigger");
    assert.match(EXIT, /progressPct\s*>=\s*exitAtPct/, "the graduation cliff must be a trigger");
    assert.ok(!/price8|lastPrices|market\.prices/.test(EXIT), "the exit must not depend on a price");
  });

  it("holds when neither trigger has fired", () => {
    assert.match(EXIT, /if \(!aged && !graduating\) continue;/, "a fresh position is not sold");
  });

  it("the graduation threshold is read from the CURVE, never defaulted", () => {
    // curveDepthFraction divides by the threshold. A zero would make the cliff
    // meaningless, which would disarm the one trigger protecting against a
    // permanently unsellable position.
    assert.match(EXIT, /readCurveThreshold/, "the threshold comes from the contract that owns it");
  });

  it("defaults ship a real exit rather than a closed door", () => {
    // Unlike classSnipeEnabled and classPerEntryUsdg, which default shut, the
    // way OUT must be on by default — a route whose exit defaults to zero is
    // the trapdoor again, wearing a setting.
    assert.ok((SETTINGS_DEFAULTS.classMaxHoldSec ?? 0) > 0, "a hold window must be set");
    const pct = SETTINGS_DEFAULTS.classExitAtGraduationPct ?? 0;
    assert.ok(pct > 0 && pct < 100, "the cliff must leave margin before graduation");
  });
});

describe("every refusal fails in the safe direction", () => {
  it("an unreadable position list does NOT read as nothing held", () => {
    // null is "could not tell". Treating it as an empty book would skip every
    // exit precisely when the database is unwell.
    assert.match(EXIT, /if \(held === null\) return \[\];/);
  });

  it("refuses to sell blind when the curve cannot be read", () => {
    // No reserves means no slippage floor, and a floorless sell into a curve
    // nobody can see is how a position leaves for nothing.
    assert.match(EXIT, /if \(!reserves\)/, "an unreadable curve must not be sold into");
    assert.match(EXIT, /continue;/);
  });

  it("refuses on unknown quote decimals rather than assuming 18", () => {
    // A wrong decimals figure misprices the floor by orders of magnitude.
    assert.match(EXIT, /quoteDec === null/, "unknown decimals must be treated as unreadable");
  });

  it("skips a zero balance, so a swept or already-sold row cannot loop", () => {
    assert.match(EXIT, /if \(balance <= 0n\) continue;/);
  });

  it("tells the owner when only their own key can help", () => {
    // The two cases the agent genuinely cannot fix — no curve on record, and a
    // dead curve — must name `merrymen recover`, because an owner cannot guess
    // that the way out is their own key.
    assert.match(EXIT, /merrymen recover/, "an unexitable position must name the owner's remedy");
  });

  it("has NO impact ceiling, unlike the entry", () => {
    // Deliberate asymmetry: refusing an exit for being expensive locks in the
    // position that most needs to close. The slippage floor still binds.
    assert.ok(!/maxImpactBps/.test(EXIT), "an exit must not be abandoned for being costly");
  });
});

describe("the hold clock is real and cannot be reset", () => {
  it("classPositions selects first_seen", () => {
    assert.match(STORE, /SELECT token, symbol, decimals, curve, quote_token, first_seen FROM class_positions/);
  });

  it("a null clock reads as NOW, never as 1970", () => {
    // Zero would make every position instantly older than any window and force
    // an immediate sale of somebody's whole book.
    assert.match(STORE, /firstSeen: r\.first_seen \?\? Math\.floor\(Date\.now\(\) \/ 1000\)/);
  });

  it("the writer cannot supply a clock, so an upsert cannot rejuvenate a position", () => {
    // The row is re-recorded on every landed buy of the same token. If the
    // caller set first_seen, a position topped up often would never age out.
    assert.match(STORE, /row: Omit<ClassPositionRow, "firstSeen">/);
  });
});
