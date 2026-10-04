/**
 * THE FLEET'S FOMO PASS, FROM THE ORCHESTRATOR — shared ingestion, the trader
 * cohort, the research queue, each child's `fomo.json` and publication drafts
 * (docs/fomo.md "Shared ingestion").
 *
 * WHY THIS LIVES BESIDE orchestrator.ts AND NOT UNDER fomo/. The pass joins
 * pieces nothing under fomo/ may join: the orchestrator's lease roster and
 * held-coin mirror, the X posting consent in xpost/ (fomo/boundary.test.ts
 * forbids fomo/ from importing it), and the child homes. orchestrator*.ts is
 * the one place allowed to hold all of them, so this file takes them as
 * INJECTED DEPENDENCIES and orchestrator.ts supplies the real ones. That is
 * also what makes it testable with an in-memory store and a fake socket.
 *
 * ONE PASS, STARTED NEVER AWAITED, BEHIND AN IN-FLIGHT LATCH, NEVER FATAL. The
 * orchestrator calls `start(roster, now)` every 15 s reconcile; a pass still
 * running when the next one comes is not doubled. Every step is caught on its
 * own: a provider outage, a slow database or a malformed row costs that step
 * this pass, never the reconcile, the watchdog or another step.
 *
 * WHO DOES WHAT, AND WHY IT IS SPLIT THAT WAY
 *
 *   every replica, for ITS roster   tenant routes, held sets, child files,
 *                                   publication drafts. A tenant is ours to
 *                                   act for only while this replica holds its
 *                                   lease healthily; the roster is exactly
 *                                   those.
 *   one replica (the fleet lease)   the stream, REST recovery, the cohort and
 *                                   its enrichment, the research queue, jobs,
 *                                   the outbox and retention. One stream per
 *                                   FLEET: the provider bills per connection
 *                                   and per recovery page, and N replicas
 *                                   each ingesting would spend N times for
 *                                   the same events.
 *
 * THE SHARED STORE IS THE MEETING POINT, NOT THE LEADER'S MEMORY. The leader
 * persists every event before routing it; each replica writes its roster's
 * routes and held sets (fomo_tenant_routes, fomo_held_tokens); the leader's
 * interest is read back from those (fleetInterest), and every replica builds
 * its children's files from the same rows (signalsFor). So an owner whose
 * child runs on a follower gets the cohort's coins and has its holdings
 * protected exactly as one on the leader, and a lease handover loses nothing
 * that was not already durable. An owner who leaves every roster stops being
 * refreshed, and its route goes stale and routes nothing (ROUTE_STALE_MS).
 *
 * WHAT IT NEVER DOES. It places no order, builds no calldata, reads no key
 * (the stream URL arrives built; only its redacted form is ever logged),
 * widens no permission and relaxes no limit. Provider figures stay research
 * data. Thesis, handle and token-name text is carried as data and never
 * interpreted. A child's file carries that tenant's own access, holdings and
 * watches and nothing of any other tenant's. Nothing here sends a post: the
 * outbox's sender is never called in this change (see NEVER_SEND).
 */
import type { Db } from "./db";
import { sanitizeText } from "./research/news";
import { postingAccounts } from "./xpost/store";
import type { ChildFomoFile, ChildSignal, FomoAccess, FomoService } from "./fomo/contract";
import {
  canonicalUserId,
  COHORT_TARGET,
  measurePositions,
  RANKING_WINDOWS,
  scoreCandidate,
  selectCohort,
  withEvidence,
  type CohortCandidate,
  type CohortWindowStats,
} from "./fomo/cohort";
import { isRobinhoodToken, robinhoodChain, tokenFromKey, tokenIdentity } from "./fomo/identity";
import {
  createIngestor,
  higherPriority,
  INGEST_DEFAULTS,
  type IngestConfig,
  type IngestHealth,
  type IngestStorePort,
  type Ingestor,
  type InterestSnapshot,
  type NormalizedFrame,
  type RecoverPort,
  type ResearchTask,
} from "./fomo/ingest";
import { lensRefs, renderTraderFlowLens } from "./fomo/lens";
import {
  alertFrameToEvent,
  alertsStreamUrl,
  expectedCredits,
  redactUrl,
  tradeFrameToEvent,
  type AlertsQuery,
  type FomoClient,
  type LeaderboardPage,
  type ProviderFailure,
} from "./fomo/provider";
import {
  admitDraft,
  canTransition,
  consentScopeFor,
  DEFAULT_DELIVERY_POLICY,
  draftPublication,
  nextContentRev,
  processOutbox,
  publicationKindFor,
  type ContentBasis,
  type DossierRef,
  type InterestDisclosure,
  type Publication,
  type PublicationConsentScope,
  type PublicationSender,
  type PublicationStore,
} from "./fomo/publish";
import {
  activePositionDeps,
  activeWatches,
  claimNextResearch,
  deadLetter,
  enqueueResearch,
  ensureFomoSchema,
  eventsForToken,
  finishResearch,
  fleetCount,
  FOMO_LIMITS,
  getCheckpoint,
  heldTokensFleet,
  heldTokensFor,
  insertCohortVersion,
  insertEvents,
  insertPublicationDraft,
  latestCohort,
  latestDossier,
  listCapabilities,
  listOpenGaps,
  markEventsProcessed,
  markGapRecovered,
  markRetracted,
  pruneFomo,
  publicationByIdForPass,
  publicationsByState,
  publicationsInState,
  putTraderEvidence,
  recentActiveTokens,
  recentAssessments,
  recentPublications,
  recordGap,
  recordUsage,
  RESEARCH_PRIORITY,
  routedTenants,
  setCheckpoint,
  setHeldTokens,
  setTenantRoute,
  subjectPublicationCount,
  sweepJobs,
  tenantKey,
  tenantsWatching,
  traderEvidence,
  transitionPublication,
  unprocessedEvents,
  upsertCapability,
  usageDay,
  watchedTokenKeys,
  type ActiveToken,
  type FomoDialect,
  type FomoPublication,
  type StoredDossier,
  type StoredTraderEvent,
  type StoredTraderEvidence,
} from "./fomo/store";
import { AlertStream, type ClockPort, type SocketLike, type StreamState, type StreamStateDetail, type TimerPort } from "./fomo/stream";
import { capabilityFromStream, mergeCapability, type StreamProbe } from "./fomo/capabilities";
import type {
  CoinDossier,
  CohortVersion,
  FollowAssessment,
  FomoHealthState,
  PublicationKind,
  RankingWindow,
  ResultStatus,
  RetrievalPriority,
  TokenLabel,
  TraderEvent,
} from "./fomo/types";

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/** The fleet-singleton lease key: not an address, so it can never be a tenant's (the holder-backfill pattern). */
export const FOMO_FLEET_LEASE = "0xfomo-fleet-ingest" as const;
/** The stream name checkpoints, gaps and dead letters are filed under. */
export const FOMO_STREAM = "alerts";
/**
 * Who the fleet's own maintenance reads are charged to: stream recovery, the
 * cohort's leaderboards and its enrichment. Nobody's tenant, and not the
 * research queue's payer (fomo/service.ts SHARED_RESEARCH_TENANT), so each
 * has its own counters and the research cap there leaves this one room.
 */
export const FOMO_FLEET_PAYER = "fomo-fleet-maintenance" as const;

/** The operator's knobs, with their defaults. */
export interface FomoPassKnobs {
  /** How often the leader rebuilds the trader cohort. Four leaderboard reads (1,000 credits) each time. */
  cohortRefreshMs: number;
  cohortTarget: number;
  /** Research-queue items the leader turns into dossier refreshes per pass. */
  maxDossierRefreshesPerPass: number;
  /** A child's fomo.json is rewritten at most this often (sooner when its access changes). */
  childFileEveryMs: number;
  /** The leader's stream and REST recovery. Off: the cohort and research queue still run. */
  ingestEnabled: boolean;
  /** Draft publications from new assessments (they stay blocked by policy; nothing is sent). */
  publishDrafts: boolean;
  /**
   * Traders whose positions are read per cohort refresh (250 credits each,
   * discovery class) to measure what a leaderboard row cannot. Incumbents
   * first, then the strongest challengers.
   */
  enrichPerRefresh: number;
  /** A trader's measured evidence is reused this long before it is read again. */
  traderEvidenceTtlMs: number;
}

export const FOMO_PASS_DEFAULTS: Readonly<FomoPassKnobs> = Object.freeze({
  cohortRefreshMs: 6 * HOUR,
  cohortTarget: COHORT_TARGET,
  maxDossierRefreshesPerPass: 3,
  childFileEveryMs: MIN,
  ingestEnabled: true,
  publishDrafts: true,
  enrichPerRefresh: 20,
  traderEvidenceTtlMs: 3 * 24 * HOUR,
});

/** Signals one child file may carry (the contract's bound). */
export const MAX_CHILD_SIGNALS = 40;
/** Cohort and dependency events per signal (the contract's bound). */
export const MAX_SIGNAL_TRIGGERS = 25;
/**
 * The breadth window: a signal's triggers are the cohort's events on the coin
 * in the last half hour, and a routed coin with nothing newer is forgotten.
 * Long enough to see several traders arrive, short enough that a stale burst
 * does not keep re-presenting itself to the child's review every tick.
 */
export const SIGNAL_WINDOW_MS = 30 * MIN;

/** Settings are re-read at most this often per tenant: a decrypting store read every 15 s per tenant is load for nothing. */
const ACCESS_TTL_MS = MIN;
/** An unchanged route is re-written this often (a change is written at once). */
const ROUTE_REFRESH_MS = 5 * MIN;
/**
 * A route nobody has re-written for this long routes nothing (store
 * routedTenants freshSinceMs). Every replica rewrites its healthy-lease
 * roster's routes every ROUTE_REFRESH_MS, so twelve missed refreshes means no
 * replica acts for that owner any more: grant revoked, killed or expired. The
 * retire paths themselves are left untouched; staleness is what retires the
 * route, on every replica alike, including after a crash.
 */
