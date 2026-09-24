/**
 * PRE-REDEPLOY TRADES, SEEN THROUGH THE SAME QUERIES AS TODAY'S.
 *
 * A hosted agent's ledger starts empty after every redeploy; the orchestrator
 * leaves the trades and decisions from before it in `trade-history.json`
 * (history-files.ts). This lays that file over the ledger for ONE read-only
 * connection: TEMP tables named `trades` and `decisions` holding this agent's
 * ledger rows plus the carried ones. SQLite resolves an unqualified name to the
 * temp schema first, so every existing lookup — /trades, /why, list_trades,
 * the P&L breakdown, decisions, find_token, the coin-name resolver — sees the
 * whole tape without a line of its SQL changing, and the ledger file itself
 * is never written (the connection is read-only; temp objects live in memory
 * and die with it).
 *
 * TABLES, NOT VIEWS. A UNION ALL view over the ledger cannot be index-searched
 * inside a join, so SQLite rebuilt the whole view and a throwaway index on
 * every coin-name lookup — once per row shown — and the chat runs inside the
 * trading process. A copy made once per connection, carrying the ledger's own
 * indexes, costs one bulk copy and then answers every query at ledger speed.
 * The two heavy JSON columns no chat read uses are left out of the copy.
 *
 * Only the chat's own connections get the overlay. The notifier, the budgets,
 * the cost basis and everything that trades open the ledger on their own and
 * never see a carried row (history-boundary.test.ts).
 *
 * ONE ROW PER OPERATION across the two. See planHistoryMerge.
 */

import { statSync } from "node:fs";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { merrymenHome } from "../home";
import { historyFilePath, readHistory, type HistoryTrade, type TradeHistory } from "../history-files";
import { isRestartCopy } from "../token-label";
import { UNCONFIRMED } from "./trade-rows";

/** What the ledger already holds for one operation. */
export interface LocalOp {
  /** At least one row for it is the executor's own (not a restart copy). */
  real: boolean;
  /** How the ledger's rows say it ended, when one of them knows ("landed", "reverted"…); null when all are still submitted. */
  status: string | null;
  tx: string | null;
}

export interface LocalOps {
  /** Lowercased op hash → what the ledger holds for it. */
  ops: Map<string, LocalOp>;
  /** The ledger's earliest trade row for this agent (unix seconds), or null when it has none. */
  firstAt: number | null;
}

export interface MergePlan {
  /** Carried rows to show. */
  trades: HistoryTrade[];
  /** Op hashes whose LOCAL restart copies the carried row replaces. */
  supersede: string[];
}

/**
 * Which carried trades to show beside the ledger's, and which of the ledger's
 * rows they replace. Pure.
 *
 *  - THE LEDGER'S OWN ROW WINS. An op the ledger holds from its executor is
 *    shown from the ledger, never twice.
 *  - EXCEPT A RESTART COPY. After a redeploy the reconciler re-writes recent
 *    ops as bare copies — no coin, no decision, stamped at the restart. When
 *    the carried row for that op is the real one, it replaces the copy, which
 *    is how "8 nameless rows at 01:07:59" become the eight trades they were.
 *  - BUT NOT HOW IT ENDED. The shared copy of an op sent just before a
 *    redeploy can still say "submitted" — the old run never lived to mirror
 *    the outcome, and this file was read before the new run's mirror could.
 *    The ledger's copy exists only because the chain says the op succeeded,
 *    so its status (and tx) is kept: the mirror's own resolution rule.
 *  - A carried op still "submitted" with nothing here was sent before a
 *    restart and its end is not on record; it says so (UNCONFIRMED) rather
 *    than "waiting to confirm" for ever.
 *  - A ROW WITH NO HASH (a refusal, a practice fill) can't be matched, so it is
 *    carried only when it is older than everything the ledger holds. Newer
 *    ones are this ledger's own rows already mirrored up — a child restarted
 *    without a redeploy keeps its ledger, and the file then overlaps it.
 */
