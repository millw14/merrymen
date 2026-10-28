/**
 * THE ORCHESTRATOR'S FLOW SERVICE — Bitquery lane in, flow facts out.
 *
 * Kept beside orchestrator.ts, as orchestrator-xpost.ts and orchestrator-fomo.ts
 * are, so the orchestrator's own diff is a handful of lines: build the runtime
 * once, export `flowFor`, attach the broker to each child it spawns.
 *
 * WHO ASKS, AND ON WHOSE BUDGET.
 *
 *   flowFor(token)          the orchestrator's own answers (X replies). Spends
 *                           from the whole day's points.
 *   a child, over IPC       decision evidence for a review. Spends from the
 *                           evidence share only (bitquery-lane.ts), and only a
 *                           child whose smart account the operator listed in
 *                           MERRYMEN_DECISION_RESEARCH_ACCOUNTS may ask at all.
 *
 * THE LAUNCHER IS RESOLVED HERE, FROM THE LAUNCHPAD'S OWN RECORD. Whether a
 * coin's launcher sold needs the launcher's address, and a caller that could
 * supply one could point the lane at any wallet — another tenant's account
 * included — and learn what it sold. So nobody supplies it. Nor does the TOKEN:
 * a deployer the token reports about itself (pons-meta.ts) is whatever the
 * contract chooses to return, and a rug that names a decoy would read as "the
 * creator did not sell" while the real one sells. This process reads the
 * Pons factory's launch event instead (pons.ts readLaunchCreator), which only
 * the factory can emit. A coin with no such record is "not-derivable", never
 * "did not sell". The address is used as a query variable and goes no
 * further: no fact, log line or reply carries it.
 *
 * ONE DEADLINE PER READING. The flow query, the chain read and the launcher's
 * query all spend from FLOW_DEADLINE_MS, which sits under the broker's ceiling
 * on one child answer (flow-broker.ts serveMaxCallMs): a reading that
 * succeeded is never thrown away by that ceiling, and nothing is still
 * spending after the child has been answered. Short of time, the flow facts
 * come back with the launcher marked unavailable rather than late.
 */

import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { createPublicClient, http, type PublicClient } from "viem";
import { decisionResearchEnabledFor } from "./decision-research";
import { childProcessFlowPort, serveFlowRequests } from "./flow-broker";
import type { CreatorFlow, FlowResult } from "./flow-facts";
import { merrymenHome } from "./home";
import { BITQUERY_LANE_DEFAULTS, BitqueryLane, LANE_POINTS, bitqueryLaneSetup, type BitqueryLaneSetup, type LanePurpose } from "./venues/bitquery-lane";
import { readLaunchCreator, type LaunchCreator } from "./venues/pons";

export type CreatorLookup = LaunchCreator;

export interface FlowService {
  /**
   * Flow facts for a token, or the word for why not. Never throws; done within
   * FLOW_DEADLINE_MS, or within `timeoutMs` when a caller that is waiting on
   * less (an X answer's research share) says so. Never longer.
   */
  flowFor(token: string, opts?: { purpose?: LanePurpose; timeoutMs?: number }): Promise<FlowResult>;
}

/** The window the creator question covers, in minutes: the widest flow window. */
export const CREATOR_WINDOW_MIN = 60;

/**
 * One reading's whole budget of time: the flow query, the chain read and the
 * launcher's query together. Under FLOW_BROKER_LIMITS.serveMaxCallMs (22 s),
 * with room for the IPC hop (orchestrator-flow.test.ts pins the order).
 */
export const FLOW_DEADLINE_MS = 18_000;

/** One RPC call's own bound for the launcher lookup; the reading's deadline still caps it. */
const LAUNCHER_RPC_TIMEOUT_MS = 5_000;

/** Resolve to `fallback` once `ms` has passed, whatever `p` is still doing. */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (ms <= 0) return Promise.resolve(fallback);
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** A recorded deployer does not change; a failed read is retried soon. */
const CREATOR_TTL_MS = { known: 24 * 3_600_000, none: 24 * 3_600_000, unreadable: 60_000 } as const;
const CREATOR_CACHE_MAX = 2048;

