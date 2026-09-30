/**
 * ONE READING OF THE TRADE LEDGER, FOR EVERY PLACE THAT SHOWS A TRADE.
 *
 * /trades, the chat's lookup tools and the model's own context all used to
 * read `trades` separately and all printed "swap 5.00 USDG": no coin, no side,
 * the intended size rather than what moved, and — after a restart — eight rows
 * stamped with the same second, because the reconciler writes back every
 * recent operation at the moment the agent comes back.
 *
 * This reads each row once into a `TradeView` that says what an owner means
 * by a trade: bought or sold, WHICH coin (token-label.ts), how many dollars
 * actually moved, what it made or lost, when it really happened, and whether
 * the row is a copy recorded after a restart. The renderers below are the
 * only two shapes it is ever shown in.
 */

import type { SQLInputValue } from "node:sqlite";
import type { PublicClient } from "viem";

import { isEnergyReserveToken, type CustomToken } from "../../../packages/core/src/index";
import { rejectRuleLabel } from "../thesis-policy";
import {
  isRestartCopy,
  labelText,
  nonCashLeg,
  receiptFacts,
  sideOf,
  tokenLabel,
  tokenLabelSync,
  type LabelDb,
} from "../token-label";
import { esc } from "./api";

export interface TradeView {
  id: number;
  side: "buy" | "sell" | null;
  kind: string;
  /** The coin's address, when known. */
  token: string | null;
  /** What to call the coin. */
  label: string;
  /** False when the coin named itself (launchpad coins do). */
  trusted: boolean;
  /** Dollars that actually moved; the intended size when nothing did. */
  usdg: number | null;
  /** Profit or loss booked by this row (sells), when the cost was known. */
  realized: number | null;
  status: string;
  /** A refusal in words. */
  refusal: string | null;
  /** Unix seconds: the chain's time for a restart copy when readable, else when it was written. */
  at: number;
  /** True when `at` is the time the row was WRITTEN after a restart, not the trade's. */
  atIsRestart: boolean;
  /** Recorded after a restart — the real trade happened earlier on chain. */
  copy: boolean;
  txHash: string | null;
  decisionId: string | null;
}

interface RawRow {
  id: number;
  agent_id: string;
  kind: string;
  target: string | null;
  sell_token: string | null;
  buy_token: string | null;
  amount_usdg: number;
  fill_cash_usdg: number | null;
  fill_side: string | null;
  realized_pnl_usdg: number | null;
  status: string;
  reject_rule: string | null;
  tx_hash: string | null;
  decision_id: string | null;
  created_at: number;
}

export interface TradeViewOpts {
  limit?: number;
  /** Only rows written after this (unix seconds). */
  since?: number;
  filter?: "all" | "filled" | "refused";
  /** A coin address or ticker; matches either leg or the resolved label. */
  token?: string;
  customTokens?: readonly CustomToken[];
  /** The owner's account and vaults — never shown as a coin, and what a receipt is netted over. */
  book?: readonly string[];
  /** For names the ledger lacks and for restart copies. Absent = local only. */
  client?: Pick<PublicClient, "readContract" | "getTransactionReceipt" | "getBlock"> | null;
}

/**
 * A trade sent before a restart whose outcome no record kept — the old run
 * died before it saw the receipt, and nothing since has matched it. Only
 * trades carried over a redeploy are ever marked so; "waiting to confirm"
 * would be a promise nothing is going to keep.
 */
export const UNCONFIRMED = "unconfirmed";

/** The trades.kind the worker records an energy purchase under. */
export const ENERGY_BUY_KIND = "energy-buy";

/**
 * What an energy purchase is called wherever a trade is shown.
 *
 * NOT the token's own ticker and never "a coin I can't name": $MERRYMEN bought
 * for energy is capacity, not a position — it is not valued, not sold by a
 * strategy, and pickAcquiredLeg refuses it, so a row recovered after a restart
 * has no other name to fall back on. Saying "energy" is also what stops an
 * owner reading it as a trade they should expect a profit or a loss from.
 */
export const ENERGY_LABEL = "energy ($MERRYMEN)";

/**
 * Is this row an energy purchase? The worker's own kind, or — for an older
 * or recovered row — a non-cash leg that is the energy reserve token.
 */
export function isEnergyRow(r: { kind: string; sell_token?: string | null; buy_token?: string | null }): boolean {
  return r.kind === ENERGY_BUY_KIND || isEnergyReserveToken(nonCashLeg(r));
}

/** Asked for "merrymen", "$MERRYMEN" or "energy", the energy rows answer. */
const ENERGY_WORDS = new Set(["merrymen", "$merrymen", "energy"]);

const FILLED = new Set(["landed", "paper"]);
// 'dropped' is here as what the owner asks "refused" for: a trade that did not
// happen. It was sent and never executed (a later op used its nonce).
const REFUSED = new Set(["rejected", "reverted", "dropped"]);

