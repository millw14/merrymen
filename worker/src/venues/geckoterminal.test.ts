import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, it } from "node:test";
import {
  parseGeckoPool,
  screenPools,
  fetchGeckoPools,
  fetchGeckoPoolsResult,
  geckoSource,
  readTokenPools,
  readTokenPoolsResult,
  resetGeckoFeedsForTest,
  cachedGeckoDetail,
  geckoRefusal,
  type GeckoPool,
} from "./geckoterminal";
import type { FeedResult } from "./fleet-feed-cache";

beforeEach(() => {
  let now = Date.now();
  resetGeckoFeedsForTest({ now: () => now, sleep: async ms => { now += ms; } });
});
afterEach(() => resetGeckoFeedsForTest());

describe("authenticated CoinGecko market source", () => {
  it("uses the public feed with no configured credential", () => {
    const source = geckoSource({ MERRYMEN_COINGECKO_PRO_API_KEY: "  " });
    assert.equal(source.base, "https://api.geckoterminal.com/api/v2");
    assert.deepEqual(source.headers, { accept: "application/json" });
  });
  it("uses the Pro onchain endpoint and a header rather than a key in the URL", () => {
    const source = geckoSource({ MERRYMEN_COINGECKO_PRO_API_KEY: " test-private-key " });
    assert.equal(source.id, "coingecko-pro");
    assert.equal(source.base, "https://pro-api.coingecko.com/api/v3/onchain");
    assert.equal(source.headers["x-cg-pro-api-key"], "test-private-key");
    assert.ok(!source.base.includes("test-private-key"));
  });
});

/**
 * Reading the market the agent could not see.
 *
 * CHUMP below is a VERBATIM trending_pools row for chain 4663, captured
 * 2026-08-29 — not a hand-written fixture. That matters twice over: every
 * numeric field really does arrive as a string, and this pool launched on
 * 2026-07-31, so it is exactly the "trending but not new" token discovery was
 * structurally blind to. If GeckoTerminal changes its shape, this is what should
 * fail, rather than the screen quietly returning nothing forever.
 */
const CHUMP = {
  id: "robinhood_0x714442e9a611f8561a7df108d6d925132937cfb8",
  type: "pool",
  attributes: {
    base_token_price_usd: "0.0222452357304331",
    address: "0x714442e9a611f8561a7df108d6d925132937cfb8",
    name: "CHUMP / WETH 1%",
    pool_created_at: "2026-07-31T01:44:31Z",
    fdv_usd: "22254823.9491408",
    price_change_percentage: { m5: "-2.926", h1: "3.391", h24: "16.413" },
    transactions: {
      m5: { buys: 22, sells: 33, buyers: 12, sellers: 16 },
      h24: { buys: 12720, sells: 10799, buyers: 1592, sellers: 1682 },
    },
    volume_usd: { m5: "10344.8738645394", h24: "2123773.6057423" },
    reserve_in_usd: "521702.1056",
  },
  relationships: {
    base_token: { data: { id: "robinhood_0x0e0d2c89a5a019fe1cf762e5e33187631dacc21b", type: "token" } },
    quote_token: { data: { id: "robinhood_0x0bd7d308f8e1639fab988df18a8011f41eacad73", type: "token" } },
    dex: { data: { id: "uniswap-v3-robinhood", type: "dex" } },
  },
};

/**
 * A real `pons-v2-dex` trending row, same capture. Identified by a 32-byte
 * poolId rather than a contract address — as are the v4 and Bankr pools.
 */
const MICRODUCK = {
  attributes: {
    address: "0xcde4d35e341901bc0308c2ffc789448ccd0f238a59597fe702e6710484b9c370",
    name: "microduck / NVDA",
    pool_created_at: "2026-08-27T00:00:00Z",
    base_token_price_usd: "0.0031",
    reserve_in_usd: "246234.1974",
    fdv_usd: "3100000",
    volume_usd: { h24: "410000" },
    price_change_percentage: { h1: "1.5", h24: "22.4" },
    transactions: { h24: { buys: 900, sells: 700, buyers: 310, sellers: 280 } },
  },
  relationships: {
    base_token: { data: { id: "robinhood_0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725" } },
    dex: { data: { id: "pons-v2-dex" } },
  },
};

