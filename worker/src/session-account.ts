/**
 * REBUILD THE SESSION ACCOUNT WITH THE POLICY FLAG THE OWNER ACTUALLY SIGNED.
 *
 * THE BUG THIS EXISTS FOR. `WALL_POLICY_FLAG` is `NOT_FOR_VALIDATE_SIG`
 * (`0x0002`), and both signers pass it to `toPermissionValidator`. It is the
 * only thing standing between a session key and an ERC-1271 signature the
 * account will honour — a class of spend no CALL policy can constrain, because
 * it never becomes a UserOp at all.
 *
 * It never reached the chain. Traced through @zerodev/permissions 5.6.3:
 *
 *   toPermissionValidator.ts:47-67   getEnableData() emits
 *                                    concat([flag, signerContract, signerData]).
 *                                    THE OWNER SIGNS OVER THIS.
 *   toPermissionValidator.ts:131-136 getPluginSerializationParams() returns
 *                                    {policies, permissionId}. NO FLAG — and
 *                                    types.ts:66-69 has no field for one.
 *   deserializePermissionAccount:61  rebuilds toPermissionValidator({...}) with
 *                                    no flag, so :37 defaults it to
 *                                    FOR_ALL_VALIDATION (0x0000).
 *
 * `permissionId` IS carried, so `getIdentifier()` still matches and the
 * validator installs under the right id — with the WRONG enable data. The owner
 * signed a blob beginning `0x0002`; the worker computes and submits one
 * beginning `0x0000`. Kernel recomputes the EIP-712 digest from the SUBMITTED
 * enable data and recovers someone who is not the owner.
 *
 * So the first UserOperation of every flagged grant fails at plugin-enable —
 * and only the first, because only the first carries enable data. That is
 * consistent with this project never having landed a trade, though it is not
 * proof of it: no UserOp has ever been sent.
 *
 * It also makes `wall.ts`'s claim — "The flag travels ON-CHAIN in the
 * validator's enable data, so the account itself enforces it — this is not a
 * client-side promise" — wrong about merrymen's own path. It is true of the
 * signing side and false of the submitting side, which is the half that counts.
 *
 * WHY REBUILD FROM THE SERIALIZED PARAMS rather than from the grant's caps.
 * `buildWallPolicies` could regenerate these policies — `grantedAt` is exactly
 * the `now` it was called with — but the CALL policy also depends on
 * `extraTokens`, and a grant stores only their ADDRESSES (`grantTokens`), not
 * the symbol/decimals a CustomToken carries. Reproducing from caps would be
 * right most of the time, and "most of the time" is not a property to build a
 * wall on. The serialized params are what was signed, so replaying them is
 * exact by construction.
 *
 * WHAT MAKES THIS SAFE. Getting the rebuild wrong yields a different permission
 * id, which is a dead grant — so the id is recomputed WITHOUT being told the
 * answer and compared against the stored one. A mismatch refuses to arm. That
 * check is byte-level: `getPermissionId` hashes `[toPolicyId(policies), flag,
 * toSignerId(signer)]`, so agreement means the policies AND the flag AND the
 * signer all reproduce what the owner signed. The account address is then
 * checked independently.
 *
 * Every import below is a published entry point (`@zerodev/permissions`,
 * `/signers`, `@zerodev/sdk`, `@zerodev/sdk/accounts`). Nothing reaches past a
 * package's `exports` map.
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { decodeParamsFromInitCode, toPermissionValidator } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { toCallPolicy, toRateLimitPolicy, toTimestampPolicy } from "@zerodev/permissions/policies";
import { createKernelAccount } from "@zerodev/sdk";
import { toKernelPluginManager } from "@zerodev/sdk/accounts";
import { KERNEL_V3_3 } from "@zerodev/sdk/constants";
import {
  assertDerivedAccount,
  derivationOf,
  derivationUnreachable,
  type Derivation,
} from "../../packages/core/src/index";

/**
 * The serialized blob's shape (serializePermissionAccount.ts:54-63).
 *
 * Deliberately loose. This is a foreign format we are replaying, not a type we
 * own, and a precise interface here would be a second place to keep in sync
 * with a package that has already surprised us once.
 */
