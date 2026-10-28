/**
 * The fleet's hourly trade funnel must query the ledger's actual timestamp —
 * and the snapshot the orchestrator logs and publishes must be read the way
 * the funnel module means it: per agent, per rail, with only the rows the
 * running workers wrote counted as their rail.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { AUTONOMY_TRADE_FUNNEL_SQL } from "./autonomy-funnel";
import { wrapSqlite } from "./db";
import { readFleetHeartbeats } from "./fleet-heartbeat";
import {
  childEnv,
  collectFleetSnapshot,
  fleetHaltFile,
  fleetHealthLines,
  setFleetHeartbeatDbForTest,
  writeOrchestratorHeartbeatForTest,
} from "./orchestrator";

it("counts recent trades by agent, status and rejection rule", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE trades (
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      reject_rule TEXT,
      created_at INTEGER NOT NULL
    )`);
    const insert = db.prepare("INSERT INTO trades (agent_id, status, reject_rule, created_at) VALUES (?, ?, ?, ?)");
    insert.run("0xa", "landed", null, 2000);
    insert.run("0xa", "rejected", "grant-too-wide", 2001);
    insert.run("0xb", "rejected", "grant-too-wide", 2002);
    insert.run("0xa", "landed", null, 1000);
    const rows = db.prepare(AUTONOMY_TRADE_FUNNEL_SQL).all(1500) as {
      agent_id: string; status: string; rule: string; n: number;
    }[];
    assert.deepEqual(
      rows.map((row) => ({ ...row })).sort((a, b) => `${a.agent_id}${a.status}`.localeCompare(`${b.agent_id}${b.status}`)),
      [
        { agent_id: "0xa", status: "landed", rule: "", n: 1 },
        { agent_id: "0xa", status: "rejected", rule: "grant-too-wide", n: 1 },
        { agent_id: "0xb", status: "rejected", rule: "grant-too-wide", n: 1 },
      ],
    );
  } finally {
    db.close();
  }
});

describe("collectFleetSnapshot: what the log prints and the heartbeat publishes", () => {
  const NOW = 1_800_000_000;
  const SPAWN_MS = (NOW - 600) * 1000;
  const FRESH = "0x00000000000000000000000000000000000000a1";
  const STALE = "0x00000000000000000000000000000000000000b2";
  const PAPER = "0x00000000000000000000000000000000000000c3";
  const EXPIRED = "0x00000000000000000000000000000000000000d4";

  function fleet(): DatabaseSync {
    const raw = new DatabaseSync(":memory:");
    raw.exec(`CREATE TABLE agents (smart_account TEXT PRIMARY KEY, name TEXT, status TEXT NOT NULL,
                mode TEXT, beat_at INTEGER, live_blocker TEXT)`);
    raw.exec(`CREATE TABLE trades (agent_id TEXT NOT NULL, status TEXT NOT NULL, reject_rule TEXT, created_at INTEGER NOT NULL)`);
    raw.exec(`CREATE TABLE decisions (source TEXT NOT NULL, action TEXT, hold_kind TEXT, at INTEGER NOT NULL)`);
    const agent = raw.prepare("INSERT INTO agents (smart_account, name, status, mode, beat_at, live_blocker) VALUES (?, ?, ?, ?, ?, ?)");
    // Written mixed-case, as the ledger may hold it.
    agent.run(FRESH.toUpperCase().replace("0X", "0x"), "Fresh", "armed", "live", NOW - 30, null);
    // The mirror kept its last mode and beat across the respawn and copied the blocker over as NULL.
    agent.run(STALE, "Stale", "armed", "live", NOW - 900, null);
    agent.run(PAPER, "Paper", "armed", "paper", NOW - 30, "no-cash");
    agent.run(EXPIRED, "Gone", "expired", "live", NOW - 86_400, null);
    const trade = raw.prepare("INSERT INTO trades (agent_id, status, reject_rule, created_at) VALUES (?, ?, ?, ?)");
    trade.run(PAPER, "rejected", "no-exit", NOW - 60);
    trade.run(PAPER, "paper", null, NOW - 60);
    trade.run(FRESH, "rejected", "gas-absurd", NOW - 60);
    trade.run(FRESH, "landed", null, NOW - 60);
    trade.run(FRESH, "rejected", "rollout-hold", NOW - 60);
    trade.run(FRESH, "landed", null, NOW - 3 * 3600);
    const decision = raw.prepare("INSERT INTO decisions (source, action, hold_kind, at) VALUES (?, ?, ?, ?)");
    decision.run("market-review-private", "hold", null, NOW - 60);
    decision.run("brain", "hold", "MODEL_HOLD", NOW - 60);
    return raw;
  }

  const spawned = new Map([
    [FRESH, SPAWN_MS],
    [STALE, SPAWN_MS],
    [PAPER, SPAWN_MS],
  ]);

  it("counts live only what has beaten since its spawn, and splits the funnel by rail", async () => {
    const raw = fleet();
    try {
      const s = await collectFleetSnapshot(wrapSqlite(raw), { nowSec: NOW, spawnedAt: spawned, longWindow: true });
      assert.deepEqual(s.byStatus, { armed: 3, expired: 1 });
      assert.equal(s.total, 4);
      assert.equal(s.rails!.live, 1);
      assert.deepEqual(s.rails!.counts, { live: 1, paper: 1, "unknown (respawning)": 1, "no worker here": 1 });
      assert.deepEqual(
        [s.funnel!.live.proposals, s.funnel!.live.execRefused, s.funnel!.live.landed],
        [2, 1, 1],
        "the gas refusal and the fill are the live rail's",
      );
      assert.deepEqual([s.funnel!.paper.proposals, s.funnel!.paper.wallRefused, s.funnel!.paper.paperFills], [2, 1, 1]);
      assert.equal(s.funnel!.admissionHeld, 1);
      assert.equal(s.funnel6h!.live.landed, 2, "the longer window sees the older fill");
      assert.deepEqual(
        s.holds!.map((h) => [h.kind, Number(h.n)]).sort(),
        [["MODEL_HOLD", 1], ["QUIET_REVIEW", 1]],
      );
    } finally {
      raw.close();
    }
  });

  it("the log's prefixes are unchanged: fleet:, BROKEN, fleet| rails, autonomy| 1h and its refusals", async () => {
    const raw = fleet();
    try {
      raw.prepare("INSERT INTO agents (smart_account, name, status) VALUES (?, ?, ?)").run(
        "0x00000000000000000000000000000000000000e5",
        "Broken",
        "error",
      );
      const lines = fleetHealthLines(await collectFleetSnapshot(wrapSqlite(raw), { nowSec: NOW, spawnedAt: spawned }));
      // In the order the grouped count returned them, as before.
      assert.equal(lines[0], "fleet: 5 agent(s) — armed 3, error 1, expired 1 — BROKEN 1");
      assert.equal(lines[1], "fleet| rails — live 1, paper 1, unknown (respawning) 1, no worker here 2");
      assert.match(lines[2]!, /^autonomy\| 1h — 1 live · proposals 4 · admission-held 1 · policy-passed 3 · userops 1 · LANDED 1 · failed 0 · grant-too-wide 0 · holds 1 model, 0 gate-forced, 0 stale-mark, 1 quiet-review, 0 unreported$/);
      assert.match(lines[3]!, /^autonomy\| 1h live-rail — /);
      assert.match(lines[4]!, /^autonomy\| 1h paper-rail — /);
      assert.equal(lines[5], "autonomy| 1h refusals — gas-absurd 1 [exec] · no-exit 1 [wall]");
      assert.equal(lines.length, 6);
    } finally {
      raw.close();
    }
  });

  it("no BROKEN word when nothing is broken, and a failed funnel read prints no autonomy line rather than zeros", async () => {
    const raw = new DatabaseSync(":memory:");
    try {
      raw.exec(`CREATE TABLE agents (smart_account TEXT PRIMARY KEY, status TEXT NOT NULL, mode TEXT, beat_at INTEGER, live_blocker TEXT)`);
      raw.prepare("INSERT INTO agents (smart_account, status, mode, beat_at) VALUES (?, ?, ?, ?)").run(FRESH, "armed", "live", NOW - 30);
      const s = await collectFleetSnapshot(wrapSqlite(raw), { nowSec: NOW, spawnedAt: spawned });
      assert.equal(s.funnel, null, "no trades table: unread, not zero");
      assert.deepEqual(fleetHealthLines(s), ["fleet: 1 agent(s) — armed 1", "fleet| rails — live 1"]);
    } finally {
      raw.close();
    }
  });
});

describe("the heartbeat's place in orchestrator.ts", () => {
  const SRC = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "orchestrator.ts"), "utf8");
  const AST = ts.createSourceFile("orchestrator.ts", SRC, ts.ScriptTarget.Latest, true);

  it("is started once, never awaited, at the top of the main loop: so it beats halted or not", () => {
    const calls: ts.CallExpression[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "startFleetHeartbeat") calls.push(n);
      ts.forEachChild(n, visit);
    };
    visit(AST);
    assert.equal(calls.length, 1, "one call site");
    const stmt = calls[0]!.parent;
    assert.ok(ts.isExpressionStatement(stmt), "a bare statement: no await, nothing that waits on it");
    const body = stmt.parent;
    assert.ok(ts.isBlock(body) && ts.isForStatement(body.parent), "directly in the main loop's body");
    const halt = body.statements.find(
      (s) => ts.isIfStatement(s) && s.expression.getText() === "haltRequested()",
    );
    assert.ok(halt, "beside the halt branch");
    assert.ok(body.statements.indexOf(stmt) < body.statements.indexOf(halt!), "before it, so neither branch can skip a beat");
  });

  it("ticks the clock that holds the minute and the latch, around the one writer that creates the table", () => {
    // heartbeatClock's own tests drive the minute, the latch, create-until-
    // first-success and the failure line; this pins that the orchestrator's
    // beat goes through that clock and nowhere else.
    const start = AST.statements.find(
      (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "startFleetHeartbeat",
    );
    assert.match(start!.body!.getText(), /\bvoid fleetHeartbeat\.tick\(\)/);
    assert.doesNotMatch(start!.body!.getText(), /writeOrchestratorHeartbeat/, "never written past the clock");
    const decl = AST.statements
      .filter(ts.isVariableStatement)
      .flatMap((s) => [...s.declarationList.declarations])
      .find((d) => ts.isIdentifier(d.name) && d.name.text === "fleetHeartbeat");
    const init = decl?.initializer?.getText() ?? "";
    assert.match(init, /^heartbeatClock\(/);
    assert.match(init, /\bbeat: writeOrchestratorHeartbeat\b/);
    assert.match(init, /\bmayCreate: true\b/);
  });

  it("childEnv strips the ops token: it opens the heartbeat, and a child has no use for it", () => {
    const saved = process.env.MERRYMEN_OPS_TOKEN;
    process.env.MERRYMEN_OPS_TOKEN = "ops-token-never-to-a-child-0123456789abcdef";
    try {
      assert.equal(childEnv("0xABCDef0000000000000000000000000000000001").MERRYMEN_OPS_TOKEN, undefined);
    } finally {
      if (saved === undefined) delete process.env.MERRYMEN_OPS_TOKEN;
      else process.env.MERRYMEN_OPS_TOKEN = saved;
    }
  });
});

describe("one orchestrator beat: what the row says about this process", () => {
  const NOW = Math.floor(Date.now() / 1000);
  const A = "0x00000000000000000000000000000000000000a1";

  /** A home of its own, so FLEET_HALT here is nobody else's, and a database the beat is pointed at. */
  async function withBeat(fleet: (raw: DatabaseSync) => void, run: (raw: DatabaseSync) => Promise<void>) {
    const saved = { home: process.env.MERRYMEN_HOME, sha: process.env.RAILWAY_GIT_COMMIT_SHA, rollout: process.env.MERRYMEN_FLEET_ROLLOUT };
    const home = mkdtempSync(path.join(tmpdir(), "mm-orch-beat-"));
    const raw = new DatabaseSync(":memory:");
    process.env.MERRYMEN_HOME = home;
    process.env.RAILWAY_GIT_COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
    process.env.MERRYMEN_FLEET_ROLLOUT = "none";
    try {
      fleet(raw);
      setFleetHeartbeatDbForTest(wrapSqlite(raw));
      await run(raw);
    } finally {
      setFleetHeartbeatDbForTest(null);
      raw.close();
      rmSync(home, { recursive: true, force: true });
      if (saved.home === undefined) delete process.env.MERRYMEN_HOME;
      else process.env.MERRYMEN_HOME = saved.home;
      if (saved.sha === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
      else process.env.RAILWAY_GIT_COMMIT_SHA = saved.sha;
      if (saved.rollout === undefined) delete process.env.MERRYMEN_FLEET_ROLLOUT;
      else process.env.MERRYMEN_FLEET_ROLLOUT = saved.rollout;
    }
  }

  const fleet = (raw: DatabaseSync) => {
    raw.exec(`CREATE TABLE agents (smart_account TEXT PRIMARY KEY, status TEXT NOT NULL, mode TEXT, beat_at INTEGER, live_blocker TEXT)`);
    raw.exec(`CREATE TABLE trades (agent_id TEXT NOT NULL, status TEXT NOT NULL, reject_rule TEXT, created_at INTEGER NOT NULL)`);
    raw.exec(`CREATE TABLE decisions (source TEXT NOT NULL, action TEXT, hold_kind TEXT, at INTEGER NOT NULL)`);
    raw.prepare("INSERT INTO agents (smart_account, status, mode, beat_at) VALUES (?, ?, ?, ?)").run(A, "armed", "live", NOW - 30);
    raw.prepare("INSERT INTO trades (agent_id, status, reject_rule, created_at) VALUES (?, ?, ?, ?)").run(A, "rejected", "no-gas", NOW - 60);
  };

  it("halted is the FLEET_HALT file as it is at the beat: present, then gone", async () => {
    await withBeat(fleet, async (raw) => {
      writeFileSync(fleetHaltFile(), "halt\n", { mode: 0o600 });
      assert.equal(await writeOrchestratorHeartbeatForTest(true), true);
      let [h] = await readFleetHeartbeats(wrapSqlite(raw), NOW + 1);
      assert.equal(h!.role, "orchestrator");
      assert.equal(h!.halted, true);
      assert.equal(h!.commit, "0123456789abcdef0123456789abcdef01234567");
      assert.deepEqual(h!.rollout, { scope: "none", levels: {} }, "the rollout's scope, with no levels before a reconcile has counted");
      const c = h!.counts as Record<string, any>;
      assert.equal(c.agents, 1);
      assert.deepEqual([c.children, c.holders], [0, 0], "this replica runs nothing for anyone here");
      assert.equal(c.funnel1h.live.execRefused, 1, "it publishes the funnel the log prints");

      rmSync(fleetHaltFile());
      assert.equal(await writeOrchestratorHeartbeatForTest(false), true, "the table is there: a bare upsert");
      [h] = await readFleetHeartbeats(wrapSqlite(raw), NOW + 1);
      assert.equal(h!.halted, false);
    });
  });

  it("a fleet it cannot read is still a beat: counts null, the row written", async () => {
    // No agents table at all: the snapshot's first read throws.
    await withBeat(() => {}, async (raw) => {
      assert.equal(await writeOrchestratorHeartbeatForTest(true), true);
      const [h] = await readFleetHeartbeats(wrapSqlite(raw), NOW + 1);
      assert.equal(h!.role, "orchestrator");
      assert.equal(h!.counts, null, "unread, never zeros");
      assert.equal(h!.halted, false);
      assert.ok(h!.beatAt >= NOW, "and it beat now");
    });
  });

  it("a write that fails reaches the clock, which says so — it is never taken here for a beat", async () => {
    await withBeat(fleet, async () => {
      // Not allowed to create the table, and it is not there: skipped, not written.
      assert.equal(await writeOrchestratorHeartbeatForTest(false), false);
    });
    const failing = {
      prepare() {
        throw new Error("disk I/O error");
      },
      async exec() {
        throw new Error("disk I/O error");
      },
    };
    setFleetHeartbeatDbForTest(failing as never);
    try {
      await assert.rejects(writeOrchestratorHeartbeatForTest(true), /disk I\/O error/);
    } finally {
      setFleetHeartbeatDbForTest(null);
    }
  });
});
