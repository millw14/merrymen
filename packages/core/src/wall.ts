import { erc20Abi, parseAbi, type Address } from "viem";
import { PolicyFlags } from "@zerodev/permissions";
import { CallPolicyVersion, ParamCondition, toCallPolicy } from "@zerodev/permissions/policies";
import { toTimestampPolicy } from "@zerodev/permissions/policies";
import { UNISWAP_SWAP_ROUTER_ABI, PERMIT2_ABI, UNIVERSAL_ROUTER_ABI, V4SELFSWAP_ABI, PONS_SELFTRADE_ABI } from "./abis";
import { MORPHO, RIALTO, UNISWAP } from "./protocols";
import { CASH, STOCK_TOKENS, TRADEABLE_SYMBOLS, USDG_DECIMALS, isValidCustomToken, type CustomToken } from "./tokens";
import { builtinGrantTargets, type GrantCaps } from "./grant";

/**
 * THE WALL. One definition, shared by every client that can sign a grant.
 *
 * This file decides what a session key is permitted to do once the account
 * contract is enforcing it — which assets it may approve, which routers may pull
 * them, how much per call, and when the key dies. It used to live inside the
 * dashboard's session.ts, which was fine while the dashboard was the only thing
 * that could sign. It is not fine with a phone app that can sign too: two copies
 * of this list would drift, nothing would fail when they did, and the difference
 * would be a wallet with permissions its owner never agreed to.
 *
 * So it is here, imported by both, and the tests in worker/src/wall.test.ts assert
 * the exact shape rather than trusting that a refactor preserved it.
 *
 * READ BEFORE CHANGING. Every entry below is a power granted to an automated
 * agent. Widening one is not a feature flag — it is a permanent change to what a
 * compromised agent could do with someone's money, and it only takes effect for
 * grants signed afterwards, so the fleet will be running a mix of walls.
 */

const VAULT_ABI = parseAbi([
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
]);

const USDG_SCALE = 10 ** USDG_DECIMALS;

/** Largest UI-unit value that can be converted to exact USDG base units. */
export const MAX_USDG_UI = Number.MAX_SAFE_INTEGER / USDG_SCALE;

/** Convert a finite UI-unit USDG amount to its exact 6-decimal base units. */
export function usdgUnits(value: number): bigint {
  const scaled = Math.round(value * USDG_SCALE);
  if (!Number.isFinite(value) || !Number.isSafeInteger(scaled)) {
    throw new RangeError(`USDG amount must be finite and no larger than ${MAX_USDG_UI}`);
  }
  return BigInt(scaled);
}

/**
 * THE SESSION KEY MAY EXECUTE, BUT IT MAY NOT SIGN.
 *
 * Everything else in this file is a CALL policy, and a call policy constrains
 * UserOp calls. It says nothing about signatures — and the permission validator
 * implements `signMessage` and `signTypedData` (@zerodev/permissions
 * toPermissionValidator), so with the library default (FOR_ALL_VALIDATION) the
 * session key can produce ERC-1271 signatures the account will honour.
 *
 * That was a hole straight through the wall, and the worst one, because it
 * bypasses the wall rather than stretching it. Permit2 is an approved spender
 * (allowedSpenders) and the stock approvals carry no amount condition, so a
 * Permit2 `permitTransferFrom` SIGNED by the session key — and submitted by
 * anyone, from their own EOA — moves tokens to any recipient with no UserOp at
 * all. No call policy is consulted, the rate limit never fires, and nothing in
 * the ledger records it. The same shape covers EIP-2612 permits and any
 * off-chain order that settles against an ERC-1271 signature.
 *
 * NOT_FOR_VALIDATE_SIG closes it: the kernel refuses to validate signatures
 * from this permission, while UserOp execution is untouched. This costs
 * merrymen nothing — the entire trading path is UserOps, and the v4 route
 * authorises Permit2 with a CALL (`permit2.approve`, see venues/uniswap-v4.ts)
 * rather than a signed permit. Grep confirms nothing in worker/, packages/ or
 * web/src/lib signs with the session account.
 *
 * The flag travels ON-CHAIN in the validator's enable data, so the account
 * itself enforces it — this is not a client-side promise. It is also hashed
 * into the permission id, which means it only takes effect for grants signed
 * AFTER this change: existing grants keep the old, permissive wall until
 * they're re-signed. See the header note about the fleet running a mix.
 */
export const WALL_POLICY_FLAG = PolicyFlags.NOT_FOR_VALIDATE_SIG;

