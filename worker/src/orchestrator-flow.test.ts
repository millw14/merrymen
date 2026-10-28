/**
 * The orchestrator's flow service and its glue: who may ask, on whose budget,
 * and where a creator's address comes from — the three things a lane cannot
 * decide for itself.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { createFlowClient, FLOW_BROKER_LIMITS, type FlowPort } from "./flow-broker";
import { answerReadingsPerDay, attachFlowBroker, CREATOR_WINDOW_MIN, FLOW_DEADLINE_MS, makeFlowService, ponsLaunchCreatorLookup, startFlowRuntime, type CreatorLookup, type FlowService } from "./orchestrator-flow";
import { BITQUERY_LANE_DEFAULTS, LANE_POINTS, bitqueryLaneSetup, type BitqueryLane, type LaneAnswer, type CreatorFlowRead, type TokenFlowRead } from "./venues/bitquery-lane";
import { PONS_LAUNCH_TOPIC, PONS_V2_FACTORY } from "./venues/pons";
import { FLOW_X_GLOSS, flowXLines } from "./flow-facts";
import { admitAgentLine } from "./groupchat/policy";
import { admitXPost, vocabularyRefusal } from "./xpost/gate";

const TOKEN = "0x00000000000000000000000000000000000000c1";
const CREATOR = "0x00000000000000000000000000000000000000a7";
/** A placeholder smart account. The real allowlist lives in the deploy environment, never in this repo. */
const LISTED_ACCOUNT = "0x00000000000000000000000000000000000000A1";
const HERE = path.dirname(fileURLToPath(import.meta.url));

const READ: TokenFlowRead = {
  windows: [5, 15, 60].map((minutes) => ({ minutes: minutes as 5 | 15 | 60, buyUsd: 10, sellUsd: 4, buys: 2, sells: 1, buyers: 2, sellers: 1 })),
  venues: [],
  largestSells: [],
};

function fakeLane(o: { flow?: LaneAnswer<TokenFlowRead>; creator?: LaneAnswer<CreatorFlowRead> } = {}) {
  const calls: { q: string; args: unknown[] }[] = [];
  const lane: Pick<BitqueryLane, "tokenFlow" | "creatorFlow"> = {
    async tokenFlow(...args) {
      calls.push({ q: "tokenFlow", args });
      return o.flow ?? { ok: true, data: READ, observedAt: 1_000, servedFrom: "live" };
    },
    async creatorFlow(...args) {
      calls.push({ q: "creatorFlow", args });
      return o.creator ?? { ok: true, data: { sells: 1, sellUsd: 50, transfersOut: 1, transferOutUsd: 50 }, observedAt: 1_000, servedFrom: "live" };
    },
  };
  return { lane, calls };
}

