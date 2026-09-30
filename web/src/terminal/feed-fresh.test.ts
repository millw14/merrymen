/**
 * A ROW IS THE SAME ROW ACROSS REFRESHES, SO A NEW ONE CAN BE SEEN ARRIVING.
 *
 * Beat ids embedded `at` — `${symbol}-${action}-${slug}-${atSec}` — and the
 * reader groups on MAX(d.at), which a re-proposed thesis advances every tick.
 * So every refresh handed React a fresh key for a post that had not changed:
 * every row remounted, and "which of these is new?" had no answer, because by
 * id they all were.
 *
 * Keyed on `postId` — a hash of the post's own published fields that does not
 * move with `at`, `said` or the outcome (post-id.ts) — a row keeps its element
 * across refreshes, and a key the page has not seen before is genuinely a post
 * it has not shown. That is what the slide-in is drawn from.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { beatsOf, fitOf, forgetKeysForTest, lanesOf, matchTwins, pillBeats, type Beat, type FeedRow, type Fit } from "./beat";
import { forgetSeenForTest, freshAmong, freshKeyOf, isFresh, markSeen } from "./feed-fresh";
import type { LiveAgent } from "./live";
import { testDom } from "./test-dom";

(globalThis as unknown as { React: typeof React }).React = React;

const NOW = 1_790_000_000;
const PID = "c".repeat(32);

const row = (over: Partial<FeedRow> = {}): FeedRow =>
  ({
    name: "Shogun",
    slug: "shogun",
    handle: null,
    action: "buy",
    symbol: "TSLA",
    sizeUsdg: 5,
    reason: "Adding under its average.",
    paper: false,
    head: "buy TSLA 5.00 USDG",
    outcome: "landed",
    outcomeText: "filled",
    said: 1,
    at: NOW,
    firstAt: NOW,
    unchangedSince: NOW,
    postId: PID,
    ...over,
  }) as FeedRow;

const agents = [
  { slug: "shogun", name: "Shogun", handle: null, owner: null, pnlBps: null, curve: [], landed: 0, last: null, glance: { id: "custom", label: "Strategy" }, thesis: "" },
] as unknown as LiveAgent[];

describe("C2: a beat is keyed by its postId", () => {
  beforeEach(() => forgetKeysForTest());

  it("the same post, re-read a tick later with a newer `at`, keeps its key", () => {
    const [before] = beatsOf([row({ at: NOW, said: 1 })], agents);
    const [after] = beatsOf([row({ at: NOW + 300, said: 2 })], agents);
    assert.equal(before!.id, PID);
    assert.equal(after!.id, before!.id);
  });

  it("a view is keyed the same way", () => {
    const [v] = beatsOf([row({ action: "hold", head: "hold TSLA", outcome: "view", postId: "d".repeat(32) })], agents);
    assert.equal(v!.kind, "view");
    assert.equal(v!.id, "d".repeat(32));
  });

  it("only a post with no postId falls back to the old id", () => {
    const [b] = beatsOf([row({ postId: null })], agents);
    assert.equal(b!.id, `TSLA-buy-shogun-${NOW}`);
    const [v] = beatsOf([row({ postId: undefined, action: "hold", head: "hold TSLA", outcome: "view" })], agents);
    assert.equal(v!.id, `view-shogun-${NOW}-TSLA`);
  });

  it("the like key is untouched: it is still the postId", () => {
    const [b] = beatsOf([row()], agents);
    assert.equal(b!.postId, PID);
  });

  it("TWO ROWS, ONE POSTID — still two keys, and the landed row keeps the bare id in either order", () => {
    // post-id.ts leaves outcome out on purpose (a like survives settling), so
    // the same thesis pending and landed are two rows sharing one id. Two
    // equal React keys make React drop or merge a row.
    // Whichever is newer, and whichever arrives first: neither the feed's
    // order nor the old `at`-bearing id may decide who owns the key.
    for (const pendingAt of [NOW + 10, NOW - 10]) {
      const pending = row({ outcome: "pending", at: pendingAt });
      const landed = row({ outcome: "landed", at: NOW });
      for (const order of [[pending, landed], [landed, pending]]) {
        const beats = beatsOf(order, agents);
        const ids = beats.map((b) => b.id);
        assert.equal(new Set(ids).size, 2, "unique");
        const landedBeat = beats.find((b) => b.outcome === "landed")!;
        assert.equal(landedBeat.id, PID, "the settled row owns the stable key");
      }
    }
  });

  it("two refusals of one post under different rules are two keys, and EACH KEEPS ITS OWN across a re-read", () => {
    // The review's probe (FE4): the tie-break was the `at`-bearing legacy id,
    // so re-proposing both in the other order SWAPPED their keys — and with
    // them their elements and any open "why". A sorted comparison of the two
    // keys could not see it; each row is found by its own words here.
    const cap = (at: number) => row({ outcome: "refused", outcomeText: "past today's spending cap", at });
    const ops = (at: number) => row({ outcome: "refused", outcomeText: "past today's number of trades", at });
    const keyOf = (bs: Beat[], text: string) => bs.find((x) => x.outcomeText === text)!.id;
    const first = beatsOf([cap(NOW), ops(NOW - 5)], agents);
    const again = beatsOf([cap(NOW + 30), ops(NOW + 60)], agents);
    assert.equal(new Set(first.map((x) => x.id)).size, 2);
    for (const text of ["past today's spending cap", "past today's number of trades"]) {
      assert.equal(keyOf(again, text), keyOf(first, text), text);
    }
  });

  it("the first read of a family keys it the same whatever the order or the clock", () => {
    const cap = (at: number) => row({ outcome: "refused", outcomeText: "past today's spending cap", at });
    const ops = (at: number) => row({ outcome: "refused", outcomeText: "past today's number of trades", at });
    const keyOf = (bs: Beat[], text: string) => bs.find((x) => x.outcomeText === text)!.id;
    const one = beatsOf([cap(NOW), ops(NOW - 5)], agents);
    forgetKeysForTest();
    const two = beatsOf([ops(NOW + 60), cap(NOW - 90)], agents);
    for (const text of ["past today's spending cap", "past today's number of trades"]) {
      assert.equal(keyOf(two, text), keyOf(one, text), text);
    }
  });

  it("lanes and lulls follow the key", () => {
    const lanes = lanesOf(beatsOf([row()], agents));
    assert.equal(lanes[0]!.id, PID);
  });
});

describe("a key stays with the row that had it (FE1)", () => {
  beforeEach(() => {
    forgetKeysForTest();
    forgetSeenForTest();
  });

  it("A TRADE THAT LANDS BESIDE A REFUSAL ON SCREEN IS THE NEW ROW — the refusal keeps its key", () => {
    // The review's probe: an owner re-signs a stuck leg. The refusal ("asset
    // the key does not cover") is on screen under the post's bare id; the
    // same thesis then lands. The landed row took the bare id by priority —
    // the refusal's element, already seen — so the new trade did not slide
    // in, and the refusal was re-keyed, remounted and slid in as "new".
    const refused = row({ outcome: "refused", outcomeText: "that asset is not in its signed permissions", at: NOW });
    const first = beatsOf([refused], agents);
    markSeen(first.map(freshKeyOf));
    const second = beatsOf([refused, row({ outcome: "landed", outcomeText: "landed", at: NOW + 600 })], agents);
    const fresh = freshAmong(second.map(freshKeyOf));
    const was = second.find((b) => b.outcome === "refused")!;
    const now = second.find((b) => b.outcome === "landed")!;
    assert.equal(was.id, first[0]!.id, "the refusal keeps the key it was drawn under");
    assert.notEqual(now.id, was.id);
    assert.equal(isFresh(now, fresh), true, "the trade is what arrived");
    assert.equal(isFresh(was, fresh), false, "the refusal was already on the page");
  });

  it("an order that lands keeps the element it was drawn under while in flight, and is news", () => {
    // The pending row is gone once its trade settles; the landed row is the
    // same trade, so it takes the key over — and the fill is still new (D2).
    const first = beatsOf([row({ outcome: "pending", outcomeText: "sent, waiting on the chain", at: NOW })], agents);
    markSeen(first.map(freshKeyOf));
    const second = beatsOf([row({ outcome: "landed", outcomeText: "landed", at: NOW + 20 })], agents);
    assert.equal(second[0]!.id, first[0]!.id);
    assert.equal(isFresh(second[0]!, freshAmong(second.map(freshKeyOf))), true);
  });
});

describe("a new fill is new even when it joins a row it shares with others (FE5, D2)", () => {
  beforeEach(() => {
    forgetKeysForTest();
    forgetSeenForTest();
  });
  const seenThen = (rows: FeedRow[]) => markSeen(beatsOf(rows, agents).map(freshKeyOf));
  const freshNow = (rows: FeedRow[]) => {
    const beats = beatsOf(rows, agents);
    const fresh = freshAmong(beats.map(freshKeyOf));
    return beats.map((b) => isFresh(b, fresh));
  };

  it("THE SECOND DCA LEG OF THE DAY: a landed row whose `at` moved and `said` grew is a new fill", () => {
    // Same reason, same size, so the reader groups it into the first leg's
    // row (no d.at in its GROUP BY). The row jumped to the top as "now" and
    // did not move — the key had been seen.
    seenThen([row({ said: 1, at: NOW })]);
    assert.deepEqual(freshNow([row({ said: 2, at: NOW + 3600 })]), [true]);
  });

  it("the same landed row read again is not new", () => {
    seenThen([row({ said: 1, at: NOW })]);
    assert.deepEqual(freshNow([row({ said: 1, at: NOW })]), [false]);
  });

  it("A REPEATED VIEW, A REPEATED REFUSAL AND A RE-SENT ORDER DO NOT FLASH EVERY TICK — only a fill is news", () => {
    const view = (said: number, at: number) =>
      row({ action: "hold", outcome: "view", outcomeText: "held — no trade, by choice", head: "hold TSLA", sizeUsdg: null, postId: "d".repeat(32), said, at, unchangedSince: NOW - 3600 });
    const refusal = (said: number, at: number) =>
      row({ outcome: "refused", outcomeText: "past today's spending cap", postId: "e".repeat(32), said, at, unchangedSince: NOW - 3600 });
    const sent = (said: number, at: number) =>
      row({ outcome: "pending", outcomeText: "sent, waiting on the chain", postId: "f".repeat(32), said, at });
    seenThen([view(3, NOW), refusal(3, NOW), sent(1, NOW)]);
    assert.deepEqual(freshNow([view(4, NOW + 300), refusal(4, NOW + 300), sent(2, NOW + 300)]), [false, false, false]);
  });
});

describe("what is new since the page last looked", () => {
  beforeEach(() => forgetSeenForTest());

  it("THE FIRST READ SLIDES NOTHING IN — it is the page, not news", () => {
    assert.deepEqual([...freshAmong(["a", "b"])], []);
    markSeen(["a", "b"]);
    assert.deepEqual([...freshAmong(["a", "b"])], []);
  });

  it("a key that arrives after the first read is fresh, once", () => {
    markSeen(["a", "b"]);
    assert.deepEqual([...freshAmong(["c", "a", "b"])], ["c"]);
    markSeen(["c", "a", "b"]);
    assert.deepEqual([...freshAmong(["c", "a", "b"])], [], "seen now");
  });

  it("an empty first read does not prime: the first real rows are still the page", () => {
    markSeen([]);
    assert.deepEqual([...freshAmong(["a"])], []);
  });

  it("MODULE-LEVEL: a remounted feed does not replay the rows it already showed", () => {
    // Switching tabs unmounts the Feed. The set outlives it, so coming back is
    // not a wall of slide-ins — only what arrived while away moves.
    markSeen(["a", "b"]);
    const remount = freshAmong(["a", "b", "z"]);
    assert.deepEqual([...remount], ["z"]);
  });

  it("reading does not mark: two renders before commit see the same fresh set", () => {
    markSeen(["a"]);
    assert.deepEqual([...freshAmong(["a", "n"])], ["n"]);
    assert.deepEqual([...freshAmong(["a", "n"])], ["n"], "StrictMode renders twice; the second must agree");
  });
});

describe("the row", () => {
  it("a fresh row carries wire-new; a seen one does not", async () => {
    const { Wire } = await import("./wire");
    const lanes = lanesOf(beatsOf([row(), row({ postId: "e".repeat(32), symbol: "NVDA", head: "buy NVDA 5.00 USDG", at: NOW - 60 })], agents));
    const beats = lanes.flatMap((l) => (l.kind === "beat" ? [l.beat] : []));
    const html = renderToStaticMarkup(createElement(Wire, { lanes, tokens: [], fresh: new Set([freshKeyOf(beats[0]!)]) }));
    const rows = html.split('<div class="wire-beat').slice(1);
    assert.equal(rows.length, 2);
    assert.match(rows[0]!, /^[^"]*wire-new/, "the new TSLA row");
    assert.doesNotMatch(rows[1]!, /^[^"]*wire-new/, "the NVDA row was already on the page");
  });

  it("a watch line moves when the hold it leads with is new, not because it is a summary", () => {
    const hold = (sym: string, pid: string, at: number) =>
      row({ action: "hold", outcome: "view", symbol: sym, head: `hold ${sym}`, sizeUsdg: null, reason: `watching ${sym}`, postId: pid, said: 3, at, unchangedSince: at - 3600 });
    const beats = beatsOf([hold("AAA", "1".repeat(32), NOW), hold("BBB", "2".repeat(32), NOW - 60)], agents);
    const [watch] = pillBeats(beats, "all", new Map(), {});
    assert.ok(watch && watch.kind === "watch");
    assert.equal(isFresh(watch, new Set(["1".repeat(32)])), true, "its latest member is new");
    assert.equal(isFresh(watch, new Set(["2".repeat(32)])), false, "an older member is not what it shows");
    assert.equal(isFresh(watch, new Set()), false);
  });

  it("no fresh set (an older caller): nothing animates", async () => {
    const { Wire } = await import("./wire");
    const html = renderToStaticMarkup(createElement(Wire, { lanes: lanesOf(beatsOf([row()], agents)), tokens: [] }));
    assert.ok(!html.includes("wire-new"));
  });
});

/**
 * TWINS: ROWS THAT SAY EXACTLY THE SAME THING (CF3).
 *
 * Same postId, outcome and outcome sentence — two refusals under rules the
 * publisher renders alike, or, since D1, a private book's fills of one coin
 * that differ only in the size it no longer publishes. They were told apart by
 * an ORDINAL over their first copies, so when the oldest left the read (the
 * window, or the action lane's page bound) every other twin took its
 * neighbour's key: landed twins flashed as new fills when nothing had arrived,
 * and a refusal that DID arrive slid in under a key the page had already seen.
 * A twin is now known by its first copy, which moves only when its own oldest
 * copies age out.
 */
