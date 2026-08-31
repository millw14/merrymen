/**
 * Carrying each tenant's ledger up to the shared database, so the dashboard can
 * see what its agent did.
 *
 * THE HOLE THIS FILLS. `db.ts` was built so a hosted deploy could put the ledger
 * in shared Postgres — its header says "so the web service can read what a
 * worker writes". But `childEnv` strips DATABASE_URL from every worker child, on
 * purpose: the URL reaches the shared grant store, and a compromised child must
 * not be able to read every tenant's rows. The two decisions are each defensible
 * and together they mean a child writes sqlite inside its own container while
 * the web service reads a Postgres nothing ever wrote to.
 *
 * The consequence was invisible and total: no trade tape, no positions, no
 * equity curve, no events and no reasoning on app.merrymen.dev, for anyone,
 * whatever the agent was doing. Balances still appeared because the web reads
 * those from the chain directly, which is exactly why it looked like a working
 * dashboard with a quiet agent.
 *
 * WHY MIRRORING RATHER THAN HANDING CHILDREN THE URL. Giving a child
 * DATABASE_URL is one line and undoes the isolation deliberately: every child
 * would be able to read every other tenant's ledger. The orchestrator already
 * has the URL, already supervises every child, and already knows where each
 * one's home is. It is the one process that can do this without widening
 * anybody's reach.
 *
 * EXACTLY-ONCE, BY TRANSACTION. Source rows carry ids that are only unique
 * WITHIN one child's database — two tenants both have event id 1 — so the id
 * cannot be the destination key. Instead each batch inserts its rows and
 * advances its watermark in ONE Postgres transaction: a crash mid-batch rolls
 * back both, and the next pass re-reads the same range. The alternative
 * (insert, then save the watermark) duplicates the tape every time a deploy
 * lands mid-copy, which on a trade ledger is worse than lagging.
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { existsSync } from "node:fs";
import type { Db } from "./db";
import { wrapSqlite } from "./db";

/** Rows per table per pass. Bounded so one busy tenant cannot starve the rest. */
export const MIRROR_BATCH = 500;

/** The append-only tables, and the column their watermark is measured in. */
const LOG_TABLES = [
  { table: "events", cols: ["agent_id", "level", "message", "created_at"] },
  {
    table: "trades",
    cols: [
      "agent_id",
      "kind",
      "target",
      "sell_token",
      "buy_token",
      "amount_usdg",
      "user_op_hash",
      "tx_hash",
      "status",
      "reject_rule",
      // THE EVIDENCE COLUMNS. This list was 11 columns and carried none of the
      // fill or basis data, so everything the ledger knows about WHAT a trade
      // actually filled at existed only in the child's local sqlite and never
      // reached the shared database behind the dashboard. A proof that holds
      // only where nobody can see it is not a proof.
      "decision_id",
      "fill_side",
      "fill_qty_raw",
      "fill_price_usd",
      "realized_pnl_usdg",
      "basis_source",
      "gas_wei",
      "created_at",
    ],
  },
  { table: "equity", cols: ["agent_id", "eth_wei", "cash_usdg", "vault_usdg", "equity_usdg", "at"] },
] as const;

/**
 * Where each tenant's copy has got to.
 *
 * Lives in the destination rather than on disk so it commits with the rows it
 * describes. `last_id` is the source database's id, which is meaningful only
 * alongside the tenant it came from — hence the composite key.
 */
export const MIRROR_STATE_DDL = `
  CREATE TABLE IF NOT EXISTS mirror_state (
    tenant TEXT NOT NULL,
    table_name TEXT NOT NULL,
    last_id INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant, table_name)
  );
`;

export interface MirrorReport {
  tenant: string;
  /** Rows copied per table this pass. Absent tables were empty or unreadable. */
  copied: Record<string, number>;
  /** Set when the child's ledger could not be opened at all. */
  skipped?: string;
}

/** Open a child's ledger READ-ONLY. Its worker is running and writing to it. */
export function openChildLedger(home: string): Db | null {
  const file = path.join(home, "merrymen.db");
  if (!existsSync(file)) return null;
  try {
    // readOnly so a bug here can never corrupt a live agent's ledger, and so
    // this can never take a write lock the worker is waiting on.
    return wrapSqlite(new DatabaseSync(file, { readOnly: true }));
  } catch {
    return null;
  }
}

/**
 * Copy one tenant's ledger forward.
 *
 * Never throws: a tenant whose ledger is mid-write, corrupt, or simply absent
 * must not stop the others being mirrored, and must not take the orchestrator
 * down — it supervises the fleet and is the last process that should die.
 */
