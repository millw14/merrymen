/**
 * THE FACT LAYER, RUN AGAINST THE REAL LEDGER SCHEMA.
 *
 * Every table here is created by `applyLedgerSchema` — the same statements the
 * shared Postgres is built from — so a column this module reads that the
 * ledger does not have fails here rather than on the first pass in production.
 * The seed is written to look like the fleet does: most decisions never become
 * a call, and the ones that must never reach the room carry distinctive private
 * figures so their absence can be asserted on the serialised output rather
 * than argued from the code.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { agentNameForSlug, DEFAULT_AGENT_NAME } from "../../../packages/core/src/agent-name";
import { CASH } from "../../../packages/core/src/tokens";
import { everyBand } from "../class-evidence";
import { wrapSqlite, type Db } from "../db";
import { resetIdentityStoreForTest } from "../identity-store";
import { applyLedgerSchema } from "../store";
import {
  cachedIdentities,
  CALLS_PER_AGENT,
  callsSql,
  chatProfileOf,
  loadFacts,
  roomName,
  rosterSql,
  settleRoomNames,
  type AgentFacts,
  type ChatProfile,
} from "./facts";
import { appendMessage, ensureGroupchatSchema } from "./store";

const NOW = 1_790_000_000;

const T1 = "0x00000000000000000000000000000000000000b1";
const T2 = "0x00000000000000000000000000000000000000b2";
const T3 = "0x00000000000000000000000000000000000000b3";
const T4 = "0x00000000000000000000000000000000000000b4";
const T5 = "0x00000000000000000000000000000000000000b5";
const TRH = "0x00000000000000000000000000000000000000b6";

// Mixed case on purpose: the roster and the ledger do not agree on case in production.
const A1 = "0x00000000000000000000000000000000000000A1";
const A2 = "0x00000000000000000000000000000000000000a2";
const A3 = "0x00000000000000000000000000000000000000a3";
const A4 = "0x00000000000000000000000000000000000000a4";
const A5 = "0x00000000000000000000000000000000000000a5";
const ARH = "rh:55501234";

const SLUG1 = "abcdefghjkmnpqrs";
const SLUG2 = "0123456789abcdef";
const SLUG3 = "vwxyz0123456789a";

const OWNER = "0x000000000000000000000000000000000000bEEF";
const SESSION = "0x000000000000000000000000000000000000c0DE";
const COIN1 = "0xAbCdEf0000000000000000000000000000000001";
const TSLA = "0x0000000000000000000000000000000000007e5a";
const COIN2 = "0x0000000000000000000000000000000000000002";

// Private figures and strings that must never appear in any fact.
const SIZE = 4242.42;
const AMOUNT = 7777.77;
const RAW_DEPTH = 912.34;
const REASON_FIGURE = "555.55";
const SIGNALS = '{"cash": 31337.31}';
const BLOCKER = "no-gas: send eth to fund";
const PRIVY_NAME = "Privy Person Name";

async function agent(db: Db, a: { id: string; name: string; mode: string | null }): Promise<void> {
  await db
    .prepare(
      `INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, mode, live_blocker, hwm_usdg)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(a.id, a.name, OWNER, SESSION, 4663, '{"perTradeUsdg": 6060.6}', NOW - 999, NOW + 99_999, a.mode, BLOCKER, 8181.81);
}

let seq = 0;
async function decision(
  db: Db,
  d: {
    agent: string;
    source: string;
    action: string | null;
    at: number;
    symbol?: string;
    reason?: string | null;
    dropped?: string;
    evidence?: unknown;
    displayName?: string;
    holdKind?: string;
  },
): Promise<string> {
  const id = `dec-${++seq}`;
  await db
    .prepare(
      `INSERT INTO decisions (id, agent_id, source, symbol, action, size_usdg, reason, dropped_rule, signals_json, hold_kind, evidence_json, display_name, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      d.agent,
      d.source,
      d.symbol ?? null,
      d.action,
      SIZE,
      d.reason === undefined ? "a reason we wrote" : d.reason,
      d.dropped ?? null,
      SIGNALS,
      d.holdKind ?? null,
      d.evidence === undefined ? null : JSON.stringify(d.evidence),
      d.displayName ?? null,
      d.at,
    );
  return id;
}

async function trade(
  db: Db,
  t: { agent: string; decision: string; status: string; buy?: string; sell?: string; rule?: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, status, reject_rule, decision_id, created_at)
       VALUES (?, 'swap', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(t.agent, t.agent, t.sell ?? null, t.buy ?? null, AMOUNT, t.status, t.rule ?? null, t.decision, NOW);
}

async function post(db: Db, agentId: string, decisionId: string, body: string): Promise<void> {
  await db.prepare(`INSERT INTO posts (agent_id, decision_id, body, created_at) VALUES (?, ?, ?, ?)`).run(agentId, decisionId, body, NOW);
}

/** A Db that records every statement it was asked to prepare. */
function spy(db: Db): { db: Db; sql: string[] } {
  const sql: string[] = [];
  const wrapped: Db = {
    prepare(text: string) {
      sql.push(text);
      return db.prepare(text);
    },
    exec: (text) => db.exec(text),
    tx: (fn) => db.tx(fn),
  };
  return { db: wrapped, sql };
}

const identities = async () =>
  new Map<string, { slug: string; createdAt: number }>([
    [T1, { slug: SLUG1, createdAt: NOW - 3 * 86_400 - 10 }],
    // Milliseconds, as a careless writer would store it: still ten days.
    [T2, { slug: SLUG2, createdAt: (NOW - 10 * 86_400) * 1000 }],
    [T3, { slug: SLUG3, createdAt: NOW - 60 }],
    [T5, { slug: "not-a-slug", createdAt: NOW }],
  ]);

const ROSTER = [
  { tenant: T1, agentId: A1.toLowerCase() },
  { tenant: T2.toUpperCase().replace("0X", "0x"), agentId: A2 },
  { tenant: T3, agentId: A3 },
  { tenant: T4, agentId: A4 },
  { tenant: T5, agentId: A5 },
  { tenant: TRH, agentId: ARH },
];

const PROFILES = new Map<string, ChatProfile>([[T1, { strategy: "trencher", traits: ["moves early and does not wait around"] }]]);

const ids = {} as Record<
  "classBuy" | "paperBuy" | "sell" | "addressPost" | "retried" | "addressName" | "longPost" | "old" | "never" | "a2" | "rh" | "stranger",
  string
>;

