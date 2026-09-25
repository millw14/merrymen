/**
 * The social family through runTool (the wrapper the MCP server calls), on
 * SQLite with the full ledger schema and an in-memory follow store — no test
 * reaches Postgres, the identity store or the chain.
 *
 * Follows: the follow route's rules (shape, not yourself, the cap) plus the
 * existence check a connected app needs; follows belong to the tenant, so one
 * owner's edges never move another's; outages are errors, never empty lists;
 * every answer says following never copies trades.
 *
 * Shares: only operations that landed with a transaction hash count; a
 * realized figure only when proceeds and cost are both measured; paper is
 * practice and never in a real figure; a private book prints no dollars; a
 * trade that is not this agent's reads exactly like one that does not exist.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { explorerFor } from "@merrymen/core";
import { MAX_FOLLOWS, type FollowEdge } from "../../../../worker/src/follow-store";
import { setPublicIdentitiesForTest, type PublicIdentityRecord } from "@/lib/services/public-feed";
import { setSettingsReaderForTest } from "@/lib/services/settings-view";
import { setFollowStoreForTest, type FollowStoreLike } from "@/lib/services/social";
import type { OwnedAgent } from "../agents";
import type { Principal } from "../oauth/server";
import { resetMetricsForTest } from "../observe";
import {
  ACCOUNT_A, ACCOUNT_B, OWNER_A, OWNER_B, SLUG_A, SLUG_B, agentFixture, connectAs, fixtureDirectory, installFixtures, makeDeps, makeTestDb, type TestDb,
} from "../testing";
import { runTool, type ToolDef } from "../tool";
import { SOCIAL_TOOLS } from "./social";

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  setFollowStoreForTest(null);
  setPublicIdentitiesForTest(null);
  resetMetricsForTest();
});

const NOW = 1_800_000_000;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const T1 = `0x${"11".repeat(20)}`;
const T2 = `0x${"22".repeat(20)}`;
const T3 = `0x${"33".repeat(20)}`;
const txh = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const oph = (n: number) => `0x${(n + 0xabc000).toString(16).padStart(64, "0")}`;

/** Ten public agents owned by nobody under test, for the cap. */
const PEERS = Array.from({ length: 10 }, (_, i) => ({
  slug: `ccccccccccccccc${i}`,
  tenant: `0x${"c".repeat(38)}0${i}` as `0x${string}`,
  account: `0x${"0".repeat(36)}c00${i}` as `0x${string}`,
}));
/** An identity with no agent on the ledger: no public profile. */
const NO_PROFILE = "eeeeeeeeeeeeeeee";
/** A second identity of owner A's that the directory does not list (the tenant check catches it). */
const A_OTHER = "dddddddddddddddd";
const ACCOUNT_A_OTHER = "0x000000000000000000000000000000000000a002" as const;
/** Well-formed, owned by nobody. */
const NOBODY = "ffffffffffffffff";

const SOCIAL_SCOPES = ["agents:read", "portfolio:read", "social:write"];

const tool = (name: string) => SOCIAL_TOOLS.find((t) => t.name === name) as unknown as ToolDef;

async function call(name: string, args: Record<string, unknown>, p: Principal, now = NOW) {
  const res = await runTool(tool(name), args, p, "trace-test", { now: () => now });
  return { res, sc: res.structuredContent as Record<string, any>, text: JSON.stringify(res) };
}

const errCode = (r: { sc: Record<string, any> }): string | undefined => r.sc?.error?.code;

// ── fixtures ────────────────────────────────────────────────────────────────

