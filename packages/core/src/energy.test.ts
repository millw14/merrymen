import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFunctionData, pad, toHex } from "viem";

import {
  ENERGY,
  ENERGY_FULL_RAW,
  ENERGY_NOTICE_PREFIX,
  ENERGY_ROUTE_V1,
  ENERGY_SWAP_SELECTOR,
  GRANT_ENERGY,
  VIRTUAL_TOKEN,
  energyCallWords,
  energyReserveTokens,
  grantEnergyRoute,
  isEnergyReserveToken,
  parseEnergyStatus,
  type EnergyStatus,
} from "./energy";
import { CIRCLE_TIERS, MERRYMEN_TOKEN } from "./token";
import { CASH } from "./tokens";
import { UNISWAP } from "./protocols";
import { UNISWAP_V2_ENERGY_ABI } from "./abis";

/**
 * THE CONTRACT EVERY TIER SHARES. The worker throttles against these numbers,
 * the wall seals this route, the web renders this report. If any of them drift
 * apart the failure is silent: a banner that says one thing while the worker
 * does another, or a wall that permits a route the worker no longer builds.
 */
describe("energy thresholds come from the tier table, never a literal", () => {
  it("FULL ENERGY IS THE MERRY MAN TIER", () => {
    const merryman = CIRCLE_TIERS.find((t) => t.id === "merryman")!;
    assert.equal(ENERGY.fullTokens, merryman.minTokens);
    assert.equal(ENERGY.fullTokens, 100_000);
    assert.equal(ENERGY_FULL_RAW, BigInt(merryman.minTokens) * 10n ** 18n);
  });

  it("a low day is about a tenth", () => {
    assert.equal(ENERGY.lowBps, 1_000);
  });

  it("THE TIER TABLE CLAIMS NO THROTTLE — every client renders its perks whether or not the gate is on", () => {
    // /api/circle sends these to the web, iOS and Android unconditionally, and
    // MERRYMEN_ENERGY_GATE is off until an operator turns it on. A perk saying
    // outsiders run on a tenth told non-holders they were throttled when nothing was.
    const outsider = CIRCLE_TIERS.find((t) => t.id === "outsider")!;
    assert.deepEqual(outsider.perks, ["merrymen is free and open to everyone — hold $MERRYMEN to join the Circle"]);
    for (const t of CIRCLE_TIERS) {
      for (const p of t.perks) assert.doesNotMatch(p, /tenth|energy|throttl/i, `${t.id}: ${p}`);
    }
  });

  it("the constants cannot be edited at runtime", () => {
    assert.ok(Object.isFrozen(ENERGY));
    assert.ok(Object.isFrozen(ENERGY_ROUTE_V1));
    assert.ok(Object.isFrozen(ENERGY_ROUTE_V1.path));
  });

  it("the notice prefix is a stable, recognisable opening", () => {
    assert.equal(ENERGY_NOTICE_PREFIX, "Energy spent for ");
  });
});

describe("the reserve token", () => {
  it("IS $MERRYMEN ON ROBINHOOD CHAIN, CASE-INSENSITIVELY", () => {
    assert.deepEqual(energyReserveTokens(4663), [MERRYMEN_TOKEN.address.toLowerCase()]);
    assert.ok(isEnergyReserveToken(MERRYMEN_TOKEN.address));
    assert.ok(isEnergyReserveToken(MERRYMEN_TOKEN.address.toUpperCase().replace("0X", "0x")));
  });

  it("nothing else is, and no chain but mainnet has one", () => {
    assert.equal(isEnergyReserveToken(CASH.USDG), false);
    assert.equal(isEnergyReserveToken(VIRTUAL_TOKEN), false);
    assert.equal(isEnergyReserveToken(null), false);
    assert.equal(isEnergyReserveToken(undefined), false);
    assert.deepEqual(energyReserveTokens(46630), []);
  });
});

describe("ENERGY_ROUTE_V1 — frozen literals that still equal the registry", () => {
  /**
   * The literals are deliberate (a marker names a route forever), so this test
   * is what catches the day a registry constant moves: the route must then
   * become v2, never be edited in place.
   */
  it("ROUTER IS THE v2 ROUTER02 THE REGISTRY NAMES", () => {
    assert.equal(ENERGY_ROUTE_V1.router, UNISWAP.v2Router02.toLowerCase());
    assert.equal(ENERGY_ROUTE_V1.chainId, MERRYMEN_TOKEN.chainId);
  });

  it("PATH IS USDG → VIRTUAL → $MERRYMEN, lowercase", () => {
    assert.deepEqual(
      [...ENERGY_ROUTE_V1.path],
      [CASH.USDG.toLowerCase(), VIRTUAL_TOKEN, MERRYMEN_TOKEN.address.toLowerCase()],
    );
    for (const a of ENERGY_ROUTE_V1.path) assert.equal(a, a.toLowerCase());
  });
});

describe("grantEnergyRoute needs BOTH the marker and mainnet", () => {
  it("marker on 4663 → the route", () => {
    assert.equal(grantEnergyRoute({ grantFeatures: [GRANT_ENERGY], chainId: 4663 }), ENERGY_ROUTE_V1);
  });
  it("marker on testnet → null (the router is codeless there; a CALL would 'land' buying nothing)", () => {
    assert.equal(grantEnergyRoute({ grantFeatures: [GRANT_ENERGY], chainId: 46630 }), null);
  });
  it("no marker → null; no grant → null", () => {
    assert.equal(grantEnergyRoute({ grantFeatures: ["tradeable-v2"], chainId: 4663 }), null);
    assert.equal(grantEnergyRoute({ chainId: 4663 }), null);
    assert.equal(grantEnergyRoute(null), null);
  });
  it("the marker is versioned", () => {
    assert.equal(GRANT_ENERGY, "energy-buy-v1");
  });
});

