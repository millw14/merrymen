/**
 * THE LOOP AN OWNER ASKED FOR, and the three places it could not close.
 *
 * "My agent does research, picks a coin, uses the brain to know if it is good
 * or not, buys; then if it is happy with its profit it sells, or if it finds
 * out something along the way."
 *
 * Read as a spec, that sentence needs three things this codebase had built and
 * then not connected:
 *
 *   "happy with its profit"        → the agent must know what it PAID.
 *   "finds out something"          → a headline must be able to WAKE it.
 *   "the brain knows if it's good" → the desk must be asked about the symbols
 *                                    the agent actually trades.
 *
 * Each was one missing assignment. None of them failed loudly; all three
 * presented as an agent that simply held.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * Source with LF endings whatever the checkout did to them. Git on Windows
 * defaults to core.autocrlf=true, so the working tree holds CRLF, and a literal
 * \n written into an assertion below misses by one invisible character. codeOf()
 * already normalises as it splits; the read that skips it — the prompt, kept
 * whole because the assertions are about its prose — has to say so itself.
 */
const srcOf = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

const INDEX = codeOf(srcOf("./index.ts"));
const STRATEGY = codeOf(srcOf("./strategist/strategy.ts"));
const DRIVER = srcOf("./strategist/driver.ts");
const TYPES = codeOf(srcOf("./strategies/types.ts"));
const NEWS = codeOf(srcOf("./research/news.ts"));
const ORCH = codeOf(srcOf("./orchestrator.ts"));

describe("am I happy with my profit", () => {
  it("A HOLDING CARRIES WHAT IT COST, not only what it is worth", () => {
    // Without an entry price, "should I take this profit" is a question the
    // agent cannot answer about itself — and there is no take-profit or
    // stop-loss without an answer. The one-shot strategist had no other route:
    // basis reached a model only through the desk tool loop, off by default.
    assert.match(TYPES, /costUsdg\?: bigint \| null;/);
    assert.match(INDEX, /const b = await getBasis\(active\.agentId, basisMode, p\.symbol\);/);
    assert.match(INDEX, /costUsdg: basisBySymbol\.get\(p\.symbol\) \?\? null,/);
  });

  it("AND AN UNKNOWN COST IS ABSENT, never zero", () => {
    // `costUsdg: 0` tells a model the entire holding is profit — the original
    // accounting bug in miniature. It has to travel as absent all the way to
    // the prompt, so the model reasons about not knowing instead of acting on
    // a number.
    assert.match(STRATEGY, /const cost = h\.costUsdg \?\? null;/);
    assert.match(STRATEGY, /cost === null\s*\?\s*\{\}/);
    assert.match(DRIVER, /costUsdg\?: number;/);
    assert.match(DRIVER, /pnlUsdg\?: number;/);
  });

  it("a read failure is null too, not a zero cost", () => {
    const block = INDEX.slice(INDEX.indexOf("const basisBySymbol"), INDEX.indexOf("const holdings = new Map"));
    assert.match(block, /catch \{\s*basisBySymbol\.set\(p\.symbol, null\);\s*\}/);
    // And a position with no ledger entry at all is null rather than 0.
    assert.match(block, /b\.qtyRaw === 0n && b\.costUsdg === 0n \? null : b\.costUsdg/);
  });

  it("and the model is TOLD it is responsible for leaving", () => {
    // The prompt listed entry discipline and said nothing about exits at all,
    // so a position once opened had no rule that ever closed it.
    assert.match(DRIVER, /YOU ARE ALSO RESPONSIBLE FOR LEAVING/);
    assert.match(DRIVER, /take a profit that is worth taking, cut\n {2}a loss that is running/);
    assert.match(DRIVER, /A position\n {2}you never close is not a decision you deferred, it is a decision you made/);
    // And told what an absent cost means, so it cannot read it as zero.
    assert.match(DRIVER, /you do not know\n {2}whether you are up on it, and you must not assume you are/);
  });
});

describe("or if it finds out something along the way", () => {
  it("A HEADLINE CAN NOW WAKE THE AGENT", () => {
    // brain-trigger has always carried a `news-event` reason keyed on this
    // value changing, and no caller ever set it — so it was permanently null,
    // the reason could never be a candidate, and a breaking story could not
    // cause a decision however material it was.
    assert.match(INDEX, /newsKey: desk\.topId,/);
    assert.match(NEWS, /topId: string \| null;/);
    // The story's own id, so the same one does not re-fire when the prose
    // around it changes, and a different one fires even if it reads the same.
    assert.match(NEWS, /topId: chosen\[0\]\?\.id \?\? null,/);
  });

  it("and no story means no key, rather than a key meaning no story", () => {
    assert.match(NEWS, /const empty = \{ news: null, newsSentiment: null, itemCount: 0, sentiment: null, topId: null \};/);
  });
});

