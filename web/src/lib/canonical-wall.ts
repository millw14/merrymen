/**
 * IS THIS SERIALIZED PERMISSION THE MERRYMEN WALL? One check, every door.
 *
 * A grant reaches the server as bytes built in a client the server does not
 * control — a browser tab, the iOS engine, a partner's SDK — and beside those
 * bytes it carries METADATA the worker believes: `grantFeatures` decides which
 * routes the off-chain mirror opens (worker/src/limits.ts limitsFromGrant),
 * `grantedAt` decides whether a legacy free-form `transfer` is honoured
 * (packages/core/src/grant.ts grantHasTransfer), `grantTokens` and the sealed
 * adapter addresses decide what the agent may sell and call. An owner-signed
 * permission hash authenticates the bytes; it does not prove the bytes are the
 * wall the metadata describes, or the wall Merrymen mints at all.
 *
 * So the check is a rebuild, not a scan. The canonical wall is rebuilt with
 * `buildWallPolicies` from the grant's own caps, timestamps, tokens and sealed
 * addresses, and every policy the permission would install is compared byte
 * for byte (`getPolicyInfoInBytes`, `getPolicyData`) — which is exactly what
 * the worker hands the account contract, since it rebuilds each policy from
 * these same serialized params (worker/src/session-account.ts). ABI metadata
 * riding beside a rule can differ without changing those bytes, and does not
 * matter; a recipient pin, a cap, a target or an extra permission does.
 *
 * WHAT THE CANONICAL WALL NEVER CARRIES, whatever the grant declares: a USDG
 * `transfer` (no signer registers a withdrawal address), the Rialto target and
 * the v4 Permit2/UniversalRouter pair (both hard-off in every signer). Their
 * markers — `transfer`, `rialto`, `v4`, and the retired `multihop` — are
 * refused outright rather than rebuilt, because each one opens a route in the
 * worker's mirror that the rebuilt wall would not contain.
 *
 * Shared by partner enrollment (web/src/lib/partner-enrollment.ts, where it
 * started) and hosted POST /api/grants. One implementation, because two would
 * drift, and the difference would be a door that accepts what the other
 * refuses.
 */
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { toCallPolicy, toTimestampPolicy } from "@zerodev/permissions/policies";
import { getActionSelector } from "@zerodev/sdk";
import {
  buildWallPolicies,
  grantWallOptions,
  GRANT_PONS_ADAPTER,
  GRANT_PONS_CLASS,
  GRANT_TRENCHER,
  GRANT_V4_ADAPTER,
  TRADEABLE_V2,
  type StoredGrant,
} from "@merrymen/core";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Every feature marker a current signer can mint, and nothing else.
 *
 * web/src/lib/session.ts prepareGrantCore (which the dashboard, the iOS engine
 * and sdk/browser.ts all sign through) and mobile/src/crypto/signGrant.ts mint
 * these and only these. `v4` is in neither list's reachable output — both pin
 * `allowUniswapV4 = false` — and `transfer`, `rialto` and `multihop` are no
 * longer minted by anything.
 */
export const CANONICAL_GRANT_FEATURES: readonly string[] = [
  TRADEABLE_V2,
  GRANT_V4_ADAPTER,
  GRANT_PONS_ADAPTER,
  GRANT_PONS_CLASS,
  GRANT_TRENCHER,
];

/** A sealed address field, and the marker that must travel with it. */
const SEALED: readonly (readonly [keyof StoredGrant, string])[] = [
  ["v4AdapterAddress", GRANT_V4_ADAPTER],
  ["ponsAdapterAddress", GRANT_PONS_ADAPTER],
  ["ponsClassVaultAddress", GRANT_PONS_CLASS],
  ["ponsClassVaultFactoryAddress", GRANT_PONS_CLASS],
  ["trencherVaultAddress", GRANT_TRENCHER],
  ["trencherFactoryAddress", GRANT_TRENCHER],
];

export type WallRefusalCode = "bad_request" | "invalid_grant" | "invalid_wall" | "owner_key_forbidden";
export type WallVerdict = { ok: true } | { ok: false; status: 400 | 422; code: WallRefusalCode; why: string };

class Refusal {
  constructor(readonly status: 400 | 422, readonly code: WallRefusalCode, readonly why: string) {}
}
const refuse = (status: 400 | 422, code: WallRefusalCode, why: string): never => {
  throw new Refusal(status, code, why);
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return refuse(400, "bad_request", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
function onlyFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) refuse(400, "bad_request", "Body contains unsupported fields");
}
function address(value: unknown, label: string): Address {
  if (typeof value !== "string" || !ADDRESS.test(value) || value.toLowerCase() === ZERO) {
    return refuse(400, "invalid_grant", `${label} must be a nonzero wallet address`);
  }
  return value.toLowerCase() as Address;
}