export const ROUTE_STALE_MS = HOUR;
/** An unchanged held set is re-written this often, so its freshness says a replica still reads that book. */
const HELD_REWRITE_MS = 5 * MIN;
/** A held set no replica has re-written for this long is not used for routing (that replica is gone). */
export const HELD_FRESH_MS = 30 * MIN;
/** Coins with recent cohort activity considered per pass (shared by every tenant's file). */
const COHORT_SIGNAL_SCAN = 60;
/** Coins one owner's own dependency traders touched, per file. */
const DEPENDENCY_SIGNAL_SCAN = 20;
/** Robinhood Chain coins with a recent thesis from anyone, per pass: open-ended discovery, so few. */
const THESIS_SIGNAL_SCAN = 10;
/** Robinhood Chain token keys, for the thesis read's prefix. */
const ROBINHOOD_KEY_PREFIX = "eip155:4663:";
/** A replica that is not the leader asks for the lease this often. */
const LEASE_RETRY_MS = MIN;
/** The leader's interest snapshot (cohort, deps, watches, holdings) is rebuilt this often. */
const INTEREST_REFRESH_MS = MIN;
/** The cohort read for child files and interest is cached this long. */
const COHORT_CACHE_MS = MIN;
/** After a cohort refresh that read nothing, wait this long before spending on another. */
const COHORT_RETRY_MS = 30 * MIN;
/** Drafts are considered at most this often. */
const DRAFT_EVERY_MS = MIN;
const PRUNE_EVERY_MS = HOUR;
/** A claimed research item is someone's for this long; past it, another claim may take it over. */
const RESEARCH_LEASE_MS = 5 * MIN;
/** One background dossier refresh may take this long before the pass stops waiting for it. */
const REFRESH_DEADLINE_MS = 90 * SEC;
/** Distinct watched coins the interest snapshot reads per refresh (one query each). */
const MAX_WATCHED_TOKENS = 500;
/** Events read per coin before the cohort filter (newest first). */
const TRIGGER_SCAN = 200;
/** Assessments looked at per tenant per draft pass. */
const ASSESSMENTS_PER_PASS = 10;
/** With monitoring on, the shared feed counts as fresh while its newest event is this recent. */
const FRESH_FEED_MS = 10 * MIN;
/** A newest-event time further ahead of our clock than this is a bad provider timestamp (the ingestor's own bound). */
const FUTURE_EVENT_SKEW_MS = INGEST_DEFAULTS.futureSkewMs;
/** Health and repeated failures are logged at most this often. */
const LOG_EVERY_MS = 20 * MIN;
/** The stream's unchanged capability verdict is re-written at most this often. */
const STREAM_CAPABILITY_EVERY_MS = 10 * MIN;
/** Connects in a row that end before any welcome, after which the stream is recorded UNAVAILABLE. */
const STREAM_UNAVAILABLE_AFTER = 5;
/** Leaderboard rows per window: the provider's documented maximum. */
const LEADERBOARD_LIMIT = 150;
/** REST recovery page size: the provider's documented maximum for /v2/alerts. */
const RECOVERY_PAGE_LIMIT = 100;
/** Positions read per trader for enrichment: one page, the provider's documented maximum. */
const ENRICH_POSITIONS_LIMIT = 100;
/** Failures after which no further trader is read this refresh: the provider (or our standing with it) is the problem. */
const ENRICH_STOP_ON: ReadonlySet<ProviderFailure> = new Set<ProviderFailure>([
  "no-key",
  "unauthorized",
  "credits-exhausted",
  "entitlement",
  "rate-limited",
  "server-error",
  "unreachable",
  "timeout",
]);

// ── the dependencies ────────────────────────────────────────────────────────

export interface FomoRosterMember {
  tenant: string;
  agentId: string;
}

export interface FomoLeaseHandle {
  release(): Promise<void>;
  /** False once the lease's connection is gone: another replica may lead now. Absent = always healthy. */
  healthy?(): boolean;
}

/**
 * The provider-credit budget, as this pass uses it: one charge before a call,
 * settled with what was billed. Null is a refusal. Optional because the
 * runtime may not expose one; without it the pass records usage and relies on
 * its own cadence (one cohort refresh per six hours, recoveries spaced 30 s).
 *
 * THE FLEET'S BUDGET, NOT AN OWNER'S. orchestrator.ts backs this with the
 * runtime's background budget charged as FOMO_FLEET_PAYER: the shared pool and
 * its class shares bind, one owner's hourly and daily caps do not (they would
 * throttle fleet maintenance by a cap meant for one person's chat).
 */
export interface FomoBudgetPort {
  charge(req: { priority: RetrievalPriority; credits: number; now: number }): Promise<{
    settle(actual: number | null): Promise<void>;
    refund(): Promise<void>;
  } | null>;
}

export interface FomoPassDeps {
  /** The shared ROOT Db (several store calls open their own transaction). */
  db: Db;
  dialect: FomoDialect;
  service: FomoService;
  /** Null without a key: lookups answer not-configured, and no fleet provider work runs. */
  client: FomoClient | null;
  /** Built from the key by `streamEndpointFor`. Only `redacted` is ever logged. */
  streamEndpoint: { url: string; redacted: string } | null;
  createSocket(url: string): SocketLike;
  clock: ClockPort;
  timers: TimerPort;
  random(): number;
  lease: { acquire(): Promise<FomoLeaseHandle | null> };
  /** A tenant's Fomo permissions from TRUSTED settings. A throw skips that tenant this pass. */
  access(tenant: string): Promise<FomoAccess>;
  /**
   * Coins this replica's tenants hold: tokenKey → tenants (the orchestrator's
   * mirror plus the children's IPC reports). The pass writes each roster
   * tenant's set to the shared store (fomo_held_tokens), which is what the
   * ingestion leader and the child files read, so a holding on any replica
   * protects the same way.
   */
  heldTokens(): Map<string, string[]>;
  /**
   * Whether this replica has read the tenant's holdings at all. A draft says
   * "I hold no position in it" only when this is true and the coin is absent
   * from heldTokens; an unread mirror is not an empty book.
   */
  holdingsKnown?(tenant: string): boolean;
  childHome(tenant: string): string;
  writeChildFile(home: string, file: ChildFomoFile): void;
  /** The tenant's connected X account with posting consent, or null. Drafts are made only for tenants with one. */
  xConsent?(tenant: string): Promise<{ accountId: string } | null>;
  /** The durable on-demand job queue (runtime.ts runPendingJobs), one job per leader pass. */
  runJobs?(now: number): Promise<unknown>;
  budget?: FomoBudgetPort;
  log(line: string): void;
  knobs?: Partial<FomoPassKnobs>;
  /** Ingestion tuning (tests shorten the coalescing window). */
  ingestConfig?: Partial<IngestConfig>;
}

export interface FomoPassHealth {
  configured: boolean;
  leader: boolean;
  ingest: "off" | "not-configured" | "follower" | "starting" | "running";
  connected: boolean;
  lastEventAt: number | null;
  openGaps: number | null;
  deadLetters: number | null;
  /** Stream frames waiting to be persisted. */
  queueDepth: number;
  /**
   * Events the leader's ingestion found of interest to someone since this
   * process started. Child files no longer wait on an in-process queue: every
   * replica builds them from the shared store (see signalsFor).
   */
  routed: number;
  lastCohortAt: number | null;
  cohortSize: number | null;
  cohortVersion: number | null;
  /** A due cohort refresh is waiting on the discovery budget; discovery research waits with it. */
  cohortWaitingOnBudget: boolean;
  research: { done: number; retried: number; failed: number };
  childFilesWritten: number;
  drafts: { admitted: number; duplicate: number };
  /** Calls to the publication sender. Zero by construction in this change. */
  senderCalls: number;
  lastPassAt: number | null;
  lastFailure: { at: number; step: string; reason: string } | null;
}

export interface FomoPass {
  /** Start one pass. Never awaited by the caller; a pass still running makes this a no-op. */
  start(roster: readonly FomoRosterMember[], now: number): void;
  health(): FomoPassHealth;
  /** Stop the stream, release the fleet lease, and refuse further passes. */
  stop(): void;
  /** Resolves when the running pass, the ingestor and every pending queue write have settled (tests, shutdown). */
  idle(): Promise<void>;
}

// ── small helpers ───────────────────────────────────────────────────────────

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A line safe to log: key-bearing query values redacted (the stream URL is the
 * one place a key could ride an error), wallet-shaped strings shortened (a
 * tenant IS a wallet, and logs carry no identities), control characters gone.
 */
export function scrubLogText(raw: string, max = 240): string {
  return sanitizeText(redactUrl(raw).replace(/0x[0-9a-fA-F]{40}/g, "0x…"), max);
}

function sanitizedLabel(l: TokenLabel | null | undefined): TokenLabel {
  const symbol = l && typeof l.symbol === "string" ? sanitizeText(l.symbol, 32) || null : null;
  const name = l && typeof l.name === "string" ? sanitizeText(l.name, 64) || null : null;
  return { symbol, name };
}

const PRIORITY_ORDER: Record<RetrievalPriority, number> = { "position-protection": 0, interactive: 1, discovery: 2 };

/** The queue integer back to its class. Unknown is the lowest class: never promoted. */
function priorityOfQueue(n: number): RetrievalPriority {
  if (n >= RESEARCH_PRIORITY["position-protection"]) return "position-protection";
  if (n >= RESEARCH_PRIORITY.interactive) return "interactive";
  return "discovery";
}

