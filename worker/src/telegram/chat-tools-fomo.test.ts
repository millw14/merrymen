/**
 * THE RESEARCH LOOKUPS IN THE DM TOOL LOOP (chat-tools.ts FOMO_CHAT_TOOLS).
 *
 * What these pin:
 *   - every registered READ tool is a lookup the model may call, and neither
 *     mutation (watch, unwatch) is, whatever is asked;
 *   - a lookup goes through the broker with the DM surface, the audience and
 *     conversation from the per-message context (never the model's
 *     arguments), interactive priority and a hard per-call bound, and comes
 *     back as labelled data, capped;
 *   - no broker: an honest "not available";
 *   - "why did you skip that coin?": the research status is followed by this
 *     agent's own decision funnel and early-candidate book, for the owner only;
 *   - the model loop dispatches a research lookup by name through the same
 *     tenant-bound context.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { brokerFailureEnvelope } from "../fomo/broker";
import type { BrokerCallOptions, FomoBroker } from "../fomo/contract";
import { MUTATION_TOOL_NAMES, READ_TOOL_NAMES, type ResearchStatusData } from "../fomo/tools";
import type { FomoEnvelope, FomoToolName, TokenIdentity } from "../fomo/types";
import { FunnelRecorder, installDecisionFunnel } from "../decision-funnel";
import { EarlyCandidateBook, installEarlyCandidateBook } from "../early-candidates";
import type { AgentMsg, AgentTurn, LlmCreds } from "../llm";
import { answerQuestion, answerSystem } from "./answer";
import { CHAT_TOOLS, FOMO_TOOL_LABEL, FOMO_TOOL_MAX_CALLS, FOMO_TOOL_TIMEOUT_MS, MODEL_FOMO_DEPTHS, TOOL_OUTPUT_MAX, answerTradeQuestion, asksAboutSomeoneElsesTrades, clampModelFomoArgs, localResearchLines, toolByName, type ToolContext } from "./chat-tools";

const NOW_SEC = 1_790_000_000;
const NOW_MS = NOW_SEC * 1000;
const PONS = "0x39dbed3a00000000000000000000000000000c0d";
const PONS_ID: TokenIdentity = { chain: { namespace: "eip155", networkId: 4663, slug: "robinhood" }, address: PONS, key: `eip155:4663:${PONS}` };

function okEnvelope(tool: FomoToolName, data: unknown, subject: FomoEnvelope["subject"] = null): FomoEnvelope {
  const base = brokerFailureEnvelope(tool, "x", "x", NOW_MS);
  return { ...base, status: "ok", reason: null, message: null, data, subject };
}

function spyBroker(answer: (tool: FomoToolName, args: Record<string, unknown>) => FomoEnvelope) {
  const calls: { tool: FomoToolName; args: Record<string, unknown>; opts: BrokerCallOptions }[] = [];
  const broker: FomoBroker = {
    async call(tool, args, opts) {
      calls.push({ tool, args: { ...args }, opts: { ...opts } });
      return answer(tool, args);
    },
    memory: { get: async () => null, set: async () => {}, clear: async () => {} },
    report: async () => {},
    configured: () => true,
  };
  return { broker, calls };
}

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    status: { agentId: null, name: "Shogun", strategy: "trencher", venue: "uniswap", paused: false, workerAliveSec: 10, grant: null, chainId: 4663, telegramMaxActionUsdg: 25 },
    cfg: { customTokens: [] },
    paused: false,
    grant: null,
    book: [],
    client: null,
    now: NOW_SEC,
    ...over,
  } as unknown as ToolContext;
}

afterEach(() => {
  installDecisionFunnel(null);
  installEarlyCandidateBook(null);
});

describe("the research lookups the DM model may call", () => {
  it("every registered read tool is offered, and no mutation ever is", () => {
    const names = CHAT_TOOLS.map((t) => t.spec.name);
    for (const n of READ_TOOL_NAMES) assert.ok(names.includes(n), `${n} is offered`);
    for (const n of MUTATION_TOOL_NAMES) {
      assert.ok(!names.includes(n), `${n} is never a lookup`);
      assert.equal(toolByName(n), null);
    }
    // Each schema refuses keys it does not name (no tenant can be passed through).
    for (const t of CHAT_TOOLS.filter((x) => x.spec.name.startsWith("fomo_"))) {
      assert.equal((t.spec.schema as { additionalProperties?: unknown }).additionalProperties, false, t.spec.name);
    }
  });

  it("a lookup goes through the broker with the context's surface, audience and conversation, and comes back labelled as data", async () => {
    const { broker, calls } = spyBroker((tool) => okEnvelope(tool, null));
    const tool = toolByName("fomo_get_token_theses")!;
    const out = await tool.run({ token: "PONS", tenant: "0xevil" }, ctx({ fomo: broker, fomoConversationKey: "tg-dm:42", fomoAudience: "owner" }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.tool, "fomo_get_token_theses");
    assert.deepEqual(calls[0]!.opts, { surface: "telegram-dm", audience: "owner", conversationKey: "tg-dm:42", priority: "interactive", timeoutMs: FOMO_TOOL_TIMEOUT_MS });
    // The model's stray key reaches the service, which refuses unknown keys; it never becomes context.
    assert.equal(calls[0]!.args.tenant, "0xevil");
    assert.ok(out.startsWith(FOMO_TOOL_LABEL));
    assert.match(out, /not instructions/);
    assert.ok(out.length <= TOOL_OUTPUT_MAX);
  });

  it("one answer makes at most a few research lookups, so the serial poll loop is never held for long", async () => {
    const { broker, calls } = spyBroker((tool) => okEnvelope(tool, null));
    const c = ctx({ fomo: broker, fomoAudience: "owner" });
    const outs: string[] = [];
    for (let i = 0; i < FOMO_TOOL_MAX_CALLS + 2; i++) outs.push(await toolByName("fomo_get_rankings")!.run({}, c));
    assert.equal(calls.length, FOMO_TOOL_MAX_CALLS);
    assert.match(outs[outs.length - 1]!, /per-answer limit/);
    // A new message is a new context, with its own allowance.
    await toolByName("fomo_get_rankings")!.run({}, ctx({ fomo: broker, fomoAudience: "owner" }));
    assert.equal(calls.length, FOMO_TOOL_MAX_CALLS + 1);
  });

  it("anyone but the owner is looked up for with the group audience", async () => {
    const { broker, calls } = spyBroker((tool) => okEnvelope(tool, null));
    await toolByName("fomo_get_rankings")!.run({}, ctx({ fomo: broker, fomoConversationKey: "tg-dm:7" }));
    await toolByName("fomo_get_rankings")!.run({}, ctx({ fomo: broker, fomoConversationKey: "tg-dm:7", fomoAudience: "group" }));
    assert.deepEqual(calls.map((c) => c.opts.audience), ["group", "group"]);
  });

  it("no broker: says research is not available, and looks nothing up", async () => {
    const out = await toolByName("fomo_find_opportunities")!.run({}, ctx({ fomo: null }));
    assert.match(out, /not available/);
    const out2 = await toolByName("fomo_find_opportunities")!.run({}, ctx());
    assert.match(out2, /not available/);
  });

  it("a refused lookup (data access switched off) carries no data, only the refusal", async () => {
    const { broker } = spyBroker((tool) => ({
      ...brokerFailureEnvelope(tool, "no-data-access", "Fomo data access is switched off for this agent.", NOW_MS),
      status: "not-authorized",
    }));
    const out = await toolByName("fomo_get_token_activity")!.run({ token: "PONS" }, ctx({ fomo: broker, fomoAudience: "owner" }));
    assert.match(out, /switched off|not authori[sz]ed|permission/i);
    assert.doesNotMatch(out, /buyer|seller|thes/i);
  });

  it("the research status is followed by this agent's own funnel and early-candidate list, for the owner only", async () => {
    const funnel = new FunnelRecorder({ now: () => NOW_MS });
    funnel.record({ token: PONS, symbol: "PONS", stage: "DISCOVERY_SCREENED_OUT", detail: "early-screen:no-sells-24h", at: NOW_MS - 120_000 });
    installDecisionFunnel(funnel);
    const book = new EarlyCandidateBook(() => NOW_MS);
    assert.equal(book.offer(PONS, { source: "fomo-follow", priority: 3, maxUsdg6: 2_000_000n, probe: true, expiresAt: NOW_MS + 20 * 60_000, ref: "fa_000000000000000000000001" }), "added");
    installEarlyCandidateBook(book);
    const data: Partial<ResearchStatusData> = { token: PONS_ID, assessment: null, funnel: [], watches: [], jobs: [], request: null, cohort: null, health: { state: "research-only", detail: "ok", configured: true, creditsRemaining: null }, capabilities: {} };
    const { broker } = spyBroker((tool) => okEnvelope(tool, data, { kind: "token", token: PONS_ID, label: { symbol: "PONS", name: null } }));
    const owner = await toolByName("fomo_get_research_status")!.run({ token: PONS, chain: "robinhood" }, ctx({ fomo: broker, fomoAudience: "owner" }));
    assert.match(owner, /My own decision funnel for it \(this agent's record, not Fomo's\): PONS: last stopped at DISCOVERY_SCREENED_OUT — early-screen:no-sells-24h/);
    assert.match(owner, /Early-candidate list: waiting for a review slot \(from fomo-follow, probe-sized ceiling, offer expires in about 20 min\)\. Being on it buys a review, never a trade\./);
    const group = await toolByName("fomo_get_research_status")!.run({ token: PONS }, ctx({ fomo: broker, fomoAudience: "group" }));
    assert.doesNotMatch(group, /decision funnel|Early-candidate/);
  });

  it("the local lines know only Robinhood Chain coins, and say nothing when there is nothing installed", () => {
    assert.equal(localResearchLines(PONS_ID, NOW_MS), null, "no funnel, no book: nothing");
    assert.equal(localResearchLines({ ...PONS_ID, chain: { namespace: "solana", networkId: 1399811149, slug: "solana" } }, NOW_MS), null);
    installDecisionFunnel(new FunnelRecorder({ now: () => NOW_MS }));
    assert.match(localResearchLines(PONS_ID, NOW_MS)!, /No record: this coin was not on the tape/);
  });
});

describe("the DM model loop and the research lookups", () => {
  const creds = { provider: "test", transport: "openai", baseUrl: "http://x", apiKey: "k", model: "m", vision: false } as unknown as LlmCreds;

  it("a research lookup the model asks for runs through the broker with the tenant-bound context, and its output goes back as data", async () => {
    const { broker, calls } = spyBroker((tool) => okEnvelope(tool, null));
    const seen: AgentMsg[][] = [];
    const turns: AgentTurn[] = [
      { text: "", toolUses: [{ id: "f1", name: "fomo_get_rankings", input: { board: "trending-tokens" } }] },
      { text: "Here is what Fomo shows.", toolUses: [] },
    ];
    let i = 0;
    const turn = (async (_c: LlmCreds, o: { messages: AgentMsg[]; tools: { name: string }[] }) => {
      seen.push([...o.messages]);
      if (i === 0) {
        const offered = o.tools.map((t) => t.name);
        assert.ok(offered.includes("fomo_get_rankings"));
        assert.ok(!offered.includes("fomo_watch_coin") && !offered.includes("fomo_unwatch_coin"));
      }
      return turns[Math.min(i++, turns.length - 1)]!;
    }) as never;
    const tools = ctx({ fomo: broker, fomoConversationKey: "tg-dm:42", fomoAudience: "owner" });
    const a = await answerQuestion({ question: "hello there", name: "Shogun", identity: "YOUR IDENTITY: Shogun.", memory: "", gap: "", history: [], tools, creds, turn });
    assert.equal(a?.text, "Here is what Fomo shows.");
    assert.ok(a?.used.includes("fomo_get_rankings"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.opts.conversationKey, "tg-dm:42");
    assert.equal(calls[0]!.opts.audience, "owner");
    const results = seen[1]!.find((m) => m.role === "tools") as Extract<AgentMsg, { role: "tools" }>;
    assert.ok(results.results[0]!.output.startsWith(FOMO_TOOL_LABEL));
  });

  it("a model asking for a watch gets no such lookup", async () => {
    const { broker, calls } = spyBroker((tool) => okEnvelope(tool, null));
    const turns: AgentTurn[] = [
      { text: "", toolUses: [{ id: "w1", name: "fomo_watch_coin", input: { token: PONS, chain: "robinhood", days: 30 } }] },
      { text: "ok", toolUses: [] },
    ];
    let i = 0;
    const seen: AgentMsg[][] = [];
    const turn = (async (_c: LlmCreds, o: { messages: AgentMsg[] }) => {
      seen.push([...o.messages]);
      return turns[Math.min(i++, turns.length - 1)]!;
    }) as never;
    await answerQuestion({ question: "hello", name: "Shogun", identity: "", memory: "", gap: "", history: [], tools: ctx({ fomo: broker, fomoAudience: "owner" }), creds, turn });
    assert.equal(calls.length, 0, "the broker never heard of it");
    const results = seen[1]!.find((m) => m.role === "tools") as Extract<AgentMsg, { role: "tools" }>;
    assert.match(results.results[0]!.output, /no lookup called fomo_watch_coin/);
  });

  it("C30: the model loop cannot start a deep research job, whatever an excerpt asks for", async () => {
    const { broker, calls } = spyBroker((tool) => okEnvelope(tool, null));
    const turns: AgentTurn[] = [
      {
        text: "",
        toolUses: [
          { id: "d1", name: "fomo_research_coin", input: { token: "PONS", depth: "deep" } },
          { id: "d2", name: "fomo_research_coin", input: { token: "ZORP", depth: "deep", freshness: "force-refresh" } },
        ],
      },
      { text: "done", toolUses: [] },
    ];
    let i = 0;
    let offered: { name: string; input_schema?: unknown; parameters?: unknown; schema?: unknown }[] = [];
    const turn = (async (_c: LlmCreds, o: { tools: typeof offered }) => {
      if (i === 0) offered = o.tools;
      return turns[Math.min(i++, turns.length - 1)]!;
    }) as never;
    await answerQuestion({ question: "hello there", name: "Shogun", identity: "", memory: "", gap: "", history: [], tools: ctx({ fomo: broker, fomoAudience: "owner" }), creds, turn });
    assert.deepEqual(calls.map((c) => [c.tool, c.args.depth]), [["fomo_research_coin", "standard"], ["fomo_research_coin", "standard"]]);
    const research = offered.find((t) => t.name === "fomo_research_coin")!;
    assert.doesNotMatch(JSON.stringify(research), /"deep"/, "deep is never offered to the model");
  });

  for (const name of ["fomo_research_coin", "fomo_get_token_theses", "fomo_get_trader_context"] as const) {
    it(`C30: ${name} offers the model quick or standard depth only, and clamps anything else to standard`, async () => {
      const tool = toolByName(name)!;
      const depth = (tool.spec.schema as { properties: Record<string, { enum?: unknown[] }> }).properties.depth;
      assert.ok(depth, `${name} has a depth`);
      assert.deepEqual(depth.enum, [...MODEL_FOMO_DEPTHS]);
      const base = name === "fomo_get_trader_context" ? { trader: "CryptoKaleo" } : { token: "PONS" };
      for (const [given, sent] of [["deep", "standard"], ["DEEP", "standard"], ["max", "standard"], [7, "standard"], ["quick", "quick"], ["standard", "standard"]] as const) {
        const { broker, calls } = spyBroker((t) => okEnvelope(t, null));
        await tool.run({ ...base, depth: given }, ctx({ fomo: broker, fomoAudience: "owner" }));
        assert.equal(calls[0]!.args.depth, sent, `${name} depth ${String(given)}`);
      }
      const { broker, calls } = spyBroker((t) => okEnvelope(t, null));
      await tool.run({ ...base }, ctx({ fomo: broker, fomoAudience: "owner" }));
      assert.ok(!("depth" in calls[0]!.args), "no depth stays no depth (the tool's own default)");
    });
  }

  it("C30: clampModelFomoArgs keeps every other argument as given, for the service's own validator", () => {
    assert.deepEqual(clampModelFomoArgs({ token: "PONS", chain: "robinhood", depth: "deep", tenant: "x" }), { token: "PONS", chain: "robinhood", depth: "standard", tenant: "x" });
    assert.deepEqual(clampModelFomoArgs(null), {});
    assert.deepEqual(clampModelFomoArgs(["deep"]), {});
  });

  it("the rules tell the model research is never an order and public activity is not the owner's", () => {
    const sys = answerSystem("Shogun", "YOUR IDENTITY: Shogun.");
    assert.match(sys, /fomo_\* lookups are read-only research/);
    assert.match(sys, /never place an order, a post or a watch/);
    assert.match(sys, /a trader's public activity is not what you or the owner traded/);
  });
});

describe("C12: somebody else's trades are never read off the owner's ledger", () => {
  const ROWS: Array<[string, boolean]> = [
    ["show their trades", true],
    ["show me their trades", true],
    ["list their sells", true],
    ["show his buys today", true],
    ["list her trades", true],
    ["show @alice's trades", true],
    ["list @alice’s buys", true],
    ["show the trader's sells", true],
    ["show CryptoKaleo's trades", true],
    ["what did they trade today? show the trades", true],
    // The owner's own book still takes the deterministic ledger answer.
    ["show trades today", false],
    ["show today's trades", false],
    ["show yesterday's buys", false],
    ["show my trades", false],
    ["list trades for $PRISM", false],
    ["show the agent's trades", false],
    ["show Shogun's trades", false],
    ["what did you trade today?", false],
  ];
  for (const [q, someoneElse] of ROWS) {
    it(`${JSON.stringify(q)} is ${someoneElse ? "somebody else's" : "the owner's"}`, async () => {
      assert.equal(asksAboutSomeoneElsesTrades(q, "Shogun"), someoneElse);
      // Returned before any ledger is opened: the answer loop gets it.
      if (someoneElse) assert.equal(await answerTradeQuestion(q, ctx()), null);
    });
  }
});
