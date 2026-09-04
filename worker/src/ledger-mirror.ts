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
      // Otherwise 'what did sponsorship cost the house this week' is a question
      // that can only be answered by sshing into 18 separate child databases.
      "sponsored_gas_wei",
      // GAS PRICED IN USDG, which is the figure both hosted P&L queries actually
      // sum. Without it the dashboard read 0.00 gas AND counted every mirrored
      // fill as unpriceable, so `gasQualifier` stamped 'this is not the full
      // cost' on every book — a warning about our own missing column.
      "gas_usdg",
      "fill_cash_usdg",
      // WHICH RUN this row belongs to. Everything below depends on it; see the
      // note on the agents upsert.
      "epoch",
      "created_at",
    ],
  },
  // `positions_usdg` is part of the equity identity (cash + vault + positions +
  // quarantined) and was the one leg not carried, so a mirrored row could not be
  // decomposed into the numbers that made it.
  {
    table: "equity",
    cols: ["agent_id", "eth_wei", "cash_usdg", "vault_usdg", "positions_usdg", "equity_usdg", "epoch", "at"],
  },
  // THE FLOW TERM. Without it equity is a bare balance reading and a deposit is
  // arithmetically indistinguishable from a gain — the bug that once reported
  // +999.48 on a book that was down 0.52 and charged a performance fee on the
  // owner's own principal (see the flows DDL in store.ts).
  //
  // The table has always existed in the shared database — applyLedgerSchema
  // creates it — so `SELECT ... FROM flows` SUCCEEDED and returned nothing. That
  // is why hosted P&L was not merely wrong but permanently null: zero rows means
  // contributions are UNKNOWN, and equity.ts refuses to publish a number it
  // cannot back. Every hosted agent showed a dash, forever, by design.
  {
    table: "flows",
    cols: ["agent_id", "direction", "amount_usdg", "tx_hash", "block_number", "log_index", "source", "epoch", "at"],
  },
  // What the house actually accrued, per agent. Read straight off `agents` by
  // the scoreboard, but the per-accrual history is what makes a fee auditable.
  {
    table: "fee_accruals",
    cols: ["agent_id", "profit_usdg", "fee_usdg", "hwm_before_usdg", "hwm_after_usdg", "epoch", "at"],
  },
] as const;

/**
 * How far the decisions cursor opens behind itself, in seconds. `at` is not
 * unique, so a cursor that resumed exactly at its own watermark would drop
 * every row sharing that second with the last one it copied.
 */
const DECISION_LOOKBACK_SEC = 300;

/**
 * How far back a trade's resolution is still worth chasing.
 *
 * A UserOp that has not resolved in six hours is not late, it is stranded, and
 * that is inflight-reconcile.ts's problem rather than the mirror's.
 */
const RESYNC_WINDOW_SEC = 6 * 3600;

/** Rows examined per resync pass. Bounded so a long outage cannot stall a tick. */
const RESYNC_LIMIT = 200;

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
  /**
   * Rows copied per table this pass.
   *
   * An append-only table records its ZERO rather than being absent — leaving it
   * out is what made a stalled cursor look exactly like a quiet table. A
   * snapshot table is absent only when the tenant has no agent row at all.
   */
  copied: Record<string, number>;
  /**
   * Tables whose cursor was rewound because the child ledger was rebuilt
   * beneath it — `was` is the watermark that turned out to point at a row
   * that no longer exists.
   *
   * Loud on purpose. A rewind is the mirror recovering from something that
   * silently cost it every append-only row since the last redeploy, and an
   * operator should see that it happened rather than infer it from a tape that
   * quietly starts working again.
   */
  restarted?: Record<string, { was: number }>;
  /**
   * Why a table copied nothing, when the reason was an error rather than an
   * empty source.
   *
   * A failing table is INVISIBLE without this. The catches below deliberately
   * continue — one table's failure is one table's lag, not a reason to abandon
   * the rest — and the watermark deliberately does not move, so the next pass
   * retries. Both are right. The consequence is that a single column mismatch
   * between a child's sqlite and shared Postgres stalls that table FOREVER
   * while every pass reports success, because a stalled table and an idle one
   * produce byte-identical output. That is not a hypothetical: it is
   * indistinguishable from the fleet simply having nothing to say, which is
   * exactly how it went unnoticed.
   */
  failed?: Record<string, string>;
  /** Set when the child's ledger could not be opened at all. */
  skipped?: string;
}

