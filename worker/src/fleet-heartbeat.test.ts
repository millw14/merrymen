/**
 * ONE ROW PER ROLE, WRITTEN EVERY MINUTE, SERVED AS AGGREGATES ONLY.
 *
 * Run against the store's real SQL on an in-memory sqlite through the ledger's
 * own driver; the Postgres dialect of the same statements is db.ts's
 * translation, covered by its own tests.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { wrapSqlite } from "./db";
import { foldFunnel } from "./autonomy-funnel";
import {
  LAST_SHUTDOWN_FILE,
  commitOf,
  heartbeatCounts,
  numbersOnly,
  publicHeartbeat,
  readFleetHeartbeats,
  readLastShutdown,
  writeFleetHeartbeat,
  type FleetHeartbeat,
  type FleetSnapshot,
} from "./fleet-heartbeat";

const ADDRESS = /0x[0-9a-f]{40}/i;
const A = "0x00000000000000000000000000000000000000a1";

function beat(over: Partial<FleetHeartbeat> = {}): FleetHeartbeat {
  return {
    role: "orchestrator",
    commit: "0123456789abcdef0123456789abcdef01234567",
    startedAt: 1_800_000_000,
    beatAt: 1_800_000_060,
    halted: true,
    rollout: { scope: "2 named", levels: { trade: 0, "exits-only": 1, observe: 1, held: 40, absent: 0 } },
    counts: null,
    lastShutdown: { clean: true, at: 1_799_999_000 },
    ...over,
  };
}

function snapshot(): FleetSnapshot {
  const funnel = foldFunnel(
    [
      { agent_id: A, status: "rejected", rule: `couldn't submit: reverted at ${A}`, n: 2 },
      { agent_id: A, status: "rejected", rule: "rollout-hold", n: 7 },
      { agent_id: A, status: "landed", rule: "", n: 1 },
    ],
    () => "live",
  );
  return {
    at: 1_800_000_060,
    byStatus: { armed: 3, expired: 1, error: 1 },
    total: 5,
    broken: 1,
    rails: { counts: { live: 1, "no worker here": 4 }, live: 1 },
    funnel,
    holds: [{ kind: "QUIET_REVIEW", n: 12 }, { kind: "MODEL_HOLD", n: "2" }],
    funnel6h: funnel,
  };
}

describe("the heartbeat row", () => {
  it("is upserted, one row per role, and read back as the same aggregates", async () => {
    const raw = new DatabaseSync(":memory:");
    try {
      const db = wrapSqlite(raw);
      const counts = heartbeatCounts(snapshot(), { children: 1, holders: 2 });
      assert.equal(await writeFleetHeartbeat(db, beat({ counts }), { create: true }), true);
      assert.equal(await writeFleetHeartbeat(db, beat({ beatAt: 1_800_000_120, halted: false, counts }), { create: true }), true);
      assert.equal(await writeFleetHeartbeat(db, beat({ role: "recovery-replies", beatAt: 1_800_000_100, rollout: null }), { create: false }), true);

      assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM fleet_heartbeat").get() as { n: number }).n, 2);
      const served = await readFleetHeartbeats(db, 1_800_000_150);
      assert.deepEqual(served.map((h) => [h.role, h.beatAgeSec, h.halted]), [
        ["orchestrator", 30, false],
        ["recovery-replies", 50, true],
      ]);
      const o = served[0]!;
      assert.equal(o.commit, "0123456789abcdef0123456789abcdef01234567");
      assert.deepEqual(o.rollout, { scope: "2 named", levels: { trade: 0, "exits-only": 1, observe: 1, held: 40, absent: 0 } });
      assert.deepEqual(o.lastShutdown, { clean: true, at: 1_799_999_000 });
      const c = o.counts as Record<string, any>;
      assert.equal(c.agents, 5);
      assert.equal(c.broken, 1);
      assert.deepEqual(c.byStatus, { armed: 3, expired: 1, error: 1 });
      assert.deepEqual(c.rails, { live: 1, "no worker here": 4 });
      assert.deepEqual(c.holds1h, { QUIET_REVIEW: 12, MODEL_HOLD: 2 });
      assert.equal(c.children, 1);
      assert.equal(c.holders, 2);
      // LANDED TOTALS, the admission gate's refusals apart from them.
      assert.equal(c.funnel1h.live.landed, 1);
      assert.equal(c.funnel1h.live.proposals, 3);
      assert.equal(c.funnel1h.admissionHeld, 7);
      assert.equal(c.funnel6h.live.landed, 1);
      // The free-text refusal rule never leaves the snapshot.
      assert.doesNotMatch(JSON.stringify(served), ADDRESS);
      assert.doesNotMatch(String((raw.prepare("SELECT counts FROM fleet_heartbeat WHERE role = 'orchestrator'").get() as { counts: string }).counts), ADDRESS);
    } finally {
      raw.close();
    }
  });

  it("never moves backwards: an older beat does not overwrite a newer one", async () => {
    const raw = new DatabaseSync(":memory:");
    try {
      const db = wrapSqlite(raw);
      await writeFleetHeartbeat(db, beat({ beatAt: 200, halted: false }), { create: true });
      await writeFleetHeartbeat(db, beat({ beatAt: 100, halted: true }), { create: true });
      const [h] = await readFleetHeartbeats(db, 210);
      assert.equal(h!.beatAt, 200);
      assert.equal(h!.halted, false);
    } finally {
      raw.close();
    }
  });

  it("a writer that may not create schema skips its beat while the table is missing", async () => {
    const raw = new DatabaseSync(":memory:");
    try {
      const db = wrapSqlite(raw);
      assert.equal(await writeFleetHeartbeat(db, beat({ role: "recovery-replies" }), { create: false }), false);
      assert.deepEqual(await readFleetHeartbeats(db, 1), [], "no table is no heartbeat yet, not an error");
    } finally {
      raw.close();
    }
  });

  it("refuses a role it does not know", async () => {
    const db = wrapSqlite(new DatabaseSync(":memory:"));
    await assert.rejects(writeFleetHeartbeat(db, beat({ role: "web" as never }), { create: true }));
  });
});

describe("what may be served", () => {
  it("numbers and objects of numbers only: no address as a key or a value, no text, no arrays", () => {
    const kept = numbersOnly({
      armed: 3,
      [A]: 1,
      [`armed ${A}`]: 1,
      deadbeefdeadbeefdeadbeef: 1,
      name: "Robin",
      who: A,
      list: [1, 2],
      half: 1.5,
      negative: -1,
      nested: { live: 2, [A]: 9, deeper: { x: 1 } },
      none: null,
    });
    assert.deepEqual(kept, { armed: 3, nested: { live: 2, deeper: { x: 1 } }, none: null });
  });

  it("a row is rebuilt from known fields: a bad commit, scope or role is dropped, not passed on", () => {
    assert.equal(publicHeartbeat({ role: "web", beat_at: 10 }, 20), null);
    assert.equal(publicHeartbeat({ role: "orchestrator", beat_at: null }, 20), null);
    const h = publicHeartbeat(
      {
        role: "orchestrator",
        commit_sha: `${A}; rm -rf`,
        started_at: "5",
        beat_at: "10",
        halted: "1",
        rollout: JSON.stringify({ scope: A, levels: { trade: 1 } }),
        counts: "not json",
        last_shutdown: JSON.stringify({ clean: "yes" }),
      },
      20,
    )!;
    assert.equal(h.commit, null);
    assert.equal(h.startedAt, 5);
    assert.equal(h.beatAgeSec, 10);
    assert.equal(h.halted, true);
    assert.equal(h.rollout, null);
    assert.equal(h.counts, null);
    assert.equal(h.lastShutdown, null);
    assert.doesNotMatch(JSON.stringify(h), ADDRESS);
  });
});

describe("the deploy's own facts", () => {
  it("the commit is Railway's hash or nothing", () => {
    assert.equal(commitOf({ RAILWAY_GIT_COMMIT_SHA: "0123456789ABCDEF0123456789abcdef01234567" }), "0123456789abcdef0123456789abcdef01234567");
    assert.equal(commitOf({ RAILWAY_GIT_COMMIT_SHA: "not a sha; rm -rf" }), null);
    assert.equal(commitOf({}), null);
  });

  it("the last shutdown is read from the drain's receipt, two facts only, and absent is null", () => {
    const home = mkdtempSync(path.join(tmpdir(), "mm-heartbeat-"));
    try {
      assert.equal(readLastShutdown(home), null);
      mkdirSync(path.join(home, "ops"));
      writeFileSync(path.join(home, LAST_SHUTDOWN_FILE), JSON.stringify({ clean: false, at: 1_800_000_000_000, tenants: [A] }));
      assert.deepEqual(readLastShutdown(home), { clean: false, at: 1_800_000_000 });
      writeFileSync(path.join(home, LAST_SHUTDOWN_FILE), "{ torn");
      assert.equal(readLastShutdown(home), null);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
