/**
 * THE GAS-CEILING GATE, REDESIGNED FROM THE SAFETY SIDE.
 *
 * This file is written to be lifted into `worker/src/executor.ts` and
 * `worker/src/gas-limits.ts` verbatim. It lives under spikes/ only because this
 * task is read-only on those directories. Nothing here signs, broadcasts or
 * mutates anything: every function is either pure or does a single `eth_call`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS WRONG WITH THE GATE ON fix/first-enable-gas
 *
 *   const accountLive = await isDeployed();
 *   const nonce       = await account.getNonce();
 *   const firstEnable = !accountLive && isFirstEnable(nonce);
 *   const bounds      = firstEnable ? FIRST_ENABLE_GAS_BOUNDS : GAS_BOUNDS;
 *
 * `!accountLive` is a fact about an ADDRESS. The ~7.4M gas it is trying to
 * admit is a fact about a PERMISSION ID. Those are different keys, so the
 * conjunct produces false negatives (every renewal on a live account) without
 * producing a single true negative that `isFirstEnable(nonce)` did not already
 * produce.
 *
 * And it buys no security. Measured below and argued in the header of
 * `chooseGasCeiling`: the strongest bound `!accountLive` can give is "one
 * elevated operation per address", and a fresh address costs an attacker one
 * `generatePrivateKey()`. The bound it appears to provide is not a bound.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT REPLACES IT: FOUR INDEPENDENT CONDITIONS AND A SIZED CEILING
 *
 * The elevated ceiling is reachable only by an operation that satisfies ALL of:
 *
 *   C1  SHAPE       nonce mode 0x01 (ENABLE) and vType 0x02 (PERMISSION).
 *                   Kept from PR #56 unchanged. Locally computed.
 *
 *   C2  FIRST OP    the nonce SEQUENCE is 0. The low 8 bytes of the nonce come
 *                   from the EntryPoint, not from us — this is the one part of
 *                   the nonce nothing local can choose. See `C2` below for why
 *                   this makes the elevated ceiling structurally once-per-paid-
 *                   operation, and why nothing legitimate is at sequence > 0.
 *
 *   C3  PAYLOAD     the stub signature the account will actually hand the
 *                   bundler is longer than ENABLE_MIN_BYTES — i.e. the enable
 *                   blob is genuinely attached, rather than merely predicted by
 *                   a mode byte. Locally computed, but from a SECOND, LATER read
 *                   than C1, which is what makes it a cross-check rather than a
 *                   restatement.
 *
 *   C4  CHAIN       OUR OWN `permissionConfig(pId)` read, against the account,
 *                   for the permission id taken OUT OF THE NONCE, says the id is
 *                   not installed. This is the only condition the SDK does not
 *                   also compute, and it is the only one that FAILS CLOSED.
 *
 *   C5  SIZE        the ceiling is derived from the enable blob's own byte
 *                   length rather than being a flat 12,000,000. A grant only
 *                   ever gets the headroom its own wall can justify.
 *
 * Every one of these can only NARROW relative to PR #56's `isFirstEnable(nonce)`
 * alone. Dropping `!accountLive` and adding C2..C5 is strictly tighter than the
 * gate on the branch today for every operation except a renewal — which it
 * admits, because a renewal is the operation the 12M was measured on.
 */
import type { Address, Hex, PublicClient } from "viem";

// ═══════════════════════════════════════════════════════════════════════════
// THE BOUNDS SHAPE. Mirrors worker/src/gas-limits.ts so this file can be
// lifted without adaptation; re-declared rather than imported so the spike
// has no compile-time dependency on the branch under review.
// ═══════════════════════════════════════════════════════════════════════════

export interface GasBounds {
  callHeadroomBps: number;
  verificationHeadroomBps: number;
  preVerificationHeadroomBps: number;
  disagreementBps: number;
  absoluteMax: bigint;
}

/** worker/src/gas-limits.ts:118-130, verbatim. */
export const GAS_BOUNDS: GasBounds = {
  callHeadroomBps: 20_000,
  verificationHeadroomBps: 12_500,
  preVerificationHeadroomBps: 12_500,
  disagreementBps: 40_000,
  absoluteMax: 3_000_000n,
};

