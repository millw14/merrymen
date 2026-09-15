/**
 * WHAT A PERMISSION WALL COSTS TO INSTALL, DERIVED FROM THE WALL ITSELF.
 *
 * A merrymen session key installs its validator LAZILY: the enable data rides in
 * the signature of the first operation that key signs, so that one operation
 * carries the whole wall — every policy, both ONE_OF lists, and the owner's
 * EIP-712 enable signature — and Kernel installs all of it inside validation.
 * That makes the first operation structurally more expensive than every one
 * after it, and it is why a separate ceiling exists for it at all.
 *
 * THE FLAT CEILING WAS SIZED FOR ONE WALL. `FIRST_ENABLE_GAS_BOUNDS.absoluteMax`
 * was derived from the DEFAULT 18-permission wall plus margin for five custom
 * tokens. It budgets for nothing else, and the optional capabilities are not
 * small: each one widens the spender list, which is pinned as a ONE_OF on EVERY
 * approve permission, so turning one on costs roughly what the entire five-token
 * margin was worth. Two funded agents sat refused as `gas-absurd` on their first
 * operation — one of them, by the fits below, carrying a single custom token and
 * four capabilities.
 *
 * So the ceiling stops being one number for every wall and becomes a function of
 * the wall being installed:
 *
 *     signed wall shape -> deterministic envelope -> wall-specific maximum
 *                                                 -> hard product maximum
 *
 * DELIBERATELY NOT "the estimator said X, so allow X plus margin". That lets an
 * anomalous estimate justify itself, which is the one thing the original ceiling
 * existed to prevent — "crossing it means the operation is not the operation we
 * think it is". Here the envelope comes from the SHAPE, and the estimate only
 * has to fit inside it. A narrow wall with a wild estimate is still refused,
 * because its envelope is still narrow.
 *
 * ONE HOME, TWO CALLERS. The signer refuses a wall it cannot deploy, and the
 * executor refuses an estimate that does not fit its wall. Both call
 * `firstEnableEnvelope`, so the two limits cannot drift apart — which is exactly
 * how the product came to mint grants the executor was already designed to
 * refuse.
 */

/**
 * A call permission, structurally — the shape `buildCallPermissions` returns.
 *
 * Typed structurally rather than imported so this module cannot acquire a
 * dependency on how the wall is BUILT. It only needs to count what is there.
 */
export interface CountablePermission {
  readonly args?: readonly (null | undefined | { readonly value?: unknown })[];
}

export interface WallShape {
  /** Call permissions in the wall. */
  permissions: number;
  /** Argument rules across all permissions — every non-null `args` entry. */
  rules: number;
  /** Total entries across every ONE_OF list. This is what custom tokens widen. */
  oneOfEntries: number;
  /** ONE_OF entries plus the scalar rules; the encoded parameter slots. */
  params: number;
  /** The ABI-encoded policy blob, in bytes. */
  policyBlobBytes: number;
  /** The stub signature the estimator is handed: the blob plus a fixed envelope. */
  stubBytes: number;
}

/**
 * Bytes of enable envelope around the policy blob — signature, permission id,
 * validator addresses and the ABI framing that does not vary with the wall.
 *
 * MEASURED, not derived: `policyBlobBytes + 1236` reproduces the recorded stub
 * sweep exactly at 0, 1, 5, 15 and 40 custom tokens. `first-enable-gas.test.ts`
 * pins all five, so a change to the wall's encoding fails there rather than
 * silently shifting every envelope.
 */
const STUB_ENVELOPE_BYTES = 1236;

/** Bytes per encoded unit, from the same recorded sweep. */
const BLOB_BASE_BYTES = 64;
const BYTES_PER_PERMISSION = 224;
const BYTES_PER_RULE = 160;
const BYTES_PER_PARAM = 32;

/**
 * COUNT THE WALL, DO NOT PREDICT IT.
 *
 * An earlier pass derived these numbers from `WallOptions` with a closed-form
 * expression, and it was correct — but a formula over the inputs is a second
 * description of the wall, and the two can drift the moment a capability adds a
 * permission. Counting the objects the signature is actually made over cannot.
 */