async function seed(db: Db): Promise<void> {
  await applyLedgerSchema(db);
  await agent(db, { id: A1, name: "Robin", mode: "paper" });
  await agent(db, { id: A2, name: "Maid Marian", mode: "live" });
  await agent(db, { id: A3, name: "0xdeadbeefcafe", mode: null });
  await agent(db, { id: A4, name: "", mode: "weird" });
  await agent(db, { id: A5, name: "Robin", mode: "live" });
  await agent(db, { id: ARH, name: "Broker Bob", mode: "live" });

  // ── A1: the calls that must appear ─────────────────────────────────────────
  ids.classBuy = await decision(db, {
    agent: A1,
    source: "class-route",
    action: "buy",
    at: NOW - 100,
    symbol: "T1A2B3C4D5E6",
    displayName: "Cash Cat 🐱 / WETH 1%",
    evidence: {
      act: "enter",
      symbol: "T1A2B3C4D5E6",
      decidedBy: "rule",
      bands: {
        depth: "liquidity thin",
        curve: "curve early",
        thesis: "to the moon, a hundred x",
        again: "liquidity thin",
        bogus: 12,
      },
      raw: { depthUsdg: RAW_DEPTH, usdg: 5 },
    },
  });
  await trade(db, { agent: A1, decision: ids.classBuy, status: "landed", buy: COIN1, sell: CASH.USDG });
  await post(db, A1, ids.classBuy, "  Liking how early this curve still is, so keeping it small and watching.  ");

  ids.paperBuy = await decision(db, { agent: A1, source: "strategy:steady-basket", action: "buy", at: NOW - 200, symbol: "TSLA" });
  await trade(db, { agent: A1, decision: ids.paperBuy, status: "paper", buy: TSLA, sell: CASH.USDG });

  ids.sell = await decision(db, { agent: A1, source: "strategy:steady-basket", action: "sell", at: NOW - 300, symbol: "TSLA" });
  await trade(db, { agent: A1, decision: ids.sell, status: "landed", buy: CASH.USDG, sell: TSLA });

  // A model reason with a figure in it, and a post that names an address.
  ids.addressPost = await decision(db, {
    agent: A1,
    source: "strategist",
    action: "buy",
    at: NOW - 400,
    symbol: "NVDA",
    reason: `buying because cash sits at ${REASON_FIGURE} idle`,
  });
  await trade(db, { agent: A1, decision: ids.addressPost, status: "landed", buy: CASH.USDG, sell: CASH.USDG });
  await post(db, A1, ids.addressPost, "Sent the rest to 0x1234567890abcdef just in case.");

  // Retried: rejected first, then landed. The latest trade is the outcome.
  ids.retried = await decision(db, { agent: A1, source: "strategy:even-keel", action: "buy", at: NOW - 500, symbol: "AAPL" });
  await trade(db, { agent: A1, decision: ids.retried, status: "rejected", rule: "slippage" });
  await trade(db, { agent: A1, decision: ids.retried, status: "landed", buy: COIN2 });

  // An address-shaped coin name costs the call its name, not the call.
  ids.addressName = await decision(db, {
    agent: A1,
    source: "brain",
    action: "buy",
    at: NOW - 600,
    symbol: "T0000000000A",
    displayName: "0xdeadbeef0000",
  });
  await trade(db, { agent: A1, decision: ids.addressName, status: "landed", buy: COIN2 });

  // A long post is clipped exactly as the feed clips it.
  ids.longPost = await decision(db, { agent: A1, source: "class-route", action: "sell", at: NOW - 700, symbol: "T1A2B3C4D5E6" });
  await trade(db, { agent: A1, decision: ids.longPost, status: "landed", sell: COIN1, buy: CASH.USDG });
  await post(db, A1, ids.longPost, `${"Left before the curve got crowded and the exit got thin. ".repeat(6)}`);

  // Outside the six-hour window.
  ids.old = await decision(db, { agent: A1, source: "strategy:steady-basket", action: "buy", at: NOW - 7 * 3600, symbol: "AMD" });
  await trade(db, { agent: A1, decision: ids.old, status: "landed", buy: TSLA });

  // ── A1: the decisions that must never appear ──────────────────────────────
  const never: Record<string, string> = {};
  never.refused = await decision(db, { agent: A1, source: "class-route", action: "buy", at: NOW - 110, symbol: "T1A2B3C4D5E6" });
  await trade(db, { agent: A1, decision: never.refused, status: "rejected", rule: "no-cash" });
  never.strategistRefused = await decision(db, { agent: A1, source: "strategist", action: "buy", at: NOW - 111, symbol: "MSFT" });
  await trade(db, { agent: A1, decision: never.strategistRefused, status: "rejected", rule: "per-trade-cap" });
  never.reverted = await decision(db, { agent: A1, source: "strategist", action: "buy", at: NOW - 120, symbol: "AMZN" });
  await trade(db, { agent: A1, decision: never.reverted, status: "reverted", buy: TSLA });
  never.pending = await decision(db, { agent: A1, source: "strategist", action: "sell", at: NOW - 130, symbol: "AMZN" });
  await trade(db, { agent: A1, decision: never.pending, status: "submitted", sell: TSLA });
  never.dropped = await decision(db, {
    agent: A1,
    source: "strategist",
    action: "buy",
    at: NOW - 140,
    symbol: "PLTR",
    dropped: "#0 PLTR: exceeds available cash",
  });
  never.shadow = await decision(db, { agent: A1, source: "brain-shadow", action: "buy", at: NOW - 150, symbol: "META" });
  never.noTrade = await decision(db, { agent: A1, source: "strategist", action: "buy", at: NOW - 155, symbol: "META" });
  never.hold = await decision(db, { agent: A1, source: "strategy:steady-basket", action: "hold", at: NOW - 160, symbol: "TSLA" });
  await trade(db, { agent: A1, decision: never.hold, status: "landed", buy: TSLA });
  never.chat = await decision(db, { agent: A1, source: "chat", action: "buy", at: NOW - 170, symbol: "TSLA" });
  await trade(db, { agent: A1, decision: never.chat, status: "landed", buy: TSLA });
  never.selftest = await decision(db, { agent: A1, source: "selftest", action: "buy", at: NOW - 180, symbol: "TSLA" });
  await trade(db, { agent: A1, decision: never.selftest, status: "paper", buy: TSLA });
  never.ownFile = await decision(db, { agent: A1, source: "strategy:my-own-file", action: "buy", at: NOW - 185, symbol: "TSLA" });
  await trade(db, { agent: A1, decision: never.ownFile, status: "landed", buy: TSLA });
  never.vault = await decision(db, { agent: A1, source: "strategy:steady-basket", action: "vault-deposit", at: NOW - 190 });
  await trade(db, { agent: A1, decision: never.vault, status: "landed" });
  // Landed, then a later rejected retry: the outcome is the refusal.
  never.laterRefused = await decision(db, { agent: A1, source: "strategist", action: "buy", at: NOW - 195, symbol: "INTC" });
  await trade(db, { agent: A1, decision: never.laterRefused, status: "landed", buy: TSLA });
  await trade(db, { agent: A1, decision: never.laterRefused, status: "rejected", rule: "slippage" });
  // An operational notice is not a thesis, and with no post there is nothing to say.
  never.operational = await decision(db, {
    agent: A1,
    source: "strategy:steady-basket",
    action: "buy",
    at: NOW - 196,
    symbol: "TSLA",
    reason: "error: rpc failed",
  });
  await trade(db, { agent: A1, decision: never.operational, status: "landed", buy: TSLA });
  // A trade row filed under ANOTHER agent against this decision.
  never.foreignTrade = await decision(db, { agent: A1, source: "strategist", action: "buy", at: NOW - 197, symbol: "MU" });
  await trade(db, { agent: A2, decision: never.foreignTrade, status: "landed", buy: TSLA });
  // A gate-forced hold kind riding a buy is still not a view.
  never.forced = await decision(db, {
    agent: A1,
    source: "brain",
    action: "buy",
    at: NOW - 198,
    symbol: "TSLA",
    holdKind: "GATE_FORCED_HOLD",
  });
  await trade(db, { agent: A1, decision: never.forced, status: "landed", buy: TSLA });
  ids.never = JSON.stringify(Object.values(never));

  // ── A2: live, named, one brain call ───────────────────────────────────────
  ids.a2 = await decision(db, { agent: A2, source: "brain", action: "buy", at: NOW - 50, symbol: "T00000000001" });
  await trade(db, { agent: A2, decision: ids.a2, status: "landed", buy: COIN2 });

  // ── the brokerage rail: landed and publishable-looking, and never a call ──
  ids.rh = await decision(db, { agent: ARH, source: "strategy:steady-basket", action: "buy", at: NOW - 60, symbol: "TSLA" });
  await trade(db, { agent: ARH, decision: ids.rh, status: "landed", buy: TSLA });

  // ── someone not on the roster ─────────────────────────────────────────────
  ids.stranger = await decision(db, {
    agent: "0x00000000000000000000000000000000000000ff",
    source: "strategy:steady-basket",
    action: "buy",
    at: NOW - 70,
    symbol: "TSLA",
  });
  await trade(db, { agent: "0x00000000000000000000000000000000000000ff", decision: ids.stranger, status: "landed", buy: TSLA });
}

