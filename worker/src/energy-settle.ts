/**
 * BOOKING AN ENERGY PURCHASE THAT LANDED — once, with both peaks, or not at all.
 *
 * energy-accounting.ts decides WHAT the purchase is (the USDG Transfer log that
 * left the account, classified `reserve-out`) and WHETHER the book can take it
 * (energyBookingGate). store.ts's bookCapitalFlow writes it: the flow row, its
 * journal fact and both peaks in one transaction, moving nothing on a duplicate.
 * This file is the wiring between them, lifted out of index.ts so it runs under
 * a test against a real ledger — the two callers are:
 *
 *   processIntentLocked, immediately BEFORE the landed trade row is written;
 *   resolveStrandedOps, immediately BEFORE a stranded row is settled landed.
 *
 * BEFORE, AND THAT IS THE CRASH-SAFETY. A purchase whose receipt cannot be read
 * THROWS here, so the caller leaves the op 'submitted' and the stranded-op
 * resolver asks again on its next pass — and because the peaks move only when
 * the insert inserted, asking again can never move them twice. Were the booking
 * after the landed row, a crash between the two would leave a landed purchase
 * no sweep ever books: a phantom drawdown equal to the spend, tripping the
 * breaker on money that never left the owner.
 *
 * NEVER FROM THE ORPHAN SWEEP. findOrphanOps writes rows for ops this child has
 * no record of at all — a redeploy that wiped its sqlite. Its lineage is broken
 * (the Shogun lesson in index.ts), so it books nothing; the reserve-aware
 * hwm-repair and reconstruction are the operator's repair for that case, and
 * the audit's envelope detects it.
 *
 * WHAT IT NEVER TOUCHES: the in-memory peaks and the cash baseline. A booking
 * that lowered the peak mid-tick, under a tick that had already read equity,
 * would charge a performance fee on principal and then re-ratchet the peak over
 * the withdrawal. So it says `booked`, and the caller sets capitalPeakDirty for
 * the NEXT tick to re-read the persisted peak before its book read.
 */

import { formatUnits } from "viem";
import { CASH, energyReserveTokens, isEnergyReserveToken } from "../../packages/core/src/index";
import { energyBookingGate, energyFlowFromReceipt } from "./energy-accounting";
import type { ReceiptLog } from "./fills";
import type { TradeIntent } from "./policy";
import type { CapitalBooking, FlowRow } from "./store";

const lc = (a: string | null | undefined) => (a ?? "").toLowerCase();

/**
 * THE ONE DEFINITION of "this intent buys the energy reserve": the dedicated
 * kind, or a swap whose buy leg is a reserve token (which nothing should build
 * — MERRYMEN is kept out of the watch set and refused in chat — but which would
 * still have to be booked as capital out, never as a fill, if anything did).
 */
export function isEnergyIntent(intent: TradeIntent): boolean {
  return intent.kind === "energy-buy" || (intent.kind === "swap" && isEnergyReserveToken(intent.buyToken));
}

/**
 * The same question of a LEDGER ROW, by kind OR by legs — the pre-broadcast row
 * carries both, and a row whose kind was ever rewritten must still be booked.
 */
export function isEnergyRow(row: { kind: string; sellToken?: string | null; buyToken?: string | null }): boolean {
  if (row.kind === "energy-buy") return true;
  return lc(row.sellToken) === lc(CASH.USDG as string) && isEnergyReserveToken(row.buyToken);
}

/** Everything a booking reads or writes, supplied by the caller (index.ts wires the store). */
export interface EnergySettleDeps {
  /** grant.smartAccount — EXACTLY the string the agents row was created with (bookCapitalFlow keys on it). */
  agentId: string;
  /** The account the USDG left: the same smart account. */
  account: string;
  /** grant.chainId: the flow's chain identity, and which reserve tokens count. */
  chainId: number;
  /** Is the agent on the paper rail right now? A paper book with no live record books nothing. */
  paper: boolean;
  /** The settled receipt's logs for a tx; null when the chain would not answer. */
  receiptLogs(txHash: `0x${string}`): Promise<readonly ReceiptLog[] | null>;
  /** getNetContributionsUsdg — a float, or null when nothing is on record. */
  netContributionsUsdg(): Promise<number | null>;
  /** getAgentFinancials().hwmUsdg — the lifetime effective peak. */
  lifetimePeakUsdg(): Promise<number>;
  /** getRiskPeriodPeak — the breaker's peak, or null when no risk period stands (then the lifetime peak is it). */
  breakerPeakUsdg(): Promise<number | null>;
  /** store.bookCapitalFlow. Database errors throw, and must. */
  book(flow: FlowRow & { txHash: string; blockNumber: number; logIndex: number }): Promise<CapitalBooking>;
  /** addEvent for this agent. */
  event(level: "ok" | "warn" | "err", line: string): Promise<void>;
}

export type EnergySettled =
  /** The flow is on the books and both peaks moved with it — the caller sets capitalPeakDirty. */
  | "booked"
  /** This exact flow was already booked; nothing moved. */
  | "already"
  /** The gate or the store refused; nothing moved, and the owner's feed says why. */
  | "refused"
  /** Paper with no live record: no real-capital record is written at all. */
  | "skipped"
  /** The receipt was read and it is not an energy purchase: an operator question, never retried. */
  | "not-a-purchase";

/** A floating USDG figure → raw 6dp, the way every other figure here is compared. */
const usdg6 = (v: number) => BigInt(Math.round(v * 1e6));