/**
 * THE HARD CAP ON THE SIZED CEILING.
 *
 * Unchanged at 12,000,000 — gas-limits.ts derives it correctly and the
 * measurements in this task confirm the renewal is CHEAPER than the undeployed
 * first op it was derived from (deployment contributes 1.8%-4.0% of the total,
 * all of it in preVerificationGas for the ~320 dropped factory bytes). No
 * constant needs to move. What changes is that a grant no longer receives this
 * number just for being an enable; it receives whatever its own wall justifies,
 * and this is only the ceiling on that.
 */
export const FIRST_ENABLE_ABSOLUTE_CAP = 12_000_000n;

// ═══════════════════════════════════════════════════════════════════════════
// C5 — THE SIZED CEILING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * WHY SIZE THE CEILING AT ALL, WHEN 12,000,000 IS ALREADY A CEILING?
 *
 * Because 12,000,000 is the ceiling for the LARGEST wall merrymen will sign,
 * and it is handed to every enable regardless of the wall it actually carries.
 * A grant with a 2-permission wall estimates at ~1.5M and, under a flat ceiling,
 * carries 10.5M of unused authority. Nothing today exploits that gap — but it is
 * the difference between "this operation may cost what an 18-permission enable
 * costs" and "this operation may cost what THIS operation's own payload costs",
 * and only the second is a bound in the sense this file cares about.
 *
 * The sizing input is the ENABLE BLOB'S BYTE LENGTH, and that choice is the
 * point: the blob is fixed before the estimate is requested, it is the literal
 * payload Kernel installs, and it cannot be inflated without also inflating the
 * estimate it is bounding. A tenant who adds custom tokens grows the blob and
 * grows their own ceiling — up to the cap, and no further.
 *
 * COEFFICIENTS. Fitted by least squares over walls of 1, 2, 4, 8 and 18
 * permissions estimated against a REAL deployed Kernel v3.3 account on 4663
 * (see gate-v2-measure.ts, which re-fits them and fails loudly if the residuals
 * move). Filled in from that run.
 */
export const ENABLE_GAS_FIT = {
  /**
   * raw total gas ≈ intercept + slope × enableBlobBytes
   *
   * MEASURED, Pimlico on 4663, 2026-09-03, against the REAL deployed Kernel v3.3
   * account 0x032Da6A0Ccf866474e45854E7fDEF9afd1509036 with no factory:
   *
   *   perms  blob B      verif   preVerif   call        RAW
   *       1    1,940  1,109,681     81,728  50,180  1,241,589
   *       2    2,388  1,396,425     89,613  50,180  1,536,218
   *       4    3,284  1,960,023    105,383  50,180  2,115,586
   *       8    5,076  3,097,109    136,922  50,180  3,284,211
   *      18   10,932  7,240,052    239,988  50,180  7,530,220
   *
   * Least squares over those five points: raw ≈ -169,701 + 700.945 × blobBytes,
   * worst residual 4.14% (at the 1-permission wall, where the fit UNDER-predicts
   * — the direction the safety factor exists for).
   *
   * The intercept is negative and that is not a modelling error: the enable's
   * cost is dominated by per-policy cold SSTOREs, which scale with the payload,
   * and the line is only ever evaluated above ENABLE_MIN_BYTES where it is
   * comfortably positive.
   *
   * THE FIT TRANSFERS TO THE LEVER TENANTS ACTUALLY PULL. Those five points vary
   * the PERMISSION COUNT by slicing the built-in list, averaging 529 bytes per
   * permission. A tenant widens a wall with `extraTokens`, which is a different
   * lever — so it was measured separately (gate-v2-extras.ts): +1/+5/+15/+40
   * custom tokens add exactly one call permission and exactly 512 bytes each,
   * 10,932 -> 11,444 -> 13,492 -> 18,612 -> 31,412. Same shape, same size, so
   * one line covers both, and a tenant's ceiling grows with their own wall by
   * ~538,000 gas per token until the cap binds at ~+3.
   *
   * (That sweep also settles what check-extras.ts left open. Its extras sweep
   * read FLAT — identical gas and a stub pinned at 10,932 bytes at +0, +5, +15
   * and +40 — and it named three incompatible explanations. The cause is the
   * third: `usableExtraTokens` -> `isValidCustomToken` silently drops anything
   * that is not a well-formed {symbol, address, decimals}, so extras passed as
   * bare addresses never reach the wall builder and the sweep varied nothing. I
   * reproduced the flat result exactly, then fixed the shape and the blob moved.)
   */
  intercept: -169_701n,
  slopeMilliGasPerByte: 700_945n, // slope × 1000, to keep it in bigint
  /**
   * Multiplied onto the fitted raw total before the headroom is applied. Covers
   * fit error and estimator revision — NOT variance we can name. The worst
   * measured residual is 4.14%, so 1.20x is 4.8x the observed error.
   */
  safetyBps: 12_000,
  /**
   * Added to the fitted raw total when the account has no code yet, because the
   * fit was taken with no factory and a first operation also pays for its own
   * CREATE2 and initCode calldata.
   *
   * Measured: the same 18-permission wall estimates 7,711,654 raw UNDEPLOYED
   * (probe.ts, and reproduced twice since) against 7,530,220 DEPLOYED — a
   * difference of 181,434, essentially all of it preVerificationGas for the ~320
   * bytes of factory calldata. 250,000 rounds that up rather than leaning on the
   * safety factor to absorb a cost that is structurally different in kind.
   */
  deployAllowanceRaw: 250_000n,
};

