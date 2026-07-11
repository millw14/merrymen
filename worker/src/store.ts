/**
 * Trade/event/equity persistence — SQLite (node:sqlite, built into Node 22+).
 * One durable file at .data/merrymen.db shared by worker (writer) and web
 * (reader via /api/feed). No external service, no keys. Migration path to
 * Postgres is a schema port when the platform goes multi-user.
 */

import { DatabaseSync } from "node:sqlite";
import type { StoredGrant } from "../../packages/core/src/index";
import { ensureHome, homePaths } from "./home";

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (db) return db;
  ensureHome();
  const DB_FILE = homePaths.db();
  db = new DatabaseSync(DB_FILE);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      smart_account TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Robin',
      owner_address TEXT NOT NULL,
      session_key_address TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      caps TEXT NOT NULL,
      granted_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'armed',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'ok',
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS events_agent_time ON events (agent_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      target TEXT NOT NULL,
      sell_token TEXT,
      buy_token TEXT,
      amount_usdg REAL NOT NULL,
      user_op_hash TEXT,
      tx_hash TEXT,
      status TEXT NOT NULL,
      reject_rule TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS trades_agent_time ON trades (agent_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS equity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      eth_wei TEXT NOT NULL,
      cash_usdg REAL NOT NULL,
      vault_usdg REAL NOT NULL,
      equity_usdg REAL NOT NULL,
      at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS equity_agent_time ON equity (agent_id, at DESC);
    CREATE TABLE IF NOT EXISTS fee_accruals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      profit_usdg REAL NOT NULL,
      fee_usdg REAL NOT NULL,
      hwm_before_usdg REAL NOT NULL,
      hwm_after_usdg REAL NOT NULL,
      at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS fee_accruals_agent_time ON fee_accruals (agent_id, at DESC);
    CREATE TABLE IF NOT EXISTS positions (
      agent_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      token TEXT NOT NULL,
      raw_balance TEXT NOT NULL,
      ui_multiplier TEXT NOT NULL,
      price_usd REAL NOT NULL,
      price_stale INTEGER NOT NULL DEFAULT 0,
      value_usdg REAL NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (agent_id, symbol)
    );
  `);
  for (const ddl of [
    "ALTER TABLE equity ADD COLUMN positions_usdg REAL NOT NULL DEFAULT 0",
    // Persistent high-water mark + running fee total — HWM must survive
    // restarts or the breaker and the fee ledger both forget the peak.
    "ALTER TABLE agents ADD COLUMN hwm_usdg REAL NOT NULL DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN accrued_fee_usdg REAL NOT NULL DEFAULT 0",
    // Simulation receipt: what the pre-trade quote promised, on the record.
    "ALTER TABLE trades ADD COLUMN sim_quote_out TEXT",
    "ALTER TABLE trades ADD COLUMN sim_min_out TEXT",
    "ALTER TABLE trades ADD COLUMN sim_fee_tier INTEGER",
    "ALTER TABLE trades ADD COLUMN sim_gas TEXT",
  ]) {
    try {
      db.exec(ddl);
    } catch {
      // column already exists
    }
  }
  console.log(`[store] sqlite at ${DB_FILE}`);
  return db;
}

/** Create the DB + schema eagerly so a broken store fails at startup, not mid-trade. */
export function initStore(): void {
  getDb();
}

export interface TradeRow {
  agent_id: string;
  kind: string;
  target: string;
  sell_token?: string;
  buy_token?: string;
  amount_usdg: number;
  user_op_hash?: string;
  tx_hash?: string;
  status: "landed" | "reverted" | "rejected";
  reject_rule?: string;
  created_at: string;
  /** Simulation receipt (Uniswap QuoterV2): quoted out, slippage-bounded min, tier, gas. */
  sim_quote_out?: string;
  sim_min_out?: string;
  sim_fee_tier?: number;
  sim_gas?: string;
}

export async function ensureAgent(grant: StoredGrant): Promise<string> {
  getDb()
    .prepare(
      `INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(smart_account) DO UPDATE SET
         caps = excluded.caps, expires_at = excluded.expires_at, session_key_address = excluded.session_key_address`,
    )
    .run(
      grant.smartAccount,
      grant.owner,
      grant.sessionKeyAddress,
      grant.chainId,
      JSON.stringify(grant.caps),
      grant.grantedAt,
      grant.expiresAt,
    );
  return grant.smartAccount;
}

/** Persisted HWM + accrued fees, loaded at arm time. */
export async function getAgentFinancials(
  agentId: string,
): Promise<{ hwmUsdg: number; accruedFeeUsdg: number }> {
  const row = getDb()
    .prepare("SELECT hwm_usdg, accrued_fee_usdg FROM agents WHERE smart_account = ?")
    .get(agentId) as { hwm_usdg: number; accrued_fee_usdg: number } | undefined;
  return { hwmUsdg: row?.hwm_usdg ?? 0, accruedFeeUsdg: row?.accrued_fee_usdg ?? 0 };
}

/** Ratchet the persisted HWM (monotonic — ignores values below the stored peak). */
export async function setAgentHwm(agentId: string, hwmUsdg: number): Promise<void> {
  try {
    getDb()
      .prepare("UPDATE agents SET hwm_usdg = MAX(hwm_usdg, ?) WHERE smart_account = ?")
      .run(hwmUsdg, agentId);
  } catch (e) {
    console.error("[store] hwm update failed:", e);
  }
}

/** Record one accrual event and roll it into the agent's running total. */
export async function addFeeAccrual(
  agentId: string,
  a: { profitUsdg: number; feeUsdg: number; hwmBeforeUsdg: number; hwmAfterUsdg: number },
): Promise<void> {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO fee_accruals (agent_id, profit_usdg, fee_usdg, hwm_before_usdg, hwm_after_usdg)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(agentId, a.profitUsdg, a.feeUsdg, a.hwmBeforeUsdg, a.hwmAfterUsdg);
    db.prepare(
      "UPDATE agents SET accrued_fee_usdg = accrued_fee_usdg + ? WHERE smart_account = ?",
    ).run(a.feeUsdg, agentId);
  } catch (e) {
    console.error("[store] fee accrual failed:", e);
  }
}

export async function setAgentStatus(
  agentId: string,
  status: "armed" | "active" | "killed" | "expired",
): Promise<void> {
  try {
    getDb().prepare("UPDATE agents SET status = ? WHERE smart_account = ?").run(status, agentId);
  } catch (e) {
    console.error("[store] status update failed:", e);
  }
}

export async function addEvent(
  agentId: string,
  level: "ok" | "warn" | "err",
  message: string,
): Promise<void> {
  try {
    getDb()
      .prepare("INSERT INTO events (agent_id, level, message) VALUES (?, ?, ?)")
      .run(agentId, level, message);
  } catch (e) {
    console.error("[store] event insert failed:", e);
  }
}

export async function addTrade(row: TradeRow): Promise<void> {
  try {
    getDb()
      .prepare(
        `INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, user_op_hash, tx_hash, status, reject_rule,
                             sim_quote_out, sim_min_out, sim_fee_tier, sim_gas)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.agent_id,
        row.kind,
        row.target,
        row.sell_token ?? null,
        row.buy_token ?? null,
        row.amount_usdg,
        row.user_op_hash ?? null,
        row.tx_hash ?? null,
        row.status,
        row.reject_rule ?? null,
        row.sim_quote_out ?? null,
        row.sim_min_out ?? null,
        row.sim_fee_tier ?? null,
        row.sim_gas ?? null,
      );
  } catch (e) {
    console.error("[store] trade insert failed:", e);
  }
}