export function wallShape(perms: readonly CountablePermission[]): WallShape {
  let rules = 0;
  let oneOfEntries = 0;
  let scalarRules = 0;
  for (const p of perms) {
    for (const a of p.args ?? []) {
      if (a === null || a === undefined) continue;
      rules += 1;
      if (Array.isArray(a.value)) oneOfEntries += a.value.length;
      else scalarRules += 1;
    }
  }
  const params = oneOfEntries + scalarRules;
  const policyBlobBytes =
    BLOB_BASE_BYTES +
    BYTES_PER_PERMISSION * perms.length +
    BYTES_PER_RULE * rules +
    BYTES_PER_PARAM * params;
  return {
    permissions: perms.length,
    rules,
    oneOfEntries,
    params,
    policyBlobBytes,
    stubBytes: policyBlobBytes + STUB_ENVELOPE_BYTES,
  };
}

/**
 * Bytes to gas, fitted on this chain against this bundler.
 *
 * Every constant is measured and every one is quoted with its source, because a
 * gas model nobody can check is a magic number with extra steps.
 */
export const FIRST_ENABLE_GAS_MODEL = {
  /** Fitted intercept, from the stub sweep. */
  interceptRaw: -169_701,
  /** Gas per stub byte × 1000, kept integral. 512 bytes × 700.945 = 358,884 —
   *  the exact per-custom-token figure gas-limits.ts already quotes. */
  slopeMilliGasPerByte: 700_945,
  /**
   * Added when the account has no code yet: a first operation also pays for its
   * own CREATE2 and initCode calldata. Measured — the same 18-permission wall
   * estimates 7,711,654 raw undeployed against 7,530,220 deployed, a difference
   * of 181,434, essentially all preVerificationGas for factory calldata.
   * Rounded up rather than leaning on the safety factor for a cost that is
   * structurally different in kind.
   */
  deployAllowanceRaw: 250_000,
  /**
   * Applied to the fitted raw before headroom. Covers fit error and estimator
   * revision — NOT variance we can name. Worst measured residual is 4.14%, so
   * 1.20 is about 4.8× the observed error.
   */
  safetyBps: 12_000,
  /**
   * Bounded-to-raw, from `boundGas`'s per-field headroom applied to the field
   * mix a first enable actually has. Observed on three real estimates: 1.2549,
   * 1.2638, 1.2600. The high end is used, so the envelope is never tighter than
   * the bounding it is compared against.
   */
  boundedOverRawBps: 12_650,
} as const;

/**
 * THE HARD PRODUCT MAXIMUM, and the one number here that is a policy choice
 * rather than a measurement — so it is derived from a measurement in the open.
 *
 * Beyond roughly forty custom tokens a grant provably cannot validate at all
 * (AA23, measured). At that wall the recorded stub is 31,412 bytes, which this
 * model puts at 22,098,383 raw and 27,834,594 bounded. Half of that is the
 * ceiling:
 *
 *     27,834,594 / 2  ->  14,000,000 bounded
 *
 * A 2× margin to a measured failure point, rather than a number chosen to fit
 * the walls that happen to exist. That distinction is the whole point: at
 * 14,000,000 one of the two agents currently refused is admitted and the other
 * is NOT, and the second becomes a renewal case. A maximum that admitted
 * everything already signed would be following the data instead of bounding it.
 *
 * It is not a licence to spend: the wall-specific envelope below is almost
 * always far tighter, and this only ever lowers it.
 */
export const FIRST_ENABLE_HARD_MAX_BOUNDED = 14_000_000n;

export interface FirstEnableEnvelope {
  shape: WallShape;
  /** What this wall should cost to install, raw, before headroom. */
  expectedRaw: bigint;
  /** The same with headroom, comparable to what `boundGas` produces. */
  expectedBounded: bigint;
  /** The most this wall may be signed for: its own envelope, capped. */
  allowedMaxBounded: bigint;
  /** True when the wall's own envelope fits under the hard product maximum. */
  withinHardMax: boolean;
}

/**
 * What this wall should cost, and the most it may be allowed.
 *
 * `deploying` is false for a RENEWAL, which installs the same wall on an account
 * that already exists — strictly cheaper, because it pays no CREATE2 and carries
 * no initCode.
 */
