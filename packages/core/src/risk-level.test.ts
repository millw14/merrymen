/**
 * A DIAL THAT MUST NOT LIE ABOUT WHAT IT MOVED.
 *
 * The suggestion came from a beta tester and it is right: nobody opening this
 * for the first time has a view on 300 basis points of price impact. They have
 * a view on how much they mind losing money.
 *
 * The way a control like this goes wrong is not in its numbers — it is in its
 * scope. Two of the seven limits an owner sees are sealed into the signature
 * and enforced on-chain; a settings write cannot touch them. So the tests that
 * matter are the ones about the boundary: that the level never claims those,
 * that picking the middle rung changes nothing for somebody on defaults, and
 * that a hand-tuned book reads as CUSTOM rather than being rounded to the
 * nearest level and quietly having its other five dials moved.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RISK_LEVELS,
  RISK_PROFILES,
  capsNeedResign,
  levelOf,
  riskProfile,
  type RiskSettings,
} from "./risk-level";
import { SETTINGS_DEFAULTS } from "./settings";

describe("the middle rung is the shipped default, not new numbers", () => {
  it("BALANCED MATCHES SETTINGS_DEFAULTS WHERE THE DEFAULTS ARE NON-ZERO", () => {
    // This is what makes `balanced` safe to offer: an owner who has never
    // touched a dial and picks it has changed nothing at all.
    const b = RISK_PROFILES.balanced.settings;
    assert.equal(b.slippageBps, SETTINGS_DEFAULTS.slippageBps);
    assert.equal(b.maxImpactBps, SETTINGS_DEFAULTS.maxImpactBps);
    assert.equal(b.buyPerTickUsdg, SETTINGS_DEFAULTS.buyPerTickUsdg);
    assert.equal(b.llmMaxActionUsdg, SETTINGS_DEFAULTS.llmMaxActionUsdg);
  });

  it("and the two exits it arms are the band the graded floor was specified against", () => {
    // strategistStopLossBps and takeProfitBps ship at 0 — off — so balanced is
    // the one place they become non-zero by choosing a level rather than by
    // typing basis points. 2500/2000 is the band, so the graded floor's
    // 12/25/35 rungs land exactly where they were designed to.
    assert.equal(RISK_PROFILES.balanced.settings.strategistStopLossBps, 2_500);
    assert.equal(RISK_PROFILES.balanced.settings.takeProfitBps, 2_000);
    assert.equal(SETTINGS_DEFAULTS.strategistStopLossBps, 0);
  });
});

describe("the ladder is monotonic in the direction it claims", () => {
  const dial = (k: keyof RiskSettings) => RISK_LEVELS.map((l) => RISK_PROFILES[l].settings[k]);

  it("SIZE RISES WITH THE LEVEL — that is the risk a beginner actually means", () => {
    for (const k of ["buyPerTickUsdg", "llmMaxActionUsdg"] as const) {
      const [careful, balanced, bold] = dial(k);
      assert.ok(careful! < balanced! && balanced! < bold!, `${k} is not ordered: ${dial(k).join(", ")}`);
    }
  });

  it("AND THE FLOOR WIDENS, which is not recklessness", () => {
    // A tight stop on a volatile book pays the spread to be stopped out by
    // noise. Bold gives a position room to be wrong; careful cuts sooner and
    // accepts being shaken out. Both are coherent, and the ladder says which.
    const [careful, balanced, bold] = dial("strategistStopLossBps");
    assert.ok(careful! < balanced! && balanced! < bold!);
  });

  it("and every execution tolerance loosens as the level rises", () => {
    for (const k of ["slippageBps", "maxImpactBps", "takeProfitBps"] as const) {
      const [careful, balanced, bold] = dial(k);
      assert.ok(careful! < balanced! && balanced! < bold!, `${k}: ${dial(k).join(", ")}`);
    }
  });

  it("AND NO LEVEL DISARMS A RULE BY SETTING IT TO ZERO", () => {
    // Zero means OFF for both exits, so a "careful" level that wrote 0 would
    // remove the stop-loss entirely while calling itself the safe choice.
    for (const l of RISK_LEVELS) {
      const s = RISK_PROFILES[l].settings;
      for (const [k, v] of Object.entries(s)) {
        assert.ok(Number(v) > 0, `${l}.${k} is ${v} — zero disarms rather than tightens`);
      }
    }
  });
});

describe("it never claims the limits it cannot reach", () => {
  it("THE SEALED CAPS ARE NAMED, NOT WRITTEN", () => {
    // perTradeUsdg and dailyUsdg are in the signature and enforced on-chain. A
    // selector that wrote them would be lying; one that ignored them would let
    // a careful owner believe their size had come down when the wall still
    // permits the old one.
    const written = Object.keys(RISK_PROFILES.balanced.settings);
    for (const cap of capsNeedResign) {
      assert.ok(!written.includes(cap), `${cap} cannot be set by a settings write`);
    }
    assert.deepEqual([...capsNeedResign], ["perTradeUsdg", "dailyUsdg"]);
  });

  it("and every key it DOES write is one the settings route accepts", async () => {
    // A level that wrote a key the PUT rejects would fail the whole save, so
    // the owner would pick a level and get nothing, with an error about a field
    // they never typed.
    const { readFileSync } = await import("node:fs");
    const route = readFileSync(new URL("../../../web/src/app/api/settings/route.ts", import.meta.url), "utf8");
    for (const k of Object.keys(RISK_PROFILES.balanced.settings)) {
      assert.match(route, new RegExp(`\\b${k}\\b`), `settings route does not accept ${k}`);
    }
  });
});

describe("a hand-tuned book is CUSTOM, not the nearest level", () => {
  it("IT REPORTS NULL RATHER THAN ROUNDING", () => {
    // The failure this prevents: an owner who set one dial by hand opens the
    // screen, the selector highlights "balanced" because it is closest, they
    // touch nothing — and the next save moves the other five back.
    const tuned = { ...RISK_PROFILES.balanced.settings, slippageBps: 137 };
    assert.equal(levelOf(tuned), null);
  });

  it("and an exact match reports its level", () => {
    for (const l of RISK_LEVELS) assert.equal(levelOf(RISK_PROFILES[l].settings), l);
  });

  it("and nothing at all is null rather than a default", () => {
    assert.equal(levelOf(null), null);
    assert.equal(levelOf({}), null);
  });
});

describe("an unknown level falls back rather than throwing", () => {
  it("BALANCED IS THE FALLBACK, and it is the one that changes nothing", () => {
    for (const bad of ["", "AGGRESSIVE", "yolo", null, undefined]) {
      assert.equal(riskProfile(bad as string).level, "balanced", String(bad));
    }
  });

  it("and it is case and whitespace tolerant for what IS a level", () => {
    assert.equal(riskProfile("  BOLD ").level, "bold");
  });
});
