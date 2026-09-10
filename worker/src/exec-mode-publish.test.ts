/**
 * THE AGENT SAID "RUNNING" WHILE IT REFUSED EVERY TRADE.
 *
 * `execModeOf` answers `paper | refuse | live`. The heartbeat published
 * `paperActive() ? "paper" : active?.executor ? "live" : "idle"` — also three
 * values, and not the same three. REFUSE had nowhere to go, so it fell through
 * to the `active?.executor` arm and published as **live**.
 *
 * That row is what the whole product reads. The terminal renders "Running", its
 * `stopped` flag computes false, the public profile draws a SOLID equity line
 * for a book that is executing nothing, and the chat prompt is told the agent is
 * live. Nothing anywhere said otherwise.
 *
 * And it is the exact shape of the report that started this: `go-live` in chat
 * writes `paperTradingEnabled: false`, so an unfunded agent lands on
 * `{mode: "refuse", rule: "no-cash"}` — published as live, funded false, zero
 * trades, half a day of nothing, and no sentence anywhere connecting the three.
 *
 * The type system could not catch it. Both sides were strings, both had three
 * cases, and the mapping was an expression rather than a function. So the
 * mapping is now a function, and this file is what pins it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { execModeOf, publishedMode, type ExecInputs, type ExecMode } from "./exec-mode";

/** A fully-working agent. Each test below breaks exactly one leg. */
const WORKING: ExecInputs = {
  armed: true,
  executor: true,
  chainId: 4663,
  cashUsdg: 1_000_000n,
  gasWei: 10n ** 16n,
  deadPolicy: false,
  gasSponsored: false,
  paperTradingEnabled: false,
};

describe("every ExecMode arm publishes something, and never the wrong thing", () => {
  it("maps all three arms without falling through", () => {
    assert.equal(publishedMode({ mode: "live" }), "live");
    assert.equal(publishedMode({ mode: "paper", rule: "no-cash" }), "paper");
    assert.equal(publishedMode({ mode: "refuse", rule: "no-cash" }), "idle");
  });

  it("NEVER publishes `live` for a verdict that is not live", () => {
    // The one-line statement of the bug. Every refuse rule, every arm.
    const rules = ["not-armed", "dead-policy", "no-executor", "wrong-chain", "no-gas", "no-cash"] as const;
    for (const rule of rules) {
      assert.notEqual(
        publishedMode({ mode: "refuse", rule }),
        "live",
        `a refusal on ${rule} must never publish as live`,
      );
      assert.notEqual(publishedMode({ mode: "paper", rule }), "live");
    }
  });
});

describe("the reported case, end to end through the real verdict", () => {
  it("an unfunded agent that turned paper OFF publishes idle, not live", () => {
    // go-live sets paperTradingEnabled false. The account holds no USDG. This
    // is the tester's agent, and it read as `live` with zero trades.
    const verdict = execModeOf({ ...WORKING, cashUsdg: 0n, paperTradingEnabled: false });
    assert.deepEqual(verdict, { mode: "refuse", rule: "no-cash" } satisfies ExecMode);
    assert.equal(publishedMode(verdict), "idle", "it is not trading, so it must not say it is");
  });

  it("the same agent with paper left ON publishes paper — unchanged behaviour", () => {
    const verdict = execModeOf({ ...WORKING, cashUsdg: 0n, paperTradingEnabled: true });
    assert.equal(verdict.mode, "paper");
    assert.equal(publishedMode(verdict), "paper");
  });

  it("a working agent still publishes live", () => {
    // The assertion that stops this fix becoming a fleet-wide false alarm.
    assert.equal(publishedMode(execModeOf(WORKING)), "live");
  });

  it("an agent with an executor but no gas publishes idle, not live", () => {
    // The case exec-mode.ts's own header records production carrying several of:
    // `eth 0 · cash 1000 USDG`, refusing forever, product saying otherwise.
    const verdict = execModeOf({ ...WORKING, gasWei: 0n, paperTradingEnabled: false });
    assert.deepEqual(verdict, { mode: "refuse", rule: "no-gas" } satisfies ExecMode);
    assert.equal(publishedMode(verdict), "idle");
  });

  it("unknown is not unfunded — a failed balance read still publishes live", () => {
    // null means no read has landed. Publishing idle here would be the mirror
    // failure: telling an owner their funded agent is stopped because our RPC
    // blinked. canTradeForReal already draws this line; this pins that the
    // publication inherits it rather than re-deciding.
    const verdict = execModeOf({ ...WORKING, cashUsdg: null, paperTradingEnabled: false });
    assert.equal(publishedMode(verdict), "live");
  });
});

describe("the call site derives it and does not work it out again", () => {
  // The bug was a second expression standing beside the verdict. exec-mode.ts's
  // header is about there having been two definitions of the rail that
  // disagreed; this stops a sixth appearing at the site that already had a fifth.
  const CODE = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

  it("the heartbeat calls publishedMode", () => {
    assert.match(CODE, /const mode = publishedMode\(verdict\)/);
  });

  it("and no longer derives a mode from the executor's mere existence", () => {
    assert.ok(
      !/active\?\.executor \? "live"/.test(CODE),
      "an executor that exists is not an executor that is trading",
    );
  });

  it("the blocker still travels with it, from the same verdict", () => {
    // The mode says "not trading"; live_blocker says which leg. Two fields, one
    // verdict — if these ever came from different reads they could disagree.
    assert.match(CODE, /const blocking = verdict\.mode === "live" \? null : verdict\.rule/);
    assert.match(CODE, /setAgentMode\(active\.agentId, mode, at, sponsorGas, blocking\)/);
  });
});
