/**
 * A FAKE LIGHTER FOR THE LIVE LANE'S END-TO-END TEST — a real HTTP server on
 * 127.0.0.1 that the REAL api.ts client talks to over the wire, answering in
 * the venue's own shapes (the fixtures'), from a small state machine:
 *
 *   accounts   one per L1 address, created by the first deposit the test's
 *              fake chain lands; C, isolated positions with their margin and
 *              entry quote, per-market isolated leverage, API keys and their
 *              next nonce, orders (entries, position-tied children, closes,
 *              standalone stops), trades, withdrawals.
 *   sendTx     parses the form's tx_type / tx_info (the signer's JSON), and
 *              looks the tx's HASH up in the test's ledger by its exact bytes
 *              (`lookupHash`) — the venue cannot compute Poseidon2, and a tx
 *              whose bytes are not already persisted is a rule-9 violation the
 *              test reads from `violations`. Then executes it as the venue
 *              would: leverage, a grouped open filled at the mark within its
 *              worst price with its stop child resting, a reduce-only IOC
 *              close, a standalone stop, a cancel, a secure withdrawal.
 *   the mark   setMark() moves it and fires any position-tied stop it crosses
 *              (a fill at the mark within the stop's bound), as the venue's
 *              trigger engine does.
 *
 * Money is kept so that the reconciler's venue-delta identity holds exactly:
 * an open moves margin C → M, a close returns margin plus the realized P&L
 * computed with reconcile.ts perpFillEconomics' own rounding, fees are zero
 * (Standard accounts), and a withdrawal leaves C when it executes.
 *
 * NOT THE VENUE: no matching engine, no liquidations, no funding. What the
 * test does not exercise is not modelled.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { isolatedLiqPrice, notionalMicro, perpMarketById, type PerpMarketSpec } from "../../../packages/core/src/perps";
import { parseOrderBookDetails } from "./markets";
import { renderScaled } from "./view";

const FIX = path.join(import.meta.dirname, "fixtures");
const OBD_TEXT = readFileSync(path.join(FIX, "orderBookDetails.perp.json"), "utf8");
const DETAILS = parseOrderBookDetails(JSON.parse(OBD_TEXT))!;

export function specOf(marketId: number): PerpMarketSpec {
  const m = DETAILS.markets.get(marketId);
  if (m === undefined) throw new Error(`fake venue: no spec for market ${marketId}`);
  return m.spec;
}

const MAKER = 999_999;

function micro6(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  return `${neg ? "-" : ""}${a / 1_000_000n}.${(a % 1_000_000n).toString().padStart(6, "0")}`;
}

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && (a < 0n) !== (b < 0n) ? q - 1n : q;
}

export interface VPos {
  side: "long" | "short";
  base: bigint;
  /** Σ quote paid for the position (micro) — the venue's entry quote. */
  entryQuote: bigint;
  margin: bigint;
  imfBp: number;
}

export interface VOrder {
  orderIndex: bigint;
  coi: bigint;
  market: number;
  isAsk: boolean;
  type: "market" | "stop-loss" | "take-profit";
  reduceOnly: boolean;
  status: string;
  triggerStatus: "na" | "mark-price" | "parent-order";
  price: bigint;
  trigger: bigint;
  initial: bigint;
  remaining: bigint;
  filled: bigint;
  filledQuote: bigint;
  expiry: number;
  nonce: number;
  parent: bigint;
  tsMs: number;
}

export interface VAccount {
  index: number;
  l1: string;
  collateral: bigint;
  pos: Map<number, VPos>;
  lev: Map<number, number>;
  keys: Map<number, { pub: string; next: number }>;
  /** false once a key we did not register sits at our index: our tokens and signatures stop working. */
  authOk: boolean;
  orders: VOrder[];
  trades: Record<string, unknown>[];
  withdraws: { id: string; amount: bigint; tsSec: number; status: "pending" | "claimable" | "completed" }[];
  txs: Map<string, Record<string, unknown>>;
}

