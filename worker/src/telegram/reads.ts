/**
 * Read formatters for Telegram — open the ledger read-only (the worker stays
 * the sole writer, same discipline as web/src/app/api/feed/route.ts) and render
 * compact, chat-friendly text. Every query is wrapped so an un-migrated or
 * missing table reads as empty rather than throwing.
 */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homePaths } from "../home";

function openRO(): DatabaseSync | null {
  const file = homePaths.db();
  if (!existsSync(file)) return null;
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
}

function usd(n: number): string {
  return `${n >= 0 ? "" : "−"}$${Math.abs(n).toFixed(2)}`;
}

export interface StatusContext {
  strategy: string;
  venue: string;
  paused: boolean;
  workerAliveSec: number | null;
  grant: { perTradeUsdg: number; dailyUsdg: number; maxDrawdownPct: number; expiresInDays: number } | null;
  telegramMaxActionUsdg: number;
}

export function readStatus(ctx: StatusContext): string {
  const lines: string[] = [];
  lines.push(`🏹 *merryman status*`);
  const alive = ctx.workerAliveSec !== null && ctx.workerAliveSec < 90;
  lines.push(`• worker: ${alive ? "alive" : "not running"}${ctx.paused ? " · ⏸ paused" : ""}`);
  lines.push(`• strategy: ${ctx.strategy} · venue: ${ctx.venue}`);
  if (ctx.grant) {
    lines.push(
      `• caps: ${ctx.grant.perTradeUsdg}/trade · ${ctx.grant.dailyUsdg}/day · breaker ${ctx.grant.maxDrawdownPct}% · key dies in ${ctx.grant.expiresInDays}d`,
    );
  } else {
    lines.push(`• no grant signed — raise the permission wall in the dashboard`);
  }
  lines.push(`• chat trade ceiling: ${ctx.telegramMaxActionUsdg} USDG/action`);

  const db = openRO();
  if (db) {
    try {
      const eq = db
        .prepare("SELECT equity_usdg, datetime(at,'unixepoch') AS at FROM equity ORDER BY at DESC, id DESC LIMIT 1")
        .get() as { equity_usdg: number; at: string } | undefined;
      if (eq) lines.push(`• equity: ${eq.equity_usdg.toFixed(2)} USDG`);
    } catch {
      /* table not ready */
    }
    db.close();
  }
  return lines.join("\n");
}

export function readPositions(): string {
  const db = openRO();
  if (!db) return "no ledger yet — the band hasn't ridden.";
  try {
    const rows = db
      .prepare("SELECT symbol, value_usdg, price_usd, price_stale FROM positions ORDER BY value_usdg DESC")
      .all() as { symbol: string; value_usdg: number; price_usd: number; price_stale: number }[];
    if (!rows.length) return "📖 no open positions — all in cash/vault.";
    const body = rows
      .map((r) => `• ${r.symbol}: $${r.value_usdg.toFixed(2)}${r.price_stale ? " (px 24/5)" : ""} @ $${r.price_usd.toFixed(2)}`)
      .join("\n");
    return `📖 *positions*\n${body}`;
  } catch {
    return "📖 no positions yet.";
  } finally {
    db.close();
  }
}

export function readPnl(): string {
  const db = openRO();
  if (!db) return "no ledger yet.";
  try {
    const eq = db
      .prepare("SELECT equity_usdg FROM equity ORDER BY at ASC, id ASC")
      .all() as { equity_usdg: number }[];
    const fee = db.prepare("SELECT COALESCE(SUM(fee_usdg),0) AS f FROM fee_accruals").get() as { f: number } | undefined;
    if (eq.length < 2) return "📈 not enough history yet — check back after a few ticks.";
    const delta = eq[eq.length - 1]!.equity_usdg - eq[0]!.equity_usdg;
    const pct = eq[0]!.equity_usdg > 0 ? (delta / eq[0]!.equity_usdg) * 100 : 0;
    return `📈 *P&L*\n• change: ${usd(delta)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)\n• fees accrued: $${(fee?.f ?? 0).toFixed(2)}`;
  } catch {
    return "📈 no P&L yet.";
  } finally {
    db.close();
  }
}

export function readTrades(): string {
  const db = openRO();
  if (!db) return "no ledger yet.";
  try {
    const rows = db
      .prepare(
        "SELECT kind, amount_usdg, status, reject_rule, datetime(created_at,'unixepoch') AS at FROM trades ORDER BY created_at DESC, id DESC LIMIT 8",
      )
      .all() as { kind: string; amount_usdg: number; status: string; reject_rule: string | null; at: string }[];
    if (!rows.length) return "🧾 no trades yet.";
    const icon = (s: string) => (s === "landed" ? "✅" : s === "rejected" ? "🚫" : "⚠️");
    const body = rows
      .map((r) => `${icon(r.status)} ${r.kind} ${r.amount_usdg.toFixed(2)} USDG ${r.status === "rejected" ? `(${r.reject_rule})` : ""} · ${r.at}`)
      .join("\n");
    return `🧾 *recent trades*\n${body}`;
  } catch {
    return "🧾 no trades yet.";
  } finally {
    db.close();
  }
}

/**
 * Read a held position's raw balance (18dp) + USDG value (6dp) for building a
 * chat sell intent. Returns null when not held. usdg6 converts the stored REAL.
 */
export function readPositionRaw(
  agentId: string,
  symbol: string,
  usdg6: (v: number) => bigint,
): { rawBalance: bigint; valueUsdg: bigint } | null {
  const db = openRO();
  if (!db) return null;
  try {
    const row = db
      .prepare("SELECT raw_balance, value_usdg FROM positions WHERE agent_id = ? AND symbol = ?")
      .get(agentId, symbol) as { raw_balance: string; value_usdg: number } | undefined;
    if (!row) return null;
    let raw: bigint;
    try {
      raw = BigInt(row.raw_balance);
    } catch {
      return null;
    }
    if (raw === 0n) return null;
    return { rawBalance: raw, valueUsdg: usdg6(row.value_usdg) };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export const HELP_TEXT = [
  "🏹 *merryman — commands*",
  "/status · /positions · /pnl · /trades — see what the band's doing",
  "/pause · /resume — hold or ride",
  "/strategy <name> — switch strategy (steady-basket, weekend-gap, llm-strategist, or your own)",
  "/cap <usdg> — set the per-action ceiling for chat trades",
  "/buy <SYM> <usdg> · /sell <SYM> <usdg> — trade (passes the policy wall)",
  "/kill — destroy the grant, stand the band down",
  "",
  "…or just talk to me in plain English if an Anthropic key is set.",
].join("\n");
