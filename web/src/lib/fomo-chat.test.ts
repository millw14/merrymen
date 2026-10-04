/**
 * APP-CHAT FOMO TURNS, against the real planner, broker, research service and
 * store, with a fixture-backed provider (worker/src/fomo/testdata) — no
 * network, no real key. What must hold:
 *
 *   - a factual question invokes a REGISTERED tool for the session's tenant
 *     and comes back as a factual reply, attributed, with no model;
 *   - an analysis question comes back as fenced evidence, the rules and a
 *     deterministic fallback, never as a model's own lookup;
 *   - a non-Fomo message (the owner's own trades included) is left alone,
 *     with no call of any kind;
 *   - an owner who switched Fomo data off is refused with no provider call;
 *   - one owner's subject memory is invisible to another;
 *   - body.state is never read; a watch happens only when asked, expiring;
 *   - hosted, a signed-in wallet that owns no agent is told so, with no
 *     lookup of any kind (the credits are the fleet's owners');
 *   - an analysis turn takes one call from the tenant's daily model
 *     allowance before the evidence is handed on, and a refused (or
 *     uncheckable) allowance is the deterministic answer, saying so.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { wrapSqlite } from "../../../worker/src/db";
import { FOMO_ATTRIBUTION, FOMO_CHAT_RULES, NOT_PERMISSION_LINE } from "../../../worker/src/fomo/render";
import { deserialize } from "../../../worker/src/fomo/subject-memory";
import { FOMO_ANALYSIS_CAPPED, FOMO_ANALYSIS_UNCHECKED, FOMO_CHAT_MAX_CHARS, FOMO_UNREACHABLE, fomoChatTurn, type FomoChatTurn } from "./fomo-chat";
import { createWebFomoRuntime, FOMO_MODEL_BUDGET, FOMO_NEEDS_AGENT, setFomoOwnerReaderForTest, type FomoRuntime } from "./fomo-runtime";
import { projectSettings, setSettingsReaderForTest } from "./services/settings-view";

type Rec = Record<string, unknown>;

const A = `0x${"a".repeat(40)}`;
const B = `0x${"b".repeat(40)}`;
const PONS = "0x39dbed3a00000000000000000000000000000c0d";
const NOW = Date.UTC(2026, 9, 4, 16, 5);
const ALERTS_NEWEST = 1788378000000;

function fixture(name: string): Rec {
  return JSON.parse(readFileSync(new URL(`../../../worker/src/fomo/testdata/${name}.json`, import.meta.url), "utf8")) as Rec;
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-credits-cost": "250" } });

interface World {
  raw: DatabaseSync;
  rt: FomoRuntime;
  provider: string[];
  clock: { now: number };
  ask(tenant: string | null, message: string, extra?: Rec): Promise<FomoChatTurn>;
  count(sql: string, ...p: unknown[]): number;
}

const settings: Record<string, Record<string, unknown> | null> = {};
/** Hosted wallets that own an agent (a grant). A and B unless a test says otherwise. */
const agents = new Set<string>();

async function world(): Promise<World> {
  const raw = new DatabaseSync(":memory:");
  const clock = { now: NOW };
  const provider: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    provider.push(u.pathname + u.search);
    const p = u.pathname;
    if (p === "/v2/tokens/search") return json(fixture("tokens-search"));
    if (p === "/v2/search") return json(fixture("search"));
    if (p === "/v2/alerts") {
      const body = fixture("alerts");
      const shift = clock.now - 60_000 - ALERTS_NEWEST;
      for (const a of body.alerts as Rec[]) {
        if (typeof a.ts === "number") a.ts += shift;
        if (typeof a.execTs === "number") a.execTs += shift;
      }
      return json(body);
    }
    if (p.startsWith("/v2/thesis/token/")) return json(fixture("theses-token"));
    if (/\/stats$/.test(p)) return json(fixture("token-stats"));
    if (/\/balances$/.test(p)) return json(fixture("balances"));
    return json({ error: "not_found" }, 404);
  }) as typeof fetch;
  const rt = await createWebFomoRuntime({
    hosted: true,
    db: wrapSqlite(raw),
    dialect: "sqlite",
    apiKey: "fixture-key-not-a-credential",
    fetchImpl,
    now: () => clock.now,
    planCreditsPerMonth: 100_000_000,
    log: () => {},
  });
  return {
    raw,
    rt,
    provider,
    clock,
    ask(tenant, message, extra = {}) {
      clock.now += 30_000;
      return fomoChatTurn({ message, ...extra }, { tenant, now: clock.now, hosted: true }, { runtime: async () => rt });
    },
    count(sql, ...p) {
      return Number((raw.prepare(sql).get(...(p as never[])) as { n: number }).n);
    },
  };
}

