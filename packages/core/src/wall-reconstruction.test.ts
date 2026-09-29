import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCallPermissions, grantWallOptions, usableExtraTokens } from "./wall";
import { wallShape } from "./first-enable-gas";
import { CASH, STOCK_TOKENS, type CustomToken } from "./tokens";
import type { GrantCaps } from "./grant";
import { GRANT_ENERGY } from "./energy";
import { MERRYMEN_TOKEN } from "./token";
import { GRANT_PERP_LIGHTER, LIGHTER_ROUTE_V1 } from "./perps";

/** A real Lighter API public key (the official signer's, from the spike). */
const PERP_PK = "0x2427c4493c2df1a3ecdd750f1398b865e5428907c41065f0612cb3fa6b5ea0d7ac00465b07f3acd7" as const;
const PERP_LIGHTER = { apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: PERP_PK } as const;
/** The perp block exactly as a stored grant carries it — sealed blob included, which the rebuild must ignore. */
const PERP_BLOCK = { route: GRANT_PERP_LIGHTER, ...PERP_LIGHTER, apiKeySealed: "aes-gcm-blob" };

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
    //
    // THE ENERGY BUY IS A DIMENSION TOO, and the one with no sealed address:
    // it is rebuilt from the GRANT_ENERGY marker alone. It adds a permission
    // AND a spender entry on the USDG approve, so a rebuild that missed it
    // would be 1,408 bytes narrower than the wall that was signed.
    //
    // PERPS ARE A DIMENSION TOO, and the first one rebuilt from more than a
    // marker: `grantWallOptions` reads the grant's chain and `perp` block
    // through `grantPerp`, so the rebuild has to be handed both — three
    // permissions, eleven rules and a spender entry (2,816 bytes) ride on it.
    const V4 = "0x" + "a".repeat(40);
    const PONS = "0x" + "b".repeat(40);
    for (const allowRialto of [false, true])
      for (const allowUniswapV4 of [false, true])
        for (const v4 of [false, true])
          for (const pons of [false, true])
            for (const energyBuy of [false, true])
              for (const perps of [false, true]) {
                const caps = {
                  allowRialto,
                  allowUniswapV4,
                  ...(v4 ? { v4AdapterAddress: V4 } : {}),
                  ...(pons ? { ponsAdapterAddress: PONS } : {}),
                  energyBuy,
                  ...(perps ? { perpLighter: PERP_LIGHTER } : {}),
                };
                const tokens = [tok(1), tok(1), tok(2)];
                const signed = shapeOf({ extraTokens: tokens, ...caps });
                const grantTokens = usableExtraTokens(tokens).map((t) => t.address.toLowerCase());
                const rebuilt = shapeOf({
                  ...grantWallOptions({
                    grantTokens,
                    grantFeatures: [
                      ...(allowRialto ? ["rialto"] : []),
                      ...(allowUniswapV4 ? ["v4"] : []),
                      ...(energyBuy ? [GRANT_ENERGY] : []),
                      ...(perps ? [GRANT_PERP_LIGHTER] : []),
                    ],
                    chainId: LIGHTER_ROUTE_V1.chainId,
                    ...(perps ? { perp: PERP_BLOCK } : {}),
                  }),
                  ...(v4 ? { v4AdapterAddress: V4 } : {}),
                  ...(pons ? { ponsAdapterAddress: PONS } : {}),
                });
                assert.deepEqual(
                  rebuilt,
                  signed,
                  `combination r=${allowRialto} v4=${allowUniswapV4} a=${v4} p=${pons} e=${energyBuy} perps=${perps}`,
                );
              }
  });

  it("PERPS REBUILD ONLY FROM MARKER + CHAIN + BLOCK, all three — a partial claim rebuilds the narrower wall", () => {
    const full = { grantFeatures: ["tradeable-v2", GRANT_PERP_LIGHTER], chainId: 4663, perp: PERP_BLOCK };
    assert.deepEqual(grantWallOptions(full).perpLighter, PERP_LIGHTER);
    // Each missing piece is "perps not granted" — never a partial wall. Server
    // side, the narrower rebuild then fails the byte comparison against a
    // signature that carried perps, which is the refusal a half-formed grant
    // deserves.
    const partial: Record<string, Record<string, unknown>> = {
      "no marker": { ...full, grantFeatures: ["tradeable-v2"] },
      "no chain": { grantFeatures: full.grantFeatures, perp: full.perp },
      testnet: { ...full, chainId: 46630 },
      "no block": { grantFeatures: full.grantFeatures, chainId: 4663 },
      "another index": { ...full, perp: { ...PERP_BLOCK, apiKeyIndex: 3 } },
      "a key the contract would reject": { ...full, perp: { ...PERP_BLOCK, apiPublicKey: `0x${"0".repeat(80)}` } },
      "a future route": { ...full, grantFeatures: ["tradeable-v2", "perp-lighter-v2"], perp: { ...PERP_BLOCK, route: "perp-lighter-v2" } },
    };
    const bare = shapeOf({});
    for (const [why, g] of Object.entries(partial)) {
      const opts = grantWallOptions(g as never);
      assert.equal(opts.perpLighter, undefined, why);
      assert.equal("perpLighter" in opts, false, `${why}: the options object keeps exactly the keys it always had`);
      assert.deepEqual(shapeOf({ ...opts }), bare, why);
    }
    // And callers that pass neither chain nor block — today's hosted check —
    // get exactly the object they always got.
    assert.deepEqual(Object.keys(grantWallOptions({ grantFeatures: [GRANT_ENERGY] })).sort(), [
      "allowRialto",
      "allowUniswapV4",
      "energyBuy",
      "extraTokens",
    ]);
  });

  it("THE ENERGY MARKER, AND ONLY THE MARKER, turns the energy buy on in a rebuild", () => {
    assert.equal(grantWallOptions({ grantFeatures: [GRANT_ENERGY] }).energyBuy, true);
    assert.equal(grantWallOptions({ grantFeatures: ["tradeable-v2"] }).energyBuy, false);
    assert.equal(grantWallOptions({}).energyBuy, false, "no features, no energy buy");
    // A future route is a future marker. v1's rebuild must not answer to it.
    assert.equal(grantWallOptions({ grantFeatures: ["energy-buy-v2"] }).energyBuy, false);
  });

  it("$MERRYMEN LISTED AS AN EXTRA does not survive into grantTokens, so the rebuild still matches", () => {
    // usableExtraTokens drops the reserve (it must never get an approve), and
    // both signers record grantTokens post-filter — so the executor rebuilds a
    // wall with no MERRYMEN approve, exactly as signed.
    const merry: CustomToken = { symbol: "MERRYMEN", address: MERRYMEN_TOKEN.address, decimals: 18 };
    const tokens = [merry, tok(3)];
    const signed = shapeOf({ extraTokens: tokens, energyBuy: true });
    const grantTokens = usableExtraTokens(tokens).map((t) => t.address.toLowerCase());
    assert.deepEqual(grantTokens, [addr(3)], "the reserve is never recorded as a covered token");
    const rebuilt = shapeOf({ ...grantWallOptions({ grantTokens, grantFeatures: [GRANT_ENERGY] }) });
    assert.deepEqual(rebuilt, signed);
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
