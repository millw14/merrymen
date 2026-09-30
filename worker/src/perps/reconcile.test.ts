/**
 * THE LIVE RECONCILER against a real sqlite ledger and the REAL api.ts client,
 * whose transport answers from the venue's own captures (fixtures/).
 *
 * What is real here: the store (store.ts's perp writers, their idempotence and
 * journal), the REST client (auth header, bounds, the error taxonomy, the
 * not-found mapping) and every parser in markets.ts. What is faked is only the
 * wire — and every body on it is a live capture RE-LABELLED to our account:
 * the trade is `recentTrades.1.json`'s first (tx 43de174b's own fill), the tx
 * is `tx.43de174b.json`, the account `account.22149.isolated.json`, the
 * orders, funding and withdrawals the synthetic captures of the auth-gated
 * endpoints. Re-labelling changes identities (account, key, client order
 * index, hash, times) and never the venue's shapes or amounts, except where a
 * test says so (a liquidation's `type`, a moved collateral).
 *
 * Each block pins one clause of the contract (docs/perps.md rules 9, 10, 11,
 * 12, 16 and the Ledger's "Hosted" bullet): each resolution branch of a
 * submitted row including an unmeasured clock, a self-trade as two fills, a
 * forced fill's provenance, a venue fill nobody signed, orphan adoption after
 * a wipe at the venue's own time, idempotent re-ingest (no duplicate, one
 * journal entry), funding and transfers by venue identity, the positions
 * cache, and the venue-delta identity.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { wrapSqlite } from "../db";
import { createLighterApi, resetLighterApiState, type LighterFetch } from "./api";
import { parseAccount, parseOrderBookDetails } from "./markets";
import {
  DELTA_DOUBTFUL_AFTER,
  EXPIRY_GRACE_MS,
  createLiveReconciler,
  isContinuous,
  perpFeeMicro,
  perpFillEconomics,
  venueDeltaCheck,
  type LiveReconcileStore,
} from "./reconcile";
import { adoptedOrderId, insertAdoptedPerpOrderRow, perpNonceRecordedRow } from "./reconcile-ledger";

// ── an isolated ledger ──────────────────────────────────────────────────────

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-perp-reconcile-"));
const isolatedCwd = path.join(scratch, "cwd");
mkdirSync(isolatedCwd);
process.env.MERRYMEN_HOME = path.join(scratch, "home");
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
// A second connection to the same file: the two statements store.ts will wire
// from reconcile-ledger.ts run here, and the tests inspect rows through it.
const raw = new DatabaseSync(path.join(process.env.MERRYMEN_HOME, "merrymen.db"));
raw.exec("PRAGMA busy_timeout = 5000");
const rawDb = wrapSqlite(raw);

after(() => {
  raw.close();
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const ledger: LiveReconcileStore = {
  listSubmittedPerpOrders: store.listSubmittedPerpOrders,
  resolvePerpOrder: store.resolvePerpOrder,
  updatePerpLegStatus: store.updatePerpLegStatus,
  perpOrderByCoi: store.perpOrderByCoi,
  insertPerpFill: (f) => store.insertPerpFill(f),
  insertPerpFunding: (f) => store.insertPerpFunding(f),
  upsertPerpTransfer: (t) => store.upsertPerpTransfer(t),
  listOpenPerpTransfers: store.listOpenPerpTransfers,
  setPerpPositions: store.setPerpPositions,
  getPerpPositions: store.getPerpPositions,
  getPerpAccount: store.getPerpAccount,
  patchPerpAccount: store.patchPerpAccount,
  bumpNonceHighWater: store.bumpNonceHighWater,
  getNonceHighWater: store.getNonceHighWater,
  insertAdoptedPerpOrder: (a) => insertAdoptedPerpOrderRow(rawDb, a),
  perpNonceRecorded: (agentId, accountIndex, apiKeyIndex, nonce) => perpNonceRecordedRow(rawDb, agentId, accountIndex, apiKeyIndex, nonce),
};

let nextAgent = 1;
async function agent(): Promise<string> {
  const hex = (nextAgent++).toString(16).padStart(38, "0");
  return store.ensureAgent({
    smartAccount: `0xCd${hex}`,
    owner: "0x00000000000000000000000000000000000000b1",
    sessionKeyAddress: "0x00000000000000000000000000000000000000c1",
    serialized: "x",
    caps: { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 },
    grantedAt: 1_000_000,
    expiresAt: 2_000_000_000,
    chainId: 4663,
  } as never);
}

function count(sql: string, ...args: (string | number)[]): number {
  return Number((raw.prepare(sql).get(...args) as { n: number }).n);
}
const journal = (agentId: string, kind: string) => count("SELECT COUNT(*) AS n FROM journal WHERE LOWER(agent_id) = LOWER(?) AND kind = ?", agentId, kind);
const fills = (agentId: string) =>
  raw.prepare("SELECT * FROM perp_fills WHERE agent_id = ? ORDER BY venue_ts_ms, venue_trade_id, side_role").all(agentId.toLowerCase()) as Record<string, unknown>[];
const orderRow = (id: string) => raw.prepare("SELECT * FROM perp_orders WHERE id = ?").get(id) as Record<string, unknown>;
const legRows = (id: string) => raw.prepare("SELECT * FROM perp_order_legs WHERE order_id = ? ORDER BY client_order_index").all(id) as Record<string, unknown>[];

// ── the venue, from its captures ────────────────────────────────────────────

const FIX = path.join(import.meta.dirname, "fixtures");
const text = (f: string) => readFileSync(path.join(FIX, f), "utf8");
const OBD = text("orderBookDetails.perp.json");
const DEC = parseOrderBookDetails(JSON.parse(OBD))!.decimals;
const TX43 = JSON.parse(text("tx.43de174b.json")) as Record<string, unknown>;
const RT1 = JSON.parse(text("recentTrades.1.json")) as { trades: Record<string, unknown>[] };
const ACCOUNT_FILE = JSON.parse(text("account.22149.isolated.json")) as { accounts: Record<string, unknown>[] };
const KEYS_FILE = JSON.parse(text("synthetic.apikeys.json")) as { api_keys: Record<string, unknown>[] };
const L1_FILE = JSON.parse(text("synthetic.accountsByL1Address.json")) as { l1_address: string; sub_accounts: Record<string, unknown>[] };
const ORDERS_FILE = JSON.parse(text("synthetic.accountActiveOrders.json")) as { orders: Record<string, unknown>[] };
const FUNDING_FILE = JSON.parse(text("synthetic.positionFunding.json")) as { position_fundings: Record<string, unknown>[] };
const NOT_FOUND = text("tx.notfound.json");

/** Our account is the fixtures' 22149, key 16, L1 0x8E93…, sealed key the synthetic apikeys' own. */
const ACCT = 22_149;
const KEY = 16;
const L1 = L1_FILE.l1_address;
const PUBKEY = String(KEYS_FILE.api_keys[0]!.public_key);
const SEALED = `0x${PUBKEY}`;
const AUTH = `${Math.floor(Date.now() / 1000) + 7_200}:${ACCT}:${KEY}:${"ab".repeat(80)}`;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

