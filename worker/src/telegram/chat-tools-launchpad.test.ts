/**
 * "I don't see launchpad setting anywhere?" — what the agent says about
 * launchpad buying when an owner asks for it.
 *
 * The owner who asked had been told launchpad buying was "dashboard only" and
 * was "near the real money switch" (a guess), that each launch buy was $50,
 * and that "max launch coins held is still 0" (0 is no limit). With scout's
 * per-token cap at its $25 default, ticking the switch would have bought
 * nothing. The settings tool now says where the switch is and what, for this
 * owner, still stands in the way.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

process.env.MERRYMEN_HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-launchpad-"));

const { launchpadStillNeeded, toolByName, TOOL_OUTPUT_MAX } = await import("./chat-tools");
const { GRANT_PONS_CLASS, SETTINGS_DEFAULTS } = await import("../../../packages/core/src/index");

const VAULT = `0x${"c1".repeat(20)}`;
const sealed = { grantFeatures: [GRANT_PONS_CLASS], ponsClassVaultAddress: VAULT } as never;

/** The owner from the DM: switch off, $50 a launch coin, no ceiling, everything else as shipped. */
function theOwner(over: Record<string, unknown> = {}) {
  return {
    ...structuredClone(SETTINGS_DEFAULTS),
    customTokens: [],
    paperTradingEnabled: false,
    classSnipeEnabled: false,
    classPerEntryUsdg: 50,
    classMaxPositions: 0,
    ...over,
  } as Record<string, unknown>;
}

/** Every gate open: what an owner who did all of it would have. */
const ready = (over: Record<string, unknown> = {}) =>
  theOwner({
    classSnipeEnabled: true,
    classPerEntryUsdg: 5,
    liveTradingEnabled: true,
    assetMode: "all",
    discoveryEnabled: true,
    scoutEnabled: true,
    scoutBudgetUsdg: 15,
    scoutPerTokenUsdg: 25,
    ...over,
  });

const needs = (cfg: Record<string, unknown>, grant: unknown = sealed) => launchpadStillNeeded(cfg as never, grant as never);

describe("launchpadStillNeeded — what stands between this owner and a launch buy", () => {
  it("the owner who asked: the switch, scout mode, its budget, its per-token cap, and the vault", () => {
    const said = needs(theOwner(), null).join("\n");
    assert.match(said, /"launchpad buying \(class route\)" tick is off/);
    assert.match(said, /scout mode is off/);
    assert.match(said, /scout budget is \$0/);
    assert.match(said, /"max per token" \$25\.00 is less than one buy of \$50\.00, so every buy is refused/);
    assert.match(said, /no launchpad vault: a "Class vault factory contract" under Advanced settings → Connections, then re-sign/);
    assert.doesNotMatch(said, /per-entry amount is \$0/, "$50 a buy is set");
  });

  it("nothing, once every gate is open", () => {
    assert.deepEqual(needs(ready()), []);
  });

  it("each gate on its own", () => {
    const only = (over: Record<string, unknown>, grant: unknown = sealed) => {
      const said = needs(ready(over), grant);
      assert.equal(said.length, 1, `${JSON.stringify(over)} → ${said.join(" | ")}`);
      return said[0]!;
    };
    assert.match(only({ classSnipeEnabled: false }), /tick is off/);
    assert.match(only({ liveTradingEnabled: false }), /practice mode can't buy launch coins \(Settings → Trading mode\)/);
    assert.match(only({ assetMode: "stocks" }), /stocks only \(Settings → What it trades\)/);
    assert.match(only({ discoveryEnabled: false }), /"watch for new pairs" is off/);
    assert.match(only({ scoutEnabled: false }), /scout mode is off/);
    assert.match(only({ scoutBudgetUsdg: 4 }), /scout budget \$4\.00 is less than one buy of \$5\.00/);
    assert.match(only({ scoutPerTokenUsdg: 4 }), /"max per token" \$4\.00 is less than one buy of \$5\.00/);
    assert.match(only({}, null), /no launchpad vault/);
    assert.match(only({}, { grantFeatures: [], ponsClassVaultAddress: VAULT }), /no launchpad vault/, "a vault address without the feature is not sealed");
  });

  it("a $0 entry is named once, not again as a scout shortfall", () => {
    const said = needs(ready({ classPerEntryUsdg: 0 }));
    assert.deepEqual(said, ["its per-entry amount is $0"]);
  });

  it("asset mode crypto still allows the route; only stocks-only shuts it", () => {
    assert.deepEqual(needs(ready({ assetMode: "crypto" })), []);
  });
});

describe("the settings tool says where launchpad buying is", () => {
  const settings = (cfg: Record<string, unknown>, grant: unknown = null) =>
    toolByName("settings")!.run({}, { cfg, grant, paused: false, book: [], client: null, now: 0, status: {} } as never);

  it("names the section and the switch's label, never just 'dashboard only'", async () => {
    const out = await settings(theOwner());
    assert.match(out, /launchpad buying: off — dashboard only: Settings → Custom tokens & discovery \(a section that starts closed\) → "launchpad buying \(class route\)"/);
    assert.match(out, /launchpad buying still needs, before it buys anything: /);
    assert.match(out, /live trading \(real money\): \w+ — dashboard only: Settings → Trading mode → "live trading"/);
    assert.match(out, /memecoin strategy with real money: \w+ — dashboard only: Settings → What it trades → Trencher mode/);
  });

  it("reads a max-launch-coins of 0 as no limit, so the agent doesn't ask the owner to raise it", async () => {
    const out = await settings(theOwner());
    assert.match(out, /max launch coins held: no limit/);
    assert.doesNotMatch(out, /max launch coins held: 0\b/);
  });

  it("says plainly when nothing is in the way", async () => {
    const out = await settings(ready(), sealed);
    assert.match(out, /launchpad buying: on — dashboard only/);
    assert.match(out, /launchpad buying: nothing I can see is stopping it/);
  });

  it("keeps the where-and-what lines when the whole answer is cut to size", async () => {
    // Every gate shut: the longest these lines get. They come first, so a cut
    // takes the end of the plain list, never the answer the owner asked for.
    const out = await settings(
      theOwner({ liveTradingEnabled: false, assetMode: "stocks", discoveryEnabled: false, classPerEntryUsdg: 50, scoutBudgetUsdg: 10 }),
    );
    assert.ok(out.length <= TOOL_OUTPUT_MAX);
    assert.match(out, /^live trading \(real money\)/);
    assert.match(out, /launchpad buying still needs, before it buys anything: .*re-sign/);
    assert.match(out, /memecoin strategy with real money/);
  });
});
