/**
 * Uniswap SwapRouter02 exactInputSingle — the one selector merrymen grants
 * session keys permission to call. NOTE: SwapRouter02 has NO deadline field
 * (that was SwapRouter v1). Shared by web (call policy) and worker (execution).
 */
export const UNISWAP_SWAP_ROUTER_ABI = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    // Multi-hop. `path` is packed token/fee/token(/fee/token…), and the router
    // holds the intermediate leg itself — so a USDG→WETH→CATE swap still only
    // needs USDG approved. That's why routing through WETH costs no new grant
    // permission and no re-sign.
    type: "function",
    name: "exactInput",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "path", type: "bytes" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

/**
 * Permit2 — how Uniswap v4 takes tokens. The account approves Permit2 once, and
 * Permit2 grants a spender a bounded, EXPIRING allowance. `amount` is uint160 and
 * `expiration` uint48, both narrower than the usual uint256: silently truncating
 * either would grant an allowance nobody intended.
 */
export const PERMIT2_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    outputs: [],
  },
] as const;

/**
 * UniversalRouter — a command interpreter, not a swap function. `commands` is a
 * byte per operation and `inputs` the matching encoded arguments, so a call
 * policy can constrain WHICH contract runs but not what it's asked to do. The
 * real bound is upstream: it can only move what Permit2 allowed it.
 */
export const UNIVERSAL_ROUTER_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

/** Chainlink AggregatorV3Interface — stock feeds run 24/5; check updatedAt for staleness. */
export const CHAINLINK_ABI = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  /**
   * One historical round, by id.
   *
   * The id is PHASE-ENCODED: the high 64 bits identify the aggregator behind
   * the proxy and the low 64 the round within it, so walking history means
   * decrementing only the low half. Cross the phase boundary and the answers
   * come back from a different aggregator with a different scale — which is
   * what the magnitude guard in read-feed-history exists to catch.
   */
  {
    type: "function",
    name: "getRoundData",
    stateMutability: "view",
    inputs: [{ name: "_roundId", type: "uint80" }],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

/**
 * V4SelfSwap — contracts/contracts/V4SelfSwap.sol, the adapter that makes
 * Uniswap v4 constrainable by the wall.
 *
 * ONE ABI, SHARED by the wall (which derives the call-policy selector and the
 * argument offsets from it) and the worker's execution path (which encodes the
 * live calldata with it). Two copies would be two chances for the policy and
 * the call to disagree about the same function — the exact drift
 * UNISWAP_SWAP_ROUTER_ABI exists here to prevent.
 *
 * All eight parameters are STATIC on purpose: the call policy maps args[i] to
 * calldata word i with no ABI awareness, and a flat static list is the only
 * shape it can actually read. The recipient is not among them — it is
 * msg.sender in the contract's bytecode, which is the whole point.
 */
export const V4SELFSWAP_ABI = [
  {
    type: "function",
    name: "swapExactIn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickSpacing", type: "int24" },
      { name: "hooks", type: "address" },
      { name: "amountIn", type: "uint128" },
      { name: "minAmountOut", type: "uint128" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

/**
 * PonsSelfTrade — the bonding-curve adapter. See contracts/PonsSelfTrade.sol.
 *
 * ALL-STATIC, and that is the whole reason the shape looks like this. The call
 * policy maps args[i] to calldata offset i*32 with a flat positional rule and
 * no ABI arity check, so a signature with no struct, no `bytes` and no dynamic
 * array makes the policy's view of the calldata and the ABI's view the same
 * thing by construction. wall.ts carries the cautionary tale next to the
 * SwapRouter02 permissions: one leading `bytes` moved `exactInput`'s recipient
 * from word 3 to word 2, and reasoning that out instead of proving it is how a
 * policy ends up constraining the wrong word while looking strict.
 *
 * There is no recipient argument. It is msg.sender, in bytecode.
 */
/**
 * PonsClassVault — the per-account holder that makes a CLASS position exitable.
 *
 * NOTE THE SHAPE, because it is what the wall relies on: the class token is not
 * an argument to EITHER call. `buy` names the FUNDING asset (which stays
 * enumerated) and derives the token from the curve; `sell` names no asset at
 * all, because the vault can only sell what it already holds and can only pay
 * its own owner. So there is no token word for the policy to leave unpinned —
 * the class capability comes from WHERE the token lives, not from a loosened
 * constraint.
 *
 * `sweep` is deliberately absent. It moves a position back to the account, which
 * is a RECOVERY action taken with the owner key — and the owner key is not bound
 * by the wall. Granting it to the session key would only let an agent move a
 * token into the account, where it cannot be sold for want of an approve.
 *
 * uint256 amounts, matching PonsClassVault.sol exactly — its sibling above uses
 * uint128 and matches ITS contract. A mismatch here changes the selector and the
 * permission silently matches nothing.
 */
export const PONS_CLASS_VAULT_ABI = [
  {
    type: "function",
    name: "buy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "curve", type: "address" },
      { name: "quoteAsset", type: "address" },
      { name: "quoteIn", type: "uint256" },
      { name: "minTokensOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "tokensOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "sell",
    stateMutability: "nonpayable",
    inputs: [
      { name: "curve", type: "address" },
      { name: "tokensIn", type: "uint256" },
      { name: "minQuoteOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "quoteOut", type: "uint256" }],
  },
] as const;

/**
 * PonsClassVaultFactory.deploy — the one call that CREATES a class vault.
 *
 * WHY THE WALL NEEDS THIS AT ALL. A vault address is a CREATE2 prediction; the
 * contract does not exist until somebody calls this. Deployment is permissionless
 * (anyone may pay to create anyone's vault), so the session key needs no
 * privilege — only PERMISSION, which is a different thing and the wall's entire
 * business.
 *
 * Leaving it ungranted is not the safe option, and the reason is EVM semantics
 * rather than policy: a CALL to an address with no code SUCCEEDS with empty
 * returndata. So a class buy against an undeployed vault would not revert — the
 * USDG approve would land, the `buy` would no-op, and the trade would report
 * `landed`. A ledger row for a purchase that bought nothing.
 *
 * Kept in this file rather than beside `vaultFor` in classvault.ts: one constant
 * imported by BOTH the wall (which derives the pinned selector) and the worker
 * (which encodes the call), so the selector the policy matches and the selector
 * the call carries cannot drift. That drift is the failure the note above
 * PONS_CLASS_VAULT_ABI describes for the uint128/uint256 width.
 *
 * All-static, one address word, so the call policy's positional offsets and the
 * ABI agree by construction — see the note on PONS_SELFTRADE_ABI.
 */
export const PONS_CLASS_VAULT_FACTORY_DEPLOY_ABI = [
  {
    type: "function",
    name: "deploy",
    stateMutability: "nonpayable",
    inputs: [{ name: "owner_", type: "address" }],
    outputs: [{ name: "vault", type: "address" }],
  },
] as const;

export const PONS_SELFTRADE_ABI = [
  {
    type: "function",
    name: "tradeExactIn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "curve", type: "address" },
      { name: "assetIn", type: "address" },
      { name: "assetOut", type: "address" },
      { name: "amountIn", type: "uint128" },
      { name: "minAmountOut", type: "uint128" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;
