/**
 * SHARED INGESTION — where a provider event becomes a durable fact and, at
 * most once, a reason for a tenant to look at a coin.
 *
 * PERSIST FIRST, THEN ROUTE ONLY WHAT WAS NEW. The same event reaches us live,
 * again in the stream's replay on every reconnect and subscribe, again through
 * REST recovery, and again after a restart re-reads the same window. The
 * store's unique event key (events.ts) is the only arbiter of "new": every
 * normalised event is inserted before anything else happens, and only the
 * keys the store reports as NEWLY inserted are routed or coalesced. An
 * in-memory "seen" set would protect one process and fail across a restart or
 * a second replica, which is exactly when replays arrive.
 *
 * A crash between the insert and the routing is the one window this cannot
 * close by itself. With the store's optional routing outbox (markProcessed /
 * unprocessedEvents) the next process routes those events once, and only a
 * crash in the instant between routing and marking can repeat one. Without
 * the outbox the routing is lost rather than repeated: research is on the
 * PROPOSE side, and the harmful failure is a duplicate task, decision or
 * post, not a missed nudge the next event on the same coin will raise again.
 *
 * THE RESUME POINT. The provider's REST fallback pages newest-first and offers
 * an opaque cursor that returns only events STRICTLY newer than it. Stream
 * frames carry no cursor and the provider says never to build one, so:
 *
 *   after a completed REST recovery   checkpoint = (that walk's newest cursor, newest ts)
 *   after live progress               checkpoint = (no cursor, newest ts)
 *
 * and recovery resumes from the cursor when there is one, otherwise from an
 * INCLUSIVE `since` a little before the newest ts we hold. Inclusive re-delivers
 * the boundary bucket (timestamps are quantised to five seconds and shared by
 * several events), and that is harmless here because the store deduplicates;
 * the overlap covers frames delivered out of order around a disconnect. The
 * checkpoint moves only after the events behind it are persisted, and never
 * backwards.
 *
 * GAPS ARE WRITTEN DOWN, NEVER PAPERED OVER. Recovery is bounded: by a page
 * budget, by the provider's ring of recent history, and by the provider being
 * up. When a walk cannot reach its resume point the shortfall is recorded as a
 * gap that stays open and visible; nothing here ever reports completeness it
 * did not achieve. Retryable gaps (backpressure, a failed recovery, a failed
 * insert) are folded into the next recovery's floor and closed only when a
 * walk reaches that floor, or when everything they covered is either
 * persisted or inside an unrecoverable gap that has itself been recorded.
 *
 * THE PROVIDER'S TEXT IS DATA. Thesis, handle and token text arrives already
 * sanitised by the injected normaliser and is carried, never interpreted; a
 * task says only which coin and which events, never what anybody wrote.
 */

import { createHash } from "node:crypto";
import { sanitizeText } from "../research/news";
import { dedupeEvents } from "./events";
import { isRobinhoodToken } from "./identity";
import type { ClockPort, StreamDeadLetter, StreamFrameMeta, StreamGap, StreamState, StreamStateDetail, TimerPort } from "./stream";
import type { EventSource, FomoHealthState, RetrievalPriority, TraderEvent } from "./types";

type Awaitable<T> = T | Promise<T>;

// ── Ports ─────────────────────────────────────────────────────────────────

/** What the injected normaliser may return for one raw frame or REST item. */
export type NormalizedFrame = TraderEvent | { retract: string } | null;

export type NormalizePort = (frame: unknown, observedAt: number, source: EventSource) => NormalizedFrame;

export interface IngestCheckpoint {
  /** Provider resume cursor (strictly newer). Null after live progress moved past it. */
  cursor: string | null;
  /** Newest source event time persisted for this stream. */
  newestTsMs: number | null;
}

/** Stores number their rows; either form is carried as given. */
export type GapId = string | number;

export interface IngestGap {
  id: GapId;
  fromMs: number;
  toMs: number;
  reason: string;
}

/** Result of marking an event retracted. A bare boolean (newly retracted) is also accepted. */
export interface RetractOutcome {
  newlyRetracted: boolean;
  /** The retracted event's token, when the store knows it. */
  tokenKey: string | null;
}

export interface IngestStorePort {
  /** Insert, deduplicating on eventKey. Returns ONLY the keys that were newly inserted. */
  insertEvents(events: readonly TraderEvent[]): Awaitable<readonly string[]>;
  markRetracted(eventKey: string): Awaitable<RetractOutcome | boolean | void>;
  getCheckpoint(stream: string): Awaitable<IngestCheckpoint | null>;
  /** Monotonic in newestTsMs. May return false when the store refused the write. */
  setCheckpoint(stream: string, cursor: string | null, newestTsMs: number | null): Awaitable<void | boolean>;
  recordGap(stream: string, fromMs: number, toMs: number, reason: string): Awaitable<GapId>;
  listOpenGaps(stream: string): Awaitable<readonly IngestGap[]>;
  markGapRecovered(id: GapId): Awaitable<unknown>;
  deadLetter(stream: string, payload: string, error: string): Awaitable<unknown>;
  /**
   * Optional routing outbox. When present, every event whose routing decision
   * was made is marked, and on the first recovery of a process the events a
   * previous process persisted but never routed (it died between the insert
   * and the routing) are routed once. Without it, that crash window loses the
   * routing rather than repeating it.
   */
  markProcessed?(eventKeys: readonly string[]): Awaitable<unknown>;
  unprocessedEvents?(limit: number): Awaitable<ReadonlyArray<TraderEvent & { retracted?: boolean }>>;
}

/**
 * One REST recovery request. `cursor` is strictly-newer, `since` (ms) is
 * inclusive, `before` walks back past a full page while keeping the floor.
 */
export interface RecoverRequest {
  cursor?: string;
  since?: number;
  before?: string;
}

export type RecoverPage =
  | {
      ok: true;
      /** Raw provider items, each normalised as source `rest-recovery`, unless `normalized`. */
      events: readonly unknown[];
      /** True when `events` are already TraderEvents (the provider client's own reader). */
      normalized?: boolean;
      nextCursor: string | null;
      /** Cursor of the oldest item on this page; required to continue when hasMore. */
      oldestCursor?: string | null;
      /** Null when the provider did not say: a non-empty page is then NOT proof of completeness. */
      hasMore: boolean | null;
      newestTs: number | null;
      oldestTs: number | null;
    }
  | { ok: false; reason: string };

export type RecoverPort = (req: RecoverRequest) => Promise<RecoverPage>;

/** Who cares about what, right now. Tenants in these maps are already opted in. */
export interface InterestSnapshot {
  cohort: ReadonlySet<string>;
  dependencies: ReadonlySet<string>;
  watchedTokens: ReadonlyMap<string, readonly string[]>;
  heldTokens: ReadonlyMap<string, readonly string[]>;
  monitoringTenants: readonly string[];
}

export type InterestReason = "held" | "watched" | "cohort" | "dependency" | "robinhood-thesis";

export interface RoutedItem {
  kind: "event" | "correction";
  eventKey: string;
  tokenKey: string | null;
  priority: RetrievalPriority;
  reasons: InterestReason[];
  routedAt: number;
  /** The event for `event` items; null for corrections (the key is enough to find it). */
  event: TraderEvent | null;
}

