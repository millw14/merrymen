/**
 * get_perp_positions on SQLite with the full ledger schema, through runTool
 * (the wrapper the MCP server calls), plus the perps line get_portfolio and
 * get_exposure gain. What is pinned is docs/perps.md's honesty for a reader:
 * paper is labelled paper, "not reported", "unreadable" and "Lighter unread"
 * are each kept apart from "nothing held", no sentence claims the money is in
 * the smart account, and another owner reads nothing.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { PerpsReport } from "@merrymen/core";
import type { AgentDirectory } from "../agents";
import type { Principal } from "../oauth/server";
import { resetMetricsForTest } from "../observe";
import {
  errorOf, ACCOUNT_A, ACCOUNT_B, OWNER_A, OWNER_B, SLUG_A, SLUG_B, agentFixture, connectAs, fixtureDirectory, installFixtures, makeDeps, makeTestDb, type TestDb,
} from "../testing";
import { runTool, type ToolDef } from "../tool";
import { AGENT_CONTROLS } from "./agents";
import { PERPS_TOOLS, bookOf, exposureOf, perpsPortfolioLine, readPerpsReports, type ReportRead } from "./perps";
import type { Db } from "../../../../worker/src/db";
import { PORTFOLIO_TOOLS } from "./portfolio";

let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; resetMetricsForTest(); });

const NOW = 1_800_000_000;
const ACCOUNT_OLD = "0x000000000000000000000000000000000000a0d0" as const;

const tool = (name: string) => [...PERPS_TOOLS, ...PORTFOLIO_TOOLS].find((t) => t.name === name) as unknown as ToolDef;

async function call(name: string, args: Record<string, unknown>, p: Principal) {
  const res = await runTool(tool(name), args, p, "trace-test", { now: () => NOW });
  return { res, sc: (res.isError ? { error: errorOf(res) } : res.structuredContent) as Record<string, any>, text: JSON.stringify(res) };
}

const errCode = (r: { sc: Record<string, any> }): string | undefined => r.sc?.error?.code;

function agentRow(d: TestDb, account: string, owner: string, mode = "live") {
  d.raw.prepare(`INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, mode, beat_at, epoch)
    VALUES (?, 'Agent', ?, '0x1', 4663, '{}', 1700000000, 4102444800, 'active', ?, ?, 1)`).run(account, owner, mode, NOW - 30);
}

function setPerps(d: TestDb, account: string, report: unknown) {
  d.raw.prepare("UPDATE agents SET perps = ? WHERE smart_account = ?").run(typeof report === "string" ? report : JSON.stringify(report), account);
}

async function setup(o: { scopes?: string[]; directory?: AgentDirectory } = {}) {
  const d = await makeTestDb();
  const directory = o.directory ?? fixtureDirectory();
  const deps = makeDeps(d, { agents: directory });
  restore = installFixtures(d, { directory, settings: { [OWNER_A]: { tickSeconds: 240 } } });
  const a = await connectAs(deps, OWNER_A, o.scopes ? { scopes: o.scopes } : {});
  const b = await connectAs(deps, OWNER_B);
  return { d, a: a.principal, b: b.principal };
}

// ── reports, in the shape the worker writes (core PerpsReport) ──────────────

const BTC_LONG = {
  market: "BTC-PERP", side: "long", baseAmount: "0.00020", entryPrice: "100000.0", markPrice: "101000.0", leverage: 2,
  marginMicro: "10000000", liqPrice: "50500.0", unrealizedMicro: "200000", stopTrigger: "95000.0", fundingMicro: "-1234",
};

const PAPER: PerpsReport = {
  v: 1, mode: "paper", blocker: null, venueReadAt: (NOW - 20) * 1000, protectAt: (NOW - 10) * 1000, accountIndex: null,
  positions: [BTC_LONG as PerpsReport["positions"][number]],
  openNotionalMicro: "20000000", collateralMicro: "10000000", inTransitMicro: "0", minLiqDistanceBps: 5000, stopsMissing: 0, incident: false,
};

const LIVE: PerpsReport = {
  ...PAPER,
  mode: "live",
  accountIndex: 6560,
  positions: [{ ...BTC_LONG, market: "ETH-PERP", side: "short", stopTrigger: null, markPrice: null, leverage: 3 } as PerpsReport["positions"][number]],
  collateralMicro: "30000000",
  stopsMissing: 1,
};

/** Lighter unread: the ledger's positions, every venue figure null — and one more position counted than listed. */
const UNREAD: PerpsReport = {
  v: 1, mode: "live", blocker: "perps-venue-unreachable", venueReadAt: (NOW - 900) * 1000, protectAt: (NOW - 10) * 1000, accountIndex: 6560,
  positions: [{ ...BTC_LONG, markPrice: null, liqPrice: null, unrealizedMicro: null, stopTrigger: null } as PerpsReport["positions"][number]],
  openNotionalMicro: null, collateralMicro: null, inTransitMicro: null, minLiqDistanceBps: null, stopsMissing: 2, incident: false,
};

