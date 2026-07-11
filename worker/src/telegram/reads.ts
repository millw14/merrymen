/**
 * Read formatters for Telegram — open the ledger read-only (the worker stays
 * the sole writer, same discipline as web/src/app/api/feed/route.ts) and render
 * compact, chat-friendly text. Every query is wrapped so an un-migrated or
 * missing table reads as empty rather than throwing.
 */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homePaths } from "../home";
import { esc } from "./api";

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
  lines.push(`🏹 <b>merryman status</b>`);
  const alive = ctx.workerAliveSec !== null && ctx.workerAliveSec < 90;
  lines.push(`• worker: ${alive ? "alive" : "not running"}${ctx.paused ? " · ⏸ paused" : ""}`);
  lines.push(`• strategy: ${esc(ctx.strategy)} · venue: ${esc(ctx.venue)}`);
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
      .map((r) => `• ${esc(r.symbol)}: $${r.value_usdg.toFixed(2)}${r.price_stale ? " (px 24/5)" : ""} @ $${r.price_usd.toFixed(2)}`)
      .join("\n");
    return `📖 <b>positions</b>\n${body}`;
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
    return `📈 <b>P&amp;L</b>\n• change: ${usd(delta)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)\n• fees accrued: $${(fee?.f ?? 0).toFixed(2)}`;
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
      .map((r) => `${icon(r.status)} ${esc(r.kind)} ${r.amount_usdg.toFixed(2)} USDG ${r.status === "rejected" ? `(${esc(r.reject_rule ?? "")})` : ""} · ${r.at}`)
      .join("\n");
    return `🧾 <b>recent trades</b>\n${body}`;
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

// ───────────────────────────────────────────── campfire report / brag / why ──

interface EquityPoint {
  equity_usdg: number;
  at: number;
}

function equitySeries(db: DatabaseSync, sinceUnix?: number): EquityPoint[] {
  try {
    const rows =
      sinceUnix !== undefined
        ? db.prepare("SELECT equity_usdg, at FROM equity WHERE at >= ? ORDER BY at ASC, id ASC").all(sinceUnix)
        : db.prepare("SELECT equity_usdg, at FROM equity ORDER BY at ASC, id ASC").all();
    return rows as unknown as EquityPoint[];
  } catch {
    return [];
  }
}

function localMidnightUnix(now = new Date()): number {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor(d.getTime() / 1000);
}

const trend = (delta: number) => (delta > 0.005 ? "📈" : delta < -0.005 ? "📉" : "➡️");

/** The daily campfire report — also served on demand by /report. */
export function readReport(ctx: StatusContext): string {
  const db = openRO();
  const lines: string[] = ["🔥 <b>campfire report</b>"];
  if (!db) return "🔥 no ledger yet — the band hasn't ridden. Nothing to report.";
  try {
    const all = equitySeries(db);
    const today = equitySeries(db, localMidnightUnix());
    if (all.length >= 1) {
      const eq = all[all.length - 1]!.equity_usdg;
      lines.push(`• equity: <b>${eq.toFixed(2)} USDG</b>`);
    }
    if (today.length >= 2) {
      const d = today[today.length - 1]!.equity_usdg - today[0]!.equity_usdg;
      const pct = today[0]!.equity_usdg > 0 ? (d / today[0]!.equity_usdg) * 100 : 0;
      lines.push(`• today: ${trend(d)} ${usd(d)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`);
    } else {
      lines.push(`• today: not enough ticks yet`);
    }
    if (all.length >= 2) {
      const d = all[all.length - 1]!.equity_usdg - all[0]!.equity_usdg;
      const pct = all[0]!.equity_usdg > 0 ? (d / all[0]!.equity_usdg) * 100 : 0;
      lines.push(`• all-time: ${trend(d)} ${usd(d)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`);
    }
    // Positions — biggest and smallest holdings.
    try {
      const pos = db
        .prepare("SELECT symbol, value_usdg FROM positions WHERE value_usdg > 0 ORDER BY value_usdg DESC")
        .all() as { symbol: string; value_usdg: number }[];
      if (pos.length) {
        const top = pos[0]!;
        lines.push(`• biggest holding: ${esc(top.symbol)} ($${top.value_usdg.toFixed(2)})${pos.length > 1 ? ` of ${pos.length} positions` : ""}`);
      } else {
        lines.push(`• book: all in cash/vault`);
      }
    } catch {
      /* no positions table yet */
    }
    // Today's trades (created_at is unix seconds — the table default).
    try {
      const t = db
        .prepare(
          "SELECT SUM(CASE WHEN status='landed' THEN 1 ELSE 0 END) AS landed, SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected FROM trades WHERE created_at >= ?",
        )
        .get(localMidnightUnix()) as { landed: number | null; rejected: number | null } | undefined;
      lines.push(`• arrows today: ${t?.landed ?? 0} landed · ${t?.rejected ?? 0} turned back by the wall`);
    } catch {
      /* no trades table yet */
    }
    // What the strategist was thinking (last event).
    try {
      const ev = db
        .prepare("SELECT message FROM events ORDER BY created_at DESC, id DESC LIMIT 1")
        .get() as { message: string } | undefined;
      if (ev) lines.push(`• last word from camp: ${esc(ev.message.slice(0, 160))}`);
    } catch {
      /* no events table yet */
    }
    lines.push(`• strategy: ${esc(ctx.strategy)}${ctx.paused ? " · ⏸ paused" : ""}`);
    return lines.join("\n");
  } finally {
    db.close();
  }
}

