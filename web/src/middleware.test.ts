/**
 * The middleware on the dedicated MCP domain, through real NextRequests and
 * Next's own matcher compiler.
 *
 * mcp.merrymen.dev is the web service under a second domain. Seen in
 * production 2026-09-25: a browser there got the whole terminal, signed out
 * (the sign-in cookie lives on app.merrymen.dev), and an MCP client given the
 * bare domain got 200 text/html for its POST, so OAuth never started. These
 * pin the fix and, as much, that nothing changes anywhere else: the app host,
 * a host nobody configured, and an install whose MCP URL is on the app host.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { before, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { CANONICAL_ROUTE_PATH, mcpConfig } from "@/mcp/config";
import { MCP_ROUTE_PATH, dedicatedMcpHost, isBrowserNavigation, mcpHostLanding } from "@/mcp/landing";

// The middleware reads its configuration once, at import (as it does in
// production), so the environment is set first and the module imported after.
let mw: typeof import("./middleware");
before(async () => {
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_PUBLIC_ORIGIN = "https://app.test";
  process.env.MERRYMEN_MCP_RESOURCE_URL = "https://mcp.test/mcp";
  delete process.env.MERRYMEN_OAUTH_ISSUER;
  mw = await import("./middleware");
});

/** What a browser sends when a person opens a URL. */
const PAGE_LOAD = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
};

function req(url: string, init: { method?: string; host?: string; headers?: Record<string, string>; body?: string } = {}): NextRequest {
  const host = init.host ?? new URL(url).host;
  return new NextRequest(url, { method: init.method ?? "GET", headers: { host, ...init.headers }, body: init.body });
}

const page = (url: string, host?: string) => req(url, { host, headers: PAGE_LOAD });

/** NextResponse.next(): the request goes on to the page or route exactly as before. */
function untouched(res: Response, what: string) {
  assert.equal(res.headers.get("x-middleware-next"), "1", `${what}: passed through (status ${res.status}, location ${res.headers.get("location")})`);
  assert.equal(res.headers.get("location"), null, what);
}

function redirected(res: Response, status: number, location: string, what: string) {
  assert.equal(res.status, status, what);
  assert.equal(res.headers.get("location"), location, what);
  assert.equal(res.headers.get("cache-control"), "no-store", `${what}: a redirect chosen by request headers is never cached`);
}

describe("a browser on the MCP domain is sent to the app, where the owner is signed in", () => {
  it("the bare domain opens the connect help page on the issuer", () => {
    redirected(mw.middleware(page("https://mcp.test/")), 307, "https://app.test/connect/mcp", "/");
  });

  it("any other page keeps its path and query, on the issuer", () => {
    redirected(mw.middleware(page("https://mcp.test/feed?x=1")), 307, "https://app.test/feed?x=1", "/feed?x=1");
    redirected(mw.middleware(page("https://mcp.test/connect/apps")), 307, "https://app.test/connect/apps", "/connect/apps");
  });

  it("a browser that sends no Sec-Fetch headers counts by its Accept, and HEAD counts like GET", () => {
    redirected(mw.middleware(req("https://mcp.test/", { headers: { accept: "text/html" } })), 307, "https://app.test/connect/mcp", "old browser");
    redirected(mw.middleware(req("https://mcp.test/", { method: "HEAD", headers: PAGE_LOAD })), 307, "https://app.test/connect/mcp", "HEAD");
  });

  it("a path that looks like a host stays a path on the issuer (no open redirect)", () => {
    // (Each ends in a segment with no dot: "/x.test" alone would count as a file and pass through.)
    for (const path of ["//evil.test/x", "/%2F%2Fevil.test/x", "/@evil.test/x", "/\\evil.test/x", "/./..//evil.test/x"]) {
      const res = mw.middleware(page(`https://mcp.test${path}`));
      assert.equal(res.status, 307, path);
      assert.equal(new URL(res.headers.get("location") ?? "").origin, "https://app.test", `${path} → ${res.headers.get("location")}`);
    }
  });
});

