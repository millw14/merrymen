/**
 * HOW AN ENERGY PURCHASE IS BOOKED — the pure half.
 *
 * WHAT THE PURCHASE IS, IN ACCOUNTING TERMS. USDG spent buying the energy
 * reserve ($MERRYMEN) into the agent's own account is CAPITAL LEAVING THE
 * TRADING BOOK. The reserve sits outside the book the way ETH gas does — never
 * watched, never a position, never valued into equity, never sold by a strategy
 * (equity.ts) — but unlike gas it is BOUGHT and KEPT, not consumed. So it is
 * not an expense: booked as one it would show a loss equal to the spend, could
 * trip the drawdown breaker, and would have the performance fee subsidise the
 * purchase. It is booked like a withdrawal instead: an 'energy-buy' out-flow,
 * with both peaks lowered by the same amount in the same transaction
 * (store.bookCapitalFlow). Equity and the peak drop together, so P&L and the
 * drawdown against the peak are what they were — except for the one ratio that
 * genuinely changes, which the pre-trade gate below judges before any USDG moves.
 *
 * WHY THE RECEIPT, NEVER THE INTENT. The flow is the USDG Transfer log that
 * left the account in the settled receipt: its amount is what actually moved
 * (not the planner's amountIn), and its tx#logIndex is the identity that makes
 * it bookable exactly once — the same key the deposit scanner, the Postgres
 * mirror and the operator reconstruction all dedupe on. The shared classifier
 * must agree it is `reserve-out`, so the worker's booking and every chain
 * re-derivation (chain-capital, hwm-repair, reconstruction) are one rule.
 *
 * PURE. No chain, no clock, no database: the caller (index.ts) reads the
 * receipt and the ledger, and writes the result through bookCapitalFlow. Every
 * decision here is tested against hand-built receipts and books.
 */
import { classifyUsdgMovement } from "../../packages/core/src/index";
import { legsFromReceiptLogs, TRANSFER_TOPIC } from "./deposit-log";
import type { ReceiptLog } from "./fills";

export type EnergyFlowRead =
  | {
      ok: true;
      /** Raw 6dp USDG that left the account, read off the log. Always > 0. */
      amountUsdg6: bigint;
      logIndex: number;
      blockNumber: number;
    }
  | {
      ok: false;
      /**
       * TRUE when the receipt could not be READ well enough to decide — logs
       * missing, a position missing, data undecodable. The caller re-reads the
       * receipt (and, if that fails, leaves the op to be retried) rather than
       * concluding anything. FALSE when it was read and is not a reserve
       * purchase: an operator question, never retried into a different answer.
       */
      unreadable: boolean;
      why: string;
    };

