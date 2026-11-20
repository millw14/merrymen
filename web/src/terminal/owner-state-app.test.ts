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
