/**
 * THE DRY RUN: what the ledger says, what the chain says, and exactly what would
 * change. Nothing here writes.
 *
 * The diagnosis established that quarantine-only is not a repair: all 363 hosted
 * flow rows are `inferred` with no transaction, so removing them leaves every
 * agent at zero contributions and the tool refuses on all of them. The rows that
 * SHOULD be there were never written, because `chain-log` has no producer in
 * production — the deposit scan defaults off.
 *
 * So a repair has two halves and an order that cannot be reversed:
 *
 *   1. INSERT the evidence-backed capital flows read off the chain.
 *   2. THEN quarantine the legacy inferred rows.
 *
 * Backwards, there is a window in which an agent has no contribution record at
 * all, and anything reading it in that window publishes the owner's principal as
 * profit. Same reason the high-water mark and the phantom contribution had to be
 * restored together rather than one at a time.
 *
 * PAPER IS NOT REAL. An account with no on-chain USDG history has contributed
 * exactly nothing, whatever its simulated book says — and the simulated book is
 * where the −59,000 / −26,000 / −7,900 USDG "contributions" came from. This
 * refuses to manufacture a real capital row from a paper balance, and says so.
 */
import type { Db } from "./db";
import { isEvidencedFlow } from "./accounting-scope";
import type { AccountCapital } from "./chain-capital";

/** A row the repair would INSERT, with the evidence that justifies it. */
export interface ProposedFlowRow {
  agentId: string;
  epoch: number;
  direction: "in" | "out";
  /** Decimal USDG, matching the column's type. The raw figure travels beside it. */
  amountUsdg: number;
  amountRaw: string;
  source: "chain-log";
  txHash: string;
  blockNumber: number;
  logIndex: number;
}

/** A row the repair would MOVE to quarantine. Never deleted. */
export interface ProposedQuarantine {
  id: number;
  direction: string;
  amountUsdg: number;
  source: string;
  reason: string;
}

export interface AccountPlan {
  smartAccount: string;
  ownerAddress: string | null;
  /** The orchestrator's key for this agent's child, which is neither of the above. */
  tenant: string | null;
  mode: string | null;
  isPaper: boolean;
  epoch: number;

  /** On-chain USDG right now, decimal. Null when the balance could not be read. */
  onchainCashUsdg: number | null;
  navUsdg: number | null;

  chainGrossInUsdg: number;
  chainGrossOutUsdg: number;
  chainNetUsdg: number;
  chainTradeLegs: number;
  chainAmbiguous: number;
  chainComplete: boolean;

  existingInferredRows: number;
  existingInferredUsdg: number;
  existingTotalUsdg: number;

  insert: ProposedFlowRow[];
  quarantine: ProposedQuarantine[];

  contributionsAfterUsdg: number;
  contributionsKnownAfter: boolean;
  pnlPublishableAfter: boolean;

  /** Set when this account must NOT be mutated. */
  blocked: string | null;
}

const num = (v: unknown): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Base units to decimal USDG. Six places, which is all the column can hold. */
const toUsdg = (raw: string): number => Number(BigInt(raw)) / 1e6;

/**
 * Build the plan. PURE with respect to the world — it takes the chain scan and
 * the database rows and decides, so the decision can be tested without either.
 */
