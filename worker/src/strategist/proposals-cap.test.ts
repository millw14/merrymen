/**
 * THE STRATEGIST HAS TO SIZE TO THE WALL IT IS BEHIND.
 *
 * A new agent is minted with `perTradeUsdg: 10` sealed into its SIGNATURE
 * (web/src/terminal/screens/CreateAgent.tsx), while `llmMaxActionUsdg` defaults
 * to 50 (packages/core/src/settings.ts). The strategist was told the settings
 * number, proposed the settings number, and every action it produced died at
 * `per-trade-cap` — on every agent minted with the default preset, on every
 * window, for the life of the grant.
 *
 * Nothing in Settings could fix it. The cap comes from the signature
 * (`limitsFromGrant`), so an owner reading "trading limits are set and lower
 * than the USDG amount" was correct and still blocked. One of them reported it
 * exactly that way.
 *
 * The fix is `min(setting, snapshot cap)`, folded in above the driver call. It
 * can only ever TIGHTEN — it cannot raise what anybody may spend, and it needs
 * no re-signing, so it repairs every already-signed agent at once. The two
 * alternatives were both wrong: raising the minted preset seals a bigger number
 * into every future grant, and lowering the setting silently shrinks every
 * owner who signed a larger one.
 *
 * The same hoist is what makes a curve leg reachable at all — see the note in
 * strategy.ts — so these tests also pin the ordering that made it inert.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { makeLlmStrategist } from "./strategy";
import type { ProposalDriver } from "./driver";
import type { StrategistUniverse } from "./proposals";
import { takeTick, type Snapshot, type Strategy } from "../strategies/types";

const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const AAPL = "0x4444444444444444444444444444444444444444" as const;

const run = async (s: Strategy, sn: Snapshot) => takeTick(await s.tick(sn));

function universe(over: Partial<StrategistUniverse> = {}): StrategistUniverse {
  return {
    legs: new Map([["AAPL", AAPL]]),
    swapRouter: ROUTER,
    usdg: USDG,
    /** The SETTING — llmMaxActionUsdg's default, in 6dp micro-USDG. */
    maxPerActionUsdg: 50_000_000n,
    maxActionsPerTick: 4,
    ...over,
  };
}

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    cashUsdg: 1_000_000_000n,
    vaultUsdg: 0n,
    holdings: new Map(),
    prices: new Map([["AAPL", { price8: 100_00000000n, stale: false, source: "chainlink" as const }]]),
    pausedTokens: new Set(),
    staleFeeds: new Set(),
    sequencerUp: true,
    spendHeadroomUsdg: 1_000_000_000_000n,
    /** The SIGNATURE — the default minted preset, 10 USDG in micro. */
    perTradeCapUsdg: 10_000_000n,
    ...over,
  };
}

/**
 * A driver that proposes exactly what it is told, and remembers what it saw.
 *
 * `sawCeiling` is in WHOLE USDG, not micro: `buildSignals` divides by 1e6
 * before the model sees anything, because a model reasoning in micro-units
 * would be reasoning in a unit nobody quotes. The micro-unit agreement is
 * pinned separately, at the boundary where it actually matters.
 */
function driverProposing(sizeUsdg: number): ProposalDriver & { sawCeiling: number | null } {
  const d = {
    name: "mock",
    sawCeiling: null as number | null,
    async propose(signals: { maxPerActionUsdg?: unknown }) {
      // What the model is TOLD it may spend. Half the bug lives here: a model
      // told 50 proposes 50, and the drop downstream is then guaranteed.
      const raw = signals?.maxPerActionUsdg;
      d.sawCeiling = typeof raw === "number" ? raw : null;
      return { actions: [{ action: "buy", symbol: "AAPL", sizeUsdg, reason: "" }] };
    },
  };
  return d as ProposalDriver & { sawCeiling: number | null };
}

