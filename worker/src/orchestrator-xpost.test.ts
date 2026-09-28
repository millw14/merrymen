/**
 * Posting on X, as the orchestrator runs it: the few lines of orchestrator.ts
 * it depends on (pinned through the TypeScript parser, like the room's), the
 * operator's knobs, the X gate composed with the room's real agent-line gate,
 * and one step() after another over an in-memory sqlite with a fake room and
 * a scripted X — intro first, a paper buy only after it and only after
 * consent, nothing posted twice, stale and asleep handled.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

process.env.MERRYMEN_HOME = path.join(process.cwd(), ".test-orch-xpost-home");
process.env.MERRYMEN_HOSTED = "1";
process.env.GROQ_API_KEY = "house-groq-key";
process.env.MERRYMEN_X_CLIENT_SECRET = "x-client-secret-never-to-a-child";
process.env.MERRYMEN_XPOST_LLM_KEY = "gsk_x_only_key_never_to_a_child";

const { childEnv } = await import("./orchestrator");
const { makeXPoster, xpostEnv, xpostSetup } = await import("./orchestrator-xpost");
const { admitAgentLine } = await import("./groupchat/policy");
const { isAsleep } = await import("./groupchat/clock");
const { admitXPost } = await import("./xpost/gate");
const { wrapSqlite } = await import("./db");
const store = await import("./xpost/store");
const { PAUSE_KEY } = await import("./xpost/sender");
const { GAP_MS } = await import("./xpost/planner");

import type { AgentFacts, CallFact } from "./groupchat/facts";
import type { Db } from "./db";
import type { LlmCreds } from "./llm";
import type { FetchLike, XApp } from "./xpost/client";
import type { XPosterDeps } from "./orchestrator-xpost";
import type { XGateCtx } from "./xpost/gate";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "orchestrator.ts"), "utf8");
const AST = ts.createSourceFile("orchestrator.ts", SRC, ts.ScriptTarget.Latest, true);

function all(root: ts.Node, keep: (n: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    if (keep(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

function callsTo(root: ts.Node, name: string): ts.CallExpression[] {
  return all(root, (n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) as ts.CallExpression[];
}

function fn(name: string): ts.FunctionDeclaration {
  const f = AST.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
  assert.ok(f?.body, `function ${name} not found in orchestrator.ts`);
  return f;
}

function within(node: ts.Node, ancestor: ts.Node): boolean {
  for (let p: ts.Node | undefined = node; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

// ── orchestrator.ts ─────────────────────────────────────────────────────────

describe("X's secrets never reach a child", () => {
  it("childEnv strips the X client secret and the X writer's key, and still passes the house keys", () => {
    const env = childEnv("0xABCDef0000000000000000000000000000000001");
    assert.equal(env.MERRYMEN_X_CLIENT_SECRET, undefined, "with it and one refresh token, anybody could keep an owner's account posting");
    assert.equal(env.MERRYMEN_XPOST_LLM_KEY, undefined, "a child holding the writer's key could spend it on anything");
    assert.equal(env.GROQ_API_KEY, "house-groq-key");
  });
});

describe("the X pass is started, never awaited, and only when the fleet is not halted", () => {
  it("startXPostPass() is called once, as a bare statement, right after startGroupChatPass() in the not-halted branch", () => {
    const loop = fn("runOrchestrator");
    const sites = callsTo(AST, "startXPostPass");
    assert.equal(sites.length, 1, "one call site");
    const call = sites[0]!;
    assert.ok(within(call, loop), "called from the main loop");
    const stmt = call.parent;
    assert.ok(ts.isExpressionStatement(stmt), "a bare statement: no await, no return, nothing that waits on it");
    const branch = stmt.parent;
    assert.ok(ts.isBlock(branch), "directly in a block");
    const ifs = branch.parent;
    assert.ok(
      ts.isIfStatement(ifs) && ifs.elseStatement === branch && ifs.expression.getText() === "haltRequested()",
      "inside the else of `if (haltRequested())`, so FLEET_HALT silences X too",
    );
    const room = branch.statements.findIndex((s) => s.getText() === "startGroupChatPass();");
    assert.ok(room >= 0, "the room's pass is in the same branch");
    assert.equal(branch.statements.indexOf(stmt), room + 1, "right after the room's, and so after the mirror and the news pass");
  });

  it("nothing awaits the pass, and one latch guards it", () => {
    const start = fn("startXPostPass");
    assert.ok(!start.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword), "startXPostPass is synchronous");
    const runs = callsTo(AST, "runXPostPass");
    assert.equal(runs.length, 1, "one caller of runXPostPass");
    assert.ok(within(runs[0]!, start), "and it is startXPostPass, behind the in-flight latch");
    assert.match(start.getText(), /if \(xPostInFlight \|\| stopping\) return;/);
    assert.match(start.getText(), /xPostInFlight = true;/);
    const awaited = all(AST, (n) => ts.isAwaitExpression(n) && /\b(?:start|run)XPostPass\b/.test(n.expression.getText()));
    assert.deepEqual(awaited.map((n) => n.getText()), []);
  });

  it("the roster is the room's: children with a healthy lease, keyed lowercased", () => {
    const run = fn("runXPostPass").getText();
    assert.match(run, /if \(!held \|\| !held\.healthy\(\)\) continue;/);
    assert.match(run, /roster\.push\(\{ tenant: key, agentId: child\.smartAccount\.toLowerCase\(\) \}\)/);
    assert.match(run, /xPoster\.step\(shared, roster, tenantChatProfile, Date\.now\(\)\)/);
  });

  it("the orchestrator reads the X knobs only through xpostSetup", () => {
    const direct = all(AST, (n) => ts.isPropertyAccessExpression(n) && n.expression.getText() === "process.env" && /^MERRYMEN_X/.test(n.name.text));
    assert.deepEqual(direct.map((n) => n.getText()), []);
    assert.equal(callsTo(fn("startXPostPass"), "xpostSetup").length, 1);
  });
});

// ── the knobs ───────────────────────────────────────────────────────────────

describe("xpostEnv reads the knobs the way an operator means them", () => {
  it("unset and set-but-blank are both the default", () => {
    assert.deepEqual(xpostEnv({}), { off: null, perDay: undefined, fleetPerDay: undefined, llmPerDay: undefined, notes: [] });
    assert.deepEqual(xpostEnv({ MERRYMEN_XPOST_PER_DAY: "", MERRYMEN_XPOST_FLEET_PER_DAY: " ", MERRYMEN_XPOST_LLM_PER_DAY: "" }), {
      off: null,
      perDay: undefined,
      fleetPerDay: undefined,
      llmPerDay: undefined,
      notes: [],
    });
  });

  it("readable values pass through", () => {
    const k = xpostEnv({ MERRYMEN_XPOST_PER_DAY: " 2 ", MERRYMEN_XPOST_FLEET_PER_DAY: "500", MERRYMEN_XPOST_LLM_PER_DAY: "0" });
    assert.deepEqual(k, { off: null, perDay: 2, fleetPerDay: 500, llmPerDay: 0, notes: [] });
  });

  it("MERRYMEN_XPOST=0 is off, and says so", () => {
    for (const v of ["0", " 0 "]) assert.match(xpostEnv({ MERRYMEN_XPOST: v }).off ?? "", /MERRYMEN_XPOST=0/);
    for (const v of ["", "1", "no"]) assert.equal(xpostEnv({ MERRYMEN_XPOST: v }).off, null, v);
  });

  it("zero posts a day, per owner or per fleet, is off rather than the default", () => {
    assert.match(xpostEnv({ MERRYMEN_XPOST_PER_DAY: "0" }).off ?? "", /MERRYMEN_XPOST_PER_DAY=0/);
    assert.match(xpostEnv({ MERRYMEN_XPOST_FLEET_PER_DAY: "0.4" }).off ?? "", /MERRYMEN_XPOST_FLEET_PER_DAY=0/);
  });

  it("an unreadable cadence keeps its default and says so", () => {
    for (const v of ["lots", "-1", "1,000"]) {
      const k = xpostEnv({ MERRYMEN_XPOST_PER_DAY: v });
      assert.equal(k.off, null);
      assert.equal(k.perDay, undefined);
      assert.match(k.notes[0] ?? "", /^xpost: ignoring MERRYMEN_XPOST_PER_DAY /);
    }
  });

  it("an unreadable spend knob fails closed and says so", () => {
    for (const v of ["1,000", "-5", "many"]) {
      assert.match(xpostEnv({ MERRYMEN_XPOST_FLEET_PER_DAY: v }).off ?? "", /MERRYMEN_XPOST_FLEET_PER_DAY is set but .*nothing is posted/);
      const k = xpostEnv({ MERRYMEN_XPOST_LLM_PER_DAY: v });
      assert.equal(k.llmPerDay, 0, `${v}: a budget nobody can read is spent as none`);
      assert.match(k.notes[0] ?? "", /MERRYMEN_XPOST_LLM_PER_DAY is set but/);
    }
  });
});

describe("xpostSetup: off unless everything posting needs is there, and never a key in the log", () => {
  const DEK = randomBytes(32);
  const ON = { MERRYMEN_X_CLIENT_ID: "id", MERRYMEN_X_CLIENT_SECRET: "the-secret", DATABASE_URL: "postgres://db" };

  it("off without the X app, a database or a DEK", () => {
    assert.match(xpostSetup({ DATABASE_URL: "postgres://db" }, DEK).off ?? "", /X app is not configured/);
    assert.match(xpostSetup({ MERRYMEN_X_CLIENT_ID: "id", MERRYMEN_X_CLIENT_SECRET: "s" }, DEK).off ?? "", /no DATABASE_URL/);
    assert.match(xpostSetup(ON, null).off ?? "", /MERRYMEN_STORE_DEK/);
    assert.match(xpostSetup({ ...ON, MERRYMEN_XPOST: "0" }, DEK).off ?? "", /MERRYMEN_XPOST=0/);
  });

  it("on: the writer is X's own key, or the room's dedicated one, or none", () => {
    const own = xpostSetup({ ...ON, MERRYMEN_XPOST_LLM_KEY: "gsk_x" }, DEK);
    assert.equal(own.off, null);
    assert.equal(own.creds?.apiKey, "gsk_x");
    const room = xpostSetup({ ...ON, MERRYMEN_GROUPCHAT_LLM_KEY: "gsk_room" }, DEK);
    assert.equal(room.creds?.apiKey, "gsk_room");
    assert.equal(xpostSetup(ON, DEK).creds, null);
    assert.equal(xpostSetup({ ...ON, MERRYMEN_XPOST_LLM_KEY: "house", GROQ_API_KEY: "house" }, DEK).creds, null, "a fleet key is refused");
  });

  it("no line ever carries a key or the client secret", () => {
    for (const env of [
      { ...ON, MERRYMEN_XPOST_LLM_KEY: "gsk_x_secret" },
      { ...ON, MERRYMEN_GROUPCHAT_LLM_KEY: "gsk_room_secret" },
      { ...ON, MERRYMEN_XPOST_LLM_KEY: "gsk_x_secret", GROQ_API_KEY: "gsk_x_secret" },
      { ...ON, MERRYMEN_XPOST_LLM_PER_DAY: "gsk_x_secret" },
    ]) {
      const lines = xpostSetup(env, DEK).lines.join("\n");
      for (const secret of ["gsk_x_secret", "gsk_room_secret", "the-secret"]) assert.ok(!lines.includes(secret), lines);
    }
  });
});

// ── the gate, composed with the room's ──────────────────────────────────────

describe("the X gate on top of the room's real agent-line gate", () => {
  const base = (raw: string, ctx: Parameters<typeof admitAgentLine>[1]) => admitAgentLine(raw, ctx);
  const ctx = (over: Partial<XGateCtx> = {}): XGateCtx => ({ kind: "casual", agentName: "Pine Stoat", mode: "paper", coins: [], recentOwn: [], recentFleet: [], ...over });
  const reason = (text: string, over: Partial<XGateCtx> = {}) => {
    const v = admitXPost(text, ctx(over), base);
    return v.ok ? "ok" : v.reason;
  };
  const buyPaper = { kind: "buy" as const, mode: "paper" as const, coins: ["Pepe", "PEPE"], paperCoins: ["Pepe", "PEPE"] };

  const natural: [string, Partial<XGateCtx>][] = [
    ["slow afternoons make me weirdly calm, nothing to prove", {}],
    ["honestly i think soup counts as a meal, and i will not be taking questions", {}],
    ["steady basket keeps me calm. a little of everything, no drama", {}],
    ["can't decide if the quiet days or the busy ones suit me better", {}],
    ["hi, i'm Pine Stoat, an AI agent that trades for the person who runs this account, on paper for now. i'll share what i pick up and why", { kind: "intro" }],
    ["Hello! I'm Pine Stoat, the AI trading agent for whoever owns this account. Real money, careful hands.", { kind: "intro", mode: "live" }],
    ["picked up some pepe on paper today, the curve looked early and that was enough for me", buyPaper],
    ["grabbed some $PEPE on paper, early curve and mostly new buyers", buyPaper],
    ["added a little tesla today, i like a quiet tape and a deep pool", { kind: "buy", mode: "live", coins: ["Tesla", "TSLA"] }],
  ];
  for (const [text, over] of natural) {
    it(`accepts: ${text.slice(0, 70)}`, () => assert.equal(reason(text, over), "ok"));
  }

  const refused: [string, Partial<XGateCtx>, string][] = [
    ["BUY ALERT: $PEPE on paper, curve early", buyPaper, "alert"],
    ["just bought pepe on paper, curve early", buyPaper, "alert"],
    ["my trade failed on paper, slippage again", {}, "ops"],
    ["insufficient balance so i sat this one out", {}, "ops"],
    ["pepe to the moon on paper, lfg", buyPaper, "hype"],
    ["you should grab some pepe on paper before it runs", buyPaper, "hype"],
    ["picked up pepe on paper at 3 cents", buyPaper, "has-digits"],
    ["bought twenty pepe on paper today, felt right", buyPaper, "quantity"],
    ["picked up some pepe today, the curve looked early", buyPaper, "paper-unsaid"],
    ["$BONK looks fun today, on paper of course", {}, "unvouched-ticker"],
    ["more thoughts at merrymen.dev today, on paper", {}, "link"],
    ["@elonmusk what do you think of quiet markets", {}, "handle"],
    ["@Pine Stoat is having a quiet day on paper", {}, "handle"],
    ["hello, i'm Pine Stoat and i'll post what i buy here", { kind: "intro" }, "undisclosed"],
  ];
  for (const [text, over, want] of refused) {
    it(`refuses (${want}): ${text.slice(0, 60)}`, () => assert.equal(reason(text, over), want));
  }
});

// ── step(), end to end ──────────────────────────────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;
const TENANT = `0x${"ab".repeat(20)}`;
const AGENT = `0x${"cd".repeat(20)}`;
const APP: XApp = { clientId: "client-id", clientSecret: "client-secret", redirectUri: "https://app.test/connect/x" };
const CREDS: LlmCreds = { provider: "groq", transport: "openai", baseUrl: "https://api.groq.com/openai/v1", apiKey: "gsk_x", model: "m", vision: false };
const INTRO = "hi, i'm Pine Stoat, an AI agent that trades for the person who runs this account, on paper for now. i'll share what i pick up and why";
const BUY = "picked up some pepe on paper today, the curve looked early and that was enough for me";

interface World {
  db: Db;
  dek: Buffer;
  tweets: string[];
  prompts: string[];
  fetch: FetchLike;
}

async function world(t: { after(fn: () => void): void }, consentAtMs: number): Promise<World> {
  const raw = new DatabaseSync(":memory:");
  t.after(() => raw.close());
  const db = wrapSqlite(raw);
  const dek = randomBytes(32);
  await store.ensureXpostSchema(db, "sqlite");
  await store.upsertAccount(db, dek, {
    tenant: TENANT,
    xUserId: "111",
    username: "robin_trades",
    tokens: { accessToken: "access-token", refreshToken: "refresh-token", accessExpiresAtMs: consentAtMs + 30 * 24 * HOUR, scope: "tweet.write" },
    nowMs: consentAtMs - MIN,
  });
  await store.setPosting(db, TENANT, { enabled: true, xUserId: "111" }, consentAtMs);
  const tweets: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    assert.equal(url, "https://api.x.com/2/tweets", "no refresh is needed with a fresh token");
    tweets.push(String(JSON.parse(init.body ?? "{}").text));
    const text = JSON.stringify({ data: { id: String(1840000000000000000n + BigInt(tweets.length)) } });
    return { status: 201, headers: { get: () => null }, text: async () => text };
  };
  return { db, dek, tweets, prompts: [], fetch };
}

function call(over: Partial<CallFact>): CallFact {
  return { side: "buy", symbol: "PEPE", name: "Pepe", token: null, paper: true, decisionId: "d", atSec: 0, bands: ["curve early"], ownWords: null, ...over };
}

function factsOf(calls: CallFact[], mode: AgentFacts["mode"] = "paper", others: Record<string, CallFact[]> = {}) {
  return async (_db: Db, _roster: unknown, _profiles: unknown, nowSec: number) =>
    new Map<string, AgentFacts>(
      [[TENANT, calls] as const, ...Object.entries(others)].map(([tenant, cs], i) => [
        tenant,
        { tenant, agentId: AGENT, slug: null, name: i === 0 ? "Pine Stoat" : "Moss Otter", mode, ageDays: 3, strategy: "steady-basket", traits: [], calls: cs.filter((c) => c.atSec <= nowSec) },
      ]),
    );
}

function poster(
  w: World,
  over: {
    calls?: CallFact[];
    /** Other owners' calls, by tenant. */
    others?: Record<string, CallFact[]>;
    tz?: string | null;
    creds?: LlmCreds | null;
    answer?: (prompt: string) => string;
    llmPerDay?: number;
    fleetPerDay?: number;
    fetch?: FetchLike;
    member?: XPosterDeps["member"];
    facts?: XPosterDeps["facts"];
  } = {},
) {
  const answer =
    over.answer ??
    ((prompt: string) => (/very first post/.test(prompt) ? INTRO : /What happened: you bought/.test(prompt) ? BUY : "slow afternoons make me weirdly calm, nothing to prove"));
  return makeXPoster({
    creds: over.creds === undefined ? CREDS : over.creds,
    knobs: { ...xpostEnv({}), llmPerDay: over.llmPerDay, fleetPerDay: over.fleetPerDay },
    app: APP,
    dek: w.dek,
    deps: {
      fetch: over.fetch ?? w.fetch,
      dialect: "sqlite",
      facts: over.facts ?? (factsOf(over.calls ?? [], "paper", over.others) as never),
      member: over.member ?? (async () => ({ tz: over.tz ?? null })),
      llm: async (_creds, { prompt }) => {
        w.prompts.push(prompt);
        return answer(prompt);
      },
    },
  });
}

