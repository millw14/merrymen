import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import * as api from "./solana-api";
import * as auth from "./solana-auth";
import * as bindings from "./solana-binding-store";
import { solanaEnabled } from "./solana-enabled";

/**
 * SOLANA IS OFF UNTIL A DEPLOYMENT SAYS OTHERWISE.
 *
 * Every route under app/api/solana, found on disk so a new one cannot be
 * missed, is called with the switch off and must refuse before it signs anyone
 * in, reads a body, opens the binding store or starts the runtime. With the
 * switch on, the same call reaches the route's own work.
 */

const WEB = fileURLToPath(new URL("../", import.meta.url));
const API = join(WEB, "app/api/solana");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
/** Every route.ts under app/api/solana, nested ones included, by its path below it ("paper", "paper/write-off"). */
function solanaRoutes(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
    const route = prefix ? `${prefix}/${entry.name}` : entry.name;
    return [...(existsSync(join(dir, route, "route.ts")) ? [route] : []), ...solanaRoutes(dir, route)];
  });
}

const flag = process.env.MERRYMEN_SOLANA;
const set = (value: string | undefined) => { if (value === undefined) delete process.env.MERRYMEN_SOLANA; else process.env.MERRYMEN_SOLANA = value; };

let touched: string[] = [];
const touch = (name: string) => async () => { touched.push(name); throw new auth.SolanaWebError(401, "Sign in first."); };
const handlers: Array<{ route: string; method: string; handle: (req: Request) => Promise<Response> }> = [];
let page: () => unknown;

before(() => {
  const loader = Module as unknown as { _load: (id: string, parent: { filename?: string }, isMain: boolean) => unknown };
  const original = loader._load;
  const interception = mock.method(loader, "_load", function (this: typeof loader, id: string, parent: { filename?: string }, isMain: boolean) {
    if (parent?.filename?.startsWith(join(WEB, "app"))) {
      if (id === "@/lib/solana-auth") return { ...auth, authenticateSolana: touch("authenticateSolana") };
      if (id === "@/lib/solana-binding-store") return { ...bindings, getSolanaBindingStore: touch("getSolanaBindingStore") };
      if (id === "@/lib/solana-api") return { ...api, solanaContext: touch("solanaContext"), solanaRequestBody: touch("solanaRequestBody") };
      if (id === "@/lib/solana-enabled") return { solanaEnabled };
      if (id.endsWith("worker/src/solana-app-runtime")) return { getSolanaAppRuntime: touch("getSolanaAppRuntime") };
    }
    return original.call(this, id, parent, isMain);
  });
  try {
    const load = createRequire(import.meta.url);
    for (const route of solanaRoutes(API)) {
      const mod = load(join(API, route, "route.ts")) as Record<string, unknown>;
      for (const method of METHODS) if (typeof mod[method] === "function") handlers.push({ route, method, handle: mod[method] as (req: Request) => Promise<Response> });
    }
    page = (load(join(WEB, "app/(app)/solana/page.tsx")) as { default: () => unknown }).default;
  } finally {
    interception.mock.restore();
  }
});
beforeEach(() => { touched = []; });
after(() => set(flag));

const call = (h: (typeof handlers)[number]) =>
  h.handle(new Request(`https://app.example.test/api/solana/${h.route}?owner=x`, h.method === "GET" ? {} : { method: h.method, body: "{}" }));