/**
 * Book one landed energy purchase from its receipt.
 *
 * `logs`/`blockNumber` are the executor's (the userOp's own receipt) when the
 * caller has them; otherwise, or when they cannot be read well enough to
 * decide, the receipt is re-read by hash. A receipt that still cannot be read
 * THROWS — see the header: the op must stay 'submitted'.
 */
export async function bookEnergyPurchase(
  d: EnergySettleDeps,
  p: { txHash: `0x${string}`; logs?: readonly ReceiptLog[] | null; blockNumber?: bigint | null },
): Promise<EnergySettled> {
  const read = (logs: readonly ReceiptLog[] | null | undefined) =>
    energyFlowFromReceipt({
      account: d.account,
      usdgToken: CASH.USDG as string,
      reserveTokens: energyReserveTokens(d.chainId),
      logs,
      blockNumber: p.blockNumber ?? null,
    });
  let r = read(p.logs);
  if (!r.ok && r.unreadable) {
    const again = await d.receiptLogs(p.txHash);
    if (again === null) {
      throw new Error(`energy purchase ${p.txHash.slice(0, 10)}…: the receipt could not be read — left to the resolver`);
    }
    r = read(again);
    if (!r.ok && r.unreadable) {
      throw new Error(`energy purchase ${p.txHash.slice(0, 10)}…: ${r.why} — left to the resolver`);
    }
  }
  if (!r.ok) {
    await d.event(
      "err",
      `an energy purchase landed (${p.txHash.slice(0, 10)}…) but its receipt does not read as one — ${r.why}. ` +
        `It was NOT booked as capital leaving the book; this needs an operator repair (hwm-repair / reconstruction).`,
    );
    return "not-a-purchase";
  }

  const net = await d.netContributionsUsdg();
  const lifetime = usdg6(await d.lifetimePeakUsdg());
  const risk = await d.breakerPeakUsdg();
  const gate = energyBookingGate({
    paper: d.paper,
    spendUsdg: r.amountUsdg6,
    netContributionsUsdg: net === null ? null : usdg6(net),
    lifetimePeakUsdg: lifetime,
    breakerPeakUsdg: risk === null ? lifetime : usdg6(risk),
  });
  const spent = formatUnits(r.amountUsdg6, 6);
  if (gate.action === "skip") {
    await d.event("ok", `energy purchase of ${spent} USDG not recorded as capital: ${gate.why}`);
    return "skipped";
  }
  if (gate.action === "refuse") {
    await d.event(
      "err",
      `an energy purchase of ${spent} USDG landed (${p.txHash.slice(0, 10)}…) but was not booked: ${gate.why}. ` +
        `This needs an operator repair.`,
    );
    return "refused";
  }

  const booking = await d.book({
    agentId: d.agentId,
    direction: "out",
    amountUsdg: Number(spent),
    source: "energy-buy",
    txHash: p.txHash,
    blockNumber: r.blockNumber,
    logIndex: r.logIndex,
    // EXPLICIT: this is a real on-chain spend whatever the heartbeat last
    // wrote, the same reason the transfer path passes it.
    mode: "live",
    chainId: d.chainId,
  });
  if (booking.kind === "booked") {
    await d.event(
      "ok",
      `set aside ${spent} USDG as energy — capital leaving the trading book, not a loss; your high-water mark moved with it`,
    );
    return "booked";
  }
  if (booking.kind === "already") return "already";
  await d.event("err", `an energy purchase of ${spent} USDG landed but its booking was refused: ${booking.why}`);
  return "refused";
}

/**
 * WHERE THE LAST ENERGY PURCHASE LANDED, read once at arm — the seed for the
 * buy's balance-read pin (index.ts lastEnergyLandedBlock), which otherwise
 * lived in memory only and was forgotten by every restart.
 *
 * The ledger's own block first (the purchase's energy-buy flow row); failing
 * that, the one receipt of the newest landed purchase, bounded by `timeoutMs`.
 * FAIL-SOFT TO NULL on every path — no row, a ledger that throws, a receipt the
 * chain will not return in time: the pin is a freshness floor on a read, never
 * a gate, and the in-flight guard and the planner's own refusals still stand.
 */
export async function energyLandedBlockAtArm(
  d: {
    newest(): Promise<{ txHash: string; blockNumber: number | null } | null>;
    receiptBlock(txHash: `0x${string}`): Promise<bigint | null>;
  },
  timeoutMs = 5_000,
): Promise<bigint | null> {
  try {
    const row = await d.newest();
    if (!row) return null;
    if (row.blockNumber !== null && row.blockNumber > 0) return BigInt(row.blockNumber);
    if (!/^0x[0-9a-f]{64}$/i.test(row.txHash)) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
      const block = await Promise.race([d.receiptBlock(row.txHash as `0x${string}`).catch(() => null), late]);
      return block !== null && block > 0n ? block : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/**
 * The resolver's form: book it, and say whether the row may now be settled.
 *
 * `proceed: false` means the booking could not be READ or WRITTEN — a receipt
 * the chain would not return, a ledger that threw — and the caller must
 * `continue`, leaving the row 'submitted' for its next pass. Every other
 * outcome (booked, already, refused, skipped, not-a-purchase) is a decision,
 * and the row is settled with it.
 */
export async function settleEnergyLanding(
  d: EnergySettleDeps,
  txHash: `0x${string}`,
): Promise<{ proceed: boolean; settled: EnergySettled | null; why?: string }> {
  try {
    return { proceed: true, settled: await bookEnergyPurchase(d, { txHash }) };
  } catch (e) {
    return { proceed: false, settled: null, why: e instanceof Error ? e.message : String(e) };
  }
}