interface Venue {
  /** apikeys' `nonce` for our key: the venue's NEXT nonce. */
  keyNonce: number;
  pubkey: string;
  extraKeys: Record<string, unknown>[];
  subAccounts: Record<string, unknown>[];
  txs: Map<string, { status: number; body: unknown }>;
  trades: Record<string, unknown>[];
  active: Record<string, unknown>[];
  inactive: Record<string, unknown>[];
  funding: Record<string, unknown>[];
  withdraws: Record<string, unknown>[];
  account: Record<string, unknown>;
  dateHeader: string | null;
  skew: number | null;
  calls: string[];
  /** Endpoints that answer 503 this pass. */
  fail: Set<string>;
}

function venueFor(clockMs: number): Venue {
  const account = clone(ACCOUNT_FILE.accounts[0]!);
  account.transaction_time = clockMs * 1000;
  return {
    keyNonce: 1,
    pubkey: PUBKEY,
    extraKeys: [],
    subAccounts: [],
    txs: new Map(),
    trades: [],
    active: [],
    inactive: [],
    funding: [],
    withdraws: [],
    account,
    dateHeader: null,
    skew: 0,
    calls: [],
    fail: new Set(),
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function transport(v: Venue): LighterFetch {
  return async (url) => {
    const u = new URL(url);
    v.calls.push(u.pathname);
    const h: Record<string, string> = v.dateHeader === null ? {} : { date: v.dateHeader };
    if (v.fail.has(u.pathname)) return json(503, { code: 503, message: "unavailable" }, h);
    switch (u.pathname) {
      case "/api/v1/orderBookDetails":
        return json(200, OBD, h);
      case "/api/v1/tx": {
        const t = v.txs.get(u.searchParams.get("value") ?? "");
        return t === undefined ? json(400, NOT_FOUND, h) : json(t.status, t.body, h);
      }
      case "/api/v1/trades":
        // The venue sorts newest first; the reconciler sorts back.
        return json(200, { code: 200, trades: [...v.trades].sort((a, b) => Number(b.timestamp) - Number(a.timestamp)), next_cursor: "" }, h);
      case "/api/v1/accountActiveOrders":
        return json(200, { code: 200, orders: v.active }, h);
      case "/api/v1/accountInactiveOrders":
        return json(200, { code: 200, orders: v.inactive, next_cursor: "" }, h);
      case "/api/v1/positionFunding":
        return json(200, { code: 200, position_fundings: v.funding, next_cursor: "" }, h);
      case "/api/v1/withdraw/history":
        return json(200, { code: 200, withdraws: v.withdraws, cursor: "" }, h);
      case "/api/v1/account":
        return json(200, { ...ACCOUNT_FILE, accounts: [v.account] }, h);
      case "/api/v1/apikeys":
        return json(200, { code: 200, api_keys: [{ ...KEYS_FILE.api_keys[0], nonce: v.keyNonce, public_key: v.pubkey }, ...v.extraKeys] }, h);
      case "/api/v1/accountsByL1Address":
        return json(200, { ...L1_FILE, sub_accounts: [...L1_FILE.sub_accounts, ...v.subAccounts] }, h);
    }
    return json(404, { code: 404, message: "no route" });
  };
}

/** tx.43de174b.json re-labelled: our account, key, nonce, hash, client index, order index, status. */
function txBody(o: { hash: string; nonce: number; status: number; coi: number; orderIndex: number; ae?: string; type?: number; executedAtMs?: number }) {
  const b = clone(TX43);
  const expireAt = o.nonce + 599_000;
  b.hash = o.hash;
  b.type = o.type ?? 14;
  b.nonce = o.nonce;
  b.account_index = ACCT;
  b.api_key_index = KEY;
  b.status = o.status;
  b.expire_at = expireAt;
  b.queued_at = o.nonce + 200;
  b.executed_at = o.executedAtMs ?? o.nonce + 250;
  const info = JSON.parse(String(b.info)) as Record<string, unknown>;
  Object.assign(info, { AccountIndex: ACCT, ApiKeyIndex: KEY, ClientOrderIndex: o.coi, Nonce: o.nonce, ExpiredAt: expireAt });
  b.info = JSON.stringify(info);
  if (b.type === 14) {
    const ev = JSON.parse(String(b.event_info)) as { to: Record<string, unknown>; ae: string };
    ev.to.u = o.coi;
    ev.to.i = o.orderIndex;
    ev.to.a = ACCT;
    ev.ae = o.ae ?? "";
    b.event_info = JSON.stringify(ev);
  } else {
    b.event_info = "";
  }
  return b;
}

/** recentTrades.1.json's first trade (tx 43de174b's fill: ask, taker, 0.00500 BTC at 83130.6) re-labelled. */
function trade(o: {
  id: string;
  tsMs: number;
  askAcct?: number;
  bidAcct?: number;
  askCoi?: string;
  bidCoi?: string;
  askId?: string;
  bidId?: string;
  txHash?: string;
  type?: string;
  over?: Record<string, unknown>;
}) {
  const t = clone(RT1.trades[0]!);
  t.trade_id = Number(o.id);
  t.trade_id_str = o.id;
  t.timestamp = o.tsMs;
  t.transaction_time = o.tsMs * 1000 + 50;
  if (o.askAcct !== undefined) t.ask_account_id = o.askAcct;
  if (o.bidAcct !== undefined) t.bid_account_id = o.bidAcct;
  if (o.askCoi !== undefined) [t.ask_client_id, t.ask_client_id_str] = [Number(o.askCoi), o.askCoi];
  if (o.bidCoi !== undefined) [t.bid_client_id, t.bid_client_id_str] = [Number(o.bidCoi), o.bidCoi];
  if (o.askId !== undefined) [t.ask_id, t.ask_id_str] = [Number(o.askId), o.askId];
  if (o.bidId !== undefined) [t.bid_id, t.bid_id_str] = [Number(o.bidId), o.bidId];
  if (o.txHash !== undefined) t.tx_hash = o.txHash;
  if (o.type !== undefined) t.type = o.type;
  return { ...t, ...o.over };
}

/** synthetic.accountActiveOrders.json's first order (a BTC stop child) re-labelled into any of our orders. */
function order(o: {
  orderId: string;
  coi: number;
  nonce: number;
  status: string;
  tsMs: number;
  type?: string;
  tif?: string;
  isAsk?: boolean;
  reduceOnly?: boolean;
  initial?: string;
  filled?: string;
  filledQuote?: string;
  price?: string;
  trigger?: string;
  triggerStatus?: string;
}) {
  const b = clone(ORDERS_FILE.orders[0]!);
  const initial = o.initial ?? "0.00500";
  const filled = o.filled ?? "0.00000";
  Object.assign(b, {
    order_index: Number(o.orderId),
    order_id: o.orderId,
    client_order_index: o.coi,
    client_order_id: String(o.coi),
    owner_account_index: ACCT,
    nonce: o.nonce,
    status: o.status,
    type: o.type ?? "market",
    time_in_force: o.tif ?? "immediate-or-cancel",
    is_ask: o.isAsk ?? true,
    reduce_only: o.reduceOnly ?? false,
    initial_base_amount: initial,
    filled_base_amount: filled,
    remaining_base_amount: "0.00000",
    filled_quote_amount: o.filledQuote ?? "0.000000",
    price: o.price ?? "83130.6",
    trigger_price: o.trigger ?? "0.0",
    trigger_status: o.triggerStatus ?? "na",
    parent_order_id: "0",
    timestamp: o.tsMs,
  });
  return b;
}

interface World {
  agentId: string;
  v: Venue;
  clock: { now: number };
  resends: string[];
  rec: ReturnType<typeof createLiveReconciler>;
}

async function world(opts: { agentId?: string } = {}): Promise<World> {
  resetLighterApiState();
  const agentId = opts.agentId ?? (await agent());
  const clock = { now: Date.now() };
  const v = venueFor(clock.now);
  const resends: string[] = [];
  const api = createLighterApi({
    home: path.join(scratch, "api-home"),
    budgetKey: L1,
    fetchFn: transport(v),
    now: () => clock.now,
    budgetPerMinute: 100_000,
  });
  const rec = createLiveReconciler({
    agentId,
    epoch: 1,
    accountIndex: ACCT,
    apiKeyIndex: KEY,
    smartAccount: L1,
    sealedPubKey: SEALED,
    api,
    auth: () => AUTH,
    store: ledger,
    now: () => clock.now,
    clockSkewMs: () => v.skew,
    resend: async (row) => {
      resends.push(row.id);
    },
  });
  return { agentId, v, clock, resends, rec };
}

const LEG = { entry: 0, sl: 1, tp: 2, close: 3 } as const;
const hashOf = (n: number) => n.toString(16).padStart(80, "0");

/** A rule-9 row as the live executor writes it: nonce reserved first, legs nonce × 8 + leg, the signed bytes kept. */
async function liveRow(
  agentId: string,
  floor: number,
  o: { effect?: "open" | "close" | "withdraw"; legs?: (keyof typeof LEG)[]; txType?: number; withdrawMicro?: bigint } = {},
): Promise<{ id: string; nonce: number; hash: string; coi: (leg: keyof typeof LEG) => number }> {
  const nonce = Number(await store.bumpNonceHighWater(agentId, "live", floor));
  const effect = o.effect ?? "open";
  const legs = o.legs ?? (effect === "withdraw" ? [] : effect === "close" ? ["close"] : ["entry"]);
  const hash = hashOf(nonce);
  const coi = (leg: keyof typeof LEG) => nonce * 8 + LEG[leg];
  const info = JSON.parse(String(TX43.info)) as Record<string, unknown>;
  Object.assign(info, { AccountIndex: ACCT, ApiKeyIndex: KEY, ClientOrderIndex: coi(legs[0] ?? "entry"), Nonce: nonce, ExpiredAt: nonce + 599_000 });
  const id = await store.insertPerpOrderSubmitted({
    agentId,
    mode: "live",
    effect,
    reduceOnly: effect === "close",
    marketId: effect === "withdraw" ? null : 1,
    worstNotionalMicro: effect === "open" ? 415_653_000n : 0n,
    signed: {
      txType: o.txType ?? (effect === "withdraw" ? 13 : legs.length > 1 ? 28 : 14),
      txInfo: JSON.stringify(info),
      txHash: hash,
      accountIndex: ACCT,
      apiKeyIndex: KEY,
      nonce,
      expiredAt: nonce + 599_000,
      clientOrderIndexes: legs.map((role) => ({ role, clientOrderIndex: coi(role) })),
    },
    withdraw: effect === "withdraw" ? { amountMicro: o.withdrawMicro ?? 25_000_000n, initiator: "agent" } : null,
  });
  return { id, nonce, hash, coi };
}

// ── pure parts ──────────────────────────────────────────────────────────────

describe("the pure parts", () => {
  it("isContinuous: a high-water reaching the venue's last nonce; no row, no high-water or an unread venue is not", () => {
    assert.equal(isContinuous({ nonceHighWater: 100n }, 101), true);
    assert.equal(isContinuous({ nonceHighWater: 100n }, 50), true);
    assert.equal(isContinuous({ nonceHighWater: 99n }, 101), false);
    assert.equal(isContinuous({ nonceHighWater: null }, 1), false);
    assert.equal(isContinuous(null, 1), false);
    assert.equal(isContinuous({ nonceHighWater: 100n }, null), false);
  });

  it("perpFillEconomics: the venue's before-state gives side and realized, rounded toward −∞", () => {
    // recentTrades.1.json trade 1150928072: our bid (taker) of 0.00200 at
    // 83133.1 into a short of 0.00225 whose entry quote was 187.093575.
    const closeShort = perpFillEconomics({ sideRole: "bid", size: 200n, usdAmountMicro: 166_266_200n, positionBefore: -225n, entryQuoteBeforeMicro: 187_093_575n });
    assert.equal(closeShort.side, "short");
    assert.equal(closeShort.closingBase, 200n);
    // entry share 187.093575 × 200/225 = 166.305400; exit 166.266200.
    assert.equal(closeShort.realizedMicro, 39_200n);
    // tx 43de174b's own fill: an ask into a short ADDS to it — realizes a known 0.
    const add = perpFillEconomics({ sideRole: "ask", size: 500n, usdAmountMicro: 415_653_000n, positionBefore: -116n, entryQuoteBeforeMicro: 96_440_570n });
    assert.deepEqual(add, { side: "short", realizedMicro: 0n, closingBase: 0n });
    // A long closed at a loss: floor, so a fraction of a micro is never a gain.
    const lossy = perpFillEconomics({ sideRole: "ask", size: 3n, usdAmountMicro: 10n, positionBefore: 3n, entryQuoteBeforeMicro: 11n });
    assert.equal(lossy.realizedMicro, -1n);
    const third = perpFillEconomics({ sideRole: "ask", size: 1n, usdAmountMicro: 3n, positionBefore: 3n, entryQuoteBeforeMicro: 10n });
    assert.equal(third.realizedMicro, -1n, "3 − 10/3 = −0.33 floors to −1");
  });

  it("perpFeeMicro: ppm of notional, ceiled — a fee never understated, a rebate never overstated", () => {
    assert.equal(perpFeeMicro(166_266_200n, 350), 58_194n); // 58 193.17
    assert.equal(perpFeeMicro(415_653_000n, 0), 0n);
    assert.equal(perpFeeMicro(1_000_001n, -1), -1n); // −1.000001 → −1
  });

  it("venueDeltaCheck: explained within 2 micro per record; an older snapshot is never compared", () => {
    const prev = { collateralMicro: 100_000_000n, isolatedMarginMicro: 50_000_000n, transactionTimeUs: 1 };
    const curr = { collateralMicro: 99_981_008n, isolatedMarginMicro: 50_000_000n, transactionTimeUs: 2 };
    const one = { fillsMicro: -18_994n, fundingMicro: 0n, depositsCreditedMicro: 0n, withdrawalsExecutedMicro: 0n, records: 1 };
    assert.equal(venueDeltaCheck(prev, curr, one).ok, true); // off by 2, tolerance 2
    assert.equal(venueDeltaCheck(prev, { ...curr, collateralMicro: 99_981_009n }, one).ok, false);
    const none = { fillsMicro: 0n, fundingMicro: 0n, depositsCreditedMicro: 0n, withdrawalsExecutedMicro: 0n, records: 0 };
    assert.equal(venueDeltaCheck(prev, { ...prev, transactionTimeUs: 3 }, none).ok, true);
    assert.equal(venueDeltaCheck(prev, { ...prev, collateralMicro: prev.collateralMicro + 1n, transactionTimeUs: 3 }, none).ok, false);
    const w = { ...none, withdrawalsExecutedMicro: 25_000_000n, records: 1 };
    assert.equal(venueDeltaCheck(prev, { ...prev, collateralMicro: 75_000_000n, transactionTimeUs: 3 }, w).ok, true);
    assert.equal(venueDeltaCheck(curr, prev, none).reason, "stale-snapshot");
  });
});

// ── rule 9: resolving a submitted row ───────────────────────────────────────

describe("rule 9: a submitted row is resolved by tx hash, and only by it", () => {
  it("status 2: executed; the leg learns its venue index; the fill is booked as intent; the row finalizes from the venue's record", async () => {
    const w = await world();
    const row = await liveRow(w.agentId, w.clock.now);
    const ORDER = "562950059464847"; // tx 43de174b's own taker order index
    w.v.keyNonce = row.nonce + 1;
    w.v.txs.set(row.hash, { status: 200, body: txBody({ hash: row.hash, nonce: row.nonce, status: 2, coi: row.coi("entry"), orderIndex: Number(ORDER) }) });
    w.v.trades = [trade({ id: "1150930974", tsMs: w.clock.now - 60_000, askAcct: ACCT, askCoi: String(row.coi("entry")), askId: ORDER })];
    w.v.inactive = [order({ orderId: ORDER, coi: row.coi("entry"), nonce: row.nonce, status: "filled", tsMs: w.clock.now - 60_000, filled: "0.00500", filledQuote: "415.653000" })];
    const r = await w.rec.reconcileOnce();

    assert.deepEqual(r.gaps, []);
    assert.equal(r.incident, null);
    assert.equal(r.continuity, "continuous");
    const o = orderRow(row.id);
    assert.equal(o.status, "filled");
    assert.equal(o.filled_base, "500");
    assert.equal(o.filled_quote_micro, "415653000");
    const [leg] = legRows(row.id);
    assert.equal(leg!.venue_order_index, ORDER);
    assert.equal(leg!.status, "filled");
    assert.equal(leg!.venue_status, "filled");
    const [f] = fills(w.agentId);
    assert.equal(f!.attribution, "intent");
    assert.equal(f!.order_id, row.id);
    assert.equal(f!.side, "short", "an ask into a short adds to it");
    assert.equal(f!.side_role, "ask");
    assert.equal(f!.role, "taker");
    assert.equal(f!.realized_micro, "0");
    assert.equal(f!.fee_micro, "0", "taker_fee is omitted when zero");
    assert.equal(f!.client_order_index, row.coi("entry"));
    assert.equal(journal(w.agentId, "perp-fill"), 1);
    // The venue cache and the account row came from the one account read.
    const pos = await store.getPerpPositions(w.agentId, "live");
    assert.deepEqual(pos.map((p) => [p.marketId, p.side, p.base]), [[15, "long", 39_685n], [25, "long", 12_054n]]);
    // The daily cap now counts what filled, not the worst notional.
    assert.equal(await store.perpOpenNotionalSince(w.agentId, "live", Math.floor(w.clock.now / 1000) - 3_600), 415_653_000n);

    // IDEMPOTENT: the same pass again books nothing twice, journals nothing.
    w.clock.now += 30_000;
    const again = await w.rec.reconcileOnce();
    assert.deepEqual(again.gaps, []);
    assert.equal(fills(w.agentId).length, 1);
    assert.equal(journal(w.agentId, "perp-fill"), 1);
    assert.equal(orderRow(row.id).status, "filled");
  });

  it("status 0: rejected, final, its nonce spent; nothing counts against the day", async () => {
    const w = await world();
    const row = await liveRow(w.agentId, w.clock.now);
    w.v.keyNonce = row.nonce + 1;
    w.v.txs.set(row.hash, { status: 200, body: txBody({ hash: row.hash, nonce: row.nonce, status: 0, coi: row.coi("entry"), orderIndex: 1 }) });
    const r = await w.rec.reconcileOnce();
    assert.deepEqual(r.gaps, []);
    const o = orderRow(row.id);
    assert.equal(o.status, "rejected");
    assert.equal(o.filled_quote_micro, "0");
    assert.equal(legRows(row.id)[0]!.status, "rejected");
    assert.equal(await store.perpOpenNotionalSince(w.agentId, "live", Math.floor(w.clock.now / 1000) - 3_600), 0n);
  });

  it("an application error in event_info is a final refusal, never an execution", async () => {
    const w = await world();
    const row = await liveRow(w.agentId, w.clock.now);
    w.v.keyNonce = row.nonce + 1;
    w.v.txs.set(row.hash, { status: 200, body: txBody({ hash: row.hash, nonce: row.nonce, status: 2, coi: row.coi("entry"), orderIndex: 1, ae: "order price is out of the band" }) });
    await w.rec.reconcileOnce();
    const o = orderRow(row.id);
    assert.equal(o.status, "app-error");
    assert.match(String(o.reason), /out of the band/);
    assert.equal(legRows(row.id)[0]!.status, "rejected");
  });

  it("status 1: still submitted; the persisted bytes are re-sent after 10 s, not again within 10 s, never after ExpiredAt", async () => {
    const w = await world();
    const row = await liveRow(w.agentId, w.clock.now);
    w.v.keyNonce = row.nonce;
    w.v.txs.set(row.hash, { status: 200, body: txBody({ hash: row.hash, nonce: row.nonce, status: 1, coi: row.coi("entry"), orderIndex: 1 }) });
    w.clock.now += 11_000;
    await w.rec.reconcileOnce();
    assert.equal(orderRow(row.id).status, "submitted");
    assert.deepEqual(w.resends, [row.id]);
    w.clock.now += 5_000;
    await w.rec.reconcileOnce();
    assert.equal(w.resends.length, 1, "not again within 10 s");
    w.clock.now += 6_000;
    await w.rec.reconcileOnce();
    assert.equal(w.resends.length, 2);
    w.clock.now = row.nonce + 599_000 + 30_000;
    await w.rec.reconcileOnce();
    assert.equal(w.resends.length, 2, "never after ExpiredAt");
    assert.equal(orderRow(row.id).status, "submitted");
  });

  it("not found: submitted until ExpiredAt + 120 s, then expired only with the clock measured within 5 s", async () => {
    const w = await world();
    const row = await liveRow(w.agentId, w.clock.now);
    w.v.keyNonce = row.nonce;
    const expiredAt = row.nonce + 599_000;

    w.clock.now = expiredAt + 60_000;
    let r = await w.rec.reconcileOnce();
    assert.equal(orderRow(row.id).status, "submitted", "inside the grace");
    assert.equal(w.resends.length, 0, "past ExpiredAt nothing is re-sent");

    // Past the grace, but the skew was never measured and the venue sent no Date.
    w.clock.now = expiredAt + EXPIRY_GRACE_MS + 1_000;
    w.v.skew = null;
    r = await w.rec.reconcileOnce();
    assert.equal(orderRow(row.id).status, "submitted");
    assert.ok(r.gaps.some((g) => /skew is unmeasured/.test(g)));
    assert.ok(r.alerts.some((a) => /skew is unmeasured/.test(a)), "an unmeasured clock is said, not just noted");

    // Measured, but 6 s off.
    w.v.skew = 6_000;
    r = await w.rec.reconcileOnce();
    assert.equal(orderRow(row.id).status, "submitted");
    assert.ok(r.gaps.some((g) => /5 s or more/.test(g)));

    // Measured by the venue's own Date header on that very answer: expired.
    w.v.skew = null;
    w.v.dateHeader = new Date(w.clock.now).toUTCString();
    r = await w.rec.reconcileOnce();
    const o = orderRow(row.id);
    assert.equal(o.status, "expired");
    assert.equal(o.filled_quote_micro, "0");
    assert.equal(legRows(row.id)[0]!.status, "expired");
  });

  it("any other failure is unknown — never not-found — and the row stays submitted", async () => {
    const w = await world();
    const row = await liveRow(w.agentId, w.clock.now);
    w.v.keyNonce = row.nonce;
    w.clock.now = row.nonce + 599_000 + EXPIRY_GRACE_MS + 60_000;
    w.v.txs.set(row.hash, { status: 500, body: { code: 500, message: "internal" } });
    let r = await w.rec.reconcileOnce();
    assert.equal(orderRow(row.id).status, "submitted");
    assert.ok(r.gaps.some((g) => /unread \(unavailable\)/.test(g)));
    // A 400 with a code other than 21500 is a refusal to read, not a missing tx.
    w.v.txs.set(row.hash, { status: 400, body: { code: 21501, message: "invalid hash" } });
    r = await w.rec.reconcileOnce();
    assert.equal(orderRow(row.id).status, "submitted");
    assert.ok(r.gaps.some((g) => /unread \(rejected\)/.test(g)));
  });

  it("a fill arriving for a row already resolved expired is booked, and said: the day's cap under-counted it", async () => {
    const w = await world();
    const row = await liveRow(w.agentId, w.clock.now);
    w.v.keyNonce = row.nonce;
    w.clock.now = row.nonce + 599_000 + EXPIRY_GRACE_MS + 1_000;
    w.v.account.transaction_time = w.clock.now * 1000;
    await w.rec.reconcileOnce();
    assert.equal(orderRow(row.id).status, "expired");
    // The venue's index catches up: the tx did execute after all.
    w.v.trades = [trade({ id: "1150930974", tsMs: w.clock.now - 60_000, askAcct: ACCT, askCoi: String(row.coi("entry")) })];
    const r = await w.rec.reconcileOnce();
    assert.equal(fills(w.agentId)[0]!.attribution, "intent");
    assert.equal(orderRow(row.id).status, "expired", "a final answer is never rewritten");
    assert.ok(r.gaps.some((g) => /resolved expired; the day's cap under-counts it/.test(g)));
    assert.ok(r.alerts.some((a) => /under-counts/.test(a)));
  });

  it("an answer for another nonce resolves nothing", async () => {
    const w = await world();
    const row = await liveRow(w.agentId, w.clock.now);
    w.v.keyNonce = row.nonce;
    w.v.txs.set(row.hash, { status: 200, body: txBody({ hash: row.hash, nonce: row.nonce + 1, status: 2, coi: row.coi("entry"), orderIndex: 1 }) });
    const r = await w.rec.reconcileOnce();
    assert.equal(orderRow(row.id).status, "submitted");
    assert.ok(r.gaps.some((g) => /another account, key or nonce/.test(g)));
  });
});

// ── rule 10: fills by venue identity, with provenance ───────────────────────

describe("rule 10: every fill on our account is booked once, with where it came from", () => {
  it("a self-trade is TWO fills — one per side — each with its own provenance", async () => {
    const w = await world();
    const a = await liveRow(w.agentId, w.clock.now);
    const b = await liveRow(w.agentId, w.clock.now, { legs: ["entry", "tp"] });
    w.v.keyNonce = b.nonce + 1;
    for (const r of [a, b]) w.v.txs.set(r.hash, { status: 200, body: txBody({ hash: r.hash, nonce: r.nonce, status: 1, coi: r.coi("entry"), orderIndex: 1 }) });
    // Our ask (taker, row a's entry) hit our own resting bid (maker, row b's take-profit).
    w.v.trades = [trade({ id: "1150930974", tsMs: w.clock.now - 30_000, askAcct: ACCT, bidAcct: ACCT, askCoi: String(a.coi("entry")), bidCoi: String(b.coi("tp")) })];
    const r = await w.rec.reconcileOnce();
    assert.equal(r.incident, null);
    const f = fills(w.agentId);
    assert.deepEqual(
      f.map((x) => [x.venue_trade_id, x.side_role, x.role, x.attribution, x.order_id]),
      [
        ["1150930974", "ask", "taker", "intent", a.id],
        ["1150930974", "bid", "maker", "venue-stop", b.id],
      ],
    );
    // The maker side carries the maker's before-state (a short of 0.43762 being bought back).
    assert.equal(f[1]!.side, "short");
    assert.equal(f[1]!.fee_micro, String(perpFeeMicro(415_653_000n, 102)));
    assert.equal(f[1]!.client_order_index, b.coi("tp"), "the take is told from the stop by its leg");
    assert.equal(journal(w.agentId, "perp-fill"), 2);
    await w.rec.reconcileOnce();
    assert.equal(fills(w.agentId).length, 2);
    assert.equal(journal(w.agentId, "perp-fill"), 2);
  });

  it("a liquidation no intent produced is venue-forced: booked, handed to the breaker once, never unknown activity", async () => {
    const w = await world();
    await store.bumpNonceHighWater(w.agentId, "live", w.clock.now);
    w.v.trades = [trade({ id: "1150930975", tsMs: w.clock.now - 30_000, bidAcct: ACCT, bidCoi: "0", type: "liquidation" })];
    const r = await w.rec.reconcileOnce();
    assert.equal(r.incident, null);
    assert.equal(r.forcedFills.length, 1);
    assert.equal(r.forcedFills[0]!.tradeType, "liquidation");
    assert.ok(r.alerts.some((a) => /forced fill/.test(a)));
    const [f] = fills(w.agentId);
    assert.equal(f!.attribution, "venue-forced");
    assert.equal(f!.trade_type, "liquidation");
    const again = await w.rec.reconcileOnce();
    assert.equal(again.forcedFills.length, 0, "a re-read is not a second liquidation");
  });

  it("a fill matching nothing of ours is venue-unknown: still booked, and the incident flag is stored", async () => {
    const w = await world();
    await store.bumpNonceHighWater(w.agentId, "live", w.clock.now);
    // Our resting ask (maker) filled — with a client index in no scheme of ours.
    w.v.trades = [trade({ id: "1150930976", tsMs: w.clock.now - 30_000, askAcct: ACCT, askCoi: "176936333218309", over: { is_maker_ask: true } })];
    const r = await w.rec.reconcileOnce();
    const [f] = fills(w.agentId);
    assert.equal(f!.attribution, "venue-unknown");
    assert.equal(r.incident?.kind, "unknown-activity");
    const acct = await store.getPerpAccount(w.agentId, "live");
    assert.equal(acct?.incident?.kind, "unknown-activity", "durable, not a flag in memory");
  });

  it("a fill whose tx another key on our account signed is owner-recover, not ours and not unknown", async () => {
    const w = await world();
    await store.bumpNonceHighWater(w.agentId, "live", w.clock.now);
    const theirs = hashOf(424242);
    const body = txBody({ hash: theirs, nonce: 3063, status: 2, coi: 3063 * 8, orderIndex: 562950059464847 });
    body.api_key_index = 0;
    w.v.txs.set(theirs, { status: 200, body });
    w.v.trades = [trade({ id: "1150930977", tsMs: w.clock.now - 30_000, askAcct: ACCT, askCoi: String(3063 * 8), txHash: theirs })];
    const r = await w.rec.reconcileOnce();
    assert.equal(fills(w.agentId)[0]!.attribution, "owner-recover");
    assert.equal(r.incident, null);
  });

  it("an order resting on our account that we never placed is unknown activity", async () => {
    const w = await world();
    await store.bumpNonceHighWater(w.agentId, "live", w.clock.now);
    // synthetic.accountActiveOrders.json's second order: a limit with no client index of ours.
    w.v.active = [clone(ORDERS_FILE.orders[1]!)];
    const r = await w.rec.reconcileOnce();
    assert.equal(r.incident?.kind, "unknown-activity");
    assert.match(r.incident!.detail.triggers[0]!.evidence, /0 fill\(s\) and 1 order\(s\)/);
  });
});

// ── the hosted wipe: continuity, adoption, the day's cap ────────────────────

describe("after a wipe, the day is rebuilt from the venue before any open", () => {
  it("orders signed with our scheme are adopted at the venue's own time; their fills are orphan-order; the high-water reaches the venue", async () => {
    const w = await world();
    // No perp_accounts row: this child's ledger is fresh (a hosted redeploy).
    const lostNonce = w.clock.now - 3 * 3_600_000;
    const entryAt = lostNonce + 300;
    w.v.keyNonce = lostNonce + 1;
    const ENTRY = "562950059464900";
    w.v.inactive = [order({ orderId: ENTRY, coi: lostNonce * 8, nonce: lostNonce, status: "filled", tsMs: entryAt, filled: "0.00500", filledQuote: "415.653000" })];
    // Its stop child still rests at the venue (reduce-only, triggered by mark).
    w.v.active = [
      order({
        orderId: "7599824390440200",
        coi: lostNonce * 8 + 1,
        nonce: lostNonce,
        status: "pending",
        tsMs: entryAt + 100,
        type: "stop-loss",
        isAsk: false,
        reduceOnly: true,
        initial: "0.00000",
        price: "86000.0",
        trigger: "85000.0",
        triggerStatus: "mark-price",
      }),
    ];
    w.v.trades = [trade({ id: "1150930974", tsMs: entryAt, askAcct: ACCT, askCoi: String(lostNonce * 8), askId: ENTRY })];

    const r = await w.rec.reconcileOnce();
    assert.equal(r.continuity, "rebuilt");
    assert.equal(r.adopted, 1);
    assert.equal(r.incident, null, "an orphan of ours is not an incident");
    assert.ok(r.gaps.some((g) => /the lost ledger signed may execute until/.test(g)), "opens wait one signer horizon");
    const id = adoptedOrderId(ACCT, KEY, lostNonce);
    const o = orderRow(id);
    assert.equal(o.reason, "adopted");
    assert.equal(o.status, "filled");
    assert.equal(o.reduce_only, 0);
    assert.equal(o.filled_quote_micro, "415653000");
    assert.equal(Number(o.created_at), Math.floor(entryAt / 1000), "stamped with the venue's time, not the ingest time");
    assert.deepEqual(
      legRows(id).map((l) => [l.role, l.status, l.venue_status]),
      [
        ["entry", "filled", "filled"],
        ["sl", "pending", "pending"],
      ],
    );
    const [f] = fills(w.agentId);
    assert.equal(f!.attribution, "orphan-order");
    assert.equal(f!.order_id, id);
    // The day's cap counts it in the 24 h it happened in.
    const at = Math.floor(entryAt / 1000);
    assert.equal(await store.perpOpenNotionalSince(w.agentId, "live", at - 1), 415_653_000n);
    assert.equal(await store.perpOpenNotionalSince(w.agentId, "live", at), 0n);
    assert.equal(await store.getNonceHighWater(w.agentId, "live"), BigInt(lostNonce));

    // Past the horizon: nothing new, nothing twice, and no gap left.
    w.clock.now += 11 * 60_000;
    w.v.account.transaction_time = w.clock.now * 1000;
    const again = await w.rec.reconcileOnce();
    assert.deepEqual(again.gaps, []);
    assert.equal(again.adopted, 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM perp_orders WHERE agent_id = ?", w.agentId.toLowerCase()), 1);
    assert.equal(fills(w.agentId).length, 1);
    assert.equal(journal(w.agentId, "perp-fill"), 1);
  });

  it("a rebuild whose reads fail leaves the ledger unarmed — a gap every pass — until they succeed", async () => {
    const w = await world();
    const lostNonce = w.clock.now - 3_600_000;
    w.v.keyNonce = lostNonce + 1;
    w.v.fail.add("/api/v1/accountInactiveOrders");
    const r = await w.rec.reconcileOnce();
    assert.equal(r.continuity, "pending");
    assert.ok(r.gaps.some((g) => /rebuild from the venue is incomplete/.test(g)));
    assert.equal(await store.getNonceHighWater(w.agentId, "live"), null, "the high-water is not raised on a partial read");
    w.v.fail.clear();
    w.clock.now += 20_000;
    w.v.account.transaction_time = w.clock.now * 1000;
    const ok = await w.rec.reconcileOnce();
    assert.equal(ok.continuity, "rebuilt");
    assert.equal(await store.getNonceHighWater(w.agentId, "live"), BigInt(lostNonce));
  });

  it("a nonce the venue shows past a CONTINUOUS ledger's high-water is foreign: an incident", async () => {
    const w = await world();
    const row = await liveRow(w.agentId, w.clock.now);
    w.v.keyNonce = row.nonce + 1;
    w.v.txs.set(row.hash, { status: 200, body: txBody({ hash: row.hash, nonce: row.nonce, status: 1, coi: row.coi("entry"), orderIndex: 1 }) });
    const first = await w.rec.reconcileOnce();
    assert.equal(first.continuity, "continuous");
    assert.equal(first.incident, null);
    // Someone signs with our key.
    w.v.keyNonce = row.nonce + 5_000 + 1;
    const r = await w.rec.reconcileOnce();
    assert.equal(r.incident?.kind, "nonce-foreign");
  });
});

// ── funding and transfers ───────────────────────────────────────────────────

describe("funding and transfers, by the venue's identity", () => {
  it("funding is booked by funding id, holder-signed, once", async () => {
    const w = await world();
    await store.bumpNonceHighWater(w.agentId, "live", w.clock.now);
    const hour = Math.floor(w.clock.now / 3_600_000) * 3_600 - 3_600;
    w.v.funding = [{ ...clone(FUNDING_FILE.position_fundings[0]!), timestamp: hour }];
    const r = await w.rec.reconcileOnce();
    assert.deepEqual(r.gaps, []);
    const rows = raw.prepare("SELECT * FROM perp_funding WHERE agent_id = ?").all(w.agentId.toLowerCase()) as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.funding_id, "881234");
    assert.equal(rows[0]!.payment_micro, "-12472", "a long paying at a positive rate pays");
    assert.equal(rows[0]!.funding_hour, hour);
    assert.equal(rows[0]!.rate_ppm, 4);
    assert.equal(rows[0]!.position_base, "39685");
    await w.rec.reconcileOnce();
    assert.equal(journal(w.agentId, "funding"), 1);
  });

  it("a payment whose sign the rate does not explain is booked as the venue moved it, and is a gap", async () => {
    const w = await world();
    await store.bumpNonceHighWater(w.agentId, "live", w.clock.now);
    const hour = Math.floor(w.clock.now / 3_600_000) * 3_600 - 3_600;
    w.v.funding = [{ ...clone(FUNDING_FILE.position_fundings[0]!), timestamp: hour, change: "0.012472" }];
    const r = await w.rec.reconcileOnce();
    assert.ok(r.gaps.some((g) => /sign the rate does not explain/.test(g)));
    assert.equal(journal(w.agentId, "funding"), 1);
  });

  it("a withdrawal's tx executing puts it in transit; the venue's history moves it forward but never to paid", async () => {
    const w = await world();
    const wd = await liveRow(w.agentId, w.clock.now, { effect: "withdraw", withdrawMicro: 25_000_000n });
    const bad = await liveRow(w.agentId, w.clock.now, { effect: "withdraw", withdrawMicro: 7_000_000n });
    w.v.keyNonce = bad.nonce + 1;
    w.v.txs.set(wd.hash, { status: 200, body: txBody({ hash: wd.hash, nonce: wd.nonce, status: 2, coi: 1, orderIndex: 1, type: 13 }) });
    w.v.txs.set(bad.hash, { status: 200, body: txBody({ hash: bad.hash, nonce: bad.nonce, status: 0, coi: 1, orderIndex: 1, type: 13 }) });
    // synthetic.withdrawHistory.json's claimable row, dated at our request.
    w.v.withdraws = [{ id: "w-1", amount: "25.000000", timestamp: Math.floor(w.clock.now / 1000), status: "claimable", type: "secure", l1_tx_hash: "", asset_id: 3 }];
    const r = await w.rec.reconcileOnce();
    assert.deepEqual(r.gaps, []);
    const byOrder = (id: string) => raw.prepare("SELECT * FROM perp_transfers WHERE order_id = ?").get(id) as Record<string, unknown>;
    assert.equal(orderRow(wd.id).status, "executed");
    assert.equal(byOrder(wd.id).state, "executed");
    assert.equal(orderRow(bad.id).status, "rejected");
    assert.equal(byOrder(bad.id).state, "failed");
    assert.equal(journal(w.agentId, "margin"), 1, "only the step that moved money");

    // The history says completed: still in transit here — the chain decides paid.
    w.v.withdraws = [{ ...w.v.withdraws[0]!, status: "completed", l1_tx_hash: `0x${"ab".repeat(32)}` }];
    await w.rec.reconcileOnce();
    assert.equal(byOrder(wd.id).state, "executed");

    // One the ledger never requested, still in flight: a gap, never adopted into transit.
    w.v.withdraws.push({ id: "w-9", amount: "3.000000", timestamp: Math.floor(w.clock.now / 1000), status: "pending", type: "secure", l1_tx_hash: "", asset_id: 3 });
    const r2 = await w.rec.reconcileOnce();
    assert.ok(r2.gaps.some((g) => /matches no open withdrawal of ours/.test(g)));
    assert.equal(count("SELECT COUNT(*) AS n FROM perp_transfers WHERE agent_id = ?", w.agentId.toLowerCase()), 2);
  });
});

// ── rule 12: positions and the venue-delta identity ─────────────────────────

describe("the one account read: the positions cache, and money the ledger must explain", () => {
  it("the cache follows the venue; recorded stops stay with the same position; a market the read does not show goes flat", async () => {
    const w = await world();
    await store.bumpNonceHighWater(w.agentId, "live", w.clock.now);
    const base = { agentId: w.agentId, mode: "live" as const, source: "venue" as const, allocatedMarginMicro: 1n, imfBp: 833, marginMode: "isolated" as const };
    await store.upsertPerpPosition({ ...base, marketId: 15, side: "long", base: 30_000n, entryPrice: 23_000n, stopTrigger: 21_900n, stopPrice: 21_500n, openedAt: 1_790_000_000 });
    await store.upsertPerpPosition({ ...base, marketId: 1, side: "long", base: 100n, entryPrice: 831_306n, stopTrigger: 800_000n, stopPrice: 790_000n });
    await w.rec.reconcileOnce();
    const pos = new Map((await store.getPerpPositions(w.agentId, "live", { includeFlat: true })).map((p) => [p.marketId, p]));
    const nvda = pos.get(15)!;
    assert.equal(nvda.base, 39_685n);
    assert.equal(nvda.entryPrice, 23_083n);
    assert.equal(nvda.allocatedMarginMicro, 76_476_136n);
    assert.equal(nvda.stopTrigger, 21_900n, "the ledger's stop stays with the same position");
    assert.equal(nvda.openedAt, 1_790_000_000);
    assert.equal(pos.get(25)!.stopTrigger, null);
    assert.equal(pos.get(1)!.side, null);
    assert.equal(pos.get(1)!.base, 0n);
    assert.equal(pos.get(1)!.stopTrigger, null, "a flat market keeps no stop");
    const acct = await store.getPerpAccount(w.agentId, "live");
    assert.equal(acct?.lastSnapshotTime, w.clock.now * 1000);
  });

  it("a move the ledger explains passes; one nobody booked is a gap; three in a row are doubtful — an incident", async () => {
    const w = await world();
    const close = await liveRow(w.agentId, w.clock.now, { effect: "close" });
    w.v.keyNonce = close.nonce + 1;
    w.v.txs.set(close.hash, { status: 200, body: txBody({ hash: close.hash, nonce: close.nonce, status: 1, coi: close.coi("close"), orderIndex: 1 }) });
    w.v.account.collateral = "100.000000";
    const p1 = await w.rec.reconcileOnce();
    assert.deepEqual(p1.gaps, []);

    // A close fills between two reads (recentTrades.1.json trade 1150928072:
    // a bid of 0.00200 into a 0.00225 short), with a 350 ppm taker fee.
    const at = w.clock.now + 10_000;
    w.v.trades = [
      trade({
        id: "1150928072",
        tsMs: at,
        bidAcct: ACCT,
        bidCoi: String(close.coi("close")),
        over: { ...clone(RT1.trades[3]!), trade_id_str: "1150928072", timestamp: at, transaction_time: at * 1000, bid_account_id: ACCT, bid_client_id_str: String(close.coi("close")), taker_fee: 350 },
      }),
    ];
    const net = 39_200n - perpFeeMicro(166_266_200n, 350);
    w.clock.now += 20_000;
    w.v.account.transaction_time = w.clock.now * 1000;
    w.v.account.collateral = (Number(100_000_000n + net) / 1e6).toFixed(6);
    const p2 = await w.rec.reconcileOnce();
    assert.deepEqual(p2.gaps, [], "explained to the micro");
    assert.equal(p2.deltaDoubtful, false);
    assert.equal(fills(w.agentId)[0]!.realized_micro, "39200");

    // Five USDG leave and nothing the ledger booked says why — pass after pass.
    let c = 100_000_000n + net;
    let last = p2;
    for (let i = 1; i <= DELTA_DOUBTFUL_AFTER; i++) {
      c -= 5_000_000n;
      w.clock.now += 20_000;
      w.v.account.transaction_time = w.clock.now * 1000;
      w.v.account.collateral = (Number(c) / 1e6).toFixed(6);
      last = await w.rec.reconcileOnce();
      assert.ok(last.gaps.some((g) => /^delta: /.test(g)), `mismatch ${i} is a gap`);
      assert.equal(last.deltaDoubtful, i >= DELTA_DOUBTFUL_AFTER);
      assert.equal(last.incident === null, i < DELTA_DOUBTFUL_AFTER, "one mismatch is a race between reads, not evidence");
    }
    assert.equal(last.incident?.kind, "venue-money-unexplained");
    assert.equal((await store.getPerpAccount(w.agentId, "live"))?.incident?.kind, "venue-money-unexplained");
  });

  it("a landed deposit the venue's money shows credited moves to credited, and the window closes", async () => {
    const w = await world();
    await store.bumpNonceHighWater(w.agentId, "live", w.clock.now);
    const dep = await store.upsertPerpTransfer({
      agentId: w.agentId,
      mode: "live",
      direction: "deposit",
      amountMicro: 20_000_000n,
      initiator: "agent",
      state: "landed",
      chainId: 4663,
      txHash: `0x${"cd".repeat(32)}`,
      logIndex: 3,
    });
    assert.equal(dep.outcome, "inserted");
    w.v.account.collateral = "10.000000";
    await w.rec.reconcileOnce();
    w.clock.now += 20_000;
    w.v.account.transaction_time = w.clock.now * 1000;
    w.v.account.collateral = "30.000000";
    const r = await w.rec.reconcileOnce();
    assert.deepEqual(r.gaps, []);
    assert.equal((raw.prepare("SELECT state FROM perp_transfers WHERE id = ?").get(dep.outcome === "inserted" ? dep.id : "") as { state: string }).state, "credited");
  });

  it("an account read the parsers refuse is unread — a gap, never an empty book", async () => {
    const w = await world();
    await store.bumpNonceHighWater(w.agentId, "live", w.clock.now);
    w.v.account.collateral = "1.0000001"; // seven decimals: not money
    assert.equal(parseAccount({ ...ACCOUNT_FILE, accounts: [w.v.account] }, DEC), null);
    const r = await w.rec.reconcileOnce();
    assert.equal(r.accountRead, null);
    assert.ok(r.gaps.some((g) => /account: the venue account is unread/.test(g)));
  });
});
