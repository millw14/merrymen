/**
 * THE STAGGER KILLED MOST OF THE FLEET, AND EVERY TEST PASSED.
 *
 * `startupSlotMs` spreads a child's first tick over one whole tick period so
 * thirty-four children do not wake together. It was correct, it was tested, and
 * it shipped. What nobody wrote down is that the WATCHDOG reads a heartbeat
 * file the worker only wrote from inside a tick.
 *
 * The two facts, each harmless alone:
 *
 *   worker/src/index.ts   — first tick at a derived slot in [0, tickMs)
 *   orchestrator.ts       — `beat === null` is stale as soon as the 90-second
 *                           grace expires; `staleSec` (570s hosted) never
 *                           applies to a child that has not beaten yet
 *
 * Together: every child whose slot landed past 90 seconds was SIGKILLed before
 * its first tick ever ran — and the slot is DERIVED FROM THE TENANT, so it took
 * the same slot on restart and was killed again, permanently. With a 240-second
 * tick that is roughly five-eighths of the fleet. Measured on the hosted fleet:
 * 18 kills in one log window, all "never beat", while the fleet reported
 * "armed 34" the whole time.
 *
 * Each restart paid for a fresh arm and a 200,000-block getLogs sweep, which is
 * the exact kill → re-arm → rate-limit loop the orchestrator's own watchdog
 * comment was written about. Rate-limited reads came back on the fleet at
 * `peak concurrency 36` after weeks at zero.
 *
 * Two fixes, and this file pins both: the worker beats BEFORE its staggered
 * wait, and the supervisor's patience for a first beat is derived from the same
 * tick the stagger is bounded by.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { firstBeatGraceSec, staleThresholdSec } from "./orchestrator";
import { startupSlotMs } from "./stagger";

const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

const INDEX = codeOf(readFileSync(new URL("./index.ts", import.meta.url), "utf8"));
const ORCH = codeOf(readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8"));

/** The hosted fleet's tick, which is where this went wrong. */
const HOSTED_TICK_SEC = 240;

describe("a process that has started is alive", () => {
  it("THE WORKER BEATS BEFORE ITS STAGGERED WAIT", () => {
    // The whole bug, in one assertion. `setTimeout(runLoop, slot)` may be a
    // whole tick away; the file has to exist before it.
    const beat = INDEX.indexOf('beatFile("idle"');
    const wait = INDEX.indexOf("setTimeout(runLoop, slot)");
    assert.ok(beat > 0, "the worker must write a heartbeat at startup");
    assert.ok(wait > 0 && beat < wait, "…and it must do so BEFORE the staggered wait");
  });

  it("and the startup beat writes the FILE without needing anything armed", () => {
    // The rest of `heartbeat()` resolves an exec-mode verdict and touches the
    // shared `agents` row, neither of which exists before the first tick. Only
    // the file is what a supervisor judges liveness by, so only the file is
    // written here.
    const fn = INDEX.slice(INDEX.indexOf("function beatFile("), INDEX.indexOf("function heartbeat("));
    assert.ok(fn.length > 0, "beatFile must exist and come before heartbeat");
    assert.match(fn, /homePaths\.heartbeat\(\)/);
    assert.ok(!/execMode\(\)|setAgentMode\(/.test(fn), "the startup beat must not need an armed agent");
    // And the tick path still goes through the same writer, so the two cannot
    // drift into different file shapes.
    const hb = INDEX.slice(INDEX.indexOf("function heartbeat("));
    assert.match(hb.slice(0, 800), /beatFile\(mode, sponsorGas, blockNumber\)/);
  });
});

describe("the supervisor's patience covers the stagger", () => {
  it("A MISSING BEAT IS JUDGED BY ITS OWN GRACE, not by the 90-second floor", () => {
    // `beat === null` short-circuits the age comparison, so `staleSec` never
    // applied to a child that had not beaten. That is still true — which is why
    // the null branch needs a threshold of its own rather than falling through
    // to the bare grace.
    assert.match(ORCH, /beat === null \? ageSec > firstGrace : nowSec - beat > child\.staleSec/);
    assert.match(ORCH, /const firstGrace = child\.firstBeatSec;/);
  });

  it("NO SLOT CAN OUTLAST THE GRACE, for any tick this fleet runs", () => {
    // The arithmetic that failed. A slot is bounded by the tick; the grace must
    // exceed the tick for the same reason.
    for (const tick of [15, 30, 60, 120, 240, 600]) {
      const grace = firstBeatGraceSec(tick);
      // The worst slot for this tick, in seconds.
      const worstSlot = (tick * 1000 - 1) / 1000;
      assert.ok(
        grace > worstSlot,
        `tick ${tick}s: a child staggered to ${worstSlot}s would be killed at ${grace}s`,
      );
    }
  });

  it("and the real hash cannot produce a slot past it either", () => {
    // Not just the bound — the function. A thousand plausible child homes, none
    // of which may land outside the grace.
    const grace = firstBeatGraceSec(HOSTED_TICK_SEC) * 1000;
    let worst = 0;
    for (let i = 0; i < 1000; i += 1) {
      const slot = startupSlotMs(`/root/.merrymen/children/0x${i.toString(16).padStart(40, "0")}`, HOSTED_TICK_SEC * 1000);
      if (slot > worst) worst = slot;
      assert.ok(slot < grace, `slot ${slot}ms exceeds the ${grace}ms first-beat grace`);
    }
    // And the stagger is still doing its job — a hash that always returned 0
    // would pass the line above while spreading nothing.
    assert.ok(worst > HOSTED_TICK_SEC * 500, `the stagger must actually spread; worst slot was ${worst}ms`);
  });

  it("a child that HAS beaten is still judged by the tick-derived threshold", () => {
    // The other half must not regress: 570s hosted, from the tick, because the
    // minimum possible gap between two beats is one tick period.
    assert.equal(staleThresholdSec(HOSTED_TICK_SEC), 570);
    assert.ok(
      staleThresholdSec(HOSTED_TICK_SEC) > firstBeatGraceSec(HOSTED_TICK_SEC),
      "a silent child gets longer than a starting one, not shorter",
    );
  });

  it("the log line stops saying '570s' about a child that has been alive 90", () => {
    // It printed `never beat > 570s`, which reads as though 570 seconds had
    // passed. They had not — the comparison was never made. That sentence is
    // why this took a production log and an afternoon to find.
    assert.match(ORCH, /never beat in \$\{Math\.round\(ageSec\)\}s > \$\{firstGrace\}s/);
  });
});
