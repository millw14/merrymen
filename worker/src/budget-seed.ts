/**
 * GIVE A REBUILT CHILD BACK ITS TRAILING DAY OF SPENDING — OR HOLD ITS NEW
 * ENTRIES UNTIL IT CAN.
 *
 * The daily caps — spend, ops, and the Telegram transfer allowance — are judged
 * against the child's OWN ledger: store.ts sums its `trades` over the trailing
 * 24h, plus every op still 'submitted'. A child whose sqlite is new (a home
 * rebuilt, replaced or archived) starts that sum from nothing, and the day it
 * already spent is somewhere it cannot see: in shared Postgres, where the
 * mirror carried it.
 *
 * The in-flight reconciler (inflight-reconcile.ts) puts part of it back at arm
 * — every SUCCESSFUL op in the last 26h of blocks — but not all of it, and not
 * faithfully:
 *
 *   - an op still 'submitted' is not in it, and the child's own predicate
 *     keeps those charged whatever their age;
 *   - an op that SETTLED inside the window but was created long before it —
 *     the window runs from observed settlement, not submission — can sit
 *     outside its block lookback;
 *   - what it does find it re-records as a bare 'swap' sized from the
 *     receipt's USDG leg, so a TRANSFER comes back as a swap and stops counting
 *     against the transfer allowance, and a curve sale into a quote asset comes
 *     back at 0;
 *   - and it is best-effort: an RPC failure at arm skips it entirely.
 *
 * Every one of those loosens a cap across a rebuild — the one unsafe direction.
 *
 * SO THE ORCHESTRATOR CARRIES THE DAY DOWN (seedBudgetForChild), before the
 * child arms, into `budget_seed` in the child's own sqlite: one row per
 * OPERATION the child's own predicate would count —
 *
 *   status IN ('landed', 'submitted')
 *   AND (status = 'submitted' OR COALESCE(budget_settled_at, created_at) > now − 24h)
 *
 * — read from shared `trades` and grouped by lower(user_op_hash). store.ts
 * adds it to every cap reader as a DURABLE INPUT, re-read on every
 * refreshBudget, so it ages out of the window on the same clock as the child's
 * own rows and is never a starting value the next refresh throws away. The
 * orchestrator opens the two databases; everything that decides lives here or
 * in store.ts, where a test can run it (budget-seed.test.ts).
 *
 * ONE OPERATION, COUNTED ONCE — AND NEVER SMALLER THAN EITHER BOOK SAYS. The
 * key is the operation hash. A seed row whose hash the child's ledger does not
 * hold counts as the seed says, on the seed's own window. One the child DOES
 * hold is the child's to time: its row carries the later facts (a revert, a
 * drop, a settlement), so once that row has stopped counting the seed adds
 * nothing. While it still counts, the seed adds only what it says ABOVE the
 * child's row, cap by cap — zero when the two agree, and exactly the transfer
 * or the curve sale the reconciler's bare copy lost when they do not. Within
 * one hash on the shared side the largest figure stands: two rows there for
 * one operation are two descriptions of it, never two operations.
 *
 * A LIVE ROW WITH NO HASH MAKES THE SEED UNKNOWN. It cannot be told apart from
 * anything the child holds, so it can be neither counted once nor left out
 * safely. The seed fails, which is the marker below.
 *
 * UNTIL A SEED EXISTS, NEW ENTRIES GET NO HEADROOM. The orchestrator writes an
 * UNRESTORED marker in the child's home BEFORE it reads anything and removes it
 * only after every seed row is in; refreshBudget reads a standing marker as a
 * spent day (holdAtCaps, below), and the transfer allowance as unreadable
 * (store.ts getTransferredTodayUsdg). The caps exempt a sale into
 * cash, so the exits a spent day leaves open stay open — a stop-loss is never
 * the thing a missing seed holds shut. The orchestrator tries again on every
 * reconcile pass while the marker stands (retryBudgetSeed) and at the next
 * spawn. A file, not a row, for the reasons energy-seed.ts gives: the failure
 * being reported may be the child's own sqlite.
 *
 * THE LIVE RAIL ONLY IS SEEDED. A paper fill carries no operation hash, so
 * there is nothing to count it once BY, and it moves no money: a rebuilt paper
 * child's practice allowance restarts from its own ledger, as it always has.
 * The HOLD is on both rails all the same (holdAtCaps says why), and a paper
 * book's marker clears on the first seed that runs, with nothing in it.
 *
 * Caps only ever tighten here. Nothing is executed, signed or replayed: a seed
 * row is a number the wall is judged against, never an operation.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAddress, isAddress } from "viem";

import type { Db } from "./db";

/**
 * The trailing day carried down from the shared ledger, one row per operation.
 *
 *   spend_usdg     the op's spend under the child's own rule, with a sale into
 *                  `cash_token` exempt (getSpentTodayUsdg's `sells`)
 *   gross_usdg     the same without that exemption, for a reader that names no
 *                  cash token, or another one — the conservative sum
 *   transfer_usdg  what it moved through the Telegram transfer allowance
 *   pending        1 while the shared row is still 'submitted': it counts
 *                  whatever its age, exactly as the child's own row would
 *   settled_at     COALESCE(budget_settled_at, created_at), the window's clock
 *
 * A child's own sqlite only: the store makes it in initSqlite and writeBudgetSeed
 * makes it before writing, and it is NOT in the ledger schema the shared
 * Postgres is migrated with — nothing there would ever write or read it.
 */
