/**
 * THE SHELL HANDS EVERY SCREEN THE SAME OWNER STATE — run through App itself.
 *
 * App's real account reader, owner state, owner-only reads and render wiring
 * run here; the screens are replaced at App's module boundary by captures of
 * the props they were given, and the network by the answers below. Modelled
 * on app-telegram-state.test.ts.
 */
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import React, { act, useEffect } from "react";
import type { LiveClockDeps } from "./live-clocks";
import { liveOf, seedSources } from "./live";
import { requestJson } from "./request-json";
import { json, testDom } from "./test-dom";

const ME = `0x${"1".repeat(40)}`;
const OTHER = `0x${"2".repeat(40)}`;
const noop = () => {};
const originalFetch = globalThis.fetch;
let App: typeof import("./App").App;
let ui: ReturnType<typeof testDom>;
let live: ReturnType<typeof liveOf>;
let pathname = "/home";
let session: { hosted: boolean; address: string | null };
let grants: Record<string, unknown>;
let perpsGrants: Record<string, unknown> | "down";
let ownAnswer: () => Response;
let requests: string[];
let readAccount: () => Promise<void>;
const seen: Record<"home" | "you" | "entry" | "profile", Record<string, unknown> | null> = { home: null, you: null, entry: null, profile: null };

before(() => {
  const appPath = fileURLToPath(new URL("./App.tsx", import.meta.url));
  const loader = Module as unknown as { _load: (id: string, parent: { filename?: string }, isMain: boolean) => unknown };
  const load = loader._load;
  const inert = new Proxy({ __esModule: true }, { get: (_target, name) => name === "__esModule" ? true : noop });
  // The props a screen was last drawn with, and null once it is no longer drawn.
  const capture = (key: keyof typeof seen) => function Captured(props: Record<string, unknown>) {
    seen[key] = props;
    useEffect(() => () => { if (seen[key] === props) seen[key] = null; });
    return null;
  };
  const keep = new Set(["react", "@merrymen/core", "./agent-status", "./account-read", "./account-session", "./recovery-view", "./worker-stale", "./chat-store", "./chat-payload", "./chat-thread", "./nav", "./perps-navigation", "./use-trading-mode-transition", "./owner-state", "./owner-reads", "./navigate", "./ticker"]);
  const intercepted = mock.method(loader, "_load", function (this: typeof loader, id: string, parent: { filename?: string }, isMain: boolean) {
    if (parent?.filename !== appPath || keep.has(id)) return load.call(this, id, parent, isMain);
    if (id === "next/navigation") return { usePathname: () => pathname, useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: noop }) };
    if (id === "next/dynamic") return { __esModule: true, default: () => noop };
    if (id === "./HostedControls") return { AccountEntry: capture("entry"), FundingPanel: noop, LimitsPanel: noop, SignIn: noop, requestJson };
    if (id === "./live") return { seedSources, liveOf: () => live };
    if (id === "./live-clocks") return { useShellClocks: (epoch: number, make: (alive: () => boolean) => LiveClockDeps) => {
      useEffect(() => {
        let alive = true;
        const deps = make(() => alive);
        readAccount = () => deps.readAccount();
        void deps.readAccount();
        return () => { alive = false; };
      }, [epoch]);
      return { shell: { banner: null, accountBusy: false }, refreshAccount: noop, invalidate: noop, tokenMissing: () => ({ loading: true }) };
    } };
    if (id === "./chat-controller") return { useChatController: () => ({ setDraft: noop, clearThread: noop, refreshSettings: noop }) };
    if (id === "./live-news") return { useSoundPref: () => [false, noop], useLiveNews: noop };
    if (id === "@/components/WiredProvider") return { WiredProvider: ({ children }: { children: React.ReactNode }) => children };
    if (id === "./screens/Home") return { Home: capture("home") };
    if (id === "./screens/You") return { You: capture("you") };
    if (id === "./screens/Profile") return { Profile: capture("profile") };
    return inert;
  });
  try { App = createRequire(import.meta.url)(appPath).App; }
  finally { intercepted.mock.restore(); }
});

const feedMine = (slug: string | null) => ({
  name: "hako merry", slug, handle: null, owner: "you", mode: null, equity: null, chg24: null, moves: [], thesis: null, history: [],
  glance: { id: "custom" as const, label: "" },
});
const ownBook = {
  recentTrades: [], activityRead: true, topTrades: [], topTradesRead: true, figuresRead: true,
  figures: { book: "paper", equityUsdg: 1000, equityAt: 1_795_550_640, held: false, pnlUsdg: 0, pnlAt: 1_795_550_640, underReview: false, pnlEstimated: false },
};

