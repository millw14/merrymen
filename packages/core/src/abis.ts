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

/**
 * Uniswap v2 Router02 — the ONE function the energy buy may call (see
 * ENERGY_ROUTE_V1 in energy.ts and the energy permission in wall.ts).
 *
 * THIS LIST MUST HOLD EXACTLY ONE FUNCTION. The call-policy builder resolves the
 * selector from the ABI by name and refuses overloads without an explicit one;
 * the read functions the worker needs for quoting live in their own constant
 * below so they can never be granted by accident.
 *
 * `address[] path` is a DYNAMIC array, which is why multi-hop through
 * SwapRouter02 was removed from the wall and why this one is pinnable anyway:
 * with the offset word (w2) and the length word (w5) pinned, the elements are
 * right-aligned words at fixed offsets (w6..w8), each individually EQUAL-pinned.
 * A packed `bytes` path has no such words. wall.test.ts proves the offsets
 * against viem's encoder.
 *
 * SupportingFeeOnTransferTokens because $MERRYMEN charges a buy tax: this
 * variant checks amountOutMin against what actually ARRIVES at `to`, not the
 * pre-tax amount the pool sent.
 */
export const UNISWAP_V2_ENERGY_ABI = [
  {
    type: "function",
    name: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

/** Uniswap v2 Router02 views the worker quotes the energy route with. Never granted. */
export const UNISWAP_V2_ROUTER_READ_ABI = [
  {
    type: "function",
    name: "getAmountsOut",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "path", type: "address[]" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "getAmountsIn",
    stateMutability: "view",
    inputs: [
      { name: "amountOut", type: "uint256" },
      { name: "path", type: "address[]" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const;

// ── Lighter (Robinhood instance) — see LIGHTER_ROUTE_V1 in perps.ts ─────────
//
// Every selector below was matched against the DEPLOYED bytecode of the proxy's
// implementations on 4663, not just lighter-contracts' source: the instance
// omits the legacy USDC functions and the NIL-account changePubKey shortcut the
// GitHub main branch has. perps.test.ts pins each selector.
//
// ONE FUNCTION PER GRANTED CONSTANT, for the reason UNISWAP_V2_ENERGY_ABI gives:
// the call-policy builder resolves a selector from the ABI by name, and a list
// holding a second function is a second thing a permission might one day be
// built from. The three the session key may call are separate constants; the
// reads, the owner's escape hatches and the events live apart so none of them
// can be granted by accident.

/**
 * `deposit(_to, _assetIndex, _routeType, _amount)` — posts USDG margin. The
 * Lighter account is keyed on `_to` and created by the first deposit, so the
 * wall pins `_to` to the account itself, asset 3, route 0 (perps), and
 * `_amount ≤ perTradeUsdg` — all four words. Payable in the contract (native
 * ETH deposits share the entry point); every permission has valueLimit 0.
 * `_routeType` is a Solidity enum (TxTypes.RouteType), which the ABI encodes as
 * uint8 — hence the selector 0x8a857083.
 */
export const LIGHTER_DEPOSIT_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [
      { name: "_to", type: "address" },
      { name: "_assetIndex", type: "uint16" },
      { name: "_routeType", type: "uint8" },
      { name: "_amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

/**
 * `changePubKey(_accountIndex, _apiKeyIndex, _pubKey)` — registers a trading
 * key, authenticated only by msg.sender being the account's L1 address, which
 * is why a Kernel can do it with no EIP-191/1271 signature.
 *
 * THE ONE DYNAMIC ARGUMENT THE WALL PINS. `bytes` puts an offset in word 2 and
 * the length in word 3, with the 40 key bytes in words 4–5 (the tail of word 5
 * zero-padded). The wall pins the offset (0x60), the length (40) and both data
 * words; without the offset pin the decoder could be pointed at other bytes.
 * `pubKeyWords` in perps.ts builds w4/w5 and perps.test.ts proves them against
 * viem's encoder.
 */
export const LIGHTER_CHANGE_PUBKEY_ABI = [
  {
    type: "function",
    name: "changePubKey",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_accountIndex", type: "uint48" },
      { name: "_apiKeyIndex", type: "uint8" },
      { name: "_pubKey", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

/**
 * `withdrawPendingBalance(_owner, _assetIndex, _baseAmount)` — claims a secure
 * withdrawal once it is pending on the contract. Anyone may call it and it
 * always pays `_owner` (Lighter's relayer usually claims first), so with
 * `_owner` pinned to self the amount can stay open: the only reachable effect
 * is paying this account what it is already owed. Emits WithdrawPending.
 */
export const LIGHTER_WITHDRAW_PENDING_ABI = [
  {
    type: "function",
    name: "withdrawPendingBalance",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_owner", type: "address" },
      { name: "_assetIndex", type: "uint16" },
      { name: "_baseAmount", type: "uint128" },
    ],
    outputs: [],
  },
] as const;

/**
 * Views the worker and the recover disclosure read. NEVER GRANTED.
 *
 * `addressToAccountIndex` returns 0 for an address that has never deposited
 * (account indexes start above 0), which is how an agent without perps reads a
 * known-zero venue term without ever calling Lighter's API.
 *
 * `assetConfigs` is the public getter of `mapping(uint16 => AssetConfig)`; it
 * returns the struct's members in declaration order (lighter-contracts
 * ExtendableStorage.sol). A claim pays `baseAmount × tickSize`.
 */
export const LIGHTER_READ_ABI = [
  {
    type: "function",
    name: "addressToAccountIndex",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint48" }],
  },
  {
    type: "function",
    name: "getPendingBalance",
    stateMutability: "view",
    inputs: [
      { name: "_owner", type: "address" },
      { name: "_assetIndex", type: "uint16" },
    ],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    type: "function",
    name: "assetConfigs",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint16" }],
    outputs: [
      { name: "tokenAddress", type: "address" },
      { name: "withdrawalsEnabled", type: "uint8" },
      { name: "extensionMultiplier", type: "uint56" },
      { name: "tickSize", type: "uint128" },
      { name: "depositCapTicks", type: "uint64" },
      { name: "minDepositTicks", type: "uint64" },
    ],
  },
] as const;

/**
 * The OWNER's escape hatches — L1 priority requests the account's L1 address
 * (the Kernel, in a sudo UserOp signed with the owner key) can make without
 * the API key. NEVER GRANTED to the session key: `withdraw` and
 * `cancelAllOrders` would let it strip the venue stops rule 7 depends on, and
 * on-chain `createOrder`'s semantics on this instance are unproven until the
 * mainnet checklist records them.
 */
export const LIGHTER_OWNER_RECOVER_ABI = [
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_accountIndex", type: "uint48" },
      { name: "_assetIndex", type: "uint16" },
      { name: "_routeType", type: "uint8" },
      { name: "_baseAmount", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "cancelAllOrders",
    stateMutability: "nonpayable",
    inputs: [{ name: "_accountIndex", type: "uint48" }],
    outputs: [],
  },
  {
    type: "function",
    name: "createOrder",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_accountIndex", type: "uint48" },
      { name: "_marketIndex", type: "uint16" },
      { name: "_baseAmount", type: "uint48" },
      { name: "_price", type: "uint32" },
      { name: "_isAsk", type: "uint8" },
      { name: "_orderType", type: "uint8" },
    ],
    outputs: [],
  },
] as const;

/**
 * The proxy's margin events, which the capital classifier's venue-margin arm
 * and payout recognition read from receipts (rule 12). `Deposit` indexes
 * nothing; `WithdrawPending` indexes `owner`, so a payout to this account is a
 * topic1 match. topic0 of each is pinned in LIGHTER_ROUTE_V1.topics.
 */
export const LIGHTER_EVENTS_ABI = [
  {
    type: "event",
    name: "Deposit",
    inputs: [
      { name: "toAccountIndex", type: "uint48", indexed: false },
      { name: "toAddress", type: "address", indexed: false },
      { name: "assetIndex", type: "uint16", indexed: false },
      { name: "routeType", type: "uint8", indexed: false },
      { name: "baseAmount", type: "uint128", indexed: false },
    ],
  },
  {
    type: "event",
    name: "WithdrawPending",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "assetIndex", type: "uint16", indexed: false },
      { name: "baseAmount", type: "uint128", indexed: false },
    ],
  },
] as const;

/**
 * Virtuals agent-token tax, in bps. $MERRYMEN answered 100 (1%) on 2026-09-27;
 * the token's owner can change it, which is why the energy buy reads it fresh
 * and refuses above ENERGY.maxTaxBps rather than trusting a remembered figure.
 */
export const AGENT_TOKEN_TAX_ABI = [
  {
    type: "function",
    name: "totalBuyTaxBasisPoints",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
