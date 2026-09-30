/**
 * A bonding curve survives in the candidate store — proven against real sqlite.
 *
 * TWO DISCOVERERS NOW WRITE THIS TABLE. The Uniswap/Bitquery pass and the Pons
 * launchpad pass both upsert onto `address`, and each knows things the other
 * does not: only the launchpad has a curve, and only the pool pass can price a
 * token in USD. Every test here is about one of the two blanking something the
 * other captured — the failure mode that produces no error, no log, and a
 * candidate that quietly stops qualifying.
 *
 * MERRYMEN_HOME is set before any store import runs getDb(); node's --test runs
 * each file in its own process, so the override never leaks.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-curves-"));
process.env.MERRYMEN_HOME = HOME;

const { closeStoreForTest, initStore, markPoolSeen, recentCandidates, recordCandidate, seenCurves, seenPools, setTrenchEntry, getTrenchEntry, upgradeTrenchEntry } = await import("./store");

await initStore();
after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const NATIVE = `0x${"0".repeat(40)}`;
// 4.2 ETH — the graduation threshold every native-quoted Pons curve carries.
const THRESHOLD = "4200000000000000000";
const find = async (addr: string) => (await recentCandidates(3600, 100)).find((c) => c.address === addr);

describe("curve columns in the candidate store", () => {
  it("captures the curve and its quote asset", async () => {
    const token = "0x00000000000000000000000000000000000000c1";
    await recordCandidate({
      address: token, symbol: "PONSY", decimals: 18, liquidityUsd: 900, fdvUsd: 12_000, firstSeen: 0,
      curve: { curve: "0x00000000000000000000000000000000000000e1", quoteToken: NATIVE, graduationThresholdRaw: THRESHOLD },
    });
    const got = await find(token);
    assert.ok(got?.curve, "a pre-graduation token is unreachable without its curve");
    assert.equal(got!.curve!.curve, "0x00000000000000000000000000000000000000e1");
  });

  it("a NATIVE-ETH quote survives, rather than reading as absent", async () => {
    // The all-zero address is a meaningful value here — it means native ETH,
    // which is 53.6% of launches. A truthiness test on the column would drop
    // the curve for the majority case.
    const token = "0x00000000000000000000000000000000000000c2";
    await recordCandidate({
      address: token, symbol: "NATIVE", decimals: 18, liquidityUsd: 0, fdvUsd: 0, firstSeen: 0,
      curve: { curve: "0x00000000000000000000000000000000000000e2", quoteToken: NATIVE, graduationThresholdRaw: THRESHOLD },
    });
    const got = await find(token);
    assert.ok(got?.curve, "a native-quoted curve must not vanish");
    assert.equal(got!.curve!.quoteToken, NATIVE);
  });

  it("a CURVELESS re-sighting does not blank the curve", async () => {
    // The Uniswap discoverer re-seeing the same token after it graduates, or a
    // gateway pass that never had a curve. Losing it is worse than losing a
    // PoolKey: there is no tier-scan fallback for a bonding curve.
    const token = "0x00000000000000000000000000000000000000c3";
    await recordCandidate({
      address: token, symbol: "KEEP", decimals: 18, liquidityUsd: 100, fdvUsd: 1_000, firstSeen: 0,
      curve: { curve: "0x00000000000000000000000000000000000000e3", quoteToken: NATIVE, graduationThresholdRaw: THRESHOLD },
    });
    await recordCandidate({ address: token, symbol: "KEEP", decimals: 18, liquidityUsd: 200, fdvUsd: 2_000, firstSeen: 0 });
    assert.equal((await find(token))?.curve?.curve, "0x00000000000000000000000000000000000000e3");
  });
});

describe("one discoverer must not zero the other's figures", () => {
  it("a re-sighting with NO usd figures keeps the ones already captured", async () => {
    // The live hazard: 42.8% of Pons launches are quoted in stock tokens and
    // 2.3% in cbBTC, which this repo cannot price at all, so the launchpad pass
    // legitimately records 0/0. Unconditional overwrite would wipe a real
    // reading and push the candidate under trencher's $25,000 depth and
    // $50,000 FDV gates — with no error and nothing logged.
    const token = "0x00000000000000000000000000000000000000c4";
    await recordCandidate({ address: token, symbol: "RICH", decimals: 18, liquidityUsd: 80_000, fdvUsd: 500_000, firstSeen: 0 });
    await recordCandidate({
      address: token, symbol: "RICH", decimals: 18, liquidityUsd: 0, fdvUsd: 0, firstSeen: 0,
      curve: { curve: "0x00000000000000000000000000000000000000e4", quoteToken: NATIVE, graduationThresholdRaw: THRESHOLD },
    });
    const got = await find(token);
    assert.equal(got?.liquidityUsd, 80_000, "depth was zeroed by a pass that could not price it");
    assert.equal(got?.fdvUsd, 500_000, "fdv was zeroed by a pass that could not price it");
    assert.ok(got?.curve, "and the curve from the zero-figure pass was still captured");
  });

  it("a re-sighting WITH figures still updates them", async () => {
    // The preservation above must not become a freeze: a real new reading wins.
    const token = "0x00000000000000000000000000000000000000c5";
    await recordCandidate({ address: token, symbol: "MOVE", decimals: 18, liquidityUsd: 10_000, fdvUsd: 20_000, firstSeen: 0 });
    await recordCandidate({ address: token, symbol: "MOVE", decimals: 18, liquidityUsd: 3_000, fdvUsd: 9_000, firstSeen: 0 });
    const got = await find(token);
    assert.equal(got?.liquidityUsd, 3_000, "a genuine lower reading must still land");
    assert.equal(got?.fdvUsd, 9_000);
  });

  it("states the cost of that choice honestly: a true drain to zero is not recorded", () => {
    // Documented rather than pretended away. The stored figure is a snapshot
    // from announce time, and trencher re-derives depth every tick from
    // lastLiquidityUsd, falling back to this only when it has no live reading —
    // so a stale non-zero here is the safer of the two available errors.
    assert.ok(true);
  });
});

/**
 * The two discoverers must dedupe INDEPENDENTLY.
 *
 * A Pons launch and that same token's graduation into a Uniswap pool are two
 * different events, and the second matters more: it is when the token becomes
 * tradeable, and the only moment its v4 PoolKey can ever be captured — hook
 * addresses cannot be guessed, so a hooked pool is unroutable without it. An
 * earlier version marked launchpad tokens into the shared seen-set, which
 * permanently suppressed the graduation sighting.
 */
