import assert from "node:assert/strict";
import { test } from "node:test";
import { TAIL_DEFAULT_HOURS, TAIL_MAX_HOURS, parseTailArgs, parseTailRequest, saysTail, tailAsksToTake, tailHoursIn } from "./tail-request";

const SELF = ["Shogun", "@merrymanme_bot"];

test("a tail asked for in words: the trader as written, and the hours", () => {
  const starts: [string, { handle: string; hours: number; clamped: boolean }][] = [
    // Milla's exact line, 2026-10-07: only the trader and the hours count; "take it" grants nothing.
    [
      "can you tail unipcs trades for the next 3 hours, inform me of his thesis and if you like the trade as well, take it",
      { handle: "unipcs", hours: 3, clamped: false },
    ],
    ["shogun tail @unipcs for 2h", { handle: "unipcs", hours: 2, clamped: false }],
    ["tail unipcs", { handle: "unipcs", hours: TAIL_DEFAULT_HOURS, clamped: false }],
    ["keep tabs on trader cupsey for a couple hours", { handle: "cupsey", hours: 2, clamped: false }],
    ["keep an eye on unipcs's trades today", { handle: "unipcs", hours: TAIL_MAX_HOURS, clamped: false }],
    ["track unipcs for 90 minutes", { handle: "unipcs", hours: 2, clamped: false }],
    ["monitor unipcs for a few hours", { handle: "unipcs", hours: 3, clamped: false }],
    ["tail unipcs for one hour", { handle: "unipcs", hours: 1, clamped: false }],
    ["tail unipcs’s trades for 4 hrs", { handle: "unipcs", hours: 4, clamped: false }],
  ];
  for (const [line, want] of starts) assert.deepEqual(parseTailRequest(line, SELF), { kind: "start", ...want }, line);
});

test("more than twelve hours is clamped to twelve, and says so", () => {
  assert.deepEqual(parseTailRequest("monitor unipcs for 24 hours", SELF), { kind: "start", handle: "unipcs", hours: 12, clamped: true });
  assert.deepEqual(parseTailRequest("tail @unipcs for 900 minutes", SELF), { kind: "start", handle: "unipcs", hours: 12, clamped: true });
  assert.deepEqual(tailHoursIn("for 13h"), { hours: 12, clamped: true });
  assert.deepEqual(tailHoursIn("for 12h"), { hours: 12, clamped: false });
  assert.deepEqual(tailHoursIn("nothing said"), { hours: TAIL_DEFAULT_HOURS, clamped: false });
  assert.deepEqual(tailHoursIn("0h"), { hours: TAIL_DEFAULT_HOURS, clamped: false }, "nothing below an hour");
});

test("stop forms, one trader or all of them", () => {
  assert.deepEqual(parseTailRequest("stop tailing unipcs", SELF), { kind: "stop", handle: "unipcs" });
  assert.deepEqual(parseTailRequest("untail @unipcs", SELF), { kind: "stop", handle: "unipcs" });
  assert.deepEqual(parseTailRequest("cancel the tail on unipcs", SELF), { kind: "stop", handle: "unipcs" });
  assert.deepEqual(parseTailRequest("quit tracking trader cupsey", SELF), { kind: "stop", handle: "cupsey" });
  assert.deepEqual(parseTailRequest("untail all", SELF), { kind: "stop", handle: null });
  assert.deepEqual(parseTailRequest("stop tracking everyone", SELF), { kind: "stop", handle: null });
  assert.deepEqual(parseTailRequest("stop tailing", SELF), { kind: "stop", handle: null }, "a bare stop with a tail word is every tail");
  assert.deepEqual(parseTailRequest("can you stop tailing unipcs?", SELF), { kind: "stop", handle: "unipcs" }, "a request, not a question about one");
  assert.deepEqual(parseTailRequest("stop tracking @unipcs", SELF), { kind: "stop", handle: "unipcs" });
  for (const line of ["untail", "ok stop tailing for now", "hey shogun, can you stop tailing?", "stop the tails please", "stop tailing them all", "untail everyone", "end all my tails"]) {
    assert.deepEqual(parseTailRequest(line, SELF), { kind: "stop", handle: null }, line);
  }
});

