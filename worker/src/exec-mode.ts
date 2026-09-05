/**
 * THE ONLY DEFINITION OF PAPER.
 *
 * There were two. `paperActive()` decided what the tick VALUED and what the
 * heartbeat REPORTED; a separate `if (!executor)` decided what the execution
 * fork actually DID. They were written at different times to answer the same
 * question, and they disagreed for every hosted tenant — because the
 * orchestrator deliberately forwards the house bundler key to every child, so
 * `executor` is never null there and the fork's paper arm was dead code.
 *
 * The fleet was therefore labelled paper, valued paper — the paper tick zeroes
 * the ETH balance — and executed live, against a gas pre-flight reading a
 * balance the paper tick had fabricated. Every intent died on `no-gas`, and not
 * one simulated fill was ever booked. `paper-mode.test.ts` was written to
 * prevent exactly this, and could not: it pinned the DEFINITION site with four
 * source regexes, and the bug was at the USE site.
 *
 * So the rule lives here, in a pure function with a seam, and both callers ask
 * it. A predicate that decides whether real money moves should be readable in
 * one screen and testable without a chain.
 *
 * TOTAL BY CONSTRUCTION. The return type has no fourth state, and the branches
 * below partition the input exactly. The old fork had a fourth state and nobody
 * noticed: with paper trading OFF, a wrong-chain or read-as-broke agent fell
 * straight through to the live rail and built a swap against a dead chain.
 * Nothing prevented that; `paper-mode.test.ts:76-80` only asserted such an
 * agent was not PAPER, never that it did not TRADE.
 */
import { TRADEABLE_CHAIN_ID } from "./preflight";

export type RefuseRule = "not-armed" | "dead-policy" | "no-executor" | "wrong-chain" | "no-cash";

export type ExecMode =
  | { mode: "paper" }
  | { mode: "refuse"; rule: RefuseRule }
  | { mode: "live" };

export interface ExecInputs {
  /** Is there an armed grant at all? */
  armed: boolean;
  /** Is there something that can sign and submit a UserOp? */
  executor: boolean;
  /** The chain the grant was signed for. */
  chainId: number;
  /**
   * The last USDG balance READ from the chain, or null if none has been.
   *
   * UNKNOWN IS NOT UNFUNDED. Null means no read has landed yet — a funded agent
   * whose balance read failed must not quietly start writing pretend fills, so
   * only a read zero counts.
   */
  cashUsdg: bigint | null;
  /**
   * Does the signature seal a policy contract with no bytecode on this chain?
   *
   * A GRANT CAN BE DEAD ON ARRIVAL, AND NOTHING DOWNSTREAM CAN TELL. Every key
   * signed before 2026-08-30 installed a rate-limit policy whose contract has
   * zero bytes on 4663 and 46630 alike. Kernel calls `checkUserOpPolicy`
   * expecting a uint256; a call to a codeless address succeeds with empty
   * returndata, so validation fails — every operation, forever.
   *
   * This is the only leg here that funding, a bundler key and a chain switch all
   * fail to fix, because a signature is frozen. It is also the only one that was
   * previously detected and then ignored: the arm path wrote one `err` and
   * carried on, so the agent armed, priced, and refused every trade for a reason
   * that named nothing.
   */
  deadPolicy: boolean;
  /** Permission to simulate. NOT a request to: it never moves a working agent. */
  paperTradingEnabled: boolean;
}

/** Could this agent put a real order on-chain right now? */
export function canTradeForReal(a: ExecInputs): boolean {
  const readAsBroke = a.cashUsdg !== null && a.cashUsdg === 0n;
  return (
    a.armed && a.executor && a.chainId === TRADEABLE_CHAIN_ID && !readAsBroke && !a.deadPolicy
  );
}

/**
 * Which rail an intent takes, and — when it takes none — which leg failed.
 *
 * The refusal names the leg because "rejected" with no reason is how the
 * original hole stayed invisible: the ledger recorded that nothing happened
 * without recording why, so an owner watching an agent do nothing had no way to
 * tell a dead chain from an empty account from a missing signer.
 */
export function execModeOf(a: ExecInputs): ExecMode {
  // Nothing to trade with and nothing to simulate for. Checked first so every
  // branch below may assume a grant exists.
  if (!a.armed) return { mode: "refuse", rule: "not-armed" };

  if (canTradeForReal(a)) return { mode: "live" };

  // Something is wrong with the live rail. Simulating is the better answer when
  // the owner has allowed it — that is the whole point of paper.
  if (a.paperTradingEnabled) return { mode: "paper" };

  // Paper is off, so say which leg failed. Ordered most-fundamental first, by
  // what the remedy costs: a dead policy is fixable ONLY by re-signing — not by
  // funding, not by a bundler key, not by switching chain — so it is named
  // ahead of all three. A missing signer cannot be fixed by funding, and a dead
  // chain cannot be fixed by either.
  if (a.deadPolicy) return { mode: "refuse", rule: "dead-policy" };
  if (!a.executor) return { mode: "refuse", rule: "no-executor" };
  if (a.chainId !== TRADEABLE_CHAIN_ID) return { mode: "refuse", rule: "wrong-chain" };
  return { mode: "refuse", rule: "no-cash" };
}
