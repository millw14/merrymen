/**
 * THE KILL MATRIX, SLICE 3: A PERPS-ONLY OWNER WITH AN OPEN PAPER POSITION.
 *
 * Self-hosted, a Perps wallet's worker runs in the Perps home
 * (`accounts/perps`), with its own grant, settings.json and ledger. The
 * position here is opened by the REAL perp lane (perps/lane.ts) on the REAL
 * ledger in that home, reading a synthetic fleet feed file, with the lane's
 * settings resolved from the home's own settings.json exactly as the worker
 * resolves them (MERRYMEN_PERPS=paper, a Perps wallet's worker). Only
 * index.ts's plumbing is modelled, as paper-e2e.integration.test.ts models it,
 * plus syncGrant's one rule that matters here: no grant, nothing armed.
 *
 * What a kill must do to that position (perps-kill.ts): revoke the grant, turn
 * the paper strategy off, and leave the position FROZEN — not closed at a price
 * the kill does not have, and not traded by anything until the owner signs
 * again; then, signed again with perps off, nothing new opens and what is held
 * closes on its own stop. Every self-hosted kill path is driven: Telegram's
 * /kill (selfHostedPerpsKill), the dashboard's (the web DELETE answers through
 * perpsHalf), and `merrymen kill`, spawned for real. A half that fails is
 * reported incomplete, never done. The hosted rows are in
 * perps-kill-hosted.integration.test.ts and perps-kill-settings.postgres.test.ts.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExecMode } from "./exec-mode";
import type { AgentLimits, PerpOrderIntent, TradeIntent } from "./policy";
import { provenanceOf } from "./provenance";
import { readSettingsFileAt, mergeSettings } from "./settings";
import { readLighterFeed, specToJson, type LighterFeedFileMarket } from "./perps/feed-reader";
import { createPerpLane, type PerpLane } from "./perps/lane";
import { parseOrderBookDetails } from "./perps/markets";
import { H4, T_LAST, breakout } from "./perps/testkit-perps";

const ROOT = mkdtempSync(path.join(realpathSync(os.tmpdir()), "merrymen-perps-kill-paper-"));
const SPOT_HOME = path.join(ROOT, "home");
const PERPS_HOME = path.join(SPOT_HOME, "accounts", "perps");
mkdirSync(PERPS_HOME, { recursive: true });
// The store opens the PERPS home's ledger, as that wallet's worker does.
process.env.MERRYMEN_HOME = PERPS_HOME;
delete process.env.DATABASE_URL;
delete process.env.MERRYMEN_HOSTED;
delete process.env.MERRYMEN_FLEET_HOME;
const isolatedCwd = path.join(ROOT, "cwd");
mkdirSync(isolatedCwd);
const originalCwd = process.cwd();
const store = await import("./store");
try {
  process.chdir(isolatedCwd);
  await store.initStore();
} finally {
  process.chdir(originalCwd);
}
const { PerpsKillIncomplete, PerpsPaperNotStopped, perpsHalf, selfHostedPerpsKill, stopLocalPerpsForKill, stopLocalPerpsGrantForRenewal } = await import("./perps-kill");
after(() => {
  raw.close();
  store.closeStoreForTest();
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** A kill runs from the install's own home (Spot's), where purposeHome("perps") is accounts/perps. */
async function fromSpotHome<T>(fn: () => Promise<T>): Promise<T> {
  process.env.MERRYMEN_HOME = SPOT_HOME;
  try {
    return await fn();
  } finally {
    process.env.MERRYMEN_HOME = PERPS_HOME;
  }
}

const u = (n: number) => BigInt(Math.round(n * 1e6));
const GRANT = path.join(PERPS_HOME, "grant.json");
const SETTINGS = path.join(PERPS_HOME, "settings.json");
const ACCOUNT = "0xab000000000000000000000000000000000000c4";
const grantJson = (grantedAt: number) =>
  JSON.stringify({ owner: "0x00000000000000000000000000000000000000b1", sessionKeyAddress: "0x00000000000000000000000000000000000000c1", smartAccount: ACCOUNT, purpose: "perps", serialized: "0xserialized", chainId: 4663, grantedAt, demoOwnerPrivateKey: `0x${"77".repeat(32)}` });
