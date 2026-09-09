/**
 * THE CHAT SCREEN HAS TO KEEP ITS ROOM.
 *
 * Reported: "the chat design is too packed and isnt good to look at especially
 * on mobile … the 'your agent found 5 coins it wants to trade' just blocks the
 * way", and for desktop: "can you make the chat more easy? like maybe aligning
 * it to the right like a small popup that can be moved around".
 *
 * THE MEASUREMENT BEHIND THIS FILE, taken at 375x812 against the real
 * stylesheet: the conversation had 394px with nothing above it, 220px with the
 * proposals panel pinned above it, and 83px with that panel expanded. Two
 * banners pushed the composer 90px past a container whose parent clips, which
 * is how content ends up drawn over other content.
 *
 * Two causes, both fixed, both pinned here because both are one line and both
 * are silent when they come back:
 *
 *   `.body > .desk-page` was a grid with `grid-template-rows: auto auto
 *   minmax(0, 1fr) auto` — four tracks, so the one row allowed to grow was
 *   whichever child happened to be THIRD. The screen renders more than four
 *   whenever anything is announced above the chat, and the flexible track then
 *   landed on the portfolio.
 *
 *   And the announcements were pinned above the conversation at all, so they
 *   came out of the only flexible row. Inside the scroller they cannot.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("the flexible row is named, not counted", () => {
  it("THE CHAT PAGE IS A COLUMN, NOT A FOUR-TRACK GRID", () => {
    // A positional template breaks the moment a child is added above the chat,
    // and children ARE added above the chat: the blocker, the notice, the
    // proposals panel. Flex names the flexible child.
    const css = read("./terminal.css");
    const block = css.slice(css.indexOf(".body > .desk-page {"), css.indexOf(".body > .desk-page {") + 400);
    assert.ok(
      !/grid-template-rows:\s*auto auto minmax\(0, 1fr\) auto/.test(block),
      "a positional row template cannot survive a new banner",
    );
    assert.match(block, /display: flex/);
    assert.match(css, /\.body > \.desk-page > \.desk-conversation \{\s*flex: 1 1 auto;/);
  });
});

describe("announcements scroll with the chat", () => {
  it("THE PROPOSALS PANEL LIVES INSIDE THE CONVERSATION", () => {
    // Pinned above it, it took the conversation's height. Inside the scroller
    // it takes none of it and scrolls away as soon as there is anything to
    // read — which is what "it just blocks the way" was asking for.
    const src = read("./screens/Agent.tsx");
    const conv = src.indexOf('className="desk-conversation"');
    const divider = src.indexOf('className="chat-divider"');
    const proposals = src.indexOf("<Proposals onResign={onResign} />");
    assert.ok(conv > 0 && proposals > conv, "Proposals must render inside the conversation");
    assert.ok(proposals < divider, "and above the conversation's own divider");
  });

  it("and so does the worker notice", () => {
    const src = read("./screens/Agent.tsx");
    const conv = src.indexOf('className="desk-conversation"');
    assert.ok(src.indexOf('className="desk-notice"') > conv);
  });

  it("BUT THE BLOCKER STAYS PINNED, because it must not be scrolled past", () => {
    // `liveBlocker` is the resolved answer to "why can't it trade for real".
    // It is short, and it is the one thing on this screen an owner must see.
    const src = read("./screens/Agent.tsx");
    const conv = src.indexOf('className="desk-conversation"');
    assert.ok(src.indexOf('className="desk-blocked"') < conv, "the blocker is pinned above the conversation");
  });
});

describe("the proposals panel folds instead of shouting", () => {
  it("IT OPENS FOLDED ONCE THE OWNER HAS FOLDED THAT SET", () => {
    const src = read("./Proposals.tsx");
    assert.match(src, /const sig = proposals\.map\(\(p\) => p\.token\)\.join\(","\);/);
    assert.match(src, /const openByDefault = !foldedSig \|\| foldedSig !== sig;/);
  });

  it("AND IT IS FOLDED, NEVER DISMISSED", () => {
    // The panel exists because the agent found coins it CANNOT trade until the
    // owner re-signs. A banner somebody closed is a fact nobody acts on, so the
    // summary line survives — and it carries the count that matters.
    const src = read("./Proposals.tsx");
    assert.match(src, /proposals-peek/);
    assert.match(src, /waiting on your signature/);
    assert.ok(!/aria-label="Dismiss"|setDismissed\(true\)/.test(src), "there is no way to destroy it");
  });

  it("and a new set of coins opens again", () => {
    // Folding at breakfast should not silence a genuinely new find. The key is
    // the set itself, so a different set is a different fold.
    const src = read("./Proposals.tsx");
    assert.match(src, /localStorage\.setItem\(FOLD_KEY, sig\)/);
  });
});

describe("the desktop chat floats instead of replacing the app", () => {
  it("EVERY ENTRY POINT OPENS THE DOCK, through the one function they all call", () => {
    // The sidebar's "Open chat", the portfolio panel's "Chat with X" and the
    // tab bar all call goTab("agent"). Intercepting there means one entry
    // point and no second one to keep in step.
    const app = read("./App.tsx");
    assert.match(app, /if \(desktop && next === "agent"\) \{\s*setChatDocked\(true\);/);
  });

  it("and it renders THE SAME agent screen, not a second chat", () => {
    // One conversation, one draft, one set of turns however it was opened. A
    // second implementation is a second place for the agent's words to drift
    // from what it actually did.
    const app = read("./App.tsx");
    const dock = app.slice(app.indexOf("<ChatDock"), app.indexOf("</ChatDock>"));
    for (const prop of ["turns={turns}", "draft={chatDraft}", "onDraft={setChatDraft}", "mine={mine}"]) {
      assert.ok(dock.includes(prop), `the docked chat must share ${prop}`);
    }
  });

  it("AND IT CANNOT BE DRAGGED OFF SCREEN", () => {
    // A panel dragged to the edge of a wide monitor and reopened on a laptop
    // would be one nobody can reach and nobody can close. The stored position
    // is clamped on open and on every resize.
    const src = read("./ChatDock.tsx");
    assert.match(src, /function clampToWindow/);
    assert.match(src, /window\.addEventListener\("resize"/);
    assert.match(src, /setPos\(clampToWindow\(start/);
  });

  it("and Escape closes it, like every other overlay here", () => {
    const src = read("./ChatDock.tsx");
    assert.match(src, /e\.key === "Escape"/);
  });

  it("and a browser that refuses storage still opens it somewhere reachable", () => {
    const src = read("./ChatDock.tsx");
    const mount = src.slice(src.indexOf("let start = defaultPos();"), src.indexOf("// And again whenever"));
    assert.match(mount, /catch \{/, "a throwing localStorage must not break the panel");
  });
});