describe("the calldata words the wall pins are the words viem encodes", () => {
  const SELF = "0x1111111111111111111111111111111111111111" as const;
  const data = encodeFunctionData({
    abi: UNISWAP_V2_ENERGY_ABI,
    functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
    args: [1_000_000n, 999n, [...ENERGY_ROUTE_V1.path], SELF, 1_800_000_000n],
  });

  it("SELECTOR 0x5c11d795, NINE WORDS, 292 BYTES", () => {
    assert.equal(data.slice(0, 10), ENERGY_SWAP_SELECTOR);
    assert.equal(data.length, 10 + 9 * 64);
    assert.equal((data.length - 2) / 2, 292);
  });

  it("w2 = 0xa0 (where the array lives), w3 = to, w5 = 3 (its length), w6..w8 = the path", () => {
    const parsed = energyCallWords(data)!;
    assert.equal(parsed.selector, ENERGY_SWAP_SELECTOR);
    const w = parsed.words;
    assert.equal(w.length, 9);
    assert.equal(w[0], 1_000_000n);
    assert.equal(w[1], 999n);
    assert.equal(w[2], 0xa0n);
    assert.equal(pad(toHex(w[3]!), { size: 20 }), SELF);
    assert.equal(w[4], 1_800_000_000n);
    assert.equal(w[5], 3n);
    assert.equal(w[6], BigInt(ENERGY_ROUTE_V1.path[0]));
    assert.equal(w[7], BigInt(ENERGY_ROUTE_V1.path[1]));
    assert.equal(w[8], BigInt(ENERGY_ROUTE_V1.path[2]));
  });

  it("anything that is not selector + whole words is not parsed", () => {
    assert.equal(energyCallWords("0x5c11d795ab"), null);
    assert.equal(energyCallWords("nothex"), null);
    assert.equal(energyCallWords("0x12"), null);
  });
});

describe("parseEnergyStatus — a report we cannot trust is no report", () => {
  const good: EnergyStatus = {
    v: 1,
    gated: true,
    mode: "enforce",
    level: "low",
    agentTokens: 12_345,
    holderTokens: null,
    needTokens: 100_000,
    day: "2026-09-27",
    resetsAt: 1_790_553_600,
    reviews: { used: 3, allowed: 29 },
    entries: { used: 2, allowed: 2 },
    spent: true,
    buy: "ready",
    estimateUsdg: 36.5,
    at: 1_790_500_000,
  };

  it("ACCEPTS A WELL-FORMED REPORT, FROM AN OBJECT OR ITS JSON", () => {
    assert.deepEqual(parseEnergyStatus(good), good);
    assert.deepEqual(parseEnergyStatus(JSON.stringify(good)), good);
  });

  it("NULL STAYS NULL — IT IS NEVER TURNED INTO ZERO", () => {
    const unread = { ...good, level: "unread", agentTokens: null, holderTokens: null, estimateUsdg: null, reviews: null, entries: { used: null, allowed: 2 } };
    const parsed = parseEnergyStatus(unread)!;
    assert.equal(parsed.agentTokens, null);
    assert.equal(parsed.holderTokens, null);
    assert.equal(parsed.estimateUsdg, null);
    assert.equal(parsed.reviews, null);
    assert.equal(parsed.entries!.used, null);
  });

  it("refuses unknown enums, string numbers, negative counts, missing fields and garbage", () => {
    assert.equal(parseEnergyStatus({ ...good, level: "empty" }), null);
    assert.equal(parseEnergyStatus({ ...good, mode: "on" }), null);
    assert.equal(parseEnergyStatus({ ...good, buy: "maybe" }), null);
    assert.equal(parseEnergyStatus({ ...good, agentTokens: "12345" }), null);
    assert.equal(parseEnergyStatus({ ...good, agentTokens: -1 }), null);
    assert.equal(parseEnergyStatus({ ...good, v: 2 }), null);
    assert.equal(parseEnergyStatus({ ...good, day: "27 Sep" }), null);
    const { entries: _drop, ...missing } = good;
    assert.equal(parseEnergyStatus(missing), null);
    assert.equal(parseEnergyStatus("{not json"), null);
    assert.equal(parseEnergyStatus(null), null);
    assert.equal(parseEnergyStatus([good]), null);
  });

  it("HOLDERCOUNTED IS OPTIONAL — kept when a boolean, absent on older reports, refused otherwise", () => {
    // No wallet that counts is a knowable nothing, not a failed read; the desk
    // needs to tell them apart. Reports written before the field stay valid.
    for (const counted of [true, false]) {
      const r = { ...good, holderCounted: counted };
      assert.deepEqual(parseEnergyStatus(r), r);
      assert.deepEqual(parseEnergyStatus(JSON.stringify(r)), r);
    }
    const old = parseEnergyStatus(good)!;
    assert.ok(!("holderCounted" in old), "an older report is not given a guess");
    assert.equal(parseEnergyStatus({ ...good, holderCounted: "false" }), null);
    assert.equal(parseEnergyStatus({ ...good, holderCounted: 0 }), null);
    assert.equal(parseEnergyStatus({ ...good, holderCounted: null }), null);
  });
});
