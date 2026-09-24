import type { Db } from "./db";

export const PAPER_CHECKPOINT_SCHEMA = `CREATE TABLE IF NOT EXISTS paper_checkpoints (
  agent_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, cash_usdg REAL NOT NULL,
  vault_usdg REAL NOT NULL, hwm_usdg REAL NOT NULL, shares TEXT NOT NULL,
  basis_json TEXT NOT NULL, updated_at INTEGER NOT NULL
);`;

export async function recordPaperRecoveryHealth(db:Db,account:string,blocked:boolean):Promise<void> {
  await db.exec(`CREATE TABLE IF NOT EXISTS paper_recovery_health (
    agent_id TEXT PRIMARY KEY, blocked INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  await db.prepare(`INSERT INTO paper_recovery_health(agent_id,blocked,updated_at) VALUES(?,?,?)
    ON CONFLICT(agent_id) DO UPDATE SET blocked=excluded.blocked,updated_at=excluded.updated_at`)
    .run(account.toLowerCase(),blocked?1:0,Math.floor(Date.now()/1000));
}

type Checkpoint = {agent_id:string; epoch:number; cash_usdg:number; vault_usdg:number; hwm_usdg:number; shares:string; basis_json:string; updated_at:number};
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
      // split-invariant quantity, so basis == shares; fills before 2026-09-19
      // booked the tradeable quantity, shares × multiplier; a position spanning
      // both holds a mix. So the basis may sit anywhere between the two, and a
      // torn write — a book updated past its basis, or a basis booked twice —
      // lands outside them. The 1e-6 is the engine's own rounding: a sell
      // rounds the book's shares to 6dp while the basis stays exact.
      const mul = multiplierOf(symbol);
      const qty = Number(b.qty_raw)/1e18;
      const lo = p.shares * Math.min(1, mul), hi = p.shares * Math.max(1, mul);
      if (qty < lo - 1e-6 || qty > hi + 1e-6) return `${symbol} basis ${b.qty_raw} raw disagrees with ${p.shares} shares at multiplier ${mul}`;
    }
    for (const b of basis) {
      if (BigInt(b.qty_raw)<0n || BigInt(b.cost_usdg)<0n) return `${b.symbol} basis is negative`;
      if (!shares[b.symbol] && BigInt(b.qty_raw)!==0n) return `${b.symbol} has basis for ${b.qty_raw} raw but is not held`;
    }
    return null;
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
  await shared.exec(PAPER_CHECKPOINT_SCHEMA);
  const snapshots = await child.tx(async db => {
    const books = await db.prepare(`SELECT p.*, a.epoch FROM paper_book p JOIN agents a ON LOWER(a.smart_account)=LOWER(p.agent_id)`).all() as Checkpoint[];
    for (const book of books) book.basis_json = JSON.stringify(await db.prepare(`SELECT symbol, qty_raw, cost_usdg FROM cost_basis WHERE agent_id=? AND mode='paper'`).all(book.agent_id));
    return books;
  });
  let count=0;
  for(const b of snapshots) {
    // FROM THE CHILD, which is the book these shares were written against.
    const why = paperCheckpointRejection(b, await multipliersFor(child, b.agent_id));
    if (why) {
      // SAID OUT LOUD, because this skip is the start of the whole failure
      // chain. No checkpoint written here means every later restore falls to
      // the upgrade path, and until now the only evidence that this line had
      // run at all was a count that was one lower than expected.
      console.warn(`[paper] checkpoint not mirrored for ${b.agent_id}: ${why}`);
      continue;
    }
    await shared.prepare(`INSERT INTO paper_checkpoints(agent_id,epoch,cash_usdg,vault_usdg,hwm_usdg,shares,basis_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET epoch=excluded.epoch,cash_usdg=excluded.cash_usdg,
      vault_usdg=excluded.vault_usdg,hwm_usdg=excluded.hwm_usdg,shares=excluded.shares,basis_json=excluded.basis_json,updated_at=excluded.updated_at
      WHERE excluded.epoch > paper_checkpoints.epoch OR (excluded.epoch=paper_checkpoints.epoch AND excluded.updated_at>=paper_checkpoints.updated_at)`)
      .run(b.agent_id,b.epoch,b.cash_usdg,b.vault_usdg,b.hwm_usdg,b.shares,b.basis_json,b.updated_at);
    count++;
  }
  return count;
}

/** Restore only an empty local book, including its matching basis. */
export async function restorePaperCheckpoint(child:Db, shared:Db, account:string):Promise<string> {
  if (await child.prepare("SELECT agent_id FROM paper_book WHERE LOWER(agent_id)=LOWER(?)").get(account)) return 'local book retained';
  await shared.exec(PAPER_CHECKPOINT_SCHEMA);
  let row = await shared.prepare(`SELECT p.* FROM paper_checkpoints p JOIN agents a ON LOWER(a.smart_account)=LOWER(p.agent_id)
    WHERE LOWER(p.agent_id)=LOWER(?) AND p.epoch=a.epoch`).get(account) as Checkpoint | undefined;
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
    const markDelta = Number(mark.cash_usdg)+Number(mark.vault_usdg)+Number(mark.positions_usdg)-Number(mark.equity_usdg);
    if (Math.abs(markDelta)>MARK_TOLERANCE_USDG) throw new Error(`the recoverable valuation does not add up (cash+vault+positions-equity=${markDelta})`);
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
    const peak=await shared.prepare(`SELECT MAX(equity_usdg) AS peak FROM equity WHERE LOWER(agent_id)=LOWER(?) AND epoch=? AND mode='paper'`).get(account,Number(mark.epoch)) as {peak:number};
    /**
     * THE HIGH-WATER MARK TAKES TODAY'S VALUATION TOO.
     *
     * The book being restored is worth `cash + vault + value` at today's
     * prices, which may be above anything the equity series ever recorded —
     * the agent was down while the market moved. An HWM must never step down,
     * and it is what the fee and the drawdown breaker are judged against, so
     * leaving a real rise out would let a fee accrue on a gain that was never
     * realised. All three candidates, and the largest wins.
     */
    row={agent_id:account,epoch:Number(mark.epoch),cash_usdg:Number(mark.cash_usdg),vault_usdg:Number(mark.vault_usdg),hwm_usdg:Math.max(Number(mark.equity_usdg),Number(peak.peak),Number(mark.cash_usdg)+Number(mark.vault_usdg)+value),shares:JSON.stringify(shares),basis_json:JSON.stringify(basis.filter(b=>shares[b.symbol])),updated_at:Number(mark.at)};
  }
  const why = paperCheckpointRejection(row, multiplierOf);
  if (why) throw new Error(`invalid paper checkpoint: ${why}`);
  await child.tx(async db=>{
    await db.prepare(`INSERT INTO paper_book(agent_id,cash_usdg,vault_usdg,hwm_usdg,shares,updated_at) VALUES(?,?,?,?,?,?)`)
      .run(account,row.cash_usdg,row.vault_usdg,row.hwm_usdg,row.shares,row.updated_at);
    await db.prepare("DELETE FROM cost_basis WHERE agent_id=? AND mode='paper'").run(account);
    for(const b of JSON.parse(row.basis_json) as Basis[]) await db.prepare(`INSERT INTO cost_basis(agent_id,mode,symbol,qty_raw,cost_usdg,updated_at) VALUES(?,'paper',?,?,?,?)`)
      .run(account,b.symbol,b.qty_raw,b.cost_usdg,row.updated_at);
  });
  return 'paper cash, holdings and basis restored';
}
