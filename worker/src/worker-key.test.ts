/**
 * The orchestrator's worker keys (worker-key.ts): exactly two shapes, and
 * nothing that is not one of them names an owner or a wallet.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { isPerpsWorkerKey, parseWorkerKey, PERPS_CHILDREN_DIR, perpsChildHome, workerKey, workerOwner, workerPurpose } from "./worker-key";
import { parseFleetId } from "./fleet-id";

const OWNER = "0xabcdef0000000000000000000000000000000001";

describe("worker keys", () => {
  it("names the Spot worker by the owner alone, as every tenant key always was", () => {
    assert.equal(workerKey(OWNER, "spot"), OWNER);
    assert.deepEqual(parseWorkerKey(OWNER), { owner: OWNER, purpose: "spot" });
    assert.equal(workerOwner(OWNER), OWNER);
    assert.equal(workerPurpose(OWNER), "spot");
    assert.equal(isPerpsWorkerKey(OWNER), false);
  });

  it("names the Perps worker owner:perps, and lowercases the owner it is given", () => {
    const key = workerKey(OWNER.toUpperCase().replace("0X", "0x"), "perps");
    assert.equal(key, `${OWNER}:perps`);
    assert.deepEqual(parseWorkerKey(key), { owner: OWNER, purpose: "perps" });
    assert.equal(workerOwner(key), OWNER);
    assert.equal(workerPurpose(key), "perps");
    assert.equal(isPerpsWorkerKey(key), true);
  });

  it("refuses everything else, rather than guessing an owner or a wallet", () => {
    for (const raw of [
      `${OWNER}:PERPS`,
      `${OWNER}:perps:perps`,
      `${OWNER}:spot`,
      `${OWNER.toUpperCase().replace("0X", "0x")}:perps`,
      ` ${OWNER}:perps`,
      `${OWNER}:perps `,
      `${OWNER.slice(0, -1)}:perps`,
      `sol:${OWNER}`,
      ":perps",
      "",
      undefined,
      42,
    ]) {
      assert.equal(parseWorkerKey(raw), null, `${String(raw)} is not a worker key`);
      assert.equal(isPerpsWorkerKey(raw), false);
      if (typeof raw === "string") {
        assert.throws(() => workerOwner(raw), RangeError);
        assert.throws(() => workerPurpose(raw), RangeError);
      }
    }
    assert.throws(() => workerKey("not-an-address", "perps"), RangeError);
    assert.throws(() => workerKey(`${OWNER}:perps`, "perps"), RangeError, "a key is not an owner");
  });

  it("leaves the fleet-id parser alone: no operator variable can name one wallet's worker", () => {
    assert.equal(parseFleetId(`${OWNER}:perps`)?.kind, "unsupported");
    assert.equal(parseFleetId(OWNER)?.kind, "evm");
  });

  it("puts a Perps worker's home under children-perps/<owner>", () => {
    assert.equal(PERPS_CHILDREN_DIR, "children-perps");
    assert.equal(perpsChildHome("/fleet", OWNER), path.join("/fleet", "children-perps", OWNER));
    assert.equal(perpsChildHome("/fleet", `${OWNER}:perps`), path.join("/fleet", "children-perps", OWNER));
  });
});
