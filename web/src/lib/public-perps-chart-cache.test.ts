import assert from "node:assert/strict";
import { it } from "node:test";
import { createPublicReadCache } from "./public-perps-chart-cache";

it("shares in-flight public reads while keeping errors short-lived", async () => {
  const cache = createPublicReadCache<number>();
  let calls = 0;
  let release!: (value: number | null) => void;
  const loader = () => { calls++; return new Promise<number | null>((resolve) => { release = resolve; }); };
  const first = cache.read("BTC:5m", 1_000, 300_000, loader);
  const second = cache.read("BTC:5m", 1_000, 300_000, loader);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  release(42);
  assert.equal(await first, 42);
  assert.equal(await cache.read("BTC:5m", 2_000, 300_000, loader), 42);
  assert.equal(calls, 1);
  const failed = cache.read("ETH:5m", 1_000, 300_000, async () => { calls++; return null; });
  assert.equal(await failed, null);
  assert.equal(await cache.read("ETH:5m", 5_000, 300_000, async () => 7), null);
  assert.equal(await cache.read("ETH:5m", 31_001, 300_000, async () => 7), 7);
});

it("rechecks a valid empty public read promptly", async () => {
  const cache = createPublicReadCache<readonly number[]>();
  let calls = 0;
  const read = (at: number) => cache.read("BTC:4h", at, 14_400_000, async () => { calls++; return calls === 1 ? [] : [42]; },
    (bars) => bars.length === 0 ? 30_000 : 14_400_000);
  assert.deepEqual(await read(1_000), []);
  assert.deepEqual(await read(20_000), []);
  assert.equal(calls, 1);
  assert.deepEqual(await read(31_001), [42]);
  assert.equal(calls, 2);
});