describe("chatProfileOf", () => {
  it("resolves an owner who saved nothing to what the child runs, and names it", () => {
    assert.deepEqual(chatProfileOf(null), { strategy: "steady-basket", traits: [] });
    assert.deepEqual(chatProfileOf(undefined), { strategy: "steady-basket", traits: [] });
    assert.deepEqual(chatProfileOf({}), { strategy: "steady-basket", traits: [] });
    assert.deepEqual(chatProfileOf("steady-basket"), { strategy: "steady-basket", traits: [] });
    assert.deepEqual(chatProfileOf([]), { strategy: "steady-basket", traits: [] });
  });

  it("names only a strategy on the publication list", () => {
    assert.equal(chatProfileOf({ strategy: "dip-hunter" }).strategy, "dip-hunter");
    assert.equal(chatProfileOf({ strategy: " trencher " }).strategy, "trencher");
    assert.equal(chatProfileOf({ strategy: "llm-strategist" }).strategy, null, "model trust is not on the list");
    assert.equal(chatProfileOf({ strategy: "my-secret-edge" }).strategy, null, "a tenant's own file is a string we did not write");
    // Malformed falls to the default, exactly as settings.ts resolves it.
    assert.equal(chatProfileOf({ strategy: "../../etc/passwd" }).strategy, "steady-basket");
    assert.equal(chatProfileOf({ strategy: 42 }).strategy, "steady-basket");
  });

  it("derives traits relative to the shipped defaults, through traitsOf", () => {
    assert.deepEqual(chatProfileOf({ classMaxHoldSec: 1800 }).traits, ["moves early and does not wait around"]);
    assert.deepEqual(chatProfileOf({ classMinDepthUsdg: 1000 }).traits, ["wants real liquidity before committing"]);
    assert.deepEqual(chatProfileOf({ classExitAtGraduationPct: 50 }).traits, ["leaves well before the curve graduates"]);
    assert.deepEqual(chatProfileOf({ maxImpactBps: 100 }).traits, ["dislikes pushing a price around"]);
  });

  it("ignores a value the child itself would refuse, so no trait is claimed from it", () => {
    // Below settings.ts's 60 s floor: the child runs the default, so there is no trait.
    assert.deepEqual(chatProfileOf({ classMaxHoldSec: 10 }).traits, []);
    assert.deepEqual(chatProfileOf({ classMaxHoldSec: "1800" }).traits, []);
    assert.deepEqual(chatProfileOf({ maxImpactBps: Number.NaN }).traits, []);
    assert.deepEqual(chatProfileOf({ classExitAtGraduationPct: 0 }).traits, []);
  });
});