describe("parseGeckoPool", () => {
  it("reads a real trending pool", () => {
    const p = parseGeckoPool(CHUMP);
    assert.ok(p);
    assert.equal(p!.poolAddress, "0x714442e9a611f8561a7df108d6d925132937cfb8");
    assert.equal(p!.poolId, "0x714442e9a611f8561a7df108d6d925132937cfb8");
    // The BASE token is what you would buy; the pool address is not it, and
    // confusing the two would have the agent trading the pool contract.
    assert.equal(p!.tokenAddress, "0x0e0d2c89a5a019fe1cf762e5e33187631dacc21b");
    assert.equal(p!.name, "CHUMP / WETH 1%");
    assert.equal(p!.dex, "uniswap-v3-robinhood");
  });

  it("turns the API's strings into numbers, not NaN", () => {
    // Every figure below arrives quoted. A silent NaN here would propagate into
    // a comparison that is false against every limit, and the screen would drop
    // everything while looking like it was working.
    const p = parseGeckoPool(CHUMP)!;
    for (const [k, v] of Object.entries({
      priceUsd: p.priceUsd, reserveUsd: p.reserveUsd, fdvUsd: p.fdvUsd,
      volume24hUsd: p.volume24hUsd, change24hPct: p.change24hPct,
    })) assert.ok(typeof v === "number" && Number.isFinite(v), `${k} = ${v}`);
    assert.ok(Math.abs(p.reserveUsd! - 521_702.1056) < 0.001);
    assert.ok(Math.abs(p.priceUsd! - 0.0222452357304331) < 1e-12);
  });

  it("keeps a NEGATIVE change negative", () => {
    // "-2.926" losing its sign would read as a 3% gain — the wrong direction on
    // the one field a momentum decision turns on.
    const p = parseGeckoPool({ ...CHUMP, attributes: { ...CHUMP.attributes, price_change_percentage: { h1: "-2.926", h24: "-40.5" } } })!;
    assert.equal(p.change1hPct, -2.926);
    assert.equal(p.change24hPct, -40.5);
  });

  it("counts DISTINCT buyers, not transactions", () => {
    // 12,720 buys but only 1,592 buyers. Wash trading inflates the first
    // cheaply; the second is what the screen tests.
    const p = parseGeckoPool(CHUMP)!;
    assert.equal(p.buys24h, 12_720);
    assert.equal(p.buyers24h, 1_592);
    assert.notEqual(p.buyers24h, p.buys24h);
  });

  it("keeps every window the index published, not just the day", () => {
    // The capture carries a five-minute tape — counts, distinct addresses on
    // BOTH sides, its own volume and its own change — and the parser used to
    // read the h24 entry and drop the rest. Everything a token page wants to
    // show over a short horizon was arriving and being thrown away.
    const b = parseGeckoPool(CHUMP)!.buckets;
    assert.equal(b.m5.buys, 22);
    assert.equal(b.m5.sells, 33);
    assert.equal(b.m5.buyers, 12);
    assert.equal(b.m5.sellers, 16);
    assert.equal(b.m5.changePct, -2.926);
    assert.equal(b.m5.volumeUsd, 10_344.8738645394);
  });

  it("reports a window the index omitted as null, never as zero", () => {
    // CHUMP is a verbatim capture and it carries NO h6 at all. The distinction
    // is the whole reason this repo prefers null: "nobody traded it in six
    // hours" and "the index did not say" are different facts, and a split bar
    // drawn from a zeroed window would state the first while knowing neither.
    const b = parseGeckoPool(CHUMP)!.buckets;
    assert.equal(b.h6.buys, null);
    assert.equal(b.h6.sells, null);
    assert.equal(b.h6.changePct, null);
    assert.equal(b.h6.volumeUsd, null);
  });

  it("derives the flat 24h fields from the same buckets", () => {
    // The scout filters on the flat names and its tests are written against
    // them. They are now one source of truth with the tape, so a page and a
    // trading decision can never be reading different numbers.
    const p = parseGeckoPool(CHUMP)!;
    assert.equal(p.buys24h, p.buckets.h24.buys);
    assert.equal(p.sells24h, p.buckets.h24.sells);
    assert.equal(p.buyers24h, p.buckets.h24.buyers);
    assert.equal(p.volume24hUsd, p.buckets.h24.volumeUsd);
    assert.equal(p.change24hPct, p.buckets.h24.changePct);
    assert.equal(p.change1hPct, p.buckets.h1.changePct);
  });

  it("dates a pool that is weeks old, not just fresh launches", () => {
    // The whole point of this source: CHUMP launched 2026-07-31 and discovery
    // (which only watches pool creation) can never see it again.
    const p = parseGeckoPool(CHUMP)!;
    assert.equal(p.createdAt, Math.floor(Date.parse("2026-07-31T01:44:31Z") / 1000));
  });

  it("strips the chain prefix off the token id", () => {
    assert.equal(parseGeckoPool(CHUMP)!.tokenAddress, `0x${"0e0d2c89a5a019fe1cf762e5e33187631dacc21b"}`);
  });

  it("KEEPS a Pons pool identified by a 32-byte poolId", () => {
    // The bug this pins: requiring a 20-byte address dropped 9 of 20 trending
    // rows — every pons-v2-dex, uniswap-v4 and bankr pool, i.e. precisely the
    // venues this source was added to reach. The parser reported success the
    // whole time.
    const p = parseGeckoPool(MICRODUCK);
    assert.ok(p, "a v4-style pool is a pool");
    assert.equal(p!.dex, "pons-v2-dex");
    assert.equal(p!.reserveUsd, 246_234.1974);
  });

  it("does not hand out a poolId as if it were a callable address", () => {
    // A 32-byte poolId is a hash of a PoolKey, not a contract. Returning it as
    // `poolAddress` would push the failure to whoever eth_calls it later.
    const p = parseGeckoPool(MICRODUCK)!;
    assert.equal(p.poolAddress, null);
    assert.equal(p.poolId.length, 66);
    // The TOKEN is a real address either way — that is what gets traded.
    assert.equal(p.tokenAddress, "0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725");
    assert.equal(p.tokenAddress.length, 42);
  });

  it("returns null when the pool cannot be IDENTIFIED", () => {
    // A row with no token address is a row about nothing. Better absent than
    // present with a zero address the rest of the code would treat as a token.
    const noRel = { ...CHUMP, relationships: {} };
    assert.equal(parseGeckoPool(noRel), null);
    assert.equal(parseGeckoPool({ ...CHUMP, attributes: { ...CHUMP.attributes, address: "nonsense" } }), null);
    assert.equal(parseGeckoPool(null), null);
    assert.equal(parseGeckoPool({}), null);
  });

  it("allows a MISSING figure to be null instead of dropping the pool", () => {
    // A brand-new curve legitimately has no 24h volume yet. That is a fact the
    // screen should weigh, not a parse failure.
    const fresh = { ...CHUMP, attributes: { ...CHUMP.attributes, volume_usd: {}, fdv_usd: null, price_change_percentage: {} } };
    const p = parseGeckoPool(fresh);
    assert.ok(p, "a pool with no history is still a pool");
    assert.equal(p!.volume24hUsd, null);
    assert.equal(p!.fdvUsd, null);
    assert.equal(p!.change24hPct, null);
    // Crucially null, NOT 0 — zero volume is a claim, absence is not.
    assert.notEqual(p!.volume24hUsd, 0);
  });
});