const ROSTER = [{ tenant: TENANT.toUpperCase().replace("0X", "0x"), agentId: AGENT }];

async function rows(w: World) {
  return (await store.postsOf(w.db, TENANT, 0, 100)).reverse();
}

describe("one step after another", () => {
  // 08:00 UTC, and no zone: never asleep, and hours before any casual slot.
  const T0 = Date.UTC(2026, 8, 28, 8, 0);

  it("the intro first; then a paper buy made after consent, and only that one; nothing twice", async (t) => {
    const w = await world(t, T0);
    const calls = [
      call({ decisionId: "d-before", symbol: "BONK", name: "Bonk", atSec: (T0 - HOUR) / 1000 }),
      call({ decisionId: "d-pepe", atSec: (T0 + 2 * MIN) / 1000 }),
    ];
    const p = poster(w, { calls });
    const logs: (string | null)[] = [];
    const step = async (at: number) => logs.push((await p.step(w.db, ROSTER, new Map(), at)).log);

    await step(T0 + MIN);
    let r = await rows(w);
    assert.deepEqual(r.map((x) => [x.kind, x.status]), [["intro", "scheduled"]]);
    assert.equal(r[0]?.body, INTRO);
    assert.equal(r[0]?.dueAtMs, T0 + 11 * MIN, "ten minutes after it is drafted, visible under Coming up first");
    assert.equal(w.tweets.length, 0);

    await step(T0 + 3 * MIN);
    assert.deepEqual((await rows(w)).map((x) => x.kind), ["intro"], "nothing else while the intro waits, even a fresh buy");

    await step(T0 + 11 * MIN);
    assert.deepEqual(w.tweets, [INTRO], "the intro went out");
    r = await rows(w);
    assert.deepEqual(r.map((x) => [x.kind, x.status, x.decisionId]), [["intro", "posted", null], ["buy", "scheduled", "d-pepe"]]);
    const buy = r[1]!;
    assert.equal(buy.body, BUY);
    assert.equal(buy.coin, "pepe");
    assert.ok(buy.dueAtMs >= T0 + 12 * MIN && buy.dueAtMs <= T0 + 42 * MIN);
    assert.equal(await store.keyStatus(w.db, "buy:d-before"), null, "a buy made before consent is never posted about");

    await step(T0 + 11 * MIN + 30_000);
    await step(T0 + 13 * MIN);
    assert.equal((await rows(w)).length, 2, "planned once");
    assert.equal(w.tweets.length, 1);

    await step(buy.dueAtMs);
    await step(buy.dueAtMs);
    await step(buy.dueAtMs + MIN);
    assert.deepEqual(w.tweets, [INTRO, BUY], "each post once, however many passes see it due");
    assert.match(w.tweets[1]!, /paper/);
    assert.deepEqual((await rows(w)).map((x) => x.status), ["posted", "posted"]);
    assert.equal(w.prompts.length, 2, "one model call per post");

    const said = logs.filter((l): l is string => l !== null).join("\n");
    assert.match(said, /drafted-intro 1/);
    assert.match(said, /sent 1/);
    for (const secret of ["pepe", "curve", "Pine", "access-token", "refresh-token", "gsk_x"]) assert.ok(!said.includes(secret), `the log says ${secret}`);
  });

  it("a hello cancelled by switching off and on is drafted again, and still goes out before any coin post", async (t) => {
    const w = await world(t, T0);
    const p = poster(w, { calls: [call({ decisionId: "d-pepe", atSec: (T0 + 5 * MIN) / 1000 })] });
    await p.step(w.db, ROSTER, new Map(), T0 + MIN);
    assert.equal(await store.keyStatus(w.db, `intro:${TENANT}:111`), "scheduled");
    // Off inside the review window cancels the hello; on again is a new consent.
    await store.setPosting(w.db, TENANT, { enabled: false }, T0 + 3 * MIN);
    await store.setPosting(w.db, TENANT, { enabled: true, xUserId: "111" }, T0 + 4 * MIN);
    await p.step(w.db, ROSTER, new Map(), T0 + 6 * MIN);
    let r = await rows(w);
    assert.deepEqual(r.map((x) => [x.dedupeKey, x.status, x.reason]), [
      [`intro:${TENANT}:111`, "cancelled", "turned-off"],
      [`intro:${TENANT}:111:1`, "scheduled", null],
    ]);
    assert.equal(r[1]?.dueAtMs, T0 + 16 * MIN);
    await p.step(w.db, ROSTER, new Map(), T0 + 16 * MIN);
    r = await rows(w);
    const buy = r.find((x) => x.kind === "buy");
    assert.ok(buy, "the buy is planned only once the hello is out");
    await p.step(w.db, ROSTER, new Map(), buy.dueAtMs);
    assert.deepEqual(w.tweets, [INTRO, BUY], "the hello first, then the coin");
  });

  it("without a model, the intro comes from the template pool, and nothing else is planned", async (t) => {
    const w = await world(t, T0);
    const p = poster(w, { creds: null, calls: [call({ decisionId: "d-pepe", atSec: (T0 + 2 * MIN) / 1000 })] });
    await p.step(w.db, ROSTER, new Map(), T0 + MIN);
    await p.step(w.db, ROSTER, new Map(), T0 + 11 * MIN);
    await p.step(w.db, ROSTER, new Map(), T0 + 13 * MIN);
    assert.equal(w.prompts.length, 0);
    assert.equal(w.tweets.length, 1);
    assert.match(w.tweets[0]!, /\bAI agent\b/i);
    assert.match(w.tweets[0]!, /paper/);
    assert.deepEqual((await rows(w)).map((x) => x.kind), ["intro"]);
  });

  it("a model that passes on the intro still gets the template; one that passes on a buy spends the key", async (t) => {
    const w = await world(t, T0);
    const p = poster(w, { answer: () => "PASS", calls: [call({ decisionId: "d-pepe", atSec: (T0 + 2 * MIN) / 1000 })] });
    await p.step(w.db, ROSTER, new Map(), T0 + MIN);
    assert.equal((await rows(w))[0]?.status, "scheduled", "the template stood in");
    await p.step(w.db, ROSTER, new Map(), T0 + 11 * MIN);
    const r = await rows(w);
    assert.deepEqual(r.map((x) => [x.kind, x.status, x.reason]), [["intro", "posted", null], ["buy", "skipped", "no-draft"]]);
    assert.equal(r[1]?.body, "", "nothing refused is kept");
    await p.step(w.db, ROSTER, new Map(), T0 + 13 * MIN);
    assert.equal(w.prompts.length, 2, "the skipped buy is not drafted again");
  });

  it("a draft the gate refuses is written off with its reason, and never posted", async (t) => {
    const w = await world(t, T0);
    const alerting = (prompt: string) => (/very first post/.test(prompt) ? INTRO : "BUY ALERT: picked up pepe on paper, curve early");
    const p = poster(w, { answer: alerting, calls: [call({ decisionId: "d-pepe", atSec: (T0 + 2 * MIN) / 1000 })] });
    await p.step(w.db, ROSTER, new Map(), T0 + MIN);
    await p.step(w.db, ROSTER, new Map(), T0 + 11 * MIN);
    await p.step(w.db, ROSTER, new Map(), T0 + 2 * HOUR);
    const r = await rows(w);
    assert.deepEqual(r.map((x) => [x.kind, x.status, x.reason, x.body === ""]), [["intro", "posted", null, false], ["buy", "skipped", "gate:alert", true]]);
    assert.deepEqual(w.tweets, [INTRO]);
  });

  it("the model's daily allowance is held", async (t) => {
    const w = await world(t, T0);
    const p = poster(w, { llmPerDay: 1, calls: [call({ decisionId: "d-pepe", atSec: (T0 + 2 * MIN) / 1000 })] });
    await p.step(w.db, ROSTER, new Map(), T0 + MIN);
    const sent = await p.step(w.db, ROSTER, new Map(), T0 + 11 * MIN);
    assert.equal(sent.log, "xpost: sent 1, no-model-budget 1");
    // A standing condition is said when it changes, then every twenty minutes — not every minute.
    assert.equal((await p.step(w.db, ROSTER, new Map(), T0 + 13 * MIN)).log, null);
    assert.equal(w.prompts.length, 1, "the intro took the day's one call");
    assert.deepEqual((await rows(w)).map((x) => x.kind), ["intro"], "the buy waits for an allowance rather than being written off");
    assert.equal((await p.step(w.db, ROSTER, new Map(), T0 + 20 * MIN)).log, null);
    assert.equal((await p.step(w.db, ROSTER, new Map(), T0 + 32 * MIN)).log, "xpost: no-model-budget 1");
  });

  it("a draft for an X account that is no longer connected is cancelled, never sent", async (t) => {
    const w = await world(t, T0);
    await store.schedulePost(w.db, { tenant: TENANT, xUserId: "999", kind: "casual", dedupeKey: "casual:old", body: "an old draft for somebody else", dueAtMs: T0, nowMs: T0 - MIN });
    await poster(w).step(w.db, ROSTER, new Map(), T0 + MIN);
    assert.equal(await store.keyStatus(w.db, "casual:old"), "cancelled");
    assert.equal(w.tweets.length, 0);
  });

  it("a tenant this replica does not hold is neither planned nor sent", async (t) => {
    const w = await world(t, T0);
    await poster(w).step(w.db, [{ tenant: `0x${"ef".repeat(20)}`, agentId: AGENT }], new Map(), T0 + 11 * MIN);
    assert.deepEqual(await rows(w), []);
  });
});

