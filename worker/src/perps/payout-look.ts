/**
 * THE PAYOUT STEP OF A LIVE TICK — payouts.ts's call order, as one function
 * with its edges injected (docs/perps.md rule 12; the
 * payout-settlement-must-be-chain-derived and margin-in-transit amendments).
 *
 * index.ts runs it once per live tick, AFTER the block-pinned balance read and
 * BEFORE the perp term and the flow look, and hands its answer to both:
 *
 *   fold     → flow-inference.ts lookAtCash / the first look: the payouts
 *              that explain cash since the baseline's block (payoutShift), or
 *              `unfoldable` — and then the look holds, never infers.
 *   transit  → rule 12b's T_in / T_out at the same block N, and whether the
 *              contract's pending balance at N agrees with them — the live
 *              perp term's in-transit figure (perps/live-term.ts) and the
 *              ratchet hold (rule 12c: pending > 0 holds). NULL when it could
 *              not be established: a book gap, never a zero.
 *   carry    → recordPayouts' carry, which the caller REPLACES its own with.
 *
 * ONE RULE FOR THE GATE (payouts.ts step 1): addressToAccountIndex(self) — on
 * chain, so it survives any wipe and a payout after the perps marker is gone
 * (a recover, a revoked grant) is still seen. 0 is the known "no Lighter
 * account": nothing to fold, nothing pending, the look is exactly the one it
 * was before perps. Unread is not 0: the fold is `unfoldable`.
 *
 * ORDER INSIDE, and why:
 *   1. the gate;
 *   2. the fold over (cursor, N] — a missing cursor or block, or a scan that did
 *      not cover the window, is `unfoldable`;
 *   3. recordPayouts — the ledger (withdraw rows `paid` oldest first in
 *      aggregate, unrequested money booked `owner` and alerted), idempotent on
 *      each payout's chain identity. A write that throws makes the fold
 *      `unfoldable` too: a payout home that the ledger still shows in transit
 *      would count once in cash and once in T_out;
 *   4. getPendingBalance(self, 3) AT N, and listOpenPerpTransfers read AFTER
 *      step 3, into payouts.ts inTransit.
 */

import { LIGHTER_ROUTE_V1 } from "../../../packages/core/src/index";
import type { PayoutFold } from "../flow-inference";
import type { ReconcileChain } from "../inflight-reconcile";
import type { PerpTransferRow } from "../store";
import {
  foldPayouts,
  inTransit,
  payoutKey,
  type CarriedPayout,
  type Payout,
  type InTransit,
  type RecordPayoutsResult,
} from "./payouts";

export interface PayoutStepDeps {
  agentId: string;
  /** The smart account: the payouts' `owner`. */
  account: `0x${string}`;
  /**
   * addressToAccountIndex(self) — 0n: no Lighter account; null: unread; else
   * the account. index.ts reads it once at arm and again after a deposit of
   * ours lands (perps/legs.ts readLighterAccountIndex).
   */
  accountIndex: bigint | null;
  /** The block the look's BASELINE cash was read at: the payout cursor. Null = none on record. */
  cursor: bigint | null;
  /** This reading's block N (the Multicall getBlockNumber beside balanceOf). Null = not pinned. */
  block: bigint | null;
  getLogs: ReconcileChain["getLogs"];
  store: {
    listOpenPerpTransfers(agentId: string, mode: "live"): Promise<PerpTransferRow[]>;
    recordPerpPayouts(agentId: string, payouts: readonly Payout[]): Promise<RecordPayoutsResult>;
  };
  /** getPendingBalance(self, 3) at block N, micro; null = unread (perps/legs.ts readLighterPendingAt). */
  pendingAt: (block: bigint) => Promise<bigint | null>;
  /** The previous step's carry (recordPayouts). */
  carry: readonly CarriedPayout[];
  log?: (m: string) => void;
}

export interface PayoutStepResult {
  fold: PayoutFold;
  /** The block N this step read to, when pinned. */
  block: bigint | null;
  /** Replace the caller's carry with this — never merge (payouts.ts). */
  carry: CarriedPayout[];
  /** What the ledger booked; null when nothing was recorded this step. */
  recorded: RecordPayoutsResult | null;
  /** T_in / T_out and the pending-balance check at N; null = could not be established (a book gap). */
  transit: InTransit | null;
  /** getPendingBalance(self, 3)@N as read; 0n with no Lighter account; null unread. */
  pendingBalanceMicro: bigint | null;
}

/**
 * ONE PAYOUT STEP. Never throws for a read or a write it could not make — each
 * becomes `unfoldable` / an unread transit, which the caller holds on. It
 * throws only on a caller bug (payouts.ts's own RangeErrors).
 */
export async function runPayoutStep(d: PayoutStepDeps): Promise<PayoutStepResult> {
  const log = d.log ?? (() => {});
  const carry = [...d.carry];
  // 1 — the gate.
  if (d.accountIndex === 0n) {
    // No Lighter account: nothing can pay it and nothing is pending. Open
    // transfers can still exist (a first deposit submitted, not yet landed —
    // not in transit), so transit is still computed, against a KNOWN zero.
    let open: PerpTransferRow[];
    try {
      open = await d.store.listOpenPerpTransfers(d.agentId, "live");
    } catch (e) {
      log(`perp transfers unreadable (${errText(e)})`);
      return { fold: { kind: "none" }, block: d.block, carry, recorded: null, transit: null, pendingBalanceMicro: 0n };
    }
    return { fold: { kind: "none" }, block: d.block, carry, recorded: null, transit: inTransit({ openTransfers: open, pendingBalanceMicro: 0n }), pendingBalanceMicro: 0n };
  }
  const unfoldable = (why: string, pending: bigint | null = null): PayoutStepResult => ({
    fold: { kind: "unfoldable", why },
    block: d.block,
    carry,
    recorded: null,
    transit: null,
    pendingBalanceMicro: pending,
  });
  if (d.accountIndex === null) return unfoldable("the agent's Lighter account index could not be read on chain");
  if (d.block === null) return unfoldable("this tick's cash read carries no block to fold payouts against");
  if (d.cursor === null) return unfoldable("the baseline cash reading carries no block, so payouts since it cannot be bounded");

  // 2 — the fold.
  const fold = await foldPayouts({
    getLogs: d.getLogs,
    proxy: LIGHTER_ROUTE_V1.proxy,
    account: d.account,
    fromBlockExclusive: d.cursor,
    toBlockInclusive: d.block,
    log,
  });
  if (!fold.complete) return unfoldable(fold.detail);

  // 3 — the ledger.
  let recorded: RecordPayoutsResult;
  try {
    recorded = await d.store.recordPerpPayouts(d.agentId, fold.payouts);
  } catch (e) {
    return unfoldable(`the payouts could not be booked (${errText(e)})`);
  }

  // 4 — transit at N, from the rows as they stand AFTER the booking.
  const pending = await d.pendingAt(d.block).catch(() => null);
  let transit: InTransit | null;
  try {
    transit = inTransit({
      openTransfers: await d.store.listOpenPerpTransfers(d.agentId, "live"),
      pendingBalanceMicro: pending,
      carriedPayoutMicro: recorded.carryMicro,
    });
  } catch (e) {
    log(`perp transfers unreadable (${errText(e)})`);
    transit = null;
  }
  return {
    fold: { kind: "folded", payouts: fold.payouts.map((p) => ({ key: payoutKey(p), amountMicro: p.amountMicro })) },
    block: d.block,
    carry: recorded.carry,
    recorded,
    transit,
    pendingBalanceMicro: pending,
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