export function planHistoryMerge(trades: readonly HistoryTrade[], agentId: string, local: LocalOps): MergePlan {
  const out: HistoryTrade[] = [];
  const supersede = new Set<string>();
  const seen = new Set<string>();
  for (const t of trades) {
    const hash = t.user_op_hash?.trim().toLowerCase() || null;
    if (!hash) {
      if (local.firstAt === null || t.created_at < local.firstAt) out.push(t);
      continue;
    }
    if (seen.has(hash)) continue; // the file is untrusted: one row per op, even if it repeats one
    seen.add(hash);
    const l = local.ops.get(hash);
    if (l?.real) continue;
    if (l) {
      // The ledger has only restart copies of this op. A carried copy adds nothing.
      if (isRestartCopy({ ...t, agent_id: agentId })) continue;
      supersede.add(hash);
      const settled = t.status === "submitted" && l.status ? l.status : t.status;
      out.push({ ...t, status: settled, tx_hash: t.tx_hash ?? l.tx });
      continue;
    }
    out.push(t.status === "submitted" ? { ...t, status: UNCONFIRMED } : t);
  }
  return { trades: out, supersede: [...supersede] };
}

/** A restart copy, in SQL, over alias `l` — isRestartCopy (token-label.ts). */
const COPY_SQL = `(l.kind = 'swap' AND l.target IS NOT NULL AND lower(l.target) = lower(l.agent_id) AND l.decision_id IS NULL AND l.fill_side IS NULL)`;

/** Columns no chat read uses, and the heaviest in the ledger. Copied as NULL. */
const NOT_COPIED = new Set(["signals_json", "evidence_json"]);

/**
 * Ledger indexes the copy does without. No chat read looks a trade up by its
 * op hash, and every one is scoped to one agent first — and the copy holds one
 * agent — so the time-only indexes only repeat (agent_id, time).
 */
const NOT_INDEXED = new Set(["trades_agent_userop", "trades_time", "decisions_time"]);

const TEMP_OBJECTS = ["trades", "decisions", "hist_supersede", "hist_meta"];

/**
 * The parsed file, kept while it is the same file. One stat instead of a parse
 * per lookup; the orchestrator replaces it by rename, which changes all three.
 */
let parsed: { key: string; file: TradeHistory } | null = null;

/** Which history file is on disk right now (size, mtime, inode), or null when there is none. */
export function historyFileKey(): string | null {
  const home = merrymenHome();
  try {
    const st = statSync(historyFilePath(home));
    return `${home}\n${st.size}\n${st.mtimeMs}\n${st.ino}`;
  } catch {
    return null;
  }
}

function historyFor(agentId: string): TradeHistory | null {
  const file = historyFileKey();
  if (file === null) return null; // absent: exactly what readHistory says
  const key = `${file}\n${agentId.toLowerCase()}`;
  if (parsed?.key === key) return parsed.file;
  // ONLY A PARSE IS KEPT. readHistory says null for a file it rejected and for
  // one it could not read (a spent file-descriptor table, an I/O error) alike;
  // kept, a passing failure would stand until the orchestrator next rewrote the
  // file — the whole life of a child. A rejected file is read again next time,
  // as every lookup did before there was a cache.
  const read = readHistory(merrymenHome(), agentId);
  parsed = read ? { key, file: read } : null;
  return read;
}

/** The carried history for `agentId` (cached while the file is the same file), or null. */
export function carriedHistory(agentId: string): TradeHistory | null {
  return historyFor(agentId);
}

const q = (c: string) => `"${c.replace(/"/g, '""')}"`;

function columns(db: DatabaseSync, schema: "main" | "temp", table: string): string[] {
  return (db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string }[]).map((r) => r.name);
}

