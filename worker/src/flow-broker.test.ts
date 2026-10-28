/**
 * The flow broker's two ends, wired to each other through an in-memory channel
 * that delivers asynchronously, as IPC does. Each test is one way a child could
 * spend the fleet's day, learn about a wallet it should not, or hang a review.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFlowClient, FLOW_BROKER_LIMITS, serveFlowRequests, type FlowPort } from "./flow-broker";
import type { FlowFacts, FlowResult } from "./flow-facts";

const TOKEN = "0x00000000000000000000000000000000000000c1";
const TOKEN_B = "0x00000000000000000000000000000000000000c2";
const TOKEN_C = "0x00000000000000000000000000000000000000c3";

function facts(token = TOKEN): FlowFacts {
  return {
    token: token as `0x${string}`,
    observedAt: Date.parse("2026-10-12T02:00:00Z"),
    windows: [5, 15, 60].map((minutes) => ({ minutes: minutes as 5 | 15 | 60, buyUsd: 10, sellUsd: 5, buys: 2, sells: 1, buyers: 2, sellers: 1 })),
    venues: [],
    largestSells: [],
    creator: { state: "not-derivable" },
  };
}

/** Two connected ends. `child` is what a forked worker holds; `parent` the orchestrator's. */
function channel(): { child: FlowPort; parent: FlowPort; sent: { from: "child" | "parent"; msg: unknown }[]; listeners: () => number; disconnect(): void; inject(to: "child" | "parent", msg: unknown): void } {
  const handlers = { child: new Set<(m: unknown) => void>(), parent: new Set<(m: unknown) => void>() };
  const gone = new Set<() => void>();
  const sent: { from: "child" | "parent"; msg: unknown }[] = [];
  let up = true;
  const end = (me: "child" | "parent", other: "child" | "parent"): FlowPort => ({
    send(msg) {
      if (!up) return false;
      sent.push({ from: me, msg });
      const copy = JSON.parse(JSON.stringify(msg)) as unknown;
      setImmediate(() => handlers[other].forEach((h) => h(copy)));
      return true;
    },
    onMessage(h) {
      handlers[me].add(h);
      return () => handlers[me].delete(h);
    },
    connected: () => up,
    onDisconnect(h) {
      gone.add(h);
      return () => gone.delete(h);
    },
  });
  return {
    child: end("child", "parent"),
    parent: end("parent", "child"),
    sent,
    listeners: () => handlers.child.size,
    disconnect() {
      up = false;
      gone.forEach((h) => h());
    },
    inject(to, msg) {
      setImmediate(() => handlers[to].forEach((h) => h(msg)));
    },
  };
}

const yes = () => true;