interface SerializedParams {
  permissionParams: { policies?: { policyParams: { type: string } }[]; permissionId?: Hex };
  action: unknown;
  validityData: Record<string, unknown>;
  accountParams: { initCode: Hex; accountAddress: `0x${string}` };
  enableSignature?: Hex;
  privateKey?: Hex;
  eip7702Auth?: unknown;
  isPreInstalled?: boolean;
}

/** base64 → the params object. Mirrors utils.ts:4-7 and :38-42 exactly. */
function decodeParams(serialized: string): SerializedParams {
  const binString = atob(serialized);
  const bytes = Uint8Array.from(binString, (m) => m.codePointAt(0) as number);
  // A PLAIN JSON.parse, with no bigint reviver — matching the package, which
  // also does none. Numeric policy fields therefore arrive as strings and the
  // toXPolicy builders coerce them, exactly as they do today. Adding a reviver
  // here would make our policies differ from the ones the package builds, which
  // is the one thing this file must not do.
  return JSON.parse(new TextDecoder().decode(bytes)) as SerializedParams;
}

/**
 * One serialized policy → a live Policy. A trimmed `createPolicyFromParams`
 * (deserializePermissionAccount.ts:100-117), which is not exported.
 *
 * EVERY KIND MERRYMEN HAS EVER SEALED, not every kind it seals today. That
 * distinction took the fleet down.
 *
 * The wall stopped installing `rate-limit` when its contract turned out to have
 * no bytecode on this chain — but a grant is a frozen signature, so every key
 * signed before that still carries one. This function only knew about the two
 * kinds the NEW wall emits, so the default threw, and `syncGrant` failed on
 * every tick for every pre-existing tenant: ten agents in a crash loop, none
 * able to arm, until this shipped.
 *
 * Rebuilding it is not optional and not a compromise. The policies are hashed
 * into the permission id and concatenated into the enable data the owner
 * signed; omitting one produces a different id, which the check below would
 * refuse anyway. To reconstruct what was signed you must reconstruct all of it.
 *
 * Doing so does NOT make an old grant able to trade — it still points at an
 * address with no code, which is why the wall dropped it. What it does is let
 * that agent arm, show its balances, run in practice mode, and be TOLD to
 * re-sign, instead of dying silently in a loop its owner cannot see.
 *
 * The default still throws, and should: an unknown policy really is a bound we
 * would be dropping. The lesson is narrower than "never throw" — it is that
 * removing a policy from the wall means adding it here, in the same change.
 */
async function policyFromParams(policy: { policyParams: { type: string } }) {
  switch (policy.policyParams.type) {
    case "call":
      return toCallPolicy(policy.policyParams as never);
    case "timestamp":
      return toTimestampPolicy(policy.policyParams as never);
    case "rate-limit":
      // Legacy only. Nothing signs one any more; see wall.ts.
      return toRateLimitPolicy(policy.policyParams as never);
    default:
      throw new Error(
        `this grant carries a '${policy.policyParams.type}' policy that merrymen cannot rebuild — refusing to arm rather than dropping it`,
      );
  }
}

/**
 * Does this serialized grant carry the dead rate-limit policy?
 *
 * Such a grant arms fine and can never land a UserOperation: the policy points
 * at an address with no bytecode on this chain, so validation has nothing to
 * call. The owner needs to re-sign, and needs to be told so in words rather
 * than by watching every trade fail.
 */
export function grantHasDeadRateLimit(serialized: string): boolean {
  try {
    return (decodeParams(serialized).permissionParams.policies ?? []).some(
      (p) => p.policyParams.type === "rate-limit",
    );
  } catch {
    return false;
  }
}

export class PermissionIdMismatch extends Error {
  constructor(readonly expected: string, readonly got: string) {
    super(
      `rebuilt permission id ${got} does not match the signed id ${expected} — ` +
        `refusing to arm. The session account could not be reconstructed exactly as it was signed.`,
    );
    this.name = "PermissionIdMismatch";
  }
}

