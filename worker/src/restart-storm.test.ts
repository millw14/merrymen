/**
 * THE RESTART LOOP THAT PAID FOR ITSELF IN COLD ARMS.
 *
 * A cold arm is the single most expensive thing a child does to the shared
 * endpoint: twenty-eight sequential reads, twenty-one of them a getLogs walk
 * over 200,000 blocks, none of which batch because each one blocks the next. A
 * steady tick, by contrast, is three requests carrying forty-nine values. So a
 * restart is not a neutral event — it is roughly ten ticks' worth of load,
 * issued as a burst, at the endpoint that is already refusing.
 *
 * Two separate defects made that burst repeat for ever, and neither was
 * visible from the other's file:
 *
 *   THE WATCHDOG had no brake. The exit handler backed off and capped at
 *   MAX_RESTARTS; the watchdog called spawnChild on the line after the SIGKILL,
 *   with no delay and no ceiling. And the watchdog is the path a RATE-LIMITED
 *   child takes, because a tick stuck retrying stops beating — so the one
 *   failure mode the endpoint actually produces got the un-braked restart.
 *
 *   RECONCILE UNDID THE CEILING. It runs every fifteen seconds and spawns
 *   anything wanted that is not currently running, with `restarts` defaulting
 *   to 0 — so a tenant the exit handler had just given up on came back a
 *   quarter of a minute later with a clean ladder, climbed it, gave up, and was
 *   picked up again. Roughly nine restarts every two minutes, indefinitely.
 *
 * These are read out of the source because the policy is one function and two
 * call sites, and the failure is silent: a fleet that has quietly gone back to
 * restarting without a brake looks exactly like a fleet with flaky children.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const orch = () => readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");

describe("there is exactly one restart policy", () => {
  it("AND THE WATCHDOG GOES THROUGH IT", () => {
    // The regression to fear is this line reverting to a direct spawnChild,
    // which is what it was.
    const src = orch();
    const watchdog = src.slice(src.indexOf("heartbeat stale ("), src.indexOf("heartbeat stale (") + 1400);
    assert.match(watchdog, /scheduleRestart\(tenant as `0x\$\{string\}`, restarts \+ 1, "heartbeat stale"\)/);
    assert.ok(
      !/kill\("SIGKILL"\);[\s\S]{0,200}void spawnChild\(/.test(src),
      "the watchdog must not restart on the same line as the kill",
    );
  });

  it("and so does an exit", () => {
    assert.match(orch(), /scheduleRestart\(tenant, freshRestarts, `exit \$\{code\}`\)/);
  });

  it("and the policy itself both waits and gives up", () => {
    const src = orch();
    const policy = src.slice(src.indexOf("function scheduleRestart("), src.indexOf("async function spawnChild("));
    assert.match(policy, /if \(restarts > MAX_RESTARTS\)/, "it must have a ceiling");
    assert.match(policy, /Math\.min\(30_000, 1_000 \* 2 \*\* Math\.min\(restarts, 5\)\)/, "and a backoff");
    assert.match(policy, /setTimeout\(/, "and the backoff must actually delay the spawn");
  });
});

describe("reconcile cannot undo the ceiling", () => {
  it("A GIVEN-UP TENANT IS SKIPPED WHILE IT IS STOOD DOWN", () => {
    const src = orch();
    const loop = src.slice(src.indexOf("for (const tenant of tenants) {"));
    assert.match(loop, /const cool = gaveUpUntil\.get\(lc\);/);
    assert.match(loop, /if \(cool && Date\.now\(\) < cool\.until\) continue;/);
  });

  it("AND IT COMES BACK WITH THE COUNT IT HAD, not a clean slate", () => {
    // The clean slate is the whole bug: it is what made MAX_RESTARTS
    // unreachable, because the ladder restarted at 1s every fifteen seconds.
    const src = orch();
    assert.match(src, /await spawnChild\(lc, cool\?\.restarts \?\? 0\);/);
  });

  it("but the stand-down expires, because a supervisor that stops trying is an outage", () => {
    // A tenant whose child cannot stay up is a real problem a human has to see.
    // Making the loop cheap must not make it permanent.
    const src = orch();
    assert.match(src, /const GIVE_UP_COOLOFF_MS = 5 \* 60_000;/);
    assert.match(src, /gaveUpUntil\.delete\(lc\);/);
  });

  it("and the stand-down survives the child, which is the only reason it works", () => {
    // Keyed to the tenant, not to a Child record — the record is gone by the
    // time reconcile looks, which is exactly how it saw a clean slate.
    const src = orch();
    assert.match(src, /const gaveUpUntil = new Map<string, \{ until: number; restarts: number \}>\(\);/);
  });
});
