/**
 * THE FOMO RESEARCH TABLES, AND THE ONLY CODE THAT READS OR WRITES THEM.
 *
 * Everything the social-trading research subsystem keeps lives in `fomo_*`
 * tables behind the `Db` seam: hosted, the shared Postgres that the web tier
 * and the orchestrator both open; self-hosted, `fomo.sqlite` in the home
 * directory. There are two kinds of table, and the difference is the point:
 *
 *   SHARED      public research data, the same for every owner: traders and
 *               their handle history, the evidence measured about them, cohort
 *               versions, the deduplicated event log, stream checkpoints and
 *               coverage gaps, the response cache, dossiers, budgets and the
 *               research queue. No tenant column, because nothing in them
 *               belongs to anybody.
 *   PER TENANT  an owner's own state: requests, jobs, conversation subjects,
 *               watches, the ingestion route, the coins it holds, assessments,
 *               position dependencies, publication drafts, outcomes and the
 *               funnel.
 *               Every row carries `tenant`, lowercased HERE (a checksummed
 *               caller must not split one owner into two). Every read takes a
 *               tenant and filters on it, and another owner's row reads as
 *               null or empty, the same answer as a row that does not exist.
 *
 * NEVER ACCOUNTING, NEVER AN ORDER. Provider money is display data. It stays
 * inside JSON blobs or decimal TEXT and is never summed into anything here.
 * The one sizing figure stored, an assessment's ceiling, is a micro-USDG
 * decimal string computed elsewhere from the owner's own limits. Nothing in
 * this module places an order, builds calldata or reads a key.
 *
 * UNTRUSTED TEXT. Handles, names, theses and comments are written by strangers
 * and are a prompt-injection vector. The normalisers upstream sanitise them;
 * this module stores them as data, bounds their length and never interprets
 * them. It also replaces NUL: Postgres TEXT refuses it and sqlite does not, so
 * one NUL in a provider frame would fail only in production.
 *
 * ONE DIALECT, TWO DATABASES, with the groupchat/xpost discipline. Statements
 * are written in sqlite's spelling and translated by db.ts (translateQuery for
 * `prepare`, translateSchema for `exec`), so everything keeps to shapes that
 * are verified to translate:
 *   - a new id is read with `RETURNING` through `.get()`: PgDb.run reports
 *     lastInsertRowid as 0, always;
 *   - "did it happen" is a RETURNING row or an UPDATE/DELETE `changes`;
 *   - result columns are snake_case (Postgres folds an unquoted alias);
 *   - dedupe is `ON CONFLICT … DO NOTHING`, never INSERT OR IGNORE/REPLACE;
 *   - "the larger of two" is a CASE, never sqlite's two-argument MAX;
 *   - no datetime(), no JSON functions: JSON is TEXT, parsed in code;
 *   - every bound value is a string, null or a safe integer.
 * store.test.ts captures every statement this module runs and checks each one
 * against those rules and against translateQuery.
 *
 * TRANSACTIONS DO NOT NEST on either backend. Functions that open their own
 * (upsertTrader(s), insertEvents, insertCohortVersion, insertDossierRevision,
 * enqueueJob, addWatch, addTail, addPositionDep, upsertOutcome, ensureFomoSchema,
 * applyFomoAlters on Postgres) take the ROOT Db, never one handed to a db.tx
 * callback.
 *
 * WEB-SAFE. The web tier imports this as well as the orchestrator, so it
 * imports only types and reads no environment: the caller opens the
 * connection and says which dialect it speaks.
 */
import type { Db } from "../db";
import type {
  ActivityKind,
  CapabilityRecord,
  CapabilityStatus,
  ChainNamespace,
  CohortChange,
  CohortMember,
  CohortVersion,
  EventIdentityBasis,
  EventSource,
  EvidenceKind,
  EvidenceRef,
  ExecutionAvailability,
  FollowAssessment,
  FomoSurface,
  FomoTail,
  Freshness,
  FreshnessClass,
  FunnelStage,
  ObservationBasis,
  PublicationKind,
  PublicationState,
  ResearchState,
  ResultStatus,
  RetrievalPriority,
  TokenIdentity,
  TokenLabel,
  TraderEvent,
  TraderIdentity,
} from "./types";

export type FomoDialect = "postgres" | "sqlite";

const DAY_MS = 86_400_000;

// ── schema ──────────────────────────────────────────────────────────────────

/**
 * The DDL, in sqlite's dialect. `IF NOT EXISTS` throughout, so a second boot or
 * a second process is a no-op. Comments are `--`, lowercase, and free of
 * placeholders and quotes, because translateSchema rewrites this text blind.
 */
export const FOMO_SCHEMA = `
CREATE TABLE IF NOT EXISTS fomo_capabilities (
  capability TEXT PRIMARY KEY,
  route TEXT NOT NULL,
  status TEXT NOT NULL,
  evidence TEXT NOT NULL,
  verified_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fomo_traders (
  user_id TEXT PRIMARY KEY,                -- the provider user id, never a handle
  handle TEXT,                             -- latest seen, display case
  display_name TEXT,
  verified INTEGER,                        -- 1, 0, or null for unknown
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fomo_trader_handles (
  user_id TEXT NOT NULL,
  handle TEXT NOT NULL,                    -- lowercased, without the at sign
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, handle)
);
CREATE INDEX IF NOT EXISTS fomo_trader_handles_handle ON fomo_trader_handles (handle, last_seen_ms);
CREATE TABLE IF NOT EXISTS fomo_trader_evidence (
  user_id TEXT PRIMARY KEY,                -- the provider user id
  measured_at_ms INTEGER NOT NULL,         -- when the positions behind it were read
  sample_size INTEGER NOT NULL,            -- positions the measurement used
  evidence_json TEXT NOT NULL              -- reconstructed cohort inputs, never a provider body
);
CREATE INDEX IF NOT EXISTS fomo_trader_evidence_measured ON fomo_trader_evidence (measured_at_ms);
CREATE TABLE IF NOT EXISTS fomo_cohort_versions (
  version INTEGER PRIMARY KEY,
  created_at_ms INTEGER NOT NULL,
  target INTEGER NOT NULL,
  member_count INTEGER NOT NULL,
  shortfall_reason TEXT,
  inputs_json TEXT
);
CREATE TABLE IF NOT EXISTS fomo_cohort_members (
  version INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  score TEXT NOT NULL,
  followable INTEGER NOT NULL,
  reasons_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  included_at_ms INTEGER NOT NULL,
  PRIMARY KEY (version, user_id)
);
CREATE TABLE IF NOT EXISTS fomo_cohort_changes (
  version INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  change TEXT NOT NULL,                    -- added, retained or removed
  reason TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  PRIMARY KEY (version, user_id)
);
CREATE TABLE IF NOT EXISTS fomo_events (
  event_key TEXT PRIMARY KEY,              -- events.ts identity, the dedupe key
  identity_basis TEXT NOT NULL,
  ambiguous INTEGER NOT NULL,
  kind TEXT NOT NULL,
  user_id TEXT,
  token_key TEXT,
  trade_id TEXT,
  swap_id TEXT,
  tx_hash TEXT,
  source TEXT NOT NULL,
  event_json TEXT NOT NULL,
  source_event_at_ms INTEGER,
  observed_at_ms INTEGER NOT NULL,
  retracted INTEGER NOT NULL DEFAULT 0,
  processed_at_ms INTEGER                  -- null until the ingestion routed it
);
CREATE INDEX IF NOT EXISTS fomo_events_token ON fomo_events (token_key, observed_at_ms);
CREATE INDEX IF NOT EXISTS fomo_events_user ON fomo_events (user_id, observed_at_ms);
CREATE INDEX IF NOT EXISTS fomo_events_observed ON fomo_events (observed_at_ms);
CREATE INDEX IF NOT EXISTS fomo_events_unprocessed ON fomo_events (observed_at_ms) WHERE processed_at_ms IS NULL;
CREATE TABLE IF NOT EXISTS fomo_stream_checkpoints (
  stream TEXT PRIMARY KEY,
  cursor TEXT,
  newest_ts_ms INTEGER,                    -- null only before any event time is known
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fomo_coverage_gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream TEXT NOT NULL,
  from_ms INTEGER NOT NULL,
  to_ms INTEGER NOT NULL,
  reason TEXT NOT NULL,
  recovered INTEGER NOT NULL DEFAULT 0,
  detected_at_ms INTEGER NOT NULL,
  recovered_at_ms INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS fomo_coverage_gaps_span ON fomo_coverage_gaps (stream, from_ms, to_ms);
CREATE INDEX IF NOT EXISTS fomo_coverage_gaps_open ON fomo_coverage_gaps (recovered, stream, from_ms);
CREATE INDEX IF NOT EXISTS fomo_coverage_gaps_to ON fomo_coverage_gaps (to_ms);
CREATE TABLE IF NOT EXISTS fomo_dead_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream TEXT NOT NULL,
  payload TEXT NOT NULL,                   -- capped, raw, untrusted
  error TEXT NOT NULL,
  at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS fomo_dead_letters_stream ON fomo_dead_letters (stream, at_ms);
CREATE INDEX IF NOT EXISTS fomo_dead_letters_at ON fomo_dead_letters (at_ms);
CREATE TABLE IF NOT EXISTS fomo_cache (
  cache_key TEXT PRIMARY KEY,
  data_class TEXT NOT NULL,
  payload_json TEXT,                       -- null for an attempt that never succeeded
  retrieved_at_ms INTEGER,
  provider_as_of_ms INTEGER,
  last_attempt_at_ms INTEGER,
  last_attempt_outcome TEXT,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS fomo_cache_retrieved ON fomo_cache (retrieved_at_ms);
CREATE INDEX IF NOT EXISTS fomo_cache_attempt ON fomo_cache (last_attempt_at_ms);
CREATE TABLE IF NOT EXISTS fomo_dossiers (
  token_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  inputs_hash TEXT NOT NULL,
  dossier_json TEXT NOT NULL,
  built_at_ms INTEGER NOT NULL,
  PRIMARY KEY (token_key, revision)
);
CREATE TABLE IF NOT EXISTS fomo_meta (
  k TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0,
  v TEXT,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fomo_usage (
  day TEXT NOT NULL,                       -- utc yyyy-mm-dd
  bucket TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  credits INTEGER NOT NULL DEFAULT 0,      -- only calls whose charge was reported
  uncounted_calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, bucket)
);
CREATE TABLE IF NOT EXISTS fomo_research_queue (
  token_key TEXT NOT NULL,
  evidence_rev TEXT NOT NULL,
  priority INTEGER NOT NULL,               -- larger is more urgent
  tenants_json TEXT NOT NULL,
  state TEXT NOT NULL,                     -- queued, claimed, done or failed
  requested_at_ms INTEGER NOT NULL,
  claimed_until_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (token_key, evidence_rev)
);
CREATE INDEX IF NOT EXISTS fomo_research_queue_claim ON fomo_research_queue (state, priority, requested_at_ms);
CREATE INDEX IF NOT EXISTS fomo_research_queue_requested ON fomo_research_queue (requested_at_ms);
CREATE TABLE IF NOT EXISTS fomo_tenant_locks (
  tenant TEXT NOT NULL,
  lock_scope TEXT NOT NULL,
  touched_at_ms INTEGER NOT NULL,
  PRIMARY KEY (tenant, lock_scope)
);
CREATE TABLE IF NOT EXISTS fomo_requests (
  request_id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  surface TEXT NOT NULL,
  tool TEXT NOT NULL,
  status TEXT NOT NULL,                    -- pending until completed
  subject_key TEXT,
  created_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS fomo_requests_tenant ON fomo_requests (tenant, created_at_ms);
CREATE INDEX IF NOT EXISTS fomo_requests_created ON fomo_requests (created_at_ms);
CREATE TABLE IF NOT EXISTS fomo_jobs (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  idempotency_key TEXT,
  conversation_key TEXT,
  surface TEXT NOT NULL,
  kind TEXT NOT NULL,
  params_json TEXT NOT NULL,
  status TEXT NOT NULL,                    -- queued, running, done, failed or cancelled
  deadline_ms INTEGER NOT NULL,
  cost_allowance_credits INTEGER,
  created_at_ms INTEGER NOT NULL,
  lease_until_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,     -- the fencing token
  result_json TEXT,
  delivered_at_ms INTEGER,
  UNIQUE (tenant, idempotency_key)
);
CREATE INDEX IF NOT EXISTS fomo_jobs_tenant ON fomo_jobs (tenant, created_at_ms);
CREATE INDEX IF NOT EXISTS fomo_jobs_queue ON fomo_jobs (status, created_at_ms);
CREATE TABLE IF NOT EXISTS fomo_subjects (
  tenant TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  subject_json TEXT NOT NULL,              -- opaque, subject-memory.ts owns its shape
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (tenant, conversation_key)
);
CREATE INDEX IF NOT EXISTS fomo_subjects_updated ON fomo_subjects (updated_at_ms);
CREATE TABLE IF NOT EXISTS fomo_watches (
  tenant TEXT NOT NULL,
  token_key TEXT NOT NULL,
  label_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_via TEXT NOT NULL,
  PRIMARY KEY (tenant, token_key)
);
CREATE INDEX IF NOT EXISTS fomo_watches_token ON fomo_watches (token_key, expires_at_ms);
CREATE INDEX IF NOT EXISTS fomo_watches_expiry ON fomo_watches (expires_at_ms);
CREATE TABLE IF NOT EXISTS fomo_tails (
  tenant TEXT NOT NULL,
  user_id TEXT NOT NULL,                   -- the provider user id, never a handle
  handle TEXT,                             -- display only
  consider INTEGER NOT NULL,               -- 1: the owner asked for their buys to reach the normal follow review
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_via TEXT NOT NULL,
  PRIMARY KEY (tenant, user_id)
);
CREATE INDEX IF NOT EXISTS fomo_tails_user ON fomo_tails (user_id, expires_at_ms);
CREATE INDEX IF NOT EXISTS fomo_tails_expiry ON fomo_tails (expires_at_ms);
CREATE TABLE IF NOT EXISTS fomo_tenant_routes (
  tenant TEXT NOT NULL PRIMARY KEY,
  data_access INTEGER NOT NULL,
  monitoring INTEGER NOT NULL,
  follow INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS fomo_tenant_routes_updated ON fomo_tenant_routes (updated_at_ms);
CREATE TABLE IF NOT EXISTS fomo_held_tokens (
  tenant TEXT NOT NULL,
  token_key TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,          -- when the replica holding the lease last wrote the set
  PRIMARY KEY (tenant, token_key)
);
CREATE INDEX IF NOT EXISTS fomo_held_tokens_updated ON fomo_held_tokens (updated_at_ms);
CREATE TABLE IF NOT EXISTS fomo_assessments (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  token_key TEXT NOT NULL,
  state TEXT NOT NULL,
  assessment_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS fomo_assessments_token ON fomo_assessments (tenant, token_key, created_at_ms);
CREATE INDEX IF NOT EXISTS fomo_assessments_tenant ON fomo_assessments (tenant, created_at_ms);
CREATE TABLE IF NOT EXISTS fomo_position_deps (
  tenant TEXT NOT NULL,
  user_id TEXT NOT NULL,
  token_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (tenant, user_id, token_key)
);
CREATE INDEX IF NOT EXISTS fomo_position_deps_expiry ON fomo_position_deps (expires_at_ms);
CREATE TABLE IF NOT EXISTS fomo_publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant TEXT NOT NULL,
  destination TEXT NOT NULL,               -- the channel
  destination_account TEXT,                -- the connected account id it was written for
  kind TEXT NOT NULL,
  token_key TEXT,
  subject_key TEXT,                        -- decision id or token key, for the per subject limit
  content_rev INTEGER NOT NULL,
  body TEXT NOT NULL,
  evidence_ref TEXT,
  decision_id TEXT,
  consent_scope TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  fleet_key TEXT,
  state TEXT NOT NULL,
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  requeued_after_absent INTEGER NOT NULL DEFAULT 0,
  reconcile_checks INTEGER NOT NULL DEFAULT 0,
  extra_json TEXT,                         -- publish.ts owns its shape
  created_at_ms INTEGER NOT NULL,
  due_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  sent_at_ms INTEGER,
  external_id TEXT
);
CREATE INDEX IF NOT EXISTS fomo_publications_tenant ON fomo_publications (tenant, created_at_ms);
CREATE INDEX IF NOT EXISTS fomo_publications_subject ON fomo_publications (tenant, kind, subject_key, created_at_ms);
CREATE INDEX IF NOT EXISTS fomo_publications_due ON fomo_publications (state, due_at_ms);
CREATE INDEX IF NOT EXISTS fomo_publications_touched ON fomo_publications (state, updated_at_ms);
CREATE INDEX IF NOT EXISTS fomo_publications_fleet ON fomo_publications (fleet_key, created_at_ms);
CREATE TABLE IF NOT EXISTS fomo_outcomes (
  assessment_id TEXT NOT NULL,
  horizon_label TEXT NOT NULL,
  tenant TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  price8 TEXT,                             -- 8dp usd decimal, null when unknown
  note TEXT,
  PRIMARY KEY (assessment_id, horizon_label)
);
CREATE INDEX IF NOT EXISTS fomo_outcomes_tenant ON fomo_outcomes (tenant, assessment_id);
CREATE TABLE IF NOT EXISTS fomo_funnel (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant TEXT NOT NULL,
  token_key TEXT NOT NULL,
  stage TEXT NOT NULL,
  detail TEXT,
  decision_id TEXT,
  at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS fomo_funnel_token ON fomo_funnel (tenant, token_key, at_ms);
CREATE INDEX IF NOT EXISTS fomo_funnel_tenant ON fomo_funnel (tenant, at_ms);
CREATE INDEX IF NOT EXISTS fomo_funnel_at ON fomo_funnel (at_ms);
`;

/** Every table FOMO_SCHEMA creates, in order. */
export const FOMO_TABLES: readonly string[] = [...FOMO_SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]!);

/**
 * A column a table made by an earlier CREATE lacks. `CREATE TABLE IF NOT
 * EXISTS` adds nothing to a table that is already there, so a later column is
 * added by one of these. `ddl` must be exactly `ALTER TABLE <table> ADD COLUMN
 * <column> …` (applyFomoAlters checks), so the guard below cannot drift from
 * the statement it guards.
 */
export interface FomoAlter {
  table: string;
  column: string;
  ddl: string;
}

/** None yet. Append here; never edit a released entry. */
export const FOMO_ALTERS: readonly FomoAlter[] = [];

/**
 * THE SCHEMA LOCK'S KEY. Distinct from every other advisory key in the repo
 * (auth nonces 1_297_691_982, partner store 1_297_692_081..084, the room
 * 1_297_692_090/091, MCP 1_297_692_101/103, X 1_297_692_110..112, the ferry
 * 1_297_692_120/121, settings 1_297_692_130): a shared key would make
 * unrelated first boots queue behind each other.
 */
export const FOMO_SCHEMA_LOCK = 1_297_692_140;

const schemaReady = new WeakMap<Db, Promise<void>>();

/**
 * Create the tables once per Db for the life of the process.
 *
 * Memoised on the Db, and the entry is dropped on failure so a database that
 * was briefly unreachable is retried on the next call instead of never. On
 * Postgres the DDL runs inside a transaction holding an advisory lock, because
 * web and orchestrator boot together and two concurrent CREATE TABLE IF NOT
 * EXISTS can still collide in the catalog (23505 on pg_type).
 */
export function ensureFomoSchema(db: Db, dialect: FomoDialect): Promise<void> {
  const existing = schemaReady.get(db);
  if (existing) return existing;
  const started = (async () => {
    if (dialect === "postgres") {
      await db.tx(async (tx) => {
        await tx.prepare("SELECT pg_advisory_xact_lock(?)").get(FOMO_SCHEMA_LOCK);
        await tx.exec(FOMO_SCHEMA);
      });
    } else {
      await db.exec(FOMO_SCHEMA);
    }
    await applyFomoAlters(db, dialect, FOMO_ALTERS);
  })().catch((error: unknown) => {
    if (schemaReady.get(db) === started) schemaReady.delete(db);
    throw error;
  });
  schemaReady.set(db, started);
  return started;
}

const ALTER_SHAPE = /^ALTER TABLE (\w+) ADD COLUMN (\w+) /;

/**
 * Run the alters a database is missing; returns the ddl of each one run.
 *
 * APART FROM THE CREATE, AND ONLY WHEN MISSING. An ALTER TABLE takes an
 * ACCESS EXCLUSIVE lock even when IF NOT EXISTS makes it a no-op, and the
 * CREATE transaction already holds locks on the tables its CREATE INDEX
 * statements touch; xpost deadlocked an owner's write against exactly that.
 * So on Postgres the alters run in a transaction of their own, under the same
 * advisory lock, and only for a column information_schema says is absent, per
 * table: a normal restart takes no exclusive lock at all. sqlite has one
 * writer and no such lock, so it runs each and ignores "duplicate column".
 *
 * Exported so a test can drive it with a synthetic list.
 */
export async function applyFomoAlters(db: Db, dialect: FomoDialect, alters: readonly FomoAlter[]): Promise<string[]> {
  for (const a of alters) {
    const m = ALTER_SHAPE.exec(a.ddl);
    if (!m || m[1] !== a.table || m[2] !== a.column) throw new TypeError(`fomo store: alter does not match its table/column: ${a.ddl}`);
  }
  if (alters.length === 0) return [];
  const ran: string[] = [];
  if (dialect === "postgres") {
    await db.tx(async (tx) => {
      await tx.prepare("SELECT pg_advisory_xact_lock(?)").get(FOMO_SCHEMA_LOCK);
      for (const table of new Set(alters.map((a) => a.table))) {
        const rows = (await tx
          .prepare("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?")
          .all(table)) as Row[];
        const have = new Set(rows.map((r) => String(r.column_name)));
        for (const a of alters) {
          if (a.table !== table || have.has(a.column)) continue;
          await tx.exec(a.ddl);
          ran.push(a.ddl);
        }
      }
    });
    return ran;
  }
  for (const a of alters) {
    try {
      await db.exec(a.ddl);
      ran.push(a.ddl);
    } catch (e) {
      if (!/duplicate column/i.test(e instanceof Error ? e.message : String(e))) throw e;
    }
  }
  return ran;
}

// ── limits ──────────────────────────────────────────────────────────────────