describe("a client given the bare MCP domain is pointed at the endpoint", () => {
  it("POST / → 308 to /mcp, which keeps the method and body", () => {
    const res = mw.middleware(req("https://mcp.test/", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    }));
    redirected(res, 308, "https://mcp.test/mcp", "POST /");
  });

  it("curl, fetch() and anything carrying a token or an MCP header at / get the same 308", () => {
    redirected(mw.middleware(req("https://mcp.test/", { headers: { accept: "*/*" } })), 308, "https://mcp.test/mcp", "curl");
    redirected(mw.middleware(req("https://mcp.test/", { headers: { accept: "*/*", "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" } })), 308, "https://mcp.test/mcp", "fetch()");
    redirected(mw.middleware(req("https://mcp.test/", { headers: { ...PAGE_LOAD, authorization: "Bearer x" } })), 308, "https://mcp.test/mcp", "Authorization");
    redirected(mw.middleware(req("https://mcp.test/", { headers: { ...PAGE_LOAD, "mcp-protocol-version": "2025-06-18" } })), 308, "https://mcp.test/mcp", "MCP-Protocol-Version");
  });

  it("a client at any other page path is left alone", () => {
    untouched(mw.middleware(req("https://mcp.test/feed", { headers: { accept: "*/*" } })), "curl /feed");
    untouched(mw.middleware(req("https://mcp.test/feed", { method: "POST", body: "{}" })), "POST /feed");
  });
});

describe("what the MCP domain serves itself is never redirected, even for a browser", () => {
  for (const path of [
    "/mcp", "/mcp/anything", "/mcp/directory", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource/mcp/directory", "/.well-known/oauth-authorization-server",
    "/oauth/authorize?client_id=x", "/oauth/token", "/_next/static/chunks/app.js", "/_next/image?url=x",
    "/icon-192.png", "/mcp-icon.svg", "/favicon.svg", "/sw.js", "/manifest.webmanifest", "/robots.txt",
  ]) {
    it(path, () => untouched(mw.middleware(page(`https://mcp.test${path}`)), path));
  }

  it("the API keeps its guards and nothing else: a same-origin call passes, a cross-site one is still refused", () => {
    untouched(mw.middleware(req("https://mcp.test/api/mcp/health", { headers: { accept: "application/json" } })), "/api/mcp/health");
    untouched(mw.middleware(page("https://mcp.test/api/mcp/health")), "/api opened in a browser");
    const cross = mw.middleware(req("https://mcp.test/api/grants", { method: "POST", headers: { "sec-fetch-site": "cross-site" } }));
    assert.equal(cross.status, 403);
  });
});

describe("every other host behaves exactly as before", () => {
  it("the app host: pages and a POST to / pass through", () => {
    untouched(mw.middleware(page("https://app.test/")), "app /");
    untouched(mw.middleware(page("https://app.test/feed?x=1")), "app /feed");
    untouched(mw.middleware(req("https://app.test/", { method: "POST", body: "{}" })), "app POST /");
  });

  it("a Host header nobody configured is compared, never followed", () => {
    for (const host of ["evil.test", "mcp.test.evil.test", "mcp.test:8443", ""]) {
      untouched(mw.middleware(page("https://mcp.test/", host)), `Host ${JSON.stringify(host)}, browser`);
      untouched(mw.middleware(req("https://mcp.test/", { host, method: "POST", body: "{}" })), `Host ${JSON.stringify(host)}, POST`);
    }
    // Host names are case-insensitive: the configured host in capitals is still it.
    redirected(mw.middleware(page("https://mcp.test/", "MCP.test")), 307, "https://app.test/connect/mcp", "MCP.test");
  });

  it("an install whose MCP URL is on the app host has no MCP domain, and so no redirects", () => {
    const sameHost = dedicatedMcpHost({ MERRYMEN_PUBLIC_ORIGIN: "https://app.test", MERRYMEN_MCP_RESOURCE_URL: "https://app.test/mcp" }, true);
    assert.equal(sameHost, null);
    assert.equal(dedicatedMcpHost({ MERRYMEN_PUBLIC_ORIGIN: "https://app.test" }, true), null, "the default resource is <origin>/mcp");
    for (const [r, what] of [[page("https://app.test/"), "browser /"], [req("https://app.test/", { method: "POST", body: "{}" }), "POST /"]] as const) {
      assert.equal(mcpHostLanding(sameHost, { method: r.method, headers: r.headers, pathname: r.nextUrl.pathname, search: r.nextUrl.search }), null, what);
    }
  });

  it("self-hosted (not hosted) never has an MCP domain, whatever the variables say", () => {
    assert.equal(dedicatedMcpHost({ MERRYMEN_PUBLIC_ORIGIN: "https://app.test", MERRYMEN_MCP_RESOURCE_URL: "https://mcp.test/mcp" }, false), null);
  });

  it("a resource at any path but /mcp (the root included) is no endpoint at all: MCP is off, so nothing to route", () => {
    for (const r of ["https://mcp.test/", "https://mcp.test", "https://mcp.test/v2/mcp", "https://mcp.test/mcp/directory", "https://mcp.test/MCP"]) {
      assert.equal(dedicatedMcpHost({ MERRYMEN_PUBLIC_ORIGIN: "https://app.test", MERRYMEN_MCP_RESOURCE_URL: r }, true), null, r);
    }
  });
});

