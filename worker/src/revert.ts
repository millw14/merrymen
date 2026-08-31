/**
 * WHAT A REVERT MEANT, so the loop can do something other than repeat itself.
 *
 * `index.ts` put ninety characters of the raw error into `reject_rule` and
 * derived nothing. That is free-form text of unbounded cardinality in a column
 * every other producer fills from a small vocabulary — and it sat in a headless
 * loop with a 60-second tick and no human reading it. **A revert you cannot
 * classify is a revert you repeat.** The 1,242 identical `ops-cap` rejections of
 * 2026-07-15 are what that looks like from the outside.
 *
 * That is also why this is worth more here than in the tool it is borrowed from.
 * Vex (github.com/Vex-Foundation/Vex, used with its author's permission) maps
 * revert strings to a taxonomy so a PERSON is told which parameter to change.
 * merrymen has no person in the loop, so the classification has to feed back
 * into the next decision itself — see `retryable`.
 *
 * THE RULE FOR THIS TABLE, taken from theirs verbatim: **add nothing from
 * memory.** Every pattern below is either a string this codebase itself emits
 * (grep the reference beside it) or a documented EntryPoint/Kernel code. A
 * plausible-looking string that no contract on this chain actually returns is
 * worse than no entry: it produces confident misclassification of the one
 * failure someone is trying to understand.
 *
 * So the table starts SMALL. `unclassified` is the honest default and is
 * treated as retryable — it must never become the bucket that quietly suppresses
 * a token because nobody recognised the message.
 */

/**
 * What kind of failure this was, and therefore what the loop should do next.
 *
 * Deliberately about the REMEDY rather than the cause: two different reverts
 * that call for the same response are one class here, because the only consumer
 * is a decision about whether to try again.
 */
export type RevertClass =
  /** The price moved between the quote and the fill. Genuinely transient. */
  | "slippage"
  /** We do not hold what we tried to spend. Retrying cannot fix it. */
  | "insufficient-balance"
  /** The router was not approved for the amount. A wiring fault, not a market one. */
  | "allowance"
  /** The account could not pay the EntryPoint's prefund. Needs ETH, not a retry. */
  | "prefund"
  /** The session key's own policy refused it — the wall, working. */
  | "wall-refused"
  /** The route has no liquidity to fill this. Retrying at the same size will not. */
  | "no-liquidity"
  /** A deadline passed before inclusion. Transient by construction. */
  | "deadline"
  /**
   * The curve graduated. Its market has moved to a pool; this venue is done with
   * that token forever. The most permanent condition in the taxonomy.
   */
  | "curve-graduated"
  /**
   * The adapter refused the trade's SHAPE — a native-quoted curve, assets that do
   * not match the curve, a non-contract asset, identical legs, a zero size. None
   * of these change by waiting, and all are decided before any money moves.
   */
  | "curve-unsupported"
  /** We do not recognise it. Retryable, deliberately — see the header. */
  | "unclassified";

export interface RevertVerdict {
  rule: RevertClass;
  /** What the owner reads. One sentence, no jargon the message did not already use. */
  detail: string;
  /**
   * May the same intent be tried again on a later tick?
   *
   * FALSE IS THE DANGEROUS ANSWER, so it is only ever returned for a class whose
   * cause cannot change without something else changing first. Everything else,
   * including `unclassified`, stays true: suppressing a token because a message
   * was unfamiliar is how a taxonomy turns into an outage.
   */
  retryable: boolean;
}

/**
 * The table. Ordered — the first match wins, so the specific sits above the
 * general.
 *
 * Each entry names where its pattern comes from. An entry without a source is
 * an entry to delete.
 */
/**
 * PonsSelfTrade's custom-error selectors.
 *
 * COMPUTED, NOT REMEMBERED, per this file's own rule. The signatures were read
 * out of contracts/contracts/PonsSelfTrade.sol:154-165 and the selectors derived
 * from them with `toFunctionSelector`, so a rename in the .sol that is not
 * mirrored here surfaces as an unclassified revert rather than as a confident
 * misclassification.
 *
 * Solidity revert data is `selector ++ abi.encode(args)`, so matching the leading
 * four bytes is exact and the arguments are ignored. Case-insensitive because
 * different RPCs hex-encode with different case.
 *
 * WHAT IS DELIBERATELY ABSENT: the errors PONS ITSELF reverts with. Those come
 * from a contract this repo does not own, so their signatures cannot be read out
 * of source. A scoping pass suggested Pons's SlippageExceeded is 0x71c4efed;
 * deriving `SlippageExceeded()` gives 0x8199f5f3, so the two disagree and neither
 * is evidence. A selector guessed from a plausible name is exactly the
 * confident-misclassification the header forbids, so Pons's own reverts classify
 * `unclassified` — retryable, and visible — until one is observed on chain and
 * added with the transaction that produced it.
 */
