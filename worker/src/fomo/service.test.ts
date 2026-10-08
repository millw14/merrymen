/**
 * THE RESEARCH SERVICE, END TO END AGAINST FIXTURES.
 *
 * Every provider answer is served from testdata/ (constructed from the
 * provider's documentation, or mirroring the field structure of a live answer
 * with fabricated values; never captured) through an injected fetch, into a
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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { wrapSqlite, type Db } from "../db";
import { homePaths } from "../home";
import { BROKER_LIMITS } from "./broker";
import { FomoBudget, MemoryAllowance, UsageMeter, type FomoBudgetConfig } from "./budget";
import type { FomoAccess } from "./contract";
import { robinhoodChain, tokenIdentity } from "./identity";
import { createFomoClient, expectedCredits } from "./provider";
import {
  BACKGROUND_RESEARCH_CAP,
  cacheKeyOf,
  READ_DEADLINE_MS,
  createFomoService,
  DEEP_JOB_DEADLINE_MS,
  feedPageCutShort,
  runPendingJobs,
  SHARED_RESEARCH_TENANT,
  STREAM_COVERAGE_MARK_KEY,
  type FomoInvokeContext,
  type FomoServiceExt,
} from "./service";
import { renderEnvelope } from "./render";
import * as store from "./store";
import type {
  ExtendTailData,
  OpportunitiesData,
  RankingsData,
  ResearchCoinData,
  ResearchStatusData,
  ResolveData,
  TailData,
  TokenActivityData,
  TokenThesesData,
  TraderActivityData,
  TraderContextData,
  UntailData,
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

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

interface Harness {
  db: Db;
  raw: DatabaseSync;
  service: FomoServiceExt;
  budget: FomoBudget;
  backgroundBudget: FomoBudget | null;
  /** The allowance counters behind both budgets. */
  port: MemoryAllowance;
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

async function harness(
  opts: { key?: boolean; access?: FomoAccess; budget?: FomoBudgetConfig; background?: FomoBudgetConfig; db?: Db; raw?: DatabaseSync; latencyMs?: number; liveFeed?: boolean; tailsEnabled?: boolean } = {},
): Promise<Harness> {
  const raw = opts.raw ?? new DatabaseSync(":memory:");
  const db = opts.db ?? wrapSqlite(raw);
  await store.ensureFomoSchema(db, "sqlite");
  const clock = { now: NOW };
  const routes = defaultRoutes(clock);
  const calls: string[] = [];
  const logs: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
    const h = routes.get(routeOf(url.pathname));
    return h ? h(url, init) : json({ error: "not_found" }, 404);
  }) as typeof fetch;
  const client = opts.key === false ? null : createFomoClient({ apiKey: KEY, fetchImpl, now: () => clock.now, sleep: async () => {}, random: () => 0 });
  const access = opts.access ?? { dataAccess: true, monitoring: true, follow: false };
  const port = new MemoryAllowance();
  const budget = new FomoBudget({ port, config: opts.budget ?? GENEROUS, now: () => clock.now });
  // The runtime's shape: the same counters, owner caps lifted to the pool.
  const backgroundBudget = opts.background ? new FomoBudget({ port, config: opts.background, now: () => clock.now }) : null;
  const service = createFomoService({
    db,
    dialect: "sqlite",
    client,
    access: async () => access,
    budget,
    ...(backgroundBudget ? { backgroundBudget } : {}),
    usage: new UsageMeter(),
    now: () => clock.now,
    log: (l) => logs.push(l),
    ...(opts.liveFeed !== undefined ? { liveFeed: opts.liveFeed } : {}),
    ...(opts.tailsEnabled !== undefined ? { tailsEnabled: opts.tailsEnabled } : {}),
  });
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
    budget,
    backgroundBudget,
    port,
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

describe("a token board narrowed to one chain says what the filter did (Milla, 2026-10-07)", () => {
  /** A Solana row at `rank`, placeable. */
  const solRow = (rank: number) => ({ rank, network: "solana", token: { symbol: `SOL${rank}`, name: `Sol ${rank}`, address: `So1${"abcdefghijkmnopqrstuvwxyz".slice(0, 26)}${String(rank).padStart(3, "1").replace(/0/g, "z")}ABCDEFGHJKLMNp`.slice(0, 43) }, marketCapUsd: 100_000 * rank });

  it("a chain read reports the board's rows, the matches and the unplaced, from the one board read", async () => {
    const h = await harness();
    const hood = await h.invoke<RankingsData>("fomo_get_rankings", { board: "trending-tokens", chain: "robinhood" });
    assert.equal(hood.status, "ok");
    assert.equal(hood.data?.chain, "robinhood");
    assert.equal(hood.data?.boardRows, 3);
    assert.equal(hood.data?.matched, 2);
    assert.equal(hood.data?.unplaced, 0);
    assert.equal(hood.data?.robinhood, undefined, "a chain was asked: no Robinhood aside");
    assert.deepEqual(hood.data?.tokens.map((t) => t.rank), [1, 4], "rows keep their board rank");
    // The same board for every chain: the second read is the cached copy.
    const before = h.count("/v2/leaderboard/tokens/trending");
    const sol = await h.invoke<RankingsData>("fomo_get_rankings", { board: "trending-tokens", chain: "solana" });
    assert.equal(sol.data?.matched, 1);
    assert.equal(h.count("/v2/leaderboard/tokens/trending"), before, "a chain filter is never a second paid read");
  });

  it("every chain: the board's Robinhood Chain rows ride along, the top three by rank", async () => {
    const h = await harness();
    const all = await h.invoke<RankingsData>("fomo_get_rankings", { board: "trending-tokens" });
    assert.equal(all.data?.chain, undefined);
    assert.equal(all.data?.boardRows, 3);
    assert.equal(all.data?.robinhood?.rows, 2);
    assert.deepEqual(all.data?.robinhood?.top.map((t) => t.label.symbol), ["PONS", "CACHE"]);
  });

  it("an all-Solana board asked for Robinhood Chain is empty, with the board's size known; unplaced rows are counted", async () => {
    const h = await harness();
    h.routes.set("board-trending", () => json({ board: "trending", count: 31, tokens: [...Array.from({ length: 30 }, (_, i) => solRow(i + 1)), { rank: 31, token: { symbol: "LOST", name: "Lost" } }] }));
    const hood = await h.invoke<RankingsData>("fomo_get_rankings", { board: "trending-tokens", chain: "robinhood" });
    assert.equal(hood.status, "empty");
    assert.equal(hood.data?.boardRows, 30);
    assert.equal(hood.data?.matched, 0);
    assert.equal(hood.data?.unplaced, 1);
    const all = await h.invoke<RankingsData>("fomo_get_rankings", { board: "trending-tokens" });
    assert.deepEqual(all.data?.robinhood, { rows: 0, top: [] });
  });

  it("a chain asked of the trader board is kept, so the answer can say it covers every chain", async () => {
    const h = await harness();
    const lb = await h.invoke<RankingsData>("fomo_get_rankings", { board: "traders", chain: "robinhood" });
    assert.equal(lb.status, "ok");
    assert.equal(lb.data?.chain, "robinhood");
    assert.equal(lb.data?.traders.length, 2, "nothing narrowed");
  });

  it("the whole feed's top coins are counts of distinct wallets, never who they were", async () => {
    const h = await harness();
    const buys = await h.invoke<TokenActivityData>("fomo_get_token_activity", { side: "buy" });
    const top = buys.data?.topTokens ?? [];
    assert.ok(top.length >= 1 && top.length <= 3, JSON.stringify(top));
    for (const c of top) {
      assert.deepEqual(Object.keys(c).sort(), ["buyers", "label", "sellers", "token"]);
      assert.ok(c.buyers >= 1);
    }
    for (let i = 1; i < top.length; i++) assert.ok(top[i - 1]!.buyers >= top[i]!.buyers, "most buyers first");
    const one = await h.invoke<TokenActivityData>("fomo_get_token_activity", { token: "PONS", side: "buy" });
    assert.equal(one.data?.topTokens, undefined, "one coin's read has no crowd aside");
  });
});

describe("a call is charged for every attempt it sent", () => {
  it("a 5xx retried past is charged to every budget, not only the answer that ended the call", async () => {
    const h = await harness();
    let n = 0;
    h.routes.set("thesis-token", () => {
      n++;
      return n === 1
        ? json({ error: "FOMO did not answer in time", retryable: true }, 503, { "x-credits-cost": "100" })
        : json(fixture("theses-token"), 200, { "x-credits-cost": "1250" });
    });
    const env = await h.invoke<TokenThesesData>("fomo_get_token_theses", { token: PONS, chain: "robinhood", freshness: "force-refresh" });
    assert.ok(env.status === "ok" || env.status === "capped", env.status);
    assert.equal(n, 2);
    const charged = h.port.keys().map((k) => h.port.used(k));
    assert.ok(charged.length > 0);
    assert.ok(charged.every((u) => u === 1350), `every counter holds both attempts: ${JSON.stringify(charged)}`);
  });

  it("an attempt that never said what it cost is charged at the estimate", async () => {
    const h = await harness();
    let n = 0;
    h.routes.set("thesis-token", () => {
      n++;
      return n === 1 ? json({ error: "upstream" }, 502) : json(fixture("theses-token"), 200, { "x-credits-cost": "1250" });
    });
    const env = await h.invoke<TokenThesesData>("fomo_get_token_theses", { token: PONS, chain: "robinhood", freshness: "force-refresh" });
    assert.ok(env.status === "ok" || env.status === "capped", env.status);
    assert.equal(n, 2);
    const charged = h.port.keys().map((k) => h.port.used(k));
    // The unpriced 502 is charged at this read's reservation (a page-sized estimate), never at nothing.
    assert.ok(charged.length > 0 && charged.every((u) => u === charged[0]), JSON.stringify(charged));
    assert.ok(charged[0]! > 1250 && charged[0]! <= 1250 + expectedCredits("thesesByToken"), `the unpriced 502 at the estimate: ${JSON.stringify(charged)}`);
  });
});

describe("a holding's P&L on the trader board has no window", () => {
  it("the 7d board shows each trader's 7d P&L and never a top holding's unwindowed P&L as if it were 7d", async () => {
    const h = await harness();
    h.routes.set("leaderboard", () => json(fixture("live-shape-leaderboard-7d")));
    const env = await h.invoke<RankingsData>("fomo_get_rankings", { board: "traders", window: "7d" });
    assert.equal(env.status, "ok");
    assert.equal(env.data?.traders[0]?.pnlUsd, 12345.5, "the row's own window P&L");
    const payload = JSON.stringify(env.data);
    assert.ok(!payload.includes("500.25") && !/unwindowed|topTokens/.test(payload), "no per-token P&L reaches the answer");
    const text = renderEnvelope(env, { audience: "owner", maxChars: 4000, now: h.clock.now });
    assert.ok(!/500\.25|\$500\b/.test(text), text);
    // What the cache keeps is named for what it is.
    const cached = await store.cacheGet(h.db, cacheKeyOf("leaderboard", { window: "7d", limit: 100 }));
    const holdings = ((cached?.payload as Rec | undefined)?.rows as Rec[] | undefined)?.[0]?.topTokens as Rec[] | undefined;
    assert.ok(holdings && holdings.length > 0, "the board was cached with its holdings");
    for (const t of holdings) assert.ok(!("pnlUsd" in t) && "unwindowedPnlUsd" in t, JSON.stringify(t));
  });
});