const pool = (over: Partial<GeckoPool> = {}): GeckoPool => ({
  ...parseGeckoPool(CHUMP)!,
  ...over,
});

describe("screenPools", () => {
  const LIMITS = { minReserveUsd: 25_000, minVolume24hUsd: 50_000, minBuyers24h: 100 };

  it("keeps a real, liquid, actively traded pool", () => {
    const { kept } = screenPools([pool()], LIMITS);
    assert.equal(kept.length, 1);
  });

  it("drops a pool for each limit, and says which", () => {
    const thin = pool({ name: "THIN", reserveUsd: 900 });
    const quiet = pool({ name: "QUIET", volume24hUsd: 12 });
    const lonely = pool({ name: "LONELY", buyers24h: 3 });
    const { kept, dropped } = screenPools([thin, quiet, lonely], LIMITS);
    assert.equal(kept.length, 0);
    assert.match(dropped.find((d) => d.name === "THIN")!.why, /depth/);
    assert.match(dropped.find((d) => d.name === "QUIET")!.why, /volume/);
    assert.match(dropped.find((d) => d.name === "LONELY")!.why, /buyers/);
  });

  it("REFUSES a pool whose figures are unknown", () => {
    // The failure that matters: absent evidence must not read as passing
    // evidence on a step whose whole job is to exclude. A null must never
    // compare as "fine".
    for (const missing of [{ reserveUsd: null }, { volume24hUsd: null }, { buyers24h: null }]) {
      const { kept, dropped } = screenPools([pool(missing as Partial<GeckoPool>)], LIMITS);
      assert.equal(kept.length, 0, `${JSON.stringify(missing)} should not survive`);
      assert.match(dropped[0]!.why, /unknown/);
    }
  });

  it("is a cheapness filter, not a safety one — it cannot approve anything", () => {
    // Everything it returns is still only a CANDIDATE. Nothing here has looked
    // at the chain, and nothing here may stand in for the wall.
    const { kept } = screenPools([pool({ name: "RUG", fdvUsd: 1e12, change24hPct: 9999 })], LIMITS);
    assert.equal(kept.length, 1, "an absurd token still passes a liquidity screen");
  });

  it("returns empty, not everything, on a quiet chain", () => {
    assert.deepEqual(screenPools([], LIMITS), { kept: [], dropped: [] });
  });
});

/**
 * "Could not ask" and "nothing to see" are different facts.
 *
 * This API is keyless and rate-limited, so a refusal is routine — and a
 * dashboard that renders one as an empty market states something false about
 * the world while looking like a perfectly normal quiet page. The same mistake
 * has already been made twice in this repo: the node's 10,000-log cap turned
 * into `[]`, and a null activity map read as a quiet launchpad. `failed` is
 * what keeps it from being made a third time.
 */
