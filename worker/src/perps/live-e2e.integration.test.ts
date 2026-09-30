/**
 * LIVE PERPS, END TO END, WITH FAKES — the real live lane (perps/lane.ts)
 * holding a real key: the REAL signer (hash-pinned WASM, KAT at load, a key
 * generated for this file and written by the real keystore), the real api.ts
 * client over HTTP to a FAKE Lighter on 127.0.0.1 (testkit-live-venue.ts),
 * the real live executor, reconciler, onboarding plan, payout step, policy
 * and ledger (store.ts on an isolated sqlite home). Only three things are
 * modelled, each with the shape index.ts gives it: the UserOp rail for the
 * on-chain legs (legs.test.ts's pieces in processIntentLocked's order), the
 * chain those legs land on (the account index, cash, the pending balance and
 * the proxy's WithdrawPending logs), and the tick's plumbing.
 *
 * THE STORY, on one account (rules 1, 5, 6, 7, 8a, 9, 10, 11, 12, 13):
 *   perps live-enabled on a live account with a perp grant
 *   → perp-trend's first open is held back and FUNDED: a deposit leg (policy
 *     with the venue's readiness assumed, the fence, the `submitted` rows
 *     before the op, `landed` with its perp_transfers row)
 *   → the account index read on chain; the first deposit seen credited
 *   → the key registration leg; the key visible at 16 and a token of ours
 *     accepted (the rule-5 self-check)
 *   → the reconciler arms (a fresh ledger is rebuilt; opens wait out one
 *     signer horizon)
 *   → leverage set while flat, as its OWN step; the open waits for the
 *     account to read it
 *   → the open: one grouped OTO persisted before it was sent; the venue fills
 *   → the reconciler books the fill ONCE, however often it looks
 *   → equity is C + ΣM + ΣU, with no drop at zero move
 *   → the mark through the stop: the venue's stop fill ingested as venue-stop
 *   → a second open whose send times out: the row stays `submitted`, and only
 *     its exact persisted bytes are sent again
 *   → a kill request file: the stand-down closes reduce-only BEFORE any
 *     cancel, withdraws the free collateral, writes the result file, and the
 *     custody sentence names what is left
 *   → the payout's WithdrawPending log is folded — the cash it brings home is
 *     explained, never inferred as the owner's deposit.
 * Then, on their own accounts: a foreign key at index 16 is an incident
 * (flag stored, opens refused, the stand-down runs); and perps turned off with
 * a position open leave the lane EXITS-ONLY (no opens; the stop is still kept
 * resting; free collateral comes home once flat).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { encodeAbiParameters, type Hex } from "viem";
import { LIGHTER_ROUTE_V1, custodySentence, type PerpGrant } from "../../../packages/core/src/perps";
import type { ExecMode } from "../exec-mode";
import { lookAtCash, payoutShift, type PayoutFold } from "../flow-inference";
import type { RawLog } from "../inflight-reconcile";
import { checkPolicy, type AgentLimits, type AgentState, type PerpOrderIntent, type TradeIntent } from "../policy";
import { provenanceOf } from "../provenance";
import { buildOpenDraft } from "./drafts";
import { readLighterFeed, specToJson, type LighterFeedFileMarket } from "./feed-reader";
import { writePerpKeyFile } from "./keystore";
import { createPerpLane, LIVE_LANE_TIMING, type PerpLane, type PerpLaneConfig, type PerpLaneRead } from "./lane";
import {
  LIGHTER_PRIORITY_REQUEST_TOPIC,
  perpLegCalls,
  perpLegKind,
  perpLegLandedTransfer,
  perpLegMismatch,
  perpLegOfReceipt,
  perpLegSubmittedTransfer,
  type PerpLegIntent,
} from "./legs";
import { createLighterApi } from "./api";
import { livePerpTerm, type LivePerpTerm } from "./live-term";
import { runPayoutStep } from "./payout-look";
import type { CarriedPayout, InTransit } from "./payouts";
import { instantiateSigner } from "./signer";
import { newStanddownNonce, readStanddownResult, writeStanddownRequest } from "./standdown-files";
import { standdownExposure } from "./standdown";
import { FakeLighter, specOf } from "./testkit-live-venue";
import { H4, candles, scaleRange } from "./testkit-perps";

// ── an isolated ledger ──────────────────────────────────────────────────────

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-perp-live-e2e-"));
const isolatedCwd = path.join(scratch, "cwd");
mkdirSync(isolatedCwd);
const HOME = path.join(scratch, "home");
process.env.MERRYMEN_HOME = HOME;
delete process.env.DATABASE_URL;
delete process.env.MERRYMEN_FLEET_HOME;
const originalCwd = process.cwd();
const store = await import("../store");
try {
  process.chdir(isolatedCwd);
  await store.initStore();
} finally {
  process.chdir(originalCwd);
}
const raw = new DatabaseSync(path.join(HOME, "merrymen.db"));
raw.exec("PRAGMA busy_timeout = 5000");

// ── the clock: one hour into a 4 h bar that has not closed yet ──────────────
//
// AHEAD of the wall clock (the next bar), so every row the ledger stamps with
// sqlite's own time is in this clock's past — as it is in production.
const H = 3_600_000;
const BAR = Math.ceil(Date.now() / H4) * H4;
let clock = BAR + H;
const LAST_T = BAR - H4;
const u = (n: number) => BigInt(Math.round(n * 1e6));

// ── the market, as the fleet feed carries it ────────────────────────────────

const BTC = specOf(1);
const FEED_FILE = path.join(scratch, "lighter-feed.json");
/** 119 flat bars at 80,000.0, then a close at 80,200.0: a long breakout (testkit-perps' breakout, on this clock). */
const CANDLES = candles([...Array.from({ length: 119 }, () => 800_000n), 802_000n], scaleRange("BTC-PERP", 200n), LAST_T);
let mark = 802_000n;

function writeFeed(): void {
  const lastHour = Math.floor((clock / 1000 - 1800) / 3600) * 3600;
  const m: LighterFeedFileMarket = {
    observedAt: clock - 1_000,
    priceSource: "ws",
    mark: mark.toString(),
    index: mark.toString(),
    status: "active",
    spec: specToJson(BTC),
    specObservedAt: clock - 60_000,
    takerFeePpm: 0,
    makerFeePpm: 0,
    bids: [[(mark - 100n).toString(), "1000"]],
    asks: [[mark.toString(), "1000"]],
    bookObservedAt: clock - 1_000,
    bookSource: "ws",
    closed4h: CANDLES.map((c) => ({ t: c.t, o: c.o.toString(), h: c.h.toString(), l: c.l.toString(), c: c.c.toString() })),
    candlesObservedAt: LAST_T + H4 + 60_000,
    // 0.0010 %/h paid by longs: inside perp-trend's funding limit.
    fundings1h: Array.from({ length: 8 }, (_, i) => ({ t: lastHour - (7 - i) * 3600, rate: "0.0010", direction: "long" as const })),
    fundingsObservedAt: clock - 60_000,
  };
  writeFileSync(FEED_FILE, JSON.stringify({ v: 1, observedAt: clock - 500, markets: { "1": m } }));
}

// ── the key: the real signer, a key made for this file, the real keystore ───

const signer = await instantiateSigner({ now: () => clock });
const apiKey = signer.generateApiKey();
writePerpKeyFile(HOME, apiKey);
const SEALED = apiKey.publicKey;
const FOREIGN = signer.generateApiKey().publicKey;

// ── the venue ───────────────────────────────────────────────────────────────

const venue = new FakeLighter({
  now: () => clock,
  // The venue answers with the hash of the bytes it was sent; it cannot
  // compute Poseidon2, so it asks the ledger — and a tx whose bytes no row
  // holds is a rule-9 violation the story checks for.
  lookupHash: (txInfo) => (raw.prepare("SELECT tx_hash FROM perp_orders WHERE tx_info = ?").get(txInfo) as { tx_hash?: string } | undefined)?.tx_hash ?? null,
});
const VENUE_URL = await venue.start();
venue.setMark(1, mark);
const API_OPTS = { home: HOME, baseUrl: VENUE_URL, timeoutMs: 800, budgetPerMinute: 1_000_000, exitReservePerMinute: 1_000, now: () => clock };
const publicApi = createLighterApi({ ...API_OPTS, budgetKey: "public" });
const apis = new Map<string, ReturnType<typeof createLighterApi>>();
const apiFor = (sa: string) => {
  const k = sa.toLowerCase();
  if (!apis.has(k)) apis.set(k, createLighterApi({ ...API_OPTS, budgetKey: k }));
  return apis.get(k)!;
};

