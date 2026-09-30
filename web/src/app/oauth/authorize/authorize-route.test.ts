/**
 * /oauth/authorize through the real route and a real NextRequest. Next's own
 * URL parser rewrites the first 127.x.x.x / [::1] / localhost anywhere in a
 * request URL — the query included — to "localhost", so a route that reads
 * req.url sees a different redirect_uri (and state) than the client sent.
 * Seen in production 2026-09-25: a client registered on http://127.0.0.1:…
 * was refused with "redirect_uri is missing or not registered".
 */
import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";
import { NextRequest } from "next/server";
import { registerClient } from "@/mcp/oauth/clients";
import { pkceS256 } from "@/mcp/oauth/crypto";
import { rawRequestUrl } from "@/mcp/oauth/deps";
import { installFixtures, makeTestDb } from "@/mcp/testing";
import { GET } from "./route";

before(() => {
  process.env.MERRYMEN_HOSTED = "1";
  process.env.DATABASE_URL = "postgres://unused-in-tests";
  process.env.MERRYMEN_PUBLIC_ORIGIN = "https://app.test";
  process.env.MERRYMEN_MCP_RESOURCE_URL = "https://mcp.test/mcp";
  process.env.MERRYMEN_SESSION_SECRET = "s".repeat(48);
});

let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });

const redirect = "http://127.0.0.1:53690/callback";
const authorizeUrl = (clientId: string, state: string) => `https://app.test/oauth/authorize?${new URLSearchParams({
  response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: pkceS256("v".repeat(50)),
  code_challenge_method: "S256", state, scope: "market:read", resource: "https://mcp.test/mcp",
})}`;

test("Next rewrites 127.0.0.1 in the query of req.url; rawRequestUrl keeps the query as sent", () => {
  const url = `https://app.test/oauth/authorize?redirect_uri=${encodeURIComponent(redirect)}`;
  const req = new NextRequest(url);
  assert.match(req.url, /localhost%3A53690/, "the framework behaviour this guards against (if this ever fails, Next fixed it)");
  assert.equal(rawRequestUrl(req), url);
  assert.equal(new URL(rawRequestUrl(req)).searchParams.get("redirect_uri"), redirect);
});

test("a client registered on a 127.0.0.1 loopback redirect reaches consent through the real route", async () => {
  const d = await makeTestDb();
  restore = installFixtures(d);
  const reg = await registerClient(d, { client_name: "Loopback client", redirect_uris: [redirect], token_endpoint_auth_method: "none" }, Math.floor(Date.now() / 1000));
  assert.equal(reg.status, 201);
  const res = await GET(new NextRequest(authorizeUrl(String(reg.body.client_id), "st-127.0.0.1-x")));
  assert.equal(res.status, 302, await res.clone().text());
  assert.match(res.headers.get("location") ?? "", /^https:\/\/app\.test\/connect\/app#request=/);
  // The parked request holds the redirect and state exactly as the client sent them.
  const row = d.raw.prepare("SELECT redirect_uri, state FROM mcp_auth_requests ORDER BY created_at DESC LIMIT 1").get() as { redirect_uri: string; state: string };
  assert.equal(row.redirect_uri, redirect);
  assert.equal(row.state, "st-127.0.0.1-x", "state round-trips unchanged");
});