export interface ResearchTask {
  kind: "research" | "correction";
  tokenKey: string;
  /** Short hash of the sorted event keys: same evidence, same revision. */
  evidenceRev: string;
  priority: RetrievalPriority;
  /** Highest priority first, then by name. */
  tenants: string[];
  eventKeys: string[];
  windowStartedAt: number;
  createdAt: number;
}

export interface IngestConfig {
  coalesceWindowMs: number;
  /** A bucket that touches a held position flushes this soon, inside the normal window. */
  protectionCoalesceMs: number;
  maxRecoveryPages: number;
  /**
   * Reconnect-triggered recoveries closer together than this are deferred and
   * coalesced. Each recovery costs at least one billed page; a flapping
   * server must not turn into a credit drain. Deferral is safe because the
   * checkpoint stays held at the pre-outage floor until a recovery reads it.
   */
  minRecoveryIntervalMs: number;
  /**
   * How far back the provider's REST ring is assumed to reach. Not documented
   * as a duration (the ring is sized in events); a conservative guess that an
   * operator can raise once measured.
   */
  ringRetentionMs: number;
  /** Overlap behind the newest persisted ts when resuming without a cursor. */
  resumeOverlapMs: number;
  discoveryPerMinute: number;
  recoveryRetryBaseMs: number;
  recoveryRetryCapMs: number;
  /** health(): a connected stream with no frame for this long is not "fresh". */
  freshFrameMs: number;
  /** Recently routed events remembered for corrections and task dedupe. */
  recentMemory: number;
  maxPendingTokens: number;
}

export const INGEST_DEFAULTS: IngestConfig = {
  coalesceWindowMs: 60_000,
  protectionCoalesceMs: 5_000,
  maxRecoveryPages: 10,
  minRecoveryIntervalMs: 30_000,
  ringRetentionMs: 6 * 60 * 60_000,
  resumeOverlapMs: 60_000,
  discoveryPerMinute: 20,
  recoveryRetryBaseMs: 60_000,
  recoveryRetryCapMs: 15 * 60_000,
  freshFrameMs: 90_000,
  recentMemory: 10_000,
  maxPendingTokens: 2_000,
};

export interface IngestorDeps {
  /** Checkpoint and gap namespace. One per provider stream. */
  streamName?: string;
  normalize: NormalizePort;
  store: IngestStorePort;
  recover: RecoverPort;
  interest: () => InterestSnapshot;
  route: (tenant: string, item: RoutedItem) => void;
  onResearchTask: (task: ResearchTask) => void;
  clock: ClockPort;
  timers: TimerPort;
  /** Optional live view of the stream's queue and liveness for health(). */
  streamStats?: () => { queueDepth: number; oldestQueuedAt: number | null; lastFrameAt: number | null };
  config?: Partial<IngestConfig>;
}

export interface DelayStats {
  n: number;
  last: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface IngestHealth {
  state: FomoHealthState;
  streamState: StreamState | "idle";
  connected: boolean;
  lastFrameAt: number | null;
  /** Newest source event time persisted. */
  lastEventAt: number | null;
  openGaps: number;
  unrecoverableGaps: number;
  deadLetters: number;
  queueDepth: number;
  oldestQueuedAgeMs: number | null;
  dropped: Record<string, number>;
  duplicates: number;
  persisted: number;
  retracted: number;
  tasksEmitted: number;
  /** Events a previous process persisted but never routed, routed by this one. */
  orphansRouted: number;
  realtime: boolean | null;
  delaySeconds: number | null;
  recovery: { running: boolean; lastStatus: RecoveryStatus | null; lastAt: number | null; lastReason: string | null };
  metrics: { sourceDelayMs: DelayStats; ingestionDelayMs: DelayStats; queueAgeMs: DelayStats };
}

export type RecoveryStatus = "complete" | "truncated" | "failed" | "no-checkpoint" | "stopped";

export interface RecoveryReport {
  trigger: string;
  status: RecoveryStatus;
  floor: { mode: "cursor" | "since"; sinceMs: number | null } | null;
  pages: number;
  fetched: number;
  persisted: number;
  gapsRecorded: GapId[];
  gapsRecovered: GapId[];
  reason: string | null;
  startedAt: number;
  finishedAt: number;
}

export interface Ingestor {
  handleFrame(frame: unknown, meta: StreamFrameMeta): Promise<void>;
  handleGap(gap: StreamGap): Promise<void>;
  handleDeadLetter(dl: StreamDeadLetter): Promise<void>;
  /** Starts recovery once per connection, on its first "open". */
  handleState(state: StreamState, detail: StreamStateDetail): void;
  /** Ready-made AlertStream callbacks. */
  streamCallbacks(): {
    onFrame: (frame: unknown, meta: StreamFrameMeta) => Promise<void>;
    onGap: (gap: StreamGap) => Promise<void>;
    onDeadLetter: (dl: StreamDeadLetter) => Promise<void>;
    onState: (state: StreamState, detail: StreamStateDetail) => void;
  };
  recoverNow(trigger?: string): Promise<RecoveryReport>;
  /** Emit every pending coalesced task now. */
  flush(): void;
  /** Flush (by default), cancel timers and refuse further work. */
  stop(options?: { flush?: boolean }): void;
  /** Resolves when all in-flight frame handling and recovery has settled. */
  idle(): Promise<void>;
  health(): IngestHealth;
}

// ── Gap reasons ───────────────────────────────────────────────────────────

export const GAP_REASONS = {
  backpressure: "stream-backpressure",
  persistFailed: "persist-failed",
  recoveryFailed: "recovery-failed",
  pageCap: "unrecoverable:page-cap",
  noOldestCursor: "unrecoverable:no-oldest-cursor",
  beyondRetention: "unrecoverable:beyond-ring-retention",
} as const;

/** Unrecoverable gaps are never retried and never closed by this module. */
export function isUnrecoverableGap(reason: string): boolean {
  return reason.startsWith("unrecoverable:");
}

// ── Pure helpers ──────────────────────────────────────────────────────────

const PRIORITY_RANK: Record<RetrievalPriority, number> = { "position-protection": 0, interactive: 1, discovery: 2 };

export function higherPriority(a: RetrievalPriority, b: RetrievalPriority): RetrievalPriority {
  return PRIORITY_RANK[a] <= PRIORITY_RANK[b] ? a : b;
}

/** Short, order-independent revision id for a set of event keys. */
export function evidenceRevOf(eventKeys: Iterable<string>): string {
  const sorted = [...new Set(eventKeys)].sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 16);
}

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function errText(err: unknown): string {
  return sanitizeText(err instanceof Error ? `${err.name}: ${err.message}` : typeof err === "string" ? err : "unknown error", 160);
}

function cleanCursor(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 && s.length <= 256 && /^[\x21-\x7e]+$/.test(s) ? s : null;
}

function isRetract(n: Exclude<NormalizedFrame, null>): n is { retract: string } {
  return typeof (n as { retract?: unknown }).retract === "string";
}

/** A cheap structural check on an event a trusted reader says it already normalised. */
function looksLikeEvent(v: unknown): v is TraderEvent {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Partial<TraderEvent>;
  return typeof e.eventKey === "string" && e.eventKey.length > 0 && typeof e.observedAt === "number" && typeof e.trader === "object" && e.trader !== null && typeof e.kind === "string";
}