export const BUDGET_SEED_SCHEMA = `CREATE TABLE IF NOT EXISTS budget_seed (
  agent_id TEXT NOT NULL, op_hash TEXT NOT NULL,
  spend_usdg REAL NOT NULL DEFAULT 0, gross_usdg REAL NOT NULL DEFAULT 0,
  transfer_usdg REAL NOT NULL DEFAULT 0, cash_token TEXT,
  pending INTEGER NOT NULL DEFAULT 0, settled_at INTEGER NOT NULL,
  seeded_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, op_hash)
)`;

/** In the child's home, beside merrymen.db. Present = the trailing day was not put back. */
export const BUDGET_UNRESTORED_FILE = "budget-unrestored.json";

const markerIn = (home: string) => path.join(home, BUDGET_UNRESTORED_FILE);

/**
 * Does a marker stand in `home` — is the trailing day NOT known to be back?
 *
 * FAILS CLOSED. Only a marker that is not there says no; one that cannot be
 * read for any other reason says yes. One read of a small file per refresh.
 */
export function budgetUnrestored(home: string): boolean {
  try {
    readFileSync(markerIn(home));
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code !== "ENOENT";
  }
}

/** Mark the trailing day unrestored. Written whole and renamed into place, so a reader never sees half a file. */
export function markBudgetUnrestored(home: string, atSec: number): void {
  mkdirSync(home, { recursive: true });
  const tmp = `${markerIn(home)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, at: Math.floor(atSec) }), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, markerIn(home));
}

/** The trailing day is back: the caps read what the ledger and the seed say. */
export function clearBudgetUnrestored(home: string): void {
  rmSync(markerIn(home), { force: true });
}

/**
 * THE HOLD, as refreshBudget applies it to the settled halves it just read:
 * while the trailing day is not known to be back (`held`), both read at the
 * grant's own caps — no headroom for a new entry, and the exits the caps
 * already exempt (a sale into cash: the stop-loss, the take-profit) run exactly
 * as they do on a spent day.
 *
 * WHATEVER THE RAIL. The rail is re-decided from measured gas and cash during
 * the tick, AFTER the refresh, so a book read on paper can be judged live
 * moments later; a hold keyed to the rail at refresh time would let that first
 * live entry through on a fresh day. Paper loses only the practice entries of
 * an outage, and paper has nothing to seed — its marker clears on the first
 * seed that runs.
 *
 * Raised, never lowered: a half already at or over its cap stays where it is.
 * A grant with no finite op count has no ops cap to hold at — the spend half
 * already leaves a new entry nothing to spend. No grant, nothing to hold at,
 * and nothing trades. Pure, so the hold itself is what the tests run.
 */
export function holdAtCaps(
  settled: { spentUsdg: bigint; ops: number },
  limits: { dailyUsdg: bigint; maxOpsPerDay: number } | null | undefined,
  held: boolean,
): { spentUsdg: bigint; ops: number } {
  if (!held || !limits) return settled;
  return {
    spentUsdg: settled.spentUsdg < limits.dailyUsdg ? limits.dailyUsdg : settled.spentUsdg,
    ops: Number.isFinite(limits.maxOpsPerDay) && settled.ops < limits.maxOpsPerDay ? limits.maxOpsPerDay : settled.ops,
  };
}

/** One operation of the trailing day, as the shared ledger describes it. */
export interface BudgetSeedEntry {
  opHash: string;
  spendUsdg: number;
  grossUsdg: number;
  transferUsdg: number;
  pending: boolean;
  settledAt: number;
}

/** The account as written, lowercase and EIP-55 — the spellings the mirror's own seek asks for. */
function spellingsOf(account: string): [string, string, string] {
  const lower = account.toLowerCase();
  return [account, lower, isAddress(lower, { strict: false }) ? getAddress(lower) : lower];
}

/**
 * The trailing day of `account` in the SHARED ledger, one entry per operation.
 *
 * The predicate is the child's own (store.ts getOpsToday / getSpentTodayUsdg /
 * getTransferredTodayUsdg), with `nowSec` standing in for unixepoch(). Grouped
 * by lower(user_op_hash), so an op carried up twice — once by the incarnation
 * that executed it, once as a rebuilt child's reconciled copy — is one entry,
 * at the larger of the two figures and still pending if either row is.
 *
 * THROWS when a live row in the window has no hash: the seed is unknown.
 */
export async function readBudgetSeed(shared: Db, account: string, cashToken: string, nowSec: number): Promise<BudgetSeedEntry[]> {
  const rows = (await shared
    .prepare(
      `SELECT lower(user_op_hash) AS op_hash, COUNT(*) AS n,
              MAX(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) AS pending,
              MAX(COALESCE(budget_settled_at, created_at)) AS settled_at,
              MAX(CASE WHEN kind != 'vault-withdraw' THEN amount_usdg ELSE 0 END) AS gross_usdg,
              MAX(CASE WHEN kind != 'vault-withdraw'
                        AND NOT (kind IN ('swap', 'curve-trade') AND LOWER(COALESCE(buy_token, '')) = ?)
                       THEN amount_usdg ELSE 0 END) AS spend_usdg,
              MAX(CASE WHEN kind = 'transfer' THEN amount_usdg ELSE 0 END) AS transfer_usdg
         FROM trades
        WHERE agent_id IN (?, ?, ?) AND status IN ('landed', 'submitted')
          AND (status = 'submitted' OR COALESCE(budget_settled_at, created_at) > ?)
        GROUP BY lower(user_op_hash)`,
    )
    .all(cashToken.toLowerCase(), ...spellingsOf(account), Math.floor(nowSec) - 86_400)) as Record<string, unknown>[];
  const unhashed = rows.find((r) => r.op_hash === null || r.op_hash === undefined || r.op_hash === "");
  if (unhashed) {
    throw new Error(
      `${Number(unhashed.n ?? 0)} live row(s) in the trailing 24h carry no operation hash, so they cannot be told ` +
        "apart from the child's own — the trailing day is unknown",
    );
  }
  return rows.map((r) => ({
    opHash: String(r.op_hash),
    spendUsdg: Number(r.spend_usdg ?? 0),
    grossUsdg: Number(r.gross_usdg ?? 0),
    transferUsdg: Number(r.transfer_usdg ?? 0),
    pending: Number(r.pending ?? 0) === 1,
    settledAt: Number(r.settled_at ?? 0),
  }));
}

/**
 * Replace `agent`'s seed in the child's ledger with `entries`, in ONE
 * transaction: a reader sees the old seed or the new one, never half of each.
 * Replaced, not merged — the shared ledger at this moment is the newer word on
 * every operation it names, and one that has aged out has nothing to say.
 */
export async function writeBudgetSeed(local: Db, agent: string, entries: readonly BudgetSeedEntry[], cashToken: string, atSec: number): Promise<void> {
  // A child's sqlite kept from before this table existed, or one no worker has
  // opened yet: the seed runs before the child's own store has made it.
  await local.exec(BUDGET_SEED_SCHEMA);
  await local.tx(async (db) => {
    await db.prepare("DELETE FROM budget_seed WHERE lower(agent_id) = lower(?)").run(agent);
    const ins = db.prepare(
      `INSERT INTO budget_seed (agent_id, op_hash, spend_usdg, gross_usdg, transfer_usdg, cash_token, pending, settled_at, seeded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of entries) {
      await ins.run(agent, e.opHash, e.spendUsdg, e.grossUsdg, e.transferUsdg, cashToken.toLowerCase(), e.pending ? 1 : 0, e.settledAt, Math.floor(atSec));
    }
  });
}

