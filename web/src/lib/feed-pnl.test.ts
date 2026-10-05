import assert from "node:assert/strict";
import { test } from "node:test";
import { pnlBasisOf, withheldWhy } from "./feed-pnl";

test("the owner's return pairs the measured mark with what was booked by it, never the held headline", () => {
  const feed = { equity: [{ equity_usdg: 100 }, { equity_usdg: 140 }], netContributionsUsdg: 90 };
  // A server that sends the pair: the held 140 is the headline, not the numerator.
  assert.deepEqual(pnlBasisOf({ ...feed, measured: { equityUsdg: 100, at: "x", netContributionsUsdg: 100 } }), { latest: 100, contributed: 100 });
  // No measured mark yet: no numerator, and the reason stays the whole record's.
  assert.deepEqual(pnlBasisOf({ ...feed, measured: null }), { latest: null, contributed: 90 });
  // An older server without the field: the old pairing, unchanged.
  assert.deepEqual(pnlBasisOf(feed), { latest: 140, contributed: 90 });
  assert.deepEqual(pnlBasisOf(null), { latest: null, contributed: null });
  assert.deepEqual(pnlBasisOf({ equity: [] }), { latest: null, contributed: null });
});

test("withheld contributions give the public page's reason on the owner's desk, never \"no deposit\"", () => {
  assert.equal(withheldWhy({ netContributionsUsdg: null, contributionsWithheld: "review" }), "review-pending");
  assert.equal(withheldWhy({ netContributionsUsdg: null, contributionsWithheld: "unread" }), "quality-unknown");
  // Nothing withheld, or an older server without the field: rankPnl decides, as before.
  assert.equal(withheldWhy({ netContributionsUsdg: null, contributionsWithheld: null }), null);
  assert.equal(withheldWhy({ netContributionsUsdg: 100 }), null);
  assert.equal(withheldWhy(null), null);
});