/** The owner's Perps settings: practice perps on, BTC only, and keys the kill must leave alone. */
const OWNER_SETTINGS = { perpsEnabled: true, perpsMarkets: ["BTC-PERP"], paperStartUsdg: 100, agentName: "Little John", perpsMaxLeverage: 2 };

// ── the venue, as the fleet feed file carries it ────────────────────────────

const DETAILS = parseOrderBookDetails(JSON.parse(readFileSync(path.join(import.meta.dirname, "perps", "fixtures", "orderBookDetails.perp.json"), "utf8")))!;
const BTC = DETAILS.markets.get(1)!;
const FEED_FILE = path.join(ROOT, "lighter-feed.json");
let clock = T_LAST + H4 + 3_600_000;
const CANDLES = breakout("BTC-PERP", 2_000n);

function writeFeed(v: { mark: bigint; bids: [bigint, bigint][]; asks: [bigint, bigint][] }): void {
  const lastHour = Math.floor((clock / 1000 - 1800) / 3600) * 3600;
  const m: LighterFeedFileMarket = {
    observedAt: clock - 1_000,
    priceSource: "ws",
    mark: v.mark.toString(),
    index: v.mark.toString(),
    status: "active",
    spec: specToJson(BTC.spec),
    specObservedAt: clock - 60_000,
    takerFeePpm: 0,
    makerFeePpm: 0,
    bids: v.bids.map(([p, s]) => [p.toString(), s.toString()]),
    asks: v.asks.map(([p, s]) => [p.toString(), s.toString()]),
    bookObservedAt: clock - 1_000,
    bookSource: "ws",
    closed4h: CANDLES.map((c) => ({ t: c.t, o: c.o.toString(), h: c.h.toString(), l: c.l.toString(), c: c.c.toString() })),
    candlesObservedAt: T_LAST + H4 + 60_000,
    fundings1h: Array.from({ length: 8 }, (_, i) => ({ t: lastHour - (7 - i) * 3600, rate: "0.0010", direction: "long" as const })),
    fundingsObservedAt: clock - 60_000,
  };
  writeFileSync(FEED_FILE, JSON.stringify({ v: 1, observedAt: clock - 500, markets: { "1": m } }));
}

// ── one Perps worker's worth of index.ts plumbing ───────────────────────────

const PAPER: ExecMode = { mode: "paper", rule: "live-not-enabled" };

/** The lane's settings, resolved from the Perps home's settings.json as the worker resolves them. */
function settingsNow() {
  const read = readSettingsFileAt(SETTINGS);
  if (read.kind === "unusable") throw new Error(read.why);
  return mergeSettings(read.kind === "parsed" ? read.settings : {}, { MERRYMEN_PERPS: "paper", MERRYMEN_WALLET_PURPOSE: "perps" });
}

let agentId = "";
let limits: AgentLimits;
let lane: PerpLane;
const events: string[] = [];
let opens = 0;

async function decide(intent: TradeIntent, source: string, reason?: string, known?: { whyCode?: string }) {
  if (intent.decisionId) return { ok: true as const };
  const id = store.newDecisionId();
  intent.decisionId = id;
  await store.addDecision({ id, agent_id: agentId, source, ...(reason !== undefined ? { reason } : {}), provenance: provenanceOf(source, known?.whyCode) });
  return { ok: true as const };
}

const TICK = { equityKnown: true, breakerIdle: true, breakerLimitBps: 1_000, energyEntriesLeft: true, opsHeadroom: true, spendHeadroomMicro: u(500), strategistLive: false };
const hooks = (equityUsdg: bigint) => ({
  claimEntry: async () => ({ ok: true }),
  refundEntry: async () => {},
  withholdEntry: async () => {},
  ensureDecision: decide,
  processIntentReporting: async (i: TradeIntent) => {
    const out = await lane.execute(i as PerpOrderIntent, { equityUsdg, equityKnown: true });
    if ((i as PerpOrderIntent).effect === "open" && out.status === "paper") opens += 1;
    return out;
  },
  processIntent: async (i: TradeIntent) => {
    await lane.execute(i as PerpOrderIntent, { equityUsdg, equityKnown: true });
  },
});
const pass = () => lane.protectPass({ lock: lane.lock, signal: new AbortController().signal, pass: 1 });
const held = async () => (await store.getPerpPositions(agentId, "paper")).find((p) => p.marketId === 1) ?? null;
/** A second, raw connection to the Perps home's ledger, to look at what the store wrote. */
const raw = new DatabaseSync(path.join(PERPS_HOME, "merrymen.db"));
const rows = async (sql: string) => raw.prepare(sql).all(agentId.toLowerCase()) as Record<string, unknown>[];

