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
 * The mutation that consumes these plans lands separately, and until it does
 * this build cannot repair anything at all — which is what `parsePreviewRequest`
 * says out loud when it is asked to.
 */
import type { AccountPlan } from "./accounting-reconstruction";

/**
 * WHERE EACH TENANT LANDED. Three arms, closed, and every account gets exactly
 * one — the report is meant to be read as "all 24 are accounted for", which it
 * cannot be if an account can fall through.
 */
export type RosterOutcome = "NO-CHAIN-HISTORY" | "EVIDENCE-BACKED-REPAIR" | "BLOCKED-AMBIGUOUS";

export type PreviewRequest =
  /** A dry run was asked for. There is no other kind in this build. */
  | { kind: "preview"; account: string | null; runId: string }
  /**
   * Something this build cannot do was asked for.
   *
   * A DISTINCT ARM RATHER THAN A SILENT DOWNGRADE. Quietly turning
   * `MERRYMEN_REPAIR=commit` into a dry run would leave an operator reading a
   * preview while believing they had repaired production — the same class of
   * confident-wrong-state this whole effort is about. It refuses and says why.
   */
  | { kind: "refused"; why: string };

/**
 * Read the request off an environment. PURE.
 *
 * Environment rather than argv because this runs INSIDE the orchestrator: the
 * shared Postgres is on Railway's private network with no public proxy, so
 * nothing on a laptop can reach it and a command-line tool would have nothing to
 * connect to. The variable names mirror the eventual flags one-for-one:
 *
 *   MERRYMEN_REPAIR=dry-run              --dry-run   (the only mode here)
 *   MERRYMEN_REPAIR_ACCOUNT=0x…          --account <smartAccount>
 *   MERRYMEN_REPAIR_RUN_ID=…             --run-id
 */
export function parsePreviewRequest(
  env: Record<string, string | undefined>,
  now = 0,
): PreviewRequest | null {
  const raw = (env.MERRYMEN_REPAIR ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw !== "dry-run") {
    return {
      kind: "refused",
      why:
        `MERRYMEN_REPAIR=${raw} asks for something this build does not contain. There is no mutation path ` +
        `here at all — no INSERT, no UPDATE, no DELETE — so nothing was written and nothing was previewed. ` +
        `Use dry-run.`,
    };
  }
  return {
    kind: "preview",
    account: (env.MERRYMEN_REPAIR_ACCOUNT ?? "").trim() || null,
    // Timestamped rather than random so a preview can be placed in time from its
    // own log line. `now` is injected because a pure function may not read a clock.
    runId: (env.MERRYMEN_REPAIR_RUN_ID ?? "").trim() || `run-${new Date(now).toISOString().replace(/[:.]/g, "-")}`,
  };
}

/** Which of the three outcomes this account falls into. Total over every plan. */
export function rosterOutcome(plan: AccountPlan): RosterOutcome {
  // BLOCKED FIRST. An account the classifier could not resolve must not be
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
export function previewAccount(plan: AccountPlan, selectedAccount: string | null): AccountPreview {
  let grossIn = 0;
  let grossOut = 0;
  for (const r of plan.insert) {
    if (r.direction === "in") grossIn += r.amountUsdg;
    else grossOut += r.amountUsdg;
  }
  return {
    account: plan.smartAccount,
    tenant: plan.tenant,
    outcome: rosterOutcome(plan),
    selected: !selectedAccount || selectedAccount.toLowerCase() === plan.smartAccount.toLowerCase(),
    isPaper: plan.isPaper,
    epoch: plan.epoch,
    inserts: plan.insert.length,
    quarantines: plan.quarantine.length,
    contributionsBeforeUsdg: round6(plan.existingTotalUsdg),
    contributionsAfterUsdg: round6(plan.contributionsAfterUsdg),
    contributionsKnownBefore: plan.contributionsKnownBefore,
    contributionsKnownAfter: plan.contributionsKnownAfter,
    grossContributionsAfterUsdg: round6(grossIn),
    grossWithdrawalsAfterUsdg: round6(grossOut),
    blocked: plan.blocked,
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
      `BLOCKED-AMBIGUOUS ${tally["BLOCKED-AMBIGUOUS"]}`,
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
  req: { account: string | null },
): AccountPreview[] {
  return plans.map((p) => previewAccount(p, req.account));
}