describe("the Solana switch", () => {
  it("is on only for MERRYMEN_SOLANA=1", () => {
    for (const value of [undefined, "", "0", "false", "true", "yes", "on", "2"]) {
      set(value);
      assert.equal(solanaEnabled(), false, String(value));
    }
    for (const value of ["1", " 1 "]) {
      set(value);
      assert.equal(solanaEnabled(), true, value);
    }
  });

  it("finds every route, including the ones that sign in directly", () => {
    const routes = new Set(handlers.map((h) => h.route));
    for (const route of ["bind", "intent", "owner", "paper", "paper/write-off", "settings", "setup", "status", "strategy"]) assert.ok(routes.has(route), route);
    assert.ok(handlers.some((h) => h.route === "bind" && h.method === "GET"));
  });

  it("off: every route answers 404 and touches nothing", async () => {
    set(undefined);
    for (const h of handlers) {
      const response = await call(h);
      assert.equal(response.status, 404, `${h.method} ${h.route}`);
      assert.deepEqual(await response.json(), { error: "Solana trading is not available.", ownerFacing: true });
    }
    assert.deepEqual(touched, []);
  });

  it("on: every route goes on to its own work", async () => {
    set("1");
    for (const h of handlers) {
      touched = [];
      assert.equal((await call(h)).status, 401, `${h.method} ${h.route}`);
      assert.ok(touched.length > 0, `${h.method} ${h.route} did no work`);
    }
  });

  it("off: the /solana page is not found; on: it renders the terminal", () => {
    set(undefined);
    assert.throws(() => page(), (error: unknown) => String((error as { digest?: unknown }).digest).includes("404"));
    set("1");
    assert.equal(page(), null);
  });

  it("the terminal shows the network switch only when the server says so", () => {
    const layout = readFileSync(join(WEB, "app/(app)/layout.tsx"), "utf8");
    assert.match(layout, /<App solana=\{solanaEnabled\(\)\} \/>/);
    const app = readFileSync(join(WEB, "terminal/App.tsx"), "utf8");
    assert.match(app, /export function App\(\{ solana = false \}/);
    assert.match(app, /screenForPath\(pathname, solana\)/);
    assert.match(app, /\{solana && <nav aria-label="Trading networks"/);
    assert.equal(app.match(/aria-label="Trading networks"/g)?.length, 1, "no second, ungated switch");
  });
});

/**
 * PRIVY FOLLOWS THE SAME SWITCH.
 *
 * Off: the provider is configured as it was before Solana (Ethereum wallets,
 * no Solana RPC). On: Privy's own hosted Solana RPC plugin is registered, so
 * its embedded-wallet signing screen can render. Without an RPC, react-auth's
 * accessor throws "No RPC configuration found for chain solana:mainnet" while
 * that screen renders and the owner can never approve a permission, a revoke
 * or a withdrawal. No app-supplied RPC URL is configured, so the server's
 * keyed endpoint cannot reach the browser.
 */
describe("Privy's Solana configuration", () => {
  type Config = { appearance?: { walletChainType?: string }; plugins?: Array<{ id: symbol; getDefaultRpcs?: (input: { appId: string }) => Record<string, unknown> }>; solana?: unknown };
  let Providers: (props: { locale: "en"; solana?: boolean; children?: unknown }) => unknown;
  let renderToStaticMarkup: (node: unknown) => string;
  let createElement: (type: unknown, props: unknown) => unknown;
  let defaultSolanaRpcsPlugin: () => { id: symbol };
  const configs: Config[] = [];
  const reactGlobal = globalThis as { React?: unknown };
  let previousReact: unknown;
  after(() => { reactGlobal.React = previousReact; });
  before(() => {
    const file = join(WEB, "terminal/Providers.tsx");
    const loader = Module as unknown as { _load: (id: string, parent: { filename?: string }, isMain: boolean) => unknown };
    const original = loader._load;
    const interception = mock.method(loader, "_load", function (this: typeof loader, id: string, parent: { filename?: string }, isMain: boolean) {
      if (parent?.filename === file) {
        if (id === "@privy-io/react-auth") return { PrivyProvider: ({ config, children }: { config: Config; children: unknown }) => { configs.push(config); return children; } };
        if (id === "@/lib/privy-client") return { PRIVY_APP_ID: "fixture-app-id", privyEnabled: () => true };
        if (id === "./OwnerClock") return { OwnerClock: () => null };
      }
      return original.call(this, id, parent, isMain);
    });
    try {
      const load = createRequire(import.meta.url);
      Providers = (load(file) as { Providers: typeof Providers }).Providers;
      renderToStaticMarkup = (load("react-dom/server") as { renderToStaticMarkup: typeof renderToStaticMarkup }).renderToStaticMarkup;
      const react = load("react") as { createElement: typeof createElement };
      createElement = react.createElement;
      // tsx compiles JSX to React.createElement, as test-dom.ts provides for screens.
      previousReact = reactGlobal.React;
      reactGlobal.React = react;
      defaultSolanaRpcsPlugin = (load("@privy-io/react-auth/solana") as { defaultSolanaRpcsPlugin: typeof defaultSolanaRpcsPlugin }).defaultSolanaRpcsPlugin;
    } finally {
      interception.mock.restore();
    }
  });
  const configFor = (solana: boolean | undefined) => {
    configs.length = 0;
    renderToStaticMarkup(createElement(Providers, solana === undefined ? { locale: "en" } : { locale: "en", solana }));
    assert.equal(configs.length, 1);
    return configs[0]!;
  };

  it("off (and by default): Ethereum wallets only and no Solana RPC", () => {
    for (const solana of [false, undefined]) {
      const config = configFor(solana);
      assert.equal(config.appearance?.walletChainType, "ethereum-only");
      assert.equal(config.plugins, undefined);
      assert.equal(config.solana, undefined);
    }
  });

  it("on: Solana wallets plus Privy's hosted RPC, never an app-supplied endpoint", () => {
    const config = configFor(true);
    assert.equal(config.appearance?.walletChainType, "ethereum-and-solana");
    assert.equal(config.solana, undefined, "no solana.rpcs: an app-supplied URL is where a keyed endpoint would leak");
    assert.equal(config.plugins?.length, 1);
    assert.equal(config.plugins![0]!.id, defaultSolanaRpcsPlugin().id);
    const rpcs = config.plugins![0]!.getDefaultRpcs!({ appId: "fixture-app-id" }) as Record<string, { rpc?: unknown; rpcSubscriptions?: unknown }>;
    // @solana/kit clients are lazy proxies: building them sends nothing.
    assert.ok(rpcs["solana:mainnet"]?.rpc, "a mainnet RPC client");
    assert.ok(rpcs["solana:mainnet"]?.rpcSubscriptions, "a mainnet subscriptions client");
  });

  it("the installed react-auth falls back to that plugin before it throws for a missing RPC", () => {
    // If a Privy upgrade drops this fallback, the signing screen breaks again
    // with nothing else failing: the screen tests mock Privy.
    const dist = join(WEB, "../../node_modules/@privy-io/react-auth/dist/esm");
    const accessor = readdirSync(dist).filter((name) => name.endsWith(".mjs")).map((name) => readFileSync(join(dist, name), "utf8"))
      .find((source) => source.includes("No RPC configuration found for chain"));
    assert.ok(accessor, "react-auth's Solana RPC accessor moved");
    assert.match(accessor, /\.solanaRpcs\[e\]\?\?t\?\.\[e\]/, "configured RPCs first, then the plugin's defaults");
    assert.match(accessor, /getDefaultRpcs\(\{appId:/);
  });

  it("only the terminal layout turns it on, from the server switch", () => {
    assert.match(readFileSync(join(WEB, "app/(app)/layout.tsx"), "utf8"), /<Providers locale=\{locale\} solana=\{solanaEnabled\(\)\}>/);
    const others: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !full.endsWith(join("(app)", "layout.tsx")) && /<Providers\b[^>]*\bsolana\b/.test(readFileSync(full, "utf8"))) others.push(full);
      }
    };
    walk(join(WEB, "app"));
    assert.deepEqual(others, []);
  });
});
