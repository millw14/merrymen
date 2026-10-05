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

// ── AND EACH RESTORED POSITION'S FLOOR ──────────────────────────────────────
//
// `position_floors` is the stop graded for a position at its own entry
// (store.ts setPositionFloor), and it dies with the child's sqlite exactly as
// `cost_basis` does. The mirror carries it up under the same rebuilt-child
// guard (ledger-mirror.ts) and, until this, nothing carried it back: every
// redeploy quietly swapped a held position's graded stop for the owner's single
// `strategistStopLossBps` — sometimes tighter, sometimes wider, never the level
// the position was entered under — and nothing said so.
//
// ONLY BESIDE A COST THIS SPAWN PUT BACK. The child keeps a floor beside a
// basis and nowhere else, and that pairing is the only thing that ever removes
// one: store.ts setBasis drops the floor when the basis goes to zero, and the
// stranded sweep (index.ts, custody.ts strandedBasisSymbols) finds what the
// chain no longer holds by walking the BASIS rows. A floor put back on its own
// would sit outside both for good, and the next entry in that symbol would
// inherit it, because setPositionFloor never overwrites — a stale and possibly
// wider stop on a new position. So a floor comes back only for a position
// whose cost the basis seed restored on this same spawn, and which the child
// holds a basis for when the floor is written. If the shared copy of either
// was stale, the sweep removes the two together on the first tick that reads
// the symbol flat.
//
// That also makes the basis seed's evidence of a rebuild the floor's: it
// writes only into a child with no live basis at all, so a child that kept its
// book is never handed a shared level it may have outlived. And when no cost
// came back — none in shared, a basis seed that failed, a cost that returns
// later by another road (the class vault's own events) — no floor does: the
// owner's own number applies, which is exactly what a redeploy did before this.

/** One stamped floor, as the shared ledger holds it under the grant's spelling. */
export interface FloorSeedRow {
  mode: string;
  symbol: string;
  stopBps: number;
  rung: string;
  why: string;
  /** When it was stamped. Null when the shared row's stamp cannot be read. */
  at: number | null;
}

/** A position whose cost the basis seed put back: the only kind a floor may follow. */
export interface RestoredBasisKey {
  mode: string;
  symbol: string;
}

export interface FloorSeedPlan {
  /** Floors to write into the child. Empty when the child already has its own. */
  rows: FloorSeedRow[];
  /** Shared floors for a restored position that were left out, and why. For the log. */
  dropped: string[];
  /** Why nothing is being written, for the operator log. Null when seeding. */
  skipped: string | null;
}

/**
 * A stop this wide fires only once the position is worth nothing, so it
 * protects nothing. The owner's own number stops here (settings.ts), but the
 * wide rung is 1.4 times it (floor-grade.ts), so a graded row can reach past.
 */
const TOTAL_LOSS_BPS = 10_000;

const floorKey = (mode: string, symbol: string) => `${mode}\u0000${symbol}`;

/**
 * Decide which floors to seed.
 *
 * - ONLY BESIDE A RESTORED COST, for the reasons above. Omitted or empty: none.
 * - A CHILD WITH FLOORS OF ITS OWN IS THE AUTHORITY ON THEM, as planBasisSeed's
 *   child is on its costs. Nothing writes a floor into a child before it arms
 *   but this, so a child that holds any did not lose its table — and the shared
 *   copy is then never newer, only possibly STALE: the mirror skips its delete
 *   while the child reads rebuilt, so a floor the child dropped on a sell can
 *   outlive it there.
 * - THE LIVE BOOK ONLY, like the basis seed beside it. It is the one rail that
 *   stamps a floor (index.ts stampFloorFor) and the one whose cost comes back;
 *   a paper floor here would follow no basis.
 * - A ROW THAT CANNOT BE READ IS DROPPED, NOT GUESSED, and so is a stop at or
 *   past a total loss. A stop of zero or less is already "no floor" to the
 *   strategist (strategy.ts falls back to the owner's number), and the owner's
 *   number is what applies in place of every row left out.
 *
 * It never writes a level the account did not already carry, and never into a
 * child that has floors of its own: it can only put a stop back, never loosen
 * one the child holds.
 */
