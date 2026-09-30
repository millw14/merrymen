/**
 * THE FEED IS ASKED FOR EVERY TEN SECONDS — so the route must answer freshly,
 * and cheaply.
 *
 * Freshly: the browser's cache held the answer for fifteen seconds with a
 * minute's stale-while-revalidate on top, so a ten-second poll would have been
 * answered with the previous poll's bytes. Cheaply: the route is force-dynamic,
 * so without a shared read every open tab would run the grouped ledger query
 * six times a minute.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { THESES_CACHE_CONTROL, THESES_FRESH_MS, thesesMemo } from "./theses-memo";
import { THESES_EVERY_MS } from "../terminal/refresh-loop";

const seconds = (directive: string) => {
  const m = THESES_CACHE_CONTROL.match(new RegExp(`(?:^|,)\\s*${directive}=(\\d+)`));
  return m ? Number(m[1]) * 1000 : 0;
};

describe("what a cache in front of /api/theses may do", () => {
  it("a poll every ten seconds is never answered from the browser's copy of the last one", () => {
    // Browsers honour stale-while-revalidate too: a response inside that
    // window is served from cache while it revalidates in the background.
    const browserMayServe = seconds("max-age") + seconds("stale-while-revalidate");
    assert.ok(browserMayServe < THESES_EVERY_MS, `the browser may reuse a response for ${browserMayServe}ms`);
  });

  it("a shared cache keeps it for between five and ten seconds", () => {
    const shared = seconds("s-maxage");
    assert.ok(shared >= 5_000 && shared <= 10_000, `s-maxage is ${shared}ms`);
  });
});

describe("one ledger read per few seconds, however many tabs ask", () => {
  function reader() {
    let clock = 0;
    const pending: Array<(v: { source: string; n: number }) => void> = [];
    const memo = thesesMemo(
      () => new Promise<{ source: string; n: number }>((r) => pending.push(r)),
      () => clock,
    );
    return { memo, pending, advance: (ms: number) => (clock += ms) };
  }

  it("callers that arrive while a read runs share it", async () => {
    const { memo, pending } = reader();
    const a = memo.get();
    const b = memo.get();
    assert.equal(pending.length, 1, "two tabs, one query");
    pending[0]!({ source: "sqlite", n: 1 });
    assert.deepEqual([(await a).n, (await b).n], [1, 1]);
  });

  it("an answer is shared for its few seconds, and then read again", async () => {
    const { memo, pending, advance } = reader();
    const first = memo.get();
    pending[0]!({ source: "sqlite", n: 1 });
    await first;
    advance(THESES_FRESH_MS - 1);
    assert.equal((await memo.get()).n, 1);
    assert.equal(pending.length, 1);
    advance(1);
    const next = memo.get();
    assert.equal(pending.length, 2, "past its life, the next caller reads again");
    pending[1]!({ source: "sqlite", n: 2 });
    assert.equal((await next).n, 2);
  });

  it("an unreadable ledger is not kept — the next caller asks again", async () => {
    const { memo, pending } = reader();
    const first = memo.get();
    pending[0]!({ source: "none", n: 0 });
    await first;
    void memo.get();
    assert.equal(pending.length, 2, "an outage is not published for the memo's whole life");
  });
});