describe("roomName", () => {
  it("keeps a name the owner chose", () => {
    assert.equal(roomName("Maid Marian", SLUG1), "Maid Marian");
    assert.equal(roomName("  Maid   Marian ", null), "Maid Marian");
  });

  it("replaces the stock Robin, an empty name and an address with the slug's name", () => {
    const generated = agentNameForSlug(SLUG1);
    assert.ok(generated);
    assert.equal(roomName(DEFAULT_AGENT_NAME, SLUG1), generated);
    assert.equal(roomName("", SLUG1), generated);
    assert.equal(roomName(null, SLUG1), generated);
    assert.equal(roomName("0xdeadbeefcafe", SLUG1), generated);
    assert.equal(roomName("rh:12345", SLUG1), generated);
    assert.equal(roomName("evil‮eman", SLUG1), generated, "a bidi override fails the stored-name rule");
  });

  it("never falls back to an address when there is no slug to seed on", () => {
    assert.equal(roomName("0xdeadbeefcafe", null), DEFAULT_AGENT_NAME);
    assert.equal(roomName("", null), DEFAULT_AGENT_NAME);
    assert.equal(roomName(DEFAULT_AGENT_NAME, null), DEFAULT_AGENT_NAME);
  });

  it("replaces a name the room's own gate would refuse as an address, a link or a secret", () => {
    // Each of these fits the stored-name rule and would head every line the
    // agent writes, and sit in the public presence list, without passing a door.
    const generated = agentNameForSlug(SLUG1);
    for (const name of [
      "0XDEADBEEF12345678",
      "A0x1234567",
      "d8da6bf26964af9d7eed9e03",
      "pump.fun",
      "vitalik.eth",
      "t.me",
      "evil.com",
      "t.me/x",
      "@elonmusk",
      "sk-proj1234567890abcdef",
      "AKIAABCDEFGHIJKLMNOP",
    ]) {
      assert.equal(roomName(name, SLUG1), generated, name);
      assert.equal(roomName(name, null), DEFAULT_AGENT_NAME, name);
    }
  });

  it("replaces a name that reads as an owner's label, which heads every owner line", () => {
    // The web route labels an owner's line "<agent>'s owner"; an agent named
    // that would post as a person. Any case, any apostrophe, or none.
    const generated = agentNameForSlug(SLUG1);
    for (const name of [
      "Bob's owner",
      "BOB'S OWNER",
      "Bob’s Owner",
      "Bobʼs owner",
      "Bobʻs owner",
      "Bobs' owner",
      "Bob s owner",
      "Bob'sOwner",
      "Bob's owners",
      "Robin's human",
      "owner",
      "Owner",
      "OWNERS",
      "the owner",
      "human",
      "Humans",
      "Own-er",
      "ᴏᴡɴᴇʀ",
    ]) {
      assert.equal(roomName(name, SLUG1), generated, name);
      assert.equal(roomName(name, null), DEFAULT_AGENT_NAME, name);
    }
  });

  it("replaces a name that reads as the room's own voice, in any case, spacing or lookalike", () => {
    const generated = agentNameForSlug(SLUG1);
    for (const name of [
      "merrymen",
      "Merrymen",
      "MERRYMEN",
      "Merry Men",
      "merry-men",
      "m.e.r.r.y.m.e.n",
      "Mеrrymen", // Cyrillic е
      "ᴍᴇʀʀʏᴍᴇɴ",
      "merry‍men",
      "mérrymen",
    ]) {
      assert.equal(roomName(name, SLUG1), generated, JSON.stringify(name));
      assert.equal(roomName(name, null), DEFAULT_AGENT_NAME, JSON.stringify(name));
    }
  });

  it("knows the room's voice by the name the conductor actually posts under", () => {
    const src = readFileSync(join(import.meta.dirname, "conductor.ts"), "utf8");
    const system = /const SYSTEM_NAME = "([^"]+)"/.exec(src)?.[1];
    assert.ok(system, "conductor.ts names its system speaker");
    assert.equal(roomName(system, SLUG1), agentNameForSlug(SLUG1));
  });

  it("replaces an owner's label with a trailing mark, a dropped apostrophe, or an apostrophe drawn some other way", () => {
    // Every one of these passes the stored-name rule, so an owner can type it
    // today, and each would head the agent's lines as another agent's owner.
    const generated = agentNameForSlug(SLUG1);
    for (const name of [
      "Pine Stoat's owner.",
      "Pine Stoat's owner-",
      "Pine Stoat's owner'",
      "Pine Stoat's owner .",
      "Pine Stoats owner",
      "Pine Stoats Owner",
      "Pine Stoats human",
      "Bobs owner",
      "Pine Stoat̕s owner", // COMBINING COMMA ABOVE RIGHT
      "Pine Stoat̓s owner", // COMBINING COMMA ABOVE
      "Pine Stoat̒s owner", // COMBINING TURNED COMMA ABOVE
      "Pine Stoat̔s owner", // COMBINING REVERSED COMMA ABOVE
      "Pine Stoat̛s owner", // COMBINING HORN
      "Pine Stoat̓s owner", // COMBINING GREEK KORONIS
      "Pine Stoatˮs owner", // MODIFIER LETTER DOUBLE APOSTROPHE
      "Pine Stoatՙs owner", // ARMENIAN MODIFIER LETTER LEFT HALF RING
      "Pine Stoatߴs owner", // NKO HIGH TONE APOSTROPHE
      "Pine Stoatߵs owner", // NKO LOW TONE APOSTROPHE
    ]) {
      assert.equal(roomName(name, SLUG1), generated, JSON.stringify(name));
      assert.equal(roomName(name, null), DEFAULT_AGENT_NAME, JSON.stringify(name));
    }
    for (const name of ["Owner 2", "Agent 47", "Chris Owner", "Mrs Owner"]) assert.equal(roomName(name, SLUG1), name, name);
  });

  it("keeps a name that only mentions an owner, or is simply not Latin", () => {
    for (const name of ["Chris Owner", "Owner Of Bob", "Mrs Owner", "Humane Hare", "Merry Marten", "Робин", "Deadbeef"]) {
      assert.equal(roomName(name, SLUG1), name, name);
    }
  });

  it("replaces a name that reads as a figure, which every model would be shown as who is talking", () => {
    const generated = agentNameForSlug(SLUG1);
    for (const name of ["Up 400x", "Up 1000 percent", "10k Club", "$100 Gang"]) assert.equal(roomName(name, SLUG1), generated, name);
    // Digits are not a figure by themselves.
    for (const name of ["Agent 47", "B2B", "Mr. Robin", "Zoë"]) assert.equal(roomName(name, SLUG1), name);
  });
});