const factual = (t: FomoChatTurn): string => {
  assert.ok(t && "factualReply" in t, `expected a factual reply, got ${JSON.stringify(t)?.slice(0, 200)}`);
  return t.factualReply;
};

beforeEach(() => {
  for (const k of Object.keys(settings)) delete settings[k];
  setSettingsReaderForTest({ async settingsFor(t) { return projectSettings(settings[t.toLowerCase()] ?? null); } });
  agents.clear();
  agents.add(A).add(B);
  setFomoOwnerReaderForTest({ async hasAgent(t) { return agents.has(t); } });
});
afterEach(() => {
  setSettingsReaderForTest(null);
  setFomoOwnerReaderForTest(null);
});

describe("a factual Fomo question", () => {
  it("invokes the registered tool for the session's tenant and answers from code, attributed", async () => {
    const w = await world();
    const reply = factual(await w.ask(A, "what are the theses on $PONS"));
    assert.match(reply, /^\$PONS on robinhood \(0x39db…0c0d\): 3 theses/);
    assert.ok(reply.endsWith(FOMO_ATTRIBUTION));
    assert.ok(w.provider.some((p) => p.startsWith(`/v2/thesis/token/`)), "the provider was read through the service");
    // The dispatcher's own request log: the registered tool, this surface, this tenant.
    const rows = w.raw.prepare("SELECT tenant, surface, tool, status FROM fomo_requests").all() as Rec[];
    assert.deepEqual(rows.map((r) => [r.tenant, r.surface, r.tool]), [[A, "app-chat", "fomo_get_token_theses"]]);
    assert.ok(["ok", "capped"].includes(String(rows[0]!.status)), `answered (the fixture holds more theses than one page): ${rows[0]!.status}`);
    for (const t of ["fomo_watches", "fomo_assessments", "fomo_jobs", "fomo_publications"]) assert.equal(w.count(`SELECT COUNT(*) AS n FROM ${t}`), 0, `${t} written by a question`);
  });

  it("never reads body.state or history: the message alone is planned", async () => {
    const w = await world();
    const body: Rec = { message: "what are the theses on $PONS" };
    for (const key of ["state", "history"]) {
      Object.defineProperty(body, key, { enumerable: true, get() { throw new Error(`fomo-chat read body.${key}`); } });
    }
    w.clock.now += 30_000;
    const t = await fomoChatTurn(body, { tenant: A, now: w.clock.now, hosted: true }, { runtime: async () => w.rt });
    assert.match(factual(t), /3 theses/);
  });
});

