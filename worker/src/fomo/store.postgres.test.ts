/**
 * REAL POSTGRES: THE FOMO STORE'S SCHEMA, ITS RACES AND EVERY STATEMENT. Opt-in.
 *
 * HOW TO RUN — against a disposable LOCAL Postgres only (the test refuses any
 * other host, and never reads DATABASE_URL):
 *
 *   MERRYMEN_TEST_PG_URL=postgres://merrymen@localhost:55432/merrymen_pgtest \
 *     npx tsx --test worker/src/fomo/store.postgres.test.ts
 *
 * (MERRYMEN_TEST_POSTGRES_URL works too.) With neither set it is skipped, so
 * `npm test` and CI need no database and no `pg`. Each run works in a schema
 * of its own, `mm_fomo_store_test_<hex>`, dropped at the end.
 *
 * WHY. store.test.ts runs every statement on sqlite and checks its
 * translation, but only Postgres can say whether two services creating the
 * schema at once collide, whether READ COMMITTED lets two writers past a cap,
 * whether overlapping event batches deadlock, and whether each translated
 * statement is actually accepted (parameter types included).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { makePgDb, type Db } from "../db";
import * as store from "./store";
import type { CohortMember, FollowAssessment, TokenIdentity, TraderEvent } from "./types";

const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;

interface PgClient {
  connect(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}
// LOADED ONLY WHEN A DATABASE IS NAMED: `pg` is not a dependency of this repo
// (the production image installs it), so a top-level require would fail the
// whole file in CI instead of skipping it.
const pg = (url ? createRequire(import.meta.url)("pg") : null) as { Client: new (c: { connectionString: string }) => PgClient } | null;

// Every export reached goes through this; the last step insists all were.
const called = new Set<string>();
const S = new Proxy(store, {
  get(target, key, receiver) {
    const v = Reflect.get(target, key, receiver) as unknown;
    if (typeof v === "function" && typeof key === "string") called.add(key);
    return v;
  },
}) as typeof store;

const T0 = 1_760_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const A = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const a = A.toLowerCase();
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const EVM = `0x${"cd".repeat(20)}`;
const TOKEN: TokenIdentity = { chain: { namespace: "eip155", networkId: 4663, slug: "robinhood" }, address: EVM, key: `eip155:4663:${EVM}` };

function ev(eventKey: string, observedAt = T0): TraderEvent {
  return {
    eventKey, identityBasis: "provider-event-id", identityAmbiguous: false, source: "stream", kind: "buy",
    trader: { userId: "u-1", handle: "alice", displayName: null, verified: null }, token: TOKEN, tokenLabel: { symbol: "CD", name: null },
    tradeId: null, swapId: null, transferId: null, txHash: null, fillUsd: null, fillUsdBasis: null, positionValueUsd: 1_000.5,
    positionRealizedPnlUsdCumulative: null, sourceEventAt: observedAt - 5_000, execAt: null, observedAt, verification: "provider-reported",
    text: "untrusted \u0000 text", replay: false,
  };
}

function assessment(id: string, tenant: string, createdAt: number): FollowAssessment {
  return {
    id, tenant, token: TOKEN, label: { symbol: "CD", name: null }, triggerEventKeys: ["ev:1"], state: "WATCH", reasonCodes: ["r"],
    supporting: [], opposing: [], signalDelayMs: null, researchDelayMs: null, priceMovePct: null,
    decisionQuote: { price8: "1.00000000", at: createdAt, source: "quoter" }, setupExpiresAt: null, horizon: null, invalidation: [],
    sizeCeilingUsdg6: "1000000", dossierRevision: null, executionAvailability: "unsupported-venue", createdAt,
  };
}

function member(userId: string, score: number): CohortMember {
  return {
    trader: { userId, handle: `h-${userId}`, displayName: null, verified: null }, score, reasons: ["x"], followable: true,
    evidence: { providerReported: { pnl: 1.5 }, reconstructed: {}, prospective: { p: null } }, sampleSize: null, includedAt: T0,
  };
}

test("Postgres: the fomo store", { skip: !url, timeout: 120_000 }, async (t) => {
  const target = new URL(url!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "only a disposable LOCAL Postgres is allowed");
  const schema = `mm_fomo_store_test_${randomBytes(8).toString("hex")}`;
  assert.match(schema, /^mm_fomo_store_test_[a-f0-9]{16}$/);
  const scoped = (who: string) => {
    const u = new URL(target);
    u.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=20000 -c lock_timeout=10000`);
    u.searchParams.set("application_name", `merrymen-fomo-test-${who}`);
    return u.toString();
  };
  const admin = new pg!.Client({ connectionString: target.toString() });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    // Two pools, as the web tier and the orchestrator would hold.
    const one = await makePgDb(scoped("web"));
    const two = await makePgDb(scoped("orchestrator"));
    const both = <T>(fn: (db: Db, i: number) => Promise<T>, n: number) => Promise.all(Array.from({ length: n }, (_, i) => fn(i % 2 ? two : one, i)));

    await t.test("two services create the schema at the same moment, and again on restart", async () => {
      await Promise.all([S.ensureFomoSchema(one, "postgres"), S.ensureFomoSchema(two, "postgres")]);
      await S.ensureFomoSchema(await makePgDb(scoped("restart")), "postgres");
      const r = await admin.query("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name", [schema]);
      assert.deepEqual(r.rows.map((x) => x.table_name), [...S.FOMO_TABLES].sort());
      const ids = await admin.query(
        "SELECT table_name FROM information_schema.columns WHERE table_schema = $1 AND is_identity = 'YES' ORDER BY table_name",
        [schema],
      );
      assert.deepEqual(ids.rows.map((x) => x.table_name), ["fomo_coverage_gaps", "fomo_dead_letters", "fomo_funnel", "fomo_publications"]);
      // The alter guard reads information_schema per table and runs only what is missing.
      const alter = { table: "fomo_meta", column: "probe_note", ddl: "ALTER TABLE fomo_meta ADD COLUMN probe_note TEXT" };
      assert.deepEqual(await S.applyFomoAlters(one, "postgres", [alter]), [alter.ddl]);
      assert.deepEqual(await Promise.all([S.applyFomoAlters(one, "postgres", [alter]), S.applyFomoAlters(two, "postgres", [alter])]), [[], []]);
    });

    await t.test("races between pools hold every cap and dedupe", async () => {
      // Overlapping event batches in opposite orders: no deadlock, each key inserted once.
      const keys = Array.from({ length: 60 }, (_, i) => `ev:${String(i).padStart(3, "0")}`);
      const [fwd, rev] = await Promise.all([
        S.insertEvents(one, keys.map((k) => ev(k))),
        S.insertEvents(two, [...keys].reverse().map((k) => ev(k))),
      ]);
      assert.equal(fwd.length + rev.length, keys.length);
      assert.deepEqual([...fwd, ...rev].sort(), keys);

      const took = await both((db) => S.takeAllowance(db, "credits:race", 1, 7, T0), 20);
      assert.equal(took.filter(Boolean).length, 7);
      assert.equal(await S.readAllowance(one, "credits:race"), 7);

      const leases = await both((db, i) => S.claimLease(db, "stream", `holder-${i}`, T0, MIN), 6);
      assert.equal(leases.filter(Boolean).length, 1);

      const gaps = await both((db) => S.recordGap(db, "alerts", 1, 2, "x", T0), 4);
      assert.equal(new Set(gaps.map((g) => g.id)).size, 1);
      assert.equal(gaps.filter((g) => g.created).length, 1);

      const tenants = ["0x01", "0x02", "0x03", "0x04", "0x05", "0x06"];
      await both((db, i) => S.enqueueResearch(db, TOKEN.key, "rev-1", 100 + i, [tenants[i]!], T0), 6);
      const claims = await both((db) => S.claimNextResearch(db, T0 + 1, MIN), 4);
      const claim = claims.find((c) => c !== null);
      assert.equal(claims.filter((c) => c !== null).length, 1);
      assert.deepEqual(claim?.tenants, tenants, "no tenant lost to a concurrent enqueue");
      assert.equal(claim?.priority, 105, "the highest priority asked for");

      const dossiers = await both((db, i) => S.insertDossierRevision(db, TOKEN.key, `h-${i}`, { i }, T0 + i), 4);
      assert.deepEqual(dossiers.map((d) => d.dossier.revision).sort(), [1, 2, 3, 4]);
      const sameInputs = await both((db) => S.insertDossierRevision(db, "k:same", "h", { same: true }, T0), 4);
      assert.equal(sameInputs.filter((d) => d.created).length, 1);
      assert.deepEqual(new Set(sameInputs.map((d) => d.dossier.revision)), new Set([1]));

      const jobs = await both(
        (db, i) => S.enqueueJob(db, { tenant: i % 3 ? A : a, idempotencyKey: `q-${i}`, conversationKey: null, surface: "app-chat", kind: "research-coin", params: { i }, deadlineMs: T0 + HOUR, costAllowanceCredits: 250, nowMs: T0 }),
        8,
      );
      assert.equal(jobs.filter((j) => j.ok).length, 3, "the active-job quota holds across pools and tenant spellings");
      const sameKey = await both(
        (db) => S.enqueueJob(db, { tenant: B, idempotencyKey: "same", conversationKey: null, surface: "mcp", kind: "research-coin", params: { x: 1 }, deadlineMs: T0 + HOUR, costAllowanceCredits: null, nowMs: T0 }),
        4,
      );
      assert.equal(new Set(sameKey.map((j) => (j.ok ? j.job.id : "refused"))).size, 1);
      const claimedJobs = await both((db) => S.claimJob(db, T0 + 1, MIN, { tenant: B }), 4);
      assert.equal(claimedJobs.filter((c) => c !== null).length, 1);

      const watches = await both(
        (db, i) => S.addWatch(db, { tenant: A, tokenKey: `k:${i}`, label: { symbol: null, name: null }, nowMs: T0, expiresAtMs: T0 + DAY, createdVia: "app-chat" }),
        30,
      );
      assert.equal(watches.filter((w) => w.ok).length, 25);
      const tails = await both(
        (db, i) => S.addTail(db, { tenant: i % 2 ? A : a, userId: `t-${i}`, handle: `h${i}`, consider: i % 3 === 0, nowMs: T0, expiresAtMs: T0 + 3 * HOUR, createdVia: "telegram-dm" }),
        8,
      );
      assert.equal(tails.filter((t) => t.ok).length, 3, "the tail cap holds across pools and tenant spellings");
      const deps = await both(
        (db, i) => S.addPositionDep(db, { tenant: A, userId: `u-${i}`, tokenKey: TOKEN.key, reason: "held", nowMs: T0, expiresAtMs: T0 + DAY }),
        34,
      );
      assert.equal(deps.filter((d) => d.ok).length, 30);
      const drafts = await both(
        (db) => S.insertPublicationDraft(db, { tenant: A, destination: "x", kind: "watching", contentRev: 1, body: "b", evidenceRef: null, decisionId: null, consentScope: null, dedupeKey: "race", fleetKey: "f", nowMs: T0 }),
        4,
      );
      assert.equal(drafts.filter((d) => d !== null).length, 1);
    });

    await t.test("every other statement is accepted by Postgres", async () => {
      const db = one;
      // events
      assert.deepEqual(await S.markRetracted(db, "ev:000"), { newlyRetracted: true, tokenKey: TOKEN.key });
      assert.equal((await S.eventsForToken(db, TOKEN.key, 0, 500)).length, 59);
      assert.equal((await S.eventsForTrader(db, "u-1", 0, 500, { includeRetracted: true })).length, 60);
      assert.equal((await S.eventsForToken(db, TOKEN.key, 0, 1))[0]?.text, "untrusted \u0000 text", "NUL survives inside JSON text");
      assert.equal((await S.unprocessedEvents(db, 500)).length, 60);
      assert.equal(await S.markEventsProcessed(db, ["ev:001", "ev:002"], T0), 2);
      // checkpoints, gaps, dead letters
      assert.equal(await S.setCheckpoint(db, "alerts", "c1", null, T0), true);
      assert.equal(await S.setCheckpoint(db, "alerts", "c2", 100, T0), true);
      assert.equal(await S.setCheckpoint(db, "alerts", "c3", 99, T0), false);
      assert.equal(await S.setCheckpoint(db, "alerts", "c4", null, T0), false);
      assert.deepEqual(await S.getCheckpoint(db, "alerts"), { stream: "alerts", cursor: "c2", newestTsMs: 100, updatedAtMs: T0 });
      const gap = (await S.listOpenGaps(db, "alerts", 10))[0]!;
      assert.equal((await S.listOpenGaps(db, null, 10)).length, 1);
      assert.equal(await S.markGapRecovered(db, gap.id, T0), true);
      await S.deadLetter(db, "alerts", "raw \u0000 frame", "bad json", T0);
      assert.equal((await S.listDeadLetters(db, 10, "alerts"))[0]?.payload, "raw � frame", "Postgres TEXT refuses NUL; it is replaced");
      assert.equal((await S.listDeadLetters(db, 10)).length, 1);
      // capabilities, traders, cohorts
      assert.equal(await S.upsertCapability(db, { capability: "leaderboard", route: "GET /v2/leaderboard", status: "DOCUMENTED", evidence: "openapi", verifiedAt: T0 }), true);
      assert.equal((await S.listCapabilities(db)).length, 1);
      await S.upsertTrader(db, { userId: "u-1", handle: "@Alice", displayName: "A", verified: true }, T0);
      await S.upsertTraders(db, [{ userId: "u-1", handle: "alicia", displayName: null, verified: null }], T0 + 1);
      assert.equal((await S.traderByHandle(db, "alice"))?.handleIsCurrent, false);
      assert.deepEqual((await S.traderById(db, "u-1"))?.verified, true);
      assert.deepEqual((await S.handleHistory(db, "u-1")).map((h) => h.handle), ["alicia", "alice"]);
      const members = Array.from({ length: 120 }, (_, i) => member(`m-${i}`, 1 - i / 1000));
      assert.equal(await S.insertCohortVersion(db, { version: 1, createdAt: T0, target: 150, members, shortfallReason: "short", changes: [{ userId: "m-0", change: "added", reason: "r" }] }, { k: 1 }), true);
      assert.equal(await S.insertCohortVersion(two, { version: 1, createdAt: T0, target: 150, members, shortfallReason: null, changes: [] }), false);
      const latest = await S.latestCohort(db);
      assert.deepEqual([latest?.cohort.members.length, latest?.cohort.members[0]?.trader.handle, latest?.cohort.members[0]?.score], [120, "h-m-0", 1]);
      assert.equal((await S.cohortByVersion(db, 1))?.cohort.changes.length, 1);
      // cache and dossiers
      assert.equal(await S.cachePut(db, { cacheKey: "c", dataClass: "boards", payload: { x: 1.25 }, retrievedAtMs: T0, providerAsOfMs: T0 - 1, meta: { m: 1 } }), true);
      await S.cacheMarkAttempt(db, "c", "boards", "failed", T0 + 1);
      assert.deepEqual([(await S.cacheGet(db, "c"))?.payload, (await S.cacheGet(db, "c"))?.lastAttemptOutcome], [{ x: 1.25 }, "failed"]);
      assert.equal((await S.latestDossier(db, TOKEN.key))?.revision, 4);
      assert.equal((await S.dossierRevision(db, TOKEN.key, 1))?.revision, 1);
      // budgets
      await S.returnAllowance(db, "credits:race", 2, T0);
      assert.equal(await S.readAllowance(db, "credits:race"), 5);
      const holder = (await admin.query(`SELECT v FROM ${schema}.fomo_meta WHERE k = 'lease:stream'`)).rows[0]?.v as string;
      assert.equal(await S.releaseLease(db, "stream", holder, T0), true);
      await S.recordUsage(db, S.usageDay(T0), "leaderboard", 2, null);
      assert.deepEqual(await S.usageForDay(db, S.usageDay(T0)), [{ bucket: "leaderboard", calls: 2, credits: 0, uncountedCalls: 2 }]);
      // research
      const c = await S.claimNextResearch(db, T0 + 2 * MIN, MIN);
      assert.equal(c?.attempts, 2, "the lapsed claim is taken again");
      assert.equal((await S.finishResearch(db, c!, "done")).ok, true);
      // requests, jobs
      assert.equal(await S.logRequest(db, { requestId: "r1", tenant: A, surface: "mcp", tool: "fomo_get_rankings", subjectKey: null, nowMs: T0, meta: { a: 1 } }), true);
      assert.equal(await S.completeRequest(db, A, "r1", "ok", T0 + 1), true);
      assert.equal((await S.getRequest(db, a, "r1"))?.status, "ok");
      assert.equal((await S.recentRequests(db, A, 10)).length, 1);
      assert.equal(await S.countRequestsSince(db, A, 0), 1);
      const claimed = (await S.claimJob(db, T0 + 2, MIN))!;
      assert.equal(await S.heartbeatJob(db, claimed, T0 + 3, MIN), true);
      assert.equal(await S.finishJob(db, claimed, { status: "done", result: { ok: true } }), true);
      assert.equal((await S.jobsAwaitingDelivery(db, 10)).length, 1);
      assert.equal(await S.markJobDelivered(db, claimed.tenant, claimed.id, T0 + 4), true);
      assert.equal((await S.getJob(db, claimed.tenant, claimed.id))?.status, "done");
      const queued = (await S.recentJobs(db, A, 10)).find((j) => j.status === "queued")!;
      assert.equal(await S.cancelJob(db, A, queued.id), true);
      assert.ok((await S.sweepJobs(db, T0 + 2 * HOUR)) >= 1);
      // subjects, watches, routes
      assert.equal(await S.setSubject(db, A, "conv", JSON.stringify({ version: 1 }), T0), true);
      assert.deepEqual(await S.getSubject(db, A, "conv"), { json: JSON.stringify({ version: 1 }), updatedAtMs: T0 });
      assert.equal(await S.clearSubject(db, A, "conv"), true);
      assert.equal((await S.activeWatches(db, A, T0)).length, 25);
      assert.equal(await S.removeWatch(db, A, (await S.activeWatches(db, A, T0))[0]!.tokenKey), true);
      assert.deepEqual(await S.tenantsWatching(db, "k:none", T0), []);
      assert.equal((await S.watchedTokenKeys(db, T0, 100)).length, 24);
      // tails
      const tailed = await S.activeTails(db, A, T0);
      assert.equal(tailed.length, 3);
      assert.equal(typeof tailed[0]!.consider, "boolean", "consider reads back as a boolean from a BIGINT");
      const owners = await S.tailOwners(db, T0, 10);
      assert.equal(owners.size, 3);
      assert.deepEqual(owners.get(tailed[0]!.userId), [a]);
      assert.deepEqual(await S.recentlyEndedTails(db, A, T0 + 3 * HOUR - MIN, T0 + 3 * HOUR).then((r) => r.length), 3);
      assert.equal(await S.removeTail(db, A, tailed[0]!.userId), true);
      assert.equal(await S.removeAllTails(db, A, T0), 2);
      assert.equal(await S.setTenantRoute(db, A, { dataAccess: true, monitoring: true, follow: false }, T0), true);
      assert.deepEqual(await S.routedTenants(db, "monitoring"), [a]);
      assert.deepEqual(await S.routedTenants(db, "follow"), []);
      assert.deepEqual(await S.routedTenants(db, "data-access"), [a]);
      assert.equal((await S.getTenantRoute(db, A))?.monitoring, true);
      // assessments, outcomes, dependencies
      assert.equal(await S.insertAssessment(db, assessment("as-1", A, T0)), true);
      assert.equal((await S.latestAssessment(db, A, TOKEN.key))?.sizeCeilingUsdg6, "1000000");
      assert.equal((await S.recentAssessments(db, A, 10)).length, 1);
      assert.equal(await S.upsertOutcome(db, { tenant: A, assessmentId: "as-1", horizonLabel: "1h", observedAtMs: T0, price8: "1.5", note: null }), true);
      assert.equal(await S.upsertOutcome(two, { tenant: A, assessmentId: "as-1", horizonLabel: "1h", observedAtMs: T0 + 1, price8: "1.6", note: "again" }), true);
      assert.equal(await S.upsertOutcome(db, { tenant: B, assessmentId: "as-1", horizonLabel: "1h", observedAtMs: T0, price8: "9", note: null }), false);
      assert.equal((await S.outcomesFor(db, A, "as-1"))[0]?.price8, "1.6");
      assert.equal((await S.activePositionDeps(db, T0)).length, 30);
      const held = await S.activePositionDeps(db, T0, A);
      assert.equal(held.length, 30);
      // Which 30 of the 34 racing adds won is up to the race; remove one that did.
      assert.equal(await S.removePositionDep(db, A, held[0]!.userId, TOKEN.key), true);
      assert.equal(await S.expirePositionDeps(db, T0 + DAY), 29);
      // publications
      const id = (await S.insertPublicationDraft(db, {
        tenant: A, destination: "x", destinationAccount: "acct", kind: "researching", tokenKey: TOKEN.key, subjectKey: TOKEN.key, contentRev: 2,
        body: "b", evidenceRef: "fomo:dossier/d@1", decisionId: null, consentScope: "x-research-posts", dedupeKey: "p-1", fleetKey: "f",
        state: "queued", extra: { coinName: "CD" }, nowMs: T0, dueAtMs: T0,
      }))!;
      assert.equal((await S.publicationsByState(db, "queued", T0, 10)).length, 1);
      assert.equal(await S.transitionPublication(db, id, ["queued"], "sending", { nowMs: T0 + 1, bumpAttempts: true, reason: null }), true);
      assert.equal(await S.transitionPublication(db, id, "sending", "uncertain", { nowMs: T0 + 2, externalId: null, sentAtMs: null, dueAtMs: T0 + 3, attempts: 1, requeuedAfterAbsent: true, reconcileChecks: 2, tenant: A }), true);
      assert.equal((await S.publicationsInState(db, "uncertain", T0 + 3, 10)).length, 1);
      assert.equal(await S.fleetCount(db, "f", 0), 1);
      assert.equal(await S.subjectPublicationCount(db, A, "researching", TOKEN.key, 0), 1);
      assert.deepEqual((await S.getPublication(db, A, id))?.extra, { coinName: "CD" });
      assert.equal((await S.publicationByIdForPass(db, id))?.reconcileChecks, 2);
      assert.equal((await S.recentPublications(db, A, 10)).length, 2);
      // funnel
      await S.insertFunnel(db, { tenant: A, tokenKey: TOKEN.key, stage: "RESEARCH_INCOMPLETE", detail: null, decisionId: null, atMs: T0 });
      await S.insertFunnel(db, { tenant: A, tokenKey: TOKEN.key, stage: "MODEL_HOLD", detail: "d", decisionId: "dec-1", atMs: T0 + 1 });
      assert.equal((await S.funnelForToken(db, A, TOKEN.key, 10)).length, 2);
      assert.deepEqual(await S.funnelSummary(db, A, 0), { events: { RESEARCH_INCOMPLETE: 1, MODEL_HOLD: 1 }, latestByToken: { MODEL_HOLD: 1 } });
      // retention runs, and removes what is past its window
      const deleted = await S.pruneFomo(db, T0 + 500 * DAY);
      assert.equal(deleted.length, S.fomoRetentionStatements(T0).length);
      assert.ok(deleted.reduce((x, y) => x + y, 0) > 0);
      // the pure helpers, for completeness of the check below
      assert.equal(S.tenantKey(A), a);
      assert.equal(S.normalizeHandle("@X"), "x");
      assert.equal(S.traderEventOf(ev("ev:x"))?.eventKey, "ev:x");
      assert.equal(S.followAssessmentOf(assessment("as-x", A, T0))?.tenant, a);
    });

    await t.test("every exported function ran against Postgres", () => {
      const exported = Object.entries(store).filter(([, v]) => typeof v === "function").map(([k]) => k);
      assert.deepEqual(exported.filter((k) => !called.has(k)), []);
    });
  } finally {
    // Only this run's own schema, whose name was checked before it was made.
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
});
