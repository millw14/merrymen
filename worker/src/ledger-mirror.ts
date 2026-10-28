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
import { tablePresent, type Db } from "./db";
import { mergeRiskPeriod, type RiskPeriod } from "./risk-period";
import { wrapSqlite } from "./db";
import { mirrorPaperCheckpoints } from "./paper-checkpoint";
import { mergeEnergyDayRow } from "./energy-days";
import { energyDayRowOf, utcDay } from "./energy";
import { OWNER_OPERATION_COLUMNS } from "./owner-operations";
// Which way each perp status may move — the same table store.ts writes by, so
// the copy can never disagree with the source about what "forward" means.
import { PERP_LEG_RANK, PERP_ORDER_RANK, PERP_TRANSFER_RANK, rankCaseSql, textInt } from "./perp-ledger-rules";
import { parseWorkerKey } from "./worker-key";

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
      "trade_fee_usdg",
      // WHICH RUN this row belongs to. Everything below depends on it; see the
      // note on the agents upsert.
      "epoch",
      "created_at",
      "budget_settled_at",
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
  //
  // AND `flows_held`, for the same reason one step further on: the hosted
  // anchor (bootstrap-source.ts) takes the downtime cash baseline from the
  // newest SHARED row and must skip a mark taken while flow inference was held.
  // Left behind in the child, every mirrored held mark would land here as an
  // ordinary one and become the anchor. And `cash_read_at`, when that cash was
  // read, which is the anchor's `since` for the hosted resume.
  //
  // AND THE VENUE'S TERMS (docs/perps.md rule 12; store.ts PERP_EQUITY_ALTERS),
  // the same omission a third time if left out: an equity row whose total
  // includes a perp book but whose perp columns arrive NULL is a row whose
  // identity no longer closes on the shared side — cash + vault + positions
  // falls short of the total by the whole perp book — and the hosted P&L and
  // peak would read "no perp term" for a book that had one. The paper
  // restore's upgrade path checks exactly that identity (paper-checkpoint.ts),
  // so these columns and its perp term land together. `cash_read_block` is
  // the block the cash was read at.
  //
  // OPTIONAL, unlike the columns above: copied when the child has them. A
  // child ledger opened before its own worker ran the ALTER (a rolling deploy;
  // a persistent home the previous release wrote, read by the new
  // orchestrator's final pass before its child has run) would otherwise fail
  // this table's SELECT and stall the equity curve — every tenant's, while
  // nobody trades perps. Absent from the child means absent from the copy,
  // never a failed pass. A Spot child writes them NULL (store.ts addEquity).
  {
    table: "equity", probe: true, stamp: "at",
    cols: ["agent_id", "eth_wei", "cash_usdg", "vault_usdg", "positions_usdg", "equity_usdg", "epoch", "mode", "flows_held", "cash_read_at", "at"],
    optional: [
      "perp_collateral_micro",
      "perp_isolated_margin_micro",
      "perp_unrealized_micro",
      "perp_unrealized_gain_micro",
      "perp_in_transit_micro",
      "perp_snapshot_time",
      "cash_read_block",
    ],
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
  /**
   * An ID-cursored source still has rows beyond this pass's batch — or a perp
   * keyset table filled the last page a pass may read (mirrorPerpLedger), so
   * its tape may run on past what was copied.
   */
  hasMore?: boolean;
  /** Set when the child's ledger could not be opened at all. */
  skipped?: string;
}

/** The `copied` keys that count rows read and deliberately NOT inserted. */
const NOT_COPIED = "_already_mirrored";
/**
 * The `copied` keys that count rows a child offered and this pass refused or
 * could not place (mirrorOwnerOperations, mirrorPerpLedger). `_conflict` is a
 * perp transfer that contradicts the shared ledger and was not merged.
 */
const NOT_COPIED_FOR_CAUSE = ["_foreign", "_invalid", "_unattributed", "_conflict"] as const;

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
  const held = (k: string) => NOT_COPIED_FOR_CAUSE.some((suffix) => k.endsWith(suffix));
  const arrived = entries.filter(([k]) => !k.endsWith(NOT_COPIED) && !held(k));
  const refused = entries.filter(([k]) => k.endsWith(NOT_COPIED));
  const n = arrived.reduce((a, [, v]) => a + v, 0);
  const s = refused.reduce((a, [, v]) => a + v, 0);
  const skip =
    s > 0
      ? `skipped ${s} already mirrored (${refused.map(([k, v]) => `${k.slice(0, -NOT_COPIED.length)} ${v}`).join(", ")})`
      : null;
  // ROWS A CHILD OFFERED THAT WERE NOT ITS TO OFFER, or that this pass could
  // not place: an owner operation under another account, one that is not a
  // full root record, or one with no agreed account to name it by
  // (mirrorOwnerOperations). Never among the arrivals.
  const kept = entries.filter(([k, v]) => held(k) && v > 0);
  const keptSaid = kept.length
    ? `not copied ${kept.reduce((a, [, v]) => a + v, 0)} (${kept.map(([k, v]) => `${k.replace(/_([a-z]+)$/, " $1")} ${v}`).join(", ")})`
    : null;
  const tail = [skip, keptSaid].filter((x): x is string => x !== null).join(" · ");
  if (n > 0) {
    const detail = arrived.map(([k, v]) => `${k} ${v}`).join(", ");
    return `ledger mirror: ${tenant} +${n} rows (${detail})${tail ? ` · ${tail}` : ""}`;
  }
  if (tail) return `ledger mirror: ${tenant} no new rows · ${tail}`;
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
 * IS THIS THE ERROR A CHILD LEDGER FROM BEFORE owner_operations GIVES — AND
 * ONLY THAT? SQLite's "no such table: owner_operations", or Postgres's
 * undefined_table (42P01) naming it. Such a ledger has recorded no owner
 * operation, which is zero rows, not a failed pass. Anything else is a failure,
 * recorded and retried like every other table's.
 */
export function missingOwnerOperationsTable(e: unknown): boolean {
  if (!(e instanceof Error) || !/\bowner_operations\b/.test(e.message)) return false;
  return /no such table/i.test(e.message) || (e as { code?: unknown }).code === "42P01";
}

const OWNER_OP_HASH = /^0x[0-9a-f]{64}$/;

/**
 * THE TENANT'S SMART ACCOUNT AS ITS OWN GRANT NAMES IT: the orchestrator's
 * `grants` table, which only the orchestrator and the grant store write, never
 * the child. Exactly one grant row for the tenant, naming a full address;
 * anything else (no table, no row, two rows, a value that is not an address,
 * a read that fails) is null. The table is asked of the catalogue first
 * (db.ts tablePresent), so a database without it answers null, not an aborted
 * statement.
 *
 * The mirror copies an owner record only under this account
 * (mirrorOwnerOperations), and admission loads one only for it
 * (ledger-resume.ts knownChainFacts): one authority for both. The perp
 * ledger is copied only under it too (mirrorPerpLedger).
 *
 * A PERPS WORKER'S KEY NAMES ITS OWN WALLET'S GRANT. `0x<owner>:perps`
 * (worker-key.ts) is the Perps wallet's worker, whose grant is the owner's row
 * in `perps_grants`, never in `grants`: asked of `grants`, the key matches no
 * row, and every owner operation its arm-time reconciler records would be
 * unattributed on every pass, so its final mirror would never complete. Only
 * the exact key shape counts; anything else is asked of `grants` as before,
 * where a key that is not a tenant finds nothing. `perps_grants` is created by
 * the first Perps put and by nothing else (grant-store.ts PgGrantStore), so
 * its absence is asked of the catalogue too, never left to an aborted
 * statement inside the caller's transaction.
 */
export async function tenantGrantAccount(db: Pick<Db, "prepare">, tenant: string): Promise<string | null> {
  try {
    const worker = parseWorkerKey(tenant);
    const perps = worker?.purpose === "perps";
    const table = perps ? "perps_grants" : "grants";
    if (!(await tablePresent(db, table))) return null;
    const rows = (await db.prepare(`SELECT grant_json->>'smartAccount' AS account FROM ${table} WHERE LOWER(tenant) = ?`)
      .all(perps ? worker!.owner : tenant.toLowerCase())) as Array<{ account?: unknown }>;
    if (rows.length !== 1) return null;
    const a = String(rows[0]!.account ?? "").toLowerCase();
    return /^0x[0-9a-f]{40}$/.test(a) ? a : null;
  } catch {
    return null;
  }
}

/**
 * THE ACCOUNT A PASS MAY COPY UNDER: the grant's (`granted`), unless the
 * caller names one (`given`), which must then agree with the grant wherever
 * the grant names one. Null when there is none to agree on — no grant and no
 * caller's, the caller's null, or the two disagree. One rule for the owner
 * operations and the perp ledger, so the two can never be copied under
 * different accounts on one pass.
 */
function agreedAccount(granted: string | null, given: string | null | undefined): string | null {
  const named = given === undefined ? undefined : given ? given.toLowerCase() : null;
  return named === undefined ? granted : named !== null && (granted === null || granted === named) ? named : null;
}