describe("one name per agent across the fleet", () => {
  /** A ledger with these agents rows, and the names loadFacts gives the roster. */
  async function named(
    rows: [string, string][],
    roster: { tenant: string; agentId: string }[],
    idents: [string, { slug: string; createdAt: number; accounts?: string[] }][],
  ): Promise<Map<string, AgentFacts>> {
    const r = new DatabaseSync(":memory:");
    const d = wrapSqlite(r);
    try {
      await applyLedgerSchema(d);
      for (const [id, name] of rows) await agent(d, { id, name, mode: "live" });
      return await loadFacts(d, roster, new Map(), NOW, { identities: async () => new Map(idents) });
    } finally {
      r.close();
    }
  }

  it("two roster agents named 'Pine Stoat' and 'Pine Stoatㅤ': the first minted keeps it, the other takes its slug's name", async () => {
    const roster = [
      { tenant: T1, agentId: A1 },
      { tenant: T2, agentId: A2 },
    ];
    const rows: [string, string][] = [
      [A1, "Pine Stoatㅤ"], // a Hangul filler: invisible, and a letter to the name rule
      [A2, "Pine Stoat"],
    ];
    const t2First = await named(rows, roster, [
      [T1, { slug: SLUG1, createdAt: NOW - 60 }],
      [T2, { slug: SLUG2, createdAt: NOW - 86_400 }],
    ]);
    assert.equal(t2First.get(T2)!.name, "Pine Stoat");
    assert.equal(t2First.get(T1)!.name, agentNameForSlug(SLUG1));
    // Mint order decides — not the roster's order or the rows'. A millisecond stamp is still a stamp.
    const t1First = await named(rows, roster, [
      [T1, { slug: SLUG1, createdAt: (NOW - 86_400) * 1000 }],
      [T2, { slug: SLUG2, createdAt: NOW - 60 }],
    ]);
    assert.equal(t1First.get(T1)!.name, "Pine Stoatㅤ");
    assert.equal(t1First.get(T2)!.name, agentNameForSlug(SLUG2));
  });

  it("a name reads the same through case, punctuation, lookalikes and invisibles; a different name is untouched", async () => {
    const idents: [string, { slug: string; createdAt: number }][] = [
      [T1, { slug: SLUG1, createdAt: NOW - 3000 }],
      [T2, { slug: SLUG2, createdAt: NOW - 2000 }],
      [T3, { slug: SLUG3, createdAt: NOW - 1000 }],
    ];
    const roster = [
      { tenant: T1, agentId: A1 },
      { tenant: T2, agentId: A2 },
      { tenant: T3, agentId: A3 },
    ];
    for (const copy of ["PINE-STOAT", "Pine Stoat.", "Pіne Stoat", "Pine‍ Stoat", "Pine  Stoat", "PineStoat"]) {
      const out = await named([[A1, "Pine Stoat"], [A2, copy], [A3, "Pine Marten"]], roster, idents);
      assert.equal(out.get(T1)!.name, "Pine Stoat", copy);
      assert.equal(out.get(T2)!.name, agentNameForSlug(SLUG2), JSON.stringify(copy));
      assert.equal(out.get(T3)!.name, "Pine Marten", copy);
    }
  });

  it("is settled against the whole fleet, not only the agents this replica runs", async () => {
    // T3 holds "Pine Stoat" and is not on this roster (another replica, or not running).
    const idents: [string, { slug: string; createdAt: number; accounts?: string[] }][] = [
      [T1, { slug: SLUG1, createdAt: NOW - 60 }],
      [T3, { slug: SLUG3, createdAt: NOW - 86_400, accounts: [A3.toUpperCase().replace("0X", "0x"), A4] }],
    ];
    const later = await named([[A1, "Pine Stoat"], [A3, "Pine Stoat"]], [{ tenant: T1, agentId: A1 }], idents);
    assert.equal(later.get(T1)!.name, agentNameForSlug(SLUG1), "a later agent took an earlier one's name");
    // …and an off-roster agent minted later takes nothing from one that is here.
    const earlier = await named([[A1, "Pine Stoat"], [A3, "Pine Stoat"]], [{ tenant: T1, agentId: A1 }], [
      [T1, { slug: SLUG1, createdAt: NOW - 86_400 }],
      [T3, { slug: SLUG3, createdAt: NOW - 60, accounts: [A3] }],
    ]);
    assert.equal(earlier.get(T1)!.name, "Pine Stoat");
  });

  it("settleRoomNames: first minted first, a generated name counts, and the loser's fallback is claimed too", () => {
    const names = new Map<string, unknown>([
      [A1.toLowerCase(), "Robin"], // T1 unnamed: its slug's generated name
      [A2, agentNameForSlug(SLUG1)], // T2 chose exactly T1's generated name, later
      [A3, agentNameForSlug(SLUG2)], // T3 chose T2's generated name, later still
    ]);
    const out = settleRoomNames(
      [
        { tenant: T3, slug: SLUG3, account: A3, mintedAt: NOW - 10 },
        { tenant: T2, slug: SLUG2, account: A2, mintedAt: NOW - 20 },
        { tenant: T1, slug: SLUG1, account: A1, mintedAt: NOW - 30 },
      ],
      names,
    );
    assert.equal(out.get(T1), agentNameForSlug(SLUG1));
    assert.equal(out.get(T2), agentNameForSlug(SLUG2), "lost its chosen name to T1's generated one");
    assert.equal(out.get(T3), agentNameForSlug(SLUG3), "lost its chosen name to T2's fallback");
  });
});

describe("cachedIdentities", () => {
  const row = (tenant: string, slug: string) => ({ tenant, slug, createdAt: NOW, displayName: PRIVY_NAME });

  function counting(rows: () => ReturnType<typeof row>[]) {
    let reads = 0;
    return {
      read: async () => {
        reads += 1;
        return rows();
      },
      get reads() {
        return reads;
      },
    };
  }

  it("reads the store once, not once a pass", async () => {
    const store = counting(() => [row(T1, SLUG1), row(T2, SLUG2)]);
    let now = 1_000_000;
    const ids = cachedIdentities(store.read, () => now);
    for (let pass = 0; pass < 240; pass++) {
      const got = await ids([T1, T2.toUpperCase().replace("0X", "0x")]);
      assert.equal(got.get(T1)?.slug, SLUG1);
      assert.equal(got.get(T2)?.slug, SLUG2);
      now += 15_000;
    }
    assert.equal(store.reads, 1, "an hour of passes read the whole identity table once");
    // …and keeps nothing social from the rows it was handed.
    assert.ok(!JSON.stringify([...(await ids([T1])).values()]).includes(PRIVY_NAME));
  });

  it("reads again at once for a tenant it has not seen, so a new agent is greeted by its real name", async () => {
    let rows = [row(T1, SLUG1)];
    const store = counting(() => rows);
    const now = 1_000_000;
    const ids = cachedIdentities(store.read, () => now);
    await ids([T1]);
    rows = [row(T1, SLUG1), row(T3, SLUG3)];
    const got = await ids([T1, T3]);
    assert.equal(got.get(T3)?.slug, SLUG3);
    assert.equal(store.reads, 2);
  });

  it("looks for a tenant with no identity at most once a minute, and refreshes hourly", async () => {
    const store = counting(() => [row(T1, SLUG1)]);
    let now = 1_000_000;
    const ids = cachedIdentities(store.read, () => now);
    for (let pass = 0; pass < 4; pass++) {
      assert.equal((await ids([T1, T4])).has(T4), false);
      now += 15_000;
    }
    assert.equal(store.reads, 1, "four passes inside a minute");
    await ids([T1, T4]);
    assert.equal(store.reads, 2, "a minute later it looks again");
    now += 60 * 60_000;
    await ids([T1]);
    assert.equal(store.reads, 3, "an hour on, the snapshot is read again");
  });

  it("lets a failed read propagate and keeps the last good snapshot", async () => {
    let fail = false;
    const ids = cachedIdentities(async () => {
      if (fail) throw new Error("identity store down");
      return [row(T1, SLUG1)];
    });
    await ids([T1]);
    fail = true;
    await assert.rejects(ids([T1, T3]));
    assert.equal((await ids([T1])).get(T1)?.slug, SLUG1);
  });
});