/**
 * THE SINGLETONS EVERY GRANT DEPENDS ON, so their absence can be a REFUSAL
 * rather than a mystery.
 *
 * A ZeroDev policy is an address plus its data: `getPolicyInfoInBytes()` is
 * `concat([policyFlag, policyAddress])`, and the addresses come from
 * @zerodev/permissions' own constants — defaults for a deployment the library
 * assumes exists. On Robinhood Chain one of them did not, and nothing here
 * checked, so the grant sealed a pointer into empty space and the failure
 * surfaced as a UserOp that would not validate, with no message naming a cause.
 *
 * This repo already knows the discipline. index.ts refuses to trust the
 * drawdown breaker unless its address has CODE on the grant chain, because
 * otherwise the read "silently fails open while the user believes they're
 * protected". The wall's own policy contracts had no such check — which is
 * exactly why an undeployed singleton survived every test in the suite.
 *
 * Duplicated as literals ON PURPOSE. Re-exporting the package's constants would
 * make this list track whatever the library ships next, and the point of a
 * probe is to assert what THIS code sealed. If a version bump moves an address,
 * the probe must fail loudly rather than follow it.
 */
export const WALL_POLICY_CONTRACTS: readonly { name: string; address: Address }[] = [
  { name: "TimestampPolicy", address: "0xB9f8f524bE6EcD8C945b1b87f9ae5C192FdCE20F" as Address },
  { name: "CallPolicy V0_0_4", address: "0x9a52283276A0ec8740DF50bF01B28A80D880eaf2" as Address },
  { name: "ECDSA signer", address: "0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF" as Address },
];

/**
 * The only contracts a token approval may ever name as spender.
 *
 * Permit2 is here only to serve the v4 route, and follows the same opt-in: v4
 * never pulls tokens directly, so the account approves PERMIT2 and Permit2
 * grants the router its allowance — the router itself is approved for nothing.
 */
export function allowedSpenders(
  allowRialto = false,
  allowUniswapV4 = false,
  v4AdapterAddress?: Address,
  ponsAdapterAddress?: Address,
): Address[] {
  return [
    // Rialto is OPT-IN, and off by default — see WallOptions.allowRialto. An
    // approved spender can pull whatever it was approved for, and the stock
    // approvals carry no amount condition, so an unused router in this list is
    // not free: it is a standing licence to move every share the agent holds.
    ...(allowRialto ? [RIALTO.routerSnapshot as Address] : []),
    UNISWAP.swapRouter02 as Address,
    MORPHO.steakhouseUsdgVault as Address,
    // Permit2 used to sit here unconditionally, which made the sentence above
    // literally true of it: with the stock approvals uncapped, the session key
    // could approve Permit2 for every share it held. Harmless only while the
    // v4 CALL permissions are absent, so the two are now granted together or
    // not at all — see WallOptions.allowUniswapV4.
    ...(allowUniswapV4 ? [UNISWAP.permit2 as Address] : []),
    // The V4SelfSwap adapter pulls tokenIn with a plain transferFrom, so it
    // must be nameable as a spender. That is ALL it gets here: joining this
    // list puts it inside the existing capped USDG approve (buy-side bound)
    // and the per-token approves (sell-side, over exactly the sealed set) —
    // zero new approve permissions. Its own call permission is added below,
    // and the licence-to-move-shares caveat above is answered by the contract
    // itself: everything it pulls it settles into the pool, and everything
    // that comes out lands with msg.sender. See contracts/V4SelfSwap.sol.
    ...(v4AdapterAddress ? [v4AdapterAddress] : []),
    // The PonsSelfTrade adapter, on exactly the same terms and for exactly the
    // same reason: it pulls assetIn with a plain transferFrom, so it must be
    // nameable as a spender, and that is ALL it gets here — zero new approve
    // permissions, inside the existing caps.
    //
    // The licence-to-move-shares caveat above is answered the same way it is
    // for the v4 adapter, by the contract: everything it pulls it either
    // spends on the curve or hands straight back, everything the curve pays
    // goes to msg.sender, and nothing survives the call. Where it differs is
    // that its CURVE argument cannot be pinned by any policy — see the call
    // permission below, which says so rather than implying otherwise.
    ...(ponsAdapterAddress ? [ponsAdapterAddress] : []),
  ];
}

/**
 * The owner's choices that widen the wall beyond its secure default.
 *
 * Every field here defaults to the CLOSED position. That is the lesson of the
 * signature hole and the unpinned recipients: a default that happens to be
 * permissive survives for months because nothing fails. So the default wall
 * trades, and does nothing else.
 */
