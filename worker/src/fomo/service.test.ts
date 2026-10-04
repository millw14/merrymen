/**
 * THE RESEARCH SERVICE, END TO END AGAINST FIXTURES.
 *
 * Every provider answer is served from testdata/ (constructed from the
 * provider's documentation, never captured) through an injected fetch, into a
 * real client and an in-memory sqlite store. Nothing touches the network and
 * the key is a test string that has never been a credential.
 *
 * What is pinned here is the contract surfaces rely on: the permission check
 * comes first and costs nothing, statuses stay distinct, stale copies are
 * labelled with their age, a refused budget makes no call, concurrent
 * refreshes make one call, lookups write no tenant state, and a deep request
 * registers its job before promising anything.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { wrapSqlite, type Db } from "../db";
import { FomoBudget, MemoryAllowance, UsageMeter, type FomoBudgetConfig } from "./budget";
import type { FomoAccess } from "./contract";
import { robinhoodChain, tokenIdentity } from "./identity";
import { createFomoClient } from "./provider";
import { cacheKeyOf, createFomoService, DEEP_JOB_DEADLINE_MS, runPendingJobs, type FomoInvokeContext, type FomoServiceExt } from "./service";
import * as store from "./store";
import type {
  OpportunitiesData,
  RankingsData,
  ResearchCoinData,
  ResearchStatusData,
  ResolveData,
  TokenActivityData,
  TokenThesesData,
  TraderActivityData,
  TraderContextData,
  WatchData,
} from "./tools";
import type { CohortVersion, FollowAssessment, FomoEnvelope, FomoToolName, TraderEvent } from "./types";

type Rec = Record<string, unknown>;

const NOW = Date.UTC(2026, 9, 4, 16, 5);
const KEY = "test_key_not_a_credential_0000";
const PONS = "0x39dbed3a00000000000000000000000000000c0d";
const PONS_KEY = `eip155:4663:${PONS}`;
const CACHE_TOKEN = "0x7fe9950000000000000000000000000000000ca5";
const FU2O = "Fu2oZoGxFtCDp29NKA4A89xcn255khq9xbxG7Mmtpump";
const KALEO = "1f08e6ab-5c73-5443-9225-bfc496cde51f";
const FRANK = "6dcf7c78-2537-522a-8307-3f9970c081be";
const STAR = "254245a7-575a-51be-9bc3-090a924789eb";
const ALERTS_NEWEST = 1788378000000;
const OWNER = "0xowner00000000000000000000000000000000001";

function fixture(name: string): Rec {
  return JSON.parse(readFileSync(new URL(`./testdata/${name}.json`, import.meta.url), "utf8")) as Rec;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-credits-cost": "250", "x-credits-remaining": "100000", ...headers } });

/** The alerts fixture rebased so its newest event is a minute before the clock. */
function alertsAt(now: number): Rec {
  const body = fixture("alerts");
  const shift = now - 60_000 - ALERTS_NEWEST;
  for (const a of body.alerts as Rec[]) {
    if (typeof a.ts === "number") a.ts += shift;
    if (typeof a.execTs === "number") a.execTs += shift;
  }
  body.newestTs = (body.newestTs as number) + shift;
  body.oldestTs = (body.oldestTs as number) + shift;
  return body;
}

type Handler = (url: URL) => Response | Promise<Response>;

interface Harness {
  db: Db;
  raw: DatabaseSync;
  service: FomoServiceExt;
  calls: string[];
  routes: Map<string, Handler>;
  logs: string[];
  clock: { now: number };
  ctx(over?: Partial<FomoInvokeContext>): FomoInvokeContext;
  invoke<T>(tool: FomoToolName, args: Rec, over?: Partial<FomoInvokeContext>): Promise<FomoEnvelope<T>>;
  count(pathPart: string): number;
}

const GENEROUS: FomoBudgetConfig = { sharedDailyCredits: 10_000_000, tenantHourlyCredits: 1_000_000, tenantDailyCredits: 1_000_000, groupHourlyCredits: 1_000_000 };

/** Pathname → fixture. Tests replace entries in `routes` to change one answer. */
function defaultRoutes(clock: { now: number }): Map<string, Handler> {
  const m = new Map<string, Handler>();
  m.set("tokens-search", () => json(fixture("tokens-search")));
  m.set("search", () => json(fixture("search")));
  m.set("balances", () => json(fixture("balances")));
  m.set("positions", () => json(fixture("positions")));
  m.set("swaps", () => json(fixture("swaps")));
  m.set("alerts", () => json(alertsAt(clock.now), 200, { "x-credits-cost": "125" }));
  m.set("thesis-token", () => json(fixture("theses-token"), 200, { "x-credits-cost": "1250" }));
  m.set("thesis-user", () => json({ ...fixture("theses-token"), theses: (fixture("theses-token").theses as Rec[]).filter((t) => t.userId === KALEO) }, 200, { "x-credits-cost": "1250" }));
  m.set("stats", () => json(fixture("token-stats")));
  m.set("leaderboard", (u) => json({ ...fixture("leaderboard-24h"), window: u.pathname.split("/").pop() }));
  m.set("board-trending", () => json(fixture("token-board-trending")));
  m.set("board-graduated", () => json({ ...fixture("token-board-trending"), board: "graduated" }));
  m.set("board-most-held", () => json(fixture("token-board-most-held")));
  m.set("profile", () => json(fixture("trader-profile"), 200, { "x-credits-cost": "2500" }));
  return m;
}

