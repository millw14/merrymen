/**
 * A PAPER BOOK THAT HOLDS THE ENERGY RESERVE STILL COMPOSES A TICK.
 *
 * The paper valuation loop walks the stored book, not the watch set, and a
 * holding it cannot find in the watch set goes to `missingPrice` — the branch
 * that HOLDS the tick (no equity, no breaker, no strategy, and every queued
 * owner order answered "book unread"). The reserve is never in the watch set,
 * so a reserve row in a paper book would have frozen the agent for good.
 *
 * Defensive: no paper book can have bought $MERRYMEN (a paper fill needs a
 * price, and the worker never had one for it). These pin that such a row, if
 * it ever exists, is left outside the book the way live leaves the reserve
 * outside it — and that nothing else is dropped with it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MERRYMEN_TOKEN } from "../../packages/core/src/index";
import { paperBookPositions, type PaperPosition } from "./paper";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const shout = (a: string) => `0x${a.slice(2).toUpperCase()}` as `0x${string}`;
const PEPE = "0x00000000000000000000000000000000000ee0e0" as `0x${string}`;
const NVDA = "0x00000000000000000000000000000000000a11a1" as `0x${string}`;

describe("paperBookPositions — what the paper tick values", () => {
  it("leaves a reserve holding out of the book, in any address case", () => {
    for (const token of [MERRYMEN_TOKEN.address, shout(MERRYMEN_TOKEN.address)]) {
      const book: PaperPosition[] = [
        { symbol: "MERRYMEN", token, shares: 250_000 },
        { symbol: "NVDA", token: NVDA, shares: 1.5 },
      ];
      assert.deepEqual(paperBookPositions(book).map((p) => p.symbol), ["NVDA"], token);
    }
  });

  it("a book holding ONLY the reserve values as an empty book — nothing left to hold the tick on", () => {
    const out = paperBookPositions([{ symbol: "MERRYMEN", token: MERRYMEN_TOKEN.address, shares: 1 }]);
    assert.deepEqual(out, []);
  });

  it("a coin that merely CALLS itself MERRYMEN elsewhere is an ordinary holding and stays", () => {
    // By address, never by symbol: dropping it would erase a real position's value.
    const book: PaperPosition[] = [{ symbol: "MERRYMEN", token: PEPE, shares: 10 }];
    assert.deepEqual(paperBookPositions(book), book);
  });

  it("still drops empty rows, as the loop always did", () => {
    const book: PaperPosition[] = [
      { symbol: "NVDA", token: NVDA, shares: 0 },
      { symbol: "PEPE", token: PEPE, shares: -1 },
      { symbol: "OK", token: PEPE, shares: 2 },
    ];
    assert.deepEqual(paperBookPositions(book).map((p) => p.symbol), ["OK"]);
  });
});

describe("the paper tick's valuation loop runs through it", () => {
  const src = readFileSync(path.join(__dirname, "index.ts"), "utf8");

  it("the loop that feeds missingPrice iterates paperBookPositions(...)", () => {
    // The ONE loop whose unfound symbols become missingPrice: it reads the paper
    // multipliers just before, and pushes to missingPrice inside.
    const start = src.indexOf("const mults = await readMultipliers(mainnetClient(), watchTokens);");
    assert.ok(start > 0, "paper valuation region moved — re-anchor this pin");
    const region = src.slice(start, src.indexOf("} else {", start));
    assert.match(region, /for \(const p of paperBookPositions\(paperPositionsOf\(bookRow\.shares\)\)\)/);
    assert.match(region, /missingPrice\.push\(p\.symbol\)/, "the region must be the one that can hold the tick");
  });
});