function accessKey(a: FomoAccess): string {
  return `${a.dataAccess ? 1 : 0}${a.monitoring ? 1 : 0}${a.follow ? 1 : 0}`;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Strip the store's bookkeeping fields: a child gets the contract's TraderEvent and nothing else. */
function asTraderEvent(e: StoredTraderEvent): TraderEvent {
  const { retracted: _r, processedAtMs: _p, ...rest } = e;
  return rest;
}

/** Race a promise against a deadline on the injected timers. The work is also told to stop through `signal`. */
async function withDeadline<T>(timers: TimerPort, ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  let handle: unknown = null;
  const deadline = new Promise<never>((_, reject) => {
    handle = timers.setTimeout(() => {
      ac.abort();
      reject(new Error(`deadline of ${Math.round(ms / SEC)}s passed`));
    }, ms);
  });
  try {
    return await Promise.race([run(ac.signal), deadline]);
  } finally {
    timers.clearTimeout(handle);
  }
}

// ── adapters over the shared store and the provider ─────────────────────────

/** The stream URL for the leader's one connection, or null without a usable key. Only `redacted` may be logged. */
export function streamEndpointFor(apiKey: string | null): { url: string; redacted: string } | null {
  if (!apiKey) return null;
  // ROBINHOOD CHAIN ONLY, IN THE URL AND IN THE SUBSCRIPTION. The stream exists
  // to notice what the cohort does where Merrymen can act — Robinhood Chain is
  // the only network the executor reaches — and the provider's firehose of
  // every chain would fill the bounded frame queue with events nobody here can
  // follow. On-demand lookups (the broker's tools) still cover every chain.
  const u = alertsStreamUrl(apiKey, { chain: "robinhood" });
  return u.ok ? { url: u.url, redacted: u.redacted } : null;
}

/**
 * One frame (or REST row) to a TraderEvent, or a retraction keyed on the EVENT
 * KEY the retracted alert was filed under (the ingestor marks that key; the
 * provider's own id is not a key here).
 */
export function normalizeAlertFrame(frame: unknown, observedAt: number, source: TraderEvent["source"]): NormalizedFrame {
  if (isObj(frame) && frame.type === "retract") {
    const r = tradeFrameToEvent(frame, observedAt);
    return r && "retract" in r ? { retract: r.eventKey } : null;
  }
  return alertFrameToEvent(frame, observedAt, source);
}

/**
 * The ingestor's store port over store.ts: gap ids stringified both ways, the
 * clock injected where the store wants a write time. insertEvents and the
 * checkpoint are the store's own, so persist-first and monotonic checkpoints
 * hold exactly as store.ts tests them.
 */
export function ingestStoreOver(db: Db, clock: ClockPort): IngestStorePort {
  const gapId = (id: string | number): number => {
    const n = typeof id === "number" ? id : Number(id);
    if (!Number.isSafeInteger(n)) throw new TypeError("fomo pass: a gap id from the store must be an integer");
    return n;
  };
  return {
    insertEvents: (events) => insertEvents(db, events),
    markRetracted: (key) => markRetracted(db, key),
    getCheckpoint: async (stream) => {
      const c = await getCheckpoint(db, stream);
      return c ? { cursor: c.cursor, newestTsMs: c.newestTsMs } : null;
    },
    setCheckpoint: (stream, cursor, newestTsMs) => setCheckpoint(db, stream, cursor, newestTsMs, clock.now()),
    recordGap: async (stream, fromMs, toMs, reason) => String((await recordGap(db, stream, fromMs, toMs, reason, clock.now())).id),
    listOpenGaps: async (stream) =>
      (await listOpenGaps(db, stream, 500)).map((g) => ({ id: String(g.id), fromMs: g.fromMs, toMs: g.toMs, reason: g.reason })),
    markGapRecovered: (id) => markGapRecovered(db, gapId(id), clock.now()),
    deadLetter: (stream, payload, error) => deadLetter(db, stream, payload, error, clock.now()),
    markProcessed: (keys) => markEventsProcessed(db, keys, clock.now()),
    unprocessedEvents: (limit) => unprocessedEvents(db, limit),
  };
}

/**
 * REST recovery through the client, with the SAME chain filter as the stream:
 * an unfiltered walk would page through (and pay for) every chain's events to
 * recover a Robinhood-only gap. Each page is charged before it is asked for
 * and recorded after; a refusal is `budget-limited`, which the ingestor
 * records as a retryable gap and retries with backoff.
 */
export function recoverVia(client: FomoClient, o: { db: Db; clock: ClockPort; budget?: FomoBudgetPort; onUsageError?: (e: unknown) => void }): RecoverPort {
  return async (req) => {
    const now = o.clock.now();
    let grant: Awaited<ReturnType<FomoBudgetPort["charge"]>> = null;
    if (o.budget) {
      try {
        // THE PROTECTION CLASS. A gap in the stream is a gap in what the fleet
        // knows about the traders behind held coins; recovery is what closes
        // it, so it draws on the reserve no discovery or chat read can touch
        // (and background research is capped short of the pool besides).
        grant = await o.budget.charge({ priority: "position-protection", credits: expectedCredits("alerts"), now });
      } catch {
        // The budget's own store is unreachable: no charge, so no call. A
        // retryable gap and the ingestor's backoff take it from here.
        return { ok: false, reason: "budget-unavailable" };
      }
      if (!grant) return { ok: false, reason: "budget-limited" };
    }
    const q: AlertsQuery = { chain: "robinhood", limit: RECOVERY_PAGE_LIMIT };
    if (req.cursor !== undefined) q.cursor = req.cursor;
    if (req.since !== undefined) q.since = req.since;
    if (req.before !== undefined) q.before = req.before;
    let r: Awaited<ReturnType<FomoClient["alerts"]>>;
    try {
      r = await client.alerts(q, "rest-recovery");
    } catch (e) {
      // The client returns failures; a throw is a bug or an abort. Billed or not is unknown: keep the estimate.
      await grant?.settle(null);
      throw e;
    }
    if (r.meta.attempts === 0) await grant?.refund();
    else {
      await grant?.settle(r.meta.creditsCost);
      try {
        await recordUsage(o.db, usageDay(now), "alerts-recovery", 1, r.meta.creditsCost);
      } catch (e) {
        o.onUsageError?.(e);
      }
    }
    if (!r.ok) return { ok: false, reason: r.failure };
    return {
      ok: true,
      normalized: true,
      events: r.data.rows,
      nextCursor: r.data.nextCursor,
      oldestCursor: r.data.oldestCursor,
      hasMore: r.data.hasMore,
      newestTs: r.data.newestTs,
      oldestTs: r.data.oldestTs,
    };
  };
}

/** What a leaderboard answer said about its own age (CallMeta). */
export interface BoardFreshness {
  /** When the provider says its copy was captured, ms; null when it did not say. */
  providerAsOf: number | null;
  /** The provider's own stale flag. */
  stale: boolean | null;
}

/**
 * Leaderboard pages to cohort candidates, one per trader with every window it
 * appeared in. Nothing is invented: a trader's profile, exits and the rest are
 * unmeasured (null) here; the cohort refresh's enrichment (positions, for a
 * bounded few) measures some of them, and the rest stay unknown, which the
 * score holds at the prior. A short cohort says why rather than being padded.
 *
 * lastActiveAt is the one inference, and it is a FLOOR: a trader with trades on
 * the 24h board was active at some point in the 24 hours before THE BOARD WAS
 * CAPTURED. When the provider serves its last captured copy (its upstream did
 * not answer), that is not the last 24 hours before our read, so the floor is
 * anchored at the board's own capture time (`providerAsOf`), and:
 *
 *   a board older than its own window (a 24h board captured two days ago) no
 *     longer says anything about the window it names, and sets nothing;
 *   a board the provider marks stale without saying when it was captured
 *     sets nothing.
 *
 * Unknown is not inactive (cohort.ts COHORT_DEFAULTS.inactiveAfterMs), so
 * this never manufactures an inactivity verdict out of a stale source: a floor
 * it does set is at most two windows old. The 30d and all-time boards prove
 * nothing inside the cohort's 14-day inactivity rule, so they set nothing.
 */
export function cohortCandidatesFrom(
  pages: Partial<Record<RankingWindow, LeaderboardPage>>,
  now: number,
  freshness: Partial<Record<RankingWindow, BoardFreshness>> = {},
): CohortCandidate[] {
  const byId = new Map<string, CohortCandidate>();
  const windowMs: Partial<Record<RankingWindow, number>> = { "24h": 24 * HOUR, "7d": 7 * 24 * HOUR };
  const activeFloor: Partial<Record<RankingWindow, number>> = {};
  for (const w of RANKING_WINDOWS) {
    const span = windowMs[w];
    if (span === undefined) continue;
    const f = freshness[w];
    const asOf = f && typeof f.providerAsOf === "number" && Number.isFinite(f.providerAsOf) ? Math.min(f.providerAsOf, now) : null;
    if (asOf === null && f?.stale === true) continue;
    const anchor = asOf ?? now;
    if (now - anchor > span) continue;
    activeFloor[w] = anchor - span;
  }
  for (const w of RANKING_WINDOWS) {
    const page = pages[w];
    if (!page) continue;
    for (const row of page.rows) {
      const id = row.trader.userId;
      if (typeof id !== "string" || id === "") continue;
      const stats: CohortWindowStats = { rank: row.rank, pnlUsd: row.pnlUsd, volumeUsd: row.volumeUsd, trades: row.trades };
      const c = byId.get(id) ?? { trader: row.trader, windows: {}, lastActiveAt: null };
      c.windows[w] = stats;
      // The shortest window read first is the freshest identity (handle) the provider gave.
      if (!byId.has(id)) byId.set(id, c);
      const floor = activeFloor[w];
      if (floor !== undefined && (row.trades ?? 0) > 0 && (c.lastActiveAt === null || floor > c.lastActiveAt)) c.lastActiveAt = floor;
    }
  }
  return [...byId.values()];
}

/**
 * A stored dossier read back as a CoinDossier, or null. The store keeps it as
 * opaque JSON (dossier.ts owns the shape); this checks the parts a child file
 * and the lens read, and that it is the dossier of THIS token, so a corrupt or
 * misfiled row is absent rather than half-trusted.
 */
export function dossierFromStored(stored: StoredDossier | null, tokenKey: string): CoinDossier | null {
  if (!stored || !isObj(stored.dossier)) return null;
  const d = stored.dossier;
  const token = d.token;
  if (typeof d.dossierId !== "string" || typeof d.revision !== "number" || !Number.isSafeInteger(d.revision)) return null;
  if (!isObj(token) || token.key !== tokenKey || stored.tokenKey !== tokenKey) return null;
  if (!Array.isArray(d.claims) || !Array.isArray(d.evidence) || !Array.isArray(d.unknowns)) return null;
  if (!isObj(d.coverage) || !isObj(d.label) || typeof d.builtAt !== "number") return null;
  return d as unknown as CoinDossier;
}

/** What publish.ts keeps in a row's extra_json: the draft fields store.ts has no column for. */
interface DraftExtra {
  coinName: string;
  interest: InterestDisclosure;
  evidenceCount: number;
  dossierRef: DossierRef | null;
  basis: ContentBasis;
}

const INTERESTS: ReadonlySet<string> = new Set(["no-position", "considering-position", "holds-position", "holds-paper-position"]);
const SCOPES: ReadonlySet<string> = new Set(["x-trade-posts", "x-research-posts"]);

function extraOf(raw: unknown): DraftExtra {
  const x = isObj(raw) ? raw : {};
  const ref = isObj(x.dossierRef) && typeof x.dossierRef.dossierId === "string" && Number.isSafeInteger(x.dossierRef.revision)
    ? { dossierId: x.dossierRef.dossierId, revision: x.dossierRef.revision as number }
    : null;
  const b = isObj(x.basis) ? x.basis : {};
  return {
    coinName: typeof x.coinName === "string" ? x.coinName : "",
    interest: typeof x.interest === "string" && INTERESTS.has(x.interest) ? (x.interest as InterestDisclosure) : "no-position",
    evidenceCount: typeof x.evidenceCount === "number" && Number.isSafeInteger(x.evidenceCount) && x.evidenceCount >= 0 ? x.evidenceCount : 0,
    dossierRef: ref,
    basis: {
      dossierRevision: typeof b.dossierRevision === "number" && Number.isSafeInteger(b.dossierRevision) ? b.dossierRevision : null,
      decisionStatus: typeof b.decisionStatus === "string" ? b.decisionStatus : null,
    },
  };
}

function publicationOfRow(p: FomoPublication): Publication | null {
  // The only destination publish.ts knows. Anything else in the table is not ours to drive.
  if (p.destination !== "x") return null;
  const extra = extraOf(p.extra);
  const tokenKey = p.tokenKey ?? "";
  return {
    id: String(p.id),
    tenant: p.tenant,
    destination: { channel: "x", accountId: p.destinationAccount },
    kind: p.kind,
    state: p.state,
    reason: p.reason,
    body: p.body,
    coinName: extra.coinName,
    interest: extra.interest,
    evidenceCount: extra.evidenceCount,
    tokenKey,
    subjectKey: p.subjectKey ?? tokenKey,
    dedupeKey: p.dedupeKey,
    fleetKey: p.fleetKey ?? "",
    dossierRef: extra.dossierRef,
    decisionId: p.decisionId,
    consentScope: p.consentScope !== null && SCOPES.has(p.consentScope) ? (p.consentScope as PublicationConsentScope) : consentScopeFor(p.kind),
    contentRev: p.contentRev,
    basis: extra.basis,
    createdAt: p.createdAtMs,
    dueAt: p.dueAtMs,
    updatedAt: p.updatedAtMs,
    attempts: p.attempts,
    externalId: p.externalId,
    sentAt: p.sentAtMs,
    requeuedAfterAbsent: p.requeuedAfterAbsent,
    reconcileChecks: p.reconcileChecks,
  };
}

/**
 * publish.ts's PublicationStore port over the shared outbox table. Ids are the
 * store's integers as strings; the draft fields without a column travel in
 * extra_json. A move publish.ts's state machine refuses THROWS, like the
 * reference store: it is a bug to surface, not a lost race to retry.
 */
export function publicationStoreOver(db: Db): PublicationStore {
  const idOf = (id: string): number | null => {
    const n = Number(id);
    return /^\d{1,15}$/.test(id) && Number.isSafeInteger(n) ? n : null;
  };
  return {
    async insertDraft(d) {
      const extra: DraftExtra = { coinName: d.coinName, interest: d.interest, evidenceCount: d.evidenceCount, dossierRef: d.dossierRef, basis: d.basis };
      const id = await insertPublicationDraft(db, {
        tenant: d.tenant,
        destination: d.destination.channel,
        destinationAccount: d.destination.accountId,
        kind: d.kind,
        tokenKey: d.tokenKey,
        subjectKey: d.subjectKey,
        contentRev: d.contentRev,
        body: d.body,
        evidenceRef: d.dossierRef ? `fomo:dossier/${d.dossierRef.dossierId}#r${d.dossierRef.revision}` : null,
        decisionId: d.decisionId,
        consentScope: d.consentScope,
        dedupeKey: d.dedupeKey,
        fleetKey: d.fleetKey,
        state: d.state,
        reason: d.reason,
        extra,
        nowMs: d.createdAt,
        dueAtMs: d.dueAt,
      });
      return id === null ? null : String(id);
    },
    async transition(id, from, to, f) {
      if (!canTransition(from, to)) throw new Error(`fomo outbox: ${from} → ${to} is not a legal move`);
      const n = idOf(id);
      if (n === null) return false;
      return transitionPublication(db, n, from, to, {
        nowMs: f.at,
        reason: f.reason,
        externalId: f.externalId,
        sentAtMs: f.sentAt,
        dueAtMs: f.dueAt,
        attempts: f.attempts,
        requeuedAfterAbsent: f.requeuedAfterAbsent,
        reconcileChecks: f.reconcileChecks,
      });
    },
    recentFleetCount: (fleetKey, sinceMs) => fleetCount(db, fleetKey, sinceMs),
    recentSubjectCount: (tenant, kind, subjectKey, sinceMs) => subjectPublicationCount(db, tenant, kind, subjectKey, sinceMs),
    async get(id) {
      const n = idOf(id);
      if (n === null) return null;
      const row = await publicationByIdForPass(db, n);
      return row ? publicationOfRow(row) : null;
    },
    async dueQueued(nowMs, limit) {
      return (await publicationsByState(db, "queued", nowMs, limit)).flatMap((p) => publicationOfRow(p) ?? []);
    },
    async inState(state, updatedBeforeMs, limit) {
      return (await publicationsInState(db, state, updatedBeforeMs, limit)).flatMap((p) => publicationOfRow(p) ?? []);
    },
  };
}

/**
 * Posting consent from the X tables: the tenant's connected account whose
 * posting is on for the account connected NOW (postingAccounts' own rule).
 * Unreadable (no X tables yet, a database error) is no consent.
 */
export function xpostConsentLookup(db: Db): (tenant: string) => Promise<{ accountId: string } | null> {
  return async (tenant) => {
    try {
      const [account] = await postingAccounts(db, [tenant]);
      return account ? { accountId: account.xUserId } : null;
    } catch {
      return null;
    }
  };
}

/**
 * Held coins per tenant (lowercased Robinhood Chain contract addresses, the
 * mirror's shape) as token keys. Only Robinhood placements: the mirror reads
 * this chain's ledger, and an address that does not parse is dropped.
 */
export function heldTokensFrom(byTenant: ReadonlyMap<string, readonly string[]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const chain = robinhoodChain();
  for (const [tenant, addresses] of byTenant) {
    const t = tenantKey(tenant);
    if (!t) continue;
    for (const a of addresses) {
      const token = tokenIdentity(chain, a);
      if (!token || !isRobinhoodToken(token)) continue;
      const list = out.get(token.key) ?? [];
      if (!list.includes(t)) list.push(t);
      out.set(token.key, list);
    }
  }
  return out;
}

/** Fold the held-tokens reports children sent over IPC (BrokerReport "held-tokens") into the mirror's map. */
export function mergeHeldTokens(...maps: ReadonlyArray<ReadonlyMap<string, readonly string[]> | null | undefined>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of maps) {
    if (!m) continue;
    for (const [key, tenants] of m) {
      const list = out.get(key) ?? [];
      for (const t of tenants) {
        const k = tenantKey(t);
        if (k && !list.includes(k)) list.push(k);
      }
      out.set(key, list);
    }
  }
  return out;
}

