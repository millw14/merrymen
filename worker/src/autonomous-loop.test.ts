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

const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

const INDEX = codeOf(readFileSync(new URL("./index.ts", import.meta.url), "utf8"));
const STRATEGY = codeOf(readFileSync(new URL("./strategist/strategy.ts", import.meta.url), "utf8"));
const DRIVER = readFileSync(new URL("./strategist/driver.ts", import.meta.url), "utf8");
const TYPES = codeOf(readFileSync(new URL("./strategies/types.ts", import.meta.url), "utf8"));
const NEWS = codeOf(readFileSync(new URL("./research/news.ts", import.meta.url), "utf8"));
const ORCH = codeOf(readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8"));

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
