/**
 * A COIN'S MEASURED FACTS (desk/facts.ts), against AUTON as GeckoTerminal
 * listed it on 2026-10-09 at about 01:15 UTC (desk/testdata/auton-*.json):
 * the main pool, the highest hourly close, the fall, the biggest drop, the
 * pool's 24h participation, holders and the creator's share; and every way a
 * read is refused, bounded or fails. No network: the fetch is a fake.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";

import { COLLAPSE_DRAWDOWN_PCT, collapseOf, type CoinFacts } from "../coin-facts-types";
import { createCoinFactsReader, factsAddressOk, FactsLimiter, mainPoolOf, measureBars, parseFactsInfo, parseFactsPools, type FactsFetch } from "./facts";
import { resetDeskReadsForTest } from "./gecko";

const MINT = "39ahtL8ynzE4amH26J29C93PA5172V3ft9UuUcqQS8fz";
const MAIN = "FiYyzxapRvkbUhF5ZD3mJigWwqBGhtVLH49MDSgCLHdB";
const NOW = Date.parse("2026-10-09T01:15:00Z");
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./testdata/${name}.json`, import.meta.url), "utf8"));

/** A fake index: the AUTON fixtures by route, every route asked recorded. */
function fakeIndex(over: { pools?: unknown; fail?: RegExp } = {}): { fetch: FactsFetch; routes: string[] } {
  const routes: string[] = [];
  const fetch: FactsFetch = async (route) => {
    routes.push(route);
    if (over.fail?.test(route)) return { ok: false, failure: "http-503" };
    if (route === `/networks/solana/tokens/${MINT}/pools?page=1`) return { ok: true, body: over.pools ?? fixture("auton-pools"), observedAt: NOW };
    if (route.startsWith(`/networks/solana/pools/${MAIN}/ohlcv/hour?`)) return { ok: true, body: fixture("auton-ohlcv-hour"), observedAt: NOW };
    if (route === `/networks/solana/tokens/${MINT}/info`) return { ok: true, body: fixture("auton-info"), observedAt: NOW };
    return { ok: false, failure: "http-404" };
  };
  return { fetch, routes };
}

const near = (a: number | null | undefined, b: number, tol: number, what: string): void => {
  assert.ok(typeof a === "number" && Math.abs(a - b) <= tol, `${what}: ${a} not within ${tol} of ${b}`);
};

