/**
 * THE RUNTIME: schema first, key as an argument, budget counters in the shared
 * store, a plan-derived daily pool with conservative per-owner caps.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { wrapSqlite } from "../db";
import { budgetConfigFor, createFomoRuntime, FREE_PLAN_CREDITS_PER_MONTH, storeAllowancePort } from "./runtime";
import * as store from "./store";

const NOW = Date.UTC(2026, 9, 4, 16, 5);
const access = async () => ({ dataAccess: true, monitoring: false, follow: false });

function db() {
  const raw = new DatabaseSync(":memory:");
  return { raw, db: wrapSqlite(raw) };
}

const ctx = (requestId: string) => ({
  tenant: "0xowner",
  surface: "app-chat" as const,
  audience: "owner" as const,
  conversationKey: null,
  requestId,
  now: NOW,
  priority: "interactive" as const,
});

describe("createFomoRuntime", () => {
  it("without a key: schema ensured, no client, and every upstream read says 'not configured'", async () => {
    const { raw, db: d } = db();
    const rt = await createFomoRuntime({ db: d, dialect: "sqlite", apiKey: null, access, now: () => NOW });
    assert.equal(rt.client, null);
    assert.equal(rt.service.configured(), false);
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fomo_%'").all() as { name: string }[]).map((r) => r.name);
    for (const t of store.FOMO_TABLES) assert.ok(tables.includes(t), `${t} missing`);
    const env = await rt.service.invoke(ctx("r1"), "fomo_get_rankings", { board: "traders" });
    assert.equal(env.status, "unavailable");
    assert.equal(env.reason, "not-configured");
    assert.equal((await rt.service.health(NOW)).state, "not-configured");
    // A blank key is no key.
    const blank = await createFomoRuntime({ db: d, dialect: "sqlite", apiKey: "   ", access, now: () => NOW });
    assert.equal(blank.client, null);
  });

  it("tails need the hosted live feed: off by default on sqlite (self-hosted), on when the host says so", async () => {
    const { db: d } = db();
    const self = await createFomoRuntime({ db: d, dialect: "sqlite", apiKey: null, access, now: () => NOW });
    const refused = await self.service.invoke(ctx("t1"), "fomo_tail_trader", { trader: "3f2a9c1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b" });
    assert.equal(refused.reason, "tail-needs-live-feed");
    const switchedOff = await createFomoRuntime({ db: d, dialect: "sqlite", apiKey: null, access, now: () => NOW, liveFeed: true, tailsEnabled: false });
    assert.equal((await switchedOff.service.invoke(ctx("t0"), "fomo_tail_trader", { trader: "3f2a9c1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b" })).reason, "tails-disabled");
    assert.equal((await store.activeTails(d, "0xowner", NOW)).length, 0);
    const hosted = await createFomoRuntime({ db: d, dialect: "sqlite", apiKey: null, access, now: () => NOW, liveFeed: true });
    const stored = await hosted.service.invoke(ctx("t2"), "fomo_tail_trader", { trader: "3f2a9c1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b" });
    assert.equal(stored.status, "ok", "a user id needs no provider: stored even without a key");
    assert.equal((await store.activeTails(d, "0xowner", NOW)).length, 1);
  });

  it("with a key: reads go through the injected fetch, and credits are charged in the shared store", async () => {
    const { db: d } = db();
    const sent: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(String(input));
      assert.equal(init?.method, "GET");
      const body = JSON.parse(readFileSync(new URL("./testdata/leaderboard-24h.json", import.meta.url), "utf8"));
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", "x-credits-cost": "250" } });
    }) as typeof fetch;
    const rt = await createFomoRuntime({ db: d, dialect: "sqlite", apiKey: "test_key_not_a_credential_0000", access, now: () => NOW, fetchImpl });
    assert.ok(rt.client);
    assert.equal(rt.service.configured(), true);
    const env = await rt.service.invoke(ctx("r1"), "fomo_get_rankings", { board: "traders", window: "24h" });
    assert.equal(env.status, "ok");
    assert.equal(sent.length, 1);
    assert.ok(!sent[0]!.includes("test_key"), "the key never travels in a URL");
    const day = new Date(NOW).toISOString().slice(0, 10);
    assert.equal(await store.readAllowance(d, `fomo:credits:pool:all:d:${day}`), 250, "the charge lives in the shared counters");
    const usage = await store.usageForDay(d, day);
    assert.equal(usage.find((u) => u.bucket === "leaderboard")?.calls, 1);
    assert.deepEqual(await rt.runJobs(NOW), { claimed: 0, done: 0, failed: 0, cancelled: 0 });
  });

  it("background shared research draws on the pool, not on one owner's caps", async () => {
    const { db: d } = db();
    const fx = (n: string) => JSON.parse(readFileSync(new URL(`./testdata/${n}.json`, import.meta.url), "utf8"));
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const p = new URL(String(input)).pathname;
      const body = p.startsWith("/v2/thesis/token/") ? fx("theses-token") : p === "/v2/alerts" ? fx("alerts") : /\/stats$/.test(p) ? fx("token-stats") : fx("leaderboard-24h");
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const rt = await createFomoRuntime({
      db: d,
      dialect: "sqlite",
      apiKey: "test_key_not_a_credential_0000",
      access,
      now: () => NOW,
      fetchImpl,
      budget: { tenantHourlyCredits: 100, tenantDailyCredits: 100 },
    });
    const owner = await rt.service.invoke(ctx("r1"), "fomo_get_rankings", { board: "traders" });
    assert.equal(owner.status, "budget-limited", "the owner's own cap holds");
    const token = { chain: { namespace: "eip155" as const, networkId: 4663, slug: "robinhood" }, address: "0x39dbed3a00000000000000000000000000000c0d", key: "eip155:4663:0x39dbed3a00000000000000000000000000000c0d" };
    const r = await rt.service.refreshDossier(token, { symbol: "PONS", name: null }, { priority: "discovery", depth: "quick", now: NOW });
    assert.notEqual(r.status, "budget-limited");
    assert.equal(r.dossier?.revision, 1);
  });

  it("runJobs cancels a deep job whose owner switched data access off after asking, before any read (C24)", async () => {
    const { db: d } = db();
    const fx = (n: string) => JSON.parse(readFileSync(new URL(`./testdata/${n}.json`, import.meta.url), "utf8"));
    let calls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls++;
      const p = new URL(String(input)).pathname;
      const body = p.startsWith("/v2/thesis/token/") ? fx("theses-token") : p === "/v2/alerts" ? fx("alerts") : /\/stats$/.test(p) ? fx("token-stats") : fx("leaderboard-24h");
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const live = { dataAccess: true, monitoring: false, follow: false };
    const rt = await createFomoRuntime({ db: d, dialect: "sqlite", apiKey: "test_key_not_a_credential_0000", access: async () => live, now: () => NOW, fetchImpl });
    const env = await rt.service.invoke(ctx("r1"), "fomo_research_coin", { token: "0x39dbed3a00000000000000000000000000000c0d", chain: "robinhood", depth: "deep" });
    assert.ok((env.data as { job: unknown } | null)?.job, "the deep job was registered while access was on");
    live.dataAccess = false;
    const before = calls;
    assert.deepEqual(await rt.runJobs(NOW), { claimed: 1, done: 0, failed: 0, cancelled: 1 });
    assert.equal(calls, before, "no provider call after the owner switched Fomo off");
  });

  it("derives the daily pool from the plan with a safety reserve, and caps owners and groups under it", () => {
    const free = budgetConfigFor(FREE_PLAN_CREDITS_PER_MONTH);
    assert.equal(free.sharedDailyCredits, Math.floor((250_000 * 0.8) / 31));
    assert.ok(free.tenantHourlyCredits <= free.sharedDailyCredits);
    assert.ok(free.tenantDailyCredits <= free.sharedDailyCredits);
    assert.ok(free.groupHourlyCredits <= free.tenantHourlyCredits);
    const growth = budgetConfigFor(37_500_000);
    assert.equal(growth.tenantDailyCredits, 20_000);
    // An unusable plan figure spends nothing rather than guessing.
    assert.equal(budgetConfigFor(Number.NaN).sharedDailyCredits, 0);
    // Overrides are clamped under the pool.
    assert.equal(budgetConfigFor(250_000, { tenantDailyCredits: 10_000_000 }).tenantDailyCredits, free.sharedDailyCredits);
  });
});

describe("storeAllowancePort", () => {
  it("takes atomically within the limit, refuses past it, and gives back never below zero", async () => {
    const { db: d } = db();
    await store.ensureFomoSchema(d, "sqlite");
    const port = storeAllowancePort(d, () => NOW);
    assert.equal(await port.take("k", 600, 1000, NOW), true);
    assert.equal(await port.take("k", 500, 1000, NOW), false);
    assert.equal(await port.take("k", 400, 1000, NOW), true);
    assert.equal(await store.readAllowance(d, "k"), 1000);
    await port.give("k", 250);
    assert.equal(await store.readAllowance(d, "k"), 750);
    await port.give("k", 5_000);
    assert.equal(await store.readAllowance(d, "k"), 0);
  });
});

describe("boundaries", () => {
  it("none of the service-layer modules reads the environment", () => {
    for (const f of ["runtime.ts", "service.ts", "tools.ts", "render.ts", "chat.ts"]) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      assert.ok(!/process\.env/.test(src), `${f} reads the environment`);
      assert.ok(!/api\.fomoapi\.io/.test(src), `${f} names the provider host`);
      assert.ok(!/from "\.\.\/(executor|policy|wall|paymaster|grant-store|session-account|index)"/.test(src), `${f} reaches execution`);
    }
  });
});