after(async () => {
  await venue.stop();
  raw.close();
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

// ── the chain the on-chain legs land on ─────────────────────────────────────

const PROXY = LIGHTER_ROUTE_V1.proxy;
const CHAIN_ID = LIGHTER_ROUTE_V1.chainId;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;
const pad = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}` as Hex;
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}` as Hex;
const h32 = () => `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
const u48 = (v: bigint) => v.toString(16).padStart(12, "0");

interface L {
  address: string;
  topics: Hex[];
  data: Hex;
  logIndex: number;
}
const depositOpLogs = (self: string, amount: bigint, idx: bigint): L[] => [
  { address: LIGHTER_ROUTE_V1.usdg, topics: [TRANSFER_TOPIC, pad(self), pad(PROXY)], data: encodeAbiParameters([{ type: "uint256" }], [amount]), logIndex: 0 },
  {
    address: PROXY,
    topics: [LIGHTER_PRIORITY_REQUEST_TOPIC as Hex],
    data: encodeAbiParameters([{ type: "address" }, { type: "uint64" }, { type: "uint8" }, { type: "bytes" }, { type: "uint64" }], [self as `0x${string}`, 7n, 61, "0x3d", 1_900_000_000n]),
    logIndex: 1,
  },
  {
    address: PROXY,
    topics: [LIGHTER_ROUTE_V1.topics.deposit],
    data: encodeAbiParameters(
      [{ type: "uint48" }, { type: "address" }, { type: "uint16" }, { type: "uint8" }, { type: "uint128" }],
      [Number(idx), self as `0x${string}`, 3, 0, amount],
    ),
    logIndex: 2,
  },
];
const keyOpLogs = (self: string, idx: bigint, pk: string): L[] => [
  {
    address: PROXY,
    topics: [LIGHTER_PRIORITY_REQUEST_TOPIC as Hex],
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "uint64" }, { type: "uint8" }, { type: "bytes" }, { type: "uint64" }],
      [self as `0x${string}`, 8n, 62, `0x3e${u48(idx)}${u48(idx)}10${pk.slice(2)}` as Hex, 1_900_000_000n],
    ),
    logIndex: 0,
  },
];
const withdrawPendingLog = (owner: string, block: bigint, amount: bigint): RawLog & { address: string } => ({
  address: PROXY,
  topics: [LIGHTER_ROUTE_V1.topics.withdrawPending as Hex, pad(owner)],
  data: encodeAbiParameters([{ type: "uint16" }, { type: "uint128" }], [3, amount]),
  transactionHash: h32(),
  blockNumber: hex(block),
  logIndex: hex(0),
});

// ── one account's world ─────────────────────────────────────────────────────

const LIVE: ExecMode = { mode: "live" };
const TICK = { equityKnown: true, breakerIdle: true, breakerLimitBps: 1_000, energyEntriesLeft: true, opsHeadroom: true, spendHeadroomMicro: u(500), strategistLive: false };

function config(over: Partial<PerpLaneConfig> = {}): PerpLaneConfig {
  return {
    perpsEnabled: true,
    liveTradingEnabled: true,
    perpsLiveEnabled: true,
    perpsDriver: "perp-trend",
    perpsMarkets: ["BTC-PERP"],
    perpsMaxLeverage: 2,
    perpsPerTradeUsdg: 25,
    perpsMaxOpenNotionalUsdg: 50,
    perpsMaxCollateralUsdg: 30,
    perpsMaxOpensPerDay: 4,
    perpsStopLossPct: 5,
    perpsStopSlipBps: 200,
    perpsTakeProfitPct: 0,
    perpsLiqBufferPct: 2,
    perpsMaxSlippageBps: 50,
    perpsOperatorCeiling: "live",
    perpsLiveTenants: null,
    perpsEntriesHalted: false,
    paperStartUsdg: 100,
    ...over,
  };
}

interface World {
  id: string;
  sa: `0x${string}`;
  idxOnDeposit: bigint;
  lane: PerpLane;
  cfg: PerpLaneConfig;
  limits: AgentLimits;
  events: { level: string; message: string }[];
  chain: { idx: bigint; cash: bigint; pending: bigint; block: bigint; logs: (RawLog & { address: string })[] };
  transit: { block: bigint | null; transit: InTransit | null; pendingBalanceMicro: bigint | null } | null;
  cursor: bigint | null;
  carry: CarriedPayout[];
  fold: PayoutFold | null;
  term: LivePerpTerm | null;
  legs: { kind: string; status: string; rule?: string }[];
  energy: { claimed: number; refunded: number };
  inFlight: { ops: number; spend: bigint };
  ledgerFactsUnread?: boolean;
  cachedBudget?: { ops: number; spend: bigint };
  budgetRefreshFails?: boolean;
  checkpointRejectsAfterInsert?: boolean;
  ownerDeadlineDelay?: { phase: "decision" | "insert"; untilMs: number };
  rejectOrderResolution?: boolean;
}

let nextWorld = 1;
async function world(opts: { sealed?: `0x${string}` } = {}): Promise<World> {
  const n = nextWorld++;
  const sa = `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
  const id = await store.ensureAgent({
    smartAccount: sa,
    owner: "0x00000000000000000000000000000000000000b1",
    sessionKeyAddress: "0x00000000000000000000000000000000000000c1",
    serialized: "x",
    caps: { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 },
    grantedAt: 1_000_000,
    expiresAt: 2_000_000_000,
    chainId: 4663,
  } as never);
  const limits: AgentLimits = {
    perTradeUsdg: u(50),
    dailyUsdg: u(500),
    allowedTargets: [],
    allowedAssets: [],
    cashToken: LIGHTER_ROUTE_V1.usdg,
    maxDrawdownBps: 1_000,
    expiresAt: Math.floor(clock / 1000) + 30 * 86_400,
    maxOpsPerDay: 48,
    perp: { proxy: PROXY, apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: opts.sealed ?? SEALED },
  };
  const w = {
    id,
    sa,
    idxOnDeposit: BigInt(22_148 + n),
    cfg: config(),
    limits,
    events: [],
    chain: { idx: 0n, cash: u(100), pending: 0n, block: 1n, logs: [] },
    transit: null,
    cursor: 1n,
    carry: [],
    fold: null,
    term: null,
    legs: [],
    energy: { claimed: 0, refunded: 0 },
    inFlight: { ops: 0, spend: 0n },
  } as unknown as World;
  w.lane = laneFor(w, LIVE);
  return w;
}

/** One process's lane for the world's agent — a second call is a restart (a fresh lane over the same ledger and venue). */
function laneFor(w: World, exec: ExecMode | (() => ExecMode)): PerpLane {
  const { id, sa, limits } = w;
  return createPerpLane({
    store,
    armed: () => ({ agentId: id, smartAccount: sa, limits }),
    config: () => w.cfg,
    execMode: () => typeof exec === "function" ? exec() : exec,
    readFeed: (now) => readLighterFeed(FEED_FILE, now),
    now: () => clock,
    agentState: (e) => agentState(w, e.equityUsdg, e.equityKnown),
    counters: () => ({ spentTodayUsdg: (w.cachedBudget?.spend ?? 0n) + w.inFlight.spend, opsToday: (w.cachedBudget?.ops ?? 0) + w.inFlight.ops }),
    budget: {
      reserve: (s) => {
        w.inFlight.ops += 1;
        w.inFlight.spend += s;
      },
      release: (s) => {
        w.inFlight.ops -= 1;
        w.inFlight.spend -= s;
      },
      refresh: async () => {
        if (w.budgetRefreshFails) throw new Error("test: budget read failed");
        if (w.cachedBudget) {
          w.cachedBudget.spend = u(await store.getSpentTodayUsdg(id, "live"));
          w.cachedBudget.ops = await store.getOpsToday(id, "live");
        }
      },
      keep: (spend) => {
        if (w.cachedBudget) {
          w.cachedBudget.ops += 1;
          w.cachedBudget.spend += spend;
        }
      },
    },
    events: async (level, message) => void w.events.push({ level, message }),
    decide: (intent, source, reason, known) => {
      if (source === "chat" && w.ownerDeadlineDelay?.phase === "decision") {
        clock = w.ownerDeadlineDelay.untilMs;
        delete w.ownerDeadlineDelay;
        writeFeed();
      }
      return decide(id, intent, source, reason, known);
    },
    log: () => {},
    live: {
      home: () => HOME,
      loadSigner: async () => signer,
      api: (s) => apiFor(s),
      publicApi: () => publicApi,
      store: {
        ...store,
        insertPerpOrderSubmitted: async (...args) => {
          const row = await store.insertPerpOrderSubmitted(...args);
          if (w.ownerDeadlineDelay?.phase === "insert") {
            clock = w.ownerDeadlineDelay.untilMs;
            delete w.ownerDeadlineDelay;
            writeFeed();
          }
          if (w.checkpointRejectsAfterInsert) throw new Error("test: checkpoint publication failed after local commit");
          return row;
        },
        resolvePerpOrder: (...args) => {
          if (w.rejectOrderResolution) throw new Error("test: order resolution unavailable");
          return store.resolvePerpOrder(...args);
        },
        perpLaneLedgerFacts: (...args) => {
          if (w.ledgerFactsUnread) throw new Error("test: live ledger facts unread");
          return store.perpLaneLedgerFacts(...args);
        },
      },
      accountIndex: () => w.chain.idx,
      cashMicro: () => w.chain.cash,
      transit: () => w.transit,
      term: (account, transit) => livePerpTerm({ account, transit }),
      keyLegInFlight: async () => (await store.listSubmittedOps(id)).some((o) => o.kind === "perp-key"),
      executorTuning: { sleep: async () => {}, txPollDelaysMs: [0, 0, 0] },
      // The stand-down waits on the test's clock, which its waits move.
      standdownTuning: {
        sleep: async (ms) => {
          clock += ms;
        },
      },
    },
  });
}

async function agentState(w: World, equityUsdg: bigint, equityKnown: boolean): Promise<Omit<AgentState, "perp">> {
  return {
    spentTodayUsdg: u(await store.getSpentTodayUsdg(w.id, "live")) + w.inFlight.spend,
    opsToday: (await store.getOpsToday(w.id, "live")) + w.inFlight.ops,
    highWaterMarkUsdg: u(100),
    equityUsdg,
    equityKnown,
    nowSec: Math.floor(clock / 1000),
  };
}

/** index.ts ensureDecision's contract: mint an id, write the row with the provenance its Why gives. */
async function decide(agentId: string, intent: TradeIntent, source: string, reason?: string, known?: { whyCode?: string }) {
  if (intent.decisionId) return { ok: true as const };
  const id = store.newDecisionId();
  intent.decisionId = id;
  await store.addDecision({ id, agent_id: agentId, source, ...(reason !== undefined ? { reason } : {}), provenance: provenanceOf(source, known?.whyCode) });
  return { ok: true as const };
}

function equityOf(w: World): bigint {
  return w.chain.cash + (w.term?.valueMicro ?? 0n);
}

/**
 * processIntentLocked's ON-CHAIN arm for a perp leg, piece by piece as
 * index.ts runs it (legs.test.ts pins each piece; perp-legs-wiring.test.ts the
 * order): checkPolicy against the lane's state FOR THIS INTENT, the fence
 * (perpLegCalls), the `submitted` trades row and the deposit's margin row in
 * ONE write before the op, the receipt read back into the leg, the `landed`
 * row with its margin step. The chain then does what the leg did.
 */