export async function addEquity(
  agentId: string,
  b: { ethWei: bigint; cashUsdg: number; vaultUsdg: number; positionsUsdg: number },
): Promise<void> {
  try {
    getDb()
      .prepare(
        "INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        agentId,
        b.ethWei.toString(),
        b.cashUsdg,
        b.vaultUsdg,
        b.positionsUsdg,
        b.cashUsdg + b.vaultUsdg + b.positionsUsdg,
      );
  } catch (e) {
    console.error("[store] equity insert failed:", e);
  }
}

/** Latest holdings snapshot — replaces, then prunes symbols no longer held. */
export async function setPositions(
  agentId: string,
  positions: readonly {
    symbol: string;
    token: string;
    rawBalance: bigint;
    uiMultiplier: bigint;
    priceUsd: number;
    priceStale: boolean;
    valueUsdg: number;
  }[],
): Promise<void> {
  try {
    const db = getDb();
    const upsert = db.prepare(
      `INSERT INTO positions (agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, price_stale, value_usdg, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
       ON CONFLICT(agent_id, symbol) DO UPDATE SET
         raw_balance = excluded.raw_balance, ui_multiplier = excluded.ui_multiplier,
         price_usd = excluded.price_usd, price_stale = excluded.price_stale,
         value_usdg = excluded.value_usdg, updated_at = excluded.updated_at`,
    );
    for (const p of positions) {
      upsert.run(
        agentId,
        p.symbol,
        p.token,
        p.rawBalance.toString(),
        p.uiMultiplier.toString(),
        p.priceUsd,
        p.priceStale ? 1 : 0,
        p.valueUsdg,
      );
    }
    const held = positions.map((p) => p.symbol);
    const placeholders = held.map(() => "?").join(",");
    db.prepare(
      held.length
        ? `DELETE FROM positions WHERE agent_id = ? AND symbol NOT IN (${placeholders})`
        : "DELETE FROM positions WHERE agent_id = ?",
    ).run(agentId, ...held);
  } catch (e) {
    console.error("[store] positions update failed:", e);
  }
}

/** Landed op count in the trailing 24h — seeds the ops-cap counter across restarts. */
export async function getOpsToday(agentId: string): Promise<number> {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM trades
       WHERE agent_id = ? AND status = 'landed' AND created_at > unixepoch() - 86400`,
    )
    .get(agentId) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Rename the agent — the user-given merryman name (shown on the dashboard). */
export async function setAgentName(agentId: string, name: string): Promise<void> {
  try {
    getDb().prepare(`UPDATE agents SET name = ? WHERE smart_account = ?`).run(name, agentId);
  } catch (e) {
    console.error("[store] agent rename failed:", e);
  }
}

/** Sum of landed chat transfers in the trailing 24h — the transfer sub-budget. */
export async function getTransferredTodayUsdg(agentId: string): Promise<number> {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(amount_usdg), 0) AS spent FROM trades
       WHERE agent_id = ? AND status = 'landed' AND kind = 'transfer'
         AND created_at > unixepoch() - 86400`,
    )
    .get(agentId) as { spent: number } | undefined;
  return row?.spent ?? 0;
}

/** Sum of landed spend in the trailing 24h — seeds the daily-cap counter across restarts. */
export async function getSpentTodayUsdg(agentId: string): Promise<number> {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(amount_usdg), 0) AS spent FROM trades
       WHERE agent_id = ? AND status = 'landed' AND kind != 'vault-withdraw'
         AND created_at > unixepoch() - 86400`,
    )
    .get(agentId) as { spent: number } | undefined;
  return row?.spent ?? 0;
}