export const FOMO_LIMITS = {
  /** Active watches one owner may hold. */
  activeWatchesPerTenant: 25,
  /** A watch must expire, and within this. */
  watchMaxMs: 30 * DAY_MS,
  /** Active tails one owner may hold (a tail is a few hours of one trader's alerts). */
  activeTailsPerTenant: 3,
  /** The shortest tail the tools offer (store: any future expiry within tailMaxMs). */
  tailMinMs: 3_600_000,
  /** A tail must expire, and within this. */
  tailMaxMs: 12 * 3_600_000,
  /** Distinct tailed traders the fleet's research routing reads (orchestrator-fomo.ts fleetInterest). */
  tailedTradersFleet: 200,
  /** Active position dependencies one owner may hold. */
  activePositionDepsPerTenant: 30,
  /** A dependency must expire within this; the lifecycle pass renews it while the position is open. */
  positionDepMaxMs: 30 * DAY_MS,
  /** Queued or running jobs one owner may have at once. */
  activeJobsPerTenant: 3,
  /** Claims of one job before a lapsed lease is read as a job that kills its worker. */
  jobMaxAttempts: 3,
  researchMaxAttempts: 3,
  deadLetterPayloadChars: 8_192,
  errorChars: 500,
  reasonChars: 500,
  publicationBodyChars: 4_000,
  cachePayloadChars: 1_000_000,
  dossierJsonChars: 512_000,
  eventJsonChars: 32_768,
  assessmentJsonChars: 128_000,
  jobParamsChars: 16_384,
  jobResultChars: 256_000,
  metaJsonChars: 8_192,
  /** subject-memory.ts MAX_SERIALIZED_LENGTH, with room; also the cap for a `state:` key's durable state (16 KiB). */
  subjectJsonChars: 16_384,
  keyChars: 256,
  /** Coins one owner's held set may name (a book this large is already beyond what the routing reads). */
  heldTokensPerTenant: 200,
  traderEvidenceJsonChars: 4_096,
  handleChars: 64,
  nameChars: 128,
  pageMax: 500,
} as const;

/** Retrieval priority as a queue integer: larger is claimed first. */
export const RESEARCH_PRIORITY: Readonly<Record<RetrievalPriority, number>> = {
  "position-protection": 300,
  interactive: 200,
  discovery: 100,
};

// ── vocabularies ────────────────────────────────────────────────────────────
//
// Record<Union, true> rather than a Set: the compiler then insists every
// member of the union in types.ts is listed and nothing else is, so a value
// added there cannot be silently refused (or an old one accepted) here.

const NAMESPACES: Record<ChainNamespace, true> = { eip155: true, solana: true, hyperliquid: true, unknown: true };
const ACTIVITY_KINDS: Record<ActivityKind, true> = {
  buy: true, sell: true, "transfer-in": true, "transfer-out": true, airdrop: true, thesis: true, perp: true, listing: true, other: true,
};
const IDENTITY_BASES: Record<EventIdentityBasis, true> = { "provider-event-id": true, "fill-identity": true, fingerprint: true };
const EVENT_SOURCES: Record<EventSource, true> = { stream: true, "rest-recovery": true, "rest-lookup": true };
const OBSERVATION_BASES: Record<ObservationBasis, true> = { "provider-reported": true, "provider-verified": true, "independently-verified": true };
const EVIDENCE_KINDS: Record<EvidenceKind, true> = {
  event: true, thesis: true, comment: true, holdings: true, positions: true, fills: true, profile: true, ranking: true, board: true,
  "token-stats": true, dossier: true, assessment: true, decision: true,
};
const CAPABILITY_STATUSES: Record<CapabilityStatus, true> = {
  DOCUMENTED: true, AUTHENTICATED_TESTED: true, PARTIAL: true, ENTITLEMENT_BLOCKED: true, UNAVAILABLE: true, UNSUPPORTED: true,
};
const COHORT_CHANGES: Record<CohortChange, true> = { added: true, retained: true, removed: true };
const FRESHNESS_CLASSES: Record<FreshnessClass, true> = {
  activity: true, holdings: true, rankings: true, theses: true, "token-stats": true, profile: true, boards: true,
};
type AttemptOutcome = NonNullable<Freshness["lastRefreshOutcome"]>;
const ATTEMPT_OUTCOMES: Record<AttemptOutcome, true> = { ok: true, failed: true, "skipped-budget": true, "skipped-fresh": true };
const SURFACES: Record<FomoSurface, true> = { "app-chat": true, "telegram-dm": true, "telegram-group": true, mcp: true, background: true };
const RESULT_STATUSES: Record<ResultStatus, true> = {
  ok: true, empty: true, partial: true, capped: true, stale: true, failed: true, unavailable: true, "not-authorized": true,
  "budget-limited": true, "needs-clarification": true, "not-found": true,
};
const RESEARCH_STATES: Record<ResearchState, true> = {
  WATCH: true, PROBE_CANDIDATE: true, ENTRY_CANDIDATE: true, ADD_CANDIDATE: true, HOLD_POSITION: true, REDUCE_CANDIDATE: true,
  EXIT_CANDIDATE: true, REJECT_SETUP: true, RESEARCH_ONLY: true,
};
const EXECUTION_AVAILABILITY: Record<ExecutionAvailability, true> = {
  "supported-authorized": true, "supported-permission-missing": true, "unsupported-venue": true, "unsupported-chain": true,
  "unresolved-identity": true,
};
const FUNNEL_STAGES: Record<FunnelStage, true> = {
  NOT_DISCOVERED: true, DISCOVERY_SCREENED_OUT: true, RESEARCH_INCOMPLETE: true, MODEL_HOLD: true, GATE_FORCED_HOLD: true,
  PERMISSION_BLOCKED: true, UNSUPPORTED_ROUTE: true, SIZE_BELOW_ECONOMIC_FLOOR: true, SPONSORSHIP_UNAVAILABLE: true,
  BUDGET_EXHAUSTED: true, SUBMISSION_FAILED: true, SETTLEMENT_PENDING: true, LANDED: true,
};
const PUBLICATION_KINDS: Record<PublicationKind, true> = {
  researching: true, watching: true, "considering-entry": true, submitted: true, "paper-traded": true, "confirmed-purchase": true,
  "confirmed-reduction": true, "confirmed-exit": true, correction: true,
};
const PUBLICATION_STATES: Record<PublicationState, true> = {
  draft: true, "blocked-policy": true, "blocked-consent": true, "suppressed-duplicate": true, queued: true, sending: true, sent: true,
  uncertain: true, "reconciled-sent": true, "reconciled-absent": true, cancelled: true, failed: true,
};

function isIn<T extends string>(set: Record<T, true>, v: unknown): v is T {
  return typeof v === "string" && Object.hasOwn(set, v);
}

// ── binding helpers ─────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

/** Tenants are lowercased owner wallets; normalising here keeps a checksummed caller from splitting one owner into two. */
export function tenantKey(tenant: string | null | undefined): string {
  return String(tenant ?? "").trim().toLowerCase();
}

/**
 * A tenant a statement may use. Missing is a programming error on a read as
 * much as on a write: an empty tenant would either write an orphan row or
 * read nothing for a reason nobody would see, so it throws.
 */
function tenantOf(tenant: string): string {
  const t = tenantKey(tenant);
  if (!t || t.length > FOMO_LIMITS.keyChars || t.includes("\u0000")) throw new TypeError("fomo store: a tenant is required");
  return t;
}

/** An exact key (token key, event key, id). Never trimmed or case-folded: Solana mints are case-sensitive. */
function keyOf(v: unknown, what: string, max: number = FOMO_LIMITS.keyChars): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max || v.includes("\u0000")) {
    throw new TypeError(`fomo store: ${what} must be a non-empty string of at most ${max} characters`);
  }
  return v;
}

function optKey(v: unknown, what: string, max: number = FOMO_LIMITS.keyChars): string | null {
  return v === null || v === undefined || v === "" ? null : keyOf(v, what, max);
}

/** A required time or count. pg refuses a fractional BIGINT, so it is truncated here, and NaN is a bug, not a zero. */
function intOf(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new TypeError(`fomo store: ${what} must be a finite number`);
  const r = Math.trunc(v);
  if (!Number.isSafeInteger(r)) throw new RangeError(`fomo store: ${what} is out of range`);
  return r;
}

/** An optional time: anything that is not a finite number is unknown (null), never 0. */
function optInt(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const r = Math.trunc(v);
  return Number.isSafeInteger(r) ? r : null;
}

function countOf(v: unknown, what: string): number {
  const n = intOf(v, what);
  if (n < 0) throw new RangeError(`fomo store: ${what} must not be negative`);
  return n;
}

/** A short identifier the store owns the shape of (destination, job kind, tool, bucket). */
function slugOf(v: unknown, what: string): string {
  if (typeof v !== "string" || !/^[a-z][a-z0-9_.:-]{0,63}$/.test(v)) throw new TypeError(`fomo store: ${what} must be a short lowercase identifier`);
  return v;
}

/**
 * Free text bound for a TEXT column: NUL replaced (Postgres refuses it) and
 * capped without leaving half a surrogate pair at the cut.
 */
function textOf(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  let s = v.includes("\u0000") ? v.replace(/\u0000/g, "�") : v;
  if (s.length > max) {
    s = s.slice(0, max);
    const last = s.charCodeAt(s.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
  }
  return s;
}

/** JSON for a TEXT column. Over the cap is refused rather than cut: truncated JSON is corrupt JSON. */
function jsonOf(v: unknown, max: number, what: string): string {
  const s = JSON.stringify(v === undefined ? null : v);
  if (typeof s !== "string") throw new TypeError(`fomo store: ${what} is not serialisable`);
  if (s.length > max) throw new RangeError(`fomo store: ${what} is ${s.length} characters, over the ${max} limit`);
  return s;
}

function pageOf(limit: unknown, max: number = FOMO_LIMITS.pageMax): number {
  const n = typeof limit === "number" && Number.isFinite(limit) ? Math.trunc(limit) : max;
  return Math.min(max, Math.max(1, n));
}

function chunksOf<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

function valuesList(columns: number, rows: number): string {
  const one = `(${Array.from({ length: columns }, () => "?").join(", ")})`;
  return Array.from({ length: rows }, () => one).join(", ");
}

function marks(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

const bit = (b: boolean): number => (b ? 1 : 0);

// ── reading helpers ─────────────────────────────────────────────────────────

/** Integer columns arrive as number (sqlite; pg with the int8 parser) or string/bigint (a pg without it). */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function flag(v: unknown): boolean | null {
  const n = num(v);
  return n === null ? null : n !== 0;
}

function parseJson(v: unknown): unknown {
  if (typeof v !== "string") return null;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return null;
  }
}

function record(v: unknown): Row | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Row) : null;
}

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function figures(v: unknown): Record<string, number | null> {
  const r = record(v);
  const out: Record<string, number | null> = {};
  if (!r) return out;
  for (const [k, x] of Object.entries(r)) out[k] = finite(x);
  return out;
}

// ── normalisers for stored JSON ─────────────────────────────────────────────
//
// Every JSON blob is rebuilt field by field on the way in AND on the way out.
// In: a field that is not in the type never reaches the shared database. Out:
// a row written by an older (or newer) build, or edited by hand, comes back in
// today's shape or not at all; a wrong type becomes null (unknown), never 0.

function tokenOf(v: unknown): TokenIdentity | null {
  const r = record(v);
  const c = record(r?.chain);
  if (!r || !c || !isIn(NAMESPACES, c.namespace)) return null;
  const networkId = c.networkId === null ? null : finite(c.networkId);
  if (networkId !== null && !(Number.isSafeInteger(networkId) && networkId > 0)) return null;
  if (c.networkId !== null && networkId === null) return null;
  const address = typeof r.address === "string" && r.address.length > 0 ? r.address : null;
  if (!address) return null;
  const key = `${c.namespace}:${networkId ?? "?"}:${address}`;
  // The key is the only join column; one that disagrees with its own parts is corrupt.
  if (r.key !== key) return null;
  return { chain: { namespace: c.namespace, networkId, slug: str(c.slug) }, address, key };
}

function labelOf(v: unknown): TokenLabel {
  const r = record(v);
  return { symbol: str(r?.symbol), name: str(r?.name) };
}

function traderOf(v: unknown): TraderIdentity | null {
  const r = record(v);
  const userId = r && typeof r.userId === "string" && r.userId.length > 0 ? r.userId : null;
  if (!r || !userId) return null;
  return {
    userId,
    handle: str(r.handle),
    displayName: str(r.displayName),
    verified: typeof r.verified === "boolean" ? r.verified : null,
  };
}

function evidenceRefsOf(v: unknown): EvidenceRef[] {
  if (!Array.isArray(v)) return [];
  const out: EvidenceRef[] = [];
  for (const x of v) {
    const r = record(x);
    if (!r || typeof r.id !== "string" || !isIn(EVIDENCE_KINDS, r.kind)) continue;
    out.push({ id: r.id, kind: r.kind, sourceUrl: str(r.sourceUrl) });
  }
  return out;
}

/** A trader event in today's shape, or null. Exported for the modules that read event_json elsewhere. */
export function traderEventOf(v: unknown): TraderEvent | null {
  const r = record(v);
  if (!r) return null;
  const trader = traderOf(r.trader);
  const observedAt = finite(r.observedAt);
  if (
    typeof r.eventKey !== "string" ||
    r.eventKey.length === 0 ||
    !trader ||
    observedAt === null ||
    !isIn(IDENTITY_BASES, r.identityBasis) ||
    !isIn(EVENT_SOURCES, r.source) ||
    !isIn(ACTIVITY_KINDS, r.kind) ||
    !isIn(OBSERVATION_BASES, r.verification)
  ) {
    return null;
  }
  const token = r.token === null || r.token === undefined ? null : tokenOf(r.token);
  // A token that was there but no longer parses is corruption, not "no token".
  if (r.token !== null && r.token !== undefined && token === null) return null;
  // Fields added after events were first stored: read back only when the stored copy has them.
  const optional: Partial<TraderEvent> = {};
  if ("providerAlertId" in r) optional.providerAlertId = typeof r.providerAlertId === "string" && /^alrt_\d{13}_\d{1,12}$/.test(r.providerAlertId) ? r.providerAlertId : null;
  if ("providerAlertSeq" in r) {
    const seq = finite(r.providerAlertSeq);
    optional.providerAlertSeq = seq !== null && Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
  }
  // Only a buy or a sell is a fill (provider.ts alertFrameToEvent): a copy of any other kind never reads back with one.
  const fillKind = r.kind === "buy" || r.kind === "sell";
  if ("fillUsdSource" in r) optional.fillUsdSource = fillKind && typeof r.fillUsdSource === "string" && /^[a-z0-9][a-z0-9_-]{0,23}$/.test(r.fillUsdSource) ? r.fillUsdSource : null;
  if ("perp" in r) {
    const p = record(r.perp);
    const lev = finite(p?.leverage);
    optional.perp =
      p && (p.action === "open" || p.action === "close") && (p.side === "long" || p.side === "short") && lev !== null && Number.isSafeInteger(lev) && lev >= 1
        ? { action: p.action, side: p.side, leverage: lev }
        : null;
  }
  return {
    ...optional,
    eventKey: r.eventKey,
    identityBasis: r.identityBasis,
    // Unknown ambiguity is ambiguity: only an explicit false clears it.
    identityAmbiguous: r.identityAmbiguous !== false,
    source: r.source,
    kind: r.kind,
    trader,
    token,
    tokenLabel: labelOf(r.tokenLabel),
    tradeId: str(r.tradeId),
    swapId: str(r.swapId),
    transferId: str(r.transferId),
    txHash: str(r.txHash),
    fillUsd: fillKind ? finite(r.fillUsd) : null,
    fillUsdBasis: fillKind && (r.fillUsdBasis === "onchain-exact" || r.fillUsdBasis === "ambiguous") ? r.fillUsdBasis : null,
    positionValueUsd: finite(r.positionValueUsd),
    positionRealizedPnlUsdCumulative: finite(r.positionRealizedPnlUsdCumulative),
    sourceEventAt: finite(r.sourceEventAt),
    execAt: finite(r.execAt),
    observedAt,
    // "Provider matched it on chain" is a claim about a FILL: a stored transfer,
    // airdrop, listing or thesis row (written before the fill gate) reads back
    // as provider-reported, so no non-trade event is ever shown as verified.
    verification: !fillKind && r.verification === "provider-verified" ? "provider-reported" : r.verification,
    text: str(r.text),
    replay: r.replay === true,
  };
}

const USDG6 = /^\d{1,30}$/;
const PRICE8 = /^\d{1,24}(\.\d{1,8})?$/;

/** A follow assessment in today's shape, or null. */
export function followAssessmentOf(v: unknown): FollowAssessment | null {
  const r = record(v);
  if (!r) return null;
  const token = tokenOf(r.token);
  const createdAt = finite(r.createdAt);
  if (
    typeof r.id !== "string" ||
    r.id.length === 0 ||
    typeof r.tenant !== "string" ||
    r.tenant.length === 0 ||
    !token ||
    createdAt === null ||
    !isIn(RESEARCH_STATES, r.state) ||
    !isIn(EXECUTION_AVAILABILITY, r.executionAvailability)
  ) {
    return null;
  }
  const q = record(r.decisionQuote);
  const quoteAt = finite(q?.at);
  const decisionQuote =
    q && typeof q.price8 === "string" && PRICE8.test(q.price8) && quoteAt !== null && typeof q.source === "string"
      ? { price8: q.price8, at: quoteAt, source: q.source }
      : null;
  const d = record(r.dossierRevision);
  const revision = finite(d?.revision);
  const dossierRevision =
    d && typeof d.dossierId === "string" && revision !== null && Number.isSafeInteger(revision) ? { dossierId: d.dossierId, revision } : null;
  // The ceiling is a bigint amount in micro-USDG. Anything that is not a plain
  // non-negative integer string is no ceiling at all, never a guessed one.
  const sizeCeilingUsdg6 = typeof r.sizeCeilingUsdg6 === "string" && USDG6.test(r.sizeCeilingUsdg6) ? r.sizeCeilingUsdg6 : null;
  return {
    id: r.id,
    tenant: tenantKey(r.tenant),
    token,
    label: labelOf(r.label),
    triggerEventKeys: strings(r.triggerEventKeys),
    state: r.state,
    reasonCodes: strings(r.reasonCodes),
    supporting: evidenceRefsOf(r.supporting),
    opposing: evidenceRefsOf(r.opposing),
    signalDelayMs: finite(r.signalDelayMs),
    researchDelayMs: finite(r.researchDelayMs),
    priceMovePct: finite(r.priceMovePct),
    decisionQuote,
    setupExpiresAt: finite(r.setupExpiresAt),
    horizon: str(r.horizon),
    invalidation: strings(r.invalidation),
    sizeCeilingUsdg6,
    dossierRevision,
    executionAvailability: r.executionAvailability,
    createdAt,
  };
}

// ── per-tenant serialisation ────────────────────────────────────────────────

/**
 * ONE WRITER PER (TENANT, SCOPE) FOR THE REST OF THIS TRANSACTION.
 *
 * A per-owner cap is a read (count the active rows) followed by a write. Under
 * Postgres READ COMMITTED two transactions can both count 24 and both insert,
 * ending at 26. Upserting this row first takes its row lock until commit, so
 * the second transaction waits, then counts again and sees the first one's
 * row. sqlite gets the same from its single writer. Unlike an advisory lock it
 * needs no dialect and no second key namespace to keep distinct.
 */
async function lockTenant(tx: Db, tenant: string, scope: "jobs" | "watches" | "tails" | "position-deps" | "held-tokens", nowMs: number): Promise<void> {
  await tx
    .prepare(
      `INSERT INTO fomo_tenant_locks (tenant, lock_scope, touched_at_ms) VALUES (?, ?, ?)
       ON CONFLICT (tenant, lock_scope) DO UPDATE SET touched_at_ms = excluded.touched_at_ms`,
    )
    .run(tenant, scope, nowMs);
}

// ═══════════════════════════════ SHARED TABLES ═══════════════════════════════

// ── capabilities ────────────────────────────────────────────────────────────

/** Record what a capability was last verified as. An older verification never overwrites a newer one. True when written. */
export async function upsertCapability(db: Db, rec: CapabilityRecord): Promise<boolean> {
  if (!isIn(CAPABILITY_STATUSES, rec.status)) throw new TypeError("fomo store: unknown capability status");
  const row = await db
    .prepare(
      `INSERT INTO fomo_capabilities (capability, route, status, evidence, verified_at_ms) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (capability) DO UPDATE SET route = excluded.route, status = excluded.status,
         evidence = excluded.evidence, verified_at_ms = excluded.verified_at_ms
       WHERE fomo_capabilities.verified_at_ms <= excluded.verified_at_ms
       RETURNING capability`,
    )
    .get(
      keyOf(rec.capability, "capability", 64),
      textOf(rec.route, 200) ?? "",
      rec.status,
      textOf(rec.evidence, FOMO_LIMITS.reasonChars) ?? "",
      intOf(rec.verifiedAt, "verifiedAt"),
    );
  return row !== undefined && row !== null;
}

export async function listCapabilities(db: Db): Promise<CapabilityRecord[]> {
  const rows = (await db
    .prepare("SELECT capability, route, status, evidence, verified_at_ms FROM fomo_capabilities ORDER BY capability")
    .all()) as Row[];
  const out: CapabilityRecord[] = [];
  for (const r of rows) {
    const capability = str(r.capability);
    const verifiedAt = num(r.verified_at_ms);
    if (!capability || verifiedAt === null) continue;
    // A status this build does not know is not evidence of anything.
    out.push({
      capability,
      route: str(r.route) ?? "",
      status: isIn(CAPABILITY_STATUSES, r.status) ? r.status : "UNAVAILABLE",
      evidence: str(r.evidence) ?? "",
      verifiedAt,
    });
  }
  return out;
}

// ── traders and handle history ──────────────────────────────────────────────

export interface StoredTrader extends TraderIdentity {
  firstSeenMs: number;
  lastSeenMs: number;
}

/** A handle as history and lookup key it: trimmed, without leading @, lowercased. Null when it is not a handle. */
export function normalizeHandle(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const h = raw.trim().replace(/^@+/, "").toLowerCase();
  if (!h || h.length > FOMO_LIMITS.handleChars || /[\s\u0000]/.test(h)) return null;
  return h;
}

/**
 * A trader write that keeps the NEWEST observation. REST recovery delivers
 * events out of order, so a stale copy must not rename a trader back, and an
 * unknown (null) field never erases a known one.
 */
