/**
 * THE FEED IS TRADES AND CHANGED MINDS, NOT A CLOCK.
 *
 * The reader now returns trades on their own budget and one view per agent and
 * name. This is the other half: how those rows are laid out. A view that has
 * only been repeated sits where it FIRST arrived, and "All" says each agent's
 * unchanged holds once. Every case goes through `beatsOf` from rows in
 * publisher units, the way `/api/theses` serves them, and the pills through
 * `pillBeats`, the function the Feed screen calls.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { beatsOf, chorusOf, compactHolds, FRESH_HOLDS_SHOWN, lanesOf, mentionTargets, pillBeats, watchCount, whenLabel, type Beat, type FeedRow } from "./beat";
import type { LiveAgent } from "./live";
import { alertsOf, alertsRead, emptyAlerts, RAIL_ALERTS } from "../lib/rail-alerts";

const NOW_MS = Date.UTC(2026, 8, 22, 12, 0, 0);
const NOW = Math.floor(NOW_MS / 1000);

const row = (over: Partial<FeedRow> = {}): FeedRow =>
  ({
    name: "Shogun",
    slug: "shogun",
    handle: null,
    action: "hold",
    symbol: "TSLA",
    sizeUsdg: null,
    reason: "Depth is thin; nothing worth taking.",
    paper: false,
    head: "hold TSLA",
    outcome: "view",
    said: 1,
    at: NOW,
    firstAt: NOW,
    unchangedSince: NOW,
    ...over,
  }) as FeedRow;

/** A post said `said` times with nothing else in between, the first `ago` seconds back. */
const repeated = (said: number, ago: number, over: Partial<FeedRow> = {}) =>
  row({ said, at: NOW - 60, firstAt: NOW - ago, unchangedSince: NOW - ago, ...over });

const agents: LiveAgent[] = ["shogun", "sirsendit"].map(
  (slug) =>
    ({
      slug,
      name: slug,
      handle: `@${slug}`,
      owner: null,
      pnlBps: null,
      curve: [],
      landed: 0,
      last: null,
      glance: { id: "custom", label: "Strategy" },
      thesis: "",
    }) as LiveAgent,
);

const buy = (over: Partial<FeedRow> = {}) =>
  row({ action: "buy", symbol: "NVDA", sizeUsdg: 5, head: "buy NVDA 5.00 USDG", outcome: "landed", reason: "Adding under its average.", at: NOW - 3600, firstAt: NOW - 3600, unchangedSince: NOW - 3600, ...over });

const none = new Map<string, unknown>();