describe("makeFlowService — one reading, assembled on the orchestrator", () => {
  it("joins the flow and the creator's sells, the creator resolved here from the chain", async () => {
    const { lane, calls } = fakeLane();
    const looked: string[] = [];
    const svc = makeFlowService({ lane, creatorOf: async (t) => (looked.push(t), { state: "known", creator: CREATOR }) });
    const r = await svc.flowFor(TOKEN.toUpperCase().replace("0X", "0x"));
    assert.ok(r.ok);
    assert.deepEqual(r.facts.creator, { state: "read", windowMin: CREATOR_WINDOW_MIN, sells: 1, sellUsd: 50, transfersOut: 1, transferOutUsd: 50 });
    assert.equal(r.facts.observedAt, 1_000);
    assert.deepEqual(looked, [TOKEN]);
    assert.deepEqual(calls.map((c) => c.q), ["tokenFlow", "creatorFlow"]);
    assert.deepEqual(calls[1]!.args.slice(0, 2), [TOKEN, CREATOR]);
    assert.ok(!JSON.stringify(r).includes(CREATOR.slice(2)), "the creator's address is a query variable, never part of the reading");
  });

  it("a coin with no recorded creator is 'not-derivable', and nothing is spent asking", async () => {
    const { lane, calls } = fakeLane();
    const r = await makeFlowService({ lane, creatorOf: async () => ({ state: "none" }) }).flowFor(TOKEN);
    assert.ok(r.ok);
    assert.deepEqual(r.facts.creator, { state: "not-derivable" });
    assert.deepEqual(calls.map((c) => c.q), ["tokenFlow"]);
  });

  it("an unreadable chain, or a failed creator query, is 'unavailable' — never 'did not sell'", async () => {
    const a = await makeFlowService({ lane: fakeLane().lane, creatorOf: async () => { throw new Error("rpc down"); } }).flowFor(TOKEN);
    assert.ok(a.ok);
    assert.deepEqual(a.facts.creator, { state: "unavailable", failure: "unavailable" });
    const b = await makeFlowService({ lane: fakeLane({ creator: { ok: false, failure: "budget" } }).lane, creatorOf: async () => ({ state: "known", creator: CREATOR }) }).flowFor(TOKEN);
    assert.ok(b.ok);
    assert.deepEqual(b.facts.creator, { state: "unavailable", failure: "budget" });
  });

  it("a failed flow reading is the whole answer, and the creator's query is never sent", async () => {
    const { lane, calls } = fakeLane({ flow: { ok: false, failure: "provider-cooldown" } });
    const r = await makeFlowService({ lane, creatorOf: async () => ({ state: "known", creator: CREATOR }) }).flowFor(TOKEN);
    assert.deepEqual(r, { ok: false, failure: "provider-cooldown" });
    assert.deepEqual(calls.map((c) => c.q), ["tokenFlow"]);
  });

  it("the purpose decides the budget share, and the caller cannot pick a window", async () => {
    const { lane, calls } = fakeLane();
    const svc = makeFlowService({ lane, creatorOf: async () => ({ state: "known", creator: CREATOR }) });
    await svc.flowFor(TOKEN, { purpose: "evidence" });
    assert.deepEqual(calls.map((c) => (c.args.at(-1) as { purpose: string }).purpose), ["evidence", "evidence"]);
    assert.equal((calls[1]!.args[2] as { windowMin: number }).windowMin, CREATOR_WINDOW_MIN);
  });

  it("a creator lookup is remembered, a failed one only briefly", async () => {
    let t = 0;
    let n = 0;
    let answer: CreatorLookup = { state: "unreadable" };
    const svc = makeFlowService({ lane: fakeLane().lane, now: () => t, creatorOf: async () => (n++, answer) });
    await svc.flowFor(TOKEN);
    t += 61_000;
    answer = { state: "known", creator: CREATOR };
    await svc.flowFor(TOKEN);
    t += 12 * 3_600_000;
    await svc.flowFor(TOKEN);
    assert.equal(n, 2, "unreadable retried after a minute; known kept for a day");
  });

  it("a recorded 'creator' that is the token itself is no creator", async () => {
    const r = await makeFlowService({ lane: fakeLane().lane, creatorOf: async () => ({ state: "known", creator: TOKEN as `0x${string}` }) }).flowFor(TOKEN);
    assert.ok(r.ok);
    assert.deepEqual(r.facts.creator, { state: "not-derivable" });
  });

  it("one deadline for the whole reading, passed to both lane calls, under the broker's ceiling", async () => {
    assert.ok(FLOW_DEADLINE_MS < FLOW_BROKER_LIMITS.serveMaxCallMs, "a reading that succeeded is never discarded by the broker's ceiling");
    const { lane, calls } = fakeLane();
    const t = 5_000_000;
    await makeFlowService({ lane, now: () => t, creatorOf: async () => ({ state: "known", creator: CREATOR }) }).flowFor(TOKEN);
    assert.deepEqual(calls.map((c) => (c.args.at(-1) as { deadline: number }).deadline), [t + FLOW_DEADLINE_MS, t + FLOW_DEADLINE_MS]);
  });

  it("a caller waiting on less shortens the reading's deadline, never lengthens it", async () => {
    const t = 5_000_000;
    const deadlines = async (timeoutMs?: number) => {
      const { lane, calls } = fakeLane();
      await makeFlowService({ lane, now: () => t, creatorOf: async () => ({ state: "known", creator: CREATOR }) })
        .flowFor(TOKEN, timeoutMs === undefined ? {} : { timeoutMs });
      return calls.map((c) => (c.args.at(-1) as { deadline: number }).deadline);
    };
    assert.deepEqual(await deadlines(8_000), [t + 8_000, t + 8_000], "an X answer's share");
    assert.deepEqual(await deadlines(60_000), [t + FLOW_DEADLINE_MS, t + FLOW_DEADLINE_MS], "never past the reading's own deadline");
    assert.deepEqual(await deadlines(0), [t + FLOW_DEADLINE_MS, t + FLOW_DEADLINE_MS], "a nonsense wait is no wait");
    assert.deepEqual(await deadlines(), [t + FLOW_DEADLINE_MS, t + FLOW_DEADLINE_MS]);
  });

  it("a slow launcher lookup gives back the flow facts in time, launcher unavailable, and no launcher query is started", async () => {
    const { lane, calls } = fakeLane();
    const started = Date.now();
    const r = await makeFlowService({ lane, deadlineMs: 300, minLaneMs: 100, creatorOf: () => new Promise<CreatorLookup>(() => {}) }).flowFor(TOKEN);
    const took = Date.now() - started;
    assert.ok(r.ok, "the flow reading is not thrown away");
    assert.deepEqual(r.facts.creator, { state: "unavailable", failure: "timeout" });
    assert.deepEqual(calls.map((c) => c.q), ["tokenFlow"], "nothing more is spent once the time is gone");
    assert.ok(took < 1_000, `answered in ${took} ms`);
  });

  it("a flow reading that used up the time returns at once, launcher unavailable, never a late launcher query", async () => {
    let t = 0;
    const lane: Pick<BitqueryLane, "tokenFlow" | "creatorFlow"> = {
      async tokenFlow() {
        t += FLOW_DEADLINE_MS - BITQUERY_LANE_DEFAULTS.minRequestMs + 1;
        return { ok: true, data: READ, observedAt: 1_000, servedFrom: "live" };
      },
      async creatorFlow() {
        throw new Error("must not be asked");
      },
    };
    const r = await makeFlowService({ lane, now: () => t, creatorOf: async () => ({ state: "known", creator: CREATOR }) }).flowFor(TOKEN);
    assert.ok(r.ok);
    assert.deepEqual(r.facts.creator, { state: "unavailable", failure: "timeout" });
  });

  it("not a token is 'invalid-request'; nothing throws", async () => {
    const svc = makeFlowService({ lane: fakeLane().lane, creatorOf: async () => ({ state: "none" }) });
    assert.deepEqual(await svc.flowFor("pepe"), { ok: false, failure: "invalid-request" });
    const broken = makeFlowService({ lane: { tokenFlow: () => { throw new Error("boom"); }, creatorFlow: async () => ({ ok: false, failure: "network" }) }, creatorOf: async () => ({ state: "none" }) });
    assert.deepEqual(await broken.flowFor(TOKEN), { ok: false, failure: "unavailable" });
  });
});

