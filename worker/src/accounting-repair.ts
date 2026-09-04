/**
 * THE MUTATION. Read-only unless explicitly told otherwise, and ordered so that
 * a failure anywhere leaves the ledger no worse than it found it.
 *
 * The order is the design. For each account:
 *
 *   1. INSERT the evidence-backed chain-log rows.
 *   2. VERIFY they landed and match the proposal exactly.
 *   3. ONLY THEN quarantine the legacy inferred rows.
 *   4. Recompute the contribution state.
 *   5. Recompute PortfolioQuality.
 *
 * Backwards there is a window in which an account has no contribution record at
 * all, and anything reading it in that window publishes the owner's principal as
 * profit — the same failure that made the phantom contribution and the phantom
 * high-water mark inseparable. If step 1 or 2 fails, step 3 does not run for
 * that account and nothing is quarantined.
 *
 * ONE TRANSACTION PER ACCOUNT, not one for the fleet. Twenty-four accounts in a
 * single transaction means one bad row rolls back twenty-three good repairs, and
 * holds a write lock on the ledger the whole fleet is mirroring into. Per-account
 * also makes `--resume` meaningful: an account either completed or did not.
 *
 * NOTHING IS EVER DELETED. Legacy rows are MOVED to `flows_quarantine` with
 * everything needed to put them back, plus the run that moved them and what
 * replaced them. A wrong row is evidence of a bug and the only remaining record
 * of what the fleet believed while it was live.
 */
import type { Db } from "./db";
import type { AccountPlan, ProposedFlowRow } from "./accounting-reconstruction";

export type RepairMode = "dry-run" | "verify-only" | "commit";

export interface RepairOptions {
  /** DRY RUN IS THE DEFAULT. Mutation requires saying so. */
  mode: RepairMode;
  /** Limit to one smart account. The canary goes first, alone. */
  account?: string;
  /** Groups every row this run moved, so one run can be undone as a unit. */
  runId: string;
  /**
   * Skip accounts a previous run already finished.
   *
   * Detected from the data rather than from a checkpoint file: an account whose
   * chain-log rows are all present and whose inferred rows are all gone is done,
   * whatever any bookkeeping says.
   */
  resume: boolean;
}

export type RepairStage =
  | "skipped-not-selected"
  | "skipped-nothing-to-do"
  /** A dry run that WOULD have mutated. Distinct from nothing-to-do, because a
   *  preview that reports "nothing to do" over a pending repair is the one line
   *  an operator would read as permission to skip reading the rest. */
  | "would-mutate"
  | "skipped-blocked"
  | "already-repaired"
  | "verified"
  | "inserted"
  | "quarantined"
  | "recomputed"
  | "failed";

export interface AccountRepairResult {
  account: string;
  stage: RepairStage;
  inserted: number;
  /** Rows the insert skipped because the unique index already held them. */
  insertsAlreadyPresent: number;
  quarantined: number;
  contributionsBeforeUsdg: number;
  contributionsAfterUsdg: number;
  contributionsKnownAfter: boolean;
  why: string;
}

const num = (v: unknown): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Money compared as integers. A float equality test on USDG is not a check. */
const microOf = (usdg: number) => BigInt(Math.round(usdg * 1e6));

/**
 * Verify that the rows the chain says should exist DO exist, exactly.
 *
 * Read back rather than trusting the insert's rowcount: `ON CONFLICT DO NOTHING`
 * reports zero for a row that was already correct AND for a row that collided
 * with something different, and those are opposite facts. The only way to know
 * which happened is to look at what is actually there.
 *
 * KEYS MATCH EXACTLY, never through LOWER(). `agents.smart_account` is a TEXT
 * PRIMARY KEY and every write in store.ts keys off it with `= ?`, so a repair
 * that looked rows up case-insensitively would verify against rows the worker
 * will never read — and, worse, the unique index is over the raw column, so
 * inserting under a different casing than the one already stored would slip past
 * the constraint and double the deposit. The plan's account string comes from
 * that column, which is what makes this deterministic across runs.
 */
