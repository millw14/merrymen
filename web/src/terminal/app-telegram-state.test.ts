import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import React, { act, useEffect } from "react";
import type { AgentStatus } from "@/app/api/grants/route";
import type { AgentDown } from "./agent-status";
import type { LiveClockDeps } from "./live-clocks";
import { liveOf, seedSources } from "./live";
import { requestJson } from "./request-json";
import { deferred, json, testDom } from "./test-dom";

const OWNER = `0x${"1".repeat(40)}` as `0x${string}`;
const OTHER = `0x${"2".repeat(40)}`;
const noop = () => {};
const originalFetch = globalThis.fetch;
let App: typeof import("./App").App;
let ui: ReturnType<typeof testDom>;
let live: ReturnType<typeof liveOf>;
let grants: Partial<AgentStatus>;
let readGrants: () => Promise<Response>;
let settings: { agentDown: AgentDown | null; slug: string | null };

before(() => {
  const appPath = fileURLToPath(new URL("./App.tsx", import.meta.url));
  const loader = Module as unknown as { _load: (id: string, parent: { filename?: string }, isMain: boolean) => unknown };
  const load = loader._load;
  const inert = new Proxy({ __esModule: true }, { get: (_target, name) => name === "__esModule" ? true : noop });
  // Run App's actual account reader and render wiring. Unrelated screens and
  // clocks are replaced at its module boundary, so no market/service I/O runs.
  const keep = new Set(["react", "@merrymen/core", "./agent-status", "./account-read", "./account-session", "./recovery-view", "./worker-stale", "./chat-store", "./chat-payload", "./chat-thread", "./nav"]);
  const intercepted = mock.method(loader, "_load", function (this: typeof loader, id: string, parent: { filename?: string }, isMain: boolean) {
    if (parent?.filename !== appPath || keep.has(id)) return load.call(this, id, parent, isMain);
    if (id === "next/navigation") return { usePathname: () => "/settings", useRouter: () => ({ push: noop }) };
    if (id === "./HostedControls") return { AccountEntry: noop, FundingPanel: noop, LimitsPanel: noop, requestJson };
    if (id === "./live") return { seedSources, liveOf: () => live };
    if (id === "./live-clocks") return { useShellClocks: (epoch: number, make: (alive: () => boolean) => LiveClockDeps) => {
      useEffect(() => { let alive = true; void make(() => alive).readAccount(); return () => { alive = false; }; }, [epoch]);
      return { shell: { banner: null, accountBusy: false }, refreshAccount: noop, invalidate: noop };
    } };
    if (id === "./chat-controller") return { useChatController: () => ({ setDraft: noop, clearThread: noop, refreshSettings: noop }) };
    if (id === "./live-news") return { useSoundPref: () => [false, noop], useLiveNews: noop };
    if (id === "@/components/WiredProvider") return { WiredProvider: ({ children }: { children: React.ReactNode }) => children };
    if (id === "./screens/Settings") return (props: typeof settings) => {
      settings = props;
      return React.createElement("output", null, props.agentDown ?? "unknown");
    };
    return inert;
  });
  try { App = createRequire(import.meta.url)(appPath).App; }
  finally { intercepted.mock.restore(); }
});

beforeEach(() => {
  ui = testDom();
  ui.dom.window.scrollTo = noop;
  ui.dom.window.matchMedia = () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) as unknown as MediaQueryList;
  live = liveOf(seedSources());
  grants = { exists: true, tenant: OWNER, workerAliveAt: null };
  readGrants = async () => json(grants);
  globalThis.fetch = async input => {
    if (String(input) === "/api/auth/session") return json({ hosted: true, address: OWNER });
    if (String(input) === "/api/grants") return readGrants();
    throw new Error(`Unexpected network boundary: ${String(input)}`);
  };
});
afterEach(async () => { await ui.close(); globalThis.fetch = originalFetch; });
const mount = async () => { await ui.render(React.createElement(App)); await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); }); };

describe("Settings receives Telegram worker status independently of the portfolio feed", () => {
  it("keeps an unread grants result unknown, then identifies a never-started worker without a feed", async () => {
    const waiting = deferred<Response>();
    readGrants = () => waiting.promise;
    await mount();
    assert.equal(settings.agentDown, null);
    await act(async () => { waiting.resolve(json(grants)); });
    assert.equal(settings.agentDown, "not-started");
    assert.equal(settings.slug, null);
  });

  it("retains recovery truth when the owner's feed answered without a portfolio", async () => {
    live = { ...live, feedTenant: OWNER, reads: { ...live.reads, mine: "ok" } };
    grants.recovery = { state: "history-only", tradingPaused: true, history: "available", memory: "unknown", checkedAt: 1_791_111_100, lastVerifiedHeartbeatAt: null };
    await mount();
    assert.equal(settings.agentDown, "recovery");
    assert.equal(settings.slug, null);
  });

  it("uses the current owner's grants when another owner's portfolio is still present", async () => {
    live = { ...live, feedTenant: OTHER, mine: {
      name: "Other agent", slug: "other-agent", owner: OTHER, handle: null, mode: "live", equity: 42, chg24: 1, moves: [], thesis: null,
      glance: { id: "custom", label: "" },
    } };
    grants.workerAliveAt = 1_700_000_000;
    grants.workerStale = true;
    await mount();
    assert.equal(settings.agentDown, "stopped");
    assert.equal(settings.slug, null, "the other owner's portfolio remains withheld");
  });
});
