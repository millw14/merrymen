import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import { createRestarter, waitForExit } from "./worker-lifecycle.cjs";

/**
 * A deliberately slow-to-exit worker must never overlap its successor.
 * Fake child: records kills, exits only when told (or never, for the
 * SIGTERM-ignoring case).
 */
function fakeChild({ exitsOn = [] } = {}) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kills = [];
  child.kill = (sig) => {
    child.kills.push(sig ?? "SIGTERM");
    if (exitsOn.includes(child.kills[child.kills.length - 1])) {
      child.exitCode = 0;
      child.emit("exit", 0, null);
    }
    return true;
  };
  return child;
}

const ms = (n) => new Promise((r) => setTimeout(r, n));

describe("waitForExit", () => {
  it("true immediately for dead or absent children", async () => {
    assert.equal(await waitForExit(null, 50), true);
    assert.equal(await waitForExit({ exitCode: 0, signalCode: null, once() {} }, 50), true);
  });

  it("false on timeout when the child never exits", async () => {
    const child = fakeChild({ exitsOn: [] });
    assert.equal(await waitForExit(child, 20), false);
  });
});

describe("createRestarter — no overlapping workers", () => {
  function rig(old) {
    let current = old;
    const events = [];
    const starts = [];
    const r = createRestarter({
      getCurrent: () => current,
      setCurrent: (c) => {
        current = c;
      },
      startWorker: () => {
        // The test's stand-in for "a second worker trading": record WHEN it
        // started relative to the old child's exit.
        starts.push({ oldExited: old ? old.exitCode !== null : true });
        const next = fakeChild({ exitsOn: ["SIGTERM"] });
        return next;
      },
      killGraceful: (c) => c.kill("SIGTERM"),
      killForce: (c) => c.kill("SIGKILL"),
      onEvent: (e) => events.push(e),
      gracefulMs: 30,
      forceMs: 30,
    });
    return { r, events, starts, current: () => current };
  }

  it("a SIGTERM-ignoring worker is escalated and never overlaps its successor", async () => {
    const old = fakeChild({ exitsOn: ["SIGKILL"] }); // ignores SIGTERM
    const { r, events, starts } = rig(old);
    await r.restart();
    assert.deepEqual(old.kills, ["SIGTERM", "SIGKILL"], "graceful first, then force");
    assert.deepEqual(events, ["escalate", "started"]);
    assert.equal(starts.length, 1);
    assert.equal(starts[0].oldExited, true, "successor starts only after the old worker exited");
  });

  it("a cooperative worker needs no escalation", async () => {
    const old = fakeChild({ exitsOn: ["SIGTERM"] });
    const { r, events, starts } = rig(old);
    await r.restart();
    assert.deepEqual(old.kills, ["SIGTERM"]);
    assert.deepEqual(events, ["started"]);
    assert.equal(starts[0].oldExited, true);
  });

  it("no current worker means just start", async () => {
    const { r, events, starts } = rig(null);
    await r.restart();
    assert.deepEqual(events, ["started"]);
    assert.equal(starts.length, 1);
  });

  it("concurrent restarts collapse into one (single-flight)", async () => {
    const old = fakeChild({ exitsOn: ["SIGKILL"] });
    const { r, starts } = rig(old);
    const [a, b] = await Promise.all([r.restart(), r.restart()]);
    assert.equal(starts.length, 1, "one replacement for two rapid clicks");
    assert.equal(b, null, "the collapsed caller gets no handle (cleared synchronously — no second worker is made)");
    assert.notEqual(a, old, "the running restart delivers the replacement");
    await ms(80); // let the background restart (if any wrongly started) settle
    assert.equal(starts.length, 1);
  });
});