describe("a repeated view keeps the time it first arrived", () => {
  it("×24 since 2h sits BELOW a trade from an hour ago, not on top of it", () => {
    const beats = beatsOf([repeated(24, 2 * 3600), buy()], agents);
    assert.deepEqual(beats.map((b) => b.kind), ["trade", "view"]);
    const view = beats[1]!;
    assert.equal(view.sinceMs, (NOW - 2 * 3600) * 1000);
    assert.equal(whenLabel(view, NOW_MS), "×24 · since 2h");
  });

  it("a first-time view is news, and says how old it is", () => {
    const [fresh] = beatsOf([row({ at: NOW - 120, firstAt: NOW - 120, unchangedSince: NOW - 120 })], agents);
    assert.equal(fresh!.sinceMs, null);
    assert.equal(whenLabel(fresh!, NOW_MS), "2m");
  });

  it("a row with no firstAt is never given a guessed one", () => {
    const [old] = beatsOf([row({ said: 5, at: NOW - 120, firstAt: undefined, unchangedSince: undefined })], agents);
    assert.equal(old!.sinceMs, null);
    assert.equal(whenLabel(old!, NOW_MS), "2m");
  });

  it("A REPEAT WHOSE RUN WAS BROKEN HAS NO 'SINCE' — A, then B, then A again", () => {
    // The reader sends firstAt (every copy in the window) and unchangedSince
    // (null when another word came in between). Only the second may say since.
    const [aba] = beatsOf([row({ said: 2, at: NOW - 60, firstAt: NOW - 7200, unchangedSince: null })], agents);
    assert.equal(aba!.sinceMs, null);
    assert.equal(whenLabel(aba!, NOW_MS), "1m");
    assert.equal(aba!.rankMs, (NOW - 60) * 1000, "and it sits where it was last said");
  });

  it("and a server that never said whether the run was unbroken proves nothing", () => {
    const [legacy] = beatsOf([row({ said: 9, at: NOW - 60, firstAt: NOW - 7200, unchangedSince: undefined })], agents);
    assert.equal(legacy!.sinceMs, null);
  });

  it("a repeated TRADE that happened still sits where it happened — it is an event", () => {
    const [trade] = beatsOf([buy({ said: 2, at: NOW - 60, firstAt: NOW - 7200, unchangedSince: NOW - 7200, outcome: "landed" })], agents);
    assert.equal(trade!.rankMs, (NOW - 60) * 1000);
    assert.equal(trade!.sinceMs, null);
  });

  it("A REFUSAL RE-PROPOSED EVERY TICK SITS WHERE IT BEGAN, and says how often", () => {
    // Nothing happened, over and over: a basket leg the key does not cover,
    // refused on every tick, arrived as "now" each time and sat on top all day.
    const refused = buy({ said: 30, at: NOW - 60, firstAt: NOW - 7200, unchangedSince: NOW - 7200, outcome: "refused", outcomeText: "that asset is not in its signed permissions" });
    const beats = beatsOf([refused, row({ at: NOW - 3600, firstAt: NOW - 3600, unchangedSince: NOW - 3600 })], agents);
    assert.deepEqual(beats.map((b) => b.kind), ["view", "trade"], "an hour-old view is newer news than a two-hour-old refusal");
    const trade = beats[1]!;
    assert.equal(trade.rankMs, (NOW - 7200) * 1000);
    assert.equal(whenLabel(trade, NOW_MS), "×30 · since 2h");
  });

  it("a lull is measured between where rows sit", () => {
    const beats = beatsOf([buy({ at: NOW }), row({ said: 3, at: NOW - 30, firstAt: NOW - 4 * 3600, unchangedSince: NOW - 4 * 3600 })], agents);
    const lanes = lanesOf(beats);
    assert.deepEqual(lanes.map((l) => l.kind), ["beat", "lull", "beat"]);
  });
});

