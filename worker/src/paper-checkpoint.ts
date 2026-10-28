import { tablePresent, type Db } from "./db";
import { perpMarketById } from "../../packages/core/src/index";
import { applyLedgerMigrations } from "./ledger-migrations";
import { textInt } from "./perp-ledger-rules";

export const PAPER_CHECKPOINT_SCHEMA = `CREATE TABLE IF NOT EXISTS paper_checkpoints (
  agent_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, cash_usdg REAL NOT NULL,
  vault_usdg REAL NOT NULL, hwm_usdg REAL NOT NULL, shares TEXT NOT NULL,
  basis_json TEXT NOT NULL, updated_at INTEGER NOT NULL
);`;

/**
 * THE PAPER PERP BOOK RIDES THE CHECKPOINT (docs/perps.md, "Hosted"; rule 14).
 *
 * A paper venue has no source but this. There is no Lighter account behind a
 * simulated position to re-read at arm, and the paper engine draws a
 * position's margin straight out of paper cash (store.ts bookPaperPerp), so a
 * redeploy that restored the cash and not the perps would put the agent back
 * with the margin already gone and no position holding it — paper equity
 * falling by the whole perp book, read by every surface as a loss.
 *
 * NULLABLE, like every column added to a table rows already live in: NULL is a
 * checkpoint with no perp book (every one written before this, and every
 * agent that never traded paper perps — every Spot agent), which restores
 * exactly as before.
 */
export const PAPER_CHECKPOINT_ALTERS: readonly string[] = ["ALTER TABLE paper_checkpoints ADD COLUMN perp_json TEXT"];

/** The databases whose checkpoint migration this process has run, or is running. */
const altered = new WeakMap<Db, Promise<void>>();
/** When each database's migration last failed: not tried again for PERP_JSON_RETRY_MS. */
const alterFailedAt = new WeakMap<Db, number>();
/** And why: the last failure's SQLSTATE (failureCode), for the error a paper perp book's checkpoint carries. */
const alterFailedCode = new WeakMap<Db, string>();
/** How long a failed perp_json migration waits before it is tried again — a mirror pass's length, about. */
const PERP_JSON_RETRY_MS = 60_000;

/**
 * Create the checkpoint table and bring it up to date.
 *
 * THE MIGRATION RUNS THROUGH applyLedgerMigrations, ONCE PER DATABASE PER
 * PROCESS, never as a bare ALTER per call. This is called on every mirror pass
 * for every tenant, and a Postgres ADD COLUMN — IF NOT EXISTS included — takes
 * an AccessExclusiveLock on a table every tenant upserts every fifteen
 * seconds: issued per call, every checkpoint write and restore would queue
 * behind it. The runner asks the catalogue first and skips a column already
 * there, and the one ADD it does make waits a bounded time for its lock
 * (ledger-migrations.ts ADD_COLUMN_LOCK). Concurrent passes share the one
 * attempt. The CREATE stays per call, as it always was.
 *
 * A FAILED ONE HOLDS A SPOT BOOK ONCE A WINDOW AT MOST. Only a book with a
 * paper perp book needs `perp_json`; every other checkpoint writes and
 * restores exactly as it did before the column existed. So a migration that
 * failed — most likely its lock held by another session, but whatever the
 * cause, named by its SQLSTATE in the log — answers false, and is not tried
 * again for PERP_JSON_RETRY_MS: not by the next tenant in the same pass, each
 * of which would otherwise wait the full bounded lock wait behind the same
 * holder. The one attempt in each window still waits that bounded wait (about
 * 14 s on Postgres), and so does a checkpoint running beside it. The callers
 * decide: the mirror writes a book without perps the old way and fails only a
 * book that has some, naming the same code; the restore reads either shape.
 * True once the column is there.
 */
export async function ensurePaperCheckpointSchema(db: Db): Promise<boolean> {
  await db.exec(PAPER_CHECKPOINT_SCHEMA);
  let done = altered.get(db);
  if (!done) {
    const failedAt = alterFailedAt.get(db);
    if (failedAt !== undefined && Date.now() - failedAt < PERP_JSON_RETRY_MS) return false;
    done = applyLedgerMigrations(db, PAPER_CHECKPOINT_ALTERS).catch((e: unknown) => {
      altered.delete(db);
      alterFailedAt.set(db, Date.now());
      alterFailedCode.set(db, failureCode(e));
      throw e;
    });
    altered.set(db, done);
  }
  try {
    await done;
    alterFailedAt.delete(db);
    return true;
  } catch (e) {
    const code = failureCode(e);
    // A lock wait passes by itself; anything else (a missing privilege, say)
    // will not, and a Perps book stays uncheckpointed until someone looks.
    console.warn(code === LOCK_NOT_AVAILABLE
      ? `[paper] paper_checkpoints.perp_json could not be added yet (${code}, its lock held elsewhere) — books without perps are checkpointed as before; tried again in ${PERP_JSON_RETRY_MS / 1000}s`
      : `[alert] paper_checkpoints.perp_json could not be added (${code}) — not a lock wait; books without perps are checkpointed as before, paper perp books are not; tried again in ${PERP_JSON_RETRY_MS / 1000}s`);
    return false;
  }
}

const LOCK_NOT_AVAILABLE = "55P03";

/** A failure's SQLSTATE, which never quotes table contents, or its class name. */
function failureCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : e instanceof Error ? e.name : "Error";
}

/** One paper perp position as a checkpoint carries it. Integers are canonical decimal strings. */
export interface PaperPerpPosition {
  market_id: number;
  side: "long" | "short";
  /** venue base units, > 0 */
  base: string;
  /** venue price units, > 0 */
  entry_price: string;
  /** micro-USDG, ≥ 0 — debited from paper cash when the position opened */
  allocated_margin_micro: string;
  imf_bp: number;
  margin_mode: "isolated" | "cross";
  realized_micro: string | null;
  funding_micro: string | null;
  /**
   * The last funding hour charged, unix seconds. MANDATORY: the paper engine
   * refuses to charge an hour at or before it (paper.ts applyPaperFunding),
   * and that is all that stops a restored position paying the same hour twice.
   * Every position the engine opens carries one (the hour it opened in).
   */
  funding_hour_applied: number;
  /** The resting stop child, both or neither. */
  stop_trigger: string | null;
  stop_price: string | null;
  /**
   * THE LEVEL THE POSITION IS PROTECTED AT (store.ts perp_positions
   * recorded_stop_*; paper.ts PaperPerpPosition.recordedStop), both or
   * neither. A gapped or part-filled stop leaves the child gone and this
   * standing; restored without it, the protective loop would re-place the
   * stop at the settings ceiling rather than the position's own level.
   */
  recorded_stop_trigger: string | null;
  recorded_stop_price: string | null;
  /** The resting take-profit child, both or neither. */
  take_trigger: string | null;
  take_price: string | null;
  opened_at: number | null;
}

/** The paper perp book: the cross collateral and every open position, from ONE read. */
export interface PaperPerpState {
  v: 1;
  collateral_micro: string;
  positions: PaperPerpPosition[];
  /**
   * The paper rail's nonce high-water as the book last stood (optional; absent
   * is none). Every paper identity is derived from it — a fill's
   * `paper:<kind>:<market>:<nonce>`, a leg's nonce × 8 + leg — and the next
   * nonce is max(high-water + 1, now in ms) (perps/executor.ts). A restored
   * child on a clock behind the old one would otherwise mint an identity the
   * shared tape already holds, and the mirror's ON CONFLICT DO NOTHING would
   * drop the real fill.
   */
  nonce_high_water?: string | null;
  /**
   * The newest perp fill or funding row of this epoch the book had booked, by
   * its created_at (optional; absent is none). The checkpoint's own
   * `updated_at` is paper_book's, which a funding hour never moves (funding
   * moves a position's margin, not cash) and a liquidation that returns
   * nothing does not move either — so it alone could not say which of the
   * shared tape's facts this book already holds.
   */
  tape_at?: number | null;
}