describe("the child's client", () => {
  it("without a channel, every question is 'unavailable' at once", async () => {
    const c = createFlowClient(null);
    assert.deepEqual(await c.facts(TOKEN), { ok: false, failure: "unavailable" });
  });

  it("asks for a token, and gets the orchestrator's reading back intact", async () => {
    const ch = channel();
    const asked: string[] = [];
    serveFlowRequests(ch.parent, "0xtenant", async (t) => {
      asked.push(t);
      return { ok: true, facts: facts(t) };
    }, { allowed: yes });
    const c = createFlowClient(ch.child);
    const r = await c.facts(TOKEN.toUpperCase().replace("0X", "0x"));
    assert.deepEqual(r, { ok: true, facts: facts() });
    assert.deepEqual(asked, [TOKEN], "lowercased before it reaches the lane");
  });

  it("a token that is not one is refused without a message being sent", async () => {
    const ch = channel();
    const c = createFlowClient(ch.child);
    for (const bad of ["", "0x12", "0x0000000000000000000000000000000000000000", "pepe"]) {
      assert.deepEqual(await c.facts(bad), { ok: false, failure: "invalid-request" });
    }
    assert.equal(ch.sent.length, 0);
  });

  it("two questions about one token share one request", async () => {
    const ch = channel();
    serveFlowRequests(ch.parent, "0xtenant", async (t) => ({ ok: true, facts: facts(t) }), { allowed: yes });
    const c = createFlowClient(ch.child);
    const [a, b] = await Promise.all([c.facts(TOKEN), c.facts(TOKEN)]);
    assert.deepEqual(a, b);
    assert.equal(ch.sent.filter((s) => s.from === "child").length, 1);
  });

  it("listens on the channel only while something is pending", async () => {
    const ch = channel();
    serveFlowRequests(ch.parent, "0xtenant", async (t) => ({ ok: true, facts: facts(t) }), { allowed: yes });
    const c = createFlowClient(ch.child);
    assert.equal(ch.listeners(), 0);
    const p = c.facts(TOKEN);
    assert.equal(ch.listeners(), 1);
    await p;
    assert.equal(ch.listeners(), 0, "an idle client never keeps a child alive");
  });

  it("a reply in the wrong shape is 'invalid-shape', never a reading", async () => {
    const ch = channel();
    ch.parent.onMessage((m) => {
      const id = (m as { id: string }).id;
      ch.parent.send({ flow: 1, id, ok: true, result: { ok: true, facts: { ...facts(), windows: [] } } as unknown as FlowResult });
    });
    const c = createFlowClient(ch.child);
    assert.deepEqual(await c.facts(TOKEN), { ok: false, failure: "invalid-shape" });
  });

  it("a slow orchestrator is a timeout, and a dropped channel is unavailable — never a hang", async () => {
    const quiet = channel();
    const c = createFlowClient(quiet.child, { timeoutMs: 20 });
    assert.deepEqual(await c.facts(TOKEN), { ok: false, failure: "timeout" });

    const ch = channel();
    const d = createFlowClient(ch.child);
    const p = d.facts(TOKEN);
    ch.disconnect();
    assert.deepEqual(await p, { ok: false, failure: "unavailable" });
  });

  it("ignores Fomo's messages on the shared channel, and Fomo's broker would ignore these", async () => {
    const ch = channel();
    const c = createFlowClient(ch.child, { timeoutMs: 50 });
    const p = c.facts(TOKEN);
    const id = (ch.sent[0]!.msg as { id: string }).id;
    ch.inject("child", { fomo: 1, id, ok: true, result: { ok: true, facts: facts() } });
    assert.deepEqual(await p, { ok: false, failure: "timeout" }, "a fomo-tagged reply cannot settle a flow request");
    assert.equal((ch.sent[0]!.msg as Record<string, unknown>).fomo, undefined);
  });
});

