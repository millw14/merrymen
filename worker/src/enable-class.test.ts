/**
 * A WRITE THAT ERASES WHAT THE OWNER CHOSE IS WORSE THAN NO WRITE.
 *
 * `put` replaces the whole settings blob, so enabling eight fields by writing
 * eight fields would silently delete everything else — including settings an
 * owner deliberately tuned. Dave is the live example: `maxImpactBps: 500` and
 * `slippageBps: 200`, both looser than the defaults, both his.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CANARY, describeCanaryChange, mergeCanary, MUST_PRESERVE, HALT_ENTRIES, HALT_MUST_PRESERVE, mergeHaltEntries, RESUME_ENTRIES, mergeResumeEntries, DAVE_CLASS, classEnableBlockers } from "./enable-class";

describe("enabling the class route preserves everything else", () => {
  it("KEEPS EVERY FIELD IT DOES NOT SET", () => {
    const owner: Record<string, unknown> = {
      maxImpactBps: 500,
      slippageBps: 200,
      liveTradingEnabled: true,
      paperTradingEnabled: true,
      strategy: "steady-basket",
      basketSymbols: ["NVDA"],
      telegramBotToken: "secret",
      assetMode: "all",
    };
    const next = mergeCanary(owner);
    for (const k of MUST_PRESERVE) {
      if (owner[k] === undefined) continue;
      assert.deepEqual(next[k], owner[k], `${k} must survive the write`);
    }
  });

  it("and sets exactly the canary fields", () => {
    const next = mergeCanary({ maxImpactBps: 500 });
    for (const [k, v] of Object.entries(CANARY)) assert.equal(next[k], v, `${k} must be set`);
  });

  it("never touches a field outside its own key set", () => {
    // Structural rather than filtered: the merge spreads CANARY's keys and no
    // others, so a field can only change if it is one of them.
    const owner = { maxImpactBps: 500, slippageBps: 200 };
    const next = mergeCanary(owner);
    const changed = Object.keys(next).filter(
      (k) => (owner as Record<string, unknown>)[k] !== undefined && next[k] !== (owner as Record<string, unknown>)[k],
    );
    assert.deepEqual(changed, []);
  });

  it("works on a tenant with no settings row at all", () => {
    const next = mergeCanary(null);
    assert.equal(next.classSnipeEnabled, true);
  });
});

describe("the canary runs the NORMAL exit rules", () => {
  it("keeps the six-hour hold", () => {
    // Shortening this to finish the demo sooner would prove nothing about the
    // exit that matters.
    assert.equal(CANARY.classMaxHoldSec, 21_600);
  });

  it("and the 85% graduation exit", () => {
    assert.equal(CANARY.classExitAtGraduationPct, 85);
  });

  it("and the 250 USDG depth floor", () => {
    assert.equal(CANARY.classMinDepthUsdg, 250);
  });

  it("and a scout budget that actually admits the position count it claims", () => {
    /**
     * `scoutAllows` refuses outright at 0, so scoutEnabled with no budget makes
     * the whole route inert while looking configured. And a budget below
     * positions x entry silently caps the count below what classMaxPositions
     * says — the third entry would be refused with scout-budget, which reads as
     * a market condition and is not one.
     */
    assert.ok(CANARY.scoutBudgetUsdg > 0, "0 refuses every unpriceable buy");
    assert.ok(
      CANARY.scoutBudgetUsdg >= CANARY.classMaxPositions * CANARY.classPerEntryUsdg,
      `${CANARY.scoutBudgetUsdg} cannot hold ${CANARY.classMaxPositions} x ${CANARY.classPerEntryUsdg}`,
    );
  });
});

describe("the operator sees what changed", () => {
  it("names a field that was unset", () => {
    const lines = describeCanaryChange(null).join("\n");
    assert.match(lines, /classSnipeEnabled\s+\(unset\) -> true/);
  });

  it("and distinguishes an unchanged field from a changed one", () => {
    const lines = describeCanaryChange({ classMinDepthUsdg: 250, classPerEntryUsdg: 0 }).join("\n");
    assert.match(lines, /classMinDepthUsdg\s+250 \(unchanged\)/);
    assert.match(lines, /classPerEntryUsdg\s+0 -> 5/);
  });
});

/**
 * SWITCHING OFF ENTRIES MUST NOT SWITCH OFF THE WAY OUT.
 *
 * Shogun is holding 1,006,167.87 tokens bought with its own money. Stopping it
 * opening more positions is one switch; stopping it closing this one is a
 * different switch, and moving both would strand a live position in a book that
 * can no longer sell it. That is the exact trap the class route was built to
 * avoid — `proposeClassEntries` shipped before any exit existed, and the comment
 * on the exit path calls the gap "not a missing feature, it is a trap".
 *
 * So the halt is ONE field, and these tests are about everything it must leave
 * alone.
 */