async function verifyInserted(
  db: Db,
  account: string,
  chainId: number,
  expected: readonly ProposedFlowRow[],
): Promise<{ ok: boolean; why: string; present: number }> {
  let present = 0;
  for (const r of expected) {
    const row = (await db
      .prepare(
        `SELECT direction, amount_usdg, source, block_number FROM flows
          WHERE chain_id = ? AND agent_id = ? AND tx_hash = ? AND log_index = ?`,
      )
      .get(chainId, account, r.txHash, r.logIndex)) as
      | { direction: string; amount_usdg: number; source: string; block_number: number }
      | undefined;

    if (!row) {
      return { ok: false, why: `expected chain-log row ${r.txHash}#${r.logIndex} is not in the ledger`, present };
    }
    if (row.direction !== r.direction) {
      return {
        ok: false,
        why: `${r.txHash}#${r.logIndex} is recorded ${row.direction}, the chain says ${r.direction}`,
        present,
      };
    }
    if (microOf(num(row.amount_usdg)) !== microOf(r.amountUsdg)) {
      return {
        ok: false,
        why:
          `${r.txHash}#${r.logIndex} is recorded ${num(row.amount_usdg).toFixed(6)}, the chain says ` +
          `${r.amountUsdg.toFixed(6)}`,
        present,
      };
    }
    if (String(row.source) !== "chain-log") {
      return { ok: false, why: `${r.txHash}#${r.logIndex} is source '${row.source}', not chain-log`, present };
    }
    present += 1;
  }
  return { ok: true, why: `${present} chain-log row(s) verified against the chain`, present };
}

/**
 * Repair one account. The whole ordered sequence, in one transaction.
 *
 * `mode` decides how far it goes: `dry-run` stops before touching anything,
 * `verify-only` checks what is already there and reports, `commit` performs the
 * sequence. There is no mode that quarantines without inserting first.
 */