export function planReconstruction(args: {
  agents: readonly Record<string, unknown>[];
  flows: readonly Record<string, unknown>[];
  equityByAccountEpoch: ReadonlyMap<string, number>;
  chain: ReadonlyMap<string, AccountCapital>;
  onchainCash: ReadonlyMap<string, number>;
  tenantByAccount?: ReadonlyMap<string, string>;
}): AccountPlan[] {
  const plans: AccountPlan[] = [];

  for (const a of args.agents) {
    const account = String(a.smart_account ?? "");
    const key = account.toLowerCase();
    const epoch = num(a.epoch) || 1;
    const mode = typeof a.mode === "string" ? a.mode : null;
    const cap = args.chain.get(key);

    const rows = args.flows.filter(
      (f) => String(f.agent_id ?? "").toLowerCase() === key && num(f.epoch) === epoch,
    );
    const inferredRows = rows.filter(
      (f) => !(isEvidencedFlow(String(f.source ?? "")) || (typeof f.tx_hash === "string" && f.tx_hash)),
    );
    const signed = (f: Record<string, unknown>) =>
      String(f.direction) === "in" ? num(f.amount_usdg) : -num(f.amount_usdg);

    const chainIn = cap ? toUsdg(cap.totals.grossContributionsRaw) : 0;
    const chainOut = cap ? toUsdg(cap.totals.grossWithdrawalsRaw) : 0;
    const chainNet = cap ? toUsdg(cap.totals.netContributionsRaw) : 0;
    const onchainCash = args.onchainCash.get(key) ?? null;

    // PAPER IS ITS OWN DOMAIN. An account with no on-chain USDG history has
    // contributed nothing real, and its simulated book must not be able to
    // create, alter or offset a real capital-flow record. This is where that
    // invariant is enforced for the repair; the runtime half lives in index.ts.
    const noChainHistory = !cap || cap.movements.length === 0;
    const isPaper = mode === "paper" || (noChainHistory && (onchainCash ?? 0) === 0);

    const insert: ProposedFlowRow[] = [];
    if (cap && cap.complete) {
      for (const m of cap.movements) {
        if (m.classification.kind !== "capital-in" && m.classification.kind !== "capital-out") continue;
        insert.push({
          agentId: account,
          epoch,
          direction: m.classification.kind === "capital-in" ? "in" : "out",
          amountUsdg: toUsdg(m.amountRaw),
          amountRaw: m.amountRaw,
          source: "chain-log",
          txHash: m.txHash,
          blockNumber: m.blockNumber,
          logIndex: m.logIndex,
        });
      }
    }

    const quarantine: ProposedQuarantine[] = inferredRows.map((f) => ({
      id: num(f.id),
      direction: String(f.direction),
      amountUsdg: num(f.amount_usdg),
      source: String(f.source ?? ""),
      reason:
        "inferred from a balance change, not read from a Transfer log — superseded by the chain-derived rows above",
    }));

    // WHAT WOULD BLOCK THE MUTATION. Each of these leaves the account in a state
    // the repair cannot justify, so it is skipped rather than half-corrected.
    let blocked: string | null = null;
    if (!cap) {
      blocked = "no chain scan result for this account";
    } else if (!cap.complete) {
      blocked =
        "the chain scan did not cover every window or could not read a receipt — inserting a contribution " +
        "history with holes in it would look authoritative while being incomplete";
    } else if (cap.totals.ambiguous > 0) {
      blocked = `${cap.totals.ambiguous} movement(s) could not be classified as capital or trade`;
    } else if (isPaper && insert.length === 0 && inferredRows.length > 0) {
      // Not an error — the correct outcome — but still a mutation that needs
      // saying out loud, because it takes a visible figure to zero.
      blocked = null;
    }

    const contributionsAfter = insert.reduce(
      (s, r) => s + (r.direction === "in" ? r.amountUsdg : -r.amountUsdg),
      0,
    );
    // Every surviving row is chain-log, so contributions are evidenced by
    // construction — PROVIDED the scan was complete and unambiguous.
    const known = blocked === null && cap !== undefined && cap.complete && cap.totals.ambiguous === 0;

    plans.push({
      smartAccount: account,
      ownerAddress: typeof a.owner_address === "string" ? a.owner_address : null,
      tenant: args.tenantByAccount?.get(key) ?? null,
      mode,
      isPaper,
      epoch,
      onchainCashUsdg: onchainCash,
      navUsdg: args.equityByAccountEpoch.get(`${key}#${epoch}`) ?? null,
      chainGrossInUsdg: chainIn,
      chainGrossOutUsdg: chainOut,
      chainNetUsdg: chainNet,
      chainTradeLegs: cap?.totals.tradeLegs ?? 0,
      chainAmbiguous: cap?.totals.ambiguous ?? 0,
      chainComplete: cap?.complete ?? false,
      existingInferredRows: inferredRows.length,
      existingInferredUsdg: inferredRows.reduce((s, f) => s + signed(f), 0),
      existingTotalUsdg: rows.reduce((s, f) => s + signed(f), 0),
      insert,
      quarantine,
      contributionsAfterUsdg: contributionsAfter,
      contributionsKnownAfter: known,
      // A PUBLISHABLE P&L NEEDS A DENOMINATOR, not just an evidenced one.
      //
      // This read `known && a mark exists`, and reported "PnL publishable true"
      // for the paper accounts whose contributions go to ZERO — where the honest
      // answer is that there is nothing to divide by. Production was never at
      // risk (rankPnl refuses on `contributed <= 0`), but a preview that
      // overstates what a repair unlocks is the same species of confident wrong
      // number as the rows it is proposing to remove.
      pnlPublishableAfter:
        known && contributionsAfter > 0 && (args.equityByAccountEpoch.get(`${key}#${epoch}`) ?? null) !== null,
      blocked,
    });
  }

  plans.sort((a, b) => Math.abs(b.existingInferredUsdg) - Math.abs(a.existingInferredUsdg));
  return plans;
}