export interface WallOptions {
  extraTokens?: readonly CustomToken[];
  /**
   * Addresses USDG may be transferred OUT to.
   *
   * EMPTY (the default) means the wall carries NO transfer permission at all —
   * a compromised agent cannot move USDG to an address, full stop.
   *
   * This closes the largest remaining hole. The recipient used to be free-form
   * because chat transfers are user-confirmed, so the amount was the only
   * on-chain bound — but that bound is PER CALL, and the daily USDG cap is
   * enforced only off-chain, in the worker. A compromised worker ignores its
   * own counter, so the true on-chain ceiling was perTradeUsdg × maxOpsPerDay
   * every day until expiry: 2,400 USDG/day at the default preset. "Bounded"
   * in the sense that draining the account took a fortnight.
   *
   * Registering addresses is the same re-sign-to-widen model the token
   * allowlist already uses, and for the same reason: the wall cannot grow by
   * itself. Moving money out to an UNREGISTERED address remains possible any
   * time via the owner key (`merrymen recover`), which is not bound by the
   * wall — so this removes an agent's power, not the owner's.
   */
  withdrawalAddresses?: readonly Address[];
  /**
   * The Rialto meta-router. OFF by default.
   *
   * Its calldata comes from a quote API, so there is no shape for a call
   * policy to constrain — target-scoping is the entire control, which means
   * granting it is granting "call anything on this contract". That is
   * defensible only if you actually use it, and it needs an integrator API key
   * to work at all, so the default is off and the risk is opt-in.
   */
  allowRialto?: boolean;
  /**
   * The Uniswap v4 route — Permit2 plus the UniversalRouter. OFF by default.
   *
   * The UniversalRouter takes an opaque `bytes[] inputs`, and the swap
   * recipient lives inside it. A call policy derives one selector from
   * `functionName` and can only constrain declared `args`, so there is no
   * shape here to constrain: granting `execute` is granting "call anything on
   * this contract". That is the same reasoning as allowRialto, and it should
   * have carried the same default.
   *
   * It did not. These two permissions were granted UNCONDITIONALLY, and
   * Permit2 was an unconditional approved spender, while the stock approvals
   * carry no amount condition. Chained — approve(stock, permit2, unbounded),
   * permit2.approve(stock, universalRouter, max, max), execute(...) — that is
   * the whole non-USDG book to any address, in one UserOp. The comment on the
   * execute permission asserted a bound ("Permit2 is only ever granted one
   * trade's worth, expiring") that described what the worker CHOOSES to
   * encode, not what the policy PERMITS. Same failure as the vault-withdraw
   * recipient and the FOR_ALL_VALIDATION default: a comment describing intent
   * over a policy allowing the opposite.
   *
   * Turning it on is a real trade, not a formality: v4 is where new pairs on
   * this chain launch, so an agent without it cannot buy them — or sell one it
   * already holds. The stock basket is unaffected; every tradeable symbol has
   * v3 depth. Off is the honest default because the front page promises the
   * chain enforces the wall, and with this granted it does not.
   */
  allowUniswapV4?: boolean;
  /**
   * The V4SelfSwap adapter to grant, or absent for none — the CLOSED default,
   * like everything here.
   *
   * This is the route that replaces allowUniswapV4: instead of Permit2 plus a
   * router whose calldata the policy cannot read, one contract with one
   * declared selector whose eight arguments are all static words — and whose
   * recipient is `msg.sender` in bytecode, so the one thing the old route
   * could never constrain simply does not exist as a parameter.
   *
   * An ADDRESS rather than a boolean because the adapter is per-deploy and
   * per-chain: the wall must name the exact contract the signature covers,
   * and the grant records it (StoredGrant.v4AdapterAddress) so the worker
   * calls that address and no other.
   */
  v4AdapterAddress?: Address;
  /**
   * The PonsSelfTrade adapter to grant, or absent for none — CLOSED by default.
   *
   * A SECOND, SEPARATE opt-in from the v4 adapter, not a widening of it. The two
   * reach different venues with different risks, and one address granting both
   * would make the owner's only choice all-or-nothing.
   *
   * WHAT THIS ONE CANNOT PIN, SAID PLAINLY. Every other call permission in this
   * file names a target the policy vouches for. A Pons buy goes to a PER-TOKEN
   * bonding curve — roughly 475 new addresses an hour — so the curve is an
   * argument, and no ONE_OF list over it would be anything but wrong tomorrow or
   * unbounded today. The bound is therefore NOT "the policy checks the venue".
   * It is:
   *
   *   - `assetIn` and `assetOut` pinned ONE_OF the same asset list the approve
   *     permissions cover, so a trade can only move assets this signature
   *     already covers;
   *   - the amount bounded by those same approve caps;
   *   - and the adapter refusing to deliver anywhere but `msg.sender`, checked
   *     against the account's own balance rather than the curve's word for it.
   *
   * That is the same exposure the v4 adapter carries with its caller-chosen pool
   * key, and the same one SwapRouter02 carries today: a compromised session key
   * can trade an allowlisted asset into a venue the attacker controls, at a
   * price they pick, up to the standing allowance. Not zero, and worth the owner
   * knowing before they turn it on.
   *
   * Note also what it does NOT reach: native-quoted curves, which are 53.6% of
   * the launchpad. The adapter is non-payable so this permission keeps
   * `valueLimit: 0n`, and native support would be a different contract behind a
   * different selector — see contracts/PonsSelfTrade.sol.
   *
   * An ADDRESS rather than a boolean, for the same reason as the v4 adapter:
   * per-deploy and per-chain, so the wall names the exact contract the signature
   * covers.
   */
  ponsAdapterAddress?: Address;
  /**
   * Native value the SwapRouter02 rule may carry, in wei. Default
   * NATIVE_SWAP_VALUE_LIMIT_WEI (0.5 ETH) so every newly signed wall can run
   * auto-convert; 0n restores the old no-native wall exactly.
   *
   * WHY THIS EXISTS. The auto-convert flow swaps NATIVE ETH → USDG in one
   * exactInputSingle call, and a native-input swap only works when the call
   * carries `msg.value`. Every other rule in this wall keeps valueLimit 0n —
   * a paymaster settles with the EntryPoint directly and the account never
   * hands ETH to anyone — so this is the ONE deliberate exception, and it is
   * bounded by a sealed constant rather than left open.
   *
   * WHAT IT EXPOSES, said plainly: a session key carrying this wall may attach
   * up to this much native ETH to ANY exactInputSingle call it is otherwise
   * allowed to make — the token legs are pinned ONE_OF the same asset set, the
   * recipient is pinned to the account, so the worst case is a bad-price swap
   * of ≤ this much ETH into an allowlisted asset the account itself receives.
   * That is the same exposure the auto-convert flow was signed for, not a
   * wider one.
   */
  nativeSwapValueLimitWei?: bigint;
}