const CANON_INT = /^-?(0|[1-9]\d*)$/;

/**
 * WHY A PAPER PERP BOOK IS REFUSED, or null. Everything a restore would write
 * back into a book is checked here first: money and margins non-negative
 * integers, every market one this build knows (a restored position in a
 * market the engine cannot price is a position nobody can close), no market
 * twice, the IMF inside the venue's own range, the funding hour present, and
 * every trigger with its bound — stop, take and recorded stop each both or
 * neither, because the paper engine refuses to read a position with half a
 * pair (perps/executor.ts positionOf) and would throw on every tick.
 */
export function paperPerpRejection(perpJson: string | null | undefined): string | null {
  if (perpJson === null || perpJson === undefined) return null;
  let s: PaperPerpState;
  try {
    s = JSON.parse(perpJson) as PaperPerpState;
  } catch (e) {
    return `perp_json is unreadable (${e instanceof Error ? e.message : String(e)})`;
  }
  if (!s || typeof s !== "object" || Array.isArray(s)) return "perp_json is not an object";
  if (s.v !== 1) return `perp_json version ${String(s.v)} is not one this build reads`;
  const nonNeg = (v: unknown) => typeof v === "string" && CANON_INT.test(v) && BigInt(v) >= 0n;
  const optNonNeg = (v: unknown) => v === null || nonNeg(v);
  const optCount = (v: unknown) => v === null || v === undefined || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
  if (!nonNeg(s.collateral_micro)) return `paper perp collateral is ${String(s.collateral_micro)}, not a non-negative integer`;
  if (s.nonce_high_water !== undefined && !optNonNeg(s.nonce_high_water)) return `paper perp nonce high-water is ${String(s.nonce_high_water)}`;
  if (!optCount(s.tape_at)) return `paper perp tape time is ${String(s.tape_at)}`;
  if (!Array.isArray(s.positions)) return "paper perp positions is not a list";
  const seen = new Set<number>();
  for (const p of s.positions) {
    if (!p || typeof p !== "object") return "a paper perp position is not an object";
    const id = p.market_id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || perpMarketById(id) === null) {
      return `paper perp market ${String(id)} is not a market this build knows`;
    }
    if (seen.has(id)) return `paper perp market ${id} is held twice`;
    seen.add(id);
    const key = perpMarketById(id)!.key;
    if (p.side !== "long" && p.side !== "short") return `${key} side is ${String(p.side)}`;
    if (!nonNeg(p.base) || BigInt(p.base) === 0n) return `${key} holds ${String(p.base)} base`;
    if (!nonNeg(p.entry_price) || BigInt(p.entry_price) === 0n) return `${key} entry price is ${String(p.entry_price)}`;
    if (!nonNeg(p.allocated_margin_micro)) return `${key} margin is ${String(p.allocated_margin_micro)}, not a non-negative integer`;
    if (typeof p.imf_bp !== "number" || !Number.isSafeInteger(p.imf_bp) || p.imf_bp < 1 || p.imf_bp > 10_000) {
      return `${key} imf is ${String(p.imf_bp)}`;
    }
    if (p.margin_mode !== "isolated" && p.margin_mode !== "cross") return `${key} margin mode is ${String(p.margin_mode)}`;
    for (const [name, v] of [["realized", p.realized_micro], ["funding", p.funding_micro]] as const) {
      if (v !== null && (typeof v !== "string" || !CANON_INT.test(v))) return `${key} ${name} is ${String(v)}`;
    }
    if (typeof p.funding_hour_applied !== "number" || !Number.isSafeInteger(p.funding_hour_applied) || p.funding_hour_applied < 0) {
      return `${key} funding hour is ${String(p.funding_hour_applied)}: a restored position without it would pay an hour it already paid`;
    }
    for (const [name, trigger, bound] of [
      ["stop", p.stop_trigger, p.stop_price],
      ["recorded stop", p.recorded_stop_trigger, p.recorded_stop_price],
      ["take", p.take_trigger, p.take_price],
    ] as const) {
      // `undefined` is a key the book never wrote: not a null, refused like any other unreadable value.
      if (!optNonNeg(trigger) || !optNonNeg(bound)) return `${key} ${name} is ${String(trigger)} / ${String(bound)}`;
      if ((trigger === null) !== (bound === null)) return `${key} ${name} has half a pair (trigger ${String(trigger)}, bound ${String(bound)})`;
    }
    if (p.opened_at !== null && (typeof p.opened_at !== "number" || !Number.isSafeInteger(p.opened_at) || p.opened_at < 0)) {
      return `${key} opened at is ${String(p.opened_at)}`;
    }
  }
  return null;
}

/** Is there a table by that name in this child's sqlite? A child from before perps has none of them. */
async function childHasTable(db: Db, name: string): Promise<boolean> {
  return (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)) !== undefined;
}

/**
 * THE PAPER PERP BOOK OF ONE AGENT, read on the caller's handle — which is the
 * paper_book snapshot's transaction, so the collateral, the positions, the
 * high-water and the cash beside them are one instant (a book read between a
 * fill's cash write and its position write would restore money that is in
 * two places, or none). Null when the agent has no paper perp book at all —
 * every Spot agent, whose perp tables are there and empty.
 *
 * A collateral that was never set is '0' only when nothing is open: margin
 * against positions with no collateral row is not a book, and is carried as
 * such (null) for the check to refuse.
 */
export async function readPaperPerpState(db: Db, account: string, epoch: number): Promise<string | null> {
  if (!(await childHasTable(db, "perp_accounts")) || !(await childHasTable(db, "perp_positions"))) return null;
  const acct = (await db
    .prepare(`SELECT paper_collateral_micro, nonce_high_water FROM perp_accounts WHERE LOWER(agent_id)=LOWER(?) AND mode='paper'`)
    .get(account)) as { paper_collateral_micro: string | null; nonce_high_water: string | null } | undefined;
  // SELECT *: a book an earlier build made may lack the recorded-stop columns,
  // and a column that is not there is a level that was never recorded.
  const rows = (await db
    .prepare(`SELECT * FROM perp_positions WHERE LOWER(agent_id)=LOWER(?) AND mode='paper' AND base <> '0' ORDER BY market_id ASC`)
    .all(account)) as Record<string, unknown>[];
  if (!acct && rows.length === 0) return null;
  const collateral = acct?.paper_collateral_micro ?? (rows.length === 0 ? "0" : null);
  let tapeAt: number | null = null;
  for (const table of ["perp_fills", "perp_funding"] as const) {
    if (!(await childHasTable(db, table))) continue;
    const r = (await db
      .prepare(`SELECT MAX(created_at) AS at FROM ${table} WHERE LOWER(agent_id)=LOWER(?) AND mode='paper' AND epoch=?`)
      .get(account, epoch)) as { at: unknown } | undefined;
    if (r?.at !== null && r?.at !== undefined) tapeAt = Math.max(tapeAt ?? 0, Number(r.at));
  }
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const state = {
    v: 1,
    collateral_micro: collateral,
    nonce_high_water: str(acct?.nonce_high_water),
    tape_at: tapeAt,
    positions: rows.map((r) => ({
      market_id: Number(r.market_id),
      side: r.side,
      base: str(r.base),
      entry_price: str(r.entry_price),
      allocated_margin_micro: str(r.allocated_margin_micro),
      imf_bp: num(r.imf_bp),
      margin_mode: r.margin_mode,
      realized_micro: str(r.realized_micro),
      funding_micro: str(r.funding_micro),
      funding_hour_applied: num(r.funding_hour_applied),
      stop_trigger: str(r.stop_trigger),
      stop_price: str(r.stop_price),
      recorded_stop_trigger: str(r.recorded_stop_trigger),
      recorded_stop_price: str(r.recorded_stop_price),
      take_trigger: str(r.take_trigger),
      take_price: str(r.take_price),
      opened_at: num(r.opened_at),
    })),
  };
  return JSON.stringify(state);
}

