/**
 * Trade/event/equity persistence — SQLite (node:sqlite, built into Node 22+).
 * One durable file at .data/merrymen.db shared by worker (writer) and web
 * (reader via /api/feed). No external service, no keys. Migration path to
 * Postgres is a schema port when the platform goes multi-user.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StoredGrant } from "@merrymen/core";

const DATA_DIR = path.join(process.cwd(), "..", ".data");
const DB_FILE = path.join(DATA_DIR, "merrymen.db");

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
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
  `);
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
        `INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, user_op_hash, tx_hash, status, reject_rule)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
  } catch (e) {
    console.error("[store] trade insert failed:", e);
  }
}

export async function addEquity(
  agentId: string,
  b: { ethWei: bigint; cashUsdg: number; vaultUsdg: number },
): Promise<void> {
  try {
    getDb()
      .prepare(
        "INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, equity_usdg) VALUES (?, ?, ?, ?, ?)",
      )
      .run(agentId, b.ethWei.toString(), b.cashUsdg, b.vaultUsdg, b.cashUsdg + b.vaultUsdg);
  } catch (e) {
    console.error("[store] equity insert failed:", e);
  }
}

/** Sum of landed spend in the trailing 24h — seeds the daily-cap counter across restarts. */
export async function getSpentTodayUsdg(agentId: string): Promise<number> {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(amount_usdg), 0) AS spent FROM trades
       WHERE agent_id = ? AND status = 'landed' AND created_at > unixepoch() - 86400`,
    )
    .get(agentId) as { spent: number } | undefined;
  return row?.spent ?? 0;
}
