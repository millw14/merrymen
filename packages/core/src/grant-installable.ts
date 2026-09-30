/**
 * CAN THIS GRANT BE INSTALLED AT ALL?
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * Kernel's CallPolicy keys every call permission by a hash over
 * (callType, target, selector) and reverts `duplicate permissionHash` if one
 * appears twice in the array it is asked to install. A grant carrying a
 * duplicate is not merely suboptimal — it can NEVER be enabled, so every
 * operation the agent ever tries fails at validation, before any policy is
 * consulted and with no reference to the trade.
 *
 * It happened. `buildCallPermissions` spread a Trencher-specific USDG
 * `approve` into an array that already had one, and no Trencher grant was
 * installable for as long as that shipped (fixed in wall.ts). The fix was the
 * easy part; the expensive part was that NOTHING NOTICED. The wall is built in
 * the signing client — the browser bundle, or a Metro-bundled mobile binary —
 * so an owner with a tab open from before a deploy seals the OLD wall, the
 * server stores it without complaint, and the agent looks armed and healthy
 * while being structurally unable to trade. Three separate re-signs were spent
 * before anyone suspected the client rather than the chain.
 *
 * ── AND WHY IT SURVIVES THE FULL WALL COMPARISON ─────────────────────────
 *
 * Hosted POST /api/grants now also rebuilds the canonical wall and demands
 * byte equality (web/src/lib/canonical-wall.ts, shared with partner
 * enrollment), because a hand-built permission could otherwise be stored with
 * a transfer or an unconstrained router in it. That comparison subsumes this
 * one on the hosted path, and it has a cost this one does not: during a deploy
 * that changes wall.ts, a tab from before it seals the old wall and is refused
 * until reloaded — accepted, because the old wall is not what the server's
 * mirror believes a grant permits. This check stays, and runs first, for the
 * two things the comparison cannot do: it runs in SELF-HOSTED mode, where the
 * comparison does not, and its refusal names the one defect that is never
 * legitimate on any version, in words an owner can act on.
 *
 * ── AND WHY IT REFUSES RATHER THAN REPAIRS ───────────────────────────────
 *
 * The permissions are inside the signed payload. De-duplicating them here
 * would store something the owner did not sign, which is the one thing this
 * route may never do (see the zero-cap refusal beside it, which makes the same
 * choice for the same reason).
 */

/** A duplicate key, rendered for an operator: `callType:target:selector`. */
export type DuplicatePermission = string;

interface SerializedCallPolicyPermission {
  callType?: unknown;
  target?: unknown;
  selector?: unknown;
}

/**
 * Decode a serialized permission account far enough to read its call policy.
 *
 * DELIBERATELY TOLERANT. This is a foreign format being inspected, not parsed
 * for use: anything it cannot read returns `null`, and the caller treats that
 * as "no opinion" rather than as a refusal. A shape we do not recognise must
 * never block an owner from signing — the checks that own the grant's validity
 * are elsewhere, and this one exists only to catch a condition that is
 * unambiguously fatal.
 */
function callPolicyPermissions(serialized: string): SerializedCallPolicyPermission[] | null {
  try {
    const json = typeof atob === "function"
      ? atob(serialized)
      : Buffer.from(serialized, "base64").toString("binary");
    const parsed = JSON.parse(json) as {
      permissionParams?: { policies?: { policyParams?: { type?: unknown; permissions?: unknown } }[] };
    };
    const policies = parsed?.permissionParams?.policies;
    if (!Array.isArray(policies)) return null;
    const call = policies.find((p) => p?.policyParams?.type === "call");
    const permissions = call?.policyParams?.permissions;
    return Array.isArray(permissions) ? (permissions as SerializedCallPolicyPermission[]) : null;
  } catch {
    return null;
  }
}

/**
 * The (callType, target, selector) keys that appear more than once.
 *
 * Empty means installable as far as this check can tell — including when the
 * blob could not be read at all. See the tolerance note above.
 */
export function duplicateWallPermissions(serialized: unknown): DuplicatePermission[] {
  if (typeof serialized !== "string" || serialized.length === 0) return [];
  const permissions = callPolicyPermissions(serialized);
  if (!permissions) return [];
  const seen = new Map<string, number>();
  for (const p of permissions) {
    // Mirrors what the contract hashes. A missing field is folded to a stable
    // placeholder rather than skipped: two entries that BOTH omit a selector
    // collide on chain, and skipping them would hide exactly that case.
    const key = [
      String(p?.callType ?? "0x00").toLowerCase(),
      String(p?.target ?? "").toLowerCase(),
      String(p?.selector ?? "0x00000000").toLowerCase(),
    ].join(":");
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k} ×${n}`);
}
