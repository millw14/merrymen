/**
 * THE SESSION CHANGE BESIDE EACH STOCK, AGAINST A CHART VENUE THAT IS DOWN —
 * driven with a fake network and a fake wall clock, because the property is how
 * many requests reach the venue, and when.
 *
 * loadSessionChanges asked the venue once per stock, four at a time, and kept
 * only a pass that read something. A pass that read nothing was not kept at
 * all, so while the venue was down every caller sent one request per stock
 * straight back at it: twenty-five at a time, every time the shell asked.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import type { LiveToken } from "./live";
import { loadSessionChanges } from "./quotes";

const realFetch = globalThis.fetch;
let now = 1_800_000_000_000;
beforeEach(() => {
  // The pass is kept in the module, so each test starts an hour past whatever
  // the one before it kept.
  now += 3_600_000;
  mock.method(Date, "now", () => now);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restoreAll();
});

const stock = (symbol: string): LiveToken =>
  ({
    id: `0x${symbol.toLowerCase()}`,
    symbol,
    name: symbol,
    logo: "",
    priceUsd: 100,
    change24hPct: null,
    fdvUsd: null,
    holders: null,
    agents: null,
    buys: null,
    kind: "stock",
    marks: [],
    cast: [],
  }) as LiveToken;
/** Twenty-five stocks, as many as the board lists, and a memecoin among them. */
const BOARD: LiveToken[] = [
  ...Array.from({ length: 25 }, (_, i) => stock(`S${String(i).padStart(2, "0")}`)),
  { ...stock("CASHCAT"), kind: "memecoin" },
];

/** What the venue route answers: a chart, or its 502 for a venue that refused. */
const chart = (change: number) =>
  new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketChangePercent: change } }] } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const refused = () =>
  new Response(JSON.stringify({ error: "venue unavailable", status: 503 }), {
    status: 502,
    headers: { "content-type": "application/json" },
  });

/**
 * The venue, answering each symbol through `answer`. Each request settles a few
 * turns of the event loop after it was sent, `delay` of them, so a test can say
 * which answers come back first.
 */
function venue(answer: (symbol: string) => Response, delay: (symbol: string) => number = () => 0) {
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://merrymen.test");
    assert.equal(url.pathname, "/api/venue");
    assert.equal(url.searchParams.get("desk"), "chart");
    const symbol = url.searchParams.get("symbol")!;
    asked.push(symbol);
    for (let i = 0; i < delay(symbol); i++) await new Promise<void>((r) => setImmediate(r));
    return answer(symbol);
  }) as typeof fetch;
  return asked;
}

describe("a chart venue that is down", () => {
  it("IS ASKED AT MOST FOUR TIMES, THEN NOT AT ALL FOR A MINUTE — not once per stock on every ask", async () => {
    const asked = venue(refused);
    const first = await loadSessionChanges(BOARD);
    assert.equal(first.size, 0, "nothing read is nothing shown");
    assert.ok(asked.length <= 4, `asked ${asked.length} times of a venue that refused the first answers`);
    assert.ok(!asked.includes("CASHCAT"), "a memecoin has no equity chart to ask for");

    const before = asked.length;
    now += 59_000;
    assert.equal((await loadSessionChanges(BOARD)).size, 0);
    assert.equal(asked.length, before, "the empty pass was kept: no request within the minute");

    now += 2_000;
    await loadSessionChanges(BOARD);
    assert.ok(asked.length > before, "and asked again once the minute is up");
    assert.ok(asked.length - before <= 4, "four at most again");
  });

  it("STOPS ON THE FAILURES ALREADY OUT, however slowly they come back — no fifth request past them", async () => {
    // The last request sent is the first to fail, and the worker it frees would
    // go straight on to a fifth stock while three failures are still out. A
    // hanging venue is the same answer, twelve seconds on.
    const asked = venue(refused, (symbol) => 25 - Number(symbol.slice(1)));
    await loadSessionChanges(BOARD);
    assert.deepEqual(asked, ["S00", "S01", "S02", "S03"]);
  });

  it("A PASS THAT READ NOTHING DOES NOT BLANK A NEWER ONE THAT READ THE BOARD — when the two overlap", async () => {
    // An old clock's pass is still out at a hanging venue when a sign-in starts
    // fresh clocks, whose own pass reads the venue once it is back. The old
    // pass ends last, on its four failures — refusals here, held until
    // released, as a request timing out would be.
    let release!: () => void;
    const hung = new Promise<void>((resolve) => (release = resolve));
    let hanging = true;
    const asked = venue(() => (hanging ? refused() : chart(3)));
    const answer = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const sentWhileHanging = hanging;
      const response = await answer(input);
      if (sentWhileHanging) await hung;
      return response;
    }) as typeof fetch;

    const old = loadSessionChanges(BOARD);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(asked.length, 4, "the old pass has its four requests out");
    hanging = false;
    assert.equal((await loadSessionChanges(BOARD)).size, 25, "the fresh pass reads the board");

    release();
    assert.equal((await old).size, 0, "the old pass read nothing");
    const before = asked.length;
    assert.equal((await loadSessionChanges(BOARD)).size, 25, "what the fresh pass read is still kept");
    assert.equal(asked.length, before, "and answered without asking again");
  });

  it("a pass with no stock in it asks nothing and keeps nothing", async () => {
    const asked = venue((symbol) => chart(symbol.length));
    assert.equal((await loadSessionChanges(BOARD.filter((t) => t.kind === "memecoin"))).size, 0);
    assert.equal(asked.length, 0);
    assert.equal((await loadSessionChanges(BOARD)).size, 25, "so the stocks asked for next are read at once");
  });
});

describe("a chart venue that is up", () => {
  it("ONE REFUSED SYMBOL DOES NOT END THE PASS — even when its refusal is the first answer back", async () => {
    const asked = venue(
      (symbol) => (symbol === "S00" ? refused() : chart(Number(symbol.slice(1)) / 10)),
      (symbol) => (symbol === "S00" ? 0 : 3),
    );
    const changes = await loadSessionChanges(BOARD);
    assert.equal(asked.length, 25, "every stock was asked for");
    assert.equal(changes.size, 24, "and every one but the refused symbol read");
    assert.equal(changes.get("0xs00"), undefined, "the refused one stays unknown, not zero");
    assert.equal(changes.get("0xs12"), 1.2);
  });

  it("an answer among the requests already out carries the pass on past the failures before it", async () => {
    // Three refusals back first: with nothing answered and two failed, the pass
    // would end — but the fourth request was already out, and it answered.
    const asked = venue(
      (symbol) => (["S00", "S01", "S02"].includes(symbol) ? refused() : chart(1)),
      (symbol) => (["S00", "S01", "S02"].includes(symbol) ? 0 : 3),
    );
    const changes = await loadSessionChanges(BOARD);
    assert.equal(asked.length, 25);
    assert.equal(changes.size, 22);
  });

  it("a pass that read something is kept for five minutes, as before", async () => {
    const asked = venue((symbol) => (symbol === "S03" ? refused() : chart(2)));
    assert.equal((await loadSessionChanges(BOARD)).size, 24);
    const before = asked.length;
    now += 299_000;
    assert.equal((await loadSessionChanges(BOARD)).size, 24);
    assert.equal(asked.length, before, "no request within the five minutes");
    now += 2_000;
    await loadSessionChanges(BOARD);
    assert.equal(asked.length, before + 25, "and the whole board asked again after them");
  });
});