describe("launchpad and pool discovery dedupe separately", () => {
  const LAUNCHED = "0x00000000000000000000000000000000000000d1";

  it("a launchpad row does NOT count as seen by the pool discoverer", async () => {
    await recordCandidate({
      address: LAUNCHED, symbol: "GRADS", decimals: 18, liquidityUsd: 0, fdvUsd: 0, firstSeen: 0,
      curve: { curve: "0x00000000000000000000000000000000000000f1", quoteToken: NATIVE, graduationThresholdRaw: THRESHOLD },
    });
    assert.equal((await seenCurves()).has(LAUNCHED), true, "the launchpad must not re-announce it");
    assert.equal(
      (await seenPools()).has(LAUNCHED),
      false,
      "but the pool discoverer must still announce it when it graduates",
    );
  });

  it("once the pool discoverer announces it, it stops re-announcing", async () => {
    await markPoolSeen(LAUNCHED, "GRADS");
    assert.equal((await seenPools()).has(LAUNCHED), true);
    // And the curve it launched on survives that write.
    const got = await find(LAUNCHED);
    assert.ok(got?.curve, "marking a pool seen must not blank the curve");
  });

  it("a pool-only token is seen by pools and not by curves", async () => {
    const poolOnly = "0x00000000000000000000000000000000000000d2";
    await markPoolSeen(poolOnly, "PLAIN");
    assert.equal((await seenPools()).has(poolOnly), true);
    assert.equal((await seenCurves()).has(poolOnly), false);
  });

  it("re-marking a pool seen does not move its timestamp", async () => {
    // COALESCE on the upsert: the first sighting is the one that counts, and a
    // repeated one must not look like a fresh discovery.
    const before = (await seenPools()).size;
    await markPoolSeen(LAUNCHED, "GRADS");
    assert.equal((await seenPools()).size, before);
  });
});