describe("AUTON, measured (live probe 2026-10-09 01:15 UTC)", () => {
  beforeEach(() => resetDeskReadsForTest());

  it("the main pool is the deepest credible one, never the stale STONK pool with a stranded reserve", () => {
    const pools = parseFactsPools(fixture("auton-pools"), "solana", MINT);
    assert.equal(pools.length, 20, "the LPPP/AUTON pool counts too: AUTON is its quote token");
    const main = mainPoolOf(pools)!;
    assert.equal(main.poolAddress, MAIN);
    assert.equal(main.isBase, true);
    near(main.priceUsd, 0.00003633764859, 1e-12, "price");
    const stonk = pools.find((p) => p.poolAddress === "ECqtTtP6ojGHPwRCEQp6qC2ean6dhn4Kv4e4iTh52rca")!;
    assert.ok(stonk.reserveUsd! > main.reserveUsd!, "its reserve is the larger");
    assert.equal(stonk.volume24hUsd, 0, "and nobody trades it");
    const quoted = pools.find((p) => !p.isBase)!;
    assert.equal(quoted.fdvUsd, null, "a pool where the coin is the quote token says nothing of its FDV");
    assert.equal(quoted.buyers24h, null);
  });

  it("reads every fact the room may hear, with the creator's share and never the creator's address", async () => {
    const idx = fakeIndex();
    const read = createCoinFactsReader({ fetchJson: idx.fetch, now: () => NOW });
    const r = await read({ network: "solana", address: MINT, chatId: -100123, timeoutMs: 10_000, withInfo: true });
    assert.ok(r.ok, JSON.stringify(r));
    const f = r.facts;
    assert.equal(f.network, "solana");
    assert.equal(f.observedAt, NOW);
    near(f.fdvNowUsd, 36_245, 1, "FDV now");
    // The highest HOURLY CLOSE, never the $8.0M wick: the hour from 04:00 UTC on Oct 7.
    near(f.high?.closeUsd, 0.0057625, 0.0000001, "highest close");
    assert.equal(f.high?.atMs, Date.parse("2026-10-07T04:00:00Z"));
    near(f.high?.fdvUsd, 5_748_000, 2_000, "FDV at the highest close");
    near(f.drawdownPct, 99.37, 0.02, "below the highest close");
    // The biggest fall within three hourly closes: about 95% in the three hours from 13:00 UTC on Oct 8.
    near(f.steepest?.pct, 95.1, 0.1, "steepest");
    assert.equal(f.steepest?.fromMs, Date.parse("2026-10-08T13:00:00Z"));
    assert.equal(f.steepest?.hours, 3);
    near(f.liquidityUsd, 16_193.6, 0.1, "liquidity");
    near(f.change24hPct, -98.47, 0.001, "24h change");
    assert.equal(f.buyers24h, 1_157);
    assert.equal(f.sellers24h, 1_576);
    assert.deepEqual(f.holders, { count: 5_683, top10Pct: 34.1077, updatedAtMs: Date.parse("2026-10-08T14:48:21Z") });
    assert.equal(f.creatorHoldingPct, 4.81);
    assert.equal(f.barsFromMs, Date.parse("2026-10-06T18:00:00Z"));
    assert.equal(f.poolCreatedAtMs, Date.parse("2026-10-06T18:43:40Z"));
    assert.equal(f.poolsSeen, 20);
    assert.equal(collapseOf(f), true);
    // No address of any kind is a fact: not the creator's, not the pool's.
    const json = JSON.stringify(f);
    assert.doesNotMatch(json, /CreatorAddressFabricated|FiYyzx|developer/);
    // The mixed-case mint reached the index verbatim: never lowercased.
    assert.ok(idx.routes.every((route) => route.includes(MINT) || route.includes(MAIN)), idx.routes.join("\n"));
    assert.ok(idx.routes.some((route) => route.includes(`token=${MINT}`)));
    assert.equal(idx.routes.length, 3);
  });

  it("without the info read: no holders and no creator's share, and one read fewer", async () => {
    const idx = fakeIndex();
    const r = await createCoinFactsReader({ fetchJson: idx.fetch, now: () => NOW })({ network: "solana", address: MINT, chatId: 1, timeoutMs: 10_000, withInfo: false });
    assert.ok(r.ok);
    assert.equal(r.facts.holders, null);
    assert.equal(r.facts.creatorHoldingPct, null);
    assert.equal(idx.routes.length, 2);
  });

  it("a pool set of dust and stale pools is not-found; a failed pools read is unavailable; failed bars leave no high", async () => {
    const pools = fixture("auton-pools") as { data: Array<{ attributes: Record<string, unknown> }> };
    const junk = { data: pools.data.map((p) => ({ ...p, attributes: { ...p.attributes, reserve_in_usd: (p.attributes.address === "ECqtTtP6ojGHPwRCEQp6qC2ean6dhn4Kv4e4iTh52rca" ? "39449.66" : "500") } })) };
    const notFound = await createCoinFactsReader({ fetchJson: fakeIndex({ pools: junk }).fetch, now: () => NOW })({ network: "solana", address: MINT, chatId: 2, timeoutMs: 10_000, withInfo: false });
    assert.deepEqual(notFound, { ok: false, why: "not-found" });
    resetDeskReadsForTest();
    const down = await createCoinFactsReader({ fetchJson: fakeIndex({ fail: /\/pools\?page=1$/ }).fetch, now: () => NOW })({ network: "solana", address: MINT, chatId: 3, timeoutMs: 10_000, withInfo: false });
    assert.deepEqual(down, { ok: false, why: "unavailable" });
    resetDeskReadsForTest();
    const noBars = await createCoinFactsReader({ fetchJson: fakeIndex({ fail: /ohlcv/ }).fetch, now: () => NOW })({ network: "solana", address: MINT, chatId: 4, timeoutMs: 10_000, withInfo: false });
    assert.ok(noBars.ok);
    assert.equal(noBars.facts.high, null);
    assert.equal(noBars.facts.drawdownPct, null);
    assert.equal(collapseOf(noBars.facts), false, "no high read, no measured collapse: the permit needs its high");
  });

  it("an address that cannot be on the network is refused before any fetch", async () => {
    const idx = fakeIndex();
    const read = createCoinFactsReader({ fetchJson: idx.fetch, now: () => NOW });
    for (const [network, address] of [
      ["solana", "0x39dbed3a00000000000000000000000000000c0d"],
      ["robinhood", MINT],
      ["base", "not-an-address"],
      ["solana", `${MINT}/../../x`],
      ["polygon", "0x39dbed3a00000000000000000000000000000c0d"],
    ] as const) {
      assert.deepEqual(await read({ network: network as never, address, chatId: 5, timeoutMs: 10_000, withInfo: true }), { ok: false, why: "unsupported" }, `${network} ${address}`);
    }
    assert.deepEqual(idx.routes, []);
    assert.equal(factsAddressOk("solana", MINT), true);
    assert.equal(factsAddressOk("ethereum", "0x39DBED3A00000000000000000000000000000C0D"), true);
  });

  it("a room past its four reads in ten minutes, or the agent past twenty an hour, is busy, with no request", async () => {
    let t = NOW;
    const idx = fakeIndex();
    const limiter = new FactsLimiter({ now: () => t });
    const read = createCoinFactsReader({ fetchJson: idx.fetch, now: () => t, limiter });
    for (let i = 0; i < 4; i++) assert.ok((await read({ network: "solana", address: MINT, chatId: 7, timeoutMs: 10_000, withInfo: false })).ok);
    const asked = idx.routes.length;
    assert.deepEqual(await read({ network: "solana", address: MINT, chatId: 7, timeoutMs: 10_000, withInfo: false }), { ok: false, why: "busy" });
    assert.equal(idx.routes.length, asked, "busy costs nothing");
    t += 10 * 60_000;
    assert.ok((await read({ network: "solana", address: MINT, chatId: 7, timeoutMs: 10_000, withInfo: false })).ok, "a new ten minutes");
    const agent = new FactsLimiter({ now: () => t });
    for (let i = 0; i < 20; i++) assert.equal(agent.take(1_000 + i), true);
    assert.equal(agent.take(9_999), false, "twenty an hour for the agent, whichever rooms ask");
  });

  it("a read that outlives its time is unavailable, and the parsers never throw on junk", async () => {
    const slow: FactsFetch = () => new Promise(() => {});
    const r = await createCoinFactsReader({ fetchJson: slow, now: () => NOW })({ network: "solana", address: MINT, chatId: 8, timeoutMs: 30, withInfo: false });
    assert.deepEqual(r, { ok: false, why: "unavailable" });
    for (const junk of [null, undefined, 42, "x", [], { data: null }, { data: [null, 1, "x", { id: 5 }, { attributes: { address: {} } }] }]) {
      assert.deepEqual(parseFactsPools(junk, "solana", MINT), []);
      assert.equal(parseFactsInfo(junk, "solana", MINT), null);
    }
    assert.equal(parseFactsInfo(fixture("auton-info"), "solana", MINT.toLowerCase()), null, "a Solana mint is matched exactly");
    assert.deepEqual(measureBars([], 1, null), { high: null, barsFromMs: null, drawdownPct: null, steepest: null });
  });
});