const PONS_ERR = {
  Expired: "0x203d82d8",
  ZeroAmount: "0x1f2a2005",
  NotAContract: "0x09ee12d5",
  Reentrant: "0xed3ba6a6",
  NativeQuoteNotSupported: "0xf51cd3d9",
  CurveGraduated: "0x025ac17e",
  AssetsDoNotMatchCurve: "0xe3716feb",
  IdenticalAssets: "0x5048bd62",
  InsufficientOutput: "0x2c19b8b8",
  NoOutput: "0x5a7cfa65",
  TransferFailed: "0x90b8ec18",
  ApprovalFailed: "0x8164f842",
} as const;

/** The selectors, for the test that asserts they are 4 bytes and all distinct. */
export const PONS_ERROR_SELECTORS: readonly string[] = Object.values(PONS_ERR);

const PATTERNS: readonly { re: RegExp; rule: RevertClass; retryable: boolean; detail: string }[] = [
  {
    // ABOVE the generic entries. These are exact four-byte matches and cannot
    // collide with a prose revert string, so specificity costs nothing.
    re: new RegExp(PONS_ERR.CurveGraduated, "i"),
    rule: "curve-graduated",
    retryable: false,
    detail:
      "this token has graduated off its bonding curve — its market is a pool now, and the adapter " +
      "refuses by name rather than trading at a price for a market that has moved. Retrying cannot " +
      "undo a graduation; the position has to be routed through a pool venue instead.",
  },
  {
    re: new RegExp(
      [
        PONS_ERR.NativeQuoteNotSupported,
        PONS_ERR.AssetsDoNotMatchCurve,
        PONS_ERR.NotAContract,
        PONS_ERR.IdenticalAssets,
        PONS_ERR.ZeroAmount,
        PONS_ERR.Reentrant,
      ].join("|"),
      "i",
    ),
    rule: "curve-unsupported",
    retryable: false,
    detail:
      "the adapter refused the shape of this trade before any money moved — a native-quoted curve, " +
      "assets that do not belong to it, a non-contract asset, identical legs, or a zero size. None of " +
      "these change by waiting, so the intent is suppressed rather than repeated every tick.",
  },
  {
    // The adapter's own floor, measured against the ACCOUNT's balance delta
    // rather than the curve's claim — so this fires on a real shortfall, not on a
    // curve lying about what it paid. Genuinely transient: it is the venue moving
    // between quote and fill, which is what a floor is for.
    re: new RegExp(PONS_ERR.InsufficientOutput, "i"),
    rule: "slippage",
    retryable: true,
    detail:
      "the curve delivered less than the floor this operation was signed with, measured against the " +
      "account's own balance rather than the curve's word for it. Nothing moved. Worth retrying at a " +
      "fresh quote.",
  },
  {
    // Zero delivered. NOT slippage — a curve that takes the input and pays
    // nothing is broken or hostile, and retrying pays it again.
    re: new RegExp(PONS_ERR.NoOutput, "i"),
    rule: "curve-unsupported",
    retryable: false,
    detail:
      "the curve delivered nothing at all. That is not the market moving; it is a curve that took the " +
      "input and paid no output, which is what the adapter's balance-delta check exists to catch.",
  },
  {
    re: new RegExp(PONS_ERR.Expired, "i"),
    rule: "deadline",
    retryable: true,
    detail:
      "the curve trade's deadline passed before it was included. Nothing moved, and the next tick " +
      "builds a fresh one.",
  },
  {
    re: new RegExp([PONS_ERR.TransferFailed, PONS_ERR.ApprovalFailed].join("|"), "i"),
    rule: "allowance",
    retryable: false,
    detail:
      "the adapter could not pull the input or approve the curve for it. merrymen batches the approve " +
      "with the trade, so seeing this means the batch did not carry what it should have — a wiring " +
      "fault, not a market one.",
  },
  {
    // STF is TransferHelper.safeTransferFrom's revert string in v3-periphery,
    // and it fires when the INPUT token's transferFrom fails — insufficient
    // balance or insufficient allowance. It is NOT slippage.
    //
    // It was in the slippage entry, above the balance and allowance entries,
    // in a first-match-wins table. So on the Uniswap v3 path — the only live
    // venue — the two classes this whole suppression mechanism exists for were
    // unreachable, and an account that simply did not hold the token was told
    // "this is the floor doing its job; it is worth retrying" every 60 seconds.
    // That is the 1,242-identical-rejections failure the header warns about,
    // produced by the thing meant to prevent it.
    //
    // It is also exactly what the header's own rule forbids: STF is not a
    // string the slippage path emits, and it was added from memory. Ordered
    // ABOVE the generic ERC-20 entries because it is more specific, and the
    // detail names both causes because the revert genuinely does not say which.
    re: /\bSTF\b/,
    rule: "insufficient-balance",
    retryable: false,
    detail:
      "the router could not pull the token this trade meant to sell — TransferHelper.safeTransferFrom reverted, which " +
      "means either the account does not hold the amount or the approve did not cover it. Retrying cannot change " +
      "either, so this intent is suppressed for the rest of the arm.",
  },
  {
    // SwapRouter02's ACTUAL slippage revert. Case-sensitive on the router's own
    // phrasing rather than a loose /slippage/i, which would match any message
    // that merely mentions the word — including our own.
    re: /Too little received|Too much requested|amountOutMinimum/,
    rule: "slippage",
    retryable: true,
    detail:
      "the fill would have come in under the slippage floor this operation was signed with, so the router refused it. " +
      "The trade did not happen and nothing moved. This is the floor doing its job; it is worth retrying.",
  },
  {
    // ERC-20 conventions (OpenZeppelin's message and the bare form).
    re: /transfer amount exceeds balance|insufficient balance|ERC20InsufficientBalance/i,
    rule: "insufficient-balance",
    retryable: false,
    detail:
      "the account does not hold what this operation tried to spend. Retrying cannot change that — the position or the " +
      "cash has to arrive first, so this intent is suppressed for the rest of the arm rather than repeated every tick.",
  },
  {
    re: /transfer amount exceeds allowance|insufficient allowance|ERC20InsufficientAllowance/i,
    rule: "allowance",
    retryable: false,
    detail:
      "the router was not approved for this amount. merrymen batches the approve and the swap into one operation, so " +
      "seeing this means the batch did not carry the approve it should have — a wiring fault, not a market one.",
  },
  {
    // ERC-4337 EntryPoint 0.7 codes: AA21 (no prefund), AA31 (paymaster deposit).
    // merrymen uses no paymaster, so AA21 is the one that fires.
    re: /AA21|didn'?t pay prefund|insufficient funds for gas/i,
    rule: "prefund",
    retryable: false,
    detail:
      "the account could not pay the EntryPoint's gas prefund. It pays its own gas and there is no paymaster, so this " +
      "needs ETH at the smart account — not a retry.",
  },
  {
    // AA23/AA24 are validation failures. On this account the validator IS the
    // wall, so a refusal here is a permission the grant does not carry.
    re: /AA23|AA24|signature error|InvalidSignature|PolicyFailed/i,
    rule: "wall-refused",
    retryable: false,
    detail:
      "the account contract refused to validate this operation — the session key's sealed policy does not permit it. " +
      "That is the wall working. It cannot be retried into success; the grant has to be re-signed to cover it.",
  },
  {
    // Uniswap v3 pool, when the swap would move the pool past its tick range.
    // Word-bounded and case-SENSITIVE. These are three-letter Solidity revert
    // strings, and /SPL/i would match inside "...SPLIT...", a token symbol, or
    // a hex address that happens to spell it. A taxonomy that fires on a
    // substring is worse than one that abstains.
    re: /\bSPL\b|\bLOK\b|not enough liquidity|insufficient liquidity/,
    rule: "no-liquidity",
    retryable: false,
    detail:
      "the pool could not fill an order this size. Retrying at the same size will fail the same way; a smaller ticket " +
      "or a different venue is the only thing that changes it.",
  },
  {
    // SwapRouter02's deadline check, and the deadline this repo passes
    // (venues/uniswap.ts builds one per trade).
    // Same discipline: EXPIRED word-bounded and case-sensitive, and the bare
    // /deadline/i dropped — it matched any message merely mentioning one.
    re: /Transaction too old|\bEXPIRED\b/,
    rule: "deadline",
    retryable: true,
    detail:
      "the operation's deadline passed before it was included. Nothing moved, and the next tick builds a fresh one.",
  },
];