describe("ponsLaunchCreatorLookup — the launchpad's record, never the token's word", () => {
  const pad = (a: string) => `0x${"0".repeat(24)}${a.slice(2)}`;
  const DECOY = "0x00000000000000000000000000000000000000d3";

  it("a contract that is not a Pons launch gets 'none', however it answers the template's metadata selector", async () => {
    let readContract = 0;
    let calls = 0;
    // The forger: answers eth_call (the metadata getter) with a decoy deployer.
    // The factory has no launch of it, so its logs come back empty.
    const client = {
      getBlockNumber: async () => 50_000_000n,
      request: async ({ method }: { method: string }) => (calls++, method === "eth_getLogs" ? [] : DECOY),
      readContract: async () => (readContract++, [{ success: true, returnData: "0x" }]),
    };
    assert.deepEqual(await ponsLaunchCreatorLookup(() => client as never)(TOKEN as `0x${string}`), { state: "none" });
    assert.equal(readContract, 0, "the token's own metadata is never asked who deployed it");
    assert.equal(calls, 1);
  });

  it("the creator topic of the factory's launch event is the launcher; an RPC failure is 'unreadable'", async () => {
    const launch = {
      address: PONS_V2_FACTORY.toLowerCase(),
      topics: [PONS_LAUNCH_TOPIC, pad(TOKEN), pad("0x00000000000000000000000000000000000000e9"), pad(CREATOR)],
      data: `0x${"0".repeat(64)}${"0".repeat(64)}${"1".padStart(64, "0")}`,
      blockNumber: "0x10",
      transactionHash: "0xabc",
    };
    const ok = { getBlockNumber: async () => 100n, request: async () => [launch] };
    assert.deepEqual(await ponsLaunchCreatorLookup(() => ok as never)(TOKEN as `0x${string}`), { state: "known", creator: CREATOR });
    const down = { getBlockNumber: async () => { throw new Error("rpc down"); }, request: async () => [] };
    assert.deepEqual(await ponsLaunchCreatorLookup(() => down as never)(TOKEN as `0x${string}`), { state: "unreadable" });
  });
});