export function firstEnableEnvelope(
  shape: WallShape,
  opts: { deploying?: boolean } = {},
): FirstEnableEnvelope {
  const m = FIRST_ENABLE_GAS_MODEL;
  // PREDICTION FIRST, TOLERANCE SECOND — and they are different quantities.
  //
  // The first draft multiplied the fit by the safety factor AND by the
  // bounded-over-raw ratio, then compared the result against a hard maximum
  // derived using the ratio alone. Two scales, one comparison: a five-token
  // wall came out unsignable, which is STRICTER than the flat ceiling it was
  // meant to relax. `expectedBounded` is now what this wall should actually
  // cost once bounded — directly comparable to what `boundGas` produces and to
  // the hard maximum — and the safety factor appears only as the tolerance we
  // will accept an estimate within.
  const fittedRaw =
    m.interceptRaw +
    Math.round((m.slopeMilliGasPerByte * shape.stubBytes) / 1000) +
    (opts.deploying === false ? 0 : m.deployAllowanceRaw);
  const expectedRaw = BigInt(Math.max(0, fittedRaw));
  const expectedBounded = (expectedRaw * BigInt(m.boundedOverRawBps)) / 10_000n;
  // DEPLOYABILITY IS JUDGED ON THE PREDICTION, not on the tolerance. Otherwise
  // the slack we allow an estimator would decide which walls exist.
  const withinHardMax = expectedBounded <= FIRST_ENABLE_HARD_MAX_BOUNDED;
  const tolerated = (expectedBounded * BigInt(m.safetyBps)) / 10_000n;
  return {
    shape,
    expectedRaw,
    expectedBounded,
    // MIN, ALWAYS. A wide wall is capped by the product maximum; a narrow wall
    // is capped by its own envelope and never inherits the headroom of a wall
    // it does not have. That second half is what stops an anomalous estimate
    // for a small wall from being waved through.
    allowedMaxBounded:
      tolerated < FIRST_ENABLE_HARD_MAX_BOUNDED ? tolerated : FIRST_ENABLE_HARD_MAX_BOUNDED,
    withinHardMax,
  };
}

/**
 * The wall a STORED grant describes, rebuilt from the inputs it was signed over.
 *
 * THIS IS THE SEAM THAT MAKES THE TWO LIMITS ONE LIMIT. The signer knows the
 * wall because it is about to build it; the executor holds only the SERIALIZED
 * account, whose policies are opaque once deserialized — `buildWallPolicies`'s
 * own comment says so, which is why `buildCallPermissions` exists separately.
 * So the executor rebuilds the wall from the same recorded inputs the signature
 * was made over: caps, the owner's tokens, and which capabilities were sealed.
 *
 * `grantTokens` is the right source and `settings.customTokens` is not. The
 * grant records the tokens its policy ACTUALLY covers; settings record what the
 * owner has typed since. Those differ precisely when an owner has added a token
 * without re-signing, and sizing the envelope from the larger list would refuse
 * a wall that is genuinely small.
 *
 * Takes the builder as an argument rather than importing it, so this module
 * stays free of any dependency on how a wall is constructed — and so a test can
 * hand it a wall directly.
 */
export function wallShapeOfGrant<C>(
  grant: {
    caps: C;
    smartAccount: `0x${string}`;
    grantTokens?: readonly string[];
  },
  buildPermissions: (caps: C, account: `0x${string}`, opts: Record<string, unknown>) => readonly CountablePermission[],
  opts: Record<string, unknown>,
): WallShape {
  return wallShape(buildPermissions(grant.caps, grant.smartAccount, opts));
}

/**
 * THE MARKER A SURFACE KEYS ITS REMEDY OFF.
 *
 * Every too-wide refusal opens with this, so a screen can offer the owner a way
 * to act on it without parsing prose or re-deriving the verdict. Matching on a
 * sentence fragment is how a remedy quietly stops appearing the day somebody
 * rewords the copy.
 */
export const WALL_TOO_WIDE = "your trading permission is too large to sign safely";

/** Does this error carry a too-wide refusal? For surfaces that only see a message. */
export function isWallTooWide(message: string | null | undefined): boolean {
  return typeof message === "string" && message.toLowerCase().includes(WALL_TOO_WIDE);
}

/** What a refusal can tell the owner about their own basket. */
export interface TooWideBasket {
  /** Custom tokens this wall carries right now. */
  count: number;
  /**
   * The same wall with `n` custom tokens, built by the CALLER'S OWN builder.
   *
   * A callback rather than a formula, and that is the whole point: the maximum
   * has to come from `buildCallPermissions` over the owner's ACTUAL features —
   * their venues, their adapters, whether a class vault is sealed — because
   * every one of those changes the per-token price. A hard-coded token limit
   * would be wrong for everybody who is not the owner it was measured on.
   */
  shapeWith: (n: number) => WallShape;
}

export interface WallSignableRefusal {
  ok: false;
  why: string;
  /** Most custom tokens that would fit, at this owner's feature set. Null when unknown. */
  maxTokens: number | null;
  /** How many to remove. Null when unknown. */
  removeAtLeast: number | null;
}

