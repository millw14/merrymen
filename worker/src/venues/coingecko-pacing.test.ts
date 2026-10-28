import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CREDIT_MONTH_MS, PRO_DEFAULT_SPACING_MS, PRO_MIN_SPACING_MS, creditFloorMs, proPacing, proPacingSet } from "./coingecko-pacing";
import { geckoSource, laneSpacingMs } from "./geckoterminal";

describe("CoinGecko Pro pacing knobs", () => {
  it("says whether the operator set either knob at all, readable or not", () => {
    assert.equal(proPacingSet({}), false);
    assert.equal(proPacingSet({ MERRYMEN_COINGECKO_PRO_SPACING_MS: "  " }), false, "blank is unset");
    assert.equal(proPacingSet({ MERRYMEN_COINGECKO_PRO_SPACING_MS: "2600" }), true);
    assert.equal(proPacingSet({ MERRYMEN_COINGECKO_MONTHLY_CREDITS: "5000000" }), true);
    assert.equal(proPacingSet({ MERRYMEN_COINGECKO_PRO_SPACING_MS: "fast" }), true, "an unreadable value is still the operator's choice to pace");
  });

  it("NOTHING SET IS THE OLD PACE, and says nothing", () => {
    const p = proPacing({});
    assert.equal(p.spacingMs, PRO_DEFAULT_SPACING_MS);
    assert.equal(p.spacingMs, 3000);
    assert.equal(p.creditFloorMs, null);
    assert.deepEqual(p.notes, []);
    assert.equal(proPacing({ MERRYMEN_COINGECKO_PRO_SPACING_MS: "  " }).spacingMs, 3000);
  });

  it("the public lane is never configurable and Pro defaults are unchanged", () => {
    const pub = geckoSource({}), pro = geckoSource({ MERRYMEN_COINGECKO_PRO_API_KEY: "k" });
    assert.equal(laneSpacingMs(pub, true, { MERRYMEN_COINGECKO_PRO_SPACING_MS: "100" }), 6500);
    assert.equal(laneSpacingMs(pro, true, {}), 3000);
    assert.equal(laneSpacingMs(pro, false, {}), 3000);
  });

  it("a readable spacing is used as given when no ceiling is set, and the missing ceiling is named", () => {
    const p = proPacing({ MERRYMEN_COINGECKO_PRO_SPACING_MS: "800" });
    assert.equal(p.spacingMs, 800);
    assert.ok(p.notes.some(n => /nothing bounds the month/.test(n)));
    assert.equal(proPacing({ MERRYMEN_COINGECKO_PRO_SPACING_MS: "5_000" }).spacingMs, 5000);
  });

  it("an unreadable value keeps the default and never echoes what was typed", () => {
    for (const raw of ["fast", "-5", "1.5", "0", "CG-secret-looking-value"]) {
      const p = proPacing({ MERRYMEN_COINGECKO_PRO_SPACING_MS: raw });
      assert.equal(p.spacingMs, 3000, raw);
      assert.equal(p.notes.length, 1, raw);
      assert.match(p.notes[0]!, /MERRYMEN_COINGECKO_PRO_SPACING_MS is unreadable/);
      assert.ok(!p.notes.join(" ").includes(raw) || raw === "0", raw);
    }
    const c = proPacing({ MERRYMEN_COINGECKO_MONTHLY_CREDITS: "CG-secret-looking-value", MERRYMEN_COINGECKO_PRO_SPACING_MS: "800" });
    assert.equal(c.creditFloorMs, null);
    assert.equal(c.spacingMs, 800);
    assert.ok(c.notes.some(n => /MONTHLY_CREDITS is unreadable/.test(n)));
    assert.ok(!c.notes.join(" ").includes("CG-secret"));
  });

  it("never faster than the plan's 1,000 requests a minute", () => {
    assert.equal(proPacing({ MERRYMEN_COINGECKO_PRO_SPACING_MS: "10" }).spacingMs, PRO_MIN_SPACING_MS);
    // Even a ceiling generous enough to allow it cannot take the pace under the hard rate.
    assert.equal(proPacing({ MERRYMEN_COINGECKO_PRO_SPACING_MS: "10", MERRYMEN_COINGECKO_MONTHLY_CREDITS: "999999999999" }).spacingMs, 60);
  });

  it("THE FLEET LANE SPENDS AT MOST 70% OF THE MONTH — 5,000,000 credits floors at 741 ms", () => {
    assert.equal(creditFloorMs(5_000_000, 0.7), 741);
    const fast = proPacing({ MERRYMEN_COINGECKO_PRO_SPACING_MS: "300", MERRYMEN_COINGECKO_MONTHLY_CREDITS: "5,000,000" }, "fleet");
    assert.equal(fast.spacingMs, 741);
    assert.equal(fast.creditFloorMs, 741);
    assert.ok(fast.notes.some(n => /using 741 ms/.test(n)));
    // Flat out for a whole 30-day month at the floor stays inside the share.
    assert.ok(CREDIT_MONTH_MS / fast.spacingMs <= 0.7 * 5_000_000);
    // The recommended setting sits above the floor and is used as given.
    const recommended = proPacing({ MERRYMEN_COINGECKO_PRO_SPACING_MS: "800", MERRYMEN_COINGECKO_MONTHLY_CREDITS: "5000000" }, "fleet");
    assert.equal(recommended.spacingMs, 800);
    assert.ok(!recommended.notes.some(n => /would spend more/.test(n)));
  });

  it("a process-local lane (web) gets the smaller 20% share", () => {
    const web = proPacing({ MERRYMEN_COINGECKO_PRO_SPACING_MS: "800", MERRYMEN_COINGECKO_MONTHLY_CREDITS: "5000000" }, "local");
    assert.equal(web.spacingMs, 2592);
    assert.ok(CREDIT_MONTH_MS / web.spacingMs <= 0.2 * 5_000_000);
    // The two lanes together leave headroom in the worst case.
    assert.ok(CREDIT_MONTH_MS / 800 + CREDIT_MONTH_MS / 2592 < 5_000_000);
  });

  it("a ceiling never makes the default pace faster", () => {
    assert.equal(proPacing({ MERRYMEN_COINGECKO_MONTHLY_CREDITS: "5000000" }).spacingMs, 3000);
    // A small plan slows the default down instead.
    assert.equal(proPacing({ MERRYMEN_COINGECKO_MONTHLY_CREDITS: "500000" }).spacingMs, creditFloorMs(500_000, 0.7));
    assert.ok(creditFloorMs(500_000, 0.7) > 3000);
  });
});