describe("All says each agent's unchanged holds once", () => {
  // A strategy re-proposing the same hold on twelve names: each an unbroken
  // repeat, which is what the watch line exists to fold.
  const standing = Array.from({ length: 12 }, (_, i) =>
    repeated(8, 3600 + i * 60, { symbol: `T${String(i).padStart(11, "0")}`, head: `hold T${String(i).padStart(11, "0")}`, reason: `review ${i}`, at: NOW - i * 30 }),
  );
  const all = (beats: Beat[]) => pillBeats(beats, "all", none, {});

  it("TWELVE STANDING HOLDS AND ONE TRADE — the trade is on the page", () => {
    const shown = all(beatsOf([...standing, buy({ at: NOW - 3 * 3600, firstAt: NOW - 3 * 3600 })], agents));
    assert.equal(shown.filter((b) => b.kind === "trade").length, 1);
    assert.equal(shown.length, 2, "one trade and one summary line");
  });

  it("the summary counts every name and carries the newest hold in full", () => {
    const [watch] = all(beatsOf(standing, agents));
    assert.ok(watch && watch.kind === "watch");
    assert.equal(watch.count, 12);
    assert.equal(watch.members.length, 12, "counted, not dropped");
    assert.equal(watch.latest.reason, "review 0");
    assert.equal(watch.postId, null, "a summary is not a post and cannot be liked");
    assert.equal(watchCount(watch), "12 tokens");
  });

  it("A COUNT FROM A TRUNCATED READ IS A FLOOR, AND SAYS SO", () => {
    // The reader caps how many names one agent may fill; when it had more, it
    // marks the agent's rows, and "watching 10 tokens" would be a false total.
    const [watch] = all(beatsOf(standing.map((r) => ({ ...r, moreNames: true })), agents));
    assert.ok(watch && watch.kind === "watch");
    assert.equal(watchCount(watch), "at least 12 tokens");
  });

  it("A FRESH OR CHANGED HOLD IS NEWS — it keeps its own row", () => {
    // A market review is published only when its bias flipped, so it is news
    // by construction — and it was folded unless it was the agent's newest.
    const flip = row({ symbol: "AAPL", head: "hold AAPL", reason: "AAPL -1% over 20h, below its mean.", at: NOW - 1800, firstAt: NOW - 1800, unchangedSince: NOW - 1800 });
    const changed = row({ symbol: "MSFT", head: "hold MSFT", reason: "Depth came back; still no entry.", said: 3, at: NOW - 900, firstAt: NOW - 5000, unchangedSince: null });
    const shown = all(beatsOf([...standing, flip, changed], agents));
    assert.ok(shown.some((b) => b.kind === "view" && b.symbol === "AAPL"), "the flip is on the page");
    assert.ok(shown.some((b) => b.kind === "view" && b.symbol === "MSFT"), "and so is the changed view");
    const watch = shown.find((b) => b.kind === "watch");
    assert.ok(watch && watch.kind === "watch" && watch.count === 12, "only the standing ones are folded");
  });

  it("one hold stays a normal row, and another agent keeps its own", () => {
    const other = repeated(4, 5 * 3600, { slug: "sirsendit", name: "SirSendIt", symbol: "AAPL", head: "hold AAPL", at: NOW - 5 * 3600 + 60 });
    const shown = all(beatsOf([...standing, other], agents));
    assert.deepEqual(
      shown.map((b) => `${b.kind}:${b.actor.slug}`),
      ["watch:shogun", "view:sirsendit"],
    );
  });

  it("a view that is not a hold is never folded into the summary", () => {
    const thesis = row({ action: null, symbol: null, head: "", reason: "Cash is the position until breadth returns.", at: NOW - 10, firstAt: NOW - 10 });
    const shown = all(beatsOf([...standing, thesis], agents));
    assert.ok(shown.some((b) => b.kind === "view" && b.reason.startsWith("Cash is the position")));
  });

  it("a liked standing hold keeps its own row and its heart", () => {
    const liked = standing.map((r, i) => ({ ...r, postId: `p${i}` }));
    const shown = all(beatsOf(liked, agents)).length;
    const withLike = pillBeats(beatsOf(liked, agents), "all", none, { p3: 2 });
    assert.equal(shown, 1, "unliked, the twelve are one line");
    assert.ok(withLike.some((b) => b.kind === "view" && b.postId === "p3"), "the liked one is its own post");
    const watch = withLike.find((b) => b.kind === "watch");
    assert.ok(watch && watch.kind === "watch" && watch.count === 11);
  });

  it("an agent's newest fresh holds keep their rows; its older ones join the watch line", () => {
    const fresh = Array.from({ length: 5 }, (_, i) => row({ symbol: `F${i}`, head: `hold F${i}`, reason: `fresh ${i}`, at: NOW - i }));
    const shown = compactHolds(beatsOf(fresh, agents));
    assert.deepEqual(shown.map((b) => b.kind), ["view", "view", "view", "watch"]);
    assert.deepEqual(shown.filter((b) => b.kind === "view").map((b) => b.symbol), ["F0", "F1", "F2"], "the newest three, as news");
    const watch = shown.find((b) => b.kind === "watch");
    assert.ok(watch && watch.kind === "watch" && watch.count === 2, "the two older, counted");
    assert.equal(
      compactHolds(beatsOf(fresh.slice(0, FRESH_HOLDS_SHOWN), agents)).every((b) => b.kind === "view"),
      true,
      "up to the bound nothing fresh is folded",
    );
  });

  it("A TRENCHER REVIEWING IN NEW WORDS EVERY THIRTY SECONDS DOES NOT BURY A TRADE", () => {
    // The fix-round review's reproduction: one agent's fresh-prose holds are
    // never repeats, so none carried a "since" to fold on, and All put 39 of
    // them above a landed buy three hours old.
    const reviews = Array.from({ length: 39 }, (_, i) =>
      row({ symbol: `T${String(i).padStart(11, "0")}`, head: `hold T${i}`, reason: `pool review ${i}: buyers ${i % 7} deep`, at: NOW - i * 30, firstAt: NOW - i * 30, unchangedSince: NOW - i * 30 }),
    );
    const shown = all(beatsOf([...reviews, buy({ slug: "sirsendit", name: "SirSendIt", at: NOW - 3 * 3600, firstAt: NOW - 3 * 3600 })], agents));
    const at = shown.findIndex((b) => b.kind === "trade");
    assert.ok(at >= 0 && at <= FRESH_HOLDS_SHOWN + 1, `the buy is row ${at + 1}, not row 40`);
    const watch = shown.find((b) => b.kind === "watch");
    assert.ok(watch && watch.kind === "watch" && watch.count === 39 - FRESH_HOLDS_SHOWN, "every other review is counted in the line");
  });
});

