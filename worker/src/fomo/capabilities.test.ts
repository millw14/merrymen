/**
 * THE CAPABILITY REPORT: what the vendor can do for us, and what each status
 * rests on. The transitions are the part worth pinning: a report that lets a
 * failure erase a success, or lets "we never asked" overwrite "we checked",
 * stops being evidence.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  CAPABILITY_FOR_ROUTE,
  capabilityFromAccount,
  capabilityFromCall,
  capabilityFromStream,
  capabilityReport,
  DOCS_FETCHED_AT,
  DOCUMENTED_CAPABILITIES,
  documentedCapability,
  mergeCapabilities,
  mergeCapability,
} from "./capabilities";
import { ROUTE_COST, type AccountInfo, type CallMeta, type ProviderFailure, type ProviderResult, type RouteName } from "./provider";
import type { CapabilityRecord } from "./types";

const T0 = Date.UTC(2026, 9, 5, 9, 0);
const KEY = "fomo_live_TESTKEY_0123456789abcdef";

function meta(over: Partial<CallMeta> = {}): CallMeta {
  return {
    route: "/v2/leaderboard/{window}",
    status: 200,
    attempts: 1,
    retrievedAt: T0,
    creditsCost: 250,
    creditsRemaining: 1000,
    unmetered: false,
    providerAsOf: null,
    providerSource: null,
    providerStale: null,
    providerAgeSeconds: null,
    ...over,
  };
}

const okResult = (data: unknown, over: Partial<CallMeta> = {}): ProviderResult<unknown> => ({ ok: true, data, meta: meta(over) });
const failResult = (failure: ProviderFailure, over: Partial<CallMeta> = {}): ProviderResult<unknown> => ({
  ok: false,
  failure,
  detail: `http ${over.status ?? "?"}`,
  meta: meta({ creditsCost: null, ...over }),
});

const byName = (name: string): CapabilityRecord => {
  const r = documentedCapability(name);
  assert.ok(r, name);
  return r;
};

describe("the documented baseline", () => {
  it("cites the documentation and its fetch time on every record", () => {
    for (const r of DOCUMENTED_CAPABILITIES) {
      assert.match(r.evidence, /2026-10-04T16:05Z/, r.capability);
      assert.equal(r.verifiedAt, DOCS_FETCHED_AT);
      assert.ok(r.route.startsWith("/"), r.capability);
    }
    assert.equal(new Set(DOCUMENTED_CAPABILITIES.map((r) => r.capability)).size, DOCUMENTED_CAPABILITIES.length, "names are unique");
  });

  it("covers every client route under its route template", () => {
    for (const route of Object.keys(ROUTE_COST) as RouteName[]) {
      const r = byName(CAPABILITY_FOR_ROUTE[route]);
      assert.equal(r.route, ROUTE_COST[route].template, route);
    }
  });

  it("marks the limitations the vendor itself states as PARTIAL", () => {
    assert.equal(byName("token-activity").status, "PARTIAL");
    assert.match(byName("token-activity").evidence, /2026-08-23/);
    assert.equal(byName("theses-by-token").status, "PARTIAL");
    assert.match(byName("theses-by-token").evidence, /no robinhood value/);
    assert.equal(byName("token-holders").status, "PARTIAL");
    assert.match(byName("token-holders").evidence, /8 traders/);
    assert.equal(byName("swaps-relay").status, "PARTIAL");
    assert.match(byName("swaps-relay").evidence, /absent from openapi\.json/);
    assert.equal(byName("token-candles").status, "PARTIAL");
    assert.match(byName("token-candles").evidence, /absent from openapi\.json/);
  });

  it("says the on-chain stream needs Growth or Scale, and refuses the trading product by policy", () => {
    assert.equal(byName("ws-trades").status, "DOCUMENTED");
    assert.match(byName("ws-trades").evidence, /Growth or Scale/);
    assert.equal(byName("trading-account").status, "UNSUPPORTED");
    assert.equal(byName("credit-top-up").status, "UNSUPPORTED");
    assert.match(byName("trading-account").evidence, /^policy: /);
  });

  it("never names the API host (only the adapter may)", () => {
    const src = readFileSync(new URL("./capabilities.ts", import.meta.url), "utf8");
    assert.ok(!/api\.fomoapi\.io/.test(src));
    assert.ok(!/api\.fomoapi\.io/.test(JSON.stringify(DOCUMENTED_CAPABILITIES)));
  });

  it("hands out copies, so a caller cannot edit the baseline", () => {
    const r = byName("leaderboard");
    r.status = "UNAVAILABLE";
    assert.equal(byName("leaderboard").status, "DOCUMENTED");
    assert.equal(documentedCapability("no-such-thing"), null);
  });
});

describe("capabilityFromCall", () => {
  const R = "/v2/users/{userId}/balances";

  it("an authenticated answer with clean rows is AUTHENTICATED_TESTED", () => {
    const r = capabilityFromCall("leaderboard", "/v2/leaderboard/{window}", okResult({ rows: [{}, {}], dropped: 0 }));
    assert.equal(r.status, "AUTHENTICATED_TESTED");
    assert.equal(r.verifiedAt, T0);
    assert.match(r.evidence, /^observed: HTTP 200/);
    assert.match(r.evidence, /250 credits/);
  });

  it("an ignored chain filter is PARTIAL, read from the result when not passed", () => {
    const auto = capabilityFromCall("balances", R, okResult({ rows: [{}], dropped: 0, chainFilterHonoured: false, truncated: false }));
    assert.equal(auto.status, "PARTIAL");
    assert.match(auto.evidence, /chain filter ignored/);
    const explicit = capabilityFromCall("balances", R, okResult({ rows: [{}] }), { chainFilterHonoured: false });
    assert.equal(explicit.status, "PARTIAL");
    const honoured = capabilityFromCall("balances", R, okResult({ rows: [{}], chainFilterHonoured: true }));
    assert.equal(honoured.status, "AUTHENTICATED_TESTED");
    const unknown = capabilityFromCall("balances", R, okResult({ rows: [{}], chainFilterHonoured: null }));
    assert.equal(unknown.status, "AUTHENTICATED_TESTED", "nothing to check is not a failed check");
  });

  it("a truncated answer is PARTIAL", () => {
    assert.equal(capabilityFromCall("balances", R, okResult({ rows: [{}], truncated: true })).status, "PARTIAL");
    assert.equal(capabilityFromCall("balances", R, okResult({ rows: [{}] }), { truncated: true }).status, "PARTIAL");
  });

  it("an answer whose every row failed identity checks is PARTIAL, not tested", () => {
    const r = capabilityFromCall("leaderboard", "/v2/leaderboard/{window}", okResult({ rows: [], dropped: 7 }));
    assert.equal(r.status, "PARTIAL");
    assert.match(r.evidence, /every row \(7\) failed identity checks/);
    const some = capabilityFromCall("leaderboard", "/v2/leaderboard/{window}", okResult({ rows: [{}], dropped: 2 }));
    assert.equal(some.status, "AUTHENTICATED_TESTED");
    assert.match(some.evidence, /2 rows dropped/);
  });

  it("plan and credit refusals are ENTITLEMENT_BLOCKED", () => {
    for (const f of ["entitlement", "credits-exhausted", "unauthorized"] as const) {
      assert.equal(capabilityFromCall("leaderboard", "/r", failResult(f, { status: 403 })).status, "ENTITLEMENT_BLOCKED", f);
    }
  });

  it("a missing route, a 5xx, no connection or a timeout is UNAVAILABLE", () => {
    for (const [f, status] of [
      ["not-found", 404],
      ["server-error", 503],
      ["unreachable", null],
      ["timeout", null],
      ["rate-limited", 429],
      ["invalid-shape", 200],
    ] as const) {
      const r = capabilityFromCall("trade-detail", "/v2/trades/{tradeId}", failResult(f, { status }));
      assert.equal(r.status, "UNAVAILABLE", f);
      assert.match(r.evidence, new RegExp(f));
    }
  });

  it("a 404 for a subject that may not exist is not evidence against the route", () => {
    const r = capabilityFromCall("trader-by-handle", "/v2/users/{handle}", failResult("not-found", { status: 404 }), { notFoundIsSubject: true });
    assert.equal(r.status, "DOCUMENTED");
    assert.match(r.evidence, /^no provider contact: /);
  });

  it("a call that never reached the vendor is no evidence at all", () => {
    for (const f of ["no-key", "refused-path", "bad-request"] as const) {
      const r = capabilityFromCall("leaderboard", "/r", failResult(f, { status: null, attempts: 0 }));
      assert.equal(r.status, "DOCUMENTED", f);
      assert.match(r.evidence, /^no provider contact: /);
    }
  });

  it("an UNSUPPORTED capability stays UNSUPPORTED whatever a call says", () => {
    const r = capabilityFromCall("trading-account", "/v2/trading/*", okResult({}));
    assert.equal(r.status, "UNSUPPORTED");
  });

  it("evidence never carries a key, even from a careless caller", () => {
    const r = capabilityFromCall("leaderboard", `/v2/leaderboard/24h?key=${KEY}`, failResult("server-error", { status: 500 }));
    assert.ok(!r.evidence.includes(KEY));
  });
});

describe("mergeCapability", () => {
  const ok = capabilityFromCall("balances", "/b", okResult({ rows: [{}] }));
  const down = (at: number) => capabilityFromCall("balances", "/b", failResult("server-error", { status: 503, retrievedAt: at }));
  const noContact = (at: number) => capabilityFromCall("balances", "/b", failResult("no-key", { status: null, attempts: 0, retrievedAt: at }));

  it("a first observation replaces the documented baseline", () => {
    assert.equal(mergeCapability(byName("balances"), ok).status, "AUTHENTICATED_TESTED");
    assert.equal(mergeCapability(undefined, ok), ok);
  });

  it("a later failure is recorded, and keeps the last success in its evidence", () => {
    const m = mergeCapability(ok, down(T0 + 60_000));
    assert.equal(m.status, "UNAVAILABLE");
    assert.equal(m.verifiedAt, T0 + 60_000);
    assert.match(m.evidence, new RegExp(`last success ${new Date(T0).toISOString()}`));
  });

  it("the last success survives a run of failures", () => {
    let m = mergeCapability(ok, down(T0 + 60_000));
    m = mergeCapability(m, down(T0 + 120_000));
    m = mergeCapability(m, capabilityFromCall("balances", "/b", failResult("entitlement", { status: 403, retrievedAt: T0 + 180_000 })));
    assert.equal(m.status, "ENTITLEMENT_BLOCKED");
    assert.match(m.evidence, new RegExp(`last success ${new Date(T0).toISOString()}`));
    assert.equal(m.evidence.match(/last success/g)?.length, 1);
  });

  it("a success after a failure recovers", () => {
    const m = mergeCapability(down(T0), capabilityFromCall("balances", "/b", okResult({ rows: [{}] }, { retrievedAt: T0 + 1 })));
    assert.equal(m.status, "AUTHENTICATED_TESTED");
  });

  it("never silently downgrades to DOCUMENTED", () => {
    assert.equal(mergeCapability(ok, noContact(T0 + 1)), ok);
    const failed = down(T0 + 1);
    assert.equal(mergeCapability(failed, noContact(T0 + 2)), failed);
    const partial = byName("token-activity");
    assert.equal(mergeCapability(partial, noContact(T0)).status, "PARTIAL");
  });

  it("ignores evidence older than what it holds", () => {
    const later = down(T0 + 60_000);
    assert.equal(mergeCapability(later, ok), later);
  });

  it("policy wins: UNSUPPORTED is never overwritten", () => {
    const policy = byName("trading-account");
    assert.equal(mergeCapability(policy, ok), policy);
  });

  it("merges a batch by name, keeping order", () => {
    const out = mergeCapabilities(DOCUMENTED_CAPABILITIES, [{ ...ok, capability: "leaderboard" }]);
    assert.equal(out.length, DOCUMENTED_CAPABILITIES.length);
    assert.equal(out.find((r) => r.capability === "leaderboard")?.status, "AUTHENTICATED_TESTED");
    assert.deepEqual(
      out.map((r) => r.capability),
      DOCUMENTED_CAPABILITIES.map((r) => r.capability),
    );
  });
});

describe("streams and entitlements", () => {
  const account = (onChain: boolean | null, appFeed: boolean | null = true): AccountInfo => ({
    plan: "starter",
    credits: { monthly: 2_500_000, usedThisMonth: 0, prepaid: 0, remaining: 2_500_000 },
    streams: { appFeed, onChain },
    expiresAt: null,
  });

  it("a plan without the on-chain stream blocks ws-trades once probed", () => {
    const [alerts, trades] = capabilityFromAccount(account(false), T0);
    assert.equal(trades!.capability, "ws-trades");
    assert.equal(trades!.status, "ENTITLEMENT_BLOCKED");
    assert.match(trades!.evidence, /plan starter/);
    assert.equal(mergeCapability(byName("ws-trades"), trades!).status, "ENTITLEMENT_BLOCKED");
    assert.equal(alerts!.status, "DOCUMENTED", "an included stream is entitled but untested");
  });

  it("an upgrade lifts the block; an unstated flag changes nothing", () => {
    const blocked = capabilityFromAccount(account(false), T0)[1]!;
    const lifted = mergeCapability(blocked, capabilityFromAccount(account(true), T0 + 1)[1]!);
    assert.equal(lifted.status, "DOCUMENTED");
    assert.match(lifted.evidence, /entitled/);
    assert.equal(mergeCapability(blocked, capabilityFromAccount(account(null), T0 + 2)[1]!), blocked);
  });

  it("a welcome frame tests the stream; a delayed feed is PARTIAL", () => {
    assert.equal(capabilityFromStream("ws-alerts", "/ws/alerts", { welcome: true, delaySeconds: 0 }, T0).status, "AUTHENTICATED_TESTED");
    const delayed = capabilityFromStream("ws-alerts", "/ws/alerts", { welcome: true, delaySeconds: 15 }, T0);
    assert.equal(delayed.status, "PARTIAL");
    assert.match(delayed.evidence, /delayed 15 s/);
  });

  it("a 1008 close or a refused upgrade is ENTITLEMENT_BLOCKED; anything else UNAVAILABLE", () => {
    assert.equal(capabilityFromStream("ws-trades", "/ws/trades", { welcome: false, closeCode: 1008 }, T0).status, "ENTITLEMENT_BLOCKED");
    assert.equal(capabilityFromStream("ws-trades", "/ws/trades", { welcome: false, httpStatus: 403 }, T0).status, "ENTITLEMENT_BLOCKED");
    assert.equal(capabilityFromStream("ws-trades", "/ws/trades", { welcome: false, closeCode: 1006 }, T0).status, "UNAVAILABLE");
  });
});

describe("capabilityReport", () => {
  it("renders one table row per record, with the status and its evidence", () => {
    const md = capabilityReport(DOCUMENTED_CAPABILITIES);
    const lines = md.trimEnd().split("\n");
    assert.equal(lines[0], "| Capability | Route | Status | Evidence | As of |");
    assert.equal(lines.length, DOCUMENTED_CAPABILITIES.length + 2);
    assert.match(md, /\| leaderboard \| `\/v2\/leaderboard\/\{window\}` \| DOCUMENTED \|/);
    assert.match(md, /\| trading-account \| `\/v2\/trading\/\*` \| UNSUPPORTED \|/);
    assert.match(md, /2026-10-04T16:05Z \|$/m);
  });

  it("escapes pipes, flattens newlines and redacts keys in every cell", () => {
    const hostile: CapabilityRecord = {
      capability: "x|y",
      route: "/r`oute",
      status: "UNAVAILABLE",
      evidence: `line one\nline | two ?key=${KEY}`,
      verifiedAt: T0,
    };
    const row = capabilityReport([hostile]).trimEnd().split("\n")[2]!;
    assert.ok(!row.includes(KEY));
    assert.match(row, /x\\\|y/);
    assert.match(row, /line one line \\\| two/);
    assert.ok(!row.includes("r`oute"));
    assert.equal(row.split("\n").length, 1);
  });
});