export async function mirrorTenant(args: {
  tenant: string;
  child: Db;
  shared: Db;
  batch?: number;
  nowSec?: number;
}): Promise<MirrorReport> {
  const { tenant, child, shared } = args;
  const batch = args.batch ?? MIRROR_BATCH;
  const nowSec = args.nowSec ?? Math.floor(Date.now() / 1000);
  const copied: Record<string, number> = {};

  // ── append-only tables ────────────────────────────────────────────────────
  for (const { table, cols } of LOG_TABLES) {
    try {
      const mark = (await shared
        .prepare(`SELECT last_id FROM mirror_state WHERE tenant = ? AND table_name = ?`)
        .get(tenant, table)) as { last_id: number } | undefined;
      const from = mark?.last_id ?? 0;

      const rows = (await child
        .prepare(`SELECT id, ${cols.join(", ")} FROM ${table} WHERE id > ? ORDER BY id ASC LIMIT ?`)
        .all(from, batch)) as Record<string, unknown>[];
      if (!rows.length) continue;

      const highest = Number(rows[rows.length - 1]!.id);
      // One transaction: the rows and the watermark that says they arrived.
      // Split them and a crash between the two duplicates the tape forever.
      await shared.tx(async (db) => {
        const ins = db.prepare(
          `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        );
        for (const r of rows) await ins.run(...cols.map((c) => r[c] ?? null));
        await db
          .prepare(
            `INSERT INTO mirror_state (tenant, table_name, last_id, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (tenant, table_name) DO UPDATE SET last_id = excluded.last_id, updated_at = excluded.updated_at`,
          )
          .run(tenant, table, highest, nowSec);
      });
      copied[table] = rows.length;
    } catch {
      // One table failing is one table's worth of lag, not a reason to abandon
      // the others — and the watermark did not move, so the next pass retries.
      continue;
    }
  }

  // ── decisions: append-only, but already globally unique ───────────────────
  // The id is a uuid, so the destination key is safe to reuse and ON CONFLICT
  // is enough. No watermark: the reasoning tape is small and the conflict is
  // cheaper than the bookkeeping.
  try {
    const rows = (await child
      .prepare(
        `SELECT id, agent_id, source, strategy, provider, model, symbol, action, size_usdg,
                reason, dropped_rule, signals_json, at
         FROM decisions ORDER BY at DESC LIMIT ?`,
      )
      .all(batch)) as Record<string, unknown>[];
    if (rows.length) {
      await shared.tx(async (db) => {
        const ins = db.prepare(
          `INSERT INTO decisions (id, agent_id, source, strategy, provider, model, symbol, action,
                                  size_usdg, reason, dropped_rule, signals_json, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
        );
        for (const r of rows) {
          await ins.run(
            r.id, r.agent_id, r.source, r.strategy ?? null, r.provider ?? null, r.model ?? null,
            r.symbol ?? null, r.action ?? null, r.size_usdg ?? null, r.reason ?? null,
            r.dropped_rule ?? null, r.signals_json ?? null, r.at,
          );
        }
      });
      copied.decisions = rows.length;
    }
  } catch {
    /* as above */
  }

  // ── snapshot tables: upsert by their own key ──────────────────────────────
  // `agents` and `positions` describe the world NOW rather than what happened,
  // so there is no watermark to keep — the current row simply replaces the
  // stored one. A position that closed is deleted at the source and would
  // otherwise linger here, so the whole set is replaced per agent.
  try {
    const agents = (await child
      .prepare(
        `SELECT smart_account, name, owner_address, session_key_address, chain_id, caps,
                granted_at, expires_at, status, created_at, mode, beat_at FROM agents`,
      )
      .all()) as Record<string, unknown>[];
    if (agents.length) {
      await shared.tx(async (db) => {
        const ins = db.prepare(
          `INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id,
                               caps, granted_at, expires_at, status, created_at, mode, beat_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (smart_account) DO UPDATE SET
             name = excluded.name, status = excluded.status, caps = excluded.caps,
             expires_at = excluded.expires_at, mode = excluded.mode,
             beat_at = excluded.beat_at`,
        );
        for (const a of agents) {
          await ins.run(
            a.smart_account, a.name, a.owner_address, a.session_key_address, a.chain_id,
            a.caps, a.granted_at, a.expires_at, a.status, a.created_at,
            // Nullable on purpose: an agent that has never beaten has no mode,
            // and null is the honest value for that. It renders as IDLE, which
            // is what it is.
            a.mode ?? null, a.beat_at ?? null,
          );
        }
      });
      copied.agents = agents.length;

      const positions = (await child
        .prepare(
          // price_source IS LOAD-BEARING and was omitted. The shared schema
          // defaults it to 'chainlink' (store.ts), so a pool mark — or a bonding
          // curve mark, which is the weakest evidence this system produces —
          // arrived in Postgres wearing an oracle's name and rendered on the
          // dashboard as oracle-grade. The whole point of the column is that the
          // three sources are NOT equally good evidence.
          `SELECT agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, price_stale,
                  price_source, value_usdg, updated_at FROM positions`,
        )
        .all()) as Record<string, unknown>[];
      await shared.tx(async (db) => {
        // Replace rather than merge: a closed position is GONE at the source,
        // and an upsert alone would leave it on the dashboard forever.
        for (const a of agents) {
          await db.prepare(`DELETE FROM positions WHERE agent_id = ?`).run(a.smart_account);
        }
        const ins = db.prepare(
          `INSERT INTO positions (agent_id, symbol, token, raw_balance, ui_multiplier, price_usd,
                                  price_stale, price_source, value_usdg, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const p of positions) {
          await ins.run(
            p.agent_id, p.symbol, p.token, p.raw_balance, p.ui_multiplier, p.price_usd,
            p.price_stale, p.price_source, p.value_usdg, p.updated_at,
          );
        }
      });
      copied.positions = positions.length;
    }
  } catch {
    /* as above */
  }

  return { tenant, copied };
}