export async function repairAccount(
  db: Db,
  plan: AccountPlan,
  opts: RepairOptions,
  chainId: number,
): Promise<AccountRepairResult> {
  const base: AccountRepairResult = {
    account: plan.smartAccount,
    stage: "skipped-nothing-to-do",
    inserted: 0,
    insertsAlreadyPresent: 0,
    quarantined: 0,
    contributionsBeforeUsdg: plan.existingTotalUsdg,
    contributionsAfterUsdg: plan.existingTotalUsdg,
    contributionsKnownAfter: false,
    why: "",
  };

  if (opts.account && opts.account.toLowerCase() !== plan.smartAccount.toLowerCase()) {
    return { ...base, stage: "skipped-not-selected", why: "not the selected account" };
  }
  if (plan.blocked) {
    // A blocked account is not a failure — it is the tool declining to guess.
    return { ...base, stage: "skipped-blocked", why: plan.blocked };
  }
  if (plan.insert.length === 0 && plan.quarantine.length === 0) {
    return { ...base, stage: "skipped-nothing-to-do", why: "the ledger already matches the chain" };
  }

  if (opts.mode === "verify-only") {
    const v = await verifyInserted(db, plan.smartAccount, chainId, plan.insert);
    return {
      ...base,
      stage: v.ok ? "verified" : "failed",
      insertsAlreadyPresent: v.present,
      why: v.why,
    };
  }

  if (opts.mode === "dry-run") {
    return {
      ...base,
      stage: "would-mutate",
      contributionsAfterUsdg: plan.contributionsAfterUsdg,
      contributionsKnownAfter: plan.contributionsKnownAfter,
      why: `dry run: would insert ${plan.insert.length} and quarantine ${plan.quarantine.length}`,
    };
  }

  // RESUME reads the data, not a checkpoint. An account whose chain-log rows are
  // all present and whose inferred rows are all gone is finished, whatever any
  // bookkeeping thinks.
  if (opts.resume) {
    const v = await verifyInserted(db, plan.smartAccount, chainId, plan.insert);
    if (v.ok && plan.quarantine.length === 0) {
      return { ...base, stage: "already-repaired", insertsAlreadyPresent: v.present, why: "nothing left to do" };
    }
  }

  const now = Math.floor(Date.now() / 1000);
  try {
    return await db.tx(async (tx) => {
      // ── 1. INSERT ────────────────────────────────────────────────────────
      //
      // ON CONFLICT DO NOTHING against the partial unique index makes a re-run a
      // no-op rather than a doubled deposit. The index is the guarantee; this
      // clause only decides how the collision is reported.
      let inserted = 0;
      for (const r of plan.insert) {
        const res = await tx
          .prepare(
            `INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, chain_id)
             VALUES (?, ?, ?, ?, ?, ?, 'chain-log', ?, ?)
             ON CONFLICT DO NOTHING`,
          )
          .run(r.agentId, r.direction, r.amountUsdg, r.txHash, r.blockNumber, r.logIndex, r.epoch, chainId);
        if (num((res as { changes?: number }).changes) > 0) inserted += 1;
      }

      // ── 2. VERIFY, before anything is taken away ─────────────────────────
      const v = await verifyInserted(tx, plan.smartAccount, chainId, plan.insert);
      if (!v.ok) {
        // Throwing rolls the transaction back, so the inserts go too. Nothing
        // was quarantined, which is the property that matters.
        throw new Error(`evidence verification failed — nothing quarantined: ${v.why}`);
      }

      // ── 3. QUARANTINE, never delete ──────────────────────────────────────
      const replacedBy = plan.insert.map((r) => `${r.txHash}#${r.logIndex}`).join(",") || null;
      let quarantined = 0;
      for (const q of plan.quarantine) {
        const moved = await tx
          .prepare(
            `INSERT INTO flows_quarantine
               (original_id, agent_id, epoch, direction, amount_usdg, tx_hash, block_number, log_index,
                source, at, run_id, quarantined_at, reason, replaced_by)
             SELECT id, agent_id, epoch, direction, amount_usdg, tx_hash, block_number, log_index,
                    source, at, ?, ?, ?, ?
               FROM flows WHERE id = ?`,
          )
          .run(opts.runId, now, q.reason, replacedBy, q.id);
        if (num((moved as { changes?: number }).changes) === 0) continue; // already moved by a prior run
        await tx.prepare("DELETE FROM flows WHERE id = ?").run(q.id);
        quarantined += 1;
      }

      // ── 4. RECOMPUTE the contribution state ──────────────────────────────
      const after = (await tx
        .prepare(
          `SELECT COUNT(*) AS n,
                  COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END), 0) AS net,
                  SUM(CASE WHEN source IN ('chain-log','epoch-carry') THEN 0 ELSE 1 END) AS unevidenced
             FROM flows WHERE agent_id = ? AND epoch = ?`,
        )
        .get(plan.smartAccount, plan.epoch)) as
        | { n: number; net: number; unevidenced: number | null }
        | undefined;

      // THE PREVIEW HAS TO PREDICT THE MUTATION, or it is not a preview.
      //
      // An earlier draft recomputed this from scratch here (`rows > 0 && no
      // unevidenced rows`) and got a DIFFERENT answer from the planner for every
      // paper account: the planner says a complete, unambiguous scan finding no
      // capital is knowledge — that account contributed exactly nothing — while
      // counting rows says an empty table is ignorance. Both readings are
      // defensible; having two of them is not. The planner's is authoritative
      // because it is what the operator approved, and the database check narrows
      // it: scan quality from the plan, row evidence from what is actually there.
      const known = plan.contributionsKnownAfter && num(after?.unevidenced) === 0;

      // WHAT THE PLAN PREDICTED vs WHAT THE LEDGER NOW SAYS. A disagreement
      // means the table held something the preview never saw — a row written
      // between preview and commit, a second epoch, a mirror pass landing
      // mid-repair — and the operator approved the preview, not this. Roll back
      // and say so rather than leaving a figure nobody signed off on.
      if (microOf(num(after?.net)) !== microOf(plan.contributionsAfterUsdg)) {
        throw new Error(
          `the preview predicted contributions ${plan.contributionsAfterUsdg.toFixed(6)} but the ledger now ` +
            `computes ${num(after?.net).toFixed(6)} — the table changed since the plan was built`,
        );
      }

      // ── 5. RECOMPUTE PortfolioQuality ────────────────────────────────────
      //
      // Written here rather than left for the worker's next tick, because
      // between the two the web would publish a percentage over a denominator
      // that just changed underneath it.
      await tx
        .prepare(
          "UPDATE agents SET contributions_known = ?, contributions_why = ?, quality_at = ? WHERE smart_account = ?",
        )
        .run(
          known ? 1 : 0,
          known
            ? `repaired from chain evidence in run ${opts.runId}: every flow is a receipt`
            : `repaired in run ${opts.runId}, but ${num(after?.unevidenced)} flow(s) still carry no evidence`,
          now,
          plan.smartAccount,
        );

      return {
        ...base,
        stage: "recomputed" as RepairStage,
        inserted,
        insertsAlreadyPresent: v.present - inserted,
        quarantined,
        contributionsAfterUsdg: num(after?.net),
        contributionsKnownAfter: known,
        why: `inserted ${inserted}, quarantined ${quarantined}, contributions now ${num(after?.net).toFixed(6)}`,
      };
    });
  } catch (e) {
    return { ...base, stage: "failed", why: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Read the modes off an environment. PURE, so the default can be tested rather
 * than trusted.
 *
 * DEFAULT IS READ-ONLY AND THERE IS NO ARRANGEMENT OF FLAGS THAT MAKES MUTATION
 * IMPLICIT. `--commit` is spelled out as its own variable set to the exact word
 * `commit`; a typo, a `1`, a `true` or an empty string all land on `dry-run`.
 *
 * Environment rather than argv because this runs INSIDE the orchestrator: the
 * shared Postgres is on Railway's private network with no public proxy, so
 * nothing on a laptop can reach it and a command-line tool would have nothing to
 * connect to. The variable names mirror the flags one-for-one so the two
 * descriptions of this tool never drift apart:
 *
 *   MERRYMEN_REPAIR=dry-run|verify-only|commit   --dry-run / --verify-only / --commit
 *   MERRYMEN_REPAIR_ACCOUNT=0x…                  --account <smartAccount>
 *   MERRYMEN_REPAIR_RUN_ID=…                     --run-id
 *   MERRYMEN_REPAIR_RESUME=1                     --resume
 */
export function parseRepairOptions(env: Record<string, string | undefined>, now = Date.now()): RepairOptions | null {
  const raw = (env.MERRYMEN_REPAIR ?? "").trim().toLowerCase();
  if (!raw) return null;
  const mode: RepairMode = raw === "commit" ? "commit" : raw === "verify-only" ? "verify-only" : "dry-run";
  const account = (env.MERRYMEN_REPAIR_ACCOUNT ?? "").trim() || undefined;
  return {
    mode,
    account,
    // A generated id is timestamped rather than random so the run that moved a
    // row can be placed in time from the quarantine table alone.
    runId: (env.MERRYMEN_REPAIR_RUN_ID ?? "").trim() || `run-${new Date(now).toISOString().replace(/[:.]/g, "-")}`,
    resume: (env.MERRYMEN_REPAIR_RESUME ?? "") === "1",
  };
}

/**
 * Is the uniqueness constraint actually there?
 *
 * ASKED RATHER THAN ASSUMED, because the whole idempotency claim rests on it and
 * the DDL that creates it runs inside a swallowing try/catch — one that exists
 * for a good reason (re-running ALTERs must be a no-op) but which means a failed
 * index creation is indistinguishable from a successful one at every later call
 * site. If the normalisation migration ahead of it left two rows naming the same
 * log, the CREATE fails, nothing says so, and `ON CONFLICT DO NOTHING` quietly
 * becomes `INSERT` — turning the repair into the duplication it exists to undo.
 *
 * Read-only, and asked in both dialects because the seam does not expose which
 * engine is underneath and this is metadata rather than a translatable query.
 */
export async function hasChainIdentityIndex(db: Db): Promise<boolean> {
  for (const sql of [
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'flows_chain_identity'",
    "SELECT indexname AS name FROM pg_indexes WHERE indexname = 'flows_chain_identity'",
  ]) {
    try {
      if (await db.prepare(sql).get()) return true;
    } catch {
      // the other engine's catalogue — try the next dialect
    }
  }
  return false;
}

/**
 * Walk the plans in order, one account at a time.
 *
 * STOPS ON THE FIRST FAILURE by default. Twenty-three further mutations after
 * the first account failed for a reason nobody has read yet is not throughput,
 * it is a bigger incident; the accounts already done are committed and the rest
 * are untouched, which is exactly the state `--resume` is built to continue from.
 */
export async function runRepair(
  db: Db,
  plans: readonly AccountPlan[],
  opts: RepairOptions,
  chainId: number,
  onResult?: (r: AccountRepairResult) => void,
): Promise<AccountRepairResult[]> {
  const out: AccountRepairResult[] = [];

  // NO CONSTRAINT, NO MUTATION. Without the index the tool's uniqueness
  // guarantee is an application-side check across a network — which is exactly
  // what the requirement rules out — so it refuses rather than proceeding on a
  // promise it cannot keep. A dry run is still allowed: it writes nothing.
  if (opts.mode === "commit" && !(await hasChainIdentityIndex(db))) {
    return [
      {
        account: "*",
        stage: "failed",
        inserted: 0,
        insertsAlreadyPresent: 0,
        quarantined: 0,
        contributionsBeforeUsdg: 0,
        contributionsAfterUsdg: 0,
        contributionsKnownAfter: false,
        why:
          "the flows_chain_identity unique index is not present — a duplicate chain-log row could not be " +
          "prevented by the database, so nothing will be written",
      },
    ];
  }

  for (const plan of plans) {
    const r = await repairAccount(db, plan, opts, chainId);
    out.push(r);
    onResult?.(r);
    if (r.stage === "failed") break;
  }
  return out;
}

/** One line per account, self-contained so log reordering cannot scramble it. */
export function repairLines(runId: string, mode: RepairMode, results: readonly AccountRepairResult[]): string[] {
  const L = [
    `REPAIR run ${runId} mode ${mode} · ${results.length} account(s) · ` +
      `inserted ${results.reduce((s, r) => s + r.inserted, 0)} · ` +
      `quarantined ${results.reduce((s, r) => s + r.quarantined, 0)} · ` +
      `failed ${results.filter((r) => r.stage === "failed").length}`,
  ];
  for (const r of results) {
    if (r.stage === "skipped-not-selected") continue;
    L.push(
      `${r.account.slice(0, 10)} ${r.stage} · insert ${r.inserted} (present ${r.insertsAlreadyPresent}) · ` +
        `quarantine ${r.quarantined} · contributions ${r.contributionsBeforeUsdg.toFixed(6)} -> ` +
        `${r.contributionsAfterUsdg.toFixed(6)} · known ${r.contributionsKnownAfter} · ${r.why}`,
    );
  }
  return L;
}
