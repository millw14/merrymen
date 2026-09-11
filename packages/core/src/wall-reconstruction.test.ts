import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCallPermissions, grantWallOptions, usableExtraTokens } from "./wall";
import { wallShape } from "./first-enable-gas";
import { CASH, STOCK_TOKENS, type CustomToken } from "./tokens";
import type { GrantCaps } from "./grant";

/**
 * THE EXECUTOR REBUILDS A WALL IT NEVER SAW, AND IT HAS TO GET THE SAME ONE.
 *
 * The signer builds the wall from whole `CustomToken` objects. The executor
 * holds only the serialized account — `buildWallPolicies` says the ZeroDev
 * Policy objects are "opaque once constructed" — so it rebuilds from
 * `grantTokens`, which records ADDRESSES only, using placeholder symbols and
 * decimals. The claim that makes that safe is: only the COUNT reaches the
 * shape, so placeholders reproduce the size exactly.
 *
 * That claim has a way to be false. `usableExtraTokens` drops three kinds of
 * entry — malformed ones, addresses already built in, and case-insensitive
 * duplicates — so if it could filter two lists of EQUAL LENGTH differently, the
 * signer and the executor would agree on a wall neither of them has, which is
 * worse than disagreeing. The round trip below is the proof, not the assertion.
 *
 * WHY IT HOLDS: both writers store the POST-FILTER list —
 * `grantTokens: usableExtraTokens(extraTokens).map((t) => t.address.toLowerCase())`
 * at web/src/lib/session.ts:497 and mobile/src/crypto/signGrant.ts:258 — so the
 * addresses are already deduped, already lowercased and already free of
 * builtins. Re-running the filter over them is idempotent. These tests pin that
 * property against the cases that would break it.
 */

const CAPS = {
  perTradeUsdg: 25,
  dailyUsdg: 100,
  maxOpsPerDay: 48,
  maxDrawdownBps: 2000,
  ttlDays: 14,
} as unknown as GrantCaps;

const ME = "0x1111111111111111111111111111111111111111" as `0x${string}`;

const addr = (i: number) => ("0x" + (i + 0x5000).toString(16).padStart(40, "0")) as `0x${string}`;
const tok = (i: number, over: Partial<CustomToken> = {}): CustomToken => ({
  symbol: `C${i}`,
  address: addr(i),
  decimals: 18,
  ...over,
});

const shapeOf = (opts: Record<string, unknown>) =>
  wallShape(buildCallPermissions(CAPS, ME, opts as never) as never);

/** Exactly what the two signers store, then exactly what the executor rebuilds. */
function roundTrip(extraTokens: readonly CustomToken[], caps: Record<string, unknown> = {}) {
  const signed = shapeOf({ extraTokens, ...caps });
  const grantTokens = usableExtraTokens(extraTokens).map((t) => t.address.toLowerCase());
  const rebuilt = shapeOf({ ...grantWallOptions({ grantTokens }), ...caps });
  return { signed, rebuilt, grantTokens };
}

const assertSame = (r: ReturnType<typeof roundTrip>, why: string) => {
  assert.deepEqual(r.rebuilt, r.signed, `reconstructed wall differs from the signed wall: ${why}`);
};