describe("fetchGeckoPoolsResult separates a refusal from an empty market", () => {
  const realFetch = globalThis.fetch;
  const withFetch = async (impl: typeof globalThis.fetch, run: () => Promise<void>) => {
    globalThis.fetch = impl;
    try {
      await run();
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  it("a rate limit is failed, NOT an empty market", async () => {
    await withFetch(
      (async () => new Response("slow down", { status: 429 })) as typeof globalThis.fetch,
      async () => {
        const r = await fetchGeckoPoolsResult("trending_pools");
        assert.equal(r.failed, true);
        assert.deepEqual(r.pools, []);
      },
    );
  });

  it("sends Pro credentials only in headers and does not fall back when they are refused", async () => {
    const oldKey = process.env.MERRYMEN_COINGECKO_PRO_API_KEY;
    const oldHome = process.env.MERRYMEN_FLEET_HOME;
    process.env.MERRYMEN_COINGECKO_PRO_API_KEY = "test-private-key";
    delete process.env.MERRYMEN_FLEET_HOME;
    let calls = 0;
    try {
      await withFetch((async (url, init) => {
        calls++;
        assert.equal(String(url), "https://pro-api.coingecko.com/api/v3/onchain/networks/robinhood/pools?page=2");
        assert.equal(new Headers(init?.headers).get("x-cg-pro-api-key"), "test-private-key");
        assert.equal(init?.redirect, "error");
        return new Response("refused", { status: 401 });
      }) as typeof globalThis.fetch, async () => {
        const result = await fetchGeckoPoolsResult("pools", { page: 2 });
        assert.equal(result.failure, "http-401");
        assert.equal(result.failed, true);
        assert.ok(!JSON.stringify(result).includes("test-private-key"));
      });
      assert.equal(calls, 1);
    } finally {
      if (oldKey === undefined) delete process.env.MERRYMEN_COINGECKO_PRO_API_KEY; else process.env.MERRYMEN_COINGECKO_PRO_API_KEY = oldKey;
      if (oldHome === undefined) delete process.env.MERRYMEN_FLEET_HOME; else process.env.MERRYMEN_FLEET_HOME = oldHome;
    }
  });

  it("a genuinely empty list is NOT failed", async () => {
    await withFetch(
      (async () => Response.json({ data: [] })) as typeof globalThis.fetch,
      async () => {
        const r = await fetchGeckoPoolsResult("trending_pools");
        assert.equal(r.failed, false);
        assert.deepEqual(r.pools, []);
      },
    );
  });

  it("a body whose shape changed is failed, not empty", async () => {
    await withFetch(
      (async () => Response.json({ notData: true })) as typeof globalThis.fetch,
      async () => {
        assert.equal((await fetchGeckoPoolsResult("trending_pools")).failed, true);
      },
    );
  });

  it("a thrown request is failed", async () => {
    await withFetch(
      (async () => {
        throw new Error("network down");
      }) as typeof globalThis.fetch,
      async () => {
        assert.equal((await fetchGeckoPoolsResult("trending_pools")).failed, true);
      },
    );
  });

  it("the plain-list wrapper still exists for the tick, which cannot act on the difference", async () => {
    await withFetch(
      (async () => new Response("nope", { status: 500 })) as typeof globalThis.fetch,
      async () => {
        assert.deepEqual(await fetchGeckoPools("trending_pools"), []);
      },
    );
  });
});

describe("the size floor — the cap in high cap", () => {
  const pool = (over: Partial<GeckoPool> = {}): GeckoPool =>
    ({
      poolId: "0x1", poolAddress: null, tokenAddress: "0xtok", name: "COIN/USDG",
      reserveUsd: 100_000, volume24hUsd: 200_000, buyers24h: 500, sellers24h: 100,
      buys24h: 600, sells24h: 100, fdvUsd: 4_000_000, priceUsd: 1,
      change1hPct: 0, change24hPct: 0, createdAt: 0, quoteAddress: "0xq",
      ...over,
    }) as unknown as GeckoPool;

  const LIMITS = { minReserveUsd: 25_000, minVolume24hUsd: 50_000, minBuyers24h: 100 };

  it("NO FLOOR IS THE DEFAULT, and changes nothing", () => {
    // Every tenant who never asks about size sees exactly the feed they saw
    // before — including coins whose FDV cannot be read at all.
    const r = screenPools([pool({ fdvUsd: 40_000 }), pool({ fdvUsd: null })], LIMITS);
    assert.equal(r.kept.length, 2);
  });

  it("A SMALL COIN IS DROPPED, and the reason names both numbers", () => {
    const r = screenPools([pool({ fdvUsd: 40_000 })], { ...LIMITS, minFdvUsd: 1_000_000 });
    assert.equal(r.kept.length, 0);
    assert.match(r.dropped[0]!.why, /FDV \$40,000 < \$1,000,000/);
  });

  it("and a big one is kept", () => {
    const r = screenPools([pool({ fdvUsd: 4_000_000 })], { ...LIMITS, minFdvUsd: 1_000_000 });
    assert.equal(r.kept.length, 1);
  });

  it("AN UNREADABLE SIZE IS REFUSED, not waved through", () => {
    // The rule this file already states for every other limit: on a screening
    // step, absent evidence is not evidence of soundness. A coin whose size
    // cannot be read has not passed a size floor.
    const r = screenPools([pool({ fdvUsd: null })], { ...LIMITS, minFdvUsd: 1_000_000 });
    assert.equal(r.kept.length, 0);
    assert.match(r.dropped[0]!.why, /FDV unknown/);
  });

  it("and the floor never rescues a coin the other limits refused", () => {
    // Order matters only in the message; a thin pool is thin whatever its FDV.
    const r = screenPools([pool({ reserveUsd: 100, fdvUsd: 900_000_000 })], { ...LIMITS, minFdvUsd: 1_000 });
    assert.equal(r.kept.length, 0);
    assert.match(r.dropped[0]!.why, /depth/);
  });
});

/**
 * ONE TOKEN'S OWN POOLS — the lookup a posted address needs (docs/tg-groups.md).
 * The address is a lookup key: validated before it reaches a URL, and what
 * comes back is only pools OF that token. A 404 is the index answering "no
 * pools I know of"; anything else unreadable is a failure, never "none".
 */
describe("readTokenPools", () => {
  const realFetch = globalThis.fetch;
  const withFetch = async (impl: typeof globalThis.fetch, run: () => Promise<void>) => {
    const oldHome = process.env.MERRYMEN_FLEET_HOME;
    delete process.env.MERRYMEN_FLEET_HOME;
    globalThis.fetch = impl;
    try {
      await run();
    } finally {
      globalThis.fetch = realFetch;
      if (oldHome === undefined) delete process.env.MERRYMEN_FLEET_HOME; else process.env.MERRYMEN_FLEET_HOME = oldHome;
    }
  };
  // Each case its own address: the in-process memo is keyed by it.
  const addr = (c: string) => `0x${c.repeat(40)}`;
  const CHUMP_TOKEN = "0x0e0d2c89a5a019fe1cf762e5e33187631dacc21b";

  it("asks the token's pools page and keeps only pools whose base token is that address", async () => {
    const urls: string[] = [];
    await withFetch((async (url) => {
      urls.push(String(url));
      return Response.json({ data: [CHUMP, MICRODUCK] });
    }) as typeof globalThis.fetch, async () => {
      const pools = await readTokenPools(CHUMP_TOKEN.toUpperCase().replace("0X", "0x"));
      assert.deepEqual(pools?.map((p) => p.tokenAddress), [CHUMP_TOKEN]);
    });
    assert.deepEqual(urls, [`https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${CHUMP_TOKEN}/pools?page=1`]);
  });

  it("a 404 is an answer (no pools known), not a failure", async () => {
    await withFetch((async () => new Response("not found", { status: 404 })) as typeof globalThis.fetch, async () => {
      assert.deepEqual(await readTokenPools(addr("1")), []);
      const r = await readTokenPoolsResult(addr("1"));
      assert.equal(r.failed, false);
    });
  });

  it("a rate limit, a timeout-shaped throw or a changed body is null — unreadable is not absent", async () => {
    await withFetch((async () => new Response("slow down", { status: 429, headers: { "retry-after": "7" } })) as typeof globalThis.fetch, async () => {
      assert.equal(await readTokenPools(addr("2")), null);
    });
    await withFetch((async () => { throw new Error("down"); }) as typeof globalThis.fetch, async () => {
      assert.equal(await readTokenPools(addr("3")), null);
    });
    await withFetch((async () => Response.json({ nope: true })) as typeof globalThis.fetch, async () => {
      assert.equal(await readTokenPools(addr("4")), null);
    });
  });

  it("never splices anything but an address into the provider's path", async () => {
    let calls = 0;
    await withFetch((async () => { calls++; return Response.json({ data: [] }); }) as typeof globalThis.fetch, async () => {
      for (const bad of ["0x1234", `0x${"g".repeat(40)}`, `${addr("5")}/../../x`, `0x${"a".repeat(64)}`, ""]) {
        assert.equal(await readTokenPools(bad), null, bad);
      }
    });
    assert.equal(calls, 0);
  });

  it("one request serves every caller for a minute — the look and the tape share it", async () => {
    let calls = 0;
    await withFetch((async () => { calls++; return Response.json({ data: [] }); }) as typeof globalThis.fetch, async () => {
      await Promise.all([readTokenPools(addr("6")), readTokenPools(addr("6"))]);
      await readTokenPools(addr("6"));
    });
    assert.equal(calls, 1);
  });
});

describe("bounded public fallback", () => {
  const realFetch = globalThis.fetch;
  let oldKey: string | undefined, oldHome: string | undefined;
  beforeEach(() => {
    oldKey = process.env.MERRYMEN_COINGECKO_PRO_API_KEY;
    oldHome = process.env.MERRYMEN_FLEET_HOME;
    process.env.MERRYMEN_COINGECKO_PRO_API_KEY = "private-pro-key";
    delete process.env.MERRYMEN_FLEET_HOME;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (oldKey === undefined) delete process.env.MERRYMEN_COINGECKO_PRO_API_KEY; else process.env.MERRYMEN_COINGECKO_PRO_API_KEY = oldKey;
    if (oldHome === undefined) delete process.env.MERRYMEN_FLEET_HOME; else process.env.MERRYMEN_FLEET_HOME = oldHome;
  });

  it("keeps Pro refusal and public success separate, coalesces cached reads, and never sends the key publicly", async () => {
    const urls: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input); urls.push(url);
      assert.equal(init?.redirect, "error");
      const pro = url.startsWith("https://pro-api.coingecko.com/");
      assert.equal(new Headers(init?.headers).get("x-cg-pro-api-key"), pro ? "private-pro-key" : null);
      return pro ? new Response("monthly quota exhausted", { status: 429 }) : Response.json({ data: [CHUMP] });
    };
    const first = await fetchGeckoPoolsResult("new_pools");
    const second = await fetchGeckoPoolsResult("new_pools");
    assert.equal(first.failed, false);
    assert.equal(first.provider, "geckoterminal-public");
    assert.equal(first.primaryFailure, "http-429");
    assert.equal(first.pools[0]?.buyers24h, 1592);
    assert.equal(second.observedAt, first.observedAt);
    assert.equal(urls.length, 2);
    assert.doesNotMatch(JSON.stringify(first), /private-pro-key|monthly quota/);
    await fetchGeckoPoolsResult("pools", { page: 2 });
    assert.equal(urls.length, 3, "a distinct page uses public without another Pro request during cooldown");
    assert.ok(urls[2]?.startsWith("https://api.geckoterminal.com/"));
  });

  it("never replaces missing distinct buyers with transaction count on fallback", async () => {
    const noBuyers = { ...CHUMP, attributes: { ...CHUMP.attributes, transactions: { h24: { buys: 999_999, sells: 999_999 } } } };
    globalThis.fetch = async input => String(input).includes("pro-api") ? new Response("outage", { status: 503 }) : Response.json({ data: [noBuyers] });
    const r = await fetchGeckoPoolsResult("pools");
    assert.equal(r.failed, false);
    assert.equal(r.pools[0]?.buyers24h, null);
    const screened = screenPools(r.pools, { minReserveUsd: 1, minVolume24hUsd: 1, minBuyers24h: 1 });
    assert.equal(screened.kept.length, 0);
    assert.match(screened.dropped[0]!.why, /unknown buyers/);
  });

  it("stops after both providers refuse and keeps the public cooldown independent", async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response("limited", { status: 429, headers: { "retry-after": "180" } }); };
    const first = await fetchGeckoPoolsResult("pools");
    assert.equal(first.failed, true);
    assert.equal(first.failure, "http-429");
    assert.equal(first.provider, "geckoterminal-public");
    const next = await fetchGeckoPoolsResult("new_pools");
    assert.equal(next.failed, true);
    assert.equal(next.failure, "provider-cooldown");
    assert.equal(calls, 2);
  });

  it("passes only the remaining shared budget to a fallback request", async () => {
    let now = Date.now();
    resetGeckoFeedsForTest({ now: () => now, sleep: async ms => { now += ms; } });
    const budgets: number[] = [];
    const result = await cachedGeckoDetail("deadline", async (source, remainingMs) => {
      budgets.push(remainingMs);
      if (source.id === "coingecko-pro") { now += 29_000; return { failed: true, failure: "timeout" }; }
      return { failed: false, observedAt: now };
    }, failure => ({ failed: true, failure }));
    assert.equal(result.failed, false);
    assert.deepEqual(budgets, [30_000, 1000]);
  });

  it("does not consult public for 401/403 or retry a healthy empty market", async () => {
    for (const status of [401, 403, 200]) {
      resetGeckoFeedsForTest();
      let calls = 0;
      globalThis.fetch = async () => { calls++; return status === 200 ? Response.json({ data: [] }) : new Response("refused", { status }); };
      const result = await fetchGeckoPoolsResult("pools");
      assert.equal(result.provider, "coingecko-pro");
      assert.equal(result.primaryFailure, undefined);
      assert.equal(result.failed, status !== 200);
      assert.equal(calls, 1);
    }
  });

  it("keys durable lanes by provider and fleet home instead of reusing the first cache", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "gecko-source-lanes-"));
    let calls = 0;
    globalThis.fetch = async input => {
      calls++;
      return String(input).includes("pro-api") ? Response.json({ data: [CHUMP] }) : new Response("limited", { status: 429 });
    };
    try {
      process.env.MERRYMEN_FLEET_HOME = path.join(home, "first");
      delete process.env.MERRYMEN_COINGECKO_PRO_API_KEY;
      assert.equal((await fetchGeckoPoolsResult("pools")).failure, "http-429");
      process.env.MERRYMEN_COINGECKO_PRO_API_KEY = "private-pro-key";
      assert.equal((await fetchGeckoPoolsResult("pools")).failed, false, "public cooldown does not suppress Pro");
      process.env.MERRYMEN_FLEET_HOME = path.join(home, "second");
      assert.equal((await fetchGeckoPoolsResult("pools")).failed, false);
      assert.equal(calls, 3, "another home has its own coordination store");
    } finally { resetGeckoFeedsForTest(); rmSync(home, { recursive: true, force: true }); }
  });
});

