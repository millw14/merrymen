/**
 * GIVING A REBUILT CHILD BACK THE COST BASIS IT ALREADY EARNED.
 *
 * A child's ledger lives in its container's own sqlite and `railway.json`
 * declares no volume for it, so every redeploy destroys `cost_basis`. The
 * mirror carries it UP to shared Postgres and nothing ever carries it back, so
 * after a redeploy a position bought last week sells with no basis at all:
 * `applyFill` reports `basisUnknown` — correctly, for a sell with nothing on
 * the books — and the realised P&L is dropped.
 *
 * `restoreClassCostBasis` already solves this for CLASS positions by
 * re-deriving them from the vault's own `ClassBuy` events. An ordinary swap has
 * no such event to read: the cost was only ever known to the ledger. So the
 * ledger is where it has to come back from.
 *
 * ONLY INTO AN EMPTY TABLE, and that is the whole safety argument. A child that
 * still holds its own rows is the authority on its own book — it may have
 * booked fills the mirror has not collected yet, and overwriting those with an
 * older shared snapshot would lose them. A rebuilt child has nothing to lose,
 * which is exactly when this runs.
 *
 * NOT A SECOND SOURCE OF TRUTH. This copies what the mirror copied up; it never
 * invents a figure. If shared has no row either, the basis stays unknown and
 * the sell still reports `basisUnknown` — which is the honest answer, and the
 * one thing that must never be replaced by a confident zero.
 */
import type { Db } from "./db";

/** One position's cost, exactly as both sides store it. */
export interface BasisSeedRow {
  mode: string;
  symbol: string;
  qtyRaw: string;
  costUsdg: string;
}

export interface BasisSeedPlan {
  /** Rows to write into the child. Empty when the child already has its own. */
  rows: BasisSeedRow[];
  /** Why nothing is being written, for the operator log. Null when seeding. */
  skipped: string | null;
}

/**
 * Decide what to seed.
 *
 * Pure so the decision can be tested without a database — the two facts that
 * matter are "does the child already have rows" and "what does shared hold".
 */
export function planBasisSeed(args: {
  /** How many `cost_basis` rows the CHILD currently holds. */
  childRowCount: number;
  /** What SHARED holds for this agent. */
  shared: readonly BasisSeedRow[];
  /**
   * Symbols the shared ledger still shows a NON-ZERO POSITION in.
   *
   * WITHOUT THIS THE SEED RESURRECTS SOLD POSITIONS. The shared `cost_basis`
   * copy goes stale in one specific way: the mirror skips its own
   * `DELETE FROM cost_basis` while the child reads `rebuilt`, so a basis the
   * child consumed on a sell can still be sitting in shared. Restoring it would
   * hand the next buy a cost it never paid and make the next sell report a loss
   * that already happened — the very thing the stranded sweep exists to prevent.
   *
   * So a cost is only restored for something the book still says is held.
   * Omitted means "no position list available", and then nothing is seeded:
   * an unknown holding set is not a licence to restore costs.
   */
  heldSymbols?: readonly string[];
}): BasisSeedPlan {
  if (args.childRowCount > 0) {
    // The child is the authority on its own book. It may hold fills the mirror
    // has not collected, and an older shared snapshot would overwrite them.
    return { rows: [], skipped: `child already holds ${args.childRowCount} basis row(s)` };
  }
  if (args.shared.length === 0) {
    return { rows: [], skipped: "shared ledger holds no basis for this account" };
  }
  // A ZERO ROW IS NOT A BASIS. `setBasis` deletes at zero rather than storing
  // one, so a zero here would be a row the child itself would never have
  // written — and it would read as a tracked position with no cost, which is a
  // different and worse claim than "unknown".
  const held = new Set(args.heldSymbols ?? []);
  if (held.size === 0) {
    return { rows: [], skipped: "no held position on record — nothing to restore a cost for" };
  }
  const rows = args.shared.filter((r) => {
    if (!held.has(r.symbol)) return false;
    try {
      return BigInt(r.qtyRaw) > 0n;
    } catch {
      return false;
    }
  });
  if (rows.length === 0) {
    return { rows: [], skipped: "no shared basis row matches a currently-held position" };
  }
  return { rows, skipped: null };
}

