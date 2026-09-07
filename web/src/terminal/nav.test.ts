/**
 * THE BAR IS THE PRODUCT'S TABLE OF CONTENTS, and it just changed.
 *
 * `home · feed · agent · board · you` became `Home · Chat · Feed · Alpha ·
 * Profile`: the board retired onto Home, Alpha took the freed slot, and the
 * logo moved from the chat tab to the feed tab — which is what the owner meant
 * by "the LOGO tab is the main tab", since the mark was already the middle
 * button.
 *
 * The ids did NOT change, deliberately. They are wired into TabIcon's
 * exhaustive switch, pathForScreen's record, the `data-screen` attribute CSS
 * selects on, and FirstVisit. Renaming `agent` to `chat` would be churn across
 * five files for nothing a reader can see.
 *
 * Three failures here are silent — nothing throws, nothing fails to compile,
 * and a click-through finds none of them. They are what this file is for.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { pathForScreen, screenForPath, TABS } from "./nav";


const ROOT = join(import.meta.dirname, "..", "..", "..");
const at = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

/**
 * The file with its COMMENTS REMOVED.
 *
 * This repo documents what it deliberately does NOT do — next.config.mjs spends
 * twenty lines explaining why there are no rewrites, and Home.tsx explains the
 * ranking it stopped doing. Scanning raw text would make that documentation the
 * violation, which is the trap privy-boundary.test.ts already names.
 */
const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

describe("the five tabs", () => {
  it("is exactly five, in the order the owner asked for", () => {
    // The bar is `grid-template-columns: repeat(5, 1fr)` in CSS. Six tabs would
    // silently overflow one cell rather than fail.
    assert.equal(TABS.length, 5);
    assert.deepEqual(
      TABS.map((t) => t.label),
      ["Home", "Chat", "Feed", "Alpha", "Profile"],
    );
  });

  it("THE LOGO IS THE CENTRE BUTTON", () => {
    assert.equal(TABS[2]!.id, "feed", "the middle slot is the feed");
    const ui = at("./ui.tsx");
    const feedArm = ui.slice(ui.indexOf('case "feed":'), ui.indexOf('case "agent":'));
    assert.match(feedArm, /<LogoMark/, "the mark belongs to the centre tab");
  });

  it("and the desktop BRAND does not borrow it from the bar", () => {
    // The silent one. The wordmark rendered `<TabIcon id="agent"/>`, which
    // happened to be the logo — so moving the logo to feed would have turned
    // the desktop brand into a speech bubble, compiling cleanly.
    const desktop = at("./Desktop.tsx");
    const header = desktop.slice(desktop.indexOf("desktop-brand"), desktop.indexOf("desktop-brand") + 900);
    assert.match(header, /<LogoMark/);
    assert.ok(!/TabIcon id="agent"/.test(desktop), "a brand is not a tab");
  });
});

describe("routing", () => {
  it("every tab round-trips through its path", () => {
    for (const t of TABS) {
      const path = pathForScreen({ kind: "tab", tab: t.id });
      const back = screenForPath(path);
      assert.equal(back.kind, "tab");
      assert.equal(back.kind === "tab" && back.tab, t.id, `${t.label} does not survive its own URL`);
    }
  });

  it("INVARIANT: every tab path has a route file", () => {
    // The failure a click-through never finds: without a page stub the tab
    // works when tapped and 404s on refresh, and on every link anyone shares.
    const missing: string[] = [];
    for (const t of TABS) {
      const path = pathForScreen({ kind: "tab", tab: t.id });
      const file = path === "/" ? "web/src/app/(app)/page.tsx" : `web/src/app/(app)${path}/page.tsx`;
      if (!existsSync(join(ROOT, file))) missing.push(`${t.label} → ${file}`);
    }
    assert.deepEqual(missing, [], `these tabs 404 on refresh: ${missing.join(", ")}`);
  });

  it("REGRESSION: /leaderboard still resolves after the board tab retired", () => {
    // A URL testers have open and have shared. It renders Home, which now
    // carries the board.
    const s = screenForPath("/leaderboard");
    assert.equal(s.kind === "tab" && s.tab, "home");
  });

  it("and the address bar is normalised by a redirect, not by a page", () => {
    // `(app)/layout.tsx` mounts the terminal and never renders `children`, so a
    // `redirect()` written inside the page may never run — it would look right
    // in review and do nothing.
    const cfg = readFileSync(join(ROOT, "web/next.config.mjs"), "utf8");
    assert.match(cfg, /source: "\/leaderboard"/);
    assert.ok(!/rewrites\(/.test(codeOf(cfg)), "a rewrite is same-origin and leaks the session cookie");
  });

  it("an unknown path lands on Home rather than nowhere", () => {
    assert.deepEqual(screenForPath("/nonsense"), { kind: "tab", tab: "home" });
  });
});

describe("what the nav rewrite could have broken quietly", () => {
  it("THE CHAT PROMPT NAMES SCREENS THAT EXIST", () => {
    // The prompt hard-codes the menu, and its own comment records the tester
    // who "spent minutes looking" for a screen that was never there. A rewrite
    // that skips this line sends people to a bar that changed underneath them.
    const prompt = at("../app/api/chat/route.ts");
    const line = prompt.slice(prompt.indexOf("NAME SCREENS THE WAY THE MENU DOES"));
    const named = line.slice(0, line.indexOf("\n"));
    for (const label of TABS.map((t) => t.label)) {
      assert.ok(named.includes(label), `the prompt never mentions the ${label} tab`);
    }
    assert.ok(!named.includes("Portfolio"), "Portfolio was renamed to Profile");
  });

  it("the desktop no longer rewrites /feed to Home", () => {
    // It did, above 1100px — survivable while the feed was a side panel, and
    // actively wrong once the feed is the centre tab.
    const app = codeOf(at("./App.tsx"));
    assert.ok(!/\?\s*HOME_SCREEN/.test(app), "the URL and the body must agree");
  });

  it("the active tab comes from the URL, not from click history", () => {
    // `tab` is only written by goTab, so a cold load of /alpha highlighted Home
    // until something was clicked.
    assert.match(at("./App.tsx"), /const activeTab = screen\.kind === "tab" \? screen\.tab : requestedScreen\.kind === "tab"/);
  });

  it("HOME CARRIES THE BOARD, so retiring the tab lost nothing", () => {
    const home = codeOf(at("./screens/Home.tsx"));
    assert.match(home, /<Board\b/, "the leaderboard must still be reachable");
    // Mounted, not reimplemented: Board carries the unreadable-vs-quiet
    // disclosure that honesty.test.ts pins by reading Board.tsx, so a local
    // copy would pass that test and lose the property.
    assert.ok(!/pnlBps/.test(home), "Home must not rank agents itself");
    assert.ok(!/weekWins/.test(home), "the duplicate wins strip is gone");
  });
});
