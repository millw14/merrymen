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
import { gasQualifier } from "../equity";
// RELATIVE import only — the "@merrymen/core" alias exists solely in dev (see
// the note in service.ts). isHostedMode decides whether a missing agent id may
// fall back to the single-tenant guess, or must refuse.
import { priceSourceNote, priceSourceTag, isHostedMode } from "../../../packages/core/src/index";

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

/**
 * Whose numbers these are. merrymen is one agent per install, but re-granting
 * mints a NEW smart account and leaves the old one's rows in the same tables —
 * and every figure in this file used to read the lot, unfiltered, so two
 * agents' equity curves interleaved and last-minus-first spanned both.
 *
 * The armed agent wins; failing that the newest, so a killed or expired agent
 * still reports on itself rather than on its predecessor.
 */
function currentAgentId(db: DatabaseSync): string | null {
  try {
    const row = db
      .prepare(
        // rowid breaks the tie deliberately: `status` DEFAULTs to 'armed', so it
        // discriminates less than it looks, and created_at is whole seconds, so
        // two agents granted in the same second would otherwise resolve in
        // whatever order SQLite felt like. rowid is insertion order — the newest
        // grant wins, every time.
        `SELECT smart_account FROM agents
          ORDER BY (status = 'armed') DESC, created_at DESC, rowid DESC LIMIT 1`,
      )
      .get() as { smart_account: string } | undefined;
    if (row?.smart_account) return row.smart_account;
  } catch {
    /* no agents table on a pre-migration ledger — fall through */
  }
  try {
    // A ledger with trades but no agent record still deserves an answer;
    // reporting nothing would be a worse failure than reporting on the only
    // agent present.
    const row = db
      .prepare("SELECT agent_id FROM trades ORDER BY created_at DESC, id DESC LIMIT 1")
      .get() as { agent_id: string } | undefined;
    return row?.agent_id ?? null;
  } catch {
    return null;
  }
}

/**
 * The agent whose numbers these are. The caller passes the process's OWN agent
 * (active.agentId — under process-per-tenant that IS this tenant), and once the
 * ledger is shared across tenants that passed id is the ONLY correct answer.
 *
 * currentAgentId is a SELF-HOSTED fallback for the idle case — no armed grant,
 * reporting on the last agent in a single-tenant DB. It must NEVER run hosted:
 * "the newest agent in the table" there is some other tenant, so a null id on a
 * shared ledger returns null (→ a "no agent" answer) rather than leaking a
 * neighbour's book.
 */
function resolveAgent(db: DatabaseSync, passed: string | null | undefined): string | null {
  if (passed) return passed;
  if (isHostedMode()) return null;
  return currentAgentId(db);
}

/**
 * The epoch this agent reports on. Rows from before the accounting was fixed
 * live in epoch 1 and are excluded from every figure below — they have no flow
 * records, their fills were booked from a slippage floor, and their equity
 * curve can contain a phantom crater from a failed balance read. Kept for
 * forensics, never mixed into a number anyone is shown.
 */
function agentEpoch(db: DatabaseSync, agentId: string): number {
  try {
    const row = db
      .prepare("SELECT epoch FROM agents WHERE smart_account = ?")
      .get(agentId) as { epoch: number } | undefined;
    return row?.epoch ?? 1;
  } catch {
    return 1;
  }
}

/**
 * Gas paid in USDG for this epoch, and how many trades' gas could not be
 * priced. The count is what stops "net of gas" being claimed when it isn't.
 */
