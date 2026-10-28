/**
 * THE FLOW BROKER — how a hosted child asks the orchestrator for flow facts
 * without holding a key, and how the orchestrator answers without letting one
 * child spend the fleet's day.
 *
 *   createFlowClient     hosted child: asks over the fork's IPC channel, or
 *                        answers "unavailable" at once when there is none.
 *   serveFlowRequests    orchestrator: answers ONE child, under that child's
 *                        own rate, with the lane's budget behind it.
 *
 * MODELLED ON fomo/broker.ts and sharing its channel. The two never read each
 * other's messages: Fomo's carry `fomo: 1`, these carry `flow: 1`, and each end
 * ignores everything else on the wire. The channel exists only while the Fomo
 * pass is on (orchestrator.ts spawnChild); without it this broker answers
 * "unavailable" immediately rather than waiting out a timeout.
 *
 * WHAT A CHILD MAY ASK. One thing: the flow facts for a token address — and
 * how long it will wait for them (`timeoutMs`), which can only shorten the
 * orchestrator's work, never lengthen it. Not a
 * query, not a window, not a limit, not a creator — the orchestrator resolves
 * the creator itself from the chain, so a child cannot point the lane at an
 * arbitrary wallet and learn what it sold. Not a tenant either: market flow is
 * not tenant-scoped, and the only per-tenant thing here — whether this child
 * may ask at all — is decided by the orchestrator from the process the bytes
 * arrived on (the `allowed` hook), never from anything in a message.
 *
 * WHAT IT CAN COST. Every answer is either a FlowResult or a refusal word; a
 * timeout, a dead channel, a busy lane and a full day all come back as words
 * from flow-facts.ts. Nothing here throws at a caller or waits unbounded.
 */

import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { flowResultOf, type FlowFailure, type FlowResult } from "./flow-facts";

export const FLOW_BROKER_LIMITS = Object.freeze({
  /** A child's bound on one request, IPC included; above the orchestrator's own ceiling, so it answers first. */
  childTimeoutMs: 25_000,
  /** Distinct tokens one child keeps open at once before answering "budget". */
  childMaxInFlight: 4,
  /** Distinct tokens one child may have the orchestrator working on at once. */
  serveMaxInFlight: 2,
  /** Requests one child may start per rolling minute. A repeat of one in flight is free. */
  servePerMinute: 6,
  /** The orchestrator's ceiling on one answer, whatever the child would wait. */
  serveMaxCallMs: 22_000,
  /**
   * Taken off the wait a child says it will give an answer, for the trip
   * back over IPC: the orchestrator stops working on a reading this much
   * before the child stops waiting for it, so nothing is paid for after.
   */
  ipcMarginMs: 250,
  maxRequestBytes: 1024,
  maxResponseBytes: 16 * 1024,
  idChars: 64,
});

/**
 * SET TO "1" IN A CHILD'S ENVIRONMENT ONLY WHEN SOMEBODY WILL ANSWER: the
 * orchestrator's flow service is on and the child gets the IPC channel
 * (orchestrator.ts childEnv). Never inherited from the operator's own
 * environment. Without it a child does not ask, so it never waits out a
 * timeout for a broker that was never attached.
 */
export const FLOW_BROKER_ENV = "MERRYMEN_FLOW_BROKER";

export interface FlowRequest {
  flow: 1;
  id: string;
  op: "facts";
  token: string;
  /**
   * How long the child waits for this answer. The orchestrator works on it
   * for at most this, less ipcMarginMs, and never past its own ceiling
   * (serveMaxCallMs); the lane then sends nothing it could not finish in that
   * time. Absent (an older child): the orchestrator's own ceiling.
   */
  timeoutMs?: number;
}

export type FlowResponse = { flow: 1; id: string; ok: true; result: FlowResult } | { flow: 1; id: string; ok: false; error: string };

/** One end of a message channel; the same contract as fomo/broker.ts BrokerPort, with this broker's messages. */
export interface FlowPort {
  send(msg: FlowRequest | FlowResponse): boolean;
  onMessage(handler: (msg: unknown) => void): () => void;
  connected(): boolean;
  onDisconnect?(handler: () => void): () => void;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);
const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const FIELD_SHAPE = /^[A-Za-z0-9_.-]{1,40}$/;

