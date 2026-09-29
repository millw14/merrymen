import type { Db } from "./db";
import { perpMarketById } from "../../packages/core/src/index";
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
 * simulated position to re-read at arm, so a redeploy that restored the cash
 * and not the perps would drop the paper collateral and every paper position
 * on the floor — paper equity falling by the whole perp book, read by every
 * surface as a loss.
 *
 * NULLABLE, like every column added to a table rows already live in: NULL is a
 * checkpoint with no perp book (every one written before this, and every agent
 * that never traded paper perps), which restores exactly as before.
 */
export const PAPER_CHECKPOINT_ALTERS: readonly string[] = ["ALTER TABLE paper_checkpoints ADD COLUMN perp_json TEXT"];

/** Databases whose checkpoint ALTERs this process has already run. */
const altered = new WeakSet<Db>();

/**
 * Create the checkpoint table and bring it up to date. Each ALTER is swallowed
 * when already applied — sqlite says "duplicate column", and the Postgres
 * translation (ADD COLUMN IF NOT EXISTS) never fails for it — the same no-op
 * applyLedgerSchema relies on. A column that genuinely failed to add surfaces
 * at the INSERT that names it, loudly, rather than here.
 *
 * The ALTERs run ONCE PER DATABASE PER PROCESS, not on every call: this is
 * called on every mirror pass for every tenant, and a Postgres ALTER TABLE
 * takes an exclusive lock on the shared table even when the column is already
 * there — every tenant's checkpoint write and restore would queue behind it
 * every fifteen seconds. (makePgDb hands back one Db per URL, so the memo
 * holds for the life of the pool.) The CREATE stays per call, as before.
 */
export async function ensurePaperCheckpointSchema(db: Db): Promise<void> {
  await db.exec(PAPER_CHECKPOINT_SCHEMA);
  if (altered.has(db)) return;
  for (const ddl of PAPER_CHECKPOINT_ALTERS) {
    try {
      await db.exec(ddl);
    } catch {
      // already there
    }
  }
  altered.add(db);
}

/** One paper perp position as a checkpoint carries it. Integers are canonical decimal strings. */
export interface PaperPerpPosition {
  market_id: number;
  side: "long" | "short";
  /** venue base units, > 0 */
  base: string;
  /** venue price units, > 0 */
  entry_price: string;
  /** micro-USDG, ≥ 0 — debited from the paper collateral when the position opened */
  allocated_margin_micro: string;
  imf_bp: number;
  margin_mode: "isolated" | "cross";
  realized_micro: string | null;
  funding_micro: string | null;
  /** The last funding hour charged, unix seconds — so a restore never charges an hour twice. */
  funding_hour_applied: number | null;
  stop_trigger: string | null;
  stop_price: string | null;
  take_trigger: string | null;
  take_price: string | null;
  opened_at: number | null;
}

/** The paper perp book: the cross collateral and every open position, from ONE read. */
export interface PaperPerpState {
  v: 1;
  collateral_micro: string;
  positions: PaperPerpPosition[];
}

const CANON_INT = /^-?(0|[1-9]\d*)$/;

/**
 * WHY A PAPER PERP BOOK IS REFUSED, or null. Everything a restore would write
 * back into a book is checked here first: money and margins non-negative
 * integers, every market one LIGHTER_MARKETS_V1 knows (a restored position in
 * a market the engine cannot price is a position nobody can close), no market
 * twice, and the IMF inside the venue's own range.
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
  if (typeof s.collateral_micro !== "string" || !CANON_INT.test(s.collateral_micro) || BigInt(s.collateral_micro) < 0n) {
    return `paper perp collateral is ${String(s.collateral_micro)}, not a non-negative integer`;
  }
  if (!Array.isArray(s.positions)) return "paper perp positions is not a list";
  const seen = new Set<number>();
  const nonNeg = (v: unknown) => typeof v === "string" && CANON_INT.test(v) && BigInt(v) >= 0n;
  const optNonNeg = (v: unknown) => v === null || nonNeg(v);
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
    for (const [name, v] of [["stop trigger", p.stop_trigger], ["stop price", p.stop_price], ["take trigger", p.take_trigger], ["take price", p.take_price]] as const) {
      if (!optNonNeg(v)) return `${key} ${name} is ${String(v)}`;
    }
    for (const [name, v] of [["funding hour", p.funding_hour_applied], ["opened at", p.opened_at]] as const) {
      if (v !== null && (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)) return `${key} ${name} is ${String(v)}`;
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
 * paper_book snapshot's transaction, so the collateral, the positions and the
 * cash beside them are one instant (a book read between a fill's collateral
 * write and its position write would restore money that is in two places, or
 * none). Null when the agent has no paper perp book at all.
 *
 * A collateral that was never set is '0' only when nothing is open: margin
 * against positions with no collateral row is not a book, and is carried as
 * such (null) for the check to refuse.
 */
