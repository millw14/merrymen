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

const CSS = readFileSync(new URL("./terminal.css", import.meta.url), "utf8");

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

  it("AND A LONG PROPOSAL LIST SCROLLS INSIDE ITS CARD", () => {
    // Bounding the LIST rather than the card keeps the heading and the re-sign
    // button — the control an owner has to press to act on any of it — in view
    // at every length.
    const list = block(":where(.terminal-host) .proposal-list {");
    assert.match(list, /max-height:\s*min\(40vh,\s*320px\)/);
    assert.match(list, /overflow-y:\s*auto/);
    // A nested scroller that chains to the page pulls the whole screen when the
    // list ends, which reads as the card jumping.
    assert.match(list, /overscroll-behavior:\s*contain/);
  });
});