/**
 * Render the plan. EVERY LINE IS SELF-CONTAINED, prefixed with the account.
 *
 * Railway's log aggregation reorders lines from a busy service, and the first
 * version of this preview relied on grouping — so per-agent blocks arrived
 * interleaved and a reader could not tell which rows belonged to which account.
 * A preview whose meaning depends on line order is not a preview.
 */
export function reconstructionLines(plans: readonly AccountPlan[]): string[] {
  const L: string[] = [];
  const f = (n: number | null) => (n === null ? "unknown" : n.toFixed(6));
  const tag = (p: AccountPlan) => p.smartAccount.slice(0, 10);

  L.push(
    `PLAN summary · ${plans.length} account(s) · ` +
      `insert ${plans.reduce((s, p) => s + p.insert.length, 0)} chain-log row(s) · ` +
      `quarantine ${plans.reduce((s, p) => s + p.quarantine.length, 0)} inferred row(s) · ` +
      `blocked ${plans.filter((p) => p.blocked !== null).length}`,
  );

  for (const p of plans) {
    const t = tag(p);
    L.push(`${t} account ${p.smartAccount}`);
    L.push(`${t} owner ${p.ownerAddress ?? "unknown"} · tenant ${p.tenant ?? "unknown"}`);
    L.push(`${t} mode ${p.mode ?? "unknown"} · ${p.isPaper ? "PAPER" : "LIVE"} · epoch ${p.epoch}`);
    L.push(`${t} on-chain USDG ${f(p.onchainCashUsdg)} · NAV(ledger) ${f(p.navUsdg)}`);
    L.push(
      `${t} chain: in ${f(p.chainGrossInUsdg)} out ${f(p.chainGrossOutUsdg)} NET ${f(p.chainNetUsdg)} · ` +
        `trade legs ${p.chainTradeLegs} · ambiguous ${p.chainAmbiguous} · complete ${p.chainComplete}`,
    );
    L.push(
      `${t} ledger now: ${p.existingInferredRows} inferred row(s) worth ${f(p.existingInferredUsdg)} · ` +
        `total ${f(p.existingTotalUsdg)}`,
    );
    for (const r of p.insert) {
      L.push(
        `${t} INSERT ${r.direction} ${f(r.amountUsdg)} src chain-log tx ${r.txHash} blk ${r.blockNumber} log ${r.logIndex}`,
      );
    }
    for (const q of p.quarantine) {
      L.push(`${t} QUARANTINE id ${q.id} ${q.direction} ${f(q.amountUsdg)} src ${q.source}`);
    }
    L.push(
      `${t} AFTER: contributions ${f(p.existingTotalUsdg)} -> ${f(p.contributionsAfterUsdg)} · ` +
        `contributionsKnown ${p.contributionsKnownAfter} · PnL publishable ${p.pnlPublishableAfter}`,
    );
    if (p.blocked) L.push(`${t} BLOCKED — ${p.blocked}`);
    if (p.isPaper && p.insert.length === 0 && p.quarantine.length > 0) {
      L.push(
        `${t} NOTE paper account with no on-chain USDG history — its real contributed capital is 0, and the ` +
          `figure being removed came from its simulated book`,
      );
    }
  }
  return L;
}
