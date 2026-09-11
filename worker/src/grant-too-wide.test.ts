import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { canTradeForReal, execModeOf, liveBlocker, publishedMode } from "./exec-mode";
import { autonomyOf, liveBlockerText } from "../../packages/core/src/autonomy";
import { rejectRuleLabel } from "./thesis-policy";

/**
 * A WALL THAT CAN NEVER BE INSTALLED IS KNOWN BEFORE ANYONE IS ASKED.
 *
 * The first operation a session key signs carries its whole permission wall, so
 * that operation's cost is a function of the wall's size — which the signature
 * fixed. When that exceeds what the product will ever sign for, no estimate can
 * change the answer. Two funded agents nonetheless asked, every tick: ~16
 * bundler calls per 97 seconds, forever, for a refusal that was deterministic
 * before the first call went out.
 *
 * Worse than the waste, it was named wrong. `gas-absurd` says "this estimate is
 * larger than we will sign for", which is true and useless — it sends an owner
 * looking for a transient fault. The cause is the wall they signed, and the
 * remedy is a narrower one.
 */

const base = {
  armed: true,
  executor: true,
  chainId: 4663,
  cashUsdg: 100_000_000n,
  deadPolicy: false,
  gasWei: 0n,
  gasSponsored: true,
  paperTradingEnabled: true,
};

describe("an unsupported wall stops the agent before the bundler", () => {
  it("is not tradeable for real", () => {
    assert.equal(canTradeForReal({ ...base, wallTooWide: true }), false);
    assert.equal(canTradeForReal({ ...base, wallTooWide: false }), true);
  });

  it("REFUSES RATHER THAN SIMULATING, even with paper enabled", () => {
    // Every other blocker is a condition the world might fix — money arrives, a
    // chain is switched — and simulating meanwhile is what paper is FOR. This
    // one cannot be fixed by waiting, so pretend fills would tell the owner
    // their agent is working while the one thing that would make it work goes
    // unsaid.
    const m = execModeOf({ ...base, wallTooWide: true, paperTradingEnabled: true });
    assert.equal(m.mode, "refuse");
    assert.equal(m.mode === "refuse" ? m.rule : null, "grant-too-wide");
    assert.equal(publishedMode(m), "idle", "and it publishes as idle, not paper");
  });

  it("every other blocker still simulates when paper is on", () => {
    // The narrowness of the exception is the point — this must not become a
    // general "refuse when anything is wrong".
    assert.equal(execModeOf({ ...base, cashUsdg: 0n, paperTradingEnabled: true }).mode, "paper");
    assert.equal(execModeOf({ ...base, deadPolicy: true, paperTradingEnabled: true }).mode, "paper");
  });

  it("names itself, and not gas-absurd", () => {
    assert.equal(liveBlocker({ ...base, wallTooWide: true }), "grant-too-wide");
    // `gas-absurd` is an ESTIMATE verdict from the executor. It must never be
    // the standing explanation for a condition the grant already proves.
    assert.notEqual(liveBlocker({ ...base, wallTooWide: true }), "gas-absurd");
  });

  it("ranks beside dead-policy, above anything money could fix", () => {
    // Both are owner-only remedies; naming a cheaper one first would send
    // someone to buy USDG for an account that can never spend it.
    assert.equal(
      liveBlocker({ ...base, wallTooWide: true, cashUsdg: 0n, gasWei: 0n, gasSponsored: false }),
      "grant-too-wide",
    );
  });
});

describe("ZERO BUNDLER CALLS, and the ledger still records what happened", () => {
  it("the refuse rail returns before anything is estimated or sent", () => {
    // The whole point of deciding this from the grant's shape. `gas-absurd` is
    // reached from INSIDE the executor, after two `eth_estimateUserOperationGas`
    // calls and two `pimlico_getUserOperationGasPrice` calls — 16 per 97
    // seconds on the two blocked agents. The refuse rail never gets there.
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const at = src.indexOf('if (execRail.mode === "refuse")');
    assert.ok(at > 0, "the refuse rail must exist");
    const branch = src.slice(at, src.indexOf("\n    }", at));
    assert.match(branch, /status: "rejected"/, "it records that nothing moved");
    assert.match(branch, /reject_rule: execRail\.rule/, "with the leg that stopped it");
    assert.match(branch, /return;/, "and returns");
    for (const forbidden of [/executor\./, /\.send\(/, /estimate/i, /bundler/i]) {
      assert.ok(!forbidden.test(branch), `the refuse rail must not touch ${forbidden}`);
    }
  });

  it("and paper is not the fallback for this rule, so no pretend fill is written either", () => {
    // Both other outcomes write something that looks like execution: a paper
    // fill, or a real one. Refuse writes a `rejected` row, which is the only
    // honest record of an operation that will never be attempted.
    const m = execModeOf({ ...base, wallTooWide: true, paperTradingEnabled: true });
    assert.notEqual(m.mode, "paper");
    assert.notEqual(m.mode, "live");
  });
});

describe("a deployed account is never retired for its historical wall", () => {
  it("THE GATE IS THE DEPLOY STATE, and only a positive answer counts", () => {
    // An account whose wall is already on-chain never signs another
    // first-enable, so a wall that would be refused today says nothing about an
    // agent that is already trading. And `null` — the chain would not answer —
    // must not retire anyone either: refusing on a failed read would take a
    // working agent down because an RPC blinked.
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    assert.match(
      src,
      /wallTooWide:\s*\(active\?\.wallOverMax \?\? false\) && active\?\.accountDeployed === false/,
      "the blocker must require a POSITIVE undeployed answer",
    );
    assert.ok(
      !/wallTooWide:\s*active\?\.wallOverMax\s*[,}]/.test(src),
      "it must never be set from the wall alone",
    );
  });
});

describe("the owner is told, in the shared vocabulary", () => {
  it("carries a sentence rather than a slug", () => {
    const say = liveBlockerText("grant-too-wide");
    assert.match(say, /too wide/);
    assert.match(say, /re-?signing/i, "and names the remedy");
    assert.ok(!say.includes("grant-too-wide"), "never the slug echoed back");
  });

  it("RAISES THE RENEWAL CTA, because only the owner can fix it", () => {
    const a = autonomyOf({ mode: "idle", liveBlocker: "grant-too-wide" });
    assert.equal(a.state, "blocked");
    assert.equal(a.needsOwnerAction, true);
    assert.deepEqual(a.action, { label: "Renew permission", kind: "renew-grant" });
  });

  it("and never offers funding, which would change nothing", () => {
    const a = autonomyOf({ mode: "idle", liveBlocker: "grant-too-wide", realCashUsd: 0 });
    assert.notEqual(a.action?.kind, "add-funds");
  });

  it("the public tape can name it too", () => {
    const label = rejectRuleLabel("grant-too-wide");
    assert.ok(label && label.length > 0, "an unnamed rule renders as unlabelled amber");
    assert.ok(!label!.includes("grant-too-wide"), "and not as the slug");
  });
});
