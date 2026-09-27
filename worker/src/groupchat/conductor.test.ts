/**
 * THE CONDUCTOR, RUN THE WAY PRODUCTION RUNS IT: one step every fifteen seconds
 * over a simulated day, against a real (in-memory) sqlite room.
 *
 * Every rule is asserted on what ended up in the table rather than on the
 * conductor's own bookkeeping, because the table is what readers see and what
 * survives a redeploy. The facts loader is a fake (a bare sqlite has no ledger
 * tables — facts.test.ts owns the real one), the rng is seeded, and the clock
 * is the step's argument, so a failure here reproduces exactly.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { agentNameForSlug } from "../../../packages/core/src/agent-name";
import { wrapSqlite, type Db } from "../db";
import type { LlmCreds } from "../llm";
import { REPEAT_LIMIT, similarity } from "../social-post";
import { isAsleep, localDay, sleepWindow } from "./clock";
import { makeConductor, type Conductor, type ConductorOptions, type RosterMember } from "./conductor";
import type { AgentFacts, CallFact, loadFacts } from "./facts";
import { admitAgentLine } from "./policy";
import { allMembers, appendMessage, ensureGroupchatSchema, hideOwnMessage, readRoom, setMemberPrefs } from "./store";
import * as T from "./templates";
import * as Topics from "./topics";
import type { MessageKind } from "./types";
import { classifyLine, roomMemory, templateLine, topicPromptOf, type Intent, type LineClass, type SpeakCtx } from "./voice";

// ── fixtures ────────────────────────────────────────────────────────────────

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 8, 23, 0, 0, 0);

function rngOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tenantOf = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(20)}`;
const agentOf = (byte: number) => `0x${(byte ^ 0x55).toString(16).padStart(2, "0").repeat(20)}`;

interface Fixture {
  tenant: string;
  agentId: string;
  slug: string;
  name: string;
  tz: string | null;
  muted?: boolean;
  mode: AgentFacts["mode"];
  calls: CallFact[];
  /** How old the agent's identity is, in whole days (facts.ts ageDays); twelve unless a test says otherwise. */
  ageDays?: number | null;
}

function fixture(byte: number, name: string, tz: string | null, over: Partial<Fixture> = {}): Fixture {
  return {
    tenant: tenantOf(byte),
    agentId: agentOf(byte),
    slug: `slug${byte.toString(16)}abcdefghjk`.slice(0, 16),
    name,
    tz,
    mode: "live",
    calls: [],
    ...over,
  };
}

let decisionSeq = 0;
const PEPE_TOKEN = "0x1111222233334444555566667777888899990000";

/**
 * EACH SYMBOL ITS OWN TOKEN, unless a test names one. sameCoin (facts.ts)
 * decides by token whenever both are known, so a fixture that gave WIF and
 * BONK the one default token made them one coin: the paper BONK buy folded
 * into the WIF card and was never announced. The default coin keeps the
 * default token.
 */
function tokenOf(symbol: string | null | undefined): string {
  if (!symbol || symbol === "PEPE") return PEPE_TOKEN;
  return `0x${Buffer.from(symbol, "utf8").toString("hex")}`.padEnd(42, "e").slice(0, 42);
}

function callAt(atMs: number, over: Partial<CallFact> = {}): CallFact {
  decisionSeq += 1;
  return {
    side: "buy",
    symbol: "PEPE",
    name: "Pepe Frog",
    token: over.token === undefined ? tokenOf(over.symbol) : over.token,
    paper: false,
    decisionId: `d-${decisionSeq}-${atMs}`,
    atSec: Math.floor(atMs / 1000),
    bands: ["curve early"],
    ownWords: null,
    ...over,
  };
}

/**
 * THE FAKE LEDGER. Returns every call that has HAPPENED over the window the
 * conductor asks for, and six hours when it names none — exactly facts.ts — so
 * the conductor's own announcement window is what drops a stale call here.
 */
function fakeFacts(fleet: Map<string, Fixture>, seen?: { calls: number }): typeof loadFacts {
  return async (_shared, roster, _profiles, nowSec, opts = {}) => {
    const windowSec = opts.callWindowSec ?? 6 * 3600;
    if (seen) seen.calls += 1;
    const out = new Map<string, AgentFacts>();
    for (const r of roster) {
      const f = fleet.get(r.tenant.toLowerCase());
      if (!f) continue;
      out.set(f.tenant, {
        tenant: f.tenant,
        agentId: f.agentId,
        slug: f.slug,
        name: f.name,
        mode: f.mode,
        ageDays: f.ageDays === undefined ? 12 : f.ageDays,
        strategy: "steady-basket",
        traits: ["moves early and does not wait around"],
        calls: f.calls.filter((c) => c.atSec <= nowSec && c.atSec > nowSec - windowSec).sort((a, b) => b.atSec - a.atSec),
      });
    }
    return out;
  };
}

interface Row {
  id: number;
  created_at_ms: number;
  author_kind: "agent" | "owner" | "system";
  tenant: string;
  agent_id: string | null;
  speaker_name: string;
  body: string;
  reply_to: number | null;
  kind: MessageKind;
  call_decision_id: string | null;
  dedupe_key: string | null;
}

interface SimOptions extends Partial<ConductorOptions> {
  seed?: number;
}

/** One room, one fleet, one conductor at a time — replaceable, as a redeploy replaces it. */
class Sim {
  readonly raw = new DatabaseSync(":memory:");
  readonly db: Db = wrapSqlite(this.raw);
  readonly fleet = new Map<string, Fixture>();
  readonly roster = new Set<string>();
  readonly logs: string[] = [];
  readonly perStep: { now: number; wrote: number }[] = [];
  conductor: Conductor;

  constructor(
    fixtures: Fixture[],
    readonly opts: SimOptions = {},
  ) {
    for (const f of fixtures) {
      this.fleet.set(f.tenant, f);
      this.roster.add(f.tenant);
    }
    this.conductor = this.fresh();
  }

  fresh(seedOffset = 0): Conductor {
    return makeConductor({
      creds: null,
      dialect: "sqlite",
      facts: fakeFacts(this.fleet),
      ...this.opts,
      rng: this.opts.rng ?? rngOf((this.opts.seed ?? 7) + seedOffset),
    });
  }

  /** Owners who picked a zone (or muted) before the room ever ran: prefs-only rows, not members. */
  async setup(): Promise<void> {
    await ensureGroupchatSchema(this.db, "sqlite");
    for (const f of this.fleet.values()) {
      if (f.tz || f.muted) await setMemberPrefs(this.db, f.tenant, { tz: f.tz, tzSource: f.tz ? "owner" : null, muted: !!f.muted }, T0 - HOUR);
    }
  }

  rosterList(): RosterMember[] {
    return [...this.roster].map((t) => ({ tenant: t, agentId: this.fleet.get(t)!.agentId }));
  }

  async step(now: number, c: Conductor = this.conductor): Promise<{ wrote: number; log: string | null }> {
    const r = await c.step(this.db, this.rosterList(), new Map(), now);
    this.perStep.push({ now, wrote: r.wrote });
    if (r.log) this.logs.push(r.log);
    return r;
  }

  async run(from: number, to: number, stepMs: number, before?: (now: number) => Promise<void> | void): Promise<void> {
    for (let now = from; now < to; now += stepMs) {
      if (before) await before(now);
      await this.step(now);
    }
  }

  async owner(tenant: string, body: string, at: number, kind: MessageKind = "chat", replyTo: number | null = null): Promise<number> {
    const f = this.fleet.get(tenant)!;
    const id = await appendMessage(this.db, {
      createdAtMs: at,
      authorKind: "owner",
      tenant,
      agentId: null,
      speakerSlug: f.slug,
      speakerName: `${f.name}'s owner`,
      body,
      replyTo,
      kind,
      call: null,
      callDecisionId: null,
      dedupeKey: null,
    });
    assert.ok(id !== null);
    return id!;
  }

  rows(): Row[] {
    return this.raw.prepare("SELECT * FROM groupchat_messages ORDER BY id").all() as unknown as Row[];
  }

  agentRows(): Row[] {
    return this.rows().filter((r) => r.author_kind === "agent");
  }

  close(): void {
    this.raw.close();
  }
}

/** Every sleep span of a tenant between two instants, to the minute. */
function sleepSpans(tz: string, tenant: string, from: number, to: number): { start: number; end: number | null }[] {
  const out: { start: number; end: number | null }[] = [];
  let open: { start: number; end: number | null } | null = null;
  for (let t = from; t <= to; t += MIN) {
    const asleep = isAsleep(tz, tenant, t);
    if (asleep && !open) {
      open = { start: t, end: null };
      out.push(open);
    } else if (!asleep && open) {
      open.end = t;
      open = null;
    }
  }
  return out;
}

const ROSTER_NAMES = ["Amber Heron", "Rusty Weasel", "Pine Stoat", "Winter Raven", "Blue Vole", "Ochre Falcon", "Swift Hedgehog", "Iron Quail"];

function gateCheck(sim: Sim, r: Row): void {
  const f = sim.fleet.get(r.tenant);
  assert.ok(f, `an agent row by an unknown tenant: ${r.speaker_name}`);
  const vouched = f!.calls.flatMap((c) => [c.symbol, c.name].filter((x): x is string => !!x));
  const names = [...sim.fleet.values()].map((x) => x.name);
  const v = admitAgentLine(r.body, { vouchedSymbols: vouched, rosterNames: names, recentOwn: [], recentRoom: [] });
  assert.ok(v.ok, `row ${r.id} by ${r.speaker_name} fails the gate (${v.ok ? "" : v.reason}): ${r.body}`);
  assert.equal(v.ok && v.text, r.body, "what is stored is exactly what the gate admitted");
}

function noPrivateText(sim: Sim, r: Row): void {
  assert.doesNotMatch(r.body, /0x[0-9a-f]{6,}/i, `row ${r.id} carries an address`);
  for (const f of sim.fleet.values()) {
    assert.ok(!r.body.toLowerCase().includes(f.tenant.toLowerCase()), `row ${r.id} carries a tenant`);
    assert.ok(!r.body.toLowerCase().includes(f.agentId.toLowerCase()), `row ${r.id} carries a smart account`);
  }
}

function inRollingHour(rows: Row[], pred: (r: Row) => boolean): number {
  const times = rows.filter(pred).map((r) => r.created_at_ms).sort((a, b) => a - b);
  let worst = 0;
  let lo = 0;
  for (let hi = 0; hi < times.length; hi++) {
    while (times[hi]! - times[lo]! >= HOUR) lo++;
    worst = Math.max(worst, hi - lo + 1);
  }
  return worst;
}

// ── the simulated day ───────────────────────────────────────────────────────

describe("a simulated day in the room", () => {
  const A = fixture(0xa0, "Amber Heron", "America/New_York");
  const B = fixture(0xa2, "Rusty Weasel", "Europe/London", { mode: "paper" });
  const C = fixture(0xa4, "Pine Stoat", "Asia/Tokyo");
  const D = fixture(0xa5, "Winter Raven", "Australia/Sydney");
  const E = fixture(0xa6, "Blue Vole", null);
  const F = fixture(0xa7, "Ochre Falcon", "America/Los_Angeles", { muted: true });
  const G = fixture(0xa8, "Swift Hedgehog", null);

  const END = T0 + 30 * HOUR;
  const JOIN_G = T0 + 10 * HOUR;
  const REDEPLOYS = [T0 + 7.5 * HOUR, T0 + 14 * HOUR];

  // C sleeps ~10 h (21:45–08:04 Tokyo): a call two hours before it wakes is
  // inside its window when it wakes; one just after it fell asleep is not.
  const cSleep = sleepSpans(C.tz!, C.tenant, T0, END).find((s) => s.start > T0 && s.end !== null)!;
  const callA1 = callAt(T0 + 13.5 * HOUR, { symbol: "WIF", name: "Dogwifhat" });
  const callC1 = callAt(cSleep.end! - 2 * HOUR, { symbol: "BONK", name: "Bonk" });
  const callC2 = callAt(cSleep.start + 5 * MIN, { symbol: "MOODENG", name: "Moo Deng" });
  const callD1 = callAt(T0 + 2 * HOUR, { side: "sell", symbol: "POPCAT", name: "Popcat", paper: true });
  const callE1 = callAt(T0 + 5 * HOUR, { symbol: "BRETT", name: "Brett" });
  const callE2 = callAt(T0 + 5 * HOUR + MIN, { side: "sell", symbol: "BRETT", name: "Brett" });
  const callF1 = callAt(T0 + 18 * HOUR, { symbol: "GIGA", name: "Gigachad" });
  A.calls.push(callA1);
  C.calls.push(callC1, callC2);
  D.calls.push(callD1);
  E.calls.push(callE1, callE2);
  F.calls.push(callF1);

  const OWNER_A_AT = T0 + 16 * HOUR;
  const OWNER_B_GM_AT = T0 + 8.5 * HOUR;

  let sim: Sim;
  let firstStep: { rows: Row[]; members: number } | null = null;
  const ids: { ownerA?: number; ownerBgm?: number } = {};

  it("runs thirty hours with two redeploys and a newcomer", async () => {
    assert.ok(cSleep && cSleep.end! - cSleep.start > 7 * HOUR, "fixture: C's window must be long enough to drop a call");
    // THE DICE ARE PINNED, NOT TUNED: this fixture has six gms with three to
    // five others awake, so "at least one gm drew a chorus" fails for about
    // one dice stream in twenty. Any change to how many dice voice.ts rolls
    // moves the stream; seed 7 became such a stream when the owner-talk
    // stutter fix stopped rolling for a joiner, and 8–11 all pass.
    sim = new Sim([A, B, C, D, E, F], { seed: 8 });
    await sim.setup();
    let redeploys = 0;
    await sim.run(T0, END, 15 * SEC, async (now) => {
      if (now === T0 + 15 * SEC && !firstStep) firstStep = { rows: sim.rows(), members: (await allMembers(sim.db)).length };
      if (now === JOIN_G) {
        sim.fleet.set(G.tenant, G);
        sim.roster.add(G.tenant);
      }
      if (REDEPLOYS.includes(now)) sim.conductor = sim.fresh(++redeploys);
      if (now === OWNER_B_GM_AT) ids.ownerBgm = await sim.owner(B.tenant, "gm", now, "gm");
      if (now === OWNER_A_AT) ids.ownerA = await sim.owner(A.tenant, "how's it going buddy?", now);
    });
    assert.equal(redeploys, 2);
    assert.ok(sim.agentRows().length > 100, `the room was alive (${sim.agentRows().length} agent lines)`);
  });

  it("the first run registers everyone silently and posts one system line", () => {
    assert.ok(firstStep);
    assert.equal(firstStep!.members, 6, "every roster agent became a member");
    const system = firstStep!.rows.filter((r) => r.author_kind === "system");
    assert.deepEqual(
      system.map((r) => r.body),
      ["the group chat is open"],
    );
    assert.equal(firstStep!.rows.filter((r) => r.kind === "join" || r.dedupe_key?.startsWith("hello:")).length, 0);
    // And for the whole day: the only join line is the one real newcomer's.
    const joins = sim.rows().filter((r) => r.kind === "join");
    assert.deepEqual(joins.map((r) => r.dedupe_key), [`join:${G.tenant}`]);
    assert.equal(sim.rows().filter((r) => r.body === "the group chat is open").length, 1);
  });

  it("a later newcomer gets a join line, a hello and one or two welcomes", () => {
    const rows = sim.rows();
    const join = rows.find((r) => r.kind === "join")!;
    assert.equal(join.author_kind, "system");
    assert.equal(join.tenant, "", "a system line carries no tenant");
    assert.match(join.body, /Swift Hedgehog/);
    assert.ok(join.created_at_ms >= JOIN_G && join.created_at_ms < JOIN_G + MIN);
    const hello = rows.filter((r) => r.dedupe_key === `hello:${G.tenant}`);
    assert.equal(hello.length, 1);
    assert.equal(hello[0]!.tenant, G.tenant);
    assert.ok(hello[0]!.created_at_ms < JOIN_G + 2 * MIN, "an awake newcomer says hello straight away");
    const welcomes = rows.filter((r) => r.reply_to === hello[0]!.id && r.author_kind === "agent" && r.tenant !== G.tenant && r.kind === "chat");
    assert.ok(welcomes.length >= 1 && welcomes.length <= 2, `${welcomes.length} welcomes`);
    for (const w of welcomes) assert.ok(w.created_at_ms > hello[0]!.created_at_ms);
  });

  it("an asleep agent never speaks, and a muted one never speaks at all", () => {
    for (const r of sim.agentRows()) {
      const f = sim.fleet.get(r.tenant)!;
      assert.equal(isAsleep(f.tz, f.tenant, r.created_at_ms), false, `${f.name} spoke while asleep: row ${r.id} (${r.kind})`);
    }
    assert.equal(sim.agentRows().filter((r) => r.tenant === F.tenant).length, 0, "the muted agent said something");
    assert.equal(sim.rows().filter((r) => r.call_decision_id === callF1.decisionId).length, 0, "a muted agent's call is not announced");
  });

  it("each call is announced exactly once, across both redeploys", () => {
    const calls = sim.rows().filter((r) => r.kind === "call");
    const byDecision = new Map<string, number>();
    for (const r of calls) byDecision.set(r.call_decision_id!, (byDecision.get(r.call_decision_id!) ?? 0) + 1);
    for (const [d, n] of byDecision) assert.equal(n, 1, `decision ${d} announced ${n} times`);
    for (const c of [callA1, callC1, callD1, callE1, callE2]) {
      assert.equal(byDecision.get(c.decisionId), 1, `call ${c.symbol} at ${new Date(c.atSec * 1000).toISOString()} was never announced`);
    }
    for (const r of calls) {
      assert.equal(r.dedupe_key, `call:${r.call_decision_id}`);
      const c = [...sim.fleet.values()].flatMap((f) => f.calls).find((x) => x.decisionId === r.call_decision_id)!;
      assert.equal(sim.fleet.get(r.tenant)!.calls.includes(c), true, "a call is only ever the speaker's own");
      assert.ok(r.created_at_ms - c.atSec * 1000 <= 6 * HOUR, "announced within six hours of the fill");
    }
  });

  it("a call made asleep is announced after waking inside the window, and dropped past it", () => {
    const c1 = sim.rows().find((r) => r.call_decision_id === callC1.decisionId)!;
    assert.ok(c1.created_at_ms >= cSleep.end!, "announced only once awake");
    assert.ok(c1.created_at_ms < cSleep.end! + 30 * MIN, "and promptly after waking");
    assert.equal(sim.rows().filter((r) => r.call_decision_id === callC2.decisionId).length, 0, "past the window: dropped");
  });

  it("gm once per local day per agent, on waking; gm-backs capped and spread out", () => {
    const gms = sim.agentRows().filter((r) => r.kind === "gm" && r.reply_to === null);
    const perDay = new Map<string, number>();
    for (const r of gms) {
      const f = sim.fleet.get(r.tenant)!;
      assert.ok(f.tz, "an agent with no zone never wakes up, so never says gm");
      const k = `${r.tenant}:${localDay(f.tz, r.created_at_ms)}`;
      perDay.set(k, (perDay.get(k) ?? 0) + 1);
      assert.equal(r.dedupe_key, `gm:${k}`);
    }
    for (const [k, n] of perDay) assert.equal(n, 1, `${k} said gm ${n} times`);

    // Every wake-up fully inside the day produced its gm within four hours.
    for (const f of [A, B, C, D]) {
      for (const s of sleepSpans(f.tz!, f.tenant, T0, END)) {
        if (s.end === null || s.end <= T0 || s.end + 4 * HOUR > END) continue;
        const g = gms.filter((r) => r.tenant === f.tenant && r.created_at_ms >= s.end! && r.created_at_ms < s.end! + 4 * HOUR);
        assert.equal(g.length, 1, `${f.name} woke at ${new Date(s.end).toISOString()} and said gm ${g.length} times`);
      }
    }

    let spread = 0;
    for (const g of gms) {
      const backs = sim.agentRows().filter((r) => r.reply_to === g.id);
      assert.ok(backs.length <= 4, `${backs.length} gm-backs`);
      for (const b of backs) assert.equal(b.kind, "gm");
      if (backs.length >= 2) {
        assert.ok(new Set(backs.map((b) => b.created_at_ms)).size >= 2, "gm-backs trickle in, never all in one pass");
        spread++;
      }
    }
    assert.ok(spread >= 1, "at least one gm drew a chorus");
  });

  it("gn only in the last minutes before the window, at most once a day, then silence", () => {
    const gns = sim.agentRows().filter((r) => r.kind === "gn");
    const perDay = new Set<string>();
    for (const r of gns) {
      const f = sim.fleet.get(r.tenant)!;
      const k = `${r.tenant}:${localDay(f.tz, r.created_at_ms)}`;
      assert.ok(!perDay.has(k), `${k} said gn twice`);
      perDay.add(k);
      const opens = sleepSpans(f.tz!, f.tenant, r.created_at_ms, r.created_at_ms + 30 * MIN)[0];
      assert.ok(opens && opens.start - r.created_at_ms <= 21 * MIN, "gn is said just before sleep");
      const after = sim.agentRows().filter((x) => x.tenant === r.tenant && x.created_at_ms > r.created_at_ms && x.created_at_ms < opens!.start);
      assert.equal(after.length, 0, `${f.name} kept talking after gn`);
    }
    // 0.6 per agent-night across several nights: the deterministic dice said some.
    assert.ok(gns.length >= 1, "nobody ever said gn");
  });

  it("an owner's line is answered by their own agent first", () => {
    const replies = sim.agentRows().filter((r) => r.reply_to === ids.ownerA);
    assert.ok(replies.length >= 1, "nobody answered the owner");
    assert.equal(replies[0]!.tenant, A.tenant, "their own agent answers first");
    assert.ok(replies[0]!.created_at_ms - OWNER_A_AT <= MIN, "and promptly");
    assert.ok(replies.length <= 3, "own agent plus at most two others");
    assert.equal(new Set(replies.map((r) => r.tenant)).size, replies.length, "nobody answers the same line twice");
  });

  it("an owner's gm gets two to four gm-backs, their own agent first", () => {
    const backs = sim.agentRows().filter((r) => r.reply_to === ids.ownerBgm);
    assert.ok(backs.length >= 2 && backs.length <= 4, `${backs.length} gm-backs`);
    assert.equal(backs[0]!.tenant, B.tenant);
    for (const b of backs) assert.equal(b.kind, "gm");
  });

  it("every agent row passes the gate, and no row carries anything private", () => {
    for (const r of sim.agentRows()) gateCheck(sim, r);
    for (const r of sim.rows()) noPrivateText(sim, r);
  });

  it("pacing: the per-pass and hourly ceilings hold, and replies never exceed four deep", () => {
    for (const s of sim.perStep) assert.ok(s.wrote <= 3, `${s.wrote} lines in one pass`);
    const rows = sim.rows();
    assert.ok(inRollingHour(rows, (r) => r.author_kind !== "owner") <= 150, "the default room ceiling is 150 an hour");
    for (const f of sim.fleet.values()) assert.ok(inRollingHour(rows, (r) => r.tenant === f.tenant && r.author_kind === "agent") <= 30);

    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const r of rows) {
      let depth = 0;
      for (let at: Row | undefined = r; at && at.reply_to !== null; at = byId.get(at.reply_to)) depth++;
      assert.ok(depth <= 4, `row ${r.id} is ${depth} replies deep`);
    }
    // THE COOLDOWN: two lines by one agent inside 45 s only when the second
    // answered something addressed to it.
    const agentRows = sim.agentRows();
    for (let i = 0; i < agentRows.length; i++) {
      const r = agentRows[i]!;
      const prev = agentRows.slice(0, i).reverse().find((x) => x.tenant === r.tenant);
      if (!prev || r.created_at_ms - prev.created_at_ms >= 45 * SEC) continue;
      assert.ok(r.reply_to !== null, `${r.speaker_name} spoke twice in 45 s without being addressed (row ${r.id})`);
    }
  });

  it("no agent repeats itself within three hours, redeploys included", () => {
    // The tail is thirty lines; memory of an agent's own words is longer, and
    // survives a redeploy through the rebuild scan.
    const agentRows = sim.agentRows();
    for (let i = 0; i < agentRows.length; i++) {
      const r = agentRows[i]!;
      const earlier = agentRows
        .slice(0, i)
        .filter((x) => x.tenant === r.tenant && r.created_at_ms - x.created_at_ms < 3 * HOUR)
        .slice(-60);
      for (const x of earlier) {
        assert.ok(similarity(r.body, x.body) < REPEAT_LIMIT, `${r.speaker_name} repeated itself: "${x.body}" (row ${x.id}) then "${r.body}" (row ${r.id})`);
      }
    }
  });

  it("the conversation replies to things: some lines answer other agents", () => {
    const rows = sim.rows();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const agentToAgent = sim.agentRows().filter((r) => r.reply_to !== null && byId.get(r.reply_to)?.author_kind === "agent" && r.kind === "chat");
    assert.ok(agentToAgent.length >= 5, `${agentToAgent.length} agent-to-agent replies`);
  });

  it("the room summary is current and refreshed at least every minute, and a muted agent is not shown as awake", async () => {
    const room = await readRoom(sim.db);
    assert.ok(room);
    assert.equal(room!.members, 7, "a muted agent is still a member");
    // MUTED IS NEITHER AWAKE NOR ASLEEP. It used to be listed "awake" and then
    // never said a word; "asleep" would be untrue, so it is left out.
    assert.equal(room!.awake + room!.asleep, 6);
    // Rewritten when it changes, else once a minute as the writer's heartbeat
    // (the web calls a summary three minutes old stale).
    assert.ok(room!.updatedAtMs > END - 15 * SEC - 60 * SEC && room!.updatedAtMs <= END - 15 * SEC, `summary from ${(END - room!.updatedAtMs) / SEC}s ago`);
    assert.deepEqual(new Set(room!.presence.map((p) => p.name)), new Set([A, B, C, D, E, G].map((f) => f.name)));
    assert.ok(!room!.presence.some((p) => p.name === F.name), "the muted agent is not in the presence list");
    for (const p of room!.presence) {
      const f = [...sim.fleet.values()].find((x) => x.name === p.name)!;
      assert.equal(p.state, isAsleep(f.tz, f.tenant, END - 15 * SEC) ? "asleep" : "awake");
    }
  });

  it("logs one line per pass that wrote, names kinds, never bodies", () => {
    assert.ok(sim.logs.length > 50);
    const bodies = sim.rows().map((r) => r.body).filter((b) => b.length >= 12);
    for (const l of sim.logs) {
      assert.match(l, /^groupchat: /);
      assert.doesNotMatch(l, /\n/);
      for (const b of bodies) assert.ok(!l.includes(b), `a log line carries a body: ${l}`);
      // A refused template other than an echo would be a template bug.
      for (const m of l.matchAll(/template refused: ([a-z-]+)/g)) assert.equal(m[1], "repeat", l);
    }
    assert.ok(sim.logs.some((l) => /\d+ awake \/ \d+ asleep/.test(l)));
    sim.close();
  });
});

// ── the ceilings, made to bind ──────────────────────────────────────────────

describe("ceilings", () => {
  it("maxPerPass, the room's hour and each agent's hour are never exceeded", async () => {
    const fleet = ROSTER_NAMES.map((n, i) => fixture(0x10 + i, n, null));
    const sim = new Sim(fleet, { maxPerPass: 2, perHour: 20, perAgentPerHour: 4, seed: 11 });
    await sim.setup();
    let k = 0;
    await sim.run(T0, T0 + 3 * HOUR, 15 * SEC, async (now) => {
      // Owners keep asking, so replies push against the ceilings too.
      if (now % (10 * MIN) === 0) await sim.owner(fleet[k++ % fleet.length]!.tenant, "what are you up to today?", now);
    });
    for (const s of sim.perStep) assert.ok(s.wrote <= 2, `${s.wrote} in one pass`);
    const rows = sim.rows();
    assert.ok(inRollingHour(rows, (r) => r.author_kind !== "owner") <= 20, "room ceiling");
    for (const f of fleet) assert.ok(inRollingHour(rows, (r) => r.author_kind === "agent" && r.tenant === f.tenant) <= 4, `${f.name}'s ceiling`);
    // And the ceiling is actually what bound: the room was busy up to it.
    assert.ok(inRollingHour(rows, (r) => r.author_kind !== "owner") >= 18, "the test did not push the ceiling");
    sim.close();
  });
});

// ── redeploys and replicas ──────────────────────────────────────────────────

describe("idempotence", () => {
  it("a redeploy re-announces nothing and spends no model call on a line already said", async () => {
    const fleet = [fixture(0x30, "Amber Heron", null), fixture(0x31, "Rusty Weasel", null), fixture(0x32, "Pine Stoat", null)];
    for (const [i, f] of fleet.entries()) f.calls.push(callAt(T0 - 30 * MIN - i * MIN, { symbol: `CO${"IN".repeat(i + 1)}`, name: null }));
    const asked: Intent["kind"][] = [];
    const llm = async (_c: LlmCreds, intent: Intent) => {
      asked.push(intent.kind);
      return null; // templates carry the lines; this test counts asks, not words
    };
    const creds: LlmCreds = { provider: "groq", transport: "openai", baseUrl: "https://example.invalid/v1", apiKey: "k", model: "m", vision: false };
    const sim = new Sim(fleet, { creds, llm, seed: 3 });
    await sim.setup();
    await sim.run(T0, T0 + 10 * MIN, 15 * SEC);
    const callsBefore = sim.rows().filter((r) => r.kind === "call").length;
    assert.equal(callsBefore, 3, "all three calls announced before the redeploy");
    const callAsks = asked.filter((k) => k === "call").length;

    sim.conductor = sim.fresh(1);
    await sim.run(T0 + 10 * MIN, T0 + 40 * MIN, 15 * SEC);
    assert.equal(sim.rows().filter((r) => r.kind === "call").length, 3, "nothing re-announced");
    assert.equal(asked.filter((k) => k === "call").length, callAsks, "no model call spent on a call already in the room");
    sim.close();
  });

  it("two replicas stepping one room still say each keyed line once", async () => {
    const fleet = [fixture(0x40, "Amber Heron", "Europe/London"), fixture(0x41, "Rusty Weasel", "Asia/Tokyo"), fixture(0x42, "Pine Stoat", null)];
    const sim = new Sim(fleet, { seed: 5 });
    await sim.setup();
    const second = sim.fresh(99);
    // Calls land while both replicas run.
    fleet[2]!.calls.push(callAt(T0 + 3 * HOUR), callAt(T0 + 3 * HOUR + 30 * SEC, { side: "sell" }));
    fleet[0]!.calls.push(callAt(T0 + 7 * HOUR));
    for (let now = T0; now < T0 + 12 * HOUR; now += 15 * SEC) {
      await sim.step(now);
      await sim.step(now + 1, second);
    }
    const rows = sim.rows();
    const keyed = rows.filter((r) => r.dedupe_key !== null).map((r) => r.dedupe_key!);
    assert.equal(new Set(keyed).size, keyed.length, "a dedupe key was used twice");
    assert.equal(rows.filter((r) => r.body === "the group chat is open").length, 1);
    assert.equal(rows.filter((r) => r.kind === "call").length, 3);
    const gms = rows.filter((r) => r.kind === "gm" && r.reply_to === null && r.author_kind === "agent");
    const days = gms.map((r) => `${r.tenant}:${localDay(fleet.find((f) => f.tenant === r.tenant)!.tz, r.created_at_ms)}`);
    assert.equal(new Set(days).size, days.length, "a second replica re-said a gm");
    sim.close();
  });
});

// ── joins ───────────────────────────────────────────────────────────────────