/**
 * HERE, NOT IN flow-facts.test.ts, because only orchestrator files may import
 * both the room's gate and xpost/ (their boundary tests pin that).
 */
describe("flow facts reach X only as glosses the existing writer and gate admit unchanged", () => {
  const room = { vouchedSymbols: [], rosterNames: [], recentOwn: [], recentRoom: [] };

  it("every gloss passes the room's base gate (no numeral, no quantity word) and every X vocabulary clause", () => {
    for (const [band, glosses] of FLOW_X_GLOSS) {
      for (const g of glosses) {
        assert.deepEqual(admitAgentLine(g, room), { ok: true, text: g }, `${band}: ${g}`);
        assert.equal(vocabularyRefusal(g), null, `${band}: ${g}`);
        // The writer's clean(): one line, no guillemets or control characters, no digit.
        assert.doesNotMatch(g, /[\u0000-\u001f\u007f«»]|\p{N}/u, `${band}: ${g}`);
      }
    }
  });

  it("said as a whole post, a gloss passes the full X gate with the production base gate", () => {
    for (const [band, glosses] of FLOW_X_GLOSS) {
      for (const g of glosses) {
        const v = admitXPost(g, { kind: "casual", agentName: "Pine Stoat", mode: null, coins: [], recentOwn: [], recentFleet: [] }, admitAgentLine);
        assert.deepEqual(v, { ok: true, text: g }, `${band}: ${g}`);
      }
    }
  });

  it("a live-shaped reading renders only gate-clean lines", () => {
    const lines = flowXLines(
      {
        ok: true,
        facts: {
          token: TOKEN,
          observedAt: 1,
          windows: [
            { minutes: 5, buyUsd: 120, sellUsd: 1_500, buys: 2, sells: 9, buyers: 2, sellers: 6 },
            { minutes: 15, buyUsd: 300, sellUsd: 2_600, buys: 4, sells: 14, buyers: 3, sellers: 9 },
            { minutes: 60, buyUsd: 410, sellUsd: 3_100, buys: 5, sells: 17, buyers: 3, sellers: 11 },
          ],
          venues: [],
          largestSells: [{ usd: 2_000, at: 1, protocol: "uniswap_v4" }],
          creator: { state: "read", windowMin: CREATOR_WINDOW_MIN, sells: 3, sellUsd: 2_000, transfersOut: 1, transferOutUsd: 10 },
        },
      },
      "0x00000000000000000000000000000000000000f1|coin",
    );
    assert.equal(lines.length, 5);
    for (const l of lines) assert.equal(admitAgentLine(l, room).ok, true, l);
  });
});