const idOf = (v: unknown): string | null => (typeof v === "string" && v.length <= FLOW_BROKER_LIMITS.idChars && ID_SHAPE.test(v) ? v : null);
const tokenOf = (v: unknown): `0x${string}` | null => (typeof v === "string" && ADDRESS.test(v) && !/^0x0{40}$/i.test(v) ? (v.toLowerCase() as `0x${string}`) : null);
const fail = (failure: FlowFailure): FlowResult => ({ ok: false, failure });

function jsonBytes(v: unknown): number | null {
  try {
    const s = JSON.stringify(v);
    return typeof s === "string" ? Buffer.byteLength(s, "utf8") : null;
  } catch {
    return null;
  }
}

// ── ports ───────────────────────────────────────────────────────────────────

/**
 * The forked child's end, or null without a channel. Same two decisions as
 * fomo/broker.ts processBrokerPort: send() passes a callback so a send on a
 * closing channel cannot emit an unhandled 'error' and kill the child, and a
 * backlogged send counts as sent because Node still delivers it.
 */
export function processFlowPort(proc: NodeJS.Process = process): FlowPort | null {
  if (typeof proc.send !== "function") return null;
  return {
    send(msg) {
      if (proc.connected !== true || typeof proc.send !== "function") return false;
      try {
        proc.send(msg, undefined, undefined, () => {});
        return true;
      } catch {
        return false;
      }
    },
    onMessage(handler) {
      const listener = (m: unknown): void => handler(m);
      proc.on("message", listener);
      return () => {
        proc.off("message", listener);
      };
    },
    connected: () => proc.connected === true,
    onDisconnect(handler) {
      proc.on("disconnect", handler);
      return () => {
        proc.off("disconnect", handler);
      };
    },
  };
}

/** The orchestrator's end of one child's channel. The callback swallows a close race that would otherwise take this process down. */
export function childProcessFlowPort(child: ChildProcess): FlowPort {
  return {
    send(msg) {
      if (child.connected !== true || typeof child.send !== "function") return false;
      try {
        child.send(msg, () => {});
        return true;
      } catch {
        return false;
      }
    },
    onMessage(handler) {
      const listener = (m: unknown): void => handler(m);
      child.on("message", listener);
      return () => {
        child.off("message", listener);
      };
    },
    connected: () => child.connected === true,
    onDisconnect(handler) {
      child.on("disconnect", handler);
      return () => {
        child.off("disconnect", handler);
      };
    },
  };
}

// ── the child's client ──────────────────────────────────────────────────────

