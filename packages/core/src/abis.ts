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
 * PonsNativeTrade — the native-quoted half of the same launchpad.
 *
 * Same all-static discipline as above, and the same absence of a recipient: it
 * is msg.sender, in bytecode. What differs is what is MISSING from each
 * signature, and it is missing on purpose.
 *
 * `sellForNative` has no `assetOut`, and `buyWithNative` has no `assetIn`,
 * because the native side is implied by the SELECTOR. If either carried the
 * native leg as an argument it would have to be `address(0)`, and pinning that
 * would mean admitting a non-contract sentinel into a ONE_OF list the ERC-20
 * adapter shares — weakening a bound on the other venue to describe this one.
 * Two selectors cost nothing and keep the two asset lists honest.
 *
 * `buyWithNative` is PAYABLE and its size is `msg.value`, not an argument. That
 * is why its permission is bounded by `valueLimit` rather than by a param
 * condition, and why it is the one permission in this wall that can move native
 * ETH at all.
 */
export const PONS_NATIVE_ABI = [
  {
    type: "function",
    name: "sellForNative",
    stateMutability: "nonpayable",
    inputs: [
      { name: "curve", type: "address" },
      { name: "token", type: "address" },
      { name: "amountIn", type: "uint128" },
      { name: "minNativeOut", type: "uint128" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "buyWithNative",
    stateMutability: "payable",
    inputs: [
      { name: "curve", type: "address" },
      { name: "token", type: "address" },
      { name: "minTokensOut", type: "uint128" },
      { name: "deadline", type: "uint256" },
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
