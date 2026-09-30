/**
 * WAS THIS GRANT SIGNED AGAINST AN OLDER WALL?
 *
 * ── THE PROBLEM THIS ANSWERS ─────────────────────────────────────────────
 *
 * The wall is built in the SIGNING CLIENT — the browser bundle, or a
 * Metro-bundled mobile binary — and a signature is a permanent artefact of
 * whatever that client believed at the time. So when a release changes which
 * permissions the wall carries, every grant already out there keeps the old
 * one, and there is no moment at which anybody is told.
 *
 * It has cost real money and days. `grant-installable.ts` records the worst
 * case: a duplicated USDG approve made every Trencher grant UNINSTALLABLE, and
 * the agent looked armed and healthy while being structurally unable to make a
 * single trade. Three re-signs were spent before the client, rather than the
 * chain, was suspected. The narrower cases are quieter and just as real — a
 * capability added to the wall is simply missing from every older signature,
 * and the agent refuses a trade it looks entitled to make.
 *
 * ── WHY A DATE AND NOT A HASH ────────────────────────────────────────────
 *
 * Comparing the signed wall against a freshly built one is the obvious idea
 * and it cannot be done where it is needed. The signed permissions live inside
 * `grant.serialized`, and `serialized` is STRIPPED from `GET /api/grants`
 * (web/src/app/api/grants/route.ts) — it exists only in the browser that
 * minted the grant. Any other browser, which is most of them, has no blob to
 * decode. Nothing else on the record describes the wall's shape: `StoredGrant`
 * carries caps, tokens, features and sealed addresses, and no version at all.
 *
 * So this follows the one precedent the repo already has for "signed before
 * change X" — `WITHDRAWAL_ALLOWLIST_LANDED_AT` in grant.ts, a hard-coded epoch
 * compared against `grantedAt`. `grantedAt` IS on the public grant and IS
 * readable by every client.
 *
 * ── AND WHY THE CONSTANT CANNOT ROT ──────────────────────────────────────
 *
 * A hand-maintained date is only as good as the memory of whoever changes the
 * wall next, and a prompt that silently stops firing is worse than no prompt —
 * it is the same invisible failure with a reassuring UI on top. So the date
 * does not stand alone: `wall-release.test.ts` pins a FINGERPRINT of the
 * canonical wall's permission keys, and any change to `wall.ts` that adds,
 * removes or re-targets a permission fails that test with an instruction to
 * bump both. The test is the thing that makes the constant true; this file
 * just holds the number.
 */

/**
 * A permission as `buildCallPermissions` emits it.
 *
 * Typed structurally, like `CountablePermission` next door and for the same
 * reason: this module must not acquire an opinion about how a wall is built.
 */
export interface KeyablePermission {
  readonly target?: unknown;
  /** The ZeroDev input shape names the function, and derives the 4-byte selector later. */
  readonly functionName?: unknown;
  /** Present instead on a permission decoded back out of a serialized grant. */
  readonly selector?: unknown;
}

/**
 * The wall's identity: sorted `target:function`.
 *
 * ── WHICH FIELD, AND WHY IT IS NOT `selector` ────────────────────────────
 *
 * `duplicateWallPermissions` keys on `callType:target:selector` because it
 * reads a SERIALIZED grant, where ZeroDev has already reduced each entry to a
 * 4-byte selector. This function reads the other end — the input objects
 * `buildCallPermissions` returns, which carry `{target, valueLimit, abi,
 * functionName, args}` and no selector at all. Keying on `selector` here reads
 * a field that does not exist: every entry collapses to the same placeholder
 * and two genuinely different permissions on one contract (the WETH
 * `deposit`/`withdraw` pair, for instance) look identical. `functionName` maps
 * one-to-one onto the selector the contract ends up hashing, so it is the same
 * identity expressed in the vocabulary this side actually has.
 *
 * SORTED, because array order is a build detail and a reordering is not a
 * change any owner needs to re-sign for.
 *
 * Caps and token lists are deliberately NOT in here. They live in the rules
 * attached to a permission, not in its key, and they differ per owner — folding
 * them in would make every owner's wall unique and the fingerprint meaningless.
 */
export function wallPermissionKeys(perms: readonly KeyablePermission[]): string[] {
  return perms
    .map((p) =>
      [
        String(p?.target ?? "").toLowerCase(),
        String(p?.functionName ?? p?.selector ?? "?").toLowerCase(),
      ].join(":"),
    )
    .sort();
}

/**
 * WHEN THE SIGNED WALL LAST CHANGED SHAPE. Unix seconds, UTC.
 *
 * ── BUMP THIS when a change to `wall.ts` alters which permissions the wall
 * carries: a new target, a new selector, a removed one, a moved one. Set it to
 * the moment the change SHIPS, not the moment it is written — a grant signed
 * between the two was signed against the old client and is genuinely stale.
 *
 * Do NOT bump it for a change to caps, token lists, rule values or ordering.
 * None of those alter the permission keys, none of them require a re-signature
 * for correctness, and prompting for them teaches owners to ignore the prompt.
 *
 * Currently: 2026-09-20T18:56:39Z, commit f96ddd9 "wall: one USDG approve, so a
 * Trencher grant can actually be installed" — the release that removed the
 * duplicate `USDG.approve`. Every grant older than this either carries that
 * duplicate and is uninstallable, or predates the Trencher permissions
 * entirely. Both want the same remedy.
 */
export const WALL_CHANGED_AT = 1_789_930_599;

/** What a staleness check can conclude. `unknown` is not `false`. */
export type WallAge = "current" | "predates-change" | "unknown";

/**
 * Was this grant signed before the current wall shipped?
 *
 * THREE ANSWERS, NOT TWO. A grant with no readable `grantedAt` is not a fresh
 * one and not a stale one — it is unread, and this repo's rule is that a
 * measured zero is never an absence. A caller that wants to prompt must act on
 * `"predates-change"` alone; folding `"unknown"` into either arm would either
 * nag an owner who signed this morning or silence the one case this exists for.
 */
export function wallAgeOfGrant(
  grant: { grantedAt?: number | null } | null | undefined,
): WallAge {
  const at = grant?.grantedAt;
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return "unknown";
  return at < WALL_CHANGED_AT ? "predates-change" : "current";
}