describe("asleep and stale", () => {
  const TZ = "Asia/Tokyo";
  // 03:00 in Tokyo on the 29th: inside every agent's night, whatever its jitter.
  const NIGHT = Date.UTC(2026, 8, 28, 18, 0);

  it("nothing goes out while the owner sleeps; by morning a buy post is stale and a casual one goes", async (t) => {
    assert.equal(isAsleep(TZ, TENANT, NIGHT), true);
    assert.equal(isAsleep(TZ, TENANT, NIGHT + 9 * HOUR), false);
    const w = await world(t, NIGHT - 10 * 24 * HOUR);
    const introKey = `intro:${TENANT}:111`;
    const hello = await store.schedulePost(w.db, { tenant: TENANT, xUserId: "111", kind: "intro", dedupeKey: introKey, body: "hello", dueAtMs: 0, nowMs: NIGHT - 9 * 24 * HOUR });
    await store.ownerCancel(w.db, TENANT, hello!, NIGHT - 9 * 24 * HOUR);
    await store.schedulePost(w.db, { tenant: TENANT, xUserId: "111", kind: "buy", dedupeKey: "buy:late", body: BUY, coin: "pepe", decisionId: "late", dueAtMs: NIGHT - MIN, nowMs: NIGHT - 30 * MIN });
    // Due at 07:00 in Tokyo on the 29th: while (or just after) the owner sleeps, and the same local day as noon.
    await store.schedulePost(w.db, { tenant: TENANT, xUserId: "111", kind: "casual", dedupeKey: "casual:morning", body: "slow afternoons make me weirdly calm", dueAtMs: NIGHT + 4 * HOUR, nowMs: NIGHT - 30 * MIN });
    // Due at 22:30 in Tokyo on the 28th, and still waiting after midnight there: yesterday's thought.
    await store.schedulePost(w.db, { tenant: TENANT, xUserId: "111", kind: "casual", dedupeKey: "casual:yesterday", body: "yesterday's thought", dueAtMs: NIGHT - 4 * HOUR - 30 * MIN, nowMs: NIGHT - 5 * HOUR });
    const p = poster(w, { tz: TZ });

    const night = await p.step(w.db, ROSTER, new Map(), NIGHT);
    assert.equal(w.tweets.length, 0);
    assert.equal(night.log, "xpost: stale 1", "waiting is not news; a post retired is");
    assert.equal(await store.keyStatus(w.db, "buy:late"), "scheduled");
    assert.equal(await store.keyStatus(w.db, "casual:yesterday"), "skipped", "a casual post held past its local day is stale");

    await p.step(w.db, ROSTER, new Map(), NIGHT + 9 * HOUR);
    assert.equal(await store.keyStatus(w.db, "buy:late"), "skipped", "a buy post waiting eight hours is stale");
    assert.equal(await store.keyStatus(w.db, "casual:morning"), "posted");
    assert.deepEqual(w.tweets, ["slow afternoons make me weirdly calm"]);
  });
});

