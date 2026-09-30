/**
 * THE SELF-HOSTED KILL'S PERPS HALF (lib/perp-kill.ts; docs/perps.md rule 13).
 *
 * What must hold whatever the worker does:
 *   - a grant without perps asks the worker nothing;
 *   - a request that cannot be written is a REFUSAL, and the route returns it
 *     before it archives anything (writeStanddownRequest's contract);
 *   - a result is turned into the owner's sentence by custodySentence, with
 *     what the result cannot know said as unknown;
 *   - no answer in time is said as exactly that, never as done — and the
 *     sentence then comes from the last report, which may be unread.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { PerpsReport } from "@merrymen/core";
import type { StanddownResult } from "../../../worker/src/perps/standdown";
import { killCustodyFromResult, standDownForKill } from "./perp-kill";

const home = mkdtempSync(path.join(tmpdir(), "mm-perp-kill-"));
after(() => rmSync(home, { recursive: true, force: true }));

const PERP_GRANT = { smartAccount: "0x00000000000000000000000000000000000000a1", grantFeatures: ["perp-lighter-v1"], chainId: 4663 };
const SPOT_GRANT = { smartAccount: "0x00000000000000000000000000000000000000a1", grantFeatures: ["tradeable-v2"], chainId: 4663 };
const NOW = 1_790_697_060_000;

const REPORT: PerpsReport = {
  v: 1,
  mode: "live",
  blocker: null,
  venueReadAt: NOW - 30_000,
  protectAt: null,
  accountIndex: 22149,
  positions: [],
  openNotionalMicro: "0",
  collateralMicro: "5000000",
  inTransitMicro: "1000000",
  minLiqDistanceBps: null,
  stopsMissing: 0,
  incident: false,
};

function result(over: Partial<StanddownResult> = {}): StanddownResult {
  return {
    reason: "kill",
    startedAt: NOW - 5_000,
    finishedAt: NOW,
    deadlineMs: NOW + 60_000,
    outcome: "residual",
    closed: [],
    residual: [{ market: "ETH-PERP", marketId: 0, side: "short", baseAmount: 1000n, stopResting: true, attempts: 3, sizeDecimals: 4 }],
    ordersLeft: 1,
    withdrawRequestedMicro: null,
    failedSteps: ["close ETH-PERP: the book was too thin within 1.5% of mark"],
    ingested: true,
    venue: { readAt: NOW, final: true, collateralMicro: 3_000_000n, isolatedMarginMicro: 2_000_000n, poolShareCount: 0, spotBalanceCount: 0 },
    ...over,
  };
}

describe("standDownForKill", () => {
  it("A GRANT WITHOUT PERPS ASKS NOTHING and gets the sentence its report supports", async () => {
    let wrote = 0;
    const got = await standDownForKill({ home, grant: SPOT_GRANT, report: null, write: () => void wrote++, now: () => NOW });
    assert.equal(wrote, 0);
    assert.ok(got.ok);
    if (!got.ok) return;
    assert.equal(got.standdown, null);
    assert.match(got.custody, /Nothing is held on Lighter/);
  });

  it("A REQUEST THAT CANNOT BE WRITTEN IS A REFUSAL — the kill must not go on as if the worker had been asked", async () => {
    const got = await standDownForKill({
      home,
      grant: PERP_GRANT,
      report: REPORT,
      write: () => {
        throw new Error("EACCES");
      },
      now: () => NOW,
    });
    assert.equal(got.ok, false);
    if (got.ok) return;
    assert.match(got.error, /nothing was stopped/);
    assert.match(got.error, /merrymen kill/);
  });

  it("writes a real, strict request file into the home, with reason kill", async () => {
    const got = await standDownForKill({
      home,
      grant: PERP_GRANT,
      report: REPORT,
      waitMs: 0,
      wait: async () => null,
      now: () => NOW,
    });
    assert.ok(got.ok);
    const file = readdirSync(home).find((f) => f.startsWith("standdown-request-"));
    assert.ok(file, "the worker's own request file is in the home");
    const body = JSON.parse(readFileSync(path.join(home, file!), "utf8")) as Record<string, unknown>;
    assert.equal(body.reason, "kill");
    assert.equal(body.kind, "standdown-request");
    assert.ok(got.ok && got.standdown && got.standdown.nonce === body.nonce);
  });

  it("NO ANSWER IN TIME IS SAID AS SUCH, and the sentence comes from the last report — never 'done'", async () => {
    const got = await standDownForKill({ home, grant: PERP_GRANT, report: null, waitMs: 1_000, wait: async () => null, now: () => NOW });
    assert.ok(got.ok);
    if (!got.ok) return;
    assert.deepEqual({ reported: got.standdown?.reported, outcome: got.standdown?.outcome }, { reported: false, outcome: null });
    assert.match(got.custody, /has not reported back within 1 second\./);
    // No report for a perps grant is unread — never the home sentence.
    assert.match(got.custody, /could not be read/);
    assert.doesNotMatch(got.custody, /stay in your smart account/);
  });

  it("PRACTICE HELD WHILE PERPS ARE OFF is never told as real money at Lighter", async () => {
    // worker lane.ts readPaperLocked: rail "off", the paper position and the paper collateral, no account index.
    const paperOff: PerpsReport = {
      ...REPORT,
      mode: "off",
      blocker: "perps-off",
      accountIndex: null,
      positions: [
        {
          market: "BTC-PERP",
          side: "long",
          baseAmount: "0.00010",
          entryPrice: "60000",
          markPrice: "60100",
          leverage: 2,
          marginMicro: "3000000",
          liqPrice: "30500",
          unrealizedMicro: "10000",
          stopTrigger: "57000",
          fundingMicro: "0",
        },
      ],
      collateralMicro: "6000000",
      inTransitMicro: "0",
    };
    const got = await standDownForKill({ home, grant: PERP_GRANT, report: paperOff, accountMode: "paper", waitMs: 1_000, wait: async () => null, now: () => NOW });
    assert.ok(got.ok);
    if (!got.ok) return;
    assert.doesNotMatch(got.custody, /Still on Lighter: 1 open position/);
    assert.doesNotMatch(got.custody, /6\.00 USDG/);
    // The grant carries perps, and the practice book says nothing about the real venue account: unread.
    assert.match(got.custody, /could not be read/);
    // …and the stand-down's own result never adds practice money in transit.
    assert.match(killCustodyFromResult(result(), { ...paperOff, inTransitMicro: "9000000" }, "paper"), /could not be read\.$/);
  });

  it("A RESULT becomes the sentence, built from it", async () => {
    const got = await standDownForKill({ home, grant: PERP_GRANT, report: REPORT, wait: async () => result(), now: () => NOW });
    assert.ok(got.ok);
    if (!got.ok) return;
    assert.deepEqual({ reported: got.standdown?.reported, outcome: got.standdown?.outcome }, { reported: true, outcome: "residual" });
    assert.match(got.custody, /Could not be closed: ETH-PERP short 0\.1000 \(its stop is still resting\)/);
    assert.doesNotMatch(got.custody, /stay in your smart account/);
  });
});

describe("killCustodyFromResult", () => {
  it("money in transit is counted as still on Lighter, and what nobody read is said as unknown", () => {
    // venue: 3 + 2 isolated = 5 USDG; report in transit 1 → 6 USDG still on Lighter.
    const s = killCustodyFromResult(result(), REPORT);
    assert.match(s, /6\.00 USDG of collateral/);
    assert.match(s, /Other Lighter accounts under your smart account could not be read/);
    assert.match(s, /merrymen recover/);
  });

  it("without a readable report, in-transit money is said to be unknown rather than zero", () => {
    const s = killCustodyFromResult(result(), null);
    assert.match(s, /5\.00 USDG of collateral/);
    assert.match(s, /could not be read\.$/);
  });

  it("an unreachable stand-down is unread", () => {
    const s = killCustodyFromResult(result({ outcome: "unreachable", venue: null, ordersLeft: null, residual: [] }), REPORT);
    assert.match(s, /Lighter could not be read/);
  });
});

describe("the route asks BEFORE it archives, and a refusal returns before the archive", () => {
  const ROUTE = readFileSync(new URL("../app/api/grants/route.ts", import.meta.url), "utf8");
  const del = ROUTE.slice(ROUTE.indexOf("export async function DELETE"));
  const selfHosted = del.slice(del.indexOf("STAND THE PERPS DOWN FIRST"));
  it("standDownForKill, then the refusal's return, then archiveCurrentGrant and rm", () => {
    const ask = selfHosted.indexOf("await standDownForKill(");
    const refuse = selfHosted.indexOf("if (!perps.ok)");
    const archive = selfHosted.indexOf("await archiveCurrentGrant()");
    const rm = selfHosted.indexOf("await rm(GRANT_FILE");
    assert.ok(ask > 0 && refuse > ask && archive > refuse && rm > archive, "ask → refuse → archive → remove");
    assert.match(selfHosted.slice(refuse, archive), /status: 503/);
  });
});