describe("twins keep their own keys (CF3)", () => {
  beforeEach(() => {
    forgetKeysForTest();
    forgetSeenForTest();
  });
  // Each twin found by its newest copy, which is distinct in every fixture here.
  const refusal = (first: number, last = first + 30) =>
    row({ outcome: "refused", outcomeText: "the wall turned it back", at: last, firstAt: first, said: 2, unchangedSince: first });
  const fill = (first: number) => row({ outcome: "landed", outcomeText: "landed", sizeUsdg: null, head: "buy TSLA", at: first, firstAt: first });
  const read = (rows: FeedRow[]) => {
    const beats = beatsOf(rows, agents);
    const keys = beats.map(freshKeyOf);
    const fresh = freshAmong(keys);
    markSeen(keys);
    return new Map(beats.map((b) => [b.atMs / 1000, { key: b.id, fresh: isFresh(b, fresh) }]));
  };

  it("THE OLDEST OF THREE REFUSED TWINS LEAVES: the other two keep their keys and are not news", () => {
    const [a, b, c] = [NOW - 300, NOW - 200, NOW - 100];
    const before = read([refusal(a), refusal(b), refusal(c)]);
    const after = read([refusal(b), refusal(c)]);
    for (const t of [b + 30, c + 30]) {
      assert.equal(after.get(t)!.key, before.get(t)!.key, `the twin last said at ${t} kept its key`);
      assert.equal(after.get(t)!.fresh, false);
    }
  });

  it("LANDED TWINS: a re-read moves nothing, and the oldest leaving flashes nothing", () => {
    const [a, b, c] = [NOW - 3000, NOW - 2000, NOW - 1000];
    const first = read([fill(a), fill(b), fill(c)]);
    const again = read([fill(a), fill(b), fill(c)]);
    assert.ok([...again.values()].every((r) => !r.fresh), "nothing arrived");
    const after = read([fill(b), fill(c)]);
    for (const t of [b, c]) {
      assert.equal(after.get(t)!.key, first.get(t)!.key);
      assert.equal(after.get(t)!.fresh, false, "no fill arrived");
    }
  });

  it("A NEW TWIN ARRIVING AS THE OLDEST LEAVES IS NEWS — it takes no key the page has shown", () => {
    const [a, b, c, d] = [NOW - 300, NOW - 200, NOW - 100, NOW];
    const before = read([refusal(a), refusal(b), refusal(c)]);
    const after = read([refusal(b), refusal(c), refusal(d)]);
    const shown = new Set([...before.values()].map((r) => r.key));
    const arrived = after.get(d + 30)!;
    assert.ok(!shown.has(arrived.key), `the new twin was drawn under ${arrived.key}, a key already shown`);
    assert.equal(arrived.fresh, true);
    for (const t of [b + 30, c + 30]) assert.equal(after.get(t)!.key, before.get(t)!.key);
  });

  it("a twin whose own oldest copies age out keeps its key: the same row, fewer copies", () => {
    const [a, b] = [NOW - 3000, NOW - 2000];
    const before = read([refusal(a, a + 30), refusal(b, b + 60)]);
    // The second twin's first copy (b) left the window; its next one (b + 20) is its first now.
    const after = read([refusal(a, a + 30), refusal(b + 20, b + 60)]);
    assert.equal(after.get(b + 60)!.key, before.get(b + 60)!.key);
    assert.equal(after.get(b + 60)!.fresh, false);
    assert.equal(after.get(a + 30)!.key, before.get(a + 30)!.key);
  });

  it("and so does one that was said again, then aged past the copies it was first read with", () => {
    const [a, b] = [NOW - 3000, NOW - 2000];
    const first = read([refusal(a, a + 30), refusal(b, b + 10)]);
    read([refusal(a, a + 30), refusal(b, b + 100)]); // said again: its newest copy is b + 100
    const aged = read([refusal(a, a + 30), refusal(b + 50, b + 100)]); // and its copies before b + 50 left
    assert.equal(aged.get(b + 100)!.key, first.get(b + 10)!.key);
    assert.equal(aged.get(b + 100)!.fresh, false);
  });

  // R3F-1: the review's probe. Twin A has copies at 100 and 400, twin B at 150
  // and 300, so A is the older by its first copy. Between two reads (a sleeping
  // laptop, a hidden tab read once a minute) both first copies leave the
  // window, and now B (300) is the older. B, handled first, took A's key — a
  // same-words key whose span covers 300 — and A was left to slide in under a
  // key nobody had seen: a refusal flashing as news, a fill flashing as a fill
  // that never came. Each twin is its own newest copy; nothing was said.
  const twin = (outcome: "refused" | "landed", first: number, last: number, said: number) =>
    row({
      outcome,
      outcomeText: outcome === "refused" ? "the wall turned it back" : "landed",
      sizeUsdg: null,
      head: "buy TSLA",
      at: last,
      firstAt: first,
      said,
      unchangedSince: first,
    });
  for (const outcome of ["refused", "landed"] as const) {
    it(`TWO TWINS' FIRST COPIES AGE OUT IN ONE READ AND THEIR ORDER FLIPS (${outcome}): each keeps its own key, neither is news`, () => {
      const [A, B] = [NOW + 400, NOW + 300];
      read([row({ postId: "f".repeat(32), symbol: "AAPL", at: NOW, firstAt: NOW })]); // the page, primed
      const before = read([twin(outcome, NOW + 100, A, 2), twin(outcome, NOW + 150, B, 2)]);
      assert.notEqual(before.get(A)!.key, before.get(B)!.key);
      const aged = read([twin(outcome, A, A, 1), twin(outcome, B, B, 1)]);
      for (const [name, t] of [["A", A], ["B", B]] as const) {
        assert.equal(aged.get(t)!.key, before.get(t)!.key, `twin ${name} kept its own key`);
        assert.equal(aged.get(t)!.fresh, false, `twin ${name}: nothing arrived`);
      }
      const again = read([twin(outcome, A, A, 1), twin(outcome, B, B, 1)]);
      assert.ok([...again.values()].every((r) => !r.fresh), "and read again, nothing is news");
    });
  }

  it("A TWIN SAID AGAIN AS BOTH AGE OUT takes its own key, not the one whose span its first copy falls in", () => {
    // Y's copies are 100, 250, 300 and X's 150, 200, 400; Y is the older, so
    // it holds the bare id. Between two reads both oldest copies leave and X
    // is said again at 500: X is now 200..500 and Y 250..300, and X is the
    // older. X's first copy (200) falls inside Y's old span as well as its own
    // — but Y's newest copy is where it was, so that key is Y's; X takes its
    // own. Handed out in list order, the two swapped.
    const [X, Y] = [NOW + 400, NOW + 300];
    read([row({ postId: "f".repeat(32), symbol: "AAPL", at: NOW, firstAt: NOW })]);
    const before = read([twin("refused", NOW + 150, X, 3), twin("refused", NOW + 100, Y, 3)]);
    assert.equal(before.get(Y)!.key, PID, "the older twin holds the bare id");
    const aged = read([twin("refused", NOW + 200, NOW + 500, 3), twin("refused", NOW + 250, Y, 2)]);
    assert.equal(aged.get(Y)!.key, before.get(Y)!.key, "Y kept its key");
    assert.equal(aged.get(NOW + 500)!.key, before.get(X)!.key, "X, said again, kept its key");
    assert.ok([...aged.values()].every((r) => !r.fresh), "a refusal said again is not news");
  });

  it("BOTH SAID AGAIN AS BOTH AGE OUT: the twin that fits one key only gets it, and the other takes its own", () => {
    // A's copies 100, 350, 400 → 350..600; B's 150, 250, 300 → 250..500. B's
    // new span fits both old keys and fits A's more closely; A's fits A's
    // alone. First come, first served, B took A's key and A slid in as news.
    const [A, B] = [NOW + 400, NOW + 300];
    read([row({ postId: "f".repeat(32), symbol: "AAPL", at: NOW, firstAt: NOW })]);
    const before = read([twin("refused", NOW + 100, A, 3), twin("refused", NOW + 150, B, 3)]);
    const aged = read([twin("refused", NOW + 350, NOW + 600, 3), twin("refused", NOW + 250, NOW + 500, 3)]);
    assert.equal(aged.get(NOW + 600)!.key, before.get(A)!.key, "A kept its key");
    assert.equal(aged.get(NOW + 500)!.key, before.get(B)!.key, "B kept its key");
    assert.ok([...aged.values()].every((r) => !r.fresh));
  });

  it("A TWIN BACK ON THE PAGE WITH ITS OLD NEWEST COPY AS ITS FIRST is that row, whatever other key its span fits", () => {
    // X (633, 1181) and Y (1090..1470). Then Y is off the page (the action
    // lane shows the newest rows) while X, said again at 1727, has lost 633:
    // X is 1181..1727. Its span fits Y's old key more closely than its own —
    // but it still has X's newest copy, 1181, so it is X. Y, back, is Y.
    read([row({ postId: "f".repeat(32), symbol: "AAPL", at: NOW, firstAt: NOW })]);
    const X = twin("refused", NOW + 633, NOW + 1181, 2);
    const Y = twin("refused", NOW + 1090, NOW + 1470, 2);
    const before = read([X, Y]);
    const back = read([twin("refused", NOW + 1181, NOW + 1727, 2)]);
    assert.equal(back.get(NOW + 1727)!.key, before.get(NOW + 1181)!.key, "X kept its key");
    assert.equal(back.get(NOW + 1727)!.fresh, false);
    const both = read([twin("refused", NOW + 1181, NOW + 1727, 2), twin("refused", NOW + 1090, NOW + 1829, 3)]);
    assert.equal(both.get(NOW + 1829)!.key, before.get(NOW + 1470)!.key, "Y, back on the page, has its own key");
    assert.ok([...both.values()].every((r) => !r.fresh));
  });

  it("A STALE BODY AFTER THE TWINS AGED: each old row is found by its newest copy and takes its own key back", () => {
    // /api/theses is stale-while-revalidate: after the read where both twins'
    // first copies left, an older body can be served again, with the rows as
    // they were. Each still has its newest copy where it was, so each is the
    // row that holds that key — its first copy going back is what a stale body
    // looks like, not a different row.
    const [A, B] = [NOW + 400, NOW + 300];
    read([row({ postId: "f".repeat(32), symbol: "AAPL", at: NOW, firstAt: NOW })]);
    const old = [twin("refused", NOW + 100, A, 2), twin("refused", NOW + 150, B, 2)];
    const before = read(old);
    read([twin("refused", A, A, 1), twin("refused", B, B, 1)]);
    const stale = read(old);
    for (const t of [A, B]) {
      assert.equal(stale.get(t)!.key, before.get(t)!.key, `the twin last said at ${t} kept its key`);
      assert.equal(stale.get(t)!.fresh, false);
    }
  });

  it("A TWIN FROM BELOW THE PAGE, WITH A COPY OLDER THAN THE HOLDER EVER HAD, does not take the key from the holder's own row", () => {
    // The action lane shows the newest rows. H (200..400) was on the page; N
    // (150, 350) was below it. By the next read H lost 200 and was said again
    // (300..600), and N was said at 500 and is on the page now. N's span
    // covers H's key too — but N has a copy (150) from before H's first, which
    // H's row never had. H's own row keeps the key; N is news to the page.
    read([row({ postId: "f".repeat(32), symbol: "AAPL", at: NOW, firstAt: NOW })]);
    const before = read([twin("refused", NOW + 200, NOW + 400, 2)]);
    const after = read([twin("refused", NOW + 300, NOW + 600, 2), twin("refused", NOW + 150, NOW + 500, 3)]);
    assert.equal(after.get(NOW + 600)!.key, before.get(NOW + 400)!.key, "H's row kept its key");
    assert.equal(after.get(NOW + 600)!.fresh, false);
    assert.equal(after.get(NOW + 500)!.fresh, true, "N was never on the page");
  });

  it("A NEW TWIN SAID BETWEEN A KEPT TWIN'S COPIES takes no key a row on screen holds", () => {
    // X is on screen (100..200). By the next read X was said again at 400 and
    // a new twin said once at 300 — inside X's span. X is still here under its
    // key; the newcomer is news, drawn under a key of its own.
    read([row({ postId: "f".repeat(32), symbol: "AAPL", at: NOW, firstAt: NOW })]);
    const before = read([twin("refused", NOW + 100, NOW + 200, 2)]);
    const beats = beatsOf([twin("refused", NOW + 100, NOW + 400, 3), twin("refused", NOW + 300, NOW + 300, 1)], agents);
    assert.equal(new Set(beats.map((b) => b.id)).size, 2, "two rows, two keys");
    assert.equal(beats.find((b) => b.atMs === (NOW + 400) * 1000)!.id, before.get(NOW + 200)!.key, "X kept its key");
    const fresh = freshAmong(beats.map(freshKeyOf));
    assert.equal(isFresh(beats.find((b) => b.atMs === (NOW + 300) * 1000)!, fresh), true, "the new twin is news");
  });
});