export async function readPaperPerpState(db: Db, account: string): Promise<string | null> {
  if (!(await childHasTable(db, "perp_accounts")) || !(await childHasTable(db, "perp_positions"))) return null;
  const acct = (await db
    .prepare(`SELECT paper_collateral_micro FROM perp_accounts WHERE LOWER(agent_id)=LOWER(?) AND mode='paper'`)
    .get(account)) as { paper_collateral_micro: string | null } | undefined;
  const rows = (await db
    .prepare(`SELECT * FROM perp_positions WHERE LOWER(agent_id)=LOWER(?) AND mode='paper' AND base <> '0' ORDER BY market_id ASC`)
    .all(account)) as Record<string, unknown>[];
  if (!acct && rows.length === 0) return null;
  const collateral = acct?.paper_collateral_micro ?? (rows.length === 0 ? "0" : null);
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const state = {
    v: 1,
    collateral_micro: collateral,
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
      take_trigger: str(r.take_trigger),
      take_price: str(r.take_price),
      opened_at: num(r.opened_at),
    })),
  };
  return JSON.stringify(state);
}

/** Write a validated paper perp book into a child's ledger, inside the restore's transaction. */
async function writePaperPerpState(db: Db, account: string, perpJson: string, at: number): Promise<void> {
  const s = JSON.parse(perpJson) as PaperPerpState;
  const agent = account.toLowerCase();
  await db
    .prepare(
      `INSERT INTO perp_accounts (agent_id, mode, paper_collateral_micro) VALUES (?, 'paper', ?)
       ON CONFLICT(agent_id, mode) DO UPDATE SET paper_collateral_micro = excluded.paper_collateral_micro`,
    )
    .run(agent, s.collateral_micro);
  await db.prepare(`DELETE FROM perp_positions WHERE agent_id = ? AND mode = 'paper'`).run(agent);
  for (const p of s.positions) {
    await db
      .prepare(
        `INSERT INTO perp_positions (agent_id, mode, market_id, side, base, entry_price, allocated_margin_micro, imf_bp,
                                     margin_mode, realized_micro, funding_micro, stop_trigger, stop_price, take_trigger,
                                     take_price, funding_hour_applied, opened_at, updated_at, source)
         VALUES (?, 'paper', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paper')`,
      )
      .run(agent, p.market_id, p.side, p.base, p.entry_price, p.allocated_margin_micro, p.imf_bp, p.margin_mode,
        p.realized_micro, p.funding_micro, p.stop_trigger, p.stop_price, p.take_trigger, p.take_price,
        p.funding_hour_applied, p.opened_at, at);
  }
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
 * did before. Only the answer got wider.
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
    // write back whole is not a restore point.
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
  await ensurePaperCheckpointSchema(shared);
  const snapshots = await child.tx(async db => {
    const books = await db.prepare(`SELECT p.*, a.epoch FROM paper_book p JOIN agents a ON LOWER(a.smart_account)=LOWER(p.agent_id)`).all() as Checkpoint[];
    for (const book of books) {
      book.basis_json = JSON.stringify(await db.prepare(`SELECT symbol, qty_raw, cost_usdg FROM cost_basis WHERE agent_id=? AND mode='paper'`).all(book.agent_id));
      // IN THE SAME TRANSACTION as the cash and shares above, so the paper
      // perp book is the same instant as the spot book it sits beside.
      book.perp_json = await readPaperPerpState(db, book.agent_id);
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
    // perp_json travels with the rest of the row and is replaced with it —
    // including by NULL, because a newer book with no paper perps is a book
    // whose perps were closed, and keeping the older ones would resurrect them.
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
    // trades boundary): a paper perp fill or funding charge after the mark
    // moved money the mark does not hold, exactly as a spot fill would. A
    // shared database with no perp tables yet holds no such rows.
    const laterPerp =
      (await countIfPresent(shared, `SELECT COUNT(*) AS n FROM perp_fills WHERE LOWER(agent_id)=LOWER(?) AND mode='paper' AND epoch=? AND created_at>=?`,
        account, Number(mark.epoch), Number(mark.at))) +
      (await countIfPresent(shared, `SELECT COUNT(*) AS n FROM perp_funding WHERE LOWER(agent_id)=LOWER(?) AND mode='paper' AND epoch=? AND created_at>=?`,
        account, Number(mark.epoch), Number(mark.at)));
    if (laterPerp>0) throw new Error('paper perp fills or funding are newer than the recoverable valuation');
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
     * the total by addEquity. NULL is a mark that carried no perp term — every
     * row from before perps — and contributes nothing; an unreadable value is
     * a row that cannot be checked, and refuses. Without this the identity
     * below would refuse every paper agent whose last mark held a perp book,
     * which is the agent-dead-on-every-ferry-pass failure this path exists to
     * end.
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
    if (Math.abs(markDelta)>MARK_TOLERANCE_USDG) throw new Error(`the recoverable valuation does not add up (cash+vault+positions+perps-equity=${markDelta})`);
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
     * Closing every paper position at the very mark whose identity was just
     * checked keeps paper equity exactly what the ledger last recorded, and
     * the result says it happened. It is paper money, and only this path —
     * which an agent with a sound checkpoint for its epoch never takes.
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
  }
  const why = paperCheckpointRejection(row, multiplierOf);
  if (why) throw new Error(`invalid paper checkpoint: ${why}`);
  // Restored in today's units, so the book comes back with basis == shares and
  // stays so through every later fill (see normalizedBasis).
  const { basis, normalized } = normalizedBasis(row.shares, row.basis_json, multiplierOf);
  const restored = row;
  await child.tx(async db=>{
    await db.prepare(`INSERT INTO paper_book(agent_id,cash_usdg,vault_usdg,hwm_usdg,shares,updated_at) VALUES(?,?,?,?,?,?)`)
      .run(account,restored.cash_usdg,restored.vault_usdg,restored.hwm_usdg,restored.shares,restored.updated_at);
    await db.prepare("DELETE FROM cost_basis WHERE agent_id=? AND mode='paper'").run(account);
    for(const b of basis) await db.prepare(`INSERT INTO cost_basis(agent_id,mode,symbol,qty_raw,cost_usdg,updated_at) VALUES(?,'paper',?,?,?,?)`)
      .run(account,b.symbol,b.qty_raw,b.cost_usdg,restored.updated_at);
    // THE PAPER PERP BOOK, in the same transaction as the cash it was drawn
    // from: half a book restored is a book whose money is in two places.
    if (restored.perp_json !== null && restored.perp_json !== undefined) {
      await writePaperPerpState(db, account, restored.perp_json, restored.updated_at);
    }
  });
  const perpNote = foldedPerps
    ? ' — paper perps at that valuation were closed into paper collateral at its own mark'
    : restored.perp_json ? ', with the paper perp book' : '';
  return `paper cash, holdings and basis restored${saidNormalized(normalized)}${perpNote}`;
}

/** Postgres undefined_table / undefined_column, or sqlite's own words for either. */
function missingRelation(e: unknown, what: "table" | "column"): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: unknown }).code;
  return what === "table" ? code === "42P01" || /no such table/i.test(e.message) : code === "42703" || /no such column/i.test(e.message);
}