export function makeFlowService(deps: {
  lane: Pick<BitqueryLane, "tokenFlow" | "creatorFlow">;
  creatorOf: (token: `0x${string}`) => Promise<CreatorLookup>;
  now?: () => number;
  /** Test seams: the reading's budget, and the least a lane request is given. */
  deadlineMs?: number;
  minLaneMs?: number;
}): FlowService {
  const now = deps.now ?? Date.now;
  const deadlineMs = deps.deadlineMs ?? FLOW_DEADLINE_MS;
  const minLaneMs = deps.minLaneMs ?? BITQUERY_LANE_DEFAULTS.minRequestMs;
  const creators = new Map<string, { lookup: CreatorLookup; until: number }>();

  async function creatorOf(token: `0x${string}`): Promise<CreatorLookup> {
    const hit = creators.get(token);
    if (hit && hit.until > now()) return hit.lookup;
    let lookup: CreatorLookup;
    try {
      lookup = await deps.creatorOf(token);
    } catch {
      lookup = { state: "unreadable" };
    }
    if (lookup.state === "known" && (!ADDRESS.test(lookup.creator) || lookup.creator.toLowerCase() === token)) lookup = { state: "none" };
    if (creators.size >= CREATOR_CACHE_MAX) creators.delete(creators.keys().next().value!);
    creators.set(token, { lookup, until: now() + CREATOR_TTL_MS[lookup.state] });
    return lookup;
  }

  return {
    async flowFor(raw, opts = {}) {
      try {
        if (typeof raw !== "string" || !ADDRESS.test(raw) || /^0x0{40}$/i.test(raw)) return { ok: false, failure: "invalid-request" };
        const token = raw.toLowerCase() as `0x${string}`;
        const purpose = opts.purpose ?? "answer";
        // A caller's own, shorter wait shortens the reading: the lane then sends
        // nothing it could not finish in time (minRequestMs), and nothing is
        // still spending after that caller has moved on.
        const budget = typeof opts.timeoutMs === "number" && opts.timeoutMs > 0 ? Math.min(deadlineMs, opts.timeoutMs) : deadlineMs;
        const deadline = now() + budget;
        // The chain read runs beside the flow query; the launcher's own query
        // waits for the flow to succeed, so a failed reading spends no more.
        const creatorP = creatorOf(token);
        const flow = await deps.lane.tokenFlow(token, { purpose, deadline });
        if (!flow.ok) return { ok: false, failure: flow.failure };
        const late: CreatorFlow = { state: "unavailable", failure: "timeout" };
        let creator: CreatorFlow;
        // Too little left to ask the lane anything: the flow facts go back now,
        // with the launcher unknown, rather than late or not at all.
        if (deadline - now() < minLaneMs) creator = late;
        else {
          const look = await within<CreatorLookup | "late">(creatorP, deadline - minLaneMs - now(), "late");
          if (look === "late") creator = late;
          else if (look.state === "none") creator = { state: "not-derivable" };
          else if (look.state === "unreadable") creator = { state: "unavailable", failure: "unavailable" };
          else {
            const c = await deps.lane.creatorFlow(token, look.creator, { purpose, windowMin: CREATOR_WINDOW_MIN, deadline });
            creator = c.ok ? { state: "read", windowMin: CREATOR_WINDOW_MIN, ...c.data } : { state: "unavailable", failure: c.failure };
          }
        }
        return { ok: true, facts: { token, observedAt: flow.observedAt, ...flow.data, creator } };
      } catch {
        return { ok: false, failure: "unavailable" };
      }
    },
  };
}

/** Who the Pons factory recorded as launching a token, through this process's RPC. */
export function ponsLaunchCreatorLookup(client: () => Pick<PublicClient, "getBlockNumber" | "request">): (token: `0x${string}`) => Promise<CreatorLookup> {
  return async (token) => {
    try {
      return await readLaunchCreator(client(), token);
    } catch {
      return { state: "unreadable" };
    }
  };
}

export interface FlowRuntime {
  setup: BitqueryLaneSetup;
  /** Null while the lane is off: every flow question then answers "unavailable". */
  service: FlowService | null;
}

/**
 * Read the switches and build the lane, once. Off — no key, or
 * MERRYMEN_BITQUERY_LANE=0 — there is no SQLite file, no RPC client and no
 * request. A lane whose file cannot be opened is off too, and says why.
 */
export function startFlowRuntime(o: { env: Record<string, string | undefined>; home: string; rpcUrl: string; log: (line: string) => void }): FlowRuntime {
  const setup = bitqueryLaneSetup(o.env);
  for (const line of setup.lines) o.log(line);
  if (setup.off || !setup.config) return { setup, service: null };
  try {
    const lane = new BitqueryLane({ dir: path.join(o.home, "bitquery-lane"), config: setup.config, log: o.log });
    let client: PublicClient | null = null;
    // BOUNDED HERE TOO, not only by the reading's deadline: viem's default is
    // ten seconds a call and three retries, and a lookup the reading has given
    // up on should not keep a socket busy for forty.
    const rpc = (): PublicClient => (client ??= createPublicClient({ transport: http(o.rpcUrl, { timeout: LAUNCHER_RPC_TIMEOUT_MS, retryCount: 1 }) }));
    return { setup, service: makeFlowService({ lane, creatorOf: ponsLaunchCreatorLookup(rpc) }) };
  } catch (e) {
    o.log(`bitquery lane: off — its store could not be opened (${e instanceof Error ? e.name : "error"})`);
    return { setup, service: null };
  }
}