async function writeTrader(db: Db, trader: TraderIdentity, seenAtMs: number): Promise<void> {
  const userId = keyOf(trader.userId, "trader.userId", 128);
  const seen = intOf(seenAtMs, "seenAtMs");
  const handle = textOf(typeof trader.handle === "string" ? trader.handle.trim().replace(/^@+/, "") : null, FOMO_LIMITS.handleChars) || null;
  const verified = typeof trader.verified === "boolean" ? bit(trader.verified) : null;
  await db
    .prepare(
      `INSERT INTO fomo_traders (user_id, handle, display_name, verified, first_seen_ms, last_seen_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         handle = CASE WHEN excluded.handle IS NOT NULL AND excluded.last_seen_ms >= fomo_traders.last_seen_ms
                       THEN excluded.handle ELSE fomo_traders.handle END,
         display_name = CASE WHEN excluded.display_name IS NOT NULL AND excluded.last_seen_ms >= fomo_traders.last_seen_ms
                             THEN excluded.display_name ELSE fomo_traders.display_name END,
         verified = CASE WHEN excluded.verified IS NOT NULL AND excluded.last_seen_ms >= fomo_traders.last_seen_ms
                         THEN excluded.verified ELSE fomo_traders.verified END,
         first_seen_ms = CASE WHEN excluded.first_seen_ms < fomo_traders.first_seen_ms
                              THEN excluded.first_seen_ms ELSE fomo_traders.first_seen_ms END,
         last_seen_ms = CASE WHEN excluded.last_seen_ms > fomo_traders.last_seen_ms
                             THEN excluded.last_seen_ms ELSE fomo_traders.last_seen_ms END`,
    )
    .run(userId, handle, textOf(trader.displayName, FOMO_LIMITS.nameChars) || null, verified, seen, seen);
  const key = normalizeHandle(handle);
  if (!key) return;
  await db
    .prepare(
      `INSERT INTO fomo_trader_handles (user_id, handle, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, handle) DO UPDATE SET
         first_seen_ms = CASE WHEN excluded.first_seen_ms < fomo_trader_handles.first_seen_ms
                              THEN excluded.first_seen_ms ELSE fomo_trader_handles.first_seen_ms END,
         last_seen_ms = CASE WHEN excluded.last_seen_ms > fomo_trader_handles.last_seen_ms
                             THEN excluded.last_seen_ms ELSE fomo_trader_handles.last_seen_ms END`,
    )
    .run(userId, key, seen, seen);
}

/**
 * Upsert a trader and the handle it was seen with. Identity is the user id;
 * a rename adds a handle row instead of replacing one, so a search for the
 * old handle still finds the same trader (and says it is a former handle).
 */
export async function upsertTrader(db: Db, trader: TraderIdentity, seenAtMs: number): Promise<void> {
  await db.tx((tx) => writeTrader(tx, trader, seenAtMs));
}

/**
 * LOCK ORDER FOR TRADER ROWS: by user id, never the caller's order. Every
 * writer that upserts several traders in one transaction (a rankings page in
 * window rank order, a cohort version in cohort rank order) takes their row
 * locks in this one order, so two of them covering the same traders cannot
 * each hold a row the other waits on (Postgres 40P01). insertEvents sorts its
 * keys for the same reason. The sort is stable: a trader listed twice is
 * still written in the order given.
 */
