/**
 * Two things matter here.
 *
 * The credential CHOICE — the owner's own key must always win over the shared
 * holder gateway, because it's their quota, their limits, and nobody else in the
 * path. And the PROTOCOL switch: against a personal key the client sends real
 * GraphQL, but the gateway takes a named query and builds the GraphQL itself.
 * Sending raw GraphQL to the gateway would be rejected; sending a bare name to
 * Bitquery would be a syntax error. Getting this backwards fails silently-ish
 * and only for holders, which is the worst way for it to fail.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  MERRYMEN_GATEWAY_BITQUERY,
  parsePoolEvent,
  resolveBitquery,
  bitqueryAuthHeaders,
  bitqueryHttpHint,
  bitqueryQuery,
  bitqueryRequestHeaders,
} from "./bitquery";

describe("resolveBitquery — whose quota is this?", () => {
  it("prefers the owner's own key over the shared gateway", () => {
    const c = resolveBitquery({ bitqueryApiKey: "personal", merrymenToken: "mmk_x" })!;
    assert.equal(c.apiKey, "personal");
    assert.equal(c.viaGateway, undefined, "no third party in the path when they brought a key");
    assert.equal(c.endpoint, undefined, "straight to Bitquery");
  });

  it("falls back to the holder gateway when there's no personal key", () => {
    const c = resolveBitquery({ merrymenToken: "mmk_x" })!;
    assert.equal(c.apiKey, "mmk_x");
    assert.equal(c.viaGateway, true);
    assert.equal(c.endpoint, MERRYMEN_GATEWAY_BITQUERY);
  });

  it("honours a self-hosted gateway URL", () => {
    const c = resolveBitquery({ merrymenToken: "mmk_x", gatewayUrl: "http://localhost:8787/bitquery" })!;
    assert.equal(c.endpoint, "http://localhost:8787/bitquery");
  });

  it("returns null with neither — no discovery is honest, a broken client isn't", () => {
    assert.equal(resolveBitquery({}), null);
    assert.equal(resolveBitquery({ bitqueryApiKey: "", merrymenToken: "" }), null);
  });
});

describe("parsePoolEvent — third-party JSON reaching a trading agent", () => {
  const ok = {
    Block: { Time: "2026-07-27T12:00:00Z" },
    Transaction: { Hash: "0xabc" },
    Arguments: [
      { Name: "token0", Value: { address: "0x00000000000000000000000000000000000000c1" } },
      { Name: "token1", Value: { address: "0x00000000000000000000000000000000000000d0" } },
    ],
  };

  it("reads a well-formed event", () => {
    const p = parsePoolEvent(ok)!;
    assert.equal(p.token, "0x00000000000000000000000000000000000000c1");
    assert.equal(p.quote, "0x00000000000000000000000000000000000000d0");
    assert.equal(p.txHash, "0xabc");
    assert.ok(p.createdAt > 0);
  });

  it("lowercases addresses so downstream comparisons hold", () => {
    const upper = { ...ok, Arguments: ok.Arguments.map((a) => ({ ...a, Value: { address: a.Value.address.toUpperCase().replace("0X", "0x") } })) };
    assert.equal(parsePoolEvent(upper)?.token, ok.Arguments[0]!.Value.address);
  });

  it("returns null rather than throwing on anything malformed", () => {
    // A schema change upstream must degrade to "found nothing", never crash a
    // tick that is also responsible for selling the owner's positions.
    for (const bad of [
      null,
      undefined,
      "string",
      42,
      {},
      { Arguments: [] },
      { ...ok, Arguments: [ok.Arguments[0]] }, // only one address
      { ...ok, Block: { Time: "not-a-date" } },
      { ...ok, Block: {} },
      { ...ok, Arguments: [{ Name: "x", Value: { address: "0x123" } }, { Name: "y", Value: { address: "nope" } }] },
    ]) {
      assert.doesNotThrow(() => parsePoolEvent(bad));
      assert.equal(parsePoolEvent(bad), null, `should reject ${JSON.stringify(bad)?.slice(0, 40)}`);
    }
  });

  it("tolerates a missing tx hash without discarding the event", () => {
    const p = parsePoolEvent({ ...ok, Transaction: undefined });
    assert.equal(p?.txHash, "");
    assert.equal(p?.token, ok.Arguments[0]!.Value.address);
  });
});

describe("parsePoolEvent — the v4 PoolKey, all five fields or none", () => {
  const A = "0x00000000000000000000000000000000000000a1";
  const B = "0x00000000000000000000000000000000000000b2";
  const HOOK = "0x00000000000000000000000000000000000000f1";
  const namedEvent = (args: { Name: string; Value: Record<string, unknown> }[]) => ({
    Block: { Time: "2026-08-26T12:00:00Z" },
    Transaction: { Hash: "0xabc" },
    Arguments: args,
  });
  const FULL = [
    { Name: "currency0", Value: { address: A } },
    { Name: "currency1", Value: { address: B } },
    { Name: "fee", Value: { integer: 8388608 } },
    { Name: "tickSpacing", Value: { integer: 200 } },
    { Name: "hooks", Value: { address: HOOK } },
  ];

  it("a complete Initialize event yields the whole key — hooks included", () => {
    // This is the ONLY way a hooked pool ever becomes routable: the hook
    // address cannot be guessed by tier-scanning, only read from this event.
    const p = parsePoolEvent(namedEvent(FULL))!;
    assert.ok(p, "the pair parses");
    assert.deepEqual(p.key, { currency0: A, currency1: B, fee: 8388608, tickSpacing: 200, hooks: HOOK });
  });

  it("a MISSING field means NO key, never a defaulted one", () => {
    // A partial key is not a vaguer version of the same pool — it is a
    // DIFFERENT pool. Defaulting fee to 0 would fabricate an identity, which
    // is the unknown-as-zero bug wearing a pool costume.
    for (const drop of ["currency0", "fee", "tickSpacing", "hooks"]) {
      const p = parsePoolEvent(namedEvent(FULL.filter((a) => a.Name !== drop)));
      // currency0 dropped may kill the whole pair (fewer than 2 addresses is
      // fine too) — the invariant is only that no PARTIAL key ever appears.
      assert.equal(p?.key, undefined, `dropping ${drop} must not yield a key`);
    }
  });

  it("out-of-range values mean no key: fee ≥ 2^24, |tickSpacing| ≥ 2^23, identical currencies", () => {
    const bad = (name: string, Value: Record<string, unknown>) =>
      namedEvent(FULL.map((a) => (a.Name === name ? { Name: name, Value } : a)));
    assert.equal(parsePoolEvent(bad("fee", { integer: 2 ** 24 }))?.key, undefined);
    assert.equal(parsePoolEvent(bad("tickSpacing", { integer: 2 ** 23 }))?.key, undefined);
    assert.equal(parsePoolEvent(bad("currency1", { address: A }))?.key, undefined, "a pool of itself is not a pool");
  });

  it("bigInteger strings are accepted where integer is absent — Bitquery types by width", () => {
    const p = parsePoolEvent(
      namedEvent(FULL.map((a) => (a.Name === "fee" ? { Name: "fee", Value: { bigInteger: "3000" } } : a))),
    )!;
    assert.equal(p.key?.fee, 3000);
  });

  it("the OLD event shape — addresses only, no names — still parses, keyless", () => {
    // The gateway path and pre-key sightings produce exactly this. Discovery
    // must keep working for them, just without a routable key.
    const p = parsePoolEvent({
      Block: { Time: "2026-08-26T12:00:00Z" },
      Transaction: { Hash: "0xabc" },
      Arguments: [{ Value: { address: A } }, { Value: { address: B } }],
    })!;
    assert.ok(p);
    assert.equal(p.key, undefined);
  });
});

/**
 * The auth header, which had exactly one right answer and used to send both.
 *
 * Bitquery has two credential generations: a legacy V1 key for `X-API-KEY` and a
 * V2 OAuth token (`ory_at_…`) for `Authorization: Bearer`. Sending both with the
 * same value works for a V1 key and hands a V2 endpoint two conflicting
 * credentials — which comes back as an opaque 402, reads as a billing problem,
 * and sends you to the wrong console. gateway/lib/core.mjs shipped this fix after
 * that exact misdiagnosis ("the opaque 402 we spent a deploy chasing"); the
 * worker kept sending both, so discovery could return nothing on a good key
 * while looking configured.
 */