describe("event order is the provider's order", () => {
  it("a trader's newest event, and so the latest cumulative P&L shown, is the provider-latest one", async () => {
    const h = await harness();
    const T = Math.floor((NOW - 60_000) / 5_000) * 5_000;
    const row = (seq: number, over: Rec): Rec => ({
      id: `alrt_${T}_${seq}`,
      alertType: "sell",
      userId: FRANK,
      trader: "frankdegods",
      token: "PONS",
      tokenAddress: PONS,
      chainId: 4663,
      chain: "robinhood",
      ts: T,
      ...over,
    });
    // seq 10 matched exactly and its block time is 2 s after the provider's; seq 11, the provider-latest, did not match.
    const earlier = row(10, { fillMatch: "onchain-exact", tradeUsd: 1_000, execTs: T + 2_000, realizedPnlUsd: -100, text: "frankdegods sold $PONS" });
    const later = row(11, { realizedPnlUsd: -250, text: "frankdegods sold $PONS" });
    h.routes.set("alerts", () => json({ ...fixture("alerts"), alerts: [later, earlier], newestTs: T, oldestTs: T }));
    const env = await h.invoke<TraderActivityData>("fomo_get_trader_activity", { trader: FRANK, window: "24h" });
    const events = env.data?.events ?? [];
    assert.equal(events.length, 2);
    assert.equal(events[0]!.positionRealizedPnlUsdCumulative, -250, "the first (newest) row is the provider's seq 11");
    assert.equal(events[1]!.positionRealizedPnlUsdCumulative, -100);
    const text = renderEnvelope(env, { audience: "owner", maxChars: 4000, now: h.clock.now });
    assert.ok(text.indexOf("P&L to date -$250") < text.indexOf("P&L to date -$100"), text);
  });
});

