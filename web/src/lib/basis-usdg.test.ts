/**
 * THE ONE MONEY COLUMN THAT IS NOT IN THE UNIT ITS NAME SAYS.
 *
 * `cost_basis.cost_usdg` is a decimal string of the worker's bigint cost in
 * MICRO-USDG — text because that is the only lossless way to carry a bigint
 * through SQLite and Postgres alike, micro because that is the unit the basis
 * arithmetic is done in. Every other money column a page reads — `value_usdg`,
 * `equity_usdg`, `amount_usdg` — is a REAL in whole USDG.
 *
 * So `Number(row.cost_usdg)` is off by a factor of a million, and it does not
 * look like an error: it renders as a position that cost $8,332,500 and is now
 * worth $8.32. Every holding down 99.99%, on the public agent page and the token
 * page, indefinitely, with no exception and no empty state to notice.
 *
 * This is the failure `venues/pons-price.ts` writes down against itself —
 * "carrying the 8dp number under a 6dp name would let a $250 curve clear a
 * $25,000 floor". The remedy is the same one: convert once, in one named place,
 * and pin the number that proves which unit is which.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { basisUsdg } from "./basis-usdg";

describe("the ledger's basis column is micro-USDG", () => {
  it("A REAL PRODUCTION ROW: 8332500 IS $8.33, NOT $8,332,500", () => {
    // Read off an owner's book. The trade was 8.3325 USDG and the position is
    // marked at 8.32 — the two figures have to be comparable, or the unrealised
    // return computed from them is −99.99% on a flat position.
    assert.equal(basisUsdg("8332500"), 8.3325);
    const value = 8.319616;
    const pnlPct = ((value - basisUsdg("8332500")!) / basisUsdg("8332500")!) * 100;
    assert.ok(Math.abs(pnlPct) < 1, `a flat position must read as flat, got ${pnlPct}%`);
  });

  it("and it accepts the number form as well as the string", () => {
    // SQLite hands back the TEXT column as a string; a Postgres driver may
    // widen it. Both are the same quantity and neither may change the unit.
    assert.equal(basisUsdg(8332500), 8.3325);
  });
});

describe("what it refuses to turn into a number", () => {
  it("NULL STAYS NULL — unknown is not free", () => {
    // A holding with no basis on record has an unknown entry price. Zero would
    // say it was free, and the return computed from it is infinite rather than
    // absent — which is the accounting bug this whole area exists downstream of.
    assert.equal(basisUsdg(null), null);
    assert.equal(basisUsdg(undefined), null);
  });

  it("and so does anything that is not a positive number", () => {
    // A zero row is what `setBasis` writes when it closes a position, and an
    // unparseable one is a column that did not answer. Neither is a cost.
    assert.equal(basisUsdg("0"), null);
    assert.equal(basisUsdg("-1"), null);
    assert.equal(basisUsdg("not a number"), null);
    assert.equal(basisUsdg(""), null);
  });
});

describe("every reader goes through it", () => {
  it("NO PAGE PARSES THE COLUMN ITSELF", async () => {
    // Three surfaces read this column and all three had the same bug. A fourth
    // written the obvious way would have it too, which is the only reason this
    // test reads source rather than behaviour.
    const { readFileSync } = await import("node:fs");
    for (const f of ["./read-agent.ts", "./read-token.ts", "../app/api/feed/route.ts"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      assert.match(src, /basisUsdg\(/, `${f} must convert through basisUsdg`);
      assert.ok(
        !/Number\(\s*(r|p)\.cost_usdg\s*\)/.test(src),
        `${f} parses cost_usdg directly — that is the micro-USDG bug`,
      );
    }
  });

  it("and the browser is handed whole USDG, not the raw column", async () => {
    // The terminal cannot import the ledger module (it opens a database), so
    // the conversion has to happen at the API boundary or not at all.
    const { readFileSync } = await import("node:fs");
    const live = readFileSync(new URL("../terminal/live.ts", import.meta.url), "utf8");
    assert.match(live, /cost_usdg\?:number\|null/, "the wire type says a number in whole USDG");
  });
});
