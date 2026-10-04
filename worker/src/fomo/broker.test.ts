import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import {
  BROKER_LIMITS,
  brokerFailureEnvelope,
  childProcessBrokerPort,
  createDirectBroker,
  createIpcBroker,
  envelopeOf,
  FOMO_TOOL_NAMES,
  isFomoToolName,
  parseBrokerRequest,
  processBrokerPort,
  serveBrokerRequests,
  validateBrokerReport,
  type BrokerCallContext,
  type BrokerPort,
} from "./broker";
import type { BrokerCallOptions, BrokerReport, FomoService, FomoServiceHealth } from "./contract";
import type { CoinDossier, FollowAssessment, FomoCallContext, FomoEnvelope, FomoToolName } from "./types";

const NOW = 1_800_000_000_000;
const ORCH_TENANT = "0x00000000000000000000000000000000000000a1";
const A = `0x${"a1".repeat(20)}`;
const RH_KEY = `eip155:4663:${A}`;
const MINT = "So11111111111111111111111111111111111111112";
const SOL_KEY = `solana:1399811149:${MINT}`;

const DM: BrokerCallOptions = { surface: "telegram-dm", audience: "owner", conversationKey: "tg:dm:1", priority: "interactive" };

function okEnvelope(tool: FomoToolName, ctx: FomoCallContext, data: unknown = { rows: [1, 2, 3] }): FomoEnvelope {
  const base = brokerFailureEnvelope(tool, "unused", "unused", ctx.now, ctx.requestId);
  return {
    ...base,
    status: "ok",
    data,
    reason: null,
    message: null,
    freshness: { ...base.freshness, retrievedAt: ctx.now, servedFrom: "live", lastRefreshAttemptAt: ctx.now, lastRefreshOutcome: "ok", cacheAgeMs: 0 },
  };
}

type Behaviour = (ctx: FomoCallContext, tool: FomoToolName, args: Record<string, unknown>) => unknown;

class FakeService implements FomoService {
  invocations: { ctx: BrokerCallContext; tool: FomoToolName; args: Record<string, unknown> }[] = [];
  memory = new Map<string, string>();
  reports: { tenant: string; r: BrokerReport; now: number }[] = [];
  memoryCalls: string[] = [];
  isConfigured: boolean | (() => boolean) = true;
  behaviour: Behaviour = (ctx, tool) => okEnvelope(tool, ctx);
  failMemory = false;

  async invoke(ctx: FomoCallContext, tool: FomoToolName, args: Record<string, unknown>): Promise<FomoEnvelope> {
    this.invocations.push({ ctx: ctx as BrokerCallContext, tool, args });
    return (await this.behaviour(ctx, tool, args)) as FomoEnvelope;
  }
  async memoryGet(tenant: string, key: string): Promise<string | null> {
    this.memoryCalls.push(`get:${tenant}:${key}`);
    if (this.failMemory) throw new Error("db down postgres://user:SECRET@host/db");
    return this.memory.get(`${tenant}|${key}`) ?? null;
  }
  async memorySet(tenant: string, key: string, json: string, _now: number): Promise<void> {
    this.memoryCalls.push(`set:${tenant}:${key}`);
    if (this.failMemory) throw new Error("db down");
    this.memory.set(`${tenant}|${key}`, json);
  }
  async memoryClear(tenant: string, key: string): Promise<void> {
    this.memoryCalls.push(`clear:${tenant}:${key}`);
    this.memory.delete(`${tenant}|${key}`);
  }
  async report(tenant: string, r: BrokerReport, now: number): Promise<void> {
    this.reports.push({ tenant, r, now });
  }
  configured(): boolean {
    return typeof this.isConfigured === "function" ? this.isConfigured() : this.isConfigured;
  }
  async refreshDossier(): Promise<{ dossier: CoinDossier | null; changed: boolean; status: FomoEnvelope["status"]; reason: string | null }> {
    throw new Error("not used here");
  }
  async health(): Promise<FomoServiceHealth> {
    throw new Error("not used here");
  }
}

/** Resolves when the abort signal fires; never otherwise. */
function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
}

/** A gate the fake service waits on, to hold calls in flight. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

const tick = () => new Promise<void>((r) => setImmediate(r));
async function flush(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}
async function waitFor<T>(fn: () => T | undefined | null | false, limit = 200): Promise<T> {
  for (let i = 0; i < limit; i++) {
    const v = fn();
    if (v) return v;
    await tick();
  }
  assert.fail("condition never became true");
}

/**
 * Two connected in-memory ports. Delivery is asynchronous and through a JSON
 * round trip, like Node's default IPC serialisation.
 */
function portPair() {
  const toParent = new Set<(m: unknown) => void>();
  const toChild = new Set<(m: unknown) => void>();
  const childDisconnect = new Set<() => void>();
  let connected = true;
  const wire = { fromChild: [] as Record<string, unknown>[], fromParent: [] as Record<string, unknown>[] };
  const deliver = (to: Set<(m: unknown) => void>, msg: unknown): void => {
    const copy = JSON.parse(JSON.stringify(msg)) as unknown;
    setImmediate(() => {
      if (!connected) return;
      for (const h of [...to]) h(copy);
    });
  };
  const child: BrokerPort = {
    send(msg) {
      if (!connected) return false;
      wire.fromChild.push(JSON.parse(JSON.stringify(msg)) as Record<string, unknown>);
      deliver(toParent, msg);
      return true;
    },
    onMessage(h) {
      toChild.add(h);
      return () => void toChild.delete(h);
    },
    connected: () => connected,
    onDisconnect(h) {
      childDisconnect.add(h);
      return () => void childDisconnect.delete(h);
    },
  };
  const parent: BrokerPort = {
    send(msg) {
      if (!connected) return false;
      wire.fromParent.push(JSON.parse(JSON.stringify(msg)) as Record<string, unknown>);
      deliver(toChild, msg);
      return true;
    },
    onMessage(h) {
      toParent.add(h);
      return () => void toParent.delete(h);
    },
    connected: () => connected,
  };
  return {
    child,
    parent,
    wire,
    childListeners: () => toChild.size,
    parentListeners: () => toParent.size,
    /** Send raw bytes to the orchestrator as a (possibly hostile) child would. */
    inject: (msg: unknown) => deliver(toParent, msg),
    replyTo: (id: string) => wire.fromParent.find((m) => m.id === id),
    disconnect() {
      connected = false;
      for (const h of [...childDisconnect]) h();
    },
  };
}