describe("one call, one clock: the reads of an invoke share its deadline and its abort", () => {
  it("the invoke deadline sits below the broker's ceiling", () => {
    assert.ok(READ_DEADLINE_MS.invoke < BROKER_LIMITS.serveMaxCallMs);
    assert.ok(READ_DEADLINE_MS.invoke < BROKER_LIMITS.directTimeoutMs);
  });

  it("the caller's own budget narrows the deadline: a call the broker would cut short sends nothing it cannot finish", async () => {
    const h = await harness();
    // A Telegram group lookup waits 3 s: minus the margin for the answer to travel back, no read can start.
    const env = await h.invoke<TokenThesesData>("fomo_get_token_theses", { token: PONS, chain: "robinhood" }, { budgetMs: 3_000 });
    assert.equal(h.calls.length, 0, "nothing sent that could not finish inside the caller's wait");
    assert.notEqual(env.status, "ok");
  });

  it("a caller that joins another's fetch gives up at ITS OWN deadline, not the leader's", async () => {
    const h = await harness({ latencyMs: 3_500 });
    const leader = h.invoke<TokenThesesData>("fomo_get_token_theses", { token: PONS, chain: "robinhood" });
    await new Promise((r) => setTimeout(r, 50));
    // Budget 4.5 s ⇒ a 3 s read deadline: enough to start, not enough to wait out a 3.5 s fetch.
    const t0 = Date.now();
    const joiner = await h.invoke<TokenThesesData>("fomo_get_token_theses", { token: PONS, chain: "robinhood" }, { budgetMs: 4_500 });
    const waited = Date.now() - t0;
    assert.ok(waited < 3_400, `the joiner stopped waiting at its own deadline (${waited} ms)`);
    assert.notEqual(joiner.status, "ok");
    const led = await leader;
    assert.equal(led.status === "ok" || led.status === "capped", true, `the leader's read still completes (${led.status})`);
    assert.equal(h.count("/v2/thesis/token/"), 1, "one fetch, shared");
  });

  it("a read that cannot start before the deadline is skipped and reported, never sent", async () => {
    const h = await harness();
    // The thesis read takes most of the call's time (a fake clock: 39 s of the 40).
    h.routes.set("thesis-token", () => {
      h.clock.now += READ_DEADLINE_MS.invoke - 1_000;
      return json(fixture("theses-token"), 200, { "x-credits-cost": "1250" });
    });
    const env = await h.invoke<ResearchCoinData>("fomo_research_coin", { token: "PONS" });
    assert.equal(h.count("/stats"), 0, "token stats was never sent");
    assert.equal(h.count("/v2/alerts"), 0, "nor the feed");
    assert.equal(env.status, "partial", "what was read is real; what was skipped is missing, not empty");
    assert.ok(env.coverage.missing.includes("token-stats"), env.coverage.missing.join(","));
    assert.ok(env.coverage.missing.includes("feed"), env.coverage.missing.join(","));
    assert.ok(env.coverage.notes.some((n) => /Time ran out before .*token-stats.* could be read/.test(n)), env.coverage.notes.join(" | "));
    // Nothing skipped was charged.
    assert.equal(env.usage.providerCalls, h.calls.length);
  });

  it("the caller's abort reaches the fetch in flight: nothing keeps running after the call is gone", async () => {
    const h = await harness();
    const ac = new AbortController();
    const seen = { started: 0, aborted: 0 };
    h.routes.set("stats", (_u, init) => {
      seen.started++;
      setTimeout(() => ac.abort(), 5);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          seen.aborted++;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    const started = Date.now();
    const env = await h.invoke<ResearchCoinData>("fomo_research_coin", { token: "PONS" }, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(seen.started, 1);
    assert.equal(seen.aborted, 1, "the stats fetch was aborted, not left listening (and billing)");
    assert.ok(Date.now() - started < 5_000);
    assert.notEqual(env.status, "ok");
    // Our own cut is not the provider failing.
    assert.notEqual((await h.service.health(h.clock.now)).state, "provider-unavailable");
    const stats = (await store.listCapabilities(h.db)).find((c) => c.capability === "token-stats");
    assert.notEqual(stats?.status, "UNAVAILABLE");
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
    assert.deepEqual(ran, { claimed: 1, done: 1, failed: 0, cancelled: 0 });
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

describe("tails", () => {
  const HOUR = 3_600_000;

  it("needs the hosted live feed: refused on an install without it, with nothing read or stored", async () => {
    const h = await harness();
    const env = await h.invoke<TailData>("fomo_tail_trader", { trader: "CryptoKaleo", hours: 3 });
    assert.equal(env.status, "unavailable");
    assert.equal(env.reason, "tail-needs-live-feed");
    assert.match(env.message ?? "", /hosted service/);
    assert.equal(h.calls.length, 0);
    assert.equal(rows(h.raw, "fomo_tails"), 0);
    const off = await harness({ liveFeed: false });
    assert.equal((await off.invoke<TailData>("fomo_tail_trader", { trader: "CryptoKaleo" })).reason, "tail-needs-live-feed");
    assert.equal(
      renderEnvelope(env, { audience: "owner", maxChars: 2000, now: NOW }).split("\n")[0],
      "Tailing needs Fomo's live feed, which only the hosted service has; this install can answer Fomo questions but can't tail.",
      "said as it is, never as a failed read",
    );
  });

  it("MERRYMEN_FOMO_TAILS=0: refused as switched off, nothing read or stored; stopping still works and status says they are on hold", async () => {
    const on = await harness({ liveFeed: true });
    await on.invoke<TailData>("fomo_tail_trader", { trader: KALEO, consider: true });
    const h = await harness({ liveFeed: true, tailsEnabled: false, db: on.db, raw: on.raw });
    const env = await h.invoke<TailData>("fomo_tail_trader", { trader: "CryptoKaleo", hours: 3, consider: true });
    assert.equal(env.status, "unavailable");
    assert.equal(env.reason, "tails-disabled");
    assert.equal(env.data, null);
    assert.equal(h.calls.length, 0, "not even the handle is resolved");
    assert.deepEqual((await store.activeTails(h.db, OWNER, NOW)).map((t) => t.userId), [KALEO], "nothing new stored");
    const text = renderEnvelope(env, { audience: "owner", maxChars: 2000, now: NOW });
    assert.match(text, /^Tailing is switched off on this service right now, so I haven't started one/);
    assert.doesNotMatch(text, /^Tailing CryptoKaleo|until \d\d:\d\d UTC|couldn't read/, "never 'Tailing X until', never a failed read");
    const status = await h.invoke<ResearchStatusData>("fomo_get_research_status", {});
    assert.equal(status.data?.tailsOff, true);
    assert.match(renderEnvelope(status, { audience: "owner", maxChars: 4000, now: NOW }), /Tailing on Fomo is switched off right now, so I'm not telling you about trader 1f08e6ab…; each tail still ends on time\./);
    assert.equal((await h.invoke<UntailData>("fomo_untail_trader", { all: true })).data?.removed, 1, "a stored tail can always be stopped");
    assert.equal((await on.invoke<ResearchStatusData>("fomo_get_research_status", {})).data?.tailsOff, undefined);
  });

  it("a known handle is free; an unknown one costs exactly one search, never the profile route", async () => {
    const h = await harness({ liveFeed: true });
    await store.upsertTrader(h.db, { userId: FRANK, handle: "frankdegods", displayName: null, verified: null }, NOW - 1000);
    const known = await h.invoke<TailData>("fomo_tail_trader", { trader: "@FrankDeGods", hours: 2 });
    assert.equal(known.status, "ok", JSON.stringify(known).slice(0, 300));
    assert.equal(h.calls.length, 0, "the local record answers, at no cost");
    assert.deepEqual(known.data, {
      action: "tail",
      trader: { userId: FRANK, handle: "frankdegods" },
      created: true,
      expiresAtMs: NOW + 2 * HOUR,
      consider: false,
      activeTails: 1,
      routable: true,
      following: false,
    });
    assert.equal(known.subject?.kind, "trader");
    const unknown = await h.invoke<TailData>("fomo_tail_trader", { trader: "CryptoKaleo", consider: true });
    assert.equal(unknown.status, "ok");
    assert.equal(h.count("/v2/search"), 1);
    assert.equal(h.calls.length, 1, "one search and nothing else");
    assert.ok(!h.calls.some((c) => c.startsWith("/v2/users")), "never the 2,500-credit profile route");
    assert.equal(unknown.usage.creditsCharged, 250);
    assert.equal(unknown.data?.expiresAtMs, NOW + 3 * HOUR, "three hours by default");
    assert.equal(unknown.data?.consider, true);
    assert.equal(unknown.data?.activeTails, 2);
    const stored = await store.activeTails(h.db, OWNER, NOW);
    // Oldest first, then by id: both started at the same moment.
    assert.deepEqual(stored.map((t) => [t.userId, t.handle, t.consider, t.createdVia]), [
      [KALEO, "CryptoKaleo", true, "app-chat"],
      [FRANK, "frankdegods", false, "app-chat"],
    ]);
    // A user id nobody has seen is taken as given: no read is spent to learn a handle.
    const before = h.calls.length;
    const byId = await h.invoke<TailData>("fomo_tail_trader", { trader: STAR, hours: 12 });
    assert.equal(byId.status, "ok");
    assert.deepEqual(byId.data?.trader, { userId: STAR, handle: null });
    assert.equal(h.calls.length, before);
  });

  it("caps at three active tails; renewing one is not a fourth and may change its hours and consider", async () => {
    const h = await harness({ liveFeed: true });
    for (const t of [KALEO, FRANK, STAR]) assert.equal((await h.invoke<TailData>("fomo_tail_trader", { trader: t })).status, "ok");
    const fourth = await h.invoke<TailData>("fomo_tail_trader", { trader: "0f08e6ab-5c73-5443-9225-bfc496cde51f" });
    assert.equal(fourth.status, "failed");
    assert.equal(fourth.reason, "tail-cap-reached");
    assert.match(fourth.message ?? "", /3 tails running/);
    h.clock.now = NOW + 10 * 60_000;
    const renewed = await h.invoke<TailData>("fomo_tail_trader", { trader: KALEO, hours: 6, consider: true });
    assert.equal(renewed.status, "ok");
    assert.equal(renewed.data?.created, false);
    assert.equal(renewed.data?.expiresAtMs, NOW + 10 * 60_000 + 6 * HOUR);
    assert.equal(renewed.data?.consider, true);
    assert.equal(renewed.data?.activeTails, 3);
  });

  it("routable says whether research routing can follow; alerts need only data access", async () => {
    const h = await harness({ liveFeed: true, access: { dataAccess: true, monitoring: false, follow: false } });
    const env = await h.invoke<TailData>("fomo_tail_trader", { trader: KALEO });
    assert.equal(env.status, "ok", "stored: alerts come from the stored feed at no cost");
    assert.equal(env.data?.routable, false);
    const follow = await harness({ liveFeed: true, access: { dataAccess: true, monitoring: false, follow: true } });
    const followed = await follow.invoke<TailData>("fomo_tail_trader", { trader: KALEO, consider: true });
    assert.deepEqual([followed.data?.routable, followed.data?.following], [true, true]);
    assert.match(renderEnvelope(followed, { audience: "owner", maxChars: 2000, now: NOW }), /one signal into my normal review/);
    assert.match(renderEnvelope(env, { audience: "owner", maxChars: 2000, now: NOW }), /tell you only/);
    // Tell-only with monitoring and follow off: no read of the coin will come, and it is said (review 2026-10-07).
    assert.match(renderEnvelope(env, { audience: "owner", maxChars: 2000, now: NOW }), /Monitoring and following are both off, so I won't have my own read of their coins/);
    assert.doesNotMatch(renderEnvelope(followed, { audience: "owner", maxChars: 2000, now: NOW }), /won't have my own read/);
    const monitorOnly = await harness({ liveFeed: true });
    const watched = await monitorOnly.invoke<TailData>("fomo_tail_trader", { trader: KALEO, consider: true });
    assert.deepEqual([watched.data?.routable, watched.data?.following], [true, false]);
    assert.match(renderEnvelope(watched, { audience: "owner", maxChars: 2000, now: NOW }), /Following is off, so their buys only reach my research, never a trade/);
    const offBoth = await h.invoke<TailData>("fomo_tail_trader", { trader: FRANK, consider: true });
    assert.match(renderEnvelope(offBoth, { audience: "owner", maxChars: 2000, now: NOW }), /Monitoring and following are both off, so I'll only tell you, without my own read of their coins/);
    const noAccess = await harness({ liveFeed: true, access: { dataAccess: false, monitoring: true, follow: true } });
    assert.equal((await noAccess.invoke<TailData>("fomo_tail_trader", { trader: KALEO })).status, "not-authorized");
    assert.equal(rows(noAccess.raw, "fomo_tails"), 0);
  });

  it("stops by handle (any case) or id, or all, at no cost; research status lists what runs", async () => {
    const h = await harness({ liveFeed: true });
    await h.invoke<TailData>("fomo_tail_trader", { trader: "CryptoKaleo", consider: true });
    await h.invoke<TailData>("fomo_tail_trader", { trader: FRANK, hours: 2 });
    await h.invoke<TailData>("fomo_tail_trader", { trader: STAR, hours: 1 });
    const status = await h.invoke<ResearchStatusData>("fomo_get_research_status", {});
    assert.deepEqual(status.data?.tails, [
      { userId: KALEO, handle: "CryptoKaleo", expiresAtMs: NOW + 3 * HOUR, consider: true },
      { userId: STAR, handle: null, expiresAtMs: NOW + HOUR, consider: false },
      { userId: FRANK, handle: null, expiresAtMs: NOW + 2 * HOUR, consider: false },
    ]);
    const calls = h.calls.length;
    const one = await h.invoke<UntailData>("fomo_untail_trader", { trader: "@cryptokaleo" });
    assert.equal(one.status, "ok");
    assert.deepEqual(one.data, { action: "untail", trader: { userId: KALEO, handle: "CryptoKaleo" }, all: false, removed: 1, activeTails: 2 });
    const again = await h.invoke<UntailData>("fomo_untail_trader", { trader: "CryptoKaleo" });
    assert.equal(again.status, "empty");
    assert.equal(again.data?.removed, 0);
    assert.equal(again.data?.trader, null, "an unmatched handle names nobody");
    const byId = await h.invoke<UntailData>("fomo_untail_trader", { trader: FRANK });
    assert.equal(byId.data?.removed, 1);
    const all = await h.invoke<UntailData>("fomo_untail_trader", { all: true });
    assert.deepEqual(all.data, { action: "untail", trader: null, all: true, removed: 1, activeTails: 0 });
    assert.equal((await h.invoke<UntailData>("fomo_untail_trader", { all: true })).status, "empty");
    assert.equal(h.calls.length, calls, "stopping never reads the provider");
    for (const bad of [{}, { all: false }, { trader: "x_1", all: true }, { trader: "a.b" }]) {
      const env = await h.invoke("fomo_untail_trader", bad);
      assert.equal(env.reason, "invalid-args", JSON.stringify(bad));
    }
    assert.equal((await h.invoke("fomo_tail_trader", { trader: KALEO, hours: 13 })).reason, "invalid-args");
    assert.equal((await h.invoke("fomo_tail_trader", { trader: KALEO, hours: 0 })).reason, "invalid-args");
    assert.equal((await h.invoke("fomo_tail_trader", { hours: 2 })).reason, "invalid-args");
  });

  it("stopping a tail that ended on its own says it ended, by name, and leaves its row for the summary; a stopped one by id says so plainly (review 2026-10-07)", async () => {
    const h = await harness({ liveFeed: true });
    await h.invoke<TailData>("fomo_tail_trader", { trader: "CryptoKaleo", hours: 1 });
    const later = { now: NOW + HOUR + 60_000 };
    for (const ref of [KALEO, "CryptoKaleo", "@cryptokaleo"]) {
      const env = await h.invoke<UntailData>("fomo_untail_trader", { trader: ref }, later);
      assert.equal(env.status, "empty", ref);
      assert.equal(env.reason, "tail-ended");
      const said = renderEnvelope(env, { audience: "owner", maxChars: 2000, now: later.now });
      assert.match(said, /^Your tail on CryptoKaleo already ended at 17:05 UTC\./, ref);
      assert.doesNotMatch(said, /weren't tailing|[0-9a-f]{8}…/);
    }
    assert.equal(rows(h.raw, "fomo_tails"), 1, "the ended row stays: its end summary is read from it");
    // A tail she stopped is gone: a Stop press (by id) is told so, never an id fragment.
    await h.invoke<TailData>("fomo_tail_trader", { trader: FRANK, hours: 2 });
    await h.invoke<UntailData>("fomo_untail_trader", { trader: FRANK });
    const gone = await h.invoke<UntailData>("fomo_untail_trader", { trader: FRANK });
    assert.equal(gone.reason, "tail-not-active");
    assert.match(renderEnvelope(gone, { audience: "owner", maxChars: 2000, now: NOW }), /^That tail has already stopped\./);
    assert.doesNotMatch(renderEnvelope(gone, { audience: "owner", maxChars: 2000, now: NOW }), /trader [0-9a-f]{8}/);
    // A handle she never tailed is still that.
    assert.match(renderEnvelope(await h.invoke<UntailData>("fomo_untail_trader", { trader: "nobody_here" }), { audience: "owner", maxChars: 2000, now: NOW }), /^You weren't tailing that trader\./);
  });

  it("+1h makes a running tail longer, never shorter, never past 12 hours from now, never a revived one; at no cost", async () => {
    const h = await harness({ liveFeed: true });
    await h.invoke<TailData>("fomo_tail_trader", { trader: "CryptoKaleo", hours: 3 });
    const calls = h.calls.length;
    const one = await h.invoke<ExtendTailData>("fomo_extend_tail", { trader: KALEO }, { now: NOW + 60_000 });
    assert.equal(one.status, "ok");
    assert.deepEqual(one.data, { action: "extend", trader: { userId: KALEO, handle: "CryptoKaleo" }, previousExpiresAtMs: NOW + 3 * HOUR, expiresAtMs: NOW + 4 * HOUR, capped: false, activeTails: 1 });
    assert.match(renderEnvelope(one, { audience: "owner", maxChars: 2000, now: NOW }), /^Tailing CryptoKaleo until 20:05 UTC now\./);
    const byHandle = await h.invoke<ExtendTailData>("fomo_extend_tail", { trader: "cryptokaleo", hours: 12 });
    assert.ok(byHandle.data?.capped && byHandle.data.expiresAtMs === NOW + 12 * HOUR, "capped at 12 hours from now");
    const again = await h.invoke<ExtendTailData>("fomo_extend_tail", { trader: KALEO });
    assert.equal(again.data?.expiresAtMs, NOW + 12 * HOUR, "nothing added, nothing taken");
    assert.match(renderEnvelope(again, { audience: "owner", maxChars: 2000, now: NOW }), /already runs as long as a tail can/);
    assert.equal(h.calls.length, calls, "extending never reads the provider");
    const ended = await h.invoke<ExtendTailData>("fomo_extend_tail", { trader: KALEO }, { now: NOW + 12 * HOUR });
    assert.equal(ended.status, "empty");
    assert.equal(ended.reason, "tail-not-active");
    assert.match(renderEnvelope(ended, { audience: "owner", maxChars: 2000, now: NOW }), /^That tail has already ended\./);
    assert.deepEqual(await store.activeTails(h.db, OWNER, NOW + 12 * HOUR), [], "not revived");
    const g = await h.invoke("fomo_extend_tail", { trader: KALEO }, { audience: "group", surface: "telegram-group", groupId: "-100123" });
    assert.equal(g.reason, "owner-only");
    const off = await harness({ liveFeed: true, tailsEnabled: false });
    assert.equal((await off.invoke("fomo_extend_tail", { trader: KALEO })).reason, "tails-disabled");
  });

  it("a group can neither start nor stop a tail, nor see one", async () => {
    const h = await harness({ liveFeed: true });
    await h.invoke<TailData>("fomo_tail_trader", { trader: KALEO });
    const g = { audience: "group" as const, surface: "telegram-group" as const, groupId: "-100123" };
    for (const [tool, args] of [
      ["fomo_tail_trader", { trader: FRANK }],
      ["fomo_untail_trader", { trader: KALEO }],
      ["fomo_untail_trader", { all: true }],
    ] as const) {
      const env = await h.invoke(tool, args, g);
      assert.equal(env.status, "not-authorized", tool);
      assert.equal(env.reason, "owner-only");
      assert.equal(env.data, null);
    }
    assert.equal(h.calls.length, 0);
    assert.deepEqual((await store.activeTails(h.db, OWNER, NOW)).map((t) => t.userId), [KALEO], "nothing changed");
  });

  it("renders for the owner in plain words, and a group is deflected", async () => {
    const h = await harness({ liveFeed: true });
    const told = await h.invoke<TailData>("fomo_tail_trader", { trader: "CryptoKaleo", hours: 2 });
    const text = renderEnvelope(told, { audience: "owner", maxChars: 2000, now: NOW });
    assert.match(text, /^Tailing CryptoKaleo on Fomo until 18:05 UTC \(2 h\)\./);
    assert.match(text, /tell you only; I won't trade on it/);
    assert.match(text, /no alert is not proof they didn't trade/);
    assert.doesNotMatch(text, /cop(y|ies)\b(?! their)/i);
    const considered = await h.invoke<TailData>("fomo_tail_trader", { trader: "CryptoKaleo", hours: 2, consider: true });
    assert.match(renderEnvelope(considered, { audience: "owner", maxChars: 2000, now: NOW }), /^Still tailing CryptoKaleo[^]*Following is off, so their buys only reach my research/);
    assert.equal(renderEnvelope(told, { audience: "group", maxChars: 2000, now: NOW }), "I'll answer that in a direct message.");
    const stop = await h.invoke<UntailData>("fomo_untail_trader", { trader: "CryptoKaleo" });
    assert.match(renderEnvelope(stop, { audience: "owner", maxChars: 2000, now: NOW }), /^Stopped tailing CryptoKaleo\./);
    const none = await h.invoke<UntailData>("fomo_untail_trader", { trader: "CryptoKaleo" });
    assert.match(renderEnvelope(none, { audience: "owner", maxChars: 2000, now: NOW }), /^You weren't tailing that trader\./);
    await h.invoke<TailData>("fomo_tail_trader", { trader: "CryptoKaleo", consider: true });
    const status = await h.invoke<ResearchStatusData>("fomo_get_research_status", {});
    assert.match(renderEnvelope(status, { audience: "owner", maxChars: 4000, now: NOW }), /Tailing on Fomo: CryptoKaleo until 19:05 UTC \(their buys go to my normal review\)\./);
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

  it("is capped short of the pool, so stream recovery still finds its credits after research has spent all it may", async () => {
    // The runtime's background budget: one pool of 20,000 a day, owner caps lifted to it.
    const pool = 20_000;
    const h = await harness({ background: { sharedDailyCredits: pool, tenantHourlyCredits: pool, tenantDailyCredits: pool, groupHourlyCredits: pool } });
    const bg = h.backgroundBudget!;
    const day = new Date(NOW).toISOString().slice(0, 10);
    const coin = (n: number) => tokenIdentity(robinhoodChain(), `0x${n.toString(16).padStart(40, "0")}`)!;
    // A research queue that never runs dry, on held coins: the protection class may borrow the whole pool.
    const statuses: string[] = [];
    for (let i = 1; i <= 20; i++) {
      const r = await h.service.refreshDossier(coin(i), { symbol: null, name: null }, { priority: "position-protection", depth: "quick", now: NOW });
      statuses.push(r.status);
      if (r.status === "budget-limited") break;
    }
    assert.ok(statuses.length > 2 && statuses.at(-1) === "budget-limited", `research ran, then was refused: ${statuses.join(",")}`);
    const researchAll = (await store.readAllowance(h.db, `fomo:research:all:d:${day}`)) ?? 0;
    assert.ok(researchAll <= pool * BACKGROUND_RESEARCH_CAP.poolShare, `research took ${researchAll} of ${pool}`);
    // Stream recovery (the protection class, under the fleet's own payer) still has pages left.
    const recovery = () => bg.tryCharge({ tenant: "fomo-fleet-maintenance", surface: "background", priority: "position-protection", credits: 125, now: NOW });
    for (let i = 0; i < 20; i++) assert.equal((await recovery()).ok, true, `recovery page ${i + 1}`);
    // The research counter never touches an owner's own reads: a tool call is unaffected.
    const owner = await h.invoke<RankingsData>("fomo_get_rankings", { board: "traders" });
    assert.notEqual(owner.status, "budget-limited");
    // A refusal by the research counter takes nothing from the budget, and a grant that is refunded gives its counter back.
    const before = (await store.readAllowance(h.db, `fomo:research:all:d:${day}`)) ?? 0;
    const refused = await h.service.refreshDossier(coin(99), { symbol: null, name: null }, { priority: "discovery", depth: "quick", now: NOW });
    assert.equal(refused.status, "budget-limited");
    assert.equal((await store.readAllowance(h.db, `fomo:research:all:d:${day}`)) ?? 0, before);
    assert.equal(SHARED_RESEARCH_TENANT, "fomo-shared-research", "research pays as its own payer, apart from the fleet's maintenance payer");
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
    // Durable too, per reporting tenant only, so another replica and the ingestion leader read the same book.
    assert.deepEqual(await store.heldTokensFor(h.db, OWNER, 0), [PONS_KEY]);
    assert.deepEqual([...(await store.heldTokensFleet(h.db, 0))], [[PONS_KEY, ["0xother", OWNER]]]);
    await h.service.report("0xother", { kind: "held-tokens", tokenKeys: [], atMs: NOW + 1 }, NOW + 1);
    assert.deepEqual(await store.heldTokensFor(h.db, "0xother", 0), [], "a report of nothing held clears that tenant's set");
    assert.deepEqual(await store.heldTokensFor(h.db, OWNER, 0), [PONS_KEY], "and only that tenant's");
  });

  it("subject memory is tenant-scoped", async () => {
    const h = await harness();
    await h.service.memorySet(OWNER, "c1", JSON.stringify({ a: 1 }), NOW);
    assert.equal(await h.service.memoryGet(OWNER, "c1"), JSON.stringify({ a: 1 }));
    assert.equal(await h.service.memoryGet("0xother", "c1"), null);
    await h.service.memoryClear(OWNER, "c1");
    assert.equal(await h.service.memoryGet(OWNER, "c1"), null);
  });

  it("the strict memory read says 'nothing stored' only when the store answered; a store error is a failure, never null", async () => {
    const raw = new DatabaseSync(":memory:");
    const inner = wrapSqlite(raw);
    const down = { on: false };
    const db: Db = {
      prepare(sql) {
        const st = inner.prepare(sql);
        if (!/SELECT subject_json/.test(sql)) return st;
        return {
          run: (...a) => st.run(...a),
          all: (...a) => st.all(...a),
          get: async (...a) => {
            if (down.on) throw new Error("Connection terminated unexpectedly");
            return st.get(...a);
          },
        };
      },
      exec: (sql) => inner.exec(sql),
      tx: (fn) => inner.tx(fn),
    };
    const h = await harness({ db, raw });
    const read = h.service.memoryRead!;
    assert.deepEqual(await read(OWNER, "state:k"), { ok: true, value: null }, "answered: nothing stored");
    await h.service.memorySet(OWNER, "state:k", JSON.stringify({ l: "15" }), NOW);
    assert.deepEqual(await read(OWNER, "state:k"), { ok: true, value: JSON.stringify({ l: "15" }) });
    assert.deepEqual(await read("0xother", "state:k"), { ok: true, value: null }, "tenant-scoped");
    down.on = true;
    assert.deepEqual(await read(OWNER, "state:k"), { ok: false, reason: "store-error" }, "a store error is not an empty store");
    assert.equal(await h.service.memoryGet(OWNER, "state:k"), null, "the lenient read keeps its contract for chat memory");
    assert.ok(h.logs.some((l) => /memory read failed/.test(l)));
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

// ── Review fixes: coverage stays honest ─────────────────────────────────

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The shared stream is current, and (when `reachesBackMs` is given) has been seen current since that long ago. */
async function streamIsCurrent(h: Harness, reachesBackMs: number | null = 40 * DAY_MS): Promise<void> {
  await store.setCheckpoint(h.db, "alerts", null, h.clock.now - 5_000, h.clock.now - 1_000);
  if (reachesBackMs !== null) {
    await store.cachePut(h.db, {
      cacheKey: STREAM_COVERAGE_MARK_KEY,
      dataClass: "activity",
      payload: { fromMs: h.clock.now - reachesBackMs, seenMs: h.clock.now - 60_000 },
      retrievedAtMs: h.clock.now - 60_000,
      providerAsOfMs: null,
    });
  }
}

/** A db whose token-keyed event reads throw while `on` is set (a statement timeout on the big table); everything else works. */
function flakyEvents(d: Db, gate: { on: boolean }): Db {
  const wrap = (x: Db): Db => ({
    prepare: (sql) => {
      if (gate.on && /FROM fomo_events WHERE token_key = \?/.test(sql)) throw new Error("canceling statement due to statement timeout");
      return x.prepare(sql);
    },
    exec: (q) => x.exec(q),
    tx: (fn) => x.tx((t) => fn(wrap(t))),
  });
  return wrap(d);
}

describe("a shallower read never replaces a deeper one as a change (C4)", () => {
  const base = () => (fixture("theses-token").theses as Rec[])[0]!;
  const users = Array.from({ length: 125 }, (_, i) => `${(i + 16).toString(16).padStart(8, "0")}-0000-4000-8000-${i.toString().padStart(12, "0")}`);
  const thesis = (i: number): Rec => ({
    ...base(),
    id: `th-d${i}`,
    userId: users[i],
    handle: `u${i}`,
    // Pages 2 and 3 (theses 25-39) hold a well-supported objection; page 1 holds none of it.
    text: i >= 25 && i < 40 ? `dev sold everything, this is a rug number ${i}` : `strong community and breakout soon number ${i}`,
    ts: new Date(NOW - (i + 1) * 60_000).toISOString(),
  });
  const deepHarness = async () => {
    const h = await harness();
    h.routes.set("thesis-token", (u) => {
      const pages = Number(u.searchParams.get("pages") ?? "1");
      return json({ totalAvailable: 125, source: "live", theses: Array.from({ length: 25 * pages }, (_, i) => thesis(i)) }, 200, { "x-credits-cost": "1250" });
    });
    const token = tokenIdentity(robinhoodChain(), PONS)!;
    const deep = await h.service.refreshDossierAs({ tenant: OWNER, surface: "app-chat", priority: "interactive" }, token, { symbol: "PONS", name: null }, { depth: "deep", now: h.clock.now });
    assert.ok(deep.dossier);
    assert.equal(deep.dossier.coverage.pagesReturned, 5);
    assert.ok(deep.dossier.strongestOpposition, "the deep read found the objection");
    return { h, deep: deep.dossier };
  };

  it("carries the deeper pages from the shared cache and refuses to compare different depths", async () => {
    const { h, deep } = await deepHarness();
    h.clock.now += 31 * 60_000;
    const before = h.count("pages=5");
    const quick = await h.invoke<ResearchCoinData>("fomo_research_coin", { token: PONS, chain: "robinhood", depth: "quick", since_revision: deep.revision });
    assert.equal(h.count("pages=5"), before, "the deeper pages came from the cache, not a new 6,250-credit read");
    assert.equal(quick.data?.coverage.pagesReturned, 5, "the stored revision keeps the deeper coverage");
    assert.equal(quick.data?.coverage.uniqueTheses, 125);
    assert.equal(quick.data?.strongestOpposition?.claimKey, deep.strongestOpposition!.claimKey, "the objection is still on record");
    assert.ok(quick.data?.coverage.limitations.some((l) => /stored copy/.test(l)), "carried pages are labelled a stored copy");
    assert.ok(quick.coverage.notes.some((n) => /carried from a deeper read/.test(n)));
    assert.equal(quick.data?.changes?.comparable, false);
    assert.equal(quick.data?.changes?.reason, "different-scope");
    const latest = asDossierOf(await store.latestDossier(h.db, PONS_KEY));
    assert.equal(latest?.strongestOpposition?.claimKey, deep.strongestOpposition!.claimKey, "the shared latest revision did not lose the objection");
    const text = renderEnvelope(quick, { audience: "owner", maxChars: 4000, now: h.clock.now });
    assert.ok(!/No longer present|no longer an objection/i.test(text), text);
  });

  it("with no deeper copy left to carry, the narrower revision is never compared as a change", async () => {
    const { h, deep } = await deepHarness();
    h.raw.prepare("DELETE FROM fomo_cache WHERE cache_key LIKE ?").run("%pages=5%");
    h.clock.now += 31 * 60_000;
    const quick = await h.invoke<ResearchCoinData>("fomo_research_coin", { token: PONS, chain: "robinhood", depth: "quick", since_revision: deep.revision });
    assert.equal(quick.data?.coverage.pagesReturned, 1);
    assert.equal(quick.data?.changes?.comparable, false, "a one-page read is not compared with a five-page one");
    assert.equal(quick.data?.changes?.reason, "different-scope");
    assert.equal(quick.data?.changes?.changes.length, 0);
  });

  it("a complete fresh read is the list: a deeper copy's pages are not carried back into it (R7)", async () => {
    const { h, deep } = await deepHarness();
    // The provider removes a spam ring: twenty theses remain, all on page one. The read is complete.
    h.routes.set("thesis-token", () => json({ totalAvailable: 20, source: "live", theses: Array.from({ length: 20 }, (_, i) => thesis(i)) }, 200, { "x-credits-cost": "1250" }));
    h.clock.now += 40 * 60_000;
    const quick = await h.invoke<ResearchCoinData>("fomo_research_coin", { token: PONS, chain: "robinhood", depth: "quick" });
    assert.equal(quick.data?.coverage.uniqueTheses, 20, "the removed theses do not come back from the cache");
    assert.equal(quick.data?.coverage.providerTotal, 20);
    assert.equal(quick.data?.coverage.pagesReturned, 1);
    assert.equal(quick.data?.strongestOpposition, null, "an objection that lived only on the removed pages is gone from the read");
    assert.ok(!quick.coverage.notes.some((n) => /carried from a deeper read/.test(n)));
    assert.equal(quick.status, "ok");
    const latest = asDossierOf(await store.latestDossier(h.db, PONS_KEY));
    assert.equal(latest?.coverage.uniqueTheses, 20, "nor do they come back into the shared latest revision");
    assert.ok(deep.coverage.uniqueTheses > 20);
  });

  it("a cut-short fresh read carries no more than the provider now says exist, and is stale, not ok (R7)", async () => {
    const { h } = await deepHarness();
    // Still more than a page, but fewer than the deeper copy holds.
    h.routes.set("thesis-token", (u) => {
      const pages = Number(u.searchParams.get("pages") ?? "1");
      return json({ totalAvailable: 60, source: "live", theses: Array.from({ length: Math.min(60, 25 * pages) }, (_, i) => thesis(i)) }, 200, { "x-credits-cost": "1250" });
    });
    h.clock.now += 40 * 60_000;
    const quick = await h.invoke<ResearchCoinData>("fomo_research_coin", { token: PONS, chain: "robinhood", depth: "quick" });
    assert.ok(quick.coverage.notes.some((n) => /carried from a deeper read/.test(n)));
    assert.equal(quick.data?.coverage.uniqueTheses, 60, "carried up to the provider's current total, never past it");
    assert.equal(quick.status, "stale", "carried pages are a stored copy, never ok-fresh");
    assert.equal(quick.reason, "carried-pages");
    assert.equal(quick.freshness.servedFrom, "stale-cache");
  });
});

describe("a feed or record read cut short is not the whole 24h (R6)", () => {
  const hex = (n: number, w: number) => n.toString(16).padStart(w, "0");
  const alert = (i: number, ts: number, kind: "buy" | "sell") => {
    const id = `${hex(i + 1, 8)}-aaaa-4bbb-8ccc-${hex(i + 1, 12)}`;
    return {
      id,
      alertType: kind,
      source: "feed",
      eventId: id,
      userId: `${hex(1000 + i, 8)}-0000-4000-8000-${hex(i, 12)}`,
      tradeId: null,
      swapId: null,
      transferId: null,
      trader: `t${i}`,
      token: "PONS",
      tokenAddress: PONS,
      chainId: 4663,
      chain: "robinhood",
      usdValue: 5000,
      positionValueUsd: 5000,
      text: `t${i} ${kind}`,
      ts,
    };
  };

  it("one REST page that stops inside the window makes research partial and supports no change claim", async () => {
    const h = await harness();
    // No stream: the token feed is the activity read. 100 rows over the last ~3h, and the provider says there are more.
    let phase = 0;
    h.routes.set("alerts", () => {
      const now = h.clock.now;
      const rows = Array.from({ length: 100 }, (_, i) => alert(i + phase * 1000, now - 60_000 - i * 100_000, phase === 0 || i % 2 ? "buy" : "sell"));
      return json({ order: "desc", hasMore: true, newestTs: rows[0]!.ts, oldestTs: rows[99]!.ts, nextCursor: null, oldestCursor: "c1", alerts: rows }, 200, { "x-credits-cost": "125" });
    });
    const r1 = await h.invoke<ResearchCoinData>("fomo_research_coin", { token: PONS, chain: "robinhood" });
    assert.equal(r1.status, "partial");
    assert.equal(r1.reason, "activity-incomplete");
    assert.ok(r1.coverage.notes.some((n) => /does not reach back over the whole 24h/.test(n)), r1.coverage.notes.join(" | "));
    phase = 1;
    h.clock.now += 40 * 60_000;
    const r2 = await h.invoke<ResearchCoinData>("fomo_research_coin", { token: PONS, chain: "robinhood", since_revision: r1.data!.revision });
    assert.equal(r2.status, "partial");
    assert.equal(r2.data?.changes?.comparable, false, "a page that rolled over is not buyers leaving");
    assert.equal(r2.data?.changes?.reason, "check-failed");
    assert.deepEqual(r2.data?.changes?.changes, []);
  });

  it("the shared record read stopped at its row limit is a floor, not the window", async () => {
    const h = await harness();
    await streamIsCurrent(h);
    const evs = Array.from({ length: 500 }, (_, i) => buyEvent(`${hex(2000 + i, 8)}-0000-4000-8000-${hex(i, 12)}`, PONS, NOW - 60_000 - i * 60_000, `ev:cap${i}`));
    for (let i = 0; i < evs.length; i += 100) await store.insertEvents(h.db, evs.slice(i, i + 100));
    const env = await h.invoke<ResearchCoinData>("fomo_research_coin", { token: PONS, chain: "robinhood" });
    assert.equal(h.count("/v2/alerts"), 0, "the record answered");
    assert.equal(env.status, "partial");
    assert.equal(env.reason, "activity-incomplete");
    assert.ok(env.coverage.notes.some((n) => /more trades for this coin in the last 24h than one read takes/.test(n)), env.coverage.notes.join(" | "));
  });

  it("feedPageCutShort: a page reaching back to the window's start, or the provider's 'no more', is complete", () => {
    const since = NOW - DAY_MS;
    const page = (n: number, hasMore: boolean | null, oldestTs: number | null) => ({ rows: Array.from({ length: n }, () => ({}) as TraderEvent), dropped: 0, hasMore, oldestTs });
    assert.equal(feedPageCutShort(page(100, true, since - 1), since), false, "older rows are outside the window");
    assert.equal(feedPageCutShort(page(100, true, since + HOUR_MS), since), true);
    assert.equal(feedPageCutShort(page(100, false, since + HOUR_MS), since), false);
    assert.equal(feedPageCutShort(page(100, null, null), since), true, "a full page that does not say is not complete");
    assert.equal(feedPageCutShort(page(40, null, null), since), false);
  });
});

function asDossierOf(s: store.StoredDossier | null): ResearchCoinData | null {
  return s ? (s.dossier as unknown as ResearchCoinData) : null;
}

describe("a failed event-record read is a failure, never an empty read (C5)", () => {
  it("activity goes partial with the record missing; research is not stored as 'buyers left'", async () => {
    const raw = new DatabaseSync(":memory:");
    const gate = { on: false };
    const h = await harness({ raw, db: flakyEvents(wrapSqlite(raw), gate) });
    await streamIsCurrent(h);
    await store.insertEvents(h.db, [buyEvent(FRANK, PONS, NOW - 30 * 60_000, "ev:p1"), buyEvent(STAR, PONS, NOW - 20 * 60_000, "ev:p2")]);
    const first = await h.invoke<ResearchCoinData>("fomo_research_coin", { token: PONS, chain: "robinhood" });
    assert.equal(first.status, "ok");
    assert.equal(first.data?.flow?.distinctBuyers, 2);
    assert.equal(h.count("/v2/alerts"), 0, "the current, reaching record alone answered");

    gate.on = true;
    h.clock.now += 40 * 60_000;
    await store.setCheckpoint(h.db, "alerts", null, h.clock.now - 5_000, h.clock.now - 1_000);
    const act = await h.invoke<TokenActivityData>("fomo_get_token_activity", { token: PONS, chain: "robinhood" });
    assert.equal(act.status, "partial", "a failed record read is not 'empty'");
    assert.ok(act.coverage.missing.includes("stream-record"));
    assert.ok(h.count("/v2/alerts") >= 1, "the provider feed stood in for the record");
    const text = renderEnvelope(act, { audience: "owner", maxChars: 3000, now: h.clock.now });
    assert.ok(!/No matching activity were returned/.test(text), text);
    assert.match(text, /Not read: stream-record/);

    const again = await h.invoke<ResearchCoinData>("fomo_research_coin", { token: PONS, chain: "robinhood", since_revision: 1 });
    assert.equal(again.status, "partial");
    assert.equal(again.data?.changes?.comparable, false, "an incomplete read supports no change claim");
    assert.ok(!(again.data?.changes?.changes ?? []).some((c) => /No longer present|Distinct buyers: 2 → 0/.test(c)));
  });

  it("a failed cohort read makes the cohort answer partial rather than complete", async () => {
    const raw = new DatabaseSync(":memory:");
    const inner = wrapSqlite(raw);
    let fail = false;
    const wrap = (x: Db): Db => ({
      prepare: (sql) => {
        if (fail && /FROM fomo_events WHERE user_id = \?/.test(sql)) throw new Error("connection reset");
        return x.prepare(sql);
      },
      exec: (q) => x.exec(q),
      tx: (fn) => x.tx((t) => fn(wrap(t))),
    });
    const h = await harness({ raw, db: wrap(inner) });
    await store.insertCohortVersion(h.db, cohort(1, [FRANK, STAR]));
    fail = true;
    const env = await h.invoke<TokenActivityData>("fomo_get_token_activity", { cohort_only: true });
    assert.notEqual(env.status, "empty");
    assert.notEqual(env.status, "ok");
  });
});

describe("open coverage gaps reach research too (C6)", () => {
  it("a gap in the 24h window makes research partial, says so, and supports no change claim", async () => {
    const h = await harness();
    await streamIsCurrent(h);
    await store.recordGap(h.db, "alerts", NOW - 6 * HOUR_MS, NOW - 2 * HOUR_MS, "stream-backpressure", NOW);
    const env = await h.invoke<ResearchCoinData>("fomo_research_coin", { token: PONS, chain: "robinhood" });
    assert.equal(env.status, "partial");
    assert.ok(env.coverage.notes.some((n) => /open gap/.test(n)), env.coverage.notes.join(" | "));
    const text = renderEnvelope(env, { audience: "owner", maxChars: 4000, now: NOW });
    assert.ok(!/0 buyers \/ 0 sellers/.test(text), "a hole is not observed silence");
    h.clock.now += 60_000;
    await store.setCheckpoint(h.db, "alerts", null, h.clock.now - 5_000, h.clock.now - 1_000);
    const since = await h.invoke<ResearchCoinData>("fomo_research_coin", { token: PONS, chain: "robinhood", since_revision: env.data!.revision });
    assert.equal(since.data?.changes?.comparable, false);
    assert.equal(since.data?.changes?.noChange, false, "'no change' is never claimed across a gap");
  });

  it("old never-closed gaps do not hide a fresh hole from health, research or activity (R5)", async () => {
    const h = await harness();
    await streamIsCurrent(h);
    // Unrecoverable gaps stay open for the whole retention; oldest first, sixty of them filled the old 50-row read.
    for (let i = 0; i < 60; i++) {
      const from = NOW - 25 * DAY_MS + i * 6 * HOUR_MS;
      await store.recordGap(h.db, "alerts", from, from + 60_000, "unrecoverable:page-cap", NOW);
    }
    await store.recordGap(h.db, "alerts", NOW - 3 * HOUR_MS, NOW - 2 * HOUR_MS, "recovery-failed", NOW);
    const health = await h.service.ownerHealth(OWNER, NOW);
    assert.equal(health.state, "watching-condition");
    assert.match(health.detail, /1 gap\(s\) in the last 24h \(about 60 min\)/);
    const env = await h.invoke<ResearchCoinData>("fomo_research_coin", { token: PONS, chain: "robinhood" });
    assert.equal(env.status, "partial");
    assert.equal(env.reason, "activity-incomplete");
    const act = await h.invoke<TokenActivityData>("fomo_get_token_activity", { token: PONS, chain: "robinhood" });
    assert.equal(act.status, "partial");
    assert.ok(act.coverage.notes.some((n) => /1 open gap\(s\) in this window/.test(n)), act.coverage.notes.join(" | "));
  });

  it("more open gaps in the window than one read takes is said as a floor, never an exact count (R5)", async () => {
    const h = await harness();
    await streamIsCurrent(h);
    for (let i = 0; i < 101; i++) await store.recordGap(h.db, "alerts", NOW - 20 * HOUR_MS + i * 60_000, NOW - 20 * HOUR_MS + i * 60_000 + 1_000, "stream-backpressure", NOW);
    const health = await h.service.ownerHealth(OWNER, NOW);
    assert.equal(health.state, "watching-condition");
    assert.match(health.detail, /more than 100 gap\(s\) in the last 24h \(at least \d+ min\)/);
  });
});

describe("the stream record answers alone only for a window it reaches back over (C32)", () => {
  it("just after ingestion starts, a 7d question reads the provider feed instead of reporting 'empty'", async () => {
    const h = await harness();
    await streamIsCurrent(h, null);
    const env = await h.invoke<TokenActivityData>("fomo_get_token_activity", { token: PONS, chain: "robinhood", window: "7d" });
    assert.notEqual(env.status, "empty");
    assert.ok(h.count("/v2/alerts") >= 1, "the cold record is not the whole week");
    assert.ok(env.coverage.notes.some((n) => /does not reach back/.test(n)));
    assert.ok((env.data?.events.length ?? 0) > 0);
  });

  it("once the record provably reaches back over the window, it alone answers", async () => {
    const h = await harness();
    await streamIsCurrent(h, 40 * DAY_MS);
    const env = await h.invoke<TokenActivityData>("fomo_get_token_activity", { token: PONS, chain: "robinhood", window: "7d" });
    assert.equal(h.count("/v2/alerts"), 0);
    assert.ok(env.coverage.notes.some((n) => /live shared feed record/.test(n)));
  });
});

describe("owners see the monitoring health that applies to them (C15)", () => {
  it("not configured, permission off, monitoring off: each said in its own words", async () => {
    assert.equal((await (await harness({ key: false })).service.ownerHealth(OWNER, NOW)).state, "not-configured");
    assert.equal((await (await harness({ access: { dataAccess: false, monitoring: true, follow: false } })).service.ownerHealth(OWNER, NOW)).state, "permission-required");
    const off = await (await harness({ access: { dataAccess: true, monitoring: false, follow: false } })).service.ownerHealth(OWNER, NOW);
    assert.equal(off.state, "research-only");
    assert.match(off.detail, /monitoring is off/);
  });

  it("a stream that is down or stale is never 'arriving normally', even when a lookup just answered", async () => {
    const h = await harness();
    await h.invoke("fomo_get_rankings", { board: "traders" });
    assert.equal((await h.service.ownerHealth(OWNER, NOW)).state, "watching-condition", "no feed has delivered on this install");
    await store.setCheckpoint(h.db, "alerts", null, NOW - HOUR_MS, NOW - HOUR_MS);
    const stale = await h.service.ownerHealth(OWNER, NOW);
    assert.equal(stale.state, "watching-condition");
    assert.match(stale.detail, /not current/);
    const global = await h.service.health(NOW);
    assert.ok(!/arriving normally/.test(global.detail), "a lookup that answered is not a stream that delivers");
    const status = await h.invoke<ResearchStatusData>("fomo_get_research_status", {});
    assert.equal(status.data?.health.state, "watching-condition");
    const text = renderEnvelope(status, { audience: "owner", maxChars: 3000, now: NOW });
    assert.match(text, /Data status: Monitoring is on, but the shared trader feed last delivered/);
    assert.ok(!/arriving normally/.test(text));
  });

  it("open gaps are a watching condition; a current feed without gaps is receiving fresh data", async () => {
    const h = await harness();
    await streamIsCurrent(h);
    assert.equal((await h.service.ownerHealth(OWNER, NOW)).state, "receiving-fresh-data");
    await store.recordGap(h.db, "alerts", NOW - 3 * HOUR_MS, NOW - 2 * HOUR_MS, "recovery-failed", NOW);
    const gap = await h.service.ownerHealth(OWNER, NOW);
    assert.equal(gap.state, "watching-condition");
    assert.match(gap.detail, /1 gap\(s\) in the last 24h/);
  });

  it("a provider that is down is provider-unavailable for the owner too", async () => {
    const h = await harness();
    h.routes.set("leaderboard", () => json({ error: "down" }, 503));
    await h.invoke("fomo_get_rankings", { board: "traders" });
    assert.equal((await h.service.ownerHealth(OWNER, NOW)).state, "provider-unavailable");
  });
});

describe("a room's research lasts the evening (WP10: D7, D8, D10)", () => {
  const G = { audience: "group" as const, surface: "telegram-group" as const, groupId: "-100123" };

  it("a group reuses a coin's theses for two hours; the app chat refreshes them after thirty minutes", async () => {
    const h = await harness();
    await h.invoke<TokenThesesData>("fomo_get_token_theses", { token: PONS, chain: "robinhood" }, G);
    assert.equal(h.count("/v2/thesis/token/"), 1);
    h.clock.now += 31 * 60_000;
    const again = await h.invoke<TokenThesesData>("fomo_get_token_theses", { token: PONS, chain: "robinhood" }, G);
    assert.equal(h.count("/v2/thesis/token/"), 1, "a group's copy is still the set");
    assert.equal(again.freshness.servedFrom, "cache");
    assert.match(renderEnvelope(again, { audience: "group", maxChars: 3_000, now: h.clock.now }), /From a copy fetched 31m ago\./, "always labelled with its age");
    await h.invoke<TokenThesesData>("fomo_get_token_theses", { token: PONS, chain: "robinhood" });
    assert.equal(h.count("/v2/thesis/token/"), 2, "the owner's app chat keeps the class window");
    // Two hours and a minute after the app chat's copy, the newest one.
    h.clock.now += 2 * 3_600_000 + 60_000;
    await h.invoke<TokenThesesData>("fomo_get_token_theses", { token: PONS, chain: "robinhood" }, G);
    assert.equal(h.count("/v2/thesis/token/"), 3, "past two hours a group reads again");
  });

  it("a room's 'now' is never a paid forced refresh: the class window, no group reuse", async () => {
    const h = await harness();
    await h.invoke<RankingsData>("fomo_get_rankings", { board: "trending-tokens" }, G);
    assert.equal(h.count("/v2/leaderboard/tokens/trending"), 1);
    h.clock.now += 3 * 60_000;
    const now3 = await h.invoke<RankingsData>("fomo_get_rankings", { board: "trending-tokens", freshness: "force-refresh" }, G);
    assert.equal(h.count("/v2/leaderboard/tokens/trending"), 1, "inside the board's five minutes: the copy");
    assert.equal(now3.freshness.mode, "prefer-fresh");
    h.clock.now += 3 * 60_000;
    await h.invoke<RankingsData>("fomo_get_rankings", { board: "trending-tokens", freshness: "force-refresh" }, G);
    assert.equal(h.count("/v2/leaderboard/tokens/trending"), 2, "past five minutes: read, not the group's fifteen");
    // The owner's own "now" in her DM is unchanged: a forced read.
    await h.invoke<RankingsData>("fomo_get_rankings", { board: "trending-tokens", freshness: "force-refresh" }, { surface: "telegram-dm" });
    assert.equal(h.count("/v2/leaderboard/tokens/trending"), 3);
  });

  it("a group's ordinary board read reuses the copy for fifteen minutes", async () => {
    const h = await harness();
    await h.invoke<RankingsData>("fomo_get_rankings", { board: "trending-tokens" }, G);
    h.clock.now += 14 * 60_000;
    await h.invoke<RankingsData>("fomo_get_rankings", { board: "trending-tokens" }, G);
    assert.equal(h.count("/v2/leaderboard/tokens/trending"), 1);
    h.clock.now += 2 * 60_000;
    await h.invoke<RankingsData>("fomo_get_rankings", { board: "trending-tokens" }, G);
    assert.equal(h.count("/v2/leaderboard/tokens/trending"), 2);
  });

  it("the owner is told which allowance ran out and when it resets; a room only when to try again", async () => {
    const h = await harness({ budget: { ...GENEROUS, groupHourlyCredits: 1_600 } });
    h.clock.now = Date.parse("2026-10-07T23:05:00Z");
    await h.invoke<TokenThesesData>("fomo_get_token_theses", { token: PONS, chain: "robinhood" }, G);
    const refused = await h.invoke<TokenThesesData>("fomo_get_token_theses", { token: CACHE_TOKEN, chain: "robinhood" }, G);
    assert.equal(refused.status, "budget-limited");
    assert.equal(refused.reason, "budget-group-hourly");
    assert.equal(refused.message, "Fomo research is rationed right now: this group's hourly research allowance is used up; it resets at 00:00 UTC.");
    const room = renderEnvelope(refused, { audience: "group", maxChars: 600, now: h.clock.now });
    assert.equal(room, "fomo lookups for this room are used up for now, try again after 00:00 UTC.");
    assert.doesNotMatch(room, /credit|\d{3,}|group's|your/);

    const t = await harness({ budget: { ...GENEROUS, tenantHourlyCredits: 100 } });
    t.clock.now = Date.parse("2026-10-07T14:59:59Z");
    const mine = await t.invoke("fomo_get_rankings", { board: "traders" });
    assert.equal(mine.message, "Fomo research is rationed right now: your hourly Fomo research allowance is used up; it resets at 15:00 UTC.");
  });
});

describe("one owner's budget refusal is theirs alone (C23)", () => {
  it("tenant A's own cap does not tell tenant B, or the fleet, that Fomo is rationed", async () => {
    const h = await harness({ budget: { sharedDailyCredits: 1_000_000, tenantHourlyCredits: 300, tenantDailyCredits: 300, groupHourlyCredits: 300 } });
    const A = OWNER;
    const B = "0xbbbb000000000000000000000000000000000002";
    const refused = await h.invoke("fomo_get_token_theses", { token: PONS, chain: "robinhood" }, { tenant: A });
    assert.equal(refused.status, "budget-limited");
    assert.match(refused.reason ?? "", /budget-tenant-/);
    assert.equal((await h.service.ownerHealth(A, NOW)).state, "budget-limited", "A is told about A's own cap");
    assert.notEqual((await h.service.ownerHealth(B, NOW)).state, "budget-limited", "B is not");
    assert.equal((await h.service.health(NOW)).budgetLimited, false, "the process-wide health is not");
    const bStatus = await h.invoke<ResearchStatusData>("fomo_get_research_status", {}, { tenant: B });
    assert.notEqual(bStatus.data?.health.state, "budget-limited");
  });

  it("a refusal by the shared pool is fleet-wide", async () => {
    // Owner caps far above the pool: whatever refuses is a limit every owner shares.
    const h = await harness({ budget: { sharedDailyCredits: 100, tenantHourlyCredits: 1_000_000, tenantDailyCredits: 1_000_000, groupHourlyCredits: 1_000_000 } });
    const env = await h.invoke("fomo_get_rankings", { board: "traders" });
    assert.equal(env.status, "budget-limited");
    assert.ok(env.reason === "budget-shared-daily" || env.reason === "budget-class-reserve", env.reason ?? "");
    assert.equal((await h.service.health(NOW)).budgetLimited, true);
    assert.equal((await h.service.ownerHealth("0xbbbb000000000000000000000000000000000002", NOW)).state, "budget-limited", "every owner shares the pool");
  });
});

describe("a queued deep job re-checks the owner's data access when it runs (C24)", () => {
  it("access revoked after asking: the job is cancelled with no provider call", async () => {
    const access: FomoAccess = { dataAccess: true, monitoring: true, follow: false };
    const h = await harness({ access });
    const env = await h.invoke<ResearchCoinData>("fomo_research_coin", { token: "PONS", depth: "deep" });
    const job = env.data!.job!;
    access.dataAccess = false;
    const calls = h.calls.length;
    const ran = await runPendingJobs(h.service, h.db, { now: () => h.clock.now, limit: 5 });
    assert.deepEqual(ran, { claimed: 1, done: 0, failed: 0, cancelled: 1 });
    assert.equal(h.calls.length, calls, "not one provider call charged to an owner who switched Fomo off");
    const stored = await store.getJob(h.db, OWNER, job.id);
    assert.equal(stored?.status, "cancelled");
    assert.equal((stored?.result as Rec | null)?.reason, "data-access-off");
  });
});

describe("a provider's stored fallback copy is labelled stale (C31)", () => {
  it("the most-held board the provider marks stale is never 'ok, live'", async () => {
    const h = await harness();
    const env = await h.invoke<RankingsData>("fomo_get_rankings", { board: "most-held-tokens" });
    assert.equal(env.status, "stale");
    assert.equal(env.reason, "provider-snapshot");
    assert.ok(env.coverage.notes.some((n) => /stored snapshot of the most-held board \(about 2h old\)/.test(n)), env.coverage.notes.join(" | "));
    const text = renderEnvelope(env, { audience: "owner", maxChars: 3000, now: NOW });
    assert.match(text, /stored snapshot of the most-held board/);
    // Served again from our cache, it is still the provider's fallback.
    const cached = await h.invoke<RankingsData>("fomo_get_rankings", { board: "most-held-tokens" });
    assert.equal(cached.freshness.servedFrom, "cache");
    assert.equal(cached.status, "stale");
    // A live board stays live.
    assert.equal((await h.invoke<RankingsData>("fomo_get_rankings", { board: "trending-tokens" })).status, "ok");
  });
});

describe("a full page of one trader's theses is capped (C33)", () => {
  const page = (n: number, total: number | null): Rec => {
    const base = (fixture("theses-token").theses as Rec[])[0]!;
    return {
      totalAvailable: total,
      source: "live",
      theses: Array.from({ length: n }, (_, i) => ({ ...base, id: `th-u${i}`, userId: KALEO, handle: "CryptoKaleo", text: `distinct thesis ${i}`, ts: new Date(NOW - (i + 1) * HOUR_MS).toISOString() })),
    };
  };

  it("trader-only: a full page with a larger provider total is capped, not the whole record", async () => {
    const h = await harness();
    h.routes.set("thesis-user", () => json(page(25, 200), 200, { "x-credits-cost": "1250" }));
    const env = await h.invoke<TokenThesesData>("fomo_get_token_theses", { trader: KALEO });
    assert.equal(env.status, "capped");
    assert.equal(env.coverage.capped, true);
    assert.match(renderEnvelope(env, { audience: "owner", maxChars: 3000, now: NOW }), /More records exist than were read/);
  });

  it("trader + token: a full page is capped even with no per-pair total", async () => {
    const h = await harness();
    h.routes.set("thesis-user", () => {
      const p = page(25, null);
      for (const t of p.theses as Rec[]) t.address = PONS;
      return json(p, 200, { "x-credits-cost": "1250" });
    });
    const env = await h.invoke<TokenThesesData>("fomo_get_token_theses", { trader: KALEO, token: PONS, chain: "robinhood" });
    assert.equal(env.coverage.capped, true);
  });
});

describe("'first seen in this window' needs a baseline before the window (C34)", () => {
  it("an earlier buy before a 7d window is found; a window past retention is unknown, not 'first seen'", async () => {
    const h = await harness();
    await store.insertCohortVersion(h.db, cohort(1, [FRANK]));
    await store.insertEvents(h.db, [buyEvent(FRANK, CACHE_TOKEN, NOW - 9 * DAY_MS, "ev:old"), buyEvent(FRANK, CACHE_TOKEN, NOW - HOUR_MS, "ev:new")]);
    const pick = (e: FomoEnvelope<OpportunitiesData>) => e.data?.rows.find((r) => r.token.address === CACHE_TOKEN)?.signals;
    const week = await h.invoke<OpportunitiesData>("fomo_find_opportunities", { window: "7d" });
    assert.equal(pick(week)?.firstSeenInWindow, false, "the 9-day-old buy is before the window");
    const month = await h.invoke<OpportunitiesData>("fomo_find_opportunities", { window: "30d" });
    assert.equal(pick(month)?.firstSeenInWindow, null, "the record before a 30d window is past retention");
    assert.ok(!/first seen in this window/.test(renderEnvelope(month, { audience: "owner", maxChars: 3000, now: NOW })));
  });

  it("a trader whose read hit its limit leaves first appearance unknown", async () => {
    const h = await harness();
    await store.insertCohortVersion(h.db, cohort(1, [FRANK]));
    const many = Array.from({ length: 100 }, (_, i) => buyEvent(FRANK, PONS, NOW - (i + 1) * 60_000, `ev:busy-${i}`));
    await store.insertEvents(h.db, [buyEvent(FRANK, CACHE_TOKEN, NOW - 30 * 60_000 - 30_000, "ev:cache-now"), ...many]);
    const env = await h.invoke<OpportunitiesData>("fomo_find_opportunities", {});
    const cache = env.data?.rows.find((r) => r.token.address === CACHE_TOKEN);
    assert.notEqual(cache?.signals.firstSeenInWindow, true);
  });
});

describe("trader P&L carries its as-of and drops windows it no longer describes (C35)", () => {
  it("a 24h figure from a five-day-old cohort record is not shown as today's", async () => {
    const h = await harness();
    const c = cohort(1, [KALEO]);
    c.createdAt = NOW - 5 * DAY_MS;
    c.members[0]!.evidence.providerReported = { "pnlUsd.24h": 151_383, "pnlUsd.7d": 9_000 };
    await store.insertCohortVersion(h.db, c);
    const env = await h.invoke<TraderContextData>("fomo_get_trader_context", { trader: "CryptoKaleo" });
    const p = env.data?.profile;
    assert.equal(p?.source, "cohort-evidence");
    assert.equal(p?.asOf, NOW - 5 * DAY_MS);
    assert.equal(p?.mayBeOlder, true);
    assert.ok(!("24h" in (p?.pnlUsd ?? {})), "a 24h figure older than a day describes a different day");
    assert.equal(p?.pnlUsd["7d"], 9_000);
    const text = renderEnvelope(env, { audience: "owner", maxChars: 3000, now: NOW });
    assert.match(text, /as of 5 days ago or earlier\): 7d \+\$9,000/);
    assert.ok(!/151,383/.test(text));
  });
});

describe("a received-only position is not a buy (C36)", () => {
  it("side=buy leaves out a position that was only transferred in; the answer labels such rows", async () => {
    const h = await harness();
    const buys = await h.invoke<TraderActivityData>("fomo_get_trader_activity", { trader: STAR, side: "buy", window: "30d" });
    assert.ok(!buys.data!.positions.some((p) => p.label.symbol === "FU2O"), "FU2O was received, never bought");
    const all = await h.invoke<TraderActivityData>("fomo_get_trader_activity", { trader: STAR, window: "30d" });
    assert.ok(all.data!.positions.some((p) => p.label.symbol === "FU2O"));
    const text = renderEnvelope(all, { audience: "owner", maxChars: 3000, now: NOW });
    assert.match(text, /\$FU2O open, received by transfer \(not bought\)/);
    assert.match(text, /received by transfer, not bought/);
  });
});

describe("reads do not depend on trading or monitoring (C40)", () => {
  it("with trading paused and monitoring and follow off, lookups still answer", async () => {
    const prior = process.env.MERRYMEN_HOME;
    const home = mkdtempSync(path.join(os.tmpdir(), "fomo-paused-"));
    process.env.MERRYMEN_HOME = home;
    try {
      writeFileSync(homePaths.paused(), "paused", "utf8");
      assert.ok(existsSync(homePaths.paused()), "the pause marker the tick loop honours is set");
      const h = await harness({ access: { dataAccess: true, monitoring: false, follow: false } });
      for (const [tool, args] of [
        ["fomo_get_token_theses", { token: PONS, chain: "robinhood" }],
        ["fomo_get_rankings", { board: "traders" }],
        ["fomo_research_coin", { token: PONS, chain: "robinhood" }],
        ["fomo_get_research_status", {}],
      ] as const) {
        const env = await h.invoke(tool, args);
        assert.ok(!["not-authorized", "failed", "unavailable"].includes(env.status), `${tool}: ${env.status} ${env.reason}`);
        assert.ok(env.data !== null, tool);
      }
      assert.ok(h.calls.length > 0);
    } finally {
      if (prior === undefined) delete process.env.MERRYMEN_HOME;
      else process.env.MERRYMEN_HOME = prior;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("research status never reads a dead job as in progress, and shows capabilities (C16/C37, C41)", () => {
  it("a job past its deadline is expired; the text says it did not finish and lists unverified routes", async () => {
    const h = await harness();
    const env = await h.invoke<ResearchCoinData>("fomo_research_coin", { token: "PONS", depth: "deep" });
    assert.ok(env.data?.job);
    h.clock.now += DEEP_JOB_DEADLINE_MS + 60_000;
    const status = await h.invoke<ResearchStatusData>("fomo_get_research_status", {});
    assert.equal(status.data?.jobs[0]?.status, "expired");
    const text = renderEnvelope(status, { audience: "owner", maxChars: 3000, now: h.clock.now });
    assert.ok(!/in progress/.test(text), text);
    assert.match(text, /1 deeper research job did not finish before the deadline/);
    assert.match(text, /Provider routes: \d+ verified/);
    assert.match(text, /Not yet verified by a call: [^.]*ws-alerts/);
    assert.ok(status.data?.capabilitiesUnverified?.includes("ws-alerts"));
    // The same deep request the same day is today's dead job: nothing promises it again.
    const again = await h.invoke<ResearchCoinData>("fomo_research_coin", { token: "PONS", depth: "deep" });
    assert.equal(again.data?.job?.status, "expired");
    assert.notEqual(again.reason, "deep-research-queued");
    assert.ok(!/is queued/.test(renderEnvelope(again, { audience: "owner", maxChars: 3000, now: h.clock.now })));
  });
});

describe("live provider shapes, as the service reads them (2026-10-04)", () => {
  it("a 5xx the provider marks transient fails that read, and is not 'provider unavailable'", async () => {
    const h = await harness();
    h.routes.set("leaderboard", () => json({ error: "FOMO did not answer in time", retryable: true }, 503, { "x-credits-cost": "0" }));
    const env = await h.invoke("fomo_get_rankings", { board: "traders" });
    assert.equal(env.status, "failed", "one subject's slow upstream is a failed read, not an outage");
    assert.notEqual((await h.service.ownerHealth(OWNER, NOW)).state, "provider-unavailable");
    assert.notEqual((await h.service.health(NOW)).state, "provider-unavailable");
    // A plain 503 still is.
    const g = await harness();
    g.routes.set("leaderboard", () => json({ error: "down" }, 503));
    assert.equal((await g.invoke("fomo_get_rankings", { board: "traders" })).status, "unavailable");
    assert.equal((await g.service.ownerHealth(OWNER, NOW)).state, "provider-unavailable");
  });

  it("a transient 5xx after a success leaves the route verified, not down, in the capability table and the status", async () => {
    const h = await harness();
    assert.equal((await h.invoke("fomo_get_rankings", { board: "traders" })).status, "ok");
    h.clock.now += 60_000;
    h.routes.set("leaderboard", () => json({ error: "FOMO did not answer in time", retryable: true }, 503, { "x-credits-cost": "0" }));
    assert.equal((await h.invoke("fomo_get_rankings", { board: "traders", freshness: "force-refresh" })).status, "stale");
    const stored = (await store.listCapabilities(h.db)).find((c) => c.capability === "leaderboard");
    assert.equal(stored?.status, "AUTHENTICATED_TESTED", "one subject's slow upstream does not mark the route unavailable");
    assert.equal(stored?.verifiedAt, NOW, "the last success stays the verdict's time");
    assert.match(stored?.evidence ?? "", /transient: server-error \(HTTP 503\)/);
    const status = await h.invoke<ResearchStatusData>("fomo_get_research_status", {});
    const down = status.data?.capabilitiesDown;
    assert.ok(Array.isArray(down));
    assert.ok(!down.includes("leaderboard"), "the status agrees: the route is not listed as down");
    assert.notEqual(status.data?.health.state, "provider-unavailable");
    // A failure the provider did not call transient does mark it down, in both places.
    h.clock.now += 6 * 60_000;
    h.routes.set("leaderboard", () => json({ error: "down" }, 503));
    await h.invoke("fomo_get_rankings", { board: "traders", freshness: "force-refresh" });
    assert.equal((await store.listCapabilities(h.db)).find((c) => c.capability === "leaderboard")?.status, "UNAVAILABLE");
    assert.ok((await h.invoke<ResearchStatusData>("fomo_get_research_status", {})).data?.capabilitiesDown?.includes("leaderboard"));
  });

  it("a captured board the provider calls current, minutes old, stays ok and says where it came from", async () => {
    const h = await harness();
    h.routes.set("board-trending", () => json({ ...fixture("token-board-trending"), source: "captured", stale: false, ageHours: 0.1 }));
    const env = await h.invoke<RankingsData>("fomo_get_rankings", { board: "trending-tokens" });
    assert.equal(env.status, "ok");
    assert.ok(env.coverage.notes.some((n) => /captured copy of the trending board .*marks as current/.test(n)), env.coverage.notes.join(" | "));
    assert.ok(!env.coverage.notes.some((n) => /stored snapshot/.test(n)));

    // Stale by its own word, or old, or silent about staleness: still a stored fallback.
    for (const over of [{ stale: true, ageHours: 0.1 }, { stale: false, ageHours: 2 }, { ageHours: 0.1 }]) {
      const g = await harness();
      g.routes.set("board-trending", () => json({ ...fixture("token-board-trending"), source: "captured", stale: undefined, ...over }));
      const e = await g.invoke<RankingsData>("fomo_get_rankings", { board: "trending-tokens" });
      assert.equal(e.status, "stale", JSON.stringify(over));
      assert.equal(e.reason, "provider-snapshot");
    }
  });

  it("an unpriced holding is unknown, not $0: chain totals sum priced rows and count the rest", async () => {
    const h = await harness();
    h.routes.set("balances", () => json({ ...fixture("live-shape-balances"), key: KALEO }));
    const env = await h.invoke<TraderContextData>("fomo_get_trader_context", { trader: KALEO, focus: "holdings" });
    const d = env.data!.holdings!;
    assert.equal(d.totalValueUsdFloor, 3600);
    const base = d.byChain.find((c) => c.chain === "base")!;
    assert.deepEqual(base, { chain: "base", rows: 1, valueUsd: null, unpricedRows: 1 });
    assert.deepEqual(d.byChain.find((c) => c.chain === "bsc"), { chain: "bsc", rows: 1, valueUsd: 0, unpricedRows: 0 }, "dust is priced at ~0");
    assert.deepEqual(d.byChain.find((c) => c.chain === "robinhood"), { chain: "robinhood", rows: 1, valueUsd: 2500, unpricedRows: 0 });
    assert.equal(d.rows.find((r) => r.symbol === "FBASE")?.valueUsd, null);
    assert.ok(env.coverage.notes.some((n) => /1 holding\(s\) have no provider valuation/.test(n)), env.coverage.notes.join(" | "));
  });

  it("fills from a provider that serves only a recent window are capped, and say so", async () => {
    const h = await harness();
    h.routes.set("swaps", () => json({ ...fixture("swaps"), moreAvailable: false, complete: false }));
    const env = await h.invoke<TraderActivityData>("fomo_get_trader_activity", { trader: STAR, window: "30d", token: "PONS" });
    assert.equal(env.status, "capped");
    assert.ok(env.coverage.notes.some((n) => /recent window/.test(n)), env.coverage.notes.join(" | "));

    const g = await harness();
    g.routes.set("swaps", () => json({ ...fixture("swaps"), moreAvailable: false, complete: true }));
    const whole = await g.invoke<TraderActivityData>("fomo_get_trader_activity", { trader: STAR, window: "30d", token: "PONS" });
    assert.ok(!whole.coverage.notes.some((n) => /recent window/.test(n)));
  });
});
