/**
 * THE CARD THAT COULD NOT BE SCROLLED TO.
 *
 * A tester: "i get this but i cant scroll down, the bottom is cut off and cant
 * scroll further." Measured on the deployed app at 1536x742 with four
 * proposals, and it was worse than reported — not a mobile problem at all:
 *
 *   .proposals          906px tall, no scroller of its own
 *   .desk-page          1,116px of content inside 362px
 *   .body               872px inside 662px, overflow: hidden
 *   document            not scrollable
 *   .desk-conversation  TWELVE pixels — the chat, on the chat screen
 *
 * Three separate things had to be true for content to become unreachable, and
 * each is defensible alone: the shell hides its overflow, a flex child may
 * shrink to nothing, and a notification card sizes to its content. Together
 * they clip whatever the card does not leave room for, silently, with no
 * scrollbar to hint that anything is missing.
 *
 * These pin the three rules that fix it. They read CSS text because that is
 * where the property lives — there is no behaviour here to call.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * The stylesheet with its COMMENTS REMOVED.
 *
 * These assertions are about declarations, and this file's comments quote
 * declarations at length — including the retired ones, which is how a rule gets
 * "found" in the prose explaining why it was deleted. Stripping them first is
 * what makes a `doesNotMatch` mean anything here.
 */
const CSS = readFileSync(new URL("./terminal.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  " ",
);

/** The declaration block for a selector, so a rule cannot be matched from a neighbour's. */
const block = (selector: string): string => {
  const at = CSS.indexOf(selector);
  assert.ok(at > 0, `selector went missing: ${selector}`);
  return CSS.slice(at, CSS.indexOf("}", at));
};

describe("the page can be scrolled to its end", () => {
  it("THE DESK PAGE SCROLLS ITS OWN OVERFLOW", () => {
    // `.body` is `overflow: hidden` — it is the app shell — so a column taller
    // than the viewport is clipped rather than scrolled, and the document does
    // not scroll either. Without this the bottom of the page is unreachable by
    // any means a user has.
    assert.match(block(":where(.terminal-host) .desk-page {"), /overflow-y:\s*auto/);
  });

  it("AND THE CONVERSATION CANNOT BE SQUEEZED TO NOTHING", () => {
    // `min-height: 0` is correct for a flex child that must be allowed to
    // shrink and wrong for the one the screen is named after. It was measured
    // at twelve pixels with a proposals card above it.
    const conv = block(":where(.terminal-host) .desk-page > .desk-conversation {");
    assert.match(conv, /min-height:\s*220px/);
    // It keeps its own scroller: Agent.tsx's auto-follow writes scrollTop here,
    // so turning this into a plain block would silently stop the chat following
    // the latest message.
    assert.match(conv, /overflow-y:\s*auto/);
  });

  it("AND THE CONVERSATION IS THE ONLY SCROLLER IN THE CHAT", () => {
    /**
     * THIS ASSERTION USED TO RUN THE OTHER WAY, and the reversal is the fix
     * rather than a weakening.
     *
     * It required `.proposal-list` to carry `max-height: min(40vh, 320px)`,
     * `overflow-y: auto` and `overscroll-behavior: contain`, and the reasoning
     * was sound for the layout it was written against (3a1a13f): `.proposals`
     * was a SIBLING, `.body` is `overflow: hidden`, and a tall sibling was
     * clipped rather than scrolled.
     *
     * 1b4ea3e moved the card INSIDE `.desk-conversation` the following day. A
     * child of an `overflow-y: auto` box cannot clip its parent, so the cap
     * prevented nothing — while the containment turned the list into a wheel
     * trap. Reported: "i could not scroll completely down to read the rest of
     * the last recommendation… I had to hover my mousepointer to the top at
     * 'Add all 3 to my watchlist'." That button is outside the <ol>, which is
     * why moving there reached the real scroller.
     *
     * The two blocks above — the ones that actually fixed the first report —
     * are untouched.
     */
    const list = block(":where(.terminal-host) .proposal-list {");
    assert.doesNotMatch(list, /max-height/);
    assert.doesNotMatch(list, /overflow-y:\s*auto/);
    assert.doesNotMatch(list, /overscroll-behavior/);
  });

  it("AND NOTHING INLINE IN THE CHAT SWALLOWS THE WHEEL", () => {
    // Generic rather than per-selector, and that is the strengthening: the next
    // inline card cannot reintroduce this, and it is pinned as a PROPERTY of the
    // chat rather than as three declarations on one class.
    //
    // Containment is for overlays that cover what is behind them — a sheet, a
    // dialog — where chaining to the page underneath is the bug. An inline card
    // has nothing behind it to protect.
    for (const cls of ["proposal-list", "proposals", "desk-notice", "desk-note", "desk-blocked"]) {
      const re = new RegExp(`\\.${cls}\\s*\\{[^}]*overscroll-behavior:\\s*contain`, "s");
      assert.doesNotMatch(CSS, re, `${cls} must not trap the wheel`);
    }
  });
});