describe("answerReadingsPerDay — X answers stay out of the evidence share", () => {
  it("is the day's points evidence cannot spend, at a whole reading's price", () => {
    const reading = LANE_POINTS.tokenFlow + LANE_POINTS.creatorFlow;
    const on = bitqueryLaneSetup({ MERRYMEN_BITQUERY_API_KEY: "ory_at_test" });
    assert.equal(answerReadingsPerDay(on), 200, "the defaults: 25,000 x 0.2 / 25");
    const small = bitqueryLaneSetup({ MERRYMEN_BITQUERY_API_KEY: "ory_at_test", MERRYMEN_BITQUERY_POINTS_PER_DAY: "5000" });
    assert.equal(answerReadingsPerDay(small), 40);
    // Even if every one of them were spent before any review asked, evidence keeps its whole share.
    for (const setup of [on, small]) {
      const day = setup.config!.pointsPerDay;
      assert.ok(answerReadingsPerDay(setup) * reading <= day - Math.floor(day * BITQUERY_LANE_DEFAULTS.evidenceShare));
    }
    assert.equal(answerReadingsPerDay(bitqueryLaneSetup({})), 0, "no lane, no readings");
    assert.equal(answerReadingsPerDay(bitqueryLaneSetup({ MERRYMEN_BITQUERY_API_KEY: "ory_at_test", MERRYMEN_BITQUERY_LANE: "0" })), 0);
  });
});

describe("startFlowRuntime — off without a key, and nothing built while off", () => {
  it("no key: no service, no store, a line saying so", () => {
    const lines: string[] = [];
    const home = mkdtempSync(path.join(os.tmpdir(), "merrymen-flow-rt-"));
    const rt = startFlowRuntime({ env: {}, home, rpcUrl: "https://example.invalid", log: (l) => lines.push(l) });
    assert.equal(rt.service, null);
    assert.match(lines.join("\n"), /bitquery lane: off/);
  });

  it("with a key: a service, its store under the fleet home, and the key never logged", () => {
    const lines: string[] = [];
    const home = mkdtempSync(path.join(os.tmpdir(), "merrymen-flow-rt-"));
    const rt = startFlowRuntime({ env: { MERRYMEN_BITQUERY_API_KEY: "ory_at_never_logged" }, home, rpcUrl: "https://example.invalid", log: (l) => lines.push(l) });
    assert.ok(rt.service);
    assert.doesNotMatch(lines.join("\n"), /ory_at_never_logged/);
    assert.ok(readFileSync(path.join(home, "bitquery-lane", "lane.sqlite")).length >= 0, "the fleet cache lives under the fleet home");
  });
});

/** A ChildProcess stand-in whose channel is an in-memory pair. */
function fakeChild(): { proc: ChildProcess; childPort: FlowPort; exit(): void } {
  const proc = new EventEmitter() as EventEmitter & { connected: boolean; send: (m: unknown, cb?: () => void) => boolean };
  const childSide = new EventEmitter();
  proc.connected = true;
  proc.send = (m, cb) => {
    setImmediate(() => childSide.emit("message", JSON.parse(JSON.stringify(m))));
    cb?.();
    return true;
  };
  const childPort: FlowPort = {
    send(m) {
      setImmediate(() => proc.emit("message", JSON.parse(JSON.stringify(m))));
      return true;
    },
    onMessage(h) {
      childSide.on("message", h);
      return () => childSide.off("message", h);
    },
    connected: () => proc.connected,
  };
  return { proc: proc as unknown as ChildProcess, childPort, exit: () => proc.emit("exit", 0) };
}