describe("halting class entries leaves every exit intact", () => {
  /** A real-shaped settings blob: the canary's, plus the owner's own choices. */
  const owner = {
    classSnipeEnabled: true,
    classMaxHoldSec: 21_600,
    classExitAtGraduationPct: 85,
    liveTradingEnabled: true,
    classPerEntryUsdg: 5,
    classMaxPositions: 3,
    scoutEnabled: true,
    scoutBudgetUsdg: 15,
    maxImpactBps: 500,
    slippageBps: 200,
    assetMode: "all",
    telegramBotToken: "secret-and-must-survive",
  };

  it("turns entries off", () => {
    assert.equal(mergeHaltEntries(owner).classSnipeEnabled, false);
  });

  it("MOVES NOTHING ELSE — every other key byte-identical", () => {
    const after = mergeHaltEntries(owner);
    for (const [k, v] of Object.entries(owner)) {
      if (k === "classSnipeEnabled") continue;
      assert.deepEqual(after[k], v, `${k} must not move`);
    }
    assert.equal(Object.keys(after).length, Object.keys(owner).length, "and nothing is added");
  });

  it("THE EXIT TRIGGERS SPECIFICALLY, named so this cannot regress quietly", () => {
    const after = mergeHaltEntries(owner);
    // The clock and the cliff are the only two things that can close a class
    // position. If either moved, the halt would have stranded the position.
    assert.equal(after.classMaxHoldSec, 21_600, "the hold clock still runs");
    assert.equal(after.classExitAtGraduationPct, 85, "the graduation cliff still fires");
    assert.equal(after.liveTradingEnabled, true, "and the rail the sell rides on is still live");
    for (const k of HALT_MUST_PRESERVE) {
      assert.deepEqual(after[k], (owner as Record<string, unknown>)[k], `${k} is in MUST_PRESERVE`);
    }
  });

  it("HALT_ENTRIES names exactly one field, and it is the entry gate", () => {
    // Structural, not a promise: `mergeHaltEntries` spreads HALT_ENTRIES' own
    // keys, so one key here is the guarantee that one key moves.
    assert.deepEqual(Object.keys(HALT_ENTRIES), ["classSnipeEnabled"]);
    assert.equal(HALT_ENTRIES.classSnipeEnabled, false);
  });

  it("an owner with no settings row at all still gets a well-formed one", () => {
    assert.deepEqual(mergeHaltEntries(null), { classSnipeEnabled: false });
  });
});

/**
 * HALT AND RESUME MUST BE A ROUND TRIP.
 *
 * If resuming touched anything halting did not, the pair would not be inverse
 * and an owner's tuned hold window or graduation cliff would drift a little on
 * every cycle through them.
 */
describe("resuming entries is the exact inverse of halting them", () => {
  const owner = {
    classSnipeEnabled: true,
    classMaxHoldSec: 21_600,
    classExitAtGraduationPct: 85,
    liveTradingEnabled: true,
    classPerEntryUsdg: 5,
    classMaxPositions: 3,
    maxImpactBps: 500,
    slippageBps: 200,
    telegramBotToken: "secret-and-must-survive",
  };

  it("halt then resume returns the settings byte-for-byte", () => {
    assert.deepEqual(mergeResumeEntries(mergeHaltEntries(owner)), owner);
  });

  it("each touches exactly the one field, and it is the same field", () => {
    assert.deepEqual(Object.keys(RESUME_ENTRIES), ["classSnipeEnabled"]);
    assert.deepEqual(Object.keys(HALT_ENTRIES), Object.keys(RESUME_ENTRIES));
    assert.equal(RESUME_ENTRIES.classSnipeEnabled, true);
    assert.equal(HALT_ENTRIES.classSnipeEnabled, false);
  });

  it("and resuming leaves the exit triggers exactly where they were", () => {
    const after = mergeResumeEntries(mergeHaltEntries(owner));
    for (const k of HALT_MUST_PRESERVE) {
      assert.deepEqual(after[k], (owner as Record<string, unknown>)[k], `${k} must not move`);
    }
  });
});

/**
 * ENABLING A ROUTE THE SIGNATURE CANNOT EXECUTE IS THE EXPENSIVE FAILURE.
 *
 * Not "inert" — an agent that scouts, scores, qualifies candidates and builds
 * entry intents its own key can never sign, every tick, forever, while the owner
 * watches it work and sees no trades.
 *
 * And a MISMATCH is worse than an absence: a grant sealed against some other
 * address pins the wall to a vault the executor never uses.
 */