export type BudgetSeedResult =
  | { ok: true; restored: number }
  /**
   * `marked`: the child will read the day as unrestored, so its entries have no
   * headroom. Asked of the home itself, the way the child asks it — false only
   * when no marker could be put there and none stands.
   */
  | { ok: false; why: string; marked: boolean };

/**
 * ONE SEED ATTEMPT, for one agent's child.
 *
 *   spawn — before the child arms. The marker is written FIRST, so a seed that
 *           dies half way — the process, the database, this function — leaves
 *           a child that arms with no headroom, never one that arms on an
 *           empty day.
 *   retry — a running child whose marker stands. A failure leaves it standing.
 *
 * Success writes every row, THEN clears the marker. Both databases are opened
 * through the thunks inside the try, so a ledger that will not open is a
 * failed seed like any other, never a throw into spawnChild.
 */
export async function seedBudget(i: {
  home: string;
  agent: string;
  cashToken: string;
  nowSec: number;
  when: "spawn" | "retry";
  local: () => Db;
  shared: () => Promise<Db>;
}): Promise<BudgetSeedResult> {
  let markFailure = "";
  if (i.when === "spawn") {
    try {
      markBudgetUnrestored(i.home, i.nowSec);
    } catch (m) {
      markFailure = `; the unrestored marker could not be written either (${m instanceof Error ? m.message : String(m)})`;
    }
  }
  try {
    const entries = await readBudgetSeed(await i.shared(), i.agent, i.cashToken, i.nowSec);
    await writeBudgetSeed(i.local(), i.agent, entries, i.cashToken, i.nowSec);
    // ONLY NOW, with every row in, may the child's caps read the day as known.
    clearBudgetUnrestored(i.home);
    return { ok: true, restored: entries.length };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { ok: false, why: `${why}${markFailure}`, marked: budgetUnrestored(i.home) };
  }
}