export interface FlowClient {
  /** Flow facts for a token, or the word for why not. Never throws, never waits past its bound. */
  facts(token: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<FlowResult>;
  close(): void;
}

export interface FlowClientOptions {
  timeoutMs?: number;
  maxInFlight?: number;
  newId?: () => string;
}

/** What a refusal word from the orchestrator means to a caller. */
function refusalFailure(error: unknown): FlowFailure {
  if (error === "rate-limited") return "budget";
  if (error === "invalid-request" || error === "request-too-large") return "invalid-request";
  return "unavailable";
}

/**
 * The hosted child's client. A repeat question for a token already in flight
 * shares that request. It listens on the channel only while something is
 * pending, so wiring it into a child never changes when that child can exit
 * (the fomo broker's reason, and the same listener discipline).
 */
export function createFlowClient(port: FlowPort | null, opts: FlowClientOptions = {}): FlowClient {
  const defaultTimeout = Math.max(1, Math.min(opts.timeoutMs ?? FLOW_BROKER_LIMITS.childTimeoutMs, 120_000));
  const maxInFlight = Math.max(1, Math.trunc(opts.maxInFlight ?? FLOW_BROKER_LIMITS.childMaxInFlight));
  const newId = opts.newId ?? randomUUID;
  const pending = new Map<string, (r: FlowResult) => void>();
  const byToken = new Map<string, Promise<FlowResult>>();
  let unsubscribe: (() => void) | null = null;
  let unsubscribeDisconnect: (() => void) | null = null;
  let closed = false;

  const onMessage = (msg: unknown): void => {
    if (!isRec(msg) || msg.flow !== 1 || typeof msg.id !== "string") return;
    const settle = pending.get(msg.id);
    if (!settle) return;
    if (msg.ok === true) settle(flowResultOf(msg.result) ?? fail("invalid-shape"));
    else if (msg.ok === false) settle(fail(refusalFailure(msg.error)));
    else settle(fail("invalid-shape"));
  };
  const onDisconnect = (): void => {
    for (const settle of [...pending.values()]) settle(fail("unavailable"));
  };
  const subscribe = (): void => {
    if (unsubscribe || !port) return;
    unsubscribe = port.onMessage(onMessage);
    unsubscribeDisconnect = port.onDisconnect?.(onDisconnect) ?? null;
  };
  const unsubscribeIfIdle = (): void => {
    if (pending.size > 0 || !unsubscribe) return;
    unsubscribe();
    unsubscribe = null;
    unsubscribeDisconnect?.();
    unsubscribeDisconnect = null;
  };
  const connected = (): boolean => {
    try {
      return port?.connected() === true;
    } catch {
      return false;
    }
  };

  function ask(token: `0x${string}`, timeoutMs: number, signal?: AbortSignal): Promise<FlowResult> {
    if (closed || !port || !connected()) return Promise.resolve(fail("unavailable"));
    if (signal?.aborted) return Promise.resolve(fail("timeout"));
    if (pending.size >= maxInFlight) return Promise.resolve(fail("budget"));
    const fresh = idOf(newId());
    const id = fresh && !pending.has(fresh) ? fresh : randomUUID();
    // The wait goes with the question, so the orchestrator stops when this child does.
    const msg: FlowRequest = { flow: 1, id, op: "facts", token, timeoutMs };
    return new Promise<FlowResult>((resolve) => {
      let done = false;
      const onAbort = (): void => settle(fail("timeout"));
      const timer = setTimeout(() => settle(fail("timeout")), timeoutMs);
      function settle(r: FlowResult): void {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        pending.delete(id);
        unsubscribeIfIdle();
        resolve(r);
      }
      // Registered BEFORE send, so even a synchronous reply finds its request.
      pending.set(id, settle);
      subscribe();
      signal?.addEventListener("abort", onAbort, { once: true });
      let sent = false;
      try {
        sent = port.send(msg) === true;
      } catch {
        sent = false;
      }
      if (!sent) settle(fail("unavailable"));
    });
  }

  return {
    facts(raw, o = {}) {
      const token = tokenOf(raw);
      if (!token) return Promise.resolve(fail("invalid-request"));
      const shared = byToken.get(token);
      if (shared) return shared;
      const timeout = Math.max(1, Math.min(o.timeoutMs ?? defaultTimeout, 120_000));
      const p = ask(token, timeout, o.signal).finally(() => byToken.delete(token));
      byToken.set(token, p);
      return p;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const settle of [...pending.values()]) settle(fail("unavailable"));
      unsubscribeIfIdle();
    },
  };
}

// ── serving (orchestrator) ──────────────────────────────────────────────────

export interface ServeFlowOptions {
  /**
   * May THIS child ask at all? Decided by the orchestrator from the process it
   * spawned (decision-research allowlist, by smart account), re-asked on every
   * request so an operator's change applies without a respawn. Default: no.
   */
  allowed?: () => boolean;
  perMinute?: number;
  maxInFlight?: number;
  maxCallMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * Answer one child's flow questions. `answer` is the orchestrator's flowFor,
 * already bound to the child-evidence budget share, handed `timeoutMs` when
 * the child said how long it waits (less ipcMarginMs, within the ceiling):
 * a reading must not be still spending after the child has given up on it.
 * Returns the unsubscribe; call it when the child exits.
 */
export function serveFlowRequests(
  port: FlowPort,
  tenant: string,
  answer: (token: `0x${string}`, timeoutMs?: number) => Promise<FlowResult>,
  opts: ServeFlowOptions = {},
): () => void {
  const clock = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const allowed = opts.allowed ?? (() => false);
  const perMinute = Math.max(1, Math.trunc(opts.perMinute ?? FLOW_BROKER_LIMITS.servePerMinute));
  const maxInFlight = Math.max(1, Math.trunc(opts.maxInFlight ?? FLOW_BROKER_LIMITS.serveMaxInFlight));
  const maxCallMs = Math.max(1, Math.trunc(opts.maxCallMs ?? FLOW_BROKER_LIMITS.serveMaxCallMs));
  const tag = `flow broker [${String(tenant).slice(0, 10)}]`;
  const inFlightIds = new Set<string>();
  const byToken = new Map<string, Promise<FlowResult>>();
  const started: number[] = [];
  const said = new Set<string>();
  let closed = false;

  const sayOnce = (key: string, line: string): void => {
    if (said.has(key) || said.size >= 64) return;
    said.add(key);
    log(`${tag}: ${line}`);
  };
  const reply = (r: FlowResponse): void => {
    if (closed) return;
    try {
      port.send(r);
    } catch {
      // The child is gone; its requests die with it.
    }
  };
  const result = (id: string, r: FlowResult): void => {
    const checked = flowResultOf(r) ?? fail("invalid-shape");
    const bytes = jsonBytes(checked);
    reply({ flow: 1, id, ok: true, result: bytes !== null && bytes <= FLOW_BROKER_LIMITS.maxResponseBytes ? checked : fail("invalid-shape") });
  };

  /** One bounded answer: a thrown error is "unavailable" and a slow one "timeout", never an exception or a hang. */
  function bounded(token: `0x${string}`, wait: number | undefined): Promise<FlowResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = (async () => {
      try {
        return (await (wait === undefined ? answer(token) : answer(token, wait))) ?? fail("unavailable");
      } catch {
        sayOnce("threw", "an answer failed inside the orchestrator");
        return fail("unavailable");
      }
    })();
    const out = Promise.race([work, new Promise<FlowResult>((r) => (timer = setTimeout(() => r(fail("timeout")), wait ?? maxCallMs)))]);
    return out.finally(() => clearTimeout(timer));
  }

