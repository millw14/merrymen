/**
 * HOW FAR THE MARKET SWEEP GOT, AND WHETHER IT SAYS SO.
 *
 * The panel read page 1 of each GeckoTerminal feed and stopped. Nothing chose
 * that: `?page=` defaults to 1, so the ceiling was a default nobody had looked
 * at. Measured on 2026-09-06 it cost roughly three quarters of the market —
 * about 19 tokens shown of 83 that clear the same screen.
 *
 * What made it survive is the property this file exists to defend: a list cut
 * short and a market that small look exactly alike on the page. So the walk has
 * to distinguish three outcomes that all produce fewer coins — the feed ended,
 * the index refused, the index refused on the very first page — and report the
 * middle one rather than let it pass as the first.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { walkFeeds } from "./read-discoveries";
import type { GeckoPool } from "../../../worker/src/venues/geckoterminal";

const pool = (id: string): GeckoPool =>
  ({
    tokenAddress: id,
    name: id,
    dex: "pons-v2-dex",
    priceUsd: 1,
    reserveUsd: 1,
    fdvUsd: null,
    volume24hUsd: 1,
    change24hPct: null,
    buyers24h: 1,
    createdAt: null,
    poolId: id,
    buckets: {} as GeckoPool["buckets"],
  }) as GeckoPool;

/** A page source: `answers[feed][page-1]`, missing entries meaning "refused". */
function source(answers: Record<string, Array<GeckoPool[] | "fail">>) {
  const calls: Array<[string, number]> = [];
  const fetchPage = async (feed: string, page: number) => {
    calls.push([feed, page]);
    const got = answers[feed]?.[page - 1];
    if (got === undefined || got === "fail") return { pools: [], failed: true };
    return { pools: got, failed: false };
  };
  return { fetchPage, calls };
}

const NO_WAIT = { gapMs: 0 } as const;

describe("the feed walk", () => {
  it("READS PAST PAGE ONE — the whole point", () => {
    // Guarding the regression directly: if this ever silently returns to one
    // page a feed, the panel shrinks to a quarter of the market and every
    // symptom of it looks like a quiet day.
    const src = source({
      trending_pools: [[pool("a")], [pool("b")], [pool("c")], [pool("d")]],
      new_pools: [[pool("e")]],
      pools: [[pool("f")]],
    });
    const seen: string[] = [];
    return walkFeeds(src.fetchPage, (p) => seen.push(p.tokenAddress), { ...NO_WAIT, pages: 4 }).then(() => {
      assert.ok(seen.includes("d"), "page 4 was never read");
      assert.deepEqual(seen.sort(), ["a", "b", "c", "d", "e", "f"]);
    });
  });

  it("goes breadth first, so a cut-off costs depth and not a whole feed", async () => {
    // Depth-first, a rate limit part way through spends the entire budget on
    // the first feed and the last one is never asked at all.
    const src = source({
      trending_pools: [[pool("a")], [pool("b")]],
      new_pools: [[pool("c")], [pool("d")]],
      pools: [[pool("e")], [pool("f")]],
    });
    await walkFeeds(src.fetchPage, () => {}, { ...NO_WAIT, pages: 2 });
    assert.deepEqual(
      src.calls.slice(0, 3).map(([f]) => f),
      ["trending_pools", "new_pools", "pools"],
      "every feed must be asked for page 1 before any is asked for page 2",
    );
    assert.deepEqual(src.calls[3], ["trending_pools", 2]);
  });

  it("an empty page ends a feed and is NOT truncation", async () => {
    // The feed ran out of coins. That is a complete answer, and reporting it as
    // a short read would make an honest empty market look like an outage.
    const src = source({
      trending_pools: [[pool("a")], []],
      new_pools: [[pool("b")], []],
      pools: [[pool("c")], []],
    });
    const r = await walkFeeds(src.fetchPage, () => {}, { ...NO_WAIT, pages: 4 });
    assert.equal(r.truncated, false);
    assert.equal(r.asked, 3);
    assert.equal(r.reached, 3);
    // And it stops asking: nothing requests page 3 of a feed that ended at 2.
    assert.equal(
      src.calls.filter(([, page]) => page > 2).length,
      0,
      "a feed that ended must not be asked again",
    );
  });

  it("A REFUSAL DEEP IN IS TRUNCATION, and the payload has to carry it", async () => {
    const src = source({
      trending_pools: [[pool("a")], "fail"],
      new_pools: [[pool("b")], [pool("c")]],
      pools: [[pool("d")], [pool("e")]],
    });
    const r = await walkFeeds(src.fetchPage, () => {}, { ...NO_WAIT, pages: 2 });
    assert.equal(r.truncated, true, "the list is short and the reader is entitled to know");
    // But the index plainly answered — this is not an unreachable index.
    assert.equal(r.reached, 3);
  });

  it("a refusal on page one is an unreachable FEED, not a truncated list", async () => {
    // asked/reached decide `indexUnreachable`, which is a claim about whether
    // the index would talk to us at all. Counting pages into it would let a
    // deep rate limit — the routine outcome — read as an outage.
    const src = source({
      trending_pools: ["fail"],
      new_pools: [[pool("b")]],
      pools: [[pool("c")]],
    });
    const r = await walkFeeds(src.fetchPage, () => {}, { ...NO_WAIT, pages: 1 });
    assert.equal(r.asked, 3);
    assert.equal(r.reached, 2);
    assert.equal(r.truncated, false, "page one is reachability, not truncation");
  });

  it("every feed refused means reached is zero — the one case that IS an outage", async () => {
    const src = source({});
    const r = await walkFeeds(src.fetchPage, () => {}, { ...NO_WAIT, pages: 3 });
    assert.equal(r.asked, 3);
    assert.equal(r.reached, 0);
  });

  it("a pool from a later page still reaches the collector", async () => {
    // The dedupe lives in the caller, so the only contract here is that every
    // pool from every page it read is handed over exactly once.
    const src = source({
      trending_pools: [[pool("a"), pool("b")], [pool("a")]],
      new_pools: [[]],
      pools: [[]],
    });
    const seen: string[] = [];
    await walkFeeds(src.fetchPage, (p) => seen.push(p.tokenAddress), { ...NO_WAIT, pages: 2 });
    assert.deepEqual(seen, ["a", "b", "a"]);
  });
});
