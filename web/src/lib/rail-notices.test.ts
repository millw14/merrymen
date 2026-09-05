import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { RAIL_LIMIT, railNotices, type WorkerEvent } from "./rail-notices";

const w = (message: string, created_at = "2026-09-02 10:00:00"): WorkerEvent => ({
  level: "warn",
  message,
  created_at,
});

describe("railNotices — what the owner finally gets to see", () => {
  it("keeps warnings and drops everything else", () => {
    // `err` already has a home: it becomes the status line's lastError. `ok` is
    // the tape. This block exists for the level that had no reader at all.
    const out = railNotices([
      { level: "ok", message: "armed", created_at: "2026-09-02 10:00:00" },
      w("no bundler key — this agent CANNOT trade live"),
      { level: "err", message: "boom", created_at: "2026-09-02 10:00:00" },
    ]);
    assert.deepEqual(
      out.map((n) => n.message),
      ["no bundler key — this agent CANNOT trade live"],
    );
  });

  it("DEDUPES BY MESSAGE — an agent that restarts hourly says it hourly", () => {
    // The reason this function exists rather than a .filter() in the JSX. These
    // are written once per arm, not once per condition, so twenty restarts turn
    // one warning into twenty rows and bury the two other things that are wrong.
    const out = railNotices([
      w("no bundler key", "2026-09-02 12:00:00"),
      w("no bundler key", "2026-09-02 11:00:00"),
      w("this account does not exist on chain 4663 yet", "2026-09-02 11:00:00"),
      w("no bundler key", "2026-09-02 10:00:00"),
    ]);
    assert.deepEqual(
      out.map((n) => n.message),
      ["no bundler key", "this account does not exist on chain 4663 yet"],
    );
  });

  it("shows the MOST RECENT time it was said, not the first", () => {
    // Follows from taking the first sighting under the API's newest-first order.
    // The other choice — earliest — would date a live problem to last week.
    const out = railNotices([w("still broken", "2026-09-02 12:00:00"), w("still broken", "2026-08-30 09:00:00")]);
    assert.equal(out[0]!.created_at, "2026-09-02 12:00:00");
  });

  it("caps the list, counting DISTINCT messages", () => {
    // The cap is on what is rendered, so it has to be applied after the dedupe.
    // Applied before, a repeated warning would spend the whole budget on itself.
    const events = [w("a"), w("a"), w("a"), w("b"), w("c"), w("d")];
    assert.deepEqual(
      railNotices(events).map((n) => n.message),
      ["a", "b", "c"],
    );
    assert.equal(RAIL_LIMIT, 3);
  });

  it("survives an absent events array rather than throwing into a blank page", () => {
    // /api/feed omits `events` entirely on the no-ledger path.
    assert.deepEqual(railNotices(undefined), []);
    assert.deepEqual(railNotices(null), []);
    assert.deepEqual(railNotices([]), []);
    assert.deepEqual(railNotices([w("a")], 0), []);
  });
});

describe("the page actually renders them", () => {
  it("YouClient reads railNotices and not a bare level filter", () => {
    // THE HALF THAT WAS MISSING LAST TIME. A pure function with tests proves the
    // rule; it does not prove anyone calls it, and the bug this whole block
    // fixes was a call site that filtered events down to one level and dropped
    // the rest. So pin the call.
    const src = readFileSync(new URL("../app/(app)/you/YouClient.tsx", import.meta.url), "utf8");
    assert.match(src, /railNotices\(/, "the page must go through the tested rule");
    assert.match(src, /mm-notices/, "and must have somewhere to put the result");
  });
});
