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

type Rule = { at: string | null; selector: string; body: string };

/**
 * Every rule in a sheet, with the at-rule it sits in (null at the top level) —
 * groupchat-screen.test.ts's reader, for any sheet. A text search cannot tell
 * a phone rule from a desktop one, and that difference is the whole of what
 * the phone tests below are about.
 */
function sheet(file: string): Rule[] {
  const css = readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
  const out: Rule[] = [];
  const at: string[] = [];
  let prelude = "";
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]!;
    if (ch === "{") {
      const head = prelude.trim().replace(/\s+/g, " ");
      prelude = "";
      if (head.startsWith("@")) {
        at.push(head.replace(/\s*:\s*/g, ": "));
        continue;
      }
      const end = css.indexOf("}", i);
      out.push({ at: at.at(-1) ?? null, selector: head, body: css.slice(i + 1, end) });
      i = end;
      continue;
    }
    if (ch === "}") {
      at.pop();
      prelude = "";
      continue;
    }
    prelude += ch;
  }
  return out;
}

const PHONE = "@media (max-width: 1099px)";

/** The one rule with exactly this selector inside the phone's media blocks. */
function phone(selector: string): Rule {
  const hits = sheet("./polish.css").filter((r) => r.at === PHONE && r.selector === selector);
  assert.equal(hits.length, 1, `expected one phone rule for ${selector}, found ${hits.length}`);
  return hits[0]!;
}

function decl(rule: { body: string }, prop: string): string | null {
  const m = rule.body.match(new RegExp(`(?:^|;)\\s*${prop.replace(/[-]/g, "\\-")}\\s*:\\s*([^;]+)`));
  return m ? m[1]!.trim() : null;
}

/**
 * Specificity, for the selectors this file compares, which are built from
 * classes alone: `:where()` counts nothing and `:has()` counts its argument.
 * Enough to say which of two rules on the same element wins — the question
 * the old floor test never asked.
 */
const weight = (selector: string): number =>
  (selector.replace(/:where\([^)]*\)/g, "").match(/\.[\w-]+/g) ?? []).length;