describe("loadFacts against the ledger schema", () => {
  let raw: DatabaseSync;
  let db: Db;
  let facts: Map<string, AgentFacts>;
  let prepared: string[];

  before(async () => {
    raw = new DatabaseSync(":memory:");
    db = wrapSqlite(raw);
    await seed(db);
    const s = spy(db);
    facts = await loadFacts(s.db, ROSTER, PROFILES, NOW, { identities });
    prepared = s.sql;
  });
  after(() => raw.close());

  const f = (tenant: string) => {
    const x = facts.get(tenant.toLowerCase());
    assert.ok(x, `no facts for ${tenant}`);
    return x;
  };

  it("runs exactly one roster query and one calls query for the whole fleet", () => {
    assert.equal(prepared.length, 2);
    assert.match(prepared[0]!, /FROM agents/);
    assert.match(prepared[1]!, /FROM decisions d/);
  });

  it("answers for every roster member, keyed by the lowercased tenant", () => {
    assert.deepEqual([...facts.keys()].sort(), [T1, T2, T3, T4, T5, TRH].sort());
    assert.equal(f(T2).tenant, T2);
  });

  it("publishes only landed and paper buys and sells from publishable sources, newest first", () => {
    assert.deepEqual(
      f(T1).calls.map((c) => c.decisionId),
      [ids.classBuy, ids.paperBuy, ids.sell, ids.addressPost, ids.retried, ids.addressName, ids.longPost],
    );
    const at = f(T1).calls.map((c) => c.atSec);
    assert.deepEqual(at, [...at].sort((a, b) => b - a));
    for (const c of f(T1).calls) assert.ok(c.side === "buy" || c.side === "sell");
  });

  it("never publishes a refused, reverted, pending, dropped, shadow, hold, chat, selftest or foreign decision", () => {
    const never = JSON.parse(ids.never) as string[];
    const all = [...facts.values()].flatMap((x) => x.calls.map((c) => c.decisionId));
    for (const id of never) assert.ok(!all.includes(id), `${id} reached the room`);
    assert.ok(!all.includes(ids.stranger), "an agent off the roster is not in the room");
  });

  it("flags paper by the trade's status, not the agent's mode", () => {
    const byId = new Map(f(T1).calls.map((c) => [c.decisionId, c]));
    assert.equal(byId.get(ids.paperBuy)!.paper, true);
    assert.equal(byId.get(ids.classBuy)!.paper, false, "a paper-mode agent's landed trade is not a paper fill");
    assert.equal(f(T2).calls[0]!.paper, false);
  });

  it("respects the call window, and a wider one admits the older call", async () => {
    assert.ok(!f(T1).calls.some((c) => c.decisionId === ids.old));
    const wide = await loadFacts(db, ROSTER, PROFILES, NOW, { identities, callWindowSec: 8 * 3600 });
    assert.ok(wide.get(T1)!.calls.some((c) => c.decisionId === ids.old));
  });

  it("keeps only band words from the closed vocabulary, never the raw figures", () => {
    const c = f(T1).calls.find((x) => x.decisionId === ids.classBuy)!;
    assert.deepEqual(c.bands, ["liquidity thin", "curve early"]);
    const vocab = everyBand();
    for (const x of facts.values()) for (const call of x.calls) for (const b of call.bands) assert.ok(vocab.has(b));
    assert.deepEqual(f(T1).calls.find((x) => x.decisionId === ids.paperBuy)!.bands, []);
  });

  it("carries no size, no private figure and no private column anywhere in the output", () => {
    const text = JSON.stringify([...facts.values()]);
    for (const secret of [String(SIZE), String(AMOUNT), String(RAW_DEPTH), REASON_FIGURE, "31337.31", "6060.6", "8181.81", BLOCKER]) {
      assert.ok(!text.includes(secret), `leaked ${secret}`);
    }
    assert.ok(!text.toLowerCase().includes(OWNER.toLowerCase()), "leaked the owner wallet");
    assert.ok(!text.toLowerCase().includes(SESSION.toLowerCase()), "leaked the session key");
    assert.ok(!/size|signals|blocker|caps|hwm|reason/i.test(text), "a private field name reached the output");
  });

  it("names agents: the owner's choice, else the slug's name, never Robin and never an address", () => {
    assert.equal(f(T1).name, agentNameForSlug(SLUG1));
    assert.equal(f(T2).name, "Maid Marian");
    assert.equal(f(T3).name, agentNameForSlug(SLUG3));
    assert.equal(f(T4).name, DEFAULT_AGENT_NAME, "no slug to seed on");
    assert.equal(f(T5).name, DEFAULT_AGENT_NAME, "a malformed slug is no slug");
    assert.equal(f(T5).slug, null);
    for (const x of facts.values()) assert.ok(!/0x[0-9a-f]{6,}/i.test(x.name));
  });

  it("maps mode, age and profile", () => {
    assert.equal(f(T1).mode, "paper");
    assert.equal(f(T2).mode, "live");
    assert.equal(f(T3).mode, "idle");
    assert.equal(f(T4).mode, "idle");
    assert.equal(f(T1).ageDays, 3);
    assert.equal(f(T2).ageDays, 10, "a millisecond createdAt is still ten days");
    assert.equal(f(T3).ageDays, 0);
    assert.equal(f(T4).ageDays, null);
    assert.equal(f(T1).strategy, "trencher");
    assert.deepEqual(f(T1).traits, ["moves early and does not wait around"]);
    assert.equal(f(T2).strategy, null);
    assert.deepEqual(f(T2).traits, []);
  });

  it("sanitises coin names and drops an address-shaped one without dropping the call", () => {
    const byId = new Map(f(T1).calls.map((c) => [c.decisionId, c]));
    const cat = byId.get(ids.classBuy)!;
    assert.equal(cat.symbol, "T1A2B3C4D5E6");
    assert.equal(cat.name, "Cash Cat", "emoji and venue suffix stripped");
    const addr = byId.get(ids.addressName)!;
    assert.equal(addr.name, null);
    assert.equal(addr.symbol, "T0000000000A");
    for (const x of facts.values()) {
      for (const c of x.calls) if (c.name !== null) assert.match(c.name, /^[A-Za-z0-9 ._-]+$/);
    }
  });

  it("links the coin that moved: bought on a buy, sold on a sell, never a cash leg", () => {
    const byId = new Map(f(T1).calls.map((c) => [c.decisionId, c]));
    assert.equal(byId.get(ids.classBuy)!.token, COIN1.toLowerCase());
    assert.equal(byId.get(ids.paperBuy)!.token, TSLA.toLowerCase());
    assert.equal(byId.get(ids.sell)!.token, TSLA.toLowerCase());
    assert.equal(byId.get(ids.longPost)!.token, COIN1.toLowerCase());
    assert.equal(byId.get(ids.addressPost)!.token, null, "USDG is never the coin");
  });

  it("gives the agent's own post, clipped like the feed, or null", () => {
    const byId = new Map(f(T1).calls.map((c) => [c.decisionId, c]));
    assert.equal(byId.get(ids.classBuy)!.ownWords, "Liking how early this curve still is, so keeping it small and watching.");
    assert.equal(byId.get(ids.addressPost)!.ownWords, null, "a post naming an address costs the post, not the call");
    const long = byId.get(ids.longPost)!.ownWords!;
    assert.ok(long.length <= 220 && long.endsWith("…"), long);
    assert.equal(byId.get(ids.paperBuy)!.ownWords, null);
  });

  it("never gives the brokerage rail a call", () => {
    assert.deepEqual(f(TRH).calls, []);
  });

  it("returns an empty map for an empty roster without touching the database", async () => {
    const s = spy(db);
    const out = await loadFacts(s.db, [], PROFILES, NOW, { identities });
    assert.equal(out.size, 0);
    assert.equal(s.sql.length, 0);
  });

  it("bounds each agent's calls without starving the others", async () => {
    const r = new DatabaseSync(":memory:");
    const d = wrapSqlite(r);
    try {
      await applyLedgerSchema(d);
      await agent(d, { id: A1, name: "Busy", mode: "paper" });
      await agent(d, { id: A2, name: "Quiet", mode: "live" });
      for (let i = 0; i < 200; i++) {
        const id = await decision(d, { agent: A1, source: "strategy:steady-basket", action: "buy", at: NOW - 10 - i, symbol: "TSLA" });
        await trade(d, { agent: A1, decision: id, status: "paper", buy: TSLA });
      }
      const quiet = await decision(d, { agent: A2, source: "strategy:steady-basket", action: "buy", at: NOW - 5000, symbol: "TSLA" });
      await trade(d, { agent: A2, decision: quiet, status: "landed", buy: TSLA });
      const out = await loadFacts(d, [{ tenant: T1, agentId: A1 }, { tenant: T2, agentId: A2 }], new Map(), NOW, { identities });
      // As many as one agent can announce in the window (30 an hour for six hours), and no more.
      assert.equal(out.get(T1)!.calls.length, 180);
      assert.equal(out.get(T1)!.calls[0]!.atSec, NOW - 10, "the newest are the ones kept");
      assert.deepEqual(out.get(T2)!.calls.map((c) => c.decisionId), [quiet]);
    } finally {
      r.close();
    }
  });

  it("keeps a call the room already posted past the per-agent cut — with the dialect, and only for the card's own key", async () => {
    // 2026-09-25 16:53: a paper basket filling three coins every few minutes
    // pushed its earlier card's fill past the newest CALLS_PER_AGENT, and a
    // redeploy weighed the unsaid fills after it against nothing: three
    // hours-old "bought TSLA" cards at once. The conductor passes the dialect,
    // and a fill whose "call:<decision>" card is in the room survives the cut.
    const r = new DatabaseSync(":memory:");
    const d = wrapSqlite(r);
    try {
      await applyLedgerSchema(d);
      await agent(d, { id: A1, name: "Busy Basket", mode: "paper" });
      const made: string[] = [];
      for (let i = 0; i < CALLS_PER_AGENT + 20; i++) {
        const id = await decision(d, { agent: A1, source: "strategy:steady-basket", action: "buy", at: NOW - 5 * 3600 + i * 60, symbol: "TSLA" });
        await trade(d, { agent: A1, decision: id, status: "paper", buy: TSLA, sell: CASH.USDG });
        made.push(id);
      }
      const anchor = made[0]!;
      const answered = made[1]!;
      await ensureGroupchatSchema(d, "sqlite");
      const row = (over: Partial<Parameters<typeof appendMessage>[1]>) => ({
        createdAtMs: (NOW - 5 * 3600) * 1000,
        authorKind: "agent" as const,
        tenant: T1,
        agentId: A1,
        speakerSlug: null,
        speakerName: "Busy Basket",
        body: "bought TSLA",
        replyTo: null,
        kind: "call" as const,
        call: { side: "buy" as const, symbol: "TSLA", name: null, token: TSLA.toLowerCase(), paper: true },
        callDecisionId: anchor,
        dedupeKey: `call:${anchor}`,
        ...over,
      });
      const card = await appendMessage(d, row({}));
      assert.ok(card !== null, "fixture: the card is in the room");
      // A key that only CONTAINS "call:<decision>" is not the card's own.
      await appendMessage(d, row({ body: "nice one", replyTo: card, kind: "chat", call: null, callDecisionId: null, dedupeKey: `re:call:${answered}` }));

      const roster = [{ tenant: T1, agentId: A1 }];
      const ids = (m: Map<string, AgentFacts>) => m.get(T1)!.calls.map((c) => c.decisionId);
      const plain = ids(await loadFacts(d, roster, new Map(), NOW, { identities }));
      const kept = ids(await loadFacts(d, roster, new Map(), NOW, { identities, dialect: "sqlite" }));
      assert.equal(plain.length, CALLS_PER_AGENT, "fixture: the cut binds");
      assert.ok(!plain.includes(anchor) && !plain.includes(answered), "fixture: the two oldest fills are past the cut");
      assert.ok(kept.includes(anchor), "a fill whose card is in the room was cut: a restart weighs the fills after it against nothing");
      assert.ok(!kept.includes(answered), `a "re:call:" key counted as the card's own`);
      assert.equal(kept.length, CALLS_PER_AGENT + 1, "the cut still bounds every fill the room has not posted");
    } finally {
      r.close();
    }
  });

  it("keeps a night's backlog whole, because the conductor announces the OLDEST call it has not said", async () => {
    // An agent that traded all night while its owner slept: forty calls, and on
    // waking the conductor starts from the earliest. A newest-25 cut would hand
    // it a list whose oldest entries it had never seen, and the first fifteen
    // calls of the night would never be said.
    const r = new DatabaseSync(":memory:");
    const d = wrapSqlite(r);
    try {
      await applyLedgerSchema(d);
      await agent(d, { id: A1, name: "Night Owl", mode: "paper" });
      const made: string[] = [];
      for (let i = 0; i < 40; i++) {
        const id = await decision(d, { agent: A1, source: "strategy:steady-basket", action: "buy", at: NOW - 5 * 3600 + i * 400, symbol: "TSLA" });
        await trade(d, { agent: A1, decision: id, status: "paper", buy: TSLA });
        made.push(id);
      }
      const out = await loadFacts(d, [{ tenant: T1, agentId: A1 }], new Map(), NOW, { identities });
      const calls = out.get(T1)!.calls;
      assert.equal(calls.length, 40);
      assert.equal(calls[calls.length - 1]!.decisionId, made[0], "the night's first call is still there to announce");
    } finally {
      r.close();
    }
  });

  it("drops a coin name the room's gate would refuse, and keeps the call", async () => {
    const r = new DatabaseSync(":memory:");
    const d = wrapSqlite(r);
    try {
      await applyLedgerSchema(d);
      await agent(d, { id: A1, name: "Maid Marian", mode: "live" });
      const names = ["up 500 percent", "pump.fun", "Sly Frog"];
      for (const [i, displayName] of names.entries()) {
        const id = await decision(d, { agent: A1, source: "class-route", action: "buy", at: NOW - 100 - i, symbol: `CN${"ABC"[i]}`, displayName });
        await trade(d, { agent: A1, decision: id, status: "landed", buy: COIN2 });
      }
      const out = await loadFacts(d, [{ tenant: T1, agentId: A1 }], new Map(), NOW, { identities });
      const bySymbol = new Map(out.get(T1)!.calls.map((c) => [c.symbol, c.name]));
      assert.equal(bySymbol.get("CNA"), null, "a coin name that is a figure");
      assert.equal(bySymbol.get("CNB"), null, "a coin name that is a link");
      assert.equal(bySymbol.get("CNC"), "Sly Frog");
    } finally {
      r.close();
    }
  });

  it("propagates a database failure rather than reading as a quiet fleet", async () => {
    const r = new DatabaseSync(":memory:");
    try {
      await assert.rejects(loadFacts(wrapSqlite(r), ROSTER, PROFILES, NOW, { identities }));
    } finally {
      r.close();
    }
  });
});