function gasPaid(db: DatabaseSync, agentId: string, epoch: number): { usdg: number; unpricedTrades: number } {
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(gas_usdg), 0) AS usdg,
                SUM(CASE WHEN gas_wei IS NOT NULL AND gas_usdg IS NULL THEN 1 ELSE 0 END) AS unpriced
           FROM trades WHERE agent_id = ? AND status = 'landed' AND epoch = ?`,
      )
      .get(agentId, epoch) as { usdg: number; unpriced: number | null } | undefined;
    return { usdg: row?.usdg ?? 0, unpricedTrades: row?.unpriced ?? 0 };
  } catch {
    return { usdg: 0, unpricedTrades: 0 }; // pre-migration ledger
  }
}

/**
 * Capital the owner put in, less what they took out. Subtracting this from
 * equity is the difference between "the account is worth more than it was" and
 * "the agent made money" — the two were the same number until 2026-08-26, which
 * is how /pnl came to report a 1,000 USDG deposit as a 1,000 USDG profit.
 */
function netContributions(db: DatabaseSync, agentId: string, sinceUnix?: number): number | null {
  try {
    const epoch = agentEpoch(db, agentId);
    const sql =
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END), 0) AS net
         FROM flows WHERE agent_id = ? AND epoch = ?` + (sinceUnix !== undefined ? " AND at >= ?" : "");
    const stmt = db.prepare(sql);
    const row = (
      sinceUnix !== undefined ? stmt.get(agentId, epoch, sinceUnix) : stmt.get(agentId, epoch)
    ) as { n: number; net: number } | undefined;
    // No rows is NOT zero. A ledger written before the flows table existed knows
    // nothing about what was put in, and calling that zero republishes the very
    // bug this fixes: equity minus zero is the bankroll, reported as profit.
    if (!row || row.n === 0) return null;
    return row.net;
  } catch {
    // Pre-migration ledger — no flows table at all.
    return null;
  }
}

export interface StatusContext {
  /**
   * The process's own agent (active.agentId), or null when idle. Optional so the
   * self-hosted callers and the tests that predate multi-tenancy still typecheck;
   * when present it scopes every figure to this tenant, which is what keeps one
   * tenant's book off another's screen once the ledger is shared.
   */
  agentId?: string | null;
  /** The merryman's user-given name (soul IDENTITY.md). */
  name: string;
  strategy: string;
  venue: string;
  paused: boolean;
  workerAliveSec: number | null;
  grant: { perTradeUsdg: number; dailyUsdg: number; maxDrawdownPct: number; expiresInDays: number } | null;
  /** The armed grant's chain (4663 mainnet = real funds, 46630 testnet); null when no grant. */
  chainId: number | null;
  /** Paper mode: fills simulate at the live oracle price, nothing signs. */
  paper?: boolean;
  telegramMaxActionUsdg: number;
  /** Simulated starting cash for the paper book — quoted in the testnet explainer. */
  paperStartUsdg?: number;
}

export function readStatus(ctx: StatusContext): string {
  const lines: string[] = [];
  lines.push(`🏹 <b>${esc(ctx.name)} — status</b>`);
  const alive = ctx.workerAliveSec !== null && ctx.workerAliveSec < 90;
  lines.push(`• worker: ${alive ? "alive" : "not running"}${ctx.paused ? " · ⏸ paused" : ""}`);
  lines.push(`• strategy: ${esc(ctx.strategy)} · venue: ${esc(ctx.venue)}`);
  if (ctx.paper) {
    lines.push(`• mode: 📜 <b>paper</b> — fills simulate at live prices, nothing signs`);
  }
  if (ctx.chainId !== null) {
    if (ctx.chainId === 46630) {
      // Say the quiet part out loud: people fund testnet, see 0, and think it's
      // broken. It isn't — the token registry is mainnet-only, so on-chain reads
      // there always return 0, and practice never spends those funds anyway.
      lines.push(`• chain: testnet 46630 — <b>practice only</b> (no real swaps)`);
      lines.push(
        `• ℹ️ testnet funds you send are <b>not used and not shown</b> — merrymen only knows mainnet ` +
          `token addresses, so a funded balance reads 0 here. It paper-trades a simulated ` +
          `${ctx.paperStartUsdg ?? 1000} USDG book at live prices. Real trades → switch to mainnet, ` +
          `add a bundler key, fund the smart account.`,
      );
    } else {
      lines.push(`• chain: <b>mainnet ${ctx.chainId} · REAL FUNDS</b>`);
    }
  }
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
      const agentId = resolveAgent(db, ctx.agentId);
      // Scoped to this tenant's latest equity row — an unfiltered ORDER BY at
      // DESC would surface whichever tenant last wrote an equity row on a shared
      // ledger. No agent resolved → no equity line, never a neighbour's number.
      const eq = agentId
        ? (db
            .prepare(
              "SELECT equity_usdg FROM equity WHERE agent_id = ? ORDER BY at DESC, id DESC LIMIT 1",
            )
            .get(agentId) as { equity_usdg: number } | undefined)
        : undefined;
      if (eq) lines.push(`• equity: ${eq.equity_usdg.toFixed(2)} USDG`);
    } catch {
      /* table not ready */
    }
    db.close();
  }
  return lines.join("\n");
}

