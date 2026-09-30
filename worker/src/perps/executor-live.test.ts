/**
 * THE LIVE LIGHTER EXECUTOR — the real signer (hash-pinned, KAT-checked, a
 * freshly generated key), a real sqlite ledger, and a FAKE venue: no network.
 *
 * What each block pins:
 *   persist → send   the rule-9 row, with the exact bytes, exists before
 *                    sendTx is called; a failed write sends nothing.
 *   answers          a timeout leaves the row submitted and the SAME bytes are
 *                    what a re-send sends; a refusal that an executed tx would
 *                    also produce (21104, 21728) leaves it submitted; /tx by
 *                    hash moves it.
 *   the open         one grouped tx: entry IOC + a reduce-only SL child sized
 *                    by the venue (BaseAmount 0) expiring in 28 days; client
 *                    order indexes nonce × 8 + leg; leverage asserted from the
 *                    venue read.
 *   exits            clamped to the venue position, IsAsk from the side HELD.
 *   money home       a withdrawal never exceeds free collateral, and its order
 *                    and transfer rows are one transaction.
 *   leverage         only while flat with nothing resting.
 *   nonces           strictly increasing in send order, however many callers.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, beforeEach, describe, it } from "node:test";
import { LIGHTER_ROUTE_V1, PERP_LEG, isolatedLiqPrice, notionalMicro, perpCoi, type PerpKey } from "../../../packages/core/src/perps";
import type { PerpOrderIntent } from "../policy";
import type { LighterApi, LighterApiError, LighterResult, SendTxError, SendTxReceipt } from "./api";
import { createLighterAuth } from "./auth";
import { PerpRefused } from "./executor";
import {
  LIVE_STOP_EXPIRY_MS,
  LIVE_TX_POLL_DELAYS_MS,
  createLivePerpExecutor,
  resendPersisted,
  type LivePerpApi,
  type LivePerpExecutor,
  type LivePerpReview,
  type LivePerpStore,
} from "./executor-live";
import { parseLighterFeed, specToJson, type LighterFeedFileMarket, type LighterFeedRead } from "./feed-reader";
import { parseOrderBookDetails, type DepthRead, type PerpAccountPosition, type PerpAccountRead, type TxRead } from "./markets";
import { createNonceAllocator } from "./nonce";
import { instantiateSigner } from "./signer";
import { guardedStanddownApi } from "./live-handle";
import type { StanddownCallContext } from "./standdown";

// ── the ledger ──────────────────────────────────────────────────────────────

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-perp-live-"));
const isolatedCwd = path.join(scratch, "cwd");
mkdirSync(isolatedCwd);
process.env.MERRYMEN_HOME = path.join(scratch, "home");
delete process.env.DATABASE_URL;
const originalCwd = process.cwd();
const store = await import("../store");
try {
  process.chdir(isolatedCwd);
  await store.initStore();
} finally {
  process.chdir(originalCwd);
}
const raw = new DatabaseSync(path.join(process.env.MERRYMEN_HOME, "merrymen.db"));

// Nothing in this file may reach the network: the venue is the fake below.
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new Error("executor-live.test: the network is forbidden");
}) as typeof fetch;

after(() => {
  globalThis.fetch = realFetch;
  raw.close();
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

// ── the signer: the real one, with a key made for this file ────────────────

const ACCOUNT = 22149;
const KEY = LIGHTER_ROUTE_V1.apiKeyIndex;
const L1 = "0x8e93b78ef08d5e36da2e2473cd9027f8c286c176" as const;
/** An hour boundary minus half an hour, ms. */
const T0 = 1_790_706_600_000;
let clock = T0;
let skew: number | null = null;

const signer = await instantiateSigner({ now: () => clock });
const apiKey = signer.generateApiKey();
const client = signer.createClient({ accountIndex: ACCOUNT, apiKeyIndex: KEY, privateKey: apiKey.privateKey, apiPublicKey: apiKey.publicKey });

// ── the market, as the fleet feed carries it ────────────────────────────────

const DETAILS = parseOrderBookDetails(JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "orderBookDetails.perp.json"), "utf8")))!;
const BTC = DETAILS.markets.get(1)!;
const SPEC = BTC.spec;

interface Market {
  mark: bigint;
  bids: [number, number][];
  asks: [number, number][];
  priceAge: number;
  bookAge: number;
}
let market: Market;

beforeEach(() => {
  clock = T0;
  skew = null;
  market = { mark: 800_000n, bids: [[799_900, 1_000]], asks: [[800_000, 1_000]], priceAge: 1_000, bookAge: 1_000 };
});

function feed(): LighterFeedRead | null {
  const m: LighterFeedFileMarket = {
    observedAt: clock - market.priceAge,
    priceSource: "ws",
    mark: market.mark.toString(),
    index: market.mark.toString(),
    status: SPEC.status,
    spec: specToJson(SPEC),
    specObservedAt: clock - 60_000,
    takerFeePpm: 0,
    makerFeePpm: 0,
    bids: market.bids.map(([p, s]) => [String(p), String(s)]),
    asks: market.asks.map(([p, s]) => [String(p), String(s)]),
    bookObservedAt: clock - market.bookAge,
    bookSource: "ws",
  };
  return parseLighterFeed({ v: 1, observedAt: clock - 500, markets: { "1": m } }, clock);
}

// ── the venue account ───────────────────────────────────────────────────────

function position(over: Partial<PerpAccountPosition> = {}): PerpAccountPosition {
  return {
    marketId: 1,
    symbol: "BTC",
    key: "BTC-PERP" as PerpKey,
    side: null,
    baseAmount: 0n,
    avgEntryPrice: 0n,
    positionValueMicro: 0n,
    allocatedMarginMicro: 0n,
    marginMode: "isolated",
    imfBp: 5000,
    unrealizedMicro: 0n,
    realizedMicro: 0n,
    liqPrice: null,
    totalFundingPaidOutMicro: 0n,
    positionTiedOrderCount: 0,
    openOrderCount: 0,
    pendingOrderCount: 0,
    ...over,
  };
}

function venueAccount(positions: PerpAccountPosition[], collateralMicro = 50_000_000n): PerpAccountRead {
  return {
    accountIndex: ACCOUNT,
    l1Address: L1,
    collateralMicro,
    positions,
    isolatedMarginMicro: 0n,
    unrealizedMicro: 0n,
    unrealizedGainMicro: 0n,
    venueValueMicro: collateralMicro,
    totalAssetValueMicro: collateralMicro,
    transactionTimeUs: clock * 1000,
    accountType: 0,
    status: 1,
    totalOrderCount: 0,
    pendingOrderCount: 0,
    poolShareCount: 0,
    spotHoldings: [],
    spotUsdgMicro: 0n,
    pendingUnlockCount: 0,
  };
}