/**
 * The three per-field headrooms boundGas applies, from gas-limits.ts:312-320.
 * Reproduced here because the ceiling must be expressed in the same units the
 * total it is compared against is expressed in — a ceiling on the RAW estimate
 * and a total computed AFTER headroom are not the same ceiling.
 */
function boundedFromRaw(rawTotal: bigint): bigint {
  // The fit is over the raw TOTAL, so apply the field mix observed across every
  // measured enable: verification dominates at ~96%, preVerification ~3%, call
  // ~0.7%. Using the verification headroom (1.25x) for the whole total
  // under-states the call field's 2.0x by (2.0-1.25) x 50,180 = 37,635 gas,
  // which is added back as a flat term rather than modelled.
  return (rawTotal * 12_500n) / 10_000n + 37_635n;
}

/**
 * THE CEILING THIS OPERATION EARNS, from its own payload.
 *
 * Floored at GAS_BOUNDS.absoluteMax so the sizing can never make a grant WORSE
 * off than the ordinary ceiling, and capped at FIRST_ENABLE_ABSOLUTE_CAP so a
 * pathological blob cannot size its own way past the number gas-limits.ts
 * justified in prose.
 */
export function enableCeilingFor(blobBytes: number, deploying = false): bigint {
  const raw =
    ENABLE_GAS_FIT.intercept +
    (ENABLE_GAS_FIT.slopeMilliGasPerByte * BigInt(blobBytes)) / 1_000n +
    (deploying ? ENABLE_GAS_FIT.deployAllowanceRaw : 0n);
  const withSafety = (raw * BigInt(ENABLE_GAS_FIT.safetyBps)) / 10_000n;
  const ceiling = boundedFromRaw(withSafety);
  if (ceiling < GAS_BOUNDS.absoluteMax) return GAS_BOUNDS.absoluteMax;
  if (ceiling > FIRST_ENABLE_ABSOLUTE_CAP) return FIRST_ENABLE_ABSOLUTE_CAP;
  return ceiling;
}

// ═══════════════════════════════════════════════════════════════════════════
// C1 / C2 — READING THE NONCE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Kernel v3 packs a 32-byte nonce as
 *
 *   mode(1) ‖ vType(1) ‖ identifier(20) ‖ nonceKey(2) ‖ sequence(8)
 *   └──────────────── the 24-byte KEY ─────────────┘   └─ EntryPoint ─┘
 *
 * Verified against landed handleOps calldata on 4663 rather than only against
 * the SDK: tx 0xc6562c38… (sudo deploy) decodes to mode 0x00 / vType 0x00 /
 * identifier 0x845adb2c…ce57 (the full ECDSAValidator address) / seq 0, and
 * tx 0x323e8050… (a permission enable) to mode 0x01 / vType 0x02 / identifier
 * 0x3ca1cec8000…0 (the 4-byte permission id, LEFT-aligned in the 20-byte field)
 * / seq 0.
 */