/**
 * Classify a revert message.
 *
 * Takes the RAW error text, because the caller's truncation is for storage and
 * this is for meaning — matching against an already-sliced string would make
 * classification depend on where the 90th character happened to fall.
 */
/**
 * The raw regex sources, for the test that asserts none of them carries a
 * control character. `` written through one escaping layer too few becomes
 * U+0008 BACKSPACE — which reads as a word boundary in a diff and matches
 * nothing a revert string contains. That happened here.
 */
export const PATTERN_SOURCES: readonly string[] = PATTERNS.map((p) => p.re.source);

export function classifyRevert(message: string): RevertVerdict {
  for (const p of PATTERNS) {
    if (p.re.test(message)) return { rule: p.rule, detail: p.detail, retryable: p.retryable };
  }
  return {
    rule: "unclassified",
    // Says what it does not know. A sentence claiming more than that is how a
    // table like this stops being trustworthy.
    detail:
      "the chain refused this operation and merrymen does not recognise the reason. It is left retryable, because " +
      "suppressing a trade on an unfamiliar message would hide the failure rather than explain it. The raw text is in " +
      "the event log.",
    retryable: true,
  };
}

/**
 * A key for suppressing one intent after a non-retryable revert.
 *
 * Scoped to the token pair rather than the intent: the same buy re-proposed a
 * tick later is a different object with the same meaning, and it is the meaning
 * that must not be repeated. Kept out of the class above because WHAT to
 * suppress is the caller's business — this only says whether to.
 */
export function suppressionKey(kind: string, sellToken?: string, buyToken?: string): string {
  return `${kind}:${(sellToken ?? "").toLowerCase()}->${(buyToken ?? "").toLowerCase()}`;
}