beforeEach(() => {
  ui = testDom();
  ui.dom.window.scrollTo = noop;
  ui.dom.window.matchMedia = () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) as unknown as MediaQueryList;
  for (const key of Object.keys(seen) as (keyof typeof seen)[]) seen[key] = null;
  requests = [];
  pathname = "/home";
  session = { hosted: true, address: ME };
  // hako merry: stopped, and Start over then removed the record.
  grants = { exists: false, tenant: ME };
  perpsGrants = { exists: false, tenant: ME };
  ownAnswer = () => json(ownBook);
  const base = liveOf(seedSources());
  live = { ...base, feedTenant: ME, reads: { ...base.reads, mine: "ok" }, mine: feedMine("hako-merry"),
    agents: [{ slug: "hako-merry", name: "hako merry", handle: null, owner: null, pnlBps: null, curve: [], landed: 0, last: null, glance: { id: "custom", label: "" }, thesis: "", mode: "paper" } as never] };
  globalThis.fetch = async input => {
    const url = String(input);
    requests.push(url);
    if (url === "/api/auth/session") return json(session);
    if (url === "/api/grants") return json(grants);
    if (url === "/api/grants?wallet=perps") return perpsGrants === "down" ? json({ error: "down" }, 503) : json(perpsGrants);
    if (url === "/api/agents/hako-merry/own") return ownAnswer();
    if (url.startsWith("/api/agents/")) return json({ error: "Agent not found" }, 404);
    throw new Error(`Unexpected network boundary: ${url}`);
  };
});
afterEach(async () => { await ui.close(); globalThis.fetch = originalFetch; });
const settle = async () => { await act(async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); }); };
const mount = async (props: { perps?: boolean } = {}) => { await ui.render(React.createElement(App, props)); await settle(); };
const stoppedOn = (key: keyof typeof seen) => seen[key]?.stoppedAgent as { name: string; slug: string; restart: { href: string } } | null | undefined;
const asked = (path: string) => requests.filter((url) => url === path).length;

describe("a stopped owner, through the shell", () => {
  it("Home and the account card get the stopped agent, with his value from the owner-only read", async () => {
    await mount();
    assert.deepEqual({ name: stoppedOn("home")?.name, slug: stoppedOn("home")?.slug, href: stoppedOn("home")?.restart.href },
      { name: "hako merry", slug: "hako-merry", href: "/create" });
    assert.equal(seen.home?.checking, false);
    assert.equal(seen.home?.mine, null, "still no desk: there is no live grant");
    assert.ok(asked("/api/agents/hako-merry/own") >= 1, "the figure comes from /own");
    assert.equal((seen.home?.stoppedBook as { figures?: { equityUsdg?: number } } | undefined)?.figures?.equityUsdg, 1000);

    pathname = "/feed";
    await ui.render(React.createElement(App));
    await settle();
    assert.equal(stoppedOn("entry")?.slug, "hako-merry", "the card beside every other page says it too");
  });

  it("a record held for a renewal points at the re-signature", async () => {
    grants = { exists: false, tenant: ME, stored: true };
    await mount();
    assert.equal(stoppedOn("home")?.restart.href, "/grant#resign");
  });

  it("Me gets the stopped card, and the phone's account card above it steps aside", async () => {
    pathname = "/you";
    await mount();
    assert.equal(stoppedOn("you")?.slug, "hako-merry");
    assert.equal(seen.entry, null, "one stopped card on Me, not two");
    // Compared as text: a DOM node in a failed assertion's message is inspected, and that hangs.
    assert.equal(ui.container.querySelector('a[href="/create"]')?.textContent ?? null, null, "no \"Create agent\" beside the sign-out for an agent that exists");
  });

  it("a newcomer on Me keeps the phone's account card and the way to create", async () => {
    pathname = "/you";
    live = { ...live, mine: feedMine(null) };
    await mount();
    assert.equal(stoppedOn("you"), null);
    assert.ok(seen.entry, "the newcomer's account card");
    assert.equal(ui.container.querySelector('a[href="/create"]')?.textContent, "Create agent");
  });

  it("a refused or unread owner read gives no figure: null, never a guessed one", async () => {
    ownAnswer = () => json({ error: "Agent not found" }, 404);
    await mount();
    assert.equal(stoppedOn("home")?.slug, "hako-merry");
    assert.equal(seen.home?.stoppedBook, null);
  });

  it("on desktop, the Chat tab goes to his way back, not to a second agent", async () => {
    ui.dom.window.matchMedia = () => ({ matches: true, addEventListener: noop, removeEventListener: noop }) as unknown as MediaQueryList;
    for (const [status, path] of [[{ exists: false, tenant: ME, stored: true }, "/grant#resign"], [{ exists: false, tenant: ME }, "/create"]] as const) {
      grants = status;
      ui.dom.window.history.replaceState(null, "", "/home");
      await ui.remount(React.createElement(App));
      await settle();
      const chat = ui.container.querySelector<HTMLButtonElement>('.tabbar button[data-tour="tab-agent"]');
      assert.ok(chat, "the Chat tab");
      await act(async () => { chat.click(); });
      const at = ui.dom.window.location;
      assert.equal(`${at.pathname}${at.hash}`, path);
    }
  });

  it("re-signing flips the screens back to live, with no stopped card left behind", async () => {
    await mount();
    assert.equal(stoppedOn("home")?.slug, "hako-merry");
    grants = { exists: true, tenant: ME, workerAliveAt: null };
    await act(async () => { await readAccount(); });
    await settle();
    assert.equal(stoppedOn("home"), null);
    assert.equal((seen.home?.mine as { slug?: string } | null)?.slug, "hako-merry", "the live desk is drawn again");
  });
});

