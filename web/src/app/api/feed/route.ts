/**
 * Agent history for the dashboard: events + equity series, read from the
 * shared SQLite file the worker writes (.data/merrymen.db).
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const DB_FILE = path.join(process.cwd(), "..", ".data", "merrymen.db");

export interface FeedEvent {
  level: "ok" | "warn" | "err";
  message: string;
  created_at: string;
}
export interface EquityPoint {
  cash_usdg: number;
  vault_usdg: number;
  equity_usdg: number;
  at: string;
}
export interface PositionRow {
  symbol: string;
  raw_balance: string;
  ui_multiplier: string;
  price_usd: number;
  price_stale: number;
  value_usdg: number;
}
export interface FeedResponse {
  source: "sqlite" | "none";
  events: FeedEvent[];
  equity: EquityPoint[];
  positions: PositionRow[];
}

export async function GET() {
  if (!existsSync(DB_FILE)) {
    return NextResponse.json({
      source: "none",
      events: [],
      equity: [],
      positions: [],
    } satisfies FeedResponse);
  }

  // Read-only open so the worker stays the single writer. Tolerate a DB the
  // worker hasn't fully initialized yet — missing tables read as empty.
  const db = new DatabaseSync(DB_FILE, { readOnly: true });
  try {
    let events: FeedEvent[] = [];
    let equity: EquityPoint[] = [];
    let positions: PositionRow[] = [];
    try {
      events = db
        .prepare(
          `SELECT level, message, datetime(created_at, 'unixepoch') AS created_at
           FROM events ORDER BY created_at DESC, id DESC LIMIT 40`,
        )
        .all() as unknown as FeedEvent[];
    } catch {
      /* table not created yet */
    }
    try {
      equity = db
        .prepare(
          `SELECT cash_usdg, vault_usdg, equity_usdg, datetime(at, 'unixepoch') AS at
           FROM (SELECT * FROM equity ORDER BY at DESC, id DESC LIMIT 288)
           ORDER BY at ASC, id ASC`,
        )
        .all() as unknown as EquityPoint[];
    } catch {
      /* table not created yet */
    }
    try {
      positions = db
        .prepare(
          `SELECT symbol, raw_balance, ui_multiplier, price_usd, price_stale, value_usdg
           FROM positions ORDER BY value_usdg DESC`,
        )
        .all() as unknown as PositionRow[];
    } catch {
      /* table not created yet */
    }
    return NextResponse.json({ source: "sqlite", events, equity, positions } satisfies FeedResponse);
  } finally {
    db.close();
  }
}