/**
 * THE MATCHING ITSELF (R3F-1): how a newcomer's span fits a departed key of
 * the same words, and who gets which key when several could.
 */
describe("which departed key a twin may take", () => {
  it("fitOf: never a key whose every copy is older than the row's first; best when the holder's newest copy is still there", () => {
    const was = { first: 100, last: 400 };
    assert.equal(fitOf({ first: 401, last: 500 }, was), null, "every copy the page saw has left: a new row");
    assert.equal(fitOf({ first: 250, last: 400 }, was), 0, "only old copies left");
    assert.equal(fitOf({ first: 400, last: 700 }, was), 0, "said again, and all before the holder's newest left");
    assert.equal(fitOf({ first: 50, last: 400 }, was), 0, "an older body served stale: first went back, newest where it was");
    assert.equal(fitOf({ first: 250, last: 700 }, was), 1, "said again: the span only moved forward");
    assert.equal(fitOf({ first: 50, last: 700 }, was), 2, "said again with a first copy the holder never had");
    assert.equal(fitOf({ first: 250, last: 300 }, was), 2, "its newest is older than the holder's and not one of its copies");
  });

  it("matchTwins: a better fit wins a key over a newcomer tried first", () => {
    const got = matchTwins(new Map<number, Fit[]>([[0, [{ key: "k", rank: 1 }]], [1, [{ key: "k", rank: 0 }]]]));
    assert.deepEqual([...got], [["k", 1]]);
  });

  it("matchTwins: a pair settled on a better fit is never undone by a worse one", () => {
    // Newcomer 1 fits only k (rank 2); newcomer 0 fits k at rank 0 and j at 2.
    // More rows would keep a key if 0 moved to j — but 0 is k's row by the
    // strongest evidence there is, and 1 is not.
    const got = matchTwins(new Map<number, Fit[]>([[0, [{ key: "j", rank: 2 }, { key: "k", rank: 0 }]], [1, [{ key: "k", rank: 2 }]]]));
    assert.equal(got.get("k"), 0);
    assert.ok(![...got.values()].includes(1));
  });

  it("matchTwins: within a fit, as many rows keep a key as can", () => {
    // Tried first, 0 would take k — the only key 1 fits. 0 moves to j.
    const got = matchTwins(new Map<number, Fit[]>([[0, [{ key: "k", rank: 1 }, { key: "j", rank: 1 }]], [1, [{ key: "k", rank: 1 }]]]));
    assert.deepEqual(new Map(got), new Map([["k", 1], ["j", 0]]));
  });
});