/**
 * WHO CARES ABOUT WHAT, READ FROM THE SHARED STORE: the ingestion leader's
 * interest snapshot. Everything in it is durable and fleet-wide, so a tenant
 * whose child runs on another replica is interested exactly as one here is:
 *
 *   routable      owners with data access and monitoring or follow, whose
 *                 route some replica refreshed within ROUTE_STALE_MS. A
 *                 departed owner's stale row routes nothing.
 *   cohort        the latest cohort version's members
 *   dependencies  routable owners' unexpired position dependencies
 *   watched       routable owners' unexpired watches (≤ MAX_WATCHED_TOKENS)
 *   held          fomo_held_tokens rows any replica wrote within
 *                 HELD_FRESH_MS, plus `local` (this replica's own book, in
 *                 case its write of this pass has not landed), for routable
 *                 owners only
 *
 * For the leader's routing and research priority ONLY. A child's file reads
 * its own owner's rows, never this snapshot.
 */
export async function fleetInterest(
  db: Db,
  now: number,
  cohort: CohortVersion | null,
  local: ReadonlyMap<string, readonly string[]> = new Map(),
): Promise<InterestSnapshot> {
  const fresh = { freshSinceMs: now - ROUTE_STALE_MS };
  // ONLY OPTED-IN TENANTS ARE INTERESTED IN ANYTHING. routedTenants already
  // requires data access; monitoring or follow decides whether the shared
  // feed routes to a tenant at all (the settings' own words), so a holding or
  // a watch of a tenant with neither is not interest.
  const routable = new Set([...(await routedTenants(db, "monitoring", fresh)), ...(await routedTenants(db, "follow", fresh))]);
  const dependencies = new Set((await activePositionDeps(db, now)).filter((d) => routable.has(d.tenant)).map((d) => d.userId));
  const watchedTokens = new Map<string, string[]>();
  for (const key of await watchedTokenKeys(db, now, MAX_WATCHED_TOKENS)) {
    const who = (await tenantsWatching(db, key, now)).filter((t) => routable.has(t));
    if (who.length > 0) watchedTokens.set(key, who);
  }
  const heldTokens = new Map<string, string[]>();
  for (const [key, tenants] of mergeHeldTokens(await heldTokensFleet(db, now - HELD_FRESH_MS), local)) {
    const who = tenants.filter((t) => routable.has(t)).sort();
    if (who.length > 0) heldTokens.set(key, who);
  }
  return {
    cohort: new Set((cohort?.members ?? []).map((m) => m.trader.userId)),
    dependencies,
    watchedTokens,
    heldTokens,
    monitoringTenants: [...routable].sort(),
  };
}

// ── the pass ────────────────────────────────────────────────────────────────

/**
 * The outbox's sender in this change: never reached, because every kind's
 * delivery policy is off (X rule 3 and the provider's redistribution terms
 * need review first), so a due row is blocked by policy before any claim. If
 * a future edit ever reaches it, the answer is a NON-retryable refusal, so the
 * row fails closed instead of posting.
 */
function neverSend(onCall: () => void): PublicationSender {
  return async () => {
    onCall();
    return { ok: false, retryable: false, reason: "delivery-disabled" };
  };
}

interface Candidate {
  priority: RetrievalPriority;
  reasons: Set<ChildSignal["reasons"][number]>;
  firstSeenAt: number | null;
  lastSeenAt: number;
  label: TokenLabel | null;
}

const EMPTY_INTEREST: InterestSnapshot = {
  cohort: new Set(),
  dependencies: new Set(),
  watchedTokens: new Map(),
  heldTokens: new Map(),
  monitoringTenants: [],
};

/** Refresh outcomes after which the research item is finished at this evidence revision. */
const RESEARCH_DONE: ReadonlySet<ResultStatus> = new Set<ResultStatus>(["ok", "empty", "partial", "capped", "not-found", "needs-clarification"]);
/** Outcomes that mean "not now": the item goes back, and the pass stops spending on the queue. */
const RESEARCH_BACK_OFF: ReadonlySet<ResultStatus> = new Set<ResultStatus>(["budget-limited", "unavailable"]);