describe("bitquery auth headers", () => {
  it("a V2 OAuth token goes in Authorization: Bearer, and ONLY there", () => {
    const h = bitqueryAuthHeaders("ory_at_abc123");
    assert.equal(h.Authorization, "Bearer ory_at_abc123");
    assert.equal(h["X-API-KEY"], undefined, "two credentials is what caused the 402");
    assert.equal(Object.keys(h).length, 1);
  });

  it("a legacy V1 key goes in X-API-KEY, and ONLY there", () => {
    const h = bitqueryAuthHeaders("BQY-legacy-key");
    assert.equal(h["X-API-KEY"], "BQY-legacy-key");
    assert.equal(h.Authorization, undefined);
    assert.equal(Object.keys(h).length, 1);
  });

  it("never emits both headers, whatever the key looks like", () => {
    // The single property worth pinning: the failure was silent and looked like
    // billing, so nothing downstream would have caught a regression here.
    for (const key of ["ory_at_x", "plain", "", "ORY_AT_upper", "0x1234", "ory_at_"]) {
      assert.equal(Object.keys(bitqueryAuthHeaders(key)).length, 1, `two headers for ${JSON.stringify(key)}`);
    }
  });
});

/**
 * THE GATEWAY'S TOKEN, WHICH NEVER ARRIVED.
 *
 * A Merry Circle token (`mmk_…`) is not `ory_at_…`, so the header rule above
 * put it in `X-API-KEY`, and the gateway's /bitquery route reads
 * `Authorization: Bearer` and nothing else. Every holder's discovery call was
 * a 401, reported as an expired token or a wallet that no longer qualified.
 * These drive the real bitqueryQuery against a stubbed fetch and read the
 * request back through the gateway's own extraction rule.
 */