describe("the MCP domain comes from configuration exactly as config.ts reads it", () => {
  const envs: Array<Record<string, string>> = [
    { MERRYMEN_PUBLIC_ORIGIN: "https://app.test", MERRYMEN_MCP_RESOURCE_URL: "https://mcp.test/mcp" },
    { MERRYMEN_PUBLIC_ORIGIN: " https://app.test/ ", MERRYMEN_MCP_RESOURCE_URL: "https://MCP.test/mcp/" },
    { MERRYMEN_OAUTH_ISSUER: "https://auth.test", MERRYMEN_PUBLIC_ORIGIN: "https://app.test", MERRYMEN_MCP_RESOURCE_URL: "https://mcp.test/mcp" },
    { MERRYMEN_OAUTH_ISSUER: "https://auth.test", MERRYMEN_PUBLIC_ORIGIN: "https://app.test", MERRYMEN_MCP_RESOURCE_URL: "https://mcp.test/v1/mcp" },
    { MERRYMEN_PUBLIC_ORIGIN: "https://app.test", MERRYMEN_MCP_RESOURCE_URL: "https://mcp.test/" },
    { MERRYMEN_PUBLIC_ORIGIN: "https://app.test", MERRYMEN_MCP_RESOURCE_URL: "https://mcp.test/mcp/directory" },
    { MERRYMEN_PUBLIC_ORIGIN: "https://app.test", MERRYMEN_MCP_RESOURCE_URL: "https://mcp.test:8443/mcp" },
    { MERRYMEN_PUBLIC_ORIGIN: "http://localhost:3100", MERRYMEN_MCP_RESOURCE_URL: "http://127.0.0.1:3100/mcp" },
    { MERRYMEN_PUBLIC_ORIGIN: "http://app.test", MERRYMEN_MCP_RESOURCE_URL: "https://mcp.test/mcp" },
    { MERRYMEN_PUBLIC_ORIGIN: "https://user:pw@app.test", MERRYMEN_MCP_RESOURCE_URL: "https://mcp.test/mcp" },
    { MERRYMEN_PUBLIC_ORIGIN: "https://app.test", MERRYMEN_MCP_RESOURCE_URL: "https://mcp.test/mcp?x=1" },
    { MERRYMEN_PUBLIC_ORIGIN: "https://app.test", MERRYMEN_MCP_RESOURCE_URL: "http://mcp.test/mcp" },
    { MERRYMEN_PUBLIC_ORIGIN: "not a url", MERRYMEN_MCP_RESOURCE_URL: "https://mcp.test/mcp" },
  ];
  for (const env of envs) {
    it(JSON.stringify(env), () => {
      const cfg = mcpConfig(env as NodeJS.ProcessEnv);
      const mcp = dedicatedMcpHost(env, true);
      if (!cfg.issuer || !cfg.resource) {
        assert.equal(mcp, null, "no MCP domain when config.ts has no issuer or resource");
        return;
      }
      assert.ok(mcp, "a second host was configured");
      assert.equal(mcp.issuer, cfg.issuer);
      assert.equal(mcp.resource, cfg.resource);
      assert.equal(mcp.host, new URL(cfg.resource).host);
      assert.ok(cfg.allowedHosts.has(mcp.host), "the endpoint answers on the host redirects are issued for");
    });
  }

  it("both read the one served path", () => assert.equal(MCP_ROUTE_PATH, CANONICAL_ROUTE_PATH));
});

