/**
 * THE TEST THAT MAKES THE DATE TRUE.
 *
 * `WALL_CHANGED_AT` is hand-maintained, and a hand-maintained staleness date
 * has exactly one failure mode: somebody changes the wall and does not bump it.
 * The prompt then stops firing, silently, for the release that needed it most —
 * which is the invisible failure the whole mechanism exists to end, with a
 * reassuring UI on top.
 *
 * So the fingerprint below is pinned. Any change to `wall.ts` that adds,
 * removes or re-targets a permission changes it and fails this test, and the
 * failure message says what to do. That is the whole design: the constant is
 * not trusted, it is ENFORCED.
 *
 * WHAT DOES NOT TRIP IT, deliberately: caps, token lists, rule values and array
 * order. Those differ per owner or are build details, they do not change which
 * calls the wall permits, and prompting every owner to re-sign for them is how
 * a prompt becomes something people click through.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCallPermissions } from "./wall";
import { WALL_CHANGED_AT, wallAgeOfGrant, wallPermissionKeys } from "./wall-release";
import type { GrantCaps } from "./grant";

const ME = "0x1111111111111111111111111111111111111111" as `0x${string}`;

/**
 * A FIXED owner, fixed caps, no custom tokens and no optional capability.
 *
 * Fixed so the fingerprint is a property of the CODE and not of whoever ran it.
 * The bare wall is the right subject: every optional capability is additive, so
 * a change to the common core is the one that reaches every grant ever signed.
 */
const CAPS = {
  perTradeUsdg: 25,
  dailyUsdg: 100,
  maxOpsPerDay: 48,
  maxDrawdownBps: 2000,
  ttlDays: 14,
} as unknown as GrantCaps;

const keysOf = (opts: Record<string, unknown> = {}) =>
  wallPermissionKeys(buildCallPermissions(CAPS, ME, opts as never) as never);

describe("the wall's identity is pinned to its release date", () => {
  it("has not changed shape since WALL_CHANGED_AT was last set", () => {
    const keys = keysOf();
    // A COUNT, NOT THE LIST. The addresses are already asserted one by one by
    // wall.ts's own tests; what this needs to catch is the wall GROWING or
    // SHRINKING a permission, which is what makes an old signature wrong.
    assert.equal(
      keys.length,
      PINNED_PERMISSION_COUNT,
      `The wall now carries ${keys.length} permission(s), not ${PINNED_PERMISSION_COUNT}.\n` +
        "Every grant already signed carries the OLD set and cannot be repaired — only re-signed.\n" +
        "If this was deliberate: set WALL_CHANGED_AT (wall-release.ts) to the release time,\n" +
        "then update PINNED_PERMISSION_COUNT and PINNED_FINGERPRINT here.",
    );
    assert.equal(
      fingerprint(keys),
      PINNED_FINGERPRINT,
      `The wall's permission keys changed (same count, different targets or selectors).\n` +
        `now: ${fingerprint(keys)}\n` +
        "An owner's signed wall no longer matches this build's. Bump WALL_CHANGED_AT\n" +
        "(wall-release.ts) to the release time and re-pin the values here.",
    );
  });

  it("is stable across runs and across permission order", () => {
    // The fingerprint must be a property of the SET. A reordering inside
    // buildCallPermissions is a refactor, not a reason to make every owner sign
    // again, and a fingerprint that moved on it would cry wolf.
    assert.equal(fingerprint(keysOf()), fingerprint(keysOf()));
    // Also the `selector` fallback arm, which is what a permission decoded back
    // out of a serialized grant looks like — no functionName to read.
    const forward = wallPermissionKeys([
      { target: "0xAAA", selector: "0x11111111" },
      { target: "0xBBB", selector: "0x22222222" },
    ]);
    const backward = wallPermissionKeys([
      { target: "0xBBB", selector: "0x22222222" },
      { target: "0xAAA", selector: "0x11111111" },
    ]);
    assert.deepEqual(forward, backward, "order is a build detail, not an identity");
  });

  it("does not move when only the caps change", () => {
    // Caps live in a permission's RULES, not its key. An owner raising their
    // per-trade limit is already told to re-sign by the limits screen; it is
    // not a wall change and must not trip a fleet-wide prompt.
    const loose = wallPermissionKeys(
      buildCallPermissions(
        { ...CAPS, perTradeUsdg: 5_000, dailyUsdg: 50_000 } as unknown as GrantCaps,
        ME,
        {} as never,
      ) as never,
    );
    assert.equal(fingerprint(loose), fingerprint(keysOf()));
  });
});

describe("how a grant's age is read", () => {
  it("calls a grant signed before the change stale", () => {
    assert.equal(wallAgeOfGrant({ grantedAt: WALL_CHANGED_AT - 1 }), "predates-change");
  });

  it("calls one signed at or after the change current", () => {
    assert.equal(wallAgeOfGrant({ grantedAt: WALL_CHANGED_AT }), "current");
    assert.equal(wallAgeOfGrant({ grantedAt: WALL_CHANGED_AT + 86_400 }), "current");
  });

  it("returns unknown rather than guessing when there is no timestamp", () => {
    // THE ARM THAT KEEPS THE PROMPT HONEST. An unread grant is neither fresh
    // nor stale; folding it into "stale" nags an owner who signed this morning,
    // and folding it into "current" silences the one case this exists for.
    for (const g of [null, undefined, {}, { grantedAt: undefined }, { grantedAt: null }]) {
      assert.equal(wallAgeOfGrant(g as never), "unknown", JSON.stringify(g));
    }
  });

  it("treats a nonsensical timestamp as unknown, not as ancient", () => {
    // 0 is what a missing field coerces to, and it would read as "signed in
    // 1970" — the most stale thing possible — for every grant that simply did
    // not report one.
    for (const at of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(wallAgeOfGrant({ grantedAt: at }), "unknown", String(at));
    }
  });
});

describe("the constant itself", () => {
  it("is a plausible past release time", () => {
    // A date in the future would mark every grant stale forever; a date before
    // the product existed would mark none.
    assert.ok(WALL_CHANGED_AT > 1_700_000_000, "before merrymen existed");
    assert.ok(WALL_CHANGED_AT < 4_000_000_000, "not a milliseconds value");
  });

  it("is in SECONDS, not milliseconds", () => {
    // grantedAt is seconds (session.ts writes Math.floor(Date.now()/1000)).
    // A milliseconds constant would be ~1.79e12 and mark every grant stale.
    assert.ok(String(WALL_CHANGED_AT).length === 10, `${WALL_CHANGED_AT} is not 10 digits`);
  });
});

/** FNV-1a over the joined keys. Not cryptographic — this detects edits, not attacks. */
function fingerprint(keys: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const ch of keys.join("|")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ── THE PINNED VALUES ──────────────────────────────────────────────────────
// Re-pin these ONLY together with WALL_CHANGED_AT. Changing them on their own
// is how the prompt stops firing for the release that needed it.
const PINNED_PERMISSION_COUNT = 18;
const PINNED_FINGERPRINT = "5bc02ceb";
