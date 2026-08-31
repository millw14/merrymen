/**
 * SPONSORED GAS — so an owner funds ONE asset instead of two.
 *
 * WHY THIS EXISTS. Two users reported the same thing on the same day: "It says
 * it can't trade. Because no ETH. But there is 15 bucks in it", and "I've topped
 * up a wallet but nothing's showing". Neither was confused. On this chain the
 * money you TRADE with (USDG) and the money you pay FEES with (ETH) are
 * different assets, and 73 of the fleet's sampled account lines read
 * `eth 0 · cash 1000 USDG` — agents holding money they cannot spend.
 *
 * A paymaster pays the EntryPoint directly. The account never touches ETH, so
 * this changes WHO PAYS and nothing else: every permission in the wall keeps its
 * `valueLimit: 0n`, the session key gains no new reach, and a sponsored
 * operation faces exactly the same policies as an unsponsored one. That
 * separation is the whole reason this is a safe thing to add and a WRAPPED
 * ETH auto-swap — the other suggestion for the same problem — is not.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MEASURED, NOT ASSUMED. `pm_getPaymasterStubData` was probed against chain 4663
 * with the live key before a line of this was written, because the alternative
 * to Pimlico having a paymaster there is deploying our own contract. It answers,
 * and the exact response shape drove two decisions below:
 *
 *   stub → { paymaster, paymasterData, paymasterPostOpGasLimit }
 *   data → { paymaster, paymasterData }
 *
 * Note what is ABSENT from the stub: `paymasterVerificationGasLimit`. viem
 * re-enters `estimateUserOperationGas` when EITHER paymaster gas field is
 * undefined after the stub (prepareUserOperation.js), so leaving it absent hands
 * both numbers back to the bundler — outside every bound `gas-limits.ts` exists
 * to impose. Filling it here is what keeps them ours.
 *
 * ALLOWLIST, NOT SPREAD. Neither observed response carries callGasLimit,
 * verificationGasLimit or preVerificationGas — but viem's paymaster actions are
 * unfiltered passthroughs (`const {a, b, ...rest} = await request(); return
 * {...rest}`), and prepareUserOperation spreads the result OVER the request. So
 * a sponsor that started returning those three fields would silently replace the
 * limits `boundGas` computed, with no error and no log, and under sponsorship
 * the payer of an out-of-gas is the house. The response shape is the sponsor's
 * to change and ours to constrain, so these wrappers return a fixed set of keys
 * and drop everything else. A TypeScript return type is not a filter.
 */

import { http } from "viem";
import {
  createPaymasterClient,
  type GetPaymasterDataParameters,
  type GetPaymasterDataReturnType,
  type GetPaymasterStubDataParameters,
  type GetPaymasterStubDataReturnType,
} from "viem/account-abstraction";

/**
 * The sponsor said no, BEFORE anything was broadcast.
 *
 * A sibling of `GasRefused` and deliberately not an on-chain revert: nothing
 * reached a bundler, nothing was signed, and no gas was spent. Without its own
 * type this lands in the generic submit-failure branch and books a ledger row
 * saying `status: "reverted"` with a free-form `reject_rule` — a row asserting
 * the chain refused a trade the chain never saw, in a column every other
 * producer fills from a small vocabulary.
 */
export class SponsorRefused extends Error {
  constructor(
    readonly rule: "sponsor-refused" | "sponsor-unreachable" | "sponsor-absurd",
    detail: string,
  ) {
    super(detail);
    this.name = "SponsorRefused";
  }
}

/**
 * Limits WE choose when the sponsor does not state one, and a ceiling that
 * applies even when it does.
 *
 * Same thesis as gas-limits.ts: never sign a limit nobody checked. The ceiling
 * matters more here than there, because the account is not the one paying — an
 * absurd paymaster gas limit costs the house, and the account would never feel
 * it.
 */
export const PAYMASTER_VERIFICATION_GAS = 200_000n;
export const PAYMASTER_POSTOP_GAS = 100_000n;
/** Refuse outright above this, per field, whatever the sponsor says. */
export const PAYMASTER_GAS_MAX = 500_000n;

export interface Sponsor {
  /** For `createKernelAccountClient` — viem's own paymaster shape. */
  paymaster: {
    getPaymasterStubData: (
      p: GetPaymasterStubDataParameters,
    ) => Promise<GetPaymasterStubDataReturnType>;
    getPaymasterData: (p: GetPaymasterDataParameters) => Promise<GetPaymasterDataReturnType>;
  };
  paymasterContext: unknown;
  /**
   * For the executor's two gas PROBES, which only need the operation to be
   * shaped like a sponsored one.
   *
   * Only `getPaymasterData` is set, and that is not a typo: viem resolves BOTH
   * hooks to undefined — silently disabling the paymaster — when
   * `getPaymasterStubData` is supplied without `getPaymasterData`. Supplying
   * only the latter makes viem use it for the stub slot and skip the second
   * call, which is one sponsor round trip per probe instead of two.
   */
  estimateOnly: {
    getPaymasterData: (
      p: GetPaymasterStubDataParameters,
    ) => Promise<GetPaymasterStubDataReturnType>;
  };
}