export function readPositions(agentId?: string | null): string {
  const db = openRO();
  if (!db) return "no ledger yet — the band hasn't ridden.";
  try {
    const who = resolveAgent(db, agentId);
    if (!who) return "📖 no open positions — all in cash/vault.";
    const rows = db
      .prepare(
        "SELECT symbol, value_usdg, price_usd, price_stale, price_source FROM positions WHERE agent_id = ? ORDER BY value_usdg DESC",
      )
      .all(who) as {
      symbol: string;
      value_usdg: number;
      price_usd: number;
      price_stale: number;
      price_source: string;
    }[];
    if (!rows.length) return "📖 no open positions — all in cash/vault.";
    const body = rows
      .map((r) => {
        // A pool- or broker-priced holding is a different evidential claim than
        // a Chainlink-priced one. Marking it inline means the owner never has
        // to remember which is which.
        const src =
          priceSourceTag(r.price_source) ? ` (${priceSourceTag(r.price_source)})` : "";
        const stale = r.price_stale ? " (px 24/5)" : "";
        return `• ${esc(r.symbol)}: $${r.value_usdg.toFixed(2)}${stale}${src} @ $${r.price_usd.toFixed(2)}`;
      })
      .join("\n");
    // Any non-feed price, not just a pool one — a curve mark needs the same
    // footnote, and more so.
    const anyPool = rows.some((r) => priceSourceTag(r.price_source) !== "");
    const note = anyPool
      ? "\n<i>pool px = a Uniswap time-averaged price, not a Chainlink feed — it passed the depth and divergence checks, but it's a thinner claim.</i>"
      : "";
    return `📖 <b>positions</b>\n${body}${note}`;
  } catch {
    return "📖 no positions yet.";
  } finally {
    db.close();
  }
}

export function readPnl(passedId?: string | null): string {
  const db = openRO();
  if (!db) return "no ledger yet.";
  try {
    const agentId = resolveAgent(db, passedId);
    if (!agentId) return "📈 no agent yet — grant one at localhost:3100/grant.";
    const epoch = agentEpoch(db, agentId);
    const eq = db
      .prepare("SELECT equity_usdg FROM equity WHERE agent_id = ? AND epoch = ? ORDER BY at ASC, id ASC")
      .all(agentId, epoch) as { equity_usdg: number }[];
    const fee = db
      .prepare("SELECT COALESCE(SUM(fee_usdg),0) AS f FROM fee_accruals WHERE agent_id = ?")
      .get(agentId) as { f: number } | undefined;
    // Realized = closed round trips, booked against weighted-average cost. Split
    // out from the equity swing so an open position's paper gain isn't mistaken
    // for money actually taken off the table. Reported independently of equity
    // history: a booked round trip is a fact, even on a young ledger.
    // Paper and live are different money and are NEVER summed together. Rows
    // whose basis was unknown carry NULL and are excluded, so this figure only
    // contains P&L we can actually defend.
    let realizedLine: string | null = null;
    try {
      const rows = db
        .prepare(
          `SELECT status, COALESCE(SUM(realized_pnl_usdg),0) AS pnl, COUNT(*) AS n
             FROM trades WHERE agent_id = ? AND realized_pnl_usdg IS NOT NULL
               AND status IN ('paper','landed')
            GROUP BY status`,
        )
        .all(agentId) as { status: string; pnl: number; n: number }[];
      const parts = rows
        .filter((r) => r.n > 0)
        .map(
          (r) =>
            `• realized${r.status === "paper" ? " (📜 paper)" : ""}: ${usd(r.pnl)} over ${r.n} closing trade${r.n === 1 ? "" : "s"}`,
        );
      if (parts.length) realizedLine = parts.join("\n");
    } catch {
      /* pre-migration ledger — no realized column yet */
    }

    if (eq.length < 1) {
      return realizedLine
        ? `📈 <b>P&amp;L</b>\n${realizedLine}\n• equity curve: not enough history yet — check back after a few ticks.`
        : "📈 not enough history yet — check back after a few ticks.";
    }
    // P&L is what the account is worth MINUS what was put into it. It used to be
    // last-minus-first over the equity curve, which counts every deposit as a
    // gain and every withdrawal as a loss: on a book that was down 0.52 USDG
    // after a 1,000 USDG deposit, this line read +999.48.
    const equityNow = eq[eq.length - 1]!.equity_usdg;
    const contributed = netContributions(db, agentId);
    const lines = [`📈 <b>P&amp;L</b>`];
    if (contributed === null) {
      // Nothing on record about capital, so there is no P&L to state. Saying
      // "equity minus nothing" would be the original bug with extra steps.
      lines.push(`• equity: ${usd(equityNow)}`);
      lines.push(`• change: not measurable — no record of what was put in (ledger predates flow tracking)`);
    } else {
      const gas = gasPaid(db, agentId, epoch);
      // NET of gas. Gas leaves in ETH and equity_usdg is cash + vault +
      // positions, so every figure here used to be gross of a cost that at this
      // account's trade sizes was most of the total.
      const delta = equityNow - contributed - gas.usdg;
      const pct = contributed > 0 ? (delta / contributed) * 100 : 0;
      lines.push(`• change: ${usd(delta)}${contributed > 0 ? ` (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)` : ""}`);
      lines.push(`• equity ${usd(equityNow)} · you put in ${usd(contributed)}`);
      if (gas.usdg > 0 || gas.unpricedTrades > 0) {
        lines.push(`• ${esc(gasQualifier(gas))}`);
      }
    }
    if (realizedLine) lines.push(realizedLine);
    lines.push(`• fees accrued: $${(fee?.f ?? 0).toFixed(2)}`);
    // Gas is a real cost paid in ETH, and equity_usdg is cash + vault +
    // positions — so every figure above is GROSS OF GAS. Said out loud rather
    // than converted at an invented rate: there is no ETH/USD feed here.
    try {
      const g = db
        .prepare("SELECT gas_wei FROM trades WHERE agent_id = ? AND gas_wei IS NOT NULL")
        .all(agentId) as { gas_wei: string }[];
      let wei = 0n;
      for (const r of g) {
        try {
          wei += BigInt(r.gas_wei);
        } catch {
          /* skip a malformed row rather than lose the total */
        }
      }
      if (wei > 0n) {
        const eth = Number(wei) / 1e18;
        lines.push(`• gas paid: ${eth.toFixed(6)} ETH`);
      }
    } catch {
      /* gas_wei arrives with a worker migration */
    }
    return lines.join("\n");
  } catch {
    return "📈 no P&L yet.";
  } finally {
    db.close();
  }
}