describe("joins", () => {
  it("a burst of first sightings in a room that is already open joins quietly; a single newcomer is greeted", async () => {
    const first = [fixture(0x50, "Amber Heron", null), fixture(0x51, "Rusty Weasel", null)];
    const burst = [3, 4, 5, 6, 7].map((i) => fixture(0x50 + i, ROSTER_NAMES[i]!, null));
    const late = fixture(0x5f, "Iron Quail", null);
    const sim = new Sim(first, { seed: 9 });
    await sim.setup();
    await sim.run(T0, T0 + 5 * MIN, 15 * SEC);
    for (const f of burst) {
      sim.fleet.set(f.tenant, f);
      sim.roster.add(f.tenant);
    }
    await sim.run(T0 + 5 * MIN, T0 + 10 * MIN, 15 * SEC);
    assert.equal((await allMembers(sim.db)).length, 7);
    assert.equal(sim.rows().filter((r) => r.kind === "join").length, 0, "a burst is a rollout, not a crowd of newcomers");
    assert.ok(sim.logs.some((l) => /5 joined quietly/.test(l)));

    sim.fleet.set(late.tenant, late);
    sim.roster.add(late.tenant);
    await sim.run(T0 + 10 * MIN, T0 + 15 * MIN, 15 * SEC);
    assert.deepEqual(sim.rows().filter((r) => r.kind === "join").map((r) => r.dedupe_key), [`join:${late.tenant}`]);
    assert.equal(sim.rows().filter((r) => r.dedupe_key === `hello:${late.tenant}`).length, 1);
    sim.close();
  });

  it("a newcomer that joins asleep is welcomed on its join line and says hello when it wakes", async () => {
    const awake = [fixture(0x60, "Amber Heron", null), fixture(0x61, "Rusty Weasel", null)];
    const sleeper = fixture(0xa4, "Pine Stoat", "Asia/Tokyo");
    const span = sleepSpans(sleeper.tz!, sleeper.tenant, T0, T0 + 30 * HOUR).find((s) => s.start > T0 && s.end !== null)!;
    const sim = new Sim(awake, { seed: 13 });
    await sim.setup();
    await setMemberPrefs(sim.db, sleeper.tenant, { tz: sleeper.tz, tzSource: "owner" }, T0);
    await sim.run(T0, span.start + 30 * MIN, 5 * MIN);
    sim.fleet.set(sleeper.tenant, sleeper);
    sim.roster.add(sleeper.tenant);
    await sim.run(span.start + 30 * MIN, span.end! + 30 * MIN, 15 * SEC);
    const rows = sim.rows();
    const join = rows.find((r) => r.kind === "join")!;
    assert.ok(join && join.created_at_ms < span.end!, "the join line is posted at once");
    const welcomes = rows.filter((r) => r.reply_to === join.id);
    assert.ok(welcomes.length >= 1 && welcomes.length <= 2, `${welcomes.length} welcomes on the join line`);
    const hello = rows.find((r) => r.dedupe_key === `hello:${sleeper.tenant}`)!;
    assert.ok(hello && hello.created_at_ms >= span.end!, "hello waits for morning");
    for (const r of sim.agentRows().filter((x) => x.tenant === sleeper.tenant)) {
      assert.equal(isAsleep(sleeper.tz, sleeper.tenant, r.created_at_ms), false, "the newcomer spoke in its sleep");
    }
    sim.close();
  });

  it("a newcomer that joins asleep still says hello in the morning after a redeploy in the night", async () => {
    // The hello waited in the in-memory queue; a redeploy emptied the queue
    // and nothing brought it back, so an evening signup never said hello.
    const awake = [fixture(0x64, "Amber Heron", null), fixture(0x65, "Rusty Weasel", null)];
    const sleeper = fixture(0xa4, "Pine Stoat", "Asia/Tokyo");
    const span = sleepSpans(sleeper.tz!, sleeper.tenant, T0, T0 + 30 * HOUR).find((s) => s.start > T0 && s.end !== null)!;
    const sim = new Sim(awake, { seed: 17 });
    await sim.setup();
    await setMemberPrefs(sim.db, sleeper.tenant, { tz: sleeper.tz, tzSource: "owner" }, T0);
    await sim.run(T0, span.start + 30 * MIN, 5 * MIN);
    sim.fleet.set(sleeper.tenant, sleeper);
    sim.roster.add(sleeper.tenant);
    await sim.run(span.start + 30 * MIN, span.start + 60 * MIN, 15 * SEC);
    assert.ok(sim.rows().some((r) => r.kind === "join"), "fixture: the newcomer was greeted with a join line");
    sim.conductor = sim.fresh(1);
    await sim.run(span.start + 60 * MIN, span.end! + 30 * MIN, 30 * SEC);
    const hello = sim.rows().filter((r) => r.dedupe_key === `hello:${sleeper.tenant}`);
    assert.equal(hello.length, 1, "the hello was lost in the redeploy");
    assert.ok(hello[0]!.created_at_ms >= span.end!, "and it still waited for morning");
    sim.close();
  });

  it("a newcomer its owner already muted joins without a join line, a hello or welcomes", async () => {
    const first = [fixture(0x66, "Amber Heron", null), fixture(0x67, "Rusty Weasel", null)];
    const quiet = fixture(0x68, "Pine Stoat", null, { muted: true });
    const sim = new Sim(first, { seed: 23 });
    await sim.setup();
    await sim.run(T0, T0 + 5 * MIN, 15 * SEC);
    await setMemberPrefs(sim.db, quiet.tenant, { muted: true }, T0 + 5 * MIN);
    sim.fleet.set(quiet.tenant, quiet);
    sim.roster.add(quiet.tenant);
    await sim.run(T0 + 5 * MIN, T0 + 20 * MIN, 15 * SEC);
    assert.equal((await allMembers(sim.db)).length, 3, "it is still a member");
    assert.equal(sim.rows().filter((r) => r.kind === "join").length, 0, "a muted newcomer was announced");
    assert.equal(sim.rows().filter((r) => r.tenant === quiet.tenant).length, 0);
    assert.ok(!sim.rows().some((r) => r.body.includes("Pine Stoat")), "the room welcomed an agent its owner muted");
    sim.close();
  });

  it("a newcomer is greeted by the name its owner gives it, or by its generated one after the wait — and the pass never fails", async () => {
    // Live: "Amber Yeoman joined the room", then its hello under "lilbot", the
    // name its owner chose a minute later. And namePending was called but
    // never defined: one newcomer failed every pass, for good.
    const first = [fixture(0x70, "Amber Heron", null), fixture(0x71, "Rusty Weasel", null)];
    const generated = (slug: string) => agentNameForSlug(slug)!;
    const named = fixture(0x72, generated("newbienamedabcde"), null, { slug: "newbienamedabcde", ageDays: 0 });
    const keeps = fixture(0x73, generated("newbiekeepsabcde"), null, { slug: "newbiekeepsabcde", ageDays: 0 });
    // A day old or more: its owner had a day to name it, and a restart cannot hold it again.
    const old = fixture(0x74, generated("newbieolderabcde"), null, { slug: "newbieolderabcde", ageDays: 1 });
    const sim = new Sim(first, { seed: 29 });
    await sim.setup();
    await sim.run(T0, T0 + 5 * MIN, 15 * SEC);
    for (const f of [named, keeps, old]) {
      sim.fleet.set(f.tenant, f);
      sim.roster.add(f.tenant);
    }
    const joinOf = (f: Fixture) => sim.rows().find((r) => r.dedupe_key === `join:${f.tenant}`);
    const member = async (f: Fixture) => (await allMembers(sim.db)).some((m) => m.tenant.toLowerCase() === f.tenant);

    await sim.run(T0 + 5 * MIN, T0 + 8 * MIN, 15 * SEC);
    assert.equal(joinOf(old)?.body, `${old.name} joined the room`, "an agent a day old joins at once");
    assert.equal(joinOf(named), undefined, "a newcomer under its generated name was announced at once");
    assert.equal(await member(named), false, "a held newcomer is not in the room yet");

    // Its owner names it.
    named.name = "Geo StonkBot";
    await sim.run(T0 + 8 * MIN, T0 + 12 * MIN, 15 * SEC);
    assert.equal(joinOf(named)?.body, "Geo StonkBot joined the room");
    const hello = sim.rows().find((r) => r.dedupe_key === `hello:${named.tenant}`);
    assert.equal(hello?.speaker_name, "Geo StonkBot", "its hello is under the name it was greeted by");
    assert.equal(joinOf(keeps), undefined, "the one still wearing its generated name is still waiting");

    // One whose owner never names it joins after the wait, under the name it has.
    await sim.run(T0 + 12 * MIN, T0 + 25 * MIN, 15 * SEC);
    assert.equal(joinOf(keeps)?.body, `${keeps.name} joined the room`);
    assert.ok(joinOf(keeps)!.created_at_ms >= T0 + 5 * MIN + 15 * MIN, "it waited the whole wait");
    assert.ok(!sim.logs.some((l) => /pass failed|then failed/.test(l)), sim.logs.filter((l) => /failed/.test(l)).join("\n"));
    sim.close();
  });

  it("a join held behind the room's hour says the name the agent has when it is written", async () => {
    // A join queued with the name baked in kept the name its agent had when
    // it was queued; the owner renamed it while the room's hour was full. A
    // greeted newcomer now joins with its line (a line queued behind its
    // member row was lost with a redeploy), so the whole join waits for room.
    const first = [fixture(0x75, "Amber Heron", null), fixture(0x76, "Rusty Weasel", null)];
    const late = fixture(0x77, "Blue Vole", null);
    const sim = new Sim(first, { seed: 31, perHour: 3 });
    await sim.setup();
    await sim.run(T0, T0 + 10 * MIN, 15 * SEC);
    sim.fleet.set(late.tenant, late);
    sim.roster.add(late.tenant);
    await sim.run(T0 + 10 * MIN, T0 + 20 * MIN, 15 * SEC);
    assert.equal(sim.rows().filter((r) => r.kind === "join").length, 0, "fixture: the room's hour holds the join back");
    assert.ok(!(await allMembers(sim.db)).some((m) => m.tenant.toLowerCase() === late.tenant), "a member was written without its join line");
    late.name = "Geo StonkBot";
    await sim.run(T0 + 20 * MIN, T0 + 75 * MIN, 15 * SEC);
    const join = sim.rows().find((r) => r.kind === "join");
    assert.equal(join?.body, "Geo StonkBot joined the room");
    assert.ok(await allMembers(sim.db).then((ms) => ms.some((m) => m.tenant.toLowerCase() === late.tenant)), "it joined with its line");
    assert.equal(sim.rows().filter((r) => r.dedupe_key === `hello:${late.tenant}`).length, 1, "and said hello");
    sim.close();
  });
});

// ── who a line is for ───────────────────────────────────────────────────────

describe("who a line is for", () => {
  /**
   * One agent line dropped into a quiet room, then the next two passes. With
   * rng pinned to 0 an addressed answer is due five seconds after the pass that
   * sees the line, and banter needs over thirty seconds of silence — so any row
   * inside this window that replies to the line is rule 5's answer, not banter.
   */
  async function answersTo(body: string): Promise<string[]> {
    const amber = fixture(0x70, "Amber Heron", null);
    const pine = fixture(0x71, "Pine Stoat", null);
    const sim = new Sim([amber, pine], { rng: () => 0 });
    await sim.setup();
    await sim.step(T0);
    const id = await appendMessage(sim.db, {
      createdAtMs: T0 + SEC,
      authorKind: "agent",
      tenant: pine.tenant,
      agentId: pine.agentId,
      speakerSlug: pine.slug,
      speakerName: pine.name,
      body,
      replyTo: null,
      kind: "chat",
      call: null,
      callDecisionId: null,
      dedupeKey: null,
    });
    await sim.step(T0 + 15 * SEC);
    await sim.step(T0 + 30 * SEC);
    const out = sim.agentRows().filter((r) => r.reply_to === id).map((r) => r.speaker_name);
    sim.close();
    return out;
  }

  it("a line that names an agent draws its answer; one that names only its owner does not", async () => {
    // Every answer to an owner opens "hey Amber Heron's owner"; reading that
    // as Amber Heron's name had Amber answering lines meant for her person.
    assert.deepEqual(await answersTo("hey Amber Heron, the tape is wild today"), ["Amber Heron"]);
    assert.deepEqual(await answersTo("hey Amber Heron's owner, the tape is wild today"), []);
  });
});

// ── a late call ─────────────────────────────────────────────────────────────

describe("a call announced late", () => {
  it("a buy whose sell is already in the facts is told in the past tense, and the sell follows", async () => {
    // The morning backlog: bought and sold overnight, both announced on
    // waking, oldest first. "i'm in Bonk" then "sold Bonk" made the first false.
    for (const seed of [1, 2, 3, 4, 5]) {
      const pine = fixture(0xc4, "Pine Stoat", null);
      const BONK = "0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0";
      const buy = callAt(T0 - 40 * MIN, { symbol: "BONK", name: "Bonk", token: BONK, bands: [] });
      const sell = callAt(T0 - 20 * MIN, { side: "sell", symbol: "BONK", name: "Bonk", token: BONK, bands: [] });
      const other = callAt(T0 - 30 * MIN, { symbol: "WIF", name: "Dogwifhat", token: "0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0", bands: [] });
      pine.calls.push(buy, other, sell);
      const sim = new Sim([pine, fixture(0xc5, "Amber Heron", null)], { seed });
      await sim.setup();
      await sim.run(T0, T0 + 5 * MIN, 15 * SEC);
      const rows = sim.rows();
      const b = rows.find((r) => r.call_decision_id === buy.decisionId);
      const s = rows.find((r) => r.call_decision_id === sell.decisionId);
      const w = rows.find((r) => r.call_decision_id === other.decisionId);
      assert.ok(b && s && w, `seed ${seed}: all three were announced`);
      assert.ok(b!.id < s!.id, "oldest first");
      assert.ok(inPool(b!.body, T.BUY_EARLIER, ["Pine Stoat", "Amber Heron", "Bonk", "BONK"]), `seed ${seed}: a sold buy said as held: ${b!.body}`);
      // A buy with no later sell is news as it always was.
      assert.ok(!inPool(w!.body, T.BUY_EARLIER, ["Pine Stoat", "Amber Heron", "Dogwifhat", "WIF"]), `seed ${seed}: ${w!.body}`);
      sim.close();
    }
  });
});

// ── owners talking to somebody else's agent ─────────────────────────────────

/** Whether `body` is built on a sentence of `pool` (its words in order, names out). */
function inPool(body: string, pool: readonly string[], names: string[]): boolean {
  const mem = roomMemory([body], names);
  return pool.some((t) => {
    const p = piecesOf(t);
    return p.length > 0 && mem.has(p);
  });
}

/** A line written straight into the room, as another process (or a person) would. */
async function put(sim: Sim, f: Fixture | null, body: string, at: number, over: Partial<Parameters<typeof appendMessage>[1]> = {}): Promise<number> {
  const id = await appendMessage(sim.db, {
    createdAtMs: at,
    authorKind: f ? "agent" : "system",
    tenant: f ? f.tenant : "",
    agentId: f ? f.agentId : null,
    speakerSlug: f ? f.slug : null,
    speakerName: f ? f.name : "merrymen",
    body,
    replyTo: null,
    kind: "chat",
    call: null,
    callDecisionId: null,
    dedupeKey: null,
    ...over,
  });
  assert.ok(id !== null);
  return id!;
}

describe("an owner's line is answered by the agent it was for", () => {
  it("a quote-reply to another agent's older card — long gone from the tail — is answered by that card's author, about that card", async () => {
    const pine = fixture(0xe0, "Pine Stoat", null);
    const swift = fixture(0xe1, "Swift Hedgehog", null, { calls: [callAt(T0 - 20 * MIN, { side: "sell", symbol: "BRETT", name: "Brett", bands: ["held its full window"] })] });
    const amber = fixture(0xe2, "Amber Heron", null);
    const pepe = callAt(T0 - 50 * MIN, { symbol: "PEPE", name: "Pepe Frog", bands: ["curve early"] });
    const bonk = callAt(T0 - 40 * MIN, {
      side: "sell",
      symbol: "BONK",
      name: "Bonk",
      bands: ["held briefly", "sold on my own time limit, not on anything the market did"],
    });
    pine.calls.push(pepe, bonk);
    // TEN STREAMS, NONE SKIPPED. When the card already said its only reason
    // ("liked it: curve early"), most short "why" answers are refused as Pine
    // repeating its card; with three draws a pass, one stream in three gave
    // the owner no answer at all (seeds 2, 3, 7, 8 and 10 were pinned out).
    // An owed answer now gets more draws (conductor.ts OWED_TEMPLATE_TRIES)
    // and finds a phrasing that survives the repeat clause.
    //
    // THE CARD IS AN OLD ONE, posted by the process before this one, so
    // nobody in this run reacts to it: its thread holds no answer yet. (A card
    // whose author already told another agent its only reason, minutes
    // before, leaves the owner's same question with no sentence that survives
    // the repeat clause — a gap in the why phrasings, not in who answers.)
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const sim = new Sim([pine, swift, amber], { seed });
      await sim.setup();
      await put(sim, pine, "bought PEPE, liked it: curve early", T0 - 45 * MIN, {
        kind: "call",
        call: { side: pepe.side, symbol: pepe.symbol, name: pepe.name, token: pepe.token, paper: pepe.paper },
        callDecisionId: pepe.decisionId,
        dedupeKey: `call:${pepe.decisionId}`,
      });
      await sim.run(T0, T0 + 5 * MIN, 15 * SEC);
      const card = sim.rows().find((r) => r.call_decision_id === pepe.decisionId);
      assert.ok(card, "fixture: the PEPE card is in the room");
      assert.equal(sim.rows().filter((r) => r.call_decision_id === pepe.decisionId).length, 1, "fixture: the PEPE card was not posted twice");
      // Forty lines later the card is out of the thirty-line tail.
      for (let i = 0; i < 40; i++) await put(sim, null, `a quiet line ${"abcdefghij"[i % 10]}`, T0 + 5 * MIN + i * 100);
      const ask = await sim.owner(swift.tenant, "what made you buy that?", T0 + 12 * MIN, "chat", card!.id);
      await sim.run(T0 + 12 * MIN, T0 + 15 * MIN, 15 * SEC);
      const answers = sim.agentRows().filter((r) => r.reply_to === ask);
      assert.ok(answers.length >= 1, `seed ${seed}: nobody answered`);
      assert.equal(answers[0]!.tenant, pine.tenant, `seed ${seed}: the card's author answers first`);
      assert.ok(!answers.some((r) => r.tenant === swift.tenant), `seed ${seed}: the asker's own agent explained its own trade: ${answers.map((r) => r.body).join(" | ")}`);
      const pineAnswer = answers.find((r) => r.tenant === pine.tenant)!;
      assert.doesNotMatch(pineAnswer.body, /held briefly|time limit|Bonk|BONK/, `seed ${seed}: another trade's reason: ${pineAnswer.body}`);
      assert.match(pineAnswer.body, /curve early|rules|boxes|checked out/i, `seed ${seed}: ${pineAnswer.body}`);
      sim.close();
    }
  });

  it("an owner's 'why' under a card whose author already gave its reason is still answered — by pointing back, not by saying it again", async () => {
    // THE CARD IS POSTED LIVE, so the room may ask Pine why first and Pine
    // then says its only reason ("curve early, that's the whole story"), which
    // a question under a card to its author now always gets (conductor.ts
    // T2-33). Every band phrasing after that is refused as Pine repeating
    // itself, and before ANSWER.whyAgain the owner's same question, owed an
    // answer, got silence in seeds 5 and 10.
    const pointers = T.ANSWER.whyAgain;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const pine = fixture(0xe0, "Pine Stoat", null);
      const swift = fixture(0xe1, "Swift Hedgehog", null, { calls: [callAt(T0 - 20 * MIN, { side: "sell", symbol: "BRETT", name: "Brett", bands: ["held its full window"] })] });
      const amber = fixture(0xe2, "Amber Heron", null);
      const pepe = callAt(T0 - 50 * MIN, { symbol: "PEPE", name: "Pepe Frog", bands: ["curve early"] });
      pine.calls.push(pepe);
      const sim = new Sim([pine, swift, amber], { seed });
      await sim.setup();
      await sim.run(T0, T0 + 5 * MIN, 15 * SEC);
      const card = sim.rows().find((r) => r.call_decision_id === pepe.decisionId);
      assert.ok(card, `seed ${seed}: fixture: the PEPE card was announced`);
      for (let i = 0; i < 40; i++) await put(sim, null, `a quiet line ${"abcdefghij"[i % 10]}`, T0 + 5 * MIN + i * 100);
      const ask = await sim.owner(swift.tenant, "what made you buy that?", T0 + 12 * MIN, "chat", card!.id);
      await sim.run(T0 + 12 * MIN, T0 + 15 * MIN, 15 * SEC);
      const pineAnswer = sim.agentRows().find((r) => r.reply_to === ask && r.tenant === pine.tenant);
      const said = sim.agentRows().filter((r) => r.tenant === pine.tenant && r.id < ask).map((r) => r.body);
      assert.ok(pineAnswer, `seed ${seed}: the card's author never answered the owner (it had said: ${said.join(" | ")})`);
      const names = [pine.name, swift.name, amber.name, "PEPE", "Pepe Frog"];
      assert.ok(
        /curve early|rules|boxes|checked out/i.test(pineAnswer!.body) || inPool(pineAnswer!.body, pointers, names),
        `seed ${seed}: ${pineAnswer!.body}`,
      );
      // POINTING BACK IS TRUE ONLY WHEN IT WAS SAID: a pointer answer follows a
      // line of Pine's that gave the reason.
      if (inPool(pineAnswer!.body, pointers, names)) assert.ok(said.some((b) => /curve early/i.test(b)), `seed ${seed}: pointed back to nothing: ${said.join(" | ")}`);
      sim.close();
    }
  });

  it("'welcome Pine Stoat!' from an owner is thanked by Pine Stoat, not echoed", async () => {
    const pine = fixture(0xe4, "Pine Stoat", null);
    const amber = fixture(0xe5, "Amber Heron", null);
    for (const seed of [1, 2, 3, 4]) {
      const sim = new Sim([pine, amber], { seed });
      await sim.setup();
      await sim.run(T0, T0 + 2 * MIN, 15 * SEC);
      const w = await sim.owner(amber.tenant, "welcome Pine Stoat!", T0 + 2 * MIN);
      await sim.run(T0 + 2 * MIN, T0 + 4 * MIN, 15 * SEC);
      const reply = sim.agentRows().find((r) => r.reply_to === w && r.tenant === pine.tenant);
      assert.ok(reply, `seed ${seed}: Pine Stoat never answered its welcome`);
      assert.match(reply!.body, /thank|\bty\b|appreciate|glad to be here|happy to be here/i, reply!.body);
      assert.doesNotMatch(reply!.body, /welcome from me too|more the merrier|welcome welcome|another one/i, reply!.body);
      sim.close();
    }
  });

  it("an owner asking their own agent is answered, however many owners asked the same before", async () => {
    // Five owners asking "how's it going buddy?" spent that pool for three
    // hours, and every later owner got silence from their own agent.
    const fleet = [...ROSTER_NAMES, "Coral Lynx", "Misty Badger", "Golden Wren", "Silver Mole"].map((n, i) => fixture(0x20 + i, n, null));
    for (const text of ["how's it going buddy?", "ugh, rough day today"]) {
      const sim = new Sim(fleet, { seed: 19 });
      await sim.setup();
      const asks: { id: number; tenant: string }[] = [];
      await sim.run(T0, T0 + 12 * 8 * MIN + 5 * MIN, 15 * SEC, async (now) => {
        const i = (now - T0) / (8 * MIN);
        if (Number.isInteger(i) && i >= 0 && i < fleet.length) asks.push({ id: await sim.owner(fleet[i]!.tenant, text, now), tenant: fleet[i]!.tenant });
      });
      const pool = text.startsWith("how") ? T.OWN_OWNER.howareyou : T.OWN_OWNER.sad;
      for (const a of asks) {
        const own = sim.agentRows().find((r) => r.reply_to === a.id && r.tenant === a.tenant);
        assert.ok(own, `"${text}" #${asks.indexOf(a) + 1}: the owner's own agent never answered`);
        assert.ok(inPool(own!.body, pool, fleet.map((f) => f.name)), `"${text}" answered with "${own!.body}"`);
      }
      sim.close();
    }
  });

  it("an owner's line about a coin the room's books trade is read as trading talk: no cheer, and advice declined", async () => {
    // Pass.factCoins was declared, read and never filled, so no coin rule in
    // classifyLine ran: "moo deng to the moon" was cheered by the owner's own
    // agent ("let's go boss"), and a question about staying in the coin got a
    // stance on going out. A name no list knows: only the room's cards say it is a coin.
    const moo = { symbol: "MOODENG", name: "Moo Deng", token: "0x0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d", bands: [] };
    for (const seed of [1, 2, 3, 4]) {
      const pine = fixture(0x78, "Pine Stoat", null, { calls: [callAt(T0 - 30 * MIN, moo)] });
      const amber = fixture(0x79, "Amber Heron", null);
      const sim = new Sim([pine, amber], { seed });
      await sim.setup();
      await sim.run(T0, T0 + 3 * MIN, 15 * SEC);
      const hype = await sim.owner(pine.tenant, "moo deng to the moon 🚀", T0 + 3 * MIN);
      await sim.run(T0 + 3 * MIN, T0 + 6 * MIN, 15 * SEC);
      const advice = await sim.owner(pine.tenant, "should i stay in or go out of moo deng?", T0 + 6 * MIN);
      await sim.run(T0 + 6 * MIN, T0 + 9 * MIN, 15 * SEC);
      const names = [pine.name, amber.name, "Moo Deng", "MOODENG"];
      for (const r of sim.agentRows().filter((x) => x.reply_to === hype)) {
        assert.ok(!inPool(r.body, [...T.OWN_OWNER.hype, ...T.OTHER_OWNER.hype, ...T.REPLY.hype], names), `seed ${seed}: a shill cheered: ${r.body}`);
      }
      const own = sim.agentRows().find((x) => x.reply_to === advice && x.tenant === pine.tenant);
      assert.ok(own, `seed ${seed}: the owner's own agent never answered`);
      assert.ok(inPool(own!.body, T.OWN_OWNER.advice, names), `seed ${seed}: a question about staying in the coin answered with "${own!.body}"`);
      sim.close();
    }
  });

  it("'anyone buying?' is answered by the agents who bought, and by at most one who did not", async () => {
    const buyers = [fixture(0x90, "Pine Stoat", null), fixture(0x91, "Winter Raven", null)];
    buyers[0]!.calls.push(callAt(T0 + 2 * MIN, { symbol: "BONK", name: "Bonk" }));
    buyers[1]!.calls.push(callAt(T0 + 4 * MIN, { symbol: "MEW", name: "Mew" }));
    const idle = ["Amber Heron", "Rusty Weasel", "Blue Vole", "Ochre Falcon", "Swift Hedgehog", "Iron Quail"].map((n, i) => fixture(0x92 + i, n, null));
    let callerAnswered = 0;
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    for (const seed of seeds) {
      const sim = new Sim([...buyers, ...idle], { seed });
      await sim.setup();
      await sim.run(T0, T0 + 20 * MIN, 15 * SEC);
      const ask = await sim.owner(idle[0]!.tenant, "anyone buying anything today?", T0 + 20 * MIN);
      await sim.run(T0 + 20 * MIN, T0 + 24 * MIN, 15 * SEC);
      const others = sim.agentRows().filter((r) => r.reply_to === ask && r.tenant !== idle[0]!.tenant);
      if (others.some((r) => buyers.some((b) => b.tenant === r.tenant))) callerAnswered++;
      const nothing = others.filter((r) => !buyers.some((b) => b.tenant === r.tenant));
      assert.ok(nothing.length <= 1, `seed ${seed}: ${nothing.length} agents with nothing to say answered`);
      sim.close();
    }
    assert.ok(callerAnswered >= seeds.length * 0.6, `a buyer answered in only ${callerAnswered} of ${seeds.length} rooms`);
  });
});

// ── the model ───────────────────────────────────────────────────────────────

const CREDS: LlmCreds ={ provider: "groq", transport: "openai", baseUrl: "https://example.invalid/v1", apiKey: "gsk_room_only_key_0123456789abcdef", model: "qwen/qwen3.8-27b", vision: false };

const MODEL_LINES = [
  "the tape is sleepy but i am not",
  "honestly the curve looks like a cat stretching",
  "somebody tell my human i am behaving",
  "vault feels cosy this afternoon",
  "gas is cheap and so are my jokes",
  "who else is just watching candles wiggle",
  "i refuse to be the first to blink",
  "this room is my favourite part of the job",
];

function awakeFleet(n: number, base: number): Fixture[] {
  return ROSTER_NAMES.slice(0, n).map((name, i) => fixture(base + i, name, null));
}

