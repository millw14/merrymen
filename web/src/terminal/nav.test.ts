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

describe("money is a place, not a mode", () => {
  // `moneyMode` was component state. The panel opened, the URL never changed,
  // and so Back could not dismiss it — while the tab bar hides itself on these
  // two screens. A person could reach the deposit panel and have no way out but
  // the app's own close button, on the screen where money moves.
  const MONEY = ["deposit", "withdraw"] as const;

  it("BOTH ROUND-TRIP THROUGH A URL", () => {
    for (const kind of MONEY) {
      const path = pathForScreen({ kind });
      assert.equal(path, `/${kind}`);
      assert.deepEqual(screenForPath(path), { kind }, `${kind} does not survive its own URL`);
    }
  });

  it("and both have a route file, or they 404 on refresh", () => {
    for (const kind of MONEY) {
      assert.ok(
        existsSync(join(ROOT, `web/src/app/(app)/${kind}/page.tsx`)),
        `/${kind} has no page stub`,
      );
    }
  });

  it("THE STATE IS GONE, not merely bypassed", () => {
    // Leaving `moneyMode` in place beside the route gives two sources of truth
    // for one panel, and the stale one wins whenever a link is followed.
    const app = codeOf(at("./App.tsx"));
    assert.ok(!/moneyMode|setMoneyMode/.test(app), "deposit and withdraw are routes now");
    assert.match(app, /const money =\s*requestedScreen\.kind === "deposit"/, "derived from the URL, not stored");
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

  it("A PHONE DOES NOT MOUNT THE DESKTOP SHELL", () => {
    // display:none hides a component; it does not stop it running. The header,
    // the rail and the portfolio aside were rendered on every device and hidden
    // by a media query, so a phone mounted a SECOND `AccountEntry` — polling,
    // fetching and holding its own state — behind the visible one.
    const app = codeOf(at("./App.tsx"));
    for (const c of ["DesktopHeader", "DesktopSidebar", "DesktopPortfolio"]) {
      const at_ = app.indexOf(`<${c}`);
      assert.ok(at_ > 0, `${c} is not mounted at all`);
      assert.match(
        app.slice(Math.max(0, at_ - 140), at_),
        /desktop &&|desktop \?/,
        `${c} renders on phones and is only hidden by CSS`,
      );
    }
    assert.equal(
      (app.match(/<AccountEntry/g) ?? []).length,
      2,
      "one for the phone body and one for the desktop rail — and they are on opposite sides of the gate",
    );
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
