/**
 * THE REVIEW'S FLOW QUESTION: asked only when somebody will answer, bounded by
 * the evidence budget, and turned into a Brain block or nothing.
 *
 * The wiring in index.ts (who asks, when, and where the block goes) is pinned
 * in trencher-decisions-wiring.test.ts; these are the pieces it calls.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ShadowOutcome } from "./brain-shadow";
import { createFlowClient, FLOW_BROKER_ENV, type FlowPort } from "./flow-broker";
import type { FlowFacts, FlowResult } from "./flow-facts";
import { ONCHAIN_FLOW_LENS, flowLensRefused, readFlowEvidence, reviewFlowClient } from "./review-flow";

const TOKEN = "0x00000000000000000000000000000000000000c1" as const;
const NOW = Date.parse("2026-10-12T02:00:00Z");

function facts(over: Partial<FlowFacts> = {}): FlowFacts {
  return {
    token: TOKEN,
    observedAt: NOW - 12_000,
    windows: [
      { minutes: 5, buyUsd: 412.5, sellUsd: 120.25, buys: 4, sells: 2, buyers: 3, sellers: 2 },
      { minutes: 15, buyUsd: 1388.9, sellUsd: 610, buys: 11, sells: 5, buyers: 8, sellers: 4 },
      { minutes: 60, buyUsd: 5120.75, sellUsd: 2310.4, buys: 40, sells: 18, buyers: 27, sellers: 12 },
    ],
    venues: [{ protocol: "uniswap_v4", family: "uniswap", buyUsd: 4020.5, sellUsd: 1800.4, buys: 31, sells: 13 }],
    largestSells: [{ usd: 512.75, at: NOW / 1000 - 1200, protocol: "uniswap_v4" }],
    creator: { state: "read", windowMin: 60, sells: 0, sellUsd: 0, transfersOut: 0, transferOutUsd: 0 },
    ...over,
  };
}

/** A port that records what is sent and never answers. */
function silentPort(): FlowPort & { sent: unknown[] } {
  const sent: unknown[] = [];
  return { sent, send: (m) => (sent.push(m), true), onMessage: () => () => {}, connected: () => true };
}

describe("reviewFlowClient — no question unless the orchestrator said a broker answers", () => {
  it("is null without the flag, whatever the channel", () => {
    assert.equal(FLOW_BROKER_ENV, "MERRYMEN_FLOW_BROKER");
    assert.equal(reviewFlowClient({}, () => silentPort()), null);
    for (const v of ["0", "true", "yes", " 1", ""]) assert.equal(reviewFlowClient({ [FLOW_BROKER_ENV]: v }, () => silentPort()), null, JSON.stringify(v));
  });

  it("is null with the flag but no channel (self-hosted, or Fomo off)", () => {
    assert.equal(reviewFlowClient({ [FLOW_BROKER_ENV]: "1" }, () => null), null);
  });

  it("is a client with both, and asks for the token alone, with how long it waits", async () => {
    const port = silentPort();
    const client = reviewFlowClient({ [FLOW_BROKER_ENV]: "1" }, () => port);
    assert.ok(client);
    const r = await readFlowEvidence(client, TOKEN, 20);
    assert.deepEqual(r, { lens: null, status: "timeout" });
    assert.equal(port.sent.length, 1);
    assert.deepEqual(Object.keys(port.sent[0] as object).sort(), ["flow", "id", "op", "timeoutMs", "token"]);
    assert.equal((port.sent[0] as { timeoutMs: number }).timeoutMs, 20, "the review's budget goes on the wire");
  });
});

describe("readFlowEvidence — bounded, and a block or nothing", () => {
  it("passes the budget down as the request's own deadline", async () => {
    let asked: { token: string; timeoutMs?: number } | null = null;
    const client = { facts: async (token: string, o?: { timeoutMs?: number }) => ((asked = { token, timeoutMs: o?.timeoutMs }), { ok: false, failure: "budget" } as FlowResult) };
    assert.deepEqual(await readFlowEvidence(client, TOKEN, 5_000), { lens: null, status: "budget" });
    assert.deepEqual(asked, { token: TOKEN, timeoutMs: 5_000 });
  });

  it("never waits past the budget for a broker that does not answer", async () => {
    const client = createFlowClient(silentPort());
    const started = Date.now();
    const r = await readFlowEvidence(client, TOKEN, 60);
    assert.equal(r.status, "timeout");
    assert.ok(Date.now() - started < 1_000, "bounded by the budget, not the client's 25 s default");
  });

  it("renders the Brain block, figures and all, with no address in it", async () => {
    const client = { facts: async () => ({ ok: true, facts: facts() }) as FlowResult };
    const r = await readFlowEvidence(client, TOKEN, 5_000, () => NOW);
    assert.equal(r.status, "lens");
    assert.ok(r.lens);
    assert.match(r.lens, /^Source: an on-chain indexer's record of DEX trades in this coin/);
    assert.match(r.lens, /"buyUsd":5121/, "the Brain's copy keeps its numbers");
    assert.match(r.lens, /WHAT THIS IS NOT: a price, a prediction or a reason to trade\./);
    assert.doesNotMatch(r.lens, /0x[0-9a-f]{6,}/i);
    assert.ok(r.lens.length <= 1_200, "inside Brain's manager cut (graph.py ONCHAIN_FLOW_MANAGER_CHARS)");
    assert.equal(ONCHAIN_FLOW_LENS, "onchain-flow");
  });

  it("sends nothing for a quiet hour: absence is not a reading", async () => {
    const quiet = facts({ windows: [5, 15, 60].map((minutes) => ({ minutes: minutes as 5 | 15 | 60, buyUsd: 0, sellUsd: 0, buys: 0, sells: 0, buyers: 0, sellers: 0 })) });
    const r = await readFlowEvidence({ facts: async () => ({ ok: true, facts: quiet }) as FlowResult }, TOKEN, 5_000, () => NOW);
    assert.deepEqual(r, { lens: null, status: "no-block" });
  });

  it("a client that throws is unavailable, never an exception into the review", async () => {
    const r = await readFlowEvidence({ facts: async () => { throw new Error("boom"); } }, TOKEN, 5_000);
    assert.deepEqual(r, { lens: null, status: "unavailable" });
  });
});

describe("flowLensRefused — an older Brain's 422 turns the key off", () => {
  const unreachable = { ran: true, result: { ok: false, kind: "unreachable", detail: "brain returned HTTP 422" } } as unknown as ShadowOutcome;
  const refused = { ran: true, result: { ok: false, kind: "refused", reason: "budget-exhausted", detail: "", cost: {} } } as unknown as ShadowOutcome;
  const decided = { ran: true, result: { ok: true } } as unknown as ShadowOutcome;
  const asleep = { ran: false, why: "x" } as unknown as ShadowOutcome;

  it("only when the key was sent and the decide never landed", () => {
    assert.equal(flowLensRefused(true, unreachable), true);
    assert.equal(flowLensRefused(false, unreachable), false, "a review without the key says nothing about it");
    assert.equal(flowLensRefused(true, refused), false, "Brain read the request; the key was accepted");
    assert.equal(flowLensRefused(true, decided), false);
    assert.equal(flowLensRefused(true, asleep), false);
  });
});