describe("the page can be scrolled to its end", () => {
  it("THE DESK PAGE SCROLLS ITS OWN OVERFLOW", () => {
    // `.body` is `overflow: hidden` — it is the app shell — so a column taller
    // than the viewport is clipped rather than scrolled, and the document does
    // not scroll either. Without this the bottom of the page is unreachable by
    // any means a user has. (On a phone the shell itself scrolls now and the
    // page gives this up — see "the phone chat" below.)
    assert.match(block(":where(.terminal-host) .desk-page {"), /overflow-y:\s*auto/);
  });

  it("AND THE CONVERSATION CANNOT BE SQUEEZED TO NOTHING — by a rule that wins", () => {
    /**
     * THIS USED TO PIN A FLOOR THAT NEVER APPLIED. It asserted `min-height:
     * 220px` on `.desk-page > .desk-conversation`, and the day after that was
     * written 1b4ea3e's more specific `.body > .desk-page > .desk-conversation
     * { min-height: 0 }` zeroed it everywhere. The test stayed green for a
     * month while an iPhone in the recovery state gave the conversation
     * sixty-nine pixels. Reading the text of a declaration says nothing about
     * whether it is the one the browser uses; the selectors have to be weighed.
     */
    const zero = sheet("./terminal.css").find(
      (r) => r.at === null && r.selector === ":where(.terminal-host) .body > .desk-page > .desk-conversation",
    );
    assert.ok(zero, "the rule the floor has to beat went missing — re-weigh the floor against its replacement");
    assert.equal(decl(zero, "min-height"), "0");
    const floor = phone(".terminal-host .body > .desk-page > .desk-conversation");
    assert.equal(decl(floor, "min-height"), "160px");
    assert.ok(weight(floor.selector) > weight(zero.selector), "the phone floor must outrank the rule that zeroes it");
    // Sized by the room it is given, never by the history it holds — without
    // this every message counts toward the page's floor (see below) and the
    // whole page grows past the screen instead of the thread scrolling.
    assert.equal(decl(floor, "contain"), "size");
    // And the dead declaration does not come back to look like a floor.
    assert.doesNotMatch(block(":where(.terminal-host) .desk-page > .desk-conversation {"), /min-height/);
  });

  it("and it keeps its own scroller", () => {
    // Agent.tsx's auto-follow writes scrollTop here, so turning this into a
    // plain block would silently stop the chat following the latest message.
    assert.match(block(":where(.terminal-host) .desk-page > .desk-conversation {"), /overflow-y:\s*auto/);
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

describe("the phone chat takes what the shell leaves", () => {
  /**
   * "CHATTING ON MOBILE IS A HEADACHE." Measured at 390x750 in the recovery
   * state: sixty-nine pixels of conversation, and the floating tab bar over the
   * composer by 8px — 56px with the tour's relaunch row above the page. The
   * page was a fixed `100dvh - var(--nav) - 26px` with --nav still the old
   * 52px bar's sum, inside a shell that clips, so anything mounted above it
   * pushed the composer under the bar by exactly its own height.
   */
  it("THE PAGE IS THE FLEXIBLE CHILD OF THE SHELL, NOT A FIXED HEIGHT", () => {
    const page = phone(".terminal-host .body > .desk-page");
    assert.equal(decl(page, "flex"), "1 1 auto");
    assert.equal(decl(page, "height"), "auto");
    // `auto`, never 0, and not a scroller: a page allowed below what it holds
    // spills the composer past the shell's end padding with no scroll left to
    // bring it out — the trap groupchat.css records.
    assert.equal(decl(page, "min-height"), "auto");
    assert.equal(decl(page, "overflow"), "visible");
  });

  it("AND THE SHELL CLEARS THE REAL BAR, and scrolls rather than clips when the floor is reached", () => {
    const shell = phone(".terminal-host .body:has(> .desk-page)");
    assert.equal(decl(shell, "padding-bottom"), "var(--tabbar-clear)");
    assert.equal(decl(shell, "overflow-y"), "auto");
  });

  it("and the clearance is computed from the bar it clears", () => {
    // One height, one lift: the bar and what clears it cannot drift apart the
    // way the 52px bar and `--nav: 76px` did.
    const vars = phone(".terminal-host");
    assert.equal(decl(vars, "--tabbar-h"), "64px");
    const lift = "max(10px, env(safe-area-inset-bottom))";
    assert.equal(decl(vars, "--tabbar-clear"), `calc(var(--tabbar-h) + ${lift} + 8px)`);
    const bar = phone(".terminal-host .app > .tabbar");
    assert.equal(decl(bar, "height"), "var(--tabbar-h)");
    assert.equal(decl(bar, "bottom"), lift);
  });

  it("NO HIGHER RULE TAKES THE PAGE'S FLOOR AWAY on a phone", () => {
    // service-notice.css set `min-height: 0` on the page while a notice was up,
    // and outranks the phone rule. With it, the composer sat 66px under the bar
    // at 375x667 with nothing to scroll. It is the desktop page's alone now.
    const notice = sheet("./service-notice.css").filter((r) => r.selector.includes("> .desk-page"));
    assert.ok(notice.length > 0, "the rule went missing — then this test has nothing to guard");
    for (const rule of notice) {
      assert.equal(rule.at, "@media (min-width: 1100px)", `${rule.selector} must not reach a phone`);
    }
  });

  it("the tour's relaunch row stays off the chat, and only the chat", () => {
    // The language picker and "Take the tour again" were 48px of a phone's
    // conversation on every visit; every other tab still shows them.
    assert.equal(decl(phone(".terminal-host .body:has(> .desk-page) > .tour-relaunch"), "display"), "none");
    const elsewhere = sheet("./polish.css").filter((r) => r.selector.includes(".tour-relaunch"));
    assert.equal(elsewhere.length, 1, "no second rule hides it on another screen");
  });
});
