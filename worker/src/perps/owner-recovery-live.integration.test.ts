/**
 * Recovery through the real lane, verifier, policy, signer and durable ledger.
 * The local FakeLighter and modelled UserOp rail are the same seams exercised
 * by live-e2e.integration.test.ts. No external RPC, provider or funds are used.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { encodeAbiParameters, toEventSelector, pad as padHex, type Hex } from "viem";
import { ENTRYPOINT, GRANT_PERP_LIGHTER, LIGHTER_ROUTE_V1, type PerpGrant, type PerpRecoveryReference } from "../../../packages/core/src/index";
import type { ExecMode } from "../exec-mode";
import { type PayoutFold } from "../flow-inference";
import type { RawLog } from "../inflight-reconcile";
import { checkPolicy, type AgentLimits, type AgentState, type PerpOrderIntent, type TradeIntent } from "../policy";
import { provenanceOf } from "../provenance";
import { readLighterFeed, specToJson, type LighterFeedFileMarket } from "./feed-reader";
import { writePerpKeyFile } from "./keystore";
import { createPerpLane, type PerpLane, type PerpLaneConfig, type PerpLaneRead } from "./lane";
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
import { FakeLighter, specOf } from "./testkit-live-venue";
import { H4, candles, scaleRange } from "./testkit-perps";
import { verifyOwnerRecoveryProof, type RecoveryReceipt } from "./owner-recovery-proof";
import { readRecoveries, recoveryReplacementKeys } from "./owner-recovery-state";

// ── an isolated ledger ──────────────────────────────────────────────────────

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-perp-recovery-e2e-"));
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
const freshKey = signer.generateApiKey();
writePerpKeyFile(HOME, freshKey);
const FRESH = freshKey.publicKey;

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
  active: boolean;
  recovery?: PerpRecoveryReference;
  receipt?: RecoveryReceipt;
  beforeSend?: () => Promise<void>;
  proofCalls: number;
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
    active: true,
    proofCalls: 0,
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
    armed: () => w.active ? ({ agentId: id, smartAccount: sa, limits, recovery: w.recovery }) : null,
    config: () => w.cfg,
    execMode: () => typeof exec === "function" ? exec() : exec,
    readFeed: (now) => readLighterFeed(FEED_FILE, now),
    now: () => clock,
    agentState: (e) => agentState(w, e.equityUsdg, e.equityKnown),
    budget: {
      reserve: (s) => {
        w.inFlight.ops += 1;
        w.inFlight.spend += s;
      },
      release: (s) => {
        w.inFlight.ops -= 1;
        w.inFlight.spend -= s;
      },
      refresh: async () => {},
    },
    events: async (level, message) => void w.events.push({ level, message }),
    decide: (intent, source, reason, known) => decide(id, intent, source, reason, known),
    log: () => {},
    live: {
      home: () => HOME,
      beforeSend: async () => { await w.beforeSend?.(); },
      // Real receipt verifier; its read seams use this test's chain and venue only.
      verifyRecovery: async (reference, context, opts) => {
        w.proofCalls += 1;
        return verifyOwnerRecoveryProof(reference, {
          now: () => clock, ...context, newPublicKey: opts.newPublicKey,
          readChainId: async () => CHAIN_ID,
          readReceipt: async () => w.receipt ?? null,
          readCanonicalBlockHash: async () => w.receipt?.blockHash ?? null,
          readAccountIndex: async () => w.chain.idx,
          readSlot: async () => {
            const pk = venue.accounts.get(Number(w.chain.idx))?.keys.get(16)?.pub;
            return pk ? `0x${pk}` : null;
          },
          readFlat: async () => {
            const a = venue.accounts.get(Number(w.chain.idx));
            return !!a && a.collateral === 0n && a.pos.size === 0 &&
              !a.orders.some(o => o.status === "open" || o.status === "pending");
          },
        });
      },
      loadSigner: async () => signer,
      api: (s) => apiFor(s),
      publicApi: () => publicApi,
      store,
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
  const SEALED = w.limits.perp!.apiPublicKey;
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
    venue.accounts.get(Number(w.chain.idx))!.authOk = true;
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

const rows = (sql: string, ...args: (string | number)[]) => raw.prepare(sql).all(...args) as Record<string, unknown>[];
const liveOrders = (w: World) => rows("SELECT * FROM perp_orders WHERE agent_id = ? AND mode = 'live' ORDER BY nonce", w.id.toLowerCase());
const acctIdx = (w: World) => Number(w.chain.idx);


async function recoveringWorld() {
  const w = await world({ sealed: FRESH });
  w.chain.idx = w.idxOnDeposit;
  venue.credit(w.sa, 0n, acctIdx(w));
  venue.replaceKey(acctIdx(w), 16, FOREIGN);
  await store.patchPerpAccount(w.id, 'live', {
    accountIndex: acctIdx(w), registeredPubkey: SEALED, entriesHalted: true,
    incident: { kind: 'pubkey-mismatch', at: Math.floor(clock / 1000), detail: 'owner recovery integration fixture' },
    incidentSealedPubkey: SEALED,
  });
  const context = await store.getPerpRecoveryContext(w.id);
  const txHash = h32(), userOpHash = h32(), blockHash = h32();
  w.recovery = {
    v: 1, smartAccount: w.sa, chainId: CHAIN_ID, route: GRANT_PERP_LIGHTER,
    accountIndex: acctIdx(w), apiKeyIndex: 16, incidentId: context.incidentId,
    evidenceDigest: context.evidenceDigest, oldPublicKey: SEALED,
    recoveryPublicKey: FOREIGN, newPublicKey: FRESH, txHash, userOpHash,
    notAfterMs: clock + 10 * 60_000,
  };
  w.receipt = {
    status: 'success', transactionHash: txHash, blockHash, blockNumber: 9n,
    logs: [
      { address: ENTRYPOINT.v07, topics: [toEventSelector('BeforeExecution()')], data: '0x', logIndex: 0 },
      ...keyOpLogs(w.sa, w.chain.idx, FOREIGN).map(l => ({ ...l, logIndex: 1 })),
      { address: ENTRYPOINT.v07,
        topics: [toEventSelector('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)'), userOpHash, padHex(w.sa), padHex('0x0000000000000000000000000000000000000000')],
        data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [4n, true, 1n, 1n]), logIndex: 2 },
    ],
  };
  return w;
}

async function assertStillHalted(w: World) {
  const a = (await store.getPerpAccount(w.id, 'live'))!;
  assert.equal(a.incidentId, w.recovery!.incidentId);
  assert.equal(a.entriesHalted, true);
  assert.equal(a.recoveriesJson, null);
  assert.deepEqual(a.retiredPubkeys, []);
  assert.equal(w.legs.length, 0);
  assert.equal(liveOrders(w).length, 0);
  assert.equal(venue.accounts.get(acctIdx(w))!.keys.get(16)!.pub, FOREIGN.slice(2));
}

describe('owner recovery through the live lane', () => {
  it('verifies recovery, preserves halt and current consent, then registers only the fresh key and opens with a persisted stop', async () => {
    const w = await recoveringWorld();
    w.cfg.perpsLiveEnabled = false;
    await tick(w);
    let a = (await store.getPerpAccount(w.id, 'live'))!;
    assert.equal(w.proofCalls, 1);
    assert.equal(a.incident, null);
    assert.equal(a.entriesHalted, true, 'verifying recovery does not grant permission to resume');
    assert.deepEqual(a.retiredPubkeys, [SEALED]);
    assert.equal(readRecoveries(a.recoveriesJson, w.sa).length, 1);
    assert.deepEqual(recoveryReplacementKeys(a.recoveriesJson, w.sa, FRESH), [FOREIGN]);
    assert.deepEqual(recoveryReplacementKeys(a.recoveriesJson, w.sa, SEALED), []);
    assert.equal(w.legs.length, 0, 'disabled live consent prevents registration and funding');

    assert.equal((await w.lane.resumeEntries('live')).ok, true);
    await tick(w);
    assert.equal(w.legs.length, 0, 'explicit resume still cannot bypass current live consent');
    w.cfg.perpsLiveEnabled = true;
    w.cfg.perpsPerTradeUsdg = 20; // A newly tightened owner cap applies after recovery.
    await tick(w);
    assert.equal(w.legs.at(-1)?.kind, 'perp-deposit');
    assert.equal(venue.accounts.get(acctIdx(w))!.keys.get(16)!.pub, FOREIGN.slice(2), 'deposit never changes the slot');
    await tick(w);
    assert.equal(w.legs.at(-1)?.kind, 'perp-key');
    assert.equal(venue.accounts.get(acctIdx(w))!.keys.get(16)!.pub, FRESH.slice(2));
    await tick(w);
    await tick(w, { advanceMs: 11 * 60_000 });
    for (let i = 0; i < 4 && !venue.accounts.get(acctIdx(w))!.pos.has(1); i++) await tick(w);
    await tick(w, { route: false });

    a = (await store.getPerpAccount(w.id, 'live'))!;
    assert.equal(a.registeredPubkey, FRESH);
    assert.equal(a.incident, null);
    assert.equal(w.proofCalls, 1, 'consumed recovery never re-verifies or grants another replacement');
    const opened = liveOrders(w).filter(o => o.effect === 'open');
    assert.equal(opened.length, 1, JSON.stringify(w.events.slice(-8)));
    assert.equal(opened[0]!.tx_type, 28, 'entry and stop share one atomic signed OTO');
    assert.ok(BigInt(String(opened[0]!.worst_notional_micro)) <= u(w.cfg.perpsPerTradeUsdg));
    assert.deepEqual(rows('SELECT role FROM perp_order_legs WHERE order_id = ? ORDER BY client_order_index', String(opened[0]!.id)).map(o => o.role), ['entry', 'sl']);
    assert.ok(venue.accounts.get(acctIdx(w))!.pos.has(1));
    assert.ok(venue.accounts.get(acctIdx(w))!.orders.some(o => o.type === 'stop-loss' && o.reduceOnly && (o.status === 'pending' || o.status === 'open')));
    assert.deepEqual(venue.violations, [], 'every L2 send was durably persisted first');
    assert.deepEqual(venue.errors, []);
  });

  it('a recovered account never raises an owner cap below the venue minimum to make a trade', async () => {
    const w = await recoveringWorld();
    await tick(w, { route: false });
    assert.equal((await w.lane.resumeEntries('live')).ok, true);
    w.cfg.perpsPerTradeUsdg = 15; // BTC minBase at this mark needs at least $16.04.
    for (let i = 0; i < 3; i++) await tick(w);
    assert.equal(w.cfg.perpsPerTradeUsdg, 15);
    assert.equal(w.legs.length, 0);
    assert.equal(liveOrders(w).length, 0);
    assert.equal((await store.getPerpAccount(w.id, 'live'))!.incident, null);
    assert.equal(venue.accounts.get(acctIdx(w))!.collateral, 0n);
  });

  for (const mode of ['expired', 'failed-receipt'] as const) {
    it(`${mode} proof leaves the incident and slot intact and cannot resume`, async () => {
      const w = await recoveringWorld();
      if (mode === 'expired') w.recovery!.notAfterMs = clock;
      else w.receipt!.status = 'reverted';
      await tick(w);
      assert.ok(w.proofCalls > 0);
      await assertStillHalted(w);
      assert.equal((await w.lane.resumeEntries('live')).ok, false);
    });
  }

  it('a grant revoked while the final beforeSend fence waits cannot clear the incident', async () => {
    const w = await recoveringWorld();
    let release!: () => void, reached!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { reached = resolve; });
    w.beforeSend = async () => { reached(); await blocked; };
    const pending = tick(w, { route: false });
    await entered;
    w.active = false;
    release();
    await pending;
    await assertStillHalted(w);
  });

  it('a different foreign key appearing after verification is never overwritten by the replacement grant', async () => {
    const w = await recoveringWorld();
    await tick(w, { route: false });
    assert.equal((await store.getPerpAccount(w.id, 'live'))!.incident, null);
    const unrelated = signer.generateApiKey().publicKey;
    venue.replaceKey(acctIdx(w), 16, unrelated);
    assert.equal((await w.lane.resumeEntries('live')).ok, true);
    await tick(w);
    assert.equal(venue.accounts.get(acctIdx(w))!.keys.get(16)!.pub, unrelated.slice(2));
    assert.ok((await store.getPerpAccount(w.id, 'live'))!.incident, 'new foreign slot creates a fresh incident');
    assert.equal(w.legs.length, 0);
    assert.equal(liveOrders(w).length, 0);
  });
});
