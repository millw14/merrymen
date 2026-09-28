/**
 * DERIVING A CHILD'S ACCOUNTING ANCHOR FROM THE DURABLE DATABASE.
 *
 * The child cannot do this. `CHILD_SECRET_STRIP` removes `DATABASE_URL`
 * precisely so that one compromised tenant cannot read every other tenant's
 * ledger, and that isolation is not up for renegotiation to fix an accounting
 * bug. So the parent — which already holds the URL, already supervises every
 * child, and already writes three other private files into each child's home —
 * reads Postgres and hands down a summary.
 *
 * WHY POSTGRES RATHER THAN THE CHILD'S OWN SQLITE. Because the child's SQLite
 * is the thing that keeps disappearing. Reading the anchor out of the directory
 * a redeploy just emptied would produce a confident anchor full of zeroes,
 * which is the original bug wearing a new hat. The mirror has been carrying
 * `flows`, `equity`, `fee_accruals` and the `agents` row (with `hwm_usdg` and
 * `epoch`) up to Postgres all along; that copy is what survives a container.
 *
 * THE THREE ANSWERS ARE NOT INTERCHANGEABLE, and this file's whole job is to
 * keep them apart:
 *
 *   established         durable rows exist — resume from them
 *   no-prior-accounting the query SUCCEEDED and found nothing at all
 *   unknown             the query did not succeed
 *
 * The middle one is the only thing that licenses an opening-balance
 * contribution, and it is a positive finding, not a default. A database that
 * threw must never look like a database that answered "empty" — that
 * substitution is exactly how a redeploy came to be recorded as a deposit.
 */
import type { Db } from "./db";
import { bigintToMicro, type BootstrapAccounting } from "./bootstrap-state";
import { reconcileEpochCarry } from "./accounting-scope";

/**
 * USDG REAL (as the ledger stores it) to micro-USDG bigint.
 *
 * The rounding is real and worth naming: the durable columns are SQLite REAL /
 * Postgres double precision, so six decimal places is already the most that can
 * be recovered from them. Rounding at the boundary is lossless with respect to
 * what is actually stored, and it is where the loss stops — everything
 * downstream of the anchor is integer.
 */
export function usdgRealToMicro(v: number): bigint {
  if (!Number.isFinite(v)) return 0n;
  return BigInt(Math.round(v * 1e6));
}

interface AgentRow {
  hwm_usdg: number | string | null;
  /**
   * Σ withdrawals that have already taken the peak down (store.ts).
   *
   * Carried into the anchor so a child STARTS from the durable total. Seeded at
   * zero instead, a child that books a further withdrawal would report a
   * SMALLER total than the shared row already holds, and the mirror's ratchet —
   * correctly, on its own terms — would discard it. The reduction would then be
   * lost on exactly the redeploy this whole mechanism exists to survive.
   */
  hwm_withdrawn_usdg: number | string | null;
  epoch: number | string | null;
}
interface FlowAgg {
  net: number | string | null;
  n: number | string | null;
  last_at: number | string | null;
}
interface EquityRow {
  cash_usdg: number | string | null;
  /** When the cash was read: `cash_read_at`, or the row's `at` before that existed. */
  read_at: number | string | null;
}
interface CountRow {
  n: number | string | null;
}

/**
 * IS THIS THE ERROR A SHARED LEDGER FROM BEFORE `flows_held`/`cash_read_at`
 * GIVES — AND ONLY THAT?
 *
 * The orchestrator derives every anchor at spawn, and its first reconcile
 * spawns the fleet BEFORE its first mirror pass runs applyLedgerSchema on
 * shared Postgres. So on the first pass after the deploy that adds these two
 * columns, the shared `equity` table does not have them yet, the cash read
 * fails, and every child armed on that pass got an UNKNOWN anchor — no peak
 * restored, no epoch adopted, contributions unknown — for as long as it ran.
 * Measured on a Postgres built by the previous release's own boot code.
 *
 * SQLite says `no such column: cash_read_at`; Postgres says undefined_column
 * (42703) and names the column. The name is required in both, so a missing
 * `cash_usdg`, a locked file or a timeout is still a failure, never forgiven
 * (the same contract as ledger-mirror.ts missingMarkColumn).
 */
export function missingHeldColumns(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (!/\b(flows_held|cash_read_at)\b/.test(e.message)) return false;
  return /no such column/i.test(e.message) || (e as { code?: unknown }).code === "42703";
}

/**
 * The downtime cash baseline: the newest mark that was NOT held, and when its
 * cash was read. See the call site for why each half is what it is.
 *
 * On a ledger the migration has not reached, the pre-column query IS this
 * query: without the columns nothing could have flagged a row held, and no
 * row has a read time but its insert — so it reads exactly what the anchor
 * read before them, and a held mark cannot slip in through it.
 */