/** Hex, decimal string, number or bigint to a non-negative safe integer, or null. */
function position(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  try {
    const n = typeof v === "number" ? v : Number(BigInt(v as string | bigint));
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

const topicAddress = (topic: string | undefined) => `0x${(topic ?? "").slice(-40)}`.toLowerCase();

/**
 * The energy purchase's capital flow, read off its settled receipt.
 *
 * Exactly one USDG Transfer must leave the account. More than one is refused:
 * there is no honest way to say which is the purchase (an ERC-20 paymaster
 * would do this; none is used today). That one log must carry an integer log
 * index and a block number (its own, else the receipt's), or the flow could not
 * be keyed and is `unreadable`. And the shared classifier, told the reserve
 * tokens, must call it `reserve-out` — a mixed batch, a reserve landing
 * anywhere but the account, or a route that bought something else is not an
 * energy purchase and is not booked as one.
 *
 * A block number of 0 counts as missing: the executor reports 0n when the
 * bundler omitted it, and no purchase lands in genesis.
 */
export function energyFlowFromReceipt(a: {
  account: string;
  usdgToken: string;
  reserveTokens: readonly string[];
  logs: readonly ReceiptLog[] | null | undefined;
  blockNumber?: bigint | number | null;
}): EnergyFlowRead {
  const account = a.account.toLowerCase();
  const usdg = a.usdgToken.toLowerCase();
  const logs = a.logs ?? [];

  const transfers = logs.filter(
    (l) => (l.topics?.[0] ?? "").toLowerCase() === TRANSFER_TOPIC && l.topics.length === 3,
  );
  if (transfers.length === 0) {
    // A landed swap always emits Transfers. None at all means the logs were not
    // handed over, not that nothing moved.
    return { ok: false, unreadable: true, why: "the receipt carried no Transfer logs to read the purchase from" };
  }

  const usdgOut = transfers.filter(
    (l) => (l.address ?? "").toLowerCase() === usdg && topicAddress(l.topics[1]) === account,
  );
  if (usdgOut.length === 0) {
    return { ok: false, unreadable: false, why: "no USDG left the account in this transaction" };
  }
  if (usdgOut.length > 1) {
    return {
      ok: false,
      unreadable: false,
      why: `${usdgOut.length} USDG transfers left the account in this transaction — there is no honest way to say which one bought the energy`,
    };
  }
  const log = usdgOut[0]!;

  const logIndex = position(log.logIndex);
  if (logIndex === null) {
    return { ok: false, unreadable: true, why: "the USDG log carries no log index, so the flow could not be booked exactly once" };
  }
  const own = position(log.blockNumber);
  const blockNumber = own !== null && own > 0 ? own : position(a.blockNumber);
  if (blockNumber === null || blockNumber === 0) {
    return { ok: false, unreadable: true, why: "the USDG log carries no block number, so the flow could not be anchored" };
  }

  let legs: ReturnType<typeof legsFromReceiptLogs>;
  let amountUsdg6: bigint;
  try {
    legs = legsFromReceiptLogs(logs);
    amountUsdg6 = BigInt(log.data || "0x0");
  } catch {
    return { ok: false, unreadable: true, why: "the receipt's Transfer data could not be decoded" };
  }
  if (amountUsdg6 <= 0n) {
    return { ok: false, unreadable: false, why: "the USDG leg moved nothing" };
  }

  const usdgLeg = { token: usdg, from: account, to: topicAddress(log.topics[2]), amountRaw: amountUsdg6.toString() };
  const v = classifyUsdgMovement({
    account,
    usdg: usdgLeg,
    txLegs: legs,
    usdgToken: usdg,
    reserveTokens: a.reserveTokens,
  });
  if (v.kind !== "reserve-out") {
    return {
      ok: false,
      unreadable: false,
      why: `the transaction reads as ${v.kind}, not an energy purchase — ${v.why}`,
    };
  }
  return { ok: true, amountUsdg6, logIndex, blockNumber };
}

// ── the gates ──────────────────────────────────────────────────────────────

/** Why a purchase may not be booked, and so must not be made. */
export type EnergyGateRule =
  | "book-untotalled"
  | "no-contribution-record"
  | "peak-below-spend"
  | "would-exhaust-contributions"
  | "would-trip-breaker";

export type EnergyGateVerdict =
  /** Book the flow (after landing) / go ahead (before). */
  | { action: "book" }
  /** Paper with no live contribution record: make no real-capital record at all. */
  | { action: "skip"; why: string }
  | { action: "refuse"; rule: EnergyGateRule; why: string };

const fmt = (usdg6: bigint) => (Number(usdg6) / 1e6).toFixed(2);

/**
 * The checks that hold both before the purchase and after it lands.
 *
 * NO CONTRIBUTION RECORD. With nothing on record, the energy out-flow would be
 * the account's ONLY flow — and the next redeploy's anchor would call that
 * record established, with net contributions of minus the spend, and publish
 * the whole bankroll as P&L. Live refuses; paper books nothing (a paper book
 * never reconciles flows, and a lone out-flow would split the record).
 *
 * PEAK BELOW SPEND. Both peak moves are clamped at zero (the withdrawn total at
 * the gross, the risk period's likewise), and the drawdown breaker only applies
 * while the peak is ABOVE zero — so a spend at or over the breaker's peak would
 * switch the breaker off. The lifetime peak may equal the spend (it is not the
 * breaker's divisor); the breaker's may not.
 */
function recordAndPeaks(a: {
  paper: boolean;
  spendUsdg: bigint;
  netContributionsUsdg: bigint | null;
  lifetimePeakUsdg: bigint;
  breakerPeakUsdg: bigint;
}): EnergyGateVerdict | null {
  if (a.netContributionsUsdg === null) {
    if (a.paper) {
      return {
        action: "skip",
        why: "this agent is practising on paper and has no live contribution record, so no real-capital record is written",
      };
    }
    return {
      action: "refuse",
      rule: "no-contribution-record",
      why:
        "this agent has no record of the capital put into it yet, so an energy purchase could not be told apart from " +
        "its P&L — send USDG to it (or let it record its opening balance) first, or send $MERRYMEN to its account directly",
    };
  }
  if (a.lifetimePeakUsdg < a.spendUsdg || a.breakerPeakUsdg <= a.spendUsdg) {
    return {
      action: "refuse",
      rule: "peak-below-spend",
      why:
        `spending ${fmt(a.spendUsdg)} USDG would take this agent's high-water mark (${fmt(a.breakerPeakUsdg)} USDG) to zero, ` +
        `which would switch its drawdown limit off — top up USDG first, or send $MERRYMEN to its account directly`,
    };
  }
  return null;
}

/**
 * THE LEAST CAPITAL AN ENERGY PURCHASE MAY LEAVE ON RECORD: a tenth of what is
 * on record before it, and never under 1 USDG. Everything that divides by
 * contributions (core computePnl's sizing, the board's published return) is
 * meaningless over a sliver, so a purchase that would leave less is refused.
 * Raw 6dp USDG in and out.
 */
export function contributionFloorUsdg(netContributionsUsdg: bigint): bigint {
  const tenth = netContributionsUsdg / 10n;
  return tenth > 1_000_000n ? tenth : 1_000_000n;
}

/**
 * May the agent spend `spendUsdg` of its book on energy RIGHT NOW? Called by
 * the buy planner before anything is built. All amounts raw 6dp USDG.
 *
 * Inputs, as the planner reads them: equity and equityKnown from the tick's
 * book, the breaker's peak from drawdownPeak(), the lifetime effective peak
 * from getAgentFinancials().hwmUsdg, net contributions from
 * getNetContributionsUsdg, and the grant's maxDrawdownBps.
 *
 * WOULD EXHAUST CONTRIBUTIONS. The purchase is booked as capital leaving the
 * book, so net contributions fall by the spend — and nothing else in these
 * gates compared the two. An agent funded with 20 USDG that made 30 passed
 * every check three asks running while its record went 20 → 10 → 0 → −10: at
 * zero or below, core computePnl answers 'no-capital-contributed' (the Brain
 * then holds on every decision), the leaderboard calls a profitable agent
 * 'no-deposit', and just above zero its published return is the P&L over a
 * sliver. So a spend that would leave too little contributed — under
 * contributionFloorUsdg, a tenth of what is on record and never under 1 USDG
 * — is refused before any USDG moves, and the owner is told the
 * USDG-then-buy way round it. Stopping only at zero was not enough: funded
 * 20, grown to 50, a 19 USDG ask left 1 USDG on record and the board then
 * published (50 − 19 − 1)/1 as the agent's return. Pre-trade only: once
 * money has moved the booking still books it (energy-settle.ts warns when a
 * landed purchase leaves nothing).
 *
 * WOULD TRIP THE BREAKER. The purchase is not an exit, and after it both the
 * peak and equity are lower by the spend, so the drawdown becomes
 * (P − E)/(P − s) — larger than (P − E)/P. Judged with policy.ts's own
 * inequality (floor(x·10000/y) ≥ cap ⟺ x·10000 ≥ cap·y), so the gate refuses
 * exactly the purchases after which the breaker would refuse the next buy.
 * The limit is never loosened to let a purchase through.
 */
export function energyPreTradeGate(a: {
  paper: boolean;
  equityKnown: boolean;
  equityUsdg: bigint;
  spendUsdg: bigint;
  netContributionsUsdg: bigint | null;
  lifetimePeakUsdg: bigint;
  breakerPeakUsdg: bigint;
  maxDrawdownBps: number;
}): EnergyGateVerdict {
  if (!a.equityKnown) {
    return {
      action: "refuse",
      rule: "book-untotalled",
      why: "this agent's book could not be totalled just now, so what an energy purchase would do to it is unknown — try again shortly",
    };
  }
  const early = recordAndPeaks(a);
  if (early) return early;
  // recordAndPeaks answered for a null record (refuse live, skip paper), so it
  // is a number here whenever this line is reached on the live rail.
  if (a.netContributionsUsdg !== null) {
    const net = a.netContributionsUsdg;
    const left = net - a.spendUsdg;
    const floor = contributionFloorUsdg(net);
    if (left < floor) {
      return {
        action: "refuse",
        rule: "would-exhaust-contributions",
        why:
          (left <= 0n
            ? `spending ${fmt(a.spendUsdg)} USDG on energy would use up all ${fmt(net)} USDG of capital on record ` +
              `for me, and with nothing contributed on record I can't size trades or report how I'm doing`
            : `spending ${fmt(a.spendUsdg)} USDG on energy would leave only ${fmt(left)} of the ${fmt(net)} USDG of ` +
              `capital on record for me — I keep at least ${fmt(floor)} (a tenth, and never under 1 USDG) so I can ` +
              `size trades and report how I'm doing`) +
          ` — send USDG to me first and ask again, or send $MERRYMEN to my account directly`,
      };
    }
  }
  const P = a.breakerPeakUsdg;
  if ((P - a.equityUsdg) * 10_000n >= BigInt(a.maxDrawdownBps) * (P - a.spendUsdg)) {
    const after = P - a.equityUsdg <= 0n ? 0n : ((P - a.equityUsdg) * 10_000n) / (P - a.spendUsdg);
    return {
      action: "refuse",
      rule: "would-trip-breaker",
      why:
        `spending ${fmt(a.spendUsdg)} USDG on energy would put this agent's drawdown at ${after}bps against its ` +
        `${a.maxDrawdownBps}bps limit, and the limit is not loosened for this — top up USDG first, or send $MERRYMEN ` +
        `to its account directly`,
    };
  }
  return { action: "book" };
}

/**
 * May a purchase that has ALREADY LANDED be booked? The pre-trade checks minus
 * the ones about equity: the money has moved, so "would this trip the breaker"
 * is no longer a question the booking can answer by refusing. What it still
 * must not do is write a lone out-flow on an unrecorded account or clamp a peak
 * to zero — a refusal here is an operator repair (hwm-repair, reconstruction),
 * which is strictly better than either.
 */
export function energyBookingGate(a: {
  paper: boolean;
  spendUsdg: bigint;
  netContributionsUsdg: bigint | null;
  lifetimePeakUsdg: bigint;
  breakerPeakUsdg: bigint;
}): EnergyGateVerdict {
  return recordAndPeaks(a) ?? { action: "book" };
}
