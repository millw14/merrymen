import type { Db } from "./db";

/** Positive evidence only; absent tables/columns/projections never mean empty. */
export async function initialCapitalHistoryEmpty(db: Db, account: string, options: {
  /** Local retries may contain the exact complete batch, checked by the booker. */
  ignoreFlows?: boolean;
  /** A failed first receipt read can have written a funded but held valuation. */
  heldCashUsdg?: number;
  /** Exact complete-batch retries may already have a settled funded valuation. */
  bookedCashUsdg?: number;
  /** Shared proof can include a first funding whose failed scan held its mark. */
  allowHeldCash?: boolean;
} = {}): Promise<boolean> {
  const checks = [
    ...(options.ignoreFlows ? [] : ["flows"]),
    "fee_accruals", "class_positions", "risk_periods", "owner_operations",
  ].map(table => `SELECT COUNT(*) AS n FROM ${table} WHERE LOWER(agent_id) = LOWER(?)`);
  checks.push(
    "SELECT COUNT(*) AS n FROM cost_basis WHERE LOWER(agent_id) = LOWER(?) AND mode <> 'paper'",
    "SELECT COUNT(*) AS n FROM trench_positions WHERE LOWER(agent_id) = LOWER(?) AND mode <> 'paper'",
    // Explicit simulations carry no chain identity and keep their own book.
    // A 'paper' label on a broadcast or unattributed fill is insufficient.
    `SELECT COUNT(*) AS n FROM trades WHERE LOWER(agent_id) = LOWER(?) AND
      (tx_hash IS NOT NULL OR user_op_hash IS NOT NULL
       OR (status <> 'rejected' AND (status <> 'paper' OR basis_source IS NULL OR basis_source <> 'paper')))`,
    // positions is a disposable snapshot with no mode column. Only a latest
    // explicitly paper valuation can identify it as the simulated snapshot;
    // live/unknown holdings are never dismissed this way.
    `SELECT COUNT(*) AS n FROM positions WHERE LOWER(agent_id) = LOWER(?) AND (raw_balance <> '0' OR value_usdg <> 0)
      AND COALESCE((SELECT mode FROM equity WHERE LOWER(equity.agent_id) = LOWER(positions.agent_id)
        ORDER BY at DESC, id DESC LIMIT 1), 'unknown') <> 'paper'`,
    `SELECT COUNT(*) AS n FROM equity WHERE LOWER(agent_id) = LOWER(?) AND
      (epoch <> 1 OR mode IS NULL OR mode NOT IN ('live', 'paper') OR (mode = 'live' AND
      (vault_usdg <> 0 OR positions_usdg <> 0 OR equity_usdg <> cash_usdg OR cash_usdg < 0 OR ${options.bookedCashUsdg !== undefined
        ? "cash_usdg > ?"
        : options.heldCashUsdg === undefined
         ? options.allowHeldCash ? "(cash_usdg <> 0 AND COALESCE(flows_held, 0) <> 1)" : "cash_usdg <> 0"
         : "(cash_usdg <> 0 AND (COALESCE(flows_held, 0) <> 1 OR cash_usdg > ?))"})))`,
  );
  try {
    for (const query of checks) {
      const params = query.includes("cash_usdg > ?") ? [account, options.bookedCashUsdg ?? options.heldCashUsdg!] : [account];
      const row = await db.prepare(query).get(...params) as { n?: unknown } | undefined;
      if (!row || (typeof row.n !== "number" && typeof row.n !== "string") || Number(row.n) !== 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}