describe("the class route is only enabled when the grant can execute it", () => {
  const VAULT = "0xC8776FAFf15212C359b23BAe531fF3aC7d760E0F";

  it("refuses when no vault is sealed — the owner must re-sign first", () => {
    const b = classEnableBlockers({ sealedVault: null, derivedVault: VAULT });
    assert.equal(b.length, 1);
    assert.match(b[0]!, /carries no class vault.*re-sign/);
  });

  it("REFUSES A MISMATCH, naming both addresses", () => {
    const b = classEnableBlockers({ sealedVault: "0xdead", derivedVault: VAULT });
    assert.equal(b.length, 1);
    assert.match(b[0]!, /0xdead/);
    assert.match(b[0]!, new RegExp(VAULT));
    assert.match(b[0]!, /pin a vault the executor never uses/);
  });

  it("refuses when the vault cannot be derived, rather than assuming a match", () => {
    const b = classEnableBlockers({ sealedVault: VAULT, derivedVault: null });
    assert.equal(b.length, 1);
    assert.match(b[0]!, /could not derive/);
  });

  it("allows a sealed vault that matches, case-insensitively", () => {
    assert.deepEqual(classEnableBlockers({ sealedVault: VAULT, derivedVault: VAULT }), []);
    assert.deepEqual(
      classEnableBlockers({ sealedVault: VAULT.toLowerCase(), derivedVault: VAULT }),
      [],
      "an address is a number; its casing is not a fact about it",
    );
  });
});

/**
 * THE FIELD THAT WOULD HAVE ENABLED DAVE INTO SILENCE.
 *
 * `assetMode: "stocks"` excludes the entire class route — `assetModeAllows`
 * filters trade legs by instrument class, so `proposeClassEntries` returns
 * nothing whatever the other seven fields say. It used to sit in MUST_PRESERVE,
 * so the enabler would have written eight green fields onto an owner who could
 * not act on any of them.
 *
 * Shogun never showed it: his `assetMode` is unset and defaults to "all".
 * Dave's is explicitly "stocks".
 */
describe("enabling the class route sets the asset mode that permits it", () => {
  it("both presets write assetMode:all", () => {
    assert.equal(CANARY.assetMode, "all");
    assert.equal(DAVE_CLASS.assetMode, "all");
  });

  it("and it is no longer claimed as preserved — that claim was the bug", () => {
    assert.equal(
      (MUST_PRESERVE as readonly string[]).includes("assetMode"),
      false,
      "a field the enabler writes cannot also be a field it promises not to touch",
    );
  });

  it("A STOCKS-ONLY OWNER IS ACTUALLY SWITCHED OVER", () => {
    const dave = { assetMode: "stocks", maxImpactBps: 500, slippageBps: 200, liveTradingEnabled: true };
    const after = mergeCanary(dave, DAVE_CLASS);
    assert.equal(after.assetMode, "all", "otherwise the route is on and unreachable");
    assert.equal(after.classSnipeEnabled, true);
  });

  it("but his tuned limits are still his", () => {
    const dave = { assetMode: "stocks", maxImpactBps: 500, slippageBps: 200, liveTradingEnabled: true };
    const after = mergeCanary(dave, DAVE_CLASS);
    assert.equal(after.maxImpactBps, 500, "looser than default, and his");
    assert.equal(after.slippageBps, 200);
    assert.equal(after.liveTradingEnabled, true);
    for (const k of MUST_PRESERVE) {
      if (k in dave) assert.deepEqual(after[k], (dave as Record<string, unknown>)[k], `${k} moved`);
    }
  });

  it("DAVE'S SCOUT BUDGET CLEARS HIS ENTRY SIZE, and is never zero", () => {
    // `scoutAllows` refuses at 0 outright, and Dave's is unset — so leaving it
    // out is exactly the shape that looks configured and does nothing. It must
    // also clear one entry, or the budget caps the position count below what
    // classMaxPositions claims.
    assert.ok(DAVE_CLASS.scoutBudgetUsdg > 0, "zero is a silent off switch");
    assert.ok(
      DAVE_CLASS.scoutBudgetUsdg >= DAVE_CLASS.classPerEntryUsdg,
      "a budget below one entry funds no entries",
    );
  });

  it("and the hold and graduation triggers are written at their normal values", () => {
    // Recorded rather than omitted, so the record says plainly they were not
    // shortened to make a proof finish sooner.
    assert.equal(DAVE_CLASS.classMaxHoldSec, 21_600);
    assert.equal(DAVE_CLASS.classExitAtGraduationPct, 85);
  });
});