describe("the desk is asked about what the agent actually trades", () => {
  it("A TENANT WHO SAVED NOTHING STILL HAS A UNIVERSE", () => {
    // The set used to happen AFTER the early return, so a tenant who never
    // opened the settings screen was recorded as having an empty universe —
    // while the child falls back to the default basket and reasons about those
    // symbols all day. The desk's filter then matched nothing and the news lens
    // reported "nobody ever asked" for every symbol the agent holds, on ticks
    // where the fetch had succeeded and the stories were in the file.
    const fn = ORCH.slice(ORCH.indexOf("async function writeSettingsForChild"), ORCH.indexOf("Write the tenant's accounting anchor"));
    const set = fn.indexOf("tenantWatchSymbols.set");
    const early = fn.indexOf("if (!settings) return null;");
    assert.ok(set > 0 && early > 0, "both must still be there");
    assert.ok(set < early, "the universe must be recorded BEFORE the early return");
    assert.match(fn, /equitySymbols\(settings\?\.basketSymbols \?\? \[\.\.\.DEFAULT_BASKET_SYMBOLS\]\)/);
  });

  it("and it is resolved the same way the child resolves it", () => {
    // Not a second, looser list — the same one, so the orchestrator's picture
    // of a tenant's universe matches what that tenant actually trades.
    assert.match(ORCH, /DEFAULT_BASKET_SYMBOLS/);
    assert.equal((ORCH.match(/tenantWatchSymbols\.set\(/g) ?? []).length, 1, "one place, not two");
  });
});

/**
 * "BUYS; THEN IF IT IS HAPPY WITH ITS PROFIT IT SELLS" — and never buys what it
 * can never sell. The entry gates (entry-gates.ts) close that loop in two
 * halves, and both have to be wired where the tick actually runs:
 *
 *   the HINT  — every strategy is handed the gates, from the limits the wall
 *               judges, so the builtins never propose a buy it refuses;
 *   the BACKSTOP — anything that proposes one anyway gets ONE rejected row per
 *               (venue, token, rule) per arm, and every repeat is withheld
 *               before a decision row, a claim or a reservation exists.
 */
describe("and it never buys what it can never sell", () => {
  const loop = INDEX.slice(INDEX.indexOf("for (const [proposedAt, intent] of proposed.entries())"));

  it("THE SNAPSHOT CARRIES THE GATES, built from the limits checkPolicy reads", () => {
    const snap = INDEX.slice(INDEX.indexOf("const snap: Snapshot = {"), INDEX.indexOf("depth: await depthReader.read("));
    assert.match(snap, /entryGates: entryGatesOf\(active\.limits\),/);
    assert.match(TYPES, /entryGates\?: EntryGates \| null;/);
  });

  it("ONE ROW PER ARM: the backstop sits after countsAsEntry and before every claim and the decision row", () => {
    const at = (needle: string) => {
      const i = loop.indexOf(needle);
      assert.ok(i >= 0, `${needle} is still in the proposal loop`);
      return i;
    };
    const entry = at("const entry = countsAsEntry(");
    const backstop = at("if (entry && entryGateRows.withhold(intent, active.limits)) continue;");
    assert.ok(entry < backstop, "an exit is never asked — `entry` decides first");
    assert.ok(backstop < at("tgClaimGroupEntry(intent)"), "before a group claim is spent");
    assert.ok(backstop < at("await claimEntry()"), "before energy is claimed");
    assert.ok(backstop < at("await ensureDecision("), "before a decision row is written");
  });

  it("THE ROW IS SPENT BY THE ROW: settle sits after processIntentReporting, past every door that can stop an entry", () => {
    const at = (needle: string) => {
      const i = loop.indexOf(needle);
      assert.ok(i >= 0, `${needle} is still in the proposal loop`);
      return i;
    };
    const settle = at("entryGateRows.settle(intent, active.limits, facts);");
    // Every `continue` between the backstop and the wall — a refused group
    // claim, closed energy, a failed decision row — comes first, so none of
    // them can spend the one row with nothing written.
    assert.ok(at("if (groupEntry?.group && !groupEntry.ok) continue;") < settle);
    assert.ok(at("await withholdEntry(agentId);") < settle);
    assert.ok(at("if (!stamped.ok) {") < settle);
    assert.ok(at("const facts = await processIntentReporting(intent, equityUsdg, !bookIncomplete);") < settle, "with what the wall wrote");
    assert.ok(settle < at("const exits = await proposeClassExits();"), "in the strategy loop, not the class route");
    assert.equal((INDEX.match(/entryGateRows\.settle\(/g) ?? []).length, 1);
  });

  it("and the latch is cleared at every arm, beside suppressedIntents", () => {
    assert.match(INDEX, /suppressedIntents\.clear\(\);\s*entryGateRows\.clear\(\);/);
    assert.equal((INDEX.match(/entryGateRows\.withhold\(/g) ?? []).length, 1, "one backstop, in the one loop");
  });
});