/** Build the sponsor. `url` is Pimlico's — the same endpoint as the bundler. */
export function createSponsor(opts: { url: string; policyId?: string }): Sponsor {
  const pm = createPaymasterClient({ transport: http(opts.url) });

  const clamp = (label: string, v: bigint): bigint => {
    if (v > PAYMASTER_GAS_MAX) {
      throw new SponsorRefused(
        "sponsor-absurd",
        `the sponsor asked for ${v} ${label}, past our ${PAYMASTER_GAS_MAX} ceiling. An approve plus a ` +
          `swap does not need that, so the operation is not the one it is meant to be. Refused before signing.`,
      );
    }
    return v;
  };

  const stub = async (
    p: GetPaymasterStubDataParameters,
  ): Promise<GetPaymasterStubDataReturnType> => {
    let r: Record<string, unknown>;
    try {
      r = (await pm.getPaymasterStubData(p)) as unknown as Record<string, unknown>;
    } catch (e) {
      throw new SponsorRefused(
        "sponsor-unreachable",
        `the gas sponsor did not answer (pm_getPaymasterStubData): ${
          e instanceof Error ? e.message : String(e)
        }. That is a refusal to quote, not a quote of zero.`,
      );
    }
    const verification = asBigint(r.paymasterVerificationGasLimit) ?? PAYMASTER_VERIFICATION_GAS;
    const postOp = asBigint(r.paymasterPostOpGasLimit) ?? PAYMASTER_POSTOP_GAS;
    // BOTH fields, ALWAYS present. Either one missing sends viem back to the
    // bundler for a fresh estimate of both, and the numbers stop being ours.
    return {
      paymaster: r.paymaster,
      paymasterData: r.paymasterData,
      paymasterVerificationGasLimit: clamp("paymasterVerificationGasLimit", verification),
      paymasterPostOpGasLimit: clamp("paymasterPostOpGasLimit", postOp),
      ...(r.isFinal === true ? { isFinal: true as const } : {}),
    } as unknown as GetPaymasterStubDataReturnType;
  };

  const data = async (p: GetPaymasterDataParameters): Promise<GetPaymasterDataReturnType> => {
    let r: Record<string, unknown>;
    try {
      r = (await pm.getPaymasterData(p)) as unknown as Record<string, unknown>;
    } catch (e) {
      // The likeliest real-world refusal: a drained deposit, an exhausted
      // policy, a rate limit. All of them are "no" rather than "not now".
      throw new SponsorRefused(
        "sponsor-refused",
        `the gas sponsor declined this operation (pm_getPaymasterData): ${
          e instanceof Error ? e.message : String(e)
        }. Nothing was signed and nothing was sent.`,
      );
    }
    const verification = asBigint(r.paymasterVerificationGasLimit);
    const postOp = asBigint(r.paymasterPostOpGasLimit);
    return {
      paymaster: r.paymaster,
      paymasterData: r.paymasterData,
      ...(verification === undefined
        ? {}
        : { paymasterVerificationGasLimit: clamp("paymasterVerificationGasLimit", verification) }),
      ...(postOp === undefined
        ? {}
        : { paymasterPostOpGasLimit: clamp("paymasterPostOpGasLimit", postOp) }),
    } as unknown as GetPaymasterDataReturnType;
  };

  return {
    paymaster: { getPaymasterStubData: stub, getPaymasterData: data },
    paymasterContext: opts.policyId ? { sponsorshipPolicyId: opts.policyId } : undefined,
    estimateOnly: { getPaymasterData: stub },
  };
}

/** `0x…` or a bigint or a number → bigint. Anything else → undefined, never 0n. */
function asBigint(v: unknown): bigint | undefined {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(v);
  if (typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v)) return BigInt(v);
  return undefined;
}

/**
 * Did the limits we bounded survive the sponsor?
 *
 * THE POST-CONDITION, and the reason the allowlist above is not the only guard.
 * viem spreads the paymaster's reply over the prepared request, so a sponsor
 * returning `callGasLimit` would overwrite the number `boundGas` signed off on —
 * silently, because the shape is valid. The allowlist stops OUR wrappers from
 * propagating that; this proves it stayed stopped, against the operation that is
 * actually about to be signed.
 *
 * Pure and exported so the check is testable without a sponsor, a bundler or a
 * chain — the same discipline gas-limits.ts is built on.
 */
export function assertBoundsHeld(
  bounded: { callGasLimit: bigint; verificationGasLimit: bigint; preVerificationGas: bigint },
  prepared: Partial<Record<string, unknown>>,
): void {
  for (const field of ["callGasLimit", "verificationGasLimit", "preVerificationGas"] as const) {
    const got = asBigint(prepared[field]);
    if (got === undefined) continue; // not reported back; nothing to contradict
    if (got !== bounded[field]) {
      throw new SponsorRefused(
        "sponsor-absurd",
        `the sponsor changed ${field} from ${bounded[field]} to ${got}. Gas limits are bounded before ` +
          `signing precisely so nobody else picks them, and under sponsorship an under-provisioned ` +
          `operation is paid for by the house. Refused.`,
      );
    }
  }
}