const flatIsolated = () => venueAccount([position()]);
const holding = (side: "long" | "short", base: bigint) =>
  venueAccount([position({ side, baseAmount: base, avgEntryPrice: 800_000n, allocatedMarginMicro: 8_000_000n, positionTiedOrderCount: 1 })]);

// ── the fake venue ──────────────────────────────────────────────────────────

interface Sent {
  txType: number;
  txInfo: string;
  txHash: string;
  exit: boolean;
  /** The ledger's row for this hash AT THE MOMENT sendTx was called. */
  rowAtSend: { status: string; tx_info: string } | undefined;
}

interface Fake {
  api: LivePerpApi;
  sent: Sent[];
  reads: { what: "account" | "book" | "tx"; auth: string | null; exit: boolean }[];
  venue: PerpAccountRead | null;
  accountAnswers: LighterResult<PerpAccountRead>[];
  book: DepthRead | null;
  sendAnswer: (tx: { txType: number; txInfo: string; txHash: string }) => LighterResult<SendTxReceipt, SendTxError>;
  txAnswer: (sent: Sent) => LighterResult<TxRead>;
}

const fail = <E,>(error: E): { ok: false; error: E; serverDateMs: null } => ({ ok: false, error, serverDateMs: null });
const notFound = (): LighterResult<TxRead> => fail({ kind: "not-found", status: 400, code: 21500, retryable: false, detail: "GET /api/v1/tx → transaction not found" } as const);

function infoOf(s: { txInfo: string }): Record<string, unknown> & { Nonce: number; Orders?: Record<string, number>[] } {
  return JSON.parse(s.txInfo) as Record<string, unknown> & { Nonce: number; Orders?: Record<string, number>[] };
}

function txRead(s: Sent, over: Partial<TxRead> = {}): TxRead {
  const info = infoOf(s);
  return {
    hash: s.txHash,
    type: s.txType,
    status: "executed",
    statusCode: 2,
    outcome: "executed",
    info: s.txInfo,
    accountIndex: ACCOUNT,
    apiKeyIndex: KEY,
    nonce: info.Nonce,
    expireAtMs: Number(info.ExpiredAt),
    blockHeight: 1,
    queuedAtMs: clock,
    executedAtMs: clock,
    appError: "",
    marketId: 1,
    orderIndex: null,
    clientOrderIndex: null,
    ...over,
  };
}

function fakeVenue(venue: PerpAccountRead | null): Fake {
  const f: Fake = {
    api: undefined as unknown as LivePerpApi,
    sent: [],
    reads: [],
    venue,
    accountAnswers: [],
    book: null,
    sendAnswer: (tx) => ({ ok: true, value: { txHash: tx.txHash, predictedExecutionMs: null, volumeQuotaRemaining: null }, serverDateMs: null }),
    txAnswer: () => notFound(),
  };
  const api: LivePerpApi = {
    account: async (who, _decimals, flags) => {
      assert.deepEqual(who, { by: "index", accountIndex: ACCOUNT });
      f.reads.push({ what: "account", auth: flags?.auth ?? null, exit: flags?.exit === true });
      const queued = f.accountAnswers.shift();
      if (queued) return queued;
      return f.venue !== null
        ? { ok: true, value: f.venue, serverDateMs: null }
        : fail({ kind: "unavailable", status: 503, retryable: true, detail: "GET /api/v1/account → HTTP 503" } as const);
    },
    orderBookOrders: async (marketId, _limit, _decimals, flags) => {
      f.reads.push({ what: "book", auth: flags?.auth ?? null, exit: flags?.exit === true });
      return f.book !== null && f.book.marketId === marketId
        ? { ok: true, value: f.book, serverDateMs: null }
        : fail({ kind: "unavailable", status: 503, retryable: true, detail: "GET /api/v1/orderBookOrders → HTTP 503" } as const);
    },
    sendTx: async (tx, flags) => {
      const row = raw.prepare("SELECT status, tx_info FROM perp_orders WHERE tx_hash = ?").get(tx.txHash) as Sent["rowAtSend"];
      const s: Sent = { txType: tx.txType, txInfo: tx.txInfo, txHash: tx.txHash, exit: flags?.exit === true, rowAtSend: row === undefined ? undefined : { ...row } };
      f.sent.push(s);
      return f.sendAnswer(tx);
    },
    tx: async (hash, flags) => {
      f.reads.push({ what: "tx", auth: flags?.auth ?? null, exit: flags?.exit === true });
      const s = f.sent.find((x) => x.txHash === hash);
      return s === undefined ? notFound() : f.txAnswer(s);
    },
  };
  f.api = api;
  return f;
}

// ── the executor under test ─────────────────────────────────────────────────

let nextAgent = 1;
const newAgent = () => `0xAbC${(nextAgent++).toString(16).padStart(37, "0")}`;

const realStore: LivePerpStore = {
  insertPerpOrderSubmitted: (s) => store.insertPerpOrderSubmitted(s),
  resolvePerpOrder: (r) => store.resolvePerpOrder(r),
  updatePerpLegStatus: (u) => store.updatePerpLegStatus(u),
  upsertPerpTransfer: (t) => store.upsertPerpTransfer(t),
  listSubmittedPerpOrders: (a, m) => store.listSubmittedPerpOrders(a, m),
};

function setup(opts: { venue?: PerpAccountRead | null; store?: Partial<LivePerpStore> } = {}): { agentId: string; f: Fake; ex: LivePerpExecutor } {
  const agentId = newAgent();
  const f = fakeVenue(opts.venue === undefined ? flatIsolated() : opts.venue);
  const ex = createLivePerpExecutor({
    agentId,
    accountIndex: ACCOUNT,
    signerClient: client,
    api: f.api,
    feed,
    store: { ...realStore, ...opts.store },
    nonces: createNonceAllocator({ agentId, accountIndex: ACCOUNT, apiKeyIndex: KEY, store, now: () => clock, venueNextNonce: async () => 0n }),
    auth: createLighterAuth({ client, now: () => clock }),
    now: () => clock,
    clockSkewMs: () => skew,
    sleep: async () => {},
  });
  return { agentId, f, ex };
}