function setup(serveOpts: Parameters<typeof serveBrokerRequests>[3] = {}, childOpts: Parameters<typeof createIpcBroker>[1] = {}) {
  const pair = portPair();
  const svc = new FakeService();
  const logs: string[] = [];
  let clock = NOW;
  let n = 0;
  const stop = serveBrokerRequests(pair.parent, ORCH_TENANT, svc, {
    now: () => clock,
    newId: () => `srv-${++n}`,
    log: (l) => logs.push(l),
    ...serveOpts,
  });
  const broker = createIpcBroker(pair.child, { now: () => clock, ...childOpts });
  return {
    pair,
    svc,
    logs,
    stop,
    broker,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function assessment(over: Partial<FollowAssessment> = {}): FollowAssessment {
  return {
    id: "fa_0123456789abcdef01234567",
    tenant: ORCH_TENANT,
    token: { chain: { namespace: "eip155", networkId: 4663, slug: "robinhood" }, address: A, key: RH_KEY },
    label: { symbol: "PEPE", name: "Pepe" },
    triggerEventKeys: ["evt-1"],
    state: "WATCH",
    reasonCodes: ["awaiting-cohort-buyer"],
    supporting: [],
    opposing: [],
    signalDelayMs: 1_000,
    researchDelayMs: 2_000,
    priceMovePct: null,
    decisionQuote: null,
    setupExpiresAt: null,
    horizon: "30m",
    invalidation: [],
    sizeCeilingUsdg6: null,
    dossierRevision: null,
    executionAvailability: "supported-authorized",
    createdAt: NOW,
    ...over,
  };
}

// ── envelopes ───────────────────────────────────────────────────────────────

describe("brokerFailureEnvelope", () => {
  it("is a complete envelope in the exact types.ts shape, with nothing claimed", () => {
    const env = brokerFailureEnvelope("fomo_get_token_theses", "broker-busy", "Busy right now.", NOW, "req-9");
    assert.deepEqual(env, {
      requestId: "req-9",
      tool: "fomo_get_token_theses",
      status: "failed",
      subject: null,
      candidates: [],
      data: null,
      evidence: [],
      freshness: {
        policy: "theses",
        mode: "prefer-fresh",
        retrievedAt: null,
        providerAsOf: null,
        sourceEventAt: { oldest: null, newest: null },
        lastRefreshAttemptAt: null,
        lastRefreshOutcome: null,
        cacheAgeMs: null,
        servedFrom: "none",
      },
      coverage: {
        requested: {},
        achieved: {},
        pagesRequested: 0,
        pagesReturned: 0,
        itemsReturned: 0,
        duplicatesRemoved: 0,
        providerTotal: null,
        capped: false,
        missing: [],
        notes: [],
      },
      usage: { providerCalls: 0, cacheHits: 0, creditsCharged: null, creditsRemaining: null },
      dossierRevision: null,
      reason: "broker-busy",
      message: "Busy right now.",
    });
    assert.ok(envelopeOf(env, "fomo_get_token_theses"), "a failure envelope passes the envelope shape check");
  });

  it("says unavailable for an unreachable broker, and keeps reasons and messages safe", () => {
    assert.equal(brokerFailureEnvelope("fomo_get_rankings", "broker-unavailable", "x", NOW).status, "unavailable");
    assert.equal(brokerFailureEnvelope("fomo_get_rankings", "timeout", "x", NOW).status, "failed");
    const odd = brokerFailureEnvelope("fomo_get_rankings", "Error: GET https://host/?key=SECRET", "line\u0000one‮ two", NOW);
    assert.equal(odd.reason, "broker-error");
    assert.equal(odd.message, "line one two");
    assert.match(odd.requestId, /^brk-1800000000000-/);
  });

  it("lists every registered tool", () => {
    assert.equal(FOMO_TOOL_NAMES.length, 11);
    for (const t of FOMO_TOOL_NAMES) assert.ok(isFomoToolName(t));
    assert.equal(isFomoToolName("fomo_place_order"), false);
    assert.equal(isFomoToolName("__proto__"), false);
  });
});

// ── direct broker ───────────────────────────────────────────────────────────

describe("createDirectBroker", () => {
  it("stamps the fixed tenant whatever the arguments say, and carries the trusted options", async () => {
    const svc = new FakeService();
    const broker = createDirectBroker(svc, "self", { now: () => NOW, newId: () => "rid-1" });
    const env = await broker.call("fomo_get_token_activity", { token: A, tenant: "0xevil" }, { ...DM, groupId: null });
    assert.equal(env.status, "ok");
    assert.equal(svc.invocations.length, 1);
    const { ctx, tool, args } = svc.invocations[0]!;
    assert.equal(ctx.tenant, "self");
    assert.equal(tool, "fomo_get_token_activity");
    assert.equal(ctx.requestId, "rid-1");
    assert.equal(ctx.now, NOW);
    assert.equal(ctx.surface, "telegram-dm");
    assert.equal(ctx.audience, "owner");
    assert.equal(ctx.conversationKey, "tg:dm:1");
    assert.equal(ctx.priority, "interactive");
    assert.equal(ctx.groupId, null);
    assert.ok(ctx.signal instanceof AbortSignal);
    // Tool args go to the service's own schema check untouched; the tenant is never read from them.
    assert.deepEqual(args, { token: A, tenant: "0xevil" });
  });

  it("passes the group id for budgets and demotes position protection outside background work", async () => {
    const svc = new FakeService();
    const broker = createDirectBroker(svc, "self", { now: () => NOW });
    await broker.call("fomo_get_rankings", {}, { surface: "telegram-group", audience: "group", conversationKey: "tg:g:7", priority: "position-protection", groupId: "-1001" });
    await broker.call("fomo_get_rankings", {}, { surface: "background", audience: "owner", conversationKey: null, priority: "position-protection" });
    assert.equal(svc.invocations[0]!.ctx.groupId, "-1001");
    assert.equal(svc.invocations[0]!.ctx.priority, "interactive");
    assert.equal(svc.invocations[1]!.ctx.priority, "position-protection");
  });

  it("enforces the timeout with an abort, answering a failed 'timeout' envelope", async () => {
    const svc = new FakeService();
    let seen: AbortSignal | undefined;
    svc.behaviour = (ctx) => {
      seen = ctx.signal;
      return untilAborted(ctx.signal);
    };
    const broker = createDirectBroker(svc, "self", { now: () => NOW });
    const env = await broker.call("fomo_research_coin", { token: A }, { ...DM, timeoutMs: 15 });
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "timeout");
    assert.equal(env.data, null);
    assert.equal(seen?.aborted, true, "the service is told to stop");
  });

  it("answers 'aborted' when the caller cancels", async () => {
    const svc = new FakeService();
    svc.behaviour = (ctx) => untilAborted(ctx.signal);
    const broker = createDirectBroker(svc, "self");
    const ac = new AbortController();
    const p = broker.call("fomo_research_coin", { token: A }, { ...DM, signal: ac.signal });
    ac.abort();
    assert.equal((await p).reason, "aborted");
    const pre = new AbortController();
    pre.abort();
    assert.equal((await broker.call("fomo_research_coin", {}, { ...DM, signal: pre.signal })).reason, "aborted");
  });

  it("turns a service exception or a malformed answer into a failed envelope with no secret in it", async () => {
    const svc = new FakeService();
    svc.behaviour = () => {
      throw new Error("GET https://provider.example/v2/x?apiKey=SECRET-KEY failed\n    at stack");
    };
    const logs: string[] = [];
    const broker = createDirectBroker(svc, "self", { log: (l) => logs.push(l) });
    const env = await broker.call("fomo_get_rankings", {}, DM);
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "service-error");
    assert.ok(!JSON.stringify(env).includes("SECRET"));
    assert.ok(!logs.join("\n").includes("SECRET"));
    svc.behaviour = () => ({ status: "ok", data: 1 });
    assert.equal((await broker.call("fomo_get_rankings", {}, DM)).reason, "service-error");
    // An envelope for a different tool than asked is not this call's answer.
    svc.behaviour = (ctx) => okEnvelope("fomo_get_token_theses", ctx);
    assert.equal((await broker.call("fomo_get_rankings", {}, DM)).reason, "service-error");
  });

  it("refuses malformed options and arguments without calling the service", async () => {
    const svc = new FakeService();
    const broker = createDirectBroker(svc, "self");
    const bad: unknown[] = [
      { ...DM, surface: "web" },
      { ...DM, audience: "everyone" },
      { ...DM, priority: "urgent" },
      { ...DM, conversationKey: "x".repeat(201) },
      { surface: "telegram-group", audience: "owner", conversationKey: null, priority: "interactive" },
    ];
    for (const o of bad) {
      const env = await broker.call("fomo_get_rankings", {}, o as BrokerCallOptions);
      assert.equal(env.reason, "invalid-request", JSON.stringify(o));
    }
    assert.equal((await broker.call("fomo_get_rankings", [] as unknown as Record<string, unknown>, DM)).reason, "invalid-request");
    assert.equal((await broker.call("fomo_place_order" as FomoToolName, {}, DM)).reason, "unknown-tool");
    assert.equal(svc.invocations.length, 0);
  });

  it("binds memory and reports to the fixed tenant, and never rejects", async () => {
    const svc = new FakeService();
    const broker = createDirectBroker(svc, "self", { now: () => NOW });
    await broker.memory.set("tg:dm:1", '{"version":1}');
    assert.equal(await broker.memory.get("tg:dm:1"), '{"version":1}');
    assert.equal(svc.memory.get("self|tg:dm:1"), '{"version":1}');
    await broker.memory.clear("tg:dm:1");
    assert.equal(await broker.memory.get("tg:dm:1"), null);
    svc.failMemory = true;
    assert.equal(await broker.memory.get("tg:dm:1"), null);
    await broker.memory.set("tg:dm:1", "{}");
    await broker.report({ kind: "assessment", assessment: assessment({ tenant: "SELF" }) });
    await broker.report({ kind: "assessment", assessment: assessment({ tenant: "0xevil" }) });
    assert.equal(svc.reports.length, 1, "only the own-tenant assessment is reported");
    assert.equal(svc.reports[0]!.tenant, "self");
    assert.equal(svc.reports[0]!.now, NOW);
  });

  it("mirrors configured() and refuses to start without a tenant", () => {
    const svc = new FakeService();
    svc.isConfigured = false;
    assert.equal(createDirectBroker(svc, "self").configured(), false);
    svc.isConfigured = () => {
      throw new Error("x");
    };
    assert.equal(createDirectBroker(svc, "self").configured(), false);
    assert.throws(() => createDirectBroker(svc, ""), TypeError);
    assert.throws(() => createDirectBroker(svc, "   "), TypeError);
  });
});