export const nonceMode = (nonce: bigint): number => Number((nonce >> 248n) & 0xffn);
export const nonceVType = (nonce: bigint): number => Number((nonce >> 240n) & 0xffn);

/**
 * The permission id the operation will actually present, taken out of the
 * nonce rather than out of the grant.
 *
 * THIS MATTERS FOR C4. Reading `permission.getIdentifier()` off the plugin
 * object would check whichever id the local object holds; reading it out of the
 * nonce checks the id the EntryPoint will dispatch on. They should be equal,
 * `deserializeFlaggedPermissionAccount` proves they are equal at arm time, and
 * checking the nonce's copy means C4 verifies the operation rather than the
 * configuration.
 */
export function noncePermissionId(nonce: bigint): Hex {
  // Bytes 2..5 of the 32-byte nonce, i.e. bits 239..208. Getting this offset
  // wrong is silent and total: shifting by 224 instead of 208 returns
  // `0x0102986f` — the mode and vType bytes with two bytes of the id — and C4
  // then reads permissionConfig for an id no operation will ever present,
  // finds it empty, and answers "not installed" for every operation forever.
  // A gate condition that always passes is not a gate condition. Verified
  // against landed calldata: tx 0x323e8050… carries identifier
  // 0x3ca1cec8000…0 and this returns 0x3ca1cec8.
  const id = (nonce >> 208n) & 0xffffffffn;
  return `0x${id.toString(16).padStart(8, "0")}` as Hex;
}

/** The EntryPoint's own counter for this key. The only part of a nonce that is not local. */
export const nonceSequence = (nonce: bigint): bigint => nonce & 0xffff_ffff_ffff_ffffn;

/** C1, unchanged from worker/src/executor.ts:154-158. */
export function isFirstEnable(nonce: bigint): boolean {
  return nonceMode(nonce) === 0x01 && nonceVType(nonce) === 0x02;
}

// ═══════════════════════════════════════════════════════════════════════════
// C3 — IS THE ENABLE BLOB ACTUALLY THERE?
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A permission validator's ORDINARY stub signature is the session key's bare
 * ECDSA stub: 65 bytes. An ENABLE stub is
 * `hook(20) ‖ abi.encode(enableData, hookData, selectorData, enableSig, userOpSig)`
 * and measures 10,932 bytes for merrymen's 18-permission wall, ~2,388 bytes for
 * a 2-permission wall, and (measured in gate-v2-measure.ts) never below ~1,900
 * bytes for a wall with a single permission — because the ONE_OF lists, the
 * timestamp policy and the owner's EIP-712 enable signature are all present
 * whatever the wall's size.
 *
 * 512 bytes therefore sits an order of magnitude above a bare signature and
 * roughly a quarter of the smallest possible enable. It is a shape check, not a
 * size check; C5 does the size.
 *
 * WHY THIS IS NOT A RESTATEMENT OF C1. Both come from `isPluginEnabled`, but
 * from DIFFERENT CALLS AT DIFFERENT TIMES, and the SDK latches: once
 * `isPluginEnabled` returns true it sets a closure flag and `getSignatureData`
 * short-circuits on it forever (toKernelPluginManager.ts:136-138, 179-181). So
 * the two reads can disagree in exactly one direction — ENABLE nonce, DEFAULT
 * signature — which is the shape a transient RPC error produces at C1 and not at
 * C3. C3 is what catches it. The reverse (DEFAULT nonce, enable signature) is
 * structurally impossible because the latch only ever moves toward DEFAULT.
 */
export const ENABLE_MIN_BYTES = 512;

export const stubBytes = (stub: Hex): number => (stub.length - 2) / 2;

// ═══════════════════════════════════════════════════════════════════════════
// C4 — ASK THE CHAIN, AND FAIL CLOSED
// ═══════════════════════════════════════════════════════════════════════════

