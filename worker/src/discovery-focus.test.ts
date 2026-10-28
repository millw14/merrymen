import assert from "node:assert/strict";
import { test } from "node:test";
import { discoveryPoolOrder } from "./discovery-focus";
import { TrenchBrainReview, TrenchTapeReader, highVolumePools } from "./trencher-brain";
import { emptyGeckoBuckets, type GeckoPool } from "./venues/geckoterminal";
import { mergeSettings } from "./settings";

const pool = (n: number, createdAt: number, volume24hUsd = 200_000): GeckoPool => ({
  tokenAddress: `0x${n.toString(16).padStart(40, "0")}`, poolAddress: `0x${(n + 100).toString(16).padStart(40, "0")}`,
  poolId: String(n), createdAt, volume24hUsd, buyers24h: 50, buys24h: 100, sells24h: 80,
  dex: "uniswap-v3-robinhood", buckets: { ...emptyGeckoBuckets(), m5: { changePct: 2, volumeUsd: 1000, buys: 10, sells: 8, buyers: 9, sellers: 8 } },
} as GeckoPool);

test("discovery preference is per-agent and default ordering remains unchanged", () => {
  assert.equal(mergeSettings({}, { MERRYMEN_DISCOVERY_FOCUS: "new-projects" }).discoveryFocus, "balanced");
  assert.equal(mergeSettings({ discoveryFocus: "new-projects" }, {}).discoveryFocus, "new-projects");
  assert.equal(mergeSettings({ discoveryFocus: "anything" as never }, {}).discoveryFocus, "balanced");
  const now = 1_000_000, old = pool(1, now - 300_000, 1_000_000), fresh = pool(2, now - 1000);
  const future = pool(3, now + 1000), quiet = pool(4, now - 500, 10);
  const screened = highVolumePools([old, fresh, future, quiet]);
  assert.deepEqual(discoveryPoolOrder(screened, "balanced", now), screened);
  assert.equal(discoveryPoolOrder(screened, "new-projects", now)[0], fresh);
  assert.ok(!discoveryPoolOrder(screened, "new-projects", now).includes(quiet), "novelty cannot defeat volume checks");
});

test("the preference adds one bounded new-pool page; disabling removes only that page", async () => {
  const calls: string[] = [];
  const reader = new TrenchTapeReader(async (feed, opts) => {
    calls.push(`${feed}:${opts?.page}`);
    return { failed: false, pools: feed === "new_pools" && opts?.page === 2 ? [pool(9, 1000)] : [] };
  });
  await reader.refresh();
  assert.equal(calls.length, 7);
  assert.ok(calls.includes("new_pools:1"));
  reader.setDiscoveryFocus("new-projects"); calls.length = 0;
  assert.equal((await reader.refresh()).pools.length, 1);
  assert.equal(calls.length, 8);
  assert.ok(calls.includes("new_pools:2"));
  reader.setDiscoveryFocus("balanced");
  assert.equal(reader.snapshot().pools.length, 0);
});

test("new-project ordering preserves the fair review pass and nomination priority", async () => {
  let now = 0;
  const r = new TrenchBrainReview(() => now);
  const old = { token: "old", volume24hUsd: 1_000_000, heat: 100, ageSec: 300_000 };
  const fresh = { token: "fresh", volume24hUsd: 200_000, heat: 1, ageSec: 1000 };
  assert.equal(r.candidate([old, fresh]), old);
  assert.equal(r.candidate([old, fresh], new Set([old.token]), "new-projects"), old);
  const seen: string[] = [];
  for (let i = 0; i < 4; i++) {
    now += 60_000;
    const c = r.candidate([old, fresh], undefined, "new-projects")!;
    seen.push(c.token);
    r.launch("ctx", { market: { symbol: c.token } } as never, c.token, async () => ({ ran: false }) as never, () => {});
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(seen, ["fresh", "old", "fresh", "old"]);
});