describe("the gate holds without the SQL", () => {
  /**
   * THE SQL NARROWING IS AN OPTIMISATION; publishableThesis IS THE RULE. A Db
   * that hands back rows the WHERE clause should have excluded — as a later
   * edit to it might — must still produce no call from any of them.
   */
  it("drops every row publishableThesis would not print as landed, whatever the query returned", async () => {
    const base = {
      agent_id: A1,
      source: "strategist",
      action: "buy",
      symbol: "TSLA",
      display_name: null,
      reason: "a view",
      dropped_rule: null,
      hold_kind: null,
      evidence_json: null,
      at: NOW - 10,
      buy_token: TSLA,
      sell_token: CASH.USDG,
      post: null,
    };
    const rows = [
      { ...base, decision_id: "rejected", status: "rejected" },
      { ...base, decision_id: "reverted", status: "reverted" },
      { ...base, decision_id: "submitted", status: "submitted" },
      { ...base, decision_id: "no-status", status: null },
      { ...base, decision_id: "shadow", source: "brain-shadow", status: null },
      { ...base, decision_id: "chat", source: "chat", status: "landed" },
      { ...base, decision_id: "hold", action: "hold", status: "landed" },
      { ...base, decision_id: "forced", hold_kind: "GATE_FORCED_HOLD", status: "landed" },
      { ...base, decision_id: "rh", agent_id: "rh:1", status: "landed" },
      { ...base, decision_id: "brain-refusal", dropped_rule: "brain-quality", status: "landed" },
      { ...base, decision_id: "address-symbol", symbol: "0xdeadbeefcafe", status: "landed" },
      { ...base, decision_id: "ok", status: "landed" },
    ];
    const fake: Db = {
      prepare: (sql: string) => ({
        run: async () => ({ changes: 0, lastInsertRowid: 0 }),
        get: async () => undefined,
        all: async () => (/FROM agents/.test(sql) ? [{ smart_account: A1, name: "Maid Marian", mode: "live" }] : rows),
      }),
      exec: async () => {},
      tx: (fn) => fn(fake),
    };
    const out = await loadFacts(fake, [{ tenant: T1, agentId: A1 }], new Map(), NOW, { identities });
    assert.deepEqual(out.get(T1)!.calls.map((c) => c.decisionId), ["ok"]);
  });
});

