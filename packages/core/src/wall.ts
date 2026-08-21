import { erc20Abi, parseAbi, type Address } from "viem";
import { PolicyFlags } from "@zerodev/permissions";
import { CallPolicyVersion, ParamCondition, toCallPolicy } from "@zerodev/permissions/policies";
import { toRateLimitPolicy, toTimestampPolicy } from "@zerodev/permissions/policies";
import { UNISWAP_SWAP_ROUTER_ABI, PERMIT2_ABI, UNIVERSAL_ROUTER_ABI } from "./abis";
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
 * The only contracts a token approval may ever name as spender.
 *
 * Permit2 is here only to serve the v4 route, and follows the same opt-in: v4
 * never pulls tokens directly, so the account approves PERMIT2 and Permit2
 * grants the router its allowance — the router itself is approved for nothing.
 */
export function allowedSpenders(allowRialto = false, allowUniswapV4 = false): Address[] {
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
}

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
  const spenders = allowedSpenders(opts.allowRialto, opts.allowUniswapV4);
  const extras = usableExtraTokens(opts.extraTokens);
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
      target: UNISWAP.swapRouter02 as Address,
      valueLimit: 0n,
      abi: UNISWAP_SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [null, null, null, self, null, null, null],
    },
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
    // Bounded ops per day, so a runaway loop cannot spam trades.
    toRateLimitPolicy({ count: args.caps.maxOpsPerDay, interval: 86_400 }),
    toCallPolicy({
      policyVersion: CallPolicyVersion.V0_0_4,
      permissions: buildCallPermissions(args.caps, args.smartAccount, {
        extraTokens: args.extraTokens,
        withdrawalAddresses: args.withdrawalAddresses,
        allowRialto: args.allowRialto,
        allowUniswapV4: args.allowUniswapV4,
      }) as never,
    }),
  ];

  return { policies, now, expiresAt };
}
