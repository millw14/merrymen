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
import { RAIL_CONTRADICTORY, RAIL_NO_WORKER, RAIL_RESPAWNING, foldFunnel } from "./autonomy-funnel";
import {
  FLEET_HEARTBEAT_EVERY_MS,
  commitOf,
  heartbeatClock,
  heartbeatCounts,
  lastShutdownOf,
  numbersOnly,
  publicHeartbeat,
  readFleetHeartbeats,
  writeFleetHeartbeat,
  type FleetHeartbeat,
  type FleetSnapshot,
} from "./fleet-heartbeat";
import { SHUTDOWN_RECEIPT_FILE, shutdownReceiptDir, takePreviousShutdown, writeShutdownReceipt, type ShutdownReceipt } from "./fleet-drain";

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
    lastShutdown: { clean: true, finishedAt: 1_799_999_000 },
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
      assert.deepEqual(o.lastShutdown, { clean: true, finishedAt: 1_799_999_000 });
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
      // A failure before submit is published as execution, so a check keyed
      // on exec-refused sees an execution outage as one.
      assert.equal(c.funnel1h.live.execRefused, 2);
      assert.equal(c.funnel1h.live.wallRefused, 0);
      assert.equal(c.funnel1h.live.marketRefused, 0);
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

describe("the clock: once a minute, never two at once", () => {
  /** A beat that settles when the test says so, recording what it was asked. */
  function harness(mayCreate = true) {
    let nowMs = 1_800_000_000_000;
    const asked: boolean[] = [];
    const logged: string[] = [];
    let settle: ((r: boolean | Error) => void) | null = null;
    const clock = heartbeatClock({
      mayCreate,
      nowMs: () => nowMs,
      log: (line) => logged.push(line),
      beat: (create) => {
        asked.push(create);
        return new Promise<boolean>((resolve, reject) => {
          settle = (r) => (r instanceof Error ? reject(r) : resolve(r));
        });
      },
    });
    return {
      clock,
      asked,
      logged,
      advance: (ms: number) => void (nowMs += ms),
      /** Settle the beat in flight, and wait for the clock to see it. */
      async finish(beat: Promise<void> | null, r: boolean | Error = true) {
        assert.ok(beat, "a beat was started");
        settle!(r);
        await beat;
      },
    };
  }

  it("two ticks inside the minute write one beat; the next minute writes the next", async () => {
    const h = harness();
    await h.finish(h.clock.tick());
    h.advance(FLEET_HEARTBEAT_EVERY_MS - 1);
    assert.equal(h.clock.tick(), null, "inside the minute");
    h.advance(1);
    await h.finish(h.clock.tick());
    assert.equal(h.asked.length, 2);
  });

  it("a beat that hangs is never joined by a second, however long it hangs", async () => {
    const h = harness();
    const first = h.clock.tick();
    h.advance(10 * FLEET_HEARTBEAT_EVERY_MS);
    assert.equal(h.clock.tick(), null, "still in flight: no second write behind it");
    assert.equal(h.clock.tick(), null);
    await h.finish(first);
    assert.equal(h.asked.length, 1);
    // Settled, and a minute has long passed: the next tick beats at once.
    await h.finish(h.clock.tick());
    assert.equal(h.asked.length, 2);
  });

  it("the table is created until the first beat lands, and then only upserted", async () => {
    const h = harness();
    await h.finish(h.clock.tick(), new Error("connection refused"));
    h.advance(FLEET_HEARTBEAT_EVERY_MS);
    await h.finish(h.clock.tick(), true);
    h.advance(FLEET_HEARTBEAT_EVERY_MS);
    await h.finish(h.clock.tick(), true);
    assert.deepEqual(h.asked, [true, true, false]);
  });

  it("a writer that may not create the table is never asked to, and a skipped beat is not an error", async () => {
    const h = harness(false);
    await h.finish(h.clock.tick(), false);
    h.advance(FLEET_HEARTBEAT_EVERY_MS);
    await h.finish(h.clock.tick(), true);
    assert.deepEqual(h.asked, [false, false]);
    assert.deepEqual(h.logged, []);
  });

  it("a failure is said once per distinct message, retried a minute later — not every pass — and its end is said once", async () => {
    const h = harness();
    await h.finish(h.clock.tick(), new Error("connection refused"));
    assert.equal(h.clock.tick(), null, "a failed beat still started the minute");
    h.advance(FLEET_HEARTBEAT_EVERY_MS);
    await h.finish(h.clock.tick(), new Error("connection refused"));
    h.advance(FLEET_HEARTBEAT_EVERY_MS);
    await h.finish(h.clock.tick(), new Error("too many clients"));
    h.advance(FLEET_HEARTBEAT_EVERY_MS);
    await h.finish(h.clock.tick(), true);
    h.advance(FLEET_HEARTBEAT_EVERY_MS);
    await h.finish(h.clock.tick(), true);
    assert.deepEqual(h.logged, [
      "fleet heartbeat: write failed — connection refused",
      "fleet heartbeat: write failed — too many clients",
      "fleet heartbeat: writing again",
    ]);
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

  it("every rail the rails line can name is a key that survives being served", () => {
    const rails = { live: 1, paper: 1, idle: 1, [RAIL_RESPAWNING]: 1, [RAIL_CONTRADICTORY]: 1, [RAIL_NO_WORKER]: 1 };
    assert.deepEqual(numbersOnly(rails), rails);
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

  it("the last shutdown is the drain's receipt as its one read took it: two facts only, and absent is null", () => {
    const dir = shutdownReceiptDir(mkdtempSync(path.join(tmpdir(), "mm-heartbeat-")));
    // As the orchestrator builds it at boot, from takePreviousShutdown's answer.
    const taken = () => {
      const t = takePreviousShutdown(dir);
      return lastShutdownOf({ clean: t.clean, finishedAt: t.at });
    };
    try {
      assert.equal(taken(), null, "no receipt");
      const receipt: ShutdownReceipt = {
        version: 1, signal: "SIGTERM", outcome: "budget-exceeded", clean: false,
        startedAt: 1_799_999_990_000, finishedAt: 1_800_000_000_000, budgetMs: 25_000, stalledAt: "final-pass",
        steps: [{ step: "final-pass", ms: 9_000, outcome: "timeout" }], hooksFailed: 0, hooksUnfinished: 0, stragglers: 1,
        finalPass: { homes: 2, saved: 1, retained: 0, skipped: 0, outOfTime: 1 }, inFlightAtRelease: false, stuckSpawns: 0,
      };
      // The receipt itself, under its own names: ms made seconds, nothing else carried.
      assert.deepEqual(lastShutdownOf(receipt), { clean: false, finishedAt: 1_800_000_000 });
      writeShutdownReceipt(dir, receipt);
      assert.deepEqual(taken(), { clean: false, finishedAt: 1_800_000_000 });
      assert.equal(taken(), null, "moved aside by that one read: a second finds no receipt");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, SHUTDOWN_RECEIPT_FILE), "{ torn");
      assert.deepEqual(taken(), { clean: false, finishedAt: null }, "a receipt that cannot be read is NOT clean, with no time");
      assert.deepEqual(lastShutdownOf({ clean: true, at: 1_800_000_000 }), { clean: true, finishedAt: null }, "`at` is not the receipt's name");
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  });
});