before(async () => {
  agentId = await store.ensureAgent({
    smartAccount: ACCOUNT,
    owner: "0x00000000000000000000000000000000000000b1",
    sessionKeyAddress: "0x00000000000000000000000000000000000000c1",
    serialized: "x",
    caps: { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 },
    grantedAt: 1_000_000,
    expiresAt: 2_000_000_000,
    chainId: 4663,
  } as never);
  await store.getPaperBook(agentId, 100);
  limits = {
    perTradeUsdg: u(50),
    dailyUsdg: u(500),
    allowedTargets: [],
    allowedAssets: [],
    cashToken: "0x00000000000000000000000000000000000000dd",
    maxDrawdownBps: 1_000,
    expiresAt: Math.floor(clock / 1000) + 30 * 86_400,
    maxOpsPerDay: 48,
  };
  lane = createPerpLane({
    store,
    // syncGrant's rule: no grant.json, no agent armed (index.ts).
    armed: () => (existsSync(GRANT) ? { agentId, smartAccount: ACCOUNT, limits } : null),
    config: () => settingsNow(),
    execMode: () => PAPER,
    readFeed: (nowMs) => readLighterFeed(FEED_FILE, nowMs),
    now: () => clock,
    agentState: async ({ equityUsdg, equityKnown }) => ({
      spentTodayUsdg: u(await store.getSpentTodayUsdg(agentId, "paper")),
      opsToday: await store.getOpsToday(agentId, "paper"),
      highWaterMarkUsdg: u(100),
      equityUsdg,
      equityKnown,
      nowSec: Math.floor(clock / 1000),
    }),
    budget: { reserve: () => {}, release: () => {}, refresh: async () => {}, keep: () => {}, counters: async () => ({ spentTodayUsdg: 0n, opsToday: 0 }) },
    events: async (_level, message) => {
      events.push(message);
    },
    decide,
    log: () => {},
  });
});