describe("a page load is told apart from a client", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  it("by Sec-Fetch-Dest when the browser sends it, and by Accept only when it does not", () => {
    assert.equal(isBrowserNavigation("GET", h(PAGE_LOAD)), true);
    assert.equal(isBrowserNavigation("GET", h({ accept: "text/html", "sec-fetch-dest": "empty" })), false, "a fetch() asking for HTML is not a page load");
    assert.equal(isBrowserNavigation("GET", h({ accept: "text/html", "sec-fetch-dest": "iframe" })), false);
    assert.equal(isBrowserNavigation("GET", h({ accept: "text/html" })), true);
    assert.equal(isBrowserNavigation("GET", h({ accept: "application/json, text/event-stream" })), false);
    assert.equal(isBrowserNavigation("GET", h({})), false);
  });
  it("never for another method, a token or an MCP header", () => {
    assert.equal(isBrowserNavigation("POST", h(PAGE_LOAD)), false);
    assert.equal(isBrowserNavigation("DELETE", h(PAGE_LOAD)), false);
    assert.equal(isBrowserNavigation("GET", h({ ...PAGE_LOAD, authorization: "Bearer x" })), false);
    assert.equal(isBrowserNavigation("GET", h({ ...PAGE_LOAD, "mcp-protocol-version": "2026-07-28" })), false);
  });
});

describe("the matcher, compiled by Next itself, reaches pages and the API but not files or MCP endpoints", () => {
  // Next internals, on purpose: the function tests above never pass through the
  // matcher, and a matcher that silently stopped reaching "/" would undo the
  // whole fix with every test green. If Next moves these files, update the paths.
  const nextRequire = createRequire(import.meta.url);
  const { getMiddlewareMatchers } = nextRequire("next/dist/build/analysis/get-page-static-info.js") as {
    getMiddlewareMatchers: (m: unknown, nextConfig: Record<string, unknown>) => unknown[];
  };
  const { getMiddlewareRouteMatcher } = nextRequire("next/dist/shared/lib/router/utils/middleware-route-matcher.js") as {
    getMiddlewareRouteMatcher: (m: unknown[]) => (pathname: string, req: { headers: Record<string, string> }, query: Record<string, string>) => boolean;
  };
  let runs: (pathname: string) => boolean;
  before(() => {
    const matches = getMiddlewareRouteMatcher(getMiddlewareMatchers(mw.config.matcher, {}));
    runs = (p) => matches(p, { headers: {} }, {});
  });

  it("runs for the API and for pages, the root included", () => {
    for (const p of ["/api/grants", "/api/mcp/health", "/", "/feed", "/connect/mcp", "/connect/app", "/oauth", "/mcpx"]) assert.equal(runs(p), true, p);
  });

  it("does not run for Next's files, static files or the MCP and OAuth endpoints", () => {
    for (const p of ["/_next/static/chunks/app.js", "/_next/image", "/icon-192.png", "/mcp-icon.svg", "/sw.js", "/manifest.webmanifest", "/robots.txt",
      "/mcp", "/mcp/x", "/mcp/directory", "/oauth/token", "/oauth/authorize", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource/mcp/directory", "/.well-known/oauth-authorization-server"]) {
      assert.equal(runs(p), false, p);
    }
  });
});

describe("the directory endpoint (/mcp/directory) passes the MCP-host middleware exactly like /mcp", () => {
  it("a client POST, a GET stream and a browser page load there all reach the route (which does its own checks)", () => {
    const client = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    untouched(mw.middleware(req("https://mcp.test/mcp/directory", { method: "POST", headers: client, body: "{}" })), "POST /mcp/directory");
    untouched(mw.middleware(req("https://mcp.test/mcp/directory", { headers: { accept: "text/event-stream" } })), "GET stream");
    untouched(mw.middleware(page("https://mcp.test/mcp/directory")), "page load: the route answers it with the help-page redirect");
    const lookup = { method: "POST", headers: new Headers({ host: "mcp.test", ...client }), pathname: "/mcp/directory", search: "" };
    assert.equal(mcpHostLanding(dedicatedMcpHost({ MERRYMEN_PUBLIC_ORIGIN: "https://app.test", MERRYMEN_MCP_RESOURCE_URL: "https://mcp.test/mcp" }, true), lookup), null);
  });

  it("its host is one the endpoint answers on, and its first path segment is mcp", () => {
    const cfg = mcpConfig({ MERRYMEN_PUBLIC_ORIGIN: "https://app.test", MERRYMEN_MCP_RESOURCE_URL: "https://mcp.test/mcp" } as unknown as NodeJS.ProcessEnv);
    const dir = new URL(cfg.directoryResource);
    assert.equal(dir.pathname.split("/")[1], "mcp");
    assert.ok(cfg.allowedHosts.has(dir.host));
  });
});