/**
 * Does `grant.serialized` install exactly the wall Merrymen would mint for this
 * grant's own declared caps, times, tokens, features and sealed addresses?
 *
 * PURE — no chain, no store, no clock — so a refusal costs nothing and burns no
 * single-use nonce. REFUSES, NEVER REPAIRS: the permissions are inside what the
 * owner signed, so correcting them would store something nobody signed.
 *
 * The caller owns the checks that are not about the wall: who is asking,
 * whether the owner key is present in the outer payload, cap bounds, and
 * whether the account derives from the owner.
 */
export function checkCanonicalWall(grant: Record<string, unknown>): WallVerdict {
  try {
    verify(grant);
    return { ok: true };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, status: error.status, code: error.code, why: error.why };
    // Anything this function did not anticipate is a wall it could not vouch
    // for — fail closed, never through.
    return { ok: false, status: 400, code: "invalid_wall", why: "The serialized permission policies cannot be verified" };
  }
}

function verify(grant: Record<string, unknown>): void {
  const owner = address(grant.owner, "owner");
  const smartAccount = address(grant.smartAccount, "smartAccount");
  const caps = object(grant.caps, "grant caps");
  if (!Number.isSafeInteger(grant.grantedAt) || !Number.isSafeInteger(grant.expiresAt)) {
    refuse(400, "invalid_grant", "The grant's start and expiry must be whole seconds");
  }
  if (typeof grant.serialized !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(grant.serialized)) {
    refuse(400, "invalid_grant", "The serialized permission cannot be read");
  }
  let params: Record<string, unknown>;
  try {
    params = object(JSON.parse(Buffer.from(grant.serialized as string, "base64").toString("utf8")), "serialized permission");
  } catch {
    return refuse(400, "invalid_grant", "The serialized permission cannot be read");
  }
  onlyFields(params, ["permissionParams", "action", "validityData", "accountParams", "enableSignature", "privateKey", "isPreInstalled"]);
  if (typeof params.privateKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(params.privateKey)) {
    refuse(400, "invalid_grant", "The serialized permission carries no session key");
  }
  if (params.privateKey !== grant.demoSessionPrivateKey) {
    refuse(400, "invalid_grant", "The serialized permission carries a different session key");
  }
  // THE ONE KEY THE OWNER-KEY SCANS EXEMPT. carriesOwnerKey skips
  // `demoSessionPrivateKey` and the scan below skips `privateKey`, because both
  // legitimately hold the session key — so an owner key placed THERE would be
  // stored as though it were one. Recognise it by the address it controls.
  let sessionAddress: string;
  try {
    sessionAddress = privateKeyToAccount(params.privateKey as `0x${string}`).address.toLowerCase();
  } catch {
    return refuse(400, "invalid_grant", "The session key is invalid");
  }
  if (sessionAddress === owner) refuse(422, "owner_key_forbidden", "The session key must be different from the owner key");

  // ABI rules legitimately contain bytes32 values, so the outer grant's broad
  // raw-key detector cannot scan this decoded object. Recognize the owner's
  // actual key by its derived address instead; reject custody-named fields too.
  const inspect = (value: unknown, key = ""): void => {
    if (/(?:owner.*(?:key|secret)|mnemonic|seed.?phrase|private.?key)/i.test(key)) {
      refuse(422, "owner_key_forbidden", "The serialized permission contains unexpected key material");
    }
    if (typeof value === "string") {
      const candidate = /^(?:0x)?([0-9a-fA-F]{64})$/.exec(value);
      if (candidate) {
        let candidateAddress: string | null = null;
        try {
          candidateAddress = privateKeyToAccount(`0x${candidate[1]}`).address.toLowerCase();
        } catch {
          /* An ABI word need not be a valid secret scalar. */
        }
        if (candidateAddress === owner) refuse(422, "owner_key_forbidden", "The serialized permission contains the owner private key");
      }
    } else if (Array.isArray(value)) value.forEach((v) => inspect(v));
    else if (value && typeof value === "object") Object.entries(value).forEach(([k, v]) => inspect(v, k));
  };
  Object.entries(params).forEach(([key, value]) => {
    if (key !== "privateKey") inspect(value, key);
  });

  const action = object(params.action, "permission action");
  onlyFields(action, ["selector", "address"]);
  const validity = object(params.validityData, "permission validity");
  onlyFields(validity, ["validAfter", "validUntil"]);
  if (
    params.isPreInstalled !== false ||
    action.address !== ZERO ||
    action.selector !== getActionSelector("0.7") ||
    Number(validity.validAfter) !== 0 ||
    Number(validity.validUntil) !== 0
  ) {
    refuse(400, "invalid_grant", "The permission must use the standard owner-enabled Kernel permission action");
  }
  const account = object(params.accountParams, "serialized account");
  onlyFields(account, ["initCode", "accountAddress"]);
  if (
    address(account.accountAddress, "serialized account address") !== smartAccount ||
    typeof account.initCode !== "string" ||
    !/^0x[0-9a-fA-F]+$/.test(account.initCode)
  ) {
    refuse(400, "invalid_grant", "The serialized account does not match this grant");
  }
  const permission = object(params.permissionParams, "serialized permission parameters");
  onlyFields(permission, ["policies", "permissionId"]);
  if (!Array.isArray(permission.policies) || permission.policies.length > 8) {
    refuse(400, "invalid_grant", "The permission policies are missing or invalid");
  }
  const policies = (permission.policies as unknown[]).map((p) => {
    const record = object(p, "permission policy");
    onlyFields(record, ["policyParams"]);
    const policy = object(record.policyParams, "permission policy parameters");
    if (policy.type === "timestamp") onlyFields(policy, ["type", "policyAddress", "policyFlag", "validAfter", "validUntil"]);
    else if (policy.type === "call") onlyFields(policy, ["type", "policyAddress", "policyFlag", "policyVersion", "permissions"]);
    else refuse(400, "invalid_grant", "This grant carries an unsupported permission policy");
    return policy;
  });
  if (
    !policies.some((p) => p.type === "call") ||
    !policies.some((p) => p.type === "timestamp" && Number(p.validUntil) === grant.expiresAt && Number(p.validAfter) === grant.grantedAt)
  ) {
    refuse(400, "invalid_grant", "The permission must carry a call policy and the grant's exact expiry");
  }

  const tokens = grant.grantTokens;
  if (tokens !== undefined && (!Array.isArray(tokens) || tokens.length > 50 || tokens.some((a) => typeof a !== "string" || !ADDRESS.test(a)))) {
    refuse(400, "invalid_grant", "Invalid granted token addresses");
  }

  // THE MARKERS ARE AN ALLOWLIST, NOT A DENYLIST. A marker the worker reads
  // and the rebuild below does not model is a route the mirror would open over
  // a wall that lacks it — or, for `transfer` dated before the allowlist, one
  // the mirror would open with any recipient. Naming the rejects makes a stale
  // or hand-built client say which marker it sent.
  const features = grant.grantFeatures;
  if (!Array.isArray(features) || !features.includes(TRADEABLE_V2)) {
    refuse(400, "invalid_grant", `The permission must declare ${TRADEABLE_V2}`);
  }
  const unknown = (features as unknown[]).filter((f) => typeof f !== "string" || !CANONICAL_GRANT_FEATURES.includes(f));
  if (unknown.length > 0) {
    const named = unknown.slice(0, 5).map((f) => JSON.stringify(f)?.slice(0, 40) ?? String(f)).join(", ");
    refuse(400, "invalid_grant", `The permission declares features the Merrymen wall does not grant: ${named}`);
  }
  for (const [field, marker] of SEALED) {
    if (grant[field] !== undefined) address(grant[field], field);
    if ((grant[field] !== undefined) !== (features as string[]).includes(marker)) {
      refuse(400, "invalid_grant", "Permission adapter metadata does not match its feature markers");
    }
  }

  // A hash signed by the owner authenticates the submitted bytes; it does not
  // prove those bytes implement the limits advertised beside them. Rebuild the
  // canonical wall and compare encoded policies, including recipient pins and
  // per-trade caps. ABI metadata can differ without changing those bytes.
  try {
    const expected = buildWallPolicies({
      caps: caps as unknown as StoredGrant["caps"],
      smartAccount,
      now: grant.grantedAt as number,
      ...grantWallOptions({ grantTokens: tokens as string[] | undefined, grantFeatures: features as string[] }),
      // Already implied by the marker allowlist above, and stated anyway: the
      // canonical wall has neither, so a rebuild must never be talked into
      // either by a marker a future edit forgot to refuse.
      allowRialto: false,
      allowUniswapV4: false,
      v4AdapterAddress: grant.v4AdapterAddress as Address | undefined,
      ponsAdapterAddress: grant.ponsAdapterAddress as Address | undefined,
      ponsClassVaultAddress: grant.ponsClassVaultAddress as string | undefined,
      ponsClassVaultFactoryAddress: grant.ponsClassVaultFactoryAddress as string | undefined,
      trencherVaultAddress: grant.trencherVaultAddress as string | undefined,
      trencherFactoryAddress: grant.trencherFactoryAddress as string | undefined,
    }).policies;
    const submitted = policies.map((p) => (p.type === "call" ? toCallPolicy(p as never) : toTimestampPolicy(p as never)));
    if (
      expected.length !== submitted.length ||
      expected.some(
        (p, i) =>
          p.getPolicyInfoInBytes().toLowerCase() !== submitted[i].getPolicyInfoInBytes().toLowerCase() ||
          p.getPolicyData().toLowerCase() !== submitted[i].getPolicyData().toLowerCase(),
      )
    ) {
      refuse(400, "invalid_wall", "The serialized permission does not implement the advertised Merrymen limits");
    }
  } catch (error) {
    if (error instanceof Refusal) throw error;
    refuse(400, "invalid_wall", "The serialized permission policies cannot be verified");
  }
  if (typeof params.enableSignature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(params.enableSignature)) {
    refuse(400, "invalid_grant", "The owner-signed permission enable signature is missing");
  }
}