function inLockOrder<T>(xs: readonly T[], idOf: (x: T) => unknown): T[] {
  return [...xs].sort((x, y) => {
    const a = String(idOf(x));
    const b = String(idOf(y));
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** Many traders seen at once (a leaderboard page), in one transaction, in lock order. */
export async function upsertTraders(db: Db, traders: readonly TraderIdentity[], seenAtMs: number): Promise<void> {
  if (traders.length === 0) return;
  await db.tx(async (tx) => {
    for (const t of inLockOrder(traders, (x) => x.userId)) await writeTrader(tx, t, seenAtMs);
  });
}

const TRADER_COLUMNS = "user_id, handle, display_name, verified, first_seen_ms, last_seen_ms";

function storedTraderOf(r: Row): StoredTrader | null {
  const userId = str(r.user_id);
  const first = num(r.first_seen_ms);
  const last = num(r.last_seen_ms);
  if (!userId || first === null || last === null) return null;
  return { userId, handle: str(r.handle), displayName: str(r.display_name), verified: flag(r.verified), firstSeenMs: first, lastSeenMs: last };
}

export async function traderById(db: Db, userId: string): Promise<StoredTrader | null> {
  const row = (await db.prepare(`SELECT ${TRADER_COLUMNS} FROM fomo_traders WHERE user_id = ?`).get(keyOf(userId, "userId", 128))) as
    | Row
    | undefined;
  return row ? storedTraderOf(row) : null;
}

/**
 * The trader most recently seen with this handle (case and a leading @
 * ignored). `handleIsCurrent` is false when that trader has since renamed:
 * the caller should say "formerly @x" rather than present an old name as
 * today's. Handles are labels; a caller that needs certainty resolves by id.
 */
export async function traderByHandle(db: Db, handle: string): Promise<(StoredTrader & { handleIsCurrent: boolean }) | null> {
  const key = normalizeHandle(handle);
  if (!key) return null;
  const row = (await db
    .prepare(
      `SELECT t.user_id, t.handle, t.display_name, t.verified, t.first_seen_ms, t.last_seen_ms
         FROM fomo_trader_handles h JOIN fomo_traders t ON t.user_id = h.user_id
        WHERE h.handle = ?
        ORDER BY h.last_seen_ms DESC, h.user_id
        LIMIT 1`,
    )
    .get(key)) as Row | undefined;
  const trader = row ? storedTraderOf(row) : null;
  return trader ? { ...trader, handleIsCurrent: normalizeHandle(trader.handle) === key } : null;
}

/** Every handle a trader has been seen with, newest first. */
export async function handleHistory(db: Db, userId: string): Promise<{ handle: string; firstSeenMs: number; lastSeenMs: number }[]> {
  const rows = (await db
    .prepare("SELECT handle, first_seen_ms, last_seen_ms FROM fomo_trader_handles WHERE user_id = ? ORDER BY last_seen_ms DESC, handle")
    .all(keyOf(userId, "userId", 128))) as Row[];
  return rows.flatMap((r) => {
    const handle = str(r.handle);
    const first = num(r.first_seen_ms);
    const last = num(r.last_seen_ms);
    return handle && first !== null && last !== null ? [{ handle, firstSeenMs: first, lastSeenMs: last }] : [];
  });
}

// ── trader evidence (cohort enrichment) ─────────────────────────────────────

/**
 * What Merrymen MEASURED about a trader from their positions, for the cohort
 * score (cohort.ts CohortCandidate's reconstructed inputs). Shared: it is a
 * fact about a public trader, not about any owner. Every figure is null when
 * the sample could not support it; nothing here is a provider body.
 */
export interface StoredTraderEvidence {
  userId: string;
  measuredAtMs: number;
  /** Positions the measurement read. */
  sampleSize: number;
  chainActivity: { robinhoodShare: number | null; sampleSize: number | null } | null;
  holding: { averageHoldSeconds: number | null; sampleSize: number | null } | null;
  exits: { closedWithGain: number | null; closedWithLoss: number | null; heldUnderwater: number | null } | null;
  concentration: { topPositionShare: number | null } | null;
  executionCapacity: { medianPositionUsd: number | null } | null;
}

const shareOf = (v: unknown): number | null => {
  const n = finite(v);
  return n !== null && n >= 0 && n <= 1 ? n : null;
};
const nonNegOf = (v: unknown): number | null => {
  const n = finite(v);
  return n !== null && n >= 0 ? n : null;
};
const countFigure = (v: unknown): number | null => {
  const n = finite(v);
  return n !== null && n >= 0 && Number.isSafeInteger(n) ? n : null;
};

/** The evidence fields in today's shape, field by field, on the way in and out. */
function evidenceFields(v: unknown): Omit<StoredTraderEvidence, "userId" | "measuredAtMs" | "sampleSize"> {
  const r = record(v);
  const ca = record(r?.chainActivity);
  const ho = record(r?.holding);
  const ex = record(r?.exits);
  const co = record(r?.concentration);
  const ec = record(r?.executionCapacity);
  return {
    chainActivity: ca ? { robinhoodShare: shareOf(ca.robinhoodShare), sampleSize: countFigure(ca.sampleSize) } : null,
    holding: ho ? { averageHoldSeconds: nonNegOf(ho.averageHoldSeconds), sampleSize: countFigure(ho.sampleSize) } : null,
    exits: ex ? { closedWithGain: countFigure(ex.closedWithGain), closedWithLoss: countFigure(ex.closedWithLoss), heldUnderwater: countFigure(ex.heldUnderwater) } : null,
    concentration: co ? { topPositionShare: shareOf(co.topPositionShare) } : null,
    executionCapacity: ec ? { medianPositionUsd: nonNegOf(ec.medianPositionUsd) } : null,
  };
}

/**
 * Keep a trader's measured evidence. The NEWER measurement wins: a slow
 * refresh that read positions earlier cannot replace a later reading. True
 * when written.
 */
export async function putTraderEvidence(db: Db, e: StoredTraderEvidence): Promise<boolean> {
  const fields = evidenceFields(e);
  const row = await db
    .prepare(
      `INSERT INTO fomo_trader_evidence (user_id, measured_at_ms, sample_size, evidence_json) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET measured_at_ms = excluded.measured_at_ms, sample_size = excluded.sample_size,
         evidence_json = excluded.evidence_json
       WHERE fomo_trader_evidence.measured_at_ms <= excluded.measured_at_ms
       RETURNING user_id`,
    )
    .get(
      keyOf(e.userId, "userId", 128),
      intOf(e.measuredAtMs, "measuredAtMs"),
      countOf(e.sampleSize, "sampleSize"),
      jsonOf(fields, FOMO_LIMITS.traderEvidenceJsonChars, "trader evidence"),
    );
  return row !== undefined && row !== null;
}

/** Stored evidence for these traders, by user id. A trader never measured is absent. */
export async function traderEvidence(db: Db, userIds: readonly string[]): Promise<Map<string, StoredTraderEvidence>> {
  const out = new Map<string, StoredTraderEvidence>();
  const ids = [...new Set(userIds.map((u) => keyOf(u, "userId", 128)))];
  for (const part of chunksOf(ids, 200)) {
    const rows = (await db
      .prepare(`SELECT user_id, measured_at_ms, sample_size, evidence_json FROM fomo_trader_evidence WHERE user_id IN (${marks(part.length)})`)
      .all(...part)) as Row[];
    for (const r of rows) {
      const userId = str(r.user_id);
      const measured = num(r.measured_at_ms);
      const sample = num(r.sample_size);
      if (!userId || measured === null || sample === null) continue;
      out.set(userId, { userId, measuredAtMs: measured, sampleSize: sample, ...evidenceFields(parseJson(r.evidence_json)) });
    }
  }
  return out;
}

// ── cohort versions ─────────────────────────────────────────────────────────

/**
 * Store a cohort version with its members and changes, ATOMICALLY: a reader
 * never sees a version with half its members. A version number that already
 * exists is left alone and false is returned (a replayed build is a no-op).
 * Members are ranked by their order in `cohort.members`; their traders are
 * upserted in the same transaction so the version reads back with handles.
 */
export async function insertCohortVersion(db: Db, cohort: CohortVersion, inputs: unknown = null): Promise<boolean> {
  const version = intOf(cohort.version, "cohort.version");
  if (version < 1) throw new RangeError("fomo store: cohort.version must be positive");
  const createdAt = intOf(cohort.createdAt, "cohort.createdAt");
  const seen = new Set<string>();
  const members = cohort.members.map((m, i) => {
    const userId = keyOf(m.trader.userId, "member userId", 128);
    if (seen.has(userId)) throw new TypeError(`fomo store: cohort member ${userId} appears twice`);
    seen.add(userId);
    if (!Number.isFinite(m.score)) throw new TypeError("fomo store: a cohort score must be finite");
    return [
      version,
      userId,
      i + 1,
      String(m.score),
      bit(m.followable),
      jsonOf(strings(m.reasons), FOMO_LIMITS.metaJsonChars, "member reasons"),
      jsonOf(
        {
          providerReported: figures(m.evidence.providerReported),
          reconstructed: figures(m.evidence.reconstructed),
          prospective: figures(m.evidence.prospective),
          sampleSize: finite(m.sampleSize),
        },
        FOMO_LIMITS.metaJsonChars,
        "member evidence",
      ),
      intOf(m.includedAt, "member includedAt"),
    ];
  });
  const changedUsers = new Set<string>();
  const changes = cohort.changes.map((c) => {
    const userId = keyOf(c.userId, "change userId", 128);
    if (changedUsers.has(userId)) throw new TypeError(`fomo store: cohort change for ${userId} appears twice`);
    changedUsers.add(userId);
    if (!isIn(COHORT_CHANGES, c.change)) throw new TypeError("fomo store: unknown cohort change");
    return [version, userId, c.change, textOf(c.reason, FOMO_LIMITS.reasonChars) ?? "", createdAt];
  });
  const inputsJson = jsonOf(inputs, FOMO_LIMITS.metaJsonChars * 8, "cohort inputs");
  return db.tx(async (tx) => {
    const head = await tx
      .prepare(
        `INSERT INTO fomo_cohort_versions (version, created_at_ms, target, member_count, shortfall_reason, inputs_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (version) DO NOTHING
         RETURNING version`,
      )
      .get(version, createdAt, countOf(cohort.target, "cohort.target"), members.length, textOf(cohort.shortfallReason, FOMO_LIMITS.reasonChars), inputsJson);
    if (head === undefined || head === null) return false;
    for (const part of chunksOf(members, 50)) {
      await tx
        .prepare(
          `INSERT INTO fomo_cohort_members (version, user_id, rank, score, followable, reasons_json, evidence_json, included_at_ms)
           VALUES ${valuesList(8, part.length)}`,
        )
        .run(...part.flat());
    }
    for (const part of chunksOf(changes, 50)) {
      await tx
        .prepare(`INSERT INTO fomo_cohort_changes (version, user_id, change, reason, at_ms) VALUES ${valuesList(5, part.length)}`)
        .run(...part.flat());
    }
    // Lock order, not rank order: see inLockOrder.
    for (const m of inLockOrder(cohort.members, (x) => x.trader.userId)) await writeTrader(tx, m.trader, createdAt);
    return true;
  });
}

async function readCohort(db: Db, head: Row): Promise<{ cohort: CohortVersion; inputs: unknown } | null> {
  const version = num(head.version);
  const createdAt = num(head.created_at_ms);
  const target = num(head.target);
  if (version === null || createdAt === null || target === null) return null;
  const memberRows = (await db
    .prepare(
      `SELECT m.user_id, m.rank, m.score, m.followable, m.reasons_json, m.evidence_json, m.included_at_ms,
              t.handle, t.display_name, t.verified
         FROM fomo_cohort_members m LEFT JOIN fomo_traders t ON t.user_id = m.user_id
        WHERE m.version = ?
        ORDER BY m.rank`,
    )
    .all(version)) as Row[];
  const members: CohortMember[] = [];
  for (const r of memberRows) {
    const userId = str(r.user_id);
    const score = num(r.score);
    const includedAt = num(r.included_at_ms);
    if (!userId || score === null || includedAt === null) continue;
    const ev = record(parseJson(r.evidence_json));
    members.push({
      trader: { userId, handle: str(r.handle), displayName: str(r.display_name), verified: flag(r.verified) },
      score,
      reasons: strings(parseJson(r.reasons_json)),
      followable: num(r.followable) === 1,
      evidence: { providerReported: figures(ev?.providerReported), reconstructed: figures(ev?.reconstructed), prospective: figures(ev?.prospective) },
      sampleSize: finite(ev?.sampleSize),
      includedAt,
    });
  }
  const changeRows = (await db
    .prepare("SELECT user_id, change, reason FROM fomo_cohort_changes WHERE version = ? ORDER BY user_id")
    .all(version)) as Row[];
  const changes: CohortVersion["changes"] = [];
  for (const r of changeRows) {
    const userId = str(r.user_id);
    if (userId && isIn(COHORT_CHANGES, r.change)) changes.push({ userId, change: r.change, reason: str(r.reason) ?? "" });
  }
  return {
    cohort: { version, createdAt, target, members, shortfallReason: str(head.shortfall_reason), changes },
    inputs: parseJson(head.inputs_json),
  };
}

const COHORT_HEAD = "SELECT version, created_at_ms, target, member_count, shortfall_reason, inputs_json FROM fomo_cohort_versions";

export async function latestCohort(db: Db): Promise<{ cohort: CohortVersion; inputs: unknown } | null> {
  const head = (await db.prepare(`${COHORT_HEAD} ORDER BY version DESC LIMIT 1`).get()) as Row | undefined;
  return head ? readCohort(db, head) : null;
}

export async function cohortByVersion(db: Db, version: number): Promise<{ cohort: CohortVersion; inputs: unknown } | null> {
  const head = (await db.prepare(`${COHORT_HEAD} WHERE version = ?`).get(intOf(version, "version"))) as Row | undefined;
  return head ? readCohort(db, head) : null;
}

// ── events ──────────────────────────────────────────────────────────────────

export interface StoredTraderEvent extends TraderEvent {
  retracted: boolean;
  /** When the ingestion pass routed it; null while it has not (see unprocessedEvents). */
  processedAtMs: number | null;
}

/** The JSON stored for an event: rebuilt (no foreign fields), and shed of its free text if that is what makes it too big. */
function eventJson(e: TraderEvent): string {
  const clean = traderEventOf(e);
  if (!clean || clean.eventKey !== e.eventKey) throw new TypeError(`fomo store: event ${String(e.eventKey)} is not a valid TraderEvent`);
  let s = JSON.stringify(clean);
  if (s.length > FOMO_LIMITS.eventJsonChars) s = JSON.stringify({ ...clean, text: null });
  if (s.length > FOMO_LIMITS.eventJsonChars) throw new RangeError(`fomo store: event ${clean.eventKey} is too large to store`);
  return s;
}

/**
 * PERSIST BEFORE PROCESSING. Insert events and return the keys of the ones
 * that were NEW, in input order. A replay, a REST recovery of something the
 * stream already delivered, or a restart's second copy returns nothing, which
 * is what keeps a reconnect from becoming a second research task.
 *
 * Within one call the first copy of a key wins (dedupeEvents in events.ts
 * merges copies properly; call it first). All chunks commit together or not
 * at all, so a failure leaves nothing half-inserted for a retry to skip.
 *
 * A crash after this returns but before the caller routes the events leaves
 * them with processed_at_ms null: unprocessedEvents finds them on restart.
 */
export async function insertEvents(db: Db, events: readonly TraderEvent[]): Promise<string[]> {
  const firsts = new Map<string, unknown[]>();
  for (const e of events) {
    const key = keyOf(e.eventKey, "eventKey", 200);
    if (firsts.has(key)) continue;
    firsts.set(key, [
      key,
      e.identityBasis,
      bit(e.identityAmbiguous !== false),
      e.kind,
      optKey(e.trader?.userId, "trader.userId", 128),
      e.token ? keyOf(e.token.key, "token.key") : null,
      optKey(e.tradeId, "tradeId"),
      optKey(e.swapId, "swapId"),
      optKey(e.txHash, "txHash"),
      e.source,
      eventJson(e),
      optInt(e.sourceEventAt),
      intOf(e.observedAt, "observedAt"),
    ]);
  }
  if (firsts.size === 0) return [];
  const inserted = new Set<string>();
  // KEY ORDER, NOT ARRIVAL ORDER. The live stream and a REST recovery can
  // insert overlapping batches at the same moment; on Postgres each waits on
  // the other's uncommitted keys, and two batches holding them in opposite
  // orders deadlock. Sorted, every writer takes them in the same order.
  const rows = [...firsts.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([, row]) => row);
  await db.tx(async (tx) => {
    for (const part of chunksOf(rows, 40)) {
      const returned = (await tx
        .prepare(
          `INSERT INTO fomo_events (event_key, identity_basis, ambiguous, kind, user_id, token_key, trade_id, swap_id, tx_hash,
             source, event_json, source_event_at_ms, observed_at_ms)
           VALUES ${valuesList(13, part.length)}
           ON CONFLICT (event_key) DO NOTHING
           RETURNING event_key`,
        )
        .all(...part.flat())) as Row[];
      for (const r of returned) if (typeof r.event_key === "string") inserted.add(r.event_key);
    }
  });
  return [...firsts.keys()].filter((k) => inserted.has(k));
}

/**
 * The provider withdrew an event. Kept (the history is real), but reads skip
 * it. `newlyRetracted` is true for exactly one caller, which then gets the
 * token too, so a correction is routed once and to the right coin.
 */
export async function markRetracted(db: Db, eventKey: string): Promise<{ newlyRetracted: boolean; tokenKey: string | null }> {
  const r = (await db
    .prepare("UPDATE fomo_events SET retracted = 1 WHERE event_key = ? AND retracted = 0 RETURNING token_key")
    .get(keyOf(eventKey, "eventKey", 200))) as Row | undefined;
  return r ? { newlyRetracted: true, tokenKey: str(r.token_key) } : { newlyRetracted: false, tokenKey: null };
}

const EVENT_COLUMNS = "event_key, event_json, retracted, processed_at_ms";

function storedEventsOf(rows: Row[]): StoredTraderEvent[] {
  const out: StoredTraderEvent[] = [];
  for (const r of rows) {
    const e = traderEventOf(parseJson(r.event_json));
    // The column is the identity; a blob that disagrees with it is not this event.
    if (!e || e.eventKey !== r.event_key) continue;
    out.push({ ...e, retracted: num(r.retracted) === 1, processedAtMs: num(r.processed_at_ms) });
  }
  return out;
}

export interface EventReadOptions {
  /** Include events the provider withdrew (default false). */
  includeRetracted?: boolean;
}

/** A token's events observed at or after `sinceMs`, newest first. */
export async function eventsForToken(db: Db, tokenKey: string, sinceMs: number, limit: number, o: EventReadOptions = {}): Promise<StoredTraderEvent[]> {
  const rows = (await db
    .prepare(
      `SELECT ${EVENT_COLUMNS} FROM fomo_events WHERE token_key = ? AND observed_at_ms >= ?${o.includeRetracted ? "" : " AND retracted = 0"}
        ORDER BY observed_at_ms DESC, event_key DESC LIMIT ?`,
    )
    .all(keyOf(tokenKey, "tokenKey"), intOf(sinceMs, "sinceMs"), pageOf(limit))) as Row[];
  return storedEventsOf(rows);
}

/** A trader's events observed at or after `sinceMs`, newest first. */
export async function eventsForTrader(db: Db, userId: string, sinceMs: number, limit: number, o: EventReadOptions = {}): Promise<StoredTraderEvent[]> {
  const rows = (await db
    .prepare(
      `SELECT ${EVENT_COLUMNS} FROM fomo_events WHERE user_id = ? AND observed_at_ms >= ?${o.includeRetracted ? "" : " AND retracted = 0"}
        ORDER BY observed_at_ms DESC, event_key DESC LIMIT ?`,
    )
    .all(keyOf(userId, "userId", 128), intOf(sinceMs, "sinceMs"), pageOf(limit))) as Row[];
  return storedEventsOf(rows);
}

/** One coin's recent activity, summarised (recentActiveTokens). */
export interface ActiveToken {
  tokenKey: string;
  events: number;
  distinctTraders: number;
  /** Newest observation among the counted events. */
  newestAt: number;
}

export interface ActiveTokenOptions {
  /**
   * Only these traders' events (the cohort, one owner's dependencies). An
   * EMPTY list means nobody, never everybody: a cohort that is empty routes
   * nothing.
   */
  userIds?: readonly string[];
  /** Only these event kinds (default every kind). */
  kinds?: readonly ActivityKind[];
  /** Only token keys starting with this (for example `eip155:4663:`, Robinhood Chain). */
  tokenKeyPrefix?: string;
}

/** Traders per IN list: well inside both backends' bound-parameter limits. */
const ACTIVE_USERS_PER_QUERY = 500;
/** Rows one chunk may return before the merge: far past what a breadth window holds. */
const ACTIVE_ROWS_PER_CHUNK = 5_000;
/** Without a trader filter, the newest this many events in the window are summarised. */
const ACTIVE_SCAN_EVENTS = 20_000;

/**
 * The coins with activity since `sinceMs`, newest activity first: what the
 * cohort (or an owner's dependencies) touched lately, as one grouped read per
 * chunk of traders instead of one read per trader. Retracted events and
 * events without a coin are not counted.
 *
 * INDEX-BACKED. With `userIds` the read walks fomo_events_user (user_id,
 * observed_at_ms) once per trader. Without, it walks fomo_events_observed
 * backwards over the window and summarises at most the newest
 * ACTIVE_SCAN_EVENTS of them: the inner, ordered and limited read is what
 * keeps a planner from walking the token index end to end to save a sort.
 * store.test.ts checks every plan.
 *
 * The result is the same on every replica that reads the shared store, which
 * is the point: a child's file no longer depends on which replica ingested.
 */
export async function recentActiveTokens(db: Db, sinceMs: number, limit: number, o: ActiveTokenOptions = {}): Promise<ActiveToken[]> {
  const since = intOf(sinceMs, "sinceMs");
  const n = pageOf(limit);
  const kinds = o.kinds ? [...new Set(o.kinds)] : null;
  if (kinds) for (const k of kinds) if (!isIn(ACTIVITY_KINDS, k)) throw new TypeError("fomo store: unknown activity kind");
  if (kinds && kinds.length === 0) return [];
  const prefix = o.tokenKeyPrefix === undefined ? null : keyOf(o.tokenKeyPrefix, "tokenKeyPrefix", 64);
  if (prefix !== null && /[%_\\]/.test(prefix)) throw new TypeError("fomo store: tokenKeyPrefix must be a plain prefix");
  const users = o.userIds ? [...new Set(o.userIds.map((u) => keyOf(u, "userId", 128)))] : null;
  if (users && users.length === 0) return [];
  // No `token_key IS NOT NULL` here: sqlite would then walk the token index
  // end to end instead of the time window. Coin-less events group under a
  // NULL key, which the fold skips and the limit allows one extra row for.
  const tail = `observed_at_ms >= ? AND retracted = 0${kinds ? ` AND kind IN (${marks(kinds.length)})` : ""}${prefix !== null ? " AND token_key LIKE ?" : ""}`;
  const tailParams: unknown[] = [since, ...(kinds ?? []), ...(prefix !== null ? [`${prefix}%`] : [])];
  const select = "SELECT token_key, COUNT(*) AS events, COUNT(DISTINCT user_id) AS traders, MAX(observed_at_ms) AS newest_at FROM fomo_events";
  const order = "GROUP BY token_key ORDER BY newest_at DESC, token_key LIMIT ?";
  const merged = new Map<string, ActiveToken>();
  const fold = (rows: Row[]) => {
    for (const r of rows) {
      const tokenKey = str(r.token_key);
      const events = num(r.events);
      const traders = num(r.traders);
      const newest = num(r.newest_at);
      if (!tokenKey || events === null || traders === null || newest === null) continue;
      const prior = merged.get(tokenKey);
      // Chunks partition the traders, so their counts add up exactly.
      merged.set(
        tokenKey,
        prior
          ? { tokenKey, events: prior.events + events, distinctTraders: prior.distinctTraders + traders, newestAt: Math.max(prior.newestAt, newest) }
          : { tokenKey, events, distinctTraders: traders, newestAt: newest },
      );
    }
  };
  if (users === null) {
    const inner = `SELECT token_key, user_id, observed_at_ms FROM fomo_events WHERE ${tail} ORDER BY observed_at_ms DESC LIMIT ?`;
    const outer = "SELECT token_key, COUNT(*) AS events, COUNT(DISTINCT user_id) AS traders, MAX(observed_at_ms) AS newest_at";
    fold((await db.prepare(`${outer} FROM (${inner}) AS w ${order}`).all(...tailParams, ACTIVE_SCAN_EVENTS, n + 1)) as Row[]);
  } else {
    const chunks = chunksOf(users, ACTIVE_USERS_PER_QUERY);
    // One chunk is exact under its own LIMIT. Several are merged first, so each reads past the limit.
    const perChunk = chunks.length === 1 ? n + 1 : ACTIVE_ROWS_PER_CHUNK;
    for (const part of chunks) {
      fold((await db.prepare(`${select} WHERE user_id IN (${marks(part.length)}) AND ${tail} ${order}`).all(...part, ...tailParams, perChunk)) as Row[]);
    }
  }
  return [...merged.values()].sort((a, b) => b.newestAt - a.newestAt || (a.tokenKey < b.tokenKey ? -1 : a.tokenKey > b.tokenKey ? 1 : 0)).slice(0, n);
}

/** Mark events routed. Only the first mark counts; returns how many changed. */
export async function markEventsProcessed(db: Db, eventKeys: readonly string[], nowMs: number): Promise<number> {
  const at = intOf(nowMs, "nowMs");
  let changed = 0;
  for (const part of chunksOf([...new Set(eventKeys.map((k) => keyOf(k, "eventKey", 200)))], 100)) {
    const r = await db
      .prepare(`UPDATE fomo_events SET processed_at_ms = ? WHERE processed_at_ms IS NULL AND event_key IN (${marks(part.length)})`)
      .run(at, ...part);
    changed += r.changes;
  }
  return changed;
}

/** Persisted but never routed (a crash between insertEvents and the routing), oldest first. */
export async function unprocessedEvents(db: Db, limit: number): Promise<StoredTraderEvent[]> {
  const rows = (await db
    .prepare(`SELECT ${EVENT_COLUMNS} FROM fomo_events WHERE processed_at_ms IS NULL ORDER BY observed_at_ms, event_key LIMIT ?`)
    .all(pageOf(limit))) as Row[];
  return storedEventsOf(rows);
}

// ── stream checkpoints, coverage gaps, dead letters ─────────────────────────

export interface StreamCheckpoint {
  stream: string;
  cursor: string | null;
  /** Newest source event time persisted for the stream; null before any was known. */
  newestTsMs: number | null;
  updatedAtMs: number;
}

export async function getCheckpoint(db: Db, stream: string): Promise<StreamCheckpoint | null> {
  const r = (await db
    .prepare("SELECT stream, cursor, newest_ts_ms, updated_at_ms FROM fomo_stream_checkpoints WHERE stream = ?")
    .get(keyOf(stream, "stream", 64))) as Row | undefined;
  const updated = num(r?.updated_at_ms);
  if (!r || updated === null) return null;
  return { stream: String(r.stream), cursor: str(r.cursor), newestTsMs: num(r.newest_ts_ms), updatedAtMs: updated };
}

/** How far ahead of the writer's clock a stored checkpoint may be before a sane write may replace it. */
export const CHECKPOINT_FUTURE_TOLERANCE_MS = 2 * 60_000;

/**
 * Advance a stream's checkpoint. MONOTONIC: a write whose newest timestamp is
 * older than the stored one is refused in the statement itself, so a slow
 * recovery finishing after the live stream cannot rewind it and make the next
 * reconnect re-fetch (and pay for) what is already held. Equal timestamps may
 * move the cursor (several events share one 5 s quantum).
 *
 * A write with no timestamp cannot be ordered against one that has one, so it
 * lands only while the stored row has none either: an untimed cursor never
 * replaces a timed checkpoint.
 *
 * A stored time further ahead of the writer's clock than
 * CHECKPOINT_FUTURE_TOLERANCE_MS is not progress but a bad provider timestamp
 * (or a clock that stepped back), and monotonicity would otherwise pin it
 * there until the wall clock caught up: any timed write replaces it. True
 * when written.
 */
export async function setCheckpoint(db: Db, stream: string, cursor: string | null, newestTsMs: number | null, nowMs: number): Promise<boolean> {
  const now = intOf(nowMs, "nowMs");
  const row = await db
    .prepare(
      `INSERT INTO fomo_stream_checkpoints (stream, cursor, newest_ts_ms, updated_at_ms) VALUES (?, ?, ?, ?)
       ON CONFLICT (stream) DO UPDATE SET cursor = excluded.cursor, newest_ts_ms = excluded.newest_ts_ms,
         updated_at_ms = excluded.updated_at_ms
       WHERE (excluded.newest_ts_ms IS NOT NULL
              AND (fomo_stream_checkpoints.newest_ts_ms IS NULL
                   OR fomo_stream_checkpoints.newest_ts_ms <= excluded.newest_ts_ms
                   OR fomo_stream_checkpoints.newest_ts_ms > ?))
          OR (excluded.newest_ts_ms IS NULL AND fomo_stream_checkpoints.newest_ts_ms IS NULL)
       RETURNING stream`,
    )
    .get(
      keyOf(stream, "stream", 64),
      textOf(cursor, FOMO_LIMITS.keyChars),
      newestTsMs === null ? null : intOf(newestTsMs, "newestTsMs"),
      now,
      now + CHECKPOINT_FUTURE_TOLERANCE_MS,
    );
  return row !== undefined && row !== null;
}

export interface CoverageGap {
  id: number;
  stream: string;
  fromMs: number;
  toMs: number;
  reason: string;
  recovered: boolean;
  detectedAtMs: number;
  recoveredAtMs: number | null;
}

/**
 * Record a span the stream did not cover. The same span recorded twice (a
 * crash between detecting and recovering it) is one gap: the id of the
 * existing row comes back with `created: false`.
 */
export async function recordGap(
  db: Db,
  stream: string,
  fromMs: number,
  toMs: number,
  reason: string,
  nowMs: number,
): Promise<{ id: number; created: boolean }> {
  const s = keyOf(stream, "stream", 64);
  const from = intOf(fromMs, "fromMs");
  const to = intOf(toMs, "toMs");
  if (to < from) throw new RangeError("fomo store: a gap must not end before it starts");
  const row = (await db
    .prepare(
      `INSERT INTO fomo_coverage_gaps (stream, from_ms, to_ms, reason, recovered, detected_at_ms, recovered_at_ms)
       VALUES (?, ?, ?, ?, 0, ?, NULL)
       ON CONFLICT (stream, from_ms, to_ms) DO NOTHING
       RETURNING id`,
    )
    .get(s, from, to, textOf(reason, FOMO_LIMITS.reasonChars) ?? "", intOf(nowMs, "nowMs"))) as Row | undefined;
  if (row) return { id: Number(row.id), created: true };
  const existing = (await db
    .prepare("SELECT id FROM fomo_coverage_gaps WHERE stream = ? AND from_ms = ? AND to_ms = ?")
    .get(s, from, to)) as Row | undefined;
  if (!existing) throw new Error("fomo store: a conflicting gap vanished before it could be read");
  return { id: Number(existing.id), created: false };
}

const GAP_COLUMNS = "id, stream, from_ms, to_ms, reason, recovered, detected_at_ms, recovered_at_ms";

function gapOf(r: Row): CoverageGap | null {
  const id = num(r.id);
  const from = num(r.from_ms);
  const to = num(r.to_ms);
  const detected = num(r.detected_at_ms);
  const stream = str(r.stream);
  if (id === null || from === null || to === null || detected === null || !stream) return null;
  return { id, stream, fromMs: from, toMs: to, reason: str(r.reason) ?? "", recovered: num(r.recovered) === 1, detectedAtMs: detected, recoveredAtMs: num(r.recovered_at_ms) };
}

/**
 * Gaps not yet recovered, oldest span first; one stream or all. With
 * `lastReasonPrefix`, gaps whose reason starts with it come after every other
 * one, so a page of old never-retried gaps cannot crowd out walkable ones.
 */
export async function listOpenGaps(db: Db, stream: string | null, limit: number, o: { lastReasonPrefix?: string } = {}): Promise<CoverageGap[]> {
  const prefix = o.lastReasonPrefix;
  if (prefix !== undefined && (prefix === "" || /[%_\\]/.test(prefix))) throw new TypeError("fomo store: a reason prefix must be plain text");
  const order = prefix !== undefined ? "CASE WHEN reason LIKE ? THEN 1 ELSE 0 END, from_ms, id" : "from_ms, id";
  const lead = prefix !== undefined ? [`${prefix}%`] : [];
  const rows = (
    stream === null
      ? await db.prepare(`SELECT ${GAP_COLUMNS} FROM fomo_coverage_gaps WHERE recovered = 0 ORDER BY ${order} LIMIT ?`).all(...lead, pageOf(limit))
      : await db
          .prepare(`SELECT ${GAP_COLUMNS} FROM fomo_coverage_gaps WHERE recovered = 0 AND stream = ? ORDER BY ${order} LIMIT ?`)
          .all(keyOf(stream, "stream", 64), ...lead, pageOf(limit))
  ) as Row[];
  return rows.flatMap((r) => gapOf(r) ?? []);
}

/**
 * Open gaps that overlap [sinceMs, untilMs], newest end first; one stream or all.
 *
 * listOpenGaps is oldest first and unbounded in time, so a page of it is the
 * OLDEST open gaps: unrecoverable ones stay open for the whole retention, and
 * fifty of them hide every newer hole. This asks for the window itself, on the
 * to_ms index (a gap ending before the window cannot overlap it). A full page
 * means "at least this many", never "these are all".
 */
export async function listOpenGapsOverlapping(db: Db, stream: string | null, sinceMs: number, untilMs: number, limit: number): Promise<CoverageGap[]> {
  const since = intOf(sinceMs, "sinceMs");
  const until = intOf(untilMs, "untilMs");
  const rows = (
    stream === null
      ? await db
          .prepare(`SELECT ${GAP_COLUMNS} FROM fomo_coverage_gaps WHERE to_ms >= ? AND from_ms <= ? AND recovered = 0 ORDER BY to_ms DESC, id DESC LIMIT ?`)
          .all(since, until, pageOf(limit))
      : await db
          .prepare(`SELECT ${GAP_COLUMNS} FROM fomo_coverage_gaps WHERE to_ms >= ? AND from_ms <= ? AND recovered = 0 AND stream = ? ORDER BY to_ms DESC, id DESC LIMIT ?`)
          .all(since, until, keyOf(stream, "stream", 64), pageOf(limit))
  ) as Row[];
  return rows.flatMap((r) => gapOf(r) ?? []);
}

/** True for exactly one caller per gap. */
export async function markGapRecovered(db: Db, id: number, nowMs: number): Promise<boolean> {
  const r = await db
    .prepare("UPDATE fomo_coverage_gaps SET recovered = 1, recovered_at_ms = ? WHERE id = ? AND recovered = 0")
    .run(intOf(nowMs, "nowMs"), intOf(id, "id"));
  return r.changes === 1;
}

export interface DeadLetter {
  id: number;
  stream: string;
  /** Raw and untrusted: for an operator, never for a prompt. */
  payload: string;
  error: string;
  atMs: number;
}

/**
 * Park a frame that could not be processed. The payload is capped rather than
 * refused: a malformed frame is exactly the kind that arrives oversized, and
 * dropping it would lose the only evidence of what went wrong.
 */
export async function deadLetter(db: Db, stream: string, payload: string, error: string, atMs: number): Promise<number> {
  const row = (await db
    .prepare("INSERT INTO fomo_dead_letters (stream, payload, error, at_ms) VALUES (?, ?, ?, ?) RETURNING id")
    .get(
      keyOf(stream, "stream", 64),
      textOf(String(payload), FOMO_LIMITS.deadLetterPayloadChars) ?? "",
      textOf(String(error), FOMO_LIMITS.errorChars) ?? "",
      intOf(atMs, "atMs"),
    )) as Row;
  return Number(row.id);
}

/** Newest first; one stream or all. */
export async function listDeadLetters(db: Db, limit: number, stream: string | null = null): Promise<DeadLetter[]> {
  const rows = (
    stream === null
      ? await db.prepare("SELECT id, stream, payload, error, at_ms FROM fomo_dead_letters ORDER BY at_ms DESC, id DESC LIMIT ?").all(pageOf(limit))
      : await db
          .prepare("SELECT id, stream, payload, error, at_ms FROM fomo_dead_letters WHERE stream = ? ORDER BY at_ms DESC, id DESC LIMIT ?")
          .all(keyOf(stream, "stream", 64), pageOf(limit))
  ) as Row[];
  return rows.flatMap((r) => {
    const id = num(r.id);
    const at = num(r.at_ms);
    return id !== null && at !== null ? [{ id, stream: String(r.stream), payload: str(r.payload) ?? "", error: str(r.error) ?? "", atMs: at }] : [];
  });
}

// ── response cache ──────────────────────────────────────────────────────────

export interface CacheEntry {
  cacheKey: string;
  dataClass: FreshnessClass;
  /** Parsed payload, unvalidated: the caller's normaliser decides what it is. Null when nothing was ever retrieved. */
  payload: unknown;
  retrievedAtMs: number | null;
  providerAsOfMs: number | null;
  lastAttemptAtMs: number | null;
  lastAttemptOutcome: Freshness["lastRefreshOutcome"];
  meta: unknown;
}

export async function cacheGet(db: Db, cacheKey: string): Promise<CacheEntry | null> {
  const r = (await db
    .prepare(
      `SELECT cache_key, data_class, payload_json, retrieved_at_ms, provider_as_of_ms, last_attempt_at_ms, last_attempt_outcome, meta_json
         FROM fomo_cache WHERE cache_key = ?`,
    )
    .get(keyOf(cacheKey, "cacheKey", 300))) as Row | undefined;
  if (!r || !isIn(FRESHNESS_CLASSES, r.data_class)) return null;
  return {
    cacheKey: String(r.cache_key),
    dataClass: r.data_class,
    payload: parseJson(r.payload_json),
    retrievedAtMs: num(r.retrieved_at_ms),
    providerAsOfMs: num(r.provider_as_of_ms),
    lastAttemptAtMs: num(r.last_attempt_at_ms),
    lastAttemptOutcome: isIn(ATTEMPT_OUTCOMES, r.last_attempt_outcome) ? r.last_attempt_outcome : null,
    meta: parseJson(r.meta_json),
  };
}

/**
 * Store a successful retrieval. Never replaces a copy retrieved LATER: two
 * refreshes racing (web and orchestrator) must leave the newer bytes, whichever
 * finished last. False when refused for that reason, or when the payload is
 * over the cap (it is then simply not cached; the caller still has it).
 */
export async function cachePut(
  db: Db,
  e: { cacheKey: string; dataClass: FreshnessClass; payload: unknown; retrievedAtMs: number; providerAsOfMs: number | null; meta?: unknown },
): Promise<boolean> {
  if (!isIn(FRESHNESS_CLASSES, e.dataClass)) throw new TypeError("fomo store: unknown freshness class");
  const payload = JSON.stringify(e.payload === undefined ? null : e.payload);
  if (typeof payload !== "string" || payload.length > FOMO_LIMITS.cachePayloadChars) return false;
  const at = intOf(e.retrievedAtMs, "retrievedAtMs");
  const row = await db
    .prepare(
      `INSERT INTO fomo_cache (cache_key, data_class, payload_json, retrieved_at_ms, provider_as_of_ms, last_attempt_at_ms, last_attempt_outcome, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, 'ok', ?)
       ON CONFLICT (cache_key) DO UPDATE SET data_class = excluded.data_class, payload_json = excluded.payload_json,
         retrieved_at_ms = excluded.retrieved_at_ms, provider_as_of_ms = excluded.provider_as_of_ms,
         last_attempt_at_ms = excluded.last_attempt_at_ms, last_attempt_outcome = excluded.last_attempt_outcome,
         meta_json = excluded.meta_json
       WHERE fomo_cache.retrieved_at_ms IS NULL OR fomo_cache.retrieved_at_ms <= excluded.retrieved_at_ms
       RETURNING cache_key`,
    )
    .get(
      keyOf(e.cacheKey, "cacheKey", 300),
      e.dataClass,
      payload,
      at,
      optInt(e.providerAsOfMs),
      at,
      e.meta === undefined ? null : jsonOf(e.meta, FOMO_LIMITS.metaJsonChars, "cache meta"),
    );
  return row !== undefined && row !== null;
}

/**
 * Record a refresh attempt that did not store bytes (a failure, a budget
 * skip). The held copy and its retrieval time are untouched, so a failed
 * refresh can be shown as "stale, last attempt failed" rather than as fresh.
 */
export async function cacheMarkAttempt(db: Db, cacheKey: string, dataClass: FreshnessClass, outcome: AttemptOutcome, nowMs: number): Promise<void> {
  if (!isIn(FRESHNESS_CLASSES, dataClass)) throw new TypeError("fomo store: unknown freshness class");
  if (!isIn(ATTEMPT_OUTCOMES, outcome)) throw new TypeError("fomo store: unknown attempt outcome");
  await db
    .prepare(
      `INSERT INTO fomo_cache (cache_key, data_class, payload_json, retrieved_at_ms, provider_as_of_ms, last_attempt_at_ms, last_attempt_outcome, meta_json)
       VALUES (?, ?, NULL, NULL, NULL, ?, ?, NULL)
       ON CONFLICT (cache_key) DO UPDATE SET last_attempt_at_ms = excluded.last_attempt_at_ms,
         last_attempt_outcome = excluded.last_attempt_outcome
       WHERE fomo_cache.last_attempt_at_ms IS NULL OR fomo_cache.last_attempt_at_ms <= excluded.last_attempt_at_ms`,
    )
    .run(keyOf(cacheKey, "cacheKey", 300), dataClass, intOf(nowMs, "nowMs"), outcome);
}

// ── dossiers ────────────────────────────────────────────────────────────────

export interface StoredDossier {
  tokenKey: string;
  revision: number;
  inputsHash: string;
  /** Parsed, unvalidated: dossier.ts owns its shape. */
  dossier: unknown;
  builtAtMs: number;
}

const DOSSIER_COLUMNS = "token_key, revision, inputs_hash, dossier_json, built_at_ms";

function dossierOf(r: Row | undefined): StoredDossier | null {
  const revision = num(r?.revision);
  const built = num(r?.built_at_ms);
  if (!r || revision === null || built === null || typeof r.token_key !== "string" || typeof r.inputs_hash !== "string") return null;
  return { tokenKey: r.token_key, revision, inputsHash: r.inputs_hash, dossier: parseJson(r.dossier_json), builtAtMs: built };
}

export async function latestDossier(db: Db, tokenKey: string): Promise<StoredDossier | null> {
  const r = (await db
    .prepare(`SELECT ${DOSSIER_COLUMNS} FROM fomo_dossiers WHERE token_key = ? ORDER BY revision DESC LIMIT 1`)
    .get(keyOf(tokenKey, "tokenKey"))) as Row | undefined;
  return dossierOf(r);
}

export async function dossierRevision(db: Db, tokenKey: string, revision: number): Promise<StoredDossier | null> {
  const r = (await db
    .prepare(`SELECT ${DOSSIER_COLUMNS} FROM fomo_dossiers WHERE token_key = ? AND revision = ?`)
    .get(keyOf(tokenKey, "tokenKey"), intOf(revision, "revision"))) as Row | undefined;
  return dossierOf(r);
}

/**
 * A new dossier revision, or the latest one when its inputs have not changed.
 *
 * UNCHANGED INPUTS ARE NOT A NEW REVISION: an answer that cites "revision 7"
 * must keep meaning the same evidence, and a rebuild from the same evidence
 * ids is the same dossier. Otherwise the revision is the latest plus one.
 *
 * Two builders racing (web and orchestrator) both read revision N and both try
 * N+1. The primary key picks one; the other's ON CONFLICT DO NOTHING yields
 * no row, it reads again (a fresh snapshot per statement on Postgres) and
 * either finds its own inputs already stored or takes N+2.
 */
export async function insertDossierRevision(
  db: Db,
  tokenKey: string,
  inputsHash: string,
  dossier: unknown,
  builtAtMs: number,
): Promise<{ created: boolean; dossier: StoredDossier }> {
  const key = keyOf(tokenKey, "tokenKey");
  const hash = keyOf(inputsHash, "inputsHash", 128);
  const json = jsonOf(dossier, FOMO_LIMITS.dossierJsonChars, "dossier");
  const built = intOf(builtAtMs, "builtAtMs");
  return db.tx(async (tx) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const latest = dossierOf(
        (await tx.prepare(`SELECT ${DOSSIER_COLUMNS} FROM fomo_dossiers WHERE token_key = ? ORDER BY revision DESC LIMIT 1`).get(key)) as
          | Row
          | undefined,
      );
      if (latest && latest.inputsHash === hash) return { created: false, dossier: latest };
      const revision = (latest?.revision ?? 0) + 1;
      const row = await tx
        .prepare(
          `INSERT INTO fomo_dossiers (token_key, revision, inputs_hash, dossier_json, built_at_ms) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (token_key, revision) DO NOTHING
           RETURNING revision`,
        )
        .get(key, revision, hash, json, built);
      if (row !== undefined && row !== null) {
        return { created: true, dossier: { tokenKey: key, revision, inputsHash: hash, dossier: JSON.parse(json) as unknown, builtAtMs: built } };
      }
    }
    throw new Error(`fomo store: dossier revisions for ${key} kept colliding`);
  });
}

// ── allowances, leases, usage ───────────────────────────────────────────────

/**
 * TAKE `amount` FROM AN ALLOWANCE, atomically: true while the counter under
 * `key` plus `amount` stays within `limit` (and it is bumped), false once it
 * would not. The key carries the period ("credits:2026-10-04"), so a new day
 * is a new counter. The conditional DO UPDATE means two replicas cannot both
 * take the last unit; an amount that does not fit takes nothing.
 */
export async function takeAllowance(db: Db, key: string, amount: number, limit: number, nowMs: number): Promise<boolean> {
  const n = intOf(amount, "amount");
  const cap = intOf(limit, "limit");
  if (n < 1 || n > cap) return false;
  const row = await db
    .prepare(
      `INSERT INTO fomo_meta (k, n, v, updated_at_ms) VALUES (?, ?, NULL, ?)
       ON CONFLICT (k) DO UPDATE SET n = fomo_meta.n + excluded.n, updated_at_ms = excluded.updated_at_ms
       WHERE fomo_meta.n + excluded.n <= ?
       RETURNING n`,
    )
    .get(`allowance:${keyOf(key, "allowance key", 200)}`, n, intOf(nowMs, "nowMs"), cap);
  return row !== undefined && row !== null;
}

/**
 * GIVE BACK what was taken for something that then certainly did not happen
 * (a call refused before it was charged). Never below zero. A call whose
 * outcome is unknown keeps its reservation: over-counting spends a little
 * budget, under-counting can overspend it.
 */
export async function returnAllowance(db: Db, key: string, amount: number, nowMs: number): Promise<void> {
  const n = intOf(amount, "amount");
  if (n < 1) return;
  await db
    .prepare("UPDATE fomo_meta SET n = CASE WHEN n > ? THEN n - ? ELSE 0 END, updated_at_ms = ? WHERE k = ? AND n > 0")
    .run(n, n, intOf(nowMs, "nowMs"), `allowance:${keyOf(key, "allowance key", 200)}`);
}

/** How much of an allowance is taken; null when nothing has been. */
export async function readAllowance(db: Db, key: string): Promise<number | null> {
  const r = (await db.prepare("SELECT n FROM fomo_meta WHERE k = ?").get(`allowance:${keyOf(key, "allowance key", 200)}`)) as Row | undefined;
  return num(r?.n);
}

/**
 * A SINGLETON LEASE (one stream connection per fleet): true while `holder`
 * holds `name` until `nowMs + leaseMs`. Taken when free or lapsed, renewed by
 * its holder; never taken from a live holder. The expiry and holder are one
 * row decided by one conditional upsert, so two replicas cannot both win.
 */
export async function claimLease(db: Db, name: string, holder: string, nowMs: number, leaseMs: number): Promise<boolean> {
  const now = intOf(nowMs, "nowMs");
  const row = await db
    .prepare(
      `INSERT INTO fomo_meta (k, n, v, updated_at_ms) VALUES (?, ?, ?, ?)
       ON CONFLICT (k) DO UPDATE SET n = excluded.n, v = excluded.v, updated_at_ms = excluded.updated_at_ms
       WHERE fomo_meta.n <= ? OR fomo_meta.v = excluded.v
       RETURNING n`,
    )
    .get(`lease:${keyOf(name, "lease name", 64)}`, now + countOf(leaseMs, "leaseMs"), keyOf(holder, "holder", 128), now, now);
  return row !== undefined && row !== null;
}

/** Let go early, only if still the holder (a lapsed lease taken by another is theirs). */
export async function releaseLease(db: Db, name: string, holder: string, nowMs: number): Promise<boolean> {
  const r = await db
    .prepare("UPDATE fomo_meta SET n = 0, updated_at_ms = ? WHERE k = ? AND v = ?")
    .run(intOf(nowMs, "nowMs"), `lease:${keyOf(name, "lease name", 64)}`, keyOf(holder, "holder", 128));
  return r.changes === 1;
}

const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** UTC day key for usage rows. */
export function usageDay(ms: number): string {
  return new Date(intOf(ms, "ms")).toISOString().slice(0, 10);
}

/**
 * Add calls (and their credit charge) to a day's bucket. An unknown charge is
 * NOT a zero charge: those calls are counted in `uncounted_calls`, so a total
 * reads as "at least N credits" rather than as an exact figure.
 */
export async function recordUsage(db: Db, day: string, bucket: string, calls: number, credits: number | null): Promise<void> {
  if (!DAY_SHAPE.test(day)) throw new TypeError("fomo store: day must be yyyy-mm-dd");
  const c = countOf(calls, "calls");
  const known = credits === null ? null : countOf(credits, "credits");
  await db
    .prepare(
      `INSERT INTO fomo_usage (day, bucket, calls, credits, uncounted_calls) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (day, bucket) DO UPDATE SET calls = fomo_usage.calls + excluded.calls,
         credits = fomo_usage.credits + excluded.credits, uncounted_calls = fomo_usage.uncounted_calls + excluded.uncounted_calls`,
    )
    .run(day, slugOf(bucket, "bucket"), c, known ?? 0, known === null ? c : 0);
}

export async function usageForDay(db: Db, day: string): Promise<{ bucket: string; calls: number; credits: number; uncountedCalls: number }[]> {
  if (!DAY_SHAPE.test(day)) throw new TypeError("fomo store: day must be yyyy-mm-dd");
  const rows = (await db.prepare("SELECT bucket, calls, credits, uncounted_calls FROM fomo_usage WHERE day = ? ORDER BY bucket").all(day)) as Row[];
  return rows.map((r) => ({ bucket: String(r.bucket), calls: num(r.calls) ?? 0, credits: num(r.credits) ?? 0, uncountedCalls: num(r.uncounted_calls) ?? 0 }));
}

// ── research queue ──────────────────────────────────────────────────────────

export type ResearchQueueState = "queued" | "claimed" | "done" | "failed";

export interface ResearchClaim {
  tokenKey: string;
  evidenceRev: string;
  priority: number;
  tenants: string[];
  /** The fencing token: finishResearch is conditioned on it. */
  attempts: number;
  requestedAtMs: number;
  claimedUntilMs: number;
}

function tenantList(v: unknown): string[] {
  return [...new Set(strings(v).map(tenantKey).filter(Boolean))].sort();
}

/**
 * Ask for research on a token at an evidence revision, COALESCING: one row per
 * (token, revision) however many owners and surfaces ask. A second request
 * keeps the HIGHER priority (a CASE in the statement, so it is decided against
 * the current row) and adds its tenants to the set.
 *
 * The tenant set is JSON, and JSON functions are off the table, so the union
 * is computed here and written with a compare-and-swap on the old set (and
 * state): a concurrent enqueue or claim makes the swap miss, and it is retried
 * against the new row. Nobody's tenant is lost and nothing waits on a lock.
 *
 *   queued     a new row
 *   coalesced  merged into a queued or claimed row (a claimed row's result is
 *              routed to every tenant on it when it finishes)
 *   requeued   a failed row with attempts left, back in the queue
 *   done       already researched at this revision: route the stored result
 *   failed     failed for good at this revision
 */
export async function enqueueResearch(
  db: Db,
  tokenKey: string,
  evidenceRev: string,
  priority: number,
  tenants: readonly string[],
  nowMs: number,
): Promise<{ outcome: "queued" | "coalesced" | "requeued" | "done" | "failed"; priority: number; tenants: string[] }> {
  const key = keyOf(tokenKey, "tokenKey");
  const rev = keyOf(evidenceRev, "evidenceRev", 128);
  const p = intOf(priority, "priority");
  const asking = tenantList(tenants.map((t) => tenantOf(t)));
  const now = intOf(nowMs, "nowMs");
  for (let attempt = 0; attempt < 8; attempt++) {
    const row = (await db
      .prepare("SELECT priority, tenants_json, state, attempts FROM fomo_research_queue WHERE token_key = ? AND evidence_rev = ?")
      .get(key, rev)) as Row | undefined;
    if (!row) {
      const ins = await db
        .prepare(
          `INSERT INTO fomo_research_queue (token_key, evidence_rev, priority, tenants_json, state, requested_at_ms, claimed_until_ms, attempts)
           VALUES (?, ?, ?, ?, 'queued', ?, NULL, 0)
           ON CONFLICT (token_key, evidence_rev) DO NOTHING
           RETURNING token_key`,
        )
        .get(key, rev, p, JSON.stringify(asking), now);
      if (ins !== undefined && ins !== null) return { outcome: "queued", priority: p, tenants: asking };
      continue;
    }
    const state = str(row.state);
    const held = tenantList(parseJson(row.tenants_json));
    const stored = num(row.priority) ?? p;
    if (state === "done") return { outcome: "done", priority: stored, tenants: held };
    if (state === "failed" && (num(row.attempts) ?? 0) >= FOMO_LIMITS.researchMaxAttempts) return { outcome: "failed", priority: stored, tenants: held };
    const merged = tenantList([...held, ...asking]);
    const nextState = state === "failed" ? "queued" : String(state);
    const swapped = (await db
      .prepare(
        `UPDATE fomo_research_queue SET priority = CASE WHEN priority < ? THEN ? ELSE priority END, tenants_json = ?, state = ?
          WHERE token_key = ? AND evidence_rev = ? AND tenants_json = ? AND state = ?
          RETURNING priority`,
      )
      .get(p, p, JSON.stringify(merged), nextState, key, rev, String(row.tenants_json), String(state))) as Row | undefined;
    if (swapped) return { outcome: state === "failed" ? "requeued" : "coalesced", priority: num(swapped.priority) ?? p, tenants: merged };
  }
  throw new Error(`fomo store: research queue row ${key} stayed contended`);
}

/**
 * Claim the most urgent runnable research: highest priority, then oldest
 * request. Runnable is queued, or claimed with a lapsed lease and attempts
 * left (its worker died). The claim is a conditional UPDATE that re-states
 * that condition, so of two claimers that picked the same row exactly one
 * gets it back; the loser looks again. A lapsed row with no attempts left is
 * failed first, so it cannot sit "claimed" for ever.
 */
export async function claimNextResearch(
  db: Db,
  nowMs: number,
  leaseMs: number,
  o: {
    /** Only items at least this urgent (RESEARCH_PRIORITY); the rest stay queued, untouched, for later. */
    minPriority?: number;
  } = {},
): Promise<ResearchClaim | null> {
  const now = intOf(nowMs, "nowMs");
  const until = now + countOf(leaseMs, "leaseMs");
  const max = FOMO_LIMITS.researchMaxAttempts;
  const floor = o.minPriority === undefined ? null : intOf(o.minPriority, "minPriority");
  await db
    .prepare("UPDATE fomo_research_queue SET state = 'failed', claimed_until_ms = NULL WHERE state = 'claimed' AND claimed_until_ms < ? AND attempts >= ?")
    .run(now, max);
  for (let attempt = 0; attempt < 5; attempt++) {
    const pick = (await (floor === null
      ? db
          .prepare(
            `SELECT token_key, evidence_rev FROM fomo_research_queue
              WHERE state = 'queued' OR (state = 'claimed' AND claimed_until_ms < ? AND attempts < ?)
              ORDER BY priority DESC, requested_at_ms, token_key, evidence_rev
              LIMIT 1`,
          )
          .get(now, max)
      : db
          .prepare(
            `SELECT token_key, evidence_rev FROM fomo_research_queue
              WHERE (state = 'queued' OR (state = 'claimed' AND claimed_until_ms < ? AND attempts < ?)) AND priority >= ?
              ORDER BY priority DESC, requested_at_ms, token_key, evidence_rev
              LIMIT 1`,
          )
          .get(now, max, floor))) as Row | undefined;
    if (!pick) return null;
    const r = (await db
      .prepare(
        `UPDATE fomo_research_queue SET state = 'claimed', attempts = attempts + 1, claimed_until_ms = ?
          WHERE token_key = ? AND evidence_rev = ?
            AND (state = 'queued' OR (state = 'claimed' AND claimed_until_ms < ? AND attempts < ?))
          RETURNING token_key, evidence_rev, priority, tenants_json, attempts, requested_at_ms, claimed_until_ms`,
      )
      .get(until, String(pick.token_key), String(pick.evidence_rev), now, max)) as Row | undefined;
    if (!r) continue;
    return {
      tokenKey: String(r.token_key),
      evidenceRev: String(r.evidence_rev),
      priority: num(r.priority) ?? 0,
      tenants: tenantList(parseJson(r.tenants_json)),
      attempts: num(r.attempts) ?? 0,
      requestedAtMs: num(r.requested_at_ms) ?? now,
      claimedUntilMs: num(r.claimed_until_ms) ?? until,
    };
  }
  return null;
}

/**
 * Finish a claimed research item, FENCED on the attempt it claimed: a worker
 * that stalled past its lease and was superseded changes nothing. `retry`
 * puts it back in the queue while attempts remain. Returns the tenant set as
 * it stands now (owners may have joined while it ran), or ok:false.
 */
export async function finishResearch(
  db: Db,
  claim: Pick<ResearchClaim, "tokenKey" | "evidenceRev" | "attempts">,
  outcome: "done" | "failed" | "retry",
): Promise<{ ok: boolean; tenants: string[] }> {
  const state = outcome === "retry" ? (claim.attempts < FOMO_LIMITS.researchMaxAttempts ? "queued" : "failed") : outcome;
  const r = (await db
    .prepare(
      `UPDATE fomo_research_queue SET state = ?, claimed_until_ms = NULL
        WHERE token_key = ? AND evidence_rev = ? AND state = 'claimed' AND attempts = ?
        RETURNING tenants_json`,
    )
    .get(state, keyOf(claim.tokenKey, "tokenKey"), keyOf(claim.evidenceRev, "evidenceRev", 128), intOf(claim.attempts, "attempts"))) as
    | Row
    | undefined;
  return r ? { ok: true, tenants: tenantList(parseJson(r.tenants_json)) } : { ok: false, tenants: [] };
}

// ══════════════════════════════ TENANT TABLES ════════════════════════════════

// ── requests ────────────────────────────────────────────────────────────────

export interface FomoRequestRecord {
  requestId: string;
  tenant: string;
  surface: FomoSurface;
  tool: string;
  status: "pending" | ResultStatus;
  subjectKey: string | null;
  createdAtMs: number;
  completedAtMs: number | null;
  meta: unknown;
}

/** Log a tool call as it starts. A repeated request id is one request (false). */
export async function logRequest(
  db: Db,
  r: { requestId: string; tenant: string; surface: FomoSurface; tool: string; subjectKey?: string | null; nowMs: number; meta?: unknown },
): Promise<boolean> {
  if (!isIn(SURFACES, r.surface)) throw new TypeError("fomo store: unknown surface");
  const row = await db
    .prepare(
      `INSERT INTO fomo_requests (request_id, tenant, surface, tool, status, subject_key, created_at_ms, completed_at_ms, meta_json)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL, ?)
       ON CONFLICT (request_id) DO NOTHING
       RETURNING request_id`,
    )
    .get(
      keyOf(r.requestId, "requestId", 128),
      tenantOf(r.tenant),
      r.surface,
      slugOf(r.tool, "tool"),
      optKey(r.subjectKey, "subjectKey"),
      intOf(r.nowMs, "nowMs"),
      r.meta === undefined ? null : jsonOf(r.meta, FOMO_LIMITS.metaJsonChars, "request meta"),
    );
  return row !== undefined && row !== null;
}

/** Complete a tenant's own pending request, once. */
export async function completeRequest(db: Db, tenant: string, requestId: string, status: ResultStatus, nowMs: number, meta?: unknown): Promise<boolean> {
  if (!isIn(RESULT_STATUSES, status)) throw new TypeError("fomo store: unknown result status");
  const r = await db
    .prepare(
      `UPDATE fomo_requests SET status = ?, completed_at_ms = ?, meta_json = COALESCE(?, meta_json)
        WHERE request_id = ? AND tenant = ? AND completed_at_ms IS NULL`,
    )
    .run(
      status,
      intOf(nowMs, "nowMs"),
      meta === undefined ? null : jsonOf(meta, FOMO_LIMITS.metaJsonChars, "request meta"),
      keyOf(requestId, "requestId", 128),
      tenantOf(tenant),
    );
  return r.changes === 1;
}

const REQUEST_COLUMNS = "request_id, tenant, surface, tool, status, subject_key, created_at_ms, completed_at_ms, meta_json";

function requestOf(r: Row): FomoRequestRecord | null {
  const created = num(r.created_at_ms);
  if (typeof r.request_id !== "string" || typeof r.tenant !== "string" || created === null || !isIn(SURFACES, r.surface)) return null;
  return {
    requestId: r.request_id,
    tenant: r.tenant,
    surface: r.surface,
    tool: str(r.tool) ?? "",
    status: isIn(RESULT_STATUSES, r.status) ? r.status : "pending",
    subjectKey: str(r.subject_key),
    createdAtMs: created,
    completedAtMs: num(r.completed_at_ms),
    meta: parseJson(r.meta_json),
  };
}

export async function getRequest(db: Db, tenant: string, requestId: string): Promise<FomoRequestRecord | null> {
  const r = (await db
    .prepare(`SELECT ${REQUEST_COLUMNS} FROM fomo_requests WHERE request_id = ? AND tenant = ?`)
    .get(keyOf(requestId, "requestId", 128), tenantOf(tenant))) as Row | undefined;
  return r ? requestOf(r) : null;
}

export async function recentRequests(db: Db, tenant: string, limit: number): Promise<FomoRequestRecord[]> {
  const rows = (await db
    .prepare(`SELECT ${REQUEST_COLUMNS} FROM fomo_requests WHERE tenant = ? ORDER BY created_at_ms DESC, request_id DESC LIMIT ?`)
    .all(tenantOf(tenant), pageOf(limit))) as Row[];
  return rows.flatMap((r) => requestOf(r) ?? []);
}

/** For a per-owner rate limit. */
export async function countRequestsSince(db: Db, tenant: string, sinceMs: number): Promise<number> {
  const r = (await db
    .prepare("SELECT COUNT(*) AS n FROM fomo_requests WHERE tenant = ? AND created_at_ms >= ?")
    .get(tenantOf(tenant), intOf(sinceMs, "sinceMs"))) as Row | undefined;
  return num(r?.n) ?? 0;
}

// ── jobs ────────────────────────────────────────────────────────────────────

export type FomoJobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
const JOB_STATUSES: Record<FomoJobStatus, true> = { queued: true, running: true, done: true, failed: true, cancelled: true };

export interface FomoJob {
  id: string;
  tenant: string;
  idempotencyKey: string | null;
  conversationKey: string | null;
  surface: FomoSurface;
  kind: string;
  params: unknown;
  status: FomoJobStatus;
  deadlineMs: number;
  costAllowanceCredits: number | null;
  createdAtMs: number;
  leaseUntilMs: number | null;
  attempts: number;
  result: unknown;
  deliveredAtMs: number | null;
}

export interface ClaimedFomoJob {
  id: string;
  tenant: string;
  kind: string;
  params: unknown;
  surface: FomoSurface;
  conversationKey: string | null;
  deadlineMs: number;
  costAllowanceCredits: number | null;
  leaseUntilMs: number;
  /** The fencing token: heartbeatJob and finishJob are conditioned on it. */
  attempts: number;
}

const JOB_COLUMNS =
  "id, tenant, idempotency_key, conversation_key, surface, kind, params_json, status, deadline_ms, cost_allowance_credits, " +
  "created_at_ms, lease_until_ms, attempts, result_json, delivered_at_ms";

function jobOf(r: Row | undefined): FomoJob | null {
  if (!r) return null;
  const deadline = num(r.deadline_ms);
  const created = num(r.created_at_ms);
  if (typeof r.id !== "string" || typeof r.tenant !== "string" || deadline === null || created === null) return null;
  if (!isIn(SURFACES, r.surface) || !isIn(JOB_STATUSES, r.status)) return null;
  return {
    id: r.id,
    tenant: r.tenant,
    idempotencyKey: str(r.idempotency_key),
    conversationKey: str(r.conversation_key),
    surface: r.surface,
    kind: str(r.kind) ?? "",
    params: parseJson(r.params_json),
    status: r.status,
    deadlineMs: deadline,
    costAllowanceCredits: num(r.cost_allowance_credits),
    createdAtMs: created,
    leaseUntilMs: num(r.lease_until_ms),
    attempts: num(r.attempts) ?? 0,
    result: parseJson(r.result_json),
    deliveredAtMs: num(r.delivered_at_ms),
  };
}

export type EnqueueJobResult =
  | { ok: true; job: FomoJob; created: boolean }
  | { ok: false; reason: "quota-exceeded"; active: number }
  | { ok: false; reason: "idempotency-conflict"; job: FomoJob };

/**
 * Queue a background research job for an owner.
 *
 * The same idempotency key with the same kind and params returns the existing
 * job (whatever its status); with different ones it is a conflict, never a
 * silent second job. A new job is refused while the owner already has
 * `activeJobsPerTenant` queued or running. The check and the insert run under
 * the owner's lock row (lockTenant), so two simultaneous requests cannot both
 * slip under the quota on either backend.
 */
export async function enqueueJob(
  db: Db,
  input: {
    tenant: string;
    idempotencyKey: string | null;
    conversationKey: string | null;
    surface: FomoSurface;
    kind: string;
    params: unknown;
    deadlineMs: number;
    costAllowanceCredits: number | null;
    nowMs: number;
    /** Supplied by a caller that already minted one; otherwise generated. */
    id?: string;
  },
): Promise<EnqueueJobResult> {
  const tenant = tenantOf(input.tenant);
  const key = optKey(input.idempotencyKey, "idempotencyKey", 128);
  const kind = slugOf(input.kind, "job kind");
  if (!isIn(SURFACES, input.surface)) throw new TypeError("fomo store: unknown surface");
  const now = intOf(input.nowMs, "nowMs");
  const deadline = intOf(input.deadlineMs, "deadlineMs");
  if (deadline <= now) throw new RangeError("fomo store: a job deadline must be in the future");
  const params = jsonOf(input.params, FOMO_LIMITS.jobParamsChars, "job params");
  const credits = input.costAllowanceCredits === null ? null : countOf(input.costAllowanceCredits, "costAllowanceCredits");
  const id = input.id !== undefined ? keyOf(input.id, "job id", 128) : `fj_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
  return db.tx(async (tx): Promise<EnqueueJobResult> => {
    await lockTenant(tx, tenant, "jobs", now);
    if (key) {
      const existing = jobOf((await tx.prepare(`SELECT ${JOB_COLUMNS} FROM fomo_jobs WHERE tenant = ? AND idempotency_key = ?`).get(tenant, key)) as Row | undefined);
      if (existing) {
        const same = existing.kind === kind && JSON.stringify(existing.params) === JSON.stringify(JSON.parse(params));
        return same ? { ok: true, job: existing, created: false } : { ok: false, reason: "idempotency-conflict", job: existing };
      }
    }
    const active = (await tx
      .prepare("SELECT COUNT(*) AS n FROM fomo_jobs WHERE tenant = ? AND status IN ('queued', 'running') AND deadline_ms > ?")
      .get(tenant, now)) as Row | undefined;
    const n = num(active?.n) ?? 0;
    if (n >= FOMO_LIMITS.activeJobsPerTenant) return { ok: false, reason: "quota-exceeded", active: n };
    const row = (await tx
      .prepare(
        `INSERT INTO fomo_jobs (id, tenant, idempotency_key, conversation_key, surface, kind, params_json, status, deadline_ms,
           cost_allowance_credits, created_at_ms, lease_until_ms, attempts, result_json, delivered_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, NULL, 0, NULL, NULL)
         RETURNING ${JOB_COLUMNS}`,
      )
      .get(id, tenant, key, optKey(input.conversationKey, "conversationKey"), input.surface, kind, params, deadline, credits, now)) as Row | undefined;
    const job = jobOf(row);
    if (!job) throw new Error("fomo store: an inserted job did not read back");
    return { ok: true, job, created: true };
  });
}

/**
 * Claim the oldest runnable job: queued, or running with a lapsed lease and
 * attempts left (its worker died), and before its deadline. ONE UPDATE whose
 * WHERE re-states the runnable condition: on Postgres a second claimer that
 * picked the same id blocks on the row lock, re-checks against the updated
 * row (running, fresh lease) and updates nothing. `tenant` narrows the claim
 * to one owner (the self-hosted worker).
 */
export async function claimJob(db: Db, nowMs: number, leaseMs: number, opts: { tenant?: string } = {}): Promise<ClaimedFomoJob | null> {
  const now = intOf(nowMs, "nowMs");
  const until = now + countOf(leaseMs, "leaseMs");
  const max = FOMO_LIMITS.jobMaxAttempts;
  const runnable = "deadline_ms > ? AND (status = 'queued' OR (status = 'running' AND lease_until_ms < ? AND attempts < ?))";
  const scope = opts.tenant !== undefined ? " AND tenant = ?" : "";
  const scopeArgs = opts.tenant !== undefined ? [tenantOf(opts.tenant)] : [];
  const r = (await db
    .prepare(
      `UPDATE fomo_jobs SET status = 'running', attempts = attempts + 1, lease_until_ms = ?
        WHERE id = (SELECT id FROM fomo_jobs WHERE ${runnable}${scope} ORDER BY created_at_ms, id LIMIT 1)
          AND ${runnable}
        RETURNING id, tenant, kind, params_json, surface, conversation_key, deadline_ms, cost_allowance_credits, lease_until_ms, attempts`,
    )
    .get(until, now, now, max, ...scopeArgs, now, now, max)) as Row | undefined;
  if (!r || typeof r.id !== "string" || typeof r.tenant !== "string" || !isIn(SURFACES, r.surface)) return null;
  return {
    id: r.id,
    tenant: r.tenant,
    kind: str(r.kind) ?? "",
    params: parseJson(r.params_json),
    surface: r.surface,
    conversationKey: str(r.conversation_key),
    deadlineMs: num(r.deadline_ms) ?? now,
    costAllowanceCredits: num(r.cost_allowance_credits),
    leaseUntilMs: num(r.lease_until_ms) ?? until,
    attempts: num(r.attempts) ?? 0,
  };
}

/** Renew the lease. False when this attempt no longer owns the job. */
export async function heartbeatJob(db: Db, job: Pick<ClaimedFomoJob, "id" | "attempts">, nowMs: number, leaseMs: number): Promise<boolean> {
  const r = await db
    .prepare("UPDATE fomo_jobs SET lease_until_ms = ? WHERE id = ? AND status = 'running' AND attempts = ?")
    .run(intOf(nowMs, "nowMs") + countOf(leaseMs, "leaseMs"), keyOf(job.id, "job id", 128), intOf(job.attempts, "attempts"));
  return r.changes === 1;
}

/**
 * Finish this attempt, FENCED on (running, the attempt it claimed): a worker
 * that stalled past its lease and was re-claimed cannot overwrite the newer
 * attempt's result. False when it no longer owns the job. A result over the
 * cap is recorded as a failure saying so, rather than leaving the job running
 * to be retried into the same wall.
 */
export async function finishJob(
  db: Db,
  job: Pick<ClaimedFomoJob, "id" | "attempts">,
  outcome: { status: "done" | "failed" | "cancelled"; result?: unknown },
): Promise<boolean> {
  let status: FomoJobStatus = outcome.status;
  let result = outcome.result === undefined ? null : JSON.stringify(outcome.result);
  if (result !== null && result.length > FOMO_LIMITS.jobResultChars) {
    status = "failed";
    result = JSON.stringify({ reason: "result-too-large" });
  }
  const r = await db
    .prepare("UPDATE fomo_jobs SET status = ?, result_json = ?, lease_until_ms = NULL WHERE id = ? AND status = 'running' AND attempts = ?")
    .run(status, result, keyOf(job.id, "job id", 128), intOf(job.attempts, "attempts"));
  return r.changes === 1;
}

/**
 * Claim the delivery of a finished job: true for exactly one caller. Mark
 * first, then deliver: a crash in between loses one notification, which the
 * owner can recover with a status read, where the other order would post the
 * same answer twice.
 */
export async function markJobDelivered(db: Db, tenant: string, id: string, nowMs: number): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE fomo_jobs SET delivered_at_ms = ?
        WHERE id = ? AND tenant = ? AND status IN ('done', 'failed', 'cancelled') AND delivered_at_ms IS NULL`,
    )
    .run(intOf(nowMs, "nowMs"), keyOf(id, "job id", 128), tenantOf(tenant));
  return r.changes === 1;
}