describe("collapseOf: measured, worth saying, and nearly all gone", () => {
  const f = (over: Partial<CoinFacts>): CoinFacts => ({
    network: "solana", observedAt: NOW, priceUsd: 1, fdvNowUsd: 1_000_000, high: { closeUsd: 2, fdvUsd: 2_000_000, atMs: NOW - 86_400_000 },
    barsFromMs: null, poolCreatedAtMs: null, drawdownPct: 50, steepest: null, liquidityUsd: 50_000, change24hPct: -5,
    buyers24h: null, sellers24h: null, holders: null, creatorHoldingPct: null, info: "read", poolsSeen: 1, ...over,
  });
  it("40% below its high is no collapse; 90% below is", () => {
    assert.equal(collapseOf(f({ drawdownPct: 40 })), false);
    assert.equal(collapseOf(f({ drawdownPct: COLLAPSE_DRAWDOWN_PCT })), true);
    assert.equal(collapseOf(f({ drawdownPct: 89.9, change24hPct: -90 })), true);
  });
  it("dust that went to less dust is no collapse", () => {
    assert.equal(collapseOf(f({ drawdownPct: 99, high: { closeUsd: 2, fdvUsd: 40_000, atMs: NOW } })), false);
    assert.equal(collapseOf(f({ drawdownPct: 99, high: { closeUsd: 2, fdvUsd: null, atMs: NOW }, liquidityUsd: null })), false);
    assert.equal(collapseOf(f({ drawdownPct: 99, high: null })), false);
    assert.equal(collapseOf(null), false);
  });
});