describe("a Perps-only owner with an open paper position", () => {
  let frozen: Awaited<ReturnType<typeof held>>;
  let fillsBefore = 0;

  it("before the kill: the lane opens a BTC-PERP long on paper, with its stop, in the Perps home's own ledger", async () => {
    writeFileSync(GRANT, grantJson(1_000_000));
    writeFileSync(SETTINGS, JSON.stringify(OWNER_SETTINGS, null, 2));
    writeFeed({ mark: 802_000n, bids: [[801_900n, 1_000n]], asks: [[802_000n, 1_000n]] });
    await lane.armed();
    await lane.stopProtect(); // the test drives every pass itself
    const { value, read } = await lane.readWithBook(() => store.getPaperBook(agentId, 100));
    assert.equal(read.rail.mode, "paper");
    await lane.runRoute({ ...TICK, equityUsdg: u(value.cashUsdg) }, hooks(u(100)));
    frozen = await held();
    assert.ok(frozen, "an open paper position");
    assert.equal(frozen.side, "long");
    assert.ok(frozen.stopTrigger !== null, "with its stop");
    assert.equal(opens, 1);
    fillsBefore = (await rows("SELECT 1 FROM perp_fills WHERE agent_id = ?")).length;
  });

  it("the self-hosted Telegram /kill: the grant revoked, the paper strategy off, the position FROZEN where it is", async () => {
    assert.equal(await fromSpotHome(() => selfHostedPerpsKill()), "stopped");
    assert.equal(existsSync(GRANT), false, "the grant is gone");
    assert.ok(existsSync(path.join(PERPS_HOME, "grants", `${ACCOUNT}.json`)), "and archived, owner key and all");
    const after = JSON.parse(readFileSync(SETTINGS, "utf8")) as Record<string, unknown>;
    const { perpsControlNonce, ...ownerFields } = after;
    assert.equal(typeof perpsControlNonce, "string", "kill advances the owner control generation");
    assert.deepEqual(ownerFields, { ...OWNER_SETTINGS, perpsEnabled: false }, "perps off, and nothing else the owner set touched");
    assert.deepEqual(await held(), frozen, "not closed at a price the kill does not have: the book is as it was");
    assert.equal((await rows("SELECT 1 FROM perp_fills WHERE agent_id = ?")).length, fillsBefore, "nothing booked");
  });

  it("nothing trades a frozen position: with no grant nothing is armed, and a price that would fire its stop books nothing", async () => {
    clock += 60_000;
    writeFeed({ mark: 785_000n, bids: [[785_000n, 1_000n]], asks: [[785_100n, 1_000n]] });
    await pass();
    await lane.runRoute({ ...TICK, equityUsdg: u(100) }, hooks(u(100)));
    assert.deepEqual(await held(), frozen, "no stop fired, no protective close, no route");
    assert.equal((await rows("SELECT 1 FROM perp_fills WHERE agent_id = ?")).length, fillsBefore);
  });

  it("a retry finds nothing left to do: the kill is safe to run again", async () => {
    assert.equal(await fromSpotHome(() => selfHostedPerpsKill()), null);
    assert.deepEqual(await fromSpotHome(() => perpsHalf(() => stopLocalPerpsForKill())), { state: "none" });
  });

  it("signed again with perps off: nothing new opens, and the held position closes on its own stop", async () => {
    writeFileSync(GRANT, grantJson(2_000_000));
    await lane.armed();
    await lane.stopProtect();
    // A fresh breakout the route would have entered on with perps on.
    clock += 60_000;
    writeFeed({ mark: 802_000n, bids: [[801_900n, 1_000n]], asks: [[802_000n, 1_000n]] });
    const { read } = await lane.readWithBook(() => store.getPaperBook(agentId, 100));
    assert.equal(read.rail.mode, "off", "the kill's switch holds across a new permission");
    assert.equal(read.active, true, "what is held is still the lane's to protect (rule 8a)");
    await lane.runRoute({ ...TICK, equityUsdg: u(100) }, hooks(u(100)));
    assert.equal(opens, 1, "nothing new opened");
    // The price crosses the stop (79392.0), above its worst price (77804.2):
    // the paper venue's clock fires it.
    clock += 60_000;
    writeFeed({ mark: 785_000n, bids: [[785_000n, 1_000n]], asks: [[785_100n, 1_000n]] });
    await pass();
    assert.equal((await held())?.side ?? null, null, "closed on its own stop, exits only");
    assert.ok((await rows("SELECT 1 FROM perp_fills WHERE agent_id = ?")).length > fillsBefore, "the stop's fill is booked");
  });
});