describe("bitqueryQuery — the header that reaches whoever answers", () => {
  const SERVER = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "gateway", "server.mjs"),
    "utf8",
  );

  /** gateway/server.mjs, /bitquery: `auth.startsWith("Bearer ") ? auth.slice(7) : ""`. */
  const gatewayToken = (headers: Record<string, string>): string => {
    const auth = headers.authorization ?? headers.Authorization ?? "";
    return auth.startsWith("Bearer ") ? auth.slice(7) : "";
  };

  async function captured(
    creds: Parameters<typeof bitqueryQuery>[0],
    status = 200,
  ): Promise<{ headers: Record<string, string>; result: Awaited<ReturnType<typeof bitqueryQuery>> }> {
    const real = globalThis.fetch;
    let headers: Record<string, string> = {};
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      headers = { ...(init?.headers as Record<string, string>) };
      return new Response(status === 200 ? JSON.stringify({ data: { ok: true } }) : "{}", { status });
    }) as typeof fetch;
    try {
      const result = await bitqueryQuery(creds, "ping");
      return { headers, result };
    } finally {
      globalThis.fetch = real;
    }
  }

  it("the gateway route still reads Bearer and only Bearer — the rule this client must meet", () => {
    const route = SERVER.slice(SERVER.indexOf('pathname === "/bitquery"'), SERVER.indexOf("gw.bitquery("));
    assert.ok(route.length > 0, "the /bitquery route was found");
    assert.match(route, /req\.headers\["authorization"\]/);
    assert.match(route, /auth\.startsWith\("Bearer "\) \? auth\.slice\(7\) : ""/);
    assert.doesNotMatch(route, /x-api-key/i, "if the gateway ever reads X-API-KEY, revisit bitqueryRequestHeaders");
  });

  it("a Merry Circle token goes in Authorization: Bearer, and the gateway reads it back intact", async () => {
    const creds = resolveBitquery({ merrymenToken: "mmk_eyJhIjoiMHgxIn0.sig" })!;
    const { headers, result } = await captured(creds);
    assert.equal(result.ok, true);
    assert.equal(gatewayToken(headers), "mmk_eyJhIjoiMHgxIn0.sig", "the token the gateway verifies is the one we hold");
    assert.equal(headers["X-API-KEY"], undefined, "one credential header, never two");
  });

  it("an owner's V1 key still goes in X-API-KEY, as the gateway's own upstream call does", async () => {
    const { headers } = await captured(resolveBitquery({ bitqueryApiKey: "BQY-legacy" })!);
    assert.equal(headers["X-API-KEY"], "BQY-legacy");
    assert.equal(headers.Authorization, undefined);
  });

  it("an owner's V2 token still goes in Bearer", async () => {
    const { headers } = await captured(resolveBitquery({ bitqueryApiKey: "ory_at_v2" })!);
    assert.equal(headers.Authorization, "Bearer ory_at_v2");
    assert.equal(headers["X-API-KEY"], undefined);
  });

  it("bitqueryRequestHeaders: the gateway always gets Bearer, whatever the token looks like", () => {
    for (const apiKey of ["mmk_x", "ory_at_y", "BQY", ""]) {
      const h = bitqueryRequestHeaders({ apiKey, viaGateway: true });
      assert.deepEqual(Object.keys(h), ["Authorization"]);
      assert.equal(h.Authorization, `Bearer ${apiKey}`);
    }
    assert.deepEqual(bitqueryRequestHeaders({ apiKey: "BQY" }), { "X-API-KEY": "BQY" });
  });
});

