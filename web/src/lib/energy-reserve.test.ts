/**
 * NO WEB SURFACE TELLS AN OWNER TO RE-SIGN FOR $MERRYMEN.
 *
 * Every signer drops the energy reserve from the sealed extras and the worker
 * never watches it, so "add it and re-sign" — the right answer for any other
 * coin the key cannot trade — is advice that can never work for this one. It
 * is energy: bought only by get-energy, in the Merrymen app chat, with the
 * amount confirmed; never sold. Each web site that used to hand out the false
 * advice is executed here (the pure ones) or pinned in its source (the two
 * routes, which read the network and the grant store).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { MERRYMEN_TOKEN } from "@merrymen/core";
import { ENERGY_RESERVE_WHY, snipeEnergyAnswer } from "./energy-reserve";
import { judgeEligibility, watchSetFor } from "./services/eligibility";
import { projectSettings } from "./services/settings-view";
import { addressableSymbol } from "../mcp/tools/proposals";

const MERRY = MERRYMEN_TOKEN.address.toLowerCase();
const MERRY_MIXED = `0x${MERRYMEN_TOKEN.address.slice(2).toUpperCase()}`;
const OWNER_LISTED = { symbol: "MERRYMEN", address: MERRY, decimals: 18 };
/** Advice that can never work for this token, in any of the ways it has been phrased. */
const RESIGN = /re-?sign|add it (by address )?in|signature would cover|would cover it|Settings first/i;
const PRICE = /price|returns?\b|profit|moon|pump|buyback|burn|invest/i;
const settings = (raw: Record<string, unknown>) => projectSettings(raw);

describe("the words", () => {
  it("say what it is and how it is bought, and nothing about its price", () => {
    assert.match(ENERGY_RESERVE_WHY, /energy/);
    assert.match(ENERGY_RESERVE_WHY, /Merrymen app chat/);
    assert.match(ENERGY_RESERVE_WHY, /confirms the amount/);
    assert.match(ENERGY_RESERVE_WHY, /no signature needs to cover it/);
    assert.doesNotMatch(ENERGY_RESERVE_WHY, PRICE);
  });
});