/** A shareable scorecard. */
export function readBrag(ctx: StatusContext): string {
  const db = openRO();
  if (!db) return "🏹 no ledger yet — nothing to brag about (yet).";
  try {
    const all = equitySeries(db);
    if (all.length < 2) return "🏹 the band just saddled up — give it a few ticks, then we'll brag.";
    const first = all[0]!;
    const last = all[all.length - 1]!;
    const delta = last.equity_usdg - first.equity_usdg;
    const pct = first.equity_usdg > 0 ? (delta / first.equity_usdg) * 100 : 0;
    const days = Math.max(1, Math.round((last.at - first.at) / 86400));
    const bar = pct >= 0 ? "🟩".repeat(Math.max(1, Math.min(8, Math.ceil(Math.abs(pct))))) : "🟥".repeat(Math.max(1, Math.min(8, Math.ceil(Math.abs(pct)))));
    let best = "";
    try {
      const b = db
        .prepare("SELECT kind, amount_usdg FROM trades WHERE status='landed' ORDER BY amount_usdg DESC LIMIT 1")
        .get() as { kind: string; amount_usdg: number } | undefined;
      if (b) best = `\n• best shot: ${esc(b.kind)} ${b.amount_usdg.toFixed(2)} USDG`;
    } catch {
      /* no trades */
    }
    return [
      `🏹 <b>my merryman's scorecard</b>`,
      `${bar}`,
      `• P&amp;L: <b>${usd(delta)}</b> (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%) over ${days}d`,
      `• equity: ${last.equity_usdg.toFixed(2)} USDG · strategy: ${esc(ctx.strategy)}${best}`,
      ``,
      `self-hosted on merrymen — your keys, your caps 🌳`,
    ].join("\n");
  } finally {
    db.close();
  }
}

/**
 * Evidence for "why did you buy that?" — the last trade plus the strategist
 * events recorded around it. Works with no LLM; the service may hand this to
 * Claude for an in-character retelling.
 */
export function readWhyEvidence(): { text: string; hasTrade: boolean } {
  const db = openRO();
  if (!db) return { text: "no ledger yet — I haven't made a trade to explain.", hasTrade: false };
  try {
    const t = db
      .prepare(
        "SELECT kind, amount_usdg, status, reject_rule, tx_hash, created_at FROM trades ORDER BY id DESC LIMIT 1",
      )
      .get() as
      | { kind: string; amount_usdg: number; status: string; reject_rule: string | null; tx_hash: string | null; created_at: string | number }
      | undefined;
    if (!t) return { text: "🧾 I haven't made a trade yet — nothing to explain.", hasTrade: false };
    const lines = [
      `🧾 <b>my last move</b>`,
      `• ${esc(t.kind)} ${t.amount_usdg.toFixed(2)} USDG — ${esc(t.status)}${t.reject_rule ? ` (${esc(t.reject_rule)})` : ""}`,
    ];
    if (t.tx_hash) lines.push(`• tx: <code>${esc(t.tx_hash)}</code>`);
    // Strategist notes around the trade time (±15 min) — the recorded reasoning.
    try {
      const tradeUnix =
        typeof t.created_at === "number" ? t.created_at : Math.floor(new Date(t.created_at).getTime() / 1000);
      const evs = db
        .prepare(
          "SELECT message FROM events WHERE created_at BETWEEN ? AND ? ORDER BY created_at DESC, id DESC LIMIT 4",
        )
        .all(tradeUnix - 900, tradeUnix + 900) as { message: string }[];
      if (evs.length) {
        lines.push(`• what was on my mind:`);
        for (const e of evs) lines.push(`  · ${esc(e.message.slice(0, 140))}`);
      }
    } catch {
      /* no events */
    }
    return { text: lines.join("\n"), hasTrade: true };
  } finally {
    db.close();
  }
}

/** Recent event-feed lines (for the LLM's context). */
export function readRecentEvents(limit = 5): string {
  const db = openRO();
  if (!db) return "(no events)";
  try {
    const rows = db
      .prepare("SELECT level, message, datetime(created_at,'unixepoch') AS at FROM events ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(limit) as { level: string; message: string; at: string }[];
    if (!rows.length) return "(no events)";
    return rows.map((r) => `[${r.at}] ${r.level}: ${r.message}`).join("\n");
  } catch {
    return "(no events)";
  } finally {
    db.close();
  }
}

/**
 * The full state pack for natural-language chat: status + positions + P&L +
 * recent trades + recent events, tags stripped (the model gets plain text).
 */
export function readLlmState(ctx: StatusContext): string {
  const strip = (s: string) => s.replace(/<[^>]+>/g, "");
  return [
    strip(readStatus(ctx)),
    "",
    strip(readPositions()),
    "",
    strip(readPnl()),
    "",
    strip(readTrades()),
    "",
    "RECENT EVENTS:",
    readRecentEvents(5),
  ].join("\n");
}

export const HELP_TEXT = [
  "🏹 <b>merryman — commands</b>",
  "/status · /positions · /pnl · /trades — see what the band's doing",
  "/report — today's campfire report · /brag — your scorecard",
  "/why — why I made my last trade",
  "/pause · /resume — hold or ride",
  "/strategy &lt;name&gt; — switch strategy (steady-basket, weekend-gap, llm-strategist, or your own)",
  "/cap &lt;usdg&gt; — set the per-action ceiling for chat trades",
  "/buy &lt;SYM&gt; &lt;usdg&gt; · /sell &lt;SYM&gt; &lt;usdg&gt; — trade (passes the policy wall)",
  "/transfer &lt;0x…&gt; &lt;usdg&gt; — send USDG out (asks you to /confirm; enable in dashboard)",
  "/alert &lt;SYM&gt; &gt; &lt;price&gt; — ping me at a price · /alerts · /unalert &lt;n&gt;",
  "/kill — destroy the grant, stand the band down",
  "",
  "…or just talk to me in plain English if an Anthropic key is set.",
].join("\n");