/** The operator line, so a restored book is visible rather than inferred. */
export function basisSeedLine(tenant: string, plan: BasisSeedPlan): string {
  if (plan.skipped !== null) return `basis seed: ${tenant} — ${plan.skipped}`;
  const what = plan.rows.map((r) => `${r.symbol}=${r.costUsdg}`).join(", ");
  return `basis seed: ${tenant} — restored ${plan.rows.length} cost basis row(s) from the shared ledger (${what})`;
}

// ── AND EACH HELD POSITION'S FLOOR ──────────────────────────────────────────
//
// `position_floors` is the stop graded for a position at its own entry
// (store.ts setPositionFloor), and it dies with the child's sqlite exactly as
// `cost_basis` does. The mirror carries it up under the same rebuilt-child
// guard (ledger-mirror.ts) and, until this, nothing carried it back: every
// redeploy quietly swapped a held position's graded stop for the owner's single
// `strategistStopLossBps` — sometimes tighter, sometimes wider, never the level
// the position was entered under — and nothing said so.
//
// NOT BEHIND THE BASIS. A floor is copied for every held symbol whether or not
// a basis row exists on either side, because the two come back by different
// roads: a cost can still return after arm (the receipts, the class vault's
// own events), and a floor that was not put back before then never comes back
// at all — setPositionFloor stamps only at an entry.

/** One stamped floor, as the shared ledger holds it. */
export interface FloorSeedRow {
  mode: string;
  symbol: string;
  stopBps: number;
  rung: string;
  why: string;
  /** When it was stamped. Null when the shared row's stamp cannot be read. */
  at: number | null;
}

export interface FloorSeedPlan {
  /** Floors to write into the child. Empty when the child already has its own. */
  rows: FloorSeedRow[];
  /** Why nothing is being written, for the operator log. Null when seeding. */
  skipped: string | null;
}

/**
 * Decide which floors to seed.
 *
 * The same rules as planBasisSeed above, for the same reasons:
 *
 * - A CHILD WITH FLOORS OF ITS OWN IS THE AUTHORITY ON THEM. Nothing writes a
 *   floor into a child before it arms but this, so a child that holds any did
 *   not lose its table — and the shared copy is then never newer, only
 *   possibly STALE: the mirror skips its delete while the child reads rebuilt,
 *   so a floor the child dropped on a sell can outlive it there. Copied in
 *   beside the child's own, it would hand a later entry in that symbol a level
 *   graded from a market and an analysis that are both gone (store.ts
 *   setBasis says why that is worse than no floor).
 * - ONLY FOR WHAT THE BOOK STILL HOLDS, for that same staleness. `positions`
 *   carries no mode — it is whichever rail last ticked — so a held symbol puts
 *   back that symbol's floor in each mode. Every floor read is scoped to the
 *   rail that is running (store.ts positionFloors), so the other rail's row is
 *   inert until that rail runs, and is then the row it had before the
 *   redeploy. An omitted list seeds nothing.
 * - A ROW THAT CANNOT BE READ IS DROPPED, NOT GUESSED. A stop of zero or less
 *   is already "no floor" to the strategist (strategy.ts falls back to the
 *   owner's number), so leaving it out changes no level. Two spellings of one
 *   account in shared resolve to the EARLIER stamp, because a floor is stamped
 *   once at entry and the first write wins.
 *
 * It never writes a level the account did not already carry, and never into a
 * child that has floors of its own: it can only put a stop back, never loosen
 * one the child holds.
 */
