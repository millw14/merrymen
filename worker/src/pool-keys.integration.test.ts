/**
 * Discovered PoolKeys survive keyless re-sightings — proven against real sqlite.
 *
 * A key is learned ONCE, from the pool's Initialize event, and that sighting
 * may never happen again: later discovery passes go through the gateway (which
 * does not return key fields yet) or re-see the token without the event. If a
 * keyless upsert blanked the captured key, a hooked pool would be routable for
 * ten minutes and then silently never again — and nothing would error.
 *
 * MERRYMEN_HOME is set before any store import runs getDb(); node's --test runs
 * each file in its own process, so the override never leaks.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-poolkeys-"));
process.env.MERRYMEN_HOME = HOME;

const { closeStoreForTest, initStore, poolKeysFor, recordCandidate } = await import("./store");

await initStore();
after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const USDG = "0x00000000000000000000000000000000000000aa";
const MEME = "0x00000000000000000000000000000000000000bb";
const HOOK = "0x00000000000000000000000000000000000000f1";
const KEY = { currency0: USDG, currency1: MEME, fee: 8388608, tickSpacing: 200, hooks: HOOK };
const base = { address: MEME, symbol: "MEME", decimals: 18, liquidityUsd: 1000, fdvUsd: 50_000, firstSeen: 0 };

describe("pool keys in the candidate store", () => {
  it("a captured key is returned for the pair, in either argument order", async () => {
    await recordCandidate({ ...base, key: KEY });
    for (const [a, b] of [
      [USDG, MEME],
      [MEME, USDG],
    ] as const) {
      const keys = await poolKeysFor(a, b);
      assert.equal(keys.length, 1);
      assert.deepEqual(keys[0], KEY);
    }
  });

  it("a KEYLESS re-sighting does not blank the key — learned once is kept", async () => {
    await recordCandidate({ ...base, liquidityUsd: 2000 }); // gateway-shaped update, no key
    const keys = await poolKeysFor(USDG, MEME);
    assert.equal(keys.length, 1, "the key survived");
    assert.deepEqual(keys[0], KEY);
  });

  it("a pair nobody discovered returns empty, and a partial key row never qualifies", async () => {
    assert.deepEqual(await poolKeysFor(USDG, "0x00000000000000000000000000000000000000cc"), []);
  });

  it("a NEW full key replaces the old one — full keys are the only writers", async () => {
    const moved = { ...KEY, fee: 3000, tickSpacing: 60 };
    await recordCandidate({ ...base, key: moved });
    const keys = await poolKeysFor(USDG, MEME);
    assert.equal(keys.length, 1);
    assert.equal(keys[0]!.fee, 3000);
  });
});
