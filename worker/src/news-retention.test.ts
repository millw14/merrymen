import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coveredSymbols, retainAsked } from "./research-pass";
import { NEWS_WINDOW_SEC } from "./research/news";
import { newsDesk } from "./research/news";

/**
 * A SYMBOL'S NEWS MUST NOT VANISH BECAUSE THE NEXT WINDOW ASKED ABOUT SOMETHING
 * ELSE.
 *
 * The desk names at most three symbols per request against a 25-symbol
 * universe, so any given name is in the ask roughly one window in eight. `items`
 * were already merged across windows — a previous fix, because a sentiment
 * reading needs three scored articles from two publishers about ONE symbol and
 * no single request ever returns that. But `asked` was still replaced, and
 * `news.ts` checks `asked` FIRST and returns a null reading for anything absent
 * from it. So the stories the desk had paid for were not deleted, merely
 * unreachable, and the lens reported no-data anyway.
 *
 * Production showed exactly this: the first live fetch asked AAPL, MU and SPCX
 * while the default basket is QQQ, NVDA and TSLA.
 *
 * Coverage is now a WINDOW rather than a window's ask — merged, and expired on
 * the same 24h clock as the stories, so the desk can never claim a stale ask is
 * current. The budget is untouched: same slot count, same request, same ledger.
 */
const HOUR = 3600;

describe("coverage survives a window that asked about other names", () => {
  it("THE CASE FROM PRODUCTION: asked NVDA, then asked AAPL — NVDA is still covered", () => {
    const t0 = 1_000_000;
    let askedAt = retainAsked({}, ["QQQ", "NVDA", "TSLA"], t0, NEWS_WINDOW_SEC);
    // The scheduler rotates on. Under the old rule this replaced the list and
    // QQQ/NVDA/TSLA became `not-fetched` with their stories still in the cache.
    askedAt = retainAsked(askedAt, ["AAPL", "MU", "SPCX"], t0 + HOUR, NEWS_WINDOW_SEC);
    const covered = coveredSymbols(askedAt);
    for (const sym of ["QQQ", "NVDA", "TSLA", "AAPL", "MU", "SPCX"]) {
      assert.ok(covered.includes(sym), `${sym} must still be covered`);
    }
  });

  it("and the reading actually comes back, rather than not-fetched", () => {
    // The property end to end: the consumer gate is what discarded the material,
    // so it is the consumer that has to be shown changing its answer.
    const asOf = 1_000_000 + HOUR;
    const items = [
      {
        id: "n1",
        source: "pub-a",
        publishedAt: asOf - 600,
        headline: "NVDA ships a thing",
        summary: null,
        url: "https://example.invalid/1",
        symbols: ["NVDA"],
        relevance: 0.9,
        sentiment: 0.4,
      },
    ];
    const lastWindowOnly = newsDesk({
      symbol: "NVDA",
      asOf,
      asked: ["AAPL", "MU", "SPCX"],
      failure: null,
      items,
    });
    assert.equal(lastWindowOnly.coverage, "not-fetched", "this is the bug, pinned");
    assert.equal(lastWindowOnly.itemCount, 0, "and the story was right there");

    const merged = newsDesk({
      symbol: "NVDA",
      asOf,
      asked: coveredSymbols(
        retainAsked(retainAsked({}, ["NVDA"], asOf - HOUR, NEWS_WINDOW_SEC), ["AAPL"], asOf, NEWS_WINDOW_SEC),
      ),
      failure: null,
      items,
    });
    assert.notEqual(merged.coverage, "not-fetched", "the material must now be reachable");
    assert.equal(merged.itemCount, 1);
  });
});

describe("coverage is a window, not a union of everything ever asked", () => {
  it("a stale ask expires, so the desk never claims it is current", () => {
    // Merging without expiry would trade one false statement for another: a
    // symbol nobody has asked about in three days is genuinely not-fetched.
    const t0 = 1_000_000;
    const askedAt = retainAsked({}, ["NVDA"], t0, NEWS_WINDOW_SEC);
    const later = retainAsked(askedAt, ["AAPL"], t0 + NEWS_WINDOW_SEC + 1, NEWS_WINDOW_SEC);
    assert.deepEqual(coveredSymbols(later), ["AAPL"], "NVDA must age out of coverage");
  });

  it("coverage expires on exactly the same clock the stories do", () => {
    // If the two could disagree, the desk would either claim a symbol whose
    // material is gone, or hide material it is still holding.
    const t0 = 1_000_000;
    const at = retainAsked({}, ["NVDA"], t0, NEWS_WINDOW_SEC);
    assert.ok(coveredSymbols(retainAsked(at, [], t0 + NEWS_WINDOW_SEC - 1, NEWS_WINDOW_SEC)).includes("NVDA"));
    assert.ok(!coveredSymbols(retainAsked(at, [], t0 + NEWS_WINDOW_SEC + 1, NEWS_WINDOW_SEC)).includes("NVDA"));
  });

  it("re-asking refreshes the clock rather than adding a duplicate", () => {
    const t0 = 1_000_000;
    let at = retainAsked({}, ["NVDA"], t0, NEWS_WINDOW_SEC);
    at = retainAsked(at, ["NVDA"], t0 + NEWS_WINDOW_SEC - 1, NEWS_WINDOW_SEC);
    assert.deepEqual(coveredSymbols(at), ["NVDA"]);
    // And it survives past where the ORIGINAL ask would have expired.
    assert.ok(coveredSymbols(retainAsked(at, [], t0 + NEWS_WINDOW_SEC + 1, NEWS_WINDOW_SEC)).includes("NVDA"));
  });
});

describe("the budget is untouched", () => {
  it("retention adds no symbols to any ask — it only remembers", () => {
    // The fix must not become "ask about the whole universe", which is the one
    // change that would blow the daily allowance. `retainAsked` cannot enlarge
    // an ask: it takes what the scheduler chose and records it.
    const asked = ["QQQ", "NVDA", "TSLA"];
    const at = retainAsked({ AAPL: 999_000, MU: 999_000 }, asked, 1_000_000, NEWS_WINDOW_SEC);
    // Coverage grew; the ASK did not. The caller still sent exactly `asked`.
    assert.equal(asked.length, 3, "the request is still three symbols");
    assert.ok(coveredSymbols(at).length > asked.length, "coverage may exceed one window's ask");
  });

  it("a spent allowance does not fabricate coverage", () => {
    // budget-exhausted means nothing was asked, so nothing may be stamped.
    const t0 = 1_000_000;
    const at = retainAsked({ NVDA: t0 }, [], t0 + HOUR, NEWS_WINDOW_SEC);
    assert.deepEqual(coveredSymbols(at), ["NVDA"], "prior coverage stands, nothing is added");
  });
});