// ── request and report validation ───────────────────────────────────────────

describe("parseBrokerRequest and validateBrokerReport", () => {
  it("separates fields it does not define, so a tenant field is never read", () => {
    const p = parseBrokerRequest({ fomo: 1, id: "r1", op: "call", tool: "fomo_get_rankings", args: {}, opts: { ...DM, tenant: "0xevil" }, tenant: "0xevil" });
    assert.ok(p.ok);
    assert.deepEqual(p.extras.sort(), ["opts.tenant", "tenant"]);
    assert.ok(!("tenant" in p.request));
    assert.ok(p.ok && p.request.op === "call" && !("tenant" in p.request.opts));
  });

  it("refuses unknown ops, unknown tools, bad ids and non-object args", () => {
    assert.deepEqual(parseBrokerRequest({ fomo: 1, id: "r", op: "drop-tables" }), { ok: false, reason: "unknown-op" });
    assert.deepEqual(parseBrokerRequest({ fomo: 1, id: "r", op: "__proto__" }), { ok: false, reason: "unknown-op" });
    assert.deepEqual(parseBrokerRequest({ fomo: 1, id: "r", op: "call", tool: "fomo_trade", args: {}, opts: DM }), { ok: false, reason: "unknown-tool" });
    assert.equal(parseBrokerRequest({ fomo: 1, id: "x".repeat(65), op: "configured" }).ok, false);
    assert.equal(parseBrokerRequest({ fomo: 1, id: "bad id", op: "configured" }).ok, false);
    assert.equal(parseBrokerRequest({ fomo: 2, id: "r", op: "configured" }).ok, false);
    assert.equal(parseBrokerRequest({ fomo: 1, id: "r", op: "call", tool: "fomo_get_rankings", args: [1], opts: DM }).ok, false);
    assert.equal(parseBrokerRequest({ fomo: 1, id: "r", op: "call", tool: "fomo_get_rankings", args: {}, opts: { ...DM, surface: "mcp" } }).ok, false);
    assert.equal(parseBrokerRequest({ fomo: 1, id: "r", op: "memory-set", conversationKey: "k", json: "x".repeat(16_385) }).ok, false);
  });

  it("rebuilds reports field by field and refuses another tenant's assessment", () => {
    assert.deepEqual(validateBrokerReport({ kind: "assessment", assessment: assessment({ tenant: "0xEVIL" }) }, ORCH_TENANT), { ok: false, reason: "wrong-tenant" });
    const ok = validateBrokerReport({ kind: "assessment", assessment: { ...assessment({ tenant: ORCH_TENANT.toUpperCase().replace("0X", "0x") }), extra: 1 } }, ORCH_TENANT);
    assert.ok(ok.ok && ok.report.kind === "assessment" && ok.report.assessment.tenant === ORCH_TENANT && !("extra" in ok.report.assessment));
    const funnel = validateBrokerReport({ kind: "funnel", tokenKey: RH_KEY, stage: "MODEL_HOLD", detail: "held‮", decisionId: null, atMs: NOW, tenant: "0xevil" }, ORCH_TENANT);
    assert.deepEqual(funnel, { ok: true, report: { kind: "funnel", tokenKey: RH_KEY, stage: "MODEL_HOLD", detail: "held", decisionId: null, atMs: NOW } });
    assert.equal(validateBrokerReport({ kind: "funnel", tokenKey: RH_KEY.toUpperCase(), stage: "MODEL_HOLD", detail: "", decisionId: null, atMs: NOW }, ORCH_TENANT).ok, false);
    assert.equal(validateBrokerReport({ kind: "funnel", tokenKey: RH_KEY, stage: "BOUGHT", detail: "", decisionId: null, atMs: NOW }, ORCH_TENANT).ok, false);
    assert.equal(validateBrokerReport({ kind: "held-tokens", tokenKeys: [RH_KEY, `eip155:4663:0x${"A1".repeat(20)}`], atMs: NOW }, ORCH_TENANT).ok, false);
    assert.deepEqual(validateBrokerReport({ kind: "held-tokens", tokenKeys: [RH_KEY, SOL_KEY, RH_KEY], atMs: NOW }, ORCH_TENANT), {
      ok: true,
      report: { kind: "held-tokens", tokenKeys: [RH_KEY, SOL_KEY], atMs: NOW },
    });
    assert.equal(validateBrokerReport({ kind: "outcome", assessmentId: "fa_1", horizonLabel: "1h", observedAtMs: NOW, price8: "1.123456789", note: null }, ORCH_TENANT).ok, false);
    assert.equal(validateBrokerReport({ kind: "outcome", assessmentId: "fa_1", horizonLabel: "1h", observedAtMs: NOW, price8: "1.12345678", note: null }, ORCH_TENANT).ok, true);
    assert.equal(validateBrokerReport({ kind: "position-dependency", userId: "3f2a9c1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b", tokenKey: RH_KEY, reason: "held", expiresAtMs: NOW + 1 }, ORCH_TENANT).ok, true);
    assert.equal(validateBrokerReport({ kind: "order", tokenKey: RH_KEY }, ORCH_TENANT).ok, false);
  });
});

