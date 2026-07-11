/**
 * The honest scoreboard — every agent that ever ran, its full P&L history,
 * drawdown, fee accruals, and trade record, straight from the worker's SQLite.
 * Transparency is the trust product: rejected and reverted trades are shown
 * with the same weight as landed ones.
 */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { NextResponse } from "next/server";
import { homePaths } from "@/lib/home";

export const dynamic = "force-dynamic";

const DB_FILE = homePaths.db();

export interface ScoreboardEquityPoint {
  equity_usdg: number;
  at: string;
}

export interface ScoreboardAgent {
  smart_account: string;
  name: string;
  status: string;
  chain_id: number;
  caps: Record<string, number>;
  granted_at: number;
  expires_at: number;
  hwm_usdg: number;
  accrued_fee_usdg: number;
  equity: ScoreboardEquityPoint[];
  pnl_usdg: number | null;
  max_drawdown_bps: number;
  trades: { landed: number; rejected: number; reverted: number; volume_usdg: number };
}

export interface ScoreboardResponse {
  source: "sqlite" | "none";
  agents: ScoreboardAgent[];
}

export async function GET() {
  if (!existsSync(DB_FILE)) {
    return NextResponse.json({ source: "none", agents: [] } satisfies ScoreboardResponse);
  }

  const db = new DatabaseSync(DB_FILE, { readOnly: true });
  try {
    let rows: Record<string, unknown>[] = [];
    try {
      rows = db
        .prepare(
          `SELECT smart_account, name, status, chain_id, caps, granted_at, expires_at,
                  COALESCE(hwm_usdg, 0) AS hwm_usdg, COALESCE(accrued_fee_usdg, 0) AS accrued_fee_usdg
           FROM agents ORDER BY created_at DESC`,
        )
        .all() as Record<string, unknown>[];
    } catch {
      return NextResponse.json({ source: "sqlite", agents: [] } satisfies ScoreboardResponse);
    }

    const agents: ScoreboardAgent[] = rows.map((row) => {
      const account = row.smart_account as string;

      let equity: ScoreboardEquityPoint[] = [];
      try {
        equity = db
          .prepare(
            `SELECT equity_usdg, datetime(at, 'unixepoch') AS at
             FROM (SELECT * FROM equity WHERE agent_id = ? ORDER BY at DESC, id DESC LIMIT 500)
             ORDER BY at ASC, id ASC`,
          )
          .all(account) as unknown as ScoreboardEquityPoint[];
      } catch {
        /* table not created yet */
      }

      let peak = 0;
      let maxDdBps = 0;
      for (const p of equity) {
        peak = Math.max(peak, p.equity_usdg);
        if (peak > 0 && p.equity_usdg < peak) {
          maxDdBps = Math.max(maxDdBps, Math.round(((peak - p.equity_usdg) / peak) * 10_000));
        }
      }

      let trades = { landed: 0, rejected: 0, reverted: 0, volume_usdg: 0 };
      try {
        const t = db
          .prepare(
            `SELECT
               SUM(CASE WHEN status = 'landed' THEN 1 ELSE 0 END) AS landed,
               SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
               SUM(CASE WHEN status = 'reverted' THEN 1 ELSE 0 END) AS reverted,
               COALESCE(SUM(CASE WHEN status = 'landed' AND kind != 'vault-withdraw' THEN amount_usdg ELSE 0 END), 0) AS volume
             FROM trades WHERE agent_id = ?`,
          )
          .get(account) as { landed: number; rejected: number; reverted: number; volume: number };
        trades = {
          landed: t.landed ?? 0,
          rejected: t.rejected ?? 0,
          reverted: t.reverted ?? 0,
          volume_usdg: t.volume ?? 0,
        };
      } catch {
        /* table not created yet */
      }

      let caps: Record<string, number> = {};
      try {
        caps = JSON.parse(row.caps as string) as Record<string, number>;
      } catch {
        /* legacy row */
      }

      return {
        smart_account: account,
        name: (row.name as string) ?? "Robin",
        status: row.status as string,
        chain_id: row.chain_id as number,
        caps,
        granted_at: row.granted_at as number,
        expires_at: row.expires_at as number,
        hwm_usdg: row.hwm_usdg as number,
        accrued_fee_usdg: row.accrued_fee_usdg as number,
        equity,
        pnl_usdg:
          equity.length >= 2 ? equity[equity.length - 1]!.equity_usdg - equity[0]!.equity_usdg : null,
        max_drawdown_bps: maxDdBps,
        trades,
      };
    });

    return NextResponse.json({ source: "sqlite", agents } satisfies ScoreboardResponse);
  } finally {
    db.close();
  }
}
