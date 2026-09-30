/**
 * "12s", NOT "now".
 *
 * The rail printed "now" for anything under a minute, which was the most it
 * could honestly say while the feed refreshed once a minute. The feed reads
 * every ten seconds now, so a trade twelve seconds old and one fifty-nine
 * seconds old are different facts a reader can actually be shown.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { whenOf } from "./clock";

const NOW_MS = Date.UTC(2026, 8, 23, 12, 0, 0);

describe("how long ago, on the rail", () => {
  it("prints the seconds under a minute", () => {
    assert.equal(whenOf(NOW_MS - 12_000, NOW_MS), "12s");
    assert.equal(whenOf(NOW_MS - 59_000, NOW_MS), "59s");
    assert.equal(whenOf(NOW_MS, NOW_MS), "0s", "a row stamped this instant is zero seconds old");
  });

  it("and the minutes, hours and days after that, as before", () => {
    assert.equal(whenOf(NOW_MS - 60_000, NOW_MS), "1m");
    assert.equal(whenOf(NOW_MS - 3 * 3_600_000, NOW_MS), "3h");
    assert.equal(whenOf(NOW_MS - 5 * 86_400_000, NOW_MS), "5d");
  });

  it("a clock that runs a little behind the server never prints a negative age", () => {
    assert.equal(whenOf(NOW_MS + 4_000, NOW_MS), "0s");
  });
});