/** Write the owner-operations cursor: the child id last settled, its created_at as the witness, and when the book was last written. */
async function setOwnerOperationsMark(db: Db, tenant: string, lastId: number, stamp: number | null, updatedAt: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO mirror_state (tenant, table_name, last_id, last_stamp, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (tenant, table_name) DO UPDATE SET last_id = excluded.last_id, last_stamp = excluded.last_stamp, updated_at = excluded.updated_at`,
    )
    .run(tenant, "owner_operations", lastId, stamp, updatedAt);
}

/**
 * COPY THE CHILD'S OWNER OPERATIONS UP, BY THEIR IDENTITY.
 *
 * NOT A LOG TABLE, deliberately. A child ledger written before this table
 * existed would fail a LOG_TABLES read with "no such table", and any `failed`
 * entry withholds an anchor, a drain, a retirement and the fleet checkpoint
 * (orchestrator.ts finalMirrorBeforeAnchor, drainContinuousBook;
 * ledger-safeguard.ts): here that ledger is zero rows. And a LOG_TABLES
 * cursor is in the continuity proof (ledger-safeguard.ts
 * assertLedgerSourceContinuity) and the handover's final cursor, which the
 * persistent-home import, rebuilding a book from ledger-import.ts SPECS
 * alone, could not satisfy. This cursor is in neither, because a rewind of it
 * can neither duplicate nor lose a record: every insert is ON CONFLICT DO
 * NOTHING on the record's identity, (chain_id, LOWER(agent_id), user_op_hash).
 *
 * THE CURSOR IS THE CHILD'S OWN id, WITH A WITNESS, AND NO CLOCK IN IT.
 * mirror_state.last_id is the child id of the last row a pass settled, and
 * last_stamp that row's created_at (the LOG_TABLES convention). A child's
 * AUTOINCREMENT id only grows within one ledger, whatever its clock does, so a
 * record written after the clock stepped back is still after the cursor. (A
 * created_at watermark with a 300-second overlap, the first cut, skipped for
 * good every record a clock stepped back by more than that wrote.) A rebuilt
 * or imported child is told apart by the witness: when the row at last_id is
 * gone or carries another created_at, the pass reads from id 0 again. That
 * re-read is free (see above), so it is not reported as `restarted` and holds
 * no drain, anchor or checkpoint. A cursor with no witness (an earlier
 * build's) is not trusted either: read from 0.
 *
 * THE BOUND, stated. A rebuilt child that already holds a row at exactly
 * last_id, created in exactly the witnessed second, is taken for the old
 * ledger, and its rows at lower ids are not re-read. That needs a new ledger
 * to record as many owner operations as the old one before the mirror's first
 * pass over it (orchestrator.ts mirrors every RECONCILE_MS, 15 seconds; an
 * imported book starts with none), the last in the same second. A record so missed is absent from
 * Postgres, so admission names its operation and holds the tenant: fail
 * closed, and nothing is booked from it.
 *
 * THE TENANT IS THE MIRROR'S, NOT THE CHILD'S. The account is the tenant's
 * grant (tenantGrantAccount). A caller that names one (the fleet checkpoint,
 * its roster's) must agree with the grant wherever there is one. Each row read
 * is then exactly one of:
 *
 *  - copied, or already there: stamped with this pass's tenant;
 *  - foreign: a full record under ANOTHER account. Never copied under this
 *    tenant (it could otherwise answer, or block, that account's operation),
 *    and settled: the cursor passes it and it is counted on the pass that
 *    passes it (`owner_operations_foreign`) — once, unless a rewind re-reads
 *    the ledger from id 0 and counts it again. Foreign is decided against
 *    the grant's account alone, which no child writes, and a tenant keeps its
 *    account across a grant replacement, so no later pass would copy it;
 *  - invalid: not a full lowercase hash pair, or not root. No account could
 *    copy it; settled and counted like a foreign one (`owner_operations_invalid`).
 *
 * With no account to check against (no grant, or the caller's and the
 * grant's disagree), nothing is copied. A row Postgres already holds under
 * this tenant, or an invalid one, has nothing left to copy; if every row read
 * is one of those, they are settled as above. Otherwise the cursor does not
 * move, every other row is counted on every such pass
 * (`owner_operations_unattributed`), and the pass reports owner_operations
 * FAILED, so no caller takes it for a finished copy: the first pass that can
 * name the account copies them. Never skipped.
 *
 * Bounded like every table: more than a batch after the cursor sets hasMore.
 * The cursor's updated_at says when the tenant's book was last written
 * (ledger-resume.ts lastMirrorPassAt). It never moves on a pass that read
 * nothing. On a trusted cursor it moves whenever a pass settles rows (they
 * are rows no pass had passed). After a rewind it moves only when the pass
 * inserts a record: the re-read cannot tell which of a rebuilt ledger's rows
 * an earlier pass passed, so a re-read that copies nothing new (already
 * there, foreign or invalid) leaves it as it was.
 */
export async function mirrorOwnerOperations(o: {
  tenant: string; child: Db; shared: Db; batch: number; nowSec: number; account?: string | null;
}): Promise<{ copied: Record<string, number>; hasMore: boolean; failed?: string }> {
  const copied: Record<string, number> = {};
  const tenant = o.tenant.toLowerCase();
  const cols = OWNER_OPERATION_COLUMNS;
  const mark = (await o.shared
    .prepare(`SELECT last_id, last_stamp, updated_at FROM mirror_state WHERE tenant = ? AND table_name = ?`)
    .get(o.tenant, "owner_operations")) as { last_id: unknown; last_stamp: unknown; updated_at: unknown } | undefined;
  let from = 0;
  let rewound = false;
  let fetched: Record<string, unknown>[];
  try {
    if (mark) {
      const at = Number(mark.last_id);
      const stamp = mark.last_stamp === null || mark.last_stamp === undefined ? null : String(mark.last_stamp);
      if (Number.isSafeInteger(at) && at > 0 && stamp !== null) {
        const witness = (await o.child.prepare(`SELECT created_at FROM owner_operations WHERE id = ?`).get(at)) as { created_at?: unknown } | undefined;
        if (witness && String(witness.created_at) === stamp) from = at;
        else rewound = true;
      } else if (at !== 0) rewound = true;
    }
    fetched = (await o.child
      .prepare(`SELECT id, ${cols.join(", ")}, created_at FROM owner_operations WHERE id > ? ORDER BY id ASC LIMIT ?`)
      .all(from, o.batch + 1)) as Record<string, unknown>[];
  } catch (e) {
    // A ledger from before this table: it recorded none. No cursor row is
    // written for it, so a tenant with no owner operation has no trace here.
    if (missingOwnerOperationsTable(e)) {
      copied.owner_operations = 0;
      return { copied, hasMore: false };
    }
    throw e;
  }
  const rows = fetched.slice(0, o.batch);
  const kept = Number(mark?.updated_at ?? 0);
  if (!rows.length) {
    copied.owner_operations = 0;
    // A rebuilt child with no record yet: forget the cursor it no longer
    // holds, so the next pass does not ask the witness again. Nothing new was
    // written, so updated_at keeps what it said.
    if (rewound) await setOwnerOperationsMark(o.shared, o.tenant, 0, null, kept);
    return { copied, hasMore: false };
  }
  const account = agreedAccount(await tenantGrantAccount(o.shared, tenant), o.account);
  /** Not a full lowercase hash pair, or not root: no account could copy it. */
  const invalidRecord = (r: Record<string, unknown>) =>
    !OWNER_OP_HASH.test(String(r.user_op_hash ?? "")) || !OWNER_OP_HASH.test(String(r.tx_hash ?? "")) || r.validator !== "root";
  if (!account) {
    // NO ACCOUNT TO NAME THEM BY, AND THIS LEDGER MAY BE THEIR ONLY COPY. A
    // removed tenant's final pass (orchestrator.ts finalMirrorBeforeAnchor,
    // after its grant row is gone) reads a home a redeploy can take, so a
    // record it cannot place is NOT a finished copy: the pass reports
    // owner_operations failed, and a final copy, a drain, a retirement and the
    // fleet checkpoint are each withheld — the lease and the home kept — until
    // a pass can name the account. Only a row with nothing left to copy is
    // settled without one: a record Postgres already holds under this tenant
    // (an earlier pass with an account placed it; a rebuilt child's re-read
    // finds these), or one no account could copy (invalid). Then the cursor
    // passes them as any pass would.
    let unplaced = 0;
    for (const r of rows) {
      if (invalidRecord(r)) continue;
      const held = await o.shared
        .prepare(`SELECT 1 AS held FROM owner_operations WHERE tenant = ? AND chain_id = ? AND LOWER(agent_id) = ? AND user_op_hash = ?`)
        .get(tenant, r.chain_id, String(r.agent_id ?? "").toLowerCase(), r.user_op_hash);
      if (!held) unplaced++;
    }
    if (unplaced > 0) {
      copied.owner_operations = 0;
      copied.owner_operations_unattributed = unplaced;
      return {
        copied, hasMore: false,
        failed: `${unplaced} owner operation record(s) have no account to be copied under (no single grant names one, or the caller's disagrees with it); ` +
          "the child's ledger is their only copy, so it is kept until a pass can name the account",
      };
    }
  }
  let inserted = 0, already = 0, foreign = 0, invalid = 0;
  const last = rows[rows.length - 1]!;
  await o.shared.tx(async (db) => {
    const ins = db.prepare(
      `INSERT INTO owner_operations (tenant, ${cols.join(", ")}, created_at) VALUES (?, ${cols.map(() => "?").join(", ")}, ?)
       ON CONFLICT (chain_id, LOWER(agent_id), user_op_hash) DO NOTHING`,
    );
    for (const r of rows) {
      if (invalidRecord(r)) {
        invalid++;
        continue;
      }
      // With no account, every row left is one Postgres holds under this tenant (checked above).
      if (!account) {
        already++;
        continue;
      }
      if (String(r.agent_id ?? "").toLowerCase() !== account) {
        foreign++;
        continue;
      }
      const res = await ins.run(tenant, ...cols.map((c) => r[c] ?? null), r.created_at);
      if (Number(res.changes) > 0) inserted++;
      else already++;
    }
    // Same transaction as the rows: a crash between the two re-reads rows
    // that ON CONFLICT absorbs, and a cursor never moves without its rows.
    await setOwnerOperationsMark(db, o.tenant, Number(last.id), Number(last.created_at), inserted > 0 || !rewound ? o.nowSec : kept);
  });
  copied.owner_operations = inserted;
  if (already > 0) copied[`owner_operations${NOT_COPIED}`] = already;
  if (foreign > 0) copied.owner_operations_foreign = foreign;
  if (invalid > 0) copied.owner_operations_invalid = invalid;
  return { copied, hasMore: fetched.length > o.batch };
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
  /**
   * The tenant's smart account as the ORCHESTRATOR knows it, never as the
   * child says: an owner_operations row is copied only under it (see
   * mirrorOwnerOperations), and so is every perp row (mirrorPerpLedger). It
   * must agree with the shared grants table — `perps_grants` for a Perps
   * worker's key (tenantGrantAccount) — which only the orchestrator and the
   * grant store write, wherever that names one; absent, the grant alone names
   * it. A final pass after the grant is gone (a kill, an expiry) names it here
   * or copies neither.
   */
  account?: string | null;
}): Promise<MirrorReport> {
  const { tenant, child, shared } = args;
  const batch = args.batch ?? MIRROR_BATCH;
  const nowSec = args.nowSec ?? Math.floor(Date.now() / 1000);
  const copied: Record<string, number> = {};
  const failed: Record<string, string> = {};
  const restarted: Record<string, { was: number }> = {};
  let hasMore = false;
  let budgetSettlementColumn: boolean | undefined;
  const hasBudgetSettlement = async () => {
    if (budgetSettlementColumn !== undefined) return budgetSettlementColumn;
    try {
      await child.prepare("SELECT budget_settled_at FROM trades LIMIT 0").all();
      return (budgetSettlementColumn = true);
    } catch (e) {
      // A rolling deploy can still have children on the old schema. Only a
      // specifically missing column permits the legacy timestamp fallback.
      if (e instanceof Error && /\bbudget_settled_at\b/.test(e.message) &&
          (/no such column/i.test(e.message) || (e as { code?: unknown }).code === "42703")) {
        return (budgetSettlementColumn = false);
      }
      throw e;
    }
  };
  let tradeFeeColumn: boolean | undefined;
  const hasTradeFee = async () => {
    if (tradeFeeColumn !== undefined) return tradeFeeColumn;
    try {
      await child.prepare("SELECT trade_fee_usdg FROM trades LIMIT 0").all();
      return (tradeFeeColumn = true);
    } catch (e) {
      // Legacy children have no fee evidence. Omit that source column rather
      // than inventing zero; other read failures must remain visible/retryable.
      if (e instanceof Error && /\btrade_fee_usdg\b/.test(e.message) &&
          (/no such column/i.test(e.message) || (e as { code?: unknown }).code === "42703")) {
        return (tradeFeeColumn = false);
      }
      throw e;
    }
  };

  // ── append-only tables ────────────────────────────────────────────────────
  for (const entry of LOG_TABLES) {
    const { table, cols: declaredCols, stamp, probe } = entry;
    try {
      let cols: readonly string[] = declaredCols;
      if (table === "trades") {
        if (!await hasBudgetSettlement()) cols = cols.filter((column) => column !== "budget_settled_at");
        if (!await hasTradeFee()) cols = cols.filter((column) => column !== "trade_fee_usdg");
      }
      // The optional columns this child actually has — see the equity entry.
      // Asked of the child alone, by name.
      const optional: readonly string[] = "optional" in entry ? entry.optional : [];
      if (optional.length) {
        const present = new Set(
          ((await child.prepare(`SELECT name FROM pragma_table_info('${table}')`).all()) as { name: string }[]).map((c) => String(c.name)),
        );
        cols = [...cols, ...optional.filter((c) => present.has(c))];
      }
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
      const fetched = (await child
        .prepare(`SELECT id, ${cols.join(", ")} FROM ${table} WHERE id > ? ORDER BY id ASC LIMIT ?`)
        .all(from, batch + 1)) as Record<string, unknown>[];
      if (fetched.length > batch) hasMore = true;
      const rows = fetched.slice(0, batch);
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
    const hasSettlement = await hasBudgetSettlement();
    const hasFee = await hasTradeFee();
    const resolved = (await child
      .prepare(
        `SELECT agent_id, user_op_hash, tx_hash, status, reject_rule, decision_id,
                fill_side, fill_qty_raw, fill_price_usd, realized_pnl_usdg, basis_source,
                gas_wei, sponsored_gas_wei, gas_usdg, gas_units, fill_cash_usdg, fill_symbol${hasFee ? ", trade_fee_usdg" : ""}${hasSettlement ? ", budget_settled_at" : ""}
           FROM trades
          WHERE user_op_hash IS NOT NULL AND status <> 'submitted'
            AND (created_at > ?${hasSettlement ? " OR budget_settled_at > ?" : ""})
          ORDER BY id DESC LIMIT ?`,
      )
      .all(nowSec - RESYNC_WINDOW_SEC, ...(hasSettlement ? [nowSec - RESYNC_WINDOW_SEC] : []), RESYNC_LIMIT)) as Record<string, unknown>[];
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
                             fill_symbol = COALESCE(?, fill_symbol)${hasFee ? ", trade_fee_usdg = COALESCE(?, trade_fee_usdg)" : ""}${hasSettlement ? ", budget_settled_at = COALESCE(?, budget_settled_at)" : ""}
            WHERE agent_id IN (?, ?, ?) AND user_op_hash IN (?, ?) AND status = 'submitted'`,
        );
        for (const r of resolved) {
          const res = await upd.run(
            r.tx_hash ?? null, r.status, r.reject_rule ?? null, r.decision_id ?? null,
            r.fill_side ?? null, r.fill_qty_raw ?? null, r.fill_price_usd ?? null,
            r.realized_pnl_usdg ?? null, r.basis_source ?? null, r.gas_wei ?? null,
            r.sponsored_gas_wei ?? null, r.gas_usdg ?? null, r.gas_units ?? null, r.fill_cash_usdg ?? null,
            r.fill_symbol ?? null,
            ...(hasFee ? [r.trade_fee_usdg ?? null] : []),
            ...(hasSettlement ? [r.budget_settled_at ?? null] : []),
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

  // ── owner operations: by identity, never by a child id ────────────────────
  try {
    const r = await mirrorOwnerOperations({ tenant, child, shared, batch, nowSec, account: args.account });
    Object.assign(copied, r.copied);
    if (r.hasMore) hasMore = true;
    // Records with no account to copy them under: not a finished copy.
    if (r.failed) failed.owner_operations = r.failed;
  } catch (e) {
    failed.owner_operations = e instanceof Error ? e.message : String(e);
  }

  // ── perpetuals (docs/perps.md, "Hosted") ──────────────────────────────────
  // Every perp_* table, each under its own try so one table's failure is one
  // table's lag, and only for a child that holds a perp row at all — see
  // mirrorPerpLedger for why none of them rides the id cursor above, and why
  // a Spot child's pass never reaches a shared perp table.
  try {
    const r = await mirrorPerpLedger({ child, shared, tenant, nowSec, batch, copied, failed, account: args.account });
    if (r.hasMore) hasMore = true;
  } catch (e) {
    // mirrorPerpLedger records its own failures; this is only a last net.
    failed.perp = e instanceof Error ? e.message : String(e);
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
                contributions_known, contributions_why, gas_accounting, quality_at, energy FROM agents`,
      )
      .all()) as Record<string, unknown>[];
    if (agents.length) {
      await shared.tx(async (db) => {
        const ins = db.prepare(
          `INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id,
                               caps, granted_at, expires_at, status, created_at, mode, beat_at,
                               sponsor_gas, live_blocker, x_handle, x_verified, epoch, hwm_usdg,
                               hwm_withdrawn_usdg, accrued_fee_usdg,
                               contributions_known, contributions_why, gas_accounting, quality_at, energy)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (smart_account) DO UPDATE SET
             name = excluded.name, status = excluded.status, caps = excluded.caps,
             expires_at = excluded.expires_at,
             -- NULL IS "NOT YET", NOT "NEVER". A redeploy rebuilds the child's
             -- agents row with no heartbeat and no mode, and the first pass after
             -- the respawn copied those NULLs over the last known ones, so the
             -- fleet report read "last heartbeat never — nothing would run" for
             -- ~45 agents that were ticking (2026-09-27 00:36: Seafish201 among
             -- them, beating again at 00:38). A later beat still replaces it.
             mode = COALESCE(excluded.mode, agents.mode),
             beat_at = COALESCE(excluded.beat_at, agents.beat_at), sponsor_gas = excluded.sponsor_gas,
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
             quality_at = excluded.quality_at,
             -- THE WORKER'S ENERGY REPORT: the last one said stands until a
             -- newer one replaces it. A rebuilt child has not reported yet and
             -- carries NULL, which is "not yet", never "no energy" — the same
             -- rule as mode and beat_at above. The worker reports every tick
             -- whatever the gate's mode, so a stale report is always replaced.
             energy = COALESCE(excluded.energy, agents.energy)`,
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
            // Null until this child has reported its energy.
            a.energy ?? null,
          );
        }
      });
      // Period IDs remain separate: mirroring a stale child cannot reset a new budget.
      // A rolling deploy can still be mirroring a child from before this schema.
      const hasPeriods = await child.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'risk_periods'").get();
      const periods = hasPeriods ? await child.prepare("SELECT * FROM risk_periods").all() as RiskPeriod[] : [];
      for (const period of periods) await mergeRiskPeriod(shared, period);
      copied.agents = agents.length;

      // ── TODAY'S ENERGY COUNTERS, carried up so a redeploy cannot reset them ──
      //
      // The child's sqlite is emptied by every redeploy, and a daily allowance
      // kept only there would be handed out afresh by each deploy. So today's
      // and yesterday's rows travel up here, and the orchestrator seeds them
      // back into a rebuilt child before it arms (seedEnergyForChild). The
      // merge is energy-days.ts's one statement: counters only ever go UP
      // through a copy, the first notice stamp stands, the newer balance read
      // wins — so a rebuilt child's zeros can never lower what shared holds.
      // A refund travels as its own rising counter (entries_refunded), which
      // is how a claim mirrored before its trade was refused comes back down.
      //
      // ITS OWN try: energy is not money, and a failure here must not stop
      // the positions and cost basis below from copying. A child from before
      // this table existed has nothing to send and is skipped, not failed.
      try {
        const hasEnergy = await child
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'energy_days'")
          .get();
        if (hasEnergy) {
          const since = utcDay(nowSec - 86_400);
          // Every column, by name through energyDayRowOf: a child's table
          // from before the refund counter has no entries_refunded, and its
          // rows still copy (their `entries` already net of refunds).
          const days = (await child
            .prepare(`SELECT * FROM energy_days WHERE day >= ?`)
            .all(since)) as Record<string, unknown>[];
          let n = 0;
          await shared.tx(async (db) => {
            for (const d of days) {
              const row = energyDayRowOf(d);
              if (!row || typeof d.agent_id !== "string") continue;
              await mergeEnergyDayRow(db, d.agent_id, row);
              n++;
            }
          });
          copied.energy_days = n;
        }
      } catch (e) {
        failed.energy_days = e instanceof Error ? e.message : String(e);
      }

      // ── THE WORKER'S PERPS REPORT (agents.perps), carried up beside energy ──
      //
      // Its OWN statement and its own try, never a column on the agents
      // INSERT above: a child (or a shared schema) from before the column must
      // still copy every other agents field — a failed column here is one
      // missing report, not a fleet whose rows stopped moving. Probed on the
      // child by name; a child without it has said nothing and sends nothing.
      //
      // NULL IS "NOT YET", the rule mode, beat_at and energy follow: a rebuilt
      // child that has not reported leaves the last report standing, and the
      // lane writes a fresh one on its first pass. So only reports are read,
      // and with none — every Spot child, whose lane never arms — nothing is
      // written, no shared transaction is opened, and nothing is counted.
      try {
        const cols = (await child.prepare("PRAGMA table_info(agents)").all()) as { name?: unknown }[];
        if (cols.some((c) => c.name === "perps")) {
          const reports = (await child
            .prepare("SELECT smart_account, perps FROM agents WHERE perps IS NOT NULL")
            .all()) as { smart_account: string; perps: string }[];
          if (reports.length) {
            await shared.tx(async (db) => {
              const up = db.prepare("UPDATE agents SET perps = ? WHERE smart_account = ?");
              for (const r of reports) await up.run(r.perps, r.smart_account);
            });
            copied.agent_perps = reports.length;
          }
        }
      } catch (e) {
        failed.agent_perps = e instanceof Error ? e.message : String(e);
      }

      // ITS OWN try, like energy: a checkpoint that cannot be written (a
      // shared column that failed to add, a lock that timed out) is one
      // missing restore point, and must not stop the positions, basis, floors
      // and class book below from copying for this tenant — Spot's included.
      try {
        copied.paper_checkpoints = await mirrorPaperCheckpoints(child, shared);
      } catch (e) {
        failed.paper_checkpoints = e instanceof Error ? e.message : String(e);
      }

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
        //
        // THE ACCOUNT IN ANY LETTER-CASE, here and in the three snapshot
        // deletes below. The child registers under the grant's spelling as it
        // stands at spawn (store.ts ensureAgent), and an owner who re-signs
        // can change that spelling without changing the account. The seeds
        // read the basis and the held positions in any case (orchestrator.ts
        // seedBasisForChild and ledger-resume.ts planAttestedSeed:
        // `lower(agent_id) = lower(?)`), so a delete that matched only the new
        // spelling left the old rows to be read as this account's for ever: a
        // closed position the seeds read as held, and with it a basis the book
        // no longer has (chain-gap-booking.ts staleBasisVerdict rests on this
        // pass removing one).
        // An equality on both sides lowered, never a pattern, so another
        // account is never matched, whatever it shares with this one. Only the
        // rows deleted change; each rebuilt-child guard is exactly as it was.
        //
        // NOT INDEXED, ON PURPOSE. No index serves lower(agent_id) on these
        // four tables, so each delete reads the whole table; they hold a few
        // rows per agent, and at today's fleet that is well under a
        // millisecond. An index would have to be installed by applyLedgerSchema,
        // which runs on this file's own fifteen-second clock, and CREATE INDEX
        // IF NOT EXISTS takes a ShareLock on its table before it finds the
        // index already there: every cycle, on the four tables every tenant's
        // pass writes, queued behind any open writer and queueing every writer
        // behind it (mcp/schema.ts describes the same hazard).
        for (const a of agents) {
          if (rebuiltChild && positions.length === 0) continue;
          await db.prepare(`DELETE FROM positions WHERE lower(agent_id) = lower(?)`).run(a.smart_account);
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
          // Any letter-case of the account, as positions above: a basis left
          // under a spelling the grant no longer uses is still this account's
          // to every seed, which would hand it to a later book once the symbol
          // is held again.
          await db.prepare(`DELETE FROM cost_basis WHERE lower(agent_id) = lower(?)`).run(a.smart_account);
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
          await db.prepare(`DELETE FROM position_floors WHERE lower(agent_id) = lower(?)`).run(a.smart_account);
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
          await db.prepare(`DELETE FROM class_positions WHERE lower(agent_id) = lower(?)`).run(a.smart_account);
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
    ...(hasMore ? { hasMore } : {}),
    ...(Object.keys(restarted).length ? { restarted } : {}),
    ...(Object.keys(failed).length ? { failed } : {}),
  };
}