/**
 * THE DCA SEQUENCE (CF4): a leg is sent, lands, and the next leg of the same
 * post is sent while the landed row is on screen. The landed row must keep the
 * bare postId and stay seen; the new order in flight is the news.
 */
describe("the next leg of a post already on screen (CF4)", () => {
  beforeEach(() => {
    forgetKeysForTest();
    forgetSeenForTest();
  });
  const leg = (outcome: "pending" | "landed", t: number) =>
    row({ outcome, outcomeText: outcome === "pending" ? "sent, waiting on the chain" : "landed", at: t, firstAt: t, sizeUsdg: null, head: "buy TSLA" });
  const read = (rows: FeedRow[]) => {
    const beats = beatsOf(rows, agents);
    const keys = beats.map(freshKeyOf);
    const fresh = freshAmong(keys);
    markSeen(keys);
    return beats.map((b) => ({ outcome: b.outcome, key: b.id, fresh: isFresh(b, fresh) }));
  };

  it("LEG SENT, LANDED, NEXT LEG SENT: the landed row keeps the bare id and is not new; the order in flight is", () => {
    read([row({ postId: "f".repeat(32), symbol: "AAPL", at: NOW - 9000, firstAt: NOW - 9000 })]); // the page, primed
    read([leg("pending", NOW - 3000)]);
    const landed = read([leg("landed", NOW - 3000)]);
    assert.deepEqual(landed, [{ outcome: "landed", key: PID, fresh: true }], "the fill is news, under the element it was sent under");
    const next = read([leg("pending", NOW - 60), leg("landed", NOW - 3000)]);
    assert.deepEqual(next.find((b) => b.outcome === "landed"), { outcome: "landed", key: PID, fresh: false });
    const sent = next.find((b) => b.outcome === "pending")!;
    assert.notEqual(sent.key, PID);
    assert.equal(sent.fresh, true);
    assert.ok(read([leg("pending", NOW - 60), leg("landed", NOW - 3000)]).every((b) => !b.fresh), "and read again, nothing is");
  });

  it("A STALE READ that shows the settled order in flight again does not take its key back", () => {
    // /api/theses is served stale-while-revalidate, so an older body can
    // follow a newer one. The order that landed keeps the element its fill
    // was drawn in: the hand-over released the in-flight row's claim.
    read([leg("pending", NOW - 3000)]);
    read([leg("landed", NOW - 3000)]);
    const stale = read([leg("pending", NOW - 3000), leg("landed", NOW - 3000)]);
    assert.equal(stale.find((b) => b.outcome === "landed")!.key, PID);
    assert.equal(stale.find((b) => b.outcome === "landed")!.fresh, false);
  });

  it("AN ORDER RE-SENT WHILE IN FLIGHT, WHOSE FIRST SEND LANDS: the order still in flight keeps its element; the fill is the news", () => {
    // One in-flight row with two copies (sent, re-sent). The first send lands:
    // the row in flight is still there, now only its newer copy, so it is the
    // same row and keeps its key. The in-flight hand-over is for an order that
    // is gone — here the fill is a new row, and it is what slides in.
    const sent = (first: number, last: number, said: number) =>
      row({ outcome: "pending", outcomeText: "sent, waiting on the chain", at: last, firstAt: first, said, sizeUsdg: null, head: "buy TSLA" });
    read([row({ postId: "f".repeat(32), symbol: "AAPL", at: NOW - 9000, firstAt: NOW - 9000 })]); // the page, primed
    const inFlight = read([sent(NOW - 200, NOW - 100, 2)]);
    const landed = read([sent(NOW - 100, NOW - 100, 1), leg("landed", NOW - 200)]);
    assert.deepEqual(landed.find((b) => b.outcome === "pending"), { outcome: "pending", key: inFlight[0]!.key, fresh: false });
    const fill = landed.find((b) => b.outcome === "landed")!;
    assert.notEqual(fill.key, inFlight[0]!.key);
    assert.equal(fill.fresh, true);
  });

  it("a landed row pushed out and replaced by a new order does not lend the order its key", () => {
    // Not the same trade settling: the new order is news, and the old fill
    // keeps its key for when it comes back.
    const first = read([leg("landed", NOW - 3000)]);
    const next = read([leg("pending", NOW - 60)]);
    assert.notEqual(next[0]!.key, first[0]!.key);
    assert.equal(next[0]!.fresh, true);
    const back = read([leg("pending", NOW - 60), leg("landed", NOW - 3000)]);
    assert.equal(back.find((b) => b.outcome === "landed")!.key, first[0]!.key);
  });
});