function readLocal(db: DatabaseSync, agentId: string): LocalOps {
  const ops = new Map<string, LocalOp>();
  const rows = db
    .prepare(
      `SELECT lower(l.user_op_hash) AS h, MAX(CASE WHEN ${COPY_SQL} THEN 0 ELSE 1 END) AS real,
              MAX(CASE WHEN l.status <> 'submitted' THEN l.status END) AS status, MAX(l.tx_hash) AS tx
         FROM main.trades l WHERE l.agent_id = ? AND l.user_op_hash IS NOT NULL AND l.user_op_hash <> ''
        GROUP BY lower(l.user_op_hash)`,
    )
    .all(agentId) as { h: string; real: number; status: string | null; tx: string | null }[];
  for (const r of rows) ops.set(r.h, { real: r.real === 1, status: r.status, tx: r.tx });
  const first = db.prepare("SELECT MIN(created_at) AS t FROM main.trades WHERE agent_id = ?").get(agentId) as { t: number | null } | undefined;
  return { ops, firstAt: typeof first?.t === "number" ? first.t : null };
}

/**
 * Copy this agent's rows of a ledger table into a temp table of the same name
 * and shape, with the ledger's own indexes. `where` narrows the copy (alias l).
 */
function materialize(db: DatabaseSync, table: string, agentId: string, where = ""): string[] {
  const cols = columns(db, "main", table);
  const sel = cols.map((c) => (NOT_COPIED.has(c) ? `NULL AS ${q(c)}` : `l.${q(c)}`)).join(", ");
  db.exec(`CREATE TEMP TABLE ${table} AS SELECT ${sel} FROM main.${table} l WHERE 0`);
  db.prepare(`INSERT INTO temp.${table} SELECT ${sel} FROM main.${table} l WHERE l.agent_id = ?${where}`).run(agentId);
  const indexes = db.prepare("SELECT name, sql FROM main.sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(table) as {
    name: string;
    sql: string;
  }[];
  // "CREATE [UNIQUE] INDEX [IF NOT EXISTS] name ON table (cols) [WHERE …]" → the same over the copy.
  // Never UNIQUE: a carried row may legitimately repeat a key the ledger holds.
  // Plus the primary key's, which a copy loses and whose index has no SQL to copy:
  // `t.id = (SELECT MAX(id) …)` and `d.id = t.decision_id` are lookups by it.
  const defs = [
    ...indexes.filter((ix) => !NOT_INDEXED.has(ix.name)).map((ix) => ({ name: ix.name, on: /\bON\s+("?)\w+\1\s*(\([\s\S]*)$/i.exec(ix.sql)?.[2] ?? null })),
    { name: `${table}_id`, on: "(id)" },
    // The chat looks trades up by coin — `lower(buy_token) = ? OR lower(sell_token) = ?`,
    // once per coin it names. The ledger scans for that; the copy need not.
    ...(table === "trades"
      ? [
          { name: "trades_buy", on: "(agent_id, lower(buy_token))" },
          { name: "trades_sell", on: "(agent_id, lower(sell_token))" },
        ]
      : []),
  ];
  for (const d of defs) {
    if (!d.on) continue;
    try {
      db.exec(`CREATE INDEX temp.${q(`h_${d.name}`)} ON ${table} ${d.on}`);
    } catch {
      /* an index is a speed-up, not a meaning: carry on without it */
    }
  }
  return columns(db, "temp", table);
}

function insertRows(db: DatabaseSync, table: string, cols: readonly string[], rows: readonly Record<string, unknown>[]): void {
  if (!rows.length) return;
  const use = cols.filter((c) => c in rows[0]!);
  const ins = db.prepare(`INSERT INTO temp.${table} (${use.map(q).join(", ")}) VALUES (${use.map(() => "?").join(", ")})`);
  for (const r of rows) ins.run(...use.map((c) => (r[c] ?? null) as SQLInputValue));
}

function dropOverlay(db: DatabaseSync): void {
  for (const t of TEMP_OBJECTS) {
    try {
      db.exec(`DROP TABLE IF EXISTS temp.${t}`);
    } catch {
      /* already gone */
    }
  }
}

/** True when this connection already carries the overlay. */
function overlaid(db: DatabaseSync): boolean {
  try {
    return !!db.prepare("SELECT 1 AS ok FROM temp.sqlite_master WHERE type = 'table' AND name = 'hist_meta'").get();
  } catch {
    return false;
  }
}

/**
 * How far back the carried decisions reach, when an overlay is in place: the
 * oldest decision carried as "recent". Older carried decisions exist only
 * because a carried trade links to them. Null without an overlay.
 */
export function carriedDecisionsFrom(db: DatabaseSync): number | null {
  try {
    const r = db.prepare("SELECT v FROM temp.hist_meta WHERE k = 'decisions_from'").get() as { v: number } | undefined;
    return typeof r?.v === "number" ? r.v : null;
  } catch {
    return null;
  }
}

/**
 * Lay the history file over `db` for `agentId`. Returns true when carried rows
 * are now visible. NEVER THROWS, and on any failure leaves the connection
 * exactly as it was — the plain ledger — rather than half an overlay. Calling
 * it again on the same connection is a no-op.
 *
 * `history` is for tests; by default the file in this agent's home is read.
 */
export function overlayHistory(db: DatabaseSync, agentId: string, history?: TradeHistory | null): boolean {
  if (overlaid(db)) return true;
  const file = history === undefined ? historyFor(agentId) : history;
  if (!file || (!file.trades.length && !file.decisions.length)) return false;
  let began = false;
  try {
    if (!columns(db, "main", "trades").length) return false;
    try {
      db.exec("PRAGMA temp_store = MEMORY");
    } catch {
      /* a speed-up only */
    }
    // ONE TRANSACTION: the ledger read that plans the merge and the copy it
    // plans over are the same snapshot, and the inserts are one write.
    db.exec("BEGIN");
    began = true;
    const plan = planHistoryMerge(file.trades, agentId, readLocal(db, agentId));
    const hasDecision = db.prepare("SELECT 1 AS ok FROM main.decisions WHERE id = ?");
    const decisions = file.decisions.filter((d) => !hasDecision.get(d.id));
    if (!plan.trades.length && !decisions.length) {
      db.exec("ROLLBACK");
      began = false;
      return false;
    }
    if (plan.trades.length) {
      db.exec("CREATE TEMP TABLE hist_supersede (h TEXT PRIMARY KEY)");
      const sup = db.prepare("INSERT OR IGNORE INTO temp.hist_supersede (h) VALUES (?)");
      for (const h of plan.supersede) sup.run(h);
      const cols = materialize(
        db,
        "trades",
        agentId,
        ` AND NOT (${COPY_SQL} AND l.user_op_hash IS NOT NULL AND lower(l.user_op_hash) IN (SELECT h FROM temp.hist_supersede))`,
      );
      // Negative ids: never equal to a ledger id, so `t.id = (SELECT MAX(id) …)`
      // joins still find exactly one row, and the ledger's own sorts first on a
      // tie. The file is newest first, so -1 is the newest carried row.
      insertRows(db, "trades", cols, plan.trades.map((t, i) => ({ ...t, id: -(i + 1), agent_id: agentId })));
      db.exec("DROP TABLE temp.hist_supersede");
    }
    if (decisions.length) {
      const cols = materialize(db, "decisions", agentId);
      insertRows(db, "decisions", cols, decisions.map((d) => ({ ...d, agent_id: agentId })));
    }
    db.exec("CREATE TEMP TABLE hist_meta (k TEXT PRIMARY KEY, v)");
    db.prepare("INSERT INTO temp.hist_meta (k, v) VALUES ('decisions_from', ?), ('written_at', ?)").run(file.decisionsFrom, file.writtenAt);
    db.exec("COMMIT");
    began = false;
    // STATISTICS FOR THE COPY. It holds one agent, and with no statistics the
    // planner takes `agent_id = ?` for selective: it searched the agent_id
    // prefix of whichever index came first — the whole copy — for every coin
    // name and every decision's trade, and the indexes above sat unused.
    try {
      db.exec("ANALYZE temp");
    } catch {
      /* a speed-up only */
    }
    return true;
  } catch {
    try {
      if (began) db.exec("ROLLBACK");
    } catch {
      /* nothing open */
    }
    dropOverlay(db);
    return false;
  }
}