/** `permissionConfig(bytes4)` on Kernel v3.3 — KernelAccountAbi.ts:315-343. */
const PERMISSION_CONFIG_SELECTOR = "0xc3e58978";

/**
 * Is this permission id already occupied on this account?
 *
 * `true` / `false` are answers. `null` is "I could not read it", and the caller
 * MUST NOT treat it as `false`. That distinction is the entire reason this
 * function exists rather than reusing the SDK's `isPluginEnabled`: the SDK's
 * version is
 *
 *   (await regular.isEnabled(...)) || (await isPluginInitialized(...))
 *
 * where `isEnabled` wraps its readContract in `catch { return false }`
 * (toPermissionValidator.ts:137-156) and `isPluginInitialized` is called with
 * `address: zeroAddress` (toPermissionValidator.ts:86) so it ALWAYS throws and
 * is ALWAYS caught to false (isPluginInitialized.ts:11-23). Both disjuncts
 * collapse to false on any error, so the SDK's answer FAILS TOWARD ENABLE —
 * toward the wide ceiling. Measured: with a fault injected on this one eth_call,
 * a real already-deployed account with an INSTALLED permission id went from mode
 * 0x00 with a 66-byte signature to mode 0x01 with a 10,932-byte enable blob.
 *
 * A ceiling decision must not inherit that failure direction, so this read
 * reports its own failure honestly and the caller refuses.
 *
 * STRICTER THAN THE SDK ON PURPOSE. The SDK asks "is the stored signer MY
 * signer contract"; this asks "is there ANY signer stored". A permission id
 * occupied by someone else's signer is one Kernel will not let us install over
 * (measured: AA23 reverted 0xc48cf8ee), so treating it as occupied refuses an
 * operation that could not have succeeded anyway.
 */
