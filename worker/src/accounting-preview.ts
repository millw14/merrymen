/**
 * WHAT A REPAIR WOULD DO. Nothing here can do it.
 *
 * READ-ONLY BY CONSTRUCTION, not by a flag. This module is never handed a `Db`,
 * imports no database type, and contains no INSERT, UPDATE or DELETE — so
 * "MERRYMEN_REPAIR=dry-run is genuinely read-only" is a property a reviewer can
 * check by reading one file, rather than a promise about how a branch is
 * exercised. A gated mutation path would need the reader to trust the gate; an
 * absent one needs nothing.
 *
 * Every figure below is computed from an `AccountPlan` the planner already
 * derived from rows the orchestrator read. The plan is the only input; there is
 * no second source of truth to disagree with.
 *
 * The mutation that consumes these plans lives in accounting-repair.ts, which
 * also owns the mode parsing — one owner, so a mode this module rendered and a
 * mode that module acted on can never be two different readings of the same
 * variable. Rendering stays here precisely because it must never be able to
 * write, whatever mode is in force.
 */
import type { AccountPlan } from "./accounting-reconstruction";

/**
 * WHERE EACH TENANT LANDED. Three arms, closed, and every account gets exactly
 * one — the report is meant to be read as "all 24 are accounted for", which it
 * cannot be if an account can fall through.
 */
export type RosterOutcome =
  | "NO-CHAIN-HISTORY"
  | "EVIDENCE-BACKED-REPAIR"
  | "BLOCKED-AMBIGUOUS"
  /**
   * NOT LOOKED AT THIS RUN — which is not the same as "has a problem".
   *
   * A scoped repair scans only the accounts it is repairing, so every other
   * account has no chain result and the planner marks it blocked. Reporting
   * that as BLOCKED-AMBIGUOUS was wrong in the way that matters: it reads as
   * "this account is in trouble" when the truth is "nobody asked about it", and
   * it dragged the already-repaired canary into the blocked column with a
   * `contributions 10.000000 -> 0.000000` line derived from evidence that was
   * never gathered. An operator reading that would think the repair had undone
   * itself.
   *
   * The roster still enumerates all 24 — the point was never that every account
   * is examined every run, it was that none disappears.
   */
  | "NOT-EXAMINED";


/**
 * Was a preview asked for at all?
 *
 * Separate from parsing it, because the caller needs the answer BEFORE it
 * decides how much else to print — and a refused request still counts as asked,
 * so the refusal is not buried under three hundred lines of something nobody
 * wanted.
 */
export function previewRequested(env: Record<string, string | undefined>): boolean {
  return (env.MERRYMEN_REPAIR ?? "").trim() !== "";
}

/** Which of the three outcomes this account falls into. Total over every plan. */
export function rosterOutcome(plan: AccountPlan, examined = true): RosterOutcome {
  // NOT EXAMINED FIRST. An account outside a scoped run's selection was never
  // scanned, so every verdict below would be an opinion about evidence nobody
  // collected.
  if (!examined) return "NOT-EXAMINED";
  // BLOCKED NEXT. An account the classifier could not resolve must not be
  // reported as a repair merely because it also has rows to insert.
  if (plan.blocked !== null) return "BLOCKED-AMBIGUOUS";
  if (plan.insert.length > 0) return "EVIDENCE-BACKED-REPAIR";
  return "NO-CHAIN-HISTORY";
}

export interface AccountPreview {
  account: string;
  tenant: string | null;
  outcome: RosterOutcome;
  /** False when --account named someone else. Still classified, never omitted. */
  selected: boolean;
  isPaper: boolean;
  epoch: number;

  inserts: number;
  quarantines: number;

  /** What the ledger holds now, and what it would hold after. Decimal USDG. */
  contributionsBeforeUsdg: number;
  contributionsAfterUsdg: number;
  contributionsKnownBefore: boolean;
  contributionsKnownAfter: boolean;

  /** Kept apart: an account funded 1010 and withdrawn 1010 nets to zero, and
   *  "no contribution ever happened" is a different and false claim. */
  grossContributionsAfterUsdg: number;
  grossWithdrawalsAfterUsdg: number;

  /** Why this account is not being mutated, when it is not. */
  blocked: string | null;
}

const round6 = (n: number) => Number(n.toFixed(6));

/** What a repair would do to one account. PURE — it is handed a plan, not a database. */
export function previewAccount(plan: AccountPlan, selected: readonly string[]): AccountPreview {
  let grossIn = 0;
  let grossOut = 0;
  for (const r of plan.insert) {
    if (r.direction === "in") grossIn += r.amountUsdg;
    else grossOut += r.amountUsdg;
  }
  const isSelected = selected.length === 0 || selected.includes(plan.smartAccount.toLowerCase());
  const outcome = rosterOutcome(plan, isSelected);
  // AN UNEXAMINED ACCOUNT REPORTS NO "AFTER". Every after-figure is computed
  // from chain evidence, and for an account nobody scanned there is none — so
  // the honest answer is the figure it already has, not a zero derived from an
  // empty scan.
  const unexamined = outcome === "NOT-EXAMINED";
  return {
    account: plan.smartAccount,
    tenant: plan.tenant,
    outcome,
    selected: isSelected,
    isPaper: plan.isPaper,
    epoch: plan.epoch,
    inserts: plan.insert.length,
    quarantines: plan.quarantine.length,
    contributionsBeforeUsdg: round6(plan.existingTotalUsdg),
    contributionsAfterUsdg: round6(unexamined ? plan.existingTotalUsdg : plan.contributionsAfterUsdg),
    contributionsKnownBefore: plan.contributionsKnownBefore,
    contributionsKnownAfter: unexamined ? plan.contributionsKnownBefore : plan.contributionsKnownAfter,
    grossContributionsAfterUsdg: round6(grossIn),
    grossWithdrawalsAfterUsdg: round6(grossOut),
    blocked: unexamined ? null : plan.blocked,
  };
}