describe("the orchestrator's end", () => {
  it("a child off the allowlist is answered 'unavailable', and the lane is never asked", async () => {
    const ch = channel();
    let asked = 0;
    serveFlowRequests(ch.parent, "0xtenant", async (t) => {
      asked++;
      return { ok: true, facts: facts(t) };
    });
    const c = createFlowClient(ch.child);
    assert.deepEqual(await c.facts(TOKEN), { ok: false, failure: "unavailable" }, "the default is no");
    assert.equal(asked, 0);
  });

  it("the allowlist is asked on every request, so an operator's change applies without a respawn", async () => {
    const ch = channel();
    let on = false;
    serveFlowRequests(ch.parent, "0xtenant", async (t) => ({ ok: true, facts: facts(t) }), { allowed: () => on });
    const c = createFlowClient(ch.child);
    assert.equal((await c.facts(TOKEN)).ok, false);
    on = true;
    assert.equal((await c.facts(TOKEN)).ok, true);
  });

  it("nothing a child adds to a request is read: not a tenant, a creator or a window", async () => {
    const ch = channel();
    const logs: string[] = [];
    const seen: unknown[][] = [];
    serveFlowRequests(ch.parent, "0xtenant", async (...args) => {
      seen.push(args);
      return { ok: true, facts: facts(args[0]) };
    }, { allowed: yes, log: (l) => logs.push(l) });
    ch.inject("parent", { flow: 1, id: "req-1", op: "facts", token: TOKEN, tenant: "0xsomeoneelse", creator: "0x00000000000000000000000000000000000000a7", windowMin: 9999 });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(seen, [[TOKEN]], "the lane is handed the token and nothing else");
    assert.match(logs.join("\n"), /ignored unexpected field "tenant"/);
    assert.match(logs.join("\n"), /ignored unexpected field "creator"/);
  });

  it("the child's wait travels with its question, less the trip back, and only ever shortens the orchestrator's work", async () => {
    const ch = channel();
    const seen: unknown[][] = [];
    serveFlowRequests(ch.parent, "0xtenant", async (...args) => {
      seen.push(args);
      return { ok: true, facts: facts(args[0]) };
    }, { allowed: yes });
    const c = createFlowClient(ch.child);
    assert.equal((await c.facts(TOKEN, { timeoutMs: 5_000 })).ok, true);
    assert.deepEqual(seen.at(-1), [TOKEN, 5_000 - FLOW_BROKER_LIMITS.ipcMarginMs], "a review's five seconds, less the IPC margin");
    ch.inject("parent", { flow: 1, id: "long", op: "facts", token: TOKEN_B, timeoutMs: 600_000 });
    ch.inject("parent", { flow: 1, id: "word", op: "facts", token: TOKEN_C, timeoutMs: "forever" });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(seen.slice(1), [[TOKEN_B, FLOW_BROKER_LIMITS.serveMaxCallMs], [TOKEN_C]], "never past the ceiling; a wait that is not a number is no wait");
    // A child that will have stopped waiting before anything could come back is answered at once, and nothing is asked.
    const before = seen.length;
    ch.inject("parent", { flow: 1, id: "short", op: "facts", token: TOKEN, timeoutMs: FLOW_BROKER_LIMITS.ipcMarginMs });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(seen.length, before);
    const reply = ch.sent.find((m) => m.from === "parent" && (m.msg as { id?: string }).id === "short")?.msg;
    assert.deepEqual(reply, { flow: 1, id: "short", ok: true, result: { ok: false, failure: "timeout" } });
  });

  it("each child has its own rate; a repeat of a question in flight is free", async () => {
    const ch = channel();
    const releases: (() => void)[] = [];
    serveFlowRequests(ch.parent, "0xtenant", (t) => new Promise<FlowResult>((r) => releases.push(() => r({ ok: true, facts: facts(t) }))), { allowed: yes, perMinute: 2, maxInFlight: 5 });
    const c = createFlowClient(ch.child);
    const a = c.facts(TOKEN);
    const b = c.facts(TOKEN_B);
    await new Promise((r) => setTimeout(r, 5));
    const third = await c.facts(TOKEN_C);
    assert.deepEqual(third, { ok: false, failure: "budget" }, "the third distinct token in a minute");
    releases.forEach((r) => r());
    assert.equal((await a).ok && (await b).ok, true);
  });

  it("an answer that throws is 'unavailable'; one that never comes is 'timeout' at the orchestrator's ceiling", async () => {
    const ch = channel();
    serveFlowRequests(ch.parent, "0xtenant", async (t) => {
      if (t === TOKEN) throw new Error("https://streaming.bitquery.io/graphql?key=leak");
      return new Promise<FlowResult>(() => {});
    }, { allowed: yes, maxCallMs: 20 });
    const c = createFlowClient(ch.child);
    assert.deepEqual(await c.facts(TOKEN), { ok: false, failure: "unavailable" });
    assert.deepEqual(await c.facts(TOKEN_B), { ok: false, failure: "timeout" });
  });

  it("a request that is too large or the wrong op is refused by word", async () => {
    const ch = channel();
    const replies: unknown[] = [];
    ch.child.onMessage((m) => replies.push(m));
    serveFlowRequests(ch.parent, "0xtenant", async (t) => ({ ok: true, facts: facts(t) }), { allowed: yes });
    ch.inject("parent", { flow: 1, id: "big", op: "facts", token: TOKEN, pad: "x".repeat(2000) });
    ch.inject("parent", { flow: 1, id: "op", op: "query", token: TOKEN, query: "{ EVM { Events { Block { Time } } } }" });
    ch.inject("parent", { flow: 1, id: "nope", op: "facts", token: "pepe" });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(replies, [
      { flow: 1, id: "big", ok: false, error: "request-too-large" },
      { flow: 1, id: "op", ok: false, error: "invalid-request" },
      { flow: 1, id: "nope", ok: false, error: "invalid-request" },
    ]);
  });

  it("ignores everything that is not a flow message — Fomo shares this channel", async () => {
    const ch = channel();
    let asked = 0;
    serveFlowRequests(ch.parent, "0xtenant", async (t) => {
      asked++;
      return { ok: true, facts: facts(t) };
    }, { allowed: yes });
    ch.inject("parent", { fomo: 1, id: "f1", op: "call", tool: "fomo_get_rankings", args: {} });
    ch.inject("parent", "hello");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(asked, 0);
    assert.equal(ch.sent.length, 0, "and answers none of them");
  });

  it("an answer in the wrong shape never leaves the orchestrator as a reading", async () => {
    const ch = channel();
    serveFlowRequests(ch.parent, "0xtenant", async () => ({ ok: true, facts: { token: "0xbad" } }) as unknown as FlowResult, { allowed: yes });
    const c = createFlowClient(ch.child);
    assert.deepEqual(await c.facts(TOKEN), { ok: false, failure: "invalid-shape" });
  });
});
