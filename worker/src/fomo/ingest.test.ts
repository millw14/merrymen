import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eventIdentity } from "./events";
import { chainFromProvider, tokenIdentity } from "./identity";
import {
  GAP_REASONS,
  createIngestor,
  createTenantRouter,
  evidenceRevOf,
  type IngestCheckpoint,
  type IngestConfig,
  type GapId,
  type IngestGap,
  type IngestStorePort,
  type InterestSnapshot,
  type NormalizedFrame,
  type RecoverPage,
  type RecoverRequest,
  type ResearchTask,
  type RetractOutcome,
  type RoutedItem,
} from "./ingest";
import { AlertStream, type ClockPort, type SocketLike, type StreamState, type StreamStateDetail, type TimerPort } from "./stream";
import type { ActivityKind, EventSource, TraderEvent } from "./types";

const T0 = 1_790_000_000_000;
const RH_A = "0x1111111111111111111111111111111111111111";
const RH_B = "0x2222222222222222222222222222222222222222";
const RH_C = "0x3333333333333333333333333333333333333333";
const RH_KEY = (a: string) => `eip155:4663:${a}`;
const SOL_MINT = "So11111111111111111111111111111111111111112";

async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise<void>((r) => setImmediate(r));
}

class ManualTime implements ClockPort, TimerPort {
  t = T0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of this.timers) {
        if (e[1].at > target) continue;
        if (!next || e[1].at < next[1].at || (e[1].at === next[1].at && e[0] < next[0])) next = e;
      }
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
      await settle();
    }
    this.t = target;
    await settle();
  }
}

// ── Provider-shaped fixtures ──────────────────────────────────────────────

interface RawAlert {
  type: "alert";
  eventId: string;
  userId: string;
  alertType: "buy" | "sell" | "thesis";
  tokenAddress: string | null;
  chainId: number | null;
  chain: string | null;
  ts: number;
  replay?: boolean;
}

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const keyOf = (n: number) => `ev:${uuid(n)}`;

function raw(n: number, ts: number, over: Partial<RawAlert> = {}): RawAlert {
  return { type: "alert", eventId: uuid(n), userId: "trader-a", alertType: "buy", tokenAddress: RH_A, chainId: 4663, chain: "robinhood", ts, ...over };
}

