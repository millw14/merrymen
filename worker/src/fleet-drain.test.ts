/**
 * THE DRAIN'S ORDER, CLOCK AND RECEIPT, WITHOUT A FLEET.
 *
 * Every step is a stub that writes to a timeline, so the order is read off
 * directly; the caps are shrunk to tens of milliseconds and run on the real
 * clock. What each step does to a real fleet is tested over the real
 * orchestrator in orchestrator-drain.integration.test.ts.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  DRAIN_BUDGET_DEFAULT_MS,
  PREVIOUS_SHUTDOWN_FILE,
  SHUTDOWN_RECEIPT_FILE,
  drainBudgetMs,
  runFleetDrain,
  shutdownReceiptDir,
  takePreviousShutdown,
  writeShutdownReceipt,
  type DrainLimits,
  type FinalPassOutcome,
  type FleetDrainPlan,
  type ShutdownReceipt,
} from "./fleet-drain";

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-fleet-drain-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Small caps, so a test that waits one out waits milliseconds. */
const FAST: Partial<DrainLimits> = {
  hooksMs: 100, settleMs: 100, exitWaitMs: 100, killGraceMs: 20, pendingKillsMs: 100, finalPassMinMs: 0, reserveMs: 10, pollMs: 5,
};

interface Run {
  timeline: string[];
  receipts: ShutdownReceipt[];
  exits: number[];
  exited: Promise<number>;
  plan: FleetDrainPlan<string>;
}

/** A plan whose every step says it ran. Overrides replace a step; the timeline still records the defaults'. */
function drainPlan(overrides: Partial<FleetDrainPlan<string>> = {}, homes = ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000a2"]): Run {
  const timeline: string[] = [];
  const receipts: ShutdownReceipt[] = [];
  const exits: number[] = [];
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (resolveExit = resolve));
  let gone = false;
  const plan: FleetDrainPlan<string> = {
    signal: "SIGTERM",
    budgetMs: 5_000,
    limits: FAST,
    log: () => {},
    stop: () => { timeline.push("stop"); return homes; },
    beforeChildren: [
      { name: "a", run: () => { timeline.push("hook:a"); } },
      { name: "b", run: async () => { await sleep(5); timeline.push("hook:b"); } },
    ],
    settled: () => true,
    closeCopies: () => timeline.push("closeCopies"),
    signalFleet: (signal) => {
      timeline.push(signal);
      if (signal === "SIGTERM") setTimeout(() => (gone = true), 5);
      return 2;
    },
    fleetGone: () => gone,
    honourPendingKills: async () => { timeline.push("kills"); },
    finalPass: async (home): Promise<FinalPassOutcome> => { timeline.push(`final:${home.slice(-2)}`); return "saved"; },
    writeReceipt: (receipt) => { timeline.push("receipt"); receipts.push(structuredClone(receipt)); },
    releaseLeases: async () => { timeline.push("release"); },
    exit: (code) => { timeline.push(`exit:${code}`); exits.push(code); resolveExit(code); },
    ...overrides,
  };
  return { timeline, receipts, exits, exited, plan };
}

