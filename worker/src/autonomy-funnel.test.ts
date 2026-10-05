/**
 * THE FUNNEL SAYS WHICH RAIL, WHICH STAGE, AND WHICH HOLDS WERE DECISIONS.
 *
 * Each case below is a way the one-line funnel misread a real hour: a stale
 * row counted as trading for real, the executor's own refusals blamed on the
 * owner's wall, paper fills read as an execution drop-off, an unknown receipt
 * read as a refusal, and every quiet review filed as an unreported hold.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
  AUTONOMY_HOLDS_SQL,
  RAIL_NO_WORKER,
  RAIL_RESPAWNING,
  autonomyHolds,
  autonomyLines,
  beatSec,
  fleetRails,
  foldFunnel,
  policyPassed,
  railOf,
  railOfTrade,
  railsLine,
  stageOf,
} from "./autonomy-funnel";
import { PRIVATE_REVIEW_SOURCE, RESEARCH_UNAVAILABLE_SOURCE, REVIEW_SOURCE } from "./market-review";

describe("stageOf: the owner's wall, or the house's own execution", () => {
  it("every gas and key-install refusal is execution, prefund included", () => {
    for (const rule of [
      "gas-absurd", "gas-unstable", "gas-unreadable", "gas-paymaster-unexpected",
      "enable-too-wide", "enable-replayed", "enable-redundant", "enable-unverified",
      "nonce-changed", "prefund-short", "prefund-unverified",
    ]) {
      assert.equal(stageOf(rule), "exec", rule);
    }
  });

  it("the sponsor declining and the ledger refusing the pre-broadcast row are execution", () => {
    for (const rule of ["sponsor-refused", "sponsor-unreachable", "sponsor-absurd", "not-recorded"]) {
      assert.equal(stageOf(rule), "exec", rule);
    }
  });

  it("the wall's own refusals, and the market's, are the wall", () => {
    for (const rule of ["no-exit", "grant-too-wide", "daily-cap", "per-trade-cap", "no-route", "scout-budget", ""]) {
      assert.equal(stageOf(rule), "wall", rule);
    }
  });
});

describe("railOfTrade: the row says its rail wherever it can", () => {
  it("paper is paper, and anything sent is live, whatever the agent's row says now", () => {
    assert.equal(railOfTrade("paper", "", "live"), "paper");
    for (const status of ["submitted", "landed", "reverted", "dropped"]) assert.equal(railOfTrade(status, "", "paper"), "live");
  });

  it("an execution refusal is live: only the live rail builds an operation", () => {
    assert.equal(railOfTrade("rejected", "gas-absurd", "paper"), "live");
    assert.equal(railOfTrade("rejected", "sponsor-refused", null), "live");
  });

  it("a wall refusal follows the agent, and an unknown agent is not counted live", () => {
    assert.equal(railOfTrade("rejected", "no-exit", "live"), "live");
    assert.equal(railOfTrade("rejected", "no-exit", "paper"), "paper");
    assert.equal(railOfTrade("rejected", "no-exit", "idle"), "paper");
    assert.equal(railOfTrade("rejected", "no-exit", null), "paper");
  });
});

describe("foldFunnel: one funnel per rail", () => {
  const LIVE = "0x00000000000000000000000000000000000000a1";
  const PAPER = "0x00000000000000000000000000000000000000b2";
  const mode = (id: string) => (id.toLowerCase() === LIVE ? "live" : id.toLowerCase() === PAPER ? "paper" : null);

  it("the incident hour: paper fills and paper no-exits are the paper rail, not an execution drop-off", () => {
    const f = foldFunnel(
      [
        { agent_id: PAPER, status: "rejected", rule: "no-exit", n: 185 },
        { agent_id: PAPER, status: "paper", rule: "", n: "9" },
        { agent_id: LIVE, status: "rejected", rule: "enable-too-wide", n: 44 },
        { agent_id: LIVE, status: "rejected", rule: "gas-absurd", n: 45 },
        { agent_id: LIVE, status: "landed", rule: "", n: 2 },
        { agent_id: LIVE, status: "reverted", rule: "", n: 1 },
      ],
      mode,
    );
    assert.deepEqual(f.paper, { proposals: 194, wallRefused: 185, execRefused: 0, userops: 0, landed: 0, failed: 0, paperFills: 9 });
    assert.deepEqual(f.live, { proposals: 92, wallRefused: 0, execRefused: 89, userops: 3, landed: 2, failed: 1, paperFills: 0 });
    // The gas ceiling saying no is a PASS of policy and a failure of execution.
    assert.equal(policyPassed(f), 194 + 92 - 185);
    assert.deepEqual(f.refusals.map((r) => [r.rule, r.n, r.stage]), [
      ["no-exit", 185, "wall"],
      ["gas-absurd", 45, "exec"],
      ["enable-too-wide", 44, "exec"],
    ]);
  });

  it("receipt-unresolved is sent with no receipt yet: a userop, never a refusal", () => {
    const f = foldFunnel(
      [
        { agent_id: LIVE, status: "submitted", rule: "receipt-unresolved", n: 2 },
        // Were it ever written beside `rejected`, it would still have gone out.
        { agent_id: PAPER, status: "rejected", rule: "receipt-unresolved", n: 1 },
      ],
      mode,
    );
    assert.equal(f.live.userops, 3);
    assert.equal(f.live.wallRefused + f.live.execRefused + f.paper.wallRefused + f.paper.execRefused, 0);
    assert.equal(f.refusals.length, 0);
  });

  it("the operator's admission gate is apart from the funnel, so an observed cohort reads as held, not as refused", () => {
    const f = foldFunnel(
      [
        { agent_id: LIVE, status: "rejected", rule: "rollout-hold", n: 50 },
        { agent_id: LIVE, status: "rejected", rule: "draining", n: 2 },
        { agent_id: LIVE, status: "rejected", rule: "grant-too-wide", n: 1 },
      ],
      mode,
    );
    assert.equal(f.admissionHeld, 52);
    assert.equal(f.live.proposals, 1);
    assert.equal(f.grantTooWide, 1);
    assert.equal(policyPassed(f), 0);
    assert.ok(!f.refusals.some((r) => r.rule === "rollout-hold"));
  });
});

describe("rails: live only if the row says so AND was written by the worker running now", () => {
  const SPAWN_MS = 1_800_000_000_000;
  const at = Math.floor(SPAWN_MS / 1000);
  const row = (mode: string | null, beat: number | null, blocker: string | null = null) => ({
    smart_account: "0x00000000000000000000000000000000000000a1",
    mode,
    live_blocker: blocker,
    beat_at: beat,
  });

  it("a live row beaten since the spawn is live", () => {
    assert.equal(railOf(row("live", at + 30), SPAWN_MS), "live");
  });

  it("a live row from BEFORE the spawn is the predecessor's: unknown (respawning)", () => {
    // The mirror keeps the last mode and beat across a respawn and copies the
    // blocker over as NULL, so this is exactly what a redeploy leaves behind.
    assert.equal(railOf(row("live", at - 60), SPAWN_MS), RAIL_RESPAWNING);
    assert.equal(railOf(row("live", null), SPAWN_MS), RAIL_RESPAWNING);
  });

  it("live with a blocker is never live", () => {
    assert.equal(railOf(row("live", at + 30, "no-cash"), SPAWN_MS), RAIL_RESPAWNING);
  });

  it("freshness applies to every mode: a stale paper row is no more current than a stale live one", () => {
    assert.equal(railOf(row("paper", at + 30, "live-not-enabled"), SPAWN_MS), "paper");
    assert.equal(railOf(row("paper", at - 60), SPAWN_MS), RAIL_RESPAWNING);
  });

  it("no worker in this replica: nothing here is trading for it, whatever its row last said", () => {
    assert.equal(railOf(row("live", at + 30), undefined), RAIL_NO_WORKER);
  });

  it("a beat in milliseconds is the same beat", () => {
    assert.equal(beatSec((at + 30) * 1000), at + 30);
    assert.equal(railOf(row("live", (at + 30) * 1000), SPAWN_MS), "live");
    assert.equal(railOf(row("live", (at - 60) * 1000), SPAWN_MS), RAIL_RESPAWNING);
  });

  it("the fleet's rails count every agent once, keyed case-blind, and only fresh live rows are live", () => {
    const rails = fleetRails(
      [
        { ...row("live", at + 30), smart_account: "0x00000000000000000000000000000000000000A1" },
        { ...row("live", at - 60), smart_account: "0x00000000000000000000000000000000000000b2" },
        { ...row("paper", at + 30), smart_account: "0x00000000000000000000000000000000000000c3" },
        { ...row("live", at + 30), smart_account: "0x00000000000000000000000000000000000000d4" },
      ],
      new Map([
        ["0x00000000000000000000000000000000000000a1", SPAWN_MS],
        ["0x00000000000000000000000000000000000000b2", SPAWN_MS],
        ["0x00000000000000000000000000000000000000c3", SPAWN_MS],
      ]),
    );
    assert.equal(rails.live, 1);
    assert.deepEqual(rails.counts, { live: 1, paper: 1, [RAIL_RESPAWNING]: 1, [RAIL_NO_WORKER]: 1 });
    assert.equal(railsLine(rails), "fleet| rails — live 1, paper 1, unknown (respawning) 1, no worker here 1");
  });
});

describe("the autonomy lines keep their prefixes", () => {
  const empty = foldFunnel([], () => null);

  it("silent only when nobody is live and nothing happened", () => {
    assert.deepEqual(autonomyLines(0, empty, []), []);
    assert.deepEqual(autonomyLines(null, empty, []), []);
    assert.ok(autonomyLines(2, empty, []).length > 0, "live agents proposing nothing is the alarming hour, never a silent one");
  });

  it("the first line is still `autonomy| 1h — `, then one line per rail, then the refusals tagged by stage", () => {
    const f = foldFunnel(
      [
        { agent_id: "a", status: "rejected", rule: "no-exit", n: 3 },
        { agent_id: "b", status: "rejected", rule: "gas-absurd", n: 1 },
        { agent_id: "b", status: "landed", rule: "", n: 1 },
      ],
      (id) => (id === "b" ? "live" : "paper"),
    );
    const lines = autonomyLines(1, f, [{ kind: "MODEL_HOLD", n: 1 }]);
    assert.match(lines[0]!, /^autonomy\| 1h — 1 live · proposals 5 · policy-passed 2 · userops 1 · LANDED 1 · failed 0 · grant-too-wide 0 · holds /);
    assert.match(lines[1]!, /^autonomy\| 1h live-rail — proposals 2 · wall-refused 0 · exec-refused 1 · userops 1 · LANDED 1 · failed 0$/);
    assert.match(lines[2]!, /^autonomy\| 1h paper-rail — proposals 3 · wall-refused 3 · paper-fills 0$/);
    assert.equal(lines[3], "autonomy| 1h refusals — no-exit 3 [wall] · gas-absurd 1 [exec]");
  });
});

describe("quiet reviews are a bucket of their own", () => {
  it("the holds query files every quiet-review source under QUIET_REVIEW, and only rows with no kind", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE decisions (source TEXT NOT NULL, action TEXT, hold_kind TEXT, at INTEGER NOT NULL)`);
      const add = db.prepare("INSERT INTO decisions (source, action, hold_kind, at) VALUES (?, ?, ?, ?)");
      add.run(REVIEW_SOURCE, "hold", null, 2000);
      add.run(PRIVATE_REVIEW_SOURCE, "hold", null, 2000);
      add.run(RESEARCH_UNAVAILABLE_SOURCE, "hold", null, 2000);
      add.run("strategy:steady-basket", "hold", null, 2000);
      add.run("brain", "hold", "MODEL_HOLD", 2000);
      // A kind the writer stamped is the kind counted, whatever the source.
      add.run(REVIEW_SOURCE, "hold", "STALE_MARK_HOLD", 2000);
      add.run(REVIEW_SOURCE, "hold", null, 1000); // outside the hour
      add.run(REVIEW_SOURCE, "buy", null, 2000); // not a hold
      const rows = db.prepare(AUTONOMY_HOLDS_SQL).all(1500) as { kind: string; n: number }[];
      const by = Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)]));
      assert.deepEqual(by, { QUIET_REVIEW: 3, unreported: 1, MODEL_HOLD: 1, STALE_MARK_HOLD: 1 });
      const line = autonomyHolds(rows);
      assert.match(line, /\b3 quiet-review\b/);
      assert.match(line, /\b1 unreported\b/);
    } finally {
      db.close();
    }
  });
});