/** FileFollowStore's semantics in memory: idempotent, newest first, a new edge refused at the cap. */
class MemFollowStore implements FollowStoreLike {
  edges = new Map<string, FollowEdge[]>();
  private clock = 1_700_000_000;
  async following(tenant: `0x${string}`): Promise<FollowEdge[]> {
    return [...(this.edges.get(tenant.toLowerCase()) ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  }
  async follow(tenant: `0x${string}`, target: string): Promise<boolean> {
    const list = this.edges.get(tenant.toLowerCase()) ?? [];
    if (list.some((e) => e.target === target)) return true;
    if (list.length >= MAX_FOLLOWS) return false;
    list.push({ target, createdAt: ++this.clock });
    this.edges.set(tenant.toLowerCase(), list);
    return true;
  }
  async unfollow(tenant: `0x${string}`, target: string): Promise<void> {
    const list = this.edges.get(tenant.toLowerCase()) ?? [];
    this.edges.set(tenant.toLowerCase(), list.filter((e) => e.target !== target));
  }
  targets(tenant: string): string[] {
    return (this.edges.get(tenant.toLowerCase()) ?? []).map((e) => e.target).sort();
  }
}

/** A store whose backend is down, with a connection string in its error the way pg's can carry one. */
const downStore: FollowStoreLike = {
  following: async () => { throw new Error("connect ECONNREFUSED postgres://merrymen:hunter2@db.internal:5432/prod"); },
  follow: async () => { throw new Error("connect ECONNREFUSED postgres://merrymen:hunter2@db.internal:5432/prod"); },
  unfollow: async () => { throw new Error("connect ECONNREFUSED postgres://merrymen:hunter2@db.internal:5432/prod"); },
};

function identity(slug: string, tenant: string, accounts: string[]): PublicIdentityRecord {
  return { tenant: tenant as `0x${string}`, slug, accounts: accounts as `0x${string}`[], createdAt: 1_700_000_000, updatedAt: 1_700_000_000 };
}

function installIdentities(o: { down?: boolean } = {}) {
  const list = [
    identity(SLUG_A, OWNER_A, [ACCOUNT_A]),
    identity(SLUG_B, OWNER_B, [ACCOUNT_B]),
    identity(A_OTHER, OWNER_A, [ACCOUNT_A_OTHER]),
    identity(NO_PROFILE, `0x${"e".repeat(40)}`, [`0x${"0".repeat(36)}e001`]),
    ...PEERS.map((p) => identity(p.slug, p.tenant, [p.account])),
  ];
  setPublicIdentitiesForTest({
    async all() {
      if (o.down) throw new Error("identity store down");
      return list;
    },
    async bySlug(slug) {
      if (o.down) throw new Error("identity store down");
      return list.find((i) => i.slug === slug) ?? null;
    },
  });
}

function agentRow(d: TestDb, account: string, owner: string, o: { name?: string; mode?: string; chainId?: number } = {}) {
  d.raw.prepare(`INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, mode, beat_at, epoch)
    VALUES (?, ?, ?, '0x1', ?, '{}', 1700000000, 4102444800, 'active', ?, ?, 1)`).run(account, o.name ?? "Agent", owner, o.chainId ?? 4663, o.mode ?? "live", NOW - 30);
}

interface TradeSeed {
  kind?: string; sell?: string | null; buy?: string | null; op?: string | null; tx?: string | null; status: string; rule?: string | null;
  side?: string | null; symbol?: string | null; qty?: string | null; realized?: number | null; source?: string | null; cash?: number | null; at: number;
}

function trade(d: TestDb, account: string, t: TradeSeed): number {
  const r = d.raw.prepare(`INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, user_op_hash, tx_hash, status, reject_rule,
      fill_side, fill_symbol, fill_qty_raw, realized_pnl_usdg, basis_source, fill_cash_usdg, created_at)
    VALUES (?, ?, 'router', ?, ?, 10, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    account, t.kind ?? "swap", t.sell ?? null, t.buy ?? null, t.op ?? null, t.tx ?? null, t.status, t.rule ?? null,
    t.side ?? null, t.symbol ?? null, t.qty ?? null, t.realized ?? null, t.source ?? null, t.cash ?? null, t.at,
  );
  return Number(r.lastInsertRowid);
}

interface Setup {
  d: TestDb;
  a: Principal;
  b: Principal;
  store: MemFollowStore;
  map: Record<string, OwnedAgent[]>;
}

async function setup(o: { scopesA?: string[]; publicBookA?: boolean; agentA?: OwnedAgent } = {}): Promise<Setup> {
  const d = await makeTestDb();
  const map: Record<string, OwnedAgent[]> = {
    [OWNER_A]: [o.agentA ?? agentFixture(SLUG_A, ACCOUNT_A)],
    [OWNER_B]: [agentFixture(SLUG_B, ACCOUNT_B)],
  };
  const directory = fixtureDirectory(map);
  const deps = makeDeps(d, { agents: directory });
  restore = installFixtures(d, {
    directory,
    settings: {
      [OWNER_A]: { agentName: "Robin", publicBook: o.publicBookA === true, telegramBotToken: "123:SECRET-A" },
      [OWNER_B]: { agentName: "Rival", publicBook: true },
    },
  });
  const store = new MemFollowStore();
  setFollowStoreForTest(store);
  installIdentities();
  const a = await connectAs(deps, OWNER_A, { scopes: o.scopesA ?? SOCIAL_SCOPES });
  const b = await connectAs(deps, OWNER_B, { scopes: SOCIAL_SCOPES });
  // Public profiles: an identity plus a row on the shared ledger.
  agentRow(d, ACCOUNT_A, OWNER_A, { name: "Robin" });
  agentRow(d, ACCOUNT_B, OWNER_B, { name: "Rival\u202e evil" });
  agentRow(d, ACCOUNT_A_OTHER, OWNER_A, { name: "Robin Two" });
  for (const p of PEERS) agentRow(d, p.account, p.tenant, { name: `Peer ${p.slug.slice(-1)}` });
  return { d, a: a.principal, b: b.principal, store, map };
}

// ── follow_agent ────────────────────────────────────────────────────────────

test("follow_agent: wires a public agent in under the owner's tenant, says plainly it never copies trades, and is idempotent", async () => {
  const { a, store } = await setup();
  const first = await call("follow_agent", { target: SLUG_B }, a);
  assert.equal(errCode(first), undefined, first.text);
  assert.equal(first.sc.following, true);
  assert.equal(first.sc.changed, true);
  assert.equal(first.sc.copies_trades, false);
  assert.match(first.sc.what_following_does, /public theses/);
  assert.match(first.sc.what_following_does, /never copies/i);
  assert.match(tool("follow_agent").description, /NEVER copies/);
  assert.equal(first.sc.target_name, "Rival evil", "a third party's name comes back with its bidi override stripped");
  assert.ok(first.sc.untrusted_fields.includes("target_name"));
  assert.deepEqual(first.sc.wired, [SLUG_B]);
  assert.equal(first.sc.following_count, 1);
  assert.equal(first.sc.slots_left, MAX_FOLLOWS - 1);
  assert.deepEqual(first.sc.affects_agents, [SLUG_A]);
  assert.deepEqual(store.targets(OWNER_A), [SLUG_B]);
  assert.match(first.res.content[0]!.text, /never copies its trades/);

  const again = await call("follow_agent", { target: SLUG_B }, a);
  assert.equal(again.sc.changed, false, "following twice is one edge");
  assert.deepEqual(store.targets(OWNER_A), [SLUG_B]);
  assert.deepEqual(store.targets(OWNER_B), [], "the follow was written under A's tenant only");
});

test("follow_agent: refuses yourself (by slug and by tenant), unknown ids, ids with no public profile, and a malformed id", async () => {
  const { a, store } = await setup();

  const self = await call("follow_agent", { target: SLUG_A }, a);
  assert.equal(errCode(self), "invalid_input");
  assert.match(self.sc.error.message, /your own agent/);

  // An identity of owner A's that this directory does not list is still A's own.
  const selfByTenant = await call("follow_agent", { target: A_OTHER }, a);
  assert.equal(errCode(selfByTenant), "invalid_input");

  const nobody = await call("follow_agent", { target: NOBODY }, a);
  assert.equal(errCode(nobody), "not_found");

  const noProfile = await call("follow_agent", { target: NO_PROFILE }, a);
  assert.equal(errCode(noProfile), "not_found", "an identity with no agent on the ledger has no public profile to read");
  assert.equal(noProfile.sc.error.message, nobody.sc.error.message, "no profile and no identity read the same");

  const malformed = await call("follow_agent", { target: "ILOU000000000000" }, a);
  assert.equal(errCode(malformed), "invalid_input", "i/l/o/u are not in a slug; the shape is checked before any store call");
  const extra = await call("follow_agent", { target: SLUG_B, agent: SLUG_A }, a);
  assert.equal(errCode(extra), "invalid_input", "strict input: a follow belongs to the owner and takes no agent id");

  assert.deepEqual(store.targets(OWNER_A), [], "no refused follow wrote anything");
});

test("follow_agent: at the cap a NEW edge is refused with a conflict, an existing one still answers, and nothing is dropped silently", async () => {
  const { a, store } = await setup();
  for (const p of PEERS.slice(0, MAX_FOLLOWS - 1)) await store.follow(OWNER_A, p.slug);

  const last = await call("follow_agent", { target: PEERS[MAX_FOLLOWS - 1]!.slug }, a);
  assert.equal(errCode(last), undefined, last.text);
  assert.equal(last.sc.following_count, MAX_FOLLOWS);
  assert.equal(last.sc.slots_left, 0);

  const over = await call("follow_agent", { target: PEERS[MAX_FOLLOWS]!.slug }, a);
  assert.equal(errCode(over), "conflict");
  assert.match(over.sc.error.message, /Unfollow one first/);
  assert.equal(over.sc.error.details.max, MAX_FOLLOWS);
  assert.equal(store.targets(OWNER_A).length, MAX_FOLLOWS);
  assert.ok(!store.targets(OWNER_A).includes(PEERS[MAX_FOLLOWS]!.slug));

  const existing = await call("follow_agent", { target: PEERS[0]!.slug }, a);
  assert.equal(errCode(existing), undefined, "re-following one already wired is not refused at the cap");
  assert.equal(existing.sc.changed, false);
});

test("follows are per owner: A's follow and unfollow never touch B's edges, and A's list never shows them", async () => {
  const { a, b, store } = await setup();
  assert.equal(errCode(await call("follow_agent", { target: SLUG_A }, b)), undefined);
  assert.equal(errCode(await call("follow_agent", { target: PEERS[0]!.slug }, b)), undefined);
  assert.equal(errCode(await call("follow_agent", { target: SLUG_B }, a)), undefined);

  // A unfollows something only B follows: nothing changes anywhere.
  const cut = await call("unfollow_agent", { target: PEERS[0]!.slug }, a);
  assert.equal(errCode(cut), undefined, cut.text);
  assert.equal(cut.sc.changed, false);
  assert.deepEqual(store.targets(OWNER_B), [SLUG_A, PEERS[0]!.slug].sort());

  const listA = await call("list_following", {}, a);
  assert.deepEqual(listA.sc.following.map((f: any) => f.agent), [SLUG_B]);
  assert.ok(!listA.text.includes(PEERS[0]!.slug), "B's edges are not in A's answer");

  const listB = await call("list_following", {}, b);
  assert.deepEqual(listB.sc.following.map((f: any) => f.agent).sort(), [SLUG_A, PEERS[0]!.slug].sort());
});

test("unfollow_agent: removes the edge, is a no-op when absent, and still removes an edge whose target lost its profile", async () => {
  const { a, store } = await setup();
  await store.follow(OWNER_A, SLUG_B);
  await store.follow(OWNER_A, NO_PROFILE); // written before the existence rule, now dangling

  const cut = await call("unfollow_agent", { target: SLUG_B }, a);
  assert.equal(errCode(cut), undefined, cut.text);
  assert.equal(cut.sc.following, false);
  assert.equal(cut.sc.changed, true);
  assert.equal(cut.sc.copies_trades, false);
  assert.deepEqual(cut.sc.wired, [NO_PROFILE]);

  const dangling = await call("unfollow_agent", { target: NO_PROFILE }, a);
  assert.equal(dangling.sc.changed, true, "unfollow is not existence-checked, so an old edge stays removable");
  const absent = await call("unfollow_agent", { target: NOBODY }, a);
  assert.equal(errCode(absent), undefined);
  assert.equal(absent.sc.changed, false);
  assert.deepEqual(store.targets(OWNER_A), []);
});

test("list_following: agents.read is enough to read, social.write is needed to change; names untrusted; dangling edges flagged", async () => {
  const { a, store } = await setup({ scopesA: ["agents:read"] });
  await store.follow(OWNER_A, SLUG_B);
  await store.follow(OWNER_A, NO_PROFILE);

  const list = await call("list_following", {}, a);
  assert.equal(errCode(list), undefined, list.text);
  assert.equal(list.sc.count, 2);
  assert.equal(list.sc.copies_trades, false);
  assert.match(list.sc.what_following_does, /never copies/i);
  const rival = list.sc.following.find((f: any) => f.agent === SLUG_B);
  assert.equal(rival.name, "Rival evil");
  assert.equal(rival.public, true);
  assert.ok(rival.followed_at);
  const gone = list.sc.following.find((f: any) => f.agent === NO_PROFILE);
  assert.equal(gone.public, false);
  assert.equal(gone.name, null);
  assert.ok(list.sc.warnings.some((w: string) => /no longer resolve/.test(w)));
  assert.ok(list.sc.untrusted_fields.includes("following[].name"));
  assert.ok(!list.text.includes("\u202e"));

  const write = await call("follow_agent", { target: PEERS[0]!.slug }, a);
  assert.equal(errCode(write), "insufficient_scope");
  const cut = await call("unfollow_agent", { target: SLUG_B }, a);
  assert.equal(errCode(cut), "insufficient_scope");
  assert.deepEqual(store.targets(OWNER_A), [NO_PROFILE, SLUG_B].sort());
});

test("follow tools: a store or directory outage is a retryable error with none of the backend's text, never an empty list", async () => {
  const { a } = await setup();
  setFollowStoreForTest(downStore);
  for (const [name, args] of [["follow_agent", { target: SLUG_B }], ["unfollow_agent", { target: SLUG_B }], ["list_following", {}]] as const) {
    const r = await call(name, args, a);
    assert.equal(errCode(r), "upstream_unavailable", `${name}: ${r.text}`);
    assert.ok(!/postgres|hunter2|ECONNREFUSED/.test(r.text), `${name} leaked the backend error`);
  }

  setFollowStoreForTest(new MemFollowStore());
  installIdentities({ down: true });
  const r = await call("follow_agent", { target: SLUG_B }, a);
  assert.equal(errCode(r), "upstream_unavailable", "an unreadable directory is not 'no such agent'");
});

test("follow tools: a connection whose owner no longer owns a shared agent may not rewire research", async () => {
  const { a, map, store } = await setup();
  map[OWNER_A] = [];
  const r = await call("follow_agent", { target: SLUG_B }, a);
  assert.equal(errCode(r), "forbidden");
  const l = await call("list_following", {}, a);
  assert.equal(errCode(l), "forbidden");
  assert.deepEqual(store.targets(OWNER_A), []);
});

// ── share_trade_summary ─────────────────────────────────────────────────────

interface Ids {
  buy1: number; sell1: number; buy2: number; sell2: number; submitted: number; reverted: number; noHash: number;
  paperBuy: number; paperSell: number; old: number; vault: number; foreign: number;
}

/**
 * Owner A, in the last day: a receipt-evidenced round trip on T1 (+2 on 10),
 * a T2 round trip whose buy was booked from a quote (so its sell is not
 * measured), one submitted, one reverted, one landed without a hash, a paper
 * round trip with a huge practice gain, and a vault move. Older than a day, one
 * more buy. Owner B has a confirmed trade of its own.
 */
function seedShare(d: TestDb): Ids {
  return {
    buy1: trade(d, ACCOUNT_A, { status: "landed", sell: USDG, buy: T1, side: "buy", qty: "1000", cash: 10, source: "receipt", symbol: "NVDA", op: oph(1), tx: txh(1), at: NOW - 5000 }),
    sell1: trade(d, ACCOUNT_A, { status: "landed", sell: T1, buy: USDG, side: "sell", qty: "1000", cash: 12, realized: 2, source: "receipt", symbol: "NVDA", op: oph(2), tx: txh(2), at: NOW - 4000 }),
    buy2: trade(d, ACCOUNT_A, { status: "landed", sell: USDG, buy: T2, side: "buy", qty: "500", cash: 5, source: "quote", symbol: "TSLA", op: oph(3), tx: txh(3), at: NOW - 3500 }),
    sell2: trade(d, ACCOUNT_A, { status: "landed", sell: T2, buy: USDG, side: "sell", qty: "500", cash: 4, realized: -1, source: "receipt", symbol: "TSLA", op: oph(4), tx: txh(4), at: NOW - 3000 }),
    submitted: trade(d, ACCOUNT_A, { status: "submitted", sell: USDG, buy: T1, side: "buy", op: oph(5), at: NOW - 2000 }),
    reverted: trade(d, ACCOUNT_A, { status: "reverted", sell: USDG, buy: T1, op: oph(6), tx: txh(6), rule: "slippage", at: NOW - 1900 }),
    noHash: trade(d, ACCOUNT_A, { status: "landed", sell: USDG, buy: T1, side: "buy", qty: "1", cash: 1, source: "receipt", op: oph(7), at: NOW - 1800 }),
    paperBuy: trade(d, ACCOUNT_A, { status: "paper", sell: USDG, buy: T3, side: "buy", qty: "100", cash: 100, source: "paper", symbol: "PAPR", at: NOW - 1500 }),
    paperSell: trade(d, ACCOUNT_A, { status: "paper", sell: T3, buy: USDG, side: "sell", qty: "100", cash: 1100, realized: 1000, source: "paper", symbol: "PAPR", at: NOW - 1400 }),
    old: trade(d, ACCOUNT_A, { status: "landed", sell: USDG, buy: T1, side: "buy", qty: "1", cash: 3, source: "receipt", symbol: "NVDA", op: oph(8), tx: txh(8), at: NOW - 3 * 86_400 }),
    vault: trade(d, ACCOUNT_A, { kind: "vault-deposit", status: "landed", sell: USDG, buy: null, op: oph(9), tx: txh(9), at: NOW - 1000 }),
    foreign: trade(d, ACCOUNT_B, { status: "landed", sell: T1, buy: USDG, side: "sell", qty: "1", cash: 50, realized: 40, source: "receipt", symbol: "BSECRET", op: oph(20), tx: txh(20), at: NOW - 500 }),
  };
}

const DOLLAR_KEYS = ["size_usdg", "realized_pnl_usdg"];

/** Every dollar-valued field anywhere in the answer, by path. */
function dollarFields(v: unknown, path = ""): Array<[string, unknown]> {
  if (Array.isArray(v)) return v.flatMap((x, i) => dollarFields(x, `${path}[${i}]`));
  if (v && typeof v === "object") {
    return Object.entries(v).flatMap(([k, x]) => (DOLLAR_KEYS.includes(k) ? [[`${path}.${k}`, x] as [string, unknown]] : dollarFields(x, `${path}.${k}`)));
  }
  return [];
}

test("share_trade_summary (public book): confirmed trades only, measured realized only, paper kept out of every real figure, explorer links", async () => {
  const { d, a } = await setup({ publicBookA: true });
  const ids = seedShare(d);
  const r = await call("share_trade_summary", { period: "day" }, a);
  assert.equal(errCode(r), undefined, r.text);
  const s = r.sc;

  assert.equal(s.agent, SLUG_A);
  assert.equal(s.privacy.public_book, true);
  assert.equal(s.privacy.dollar_figures, "included");
  assert.equal(s.privacy.links_in_text, true);
  assert.equal(s.network.real_money, true);

  // Real: the four confirmed swaps; not the vault move, the older buy, or anything unconfirmed.
  assert.deepEqual(s.trades.map((t: any) => t.trade_id).sort(), [ids.buy1, ids.sell1, ids.buy2, ids.sell2].map(String).sort());
  assert.equal(s.real.trades, 4);
  assert.equal(s.real.buys, 2);
  assert.equal(s.real.sells, 2);
  assert.equal(s.real.measured_sells, 1, "the T2 sale sold against a quote-booked buy");
  assert.equal(s.real.unmeasured_sells, 1);
  assert.equal(s.real.wins, 1);
  assert.equal(s.real.losses, 0, "an unmeasured loss is not a measured one");
  assert.equal(s.real.realized_return_pct, 20);
  assert.equal(s.real.realized_pnl_usdg, 2, "the paper gain of 1000 is not in the real figure");
  assert.equal(s.real.complete, true);

  // Practice: separate, labelled, never counted.
  assert.equal(s.practice.money, "simulated");
  assert.equal(s.practice.counted_in_real, false);
  assert.equal(s.practice.trades, 2);
  assert.equal(s.practice.realized_return_pct, 1000);
  assert.ok(s.trades.every((t: any) => t.book === "live" && t.money === "real"), "no paper fill is listed as a real trade");

  // Unconfirmed attempts are counted as left out, not listed.
  assert.deepEqual({ ...s.excluded, note: undefined }, { submitted: 1, failed: 1, landed_without_tx_hash: 1, note: undefined });
  for (const id of [ids.submitted, ids.reverted, ids.noHash, ids.paperBuy, ids.paperSell, ids.vault, ids.old, ids.foreign]) {
    assert.ok(!s.trades.some((t: any) => t.trade_id === String(id)), `trade ${id} must not be listed`);
  }

  const sell1 = s.trades.find((t: any) => t.trade_id === String(ids.sell1));
  assert.equal(sell1.verified_on_chain, true);
  assert.equal(sell1.tx_hash, txh(2));
  assert.equal(sell1.explorer_url, `${explorerFor(4663)}/tx/${txh(2)}`);
  assert.equal(sell1.size_usdg, 12);
  assert.equal(sell1.realized_pnl_usdg, 2);
  assert.equal(sell1.realized_return_pct, 20);
  assert.equal(sell1.realized_measured, true);
  const sell2 = s.trades.find((t: any) => t.trade_id === String(ids.sell2));
  assert.equal(sell2.realized_measured, false);
  assert.equal(sell2.realized_pnl_usdg, null, "an unmeasured result is null, never a number");
  assert.equal(sell2.realized_return_pct, null);

  // The text carries the same figures and the links, and says practice is not included.
  assert.match(s.text, /Trades confirmed on .+: 4 \(2 buys, 2 sells\)/);
  assert.match(s.text, /\+20\.00% \(\+\$2\.00\)/);
  assert.ok(s.text.includes(`${explorerFor(4663)}/tx/${txh(2)}`));
  assert.match(s.text, /Practice \(paper, simulated money, not real\): 2 fills.*Not included above/);
  assert.ok(!/\$1,?00[02]/.test(s.text), "the practice dollars never appear, alone or added to the real ones");
  assert.match(s.text, /\+1000\.00% on measured practice sells\. Not included above/);
  assert.ok(!s.text.includes("BSECRET"));

  // A one-line version the group chat would take: no link, no address.
  assert.equal(typeof s.post_line, "string");
  assert.ok(!/https?:|0x[0-9a-f]{6}/i.test(s.post_line));
  assert.match(s.post_line, /4 trades confirmed/);
  assert.match(s.posting, /posts nothing/);
  assert.equal(tool("share_trade_summary").annotations.readOnlyHint, true);
  assert.equal(tool("share_trade_summary").capability, "portfolio.read");
});

test("share_trade_summary (private book): no dollar figure anywhere, percentages and counts only, and it says so", async () => {
  const { d, a } = await setup({ publicBookA: false });
  seedShare(d);
  // A creator-chosen symbol that reads as a dollar amount must not put one in the text.
  trade(d, ACCOUNT_A, { status: "landed", sell: USDG, buy: T3, side: "buy", qty: "1", cash: 1, source: "receipt", symbol: "$100", op: oph(30), tx: txh(30), at: NOW - 100 });
  const r = await call("share_trade_summary", {}, a);
  assert.equal(errCode(r), undefined, r.text);
  const s = r.sc;
  assert.equal(s.scope.period, "day", "no trade_id and no period means the last day");
  assert.equal(s.privacy.public_book, false);
  assert.equal(s.privacy.setting_read, true);
  assert.equal(s.privacy.dollar_figures, "omitted");
  assert.match(s.privacy.note, /private/);

  const dollars = dollarFields(s).filter(([, v]) => v !== null);
  assert.deepEqual(dollars, [], `dollar figures leaked: ${JSON.stringify(dollars)}`);
  assert.equal(s.real.realized_return_pct, 20, "the percentage is still shared");
  assert.equal(s.real.trades, 5);
  assert.ok(!s.text.includes("$"), `text has a dollar sign: ${s.text}`);
  assert.match(s.text, /Dollar amounts are not shown: this agent's book is private/);
  assert.match(s.text, /\+20\.00%/);
  assert.ok(s.post_line === null || !s.post_line.includes("$"));
  // A link is the transaction, amounts included: a private book's text leaves them out unless asked.
  assert.equal(s.privacy.links_in_text, false);
  assert.ok(!s.text.includes("http"), "a private book's text carries no explorer link by default");
  assert.ok(s.trades.every((t: any) => typeof t.explorer_url === "string"), "the structured trades still carry their links");

  const asked = await call("share_trade_summary", { period: "day", include_links: true }, a);
  assert.equal(asked.sc.privacy.links_in_text, true);
  assert.ok(asked.sc.text.includes(`${explorerFor(4663)}/tx/`));
  assert.ok(asked.sc.warnings.some((w: string) => /explorer link/.test(w)), "asking for links on a private book is warned what a link shows");
  assert.deepEqual(dollarFields(asked.sc).filter(([, v]) => v !== null), []);
});

test("share_trade_summary: an unreadable public-book setting is treated as private, with a warning and no backend text", async () => {
  const { d, a } = await setup({ publicBookA: true });
  seedShare(d);
  setSettingsReaderForTest({ async settingsFor() { throw new Error("pg: password authentication failed for postgres://u:p@x"); } });
  const r = await call("share_trade_summary", { period: "week" }, a);
  assert.equal(errCode(r), undefined, r.text);
  assert.equal(r.sc.privacy.setting_read, false);
  assert.equal(r.sc.privacy.dollar_figures, "omitted");
  assert.deepEqual(dollarFields(r.sc).filter(([, v]) => v !== null), []);
  assert.ok(r.sc.warnings.some((w: string) => /could not be read/.test(w)));
  assert.ok(!/postgres|password/.test(r.text));
  assert.equal(r.sc.real.trades, 5, "the week reaches the older buy");
});

test("share_trade_summary (one trade): a confirmed trade is shared, a paper fill as practice; unconfirmed ones and non-trades are refused", async () => {
  const { d, a } = await setup({ publicBookA: true });
  const ids = seedShare(d);

  const one = await call("share_trade_summary", { trade_id: String(ids.sell1) }, a);
  assert.equal(errCode(one), undefined, one.text);
  assert.equal(one.sc.scope.kind, "trade");
  assert.equal(one.sc.excluded, null);
  assert.equal(one.sc.trades.length, 1);
  assert.equal(one.sc.trades[0].verified_on_chain, true);
  assert.equal(one.sc.real.realized_return_pct, 20);
  assert.match(one.sc.text, /Confirmed on .+: https:\/\//);
  assert.match(one.sc.post_line, /confirmed on chain/);

  const paper = await call("share_trade_summary", { trade_id: String(ids.paperSell) }, a);
  assert.equal(errCode(paper), undefined, paper.text);
  assert.equal(paper.sc.real.trades, 0, "a paper fill is never a real trade");
  assert.equal(paper.sc.practice.trades, 1);
  assert.equal(paper.sc.trades[0].book, "paper");
  assert.equal(paper.sc.trades[0].money, "simulated");
  assert.equal(paper.sc.trades[0].verified_on_chain, false);
  assert.equal(paper.sc.trades[0].explorer_url, null);
  assert.match(paper.sc.text, /PRACTICE trade/);
  assert.ok(paper.sc.warnings.some((w: string) => /practice \(paper\)/.test(w)));

  for (const [id, why] of [[ids.submitted, /not confirmed/], [ids.reverted, /reverted/], [ids.noHash, /no transaction hash/], [ids.vault, /not a trade/]] as const) {
    const r = await call("share_trade_summary", { trade_id: String(id) }, a);
    assert.equal(errCode(r), "conflict", `trade ${id}: ${r.text}`);
    assert.match(r.sc.error.message, why);
  }
});

test("share_trade_summary: another owner's trade id reads exactly like one that does not exist", async () => {
  const { d, a, b } = await setup({ publicBookA: true });
  const ids = seedShare(d);
  const foreign = await call("share_trade_summary", { trade_id: String(ids.foreign) }, a);
  assert.equal(errCode(foreign), "not_found");
  const missing = await call("share_trade_summary", { trade_id: "987654" }, a);
  assert.equal(errCode(missing), "not_found");
  assert.equal(foreign.sc.error.message, missing.sc.error.message);
  assert.ok(!foreign.text.includes("BSECRET") && !foreign.text.includes(txh(20)));

  // And the other way round: B cannot share A's trade, and B's own summary holds only B's.
  const reverse = await call("share_trade_summary", { trade_id: String(ids.sell1) }, b);
  assert.equal(errCode(reverse), "not_found");
  const bDay = await call("share_trade_summary", { period: "day" }, b);
  assert.deepEqual(bDay.sc.trades.map((t: any) => t.trade_id), [String(ids.foreign)]);
  assert.equal(bDay.sc.practice.trades, 0);

  // Naming an agent that is not shared with this connection is not_found too.
  const other = await call("share_trade_summary", { agent: SLUG_B }, a);
  assert.equal(errCode(other), "not_found");
});

test("share_trade_summary: input rules, scope, testnet labelling, and untrusted symbols", async () => {
  const { d, a } = await setup({ publicBookA: true, agentA: agentFixture(SLUG_A, ACCOUNT_A, { chainId: 46630 }) });
  trade(d, ACCOUNT_A, { status: "landed", sell: USDG, buy: T1, side: "buy", qty: "1", cash: 2, source: "receipt", symbol: "NV\u202eDA", op: oph(40), tx: txh(40), at: NOW - 60 });

  const both = await call("share_trade_summary", { trade_id: "1", period: "day" }, a);
  assert.equal(errCode(both), "invalid_input");
  const badPeriod = await call("share_trade_summary", { period: "month" }, a);
  assert.equal(errCode(badPeriod), "invalid_input");
  const badId = await call("share_trade_summary", { trade_id: "0x10" }, a);
  assert.equal(errCode(badId), "invalid_input");

  const r = await call("share_trade_summary", { period: "day" }, a);
  assert.equal(errCode(r), undefined, r.text);
  assert.equal(r.sc.network.real_money, false);
  assert.equal(r.sc.real.money, "testnet");
  assert.equal(r.sc.trades[0].money, "testnet");
  assert.ok(r.sc.trades[0].explorer_url.startsWith(`${explorerFor(46630)}/tx/`));
  assert.ok(r.sc.warnings.some((w: string) => /test funds/.test(w)));
  assert.match(r.sc.text, /test funds/);
  assert.equal(r.sc.trades[0].symbol, "NVDA", "the bidi override is stripped from the structured symbol");
  assert.ok(!r.text.includes("\u202e"), "and never reaches the text");
  assert.ok(r.sc.untrusted_fields.includes("text"));

  const { a: noPortfolio } = await (async () => {
    const d2 = await makeTestDb();
    const deps = makeDeps(d2);
    restore?.();
    restore = installFixtures(d2);
    return { a: (await connectAs(deps, OWNER_A, { scopes: ["agents:read", "social:write"] })).principal };
  })();
  const denied = await call("share_trade_summary", { period: "day" }, noPortfolio);
  assert.equal(errCode(denied), "insufficient_scope", "reading private trades needs portfolio:read, not social:write");
});

test("share_trade_summary: post_line is held to the group chat's gate, and is null (with a reason) when it would be refused", async () => {
  const { d, a } = await setup({ publicBookA: false });
  seedShare(d);
  const ok = await call("share_trade_summary", { period: "day" }, a);
  assert.equal(ok.sc.post_line, "Robin: 4 trades confirmed on Robinhood Chain in the last 24 hours, +20.00% realised on 1 measured sell, plus 2 practice (paper) fills, not counted.");

  // An agent name that reads as a link would be refused by draft_post, so no line is offered.
  d.raw.prepare("UPDATE agents SET name = ? WHERE smart_account = ?").run("Robin of scam.com", ACCOUNT_A);
  const refused = await call("share_trade_summary", { period: "day" }, a);
  assert.equal(errCode(refused), undefined, refused.text);
  assert.equal(refused.sc.post_line, null);
  assert.ok(refused.sc.warnings.some((w: string) => /post_line is null/.test(w)));
  assert.match(refused.sc.text, /^Robin of scam\.com on Merrymen/, "the paste-anywhere text is the owner's own and still carries the name");
});

// ── review additions: the failure modes the first suite did not reach ───────

test("share_trade_summary: a landed row with a garbled hash is counted as left out, and a row stamped after `until` is neither listed nor counted", async () => {
  const { d, a } = await setup({ publicBookA: true });
  const ids = seedShare(d);
  // Not NULL, not empty, not a 66-character hash: the confirmed filter drops
  // it, so it must land in landed_without_tx_hash rather than in neither.
  const garbled = trade(d, ACCOUNT_A, { status: "landed", sell: USDG, buy: T1, side: "buy", qty: "1", cash: 1, source: "receipt", symbol: "NVDA", op: oph(50), tx: "0xpending", at: NOW - 900 });
  // A worker clock ahead of this one: outside a summary that says "to <until>".
  const future = trade(d, ACCOUNT_A, { status: "landed", sell: USDG, buy: T1, side: "buy", qty: "1", cash: 1, source: "receipt", symbol: "NVDA", op: oph(51), tx: txh(51), at: NOW + 120 });

  const r = await call("share_trade_summary", { period: "day" }, a);
  assert.equal(errCode(r), undefined, r.text);
  assert.equal(r.sc.excluded.landed_without_tx_hash, 2, "the NULL-hash row and the garbled one");
  assert.equal(r.sc.real.trades, 4);
  for (const id of [garbled, future]) assert.ok(!r.sc.trades.some((t: any) => t.trade_id === String(id)), `trade ${id} must not be listed`);
  assert.ok(r.sc.trades.some((t: any) => t.trade_id === String(ids.sell1)));

  const one = await call("share_trade_summary", { trade_id: String(garbled) }, a);
  assert.equal(errCode(one), "conflict", "a garbled hash cannot be checked on chain, so it is not shared as verified");
});

test("share_trade_summary: past the scan bound the counts are floors, no return is claimed, and 'no trades' is never asserted from a cut-short read", async () => {
  const { d, a } = await setup({ publicBookA: true });
  d.raw.exec("BEGIN");
  for (let i = 0; i < 501; i++) {
    trade(d, ACCOUNT_A, { status: "landed", sell: USDG, buy: T1, side: "buy", qty: "1", cash: 1, source: "receipt", symbol: "NVDA", op: oph(1000 + i), tx: txh(1000 + i), at: NOW - 10_000 + i });
  }
  d.raw.exec("COMMIT");
  const r = await call("share_trade_summary", { period: "day" }, a);
  assert.equal(errCode(r), undefined, r.text);
  assert.equal(r.sc.real.complete, false);
  assert.equal(r.sc.real.trades, 500, "the trades read, reported as a floor");
  assert.equal(r.sc.real.realized_return_pct, null);
  assert.equal(r.sc.real.realized_pnl_usdg, null);
  assert.equal(r.sc.trades.length, 20);
  assert.equal(r.sc.trades_total, 500);
  assert.ok(r.sc.warnings.some((w: string) => /More than 500 confirmed operations/.test(w)));
  assert.match(r.sc.text, /at least 500/);
  assert.match(r.sc.post_line, /at least 500 trades/);

  // Only non-trades in the newest 500: "no trades" would be a claim the read cannot make.
  const { d: d2, a: a2 } = await setup({ publicBookA: true });
  d2.raw.exec("BEGIN");
  for (let i = 0; i < 501; i++) {
    trade(d2, ACCOUNT_A, { kind: "vault-deposit", status: "landed", sell: USDG, buy: null, op: oph(3000 + i), tx: txh(3000 + i), at: NOW - 10_000 + i });
  }
  d2.raw.exec("COMMIT");
  const v = await call("share_trade_summary", { period: "day" }, a2);
  assert.equal(errCode(v), undefined, v.text);
  assert.equal(v.sc.real.trades, 0);
  assert.equal(v.sc.real.complete, false);
  assert.doesNotMatch(v.sc.text, /No trades were confirmed/);
  assert.match(v.sc.text, /No trades among the newest 500/);
  assert.equal(v.sc.post_line, null, "no one-line 'no trades' claim from a cut-short read");
});

test("share_trade_summary: a refused operation is not shareable, and a public book can still keep links out of the text", async () => {
  const { d, a } = await setup({ publicBookA: true });
  seedShare(d);
  const refused = trade(d, ACCOUNT_A, { status: "rejected", sell: USDG, buy: T1, side: "buy", rule: "per-trade-cap", at: NOW - 700 });
  const r = await call("share_trade_summary", { trade_id: String(refused) }, a);
  assert.equal(errCode(r), "conflict");
  assert.match(r.sc.error.message, /refused before anything was sent/);

  const noLinks = await call("share_trade_summary", { period: "day", include_links: false }, a);
  assert.equal(errCode(noLinks), undefined, noLinks.text);
  assert.equal(noLinks.sc.privacy.links_in_text, false);
  assert.ok(!noLinks.sc.text.includes("http"));
  assert.equal(noLinks.sc.privacy.dollar_figures, "included", "links and dollars are separate choices");
  assert.ok(!noLinks.sc.warnings.some((w: string) => /explorer link/.test(w)), "no private-book warning on a public book");
});

test("follow_agent: an unreadable ledger is a retryable outage with none of the driver's text, never 'no such agent'", async () => {
  const { d, a, store } = await setup();
  d.raw.exec("DROP TABLE agents");
  const r = await call("follow_agent", { target: SLUG_B }, a);
  assert.equal(errCode(r), "upstream_unavailable", r.text);
  assert.ok(!/no such table|agents|sqlite/i.test(r.sc.error.message), r.text);
  assert.deepEqual(store.targets(OWNER_A), [], "nothing is written when existence could not be checked");
});

test("list_following: a directory outage still lists the edges (unknown, not gone), and a cap overshot by a race is reported, not hidden", async () => {
  const { a, store } = await setup();
  await store.follow(OWNER_A, SLUG_B);
  installIdentities({ down: true });
  const down = await call("list_following", {}, a);
  assert.equal(errCode(down), undefined, down.text);
  assert.equal(down.sc.count, 1);
  assert.equal(down.sc.following[0].public, null, "could not be checked is null, not false");
  assert.equal(down.sc.following[0].name, null);
  assert.ok(down.sc.warnings.some((w: string) => /could not be read/.test(w)));
  assert.ok(!down.sc.warnings.some((w: string) => /no longer resolve/.test(w)), "an outage is not reported as dangling edges");

  // Two replicas each saw MAX_FOLLOWS - 1 and both inserted (the store's documented race).
  installIdentities();
  for (const p of PEERS.slice(0, MAX_FOLLOWS)) {
    const list = store.edges.get(OWNER_A) ?? [];
    list.push({ target: p.slug, createdAt: 1_750_000_000 + list.length });
    store.edges.set(OWNER_A, list);
  }
  const over = await call("list_following", {}, a);
  assert.equal(errCode(over), undefined, over.text);
  assert.equal(over.sc.count, MAX_FOLLOWS + 1);
  assert.equal(over.sc.slots_left, 0);
  assert.ok(over.sc.warnings.some((w: string) => new RegExp(`only the newest ${MAX_FOLLOWS} feed`, "i").test(w)), JSON.stringify(over.sc.warnings));
});

test("unfollow_agent: the delete is issued even when the first read missed the edge (a follow racing in from another replica)", async () => {
  const { a, store } = await setup();
  await store.follow(OWNER_A, SLUG_B);
  let reads = 0;
  // The first read predates the racing follow; later reads see it.
  const racing: FollowStoreLike = {
    following: async (t) => (reads++ === 0 ? [] : store.following(t)),
    follow: (t, s) => store.follow(t, s),
    unfollow: (t, s) => store.unfollow(t, s),
  };
  setFollowStoreForTest(racing);
  const r = await call("unfollow_agent", { target: SLUG_B }, a);
  assert.equal(errCode(r), undefined, r.text);
  assert.deepEqual(store.targets(OWNER_A), [], "the unfollow the caller asked for took effect");
  assert.deepEqual(r.sc.wired, []);
});

test("social tools: every schema converts to JSON Schema, and the annotations say what each one does", async () => {
  const z = await import("zod");
  for (const t of SOCIAL_TOOLS as unknown as ToolDef[]) {
    assert.doesNotThrow(() => z.toJSONSchema(t.input, { io: "input" }), `${t.name} input`);
    assert.doesNotThrow(() => z.toJSONSchema(t.output), `${t.name} output`);
  }
  assert.deepEqual(SOCIAL_TOOLS.map((t) => t.name), ["follow_agent", "unfollow_agent", "list_following", "share_trade_summary"]);
  assert.equal(tool("follow_agent").annotations.readOnlyHint, false);
  assert.equal(tool("unfollow_agent").annotations.readOnlyHint, false);
  assert.equal(tool("list_following").annotations.readOnlyHint, true);
  assert.equal(tool("follow_agent").capability, "social.write");
  assert.equal(tool("unfollow_agent").capability, "social.write");
  assert.equal(tool("list_following").capability, "agents.read");
});