describe("a rebuilt wall is the same wall", () => {
  it("plain case: five ordinary custom tokens", () => {
    assertSame(roundTrip([1, 2, 3, 4, 5].map((i) => tok(i))), "plain");
  });

  it("DUPLICATES — the same address twice, and in different case", () => {
    // usableExtraTokens dedupes on a lowercased key. If the stored list kept
    // both, the rebuild would be one permission wider than the signed wall.
    const dup = [tok(1), tok(1), { ...tok(1), address: addr(1).toUpperCase() as `0x${string}` }, tok(2)];
    const r = roundTrip(dup);
    assertSame(r, "duplicates");
    assert.equal(r.grantTokens.length, 2, "duplicates must collapse before storage");
  });

  it("BUILT-IN TOKENS mixed in — USDG and a tradeable stock", () => {
    // Already covered by the base wall, so they are dropped rather than added.
    // Storing them unfiltered would make the rebuild two permissions too wide.
    const builtins = [
      { symbol: "USDG", address: CASH.USDG as `0x${string}`, decimals: 6 },
      { symbol: STOCK_TOKENS[0]!.symbol, address: STOCK_TOKENS[0]!.address as `0x${string}`, decimals: 18 },
    ];
    const r = roundTrip([...builtins, tok(7), tok(8)]);
    assertSame(r, "builtins mixed in");
    assert.equal(r.grantTokens.length, 2, "built-ins must not survive into grantTokens");
  });

  it("MALFORMED ENTRIES — bad address, bad decimals, empty symbol", () => {
    // The case that would be fatal if grantTokens were stored pre-filter: two
    // lists of equal length filtering to different counts.
    const malformed = [
      { symbol: "BAD", address: "0xnothex" as `0x${string}`, decimals: 18 },
      { symbol: "", address: addr(20), decimals: 18 },
      { symbol: "NEG", address: addr(21), decimals: -1 },
      { symbol: "HUGE", address: addr(22), decimals: 999 },
    ];
    const r = roundTrip([...malformed, tok(9)]);
    assertSame(r, "malformed entries");
    assert.ok(r.grantTokens.length <= 1 + malformed.length);
  });

  it("ORDER does not change the shape", () => {
    const a = roundTrip([tok(1), tok(2), tok(3)]);
    const b = roundTrip([tok(3), tok(1), tok(2)]);
    assertSame(a, "order A");
    assertSame(b, "order B");
    assert.deepEqual(a.signed, b.signed, "shape must not depend on token order");
  });

  it("EVERY CAPABILITY COMBINATION round-trips", () => {
    // Capabilities widen the spender list, which is pinned on every approve
    // permission — the single largest driver of wall size — so the rebuild has
    // to reproduce them from grantFeatures too, not only the token count.
    const V4 = "0x" + "a".repeat(40);
    const PONS = "0x" + "b".repeat(40);
    for (const allowRialto of [false, true])
      for (const allowUniswapV4 of [false, true])
        for (const v4 of [false, true])
          for (const pons of [false, true]) {
            const caps = {
              allowRialto,
              allowUniswapV4,
              ...(v4 ? { v4AdapterAddress: V4 } : {}),
              ...(pons ? { ponsAdapterAddress: PONS } : {}),
            };
            const tokens = [tok(1), tok(1), tok(2)];
            const signed = shapeOf({ extraTokens: tokens, ...caps });
            const grantTokens = usableExtraTokens(tokens).map((t) => t.address.toLowerCase());
            const rebuilt = shapeOf({
              ...grantWallOptions({
                grantTokens,
                grantFeatures: [...(allowRialto ? ["rialto"] : []), ...(allowUniswapV4 ? ["v4"] : [])],
              }),
              ...(v4 ? { v4AdapterAddress: V4 } : {}),
              ...(pons ? { ponsAdapterAddress: PONS } : {}),
            });
            assert.deepEqual(rebuilt, signed, `combination r=${allowRialto} v4=${allowUniswapV4} a=${v4} p=${pons}`);
          }
  });

  it("THE PROPERTY, STATED DIRECTLY: filtering is idempotent over stored addresses", () => {
    // If this ever stops holding, count-only reconstruction is unsafe and the
    // envelope must come from persisted wall-shape metadata instead. This is
    // the assertion that would catch it.
    const messy = [
      tok(1),
      tok(1),
      { symbol: "USDG", address: CASH.USDG as `0x${string}`, decimals: 6 },
      { symbol: "BAD", address: "0xzzz" as `0x${string}`, decimals: 18 },
      tok(2),
      { ...tok(2), address: addr(2).toUpperCase() as `0x${string}` },
    ];
    const stored = usableExtraTokens(messy).map((t) => t.address.toLowerCase());
    const placeholders = grantWallOptions({ grantTokens: stored }).extraTokens ?? [];
    const refiltered = usableExtraTokens(placeholders).map((t) => t.address.toLowerCase());
    assert.deepEqual(refiltered, stored, "re-filtering stored addresses must be a no-op");
  });
});