/**
 * The grant's own initCode does not deploy the address the grant claims.
 *
 * Named, like PermissionIdMismatch, because "refusing to arm" with a bare
 * Error is what an owner sees, and the two failures mean different things: a
 * mismatched id is a wall we rebuilt wrongly, a mismatched address is a grant
 * whose two halves disagree about which account they are for.
 */
export class AccountAddressMismatch extends Error {
  constructor(
    readonly signed: `0x${string}`,
    readonly derived: `0x${string}`,
  ) {
    super(
      `this grant says it is for account ${signed}, but its own factory data deploys ${derived}. ` +
        "The two halves of the blob disagree about which account they belong to, so nothing here " +
        "can be trusted to sign for either. Refusing to arm — nothing was signed.",
    );
    this.name = "AccountAddressMismatch";
  }
}

/**
 * `deserializePermissionAccount`, plus the flag.
 *
 * Signature deliberately mirrors the package's so the two can be read side by
 * side, with `flag` as the one addition — the whole point of the file.
 */
export async function deserializeFlaggedPermissionAccount(
  client: Parameters<typeof toPermissionValidator>[0],
  entryPoint: { address: `0x${string}`; version: "0.7" },
  kernelVersion: typeof KERNEL_V3_3,
  serialized: string,
  flag: `0x${string}`,
  /**
   * Told when the re-derivation could not be completed, with the reason.
   *
   * A callback rather than a return value because every caller of this
   * function wants the ACCOUNT; the verdict is a side channel, and one that
   * must not be droppable by being ignored in a destructuring.
   */
  onUnverified?: (why: string) => void,
) {
  const params = decodeParams(serialized);
  if (!params.privateKey) {
    throw new Error("serialized grant carries no session key — nothing to sign with");
  }

  const signer = await toECDSASigner({ signer: privateKeyToAccount(params.privateKey) });
  const policies = await Promise.all((params.permissionParams.policies ?? []).map(policyFromParams));

  // FIRST, WITHOUT THE ANSWER. Passing `permissionId` makes getIdentifier()
  // return it verbatim (toPermissionValidator.ts:71-73), which would make the
  // check below tautological — it would compare the stored id with itself and
  // pass however wrong the rebuild was. So compute it fresh and compare.
  const probe = await toPermissionValidator(client, {
    signer,
    policies,
    entryPoint,
    kernelVersion,
    flag,
  } as never);

  const signedId = params.permissionParams.permissionId;
  const rebuiltId = probe.getIdentifier();
  if (signedId && rebuiltId.toLowerCase() !== signedId.toLowerCase()) {
    throw new PermissionIdMismatch(signedId, rebuiltId);
  }

  // Now pass it, matching the package: the id is part of what the account
  // installs, and the stored one is authoritative even though we just proved
  // ours equals it.
  const validator = await toPermissionValidator(client, {
    signer,
    policies,
    entryPoint,
    kernelVersion,
    flag,
    permissionId: signedId,
  } as never);

  const { index, validatorInitData, useMetaFactory } = decodeParamsFromInitCode(
    params.accountParams.initCode,
    kernelVersion,
  );

  const plugins = await toKernelPluginManager(client as never, {
    regular: validator,
    pluginEnableSignature: params.isPreInstalled ? undefined : params.enableSignature,
    validatorInitData,
    action: params.action,
    entryPoint,
    kernelVersion,
    isPreInstalled: params.isPreInstalled,
    ...params.validityData,
  } as never);

  // SECOND, INDEPENDENT CHECK — AND, AGAIN, WITHOUT THE ANSWER.
  //
  // This check used to run against an account built WITH
  // `address: params.accountParams.accountAddress`, and createKernelAccount is
  // `accountAddress = address ?? (…derive…)` (createKernelAccount.ts:263): hand
  // it the address and the derivation is skipped entirely, so the comparison
  // below compared the signed address with itself and could not fail. The same
  // trap the id check twenty lines up was deliberately written to avoid, walked
  // into by the check that claimed to be independent of it.
  //
  // So derive it. Omitting `address` sends createKernelAccount down the CREATE2
  // path — getFactoryArgs() over the grant's own initCode-derived
  // validatorInitData, index and useMetaFactory, then getSenderAddress against
  // the EntryPoint — which is the address this grant's factory data actually
  // deploys, computed from the grant rather than read off it.
  //
  // WHAT IT COSTS: one eth_call at ARM time, and this function is no longer
  // offline. That is the price of the check being real; it was free before
  // because it was doing nothing.
  //
  // WHAT IT CATCHES: an accountAddress that does not match the initCode sitting
  // beside it in the same blob. Kernel's own enable-signature check would also
  // refuse such a grant on chain (measured on 4663: AA23 reverted 0xc48cf8ee),
  // but only after arming, mirroring, showing the owner a live agent, and
  // spending a signature — and it would present as an opaque bundler code.
  // AND IT CAN THROW, which is how it took the fleet down. The derivation is
  // an eth_call, the SDK's own error path assumes any RpcRequestError carries
  // revert data, and a rate-limited node returns one that does not — so a busy
  // endpoint arrives here as `Cannot read properties of undefined (reading
  // 'match')` rather than as a refusal to answer. A network failure must not
  // be able to leave this function by a route the caller reads as a verdict.
  let check: Derivation;
  try {
    const derived = await createKernelAccount(client as never, {
      entryPoint,
      kernelVersion,
      plugins,
      index,
      useMetaFactory,
      eip7702Auth: params.eip7702Auth,
    } as never);
    check = derivationOf(derived.address);
  } catch (e) {
    check = derivationUnreachable(e instanceof Error ? e.message : String(e));
  }

  // THE GRANT'S OWN CLAIM IS CHECKED WHATEVER THE CHAIN DID. A blob carrying a
  // zero or malformed accountAddress is refused here and always — that failure
  // needs no network to see, and it is the half of the check that cannot be
  // taken away by somebody else's rate limit.
  assertDerivedAccount(params.accountParams.accountAddress, "this grant carries no usable account address");

  if (check.ok) {
    if (check.address !== params.accountParams.accountAddress.toLowerCase()) {
      throw new AccountAddressMismatch(params.accountParams.accountAddress, check.address);
    }
  } else {
    // ── A CHECK THAT COULD NOT RUN IS NOT A CHECK THAT FAILED ───────────
    //
    // This is the distinction the rest of the repo is built on, arriving at
    // the one place that had not been told: "we asked and the answer was
    // wrong" and "we never got an answer" had the same consequence here, and
    // the consequence was permanent. On 2026-09-06 twelve of thirty-two hosted
    // agents sat at status `error` with `CANNOT ARM — Cannot read properties
    // of undefined (reading 'match')` — a TypeError thrown inside the SDK's
    // own error path (@zerodev/sdk getSenderAddress, which assumes any
    // RpcRequestError carries revert data) when the chain RPC refused the call
    // this derivation makes. The fleet was being rate-limited into paralysis
    // at the time; the agents were not broken, the endpoint was busy.
    //
    // So an unverifiable derivation now REPORTS instead of refusing. That is
    // not a hole opened here: it is exactly the behaviour merrymen had before
    // this check existed, and Kernel's own enable-signature check still
    // refuses a genuinely mismatched grant on chain (measured on 4663: AA23
    // reverted 0xc48cf8ee). What is lost is one round of early warning; what
    // was being lost instead was every agent whose arm coincided with a 429.
    //
    // It is deliberately LOUD rather than silent — the caller writes it where
    // the owner can see it — because an unverified arm is a real weakening of
    // a real check, and a weakening nobody is told about is how the next
    // incident starts.
    onUnverified?.(check.why);
  }

  // Now pass it, matching the package — same shape as the id above, and for the
  // same reason: the stored value is authoritative, we have just proved ours
  // equals it.
  return createKernelAccount(client as never, {
    entryPoint,
    kernelVersion,
    plugins,
    index,
    address: params.accountParams.accountAddress,
    useMetaFactory,
    eip7702Auth: params.eip7702Auth,
  } as never);
}