describe("bitqueryHttpHint — a refusal tells the owner what is actually wrong", () => {
  it("a gateway 401 is about the token, a 403 about the wallet, a 503 about neither", () => {
    assert.match(bitqueryHttpHint(401, true), /did not accept your Merry Circle token/);
    assert.doesNotMatch(bitqueryHttpHint(401, true), /wallet|\$MERRYMEN/, "a 401 is not a holdings verdict");
    assert.match(bitqueryHttpHint(403, true), /no longer holds enough \$MERRYMEN/);
    assert.doesNotMatch(bitqueryHttpHint(403, true), /expired|claim a fresh/, "a 403 is not a token problem");
    assert.match(bitqueryHttpHint(503, true), /this is not your token/);
    assert.match(bitqueryHttpHint(503, true), /daily allowance/, "the gateway's fleet-wide cap is one of the 503s");
    assert.match(bitqueryHttpHint(429, true), /per-wallet/);
  });

  it("a direct key's 401/403 points at /settings, and nothing else gets a guess", () => {
    assert.match(bitqueryHttpHint(401, false), /\/settings/);
    assert.match(bitqueryHttpHint(403, undefined), /\/settings/);
    assert.equal(bitqueryHttpHint(429, false), "");
    assert.equal(bitqueryHttpHint(500, true), "");
  });

  it("the hint is what bitqueryQuery reports — and the old misdiagnosis is gone", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    try {
      const r = await bitqueryQuery(resolveBitquery({ merrymenToken: "mmk_x" })!, "ping");
      assert.equal(r.ok, false);
      assert.match(r.error!, /^bitquery HTTP 401 — the gateway did not accept/);
      assert.doesNotMatch(r.error!, /wallet no longer qualifies/);
    } finally {
      globalThis.fetch = real;
    }
  });
});
