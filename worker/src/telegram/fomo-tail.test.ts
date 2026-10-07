/**
 * A Fomo tail as the owner's DM sees it (fomo-tail.ts): the card's words,
 * what following would do, and the list. Pure; the flows are pinned end to
 * end in fomo-dm.integration.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TAIL_COVERAGE_LINE } from "../fomo/render";
import { canConsider, considerRefusedNote, tailAmbiguousText, tailCardText, tailListText, tailReadinessLine } from "./fomo-tail";

const T0 = Date.UTC(2026, 9, 7, 15, 5);
const plain = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

describe("the tail's confirm card", () => {
  it("says who, how long and until when, what she gets, the coverage floor and what following would do", () => {
    const card = plain(tailCardText({ handle: "unipcs", hours: 3, clamped: false, take: false, nowMs: T0, readiness: { mode: "live", blockers: [] } }));
    assert.match(card, /^👀 Tail unipcs on Fomo for 3 hours \(until 18:05 UTC\)\?/);
    assert.ok(card.includes(TAIL_COVERAGE_LINE));
    assert.match(card, /Following is on with real money/);
    assert.doesNotMatch(card, /\bcopy|mirror/i);
    assert.match(plain(tailCardText({ handle: "unipcs", hours: 1, clamped: false, take: false, nowMs: T0, readiness: null })), /for 1 hour \(until 16:05 UTC\)/);
  });

  it("'take it' grants nothing: a tail never skips my normal review", () => {
    const able = plain(tailCardText({ handle: "unipcs", hours: 3, clamped: false, take: true, nowMs: T0, readiness: { mode: "paper", blockers: [] } }));
    assert.match(able, /a tail never skips my normal review/);
    assert.match(able, /only enter if my own checks and the Brain agree/);
    const unable = plain(tailCardText({ handle: "unipcs", hours: 3, clamped: false, take: true, nowMs: T0, readiness: { mode: "off", blockers: ["follow-off"] } }));
    assert.match(unable, /a tail never skips my normal review, and right now following can't act on it/);
  });

  it("a handle that is not a plain one is never shown", () => {
    const card = tailCardText({ handle: "<b>x</b>", hours: 3, clamped: false, take: false, nowMs: T0, readiness: null });
    assert.match(card, /Tail that trader on Fomo/);
    assert.doesNotMatch(card, /<b>x/);
  });
});

describe("what following would do with their buy", () => {
  it("off, unknown, blocked, paper, live", () => {
    assert.equal(canConsider(null), false);
    assert.equal(canConsider({ mode: "off", blockers: ["follow-off"] }), false);
    assert.equal(canConsider({ mode: "paper", blockers: ["scout-off"] }), false);
    assert.equal(canConsider({ mode: "paper", blockers: [] }), true);
    assert.equal(canConsider({ mode: "live", blockers: [] }), true);
    assert.match(tailReadinessLine(null), /can't tell right now/);
    assert.match(tailReadinessLine({ mode: "off", blockers: ["follow-off"] }), /^Following is off/);
    assert.equal(
      tailReadinessLine({ mode: "live", blockers: ["live-not-allowed", "no-vault"] }),
      "Following can't act right now (live follow isn't enabled for this agent; your agent has no Trencher vault, which every follow entry needs), so this tail can only tell you.",
    );
    assert.match(tailReadinessLine({ mode: "paper", blockers: [] }), /on paper/);
  });

  it("live: never promises every entry is a small probe; a considered buy beside another buyer can be a normal entry (review 2026-10-07)", () => {
    const live = tailReadinessLine({ mode: "live", blockers: [] });
    assert.doesNotMatch(live, /any entry would be a small live probe/);
    assert.match(live, /^Following is on with real money/);
    assert.match(live, /On its own it can lead at most to a small probe; with another buyer I track on the same coin it can lead to a normal follow entry\./);
    assert.match(live, /inside your scout budget and per-trade limits/);
    assert.doesNotMatch(live, /\bcopy/i);
  });

  it("a refused consider press says why", () => {
    assert.match(considerRefusedNote({ mode: "paper", blockers: [] }, false), /wasn't on the card/);
    assert.match(considerRefusedNote(null, true), /can't tell right now/);
    assert.match(considerRefusedNote({ mode: "paper", blockers: ["paused"] }, true), /\(entries are paused\)/);
  });
});

describe("the other answers", () => {
  it("two traders answer to one handle: up to three, then the question", () => {
    const four = ["a1", "a2", "a3", "a4"].map((h) => ({ handle: h, displayName: null }));
    assert.equal(tailAmbiguousText("a1", four), "More than one Fomo trader answers to a1: a1, a2, a3. Which one? Send /tail with their exact handle.");
  });

  it("/tails: none, some, and switched off", () => {
    assert.match(tailListText([], false), /^You aren't tailing anyone on Fomo\. \/tail &lt;trader&gt;/);
    const some = plain(tailListText([{ handle: "unipcs", expiresAtMs: T0, consider: true }, { handle: null, expiresAtMs: T0, consider: false }], false));
    assert.match(some, /• unipcs until 15:05 UTC \(their buys go to my normal review\)\n• a trader until 15:05 UTC \(tell only\)/);
    assert.match(tailListText([{ handle: "unipcs", expiresAtMs: T0, consider: false }], true), /switched off on this service/);
  });
});