describe("the default identity read", () => {
  let home: string;
  const saved = { home: process.env.MERRYMEN_HOME, url: process.env.DATABASE_URL };

  before(() => {
    home = mkdtempSync(join(tmpdir(), "mm-facts-"));
    process.env.MERRYMEN_HOME = home;
    delete process.env.DATABASE_URL;
    resetIdentityStoreForTest();
    mkdirSync(join(home, "agent-identity"), { recursive: true });
    writeFileSync(
      join(home, "agent-identity", `${T1}.json`),
      JSON.stringify({
        tenant: T1,
        slug: SLUG1,
        accounts: [A1.toLowerCase()],
        social: { did: "did:privy:abc", provider: "twitter", subject: "123", handle: "owner_handle", displayName: PRIVY_NAME },
        createdAt: NOW - 2 * 86_400,
        updatedAt: NOW,
      }),
    );
  });
  after(() => {
    resetIdentityStoreForTest();
    if (saved.home === undefined) delete process.env.MERRYMEN_HOME;
    else process.env.MERRYMEN_HOME = saved.home;
    if (saved.url !== undefined) process.env.DATABASE_URL = saved.url;
    rmSync(home, { recursive: true, force: true });
  });

  it("uses the identity store's slug and age, and nothing social reaches the facts", async () => {
    const r = new DatabaseSync(":memory:");
    const d = wrapSqlite(r);
    try {
      await applyLedgerSchema(d);
      await agent(d, { id: A1, name: "Robin", mode: "paper" });
      const out = await loadFacts(d, [{ tenant: T1, agentId: A1 }], new Map(), NOW);
      const x = out.get(T1)!;
      assert.equal(x.slug, SLUG1);
      assert.equal(x.ageDays, 2);
      assert.equal(x.name, agentNameForSlug(SLUG1));
      const text = JSON.stringify(x);
      for (const s of [PRIVY_NAME, "owner_handle", "did:privy"]) assert.ok(!text.includes(s), `leaked ${s}`);
    } finally {
      r.close();
    }
  });
});

describe("what this module's SQL may name", () => {
  const FORBIDDEN = [
    "signals_json",
    "size_usdg",
    "amount_usdg",
    "owner_address",
    "session_key_address",
    "caps",
    "hwm_",
    "accrued_fee_usdg",
    "live_blocker",
    "contributions_",
    "x_handle",
    "realized_pnl",
    "fill_cash",
  ];

  it("never mentions a private column in any SELECT in the source", () => {
    // Comments first: they name the forbidden columns on purpose, and a stray
    // backtick in one would pair with the wrong one in the code.
    const src = readFileSync(join(import.meta.dirname, "facts.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const literals = [...src.matchAll(/`([^`]*)`/g)].map((m) => m[1]!).filter((s) => /\bSELECT\b/i.test(s));
    assert.ok(literals.length >= 2, "found the roster and calls statements");
    for (const sql of literals) {
      for (const word of FORBIDDEN) assert.ok(!sql.toLowerCase().includes(word), `a SELECT names ${word}`);
      assert.ok(!/\*/.test(sql), "a star selects every column, including the private ones");
    }
  });

  it("never mentions a private column in the statements it actually prepares", () => {
    for (const sql of [rosterSql(), callsSql(3).sql]) {
      for (const word of FORBIDDEN) assert.ok(!sql.toLowerCase().includes(word), `a SELECT names ${word}`);
      assert.ok(!/\*/.test(sql));
    }
  });
});