/** 0.0002 BTC long at up to 80,400.0, stop 76,000.0 / 74,480.0, 2x — the paper tests' standard open. */
function openLong(over: Record<string, unknown> = {}): PerpOrderIntent {
  return {
    kind: "perp-order",
    venue: "lighter",
    market: "BTC-PERP",
    marketId: 1,
    effect: "open",
    side: "long",
    reduceOnly: false,
    baseAmount: 20n,
    worstPrice: 804_000n,
    markPrice: 800_000n,
    notionalUsdg: 16_080_000n,
    imfBp: 5000,
    stopTrigger: 760_000n,
    stopPrice: 744_800n,
    ...over,
  } as PerpOrderIntent;
}

function exit(side: "long" | "short", effect: "reduce" | "close", baseAmount: bigint, worstPrice?: bigint): PerpOrderIntent {
  return {
    kind: "perp-order",
    venue: "lighter",
    market: "BTC-PERP",
    marketId: 1,
    effect,
    side,
    reduceOnly: true,
    baseAmount,
    worstPrice: worstPrice ?? (side === "long" ? 792_000n : 808_000n),
    markPrice: 800_000n,
    notionalUsdg: 0n,
  } as PerpOrderIntent;
}

async function refusedWith(p: Promise<unknown>, rule: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof PerpRefused, `expected PerpRefused ${rule}, got ${String(e)}`);
    assert.equal(e.rule, rule);
    return true;
  });
}

function orderRows(agentId: string): Record<string, unknown>[] {
  return raw.prepare("SELECT * FROM perp_orders WHERE agent_id = ? AND mode = 'live' ORDER BY nonce").all(agentId.toLowerCase()) as Record<string, unknown>[];
}

function legRows(agentId: string): { role: string; client_order_index: number; venue_order_index: string | null; status: string }[] {
  return raw
    .prepare("SELECT role, client_order_index, venue_order_index, status FROM perp_order_legs WHERE agent_id = ? AND mode = 'live' ORDER BY client_order_index")
    .all(agentId.toLowerCase()) as { role: string; client_order_index: number; venue_order_index: string | null; status: string }[];
}

async function openOnce(s: ReturnType<typeof setup>, intent = openLong()) {
  const review = await s.ex.review(intent);
  return s.ex.place(intent, review, { agentId: s.agentId, decisionId: null, venue: s.f.venue });
}

// ── persist before send ─────────────────────────────────────────────────────

describe("persist before send (rule 9)", () => {
  it("the row with the exact bytes is in the ledger, submitted, before sendTx is called", async () => {
    const s = setup();
    const placed = await openOnce(s);
    assert.equal(s.f.sent.length, 1);
    const sent = s.f.sent[0]!;
    assert.deepEqual(sent.rowAtSend, { status: "submitted", tx_info: sent.txInfo });
    const [row] = orderRows(s.agentId);
    assert.equal(row?.id, placed.orderRowId);
    assert.equal(row?.tx_hash, sent.txHash);
    assert.equal(row?.tx_type, 28);
    assert.equal(row?.account_index, ACCOUNT);
    assert.equal(row?.api_key_index, KEY);
    assert.equal(BigInt(row?.nonce as number), placed.nonce);
    assert.equal(row?.expired_at, infoOf(sent).ExpiredAt, "ExpiredAt is the signer's, parsed from the bytes");
  });

  it("a ledger that refuses the write sends nothing — PerpNotRecorded, whatever the store threw", async () => {
    const s = setup();
    raw.exec("CREATE TRIGGER fail_live_order BEFORE INSERT ON perp_orders BEGIN SELECT RAISE(ABORT, 'injected perp_orders failure'); END");
    try {
      await assert.rejects(openOnce(s), (e: unknown) => e instanceof store.PerpNotRecorded);
    } finally {
      raw.exec("DROP TRIGGER fail_live_order");
    }
    assert.equal(s.f.sent.length, 0, "nothing reached sendTx");
    assert.deepEqual(orderRows(s.agentId), []);

    const t = setup({ store: { insertPerpOrderSubmitted: () => Promise.reject(new Error("disk I/O error")) } });
    await assert.rejects(t.ex.cancelMarket(1), (e: unknown) => e instanceof store.PerpNotRecorded && e.txHash !== null);
    assert.equal(t.f.sent.length, 0);
  });
});

// ── the open ────────────────────────────────────────────────────────────────