describe("the order", () => {
  it("stops, runs the hooks, settles, signals, honours kills, passes, writes the receipt, then releases the leases and exits 0", async () => {
    const run = drainPlan();
    await runFleetDrain(run.plan);
    assert.deepEqual(run.timeline, [
      "stop", "hook:a", "hook:b", "closeCopies", "SIGTERM", "kills", "final:a1", "final:a2", "receipt", "release", "exit:0",
    ]);
    const [receipt] = run.receipts;
    assert.equal(receipt!.clean, true);
    assert.equal(receipt!.outcome, "drained");
    assert.deepEqual(receipt!.steps.map((s) => [s.step, s.outcome]), [
      ["hooks", "done"], ["settle", "done"], ["children", "done"], ["pending-kills", "done"], ["final-pass", "done"], ["late-settle", "done"],
    ]);
    assert.deepEqual(receipt!.finalPass, { homes: 2, saved: 2, retained: 0, skipped: 0, outOfTime: 0 });
    assert.deepEqual(run.exits, [0], "exactly one exit");
  });

  it("signals no process until every copy in flight has finished, and closes copies only then", async () => {
    let copying = true;
    setTimeout(() => (copying = false), 40);
    const run = drainPlan({ settled: () => !copying });
    const t0 = Date.now();
    let signalledAt = 0;
    const signalFleet = run.plan.signalFleet;
    run.plan.signalFleet = (signal) => { if (!signalledAt) signalledAt = Date.now(); return signalFleet(signal); };
    await runFleetDrain(run.plan);
    assert.ok(signalledAt - t0 >= 35, "SIGTERM waited for the copy");
    assert.ok(run.timeline.indexOf("closeCopies") < run.timeline.indexOf("SIGTERM"));
    assert.equal(run.receipts[0]!.clean, true);
  });

  it("a settle that never comes is waited out for its cap only — the drain goes on, and the receipt is not clean", async () => {
    // The late settle waits out what is left of the budget, less the reserve.
    const run = drainPlan({ settled: () => false, budgetMs: 600, limits: { ...FAST, reserveMs: 150 } });
    await runFleetDrain(run.plan);
    const receipt = run.receipts[0]!;
    assert.equal(receipt.steps.find((s) => s.step === "settle")!.outcome, "timeout");
    assert.ok(run.timeline.includes("SIGTERM") && run.timeline.includes("final:a1"), "the rest of the drain still ran");
    assert.equal(receipt.inFlightAtRelease, true);
    assert.equal(receipt.clean, false);
    assert.deepEqual(run.exits, [0]);
  });
});

describe("children and hold processes", () => {
  it("a process that exits within the wait is never sent SIGKILL — there is no three-second SIGKILL", async () => {
    const run = drainPlan();
    await runFleetDrain(run.plan);
    assert.ok(!run.timeline.includes("SIGKILL"));
    assert.equal(run.receipts[0]!.stragglers, 0);
  });

  it("only what is still running when the wait ends gets SIGKILL, and the receipt counts it", async () => {
    let signalled = 0;
    const run = drainPlan({
      signalFleet: (signal) => {
        run.timeline.push(signal);
        if (signal === "SIGTERM") signalled = Date.now();
        return signal === "SIGKILL" ? 1 : 3;
      },
      fleetGone: () => false,
    });
    let killedAfter = 0;
    const record = run.plan.signalFleet;
    run.plan.signalFleet = (signal) => { if (signal === "SIGKILL") killedAfter = Date.now() - signalled; return record(signal); };
    await runFleetDrain(run.plan);
    assert.deepEqual(run.timeline.filter((s) => s.startsWith("SIG")), ["SIGTERM", "SIGKILL"]);
    assert.ok(killedAfter >= 95, `SIGKILL only once the exit wait was over (${killedAfter}ms)`);
    const receipt = run.receipts[0]!;
    assert.equal(receipt.stragglers, 1);
    assert.equal(receipt.steps.find((s) => s.step === "children")!.outcome, "timeout");
    assert.equal(receipt.clean, false);
  });
});

describe("the hooks", () => {
  it("a hook that throws is said and skipped, one that overruns is no longer waited for, and the children are still signalled", async () => {
    const said: string[] = [];
    const run = drainPlan({
      log: (line) => said.push(line),
      beforeChildren: [
        { name: "throws", run: () => { throw new Error("hook broke"); } },
        { name: "hangs", run: () => new Promise<void>(() => {}) },
      ],
    });
    await runFleetDrain(run.plan);
    assert.ok(said.some((l) => /drain hook throws failed — hook broke/.test(l)));
    assert.ok(said.some((l) => /drain hooks still running/.test(l)));
    assert.ok(run.timeline.includes("SIGTERM"));
    const receipt = run.receipts[0]!;
    assert.equal(receipt.hooksFailed, 1);
    assert.equal(receipt.steps[0]!.outcome, "timeout");
    assert.equal(receipt.clean, false);
  });
});

