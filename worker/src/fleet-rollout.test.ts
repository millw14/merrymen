/**
 * THE ROLLOUT VALUE: ITS GRAMMAR, ITS REFUSALS, AND WHAT EACH READER MAKES OF IT.
 *
 * Pure: every reader here takes the environment as an argument, so nothing in
 * this file touches the process's own. The orchestrator wiring (who is leased,
 * spawned, killed or retired) is orchestrator-rollout.integration.test.ts.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ADMISSION_LEVELS,
  ADMISSION_LEVEL_ENV,
  FLEET_ROLLOUT_ENV,
  MAX_ROLLOUT_TENANTS,
  childAdmissionLevel,
  fleetRollout,
  railwayHosted,
  rolloutAdmitsWholeFleet,
  rolloutCounts,
  rolloutHeld,
  rolloutLevel,
  rolloutLine,
  rolloutStartupLine,
  rolloutSummary,
  WORKER_ENFORCED_LEVELS,
} from "./fleet-rollout";
import { onRailway, RAILWAY_ONLY_IDENTITY } from "./deploy-guard-checks";
import * as gate from "./worker-admission";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const A = address(0xa1), B = address(0xb2), C = address(0xc3), D = address(0xd4);
const env = (value: string | undefined, extra: Record<string, string> = {}) =>
  value === undefined ? { ...extra } : { [FLEET_ROLLOUT_ENV]: value, ...extra };

describe("the grammar", () => {
  it("none admits nobody, all admits everybody at trade", () => {
    assert.deepEqual(fleetRollout(env("none")), { scope: "none" });
    assert.equal(rolloutLevel(A, env("none")), "held");
    assert.deepEqual(fleetRollout(env("all")), { scope: "all", unset: false });
    assert.equal(rolloutLevel(A, env("all")), "trade");
  });

  it("a list admits exactly the tenants it names, and holds the rest", () => {
    const e = env(`${A}:trade,${C}:trade`);
    assert.equal(rolloutLevel(A, e), "trade");
    assert.equal(rolloutLevel(C, e), "trade");
    assert.equal(rolloutLevel(B, e), "held");
    assert.equal(rolloutLevel(D, e), "held");
    assert.equal(rolloutHeld(D, e), true);
    assert.equal(rolloutHeld(A, e), false);
  });

  it("addresses match whatever their case, and whitespace around entries is ignored", () => {
    const mixed = "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD";
    const e = env(` ${mixed}:trade , ${A}:trade `);
    assert.equal(rolloutLevel(mixed.toLowerCase(), e), "trade");
    assert.equal(rolloutLevel(mixed, e), "trade");
    assert.equal(rolloutLevel(A.toUpperCase().replace("0X", "0x"), e), "trade");
    assert.equal(rolloutLevel(B, e), "held");
  });

  it(`takes up to ${MAX_ROLLOUT_TENANTS} named tenants and refuses one more`, () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `${address(0x1000 + i)}:trade`).join(",");
    const most = fleetRollout(env(names(MAX_ROLLOUT_TENANTS)));
    assert.equal(most.scope === "list" && most.levels.size, MAX_ROLLOUT_TENANTS);
    assert.throws(() => fleetRollout(env(names(MAX_ROLLOUT_TENANTS + 1))), /more than 512 tenants/);
  });

  const malformed: [string, string][] = [
    ["empty", ""],
    ["blank", "   "],
    ["no halt value", "halt"],
    ["case matters for the keywords", "NONE"],
    ["All is not all", "All"],
    ["a keyword mixed with names", `none,${A}:trade`],
    ["a bare address", A],
    ["an unknown level", `${A}:paper`],
    ["held is never a level an operator writes", `${A}:held`],
    ["a short address", "0x123:trade"],
    ["a 0X prefix", `0X${A.slice(2)}:trade`],
    ["a trailing comma", `${A}:trade,`],
    ["an empty entry", `${A}:trade,,${B}:trade`],
    ["a semicolon", `${A}:trade;${B}:trade`],
    ["space inside an entry", `${A} : trade`],
    ["a tenant named twice at one level", `${A}:trade,${B}:trade,${A}:trade`],
    ["a tenant named twice at two", `${A}:trade,${A.toUpperCase().replace("0X", "0x")}:observe`],
    // The levels are exact words, as the keywords are: a case or a spelling
    // the grammar does not write is a guess, and refuses with the rest.
    ["case matters for the levels", `${A}:Observe`],
    ["exits_only is not exits-only", `${B}:trade,${A}:exits_only`],
  ];
  for (const [why, value] of malformed) {
    it(`refuses rather than guesses: ${why}`, () => {
      assert.throws(() => fleetRollout(env(value)), /MERRYMEN_FLEET_ROLLOUT .*refusing to start rather than guess/);
      // And every runtime reader fails closed on the same value.
      assert.equal(rolloutLevel(A, env(value)), "held");
      assert.equal(rolloutHeld(A, env(value)), true);
      assert.equal(rolloutAdmitsWholeFleet(env(value)), false);
      assert.equal(childAdmissionLevel(A, env(value)), "observe");
    });
  }

  it("observe and exits-only are accepted, now that the worker's admission gate obeys them", () => {
    const e = env(`${B}:trade,${A}:observe,${C}:exits-only`);
    assert.deepEqual(fleetRollout(e), { scope: "list", levels: new Map([[B, "trade"], [A, "observe"], [C, "exits-only"]]) });
    assert.equal(rolloutLevel(A, e), "observe");
    assert.equal(rolloutLevel(C, e), "exits-only");
    assert.equal(rolloutLevel(B, e), "trade", "beside them, the tenant named at trade is admitted as well");
    assert.equal(rolloutLevel(D, e), "held");
    // Each child carries its own level, and nothing else of the value.
    assert.equal(childAdmissionLevel(A, e), "observe");
    assert.equal(childAdmissionLevel(C, e), "exits-only");
    assert.equal(childAdmissionLevel(B, e), "trade");
    // Admitted, not held: neither is a fleet-wide writer's whole fleet.
    assert.equal(rolloutHeld(A, e), false);
    assert.equal(rolloutAdmitsWholeFleet(e), false);
    assert.match(rolloutStartupLine(fleetRollout(e)), /^fleet rollout: 3 named tenant\(s\) — trade 1 · exits-only 1 · observe 1; every other tenant is held/);
    // Named twice is still named twice, whichever level the second one asks for.
    assert.throws(() => fleetRollout(env(`${A}:trade,${A}:observe`)), /entry 2 names a tenant an earlier entry already named/);
  });

  it("a refusal names the entry's position, never its text", () => {
    const secretish = "0xnot-an-address-but-somebody-pasted-it-here:trade";
    assert.throws(() => fleetRollout(env(`${A}:trade,${secretish}`)), (e: Error) => {
      assert.match(e.message, /entry 2 /);
      assert.ok(!e.message.includes("somebody-pasted"), "the bad entry is not echoed");
      return true;
    });
  });
});

describe("unset", () => {
  it("off Railway keeps today's behaviour: every tenant at trade, and it says it was unset", () => {
    assert.deepEqual(fleetRollout(env(undefined)), { scope: "all", unset: true });
    assert.equal(rolloutLevel(A, env(undefined)), "trade");
    assert.equal(rolloutAdmitsWholeFleet(env(undefined)), true);
  });

  for (const marker of [
    "RAILWAY_ENVIRONMENT", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_ENVIRONMENT_NAME", "RAILWAY_PROJECT_ID",
    "RAILWAY_SERVICE_ID", "RAILWAY_DEPLOYMENT_ID", "RAILWAY_REPLICA_ID", "RAILWAY_VOLUME_MOUNT_PATH",
  ]) {
    it(`on Railway (${marker}) refuses, and every runtime reader holds`, () => {
      const e = env(undefined, { [marker]: "" });
      assert.equal(railwayHosted(e), true, "present at all is enough, even empty");
      assert.throws(() => fleetRollout(e), /unset, and a Railway-hosted orchestrator must name its scope/);
      assert.equal(rolloutLevel(A, e), "held");
      assert.equal(rolloutAdmitsWholeFleet(e), false);
    });
  }

  it("a required persistent home is the production volume, and counts as Railway", () => {
    const e = env(undefined, { MERRYMEN_PERSISTENT_HOME_REQUIRED: "1" });
    assert.equal(railwayHosted(e), true);
    assert.throws(() => fleetRollout(e), /must name its scope/);
    assert.equal(railwayHosted({ MERRYMEN_PERSISTENT_HOME_REQUIRED: "0" }), false);
  });

  it("a deployer's token is not a deployment: RAILWAY_TOKEN alone does not make this Railway-hosted", () => {
    assert.equal(railwayHosted({ RAILWAY_TOKEN: "x", RAILWAY_API_TOKEN: "y" }), false);
  });

  it("is Railway wherever the deploy guard is, and never the other way round", () => {
    // The guard (deploy-guard-checks.ts) skips off Railway; this refuses an
    // unset value on Railway. Were the guard's list ever wider than this one,
    // a process the guard checked as the fleet could still read unset as all.
    for (const key of [...RAILWAY_ONLY_IDENTITY, "RAILWAY_VOLUME_MOUNT_PATH", "RAILWAY_TOKEN", "RAILWAY_GIT_BRANCH"]) {
      for (const value of ["x", ""]) {
        if (onRailway({ [key]: value })) assert.equal(railwayHosted({ [key]: value }), true, `${key}=${JSON.stringify(value)}`);
      }
    }
    for (const key of RAILWAY_ONLY_IDENTITY) assert.equal(railwayHosted({ [key]: "" }), true, `${key}, present but empty`);
  });

  it("set on Railway, the value decides as anywhere else", () => {
    const e = env(`${A}:trade`, { RAILWAY_PROJECT_ID: "p" });
    assert.equal(rolloutLevel(A, e), "trade");
    assert.equal(rolloutLevel(B, e), "held");
  });
});

describe("what the readers make of it", () => {
  it("only the level reaches a child, and held never does", () => {
    const e = env(`${A}:trade`);
    assert.equal(childAdmissionLevel(A, e), "trade");
    assert.equal(childAdmissionLevel(B, e), "observe", "the grammar's most restrictive level");
    assert.equal(childAdmissionLevel(A, env("all")), "trade");
    assert.equal(ADMISSION_LEVEL_ENV, "MERRYMEN_ADMISSION_LEVEL", "the name the worker's admission gate reads");
  });

  it("fleet-wide writers run only when the whole fleet is admitted", () => {
    assert.equal(rolloutAdmitsWholeFleet(env("all")), true);
    assert.equal(rolloutAdmitsWholeFleet(env(undefined)), true);
    assert.equal(rolloutAdmitsWholeFleet(env("none")), false);
    assert.equal(rolloutAdmitsWholeFleet(env(`${A}:trade`)), false, "even one tenant at trade is not the whole fleet");
  });

  it("the heartbeat counts the roster by level, and names tenants the roster lacks", () => {
    const e = env(`${A}:trade,${B}:trade,${D}:trade`);
    const counts = rolloutCounts([A, B, C, C.toUpperCase().replace("0X", "0x")], e);
    assert.deepEqual(counts, { trade: 2, "exits-only": 0, observe: 0, held: 1, expired: 0, absent: 1 });
    assert.equal(
      rolloutLine(counts, e),
      "fleet| rollout 3 named — admitted: trade 2 · exits-only 0 · observe 0; not run: held 1 · expired 0; named but not in the roster 1",
    );
    const all = rolloutCounts([A, B], env("all"));
    assert.deepEqual(all, { trade: 2, "exits-only": 0, observe: 0, held: 0, expired: 0, absent: 0 });
    assert.equal(rolloutLine(all, env("all")), "fleet| rollout all — admitted: trade 2 · exits-only 0 · observe 0; not run: held 0 · expired 0");
    assert.match(rolloutLine(all, env(undefined)), /^fleet\| rollout all \(unset off Railway\) /);
    assert.deepEqual(rolloutCounts([A, B], env("none")), { trade: 0, "exits-only": 0, observe: 0, held: 2, expired: 0, absent: 0 });
    assert.match(rolloutLine(rolloutCounts([A], env("halt")), env("halt")), /^fleet\| rollout REFUSED — .* held 1 · expired 0$/);
  });

  it("a tenant nothing runs for is never counted at a level: the accounting hold is held, an expired key is expired", () => {
    // A, B, C and D all admitted at trade. A is named by the accounting hold,
    // B's key has expired, and A's has too: held wins, as nothing runs either way.
    const counts = rolloutCounts([A, B, C, D], env("all"), { accountingHeld: new Set([A]), unexpired: new Set([C, D]) });
    assert.deepEqual(counts, { trade: 2, "exits-only": 0, observe: 0, held: 1, expired: 1, absent: 0 });
    // Held by the rollout and expired: held.
    assert.deepEqual(rolloutCounts([A, B], env(`${A}:trade`), { unexpired: new Set([A]) }),
      { trade: 1, "exits-only": 0, observe: 0, held: 1, expired: 0, absent: 0 });
  });

  it("a pass that could not read the roster says so, and repeats no older figure", () => {
    assert.equal(rolloutLine(null, env("none")), "fleet| rollout none — the last pass could not read the roster");
  });

  it("the heartbeat row carries the line's scope and counts, and never a tenant", () => {
    const e = env(`${A}:trade,${B}:observe,${D}:exits-only`);
    const summary = rolloutSummary(rolloutCounts([A, B, C], e), e);
    assert.deepEqual(summary, { scope: "3 named", levels: { trade: 1, "exits-only": 0, observe: 1, held: 1, expired: 0, absent: 1 } });
    assert.doesNotMatch(JSON.stringify(summary), /0x/i);
    assert.deepEqual(rolloutSummary(null, env("none")), { scope: "none", levels: {} }, "uncounted is no levels, never zeros");
    assert.equal(rolloutSummary(null, env(undefined)).scope, "all (unset off Railway)");
    assert.equal(rolloutSummary(null, env("halt")).scope, "REFUSED");
  });

  it("the startup line says the scope that took", () => {
    assert.match(rolloutStartupLine(fleetRollout(env("none"))), /^fleet rollout: none — no tenant is admitted/);
    assert.match(rolloutStartupLine(fleetRollout(env("all"))), /^fleet rollout: all — every tenant is admitted at trade$/);
    assert.match(rolloutStartupLine(fleetRollout(env(undefined))), /unset off Railway/);
    assert.match(
      rolloutStartupLine(fleetRollout(env(`${A}:trade,${B}:trade,${C}:trade`))),
      /^fleet rollout: 3 named tenant\(s\) — trade 3 · exits-only 0 · observe 0; every other tenant is held/,
    );
  });

  it("a changed value is read afresh, not served from the last parse", () => {
    assert.equal(rolloutLevel(A, env(`${A}:trade`)), "trade");
    assert.equal(rolloutLevel(A, env(`${B}:trade`)), "held");
    assert.equal(rolloutLevel(A, env(`${A}:trade`)), "trade");
    assert.equal(rolloutLevel(A, env("none")), "held");
    assert.equal(rolloutLevel(A, env(undefined)), "trade");
    assert.equal(rolloutLevel(A, env(undefined, { RAILWAY_SERVICE_ID: "s" })), "held");
  });
});

describe("the levels a worker in this tree obeys", () => {
  /**
   * A TRIPWIRE ON THE ORDER TWO CHANGES MERGE IN. The worker's admission gate
   * is worker-admission.ts, by the name the rollout plan gives it. Without it
   * in this tree, `trade` is the only level anything obeys, and the rollout
   * must accept no other (fleet-rollout.ts WORKER_ENFORCED_LEVELS). With it,
   * the set is widened in the same change, and this fails until it is: a
   * refusal left in place is safe but would keep the staged rollout from ever
   * using the levels it exists for.
   */
  it("are exactly the ones the rollout accepts: trade, until the worker's admission gate is here", () => {
    const gate = existsSync(fileURLToPath(new URL("./worker-admission.ts", import.meta.url)));
    assert.deepEqual(
      [...WORKER_ENFORCED_LEVELS].sort(),
      gate ? [...ADMISSION_LEVELS].sort() : ["trade"],
      gate
        ? "worker-admission.ts is in this tree: widen WORKER_ENFORCED_LEVELS to the levels it obeys, in the same change"
        : "no worker in this tree reads MERRYMEN_ADMISSION_LEVEL, so no level but trade may be accepted",
    );
  });

  it("are the gate's own list and variable, defined once: the rollout keeps no copy to drift", () => {
    assert.equal(ADMISSION_LEVELS, gate.ADMISSION_LEVELS);
    assert.equal(ADMISSION_LEVEL_ENV, gate.ADMISSION_LEVEL_ENV);
    // Every level the rollout hands a child is one the gate reads as itself,
    // not as the `observe` it falls back to on a word it does not know.
    for (const level of WORKER_ENFORCED_LEVELS) assert.equal(gate.admissionFrom(level, true).level, level);
  });
});