describe("an open is one grouped tx carrying its own stop (rule 7)", () => {
  it("OTO: IOC entry + a reduce-only STOP_LOSS child, BaseAmount 0, expiring in 28 days; COIs are nonce × 8 + leg", async () => {
    const s = setup();
    const placed = await openOnce(s);
    assert.equal(placed.status, "submitted");
    assert.equal(placed.filledBase, 0n, "the venue fills; reconcile books what it filled");
    const sent = s.f.sent[0]!;
    assert.equal(sent.txType, 28);
    assert.equal(sent.exit, false);
    const info = infoOf(sent);
    assert.equal(info.GroupingType, 1, "OTO without a take-profit");
    assert.equal(BigInt(info.Nonce), placed.nonce);
    const [entry, sl] = info.Orders!;
    assert.equal(info.Orders!.length, 2);
    assert.deepEqual(
      { t: entry!.Type, tif: entry!.TimeInForce, ro: entry!.ReduceOnly, ask: entry!.IsAsk, base: entry!.BaseAmount, px: entry!.Price, trig: entry!.TriggerPrice },
      { t: 1, tif: 0, ro: 0, ask: 0, base: 20, px: 804_000, trig: 0 },
    );
    assert.deepEqual(
      { t: sl!.Type, tif: sl!.TimeInForce, ro: sl!.ReduceOnly, ask: sl!.IsAsk, base: sl!.BaseAmount, px: sl!.Price, trig: sl!.TriggerPrice, exp: sl!.OrderExpiry },
      { t: 2, tif: 0, ro: 1, ask: 1, base: 0, px: 744_800, trig: 760_000, exp: T0 + LIVE_STOP_EXPIRY_MS },
    );
    assert.equal(LIVE_STOP_EXPIRY_MS, 28 * 86_400_000);
    const nonce = placed.nonce!;
    assert.equal(BigInt(entry!.ClientOrderIndex!), perpCoi(nonce, PERP_LEG.entry));
    assert.equal(BigInt(sl!.ClientOrderIndex!), perpCoi(nonce, PERP_LEG.sl));
    assert.deepEqual(
      legRows(s.agentId).map((l) => [l.role, BigInt(l.client_order_index)]),
      [
        ["entry", nonce * 8n],
        ["sl", nonce * 8n + 1n],
      ],
    );
    const [row] = orderRows(s.agentId);
    assert.deepEqual([row?.effect, row?.reduce_only, row?.status, row?.worst_notional_micro], ["open", 0, "submitted", "16080000"]);
  });

  it("OTOCO with a take-profit: the TP child is reduce-only, BaseAmount 0, and expires with the stop", async () => {
    const s = setup();
    const placed = await openOnce(s, openLong({ takeTrigger: 880_000n, takePrice: 862_400n }));
    const info = infoOf(s.f.sent[0]!);
    assert.equal(info.GroupingType, 3);
    const tp = info.Orders![2]!;
    assert.deepEqual(
      { t: tp.Type, ro: tp.ReduceOnly, ask: tp.IsAsk, base: tp.BaseAmount, px: tp.Price, trig: tp.TriggerPrice, exp: tp.OrderExpiry },
      { t: 4, ro: 1, ask: 1, base: 0, px: 862_400, trig: 880_000, exp: info.Orders![1]!.OrderExpiry },
    );
    assert.equal(BigInt(tp.ClientOrderIndex!), placed.nonce! * 8n + 2n);
    assert.deepEqual(legRows(s.agentId).map((l) => l.role), ["entry", "sl", "tp"]);
  });

  it("is refused unless the venue reads the market isolated at exactly the asserted IMF, flat — nothing reserved, signed or sent", async () => {
    for (const [venue, rule] of [
      [venueAccount([position({ marginMode: "cross", imfBp: 5000 })]), "perp-leverage-unset"],
      [venueAccount([]), "perp-leverage-unset"],
      [venueAccount([position({ imfBp: 3334 })]), "perp-leverage-mismatch"],
      [holding("long", 20n), "perp-add-to-position"],
    ] as const) {
      const s = setup({ venue });
      await refusedWith(openOnce(s), rule);
      assert.equal(s.f.sent.length, 0, rule);
      assert.equal(await store.getNonceHighWater(s.agentId, "live"), null, `${rule}: no nonce was spent`);
    }
    // No venue read in the context and none to be had: unread is not "flat".
    const u = setup({ venue: null });
    const intent = openLong();
    const review = await u.ex.review(intent);
    await refusedWith(u.ex.place(intent, review, { agentId: u.agentId, decisionId: null }), "perp-unpriced");
    assert.equal(u.f.sent.length, 0);
  });

  it("signs only the terms that were reviewed, while they are fresh", async () => {
    const s = setup();
    const intent = openLong();
    const review = await s.ex.review(intent);
    await refusedWith(s.ex.place(openLong({ stopTrigger: 750_000n }), review, { agentId: s.agentId, decisionId: null, venue: s.f.venue }), "perp-order-malformed");
    await refusedWith(s.ex.place(intent, review, { agentId: newAgent(), decisionId: null, venue: s.f.venue }), "perp-order-malformed");
    clock += 31_000;
    market.priceAge = 0;
    market.bookAge = 0;
    await refusedWith(s.ex.place(intent, review, { agentId: s.agentId, decisionId: null, venue: s.f.venue }), "perp-unpriced");
    assert.equal(s.f.sent.length, 0);
  });
});

// ── review ──────────────────────────────────────────────────────────────────

describe("review(): the feed's fresh book, else one authenticated venue read", () => {
  it("prices an open from the feed, judging the worst of worst price and mark, with the margin and liquidation it would carry", async () => {
    const s = setup();
    const r: LivePerpReview = await s.ex.review(openLong());
    assert.equal(r.bookSource, "feed");
    assert.deepEqual(s.f.reads, [], "a fresh feed book needs no venue read");
    assert.equal(r.expectedFill, "full");
    assert.equal(r.avgPrice, 800_000n);
    assert.equal(r.worstNotionalMicro, notionalMicro(20n, 804_000n, SPEC, "ceil"));
    assert.equal(r.marginNeededMicro, 8_040_000n, "the worst notional at the asserted 50% IMF, no fee");
    const am = (notionalMicro(20n, 804_000n, SPEC, "floor") * 5000n) / 10_000n;
    assert.equal(r.liqPriceEstimate, isolatedLiqPrice({ side: "long", entryPrice: 804_000n, baseAmount: 20n, allocatedMarginMicro: am, mmfBp: SPEC.mmfBp, spec: SPEC }));
  });

  it("reads the venue's book once when the feed's is older than 10 s — exit-flagged for an exit", async () => {
    market.bookAge = 20_000;
    const s = setup({ venue: holding("long", 30n) });
    s.f.book = { marketId: 1, bids: [{ price: 799_800n, baseAmount: 10n }, { price: 799_800n, baseAmount: 10n }, { price: 799_700n, baseAmount: 50n }], asks: [{ price: 800_100n, baseAmount: 100n }] };
    const o = await s.ex.review(openLong());
    assert.equal(o.bookSource, "venue");
    assert.equal(o.avgPrice, 800_100n);
    assert.deepEqual(s.f.reads.map((x) => [x.what, x.auth !== null, x.exit]), [["book", true, false]]);

    s.f.reads.length = 0;
    const x = await s.ex.review(exit("long", "close", 30n));
    assert.equal(x.bookSource, "venue");
    assert.equal(x.effect, "close");
    assert.equal(x.baseAmount, 30n);
    // One row per ORDER at the venue: the two 799,800 orders are one level to a taker.
    assert.deepEqual(x.levels, [
      { price: 799_800n, baseAmount: 20n },
      { price: 799_700n, baseAmount: 10n },
    ]);
    assert.deepEqual(s.f.reads.map((r) => [r.what, r.auth !== null, r.exit]), [
      ["account", true, true],
      ["book", true, true],
    ]);
  });

  it("refuses an open it cannot price; still reviews an exit whose book is unread", async () => {
    market.priceAge = 40_000;
    const s = setup({ venue: holding("long", 30n) });
    await refusedWith(s.ex.review(openLong()), "perp-unpriced");
    assert.deepEqual(s.f.reads, [], "stale prices refuse before any read");
    market.priceAge = 1_000;
    market.bookAge = 20_000;
    await refusedWith(s.ex.review(openLong()), "perp-unpriced");
    const x = await s.ex.review(exit("long", "close", 30n));
    assert.deepEqual([x.bookSource, x.expectedFill, x.baseAmount], ["unread", "none", 30n]);
    // An unread ACCOUNT is different: an exit cannot be sized without it.
    s.f.venue = null;
    await refusedWith(s.ex.review(exit("long", "close", 30n)), "perp-unpriced");
  });
});

// ── what an answer means to the row ─────────────────────────────────────────

