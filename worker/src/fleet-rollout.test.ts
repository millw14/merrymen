/**
 * THE ROLLOUT VALUE: ITS GRAMMAR, ITS REFUSALS, AND WHAT EACH READER MAKES OF IT.
 *
 * Pure: every reader here takes the environment as an argument, so nothing in
 * this file touches the process's own. The orchestrator wiring (who is leased,
 * spawned, killed or retired) is orchestrator-rollout.integration.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
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
} from "./fleet-rollout";

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

  it("a list admits exactly the tenants it names, each at its own level, and holds the rest", () => {
    const e = env(`${A}:observe,${B}:exits-only,${C}:trade`);
    assert.equal(rolloutLevel(A, e), "observe");
    assert.equal(rolloutLevel(B, e), "exits-only");
    assert.equal(rolloutLevel(C, e), "trade");
    assert.equal(rolloutLevel(D, e), "held");
    assert.equal(rolloutHeld(D, e), true);
    assert.equal(rolloutHeld(A, e), false);
  });

  it("addresses match whatever their case, and whitespace around entries is ignored", () => {
    const mixed = "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD";
    const e = env(` ${mixed}:trade , ${A}:observe `);
    assert.equal(rolloutLevel(mixed.toLowerCase(), e), "trade");
    assert.equal(rolloutLevel(mixed, e), "trade");
    assert.equal(rolloutLevel(A.toUpperCase().replace("0X", "0x"), e), "observe");
  });

  it(`takes up to ${MAX_ROLLOUT_TENANTS} named tenants and refuses one more`, () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `${address(0x1000 + i)}:observe`).join(",");
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
    ["an empty entry", `${A}:trade,,${B}:observe`],
    ["a semicolon", `${A}:trade;${B}:observe`],
    ["space inside an entry", `${A} : trade`],
    ["a tenant named twice at one level", `${A}:trade,${B}:observe,${A}:trade`],
    ["a tenant named twice at two", `${A}:trade,${A.toUpperCase().replace("0X", "0x")}:observe`],
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

  it("set on Railway, the value decides as anywhere else", () => {
    const e = env(`${A}:observe`, { RAILWAY_PROJECT_ID: "p" });
    assert.equal(rolloutLevel(A, e), "observe");
    assert.equal(rolloutLevel(B, e), "held");
  });
});

describe("what the readers make of it", () => {
  it("only the level reaches a child, and held never does", () => {
    const e = env(`${A}:exits-only`);
    assert.equal(childAdmissionLevel(A, e), "exits-only");
    assert.equal(childAdmissionLevel(B, e), "observe", "the most restrictive level a worker understands");
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
    const e = env(`${A}:observe,${B}:trade,${D}:exits-only`);
    const counts = rolloutCounts([A, B, C, C.toUpperCase().replace("0X", "0x")], e);
    assert.deepEqual(counts, { trade: 1, "exits-only": 0, observe: 1, held: 1, absent: 1 });
    assert.equal(
      rolloutLine(counts, e),
      "fleet| rollout 3 named — trade 1 · exits-only 0 · observe 1 · held 1 · named but not in the roster 1",
    );
    const all = rolloutCounts([A, B], env("all"));
    assert.deepEqual(all, { trade: 2, "exits-only": 0, observe: 0, held: 0, absent: 0 });
    assert.equal(rolloutLine(all, env("all")), "fleet| rollout all — trade 2 · exits-only 0 · observe 0 · held 0");
    assert.match(rolloutLine(all, env(undefined)), /^fleet\| rollout all \(unset off Railway\) /);
    assert.deepEqual(rolloutCounts([A, B], env("none")), { trade: 0, "exits-only": 0, observe: 0, held: 2, absent: 0 });
    assert.match(rolloutLine(rolloutCounts([A], env("halt")), env("halt")), /^fleet\| rollout REFUSED — .* held 1$/);
  });

  it("the startup line says the scope that took", () => {
    assert.match(rolloutStartupLine(fleetRollout(env("none"))), /^fleet rollout: none — no tenant is admitted/);
    assert.match(rolloutStartupLine(fleetRollout(env("all"))), /^fleet rollout: all — every tenant is admitted at trade$/);
    assert.match(rolloutStartupLine(fleetRollout(env(undefined))), /unset off Railway/);
    assert.match(
      rolloutStartupLine(fleetRollout(env(`${A}:observe,${B}:observe,${C}:trade`))),
      /^fleet rollout: 3 named tenant\(s\) — trade 1 · exits-only 0 · observe 2; every other tenant is held/,
    );
  });

  it("a changed value is read afresh, not served from the last parse", () => {
    assert.equal(rolloutLevel(A, env(`${A}:trade`)), "trade");
    assert.equal(rolloutLevel(A, env(`${A}:observe`)), "observe");
    assert.equal(rolloutLevel(A, env("none")), "held");
    assert.equal(rolloutLevel(A, env(undefined)), "trade");
    assert.equal(rolloutLevel(A, env(undefined, { RAILWAY_SERVICE_ID: "s" })), "held");
  });
});