describe("the other self-hosted kill paths, and a half that fails", () => {
  it("the dashboard's kill (perpsHalf over stopLocalPerpsForKill) stops it the same way", async () => {
    writeFileSync(GRANT, grantJson(3_000_000));
    writeFileSync(SETTINGS, JSON.stringify(OWNER_SETTINGS, null, 2));
    assert.deepEqual(await fromSpotHome(() => perpsHalf(() => stopLocalPerpsForKill())), { state: "stopped" });
    assert.equal(existsSync(GRANT), false);
    assert.equal((JSON.parse(readFileSync(SETTINGS, "utf8")) as { perpsEnabled: boolean }).perpsEnabled, false);
  });

  it("a Perps PERMISSION REPLACEMENT stops the grant alone: a renewal is the owner keeping it trading, and its perps stay on", async () => {
    writeFileSync(GRANT, grantJson(3_500_000));
    writeFileSync(SETTINGS, JSON.stringify(OWNER_SETTINGS, null, 2));
    assert.equal(await fromSpotHome(() => stopLocalPerpsGrantForRenewal(ACCOUNT, "0x00000000000000000000000000000000000000c1")), "stopped");
    assert.equal(existsSync(GRANT), false, "the grant goes, so the renewal can be posted");
    assert.deepEqual(JSON.parse(readFileSync(SETTINGS, "utf8")), OWNER_SETTINGS, "and the settings are the owner's, untouched");
    // Even settings it could not read do not stop a renewal: it never reads them.
    writeFileSync(GRANT, grantJson(3_600_000));
    writeFileSync(SETTINGS, "{ not json");
    assert.equal(await fromSpotHome(() => stopLocalPerpsGrantForRenewal(ACCOUNT, "0x00000000000000000000000000000000000000c1")), "stopped");
    writeFileSync(SETTINGS, JSON.stringify(OWNER_SETTINGS, null, 2));
  });

  it("settings it cannot read: the grant is still revoked, the kill says incomplete, and a retry finishes it", async () => {
    writeFileSync(GRANT, grantJson(4_000_000));
    writeFileSync(SETTINGS, "{ not json");
    await assert.rejects(
      fromSpotHome(() => stopLocalPerpsForKill()),
      (e: unknown) => e instanceof PerpsPaperNotStopped && e instanceof PerpsKillIncomplete && /practice perpetuals could NOT be switched off/.test(e.message) && /grant was revoked/.test(e.message),
    );
    assert.equal(existsSync(GRANT), false, "the grant went regardless");
    assert.equal(readFileSync(SETTINGS, "utf8"), "{ not json", "a file it cannot read is never replaced");
    assert.equal(await fromSpotHome(() => selfHostedPerpsKill()), "paper-not-stopped", "never none, never done, and never said to be a live grant");
    const half = await fromSpotHome(() => perpsHalf(() => stopLocalPerpsForKill()));
    assert.equal(half.state, "not-stopped");
    assert.match(half.why ?? "", /switch perps off in Settings/);
    writeFileSync(SETTINGS, JSON.stringify(OWNER_SETTINGS));
    // The grant is already gone, so the answer is "none" (no grant to name);
    // the retry still turns the paper strategy off.
    assert.equal(await fromSpotHome(() => selfHostedPerpsKill()), null);
    assert.equal((JSON.parse(readFileSync(SETTINGS, "utf8")) as { perpsEnabled: boolean }).perpsEnabled, false, "the retry turns them off");
  });
});

const bin = fileURLToPath(new URL("../../cli/bin.mjs", import.meta.url));
const cli = (input: string) =>
  spawnSync(process.execPath, [bin, "kill"], { input, encoding: "utf8", timeout: 100_000, env: { ...process.env, MERRYMEN_HOME: SPOT_HOME, MERRYMEN_HOSTED: "", DATABASE_URL: "" } });

describe("`merrymen kill`, spawned for real", () => {
  it("revokes the Perps grant and switches its practice perpetuals off, and says both", { timeout: 120_000 }, () => {
    writeFileSync(GRANT, grantJson(5_000_000));
    writeFileSync(SETTINGS, JSON.stringify(OWNER_SETTINGS));
    const run = cli("y\n");
    const said = run.stdout + run.stderr;
    assert.equal(run.status, 0, said);
    assert.match(said, /Perps wallet's grant revoked/);
    assert.match(said, /practice perpetuals switched off — its paper positions stay as they are, untraded/);
    assert.equal(existsSync(GRANT), false);
    assert.equal((JSON.parse(readFileSync(SETTINGS, "utf8")) as { perpsEnabled: boolean }).perpsEnabled, false);
  });

  it("with no grant left but perps still on, it switches them off", { timeout: 120_000 }, () => {
    writeFileSync(SETTINGS, JSON.stringify(OWNER_SETTINGS));
    const run = cli("y\n");
    const said = run.stdout + run.stderr;
    assert.equal(run.status, 0, said);
    assert.match(said, /practice perpetuals switched off/);
    assert.equal((JSON.parse(readFileSync(SETTINGS, "utf8")) as { perpsEnabled: boolean }).perpsEnabled, false);
  });

  it("settings it cannot read: incomplete, exit 1, and it says which half is left", { timeout: 120_000 }, () => {
    writeFileSync(GRANT, grantJson(6_000_000));
    writeFileSync(SETTINGS, "{ not json");
    const run = cli("y\n");
    const said = run.stdout + run.stderr;
    assert.equal(run.status, 1, said);
    assert.match(said, /Kill incomplete: your Perps wallet's practice perpetuals could not be switched off\./);
    assert.doesNotMatch(said, /grant could not be revoked/, "the grant was revoked; it is not said to be live");
    assert.equal(existsSync(GRANT), false);
  });
});