describe("sendTx answers (rule 9)", () => {
  it("carries a persisted owner deadline through an awaited replay fence and preserves legacy semantics", async () => {
    const s = setup({ venue: holding("long", 30n) });
    s.f.sendAnswer = () => fail({ kind: "unavailable", status: null, retryable: true, detail: "unknown" } as const);
    const intent = exit("long", "close", 30n), deadline = clock + 5_000;
    const review = await s.ex.review(intent);
    await s.ex.place(intent, review, { agentId: s.agentId, decisionId: null, notAfterMs: deadline });
    const [row] = await store.listSubmittedPerpOrders(s.agentId, "live");
    assert.equal(row!.sendNotAfterMs, deadline);
    assert.ok(row!.expiredAt! > deadline, "the local owner expiry is earlier than the signed transaction expiry");
    const guarded = guardedStanddownApi({ api: s.f.api as LighterApi, now: () => clock,
      beforeSend: async () => { clock = deadline; } }, new AsyncLocalStorage<StanddownCallContext>());
    const deps = { agentId: s.agentId, accountIndex: ACCOUNT, api: guarded, now: () => clock, clockSkewMs: () => skew };
    assert.equal((await resendPersisted(deps, row!)).sent, false, "expiry during the awaited lease check still withholds bytes");
    assert.equal(s.f.sent.length, 1);
    assert.equal((await resendPersisted({ ...deps, api: s.f.api }, row!)).sent, false, "a restarted sender reads the stored bound");
    for (const sendNotAfterMs of [undefined, null]) {
      assert.equal((await resendPersisted({ ...deps, api: s.f.api }, { ...row!, sendNotAfterMs })).sent, true,
        "genuinely legacy rows retain their original signed-expiry behavior");
    }
    assert.equal(s.f.sent.length, 3);
  });

  it("a timeout leaves the row submitted; the re-send sends the identical persisted bytes, and never past ExpiredAt", async () => {
    const s = setup();
    s.f.sendAnswer = () => fail({ kind: "unavailable", status: null, retryable: true, detail: "POST /api/v1/sendTx timed out after 5000 ms" } as const);
    const placed = await openOnce(s);
    assert.equal(placed.status, "submitted");
    assert.deepEqual(placed.tx.send, { kind: "unknown", detail: "POST /api/v1/sendTx timed out after 5000 ms" });
    assert.equal(orderRows(s.agentId)[0]?.status, "submitted");

    const [row] = await store.listSubmittedPerpOrders(s.agentId, "live");
    assert.ok(row);
    s.f.sendAnswer = (tx) => ({ ok: true, value: { txHash: tx.txHash, predictedExecutionMs: null, volumeQuotaRemaining: null }, serverDateMs: null });
    const again = await s.ex.resendPersisted(row);
    assert.equal(again.sent, true);
    assert.equal(s.f.sent.length, 2);
    const [first, second] = s.f.sent;
    assert.deepEqual([second!.txType, second!.txHash, second!.txInfo], [first!.txType, first!.txHash, first!.txInfo], "the same bytes, never a re-signature");
    assert.equal(orderRows(s.agentId)[0]?.status, "submitted", "a re-send resolves nothing");

    const deps = { agentId: s.agentId, accountIndex: ACCOUNT, api: s.f.api, now: () => clock, clockSkewMs: () => skew };
    // Never past ExpiredAt — by the LATER of the two clocks.
    clock = row.expiredAt! - 1_000;
    skew = 2_000;
    assert.equal((await resendPersisted(deps, row)).sent, false, "the venue's clock is already past it");
    skew = -5_000;
    assert.equal((await resendPersisted(deps, row)).sent, true, "ours is the later clock, and it is not");
    skew = null;
    assert.equal((await resendPersisted(deps, row)).sent, true, "unmeasured skew: our clock alone");
    clock = row.expiredAt!;
    assert.equal((await resendPersisted(deps, row)).sent, false);
    clock = T0;
    // Only a submitted row, only bytes that say what the row says.
    assert.equal((await resendPersisted(deps, { ...row, status: "rejected" })).sent, false);
    const forged = row.txInfo!.replace(`"Nonce":${row.nonce}`, `"Nonce":${row.nonce! + 1}`);
    assert.notEqual(forged, row.txInfo);
    assert.equal((await resendPersisted(deps, { ...row, txInfo: forged })).sent, false);
    assert.equal((await resendPersisted({ ...deps, agentId: newAgent() }, row)).sent, false);
    assert.equal(s.f.sent.length, 4, "the first send, the executor's re-send and the two in time");
  });

  it("a refusal an executed tx would also produce (21104, 21728) stays submitted; any other refusal of a first send is rejected", async () => {
    for (const code of [21104, 21728]) {
      const s = setup();
      s.f.sendAnswer = () => fail({ kind: "refused-send", status: 400, code, retryable: false, maybeExecuted: true, detail: `code ${code}` } as const);
      const placed = await openOnce(s);
      assert.equal(placed.status, "submitted", String(code));
      assert.equal(placed.tx.send.kind, "refused");
      assert.equal(orderRows(s.agentId)[0]?.status, "submitted", String(code));
    }
    const s = setup();
    s.f.sendAnswer = () => fail({ kind: "refused-send", status: 400, code: 21733, retryable: false, maybeExecuted: false, detail: "code 21733" } as const);
    const placed = await openOnce(s);
    assert.equal(placed.status, "rejected");
    assert.deepEqual([orderRows(s.agentId)[0]?.status, orderRows(s.agentId)[0]?.filled_base], ["rejected", "0"]);
  });

  it("stopped by our own budget it never left: rejected. Refused by the venue's limiter: unknown, submitted", async () => {
    const s = setup();
    s.f.sendAnswer = () => fail({ kind: "rate-limited", source: "budget", status: null, retryAfterMs: 5_000, retryable: true, detail: "40 requests in the last minute" } as const);
    const a = await s.ex.cancelMarket(1);
    assert.deepEqual([a.rowStatus, a.send.kind], ["rejected", "not-sent"]);
    s.f.sendAnswer = () => fail({ kind: "rate-limited", source: "venue", status: 429, retryAfterMs: 60_000, retryable: true, detail: "HTTP 429" } as const);
    const b = await s.ex.cancelMarket(1);
    assert.deepEqual([b.rowStatus, b.send.kind], ["submitted", "unknown"]);
  });

  it("/tx by hash: executed records the entry's venue order index; status 0 and an app error are final refusals; the poll is bounded", async () => {
    const s = setup();
    s.f.txAnswer = (sent) => {
      const nonce = BigInt(infoOf(sent).Nonce);
      return { ok: true, value: txRead(sent, { orderIndex: "562949953421313", clientOrderIndex: Number(nonce * 8n) }), serverDateMs: null };
    };
    const placed = await openOnce(s);
    assert.deepEqual([placed.status, placed.tx.rowStatus, placed.tx.venueOrderIndex], ["submitted", "executed", "562949953421313"]);
    assert.equal(orderRows(s.agentId)[0]?.status, "executed");
    const legs = legRows(s.agentId);
    assert.deepEqual(legs.map((l) => [l.role, l.venue_order_index, l.status]), [
      ["entry", "562949953421313", "submitted"],
      ["sl", null, "submitted"],
    ]);

    // A client order index that is not one of ours is never written onto a leg.
    const t = setup();
    t.f.txAnswer = (sent) => ({ ok: true, value: txRead(sent, { orderIndex: "562949953421399", clientOrderIndex: 7 }), serverDateMs: null });
    const p2 = await openOnce(t);
    assert.equal(p2.tx.venueOrderIndex, null);
    assert.ok(legRows(t.agentId).every((l) => l.venue_order_index === null));

    for (const [over, want] of [
      [{ status: "failed", statusCode: 0, outcome: "rejected" }, "rejected"],
      [{ outcome: "app-error", appError: "not enough margin" }, "app-error"],
    ] as const) {
      const u = setup();
      u.f.txAnswer = (sent) => ({ ok: true, value: txRead(sent, over as Partial<TxRead>), serverDateMs: null });
      const p = await openOnce(u);
      assert.deepEqual([p.status, p.tx.rowStatus, orderRows(u.agentId)[0]?.status], ["rejected", want, want]);
    }

    const v = setup();
    v.f.txAnswer = (sent) => ({ ok: true, value: txRead(sent, { status: "pending", statusCode: 1, outcome: "pending" }), serverDateMs: null });
    const p3 = await openOnce(v);
    assert.deepEqual([p3.tx.rowStatus, p3.tx.send], ["submitted", { kind: "accepted", tx: "pending" }]);
    assert.equal(v.f.reads.filter((r) => r.what === "tx").length, LIVE_TX_POLL_DELAYS_MS.length, "a bounded poll");

    // A /tx answer about another nonce at our hash is no answer.
    const w = setup();
    w.f.txAnswer = (sent) => ({ ok: true, value: txRead(sent, { nonce: infoOf(sent).Nonce + 1 }), serverDateMs: null });
    const p4 = await openOnce(w);
    assert.equal(p4.tx.rowStatus, "submitted");
  });
});