/**
 * Write a validated paper perp book into a child's ledger, inside the
 * restore's transaction.
 *
 * Its rows are stamped NOW (unixepoch), not with the checkpoint's time: the
 * restored book IS the rail's newest word, and the mirror's newer-wins copy
 * and its flatten-on-evidence both read the stamp — so a stale shared
 * position the restored book does not hold goes flat on the next pass, and
 * the restored rows replace the shared ones rather than losing to them.
 *
 * THE HIGH-WATER ONLY RISES: the larger of the checkpoint's and whatever this
 * ledger already holds. One already there that cannot be read refuses the
 * restore — guessing it low is exactly how an identity gets minted twice.
 */
async function writePaperPerpState(db: Db, account: string, perpJson: string): Promise<void> {
  const s = JSON.parse(perpJson) as PaperPerpState;
  const agent = account.toLowerCase();
  const held = (await db.prepare(`SELECT nonce_high_water FROM perp_accounts WHERE agent_id = ? AND mode = 'paper'`).get(agent)) as
    | { nonce_high_water: string | null }
    | undefined;
  const heldHigh = held?.nonce_high_water === null || held?.nonce_high_water === undefined ? null : textInt(held.nonce_high_water);
  if (held?.nonce_high_water != null && heldHigh === null) throw new Error(`the paper nonce high-water ${held.nonce_high_water} is unreadable`);
  const carried = s.nonce_high_water === null || s.nonce_high_water === undefined ? null : textInt(s.nonce_high_water);
  const high = carried === null ? heldHigh : heldHigh === null || carried > heldHigh ? carried : heldHigh;
  await db
    .prepare(
      `INSERT INTO perp_accounts (agent_id, mode, paper_collateral_micro, nonce_high_water) VALUES (?, 'paper', ?, ?)
       ON CONFLICT(agent_id, mode) DO UPDATE SET paper_collateral_micro = excluded.paper_collateral_micro,
         nonce_high_water = excluded.nonce_high_water, updated_at = unixepoch()`,
    )
    .run(agent, s.collateral_micro, high === null ? null : high.toString());
  await db.prepare(`DELETE FROM perp_positions WHERE agent_id = ? AND mode = 'paper'`).run(agent);
  for (const p of s.positions) {
    await db
      .prepare(
        `INSERT INTO perp_positions (agent_id, mode, market_id, side, base, entry_price, allocated_margin_micro, imf_bp,
                                     margin_mode, realized_micro, funding_micro, stop_trigger, stop_price,
                                     recorded_stop_trigger, recorded_stop_price, take_trigger, take_price,
                                     funding_hour_applied, opened_at, updated_at, source)
         VALUES (?, 'paper', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), 'paper')`,
      )
      .run(agent, p.market_id, p.side, p.base, p.entry_price, p.allocated_margin_micro, p.imf_bp, p.margin_mode,
        p.realized_micro, p.funding_micro, p.stop_trigger, p.stop_price, p.recorded_stop_trigger, p.recorded_stop_price,
        p.take_trigger, p.take_price, p.funding_hour_applied, p.opened_at);
  }
}

/**
 * The paper perp facts of one epoch the SHARED tape holds past `at` — fills
 * and funding, the two that move a paper book's money — by created_at, the
 * child's own stamp the mirror copies as written. `strict`: past it
 * (`>`), the checkpoint path, whose book holds everything up to and including
 * its own time; otherwise at or past it (`>=`), the upgrade path, whose mark
 * holds nothing booked in its own second. A shared database without the perp
 * tables yet holds no such row, and its absence is asked of the catalogue,
 * never learned from a failed read. Every perp writer, and the mirror, store
 * the account lowercased, so the account is matched as it is stored.
 */