export function makeFomoPass(deps: FomoPassDeps): FomoPass {
  const knobs: FomoPassKnobs = { ...FOMO_PASS_DEFAULTS, ...(deps.knobs ?? {}) };
  const { db, clock, timers } = deps;
  const outbox = publicationStoreOver(db);
  const pending = new Set<Promise<unknown>>();

  let running: Promise<void> | null = null;
  let fleetRunning: Promise<void> | null = null;
  let jobsRunning: Promise<void> | null = null;
  let stopped = false;

  let lease: FomoLeaseHandle | null = null;
  let nextLeaseTryAt = Number.NEGATIVE_INFINITY;
  let ingest: { stream: AlertStream; ingestor: Ingestor } | null = null;
  let interest: InterestSnapshot = EMPTY_INTEREST;
  let interestAt = Number.NEGATIVE_INFINITY;

  let cohortCache: { at: number; cohort: CohortVersion | null } | null = null;
  let cohortRetryAt = Number.NEGATIVE_INFINITY;
  /**
   * A due cohort refresh the budget refused. While it waits, the research
   * queue serves only protection and interactive items, so discovery-priority
   * dossier refreshes cannot keep spending the discovery share the cohort
   * needs (the cohort is first in line again the moment the day's counters
   * reset, because fleetWork runs it before the queue).
   */
  let cohortWaitingOnBudget = false;
  let lastPruneAt = Number.NEGATIVE_INFINITY;
  let lastDraftAt = Number.NEGATIVE_INFINITY;

  const accessCache = new Map<string, { at: number; access: FomoAccess }>();
  const routeWritten = new Map<string, { at: number; key: string }>();
  const fileWritten = new Map<string, { at: number; key: string }>();
  const heldWritten = new Map<string, { at: number; key: string }>();
  /** When each coin first went into a tenant's file: the honest "first seen" of a holding or watch with no cohort activity. */
  const firstTracked = new Map<string, Map<string, number>>();
  const assessmentSeen = new Map<string, number>();

  const counters = {
    routed: 0,
    researchDone: 0,
    researchRetried: 0,
    researchFailed: 0,
    childFiles: 0,
    draftsAdmitted: 0,
    draftsDuplicate: 0,
    senderCalls: 0,
  };
  let lastPassAt: number | null = null;
  let lastFailure: { at: number; step: string; reason: string } | null = null;
  const failureLogged = new Map<string, { text: string; at: number }>();
  let lastHealthLogAt = Number.NEGATIVE_INFINITY;
  let fleetFreshness: { lastEventAt: number | null } = { lastEventAt: null };

  const configured = (): boolean => {
    try {
      return deps.client !== null && deps.service.configured();
    } catch {
      return false;
    }
  };

  const noteFailure = (step: string, e: unknown): void => {
    const text = scrubLogText(errText(e));
    const at = clock.now();
    lastFailure = { at, step, reason: text };
    const prior = failureLogged.get(step);
    if (!prior || prior.text !== text || at - prior.at > LOG_EVERY_MS) {
      failureLogged.set(step, { text, at });
      deps.log(`fomo: ${step} failed — ${text}`);
    }
  };

  const track = (p: Promise<unknown>): void => {
    pending.add(p);
    void p.finally(() => pending.delete(p));
  };

  // ── access and routes (every replica, its roster) ──

  const accessFor = async (tenant: string, now: number): Promise<FomoAccess | null> => {
    const hit = accessCache.get(tenant);
    if (hit && now - hit.at < ACCESS_TTL_MS) return hit.access;
    try {
      const a = await deps.access(tenant);
      // Normalised to plain booleans: anything that is not exactly true is off.
      const access: FomoAccess = { dataAccess: a.dataAccess === true, monitoring: a.monitoring === true, follow: a.follow === true };
      accessCache.set(tenant, { at: now, access });
      return access;
    } catch (e) {
      // Unreadable settings skip the tenant this pass. Writing "off" would
      // clear an owner's routes on a transient read error; writing "on" would
      // be worse. Neither is written.
      noteFailure("settings", e);
      return null;
    }
  };

  const syncRoutes = async (roster: readonly string[], now: number): Promise<void> => {
    for (const tenant of roster) {
      const access = await accessFor(tenant, now);
      if (!access) continue;
      const key = accessKey(access);
      const prior = routeWritten.get(tenant);
      // A change is written at once; an unchanged snapshot is refreshed every
      // few minutes rather than every 15 s, which would be one shared-database
      // write per tenant per pass for no new information.
      if (prior && prior.key === key && now - prior.at < ROUTE_REFRESH_MS) continue;
      await setTenantRoute(db, tenant, access, now);
      routeWritten.set(tenant, { at: now, key });
    }
  };

  /**
   * THIS REPLICA'S ROSTER'S BOOKS, TO THE SHARED STORE (fomo_held_tokens), so
   * the ingestion leader — whichever replica that is — protects them, and
   * every replica builds the same file for its own roster.
   *
   * Only an owner who is monitored (data access and monitoring or follow) has
   * a set kept at all; turning that off clears it. An UNREAD book is not an
   * empty one: nothing is written for an owner whose holdings this replica
   * has not read and who has reported none. Unchanged sets are re-written
   * every HELD_REWRITE_MS so their age says a replica still reads that book.
   */
  const syncHeld = async (roster: readonly string[], now: number): Promise<void> => {
    const local = deps.heldTokens();
    for (const tenant of roster) {
      const access = await accessFor(tenant, now);
      if (!access) continue;
      const monitored = access.dataAccess && (access.monitoring || access.follow);
      const mine = [...local].filter(([key, ts]) => ts.map(tenantKey).includes(tenant) && tokenFromKey(key)?.key === key).map(([key]) => key);
      if (monitored && mine.length === 0 && !deps.holdingsKnown?.(tenant)) continue;
      const keys = monitored ? [...new Set(mine)].sort().slice(0, FOMO_LIMITS.heldTokensPerTenant) : [];
      const key = keys.join(",");
      const prior = heldWritten.get(tenant);
      if (prior && prior.key === key && (key === "" || now - prior.at < HELD_REWRITE_MS)) continue;
      // Refused only when a newer set is stored (a child's report landed after this pass began); the next pass writes again.
      if (await setHeldTokens(db, tenant, keys, now)) heldWritten.set(tenant, { at: now, key });
    }
  };

  // ── cohort (cached read; leader refresh) ──

  const cohortNow = async (now: number, force = false): Promise<CohortVersion | null> => {
    if (!force && cohortCache && now - cohortCache.at < COHORT_CACHE_MS) return cohortCache.cohort;
    const latest = await latestCohort(db);
    cohortCache = { at: now, cohort: latest?.cohort ?? null };
    return cohortCache.cohort;
  };

  /**
   * MEASURE WHAT A LEADERBOARD ROW CANNOT, FOR A BOUNDED FEW. A board row says
   * where a trader ranked; it says nothing of which chain they trade, how long
   * they hold, how they exit or how they size, so on boards alone a score can
   * only move a little off the prior (cohort.ts CALIBRATION). One positions
   * read (250 credits, discovery class, the fleet's budget) measures those for
   * one trader, and the result is kept in fomo_trader_evidence and reused
   * until it is traderEvidenceTtlMs old, so a refresh re-reads only what went
   * stale. At most enrichPerRefresh reads per refresh: incumbents first (they
   * hold seats on evidence that should be checked), then challengers by their
   * board-only score. A budget refusal or a provider-level failure ends the
   * round; what was measured is still used. Nothing is invented for a trader
   * whose positions were not read: they stay board-only.
   */
  const enrich = async (
    candidates: CohortCandidate[],
    prev: CohortVersion | null,
    scoring: { windowPopulation: Partial<Record<RankingWindow, number>>; observedWindows: RankingWindow[] },
    now: number,
  ): Promise<{ candidates: CohortCandidate[]; read: number; measured: number; stoppedBy: string | null }> => {
    const client = deps.client;
    const ids = candidates.map((c) => canonicalUserId(c.trader.userId));
    let stored = new Map<string, StoredTraderEvidence>();
    try {
      stored = await traderEvidence(db, ids.filter((x): x is string => x !== null));
    } catch (e) {
      noteFailure("cohort-evidence", e);
    }
    const fresh = (e: StoredTraderEvidence | undefined): e is StoredTraderEvidence => !!e && e.measuredAtMs >= now - knobs.traderEvidenceTtlMs;
    const seated = new Set((prev?.members ?? []).map((m) => canonicalUserId(m.trader.userId)));
    const due = candidates
      .flatMap((c, i) => {
        const id = ids[i];
        return id && !fresh(stored.get(id)) ? [{ id, seated: seated.has(id), board: scoreCandidate(c, scoring).score }] : [];
      })
      .sort((a, b) => Number(b.seated) - Number(a.seated) || b.board - a.board || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, Math.max(0, Math.floor(knobs.enrichPerRefresh)));
    let read = 0;
    let stoppedBy: string | null = null;
    for (const d of due) {
      if (!client || stopped || !lease || (lease.healthy && !lease.healthy())) {
        stoppedBy = "leadership";
        break;
      }
      const at = clock.now();
      const grant = deps.budget ? await deps.budget.charge({ priority: "discovery", credits: expectedCredits("positions"), now: at }) : null;
      if (deps.budget && !grant) {
        stoppedBy = "budget";
        break;
      }
      let r: Awaited<ReturnType<FomoClient["positions"]>>;
      try {
        r = await client.positions(d.id, { status: "all", limit: ENRICH_POSITIONS_LIMIT });
      } catch (e) {
        // The client returns failures; a throw is a bug or an abort. Billed or not is unknown: keep the estimate.
        await grant?.settle(null);
        throw e;
      }
      if (r.meta.attempts === 0) await grant?.refund();
      else {
        await grant?.settle(r.meta.creditsCost);
        try {
          await recordUsage(db, usageDay(at), "cohort-enrichment", 1, r.meta.creditsCost);
        } catch (e) {
          noteFailure("usage", e);
        }
      }
      if (!r.ok && ENRICH_STOP_ON.has(r.failure)) {
        stoppedBy = r.failure;
        break;
      }
      // A trader the provider has no positions for is measured as "nothing to
      // measure" and kept for the TTL like any reading, so the same unknown is
      // not re-bought every refresh. Any other failure is simply not a reading.
      if (!r.ok && r.failure !== "not-found") continue;
      read++;
      const m = measurePositions(r.ok ? r.data.rows : []);
      const ev: StoredTraderEvidence = { userId: d.id, measuredAtMs: at, ...m };
      try {
        await putTraderEvidence(db, ev);
      } catch (e) {
        noteFailure("cohort-evidence", e);
      }
      stored.set(d.id, ev);
    }
    let measured = 0;
    const out = candidates.map((c, i) => {
      const e = ids[i] ? stored.get(ids[i]!) : undefined;
      if (!fresh(e)) return c;
      measured++;
      return withEvidence(c, e);
    });
    return { candidates: out, read, measured, stoppedBy };
  };

  const refreshCohort = async (now: number): Promise<void> => {
    const client = deps.client;
    if (!configured() || !client) {
      cohortWaitingOnBudget = false;
      return;
    }
    if (now < cohortRetryAt) return;
    const prev = await cohortNow(now, true);
    // DUE BY THE DURABLE VERSION'S AGE, not by an in-memory timer: a restart
    // or a lease handover to another replica must not re-spend 1,000 credits
    // on a cohort that is an hour old.
    if (prev && now - prev.createdAt < knobs.cohortRefreshMs) {
      cohortWaitingOnBudget = false;
      return;
    }
    const credits = RANKING_WINDOWS.length * expectedCredits("leaderboard");
    const grant = deps.budget ? await deps.budget.charge({ priority: "discovery", credits, now }) : null;
    if (deps.budget && !grant) {
      cohortRetryAt = now + COHORT_RETRY_MS;
      if (!cohortWaitingOnBudget) {
        deps.log("fomo: cohort refresh skipped — the discovery budget refused it; discovery research waits for it, trying again in 30 min");
      }
      cohortWaitingOnBudget = true;
      return;
    }
    cohortWaitingOnBudget = false;
    const pages: Partial<Record<RankingWindow, LeaderboardPage>> = {};
    const boardAge: Partial<Record<RankingWindow, BoardFreshness>> = {};
    const population: Partial<Record<RankingWindow, number>> = {};
    const failures: string[] = [];
    let billed = 0;
    let billedKnown = true;
    let reached = 0;
    try {
      for (const w of RANKING_WINDOWS) {
        const r = await client.leaderboard(w, LEADERBOARD_LIMIT);
        if (r.meta.attempts > 0) {
          reached++;
          if (r.meta.creditsCost === null) billedKnown = false;
          else billed += r.meta.creditsCost;
          try {
            await recordUsage(db, usageDay(now), "leaderboard", 1, r.meta.creditsCost);
          } catch (e) {
            noteFailure("usage", e);
          }
        }
        if (!r.ok) {
          failures.push(`${w}:${r.failure}`);
          continue;
        }
        pages[w] = r.data;
        // The board's own capture time, not our read time: a captured copy is
        // not current activity (cohortCandidatesFrom).
        boardAge[w] = { providerAsOf: r.meta.providerAsOf, stale: r.meta.providerStale };
        population[w] = r.data.providerCount ?? r.data.rows.length + r.data.dropped;
      }
    } catch (e) {
      // The client returns failures rather than throwing; a throw is a bug or
      // an abort, and whether the call in flight was billed is unknown.
      billedKnown = false;
      reached++;
      throw e;
    } finally {
      // Reconciled whatever happened: nothing sent is refunded, an unknown charge keeps the estimate.
      if (grant) await (reached === 0 ? grant.refund() : grant.settle(billedKnown ? billed : null));
    }
    const observed = RANKING_WINDOWS.filter((w) => pages[w] !== undefined);
    if (observed.length === 0) {
      cohortRetryAt = now + COHORT_RETRY_MS;
      deps.log(`fomo: cohort refresh read nothing (${scrubLogText(failures.join(", "), 120)}); keeping the current cohort and trying again in 30 min`);
      return;
    }
    const scoring = { windowPopulation: population, observedWindows: observed };
    const enriched = await enrich(cohortCandidatesFrom(pages, now, boardAge), prev, scoring, now);
    const candidates = enriched.candidates;
    const next = selectCohort(prev, candidates, { now, target: knobs.cohortTarget, ...scoring });
    let inserted: boolean;
    try {
      inserted = await insertCohortVersion(db, next, {
        windows: observed,
        failedWindows: failures.length,
        candidates: candidates.length,
        enrichedThisRefresh: enriched.read,
        withMeasuredEvidence: enriched.measured,
        // How old each board said it was, so a cohort built from captured copies says so.
        boardsAsOf: Object.fromEntries(observed.map((w) => [w, { providerAsOf: boardAge[w]?.providerAsOf ?? null, stale: boardAge[w]?.stale ?? null }])),
      });
    } catch (e) {
      // The boards are already bought: a failed write (a deadlock, a blip)
      // must not have the very next pass buy all four again.
      cohortRetryAt = now + COHORT_RETRY_MS;
      throw e;
    }
    cohortCache = null;
    let added = 0;
    let removed = 0;
    let retained = 0;
    for (const c of next.changes) {
      if (c.change === "added") added++;
      else if (c.change === "removed") removed++;
      else retained++;
    }
    // COUNTS ONLY. cohortDiff names handles; a log line names nobody.
    deps.log(
      `fomo: cohort v${next.version} ${inserted ? "built" : "already built elsewhere"} — ${next.members.length}/${next.target} members ` +
        `(+${added} −${removed} =${retained}) from ${candidates.length} candidates over ${observed.length}/${RANKING_WINDOWS.length} windows, ` +
        `${enriched.measured} with measured evidence (${enriched.read} read this refresh${enriched.stoppedBy ? `, stopped: ${enriched.stoppedBy}` : ""})` +
        (next.shortfallReason ? `; short of target: ${scrubLogText(next.shortfallReason, 160)}` : ""),
    );
  };

  // ── interest (leader) ──

  const refreshInterest = async (now: number, force = false): Promise<void> => {
    if (!force && now - interestAt < INTEREST_REFRESH_MS) return;
    // From the shared store, so an owner on another replica is interested
    // exactly as one here is (fleetInterest); this replica's own book is
    // folded in too in case this pass's write has not landed yet.
    interest = await fleetInterest(db, now, await cohortNow(now), deps.heldTokens());
    interestAt = now;
  };

  // ── leadership and the stream (leader) ──

  const stopIngest = (reason: string): void => {
    const live = ingest;
    if (!live) return;
    ingest = null;
    try {
      live.stream.stop(reason);
    } catch (e) {
      noteFailure("stream-stop", e);
    }
    // Flushed: pending coalesced work is written to the durable queue, where
    // whichever replica leads next finds it. The queue coalesces, so a task
    // the next leader also builds is one row.
    live.ingestor.stop({ flush: true });
    track(live.ingestor.idle());
  };

  /**
   * WHAT THE LIVE STREAM PROVES ABOUT ws-alerts, into fomo_capabilities, so
   * the capability table moves as the stream is observed (as REST calls
   * already move theirs) instead of keeping the documented baseline:
   *
   *   welcome                         AUTHENTICATED_TESTED, or PARTIAL when the
   *                                   provider says it delays delivery (a free
   *                                   key's 15 s)
   *   the vendor's close 1008 before  ENTITLEMENT_BLOCKED (its documented close
   *   any welcome                     for a plan without the stream)
   *   STREAM_UNAVAILABLE_AFTER        UNAVAILABLE
   *   connects in a row, no welcome
   *
   * A drop AFTER a welcome is not a verdict on the capability (servers
   * restart), and nor is any close of our own. The same verdict is written at
   * most once per STREAM_CAPABILITY_EVERY_MS: a flapping socket is not a
   * database load. A failed write is logged and retried on the next change.
   */
  const streamCapabilityObserver = () => {
    let welcomed = false;
    let failedConnects = 0;
    let written: { at: number; status: string } | null = null;
    return (state: StreamState, detail: StreamStateDetail): void => {
      if (state === "connecting") {
        welcomed = false;
        return;
      }
      let probe: StreamProbe | null = null;
      if (state === "open") {
        welcomed = true;
        failedConnects = 0;
        probe = { welcome: true, delaySeconds: detail.delaySeconds ?? null };
      } else if (state === "backoff" && !welcomed) {
        failedConnects++;
        const vendorClose = /^closed\b/.test(detail.reason ?? "") ? (detail.code ?? null) : null;
        if (vendorClose === 1008) probe = { welcome: false, closeCode: 1008 };
        else if (failedConnects >= STREAM_UNAVAILABLE_AFTER) probe = { welcome: false, closeCode: vendorClose };
      }
      if (!probe) return;
      const at = clock.now();
      const next = capabilityFromStream("ws-alerts", "/ws/alerts", probe, at);
      if (written && written.status === next.status && at - written.at < STREAM_CAPABILITY_EVERY_MS) return;
      const prior = written;
      written = { at, status: next.status };
      track(
        (async () => {
          const stored = (await listCapabilities(db)).find((c) => c.capability === next.capability) ?? null;
          await upsertCapability(db, mergeCapability(stored, next));
        })().catch((e) => {
          written = prior;
          noteFailure("capability", e);
        }),
      );
    };
  };

  const enqueueTask = (task: ResearchTask): void => {
    track(
      enqueueResearch(db, task.tokenKey, task.evidenceRev, RESEARCH_PRIORITY[task.priority], task.tenants, clock.now()).catch((e) =>
        noteFailure("research-enqueue", e),
      ),
    );
  };

  const ensureIngest = async (now: number): Promise<void> => {
    const can = !stopped && lease !== null && knobs.ingestEnabled && deps.streamEndpoint !== null && configured();
    if (!can) {
      if (ingest) stopIngest("ingestion off");
      return;
    }
    if (ingest) return;
    await refreshInterest(now, true);
    if (stopped || !lease) return;
    const ingestor = createIngestor({
      streamName: FOMO_STREAM,
      normalize: normalizeAlertFrame,
      store: ingestStoreOver(db, clock),
      recover: recoverVia(deps.client!, { db, clock, budget: deps.budget, onUsageError: (e) => noteFailure("usage", e) }),
      interest: () => interest,
      // Nothing is queued per tenant in this process: every replica builds its
      // children's files from the shared store, where the ingestor has already
      // persisted the event. Routing still decides research priority (the
      // tasks below); here it is only counted.
      route: () => {
        counters.routed++;
      },
      onResearchTask: enqueueTask,
      clock,
      timers,
      streamStats: () => {
        const s = ingest?.stream.stats();
        return { queueDepth: s?.queueDepth ?? 0, oldestQueuedAt: s?.oldestQueuedAt ?? null, lastFrameAt: s?.lastFrameAt ?? null };
      },
      config: deps.ingestConfig,
    });
    const callbacks = ingestor.streamCallbacks();
    const observe = streamCapabilityObserver();
    const stream = new AlertStream({
      endpoint: deps.streamEndpoint!,
      createSocket: deps.createSocket,
      clock,
      timers,
      random: deps.random,
      // Re-sent after every reconnect: the URL's filter applies from the first
      // frame, and the subscription keeps it if the server ever resets it.
      subscription: { chain: "robinhood" },
      ...callbacks,
      onState: (state, detail) => {
        callbacks.onState(state, detail);
        observe(state, detail);
      },
    });
    ingest = { stream, ingestor };
    stream.start();
    deps.log(`fomo: shared ingestion started on ${scrubLogText(deps.streamEndpoint!.redacted, 160)}`);
  };

  const lead = async (now: number): Promise<boolean> => {
    if (stopped) return false;
    if (lease && lease.healthy && !lease.healthy()) {
      // THE STREAM GOES WITH THE LEASE. Its connection is gone, Postgres has
      // released the lock, and another replica may be leading already: two
      // streams would double every billed recovery page.
      deps.log("fomo: the fleet ingestion lease was lost — stopping the stream on this replica");
      stopIngest("lease lost");
      const lost = lease;
      lease = null;
      nextLeaseTryAt = now + LEASE_RETRY_MS;
      track(lost.release().catch(() => undefined));
    }
    if (!lease && now >= nextLeaseTryAt) {
      nextLeaseTryAt = now + LEASE_RETRY_MS;
      try {
        lease = await deps.lease.acquire();
      } catch (e) {
        noteFailure("lease", e);
        lease = null;
      }
      if (lease && stopped) {
        // stop() ran while the acquire was in flight: give it straight back.
        const late = lease;
        lease = null;
        track(late.release().catch(() => undefined));
      }
      if (lease) deps.log("fomo: this replica leads the fleet's shared ingestion, cohort and research queue");
    }
    return lease !== null;
  };

  // ── research queue (leader) ──

  const labelFor = async (tokenKey: string): Promise<TokenLabel> => {
    const [latest] = await eventsForToken(db, tokenKey, 0, 1);
    if (latest && (latest.tokenLabel.symbol || latest.tokenLabel.name)) return sanitizedLabel(latest.tokenLabel);
    const d = dossierFromStored(await latestDossier(db, tokenKey), tokenKey);
    return sanitizedLabel(d?.label);
  };

  const runResearch = async (): Promise<void> => {
    // Without a key every refresh would answer not-configured and burn the
    // item's attempts; the queue waits for a key instead.
    if (!configured()) return;
    // COHORT FIRST in the discovery class: while a due refresh waits on the
    // budget, discovery-priority items stay queued (untouched, attempts kept).
    const floor = cohortWaitingOnBudget ? { minPriority: RESEARCH_PRIORITY.interactive } : {};
    for (let i = 0; i < knobs.maxDossierRefreshesPerPass; i++) {
      const claim = await claimNextResearch(db, clock.now(), RESEARCH_LEASE_MS, floor);
      if (!claim) return;
      const token = tokenFromKey(claim.tokenKey);
      if (!token) {
        await finishResearch(db, claim, "failed");
        counters.researchFailed++;
        continue;
      }
      let outcome: "done" | "retry" = "retry";
      let backOff = false;
      try {
        const label = await labelFor(claim.tokenKey);
        const r = await withDeadline(timers, REFRESH_DEADLINE_MS, (signal) =>
          deps.service.refreshDossier(token, label, { priority: priorityOfQueue(claim.priority), depth: "quick", now: clock.now(), signal }),
        );
        if (RESEARCH_DONE.has(r.status)) outcome = "done";
        backOff = RESEARCH_BACK_OFF.has(r.status);
      } catch (e) {
        noteFailure("research", e);
      }
      const fin = await finishResearch(db, claim, outcome);
      if (outcome === "done") counters.researchDone++;
      else if (fin.ok && claim.attempts < FOMO_LIMITS.researchMaxAttempts) counters.researchRetried++;
      else counters.researchFailed++;
      if (backOff) return;
    }
  };

  // ── publication drafts (every replica, its roster) and the outbox (leader) ──

  const latestBasis = async (tenant: string, kind: PublicationKind, tokenKey: string): Promise<{ contentRev: number; basis: ContentBasis } | null> => {
    let best: FomoPublication | null = null;
    for (const p of await recentPublications(db, tenant, 100)) {
      if (p.kind !== kind || (p.subjectKey ?? p.tokenKey) !== tokenKey) continue;
      if (!best || p.contentRev > best.contentRev) best = p;
    }
    return best ? { contentRev: best.contentRev, basis: extraOf(best.extra).basis } : null;
  };

  const draftFor = async (tenant: string, accountId: string, a: FollowAssessment, now: number): Promise<void> => {
    const kind = publicationKindFor({ source: "assessment", state: a.state });
    if (!kind) return;
    // THE INTEREST LINE MUST BE TRUE, and this replica cannot tell a paper
    // holding from a live one, nor an unread mirror from an empty book. So a
    // draft is made only when the tenant's holdings were read and the coin is
    // not among them; "I hold no position in it" is then a fact.
    if (!deps.holdingsKnown?.(tenant)) return;
    if ((deps.heldTokens().get(a.token.key) ?? []).map(tenantKey).includes(tenant)) return;
    const interestLine: InterestDisclosure = kind === "considering-entry" ? "considering-position" : "no-position";
    const dossier = dossierFromStored(await latestDossier(db, a.token.key), a.token.key);
    const dossierRef = dossier ? { dossierId: dossier.dossierId, revision: dossier.revision } : a.dossierRevision;
    const basis: ContentBasis = { dossierRevision: dossierRef?.revision ?? null, decisionStatus: null };
    // ONLY A MEANINGFUL REVISION IS DRAFTED: the dossier moved forward. A pass
    // re-reading the same evidence says nothing new and drafts nothing.
    const contentRev = nextContentRev(await latestBasis(tenant, kind, a.token.key), basis);
    if (contentRev === null) return;
    const claims = (dossier?.claims ?? [])
      .filter((c) => c.stance === "supporting")
      .map((c) => c.summary)
      .slice(0, 2);
    const sourceTexts = (dossier?.claims ?? []).flatMap((c) => {
      const q = (c as { quoted?: { text?: unknown } | null }).quoted;
      return q && typeof q.text === "string" ? [q.text] : [];
    });
    const draft = draftPublication({
      tenant,
      destination: { channel: "x", accountId },
      kind,
      tokenKey: a.token.key,
      facts: {
        coinName: a.label.name ?? a.label.symbol ?? "",
        claims,
        uncertainty: (dossier?.unknowns ?? []).slice(0, 2),
        interest: interestLine,
        sourceTexts,
      },
      dossierRef,
      decisionId: null,
      decisionStatus: null,
      consentScope: consentScopeFor(kind),
      now,
      contentRev,
    });
    // Research-post consent has never been collected from an owner, so it is
    // false; delivery is off for every kind first anyway, and the draft is
    // stored blocked by policy, visible to its owner, never sent.
    const r = await admitDraft(
      outbox,
      draft,
      { coinName: draft.coinName, interest: interestLine, sourceTexts },
      { consentNow: () => false, deliveryEnabled: DEFAULT_DELIVERY_POLICY },
      now,
    );
    if (r.duplicate) counters.draftsDuplicate++;
    else counters.draftsAdmitted++;
  };

  const runDrafts = async (roster: readonly string[], now: number): Promise<void> => {
    if (!knobs.publishDrafts || !deps.xConsent || now - lastDraftAt < DRAFT_EVERY_MS) return;
    lastDraftAt = now;
    for (const tenant of roster) {
      const access = await accessFor(tenant, now);
      if (!access?.dataAccess) continue;
      const consent = await deps.xConsent(tenant);
      if (!consent) continue;
      const since = assessmentSeen.get(tenant) ?? Number.NEGATIVE_INFINITY;
      const list = await recentAssessments(db, tenant, ASSESSMENTS_PER_PASS);
      const fresh = list.filter((a) => a.createdAt > since).sort((x, y) => x.createdAt - y.createdAt);
      let seen = since;
      for (const a of fresh) {
        // The store already scoped the read to this tenant; this is the belt to that brace.
        if (tenantKey(a.tenant) !== tenant) continue;
        try {
          await draftFor(tenant, consent.accountId, a, now);
        } catch (e) {
          // Not past this one: the next pass tries it again. The dedupe key
          // and the revision rule make a retry write nothing twice.
          noteFailure("draft", e);
          break;
        }
        seen = Math.max(seen, a.createdAt);
      }
      assessmentSeen.set(tenant, seen);
    }
  };

  const runOutbox = async (now: number): Promise<void> => {
    await processOutbox(
      outbox,
      neverSend(() => counters.senderCalls++),
      {
        consentNow: () => false,
        deliveryEnabled: DEFAULT_DELIVERY_POLICY,
        lookup: () => "unknown",
        // Nothing here can establish what a post may claim now; null makes a
        // queued row that ever got past policy cancel rather than send.
        currentKind: () => null,
      },
      now,
    );
  };

  // ── child files (every replica, its roster) ──

  interface FileContext {
    now: number;
    configured: boolean;
    serviceState: FomoHealthState;
    serviceDetail: string;
    cohort: CohortVersion | null;
    lastEventAt: number | null;
    fresh: boolean;
    tokens: Map<string, Promise<{ events: StoredTraderEvent[]; dossier: CoinDossier | null }>>;
    cohortActive: Promise<ActiveToken[]> | null;
    thesisActive: Promise<ActiveToken[]> | null;
  }

  const tokenData = (ctx: FileContext, tokenKey: string) => {
    let p = ctx.tokens.get(tokenKey);
    if (!p) {
      p = (async () => ({
        events: await eventsForToken(db, tokenKey, ctx.now - SIGNAL_WINDOW_MS, TRIGGER_SCAN),
        dossier: dossierFromStored(await latestDossier(db, tokenKey), tokenKey),
      }))();
      ctx.tokens.set(tokenKey, p);
    }
    return p;
  };

  const healthFor = (access: FomoAccess, ctx: FileContext): ChildFomoFile["health"] => {
    const base = {
      cohortSize: ctx.cohort ? ctx.cohort.members.length : null,
      cohortVersion: ctx.cohort ? ctx.cohort.version : null,
      cohortTarget: knobs.cohortTarget,
      lastEventAt: ctx.lastEventAt,
    };
    if (!ctx.configured) {
      return { state: "not-configured", detail: "Fomo research is not configured on this deployment, so lookups answer that honestly.", ...base };
    }
    if (!access.dataAccess) return { state: "permission-required", detail: "Fomo data access is off for this agent.", ...base };
    if (ctx.serviceState === "provider-unavailable" || ctx.serviceState === "budget-limited" || ctx.serviceState === "disabled") {
      return { state: ctx.serviceState, detail: ctx.serviceDetail, ...base };
    }
    if (!access.monitoring && !access.follow) return { state: "research-only", detail: "Fomo lookups are on; trader monitoring is off.", ...base };
    if (ctx.fresh) return { state: "receiving-fresh-data", detail: "The shared trader feed is delivering.", ...base };
    return { state: "watching-condition", detail: "Monitoring is on; the shared trader feed has delivered nothing in the last ten minutes.", ...base };
  };

  /** The cohort's recent coins: PUBLIC activity, read once per pass and shared by every owner's file. */
  const cohortActivity = (ctx: FileContext): Promise<ActiveToken[]> => {
    ctx.cohortActive ??= (async () => {
      const ids = (ctx.cohort?.members ?? []).map((m) => m.trader.userId);
      return ids.length === 0 ? [] : recentActiveTokens(db, ctx.now - SIGNAL_WINDOW_MS, COHORT_SIGNAL_SCAN, { userIds: ids });
    })();
    return ctx.cohortActive;
  };

  /** Robinhood Chain coins anyone wrote a thesis on lately: public, open-ended discovery, bounded small. */
  const thesisActivity = (ctx: FileContext): Promise<ActiveToken[]> => {
    ctx.thesisActive ??= recentActiveTokens(db, ctx.now - SIGNAL_WINDOW_MS, THESIS_SIGNAL_SCAN, { kinds: ["thesis"], tokenKeyPrefix: ROBINHOOD_KEY_PREFIX });
    return ctx.thesisActive;
  };

  /**
   * ONE OWNER'S SIGNALS, FROM THE SHARED STORE, the same on whichever replica
   * holds the owner's lease:
   *
   *   cohort            coins the cohort touched in the breadth window (public)
   *   robinhood-thesis  Robinhood Chain coins with a fresh thesis (public)
   *   dependency        coins THIS owner's own dependency traders touched
   *   held              THIS owner's held set (fomo_held_tokens, plus this
   *                     replica's own reading of the book)
   *   watched           THIS owner's unexpired watches
   *
   * Nothing of any other owner's: no other owner's holdings, watches or
   * dependencies reach the file, as a coin, a reason or a trigger. A coin
   * another owner holds appears here only if the public cohort touched it,
   * and then only as "cohort".
   */
  const signalsFor = async (tenant: string, ctx: FileContext): Promise<ChildSignal[]> => {
    const now = ctx.now;
    const cand = new Map<string, Candidate>();
    const add = (key: string, priority: RetrievalPriority, reason: ChildSignal["reasons"][number], at: number | null, lastSeenAt: number, label: TokenLabel | null) => {
      const prior = cand.get(key);
      if (!prior) {
        cand.set(key, { priority, reasons: new Set([reason]), firstSeenAt: at, lastSeenAt, label });
        return;
      }
      prior.priority = higherPriority(prior.priority, priority);
      prior.reasons.add(reason);
      if (at !== null) prior.firstSeenAt = prior.firstSeenAt === null ? at : Math.min(prior.firstSeenAt, at);
      prior.lastSeenAt = Math.max(prior.lastSeenAt, lastSeenAt);
      prior.label ??= label;
    };
    for (const a of await cohortActivity(ctx)) add(a.tokenKey, "discovery", "cohort", null, a.newestAt, null);
    for (const a of await thesisActivity(ctx)) add(a.tokenKey, "discovery", "robinhood-thesis", null, a.newestAt, null);
    // This tenant's own position dependencies only: whom ANOTHER tenant
    // depends on is that tenant's private state.
    const depIds = [...new Set((await activePositionDeps(db, now, tenant)).map((d) => d.userId))];
    if (depIds.length > 0) {
      for (const a of await recentActiveTokens(db, now - SIGNAL_WINDOW_MS, DEPENDENCY_SIGNAL_SCAN, { userIds: depIds })) {
        add(a.tokenKey, "discovery", "dependency", null, a.newestAt, null);
      }
    }
    // THIS TENANT'S OWN HOLDINGS AND WATCHES: the held read and the local map
    // are filtered to this tenant, and the watch read is scoped by the store.
    const held = new Set(await heldTokensFor(db, tenant, now - HELD_FRESH_MS));
    for (const [key, tenants] of deps.heldTokens()) if (tenants.map(tenantKey).includes(tenant)) held.add(key);
    for (const key of held) add(key, "position-protection", "held", null, now, null);
    for (const w of await activeWatches(db, tenant, now)) add(w.tokenKey, "interactive", "watched", w.createdAtMs, w.createdAtMs, w.label);

    const ordered = [...cand.entries()]
      .sort((x, y) => PRIORITY_ORDER[x[1].priority] - PRIORITY_ORDER[y[1].priority] || y[1].lastSeenAt - x[1].lastSeenAt || (x[0] < y[0] ? -1 : 1))
      .slice(0, MAX_CHILD_SIGNALS);
    if (ordered.length === 0) return [];

    const tracked = firstTracked.get(tenant) ?? new Map<string, number>();
    for (const key of [...tracked.keys()]) if (!ordered.some(([k]) => k === key)) tracked.delete(key);
    for (const [key] of ordered) if (!tracked.has(key)) tracked.set(key, now);
    firstTracked.set(tenant, tracked);
    const cohortIds = new Set((ctx.cohort?.members ?? []).map((m) => m.trader.userId));
    const ownDeps = new Set(depIds);
    const out: ChildSignal[] = [];
    for (const [key, c] of ordered) {
      const token = tokenFromKey(key);
      if (!token) continue;
      const { events, dossier } = await tokenData(ctx, key);
      // A coin known only from activity takes its label from the newest event that named it.
      const named = events.find((e) => e.tokenLabel.symbol || e.tokenLabel.name)?.tokenLabel ?? null;
      const triggers = events
        .filter((e) => cohortIds.has(e.trader.userId) || ownDeps.has(e.trader.userId))
        .slice(0, MAX_SIGNAL_TRIGGERS)
        .map(asTraderEvent);
      const oldestTrigger = triggers.length > 0 ? Math.min(...triggers.map((e) => e.observedAt)) : null;
      const firstSeenAt = Math.min(c.firstSeenAt ?? Number.POSITIVE_INFINITY, oldestTrigger ?? Number.POSITIVE_INFINITY, tracked.get(key) ?? now);
      let lens: string | null = null;
      let refs: string[] = [];
      try {
        lens = renderTraderFlowLens(dossier, now);
        refs = lens ? lensRefs(dossier) : [];
      } catch {
        // A stored dossier the lens cannot read gives no lens, never a half one.
        lens = null;
        refs = [];
      }
      out.push({
        token,
        label: sanitizedLabel(c.label ?? named ?? dossier?.label ?? null),
        priority: c.priority,
        reasons: [...c.reasons].sort(),
        triggers,
        // A coin tracked for a holding with no cohort activity yet was first
        // seen when it first went into this tenant's file.
        firstSeenAt,
        dossier,
        lens,
        lensRefs: refs,
      });
    }
    return out;
  };

  const writeChildFiles = async (roster: readonly string[], now: number): Promise<void> => {
    let ctx: FileContext | null = null;
    const context = async (): Promise<FileContext> => {
      if (ctx) return ctx;
      const isConfigured = configured();
      let serviceState: FomoHealthState = isConfigured ? "research-only" : "not-configured";
      let serviceDetail = "";
      try {
        const h = await deps.service.health(now);
        serviceState = h.state;
        serviceDetail = sanitizeText(h.detail, 200) || "Fomo research is temporarily limited.";
      } catch (e) {
        noteFailure("service-health", e);
        serviceState = "provider-unavailable";
        serviceDetail = "Fomo health could not be read.";
      }
      const live: IngestHealth | null = ingest ? ingest.ingestor.health() : null;
      let lastEventAt = live?.lastEventAt ?? null;
      if (lastEventAt === null) {
        // A replica that does not lead reads the fleet's progress from the durable checkpoint.
        try {
          lastEventAt = (await getCheckpoint(db, FOMO_STREAM))?.newestTsMs ?? null;
        } catch (e) {
          noteFailure("checkpoint", e);
        }
      }
      // A newest-event time ahead of our clock is a bad provider timestamp,
      // not a fresh feed: `now - lastEventAt` would be negative and pass any
      // freshness test until the wall clock caught up.
      if (lastEventAt !== null && lastEventAt > now + FUTURE_EVENT_SKEW_MS) lastEventAt = null;
      fleetFreshness = { lastEventAt };
      const fresh = live?.state === "receiving-fresh-data" || (lastEventAt !== null && now - lastEventAt <= FRESH_FEED_MS);
      ctx = {
        now,
        configured: isConfigured,
        serviceState,
        serviceDetail,
        cohort: await cohortNow(now),
        lastEventAt,
        fresh,
        tokens: new Map(),
        cohortActive: null,
        thesisActive: null,
      };
      return ctx;
    };
    for (const tenant of roster) {
      const access = await accessFor(tenant, now);
      if (!access) continue;
      const key = accessKey(access);
      const prior = fileWritten.get(tenant);
      if (prior && prior.key === key && now - prior.at < knobs.childFileEveryMs) continue;
      try {
        const c = await context();
        // NO DATA ACCESS, NO SIGNALS — but still a file. An owner who just
        // turned access off must not leave yesterday's signals in the home for
        // the child to keep reading; this overwrites them with nothing.
        const monitored = access.dataAccess && (access.monitoring || access.follow);
        if (!monitored) firstTracked.delete(tenant);
        const file: ChildFomoFile = {
          version: 1,
          writtenAt: now,
          tenant,
          access,
          health: healthFor(access, c),
          signals: monitored ? await signalsFor(tenant, c) : [],
        };
        deps.writeChildFile(deps.childHome(tenant), file);
        fileWritten.set(tenant, { at: now, key });
        counters.childFiles++;
      } catch (e) {
        noteFailure("child-file", e);
      }
    }
  };

  // ── health ──

  const health = (): FomoPassHealth => {
    const live = ingest ? ingest.ingestor.health() : null;
    const cohort = cohortCache?.cohort ?? null;
    return {
      configured: configured(),
      leader: lease !== null,
      ingest: !knobs.ingestEnabled ? "off" : !configured() || !deps.streamEndpoint ? "not-configured" : live ? "running" : lease ? "starting" : "follower",
      connected: live?.connected ?? false,
      lastEventAt: live?.lastEventAt ?? fleetFreshness.lastEventAt,
      openGaps: live ? live.openGaps : null,
      deadLetters: live ? live.deadLetters : null,
      queueDepth: live?.queueDepth ?? 0,
      routed: counters.routed,
      lastCohortAt: cohort?.createdAt ?? null,
      cohortSize: cohort ? cohort.members.length : null,
      cohortVersion: cohort ? cohort.version : null,
      cohortWaitingOnBudget,
      research: { done: counters.researchDone, retried: counters.researchRetried, failed: counters.researchFailed },
      childFilesWritten: counters.childFiles,
      drafts: { admitted: counters.draftsAdmitted, duplicate: counters.draftsDuplicate },
      senderCalls: counters.senderCalls,
      lastPassAt,
      lastFailure,
    };
  };

  const ago = (at: number | null, now: number): string => (at === null ? "never" : `${Math.max(0, Math.round((now - at) / MIN))}m ago`);

  const logHealth = (now: number): void => {
    if (now - lastHealthLogAt < LOG_EVERY_MS) return;
    lastHealthLogAt = now;
    const h = health();
    // Counts and ages only: no tenant, no trader, no token, no URL.
    deps.log(
      `fomo: ${h.configured ? "configured" : "not configured"}, ${h.leader ? "leading" : "following"}, ingest ${h.ingest}` +
        `${h.leader ? `, stream ${h.connected ? "connected" : "not connected"}, ${h.openGaps ?? 0} open gap(s), ${h.deadLetters ?? 0} dead letter(s)` : ""}` +
        `, last event ${ago(h.lastEventAt, now)}, cohort ${h.cohortVersion === null ? "none" : `v${h.cohortVersion} ${h.cohortSize}/${knobs.cohortTarget}`}` +
        (h.cohortWaitingOnBudget ? " (refresh waiting on the budget)" : "") +
        `, research ${h.research.done} done ${h.research.retried} retried ${h.research.failed} failed` +
        `, ${h.childFilesWritten} child file(s), ${h.drafts.admitted} draft(s) held by policy, sender calls ${h.senderCalls}` +
        (h.lastFailure ? `, last failure in ${h.lastFailure.step} ${ago(h.lastFailure.at, now)}` : ""),
    );
  };

  // ── one pass ──

  const step = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (e) {
      noteFailure(name, e);
    }
  };

  /**
   * THE LEADER'S SLOW WORK, ON ITS OWN LATCH. A leaderboard read, three dossier
   * refreshes or a deep research job can take minutes; awaited inside the
   * pass they would hold the latch, and every child on this replica would see
   * its file go stale while the leader waited on the provider. So the pass
   * starts this and goes on; a second one is not started beside a running one.
   */
  const fleetWork = async (now: number): Promise<void> => {
    await step("cohort", () => refreshCohort(now));
    await step("research", () => runResearch());
    // SETTLE WHAT NOBODY WILL FINISH, before claiming more. A job still queued
    // at its deadline, or running on a lease that lapsed after it (its worker
    // died), can never be claimed again (claimJob needs deadline_ms > now) and
    // retention keeps only finished rows' clocks: unswept, it would read as
    // "in progress" for ever. The sweep fails it with a reason the owner can
    // be told; a live lease is left alone.
    await step("jobs-sweep", async () => void (await sweepJobs(db, clock.now())));
    startJobs(now);
    await step("outbox", () => runOutbox(now));
    if (now - lastPruneAt >= PRUNE_EVERY_MS) {
      lastPruneAt = now;
      await step("retention", async () => void (await pruneFomo(db, now)));
    }
  };

  /** Deep jobs run up to their own ten-minute deadline: a latch of their own, so the queue and outbox keep moving. */
  const startJobs = (now: number): void => {
    const run = deps.runJobs;
    if (!run || jobsRunning || stopped) return;
    jobsRunning = step("jobs", async () => void (await run(now))).finally(() => {
      jobsRunning = null;
    });
  };

  const pass = async (rosterIn: readonly FomoRosterMember[], now: number): Promise<void> => {
    const roster = [...new Set(rosterIn.map((m) => tenantKey(m.tenant)).filter((t) => t !== ""))];
    try {
      await ensureFomoSchema(db, deps.dialect);
    } catch (e) {
      noteFailure("schema", e);
      return;
    }
    await step("routes", () => syncRoutes(roster, now));
    await step("held", () => syncHeld(roster, now));
    let leading = false;
    await step("lease", async () => {
      leading = await lead(now);
    });
    if (leading) {
      await step("interest", () => refreshInterest(now));
      await step("ingest", () => ensureIngest(now));
    }
    if (leading && !stopped && !fleetRunning) {
      fleetRunning = fleetWork(now).finally(() => {
        fleetRunning = null;
      });
    }
    await step("child-files", () => writeChildFiles(roster, now));
    await step("drafts", () => runDrafts(roster, now));
    // A tenant whose lease moved away is not ours to remember; if it comes
    // back, its route and file are written afresh.
    const here = new Set(roster);
    for (const m of [accessCache, routeWritten, heldWritten, fileWritten, firstTracked, assessmentSeen] as Map<string, unknown>[]) {
      for (const t of [...m.keys()]) if (!here.has(t)) m.delete(t);
    }
    lastPassAt = now;
    logHealth(now);
  };

  return {
    start(roster, now) {
      if (stopped || running) return;
      running = pass(roster, now)
        .catch((e) => noteFailure("pass", e))
        .finally(() => {
          running = null;
        });
    },
    health,
    stop() {
      if (stopped) return;
      stopped = true;
      stopIngest("shutdown");
      const held = lease;
      lease = null;
      if (held) track(held.release().catch(() => undefined));
    },
    async idle() {
      for (let i = 0; i < 3; i++) {
        if (running) await running;
        if (fleetRunning) await fleetRunning;
        if (jobsRunning) await jobsRunning;
        if (ingest) await ingest.ingestor.idle();
        if (pending.size > 0) await Promise.allSettled([...pending]);
      }
    },
  };
}