/**
 * THE ROSTER. One line per account, and a tally that must add up to the fleet.
 *
 * Every line is self-contained and carries the account, because Railway's log
 * aggregation reorders lines from a busy service — a report whose meaning
 * depends on line order is not a report.
 */
export function rosterLines(previews: readonly AccountPreview[]): string[] {
  const L: string[] = [];
  const tally: Record<RosterOutcome, number> = {
    "NO-CHAIN-HISTORY": 0,
    "EVIDENCE-BACKED-REPAIR": 0,
    "BLOCKED-AMBIGUOUS": 0,
    "NOT-EXAMINED": 0,
  };
  for (const p of previews) {
    tally[p.outcome] += 1;
    L.push(
      `ROSTER ${p.account} tenant ${p.tenant ?? "unknown"} · ${p.outcome} · ` +
        `${p.isPaper ? "PAPER" : "LIVE"} epoch ${p.epoch} · insert ${p.inserts} quarantine ${p.quarantines} · ` +
        `contributions ${p.contributionsBeforeUsdg.toFixed(6)} -> ${p.contributionsAfterUsdg.toFixed(6)} · ` +
        `known ${p.contributionsKnownBefore} -> ${p.contributionsKnownAfter}` +
        (p.blocked ? ` · BLOCKED: ${p.blocked}` : ""),
    );
  }
  L.push(
    `ROSTER TOTAL ${previews.length} account(s) — ` +
      `NO-CHAIN-HISTORY ${tally["NO-CHAIN-HISTORY"]} · ` +
      `EVIDENCE-BACKED-REPAIR ${tally["EVIDENCE-BACKED-REPAIR"]} · ` +
      `BLOCKED-AMBIGUOUS ${tally["BLOCKED-AMBIGUOUS"]} · ` +
      `NOT-EXAMINED ${tally["NOT-EXAMINED"]}`,
  );
  return L;
}

/**
 * The four-part account preview: what the ledger says, what the chain says, what
 * would change, and what would be left.
 *
 * Tagged per line rather than emitted as a block, for the log-reordering reason
 * above — the tag is what lets the four parts be reassembled.
 */
export function accountPreviewLines(plan: AccountPlan, p: AccountPreview): string[] {
  const t = plan.smartAccount.slice(0, 10);
  const L: string[] = [`${t} ┌── PREVIEW ${plan.smartAccount} · tenant ${plan.tenant ?? "unknown"} · ${p.outcome}`];

  L.push(`${t} BEFORE`);
  // Grouped by (direction, amount) so "the same 10 USDG booked three times"
  // reads as what it is rather than as three unrelated rows.
  const groups = new Map<string, { n: number; direction: string; amount: number; source: string }>();
  for (const q of plan.quarantine) {
    const k = `${q.source}|${q.direction}|${q.amountUsdg.toFixed(6)}`;
    const g = groups.get(k);
    if (g) g.n += 1;
    else groups.set(k, { n: 1, direction: q.direction, amount: q.amountUsdg, source: q.source });
  }
  if (groups.size === 0) L.push(`${t}   no rows to remove`);
  for (const g of groups.values()) {
    L.push(
      `${t}   ${g.n} ${g.source} ${g.direction === "in" ? "inbound" : "outbound"} row(s) × ${g.amount.toFixed(6)} USDG`,
    );
  }
  L.push(`${t}   contribution total = ${p.contributionsBeforeUsdg.toFixed(6)} USDG`);
  L.push(`${t}   contributionsKnown = ${p.contributionsKnownBefore}`);

  L.push(`${t} CHAIN EVIDENCE`);
  const ins = plan.insert.filter((r) => r.direction === "in").length;
  const outs = plan.insert.filter((r) => r.direction === "out").length;
  L.push(`${t}   ${ins} external inbound = ${p.grossContributionsAfterUsdg.toFixed(6)} USDG`);
  L.push(`${t}   ${outs} external outbound = ${p.grossWithdrawalsAfterUsdg.toFixed(6)} USDG`);
  L.push(`${t}   ${plan.chainTradeLegs} router/trade leg(s) excluded from capital flows`);
  L.push(`${t}   ambiguous = ${plan.chainAmbiguous} · scan complete = ${plan.chainComplete}`);

  L.push(`${t} PROPOSED`);
  L.push(`${t}   insert ${p.inserts} chain-log contribution row(s)`);
  L.push(`${t}   quarantine ${p.quarantines} legacy row(s) — moved, never deleted`);
  if (!p.selected) L.push(`${t}   NOT SELECTED by --account: nothing would run for this tenant`);
  if (p.blocked) L.push(`${t}   BLOCKED — ${p.blocked}`);

  L.push(`${t} AFTER`);
  L.push(`${t}   gross contributions = ${p.grossContributionsAfterUsdg.toFixed(6)}`);
  L.push(`${t}   gross withdrawals = ${p.grossWithdrawalsAfterUsdg.toFixed(6)}`);
  L.push(`${t}   net contributions = ${p.contributionsAfterUsdg.toFixed(6)}`);
  L.push(`${t}   contributionsKnown = ${p.contributionsKnownAfter}`);
  L.push(`${t}   PnL publishable = ${plan.pnlPublishableAfter}`);
  L.push(`${t} └── END PREVIEW ${plan.smartAccount}`);
  return L;
}

/** Preview every account. PURE, and the fleet total is part of the answer. */
export function runPreview(
  plans: readonly AccountPlan[],
  req: { accounts: readonly string[] },
): AccountPreview[] {
  return plans.map((p) => previewAccount(p, req.accounts));
}