export function planFloorSeed(args: {
  /** How many `position_floors` rows the CHILD currently holds, in any mode. */
  childRowCount: number;
  /** What SHARED holds for this agent. */
  shared: readonly FloorSeedRow[];
  /** Symbols the shared ledger still shows a NON-ZERO POSITION in. */
  heldSymbols?: readonly string[];
}): FloorSeedPlan {
  if (args.childRowCount > 0) {
    return { rows: [], skipped: `child already holds ${args.childRowCount} floor row(s)` };
  }
  if (args.shared.length === 0) {
    return { rows: [], skipped: "shared ledger holds no floor for this account" };
  }
  const held = new Set(args.heldSymbols ?? []);
  if (held.size === 0) {
    return { rows: [], skipped: "no held position on record — nothing to restore a floor for" };
  }
  const byKey = new Map<string, FloorSeedRow>();
  for (const r of args.shared) {
    if (!r.mode || !held.has(r.symbol)) continue;
    if (!Number.isSafeInteger(r.stopBps) || r.stopBps <= 0) continue;
    const key = `${r.mode}\u0000${r.symbol}`;
    const was = byKey.get(key);
    if (!was || (r.at !== null && (was.at === null || r.at < was.at))) byKey.set(key, r);
  }
  const rows = [...byKey.values()];
  if (rows.length === 0) {
    return { rows: [], skipped: "no shared floor matches a currently-held position" };
  }
  return { rows, skipped: null };
}

/** The operator line, so a restored stop is visible rather than inferred. */
export function floorSeedLine(tenant: string, plan: FloorSeedPlan): string {
  if (plan.skipped !== null) return `floor seed: ${tenant} — ${plan.skipped}`;
  const what = plan.rows.map((r) => `${r.mode}:${r.symbol}=${r.stopBps}bps`).join(", ");
  return `floor seed: ${tenant} — restored ${plan.rows.length} position floor(s) from the shared ledger (${what})`;
}

/**
 * Read both sides, plan, and write. The orchestrator opens the two databases
 * (seedBasisForChild); everything that decides is here, where a test can run
 * it over sqlite on both sides (basis-durability.test.ts).
 *
 * READ CASE-BLIND, WRITTEN IN THE GRANT'S SPELLING. Shared may hold the account
 * lower-cased or checksummed, but the child reads its floors with
 * `agent_id = ?` against `grant.smartAccount` exactly (store.ts positionFloors,
 * ensureAgent). A floor written under any other spelling would be present and
 * never applied — a stop restored in the log and nowhere else.
 *
 * ONE TRANSACTION ON THE CHILD, its count and its writes together. A seed cut
 * short must leave no floor at all rather than some, or the next spawn would
 * read the partial table as the child's own and never restore the rest.
 */
export async function seedPositionFloors(args: {
  child: Db;
  shared: Db;
  /** `grant.smartAccount`, in its exact spelling. */
  account: string;
}): Promise<FloorSeedPlan> {
  const { child, shared, account } = args;
  const floors = (await shared
    .prepare("SELECT mode, symbol, stop_bps, rung, why, at FROM position_floors WHERE lower(agent_id) = lower(?)")
    .all(account)) as Record<string, unknown>[];
  // WHAT THE BOOK STILL SAYS IS HELD — the same read the basis seed makes.
  const heldRows = (await shared
    .prepare("SELECT symbol FROM positions WHERE lower(agent_id) = lower(?) AND raw_balance <> '0'")
    .all(account)) as Record<string, unknown>[];
  // Postgres hands `bigint` columns back as strings; an unreadable one is null.
  const int = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  };
  const stamped: FloorSeedRow[] = floors.map((r) => ({
    mode: String(r.mode ?? ""),
    symbol: String(r.symbol ?? ""),
    stopBps: int(r.stop_bps) ?? Number.NaN,
    rung: String(r.rung ?? ""),
    why: String(r.why ?? ""),
    at: int(r.at),
  }));
  return child.tx(async (db) => {
    const have = (await db.prepare("SELECT COUNT(*) AS n FROM position_floors").get()) as { n: number } | undefined;
    const plan = planFloorSeed({
      childRowCount: Number(have?.n ?? 0),
      heldSymbols: heldRows.map((r) => String(r.symbol ?? "")),
      shared: stamped,
    });
    for (const f of plan.rows) {
      // ON CONFLICT DO NOTHING, as setPositionFloor: first write wins, for ever.
      await db
        .prepare(
          `INSERT INTO position_floors (agent_id, mode, symbol, stop_bps, rung, why, at)
           VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, unixepoch()))
           ON CONFLICT(agent_id, mode, symbol) DO NOTHING`,
        )
        .run(account, f.mode, f.symbol, f.stopBps, f.rung, f.why, f.at);
    }
    return plan;
  });
}
