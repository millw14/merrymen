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
import { getAddress, isAddress } from "viem";
import type { Db } from "./db";
import { mergeRiskPeriod, type RiskPeriod } from "./risk-period";
import { wrapSqlite } from "./db";
import { mirrorPaperCheckpoints } from "./paper-checkpoint";

/** Rows per table per pass. Bounded so one busy tenant cannot starve the rest. */
export const MIRROR_BATCH = 500;

/** The append-only tables, and the column their watermark is measured in. */
const LOG_TABLES = [
  { table: "events", probe: true, stamp: "created_at", cols: ["agent_id", "level", "message", "created_at"] },
  // WHAT AN AGENT SAID, carried the ordinary cursored way. A post is written
  // once and never updated, which is what makes it safe here — see the note on
  // the decisions block below about what a late-filled column costs.
  { table: "posts", probe: true, stamp: "created_at", cols: ["agent_id", "decision_id", "body", "created_at"] },
  {
    table: "trades", probe: true, stamp: "created_at",
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
      // The coin's name, written with the fill (store.ts fillSymbolOfRow).
      // Without it the dashboard names a coin only through its decision row,
      // and a redeploy leaves the chat nothing to name it from at all.
      "fill_symbol",
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
      // THE PRICE-INDEPENDENT HALF of the cost. Without it a hosted split of
      // setup versus steady-state gas has to infer units from wei, and inherits
      // every base-fee move as if it were extra work done.
      "gas_units",
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
  //
  // AND `mode`, WHICH BOOK THE MARK IS OF — the same shape of omission one
  // paragraph up, with the same consequence. The child writes 'paper' or 'live'
  // on every row; a column list that leaves it out lands every mirrored row in
  // the shared ledger with mode NULL, and the shared ledger is the one the web
  // tier reads. So the split between a practice book opening at 1,000 USDG and a
  // funded book holding what the owner sent would exist in the child and nowhere
  // anybody can see it — and the daily change, the chart, the growth index and
  // the published drawdown would all go on measuring the step between two books
  // as performance.
  {
    table: "equity", probe: true, stamp: "at",
    cols: ["agent_id", "eth_wei", "cash_usdg", "vault_usdg", "positions_usdg", "equity_usdg", "epoch", "mode", "at"],
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
  //
  // `chain_id` is carried because it is the first component of the flow's
  // IDENTITY (`flows_chain_identity`), and a tx hash is unique only within a
  // chain — this codebase runs 4663 and 46630 against one schema. Omitting it
  // left every mirrored row with chain_id NULL, and NULLs are distinct in a
  // unique index on both engines, so the constraint could never fire on the
  // shared side no matter what the child wrote.
  {
    table: "flows", probe: false, stamp: "at",
    cols: [
      "agent_id",
      "direction",
      "amount_usdg",
      "tx_hash",
      "block_number",
      "log_index",
      "source",
      "epoch",
      "chain_id",
      "at",
    ],
  },
  // What the house actually accrued, per agent. Read straight off `agents` by
  // the scoreboard, but the per-accrual history is what makes a fee auditable.
  {
    table: "fee_accruals", probe: true, stamp: "at",
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
 *
 * `last_stamp` IS WHAT MAKES `last_id` MEAN ANYTHING.
 *
 * An id alone cannot say WHICH ledger it came from. A rebuilt child restarts
 * its ids at 1, and once it has written `last_id` rows again, a test that asks
 * only whether SOME row occupies that id finds one — a different row wearing
 * the same number — and declares the cursor healthy. The stamp is the row's
 * creation time, which nothing ever updates, so comparing it distinguishes the
 * row we copied from a stranger standing where it used to be.
 *
 * Nullable: every tenant alive when this shipped has a cursor and no witness.
 * See the one-time reconciliation in `mirrorTenant`.
 */
export const MIRROR_STATE_DDL = `
  CREATE TABLE IF NOT EXISTS mirror_state (
    tenant TEXT NOT NULL,
    table_name TEXT NOT NULL,
    last_id INTEGER NOT NULL DEFAULT 0,
    -- last_stamp: creation time of the row last_id points at. See the doc above.
    last_stamp INTEGER,
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
   *
   * `trades_already_mirrored` counts rows read and deliberately NOT inserted:
   * an operation whose hash the shared ledger already holds. See the insert.
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

/** The `copied` keys that count rows read and deliberately NOT inserted. */
const NOT_COPIED = "_already_mirrored";

/**
 * An account id as EIP-55 spells it, or the lowercase id back when it is not
 * an address at all — the duplicate-op probe asks for it beside the other two
 * spellings, and a repeated value in an IN list is harmless.
 */
function checksummed(lower: string): string {
  return isAddress(lower, { strict: false }) ? getAddress(lower) : lower;
}

/**
 * The five binds for `agent_id IN (?, ?, ?) AND user_op_hash IN (?, ?)`: the
 * account as written, lowercase and EIP-55, the hash as written and
 * lowercase. Every pair is a key of trades_agent_userop, so the lookup stays
 * an index seek on both backends.
 */
function spellingsOf(r: Record<string, unknown>): string[] {
  const account = String(r.agent_id ?? "");
  const hash = String(r.user_op_hash ?? "");
  const lower = account.toLowerCase();
  return [account, lower, checksummed(lower), hash, hash.toLowerCase()];
}

/**
 * THE ORCHESTRATOR'S LINE FOR ONE PASS: the rows that arrived, and beside them,
 * never inside them, the copies that were refused.
 *
 * It summed every key in `copied`, and `trades_already_mirrored` is a key, so a
 * pass that skipped five re-recorded ops and inserted nothing printed "+5 rows"
 * where it used to print "idle": the skip read as five rows that came in. The
 * skip is still printed, because it is what makes a redeploy's re-recorded ops
 * visible as what they are, but in its own clause.
 *
 * Null when there is nothing to say beyond the failure: the caller prints the
 * STALLED line itself, and "idle" beside it would be false.
 */
export function mirrorCountsLine(tenant: string, r: Pick<MirrorReport, "copied" | "failed">): string | null {
  const entries = Object.entries(r.copied);
  const arrived = entries.filter(([k]) => !k.endsWith(NOT_COPIED));
  const refused = entries.filter(([k]) => k.endsWith(NOT_COPIED));
  const n = arrived.reduce((a, [, v]) => a + v, 0);
  const s = refused.reduce((a, [, v]) => a + v, 0);
  const skip =
    s > 0
      ? `skipped ${s} already mirrored (${refused.map(([k, v]) => `${k.slice(0, -NOT_COPIED.length)} ${v}`).join(", ")})`
      : null;
  if (n > 0) {
    const detail = arrived.map(([k, v]) => `${k} ${v}`).join(", ");
    return `ledger mirror: ${tenant} +${n} rows (${detail})${skip ? ` · ${skip}` : ""}`;
  }
  if (skip) return `ledger mirror: ${tenant} no new rows · ${skip}`;
  // Says "read, nothing new" rather than saying nothing at all, so the absence
  // of this line means the pass itself did not run.
  return r.failed ? null : `ledger mirror: ${tenant} idle`;
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
 * IS THIS THE ERROR A LEDGER WITHOUT `mark_usd`/`mcap_usd` GIVES — AND ONLY THAT?
 *
 * The decisions copy falls back to a SELECT without the mark columns for a
 * child ledger that predates them. That fallback is permanent for every row it
 * copies: a decision reaches the shared ledger once, exactly as first written
 * (see the ON CONFLICT note below). So it may only ever answer the one question
 * it exists for. A locked file, a timeout or any other column's absence is a
 * failed pass, which the next pass retries WITH the marks; swallowing it here
 * would publish up to a batch of posts that can never say "since posted".
 *
 * SQLite says `no such column: mark_usd`; Postgres says undefined_column (42703)
 * and names the column. The column name is required in both, so the absence of
 * some OTHER column is still a failure and still visible.
 */
export function missingMarkColumn(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const names = /\b(mark_usd|mcap_usd)\b/.test(e.message);
  if (!names) return false;
  return /no such column/i.test(e.message) || (e as { code?: unknown }).code === "42703";
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
  for (const { table, cols, stamp, probe } of LOG_TABLES) {
    try {
      const mark = (await shared
        .prepare(`SELECT last_id, last_stamp FROM mirror_state WHERE tenant = ? AND table_name = ?`)
        .get(tenant, table)) as { last_id: number; last_stamp: number | null } | undefined;
      let from = Number(mark?.last_id ?? 0);
      const witnessed =
        mark?.last_stamp === null || mark?.last_stamp === undefined ? null : Number(mark.last_stamp);

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
      // ── AND WHY ASKING 'IS THE ROW STILL THERE' WAS NOT ENOUGH ────────────
      //
      // The first fix tested `SELECT 1 FROM <table> WHERE id = from`, reasoning
      // that an append-only table can only lose that row to a rebuild. True —
      // but a rebuilt child that has since written `from` rows again puts a
      // DIFFERENT row at that id, the test finds it, and the cursor is declared
      // healthy. Shogun hit exactly this: an autonomous ClassBuy landed, its
      // `class_positions` row (a snapshot, no cursor) mirrored fine, and the
      // `trades` row carrying `fill_side` and `basis_source` never arrived,
      // with the orchestrator printing `trades 0` every pass.
      //
      // So the question is not whether SOME row occupies the watermark. It is
      // whether it is THE SAME ROW. `stamp` is the row's creation time, which
      // nothing updates — the resync pass below rewrites status, tx_hash and
      // every fill column of a trade in place, so a witness over mutable
      // columns would read an ordinary settlement as a rebuild and DUPLICATE
      // THE TAPE. Duplication is the one error this file must never make.
      if (from > 0) {
        const at = (await child
          .prepare(`SELECT ${stamp} AS s, agent_id FROM ${table} WHERE id = ?`)
          .get(from)) as { s: number | null; agent_id: string } | undefined;

        if (!at) {
          // The plain case: the rebuilt ledger has not yet reached that id.
          restarted[table] = { was: from };
          from = 0;
        } else if (witnessed !== null) {
          // The ordinary case once a witness exists. A pure local comparison,
          // no query against the destination.
          if (Number(at.s) !== witnessed) {
            restarted[table] = { was: from };
            from = 0;
          }
        } else {
          // ── ONE-TIME RECONCILIATION, for cursors older than the witness ────
          //
          // Every tenant alive when this shipped has a `last_id` and no
          // `last_stamp`, and some of those cursors are ALREADY stranded — that
          // is the bug being fixed, so seeding the witness from whatever sits at
          // the watermark would freeze the wrong answer in permanently.
          //
          // Reseeding them all instead is the other wrong answer and the worse
          // one: it re-copies rows already in the destination, and `trades`
          // carries no unique key for `ON CONFLICT DO NOTHING` to bite on, so a
          // fleet-wide reseed duplicates every tape that money is summed from.
          //
          // So ask the destination a question only a real rebuild answers NO to:
          // was the row now sitting at the watermark ever mirrored? If the child
          // is the one we have been copying, that row IS a row we copied and its
          // stamp is present. If the ledger was rebuilt beneath us, the row there
          // now belongs to an incarnation the destination has never seen.
          //
          // Existence, not uniqueness — two rows can share a second. That makes
          // the test err towards NOT rewinding, which is the safe direction.
          // ── ONLY WHERE ABSENCE CAN ONLY MEAN A REBUILD ───────────────────
          //
          // The probe reads its answer out of the DESTINATION, so it is sound
          // only for a table nothing ever deletes there. `flows` is deleted
          // from by accounting-repair.ts, and a quarantined row sitting at a
          // tenant's watermark would make the probe answer NO and rewind a
          // perfectly healthy cursor. Flows with a tx hash would dedupe on
          // `flows_chain_identity`, but the inferred and epoch-carry rows
          // carry no identity at all and no index can catch them — so that
          // rewind would duplicate exactly the rows contributions are summed
          // from, and contributions set the high-water mark.
          //
          // So `flows` keeps the old existence test on this one pass and gains
          // its witness for every pass after. It is the table that was never
          // the problem: `trades` is what Shogun lost.
          const seen = !probe
            ? { ok: 1 }
            : ((await shared
                // `lower()` on both sides. Neighbouring writers use lower(agent_id)
                // in places and not in others; a case difference here would read as
                // a rebuild and reseed a healthy cursor.
                .prepare(`SELECT 1 AS ok FROM ${table} WHERE lower(agent_id) = lower(?) AND ${stamp} = ? LIMIT 1`)
                .get(at.agent_id, at.s)) as { ok: number } | undefined);
          if (!seen) {
            restarted[table] = { was: from };
            from = 0;
          } else {
            // Healthy, and now witnessed — so this query never runs again.
            await shared
              .prepare(
                `INSERT INTO mirror_state (tenant, table_name, last_id, last_stamp, updated_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (tenant, table_name) DO UPDATE SET last_stamp = excluded.last_stamp`,
              )
              .run(tenant, table, from, at.s, nowSec);
          }
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
      let alreadyHeld = 0;
      // One transaction: the rows and the watermark that says they arrived.
      // Split them and a crash between the two duplicates the tape forever.
      await shared.tx(async (db) => {
        // ON CONFLICT DO NOTHING, AND IT HAD TO LAND IN THE SAME CHANGE AS
        // `flows.chain_id` — never after it.
        //
        // The watermark was this file's only exactly-once mechanism, which was
        // safe precisely BECAUSE no unique constraint existed to violate: a
        // re-copied row landed as a silent duplicate. That is how the canary's
        // 10 USDG opening balance came to sit in Postgres three times.
        //
        // Populating chain_id makes `flows_chain_identity` bite, and the rebirth
        // path above deliberately rewinds to id 0 after a redeploy — so the first
        // re-copied flow would raise a unique violation, roll the whole batch
        // back, and leave the watermark parked forever. `flows` would stop
        // mirroring for that tenant while every other table kept moving: the
        // exact silent stall documented forty lines up, which already cost this
        // fleet its entire trade tape once.
        //
        // This does NOT weaken the watermark. A conflict can only occur on a row
        // whose (chain_id, agent_id, tx_hash, log_index) is already present —
        // the same log, the same account — which is by definition the row we
        // already copied.
        const ins = db.prepare(
          `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
           ON CONFLICT DO NOTHING`,
        );
        // ONE OPERATION, ONE ROW — and the rewind above is exactly what breaks
        // that for `trades`. A rebuilt child is not only a restart of ids: at
        // its first arm the in-flight reconciler finds every successful op of
        // the last 26 hours missing from the empty ledger and writes each one
        // AGAIN, as a bare 'swap' with no decision and no fill side, stamped at
        // the restart. Rewound onto that ledger, this loop carried every one of
        // them up beside the evidenced original, and nothing stopped it: the
        // shared `trades` has no unique key on user_op_hash, on purpose (see
        // trades_agent_userop in store.ts). So every profile's newest fills
        // were the copies, and every count of operations read each one twice.
        //
        // So a hash this account already holds here is not inserted again. The
        // row that is already here is the one to keep — it was copied from the
        // incarnation that executed the op and carries its evidence — and the
        // copy's only new fact, the outcome of an op still marked 'submitted'
        // here, reaches that row through the resolution pass below, which
        // updates by hash rather than inserting.
        //
        // WHY THIS IS NOT A SPEND ISSUE: the child's own row is untouched, and
        // that is the row its daily cap is seeded from. Nothing is summed
        // against a cap from the shared ledger.
        //
        // ASKED OF THE INDEX, IN EVERY SPELLING A WRITER HERE USES.
        // `(agent_id, user_op_hash)` is exactly trades_agent_userop, and every
        // new live fill asks this, inside this transaction, on a fifteen-second
        // clock. The first version read `lower(agent_id)`, which no index
        // serves, and so scanned the whole fleet's tape on every one of those
        // passes.
        //
        // A COPY IS SPELT ITS OWN WAY, AND IT CAN ARRIVE ON ANY PASS. The
        // in-flight reconciler lowercases every hash it writes, and an account
        // arrives EIP-55 from one incarnation and lowercase from the next. It
        // used to be only the rewind pass that looked past the exact spelling,
        // on the theory that copies arrive there — but a rebuilt child whose
        // first row is a tick's refusal is rewound onto BEFORE the arm's
        // reconciler has written anything, and its copies then come up on
        // ordinary passes, where the exact seek missed them and the shared
        // tape took both rows. So every pass asks for the account as written,
        // lowercase and checksummed, and the hash as written and lowercase.
        // Each pair is a key of the same index, so the question is still a
        // handful of seeks. No index is added for it and none may be: a CREATE
        // INDEX on the shared trades table takes a write lock on every tenant's
        // mirror at once.
        //
        // THE lower() SCAN STAYS ON THE REWIND PASS, and only when the seek
        // missed. It is the one net for a spelling no writer here produces —
        // mixed case that is not EIP-55 — and it costs one read per account per
        // rebuild rather than one per fill. On that pass the account's held
        // hashes are read once per batch, lowercased on both sides, as a set.
        // And never INSERT … WHERE NOT EXISTS: the insert stays the statement
        // Postgres already runs.
        //
        // Hashes inserted in this batch are remembered, lowercased, so a child
        // holding one op twice does not put it here twice either. A row with
        // no hash — a refusal, a paper fill — is always inserted.
        const rewound = restarted[table] !== undefined;
        const seek = db.prepare(
          `SELECT 1 AS ok FROM trades WHERE agent_id IN (?, ?, ?) AND user_op_hash IN (?, ?) LIMIT 1`,
        );
        const heldBy = new Map<string, Set<string>>();
        const heldAnyCase = async (account: string): Promise<Set<string>> => {
          let set = heldBy.get(account);
          if (!set) {
            const got = (await db
              .prepare(
                `SELECT lower(user_op_hash) AS h FROM trades
                  WHERE lower(agent_id) = ? AND user_op_hash IS NOT NULL`,
              )
              .all(account)) as { h: string }[];
            set = new Set(got.map((g) => String(g.h)));
            heldBy.set(account, set);
          }
          return set;
        };
        const thisBatch = new Set<string>();
        for (const r of rows) {
          const raw = typeof r.user_op_hash === "string" ? r.user_op_hash : "";
          if (table === "trades" && raw !== "") {
            const account = String(r.agent_id ?? "").toLowerCase();
            const hash = raw.toLowerCase();
            const key = `${account} ${hash}`;
            const held =
              thisBatch.has(key) ||
              (await seek.get(r.agent_id ?? null, account, checksummed(account), raw, hash)) !== undefined ||
              (rewound && (await heldAnyCase(account)).has(hash));
            if (held) {
              alreadyHeld++;
              continue;
            }
            thisBatch.add(key);
          }
          await ins.run(...cols.map((c) => r[c] ?? null));
        }
        // THE WITNESS MOVES WITH THE WATERMARK, in the same transaction and for
        // the same reason: a cursor whose stamp belongs to a different row is
        // exactly the state this column exists to make impossible.
        await db
          .prepare(
            `INSERT INTO mirror_state (tenant, table_name, last_id, last_stamp, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (tenant, table_name) DO UPDATE SET last_id = excluded.last_id,
               last_stamp = excluded.last_stamp, updated_at = excluded.updated_at`,
          )
          .run(tenant, table, highest, rows[rows.length - 1]![stamp] ?? null, nowSec);
      });
      // Rows that ARRIVED, and beside them the ones deliberately not copied —
      // printed by the orchestrator like every other key here, so a redeploy's
      // re-recorded ops show up as what they are rather than as a quiet pass.
      copied[table] = rows.length - alreadyHeld;
      if (alreadyHeld > 0) copied[`${table}_already_mirrored`] = alreadyHeld;
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
  //
  // THE SAME SPELLINGS AS THE DUPLICATE SEEK ABOVE. That seek now refuses a
  // copy spelt the other way on every pass, so this UPDATE is the only road
  // the copy's outcome has to the original. Matched on the exact spelling it
  // found nothing, and an original left `submitted` by a child killed while
  // waiting on the receipt stayed "sent, waiting on the chain" for good —
  // worse than the duplicate it replaced, which at least showed the landing.
  //
  // AND IT MAY ONLY ADD EVIDENCE, NEVER ERASE IT. The row it now reaches is
  // often the reconciler's copy: kind 'swap', no decision, no fill side, no
  // gas. Bound as written, it overwrote the original's decision_id and
  // fill_side with NULL — the row that proved WHY the agent traded would
  // settle as an anonymous swap. Each evidence column keeps its value when
  // the child has none (COALESCE); status and the outcome itself still move,
  // and only ever from `submitted`.
  try {
    const resolved = (await child
      .prepare(
        `SELECT agent_id, user_op_hash, tx_hash, status, reject_rule, decision_id,
                fill_side, fill_qty_raw, fill_price_usd, realized_pnl_usdg, basis_source,
                gas_wei, sponsored_gas_wei, gas_usdg, gas_units, fill_cash_usdg, fill_symbol
           FROM trades
          WHERE user_op_hash IS NOT NULL AND status <> 'submitted' AND created_at > ?
          ORDER BY id DESC LIMIT ?`,
      )
      .all(nowSec - RESYNC_WINDOW_SEC, RESYNC_LIMIT)) as Record<string, unknown>[];
    if (resolved.length) {
      let n = 0;
      await shared.tx(async (db) => {
        const upd = db.prepare(
          `UPDATE trades SET tx_hash = COALESCE(?, tx_hash), status = ?,
                             reject_rule = COALESCE(?, reject_rule), decision_id = COALESCE(?, decision_id),
                             fill_side = COALESCE(?, fill_side), fill_qty_raw = COALESCE(?, fill_qty_raw),
                             fill_price_usd = COALESCE(?, fill_price_usd),
                             realized_pnl_usdg = COALESCE(?, realized_pnl_usdg),
                             basis_source = COALESCE(?, basis_source), gas_wei = COALESCE(?, gas_wei),
                             sponsored_gas_wei = COALESCE(?, sponsored_gas_wei),
                             gas_usdg = COALESCE(?, gas_usdg), gas_units = COALESCE(?, gas_units),
                             fill_cash_usdg = COALESCE(?, fill_cash_usdg),
                             fill_symbol = COALESCE(?, fill_symbol)
            WHERE agent_id IN (?, ?, ?) AND user_op_hash IN (?, ?) AND status = 'submitted'`,
        );
        for (const r of resolved) {
          const res = await upd.run(
            r.tx_hash ?? null, r.status, r.reject_rule ?? null, r.decision_id ?? null,
            r.fill_side ?? null, r.fill_qty_raw ?? null, r.fill_price_usd ?? null,
            r.realized_pnl_usdg ?? null, r.basis_source ?? null, r.gas_wei ?? null,
            r.sponsored_gas_wei ?? null, r.gas_usdg ?? null, r.gas_units ?? null, r.fill_cash_usdg ?? null,
            r.fill_symbol ?? null,
            ...spellingsOf(r),
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
    // THE MARK COLUMNS ARE READ WHEN THE CHILD HAS THEM. This handle is
    // read-only, so the mirror cannot migrate a child ledger; one opened
    // before its own worker has run the ALTER would fail a SELECT naming
    // `mark_usd`, and the whole decisions copy would stall behind it —
    // silently, since a stalled table and an idle one print the same line.
    // So the row is copied without them instead: a post with no mark claims
    // nothing, and a post that never arrives says nothing at all.
    //
    // ONLY for that. Any other failure of the first read throws to the catch
    // below and the pass retries with the marks — see missingMarkColumn.
    const read = (marks: boolean) =>
      child
        .prepare(
          `SELECT id, agent_id, source, strategy, provider, model, symbol, action, size_usdg,
                  reason, dropped_rule, signals_json, hold_kind, evidence_json, provenance, display_name,
                  ${marks ? "mark_usd, mcap_usd," : ""} at
           FROM decisions WHERE at >= ? ORDER BY at ASC LIMIT ?`,
        )
        .all(since, batch) as Promise<Record<string, unknown>[]>;
    const rows = await read(true).catch((e: unknown) => {
      if (missingMarkColumn(e)) return read(false);
      throw e;
    });
    if (rows.length) {
      await shared.tx(async (db) => {
        const ins = db.prepare(
          // ON CONFLICT (id) DO NOTHING IS LOAD-BEARING AND IT CONSTRAINS WHAT
          // MAY BE ADDED HERE. Every other table in this file upserts; this one
          // deliberately does not, so a decision row reaches shared storage
          // EXACTLY AS IT WAS FIRST WRITTEN and never again. Anything written to
          // a decision after its first mirror pass is therefore unreachable from
          // the hosted feed, silently — the row is already there and the second
          // copy is dropped on the floor.
          //
          // `evidence_json` is safe here only because it is written in the same
          // INSERT as the row it belongs to, at intent time, from measurements
          // that were already in hand. A column filled in later — a post written
          // after the fill lands, say — must NOT be added to this statement; it
          // needs its own append-only table, inserted once, or it will pass
          // every test against a child sqlite and publish nothing in production.
          //
          // `mark_usd` and `mcap_usd` are safe here for the same reason: the
          // writer puts them in the row's own INSERT, at decision time.
          `INSERT INTO decisions (id, agent_id, source, strategy, provider, model, symbol, action,
                                  size_usdg, reason, dropped_rule, signals_json, hold_kind, evidence_json, provenance, display_name,
                                  mark_usd, mcap_usd, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
        );
        for (const r of rows) {
          await ins.run(
            r.id, r.agent_id, r.source, r.strategy ?? null, r.provider ?? null, r.model ?? null,
            r.symbol ?? null, r.action ?? null, r.size_usdg ?? null, r.reason ?? null,
            r.dropped_rule ?? null, r.signals_json ?? null, r.hold_kind ?? null, r.evidence_json ?? null,
            r.provenance ?? null, r.display_name ?? null, r.mark_usd ?? null, r.mcap_usd ?? null, r.at,
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
                granted_at, expires_at, status, created_at, mode, beat_at, sponsor_gas, live_blocker, x_handle, x_verified,
                epoch, hwm_usdg, hwm_withdrawn_usdg, accrued_fee_usdg,
                contributions_known, contributions_why, gas_accounting, quality_at FROM agents`,
      )
      .all()) as Record<string, unknown>[];
    if (agents.length) {
      await shared.tx(async (db) => {
        const ins = db.prepare(
          `INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id,
                               caps, granted_at, expires_at, status, created_at, mode, beat_at,
                               sponsor_gas, live_blocker, x_handle, x_verified, epoch, hwm_usdg,
                               hwm_withdrawn_usdg, accrued_fee_usdg,
                               contributions_known, contributions_why, gas_accounting, quality_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (smart_account) DO UPDATE SET
             name = excluded.name, status = excluded.status, caps = excluded.caps,
             expires_at = excluded.expires_at, mode = excluded.mode,
             beat_at = excluded.beat_at, sponsor_gas = excluded.sponsor_gas,
             live_blocker = excluded.live_blocker,
             x_handle = excluded.x_handle,
             -- NOT a ratchet: a handle that loses its proof (renamed, or
             -- unlinked) has to be able to stop being a link.
             x_verified = excluded.x_verified,
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
             -- THE HALF THAT LETS THE PEAK COME DOWN, and it is a ratchet too.
             --
             -- The peak has to fall when capital leaves, or an owner who
             -- withdraws is permanently "in drawdown" by what they took home and
             -- the breaker refuses every buy forever. But the line above cannot
             -- be relaxed to allow it: a rebuilt child reports hwm 0, and that
             -- zero would erase the durable peak, hand the whole principal to
             -- accrueAboveHwm as profit, and charge a fee on the owner's own
             -- money — the exact failure the ratchet was added to stop.
             --
             -- So the reduction travels as its own MONOTONIC total instead. A
             -- rebuilt child reports 0 here as well and this ratchet ignores it,
             -- exactly like the one above; a child that has booked a withdrawal
             -- reports a LARGER total and it carries. The effective peak is
             -- hwm_usdg − hwm_withdrawn_usdg (store.getAgentFinancials), so it
             -- falls without any statement anywhere being able to write it down.
             hwm_withdrawn_usdg = CASE WHEN excluded.hwm_withdrawn_usdg > agents.hwm_withdrawn_usdg
                                       THEN excluded.hwm_withdrawn_usdg ELSE agents.hwm_withdrawn_usdg END,
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
            a.sponsor_gas ?? null,
            // Null is TWO answers — never beaten, or beaten and trading for real —
            // and a reader must render neither as a blocker.
            a.live_blocker ?? null, a.x_handle ?? null, a.x_verified ?? 0,
            // These three have NOT NULL DEFAULTs at the source, so a null here
            // means a pre-migration child rather than an absent value — fall back
            // to the same defaults the schema would have applied.
            a.epoch ?? 1, a.hwm_usdg ?? 0, a.hwm_withdrawn_usdg ?? 0, a.accrued_fee_usdg ?? 0,
            // NULL means NEVER ASSESSED, which is not the same as false. An agent
            // that has not armed since quality shipped has made no claim about
            // its own book, and a reader must render that as unknown rather than
            // pick an answer on its behalf.
            a.contributions_known ?? null, a.contributions_why ?? null,
            a.gas_accounting ?? null, a.quality_at ?? null,
          );
        }
      });
      // Period IDs remain separate: mirroring a stale child cannot reset a new budget.
      // A rolling deploy can still be mirroring a child from before this schema.
      const hasPeriods = await child.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'risk_periods'").get();
      const periods = hasPeriods ? await child.prepare("SELECT * FROM risk_periods").all() as RiskPeriod[] : [];
      for (const period of periods) await mergeRiskPeriod(shared, period);
      copied.agents = agents.length;
      copied.paper_checkpoints = await mirrorPaperCheckpoints(child, shared);

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
      // A REBUILT CHILD HAS NOT GONE FLAT, IT HAS FORGOTTEN — the same rule the
      // cost basis below now follows, and for a milder version of the same
      // reason. Positions ARE re-derived from the chain every tick, so this
      // heals itself; but the tick after a redeploy is exactly the tick most
      // likely to fail (a cold RPC pool: "the market could not be read this
      // tick (49 read(s) failed)" is what prompted this), and until the next
      // good read the owner is shown an empty book with no explanation.
      //
      // The guard is narrow on purpose: it suppresses the delete ONLY when the
      // rewind detector says the id space began again. A book that genuinely
      // sold everything empties on an ordinary tick, no rewind, and still
      // clears here — which it must, or a closed position lingers for ever.
      const rebuiltChild = Object.keys(restarted).length > 0;
      await shared.tx(async (db) => {
        // Replace rather than merge: a closed position is GONE at the source,
        // and an upsert alone would leave it on the dashboard forever.
        for (const a of agents) {
          if (rebuiltChild && positions.length === 0) continue;
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
      // AN EMPTY CHILD IS NOT A FLAT BOOK — and here that distinction is the
      // difference between a stale row and a destroyed one.
      //
      // The child's sqlite lives in the container and is REBUILT on every
      // redeploy; this file's own rewind detector reports it ("the child ledger
      // was rebuilt beneath it"). Positions survive that, because the next tick
      // re-reads them from the chain. A cost basis cannot: it is history, and
      // the shared ledger holds the only surviving copy.
      //
      // So a wholesale delete keyed on the child's silence deleted real entry
      // prices — and a holding with no entry price is one BOTH mechanical exits
      // refuse, so the owner's stop-loss and take-profit went inert on a live
      // position because a container restarted. Observed end to end: recovered
      // from the receipts at 11:13, wiped by this line at 12:37.
      //
      // The delete is right for an agent the child has something to say about —
      // a closed position's basis really is gone at the source and an upsert
      // alone would leave it on the dashboard forever. It is only ever wrong as
      // an inference from nothing. And a stale row is inert either way: the feed
      // joins basis to POSITIONS, so a basis for a symbol nobody holds never
      // appears, and the worker's own reconciler closes it on the next tick that
      // can see the book.
      //
      // The signal is the one this file already computes: `restarted` is set
      // when a row we know we copied is no longer at its id, which is only
      // possible if the id space began again. That is a rebuilt ledger stated by
      // evidence rather than guessed from a row count — and a row count could
      // not tell these apart anyway, since a book with one closed position and a
      // book that has forgotten one both report zero.
      const rebuilt = Object.keys(restarted).length > 0;
      await shared.tx(async (db) => {
        for (const a of agents) {
          if (rebuilt) continue;
          await db.prepare(`DELETE FROM cost_basis WHERE agent_id = ?`).run(a.smart_account);
        }
        // UPSERT, because the delete above is now conditional. Without the
        // delete a rebuilt child re-inserting the rows it does still have would
        // collide with the primary key and throw the whole snapshot into the
        // catch below — which would leave the shared ledger stale for a
        // different reason.
        const ins = db.prepare(
          `INSERT INTO cost_basis (agent_id, mode, symbol, qty_raw, cost_usdg, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(agent_id, mode, symbol) DO UPDATE SET
             qty_raw = excluded.qty_raw, cost_usdg = excluded.cost_usdg, updated_at = excluded.updated_at`,
        );
        for (const b of basis) {
          await ins.run(b.agent_id, b.mode, b.symbol, b.qty_raw, b.cost_usdg, b.updated_at);
        }
      });
      copied.cost_basis = basis.length;

      // AND THE GRADED FLOOR, which shares the basis's lifecycle exactly: it is
      // a distance from an entry price, stamped once at entry and dropped when
      // the basis is. So it gets the same treatment for the same reasons — the
      // rebuilt-child guard, because it is history a restart cannot re-derive,
      // and the upsert, because the delete above it is conditional.
      const floors = (await child
        .prepare(`SELECT agent_id, mode, symbol, stop_bps, rung, why, at FROM position_floors`)
        .all()
        .catch(() => [])) as Record<string, unknown>[];
      await shared.tx(async (db) => {
        for (const a of agents) {
          if (rebuilt) continue;
          await db.prepare(`DELETE FROM position_floors WHERE agent_id = ?`).run(a.smart_account);
        }
        const ins = db.prepare(
          `INSERT INTO position_floors (agent_id, mode, symbol, stop_bps, rung, why, at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(agent_id, mode, symbol) DO UPDATE SET
             stop_bps = excluded.stop_bps, rung = excluded.rung, why = excluded.why, at = excluded.at`,
        );
        for (const f of floors) {
          await ins.run(f.agent_id, f.mode, f.symbol, f.stop_bps, f.rung, f.why, f.at);
        }
      });
      copied.position_floors = floors.length;

      // ── AND THE CLASS BOOK ────────────────────────────────────────────────
      //
      // Money the ACCOUNT does not hold. A class position sits in a separate
      // contract, so it is in no other table here: `positions` is read from the
      // account's own balances and `cost_basis` is written by a path the class
      // executor never takes. Without this the shared ledger — and therefore
      // the dashboard, the operator view and anything reading Postgres — could
      // not see a class position at all, and an owner's equity would be missing
      // a real holding with nothing saying so.
      //
      // SAME TREATMENT AS cost_basis, for the same reason: these rows carry
      // what a position COST, which is history a restart cannot re-derive from
      // the account. The rebuilt-child guard keeps a wiped container from
      // deleting it, and the upsert makes the conditional delete safe.
      //
      // The child re-derives this from the chain at every arm, so the shared
      // copy is a convenience rather than the only survivor — which is exactly
      // the relationship `class_positions` should have with the truth.
      const classRows = (await child
        .prepare(
          `SELECT agent_id, token, symbol, decimals, curve, quote_token, first_seen,
                  vault, entry_tx, exit_tx, cost_usdg, qty_raw, proceeds_usdg, opened_at_block, state,
                  swept_raw
             FROM class_positions`,
        )
        .all()
        .catch(() => [])) as Record<string, unknown>[];
      await shared.tx(async (db) => {
        for (const a of agents) {
          if (rebuilt) continue;
          await db.prepare(`DELETE FROM class_positions WHERE agent_id = ?`).run(a.smart_account);
        }
        const ins = db.prepare(
          `INSERT INTO class_positions
             (agent_id, token, symbol, decimals, curve, quote_token, first_seen,
              vault, entry_tx, exit_tx, cost_usdg, qty_raw, proceeds_usdg, opened_at_block, state,
              swept_raw)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           -- THE EXISTING-ROW SIDE MUST BE QUALIFIED, and sqlite will not tell you.
           --
           -- Inside ON CONFLICT ... DO UPDATE SET, Postgres has TWO relations in
           -- scope — the target table and the "excluded" pseudo-relation — and
           -- both expose every one of these columns. A bare "symbol" is therefore
           -- ambiguous and Postgres refuses to PARSE the statement. sqlite
           -- resolves it to the target row instead, so the mirror's own test
           -- suite (which uses sqlite as the destination) passed throughout.
           --
           -- Measured 2026-09-12: the first class position the fleet ever opened
           -- (Shogun, Doggos, tx 0xd860ac46...) produced
           --     ledger mirror: 0x8e93ba... STALLED — snapshots: column reference "symbol" is ambiguous
           -- and "symbol" only because it is FIRST in this SET list. Every line
           -- below was equally wrong.
           --
           -- AND IT WAS NEVER GOING TO SELF-HEAL. PgDb.prepare sends nothing to
           -- the server (db.ts:181-186); the statement is parsed on its first
           -- .run(), which executes only when there is a class row to write. So
           -- this lay dormant from the day it was written until the day the
           -- capability was first used, and then failed on every attempt — a
           -- parse error rejects a brand-new non-conflicting row exactly as it
           -- rejects a conflicting one.
           --
           -- The agents upsert above already does this correctly (agents.epoch),
           -- which is the in-repo precedent this now matches.
           ON CONFLICT(agent_id, token) DO UPDATE SET
             symbol = COALESCE(excluded.symbol, class_positions.symbol),
             decimals = excluded.decimals,
             curve = COALESCE(excluded.curve, class_positions.curve),
             quote_token = COALESCE(excluded.quote_token, class_positions.quote_token),
             vault = COALESCE(excluded.vault, class_positions.vault),
             entry_tx = COALESCE(excluded.entry_tx, class_positions.entry_tx),
             exit_tx = COALESCE(excluded.exit_tx, class_positions.exit_tx),
             cost_usdg = COALESCE(excluded.cost_usdg, class_positions.cost_usdg),
             qty_raw = COALESCE(excluded.qty_raw, class_positions.qty_raw),
             proceeds_usdg = COALESCE(excluded.proceeds_usdg, class_positions.proceeds_usdg),
             opened_at_block = COALESCE(excluded.opened_at_block, class_positions.opened_at_block),
             state = excluded.state,
             -- COALESCE, like the other money columns. A child that has not
             -- re-read the vault's log yet reports null here, and null must not
             -- erase the record that the owner took this position home — that
             -- record is the only thing separating a withdrawal from a sale
             -- that returned nothing.
             swept_raw = COALESCE(excluded.swept_raw, class_positions.swept_raw)`,
        );
        for (const c of classRows) {
          await ins.run(
            c.agent_id,
            c.token,
            c.symbol,
            c.decimals,
            c.curve,
            c.quote_token,
            c.first_seen,
            c.vault,
            c.entry_tx,
            c.exit_tx,
            c.cost_usdg,
            c.qty_raw,
            c.proceeds_usdg,
            c.opened_at_block,
            c.state,
            c.swept_raw ?? null,
          );
        }
      });
      copied.class_positions = classRows.length;
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