describe("the Pro lane's pace, priority and plan latch", () => {
  const realFetch = globalThis.fetch;
  const KNOBS = ["MERRYMEN_COINGECKO_PRO_API_KEY", "MERRYMEN_FLEET_HOME", "MERRYMEN_COINGECKO_PRO_SPACING_MS", "MERRYMEN_COINGECKO_MONTHLY_CREDITS"] as const;
  let saved: Record<string, string | undefined> = {};
  let now = 0;
  beforeEach(() => {
    saved = Object.fromEntries(KNOBS.map(k => [k, process.env[k]]));
    for (const k of KNOBS) delete process.env[k];
    process.env.MERRYMEN_COINGECKO_PRO_API_KEY = "private-pro-key";
    now = 1_000_000;
    resetGeckoFeedsForTest({ now: () => now, sleep: async ms => { now += ms; } });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetGeckoFeedsForTest();
    for (const k of KNOBS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  });

  /** When each request reached the provider, on the lane's own clock. */
  const recordStarts = (starts: number[]) => {
    globalThis.fetch = (async () => { starts.push(now); return Response.json({ data: [CHUMP] }); }) as typeof globalThis.fetch;
  };

  it("NO KNOBS: the Pro lane is still spaced 3000 ms", async () => {
    const starts: number[] = [];
    recordStarts(starts);
    await fetchGeckoPoolsResult("pools");
    await fetchGeckoPoolsResult("new_pools");
    assert.deepEqual(starts.map(s => s - starts[0]!), [0, 3000]);
  });

  it("the spacing knob sets the pace, and the credit ceiling clamps it fleet-wide", async () => {
    const starts: number[] = [];
    recordStarts(starts);
    process.env.MERRYMEN_COINGECKO_PRO_SPACING_MS = "800";
    await fetchGeckoPoolsResult("pools");
    await fetchGeckoPoolsResult("new_pools");
    assert.equal(starts[1]! - starts[0]!, 800);

    const home = mkdtempSync(path.join(tmpdir(), "gecko-pace-"));
    try {
      resetGeckoFeedsForTest({ now: () => now, sleep: async ms => { now += ms; } });
      process.env.MERRYMEN_FLEET_HOME = home;
      process.env.MERRYMEN_COINGECKO_PRO_SPACING_MS = "300";
      process.env.MERRYMEN_COINGECKO_MONTHLY_CREDITS = "5000000";
      starts.length = 0;
      await fetchGeckoPoolsResult("pools");
      await fetchGeckoPoolsResult("new_pools");
      assert.equal(starts[1]! - starts[0]!, 741, "70% of 5,000,000 credits over 30 days");
    } finally { resetGeckoFeedsForTest(); rmSync(home, { recursive: true, force: true }); }
  });

  it("a Brain evidence detail read is not queued behind the tape", async () => {
    const starts: Record<string, number> = {};
    globalThis.fetch = (async (input: string | URL | Request) => {
      starts[String(input).includes("/trades") ? "evidence" : "tape"] = now;
      return Response.json({ data: [] });
    }) as typeof globalThis.fetch;
    const t = now;
    await fetchGeckoPoolsResult("trending_pools");
    // The default row's next slot is t+3000; the evidence read takes its own.
    const route = `/networks/robinhood/pools/0x${"4".repeat(40)}/trades?token=0x${"3".repeat(40)}`;
    await cachedGeckoDetail<FeedResult>("evidence-leg", async (source, remainingMs) => {
      await fetch(`${source.base}${route}`, { signal: AbortSignal.timeout(remainingMs) });
      return { failed: false, observedAt: now };
    }, failure => ({ failed: true, failure }), { lane: "evidence", route });
    assert.equal(starts.tape, t);
    assert.equal(starts.evidence, t);
  });

  it("CoinGecko's 10005 body is a plan refusal; the endpoint is latched, never retried publicly, and other endpoints still read", async () => {
    const urls: string[] = [];
    const warn = console.warn, lines: string[] = [];
    console.warn = (line: string) => { lines.push(String(line)); };
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input); urls.push(url);
      if (url.includes("/trending_pools")) {
        return new Response(JSON.stringify({ status: { error_code: 10005, error_message: "You may not have access to this endpoint" } }), { status: 401, headers: { "content-type": "application/json" } });
      }
      return Response.json({ data: [CHUMP] });
    }) as typeof globalThis.fetch;
    try {
      const first = await fetchGeckoPoolsResult("trending_pools");
      assert.equal(first.failure, "plan-restricted");
      assert.equal(first.provider, "coingecko-pro");
      assert.equal(first.primaryFailure, undefined, "rejected authority never falls back to public");
      assert.doesNotMatch(JSON.stringify(first), /You may not|private-pro-key/);
      now += 10_000;
      const page2 = await fetchGeckoPoolsResult("trending_pools", { page: 2 });
      assert.equal(page2.failure, "plan-restricted");
      assert.equal(urls.filter(u => u.includes("/trending_pools")).length, 1, "the latched family spends no further requests");
      assert.equal((await fetchGeckoPoolsResult("new_pools")).failed, false);
      const latchLines = lines.filter(l => /refused networks\/robinhood\/trending_pools/.test(l));
      assert.equal(latchLines.length, 1);
      assert.ok(urls.every(u => u.startsWith("https://pro-api.coingecko.com/")));
    } finally { console.warn = warn; }
  });

  /** A Brain-style evidence detail read of one pool's trades, on whichever source the lane picks. */
  const evidenceRead = (n: string) => {
    const route = `/networks/robinhood/pools/0x${n.repeat(40)}/trades?token=0x${"3".repeat(40)}`;
    return cachedGeckoDetail<FeedResult>(`evidence-${n}`, async (source) => {
      const res = await fetch(`${source.base}${route}`);
      return res.ok ? { failed: false, observedAt: now } : { failed: true, failure: `http-${res.status}` };
    }, failure => ({ failed: true, failure }), { lane: "evidence", route });
  };

  it("WITHOUT A KEY there is no evidence row: every public request stays 6.5 s from the last", async () => {
    delete process.env.MERRYMEN_COINGECKO_PRO_API_KEY;
    const starts: number[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      assert.ok(String(input).startsWith("https://api.geckoterminal.com/"));
      starts.push(now);
      return Response.json({ data: [CHUMP] });
    }) as typeof globalThis.fetch;
    await fetchGeckoPoolsResult("trending_pools");
    await evidenceRead("4");
    await evidenceRead("5");
    await fetchGeckoPoolsResult("new_pools");
    assert.deepEqual(starts.map(s => s - starts[0]!), [0, 6500, 13_000, 19_500]);
  });

  it("nor during a Pro outage: an evidence read's public fallback waits its 6.5 s turn", async () => {
    const pub: number[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).includes("pro-api")) return new Response("down", { status: 503 });
      pub.push(now);
      return Response.json({ data: [CHUMP] });
    }) as typeof globalThis.fetch;
    assert.equal((await fetchGeckoPoolsResult("trending_pools")).provider, "geckoterminal-public");
    const r = await evidenceRead("6");
    assert.equal(r.provider, "geckoterminal-public");
    assert.equal(r.primaryFailure, "http-503");
    assert.deepEqual(pub.map(s => s - pub[0]!), [0, 6500]);
  });

  it("a plan latch belongs to the key: fixing the key and restarting asks again at once", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "gecko-latch-key-"));
    const warn = console.warn;
    console.warn = () => {};
    const clock = () => ({ now: () => now, sleep: async (ms: number) => { now += ms; } });
    let asked = 0;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      asked++;
      return new Headers(init?.headers).get("x-cg-pro-api-key") === "mistyped-pro-key"
        ? new Response("", { status: 401 })
        : Response.json({ data: [CHUMP] });
    }) as typeof globalThis.fetch;
    try {
      process.env.MERRYMEN_FLEET_HOME = home;
      process.env.MERRYMEN_COINGECKO_PRO_API_KEY = "mistyped-pro-key";
      assert.equal((await fetchGeckoPoolsResult("trending_pools")).failure, "http-401");
      // The operator fixes the key and restarts: same persistent fleet home.
      now += 10_000;
      resetGeckoFeedsForTest(clock());
      process.env.MERRYMEN_COINGECKO_PRO_API_KEY = "fixed-pro-key";
      const fixed = await fetchGeckoPoolsResult("trending_pools", { page: 2 });
      assert.equal(fixed.failed, false, "not an hour of plan-restricted after the fix");
      assert.equal(asked, 2);
      // The refused key, back inside the hour, is still latched and asks nothing.
      now += 10_000;
      resetGeckoFeedsForTest(clock());
      process.env.MERRYMEN_COINGECKO_PRO_API_KEY = "mistyped-pro-key";
      assert.equal((await fetchGeckoPoolsResult("trending_pools", { page: 3 })).failure, "plan-restricted");
      assert.equal(asked, 2);
    } finally { console.warn = warn; resetGeckoFeedsForTest(); rmSync(home, { recursive: true, force: true }); }
  });

  it("an X answer's pool read names its budget: a slot that does not come in time is skipped, never waited on or paid for", async () => {
    const starts: number[] = [];
    recordStarts(starts);
    // The tape's own read took the evidence row's slot a moment ago.
    await fetchGeckoPoolsResult("new_pools", { lane: "evidence" });
    const t = now;
    const late = await fetchGeckoPoolsResult("trending_pools", { timeoutMs: 1000, budgetMs: 1000, lane: "evidence" });
    assert.equal(late.failed, true);
    assert.match(late.failure ?? "", /^(?:request-budget|timeout)$/);
    assert.equal(starts.length, 1, "nothing was asked, nothing spent");
    assert.ok(now - t <= 1000, "and it waited no longer than its budget");
    // The tape's own read, with no budget named, still reads as it always did.
    assert.equal((await fetchGeckoPoolsResult("trending_pools")).failed, false);
    assert.equal(starts.length, 2);
  });

  it("a 5xx or 429 on Pro is never latched", async () => {
    let pro = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).includes("pro-api")) { pro++; return new Response("{\"status\":{\"error_code\":10005}}", { status: 503 }); }
      return Response.json({ data: [CHUMP] });
    }) as typeof globalThis.fetch;
    await fetchGeckoPoolsResult("pools");
    now += 10_000;
    await fetchGeckoPoolsResult("pools", { page: 2 });
    assert.equal(pro, 2, "a provider outage is asked again; only a plan refusal latches");
  });
});

