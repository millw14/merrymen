/** Private, descriptive learning from this account's durable filled book.
 * Never a trading permission, forecast, public thesis, or counterfactual mark. */
import type { Db } from "./db";
import { applyFill, ZERO_BASIS, type BasisRow } from "./basis";
import { distinctTrades } from "./distinct-trades";

export const OWN_LEARNING_ROWS = 2_000;
export const OWN_LEARNING_WINDOW_SEC = 30 * 86_400;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;

export interface OwnOutcomeLearning {
  version: 1;
  account: string;
  chainId: number;
  epoch: number;
  at: number;
  status: "ready" | "unavailable";
  reason: "none" | "identity" | "history-limit" | "unreadable";
  closed: number;
  wins: number;
  losses: number;
  flat: number;
  costFlips: number;
  excluded: number;
  open: number;
  unresolved: number;
  /** Weighted by recorded entry cash, after fill costs, NOT account return. */
  returnPct: number | null;
  costDragPct: number | null;
}

function empty(account: string, chainId: number, now: number, epoch = 0): OwnOutcomeLearning {
  return { version: 1, account: account.toLowerCase(), chainId, epoch, at: now,
    status: "unavailable", reason: "identity", closed: 0, wins: 0, losses: 0,
    flat: 0, costFlips: 0, excluded: 0, open: 0, unresolved: 0,
    returnPct: null, costDragPct: null };
}

/** The ledger stores six-decimal USDG numbers. Missing is never zero. */
function micros(value: unknown, signed = false): bigint | null {
  if (typeof value !== "number" || !Number.isFinite(value) || (!signed && value < 0)) return null;
  const scaled = value * 1_000_000, rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 0.00001) return null;
  return BigInt(rounded);
}

function rawQty(value: unknown): bigint | null {
  return typeof value === "string" && /^\d{1,78}$/.test(value) ? BigInt(value) : null;
}

/** Owner gas only; an explicit sponsorship receipt is evidence of zero owner gas. */
function paidGas(row: Record<string, unknown>): bigint | null {
  const wei = rawQty(row.gas_wei);
  if (wei !== null) return wei === 0n ? 0n : micros(row.gas_usdg);
  return rawQty(row.sponsored_gas_wei) !== null ? 0n : null;
}

interface Cycle {
  basis: BasisRow;
  quantityKnown: boolean;
  evidenced: boolean;
  currentEpoch: boolean;
  spent: bigint;
  proceeds: bigint;
  costs: bigint;
  touchedInWindow: boolean;
}
function cycle(): Cycle {
  return { basis: { ...ZERO_BASIS }, quantityKnown: true, evidenced: true,
    currentEpoch: true, spent: 0n, proceeds: 0n, costs: 0n, touchedInWindow: false };
}

/**
 * Replay the complete bounded book, not just the outcome window. Positions can
 * span epochs, so older rows may invalidate a current cycle but never become
 * outcomes on today's chain. A cycle must start and end flat, contain only
 * current-epoch receipts, and match every recorded sale's weighted-average
 * realized basis. Partial sales stay in one cycle, with every entry/exit cost.
 * Missing quantity or an unmatched sale cannot establish flat: that token is
 * unresolved for the rest of the replay. No invented reset at a history edge.
 */
function summarize(rows: readonly Record<string, unknown>[], out: OwnOutcomeLearning): OwnOutcomeLearning {
  const positions = new Map<string, Cycle>();
  // An ordinary cash funding/vault move is not an unresolved trading position.
  // A transfer of a traded token DOES break its flat/basis proof, including one
  // that happened before that token's first typed trade in the replay.
  const tradedTokens = new Set(rows.filter((r) => (r.kind === "swap" || r.kind === "curve-trade") &&
    (r.fill_side === "buy" || r.fill_side === "sell")).map((r) => r[r.fill_side === "buy" ? "buy_token" : "sell_token"])
    .filter((v): v is string => typeof v === "string" && ADDRESS.test(v)).map((v) => v.toLowerCase()));
  let spent = 0n, net = 0n, costs = 0n;
  const since = out.at - OWN_LEARNING_WINDOW_SEC;
  for (const row of rows) {
    const current = Number(row.epoch) === out.epoch;
    const recent = current && Number(row.created_at) > since;
    const side = row.fill_side === "buy" || row.fill_side === "sell" ? row.fill_side : null;
    const trade = row.kind === "swap" || row.kind === "curve-trade";
    const tokens = side && trade ? [row[side === "buy" ? "buy_token" : "sell_token"]] : [row.buy_token, row.sell_token];
    for (const token of new Set(tokens.filter((v): v is string => typeof v === "string" && ADDRESS.test(v)).map((v) => v.toLowerCase()).filter((v) => tradedTokens.has(v)))) {
      let state = positions.get(token);
      if (!state) { state = cycle(); positions.set(token, state); }
      state.touchedInWindow ||= recent;
      state.currentEpoch &&= current;
      const qty = rawQty(row.fill_qty_raw);
      if (!trade || !side || qty === null || qty <= 0n) {
        state.quantityKnown = false;
        state.evidenced = false;
        continue;
      }
      if (!state.quantityKnown) continue;
      const cash = micros(row.fill_cash_usdg), fee = micros(row.trade_fee_usdg), gas = paidGas(row);
      const evidence = row.basis_source === "receipt" && HASH.test(String(row.tx_hash)) && HASH.test(String(row.user_op_hash));
      state.evidenced &&= evidence && cash !== null && fee !== null && gas !== null;
      // Unknown cash can preserve the quantity boundary but never a result.
      const applied = applyFill(state.basis, { side, qtyRaw: qty, cashUsdg: cash ?? 0n });
      if (side === "sell" && applied.basisUnknown) {
        state.quantityKnown = false;
        state.evidenced = false;
        continue;
      }
      if (side === "sell") {
        state.evidenced &&= micros(row.realized_pnl_usdg, true) === applied.realizedUsdg;
        state.proceeds += cash ?? 0n;
      } else {
        state.spent += cash ?? 0n;
      }
      state.costs += (fee ?? 0n) + (gas ?? 0n);
      state.basis = applied.basis;
      if (side !== "sell" || state.basis.qtyRaw !== 0n) continue;
      if (recent) {
        if (state.evidenced && state.currentEpoch && state.spent > 0n) {
          const gross = state.proceeds - state.spent, result = gross - state.costs;
          out.closed++;
          if (result > 0n) out.wins++; else if (result < 0n) out.losses++; else out.flat++;
          if (gross > 0n && result < 0n) out.costFlips++;
          spent += state.spent; net += result; costs += state.costs;
        } else out.excluded++;
      }
      positions.set(token, cycle());
    }
  }
  for (const state of positions.values()) {
    if (!state.touchedInWindow) continue;
    if (!state.quantityKnown) out.unresolved++;
    else if (state.basis.qtyRaw > 0n) out.open++;
  }
  out.status = "ready";
  out.reason = "none";
  if (spent > 0n) {
    // Bound to integer hundredths before conversion; no overflowing float sums.
    out.returnPct = Number(net * 10_000n / spent) / 100;
    out.costDragPct = Number(costs * 10_000n / spent) / 100;
  }
  return out;
}