async function laterPaperPerpFacts(db: Db, account: string, epoch: number, at: number, strict: boolean): Promise<number> {
  let n = 0;
  for (const table of ["perp_fills", "perp_funding"] as const) {
    if (!(await tablePresent(db, table))) continue;
    const r = (await db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE agent_id = ? AND mode = 'paper' AND epoch = ? AND created_at ${strict ? ">" : ">="} ?`)
      .get(account.toLowerCase(), epoch, at)) as { n: unknown } | undefined;
    n += Number(r?.n ?? 0);
  }
  return n;
}

export async function recordPaperRecoveryHealth(db:Db,account:string,blocked:boolean):Promise<void> {
  await db.exec(`CREATE TABLE IF NOT EXISTS paper_recovery_health (
    agent_id TEXT PRIMARY KEY, blocked INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  await db.prepare(`INSERT INTO paper_recovery_health(agent_id,blocked,updated_at) VALUES(?,?,?)
    ON CONFLICT(agent_id) DO UPDATE SET blocked=excluded.blocked,updated_at=excluded.updated_at`)
    .run(account.toLowerCase(),blocked?1:0,Math.floor(Date.now()/1000));
}

/** `perp_json` is optional in the type because every checkpoint from before perps lacks it; absent and NULL read alike. */
type Checkpoint = {agent_id:string; epoch:number; cash_usdg:number; vault_usdg:number; hwm_usdg:number; shares:string; basis_json:string; updated_at:number; perp_json?: string | null};
type Basis = {symbol:string; qty_raw:string; cost_usdg:string};

/**
 * How far the terms of ONE equity row may disagree with their own total.
 *
 * These are REAL columns summed in floating point, so the slack is for binary
 * representation and nothing else. It is deliberately NOT a business tolerance:
 * every term comes from the same row written in the same instant, so anything
 * a float cannot explain is a row that was never coherent.
 */
const MARK_TOLERANCE_USDG = 0.00001;

/**
 * BASIS_UNITS — WHAT A PAPER BASIS QUANTITY IS COUNTED IN, AND WHY IT IS TWO THINGS.
 *
 * Since d2c652db (2026-09-19) a paper fill books its basis in the SAME
 * split-invariant units as the book: index.ts passes `qtyRaw: rawShares * 1e18`,
 * and rawShares is exactly what the book stores. Before it, the basis took the
 * TRADEABLE quantity at the multiplier of the day. A position bought across the
 * change holds some of each, so a sound checkpoint's basis lies between
 * `shares` and `shares × multiplier`.
 *
 * The comment below (from 912502b5) read the old half as the whole rule and
 * compared every basis with `shares × multiplier`. That passed the pre-change
 * rows and refused every book today's engine writes, as soon as a multiplier
 * left 1.0 — and a refused checkpoint is an agent the orchestrator never
 * starts. Production, 2026-09-24: ten paper agents refused on every ferry
 * pass since the deploy that shipped it, one of them the only agent there with
 * a Telegram bot, which went silent while the dashboard said connected.
 */

/**
 * THE MULTIPLIER DRIFT A LEGACY BASIS MAY CARRY — dividend-scale, never a split.
 *
 * A basis in the old tradeable units differs from its shares by at most the
 * multiplier, which for every stock token today is within 0.08% of 1.0. A
 * range that wide cannot hide a torn write of any real size. At a split the
 * multiplier is ~2 and the same range would admit a sell that updated the book
 * but crashed before its basis (Kaka's review of #164: book 0.6, stale basis
 * 1.0, inside [0.6, 1.2]) — so past this bound the check is exact, and a
 * legacy basis there is refused as it was before.
 */
export const LEGACY_DRIFT = 0.01;

/**
 * HOW A BASIS QUANTITY RELATES TO THE BOOK'S SHARES: "current" (today's units,
 * equal within the engine's rounding), "legacy" (the old tradeable units at a
 * drift-scale multiplier, or a mix of both), or null (neither — refuse it).
 */
export function basisUnits(qty: number, shares: number, mul: number): "current" | "legacy" | null {
  if (Math.abs(qty - shares) <= 1e-6) return "current";
  if (Math.abs(mul - 1) > LEGACY_DRIFT) return null;
  const lo = shares * Math.min(1, mul), hi = shares * Math.max(1, mul);
  return qty >= lo - 1e-6 && qty <= hi + 1e-6 ? "legacy" : null;
}

/**
 * EVERY LEGACY BASIS REWRITTEN IN TODAY'S UNITS — qty := shares, cost kept.
 *
 * Admitting a mixed basis is not enough on its own (Kaka's review of #164): a
 * sell takes split-invariant quantity off a basis whose older part is
 * tradeable, so a legacy position that is later sold down drifts past
 * shares × multiplier and would be refused on the NEXT restart. So a legacy
 * basis is admitted only to be normalised: after this, basis == shares, and
 * every later fill and sell keeps it so. The cost is untouched; the average
 * cost per share moves by the multiplier's drift (≤ 0.08% today), which is the
 * units correction and nothing else. A basis the check refuses is not touched.
 */
export function normalizedBasis(
  sharesJson: string,
  basisJson: string,
  multiplierOf: MultiplierOf,
): { basis: Basis[]; normalized: string[] } {
  const shares = JSON.parse(sharesJson) as Record<string, { shares: number }>;
  const basis = JSON.parse(basisJson) as Basis[];
  const normalized: string[] = [];
  const out = basis.map((b) => {
    const held = shares[b.symbol];
    if (!held) return b;
    if (basisUnits(Number(b.qty_raw) / 1e18, held.shares, multiplierOf(b.symbol)) !== "legacy") return b;
    normalized.push(b.symbol);
    // The expression index.ts books a paper fill with: the stored shares, in 18dp.
    return { ...b, qty_raw: String(BigInt(Math.round(held.shares * 1e18))) };
  });
  return { basis: out, normalized };
}

const saidNormalized = (symbols: string[]) =>
  symbols.length ? ` (basis for ${symbols.join(", ")} moved to split-invariant units)` : "";

/**
 * WHAT ONE SPLIT-INVARIANT SHARE IS WORTH IN TRADEABLE UNITS, PER SYMBOL.
 *
 * The two numbers a checkpoint carries are in DIFFERENT UNITS and nothing said
 * so. `paper_book.shares` is split-invariant — shares at multiplier 1.0, which
 * paper.ts holds deliberately so that a corporate action does not read as a 50%
 * loss and retire an agent over a stock split. `cost_basis.qty_raw` is a raw
 * balance, which is tradeable units. They are equal only while the multiplier
 * is exactly 1.0, and paper.ts said as much in writing:
 *
 *   "Every token in the registry currently sits at exactly 1.0, which is why
 *    existing books carry over unchanged — the two readings only diverge after
 *    the first real split."
 *
 * Production has now outgrown that sentence. Measured 2026-09-22, across seven
 * blocked agents: NVDA 1.000775 on five of them, AAPL 1.000566, and one holding
 * at 2.001550 — which is exactly twice NVDA's, a 2:1 split on top. Every ratio
 * constant per symbol across different agents and different sizes, which is
 * what a multiplier looks like and what a fee does not.
 *
 * ABSENT MEANS 1.0, and that is what makes this safe to roll out. A checkpoint
 * written before this existed carries no multiplier, and every token that never
 * split still sits at exactly 1.0, so the old comparison and the new one agree
 * everywhere except on the rows that were already failing.
 */
export type MultiplierOf = (symbol: string) => number;

const ONE: MultiplierOf = () => 1;

/** `ui_multiplier` is an 18-decimal fixed-point integer. Unreadable means 1.0. */
export function multipliersFrom(rows: readonly Record<string, unknown>[]): MultiplierOf {
  const bySymbol = new Map<string, number>();
  for (const r of rows) {
    const raw = Number(r.ui_multiplier);
    // A zero or unreadable multiplier is NOT a zero holding — it is a column we
    // could not use, and the only safe reading of it is the identity.
    if (Number.isFinite(raw) && raw > 0) bySymbol.set(String(r.symbol), raw / 1e18);
  }
  return (symbol) => bySymbol.get(symbol) ?? 1;
}

/**
 * WHY A CHECKPOINT WAS REJECTED, or null when it was not.
 *
 * This used to be a bare boolean, and the boolean is why eight agents sat dead
 * without anybody being able to say which clause was firing. A rejection here
 * is not a detail: `mirrorPaperCheckpoints` silently skips the row, so the
 * durable path never gets a checkpoint, every later restore falls through to
 * the fragile upgrade path, and the only trace in the log is the word
 * "invalid". A validator that cannot say what it disliked turns a one-line fix
 * into an investigation.
 *
 * The RULES ARE UNCHANGED — every clause accepts and rejects exactly what it
 * did before. Only the answer got wider. The one clause added since is the
 * paper perp book's (paperPerpRejection), which a checkpoint without one —
 * every Spot agent's — passes as it always did.
 */
export function paperCheckpointRejection(row: Checkpoint, multiplierOf: MultiplierOf = ONE): string | null {
  try {
    for (const [name,v] of [["cash",row.cash_usdg],["vault",row.vault_usdg],["hwm",row.hwm_usdg]] as const) {
      if (!Number.isFinite(Number(v)) || Number(v)<0) return `${name} is ${String(v)}, not a non-negative number`;
    }
    const shares = JSON.parse(row.shares) as Record<string,{token:string;shares:number}>;
    const basis = JSON.parse(row.basis_json) as Basis[];
    if (!shares || Array.isArray(shares)) return 'shares is not an object';
    if (!Array.isArray(basis)) return 'basis_json is not an array';
    for (const [symbol,p] of Object.entries(shares)) {
      if (!/^0x[0-9a-f]{40}$/i.test(p.token)) return `${symbol} has no usable token address`;
      if (!Number.isFinite(p.shares) || p.shares<=0) return `${symbol} holds ${String(p.shares)} shares`;
      const b = basis.find(b=>b.symbol===symbol);
      // A snapshot between cash/book and basis writes must not become a restore point.
      if (!b) return `${symbol} is held with no paper cost basis`;
      if (BigInt(b.cost_usdg)<0n) return `${symbol} has a negative cost basis`;
      // IN THE UNITS THE ENGINE WROTE — see BASIS_UNITS. Today's fills book the
      // split-invariant quantity, so basis == shares; the 1e-6 is the engine's
      // own rounding (a sell rounds the book's shares to 6dp, the basis stays
      // exact). A basis from before 2026-09-19 may also sit anywhere up to
      // shares × multiplier — see legacyBasis for when that is admitted and
      // why it is admitted only to be normalised away.
      if (basisUnits(Number(b.qty_raw)/1e18, p.shares, multiplierOf(symbol)) === null) {
        return `${symbol} basis ${b.qty_raw} raw disagrees with ${p.shares} shares at multiplier ${multiplierOf(symbol)}`;
      }
    }
    for (const b of basis) {
      if (BigInt(b.qty_raw)<0n || BigInt(b.cost_usdg)<0n) return `${b.symbol} basis is negative`;
      if (!shares[b.symbol] && BigInt(b.qty_raw)!==0n) return `${b.symbol} has basis for ${b.qty_raw} raw but is not held`;
    }
    // THE PAPER PERP BOOK, by the same standard: a restore point it cannot
    // write back whole is not a restore point. NULL is no perp book.
    return paperPerpRejection(row.perp_json);
  } catch (e) { return `unreadable (${e instanceof Error ? e.message : String(e)})`; }
}

export function validPaperCheckpoint(row: Checkpoint, multiplierOf: MultiplierOf = ONE): boolean {
  return paperCheckpointRejection(row, multiplierOf) === null;
}

/**
 * The multipliers for one agent's holdings, from whichever book is to hand.
 *
 * Best-effort: a table that will not answer gives the identity, which is what
 * every unsplit token is anyway. Recovery must not be blocked by the lookup
 * that exists to unblock it.
 */
async function multipliersFor(db: Db, account: string): Promise<MultiplierOf> {
  try {
    return multipliersFrom(await db.prepare(
      `SELECT symbol, ui_multiplier FROM positions WHERE LOWER(agent_id)=LOWER(?)`,
    ).all(account) as Record<string, unknown>[]);
  } catch { return ONE; }
}

export async function mirrorPaperCheckpoints(child:Db, shared:Db): Promise<number> {
  if (!await child.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='paper_book'").get()) return 0;
  const withPerps = await ensurePaperCheckpointSchema(shared);
  const snapshots = await child.tx(async db => {
    const books = await db.prepare(`SELECT p.*, a.epoch FROM paper_book p JOIN agents a ON LOWER(a.smart_account)=LOWER(p.agent_id)`).all() as Checkpoint[];
    for (const book of books) {
      book.basis_json = JSON.stringify(await db.prepare(`SELECT symbol, qty_raw, cost_usdg FROM cost_basis WHERE agent_id=? AND mode='paper'`).all(book.agent_id));
      // IN THE SAME TRANSACTION as the cash and shares above, so the paper
      // perp book is the same instant as the spot book it sits beside.
      book.perp_json = await readPaperPerpState(db, book.agent_id, Number(book.epoch));
    }
    return books;
  });
  let count=0;
  for(const b of snapshots) {
    // FROM THE CHILD, which is the book these shares were written against.
    const multiplierOf = await multipliersFor(child, b.agent_id);
    const why = paperCheckpointRejection(b, multiplierOf);
    if (why) {
      // SAID OUT LOUD, because this skip is the start of the whole failure
      // chain. No checkpoint written here means every later restore falls to
      // the upgrade path, and until now the only evidence that this line had
      // run at all was a count that was one lower than expected.
      console.warn(`[paper] checkpoint not mirrored for ${b.agent_id}: ${why}`);
      continue;
    }
    // The durable row is written in today's units, so a restore from it never
    // carries a legacy basis back into a book (see normalizedBasis).
    b.basis_json = JSON.stringify(normalizedBasis(b.shares, b.basis_json, multiplierOf).basis);
    // WITHOUT THE COLUMN (its migration waiting on a lock): a book with no
    // perps is written exactly as before the column existed; one with perps
    // is not written at all this pass, and its tenant's mirror says so.
    if (!withPerps) {
      if (b.perp_json !== null && b.perp_json !== undefined)
        throw new Error(`paper_checkpoints.perp_json is not there yet (${alterFailedCode.get(shared) ?? "unknown"}); this paper perp book is checkpointed once it is`);
      await shared.prepare(`INSERT INTO paper_checkpoints(agent_id,epoch,cash_usdg,vault_usdg,hwm_usdg,shares,basis_json,updated_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET epoch=excluded.epoch,cash_usdg=excluded.cash_usdg,
        vault_usdg=excluded.vault_usdg,hwm_usdg=excluded.hwm_usdg,shares=excluded.shares,basis_json=excluded.basis_json,updated_at=excluded.updated_at
        WHERE excluded.epoch > paper_checkpoints.epoch OR (excluded.epoch=paper_checkpoints.epoch AND excluded.updated_at>=paper_checkpoints.updated_at)`)
        .run(b.agent_id,b.epoch,b.cash_usdg,b.vault_usdg,b.hwm_usdg,b.shares,b.basis_json,b.updated_at);
      count++;
      continue;
    }
    // perp_json travels with the rest of the row and is replaced with it —
    // including by NULL, because a newer book with no paper perp book is a
    // book whose perps are gone, and keeping the older ones would resurrect
    // them.
    await shared.prepare(`INSERT INTO paper_checkpoints(agent_id,epoch,cash_usdg,vault_usdg,hwm_usdg,shares,basis_json,updated_at,perp_json)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET epoch=excluded.epoch,cash_usdg=excluded.cash_usdg,
      vault_usdg=excluded.vault_usdg,hwm_usdg=excluded.hwm_usdg,shares=excluded.shares,basis_json=excluded.basis_json,updated_at=excluded.updated_at,
      perp_json=excluded.perp_json
      WHERE excluded.epoch > paper_checkpoints.epoch OR (excluded.epoch=paper_checkpoints.epoch AND excluded.updated_at>=paper_checkpoints.updated_at)`)
      .run(b.agent_id,b.epoch,b.cash_usdg,b.vault_usdg,b.hwm_usdg,b.shares,b.basis_json,b.updated_at,b.perp_json ?? null);
    count++;
  }
  return count;
}

/** Restore only an empty local book, including its matching basis. */
export async function restorePaperCheckpoint(child:Db, shared:Db, account:string):Promise<string> {
  const local = await child.prepare("SELECT agent_id, shares FROM paper_book WHERE LOWER(agent_id)=LOWER(?)").get(account) as {agent_id:string;shares:string} | undefined;
  if (local) {
    // A BOOK THAT SURVIVED THE RESTART IS KEPT — and its legacy basis, if any,
    // moved to today's units now, so the next sell cannot drift it past the
    // check (see normalizedBasis). Best-effort: a local book is never blocked.
    try {
      const rows = await child.prepare("SELECT symbol, qty_raw, cost_usdg FROM cost_basis WHERE agent_id=? AND mode='paper'").all(local.agent_id) as Basis[];
      const { basis, normalized } = normalizedBasis(local.shares, JSON.stringify(rows), await multipliersFor(shared, account));
      if (normalized.length) {
        await child.tx(async (db) => {
          for (const b of basis.filter((b) => normalized.includes(b.symbol))) {
            await db.prepare("UPDATE cost_basis SET qty_raw=? WHERE agent_id=? AND mode='paper' AND symbol=?").run(b.qty_raw, local.agent_id, b.symbol);
          }
        });
      }
      return `local book retained${saidNormalized(normalized)}`;
    } catch { return 'local book retained'; }
  }
  await ensurePaperCheckpointSchema(shared);
  let row = await shared.prepare(`SELECT p.* FROM paper_checkpoints p JOIN agents a ON LOWER(a.smart_account)=LOWER(p.agent_id)
    WHERE LOWER(p.agent_id)=LOWER(?) AND p.epoch=a.epoch`).get(account) as Checkpoint | undefined;
  /** Set when the upgrade path had to close paper perps into collateral; said in the result. */
  let foldedPerps = false;
  /**
   * THE INSTANT THE BOOK BEING RESTORED STANDS AT: the checkpoint's own time,
   * or the newest perp fact its perp book had booked, whichever is later (see
   * PaperPerpState.tape_at for why the first alone is not enough).
   */
  let bookAt = 0;
  if (row) {
    // A CHECKPOINT OLDER THAN THE SHARED PERP TAPE IS NOT A RESTORE POINT.
    // Within one mirror pass the perp tape is copied BEFORE the snapshot
    // block that writes this row, so a pass whose snapshot failed after its
    // perp copy, and then a lost home, leaves a checkpoint from before a fill
    // the shared tape already holds — a close, say. Restored, the book would
    // reopen a position the tape shows closed, and the second close a
    // restored child then books is a second closing fill under a new id:
    // shared realized P&L counting the close twice. A Spot agent's tape is
    // empty and passes as before. (Same-second facts stay indistinguishable
    // by stamps alone; the identities they carry are the backstop.)
    let tapeAt = 0;
    try {
      const s = row.perp_json ? (JSON.parse(row.perp_json) as PaperPerpState) : null;
      if (typeof s?.tape_at === "number" && Number.isSafeInteger(s.tape_at)) tapeAt = s.tape_at;
    } catch { /* unreadable: paperCheckpointRejection, below, refuses the row */ }
    bookAt = Math.max(Number(row.updated_at), tapeAt);
    if ((await laterPaperPerpFacts(shared, account, Number(row.epoch), bookAt, true)) > 0) {
      throw new Error("paper perp fills or funding are newer than the durable checkpoint");
    }
  }
  /**
   * READ ONCE, FOR BOTH PATHS, AND FROM THE SHARED BOOK ON PURPOSE.
   *
   * A checkpoint written before multipliers were understood carries none, and
   * the agents that need this most are precisely the ones that are NOT running
   * — their child was never spawned, so nothing has re-mirrored their book and
   * their stale row would go on failing for ever. The shared `positions` table
   * is mirrored and current, so resolving the multiplier HERE fixes the legacy
   * rows as well as the new ones, which a checkpoint-side field could not.
   */
  const multiplierOf = await multipliersFor(shared, account);
  if (!row) {
    // Upgrade path: recover a fully reconciled recorded valuation. Never take
    // today's on-chain cash or a configured seed as the old paper bankroll.
    const mark = await shared.prepare(`SELECT e.* FROM equity e JOIN agents a ON LOWER(a.smart_account)=LOWER(e.agent_id) AND a.epoch=e.epoch
      WHERE LOWER(e.agent_id)=LOWER(?) ORDER BY e.at DESC,e.id DESC LIMIT 1`).get(account) as Record<string,unknown> | undefined;
    if (!mark || mark.mode !== 'paper') return 'no durable checkpoint';
    const later = await shared.prepare(`SELECT COUNT(*) AS n FROM trades WHERE LOWER(agent_id)=LOWER(?) AND epoch=? AND status='paper' AND created_at>=?`)
      .get(account,Number(mark.epoch),Number(mark.at)) as {n:number};
    if (Number(later.n)>0) throw new Error('paper fills are newer than the recoverable valuation');
    // AND THE PAPER PERP BOOK'S OWN FACTS, which are never trades rows (the
    // trades boundary, store.ts PERP_LEDGER_DDL): a paper perp fill or funding
    // charge at or after the mark moved money the mark does not hold, exactly
    // as a spot fill would. A shared database with no perp tables yet holds
    // no such rows.
    if ((await laterPaperPerpFacts(shared, account, Number(mark.epoch), Number(mark.at), false)) > 0) {
      throw new Error('paper perp fills or funding are newer than the recoverable valuation');
    }
    /**
     * ── THE CHECK THAT USED TO BE HERE, AND WHY IT COULD NEVER PASS ──────
     *
     * It asserted `value === mark.positions_usdg` to within 0.00001 USDG,
     * where `value` is summed from the `positions` table and
     * `mark.positions_usdg` comes from an `equity` row. Those are the same
     * quantity read at DIFFERENT INSTANTS: `setPositions` REPLACES the
     * positions table every tick, while the equity row is written only
     * `if (!bookIncomplete)` — so a single unpriceable holding, or simply a
     * price that moved, desynchronises them for good.
     *
     * A hundredth of a cent is a tolerance only a same-instant comparison
     * could meet, so the assertion was a mark-to-market test dressed as a
     * consistency test, and it failed by design. Production, 2026-09-22:
     * eight agents, twenty-four consecutive failures, zero successes, with
     * deltas from 0.0066 to 948.40 USDG. Because the caller treats a failed
     * restore as "do not start this agent", every one of them was dead.
     *
     * ── WHAT ACTUALLY GUARANTEES COHERENCE, AND IT IS ALREADY ABOVE ──────
     *
     * `later.n` proves NO PAPER FILL LANDED AFTER THE MARK. That is the real
     * invariant: with no fills, the QUANTITIES cannot have changed, so the
     * mark's cash and vault are still exactly right and the holdings in
     * `positions` are still exactly the holdings the mark was taken over.
     * Only the prices moved — which is not a discrepancy, it is a market.
     *
     * So the value equality is gone and two checks stand in its place, both
     * of which test one instant against itself rather than against another:
     *
     *   the MARK is internally consistent — cash + vault + positions = equity,
     *   every term from the same row. Production passes this every time, and
     *   the old error proved it: `snapshotDelta` and `equityDelta` were equal
     *   in all six numeric failures, which reduces algebraically to exactly
     *   this identity holding.
     *
     *   the VALUE is readable at all. A NaN would otherwise become an equity.
     */
    const positions = await shared.prepare(`SELECT symbol,token,raw_balance,value_usdg FROM positions WHERE LOWER(agent_id)=LOWER(?)`).all(account) as Record<string,unknown>[];
    const value = positions.reduce((sum,p)=>sum+Number(p.value_usdg),0);
    if (!Number.isFinite(value)) throw new Error(`paper positions do not value (positions=${positions.length})`);
    /**
     * THE PERP TERM OF THE SAME ROW (rule 12): C + ΣM + ΣU + T, written beside
     * the total by addEquity and mirrored with it (ledger-mirror.ts, the
     * equity entry's `optional`). NULL is a mark that carried no perp term —
     * every row from before perps, and every Spot agent's — and contributes
     * nothing, so for them this identity is exactly the one it always was. An
     * unreadable value is a row that cannot be checked, and refuses. Without
     * this the identity would refuse every paper agent whose last mark held a
     * perp book: the agent-held-on-every-pass failure this path exists to end.
     */
    const perpTerm = (col: string): bigint => {
      const v = mark[col];
      if (v === null || v === undefined) return 0n;
      const b = textInt(v);
      if (b === null) throw new Error(`the recoverable valuation's ${col} (${String(v)}) is unreadable`);
      return b;
    };
    const perpMicro =
      perpTerm('perp_collateral_micro') + perpTerm('perp_isolated_margin_micro') + perpTerm('perp_unrealized_micro') + perpTerm('perp_in_transit_micro');
    const gainMicro = perpTerm('perp_unrealized_gain_micro');
    const markDelta = Number(mark.cash_usdg)+Number(mark.vault_usdg)+Number(mark.positions_usdg)+Number(perpMicro)/1e6-Number(mark.equity_usdg);
    if (Math.abs(markDelta)>MARK_TOLERANCE_USDG) {
      throw new Error(perpMicro === 0n
        ? `the recoverable valuation does not add up (cash+vault+positions-equity=${markDelta})`
        : `the recoverable valuation does not add up (cash+vault+positions+perps-equity=${markDelta})`);
    }
    if (perpMicro < 0n) throw new Error(`the recoverable valuation's paper perp book is negative (${perpMicro} micro)`);
    /**
     * SPLIT-INVARIANT, LIKE THE BOOK THIS IS RESTORING INTO — AND A PAPER
     * `raw_balance` ALREADY IS.
     *
     * index.ts writes a paper position's raw balance as `shares * 1e18` ("shares
     * is split-invariant, so it IS the raw balance in 18dp terms"), so it comes
     * back as `raw_balance / 1e18` with nothing applied. 912502b5 divided it by
     * the multiplier as well, reading it as a tradeable on-chain balance: every
     * restore through here then understated the holding by that multiplier and,
     * against the basis, disagreed by it twice over — which is how three
     * agents on this path were refused on every pass.
     */
    const shares=Object.fromEntries(positions.filter(p=>BigInt(String(p.raw_balance))>0n).map(p=>{
      const symbol=String(p.symbol);
      return [symbol,{token:String(p.token),shares:Number(p.raw_balance)/1e18}];
    }));
    const basis=await shared.prepare(`SELECT symbol,qty_raw,cost_usdg FROM cost_basis WHERE LOWER(agent_id)=LOWER(?) AND mode='paper'`).all(account) as Basis[];
    const peak = await paperPeakBasis(shared, account, Number(mark.epoch));
    /**
     * A PAPER PERP BOOK THIS PATH CANNOT RESTORE WHOLE IS CLOSED AT THE MARK.
     *
     * An equity row carries the perp book's value, not its positions, so the
     * positions themselves are not recoverable from here. The two other
     * answers are both worse: dropping the book loses its whole value from a
     * book the owner can see, and refusing leaves a paper agent that is never
     * started — and so can never be reset — for as long as the row stands.
     * Folding every paper position into collateral at the very mark whose
     * identity was just checked keeps paper equity exactly what the ledger
     * last recorded, and the result says it happened. It is paper money, and
     * only this path — which an agent with a sound checkpoint for its epoch
     * never takes.
     */
    const perpJson = perpMicro > 0n ? JSON.stringify({ v: 1, collateral_micro: perpMicro.toString(), positions: [] }) : null;
    foldedPerps = perpJson !== null;
    /**
     * THE HIGH-WATER MARK TAKES TODAY'S VALUATION TOO.
     *
     * The book being restored is worth `cash + vault + value` at today's
     * prices, which may be above anything the equity series ever recorded —
     * the agent was down while the market moved. An HWM must never step down,
     * and it is what the fee and the drawdown breaker are judged against, so
     * leaving a real rise out would let a fee accrue on a gain that was never
     * realised. All three candidates, and the largest wins.
     *
     * EACH ON THE PEAK BASIS (rule 12): equity less the positive unrealized
     * perp P&L it held, per position, so a wick that reverted can never have
     * lifted the paper peak. For a row with no perp term it is the equity
     * itself, exactly as before. Today's candidate includes the folded perp
     * book, which is now collateral and no longer unrealized.
     */
    const hwm = Math.max(
      Number(mark.equity_usdg) - Number(gainMicro) / 1e6,
      peak,
      Number(mark.cash_usdg) + Number(mark.vault_usdg) + value + Number(perpMicro) / 1e6,
    );
    row={agent_id:account,epoch:Number(mark.epoch),cash_usdg:Number(mark.cash_usdg),vault_usdg:Number(mark.vault_usdg),hwm_usdg:hwm,shares:JSON.stringify(shares),basis_json:JSON.stringify(basis.filter(b=>shares[b.symbol])),updated_at:Number(mark.at),perp_json:perpJson};
    bookAt = Number(mark.at);
  }
  const why = paperCheckpointRejection(row, multiplierOf);
  if (why) throw new Error(`invalid paper checkpoint: ${why}`);
  // Restored in today's units, so the book comes back with basis == shares and
  // stays so through every later fill (see normalizedBasis).
  const { basis, normalized } = normalizedBasis(row.shares, row.basis_json, multiplierOf);
  const restored = row;
  await child.tx(async db=>{
    // paper_book's time is the instant the restored book stands at (bookAt):
    // the checkpoint this book writes next must claim at least what this one
    // held, or a funding hour booked before the restore would read as newer
    // than it and refuse the next restore. For a book with no perps it is the
    // checkpoint's own time, as it always was.
    await db.prepare(`INSERT INTO paper_book(agent_id,cash_usdg,vault_usdg,hwm_usdg,shares,updated_at) VALUES(?,?,?,?,?,?)`)
      .run(account,restored.cash_usdg,restored.vault_usdg,restored.hwm_usdg,restored.shares,bookAt);
    await db.prepare("DELETE FROM cost_basis WHERE agent_id=? AND mode='paper'").run(account);
    for(const b of basis) await db.prepare(`INSERT INTO cost_basis(agent_id,mode,symbol,qty_raw,cost_usdg,updated_at) VALUES(?,'paper',?,?,?,?)`)
      .run(account,b.symbol,b.qty_raw,b.cost_usdg,restored.updated_at);
    // THE PAPER PERP BOOK, in the same transaction as the cash it was drawn
    // from: half a book restored is a book whose money is in two places.
    if (restored.perp_json !== null && restored.perp_json !== undefined) {
      await writePaperPerpState(db, account, restored.perp_json);
    }
  });
  const perpNote = foldedPerps
    ? ' — paper perps at that valuation were closed into paper collateral at its own mark'
    : restored.perp_json ? ', with the paper perp book' : '';
  return `paper cash, holdings and basis restored${saidNormalized(normalized)}${perpNote}`;
}

/**
 * THE PAPER PEAK OF AN EPOCH, ON THE PEAK BASIS: the highest equity less the
 * positive unrealized perp P&L that row held (rule 12 — every peak, the paper
 * peak included, ratchets on what is real). A row with no perp term (NULL) is
 * its own equity, so for every Spot agent this is MAX(equity_usdg), as it was.
 *
 * Postgres: equity_usdg is double precision, and BIGINT ÷ 1000000.0 is
 * numeric; the explicit cast keeps the whole expression double precision
 * rather than leaning on an implicit numeric-to-float conversion.
 *
 * Only for a shared database whose equity table predates the perp columns
 * does it fall back to the plain maximum — asked of the catalogue, never
 * learned from a failed read — and there no row can have held a perp gain to
 * subtract, so the answer is the same.
 */
async function paperPeakBasis(db: Db, account: string, epoch: number): Promise<number> {
  const gain = await equityColumnPresent(db, "perp_unrealized_gain_micro");
  const r = (await db
    .prepare(
      gain
        ? `SELECT MAX(equity_usdg - CAST(COALESCE(CAST(perp_unrealized_gain_micro AS BIGINT), 0) AS DOUBLE PRECISION) / 1000000.0) AS peak
             FROM equity WHERE LOWER(agent_id)=LOWER(?) AND epoch=? AND mode='paper'`
        : `SELECT MAX(equity_usdg) AS peak FROM equity WHERE LOWER(agent_id)=LOWER(?) AND epoch=? AND mode='paper'`,
    )
    .get(account, epoch)) as { peak: number | null } | undefined;
  return Number(r?.peak ?? 0);
}

/**
 * Does the shared `equity` table have this column? Postgres's catalogue
 * first, as ledger-migrations.ts reads it; only SQLite's own absence of that
 * catalogue selects SQLite's.
 */
async function equityColumnPresent(db: Db, column: string): Promise<boolean> {
  try {
    return !!(await db
      .prepare(`SELECT 1 AS x FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
                 WHERE c.relname = 'equity' AND a.attname = ? AND a.attnum > 0 AND NOT a.attisdropped
                   AND c.relkind IN ('r', 'p') AND pg_table_is_visible(c.oid)`)
      .get(column));
  } catch (e) {
    if (!/^no such table: pg_catalog\.pg_attribute$/i.test((e as Error)?.message ?? "")) throw e;
    return !!(await db.prepare("SELECT 1 AS x FROM pragma_table_info('equity') WHERE name = ?").get(column));
  }
}

/**
 * What a reset of a blocked book came to: the epoch it opened, or why nothing
 * was changed. `moved` marks the one refusal that asking again can undo: the
 * epoch changed under the decision, and the next decision reads the new one.
 */
export type BlockedBookReset = { ok: true; epoch: number } | { ok: false; why: string; moved?: true };

/**
 * START A PRACTICE BOOK OVER WHEN NO WORKER CAN, from the shared ledger alone.
 *
 * A book restorePaperCheckpoint refuses holds its tenant (orchestrator.ts
 * spawnHolder), and a held tenant has no worker, which is the only process
 * that could run the owner's Practice reset (index.ts runPaperReset). So the
 * reset the owner was told to press waited for a worker that could not start.
 * This is the same reset, done where the book's durable copy lives.
 *
 * WHAT THE WORKER'S RESET LEAVES IN THE SHARED LEDGER, AND SO WHAT THIS DOES.
 * runPaperReset clears the local paper_book, positions and the paper rows of
 * cost_basis and position_floors (store.ts resetPaperLedger), and opens the
 * next accounting epoch with no capital flow (a paper carry is refused by
 * admitCapitalFlow). The mirror then carries it up: the epoch by its ratchet,
 * and the three snapshots by delete-then-insert. So, in one transaction:
 *
 * - `agents.epoch` moves to an epoch nothing has been filed under. Every old
 *   trade, mark, flow and the old checkpoint stay where they are and stop
 *   counting, which is what the epoch is for. restorePaperCheckpoint then finds
 *   no checkpoint and no valuation in the new epoch and answers "no durable
 *   checkpoint", the worker seeds its book at its own starting stake, and its
 *   first mirror pass writes the new epoch's checkpoint, which the checkpoint
 *   upsert prefers to the old one (a higher epoch always wins).
 * - `positions`, and the PAPER rows of `cost_basis` and `position_floors`, are
 *   deleted. Not only for the dashboard, which would go on showing the old
 *   holdings: the worker that comes next starts in a fresh home, and the
 *   mirror never deletes a rebuilt worker's cost basis, nor its positions
 *   while its book is empty (ledger-mirror.ts), so nothing else would. And
 *   the restore's upgrade path builds a book from exactly these two tables:
 *   left behind, one missed checkpoint in the new epoch would restore the old
 *   book's shares beside the new book's cash. A live basis is another book
 *   (the primary key has a mode) and is never touched.
 * - the PAPER perp book: its positions deleted and its collateral a read '0',
 *   as resetPaperLedger leaves the worker's own. The live rail is never
 *   touched.
 *
 * "NOTHING FILED UNDER" IS NOT ALWAYS epoch + 1. The mirror copies the append-
 * only tables before the agents row, so a pass that failed between the two,
 * followed by a redeploy, leaves rows a step ahead of `agents.epoch`. Reusing
 * that epoch would hand the new book an old valuation and old fills, which is
 * the failure being recovered from. So the new epoch is one past the highest
 * any of this account's rows carries, and never less than one past the
 * observed one.
 *
 * CONDITIONAL ON THE EPOCH THE CALLER DECIDED ON: `observedEpoch` must still be
 * the account's, or nothing changes. Whatever moved it (a worker's own reset
 * carried up by the mirror) has changed the book this decision was about.
 *
 * AND ONLY A PRACTICE BOOK, asked again here, inside the transaction, of the
 * ledger itself: the newest valuation must be a paper one, and the agent must
 * not last have reported the live rail. The caller asks the owner's stored
 * settings as well (held-reset.ts). Neither check relies on the other, the same
 * rule runOrderCommand states: on a live account this would hide real history
 * from reporting without carrying its capital across, and delete the positions
 * real P&L is read against.
 */
export async function resetBlockedPaperBook(shared: Db, account: string, observedEpoch: number): Promise<BlockedBookReset> {
  await shared.exec(PAPER_CHECKPOINT_SCHEMA);
  return shared.tx((db) => resetBlockedPaperBookIn(db, account, observedEpoch));
}

/**
 * resetBlockedPaperBook inside a transaction the caller already holds, so the
 * claim of the owner's command can commit with it (held-reset.ts). The caller
 * has run PAPER_CHECKPOINT_SCHEMA: DDL does not belong inside the transaction.
 */
export async function resetBlockedPaperBookIn(db: Db, account: string, observedEpoch: number): Promise<BlockedBookReset> {
  if (!Number.isSafeInteger(observedEpoch) || observedEpoch < 1) return { ok: false, why: `no usable epoch (${String(observedEpoch)})` };
  const agent = await db.prepare(`SELECT epoch, mode FROM agents WHERE LOWER(smart_account)=LOWER(?)`).get(account) as { epoch: number; mode: string | null } | undefined;
  if (!agent) return { ok: false, why: "the account has no agent row" };
  if (Number(agent.epoch) !== observedEpoch) return { ok: false, why: `the epoch moved (${observedEpoch} → ${Number(agent.epoch)})`, moved: true };
  if (agent.mode === "live") return { ok: false, why: "the agent last reported the live rail" };
  const mark = await db.prepare(`SELECT mode FROM equity WHERE LOWER(agent_id)=LOWER(?) ORDER BY at DESC, id DESC LIMIT 1`).get(account) as { mode: string | null } | undefined;
  if (mark?.mode !== "paper") return { ok: false, why: mark ? `the newest valuation is not a paper one (${String(mark.mode)})` : "there is no valuation to show the book is a paper one" };
  // THE PERP TAPE FILES UNDER EPOCHS TOO, and the mirror copies it before the
  // agents row exactly as it copies the tables above — the same "a step
  // ahead" case. Each perp table is asked of the catalogue first: the caller
  // holds a transaction, and on Postgres a read of a table that is not there
  // would abort it.
  const perpFiled: string[] = [];
  for (const table of ["perp_fills", "perp_funding", "perp_carries", "perp_orders", "perp_transfers"] as const) {
    if (await tablePresent(db, table)) perpFiled.push(table);
  }
  const top = await db.prepare(`SELECT MAX(e) AS top FROM (
      SELECT MAX(epoch) AS e FROM equity WHERE LOWER(agent_id)=LOWER(?)
      UNION ALL SELECT MAX(epoch) AS e FROM trades WHERE LOWER(agent_id)=LOWER(?)
      UNION ALL SELECT MAX(epoch) AS e FROM flows WHERE LOWER(agent_id)=LOWER(?)
      UNION ALL SELECT MAX(epoch) AS e FROM paper_checkpoints WHERE LOWER(agent_id)=LOWER(?)${
        perpFiled.map((t) => `\n      UNION ALL SELECT MAX(epoch) AS e FROM ${t} WHERE LOWER(agent_id)=LOWER(?)`).join("")}
    ) filed`).get(account, account, account, account, ...perpFiled.map(() => account)) as { top: number | string | null } | undefined;
  const filed = Number(top?.top ?? 0);
  const epoch = Math.max(observedEpoch, Number.isFinite(filed) ? filed : 0) + 1;
  const moved = await db.prepare(`UPDATE agents SET epoch=? WHERE LOWER(smart_account)=LOWER(?) AND epoch=?`).run(epoch, account, observedEpoch);
  if (Number(moved.changes) === 0) return { ok: false, why: "the epoch moved", moved: true };
  await db.prepare(`DELETE FROM positions WHERE LOWER(agent_id)=LOWER(?)`).run(account);
  await db.prepare(`DELETE FROM cost_basis WHERE LOWER(agent_id)=LOWER(?) AND mode='paper'`).run(account);
  await db.prepare(`DELETE FROM position_floors WHERE LOWER(agent_id)=LOWER(?) AND mode='paper'`).run(account);
  // AND THE PAPER PERP BOOK, which the worker's own reset clears with the
  // cash (store.ts resetPaperLedger): the paper positions go, and the paper
  // collateral goes to a READ '0' (never NULL, which a checkpoint reads as a
  // torn book). Left here, the old open positions would stand in the shared
  // book until the new child first writes its account row. The nonce
  // high-water stays: it only ever rises, across a reset too. The live rail
  // is another book and is never touched; the old checkpoint's perp_json is
  // already out of reach, since a restore reads only the agent's own epoch.
  if (await tablePresent(db, "perp_positions")) {
    await db.prepare(`DELETE FROM perp_positions WHERE LOWER(agent_id)=LOWER(?) AND mode='paper'`).run(account);
  }
  if (await tablePresent(db, "perp_accounts")) {
    await db.prepare(`UPDATE perp_accounts SET paper_collateral_micro='0', updated_at=? WHERE LOWER(agent_id)=LOWER(?) AND mode='paper'`)
      .run(Math.floor(Date.now() / 1000), account);
  }
  return { ok: true, epoch };
}
