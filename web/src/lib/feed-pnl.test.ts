import assert from "node:assert/strict";
import { test } from "node:test";
import { pnlBasisOf } from "./feed-pnl";

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