function safeJson(v: unknown, max: number): string {
  try {
    const s = JSON.stringify(v);
    return sanitizeText(typeof s === "string" ? s : String(v), max);
  } catch {
    return "";
  }
}

function orderTenants(m: ReadonlyMap<string, RetrievalPriority>): string[] {
  return [...m.entries()].sort((a, b) => PRIORITY_RANK[a[1]] - PRIORITY_RANK[b[1]] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([t]) => t);
}

function maxPriorityOf(m: ReadonlyMap<string, RetrievalPriority>): RetrievalPriority {
  let p: RetrievalPriority = "discovery";
  for (const v of m.values()) p = higherPriority(p, v);
  return p;
}

class DelayRing {
  private xs: number[] = [];
  private i = 0;
  private n = 0;
  private last: number | null = null;
  constructor(private readonly cap = 512) {}
  add(v: number): void {
    if (!Number.isFinite(v)) return;
    if (this.xs.length < this.cap) this.xs.push(v);
    else {
      this.xs[this.i] = v;
      this.i = (this.i + 1) % this.cap;
    }
    this.n++;
    this.last = v;
  }
  snapshot(): DelayStats {
    if (this.xs.length === 0) return { n: 0, last: null, p50: null, p95: null, max: null };
    const s = [...this.xs].sort((a, b) => a - b);
    const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? null;
    return { n: this.n, last: this.last, p50: at(0.5), p95: at(0.95), max: s[s.length - 1] ?? null };
  }
}

/** Insertion-ordered map that forgets its oldest entries past a bound. */
class BoundedMap<K, V> {
  private readonly m = new Map<K, V>();
  constructor(private readonly cap: number) {}
  get(k: K): V | undefined {
    return this.m.get(k);
  }
  has(k: K): boolean {
    return this.m.has(k);
  }
  set(k: K, v: V): void {
    this.m.delete(k);
    this.m.set(k, v);
    while (this.m.size > this.cap) {
      const oldest = this.m.keys().next();
      if (oldest.done) break;
      this.m.delete(oldest.value);
    }
  }
}

interface Bucket {
  tokenKey: string;
  openedAt: number;
  deadline: number;
  protection: boolean;
  /** Event key → the audience it brought, so a retracted event takes its audience with it. */
  byKey: Map<string, ReadonlyMap<string, RetrievalPriority>>;
  timer: unknown;
}

interface Audience {
  tenants: Map<string, RetrievalPriority>;
  reasons: Map<string, InterestReason[]>;
}

interface RecentRouted {
  tokenKey: string | null;
  tenants: Array<[string, RetrievalPriority]>;
}

// ── The ingestor ──────────────────────────────────────────────────────────

class IngestorImpl implements Ingestor {
  private readonly name: string;
  private readonly cfg: IngestConfig;
  private stopped = false;

  private streamState: StreamState | "idle" = "idle";
  private connected = false;
  private connectedAt: number | null = null;
  private lastRecoveredConnection: number | null = null;
  private realtime: boolean | null = null;
  private delaySeconds: number | null = null;
  private lastDataFrameAt: number | null = null;
  private lastEventAt: number | null = null;

  /** Cached checkpoint; this ingestor is the only writer for its stream (fleet singleton lease). */
  private cp: IngestCheckpoint | null | undefined = undefined;
  private lockTail: Promise<unknown> = Promise.resolve();
  /**
   * Live progress is held back from the checkpoint from the moment a new
   * socket starts connecting (and at process start) until that connection's
   * recovery has read its resume point. Otherwise a replayed or early frame
   * of the new connection could move the checkpoint past the outage before
   * recovery looked at it. Held progress is applied afterwards, never lost.
   */
  private checkpointHeld = true;
  private heldMaxTs: number | null = null;
  /** Bumped on every new connection; only a recovery started after it may release the hold. */
  private holdEpoch = 0;

  private openGaps = new Map<GapId, IngestGap>();
  /** Events observed before this ingestor existed and never marked routed are a previous process's. */
  private readonly constructedAt: number;
  private orphansChecked = false;
  /** Gaps the store refused to record; kept, counted, and retried before the next recovery. */
  private unrecordedGaps: Array<Omit<IngestGap, "id">> = [];

  private inflight: Promise<RecoveryReport> | null = null;
  private rerun = false;
  private retryTimer: unknown = null;
  private retryAttempt = 0;
  private deferredTimer: unknown = null;
  private lastRecoveryStartedAt: number | null = null;
  private lastRecovery: { status: RecoveryStatus; at: number; reason: string | null } | null = null;

  private buckets = new Map<string, Bucket>();
  private emittedTasks: BoundedMap<string, true>;
  private recent: BoundedMap<string, RecentRouted>;
  private discoveryTimes: number[] = [];

  private pending = new Set<Promise<unknown>>();
  private counters = { duplicates: 0, persisted: 0, retracted: 0, tasksEmitted: 0, deadLetters: 0, orphansRouted: 0 };
  private dropped: Record<string, number> = {};
  private sourceDelay = new DelayRing();
  private ingestionDelay = new DelayRing();
  private queueAge = new DelayRing();

  constructor(private readonly d: IngestorDeps) {
    this.name = d.streamName ?? "alerts";
    this.constructedAt = d.clock.now();
    const c = { ...INGEST_DEFAULTS, ...(d.config ?? {}) };
    const pos = (v: number, dflt: number) => (Number.isFinite(v) && v > 0 ? v : dflt);
    this.cfg = {
      coalesceWindowMs: pos(c.coalesceWindowMs, INGEST_DEFAULTS.coalesceWindowMs),
      protectionCoalesceMs: pos(c.protectionCoalesceMs, INGEST_DEFAULTS.protectionCoalesceMs),
      maxRecoveryPages: Math.max(1, Math.floor(pos(c.maxRecoveryPages, INGEST_DEFAULTS.maxRecoveryPages))),
      minRecoveryIntervalMs: Number.isFinite(c.minRecoveryIntervalMs) && c.minRecoveryIntervalMs >= 0 ? c.minRecoveryIntervalMs : INGEST_DEFAULTS.minRecoveryIntervalMs,
      ringRetentionMs: pos(c.ringRetentionMs, INGEST_DEFAULTS.ringRetentionMs),
      resumeOverlapMs: Number.isFinite(c.resumeOverlapMs) && c.resumeOverlapMs >= 0 ? c.resumeOverlapMs : INGEST_DEFAULTS.resumeOverlapMs,
      discoveryPerMinute: Number.isFinite(c.discoveryPerMinute) && c.discoveryPerMinute >= 0 ? Math.floor(c.discoveryPerMinute) : INGEST_DEFAULTS.discoveryPerMinute,
      recoveryRetryBaseMs: pos(c.recoveryRetryBaseMs, INGEST_DEFAULTS.recoveryRetryBaseMs),
      recoveryRetryCapMs: pos(c.recoveryRetryCapMs, INGEST_DEFAULTS.recoveryRetryCapMs),
      freshFrameMs: pos(c.freshFrameMs, INGEST_DEFAULTS.freshFrameMs),
      recentMemory: Math.floor(pos(c.recentMemory, INGEST_DEFAULTS.recentMemory)),
      maxPendingTokens: Math.floor(pos(c.maxPendingTokens, INGEST_DEFAULTS.maxPendingTokens)),
    };
    this.emittedTasks = new BoundedMap(this.cfg.recentMemory);
    this.recent = new BoundedMap(this.cfg.recentMemory);
  }