// ── IPC ─────────────────────────────────────────────────────────────────────

describe("IPC broker round trip", () => {
  it("answers calls with the orchestrator's tenant, and memory, reports and configured over the same channel", async () => {
    const { pair, svc, broker } = setup();
    assert.equal(broker.configured(), false, "unknown is not configured");
    await waitFor(() => broker.configured());
    const env = await broker.call("fomo_get_trader_activity", { trader: "abc" }, { ...DM, groupId: null });
    assert.equal(env.status, "ok");
    assert.deepEqual(env.data, { rows: [1, 2, 3] });
    const { ctx } = svc.invocations[0]!;
    assert.equal(ctx.tenant, ORCH_TENANT);
    assert.equal(ctx.requestId, "srv-1", "the orchestrator, not the child, names the request");
    assert.equal(ctx.surface, "telegram-dm");
    assert.equal(ctx.conversationKey, "tg:dm:1");
    const sent = pair.wire.fromChild.find((m) => m.op === "call")!;
    assert.ok(!("tenant" in sent), "the child never sends a tenant");
    assert.equal((sent.opts as Record<string, unknown>).timeoutMs, BROKER_LIMITS.childTimeoutMs);

    await broker.memory.set("tg:dm:1", '{"version":1}');
    assert.equal(svc.memory.get(`${ORCH_TENANT}|tg:dm:1`), '{"version":1}');
    assert.equal(await broker.memory.get("tg:dm:1"), '{"version":1}');
    await broker.memory.clear("tg:dm:1");
    assert.equal(await broker.memory.get("tg:dm:1"), null);

    await broker.report({ kind: "funnel", tokenKey: RH_KEY, stage: "GATE_FORCED_HOLD", detail: "gate", decisionId: "d-1", atMs: NOW });
    assert.equal(svc.reports.length, 1);
    assert.equal(svc.reports[0]!.tenant, ORCH_TENANT);
    assert.deepEqual(svc.reports[0]!.r, { kind: "funnel", tokenKey: RH_KEY, stage: "GATE_FORCED_HOLD", detail: "gate", decisionId: "d-1", atMs: NOW });
  });

  it("a request carrying tenant '0xevil' still runs as the orchestrator's tenant, logged once", async () => {
    const { pair, svc, logs } = setup();
    pair.inject({ fomo: 1, id: "evil-1", op: "call", tool: "fomo_get_rankings", args: {}, opts: { ...DM, tenant: "0xevil" }, tenant: "0xevil" });
    pair.inject({ fomo: 1, id: "evil-2", op: "memory-set", conversationKey: "k", json: "{}", tenant: "0xevil" });
    pair.inject({ fomo: 1, id: "evil-3", op: "call", tool: "fomo_get_rankings", args: {}, opts: DM, tenant: "0xevil" });
    await waitFor(() => pair.replyTo("evil-1") && pair.replyTo("evil-2") && pair.replyTo("evil-3"));
    assert.equal(svc.invocations.length, 2);
    for (const i of svc.invocations) assert.equal(i.ctx.tenant, ORCH_TENANT);
    assert.equal(svc.memory.get(`${ORCH_TENANT}|k`), "{}");
    assert.ok(![...svc.memory.keys()].some((k) => k.includes("evil")));
    assert.equal(logs.filter((l) => l.includes('"tenant"')).length, 1, "the ignored field is logged once");
    assert.equal(logs.filter((l) => l.includes('"opts.tenant"')).length, 1);
    assert.ok(!logs.join("\n").includes("0xevil"), "the forged value itself is never logged");
  });

  it("refuses malformed, unknown and oversized requests and ignores what is not addressed to it", async () => {
    const { pair, svc } = setup();
    pair.inject({ hello: "another IPC user" });
    pair.inject({ fomo: 1, op: "configured" });
    pair.inject({ fomo: 1, id: "x".repeat(65), op: "configured" });
    pair.inject({ fomo: 1, id: "u1", op: "sign" });
    pair.inject({ fomo: 1, id: "u2", op: "call", tool: "fomo_buy", args: {}, opts: DM });
    pair.inject({ fomo: 1, id: "u3", op: "call", tool: "fomo_get_rankings", args: [], opts: DM });
    pair.inject({ fomo: 1, id: "u4", op: "call", tool: "fomo_get_rankings", args: {}, opts: { ...DM, surface: "app-chat" } });
    pair.inject({ fomo: 1, id: "u5", op: "call", tool: "fomo_get_rankings", args: {}, opts: { surface: "telegram-group", audience: "owner", conversationKey: null, priority: "interactive" } });
    pair.inject({ fomo: 1, id: "u6", op: "call", tool: "fomo_get_rankings", args: {}, opts: { ...DM, conversationKey: "k".repeat(201) } });
    pair.inject({ fomo: 1, id: "u7", op: "call", tool: "fomo_get_rankings", args: { blob: "x".repeat(17_000) }, opts: DM });
    pair.inject({ fomo: 1, id: "u8", op: "report", report: "not an object" });
    pair.inject({ fomo: 1, id: "u9", op: "memory-get", conversationKey: "" });
    await waitFor(() => ["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8", "u9"].every((id) => pair.replyTo(id)));
    await flush();
    const err = (id: string) => pair.replyTo(id)!.error;
    assert.equal(err("u1"), "unknown-op");
    assert.equal(err("u2"), "unknown-tool");
    for (const id of ["u3", "u4", "u5", "u6", "u9"]) assert.equal(err(id), "invalid-request", id);
    assert.equal(err("u7"), "request-too-large");
    assert.equal(err("u8"), "invalid-report");
    // Exactly the nine replies above (beside the broker's own configured
    // query): nothing answered the foreign or id-less messages.
    const childIds = new Set(pair.wire.fromChild.map((m) => m.id));
    const injectedReplies = pair.wire.fromParent.filter((m) => !childIds.has(m.id));
    assert.equal(injectedReplies.length, 9);
    assert.ok(injectedReplies.every((m) => m.ok === false));
    assert.equal(svc.invocations.length, 0);
    assert.equal(svc.memoryCalls.length, 0);
  });

  it("the child refuses to send an oversized request at all", async () => {
    const { pair, svc, broker } = setup();
    await flush();
    const before = pair.wire.fromChild.length;
    const env = await broker.call("fomo_get_token_theses", { token: "x".repeat(20_000) }, DM);
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "request-too-large");
    assert.equal(pair.wire.fromChild.length, before);
    assert.equal(svc.invocations.length, 0);
    const bigint = await broker.call("fomo_get_token_theses", { n: 1n } as unknown as Record<string, unknown>, DM);
    assert.equal(bigint.reason, "invalid-request");
  });

  it("caps calls per rolling minute with a failed 'rate-limited' envelope", async () => {
    const { svc, broker, advance } = setup({ perMinute: 3 });
    for (let i = 0; i < 3; i++) assert.equal((await broker.call("fomo_get_rankings", {}, DM)).status, "ok");
    const limited = await broker.call("fomo_get_rankings", {}, DM);
    assert.equal(limited.status, "failed");
    assert.equal(limited.reason, "rate-limited");
    assert.equal(svc.invocations.length, 3);
    advance(60_000);
    assert.equal((await broker.call("fomo_get_rankings", {}, DM)).status, "ok");
  });

  it("caps concurrent calls per child, and frees a slot only when the service is done", async () => {
    const { svc, broker } = setup({ maxInFlight: 2 });
    const g = gate();
    svc.behaviour = async (ctx, tool) => {
      await g.wait;
      return okEnvelope(tool, ctx);
    };
    const first = broker.call("fomo_get_rankings", {}, DM);
    const second = broker.call("fomo_get_rankings", {}, DM);
    await waitFor(() => svc.invocations.length === 2);
    const third = await broker.call("fomo_get_rankings", {}, DM);
    assert.equal(third.reason, "rate-limited");
    g.open();
    assert.equal((await first).status, "ok");
    assert.equal((await second).status, "ok");
    await flush();
    assert.equal((await broker.call("fomo_get_rankings", {}, DM)).status, "ok");
  });

  it("the orchestrator bounds a slow call itself and tells the service to stop", async () => {
    const { svc, broker } = setup({ maxCallMs: 20 });
    let seen: AbortSignal | undefined;
    svc.behaviour = (ctx) => {
      seen = ctx.signal;
      return untilAborted(ctx.signal);
    };
    const env = await broker.call("fomo_research_coin", { token: A }, { ...DM, timeoutMs: 5_000 });
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "timeout");
    assert.equal(seen?.aborted, true);
  });

  it("a service exception crosses the wire as a failed envelope without its text", async () => {
    const { svc, broker, logs } = setup();
    svc.behaviour = () => {
      throw new Error("Bearer SECRET-TOKEN rejected by https://provider.example");
    };
    const env = await broker.call("fomo_get_rankings", {}, DM);
    assert.equal(env.reason, "service-error");
    assert.ok(!JSON.stringify(env).includes("SECRET"));
    assert.ok(!logs.join("\n").includes("SECRET"));
  });

  it("trims an oversized answer to fit, saying so, and never sends more than the limit", async () => {
    const { pair, svc, broker } = setup({ maxResponseBytes: 64 * 1024 });
    svc.behaviour = (ctx, tool) => okEnvelope(tool, ctx, { blob: "x".repeat(300 * 1024) });
    const env = await broker.call("fomo_get_token_theses", { token: A }, DM);
    assert.equal(env.status, "partial");
    assert.equal(env.data, null);
    assert.equal(env.coverage.capped, true);
    assert.ok(env.coverage.missing.includes("data"));
    assert.ok(env.coverage.notes.some((n) => /too large/.test(n)));
    for (const m of pair.wire.fromParent) assert.ok(Buffer.byteLength(JSON.stringify(m)) <= 64 * 1024);

    // A stale copy stays labelled stale when trimmed.
    svc.behaviour = (ctx, tool) => ({ ...okEnvelope(tool, ctx, "y".repeat(100 * 1024)), status: "stale" });
    assert.equal((await broker.call("fomo_get_token_theses", { token: A }, DM)).status, "stale");

    // Evidence alone over the limit: the long lists go too.
    svc.behaviour = (ctx, tool) => ({
      ...okEnvelope(tool, ctx),
      evidence: Array.from({ length: 3_000 }, (_, i) => ({ id: `fomo:thesis/${"t".repeat(20)}${i}`, kind: "thesis", sourceUrl: null })),
    });
    const bare = await broker.call("fomo_get_token_theses", { token: A }, DM);
    assert.equal(bare.status, "partial");
    assert.deepEqual(bare.evidence, []);
  });

  it("a report about another tenant's assessment is refused and never stored", async () => {
    const { pair, svc, broker } = setup();
    await broker.report({ kind: "assessment", assessment: assessment({ tenant: "0x00000000000000000000000000000000000000b2" }) });
    assert.equal(svc.reports.length, 0);
    const refused = pair.wire.fromParent.find((m) => m.ok === false);
    assert.equal(refused?.error, "wrong-tenant");
    await broker.report({ kind: "assessment", assessment: assessment({ tenant: ORCH_TENANT.replace("a1", "A1") }) });
    assert.equal(svc.reports.length, 1);
    assert.equal(svc.reports[0]!.tenant, ORCH_TENANT);
    await broker.report({ kind: "held-tokens", tokenKeys: [RH_KEY, "eip155:4663:not-an-address"], atMs: NOW });
    assert.equal(svc.reports.length, 1, "a held-tokens report with a forged key is refused whole");
  });

  it("fails fast as unavailable when disconnected, and on disconnect mid-request", async () => {
    const { pair, svc, broker } = setup({}, { timeoutMs: 10_000 });
    const g = gate();
    svc.behaviour = async (ctx, tool) => {
      await g.wait;
      return okEnvelope(tool, ctx);
    };
    const pending = broker.call("fomo_get_rankings", {}, DM);
    await waitFor(() => svc.invocations.length === 1);
    const started = Date.now();
    pair.disconnect();
    const env = await pending;
    assert.equal(env.status, "unavailable");
    assert.equal(env.reason, "broker-unavailable");
    assert.ok(Date.now() - started < 5_000, "did not wait for the timeout");
    const after = await broker.call("fomo_get_rankings", {}, DM);
    assert.equal(after.reason, "broker-unavailable");
    assert.equal(await broker.memory.get("k"), null);
    g.open();
  });

  it("answers unavailable when send is refused, and busy past the child's own cap", async () => {
    const refusing: BrokerPort = { send: () => false, onMessage: () => () => {}, connected: () => true };
    const b1 = createIpcBroker(refusing);
    assert.equal((await b1.call("fomo_get_rankings", {}, DM)).reason, "broker-unavailable");
    const throwing: BrokerPort = {
      send: () => {
        throw new Error("EPIPE");
      },
      onMessage: () => () => {},
      connected: () => true,
    };
    assert.equal((await createIpcBroker(throwing).call("fomo_get_rankings", {}, DM)).reason, "broker-unavailable");

    const { svc, broker } = setup({}, { maxInFlight: 2 });
    await flush();
    const g = gate();
    svc.behaviour = async (ctx, tool) => {
      await g.wait;
      return okEnvelope(tool, ctx);
    };
    const a = broker.call("fomo_get_rankings", {}, DM);
    const b = broker.call("fomo_get_rankings", {}, DM);
    const busy = await broker.call("fomo_get_rankings", {}, DM);
    assert.equal(busy.reason, "broker-busy");
    g.open();
    assert.equal((await a).status, "ok");
    assert.equal((await b).status, "ok");
  });

  it("times out as 'broker-timeout' when no answer arrives", async () => {
    const silent: BrokerPort = { send: () => true, onMessage: () => () => {}, connected: () => true };
    const broker = createIpcBroker(silent, { timeoutMs: 20 });
    const env = await broker.call("fomo_get_rankings", {}, DM);
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "broker-timeout");
    assert.ok(env.coverage.notes.length > 0, "the timeout says usage is not a complete count");
    assert.equal(await broker.memory.get("k"), null);
    broker.close();
  });

  it("matches answers only by id and checks their shape", async () => {
    let handler: ((m: unknown) => void) | null = null;
    const sent: Record<string, unknown>[] = [];
    const port: BrokerPort = {
      send: (m) => {
        sent.push(m as unknown as Record<string, unknown>);
        return true;
      },
      onMessage: (h) => {
        handler = h;
        return () => {
          handler = null;
        };
      },
      connected: () => true,
    };
    const broker = createIpcBroker(port, { timeoutMs: 200 });
    const deliver = (m: unknown) => handler?.(m);
    const call = (tool: FomoToolName = "fomo_get_rankings") => broker.call(tool, {}, DM);

    let p = call();
    let id = sent.at(-1)!.id as string;
    deliver({ fomo: 1, id: "someone-else", ok: true, result: okEnvelope("fomo_get_rankings", { ...ctxFor(), requestId: "r" }) });
    deliver({ fomo: 1, id, ok: "yes" });
    assert.equal((await p).reason, "broker-bad-response");

    p = call();
    id = sent.at(-1)!.id as string;
    deliver({ fomo: 1, id, ok: true, result: { status: "ok" } });
    assert.equal((await p).reason, "broker-bad-response");

    p = call("fomo_get_rankings");
    id = sent.at(-1)!.id as string;
    deliver({ fomo: 1, id, ok: true, result: okEnvelope("fomo_get_token_theses", { ...ctxFor(), requestId: "r" }) });
    assert.equal((await p).reason, "broker-bad-response", "an answer for another tool is not this call's answer");

    p = call();
    id = sent.at(-1)!.id as string;
    deliver({ fomo: 1, id, ok: false, error: "Error: secret stack\n at x" });
    const refused = await p;
    assert.equal(refused.reason, "broker-refused", "a free-text error never becomes the reason");

    p = call();
    id = sent.at(-1)!.id as string;
    deliver({ fomo: 1, id, ok: true, result: okEnvelope("fomo_get_rankings", { ...ctxFor(), requestId: "r-good" }) });
    assert.equal((await p).requestId, "r-good");
  });

  it("listens only while a request is open, and close() settles what is pending", async () => {
    const { pair, svc, broker } = setup();
    await waitFor(() => broker.configured());
    await flush();
    assert.equal(pair.childListeners(), 0, "idle: no listener holding the channel open");
    const g = gate();
    svc.behaviour = async (ctx, tool) => {
      await g.wait;
      return okEnvelope(tool, ctx);
    };
    const p = broker.call("fomo_get_rankings", {}, DM);
    assert.equal(pair.childListeners(), 1);
    broker.close();
    assert.equal((await p).reason, "broker-unavailable");
    assert.equal(pair.childListeners(), 0);
    assert.equal((await broker.call("fomo_get_rankings", {}, DM)).reason, "broker-unavailable");
    g.open();
  });

  it("refreshes configured() at most once a minute", async () => {
    const { pair, svc, broker, advance } = setup();
    await waitFor(() => broker.configured());
    svc.isConfigured = false;
    broker.configured();
    broker.configured();
    await flush();
    assert.equal(broker.configured(), true, "still the cached answer inside the minute");
    assert.equal(pair.wire.fromChild.filter((m) => m.op === "configured").length, 1);
    advance(60_000);
    broker.configured();
    await waitFor(() => !broker.configured());
    assert.equal(pair.wire.fromChild.filter((m) => m.op === "configured").length, 2);
  });

  it("stops answering once unsubscribed, and ignores a reused in-flight id", async () => {
    const { pair, svc, stop } = setup();
    const g = gate();
    svc.behaviour = async (ctx, tool) => {
      await g.wait;
      return okEnvelope(tool, ctx);
    };
    pair.inject({ fomo: 1, id: "dup", op: "call", tool: "fomo_get_rankings", args: {}, opts: DM });
    await waitFor(() => svc.invocations.length === 1);
    pair.inject({ fomo: 1, id: "dup", op: "call", tool: "fomo_get_rankings", args: {}, opts: DM });
    await flush();
    assert.equal(svc.invocations.length, 1);
    g.open();
    await waitFor(() => pair.replyTo("dup"));
    stop();
    assert.equal(pair.parentListeners(), 0);
    pair.inject({ fomo: 1, id: "late", op: "configured" });
    await flush();
    assert.equal(pair.replyTo("late"), undefined);
  });

  it("refuses to serve without a tenant", () => {
    const pair = portPair();
    assert.throws(() => serveBrokerRequests(pair.parent, "", new FakeService()), TypeError);
  });
});