/**
 * THE PROCESS'S ONE RUNTIME, held here rather than in orchestrator.ts so the
 * passes that answer on X (orchestrator-xpost.ts and its kin, which
 * orchestrator.ts imports) can import `flowFor` from this file without a
 * cycle. Built on first use; the orchestrator builds it at boot so its line
 * lands in the boot log, with the orchestrator's own log prefix.
 *
 * Reads process.env, which is safe for the reason CHILD_SECRET_STRIP exists:
 * in a child the key is gone, so the lane is off and every answer is
 * "unavailable". A child has no reason to import this file, and
 * orchestrator-flow.test.ts pins that index.ts does not.
 */
let runtime: FlowRuntime | null = null;

export const DEFAULT_RPC_MAINNET = "https://rpc.mainnet.chain.robinhood.com";

export function flowRuntimeNow(o: { log?: (line: string) => void } = {}): FlowRuntime {
  runtime ??= startFlowRuntime({
    env: process.env,
    home: merrymenHome(),
    // The same default every other read in the orchestrator uses.
    rpcUrl: process.env.MERRYMEN_RPC_MAINNET ?? DEFAULT_RPC_MAINNET,
    log: o.log ?? ((line) => console.log(`[orchestrator] ${line}`)),
  });
  return runtime;
}

/** Test seam: forget the runtime so the next use reads the environment again. */
export function resetFlowRuntimeForTest(): void {
  runtime = null;
}

/**
 * FLOW FACTS FOR A TOKEN, for the orchestrator's own answers (X replies): DEX
 * buys and sells over 5/15/60 minutes, the venue split, the largest sells, and
 * whether the address the launchpad recorded as launching the coin sold — or
 * the word for why not (flow-facts.ts). Spends from the lane's whole day;
 * never throws, and answers within FLOW_DEADLINE_MS, or `timeoutMs` when that
 * is shorter. For X, flowXLines() turns a result into digit-free banded lines
 * that pass the writer's clean() and the X gate unchanged; renderFlowLens()
 * keeps the numbers, for a Brain lens.
 */
export async function flowFor(token: string, opts: { timeoutMs?: number } = {}): Promise<FlowResult> {
  const service = flowRuntimeNow().service;
  return service ? service.flowFor(token, { purpose: "answer", ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) }) : { ok: false, failure: "unavailable" };
}

/**
 * HOW MANY READINGS X ANSWERS MAY ASK FOR IN A UTC DAY: the part of the lane's
 * day that child evidence can never spend (1 − evidenceShare), at a whole
 * reading's price (the flow query and the launcher's). Answers spend from the
 * whole day, so without this a run of strangers' tags — public, and polled
 * every minute — could eat into the share the trading reviews rely on: the
 * lane weighs evidence against its own spend and the day's total, so answers
 * kept to the rest leave evidence its whole share. With the defaults,
 * 25,000 × 0.2 / 25 = 200 readings a day. Zero with the lane off.
 */
export function answerReadingsPerDay(setup: BitqueryLaneSetup): number {
  if (setup.off || !setup.config) return 0;
  const reading = LANE_POINTS.tokenFlow + LANE_POINTS.creatorFlow;
  // The evidence cap exactly as the lane computes it (bitquery-lane.ts reserve).
  const day = setup.config.pointsPerDay;
  return Math.max(0, Math.floor((day - Math.floor(day * BITQUERY_LANE_DEFAULTS.evidenceShare)) / reading));
}

/**
 * Answer one child's flow questions on its IPC channel, as decision evidence.
 * A no-op with the lane off or without a connected channel (the channel exists
 * while the Fomo pass is on). The allowlist is read on every request, by the
 * smart account THIS process spawned the child for. Released when it exits.
 */
export function attachFlowBroker(
  service: FlowService | null,
  tenant: string,
  proc: ChildProcess,
  smartAccount: string,
  log: (line: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): (() => void) | null {
  if (!service || proc.connected !== true) return null;
  try {
    // The child's own wait, carried on the request, bounds the reading: nothing is still spending after it gave up.
    const release = serveFlowRequests(childProcessFlowPort(proc), tenant.toLowerCase(), (t, timeoutMs) => service.flowFor(t, { purpose: "evidence", ...(timeoutMs !== undefined ? { timeoutMs } : {}) }), {
      allowed: () => decisionResearchEnabledFor(smartAccount, env),
      log,
    });
    proc.once("exit", release);
    return release;
  } catch (e) {
    log(`bitquery lane: flow broker not attached (${e instanceof Error ? e.name : "error"})`);
    return null;
  }
}