export function readTrades(agentId?: string | null): string {
  const db = openRO();
  if (!db) return "no ledger yet.";
  try {
    const who = resolveAgent(db, agentId);
    if (!who) return "🧾 no trades yet.";
    const rows = db
      .prepare(
        "SELECT kind, amount_usdg, status, reject_rule, datetime(created_at,'unixepoch') AS at FROM trades WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT 8",
      )
      .all(who) as { kind: string; amount_usdg: number; status: string; reject_rule: string | null; at: string }[];
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

function equitySeries(db: DatabaseSync, agentId: string, sinceUnix?: number): EquityPoint[] {
  try {
    const epoch = agentEpoch(db, agentId);
    const rows =
      sinceUnix !== undefined
        ? db
            .prepare(
              "SELECT equity_usdg, at FROM equity WHERE agent_id = ? AND epoch = ? AND at >= ? ORDER BY at ASC, id ASC",
            )
            .all(agentId, epoch, sinceUnix)
        : db
            .prepare("SELECT equity_usdg, at FROM equity WHERE agent_id = ? AND epoch = ? ORDER BY at ASC, id ASC")
            .all(agentId, epoch);
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
    const agentId = resolveAgent(db, ctx.agentId);
    if (!agentId) return "🔥 no agent yet — grant one at localhost:3100/grant.";
    const midnight = localMidnightUnix();
    const all = equitySeries(db, agentId);
    const today = equitySeries(db, agentId, midnight);
    if (all.length >= 1) {
      const eq = all[all.length - 1]!.equity_usdg;
      lines.push(`• equity: <b>${eq.toFixed(2)} USDG</b>`);
    }
    // Both windows net out capital that crossed the boundary inside them, so a
    // deposit doesn't read as a day's winnings.
    if (today.length >= 2) {
      // Today's flows net out of today's move; a same-day deposit is not a win.
      const d =
        today[today.length - 1]!.equity_usdg -
        today[0]!.equity_usdg -
        (netContributions(db, agentId, midnight) ?? 0);
      const base = today[0]!.equity_usdg;
      const pct = base > 0 ? (d / base) * 100 : 0;
      lines.push(`• today: ${trend(d)} ${usd(d)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`);
    } else {
      lines.push(`• today: not enough ticks yet`);
    }
    const contributed = netContributions(db, agentId);
    if (contributed === null) {
      lines.push(`• all-time: not measurable — no record of what was put in`);
    } else if (all.length >= 1) {
      const d = all[all.length - 1]!.equity_usdg - contributed;
      const pct = contributed > 0 ? (d / contributed) * 100 : 0;
      lines.push(`• all-time: ${trend(d)} ${usd(d)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`);
    }
    // Positions — biggest and smallest holdings.
    try {
      const pos = db
        .prepare(
          "SELECT symbol, value_usdg FROM positions WHERE agent_id = ? AND value_usdg > 0 ORDER BY value_usdg DESC",
        )
        .all(agentId) as { symbol: string; value_usdg: number }[];
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
          "SELECT SUM(CASE WHEN status='landed' THEN 1 ELSE 0 END) AS landed, SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected FROM trades WHERE agent_id = ? AND created_at >= ?",
        )
        .get(agentId, midnight) as { landed: number | null; rejected: number | null } | undefined;
      lines.push(`• arrows today: ${t?.landed ?? 0} landed · ${t?.rejected ?? 0} turned back by the wall`);
    } catch {
      /* no trades table yet */
    }
    // What the strategist was thinking (last event).
    try {
      const ev = db
        .prepare(
          "SELECT message FROM events WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
        )
        .get(agentId) as { message: string } | undefined;
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
    const agentId = resolveAgent(db, ctx.agentId);
    if (!agentId) return "🏹 no agent yet — grant one at localhost:3100/grant.";
    const all = equitySeries(db, agentId);
    if (all.length < 2) return "🏹 the band just saddled up — give it a few ticks, then we'll brag.";
    const first = all[0]!;
    const last = all[all.length - 1]!;
    // The scorecard people SHARE. Getting this one wrong doesn't just mislead
    // the owner, it misleads everyone they show it to — so it nets out capital
    // like every other figure rather than bragging about a deposit.
    const contributed = netContributions(db, agentId);
    if (contributed === null) {
      return "🏹 nothing to brag about yet — this ledger has no record of what was put in, so there's no honest number to share.";
    }
    const delta = last.equity_usdg - contributed;
    const pct = contributed > 0 ? (delta / contributed) * 100 : 0;
    const days = Math.max(1, Math.round((last.at - first.at) / 86400));
    const bar = pct >= 0 ? "🟩".repeat(Math.max(1, Math.min(8, Math.ceil(Math.abs(pct))))) : "🟥".repeat(Math.max(1, Math.min(8, Math.ceil(Math.abs(pct)))));
    let best = "";
    try {
      const b = db
        .prepare("SELECT kind, amount_usdg FROM trades WHERE agent_id = ? AND status='landed' ORDER BY amount_usdg DESC LIMIT 1")
        .get(agentId) as { kind: string; amount_usdg: number } | undefined;
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
export function readWhyEvidence(agentId?: string | null): { text: string; hasTrade: boolean } {
  const db = openRO();
  if (!db) return { text: "no ledger yet — I haven't made a trade to explain.", hasTrade: false };
  try {
    const who = resolveAgent(db, agentId);
    if (!who) return { text: "🧾 I haven't made a trade yet — nothing to explain.", hasTrade: false };
    const t = db
      .prepare(
        "SELECT kind, amount_usdg, status, reject_rule, tx_hash, created_at, decision_id FROM trades WHERE agent_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(who) as
      | { kind: string; amount_usdg: number; status: string; reject_rule: string | null; tx_hash: string | null; created_at: string | number; decision_id: string | null }
      | undefined;
    if (!t) return { text: "🧾 I haven't made a trade yet — nothing to explain.", hasTrade: false };
    const lines = [
      `🧾 <b>my last move</b>`,
      `• ${esc(t.kind)} ${t.amount_usdg.toFixed(2)} USDG — ${esc(t.status)}${t.reject_rule ? ` (${esc(t.reject_rule)})` : ""}`,
    ];
    if (t.tx_hash) lines.push(`• tx: <code>${esc(t.tx_hash)}</code>`);
    // The real reasoning: the trade's OWN decision row, joined by decision_id.
    // This is exact — no more guessing with a time window.
    const d = t.decision_id
      ? (db
          // AND agent_id: decisions.id is a global autoincrement, so an unscoped
          // WHERE id = ? could surface another tenant's decision row (their
          // strategy's reasoning) if a decision_id ever collided across the
          // shared ledger. Pinning the tenant makes that structurally impossible.
          .prepare("SELECT source, action, symbol, size_usdg, reason, dropped_rule FROM decisions WHERE id = ? AND agent_id = ?")
          .get(t.decision_id, who) as
          | { source: string; action: string | null; symbol: string | null; size_usdg: number | null; reason: string | null; dropped_rule: string | null }
          | undefined)
      : undefined;
    if (d) {
      const head = [d.action, d.symbol, d.size_usdg != null ? `${d.size_usdg.toFixed(2)} USDG` : null].filter(Boolean).join(" ");
      lines.push(`• decision: ${esc(head || d.source)} · via ${esc(d.source)}`);
      if (d.reason) lines.push(`• my reasoning: ${esc(d.reason.slice(0, 220))}`);
      if (d.dropped_rule) lines.push(`• dropped: ${esc(d.dropped_rule.slice(0, 140))}`);
    } else {
      // Legacy fallback for trades written before decisions existed: the old
      // ±15-min event-window guess. New trades never take this path.
      try {
        const tradeUnix =
          typeof t.created_at === "number" ? t.created_at : Math.floor(new Date(t.created_at).getTime() / 1000);
        const evs = db
          .prepare(
            "SELECT message FROM events WHERE agent_id = ? AND created_at BETWEEN ? AND ? ORDER BY created_at DESC, id DESC LIMIT 4",
          )
          .all(who, tradeUnix - 900, tradeUnix + 900) as { message: string }[];
        if (evs.length) {
          lines.push(`• what was on my mind (approx):`);
          for (const e of evs) lines.push(`  · ${esc(e.message.slice(0, 140))}`);
        }
      } catch {
        /* no events */
      }
    }
    return { text: lines.join("\n"), hasTrade: true };
  } finally {
    db.close();
  }
}

/** Recent event-feed lines (for the LLM's context). */
export function readRecentEvents(agentId?: string | null, limit = 5): string {
  const db = openRO();
  if (!db) return "(no events)";
  try {
    const who = resolveAgent(db, agentId);
    if (!who) return "(no events)";
    const rows = db
      .prepare("SELECT level, message, datetime(created_at,'unixepoch') AS at FROM events WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(who, limit) as { level: string; message: string; at: string }[];
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
    strip(readPositions(ctx.agentId)),
    "",
    strip(readPnl(ctx.agentId)),
    "",
    strip(readTrades(ctx.agentId)),
    "",
    "RECENT EVENTS:",
    readRecentEvents(ctx.agentId, 5),
  ].join("\n");
}

/**
 * Answer for /grant, /wallet, /restore, /recover… — the commands people type in
 * chat after reading "go to /grant". Wallet actions can't happen here (the owner
 * key must never touch a chat app), so this is a signpost to the local dashboard
 * rather than a dead end.
 */
const WALLET_TEXT_LINES = [
  "🏹 <b>your wallet lives in the dashboard</b> — not in chat.",
  "",
  "Open <b>http://localhost:3100/grant</b> on the machine running merrymen:",
  "• <b>new wallet</b> — create an agent wallet, then fund it. on <b>mainnet</b>: ETH (gas) + USDG (trading capital). on <b>testnet</b>: gas only — USDG sent to a testnet account is never shown and never traded",
  "• <b>restore a funded wallet</b> — paste your owner key to bring an already-funded wallet back: same address, same funds, no gas (on testnet the USDG figure still reads 0 — merrymen only knows mainnet token addresses; the ETH figure is real)",
  "• if it says <i>“this wallet isn’t active”</i> → hit <b>re-arm this wallet</b> (one click, no key needed)",
  "",
  "To move funds <b>out</b>: the dashboard’s <b>recover funds</b> panel, or run <code>merrymen recover</code> in your terminal.",
  "",
  "Heads-up: the address you funded is a <b>smart account</b>, not a MetaMask wallet — importing your owner key into MetaMask shows a different, empty address. That’s normal; your funds are safe at the account address.",
  "",
  "Why not here? Your owner key never touches chat — wallet actions stay on your machine.",
];

/** The signpost alone, for callers with no ledger to read. */
export const WALLET_TEXT = WALLET_TEXT_LINES.join("\n");

/**
 * `/wallet`, leading with the ONE fact that resolves the confusion: the address.
 *
 * A user imported his owner key into MetaMask, saw an empty wallet, and told us
 * “I don't see my money… which is not the wallet I've sent tokens to.” Every
 * observable fact in that message is correct; only the conclusion is wrong.
 *
 * The explanation already existed — in the grant page, the recovery panel, the
 * README, and the last line of the signpost below. He hit it anyway, and his own
 * message shows why: he was holding two addresses and nothing put them side by
 * side and said which was which. A paragraph about smart accounts does not
 * answer “is MY money gone”. His own address, printed, does.
 *
 * So the address leads and the concept follows it, rather than the other way
 * round. This is also why it became a function — the static export could not
 * reach the ledger to know the address.
 */
export function readWallet(agentId?: string | null, dashboardUrl?: string): string {
  const base = dashboardUrl ?? "http://localhost:3100";
  const signpost = WALLET_TEXT_LINES.map((l) =>
    l.split("http://localhost:3100").join(base),
  );
  const db = openRO();
  if (!db) return signpost.join("\n");
  let who: string | null = null;
  try {
    who = resolveAgent(db, agentId);
  } catch {
    /* pre-migration ledger — the signpost still stands on its own */
  } finally {
    db.close();
  }
  if (!who) return signpost.join("\n");
  return [
    "🏹 <b>your agent's account</b> — this is where your money is:",
    `<code>${esc(who)}</code>`,
    "",
    "That address is a <b>smart account</b>. Your owner key CONTROLS it but is not",
    "it — import the key into MetaMask and MetaMask shows the KEY's own address,",
    "which is empty and always will be. Nothing is lost; there are two addresses",
    "and that is the other one. Compare what MetaMask shows against the address",
    "above.",
    "",
    ...signpost,
  ].join("\n");
}

export const HELP_TEXT = [
  "🏹 <b>merryman — commands</b>",
  "/status · /positions · /pnl · /trades — see what the band's doing",
  "/depth &lt;SYM&gt; — where the money sits: liquidity, support and resistance, live from the chain",
  "/report — today's campfire report · /brag — your scorecard",
  "/why — why I made my last trade",
  "/name &lt;name&gt; — christen your merryman · /soul — who I am &amp; what I know of you",
  "/remember &lt;fact&gt; — tell me something to keep · /forget — wipe what I know",
  "/pause · /resume — hold or ride",
  "/strategy &lt;name&gt; — switch strategy (steady-basket, weekend-gap, llm-strategist, or your own)",
  "/cap &lt;usdg&gt; — set the per-action ceiling for chat trades",
  "/buy &lt;SYM&gt; &lt;usdg&gt; · /sell &lt;SYM&gt; &lt;usdg&gt; — trade (passes the policy wall)",
  "/transfer &lt;0x…&gt; &lt;usdg&gt; — send USDG out (asks you to /confirm; enable in dashboard)",
  "/alert &lt;SYM&gt; &gt; &lt;price&gt; — ping me at a price · /alerts · /unalert &lt;n&gt;",
  "/wallet — create, restore, or recover a wallet (points you to the dashboard)",
  "/kill — destroy the grant, stand the band down",
  "",
  "🖥️ <b>your PC</b> (enable in dashboard → remote control):",
  "/shot — screenshot · /look &lt;q&gt; — what am I looking at? · /sys — system info",
  "/open &lt;app|url&gt; · /vol &lt;up|down|mute&gt; · /media &lt;play|pause|next|prev&gt; · /notify &lt;msg&gt; · /lock",
  "/ls [path] · /get &lt;path&gt; · /clip [text] — browse/send files, clipboard",
  "/run &lt;cmd&gt; · /type &lt;text&gt; · /key &lt;combo&gt; — shell/keyboard (allowlisted + /confirm)",
  "/remind &lt;20m&gt; &lt;msg&gt; · /watch &lt;cpu&gt;80|file …|proc …&gt; · /pc — what's enabled",
  "/agent &lt;task&gt; — or just ask in plain English: I work your PC in steps (code, build, fix, report) until done · say “stop” to halt",
  "",
  "…or just talk to me in plain English once an AI provider is set in Settings — voice notes work too.",
].join("\n");