/**
 * THE FEED ITSELF PAIRS THE KEYS (CF5). `useFresh` must build the fresh set
 * with the key `isFresh` looks up — `freshKeyOf`, the fill's time for a
 * landed row — or no landed trade is ever new again. The tests above build
 * the set by hand; this renders <Feed>.
 */
describe("the rendered feed marks a new fill new (CF5)", () => {
  beforeEach(() => {
    forgetKeysForTest();
    forgetSeenForTest();
  });

  it("A LANDED ROW WHOSE NEWEST FILL MOVED CARRIES wire-new; the same row unchanged does not", async () => {
    const { Feed } = await import("./screens/Feed");
    const render = (theses: FeedRow[]) =>
      renderToStaticMarkup(
        createElement(Feed, { theses: theses as never, tokens: [], agents, onToken: () => {}, onProfile: () => {}, onDesk: () => {} }),
      );
    const first = [row({ said: 1, at: NOW })];
    // What the page marked when it drew the first read (the effect a static
    // render does not run), keyed the way a correct page keys it.
    markSeen(beatsOf(first, agents).map(freshKeyOf));
    assert.doesNotMatch(render(first), /wire-new/, "nothing arrived");
    assert.match(render([row({ said: 2, at: NOW + 3600 })]), /wire-beat[^"]*wire-new/, "the second leg arrived");
  });
});

/**
 * THE MARKING HALF, RUN (R3F-2). The render above primes the seen set by hand,
 * because a static render runs no effect — so what the mounted page MARKS after
 * it draws a read was never executed. If that marked the bare ids while the
 * lookup uses `freshKeyOf`, every landed row would read new on every refresh
 * and the whole feed of fills would flash. Here the real <Feed> is mounted and
 * nothing is primed by hand: the page marks what it drew, itself.
 */
describe("the mounted feed marks what it drew (R3F-2)", () => {
  let ui: ReturnType<typeof testDom>;
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    forgetKeysForTest();
    forgetSeenForTest();
    // The likes store asks the server once; it never answers here.
    globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;
    ui = testDom();
  });
  afterEach(async () => {
    await ui.close();
    globalThis.fetch = realFetch;
  });

  const feed = async (theses: FeedRow[]) => {
    const { Feed } = await import("./screens/Feed");
    return createElement(Feed, { theses: theses as never, tokens: [], agents, onToken: () => {}, onProfile: () => {}, onDesk: () => {} });
  };
  // Symbol -> whether its row carries wire-new.
  const drawn = () =>
    new Map(
      [...ui.container.querySelectorAll(".wire-beat")].map((el) => [
        ["TSLA", "NVDA", "AAPL"].find((s) => el.textContent?.includes(s)) ?? "?",
        el.classList.contains("wire-new"),
      ]),
    );
  const fill = row({ said: 1, at: NOW });
  const nvda = row({ postId: "e".repeat(32), symbol: "NVDA", head: "buy NVDA 5.00 USDG", at: NOW + 60, firstAt: NOW + 60 });

  it("A LANDED ROW ALREADY DRAWN IS NOT NEW WHEN ANOTHER ROW ARRIVES BESIDE IT; the arrival is", async () => {
    await ui.render(await feed([fill]));
    assert.deepEqual([...drawn()], [["TSLA", false]], "the first read is the page");
    await ui.render(await feed([fill, nvda]));
    assert.deepEqual(drawn(), new Map([["NVDA", true], ["TSLA", false]]));
    await ui.render(await feed([fill, nvda, row({ postId: "a".repeat(32), symbol: "AAPL", head: "buy AAPL 5.00 USDG", at: NOW + 90, firstAt: NOW + 90 })]));
    assert.deepEqual(drawn(), new Map([["AAPL", true], ["NVDA", false], ["TSLA", false]]), "what arrived last read is seen now");
  });

  it("SWITCHING TABS AND BACK REPLAYS NOTHING — a landed row drawn before the feed unmounted is not new", async () => {
    await ui.render(await feed([fill]));
    await ui.render(await feed([fill, nvda]));
    await ui.remount(await feed([fill, nvda]));
    assert.deepEqual(drawn(), new Map([["NVDA", false], ["TSLA", false]]));
  });

  it("a new fill of a landed row already drawn is new, once", async () => {
    await ui.render(await feed([fill, nvda]));
    await ui.render(await feed([row({ said: 2, at: NOW + 3600 }), nvda]));
    assert.deepEqual(drawn(), new Map([["TSLA", true], ["NVDA", false]]));
    await ui.render(await feed([row({ said: 2, at: NOW + 3600 }), nvda, row({ postId: "a".repeat(32), symbol: "AAPL", head: "buy AAPL 5.00 USDG", at: NOW + 90, firstAt: NOW + 90 })]));
    assert.equal(drawn().get("TSLA"), false, "and drawn once, it is seen");
  });
});