/**
 * The ceiling on native value one exactInputSingle call may carry — the bound
 * that makes the auto-convert flow (native ETH → USDG) expressible at all.
 * 0.5 ETH is far above any conversion a sane reserve split produces and far
 * below "the account's whole balance" for anything but a dust account, where
 * the worker's own reserve arithmetic never proposes the op anyway.
 */
export const NATIVE_SWAP_VALUE_LIMIT_WEI = 500_000_000_000_000_000n; // 0.5 ETH

/**
 * Owner-added tokens that are safe to seal into a policy.
 *
 * Validated HERE, at the last point before an address becomes on-chain policy: a
 * malformed entry either bricks the grant or silently widens it. Anything already
 * covered by the built-in set is dropped so the policy carries no duplicates.
 */
export function usableExtraTokens(extraTokens: readonly CustomToken[] = []): CustomToken[] {
  const builtin = builtinGrantTargets();
  const seen = new Set<string>();
  return extraTokens.filter((t) => {
    if (!isValidCustomToken(t)) return false;
    const key = t.address.toLowerCase();
    if (builtin.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The call-policy permission list — pure data, which is what makes it testable.
 *
 * Deliberately separate from `buildWallPolicies` below: the ZeroDev Policy objects
 * are opaque once constructed, so asserting on them proves little. This returns
 * the thing that actually defines the wall, in a shape a test can read.
 */
export function buildCallPermissions(
  caps: GrantCaps,
  /**
   * The agent's own smart-account address — where value must land.
   *
   * REQUIRED, not optional with a fallback. An optional parameter would let a
   * caller silently rebuild the OLD wall, where the swap recipient and the
   * vault receiver were unconstrained, and nothing would fail — which is
   * exactly how the signature hole (WALL_POLICY_FLAG) survived: a default that
   * happened to be permissive.
   *
   * Available at policy-build time because the Kernel address derives from the
   * SUDO validator alone; the permission plugin is enabled at UserOp time and
   * does not affect it. Both signers derive a sudo-only account first, pin it
   * here, and then assert the final account matches.
   */
  smartAccount: Address,
  opts: WallOptions = {},
) {
  // The adapter address is validated HERE, at the last point before it
  // becomes on-chain policy — a malformed address in a call permission is a
  // policy that can never match anything, i.e. a bricked route that looks
  // granted. Throwing beats sealing garbage into a signature.
  let adapter: Address | undefined;
  if (opts.v4AdapterAddress !== undefined) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(opts.v4AdapterAddress)) {
      throw new Error(`v4AdapterAddress is not an address: ${JSON.stringify(opts.v4AdapterAddress)}`);
    }
    adapter = opts.v4AdapterAddress.toLowerCase() as Address;
  }
  let ponsAdapter: Address | undefined;
  if (opts.ponsAdapterAddress !== undefined) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(opts.ponsAdapterAddress)) {
      throw new Error(`ponsAdapterAddress is not an address: ${JSON.stringify(opts.ponsAdapterAddress)}`);
    }
    ponsAdapter = opts.ponsAdapterAddress.toLowerCase() as Address;
  }
  // Native value the router rule may carry. Sealed at signing: this is the
  // security ceiling for auto-convert, deliberately NOT a settings knob — the
  // owner's live knob is the reserve PERCENTAGE in settings, which decides how
  // much converts but can never lift what one op may attach.
  const nativeSwapValueLimit = opts.nativeSwapValueLimitWei ?? NATIVE_SWAP_VALUE_LIMIT_WEI;
  const spenders = allowedSpenders(opts.allowRialto, opts.allowUniswapV4, adapter, ponsAdapter);
  const extras = usableExtraTokens(opts.extraTokens);
  // Every asset this signature may hold a leg in: USDG plus everything the
  // approve permissions below cover. This is what the adapter's tokenIn and
  // tokenOut are pinned to — same source, same call, so the approve set and
  // the swap set cannot drift apart within one grant.
  const adapterAssets: Address[] = [
    CASH.USDG as Address,
    ...STOCK_TOKENS.filter((t) => (TRADEABLE_SYMBOLS as readonly string[]).includes(t.symbol)).map(
      (t) => t.address as Address,
    ),
    ...extras.map((t) => t.address as Address),
  ];
  // tokenIn for the router rule adds WETH, and WETH only. The auto-convert flow
  // swaps NATIVE ETH → USDG, and SwapRouter02 identifies a native-input swap by
  // `tokenIn` being the WETH address with `msg.value` attached (it wraps and
  // refunds excess internally) — so without WETH here, no key could ever run a
  // convert, and every pre-existing grant must RE-SIGN to gain it. tokenOut
  // stays the plain asset set on purpose: a convert only ever PRODUCES an
  // allowlisted asset, so the widen is on what may be spent, never on what may
  // be received.
  const swapInAssets: Address[] = [...adapterAssets, CASH.WETH as Address];
  const self = { condition: ParamCondition.EQUAL, value: smartAccount } as const;
  // Deduped and lowercased so a list with the same address twice doesn't bloat
  // the on-chain policy, and a case difference can't read as a second address.
  const withdrawals = [
    ...new Set((opts.withdrawalAddresses ?? []).map((a) => a.toLowerCase() as Address)),
  ];

  return [
    {
      // approve USDG, only to the allowed spenders, only up to one trade's size.
      target: CASH.USDG as Address,
      valueLimit: 0n,
      abi: erc20Abi,
      functionName: "approve",
      args: [
        { condition: ParamCondition.ONE_OF, value: spenders },
        { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: usdgUnits(caps.perTradeUsdg) },
      ],
    },
    // approve the TRADEABLE stock tokens so the agent can SELL what it may buy.
    // No amount condition: share counts are 18dp and not comparable to a USDG
    // cap, and a router can only pull what was approved — while the USDG cap
    // above already bounds what could ever have been bought.
    ...STOCK_TOKENS.filter((t) => (TRADEABLE_SYMBOLS as readonly string[]).includes(t.symbol)).map(
      (t) =>
        ({
          target: t.address as Address,
          valueLimit: 0n,
          abi: erc20Abi,
          functionName: "approve",
          args: [{ condition: ParamCondition.ONE_OF, value: spenders }, null],
        }) as const,
    ),
    // Owner-added tokens, same shape and same routers. Present ONLY because the
    // owner listed them and is signing this grant right now — which is precisely
    // why the wall cannot widen by itself.
    ...extras.map(
      (t) =>
        ({
          target: t.address as Address,
          valueLimit: 0n,
          abi: erc20Abi,
          functionName: "approve",
          args: [{ condition: ParamCondition.ONE_OF, value: spenders }, null],
        }) as const,
    ),
    // USDG out of the wall — ONLY to addresses the owner registered, and only
    // one trade's worth per call. Absent entirely when the list is empty, which
    // is the default: no registered destination, no power to send.
    //
    // The recipient used to be free-form, leaving the per-call amount as the
    // only on-chain bound — and since the daily USDG cap lives off-chain in the
    // worker, a compromised worker's real ceiling was perTradeUsdg ×
    // maxOpsPerDay per day, every day, until expiry.
    ...(withdrawals.length > 0
      ? [
          {
            target: CASH.USDG as Address,
            valueLimit: 0n,
            abi: erc20Abi,
            functionName: "transfer",
            args: [
              { condition: ParamCondition.ONE_OF, value: withdrawals },
              { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: usdgUnits(caps.perTradeUsdg) },
            ],
          } as const,
        ]
      : []),
    // Rialto router: target-scoped ONLY, because its calldata comes from a
    // quote API and has no shape to constrain — so this permission is "call
    // anything on this contract". Opt-in for that reason; absent by default.
    ...(opts.allowRialto
      ? [
          {
            target: RIALTO.routerSnapshot as Address,
            valueLimit: 0n,
          } as const,
        ]
      : []),
    {
      // Uniswap SwapRouter02: exactInputSingle only, AND the output must land
      // in the agent's own account.
      //
      // Without the recipient pin, the approve cap above bounds only how much
      // can be spent per call — not who receives the proceeds. A compromised
      // agent could swap USDG for a token and direct the output anywhere, over
      // and over, up to the daily cap. "Bounded by the approve cap" was true
      // and beside the point: the money still left.
      //
      // WHY THE ARGS ARRAY IS SEVEN LONG FOR A ONE-PARAMETER FUNCTION. The
      // call policy maps args[i] to calldata offset i*32 (see
      // @zerodev/permissions callPolicyUtils getPermissionFromABI) — a FLAT
      // positional mapping with no ABI arity check. ExactInputSingleParams is
      // a tuple of seven STATIC members, so the ABI encoder lays it out inline
      // as seven consecutive words rather than behind a pointer. Index 3 is
      // therefore exactly `recipient`.
      //
      // That alignment is real but fragile: it depends on the tuple staying
      // all-static and the member order not moving. wall.test.ts proves the
      // offset against viem's own encoder rather than against this reasoning —
      // if SwapRouter02's struct ever changes, that test fails loudly instead
      // of the policy quietly constraining the wrong word.
      //
      // BOTH TOKEN LEGS ARE PINNED, and the recipient pin alone was not enough.
      // With `tokenOut` open, a stolen session key needed two calls and one
      // UserOp: approve the router for a stock (the amount is deliberately
      // uncapped — share counts are 18dp and not comparable to a USDG cap),
      // then `exactInputSingle{tokenIn: STOCK, tokenOut: <token the attacker
      // minted>, amountIn: the whole balance, amountOutMinimum: 0}`. The
      // recipient pin is satisfied: the account duly RECEIVES the worthless
      // token. The stocks left via the pool, so the ops-per-day cap never
      // bites — one op is enough to convert the entire non-cash book.
      //
      // The paragraph below at the v4 adapter already described this attack and
      // said the adapter's ONE_OF pin closes it; the adapter has never shipped
      // (allowUniswapV4 is hardcoded false in both signers), so the pin belongs
      // here, on the route grants actually carry. Same list, same variable as
      // the approve permissions above — `adapterAssets` — so the set a key may
      // APPROVE and the set it may SWAP INTO cannot drift apart within a grant.
      //
      // Cost: one bytes32 per allowed address per rule, so two legs over the
      // default 15-address list is ~960 bytes of extra enable-data, paid once
      // on the first UserOp of each session key.
      target: UNISWAP.swapRouter02 as Address,
      // The ONE rule in this wall that may carry native value — see
      // WallOptions.nativeSwapValueLimitWei. Auto-convert is a native-input
      // swap, and a native-input swap without msg.value simply does not exist.
      valueLimit: nativeSwapValueLimit,
      abi: UNISWAP_SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [
        { condition: ParamCondition.ONE_OF, value: swapInAssets },
        { condition: ParamCondition.ONE_OF, value: adapterAssets },
        null,
        self,
        null,
        null,
        null,
      ],
    },
    // MULTI-HOP (`exactInput`) IS GONE, and it cannot come back in this shape.
    //
    // It used to sit here with `args: [null, null, self]` — the recipient
    // pinned at word 2, everything else open. The comment defending it argued
    // that a longer path "buys a worse price, not somebody else's tokens",
    // which was true only while its single-hop sibling was equally open. Now
    // that `exactInputSingle` pins both token legs, this permission is the
    // loosest door in the wall: the output token lives inside a packed `path`
    // and can be anything at all.
    //
    // AND THE PATH CANNOT BE CONSTRAINED. `SLICE_EQUAL` is the only condition
    // in the library aimed at dynamic bytes, and it is unavailable twice over:
    // it requires CallPolicyVersion V0_0_5 while this wall pins V0_0_4, and
    // even there it resolves the argument type from the ABI, where
    // ExactInputParams is a `tuple` and never a `bytes`. A fixed-offset rule
    // cannot help either — the path is `token(20) ‖ fee(3) ‖ token(20) …`, so
    // the output token straddles two words and its word index MOVES with the
    // hop count. There is no word that equals a token address.
    //
    // WHAT THIS COSTS, said plainly: roughly three quarters of this chain's
    // pools quote against WETH, so any token with no direct USDG pair becomes
    // unreachable. That is a real loss of reach and it is the honest trade —
    // the alternative is shipping a hole that cannot be closed. The way back is
    // an adapter with static args (V4SelfSwap is the pattern), not this.
    // ── the V4SelfSwap adapter, when the owner opted in ──────────────────
    //
    // ONE permission, and STRICTER than the v3 routes above it. `swapExactIn`
    // has eight all-static arguments, so each maps to its own calldata word
    // and each is individually pinnable — proven against viem's encoder in
    // wall.test.ts, the same way the two routes above are.
    //
    // tokenIn and tokenOut are pinned ONE_OF over the same asset set the
    // approve targets derive from — USDG plus every token this signature can
    // approve for a sell. Computed inside this same call from the same
    // `extras`, so the two lists cannot drift within one grant. That closes
    // the attack the v3 routes still accept: a stolen session key minting a
    // worthless token and swapping the whole approved balance into it costs
    // the attacker only gas. Here, both legs must be assets the OWNER named.
    // The cost of that strictness is zero, not small: a new token needs a
    // re-sign to be SELLABLE anyway (the no-exit rule), so being pinned here
    // adds no friction that does not already exist.
    //
    // The words left null are null for stated reasons. amountIn (word 5) is
    // denominated in tokenIn's own units — a USDG-derived cap would be
    // meaningless on a sell — and the approve caps above are the real bound:
    // the adapter can only pull what was approved, and pulls are further
    // bounded by its own PullExceedsAmountIn check. minAmountOut (word 6) is
    // denominated in the OUTPUT token, so no single figure means anything
    // across pairs; the adapter's NoOutput guard is what stops a null here
    // meaning "zero is acceptable". hooks (word 4) is null DELIBERATELY:
    // hooked pools are the entire point (new pairs launch through them), and
    // a hostile hook is inside the adapter's tested threat model — it can
    // worsen a price, never redirect the output or overdraw the pull.
    //
    // And the word that is not here at all is the reason this contract
    // exists: there is no recipient argument. It is msg.sender, in bytecode.
    ...(adapter
      ? [
          {
            target: adapter,
            valueLimit: 0n,
            abi: V4SELFSWAP_ABI,
            functionName: "swapExactIn",
            args: [
              { condition: ParamCondition.ONE_OF, value: adapterAssets },
              { condition: ParamCondition.ONE_OF, value: adapterAssets },
              null, // fee — any tier the pool actually has
              null, // tickSpacing — pool identity, bounded by the quote
              null, // hooks — see above
              null, // amountIn — bounded by the approve caps
              null, // minAmountOut — see above
              null, // deadline
            ],
          } as const,
        ]
      : []),
    // The Pons bonding-curve adapter. Same shape, one honest difference.
    //
    // THE CURVE IS NOT PINNED AND CANNOT BE. A buy goes to a per-token curve —
    // ~475 new addresses an hour — so any ONE_OF list over word 0 is either
    // stale tomorrow or unbounded today. This comment exists to say that
    // outright, because the failure mode this file keeps warning about is a
    // comment describing intent over a policy allowing the opposite, and a
    // reader skimming `null` deserves to know it is deliberate rather than an
    // oversight.
    //
    // What still binds: both asset legs are pinned to the SAME list the approve
    // permissions cover — same variable, same call, so the trade set cannot
    // drift from the approve set within one grant — the size is bounded by
    // those approves, and the adapter delivers only to msg.sender, verified
    // against the account's own balance rather than the curve's claim.
    //
    // `valueLimit: 0n` like every other entry here, and that is load-bearing
    // rather than incidental: the adapter is non-payable, which is exactly why
    // native-quoted curves are out of reach and why granting this does not
    // become the first permission in the wall that can move native ETH.
    ...(ponsAdapter
      ? [
          {
            target: ponsAdapter,
            valueLimit: 0n,
            abi: PONS_SELFTRADE_ABI,
            functionName: "tradeExactIn",
            args: [
              null, // curve — unpinnable, see above
              { condition: ParamCondition.ONE_OF, value: adapterAssets },
              { condition: ParamCondition.ONE_OF, value: adapterAssets },
              null, // amountIn — bounded by the approve caps
              null, // minAmountOut — denominated in the output asset, says nothing useful
              null, // deadline
            ],
          } as const,
        ]
      : []),
    {
      // Morpho vault deposits, capped per call at the daily limit — and the
      // SHARES must come back to the agent's own account.
      //
      // Not in the original five exits, found while pinning the withdrawal:
      // deposit(assets, receiver) mints vault shares to `receiver`. Unpinned,
      // a compromised agent could spend the owner's USDG and mint the shares
      // to itself elsewhere — the money leaves just as surely as a transfer,
      // only wearing a deposit's clothes.
      target: MORPHO.steakhouseUsdgVault as Address,
      valueLimit: 0n,
      abi: VAULT_ABI,
      functionName: "deposit",
      args: [{ condition: ParamCondition.LESS_THAN_OR_EQUAL, value: usdgUnits(caps.dailyUsdg) }, self],
    },
    {
      // Withdrawals are unrestricted in SIZE — money coming home is not a risk
      // the wall needs to bound. But "coming home" has to be enforced, not
      // assumed: withdraw(assets, receiver, owner) takes a receiver, and with
      // no args at all the session key could drain the entire vault position
      // to any address in one call, uncapped, because the size rule that would
      // have bounded it was deliberately absent.
      //
      // The old comment described the INTENT ("money coming home") while the
      // policy permitted the opposite. Size stays unbounded; the destination
      // does not.
      target: MORPHO.steakhouseUsdgVault as Address,
      valueLimit: 0n,
      abi: VAULT_ABI,
      functionName: "withdraw",
      args: [null, self, null],
    },
    // The v4 pair — OPT-IN, and off by default. See WallOptions.allowUniswapV4
    // for why, and note these two travel together with the Permit2 spender in
    // allowedSpenders: any one of the three alone is inert, all three is a
    // drain. Granting them individually is how this became a hole.
    ...(opts.allowUniswapV4
      ? [
          {
            // Permit2 may be told to grant an allowance, but ONLY to the
            // UniversalRouter. Without that EQUAL condition this single
            // permission would let the session key hand any spender an
            // allowance on any token — strictly more power than trading.
            //
            // The token, the amount and the expiration all stay unconstrained,
            // so this is a bound on WHO, never on how much or for how long.
            // That is precisely why the whole pair is opt-in.
            target: UNISWAP.permit2 as Address,
            valueLimit: 0n,
            abi: PERMIT2_ABI,
            functionName: "approve",
            args: [null, { condition: ParamCondition.EQUAL, value: UNISWAP.universalRouter as Address }, null, null],
          },
          {
            // The UniversalRouter executes opaque command bundles, so a call
            // policy cannot constrain its calldata — including the recipient.
            // Nothing upstream bounds it either: the Permit2 allowance above
            // is uncapped and non-expiring as far as the POLICY is concerned.
            // Enabling this grants "move approved tokens anywhere".
            target: UNISWAP.universalRouter as Address,
            valueLimit: 0n,
            abi: UNIVERSAL_ROUTER_ABI,
            functionName: "execute",
          },
        ]
      : []),
  ];
}