  private now(): number {
    return this.d.clock.now();
  }

  private drop(reason: string, n = 1): void {
    this.dropped[reason] = (this.dropped[reason] ?? 0) + n;
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    const done = () => this.pending.delete(p);
    p.then(done, done);
    return p;
  }

  /**
   * Serialises checkpoint reads and writes. The callback is chained
   * SYNCHRONOUSLY, so a recovery that asks for the lock before the first live
   * frame of a new connection reads the resume point before that frame can
   * move it.
   */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lockTail.then(fn, fn);
    this.lockTail = run.catch(() => undefined);
    return run;
  }

  // ── Stream callbacks ───────────────────────────────────────────────────

  streamCallbacks() {
    return {
      onFrame: (frame: unknown, meta: StreamFrameMeta) => this.handleFrame(frame, meta),
      onGap: (gap: StreamGap) => this.handleGap(gap),
      onDeadLetter: (dl: StreamDeadLetter) => this.handleDeadLetter(dl),
      onState: (state: StreamState, detail: StreamStateDetail) => this.handleState(state, detail),
    };
  }

  handleState(state: StreamState, detail: StreamStateDetail): void {
    this.streamState = state;
    if (state === "connecting") {
      this.checkpointHeld = true;
      this.holdEpoch++;
    }
    if (state !== "open") {
      this.connected = false;
      return;
    }
    this.connected = true;
    this.connectedAt = this.now();
    this.realtime = typeof detail.realtime === "boolean" ? detail.realtime : null;
    this.delaySeconds = finite(detail.delaySeconds) ?? null;
    if (detail.connection === this.lastRecoveredConnection) return;
    this.lastRecoveredConnection = detail.connection;
    this.requestRecovery("reconnect");
  }

  private requestRecovery(trigger: string): void {
    const last = this.lastRecoveryStartedAt;
    const wait = last === null ? 0 : last + this.cfg.minRecoveryIntervalMs - this.now();
    if (wait <= 0) {
      void this.recoverNow(trigger);
      return;
    }
    if (this.deferredTimer !== null) return;
    this.deferredTimer = this.d.timers.setTimeout(() => {
      this.deferredTimer = null;
      if (!this.stopped) void this.recoverNow(trigger);
    }, wait);
  }

  handleFrame(frame: unknown, meta: StreamFrameMeta): Promise<void> {
    return this.track(this.processFrame(frame, meta));
  }

  private async processFrame(frame: unknown, meta: StreamFrameMeta): Promise<void> {
    if (this.stopped) {
      this.drop("after-stop");
      return;
    }
    const startedAt = this.now();
    const receivedAt = finite(meta.receivedAt) ?? startedAt;
    this.lastDataFrameAt = receivedAt;
    this.queueAge.add(startedAt - receivedAt);

    let n: NormalizedFrame;
    try {
      n = this.d.normalize(frame, receivedAt, "stream");
    } catch (err) {
      this.drop("normalize-error");
      await this.deadLetter(safeJson(frame, 2_048), `normalize-threw: ${errText(err)}`);
      return;
    }
    if (n === null) {
      this.drop("normalize-null");
      return;
    }
    if (isRetract(n)) {
      await this.handleRetract(n.retract);
      return;
    }
    const ev: TraderEvent = meta.replay && !n.replay ? { ...n, replay: true } : n;

    let result: { fresh: TraderEvent[]; maxTs: number | null };
    try {
      result = await this.persist([ev], { live: !ev.replay });
    } catch (err) {
      // The event is not durable, so it must not be routed, and the time it
      // covers is now a hole for REST recovery to fill.
      this.drop("persist-failed");
      await this.deadLetter(safeJson(frame, 2_048), `persist-failed: ${errText(err)}`);
      const from = finite(ev.sourceEventAt) ?? receivedAt;
      await this.recordGap(Math.min(from, this.now()), this.now(), GAP_REASONS.persistFailed);
      this.scheduleRecoveryRetry();
      return;
    }
    if (result.maxTs !== null) await this.advanceLiveCheckpoint(result.maxTs);
    this.routeFresh(result.fresh);
  }

  async handleGap(gap: StreamGap): Promise<void> {
    const from = finite(gap.fromMs);
    const to = finite(gap.toMs);
    if (from === null || to === null) {
      this.drop("gap-malformed");
      return;
    }
    const reason = sanitizeText(gap.reason, 64) || GAP_REASONS.backpressure;
    // A stream may report a hole; it may not declare one unrecoverable on our behalf.
    await this.recordGap(Math.min(from, to), Math.max(from, to), isUnrecoverableGap(reason) ? GAP_REASONS.backpressure : reason);
  }

  async handleDeadLetter(dl: StreamDeadLetter): Promise<void> {
    await this.deadLetter(sanitizeText(dl.payload, 2_048), sanitizeText(dl.error, 200));
  }

  private async deadLetter(payload: string, error: string): Promise<void> {
    this.counters.deadLetters++;
    try {
      await this.d.store.deadLetter(this.name, payload, error);
    } catch {
      this.drop("dead-letter-store-failed");
    }
  }

  // ── Persistence and checkpoint ─────────────────────────────────────────

  /** Insert, then report which events were NEW. Throws when the store does. */
  private async persist(events: readonly TraderEvent[], opts: { live: boolean }): Promise<{ fresh: TraderEvent[]; maxTs: number | null }> {
    if (events.length === 0) return { fresh: [], maxTs: null };
    const { events: unique, duplicates } = dedupeEvents(events);
    this.counters.duplicates += duplicates;
    const inserted = await this.d.store.insertEvents(unique);
    const persistedAt = this.now();
    const insertedKeys = new Set(inserted);
    const fresh = unique.filter((e) => insertedKeys.has(e.eventKey));
    this.counters.duplicates += unique.length - fresh.length;
    this.counters.persisted += fresh.length;
    let maxTs: number | null = null;
    for (const e of unique) {
      const ts = finite(e.sourceEventAt);
      if (ts !== null && (maxTs === null || ts > maxTs)) maxTs = ts;
    }
    if (maxTs !== null && (this.lastEventAt === null || maxTs > this.lastEventAt)) this.lastEventAt = maxTs;
    for (const e of fresh) {
      this.ingestionDelay.add(persistedAt - e.observedAt);
      // Replays and recovered rows would measure our outage, not the provider's delay.
      const ts = finite(e.sourceEventAt);
      if (opts.live && !e.replay && ts !== null) this.sourceDelay.add(e.observedAt - ts);
    }
    return { fresh, maxTs };
  }

  private async currentCheckpoint(): Promise<IngestCheckpoint | null> {
    if (this.cp === undefined) {
      const raw = await this.d.store.getCheckpoint(this.name);
      this.cp = raw ? { cursor: cleanCursor(raw.cursor), newestTsMs: finite(raw.newestTsMs) } : null;
    }
    return this.cp;
  }

  private advanceLiveCheckpoint(maxTs: number): Promise<void> {
    if (this.checkpointHeld) {
      this.heldMaxTs = this.heldMaxTs === null ? maxTs : Math.max(this.heldMaxTs, maxTs);
      return Promise.resolve();
    }
    return this.withLock(async () => {
      try {
        const cur = await this.currentCheckpoint();
        if (cur && cur.newestTsMs !== null && maxTs <= cur.newestTsMs) return;
        const ok = await this.d.store.setCheckpoint(this.name, null, maxTs);
        this.cp = ok === false ? undefined : { cursor: null, newestTsMs: maxTs };
      } catch {
        // The events are persisted; a stale checkpoint only widens the next recovery.
        this.cp = undefined;
        this.drop("checkpoint-write-failed");
      }
    });
  }

  private releaseCheckpoint(epoch: number): void {
    if (!this.checkpointHeld || epoch !== this.holdEpoch) return;
    this.checkpointHeld = false;
    const held = this.heldMaxTs;
    this.heldMaxTs = null;
    if (held !== null) void this.track(this.advanceLiveCheckpoint(held));
  }

  /**
   * After a walk that reached its floor. A stored cursor always sits exactly
   * at `newestTsMs`: when live frames have already moved past what the walk
   * read, out-of-order delivery may have left holes behind them that only an
   * inclusive `since` with overlap would revisit, so the cursor is dropped.
   */
  private completeCheckpoint(cursor: string | null, newestTs: number | null): Promise<void> {
    return this.withLock(async () => {
      try {
        const cur = await this.currentCheckpoint();
        const curTs = cur?.newestTsMs ?? null;
        let nextCursor: string | null;
        let ts: number | null;
        if (newestTs === null) {
          nextCursor = cur?.cursor ?? null;
          ts = curTs;
        } else if (curTs !== null && curTs > newestTs) {
          nextCursor = null;
          ts = curTs;
        } else {
          nextCursor = cursor;
          ts = newestTs;
        }
        if (cur && cur.cursor === nextCursor && cur.newestTsMs === ts) return;
        const ok = await this.d.store.setCheckpoint(this.name, nextCursor, ts);
        this.cp = ok === false ? undefined : { cursor: nextCursor, newestTsMs: ts };
      } catch {
        this.cp = undefined;
        this.drop("checkpoint-write-failed");
      }
    });
  }

  // ── Gaps ───────────────────────────────────────────────────────────────

  private async recordGap(fromMs: number, toMs: number, reason: string): Promise<GapId | null> {
    try {
      const id = await this.d.store.recordGap(this.name, fromMs, toMs, reason);
      this.openGaps.set(id, { id, fromMs, toMs, reason });
      return id;
    } catch {
      this.unrecordedGaps.push({ fromMs, toMs, reason });
      this.drop("gap-record-failed");
      return null;
    }
  }

  private async retryUnrecordedGaps(): Promise<void> {
    const queued = this.unrecordedGaps;
    this.unrecordedGaps = [];
    for (const g of queued) {
      try {
        const id = await this.d.store.recordGap(this.name, g.fromMs, g.toMs, g.reason);
        this.openGaps.set(id, { id, ...g });
      } catch {
        this.unrecordedGaps.push(g);
      }
    }
  }

  private async closeGaps(gaps: readonly IngestGap[], report: RecoveryReport): Promise<void> {
    for (const g of gaps) {
      try {
        await this.d.store.markGapRecovered(g.id);
        this.openGaps.delete(g.id);
        report.gapsRecovered.push(g.id);
      } catch {
        this.drop("gap-close-failed");
      }
    }
  }

  // ── Recovery ───────────────────────────────────────────────────────────

  recoverNow(trigger = "manual"): Promise<RecoveryReport> {
    if (this.inflight) {
      this.rerun = true;
      return this.inflight;
    }
    const run = this.runRecovery(trigger).finally(() => {
      this.inflight = null;
      if (this.rerun && !this.stopped) {
        this.rerun = false;
        void this.recoverNow("rerun");
      }
    });
    this.inflight = run;
    return this.track(run);
  }

  private async runRecovery(trigger: string): Promise<RecoveryReport> {
    // Queue the read of the resume point before anything else can await.
    const snapshotP = this.withLock(async () => {
      // Always re-read: recovery is rare, and an operator may have reset the row.
      this.cp = undefined;
      const cp = await this.currentCheckpoint();
      const gaps = await this.d.store.listOpenGaps(this.name);
      return { cp, gaps };
    });
    // Once the resume point is read, held live progress may move the checkpoint
    // (unless a newer connection began meanwhile: its own recovery releases it).
    const epoch = this.holdEpoch;
    void snapshotP.then(
      () => this.releaseCheckpoint(epoch),
      () => undefined,
    );
    const startedAt = this.now();
    this.lastRecoveryStartedAt = startedAt;
    const report: RecoveryReport = {
      trigger,
      status: "complete",
      floor: null,
      pages: 0,
      fetched: 0,
      persisted: 0,
      gapsRecorded: [],
      gapsRecovered: [],
      reason: null,
      startedAt,
      finishedAt: startedAt,
    };
    const finish = (status: RecoveryStatus, reason: string | null): RecoveryReport => {
      report.status = status;
      report.reason = reason;
      report.finishedAt = this.now();
      this.lastRecovery = { status, at: report.finishedAt, reason };
      return report;
    };
    if (this.stopped) return finish("stopped", null);
    this.cancelRecoveryRetry();

    let snapshot: { cp: IngestCheckpoint | null; gaps: readonly IngestGap[] };
    try {
      snapshot = await snapshotP;
    } catch (err) {
      this.cp = undefined;
      this.scheduleRecoveryRetry();
      return finish("failed", `store-unavailable: ${errText(err)}`);
    }
    await this.retryUnrecordedGaps();
    await this.routeOrphans();
    this.openGaps = new Map(snapshot.gaps.map((g) => [g.id, g]));
    const retryable = snapshot.gaps.filter((g) => !isUnrecoverableGap(g.reason) && finite(g.fromMs) !== null);
    const gapFloor = retryable.length > 0 ? Math.min(...retryable.map((g) => g.fromMs)) : null;
    const cp = snapshot.cp;
    const cpTs = cp?.newestTsMs ?? null;

    if (!cp?.cursor && cpTs === null && gapFloor === null) return finish("no-checkpoint", null);

    // Resume from the cursor only when no open gap reaches further back than it.
    let request: RecoverRequest;
    let floorMs: number | null;
    if (cp?.cursor && (gapFloor === null || (cpTs !== null && gapFloor >= cpTs))) {
      request = { cursor: cp.cursor };
      floorMs = cpTs;
      report.floor = { mode: "cursor", sinceMs: cpTs };
    } else {
      const candidates = [cpTs !== null ? cpTs - this.cfg.resumeOverlapMs : null, gapFloor].filter((x): x is number => x !== null);
      floorMs = Math.min(...candidates);
      request = { since: floorMs };
      report.floor = { mode: "since", sinceMs: floorMs };
    }

    // An outage longer than the provider's ring is lost before we ask. Say so,
    // then recover what the ring can still hold.
    const ringEdge = startedAt - this.cfg.ringRetentionMs;
    if (floorMs !== null && floorMs < ringEdge) {
      const id = await this.recordGap(floorMs, ringEdge, GAP_REASONS.beyondRetention);
      if (id) report.gapsRecorded.push(id);
      floorMs = ringEdge;
      request = { since: ringEdge };
      report.floor = { mode: "since", sinceMs: ringEdge };
    }

    let firstNextCursor: string | null = null;
    let firstNewestTs: number | null = null;
    let oldestSeen: number | null = null;
    let before: string | null = null;
    let outcome: "complete" | "truncated" | "failed" = "truncated";
    let why: string | null = "page-cap";
    while (report.pages < this.cfg.maxRecoveryPages) {
      if (this.stopped) {
        outcome = "failed";
        why = "stopped";
        break;
      }
      let page: RecoverPage;
      try {
        page = await this.d.recover(before ? { ...request, before } : request);
      } catch (err) {
        page = { ok: false, reason: `threw: ${errText(err)}` };
      }
      if (!page || !page.ok) {
        outcome = "failed";
        why = sanitizeText(page && !page.ok ? page.reason : "malformed-page", 120) || "failed";
        break;
      }
      if (!Array.isArray(page.events) || (typeof page.hasMore !== "boolean" && page.hasMore !== null) || page.events.length > 1_000) {
        outcome = "failed";
        why = "malformed-page";
        break;
      }
      report.pages++;
      if (report.pages === 1) {
        firstNextCursor = cleanCursor(page.nextCursor);
        firstNewestTs = finite(page.newestTs);
      }
      const pageOldest = finite(page.oldestTs);
      if (pageOldest !== null) oldestSeen = oldestSeen === null ? pageOldest : Math.min(oldestSeen, pageOldest);
      try {
        const fresh = await this.ingestRecovered(page.events, page.normalized === true);
        report.fetched += page.events.length;
        report.persisted += fresh;
      } catch (err) {
        outcome = "failed";
        why = `persist-failed: ${errText(err)}`;
        break;
      }
      // An unstated hasMore on a non-empty page proves nothing; keep walking if we can.
      const more = page.hasMore === true || (page.hasMore === null && page.events.length > 0);
      if (!more) {
        outcome = "complete";
        why = null;
        break;
      }
      const next = cleanCursor(page.oldestCursor);
      if (!next) {
        outcome = "truncated";
        why = page.hasMore === null ? "has-more-unknown" : "no-oldest-cursor";
        break;
      }
      before = next;
    }

    if (outcome === "complete") {
      await this.completeCheckpoint(firstNextCursor, firstNewestTs);
      this.retryAttempt = 0;
      await this.closeGaps(retryable, report);
      this.rerunForLateGaps(snapshot.gaps);
      return finish("complete", null);
    }

    if (outcome === "truncated") {
      // The walk stopped short of the floor. Everything between the floor and
      // the oldest row we did read is lost to us; write that down, and only
      // then let the retryable gaps go, because their contents are now either
      // persisted or inside a recorded unrecoverable gap.
      const from = floorMs ?? oldestSeen ?? startedAt;
      const to = Math.max(from, oldestSeen ?? startedAt);
      const id = await this.recordGap(from, to, why === "page-cap" ? GAP_REASONS.pageCap : GAP_REASONS.noOldestCursor);
      if (id) {
        report.gapsRecorded.push(id);
        await this.completeCheckpoint(firstNextCursor, firstNewestTs);
        await this.closeGaps(retryable, report);
        this.rerunForLateGaps(snapshot.gaps);
      }
      return finish("truncated", why);
    }

    // Failed: nothing is claimed. The hole stays open as a retryable gap and
    // recovery is tried again later. The hole ends where live coverage began.
    const holeFrom = floorMs ?? oldestSeen ?? startedAt;
    const holeTo = Math.max(holeFrom, this.connected && this.connectedAt !== null ? this.connectedAt : startedAt);
    const covered = retryable.some((g) => g.fromMs <= holeFrom && g.toMs >= holeTo);
    if (!covered) {
      const id = await this.recordGap(holeFrom, holeTo, GAP_REASONS.recoveryFailed);
      if (id) report.gapsRecorded.push(id);
    }
    this.scheduleRecoveryRetry();
    return finish("failed", why);
  }

  /** Normalise, persist and route one recovered page. Returns how many were new. */
  private async ingestRecovered(items: readonly unknown[], normalized: boolean): Promise<number> {
    const observedAt = this.now();
    const events: TraderEvent[] = [];
    const retracts: string[] = [];
    for (const raw of items) {
      if (normalized) {
        if (looksLikeEvent(raw)) events.push(raw);
        else this.drop("malformed-recovered-event");
        continue;
      }
      let n: NormalizedFrame;
      try {
        n = this.d.normalize(raw, observedAt, "rest-recovery");
      } catch (err) {
        this.drop("normalize-error");
        await this.deadLetter(safeJson(raw, 2_048), `normalize-threw: ${errText(err)}`);
        continue;
      }
      if (n === null) {
        this.drop("normalize-null");
        continue;
      }
      if (isRetract(n)) retracts.push(n.retract);
      else events.push(n);
    }
    const { fresh } = await this.persist(events, { live: false });
    for (const key of retracts) await this.handleRetract(key);
    this.routeFresh(fresh);
    return fresh.length;
  }

  /** A retryable gap recorded while this walk ran was not in its floor; walk again for it. */
  private rerunForLateGaps(seen: readonly IngestGap[]): void {
    const known = new Set(seen.map((g) => g.id));
    for (const g of this.openGaps.values()) {
      if (!known.has(g.id) && !isUnrecoverableGap(g.reason)) {
        this.rerun = true;
        return;
      }
    }
  }

  private scheduleRecoveryRetry(): void {
    if (this.stopped || this.retryTimer !== null) return;
    const delay = Math.min(this.cfg.recoveryRetryCapMs, this.cfg.recoveryRetryBaseMs * 2 ** Math.min(this.retryAttempt, 20));
    this.retryAttempt++;
    this.retryTimer = this.d.timers.setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) void this.recoverNow("retry");
    }, delay);
  }

  private cancelRecoveryRetry(): void {
    if (this.retryTimer !== null) this.d.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  // ── Interest, routing and coalescing ───────────────────────────────────

  private takeDiscoveryBudget(now: number): boolean {
    const horizon = now - 60_000;
    while (this.discoveryTimes.length > 0 && (this.discoveryTimes[0] ?? now) <= horizon) this.discoveryTimes.shift();
    if (this.discoveryTimes.length >= this.cfg.discoveryPerMinute) return false;
    this.discoveryTimes.push(now);
    return true;
  }

  private audienceFor(e: TraderEvent, snap: InterestSnapshot, now: number): Audience {
    const tenants = new Map<string, RetrievalPriority>();
    const reasons = new Map<string, InterestReason[]>();
    const add = (tenant: string, priority: RetrievalPriority, reason: InterestReason) => {
      if (typeof tenant !== "string" || !tenant) return;
      const prior = tenants.get(tenant);
      tenants.set(tenant, prior ? higherPriority(prior, priority) : priority);
      const rs = reasons.get(tenant) ?? [];
      if (!rs.includes(reason)) rs.push(reason);
      reasons.set(tenant, rs);
    };
    const tk = e.token?.key ?? null;
    if (tk) {
      for (const t of snap.heldTokens.get(tk) ?? []) add(t, "position-protection", "held");
      for (const t of snap.watchedTokens.get(tk) ?? []) add(t, "interactive", "watched");
    }
    const uid = e.trader.userId;
    const fromDependency = !!uid && snap.dependencies.has(uid);
    const fromCohort = !!uid && snap.cohort.has(uid);
    if (fromDependency || fromCohort) {
      for (const t of snap.monitoringTenants) add(t, "discovery", fromDependency ? "dependency" : "cohort");
    } else if (e.kind === "thesis" && isRobinhoodToken(e.token) && snap.monitoringTenants.length > 0) {
      // Open-ended discovery from strangers' theses is the first thing shed:
      // a bounded number per minute, the rest counted.
      if (this.takeDiscoveryBudget(now)) {
        for (const t of snap.monitoringTenants) add(t, "discovery", "robinhood-thesis");
      } else {
        this.drop("discovery-rate-limited");
      }
    }
    return { tenants, reasons };
  }

  private routeFresh(fresh: readonly TraderEvent[]): void {
    if (fresh.length === 0) return;
    if (this.stopped) {
      this.drop("after-stop", fresh.length);
      return;
    }
    let snap: InterestSnapshot;
    try {
      snap = this.d.interest();
    } catch {
      this.drop("interest-unavailable", fresh.length);
      return;
    }
    const now = this.now();
    for (const e of fresh) {
      const a = this.audienceFor(e, snap, now);
      if (a.tenants.size === 0) {
        this.drop("not-of-interest");
        continue;
      }
      const tokenKey = e.token?.key ?? null;
      this.recent.set(e.eventKey, { tokenKey, tenants: [...a.tenants.entries()] });
      for (const tenant of orderTenants(a.tenants)) {
        const item: RoutedItem = {
          kind: "event",
          eventKey: e.eventKey,
          tokenKey,
          priority: a.tenants.get(tenant) ?? "discovery",
          reasons: a.reasons.get(tenant) ?? [],
          routedAt: now,
          event: e,
        };
        try {
          this.d.route(tenant, item);
        } catch {
          this.drop("route-failed");
        }
      }
      if (tokenKey) this.coalesce(tokenKey, e.eventKey, a.tenants, now);
    }
    void this.track(this.markProcessed(fresh.map((e) => e.eventKey)));
  }

  private async markProcessed(keys: readonly string[]): Promise<void> {
    if (!this.d.store.markProcessed || keys.length === 0) return;
    try {
      await this.d.store.markProcessed(keys);
    } catch {
      // Unmarked events are routed again by the next process: at-least-once, never lost.
      this.drop("mark-processed-failed");
    }
  }

  /** Once per process: route what a previous process persisted but died before routing. */
  private async routeOrphans(): Promise<void> {
    if (this.orphansChecked || !this.d.store.unprocessedEvents) return;
    this.orphansChecked = true;
    let rows: ReadonlyArray<TraderEvent & { retracted?: boolean }>;
    try {
      rows = await this.d.store.unprocessedEvents(500);
    } catch {
      this.orphansChecked = false;
      this.drop("orphans-unreadable");
      return;
    }
    // Anything observed since this ingestor started is this process's own, mid-flight.
    const mine = rows.filter((e) => looksLikeEvent(e) && e.observedAt < this.constructedAt);
    const live = mine.filter((e) => e.retracted !== true);
    await this.markProcessed(mine.filter((e) => e.retracted === true).map((e) => e.eventKey));
    if (live.length === 0) return;
    this.counters.orphansRouted += live.length;
    this.routeFresh(live);
  }

  private coalesce(tokenKey: string, eventKey: string, tenants: ReadonlyMap<string, RetrievalPriority>, now: number): void {
    let b = this.buckets.get(tokenKey);
    if (!b) {
      if (this.buckets.size >= this.cfg.maxPendingTokens) {
        const oldest = this.buckets.keys().next();
        if (!oldest.done) this.flushBucket(oldest.value);
      }
      b = { tokenKey, openedAt: now, deadline: now + this.cfg.coalesceWindowMs, protection: false, byKey: new Map(), timer: null };
      this.buckets.set(tokenKey, b);
      this.armBucket(b);
    }
    b.byKey.set(eventKey, new Map(tenants));
    if (!b.protection && [...tenants.values()].includes("position-protection")) {
      // A held position should not wait a full window to be looked at.
      b.protection = true;
      const sooner = now + this.cfg.protectionCoalesceMs;
      if (sooner < b.deadline) {
        b.deadline = sooner;
        this.armBucket(b);
      }
    }
  }

  private armBucket(b: Bucket): void {
    if (b.timer !== null) this.d.timers.clearTimeout(b.timer);
    const delay = Math.max(0, b.deadline - this.now());
    b.timer = this.d.timers.setTimeout(() => {
      b.timer = null;
      this.flushBucket(b.tokenKey);
    }, delay);
  }

  private flushBucket(tokenKey: string): void {
    const b = this.buckets.get(tokenKey);
    if (!b) return;
    this.buckets.delete(tokenKey);
    if (b.timer !== null) this.d.timers.clearTimeout(b.timer);
    b.timer = null;
    const tenants = new Map<string, RetrievalPriority>();
    for (const audience of b.byKey.values()) {
      for (const [t, p] of audience) {
        const prior = tenants.get(t);
        tenants.set(t, prior ? higherPriority(prior, p) : p);
      }
    }
    if (b.byKey.size === 0 || tenants.size === 0) return;
    const eventKeys = [...b.byKey.keys()].sort();
    this.emitTask({
      kind: "research",
      tokenKey,
      evidenceRev: evidenceRevOf(eventKeys),
      priority: maxPriorityOf(tenants),
      tenants: orderTenants(tenants),
      eventKeys,
      windowStartedAt: b.openedAt,
      createdAt: this.now(),
    });
  }

  private emitTask(task: ResearchTask): void {
    const id = `${task.kind}|${task.tokenKey}|${task.evidenceRev}`;
    if (this.emittedTasks.has(id)) {
      this.drop("task-duplicate");
      return;
    }
    this.emittedTasks.set(id, true);
    this.counters.tasksEmitted++;
    try {
      this.d.onResearchTask(task);
    } catch {
      this.drop("task-handler-failed");
    }
  }

  flush(): void {
    for (const tokenKey of [...this.buckets.keys()]) this.flushBucket(tokenKey);
  }

  // ── Retractions ────────────────────────────────────────────────────────

  private async handleRetract(raw: string): Promise<void> {
    const key = typeof raw === "string" ? raw.trim() : "";
    if (!key || key.length > 256) {
      this.drop("retract-invalid");
      return;
    }
    let outcome: RetractOutcome;
    try {
      const r = await this.d.store.markRetracted(key);
      outcome =
        typeof r === "boolean"
          ? { newlyRetracted: r, tokenKey: null }
          : r && typeof r === "object"
            ? { newlyRetracted: r.newlyRetracted === true, tokenKey: typeof r.tokenKey === "string" ? r.tokenKey : null }
            : { newlyRetracted: true, tokenKey: null };
    } catch (err) {
      this.drop("retract-persist-failed");
      await this.deadLetter(sanitizeText(key, 256), `retract-persist-failed: ${errText(err)}`);
      return;
    }
    const mem = this.recent.get(key);
    const tokenKey = outcome.tokenKey ?? mem?.tokenKey ?? null;
    // Still waiting in a coalescing window: it never left in a task, so taking
    // it out is the whole correction for the research side.
    let wasPending = false;
    if (tokenKey) {
      const b = this.buckets.get(tokenKey);
      if (b && b.byKey.delete(key)) {
        wasPending = true;
        if (b.byKey.size === 0) {
          if (b.timer !== null) this.d.timers.clearTimeout(b.timer);
          this.buckets.delete(tokenKey);
        }
      }
    }
    if (!outcome.newlyRetracted) {
      this.drop("retract-duplicate");
      return;
    }
    this.counters.retracted++;

    const tenants = new Map<string, RetrievalPriority>(mem?.tenants ?? []);
    if (tokenKey) {
      try {
        const snap = this.d.interest();
        for (const t of snap.heldTokens.get(tokenKey) ?? []) tenants.set(t, "position-protection");
        for (const t of snap.watchedTokens.get(tokenKey) ?? []) tenants.set(t, higherPriority(tenants.get(t) ?? "interactive", "interactive"));
      } catch {
        // Fall back to whoever received it.
      }
    }
    if (tenants.size === 0) {
      this.drop("retract-no-audience");
      return;
    }
    const now = this.now();
    for (const tenant of orderTenants(tenants)) {
      try {
        this.d.route(tenant, { kind: "correction", eventKey: key, tokenKey, priority: tenants.get(tenant) ?? "discovery", reasons: [], routedAt: now, event: null });
      } catch {
        this.drop("route-failed");
      }
    }
    if (tokenKey && !wasPending) {
      this.emitTask({
        kind: "correction",
        tokenKey,
        evidenceRev: evidenceRevOf([`retract:${key}`]),
        priority: maxPriorityOf(tenants),
        tenants: orderTenants(tenants),
        eventKeys: [key],
        windowStartedAt: now,
        createdAt: now,
      });
    }
  }

  // ── Lifecycle and health ───────────────────────────────────────────────

  stop(options?: { flush?: boolean }): void {
    if (options?.flush !== false) this.flush();
    this.stopped = true;
    this.cancelRecoveryRetry();
    if (this.deferredTimer !== null) this.d.timers.clearTimeout(this.deferredTimer);
    this.deferredTimer = null;
    for (const b of this.buckets.values()) if (b.timer !== null) this.d.timers.clearTimeout(b.timer);
    this.buckets.clear();
  }

  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  health(): IngestHealth {
    const now = this.now();
    const s = this.d.streamStats?.();
    const lastFrameAt = s?.lastFrameAt ?? this.lastDataFrameAt;
    let state: FomoHealthState;
    if (this.stopped || this.streamState === "stopped") state = "disabled";
    else if (this.connected && lastFrameAt !== null && now - lastFrameAt <= this.cfg.freshFrameMs) state = "receiving-fresh-data";
    else state = "provider-unavailable";
    let unrecoverable = 0;
    for (const g of this.openGaps.values()) if (isUnrecoverableGap(g.reason)) unrecoverable++;
    for (const g of this.unrecordedGaps) if (isUnrecoverableGap(g.reason)) unrecoverable++;
    return {
      state,
      streamState: this.streamState,
      connected: this.connected,
      lastFrameAt,
      lastEventAt: this.lastEventAt,
      openGaps: this.openGaps.size + this.unrecordedGaps.length,
      unrecoverableGaps: unrecoverable,
      deadLetters: this.counters.deadLetters,
      queueDepth: s?.queueDepth ?? 0,
      oldestQueuedAgeMs: s?.oldestQueuedAt != null ? Math.max(0, now - s.oldestQueuedAt) : null,
      dropped: { ...this.dropped },
      duplicates: this.counters.duplicates,
      persisted: this.counters.persisted,
      retracted: this.counters.retracted,
      tasksEmitted: this.counters.tasksEmitted,
      orphansRouted: this.counters.orphansRouted,
      realtime: this.realtime,
      delaySeconds: this.delaySeconds,
      recovery: {
        running: this.inflight !== null,
        lastStatus: this.lastRecovery?.status ?? null,
        lastAt: this.lastRecovery?.at ?? null,
        lastReason: this.lastRecovery?.reason ?? null,
      },
      metrics: { sourceDelayMs: this.sourceDelay.snapshot(), ingestionDelayMs: this.ingestionDelay.snapshot(), queueAgeMs: this.queueAge.snapshot() },
    };
  }
}