// ══ THE PERP LEDGER (docs/perps.md, "Ledger" → "Hosted") ═══════════════════════
//
// A HOSTED PAPER PERPS BOOK IS DURABLE ONLY HERE. Its child lives on a home a
// redeploy can take, and the shared database is the one copy that survives
// it; the restore point beside this (paper-checkpoint.ts perp_json) is checked
// against the tape copied here, so a restore can never reopen a position the
// tape shows closed.
//
// WHY NOT THE ID CURSOR. None of these tables has an autoincrement id: their
// keys are identities — the venue's trade id and our side of it, a funding
// id, a client order index, a transfer's chain log — and that is what makes
// them safe to copy MORE than once. A rebuilt child needs no rewind detection
// either: its rows carry wall-clock stamps, not a restarted id space. (Which
// is also why neither the continuity proof nor the handover's final cursor
// names a perp table: both read only LOG_TABLES, by id.)
//
// A KEYSET CURSOR, (stamp, child rowid), NOT A BARE TIME. Each table is read
// in two parts per pass:
//   forward   rows strictly AFTER the cursor in (stamp, rowid) order, page by
//             page, each page resuming from the last row of the one before;
//             the cursor then moves to the last row read. Every pass that
//             finds rows moves it, so a burst of any size drains at up to
//             PERP_MAX_PAGES × batch rows a pass — and a pass that filled its
//             last page says so (MirrorReport.hasMore), so no caller takes a
//             tape that runs on past it for a finished copy.
//   lookback  rows AT OR BEFORE the cursor within PERP_LOOKBACK_SEC, newest
//             first — the decisions pattern, for what a keyset alone misses:
//             an in-place UPDATE landing in the cursor's own second on a row
//             it already passed, or a stamp computed before a slower commit.
//             Re-copying is free (ON CONFLICT DO NOTHING / the rank guard).
// A bare time that reopened LOOKBACK behind the newest stamp read re-read the
// same first pages for ever once more than PERP_MAX_PAGES × batch rows shared
// one lookback span — a rebuilt child re-ingesting a year of hourly funding in
// seconds — and nothing after them was ever copied (the perps branch's review:
// mirror-perp-page-cap-permanent-skip). The rowid is the child's own (every
// perp table is a rowid table); it only breaks ties within one stamp, so a
// rebuilt child's restarted rowids cost at most the lookback's re-read. The
// cursor moves in the SAME shared transaction as its rows: a cursor that moved
// without them would skip them for ever.
//
// THE UPDATED TABLES ARE COPIED BY `updated_at`, and each row goes through a
// RANK GUARD (perp-ledger-rules.ts): an UPDATE that only moves the shared row
// FORWARD, then — if it matched nothing — an INSERT … ON CONFLICT DO NOTHING.
// So a stale child, or a slow pass racing a fresh one, can never turn a
// `filled` order back into `submitted` or a `paid` withdrawal back into
// transit. DO NOTHING absorbs a conflict on ANY unique index for an INSERT;
// an UPDATE that FILLS identity columns (perp_transfers only) has no such
// clause, so a transfer row resolves ONE shared target first and fills only
// identities no other shared row holds, under a savepoint — one contradictory
// row is a counted conflict, never an error that rolls back the batch and
// stalls the table for good (the trades-tape failure recorded above).
//
// ONLY THE WORKER'S OWN ACCOUNT. LOG_TABLES can only insert; these paths can
// change rows that are already there — an order matched by its global id, a
// transfer resolved through global identities, a position flattened, an
// account row merged. A child that could name another account's agent_id
// could advance or flatten that account's shared book. So, as owner
// operations are (mirrorOwnerOperations), every perp row is copied only under
// the account the tenant's grant names (tenantGrantAccount: `perps_grants` for
// a Perps worker's key), and a row under any other is counted
// (`perp_<table>_foreign`) and never copied. With no account to name, nothing
// is copied and the pass says so in `failed`, so no caller takes it for a
// finished copy.
//
// INERT FOR A CHILD THAT HOLDS NO PERP ROW. Every child ledger has had every
// perp table since slice 3 (store.ts execPerpLedger), Spot's included, and
// almost none of them holds a row. One child-only probe comes first; with no
// row there, no shared perp table — no cursor, no grant, no snapshot — is
// read or written, and nothing is added to `copied` or `failed`. Without it a
// shared-side perp fault (a lock timeout, a missing table) would be a
// `failed.perp_*` on every Spot tenant's pass, and any `failed` entry
// withholds that tenant's anchor, drain, retirement and fleet checkpoint.
//
// NEVER COPIED: perp_orders.tx_info. It is the exact signed transaction,
// signature included — bytes that could be re-sent to the venue — and the
// shared database has no use for them: live orders are re-read from the venue
// at arm, never seeded from shared storage. Nor an incident's detail: the
// shared row learns that there IS an incident, its kind and when.

