/**
 * "IT SAYS 20688d WHILE WHEN I CLICK THE AGENT ITSELF IT TELLS THE TRADE WAS 2
 * MINUTES AGO."
 *
 * Reported from the beta with a screenshot of the Latest activity list:
 *
 *     Cronus tried to buy KNIGHT  [paper]  — the wall turned it back   20688d
 *
 * 20,688 days is about fifty-six years, which put the trade in 1970 — the shape
 * of a zero. It was not a zero. `Thesis.at` is epoch SECONDS, the publisher says
 * so, and the rail handed it to a formatter whose other argument was
 * `Date.now()` in MILLISECONDS. The subtraction produced roughly the current
 * epoch, divided by a day, so EVERY row printed the same number regardless of
 * its real age. (A genuinely missing value would have printed 20709d on the day
 * this was reported — which is how the zero hypothesis was ruled out.)
 *
 * The agent screen was right the whole time because it goes through a different
 * formatter, `ageOf`, which normalises units. Two rails, one fact, one of them
 * guessing.
 *
 * WHY THERE WAS NO TEST. `whenOf` was private to `wire.tsx`, and the runner
 * globs `*.test.ts` — there is not one `.test.tsx` in this repo — so nothing in
 * that file was reachable from a test at all. `format.test.ts` exercises
 * `elapsed` only with hand-built millisecond literals (`now - 59_000`), which
 * can never catch a caller passing the wrong unit, and pins `ageOf`, the
 * function that was already correct. The fix moved `whenOf` into `clock.ts`;
 * this file is what that move was for.
 *
 * EVERY CASE BELOW STARTS FROM A REAL `Thesis.at` IN PUBLISHER UNITS and goes
 * through `beatsOf`, because the defect lived in the conversion between them and
 * a test built on literals would have reproduced the blind spot it exists to
 * close.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { beatsOf, lanesOf } from "./beat";
import { whenOf } from "./clock";
import { ageOf, type LiveAgent, type Thesis } from "./live";

/** A published row, exactly as `/api/theses` serves one. */
const t = (over: Partial<Thesis> = {}): Thesis =>
  ({
    name: "Cronus",
    slug: "cronus",
    handle: "@cronus",
    action: "buy",
    symbol: "KNIGHT",
    sizeUsdg: 5,
    reason: null,
    paper: true,
    head: "would buy KNIGHT 5.00 USDG",
    ...over,
  }) as Thesis;

const agent = (over: Partial<LiveAgent> = {}): LiveAgent =>
  ({
    slug: "cronus",
    name: "Cronus",
    handle: "@cronus",
    owner: null,
    pnlBps: null,
    curve: [],
    landed: 0,
    last: null,
    glance: { id: "custom", label: "Strategy" },
    thesis: "",
    ...over,
  }) as LiveAgent;

/** A fixed wall clock, so the arithmetic is checkable by hand. */
const NOW_MS = Date.UTC(2026, 8, 13, 12, 0, 0);
const NOW_SEC = Math.floor(NOW_MS / 1000);

describe("the feed rail and the agent screen agree about one row's age", () => {
  it("A TWO-MINUTE-OLD TRADE READS AS TWO MINUTES, not as fifty-six years", () => {
    const [beat] = beatsOf([t({ at: NOW_SEC - 120 })], [agent()]);
    assert.ok(beat);
    assert.equal(whenOf(beat.atMs, NOW_MS), "2m");
  });

  it("AND THE TWO SCREENS DO NOT DISAGREE ABOUT IT — the reporter's sentence, as an assertion", () => {
    // Pinned as a RELATIONSHIP rather than as two separate expected strings, so
    // a future divergence fails whichever side drifts. That is the property the
    // owner actually observed: not "the number is wrong" but "these two screens
    // tell me different things about the same trade."
    for (const agoSec of [30, 120, 3 * 3600, 5 * 86_400]) {
      const row = t({ at: NOW_SEC - agoSec });
      const [beat] = beatsOf([row], [agent()]);
      assert.ok(beat);
      const rail = whenOf(beat.atMs, NOW_MS);
      const screen = ageOf(row, NOW_MS);
      // `whenOf` says "now" under a minute where `ageOf` gives the seconds;
      // everywhere else they must be the same words.
      if (agoSec >= 60) assert.equal(rail, screen, `${agoSec}s ago`);
      else assert.equal(rail, "now");
    }
  });

  it("the conversion happens once, at the seam, and ids keep their old shape", () => {
    // `Beat.id` is a React key and re-basing it to milliseconds would churn
    // every key in the feed for a cosmetic fix, so it stays built from seconds.
    const [beat] = beatsOf([t({ at: NOW_SEC - 120 })], [agent()]);
    assert.ok(beat);
    assert.equal(beat.atMs, (NOW_SEC - 120) * 1000);
    assert.match(beat.id, new RegExp(`-${NOW_SEC - 120}$`));
  });
});

describe("a quiet stretch finally shows as one", () => {
  it("A FOUR-HOUR GAP IS A LULL — unreachable dead code until the units were fixed", () => {
    // `LULL_MS` is three hours in milliseconds and it was compared against a
    // difference in SECONDS, so the divider needed a 125-day gap against a feed
    // window of 24 hours. It could never render. Same root cause, found while
    // reading for the one above.
    const lanes = lanesOf(
      beatsOf(
        [t({ at: NOW_SEC }), t({ at: NOW_SEC - 4 * 3600, symbol: "CRUMBS" })],
        [agent()],
      ),
    );
    assert.ok(lanes.some((l) => l.kind === "lull"), "a four-hour gap is a lull");
  });

  it("but a few minutes is not", () => {
    const lanes = lanesOf(
      beatsOf(
        [t({ at: NOW_SEC }), t({ at: NOW_SEC - 180, symbol: "CRUMBS" })],
        [agent()],
      ),
    );
    assert.ok(!lanes.some((l) => l.kind === "lull"));
  });
});

describe("a row with no timestamp has no age", () => {
  it("AND `said` IS NOT A FALLBACK FOR IT — it is a repeat count", () => {
    // `ageOf` read `t.at ?? t.said` under a comment claiming `said` was
    // "seconds-ago". It is how many times the thesis was said in the window,
    // rendered elsewhere as ×3. On a row with no `at` this formatted a count as
    // a time.
    assert.equal(ageOf(t({ at: undefined, said: 3 }), NOW_MS), "");
  });

  it("and `beatsOf` drops it rather than inventing one", () => {
    assert.deepEqual(beatsOf([t({ at: undefined })], [agent()]), []);
  });
});
