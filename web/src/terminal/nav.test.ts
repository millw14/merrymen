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

import { closeTarget, pathForScreen, screenForPath, TABS } from "./nav";
import type { Screen } from "./live";


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

describe("the four tabs", () => {
  it("is exactly four, in the order the owner asked for", () => {
    // The bar is `grid-template-columns: repeat(4, 1fr)` in CSS. A fifth tab
    // would silently overflow one cell rather than fail. Feed, the board, the
    // markets and research (alpha) all live under Explore now.
    assert.equal(TABS.length, 4);
    assert.deepEqual(
      TABS.map((t) => t.label),
      ["Home", "Chat", "Explore", "Me"],
    );
    assert.match(at("./terminal.css"), /\.tabbar \{[^}]*grid-template-columns: repeat\(4, 1fr\)/, "the bar's grid matches its tabs");
  });

  it("THE LOGO IS THE CENTRE BUTTON", () => {
    assert.equal(TABS[2]!.id, "feed", "the middle slot is the feed");
    const ui = at("./ui.tsx");
    const feedArm = ui.slice(ui.indexOf('case "feed":'), ui.indexOf('case "agent":'));
    assert.match(feedArm, /<LogoMark/, "the mark belongs to the centre tab");
  });

  it("shows every tab name instead of asking readers to decode icons", () => {
    const app = at("./App.tsx");
    const bar = app.slice(app.indexOf('<nav className="tabbar"'), app.indexOf("</nav>", app.indexOf('<nav className="tabbar"')));
    assert.match(bar, /className="tab-label"/);
    assert.match(bar, /\{t\.label\}/);
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
  it("Solana round-trips to its dedicated route without adding a sixth tab", () => {
    assert.deepEqual(screenForPath("/solana", true), { kind: "solana" });
    assert.equal(pathForScreen({ kind: "solana" }), "/solana");
    assert.ok(existsSync(join(ROOT, "web/src/app/(app)/solana/page.tsx")));
    assert.equal(TABS.length, 4);
  });
  it("without Solana on this deployment, /solana is Home like any unknown path", () => {
    assert.deepEqual(screenForPath("/solana"), { kind: "tab", tab: "home" });
    assert.deepEqual(screenForPath("/solana", false), { kind: "tab", tab: "home" });
  });
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

  it("REGRESSION: /leaderboard and /tokens still open what they named", () => {
    // URLs testers have open and have shared. The board and the market table
    // live under Explore now, each at its own address.
    assert.deepEqual(screenForPath("/leaderboard"), { kind: "leaders" });
    assert.deepEqual(screenForPath("/tokens"), { kind: "markets" });
  });

  it("Explore's views round-trip and have route files", () => {
    for (const kind of ["leaders", "markets", "wardrobe"] as const) {
      assert.deepEqual(screenForPath(pathForScreen({ kind })), { kind });
      assert.ok(existsSync(join(ROOT, `web/src/app/(app)/${kind}/page.tsx`)), `/${kind} has no page stub`);
    }
    assert.deepEqual(screenForPath("/"), { kind: "tab", tab: "home" }, "the front door is Home");
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
    assert.match(app, /const money =\s*!isolatedWallet && \(requestedScreen\.kind === "deposit"/, "derived from the Spot URL, not stored; Perps recovery has its own screen");
  });
});

describe("closing Add money goes back to the page it was opened over", () => {
  // Reported on PR #377: on desktop, Markets → a token → Add money → close
  // landed on Markets, while the token chart had been on screen under the
  // panel the whole time. Back skips detail screens on purpose; closing a
  // money panel must not.
  const markets: Screen = { kind: "markets" };
  const token: Screen = { kind: "token", id: "0xabc" };
  const profile: Screen = { kind: "profile", slug: "alan" };
  const home: Screen = { kind: "tab", tab: "home" };
  const chat: Screen = { kind: "tab", tab: "agent" };

  it("OVER A TOKEN CHART OR A PROFILE, CLOSE IS THAT PAGE — desktop and phone", () => {
    for (const desktop of [true, false]) {
      assert.deepEqual(closeTarget({ money: true, under: token, lastBrowse: markets, desktop }), token);
      assert.deepEqual(closeTarget({ money: true, under: profile, lastBrowse: home, desktop }), profile);
      assert.deepEqual(closeTarget({ money: true, under: home, lastBrowse: home, desktop }), home);
    }
  });

  it("Back from a detail screen still goes to the last place browsed", () => {
    assert.deepEqual(closeTarget({ money: false, under: token, lastBrowse: markets, desktop: true }), markets);
    assert.deepEqual(closeTarget({ money: false, under: null, lastBrowse: home, desktop: false }), home);
  });

  it("a cold load of /deposit has nothing under it: the browse history, then the tab", () => {
    assert.deepEqual(closeTarget({ money: true, under: null, lastBrowse: markets, desktop: true }), markets);
    assert.equal(closeTarget({ money: true, under: null, lastBrowse: null, desktop: true }), null);
  });

  it("never a money screen, and never Chat on desktop, where Chat is a dock", () => {
    assert.equal(closeTarget({ money: true, under: { kind: "withdraw" }, lastBrowse: null, desktop: false }), null);
    assert.equal(closeTarget({ money: true, under: chat, lastBrowse: null, desktop: true }), null);
    assert.deepEqual(closeTarget({ money: true, under: chat, lastBrowse: markets, desktop: true }), markets);
    assert.deepEqual(closeTarget({ money: true, under: chat, lastBrowse: null, desktop: false }), chat, "the phone has a Chat screen");
    assert.equal(closeTarget({ money: false, under: null, lastBrowse: chat, desktop: true }), null);
  });

  it("App closes BOTH funding panels this way, and nothing else does", () => {
    const app = codeOf(at("./App.tsx"));
    const panels = app.match(/<FundingPanel\b[^>]*>/g) ?? [];
    assert.equal(panels.length, 2, "the phone panel and the desktop side panel");
    for (const panel of panels) assert.match(panel, /onClose=\{closeMoney\}/);
    assert.match(app, /const closeMoney = \(\) => goBackTo\(closeTarget\(\{ money: true, under: underMoney\.current/);
  });
});

describe("the group chat is a place, not a tab", () => {
  // The room every agent is in. `/chat` already means the owner talking to
  // their own agent, and the bar is five wide by CSS — so the room is a screen
  // reached from Home's header and the desktop header, never a sixth button.
  it("/groupchat ROUND-TRIPS THROUGH ITS URL", () => {
    assert.equal(pathForScreen({ kind: "groupchat" }), "/groupchat");
    assert.deepEqual(screenForPath("/groupchat"), { kind: "groupchat" });
    assert.deepEqual(screenForPath("/chat"), { kind: "tab", tab: "agent" }, "the owner's own chat is untouched");
  });

  it("and has a route file, or it 404s on refresh and on every shared link", () => {
    assert.ok(existsSync(join(ROOT, "web/src/app/(app)/groupchat/page.tsx")), "/groupchat has no page stub");
  });

  it("and did not become a fifth tab", () => {
    assert.equal(TABS.length, 4);
    assert.ok(!TABS.some((t) => (t.id as string) === "groupchat"));
  });

  it("both entry points lead there", () => {
    // THE PHONE'S WAY IN IS A CALLBACK, like every other way off Home. A
    // next/link there crashed a node test that renders Home (market-flip): with
    // no IntersectionObserver a Link falls back to requestIdleCallback on
    // `self`, which only a browser has.
    assert.match(codeOf(at("./screens/Home.tsx")), /onClick=\{onGroupChat\}/, "the phone's way in");
    assert.doesNotMatch(codeOf(at("./screens/Home.tsx")), /from "next\/link"/, "Home stays link-free");
    assert.match(codeOf(at("./App.tsx")), /onGroupChat=\{\(\) => openScreen\(\{ kind: "groupchat" \}\)\}/, "and App wires it");
    assert.match(codeOf(at("./Desktop.tsx")), /href="\/groupchat"/, "the desktop's way in");
    assert.match(codeOf(at("./App.tsx")), /screen\.kind === "groupchat" && <GroupChat /);
  });
});

describe("what the nav rewrite could have broken quietly", () => {
  it("THE CHAT PROMPT NAMES SCREENS THAT EXIST", () => {
    // The prompt hard-codes the menu, and its own comment records the tester
    // who "spent minutes looking" for a screen that was never there. A rewrite
    // that skips this line sends people to a bar that changed underneath them.
    const prompt = at("../lib/agent-chat.ts");
    const line = prompt.slice(prompt.indexOf("NAME SCREENS THE WAY THE MENU DOES"));
    const named = line.slice(0, line.indexOf("\n"));
    for (const label of TABS.map((t) => t.label)) {
      assert.ok(named.includes(label), `the prompt never mentions the ${label} tab`);
    }
    assert.ok(!named.includes("Portfolio"), "Portfolio was renamed, and is now Me");
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

describe("what the room came for is at the top", () => {
  // The market table moved from Home to Explore → Markets, ranking and all.
  const home = codeOf(at("./screens/Markets.tsx"));

  it("COINS RANK ABOVE STOCKS, in every list this screen sorts", () => {
    // An admin's words: "can we show memecoins first instead of stocks? nobody
    // here is trading stocks." Deliberately not done at the time — the memecoin
    // path did not exist, so a coin at the top advertised something the product
    // could not do. It exists now: the wall can cover a curve coin, the default
    // strategy trades one when the equity feeds are shut, and the agent
    // proposes vetted ones with a one-tap path to signing them.
    assert.match(home, /const coinFirst = /);
    // All three: most-bought, most-held, and the fallback — which is the one
    // actually on screen while nothing has traded.
    assert.equal(
      (home.match(/coinFirst\(a, b\) \|\|/g) ?? []).length,
      3,
      "every ranked list on Markets must put coins first",
    );
  });

  it("and it is a SORT KEY, not a filter", () => {
    // Stocks stay listed and stay ranked among themselves. An owner whose
    // basket is equities loses nothing; this decides the top of the table, not
    // its contents.
    assert.ok(
      !/kind !== "memecoin"|filter\(\(t\) => t\.kind === "memecoin"\)/.test(home),
      "stocks must not be filtered out of the market table",
    );
  });
});