/** How far each perp cursor re-reads behind itself, seconds (the lookback part of a pass). */
const PERP_LOOKBACK_SEC = 300;
/**
 * Pages read per table per pass, forward and lookback each. A bound on one
 * pass's work, never on what is eventually copied: the keyset cursor resumes
 * after the last row read, so whatever did not fit arrives next pass.
 */
const PERP_MAX_PAGES = 20;

/** Every perp table a child ledger can hold (store.ts PERP_LEDGER_DDL). */
const PERP_TABLES = [
  "perp_orders", "perp_order_legs", "perp_fills", "perp_funding", "perp_transfers", "perp_positions", "perp_accounts", "perp_carries",
] as const;

const PERP_FILL_COLS = [
  "agent_id", "mode", "epoch", "venue_trade_id", "side_role", "market_id", "side", "role", "base", "price",
  "quote_micro", "fee_micro", "realized_micro", "position_before", "entry_quote_before_micro", "trade_type",
  "attribution", "order_id", "venue_order_index", "client_order_index", "venue_tx_hash", "venue_ts_ms", "created_at",
] as const;
const PERP_FUNDING_COLS = [
  "agent_id", "mode", "epoch", "market_id", "funding_id", "funding_hour", "payment_micro", "rate_ppm",
  "position_base", "position_side", "created_at",
] as const;
const PERP_CARRY_COLS = ["agent_id", "mode", "epoch", "market_id", "side", "base", "mark_price", "entry_quote_micro", "created_at"] as const;
/** Every perp_orders column EXCEPT tx_info — see the note above. */
const PERP_ORDER_COLS = [
  "id", "agent_id", "mode", "epoch", "account_index", "api_key_index", "nonce", "tx_hash", "tx_type", "expired_at",
  "status", "effect", "reduce_only", "market_id", "worst_notional_micro", "filled_base", "filled_quote_micro",
  "decision_id", "reason", "created_at", "resolved_at", "updated_at",
] as const;
const PERP_LEG_COLS = [
  "agent_id", "mode", "order_id", "role", "client_order_index", "venue_order_index", "status", "venue_status",
  "created_at", "updated_at",
] as const;
const PERP_TRANSFER_COLS = [
  "id", "agent_id", "mode", "epoch", "direction", "amount_micro", "initiator", "state", "chain_id", "tx_hash",
  "log_index", "user_op_hash", "venue_tx_hash", "paid_tx_hash", "paid_log_index", "order_id", "created_at", "updated_at",
] as const;
/**
 * The position row, with the level it is PROTECTED at (`recorded_stop_*`,
 * paper.ts PaperPerpPosition.recordedStop) beside its resting stop child: a
 * gapped stop leaves the child gone and the level standing, and a shared book
 * without it would say a position was protected at the settings ceiling.
 */
