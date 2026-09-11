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

/**
 * THE RULE NAMES AND THEIR REMEDIES NOW LIVE IN CORE, and are re-exported here
 * so every existing importer is untouched.
 *
 * They moved for the reason the old comment on `liveBlockerText` already gave —
 * "the remedy is a property of the rule, and two surfaces already render this" —
 * except that the second surface, the web tier, could not import from the
 * worker and so had no way to render them at all. The result was nine owners
 * sitting in practice mode because the one thing that would fix it, a free
 * re-signature, was named only in a worker log they never see.
 *
 * `liveBlocker` itself stays here: deciding WHICH leg failed reads the worker's
 * own inputs. Naming the legs does not.
 */
export type { RefuseRule } from "../../packages/core/src/autonomy";
export { liveBlockerText } from "../../packages/core/src/autonomy";
import type { RefuseRule } from "../../packages/core/src/autonomy";

export type ExecMode =
  /**
   * WHY, EVEN HERE. `rule` is the leg that stopped the live rail, and on paper
   * it is never absent: `canTradeForReal` is asked first, so reaching this
   * branch means something blocked it.
   *
   * It used to be omitted, and that omission is what a tester ran into —
   * funded with ETH and USDG, key set, agent running, and the product saying
   * "Paper trading" with no way to find out why or any control to change it.
   * They went looking for a switch. There is no switch: paper is PERMISSION TO
   * SIMULATE, not a request to, and it never moves a working agent. The thing
   * they needed was the sentence this field carries.
   */
  | { mode: "paper"; rule: RefuseRule }
  | { mode: "refuse"; rule: RefuseRule }
  | { mode: "live" };

/**
 * What the `agents` row publishes, and therefore what the whole product shows.
 *
 * THIS EXISTS BECAUSE THE CALL SITE WORKED IT OUT AGAIN. The heartbeat used to
 * derive it as `paperActive() ? "paper" : active?.executor ? "live" : "idle"`,
 * beside the verdict rather than from it — a fifth definition of the rail in a
 * module whose whole header is about two that disagreed. And it lost a state:
 * this type has three arms and that expression had three values, but they were
 * not the same three. REFUSE had nowhere to go, so an agent with an executor
 * that refused every intent published as `live`, and the terminal, the public
 * profile and the chat prompt all believed it.
 *
 * `refuse` maps to `idle` deliberately rather than to a new fourth value.
 * "Idle" is already exactly this fact — not trading, whatever the reason — and
 * every reader handles it. WHICH reason is a separate column, `live_blocker`,
 * written on the same row from this same verdict, and that is what tells
 * not-armed apart from armed-but-broke. One fact, one source, two fields.
 */
export type PublishedMode = "paper" | "live" | "idle";

export function publishedMode(v: ExecMode): PublishedMode {
  switch (v.mode) {
    case "paper":
      return "paper";
    case "live":
      return "live";
    case "refuse":
      return "idle";
  }
}

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
  /**
   * The account's ETH, or null when it has not been read yet.
   *
   * NULL IS NOT ZERO, the same rule `cashUsdg` follows. A worker's first tick
   * has read nothing, and treating that silence as an empty tank would put
   * every agent on paper for its opening window.
   */
  gasWei: bigint | null;
  /**
   * Is somebody else paying the fee?
   *
   * A sponsored account never handles ETH — the paymaster settles with the
   * EntryPoint directly — so a zero balance says nothing about whether it can
   * trade. This term is what keeps the sponsored fleet on the live rail, and
   * dropping it is the most damaging single edit available to this file.
   */
  gasSponsored: boolean;
  /**
   * Is this grant's permission wall too wide to ever install, AND the account
   * still undeployed?
   *
   * DETERMINISTIC, AND KNOWN BEFORE ANY BUNDLER IS CONTACTED. The first
   * operation a session key signs carries the whole wall, so its cost is a
   * function of the wall's size — which the grant already fixes. When that
   * exceeds what the product will sign for, no estimate can change the answer,
   * and asking anyway is what produced ~16 bundler calls every 97 seconds,
   * forever, on two funded agents.
   *
   * ONLY MEANINGFUL WHILE UNDEPLOYED. An account whose wall is already
   * installed never signs another first-enable, so a wall that would be refused
   * today says nothing about an agent that is already trading. The caller is
   * responsible for that half — see index.ts — and getting it wrong would
   * retire working agents for a rule that cannot apply to them.
   */
  wallTooWide?: boolean;
  /** Permission to simulate. NOT a request to: it never moves a working agent. */
  paperTradingEnabled: boolean;
}

