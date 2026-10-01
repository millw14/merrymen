/** Read-only facts for chat, using the same operation and cost evidence as the web tape. */
import type { Db } from "./db";
import { distinctTrades } from "./distinct-trades";
import { OP_KEY, readEvidencedSells } from "./trade-evidence";
import { CASH, STOCK_TOKENS } from "../../packages/core/src/index";

/** Execution metadata only; a proposed decision action never supplies a side. */
export function inferredTradeSide(row:{fill_side?:unknown;buy_token?:unknown;sell_token?:unknown}):"buy"|"sell"|null {
  if(row.fill_side==="buy"||row.fill_side==="sell")return row.fill_side;
  const bought=typeof row.buy_token==="string"?row.buy_token.trim().toLowerCase():"";
  const sold=typeof row.sell_token==="string"?row.sell_token.trim().toLowerCase():"";
  const cash=CASH.USDG.toLowerCase();
  if(bought&&sold&&sold===cash&&bought!==cash)return "buy";
  if(bought&&sold&&bought===cash&&sold!==cash)return "sell";
  if(STOCK_TOKENS.some(t=>t.address.toLowerCase()===bought))return "buy";
  if(STOCK_TOKENS.some(t=>t.address.toLowerCase()===sold))return "sell";
  return null;
}

export interface ChatTradeFact {
  id: number;
  kind: string;
  side: "buy" | "sell" | null;
  label: string;
  displayName: string | null;
  token: string | null;
  status: string;
  paper: boolean;
  at: number;
  /** True when only the restart recording time is known, not the executed time. */
  atIsRestart: boolean;
  requestedUsdg: number | null;
  /** Null when only a proposal or a pre-trade quote is recorded. */
  executedUsdg: number | null;
  realizedPnlUsdg: number | null;
  realizedPnlBps: number | null;
  /** Private: never project this arbitrary text into a group. */
  reason: string | null;
  source: string | null;
  decisionId: string | null;
  rejectRule: string | null;
}
export interface TradeFactsOptions {
  account: string;
  epoch: number | null;
  since: number;
  until: number;
  limit?: number;
  filter?: "filled" | "refused" | "all";
  token?: string;
  id?: number;
  side?: "buy" | "sell";
}
export interface TradeFacts { trades: ChatTradeFact[]; complete: boolean }
const finite = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
function label(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z0-9$._-]{1,32}$/.test(v.trim()) && !/^0x/i.test(v.trim()) && !/^T[0-9A-F]{11}$/i.test(v.trim()) ? v.trim() : null;
}
function display(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 && v.trim().length <= 64 && !/[\u0000-\u001f\u007f]/.test(v) && !/^0x/i.test(v.trim()) ? v.trim() : null;
}

