/**
 * THE BUDGET IS THE DESIGN, so these are the tests that matter most.
 *
 * A news provider's allowance is measured in requests per day. A fleet that
 * fetches whenever it thinks spends the day's allowance before lunch and then
 * reasons blind all afternoon while every log line still says "news". The two
 * properties below are what stop that, and neither is obvious from reading the
 * call site:
 *
 *   - waking is not fetching (the child never fetches at all; the orchestrator
 *     refreshes on a window derived from the allowance);
 *   - a symbol we cannot actually hear about is reported as not asked, never as
 *     quiet — which is why the symbol cap is tied to how many articles one
 *     request can return.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chooseSymbols, makeNewsDesk, newsFailureLine, planNewsWindow } from "./research-pass";

const NOW = 1_788_600_000;

/** A fetch that answers with `n` stories about the first symbol it was asked. */
function answering(rows: number, onCall?: (url: string) => void): typeof fetch {
  return (async (url: string) => {
    onCall?.(url);
    const symbols = new URL(url).searchParams.get("symbols")!.split(",");
    const data = Array.from({ length: rows }, (_, i) => ({
      uuid: "u" + i,
      title: "Story " + i,
      description: "d",
      url: "https://a.com/" + i,
      published_at: new Date((NOW - 3600) * 1000).toISOString(),
      source: "a.com",
      entities: [{ symbol: symbols[0], match_score: 80, sentiment_score: 0.3 }],
    }));
    return new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("the window is derived from the allowance, not chosen", () => {
  it("a hundred requests a day buys a sixteen-minute refresh, and stays inside it", () => {
    const p = planNewsWindow(100, 3);
    assert.ok(p.ttlSec >= 300 && p.ttlSec <= 3600, "got " + p.ttlSec);
    assert.ok(
      Math.floor(86_400 / p.ttlSec) <= 100,
      "a day of refreshes must fit the allowance: " + Math.floor(86_400 / p.ttlSec),
    );
    assert.match(p.why, /requests\/day/);
  });

  it("a small allowance slows the desk down rather than overspending", () => {
    // The version that clamped this at an hour spent ten requests by
    // mid-morning and then reported no news for the rest of the day while the
    // plan line still promised hourly refresh. Stretching the window spends the
    // allowance evenly, and says so.
    const p = planNewsWindow(10, 3);
    assert.ok(p.ttlSec > 3600, "the window has to stretch, got " + p.ttlSec);
    assert.ok(Math.floor(86_400 / p.ttlSec) <= 10, "and it must still fit the allowance");
    assert.match(p.why, /SLOWER THAN THE HOUR/);
  });

  it("a generous allowance still refuses to refresh faster than five minutes", () => {
    assert.equal(planNewsWindow(100_000, 50).ttlSec, 300);
  });

  it("HONESTY: never ask about more symbols than one request can answer for", () => {
    // The trap this closes: eight symbols on a tier returning three stories
    // means five symbols come back empty, and the desk would report those five
    // as "we asked and the tape was quiet" when they were simply crowded out.
    for (const articles of [1, 3, 5, 50]) {
      const p = planNewsWindow(100, articles);
      assert.ok(p.maxSymbols <= articles, articles + " articles but " + p.maxSymbols + " symbols");
    }
    assert.equal(planNewsWindow(100, 3).maxSymbols, 3);
  });
});

describe("which symbols this window asks about", () => {
  it("asks about everything when everything fits", () => {
    assert.deepEqual(chooseSymbols(["TSLA", "NVDA"], { maxSymbols: 3, asOf: NOW, ttlSec: 900 }), [
      "TSLA",
      "NVDA",
    ]);
  });

  it("dedupes and uppercases, preserving the caller's priority order", () => {
    assert.deepEqual(chooseSymbols([" tsla ", "TSLA", "nvda"], { maxSymbols: 5, asOf: NOW, ttlSec: 900 }), [
      "TSLA",
      "NVDA",
    ]);
  });

  it("rotates when the fleet wants more than a request can carry", () => {
    const all = ["A", "B", "C", "D", "E"];
    const w1 = chooseSymbols(all, { maxSymbols: 2, asOf: NOW, ttlSec: 900 });
    const w2 = chooseSymbols(all, { maxSymbols: 2, asOf: NOW + 900, ttlSec: 900 });
    assert.equal(w1.length, 2);
    assert.notDeepEqual(w1, w2, "the next window asks about a different slice");
  });

  it("a held name keeps its slot however the rotation falls", () => {
    // The defect this pins: rotation is anchored on the clock, so priority
    // order used to survive only while everything fitted. Production held TSLA
    // and asked about GOOGL, AMZN and NVDA — three names nobody owned.
    const universe = ["TSLA", "GOOGL", "AMZN", "NVDA", "AAPL", "MU", "SPCX", "COIN"];
    for (let w = 0; w < 40; w += 1) {
      const ask = chooseSymbols(universe, {
        maxSymbols: 3,
        asOf: NOW + w * 960,
        ttlSec: 960,
        alwaysAsk: ["TSLA"],
      });
      assert.equal(ask.length, 3);
      assert.ok(ask.includes("TSLA"), "window " + w + " dropped the held name: " + ask.join(","));
    }
  });

  it("a book bigger than one request rotates inside itself, never outside it", () => {
    // Eight positions and three slots. Every slot goes to a name we own, and
    // across windows the whole book gets covered — a held symbol must not lose
    // its turn to a watch-list name it is competing with.
    const held = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const universe = [...held, "WATCH1", "WATCH2", "WATCH3"];
    const seen = new Set<string>();
    for (let w = 0; w < 40; w += 1) {
      const ask = chooseSymbols(universe, {
        maxSymbols: 3,
        asOf: NOW + w * 960,
        ttlSec: 960,
        alwaysAsk: held,
      });
      for (const s of ask) {
        assert.ok(held.includes(s), "a watched name took a slot from the book: " + s);
        seen.add(s);
      }
    }
    assert.equal(seen.size, held.length, "some position never got asked about");
  });

  it("without a held set it behaves exactly as it did — pure rotation", () => {
    const all = ["A", "B", "C", "D", "E"];
    assert.deepEqual(
      chooseSymbols(all, { maxSymbols: 2, asOf: NOW, ttlSec: 900 }),
      chooseSymbols(all, { maxSymbols: 2, asOf: NOW, ttlSec: 900, alwaysAsk: [] }),
    );
  });

  it("the same window always asks the same thing, so a replay is reproducible", () => {
    const all = ["A", "B", "C", "D", "E"];
    const a = chooseSymbols(all, { maxSymbols: 2, asOf: NOW + 10, ttlSec: 900 });
    const b = chooseSymbols(all, { maxSymbols: 2, asOf: NOW + 20, ttlSec: 900 });
    assert.deepEqual(a, b);
  });
});

describe("waking is not fetching", () => {
  it("a second refresh inside the window costs nothing", async () => {
    let calls = 0;
    const desk = makeNewsDesk({
      apiKey: "k",
      dailyLimit: 100,
      articlesPerRequest: 3,
      fetchImpl: answering(2, () => {
        calls += 1;
      }),
    });
    const first = await desk.refresh(["TSLA"], NOW);
    assert.equal(first.fetched, true);
    assert.equal(calls, 1);

    for (const t of [NOW + 1, NOW + 60, NOW + 300]) {
      const again = await desk.refresh(["TSLA"], t);
      assert.equal(again.fetched, false);
    }
    assert.equal(calls, 1, "three more wakes, still one request");
  });

  it("and the window does eventually elapse", async () => {
    let calls = 0;
    const desk = makeNewsDesk({
      apiKey: "k",
      articlesPerRequest: 3,
      fetchImpl: answering(1, () => {
        calls += 1;
      }),
    });
    await desk.refresh(["TSLA"], NOW);
    await desk.refresh(["TSLA"], NOW + desk.plan().ttlSec);
    assert.equal(calls, 2);
  });

  it("nothing to ask about is not a request", async () => {
    let calls = 0;
    const desk = makeNewsDesk({
      apiKey: "k",
      fetchImpl: answering(1, () => {
        calls += 1;
      }),
    });
    const r = await desk.refresh([], NOW);
    assert.equal(r.fetched, false);
    assert.equal(calls, 0);
  });
});

describe("failure does not become silence, and does not become a retry storm", () => {
  it("a refused request is rate-limited exactly like a successful one", async () => {
    let calls = 0;
    const desk = makeNewsDesk({
      apiKey: "k",
      dailyLimit: 100,
      fetchImpl: (async () => {
        calls += 1;
        return new Response("no", { status: 500 });
      }) as unknown as typeof fetch,
    });
    await desk.refresh(["TSLA"], NOW);
    await desk.refresh(["TSLA"], NOW + 1);
    await desk.refresh(["TSLA"], NOW + 2);
    assert.equal(calls, 1, "an outage must not turn a 15-second pass into a 15-second retry");
    assert.equal(desk.state().failure, "http-error");
  });

  it("a failure keeps the last good stories but does not claim they are fresh", async () => {
    let fail = false;
    const desk = makeNewsDesk({
      apiKey: "k",
      articlesPerRequest: 3,
      fetchImpl: (async (url: string) =>
        fail ? new Response("no", { status: 500 }) : answering(2)(url)) as unknown as typeof fetch,
    });
    await desk.refresh(["TSLA"], NOW);
    const good = desk.state();
    assert.equal(good.items.length, 2);
    assert.equal(good.fetchedAt, NOW);

    fail = true;
    await desk.refresh(["TSLA"], NOW + desk.plan().ttlSec);
    const after = desk.state();
    assert.equal(after.items.length, 2, "a window-old story is still a story");
    assert.equal(after.fetchedAt, NOW, "but the desk does not pretend it was just fetched");
    assert.equal(after.failure, "http-error");
  });

  it("the day's allowance is a hard stop, reported as such", async () => {
    // Reachable only when somebody chooses a cadence the allowance cannot pay
    // for — the derived window never can, by construction, and that is the
    // honest description of this guard. An operator setting a five-minute desk
    // against two requests a day gets exactly two, then a refusal that says so.
    let calls = 0;
    const desk = makeNewsDesk({
      apiKey: "k",
      dailyLimit: 2,
      windowSec: 300,
      fetchImpl: answering(1, () => {
        calls += 1;
      }),
    });
    assert.equal(desk.plan().ttlSec, 300);
    await desk.refresh(["TSLA"], NOW);
    await desk.refresh(["TSLA"], NOW + 300);
    const r = await desk.refresh(["TSLA"], NOW + 600);
    assert.equal(calls, 2, "two permitted requests, and no third");
    assert.equal(r.fetched, false);
    assert.equal(desk.state().failure, "budget-exhausted");
    assert.match(r.log ?? "", /allowance/);
  });

  it("the derived window can never exhaust the allowance on its own", () => {
    // The reserve is what buys this, and what it is really for is redeploys: a
    // restart resets the in-memory ledger, so a fleet that ships ten times a day
    // must still fit inside the vendor's count.
    for (const limit of [10, 100, 1000]) {
      const p = planNewsWindow(limit, 3);
      assert.ok(
        Math.floor(86_400 / p.ttlSec) < limit,
        "limit " + limit + " would spend " + Math.floor(86_400 / p.ttlSec),
      );
    }
  });

  it("a missing token reads as our own gap, not the provider's", () => {
    const line = newsFailureLine("no-key", "", ["TSLA"], 0, 100);
    assert.match(line, /NOT CONFIGURED/);
    assert.match(line, /has never asked anything/);

    const theirs = newsFailureLine("http-error", "429", ["TSLA"], 4, 100);
    assert.match(theirs, /the provider did not answer/);
  });
});