const PERP_POSITION_COLS = [
  "agent_id", "mode", "market_id", "side", "base", "entry_price", "allocated_margin_micro", "imf_bp", "margin_mode",
  "realized_micro", "funding_micro", "stop_trigger", "stop_price", "recorded_stop_trigger", "recorded_stop_price",
  "take_trigger", "take_price", "funding_hour_applied", "opened_at", "updated_at", "source",
] as const;
const PERP_ACCOUNT_COLS = [
  "agent_id", "mode", "account_index", "registered_pubkey", "retired_pubkeys", "nonce_high_water",
  "paper_collateral_micro", "incident_json", "entries_halted", "last_venue_read_at", "last_snapshot_time",
  "created_at", "updated_at",
] as const;

type Row = Record<string, unknown>;

/** The row's values for `cols`, agent_id lowercased — the perp tables' rule, applied again at the copy. */
function valuesOf(r: Row, cols: readonly string[]): unknown[] {
  return cols.map((c) => (c === "agent_id" ? String(r.agent_id ?? "").toLowerCase() : (r[c] ?? null)));
}

function insertSql(table: string, cols: readonly string[]): string {
  return `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING`;
}

/**
 * WHERE A PERP TABLE'S COPY HAS GOT TO: the stamp (`created_at` or
 * `updated_at`, unix seconds) and the child rowid of the last row copied, in
 * that order. Kept in mirror_state's own two integers — `last_id` the stamp
 * and `last_stamp` the rowid tie-break — so no shared schema moves. For the
 * perp rows `last_stamp` is therefore NOT the id-cursor witness
 * MIRROR_STATE_DDL describes; nothing reads it as one (the witness
 * reconciliation walks LOG_TABLES only). The tenant is the worker's key, so a
 * login's Spot and Perps workers, whose children are two ledgers with two
 * rowid spaces, never share a cursor.
 */
interface PerpCursor {
  stamp: number;
  rowid: number;
}

/** The rowid alias every keyset read selects beside the copied columns (never itself copied: valuesOf picks by name). */
const ROWID = "mirror_rowid";

async function perpCursorOf(shared: Db, tenant: string, key: string): Promise<PerpCursor> {
  const m = (await shared
    .prepare(`SELECT last_id, last_stamp FROM mirror_state WHERE tenant = ? AND table_name = ?`)
    .get(tenant, key)) as { last_id: number; last_stamp: number | null } | undefined;
  // A cursor with a stamp and no rowid (a bare-time one): resume AT that
  // stamp, ties included — a re-read is free, a skipped row is not.
  return { stamp: Number(m?.last_id ?? 0), rowid: m?.last_stamp === null || m?.last_stamp === undefined ? -1 : Number(m.last_stamp) };
}

/**
 * Moves only forward, in (stamp, rowid) order: a pass that read nothing past
 * the cursor leaves it where it was. Both CASEs read the OLD row (SQL
 * evaluates every SET expression against it), so their order is immaterial,
 * and every existing-row column is qualified, as Postgres requires inside DO
 * UPDATE SET (see class_positions above).
 */
