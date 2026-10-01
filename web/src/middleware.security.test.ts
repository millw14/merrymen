import assert from "node:assert/strict";
import { before, test } from "node:test";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { documentPolicy } from "./lib/browser-security";
import nextConfig from "../next.config.mjs";

let middlewareConfig: typeof import("./middleware").config;
let middleware: typeof import("./middleware").middleware;
before(async () => {
  delete process.env.MERRYMEN_HOSTED;
  delete process.env.MERRYMEN_PUBLIC_ORIGIN;
  delete process.env.MERRYMEN_OAUTH_ISSUER;
  delete process.env.MERRYMEN_MCP_RESOURCE_URL;
  ({ middleware, config: middlewareConfig } = await import("./middleware"));
});

function request(url: string, headers: Record<string, string> = {}, method = "POST") {
  return new NextRequest(url, { method, headers: { host: new URL(url).host, ...headers } });
}

test("LAN HTTP cannot bypass CSRF by omitting Fetch Metadata or using a simple content type", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const origin of ["http://attacker.example", "null", "http://192.168.1.20:9999"]) {
      const response = middleware(request("http://192.168.1.20:3100/api/recover", { origin, "content-type": "text/plain" }, method));
      assert.equal(response.status, 403, `${method} from ${origin}`);
    }
  }
  assert.equal(middleware(request("http://192.168.1.20:3100/api/recover", { origin: "http://attacker.example", "sec-fetch-site": "same-origin" })).status, 403);
});

test("same-origin LAN and loopback requests work, preserving Next's 127.0.0.1 Host spelling", () => {
  for (const origin of ["http://192.168.1.20:3100", "http://127.0.0.1:3100", "http://localhost:3100", "http://[::1]:3100"]) {
    assert.equal(middleware(request(`${origin}/api/settings`, { origin }, "PUT")).headers.get("x-middleware-next"), "1", origin);
  }
});

test("legacy browser Referer fallback rejects foreign pages, and opaque unsafe browser requests fail closed", () => {
  const url = "http://192.168.1.20:3100/api/recover";
  assert.equal(middleware(request(url, { referer: "http://attacker.example/" })).status, 403);
  assert.equal(middleware(request(url, { referer: "not a URL" })).status, 403);
  assert.equal(middleware(request(url, { referer: "http://192.168.1.20:3100/settings" })).status, 200);
  assert.equal(middleware(request(url, { "sec-fetch-mode": "no-cors" })).status, 403);
  assert.equal(middleware(request(url, { "sec-fetch-site": "none" })).status, 403);
  assert.equal(middleware(request(url, { "sec-fetch-site": "same-origin" })).status, 200);
});

test("non-browser clients still reach route authorization and DNS-rebinding hosts remain blocked", () => {
  const clients: Record<string, string>[] = [{}, { authorization: "Bearer test-token" }, { "x-merrymen-partner-signature": "test-signature" }];
  for (const headers of clients) {
    assert.equal(middleware(request("http://localhost:3100/api/partner/agents", headers)).headers.get("x-middleware-next"), "1");
  }
  assert.equal(middleware(request("http://attacker.example:3100/api/recover")).status, 403);
});

test("document nonces are fresh, override supplied values and agree in request and response policy", () => {
  const first = middleware(request("http://localhost:3100/home", { "x-nonce": "attacker", "content-security-policy": "script-src * 'unsafe-inline'" }, "GET"));
  const second = middleware(request("http://localhost:3100/home", {}, "GET"));
  const nonce = first.headers.get("x-middleware-request-x-nonce");
  assert.match(nonce ?? "", /^[A-Za-z0-9+/]{22}==$/);
  assert.notEqual(nonce, second.headers.get("x-middleware-request-x-nonce"));
  const policy = first.headers.get("content-security-policy");
  assert.equal(first.headers.get("x-middleware-request-content-security-policy"), policy);
  assert.ok(policy?.includes(`'nonce-${nonce}'`));
  assert.match(first.headers.get("cache-control") ?? "", /no-store/);
});

test("dotted application paths and unknown documents match middleware and receive nonce policy", () => {
  for (const pathname of ["/a/alice.eth", "/connect/approve/id.js", "/connect/export/grant.json", "/missing/document.svg", "/fonts/not-an-asset.js"]) {
    const url = `http://localhost:3100${pathname}`;
    assert.equal(unstable_doesMiddlewareMatch({ config: middlewareConfig, nextConfig, url }), true, pathname);
    assert.match(middleware(request(url, {}, "GET")).headers.get("content-security-policy") ?? "", /script-src [^;]*'nonce-/, pathname);
  }
  for (const pathname of ["/sw.js", "/fonts/Inter-latin.woff2", "/sdk/merrymen-browser.js", "/offline.html"]) {
    assert.equal(middleware(request(`http://localhost:3100${pathname}`, {}, "GET")).headers.get("content-security-policy"), null, pathname);
  }
});

test("production script policy blocks injected inline scripts while keeping required RPC, Privy and Stripe paths", () => {
  const policy = documentPolicy("testnonce", { development: false, hosted: true });
  const script = policy.split(";").map(p => p.trim()).find(p => p.startsWith("script-src "))!;
  assert.match(script, /'strict-dynamic'/);
  assert.doesNotMatch(script, /unsafe-inline|unsafe-eval|https:/);
  assert.match(policy, /script-src-attr 'none'/);
  assert.match(policy, /frame-src [^;]*https:\/\/auth\.privy\.io/);
  assert.match(policy, /frame-src [^;]*https:\/\/js\.stripe\.com/);
  assert.match(policy, /connect-src 'self' https: wss:;/);
  assert.match(documentPolicy("testnonce", { development: true, hosted: false }), /'unsafe-eval'/);
});

test("document script policy does not bleed into protocol handlers or MCP App resources", () => {
  for (const path of ["/mcp", "/mcp/directory", "/oauth/token", "/.well-known/oauth-authorization-server", "/api/partner/agents", "/sw.js"]) {
    assert.equal(middleware(request(`http://localhost:3100${path}`)).headers.get("content-security-policy"), null, path);
  }
});

test("all routes receive anti-frame, MIME and referrer protections while browser SDK CORS remains", async () => {
  const rules = await nextConfig.headers!();
  const global = rules.find(r => r.source === "/:path*")!;
  const headers = new Map(global.headers.map(h => [h.key.toLowerCase(), h.value]));
  assert.equal(headers.get("x-frame-options"), "DENY");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("referrer-policy"), "no-referrer");
  assert.match(headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.ok(rules.find(r => r.source === "/sdk/merrymen-browser.js")?.headers.some(h => h.key === "Access-Control-Allow-Origin" && h.value === "*"));
});