/**
 * The complete policy set for a grant: expiry, rate limit, and the call policy.
 *
 * `now` is injectable so a test can assert the timestamps rather than racing the
 * clock. Callers should leave it alone.
 */
export function buildWallPolicies(args: {
  caps: GrantCaps;
  /** The agent's own account — see buildCallPermissions. Required, never defaulted. */
  smartAccount: Address;
  now?: number;
} & WallOptions) {
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const expiresAt = now + args.caps.expiryDays * 86_400;

  const policies = [
    // Hard expiry — the key dies even if every other control fails.
    toTimestampPolicy({ validAfter: now, validUntil: expiresAt }),
    // THE RATE LIMIT POLICY IS GONE, because it was never there.
    //
    // `toRateLimitPolicy({count: maxOpsPerDay, interval: 86_400})` used to sit
    // on this line. Its `policyAddress` defaults to RATE_LIMIT_POLICY_CONTRACT
    // in @zerodev/permissions — and that address has NO CODE on Robinhood
    // Chain. Measured 2026-08-30 with eth_getCode against both live RPCs:
    //
    //   RateLimitPolicy  0xf63d4139B25c836334edD76641356c6b74C86873   0 bytes on 4663 AND 46630
    //   TimestampPolicy  0xB9f8f524bE6EcD8C945b1b87f9ae5C192FdCE20F   1,441 bytes
    //   CallPolicy V4    0x9a52283276A0ec8740DF50bF01B28A80D880eaf2   6,539 bytes
    //   ECDSA signer     0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF   1,609 bytes
    //
    // So every grant this repo could produce installed a policy pointing at an
    // empty address. Kernel calls `checkUserOpPolicy` expecting a uint256; a
    // call to a codeless address succeeds with zero returndata. That is not
    // "ops go unlimited" — it is most likely EVERY UserOp failing validation,
    // which is consistent with this project never having landed a trade.
    //
    // A policy that cannot execute is not a bound. Leaving it in traded a
    // guarantee we did not have for a failure mode we could not diagnose.
    //
    // SAY THE COST OUT LOUD. maxOpsPerDay is now enforced by the WORKER only,
    // alongside the daily total and the drawdown breaker. The on-chain ceiling
    // is per-trade × (however many ops fit before expiry) — see the header.
    //
    // And it was never the cap it was described as, even where the contract IS
    // deployed: RateLimitPolicy decrements a LIFETIME counter and returns
    // packValidationData(startAt); this call never passed `startAt`, so it
    // defaulted to 0 and imposed no spacing at all. It was maxOpsPerDay ops
    // TOTAL per grant, with no daily refill — not "48 a day".
    //
    // The fix that would restore a real on-chain bound is to deploy the policy
    // singleton to 4663 ourselves and pass `policyAddress`. That is a contract
    // deployment and it is deliberately not bundled with this correction.
    toCallPolicy({
      policyVersion: CallPolicyVersion.V0_0_4,
      // EVERY adapter must be forwarded, and the type system will not tell you.
      // `ponsAdapterAddress` was missing here and it type-checked, because this
      // function's argument is an intersection with WallOptions — so the field
      // was accepted at the call site and silently dropped one line later. The
      // result would be the exact failure the grant module warns about: a
      // signature carrying the `pons-adapter` MARKER and a sealed address, over
      // a call policy with no `tradeExactIn` permission and no adapter in the
      // approve spender set. `limitsFromGrant` would allow the target, the
      // worker would build the UserOp, and both calls would revert at the wall.
      // A mirror looser than the chain is the one shape this file exists to
      // prevent.
      permissions: buildCallPermissions(args.caps, args.smartAccount, {
        extraTokens: args.extraTokens,
        withdrawalAddresses: args.withdrawalAddresses,
        allowRialto: args.allowRialto,
        allowUniswapV4: args.allowUniswapV4,
        v4AdapterAddress: args.v4AdapterAddress,
        ponsAdapterAddress: args.ponsAdapterAddress,
      }) as never,
    }),
  ];

  return { policies, now, expiresAt };
}