/**
 * May this wall be signed at all?
 *
 * Asked BEFORE a signature exists, so an owner cannot mint a grant whose first
 * operation the executor is already designed to refuse. That was the actual
 * defect: the ceiling was behaving exactly as documented while signing had no
 * idea the ceiling existed.
 *
 * ── `deploying` IS A FACT ABOUT THE ACCOUNT, NOT A CONSTANT ────────────────
 *
 * It used to be hardcoded `true` here, which charged every RE-SIGN for a CREATE2
 * and an initCode it will never pay — 316,250 bounded gas, measured — because a
 * renewal installs the same wall on an account that already exists. That is not
 * a rounding error at this ceiling: it is the difference between signable and
 * refused for an owner sitting anywhere in a ~316k band, and a beta user was
 * told to delete a fifth token when four was the true answer.
 *
 * REQUIRED, not defaulted, so a caller has to state which case it is. A caller
 * that cannot find out must pass `true`: an unreadable account might be
 * undeployed, and over-charging refuses a wall that would have fitted, while
 * under-charging mints one whose first operation the executor then refuses
 * forever. Only one of those is recoverable by the owner.
 *
 * ── AND A REFUSAL HAS TO BE ACTIONABLE ────────────────────────────────────
 *
 * "Remove some custom tokens, or turn off a venue you are not using" was true
 * and useless. It named no number, and on chain 4663 the largest removable item
 * — the class vault, 1,361,964 gas, about three tokens' worth — CANNOT be turned
 * off: `sealedClassFactory` falls back to the chain's own factory and the
 * settings field can only override the address, never clear it. So the one lever
 * the sentence pointed at was the one lever the owner did not have.
 *
 * Given a basket, this now descends through the caller's own builder to find the
 * largest token count that actually fits, and says that. Not a formula and not a
 * constant — the same `buildCallPermissions` the signature is about to be made
 * over, so the number is true for THIS owner's features.
 */
export function wallSignable(
  shape: WallShape,
  opts: { deploying: boolean; basket?: TooWideBasket },
): { ok: true } | WallSignableRefusal {
  const env = firstEnableEnvelope(shape, { deploying: opts.deploying });
  if (env.withinHardMax) return { ok: true };

  // THE OWNER'S OWN ARITHMETIC, from the builder rather than from a rule.
  //
  // Linear descent, not a binary search: the range is a handful of tokens, cost
  // is monotonic in the count, and a wrong answer here tells somebody to delete
  // part of their basket. Cheap and obviously correct beats clever.
  let maxTokens: number | null = null;
  if (opts.basket) {
    for (let n = opts.basket.count - 1; n >= 0; n--) {
      if (firstEnableEnvelope(opts.basket.shapeWith(n), { deploying: opts.deploying }).withinHardMax) {
        maxTokens = n;
        break;
      }
    }
    // Still refused at zero tokens: the basket is not what is over the ceiling,
    // and telling the owner to delete all of it would be a lie as well as a
    // loss. Reported as unknown so the sentence below stays general.
    if (maxTokens === null) maxTokens = null;
  }
  const removeAtLeast = maxTokens === null || opts.basket === undefined ? null : opts.basket.count - maxTokens;

  const head =
    `${WALL_TOO_WIDE}: installing it would need about ` +
    `${env.expectedBounded.toLocaleString()} gas against a limit of ` +
    `${FIRST_ENABLE_HARD_MAX_BOUNDED.toLocaleString()}.`;

  if (opts.basket && maxTokens !== null && removeAtLeast !== null && removeAtLeast > 0) {
    return {
      ok: false,
      maxTokens,
      removeAtLeast,
      why:
        `${head} You have ${opts.basket.count} custom token${opts.basket.count === 1 ? "" : "s"}; the most ` +
        `that fits with the features you have enabled is ${maxTokens}. Remove at least ` +
        `${removeAtLeast} custom token${removeAtLeast === 1 ? "" : "s"}, then sign again.`,
    };
  }

  // NO BASKET TO BLAME, or it is over even when empty. Every capability is
  // pinned on every token, so the cost grows with both — but do not send an
  // owner to delete tokens that are not the cause.
  return {
    ok: false,
    maxTokens,
    removeAtLeast,
    why:
      `${head} Every capability you enable is pinned on each token you allow, so the cost grows with ` +
      `both together.` +
      (opts.basket
        ? ` Your ${opts.basket.count} custom token${opts.basket.count === 1 ? "" : "s"} are not the whole ` +
          `cause — this wall is over the limit even with none of them — so removing them will not be enough.`
        : ` Remove some custom tokens and sign again.`),
  };
}