describe("the strategist ceiling is the tighter of the setting and the signature", () => {
  it("THE MODEL IS TOLD THE SEALED CAP, not the setting", async () => {
    // This is the half that stops the wrong proposal being made at all. A
    // rejection after the fact is a wasted window; the model should never have
    // been offered the larger number.
    const driver = driverProposing(50);
    const s = makeLlmStrategist({ driver, universe: universe(), decisionIntervalMs: 0, now: () => 1 });
    await run(s, snap());
    assert.equal(driver.sawCeiling, 10, "the model was told the settings number, not the grant's");
  });

  it("a proposal above the sealed cap is dropped HERE, not at the wall", async () => {
    const driver = driverProposing(50);
    const s = makeLlmStrategist({ driver, universe: universe(), decisionIntervalMs: 0, now: () => 1 });
    const { intents } = await run(s, snap());
    assert.equal(intents.length, 0, "50 against a sealed cap of 10 must not reach the policy wall");
  });

  it("a proposal within the sealed cap still goes through", async () => {
    const driver = driverProposing(9);
    const s = makeLlmStrategist({ driver, universe: universe(), decisionIntervalMs: 0, now: () => 1 });
    const { intents } = await run(s, snap());
    assert.equal(intents.length, 1, "the fix must not silence a strategist that was sizing correctly");
  });

  it("THE CEILING NEVER RISES — min(), not the snapshot alone", async () => {
    // A generous grant must not widen the settings ceiling. If this ever
    // inverts, an owner who lowered llmMaxActionUsdg deliberately would find
    // it ignored.
    const driver = driverProposing(50);
    const s = makeLlmStrategist({ driver, universe: universe(), decisionIntervalMs: 0, now: () => 1 });
    await run(s, snap({ perTradeCapUsdg: 500_000_000n }));
    assert.equal(driver.sawCeiling, 50, "the setting still binds when the grant is looser");
  });

  it("BOTH SIDES OF THE min() ARE MICRO-USDG, so nobody re-introduces a 1e6 factor", async () => {
    // `limits.ts` scales the grant's whole-USDG cap with usdgUnits(); the
    // universe is built with usdg6(). They agree today, and this says so out
    // loud rather than leaving it to be re-derived by the next reader. If one
    // side were ever whole-USDG the comparison would pick the wrong number by
    // a factor of a million, which is the shape of bug that reads as "the
    // strategist stopped proposing anything".
    const driver = driverProposing(1);
    const s = makeLlmStrategist({ driver, universe: universe({ maxPerActionUsdg: 50_000_000n }), decisionIntervalMs: 0, now: () => 1 });
    await run(s, snap({ perTradeCapUsdg: 10_000_000n }));
    // 10_000_000 micro compared against 50_000_000 micro, reported as 10 whole.
    assert.equal(driver.sawCeiling, 10);
  });
});

describe("the universe is merged BEFORE the model is asked", () => {
  it("INVARIANT: buildSignals receives the merged universe", () => {
    // This ordering is not cosmetic. `buildSignals` derives `tradableSymbols`
    // and `prices` from `universe.legs`, so anything merged in afterwards was
    // never offered to the model — which is how `curveLegsNow` came to be
    // declared, forwarded, consumed and completely inert, with every memecoin
    // proposal dying as "not in the tradable universe".
    const src = readFileSync(new URL("./strategy.ts", import.meta.url), "utf8");
    assert.match(src, /buildSignals\(snap, universeNow/, "the model must see the merged universe");
    const merge = src.indexOf("const universeNow");
    const signals = src.indexOf("buildSignals(snap, universeNow");
    assert.ok(merge > 0 && signals > merge, "the merge must happen above the driver call, not below it");
  });

  it("INVARIANT: the ceiling is a min(), stated in the source", () => {
    const src = readFileSync(new URL("./strategy.ts", import.meta.url), "utf8");
    assert.match(src, /snap\.perTradeCapUsdg/, "the sealed cap must be read");
    assert.match(
      src,
      /cfg\.universe\.maxPerActionUsdg < snap\.perTradeCapUsdg/,
      "the comparison must pick the tighter of the two",
    );
  });
});