export function planFloorSeed(args: {
  /** How many `position_floors` rows the CHILD currently holds, in any mode. */
  childRowCount: number;
  /** What SHARED holds for this agent, under the grant's own spelling. */
  shared: readonly FloorSeedRow[];
  /**
   * The positions whose cost the basis seed restored on THIS spawn and which
   * the child now holds a basis for. Omitted means none: an unknown set is not
   * a licence to restore a stop.
   */
  restored?: readonly RestoredBasisKey[];
}): FloorSeedPlan {
  const beside = new Set((args.restored ?? []).map((k) => floorKey(k.mode, k.symbol)));
  if (beside.size === 0) {
    return { rows: [], dropped: [], skipped: "no cost basis was restored on this spawn — a floor only comes back beside one" };
  }
  if (args.childRowCount > 0) {
    return { rows: [], dropped: [], skipped: `child already holds ${args.childRowCount} floor row(s)` };
  }
  if (args.shared.length === 0) {
    return { rows: [], dropped: [], skipped: "shared ledger holds no floor for this account" };
  }
  const rows: FloorSeedRow[] = [];
  const dropped: string[] = [];
  for (const r of args.shared) {
    if (r.mode !== "live" || !beside.has(floorKey(r.mode, r.symbol))) continue;
    if (!Number.isSafeInteger(r.stopBps) || r.stopBps <= 0) {
      dropped.push(`${r.mode}:${r.symbol} (no readable stop)`);
    } else if (r.stopBps >= TOTAL_LOSS_BPS) {
      dropped.push(`${r.mode}:${r.symbol} (${r.stopBps}bps — at or past a total loss)`);
    } else {
      rows.push(r);
    }
  }
  if (rows.length === 0) {
    return { rows: [], dropped, skipped: "no shared floor matches a position whose cost was restored" };
  }
  return { rows, dropped, skipped: null };
}

/** The operator line, so a restored stop is visible rather than inferred. */
export function floorSeedLine(tenant: string, plan: FloorSeedPlan): string {
  const left = plan.dropped.length > 0 ? `; not restored: ${plan.dropped.join(", ")}` : "";
  if (plan.skipped !== null) return `floor seed: ${tenant} — ${plan.skipped}${left}`;
  const what = plan.rows.map((r) => `${r.mode}:${r.symbol}=${r.stopBps}bps`).join(", ");
  return `floor seed: ${tenant} — restored ${plan.rows.length} position floor(s) from the shared ledger (${what})${left}`;
}

/**
 * Read both sides, plan, and write. The orchestrator opens the two databases
 * and passes what its basis seed wrote (seedBasisForChild); everything that
 * decides is here, where a test can run it over sqlite on both sides
 * (basis-durability.test.ts).
 *
 * THE GRANT'S OWN SPELLING, ON BOTH SIDES. The child reads its floors with
 * `agent_id = ?` against `grant.smartAccount` exactly (store.ts positionFloors,
 * ensureAgent), so that is the spelling written. And it is the only spelling
 * read: the mirror deletes and rewrites a tenant's shared floors under the
 * spelling its current child writes (ledger-mirror.ts) and never touches
 * another, so a row under any other spelling is one nothing has kept current
 * since that spelling's last incarnation — frozen, possibly from a position
 * long sold. A floor shared holds only under another spelling restores none,
 * and the owner's number applies.
 *
 * ONE TRANSACTION ON THE CHILD: its count, the basis it holds and the writes
 * together. A seed cut short must leave no floor at all rather than some, or
 * the next spawn would read the partial table as the child's own and never
 * restore the rest.
 *
 * ASKED WHETHER IT MAY STILL WRITE, before the first row and again before the
 * commit. The restores ahead of this await for seconds, and a replica that
 * lost the tenant meanwhile, or whose book a source barrier now holds, must not
 * put a row into it. A refusal before writes nothing and says why; one at the
 * end rolls the rows back and throws, so the caller says it out loud.
 */
export async function seedPositionFloors(args: {
  child: Db;
  shared: Db;
  /** `grant.smartAccount`, in its exact spelling. */
  account: string;
  /** What the basis seed wrote into this child on this spawn (see planFloorSeed). */
  restored: readonly RestoredBasisKey[];
  /** Null while this replica may still write the child's book, else why not. */
  mayWrite: () => string | null;
}): Promise<FloorSeedPlan> {
  const { child, shared, account } = args;
  const floors = (await shared
    .prepare("SELECT mode, symbol, stop_bps, rung, why, at FROM position_floors WHERE agent_id = ? AND mode = 'live'")
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
    // WHAT THE CHILD NOW HOLDS A COST FOR, under the spelling it reads by. The
    // restored set is the caller's account of what it wrote; this is the row
    // the stranded sweep will actually walk, so it is the one that decides.
    const costs = (await db
      .prepare("SELECT mode, symbol, qty_raw FROM cost_basis WHERE agent_id = ?")
      .all(account)) as Record<string, unknown>[];
    const based = new Set(
      costs
        .filter((r) => {
          try {
            return BigInt(String(r.qty_raw ?? "0")) > 0n;
          } catch {
            return false;
          }
        })
        .map((r) => floorKey(String(r.mode ?? ""), String(r.symbol ?? ""))),
    );
    const plan = planFloorSeed({
      childRowCount: Number(have?.n ?? 0),
      restored: args.restored.filter((k) => based.has(floorKey(k.mode, k.symbol))),
      shared: stamped,
    });
    if (plan.rows.length === 0) return plan;
    const refused = args.mayWrite();
    if (refused !== null) return { rows: [], dropped: plan.dropped, skipped: `nothing written — ${refused}` };
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
    // Thrown, not returned, so the transaction takes the rows back with it.
    const late = args.mayWrite();
    if (late !== null) throw new Error(`refused before commit — ${late}`);
    return plan;
  });
}