export async function permissionIdInstalled(
  client: Pick<PublicClient, "call" | "getCode">,
  account: Address,
  permissionId: Hex,
  attempts = 3,
): Promise<boolean | null> {
  // ── THE CODELESS CASE FIRST, AND THIS IS WHERE `accountLive` EARNS ITS KEEP ──
  //
  // An account with no code cannot have a permission id installed on it: there
  // is no storage and no implementation. `eth_call` to a codeless address
  // SUCCEEDS with empty returndata, so the parse below cannot tell that apart
  // from a malformed reply — and a first deploy+enable is exactly a codeless
  // account. Measured: without this branch, the undeployed first op PR #56 was
  // written for is refused as `enable-unverified`.
  //
  // NOTE THE INVERTED FAILURE DIRECTION relative to executor.ts:262-273, which
  // answers "not deployed" when getCode throws. Here a failed read must be
  // UNREAD, because "no code" is now a REASON TO WIDEN the ceiling rather than
  // a fact we merely log. Today a failed getCode is the only thing that lets a
  // renewal through; under this gate a failed getCode refuses the operation and
  // says why. That inversion is deliberate and is the whole reason `deployed`
  // stops being memoised for the life of the executor.
  let code: string | undefined;
  try {
    code = await client.getCode({ address: account });
  } catch {
    return null;
  }
  if (code === undefined || code === "0x") return false;

  const data = (PERMISSION_CONFIG_SELECTOR +
    permissionId.slice(2).padEnd(64, "0")) as Hex;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await client.call({ to: account, data });
      const hex = r.data;
      // struct PermissionConfig { bytes2 flag; address signer; bytes22[] policyData }
      // returned as: word0 = offset to struct, word1 = flag, word2 = signer, …
      if (typeof hex !== "string" || hex.length < 2 + 3 * 64) {
        // Short or empty returndata from an account that DOES have code is not
        // "not installed" — it is a reply we do not understand. Answering false
        // there would hand the wide ceiling to anything that can produce a
        // truncated response.
        if (i === attempts - 1) return null;
        continue;
      }
      const signer = `0x${hex.slice(2 + 128 + 24, 2 + 192)}`.toLowerCase();
      return signer !== "0x0000000000000000000000000000000000000000";
    } catch {
      if (i === attempts - 1) return null;
      await new Promise((s) => setTimeout(s, 150 * 2 ** i));
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE GATE
// ═══════════════════════════════════════════════════════════════════════════

export type CeilingDecision =
  | {
      kind: "elevated";
      bounds: GasBounds;
      /** Why, in one line, for the [gas] log. */
      why: string;
      evidence: Evidence;
    }
  | { kind: "ordinary"; bounds: GasBounds; why: string; evidence: Evidence }
  /**
   * THE THIRD ANSWER, AND THE ONE PR #56 DOES NOT HAVE.
   *
   * An operation that PRESENTS as an enable but whose enable we could not
   * verify is not an ordinary operation, and quietly handing it the 3,000,000
   * ceiling is the worst available outcome: executor.ts sizes the estimate's
   * balance stateOverride from the ceiling it just chose
   * (`bounds.absoluteMax * feeCeiling * 2n`), so a ~7.5M operation under a 3M
   * override is handed 6,000,000 gas of imaginary ETH, the bundler answers
   * "AA21 didn't pay prefund", boundGas receives null, and the owner is told
   * `gas-unreadable` with no gas figure logged anywhere. That is exactly the
   * twenty-four-identical-failures shape this whole file exists to end.
   *
   * So say what happened instead. `enable-unverified` is a pre-broadcast
   * refusal in the same shape as a policy one: nothing signed, nothing spent,
   * and the next tick retries.
   */
  | { kind: "refuse"; rule: "enable-unverified"; detail: string; evidence: Evidence };

export interface Evidence {
  nonce: bigint;
  mode: number;
  vType: number;
  seq: bigint;
  permissionId: Hex;
  blobBytes: number;
  installed: boolean | null;
  accountLive: boolean | null;
  sizedCeiling: bigint | null;
}

/**
 * CHOOSE THE CEILING.
 *
 * `accountLive` is still READ and still LOGGED — it is genuinely useful for
 * diagnosis — but it is no longer an input to the decision, because it is a
 * fact about an address and the cost being bounded is a fact about a permission
 * id. Passing it in keeps that visible rather than deleting the read and
 * losing the log line.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ONCE-PER-PAID-OPERATION WITHOUT A DATABASE
 *
 * The obvious hardening — a table of (account, permissionId) that have already
 * drawn the elevated ceiling — is not needed, and adding it would introduce a
 * failure mode (ledger unreachable ⇒ renewals blocked) in exchange for a bound
 * C2 and C4 already give:
 *
 *   An operation that is NEVER INCLUDED costs nobody anything. It is a
 *   simulation and a refusal. Repeats of it are free to the attacker and free
 *   to the house, and no ceiling needs to bound them.
 *
 *   An operation that IS INCLUDED installs the permission id inside validation.
 *   From that moment: C4's read returns `true` (the id is occupied) AND the
 *   EntryPoint's counter for that nonce key is 1, so C2 fails. Both close, from
 *   two independent sources, permanently, for that (account, permissionId).
 *
 * So the elevated ceiling admits AT MOST ONE PAID OPERATION per permission id
 * per account, and a second one requires a new permission id — which requires a
 * new session key or new policies, which requires a new signed grant.
 *
 * That is exactly the bound `!accountLive` was reaching for, obtained on the
 * right key. `!accountLive` obtains it on the wrong key and therefore obtains
 * nothing: a fresh owner key derives a fresh undeployed address for the cost of
 * one `generatePrivateKey()`, so an attacker willing to re-arm was never bounded
 * by it, while an honest owner renewing on their funded account was.
 */
export async function chooseGasCeiling(args: {
  client: Pick<PublicClient, "call" | "getCode">;
  account: Address;
  nonce: bigint;
  /** The stub signature for THIS operation — the blob that will be signed. */
  stub: Hex;
  /** Read and logged, never decided on. */
  accountLive: boolean | null;
}): Promise<CeilingDecision> {
  const { nonce, stub } = args;
  const mode = nonceMode(nonce);
  const vType = nonceVType(nonce);
  const seq = nonceSequence(nonce);
  const permissionId = noncePermissionId(nonce);
  const blobBytes = stubBytes(stub);

  const base: Evidence = {
    nonce,
    mode,
    vType,
    seq,
    permissionId,
    blobBytes,
    installed: null,
    accountLive: args.accountLive,
    sizedCeiling: null,
  };

  // ── C1. SHAPE ────────────────────────────────────────────────────────────
  if (!isFirstEnable(nonce)) {
    return {
      kind: "ordinary",
      bounds: GAS_BOUNDS,
      why: `nonce mode 0x${mode.toString(16).padStart(2, "0")}/vType 0x${vType
        .toString(16)
        .padStart(2, "0")} is not a permission-validator enable`,
      evidence: base,
    };
  }

  // ── C3 BEFORE C2/C4, because it is free and it is the strongest single
  //    disqualifier: an operation whose signature carries no enable blob is not
  //    the operation the elevated ceiling was measured on, whatever its nonce
  //    claims. Checking it first also means a nonce/signature disagreement never
  //    costs an eth_call.
  if (blobBytes < ENABLE_MIN_BYTES) {
    return {
      kind: "ordinary",
      bounds: GAS_BOUNDS,
      why: `nonce claims an enable but the signature carries only ${blobBytes} bytes (< ${ENABLE_MIN_BYTES}) — no enable blob is attached`,
      evidence: base,
    };
  }

  // ── C2. FIRST OPERATION OF THIS KEY ──────────────────────────────────────
  //
  // NOTHING LEGITIMATE SITS AT SEQUENCE > 0 ON AN ENABLE KEY. The EntryPoint
  // increments a key's sequence only when an operation under that key is
  // INCLUDED, and inclusion of an enable installs the permission id — after
  // which the SDK builds mode 0x00, a different key, whose own sequence starts
  // at 0 again. A revert during validation reverts the whole handleOps and
  // increments nothing; a bundler rejection never reaches the EntryPoint. So
  // sequence 1 on an enable key means precisely one thing: this permission id
  // has already been installed and this operation will revert (measured:
  // AA23 0xc48cf8ee). Refusing it early is refusing an operation that could not
  // have succeeded.
  if (seq !== 0n) {
    return {
      kind: "ordinary",
      bounds: GAS_BOUNDS,
      why: `enable-shaped op at sequence ${seq} — permission id ${permissionId} has already been installed under this key`,
      evidence: base,
    };
  }

  // ── C4. THE CHAIN, FAIL-CLOSED ───────────────────────────────────────────
  const installed = await permissionIdInstalled(args.client, args.account, permissionId);
  const withRead: Evidence = { ...base, installed };

  if (installed === null) {
    return {
      kind: "refuse",
      rule: "enable-unverified",
      detail:
        `this operation presents as a permission-validator enable of ${permissionId} carrying ` +
        `${blobBytes} bytes of enable data, which is the one shape allowed past the ordinary ` +
        `${GAS_BOUNDS.absoluteMax} gas ceiling. Confirming that requires reading permissionConfig(${permissionId}) ` +
        `from the account, and that read did not answer — three times. An unread answer is not "not installed": ` +
        `treating it as one would widen a gas ceiling on the strength of a failed RPC call. Nothing was signed ` +
        `and nothing was spent; the next attempt re-reads.`,
      evidence: withRead,
    };
  }

  if (installed) {
    return {
      kind: "ordinary",
      bounds: GAS_BOUNDS,
      why: `permission id ${permissionId} is already installed on ${args.account} — the enable blob would revert`,
      evidence: withRead,
    };
  }

  // ── C5. THE CEILING THIS BLOB EARNS ──────────────────────────────────────
  // `installed === false` reached here either because the account has code and
  // the id's slot is empty (a renewal) or because the account has no code at all
  // (a first deploy+enable). Only the second gets the deployment allowance.
  const sizedCeiling = enableCeilingFor(blobBytes, args.accountLive === false);
  return {
    kind: "elevated",
    bounds: { ...GAS_BOUNDS, absoluteMax: sizedCeiling },
    why:
      `first enable of permission id ${permissionId} (seq 0, ${blobBytes}-byte blob, not installed on chain) ` +
      `— ceiling sized to ${sizedCeiling}${sizedCeiling === FIRST_ENABLE_ABSOLUTE_CAP ? " (capped)" : ""}`,
    evidence: { ...withRead, sizedCeiling },
  };
}