describe("geckoRefusal", () => {
  it("reads Retry-After and recognises a plan refusal only on a client error", async () => {
    const body = JSON.stringify({ status: { error_code: 10005, error_message: "upgrade" } });
    assert.deepEqual(await geckoRefusal(new Response(body, { status: 401 })), { failure: "plan-restricted", retryAfterMs: 0 });
    assert.deepEqual(await geckoRefusal(new Response(body, { status: 403 })), { failure: "plan-restricted", retryAfterMs: 0 });
    assert.deepEqual(await geckoRefusal(new Response("refused", { status: 401 })), { failure: "http-401", retryAfterMs: 0 });
    assert.deepEqual(await geckoRefusal(new Response(body, { status: 429, headers: { "retry-after": "30" } })), { failure: "http-429", retryAfterMs: 30_000 });
    assert.deepEqual(await geckoRefusal(new Response(body, { status: 500 })), { failure: "http-500", retryAfterMs: 0 });
    // A huge body is not read past the bound and is not a plan refusal.
    assert.equal((await geckoRefusal(new Response(`${"x".repeat(10_000)}${body}`, { status: 401 }))).failure, "http-401");
    // Test doubles without headers or a body still produce a code.
    assert.deepEqual(await geckoRefusal({ status: 429 }), { failure: "http-429", retryAfterMs: 0 });
  });
});