/** An owner's job; another owner's job reads as null. */
export async function getJob(db: Db, tenant: string, id: string): Promise<FomoJob | null> {
  return jobOf((await db.prepare(`SELECT ${JOB_COLUMNS} FROM fomo_jobs WHERE id = ? AND tenant = ?`).get(keyOf(id, "job id", 128), tenantOf(tenant))) as Row | undefined);
}

export async function recentJobs(db: Db, tenant: string, limit: number): Promise<FomoJob[]> {
  const rows = (await db
    .prepare(`SELECT ${JOB_COLUMNS} FROM fomo_jobs WHERE tenant = ? ORDER BY created_at_ms DESC, id DESC LIMIT ?`)
    .all(tenantOf(tenant), pageOf(limit, 100))) as Row[];
  return rows.flatMap((r) => jobOf(r) ?? []);
}

/** Cancel an owner's job while it is still queued. A running job finishes or lapses; true when cancelled now. */
export async function cancelJob(db: Db, tenant: string, id: string): Promise<boolean> {
  const r = await db
    .prepare("UPDATE fomo_jobs SET status = 'cancelled', lease_until_ms = NULL WHERE id = ? AND tenant = ? AND status = 'queued'")
    .run(keyOf(id, "job id", 128), tenantOf(tenant));
  return r.changes === 1;
}