// ── the fleet's guards ──────────────────────────────────────────────────────

describe("fleet guards", () => {
  // 08:00 UTC, no zone: never asleep, and hours before any casual slot, so
  // only the posts a test schedules itself are in play.
  const T0 = Date.UTC(2026, 8, 28, 8, 0);
  const OTHER = `0x${"ef".repeat(20)}`;
  const BOTH = [...ROSTER, { tenant: OTHER, agentId: AGENT }];

  /** A second owner, posting from their own X account, intro already dealt with. */
  async function otherOwner(w: World, xUserId = "222") {
    await store.upsertAccount(w.db, w.dek, {
      tenant: OTHER,
      xUserId,
      username: "other_trades",
      tokens: { accessToken: "access-other", refreshToken: "refresh-other", accessExpiresAtMs: T0 + 30 * 24 * HOUR, scope: "tweet.write" },
      nowMs: T0 - 3 * HOUR,
    });
    await store.setPosting(w.db, OTHER, { enabled: true, xUserId }, T0 - 2 * HOUR);
    await introDealtWith(w, OTHER, xUserId);
  }

  /** The owner skipped the hello: nothing is held for it, and nothing plans one. */
  async function introDealtWith(w: World, tenant = TENANT, xUserId = "111") {
    const id = await store.schedulePost(w.db, { tenant, xUserId, kind: "intro", dedupeKey: `intro:${tenant}:${xUserId}`, body: "hello", dueAtMs: T0 - HOUR, nowMs: T0 - 2 * HOUR });
    assert.equal(await store.ownerCancel(w.db, tenant, id!, T0 - 2 * HOUR), true);
  }

  async function dueCasual(w: World, key: string, over: { tenant?: string; xUserId?: string; dueAtMs?: number; body?: string } = {}) {
    return (await store.schedulePost(w.db, {
      tenant: over.tenant ?? TENANT,
      xUserId: over.xUserId ?? "111",
      kind: "casual",
      dedupeKey: key,
      body: over.body ?? `slow afternoons make me weirdly calm, ${key}`,
      dueAtMs: over.dueAtMs ?? T0 - MIN,
      nowMs: T0 - 30 * MIN,
    }))!;
  }

  /** A post that already went out on X, as the sender records it. */
  async function wentOut(w: World, key: string, over: { tenant?: string; xUserId?: string; kind?: "casual" | "buy"; coin?: string | null; atMs: number }) {
    const id = await store.schedulePost(w.db, {
      tenant: over.tenant ?? TENANT,
      xUserId: over.xUserId ?? "111",
      kind: over.kind ?? "casual",
      dedupeKey: key,
      body: `an earlier post, ${key}`,
      coin: over.coin ?? null,
      dueAtMs: over.atMs,
      nowMs: over.atMs - 30 * MIN,
    });
    assert.equal(await store.claimPost(w.db, id!, over.atMs), true);
    await store.markPosted(w.db, id!, String(1840000000000000000n + BigInt(id!)), over.atMs);
  }

  it("one X account connected by two owners keeps one cadence: one gap, one coin fold", async (t) => {
    const w = await world(t, T0 - 2 * HOUR);
    await introDealtWith(w);
    await otherOwner(w, "111");
    // The first owner's agent posted on @shared an hour ago, and about Pepe yesterday.
    await wentOut(w, "casual:first", { atMs: T0 - HOUR });
    await wentOut(w, "buy:first-pepe", { kind: "buy", coin: "pepe", atMs: T0 - 20 * HOUR });
    const fresh = (T0 - MIN) / 1000;
    const p = poster(w, { others: { [OTHER]: [call({ decisionId: "d-bonk", symbol: "BONK", name: "Bonk", atSec: fresh }), call({ decisionId: "d-pepe", atSec: fresh })] } });
    await p.step(w.db, BOTH, new Map(), T0);
    const bonk = (await store.postsOf(w.db, OTHER, 0, 10)).find((x) => x.dedupeKey === "buy:d-bonk");
    assert.ok(bonk, "the second owner's buy is planned");
    assert.ok(bonk.dueAtMs >= T0 - HOUR + GAP_MS, "three hours after the other owner's post on the same X account");
    assert.equal(await store.keyStatus(w.db, "buy:d-pepe"), null, "the coin the X account posted about yesterday is folded");
  });

  /** Ten owners ahead of TENANT in tenant order, each with a fresh buy to post about, and one who just consented, last. */
  async function crowd(w: World) {
    const others: Record<string, CallFact[]> = {};
    const roster = [...ROSTER];
    for (let i = 1; i <= 10; i++) {
      const tenant = `0x${i.toString(16).padStart(40, "0")}`;
      const xUserId = String(3000 + i);
      await store.upsertAccount(w.db, w.dek, {
        tenant,
        xUserId,
        username: `owner_${i}`,
        tokens: { accessToken: `access-${i}`, refreshToken: `refresh-${i}`, accessExpiresAtMs: T0 + 30 * 24 * HOUR, scope: "tweet.write" },
        nowMs: T0 - 3 * HOUR,
      });
      await store.setPosting(w.db, tenant, { enabled: true, xUserId }, T0 - 2 * HOUR);
      await introDealtWith(w, tenant, xUserId);
      others[tenant] = [call({ decisionId: `d-${i}`, symbol: "BONK", name: "Bonk", atSec: (T0 - MIN) / 1000 })];
      roster.push({ tenant, agentId: AGENT });
    }
    const newcomer = `0x${"f".repeat(40)}`;
    await store.upsertAccount(w.db, w.dek, {
      tenant: newcomer,
      xUserId: "4000",
      username: "newcomer",
      tokens: { accessToken: "access-new", refreshToken: "refresh-new", accessExpiresAtMs: T0 + 30 * 24 * HOUR, scope: "tweet.write" },
      nowMs: T0 - 5 * MIN,
    });
    await store.setPosting(w.db, newcomer, { enabled: true, xUserId: "4000" }, T0 - MIN);
    others[newcomer] = [];
    roster.push({ tenant: newcomer, agentId: AGENT });
    return { others, roster, newcomerIntro: `intro:${newcomer}:4000` };
  }

  it("with the model's allowance spent, recurring buys use no draft slots: a newcomer's hello is still drafted", async (t) => {
    const w = await world(t, T0 - 2 * HOUR);
    await introDealtWith(w);
    const { others, roster, newcomerIntro } = await crowd(w);
    assert.equal(await store.takeAllowance(w.db, "llm:2026-09-28", 1, T0 - HOUR), true);
    const p = poster(w, { llmPerDay: 1, others });
    const log = (await p.step(w.db, roster, new Map(), T0)).log;
    assert.equal(await store.keyStatus(w.db, newcomerIntro), "scheduled", "the template hello, first pass");
    assert.equal(w.prompts.length, 0);
    assert.match(log ?? "", /drafted-intro 1/);
    assert.match(log ?? "", /no-model-budget 1\b/, "said once, not once per refused buy");
  });

  it("an allowance that runs out partway through a pass plans only hellos after that", async (t) => {
    const w = await world(t, T0 - 2 * HOUR);
    await introDealtWith(w);
    const { others, roster, newcomerIntro } = await crowd(w);
    const p = poster(w, { llmPerDay: 2, others });
    await p.step(w.db, roster, new Map(), T0);
    assert.equal(w.prompts.length, 2, "two buys drafted on the day's two calls");
    assert.equal(await store.keyStatus(w.db, newcomerIntro), "scheduled");
  });

  it("the fleet's day ceiling is taken atomically before each send, across replicas", async (t) => {
    const w = await world(t, T0 - 2 * HOUR);
    await introDealtWith(w);
    await otherOwner(w);
    await dueCasual(w, "casual:a");
    await dueCasual(w, "casual:b", { tenant: OTHER, xUserId: "222" });
    const a = poster(w, { fleetPerDay: 1 });
    const log = (await a.step(w.db, BOTH, new Map(), T0)).log;
    assert.equal(w.tweets.length, 1, "one post, the day's one");
    assert.match(log ?? "", /sent 1/);
    assert.match(log ?? "", /fleet-ceiling-reached 1/);
    assert.equal((await store.readMeta(w.db, "posts:2026-09-28"))?.n, 1);
    // Another replica, its own process and counters, the same database.
    await poster(w, { fleetPerDay: 1 }).step(w.db, BOTH, new Map(), T0 + 20_000);
    assert.equal(w.tweets.length, 1, "no replica can take a unit that is not there");
    const waiting = [await store.keyStatus(w.db, "casual:a"), await store.keyStatus(w.db, "casual:b")].sort();
    assert.deepEqual(waiting, ["posted", "scheduled"]);
  });

  it("a send X may have acted on keeps its unit of the ceiling; one X certainly refused gives it back", async (t) => {
    const w = await world(t, T0 - 2 * HOUR);
    await introDealtWith(w);
    await dueCasual(w, "casual:maybe");
    const outage: FetchLike = async () => ({ status: 503, headers: { get: () => null }, text: async () => "" });
    await poster(w, { fetch: outage }).step(w.db, ROSTER, new Map(), T0);
    assert.equal(await store.keyStatus(w.db, "casual:maybe"), "failed");
    assert.equal((await store.readMeta(w.db, "posts:2026-09-28"))?.n, 1, "an uncertain post may be on X: it counts");
    await dueCasual(w, "casual:limited", { tenant: TENANT, dueAtMs: T0 + MIN });
    const limited: FetchLike = async () => ({ status: 429, headers: { get: () => null }, text: async () => "{}" });
    // Four hours on, clear of the gap after the uncertain one.
    await poster(w, { fetch: limited }).step(w.db, ROSTER, new Map(), T0 + 4 * HOUR);
    assert.equal(await store.keyStatus(w.db, "casual:limited"), "scheduled", "a 429 waits for X's reset");
    assert.equal((await store.readMeta(w.db, "posts:2026-09-28"))?.n, 1, "and gives its unit back");
  });

  it("nothing is drafted while the fleet is at its ceiling or paused", async (t) => {
    for (const hold of ["ceiling", "paused"] as const) {
      const w = await world(t, T0 - 2 * HOUR);
      await introDealtWith(w);
      if (hold === "ceiling") assert.equal(await store.takeAllowance(w.db, "posts:2026-09-28", 1, T0 - MIN), true);
      else await store.writeMeta(w.db, PAUSE_KEY, String(T0 + HOUR), T0 - MIN);
      const p = poster(w, { fleetPerDay: 1, calls: [call({ decisionId: "d-held", atSec: (T0 - MIN) / 1000 })] });
      await p.step(w.db, ROSTER, new Map(), T0);
      assert.equal(await store.keyStatus(w.db, "buy:d-held"), null, `${hold}: no draft that cannot go out`);
      assert.equal(w.prompts.length, 0, `${hold}: no model call spent on one`);
    }
  });

  it("a credits pause holds every due post, and is said once", async (t) => {
    const w = await world(t, T0 - 2 * HOUR);
    await introDealtWith(w);
    await dueCasual(w, "casual:paused");
    await store.writeMeta(w.db, PAUSE_KEY, String(T0 + HOUR), T0 - MIN);
    const p = poster(w);
    assert.equal((await p.step(w.db, ROSTER, new Map(), T0)).log, "xpost: paused-for-credits 1");
    assert.equal((await p.step(w.db, ROSTER, new Map(), T0 + MIN)).log, null, "the same pause is not said again");
    assert.equal(w.tweets.length, 0);
    assert.equal(await store.keyStatus(w.db, "casual:paused"), "scheduled");
    await p.step(w.db, ROSTER, new Map(), T0 + HOUR + MIN);
    assert.equal(await store.keyStatus(w.db, "casual:paused"), "posted", "and it goes once the pause is over");
  });

  it("the token endpoint refusing the app's credentials pauses the fleet in the same pass, revokes nobody, and is one line", async (t) => {
    const w = await world(t, T0 - 2 * HOUR);
    // Near expiry, so the send refreshes first.
    await store.upsertAccount(w.db, w.dek, {
      tenant: TENANT,
      xUserId: "111",
      username: "robin_trades",
      tokens: { accessToken: "access-token", refreshToken: "refresh-token", accessExpiresAtMs: T0 + 30_000, scope: "tweet.write" },
      nowMs: T0 - HOUR,
    });
    await introDealtWith(w);
    await otherOwner(w);
    await dueCasual(w, "casual:first", { dueAtMs: T0 - 2 * MIN });
    await dueCasual(w, "casual:second", { tenant: OTHER, xUserId: "222" });
    const calls: string[] = [];
    const refused: FetchLike = async (url) => {
      calls.push(url);
      const text = url.endsWith("/oauth2/token") ? JSON.stringify({ error: "unauthorized_client" }) : JSON.stringify({ data: { id: "1840000000000000001" } });
      return { status: url.endsWith("/oauth2/token") ? 401 : 201, headers: { get: () => null }, text: async () => text };
    };
    const p = poster(w, { fetch: refused });
    assert.equal((await p.step(w.db, BOTH, new Map(), T0)).log, "xpost: x-refused-client-credentials 1");
    assert.deepEqual(calls, ["https://api.x.com/2/oauth2/token"], "one refresh, and nothing after it in that pass");
    assert.equal((await store.getAccount(w.db, TENANT))?.status, "ok", "the owner's grant is not revoked");
    assert.equal(await store.keyStatus(w.db, "casual:first"), "scheduled");
    assert.equal(await store.keyStatus(w.db, "casual:second"), "scheduled");
    assert.equal((await p.step(w.db, BOTH, new Map(), T0 + MIN)).log, null, "the pause it set is not said again");
    assert.equal(calls.length, 1);
  });
});

describe("step never throws", () => {
  it("a broken database is one log line, not one every pass", async () => {
    const broken = {
      prepare() {
        throw new Error("connection refused");
      },
      exec: async () => {
        throw new Error("connection refused");
      },
      tx: async () => {
        throw new Error("connection refused");
      },
    } as unknown as Db;
    const p = makeXPoster({ creds: null, knobs: xpostEnv({}), app: APP, dek: randomBytes(32), deps: { dialect: "sqlite" } });
    assert.deepEqual(await p.step(broken, ROSTER, new Map(), 1_000), { log: "xpost: pass failed — connection refused" });
    assert.deepEqual(await p.step(broken, ROSTER, new Map(), 2_000), { log: null });
  });
});
