import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { valuationMultiplierFor, UI_MULTIPLIER_ONE } from "./positions";

/**
 * THE V4 PRICE PATH, WIRED — pinned because every failure here is silent.
 *
 * A graduated Pons coin has no v3 pool (it never had one) and no curve (it left
 * it). Before this pass existed it matched neither pricer, stayed unpriceable
 * forever, and trencher refused it at the `priceable` gate before forming any
 * view of the token. Nothing logged, nothing failed — the agent simply never
 * traded a memecoin, and the reason was three files away from where it showed.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const INDEX = readFileSync(`${HERE}index.ts`, "utf8");

describe("the v4 pass sits between the pools and the curves", () => {
  it("runs on tokens the v3 reader refused for having NO POOL", () => {
    // Not on tokens refused as too thin or divergent: those have a pool and
    // failed its guards, and re-pricing them at another venue would be looking
    // for a venue that answers rather than a price that is true.
    // The pass reads `noPool`, which is built from the v3 reader's own
    // `kind === "no-pool"` refusals — the guard against re-pricing a token that
    // HAS a pool and failed its depth or divergence check somewhere friendlier.
    assert.match(INDEX, /noPool = feedless\.filter\([\s\S]{0,300}?kind === "no-pool"/);
    assert.match(INDEX, /UNISWAP V4[\s\S]*?for \(const t of noPool\)[\s\S]{0,600}?readBestV4Price/);
  });

  it("is ordered BEFORE the curve pass", () => {
    // The CALL sites, not the imports — import order says nothing about which
    // pricer runs first, and an assertion that reads them proves nothing.
    const v4 = INDEX.indexOf("await readBestV4Price(");
    const curve = INDEX.indexOf("await readCurvePrices(");
    assert.ok(v4 > 0 && curve > 0, "both pricers must be CALLED, not merely imported");
    assert.ok(v4 < curve, "v4 must be tried before the curve — a graduated coin has left its curve");
  });

  it("removes a v4-priced token from the refusal list", () => {
    // Leaving it there tells the owner the token is unpriced while its price
    // sits on the dashboard feeding equity — the same bug the curve pass fixed.
    assert.match(INDEX, /pricedV4[\s\S]{0,400}?refused\.splice/);
  });

  it("SKIPS a token whose decimals are unknown rather than assuming 18", () => {
    // Decimals set the scale of the price. Guessing 18 on a 9dp coin misvalues
    // it by a billion, into equity and the drawdown breaker.
    assert.match(INDEX, /t\.decimals === undefined\) continue;/);
  });

  it("prices no native-quoted pool when ETH itself could not be priced", () => {
    // Most v4 pools here quote against native ETH. Defaulting that figure would
    // rescale every memecoin on the chain by a number nobody checked.
    assert.match(INDEX, /eth\.price8 !== null && eth\.price8 > 0n/);
  });

  it("records a REFUSAL rather than silence — the fee is the headline fact", () => {
    // Two-thirds of graduated pools charge over 50% a trade. A coin turned down
    // for that must look turned down, not unseen.
    assert.match(INDEX, /poolRefusals\.set\(t\.symbol, r\.usable\.reason\)/);
  });
});

describe("a v4 mark is a weaker kind of evidence, and stays one", () => {
  it("keeps v4-priced tokens inside the scout budget's reach", () => {
    // Same treatment as a curve mark and for the same reason: no oracle to
    // check the price against. Good enough to value a holding, not good enough
    // to authorise a new one on its own.
    assert.match(INDEX, /q\.source === "curve" \|\| q\.source === "v4"/);
  });

  it("values a whole ERC-20, like every other pool", () => {
    // The exhaustive switch in positions.ts exists so a new source cannot
    // silently inherit Chainlink's per-SHARE unit. v4 changed the venue, not
    // the unit.
    assert.equal(valuationMultiplierFor("v4", 10n ** 18n), UI_MULTIPLIER_ONE);
    assert.equal(valuationMultiplierFor("v4", 5n * 10n ** 18n), UI_MULTIPLIER_ONE);
  });

  it("still differs from chainlink, which quotes per SHARE", () => {
    const ui = 2n * 10n ** 18n;
    assert.equal(valuationMultiplierFor("chainlink", ui), ui);
    assert.notEqual(valuationMultiplierFor("v4", ui), ui);
  });
});

/**
 * THE LIVE RAIL, MADE EXPLICIT.
 *
 * `trenchCandidates` began `if (!paperActive()) return []`, and `paperActive` is
 * defined as the ABSENCE of an executor (`!active.executor`). So arming a live
 * executor did not take the strategy live — it turned the candidate feed OFF.
 * The memecoin strategy stopped seeing anything at the exact moment it became
 * able to act, silently.
 */
describe("trencher goes live only when the owner says so", () => {
  it("still returns nothing when neither paper nor live is on", () => {
    // Tests the GUARD, not its formatting. This pinned the exact one-line source
    // and broke the moment the branch grew a body — a fine trade if the body were
    // cosmetic, but the body IS the fix (next test).
    assert.match(INDEX, /if \(!paperActive\(\) && !cfg\.trencherLiveEnabled\) \{/);
    const guard = INDEX.slice(INDEX.indexOf("if (!paperActive() && !cfg.trencherLiveEnabled)")).slice(0, 1400);
    assert.match(guard, /return \[\];/, "the guard must still return no candidates");
  });

  it("SAYS SO instead of returning an empty feed in silence", () => {
    // A user picked trencher, armed a real key, and got an empty candidate feed
    // every tick forever. He reported it as “it didn't take any trades yet” and
    // then “I think I'm stuck in paper mode” — the shape of a system refusing
    // without saying so. index.ts's own comment calls the surprise out, and then
    // left it silent.
    const guard = INDEX.slice(INDEX.indexOf("if (!paperActive() && !cfg.trencherLiveEnabled)")).slice(0, 1400);
    assert.match(guard, /trencherRailAnnounced/, "the refusal must be announced");
    assert.match(guard, /addEvent/, "and recorded where the owner can see it");
  });

  it("the remedy is reachable from the settings page", () => {
    // The flag had an API branch and no input, so the one action that would fix
    // it could not be taken. Same class as ponsAdapterAddress.
    const page = readFileSync(new URL("../../web/src/app/settings/page.tsx", import.meta.url), "utf8");
    assert.match(page, /trencherLiveEnabled/, "no control means no remedy");
  });

  it("is OFF by default — spending real money is opt-in", async () => {
    const { SETTINGS_DEFAULTS } = await import("../../packages/core/src/index");
    assert.equal(SETTINGS_DEFAULTS.trencherLiveEnabled, false);
  });

  it("composes with the other bounds rather than replacing them", () => {
    // The scout budget is what actually limits a buy into something nobody can
    // independently value, and a v4-priced coin is exactly that. Enabling live
    // trencher must not be a way around it.
    assert.match(INDEX, /q\.source === "curve" \|\| q\.source === "v4"/);
    assert.ok(
      !/trencherLiveEnabled[\s\S]{0,200}?scoutAllows/.test(INDEX),
      "the live flag must not gate or bypass the scout budget",
    );
  });
});