describe("the final pass", () => {
  it("asks a home again while it has more, and counts what each came to", async () => {
    const asked: string[] = [];
    const answers: FinalPassOutcome[] = ["more", "more", "saved", "retained", "skipped"];
    const run = drainPlan({
      finalPass: async (home) => { asked.push(home.slice(-2)); return answers.shift()!; },
    }, ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000a2", "0x00000000000000000000000000000000000000a3"]);
    await runFleetDrain(run.plan);
    assert.deepEqual(asked, ["a1", "a1", "a1", "a2", "a3"]);
    assert.deepEqual(run.receipts[0]!.finalPass, { homes: 3, saved: 1, retained: 1, skipped: 1, outOfTime: 0 });
    assert.equal(run.receipts[0]!.clean, false, "a retained or skipped home is not a clean stop");
  });

  it("STARTS NO COPY IT CANNOT FINISH: with less than finalPassMinMs of the budget left, the rest are out of time", async () => {
    const asked: string[] = [];
    const run = drainPlan({
      budgetMs: 1_000,
      limits: { ...FAST, finalPassMinMs: 500 },
      finalPass: async (home) => {
        asked.push(home.slice(-2));
        // The first home's last batch runs the budget below the minimum.
        if (asked.length === 2) await sleep(600);
        return asked.length === 1 ? "more" : "saved";
      },
    });
    await runFleetDrain(run.plan);
    assert.deepEqual(asked, ["a1", "a1"], "the second home was never started");
    const receipt = run.receipts[0]!;
    assert.deepEqual(receipt.finalPass, { homes: 2, saved: 1, retained: 0, skipped: 0, outOfTime: 1 });
    assert.equal(receipt.steps.find((s) => s.step === "final-pass")!.outcome, "timeout");
    assert.equal(receipt.clean, false);
    assert.deepEqual(run.exits, [0], "running out of time is not a crash: the leases are still released and the exit is 0");
    assert.ok(run.timeline.indexOf("receipt") < run.timeline.indexOf("release"));
  });

  it("a final pass that throws is retained, and the next home still gets its pass", async () => {
    const run = drainPlan({
      finalPass: async (home) => { if (home.endsWith("a1")) throw new Error("copy broke"); return "saved"; },
    });
    await runFleetDrain(run.plan);
    assert.deepEqual(run.receipts[0]!.finalPass, { homes: 2, saved: 1, retained: 1, skipped: 0, outOfTime: 0 });
  });
});

describe("the backstop", () => {
  it("a step still running when the budget is spent exits 1 with a receipt naming it — and nothing after it runs", async () => {
    const run = drainPlan({ budgetMs: 300, finalPass: () => new Promise<FinalPassOutcome>(() => {}) });
    void runFleetDrain(run.plan);
    assert.equal(await run.exited, 1);
    await sleep(50);
    assert.deepEqual(run.exits, [1]);
    assert.ok(!run.timeline.includes("release"), "the leases are left to the dropped connection");
    const receipt = run.receipts.at(-1)!;
    assert.equal(receipt.outcome, "budget-exceeded");
    assert.equal(receipt.stalledAt, "final-pass");
    assert.equal(receipt.clean, false);
    assert.equal(run.receipts.length, 1, "one receipt, the backstop's");
  });
});

describe("the receipt", () => {
  it("names no tenant — counts and step names only, so it can be published as it stands", async () => {
    const run = drainPlan();
    await runFleetDrain(run.plan);
    assert.doesNotMatch(JSON.stringify(run.receipts[0]), /0x[0-9a-f]/i);
  });

  it("is written owner-only into an owner-only ops directory", () => {
    const home = mkdtempSync(path.join(scratch, "home-"));
    const dir = shutdownReceiptDir(home);
    writeShutdownReceipt(dir, receiptLike({ clean: true }));
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(dir, SHUTDOWN_RECEIPT_FILE)).mode & 0o777, 0o600);
  });

  it("the next start says the last stop was clean, and moves the receipt aside so a crash of its own is not read as clean", () => {
    const dir = shutdownReceiptDir(mkdtempSync(path.join(scratch, "home-")));
    writeShutdownReceipt(dir, receiptLike({ clean: true }));
    const first = takePreviousShutdown(dir);
    assert.equal(first.clean, true);
    assert.equal(first.at, 1_760_000_012_000, "when it finished, for whatever else reports the last stop");
    assert.match(first.line, /^previous shutdown was clean — SIGTERM drained in 12\.0s/);
    assert.equal(existsSync(path.join(dir, SHUTDOWN_RECEIPT_FILE)), false);
    assert.equal(existsSync(path.join(dir, PREVIOUS_SHUTDOWN_FILE)), true, "kept for an operator");
    const second = takePreviousShutdown(dir);
    assert.equal(second.clean, null);
    assert.equal(second.at, null);
    assert.match(second.line, /left no receipt — it did not drain/);
  });

  it("an unclean stop is an [alert] that says what went wrong", () => {
    const dir = shutdownReceiptDir(mkdtempSync(path.join(scratch, "home-")));
    writeShutdownReceipt(dir, receiptLike({
      clean: false, outcome: "budget-exceeded", stalledAt: "final-pass", stragglers: 2,
      steps: [{ step: "children", ms: 20_000, outcome: "timeout" }],
      finalPass: { homes: 5, saved: 3, retained: 0, skipped: 0, outOfTime: 2 },
    }));
    const said = takePreviousShutdown(dir);
    assert.equal(said.clean, false);
    assert.match(said.line, /^\[alert\] previous shutdown was NOT clean — SIGTERM, budget exceeded during final-pass/);
    assert.match(said.line, /children timeout/);
    assert.match(said.line, /2 process\(es\) SIGKILLed/);
    assert.match(said.line, /final pass 3\/5 saved, 0 retained, 0 skipped, 2 out of time/);
  });

  it("a malformed receipt is read as not clean", () => {
    const dir = shutdownReceiptDir(mkdtempSync(path.join(scratch, "home-")));
    writeShutdownReceipt(dir, receiptLike({ clean: true }));
    writeFileSync(path.join(dir, SHUTDOWN_RECEIPT_FILE), "{\"version\":1,\"clean\":tr");
    const said = takePreviousShutdown(dir);
    assert.equal(said.clean, false);
    assert.equal(said.at, null);
    assert.match(said.line, /malformed — read as NOT clean/);
    assert.equal(readFileSync(path.join(dir, PREVIOUS_SHUTDOWN_FILE), "utf8").startsWith("{\"version\":1"), true);
    // Shaped right on the outside and still not a receipt: never a throw at start.
    for (const over of [{ clean: false, steps: [null] }, { finishedAt: 1e300 }]) {
      writeFileSync(path.join(dir, SHUTDOWN_RECEIPT_FILE), JSON.stringify(receiptLike(over as Partial<ShutdownReceipt>)));
      const odd = takePreviousShutdown(dir);
      assert.equal(odd.clean, false, JSON.stringify(over));
      assert.match(odd.line, /malformed — read as NOT clean/);
    }
  });
});

