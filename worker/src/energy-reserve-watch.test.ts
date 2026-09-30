/**
 * THE ENERGY RESERVE NEVER ENTERS THE WATCH SET.
 *
 * $MERRYMEN in the agent's account is energy, not a position. Everything that
 * reads positions is built from the watch set, so this one exclusion is what
 * keeps the reserve out of all of them:
 *
 *   - equity: a watched, priced reserve that the owner sends in reads as profit,
 *     ratchets the persisted (and mirrored, upward-only) peak and accrues a
 *     performance fee on the owner's own tokens;
 *   - the book: a watched, UNPRICEABLE reserve makes it incomplete, which pauses
 *     equity, the peak, fees and the breaker every tick;
 *   - strategies: steady-basket take-profit and the strategist stop-floor sell
 *     EVERY holding — the reserve included, whole.
 *
 * Excluded by ADDRESS, before any list is read, so no route in — the owner's
 * custom tokens, a platform listing — can put it back. Never by mode: the watch
 * set is never narrowed by the asset mode (asset-mode.test.ts pins the call).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MERRYMEN_TOKEN, STOCK_TOKENS, energyReserveTokens } from "../../packages/core/src/index";
import { watchTokensFor } from "./strategies/registry";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MERRYMEN = MERRYMEN_TOKEN.address;
const shout = (a: string) => `0x${a.slice(2).toUpperCase()}` as `0x${string}`;
const PEPE = "0x00000000000000000000000000000000000ee0e0" as `0x${string}`;

describe("watchTokensFor never watches the energy reserve", () => {
  it("drops an owner-added custom token whose address is the reserve — in any case", () => {
    for (const address of [MERRYMEN, shout(MERRYMEN)]) {
      const set = watchTokensFor([], [
        { symbol: "MERRY", address, decimals: 18 },
        { symbol: "PEPE", address: PEPE, decimals: 18 },
      ]);
      assert.deepEqual(set.map((t) => t.symbol), ["PEPE"], `custom ${address}`);
    }
  });

  it("drops an official listing whose address is the reserve — in any case", () => {
    for (const address of [MERRYMEN, shout(MERRYMEN)]) {
      const set = watchTokensFor([], [], [{ symbol: "MERRYMEN", name: "Merrymen", address, decimals: 18 }]);
      assert.equal(set.length, 0, `official ${address}`);
    }
  });

  it("a coin that merely CALLS itself MERRYMEN at another address is not the reserve", () => {
    // By address, never by symbol — a symbol is whatever a list says it is.
    const set = watchTokensFor([], [{ symbol: "MERRYMEN", address: PEPE, decimals: 18 }]);
    assert.deepEqual(set.map((t) => t.address), [PEPE]);
  });

  it("the basket and every other extra are untouched", () => {
    const basket = STOCK_TOKENS.slice(0, 2).map((t) => t.symbol);
    const set = watchTokensFor(basket, [{ symbol: "PEPE", address: PEPE, decimals: 18 }]);
    assert.deepEqual(set.map((t) => t.symbol), [...basket, "PEPE"]);
  });

  it("the reserve this test excludes is the one core names for mainnet", () => {
    assert.deepEqual(energyReserveTokens(4663), [MERRYMEN.toLowerCase()]);
  });

  it("the exclusion is by address, with no mode parameter — the asset-mode invariant holds", () => {
    const src = readFileSync(path.join(__dirname, "strategies/registry.ts"), "utf8");
    const sig = src.match(/export function watchTokensFor\(([\s\S]*?)\): StockToken\[\]/);
    assert.ok(sig, "watchTokensFor is still defined");
    assert.doesNotMatch(sig![1]!, /mode/i, "watchTokensFor takes no mode");
    assert.match(src, /ENERGY_RESERVE_TOKENS/, "and seeds its taken addresses from the reserve list");
  });
});