async function cashBaseline(shared: Db, agentId: string): Promise<EquityRow | undefined> {
  try {
    return (await shared
      .prepare(
        "SELECT cash_usdg, COALESCE(cash_read_at, at) AS read_at FROM equity " +
          "WHERE LOWER(agent_id) = ? AND COALESCE(flows_held, 0) = 0 ORDER BY at DESC, id DESC LIMIT 1",
      )
      .get(agentId)) as EquityRow | undefined;
  } catch (e) {
    if (!missingHeldColumns(e)) throw e;
    return (await shared
      .prepare("SELECT cash_usdg, at AS read_at FROM equity WHERE LOWER(agent_id) = ? ORDER BY at DESC, id DESC LIMIT 1")
      .get(agentId)) as EquityRow | undefined;
  }
}

const num = (v: number | string | null | undefined): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Read a tenant's durable accounting position.
 *
 * NEVER THROWS. Every failure becomes `{ kind: "unknown" }` carrying the reason,
 * because the caller's only alternative to a typed unknown is a `catch` that
 * decides for itself what an unavailable database means — and the entire point
 * of this change is that nothing gets to make that decision implicitly.
 */
export async function deriveBootstrapAccounting(
  shared: Db,
  /**
   * THE SMART ACCOUNT, not the tenant. They are different addresses and this
   * distinction is the whole correctness of the query.
   *
   * A tenant is the OWNER address that signed the grant; the smart account is
   * the ERC-4337 wallet it controls, and every ledger table — `agents`
   * (`smart_account`), `flows`, `equity`, `fee_accruals` (`agent_id`) — is keyed
   * on the latter. `orchestrator.ts:237` passes both to the identity store side
   * by side, which is what makes it easy to reach for the wrong one.
   *
   * Getting it wrong here does not merely return nothing. It returns nothing FOR
   * A FUNDED ACCOUNT, and "the query succeeded and found no history" is the one
   * arm that LICENSES booking the whole balance as an opening contribution — so
   * a lookup by the wrong key would have manufactured a contribution on every
   * deploy, with the parent's explicit blessing. Strictly worse than the bug
   * this file was written to fix.
   */
  smartAccount: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<BootstrapAccounting> {
  const agentId = smartAccount.toLowerCase();
  try {
    const agent = (await shared
      .prepare("SELECT hwm_usdg, hwm_withdrawn_usdg, epoch FROM agents WHERE LOWER(smart_account) = ?")
      .get(agentId)) as AgentRow | undefined;

    // Direction carries the sign and `amount_usdg` is always positive, so the
    // net has to be built in SQL rather than summed off a signed column that
    // does not exist.
    // EPOCH-SCOPED. The boundary bridges two epochs by writing the closing equity
    // of the old one as an opening balance in the new one, so a lifetime sum
    // counts the same capital twice — once as the original deposit and once as
    // the bridge derived from it. The child's own reader is epoch-scoped and so
    // is the web's; an anchor summing across every epoch would hand the child a
    // figure neither of them agrees with. See accounting-scope.ts.
    const epoch = Math.max(1, Math.trunc(num(agent?.epoch)) || 1);
    const flows = (await shared
      .prepare(
        "SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END), 0) AS net, " +
          "COUNT(*) AS n, COALESCE(MAX(at), 0) AS last_at FROM flows WHERE LOWER(agent_id) = ? AND epoch = ?",
      )
      .get(agentId, epoch)) as FlowAgg | undefined;

    // WHY THE DISTINCTION EARNS ITS KEEP. When a hosted child's SQLite is
    // rebuilt by a redeploy, the mirror finds its watermark row gone, rewinds the
    // cursor to zero (the orchestrator logs CURSOR REWOUND) and re-copies rows
    // 1..N from the reborn child. The INSERT has no ON CONFLICT and  has
    // no unique key, so the shared table accumulates the OLD rows plus whatever
    // the new incarnation wrote — including a fresh phantom opening balance.
    // Summing every row over-counts by construction. The anchor therefore reports
    // both totals and lets the licence decide.
    // EVIDENCED, not merely tx-hashed.
    //
    // `epoch-carry` has no transaction and never can: it is the closing equity
    // of the epoch just closed, bridged forward. Demanding a hash of it made
    // every agent that had ever crossed a boundary permanently unable to
    // evidence its contributions — and no future deposit scan could fix that,
    // because there is no transfer to find. It is checkable against the prior
    // epoch's own closing mark instead, which `reconcileEpochCarry` does.
    const anchored = (await shared
      .prepare(
        "SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END), 0) AS net, " +
          "COUNT(*) AS n, COALESCE(MAX(at), 0) AS last_at FROM flows " +
          "WHERE LOWER(agent_id) = ? AND epoch = ? AND " +
          "((tx_hash IS NOT NULL AND tx_hash <> '') OR source = 'epoch-carry')",
      )
      .get(agentId, epoch)) as FlowAgg | undefined;

    // The carry, if this epoch opened with one, and the mark it must match.
    const carry = (await shared
      .prepare(
        "SELECT COALESCE(SUM(amount_usdg), 0) AS net, COUNT(*) AS n, 0 AS last_at FROM flows " +
          "WHERE LOWER(agent_id) = ? AND epoch = ? AND source = 'epoch-carry' AND direction = 'in'",
      )
      .get(agentId, epoch)) as FlowAgg | undefined;
    const priorClose =
      epoch > 1
        ? ((await shared
            .prepare(
              "SELECT equity_usdg FROM equity WHERE LOWER(agent_id) = ? AND epoch = ? " +
                "ORDER BY at DESC, id DESC LIMIT 1",
            )
            .get(agentId, epoch - 1)) as { equity_usdg: number | string | null } | undefined)
        : undefined;

    // THE CASH BASELINE IS NEVER A HELD MARK. A tick whose flow look held (an
    // op the resolver may still settle was in flight) writes its row flagged
    // `flows_held` (store.ts): a true valuation, whose cash may carry that op's
    // movement. As the downtime baseline it would be shifted again by the op's
    // own settlement and read as drift. Before the flag those rows were not
    // written at all, so skipping them leaves this read where it always was —
    // without a dropped op's 26-hour hold leaving the curve a day stale.
    //
    // AND ITS TIME IS WHEN THE CASH WAS READ (`cash_read_at`), not when the row
    // was inserted at the end of that tick: an op submitted in between is not
    // in this cash, and the hosted resume's `since` must let its settlement
    // shift the baseline rather than read it as drift. Older rows fall back to
    // `at`. Aliased `read_at` so ORDER BY still means the insert.
    const equity = await cashBaseline(shared, agentId);
    // But a held mark IS a durable trace of a funded account: it must refuse the
    // new-account claim below exactly as any other mark does.
    const anyMark: unknown =
      equity ??
      (await shared.prepare("SELECT at FROM equity WHERE LOWER(agent_id) = ? ORDER BY at DESC, id DESC LIMIT 1").get(agentId));

    const accruals = (await shared
      .prepare("SELECT COUNT(*) AS n FROM fee_accruals WHERE LOWER(agent_id) = ?")
      .get(agentId)) as CountRow | undefined;

    const hwm = usdgRealToMicro(num(agent?.hwm_usdg));
    const hwmWithdrawn = usdgRealToMicro(num(agent?.hwm_withdrawn_usdg));
    const flowCount = num(flows?.n);
    const accrualCount = num(accruals?.n);
    const hasEquity = anyMark !== undefined && anyMark !== null;
    const hasCashReading = equity !== undefined && equity !== null;

    // NO PRIOR ACCOUNTING is asserted only when every durable trace is absent.
    // A zero HWM on its own is not enough — an agent can be underwater — and
    // neither is an empty flows table, because an agent funded before the flow
    // ledger existed has equity marks and no flows.
    if (hwm === 0n && flowCount === 0 && accrualCount === 0 && !hasEquity) {
      return { kind: "no-prior-accounting", observedAt: nowSec };
    }

    // The freshest durable observation this anchor rests on. Reported so a
    // consumer can see how old the underlying evidence is, separately from how
    // old the FILE is — a recently written anchor over month-old rows is a
    // different situation from a month-old file.
    const observedAt = Math.max(num(flows?.last_at), num(equity?.read_at)) || nowSec;

    let unanchoredFlows = flowCount - num(anchored?.n);

    // A CARRY THAT DOES NOT RECONCILE IS NOT EVIDENCE, so it is demoted back to
    // the unanchored count rather than quietly counted as support. The bridge is
    // only as good as its agreement with the mark it claims to carry.
    let carryNote: string | null = null;
    if (num(carry?.n) > 0) {
      const r = reconcileEpochCarry({
        openingBalanceUsdg: num(carry?.net),
        priorEpochClosingEquityUsdg: priorClose === undefined ? null : num(priorClose.equity_usdg),
      });
      if (!r.reconciles) {
        unanchoredFlows += num(carry?.n);
        carryNote = r.why;
      }
    }

    return {
      kind: "established",
      // GROSS, with the withdrawn total beside it rather than folded in. The
      // child needs both halves to keep contributing to a ratchet it did not
      // start; a single pre-netted figure cannot be added to.
      highWaterMarkUsdg: bigintToMicro(hwm),
      highWaterWithdrawnUsdg: bigintToMicro(hwmWithdrawn),
      netContributionsUsdg: bigintToMicro(usdgRealToMicro(num(flows?.net))),
      // The receipts-only total, and how many rows are NOT receipts. Together
      // they are what makes "contributions are known" a checkable claim rather
      // than an assumption about rows nobody looked at.
      anchoredContributionsUsdg: bigintToMicro(usdgRealToMicro(num(anchored?.net))),
      unanchoredFlowCount: unanchoredFlows,
      // Null rather than zero when there is no mark: "no cash reading on
      // record" and "the account held nothing" are different claims, and the
      // child branches on which one it got.
      lastObservedCashUsdg: hasCashReading ? bigintToMicro(usdgRealToMicro(num(equity?.cash_usdg))) : null,
      accountingEpoch: epoch,
      observedAt,
      ...(carryNote === null ? {} : { carryNote }),
    };
  } catch (e) {
    return {
      kind: "unknown",
      why: e instanceof Error ? e.message : String(e),
      observedAt: nowSec,
    };
  }
}