// ── exits ───────────────────────────────────────────────────────────────────

describe("exits are clamped to the venue position and sell what is held (rule 8)", () => {
  it("a close is the full venue size, reduce-only IOC, IsAsk opposite the long held", async () => {
    const s = setup({ venue: holding("long", 30n) });
    const intent = exit("long", "close", 50n);
    const review = await s.ex.review(intent);
    const placed = await s.ex.place(intent, review, { agentId: s.agentId, decisionId: null, venue: s.f.venue });
    const sent = s.f.sent[0]!;
    assert.equal(sent.txType, 14);
    assert.equal(sent.exit, true);
    const info = infoOf(sent);
    assert.deepEqual(
      { base: info.BaseAmount, ask: info.IsAsk, ro: info.ReduceOnly, t: info.Type, tif: info.TimeInForce, px: info.Price, trig: info.TriggerPrice, exp: info.OrderExpiry },
      { base: 30, ask: 1, ro: 1, t: 1, tif: 0, px: 792_000, trig: 0, exp: 0 },
    );
    assert.equal(BigInt(info.ClientOrderIndex as number), perpCoi(placed.nonce!, PERP_LEG.close));
    const [row] = orderRows(s.agentId);
    assert.deepEqual([row?.effect, row?.reduce_only], ["close", 1]);
    assert.deepEqual(legRows(s.agentId).map((l) => l.role), ["close"]);
  });

  it("a short is bought back; a reduce stays a reduce unless it would leave a stub under the market minimum", async () => {
    const s = setup({ venue: holding("short", 30n) });
    // 10 of 30: the 20 left is 16 USDG at 80,000 — the market minimum exactly.
    let intent = exit("short", "reduce", 10n);
    await s.ex.place(intent, await s.ex.review(intent), { agentId: s.agentId, decisionId: null, venue: s.f.venue });
    let info = infoOf(s.f.sent[0]!);
    assert.deepEqual([info.IsAsk, info.BaseAmount, info.ReduceOnly], [0, 10, 1]);
    // 15 of 30: the 15 left (12 USDG) could not be closed on its own — the whole position goes.
    intent = exit("short", "reduce", 15n);
    await s.ex.place(intent, await s.ex.review(intent), { agentId: s.agentId, decisionId: null });
    info = infoOf(s.f.sent[1]!);
    assert.deepEqual([info.IsAsk, info.BaseAmount], [0, 30]);
    assert.deepEqual(orderRows(s.agentId).map((r) => r.effect), ["reduce", "close"]);
    assert.equal(s.f.reads.filter((r) => r.what === "account" && r.exit).length, 3, "with no read in the context, place() reads the venue itself (exit-flagged)");
  });

  it("names the side HELD: a side that is not the position's, or no position at all, is refused and nothing is sent", async () => {
    const s = setup({ venue: holding("long", 30n) });
    const intent = exit("long", "close", 30n);
    const review = await s.ex.review(intent);
    await refusedWith(s.ex.place(exit("short", "close", 30n), { ...review, side: "short" }, { agentId: s.agentId, decisionId: null, venue: s.f.venue }), "perp-side-mismatch");
    await refusedWith(s.ex.place(intent, review, { agentId: s.agentId, decisionId: null, venue: flatIsolated() }), "perp-no-position");
    assert.equal(s.f.sent.length, 0);
  });
});

// ── withdrawals ─────────────────────────────────────────────────────────────

