/**
 * "RE-SIGN TO COVER $MERRYMEN" IS ADVICE NOTHING CAN FOLLOW.
 *
 * Every signer drops the energy reserve from the sealed extras
 * (wall.ts usableExtraTokens), so no signature will ever cover it, and the
 * worker never watches it. An owner who listed $MERRYMEN as one of their
 * tokens (they had to, before energy existed) would otherwise be told, by
 * every coverage check the product has, to re-sign — and re-sign, and re-sign.
 * It is energy, bought only by the agent's get-energy route in the app chat.
 *
 * Each worker-side site is executed here: the core coverage helpers the worker
 * note, Wallet and Settings use, the preflight blocker, and the trending
 * discoverer whose picks reach the owner as "add it and re-sign at /grant".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MERRYMEN_TOKEN,
  TRADEABLE_V2,
  tokenCoverage,
  uncoveredBasketSymbols,
  type CustomToken,
} from "../../packages/core/src/index";
import { discoverTrending } from "./discovery";
import { preflight, type PreflightInput } from "./preflight";
import { emptyGeckoBuckets, type GeckoPool } from "./venues/geckoterminal";
import { applyVerdicts } from "./strategist/memecoin-scout";

const MERRY: CustomToken = { symbol: "MERRYMEN", address: MERRYMEN_TOKEN.address, decimals: 18 };
const MERRY_UPPER: CustomToken = { ...MERRY, address: `0x${MERRYMEN_TOKEN.address.slice(2).toUpperCase()}` };
const CATE: CustomToken = { symbol: "CATE", address: "0x00000000000000000000000000000000000000c1", decimals: 18 };
/** A current signer's grant: MERRYMEN is never sealed, however the owner listed it. */
const grant = (...addrs: string[]) => ({ grantTokens: addrs, grantFeatures: ["transfer", TRADEABLE_V2] });

describe("the core coverage helpers never ask a re-sign for the energy reserve", () => {
  it("tokenCoverage: $MERRYMEN is neither covered nor uncovered, in any case", () => {
    for (const t of [MERRY, MERRY_UPPER]) {
      const { covered, uncovered } = tokenCoverage([t, CATE], grant());
      assert.deepEqual(uncovered.map((x) => x.symbol), ["CATE"], "only the real gap is reported");
      assert.deepEqual(covered, []);
    }
  });

  it("…even on a legacy grant that happens to carry it — it is not a tradable leg either way", () => {
    const { covered, uncovered } = tokenCoverage([MERRY], grant(MERRY.address.toLowerCase()));
    assert.deepEqual([covered, uncovered], [[], []]);
  });

  it("an ordinary custom token is judged exactly as before", () => {
    assert.deepEqual(tokenCoverage([CATE], grant()).uncovered.map((t) => t.symbol), ["CATE"]);
    assert.deepEqual(tokenCoverage([CATE], grant(CATE.address)).covered.map((t) => t.symbol), ["CATE"]);
  });

  it("uncoveredBasketSymbols: MERRYMEN in the basket is not a 'can't sell' banner", () => {
    assert.deepEqual(uncoveredBasketSymbols(["MERRYMEN", "CATE"], grant(), [MERRY, CATE]), ["CATE"]);
    assert.deepEqual(uncoveredBasketSymbols(["MERRYMEN"], grant(), [MERRY_UPPER]), []);
  });
});

describe("preflight: no blocker for a basket entry nothing could clear", () => {
  const NOW = 1_800_000_000;
  const input = (basket: string[], customTokens: CustomToken[]): PreflightInput => ({
    settings: { bundlerApiKey: "pim_x", basketSymbols: basket, customTokens, buyPerTickUsdg: 50, idleFloorUsdg: 10_000 } as never,
    grant: {
      smartAccount: "0x00000000000000000000000000000000000000a1",
      chainId: 4663,
      expiresAt: NOW + 10 * 86_400,
      grantFeatures: ["transfer", "tradeable-v2", "multihop"],
      grantTokens: [],
    } as never,
    nowSec: NOW,
    usdg: 500,
    ethWei: 10n ** 16n,
    bundlerReachable: true,
    missingPolicyContracts: [],
    deadPolicy: false,
    accountDeployed: true,
  });
  const sellable = (i: PreflightInput) => preflight(i).find((c) => c.id === "sellable");

  it("MERRYMEN alongside a covered stock: no 'cannot sell' blocker", () => {
    const c = sellable(input(["QQQ", "MERRYMEN"], [MERRY]));
    assert.notEqual(c?.level, "blocker", JSON.stringify(c));
  });

  it("a genuinely uncovered custom token still is one", () => {
    const c = sellable(input(["QQQ", "MERRYMEN", "CATE"], [MERRY, CATE]))!;
    assert.equal(c.level, "blocker");
    assert.match(c.title, /cannot sell CATE$/, "CATE only — MERRYMEN is not in the list");
  });
});

describe("trending discovery never surfaces the energy reserve as a coin to trade", () => {
  const pool = (tokenAddress: `0x${string}`): GeckoPool => ({
    poolId: `0x${"1".repeat(40)}`,
    poolAddress: null,
    tokenAddress,
    name: "MERRYMEN / VIRTUAL",
    dex: "uniswap-v2-robinhood",
    priceUsd: 1,
    reserveUsd: 500_000,
    fdvUsd: 5_000_000,
    volume24hUsd: 900_000,
    change24hPct: 20,
    change1hPct: 1,
    buys24h: 900,
    sells24h: 700,
    buyers24h: 400,
    buckets: emptyGeckoBuckets(),
    createdAt: 1,
  });
  const deps = (pools: GeckoPool[]) => ({
    client: { async readContract() { throw new Error("no"); } },
    seen: new Set<string>(),
    known: [],
    fetchPools: async () => pools,
    scout: {
      name: "t",
      rank: async (ps: readonly GeckoPool[]) =>
        applyVerdicts(ps, { keep: ps.map((_, i) => ({ index: i, conviction: 3, reason: "r" })) }),
    },
    limits: { minReserveUsd: 25_000, minVolume24hUsd: 50_000, minBuyers24h: 100 },
    nowSec: 1_000,
  });

  it("a trending $MERRYMEN pool is dropped before the screen; a coin beside it is still picked", async () => {
    const merry = MERRYMEN_TOKEN.address.toLowerCase() as `0x${string}`;
    const other = `0x${"a".repeat(40)}` as `0x${string}`;
    const res = await discoverTrending(deps([pool(merry), pool(other)]) as never);
    assert.deepEqual(res.picks.map((p) => p.pool.tokenAddress), [other]);
  });
});