/** Stand-in for provider.alertFrameToEvent: enough of the real shape to exercise ingestion. */
function normalize(input: unknown, observedAt: number, source: EventSource): NormalizedFrame {
  if (!input || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  if (r.type === "retract") return typeof r.id === "string" ? { retract: `ev:${r.id.toLowerCase()}` } : null;
  if (r.type !== "alert") return null;
  const token = tokenIdentity(chainFromProvider(r.chainId, r.chain), r.tokenAddress);
  const kind: ActivityKind = r.alertType === "thesis" ? "thesis" : r.alertType === "sell" ? "sell" : r.alertType === "buy" ? "buy" : "other";
  const ts = typeof r.ts === "number" ? r.ts : null;
  const id = eventIdentity({ eventId: r.eventId, userId: r.userId, tokenKey: token?.key ?? null, kind, sourceEventAt: ts });
  return {
    eventKey: id.eventKey,
    identityBasis: id.basis,
    identityAmbiguous: id.ambiguous,
    source,
    kind,
    trader: { userId: String(r.userId), handle: null, displayName: null, verified: null },
    token,
    tokenLabel: { symbol: null, name: null },
    tradeId: null,
    swapId: null,
    transferId: null,
    txHash: null,
    fillUsd: null,
    fillUsdBasis: null,
    positionValueUsd: null,
    positionRealizedPnlUsdCumulative: null,
    sourceEventAt: ts,
    execAt: null,
    observedAt,
    verification: "provider-reported",
    text: null,
    replay: r.replay === true,
  };
}

/** A durable store with a real unique key. It does NOT enforce monotonic checkpoints, so tests prove the ingestor does. */
class MemoryStore implements IngestStorePort {
  events = new Map<string, TraderEvent>();
  retracted = new Set<string>();
  checkpoints = new Map<string, IngestCheckpoint>();
  checkpointWrites: IngestCheckpoint[] = [];
  gaps = new Map<GapId, IngestGap & { recovered: boolean }>();
  processed = new Set<string>();
  deadLetters: Array<{ payload: string; error: string }> = [];
  log: string[] = [];
  failInsert = false;
  gate: Promise<void> | null = null;
  listGate: Promise<void> | null = null;
  private gapSeq = 0;

  async insertEvents(events: readonly TraderEvent[]): Promise<string[]> {
    if (this.gate) await this.gate;
    if (this.failInsert) throw new Error("db unavailable");
    const out: string[] = [];
    for (const e of events) {
      if (this.events.has(e.eventKey)) continue;
      this.events.set(e.eventKey, e);
      out.push(e.eventKey);
    }
    for (const k of out) this.log.push(`insert:${k}`);
    return out;
  }
  markRetracted(key: string): RetractOutcome {
    const e = this.events.get(key);
    if (!e || this.retracted.has(key)) return { newlyRetracted: false, tokenKey: e?.token?.key ?? null };
    this.retracted.add(key);
    return { newlyRetracted: true, tokenKey: e.token?.key ?? null };
  }
  getCheckpoint(stream: string): IngestCheckpoint | null {
    return this.checkpoints.get(stream) ?? null;
  }
  async setCheckpoint(stream: string, cursor: string | null, newestTsMs: number | null): Promise<void> {
    this.checkpoints.set(stream, { cursor, newestTsMs });
    this.checkpointWrites.push({ cursor, newestTsMs });
  }
  recordGap(_stream: string, fromMs: number, toMs: number, reason: string): GapId {
    const id = ++this.gapSeq; // numbered rows, like the real store
    this.gaps.set(id, { id, fromMs, toMs, reason, recovered: false });
    return id;
  }
  async listOpenGaps(): Promise<IngestGap[]> {
    if (this.listGate) await this.listGate;
    return [...this.gaps.values()].filter((g) => !g.recovered).map(({ recovered: _r, ...g }) => g);
  }
  markProcessed(keys: readonly string[]): void {
    for (const k of keys) this.processed.add(k);
  }
  async unprocessedEvents(limit: number): Promise<Array<TraderEvent & { retracted: boolean }>> {
    return [...this.events.values()]
      .filter((e) => !this.processed.has(e.eventKey))
      .slice(0, limit)
      .map((e) => ({ ...e, retracted: this.retracted.has(e.eventKey) }));
  }
  markGapRecovered(id: GapId): void {
    const g = this.gaps.get(id);
    if (g) g.recovered = true;
  }
  deadLetter(_stream: string, payload: string, error: string): void {
    this.deadLetters.push({ payload, error });
  }
}

/**
 * The provider's REST ring, with its documented contract: newest first,
 * ordered by (ts, id); cursor strictly newer, since inclusive, before strictly
 * older; opaque "<ts>.<id>" cursors.
 */
class FakeRest {
  items: RawAlert[] = [];
  pageSize = 3;
  calls: RecoverRequest[] = [];
  failCalls = new Set<number>();
  gate: Promise<void> | null = null;
  private static cursorOf(a: RawAlert): string {
    return `${a.ts}.${a.eventId}`;
  }
  private static parse(c: string): [number, string] {
    const i = c.indexOf(".");
    return [Number(c.slice(0, i)), c.slice(i + 1)];
  }
  recover = async (req: RecoverRequest): Promise<RecoverPage> => {
    this.calls.push(req);
    if (this.gate) await this.gate;
    if (this.failCalls.has(this.calls.length)) return { ok: false, reason: "http-503" };
    const cmp = (a: RawAlert, b: RawAlert) => b.ts - a.ts || (a.eventId < b.eventId ? 1 : a.eventId > b.eventId ? -1 : 0);
    let rows = [...this.items].sort(cmp);
    if (req.cursor) {
      const [ts, id] = FakeRest.parse(req.cursor);
      rows = rows.filter((a) => a.ts > ts || (a.ts === ts && a.eventId > id));
    }
    if (req.since !== undefined) rows = rows.filter((a) => a.ts >= (req.since as number));
    if (req.before) {
      const [ts, id] = FakeRest.parse(req.before);
      rows = rows.filter((a) => a.ts < ts || (a.ts === ts && a.eventId < id));
    }
    const page = rows.slice(0, this.pageSize);
    const first = page[0];
    const last = page[page.length - 1];
    return {
      ok: true,
      events: page.map((a) => ({ ...a })),
      nextCursor: first ? FakeRest.cursorOf(first) : null,
      oldestCursor: last ? FakeRest.cursorOf(last) : null,
      hasMore: rows.length > page.length,
      newestTs: first?.ts ?? null,
      oldestTs: last?.ts ?? null,
    };
  };
}

function interestOf(over: Partial<InterestSnapshot> = {}): InterestSnapshot {
  return { cohort: new Set(["trader-a"]), dependencies: new Set(), watchedTokens: new Map(), heldTokens: new Map(), monitoringTenants: ["tenant-m"], ...over };
}

function setup(opts: { store?: MemoryStore; rest?: FakeRest; time?: ManualTime; interest?: InterestSnapshot; config?: Partial<IngestConfig> } = {}) {
  const time = opts.time ?? new ManualTime();
  const store = opts.store ?? new MemoryStore();
  const rest = opts.rest ?? new FakeRest();
  const interest = { current: opts.interest ?? interestOf() };
  const routed: Array<{ tenant: string; item: RoutedItem }> = [];
  const tasks: ResearchTask[] = [];
  const ing = createIngestor({
    normalize,
    store,
    recover: rest.recover,
    interest: () => interest.current,
    route: (tenant, item) => {
      routed.push({ tenant, item });
      store.log.push(`route:${tenant}:${item.eventKey}`);
    },
    onResearchTask: (t) => tasks.push(t),
    clock: time,
    timers: time,
    config: opts.config,
  });
  let conn = 100;
  const detail = (connection: number): StreamStateDetail => ({ endpoint: "redacted", connection, attempt: 0, realtime: true, delaySeconds: 0, heartbeatSeconds: 20 });
  /** Simulate the stream connecting and saying welcome. */
  const open = async () => {
    conn++;
    ing.handleState("connecting", detail(conn));
    ing.handleState("open", detail(conn));
    await ing.idle();
  };
  const drop = () => ing.handleState("backoff", detail(conn));
  const live = async (r: RawAlert | Record<string, unknown>, replay = false) => {
    await ing.handleFrame(r, { replay, receivedAt: time.now() });
    await ing.idle();
  };
  return { time, store, rest, interest, routed, tasks, ing, open, drop, live };
}

function routedOnce(routed: ReadonlyArray<{ tenant: string; item: RoutedItem }>): void {
  const seen = new Set<string>();
  for (const r of routed) {
    const k = `${r.tenant}|${r.item.kind}|${r.item.eventKey}`;
    assert.ok(!seen.has(k), `routed twice: ${k}`);
    seen.add(k);
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("persist first, route only what is new", () => {
  it("live, replay, REST recovery and a restart route every event exactly once and task it exactly once", async () => {
    const store = new MemoryStore();
    const rest = new FakeRest();
    const time = new ManualTime();
    const a = setup({ store, rest, time });

    await a.open(); // fresh install: nothing to recover
    const e1 = raw(1, T0 - 50_000);
    const e2 = raw(2, T0 - 45_000);
    rest.items.push(e1, e2);
    await a.live(e1);
    await a.live(e2);
    await a.live({ ...e1, replay: true }, true);

    // Outage: two events happen while we are disconnected.
    a.drop();
    await time.advance(30_000);
    const e3 = raw(3, T0 - 10_000, { tokenAddress: RH_B });
    const e4 = raw(4, T0 - 5_000, { tokenAddress: RH_B });
    rest.items.push(e3, e4);
    await a.open(); // recovery walks two pages back to the resume point
    await a.live({ ...e4, replay: true }, true);
    await a.live({ ...e3, replay: true }, true);
    await time.advance(120_000);
    a.ing.stop();

    // Restart: a new ingestor over the same store, same provider.
    const e5 = raw(5, time.now() - 2_000, { tokenAddress: RH_C });
    rest.items.push(e5);
    const b = setup({ store, rest, time });
    await b.open();
    await b.live({ ...e3, replay: true }, true);
    await b.live({ ...e4, replay: true }, true);
    await b.live({ ...e5, replay: true }, true);
    await b.live(e5);
    await time.advance(120_000);

    const routed = [...a.routed, ...b.routed];
    routedOnce(routed);
    assert.deepEqual(routed.map((r) => r.item.eventKey).sort(), [1, 2, 3, 4, 5].map(keyOf).sort());

    const taskKeys = [...a.tasks, ...b.tasks].flatMap((t) => t.eventKeys);
    assert.deepEqual([...taskKeys].sort(), [1, 2, 3, 4, 5].map(keyOf).sort(), "each event in exactly one task");
    assert.equal(new Set(taskKeys).size, taskKeys.length);

    // Every route came after that event's insert.
    for (const k of [1, 2, 3, 4, 5].map(keyOf)) {
      const ins = store.log.indexOf(`insert:${k}`);
      const rt = store.log.findIndex((l) => l.endsWith(`:${k}`) && l.startsWith("route:"));
      assert.ok(ins >= 0 && rt > ins, `${k} inserted before routed`);
    }
    assert.equal(store.events.get(keyOf(3))?.source, "rest-recovery", "the outage was filled by REST, before any replay");
    assert.equal(store.events.get(keyOf(4))?.source, "rest-recovery");
    assert.equal(store.events.get(keyOf(5))?.source, "rest-recovery");
    assert.ok(a.ing.health().duplicates >= 3);
    // The restart resumed strictly after the last completed walk.
    assert.ok(rest.calls.some((c) => typeof c.cursor === "string"));
  });
});

describe("routing outbox", () => {
  it("a new process routes, once, what a crashed one persisted but never routed", async () => {
    const store = new MemoryStore();
    const time = new ManualTime();
    // A previous process inserted these and died before routing them.
    await store.insertEvents([normalize(raw(1, T0 - 30_000), T0 - 29_000, "stream") as TraderEvent, normalize(raw(2, T0 - 25_000), T0 - 24_000, "stream") as TraderEvent]);
    store.retracted.add(keyOf(2));
    store.checkpoints.set("alerts", { cursor: null, newestTsMs: T0 - 25_000 });

    const a = setup({ store, time });
    await a.open();
    assert.deepEqual(a.routed.map((r) => r.item.eventKey), [keyOf(1)], "the retracted orphan is not routed");
    assert.ok(store.processed.has(keyOf(1)) && store.processed.has(keyOf(2)));
    assert.equal(a.ing.health().orphansRouted, 1);
    await time.advance(60_000);
    assert.deepEqual(a.tasks.flatMap((t) => t.eventKeys), [keyOf(1)]);

    // A live event in flight during the next start is that process's own, not an orphan.
    a.ing.stop();
    const b = setup({ store, time });
    await b.live(raw(3, T0 + 50_000));
    await b.open();
    assert.deepEqual(b.routed.map((r) => r.item.eventKey), [keyOf(3)]);
    routedOnce([...a.routed, ...b.routed]);
  });

  it("accepts pages a provider reader already normalised, and does not trust an unstated hasMore", async () => {
    const store = new MemoryStore();
    store.checkpoints.set("alerts", { cursor: null, newestTsMs: T0 - 100_000 });
    const pages: RecoverPage[] = [
      { ok: true, normalized: true, events: [normalize(raw(1, T0 - 50_000), T0, "rest-recovery"), { not: "an event" }], nextCursor: "c1", oldestCursor: null, hasMore: null, newestTs: T0 - 50_000, oldestTs: T0 - 50_000 },
    ];
    const time = new ManualTime();
    const routed: string[] = [];
    const ing = createIngestor({
      normalize: () => {
        throw new Error("must not be called for normalized pages");
      },
      store,
      recover: async () => pages.shift() ?? { ok: false, reason: "no more" },
      interest: () => interestOf(),
      route: (_t, i) => routed.push(i.eventKey),
      onResearchTask: () => undefined,
      clock: time,
      timers: time,
    });
    ing.handleState("connecting", { endpoint: "r", connection: 1, attempt: 0 });
    ing.handleState("open", { endpoint: "r", connection: 1, attempt: 0 });
    await ing.idle();
    assert.deepEqual(routed, [keyOf(1)]);
    assert.equal(ing.health().dropped["malformed-recovered-event"], 1);
    assert.equal(ing.health().recovery.lastStatus, "truncated", "no proof the walk reached its floor");
    assert.equal(ing.health().recovery.lastReason, "has-more-unknown");
    assert.equal(ing.health().unrecoverableGaps, 1);
  });
});

describe("checkpoint", () => {
  it("is monotonic, moves only after persistence, and takes a cursor only from a completed walk", async () => {
    const s = setup();
    await s.open();
    await s.live(raw(1, T0 - 100_000));
    await s.live(raw(2, T0 - 200_000)); // older: no move
    await s.live({ ...raw(3, T0 - 300_000), replay: true }, true); // older replay: no move
    assert.deepEqual(s.store.checkpoints.get("alerts"), { cursor: null, newestTsMs: T0 - 100_000 });

    s.store.failInsert = true;
    await s.live(raw(4, T0 - 20_000));
    s.store.failInsert = false;
    assert.deepEqual(s.store.checkpoints.get("alerts"), { cursor: null, newestTsMs: T0 - 100_000 }, "a failed insert never moves the checkpoint");
    assert.equal(s.ing.health().dropped["persist-failed"], 1);
    const failGap = [...s.store.gaps.values()].find((g) => g.reason === GAP_REASONS.persistFailed);
    assert.ok(failGap && failGap.fromMs === T0 - 20_000);
    assert.equal(s.store.deadLetters.length, 1);

    // The retry recovers the missed event over REST and the gap closes.
    s.rest.items.push(raw(4, T0 - 20_000));
    await s.time.advance(60_000);
    await s.ing.idle();
    assert.ok(s.store.events.has(keyOf(4)));
    assert.equal(s.store.gaps.get(failGap.id)?.recovered, true);
    const cp = s.store.checkpoints.get("alerts");
    assert.equal(cp?.cursor, `${T0 - 20_000}.${uuid(4)}`);
    assert.equal(cp?.newestTsMs, T0 - 20_000);

    let prev = -Infinity;
    for (const w of s.store.checkpointWrites) {
      assert.ok((w.newestTsMs ?? -Infinity) >= prev, "never backwards");
      prev = w.newestTsMs ?? prev;
    }
  });

  it("holds a new connection's early frames back until recovery has read the resume point", async () => {
    const s = setup();
    s.store.checkpoints.set("alerts", { cursor: null, newestTsMs: T0 - 600_000 });
    s.ing.handleState("connecting", { endpoint: "r", connection: 1, attempt: 0 });
    // A replayed frame arrives before welcome, from long after the outage began.
    await s.live({ ...raw(9, T0 - 1_000), replay: true }, true);
    assert.equal(s.store.checkpoints.get("alerts")?.newestTsMs, T0 - 600_000, "held");
    s.ing.handleState("open", { endpoint: "r", connection: 1, attempt: 0 });
    await s.ing.idle();
    assert.deepEqual(s.rest.calls[0], { since: T0 - 600_000 - 60_000 }, "recovery resumes from before the outage");
    assert.equal(s.store.checkpoints.get("alerts")?.newestTsMs, T0 - 1_000, "held progress applied afterwards");
  });
});

describe("checkpoint cursor", () => {
  it("is dropped when live frames have already moved past what the walk read", async () => {
    const s = setup();
    s.store.checkpoints.set("alerts", { cursor: null, newestTsMs: T0 - 300_000 });
    s.rest.items.push(raw(1, T0 - 200_000));
    let releaseRest!: () => void;
    s.rest.gate = new Promise<void>((r) => (releaseRest = r));
    s.ing.handleState("connecting", { endpoint: "r", connection: 1, attempt: 0 });
    s.ing.handleState("open", { endpoint: "r", connection: 1, attempt: 0 });
    await settle(); // the resume point is read; the walk is waiting on the provider
    await s.ing.handleFrame(raw(2, T0 - 1_000), { replay: false, receivedAt: T0 });
    s.rest.gate = null;
    releaseRest();
    await s.ing.idle();
    assert.deepEqual(s.store.checkpoints.get("alerts"), { cursor: null, newestTsMs: T0 - 1_000 });
  });
});

describe("checkpoint hold across overlapping connections", () => {
  it("a recovery that started before a reconnect cannot release the new connection's hold", async () => {
    const s = setup();
    s.store.checkpoints.set("alerts", { cursor: null, newestTsMs: T0 - 600_000 });
    let releaseList!: () => void;
    let releaseRest!: () => void;
    s.store.listGate = new Promise<void>((r) => (releaseList = r));
    s.rest.gate = new Promise<void>((r) => (releaseRest = r));
    const d = (connection: number): StreamStateDetail => ({ endpoint: "r", connection, attempt: 0 });

    s.ing.handleState("connecting", d(1));
    s.ing.handleState("open", d(1)); // recovery #1: its resume-point read is still pending
    s.ing.handleState("backoff", d(1));
    s.ing.handleState("connecting", d(2));
    await s.ing.handleFrame({ ...raw(9, T0 - 1_000), replay: true }, { replay: true, receivedAt: T0 });
    s.ing.handleState("open", d(2)); // recovery #2 queued behind #1

    s.store.listGate = null;
    releaseList();
    await settle();
    assert.equal(s.store.checkpoints.get("alerts")?.newestTsMs, T0 - 600_000, "still held while #1 walks");
    s.rest.gate = null;
    releaseRest();
    await s.ing.idle();
    assert.equal(s.store.checkpoints.get("alerts")?.newestTsMs !== T0 - 1_000, true, "still held until the new connection's own recovery");
    await s.time.advance(30_000);
    await s.ing.idle();
    assert.equal(s.rest.calls.length, 2, "recovery ran again for the new connection");
    assert.deepEqual(s.rest.calls[1], { since: T0 - 600_000 - 60_000 }, "#2 still resumes from before the outage");
    assert.equal(s.store.checkpoints.get("alerts")?.newestTsMs, T0 - 1_000, "held progress applied after #2 read its floor");
  });
});

describe("recovery and gaps", () => {
  it("coalesces reconnect recoveries from a flapping connection instead of paying for each", async () => {
    const s = setup();
    s.store.checkpoints.set("alerts", { cursor: null, newestTsMs: T0 - 60_000 });
    for (let i = 0; i < 10; i++) {
      s.drop();
      await s.open();
      await s.time.advance(2_000);
    }
    assert.equal(s.rest.calls.length, 1, "one immediate recovery; the rest wait");
    await s.time.advance(30_000);
    await s.ing.idle();
    assert.equal(s.rest.calls.length, 2, "one deferred recovery covers every reconnect since");
  });

  it("walks back with before, keeps the floor, and closes a backpressure gap only once the floor is reached", async () => {
    const s = setup({ config: { maxRecoveryPages: 10 } });
    s.store.checkpoints.set("alerts", { cursor: null, newestTsMs: T0 - 300_000 });
    await s.ing.handleGap({ fromMs: T0 - 290_000, toMs: T0 - 100_000, reason: "stream-backpressure" });
    for (let i = 1; i <= 7; i++) s.rest.items.push(raw(i, T0 - 300_000 + i * 30_000));
    s.rest.failCalls.add(2); // the second page fails the first time

    await s.open();
    const gapId = [...s.store.gaps.keys()][0] ?? -1;
    assert.equal(s.store.gaps.get(gapId)?.recovered, false, "a walk that failed half way closes nothing");
    const failed = [...s.store.gaps.values()].find((g) => g.reason === GAP_REASONS.recoveryFailed);
    assert.ok(failed, "the failed walk is itself recorded");
    assert.equal(s.ing.health().recovery.lastStatus, "failed");

    await s.time.advance(60_000); // scheduled retry
    await s.ing.idle();
    const floor = T0 - 360_000;
    const retry = s.rest.calls.slice(2);
    assert.deepEqual(retry[0], { since: floor });
    assert.equal(retry[1]?.since, floor, "the floor is kept while paging back");
    assert.equal(typeof retry[1]?.before, "string");
    assert.equal(s.store.gaps.get(gapId)?.recovered, true);
    assert.equal(s.store.gaps.get(failed.id)?.recovered, true);
    assert.equal(s.store.events.size, 7);
    assert.equal(s.ing.health().openGaps, 0);
    assert.equal(s.store.checkpoints.get("alerts")?.cursor, `${T0 - 300_000 + 7 * 30_000}.${uuid(7)}`);
  });

  it("records an unrecoverable gap when pages run out, and it stays visible", async () => {
    const s = setup({ config: { maxRecoveryPages: 2 } });
    s.rest.pageSize = 2;
    s.store.checkpoints.set("alerts", { cursor: null, newestTsMs: T0 - 1_000_000 });
    for (let i = 1; i <= 10; i++) s.rest.items.push(raw(i, T0 - 1_000_000 + i * 60_000));
    await s.open();

    const unrecoverable = [...s.store.gaps.values()].filter((g) => g.reason === GAP_REASONS.pageCap);
    assert.equal(unrecoverable.length, 1);
    assert.deepEqual([unrecoverable[0]?.fromMs, unrecoverable[0]?.toMs], [T0 - 1_060_000, T0 - 1_000_000 + 7 * 60_000]);
    assert.equal(s.ing.health().recovery.lastStatus, "truncated");
    assert.equal(s.store.events.size, 4, "the four newest were read");

    // Later recoveries succeed, and the hole is still reported.
    for (let i = 0; i < 2; i++) {
      await s.time.advance(30_000);
      s.drop();
      await s.open();
    }
    assert.equal(s.ing.health().recovery.lastStatus, "complete");
    assert.equal(s.store.gaps.get(unrecoverable[0]?.id ?? -1)?.recovered, false);
    assert.equal(s.ing.health().openGaps, 1);
    assert.equal(s.ing.health().unrecoverableGaps, 1);
  });

  it("records an outage longer than the provider's ring as unrecoverable and recovers what the ring holds", async () => {
    const s = setup({ config: { ringRetentionMs: 6 * 3_600_000 } });
    s.store.checkpoints.set("alerts", { cursor: "old.cursor", newestTsMs: T0 - 7 * 3_600_000 });
    s.rest.items.push(raw(1, T0 - 3_600_000));
    await s.open();
    const g = [...s.store.gaps.values()].find((x) => x.reason === GAP_REASONS.beyondRetention);
    assert.ok(g);
    assert.deepEqual([g.fromMs, g.toMs], [T0 - 7 * 3_600_000, T0 - 6 * 3_600_000]);
    assert.deepEqual(s.rest.calls[0], { since: T0 - 6 * 3_600_000 });
    assert.ok(s.store.events.has(keyOf(1)));
    assert.equal(s.ing.health().unrecoverableGaps, 1);
  });

  it("does nothing on a first start with no checkpoint, and resumes by cursor after a completed walk", async () => {
    const s = setup();
    await s.open();
    assert.equal(s.rest.calls.length, 0);
    assert.equal(s.ing.health().recovery.lastStatus, "no-checkpoint");
    s.store.checkpoints.set("alerts", { cursor: "1.a", newestTsMs: T0 - 5_000 });
    s.drop();
    await s.open(); // within the minimum interval: deferred, not dropped
    assert.equal(s.rest.calls.length, 0);
    await s.time.advance(30_000);
    await s.ing.idle();
    assert.deepEqual(s.rest.calls[0], { cursor: "1.a" });
  });
});

describe("coalescing and priority", () => {
  it("yields one task per coin per evidence revision", async () => {
    const s = setup();
    await s.open();
    await s.live(raw(1, T0 - 9_000));
    await s.time.advance(10_000);
    await s.live(raw(2, T0));
    await s.live(raw(3, T0, { tokenAddress: RH_B }));
    await s.time.advance(30_000);
    await s.live(raw(4, T0 + 30_000));
    await s.live({ ...raw(2, T0), replay: true }, true);
    assert.equal(s.tasks.length, 0, "nothing before the window closes");
    await s.time.advance(20_000);

    const forA = s.tasks.filter((t) => t.tokenKey === RH_KEY(RH_A));
    assert.equal(forA.length, 1);
    assert.deepEqual(forA[0]?.eventKeys, [keyOf(1), keyOf(2), keyOf(4)].sort());
    assert.equal(forA[0]?.evidenceRev, evidenceRevOf([keyOf(4), keyOf(1), keyOf(2)]));
    assert.equal(forA[0]?.priority, "discovery");
    assert.deepEqual(forA[0]?.tenants, ["tenant-m"]);

    await s.live(raw(5, T0 + 61_000));
    await s.time.advance(61_000);
    const later = s.tasks.filter((t) => t.tokenKey === RH_KEY(RH_A));
    assert.equal(later.length, 2, "new evidence, new revision");
    assert.notEqual(later[1]?.evidenceRev, later[0]?.evidenceRev);
    assert.equal(s.tasks.filter((t) => t.tokenKey === RH_KEY(RH_B)).length, 1);
  });

  it("orders position protection over interactive over discovery and flushes held coins early", async () => {
    const s = setup({
      interest: interestOf({
        heldTokens: new Map([[RH_KEY(RH_A), ["tenant-h"]]]),
        watchedTokens: new Map([
          [RH_KEY(RH_A), ["tenant-w"]],
          [RH_KEY(RH_B), ["tenant-w"]],
        ]),
        monitoringTenants: ["tenant-m", "tenant-h"],
      }),
    });
    await s.open();
    await s.live(raw(1, T0));
    await s.live(raw(2, T0, { userId: "stranger", tokenAddress: RH_B }));
    const byTenant = Object.fromEntries(s.routed.filter((r) => r.item.eventKey === keyOf(1)).map((r) => [r.tenant, r.item.priority]));
    assert.deepEqual(byTenant, { "tenant-h": "position-protection", "tenant-w": "interactive", "tenant-m": "discovery" });
    assert.deepEqual(
      s.routed.filter((r) => r.item.eventKey === keyOf(1)).map((r) => r.tenant),
      ["tenant-h", "tenant-w", "tenant-m"],
      "routed highest priority first",
    );
    assert.deepEqual(s.routed.find((r) => r.tenant === "tenant-h")?.item.reasons, ["held", "cohort"]);

    await s.time.advance(5_000);
    assert.equal(s.tasks.length, 1, "the held coin did not wait the full window");
    assert.deepEqual(s.tasks[0]?.tenants, ["tenant-h", "tenant-w", "tenant-m"]);
    assert.equal(s.tasks[0]?.priority, "position-protection");
    await s.time.advance(55_000);
    const watched = s.tasks.find((t) => t.tokenKey === RH_KEY(RH_B));
    assert.equal(watched?.priority, "interactive");
    assert.deepEqual(watched?.tenants, ["tenant-w"]);
  });

  it("drops what nobody follows, counts it, and bounds stranger-thesis discovery per minute", async () => {
    const s = setup({ config: { discoveryPerMinute: 2 } });
    await s.open();
    await s.live(raw(1, T0, { userId: "stranger", tokenAddress: RH_C }));
    assert.ok(s.store.events.has(keyOf(1)), "persisted even though not routed");
    assert.equal(s.ing.health().dropped["not-of-interest"], 1);

    for (let i = 2; i <= 5; i++) await s.live(raw(i, T0, { userId: `stranger-${i}`, alertType: "thesis", tokenAddress: RH_C }));
    await s.live(raw(6, T0, { userId: "stranger", alertType: "thesis", tokenAddress: SOL_MINT, chainId: 1399811149, chain: "solana" }));
    assert.deepEqual(s.routed.map((r) => r.item.eventKey), [keyOf(2), keyOf(3)]);
    assert.deepEqual(s.routed[0]?.item.reasons, ["robinhood-thesis"]);
    const h = s.ing.health();
    assert.equal(h.dropped["discovery-rate-limited"], 2);
    assert.equal(h.dropped["not-of-interest"], 4);

    await s.time.advance(60_001);
    await s.live(raw(7, T0, { userId: "stranger-7", alertType: "thesis", tokenAddress: RH_C }));
    assert.equal(s.routed.at(-1)?.item.eventKey, keyOf(7), "budget refills after a minute");
  });
});

describe("retractions", () => {
  it("marks the event retracted, routes a correction and emits one correction task", async () => {
    const s = setup();
    await s.open();
    await s.live(raw(1, T0));
    await s.time.advance(60_000);
    assert.equal(s.tasks.length, 1);

    await s.live({ type: "retract", id: uuid(1) });
    await s.live({ type: "retract", id: uuid(1) }); // replayed retract
    assert.ok(s.store.retracted.has(keyOf(1)));
    const corrections = s.tasks.filter((t) => t.kind === "correction");
    assert.equal(corrections.length, 1);
    assert.deepEqual(corrections[0]?.eventKeys, [keyOf(1)]);
    assert.equal(corrections[0]?.tokenKey, RH_KEY(RH_A));
    assert.deepEqual(
      s.routed.filter((r) => r.item.kind === "correction").map((r) => r.tenant),
      ["tenant-m"],
    );
    assert.equal(s.ing.health().dropped["retract-duplicate"], 1);
  });

  it("takes a still-pending event out of its coalescing window instead of correcting a task", async () => {
    const s = setup();
    await s.open();
    await s.live(raw(1, T0));
    await s.live(raw(2, T0));
    await s.live({ type: "retract", id: uuid(2) });
    await s.time.advance(60_000);
    const research = s.tasks.filter((t) => t.kind === "research");
    assert.deepEqual(research.map((t) => t.eventKeys), [[keyOf(1)]]);
    assert.equal(s.tasks.filter((t) => t.kind === "correction").length, 0);
    assert.equal(s.routed.filter((r) => r.item.kind === "correction").length, 1, "the tenant that saw it is still told");
  });
});

describe("tenant router", () => {
  const item = (n: number, priority: RoutedItem["priority"]): RoutedItem => ({ kind: "event", eventKey: `k${n}`, tokenKey: null, priority, reasons: [], routedAt: T0, event: null });

  it("sheds the oldest discovery first, then interactive, and never position protection", () => {
    const r = createTenantRouter({ maxPerTenant: 3 });
    r.route("t", item(1, "discovery"));
    r.route("t", item(2, "discovery"));
    r.route("t", item(3, "interactive"));
    r.route("t", item(4, "position-protection")); // sheds k1
    r.route("t", item(5, "position-protection")); // sheds k2
    r.route("t", item(6, "discovery")); // nothing older to shed: the newcomer goes
    r.route("t", item(7, "position-protection")); // sheds k3
    r.route("t", item(8, "position-protection")); // over the bound, kept
    r.route("t", item(9, "interactive")); // only protection queued: refused
    r.route("t", item(8, "position-protection")); // duplicate ignored
    r.route("u", item(10, "discovery"));
    assert.equal(r.depth("t"), 4);
    assert.deepEqual(r.stats(), { tenants: 2, depth: 5, shed: { "position-protection": 0, interactive: 2, discovery: 3 }, overBound: 1 });
    assert.deepEqual(r.take("t", 2).map((x) => x.eventKey), ["k4", "k5"]);
    assert.deepEqual(r.take("t").map((x) => x.eventKey), ["k7", "k8"]);
    assert.equal(r.depth("t"), 0);
  });

  it("hands items out highest priority first, oldest first within a priority", () => {
    const r = createTenantRouter();
    r.route("t", item(1, "discovery"));
    r.route("t", item(2, "interactive"));
    r.route("t", item(3, "position-protection"));
    r.route("t", item(4, "interactive"));
    assert.deepEqual(r.take("t").map((x) => x.eventKey), ["k3", "k2", "k4", "k1"]);
  });
});

describe("with the real stream", () => {
  const SECRET_KEY = "sk_live_0a1b2c3d4e5f60718293";
  const SECRET_URL = `wss://stream.test/ws/alerts?key=${SECRET_KEY}&chain=robinhood`;

  class Sock implements SocketLike {
    closed: number | null = null;
    sent: string[] = [];
    onopen: SocketLike["onopen"] = null;
    onmessage: SocketLike["onmessage"] = null;
    onclose: SocketLike["onclose"] = null;
    onerror: SocketLike["onerror"] = null;
    send(d: string): void {
      this.sent.push(d);
    }
    close(code?: number): void {
      this.closed = code ?? null;
    }
    frame(o: unknown): void {
      this.onmessage?.({ data: JSON.stringify(o) });
    }
  }

  it("a full queue closes the socket and records a gap, then REST recovery fills it and closes it; the URL is never emitted", async () => {
    const time = new ManualTime();
    const store = new MemoryStore();
    const rest = new FakeRest();
    store.checkpoints.set("alerts", { cursor: null, newestTsMs: T0 - 120_000 });
    const s = setup({ store, rest, time });
    const states: Array<{ state: StreamState; detail: StreamStateDetail }> = [];
    const sockets: Sock[] = [];
    const cb = s.ing.streamCallbacks();
    const stream = new AlertStream({
      endpoint: { url: SECRET_URL, redacted: "wss://stream.test/ws/alerts?key=***" },
      createSocket: () => {
        const k = new Sock();
        sockets.push(k);
        return k;
      },
      clock: time,
      timers: time,
      random: () => 0.5,
      subscription: { chain: "robinhood" },
      maxQueue: 3,
      onFrame: cb.onFrame,
      onGap: cb.onGap,
      onDeadLetter: cb.onDeadLetter,
      onState: (state, detail) => {
        states.push({ state, detail });
        cb.onState(state, detail);
      },
    });
    stream.start();
    const first = sockets[0];
    assert.ok(first);
    first.frame({ type: "welcome", realtime: true, delaySeconds: 0, heartbeatSeconds: 20, filter: { chain: "robinhood" } });
    await s.ing.idle();
    assert.equal(rest.calls.length, 1, "recovered once on connect");

    const ev = (n: number) => raw(n, T0 - 100_000 + n * 5_000);
    const happen = (n: number) => {
      rest.items.push(ev(n));
      return ev(n);
    };
    first.frame(happen(1));
    first.frame({ type: "garbage", key: SECRET_KEY, url: SECRET_URL });
    await settle();
    let release!: () => void;
    store.gate = new Promise<void>((r) => (release = r));
    for (let n = 2; n <= 6; n++) first.frame(happen(n)); // 2 in flight, 3-5 queued, 6 rejected
    happen(7);
    happen(8); // the socket is closed by now
    await settle();
    assert.equal(first.closed, 4001);
    const gap = [...store.gaps.values()].find((g) => g.reason === "stream-backpressure");
    assert.ok(gap, "backpressure gap recorded");
    assert.equal(gap.fromMs, ev(1).ts, "from the last processed event");

    store.gate = null;
    release();
    await stream.drained();
    await s.ing.idle();
    const delay = states.filter((x) => x.state === "backoff").at(-1)?.detail.delayMs ?? 0;
    await time.advance(delay);
    const second = sockets[1];
    assert.ok(second, "reconnected after draining");
    second.frame({ type: "welcome", realtime: true, delaySeconds: 0, heartbeatSeconds: 20, filter: { chain: "robinhood" } });
    await time.advance(30_000); // reconnect recoveries are spaced by minRecoveryIntervalMs
    second.frame({ type: "heartbeat", ts: time.now(), lastEventAt: null, quietSeconds: 30, buffered: 0 });
    await s.ing.idle();
    await stream.drained();

    for (let n = 1; n <= 8; n++) assert.ok(store.events.has(keyOf(n)), `event ${n} persisted`);
    for (const n of [6, 7, 8]) assert.equal(store.events.get(keyOf(n))?.source, "rest-recovery", `event ${n} came back over REST`);
    assert.equal(store.gaps.get(gap.id)?.recovered, true, "gap closed once recovery reached its floor");
    routedOnce(s.routed);
    assert.equal(s.routed.length, 8);
    const h = s.ing.health();
    assert.equal(h.openGaps, 0);
    assert.equal(h.connected, true);
    assert.equal(h.state, "receiving-fresh-data");
    assert.ok(h.metrics.ingestionDelayMs.n > 0 && h.metrics.queueAgeMs.n > 0);
    assert.ok(h.metrics.sourceDelayMs.p50 !== null && h.metrics.sourceDelayMs.p50 > 0);

    stream.stop();
    s.ing.stop();
    assert.equal(s.ing.health().state, "disabled");

    const everything = JSON.stringify({ states, deadLetters: store.deadLetters, gaps: [...store.gaps.values()], health: h, stats: stream.stats(), routed: s.routed });
    assert.ok(!everything.includes(SECRET_KEY));
    assert.ok(!everything.includes("sk_live"));
    assert.ok(store.deadLetters.length >= 1, "the garbage frame was dead-lettered through the ingestor");
  });
});