describe("curve rows do not crowd out the trencher's window", () => {
  it("poolsOnly excludes bonding-curve candidates", async () => {
    // The launchpad adds ~10 rows/hour against a 25-row window ordered by
    // recency, so within hours it would contain nothing else — and those rows
    // can never be entered. Filtered in SQL because the LIMIT is applied by the
    // database; dropping them afterwards would still leave the window full.
    for (let i = 0; i < 30; i++) {
      await recordCandidate({
        address: `0x${String(i).padStart(40, "b")}`, symbol: `C${i}`, decimals: 18,
        liquidityUsd: 0, fdvUsd: 0, firstSeen: 0,
        curve: { curve: "0x00000000000000000000000000000000000000f9", quoteToken: NATIVE, graduationThresholdRaw: THRESHOLD },
      });
    }
    const pool = "0x00000000000000000000000000000000000000d3";
    await recordCandidate({ address: pool, symbol: "REAL", decimals: 18, liquidityUsd: 90_000, fdvUsd: 200_000, firstSeen: 0 });

    const windowed = await recentCandidates(3600, 25, { poolsOnly: true });
    assert.ok(windowed.some((c) => c.address === pool), "the one enterable candidate must survive the window");
    assert.equal(windowed.every((c) => !c.curve), true, "no curve rows may consume a slot");
    // Without the filter it is buried.
    const unfiltered = await recentCandidates(3600, 25);
    assert.ok(unfiltered.some((c) => c.curve), "the unfiltered view still shows them");
  });
});

/**
 * A trench baseline that starts unknown must be able to become known.
 *
 * The row's ABSENCE means "another strategy's position", so a fill with no
 * depth reading still has to write one — and 0 is the honest value, which the
 * drain guard reads as "this check is off". What was missing was the way back:
 * the insert is ON CONFLICT DO NOTHING, so a 0 written at fill time stayed 0
 * for the position's whole life and the rug defence stayed off with it.
 */
describe("trench entry baselines", () => {
  const A = "agent-trench";

  it("a zero baseline is filled in the first time depth is readable", async () => {
    await setTrenchEntry(A, "paper", "UNK", 0);
    assert.equal((await getTrenchEntry(A, "paper", "UNK"))?.liquidityUsd, 0);
    assert.equal(await upgradeTrenchEntry(A, "paper", "UNK", 42_000), true);
    assert.equal((await getTrenchEntry(A, "paper", "UNK"))?.liquidityUsd, 42_000);
  });

  it("NEVER moves a baseline that is already real", async () => {
    // The drain check measures against depth AT ENTRY. Re-anchoring it later
    // would make a drain that already happened stop counting as one — the
    // check would keep reporting healthy all the way down.
    await setTrenchEntry(A, "paper", "REAL", 100_000);
    await upgradeTrenchEntry(A, "paper", "REAL", 5);
    assert.equal((await getTrenchEntry(A, "paper", "REAL"))?.liquidityUsd, 100_000);
  });

  it("refuses to upgrade to a non-positive reading", async () => {
    await setTrenchEntry(A, "paper", "ZERO", 0);
    assert.equal(await upgradeTrenchEntry(A, "paper", "ZERO", 0), false);
    assert.equal(await upgradeTrenchEntry(A, "paper", "ZERO", -1), false);
  });

  it("the row EXISTS even with an unknown baseline, so the position stays owned", async () => {
    // trenchOpen skips a position with no row, treating it as another
    // strategy's. Not writing one made the position invisible to every exit —
    // stop-loss and max-hold included — which is strictly worse than a zero
    // that only disables the drain check.
    await setTrenchEntry(A, "paper", "OWNED", 0);
    assert.notEqual(await getTrenchEntry(A, "paper", "OWNED"), null);
  });
});