function ctxFor(): FomoCallContext {
  return { tenant: ORCH_TENANT, surface: "telegram-dm", audience: "owner", conversationKey: null, requestId: "r", now: NOW, priority: "interactive" };
}

// ── process ports ───────────────────────────────────────────────────────────

class FakeProc extends EventEmitter {
  connected = true;
  sent: unknown[][] = [];
  throwOnSend = false;
  send?: (...args: unknown[]) => boolean = (...args: unknown[]) => {
    if (this.throwOnSend) throw new Error("channel closed");
    this.sent.push(args);
    return false; // Node returns false on backlog too; the message is still queued.
  };
}

describe("process ports", () => {
  it("processBrokerPort is null without an IPC channel", () => {
    const p = new FakeProc();
    p.send = undefined;
    assert.equal(processBrokerPort(p as unknown as NodeJS.Process), null);
  });

  it("processBrokerPort sends with a callback, reports connection, and subscribes/unsubscribes", () => {
    const p = new FakeProc();
    const port = processBrokerPort(p as unknown as NodeJS.Process)!;
    assert.equal(port.send({ fomo: 1, id: "a", op: "configured" }), true, "a backlogged send is still a send");
    assert.equal(typeof p.sent[0]![3], "function", "a callback swallows close races instead of an 'error' event");
    const got: unknown[] = [];
    const off = port.onMessage((m) => got.push(m));
    p.emit("message", { x: 1 });
    off();
    p.emit("message", { x: 2 });
    assert.deepEqual(got, [{ x: 1 }]);
    assert.equal(p.listenerCount("message"), 0);
    let closed = 0;
    const offD = port.onDisconnect!(() => closed++);
    p.emit("disconnect");
    offD();
    assert.equal(closed, 1);
    p.throwOnSend = true;
    assert.equal(port.send({ fomo: 1, id: "b", op: "configured" }), false);
    p.connected = false;
    p.throwOnSend = false;
    assert.equal(port.connected(), false);
    assert.equal(port.send({ fomo: 1, id: "c", op: "configured" }), false);
    assert.equal(p.sent.length, 1);
  });

  it("childProcessBrokerPort mirrors it on the orchestrator side", () => {
    const c = new FakeProc();
    const port = childProcessBrokerPort(c as unknown as import("node:child_process").ChildProcess);
    assert.equal(port.send({ fomo: 1, id: "a", ok: true, result: null }), true);
    assert.equal(typeof c.sent[0]![1], "function");
    const got: unknown[] = [];
    const off = port.onMessage((m) => got.push(m));
    c.emit("message", "hi");
    off();
    assert.deepEqual(got, ["hi"]);
    c.connected = false;
    assert.equal(port.send({ fomo: 1, id: "b", ok: true, result: null }), false);
  });

  it("works end to end over a real forked child's IPC channel, and the child still exits on its own", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fomo-broker-ipc-"));
    try {
      const brokerUrl = pathToFileURL(path.join(path.dirname(new URL(import.meta.url).pathname), "broker.ts")).href;
      const script = path.join(dir, "child.mts");
      writeFileSync(
        script,
        `import { createIpcBroker, processBrokerPort } from ${JSON.stringify(brokerUrl)};
const port = processBrokerPort();
if (!port) process.exit(3);
const broker = createIpcBroker(port, { timeoutMs: 10000 });
const env = await broker.call("fomo_get_rankings", { board: "traders" }, { surface: "telegram-dm", audience: "owner", conversationKey: "tg:dm:9", priority: "interactive" });
await broker.memory.set("tg:dm:9", '{"version":1}');
const mem = await broker.memory.get("tg:dm:9");
process.send({ done: true, status: env.status, data: env.data, mem, configured: broker.configured() });
`,
      );
      const svc = new FakeService();
      svc.behaviour = (ctx, tool) => okEnvelope(tool, ctx, { tenantSeen: ctx.tenant });
      const child = fork(script, [], { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"], cwd: process.cwd() });
      let stderr = "";
      child.stderr?.on("data", (c: Buffer) => (stderr += String(c)));
      const stop = serveBrokerRequests(childProcessBrokerPort(child), ORCH_TENANT, svc);
      const done = new Promise<Record<string, unknown>>((resolve) =>
        child.on("message", (m: unknown) => {
          if (m && typeof m === "object" && (m as Record<string, unknown>).done) resolve(m as Record<string, unknown>);
        }),
      );
      const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
      const result: Record<string, unknown> = await Promise.race([done, exited.then((code) => ({ exitedEarly: code, stderr }))]);
      assert.equal(result.status, "ok", JSON.stringify(result));
      assert.deepEqual(result.data, { tenantSeen: ORCH_TENANT });
      assert.equal(result.mem, '{"version":1}');
      assert.equal(svc.invocations[0]!.ctx.tenant, ORCH_TENANT);
      // No listener left on the child's process, so it ends by itself.
      assert.equal(await exited, 0, stderr);
      stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