function routeOf(p: string): string {
  if (p === "/v2/tokens/search") return "tokens-search";
  if (p === "/v2/search") return "search";
  if (p === "/v2/alerts") return "alerts";
  if (/^\/v2\/users\/id\//.test(p)) return "profile";
  if (/^\/v2\/users\/[^/]+\/balances$/.test(p)) return "balances";
  if (/^\/v2\/users\/[^/]+\/positions$/.test(p)) return "positions";
  if (/^\/v2\/users\/[^/]+\/swaps$/.test(p)) return "swaps";
  if (/^\/v2\/thesis\/token\//.test(p)) return "thesis-token";
  if (/^\/v2\/thesis\/user\/[^/]+\/token\//.test(p)) return "thesis-user";
  if (/^\/v2\/thesis\/user\//.test(p)) return "thesis-user";
  if (/^\/v2\/token\/[^/]+\/stats$/.test(p)) return "stats";
  if (p === "/v2/leaderboard/tokens/trending") return "board-trending";
  if (p === "/v2/leaderboard/tokens/graduated") return "board-graduated";
  if (p === "/v2/leaderboard/tokens/most-held") return "board-most-held";
  if (/^\/v2\/leaderboard\/[^/]+$/.test(p)) return "leaderboard";
  return "unknown";
}

async function harness(opts: { key?: boolean; access?: FomoAccess; budget?: FomoBudgetConfig; db?: Db; raw?: DatabaseSync; latencyMs?: number } = {}): Promise<Harness> {
  const raw = opts.raw ?? new DatabaseSync(":memory:");
  const db = opts.db ?? wrapSqlite(raw);
  await store.ensureFomoSchema(db, "sqlite");
  const clock = { now: NOW };
  const routes = defaultRoutes(clock);
  const calls: string[] = [];
  const logs: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
    const h = routes.get(routeOf(url.pathname));
    return h ? h(url) : json({ error: "not_found" }, 404);
  }) as typeof fetch;
  const client = opts.key === false ? null : createFomoClient({ apiKey: KEY, fetchImpl, now: () => clock.now, sleep: async () => {}, random: () => 0 });
  const access = opts.access ?? { dataAccess: true, monitoring: true, follow: false };
  const budget = new FomoBudget({ port: new MemoryAllowance(), config: opts.budget ?? GENEROUS, now: () => clock.now });
  const service = createFomoService({ db, dialect: "sqlite", client, access: async () => access, budget, usage: new UsageMeter(), now: () => clock.now, log: (l) => logs.push(l) });
  let n = 0;
  const ctx = (over: Partial<FomoInvokeContext> = {}): FomoInvokeContext => ({
    tenant: OWNER,
    surface: "app-chat",
    audience: "owner",
    conversationKey: "conv-1",
    requestId: `req-${++n}`,
    now: clock.now,
    priority: "interactive",
    ...over,
  });
  return {
    db,
    raw,
    service,
    calls,
    routes,
    logs,
    clock,
    ctx,
    invoke: <T>(tool: FomoToolName, args: Rec, over: Partial<FomoInvokeContext> = {}) => service.invoke(ctx(over), tool, args) as Promise<FomoEnvelope<T>>,
    count: (part: string) => calls.filter((c) => c.includes(part)).length,
  };
}

function rows(raw: DatabaseSync, table: string): number {
  return Number((raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

function cohort(version: number, userIds: string[], now = NOW): CohortVersion {
  return {
    version,
    createdAt: now - 3_600_000,
    target: 150,
    members: userIds.map((u) => ({
      trader: { userId: u, handle: null, displayName: null, verified: null },
      score: 0.6,
      reasons: ["strength:consistency"],
      followable: true,
      evidence: { providerReported: { "pnlUsd.24h": 1000 }, reconstructed: {}, prospective: {} },
      sampleSize: 20,
      includedAt: now - 86_400_000,
    })),
    shortfallReason: userIds.length < 150 ? "test cohort" : null,
    changes: userIds.map((u) => ({ userId: u, change: "added" as const, reason: "test" })),
  };
}

function buyEvent(userId: string, token: string, at: number, key: string, handle = "trader"): TraderEvent {
  const t = tokenIdentity(robinhoodChain(), token)!;
  return {
    eventKey: key,
    identityBasis: "provider-event-id",
    identityAmbiguous: false,
    source: "stream",
    kind: "buy",
    trader: { userId, handle, displayName: null, verified: null },
    token: t,
    tokenLabel: { symbol: "CACHE", name: null },
    tradeId: null,
    swapId: null,
    transferId: null,
    txHash: null,
    fillUsd: null,
    fillUsdBasis: null,
    positionValueUsd: 5000,
    positionRealizedPnlUsdCumulative: null,
    sourceEventAt: at,
    execAt: null,
    observedAt: at + 1000,
    verification: "provider-reported",
    text: null,
    replay: false,
  };
}

const PRIVATE_TABLES = ["fomo_watches", "fomo_assessments", "fomo_publications", "fomo_cohort_versions", "fomo_cohort_members", "fomo_position_deps", "fomo_outcomes", "fomo_funnel", "fomo_jobs", "fomo_tenant_routes"];

// ── Resolution ──────────────────────────────────────────────────────────

describe("fomo_resolve_subject", () => {
  it("resolves an exact ticker on one chain with one search and labels execution honestly", async () => {
    const h = await harness();
    const env = await h.invoke<ResolveData>("fomo_resolve_subject", { query: "PONS" });
    assert.equal(env.status, "ok");
    assert.equal(env.subject?.kind, "token");
    assert.equal(env.subject?.kind === "token" && env.subject.token.key, PONS_KEY);
    assert.equal(env.data?.match, "exact-symbol");
    assert.equal(env.data?.executionAvailability, "unsupported-venue", "a route is never claimed verified by the service");
    assert.equal(env.data?.marketCapUsd, 2_080_000);
    assert.equal(h.count("/v2/tokens/search"), 1);
    assert.equal(env.usage.providerCalls, 1);
    assert.equal(env.usage.creditsCharged, 250);
    assert.equal(env.freshness.servedFrom, "live");
    // The same question again is a cache hit, not a second charge.
    const again = await h.invoke<ResolveData>("fomo_resolve_subject", { query: "PONS" });
    assert.equal(again.status, "ok");
    assert.equal(h.count("/v2/tokens/search"), 1);
    assert.equal(again.usage.cacheHits, 1);
    assert.equal(again.freshness.servedFrom, "cache");
  });

  it("never silently picks a same-ticker coin on another chain: candidates, no choice", async () => {
    const h = await harness();
    h.routes.set("tokens-search", () => {
      const b = fixture("tokens-search");
      (b.tokens as Rec[]).push({ symbol: "PONS", address: FU2O, name: "Pons on Solana", networkId: 1399811149 });
      return json(b);
    });
    const env = await h.invoke<ResolveData>("fomo_resolve_subject", { query: "PONS" });
    assert.equal(env.status, "needs-clarification");
    assert.equal(env.candidates.length, 2);
    assert.deepEqual(env.candidates.map((c) => (c.subject.kind === "token" ? c.subject.token.chain.slug : null)).sort(), ["robinhood", "solana"]);
    assert.equal(env.data, null);
    assert.equal(env.subject, null);
    // A chain hint narrows it to one.
    const rh = await h.invoke<ResolveData>("fomo_resolve_subject", { query: "PONS", chain: "robinhood" });
    assert.equal(rh.status, "ok");
    assert.equal(rh.subject?.kind === "token" && rh.subject.token.key, PONS_KEY);
  });

  it("places an address by the network the provider returned, and asks for the chain when it cannot", async () => {
    const h = await harness();
    const placed = await h.invoke<ResolveData>("fomo_resolve_subject", { query: PONS });
    assert.equal(placed.status, "ok");
    assert.equal(placed.subject?.kind === "token" && placed.subject.token.key, PONS_KEY);
    const unknown = await h.invoke<ResolveData>("fomo_resolve_subject", { query: "0x" + "ab".repeat(20) });
    assert.equal(unknown.status, "not-found");
    assert.match(unknown.message ?? "", /Which chain/);
    // With a chain hint an address needs no provider call at all.
    const before = h.calls.length;
    const hinted = await h.invoke<ResolveData>("fomo_resolve_subject", { query: PONS, chain: "robinhood" });
    assert.equal(hinted.status, "ok");
    assert.equal(h.calls.length, before);
  });

  it("resolves a handle by search once, then from our own record, and flags a former handle", async () => {
    const h = await harness();
    const first = await h.invoke<ResolveData>("fomo_resolve_subject", { query: "@CryptoKaleo" });
    assert.equal(first.status, "ok");
    assert.equal(first.subject?.kind === "trader" && first.subject.trader.userId, KALEO);
    assert.equal(h.count("/v2/search"), 1);
    assert.equal(h.count("/v2/users/"), 0, "no 2,500-credit profile read to learn a user id");
    const second = await h.invoke<ResolveData>("fomo_resolve_subject", { query: "cryptokaleo", kind: "trader" });
    assert.equal(second.status, "ok");
    assert.equal(h.count("/v2/search"), 1, "the persisted identity answers for free");
    // The trader renames; the old handle still resolves, flagged.
    await store.upsertTrader(h.db, { userId: KALEO, handle: "KaleoNew", displayName: null, verified: null }, NOW + 1000);
    const old = await h.invoke<ResolveData>("fomo_resolve_subject", { query: "@CryptoKaleo" });
    assert.equal(old.status, "ok");
    assert.equal(old.data?.formerHandle, true);
    assert.equal(old.subject?.kind === "trader" && old.subject.trader.handle, "KaleoNew");
  });
});

// ── Each tool's happy path ──────────────────────────────────────────────

describe("trader tools", () => {
  it("fomo_get_trader_context: a holdings snapshot with chain rows, a floor when truncated, cohort membership", async () => {
    const h = await harness();
    const env = await h.invoke<TraderContextData>("fomo_get_trader_context", { trader: "CryptoKaleo" });
    assert.equal(env.status, "ok");
    const d = env.data!;
    assert.equal(d.holdings?.rowsTotal, 2);
    assert.equal(d.holdings?.totalValueUsdFloor, 3133);
    assert.equal(d.holdings?.rows[0]?.robinhood, true);
    assert.equal(d.holdings?.rows[1]?.robinhood, false);
    assert.deepEqual(d.holdings?.byChain.map((c) => c.chain).sort(), ["robinhood", "solana"]);
    assert.equal(d.cohort?.member, false);
    assert.equal(h.count("/v2/users/id/"), 0, "no profile read on a standard question");
    assert.ok(env.evidence.some((e) => e.id.startsWith(`fomo:holdings/${KALEO}@`)));
    assert.ok(env.evidence.every((e) => e.sourceUrl === null), "no invented permalinks");

    h.routes.set("balances", () => json({ ...fixture("balances"), truncated: true }));
    const cut = await h.invoke<TraderContextData>("fomo_get_trader_context", { trader: KALEO, focus: "holdings", freshness: "force-refresh" });
    assert.equal(cut.status, "capped");
    assert.equal(cut.data?.holdings?.truncated, true);
    assert.equal(cut.data?.cohort, null, "holdings focus reads holdings only");
    assert.ok(cut.coverage.notes.some((n) => /floor/.test(n)));
  });

  it("fomo_get_trader_activity: positions and feed kept apart, transfers never purchases, window by event time", async () => {
    const h = await harness();
    const env = await h.invoke<TraderActivityData>("fomo_get_trader_activity", { trader: STAR, window: "30d" });
    assert.equal(env.status, "ok");
    const d = env.data!;
    assert.deepEqual(d.sources, ["positions", "feed"]);
    assert.equal(d.counts.sells, 2);
    assert.equal(d.counts.buys, 0);
    assert.ok(d.positions.length >= 1);
    for (const e of d.events) {
      assert.equal(e.fillUsd, null, "no exact fill was matched, so the size is unknown");
      assert.notEqual(e.positionRealizedPnlUsdCumulative, undefined);
    }
    assert.equal(h.count("/swaps"), 0, "fills are read only when a coin is named");

    const kaleo = await h.invoke<TraderActivityData>("fomo_get_trader_activity", { trader: KALEO, window: "24h", side: "buy" });
    assert.equal(kaleo.data?.counts.transfers, 0, "a side=buy question never counts a transfer");
    assert.ok(kaleo.data!.events.every((e) => e.kind === "buy"));
  });
});

describe("token tools", () => {
  it("fomo_get_token_theses: excerpts sanitised and marked, stance counts, capped coverage", async () => {
    const h = await harness();
    const env = await h.invoke<TokenThesesData>("fomo_get_token_theses", { token: "PONS" });
    assert.equal(env.status, "capped", "25 reported, 3 returned: more exist than were read");
    const d = env.data!;
    assert.equal(d.theses.length, 3);
    assert.ok(d.theses.every((t) => t.excerpt.length <= 280 && !/https?:/.test(t.excerpt)));
    assert.equal(d.stance.supporting + d.stance.opposing + d.stance.neutral, 3);
    assert.equal(env.coverage.providerTotal, 25);
    assert.equal(env.coverage.pagesRequested, 1, "quick by default: one 1,250-credit page");
    assert.equal(h.count("/v2/thesis/token/"), 1);
    // Robinhood: no network parameter is sent; rows are checked instead.
    assert.ok(!h.calls.find((c) => c.includes("/v2/thesis/token/"))!.includes("network="));
    assert.ok(env.evidence.some((e) => e.id === "fomo:thesis/th-0001"));

    h.routes.set("thesis-token", () => json({ ...fixture("theses-token"), totalAvailable: 3 }));
    const exact = await h.invoke<TokenThesesData>("fomo_get_token_theses", { token: PONS, chain: "robinhood", freshness: "force-refresh" });
    assert.equal(exact.status, "ok");
  });

  it("fomo_get_token_activity: distinct buyers and sellers, cohort-only actors, provider stats", async () => {
    const h = await harness();
    await store.insertCohortVersion(h.db, cohort(1, [FRANK]));
    const env = await h.invoke<TokenActivityData>("fomo_get_token_activity", { token: "PONS", window: "24h" });
    assert.equal(env.status, "ok");
    const d = env.data!;
    assert.equal(d.distinctBuyers, 1);
    // CryptoKaleo's PONS transfer is in the window and is not a purchase: one buyer, not two.
    assert.ok(d.events.some((e) => e.trader.userId === KALEO && e.kind === "other"));
    assert.ok(d.events.filter((e) => e.trader.userId === KALEO).every((e) => e.kind !== "buy"));
    assert.equal(d.stats?.holders, 1234);
    assert.ok(h.calls.find((c) => c.includes("/stats"))!.includes("networkId=4663"));
    const cohortOnly = await h.invoke<TokenActivityData>("fomo_get_token_activity", { token: "PONS", side: "buy", cohort_only: true });
    assert.equal(cohortOnly.data?.cohort?.buyers.map((b) => b.userId).join(), FRANK);
    assert.ok(cohortOnly.data!.events.every((e) => e.trader.userId === FRANK));
  });

  it("fomo_get_rankings: provider P&L labelled as not skill; token boards keep unknown market caps unknown", async () => {
    const h = await harness();
    const lb = await h.invoke<RankingsData>("fomo_get_rankings", { board: "traders", window: "7d" });
    assert.equal(lb.status, "ok");
    assert.equal(lb.data?.traders.length, 2);
    assert.ok(lb.coverage.notes.some((n) => /not a measure of skill/.test(n)));
    assert.ok(await store.traderById(h.db, FRANK), "leaderboard identities are persisted to the shared trader table");
    const sol = await h.invoke<RankingsData>("fomo_get_rankings", { board: "trending-tokens", chain: "solana" });
    assert.equal(sol.status, "ok");
    assert.equal(sol.data?.tokens.length, 1);
    assert.equal(sol.data?.tokens[0]?.marketCapUsd, null);
    assert.ok(sol.coverage.notes.some((n) => /unknown, not zero/.test(n)));
  });

  it("fomo_find_opportunities: ranked by cohort early signals, not size; unknown caps kept and labelled", async () => {
    const h = await harness();
    await store.insertCohortVersion(h.db, cohort(1, [FRANK, STAR]));
    await store.insertEvents(h.db, [
      buyEvent(FRANK, CACHE_TOKEN, NOW - 30 * 60_000, "ev:cache-1", "frankdegods"),
      buyEvent(STAR, CACHE_TOKEN, NOW - 20 * 60_000, "ev:cache-2", "det"),
    ]);
    const env = await h.invoke<OpportunitiesData>("fomo_find_opportunities", {});
    assert.equal(env.status, "ok");
    const top = env.data!.rows[0]!;
    assert.equal(top.token.address, CACHE_TOKEN);
    assert.equal(top.signals.cohortBuyers, 2);
    assert.equal(top.signals.firstSeenInWindow, true);
    assert.equal(top.routeNote, "route not yet verified by Merrymen");
    // PONS has the biggest market cap and volume, and ranks below the small coin with cohort buyers.
    const pons = env.data!.rows.findIndex((r) => r.token.address === PONS);
    assert.ok(pons > 0);

    const capped = await h.invoke<OpportunitiesData>("fomo_find_opportunities", { max_market_cap_usd: 1_000_000 });
    assert.ok(capped.data!.rows.every((r) => r.marketCapUsd === null || r.marketCapUsd <= 1_000_000));
    assert.ok(capped.data!.rows.some((r) => !r.marketCapKnown), "an unknown market cap is kept");
    assert.ok(capped.data!.filteredByMarketCap >= 1);
  });
});

describe("fomo_research_coin", () => {
  it("builds and stores a dossier revision, then reports change honestly against it", async () => {
    const h = await harness();
    const env = await h.invoke<ResearchCoinData>("fomo_research_coin", { token: "PONS" });
    assert.equal(env.status, "ok");
    assert.equal(env.data?.revision, 1);
    assert.deepEqual(env.dossierRevision, { dossierId: env.data!.dossierId, revision: 1 });
    assert.equal((await store.latestDossier(h.db, PONS_KEY))?.revision, 1);
    assert.equal(env.data?.job, null);

    h.clock.now += 60_000;
    const since = await h.invoke<ResearchCoinData>("fomo_research_coin", { token: PONS, chain: "robinhood", since_revision: 1 });
    assert.equal(since.data?.revision, 1, "unchanged inputs are not a new revision");
    assert.equal(since.data?.changes?.comparable, true);
    assert.equal(since.data?.changes?.noChange, true);

    const unknownBase = await h.invoke<ResearchCoinData>("fomo_research_coin", { token: PONS, chain: "robinhood", since_revision: 9 });
    assert.equal(unknownBase.data?.changes?.comparable, false);
    assert.equal(unknownBase.data?.changes?.noChange, false, "no baseline is never 'no change'");
  });

  it("a deep request registers a bounded job BEFORE promising delivery, and the job runner completes it", async () => {
    const h = await harness();
    const env = await h.invoke<ResearchCoinData>("fomo_research_coin", { token: "PONS", depth: "deep" });
    assert.equal(env.status, "partial");
    const job = env.data?.job;
    assert.ok(job, "a job is promised only once it exists");
    assert.equal(job.deadlineMs, NOW + DEEP_JOB_DEADLINE_MS);
    const stored = await store.getJob(h.db, OWNER, job.id);
    assert.equal(stored?.status, "queued");
    assert.equal(stored?.costAllowanceCredits, 15_000);
    // The same request today is the same job.
    const again = await h.invoke<ResearchCoinData>("fomo_research_coin", { token: "PONS", depth: "deep" });
    assert.equal(again.data?.job?.id, job.id);
    assert.equal(again.data?.job?.created, false);

    const ran = await runPendingJobs(h.service, h.db, { now: () => h.clock.now, limit: 5 });
    assert.deepEqual(ran, { claimed: 1, done: 1, failed: 0 });
    assert.equal((await store.getJob(h.db, OWNER, job.id))?.status, "done");
    assert.equal((await store.jobsAwaitingDelivery(h.db, 10)).length, 1, "delivery is left to the surfaces");
  });

  it("a deep request in a group runs the standard read and registers nothing", async () => {
    const h = await harness();
    const env = await h.invoke<ResearchCoinData>("fomo_research_coin", { token: "PONS", depth: "deep" }, { audience: "group", surface: "telegram-group", groupId: "g1" });
    assert.equal(env.data?.job, null);
    assert.equal(rows(h.raw, "fomo_jobs"), 0);
  });
});

describe("owner tools", () => {
  it("research status and watches are the owner's own, and never another tenant's", async () => {
    const h = await harness();
    const w = await h.invoke<WatchData>("fomo_watch_coin", { token: PONS, chain: "robinhood", days: 3 });
    assert.equal(w.status, "ok");
    assert.equal(w.data?.expiresAtMs, NOW + 3 * 86_400_000);
    const s = await h.invoke<ResearchStatusData>("fomo_get_research_status", { token: PONS, chain: "robinhood" });
    assert.equal(s.status, "ok");
    assert.equal(s.data?.watches.length, 1);
    const other = await h.invoke<ResearchStatusData>("fomo_get_research_status", {}, { tenant: "0xsomeoneelse" });
    assert.equal(other.data?.watches.length, 0);
    const u = await h.invoke<WatchData>("fomo_unwatch_coin", { token: PONS, chain: "robinhood" });
    assert.equal(u.data?.removed, true);
    const again = await h.invoke<WatchData>("fomo_unwatch_coin", { token: PONS, chain: "robinhood" });
    assert.equal(again.status, "empty");
  });
});

// ── Permission, audience, configuration ─────────────────────────────────

describe("the order of checks", () => {
  it("data access off: not-authorized with ZERO provider calls and no cache read", async () => {
    const raw = new DatabaseSync(":memory:");
    const inner = wrapSqlite(raw);
    const seen: string[] = [];
    const spy = (d: Db): Db => ({ prepare: (sql) => (seen.push(sql), d.prepare(sql)), exec: (s) => d.exec(s), tx: (fn) => d.tx((t) => fn(spy(t))) });
    const h = await harness({ access: { dataAccess: false, monitoring: true, follow: true }, db: spy(inner), raw });
    seen.length = 0;
    for (const [tool, args] of [
      ["fomo_get_token_theses", { token: "PONS" }],
      ["fomo_get_trader_context", { trader: "CryptoKaleo" }],
      ["fomo_research_coin", { token: "PONS" }],
      ["fomo_watch_coin", { token: "PONS" }],
    ] as const) {
      const env = await h.invoke(tool, args);
      assert.equal(env.status, "not-authorized", tool);
      assert.equal(env.data, null);
    }
    assert.equal(h.calls.length, 0);
    assert.ok(!seen.some((s) => /fomo_cache/.test(s)), "not even the shared cache is read");
  });

  it("a group may read public data but never the owner's state or a mutation", async () => {
    const h = await harness();
    const g = { audience: "group" as const, surface: "telegram-group" as const, groupId: "-100123" };
    for (const tool of ["fomo_get_research_status", "fomo_watch_coin", "fomo_unwatch_coin"] as const) {
      const env = await h.invoke(tool, { token: "PONS" }, g);
      assert.equal(env.status, "not-authorized", tool);
      assert.equal(env.reason, "owner-only");
    }
    assert.equal(h.calls.length, 0);
    const pub = await h.invoke<TokenThesesData>("fomo_get_token_theses", { token: "PONS" }, g);
    assert.equal(pub.status, "capped");
    // A group charge that cannot name its group cannot be capped, so it is refused.
    const noGroup = await h.invoke("fomo_get_rankings", { board: "traders" }, { audience: "group", surface: "telegram-group" });
    assert.equal(noGroup.status, "budget-limited");
  });

  it("invalid arguments fail before anything is read; a tenant argument is just an unknown key", async () => {
    const h = await harness();
    for (const args of [
      { token: "PONS", tenant: "0xevil" },
      { token: "https://evil.example/x" },
      { token: "../../v2/trading" },
      { token: "PONS\u0000" },
      { token: "PONS", limit: 500 },
    ]) {
      const env = await h.invoke("fomo_get_token_theses", args);
      assert.equal(env.status, "failed");
      assert.equal(env.reason, "invalid-args");
    }
    const unknown = await h.service.invoke(h.ctx(), "fomo_buy_coin" as FomoToolName, {});
    assert.equal(unknown.status, "failed");
    assert.equal(h.calls.length, 0);
  });

  it("no key: unavailable and honest, while the shared cache still answers what it holds", async () => {
    const raw = new DatabaseSync(":memory:");
    const db = wrapSqlite(raw);
    const keyed = await harness({ db, raw });
    assert.equal((await keyed.invoke("fomo_get_token_theses", { token: PONS, chain: "robinhood" })).status, "capped");

    const bare = await harness({ key: false, db, raw });
    assert.equal(bare.service.configured(), false);
    const miss = await bare.invoke("fomo_get_rankings", { board: "traders" });
    assert.equal(miss.status, "unavailable");
    assert.equal(miss.reason, "not-configured");
    assert.match(miss.message ?? "", /not configured on this install/);
    // Fresh cached public data is served as cache.
    const hit = await bare.invoke<TokenThesesData>("fomo_get_token_theses", { token: PONS, chain: "robinhood" });
    assert.equal(hit.status, "capped");
    assert.equal(hit.freshness.servedFrom, "cache");
    // An expired copy is served labelled stale, with the reason.
    bare.clock.now += 2 * 3_600_000;
    const old = await bare.invoke<TokenThesesData>("fomo_get_token_theses", { token: PONS, chain: "robinhood" });
    assert.equal(old.status, "stale");
    assert.equal(old.freshness.servedFrom, "stale-cache");
    assert.equal(old.freshness.cacheAgeMs, 2 * 3_600_000);
    assert.equal(old.reason, "not-configured");
    const health = await bare.service.health(bare.clock.now);
    assert.equal(health.state, "not-configured");
  });
});

// ── Freshness and distinct statuses ─────────────────────────────────────

describe("statuses stay distinct", () => {
  it("force-refresh goes upstream; a failure is reported with the stale copy's age", async () => {
    const h = await harness();
    assert.equal((await h.invoke("fomo_get_token_theses", { token: PONS, chain: "robinhood" })).freshness.servedFrom, "live");
    h.clock.now += 10 * 60_000;
    h.routes.set("thesis-token", () => json({ error: "upstream" }, 500));
    const before = h.count("/v2/thesis/token/");
    const env = await h.invoke<TokenThesesData>("fomo_get_token_theses", { token: PONS, chain: "robinhood", freshness: "force-refresh" });
    assert.ok(h.count("/v2/thesis/token/") > before, "force-refresh attempted upstream even with a fresh copy");
    assert.equal(env.status, "stale");
    assert.equal(env.freshness.servedFrom, "stale-cache");
    assert.equal(env.freshness.cacheAgeMs, 10 * 60_000);
    assert.equal(env.freshness.lastRefreshOutcome, "failed");
    assert.equal(env.reason, "server-error");
    assert.equal(env.data?.theses.length, 3);
  });

  it("empty, failed, unavailable, partial, capped and budget-limited are different answers", async () => {
    const h = await harness();
    h.routes.set("thesis-token", () => json({ ...fixture("theses-token"), theses: [], totalAvailable: 0 }));
    const empty = await h.invoke("fomo_get_token_theses", { token: PONS, chain: "robinhood" });
    assert.equal(empty.status, "empty");

    h.routes.set("leaderboard", () => new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } }));
    const failed = await h.invoke("fomo_get_rankings", { board: "traders" });
    assert.equal(failed.status, "failed");
    assert.equal(failed.data, null);

    h.routes.set("board-trending", () => json({ error: "down" }, 503));
    const down = await h.invoke("fomo_get_rankings", { board: "trending-tokens" });
    assert.equal(down.status, "unavailable");

    h.routes.set("stats", () => json({ error: "down" }, 503));
    const partial = await h.invoke<TokenActivityData>("fomo_get_token_activity", { token: PONS, chain: "robinhood" });
    assert.equal(partial.status, "partial");
    assert.ok(partial.coverage.missing.includes("token-stats"));
    assert.ok((partial.data?.distinctBuyers ?? 0) >= 1, "the rest of a partial answer is real");

    const tight = await harness({ budget: { sharedDailyCredits: 100_000, tenantHourlyCredits: 100, tenantDailyCredits: 100, groupHourlyCredits: 100 } });
    const limited = await tight.invoke("fomo_get_token_theses", { token: PONS, chain: "robinhood" });
    assert.equal(limited.status, "budget-limited");
    assert.match(limited.reason ?? "", /^budget-/);
    assert.equal(tight.calls.length, 0, "a refused budget makes no call");
  });

  it("research that cannot refresh shows the stored revision as stale, with its age, never as fresh", async () => {
    const h = await harness();
    const first = await h.invoke<ResearchCoinData>("fomo_research_coin", { token: PONS, chain: "robinhood" });
    assert.equal(first.status, "ok");
    h.clock.now += 45 * 60_000;
    h.routes.set("thesis-token", () => json({ error: "upstream" }, 500));
    const env = await h.invoke<ResearchCoinData>("fomo_research_coin", { token: PONS, chain: "robinhood", freshness: "force-refresh" });
    assert.equal(env.status, "stale");
    assert.equal(env.data?.revision, 1);
    assert.equal(env.freshness.servedFrom, "stale-cache");
    assert.equal(env.freshness.lastRefreshOutcome, "failed");
    assert.ok((env.freshness.cacheAgeMs ?? 0) >= 45 * 60_000);
    assert.ok(env.coverage.notes.some((n) => /last stored research/.test(n)));
  });

  it("an open coverage gap in the window makes activity partial, with a note", async () => {
    const h = await harness();
    await store.recordGap(h.db, "alerts", NOW - 3_600_000, NOW - 1_800_000, "stream-backpressure", NOW);
    const env = await h.invoke<TokenActivityData>("fomo_get_token_activity", { token: PONS, chain: "robinhood" });
    assert.equal(env.status, "partial");
    assert.ok(env.coverage.notes.some((n) => /gap/.test(n)));
  });
});

// ── Isolation and side effects ──────────────────────────────────────────

describe("lookups have no side effects on tenant state", () => {
  it("a trader outside the cohort is researchable and the cohort is unchanged", async () => {
    const h = await harness();
    await store.insertCohortVersion(h.db, cohort(1, [FRANK]));
    const env = await h.invoke<TraderContextData>("fomo_get_trader_context", { trader: "CryptoKaleo" });
    assert.equal(env.status, "ok");
    assert.equal(env.data?.cohort?.member, false);
    const c = await store.latestCohort(h.db);
    assert.equal(c?.cohort.version, 1);
    assert.deepEqual(c?.cohort.members.map((m) => m.trader.userId), [FRANK]);
  });

  it("a never-seen coin with an empty watchlist works", async () => {
    const h = await harness();
    assert.equal((await store.activeWatches(h.db, OWNER, NOW)).length, 0);
    const env = await h.invoke<ResearchCoinData>("fomo_research_coin", { token: PONS, chain: "robinhood" });
    assert.equal(env.status, "ok");
    assert.equal((await store.activeWatches(h.db, OWNER, NOW)).length, 0);
  });

  it("many reads create no watch, assessment, publication, job, dependency, funnel row or cohort change", async () => {
    const h = await harness();
    const reads: [FomoToolName, Rec][] = [
      ["fomo_resolve_subject", { query: "PONS" }],
      ["fomo_get_trader_context", { trader: "CryptoKaleo" }],
      ["fomo_get_trader_activity", { trader: STAR, window: "30d", token: "PONS" }],
      ["fomo_get_token_theses", { token: "PONS" }],
      ["fomo_get_token_activity", { token: "PONS", cohort_only: true }],
      ["fomo_get_token_activity", {}],
      ["fomo_get_rankings", { board: "traders" }],
      ["fomo_get_rankings", { board: "most-held-tokens" }],
      ["fomo_find_opportunities", {}],
      ["fomo_research_coin", { token: "PONS", focus: "words-vs-actions" }],
      ["fomo_get_research_status", {}],
    ];
    for (const [tool, args] of reads) {
      const env = await h.invoke(tool, args);
      assert.ok(!["failed", "not-authorized"].includes(env.status), `${tool}: ${env.status} ${env.reason}`);
    }
    for (const t of PRIVATE_TABLES) assert.equal(rows(h.raw, t), 0, `${t} was written by a lookup`);
    assert.equal(rows(h.raw, "fomo_requests"), reads.length, "the audit log is the only tenant row a lookup writes");
  });
});

describe("single flight", () => {
  it("concurrent identical refreshes make ONE provider call per route", async () => {
    const h = await harness({ latencyMs: 15 });
    const token = tokenIdentity(robinhoodChain(), PONS)!;
    const results = await Promise.all(
      [0, 1, 2].map(() => h.service.refreshDossier(token, { symbol: "PONS", name: null }, { priority: "discovery", depth: "quick", now: NOW })),
    );
    assert.equal(h.count("/v2/thesis/token/"), 1);
    assert.equal(h.count("/v2/alerts"), 1);
    assert.equal(h.count("/stats"), 1);
    assert.ok(results.every((r) => r.dossier !== null));
    assert.equal((await store.latestDossier(h.db, PONS_KEY))?.revision, 1, "one revision for one set of inputs");

    const envs = await Promise.all([OWNER, "0xother", "0xthird"].map((t) => h.invoke("fomo_get_rankings", { board: "traders", window: "30d" }, { tenant: t })));
    assert.ok(envs.every((e) => e.status === "ok"));
    assert.equal(h.count("/v2/leaderboard/30d"), 1, "three owners, one upstream read");
    assert.equal(envs.reduce((n, e) => n + e.usage.providerCalls, 0), 1, "only the caller that reached upstream is charged");
  });
});

describe("refreshDossier (background)", () => {
  it("a refused budget leaves the previous dossier and reports budget-limited", async () => {
    const raw = new DatabaseSync(":memory:");
    const db = wrapSqlite(raw);
    const h = await harness({ db, raw });
    const token = tokenIdentity(robinhoodChain(), PONS)!;
    const first = await h.service.refreshDossier(token, { symbol: "PONS", name: null }, { priority: "discovery", depth: "quick", now: NOW });
    assert.equal(first.status, "ok");
    assert.equal(first.dossier?.revision, 1);
    const tight = await harness({ db, raw, budget: { sharedDailyCredits: 10, tenantHourlyCredits: 10, tenantDailyCredits: 10, groupHourlyCredits: 10 } });
    tight.clock.now = NOW + 3 * 3_600_000;
    const r = await tight.service.refreshDossier(token, { symbol: "PONS", name: null }, { priority: "discovery", depth: "quick", now: tight.clock.now });
    assert.equal(r.status, "budget-limited");
    assert.equal(r.dossier?.revision, 1);
    assert.equal(r.changed, false);
    assert.equal(tight.calls.length, 0);
  });
});

describe("reports, memory, health", () => {
  it("refuses an assessment that names another tenant; keeps held tokens per tenant", async () => {
    const h = await harness();
    const token = tokenIdentity(robinhoodChain(), PONS)!;
    const a: FollowAssessment = {
      id: "as-1",
      tenant: "0xsomeoneelse",
      token,
      label: { symbol: "PONS", name: null },
      triggerEventKeys: [],
      state: "WATCH",
      reasonCodes: ["test"],
      supporting: [],
      opposing: [],
      signalDelayMs: null,
      researchDelayMs: null,
      priceMovePct: null,
      decisionQuote: null,
      setupExpiresAt: null,
      horizon: null,
      invalidation: [],
      sizeCeilingUsdg6: null,
      dossierRevision: null,
      executionAvailability: "unsupported-venue",
      createdAt: NOW,
    };
    await h.service.report(OWNER, { kind: "assessment", assessment: a }, NOW);
    assert.equal(rows(h.raw, "fomo_assessments"), 0);
    await h.service.report(OWNER, { kind: "assessment", assessment: { ...a, tenant: OWNER.toUpperCase().replace("0X", "0x") } }, NOW);
    assert.equal(rows(h.raw, "fomo_assessments"), 1);
    await h.service.report(OWNER, { kind: "held-tokens", tokenKeys: [PONS_KEY, "not-a-key"], atMs: NOW }, NOW);
    await h.service.report("0xother", { kind: "held-tokens", tokenKeys: [PONS_KEY], atMs: NOW }, NOW);
    assert.deepEqual(h.service.heldTokensSnapshot(NOW).get(PONS_KEY), ["0xother", OWNER]);
    assert.equal(h.service.heldTokensSnapshot(NOW).size, 1);
  });

  it("subject memory is tenant-scoped", async () => {
    const h = await harness();
    await h.service.memorySet(OWNER, "c1", JSON.stringify({ a: 1 }), NOW);
    assert.equal(await h.service.memoryGet(OWNER, "c1"), JSON.stringify({ a: 1 }));
    assert.equal(await h.service.memoryGet("0xother", "c1"), null);
    await h.service.memoryClear(OWNER, "c1");
    assert.equal(await h.service.memoryGet(OWNER, "c1"), null);
  });

  it("health says receiving fresh data after a successful read, and records capabilities and usage", async () => {
    const h = await harness();
    assert.equal((await h.service.health(NOW)).state, "research-only");
    await h.invoke("fomo_get_rankings", { board: "traders" });
    const health = await h.service.health(NOW);
    assert.equal(health.state, "receiving-fresh-data");
    assert.equal(health.creditsRemaining, 100_000);
    const caps = await store.listCapabilities(h.db);
    assert.equal(caps.find((c) => c.capability === "leaderboard")?.status, "AUTHENTICATED_TESTED");
    const usage = await store.usageForDay(h.db, store.usageDay(NOW));
    assert.equal(usage.find((u) => u.bucket === "leaderboard")?.credits, 250);
    // The cache key is public: no tenant in it.
    assert.ok(await store.cacheGet(h.db, cacheKeyOf("leaderboard", { window: "24h", limit: 100 })));
  });
});