  function handle(msg: unknown): void {
    if (closed || !isRec(msg) || msg.flow !== 1) return;
    const id = idOf(msg.id);
    if (!id) {
      sayOnce("bad-id", "ignored a request without a usable id");
      return;
    }
    if (inFlightIds.has(id)) {
      sayOnce("duplicate-id", "ignored a request reusing an id still in flight");
      return;
    }
    const bytes = jsonBytes(msg);
    if (bytes === null || bytes > FLOW_BROKER_LIMITS.maxRequestBytes) {
      sayOnce("too-large", "refused a request over the size limit");
      reply({ flow: 1, id, ok: false, error: "request-too-large" });
      return;
    }
    for (const field of Object.keys(msg)) {
      if (field === "flow" || field === "id" || field === "op" || field === "token" || field === "timeoutMs") continue;
      // Never read, never used: not a tenant, not a creator, not a window.
      sayOnce(`extra:${FIELD_SHAPE.test(field) ? field : "?"}`, `ignored unexpected field "${FIELD_SHAPE.test(field) ? field : "?"}" on a request`);
    }
    const token = tokenOf(msg.token);
    if (msg.op !== "facts" || !token) {
      reply({ flow: 1, id, ok: false, error: "invalid-request" });
      return;
    }
    // THE CHILD'S OWN WAIT, less the trip back, within the ceiling. Only ever shorter.
    const waits = msg.timeoutMs;
    const wait = typeof waits === "number" && Number.isFinite(waits) && waits > 0
      ? Math.min(maxCallMs, Math.floor(waits) - FLOW_BROKER_LIMITS.ipcMarginMs) : undefined;
    if (wait !== undefined && wait < 1) {
      // It will have stopped waiting before anything could come back: nothing is asked.
      result(id, fail("timeout"));
      return;
    }
    let ok = false;
    try {
      ok = allowed() === true;
    } catch {
      ok = false;
    }
    if (!ok) {
      sayOnce("not-allowed", "this child is not on the flow allowlist; answering unavailable");
      result(id, fail("unavailable"));
      return;
    }
    inFlightIds.add(id);
    const shared = byToken.get(token);
    const settle = (p: Promise<FlowResult>): void => {
      void p.then((r) => {
        inFlightIds.delete(id);
        result(id, r);
      });
    };
    if (shared) {
      settle(shared);
      return;
    }
    const now = clock();
    while (started.length > 0 && now - started[0]! >= 60_000) started.shift();
    if (started.length >= perMinute || byToken.size >= maxInFlight) {
      sayOnce("rate-limited", "flow requests rate-limited for this child");
      inFlightIds.delete(id);
      result(id, fail("budget"));
      return;
    }
    started.push(now);
    const p = bounded(token, wait).finally(() => byToken.delete(token));
    byToken.set(token, p);
    settle(p);
  }

  const unsubscribe = port.onMessage((msg) => {
    try {
      handle(msg);
    } catch {
      sayOnce("handle-failed", "request handling failed");
    }
  });
  return () => {
    if (closed) return;
    closed = true;
    unsubscribe();
  };
}