export function createIngestor(deps: IngestorDeps): Ingestor {
  return new IngestorImpl(deps);
}

// ── Per-tenant delivery queue ─────────────────────────────────────────────

export interface TenantRouterOptions {
  /** Bound per tenant for interactive and discovery items. Protection items are never shed. */
  maxPerTenant?: number;
}

export interface TenantRouterStats {
  tenants: number;
  depth: number;
  shed: Record<RetrievalPriority, number>;
  /** Protection items accepted past the bound rather than shed. */
  overBound: number;
}

export interface TenantRouter {
  route(tenant: string, item: RoutedItem): void;
  /** Highest priority first, oldest first within a priority. */
  take(tenant: string, max?: number): RoutedItem[];
  depth(tenant: string): number;
  stats(): TenantRouterStats;
}

/**
 * A bounded queue per tenant between shared ingestion and that tenant's
 * research. When it is full the OLDEST discovery item goes first, then the
 * oldest interactive one; an item that protects a held position is never
 * shed, even past the bound, because missing a reason to protect money is the
 * one loss this queue must not cause.
 */
export function createTenantRouter(options: TenantRouterOptions = {}): TenantRouter {
  const max = typeof options.maxPerTenant === "number" && options.maxPerTenant > 0 ? Math.floor(options.maxPerTenant) : 500;
  type Lanes = Record<RetrievalPriority, RoutedItem[]>;
  const queues = new Map<string, Lanes>();
  const shed: Record<RetrievalPriority, number> = { "position-protection": 0, interactive: 0, discovery: 0 };
  let overBound = 0;
  const size = (l: Lanes) => l["position-protection"].length + l.interactive.length + l.discovery.length;

  return {
    route(tenant, item) {
      let lanes = queues.get(tenant);
      if (!lanes) {
        lanes = { "position-protection": [], interactive: [], discovery: [] };
        queues.set(tenant, lanes);
      }
      const lane = lanes[item.priority];
      if (lane.some((x) => x.eventKey === item.eventKey && x.kind === item.kind)) return;
      if (size(lanes) >= max) {
        if (lanes.discovery.length > 0) {
          lanes.discovery.shift();
          shed.discovery++;
        } else if (item.priority === "discovery") {
          shed.discovery++;
          return;
        } else if (lanes.interactive.length > 0) {
          lanes.interactive.shift();
          shed.interactive++;
        } else if (item.priority === "interactive") {
          shed.interactive++;
          return;
        } else {
          overBound++;
        }
      }
      lane.push(item);
    },
    take(tenant, n) {
      const lanes = queues.get(tenant);
      if (!lanes) return [];
      const limit = typeof n === "number" && n >= 0 ? Math.floor(n) : Number.POSITIVE_INFINITY;
      const out: RoutedItem[] = [];
      for (const p of ["position-protection", "interactive", "discovery"] as const) {
        const lane = lanes[p];
        while (lane.length > 0 && out.length < limit) {
          const x = lane.shift();
          if (x) out.push(x);
        }
      }
      if (size(lanes) === 0) queues.delete(tenant);
      return out;
    },
    depth(tenant) {
      const lanes = queues.get(tenant);
      return lanes ? size(lanes) : 0;
    },
    stats() {
      let depth = 0;
      for (const l of queues.values()) depth += size(l);
      return { tenants: queues.size, depth, shed: { ...shed }, overBound };
    },
  };
}