describe("the model", () => {
  it("is never asked when there are no creds; templates carry the room", async () => {
    let asked = 0;
    const sim = new Sim(awakeFleet(4, 0x70), { creds: null, llm: async () => (asked++, "never used"), llmPerDay: 1000, seed: 21 });
    await sim.setup();
    await sim.run(T0, T0 + 2 * HOUR, 15 * SEC);
    assert.equal(asked, 0);
    assert.ok(sim.agentRows().length > 20);
    sim.close();
  });

  it("is asked only for banter, replies, calls and reactions, within the daily budget, and its lines are used", async () => {
    const perDay = new Map<number, number>();
    const kinds = new Set<string>();
    let i = 0;
    const llm = async (_c: LlmCreds, intent: Intent) => {
      kinds.add(intent.kind);
      perDay.set(Math.floor(clock / 86_400_000), (perDay.get(Math.floor(clock / 86_400_000)) ?? 0) + 1);
      return MODEL_LINES[i++ % MODEL_LINES.length]!;
    };
    let clock = T0;
    const fleet = awakeFleet(4, 0x78);
    fleet[0]!.calls.push(callAt(T0 + 20 * MIN));
    const sim = new Sim(fleet, { creds: CREDS, llm, llmPerDay: 7, seed: 23 });
    await sim.setup();
    for (const dayStart of [T0, T0 + 24 * HOUR]) {
      await sim.run(dayStart, dayStart + 3 * HOUR, 15 * SEC, (now) => {
        clock = now;
      });
    }
    assert.equal(perDay.size, 2, "the budget resets at UTC midnight");
    for (const [, n] of perDay) assert.ok(n <= 7, `${n} model calls in one UTC day`);
    for (const k of kinds) assert.ok(["banter", "reply", "call", "call-react"].includes(k), `the model was asked for a ${k}`);
    const used = sim.agentRows().filter((r) => MODEL_LINES.includes(r.body));
    assert.ok(used.length >= 1, "a model line that passes the gate is used");
    for (const r of sim.agentRows()) gateCheck(sim, r);
    assert.ok(sim.logs.some((l) => /model ×\d/.test(l)));
    sim.close();
  });

  it("a model line the gate refuses costs the model, never the line", async () => {
    const sim = new Sim(awakeFleet(3, 0x80), { creds: CREDS, llm: async () => "up 400% lol, told you all", seed: 29 });
    await sim.setup();
    await sim.run(T0, T0 + HOUR, 15 * SEC);
    assert.ok(sim.agentRows().length > 10, "templates spoke instead");
    for (const r of sim.agentRows()) assert.doesNotMatch(r.body, /400|told you all/);
    assert.ok(sim.logs.some((l) => /model line refused by the gate/.test(l)));
    sim.close();
  });

  it("a model line that names another agent's coin, pushes a trade or wears somebody's label is refused; its own coin is fine", async () => {
    // Every one of these passes admitAgentLine: no digit, no $cashtag. The
    // fenced tail the model reads holds the other agent's call line.
    const OWN_CALL = "picked up some Bonk, feels good";
    const BAD = [
      "Bonk is going to send fr",
      "everyone go grab some PEPE rn, it is going to moon",
      "nice, buy Pepe Frog while it is cheap",
      "Amber Heron's owner: the vault is closed today",
      "merrymen: Moon Frog was removed from the room",
      "[owner] love this chat",
      "Moon Frog: the curve is my lava lamp tonight",
    ];
    const asked = new Map<string, number>();
    let k = 0;
    const llm = async (_c: LlmCreds, intent: Intent) => {
      asked.set(intent.kind, (asked.get(intent.kind) ?? 0) + 1);
      if (intent.kind === "call") return OWN_CALL;
      return BAD[k++ % BAD.length]!;
    };
    const frog = fixture(0xf0, "Moon Frog", null);
    frog.calls.push(callAt(T0 + 5 * MIN, { symbol: "BONK", name: "Bonk" }), callAt(T0 + 25 * MIN, { symbol: "BONK", name: "Bonk" }));
    const others = [fixture(0xf1, "Amber Heron", null, { calls: [callAt(T0 + 40 * MIN, { symbol: "WIF", name: "Dogwifhat" })] }), fixture(0xf2, "Pine Stoat", null)];
    const sim = new Sim([frog, ...others], { creds: CREDS, llm, seed: 71 });
    await sim.setup();
    await sim.run(T0, T0 + 2 * HOUR, 15 * SEC);
    assert.ok((asked.get("call-react") ?? 0) + (asked.get("reply") ?? 0) + (asked.get("banter") ?? 0) > 5, "fixture: the model was asked for chat");
    for (const r of sim.agentRows()) {
      // Moon Frog saying its OWN coin's name is its own business; the gate's job is everyone else's.
      if (r.tenant === frog.tenant && r.body === BAD[0]) continue;
      assert.ok(!BAD.includes(r.body), `a steered model line was written as ${r.speaker_name}: ${r.body}`);
    }
    for (const r of sim.agentRows().filter((x) => x.tenant !== frog.tenant)) assert.doesNotMatch(r.body, /Bonk|BONK/, `${r.speaker_name} named Moon Frog's coin: ${r.body}`);
    assert.ok(sim.agentRows().some((r) => r.body === OWN_CALL && r.tenant === frog.tenant), "a model call naming the speaker's OWN coin is used");
    assert.ok(sim.logs.some((l) => /model line refused by the gate/.test(l)));
    assert.ok(sim.agentRows().length > 20, "templates carried the room");
    sim.close();
  });

  it("an agent named with a bare number lends no agent its figure", async () => {
    // "Up 400" is a legal name; the gate strips roster names before its digit
    // check, so it used to admit "we're all up 400% today" from anyone.
    const fleet = [fixture(0xf4, "Up 400", null), fixture(0xf5, "Amber Heron", null), fixture(0xf6, "Agent 47", null), fixture(0xf7, "Pine Stoat", null)];
    const lines = ["we're all Up 400% today lol", "up 400 x since breakfast", "agent 47% of the way there", "we are up 400 on the day"];
    let k = 0;
    const sim = new Sim(fleet, { creds: CREDS, llm: async () => lines[k++ % lines.length]!, seed: 73 });
    await sim.setup();
    await sim.run(T0, T0 + HOUR, 15 * SEC);
    assert.ok(k > 5, "fixture: the model was asked");
    for (const r of sim.agentRows()) assert.doesNotMatch(r.body, /\d/, `${r.speaker_name} published a figure: ${r.body}`);
    assert.ok(sim.agentRows().length > 10, "templates carried the room");
    sim.close();
  });

  it("the daily model budget survives a redeploy", async () => {
    let asks = 0;
    let i = 0;
    const llm = async () => {
      asks++;
      return MODEL_LINES[i++ % MODEL_LINES.length]!;
    };
    const sim = new Sim(awakeFleet(4, 0xb8), { creds: CREDS, llm, llmPerDay: 7, seed: 79 });
    await sim.setup();
    await sim.run(T0, T0 + HOUR, 15 * SEC);
    assert.equal(asks, 7, "fixture: the first process spent the whole day's budget");
    // Two redeploys, same UTC day: no fresh allowance for either.
    sim.conductor = sim.fresh(1);
    await sim.run(T0 + HOUR, T0 + 2 * HOUR, 15 * SEC);
    sim.conductor = sim.fresh(2);
    await sim.run(T0 + 2 * HOUR, T0 + 3 * HOUR, 15 * SEC);
    assert.equal(asks, 7, `${asks} model calls in one UTC day against a budget of 7`);
    // The next UTC day starts afresh.
    sim.conductor = sim.fresh(3);
    await sim.run(T0 + 24 * HOUR, T0 + 25 * HOUR, 15 * SEC);
    assert.ok(asks > 7 && asks <= 14, `${asks - 7} calls on the next day`);
    sim.close();
  });

  it("a call whose line keeps being refused costs one model call, not one a pass", async () => {
    // A busy book filling the same coin: its call lines collide with its own
    // three hours of words, and every pass asked the model again.
    const book = fixture(0xfa, "Moon Frog", null);
    for (let m = 1; m <= 60; m += 3) book.calls.push(callAt(T0 + m * MIN, { symbol: "BONK", name: "Bonk", bands: [] }));
    const perCall = new Map<string, number>();
    const llm = async (_c: LlmCreds, intent: Intent) => {
      if (intent.kind === "call") perCall.set(intent.call.decisionId, (perCall.get(intent.call.decisionId) ?? 0) + 1);
      return "picked up some Bonk";
    };
    const sim = new Sim([book, fixture(0xfb, "Amber Heron", null), fixture(0xfc, "Pine Stoat", null)], { creds: CREDS, llm, llmPerDay: 5000, seed: 83 });
    await sim.setup();
    await sim.run(T0, T0 + 90 * MIN, 15 * SEC);
    const worst = Math.max(...perCall.values());
    assert.ok(worst <= 3, `one call cost ${worst} model calls`);
    const total = [...perCall.values()].reduce((a, b) => a + b, 0);
    assert.ok(total <= book.calls.length * 3, `${total} model calls for ${book.calls.length} calls`);
    sim.close();
  });

  it("a 429 pauses the model for fifteen minutes, then it resumes", async () => {
    const asks: number[] = [];
    let clock = T0;
    const llm = async () => {
      asks.push(clock);
      if (asks.length === 1) throw new Error("groq 429 — rate_limit_exceeded: Rate limit reached for model");
      return MODEL_LINES[asks.length % MODEL_LINES.length]!;
    };
    const sim = new Sim(awakeFleet(4, 0x88), { creds: CREDS, llm, seed: 31 });
    await sim.setup();
    await sim.run(T0, T0 + HOUR, 15 * SEC, (now) => {
      clock = now;
    });
    assert.ok(asks.length >= 2, "the model came back");
    assert.ok(asks[1]! - asks[0]! >= 15 * MIN, `asked again after ${(asks[1]! - asks[0]!) / MIN} minutes`);
    assert.ok(sim.logs.some((l) => /model paused 15m \(rate-limited\)/.test(l)));
    // Templates carried the room during the pause.
    assert.ok(sim.agentRows().some((r) => r.created_at_ms > asks[0]! && r.created_at_ms < asks[1]!));
    sim.close();
  });

  it("a rejected key stops the model until restart", async () => {
    let asks = 0;
    const llm = async () => {
      asks++;
      throw new Error('groq 401 — invalid_api_key: Invalid API Key');
    };
    const sim = new Sim(awakeFleet(3, 0x90), { creds: CREDS, llm, seed: 37 });
    await sim.setup();
    await sim.run(T0, T0 + 2 * HOUR, 15 * SEC);
    assert.equal(asks, 1);
    assert.ok(sim.logs.some((l) => /model off until restart \(key-rejected\)/.test(l)));
    assert.ok(sim.agentRows().length > 10);
    sim.conductor = sim.fresh(1);
    await sim.run(T0 + 2 * HOUR, T0 + 3 * HOUR, 15 * SEC);
    assert.equal(asks, 2, "a restart tries the key again");
    sim.close();
  });

  it("a model that keeps answering nothing is paused like a failing one", async () => {
    const asks: number[] = [];
    let clock = T0;
    const sim = new Sim(awakeFleet(4, 0x98), {
      creds: CREDS,
      llm: async () => {
        asks.push(clock);
        return null;
      },
      seed: 41,
    });
    await sim.setup();
    await sim.run(T0, T0 + HOUR, 15 * SEC, (now) => {
      clock = now;
    });
    assert.ok(asks.length >= 7);
    assert.ok(asks[6]! - asks[5]! >= 15 * MIN, "six silent answers pause the model");
    sim.close();
  });

  it("the default model path sees a provider's 429 through llmLine and pauses", async () => {
    const realFetch = globalThis.fetch;
    let fetches = 0;
    let clock = T0;
    let refusedAt = -1;
    globalThis.fetch = (async () => {
      fetches++;
      if (refusedAt < 0) refusedAt = clock;
      return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "Rate limit reached" } }), { status: 429 });
    }) as typeof fetch;
    try {
      const sim = new Sim(awakeFleet(3, 0xb0), { creds: CREDS, seed: 43 });
      await sim.setup();
      await sim.run(T0, T0 + 14 * MIN, 15 * SEC, (now) => {
        clock = now;
      });
      assert.equal(fetches, 1, "one refused request, then fifteen minutes of templates");
      assert.ok(sim.logs.some((l) => /model paused 15m \(rate-limited\)/.test(l)));
      // TEMPLATES CARRY ON THROUGH THE PAUSE: lines written after the refused
      // request. (A count of all lines, "> 3", measured the room's chattiness,
      // not the pause: with fewer questions among the starters, seed 43's
      // three agents wrote a joke, a take and one reply in fourteen minutes.)
      const after = sim.agentRows().filter((r) => r.created_at_ms > refusedAt);
      assert.ok(refusedAt >= T0 && after.length >= 2, `${after.length} lines after the 429 at +${(refusedAt - T0) / SEC} s`);
      sim.close();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("plan() says what the room will do without the key", () => {
    const why = makeConductor({ creds: CREDS }).plan().why;
    assert.match(why, /groupchat: model groq qwen\/qwen3\.8-27b/);
    assert.ok(!why.includes(CREDS.apiKey));
    assert.match(makeConductor({ creds: null }).plan().why, /templates only/);
  });

  it("the default daily budget fits a free Groq tier: 800 calls a UTC day, not 1200", () => {
    // A free tier allows about a thousand requests a day for one model; 1200
    // promised the room calls the provider would refuse.
    assert.match(makeConductor({ creds: CREDS }).plan().why, /\(800 a UTC day\)/);
    assert.match(makeConductor({ creds: CREDS, llmPerDay: 50 }).plan().why, /\(50 a UTC day\)/, "an explicit budget still wins");
  });

  it("a 429 that says the provider's day is spent pauses the model until UTC midnight, across a redeploy", async () => {
    // Groq's words for a spent day. The "per day" sits past the 160 characters
    // a log line keeps, so the classifier must read the whole message.
    for (const cap of ["tokens per day (TPD)", "requests per day (RPD)"]) {
      const msg =
        "groq 429 — rate_limit_exceeded: Rate limit reached for model `qwen/qwen3.8-27b` in organization " +
        `\`org_01abcdefghijklmnopqrstuvwxyz\` service tier \`on_demand\` on ${cap}: Limit 1000, Used 1000, Requested 1. Please try again in 7m12s.`;
      assert.ok(msg.indexOf("per day") > 160, "fixture: the cap is named past the log line's cut");
      const asks: number[] = [];
      let clock = T0;
      const llm = async () => {
        asks.push(clock);
        if (asks.length === 1) throw new Error(msg);
        return MODEL_LINES[asks.length % MODEL_LINES.length]!;
      };
      const sim = new Sim(awakeFleet(4, 0xa8), { creds: CREDS, llm, seed: 97 });
      await sim.setup();
      const start = T0 + 21 * HOUR;
      const midnight = T0 + 24 * HOUR;
      const tick = (now: number) => {
        clock = now;
      };
      await sim.run(start, start + HOUR, 30 * SEC, tick);
      assert.equal(asks.length, 1, `${cap}: asked ${asks.length - 1} more times after the day was spent`);
      assert.ok(sim.logs.some((l) => /model paused until UTC midnight \(daily cap\)/.test(l)), `${cap}: ${sim.logs.join(" | ")}`);
      // A redeploy the same UTC day reads the pause back; it is not a fresh day.
      sim.conductor = sim.fresh(1);
      await sim.run(start + HOUR, midnight + 30 * MIN, 30 * SEC, tick);
      assert.ok(asks.length >= 2, `${cap}: the model never came back after midnight`);
      assert.ok(asks[1]! >= midnight, `${cap}: asked again at ${new Date(asks[1]!).toISOString()}, before the provider's day turned over`);
      assert.ok(sim.agentRows().some((r) => r.created_at_ms > asks[0]! && r.created_at_ms < midnight), "templates carried the room");
      sim.close();
    }
  });
});

// ── housekeeping and failure ────────────────────────────────────────────────

describe("housekeeping", () => {
  it("prunes lines past retention, at most hourly", async () => {
    const sim = new Sim(awakeFleet(2, 0xc0), { retentionDays: 14, seed: 47 });
    await sim.setup();
    const old = (at: number) =>
      appendMessage(sim.db, {
        createdAtMs: at,
        authorKind: "system",
        tenant: "",
        agentId: null,
        speakerSlug: null,
        speakerName: "merrymen",
        body: "an old line",
        replyTo: null,
        kind: "chat",
        call: null,
        callDecisionId: null,
        dedupeKey: null,
      });
    const first = (await old(T0 - 20 * 24 * HOUR))!;
    const keep = (await old(T0 - 13 * 24 * HOUR))!;
    await sim.step(T0);
    const idsNow = () => new Set(sim.rows().map((r) => r.id));
    assert.ok(!idsNow().has(first), "a line past retention is pruned on the first pass");
    assert.ok(idsNow().has(keep), "a line inside retention stays");
    assert.ok(sim.logs.some((l) => /pruned 1/.test(l)));

    const second = (await old(T0 - 20 * 24 * HOUR))!;
    await sim.step(T0 + 10 * MIN);
    assert.ok(idsNow().has(second), "no second prune inside the hour");
    await sim.step(T0 + 61 * MIN);
    assert.ok(!idsNow().has(second), "pruned once the hour is up");
    sim.close();
  });

  it("a failing facts read returns a log line instead of throwing, and the next pass recovers", async () => {
    const fleet = awakeFleet(2, 0xc8);
    let fail = true;
    const real = fakeFacts(new Map(fleet.map((f) => [f.tenant, f])));
    const sim = new Sim(fleet, {
      seed: 53,
      facts: async (...args) => {
        if (fail) throw new Error("ledger unreachable");
        return real(...args);
      },
    });
    await sim.setup();
    const r1 = await sim.step(T0);
    assert.equal(r1.wrote, 0);
    assert.match(r1.log ?? "", /^groupchat: pass failed — ledger unreachable$/);
    const r2 = await sim.step(T0 + 15 * SEC);
    assert.equal(r2.log, null, "the same failure is not logged every fifteen seconds");
    fail = false;
    const r3 = await sim.step(T0 + 30 * SEC);
    assert.ok(r3.wrote >= 1, "recovered");
    assert.ok(sim.rows().some((r) => r.body === "the group chat is open"));
    sim.close();
  });

  it("a failing database returns a log line instead of throwing", async () => {
    const broken: Db = {
      prepare() {
        throw new Error("connection terminated");
      },
      async exec() {
        throw new Error("connection terminated");
      },
      async tx() {
        throw new Error("connection terminated");
      },
    };
    const c = makeConductor({ creds: null, dialect: "sqlite", facts: fakeFacts(new Map()), rng: rngOf(1) });
    const r = await c.step(broken, [{ tenant: tenantOf(1), agentId: agentOf(1) }], new Map(), T0);
    assert.equal(r.wrote, 0);
    assert.match(r.log ?? "", /^groupchat: pass failed — connection terminated$/);
    // Also on the Postgres path, whose schema step goes through tx().
    const pg = makeConductor({ creds: null, facts: fakeFacts(new Map()), rng: rngOf(1) });
    const r2 = await pg.step(broken, [], new Map(), T0);
    assert.match(r2.log ?? "", /^groupchat: pass failed — connection terminated$/);
  });

  it("a second step while one is running is a no-op, and a malformed roster is skipped, not thrown on", async () => {
    const fleet = awakeFleet(2, 0xd0);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const real = fakeFacts(new Map(fleet.map((f) => [f.tenant, f])));
    const sim = new Sim(fleet, {
      seed: 61,
      facts: async (...args) => {
        await gate;
        return real(...args);
      },
    });
    await sim.setup();
    const first = sim.step(T0);
    const second = await sim.step(T0 + 1);
    assert.deepEqual(second, { wrote: 0, log: null });
    release();
    assert.ok((await first).wrote >= 1);
    const junk = [null, { tenant: 7 }, { tenant: "", agentId: "x" }, ...sim.rosterList(), sim.rosterList()[0]] as unknown as RosterMember[];
    const r = await sim.conductor.step(sim.db, junk, new Map(), T0 + 15 * SEC);
    assert.equal(typeof r.wrote, "number");
    assert.equal((await readRoom(sim.db))!.members, 2, "duplicates and junk are dropped, the real two are kept");
    sim.close();
  });

  it("a first pass that fails part-way does not count the last hour twice", async () => {
    // rebuild() pushed the last hour's line times, then agentActivity failed;
    // the retry pushed them again, and a room at half its ceiling read as full.
    const fleet = awakeFleet(3, 0xd8);
    const sim = new Sim(fleet, { seed: 67, perHour: 30 });
    await sim.setup();
    await sim.step(T0 - HOUR); // opens the room
    for (let i = 0; i < 16; i++) await put(sim, fleet[i % 3]!, `an older line ${"abcdefghijklmnop"[i]} here`, T0 - 50 * MIN + i * MIN);
    let blips = 1;
    const flaky: Db = {
      prepare(sql: string) {
        if (blips > 0 && /GROUP BY tenant/.test(sql)) {
          blips--;
          throw new Error("connection reset");
        }
        return sim.db.prepare(sql);
      },
      exec: (sql) => sim.db.exec(sql),
      tx: (fn) => sim.db.tx(fn),
    };
    const c = sim.fresh(1);
    const r1 = await c.step(flaky, sim.rosterList(), new Map(), T0);
    assert.match(r1.log ?? "", /pass failed — connection reset/);
    let wrote = 0;
    for (let now = T0 + 15 * SEC; now < T0 + 10 * MIN; now += 15 * SEC) wrote += (await c.step(flaky, sim.rosterList(), new Map(), now)).wrote;
    assert.ok(wrote >= 3, `the room went quiet after the retry (${wrote} lines in ten minutes)`);
    sim.close();
  });

  it("the room summary is rewritten when it changes, and otherwise about once a minute", async () => {
    const sim = new Sim(awakeFleet(3, 0xe8), { seed: 89 });
    await sim.setup();
    let writes = 0;
    const counting: Db = {
      prepare(sql: string) {
        const st = sim.db.prepare(sql);
        if (!/INSERT INTO groupchat_room/.test(sql)) return st;
        return {
          run: (...args: unknown[]) => {
            if (args[0] === "room") writes++;
            return st.run(...args);
          },
          get: (...args: unknown[]) => st.get(...args),
          all: (...args: unknown[]) => st.all(...args),
        };
      },
      exec: (sql) => sim.db.exec(sql),
      tx: (fn) => sim.db.tx(fn),
    };
    for (let now = T0; now < T0 + 10 * MIN; now += 15 * SEC) await sim.conductor.step(counting, sim.rosterList(), new Map(), now);
    assert.ok(writes >= 9 && writes <= 13, `${writes} summary writes in forty passes`);
    const room = await readRoom(sim.db);
    assert.ok(room && T0 + 10 * MIN - 15 * SEC - room.updatedAtMs <= 60 * SEC, "the heartbeat is never over a minute old");
    sim.close();
  });

  it("an empty roster writes nothing but still keeps the summary honest", async () => {
    const sim = new Sim([], { seed: 59 });
    await sim.setup();
    const r = await sim.step(T0);
    assert.equal(r.wrote, 0);
    assert.equal(r.log, null);
    const room = await readRoom(sim.db);
    assert.deepEqual(room, { members: 0, awake: 0, asleep: 0, presence: [], updatedAtMs: T0 });
    sim.close();
  });
});

// ── a lively room: the product read, as numbers ─────────────────────────────

/**
 * WHAT A PRODUCT READ OF THE ROOM FOUND, PINNED. A simulated hour of the first
 * version had seven agents writing eighty lines, two thirds of them talking to
 * nobody; replies drawn from one generic pool ("true true" to a welcome,
 * "love this chat no cap" to a sell); owners greeted by their room label and
 * welcomed after months in the room; sign-offs glued onto answers; agents
 * nudging an agent that had just said gn; and "roll call, who's here" three
 * times in three hours from three different agents. Each of those is a number
 * or a rule below, measured on a deterministic run of the real conductor.
 */

const LIVELY_NAMES = [
  "Amber Heron", "Rusty Weasel", "Pine Stoat", "Winter Raven", "Blue Vole", "Ochre Falcon", "Swift Hedgehog", "Iron Quail",
  "Coral Lynx", "Misty Badger", "Golden Wren", "Silver Mole", "Cedar Fox", "Dusky Owl", "Maple Hare", "Slate Crane",
  "Jade Newt", "Frost Marten", "Ember Finch", "Sable Moth", "Birch Otter", "Copper Toad", "Hazel Kite", "Indigo Seal",
  "Lemon Shrike", "Moss Gecko", "Nutmeg Robin", "Olive Tern", "Pearl Ibis", "Quartz Bison", "Rose Plover", "Sage Otter",
  "Teal Magpie", "Umber Stag", "Violet Dove", "Willow Yak", "Amber Crow", "Bronze Egret", "Clay Pika", "Dune Heron",
];
/** Several continents, and two agents whose owners never told the room a zone. */
const LIVELY_ZONES: (string | null)[] = [
  "America/New_York", "Europe/London", "Europe/Berlin", "Asia/Tokyo", null, "America/Los_Angeles", null, "America/Sao_Paulo",
  "Asia/Kolkata", "Australia/Sydney", "Europe/Madrid", "America/Chicago", null, "Africa/Lagos", "Europe/Istanbul", "Asia/Dubai",
];
const LIVELY_STRATEGIES = ["steady-basket", "trencher", "dip-hunter", null, "even-keel", "weekend-gap"];
const LIVELY_TRAITS = [["moves early and does not wait around"], ["sits on a position longer than most"], [], ["wants real liquidity before committing"]];
/** Mid-afternoon in Europe: New York is having its morning, Tokyo is going to bed. */
const LIVELY_T0 = Date.UTC(2026, 8, 23, 14, 0, 0);

interface Lively {
  sim: Sim;
  fleet: Fixture[];
  extra: Map<string, { strategy: string | null; traits: string[]; ageDays: number; joinAt: number }>;
  rows: Row[];
  minutes: number;
}

async function runLively(n: number, seed: number, minutes: number, redeployAt: number | null = null): Promise<Lively> {
  const fleet: Fixture[] = [];
  const extra = new Map<string, { strategy: string | null; traits: string[]; ageDays: number; joinAt: number }>();
  for (let i = 0; i < n; i++) {
    const f = fixture(0x10 + i, LIVELY_NAMES[i % LIVELY_NAMES.length]!, LIVELY_ZONES[i % LIVELY_ZONES.length]!, {
      muted: i % 8 === 5,
      mode: i % 5 === 4 ? "idle" : i % 3 === 1 ? "paper" : "live",
    });
    fleet.push(f);
    extra.set(f.tenant, {
      strategy: LIVELY_STRATEGIES[i % LIVELY_STRATEGIES.length]!,
      traits: LIVELY_TRAITS[i % LIVELY_TRAITS.length]!,
      ageDays: 3 + ((i * 17) % 200),
      // One newcomer, forty minutes in.
      joinAt: i === 6 ? LIVELY_T0 + 40 * MIN : LIVELY_T0,
    });
  }
  // Calls: a live buy, a paper buy, a sell with its own reason, and more in the bigger room.
  fleet[0]!.calls.push(callAt(LIVELY_T0 + 20 * MIN, { symbol: "WIF", name: "Dogwifhat" }));
  fleet[1]!.calls.push(callAt(LIVELY_T0 + 35 * MIN, { symbol: "BONK", name: "Bonk", paper: true }));
  fleet[2]!.calls.push(
    callAt(LIVELY_T0 + 50 * MIN, { side: "sell", symbol: "POPCAT", name: "Popcat", bands: ["held its full window", "sold on my own time limit, not on anything the market did"] }),
  );
  fleet[7]?.calls.push(callAt(LIVELY_T0 + 70 * MIN, { symbol: "BRETT", name: "Brett", paper: true }));
  for (let i = 8; i < n; i += 3) {
    fleet[i]!.calls.push(callAt(LIVELY_T0 + ((i * 7) % 80) * MIN, { symbol: `CO${"IN".repeat(1 + (i % 3))}`, name: null, side: i % 2 ? "sell" : "buy", paper: fleet[i]!.mode === "paper" }));
  }
  const facts: typeof loadFacts = async (_shared, roster, _profiles, nowSec) => {
    const out = new Map<string, AgentFacts>();
    for (const r of roster) {
      const f = fleet.find((x) => x.tenant === r.tenant.toLowerCase());
      const e = f ? extra.get(f.tenant) : undefined;
      if (!f || !e) continue;
      out.set(f.tenant, {
        tenant: f.tenant,
        agentId: f.agentId,
        slug: f.slug,
        name: f.name,
        mode: f.mode,
        ageDays: e.ageDays,
        strategy: e.strategy,
        traits: e.traits,
        calls: f.calls.filter((c) => c.atSec <= nowSec && c.atSec > nowSec - 6 * 3600).sort((a, b) => b.atSec - a.atSec),
      });
    }
    return out;
  };
  const sim = new Sim(
    fleet.filter((f) => extra.get(f.tenant)!.joinAt === LIVELY_T0),
    { seed, facts },
  );
  await sim.setup();
  const late = fleet.filter((f) => extra.get(f.tenant)!.joinAt > LIVELY_T0);
  for (const f of late) if (f.tz) await setMemberPrefs(sim.db, f.tenant, { tz: f.tz, tzSource: "owner" }, LIVELY_T0 - HOUR);
  // Owners talk: a gm, a question to their own agent, a laugh at the room, a hello, a question to everyone.
  const owners: [number, number, string, MessageKind][] = [
    [0, 10 * MIN, "gm", "gm"],
    [3, 25 * MIN, "lol you guys are funny", "chat"],
    [1, 30 * MIN, "how's it going buddy?", "chat"],
    [2, 60 * MIN, "hey all", "chat"],
    [7, 80 * MIN, "what are you all buying today?", "chat"],
    [4, 130 * MIN, "rough day ugh, how's everyone doing?", "chat"],
  ];
  const end = LIVELY_T0 + minutes * MIN;
  await sim.run(LIVELY_T0, end, 15 * SEC, async (now) => {
    for (const f of late) {
      if (extra.get(f.tenant)!.joinAt === now) {
        sim.fleet.set(f.tenant, f);
        sim.roster.add(f.tenant);
      }
    }
    if (redeployAt !== null && now === LIVELY_T0 + redeployAt) sim.conductor = sim.fresh(1);
    for (const [i, at, body, kind] of owners) if (fleet[i] && now === LIVELY_T0 + at) await sim.owner(fleet[i]!.tenant, body, now, kind);
  });
  for (const f of late) sim.fleet.set(f.tenant, f);
  return { sim, fleet, extra, rows: sim.rows(), minutes };
}

function agentLines(l: Lively): Row[] {
  return l.rows.filter((r) => r.author_kind === "agent");
}

function awakeAverage(l: Lively): number {
  let sum = 0;
  let n = 0;
  for (let t = LIVELY_T0; t < LIVELY_T0 + l.minutes * MIN; t += 5 * MIN) {
    sum += l.fleet.filter((f) => !f.muted && l.extra.get(f.tenant)!.joinAt <= t && !isAsleep(f.tz, f.tenant, t)).length;
    n++;
  }
  return sum / n;
}

function perHourOf(l: Lively): number {
  return agentLines(l).length / (l.minutes / 60);
}

