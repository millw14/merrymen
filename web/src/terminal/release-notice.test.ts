/**
 * A RELEASE NOTICE MUST NOT REACH, OR SPEND ITSELF ON, A VISITOR WITH NO AGENT.
 *
 * The desk mounted the Trencher notice inside its own `if (!mine)` branch — the
 * empty state that exists to get somebody to create an agent — so a new visitor
 * was told about a trading mode for an agent they did not have, directly above
 * the button asking them to make one.
 *
 * The quieter half is the one these tests mostly guard. The notice fires a
 * desktop notification ONCE EVER and writes a flag to say so. Spent on a
 * visitor with no agent, that flag is still spent when they create one the next
 * day — so the owner the release was written for hears nothing, for ever, and
 * nothing anywhere records why.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { releaseNotice } from "./release-notice";

/** An owner with an agent who has seen nothing yet and could be notified. */
const owner = (over: Partial<Parameters<typeof releaseNotice>[0]> = {}) =>
  releaseNotice({ hasAgent: true, dismissed: false, alreadyNotified: false, canNotify: true, ...over });

describe("a visitor with no agent", () => {
  it("is not shown the notice", () => {
    assert.equal(owner({ hasAgent: false }).show, false);
  });

  it("IS NOT NOTIFIED, AND DOES NOT SPEND THE ONE-SHOT", () => {
    // The whole point. `notify` false means the flag is never written, so the
    // notification is still there for the owner they may become tomorrow.
    assert.equal(owner({ hasAgent: false }).notify, false);
  });

  it("is refused on both counts whatever else is true", () => {
    // No combination of the other inputs may let it through — the agent check
    // is a precondition, not one vote among several.
    for (const dismissed of [true, false]) {
      for (const alreadyNotified of [true, false]) {
        for (const canNotify of [true, false]) {
          assert.deepEqual(
            releaseNotice({ hasAgent: false, dismissed, alreadyNotified, canNotify }),
            { show: false, notify: false },
            JSON.stringify({ dismissed, alreadyNotified, canNotify }),
          );
        }
      }
    }
  });
});

describe("an owner who has an agent", () => {
  it("sees the notice and gets the notification", () => {
    assert.deepEqual(owner(), { show: true, notify: true });
  });

  it("stops seeing it once dismissed", () => {
    assert.equal(owner({ dismissed: true }).show, false);
  });

  it("is not notified twice", () => {
    assert.equal(owner({ alreadyNotified: true }).notify, false);
  });

  it("is not notified when the browser cannot", () => {
    // No permission, or no Notification API at all. Not a failure — the in-app
    // notice is the real delivery and still shows.
    assert.deepEqual(owner({ canNotify: false }), { show: true, notify: false });
  });
});

describe("showing and notifying are independent", () => {
  it("does not re-arm the notification by dismissing the notice", () => {
    assert.equal(owner({ dismissed: true, alreadyNotified: true }).notify, false);
  });

  it("still shows the notice to somebody already notified", () => {
    // The desktop notification is a nudge, not the delivery. Treating it as
    // delivery would hide the notice from everyone who saw a toast in passing.
    assert.equal(owner({ alreadyNotified: true }).show, true);
  });

  it("can notify while the notice itself is dismissed", () => {
    // Reachable when the two records disagree — a dismissal written in a
    // browser where the notify flag failed to write. Neither implies the other.
    assert.deepEqual(owner({ dismissed: true, alreadyNotified: false }), { show: false, notify: true });
  });
});