async function runLeg(w: World, intent: PerpLegIntent): Promise<{ status: string; rejectRule?: string }> {
  const kind = perpLegKind(intent as TradeIntent)!;
  const amount = intent.kind === "perp-key" ? 0n : intent.amountUsdg;
  const state = { ...(await agentState(w, equityOf(w), true)), perp: w.lane.policyStateFor(intent as TradeIntent) };
  const v = checkPolicy(intent as TradeIntent, w.limits, state);
  if (!v.ok) {
    w.legs.push({ kind, status: "rejected", rule: v.rule });
    return { status: "rejected", rejectRule: v.rule };
  }
  const grant: PerpGrant = { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: SEALED };
  const built = perpLegCalls(intent, { perp: grant, account: w.sa, chainAccountIndex: w.chain.idx });
  if (!built.ok) {
    w.legs.push({ kind, status: "rejected", rule: built.rule });
    return { status: "rejected", rejectRule: built.rule };
  }
  const userOpHash = h32();
  const t = perpLegSubmittedTransfer(intent, userOpHash);
  assert.ok(
    await store.addTrade(
      { agent_id: w.id, kind, target: PROXY, amount_usdg: Number(amount) / 1e6, user_op_hash: userOpHash, status: "submitted" },
      t === null ? undefined : { with: store.perpTransferWith({ ...t, agentId: w.id, mode: "live" }) },
    ),
  );
  // ── the chain ──
  let logs: L[];
  if (kind === "perp-deposit") {
    if (w.chain.idx === 0n) w.chain.idx = w.idxOnDeposit;
    w.chain.cash -= amount;
    logs = depositOpLogs(w.sa, amount, w.chain.idx);
    venue.credit(w.sa, amount, Number(w.chain.idx));
  } else if (kind === "perp-key") {
    logs = keyOpLogs(w.sa, w.chain.idx, SEALED);
    venue.registerKey(Number(w.chain.idx), 16, SEALED);
  } else {
    throw new Error(`the story sends no ${kind}`);
  }
  const txHash = h32();
  const reading = perpLegOfReceipt(logs, w.sa, CHAIN_ID);
  assert.equal(perpLegMismatch(intent, reading, SEALED), null, "the receipt proves the leg that was signed");
  const landed = reading.kind === "leg" ? perpLegLandedTransfer(reading.leg, { userOpHash, txHash, chainId: CHAIN_ID }) : null;
  assert.ok(
    await store.addTrade(
      { agent_id: w.id, kind, target: PROXY, amount_usdg: Number(amount) / 1e6, tx_hash: txHash, user_op_hash: userOpHash, status: "landed" },
      landed === null ? undefined : { with: store.perpTransferWith({ ...landed, agentId: w.id, mode: "live" }) },
    ),
  );
  w.legs.push({ kind, status: "landed" });
  return { status: "landed" };
}

function hooks(w: World) {
  const equity = equityOf(w);
  return {
    claimEntry: async () => {
      w.energy.claimed += 1;
      return { ok: true };
    },
    refundEntry: async (c: { ok: boolean } | null) => {
      if (c?.ok) w.energy.refunded += 1;
    },
    withholdEntry: async () => {},
    ensureDecision: (i: TradeIntent, s: string, r?: string, k?: { whyCode?: string }) => decide(w.id, i, s, r, k),
    // processIntentReporting → processIntentLocked: the lane for an L2 perp
    // intent, the UserOp arm for an on-chain leg (index.ts's own fork).
    processIntentReporting: (i: TradeIntent) =>
      perpLegKind(i) !== null ? runLeg(w, i as PerpLegIntent) : w.lane.execute(i as PerpOrderIntent, { equityUsdg: equity, equityKnown: true }),
    processIntent: async (i: TradeIntent) => {
      await w.lane.execute(i as PerpOrderIntent, { equityUsdg: equity, equityKnown: true });
    },
  };
}

/** One live tick as index.ts runs it: the payout step at a new block, the lane's refresh (reconcile first), the term, the route. */
async function tick(w: World, opts: { route?: boolean; advanceMs?: number } = {}): Promise<PerpLaneRead> {
  clock += opts.advanceMs ?? 2_000;
  writeFeed();
  w.chain.block += 1n;
  const block = w.chain.block;
  const step = await runPayoutStep({
    agentId: w.id,
    account: w.sa,
    accountIndex: w.chain.idx,
    cursor: w.cursor,
    block,
    getLogs: async (a) => w.chain.logs.filter((l) => BigInt(l.blockNumber!) >= a.fromBlock && BigInt(l.blockNumber!) <= a.toBlock),
    store,
    pendingAt: async () => w.chain.pending,
    carry: w.carry,
  });
  w.carry = step.carry;
  w.transit = { block: step.block, transit: step.transit, pendingBalanceMicro: step.pendingBalanceMicro };
  w.cursor = block;
  w.fold = step.fold;
  const r = await w.lane.refresh();
  if (r.liveTerm !== undefined) w.term = r.liveTerm;
  if (opts.route !== false) await w.lane.runRoute({ ...TICK, equityUsdg: equityOf(w) }, hooks(w));
  return r;
}

function pass(w: World) {
  return w.lane.protectPass({ lock: w.lane.lock, signal: new AbortController().signal, pass: 1 });
}

const rows = (sql: string, ...args: (string | number)[]) => raw.prepare(sql).all(...args) as Record<string, unknown>[];
const liveOrders = (w: World) => rows("SELECT * FROM perp_orders WHERE agent_id = ? AND mode = 'live' ORDER BY nonce", w.id.toLowerCase());
const fills = (w: World) => rows("SELECT * FROM perp_fills WHERE agent_id = ? AND mode = 'live' ORDER BY venue_ts_ms", w.id.toLowerCase());
const journal = async (w: World, kind: string) => (await store.readJournal(w.id, 1)).filter((e) => e.kind === kind).length;
const acctIdx = (w: World) => Number(w.chain.idx);

/**
 * Onboarding to the first open, as the story below walks it — for the other
 * accounts, which need a live position and nothing it proves.
 */
async function onboardAndOpen(w: World): Promise<void> {
  await w.lane.armed();
  await w.lane.stopProtect();
  for (let i = 0; i < 3; i++) await tick(w);
  await tick(w, { advanceMs: 11 * 60_000 });
  for (let i = 0; i < 3 && venue.accounts.get(acctIdx(w))?.pos.get(1) === undefined; i++) await tick(w);
  await tick(w);
  assert.ok(venue.accounts.get(acctIdx(w))?.pos.get(1), `an open at the venue for ${w.id}: ${JSON.stringify(w.events.map((e) => e.message).slice(-6))}`);
}

// ── the story ───────────────────────────────────────────────────────────────