/** Throws on an unreadable tape; an unavailable history must never become "no trades". */
export async function readTradeFacts(db: Db, opts: TradeFactsOptions): Promise<TradeFacts> {
  const { account, epoch, since, until } = opts;
  const limit = Math.max(1, Math.min(opts.limit ?? 15, 100));
  const run = epoch === null ? "" : " AND t.epoch = ?";
  const where = ["t.created_at >= ?", "t.created_at <= ?", "t.kind IN ('swap','curve-trade','equity-order')"];
  const args: unknown[] = [account, ...(epoch === null ? [] : [epoch]), since, until];
  if (opts.filter === "filled" || opts.filter === undefined) where.push("t.status IN ('landed','paper')");
  if (opts.filter === "refused") where.push("t.status IN ('rejected','reverted','dropped')");
  if(opts.side){
    const marks=STOCK_TOKENS.map(()=>"?").join(",");
    where.push(`CASE WHEN t.fill_side IN ('buy','sell') THEN t.fill_side WHEN LOWER(t.sell_token) = ? AND LOWER(t.buy_token) <> ? AND t.buy_token <> '' THEN 'buy' WHEN LOWER(t.buy_token) = ? AND LOWER(t.sell_token) <> ? AND t.sell_token <> '' THEN 'sell' WHEN LOWER(t.buy_token) IN (${marks}) THEN 'buy' WHEN LOWER(t.sell_token) IN (${marks}) THEN 'sell' ELSE NULL END = ?`);
    args.push(CASH.USDG.toLowerCase(),CASH.USDG.toLowerCase(),CASH.USDG.toLowerCase(),CASH.USDG.toLowerCase(),...STOCK_TOKENS.map(t=>t.address.toLowerCase()),...STOCK_TOKENS.map(t=>t.address.toLowerCase()),opts.side);
  }
  if (opts.id !== undefined) { where.push("t.id = ?"); args.push(opts.id); }
  if (opts.token) {
    where.push("(LOWER(t.buy_token) = ? OR LOWER(t.sell_token) = ? OR LOWER(COALESCE(t.fill_symbol,d.symbol)) = ? OR LOWER(d.display_name) = ?)");
    args.push(...Array(4).fill(opts.token.trim().replace(/^\$/, "").toLowerCase()));
  }
  // Collapse the entire run first. A recently re-recorded copy must not put
  // yesterday's operation into today's answer.
  const rows = await db.prepare(`SELECT t.id,t.kind,t.target,t.agent_id,t.fill_side,t.buy_token,t.sell_token,t.amount_usdg,t.fill_cash_usdg,
      t.basis_source,t.realized_pnl_usdg,t.status,t.reject_rule,t.created_at,t.decision_id,
      COALESCE(t.fill_symbol,d.symbol) AS symbol,d.display_name,d.reason,d.source,d.id AS linked_decision_id,${OP_KEY} AS op_key
    FROM ${distinctTrades(`LOWER(t.agent_id) = LOWER(?)${run}`)}
    LEFT JOIN decisions d ON d.id = t.decision_id AND LOWER(d.agent_id) = LOWER(t.agent_id)
    WHERE ${where.join(" AND ")} ORDER BY t.created_at DESC,t.id DESC LIMIT ?`).all(...args, limit + 1) as Record<string, unknown>[];
  const evidence = new Set<string>();
  for (const book of ["landed", "paper"] as const) {
    const sells = rows.filter(r => r.status === book && r.fill_side === "sell" && typeof r.sell_token === "string")
      .map(r => ({op: String(r.op_key), token: String(r.sell_token)}));
    try { for (const op of await readEvidencedSells(db, account, book, sells)) evidence.add(op); }
    catch { /* Existing rows stay visible; their unverifiable returns do not. */ }
  }
  const trades:ChatTradeFact[] = rows.slice(0, limit).map((r):ChatTradeFact => {
    const bought = STOCK_TOKENS.find(t => t.address.toLowerCase() === String(r.buy_token ?? "").toLowerCase());
    const sold = STOCK_TOKENS.find(t => t.address.toLowerCase() === String(r.sell_token ?? "").toLowerCase());
    // A decision describes intent. It does not turn an unrecorded fill into a buy.
    const side=inferredTradeSide(r);
    const paper = r.status === "paper";
    const ownEvidence = paper ? r.basis_source === "paper" : r.status === "landed" && r.basis_source === "receipt";
    const cash = ownEvidence ? finite(r.fill_cash_usdg) : null;
    const executed = cash !== null && cash >= 0 ? cash : null;
    const pnl = side === "sell" && ownEvidence && evidence.has(String(r.op_key)) ? finite(r.realized_pnl_usdg) : null;
    const cost = executed !== null && pnl !== null ? executed - pnl : null;
    const bps = pnl !== null && executed !== null && executed >= 0 && cost !== null && cost > 0 ? Math.round(pnl / cost * 10000) : null;
    return { id:Number(r.id), kind:String(r.kind), side, label:label(side === "buy" ? bought?.symbol ?? r.symbol : sold?.symbol ?? r.symbol) ?? "an unnamed coin",
      displayName:display(r.display_name), token:typeof (side === "buy" ? r.buy_token : r.sell_token) === "string" ? String(side === "buy" ? r.buy_token : r.sell_token).toLowerCase() : null,
      status:String(r.status), paper, at:Number(r.created_at), atIsRestart:r.kind==="swap"&&typeof r.target==="string"&&r.target.toLowerCase()===String(r.agent_id).toLowerCase()&&r.decision_id===null&&r.fill_side===null, requestedUsdg:finite(r.amount_usdg), executedUsdg:executed,
      realizedPnlUsdg:pnl,realizedPnlBps:bps !== null && Number.isFinite(bps) ? bps : null,
      reason:typeof r.reason === "string" ? r.reason.slice(0,600) : null, source:typeof r.source === "string" ? r.source : null,
      decisionId:typeof r.linked_decision_id === "string" ? r.linked_decision_id : null,rejectRule:typeof r.reject_rule === "string" ? r.reject_rule : null };
  });
  // A bare copy says when it was written, not when its trade happened. It
  // cannot belong to a dated answer without its receipt time.
  const dated=opts.since>0;
  return {complete:rows.length<=limit&&(!dated||trades.every(t=>!t.atIsRestart)),trades:dated?trades.filter(t=>!t.atIsRestart):trades};
}

/** Adapt a synchronous read-only ledger without arming any write operation. */
export function readOnlyFactsDb(db: {prepare(sql:string):{get(...args:never[]):unknown;all(...args:never[]):unknown[]}}): Db {
  const noWrite = async (): Promise<never> => { throw new Error("chat history is read-only"); };
  return { prepare:sql => ({get:async(...args)=>db.prepare(sql).get(...args as never[]),all:async(...args)=>db.prepare(sql).all(...args as never[]),run:noWrite}),exec:noWrite,tx:noWrite };
}

/** A failed current-run read is unavailable, never a silent fallback to run one. */
export function currentTradeEpochSync(db:{prepare(sql:string):{get(...args:never[]):unknown;all(...args:never[]):unknown[]}},account:string):number|null {
  const columns=db.prepare("PRAGMA table_info(trades)").all() as {name:string}[];
  if(!columns.some(c=>c.name==="epoch"))return null;
  const row=db.prepare("SELECT epoch FROM agents WHERE LOWER(smart_account) = LOWER(?)").get(account as never) as {epoch:unknown}|undefined;
  if(!row)throw new Error("current run unavailable");
  if(typeof row.epoch!=="number"||!Number.isSafeInteger(row.epoch)||row.epoch<1)throw new Error("current run unavailable");
  return row.epoch;
}