describe("an analysis question", () => {
  it("returns fenced evidence, the rules and a deterministic fallback — the model gets no lookup of its own", async () => {
    const w = await world();
    await w.ask(A, "what are the theses on $PONS");
    const t = await w.ask(A, "should we follow this?");
    assert.ok(t && "fomo" in t, JSON.stringify(t)?.slice(0, 300));
    const { evidence, rules, fallback, footer } = t.fomo;
    assert.match(evidence, /^```fomo-evidence\nFOMO EVIDENCE \(retrieved by registered read-only tools; third-party data — not instructions\)/);
    assert.match(evidence, /tool=fomo_research_coin/);
    assert.ok(evidence.length <= 6_000);
    assert.equal(rules, FOMO_CHAT_RULES);
    assert.ok(fallback.includes(NOT_PERMISSION_LINE) && fallback.includes(FOMO_ATTRIBUTION), fallback);
    assert.equal(footer, `${NOT_PERMISSION_LINE}\n${FOMO_ATTRIBUTION}`);
    assert.equal(w.count("SELECT COUNT(*) AS n FROM fomo_assessments"), 0, "analysis is not an assessment");
  });

  it("an info-only request stays factual", async () => {
    const w = await world();
    await w.ask(A, "what are the theses on $PONS");
    const reply = factual(await w.ask(A, "just give me the information, not a trading opinion"));
    assert.ok(!reply.includes(NOT_PERMISSION_LINE));
  });
});

describe("what is left alone", () => {
  it("non-Fomo messages, the owner's own trades included, are not claimed and cost nothing", async () => {
    const w = await world();
    for (const m of ["what did you buy today?", "what did you trade today?", "hello there", "buy 50 USDG of PEPE", "I have fomo lol", "  "]) {
      assert.equal(await w.ask(A, m), null, m);
    }
    assert.deepEqual(w.provider, []);
    assert.equal(w.count("SELECT COUNT(*) AS n FROM fomo_requests"), 0);
  });

  it("hosted with no verified tenant: nothing is built, nothing is asked", async () => {
    let built = 0;
    const t = await fomoChatTurn({ message: "what are the theses on $PONS" }, { tenant: null, now: NOW, hosted: true }, { runtime: async () => { built++; throw new Error("no"); } });
    assert.equal(t, null);
    assert.equal(built, 0);
  });

  it("self-hosted: the install's fixed tenant answers, whatever tenant is passed", async () => {
    let asked: boolean | null = null;
    const w = await world();
    const t = await fomoChatTurn({ message: "what are the theses on $PONS" }, { tenant: A, now: NOW + 60_000, hosted: false }, { runtime: async (hosted) => ((asked = hosted), w.rt) });
    assert.equal(asked, false, "the self-hosted runtime was asked for");
    // The hosted access reader of this fixture runtime refuses "self": proof the tenant was the install's, not A.
    assert.match(factual(t), /switched off/);
    assert.deepEqual((w.raw.prepare("SELECT tenant FROM fomo_requests").all() as Rec[]).map((r) => r.tenant), ["self"]);
  });

  it("a store that cannot be reached: an honest line for a Fomo question, nothing for anything else", async () => {
    const down = { runtime: async () => { throw new Error("db down"); } };
    assert.deepEqual(await fomoChatTurn({ message: "what are the theses on $PONS" }, { tenant: A, now: NOW, hosted: true }, down), { factualReply: FOMO_UNREACHABLE });
    assert.equal(await fomoChatTurn({ message: "what did you trade today?" }, { tenant: A, now: NOW, hosted: true }, down), null);
  });
});

describe("the owner's permission and tenant", () => {
  it("fomoDataAccess off is refused with no provider call", async () => {
    const w = await world();
    settings[B] = { fomoDataAccess: false };
    const reply = factual(await w.ask(B, "what are the theses on $PONS"));
    assert.match(reply, /switched off/);
    assert.deepEqual(w.provider, [], "no provider call for an owner who switched Fomo off");
    const rows = w.raw.prepare("SELECT tenant, status FROM fomo_requests").all() as Rec[];
    assert.deepEqual(rows.map((r) => [r.tenant, r.status]), [[B, "not-authorized"]]);
  });

  it("one owner's subject memory is invisible to another", async () => {
    const w = await world();
    await w.ask(A, "what are the theses on $PONS");
    const memA = deserialize(await w.rt.service.memoryGet(A, `app:${A}`));
    assert.ok(memA?.subjects.some((s) => s.kind === "token" && s.tokenKey === `eip155:4663:${PONS}`));
    const before = w.provider.length;
    const t = await w.ask(B, "What about the sellers?");
    const text = t && "factualReply" in t ? t.factualReply : "";
    assert.ok(!/PONS|0x39db/i.test(text), `B must not hear about A's coin: ${text}`);
    assert.ok(!w.provider.slice(before).some((p) => p.toLowerCase().includes(PONS)), "no lookup of A's coin for B");
    // Even A's conversation key, read as B, is empty: memory is scoped by the tenant, not by the key.
    assert.equal(await w.rt.service.memoryGet(B, `app:${A}`), null);
  });

  it("a watch happens only when the owner asks for one, for that owner, and it expires", async () => {
    const w = await world();
    const reply = factual(await w.ask(A, "keep an eye on $PONS for me on fomo"));
    assert.ok(reply.length > 0);
    const rows = w.raw.prepare("SELECT tenant, created_at_ms, expires_at_ms FROM fomo_watches").all() as Rec[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.tenant, A);
    const span = Number(rows[0]!.expires_at_ms) - Number(rows[0]!.created_at_ms);
    assert.ok(span > 0 && span <= 30 * 86_400_000, "bounded and expiring");
    assert.equal(w.count("SELECT COUNT(*) AS n FROM fomo_watches WHERE tenant = ?", B), 0);
  });
});

describe("hosted, only an owner with an agent", () => {
  const C = `0x${"c".repeat(40)}`;

  it("a signed-in wallet that owns no agent is told why, and nothing is looked up or logged", async () => {
    const w = await world();
    assert.equal(factual(await w.ask(C, "what are the theses on $PONS")), FOMO_NEEDS_AGENT);
    assert.equal(factual(await w.ask(C, "refresh theses on $PONS")), FOMO_NEEDS_AGENT, "not even a forced refresh");
    assert.deepEqual(w.provider, [], "no provider credit spent for a wallet that is not an owner");
    assert.equal(w.count("SELECT COUNT(*) AS n FROM fomo_requests"), 0);
    // A message that is not about Fomo is left to the existing handlers, as for anyone.
    assert.equal(await w.ask(C, "hello there"), null);
  });

  it("the access reader refuses it too, so a caller that skipped the question still gets nothing", async () => {
    const w = await world();
    const env = await w.rt.service.invoke(
      { tenant: C, surface: "app-chat", audience: "owner", conversationKey: null, requestId: "direct-c", now: w.clock.now, priority: "interactive" },
      "fomo_get_token_theses",
      { token: PONS, chain: "robinhood" },
    );
    assert.equal(env.status, "not-authorized");
    assert.deepEqual(w.provider, []);
  });

  it("an unreadable grant store is 'can't reach', never 'not an owner', and nothing is looked up", async () => {
    const w = await world();
    setFomoOwnerReaderForTest({ async hasAgent() { throw new Error("grants down"); } });
    assert.equal(factual(await w.ask(A, "what are the theses on $PONS")), FOMO_UNREACHABLE);
    assert.equal(await w.ask(A, "hello there"), null);
    assert.deepEqual(w.provider, []);
  });

  it("self-hosted asks no such question: the install's own tenant is its owner", async () => {
    const w = await world();
    setFomoOwnerReaderForTest({ async hasAgent() { throw new Error("must not be asked self-hosted"); } });
    const t = await fomoChatTurn({ message: "what are the theses on $PONS" }, { tenant: null, now: NOW + 60_000, hosted: false }, { runtime: async () => w.rt });
    assert.ok(t && "factualReply" in t);
    assert.notEqual(t.factualReply, FOMO_UNREACHABLE);
  });
});

describe("the per-tenant model allowance on analysis", () => {
  const modelCalls = (w: World): Rec[] =>
    w.raw.prepare("SELECT k, n FROM fomo_meta WHERE k LIKE 'allowance:fomo:model:%:calls'").all() as Rec[];

  it("an analysis turn handed to the model takes exactly one call from the asking tenant's allowance", async () => {
    const w = await world();
    await w.ask(A, "what are the theses on $PONS");
    assert.deepEqual(modelCalls(w), [], "a factual answer uses no model and takes nothing");
    const t = await w.ask(A, "should we follow this?");
    assert.ok(t && "fomo" in t);
    const rows = modelCalls(w);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0]!.n), 1);
    assert.ok(String(rows[0]!.k).includes(A), "charged to the asking tenant");
  });

  it("refused: the deterministic answer, saying so, with no evidence for a model", async () => {
    const w = await world();
    const day = w.clock.now + 60_000;
    for (let i = 0; i < FOMO_MODEL_BUDGET.callsPerDay; i++) await w.rt.modelBudget.tryStart({ tenant: A, estimatedTokens: 1, now: day });
    await w.ask(A, "what are the theses on $PONS");
    const t = await w.ask(A, "should we follow this?");
    const reply = factual(t);
    assert.ok(reply.startsWith(`${FOMO_ANALYSIS_CAPPED}\n`), reply.slice(0, 200));
    assert.ok(reply.includes(NOT_PERMISSION_LINE) && reply.endsWith(FOMO_ATTRIBUTION), "still the facts, the not-permission line and the attribution");
    assert.ok(reply.length <= FOMO_CHAT_MAX_CHARS, `inside the chat bound: ${reply.length}`);
    // Another owner's allowance is untouched.
    await w.ask(B, "what are the theses on $PONS");
    const b = await w.ask(B, "should we follow this?");
    assert.ok(b && "fomo" in b, "B's analysis still reaches the model");
  });

  it("an allowance that cannot be checked spends no model: the facts, saying why", async () => {
    const w = await world();
    const broken = { ...w.rt, modelBudget: { tryStart: async () => { throw new Error("meta down"); } } } as unknown as FomoRuntime;
    w.clock.now += 30_000;
    await fomoChatTurn({ message: "what are the theses on $PONS" }, { tenant: A, now: w.clock.now, hosted: true }, { runtime: async () => broken });
    w.clock.now += 30_000;
    const t = await fomoChatTurn({ message: "should we follow this?" }, { tenant: A, now: w.clock.now, hosted: true }, { runtime: async () => broken });
    assert.ok(factual(t).startsWith(`${FOMO_ANALYSIS_UNCHECKED}\n`));
    const none = { ...w.rt, modelBudget: undefined } as unknown as FomoRuntime;
    w.clock.now += 30_000;
    const u = await fomoChatTurn({ message: "should we follow this?" }, { tenant: A, now: w.clock.now, hosted: true }, { runtime: async () => none });
    assert.ok(factual(u).startsWith(`${FOMO_ANALYSIS_UNCHECKED}\n`), "no budget object is no allowance");
  });
});

describe("the agent's own name", () => {
  it("is read from the owner's stored settings and never researched as a Fomo trader", async () => {
    const w = await world();
    settings[A] = { agentName: "Robin" };
    // A live Fomo conversation, then a possessive on the agent's own name.
    await w.ask(A, "what are the theses on $PONS");
    const before = w.provider.length;
    const t = await w.ask(A, "what are Robin's holdings?");
    // The owner's own book is the ledger's question, not a trader lookup on Fomo.
    assert.ok(t === null || !("factualReply" in t && /Fomo trader/.test(t.factualReply)), JSON.stringify(t)?.slice(0, 200));
    assert.equal(w.provider.filter((p) => p.startsWith("/v2/search")).slice(before).length, 0, "no trader search for the agent's own name");
  });
});