describe("attachFlowBroker — only allowlisted accounts, only as evidence", () => {
  const service = (): FlowService & { purposes: string[] } => {
    const purposes: string[] = [];
    return {
      purposes,
      async flowFor(t, o) {
        purposes.push(o?.purpose ?? "?");
        return { ok: true, facts: { token: t.toLowerCase() as `0x${string}`, observedAt: 1, ...READ, creator: { state: "not-derivable" } } };
      },
    };
  };

  it("an account on MERRYMEN_DECISION_RESEARCH_ACCOUNTS gets readings, spent from the evidence share", async () => {
    const svc = service();
    const c = fakeChild();
    attachFlowBroker(svc, "0x00000000000000000000000000000000000000f1", c.proc, LISTED_ACCOUNT, () => {}, { MERRYMEN_DECISION_RESEARCH_ACCOUNTS: LISTED_ACCOUNT.toLowerCase() });
    const r = await createFlowClient(c.childPort).facts(TOKEN);
    assert.equal(r.ok, true);
    assert.deepEqual(svc.purposes, ["evidence"]);
  });

  it("the review's own budget bounds the reading: the lane is never still spending after the child gave up", async () => {
    const { lane, calls } = fakeLane();
    const t = 5_000_000;
    const svc = makeFlowService({ lane, now: () => t, creatorOf: async () => ({ state: "known", creator: CREATOR }) });
    const c = fakeChild();
    attachFlowBroker(svc, "0x00000000000000000000000000000000000000f1", c.proc, LISTED_ACCOUNT, () => {}, { MERRYMEN_DECISION_RESEARCH_ACCOUNTS: LISTED_ACCOUNT });
    assert.equal((await createFlowClient(c.childPort).facts(TOKEN, { timeoutMs: 5_000 })).ok, true);
    const deadline = t + 5_000 - FLOW_BROKER_LIMITS.ipcMarginMs;
    assert.deepEqual(calls.map((x) => [(x.args.at(-1) as { purpose: string }).purpose, (x.args.at(-1) as { deadline: number }).deadline]),
      [["evidence", deadline], ["evidence", deadline]], "five seconds less the trip back, not the reading's eighteen");
  });

  it("any other account is answered 'unavailable' and costs nothing", async () => {
    const svc = service();
    const c = fakeChild();
    attachFlowBroker(svc, "0xother", c.proc, "0x00000000000000000000000000000000000000b0", () => {}, { MERRYMEN_DECISION_RESEARCH_ACCOUNTS: LISTED_ACCOUNT });
    assert.deepEqual(await createFlowClient(c.childPort).facts(TOKEN), { ok: false, failure: "unavailable" });
    assert.deepEqual(svc.purposes, []);
  });

  it("a no-op with the lane off or without a channel, and released when the child exits", async () => {
    const c = fakeChild();
    assert.equal(attachFlowBroker(null, "0xt", c.proc, LISTED_ACCOUNT, () => {}), null);
    const unconnected = fakeChild();
    (unconnected.proc as unknown as { connected: boolean }).connected = false;
    assert.equal(attachFlowBroker(service(), "0xt", unconnected.proc, LISTED_ACCOUNT, () => {}), null);
    const svc = service();
    const live = fakeChild();
    assert.ok(attachFlowBroker(svc, "0xt", live.proc, LISTED_ACCOUNT, () => {}, { MERRYMEN_DECISION_RESEARCH_ACCOUNTS: LISTED_ACCOUNT }));
    assert.equal((live.proc as unknown as EventEmitter).listenerCount("message"), 1);
    live.exit();
    assert.equal((live.proc as unknown as EventEmitter).listenerCount("message"), 0, "released on exit");
  });
});