test("a stop is as narrow as a start: every tail only when she says so or says nothing else (review 2026-10-07)", () => {
  // A coin, an address, a pronoun or a thing with no tail word: not about
  // tails at all, so the research planner's unwatch (or the classifier) has
  // it, as before tails existed. These used to stop EVERY tail.
  for (const line of [
    "stop tracking $PONS on fomo",
    "stop tracking $PONS",
    "pine stop tracking $PONS",
    "stop monitoring PONS",
    "stop tracking PONS",
    "stop tracking it",
    "stop tracking this",
    "stop monitoring the cpu",
    "ok stop tracking for now",
    "stop tracking 0x39dbed3a00000000000000000000000000000c0d",
    "stop tracking everything",
    "cancel tracking",
    "stop tailing $PONS",
  ]) {
    assert.equal(parseTailRequest(line, SELF), null, line);
  }
  // Negated, or a question about a tail: nothing stops.
  for (const line of ["don't stop tailing unipcs", "do not stop tracking unipcs", "never stop tailing him", "when will you stop tailing unipcs?", "how long until you stop tailing unipcs", "why did you stop tailing unipcs?"]) {
    assert.equal(parseTailRequest(line, SELF), null, line);
  }
  // Pointing at someone it does not name: she is asked which, and nothing stops.
  for (const line of ["stop tracking him", "stop tailing him", "ok stop tailing him", "stop tracking that guy", "stop tailing the second one", "untail that guy"]) {
    assert.deepEqual(parseTailRequest(line, SELF), { kind: "stop-which" }, line);
  }
  // A comma ends the negation's clause.
  assert.deepEqual(parseTailRequest("not now, stop tailing unipcs", SELF), { kind: "stop", handle: "unipcs" });
  assert.equal(saysTail("stop tailing unipcs"), true);
  assert.equal(saysTail("stop tracking pons"), false);
});

test("never a tail: copy, mirror and follow keep their meaning; coins, her own things, pronouns and the bot itself are not traders", () => {
  for (const line of [
    "copy unipcs trades for 3 hours",
    "copytrade @unipcs",
    "follow unipcs",
    "can you follow unipcs's trades for 3 hours",
    "mirror @unipcs",
    "stop copying unipcs",
    "watch PONS on fomo",
    "track PONS",
    "track $pons",
    "track $pons for me",
    "track my order",
    "keep an eye on the price",
    "stop monitoring the price",
    "stop tracking my order",
    "tail him",
    "keep an eye on it",
    "can you tail shogun",
    "tail @merrymanme_bot for 2h",
    "i love the tail on that chart",
    "what are the theses on PONS",
    "",
    "x".repeat(401),
  ]) {
    assert.equal(parseTailRequest(line, SELF), null, line);
  }
  assert.equal(parseTailRequest(undefined, SELF), null);
  assert.equal(parseTailRequest(42, SELF), null);
});

test("/tail NAME [hours]: the command's own argument", () => {
  assert.deepEqual(parseTailArgs("unipcs 3h", SELF), { handle: "unipcs", hours: 3, clamped: false });
  assert.deepEqual(parseTailArgs("unipcs", SELF), { handle: "unipcs", hours: TAIL_DEFAULT_HOURS, clamped: false });
  assert.deepEqual(parseTailArgs("unipcs 5", SELF), { handle: "unipcs", hours: 5, clamped: false }, "a bare number is hours");
  assert.deepEqual(parseTailArgs("unipcs 30", SELF), { handle: "unipcs", hours: 12, clamped: true });
  assert.deepEqual(parseTailArgs("@unipcs 2 hours", SELF), { handle: "unipcs", hours: 2, clamped: false });
  assert.deepEqual(parseTailArgs("unipcs 90 minutes", SELF), { handle: "unipcs", hours: 2, clamped: false });
  for (const bad of ["", "   ", "unipcs please", "it 3h", "him", "shogun 2h", "@merrymanme_bot", "a b c d", "123", "uni.pcs"]) {
    assert.equal(parseTailArgs(bad, SELF), null, bad);
  }
  assert.equal(parseTailArgs(null, SELF), null);
});

test("'take it' is noticed only so the card can say it grants nothing", () => {
  assert.equal(tailAsksToTake("can you tail unipcs trades for the next 3 hours, inform me of his thesis and if you like the trade as well, take it"), true);
  assert.equal(tailAsksToTake("tail unipcs and buy it if it looks good"), true);
  assert.equal(tailAsksToTake("tail unipcs for 3h"), false);
  assert.equal(tailAsksToTake("take a look at unipcs"), false);
  assert.equal(tailAsksToTake(undefined), false);
});