describe("a withdrawal (rule 2: it can only pay the account's own address)", () => {
  it("never exceeds the free cross collateral — refused before a nonce is spent", async () => {
    const s = setup();
    await refusedWith(s.ex.requestWithdraw(50_000_001n, 50_000_000n, { initiator: "agent" }), "perp-withdraw-exceeds-free");
    await refusedWith(s.ex.requestWithdraw(1n, 0n, { initiator: "agent" }), "perp-withdraw-exceeds-free");
    await refusedWith(s.ex.requestWithdraw(0n, 50_000_000n, { initiator: "agent" }), "perp-order-malformed");
    assert.equal(s.f.sent.length, 0);
    assert.equal(await store.getNonceHighWater(s.agentId, "live"), null);
  });

  it("writes its order row and its transfer row in one transaction, then sends a secure withdraw once", async () => {
    const s = setup();
    const tx = await s.ex.requestWithdraw(20_000_000n, 50_000_000n, { initiator: "owner" });
    assert.equal(s.f.sent.length, 1);
    const sent = s.f.sent[0]!;
    assert.equal(sent.txType, 13);
    assert.equal(sent.exit, true);
    const info = infoOf(sent);
    assert.deepEqual([info.FromAccountIndex, info.AssetIndex, info.RouteType, info.Amount], [ACCOUNT, 3, 0, 20_000_000]);
    const [row] = orderRows(s.agentId);
    assert.deepEqual([row?.effect, row?.status, row?.market_id], ["withdraw", "submitted", null]);
    const transfers = raw.prepare("SELECT * FROM perp_transfers WHERE agent_id = ? AND mode = 'live'").all(s.agentId.toLowerCase()) as Record<string, unknown>[];
    assert.equal(transfers.length, 1);
    assert.deepEqual(
      [transfers[0]!.direction, transfers[0]!.amount_micro, transfers[0]!.initiator, transfers[0]!.state, transfers[0]!.venue_tx_hash, transfers[0]!.order_id],
      ["withdraw", "20000000", "owner", "submitted", sent.txHash, tx.orderRowId],
    );
    // A second request while the first has no outcome: refused, not signed.
    await refusedWith(s.ex.requestWithdraw(1_000_000n, 30_000_000n, { initiator: "owner" }), "perp-withdraw-in-flight");
    assert.equal(s.f.sent.length, 1);

    // A transfer row that cannot be written takes its order row down with it.
    const t = setup();
    raw.exec("CREATE TRIGGER fail_live_transfer BEFORE INSERT ON perp_transfers BEGIN SELECT RAISE(ABORT, 'injected perp_transfers failure'); END");
    try {
      await assert.rejects(t.ex.requestWithdraw(20_000_000n, 50_000_000n, { initiator: "agent" }), (e: unknown) => e instanceof store.PerpNotRecorded);
    } finally {
      raw.exec("DROP TRIGGER fail_live_transfer");
    }
    assert.deepEqual(orderRows(t.agentId), [], "no order row without its transfer");
    assert.equal(t.f.sent.length, 0);
  });

  it("moves its transfer with its order: executed at the venue is money in transit; a refused first send is a failed transfer", async () => {
    const s = setup();
    s.f.txAnswer = (sent) => ({ ok: true, value: txRead(sent, { marketId: null }), serverDateMs: null });
    const tx = await s.ex.requestWithdraw(5_000_000n, 50_000_000n, { initiator: "agent" });
    assert.equal(tx.rowStatus, "executed");
    const state = (a: string) => (raw.prepare("SELECT state FROM perp_transfers WHERE agent_id = ? AND mode = 'live'").get(a.toLowerCase()) as { state: string }).state;
    assert.equal(state(s.agentId), "executed");

    const t = setup();
    t.f.sendAnswer = () => fail({ kind: "refused-send", status: 400, code: 21120, retryable: false, maybeExecuted: false, detail: "code 21120" } as const);
    const r = await t.ex.requestWithdraw(5_000_000n, 50_000_000n, { initiator: "agent" });
    assert.equal(r.rowStatus, "rejected");
    assert.equal(state(t.agentId), "failed");
  });
});

// ── leverage ────────────────────────────────────────────────────────────────

describe("leverage is venue state, set only while the market is flat (rule 6)", () => {
  it("signs UpdateLeverage isolated at the IMF and resolves it by hash", async () => {
    const venue = venueAccount([position({ marginMode: "cross", imfBp: 5000 })]);
    const s = setup({ venue });
    s.f.txAnswer = (sent) => ({ ok: true, value: txRead(sent), serverDateMs: null });
    const tx = await s.ex.ensureLeverage(1, 5000, venue);
    assert.ok("rowStatus" in tx);
    assert.equal(tx.rowStatus, "executed");
    const sent = s.f.sent[0]!;
    assert.equal(sent.txType, 20);
    assert.equal(sent.exit, false);
    const info = infoOf(sent);
    assert.deepEqual([info.MarketIndex, info.InitialMarginFraction, info.MarginMode], [1, 5000, 1]);
    assert.deepEqual([orderRows(s.agentId)[0]?.effect, orderRows(s.agentId)[0]?.status], ["leverage", "executed"]);
  });

  it("is refused while anything is held or resting in the market, or a tx of ours on it has no outcome; a no-op when already set", async () => {
    for (const p of [
      position({ marginMode: "cross", side: "long", baseAmount: 20n, avgEntryPrice: 800_000n }),
      position({ marginMode: "cross", positionTiedOrderCount: 1 }),
      position({ marginMode: "cross", openOrderCount: 1 }),
      position({ marginMode: "cross", pendingOrderCount: 2 }),
    ]) {
      const s = setup();
      await refusedWith(s.ex.ensureLeverage(1, 5000, venueAccount([p])), "perp-leverage-busy");
      assert.equal(s.f.sent.length, 0);
    }
    const s = setup();
    assert.deepEqual(await s.ex.ensureLeverage(1, 5000, flatIsolated()), { kind: "already", detail: "BTC-PERP already reads isolated at 5000 bp" });
    assert.equal(s.f.sent.length, 0);
    // Our own cancel whose send timed out: the venue read may not show it yet.
    s.f.sendAnswer = () => fail({ kind: "unavailable", status: null, retryable: true, detail: "timed out" } as const);
    await s.ex.cancelMarket(1);
    await refusedWith(s.ex.ensureLeverage(1, 3334, flatIsolated()), "perp-leverage-busy");
    assert.equal(s.f.sent.length, 1);
  });
});

// ── the protective stop ─────────────────────────────────────────────────────