describe("the orchestrator's wiring", () => {
  const SRC = readFileSync(path.join(HERE, "orchestrator.ts"), "utf8");

  it("attaches the flow broker right after the Fomo broker, with the smart account it spawned the child for", () => {
    const spawnChild = SRC.slice(SRC.indexOf("async function spawnChild("), SRC.indexOf("export type PaperRestore"));
    assert.match(spawnChild, /attachFomoBroker\(tenant, proc\);[\s\S]{0,300}attachFlowBroker\(flowRuntimeNow\(\)\.service, tenant, proc, smartAccount, log\);/);
  });

  it("does not open an IPC channel of its own: the spawn's stdio is still Fomo's decision", () => {
    // A Perps worker's spawn opens none at all: it asks nothing of either broker.
    assert.match(SRC, /stdio: perpsSlot \|\| fomoBootNow\(\)\.off \? \["ignore", "pipe", "pipe"\] : \["ignore", "pipe", "pipe", "ipc"\]/);
  });

  it("says the lane's switches at boot, right after Fomo's", () => {
    const boot = SRC.slice(SRC.indexOf("export async function runOrchestrator("));
    assert.match(boot, /fomoBootNow\(\);\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*flowRuntimeNow\(\);/);
  });

  it("exports flowFor for the orchestrator's own answers, on the whole day's budget, importable without a cycle", () => {
    const flow = readFileSync(path.join(HERE, "orchestrator-flow.ts"), "utf8");
    assert.match(flow, /export async function flowFor\(token: string, opts: \{ timeoutMs\?: number \} = \{\}\): Promise<FlowResult> \{[\s\S]{0,200}purpose: "answer"/);
    assert.doesNotMatch(flow, /from "\.\/orchestrator"/, "orchestrator-flow.ts never imports orchestrator.ts, so a pass can import it");
    assert.match(SRC, /export \{ flowFor \};/, "and orchestrator.ts re-exports it");
  });

  it("X answers read flow only with the lane on, through flowFor, on Robinhood Chain, with their own day's count", () => {
    const fn = SRC.slice(SRC.indexOf("function xAnswerFlow("), SRC.indexOf("function xAnswerFlow(") + 900);
    assert.match(fn, /const rt = flowRuntimeNow\(\);\s*if \(!rt\.service\) return \{\};/, "nothing at all with the lane off");
    assert.match(fn, /const flowPerDay = answerReadingsPerDay\(rt\.setup\);/);
    assert.match(fn, /q\.chainId === 4663 \? flowFor\(q\.address, \{ timeoutMs: q\.timeoutMs \}\)/);
    const research = SRC.slice(SRC.indexOf("research: createXResearch({"), SRC.indexOf("research: createXResearch({") + 900);
    assert.match(research, /\.\.\.xAnswerFlow\(\),/, "handed to the research, which runs only with MERRYMEN_XPOST_RESEARCH=1");
  });

  it("flowFor answers 'unavailable' when the lane is off, without building anything", async () => {
    const { flowFor, resetFlowRuntimeForTest } = await import("./orchestrator-flow");
    const saved = process.env.MERRYMEN_BITQUERY_API_KEY;
    delete process.env.MERRYMEN_BITQUERY_API_KEY;
    resetFlowRuntimeForTest();
    try {
      assert.deepEqual(await flowFor(TOKEN), { ok: false, failure: "unavailable" });
    } finally {
      if (saved !== undefined) process.env.MERRYMEN_BITQUERY_API_KEY = saved;
      resetFlowRuntimeForTest();
    }
  });

  it("MERRYMEN_BITQUERY_API_KEY is read by the orchestrator's setup alone — never by a child's code", () => {
    const files = ["index.ts", "settings.ts", "flow-broker.ts", "flow-facts.ts", "orchestrator-flow.ts", "venues/bitquery.ts", "venues/bitquery-lane.ts"];
    const readers = files.filter((f) => /process\.env\.MERRYMEN_BITQUERY_API_KEY|env\.MERRYMEN_BITQUERY_API_KEY/.test(readFileSync(path.join(HERE, f), "utf8")));
    assert.deepEqual(readers, ["venues/bitquery-lane.ts"], "only bitqueryLaneSetup reads it, from the env the orchestrator hands it");
    const index = readFileSync(path.join(HERE, "index.ts"), "utf8");
    assert.doesNotMatch(index, /from "\.\/venues\/bitquery-lane"|from "\.\/orchestrator-flow"/, "a child never imports the lane");
    assert.doesNotMatch(readFileSync(path.join(HERE, "venues", "bitquery-lane.ts"), "utf8"), /process\.env/, "the lane takes its env as an argument");
  });

  it("flow facts name no vendor, so nothing downstream learns one", () => {
    for (const f of ["flow-facts.ts", "flow-broker.ts"]) {
      const code = readFileSync(path.join(HERE, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      assert.doesNotMatch(code, /bitquery/i, `${f} speaks flow, not a supplier`);
    }
  });
});