/** Finished jobs nobody has delivered yet, oldest first (the delivery pass; fleet-wide). */
export async function jobsAwaitingDelivery(db: Db, limit: number): Promise<FomoJob[]> {
  const rows = (await db
    .prepare(`SELECT ${JOB_COLUMNS} FROM fomo_jobs WHERE status IN ('done', 'failed', 'cancelled') AND delivered_at_ms IS NULL ORDER BY created_at_ms, id LIMIT ?`)
    .all(pageOf(limit, 100))) as Row[];
  return rows.flatMap((r) => jobOf(r) ?? []);
}

/**
 * Settle jobs nobody will finish: queued past the deadline, and running with
 * a lapsed lease that is past the deadline or has used every attempt. Each is
 * failed with a reason the owner can be told. Returns how many.
 */
export async function sweepJobs(db: Db, nowMs: number): Promise<number> {
  const now = intOf(nowMs, "nowMs");
  const late = await db
    .prepare("UPDATE fomo_jobs SET status = 'failed', result_json = ? WHERE status = 'queued' AND deadline_ms <= ?")
    .run(JSON.stringify({ reason: "deadline" }), now);
  // A running row with no lease at all has no worker that could finish it.
  const lost = await db
    .prepare(
      `UPDATE fomo_jobs SET status = 'failed', result_json = ?, lease_until_ms = NULL
        WHERE status = 'running' AND (lease_until_ms IS NULL OR lease_until_ms < ?) AND (deadline_ms <= ? OR attempts >= ?)`,
    )
    .run(JSON.stringify({ reason: "worker-lost" }), now, now, FOMO_LIMITS.jobMaxAttempts);
  return late.changes + lost.changes;
}

// ── conversation subjects ───────────────────────────────────────────────────

/**
 * What "it" refers to in an owner's conversation: the serialised memory
 * subject-memory.ts wrote, returned as the string it wrote. That module's
 * strict deserialize is the normaliser; this one does not guess at its shape.
 * Another owner's conversation reads as null.
 */
export async function getSubject(db: Db, tenant: string, conversationKey: string): Promise<{ json: string; updatedAtMs: number } | null> {
  const r = (await db
    .prepare("SELECT subject_json, updated_at_ms FROM fomo_subjects WHERE tenant = ? AND conversation_key = ?")
    .get(tenantOf(tenant), keyOf(conversationKey, "conversationKey"))) as Row | undefined;
  const json = str(r?.subject_json);
  const updated = num(r?.updated_at_ms);
  return json !== null && updated !== null ? { json, updatedAtMs: updated } : null;
}

/**
 * Keys under this prefix hold an owner's DURABLE child state (an exploration
 * ledger, say), not a conversation's memory: retention never prunes them
 * (fomoRetentionStatements), and they share setSubject's 16 KiB cap.
 */
export const FOMO_STATE_KEY_PREFIX = "state:";

/**
 * Remember a conversation's subject memory (a serialised string), or a
 * `state:` key's durable state. It must be JSON and within the cap
 * (subjectJsonChars: 16,384 characters, 16 KiB of ASCII JSON); an over-long
 * one is refused rather than cut, because cut JSON would read back as nothing
 * at all. An older write never replaces a newer one. True when written.
 */
export async function setSubject(db: Db, tenant: string, conversationKey: string, json: string, nowMs: number): Promise<boolean> {
  if (typeof json !== "string" || json.length > FOMO_LIMITS.subjectJsonChars || parseJson(json) === null) {
    throw new TypeError("fomo store: subject memory must be JSON within the size cap");
  }
  const row = await db
    .prepare(
      `INSERT INTO fomo_subjects (tenant, conversation_key, subject_json, updated_at_ms) VALUES (?, ?, ?, ?)
       ON CONFLICT (tenant, conversation_key) DO UPDATE SET subject_json = excluded.subject_json, updated_at_ms = excluded.updated_at_ms
       WHERE fomo_subjects.updated_at_ms <= excluded.updated_at_ms
       RETURNING tenant`,
    )
    .get(tenantOf(tenant), keyOf(conversationKey, "conversationKey"), json, intOf(nowMs, "nowMs"));
  return row !== undefined && row !== null;
}

export async function clearSubject(db: Db, tenant: string, conversationKey: string): Promise<boolean> {
  const r = await db
    .prepare("DELETE FROM fomo_subjects WHERE tenant = ? AND conversation_key = ?")
    .run(tenantOf(tenant), keyOf(conversationKey, "conversationKey"));
  return r.changes > 0;
}

// ── watches ─────────────────────────────────────────────────────────────────

export interface FomoWatch {
  tenant: string;
  tokenKey: string;
  label: TokenLabel;
  createdAtMs: number;
  expiresAtMs: number;
  createdVia: FomoSurface;
}

export type AddWatchResult =
  | { ok: true; created: boolean; watch: FomoWatch }
  | { ok: false; reason: "cap-reached"; active: number }
  | { ok: false; reason: "expiry-not-future" | "expiry-too-far" };

/**
 * Watch a coin for an owner. A watch MUST expire, within `watchMaxMs`: a
 * forgotten watch keeps spending shared retrieval budget long after anyone
 * cares. At most `activeWatchesPerTenant` are active at once; renewing a
 * watch that is still active does not count against that, re-activating an
 * expired one does (and restarts its created time). Counted and written under
 * the owner's lock row, so two concurrent adds cannot pass the cap together.
 */
export async function addWatch(
  db: Db,
  w: { tenant: string; tokenKey: string; label: TokenLabel; nowMs: number; expiresAtMs: number; createdVia: FomoSurface },
): Promise<AddWatchResult> {
  const tenant = tenantOf(w.tenant);
  const tokenKey = keyOf(w.tokenKey, "tokenKey");
  const now = intOf(w.nowMs, "nowMs");
  const expires = intOf(w.expiresAtMs, "expiresAtMs");
  if (!isIn(SURFACES, w.createdVia)) throw new TypeError("fomo store: unknown surface");
  if (expires <= now) return { ok: false, reason: "expiry-not-future" };
  if (expires - now > FOMO_LIMITS.watchMaxMs) return { ok: false, reason: "expiry-too-far" };
  const label = jsonOf({ symbol: textOf(w.label?.symbol, 64), name: textOf(w.label?.name, FOMO_LIMITS.nameChars) }, 1_024, "watch label");
  return db.tx(async (tx): Promise<AddWatchResult> => {
    await lockTenant(tx, tenant, "watches", now);
    const existing = (await tx
      .prepare("SELECT created_at_ms, expires_at_ms FROM fomo_watches WHERE tenant = ? AND token_key = ?")
      .get(tenant, tokenKey)) as Row | undefined;
    const wasActive = existing !== undefined && (num(existing.expires_at_ms) ?? 0) > now;
    if (!wasActive) {
      const c = (await tx
        .prepare("SELECT COUNT(*) AS n FROM fomo_watches WHERE tenant = ? AND expires_at_ms > ?")
        .get(tenant, now)) as Row | undefined;
      const active = num(c?.n) ?? 0;
      if (active >= FOMO_LIMITS.activeWatchesPerTenant) return { ok: false, reason: "cap-reached", active };
    }
    const createdAt = wasActive ? num(existing?.created_at_ms) ?? now : now;
    await tx
      .prepare(
        `INSERT INTO fomo_watches (tenant, token_key, label_json, created_at_ms, expires_at_ms, created_via) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant, token_key) DO UPDATE SET label_json = excluded.label_json, created_at_ms = excluded.created_at_ms,
           expires_at_ms = excluded.expires_at_ms, created_via = excluded.created_via`,
      )
      .run(tenant, tokenKey, label, createdAt, expires, w.createdVia);
    return {
      ok: true,
      created: !wasActive,
      watch: { tenant, tokenKey, label: labelOf(JSON.parse(label)), createdAtMs: createdAt, expiresAtMs: expires, createdVia: w.createdVia },
    };
  });
}

export async function removeWatch(db: Db, tenant: string, tokenKey: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM fomo_watches WHERE tenant = ? AND token_key = ?").run(tenantOf(tenant), keyOf(tokenKey, "tokenKey"));
  return r.changes > 0;
}

function watchOf(r: Row): FomoWatch | null {
  const created = num(r.created_at_ms);
  const expires = num(r.expires_at_ms);
  if (typeof r.tenant !== "string" || typeof r.token_key !== "string" || created === null || expires === null || !isIn(SURFACES, r.created_via)) return null;
  return { tenant: r.tenant, tokenKey: r.token_key, label: labelOf(parseJson(r.label_json)), createdAtMs: created, expiresAtMs: expires, createdVia: r.created_via };
}

/** An owner's unexpired watches, oldest first. */
export async function activeWatches(db: Db, tenant: string, nowMs: number): Promise<FomoWatch[]> {
  const rows = (await db
    .prepare(
      `SELECT tenant, token_key, label_json, created_at_ms, expires_at_ms, created_via FROM fomo_watches
        WHERE tenant = ? AND expires_at_ms > ? ORDER BY created_at_ms, token_key`,
    )
    .all(tenantOf(tenant), intOf(nowMs, "nowMs"))) as Row[];
  return rows.flatMap((r) => watchOf(r) ?? []);
}

/** Owners with an unexpired watch on a token: who the shared ingestion routes its events to. */
export async function tenantsWatching(db: Db, tokenKey: string, nowMs: number): Promise<string[]> {
  const rows = (await db
    .prepare("SELECT tenant FROM fomo_watches WHERE token_key = ? AND expires_at_ms > ? ORDER BY tenant")
    .all(keyOf(tokenKey, "tokenKey"), intOf(nowMs, "nowMs"))) as Row[];
  return rows.flatMap((r) => (typeof r.tenant === "string" ? [r.tenant] : []));
}

/** Every token anybody is watching (the fleet stream's filter). */
export async function watchedTokenKeys(db: Db, nowMs: number, limit: number): Promise<string[]> {
  const rows = (await db
    .prepare("SELECT DISTINCT token_key FROM fomo_watches WHERE expires_at_ms > ? ORDER BY token_key LIMIT ?")
    .all(intOf(nowMs, "nowMs"), pageOf(limit, 5_000))) as Row[];
  return rows.flatMap((r) => (typeof r.token_key === "string" ? [r.token_key] : []));
}

// ── tails ───────────────────────────────────────────────────────────────────

export type AddTailResult =
  | { ok: true; created: boolean; tail: FomoTail }
  | { ok: false; reason: "cap-reached"; active: number }
  | { ok: false; reason: "expiry-not-future" | "expiry-too-far" };

/**
 * Tail a Fomo trader for an owner, addWatch's rules exactly: a tail MUST
 * expire, within `tailMaxMs` (a forgotten tail keeps telling the owner about a
 * stranger's trades long after anyone asked). At most `activeTailsPerTenant`
 * are active at once; renewing a tail that is still active does not count
 * against that and may change its expiry and `consider`, re-activating an
 * expired one does count (and restarts its created time). Counted and written
 * under the owner's lock row, so two concurrent adds cannot pass the cap
 * together. Owner state only: nothing here sizes, orders or grants.
 */