describe("live perps, end to end, on one account", () => {
  let w: World;
  let depositMicro = 0n;
  let equityBeforeOpen = 0n;

  before(async () => {
    writeFeed();
    w = await world();
    // THE ARM: the lane's first read, the loop started (and stopped here: the
    // test runs its passes itself, on its own clock).
    await w.lane.armed();
    await w.lane.stopProtect();
  });

  it("no venue account yet: the known zero, and the lane ON — the route may propose, the deposit is what creates the account", async () => {
    const r = await tick(w, { route: false });
    assert.deepEqual(r.rail, { mode: "refuse", rule: "perp-venue-unready" });
    assert.equal(r.book, undefined, "addressToAccountIndex 0: nothing at Lighter, Lighter's money never read");
    assert.equal(r.active, true);
    assert.equal(r.report.blocker, "perps-awaiting-deposit");
    assert.equal(venue.sends.length, 0);
  });

  it("the first open is held back and FUNDED: a deposit leg through policy (venue readiness assumed), the fence, the rows before the op", async () => {
    await tick(w);
    assert.equal(w.energy.claimed, 1, "the route's entry claimed");
    assert.equal(w.energy.refunded, 1, "held back, it placed nothing: refunded");
    assert.deepEqual(w.legs, [{ kind: "perp-deposit", status: "landed" }]);
    const t = rows("SELECT * FROM perp_transfers WHERE agent_id = ? AND mode = 'live'", w.id.toLowerCase());
    assert.equal(t.length, 1);
    assert.equal(t[0]!.direction, "deposit");
    assert.equal(t[0]!.state, "landed");
    depositMicro = BigInt(t[0]!.amount_micro as string);
    // margin (the open's notional at 2x) + 10%, never more: ~25 USDG → ~13.75.
    assert.ok(depositMicro > u(12) && depositMicro < u(14), String(depositMicro));
    // One trades row, written `submitted` before the op and settled `landed` (store.ts addTrade by user_op_hash).
    const trades = rows("SELECT kind, status, target FROM trades WHERE agent_id = ? ORDER BY id", w.id);
    assert.deepEqual(trades.map((x) => `${x.kind}:${x.status}`), ["perp-deposit:landed"]);
    assert.equal(String(trades[0]!.target).toLowerCase(), PROXY, "a leg's target is the sealed proxy");
    assert.equal(w.chain.idx, w.idxOnDeposit, "the deposit created the Lighter account");
    assert.equal(liveOrders(w).length, 0, "nothing was signed at the venue: the key is not registered yet");
  });

  it("the account index is read; the first deposit is seen credited (not counted twice); the key registration leg goes", async () => {
    const r = await tick(w);
    const t = rows("SELECT state FROM perp_transfers WHERE agent_id = ? AND mode = 'live'", w.id.toLowerCase());
    assert.equal(t[0]!.state, "credited", "C holds it now: never also in T_in");
    assert.equal(await journal(w, "margin"), 2, "one margin entry landing, one crediting");
    assert.ok(r.liveTerm && r.liveTerm.valueMicro === depositMicro, `the venue term is the deposit, once: ${r.liveTerm?.valueMicro}`);
    assert.deepEqual(w.legs.at(-1), { kind: "perp-key", status: "landed" });
    assert.equal(venue.accounts.get(acctIdx(w))!.keys.get(16)?.pub, SEALED.slice(2));
  });

  it("the key is visible at 16 AND a token of ours is accepted: the rule-5 self-check passes; the reconciler arms and opens wait one signer horizon", async () => {
    const r = await tick(w);
    const acct = await store.getPerpAccount(w.id, "live");
    assert.equal(acct?.registeredPubkey, SEALED, "recorded once the venue showed it and our token worked");
    assert.deepEqual(r.rail, { mode: "refuse", rule: "perp-venue-unready" }, "a rebuilt ledger waits out the lost ledger's ExpiredAt horizon");
    assert.equal(liveOrders(w).length, 0);
  });

  it("leverage is set while flat, as its OWN step: the open waits for the account to read it", async () => {
    const r = await tick(w, { advanceMs: 11 * 60_000 });
    assert.deepEqual(r.rail, { mode: "live" }, JSON.stringify(w.events.slice(-4)));
    const o = liveOrders(w);
    assert.equal(o.length, 1);
    assert.equal(o[0]!.effect, "leverage");
    assert.equal(o[0]!.tx_type, 20);
    assert.equal(venue.accounts.get(acctIdx(w))!.lev.get(1), 5_000, "isolated at 2x, the owner's setting — never a model's");
    assert.equal(venue.accounts.get(acctIdx(w))!.pos.size, 0, "and nothing opened in the same tick");
    equityBeforeOpen = r.liveTerm!.valueMicro!;
  });

  it("the open: ONE grouped OTO, persisted before it was sent; the venue fills it; the reconciler books the fill ONCE", async () => {
    await tick(w);
    const o = liveOrders(w).filter((x) => x.effect === "open");
    assert.equal(o.length, 1);
    assert.equal(o[0]!.tx_type, 28, "entry and stop in one tx (rule 7)");
    const legs = rows("SELECT role FROM perp_order_legs WHERE order_id = ? ORDER BY client_order_index", o[0]!.id as string).map((x) => x.role);
    assert.deepEqual(legs, ["entry", "sl"]);
    assert.deepEqual(venue.violations, [], "every byte the venue saw was already on a row (rule 9)");
    const sent = venue.sends.filter((s) => s.txType === 28);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.hash, o[0]!.tx_hash);
    assert.ok(venue.accounts.get(acctIdx(w))!.pos.get(1), `the venue holds the long: ${JSON.stringify({ c: String(venue.accounts.get(acctIdx(w))!.collateral), orders: venue.accounts.get(acctIdx(w))!.orders.map((x) => [x.type, x.status, String(x.price), String(x.initial)]), sends: venue.sends.map((x) => [x.txType, x.outcome]), errors: venue.errors, mark: String(mark) })}`);
    assert.equal(w.energy.claimed, 5, "one claim per tick the route proposed the entry");
    assert.equal(w.energy.refunded, 4, "the four held-back tries (deposit, key, horizon, leverage) were refunded; this one became a trade");

    await tick(w, { route: false });
    await tick(w, { route: false });
    const f = fills(w);
    assert.equal(f.length, 1, "booked once, however often the reconciler looks");
    assert.equal(f[0]!.attribution, "intent");
    assert.equal(await journal(w, "perp-fill"), 1);
    assert.equal(liveOrders(w).find((x) => x.effect === "open")!.status, "filled");
    const pos = (await store.getPerpPositions(w.id, "live")).find((p) => p.marketId === 1)!;
    assert.ok(pos.stopTrigger !== null && pos.stopTrigger < mark, "the stop the open carried is recorded on its position");
  });

  it("equity is C + ΣM + ΣU, with no drop at zero move", async () => {
    const r = await tick(w, { route: false });
    const book = r.liveTerm!.book;
    assert.ok(book !== "unread");
    assert.ok(book.isolatedMarginMicro > 0n);
    assert.equal(book.unrealizedMicro, 0n);
    assert.equal(r.liveTerm!.valueMicro, equityBeforeOpen, "the margin moved from C to ΣM and is counted once");
    assert.equal(book.collateralMicro + book.isolatedMarginMicro, depositMicro);
  });

  it("a reconcile pass with a GAP is a book gap: no term, no view for the route — the protective loop still reads", async () => {
    venue.failing.add("/api/v1/positionFunding");
    const r = await tick(w, { route: false });
    assert.equal(r.book, "unread", "funding unread: money the ledger cannot explain (rule 11)");
    assert.equal(r.liveTerm?.valueMicro, null);
    assert.match(String(r.liveTerm?.why), /funding/);
    assert.equal(r.view, null, "the route decides on nothing it cannot vouch for");
    assert.ok(r.policy !== undefined && r.policy.committedCollateralMicro === r.policy.settings.maxCollateralMicro, "and the committed total is unknown, so it saturates");
    venue.failing.delete("/api/v1/positionFunding");
    const back = await tick(w, { route: false });
    assert.notEqual(back.book, "unread", "the next complete pass reads again");
    assert.equal(back.liveTerm?.valueMicro, equityBeforeOpen);
  });

  it("a ledger facts failure after venue reconciliation leaves the tick's live term unread", async () => {
    const previous = (await tick(w, { route: false })).lastKnownMicro;
    w.ledgerFactsUnread = true;
    try {
      const r = await tick(w, { route: false });
      assert.equal(r.book, "unread");
      assert.equal(r.liveTerm?.book, "unread", "index.ts consumes this term before r.book");
      assert.equal(r.liveTerm?.valueMicro, null);
      assert.equal(r.liveTerm?.venueMoneyMicro, null);
      assert.equal(r.lastKnownMicro, previous, "the failed read never resets last-known money");
      assert.equal(r.view, null);
    } finally {
      w.ledgerFactsUnread = false;
    }
    assert.notEqual((await tick(w, { route: false })).book, "unread");
  });

  it("the mark through the stop: the venue's stop fill is ingested as venue-stop", async () => {
    const pos = (await store.getPerpPositions(w.id, "live")).find((p) => p.marketId === 1)!;
    mark = pos.stopTrigger! - 50n;
    venue.setMark(1, mark);
    await tick(w, { route: false });
    const f = fills(w);
    assert.equal(f.length, 2);
    assert.equal(f[1]!.attribution, "venue-stop");
    assert.ok(BigInt(f[1]!.realized_micro as string) < 0n, "a stop closes at a loss");
    assert.equal(venue.accounts.get(acctIdx(w))!.pos.size, 0);
    assert.equal((await store.getPerpPositions(w.id, "live")).length, 0, "flat in the cache too");
  });

  it("a second open whose send TIMES OUT stays submitted, and only its exact persisted bytes are sent again", async () => {
    await tick(w, { route: false });
    const view = w.lane.snapshotView()!;
    const built = buildOpenDraft({ market: view.markets.get("BTC-PERP")!, side: "long", notionalCapMicro: u(20), stopBps: 300, maxSlippageBps: 50, stopSlipBps: 200, liqBufferBps: 200 });
    assert.ok(built.ok);
    venue.dropNextSend = true;
    const out = await w.lane.execute({ ...built.draft } as PerpOrderIntent, { equityUsdg: equityOf(w), equityKnown: true });
    assert.equal(out.status, "submitted", "unknown is not refused: the row stands, resolved by its hash");
    const row = liveOrders(w).filter((x) => x.effect === "open").at(-1)!;
    assert.equal(row.status, "submitted");
    assert.equal(venue.accounts.get(acctIdx(w))!.pos.size, 0, "the venue never saw it executed");

    await tick(w, { route: false, advanceMs: 12_000 });
    await tick(w, { route: false });
    const again = venue.sends.filter((s) => s.hash === row.tx_hash);
    assert.equal(again.length, 2, "sent once, re-sent once");
    assert.equal(again[0]!.outcome, "dropped");
    assert.equal(again[1]!.outcome, "executed");
    assert.equal(again[1]!.txInfo, again[0]!.txInfo, "the SAME bytes — a re-sign would be another tx under the same nonce");
    assert.equal(row.tx_info, again[1]!.txInfo);
    assert.equal(liveOrders(w).filter((x) => x.effect === "open").length, 2, "no second row, no second nonce for the intent");
    assert.ok(venue.accounts.get(acctIdx(w))!.pos.get(1), "and it filled");
    await tick(w, { route: false });
    assert.equal(fills(w).length, 3);
  });

  it("a kill REQUEST FILE: the stand-down closes reduce-only BEFORE any cancel, withdraws the free collateral, writes the result", async () => {
    const before = venue.sends.length;
    const nonce = newStanddownNonce();
    writeStanddownRequest(HOME, { reason: "kill", requestedAt: clock, nonce });
    await w.lane.pollStanddownRequests();
    const res = readStanddownResult(HOME, nonce);
    assert.ok(res, "the result file the CLI waits on");
    assert.equal(res.outcome, "done", JSON.stringify(res.failedSteps));
    assert.equal(res.closed.length, 1);
    assert.equal(res.closed[0]!.market, "BTC-PERP");
    assert.ok(res.withdrawRequestedMicro !== null && res.withdrawRequestedMicro > 0n);
    const mine = venue.sends.slice(before).filter((s) => s.outcome === "executed").map((s) => {
      const info = JSON.parse(s.txInfo) as Record<string, unknown>;
      return s.txType === 14 ? (info.ReduceOnly === 1 && info.Type === 1 ? "close" : `order-${String(info.Type)}`) : s.txType === 16 ? "cancel" : s.txType === 13 ? "withdraw" : String(s.txType);
    });
    // THE ORDER IS THE SAFETY (rule 13): the close goes first; nothing is
    // cancelled before it (a cancel, if anything were left resting, only
    // after the market reads flat — here the venue ended the position-tied
    // stop with the position), and the withdrawal comes last.
    assert.equal(mine[0], "close", `the close is the first send: ${mine.join(", ")}`);
    const close = mine.indexOf("close");
    const withdraw = mine.indexOf("withdraw");
    assert.ok(mine.every((x, i) => x !== "cancel" || i > close), `no cancel before the close: ${mine.join(", ")}`);
    assert.ok(withdraw > close, `then the withdrawal: ${mine.join(", ")}`);
    const closeInfo = JSON.parse(venue.sends.slice(before).find((x) => x.outcome === "executed")!.txInfo) as Record<string, unknown>;
    assert.equal(closeInfo.ReduceOnly, 1, "reduce-only: a duplicate can never flip into a position");
    assert.equal(closeInfo.IsAsk, 1, "a long is closed by selling");
    assert.equal(venue.accounts.get(acctIdx(w))!.pos.size, 0);
    assert.equal(venue.accounts.get(acctIdx(w))!.collateral, 0n, "the free collateral left the venue for home");
    assert.equal(w.lane.standingDown, false, "the latch is released");

    // THE OWNER'S SENTENCE, from the result — naming what is still on its way.
    const said = w.events.filter((e) => /perps stand-down \(kill\)/.test(e.message)).at(-1)!;
    assert.match(said.message, /is on its way back to your smart account/);
    assert.doesNotMatch(said.message, /your funds stay in your smart account/);
    const exposure = standdownExposure(res, { pendingWithdrawalsMicro: res.withdrawRequestedMicro!, depositsInTransitMicro: 0n, otherAccounts: { count: 0, valueMicro: 0n }, withdrawalDelaySec: 600 });
    assert.match(custodySentence(exposure), /on its way back/);
  });

  it("the payout's WithdrawPending log is FOLDED: the withdrawal is paid, and the cash it brings home is never inferred as a deposit", async () => {
    await tick(w, { route: false });
    const owed = rows("SELECT state, amount_micro FROM perp_transfers WHERE agent_id = ? AND mode = 'live' AND direction = 'withdraw'", w.id.toLowerCase());
    assert.equal(owed.length, 1);
    assert.equal(owed[0]!.state, "executed", "the venue executed it: T_out until it is paid");
    const amount = BigInt(owed[0]!.amount_micro as string);
    // Past the venue's delay: pending on the contract, then the relayer pays it.
    w.chain.pending += venue.makeClaimable(acctIdx(w));
    await tick(w, { route: false });
    assert.ok(w.transit?.transit && !w.transit.transit.gap, "pending equals what the ledger knows is on its way");
    const cashBefore = w.chain.cash;
    w.chain.logs.push(withdrawPendingLog(w.sa, w.chain.block + 1n, amount));
    w.chain.pending -= amount;
    w.chain.cash += amount;
    venue.complete(acctIdx(w));
    await tick(w, { route: false });
    assert.equal(rows("SELECT state FROM perp_transfers WHERE agent_id = ? AND mode = 'live' AND direction = 'withdraw'", w.id.toLowerCase())[0]!.state, "paid");
    assert.ok(w.fold !== null && w.fold.kind === "folded" && w.fold.payouts.length === 1);
    const shift = payoutShift(w.fold, new Set())!;
    const look = lookAtCash({ baselineUsdg: cashBefore, since: null, unattributed: false, settled: [], cashUsdg: w.chain.cash, opsInFlight: false, writesInInterval: false, payoutShiftUsdg6: shift.shiftUsdg6 });
    assert.deepEqual(look.verdict, { action: "infer", deltaUsdg: 0n }, "the margin came home: explained to the micro, nothing inferred");
    assert.ok(!w.events.some((e) => /no withdrawal of the agent's asked for/.test(e.message)), "and it was the agent's own withdrawal, not an unrequested payout");
  });
});

describe("a FOREIGN key at index 16", () => {
  it("is an incident: the flag is stored, opens are refused, the stand-down runs", async () => {
    const w = await world();
    await onboardAndOpen(w);
    venue.replaceKey(acctIdx(w), 16, FOREIGN);
    await tick(w, { route: false });
    const acct = await store.getPerpAccount(w.id, "live");
    assert.equal(acct?.incident?.kind, "pubkey-mismatch", "the durable flag");
    const res = await w.lane.standdown("incident");
    assert.ok(res);
    assert.equal(res.reason, "incident");
    assert.notEqual(res.outcome, "done", "our signatures no longer work: the position cannot be closed by us");
    assert.ok(res.residual.some((x) => x.market === "BTC-PERP" && x.stopResting), "and it says so — with its stop still resting");
    assert.ok(w.events.some((e) => /INCIDENT/.test(e.message) && /merrymen recover/.test(e.message)), "the owner is told how to rotate the key");
    const said = w.events.filter((e) => /perps stand-down \(incident\)/.test(e.message)).at(-1)!;
    assert.match(said.message, /Could not be closed: BTC-PERP long/);
    assert.match(said.message, /merrymen recover/);

    // OPENS REFUSED.
    const view = w.lane.snapshotView();
    assert.ok(view);
    assert.equal(view.opensBlocked, "perps-unknown-activity");
    const built = buildOpenDraft({ market: view.markets.get("BTC-PERP")!, side: "short", notionalCapMicro: u(20), stopBps: 300, maxSlippageBps: 50, stopSlipBps: 200, liqBufferBps: 200 });
    assert.ok(built.ok);
    const sendsBefore = venue.sends.length;
    const out = await w.lane.execute({ ...built.draft } as PerpOrderIntent, { equityUsdg: equityOf(w), equityKnown: true });
    assert.equal(out.status, "rejected");
    assert.equal(out.rejectRule, "perp-venue-incident", "refused by the incident, by name");
    assert.equal(venue.sends.slice(sendsBefore).filter((s) => s.txType === 28).length, 0, "nothing opened");
  });
});

describe("a grant whose sealed key is NOT on this machine", () => {
  it("funds nothing it cannot then use: no deposit, no key registered, nothing signed — and the owner is told to re-sign", async () => {
    const LOST = signer.generateApiKey().publicKey; // sealed in the grant, never written to the keystore
    const w = await world({ sealed: LOST });
    await w.lane.armed();
    await w.lane.stopProtect();
    const r1 = await tick(w);
    const r2 = await tick(w);
    assert.deepEqual(w.legs, [], "no margin is posted to a venue this worker holds no key for");
    assert.equal(w.chain.idx, 0n);
    assert.equal(r2.report.blocker, "perps-key-pending");
    assert.deepEqual(r1.rail, { mode: "refuse", rule: "perp-venue-unready" });
    assert.ok(w.events.some((e) => /not on this machine/.test(e.message) && /Re-sign/.test(e.message)), JSON.stringify(w.events.slice(-3)));
    assert.equal(w.events.filter((e) => /not on this machine/.test(e.message)).length, 1, "said once, not every tick");
    assert.ok(w.energy.claimed > 0 && w.energy.claimed === w.energy.refunded, "the route's entry was held back and refunded");
  });
});

describe("a restart onto PAPER with a live position still open (rule 8a)", () => {
  it("never lets a practice zero stand in for unread live collateral, and retains each book's last successful read", async () => {
    const w = await world();
    await onboardAndOpen(w);
    let mode: ExecMode = { mode: "paper", rule: "live-not-enabled" };
    w.lane = laneFor(w, () => mode);
    const paper = await w.lane.refresh();
    assert.equal(paper.lastKnownMicro, 0n);
    venue.failing.add("/api/v1/account");
    try {
      mode = LIVE;
      const unread = await w.lane.refresh();
      assert.equal(unread.book, "unread");
      assert.equal(unread.lastKnownMicro, null, "this lane has no live book value yet; its practice zero is irrelevant");
      const vault = "0x00000000000000000000000000000000000000a1" as const;
      const verdict = checkPolicy({ kind: "vault-deposit", target: vault, amountUsdg: u(1) }, { ...w.limits, allowedTargets: [vault] }, {
        ...(await agentState(w, u(100), false)), perpVenueUnread: true, perpLastKnownMicro: unread.lastKnownMicro,
      });
      assert.equal(verdict.ok, false);
      if (!verdict.ok) assert.equal(verdict.rule, "perp-unpriced", "new spot risk remains blocked too");
    } finally {
      venue.failing.delete("/api/v1/account");
    }
    const read = await w.lane.refresh();
    assert.ok(read.lastKnownMicro !== null && read.lastKnownMicro > 0n);
    mode = { mode: "paper", rule: "live-not-enabled" };
    assert.equal((await w.lane.refresh()).lastKnownMicro, 0n);
    venue.failing.add("/api/v1/account");
    try {
      mode = LIVE;
      const unreadAgain = await w.lane.refresh();
      assert.equal(unreadAgain.book, "unread");
      assert.equal(unreadAgain.lastKnownMicro, read.lastKnownMicro, "a later outage preserves the real balance across a paper read");
    } finally {
      venue.failing.delete("/api/v1/account");
    }
  });

  it("the venue account is read anyway, and its position keeps its stop — the exits lane follows the venue, not the rail", async () => {
    const w = await world();
    await onboardAndOpen(w);
    // A fresh process: the account's rail now reads paper (live trading
    // switched off, or the last USDG posted as margin), nothing in memory.
    w.lane = laneFor(w, { mode: "paper", rule: "live-not-enabled" });
    await w.lane.armed();
    await w.lane.stopProtect();
    const v = venue.accounts.get(acctIdx(w))!;
    const stop = v.orders.find((o) => o.type === "stop-loss" && o.status === "pending")!;
    const trigger = stop.trigger;
    stop.status = "canceled";
    clock += 61_000;
    writeFeed();
    const sendsBefore = venue.sends.length;
    await pass(w);
    await pass(w);
    const placed = venue.sends.slice(sendsBefore).filter((s) => s.outcome === "executed");
    assert.equal(placed.length, 1, JSON.stringify(w.events.slice(-4)));
    assert.equal((JSON.parse(placed[0]!.txInfo) as Record<string, unknown>).Type, 2, "a stop, put back");
    assert.equal(v.orders.filter((o) => o.type === "stop-loss" && o.status === "pending")[0]?.trigger, trigger);
    assert.equal((await store.getPerpPositions(w.id, "paper")).length, 0, "and never a practice book beside it");
  });
});

describe("perps turned OFF with a position open", () => {
  it("is exits-only: no opens, the stop is still kept resting, and free collateral comes home once flat", async () => {
    const w = await world();
    await onboardAndOpen(w);
    w.cfg = config({ perpsEnabled: false });
    const r = await tick(w, { route: false });
    assert.deepEqual(r.rail, { mode: "off" });
    assert.equal(r.active, true, "what is held keeps the lane on (rule 8a)");
    assert.equal(r.exposure, true);

    // No opens.
    const built = buildOpenDraft({ market: r.view!.markets.get("BTC-PERP")!, side: "long", notionalCapMicro: u(20), stopBps: 300, maxSlippageBps: 50, stopSlipBps: 200, liqBufferBps: 200 });
    assert.ok(built.ok);
    const out = await w.lane.execute({ ...built.draft } as PerpOrderIntent, { equityUsdg: equityOf(w), equityKnown: true });
    assert.equal(out.status, "rejected");
    assert.equal(out.rejectRule, "perp-not-enabled", "perps off stops OPENS (rule 8a)");

    // THE STOP IS KEPT: gone at the venue, put back by the protective loop.
    const v = venue.accounts.get(acctIdx(w))!;
    const stop = v.orders.find((o) => o.type === "stop-loss" && o.status === "pending")!;
    const trigger = stop.trigger;
    stop.status = "canceled";
    clock += 61_000;
    writeFeed();
    const sendsBefore = venue.sends.length;
    await pass(w);
    const placed = venue.sends.slice(sendsBefore).filter((s) => s.outcome === "executed");
    assert.equal(placed.length, 1, JSON.stringify(w.events.slice(-4)));
    assert.equal(placed[0]!.txType, 14);
    assert.equal((JSON.parse(placed[0]!.txInfo) as Record<string, unknown>).Type, 2, "a stop-loss, reduce-only");
    const back = v.orders.filter((o) => o.type === "stop-loss" && o.status === "pending");
    assert.equal(back.length, 1);
    assert.equal(back[0]!.trigger, trigger, "at the stop the open carried");
    assert.equal(venue.sends.slice(sendsBefore).filter((s) => s.txType === 28).length, 0, "never an open");

    // The owner closes; once flat, the exits-only lane sends the free collateral home.
    const pos = (await store.getPerpPositions(w.id, "live")).find((p) => p.marketId === 1)!;
    const close: PerpOrderIntent = {
      kind: "perp-order",
      venue: "lighter",
      market: "BTC-PERP",
      marketId: 1,
      effect: "close",
      side: "long",
      reduceOnly: true,
      baseAmount: pos.base,
      worstPrice: mark - (mark * 150n) / 10_000n,
      markPrice: mark,
      notionalUsdg: 0n,
    };
    const closed = await w.lane.execute(close, { equityUsdg: equityOf(w), equityKnown: true });
    assert.equal(closed.status, "submitted");
    assert.equal(v.pos.size, 0);
    await tick(w, { route: false });
    clock += 16_000;
    await pass(w);
    const home = venue.sends.filter((s) => s.txType === 13 && s.outcome === "executed" && JSON.parse(s.txInfo).FromAccountIndex === acctIdx(w));
    assert.equal(home.length, 1, "free collateral asked home once flat");
    assert.equal(v.collateral, 0n);
  });
});

describe("owner exits and an entry switched off before retry", () => {
  for (const action of ["close", "flatten"] as const) {
    const exit = (w: World, deadline: number) => action === "close"
      ? w.lane.close("BTC-PERP", { book: "live", notAfterMs: deadline })
      : w.lane.flatten({ book: "live", notAfterMs: deadline });

    it(`${action} keeps the owner's original deadline through delayed decision recording`, async () => {
      clock = BAR + H;
      const w = await world();
      await onboardAndOpen(w);
      const before = venue.sends.length;
      const deadline = clock + 5_000;
      w.ownerDeadlineDelay = { phase: "decision", untilMs: deadline + 1 };
      const out = await exit(w, deadline);
      assert.equal(out.ok, false, out.sentence);
      assert.equal(venue.sends.length, before, "no signed close leaves after expiry, even before the timer fires");
      assert.ok(venue.accounts.get(acctIdx(w))!.pos.get(1), "the position remains protected at the venue");
    });

    it(`${action} cannot replay after expiry during the durable write even if rejection cannot be saved`, async () => {
      clock = BAR + H;
      const w = await world();
      await onboardAndOpen(w);
      const before = venue.sends.length;
      const deadline = clock + 5_000;
      w.ownerDeadlineDelay = { phase: "insert", untilMs: deadline + 1 };
      w.rejectOrderResolution = true;
      const out = await exit(w, deadline);
      assert.equal(out.ok, false, out.sentence);
      const [pending] = (await store.listSubmittedPerpOrders(w.id, "live")).filter(r => r.effect === "close");
      assert.ok(pending, "failed resolution leaves the persisted bytes for a later process");
      assert.ok(pending.sendNotAfterMs! <= deadline && pending.sendNotAfterMs! > deadline - 5_000);
      assert.equal(venue.sends.length, before);
      w.rejectOrderResolution = false;
      w.lane = laneFor(w, LIVE);
      await tick(w, { route: false });
      assert.equal(venue.sends.length, before, "a new handle cannot replay expired owner authority");
      assert.ok(venue.accounts.get(acctIdx(w))!.pos.get(1));
    });

    it(`${action} preserves its send deadline through a crash before expiry and restores it after restart`, async () => {
      clock = BAR + H;
      const w = await world();
      await onboardAndOpen(w);
      const before = venue.sends.length;
      const deadline = clock + 5_000;
      w.checkpointRejectsAfterInsert = true;
      await exit(w, deadline);
      const pending = (await store.listSubmittedPerpOrders(w.id, "live")).filter(r => r.effect === "close");
      assert.ok(pending.length > 0);
      for (const row of pending) assert.ok(row.sendNotAfterMs! <= deadline && row.sendNotAfterMs! > deadline - 5_000);
      assert.equal(venue.sends.length, before, "a failed checkpoint sends nothing");
      w.checkpointRejectsAfterInsert = false;
      clock = Math.max(clock, deadline + 1);
      writeFeed();
      w.lane = laneFor(w, LIVE);
      await tick(w, { route: false });
      assert.equal(venue.sends.length, before, "restart retains the original deadline even though the signature is still valid");
      assert.ok(venue.accounts.get(acctIdx(w))!.pos.get(1));
    });
  }

  it("a queued flatten keeps its original fifteen-minute ceiling even with a later owner deadline", async () => {
    clock = BAR + H;
    const w = await world();
    await onboardAndOpen(w);
    const before = venue.sends.length, started = clock;
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const held = w.lane.lock.run(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
    await ready;
    const pending = w.lane.standdown("flatten", { notAfterMs: started + 30 * 60_000 });
    clock = started + 15 * 60_000 + 1;
    writeFeed();
    release();
    await held;
    const result = await pending;
    assert.equal(result?.deadlineMs, started + 15 * 60_000);
    assert.equal(venue.sends.length, before, "time waiting for an in-flight operation does not renew flatten authority");
    assert.ok(venue.accounts.get(acctIdx(w))!.pos.get(1));
  });

  it("requires a book when practice and real holdings share a market, and keeps an explicit practice close in practice", async () => {
    const w = await world();
    await onboardAndOpen(w);
    const paper = laneFor(w, { mode: "paper", rule: "live-not-enabled" });
    const r = await paper.refresh();
    const built = buildOpenDraft({ market: r.view!.markets.get("BTC-PERP")!, side: "long", notionalCapMicro: u(20), stopBps: 300, maxSlippageBps: 50, stopSlipBps: 200, liqBufferBps: 200 });
    assert.ok(built.ok);
    assert.equal((await paper.execute(built.draft as PerpOrderIntent, { equityUsdg: u(100), equityKnown: true })).status, "paper");
    w.lane = paper; // the replacement process owns the signer's current account client
    assert.equal((await w.lane.ownerReport())?.mode, "live", "owner reads show retained real exposure while practicing");
    const before = venue.sends.length;
    const ambiguous = await w.lane.close("BTC-PERP");
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.sentence, /both the real and practice/);
    assert.equal(venue.sends.length, before);
    const practice = await w.lane.close("BTC-PERP", { book: "paper" });
    assert.equal(practice.ok, true, practice.sentence);
    assert.match(practice.sentence, /practice/);
    assert.equal(venue.sends.length, before, "an explicit practice close never reaches the live venue");
    assert.equal((await store.getPerpPositions(w.id, "paper")).length, 0);
    assert.ok(venue.accounts.get(acctIdx(w))!.pos.get(1));
    const real = await w.lane.close("BTC-PERP", { book: "live" });
    assert.equal(real.ok, true, `${real.sentence} ${JSON.stringify(w.events.slice(-4))}`);
    assert.match(real.sentence, /real-money/);
    assert.equal(venue.accounts.get(acctIdx(w))!.pos.size, 0);
  });

  it("closes real holdings despite unread daily facts, then never replays an entry after consent is off", async () => {
    const w = await world();
    await onboardAndOpen(w);
    w.ledgerFactsUnread = true;
    w.cfg = config({ perpsEnabled: false });
    const out = await w.lane.close("BTC-PERP");
    assert.equal(out.ok, true, out.sentence);
    assert.equal(venue.accounts.get(acctIdx(w))!.pos.size, 0);
    w.ledgerFactsUnread = false;
    w.cfg = config();
    await tick(w, { route: false });
    const m = w.lane.snapshotView()!.markets.get("BTC-PERP")!;
    const built = buildOpenDraft({ market: m, side: "long", notionalCapMicro: u(20), stopBps: 300, maxSlippageBps: 50, stopSlipBps: 200, liqBufferBps: 200 });
    assert.ok(built.ok);
    venue.dropNextSend = true;
    const pending = await w.lane.execute(built.draft as PerpOrderIntent, { equityUsdg: equityOf(w), equityKnown: true });
    assert.equal(pending.status, "submitted");
    const row = liveOrders(w).filter((r) => r.effect === "open").at(-1)!;
    w.cfg = config({ perpsEnabled: false });
    await tick(w, { route: false, advanceMs: 12_000 });
    assert.equal(venue.sends.filter((s) => s.hash === row.tx_hash).length, 1, "the original uncertain send is never replayed after entries stop");
    assert.equal(venue.accounts.get(acctIdx(w))!.pos.size, 0);
    assert.equal(liveOrders(w).find((r) => r.id === row.id)!.status, "submitted", "still resolved by its original hash, never guessed rejected");
  });
});

describe("live leverage obeys the shared operation allowance", () => {
  async function beforeLeverage() {
    const w = await world();
    await w.lane.armed();
    await w.lane.stopProtect();
    for (let i = 0; i < 3; i++) await tick(w);
    const r = await tick(w, { advanceMs: 11 * 60_000, route: false });
    assert.equal(r.rail.mode, "live");
    assert.equal(liveOrders(w).length, 0);
    w.cachedBudget = { ops: await store.getOpsToday(w.id, "live"), spend: u(await store.getSpentTodayUsdg(w.id, "live")) };
    const built = buildOpenDraft({ market: r.view!.markets.get("BTC-PERP")!, side: "long", notionalCapMicro: u(20), stopBps: 300, maxSlippageBps: 50, stopSlipBps: 200, liqBufferBps: 200 });
    assert.ok(built.ok);
    return { w, draft: built.draft as PerpOrderIntent };
  }

  it("signs nothing when the open is capped, expiring or in drawdown; counts leverage before the next intent and still permits exits", async () => {
    const { w, draft } = await beforeLeverage();
    const ops = w.cachedBudget!.ops;
    const spend = w.cachedBudget!.spend;
    const sends = venue.sends.length;
    const expiry = w.limits.expiresAt;
    w.limits.maxOpsPerDay = ops;
    assert.equal((await w.lane.execute(draft, { equityUsdg: u(100), equityKnown: true })).rejectRule, "ops-cap");
    w.limits.maxOpsPerDay = ops + 1;
    w.limits.expiresAt = Math.floor(clock / 1000) + 12 * 3600;
    assert.equal((await w.lane.execute(draft, { equityUsdg: u(100), equityKnown: true })).rejectRule, "perp-grant-expiring");
    w.limits.expiresAt = expiry;
    assert.equal((await w.lane.execute(draft, { equityUsdg: u(50), equityKnown: true })).rejectRule, "drawdown-breaker");
    w.limits.dailyUsdg = spend;
    assert.equal((await w.lane.execute(draft, { equityUsdg: u(100), equityKnown: true })).rejectRule, "daily-cap");
    w.limits.dailyUsdg = u(500);
    assert.equal(venue.sends.length, sends, "none of the refused opens may set leverage");
    assert.equal(liveOrders(w).length, 0);

    assert.equal((await w.lane.execute(draft, { equityUsdg: u(100), equityKnown: true })).rejectRule, "perp-leverage-unset");
    assert.equal(liveOrders(w).length, 1);
    assert.equal(liveOrders(w)[0]!.effect, "leverage");
    assert.deepEqual(w.cachedBudget, { ops: ops + 1, spend }, "leverage spends one op and no opening notional");
    assert.deepEqual(w.inFlight, { ops: 0, spend: 0n });
    assert.equal((await w.lane.execute(draft, { equityUsdg: u(100), equityKnown: true })).rejectRule, "ops-cap", "the next intent sees the op before another tick refresh");
    assert.equal(venue.sends.length, sends + 1);

    w.limits.maxOpsPerDay = ops + 2;
    await tick(w, { route: false });
    assert.equal((await w.lane.execute(draft, { equityUsdg: u(100), equityKnown: true })).status, "submitted");
    assert.equal(w.cachedBudget!.ops, ops + 2);
    assert.ok(w.cachedBudget!.spend > spend, "the later open counts its own notional once");
    await tick(w, { route: false });
    const closed = await w.lane.close("BTC-PERP", { book: "live" });
    assert.equal(closed.ok, true, closed.sentence);
    assert.equal(venue.accounts.get(acctIdx(w))!.pos.size, 0, "an exhausted operation allowance never blocks a reduce-only exit");
  });

  it("keeps the leverage op counted if its post-sign budget refresh fails", async () => {
    const { w, draft } = await beforeLeverage();
    const ops = w.cachedBudget!.ops;
    const spend = w.cachedBudget!.spend;
    w.limits.maxOpsPerDay = ops + 1;
    w.budgetRefreshFails = true;
    assert.equal((await w.lane.execute(draft, { equityUsdg: u(100), equityKnown: true })).rejectRule, "perp-leverage-unset");
    assert.deepEqual(w.cachedBudget, { ops: ops + 1, spend });
    assert.deepEqual(w.inFlight, { ops: 0, spend: 0n });
    assert.equal((await w.lane.execute(draft, { equityUsdg: u(100), equityKnown: true })).rejectRule, "ops-cap");
    assert.equal(liveOrders(w).length, 1);
  });
});

describe("a local commit followed by a failed hosted checkpoint", () => {
  async function beforeLeverage() {
    const w = await world();
    await w.lane.armed();
    await w.lane.stopProtect();
    for (let i = 0; i < 3; i++) await tick(w);
    const r = await tick(w, { advanceMs: 11 * 60_000, route: false });
    w.cachedBudget = { ops: await store.getOpsToday(w.id, "live"), spend: u(await store.getSpentTodayUsdg(w.id, "live")) };
    const built = buildOpenDraft({ market: r.view!.markets.get("BTC-PERP")!, side: "long", notionalCapMicro: u(20), stopBps: 300, maxSlippageBps: 50, stopSlipBps: 200, liqBufferBps: 200 });
    assert.ok(built.ok);
    return { w, draft: built.draft as PerpOrderIntent };
  }

  it("counts a locally committed leverage row when checkpoint publication throws before broadcast", async () => {
    const { w, draft } = await beforeLeverage();
    const before = { ...w.cachedBudget! };
    const sends = venue.sends.length;
    w.checkpointRejectsAfterInsert = true;
    const out = await w.lane.execute(draft, { equityUsdg: u(100), equityKnown: true });
    assert.equal(out.status, "rejected");
    assert.equal(venue.sends.length, sends, "a checkpoint failure prevents broadcast");
    assert.equal(liveOrders(w)[0]!.status, "submitted", "the local signed row remains pending");
    assert.deepEqual(w.cachedBudget, { ops: before.ops + 1, spend: before.spend });
    assert.deepEqual(w.inFlight, { ops: 0, spend: 0n });
  });

  it("counts a locally committed opening order and its notional when checkpoint publication throws", async () => {
    const { w, draft } = await beforeLeverage();
    await w.lane.execute(draft, { equityUsdg: u(100), equityKnown: true });
    await tick(w, { route: false });
    const before = { ...w.cachedBudget! };
    const sends = venue.sends.length;
    w.checkpointRejectsAfterInsert = true;
    const out = await w.lane.execute(draft, { equityUsdg: u(100), equityKnown: true });
    assert.equal(out.status, "rejected");
    assert.equal(venue.sends.length, sends);
    const open = liveOrders(w).find((r) => r.effect === "open")!;
    assert.equal(open.status, "submitted");
    assert.deepEqual(w.cachedBudget, { ops: before.ops + 1, spend: before.spend + BigInt(open.worst_notional_micro as string) });
    assert.deepEqual(w.inFlight, { ops: 0, spend: 0n });
  });
});

describe("the fake venue itself", () => {
  it("never saw a byte no ledger row held, and never failed on its own (a fake that threw would prove nothing)", () => {
    assert.deepEqual(venue.violations, []);
    assert.deepEqual(venue.errors, []);
  });
});

describe("autonomous first entry survives temporary admission failures", () => {
  for (const failure of ["energy-claim", "decision-write"] as const) {
    it(`${failure} failure before execution keeps the same signal available for complete onboarding`, async () => {
      const w = await world();
      await w.lane.armed();
      await w.lane.stopProtect();
      await tick(w, { route: false });
      const normal = hooks(w);
      let withheld = 0;
      await w.lane.runRoute({ ...TICK, equityUsdg: equityOf(w) }, {
        ...normal,
        ...(failure === "energy-claim" ? {
          claimEntry: async () => ({ ok: false }),
          withholdEntry: async () => { withheld++; },
        } : { ensureDecision: async () => ({ ok: false as const, why: "temporary decision store outage" }) }),
      });
      assert.equal(w.legs.length, 0, "no deposit was authorized before admission and decision stamping");
      assert.equal(liveOrders(w).length, 0);
      if (failure === "energy-claim") assert.equal(withheld, 1);
      else assert.equal(w.energy.claimed, w.energy.refunded, "failed decision refunded its entry claim");
      // The next tick is still within the exact same 4h signal candle.
      await tick(w);
      assert.deepEqual(w.legs, [{ kind: "perp-deposit", status: "landed" }], "recovery proceeds without waiting four hours for another signal");
      await tick(w); // credited deposit, register key
      await tick(w); // key self-check, nonce horizon
      await tick(w, { advanceMs: 11 * 60_000 }); // leverage
      await tick(w); // protected entry
      assert.equal(liveOrders(w).filter(row => row.effect === "open").length, 1);
      assert.ok(venue.accounts.get(acctIdx(w))?.pos.get(1));
      await tick(w); // reconciliation must not duplicate entry
      assert.equal(liveOrders(w).filter(row => row.effect === "open").length, 1);
      const order = liveOrders(w).find(row => row.effect === "open")!;
      assert.deepEqual(rows("SELECT role FROM perp_order_legs WHERE order_id = ? ORDER BY client_order_index", String(order.id)).map(row => row.role), ["entry", "sl"]);
    });
  }
});

describe("autonomous recovery after the exact key file is restored", () => {
  it("rechecks a repaired sealed key without a restart, while an unrelated key never resumes trading", async () => {
    const restored = signer.generateApiKey();
    const w = await world({ sealed: restored.publicKey });
    w.chain.idx = w.idxOnDeposit;
    w.chain.cash -= u(20);
    venue.credit(w.sa, u(20), Number(w.chain.idx));
    venue.registerKey(Number(w.chain.idx), 16, restored.publicKey);
    await w.lane.armed();
    await w.lane.stopProtect();
    const blocked = await tick(w, { route: false });
    assert.equal(blocked.report.blocker, "perps-key-pending");
    writePerpKeyFile(HOME, signer.generateApiKey());
    const unrelated = await tick(w, { advanceMs: 61_000, route: false });
    assert.equal(unrelated.report.blocker, "perps-key-pending");
    assert.equal(liveOrders(w).length, 0, "another readable private key is not authority for this grant");
    writePerpKeyFile(HOME, restored);
    await tick(w, { advanceMs: 61_000, route: false });
    const ready = await tick(w, { advanceMs: 11 * 60_000, route: false });
    assert.equal(ready.rail.mode, "live", "the matching key is verified and the existing nonce horizon still applies");
    assert.equal((await store.getPerpAccount(w.id, "live"))?.registeredPubkey, restored.publicKey);
    assert.equal(liveOrders(w).length, 0, "recovery itself does not open or raise leverage");
    // Only the ordinary fresh route and all its policy checks may now trade.
    await tick(w);
    await tick(w);
    assert.equal(liveOrders(w).filter(row => row.effect === "open").length, 1);
    assert.ok(venue.accounts.get(acctIdx(w))?.pos.get(1));
  });
});

describe("live stop renewal", () => {
  it("keeps the old stop until its exact replacement reads resting, then converges without further sends", async () => {
    clock = BAR + H;
    mark = 802_000n; venue.setMark(1, mark);
    const w = await world(); await onboardAndOpen(w);
    w.cfg.perpsDriver = "manual";
    const account = venue.accounts.get(acctIdx(w))!;
    const old = account.orders.find(o => o.type === "stop-loss" && o.status === "pending")!;
    assert.ok(old);
    old.expiry = clock + 6 * 86_400_000;

    await tick(w, { route: false, advanceMs: 61_000 }); await pass(w);
    const replacement = account.orders.find(o => o.type === "stop-loss" && o.orderIndex !== old.orderIndex)!;
    assert.ok(replacement);
    assert.equal(old.status, "pending", "sending a renewal is not confirmation that it rests");

    venue.failing.add("/api/v1/accountActiveOrders");
    try {
      await tick(w, { route: false, advanceMs: 16_000 }); await pass(w);
      assert.equal(old.status, "pending", "an unread order list cannot retire the old stop");
    } finally {
      venue.failing.delete("/api/v1/accountActiveOrders");
    }
    await tick(w, { route: false, advanceMs: 16_000 }); await pass(w);
    assert.equal(old.status, "canceled");
    assert.equal(replacement.status, "pending");
    const sent = venue.sends.length;
    await tick(w, { route: false, advanceMs: 61_000 }); await pass(w);
    assert.equal(venue.sends.length, sent, "confirmed renewal ends the replacement/cancellation loop");
    assert.equal(liveOrders(w).filter(row => row.reason === "protective-stop-expiring").length, 1);
  });
});

describe("idle collateral returns after a durable full day flat", () => {
  async function flatWorld() {
    clock = BAR + H;
    mark = 802_000n; venue.setMark(1, mark);
    const w = await world(); await onboardAndOpen(w);
    w.cfg.perpsDriver = "manual";
    const closed = await w.lane.close("BTC-PERP"); assert.equal(closed.ok, true);
    await tick(w, { route: false });
    assert.equal(venue.accounts.get(acctIdx(w))!.pos.size, 0);
    const flat = (await store.getPerpAccount(w.id, "live"))?.flatSince;
    assert.ok(flat); return { w, flat };
  }
  it("survives closing and reopening the ledger and lane without shortening or restarting the 24-hour clock", async () => {
    const { w, flat } = await flatWorld();
    const deadline = flat.atMs + LIVE_LANE_TIMING.flatWithdrawMs;
    await tick(w, { route: false, advanceMs: deadline - clock - 1 });
    await pass(w);
    assert.equal(liveOrders(w).filter(row => row.effect === "withdraw").length, 0, "one millisecond short is still too early");
    await w.lane.stopProtect();
    store.closeStoreForTest();
    const cwd = process.cwd(); try { process.chdir(isolatedCwd); await store.initStore(); } finally { process.chdir(cwd); }
    w.lane = laneFor(w, LIVE);
    await w.lane.armed(); await w.lane.stopProtect();
    assert.equal((await store.getPerpAccount(w.id, "live"))?.flatSince?.atMs, flat.atMs);
    await tick(w, { route: false, advanceMs: 1 });
    await pass(w);
    assert.equal(liveOrders(w).filter(row => row.effect === "withdraw").length, 1, "the idle funds return without another day after redeploy");
  });
  it("a reopened position clears the old flat interval; malformed and future clocks authorize no immediate withdrawal", async () => {
    const { w, flat } = await flatWorld();
    const read = await tick(w, { route: false });
    const draft = buildOpenDraft({ market: read.view!.markets.get("BTC-PERP")!, side: "long", notionalCapMicro: u(20), stopBps: 300, maxSlippageBps: 50, stopSlipBps: 200, liqBufferBps: 200 });
    assert.ok(draft.ok); assert.equal((await w.lane.execute(draft.draft as PerpOrderIntent, { equityUsdg: equityOf(w), equityKnown: true })).status, "submitted");
    await tick(w, { route: false });
    assert.equal((await store.getPerpAccount(w.id, "live"))?.flatSince, null, "a held position retires the previous clock");
    assert.equal((await w.lane.close("BTC-PERP")).ok, true);
    await tick(w, { route: false });
    const again = (await store.getPerpAccount(w.id, "live"))!.flatSince!;
    assert.ok(again.atMs > flat.atMs);
    await pass(w);
    assert.equal(liveOrders(w).filter(row => row.effect === "withdraw").length, 0);
    for (const invalid of ["broken-json", JSON.stringify({ ...again, atMs: clock + 99_000 }), JSON.stringify({ ...again, epoch: again.epoch + 1 }), JSON.stringify({ ...again, accountIndex: again.accountIndex + 1 })]) {
      raw.prepare("UPDATE perp_accounts SET flat_since_json = ? WHERE agent_id = ? AND mode = 'live'").run(invalid, w.id);
      await tick(w, { route: false }); await pass(w);
      assert.equal(liveOrders(w).filter(row => row.effect === "withdraw").length, 0);
      assert.ok((await store.getPerpAccount(w.id, "live"))!.flatSince!.atMs >= again.atMs);
    }
  });
  it("an open that stops out between reads cannot revive the pre-open clock after a crash", async () => {
    const { w, flat } = await flatWorld();
    const read = await tick(w, { route: false, advanceMs: LIVE_LANE_TIMING.flatWithdrawMs + 1 });
    const draft = buildOpenDraft({ market: read.view!.markets.get("BTC-PERP")!, side: "long", notionalCapMicro: u(20), stopBps: 300, maxSlippageBps: 50, stopSlipBps: 200, liqBufferBps: 200 });
    assert.ok(draft.ok);
    assert.equal((await w.lane.execute(draft.draft as PerpOrderIntent, { equityUsdg: equityOf(w), equityKnown: true })).status, "submitted");
    assert.equal((await store.getPerpAccount(w.id, "live"))?.flatSince, null, "the signed open and retired clock commit atomically before broadcast");
    // The venue fills its resting stop before the worker observes the holding.
    mark = mark * 97n / 100n; venue.setMark(1, mark);
    assert.equal(venue.accounts.get(acctIdx(w))!.pos.size, 0);
    await w.lane.stopProtect(); store.closeStoreForTest();
    const cwd = process.cwd(); try { process.chdir(isolatedCwd); await store.initStore(); } finally { process.chdir(cwd); }
    w.lane = laneFor(w, LIVE); await w.lane.armed(); await w.lane.stopProtect();
    await tick(w, { route: false }); await pass(w);
    assert.equal(liveOrders(w).filter(row => row.effect === "withdraw").length, 0);
    assert.ok((await store.getPerpAccount(w.id, "live"))!.flatSince!.atMs > flat.atMs, "flat again starts its own full day");
  });
  it("a new deposit after the idle return survives protect before the next entry tick", async () => {
    const { w, flat } = await flatWorld();
    await tick(w, { route: false, advanceMs: LIVE_LANE_TIMING.flatWithdrawMs + 1 }); await pass(w);
    assert.equal(liveOrders(w).filter(row => row.effect === "withdraw").length, 1);
    await tick(w, { route: false });
    assert.equal(venue.accounts.get(acctIdx(w))!.collateral, 0n);
    const returned = venue.makeClaimable(acctIdx(w)); w.chain.pending += returned;
    await tick(w, { route: false });
    w.chain.logs.push(withdrawPendingLog(w.sa, w.chain.block + 1n, returned));
    w.chain.pending -= returned; w.chain.cash += returned; venue.complete(acctIdx(w));
    await tick(w, { route: false });
    assert.deepEqual(await runLeg(w, { kind: "perp-margin", direction: "deposit", target: PROXY, amountUsdg: u(12) }), { status: "landed" });
    const funded = await tick(w, { route: false }); await pass(w);
    assert.deepEqual(funded.rail, { mode: "refuse", rule: "perp-venue-unready" }, "the credit reconcile is a temporary wait, not disabled consent");
    assert.equal(liveOrders(w).filter(row => row.effect === "withdraw").length, 1, "fresh funding is not swept by a previous timer or temporary readiness wait");
    assert.ok((await store.getPerpAccount(w.id, "live"))!.flatSince!.atMs > flat.atMs);
    const read = await tick(w, { route: false });
    const draft = buildOpenDraft({ market: read.view!.markets.get("BTC-PERP")!, side: "long", notionalCapMicro: u(20), stopBps: 300, maxSlippageBps: 50, stopSlipBps: 200, liqBufferBps: 200 });
    assert.ok(draft.ok);
    assert.equal((await w.lane.execute(draft.draft as PerpOrderIntent, { equityUsdg: equityOf(w), equityKnown: true })).status, "submitted");
    assert.ok(venue.accounts.get(acctIdx(w))!.pos.get(1), "new funding reaches its protected entry");
  });
  it("an incoming deposit cannot reacquire the old idle interval before it lands", async () => {
    const { w } = await flatWorld();
    await tick(w, { route: false, advanceMs: LIVE_LANE_TIMING.flatWithdrawMs + 1 });
    const deposit = { agentId: w.id, mode: "live" as const, direction: "deposit" as const, amountMicro: u(1), initiator: "agent" as const, state: "submitted" as const, userOpHash: h32() };
    await store.upsertPerpTransfer(deposit);
    await tick(w, { route: false }); await pass(w);
    assert.equal((await store.getPerpAccount(w.id, "live"))!.flatSince, null);
    assert.equal(liveOrders(w).filter(row => row.effect === "withdraw").length, 0);
    assert.equal((await store.upsertPerpTransfer(deposit)).outcome, "unchanged");
    await tick(w, { route: false });
    assert.equal((await store.getPerpAccount(w.id, "live"))!.flatSince, null);
    w.cfg.perpsEnabled = false;
    await tick(w, { route: false }); await pass(w);
    assert.equal(liveOrders(w).filter(row => row.effect === "withdraw").length, 1, "actually switching off still returns free collateral immediately");
    assert.equal(liveOrders(w).find(row => row.effect === "withdraw")!.reason, "exits-only");
  });
});