describe("cancels", () => {
  it("are market-scoped by default; the account-wide one needs its literal acknowledgement", async () => {
    const s = setup();
    await s.ex.cancelMarket(1);
    let info = infoOf(s.f.sent[0]!);
    assert.deepEqual([s.f.sent[0]!.txType, info.TimeInForce, info.L2TxAttributes], [16, 0, { "4": 1, "5": 1 }]);
    await refusedWith(s.ex.cancelAllAccountWide({ acknowledge: "yes" as "removes-every-resting-stop" }), "perp-order-malformed");
    assert.equal(s.f.sent.length, 1);
    await s.ex.cancelAllAccountWide({ acknowledge: "removes-every-resting-stop" });
    info = infoOf(s.f.sent[1]!);
    assert.deepEqual([s.f.sent[1]!.txType, info.L2TxAttributes, s.f.sent[1]!.exit], [16, { "4": 1 }, true]);
    assert.deepEqual(orderRows(s.agentId).map((r) => [r.effect, r.market_id]), [
      ["cancel", 1],
      ["cancel", null],
    ]);
  });
});

describe("replaceStop: a standalone position-tied stop", () => {
  it("is a reduce-only STOP_LOSS with BaseAmount 0 and a 28-day expiry, on the side that closes what is held", async () => {
    const s = setup({ venue: holding("long", 30n) });
    const tx = await s.ex.replaceStop(1, "long", 760_000n, 744_800n);
    const sent = s.f.sent[0]!;
    assert.deepEqual([sent.txType, sent.exit], [14, true]);
    const info = infoOf(sent);
    assert.deepEqual(
      { t: info.Type, base: info.BaseAmount, ro: info.ReduceOnly, ask: info.IsAsk, trig: info.TriggerPrice, px: info.Price, exp: info.OrderExpiry },
      { t: 2, base: 0, ro: 1, ask: 1, trig: 760_000, px: 744_800, exp: T0 + LIVE_STOP_EXPIRY_MS },
    );
    assert.equal(BigInt(info.ClientOrderIndex as number), perpCoi(tx.nonce, PERP_LEG.sl));
    const [row] = orderRows(s.agentId);
    assert.deepEqual([row?.effect, row?.reduce_only, row?.reason, row?.worst_notional_micro], ["close", 1, "protective-stop", "0"]);
    assert.deepEqual(legRows(s.agentId).map((l) => l.role), ["sl"]);
  });

  it("is refused on the winning side of a fresh mark — that is a close, not a stop", async () => {
    const s = setup({ venue: holding("long", 30n) });
    await refusedWith(s.ex.replaceStop(1, "long", 810_000n, 800_000n), "perp-stop-required");
    await refusedWith(s.ex.replaceStop(1, "short", 790_000n, 800_000n), "perp-stop-required");
    assert.equal(s.f.sent.length, 0);
  });
});

// ── nonces and order ────────────────────────────────────────────────────────

describe("sends are serialised in nonce order", () => {
  it("our own unresolved rows are judged inside the send lock: of two concurrent opens or withdrawals, one is signed", async () => {
    const s = setup();
    const intent = openLong();
    const review = await s.ex.review(intent);
    const ctx = { agentId: s.agentId, decisionId: null, venue: s.f.venue };
    const opens = await Promise.allSettled([s.ex.place(intent, review, ctx), s.ex.place(intent, review, ctx)]);
    assert.deepEqual(opens.map((o) => o.status).sort(), ["fulfilled", "rejected"]);
    const lost = opens.find((o) => o.status === "rejected") as PromiseRejectedResult;
    assert.ok(lost.reason instanceof PerpRefused && lost.reason.rule === "perp-close-in-flight");
    const w = await Promise.allSettled([
      s.ex.requestWithdraw(1_000_000n, 50_000_000n, { initiator: "agent" }),
      s.ex.requestWithdraw(1_000_000n, 50_000_000n, { initiator: "agent" }),
    ]);
    const refusedW = w.find((o) => o.status === "rejected") as PromiseRejectedResult | undefined;
    assert.ok(refusedW?.reason instanceof PerpRefused && refusedW.reason.rule === "perp-withdraw-in-flight");
    assert.equal(s.f.sent.length, 2, "one open, one withdrawal");
  });


  it("concurrent callers get strictly increasing nonces, sent in that order, each on its own row", async () => {
    const s = setup({ venue: holding("long", 30n) });
    const results = await Promise.all([
      s.ex.cancelMarket(1),
      s.ex.replaceStop(1, "long", 760_000n, 744_800n),
      s.ex.cancelMarket(1),
      s.ex.requestWithdraw(1_000_000n, 50_000_000n, { initiator: "agent" }),
      s.ex.cancelOrder(1, 562_949_953_421_313n),
      s.ex.cancelMarket(1),
    ]);
    const nonces = s.f.sent.map((x) => BigInt(infoOf(x).Nonce));
    assert.equal(nonces.length, 6);
    for (let i = 1; i < nonces.length; i++) assert.ok(nonces[i]! > nonces[i - 1]!, `send ${i} carries a larger nonce than send ${i - 1}`);
    // Each caller got back the nonce of the tx that went out for it (a
    // withdrawal reads the ledger first, so it may queue behind later callers).
    assert.deepEqual(
      results.map((r) => r.nonce).sort((a, b) => (a < b ? -1 : 1)),
      nonces,
    );
    for (const r of results) {
      const out = s.f.sent.find((x) => x.txHash === r.txHash);
      assert.ok(out, "every result names a tx that was sent");
      assert.equal(BigInt(infoOf(out).Nonce), r.nonce);
    }
    assert.equal(orderRows(s.agentId).length, 6);
    assert.equal(await store.getNonceHighWater(s.agentId, "live"), nonces[5]);
    // Rows keep the COI rule whatever order they were asked in.
    const stop = legRows(s.agentId)[0]!;
    assert.equal(BigInt(stop.client_order_index), (results[1] as { nonce: bigint }).nonce * 8n + 1n);
  });
});

// ── the account ─────────────────────────────────────────────────────────────

describe("account(): the one authenticated read", () => {
  it("carries a token, and an auth refusal forces exactly one fresh token", async () => {
    const s = setup();
    const refusal: LighterApiError = { kind: "rejected", status: 400, code: 20001, retryable: false, detail: "GET /api/v1/account → HTTP 400 code 20001: auth required for main accounts" };
    s.f.accountAnswers.push(fail(refusal));
    const r = await s.ex.account();
    assert.equal(r.ok, true);
    const [a, b] = s.f.reads;
    assert.equal(s.f.reads.length, 2);
    assert.ok(a?.auth && b?.auth);
    assert.notEqual(a?.auth, b?.auth, "the retry carries a new token");
    // Twice refused: an unread account, never an empty one.
    s.f.accountAnswers.push(fail(refusal), fail(refusal));
    const u = await s.ex.account({ exit: true });
    assert.equal(u.ok, false);
    assert.equal(s.f.reads.length, 4);
    assert.ok(s.f.reads.slice(2).every((x) => x.exit));
  });
});