describe("who is not told their agent is stopped", () => {
  it("a Perps-only owner: the Perps wallet is asked, and holds a grant", async () => {
    perpsGrants = { exists: true, tenant: ME, grant: { smartAccount: `0x${"3".repeat(40)}`, chainId: 4663, purpose: "perps", caps: { perTradeUsdg: 1, dailyUsdg: 1 } } };
    await mount({ perps: true });
    assert.equal(asked("/api/grants?wallet=perps"), 1);
    assert.equal(stoppedOn("home"), null);
    assert.equal(seen.home?.checking, false);
    assert.equal(asked("/api/agents/hako-merry/own"), 0, "no stopped card, so no owner read for one");
  });

  it("with Perps offered and no Perps wallet, he is stopped; with the Perps read down, nothing is claimed", async () => {
    await mount({ perps: true });
    assert.equal(stoppedOn("home")?.slug, "hako-merry");
    await ui.remount(React.createElement("div"));
    perpsGrants = "down";
    await ui.render(React.createElement(App, { perps: true }));
    await settle();
    assert.equal(stoppedOn("home"), null);
    assert.equal(seen.home?.checking, false);
  });

  it("a feed answered for another session: no stopped card, no owner or Perps read", async () => {
    live = { ...live, feedTenant: OTHER };
    await mount({ perps: true });
    assert.equal(stoppedOn("home"), null);
    assert.equal(asked("/api/agents/hako-merry/own"), 0);
    assert.equal(asked("/api/grants?wallet=perps"), 0);
  });

  it("a brand-new account, whose feed names no slug", async () => {
    live = { ...live, mine: feedMine(null) };
    await mount({ perps: true });
    assert.equal(stoppedOn("home"), null);
    assert.equal(seen.home?.checking, false);
    assert.equal(asked("/api/grants?wallet=perps"), 0);
  });

  it("before the feed's first answer: checking, neither stopped nor new", async () => {
    live = { ...live, feedTenant: undefined, mine: null, reads: { ...live.reads, mine: "unread" } };
    await mount();
    assert.equal(stoppedOn("home"), null);
    assert.equal(seen.home?.checking, true);
  });

  it("signed out", async () => {
    session = { hosted: true, address: null };
    grants = { exists: false, tenant: null };
    live = { ...live, feedTenant: null };
    await mount({ perps: true });
    assert.equal(stoppedOn("home"), null);
    assert.equal(requests.filter((url) => url !== "/api/auth/session" && url !== "/api/grants").length, 0);
  });

  it("self-hosted", async () => {
    session = { hosted: false, address: null };
    grants = { exists: false };
    live = { ...live, feedTenant: undefined };
    await mount({ perps: true });
    assert.equal(stoppedOn("home"), null);
    assert.equal(seen.home?.checking, false);
  });
});

describe("the profile's owner, through the shell", () => {
  // What an owner's page then does — the book switch, no wire button, and the
  // /own read that replaces "Private" — is profile-render.test.ts's.
  it("a stopped owner's own page is drawn as his", async () => {
    pathname = "/a/hako-merry";
    await mount();
    assert.equal(seen.profile?.isMine, true);
  });

  it("a stranger's page stays a stranger's", async () => {
    live = { ...live, agents: [...live.agents, { ...live.agents[0]!, slug: "someone-else", name: "Someone" }] };
    pathname = "/a/someone-else";
    await mount();
    assert.equal(seen.profile?.isMine, false);
  });

  it("a feed for another session makes the owner a stranger on every page", async () => {
    live = { ...live, feedTenant: OTHER };
    pathname = "/a/hako-merry";
    await mount();
    assert.equal(seen.profile?.isMine, false);
  });
});