describe("five agents saying one shared line is one crowd, not five convictions", () => {
  const fleet = ["shogun", "sirsendit", "tuck", "marian", "scarlet"];
  const crowdAgents = fleet.map((slug) => ({ ...agents[0]!, slug, name: slug, handle: `@${slug}` }) as LiveAgent);
  const review = (slug: string, i: number, reason: string, over: Partial<FeedRow> = {}) =>
    row({ slug, name: slug, reason, head: "hold TSLA", at: NOW - i * 40, firstAt: NOW - i * 40, unchangedSince: NOW - i * 40, ...over });

  it("the same hold from five agents — figures drifting — is one chorus naming all five", () => {
    const rows = fleet.map((s, i) => review(s, i, `TSLA +1.${i}% over 2${i}h, above its mean.`));
    const beats = pillBeats(beatsOf(rows, crowdAgents), "holds", none, {});
    assert.equal(beats.length, 1);
    const [chorus] = beats;
    assert.ok(chorus && chorus.kind === "chorus");
    assert.equal(chorus.symbol, "TSLA");
    assert.deepEqual(chorus.actors.map((a) => a.slug), fleet, "everybody in it, newest first");
    // The words are ONE member's, attributed to that member.
    assert.equal(chorus.latest.actor.slug, "shogun");
    assert.equal(chorus.reason, "TSLA +1.0% over 20h, above its mean.");
    assert.equal(chorus.postId, null, "a crowd is not one post");
  });

  it("a crowd is never formed from one agent", () => {
    const beats = chorusOf(beatsOf([review("shogun", 0, "TSLA +1.0% over 20h, above its mean.")], crowdAgents));
    assert.equal(beats[0]!.kind, "view");
  });

  it("different views stay apart, and so do trades", () => {
    const rows = [
      review("shogun", 0, "TSLA +1.0% over 20h, above its mean."),
      review("sirsendit", 1, "TSLA -1.0% over 20h, below its mean."),
      buy({ slug: "tuck", name: "tuck", symbol: "TSLA" }),
      buy({ slug: "marian", name: "marian", symbol: "TSLA" }),
    ];
    const kinds = chorusOf(beatsOf(rows, crowdAgents)).map((b) => b.kind).sort();
    assert.deepEqual(kinds, ["trade", "trade", "view", "view"]);
  });

  it("and the All summary leaves a chorus alone", () => {
    const rows = fleet.map((s, i) => review(s, i, "TSLA +1.0% over 20h, above its mean."));
    assert.deepEqual(pillBeats(beatsOf(rows, crowdAgents), "all", none, {}).map((b) => b.kind), ["chorus"]);
  });

  it("A LIKED HOLD IS NOT FOLDED INTO A CROWD — it keeps its like control, and Top finds it", () => {
    // The reviewer's reproduction: two agents' identical TSLA holds, one liked.
    // Folded, the only liked post became a chorus with no post id, Top kept
    // nothing, and the heart was gone from every pill.
    const rows = [
      review("shogun", 0, "TSLA +1.0% over 20h, above its mean.", { postId: "p-liked" }),
      review("sirsendit", 1, "TSLA +1.0% over 20h, above its mean.", { postId: "p-other" }),
    ];
    const beats = beatsOf(rows, crowdAgents);
    const counts = { "p-liked": 3 };
    assert.deepEqual(pillBeats(beats, "top", none, counts).map((b) => b.postId), ["p-liked"]);
    const all = pillBeats(beats, "all", none, counts);
    assert.deepEqual(all.map((b) => `${b.kind}:${b.postId}`).sort(), ["view:p-liked", "view:p-other"], "a crowd of one unliked agent is not a crowd");
    // With nobody's like on it, the same two are one chorus again.
    assert.deepEqual(pillBeats(beats, "all", none, {}).map((b) => b.kind), ["chorus"]);
  });

  it("A MEMBER'S MENTION OF ANOTHER AGENT STAYS IN DEBATES", () => {
    const rows = fleet.map((s, i) => review(s, i, "TSLA +1.0% over 20h, above its mean."));
    const beats = beatsOf(rows, crowdAgents);
    const member = beats.find((b) => b.actor.slug === "tuck")!;
    const debate = pillBeats(beats, "debate", new Map([[member.id, [{ handle: "shogun", slug: "shogun", name: "shogun" }]]]), {});
    assert.deepEqual(debate.map((b) => b.actor.slug), ["tuck"]);
  });
});