/**
 * A count from a table the shared database may not have yet. Absent is zero
 * ONLY for "no such table" — a database that has never had a perp table holds
 * no perp rows. Any other failure is thrown: an unanswered question is not a
 * clean answer.
 */
async function countIfPresent(db: Db, sql: string, ...args: unknown[]): Promise<number> {
  try {
    const r = (await db.prepare(sql).get(...args)) as { n: unknown } | undefined;
    return Number(r?.n ?? 0);
  } catch (e) {
    if (missingRelation(e, "table")) return 0;
    throw e;
  }
}

/**
 * THE PAPER PEAK OF AN EPOCH, ON THE PEAK BASIS: the highest equity less the
 * positive unrealized perp P&L that row held (rule 12 — every peak, the paper
 * peak included, ratchets on what is real). A row with no perp term (NULL) is
 * its own equity.
 *
 * Only for a shared database whose equity table predates the perp columns
 * does it fall back to the plain maximum — and there no row can have held a
 * perp gain to subtract, so the answer is the same. Any other failure throws.
 */
async function paperPeakBasis(db: Db, account: string, epoch: number): Promise<number> {
  try {
    const r = (await db
      .prepare(
        `SELECT MAX(equity_usdg - COALESCE(CAST(perp_unrealized_gain_micro AS BIGINT), 0) / 1000000.0) AS peak
           FROM equity WHERE LOWER(agent_id)=LOWER(?) AND epoch=? AND mode='paper'`,
      )
      .get(account, epoch)) as { peak: number | null } | undefined;
    return Number(r?.peak ?? 0);
  } catch (e) {
    if (!missingRelation(e, "column")) throw e;
    const r = (await db
      .prepare(`SELECT MAX(equity_usdg) AS peak FROM equity WHERE LOWER(agent_id)=LOWER(?) AND epoch=? AND mode='paper'`)
      .get(account, epoch)) as { peak: number | null } | undefined;
    return Number(r?.peak ?? 0);
  }
}