/** Read and label recent trades, newest first. Never throws; an unreadable ledger is []. */
export async function loadTradeViews(db: LabelDb, agentId: string, o: TradeViewOpts = {}): Promise<TradeView[]> {
  const limit = Math.max(1, Math.min(o.limit ?? 8, 50));
  let rows: RawRow[] = [];
  // THE FILTERS GO IN THE SQL, before the LIMIT. Filtering the newest N rows
  // afterwards meant an agent whose last dozen rows were refusals reported
  // "no trades" while its real fills sat just past the cut.
  const where = ["agent_id = ?", "created_at >= ?"];
  const args: SQLInputValue[] = [agentId, o.since ?? 0];
  if (o.filter === "filled") where.push("status IN ('landed','paper')");
  else if (o.filter === "refused") where.push("status IN ('rejected','reverted','dropped')");
  const tokenAddr = o.token?.trim().toLowerCase();
  if (tokenAddr && /^0x[0-9a-f]{40}$/.test(tokenAddr)) {
    // Leg-less rows stay candidates: a restart copy's coin is only in its receipt.
    where.push("(lower(buy_token) = ? OR lower(sell_token) = ? OR (buy_token IS NULL AND sell_token IS NULL))");
    args.push(tokenAddr, tokenAddr);
  }
  try {
    rows = db
      .prepare(
        `SELECT id, agent_id, kind, target, sell_token, buy_token, amount_usdg, fill_cash_usdg, fill_side,
                realized_pnl_usdg, status, reject_rule, tx_hash, decision_id, created_at
           FROM trades WHERE ${where.join(" AND ")}
          ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...args, o.token ? 200 : limit * 3) as unknown as RawRow[];
  } catch {
    return [];
  }
  const own = o.book ?? [agentId];
  const kept = rows.filter(
    (r) => !(o.filter === "filled" && !FILLED.has(r.status)) && !(o.filter === "refused" && !REFUSED.has(r.status)),
  );
  // IN PARALLEL. After a restart every recent row is a copy whose coin only
  // its receipt knows — a receipt, a block and a symbol read each, with a
  // timeout apiece. One after another, eight of them on a slow RPC was a
  // minute of silence before /trades answered.
  //
  // A restart copy's true time (its receipt's, with a client) is EARLIER than
  // its row, so while one is among the first `limit` a later trade may belong
  // in its place: every candidate is read before the cut. Nothing else moves.
  const head = kept.slice(0, limit);
  const views: TradeView[] = await Promise.all((o.token || (o.client && head.some(isRestartCopy)) ? kept : head).map((r) => view(db, agentId, r, own, o)));
  const wanted = o.token?.trim().toLowerCase();
  const out = wanted
    ? views.filter(
        (v) =>
          v.token === wanted ||
          v.label.toLowerCase() === wanted ||
          v.label.toLowerCase().startsWith(`${wanted} `) ||
          (v.label === ENERGY_LABEL && ENERGY_WORDS.has(wanted)),
      )
    : views;
  // A restart copy's true time can put it before rows written earlier.
  return out.sort((a, b) => b.at - a.at || b.id - a.id).slice(0, limit);
}

async function view(db: LabelDb, agentId: string, r: RawRow, own: readonly string[], o: TradeViewOpts): Promise<TradeView> {
  const copy = isRestartCopy(r);
  let token = nonCashLeg(r);
  let side = sideOf(r);
  let usdg: number | null = r.fill_cash_usdg ?? r.amount_usdg;
  let at = r.created_at;
  let atIsRestart = copy;
  // A copy has no legs. Its receipt still says what moved, and when.
  if (copy && r.tx_hash && o.client) {
    const facts = await receiptFacts(o.client, r.tx_hash, own).catch(() => null);
    if (facts) {
      token = token ?? facts.token;
      side = side ?? facts.side;
      usdg = Number(facts.cashUsdg) / 1e6;
      if (facts.blockTime) {
        at = facts.blockTime;
        atIsRestart = false;
      }
    }
  }
  // An equity order names its stock in `target` — the one row shape where it does.
  const equityTicker = r.kind === "equity-order" && r.target && !/^0x/i.test(r.target) ? r.target.toUpperCase() : null;
  // AN ENERGY PURCHASE IS NAMED FOR WHAT IT IS, by kind or by its reserve leg
  // (a restart copy's leg comes from its receipt, above). It is only ever
  // bought, so a leg-less row of the worker's own kind is a buy.
  const energy = r.kind === ENERGY_BUY_KIND || isEnergyReserveToken(token);
  if (energy && side === null && r.kind === ENERGY_BUY_KIND) side = "buy";
  const lbl = token && !energy
    ? o.client
      ? await tokenLabel(db, agentId, token, { customTokens: o.customTokens, own, client: o.client })
      : tokenLabelSync(db, agentId, token, { customTokens: o.customTokens, own })
    : null;
  return {
    id: r.id,
    side,
    kind: r.kind,
    token,
    label: energy
      ? ENERGY_LABEL
      : lbl
        ? labelText(lbl)
        : equityTicker
          ? equityTicker
          : r.kind === "vault-deposit" || r.kind === "vault-withdraw"
            ? "your savings vault"
            : r.kind === "transfer"
              ? "a transfer out"
              : "a coin I can't name",
    trusted: energy || equityTicker ? true : (lbl?.trusted ?? false),
    usdg: Number.isFinite(usdg as number) ? usdg : null,
    realized: r.realized_pnl_usdg,
    status: r.status,
    refusal: REFUSED.has(r.status) ? rejectRuleLabel(r.reject_rule) ?? r.reject_rule : null,
    at,
    atIsRestart,
    copy,
    txHash: r.tx_hash,
    decisionId: r.decision_id,
  };
}

/** "$5.00", "<$0.01" — a leftover worth a fraction of a cent is not "0.00". */
export function dollars(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "an unknown amount";
  const a = Math.abs(n);
  if (a > 0 && a < 0.005) return "<$0.01";
  return `$${a.toFixed(2)}`;
}

function signed(n: number): string {
  if (Math.abs(n) < 0.005) return n === 0 ? "±$0.00" : n > 0 ? "+<$0.01" : "−<$0.01";
  return `${n > 0 ? "+" : "−"}$${Math.abs(n).toFixed(2)}`;
}

/** "Sep 23, 01:07 UTC". */
export function when(unix: number): string {
  const d = new Date(unix * 1000);
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${month} ${d.getUTCDate()}, ${hh}:${mm} UTC`;
}

function verb(v: TradeView): string {
  if (v.kind === "transfer") return "sent out";
  if (v.kind === "vault-deposit") return "moved cash into";
  if (v.kind === "vault-withdraw") return "moved cash out of";
  if (v.side === "buy") return "bought";
  if (v.side === "sell") return "sold";
  return "traded";
}

/** One trade, in words. `html` escapes the coin name for Telegram. */
export function tradeViewLine(v: TradeView, html: boolean): string {
  const e = html ? esc : (s: string) => s;
  const coin = e(v.label);
  // DROPPED IS NOT A PURCHASE WAITING TO CONFIRM. Left to the line below it
  // read "⏳ bought …" for an op that can never execute.
  if (v.status === "dropped") {
    const what = v.side ? `${v.side} of ${coin}` : `trade in ${coin}`;
    return `↩️ dropped: ${what}, ${e(dollars(v.usdg))} — it never reached the chain, and nothing moved · ${when(v.at)}`;
  }
  if (v.status === "rejected" || v.status === "reverted") {
    const what = v.side ? `${v.side} of ${coin}` : `trade in ${coin}`;
    const why = v.refusal ? ` — ${e(v.refusal)}` : "";
    return `${v.status === "rejected" ? "🚫 blocked" : "⚠️ failed"}: ${what}, ${e(dollars(v.usdg))}${why} · ${when(v.at)}`;
  }
  const paper =
    v.status === "paper"
      ? " (practice)"
      : v.status === "submitted"
        ? " (waiting to confirm)"
        : v.status === UNCONFIRMED
          ? " (sent before a restart — how it ended isn't on record)"
          : "";
  const result = v.realized !== null && v.side === "sell" ? ` (${e(signed(v.realized))})` : "";
  const time = v.atIsRestart ? `recorded ${when(v.at)} after a restart` : when(v.at);
  const icon = v.status === "landed" ? "✅" : v.status === "paper" ? "📜" : v.status === UNCONFIRMED ? "❔" : "⏳";
  const doing = v.status === UNCONFIRMED ? (v.side === "sell" ? "tried to sell" : v.side === "buy" ? "tried to buy" : "tried to trade") : verb(v);
  return `${icon} ${doing} ${coin} for ${e(dollars(v.usdg))}${result}${paper} · ${time}`;
}

/** The /trades message. */
export function renderTradeList(views: TradeView[]): string {
  if (!views.length) return "🧾 no trades yet.";
  const lines = views.map((v) => tradeViewLine(v, true));
  const notes: string[] = [];
  if (views.some((v) => v.copy)) {
    notes.push(
      views.some((v) => v.copy && v.atIsRestart)
        ? "Some of these were re-recorded when I restarted, so their time is the restart's — the trades themselves happened earlier."
        : "Some of these were re-recorded when I restarted; the times shown are the chain's own.",
    );
  }
  if (views.some((v) => !v.trusted && v.token && v.status !== "rejected")) {
    notes.push("Launchpad coins pick their own names, so a name is only as honest as the coin.");
  }
  return [`🧾 <b>recent trades</b>`, ...lines, ...(notes.length ? ["", ...notes.map((n) => `<i>${esc(n)}</i>`)] : [])].join("\n");
}