export async function addTail(
  db: Db,
  t: { tenant: string; userId: string; handle: string | null; consider: boolean; nowMs: number; expiresAtMs: number; createdVia: FomoSurface },
): Promise<AddTailResult> {
  const tenant = tenantOf(t.tenant);
  const userId = keyOf(t.userId, "userId", 128);
  const now = intOf(t.nowMs, "nowMs");
  const expires = intOf(t.expiresAtMs, "expiresAtMs");
  if (!isIn(SURFACES, t.createdVia)) throw new TypeError("fomo store: unknown surface");
  if (typeof t.consider !== "boolean") throw new TypeError("fomo store: consider must be a boolean");
  if (expires <= now) return { ok: false, reason: "expiry-not-future" };
  if (expires - now > FOMO_LIMITS.tailMaxMs) return { ok: false, reason: "expiry-too-far" };
  const handle = typeof t.handle === "string" ? textOf(t.handle.trim().replace(/^@+/, ""), FOMO_LIMITS.handleChars) || null : null;
  const consider = t.consider ? 1 : 0;
  return db.tx(async (tx): Promise<AddTailResult> => {
    await lockTenant(tx, tenant, "tails", now);
    const existing = (await tx
      .prepare("SELECT created_at_ms, expires_at_ms FROM fomo_tails WHERE tenant = ? AND user_id = ?")
      .get(tenant, userId)) as Row | undefined;
    const wasActive = existing !== undefined && (num(existing.expires_at_ms) ?? 0) > now;
    if (!wasActive) {
      const c = (await tx
        .prepare("SELECT COUNT(*) AS n FROM fomo_tails WHERE tenant = ? AND expires_at_ms > ?")
        .get(tenant, now)) as Row | undefined;
      const active = num(c?.n) ?? 0;
      if (active >= FOMO_LIMITS.activeTailsPerTenant) return { ok: false, reason: "cap-reached", active };
    }
    const createdAt = wasActive ? num(existing?.created_at_ms) ?? now : now;
    await tx
      .prepare(
        `INSERT INTO fomo_tails (tenant, user_id, handle, consider, created_at_ms, expires_at_ms, created_via) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant, user_id) DO UPDATE SET handle = excluded.handle, consider = excluded.consider, created_at_ms = excluded.created_at_ms,
           expires_at_ms = excluded.expires_at_ms, created_via = excluded.created_via`,
      )
      .run(tenant, userId, handle, consider, createdAt, expires, t.createdVia);
    return {
      ok: true,
      created: !wasActive,
      tail: { tenant, userId, handle, consider: consider === 1, createdAtMs: createdAt, expiresAtMs: expires, createdVia: t.createdVia },
    };
  });
}

/** Stop one tail now (its row goes; nothing is summarised for a tail the owner stopped). True when there was one. */
export async function removeTail(db: Db, tenant: string, userId: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM fomo_tails WHERE tenant = ? AND user_id = ?").run(tenantOf(tenant), keyOf(userId, "userId", 128));
  return r.changes > 0;
}

/** Stop every ACTIVE tail of one owner; returns how many were stopped. Ended rows are left to retention. */
export async function removeAllTails(db: Db, tenant: string, nowMs: number): Promise<number> {
  const r = await db.prepare("DELETE FROM fomo_tails WHERE tenant = ? AND expires_at_ms > ?").run(tenantOf(tenant), intOf(nowMs, "nowMs"));
  return r.changes;
}

const TAIL_COLUMNS = "tenant, user_id, handle, consider, created_at_ms, expires_at_ms, created_via";

function tailOf(r: Row): FomoTail | null {
  const created = num(r.created_at_ms);
  const expires = num(r.expires_at_ms);
  const consider = flag(r.consider);
  if (typeof r.tenant !== "string" || typeof r.user_id !== "string" || created === null || expires === null || consider === null || !isIn(SURFACES, r.created_via)) {
    return null;
  }
  return { tenant: r.tenant, userId: r.user_id, handle: str(r.handle), consider, createdAtMs: created, expiresAtMs: expires, createdVia: r.created_via };
}

/** An owner's unexpired tails, oldest first. */
export async function activeTails(db: Db, tenant: string, nowMs: number): Promise<FomoTail[]> {
  const rows = (await db
    .prepare(`SELECT ${TAIL_COLUMNS} FROM fomo_tails WHERE tenant = ? AND expires_at_ms > ? ORDER BY created_at_ms, user_id`)
    .all(tenantOf(tenant), intOf(nowMs, "nowMs"))) as Row[];
  return rows.flatMap((r) => tailOf(r) ?? []);
}

/** An owner's tails that ended (expired) after `sinceMs` and by `nowMs`, oldest end first: what an end-of-tail summary reads. */
export async function recentlyEndedTails(db: Db, tenant: string, sinceMs: number, nowMs: number): Promise<FomoTail[]> {
  const rows = (await db
    .prepare(`SELECT ${TAIL_COLUMNS} FROM fomo_tails WHERE tenant = ? AND expires_at_ms > ? AND expires_at_ms <= ? ORDER BY expires_at_ms, user_id`)
    .all(tenantOf(tenant), intOf(sinceMs, "sinceMs"), intOf(nowMs, "nowMs"))) as Row[];
  return rows.flatMap((r) => tailOf(r) ?? []);
}

/**
 * EVERY TRADER ANYBODY IS TAILING NOW → the owners tailing them (the only
 * tenants a tailed trader's events are routed to for it), at most `limit`
 * traders by id, each owner list sorted. ONE query for the whole fleet: the
 * leader's routing reads this every interest refresh, so it must not cost a
 * round trip per tailed trader. Rows are bounded by the trader limit times
 * the owners tailing each (each owner holds at most activeTailsPerTenant).
 */
export async function tailOwners(db: Db, nowMs: number, limit: number): Promise<Map<string, string[]>> {
  const now = intOf(nowMs, "nowMs");
  const rows = (await db
    .prepare(
      `SELECT user_id, tenant FROM fomo_tails
        WHERE expires_at_ms > ? AND user_id IN (SELECT DISTINCT user_id FROM fomo_tails WHERE expires_at_ms > ? ORDER BY user_id LIMIT ?)
        ORDER BY user_id, tenant`,
    )
    .all(now, now, pageOf(limit, FOMO_LIMITS.tailedTradersFleet))) as Row[];
  const out = new Map<string, string[]>();
  for (const r of rows) {
    if (typeof r.user_id !== "string" || typeof r.tenant !== "string") continue;
    const list = out.get(r.user_id);
    if (list) list.push(r.tenant);
    else out.set(r.user_id, [r.tenant]);
  }
  return out;
}

// ── tenant routes ───────────────────────────────────────────────────────────

/**
 * The opt-in snapshot the SHARED ingestion routes by. The orchestrator writes
 * it from each owner's settings; the ingestion reads only this, never the
 * settings blob, so an owner who switched Fomo off stops receiving events at
 * the next write rather than whenever a child next restarts.
 */
export interface TenantRoute {
  tenant: string;
  dataAccess: boolean;
  monitoring: boolean;
  follow: boolean;
  updatedAtMs: number;
}

/** True when written. A snapshot older than the stored one is refused (a slow writer must not undo an owner's newer Off). */
export async function setTenantRoute(db: Db, tenant: string, route: { dataAccess: boolean; monitoring: boolean; follow: boolean }, nowMs: number): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO fomo_tenant_routes (tenant, data_access, monitoring, follow, updated_at_ms) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (tenant) DO UPDATE SET data_access = excluded.data_access, monitoring = excluded.monitoring,
         follow = excluded.follow, updated_at_ms = excluded.updated_at_ms
       WHERE fomo_tenant_routes.updated_at_ms <= excluded.updated_at_ms
       RETURNING tenant`,
    )
    .get(tenantOf(tenant), bit(route.dataAccess === true), bit(route.monitoring === true), bit(route.follow === true), intOf(nowMs, "nowMs"));
  return row !== undefined && row !== null;
}

export async function getTenantRoute(db: Db, tenant: string): Promise<TenantRoute | null> {
  const r = (await db
    .prepare("SELECT tenant, data_access, monitoring, follow, updated_at_ms FROM fomo_tenant_routes WHERE tenant = ?")
    .get(tenantOf(tenant))) as Row | undefined;
  const updated = num(r?.updated_at_ms);
  if (!r || typeof r.tenant !== "string" || updated === null) return null;
  return { tenant: r.tenant, dataAccess: num(r.data_access) === 1, monitoring: num(r.monitoring) === 1, follow: num(r.follow) === 1, updatedAtMs: updated };
}

/**
 * Owners routed for a purpose. Data access is the master switch: a tenant with
 * monitoring or follow on but data access off is routed for nothing.
 */
export async function routedTenants(
  db: Db,
  purpose: "data-access" | "monitoring" | "follow",
  o: {
    /**
     * Only routes written at or after this. A route is rewritten every few
     * minutes by whichever replica holds the owner's lease healthily, so a
     * row nobody has refreshed for a long while belongs to an owner nobody
     * acts for any more (grant revoked, killed, expired): it routes nothing.
     */
    freshSinceMs?: number;
  } = {},
): Promise<string[]> {
  const where =
    purpose === "monitoring" ? "data_access = 1 AND monitoring = 1" : purpose === "follow" ? "data_access = 1 AND follow = 1" : "data_access = 1";
  const fresh = o.freshSinceMs === undefined ? null : intOf(o.freshSinceMs, "freshSinceMs");
  const rows = (await (fresh === null
    ? db.prepare(`SELECT tenant FROM fomo_tenant_routes WHERE ${where} ORDER BY tenant`).all()
    : db.prepare(`SELECT tenant FROM fomo_tenant_routes WHERE ${where} AND updated_at_ms >= ? ORDER BY tenant`).all(fresh))) as Row[];
  return rows.flatMap((r) => (typeof r.tenant === "string" ? [r.tenant] : []));
}

// ── held tokens ─────────────────────────────────────────────────────────────

/**
 * REPLACE an owner's held set: the coins it holds now, as Robinhood token keys
 * (or any token key the caller validated). Written by whoever can see the
 * owner's book — the replica holding its lease (the ledger mirror) or the
 * owner's own child reporting through the broker — so every replica, and the
 * fleet's ingestion leader, can read the same answer. An empty list clears
 * the set.
 *
 * Duplicates collapse; more than `heldTokensPerTenant` keys is refused rather
 * than cut (a truncated book would read as "does not hold" for the rest). A
 * write older than the stored set is refused, so a slow writer cannot bring
 * back a coin the owner has since sold. Serialised per owner on its lock row.
 * Opens its own transaction: pass the ROOT Db. Returns false when refused.
 */
export async function setHeldTokens(db: Db, tenant: string, tokenKeys: readonly string[], nowMs: number): Promise<boolean> {
  const t = tenantOf(tenant);
  const now = intOf(nowMs, "nowMs");
  const keys = [...new Set(tokenKeys.map((k) => keyOf(k, "tokenKey")))].sort();
  if (keys.length > FOMO_LIMITS.heldTokensPerTenant) throw new RangeError(`fomo store: at most ${FOMO_LIMITS.heldTokensPerTenant} held tokens per owner`);
  return db.tx(async (tx) => {
    await lockTenant(tx, t, "held-tokens", now);
    const newest = (await tx.prepare("SELECT MAX(updated_at_ms) AS newest FROM fomo_held_tokens WHERE tenant = ?").get(t)) as Row | undefined;
    const prior = num(newest?.newest);
    if (prior !== null && prior > now) return false;
    await tx.prepare("DELETE FROM fomo_held_tokens WHERE tenant = ?").run(t);
    for (const part of chunksOf(keys, 100)) {
      await tx
        .prepare(`INSERT INTO fomo_held_tokens (tenant, token_key, updated_at_ms) VALUES ${valuesList(3, part.length)}`)
        .run(...part.flatMap((k) => [t, k, now]));
    }
    return true;
  });
}

/** One owner's held coins, as last written at or after `sinceMs`, sorted. Another owner's rows never answer. */
export async function heldTokensFor(db: Db, tenant: string, sinceMs: number): Promise<string[]> {
  const rows = (await db
    .prepare("SELECT token_key FROM fomo_held_tokens WHERE tenant = ? AND updated_at_ms >= ? ORDER BY token_key")
    .all(tenantOf(tenant), intOf(sinceMs, "sinceMs"))) as Row[];
  return rows.flatMap((r) => (typeof r.token_key === "string" ? [r.token_key] : []));
}

/**
 * Every owner's held coins written at or after `sinceMs`: tokenKey → owners
 * (sorted). FOR THE FLEET'S INGESTION ONLY — it decides which events protect
 * a position and to whom they matter; nothing that answers an owner may read
 * another owner's holdings from here. Bounded by `limit` rows.
 */
export async function heldTokensFleet(db: Db, sinceMs: number, limit = 20_000): Promise<Map<string, string[]>> {
  const rows = (await db
    .prepare("SELECT tenant, token_key FROM fomo_held_tokens WHERE updated_at_ms >= ? ORDER BY token_key, tenant LIMIT ?")
    .all(intOf(sinceMs, "sinceMs"), pageOf(limit, 20_000))) as Row[];
  const out = new Map<string, string[]>();
  for (const r of rows) {
    if (typeof r.tenant !== "string" || typeof r.token_key !== "string") continue;
    const list = out.get(r.token_key) ?? [];
    list.push(r.tenant);
    out.set(r.token_key, list);
  }
  return out;
}

// ── assessments ─────────────────────────────────────────────────────────────

/** Store an assessment (immutable once written). False when its id exists. */
export async function insertAssessment(db: Db, a: FollowAssessment): Promise<boolean> {
  const clean = followAssessmentOf(a);
  if (!clean || clean.id !== a.id) throw new TypeError("fomo store: not a valid FollowAssessment");
  // A field that would be dropped on the way in is refused instead: a stored
  // assessment with its ceiling or quote silently missing reads as "none".
  if (a.sizeCeilingUsdg6 !== null && clean.sizeCeilingUsdg6 === null) throw new TypeError("fomo store: sizeCeilingUsdg6 must be a micro-USDG integer string");
  if (a.decisionQuote !== null && clean.decisionQuote === null) throw new TypeError("fomo store: decisionQuote is malformed");
  const row = await db
    .prepare(
      `INSERT INTO fomo_assessments (id, tenant, token_key, state, assessment_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
    )
    .get(
      keyOf(clean.id, "assessment id", 128),
      tenantOf(clean.tenant),
      keyOf(clean.token.key, "tokenKey"),
      clean.state,
      jsonOf(clean, FOMO_LIMITS.assessmentJsonChars, "assessment"),
      intOf(clean.createdAt, "createdAt"),
    );
  return row !== undefined && row !== null;
}

function assessmentsOf(rows: Row[]): FollowAssessment[] {
  const out: FollowAssessment[] = [];
  for (const r of rows) {
    const a = followAssessmentOf(parseJson(r.assessment_json));
    // The columns are authoritative for identity and ownership.
    if (a && a.id === r.id && a.tenant === r.tenant) out.push(a);
  }
  return out;
}

export async function latestAssessment(db: Db, tenant: string, tokenKey: string): Promise<FollowAssessment | null> {
  const rows = (await db
    .prepare(
      `SELECT id, tenant, assessment_json FROM fomo_assessments WHERE tenant = ? AND token_key = ?
        ORDER BY created_at_ms DESC, id DESC LIMIT 1`,
    )
    .all(tenantOf(tenant), keyOf(tokenKey, "tokenKey"))) as Row[];
  return assessmentsOf(rows)[0] ?? null;
}

export async function recentAssessments(db: Db, tenant: string, limit: number): Promise<FollowAssessment[]> {
  const rows = (await db
    .prepare("SELECT id, tenant, assessment_json FROM fomo_assessments WHERE tenant = ? ORDER BY created_at_ms DESC, id DESC LIMIT ?")
    .all(tenantOf(tenant), pageOf(limit, 200))) as Row[];
  return assessmentsOf(rows);
}

// ── position dependencies ───────────────────────────────────────────────────

/**
 * "This owner holds a position that depends on this trader's behaviour in
 * this token": the shared ingestion keeps those (trader, token) pairs at
 * position-protection priority. Capped per owner, and it must expire: the
 * lifecycle pass renews it while the position is open.
 */
export interface PositionDep {
  tenant: string;
  userId: string;
  tokenKey: string;
  reason: string;
  createdAtMs: number;
  expiresAtMs: number;
}

export type AddPositionDepResult =
  | { ok: true; created: boolean }
  | { ok: false; reason: "cap-reached"; active: number }
  | { ok: false; reason: "expiry-not-future" | "expiry-too-far" };

export async function addPositionDep(
  db: Db,
  d: { tenant: string; userId: string; tokenKey: string; reason: string; nowMs: number; expiresAtMs: number },
): Promise<AddPositionDepResult> {
  const tenant = tenantOf(d.tenant);
  const userId = keyOf(d.userId, "userId", 128);
  const tokenKey = keyOf(d.tokenKey, "tokenKey");
  const now = intOf(d.nowMs, "nowMs");
  const expires = intOf(d.expiresAtMs, "expiresAtMs");
  if (expires <= now) return { ok: false, reason: "expiry-not-future" };
  if (expires - now > FOMO_LIMITS.positionDepMaxMs) return { ok: false, reason: "expiry-too-far" };
  return db.tx(async (tx): Promise<AddPositionDepResult> => {
    await lockTenant(tx, tenant, "position-deps", now);
    const existing = (await tx
      .prepare("SELECT created_at_ms, expires_at_ms FROM fomo_position_deps WHERE tenant = ? AND user_id = ? AND token_key = ?")
      .get(tenant, userId, tokenKey)) as Row | undefined;
    const wasActive = existing !== undefined && (num(existing.expires_at_ms) ?? 0) > now;
    if (!wasActive) {
      const c = (await tx
        .prepare("SELECT COUNT(*) AS n FROM fomo_position_deps WHERE tenant = ? AND expires_at_ms > ?")
        .get(tenant, now)) as Row | undefined;
      const active = num(c?.n) ?? 0;
      if (active >= FOMO_LIMITS.activePositionDepsPerTenant) return { ok: false, reason: "cap-reached", active };
    }
    await tx
      .prepare(
        `INSERT INTO fomo_position_deps (tenant, user_id, token_key, reason, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant, user_id, token_key) DO UPDATE SET reason = excluded.reason, created_at_ms = excluded.created_at_ms,
           expires_at_ms = excluded.expires_at_ms`,
      )
      .run(tenant, userId, tokenKey, textOf(d.reason, FOMO_LIMITS.reasonChars) ?? "", wasActive ? num(existing?.created_at_ms) ?? now : now, expires);
    return { ok: true, created: !wasActive };
  });
}

export async function removePositionDep(db: Db, tenant: string, userId: string, tokenKey: string): Promise<boolean> {
  const r = await db
    .prepare("DELETE FROM fomo_position_deps WHERE tenant = ? AND user_id = ? AND token_key = ?")
    .run(tenantOf(tenant), keyOf(userId, "userId", 128), keyOf(tokenKey, "tokenKey"));
  return r.changes > 0;
}

/** Unexpired dependencies: fleet-wide for the ingestion, or one owner's. */
export async function activePositionDeps(db: Db, nowMs: number, tenant?: string): Promise<PositionDep[]> {
  const now = intOf(nowMs, "nowMs");
  const rows = (
    tenant === undefined
      ? await db
          .prepare(
            `SELECT tenant, user_id, token_key, reason, created_at_ms, expires_at_ms FROM fomo_position_deps
              WHERE expires_at_ms > ? ORDER BY tenant, user_id, token_key`,
          )
          .all(now)
      : await db
          .prepare(
            `SELECT tenant, user_id, token_key, reason, created_at_ms, expires_at_ms FROM fomo_position_deps
              WHERE tenant = ? AND expires_at_ms > ? ORDER BY user_id, token_key`,
          )
          .all(tenantOf(tenant), now)
  ) as Row[];
  return rows.flatMap((r) => {
    const created = num(r.created_at_ms);
    const expires = num(r.expires_at_ms);
    if (typeof r.tenant !== "string" || typeof r.user_id !== "string" || typeof r.token_key !== "string" || created === null || expires === null) return [];
    return [{ tenant: r.tenant, userId: r.user_id, tokenKey: r.token_key, reason: str(r.reason) ?? "", createdAtMs: created, expiresAtMs: expires }];
  });
}

export async function expirePositionDeps(db: Db, nowMs: number): Promise<number> {
  const r = await db.prepare("DELETE FROM fomo_position_deps WHERE expires_at_ms <= ?").run(intOf(nowMs, "nowMs"));
  return r.changes;
}

// ── publications ────────────────────────────────────────────────────────────
//
// The outbox behind publish.ts (its PublicationStore port). Columns hold what
// a statement filters or orders on, or what makes a send at-most-once; the
// rest of a draft (coin name, interest disclosure, content basis, dossier
// reference) is publish.ts's to shape and travels in extra_json.

export interface FomoPublication {
  id: number;
  tenant: string;
  destination: string;
  destinationAccount: string | null;
  kind: PublicationKind;
  tokenKey: string | null;
  subjectKey: string | null;
  contentRev: number;
  body: string;
  evidenceRef: string | null;
  decisionId: string | null;
  consentScope: string | null;
  dedupeKey: string;
  fleetKey: string | null;
  state: PublicationState;
  reason: string | null;
  attempts: number;
  requeuedAfterAbsent: boolean;
  reconcileChecks: number;
  /** Parsed, unvalidated: publish.ts owns its shape. */
  extra: unknown;
  createdAtMs: number;
  dueAtMs: number;
  updatedAtMs: number;
  sentAtMs: number | null;
  externalId: string | null;
}

/** States a draft may be born in. Anything later is reached only through transitionPublication. */
const INITIAL_PUBLICATION_STATES: ReadonlySet<PublicationState> = new Set<PublicationState>([
  "draft",
  "blocked-policy",
  "blocked-consent",
  "suppressed-duplicate",
  "queued",
]);

/**
 * States that count against a fleet or subject limit: posts that went out, or
 * might have. A blocked, suppressed, cancelled or failed draft reached nobody.
 */
export const FLEET_COUNTED_STATES: readonly PublicationState[] = ["queued", "sending", "sent", "uncertain", "reconciled-sent"];

/**
 * Add a draft to the outbox. The UNIQUE dedupe key is what makes a post
 * at-most-once across crashes and replicas: a second draft with the same key
 * is not written and null comes back.
 */