export async function readOwnOutcomeLearning(db: Db, account: string, chainId: number, nowSec: number): Promise<OwnOutcomeLearning> {
  const out = empty(account, chainId, nowSec);
  if (!ADDRESS.test(account) || !Number.isSafeInteger(chainId) || chainId <= 0 || !Number.isSafeInteger(nowSec) || nowSec <= 0) return out;
  try {
    const readAccount = () => db.prepare("SELECT smart_account, chain_id, epoch, mode FROM agents WHERE LOWER(smart_account) = LOWER(?) LIMIT 2").all(account) as Promise<Record<string, unknown>[]>;
    const accounts = await readAccount();
    const a = accounts.length === 1 ? accounts[0] : undefined;
    if (!a || Number(a.chain_id) !== chainId || a.mode !== "live" || typeof a.epoch !== "number" || !Number.isSafeInteger(a.epoch) || a.epoch < 0) return out;
    out.epoch = Number(a.epoch);
    // All epochs are needed to prove the initial inventory. Only this account;
    // no private decisions/reasons/signals, market marks, or peer financials.
    const rows = await db.prepare(`SELECT t.epoch, t.kind, t.fill_side, t.fill_qty_raw, t.buy_token, t.sell_token,
        t.basis_source, t.tx_hash, t.user_op_hash, t.created_at, t.fill_cash_usdg,
        t.realized_pnl_usdg, t.trade_fee_usdg, t.gas_wei, t.gas_usdg, t.sponsored_gas_wei
      FROM ${distinctTrades("LOWER(t.agent_id) = LOWER(?)")}
      WHERE t.status = 'landed' AND t.created_at <= ?
      ORDER BY t.created_at ASC, t.id ASC LIMIT ?`).all(account, nowSec, OWN_LEARNING_ROWS + 1) as Record<string, unknown>[];
    if (rows.length > OWN_LEARNING_ROWS) { out.reason = "history-limit"; return out; }
    // The shared mirror may publish rows before the agent registration. Never
    // treat that transient, mixed-period picture as a complete current book.
    if (rows.some((r) => typeof r.epoch !== "number" || !Number.isSafeInteger(r.epoch) || r.epoch < 0 || r.epoch > out.epoch)) return out;
    const latest = await readAccount();
    if (latest.length !== 1 || latest[0]?.mode !== "live" || Number(latest[0]?.chain_id) !== chainId || Number(latest[0]?.epoch) !== out.epoch) return out;
    return summarize(rows, out);
  } catch {
    out.reason = "unreadable";
    return out;
  }
}

/** Closed, repo-owned language only. No raw row text can become an instruction. */
export function outcomeLearningLines(snapshot: OwnOutcomeLearning | null): string[] {
  if (!snapshot) return [];
  if (snapshot.status !== "ready") return ["Own durable outcome learning unavailable: complete account/chain history could not be established. Do not infer wins, losses, or skill from missing evidence."];
  const sample = snapshot.closed > 0
    ? `${snapshot.closed} fully closed receipt-proven cycles: ${snapshot.wins} positive, ${snapshot.losses} negative, ${snapshot.flat} flat after recorded entry/exit gas and accrued trade fees; weighted result ${snapshot.returnPct!.toFixed(2)}%, cost drag ${snapshot.costDragPct!.toFixed(2)}%; ${snapshot.costFlips} gross winners became losses after those costs.`
    : "No fully closed cycles with complete receipt, cost-basis, gas and trade-fee evidence; realized profitability is unknown.";
  return [
    `Own durable 30-day/current-period outcomes: ${sample} This is filled-cycle performance before failed-operation gas and other account costs/performance fees, not total-account net return.`,
    `Evidence limits: ${snapshot.excluded} closed cycles excluded for incomplete or cross-period evidence; ${snapshot.open} open and ${snapshot.unresolved} unresolved token histories are not scored. ${snapshot.closed < 10 ? "Small sample; " : "Descriptive sample; "}do not infer predictive skill or confidence calibration. No observed skip/counterfactual or fixed-horizon results are available. Compare each new entry's evidence and costs independently; public realized percentages are gross before fees/gas.`,
  ];
}