async function advancePerpCursor(db: Db, tenant: string, key: string, to: PerpCursor, nowSec: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO mirror_state (tenant, table_name, last_id, last_stamp, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (tenant, table_name) DO UPDATE SET
         last_stamp = CASE WHEN excluded.last_id > mirror_state.last_id
                             OR (excluded.last_id = mirror_state.last_id AND excluded.last_stamp > COALESCE(mirror_state.last_stamp, -1))
                           THEN excluded.last_stamp ELSE mirror_state.last_stamp END,
         last_id = CASE WHEN excluded.last_id > mirror_state.last_id THEN excluded.last_id ELSE mirror_state.last_id END,
         updated_at = excluded.updated_at`,
    )
    .run(tenant, key, to.stamp, to.rowid, nowSec);
}

function cursorOfRow(r: Row, stamp: string): PerpCursor {
  return { stamp: Number(r[stamp] ?? 0), rowid: Number(r[ROWID] ?? -1) };
}

/**
 * The FORWARD part of a pass: child rows strictly after `after` in (stamp,
 * rowid) order, at most PERP_MAX_PAGES pages. Each page resumes from the last
 * row of the one before — never by OFFSET, which a worker writing between two
 * pages would shift under the read. `more` is the honest answer to "is that
 * all?": the last page this pass may read came back full, so rows may follow
 * it that this pass did not reach.
 */
async function readAfter(
  child: Db, table: string, cols: readonly string[], stamp: string, after: PerpCursor, batch: number,
): Promise<{ rows: Row[]; more: boolean }> {
  const out: Row[] = [];
  let at = after;
  for (let page = 0; page < PERP_MAX_PAGES; page++) {
    const rows = (await child
      .prepare(
        `SELECT rowid AS ${ROWID}, ${cols.join(", ")} FROM ${table}
          WHERE ${stamp} > ? OR (${stamp} = ? AND rowid > ?)
          ORDER BY ${stamp} ASC, rowid ASC LIMIT ?`,
      )
      .all(at.stamp, at.stamp, at.rowid, batch)) as Row[];
    out.push(...rows);
    const last = rows[rows.length - 1];
    if (rows.length < batch || !last) return { rows: out, more: false };
    at = cursorOfRow(last, stamp);
  }
  return { rows: out, more: true };
}

/**
 * The LOOKBACK part: child rows AT OR BEFORE `cursor`, no older than
 * PERP_LOOKBACK_SEC behind it, newest first (the stragglers it exists for sit
 * right behind the cursor), at most PERP_MAX_PAGES pages. Nothing before the
 * first copy: the forward part covers everything then. Never a reason for
 * hasMore: these rows were all passed once, and a capped re-read that said
 * "more" would keep a drain asking the same question for ever.
 */
async function readLookback(child: Db, table: string, cols: readonly string[], stamp: string, cursor: PerpCursor, batch: number): Promise<Row[]> {
  if (cursor.stamp <= 0) return [];
  const floor = Math.max(0, cursor.stamp - PERP_LOOKBACK_SEC);
  const out: Row[] = [];
  let at = { stamp: cursor.stamp, rowid: cursor.rowid, inclusive: true };
  for (let page = 0; page < PERP_MAX_PAGES; page++) {
    const rows = (await child
      .prepare(
        `SELECT rowid AS ${ROWID}, ${cols.join(", ")} FROM ${table}
          WHERE ${stamp} >= ? AND (${stamp} < ? OR (${stamp} = ? AND rowid ${at.inclusive ? "<=" : "<"} ?))
          ORDER BY ${stamp} DESC, rowid DESC LIMIT ?`,
      )
      .all(floor, at.stamp, at.stamp, at.rowid, batch)) as Row[];
    out.push(...rows);
    const last = rows[rows.length - 1];
    if (rows.length < batch || !last) break;
    at = { ...cursorOfRow(last, stamp), inclusive: false };
  }
  return out;
}

/** SQLSTATE 23505 (Postgres) or SQLITE_CONSTRAINT_UNIQUE / _PRIMARYKEY (node:sqlite) — matched on codes first, the message last. */
function isUniqueViolation(e: unknown): boolean {
  const x = e as { code?: unknown; errcode?: unknown; message?: unknown } | null;
  if (x?.code === "23505" || x?.errcode === 2067 || x?.errcode === 1555) return true;
  return typeof x?.message === "string" && /UNIQUE constraint failed|duplicate key value violates unique constraint/.test(x.message);
}

/**
 * THE INCIDENT AS THE SHARED DATABASE MAY HOLD IT — an allowlist, like
 * publicGrantView, not a denylist: its kind and its time, nothing else.
 * Unparseable is still an incident, never none.
 */
function sharedIncident(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  try {
    const j = JSON.parse(String(raw)) as { kind?: unknown; at?: unknown };
    const kind = typeof j.kind === "string" && /^[A-Za-z0-9:._-]{1,64}$/.test(j.kind) ? j.kind : "unreadable";
    const at = typeof j.at === "number" && Number.isSafeInteger(j.at) ? j.at : 0;
    return JSON.stringify({ at, kind });
  } catch {
    return JSON.stringify({ at: 0, kind: "unreadable" });
  }
}

function retiredOf(raw: unknown): string[] {
  try {
    const v = JSON.parse(String(raw ?? "[]")) as unknown;
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The perp transfers already said to contradict the shared ledger, per
 * tenant, so each is logged once per process rather than once per pass for as
 * long as it sits inside the lookback. Bounded: a contradiction is rare, and
 * forgetting the set only means saying one again.
 */
const saidTransferConflicts = new Set<string>();

/**
 * Copy one tenant's perp ledger up. Never throws: each table records its own
 * failure and leaves its cursor where it was, so the next pass retries.
 *
 * Counts are recorded only when something arrived. Most tenants never trade
 * perps, and eight zeros on every tenant's line every fifteen seconds would
 * bury the line; a failure is still always recorded — for a child that holds
 * a perp row. One that holds none adds nothing at all (see the note above).
 */
export async function mirrorPerpLedger(args: {
  child: Db;
  shared: Db;
  tenant: string;
  nowSec: number;
  batch: number;
  copied: Record<string, number>;
  failed: Record<string, string>;
  /** The account the caller names, held to the grant's exactly as mirrorTenant's `account` (agreedAccount). */
  account?: string | null;
}): Promise<{ hasMore: boolean }> {
  const { child, shared, tenant, nowSec, batch, copied, failed } = args;
  let hasMore = false;

  // ── THE INERT GATE: the child, and only the child, first ──────────────────
  // Which perp tables this ledger has (one from before perps has none), then
  // whether any of them holds a row. No shared statement before this answer.
  let present: Set<string>;
  try {
    const tables = (await child
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${PERP_TABLES.map(() => "?").join(", ")})`)
      .all(...PERP_TABLES)) as { name: string }[];
    present = new Set(tables.map((t) => String(t.name)));
    if (!present.size) return { hasMore };
    const any = (await child
      .prepare(`SELECT ${[...present].map((t) => `EXISTS (SELECT 1 FROM ${t})`).join(" OR ")} AS held`)
      .get()) as { held?: unknown } | undefined;
    if (Number(any?.held ?? 0) !== 1) return { hasMore };
  } catch (e) {
    // The child itself could not be read: not a finished copy, and not a
    // shared fault either — nothing on the shared side was asked.
    failed.perp = e instanceof Error ? e.message : String(e);
    return { hasMore };
  }
  const has = (t: string) => present.has(t);

  // ── WHOSE ROWS THESE MAY BE ───────────────────────────────────────────────
  let account: string | null;
  try {
    account = agreedAccount(await tenantGrantAccount(shared, tenant), args.account);
  } catch (e) {
    failed.perp = e instanceof Error ? e.message : String(e);
    return { hasMore };
  }
  if (!account) {
    // NO ACCOUNT TO COPY UNDER, AND THIS LEDGER MAY BE THE BOOK'S ONLY COPY —
    // a paper book has no venue behind it to re-read. Nothing is copied and
    // no cursor moves, so the first pass that can name the account (a grant,
    // or a final pass's caller naming the worker's own) copies everything.
    failed.perp =
      "perp rows have no account to be copied under (no single grant names one, or the caller's disagrees with it); " +
      "the child's ledger is their only copy, so it is kept until a pass can name the account";
    return { hasMore };
  }
  const own = (r: Row) => String(r.agent_id ?? "").toLowerCase() === account;

  const step = async (key: string, run: () => Promise<number>) => {
    try {
      const n = await run();
      if (n > 0) copied[key] = n;
    } catch (e) {
      failed[key] = e instanceof Error ? e.message : String(e);
    }
  };

  /**
   * One table, one pass: the lookback and the forward part (see the section
   * header), applied in ONE shared transaction with the cursor move. The
   * cursor moves to the last FORWARD row, past foreign rows too — they are
   * settled, counted on the pass that passes them and never copied; a pass
   * that found nothing past it leaves it alone.
   */
  const copyTable = async (table: string, cols: readonly string[], stamp: "created_at" | "updated_at", apply: (db: Db, r: Row) => Promise<number>) => {
    const cursor = await perpCursorOf(shared, tenant, table);
    const behind = await readLookback(child, table, cols, stamp, cursor, batch);
    const ahead = await readAfter(child, table, cols, stamp, cursor, batch);
    if (ahead.more) hasMore = true;
    if (!behind.length && !ahead.rows.length) return 0;
    const foreign = ahead.rows.filter((r) => !own(r)).length;
    let n = 0;
    await shared.tx(async (db) => {
      for (const r of behind) if (own(r)) n += await apply(db, r);
      for (const r of ahead.rows) if (own(r)) n += await apply(db, r);
      const last = ahead.rows[ahead.rows.length - 1];
      if (last) await advancePerpCursor(db, tenant, table, cursorOfRow(last, stamp), nowSec);
    });
    if (foreign > 0) copied[`${table}_foreign`] = foreign;
    return n;
  };

  // ── append-only: fills, funding, carries ──────────────────────────────────
  const appendOnly = (table: string, cols: readonly string[]) => {
    const sql = insertSql(table, cols);
    return copyTable(table, cols, "created_at", async (db, r) => Number((await db.prepare(sql).run(...valuesOf(r, cols))).changes));
  };
  if (has("perp_fills")) await step("perp_fills", () => appendOnly("perp_fills", PERP_FILL_COLS));
  if (has("perp_funding")) await step("perp_funding", () => appendOnly("perp_funding", PERP_FUNDING_COLS));
  if (has("perp_carries")) await step("perp_carries", () => appendOnly("perp_carries", PERP_CARRY_COLS));

  // ── rank-guarded: orders, legs, transfers ─────────────────────────────────
  const updated = (table: string, cols: readonly string[], apply: (db: Db, r: Row) => Promise<number>) =>
    copyTable(table, cols, "updated_at", apply);

  const orderRank = rankCaseSql("perp_orders.status", PERP_ORDER_RANK);
  if (has("perp_orders")) await step("perp_orders", () =>
    updated("perp_orders", PERP_ORDER_COLS, async (db, r) => {
      const status = String(r.status);
      const rank = PERP_ORDER_RANK[status as keyof typeof PERP_ORDER_RANK] ?? -1;
      // Matched by id OR by the nonce it was signed with: a row a rebuilt
      // child re-adopted under a new id is still the same signed tx, and the
      // row already here is the one to advance. Never another account's: the
      // account is in the match, and the row was checked to be this one's.
      const res = await db
        .prepare(
          `UPDATE perp_orders
              SET status = ?, filled_base = COALESCE(?, filled_base), filled_quote_micro = COALESCE(?, filled_quote_micro),
                  reason = COALESCE(?, reason), resolved_at = COALESCE(?, resolved_at),
                  updated_at = ?
            WHERE agent_id = ? AND mode = ?
              AND (id = ? OR (nonce IS NOT NULL AND account_index = ? AND api_key_index = ? AND nonce = ?))
              AND (${orderRank} < ? OR (perp_orders.status = ? AND perp_orders.updated_at < ?))`,
        )
        .run(
          status, r.filled_base ?? null, r.filled_quote_micro ?? null, r.reason ?? null, r.resolved_at ?? null, r.updated_at,
          String(r.agent_id ?? "").toLowerCase(), r.mode, r.id, r.account_index ?? null, r.api_key_index ?? null, r.nonce ?? null,
          rank, status, r.updated_at,
        );
      if (Number(res.changes) > 0) return Number(res.changes);
      return Number((await db.prepare(insertSql("perp_orders", PERP_ORDER_COLS)).run(...valuesOf(r, PERP_ORDER_COLS))).changes);
    }),
  );

  const legRank = rankCaseSql("perp_order_legs.status", PERP_LEG_RANK);
  if (has("perp_order_legs")) await step("perp_order_legs", () =>
    updated("perp_order_legs", PERP_LEG_COLS, async (db, r) => {
      const status = String(r.status);
      const rank = PERP_LEG_RANK[status as keyof typeof PERP_LEG_RANK] ?? -1;
      const res = await db
        .prepare(
          `UPDATE perp_order_legs
              SET status = ?, venue_order_index = COALESCE(venue_order_index, ?), venue_status = COALESCE(?, venue_status),
                  updated_at = ?
            WHERE agent_id = ? AND mode = ? AND client_order_index = ?
              AND (${legRank} < ? OR (perp_order_legs.status = ? AND perp_order_legs.updated_at < ?))`,
        )
        .run(
          status, r.venue_order_index ?? null, r.venue_status ?? null, r.updated_at,
          String(r.agent_id ?? "").toLowerCase(), r.mode, r.client_order_index, rank, status, r.updated_at,
        );
      if (Number(res.changes) > 0) return Number(res.changes);
      return Number((await db.prepare(insertSql("perp_order_legs", PERP_LEG_COLS)).run(...valuesOf(r, PERP_LEG_COLS))).changes);
    }),
  );

  const transferRank = rankCaseSql("perp_transfers.state", PERP_TRANSFER_RANK);
  // Child transfers that contradict the shared ledger this pass, by child id.
  // Counted, never merged, and the cursor moves past them.
  const transferConflicts = new Set<string>();
  const applyTransfer = async (db: Db, r: Row): Promise<number> => {
    const state = String(r.state);
    const rank = PERP_TRANSFER_RANK[state as keyof typeof PERP_TRANSFER_RANK] ?? -1;
    const agent = String(r.agent_id ?? "").toLowerCase();
    const id = String(r.id ?? "");
    // WHO ALREADY HOLDS THIS TRANSFER — by its id or by any identity it
    // carries, each looked up in EXACTLY the scope of the unique index that
    // guards it (store.ts: the primary key is global; chain log is per
    // (chain, agent); UserOp and venue hash per (agent, mode)). So no identity
    // filled below can collide with a row this read did not see.
    const holders = (await db
      .prepare(
        `SELECT id, agent_id, mode, direction, amount_micro, chain_id, tx_hash, log_index, user_op_hash, venue_tx_hash
           FROM perp_transfers
          WHERE id = ?
             OR (agent_id = ? AND mode = ? AND venue_tx_hash IS NOT NULL AND venue_tx_hash = ?)
             OR (agent_id = ? AND mode = ? AND user_op_hash IS NOT NULL AND user_op_hash = ?)
             OR (agent_id = ? AND tx_hash IS NOT NULL AND log_index IS NOT NULL AND chain_id = ? AND tx_hash = ? AND log_index = ?)`,
      )
      .all(
        id,
        agent, r.mode, r.venue_tx_hash ?? null,
        agent, r.mode, r.user_op_hash ?? null,
        agent, r.chain_id ?? null, r.tx_hash ?? null, r.log_index ?? null,
      )) as Row[];
    if (!holders.length) {
      return Number((await db.prepare(insertSql("perp_transfers", PERP_TRANSFER_COLS)).run(...valuesOf(r, PERP_TRANSFER_COLS))).changes);
    }
    // ONE TARGET: the row with this child row's own id, else the only holder
    // (a transfer a rebuilt child re-derived under a new id is the row already
    // here, not a second one). Several holders and none of them this id is
    // ambiguous — which one is "this" transfer is not the mirror's to guess.
    // A holder under another account is never this one's (the id is global).
    const target = holders.find((h) => h.id === id) ?? (holders.length === 1 ? holders[0] : undefined);
    const amount = textInt(r.amount_micro);
    const same =
      target !== undefined &&
      String(target.agent_id ?? "").toLowerCase() === agent &&
      target.mode === r.mode &&
      target.direction === r.direction &&
      amount !== null &&
      textInt(target.amount_micro) === amount;
    if (!target || !same) {
      transferConflicts.add(id);
      return 0;
    }
    // Another shared row ALSO holds one of these identities: two shared rows
    // claim one transfer (a rebuilt child booked it before it could know the
    // identity that ties them). The target still moves forward — it is the
    // child's own row, or the only candidate — but it takes no identity the
    // other row holds, and the conflict is counted for a person to settle.
    const others = holders.filter((h) => h.id !== target.id);
    if (others.length) transferConflicts.add(id);
    const heldElsewhere = (col: "venue_tx_hash" | "user_op_hash") =>
      r[col] !== null && r[col] !== undefined && others.some((h) => h[col] === r[col]);
    const chainKnown = r.chain_id !== null && r.chain_id !== undefined && r.tx_hash !== null && r.tx_hash !== undefined && r.log_index !== null && r.log_index !== undefined;
    // The chain log moves as ONE identity — all three columns from the child,
    // only onto a target with none, and never a chain id that disagrees — so
    // the triple written is exactly the triple looked up above.
    const fillChain =
      chainKnown &&
      (target.tx_hash === null || target.tx_hash === undefined) &&
      (target.log_index === null || target.log_index === undefined) &&
      (target.chain_id === null || target.chain_id === undefined || Number(target.chain_id) === Number(r.chain_id)) &&
      !others.some((h) => Number(h.chain_id) === Number(r.chain_id) && h.tx_hash === r.tx_hash && Number(h.log_index) === Number(r.log_index));
    const res = await db
      .prepare(
        `UPDATE perp_transfers
            SET state = ?,
                chain_id = CASE WHEN ? = 1 THEN ? ELSE chain_id END,
                tx_hash = CASE WHEN ? = 1 THEN ? ELSE tx_hash END,
                log_index = CASE WHEN ? = 1 THEN ? ELSE log_index END,
                user_op_hash = COALESCE(user_op_hash, ?), venue_tx_hash = COALESCE(venue_tx_hash, ?),
                paid_tx_hash = COALESCE(paid_tx_hash, ?), paid_log_index = COALESCE(paid_log_index, ?),
                order_id = COALESCE(order_id, ?), updated_at = ?
          WHERE id = ?
            AND (${transferRank} < ? OR (perp_transfers.state = ? AND perp_transfers.updated_at < ?))`,
      )
      .run(
        state,
        fillChain ? 1 : 0, r.chain_id ?? null,
        fillChain ? 1 : 0, r.tx_hash ?? null,
        fillChain ? 1 : 0, r.log_index ?? null,
        heldElsewhere("user_op_hash") ? null : (r.user_op_hash ?? null),
        heldElsewhere("venue_tx_hash") ? null : (r.venue_tx_hash ?? null),
        r.paid_tx_hash ?? null, r.paid_log_index ?? null, r.order_id ?? null, r.updated_at,
        target.id, rank, state, r.updated_at,
      );
    return Number(res.changes);
  };
  if (has("perp_transfers")) await step("perp_transfers", async () => {
    const n = await updated("perp_transfers", PERP_TRANSFER_COLS, async (db, r) => {
      // A SAVEPOINT PER ROW, the last line under the resolution above: should
      // any row still meet a unique index, it is rolled back ALONE and
      // counted, and the batch — every later transfer, and the cursor —
      // commits. Postgres aborts a whole transaction on a failed statement, so
      // catching without a savepoint would only move the failure to COMMIT.
      // Anything but a unique violation still fails the table, as before.
      await db.prepare("SAVEPOINT perp_transfer_row").run();
      try {
        const changed = await applyTransfer(db, r);
        await db.prepare("RELEASE SAVEPOINT perp_transfer_row").run();
        return changed;
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        await db.prepare("ROLLBACK TO SAVEPOINT perp_transfer_row").run();
        await db.prepare("RELEASE SAVEPOINT perp_transfer_row").run();
        transferConflicts.add(String(r.id ?? ""));
        return 0;
      }
    });
    // INFORMATIONAL, NOT `failed`, AND ON PURPOSE. A contradiction is a child
    // row the mirror refused to merge, so it is counted beside the copies
    // (`perp_transfers_conflict`, never among the arrivals) and said once per
    // process. It is NOT a failure because nothing is left uncopied that a
    // later pass could copy: the cursor has moved, the row is still intact in
    // the child, and every later transfer arrived. In `failed` it would hold
    // every final pass — the anchor, the drain, the retirement, the fleet
    // checkpoint — for exactly as long as the row sat inside the lookback, and
    // then let them through with nothing settled: a block that proves
    // nothing. And it can only arise from a chain identity two rows claim (a
    // UserOp, a venue hash, a chain log), which a paper transfer never has —
    // a hosted Perps book is paper only in this build. The live rail will need
    // its own durable record of these before any deposit is real.
    if (transferConflicts.size) {
      copied.perp_transfers_conflict = transferConflicts.size;
      const fresh = [...transferConflicts].filter((id) => !saidTransferConflicts.has(`${tenant} ${id}`));
      if (fresh.length) {
        if (saidTransferConflicts.size > 10_000) saidTransferConflicts.clear();
        for (const id of fresh) saidTransferConflicts.add(`${tenant} ${id}`);
        const ids = fresh.slice(0, 5).join(", ");
        console.warn(
          `[perps] ledger mirror: ${tenant} — ${fresh.length} transfer row(s) contradict the shared ledger and were not merged ` +
            `(${ids}${fresh.length > 5 ? ", …" : ""}); later rows were copied, and the child still holds them`,
        );
      }
    }
    return n;
  });

  // ── snapshots: positions and the account row ─────────────────────────────
  //
  // Small (a market per row, two rails per agent) and rewritten in place, so
  // every row is read every pass and copied when it is NEWER than the row
  // already here — or, at the SAME stamp, when it says something different.
  //
  // A TIE GOES TO THE CHILD. The stamp is in seconds, and the child keeps
  // committing while a pass reads it from another process, so one pass can
  // copy a write and miss a second one made within the same second. For a
  // position that second write is as often as not the CLOSE — the hour's
  // funding booked, then the stop or a liquidation, in one executor pass,
  // each its own commit — and a flat row is not written again until that
  // market next trades; nor does the flatten below look at a market the
  // child still holds a row for. Strictly-newer would leave the shared book
  // showing the closed position open, its margin and its stop with it, for
  // as long as the market stayed quiet. At a tie the child's row is the
  // later word: it is what the shared row was copied from, and the shared
  // side's own writers never race it within a second — the flatten below
  // never touches a market the child holds, and the held reset
  // (paper-checkpoint.ts resetBlockedPaperBookIn) runs only for a tenant
  // with no worker, whose ledger no pass reads. A tie that says the same
  // thing is not a copy: an unchanged row is still not rewritten (and not
  // counted) on every pass. An OLDER child row never wins, whatever it says.
  //
  // BOTH FROM ONE CHILD READ. The flatten below takes its evidence from the
  // newest write on each rail across BOTH tables, and two separate reads
  // could pair an account row from after a close with positions from before
  // it — evidence from two instants, which is no evidence.
  let snap: { accounts: Row[]; positions: Row[] };
  try {
    snap = await child.tx(async (db) => ({
      accounts: has("perp_accounts") ? ((await db.prepare(`SELECT ${PERP_ACCOUNT_COLS.join(", ")} FROM perp_accounts`).all()) as Row[]) : [],
      positions: has("perp_positions") ? ((await db.prepare(`SELECT ${PERP_POSITION_COLS.join(", ")} FROM perp_positions`).all()) as Row[]) : [],
    }));
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (has("perp_accounts")) failed.perp_accounts = why;
    if (has("perp_positions")) failed.perp_positions = why;
    return { hasMore };
  }
  const foreignAccounts = snap.accounts.filter((r) => !own(r)).length;
  const foreignPositions = snap.positions.filter((r) => !own(r)).length;
  const accounts = snap.accounts.filter(own);
  const positions = snap.positions.filter(own);
  if (foreignAccounts > 0) copied.perp_accounts_foreign = foreignAccounts;
  if (foreignPositions > 0) copied.perp_positions_foreign = foreignPositions;

  if (has("perp_accounts")) await step("perp_accounts", async () => {
    if (!accounts.length) return 0;
    let n = 0;
    await shared.tx(async (db) => {
      for (const r of accounts) {
        const agent = String(r.agent_id ?? "").toLowerCase();
        // The row's lock first, so a concurrent pass for the same rail reads
        // the row this one writes rather than the one before it.
        await db.prepare("UPDATE perp_accounts SET entries_halted = entries_halted WHERE agent_id = ? AND mode = ?").run(agent, r.mode);
        const held = (await db
          .prepare(`SELECT ${PERP_ACCOUNT_COLS.join(", ")} FROM perp_accounts WHERE agent_id = ? AND mode = ?`)
          .get(agent, r.mode)) as Row | undefined;
        const incident = sharedIncident(r.incident_json);
        if (!held) {
          n += Number(
            (await db.prepare(insertSql("perp_accounts", PERP_ACCOUNT_COLS)).run(...valuesOf({ ...r, incident_json: incident }, PERP_ACCOUNT_COLS))).changes,
          );
          continue;
        }
        // MONOTONIC WHATEVER THE ORDER, like the agents row's ratchets: a
        // rebuilt child restarts both of these, and neither may go backwards
        // here — the high-water only rises (compared as integers, never as
        // the TEXT it is stored in, where "9" sorts above "10"), and a key
        // once retired stays retired. Everything else follows the newer row
        // — the CHILD'S ON A TIE, for the reason the snapshots' note above
        // gives; `changed` below keeps a tie that says nothing new unwritten.
        const childHigh = textInt(r.nonce_high_water);
        const heldHigh = textInt(held.nonce_high_water);
        const high = childHigh === null ? heldHigh : heldHigh === null || childHigh > heldHigh ? childHigh : heldHigh;
        const retired = [...new Set([...retiredOf(held.retired_pubkeys), ...retiredOf(r.retired_pubkeys)])].sort();
        const childWins = Number(r.updated_at ?? 0) >= Number(held.updated_at ?? 0);
        const pick = (c: string) => (childWins ? (r[c] ?? null) : (held[c] ?? null));
        const next: Row = {
          account_index: r.account_index ?? held.account_index ?? null,
          registered_pubkey: childWins ? (r.registered_pubkey ?? held.registered_pubkey ?? null) : (held.registered_pubkey ?? null),
          retired_pubkeys: JSON.stringify(retired),
          nonce_high_water: high === null ? null : high.toString(),
          paper_collateral_micro: pick("paper_collateral_micro"),
          // Kind and time only, from whichever row wins (sharedIncident).
          incident_json: childWins ? incident : (held.incident_json ?? null),
          entries_halted: pick("entries_halted") ?? 0,
          last_venue_read_at: pick("last_venue_read_at"),
          last_snapshot_time: Math.max(Number(r.last_snapshot_time ?? 0), Number(held.last_snapshot_time ?? 0)) || null,
          updated_at: childWins ? r.updated_at : held.updated_at,
        };
        const changed = Object.keys(next).some((k) => String(next[k] ?? "") !== String(held[k] ?? ""));
        if (!changed) continue;
        n += Number(
          (await db
            .prepare(
              `UPDATE perp_accounts SET account_index = ?, registered_pubkey = ?, retired_pubkeys = ?, nonce_high_water = ?,
                      paper_collateral_micro = ?, incident_json = ?, entries_halted = ?, last_venue_read_at = ?,
                      last_snapshot_time = ?, updated_at = ?
                WHERE agent_id = ? AND mode = ?`,
            )
            .run(
              next.account_index, next.registered_pubkey, next.retired_pubkeys, next.nonce_high_water,
              next.paper_collateral_micro, next.incident_json, next.entries_halted, next.last_venue_read_at,
              next.last_snapshot_time, next.updated_at, agent, r.mode,
            )).changes,
        );
      }
    });
    return n;
  });

  if (has("perp_positions")) await step("perp_positions", async () => {
    if (!positions.length && !accounts.length) return 0;
    let n = 0;
    await shared.tx(async (db) => {
      const setCols = PERP_POSITION_COLS.filter((c) => c !== "agent_id" && c !== "mode" && c !== "market_id");
      // What a tie is judged on: every copied column but the stamp the two
      // rows share. IS DISTINCT FROM, so NULL against a level (a stop
      // cleared, a recorded stop gone with the close) is a difference — and
      // spelled the same on sqlite (3.39+) and Postgres. One guarded
      // statement, so the judgement and the write are one row-level step.
      const tieCols = setCols.filter((c) => c !== "updated_at");
      for (const r of positions) {
        const agent = String(r.agent_id ?? "").toLowerCase();
        const res = await db
          .prepare(
            `UPDATE perp_positions SET ${setCols.map((c) => `${c} = ?`).join(", ")}
              WHERE agent_id = ? AND mode = ? AND market_id = ?
                AND (updated_at < ? OR (updated_at = ? AND (${tieCols.map((c) => `${c} IS DISTINCT FROM ?`).join(" OR ")})))`,
          )
          .run(
            ...setCols.map((c) => r[c] ?? null), agent, r.mode, r.market_id, r.updated_at, r.updated_at,
            ...tieCols.map((c) => r[c] ?? null),
          );
        if (Number(res.changes) > 0) {
          n += Number(res.changes);
          continue;
        }
        n += Number((await db.prepare(insertSql("perp_positions", PERP_POSITION_COLS)).run(...valuesOf(r, PERP_POSITION_COLS))).changes);
      }
      // A POSITION THE CHILD NO LONGER HOLDS GOES FLAT HERE TOO — but only for
      // a rail the child can speak for. A paper reset deletes the paper rows;
      // a rebuilt child that has re-read the venue simply lacks the market it
      // closed while it was down. Either way the child's newest perp write for
      // that rail is newer than the stale row here, and that is the evidence.
      // A rebuilt child that has written nothing yet says nothing, and the
      // last known book stands — silence is not flatness. Flat as the
      // worker's own flatten writes it (store.ts setPerpPositions): no side,
      // no size, no entry, no resting children, and no recorded stop either,
      // since a flat row that claimed a protected level would be a claim
      // about a position that is not there.
      const newest = new Map<string, number>();
      const held = new Map<string, Set<number>>();
      const note = (agent: string, mode: string, at: number) => {
        const k = `${agent} ${mode}`;
        newest.set(k, Math.max(newest.get(k) ?? 0, at));
        if (!held.has(k)) held.set(k, new Set());
      };
      for (const a of accounts) note(String(a.agent_id ?? "").toLowerCase(), String(a.mode), Number(a.updated_at ?? 0));
      for (const r of positions) {
        const agent = String(r.agent_id ?? "").toLowerCase();
        note(agent, String(r.mode), Number(r.updated_at ?? 0));
        held.get(`${agent} ${String(r.mode)}`)!.add(Number(r.market_id));
      }
      for (const [k, at] of newest) {
        const [agent, mode] = k.split(" ") as [string, string];
        const markets = [...(held.get(k) ?? new Set<number>())];
        const res = await db
          .prepare(
            `UPDATE perp_positions SET side = NULL, base = '0', allocated_margin_micro = '0', entry_price = NULL,
                    stop_trigger = NULL, stop_price = NULL, take_trigger = NULL, take_price = NULL,
                    recorded_stop_trigger = NULL, recorded_stop_price = NULL, opened_at = NULL,
                    updated_at = ?
              WHERE agent_id = ? AND mode = ? AND base <> '0' AND updated_at < ?${
                markets.length ? ` AND market_id NOT IN (${markets.map(() => "?").join(", ")})` : ""
              }`,
          )
          .run(at, agent, mode, at, ...markets);
        n += Number(res.changes);
      }
    });
    return n;
  });

  return { hasMore };
}