export async function insertPublicationDraft(
  db: Db,
  p: {
    tenant: string;
    destination: string;
    destinationAccount?: string | null;
    kind: PublicationKind;
    tokenKey?: string | null;
    subjectKey?: string | null;
    contentRev: number;
    body: string;
    evidenceRef: string | null;
    decisionId: string | null;
    consentScope: string | null;
    dedupeKey: string;
    fleetKey: string | null;
    state?: PublicationState;
    reason?: string | null;
    extra?: unknown;
    nowMs: number;
    dueAtMs?: number;
  },
): Promise<number | null> {
  if (!isIn(PUBLICATION_KINDS, p.kind)) throw new TypeError("fomo store: unknown publication kind");
  const state = p.state ?? "draft";
  if (!INITIAL_PUBLICATION_STATES.has(state)) throw new TypeError(`fomo store: a draft cannot start as ${state}`);
  const now = intOf(p.nowMs, "nowMs");
  const row = (await db
    .prepare(
      `INSERT INTO fomo_publications (tenant, destination, destination_account, kind, token_key, subject_key, content_rev, body,
         evidence_ref, decision_id, consent_scope, dedupe_key, fleet_key, state, reason, attempts, requeued_after_absent,
         reconcile_checks, extra_json, created_at_ms, due_at_ms, updated_at_ms, sent_at_ms, external_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
    )
    .get(
      tenantOf(p.tenant),
      slugOf(p.destination, "destination"),
      optKey(p.destinationAccount, "destinationAccount", 128),
      p.kind,
      optKey(p.tokenKey, "tokenKey"),
      optKey(p.subjectKey, "subjectKey"),
      countOf(p.contentRev, "contentRev"),
      textOf(p.body, FOMO_LIMITS.publicationBodyChars) ?? "",
      optKey(p.evidenceRef, "evidenceRef"),
      optKey(p.decisionId, "decisionId", 128),
      optKey(p.consentScope, "consentScope", 64),
      keyOf(p.dedupeKey, "dedupeKey"),
      optKey(p.fleetKey, "fleetKey"),
      state,
      textOf(p.reason ?? null, FOMO_LIMITS.reasonChars),
      p.extra === undefined ? null : jsonOf(p.extra, FOMO_LIMITS.metaJsonChars, "publication extra"),
      now,
      p.dueAtMs === undefined ? now : intOf(p.dueAtMs, "dueAtMs"),
      now,
    )) as Row | undefined;
  return row ? Number(row.id) : null;
}

export interface PublicationTransitionFields {
  nowMs: number;
  reason?: string | null;
  externalId?: string | null;
  sentAtMs?: number | null;
  dueAtMs?: number;
  /** Set the claim count to this value. */
  attempts?: number;
  /** Or add one to it. Not both. */
  bumpAttempts?: boolean;
  requeuedAfterAbsent?: boolean;
  reconcileChecks?: number;
  /** Scope the move to one owner (a web request acting for an owner). */
  tenant?: string;
}

/**
 * Move a publication from one of `from` to `to`, conditionally: true for
 * exactly one caller, false when it was no longer in a `from` state (another
 * worker claimed it, an owner cancelled it). publish.ts owns which moves are
 * legal (canTransition); this makes each one atomic. Fields left undefined
 * are untouched.
 */
export async function transitionPublication(
  db: Db,
  id: number,
  from: PublicationState | readonly PublicationState[],
  to: PublicationState,
  fields: PublicationTransitionFields,
): Promise<boolean> {
  const fromList = (typeof from === "string" ? [from] : [...from]) as PublicationState[];
  if (fromList.length === 0 || !fromList.every((s) => isIn(PUBLICATION_STATES, s)) || !isIn(PUBLICATION_STATES, to)) {
    throw new TypeError("fomo store: unknown publication state");
  }
  if (fields.attempts !== undefined && fields.bumpAttempts) throw new TypeError("fomo store: set attempts or bump them, not both");
  const sets = ["state = ?", "updated_at_ms = ?"];
  const args: unknown[] = [to, intOf(fields.nowMs, "nowMs")];
  const set = (column: string, value: unknown) => {
    sets.push(`${column} = ?`);
    args.push(value);
  };
  if (fields.reason !== undefined) set("reason", textOf(fields.reason, FOMO_LIMITS.reasonChars));
  if (fields.externalId !== undefined) set("external_id", optKey(fields.externalId, "externalId", 128));
  if (fields.sentAtMs !== undefined) set("sent_at_ms", fields.sentAtMs === null ? null : intOf(fields.sentAtMs, "sentAtMs"));
  if (fields.dueAtMs !== undefined) set("due_at_ms", intOf(fields.dueAtMs, "dueAtMs"));
  if (fields.attempts !== undefined) set("attempts", countOf(fields.attempts, "attempts"));
  if (fields.requeuedAfterAbsent !== undefined) set("requeued_after_absent", bit(fields.requeuedAfterAbsent));
  if (fields.reconcileChecks !== undefined) set("reconcile_checks", countOf(fields.reconcileChecks, "reconcileChecks"));
  if (fields.bumpAttempts) sets.push("attempts = attempts + 1");
  const scope = fields.tenant !== undefined ? " AND tenant = ?" : "";
  const scopeArgs = fields.tenant !== undefined ? [tenantOf(fields.tenant)] : [];
  const r = await db
    .prepare(`UPDATE fomo_publications SET ${sets.join(", ")} WHERE id = ? AND state IN (${marks(fromList.length)})${scope}`)
    .run(...args, intOf(id, "id"), ...fromList, ...scopeArgs);
  return r.changes === 1;
}

const PUBLICATION_COLUMNS =
  "id, tenant, destination, destination_account, kind, token_key, subject_key, content_rev, body, evidence_ref, decision_id, " +
  "consent_scope, dedupe_key, fleet_key, state, reason, attempts, requeued_after_absent, reconcile_checks, extra_json, " +
  "created_at_ms, due_at_ms, updated_at_ms, sent_at_ms, external_id";

function publicationOf(r: Row): FomoPublication | null {
  const id = num(r.id);
  const created = num(r.created_at_ms);
  const due = num(r.due_at_ms);
  const updated = num(r.updated_at_ms);
  if (id === null || created === null || due === null || updated === null) return null;
  if (typeof r.tenant !== "string" || typeof r.dedupe_key !== "string" || !isIn(PUBLICATION_KINDS, r.kind) || !isIn(PUBLICATION_STATES, r.state)) return null;
  return {
    id,
    tenant: r.tenant,
    destination: str(r.destination) ?? "",
    destinationAccount: str(r.destination_account),
    kind: r.kind,
    tokenKey: str(r.token_key),
    subjectKey: str(r.subject_key),
    contentRev: num(r.content_rev) ?? 0,
    body: str(r.body) ?? "",
    evidenceRef: str(r.evidence_ref),
    decisionId: str(r.decision_id),
    consentScope: str(r.consent_scope),
    dedupeKey: r.dedupe_key,
    fleetKey: str(r.fleet_key),
    state: r.state,
    reason: str(r.reason),
    attempts: num(r.attempts) ?? 0,
    requeuedAfterAbsent: num(r.requeued_after_absent) === 1,
    reconcileChecks: num(r.reconcile_checks) ?? 0,
    extra: parseJson(r.extra_json),
    createdAtMs: created,
    dueAtMs: due,
    updatedAtMs: updated,
    sentAtMs: num(r.sent_at_ms),
    externalId: str(r.external_id),
  };
}

/** Publications in a state that are due, soonest first (the publish pass; fleet-wide). */
export async function publicationsByState(db: Db, state: PublicationState, dueBeforeMs: number, limit: number): Promise<FomoPublication[]> {
  if (!isIn(PUBLICATION_STATES, state)) throw new TypeError("fomo store: unknown publication state");
  const rows = (await db
    .prepare(`SELECT ${PUBLICATION_COLUMNS} FROM fomo_publications WHERE state = ? AND due_at_ms <= ? ORDER BY due_at_ms, id LIMIT ?`)
    .all(state, intOf(dueBeforeMs, "dueBeforeMs"), pageOf(limit, 200))) as Row[];
  return rows.flatMap((r) => publicationOf(r) ?? []);
}

/**
 * Publications in a state last touched before `updatedBeforeMs`, least
 * recently touched first (the reconcile pass; fleet-wide), so a lookup that
 * keeps answering "unknown" rotates to the back instead of starving the rest.
 */
export async function publicationsInState(db: Db, state: PublicationState, updatedBeforeMs: number, limit: number): Promise<FomoPublication[]> {
  if (!isIn(PUBLICATION_STATES, state)) throw new TypeError("fomo store: unknown publication state");
  const rows = (await db
    .prepare(`SELECT ${PUBLICATION_COLUMNS} FROM fomo_publications WHERE state = ? AND updated_at_ms < ? ORDER BY updated_at_ms, id LIMIT ?`)
    .all(state, intOf(updatedBeforeMs, "updatedBeforeMs"), pageOf(limit, 200))) as Row[];
  return rows.flatMap((r) => publicationOf(r) ?? []);
}

/**
 * How many publications under one fleet key went out (or may have) since
 * `sinceMs`, across every owner: the limit that stops thirty agents posting
 * the same coin in the same hour. See FLEET_COUNTED_STATES.
 */
export async function fleetCount(db: Db, fleetKey: string, sinceMs: number): Promise<number> {
  const r = (await db
    .prepare(`SELECT COUNT(*) AS n FROM fomo_publications WHERE fleet_key = ? AND created_at_ms >= ? AND state IN (${marks(FLEET_COUNTED_STATES.length)})`)
    .get(keyOf(fleetKey, "fleetKey"), intOf(sinceMs, "sinceMs"), ...FLEET_COUNTED_STATES)) as Row | undefined;
  return num(r?.n) ?? 0;
}

/** The same count for one owner, kind and subject: one agent repeating itself about one coin. */
export async function subjectPublicationCount(db: Db, tenant: string, kind: PublicationKind, subjectKey: string, sinceMs: number): Promise<number> {
  if (!isIn(PUBLICATION_KINDS, kind)) throw new TypeError("fomo store: unknown publication kind");
  const r = (await db
    .prepare(
      `SELECT COUNT(*) AS n FROM fomo_publications
        WHERE tenant = ? AND kind = ? AND subject_key = ? AND created_at_ms >= ? AND state IN (${marks(FLEET_COUNTED_STATES.length)})`,
    )
    .get(tenantOf(tenant), kind, keyOf(subjectKey, "subjectKey"), intOf(sinceMs, "sinceMs"), ...FLEET_COUNTED_STATES)) as Row | undefined;
  return num(r?.n) ?? 0;
}

/** An owner's publication; another owner's reads as null. */
export async function getPublication(db: Db, tenant: string, id: number): Promise<FomoPublication | null> {
  const r = (await db
    .prepare(`SELECT ${PUBLICATION_COLUMNS} FROM fomo_publications WHERE id = ? AND tenant = ?`)
    .get(intOf(id, "id"), tenantOf(tenant))) as Row | undefined;
  return r ? publicationOf(r) : null;
}

/**
 * One publication by id with no owner check, for the fleet publish pass that
 * holds an id it listed itself. Never reachable from a tenant surface: a
 * request on an owner's behalf uses getPublication.
 */
export async function publicationByIdForPass(db: Db, id: number): Promise<FomoPublication | null> {
  const r = (await db.prepare(`SELECT ${PUBLICATION_COLUMNS} FROM fomo_publications WHERE id = ?`).get(intOf(id, "id"))) as Row | undefined;
  return r ? publicationOf(r) : null;
}

export async function recentPublications(db: Db, tenant: string, limit: number): Promise<FomoPublication[]> {
  const rows = (await db
    .prepare(`SELECT ${PUBLICATION_COLUMNS} FROM fomo_publications WHERE tenant = ? ORDER BY created_at_ms DESC, id DESC LIMIT ?`)
    .all(tenantOf(tenant), pageOf(limit, 200))) as Row[];
  return rows.flatMap((r) => publicationOf(r) ?? []);
}

// ── outcomes ────────────────────────────────────────────────────────────────

export interface AssessmentOutcome {
  assessmentId: string;
  horizonLabel: string;
  observedAtMs: number;
  /** 8dp USD decimal from Merrymen's own pricing; null when no price could be read. */
  price8: string | null;
  note: string | null;
}

/**
 * Record what happened by a horizon after an assessment. Only for an
 * assessment that is this owner's: the check and the write share one
 * transaction (assessments are never deleted or re-owned), and the upsert is
 * additionally conditioned on the stored row's tenant. False when refused.
 */
export async function upsertOutcome(
  db: Db,
  o: { tenant: string; assessmentId: string; horizonLabel: string; observedAtMs: number; price8: string | null; note: string | null },
): Promise<boolean> {
  const tenant = tenantOf(o.tenant);
  const id = keyOf(o.assessmentId, "assessmentId", 128);
  if (o.price8 !== null && !PRICE8.test(o.price8)) throw new TypeError("fomo store: price8 must be a decimal with at most 8 places");
  const args = [id, keyOf(o.horizonLabel, "horizonLabel", 32), tenant, intOf(o.observedAtMs, "observedAtMs"), o.price8, textOf(o.note, FOMO_LIMITS.reasonChars)];
  return db.tx(async (tx) => {
    const owns = await tx.prepare("SELECT id FROM fomo_assessments WHERE id = ? AND tenant = ?").get(id, tenant);
    if (owns === undefined || owns === null) return false;
    const row = await tx
      .prepare(
        `INSERT INTO fomo_outcomes (assessment_id, horizon_label, tenant, observed_at_ms, price8, note) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (assessment_id, horizon_label) DO UPDATE SET observed_at_ms = excluded.observed_at_ms,
           price8 = excluded.price8, note = excluded.note
         WHERE fomo_outcomes.tenant = excluded.tenant
         RETURNING assessment_id`,
      )
      .get(...args);
    return row !== undefined && row !== null;
  });
}

export async function outcomesFor(db: Db, tenant: string, assessmentId: string): Promise<AssessmentOutcome[]> {
  const rows = (await db
    .prepare(
      `SELECT assessment_id, horizon_label, observed_at_ms, price8, note FROM fomo_outcomes
        WHERE tenant = ? AND assessment_id = ? ORDER BY observed_at_ms, horizon_label`,
    )
    .all(tenantOf(tenant), keyOf(assessmentId, "assessmentId", 128))) as Row[];
  return rows.flatMap((r) => {
    const at = num(r.observed_at_ms);
    if (typeof r.assessment_id !== "string" || typeof r.horizon_label !== "string" || at === null) return [];
    const price = str(r.price8);
    return [{ assessmentId: r.assessment_id, horizonLabel: r.horizon_label, observedAtMs: at, price8: price && PRICE8.test(price) ? price : null, note: str(r.note) }];
  });
}

// ── decision funnel ─────────────────────────────────────────────────────────

export interface FunnelEntry {
  id: number;
  tokenKey: string;
  stage: FunnelStage;
  detail: string | null;
  decisionId: string | null;
  atMs: number;
}

export async function insertFunnel(
  db: Db,
  f: { tenant: string; tokenKey: string; stage: FunnelStage; detail: string | null; decisionId: string | null; atMs: number },
): Promise<number> {
  if (!isIn(FUNNEL_STAGES, f.stage)) throw new TypeError("fomo store: unknown funnel stage");
  const row = (await db
    .prepare("INSERT INTO fomo_funnel (tenant, token_key, stage, detail, decision_id, at_ms) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
    .get(tenantOf(f.tenant), keyOf(f.tokenKey, "tokenKey"), f.stage, textOf(f.detail, FOMO_LIMITS.reasonChars), optKey(f.decisionId, "decisionId", 128), intOf(f.atMs, "atMs"))) as Row;
  return Number(row.id);
}

/** Where one coin went for one owner, newest first. */
export async function funnelForToken(db: Db, tenant: string, tokenKey: string, limit: number): Promise<FunnelEntry[]> {
  const rows = (await db
    .prepare(
      `SELECT id, token_key, stage, detail, decision_id, at_ms FROM fomo_funnel
        WHERE tenant = ? AND token_key = ? ORDER BY at_ms DESC, id DESC LIMIT ?`,
    )
    .all(tenantOf(tenant), keyOf(tokenKey, "tokenKey"), pageOf(limit, 200))) as Row[];
  return rows.flatMap((r) => {
    const id = num(r.id);
    const at = num(r.at_ms);
    if (id === null || at === null || typeof r.token_key !== "string" || !isIn(FUNNEL_STAGES, r.stage)) return [];
    return [{ id, tokenKey: r.token_key, stage: r.stage, detail: str(r.detail), decisionId: str(r.decision_id), atMs: at }];
  });
}

/**
 * Where an owner's candidates stopped since `sinceMs`. `events` counts every
 * funnel row by stage; `latestByToken` counts each coin once, at the stage of
 * its most recent row (when that row is in the window), which is the honest
 * "where do my candidates die" view: one coin retried ten times is one coin.
 */
export async function funnelSummary(
  db: Db,
  tenant: string,
  sinceMs: number,
): Promise<{ events: Partial<Record<FunnelStage, number>>; latestByToken: Partial<Record<FunnelStage, number>> }> {
  const t = tenantOf(tenant);
  const since = intOf(sinceMs, "sinceMs");
  const tally = (rows: Row[]) => {
    const out: Partial<Record<FunnelStage, number>> = {};
    for (const r of rows) if (isIn(FUNNEL_STAGES, r.stage)) out[r.stage] = num(r.n) ?? 0;
    return out;
  };
  const events = (await db
    .prepare("SELECT stage, COUNT(*) AS n FROM fomo_funnel WHERE tenant = ? AND at_ms >= ? GROUP BY stage")
    .all(t, since)) as Row[];
  const latest = (await db
    .prepare(
      `SELECT f.stage AS stage, COUNT(*) AS n FROM fomo_funnel f
        WHERE f.tenant = ? AND f.at_ms >= ?
          AND f.id = (SELECT g.id FROM fomo_funnel g WHERE g.tenant = f.tenant AND g.token_key = f.token_key
                      ORDER BY g.at_ms DESC, g.id DESC LIMIT 1)
        GROUP BY f.stage`,
    )
    .all(t, since)) as Row[];
  return { events: tally(events), latestByToken: tally(latest) };
}

// ── retention ───────────────────────────────────────────────────────────────

export interface FomoRetentionPolicy {
  cacheMs: number;
  eventsMs: number;
  deadLettersMs: number;
  requestsMs: number;
  funnelMs: number;
  jobsMs: number;
  researchQueueMs: number;
  subjectsMs: number;
  expiredWatchesMs: number;
  /** An ended tail is kept this long (an end-of-tail summary reads it), then goes. */
  expiredTailsMs: number;
  usageDays: number;
  /** Measured trader evidence older than this is gone (the cohort re-measures within days). */
  traderEvidenceMs: number;
  /** A held set no replica has rewritten for this long describes a book nobody is acting for. */
  heldTokensMs: number;
  /** A route nobody has refreshed for this long belongs to an owner who left the fleet. */
  staleRoutesMs: number;
}

export const FOMO_RETENTION: Readonly<FomoRetentionPolicy> = {
  cacheMs: 7 * DAY_MS,
  eventsMs: 30 * DAY_MS,
  deadLettersMs: 14 * DAY_MS,
  requestsMs: 30 * DAY_MS,
  funnelMs: 90 * DAY_MS,
  jobsMs: 30 * DAY_MS,
  researchQueueMs: 7 * DAY_MS,
  subjectsMs: 30 * DAY_MS,
  expiredWatchesMs: 7 * DAY_MS,
  expiredTailsMs: DAY_MS,
  usageDays: 400,
  traderEvidenceMs: 30 * DAY_MS,
  heldTokensMs: 2 * DAY_MS,
  staleRoutesMs: 30 * DAY_MS,
};

/**
 * The retention DELETEs for one run, in order. Each filters on a time column
 * that leads an index of its own (or follows the equality column the statement
 * also filters on), so each is an index range scan, never a sequential scan
 * of the event log; store.test.ts checks every plan. Run each in its own short
 * statement so one slow table cannot hold another's locks.
 *
 * Not pruned here: traders and handle history (identity is kept), cohort
 * versions, dossiers and assessments (later answers cite them), publications
 * (the outbox is the audit trail), outcomes, capabilities, the budget
 * counters in fomo_meta (keyed by their own day or hour), and an owner's
 * durable `state:` subjects (FOMO_STATE_KEY_PREFIX).
 */
export function fomoRetentionStatements(nowMs: number, policy: FomoRetentionPolicy = FOMO_RETENTION): Array<[string, unknown[]]> {
  const now = intOf(nowMs, "nowMs");
  const eventsBefore = now - policy.eventsMs;
  return [
    // Two statements, one index each, rather than an OR the planner may not split.
    ["DELETE FROM fomo_cache WHERE retrieved_at_ms < ?", [now - policy.cacheMs]],
    ["DELETE FROM fomo_cache WHERE retrieved_at_ms IS NULL AND last_attempt_at_ms < ?", [now - policy.cacheMs]],
    ["DELETE FROM fomo_events WHERE observed_at_ms < ?", [eventsBefore]],
    // A gap that ends before the oldest event kept describes data already gone.
    ["DELETE FROM fomo_coverage_gaps WHERE to_ms < ?", [eventsBefore]],
    ["DELETE FROM fomo_dead_letters WHERE at_ms < ?", [now - policy.deadLettersMs]],
    ["DELETE FROM fomo_requests WHERE created_at_ms < ?", [now - policy.requestsMs]],
    ["DELETE FROM fomo_funnel WHERE at_ms < ?", [now - policy.funnelMs]],
    ["DELETE FROM fomo_jobs WHERE status IN ('done', 'failed', 'cancelled') AND created_at_ms < ?", [now - policy.jobsMs]],
    // A claimed row is somebody's live work; it goes once it is finished or lapses to failed.
    ["DELETE FROM fomo_research_queue WHERE requested_at_ms < ? AND state <> 'claimed'", [now - policy.researchQueueMs]],
    // A conversation's memory ages out; a child's durable state (key prefix
    // FOMO_STATE_KEY_PREFIX, e.g. its exploration ledger) is not a
    // conversation and is never pruned here. substr, not LIKE: sqlite's LIKE
    // ignores case, and only the exact prefix is state.
    [
      `DELETE FROM fomo_subjects WHERE updated_at_ms < ? AND substr(conversation_key, 1, ${FOMO_STATE_KEY_PREFIX.length}) <> '${FOMO_STATE_KEY_PREFIX}'`,
      [now - policy.subjectsMs],
    ],
    ["DELETE FROM fomo_watches WHERE expires_at_ms < ?", [now - policy.expiredWatchesMs]],
    ["DELETE FROM fomo_tails WHERE expires_at_ms < ?", [now - policy.expiredTailsMs]],
    ["DELETE FROM fomo_position_deps WHERE expires_at_ms < ?", [now]],
    ["DELETE FROM fomo_usage WHERE day < ?", [usageDay(Math.max(0, now - policy.usageDays * DAY_MS))]],
    ["DELETE FROM fomo_trader_evidence WHERE measured_at_ms < ?", [now - policy.traderEvidenceMs]],
    ["DELETE FROM fomo_held_tokens WHERE updated_at_ms < ?", [now - policy.heldTokensMs]],
    // Already routing nothing (routedTenants' freshness rule); this only stops the table growing.
    ["DELETE FROM fomo_tenant_routes WHERE updated_at_ms < ?", [now - policy.staleRoutesMs]],
  ];
}

/** Run the retention statements; returns rows deleted per statement, in order. */
export async function pruneFomo(db: Db, nowMs: number, policy: FomoRetentionPolicy = FOMO_RETENTION): Promise<number[]> {
  const out: number[] = [];
  for (const [sql, params] of fomoRetentionStatements(nowMs, policy)) out.push((await db.prepare(sql).run(...params)).changes);
  return out;
}