/**
 * Open a child's ledger READ-ONLY. Its worker is running and writing to it.
 *
 * RETURNS A HANDLE THE CALLER MUST CLOSE. It used to return a bare Db, which
 * made the file descriptor invisible — the mirror opened one per tenant per
 * pass and closed none, so a 24-agent fleet leaked roughly twenty-two
 * descriptors every fifteen seconds, for ever. Returning the closer alongside
 * the database is what makes forgetting it a thing you can see in the code.
 */
export function openChildLedger(home: string): { db: Db; close: () => void } | null {
  const file = path.join(home, "merrymen.db");
  if (!existsSync(file)) return null;
  try {
    // readOnly so a bug here can never corrupt a live agent's ledger, and so
    // this can never take a write lock the worker is waiting on.
    const raw = new DatabaseSync(file, { readOnly: true });
    return {
      db: wrapSqlite(raw),
      close: () => {
        try {
          raw.close();
        } catch {
          // Already closed, or the file went away with a redeploy. Either way
          // there is nothing to do and nothing worth saying.
        }
      },
    };
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
  const failed: Record<string, string> = {};
  const restarted: Record<string, { was: number }> = {};

  // ── append-only tables ────────────────────────────────────────────────────
  for (const { table, cols } of LOG_TABLES) {
    try {
      const mark = (await shared
        .prepare(`SELECT last_id FROM mirror_state WHERE tenant = ? AND table_name = ?`)
        .get(tenant, table)) as { last_id: number } | undefined;
      let from = Number(mark?.last_id ?? 0);

      // ── THE CURSOR OUTLIVES THE LEDGER IT POINTS INTO ──────────────────────
      //
      // `last_id` is an id in the CHILD's sqlite, and it is stored HERE, in
      // shared Postgres. Those two do not have the same lifetime. A child home
      // lives on the orchestrator container's own filesystem and railway.json
      // declares no volume for it, so a redeploy destroys every child ledger
      // while mirror_state survives untouched. Every LOG_TABLE is INTEGER
      // PRIMARY KEY AUTOINCREMENT, so the rebuilt file restarts at id 1 beneath
      // a watermark that still reads four thousand — after which `id > from`
      // matches nothing, FOREVER, and the `!rows.length` path below records
      // neither a count nor a failure, so every pass reports success.
      //
      // That is not hypothetical: it is why the entire fleet's trade tape was
      // empty in production while `positions` and `cost_basis` — snapshots, no
      // id cursor — arrived normally, and why `decisions`, which is cursored on
      // a TIMESTAMP with a lookback, kept flowing past the same stalled state.
      //
      // THE TEST IS "IS THE ROW WE LAST COPIED STILL THERE", not MAX(id).
      // Within one incarnation the watermark IS an id we copied, and these
      // tables are append-only — nothing in this repo deletes from them — so
      // that row can only be missing because the id space restarted underneath
      // us. It cannot false-positive, which matters more than completeness
      // here: this file's exactly-once property rests solely on the watermark
      // (the INSERT below has no ON CONFLICT), so a spurious rewind would
      // duplicate the tape, and a trade shown twice is worse than one shown
      // late. MAX(id) < from would miss the case where the reborn ledger has
      // grown to exactly the old mark; asking for the row itself does not.
      if (from > 0) {
        const still = (await child
          .prepare(`SELECT 1 AS ok FROM ${table} WHERE id = ?`)
          .get(from)) as { ok: number } | undefined;
        if (!still) {
          restarted[table] = { was: from };
          from = 0;
        }
      }

      const rows = (await child
        .prepare(`SELECT id, ${cols.join(", ")} FROM ${table} WHERE id > ? ORDER BY id ASC LIMIT ?`)
        .all(from, batch)) as Record<string, unknown>[];
      if (!rows.length) {
        // RECORD THE ZERO. Leaving it absent is what made a wedged cursor
        // indistinguishable from a quiet table for as long as this bug lived:
        // the orchestrator prints only the keys present, so `trades` simply
        // vanished from the line rather than reading `trades 0`.
        copied[table] = 0;
        continue;
      }

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
    } catch (e) {
      // One table failing is one table's worth of lag, not a reason to abandon
      // the others — and the watermark did not move, so the next pass retries.
      // Recorded rather than swallowed: see MirrorReport.failed.
      failed[table] = e instanceof Error ? e.message : String(e);
      continue;
    }
  }

  // ── trades that resolved AFTER they were copied ───────────────────────────
  //
  // A live trade is written twice at the source: once as `submitted` the moment
  // the UserOp goes out, then UPDATED IN PLACE when it lands or reverts. The
  // watermark above is on `id`, so the first write is copied and the second is
  // never seen — the row keeps its original id and the cursor is already past
  // it. Every live fill therefore froze at "sent, waiting on the chain" in the
  // shared database, permanently.
  //
  // That is not a display bug. The scoreboard and the feed both filter
  // `status = 'landed'`, so hosted, EVERY successful trade was invisible to
  // them: landed count, volume and gas all read zero for an agent that had been
  // trading all week.
  //
  // Keyed on user_op_hash with `AND status = 'submitted'` on the destination.
  // That guard is the whole correctness argument — it is the same key and the
  // same condition addTrade uses at the source, so this pass can only ever
  // convert a submitted row into its resolution, never rewrite a settled one.
  // It also makes the pass idempotent for free: once a row is resolved the
  // UPDATE matches nothing, so re-reading the same window costs one bounded
  // SELECT and N no-op updates.
  try {
    const resolved = (await child
      .prepare(
        `SELECT agent_id, user_op_hash, tx_hash, status, reject_rule, decision_id,
                fill_side, fill_qty_raw, fill_price_usd, realized_pnl_usdg, basis_source,
                gas_wei, sponsored_gas_wei, gas_usdg, fill_cash_usdg
           FROM trades
          WHERE user_op_hash IS NOT NULL AND status <> 'submitted' AND created_at > ?
          ORDER BY id DESC LIMIT ?`,
      )
      .all(nowSec - RESYNC_WINDOW_SEC, RESYNC_LIMIT)) as Record<string, unknown>[];
    if (resolved.length) {
      let n = 0;
      await shared.tx(async (db) => {
        const upd = db.prepare(
          `UPDATE trades SET tx_hash = ?, status = ?, reject_rule = ?, decision_id = ?,
                             fill_side = ?, fill_qty_raw = ?, fill_price_usd = ?,
                             realized_pnl_usdg = ?, basis_source = ?, gas_wei = ?,
                             sponsored_gas_wei = ?, gas_usdg = ?, fill_cash_usdg = ?
            WHERE agent_id = ? AND user_op_hash = ? AND status = 'submitted'`,
        );
        for (const r of resolved) {
          const res = await upd.run(
            r.tx_hash ?? null, r.status, r.reject_rule ?? null, r.decision_id ?? null,
            r.fill_side ?? null, r.fill_qty_raw ?? null, r.fill_price_usd ?? null,
            r.realized_pnl_usdg ?? null, r.basis_source ?? null, r.gas_wei ?? null,
            r.sponsored_gas_wei ?? null, r.gas_usdg ?? null, r.fill_cash_usdg ?? null,
            r.agent_id, r.user_op_hash,
          );
          // RunResult.changes is part of the Db contract — node:sqlite reports
          // it directly and the Postgres driver maps rowCount — so this counts
          // rows that ACTUALLY moved, not rows attempted. On a settled fleet
          // every update matches nothing and the pass reports no work, which is
          // the honest answer.
          n += res.changes;
        }
      });
      // Only when something actually moved — otherwise every pass would report
      // work on a fleet that has nothing left to resolve.
      if (n > 0) copied.trades_resolved = n;
    }
  } catch (e) {
    failed.trades_resolved = e instanceof Error ? e.message : String(e);
  }

  // ── decisions: append-only, globally unique, and now watermarked ──────────
  //
  // The id is a uuid, so the destination key is safe to reuse and ON CONFLICT
  // is enough on its own. What it is NOT enough for is completeness: this used
  // to read `ORDER BY at DESC LIMIT 500` with no cursor, so a child that wrote
  // more than a batch between two passes lost the overflow PERMANENTLY. That
  // was tolerable while a decision was only dashboard furniture. It stopped
  // being tolerable when agents began reading each other: a dropped decision is
  // now a peer input that silently never arrives, and the agent it never reached
  // has no way to know it was missing.
  //
  // Watermarked on `at` rather than on an id, because the id is a uuid and has
  // no order. `at` is not unique, so the cursor opens 300s BEHIND itself: ties
  // and a little clock skew are re-read rather than skipped, and ON CONFLICT
  // makes the overlap free. Ascending, so a batch cap truncates the NEWEST rows
  // (which the next pass collects) instead of the oldest (which it never would).
  try {
    const dmark = (await shared
      .prepare(`SELECT last_id FROM mirror_state WHERE tenant = ? AND table_name = ?`)
      .get(tenant, "decisions")) as { last_id: number } | undefined;
    const since = Math.max(0, (dmark?.last_id ?? 0) - DECISION_LOOKBACK_SEC);
    const rows = (await child
      .prepare(
        `SELECT id, agent_id, source, strategy, provider, model, symbol, action, size_usdg,
                reason, dropped_rule, signals_json, at
         FROM decisions WHERE at >= ? ORDER BY at ASC LIMIT ?`,
      )
      .all(since, batch)) as Record<string, unknown>[];
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
        // Same transaction as the rows, for the same reason the log tables do
        // it: a crash between the two re-reads a window that is already there,
        // which ON CONFLICT absorbs, but a watermark that moved without its
        // rows would skip them forever.
        const highest = Number(rows[rows.length - 1]!.at);
        await db
          .prepare(
            `INSERT INTO mirror_state (tenant, table_name, last_id, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (tenant, table_name) DO UPDATE SET last_id = excluded.last_id, updated_at = excluded.updated_at`,
          )
          .run(tenant, "decisions", highest, nowSec);
      });
      copied.decisions = rows.length;
    }
  } catch (e) {
    failed.decisions = e instanceof Error ? e.message : String(e);
  }

  // ── snapshot tables: upsert by their own key ──────────────────────────────
  // `agents` and `positions` describe the world NOW rather than what happened,
  // so there is no watermark to keep — the current row simply replaces the
  // stored one. A position that closed is deleted at the source and would
  // otherwise linger here, so the whole set is replaced per agent.
  try {
    const agents = (await child
      .prepare(
        // `epoch`, `hwm_usdg` and `accrued_fee_usdg` MUST travel with the row
        // tables above, in the same change. Both web routes filter every query on
        // `agents.epoch`; while nothing carried it, the shared row sat at its
        // DEFAULT 1 and so did every mirrored trade and equity row, so the filter
        // matched everything and accidentally agreed. Carrying epoch on the rows
        // alone would file epoch-2 rows under an epoch-1 agent and blank every
        // hosted dashboard; carrying it here alone would hide a child's whole
        // current run. The two halves are only correct together.
        //
        // The other two are read with COALESCE(..., 0) by the scoreboard, so an
        // unmirrored high-water mark and accrued fee did not render as unknown —
        // they rendered as a confident zero.
        `SELECT smart_account, name, owner_address, session_key_address, chain_id, caps,
                granted_at, expires_at, status, created_at, mode, beat_at, sponsor_gas, x_handle,
                epoch, hwm_usdg, accrued_fee_usdg,
                contributions_known, contributions_why, gas_accounting, quality_at FROM agents`,
      )
      .all()) as Record<string, unknown>[];
    if (agents.length) {
      await shared.tx(async (db) => {
        const ins = db.prepare(
          `INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id,
                               caps, granted_at, expires_at, status, created_at, mode, beat_at,
                               sponsor_gas, x_handle, epoch, hwm_usdg, accrued_fee_usdg,
                               contributions_known, contributions_why, gas_accounting, quality_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (smart_account) DO UPDATE SET
             name = excluded.name, status = excluded.status, caps = excluded.caps,
             expires_at = excluded.expires_at, mode = excluded.mode,
             beat_at = excluded.beat_at, sponsor_gas = excluded.sponsor_gas,
             x_handle = excluded.x_handle,
             -- MONOTONIC, NOT OVERWRITTEN. These three are RATCHETS, and the
             -- child that supplies them lives in a container whose database a
             -- redeploy empties. A fresh child recreates its local agents row at
             -- the schema defaults — epoch 1, hwm 0, fee 0 — and an unconditional
             -- assignment here wrote those defaults straight over the durable
             -- history: the peak the performance fee is measured against reset to
             -- zero, the accounting epoch regressed to 1 (readmitting the very
             -- epoch-1 rows the epoch mechanism exists to exclude), and the
             -- accrued-fee total forgot what the house had earned.
             --
             -- The direction matters more than the loss. A peak that resets to 0
             -- means the next mark hands the whole principal to accrueAboveHwm as
             -- profit and charges a performance fee on the owner's own capital —
             -- the exact failure the accounting anchor was built to prevent,
             -- arriving through the mirror instead of through the worker.
             --
             -- CASE rather than MAX/GREATEST because this statement is written
             -- once for both backends: MAX is scalar in sqlite and an aggregate
             -- in Postgres, and GREATEST does not exist in sqlite.
             epoch = CASE WHEN excluded.epoch > agents.epoch THEN excluded.epoch ELSE agents.epoch END,
             hwm_usdg = CASE WHEN excluded.hwm_usdg > agents.hwm_usdg THEN excluded.hwm_usdg ELSE agents.hwm_usdg END,
             accrued_fee_usdg = CASE WHEN excluded.accrued_fee_usdg > agents.accrued_fee_usdg
                                     THEN excluded.accrued_fee_usdg ELSE agents.accrued_fee_usdg END,
             -- DELIBERATELY NOT MONOTONIC, unlike the three above. Quality is a
             -- CURRENT assessment, not a ratchet: a book that stops being
             -- provable has to be able to say so. A high-water rule here would
             -- pin an agent at a claim it can no longer support, which is the
             -- same class of lie as the numbers this whole change is about.
             contributions_known = excluded.contributions_known,
             contributions_why = excluded.contributions_why,
             gas_accounting = excluded.gas_accounting,
             quality_at = excluded.quality_at`,
        );
        for (const a of agents) {
          await ins.run(
            a.smart_account, a.name, a.owner_address, a.session_key_address, a.chain_id,
            a.caps, a.granted_at, a.expires_at, a.status, a.created_at,
            // Nullable on purpose: an agent that has never beaten has no mode,
            // and null is the honest value for that. It renders as IDLE, which
            // is what it is.
            a.mode ?? null, a.beat_at ?? null,
            // Null until the first heartbeat, and null is the honest answer: an
            // agent that has never run has not told us who pays.
            a.sponsor_gas ?? null, a.x_handle ?? null,
            // These three have NOT NULL DEFAULTs at the source, so a null here
            // means a pre-migration child rather than an absent value — fall back
            // to the same defaults the schema would have applied.
            a.epoch ?? 1, a.hwm_usdg ?? 0, a.accrued_fee_usdg ?? 0,
            // NULL means NEVER ASSESSED, which is not the same as false. An agent
            // that has not armed since quality shipped has made no claim about
            // its own book, and a reader must render that as unknown rather than
            // pick an answer on its behalf.
            a.contributions_known ?? null, a.contributions_why ?? null,
            a.gas_accounting ?? null, a.quality_at ?? null,
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

      // WHAT IT PAID, which is the other half of what a position IS. `positions`
      // carries today's value; without the basis there is no entry price and no
      // P&L for a holding — the feed can say an agent holds 6,822.51 of something
      // and not whether that is up or down. Same shape as positions: a snapshot
      // keyed on (agent, mode, symbol), replaced rather than merged, because a
      // closed position's basis is deleted at the source and an upsert alone
      // would leave it here forever.
      const basis = (await child
        .prepare(`SELECT agent_id, mode, symbol, qty_raw, cost_usdg, updated_at FROM cost_basis`)
        .all()) as Record<string, unknown>[];
      await shared.tx(async (db) => {
        for (const a of agents) {
          await db.prepare(`DELETE FROM cost_basis WHERE agent_id = ?`).run(a.smart_account);
        }
        const ins = db.prepare(
          `INSERT INTO cost_basis (agent_id, mode, symbol, qty_raw, cost_usdg, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const b of basis) {
          await ins.run(b.agent_id, b.mode, b.symbol, b.qty_raw, b.cost_usdg, b.updated_at);
        }
      });
      copied.cost_basis = basis.length;
    }
  } catch (e) {
    failed.snapshots = e instanceof Error ? e.message : String(e);
  }

  return {
    tenant,
    copied,
    ...(Object.keys(restarted).length ? { restarted } : {}),
    ...(Object.keys(failed).length ? { failed } : {}),
  };
}