/** Could this agent put a real order on-chain right now? */
export function canTradeForReal(a: ExecInputs): boolean {
  const readAsBroke = a.cashUsdg !== null && a.cashUsdg === 0n;
  // GAS IS A LEG, and it was the one missing.
  //
  // An operation that cannot pay its fee never reaches the chain, so an account
  // with no ETH is exactly as unable to trade as one with no signer — and the
  // rule lived 2,100 lines downstream, in the gas pre-flight, AFTER the paper
  // fork had already been taken. So an armed, USDG-funded, zero-ETH agent was
  // routed live and refused every tick forever, while its owner had paper
  // selected and the product said "Paper trading". Production carried several:
  // `eth 0 · cash 1000 USDG`, refusing on `no-gas`, indefinitely.
  //
  // SPONSORSHIP FIRST. A sponsored agent trades with zero ETH by design — the
  // paymaster settles with the EntryPoint and the account never handles ETH at
  // all. Dropping this term sends every sponsored agent in the fleet to paper,
  // which is the single most dangerous thing this function could get wrong.
  //
  // And only a READ zero counts, mirroring `readAsBroke`: null is "not yet
  // observed", and unknown is not unfunded.
  const readAsGasless = !a.gasSponsored && a.gasWei !== null && a.gasWei === 0n;
  return (
    a.armed &&
    a.executor &&
    a.chainId === TRADEABLE_CHAIN_ID &&
    !readAsBroke &&
    !readAsGasless &&
    !a.deadPolicy &&
    !a.wallTooWide
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

  // Something is wrong with the live rail, and whichever answer we give — a
  // simulated fill or a refusal — the owner is owed the same sentence about
  // which leg it was. Naming it only in the refusal branch is what made paper
  // an unexplained dead end.
  const blocker = liveBlocker(a);

  // A WALL THAT CANNOT BE INSTALLED IS NOT SIMULATED EITHER.
  //
  // Every other blocker here is a condition the world might fix — money
  // arrives, a chain is switched, a bundler is configured — and simulating
  // meanwhile is exactly what paper is for. This one cannot: the grant's own
  // shape proves its first operation will never be signed, and writing
  // pretend fills against it tells the owner their agent is working while the
  // one thing that would make it work goes unsaid.
  if (blocker === "grant-too-wide") return { mode: "refuse", rule: blocker };

  // Simulating is the better answer when the owner has allowed it — that is the
  // whole point of paper.
  if (a.paperTradingEnabled) return { mode: "paper", rule: blocker };
  return { mode: "refuse", rule: blocker };
}

/**
 * Which leg of the live rail failed.
 *
 * Ordered most-fundamental first, by what the remedy costs: a dead policy is
 * fixable ONLY by re-signing — not by funding, not by a bundler key, not by
 * switching chain — so it is named ahead of all three. A missing signer cannot
 * be fixed by funding, and a dead chain cannot be fixed by either.
 *
 * Only ever called where `canTradeForReal` has already answered false, so it
 * always has something to name.
 */
export function liveBlocker(a: ExecInputs): RefuseRule {
  if (!a.armed) return "not-armed";
  if (a.deadPolicy) return "dead-policy";
  // Beside dead-policy because the remedy is the same shape — only the owner can
  // fix it — but it is NARROWER: re-signing the same wall changes nothing, so
  // the owner has to sign a smaller one.
  if (a.wallTooWide) return "grant-too-wide";
  if (!a.executor) return "no-executor";
  if (a.chainId !== TRADEABLE_CHAIN_ID) return "wrong-chain";
  // GAS BEFORE CASH. Both are fixed by sending money, so the tie-break is
  // REACH: with no ETH nothing at all can be submitted, including the exit;
  // with no USDG only a buy is blocked and a sell still works. Naming the
  // narrower problem first would send an owner to buy USDG for an account that
  // could not have spent it.
  if (!a.gasSponsored && a.gasWei !== null && a.gasWei === 0n) return "no-gas";
  return "no-cash";
}