describe("/api/snipe", () => {
  it("a snipe that resolves to $MERRYMEN answers 'energy', places nothing, asks no signature — in any case", () => {
    for (const address of [MERRY, MERRY_MIXED]) {
      const a = snipeEnergyAnswer({ symbol: "MERRYMEN", address })!;
      assert.equal(a.outcome, "energy");
      assert.match(a.say, /my energy, not a coin I trade/);
      assert.match(a.say, /get my \$MERRYMEN/);
      assert.match(a.say, /you confirm the amount first/);
      // The buy is sized to COVER the shortfall with a margin — never "only what I'm short of".
      assert.match(a.say, /I size it to cover what I'm short of, with a small margin/);
      assert.doesNotMatch(a.say, /only buy/);
      assert.doesNotMatch(a.say, RESIGN);
      assert.doesNotMatch(a.say, PRICE);
    }
  });

  it("any other coin is left to the resolver as before", () => {
    assert.equal(snipeEnergyAnswer({ symbol: "MERRYMEN", address: "0x000000000000000000000000000000000000beef" }), null, "an impostor by name is not the reserve");
    assert.equal(snipeEnergyAnswer({ symbol: "TSLA", address: "0x0000000000000000000000000000000000000001" }), null);
  });

  it("the route answers it BEFORE the covered check, so neither 'needs-signature' nor an order can follow", () => {
    const src = readFileSync(new URL("../app/api/snipe/route.ts", import.meta.url), "utf8");
    const at = src.indexOf("snipeEnergyAnswer(t)");
    assert.ok(at > 0, "the route consults it on the resolved target");
    assert.ok(at < src.indexOf("if (!t.covered)"), "before 'needs-signature'");
    assert.ok(at < src.indexOf('outcome: "resolved"'), "and before anything that leads to an order");
  });
});

describe("/api/proposals", () => {
  it("never proposes the energy reserve for a re-sign", () => {
    const src = readFileSync(new URL("../app/api/proposals/route.ts", import.meta.url), "utf8");
    assert.match(src, /const fresh = vetted\.filter\(\(r\) => !covered\.has\(r\.token\.toLowerCase\(\)\) && !isEnergyReserveToken\(r\.token\)\);/);
  });
});

describe("the MCP settings view (projectSettings)", () => {
  const CATE = { symbol: "CATE", address: "0x0000000000000000000000000000000000ca7e00", decimals: 18 };
  const NAMESAKE = { symbol: "MERRYMEN", address: "0x0000000000000000000000000000000000003333", decimals: 18 };

  it("SERVES NEITHER THE RESERVE NOR THE BASKET SYMBOL ONLY IT SUPPLIED — as GET /api/settings, so no basket proposal is fed MERRYMEN", () => {
    const v = settings({ customTokens: [{ ...OWNER_LISTED, address: MERRY_MIXED }, CATE], basketSymbols: ["NVDA", "MERRYMEN", "CATE"] })!;
    assert.deepEqual(v.customTokens, [{ symbol: "CATE", address: CATE.address }]);
    assert.deepEqual(v.basketSymbols, ["NVDA", "CATE"]);
  });

  it("a basket that outlived its reserve entry drops the reserve's name too", () => {
    assert.deepEqual(settings({ customTokens: [CATE], basketSymbols: ["MERRYMEN", "CATE"] })!.basketSymbols, ["CATE"]);
  });

  it("a lookalike at another address that calls itself MERRYMEN is an ordinary token, and stays", () => {
    const v = settings({ customTokens: [OWNER_LISTED, NAMESAKE], basketSymbols: ["MERRYMEN", "NVDA"] })!;
    assert.deepEqual(v.customTokens, [{ symbol: "MERRYMEN", address: NAMESAKE.address }]);
    assert.deepEqual(v.basketSymbols, ["MERRYMEN", "NVDA"]);
  });
});

describe("MCP propose_trade / approval: addressableSymbol", () => {
  it("refuses the reserve with the energy sentence, whether or not the owner listed it", () => {
    for (const s of [settings({}), settings({ customTokens: [OWNER_LISTED] })]) {
      for (const address of [MERRY, MERRY_MIXED]) {
        const r = addressableSymbol(address, s, 4663) as { why: string };
        assert.ok("why" in r, "never an addressable symbol");
        assert.ok(r.why.startsWith(ENERGY_RESERVE_WHY), r.why);
        assert.match(r.why, /A trade proposal cannot buy or sell it/);
        assert.doesNotMatch(r.why, RESIGN);
      }
    }
  });
});

describe("check_token_eligibility: the watch set and the verdict", () => {
  it("watchSetFor never watches an owner-listed $MERRYMEN — the view leaves it out, and a view that carries it drops it with the energy reason", () => {
    assert.ok(!watchSetFor(settings({ customTokens: [OWNER_LISTED] }), 4663).tokens.some((t) => t.address === MERRY), "never watched");
    // Defence in depth: a view that still carries the entry (projectSettings
    // leaves it out now) is dropped as the worker drops it, with the reason.
    const carried = { ...settings({})!, customTokens: [{ symbol: "MERRYMEN", address: MERRY }] };
    const w = watchSetFor(carried, 4663);
    assert.ok(!w.tokens.some((t) => t.address === MERRY), "never watched");
    const d = w.dropped.find((t) => t.address === MERRY)!;
    assert.equal(d.why, ENERGY_RESERVE_WHY);
    assert.ok(!watchSetFor(settings({}), 4663).tokens.some((t) => t.address === MERRY), "nor through any listing");
  });

  it("judgeEligibility says no, because it is energy — and no check tells the owner to add it or re-sign", () => {
    for (const listed of [false, true]) {
      const v = judgeEligibility({
        address: MERRY,
        agent: {
          account: "0x00000000000000000000000000000000000000a1",
          chainId: 4663,
          expiresAt: 2_000_000_000,
          features: ["transfer", "tradeable-v2"],
          grantTokens: [],
        },
        settings: settings(listed ? { customTokens: [OWNER_LISTED] } : {}),
        facts: {
          address: MERRY,
          identity: null,
          stock: null,
          row: null,
          index: { read: "absent", observed_at: null, truncated: false },
          stockMarket: { row: null, read: "not_applicable", fetched_at: null },
        },
        mode: "live",
        now: 1_800_000_000,
      });
      assert.equal(v.executable.state, "no");
      assert.deepEqual(v.executable.reasons, [ENERGY_RESERVE_WHY]);
      const byName = Object.fromEntries(v.checks.map((c) => [c.check, c]));
      assert.equal(byName.grant_can_sell!.result, "not_applicable");
      assert.equal(byName.class_route!.result, "not_applicable");
      assert.equal(byName.trencher_route!.result, "not_applicable");
      for (const c of v.checks) {
        if (c.check === "discovery_lists_it" || c.check === "price_guard" || c.check === "scout_budget") continue; // market facts, not advice
        assert.doesNotMatch(c.detail, RESIGN, `${c.check}: ${c.detail}`);
      }
    }
  });
});