describe("what an @ in a post can name", () => {
  const actor = (slug: string, name: string, over: Partial<FeedRow> = {}) =>
    beatsOf([row({ slug, name, ...over })], [])[0]!;

  it("AN AGENT ANSWERS TO ITS NAME, AND TO ITS OWNER'S HANDLE ONLY ONCE PROVEN", () => {
    const targets = mentionTargets([
      actor("shogun", "Shogun", { handle: "elonmusk" }),
      actor("sirsendit", "SirSendIt", { handle: "sir_x", handleVerified: true }),
    ]);
    assert.deepEqual([...targets.keys()].sort(), ["shogun", "sir_x", "sirsendit"]);
    assert.ok(!targets.has("elonmusk"), "a typed handle nobody proved names nobody");
    assert.equal(targets.get("sir_x")!.name, "SirSendIt", "a mention prints the agent, whichever token named it");
  });

  it("a name two agents share names neither", () => {
    const targets = mentionTargets([actor("a1", "Robin"), actor("a2", "Robin"), actor("a3", "Tuck")]);
    assert.ok(!targets.has("robin"));
    assert.ok(targets.has("tuck"));
  });
});

describe("the alerts rail is trades", () => {
  it("holds are left to the feed; a refusal is still an alert", () => {
    const rows = [
      row({ at: NOW }),
      buy({ outcome: "refused", outcomeText: "past today's spending cap" }),
      row({ action: null, symbol: null }),
      buy({ action: "sell", outcome: "landed" }),
    ];
    const alerts = alertsOf(rows);
    assert.deepEqual(alerts.map((a) => `${a.action}:${a.outcome}`), ["buy:refused", "sell:landed"]);
  });

  it("and it fits the rail", () => {
    assert.equal(alertsOf(Array.from({ length: 40 }, () => buy())).length, RAIL_ALERTS);
  });

  it("an unreadable read is not a quiet day", () => {
    assert.equal(alertsRead({ source: "none" }), "unreadable");
    assert.equal(alertsRead(null), "unreadable");
    assert.equal(emptyAlerts(alertsRead(null)), "Alerts unavailable.");
  });

  it("A READ OF PART OF THE DAY DOES NOT CLAIM THE DAY", () => {
    // The rail shows PUBLISHED trades from a bounded scan. "No trades in the
    // last day" was printed off any read that answered — while a landed buy
    // sat past the end of the scan, and while an owner's chat trade, which is
    // never published, was the day's only trade.
    assert.equal(alertsRead({ source: "sqlite", tradesComplete: true }), "complete");
    assert.equal(alertsRead({ source: "sqlite", tradesComplete: false }), "partial");
    assert.equal(alertsRead({ source: "sqlite" }), "partial", "a server that predates the flag proved nothing");
    assert.equal(emptyAlerts("complete"), "No published trades in the last day.");
    assert.equal(emptyAlerts("partial"), "No published trades among the latest posts.");
    for (const state of ["complete", "partial", "unreadable"] as const) {
      assert.doesNotMatch(emptyAlerts(state), /^No trades/, "never a claim about trades that were not published");
    }
  });
});
