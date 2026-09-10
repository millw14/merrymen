/**
 * Building the calls for a CLASS trade — one through the per-account vault.
 *
 * A SIBLING OF pons-trade.ts, not a branch inside it, and for a sharper reason
 * than that file gives for its own separation. The two differ in the one place a
 * shared function would be most tempting to unify: `buildCurveTradeCalls`
 * returns TWO calls and this returns two for a buy and exactly ONE for a sell,
 * because a class sell needs no approve. Folding them together would put a
 * branch on `side` inside a builder, and the failure mode of getting that branch
 * wrong is emitting an approve the wall refuses — which reverts the whole
 * UserOp, on the exit path, at the moment an owner most needs it to work.
 *
 * The other thing that must never be shared is `checked128`. PonsSelfTrade's ABI
 * is uint128 and this contract's is uint256 (see abis.ts, which explains that
 * the width is part of the selector). Copying the guard across would refuse
 * trades the chain accepts — a mirror stricter than the chain, in the encoder,
 * where nothing else would ever look for it.
 *
 * Returns executor's `Call`, whose `value` is a plain bigint, for the reason
 * pons-trade.ts records: the Uniswap layer's identically-named type pins `value`
 * to the literal `0n`, and that literal is load-bearing documentation there.
 * Everything here emits `value: 0n` anyway — the vault is non-payable, which is
 * what lets its permissions carry `valueLimit: 0`.
 */
import { encodeFunctionData } from "viem";
import {
  PONS_CLASS_VAULT_ABI,
  PONS_CLASS_VAULT_FACTORY_DEPLOY_ABI,
} from "../../../packages/core/src/index";
import type { Call } from "../executor";

/** The ERC-20 approve the account gives the vault. Its own literal, see below. */
const APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export interface ClassBuy {
  /** The GRANT-SEALED vault. What the wall pinned; never re-derived at tick time. */
  vault: `0x${string}`;
  /** The bonding curve. An argument the wall cannot pin — a new address per launch. */
  curve: `0x${string}`;
  /**
   * The FUNDING asset — word 1, and the one word the wall pins ONE_OF the
   * sealed set. The class token is not an argument to this call at all; the
   * vault derives it from the curve.
   */
  quoteAsset: `0x${string}`;
  quoteInRaw: bigint;
  /** Slippage floor in the class token's units, enforced on-chain by the vault. */
  minTokensOutRaw: bigint;
  /** Unix seconds. */
  deadline: bigint;
}

export interface ClassSell {
  vault: `0x${string}`;
  curve: `0x${string}`;
  /** Units of the class token the vault holds. It can sell nothing else. */
  tokensInRaw: bigint;
  /** Floor in the curve's quote asset, which the vault reads from the curve. */
  minQuoteOutRaw: bigint;
  deadline: bigint;
}

/**
 * TWO CALLS: approve the vault, then buy.
 *
 * The approve is the account's ordinary, already-granted quote approve — the
 * vault joins `allowedSpenders` precisely so this is expressible, and it gains
 * no approve permission of its own. Sized to EXACTLY `quoteInRaw`, never max,
 * for pons-trade.ts's reason plus one specific to here: the other two adapters
 * hand back everything they take within the call, and this contract KEEPS the
 * token. A standing licence to a contract that keeps things is a different
 * proposition from one to a contract that cannot.
 */
export function buildClassBuyCalls(t: ClassBuy): Call[] {
  if (t.quoteInRaw <= 0n) throw new Error("class buy: quoteInRaw must be positive");
  // STRICTER THAN THE ADAPTER PATH, deliberately, and this is the one place
  // that difference is worth arguing. `buildCurveTradeCalls` tolerates a zero
  // floor because the wall pins BOTH its asset legs, so a bad fill is still a
  // fill in an asset the owner named. Here the output leg is un-enumerated by
  // design — the floor is the only thing standing between a trade and a token
  // nobody vouched for. The contract's own NoOutput refuses exactly zero and
  // nothing more, and all three producers already refuse a null floor, so this
  // makes an invariant structural instead of repeated in four places.
  if (t.minTokensOutRaw <= 0n) throw new Error("class buy: minTokensOutRaw must be positive");
  if (/^0x0{40}$/i.test(t.quoteAsset)) {
    // A native-quoted curve. The approve below would encode against a codeless
    // address and SUCCEED silently (a CALL to no code returns empty success),
    // and the vault would then revert NativeQuoteNotSupported having already
    // spent the gas. Refuse before building.
    throw new Error("class buy: the zero address is not a quote asset — native-quoted curves are out of reach");
  }
  if (t.vault.toLowerCase() === t.curve.toLowerCase()) {
    throw new Error("class buy: the vault cannot be its own curve");
  }
  return [
    {
      to: t.quoteAsset,
      value: 0n,
      data: encodeFunctionData({
        abi: APPROVE_ABI,
        functionName: "approve",
        args: [t.vault, t.quoteInRaw],
      }),
    },
    {
      to: t.vault,
      // Zero, and it is why native-quoted curves stay unreachable: the vault is
      // non-payable so its permissions keep valueLimit 0, and the account never
      // sends native value.
      value: 0n,
      data: encodeFunctionData({
        abi: PONS_CLASS_VAULT_ABI,
        functionName: "buy",
        args: [t.curve, t.quoteAsset, t.quoteInRaw, t.minTokensOutRaw, t.deadline],
      }),
    },
  ];
}

/**
 * ONE CALL. NO APPROVE. This is the entire reason the contract exists.
 *
 * The tokens are already in the vault, which approves the curve from inside
 * itself. The account has no allowance to give and — this is the load-bearing
 * half — COULD NOT give one: an approve's target is the token contract, and the
 * wall carries no permission for a token nobody enumerated. So an approve leg
 * here is not merely redundant, it is a call the wall refuses, and a refused
 * call reverts the whole UserOp. On the exit path.
 *
 * If this function ever returns two calls, the class route has no exit.
 */
export function buildClassSellCalls(t: ClassSell): Call[] {
  if (t.tokensInRaw <= 0n) throw new Error("class sell: tokensInRaw must be positive");
  if (t.minQuoteOutRaw <= 0n) throw new Error("class sell: minQuoteOutRaw must be positive");
  return [
    {
      to: t.vault,
      value: 0n,
      data: encodeFunctionData({
        abi: PONS_CLASS_VAULT_ABI,
        functionName: "sell",
        args: [t.curve, t.tokensInRaw, t.minQuoteOutRaw, t.deadline],
      }),
    },
  ];
}

/**
 * Create the vault. Prepended to the first class buy when it has no code.
 *
 * NOT OPTIONAL, and not a convenience. A CALL to an address with no code
 * succeeds with empty returndata, so a buy against an undeployed vault does not
 * revert — it approves the USDG, no-ops, and reports a landed trade that bought
 * nothing. The caller must decide from a FRESH `getCode` immediately before
 * building, never from a cached flag: the answer changes the moment the first
 * class buy of the arm lands.
 */
export function buildClassVaultDeployCall(
  factory: `0x${string}`,
  owner: `0x${string}`,
): Call {
  return {
    to: factory,
    value: 0n,
    data: encodeFunctionData({
      abi: PONS_CLASS_VAULT_FACTORY_DEPLOY_ABI,
      functionName: "deploy",
      args: [owner],
    }),
  };
}