export interface SendRecord {
  txType: number;
  txInfo: string;
  hash: string | null;
  atMs: number;
  /** What the venue did with it. */
  outcome: "executed" | "app-error" | "refused" | "dropped";
}

export class FakeLighter {
  readonly accounts = new Map<number, VAccount>();
  readonly marks = new Map<number, bigint>();
  readonly sends: SendRecord[] = [];
  readonly violations: string[] = [];
  /** Exceptions the fake itself threw while answering (a bug in the fake, never the venue's word). */
  readonly errors: string[] = [];
  /** Paths that answer 503 while listed — an outage of one endpoint. */
  readonly failing = new Set<string>();
  /** The next sendTx is received and DROPPED, and answered only after `hangMs` — the client times out. */
  dropNextSend = false;
  hangMs = 2_000;
  private nextOrder = 1n;
  private nextTrade = 7_000_000_000;
  private seqUs = 0;
  private server: Server | null = null;
  url = "";

  constructor(
    private readonly o: {
      now: () => number;
      /** The persisted tx hash for these exact bytes (the test's ledger), or null. */
      lookupHash: (txInfo: string) => string | null;
    },
  ) {}

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((e) => {
        this.errors.push(e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e));
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 500, message: String(e) }));
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    const a = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${a.port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s !== null) await new Promise<void>((r) => s.close(() => r()));
  }

  // ── the test's levers ─────────────────────────────────────────────────────

  /** A µs time strictly after every one handed out before (events and reads are ordered). */
  private us(): number {
    const base = this.o.now() * 1000;
    this.seqUs = Math.max(this.seqUs + 1, base);
    return this.seqUs;
  }

  accountByL1(l1: string): VAccount | undefined {
    for (const a of this.accounts.values()) if (a.l1 === l1.toLowerCase()) return a;
    return undefined;
  }

  /** The chain's deposit landing: credit C, creating the account (its index) on the first. */
  credit(l1: string, amount: bigint, index: number): VAccount {
    let a = this.accountByL1(l1);
    if (a === undefined) {
      a = { index, l1: l1.toLowerCase(), collateral: 0n, pos: new Map(), lev: new Map(), keys: new Map(), authOk: true, orders: [], trades: [], withdraws: [], txs: new Map() };
      this.accounts.set(index, a);
    }
    a.collateral += amount;
    this.us();
    return a;
  }

  /** The chain's changePubKey priority request, processed. */
  registerKey(index: number, apiKeyIndex: number, pub: string): void {
    const a = this.accounts.get(index)!;
    const bare = pub.replace(/^0x/, "").toLowerCase();
    const prior = a.keys.get(apiKeyIndex);
    a.keys.set(apiKeyIndex, { pub: bare, next: prior?.next ?? 0 });
  }

  /** Someone else's key at our index: our token and every signature of ours stop working. */
  replaceKey(index: number, apiKeyIndex: number, pub: string): void {
    this.registerKey(index, apiKeyIndex, pub);
    this.accounts.get(index)!.authOk = false;
  }

  /** Move the mark; a position-tied stop it crosses fires at the mark when that is inside its bound. */
  setMark(market: number, mark: bigint): void {
    this.marks.set(market, mark);
    for (const a of this.accounts.values()) {
      const p = a.pos.get(market);
      if (p === undefined) continue;
      for (const o of a.orders) {
        if (o.market !== market || o.type !== "stop-loss" || !o.reduceOnly || (o.status !== "pending" && o.status !== "open")) continue;
        const crossed = p.side === "long" ? mark <= o.trigger : mark >= o.trigger;
        if (!crossed) continue;
        const inside = p.side === "long" ? mark >= o.price : mark <= o.price;
        if (!inside) {
          o.status = "canceled-too-much-slippage";
          continue;
        }
        this.fillClose(a, market, p.base, mark, o, null);
        break;
      }
    }
  }

  /** A pending withdrawal, past the venue's delay: claimable on the contract. */
  makeClaimable(index: number): bigint {
    let sum = 0n;
    for (const w of this.accounts.get(index)?.withdraws ?? []) {
      if (w.status !== "pending") continue;
      w.status = "claimable";
      sum += w.amount;
    }
    return sum;
  }

  /** The relayer (or our claim) paid the claimable withdrawals home. */
  complete(index: number): void {
    for (const w of this.accounts.get(index)?.withdraws ?? []) if (w.status === "claimable") w.status = "completed";
  }

  /** Every tx type the venue executed for an account, in order. */
  executedTypes(index: number): number[] {
    return this.sends.filter((s) => s.outcome === "executed" && (this.hashAccount.get(s.hash ?? "") ?? -1) === index).map((s) => s.txType);
  }

  private readonly hashAccount = new Map<string, number>();

  // ── the venue's own mechanics ─────────────────────────────────────────────

  private orderIndex(market: number): bigint {
    this.nextOrder += 1n;
    return (BigInt(market + 1) << 48n) + this.nextOrder;
  }

  private trade(a: VAccount, o: { market: number; ours: "ask" | "bid"; size: bigint; price: bigint; quote: bigint; ourOrder: bigint; ourCoi: bigint; txHash: string; before: bigint; beforeQuote: bigint }): void {
    const spec = specOf(o.market);
    const tsUs = this.us();
    const id = String(this.nextTrade++);
    const makerOrder = this.orderIndex(o.market).toString();
    const ask = o.ours === "ask";
    a.trades.push({
      trade_id: Number(id),
      trade_id_str: id,
      tx_hash: o.txHash,
      type: "trade",
      market_id: o.market,
      size: renderScaled(o.size, spec.sizeDecimals),
      price: renderScaled(o.price, spec.priceDecimals),
      usd_amount: micro6(o.quote),
      ask_id: 0,
      ask_id_str: ask ? o.ourOrder.toString() : makerOrder,
      bid_id: 0,
      bid_id_str: ask ? makerOrder : o.ourOrder.toString(),
      ask_client_id: 0,
      ask_client_id_str: ask ? o.ourCoi.toString() : "0",
      bid_client_id: 0,
      bid_client_id_str: ask ? "0" : o.ourCoi.toString(),
      ask_account_id: ask ? a.index : MAKER,
      bid_account_id: ask ? MAKER : a.index,
      // We are always the taker: our side is the non-maker one.
      is_maker_ask: !ask,
      block_height: 1,
      timestamp: Math.floor(tsUs / 1000),
      taker_position_size_before: renderScaled(o.before, spec.sizeDecimals),
      taker_entry_quote_before: micro6(o.beforeQuote),
      maker_position_size_before: renderScaled(0n, spec.sizeDecimals),
      maker_entry_quote_before: micro6(0n),
      transaction_time: tsUs,
    });
  }

  /** Close (part of) a position at `price` — our reduce-only IOC or a stop that fired. Realized with reconcile.ts's own rounding. */
  private fillClose(a: VAccount, market: number, size: bigint, price: bigint, order: VOrder, txHash: string | null): bigint {
    const p = a.pos.get(market)!;
    const spec = specOf(market);
    const closing = size < p.base ? size : p.base;
    const quote = notionalMicro(closing, price, spec, "floor");
    const sign = p.side === "long" ? 1n : -1n;
    // perpFillEconomics: floor(sign × closing × (usd × |s| − eq × size) / (size × |s|)), size = closing.
    const realized = floorDiv(sign * closing * (quote * p.base - p.entryQuote * closing), closing * p.base);
    const marginBack = (p.margin * closing) / p.base;
    const quoteBack = (p.entryQuote * closing) / p.base;
    this.trade(a, {
      market,
      ours: p.side === "long" ? "ask" : "bid",
      size: closing,
      price,
      quote,
      ourOrder: order.orderIndex,
      ourCoi: order.coi,
      txHash: txHash ?? "f".repeat(16) + this.nextTrade.toString(16).padStart(64, "0"),
      before: p.side === "long" ? p.base : -p.base,
      beforeQuote: p.entryQuote,
    });
    order.status = "filled";
    order.filled += closing;
    order.filledQuote += quote;
    order.remaining = 0n;
    a.collateral += marginBack + realized;
    p.base -= closing;
    p.margin -= marginBack;
    p.entryQuote -= quoteBack;
    if (p.base === 0n) {
      a.pos.delete(market);
      // Position-tied orders end with the position.
      for (const o of a.orders) if (o.market === market && o !== order && o.initial === 0n && (o.status === "pending" || o.status === "open")) o.status = "canceled-reduce-only";
    }
    return realized;
  }

  private execute(a: VAccount, txType: number, info: Record<string, unknown>, hash: string, nonce: number): { ae: string; to?: { i: bigint; u: bigint }; market?: number } {
    const n = (k: string) => Number(info[k]);
    const b = (k: string) => BigInt(info[k] as number);
    const now = this.o.now();
    switch (txType) {
      case 20: {
        const m = n("MarketIndex");
        if (a.pos.has(m)) return { ae: "position is open", market: m };
        a.lev.set(m, n("InitialMarginFraction"));
        return { ae: "", market: m };
      }
      case 28: {
        const orders = info.Orders as Record<string, unknown>[];
        const e = orders[0]!;
        const m = Number(e.MarketIndex);
        const spec = specOf(m);
        const imf = a.lev.get(m);
        if (imf === undefined) return { ae: "leverage not set", market: m };
        if (a.pos.has(m)) return { ae: "position exists", market: m };
        const mark = this.marks.get(m)!;
        const long = Number(e.IsAsk) === 0;
        const worst = BigInt(e.Price as number);
        const base = BigInt(e.BaseAmount as number);
        const entryIdx = this.orderIndex(m);
        const entry: VOrder = {
          orderIndex: entryIdx,
          coi: BigInt(e.ClientOrderIndex as number),
          market: m,
          isAsk: !long,
          type: "market",
          reduceOnly: false,
          status: "filled",
          triggerStatus: "na",
          price: worst,
          trigger: 0n,
          initial: base,
          remaining: 0n,
          filled: 0n,
          filledQuote: 0n,
          expiry: 0,
          nonce,
          parent: 0n,
          tsMs: now,
        };
        a.orders.push(entry);
        const inside = long ? mark <= worst : mark >= worst;
        const quote = notionalMicro(base, mark, spec, "floor");
        const margin = (quote * BigInt(imf) + 9_999n) / 10_000n;
        if (!inside || a.collateral < margin) {
          entry.status = inside ? "canceled-margin-not-allowed" : "canceled-too-much-slippage";
          entry.remaining = 0n;
          return { ae: "", to: { i: entryIdx, u: entry.coi }, market: m };
        }
        a.collateral -= margin;
        a.pos.set(m, { side: long ? "long" : "short", base, entryQuote: quote, margin, imfBp: imf });
        entry.filled = base;
        entry.filledQuote = quote;
        this.trade(a, { market: m, ours: long ? "bid" : "ask", size: base, price: mark, quote, ourOrder: entryIdx, ourCoi: entry.coi, txHash: hash, before: 0n, beforeQuote: 0n });
        for (const c of orders.slice(1)) {
          const t = Number(c.Type);
          a.orders.push({
            orderIndex: this.orderIndex(m),
            coi: BigInt(c.ClientOrderIndex as number),
            market: m,
            isAsk: Number(c.IsAsk) === 1,
            type: t === 2 ? "stop-loss" : "take-profit",
            reduceOnly: true,
            status: "pending",
            triggerStatus: "mark-price",
            price: BigInt(c.Price as number),
            trigger: BigInt(c.TriggerPrice as number),
            initial: 0n,
            remaining: 0n,
            filled: 0n,
            filledQuote: 0n,
            expiry: Number(c.OrderExpiry),
            nonce,
            parent: entryIdx,
            tsMs: now,
          });
        }
        return { ae: "", to: { i: entryIdx, u: entry.coi }, market: m };
      }
      case 14: {
        const m = n("MarketIndex");
        const t = n("Type");
        if (t === 2 || t === 4) {
          const idx = this.orderIndex(m);
          a.orders.push({
            orderIndex: idx,
            coi: b("ClientOrderIndex"),
            market: m,
            isAsk: n("IsAsk") === 1,
            type: t === 2 ? "stop-loss" : "take-profit",
            reduceOnly: true,
            status: "pending",
            triggerStatus: "mark-price",
            price: b("Price"),
            trigger: b("TriggerPrice"),
            initial: b("BaseAmount"),
            remaining: b("BaseAmount"),
            filled: 0n,
            filledQuote: 0n,
            expiry: n("OrderExpiry"),
            nonce,
            parent: 0n,
            tsMs: now,
          });
          return { ae: "", to: { i: idx, u: b("ClientOrderIndex") }, market: m };
        }
        // A market IOC, reduce-only: a close.
        const p = a.pos.get(m);
        const idx = this.orderIndex(m);
        const order: VOrder = {
          orderIndex: idx,
          coi: b("ClientOrderIndex"),
          market: m,
          isAsk: n("IsAsk") === 1,
          type: "market",
          reduceOnly: n("ReduceOnly") === 1,
          status: "canceled-reduce-only",
          triggerStatus: "na",
          price: b("Price"),
          trigger: 0n,
          initial: b("BaseAmount"),
          remaining: 0n,
          filled: 0n,
          filledQuote: 0n,
          expiry: 0,
          nonce,
          parent: 0n,
          tsMs: now,
        };
        a.orders.push(order);
        if (p === undefined || (p.side === "long") !== order.isAsk) return { ae: "", to: { i: idx, u: order.coi }, market: m };
        const mark = this.marks.get(m)!;
        const inside = order.isAsk ? mark >= order.price : mark <= order.price;
        if (!inside) {
          order.status = "canceled-too-much-slippage";
          return { ae: "", to: { i: idx, u: order.coi }, market: m };
        }
        this.fillClose(a, m, b("BaseAmount"), mark, order, hash);
        return { ae: "", to: { i: idx, u: order.coi }, market: m };
      }
      case 15: {
        const m = n("MarketIndex");
        const target = String(info.Index);
        for (const o of a.orders) if (o.market === m && (o.orderIndex.toString() === target || o.coi.toString() === target) && (o.status === "pending" || o.status === "open")) o.status = "canceled";
        return { ae: "", market: m };
      }
      case 16: {
        const attrs = (info.L2TxAttributes ?? {}) as Record<string, number>;
        const scoped = attrs["5"];
        for (const o of a.orders) {
          if ((o.status === "pending" || o.status === "open") && (scoped === undefined || o.market === scoped)) o.status = "canceled";
        }
        return { ae: "" };
      }
      case 13: {
        const amount = b("Amount");
        if (amount > a.collateral) return { ae: "not enough free collateral" };
        a.collateral -= amount;
        a.withdraws.push({ id: hash, amount, tsSec: Math.floor(this.us() / 1_000_000), status: "pending" });
        return { ae: "" };
      }
    }
    return { ae: `tx type ${txType} not modelled` };
  }

  // ── the HTTP surface ──────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = new URL(req.url ?? "/", "http://x");
    const q = (k: string) => u.searchParams.get(k);
    const headers = { "content-type": "application/json", date: new Date(this.o.now()).toUTCString() };
    const send = (status: number, body: unknown) => {
      res.writeHead(status, headers);
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const authed = typeof req.headers.authorization === "string";
    const acctOf = (v: string | null) => (v === null ? undefined : this.accounts.get(Number(v)));
    const refuseAuth = (a: VAccount | undefined) => authed && a !== undefined && !a.authOk;
    if (this.failing.has(u.pathname)) return send(503, { code: 503, message: "unavailable" });

    switch (u.pathname) {
      case "/api/v1/orderBookDetails":
        return send(200, OBD_TEXT);
      case "/api/v1/withdrawalDelay":
        return send(200, { seconds: 600 });
      case "/api/v1/apikeys": {
        const a = acctOf(q("account_index"));
        if (refuseAuth(a)) return send(401, { code: 20001, message: "invalid auth token" });
        const k = Number(q("api_key_index"));
        if (a === undefined) return send(400, { code: 21100, message: "account not found" });
        const rows = [...a.keys].filter(([i]) => k === 255 || i === k).map(([i, v]) => ({ account_index: a.index, api_key_index: i, nonce: v.next, public_key: v.pub }));
        if (rows.length === 0) return send(400, { code: 21109, message: "api key not found" });
        return send(200, { code: 200, api_keys: rows });
      }
      case "/api/v1/nextNonce": {
        const a = acctOf(q("account_index"));
        if (refuseAuth(a)) return send(401, { code: 20001, message: "invalid auth token" });
        const k = a?.keys.get(Number(q("api_key_index")));
        return k === undefined ? send(400, { code: 21109, message: "api key not found" }) : send(200, { code: 200, nonce: k.next });
      }
      case "/api/v1/account": {
        const a = acctOf(q("value"));
        if (refuseAuth(a)) return send(401, { code: 20001, message: "invalid auth token" });
        if (a === undefined) return send(400, { code: 21100, message: "account not found" });
        return send(200, this.accountJson(a));
      }
      case "/api/v1/accountsByL1Address": {
        const a = this.accountByL1(q("l1_address") ?? "");
        if (refuseAuth(a)) return send(401, { code: 20001, message: "invalid auth token" });
        return send(200, { code: 200, l1_address: q("l1_address"), sub_accounts: a === undefined ? [] : [{ index: a.index, account_type: 0, collateral: micro6(a.collateral), l1_address: a.l1 }] });
      }
      case "/api/v1/accountActiveOrders":
      case "/api/v1/accountInactiveOrders": {
        const a = acctOf(q("account_index"));
        if (!authed || refuseAuth(a)) return send(401, { code: 20001, message: "invalid auth token" });
        if (a === undefined) return send(400, { code: 21100, message: "account not found" });
        const active = u.pathname.endsWith("ActiveOrders");
        const rows = a.orders.filter((o) => (o.status === "pending" || o.status === "open") === active);
        return send(200, { code: 200, orders: rows.map((o) => this.orderJson(a, o)), next_cursor: "" });
      }
      case "/api/v1/trades": {
        const a = acctOf(q("account_index"));
        if (!authed || refuseAuth(a)) return send(401, { code: 20001, message: "invalid auth token" });
        const rows = [...(a?.trades ?? [])].sort((x, y) => Number(y.timestamp) - Number(x.timestamp));
        return send(200, { code: 200, trades: rows, next_cursor: "" });
      }
      case "/api/v1/positionFunding": {
        const a = acctOf(q("account_index"));
        if (!authed || refuseAuth(a)) return send(401, { code: 20001, message: "invalid auth token" });
        return send(200, { code: 200, position_fundings: [], next_cursor: "" });
      }
      case "/api/v1/withdraw/history": {
        const a = acctOf(q("account_index"));
        if (!authed || refuseAuth(a)) return send(401, { code: 20001, message: "invalid auth token" });
        return send(200, {
          code: 200,
          withdraws: (a?.withdraws ?? []).map((w) => ({ id: w.id, amount: micro6(w.amount), timestamp: w.tsSec, status: w.status, type: "secure", l1_tx_hash: "", asset_id: 3 })),
          cursor: "",
        });
      }
      case "/api/v1/tx": {
        const h = (q("value") ?? "").toLowerCase();
        for (const a of this.accounts.values()) {
          if (refuseAuth(a) && this.hashAccount.get(h) === a.index) return send(401, { code: 20001, message: "invalid auth token" });
          const t = a.txs.get(h);
          if (t !== undefined) return send(200, t);
        }
        return send(400, { code: 21500, message: "transaction not found" });
      }
      case "/api/v1/sendTx": {
        const body = await new Promise<string>((r) => {
          let s = "";
          req.on("data", (c) => (s += c));
          req.on("end", () => r(s));
        });
        const form = new URLSearchParams(body);
        const txType = Number(form.get("tx_type"));
        const txInfo = form.get("tx_info") ?? "";
        const hash = this.o.lookupHash(txInfo);
        const rec: SendRecord = { txType, txInfo, hash, atMs: this.o.now(), outcome: "refused" };
        this.sends.push(rec);
        if (hash === null) {
          this.violations.push(`sendTx of type ${txType} whose bytes no ledger row holds`);
          return send(500, { code: 500, message: "unknown bytes" });
        }
        if (this.dropNextSend) {
          this.dropNextSend = false;
          rec.outcome = "dropped";
          await new Promise((r) => setTimeout(r, this.hangMs));
          return send(504, { code: 504, message: "gateway timeout" });
        }
        const info = JSON.parse(txInfo) as Record<string, unknown>;
        const a = this.accounts.get(Number(info.AccountIndex ?? info.FromAccountIndex));
        if (a === undefined) return send(400, { code: 21100, message: "account not found" });
        if (!a.authOk) return send(400, { code: 21120, message: "invalid signature" });
        const key = a.keys.get(Number(info.ApiKeyIndex));
        if (key === undefined) return send(400, { code: 21109, message: "api key not found" });
        const nonce = Number(info.Nonce);
        if (a.txs.has(hash) || nonce < key.next) return send(400, { code: 21104, message: "invalid nonce" });
        const ev = this.execute(a, txType, info, hash, nonce);
        key.next = nonce + 1;
        this.hashAccount.set(hash, a.index);
        rec.outcome = ev.ae === "" ? "executed" : "app-error";
        const tsUs = this.us();
        const event: Record<string, unknown> = { ...(ev.market !== undefined ? { m: ev.market } : {}), ae: ev.ae };
        if (ev.to !== undefined) event.to = { i: Number(ev.to.i), u: Number(ev.to.u), a: a.index };
        a.txs.set(hash, {
          code: 200,
          hash,
          type: txType,
          info: txInfo,
          event_info: JSON.stringify(event),
          status: 2,
          transaction_index: 1,
          l1_address: a.l1,
          account_index: a.index,
          nonce,
          expire_at: Number(info.ExpiredAt),
          block_height: 1,
          queued_at: Math.floor(tsUs / 1000),
          sequence_index: 1,
          parent_hash: "",
          api_key_index: Number(info.ApiKeyIndex),
          transaction_time: tsUs,
          committed_at: 0,
          verified_at: 0,
          executed_at: Math.floor(tsUs / 1000),
        });
        return send(200, { code: 200, tx_hash: hash, predicted_execution_time_ms: 300 });
      }
    }
    return send(404, { code: 404, message: `no route ${u.pathname}` });
  }

  private orderJson(a: VAccount, o: VOrder): Record<string, unknown> {
    const spec = specOf(o.market);
    return {
      order_index: Number(o.orderIndex),
      client_order_index: Number(o.coi),
      order_id: o.orderIndex.toString(),
      client_order_id: o.coi.toString(),
      market_index: o.market,
      owner_account_index: a.index,
      initial_base_amount: renderScaled(o.initial, spec.sizeDecimals),
      price: renderScaled(o.price, spec.priceDecimals),
      nonce: o.nonce,
      remaining_base_amount: renderScaled(o.remaining, spec.sizeDecimals),
      is_ask: o.isAsk,
      filled_base_amount: renderScaled(o.filled, spec.sizeDecimals),
      filled_quote_amount: micro6(o.filledQuote),
      type: o.type,
      time_in_force: "immediate-or-cancel",
      reduce_only: o.reduceOnly,
      trigger_price: renderScaled(o.trigger, spec.priceDecimals),
      order_expiry: o.expiry,
      status: o.status,
      trigger_status: o.triggerStatus,
      trigger_time: 0,
      parent_order_id: o.parent.toString(),
      timestamp: o.tsMs,
    };
  }

  private accountJson(a: VAccount): Record<string, unknown> {
    const tsUs = this.us();
    let isolated = 0n;
    let unrealized = 0n;
    const markets = new Set<number>([...a.lev.keys(), ...a.pos.keys()]);
    const positions = [...markets].sort((x, y) => x - y).map((m) => {
      const spec = specOf(m);
      const p = a.pos.get(m);
      const imf = p?.imfBp ?? a.lev.get(m) ?? 5_000;
      const tied = a.orders.filter((o) => o.market === m && o.initial === 0n && (o.status === "pending" || o.status === "open")).length;
      const standalone = a.orders.filter((o) => o.market === m && o.initial !== 0n && (o.status === "pending" || o.status === "open")).length;
      if (p === undefined) {
        return {
          market_id: m,
          symbol: perpMarketById(m)!.symbol,
          initial_margin_fraction: (imf / 100).toFixed(2),
          open_order_count: 0,
          pending_order_count: standalone,
          position_tied_order_count: tied,
          sign: 1,
          position: renderScaled(0n, spec.sizeDecimals),
          avg_entry_price: renderScaled(0n, spec.priceDecimals),
          position_value: "0.000000",
          unrealized_pnl: "0.000000",
          realized_pnl: "0.000000",
          liquidation_price: "0",
          margin_mode: 1,
          margin_set_flag: 1,
          allocated_margin: "0.000000",
        };
      }
      const mark = this.marks.get(m)!;
      const value = notionalMicro(p.base, mark, spec, "floor");
      const u = p.side === "long" ? value - p.entryQuote : p.entryQuote - value;
      isolated += p.margin;
      unrealized += u;
      // The venue's displayed entry: quote per base, at the price's precision.
      const entry = (p.entryQuote * 10n ** BigInt(spec.sizeDecimals + spec.priceDecimals)) / (p.base * 1_000_000n);
      const liq = isolatedLiqPrice({ side: p.side, entryPrice: entry, baseAmount: p.base, allocatedMarginMicro: p.margin, mmfBp: spec.mmfBp, spec });
      return {
        market_id: m,
        symbol: perpMarketById(m)!.symbol,
        initial_margin_fraction: (imf / 100).toFixed(2),
        open_order_count: 0,
        pending_order_count: standalone,
        position_tied_order_count: tied,
        sign: p.side === "long" ? 1 : -1,
        position: renderScaled(p.base, spec.sizeDecimals),
        avg_entry_price: renderScaled(entry, spec.priceDecimals),
        position_value: micro6(value),
        unrealized_pnl: micro6(u),
        realized_pnl: "0.000000",
        liquidation_price: liq === null ? "0" : renderScaled(liq, spec.priceDecimals),
        margin_mode: 1,
        margin_set_flag: 1,
        allocated_margin: micro6(p.margin),
      };
    });
    const active = a.orders.filter((o) => o.status === "pending" || o.status === "open");
    return {
      code: 200,
      total: 1,
      accounts: [
        {
          code: 0,
          account_type: 0,
          index: a.index,
          l1_address: a.l1,
          cancel_all_time: 0,
          total_order_count: active.filter((o) => o.status === "open").length,
          total_isolated_order_count: 0,
          pending_order_count: active.filter((o) => o.status === "pending").length,
          available_balance: micro6(a.collateral),
          status: 1,
          collateral: micro6(a.collateral),
          transaction_time: tsUs,
          account_trading_mode: 1,
          account_index: a.index,
          name: "",
          description: "",
          can_invite: true,
          referral_points_percentage: "",
          positions,
          total_asset_value: micro6(a.collateral + isolated + unrealized),
          cross_asset_value: micro6(a.collateral),
          shares: [],
          pending_unlocks: [],
          assets: [{ asset_id: 3, symbol: "USDG", balance: "0.000000", locked_balance: "0.000000" }],
        },
      ],
    };
  }
}