const OFF_FLAT: PerpsReport = {
  v: 1, mode: "off", blocker: "perps-off", venueReadAt: null, protectAt: null, accountIndex: null, positions: [],
  openNotionalMicro: "0", collateralMicro: "0", inTransitMicro: "0", minLiqDistanceBps: null, stopsMissing: 0, incident: false,
};

/** Perps switched off with something still held, and no Lighter account named: the report does not say which book. */
const OFF_HELD: PerpsReport = { ...PAPER, mode: "off", blocker: "perps-off" };

/** The one sentence reserved for a kill with nothing at the venue (custodySentence `none`) — never said here. */
const HOME_CLAIM = /stay in (your|the)( owner's)? smart account|funds stay|positions untouched/i;

// ── the tool ────────────────────────────────────────────────────────────────

test("paper perps are labelled paper and simulated, with every figure converted and the stop shown only as seen", async () => {
  const { d, a } = await setup();
  agentRow(d, ACCOUNT_A, OWNER_A, "paper");
  setPerps(d, ACCOUNT_A, PAPER);
  const { sc, text } = await call("get_perp_positions", { agent: SLUG_A }, a);
  assert.equal(sc.report, "reported");
  assert.equal(sc.perps_mode, "paper");
  assert.equal(sc.book, "paper");
  assert.equal(sc.money, "simulated");
  assert.equal(sc.exposure, "held");
  assert.equal(sc.venue_state, "read");
  assert.equal(sc.positions_complete, true);
  assert.equal(sc.account, ACCOUNT_A);
  assert.equal(sc.account_is_current, true);
  assert.equal(sc.account_index, null);
  assert.deepEqual(sc.positions, [{
    market: "BTC-PERP", side: "long", size: "0.00020", entry_price: "100000.0", mark_price: "101000.0", leverage: 2, margin_usdg: 10,
    liquidation_price: "50500.0", unrealized_pnl_usdg: 0.2, stop_trigger: "95000.0", stop_seen_resting: true, funding_usdg: -0.001234,
  }]);
  assert.deepEqual(sc.totals, { open_notional_usdg: 20, collateral_usdg: 10, in_transit_usdg: 0 });
  assert.equal(sc.min_liquidation_distance_pct, 50);
  assert.equal(sc.venue_read_at, new Date((NOW - 20) * 1000).toISOString());
  assert.equal(sc.protect_checked_at, new Date((NOW - 10) * 1000).toISOString());
  assert.equal(sc.worker_heartbeat_at, new Date((NOW - 30) * 1000).toISOString());
  assert.equal(sc.worker_fresh, true);
  assert.match(sc.custody, /Simulated/);
  assert.match(sc.custody, /Nothing is at Lighter/);
  assert.match(text, /paper perpetuals \(simulated\): 1 position, 10\.00 USDG collateral\./);
  assert.doesNotMatch(text, HOME_CLAIM);
});

test("live perps are labelled real funds at Lighter, name the account index, and count the stop that was not seen", async () => {
  const { d, a } = await setup();
  agentRow(d, ACCOUNT_A, OWNER_A);
  setPerps(d, ACCOUNT_A, LIVE);
  const { sc, text } = await call("get_perp_positions", { agent: SLUG_A }, a);
  assert.equal(sc.book, "live");
  assert.equal(sc.money, "real");
  assert.equal(sc.account_index, 6560);
  assert.equal(sc.stops_missing, 1);
  assert.equal(sc.positions[0].stop_seen_resting, false);
  assert.equal(sc.positions[0].stop_trigger, null);
  assert.equal(sc.positions[0].mark_price, null, "a mark that was not read stays null");
  assert.equal(sc.totals.collateral_usdg, 30);
  assert.match(sc.custody, /not in the smart account/);
  assert.match(sc.custody, /withdrawal delay and a claim/);
  assert.match(text, /live perpetuals \(real funds\): 1 position, 30\.00 USDG collateral, 1 without a stop seen resting\./);
  assert.doesNotMatch(text, HOME_CLAIM);
});

test("Lighter unread is never 'no positions': the ledger's positions with venue figures null, marked incomplete, with the uncounted one named", async () => {
  const { d, a } = await setup();
  agentRow(d, ACCOUNT_A, OWNER_A);
  setPerps(d, ACCOUNT_A, UNREAD);
  const { sc, text } = await call("get_perp_positions", { agent: SLUG_A }, a);
  assert.equal(sc.venue_state, "unread");
  assert.equal(sc.exposure, "held");
  assert.equal(sc.positions_complete, false);
  assert.deepEqual(sc.totals, { open_notional_usdg: null, collateral_usdg: null, in_transit_usdg: null });
  assert.equal(sc.positions.length, 1);
  assert.equal(sc.positions[0].liquidation_price, null);
  assert.equal(sc.positions[0].unrealized_pnl_usdg, null);
  assert.deepEqual(sc.blocker, {
    code: "perps-venue-unreachable",
    what: "Lighter cannot be reached right now, so no new positions are opened.",
    remedy: null,
  });
  assert.ok(sc.warnings.some((w: string) => /1 more position is held than listed/.test(w)), JSON.stringify(sc.warnings));
  assert.match(sc.custody, /Lighter could not be read/);
  assert.match(text, /Lighter could not be read at the last check; leveraged positions may be open\./);
  assert.doesNotMatch(text, HOME_CLAIM);

  // Unread with nothing listed is unknown, not none.
  setPerps(d, ACCOUNT_A, { ...UNREAD, positions: [], stopsMissing: 0 });
  const empty = await call("get_perp_positions", { agent: SLUG_A }, a);
  assert.equal(empty.sc.exposure, "unknown");
  assert.equal(empty.sc.positions_complete, false);
});

test("no report, and a report this build cannot read, are unknown — never an empty book", async () => {
  const { d, a } = await setup();
  // No agents row at all.
  let r = await call("get_perp_positions", { agent: SLUG_A }, a);
  assert.equal(r.sc.report, "not_reported");
  assert.equal(r.sc.exposure, "unknown");
  assert.equal(r.sc.venue_state, "unknown");
  assert.equal(r.sc.positions_complete, false);
  assert.equal(r.sc.book, null);
  assert.equal(r.sc.stops_missing, null);
  assert.match(r.text, /whether anything is held at Lighter is unknown/);

  // A row whose column is NULL: the worker has not said.
  agentRow(d, ACCOUNT_A, OWNER_A);
  r = await call("get_perp_positions", { agent: SLUG_A }, a);
  assert.equal(r.sc.report, "not_reported");
  assert.match(r.sc.report_explained, /unknown, not "no positions"/);

  // Garbled JSON, an unknown version, and one malformed position all reject the whole report.
  for (const bad of ["{not json", JSON.stringify({ ...PAPER, v: 2 }), JSON.stringify({ ...PAPER, positions: [{ ...BTC_LONG, side: "sell" }] })]) {
    setPerps(d, ACCOUNT_A, bad);
    r = await call("get_perp_positions", { agent: SLUG_A }, a);
    assert.equal(r.sc.report, "unreadable", bad);
    assert.equal(r.sc.exposure, "unknown", bad);
    assert.deepEqual(r.sc.positions, [], bad);
    assert.equal(r.sc.positions_complete, false, bad);
  }
});

test("perps off with nothing held reads none; off while something is still held does not guess the book", async () => {
  const { d, a } = await setup();
  agentRow(d, ACCOUNT_A, OWNER_A);
  setPerps(d, ACCOUNT_A, OFF_FLAT);
  let r = await call("get_perp_positions", { agent: SLUG_A }, a);
  assert.equal(r.sc.exposure, "none");
  assert.equal(r.sc.perps_mode, "off");
  assert.equal(r.sc.blocker.code, "perps-off");
  assert.match(r.text, /perpetuals are off; nothing held\./);
  assert.doesNotMatch(r.text, HOME_CLAIM);

  setPerps(d, ACCOUNT_A, OFF_HELD);
  r = await call("get_perp_positions", { agent: SLUG_A }, a);
  assert.equal(r.sc.exposure, "held");
  assert.equal(r.sc.book, null);
  assert.equal(r.sc.money, null);
  assert.match(r.sc.book_why, /does not say whether anything it lists is paper or real/);

  // A named Lighter account is real, whatever the rail says.
  setPerps(d, ACCOUNT_A, { ...OFF_HELD, accountIndex: 77 });
  r = await call("get_perp_positions", { agent: SLUG_A }, a);
  assert.equal(r.sc.book, "live");
  assert.equal(r.sc.money, "real");
});

test("an incident is never 'none', even when every figure reads zero", async () => {
  const { d, a } = await setup();
  agentRow(d, ACCOUNT_A, OWNER_A);
  setPerps(d, ACCOUNT_A, { ...OFF_FLAT, mode: "live", blocker: "perps-unknown-activity", accountIndex: 6560, incident: true });
  const { sc } = await call("get_perp_positions", { agent: SLUG_A }, a);
  assert.equal(sc.incident, true);
  assert.equal(sc.exposure, "unknown");
  assert.match(sc.blocker.remedy, /merrymen recover/);
});

test("the signed permission's perps marker is reported as it is", async () => {
  const directory = fixtureDirectory({
    [OWNER_A]: [agentFixture(SLUG_A, ACCOUNT_A, { features: ["perp-lighter-v1"] })],
    [OWNER_B]: [agentFixture(SLUG_B, ACCOUNT_B)],
  });
  const { a, b } = await setup({ directory });
  assert.equal((await call("get_perp_positions", { agent: SLUG_A }, a)).sc.permission_includes_perps, true);
  assert.equal((await call("get_perp_positions", { agent: SLUG_B }, b)).sc.permission_includes_perps, false);
});

test("after a kill (no current account) the most recent account's report is read and said to be that", async () => {
  const directory = fixtureDirectory({
    [OWNER_A]: [agentFixture(SLUG_A, ACCOUNT_A, { account: null, orderAgentId: null })],
    [OWNER_B]: [agentFixture(SLUG_B, ACCOUNT_B)],
  });
  const { d, a } = await setup({ directory });
  agentRow(d, ACCOUNT_A, OWNER_A);
  setPerps(d, ACCOUNT_A, LIVE);
  const { sc } = await call("get_perp_positions", { agent: SLUG_A }, a);
  assert.equal(sc.account, ACCOUNT_A);
  assert.equal(sc.account_is_current, false);
  assert.equal(sc.exposure, "held");
  assert.ok(sc.warnings.some((w: string) => /no current signed permission/.test(w)), JSON.stringify(sc.warnings));
});

test("an earlier account that still reports perps is named in the warnings; one that never had perps is not", async () => {
  const directory = fixtureDirectory({
    [OWNER_A]: [agentFixture(SLUG_A, ACCOUNT_A, { accounts: [ACCOUNT_A, ACCOUNT_OLD] })],
    [OWNER_B]: [agentFixture(SLUG_B, ACCOUNT_B)],
  });
  const { d, a } = await setup({ directory });
  agentRow(d, ACCOUNT_A, OWNER_A);
  agentRow(d, ACCOUNT_OLD, OWNER_A);
  setPerps(d, ACCOUNT_A, OFF_FLAT);
  let r = await call("get_perp_positions", { agent: SLUG_A }, a);
  assert.deepEqual(r.sc.warnings, []);
  setPerps(d, ACCOUNT_OLD, LIVE);
  r = await call("get_perp_positions", { agent: SLUG_A }, a);
  assert.equal(r.sc.exposure, "none", "the current account's own report is what exposure describes");
  assert.ok(r.sc.warnings.some((w: string) => w.includes(ACCOUNT_OLD) && /still held/.test(w)), JSON.stringify(r.sc.warnings));
});

test("another owner reads nothing, and a connection without portfolio:read is refused before any read", async () => {
  const { d, a, b } = await setup();
  agentRow(d, ACCOUNT_A, OWNER_A);
  setPerps(d, ACCOUNT_A, LIVE);
  const other = await call("get_perp_positions", { agent: SLUG_A }, b);
  assert.equal(errCode(other), "not_found");
  assert.ok(!other.text.includes("ETH-PERP") && !other.text.includes(ACCOUNT_A));
  // B's own agent never carries A's report.
  const own = await call("get_perp_positions", {}, b);
  assert.equal(own.sc.report, "not_reported");
  assert.ok(!own.text.includes("ETH-PERP"));

  restore?.();
  const narrow = await setup({ scopes: ["agents:read", "offline_access"] });
  agentRow(narrow.d, ACCOUNT_A, OWNER_A);
  setPerps(narrow.d, ACCOUNT_A, LIVE);
  const r = await call("get_perp_positions", { agent: SLUG_A }, narrow.a);
  assert.equal(errCode(r), "insufficient_scope");
  assert.ok(!r.text.includes("ETH-PERP"));
});

test("the tool is read-only and says it cannot open, close or move anything", () => {
  const def = tool("get_perp_positions");
  assert.equal(def.capability, "portfolio.read");
  assert.equal(def.annotations.readOnlyHint, true);
  assert.equal(def.annotations.openWorldHint, false);
  assert.match(def.description, /Read-only: it cannot open, close or move anything\./);
});

// ── the portfolio line ──────────────────────────────────────────────────────

test("get_portfolio and get_exposure gain one perps line when something is held or unread, and none when nothing is", async () => {
  const { d, a } = await setup();
  agentRow(d, ACCOUNT_A, OWNER_A);

  // No report: no line (an agent that never had perps grows nothing).
  let p = await call("get_portfolio", { agent: SLUG_A }, a);
  assert.ok(!p.sc.warnings.some((w: string) => /Perpetuals/.test(w)), JSON.stringify(p.sc.warnings));
  assert.doesNotMatch(p.sc.custody_note, /Perpetual/);

  setPerps(d, ACCOUNT_A, OFF_FLAT);
  p = await call("get_portfolio", { agent: SLUG_A }, a);
  assert.ok(!p.sc.warnings.some((w: string) => /Perpetuals/.test(w)));

  setPerps(d, ACCOUNT_A, LIVE);
  p = await call("get_portfolio", { agent: SLUG_A }, a);
  assert.ok(p.sc.warnings.includes("Perpetuals (live, real funds): 1 leveraged position and 30.00 USDG of collateral at Lighter, not listed under positions."), JSON.stringify(p.sc.warnings));
  assert.match(p.sc.custody_note, /Perpetual futures positions are not listed here \(see warnings\)\./);

  setPerps(d, ACCOUNT_A, PAPER);
  p = await call("get_portfolio", { agent: SLUG_A }, a);
  assert.ok(p.sc.warnings.includes("Perpetuals (paper, simulated money): 1 leveraged position and 10.00 USDG of collateral in the paper book, not listed under positions."), JSON.stringify(p.sc.warnings));

  setPerps(d, ACCOUNT_A, UNREAD);
  const e = await call("get_exposure", {}, a);
  assert.ok(e.sc.warnings.some((w: string) => w.startsWith(`${SLUG_A}: Perpetuals (live, real funds): Lighter could not be read`)), JSON.stringify(e.sc.warnings));
});

// ── the pure helpers ────────────────────────────────────────────────────────

test("exposureOf, bookOf and the portfolio line keep unknown apart from none", () => {
  const rep = (report: PerpsReport): ReportRead => ({ state: "reported", report, beatAt: null });
  assert.equal(exposureOf(undefined), "unknown");
  assert.equal(exposureOf({ state: "not_reported", beatAt: null }), "unknown");
  assert.equal(exposureOf({ state: "unreadable", beatAt: null, cause: "parse" }), "unknown");
  assert.equal(exposureOf(rep(OFF_FLAT)), "none");
  assert.equal(exposureOf(rep({ ...OFF_FLAT, inTransitMicro: "5000000" })), "held", "money on its way is money held");
  assert.equal(exposureOf(rep({ ...OFF_FLAT, collateralMicro: null })), "unknown");
  assert.equal(exposureOf(rep({ ...OFF_FLAT, stopsMissing: 1 })), "held", "a counted, unlisted position is a position");
  assert.deepEqual(bookOf(PAPER).book, "paper");
  assert.deepEqual(bookOf(LIVE).book, "live");
  assert.deepEqual(bookOf(OFF_HELD).book, null);
  assert.match(perpsPortfolioLine({ state: "unreadable", beatAt: null, cause: "query" })!, /unknown \(not zero\)/);
  assert.match(perpsPortfolioLine({ state: "unreadable", beatAt: null, cause: "parse" })!, /unknown \(not zero\)/);
  assert.equal(perpsPortfolioLine({ state: "not_reported", beatAt: null }), null);
  assert.equal(perpsPortfolioLine(rep(OFF_FLAT)), null);
});

test("a ledger from before the column has said nothing; any other failed read is unreadable, never nothing", async () => {
  const failing = (message: string) => ({
    prepare: () => ({ all: async () => { throw new Error(message); }, get: async () => undefined, run: async () => ({}) }),
  }) as unknown as Db;
  const sqliteOld = await readPerpsReports(failing("no such column: perps"), [ACCOUNT_A]);
  assert.equal(sqliteOld.get(ACCOUNT_A)?.state, "not_reported");
  const pgOld = await readPerpsReports(failing('column "perps" does not exist'), [ACCOUNT_A]);
  assert.equal(pgOld.get(ACCOUNT_A)?.state, "not_reported");
  const down = await readPerpsReports(failing("connection terminated unexpectedly"), [ACCOUNT_A]);
  assert.deepEqual(down.get(ACCOUNT_A), { state: "unreadable", beatAt: null, cause: "query" });
  assert.equal(exposureOf(down.get(ACCOUNT_A)), "unknown");
});

// ── the kill switch's words ─────────────────────────────────────────────────

test("the kill switch no longer says, of every agent, that the funds stay in the smart account", () => {
  const kill = AGENT_CONTROLS.find((c) => c.control === "kill switch")!;
  assert.doesNotMatch(kill.effect, /Funds stay in the owner's smart account\./);
  assert.match(kill.effect, /Funds in the owner's smart account stay there\./);
  assert.match(kill.effect, /positions and collateral behind/);
  assert.match(kill.effect, /Lighter's delay and a claim/);
  assert.match(kill.effect, /completed shutdown does not prove the funds have arrived home/);
});