describe("the budget", () => {
  it("defaults to 50s, takes a whole number of milliseconds in range, and refuses anything else without echoing it", () => {
    assert.deepEqual(drainBudgetMs({}), { ms: DRAIN_BUDGET_DEFAULT_MS, refused: null });
    assert.deepEqual(drainBudgetMs({ MERRYMEN_DRAIN_BUDGET_MS: "" }), { ms: DRAIN_BUDGET_DEFAULT_MS, refused: null });
    assert.deepEqual(drainBudgetMs({ MERRYMEN_DRAIN_BUDGET_MS: "40000" }), { ms: 40_000, refused: null });
    for (const bad of ["abc", "0", "999", "600001", "1e4", "-5", "45.5", "0x1000", "fifty-seconds"]) {
      const r = drainBudgetMs({ MERRYMEN_DRAIN_BUDGET_MS: bad });
      assert.equal(r.ms, DRAIN_BUDGET_DEFAULT_MS, bad);
      assert.match(r.refused ?? "", /^MERRYMEN_DRAIN_BUDGET_MS is not a whole number of milliseconds from 1000 to 600000 — draining within the default 50000ms$/, bad);
    }
  });
});

function receiptLike(over: Partial<ShutdownReceipt>): ShutdownReceipt {
  return {
    version: 1, signal: "SIGTERM", outcome: "drained", clean: true, startedAt: 1_760_000_000_000, finishedAt: 1_760_000_012_000,
    budgetMs: 50_000, stalledAt: null, steps: [], hooksFailed: 0, stragglers: 0,
    finalPass: { homes: 0, saved: 0, retained: 0, skipped: 0, outOfTime: 0 }, inFlightAtRelease: false, ...over,
  };
}