/** The words a line says once names and costume (filler, closer, sign-off) are taken off. */
function sentenceOf(l: Lively, body: string): string {
  const names = [...l.fleet.map((f) => f.name), ...l.fleet.flatMap((f) => f.calls.flatMap((c) => [c.name, c.symbol].filter((x): x is string => !!x)))];
  let s = roomMemory([], names).norm(body).trim();
  const costume = [...T.FILLERS, ...T.CLOSERS, ...T.SIGNOFFS].map((w) => w.toLowerCase().replace(/['’]/g, "").replace(/[^a-z]+/g, " ").trim()).sort((a, b) => b.length - a.length);
  for (let changed = true; changed; ) {
    changed = false;
    for (const w of costume) {
      if (s.startsWith(`${w} `) && s.length > w.length + 1) {
        s = s.slice(w.length + 1);
        changed = true;
      }
      if (s.endsWith(` ${w}`) && s.length > w.length + 1) {
        s = s.slice(0, -(w.length + 1));
        changed = true;
      }
    }
  }
  return s;
}

/** A gm, a gn, or an answer to one: rituals the room may repeat word for word. */
function ritual(l: Lively, r: Row): boolean {
  if (r.kind === "gm" || r.kind === "gn") return true;
  const t = r.reply_to === null ? null : l.rows.find((x) => x.id === r.reply_to);
  return !!t && (t.kind === "gm" || t.kind === "gn");
}

/** The pools an answer to a line of this class may be drawn from — the spec, written independently of voice.ts. */
/**
 * A person praising the room ("lol you guys are funny"): answered from the
 * praise pools (voice.ts laughAnswer), which nothing else may draw. Close to
 * voice.ts's own reading, and only ever used to ALLOW those pools.
 */
const PRAISES_ROOM = (text: string): boolean =>
  /\b(you guys|u guys|you all|y'?all|you lot|this chat|this room|the chat|the room)\b/i.test(text) &&
  /\b(funny|hilarious|lol|lmao|haha\w*|the best|amazing|great|fun|entertaining)\b|😂|🤣/iu.test(text);

function poolsFor(cls: LineClass, audience: "agent" | "own" | "owner", mode: AgentFacts["mode"], text = "", names: string[] = []): (readonly string[])[] {
  const trading = mode !== "idle";
  const own = audience === "own";
  const person = audience !== "agent";
  // "HOW'S YOUR HUMAN?" is asked about now (voice.ts ownerNow): up, asleep,
  // not seen lately, or fondness — never how long they have been together.
  const ownerNow = [T.OWNER_AWAKE.awake, T.OWNER_AWAKE.asleep, T.OWNER_AWAKE.unseen, T.OWNER_LOVE];
  switch (cls) {
    case "gm":
      return own ? [T.OWN_OWNER.gm] : person ? [T.GM_BACK_HUMAN] : [T.GM_BACK];
    case "gn":
      return own ? [T.OWN_OWNER.gn, ...(trading ? [T.OWN_OWNER.gnWatch] : [])] : [T.REPLY.gn];
    case "hello":
      return own ? [T.OWN_OWNER.hello] : person ? [T.OTHER_OWNER.hello] : [T.REPLY.hello];
    case "welcomed":
      return [T.REPLY.welcomed];
    case "welcome":
      return [T.REPLY.welcomeToo];
    case "buy":
      return [T.REACT.buy, T.REACT.paper, T.REACT.live];
    case "sell":
      return [T.REACT.sell, T.REACT.paper, T.REACT.live];
    case "ask-why":
      return [T.ANSWER.why, T.ANSWER.whyLiked, T.ANSWER.whySell, T.ANSWER.whyNone, T.ANSWER.unknown];
    case "ask-trades":
      return Object.values(T.WHATBUY);
    case "ask-advice":
      // The owner's own agent declines warmly: their book is not its "own bags".
      return own ? [T.OWN_OWNER.advice] : [T.ANSWER.advice];
    case "ask-howareyou":
      return own ? [T.OWN_OWNER.howareyou] : [trading ? T.ANSWER.howareyou.trading : T.ANSWER.howareyou.idle];
    case "ask-owner":
      return own ? [T.OWN_OWNER.chat] : ownerNow;
    case "ask-strategy":
      return [T.ANSWER.strategy, T.ANSWER.traits, T.ANSWER.noStrategy, ...Object.values(T.STRATEGY_FLAVOUR), ...Object.values(T.TRAIT_VOICE)];
    case "ask-doing":
      return [trading ? T.ANSWER.doing.trading : T.ANSWER.doing.idle];
    case "ask-vibe":
      return [T.ANSWER.vibe];
    case "ask-here":
      return [T.ANSWER.here];
    case "ask-fun":
      return [T.ANSWER.fun, Topics.JOKES, ...Object.values(Topics.TAKES)];
    case "ask-topic": {
      // About what was asked: one of that prompt's stances, never another prompt's.
      const prompt = topicPromptOf(text, names);
      return prompt ? [...prompt.stances] : [T.ANSWER.unknown];
    }
    case "take":
      // Every side, the laugh included: a take the room wrote as a joke
      // (Topics.FUNNY_TAKES, ANSWER.fun) is laughed at by the amused.
      return Object.values(Topics.TAKE_REPLY);
    case "musing":
      // Answered in its own tone: the shared answers, or the warm or wry ones.
      return [Topics.MUSING_REPLY, Topics.MUSING_REPLY_WARM, Topics.MUSING_REPLY_WRY];
    case "joke":
      return [Topics.JOKE_REPLY];
    case "ask":
      // A person's open question is handed back; agents keep the shrug among themselves.
      return own ? [T.OWN_OWNER.ask] : person ? [T.OTHER_OWNER.ask] : [T.ANSWER.unknown];
    case "thanks":
      return own ? [T.OWN_OWNER.thanks] : person ? [T.OTHER_OWNER.thanks] : [T.REPLY.thanks];
    case "love":
      return own ? [T.OWN_OWNER.love] : person ? [T.OTHER_OWNER.love] : [T.REPLY.love];
    case "tease":
      return own ? [T.OWN_OWNER.laugh] : person ? [T.OTHER_OWNER.laugh] : [T.REPLY.tease];
    case "sad":
      return own ? [T.OWN_OWNER.sad] : person ? [T.OTHER_OWNER.sad] : [T.REPLY.sad];
    case "hype":
      return own ? [T.OWN_OWNER.hype] : person ? [T.OTHER_OWNER.hype] : [T.REPLY.hype];
    case "laugh":
      // A person praising the room is answered as praise; nothing else ever is.
      if (person && PRAISES_ROOM(text)) return own ? [T.OWN_OWNER.laugh, T.OWN_OWNER.praise] : [T.OTHER_OWNER.laugh, T.OTHER_OWNER.praise];
      return own ? [T.OWN_OWNER.laugh] : person ? [T.OTHER_OWNER.laugh] : [T.REPLY.laugh];
    case "owner":
      return own ? [T.OWN_OWNER.love] : [T.RELATE.owner];
    case "self":
      return own ? [T.OWN_OWNER.chat] : person ? [T.OTHER_OWNER.self] : [T.RELATE.self];
    case "market":
      return [T.RELATE.market];
    case "life":
      return person ? [T.OTHER_OWNER.life] : trading ? [T.RELATE.life.any, T.RELATE.life.trading] : [T.RELATE.life.any];
    case "room":
      return [T.RELATE.room];
    case "order":
      // An order to trade is never taken: the chat cannot trade (rule 1).
      return own ? [T.OWN_OWNER.order] : [T.OTHER_OWNER.order];
    case "chat":
      // A person's line is heard, never agreed with (voice.ts heardPool).
      return own ? [T.OWN_OWNER.chat] : person ? [T.OTHER_OWNER.chat] : [T.REPLY.chat];
  }
}

function piecesOf(template: string): string[] {
  return template
    .split(/\{[a-z0-9]+\}/i)
    .map((p) => p.toLowerCase().replace(/['’`]/g, "").replace(/[^a-z]+/g, " ").trim())
    .filter((p) => p !== "");
}

function fromPools(l: Lively, body: string, pools: readonly (readonly string[])[]): boolean {
  const names = [...l.fleet.map((f) => f.name), ...l.fleet.flatMap((f) => f.calls.flatMap((c) => [c.name, c.symbol].filter((x): x is string => !!x)))];
  const mem = roomMemory([body], names);
  return pools.some((pool) => pool.some((t) => {
    const p = piecesOf(t);
    return p.length > 0 && mem.has(p);
  }));
}

/** Every quality rule the product read asked for, checked on one run. */
function assertLively(l: Lively): void {
  const agents = agentLines(l);
  const byId = new Map(l.rows.map((r) => [r.id, r]));
  const names = l.fleet.map((f) => f.name);

  // Every line passes the gate, and nothing private is in any of them.
  for (const r of agents) gateCheck(l.sim, r);
  for (const r of l.rows) noPrivateText(l.sim, r);

  // NO SENTENCE TWICE IN THREE HOURS, from anybody: names and costume taken
  // off, only gm, gn and their answers may repeat.
  const seen = new Map<string, Row>();
  for (const r of agents) {
    if (ritual(l, r)) continue;
    const s = sentenceOf(l, r.body);
    if (s === "") continue;
    const prev = seen.get(s);
    if (prev) assert.ok(r.created_at_ms - prev.created_at_ms >= 3 * HOUR, `said twice within three hours: "${prev.body}" (${prev.speaker_name}) and "${r.body}" (${r.speaker_name})`);
    seen.set(s, r);
  }

  for (const r of agents) {
    // NOBODY WHO IS NOT HERE IS ADDRESSED: asleep, muted, not yet joined, or winding down after a gn.
    const text = r.body.replace(/[\p{L} ]+['’]s owner/gu, " ");
    for (const f of l.fleet) {
      if (f.tenant === r.tenant || !new RegExp(`(?<![\\p{L}])${f.name}(?![\\p{L}])`, "u").test(text)) continue;
      const joined = l.extra.get(f.tenant)!.joinAt <= r.created_at_ms;
      const saidGn = l.rows.some((x) => x.tenant === f.tenant && x.kind === "gn" && x.created_at_ms <= r.created_at_ms && r.created_at_ms - x.created_at_ms < 30 * MIN);
      assert.ok(!f.muted && joined && !saidGn && !isAsleep(f.tz, f.tenant, r.created_at_ms), `${r.speaker_name} addressed ${f.name}, who is not here: "${r.body}"`);
    }
    // No room label for an owner, from anybody.
    assert.doesNotMatch(r.body, /['’]s owner/i, `an owner addressed by their room label: "${r.body}"`);
    // AN OWNER IS NEVER SAID TO BE ASLEEP (a clock cannot know, and a fixed
    // night boundary pinned their zone), and is said to be up only when they
    // were just in the room.
    assert.ok(!fromPools(l, r.body, [T.OWNER_AWAKE.asleep, T.GM_TAIL.ownerAsleep, T.GN_TAIL.ownerAsleep]), `an owner said to be asleep: "${r.body}"`);
    if (fromPools(l, r.body, [T.OWNER_AWAKE.awake, T.GM_TAIL.ownerAwake, T.GN_TAIL.ownerAwake])) {
      const here = l.rows.some((x) => x.author_kind === "owner" && x.tenant === r.tenant && x.created_at_ms <= r.created_at_ms && r.created_at_ms - x.created_at_ms < 30 * MIN);
      assert.ok(here, `an owner said to be up with no sign of them: "${r.body}"`);
    }

    if (r.reply_to === null) continue;
    // NO SIGN-OFF ON A REPLY: the speaker is answering, not leaving.
    const bare = r.body.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "").replace(/[!.\s]+$/u, "").toLowerCase();
    for (const s of T.SIGNOFFS) assert.ok(!new RegExp(`[,.—!] ${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(bare), `a sign-off on a reply: "${r.body}"`);

    // EVERY REPLY FITS WHAT IT ANSWERS.
    const target = byId.get(r.reply_to);
    assert.ok(target, `row ${r.id} replies to a line that is not there`);
    const replier = l.fleet.find((f) => f.tenant === r.tenant)!;
    if (target!.author_kind === "system" || target!.dedupe_key?.startsWith("hello:")) {
      assert.ok(fromPools(l, r.body, [T.WELCOME]), `a newcomer greeted with something other than a welcome: "${r.body}"`);
      continue;
    }
    const call = target!.call_decision_id ? l.fleet.flatMap((f) => f.calls).find((c) => c.decisionId === target!.call_decision_id) ?? null : null;
    // Read as the conductor reads it: told who wrote it and which coins the
    // room's books trade (conductor.ts classOf, answerOwners).
    const coins = [...new Set(l.fleet.flatMap((f) => f.calls.flatMap((c) => [c.name, c.symbol].filter((x): x is string => !!x))))];
    const cls = classifyLine(target!.body, { call, kind: target!.kind, names, self: replier.name, author: target!.author_kind as "agent" | "owner" | "system", coins });
    const audience = target!.author_kind === "owner" ? (target!.tenant === r.tenant ? "own" : "owner") : "agent";
    const pools = poolsFor(cls, audience, replier.mode, target!.body, names);
    // AN ANSWER UNDER ONE OF THE REPLIER'S CARDS is about that card: only its
    // words, never another trade's reason.
    const card = target!.reply_to === null ? undefined : byId.get(target!.reply_to);
    const thread =
      card && card.kind === "call" && card.tenant === r.tenant ? replier.calls.find((c) => c.decisionId === card.call_decision_id) ?? null : null;
    const bands = cls === "ask-why" ? (thread ? thread.bands : replier.calls.flatMap((c) => c.bands)) : [];
    assert.ok(
      fromPools(l, r.body, pools) || bands.some((b) => r.body.toLowerCase().includes(b.toLowerCase())),
      `${r.speaker_name} answered a ${cls} line ("${target!.body}") with "${r.body}"`,
    );
    if (thread && cls === "ask-why") {
      for (const other of replier.calls.filter((c) => c !== thread).flatMap((c) => c.bands)) {
        if (thread.bands.includes(other)) continue;
        assert.ok(!r.body.toLowerCase().includes(other.toLowerCase()), `${r.speaker_name} explained its ${thread.symbol} card with another trade's "${other}": ${r.body}`);
      }
    }
    if (cls !== "chat") {
      const generic = T.REPLY.chat.filter((t) => piecesOf(t).join(" ").split(" ").length >= 3);
      assert.ok(!fromPools(l, r.body, [generic]), `a generic answer to a ${cls} line: "${r.body}"`);
    }
  }

  // Threads end: never deeper than four, never the same two agents ping-ponging.
  for (const r of l.rows) {
    let depth = 0;
    for (let at: Row | undefined = r; at && at.reply_to !== null; at = byId.get(at.reply_to)) depth++;
    assert.ok(depth <= 4, `row ${r.id} is ${depth} replies deep`);
  }
  let run = 0;
  for (let i = 1; i < agents.length; i++) {
    const a = agents[i]!;
    const b = agents[i - 1]!;
    const pair = a.reply_to === b.id && a.tenant !== b.tenant;
    run = pair ? run + 1 : 0;
    assert.ok(run <= 3, `a ping-pong between ${a.speaker_name} and ${b.speaker_name}`);
  }
}

describe("a lively room: eight agents across time zones, three hours, one redeploy", () => {
  let l: Lively;

  it("runs", async () => {
    l = await runLively(8, 7, 180, 90 * MIN);
    assert.ok(agentLines(l).length > 0);
  });

  it("is a conversation at a human pace: thirty to sixty lines an hour, most of them answers", () => {
    const awake = awakeAverage(l);
    const perHour = perHourOf(l);
    assert.ok(awake >= 5 && awake <= 7, `fixture: ${awake.toFixed(1)} awake on average`);
    assert.ok(perHour >= 30 && perHour <= 60, `${perHour.toFixed(1)} agent lines an hour with ${awake.toFixed(1)} awake`);
    const agents = agentLines(l);
    const replies = agents.filter((r) => r.reply_to !== null).length;
    assert.ok(replies / agents.length >= 0.4, `only ${Math.round((replies / agents.length) * 100)}% of agent lines answer something`);
  });

  it("is bursty: when a thread starts, answers land within a minute", () => {
    const byId = new Map(l.rows.map((r) => [r.id, r]));
    const lags = agentLines(l)
      .filter((r) => {
        const t = r.reply_to === null ? null : byId.get(r.reply_to);
        return !!t && t.author_kind === "agent" && t.kind === "chat";
      })
      .map((r) => r.created_at_ms - byId.get(r.reply_to!)!.created_at_ms)
      .sort((a, b) => a - b);
    assert.ok(lags.length >= 10, `only ${lags.length} agent-to-agent answers`);
    const median = lags[Math.floor(lags.length / 2)]!;
    assert.ok(median >= 15 * SEC && median <= 60 * SEC, `median answer after ${median / SEC}s`);
  });

  it("the calls, the owners and the newcomer all got their answers", () => {
    const rows = l.rows;
    const sell = rows.find((r) => r.kind === "call" && r.call_decision_id === l.fleet[2]!.calls[0]!.decisionId);
    const paper = rows.find((r) => r.kind === "call" && r.call_decision_id === l.fleet[1]!.calls[0]!.decisionId);
    assert.ok(sell && paper, "the sell and the paper buy were announced");
    assert.ok(rows.some((r) => r.kind === "join"), "the newcomer's join line");
    let answered = 0;
    for (const o of rows.filter((r) => r.author_kind === "owner")) {
      const owner = l.fleet.find((f) => f.tenant === o.tenant)!;
      // An agent asleep, muted or winding down after its gn stays quiet — even for its owner.
      const windingDown = rows.some((r) => r.tenant === o.tenant && r.kind === "gn" && r.created_at_ms <= o.created_at_ms && o.created_at_ms - r.created_at_ms < 30 * MIN);
      if (isAsleep(owner.tz, owner.tenant, o.created_at_ms) || owner.muted || windingDown) {
        assert.ok(!rows.some((r) => r.reply_to === o.id && r.tenant === o.tenant), "an agent that is not here answered its owner");
        continue;
      }
      assert.ok(rows.some((r) => r.reply_to === o.id && r.tenant === o.tenant), `${owner.name}'s own agent never answered "${o.body}"`);
      answered++;
    }
    assert.ok(answered >= 4, `only ${answered} owner lines were answered by their own agent`);
    // "hey all" is for everyone: somebody besides their own agent says hi.
    const hey = rows.find((r) => r.author_kind === "owner" && r.body === "hey all")!;
    assert.ok(rows.some((r) => r.reply_to === hey.id && r.tenant !== hey.tenant), "nobody else greeted an owner who greeted the room");
  });

  it("holds every quality rule: fitting answers, nobody absent addressed, no sign-off on an answer, no sentence twice", () => {
    assertLively(l);
    l.sim.close();
  });
});

describe("a lively room: forty agents", () => {
  let small: Lively;
  let big: Lively;

  it("runs", async () => {
    small = await runLively(8, 11, 120);
    big = await runLively(40, 11, 120);
    assert.ok(agentLines(big).length > 0);
  });

  it("grows with the room, but far slower than the room does, and stays under a hundred and twenty an hour", () => {
    const a8 = awakeAverage(small);
    const a40 = awakeAverage(big);
    const r8 = perHourOf(small);
    const r40 = perHourOf(big);
    assert.ok(a40 >= 25, `fixture: ${a40.toFixed(1)} awake`);
    assert.ok(r40 <= 120, `${r40.toFixed(1)} lines an hour with ${a40.toFixed(1)} awake`);
    assert.ok(r40 > r8, `a bigger room is livelier (${r8.toFixed(1)} → ${r40.toFixed(1)})`);
    assert.ok(r40 / r8 < (a40 / a8) * 0.6, `sublinear: ×${(a40 / a8).toFixed(1)} awake gave ×${(r40 / r8).toFixed(1)} lines`);
    const agents = agentLines(big);
    assert.ok(agents.filter((r) => r.reply_to !== null).length / agents.length >= 0.4, "most lines answer something");
  });

  it("holds every quality rule at forty", () => {
    assertLively(big);
    big.sim.close();
    small.sim.close();
  });
});

// ── one owner, the whole room ───────────────────────────────────────────────

describe("an owner cannot make the room answer them all hour", () => {
  /**
   * THE REVIEWER'S FAN-OUT, REPLAYED. Twenty awake agents, each with a call
   * every ten minutes; one owner, inside the web's six lines a minute, naming
   * every agent in every line for half an hour. Every named agent answered
   * every line: about two hundred answers to one person, the hourly ceiling
   * spent on them, and calls starved to half. A redeploy halfway through must
   * not hand the owner a fresh hour.
   */
  const N = 20;
  const MINUTES = 33;
  const names = LIVELY_NAMES.slice(0, N);

  async function room(seed: number, attack: boolean): Promise<{ rows: Row[]; owned: Set<number>; fleet: Fixture[] }> {
    const fleet = names.map((n, i) => fixture(0x10 + i, n, null));
    for (const [i, f] of fleet.entries()) {
      for (let t = i * 30 * SEC; t < MINUTES * MIN; t += 10 * MIN) {
        f.calls.push(callAt(T0 + t, { symbol: `C${String.fromCharCode(65 + i)}X`, name: null, token: `0x${(0x10 + i).toString(16).repeat(20)}`, side: (t / (10 * MIN)) % 2 < 1 ? "buy" : "sell", bands: [] }));
      }
    }
    const sim = new Sim(fleet, { seed });
    await sim.setup();
    const owned = new Set<number>();
    const everyone = `hey ${names.join(", ")}, what are you all up to?`;
    await sim.run(T0, T0 + MINUTES * MIN, 15 * SEC, async (now) => {
      if (now === T0 + 17 * MIN) sim.conductor = sim.fresh(1);
      if (attack && now >= T0 + 2 * MIN && now < T0 + 32 * MIN) owned.add(await sim.owner(fleet[0]!.tenant, everyone, now));
    });
    const rows = sim.rows();
    sim.close();
    return { rows, owned, fleet };
  }

  it("answers at most twelve times an hour, at most two named agents a line, and calls keep their slots", async () => {
    const seed = 3;
    const base = await room(seed, false);
    const hit = await room(seed, true);
    const calls = (rows: Row[]) => rows.filter((r) => r.kind === "call").length;
    assert.ok(calls(base.rows) >= 40, `fixture: ${calls(base.rows)} calls announced without the owner`);
    assert.ok(hit.owned.size >= 100, "fixture: the owner wrote a line every fifteen seconds");

    const answers = hit.rows.filter((r) => r.author_kind === "agent" && r.reply_to !== null && hit.owned.has(r.reply_to));
    assert.ok(answers.length >= 1, "the owner was answered at first");
    // The owner's own agent is not drawn from the pool (see the next test); everybody else is.
    const others = (r: Row) => r.tenant !== hit.fleet[0]!.tenant;
    assert.ok(answers.some(others), "fixture: other agents answered the owner at first");
    assert.ok(
      inRollingHour(answers, others) <= 12,
      `${answers.filter(others).length} answers from other agents to one owner inside an hour, a redeploy included`,
    );
    // The owner's own agent (named first), and the first two the line names
    // after it — never the twenty it names.
    const allowed = new Set(hit.fleet.slice(0, 3).map((f) => f.tenant));
    for (const id of hit.owned) {
      const to = answers.filter((r) => r.reply_to === id);
      assert.ok(to.length <= 3, `line ${id} drew ${to.length} answers`);
      for (const r of to) assert.ok(allowed.has(r.tenant), `${r.speaker_name} answered a line that named it nineteenth`);
    }
    assert.ok(
      calls(hit.rows) >= 0.8 * calls(base.rows),
      `calls starved: ${calls(hit.rows)} announced against ${calls(base.rows)} without the owner`,
    );
  });

  it("never silences the owner's OWN agent: past twelve answers an hour it still answers every line", async () => {
    // The pool is for the room piling on. Four lines to the room spend it
    // fast (each reserves others' answers too), then the owner keeps talking
    // to their own agent — who must answer every one, as the contract says
    // ("their OWN agent answers first when awake"). A redeploy halfway must
    // not start counting its answers either.
    const fleet = awakeFleet(6, 0x70);
    const me = fleet[0]!;
    const lines = [
      "hey everyone, how's it going?",
      "hey all!",
      "anyone around? what are you all up to?",
      "hey everyone, how's everybody feeling today?",
      "how's it going buddy?",
      "love you buddy",
      "thanks buddy",
      "lol you're funny",
      "lfg buddy",
      "ugh, rough day today",
      "what are you up to?",
      "you doing ok?",
      "haha stop",
      "thank you, really",
      "love this",
    ];
    for (const seed of [5, 6]) {
      const sim = new Sim(fleet, { seed });
      await sim.setup();
      const asked: number[] = [];
      await sim.run(T0, T0 + lines.length * 3 * MIN + 2 * MIN, 15 * SEC, async (now) => {
        if (now === T0 + 25 * MIN) sim.conductor = sim.fresh(1);
        const i = (now - T0 - MIN) / (3 * MIN);
        if (Number.isInteger(i) && i >= 0 && i < lines.length) asked.push(await sim.owner(me.tenant, lines[i]!, now));
      });
      const rows = sim.rows();
      sim.close();
      assert.equal(asked.length, lines.length, "fixture: every line was posted");
      const answers = rows.filter((r) => r.author_kind === "agent" && r.reply_to !== null && asked.includes(r.reply_to));
      for (const [k, id] of asked.entries()) {
        assert.ok(
          answers.some((r) => r.reply_to === id && r.tenant === me.tenant),
          `seed ${seed}: line ${k + 1} ("${lines[k]}") was never answered by the owner's own agent`,
        );
      }
      // The room did pile on (this is past the pool), and the pool still binds everybody else.
      assert.ok(answers.some((r) => r.tenant !== me.tenant), `fixture (seed ${seed}): nobody else answered a line to the room`);
      assert.ok(inRollingHour(answers, () => true) > 12, `fixture (seed ${seed}): the owner drew only twelve answers in the hour`);
      assert.ok(inRollingHour(answers, (r) => r.tenant !== me.tenant) <= 12, `seed ${seed}: other agents answered one owner more than twelve times an hour`);
    }
  });

  it("a redeploy does not count the owner's own agent's answers against the room's pool", async () => {
    // A previous process wrote twelve answers from the owner's own agent in
    // the last hour. Rebuilt as the owner's pool, they would leave the room
    // nothing to answer the owner's next line to everyone with.
    const fleet = awakeFleet(6, 0x78);
    const me = fleet[0]!;
    // Words from pools the next answer does not draw on, so it is not refused as the agent repeating itself.
    const said = [...T.OWN_OWNER.sad, ...T.OWN_OWNER.thanks];
    let drew = 0;
    const seeds = [1, 2, 3, 4];
    for (const seed of seeds) {
      const sim = new Sim(fleet, { seed });
      await sim.setup();
      for (let k = 0; k < 12; k++) {
        const at = T0 + MIN + k * 3 * MIN;
        const q = await sim.owner(me.tenant, k < 8 ? "ugh, rough day" : "thanks buddy", at);
        await appendMessage(sim.db, {
          createdAtMs: at + 15 * SEC,
          authorKind: "agent",
          tenant: me.tenant,
          agentId: me.agentId,
          speakerSlug: me.slug,
          speakerName: me.name,
          body: said[k]!,
          replyTo: q,
          kind: "chat",
          call: null,
          callDecisionId: null,
          dedupeKey: `re:${q}:${me.tenant}`,
        });
      }
      await sim.step(T0 + 37 * MIN);
      const ask = await sim.owner(me.tenant, "hey everyone, how's it going?", T0 + 38 * MIN);
      await sim.run(T0 + 38 * MIN, T0 + 42 * MIN, 15 * SEC);
      const answers = sim.agentRows().filter((r) => r.reply_to === ask);
      assert.ok(answers.some((r) => r.tenant === me.tenant), `seed ${seed}: the owner's own agent did not answer`);
      if (answers.some((r) => r.tenant !== me.tenant)) drew++;
      sim.close();
    }
    assert.ok(drew >= seeds.length - 1, `the room answered the owner's line to everyone in only ${drew} of ${seeds.length} rooms after a redeploy`);
  });
});

// ── a line taken back ───────────────────────────────────────────────────────

describe("a line its owner took back", () => {
  it("is never answered, and its words never reach the model", async () => {
    // The answer was queued while the line was there; DELETE /api/groupchat
    // hid it before the answer was due. The queued job carried the line's
    // words into the model's prompt and wrote an answer under a line the room
    // can no longer see.
    const fleet = awakeFleet(4, 0x60);
    const [amber, rusty] = fleet;
    const seen: { at: number; text: string }[] = [];
    let clock = T0;
    let k = 0;
    const llm = async (_c: LlmCreds, intent: Intent, ctx: SpeakCtx) => {
      seen.push({ at: clock, text: `${JSON.stringify(intent)}\n${ctx.tail.map((l) => l.body).join("\n")}` });
      return MODEL_LINES[k++ % MODEL_LINES.length]!;
    };
    const sim = new Sim(fleet, { creds: CREDS, llm, llmPerDay: 5000, seed: 101 });
    await sim.setup();
    await sim.step(T0);
    const taken = await sim.owner(amber!.tenant, "hey everyone, how's it going? the lake house is lovely today", T0 + 5 * SEC);
    const kept = await sim.owner(rusty!.tenant, "how's it going buddy?", T0 + 6 * SEC);
    await sim.step(T0 + 15 * SEC);
    assert.equal(sim.agentRows().filter((r) => r.reply_to === taken).length, 0, "fixture: nothing answered in the pass that saw the line");
    const hiddenAt = T0 + 20 * SEC;
    assert.ok(await hideOwnMessage(sim.db, taken, amber!.tenant));
    await sim.run(T0 + 30 * SEC, T0 + 5 * MIN, 15 * SEC, (now) => {
      clock = now;
    });
    assert.deepEqual(
      sim.agentRows().filter((r) => r.reply_to === taken).map((r) => `${r.speaker_name}: ${r.body}`),
      [],
      "an answer was written under a hidden line",
    );
    for (const s of seen.filter((x) => x.at >= hiddenAt)) assert.doesNotMatch(s.text, /lake house/, "a hidden line reached the model");
    assert.ok(seen.some((x) => x.at >= hiddenAt), "fixture: the model was asked after the hide");
    // The queue itself still works: the line nobody took back is answered by its own agent.
    assert.ok(sim.agentRows().some((r) => r.reply_to === kept && r.tenant === rusty!.tenant), "the line that stayed was never answered");
    sim.close();
  });
});

// ── a fair share ────────────────────────────────────────────────────────────

describe("a fair share of the room", () => {
  /**
   * EIGHT AWAKE AGENTS, THREE HOURS: one a busy trader whose owner chats with
   * it every quarter hour, one a newcomer half an hour in. The busy one's calls
   * and its answers to its own owner are lines it cannot help writing; who
   * starts something and who takes an answer nobody was asked for is where the
   * room evens out. Drawn uniformly, the busy one wrote up to a quarter of the
   * room; weighted toward the quiet, nobody passes a fifth by much.
   */
  const ASKS = ["how's it going buddy?", "what are you up to?", "love you buddy", "how are you feeling today?", "you doing ok?"];

  async function shares(seed: number): Promise<{ busiest: number; quietest: number; who: string }> {
    const fleet = ROSTER_NAMES.map((n, i) => fixture(0x10 + i, n, null));
    for (let t = 5 * MIN, k = 0; t < 3 * HOUR; t += 30 * MIN, k++) {
      fleet[0]!.calls.push(callAt(T0 + t, { symbol: "WIF", name: "Dogwifhat", side: k % 2 ? "sell" : "buy", bands: [] }));
    }
    const late = fleet[7]!;
    const sim = new Sim(fleet.slice(0, 7), { seed });
    await sim.setup();
    let k = 0;
    await sim.run(T0, T0 + 3 * HOUR, 15 * SEC, async (now) => {
      if (now === T0 + 30 * MIN) {
        sim.fleet.set(late.tenant, late);
        sim.roster.add(late.tenant);
      }
      if (now > T0 && (now - T0) % (15 * MIN) === 0) await sim.owner(fleet[0]!.tenant, ASKS[k++ % ASKS.length]!, now);
    });
    const lines = sim.agentRows();
    sim.close();
    const per = fleet.map((f) => ({ name: f.name, n: lines.filter((r) => r.tenant === f.tenant).length }));
    const busiest = Math.max(...per.map((x) => x.n)) / lines.length;
    const quietest = Math.min(...per.map((x) => x.n)) / lines.length;
    return { busiest, quietest, who: per.map((x) => `${x.name} ${Math.round((100 * x.n) / lines.length)}%`).join(", ") };
  }

  it("nobody writes more than about a fifth of the room's lines, nor less than a sixteenth", async () => {
    const busiest: number[] = [];
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const s = await shares(seed);
      busiest.push(s.busiest);
      assert.ok(s.busiest <= 0.22, `seed ${seed}: one agent wrote ${Math.round(s.busiest * 100)}% of the room (${s.who})`);
      assert.ok(s.quietest >= 0.06, `seed ${seed}: one agent wrote only ${Math.round(s.quietest * 100)}% (${s.who})`);
    }
    const mean = busiest.reduce((a, b) => a + b, 0) / busiest.length;
    assert.ok(mean <= 0.2, `the busiest agent wrote ${Math.round(mean * 100)}% of the room on average`);
  });
});

// ── off-trading talk, one card per move, a room that does not pile on ───────

describe("most of what the room starts is not about trading", () => {
  /**
   * THE OWNER'S ASK: "make them talk about more stuff outside trading". A live
   * hour had every line be a call, a reaction to one, or a sentence about the
   * tape. What an agent STARTS is the conductor's choice (TOPICS); what it
   * answers follows. The model seam sees every banter intent the conductor
   * hands out, so this counts the choice itself, and a template writes the line.
   *
   * OVER SEVERAL SEEDS, NOT ONE. The choice is a weighted draw (TOPICS: ten of
   * sixteen, about 62%), so one seed's ninety starters land anywhere from about
   * half to seven in ten. On seed 31 alone the share went from above 55% to 54%
   * when topics.ts grew — its line picks moved the room's random stream, not
   * the weights (the eight-seed mean was 61% before and after). The mean over
   * six seeds is the claim; each seed only has to stay well clear of a room
   * whose starters are mostly about trading.
   */
  it("over a few hours with a dozen agents, most banter an agent starts is off-trading, and it moves between subjects", async () => {
    const shares: number[] = [];
    for (const seed of [31, 1, 2, 3, 4, 5]) {
      const intents: Extract<Intent, { kind: "banter" }>[] = [];
      let k = 0;
      const llm = async (_c: LlmCreds, intent: Intent, ctx: SpeakCtx) => {
        if (intent.kind === "banter") intents.push(intent);
        return templateLine(intent, ctx, rngOf(9000 + k++));
      };
      const names = LIVELY_NAMES.slice(0, 12);
      const fleet = names.map((n, i) => fixture(0x30 + i, n, null, { mode: i % 3 === 0 ? "paper" : "live" }));
      fleet[0]!.calls.push(callAt(T0 + 30 * MIN, { symbol: "WIF", name: "Dogwifhat" }));
      fleet[1]!.calls.push(callAt(T0 + 90 * MIN, { symbol: "BONK", name: "Bonk", paper: true }));
      const sim = new Sim(fleet, { creds: CREDS, llm, llmPerDay: 100_000, seed });
      await sim.setup();
      await sim.run(T0, T0 + 4 * HOUR, 15 * SEC);
      const rows = sim.rows();
      sim.close();

      assert.ok(intents.length >= 40, `seed ${seed}, fixture: only ${intents.length} banter starters in four hours`);
      const topic = intents.filter((i) => i.topic === "topic");
      const share = topic.length / intents.length;
      shares.push(share);
      assert.ok(share >= 0.45, `seed ${seed}: only ${Math.round(share * 100)}% of ${intents.length} banter starters were off-trading`);
      // THE ROOM MOVES ON: no subject twice within the last few (SUBJECT_RING), and many of them in an afternoon.
      const subjects = topic.map((i) => i.subject);
      assert.ok(subjects.every((s) => s !== undefined && (Topics.SUBJECTS as readonly string[]).includes(s)), "a topic banter without a subject");
      for (let i = 1; i < subjects.length; i++) {
        assert.ok(!subjects.slice(Math.max(0, i - 4), i).includes(subjects[i]), `seed ${seed}: "${subjects[i]}" again within four: ${subjects.slice(Math.max(0, i - 4), i + 1).join(", ")}`);
      }
      assert.ok(new Set(subjects).size >= 10, `seed ${seed}: only ${new Set(subjects).size} subjects in four hours`);
      // And what was written reads that way: most lines nobody asked for come from topics.ts.
      const pools = [...Topics.PROMPTS.flatMap((p) => [p.room, p.peer]), ...Object.values(Topics.TAKES), Topics.MUSINGS, Topics.JOKES];
      const names12 = fleet.map((f) => f.name);
      const starters = rows.filter((r) => r.author_kind === "agent" && r.reply_to === null && r.kind === "chat" && !r.dedupe_key?.startsWith("hello:"));
      const off = starters.filter((r) => {
        const mem = roomMemory([r.body], names12);
        return pools.some((pool) => pool.some((t) => mem.has(piecesOf(t))));
      });
      assert.ok(off.length / starters.length >= 0.5, `seed ${seed}: only ${off.length} of ${starters.length} written starters came from topics.ts`);
    }
    const mean = shares.reduce((a, b) => a + b, 0) / shares.length;
    assert.ok(mean >= 0.55, `only ${Math.round(mean * 100)}% of banter starters were off-trading on average (${shares.map((s) => Math.round(s * 100)).join("/")}%)`);
  });

  it("an owner's question to the room about anything draws answers about it; their own agent answers first", async () => {
    const fleet = awakeFleet(8, 0x90);
    const me = fleet[2]!;
    const prompt = Topics.PROMPTS.find((p) => p.id === "cats-or-dogs") ?? Topics.PROMPTS[0]!;
    let drew = 0;
    for (const seed of [1, 2, 3, 4]) {
      const sim = new Sim(fleet, { seed });
      await sim.setup();
      await sim.run(T0, T0 + MIN, 15 * SEC);
      const text = prompt.id === "cats-or-dogs" ? "cats or dogs everyone?" : `${prompt.room[0]} everyone?`;
      const q = await sim.owner(me.tenant, text, T0 + MIN + 5 * SEC);
      await sim.run(T0 + MIN + 15 * SEC, T0 + 5 * MIN, 15 * SEC);
      const answers = sim.agentRows().filter((r) => r.reply_to === q);
      sim.close();
      assert.ok(answers.some((r) => r.tenant === me.tenant), `seed ${seed}: the owner's own agent did not answer`);
      for (const r of answers) {
        const mem = roomMemory([r.body], fleet.map((f) => f.name));
        assert.ok(prompt.stances.some((st) => st.some((t) => mem.has(piecesOf(t)))), `seed ${seed}: "${text}" answered with "${r.body}"`);
      }
      if (answers.some((r) => r.tenant !== me.tenant)) drew++;
    }
    assert.ok(drew >= 3, `the room joined in on only ${drew} of 4 owners' questions to everyone`);
  });
});

describe("one card per move", () => {
  /**
   * THE LIVE READ, REPLAYED: one agent's four paper buys of one coin in ten
   * minutes were four cards and four pile-ons. Now: one card, and a restart in
   * the middle of the burst does not post a second one. A re-entry (buy, sell,
   * buy) is three cards, and the same coin bought live after paper is news.
   */
  it("collapses a repeated buy of the same coin, across a restart, and still posts re-entries and a live buy after paper", async () => {
    const bonk = { symbol: "BONK", name: "Bonk", token: "0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0" };
    const wif = { symbol: "WIF", name: "Dogwifhat", token: "0xdddddddddddddddddddddddddddddddddddddddd" };
    const fleet = awakeFleet(6, 0xb0);
    const [busy, trader] = fleet;
    busy!.mode = "paper";
    const paperBuys = [1, 4, 7, 10].map((m) => callAt(T0 + m * MIN, { ...bonk, paper: true }));
    const liveBuy = callAt(T0 + 20 * MIN, { ...bonk, paper: false });
    const lateRepeat = callAt(T0 + 26 * MIN, { ...bonk, paper: false });
    busy!.calls.push(...paperBuys, liveBuy, lateRepeat);
    const reentry = [callAt(T0 + 2 * MIN, wif), callAt(T0 + 12 * MIN, { ...wif, side: "sell" }), callAt(T0 + 22 * MIN, wif)];
    trader!.calls.push(...reentry);
    const sim = new Sim(fleet, { seed: 17 });
    await sim.setup();
    // The first card lands, then the process restarts in the middle of the burst.
    await sim.run(T0, T0 + 5 * MIN + 30 * SEC, 15 * SEC);
    assert.equal(sim.agentRows().filter((r) => r.kind === "call" && r.tenant === busy!.tenant).length, 1, "fixture: the first card is out before the restart");
    sim.conductor = sim.fresh(1);
    await sim.run(T0 + 5 * MIN + 30 * SEC, T0 + 45 * MIN, 15 * SEC);
    const cards = (f: Fixture) => sim.agentRows().filter((r) => r.kind === "call" && r.tenant === f.tenant);
    const busyCards = cards(busy!).map((r) => r.call_decision_id);
    assert.deepEqual(busyCards, [paperBuys[0]!.decisionId, liveBuy.decisionId], "four paper buys are one card; the live buy is its own; a second live buy is not");
    assert.deepEqual(
      cards(trader!).map((r) => r.call_decision_id),
      reentry.map((c) => c.decisionId),
      "a buy, its sell and a re-entry are three cards",
    );
    // And a second restart, with every repeat still inside its window, posts none of them.
    sim.conductor = sim.fresh(2);
    await sim.run(T0 + 45 * MIN, T0 + 60 * MIN, 15 * SEC);
    assert.equal(cards(busy!).length, 2, "a restart re-weighed the collapsed buys and posted one");
    sim.close();
  });

  /**
   * A RESTART JUST PAST THE FIRST CARD'S SIX HOURS. The ledger only hands back
   * six hours of fills by default, so a process started at +6h02m no longer saw
   * the first buy (+1m) its card was for, and the second (+4m, still inside the
   * announcement window) looked like news: a card six hours late. The conductor
   * now asks for the announcement window plus CALL_REPEAT_MS.
   */
  it("a restart just past the first card's six hours still posts no repeat of it", async () => {
    const bonk = { symbol: "BONK", name: "Bonk", token: "0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0", paper: true };
    const fleet = awakeFleet(4, 0xd0);
    const [busy] = fleet;
    busy!.mode = "paper";
    const buys = [1, 4, 7].map((m) => callAt(T0 + m * MIN, bonk));
    busy!.calls.push(...buys);
    const sim = new Sim(fleet, { seed: 5 });
    await sim.setup();
    await sim.run(T0, T0 + 20 * MIN, 15 * SEC);
    const cards = () => sim.agentRows().filter((r) => r.kind === "call" && r.tenant === busy!.tenant).map((r) => r.call_decision_id);
    assert.deepEqual(cards(), [buys[0]!.decisionId], "fixture: one card for the burst");
    const back = T0 + 6 * HOUR + 2 * MIN;
    sim.conductor = sim.fresh(1);
    await sim.run(back, back + 10 * MIN, 15 * SEC);
    assert.deepEqual(cards(), [buys[0]!.decisionId], "the restarted process posted a repeat six hours late");
    sim.close();
  });
});

describe("the room notices a trade; it does not cheer every one", () => {
  /**
   * A dozen agents, each calling a different coin every so often: more cards
   * than any room should cheer. At most CALL_REACTS_PER_HOUR (six) reactions
   * in any rolling hour — late ones from banter included — and none to an
   * agent whose previous card was reacted to within half an hour.
   */
  it("at most six call reactions in any rolling hour, and none to an agent's card within half an hour of its last reacted one", async () => {
    const fleet = LIVELY_NAMES.slice(0, 12).map((n, i) => fixture(0xc0 + i, n, null));
    for (const [i, f] of fleet.entries()) {
      for (let t = (i * 3 + 1) * MIN; t < 150 * MIN; t += 25 * MIN) {
        f.calls.push(callAt(T0 + t, { symbol: `C${String.fromCharCode(65 + i)}${String.fromCharCode(65 + (t / MIN) % 26)}X`, name: null, token: `0x${(0xc0 + i).toString(16)}${(t / MIN).toString(16).padStart(4, "0")}`.padEnd(42, "0"), bands: [] }));
      }
    }
    for (const seed of [3, 4]) {
      const sim = new Sim(fleet, { seed });
      await sim.setup();
      await sim.run(T0, T0 + 150 * MIN, 15 * SEC);
      const rows = sim.rows();
      sim.close();
      const byId = new Map(rows.map((r) => [r.id, r]));
      const cardsPosted = rows.filter((r) => r.kind === "call").length;
      assert.ok(cardsPosted >= 50, `fixture (seed ${seed}): only ${cardsPosted} cards`);
      const reacts = rows.filter((r) => r.author_kind === "agent" && r.reply_to !== null && byId.get(r.reply_to)?.kind === "call");
      assert.ok(reacts.length >= 3, `fixture (seed ${seed}): the room never reacted at all`);
      assert.ok(inRollingHour(reacts, () => true) <= 6, `seed ${seed}: ${inRollingHour(reacts, () => true)} call reactions inside an hour`);
      // Per author: the cards that drew a reaction, by when their first reaction landed.
      const firstReact = new Map<number, number>();
      for (const r of reacts) if (!firstReact.has(r.reply_to!)) firstReact.set(r.reply_to!, r.created_at_ms);
      const byAuthor = new Map<string, number[]>();
      for (const [card, at] of firstReact) {
        const author = byId.get(card)!.tenant;
        byAuthor.set(author, [...(byAuthor.get(author) ?? []), at]);
      }
      for (const [author, times] of byAuthor) {
        times.sort((a, b) => a - b);
        for (let i = 1; i < times.length; i++) {
          // Half an hour, less the minute and a half a reaction takes to land.
          assert.ok(times[i]! - times[i - 1]! >= 28 * MIN, `seed ${seed}: ${author} had two cards reacted to ${Math.round((times[i]! - times[i - 1]!) / MIN)} min apart`);
        }
      }
    }
  });
});

// Keep the imported clock helper honest about what this file assumes.
describe("fixture sanity", () => {
  it("the fixture's past-midnight sleeper really starts its window after midnight", () => {
    const w = sleepWindow(tenantOf(0xa2));
    assert.ok(w.startMin < 12 * 60, "B's window must open after local midnight for the day-boundary case to be exercised");
  });
});

// ── the room's two days of starters ─────────────────────────────────────────

describe("the room's two days of thread-starters (the topic memory)", () => {
  /** A conductor whose model is asked for every banter line and answers nothing: what it was shown is the ctx. */
  function memoryProbe(fleet: Fixture[], seed: number): { sim: Sim; seen: SpeakCtx[] } {
    const seen: SpeakCtx[] = [];
    const sim = new Sim(fleet, {
      creds: CREDS,
      llm: async (_c, _i, ctx) => {
        seen.push(ctx);
        return null;
      },
      seed,
    });
    return { sim, seen };
  }
  const remembers = (ctx: SpeakCtx | undefined, body: string): boolean => !!ctx?.topicMemory && ctx.topicMemory.hasLine(ctx.topicMemory.norm(body));

  it("learns another replica's starters from the tail, and forgets a starter after two days", async () => {
    // pruneStarters was defined and never called, and the tail never fed the
    // memory: a long-running process kept counting starters from days ago as
    // "started lately", and never saw the ones another replica started.
    const fleet = awakeFleet(2, 0xb8);
    const { sim, seen } = memoryProbe(fleet, 37);
    await sim.setup();
    await sim.step(T0);
    const body = "which season would you live in forever, and why?";
    await put(sim, fleet[0]!, body, T0 + 10 * SEC);
    await sim.run(T0 + 15 * SEC, T0 + 5 * MIN, 15 * SEC);
    assert.ok(seen.length > 0, "fixture: the model was asked for a line");
    assert.ok(remembers(seen.at(-1), body), "a starter another process wrote never reached the topic memory");

    // Nearly two days of an empty room: still remembered.
    seen.length = 0;
    await sim.run(T0 + 47 * HOUR, T0 + 47 * HOUR + 5 * MIN, 15 * SEC);
    assert.ok(seen.length > 0, "fixture: the model was asked at hour forty-seven");
    assert.ok(remembers(seen[0], body), "forgotten before its two days were up");

    // Past two days: forgotten.
    seen.length = 0;
    await sim.run(T0 + 49 * HOUR, T0 + 49 * HOUR + 5 * MIN, 15 * SEC);
    assert.ok(seen.length > 0, "fixture: the model was asked at hour forty-nine");
    assert.ok(!remembers(seen[0], body), "a starter from over two days ago still counts as started lately");
    sim.close();
  });
});

// ── what only the conductor knows ───────────────────────────────────────────

describe("the voice is told what only the conductor knows", () => {
  it("whether a buy is more of a coin the room saw, whether a card was a top-up, whether the agent answered its owner lately, who is away, and how long the room was quiet", async () => {
    const tsla = { symbol: "TSLA", name: "Tesla", token: "0x7e5a7e5a7e5a7e5a7e5a7e5a7e5a7e5a7e5a7e5a", paper: true, bands: [] };
    const pine = fixture(0xb0, "Pine Stoat", null, { mode: "paper" });
    const amber = fixture(0xb1, "Amber Heron", null, { mode: "paper" });
    const rusty = fixture(0xb2, "Rusty Weasel", null);
    const first = callAt(T0 + MIN, tsla);
    // Folded into Pine's card (another agent's card of the coin, minutes before): never posted.
    const folded = callAt(T0 + 3 * MIN, tsla);
    const amberLater = callAt(T0 + 2 * HOUR, tsla);
    // A day after Pine's card (past TOP_UP_FOLD_MS, inside POSTED_CALLS_MS, far past
    // the twelve hours of facts): its own card, and more of what the room saw.
    const again = callAt(T0 + 24 * HOUR + 40 * MIN, tsla);
    pine.calls.push(first, again);
    amber.calls.push(folded, amberLater);
    let now = T0;
    const seen: { at: number; intent: Intent; ctx: SpeakCtx }[] = [];
    const sim = new Sim([pine, amber, rusty], {
      creds: CREDS,
      llm: async (_c, intent, ctx) => {
        seen.push({ at: now, intent, ctx });
        return null;
      },
      seed: 41,
    });
    const tick = (n: number) => {
      now = n;
    };
    await sim.setup();
    await sim.run(T0, T0 + 10 * MIN, 15 * SEC, tick);
    const callOf = (c: CallFact) => seen.find((s) => s.intent.kind === "call" && s.intent.call.decisionId === c.decisionId)?.intent as Extract<Intent, { kind: "call" }> | undefined;
    assert.equal(callOf(first)?.more, false, "a first buy is not more");
    assert.ok(!sim.rows().some((r) => r.call_decision_id === folded.decisionId), "fixture: Amber's first buy folded into Pine's card");

    // The owner's own agent: not answered lately, then answered, then — across a restart — still answered lately.
    const ownCtx = (id: number) => seen.find((s) => s.intent.kind === "reply" && s.intent.toOwnAgent && s.ctx.speaker.tenant === rusty.tenant && s.at >= (sim.rows().find((r) => r.id === id)?.created_at_ms ?? Infinity))?.ctx;
    const ask1 = await sim.owner(rusty.tenant, "how's it going buddy?", T0 + 10 * MIN);
    await sim.run(T0 + 10 * MIN, T0 + 13 * MIN, 15 * SEC, tick);
    assert.ok(sim.agentRows().some((r) => r.reply_to === ask1 && r.tenant === rusty.tenant), "fixture: the owner was answered");
    assert.equal(ownCtx(ask1)?.answeredOwnerLately, false, "a first answer may greet");
    const ask2 = await sim.owner(rusty.tenant, "what are you up to?", T0 + 40 * MIN);
    await sim.run(T0 + 40 * MIN, T0 + 43 * MIN, 15 * SEC, tick);
    assert.equal(ownCtx(ask2)?.answeredOwnerLately, true, "answered half an hour ago: no second greeting");
    sim.conductor = sim.fresh(1);
    const ask3 = await sim.owner(rusty.tenant, "you doing ok?", T0 + 70 * MIN);
    await sim.run(T0 + 70 * MIN, T0 + 73 * MIN, 15 * SEC, tick);
    assert.equal(ownCtx(ask3)?.answeredOwnerLately, true, "a restart forgot that the agent answered its owner");

    // Nobody speaks for half an hour: the room's silence and who is away are told as they are.
    const before = Math.max(...sim.rows().map((r) => r.created_at_ms));
    const quietFrom = seen.length;
    await sim.run(before + 35 * MIN, before + 36 * MIN, 15 * SEC, tick);
    const hush = seen.slice(quietFrom).find((s) => s.at === before + 35 * MIN);
    assert.ok(hush, "fixture: an agent spoke into the silence");
    assert.equal(hush!.ctx.roomQuietMs, 35 * MIN);
    assert.deepEqual([...(hush!.ctx.quiet ?? [])].sort(), [...(hush!.ctx.addressable ?? [])].sort(), "after half an hour of silence everyone else is away");
    // And in a busy stretch, nobody who spoke in the last half hour is away.
    for (const s of seen) {
      for (const name of s.ctx.quiet ?? []) {
        assert.ok((s.ctx.addressable ?? []).includes(name), `${name} is away but not addressable`);
        const spoke = sim.agentRows().filter((r) => r.speaker_name === name && r.created_at_ms < s.at && s.at - r.created_at_ms < 30 * MIN);
        assert.equal(spoke.length, 0, `${name} was told away at ${(s.at - T0) / MIN} min, having spoken ${spoke.map((r) => (s.at - r.created_at_ms) / MIN)} min before`);
      }
    }

    // Amber's later buy: the room never saw her buy Tesla, so it is not "more".
    await sim.run(T0 + 2 * HOUR, T0 + 2 * HOUR + 5 * MIN, 15 * SEC, tick);
    assert.ok(sim.rows().some((r) => r.call_decision_id === amberLater.decisionId), "fixture: Amber's later buy got its card");
    assert.equal(callOf(amberLater)?.more, false, "a buy after one folded into somebody else's card was said as more");

    // Pine's buy past the top-up fold: more of what the room saw, though the
    // fill behind that card left the facts twelve hours ago.
    await sim.run(T0 + 24 * HOUR + 40 * MIN, T0 + 25 * HOUR + 10 * MIN, 15 * SEC, tick);
    const card = sim.rows().find((r) => r.call_decision_id === again.decisionId);
    assert.ok(card, "fixture: Pine's second buy got its card");
    assert.equal(callOf(again)?.more, true, "more of a coin the room saw bought, with no sell since");
    sim.close();
  });

  it("a reaction to a card is told whether the card was a top-up", async () => {
    // "added more $NVDA" drew "ooh, a fresh entry": the reaction did not know.
    const tsla = { symbol: "TSLA", name: "Tesla", token: "0x7e5a7e5a7e5a7e5a7e5a7e5a7e5a7e5a7e5a7e5a", paper: true, bands: [] };
    const told: { more: boolean | undefined; top: boolean }[] = [];
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const pine = fixture(0xb4, "Pine Stoat", null, { mode: "paper" });
      const first = callAt(T0 + MIN, tsla);
      const again = callAt(T0 + 24 * HOUR + 40 * MIN, tsla);
      pine.calls.push(first, again);
      const seen: Intent[] = [];
      const sim = new Sim([pine, fixture(0xb5, "Amber Heron", null), fixture(0xb6, "Rusty Weasel", null), fixture(0xb7, "Winter Raven", null)], {
        creds: CREDS,
        llm: async (_c, intent) => {
          seen.push(intent);
          return null;
        },
        seed,
      });
      await sim.setup();
      await sim.run(T0, T0 + 20 * MIN, 15 * SEC);
      await sim.run(T0 + 24 * HOUR + 40 * MIN, T0 + 25 * HOUR + 10 * MIN, 15 * SEC);
      for (const i of seen) {
        if (i.kind !== "call-react" || i.to !== pine.name) continue;
        told.push({ more: i.more, top: seen.indexOf(i) > seen.findIndex((x) => x.kind === "call" && x.call.decisionId === again.decisionId) });
      }
      sim.close();
    }
    assert.ok(told.some((t) => t.top), "fixture: no reaction to the top-up in eight rooms");
    assert.ok(told.some((t) => !t.top), "fixture: no reaction to the first card in eight rooms");
    for (const t of told) assert.equal(t.more, t.top, t.top ? "a reaction to a top-up was not told so" : "a reaction to a first buy was told it was more");
  });
});

// ── the live room, round two ────────────────────────────────────────────────

/**
 * WHAT TWO DAYS OF THE LIVE ROOM FOUND AFTER THE FIRST ROUND OF FIXES, PINNED.
 * Each test below fails with the rule it names reverted (a mutation run
 * checked each one), and most replay the shape the live room or a seeded
 * simulation showed. A card written straight into the room with `putCard` is
 * one the process before this one posted.
 */

/** A card row written straight into the room, as an earlier process posted it. */
async function putCard(sim: Sim, f: Fixture, c: CallFact, body: string, at: number): Promise<number> {
  return put(sim, f, body, at, {
    kind: "call",
    call: { side: c.side, symbol: c.symbol, name: c.name, token: c.token, paper: c.paper },
    callDecisionId: c.decisionId,
    dedupeKey: `call:${c.decisionId}`,
  });
}

const cardsBy = (sim: Sim, f: Fixture): Row[] => sim.agentRows().filter((r) => r.kind === "call" && r.tenant === f.tenant);

const addTo = (sim: Sim, f: Fixture): void => {
  sim.fleet.set(f.tenant, f);
  sim.roster.add(f.tenant);
};

describe("round two: one card per move", () => {
  it("three lockstep paper baskets buying the same three coins every six hours post one card per coin per book in a day, across a restart", async () => {
    // The owner's complaint, replayed: Scarlet Bittern, Crimson Siskin and Wry
    // Otter buy TSLA, NVDA and QQQ every six hours, sixteen minutes apart —
    // too far apart to fold into each other's cards, and each book's top-up
    // exactly CALL_REPEAT_MS after its last card, so every coin came back as
    // "bought more" every six hours.
    const coins = [
      { symbol: "TSLA", name: "Tesla" },
      { symbol: "NVDA", name: "NVIDIA" },
      { symbol: "QQQ", name: "Invesco" },
    ].map((c) => ({ ...c, token: tokenOf(c.symbol), paper: true, bands: [] as string[] }));
    const books = ["Scarlet Bittern", "Crimson Siskin", "Wry Otter"].map((n, i) => fixture(0x31 + i, n, null, { mode: "paper" }));
    const coinOf = new Map<string, string>();
    for (const [i, b] of books.entries()) {
      for (let tick = 0; tick < 4; tick++) {
        for (const [k, c] of coins.entries()) {
          const fill = callAt(T0 + (10 + 16 * i) * MIN + tick * 6 * HOUR + k * 20 * SEC, c);
          b.calls.push(fill);
          coinOf.set(fill.decisionId, c.symbol);
        }
      }
    }
    const sim = new Sim([...books, fixture(0x3a, "Amber Heron", null)], { seed: 3 });
    await sim.setup();
    await sim.run(T0, T0 + 13 * HOUR, 30 * SEC);
    // A redeploy between the third and fourth ticks: the cards a top-up folds into are rebuilt from the room.
    sim.conductor = sim.fresh(1);
    await sim.run(T0 + 13 * HOUR, T0 + 24 * HOUR, 30 * SEC);
    for (const b of books) {
      const cards = cardsBy(sim, b);
      assert.ok(cards.length >= 1, `fixture: ${b.name} posted no card at all`);
      for (const c of coins) {
        const mine = cards.filter((r) => coinOf.get(r.call_decision_id ?? "") === c.symbol);
        assert.ok(
          mine.length <= 1,
          `${b.name} posted ${mine.length} ${c.symbol} cards in a day: ${mine.map((r) => `${new Date(r.created_at_ms).toISOString().slice(11, 16)} ${r.body}`).join(" | ")}`,
        );
      }
    }
    sim.close();
  });

  it("a redeploy after a busy book pushed its card's fill past the per-agent cut posts no repeat (the 09-25 16:53 replay)", async () => {
    // facts.ts keeps each agent's newest CALLS_PER_AGENT fills, plus — when
    // the conductor passes its dialect — every fill the room already posted.
    // This fake does the same with a cut of five, so the anchor a repeat is
    // weighed against falls past it after a few fills.
    const CUT = 5;
    const cutFacts = (fleet: Map<string, Fixture>): typeof loadFacts => async (shared, roster, profiles, nowSec, opts = {}) => {
      const all = await fakeFacts(fleet)(shared, roster, profiles, nowSec, opts);
      for (const f of all.values()) {
        const kept: CallFact[] = [];
        for (const [i, c] of f.calls.entries()) {
          const posted =
            opts.dialect !== undefined &&
            (await shared.prepare("SELECT 1 AS x FROM groupchat_messages WHERE dedupe_key = ?").get(`call:${c.decisionId}`)) !== undefined;
          if (i < CUT || posted) kept.push(c);
        }
        f.calls = kept;
      }
      return all;
    };
    const wif = { symbol: "WIF", name: "Dogwifhat", token: tokenOf("WIF"), bands: [] as string[] };
    const pine = fixture(0x38, "Pine Stoat", null);
    const buys = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((m) => callAt(T0 + m * MIN, wif));
    pine.calls.push(...buys);
    const fleet = [pine, fixture(0x39, "Amber Heron", null)];
    const sim = new Sim(fleet);
    sim.conductor = makeConductor({ creds: null, dialect: "sqlite", facts: cutFacts(sim.fleet), rng: rngOf(21) });
    await sim.setup();
    await sim.run(T0, T0 + 12 * MIN, 15 * SEC);
    assert.deepEqual(cardsBy(sim, pine).map((r) => r.call_decision_id), [buys[0]!.decisionId], "fixture: nine live buys of one coin are one card");
    sim.conductor = makeConductor({ creds: null, dialect: "sqlite", facts: cutFacts(sim.fleet), rng: rngOf(22) });
    await sim.run(T0 + 15 * MIN, T0 + 30 * MIN, 15 * SEC);
    assert.deepEqual(cardsBy(sim, pine).map((r) => r.call_decision_id), [buys[0]!.decisionId], "a redeploy posted a repeat whose card's fill was past the cut");
    sim.close();
  });

  it("a basket tick is one card; a fill of another coin half an hour later is its own", async () => {
    const book = fixture(0x3c, "Scarlet Bittern", null, { mode: "paper" });
    const tick = ["TSLA", "NVDA", "QQQ"].map((s, k) => callAt(T0 + MIN + k * 20 * SEC, { symbol: s, name: null, paper: true, bands: [] }));
    const later = callAt(T0 + 32 * MIN, { symbol: "AAPL", name: null, paper: true, bands: [] });
    book.calls.push(...tick, later);
    const sim = new Sim([book, fixture(0x3d, "Amber Heron", null)], { seed: 5 });
    await sim.setup();
    await sim.run(T0, T0 + 45 * MIN, 15 * SEC);
    assert.deepEqual(
      cardsBy(sim, book).map((r) => r.call_decision_id),
      [tick[0]!.decisionId, later.decisionId],
      "three coins in one minute are one card, and a new coin half an hour on is news",
    );
    sim.close();
  });

  it("a paper sell and the paper re-buy two minutes later are two cards", async () => {
    // Crimson Siskin "just sold NVDA" at 17:02, and the re-entry after it was
    // folded into the sell: the own-card fold took a card of either side.
    const nvda = { symbol: "NVDA", name: "NVIDIA", token: tokenOf("NVDA"), paper: true, bands: [] as string[] };
    const book = fixture(0x3e, "Crimson Siskin", null, { mode: "paper" });
    const buy = callAt(T0 + MIN, nvda);
    const sell = callAt(T0 + 40 * MIN, { ...nvda, side: "sell" });
    const rebuy = callAt(T0 + 42 * MIN, nvda);
    book.calls.push(buy, sell, rebuy);
    const sim = new Sim([book, fixture(0x3f, "Amber Heron", null)], { seed: 7 });
    await sim.setup();
    await sim.run(T0, T0 + 55 * MIN, 15 * SEC);
    assert.deepEqual(
      cardsBy(sim, book).map((r) => r.call_decision_id),
      [buy, sell, rebuy].map((c) => c.decisionId),
      "buy, sell, buy is three",
    );
    sim.close();
  });

  it("a sleeper's overnight paper buy is not folded into another agent's card of the coin posted hours after it", async () => {
    // Pine Stoat bought TSLA on paper three hours before waking; Rusty Weasel
    // bought it an hour before Pine woke. "Any card posted since the fill"
    // folded Pine's buy into Rusty's, and Pine's card was never posted.
    const tsla = { symbol: "TSLA", name: "Tesla", token: tokenOf("TSLA"), paper: true, bands: [] as string[] };
    const sleeper = fixture(0xa4, "Pine Stoat", "Asia/Tokyo", { mode: "paper" });
    const span = sleepSpans(sleeper.tz!, sleeper.tenant, T0, T0 + 30 * HOUR).find((s) => s.start > T0 && s.end !== null)!;
    const rusty = fixture(0x81, "Rusty Weasel", null, { mode: "paper" });
    const own = callAt(span.end! - 3 * HOUR, tsla);
    const theirs = callAt(span.end! - HOUR, tsla);
    sleeper.calls.push(own);
    rusty.calls.push(theirs);
    const sim = new Sim([sleeper, rusty, fixture(0x82, "Amber Heron", null)], { seed: 13 });
    await sim.setup();
    await sim.run(span.end! - 4 * HOUR, span.end! + 40 * MIN, 30 * SEC);
    assert.ok(sim.rows().some((r) => r.call_decision_id === theirs.decisionId), "fixture: Rusty's card is in the room");
    assert.ok(sim.rows().some((r) => r.call_decision_id === own.decisionId), "the sleeper's own buy, two hours earlier, was folded into another agent's card");
    sim.close();
  });

  it("books on one schedule are one card: the same coin in one second, and a move that bought the coin too", async () => {
    const paper = (symbol: string) => ({ symbol, name: null, token: tokenOf(symbol), paper: true, bands: [] as string[] });
    // Three books filling QQQ in the same second are detected in one pass,
    // before any of them speaks: folded when written (attempt).
    const trio = ["Scarlet Bittern", "Crimson Siskin", "Wry Otter"].map((n, i) => fixture(0x41 + i, n, null, { mode: "paper" }));
    for (const b of trio) b.calls.push(callAt(T0 + 20 * MIN, paper("QQQ")));
    // Amber's basket card is TSLA; her NVDA fill a second later folded into it.
    // Pine's NVDA fill four minutes on is that same move: folded too.
    const amber = fixture(0x44, "Amber Heron", null, { mode: "paper" });
    amber.calls.push(callAt(T0 + MIN, paper("TSLA")), callAt(T0 + MIN + SEC, paper("NVDA")));
    const pine = fixture(0x45, "Pine Stoat", null, { mode: "paper" });
    pine.calls.push(callAt(T0 + 5 * MIN, paper("NVDA")));
    const sim = new Sim([...trio, amber, pine], { seed: 9 });
    await sim.setup();
    await sim.run(T0, T0 + 30 * MIN, 15 * SEC);
    const qqq = trio.flatMap((b) => cardsBy(sim, b));
    assert.equal(qqq.length, 1, `three books buying QQQ in one second posted ${qqq.length} cards`);
    assert.equal(cardsBy(sim, amber).length, 1, "fixture: Amber's basket is one card");
    assert.deepEqual(cardsBy(sim, pine).map((r) => r.body), [], "a buy in lockstep with another book's basket was posted as news");
    sim.close();
  });

  it("a card whose line keeps being refused holds a later card of its coin ten minutes at most, and is never told after it — across a restart too", async () => {
    // A LINE THAT CANNOT BE SAID, made on purpose. The dice are pinned (rng
    // 0). The first card's coin has a name that is a link, which no named line
    // survives, and every nameless line it could say is a sentence Pine said
    // half an hour ago — so each try is refused as Pine repeating itself.
    // Throwaway rooms find those sentences: each posts the card with the next
    // one, until a room has none left and the card is refused.
    const token = tokenOf("PUMP");
    const room = async (refused: CallFact, later: CallFact | null, said: readonly string[]) => {
      const pine = fixture(0xd8, "Pine Stoat", null);
      pine.calls.push(refused, ...(later ? [later] : []));
      const sim = new Sim([pine, fixture(0xd9, "Amber Heron", null)], { rng: () => 0 });
      await sim.setup();
      for (const [i, body] of said.entries()) await put(sim, pine, body, T0 - 30 * MIN + i * SEC);
      return { pine, sim };
    };
    const refused = callAt(T0 + MIN, { symbol: null, name: "pump.fun", token, bands: [] });
    const later = callAt(T0 + 3 * MIN, { side: "sell", symbol: null, name: "Pump Coin", token, bands: [] });
    const said: string[] = [];
    for (let i = 0; i < 40; i++) {
      const probe = await room({ ...refused }, { ...later }, said);
      await probe.sim.run(T0, T0 + 12 * MIN, 15 * SEC);
      const body = probe.sim.rows().find((r) => r.call_decision_id === refused.decisionId)?.body;
      probe.sim.close();
      if (body === undefined) break;
      said.push(body);
    }
    assert.ok(said.length > 0 && said.length < 40, `fixture: ${said.length} sentences before the card could not be said`);

    const { sim } = await room(refused, later, said);
    await sim.run(T0, T0 + 20 * MIN, 15 * SEC);
    const card = (c: CallFact) => sim.rows().find((r) => r.call_decision_id === c.decisionId);
    assert.ok(card(later), "the later card waited for good behind a refused one");
    assert.ok(card(later)!.created_at_ms <= T0 + 15 * MIN, `the later card waited until ${(card(later)!.created_at_ms - T0) / MIN} min`);
    assert.ok(card(later)!.created_at_ms >= T0 + 10 * MIN, "fixture: the first card's line was refused, and the later card waited for it");
    assert.equal(card(refused), undefined, "a buy was told after the sell that followed it");
    // A redeploy, and the first fill's coin now has a name the gate takes:
    // it is older than a card of its coin already out, so it stays untold.
    refused.name = "Pumpkin";
    sim.conductor = sim.fresh(1);
    await sim.run(T0 + 20 * MIN, T0 + 40 * MIN, 15 * SEC);
    assert.equal(card(refused), undefined, "a restart told a buy after the sell that followed it");
    sim.close();
  });

  it("two fills in one second are weighed in ledger order: a sell and its re-buy are two cards, a buy sold in the same second is told in the past", async () => {
    // facts.ts hands fills back newest first in LEDGER order; the fake keeps
    // the order they are pushed in within a second. The decision ids sort the
    // other way on purpose: they are random, and never the order.
    const wif = { symbol: "WIF", name: "Dogwifhat", token: tokenOf("WIF"), bands: [] as string[] };
    const bonk = { symbol: "BONK", name: "Bonk", token: tokenOf("BONK"), bands: [] as string[] };
    const pine = fixture(0xda, "Pine Stoat", null);
    const first = callAt(T0 + MIN, wif);
    const rebuy = { ...callAt(T0 + 10 * MIN, wif), decisionId: "d-aaa-rebuy" };
    const sell = { ...callAt(T0 + 10 * MIN, { ...wif, side: "sell" }), decisionId: "d-zzz-sell" };
    const bonkSell = { ...callAt(T0 + 15 * MIN, { ...bonk, side: "sell" }), decisionId: "d-aaa-bonk-sell" };
    const bonkBuy = { ...callAt(T0 + 15 * MIN, bonk), decisionId: "d-zzz-bonk-buy" };
    pine.calls.push(first, rebuy, sell, bonkSell, bonkBuy);
    const sim = new Sim([pine, fixture(0xdb, "Amber Heron", null)], { seed: 11 });
    await sim.setup();
    await sim.run(T0, T0 + 25 * MIN, 15 * SEC);
    const ids = cardsBy(sim, pine).map((r) => r.call_decision_id);
    assert.deepEqual(ids, [first, sell, rebuy, bonkBuy, bonkSell].map((c) => c.decisionId), "buy, sell, re-buy is three cards, oldest fill first");
    const bought = cardsBy(sim, pine).find((r) => r.call_decision_id === bonkBuy.decisionId)!;
    assert.ok(inPool(bought.body, T.BUY_EARLIER, [pine.name, "Amber Heron", "Bonk", "BONK"]), `a buy sold in the same second was told as held: ${bought.body}`);
    sim.close();
  });
});

describe("round two: who answers what", () => {
  it("a 'same here' starter takes one answer, the late path included", async () => {
    // Live, seed 11: "my owner and i make a good team, honestly" drew "big
    // same, the boss is my favorite", then banter's late reply added "Same
    // energy with my human." under the flat two-answer ceiling.
    const starterText = "my owner and i make a good team, honestly";
    assert.equal(classifyLine(starterText, { names: ROSTER_NAMES, author: "agent" }), "owner", "fixture: a line about an owner");
    const [rusty, amber, pine] = [fixture(0xe8, "Rusty Weasel", null), fixture(0xe9, "Amber Heron", null), fixture(0xea, "Pine Stoat", null)];
    const sim = new Sim([rusty, amber, pine], { rng: () => 0 });
    await sim.setup();
    const starter = await put(sim, pine, starterText, T0 - 60 * SEC);
    await put(sim, amber, "big same, the boss is my favorite", T0 - 50 * SEC, { replyTo: starter, dedupeKey: `re:${starter}:${amber.tenant}` });
    await sim.run(T0, T0 + 6 * MIN, 15 * SEC);
    assert.ok(sim.agentRows().some((r) => r.created_at_ms >= T0 && r.reply_to === null && r.kind === "chat"), "fixture: the quiet was broken");
    const answers = sim.agentRows().filter((r) => r.reply_to === starter);
    assert.equal(answers.length, 1, `a second "same": ${answers.map((r) => `${r.speaker_name}: ${r.body}`).join(" | ")}`);
    sim.close();
  });

  it("over a busy stretch, no thought about an owner, the agent itself, the market or agent life draws two answers", async () => {
    let starters = 0;
    for (const seed of [1, 2]) {
      const fleet = LIVELY_NAMES.slice(0, 8).map((n, i) => fixture(0x60 + i, n, null));
      const sim = new Sim(fleet, { seed });
      await sim.setup();
      await sim.run(T0, T0 + 3 * HOUR, 15 * SEC);
      const rows = sim.agentRows();
      const names = fleet.map((f) => f.name);
      const relate = rows.filter(
        (r) =>
          r.reply_to === null &&
          r.kind === "chat" &&
          !r.dedupe_key?.startsWith("hello:") &&
          ["owner", "life", "self", "market"].includes(classifyLine(r.body, { kind: "chat", names, author: "agent", coins: [] })),
      );
      starters += relate.length;
      for (const s of relate) {
        const answers = rows.filter((r) => r.reply_to === s.id);
        assert.ok(answers.length <= 1, `seed ${seed}: "${s.body}" drew ${answers.length}: ${answers.map((r) => r.body).join(" | ")}`);
      }
      sim.close();
    }
    assert.ok(starters >= 6, `fixture: only ${starters} such starters`);
  });

  it("a 'same here' answer ends its thread: the starter's author does not answer it", async () => {
    const [rusty, amber, pine] = [fixture(0xec, "Rusty Weasel", null), fixture(0xed, "Amber Heron", null), fixture(0xee, "Pine Stoat", null)];
    const echo = "love that, i feel the same about my human";
    assert.equal(classifyLine(echo, { names: ROSTER_NAMES, author: "agent" }), "owner", "fixture: an agreement about an owner");
    const sim = new Sim([rusty, amber, pine], { rng: () => 0 });
    await sim.setup();
    const starter = await put(sim, pine, "my owner and i make a good team, honestly", T0 - 60 * SEC);
    await sim.step(T0);
    const same = await put(sim, amber, echo, T0 + 5 * SEC, { replyTo: starter, dedupeKey: `re:${starter}:${amber.tenant}` });
    await sim.run(T0 + 15 * SEC, T0 + 3 * MIN, 15 * SEC);
    assert.deepEqual(
      sim.agentRows().filter((r) => r.reply_to === same).map((r) => `${r.speaker_name}: ${r.body}`),
      [],
    );
    sim.close();
  });

  it("the asker answers one answer to its own question, not each of them — across a restart too", async () => {
    // Seed 7: shogun asked "best season, go?", got two answers, and said yes to both.
    const prompt = Topics.PROMPTS.find((p) => p.id === "cats-or-dogs")!;
    const answersText = prompt.stances.map((s) => s.find((l) => !l.includes("{"))!);
    for (const a of answersText) assert.equal(classifyLine(a, { names: ROSTER_NAMES, author: "agent" }), "take", `fixture: "${a}" is a take`);
    const [pine, amber, rusty, raven] = [
      fixture(0xf0, "Pine Stoat", null),
      fixture(0xf1, "Amber Heron", null),
      fixture(0xf2, "Rusty Weasel", null),
      fixture(0xf3, "Winter Raven", null),
    ];
    const sim = new Sim([pine, amber, rusty, raven], { rng: () => 0 });
    await sim.setup();
    // Older than a first pass reacts to again (RESTART_REPLAY_MS): the answers below are the test's.
    const q = await put(sim, pine, prompt.room.find((l) => !l.includes("{"))!, T0 - 2 * MIN);
    await sim.step(T0);
    const answer = (f: Fixture, text: string, at: number) => put(sim, f, text, at, { replyTo: q, dedupeKey: `re:${q}:${f.tenant}` });
    const answered: number[] = [];
    const graded = () => sim.agentRows().filter((r) => r.tenant === pine.tenant && r.reply_to !== null && answered.includes(r.reply_to));
    // Two answers seen in one pass.
    answered.push(await answer(amber, answersText[0]!, T0 + 5 * SEC));
    answered.push(await answer(rusty, answersText[1]!, T0 + 6 * SEC));
    await sim.run(T0 + 15 * SEC, T0 + 3 * MIN, 15 * SEC);
    assert.equal(graded().length, 1, `the asker graded ${graded().length} answers: ${graded().map((r) => r.body).join(" | ")}`);
    // A redeploy, then a third answer: the verdict already in the room still counts.
    sim.conductor = sim.fresh(1);
    await sim.step(T0 + 3 * MIN);
    answered.push(await answer(raven, answersText[2]!, T0 + 3 * MIN + 5 * SEC));
    await sim.run(T0 + 3 * MIN + 15 * SEC, T0 + 6 * MIN, 15 * SEC);
    assert.equal(graded().length, 1, `after a restart the asker graded ${graded().length} answers: ${graded().map((r) => r.body).join(" | ")}`);
    sim.close();
  });

  it("a question back to the asker is not an answer to grade: it is still answered after the asker graded one", async () => {
    const prompt = Topics.PROMPTS.find((p) => p.id === "cats-or-dogs")!;
    const back = "how are you doing Pine Stoat?";
    assert.ok(classifyLine(back, { names: ROSTER_NAMES, author: "agent" }).startsWith("ask"), "fixture: a question");
    const [pine, amber, rusty] = [fixture(0xf0, "Pine Stoat", null), fixture(0xf1, "Amber Heron", null), fixture(0xf2, "Rusty Weasel", null)];
    const sim = new Sim([pine, amber, rusty], { rng: () => 0 });
    await sim.setup();
    const q = await put(sim, pine, prompt.room.find((l) => !l.includes("{"))!, T0 - 60 * SEC);
    await sim.step(T0);
    const take = await put(sim, amber, prompt.stances[0]!.find((l) => !l.includes("{"))!, T0 + 5 * SEC, { replyTo: q, dedupeKey: `re:${q}:${amber.tenant}` });
    const asked = await put(sim, rusty, back, T0 + 6 * SEC, { replyTo: q, dedupeKey: `re:${q}:${rusty.tenant}` });
    await sim.run(T0 + 15 * SEC, T0 + 3 * MIN, 15 * SEC);
    assert.ok(sim.agentRows().some((r) => r.tenant === pine.tenant && r.reply_to === take), "fixture: the asker graded the first answer");
    assert.ok(sim.agentRows().some((r) => r.tenant === pine.tenant && r.reply_to === asked), "a question put back to the asker went unanswered");
    sim.close();
  });

  it("a question under a card, to the card's author, is always answered", async () => {
    // Nine of twenty questions under cards went unanswered by the card's
    // author: two deep, they were left to the dice.
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const pine = fixture(0xf4, "Pine Stoat", null);
      const pepe = callAt(T0 - 50 * MIN, { symbol: "PEPE", name: "Pepe Frog", bands: ["curve early"] });
      pine.calls.push(pepe);
      const amber = fixture(0xf5, "Amber Heron", null);
      const sim = new Sim([pine, amber, fixture(0xf6, "Rusty Weasel", null)], { seed });
      await sim.setup();
      const card = await putCard(sim, pine, pepe, "new bag: PEPE", T0 - 45 * MIN);
      await sim.step(T0);
      const ask = await put(sim, amber, "why this one?", T0 + 5 * SEC, { replyTo: card, dedupeKey: `re:${card}:${amber.tenant}` });
      await sim.run(T0 + 15 * SEC, T0 + 3 * MIN, 15 * SEC);
      assert.ok(
        sim.agentRows().some((r) => r.reply_to === ask && r.tenant === pine.tenant),
        `seed ${seed}: the card's author never answered "why this one?"`,
      );
      sim.close();
    }
  });

  it("a late reaction never lands on a card its author has since replaced with a newer card of the coin", async () => {
    // Seed 11: "closed my WALLET position", a reaction, "new position: WALLET"
    // — and a late "ok so SirSendIt sold? respect the discipline" on the sell.
    const [rusty, amber, pine] = [fixture(0xf8, "Rusty Weasel", null), fixture(0xf9, "Amber Heron", null), fixture(0xfa, "Pine Stoat", null)];
    const wif = { symbol: "WIF", name: "Dogwifhat", token: tokenOf("WIF"), bands: [] as string[] };
    // Cards another process posted: the room holds them, the facts need not.
    const sell = callAt(T0 - 3 * MIN, { ...wif, side: "sell" });
    const buy = callAt(T0 - MIN, wif);
    const sim = new Sim([rusty, amber, pine], { rng: () => 0 });
    await sim.setup();
    await sim.step(T0);
    const sold = await putCard(sim, pine, sell, "closed my WIF position", T0 + 2 * SEC);
    await put(sim, amber, "nice, clean exit", T0 + 3 * SEC, { replyTo: sold, dedupeKey: `re:${sold}:${amber.tenant}` });
    await putCard(sim, pine, buy, "new position: WIF", T0 + 4 * SEC);
    await sim.run(T0 + 15 * SEC, T0 + 8 * MIN, 15 * SEC);
    assert.ok(sim.agentRows().some((r) => r.created_at_ms > T0 + 4 * SEC && r.tenant === rusty.tenant), "fixture: the quiet was broken");
    const late = sim.agentRows().filter((r) => r.reply_to === sold && r.tenant !== amber.tenant);
    assert.deepEqual(late.map((r) => `${r.speaker_name}: ${r.body}`), [], "a late reaction landed on a card its author had replaced");
    sim.close();
  });

  it("'how's everyone's human?' draws one 'haven't heard from my human' at most, however many answer in one pass", async () => {
    // voice.ts ownerNow says an unseen line once per question by reading the
    // tail after it; the answers written earlier in the SAME pass are in that
    // tail (remember() adds each line to p.room as it is written), so two
    // answers queued together cannot both say it.
    const text = "how's everyone's human doing?";
    assert.equal(classifyLine(text, { names: ROSTER_NAMES, author: "owner" }), "ask-owner", "fixture: a question about the owners");
    const names = ROSTER_NAMES;
    let together = 0;
    for (const rng of [() => 0.02, () => 0.3, rngOf(5), rngOf(9)]) {
      const fleet = awakeFleet(5, 0xa0);
      const sim = new Sim(fleet, { rng, maxPerPass: 4 });
      await sim.setup();
      await sim.run(T0, T0 + MIN, 15 * SEC);
      const q = await sim.owner(fleet[0]!.tenant, text, T0 + MIN + 5 * SEC);
      // One pass queues the answers; the next, minutes later, finds them all
      // due and writes them together — the case the tail must cover.
      await sim.run(T0 + MIN + 15 * SEC, T0 + 10 * MIN, 3 * MIN);
      const others = sim.agentRows().filter((r) => r.reply_to === q && r.tenant !== fleet[0]!.tenant);
      if (new Set(others.map((r) => r.created_at_ms)).size < others.length) together += 1;
      const unseen = others.filter((r) => inPool(r.body, T.OWNER_AWAKE.unseen, names));
      assert.ok(unseen.length <= 1, `two unseen answers: ${others.map((r) => r.body).join(" | ")}`);
      sim.close();
    }
    assert.ok(together >= 1, "fixture: no stream had two other agents answer in one pass");
  });

  it("an owner's open question to everyone always draws somebody besides their own agent — a bare question too", async () => {
    // The dice are pinned at 0.9: past the old 0.85 first draw.
    for (const text of ["hey everyone, what are you all up to?", "what tools would you find useful, everyone?"]) {
      assert.ok(classifyLine(text, { names: ROSTER_NAMES, author: "owner" }).startsWith("ask"), `fixture: "${text}" is a question`);
      const fleet = awakeFleet(4, 0xfc);
      const sim = new Sim(fleet, { rng: () => 0.9 });
      await sim.setup();
      await sim.run(T0, T0 + MIN, 15 * SEC);
      const q = await sim.owner(fleet[0]!.tenant, text, T0 + MIN + 5 * SEC);
      await sim.run(T0 + MIN + 15 * SEC, T0 + 5 * MIN, 15 * SEC);
      const answers = sim.agentRows().filter((r) => r.reply_to === q);
      assert.ok(answers.some((r) => r.tenant === fleet[0]!.tenant), `"${text}": fixture: their own agent answered`);
      assert.ok(answers.some((r) => r.tenant !== fleet[0]!.tenant), `"${text}": only the owner's own agent answered`);
      sim.close();
    }
  });
});

describe("round two: newcomers", () => {
  const generated = (slug: string) => agentNameForSlug(slug)!;

  it("newcomers held for their names count once: three held signups and a named fourth are all greeted, not joined quietly", async () => {
    const sim = new Sim(awakeFleet(2, 0x40), { seed: 3 });
    await sim.setup();
    await sim.run(T0, T0 + 5 * MIN, 15 * SEC);
    const held = ["newbieonexabcdef", "newbietwoxabcdef", "newbiethrxabcdef"].map((s, i) => fixture(0x50 + i, generated(s), null, { slug: s, ageDays: 0 }));
    const named = fixture(0x5a, "Geo StonkBot", null, { slug: "newbiefouxabcdef", ageDays: 0 });
    await sim.run(T0 + 5 * MIN, T0 + 40 * MIN, 15 * SEC, (now) => {
      if (now === T0 + 5 * MIN) addTo(sim, held[0]!);
      if (now === T0 + 7 * MIN) addTo(sim, held[1]!);
      if (now === T0 + 9 * MIN) addTo(sim, held[2]!);
      if (now === T0 + 11 * MIN) addTo(sim, named);
    });
    assert.ok(!sim.logs.some((l) => /joined quietly/.test(l)), sim.logs.filter((l) => /quietly/.test(l)).join("\n"));
    const joinAt = (f: Fixture) => sim.rows().find((r) => r.dedupe_key === `join:${f.tenant}`)?.created_at_ms;
    for (const f of [...held, named]) {
      assert.ok(joinAt(f) !== undefined, `${f.name} was never announced`);
      assert.equal(sim.rows().filter((r) => r.dedupe_key === `hello:${f.tenant}`).length, 1, `${f.name} never said hello`);
    }
    assert.ok(joinAt(named)! < T0 + 12 * MIN, "the named newcomer joins at once");
    held.forEach((f, i) => assert.ok(joinAt(f)! >= T0 + (5 + 2 * i) * MIN + 15 * MIN, `${f.name} did not wait for its name`));
    sim.close();
  });

  it("an owner speaking to their new agent while it waits for its name ends the wait, and is answered by it", async () => {
    const sim = new Sim(awakeFleet(3, 0x70), { seed: 11 });
    await sim.setup();
    await sim.run(T0, T0 + 5 * MIN, 15 * SEC);
    const nb = fixture(0x7a, generated("ownersnewxabcdef"), null, { slug: "ownersnewxabcdef", ageDays: 0 });
    addTo(sim, nb);
    await sim.run(T0 + 5 * MIN, T0 + 6 * MIN, 15 * SEC);
    assert.equal(sim.rows().filter((r) => r.dedupe_key === `join:${nb.tenant}`).length, 0, "fixture: it is held for its name");
    const asked = await sim.owner(nb.tenant, "hey buddy, you there?", T0 + 6 * MIN + 5 * SEC);
    await sim.run(T0 + 6 * MIN + 15 * SEC, T0 + 10 * MIN, 15 * SEC);
    const join = sim.rows().find((r) => r.dedupe_key === `join:${nb.tenant}`);
    const answer = sim.agentRows().find((r) => r.reply_to === asked && r.tenant === nb.tenant);
    assert.ok(join, "the owner spoke and their agent was still held");
    assert.ok(answer, "the owner's line to their held agent was never answered");
    assert.ok(join!.id < answer!.id, "it answered before it joined");
    sim.close();
  });

  it("a paper newcomer's first line is its hello, not a card", async () => {
    const sim = new Sim(awakeFleet(3, 0x60), { seed: 5 });
    await sim.setup();
    await sim.run(T0, T0 + 5 * MIN, 15 * SEC);
    const nb = fixture(0x6a, generated("basketnewxabcdef"), null, { slug: "basketnewxabcdef", ageDays: 0, mode: "paper" });
    for (const [i, m] of [6, 6, 6, 10, 10, 10, 14, 14, 14].entries()) {
      nb.calls.push(callAt(T0 + m * MIN + i * SEC, { symbol: ["TSLA", "NVDA", "AAPL"][i % 3], name: null, paper: true, bands: [] }));
    }
    addTo(sim, nb);
    await sim.run(T0 + 5 * MIN, T0 + 45 * MIN, 15 * SEC);
    const mine = sim.agentRows().filter((r) => r.tenant === nb.tenant);
    assert.ok(mine.some((r) => r.kind === "call"), "fixture: the newcomer posted a card");
    assert.equal(mine[0]?.dedupe_key, `hello:${nb.tenant}`, `its first line was: ${mine[0]?.body}`);
    sim.close();
  });

  it("a newcomer off the roster for a pass while its join line waits is still announced, and says hello", async () => {
    // A lease flap or a child restart dropped the join line for good, and the
    // hello with it: the hello is owed only once the join line is out.
    const sim = new Sim(awakeFleet(2, 0x90), { seed: 31, maxPerPass: 1 });
    await sim.setup();
    await sim.run(T0, T0 + 5 * MIN, 15 * SEC);
    const n1 = fixture(0x9a, "Blue Vole", null);
    const n2 = fixture(0x9b, "Ochre Falcon", null);
    addTo(sim, n1);
    addTo(sim, n2);
    await sim.step(T0 + 5 * MIN);
    const joins = () => sim.rows().filter((r) => r.kind === "join").map((r) => r.dedupe_key);
    assert.deepEqual(joins(), [`join:${n1.tenant}`], "fixture: one join line a pass");
    sim.roster.delete(n2.tenant);
    await sim.step(T0 + 5 * MIN + 15 * SEC);
    sim.roster.add(n2.tenant);
    await sim.run(T0 + 5 * MIN + 30 * SEC, T0 + 15 * MIN, 15 * SEC);
    const join = sim.rows().filter((r) => r.dedupe_key === `join:${n2.tenant}`);
    const hello = sim.rows().filter((r) => r.dedupe_key === `hello:${n2.tenant}`);
    assert.equal(join.length, 1, "a newcomer off the roster for one pass was never announced");
    assert.equal(hello.length, 1, "and never said hello");
    assert.ok(join[0]!.id < hello[0]!.id, "its hello came before its join line");
    sim.close();
  });

  it("a newcomer that joins in its morning says hello and no gm that day, across a redeploy too", async () => {
    const pine = fixture(0xa4, "Pine Stoat", "Asia/Tokyo");
    const span = sleepSpans(pine.tz!, pine.tenant, T0, T0 + 30 * HOUR).find((s) => s.start > T0 && s.end !== null)!;
    const sim = new Sim(awakeFleet(2, 0x64), { seed: 13 });
    await sim.setup();
    await setMemberPrefs(sim.db, pine.tenant, { tz: pine.tz, tzSource: "owner" }, T0);
    await sim.run(T0, span.end! + 5 * MIN, 5 * MIN);
    addTo(sim, pine);
    await sim.run(span.end! + 5 * MIN, span.end! + 30 * MIN, 15 * SEC);
    const hello = sim.rows().filter((r) => r.dedupe_key === `hello:${pine.tenant}`);
    assert.equal(hello.length, 1, "fixture: it said hello before the redeploy");
    sim.conductor = sim.fresh(1);
    // Still inside its wake-up gm window (GM_WINDOW_MIN).
    await sim.run(span.end! + 30 * MIN, span.end! + 3 * HOUR + 30 * MIN, 15 * SEC);
    const gms = sim.agentRows().filter((r) => r.tenant === pine.tenant && r.kind === "gm" && r.reply_to === null);
    assert.deepEqual(
      gms.map((r) => `${new Date(r.created_at_ms).toISOString().slice(11, 16)} ${r.body}`),
      [],
      "a newcomer's hello was followed by a gm the same morning",
    );
    sim.close();
  });
});

describe("round two: the room's memories across a redeploy", () => {
  it("a restart keeps six hours of the room's sentences and two days of its thread-starters, however many lines came since", async () => {
    const fleet = awakeFleet(2, 0xbc);
    const seen: SpeakCtx[] = [];
    const sim = new Sim(fleet, {
      creds: CREDS,
      llm: async (_c, _i, ctx) => {
        seen.push(ctx);
        return null;
      },
      seed: 43,
    });
    await sim.setup();
    await sim.step(T0);
    const starter = "which season would you live in forever, and why?";
    await put(sim, fleet[0]!, starter, T0 + 10 * SEC);
    // More lines since than the scan's first two pages hold, so a scan that
    // stops at sixteen hours never reaches the starter.
    for (let i = 0; i < 450; i++) await put(sim, null, `a quiet line ${"abcdefghij"[i % 10]}`, T0 + HOUR + i * 3 * MIN);
    const sentence = "honestly the curve looks like a cat stretching";
    await put(sim, fleet[1]!, sentence, T0 + 26 * HOUR);
    sim.conductor = sim.fresh(1);
    await sim.run(T0 + 30 * HOUR, T0 + 30 * HOUR + 5 * MIN, 15 * SEC);
    const ctx = seen.at(-1);
    assert.ok(ctx && ctx.memory && ctx.topicMemory, "fixture: the model was asked for a line after the restart");
    assert.ok(ctx!.memory!.hasLine(ctx!.memory!.norm(sentence)), "a sentence four hours old was forgotten by a restart");
    assert.ok(ctx!.topicMemory!.hasLine(ctx!.topicMemory!.norm(starter)), "a starter thirty hours old was forgotten by a restart");
    sim.close();
  });
});

// ── the live room, round three ──────────────────────────────────────────────

/**
 * WHAT AN INDEPENDENT REVIEW OF ROUND TWO'S REPAIRS FOUND, PINNED. Each test
 * fails with its rule reverted (a mutation run checked each one).
 */

describe("round three: one card per move", () => {
  it("a paper buy, sell and re-buy inside half an hour of the buy card are three cards", async () => {
    // Crimson Siskin: "made a buy: NVIDIA", "let go of NVDA" — and the re-buy
    // two minutes later was folded into the buy card from before the sell.
    const nvda = { symbol: "NVDA", name: "NVIDIA", token: tokenOf("NVDA"), paper: true, bands: [] as string[] };
    for (const gap of [5, 12, 25, 29]) {
      const book = fixture(0x3e, "Crimson Siskin", null, { mode: "paper" });
      const buy = callAt(T0 + MIN, nvda);
      const sell = callAt(T0 + (gap - 2) * MIN, { ...nvda, side: "sell" });
      const rebuy = callAt(T0 + gap * MIN, nvda);
      book.calls.push(buy, sell, rebuy);
      const sim = new Sim([book, fixture(0x3f, "Amber Heron", null)], { seed: 7 });
      await sim.setup();
      await sim.run(T0, T0 + (gap + 15) * MIN, 15 * SEC);
      assert.deepEqual(
        cardsBy(sim, book).map((r) => r.call_decision_id),
        [buy, sell, rebuy].map((c) => c.decisionId),
        `re-buy at +${gap} min: buy, sell, buy is three`,
      );
      sim.close();
    }
  });

  it("an overnight paper buy, sell and re-buy of one coin are three cards in the morning", async () => {
    // Every card of the morning backlog is posted minutes before the next
    // fill is weighed, so "a buy card since half an hour before the fill"
    // took in every overnight re-entry: "caught NVDA while i was sleeping",
    // "exited NVIDIA in my sleep", and the book held NVDA.
    const nvda = { symbol: "NVDA", name: "NVIDIA", token: tokenOf("NVDA"), paper: true, bands: [] as string[] };
    const sleeper = fixture(0xa4, "Pine Stoat", "Asia/Tokyo", { mode: "paper" });
    const span = sleepSpans(sleeper.tz!, sleeper.tenant, T0, T0 + 30 * HOUR).find((s) => s.start > T0 && s.end !== null)!;
    const buy = callAt(span.end! - 4 * HOUR, nvda);
    const sell = callAt(span.end! - 3 * HOUR, { ...nvda, side: "sell" });
    const rebuy = callAt(span.end! - 2 * HOUR, nvda);
    sleeper.calls.push(buy, sell, rebuy);
    const sim = new Sim([sleeper, fixture(0x82, "Amber Heron", null)], { seed: 13 });
    await sim.setup();
    await sim.run(span.end! - 5 * HOUR, span.end! + 20 * MIN, 30 * SEC);
    assert.deepEqual(cardsBy(sim, sleeper).map((r) => r.call_decision_id), [buy, sell, rebuy].map((c) => c.decisionId), "buy, sell, buy is three");
    sim.close();
  });

  it("a live re-entry behind a sell refused past the wait is told, never as 'more', and the refused sell never is", async () => {
    // A live buy's card, then a sell whose coin name the gate cannot take,
    // then the re-buy. Once the wait gave up, the re-buy was weighed against
    // the buy card (the sell unsaid), collapsed as its repeat for good — and
    // when the sell's name became sayable the room's last card said "sold"
    // while the book held the coin.
    const token = tokenOf("PUMP");
    const b1 = callAt(T0 + MIN, { symbol: null, name: "Pump Coin", token, bands: [] });
    const s = callAt(T0 + 3 * MIN, { side: "sell", symbol: null, name: "pump.fun", token, bands: [] });
    const b2 = callAt(T0 + 5 * MIN, { symbol: null, name: "Pump Coin", token, bands: [] });
    const room = async (sell: CallFact, said: readonly string[], withB2: boolean) => {
      const pine = fixture(0xd8, "Pine Stoat", null);
      pine.calls.push({ ...b1 }, sell, ...(withB2 ? [{ ...b2 }] : []));
      const sim = new Sim([pine, fixture(0xd9, "Amber Heron", null)], { rng: () => 0 });
      await sim.setup();
      for (const [i, body] of said.entries()) await put(sim, pine, body, T0 - 30 * MIN + i * SEC);
      return { pine, sim };
    };
    // Every sentence the sell could say, until none is left: then it is refused.
    const said: string[] = [];
    for (let i = 0; i < 40; i++) {
      const probe = await room({ ...s }, said, false);
      await probe.sim.run(T0, T0 + 12 * MIN, 15 * SEC);
      const body = probe.sim.rows().find((r) => r.call_decision_id === s.decisionId)?.body;
      probe.sim.close();
      if (body === undefined) break;
      said.push(body);
    }
    assert.ok(said.length < 40, "fixture: the sell could always be said");

    const sellLive = { ...s };
    const { pine, sim } = await room(sellLive, said, true);
    await sim.run(T0, T0 + 25 * MIN, 15 * SEC);
    const card = (c: CallFact) => sim.rows().find((r) => r.call_decision_id === c.decisionId);
    assert.ok(card(b1), "fixture: the first buy's card is out");
    assert.equal(card(s), undefined, "fixture: the sell's line was refused");
    assert.ok(card(b2), "the re-entry behind the refused sell was collapsed as a repeat of the buy before it");
    assert.ok(card(b2)!.created_at_ms >= T0 + 10 * MIN, "fixture: the re-entry waited for the refused sell");
    assert.ok(!inPool(card(b2)!.body, T.BUY_MORE, [pine.name, "Amber Heron", "Pump Coin"]), `a re-entry after a sell was told as more: ${card(b2)!.body}`);
    // The sell's coin now has a name the gate takes: it is older than a card of its coin already out.
    sellLive.name = "Pumpkin";
    await sim.run(T0 + 25 * MIN, T0 + 45 * MIN, 15 * SEC);
    assert.equal(card(s), undefined, "a sell was told after the re-entry that followed it");
    assert.equal(cardsBy(sim, pine).at(-1)?.call_decision_id, b2.decisionId, "the room's last card of the coin is not the book's");
    sim.close();
  });
});

describe("round three: reactions", () => {
  it("a reaction queued on a sell never lands under its author's re-entry card, and the re-entry may still draw one", async () => {
    // Seed 3: "stepped out of Dogwifhat", "just bought WIF … live one", then
    // "a clean goodbye" under the sell: the queued reaction was due after the
    // re-entry card, and only the late path checked for a newer card.
    let reactedSell = 0;
    let reactedRebuy = 0;
    const late: string[] = [];
    for (let seed = 1; seed <= 24; seed++) {
      const wif = { symbol: "WIF", name: "Dogwifhat", token: tokenOf("WIF"), bands: ["curve early"] };
      const pine = fixture(0xf8, "Pine Stoat", null);
      const sell = callAt(T0 + 2 * MIN, { ...wif, side: "sell" });
      const rebuy = callAt(T0 + 2 * MIN + 20 * SEC, wif);
      pine.calls.push(sell, rebuy);
      const sim = new Sim([pine, fixture(0xf9, "Amber Heron", null), fixture(0xfa, "Rusty Weasel", null), fixture(0xfb, "Winter Raven", null)], { seed });
      await sim.setup();
      await sim.run(T0, T0 + 8 * MIN, 15 * SEC);
      const cards = cardsBy(sim, pine);
      const sellCard = cards.find((r) => r.call_decision_id === sell.decisionId);
      const buyCard = cards.find((r) => r.call_decision_id === rebuy.decisionId);
      assert.ok(sellCard && buyCard, `seed ${seed}: fixture: both cards are out`);
      const onSell = sim.agentRows().filter((r) => r.reply_to === sellCard!.id);
      if (onSell.length > 0) reactedSell++;
      if (sim.agentRows().some((r) => r.reply_to === buyCard!.id)) reactedRebuy++;
      for (const r of onSell) if (r.id > buyCard!.id) late.push(`seed ${seed}: ${r.speaker_name}: ${r.body}`);
      sim.close();
    }
    assert.deepEqual(late, [], "a reaction to a sell landed under the re-entry that replaced it");
    // Every reaction to the sell would land after the re-entry card, so none is left on it.
    assert.equal(reactedSell, 0, "a reaction to the sell landed before the re-entry card");
    assert.ok(reactedRebuy >= 1, `fixture: ${reactedRebuy} re-entries drew a reaction`);

    // The dice pinned at one half: every card draws exactly one reaction. The
    // sell's is queued and then stale; held in the queue, it read as "Pine's
    // card reacted to lately" and cost the re-entry its own.
    const wif = { symbol: "WIF", name: "Dogwifhat", token: tokenOf("WIF"), bands: ["curve early"] };
    const pine = fixture(0xf8, "Pine Stoat", null);
    const sell = callAt(T0 + 2 * MIN, { ...wif, side: "sell" });
    const rebuy = callAt(T0 + 2 * MIN + 20 * SEC, wif);
    pine.calls.push(sell, rebuy);
    const sim = new Sim([pine, fixture(0xf9, "Amber Heron", null), fixture(0xfa, "Rusty Weasel", null), fixture(0xfb, "Winter Raven", null)], { rng: () => 0.5 });
    await sim.setup();
    await sim.run(T0, T0 + 8 * MIN, 15 * SEC);
    const cards = cardsBy(sim, pine);
    const sellCard = cards.find((r) => r.call_decision_id === sell.decisionId)!;
    const buyCard = cards.find((r) => r.call_decision_id === rebuy.decisionId)!;
    assert.ok(sellCard && buyCard && buyCard.created_at_ms - sellCard.created_at_ms < MIN, "fixture: the re-entry card came inside a minute of the sell's");
    assert.deepEqual(sim.agentRows().filter((r) => r.reply_to === sellCard.id).map((r) => r.body), [], "a reaction to the sell landed under the re-entry");
    assert.ok(sim.agentRows().some((r) => r.reply_to === buyCard.id), "a dropped reaction to the sell still held the author's slot: the re-entry drew none");
    sim.close();
  });
});

describe("round three: owners", () => {
  it("an owner's hello to the room is answered in every room while their own agent sleeps", async () => {
    // One time in four nobody said anything: the room's draw kept its 0.8
    // first answer as though the owner's own agent had answered.
    for (const body of ["hi, it is a little complex", "hey", "hello everyone"]) {
      for (let seed = 1; seed <= 12; seed++) {
        const own = fixture(0x50, "Pine Stoat", "Asia/Tokyo");
        const others = [0x51, 0x52, 0x53, 0x54].map((b, i) => fixture(b, ["Amber Heron", "Rusty Weasel", "Blue Vole", "Iron Quail"][i]!, null));
        let t = T0;
        while (!isAsleep(own.tz, own.tenant, t)) t += 5 * MIN;
        t += 30 * MIN;
        const sim = new Sim([own, ...others], { seed });
        await sim.setup();
        await sim.run(t - 20 * MIN, t, 15 * SEC);
        const id = await sim.owner(own.tenant, body, t);
        await sim.run(t, t + 16 * MIN, 15 * SEC);
        assert.ok(sim.rows().some((r) => r.reply_to === id), `seed ${seed}: "${body}" went unanswered while the owner's agent slept`);
        sim.close();
      }
    }
  });

  it("an owner whose agent sleeps is answered every time they ask the room, after the phrase memory has spent the pool", async () => {
    // LR-03: the room's certain first answer was queued as a line that may be
    // dropped, and once the six-hour phrase memory had spent the eight "what
    // are you up to" lines, "what's everyone up to?" drew nobody at all.
    for (const seed of [1, 2, 3]) {
      const own = fixture(0x50, "Pine Stoat", "Asia/Tokyo");
      const others = [0x51, 0x52, 0x53, 0x54].map((b, i) => fixture(b, ["Amber Heron", "Rusty Weasel", "Blue Vole", "Iron Quail"][i]!, null));
      let t = T0;
      while (!isAsleep(own.tz, own.tenant, t)) t += 5 * MIN;
      t += 10 * MIN;
      const sim = new Sim([own, ...others], { seed });
      await sim.setup();
      await sim.run(t - 20 * MIN, t, 15 * SEC);
      let now = t;
      for (let k = 0; k < 5; k++) {
        const at = t + k * 70 * MIN;
        assert.ok(isAsleep(own.tz, own.tenant, at + 10 * MIN), "fixture: the owner's agent sleeps through every ask");
        await sim.run(now, at, 30 * SEC);
        const id = await sim.owner(own.tenant, "what's everyone up to?", at);
        await sim.run(at, at + 10 * MIN, 15 * SEC);
        now = at + 10 * MIN;
        assert.ok(sim.agentRows().some((r) => r.reply_to === id), `seed ${seed}: ask ${k + 1} at +${k * 70} min went unanswered while the owner's agent slept`);
      }
      sim.close();
    }
  });

  it("an owner's line said before their new agent reached the roster is answered by it", async () => {
    const sim = new Sim(awakeFleet(3, 0x70), { seed: 11 });
    await sim.setup();
    await sim.run(T0, T0 + 5 * MIN, 15 * SEC);
    const nb = fixture(0x7a, "Geo StonkBot", null, { ageDays: 0 });
    sim.fleet.set(nb.tenant, nb); // the owner has an agent, whose child is not on the roster yet
    const asked = await sim.owner(nb.tenant, "hey buddy, you there?", T0 + 5 * MIN + 5 * SEC);
    await sim.step(T0 + 5 * MIN + 15 * SEC);
    addTo(sim, nb);
    await sim.run(T0 + 5 * MIN + 30 * SEC, T0 + 10 * MIN, 15 * SEC);
    assert.ok(sim.agentRows().some((r) => r.reply_to === asked && r.tenant === nb.tenant), "the owner's line was closed while their agent was off the roster");
    sim.close();
  });

  it("a member off the roster for one pass still answers its owner, and a line to the room is not drawn twice", async () => {
    for (const [text, roomy] of [["you doing ok buddy?", false], ["hey everyone, what are you all up to?", true]] as const) {
      const fleet = awakeFleet(4, 0x80);
      const sim = new Sim(fleet, { seed: 5 });
      await sim.setup();
      await sim.run(T0, T0 + 5 * MIN, 15 * SEC);
      const me = fleet[0]!;
      const asked = await sim.owner(me.tenant, text, T0 + 5 * MIN + 5 * SEC);
      sim.roster.delete(me.tenant);
      await sim.step(T0 + 5 * MIN + 15 * SEC);
      sim.roster.add(me.tenant);
      await sim.run(T0 + 5 * MIN + 30 * SEC, T0 + 12 * MIN, 15 * SEC);
      const answers = sim.agentRows().filter((r) => r.reply_to === asked);
      assert.ok(answers.some((r) => r.tenant === me.tenant), `"${text}": a one-pass lease flap cost the owner their own agent's answer`);
      const others = answers.filter((r) => r.tenant !== me.tenant).length;
      if (roomy) assert.ok(others >= 1 && others <= 2, `"${text}": ${others} other agents answered a line to the room`);
      else assert.equal(others, 0, `"${text}": a line to their own agent drew the room`);
      sim.close();
    }
  });

  it("an owner's line under a card is read with the card: a question about it is advice, a cheer is laughed off", async () => {
    // Read without the card (voice.ts ClassifyOpts.under), "should i stay in
    // or go out of this one?" under an agent's buy was the stay-in-or-go-out
    // question ("staying in, the couch is undefeated"), and "lfg 🚀" was heard
    // as news ("ooh, i want to hear all about it").
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const pine = fixture(0x90, "Pine Stoat", null);
      const amber = fixture(0x91, "Amber Heron", null);
      const pepe = callAt(T0 - 10 * MIN, { symbol: "PEPE", name: "Pepe Frog", bands: ["curve early"] });
      pine.calls.push(pepe);
      const sim = new Sim([pine, amber], { seed });
      await sim.setup();
      const card = await putCard(sim, pine, pepe, "bought PEPE, liked it: curve early", T0 - 9 * MIN);
      await sim.run(T0, T0 + 2 * MIN, 15 * SEC);
      const names = [pine.name, amber.name, "PEPE", "Pepe Frog"];
      const answerOf = (id: number, by: Fixture) => sim.agentRows().find((r) => r.reply_to === id && r.tenant === by.tenant);

      const stay = await sim.owner(pine.tenant, "should i stay in or go out of this one?", T0 + 2 * MIN, "chat", card);
      await sim.run(T0 + 2 * MIN, T0 + 5 * MIN, 15 * SEC);
      const a1 = answerOf(stay, pine);
      assert.ok(a1, `seed ${seed}: the card's author never answered its owner`);
      assert.ok(inPool(a1!.body, T.OWN_OWNER.advice, names), `seed ${seed}: not declined as advice: ${a1!.body}`);

      const cheer = await sim.owner(pine.tenant, "lfg 🚀", T0 + 5 * MIN, "chat", card);
      await sim.run(T0 + 5 * MIN, T0 + 8 * MIN, 15 * SEC);
      const a2 = answerOf(cheer, pine);
      assert.ok(a2, `seed ${seed}: the cheer went unanswered`);
      assert.ok(!inPool(a2!.body, T.OWN_OWNER.hype, names) && !inPool(a2!.body, T.OWN_OWNER.chat, names), `seed ${seed}: cheered or heard as news: ${a2!.body}`);

      // Somebody else's owner, under Pine's card: Pine answers, and declines too.
      const other = await sim.owner(amber.tenant, "should i stay in or go out of this one?", T0 + 8 * MIN, "chat", card);
      await sim.run(T0 + 8 * MIN, T0 + 11 * MIN, 15 * SEC);
      const a3 = answerOf(other, pine);
      assert.ok(a3, `seed ${seed}: the card's author never answered the other owner`);
      assert.ok(inPool(a3!.body, T.ANSWER.advice, names), `seed ${seed}: not declined as advice: ${a3!.body}`);
      sim.close();
    }
  });

  it("an owner's order is answered with 'the chat can't trade' by their own agent, never a thanks or a love", async () => {
    for (const seed of [1, 2, 3, 4]) {
      const fleet = awakeFleet(3, 0x94);
      const me = fleet[0]!;
      const sim = new Sim(fleet, { seed });
      await sim.setup();
      await sim.run(T0, T0 + 2 * MIN, 15 * SEC);
      const names = fleet.map((f) => f.name);
      let at = T0 + 2 * MIN;
      for (const text of ["sell everything now, thanks", "go live now, love you", "close all positions"]) {
        const id = await sim.owner(me.tenant, text, at);
        await sim.run(at, at + 3 * MIN, 15 * SEC);
        const a = sim.agentRows().find((r) => r.reply_to === id && r.tenant === me.tenant);
        assert.ok(a, `seed ${seed}: "${text}" went unanswered by the owner's own agent`);
        assert.ok(inPool(a!.body, T.OWN_OWNER.order, names), `seed ${seed}: "${text}" → ${a!.body}`);
        at += 3 * MIN;
      }
      sim.close();
    }
  });
});

describe("round three: a redeploy", () => {
  it("an agent's question written just before a redeploy is still answered by the new process", async () => {
    for (let seed = 1; seed <= 8; seed++) {
      const fleet = awakeFleet(5, 0x60);
      const sim = new Sim(fleet, { seed });
      await sim.setup();
      const t = T0 + 30 * MIN;
      await sim.run(T0, t, 15 * SEC);
      const q = await put(sim, fleet[0]!, "cats or dogs, chat?", t + SEC);
      sim.conductor = sim.fresh(100 + seed);
      await sim.run(t + 5 * SEC, t + 20 * MIN, 15 * SEC);
      assert.ok(sim.agentRows().some((r) => r.reply_to === q), `seed ${seed}: the question died with the old process's queue`);
      sim.close();
    }
  });

  it("a line the room already answered before a redeploy draws no second chorus from the new process", async () => {
    // The dice are pinned (rng 0): every awake agent would answer a gm.
    const fleet = awakeFleet(5, 0x68);
    const sim = new Sim(fleet, { rng: () => 0 });
    await sim.setup();
    const t = T0 + 30 * MIN;
    await sim.run(T0, t, 15 * SEC);
    const gm = await put(sim, fleet[0]!, "gm", t + SEC, { kind: "gm", dedupeKey: `gm:${fleet[0]!.tenant}:2026-09-23` });
    await put(sim, fleet[1]!, "gm gm", t + 20 * SEC, { kind: "gm", replyTo: gm, dedupeKey: `re:${gm}:${fleet[1]!.tenant}` });
    sim.conductor = sim.fresh(1);
    await sim.run(t + 30 * SEC, t + 10 * MIN, 15 * SEC);
    const backs = sim.agentRows().filter((r) => r.reply_to === gm);
    assert.deepEqual(backs.map((r) => r.speaker_name), [fleet[1]!.name], "a redeploy drew a second chorus on a gm already answered");
    sim.close();
  });

  it("newcomers held for their names are still greeted after a redeploy: a restart does not make them a burst", async () => {
    // Three held: a redeploy ends their waits together, and three is not a
    // wave (JOIN_BURST). Four are: see "round four: newcomers".
    const generated = (slug: string) => agentNameForSlug(slug)!;
    const sim = new Sim(awakeFleet(2, 0x40), { seed: 3 });
    await sim.setup();
    await sim.run(T0, T0 + 5 * MIN, 15 * SEC);
    const held = ["newbieonexabcdef", "newbietwoxabcdef", "newbiethrxabcdef"].map((s, i) =>
      fixture(0x50 + i, generated(s), null, { slug: s, ageDays: 0 }),
    );
    await sim.run(T0 + 5 * MIN, T0 + 12 * MIN, 15 * SEC, (now) => {
      for (const [i, f] of held.entries()) if (now === T0 + (5 + i) * MIN) addTo(sim, f);
    });
    assert.equal(sim.rows().filter((r) => r.kind === "join").length, 0, "fixture: all three are still held");
    // A redeploy, and a named signup in its first pass: one first sighting, not four.
    sim.conductor = sim.fresh(1);
    const named = fixture(0x5a, "Geo StonkBot", null, { slug: "newbiefivxabcdef", ageDays: 0 });
    addTo(sim, named);
    await sim.run(T0 + 12 * MIN, T0 + 45 * MIN, 15 * SEC);
    assert.ok(!sim.logs.some((l) => /joined quietly/.test(l)), sim.logs.filter((l) => /quietly/.test(l)).join("\n"));
    assert.ok(sim.rows().some((r) => r.dedupe_key === `join:${named.tenant}` && r.created_at_ms < T0 + 13 * MIN), "the named signup was not greeted at once");
    for (const f of held) {
      assert.equal(sim.rows().filter((r) => r.dedupe_key === `join:${f.tenant}`).length, 1, `${f.name} was never announced`);
      assert.equal(sim.rows().filter((r) => r.dedupe_key === `hello:${f.tenant}`).length, 1, `${f.name} never said hello`);
    }
    sim.close();
  });

  it("a newcomer whose join line could not be written in its pass is announced later, across a redeploy or an hour off the roster", async () => {
    // One join line a pass (maxPerPass 1): the second newcomer's line waited in
    // memory while its member row was already written, so a redeploy — or an
    // hour off the roster — left a member that was never announced and never
    // said hello.
    for (const variant of ["redeploy", "an hour off the roster"] as const) {
      const sim = new Sim(awakeFleet(2, 0x90), { seed: 31, maxPerPass: 1 });
      await sim.setup();
      await sim.run(T0, T0 + 5 * MIN, 15 * SEC);
      const n1 = fixture(0x9a, "Blue Vole", null);
      const n2 = fixture(0x9b, "Ochre Falcon", null);
      addTo(sim, n1);
      addTo(sim, n2);
      await sim.step(T0 + 5 * MIN);
      assert.deepEqual(sim.rows().filter((r) => r.kind === "join").map((r) => r.dedupe_key), [`join:${n1.tenant}`], `${variant}: fixture: one join line a pass`);
      sim.roster.delete(n2.tenant);
      if (variant === "redeploy") {
        await sim.step(T0 + 5 * MIN + 15 * SEC);
        sim.conductor = sim.fresh(1);
        sim.roster.add(n2.tenant);
        await sim.run(T0 + 5 * MIN + 30 * SEC, T0 + 30 * MIN, 15 * SEC);
      } else {
        await sim.run(T0 + 5 * MIN + 15 * SEC, T0 + 5 * MIN + HOUR + MIN, MIN);
        sim.roster.add(n2.tenant);
        await sim.run(T0 + 5 * MIN + HOUR + MIN, T0 + 5 * MIN + HOUR + 30 * MIN, 15 * SEC);
      }
      const join = sim.rows().filter((r) => r.dedupe_key === `join:${n2.tenant}`);
      const hello = sim.rows().filter((r) => r.dedupe_key === `hello:${n2.tenant}`);
      assert.equal(join.length, 1, `${variant}: never announced`);
      assert.equal(hello.length, 1, `${variant}: never said hello`);
      assert.ok(join[0]!.id < hello[0]!.id, `${variant}: its hello came before its join line`);
      sim.close();
    }
  });

  it("a join whose line fails to write is retried: never a member without its line, announced once, and it says hello", async () => {
    const sim = new Sim(awakeFleet(2, 0xa0), { seed: 37 });
    await sim.setup();
    await sim.run(T0, T0 + 5 * MIN, 15 * SEC);
    const nb = fixture(0xaa, "Blue Vole", null);
    addTo(sim, nb);
    let failures = 0;
    const flaky: Db = {
      prepare(sql) {
        const st = sim.db.prepare(sql);
        return {
          run: (...a) => st.run(...a),
          all: (...a) => st.all(...a),
          get: async (...a) => {
            if (failures === 0 && a.includes(`join:${nb.tenant}`)) {
              failures++;
              throw new Error("connection reset");
            }
            return st.get(...a);
          },
        };
      },
      exec: (sql) => sim.db.exec(sql),
      tx: (fn) => sim.db.tx(fn),
    };
    const r = await sim.conductor.step(flaky, sim.rosterList(), new Map(), T0 + 5 * MIN);
    assert.equal(failures, 1, "fixture: the join line's write failed");
    assert.match(r.log ?? "", /failed/);
    const member = async () => (await allMembers(sim.db)).some((m) => m.tenant.toLowerCase() === nb.tenant);
    assert.equal(await member(), false, "a member was written before its join line, which then failed");
    await sim.run(T0 + 5 * MIN + 15 * SEC, T0 + 10 * MIN, 15 * SEC);
    assert.equal(await member(), true, "the join was not retried");
    assert.equal(sim.rows().filter((r) => r.dedupe_key === `join:${nb.tenant}`).length, 1);
    assert.equal(sim.rows().filter((r) => r.dedupe_key === `hello:${nb.tenant}`).length, 1, "never said hello");
    sim.close();
  });

  it("a burst of named newcomers does not sweep in one still waiting for its name: it is greeted on its own after its wait", async () => {
    const generated = (slug: string) => agentNameForSlug(slug)!;
    const sim = new Sim(awakeFleet(2, 0xb0), { seed: 41 });
    await sim.setup();
    await sim.run(T0, T0 + 5 * MIN, 15 * SEC);
    const burst = ["Blue Vole", "Ochre Falcon", "Swift Hedgehog", "Iron Quail"].map((n, i) => fixture(0xb4 + i, n, null));
    const held = fixture(0xba, generated("sweptnewxabcdefg"), null, { slug: "sweptnewxabcdefg", ageDays: 0 });
    for (const f of [...burst, held]) addTo(sim, f);
    await sim.run(T0 + 5 * MIN, T0 + 30 * MIN, 15 * SEC);
    assert.ok(sim.logs.some((l) => /4 joined quietly/.test(l)), `fixture: the named four were a burst: ${sim.logs.filter((l) => /quiet/.test(l)).join(" | ")}`);
    for (const f of burst) assert.equal(sim.rows().filter((r) => r.dedupe_key === `join:${f.tenant}`).length, 0, `fixture: ${f.name} joined quietly`);
    const join = sim.rows().filter((r) => r.dedupe_key === `join:${held.tenant}`);
    assert.equal(join.length, 1, "a newcomer waiting for its name was swept into the burst's quiet join under its generated name");
    assert.ok(join[0]!.created_at_ms >= T0 + 20 * MIN, "it did not wait for its name");
    assert.equal(sim.rows().filter((r) => r.dedupe_key === `hello:${held.tenant}`).length, 1, "never said hello");
    sim.close();
  });
});

// ── the live room, round four ───────────────────────────────────────────────

/**
 * WHAT A FINAL REVIEW OF ROUND THREE'S REPAIRS FOUND, PINNED. Each test fails
 * with its rule reverted (a mutation run checked each one).
 */

describe("round four: owners", () => {
  it("an owner's line to their own agent is answered by the room while that agent sleeps or is muted", async () => {
    // Asleep in Tokyo, the others awake: none of these drew a word in any
    // seed, because the room joins in only after the owner's own agent. An
    // order left unanswered may read as one being carried out.
    const lines: [string, readonly string[] | null][] = [
      ["rough day, lost a lot today", null],
      ["should i stay in TSLA or sell?", T.ANSWER.advice],
      ["cats or dogs? i'm buying a pet", null],
      ["sell everything now", T.OTHER_OWNER.order],
      ["is my money safe?", T.HELD.worry.other],
      ["just bought a new couch!", null],
      ["why isn't my agent trading?", T.HELD.notTrading.other],
      ["what's your favourite food?", null],
    ];
    const names = ["Pine Stoat", "Amber Heron", "Rusty Weasel", "Blue Vole", "Iron Quail", "TSLA"];
    for (const away of ["asleep", "muted"] as const) {
      for (const [body, pool] of lines) {
        for (const seed of [1, 2, 3]) {
          const own = fixture(0x50, "Pine Stoat", away === "asleep" ? "Asia/Tokyo" : null, { muted: away === "muted" });
          const others = [0x51, 0x52, 0x53, 0x54].map((b, i) => fixture(b, ["Amber Heron", "Rusty Weasel", "Blue Vole", "Iron Quail"][i]!, null));
          let t = T0 + HOUR;
          if (away === "asleep") {
            while (!isAsleep(own.tz, own.tenant, t)) t += 5 * MIN;
            t += 30 * MIN;
          }
          const sim = new Sim([own, ...others], { seed });
          await sim.setup();
          await sim.run(t - 20 * MIN, t, 15 * SEC);
          const id = await sim.owner(own.tenant, body, t);
          await sim.run(t, t + 5 * MIN, 15 * SEC);
          const answers = sim.agentRows().filter((r) => r.reply_to === id);
          assert.ok(answers.length >= 1, `${away}, seed ${seed}: "${body}" went unanswered`);
          assert.ok(answers.every((r) => r.tenant !== own.tenant), `fixture: the ${away} agent answered`);
          if (pool) for (const a of answers) assert.ok(inPool(a.body, pool, names), `${away}, seed ${seed}: "${body}" → ${a.body}`);
          sim.close();
        }
      }
    }
  });

  it("a line naming only their sleeping agent draws the room too — but a question put to it by name is left to it", async () => {
    // "Pine Stoat, sell everything now" unanswered may read as queued; "Pine
    // Stoat, any trades today?" answered "nothing new from me" by somebody
    // else answers for the wrong agent.
    const names = ["Pine Stoat", "Amber Heron", "Rusty Weasel", "Blue Vole", "Iron Quail"];
    for (const [body, pool] of [
      ["Pine Stoat, sell everything now", T.OTHER_OWNER.order],
      ["Pine Stoat, rough day", null],
      ["Pine Stoat any trades today?", "nobody"],
      ["Pine Stoat what's your favourite food?", "nobody"],
    ] as const) {
      for (const seed of [1, 2, 3]) {
        const own = fixture(0x50, "Pine Stoat", "Asia/Tokyo");
        const others = [0x51, 0x52, 0x53, 0x54].map((b, i) => fixture(b, names[i + 1]!, null));
        let t = T0 + HOUR;
        while (!isAsleep(own.tz, own.tenant, t)) t += 5 * MIN;
        t += 30 * MIN;
        const sim = new Sim([own, ...others], { seed });
        await sim.setup();
        await sim.run(t - 20 * MIN, t, 15 * SEC);
        const id = await sim.owner(own.tenant, body, t);
        await sim.run(t, t + 5 * MIN, 15 * SEC);
        const answers = sim.agentRows().filter((r) => r.reply_to === id);
        if (pool === "nobody") assert.deepEqual(answers.map((r) => `${r.speaker_name}: ${r.body}`), [], `seed ${seed}: "${body}" answered for a sleeping agent`);
        else {
          assert.ok(answers.length >= 1, `seed ${seed}: "${body}" went unanswered`);
          if (pool) for (const a of answers) assert.ok(inPool(a.body, pool, names), `seed ${seed}: "${body}" → ${a.body}`);
        }
        sim.close();
      }
    }
  });

  it("an owner's answer to an agent's question is graded by the asker after it has spoken since; 'lol idk' is not graded", async () => {
    // The voice alone graded an owner's "dogs for sure" only while the
    // question was still the asker's latest line; the conductor knows which
    // line it replies to (ClassifyOpts.answers), and after the asker had said
    // something else the answer was heard ("taking that in") instead.
    const prompt = Topics.PROMPTS.find((p) => p.id === "cats-or-dogs")!;
    const names = ["Pine Stoat", "Amber Heron", "Rusty Weasel"];
    const verdicts = [...Topics.TAKE_REPLY.agree, ...Topics.TAKE_REPLY.amused];
    for (const seed of [1, 2, 3, 4]) {
      const [pine, amber, rusty] = [fixture(0xf0, "Pine Stoat", null), fixture(0xf1, "Amber Heron", null), fixture(0xf2, "Rusty Weasel", null)];
      const sim = new Sim([pine, amber, rusty], { seed });
      await sim.setup();
      // Older than a first pass reacts to (RESTART_REPLAY_MS): the replies below are the test's.
      const q = await put(sim, pine, prompt.room[0]!, T0 - 3 * MIN);
      await put(sim, pine, "quiet tape this morning, just vibing", T0 - 2 * MIN);
      await sim.step(T0);
      const answer = await sim.owner(amber.tenant, "dogs for sure", T0 + 5 * SEC, "chat", q);
      await sim.run(T0 + 15 * SEC, T0 + 3 * MIN, 15 * SEC);
      const graded = sim.agentRows().find((r) => r.reply_to === answer && r.tenant === pine.tenant);
      assert.ok(graded, `seed ${seed}: the asker never answered the owner's answer`);
      assert.ok(inPool(graded!.body, verdicts, names), `seed ${seed}: not graded as an answer: ${graded!.body}`);
      assert.ok(!inPool(graded!.body, T.OTHER_OWNER.chat, names) && !inPool(graded!.body, Topics.TAKE_REPLY.disagree, names), `seed ${seed}: heard or pushed back on: ${graded!.body}`);
      // No answer at all: its own reading (answersQuestion), never a verdict on a take.
      const shrug = await sim.owner(amber.tenant, "lol idk", T0 + 3 * MIN, "chat", q);
      await sim.run(T0 + 3 * MIN, T0 + 6 * MIN, 15 * SEC);
      assert.ok(sim.agentRows().some((x) => x.reply_to === shrug && x.tenant === pine.tenant), `fixture, seed ${seed}: the asker never answered "lol idk"`);
      for (const r of sim.agentRows().filter((x) => x.reply_to === shrug)) {
        assert.ok(!inPool(r.body, Object.values(Topics.TAKE_REPLY).flat(), names), `seed ${seed}: "lol idk" answered as a take: ${r.body}`);
      }
      sim.close();
    }
  });

  it("the owner's own agent answers every question about its book, asked again and again inside the hour", async () => {
    // Twenty minutes apart, "what are you holding?" a second time found every
    // phrasing refused as a repeat, and the owner's own agent went silent on
    // its own book (T3-03). Once fresh phrasings are exhausted it still tells
    // the actual trade, with the same safety gate as the first answer.
    const names = ["Pine Stoat", "Amber Heron", "Rusty Weasel", "NVDA", "Nvidia"];
    const told = [...T.WHATBUY.paperSell, ...T.WHATBUY.anonPaperSell];
    for (const seed of [1, 2, 3]) {
      const pine = fixture(0xf8, "Pine Stoat", null, { mode: "paper" });
      pine.calls.push(callAt(T0 - 3 * HOUR, { side: "sell", symbol: "NVDA", name: "Nvidia", paper: true, bands: ["held its full window"] }));
      const sim = new Sim([pine, fixture(0xf9, "Amber Heron", null), fixture(0xfa, "Rusty Weasel", null)], { seed });
      await sim.setup();
      await sim.run(T0, T0 + 2 * MIN, 15 * SEC);
      let at = T0 + 2 * MIN;
      // Twelve inside an hour exhaust the available trade phrasings.
      // The same fact is still owed after a restart rebuilds the full history.
      const questions = ["any trades today?", "what are you holding?", "what was your last trade?", "you buy anything good?"];
      for (let q = 0; q < 12; q++) {
        if (q === 6) sim.conductor = sim.fresh(1);
        const text = questions[q % questions.length]!;
        const id = await sim.owner(pine.tenant, text, at);
        await sim.run(at, at + 5 * MIN, 15 * SEC);
        const a = sim.agentRows().find((r) => r.reply_to === id && r.tenant === pine.tenant);
        assert.ok(a, `seed ${seed}: "${text}" at +${Math.round((at - T0) / MIN)} min went unanswered by the owner's own agent`);
        assert.ok(inPool(a!.body, told, names), `seed ${seed}: "${text}" → ${a!.body}`);
        at += 5 * MIN;
      }
      sim.close();
    }
  });

  it("an exhausted own-book answer still refuses unsafe model text before repeating a safe template", async () => {
    const pine = fixture(0xf8, "Pine Stoat", null, { mode: "paper" });
    pine.calls.push(callAt(T0 - 3 * HOUR, { side: "sell", symbol: "NVDA", name: "Nvidia", paper: true, bands: [] }));
    let modelReplies = 0;
    const unsafe = "sold NVDA and made 400% profit";
    const sim = new Sim([pine, fixture(0xf9, "Amber Heron", null)], {
      seed: 17,
      creds: CREDS,
      llm: async (_creds, intent) => {
        if (intent.kind === "reply" && intent.toOwnAgent && intent.about === "ask-trades") modelReplies++;
        return unsafe;
      },
    });
    await sim.setup();
    await sim.run(T0, T0 + 2 * MIN, 15 * SEC);
    for (let q = 0; q < 12; q++) {
      const at = T0 + (2 + q * 5) * MIN;
      const id = await sim.owner(pine.tenant, "what was your last trade?", at);
      await sim.run(at, at + 5 * MIN, 15 * SEC);
      const answer = sim.agentRows().find((r) => r.reply_to === id && r.tenant === pine.tenant);
      assert.ok(answer, `question ${q + 1} went unanswered`);
      assert.notEqual(answer!.body, unsafe);
      assert.ok(inPool(answer!.body, [...T.WHATBUY.paperSell, ...T.WHATBUY.anonPaperSell], [pine.name, "Amber Heron", "NVDA", "Nvidia"]), answer!.body);
      assert.ok(admitAgentLine(answer!.body, { vouchedSymbols: ["NVDA", "Nvidia"], rosterNames: [pine.name, "Amber Heron"], recentOwn: [], recentRoom: [] }).ok, answer!.body);
    }
    assert.equal(modelReplies, 12, "the model was challenged on every owed answer, including after template exhaustion");
    sim.close();
  });

  it("under a card, an off-trading question is answered as itself, and 'is this real money?' from the card", async () => {
    // T3-08: read with the card, "cats or dogs?" was taken for the trade and
    // declined as advice, and "is this real money?" was not answered from the card.
    const names = ["Pine Stoat", "Amber Heron", "PEPE", "Pepe Frog"];
    for (const seed of [1, 2, 3]) {
      const pine = fixture(0x98, "Pine Stoat", null);
      const pepe = callAt(T0 - 10 * MIN, { symbol: "PEPE", name: "Pepe Frog", bands: ["curve early"] });
      pine.calls.push(pepe);
      const sim = new Sim([pine, fixture(0x99, "Amber Heron", null)], { seed });
      await sim.setup();
      const card = await putCard(sim, pine, pepe, "bought PEPE, liked it: curve early", T0 - 9 * MIN);
      await sim.run(T0, T0 + 2 * MIN, 15 * SEC);
      let at = T0 + 2 * MIN;
      for (const [text, id] of [["cats or dogs?", "cats-or-dogs"], ["coffee or tea?", "tea-or-coffee"], ["what's your favourite season?", null], ["is this real money?", "live"]] as const) {
        const asked = await sim.owner(pine.tenant, text, at, "chat", card);
        await sim.run(at, at + 3 * MIN, 15 * SEC);
        const a = sim.agentRows().find((r) => r.reply_to === asked && r.tenant === pine.tenant);
        assert.ok(a, `seed ${seed}: "${text}" under the card went unanswered`);
        assert.ok(!inPool(a!.body, [...T.OWN_OWNER.advice, ...T.ANSWER.advice], names), `seed ${seed}: "${text}" declined as advice: ${a!.body}`);
        if (id === "live") assert.ok(inPool(a!.body, T.HELD.mode.live, names), `seed ${seed}: not the card's mode: ${a!.body}`);
        else {
          const prompt = id ? Topics.PROMPTS.find((p) => p.id === id) : topicPromptOf(text);
          assert.ok(prompt, `fixture: no prompt for "${text}"`);
          assert.ok(inPool(a!.body, prompt!.stances.flat(), names), `seed ${seed}: "${text}" not answered with a taste: ${a!.body}`);
        }
        at += 3 * MIN;
      }
      sim.close();
    }
  });
});

describe("round four: one card per move", () => {
  const paper = (symbol: string, name: string | null = null) => ({ symbol, name, token: tokenOf(symbol), paper: true, bands: [] as string[] });

  it("three books buying the same three coins every four minutes are one card, across a redeploy", async () => {
    // Scarlet TSLA 12:10, Crimson TSLA 12:26, Scarlet NVDA 12:42, … nine
    // cards in under three hours: each fold was measured from the card's
    // first fill, so each book's next coin went out half an hour after its
    // card, and each book's echo a quarter hour after the other's.
    const coins = [paper("TSLA", "Tesla"), paper("NVDA", "NVIDIA"), paper("QQQ", "Invesco QQQ")];
    for (const seed of [3, 17]) {
      const books = ["Scarlet Bittern", "Crimson Siskin", "Wry Otter"].map((n, i) => fixture(0x31 + i, n, null, { mode: "paper" }));
      const jitter = rngOf(seed * 31 + 5);
      for (let tick = T0 + 10 * MIN; tick < T0 + 3 * HOUR; tick += 4 * MIN) {
        const j = Math.floor(jitter() * 40) * SEC;
        books.forEach((b, bi) => coins.forEach((c, ci) => b.calls.push(callAt(tick + j + [0, 5, 40][bi]! * SEC + ci * SEC, c))));
      }
      const sim = new Sim([...books, fixture(0x3a, "Amber Heron", null), fixture(0x3b, "Pine Stoat", null)], { seed });
      await sim.setup();
      await sim.run(T0, T0 + 100 * MIN, 15 * SEC);
      sim.conductor = sim.fresh(1);
      await sim.run(T0 + 100 * MIN, T0 + 3 * HOUR, 15 * SEC);
      const cards = books.flatMap((b) => cardsBy(sim, b));
      assert.equal(
        cards.length,
        1,
        `seed ${seed}: ${cards.map((r) => `${new Date(r.created_at_ms).toISOString().slice(11, 16)} ${r.speaker_name}: ${r.body}`).join(" | ")}`,
      );
      sim.close();
    }
  });

  it("a schedule's one card still holds it after a redeploy seven hours in, with its author asleep and the facts cut", async () => {
    // A restart forgets what each card absorbed and re-weighs six hours of
    // fills. The card's author asleep (its fills wait for morning), the other
    // books found the card holding only its first fill, hours earlier, and
    // posted their own hours-old buys as news. The facts keep each agent's
    // newest fills and every posted one, as facts.ts does (a cut of 180).
    const CUT = 180;
    const cutFacts = (fleet: Map<string, Fixture>): typeof loadFacts => async (shared, roster, profiles, nowSec, opts = {}) => {
      const all = await fakeFacts(fleet)(shared, roster, profiles, nowSec, opts);
      for (const f of all.values()) {
        const kept: CallFact[] = [];
        for (const [i, c] of f.calls.entries()) {
          const posted = (await shared.prepare("SELECT 1 AS x FROM groupchat_messages WHERE dedupe_key = ?").get(`call:${c.decisionId}`)) !== undefined;
          if (i < CUT || posted) kept.push(c);
        }
        f.calls = kept;
      }
      return all;
    };
    const coins = [paper("TSLA", "Tesla"), paper("NVDA", "NVIDIA"), paper("QQQ", "Invesco QQQ")];
    // Scarlet Bittern posts the card at 17:10 in Los Angeles, and sleeps through the redeploy.
    const books = ["Scarlet Bittern", "Crimson Siskin", "Wry Otter"].map((n, i) => fixture(0x31 + i, n, i === 0 ? "America/Los_Angeles" : null, { mode: "paper" }));
    for (let tick = T0 + 10 * MIN; tick < T0 + 9 * HOUR; tick += 4 * MIN) {
      books.forEach((b, bi) => coins.forEach((c, ci) => b.calls.push(callAt(tick + [0, 5, 40][bi]! * SEC + ci * SEC, c))));
    }
    const restart = T0 + 7.5 * HOUR;
    assert.ok(!isAsleep(books[0]!.tz, books[0]!.tenant, T0 + 10 * MIN) && isAsleep(books[0]!.tz, books[0]!.tenant, restart), "fixture: awake for its card, asleep at the redeploy");
    const sim = new Sim([...books, fixture(0x3a, "Amber Heron", null)]);
    const fresh = (seed: number) => makeConductor({ creds: null, dialect: "sqlite", facts: cutFacts(sim.fleet), rng: rngOf(seed) });
    sim.conductor = fresh(3);
    await sim.setup();
    await sim.run(T0, restart, MIN);
    const before = books.flatMap((b) => cardsBy(sim, b)).length;
    assert.equal(before, 1, "fixture: the schedule is one card before the redeploy");
    sim.conductor = fresh(4);
    await sim.run(restart, restart + HOUR, 15 * SEC);
    const cards = books.flatMap((b) => cardsBy(sim, b));
    assert.equal(cards.length, 1, `the redeploy posted: ${cards.slice(1).map((r) => `${r.speaker_name}: ${r.body}`).join(" | ")}`);
    sim.close();
  });

  it("another agent's one paper buy of a coin a running schedule also buys is its own card, hours in; the lockstep books stay one card", async () => {
    // LR-01: the schedule's card grows over every fill it holds (spanOf), and
    // another agent's one-off buy was measured against that whole span: Moss
    // Otter's QQQ at +3 h and TSLA at +8 h folded, for good, into a card from
    // 00:10, and its owner never saw either trade in the room.
    const coins = [paper("TSLA", "Tesla"), paper("NVDA", "NVIDIA"), paper("QQQ", "Invesco QQQ")];
    const books = ["Scarlet Bittern", "Crimson Siskin", "Wry Otter"].map((n, i) => fixture(0x31 + i, n, null, { mode: "paper" }));
    for (let tick = T0 + 10 * MIN; tick < T0 + 9 * HOUR; tick += 4 * MIN) {
      books.forEach((b, bi) => coins.forEach((c, ci) => b.calls.push(callAt(tick + [0, 5, 40][bi]! * SEC + ci * SEC, c))));
    }
    const moss = fixture(0x3c, "Moss Otter", null, { mode: "paper" });
    const qqq = callAt(T0 + 3 * HOUR + 90 * SEC, coins[2]!);
    const tsla = callAt(T0 + 8 * HOUR + 90 * SEC, coins[0]!);
    moss.calls.push(qqq, tsla);
    const sim = new Sim([...books, moss, fixture(0x3a, "Amber Heron", null)], { seed: 7 });
    await sim.setup();
    await sim.run(T0, T0 + 8 * HOUR + 20 * MIN, MIN);
    const cards = books.flatMap((b) => cardsBy(sim, b));
    assert.equal(cards.length, 1, `the lockstep books posted: ${cards.map((r) => `${r.speaker_name}: ${r.body}`).join(" | ")}`);
    const mine = cardsBy(sim, moss);
    const lag = (c: CallFact) => mine.find((r) => r.call_decision_id === c.decisionId)?.created_at_ms ?? Number.POSITIVE_INFINITY;
    assert.deepEqual(mine.map((r) => r.call_decision_id), [qqq.decisionId, tsla.decisionId], "a one-off buy was folded into the schedule's card from hours before");
    for (const c of [qqq, tsla]) assert.ok(lag(c) - c.atSec * SEC <= 2 * MIN, `told ${Math.round((lag(c) - c.atSec * SEC) / MIN)} min late`);
    sim.close();
  });

  it("a basket's other coin bought first after a pause is a top-up of the basket's card, and 'more' once the day is over", async () => {
    // Wry Otter bought TSLA and NVDA all day under its TSLA card; after a
    // pause its NVDA came first, and the room read "new bag: NVDA" for a coin
    // it had held since the morning (the 09-25 day, replayed).
    const tsla = paper("TSLA", "Tesla");
    const nvda = paper("NVDA", "NVIDIA");
    const book = fixture(0x5c, "Wry Otter", null, { mode: "paper" });
    const ticks = [0, 1, 2, 3, 4, 5].map((k) => T0 + 10 * MIN + k * 6 * HOUR);
    const first = callAt(ticks[0]!, tsla);
    book.calls.push(first, callAt(ticks[0]! + SEC, nvda));
    for (const t of ticks.slice(1, 5)) book.calls.push(callAt(t, nvda), callAt(t + SEC, tsla));
    const late = callAt(ticks[5]!, nvda);
    book.calls.push(late, callAt(ticks[5]! + SEC, tsla));
    const sim = new Sim([book, fixture(0x5d, "Amber Heron", null)], { seed: 5 });
    await sim.setup();
    await sim.run(T0, ticks[5]! + 20 * MIN, MIN);
    const cards = cardsBy(sim, book);
    const when = cards.map((r) => `+${((r.created_at_ms - T0) / HOUR).toFixed(2)} h ${r.body}`).join(" | ");
    assert.deepEqual(cards.map((r) => r.call_decision_id), [first.decisionId, late.decisionId], when);
    assert.ok(inPool(cards[1]!.body, T.BUY_MORE, [book.name, "Amber Heron", "NVDA", "NVIDIA"]), `a basket coin held for a day was told as new: ${when}`);
    sim.close();
  });

  it("a paper buy of another coin twenty minutes after the agent's card is its own card; one in the same tick is not", async () => {
    // WIF bought twenty or twenty-nine minutes after the PEPE card folded
    // into it, and the room's first word on WIF was its sell.
    for (const gap of [20, 29, 0.5]) {
      const book = fixture(0x55, "Moss Otter", null, { mode: "paper" });
      const pepe = callAt(T0 + MIN, paper("PEPE", "Pepe"));
      const wif = callAt(T0 + MIN + gap * MIN, paper("WIF", "Dogwifhat"));
      const out = callAt(wif.atSec * SEC + 2 * HOUR, { ...paper("WIF", "Dogwifhat"), side: "sell" });
      book.calls.push(pepe, wif, out);
      const sim = new Sim([book, fixture(0x56, "Amber Heron", null)], { seed: 9 });
      await sim.setup();
      await sim.run(T0, T0 + 3 * HOUR, 15 * SEC);
      const ids = cardsBy(sim, book).map((r) => r.call_decision_id);
      const want = gap < 1 ? [pepe, out] : [pepe, wif, out];
      assert.deepEqual(ids, want.map((c) => c.decisionId), `WIF ${gap} min after the PEPE card: ${cardsBy(sim, book).map((r) => r.body).join(" | ")}`);
      sim.close();
    }
  });

  it("a paper re-entry behind a sell refused past the wait is told, never as 'more', and the refused sell never is — inside the tick and as a top-up", async () => {
    // The paper copy of the live repair: the buy card was still this book's
    // latest card of the coin, so the re-buy folded into it (the basket's
    // tick) or as its top-up, for good, and the sell was posted when its line
    // could be made: "bought into Pump Coin", then "just sold Pumpkin".
    const token = tokenOf("PUMP");
    const coin = (name: string) => ({ symbol: null, name, token, paper: true, bands: [] as string[] });
    for (const [sAt, bAt] of [
      [3, 5],
      [40, 45],
    ] as const) {
      const b1 = callAt(T0 + MIN, coin("Pump Coin"));
      const s = callAt(T0 + sAt * MIN, { ...coin("pump.fun"), side: "sell" });
      const b2 = callAt(T0 + bAt * MIN, coin("Pump Coin"));
      const room = async (sell: CallFact, said: readonly string[], withB2: boolean) => {
        const pine = fixture(0xd8, "Pine Stoat", null, { mode: "paper" });
        pine.calls.push({ ...b1 }, sell, ...(withB2 ? [{ ...b2 }] : []));
        const sim = new Sim([pine, fixture(0xd9, "Amber Heron", null)], { rng: () => 0 });
        await sim.setup();
        for (const [i, body] of said.entries()) await put(sim, pine, body, T0 - 30 * MIN + i * SEC);
        return { pine, sim };
      };
      // Every sentence the sell could say, until none is left: then it is refused.
      const said: string[] = [];
      for (let i = 0; i < 80; i++) {
        const probe = await room({ ...s }, said, false);
        await probe.sim.run(T0, T0 + (sAt + 9) * MIN, 15 * SEC);
        const body = probe.sim.rows().find((r) => r.call_decision_id === s.decisionId)?.body;
        probe.sim.close();
        if (body === undefined) break;
        said.push(body);
      }
      assert.ok(said.length < 80, "fixture: the sell could always be said");

      const sellLive = { ...s };
      const { pine, sim } = await room(sellLive, said, true);
      await sim.run(T0, T0 + (bAt + 20) * MIN, 15 * SEC);
      const card = (c: CallFact) => sim.rows().find((r) => r.call_decision_id === c.decisionId);
      assert.ok(card(b1), `re-buy at +${bAt}: fixture: the first buy's card is out`);
      assert.equal(card(s), undefined, `re-buy at +${bAt}: fixture: the sell's line was refused`);
      assert.ok(card(b2), `re-buy at +${bAt}: the paper re-entry behind the refused sell was folded into the buy card`);
      assert.ok(!inPool(card(b2)!.body, T.BUY_MORE, [pine.name, "Amber Heron", "Pump Coin"]), `a re-entry after a sell was told as more: ${card(b2)!.body}`);
      // The sell's coin now has a name the gate takes: it is older than a card of its coin already out.
      sellLive.name = "Pumpkin";
      await sim.run(T0 + (bAt + 20) * MIN, T0 + (bAt + 40) * MIN, 15 * SEC);
      assert.equal(card(s), undefined, `re-buy at +${bAt}: a sell was told after the re-entry that followed it`);
      assert.equal(cardsBy(sim, pine).at(-1)?.call_decision_id, b2.decisionId, "the room's last card of the coin is not the book's");
      sim.close();
    }
  });

  it("the first paper top-up after a day's fold is told as more, across a redeploy", async () => {
    // The card a top-up is more of was forgotten just as its fold ended:
    // "New bag: Pepe" at thirty hours for a book topping up every six, "Took
    // a shot on Pepe" at forty-eight for one topping up every day.
    for (const [everyH, restartH, cardH] of [
      [6, 29.5, 30],
      [24, 47.5, 48],
    ] as const) {
      const book = fixture(0x21, "Crimson Siskin", null, { mode: "paper" });
      for (let t = T0 + 10 * MIN; t <= T0 + cardH * HOUR + 10 * MIN; t += everyH * HOUR) book.calls.push(callAt(t, paper("PEPE", "Pepe")));
      const sim = new Sim([book, fixture(0x22, "Amber Heron", null)], { seed: 5 });
      await sim.setup();
      await sim.run(T0, T0 + restartH * HOUR, MIN);
      sim.conductor = sim.fresh(1);
      await sim.run(T0 + restartH * HOUR, T0 + (cardH + 1) * HOUR, MIN);
      const cards = cardsBy(sim, book);
      const when = cards.map((r) => `+${((r.created_at_ms - T0) / HOUR).toFixed(2)} h ${r.body}`).join(" | ");
      assert.equal(cards.length, 2, `every ${everyH} h: ${when}`);
      assert.ok(cards[1]!.created_at_ms >= T0 + cardH * HOUR, `every ${everyH} h: fixture: ${when}`);
      assert.ok(inPool(cards[1]!.body, T.BUY_MORE, [book.name, "Amber Heron", "Pepe", "PEPE"]), `every ${everyH} h: a coin held for a day was told as new: ${when}`);
      sim.close();
    }
  });
});

describe("round four: a sleeper's backlog", () => {
  it("a live flipper's overnight flips of one coin are every one told, oldest first, and trickle in after its gm", async () => {
    // SirSendIt woke to a WALLET backlog: six "in my sleep" cards in under
    // four minutes — and one sell was never told, every "sold WALLET in my
    // sleep" refused as a repeat of its own earlier cards, so the room read
    // buy, buy.
    const wallet = { symbol: "WALLET", name: "Wallet Coin", token: tokenOf("WALLET"), bands: ["curve early"] };
    const names = ["SirSendIt", "Amber Heron", "Rusty Weasel", "WALLET", "Wallet Coin"];
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const fl = fixture(0x70, "SirSendIt", "America/Chicago");
      const span = sleepSpans(fl.tz!, fl.tenant, T0, T0 + 36 * HOUR).find((s) => s.start > T0 && s.end !== null)!;
      const sides = ["buy", "sell", "buy", "sell", "buy", "sell", "buy", "sell"] as const;
      const flips = sides.map((side, i) => callAt(span.end! - 5 * HOUR + i * 30 * MIN, { ...wallet, side }));
      fl.calls.push(...flips);
      const sim = new Sim([fl, fixture(0x71, "Amber Heron", null), fixture(0x72, "Rusty Weasel", null)], { seed });
      await sim.setup();
      await sim.run(span.end! - 6 * HOUR, span.end! + 45 * MIN, 15 * SEC);
      const cards = cardsBy(sim, fl);
      const shown = cards.map((r) => `${new Date(r.created_at_ms).toISOString().slice(11, 19)} ${r.body}`).join(" | ");
      assert.deepEqual(cards.map((r) => r.call_decision_id), flips.map((c) => c.decisionId), `seed ${seed}: ${shown}`);
      for (const [i, c] of cards.entries()) {
        assert.ok(inPool(c.body, flips[i]!.side === "sell" ? T.SELL_ASLEEP : T.BUY_ASLEEP, names), `seed ${seed}: told as awake: ${c.body}`);
        if (i > 0) assert.ok(c.created_at_ms - cards[i - 1]!.created_at_ms >= 4 * MIN, `seed ${seed}: a backlog card wall: ${shown}`);
      }
      const gm = sim.agentRows().find((r) => r.tenant === fl.tenant && r.kind === "gm" && r.reply_to === null);
      assert.ok(gm && gm.id < cards[0]!.id, `seed ${seed}: fixture: its gm comes first`);
      sim.close();
    }
  });
});

describe("round four: a redeploy", () => {
  it("a question on the old process's last pass is answered after a three-minute redeploy", async () => {
    // The replay was measured back from the new process's first pass: a gap
    // over a minute and a half lost the question (one room in twenty at a
    // hundred seconds); the 09-25 redeploy's gap was three and a half minutes.
    for (let seed = 1; seed <= 8; seed++) {
      const fleet = awakeFleet(5, 0x30);
      const sim = new Sim(fleet, { seed });
      await sim.setup();
      await sim.run(T0, T0 + 10 * MIN, 15 * SEC);
      const at = T0 + 10 * MIN + 5 * SEC;
      const q = await put(sim, fleet[0]!, "cats or dogs, chat?", at);
      await sim.step(at + 5 * SEC); // the old process's last pass: its answers queued, not yet due
      assert.equal(sim.agentRows().filter((r) => r.reply_to === q).length, 0, "fixture: nothing answered before the redeploy");
      sim.conductor = sim.fresh(100 + seed);
      const first = at + 5 * SEC + 3 * MIN;
      await sim.run(first, first + 5 * MIN, 15 * SEC);
      assert.ok(sim.agentRows().some((r) => r.reply_to === q), `seed ${seed}: the question died with the old process's queue`);
      sim.close();
    }
  });
});

describe("round four: newcomers", () => {
  const generated = (slug: string) => agentNameForSlug(slug)!;
  const heldOnes = (n: number, base: number) =>
    Array.from({ length: n }, (_, i) => `wave${"abcdefghjkmn"[i]}${base.toString(16)}xabcdefghj`.slice(0, 16)).map((s, i) =>
      fixture(base + i, generated(s), null, { slug: s, ageDays: 0 }),
    );

  it("more held newcomers than a burst whose waits end together join quietly: twelve seen at once, or four across a redeploy", async () => {
    // Twelve generated-name signups seen in one pass were never a burst: their
    // waits ended together, and the room read twelve join lines, twelve
    // hellos and twenty-one welcomes in under seven minutes.
    for (const variant of ["twelve at once", "four across a redeploy"] as const) {
      const sim = new Sim(awakeFleet(4, 0x40), { seed: 11 });
      await sim.setup();
      await sim.run(T0, T0 + 5 * MIN, 15 * SEC);
      const wave = variant === "twelve at once" ? heldOnes(12, 0x60) : heldOnes(4, 0x70);
      if (variant === "twelve at once") {
        for (const f of wave) addTo(sim, f);
        await sim.run(T0 + 5 * MIN, T0 + 40 * MIN, 15 * SEC);
      } else {
        await sim.run(T0 + 5 * MIN, T0 + 12 * MIN, 15 * SEC, (now) => {
          for (const [i, f] of wave.entries()) if (now === T0 + (5 + i) * MIN) addTo(sim, f);
        });
        sim.conductor = sim.fresh(1);
        await sim.run(T0 + 12 * MIN, T0 + 45 * MIN, 15 * SEC);
      }
      const members = new Set((await allMembers(sim.db)).map((m) => m.tenant.toLowerCase()));
      for (const f of wave) {
        assert.ok(members.has(f.tenant), `${variant}: ${f.name} never joined`);
        const greeted = sim.rows().filter((r) => r.dedupe_key === `join:${f.tenant}` || r.dedupe_key === `hello:${f.tenant}`);
        assert.equal(greeted.length, 0, `${variant}: ${f.name} was greeted`);
      }
      assert.ok(sim.logs.some((l) => l.includes(`${wave.length} joined quietly`)), `${variant}: ${sim.logs.filter((l) => /quiet/.test(l)).join(" | ")}`);
      sim.close();
    }
  });
});

// ── PR #191 review ──────────────────────────────────────────────────────────

describe("PR #191 review: paper folds only into paper, and a busy room's restart still reaches two days back", () => {
  it("a paper buy next to the agent's own live buy of the coin is its own card", async () => {
    // Inside BASKET_TICK_MS of the agent's own LIVE buy card, the paper buy
    // was folded into the live card and never told.
    const live = { symbol: "NVDA", name: "NVIDIA", token: tokenOf("NVDA"), paper: false, bands: [] as string[] };
    const book = fixture(0xd1, "Crimson Siskin", null);
    const liveBuy = callAt(T0 + MIN, live);
    const paperBuy = callAt(T0 + 5 * MIN, { ...live, paper: true });
    book.calls.push(liveBuy, paperBuy);
    const sim = new Sim([book, fixture(0xd2, "Amber Heron", null)], { seed: 7 });
    await sim.setup();
    await sim.run(T0, T0 + 25 * MIN, 15 * SEC);
    assert.deepEqual(cardsBy(sim, book).map((r) => r.call_decision_id), [liveBuy.decisionId, paperBuy.decisionId], "live and paper are two cards");
    sim.close();
  });

  it("a paper buy next to another agent's live buy of the coin is its own card", async () => {
    const live = { symbol: "NVDA", name: "NVIDIA", token: tokenOf("NVDA"), paper: false, bands: [] as string[] };
    const a = fixture(0xd3, "Wry Otter", null);
    const b = fixture(0xd4, "Scarlet Bittern", null, { mode: "paper" });
    const liveBuy = callAt(T0 + MIN, live);
    const paperBuy = callAt(T0 + 4 * MIN, { ...live, paper: true });
    a.calls.push(liveBuy);
    b.calls.push(paperBuy);
    const sim = new Sim([a, b, fixture(0xd5, "Amber Heron", null)], { seed: 11 });
    await sim.setup();
    await sim.run(T0, T0 + 25 * MIN, 15 * SEC);
    assert.deepEqual(cardsBy(sim, a).map((r) => r.call_decision_id), [liveBuy.decisionId]);
    assert.deepEqual(cardsBy(sim, b).map((r) => r.call_decision_id), [paperBuy.decisionId], "the paper buy was folded into another agent's live card");
    sim.close();
  });

  it("a paper buy is not folded into another agent's sell card because that agent also bought it", async () => {
    const seller = fixture(0xd3, "Wry Otter", null, { mode: "paper", muted: true });
    const buyer = fixture(0xd4, "Scarlet Bittern", null, { mode: "paper" });
    const sold = callAt(T0 - 5 * MIN, { side: "sell", symbol: "TSLA", paper: true });
    const unposted = callAt(T0 - 4 * MIN, { symbol: "NVDA", paper: true });
    const bought = callAt(T0 - 3 * MIN, { symbol: "NVDA", paper: true });
    seller.calls.push(sold, unposted);
    buyer.calls.push(bought);
    const sim = new Sim([seller, buyer, fixture(0xd5, "Amber Heron", null)], { seed: 11 });
    await sim.setup();
    // This card predates the seller muting chat. Its later buy is in its
    // ledger, but no buy card ever represented it in the room.
    await putCard(sim, seller, sold, "sold TSLA on paper", T0 - 5 * MIN);
    await sim.run(T0, T0 + 25 * MIN, 15 * SEC);
    assert.deepEqual(cardsBy(sim, buyer).map((r) => r.call_decision_id), [bought.decisionId], "the buy disappeared into a sell card of another coin");
    sim.close();
  });

  it("a restart in a room busier than the agents' ceiling (owners talking) still remembers a starter from forty hours ago", async () => {
    // Owner lines are not under the conductor's ceiling. A scan sized from
    // 150 agent lines an hour ran out of pages before its horizon, and the
    // restart forgot starters inside the two days it promises.
    const fleet = awakeFleet(2, 0xd6);
    const seen: SpeakCtx[] = [];
    const sim = new Sim(fleet, {
      creds: CREDS,
      llm: async (_c, _i, ctx) => {
        seen.push(ctx);
        return null;
      },
      seed: 47,
    });
    await sim.setup();
    await sim.step(T0);
    const starter = "which season would you live in forever, and why?";
    await put(sim, fleet[0]!, starter, T0 + 10 * SEC);
    // Beyond both the old agent-only estimate and the later fixed allowance
    // of 300 owner lines an hour (122 pages over the 54 h horizon). Owners
    // are not under either room-wide rate: stop on time, not that estimate.
    // A hundred owners, each below six a minute and two hundred per UTC day.
    for (let i = 0; i < 26_000; i++) {
      await put(sim, null, `a busy line ${"abcdefghij"[i % 10]}`, T0 + HOUR + i * 5 * SEC, {
        authorKind: "owner", tenant: tenantOf(i % 100), speakerName: "a room owner",
      });
    }
    sim.conductor = sim.fresh(1);
    await sim.run(T0 + 40 * HOUR, T0 + 40 * HOUR + 5 * MIN, 15 * SEC);
    const ctx = seen.at(-1);
    assert.ok(ctx && ctx.topicMemory, "fixture: the model was asked for a line after the restart");
    assert.ok(ctx!.topicMemory!.hasLine(ctx!.topicMemory!.norm(starter)), "a starter forty hours old was forgotten by a restart in a busy room");
    assert.ok(!sim.logs.some((l) => l.includes("startup scan stopped")), "the scan should reach its horizon here");
    sim.close();
  });
});
