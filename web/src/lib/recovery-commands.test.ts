import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { wrapSqlite, type Db } from "../../../worker/src/db";
import { FLEET_RECOVERY_SCHEMA, recordFleetRecoveryHold, recordFleetSourceVerified,
  withFleetRecoveryLock } from "../../../worker/src/fleet-recovery";
import { queueRecoveryCheckedCommand } from "./recovery-commands";

const agent = `0x${"b".repeat(40)}`, other = `0x${"c".repeat(40)}`;
const scope = { tenant: `0x${"a".repeat(40)}`, smartAccount: agent, chainId: 4663 };
const at = 1_800_000_000;
const command = (id: string, kind: "selftest" | "paper-reset" = "paper-reset", account = agent, time = at * 1000) =>
  ({ id, agent: account, kind, at: time });
const fixture = () => {
  const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw);
  raw.exec(`CREATE TABLE agent_commands(id TEXT PRIMARY KEY,agent_id TEXT,kind TEXT,created_at INTEGER,
    claimed_at INTEGER,done_at INTEGER,result TEXT);`);
  return { raw, db };
};

test("held resets and probes are refused before insert; other accounts remain independent", async () => {
  const { raw, db } = fixture();
  try {
    await recordFleetRecoveryHold(db, scope, "source-continuity", at, () => true);
    for (const kind of ["paper-reset", "selftest"] as const) {
      assert.deepEqual(await queueRecoveryCheckedCommand(db, command(`held-${kind}`, kind)), { ok: false, why: "recovery" });
      assert.deepEqual(await queueRecoveryCheckedCommand(db, command(`other-${kind}`, kind, other)), { ok: true });
    }
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM agent_commands WHERE agent_id=?").get(agent)!.n, 0);
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM agent_commands WHERE agent_id=?").get(other)!.n, 2);
  } finally { raw.close(); }
});

test("release never admits pre-boundary or equal-boundary requests, including a request delayed in a lock queue", async () => {
  const { raw, db } = fixture();
  try {
    await recordFleetRecoveryHold(db, scope, "source-barrier", at, () => true);
    await recordFleetSourceVerified(db, scope, at + 10, () => true);
    const cutoff = (at + 11) * 1000;
    for (const kind of ["paper-reset", "selftest"] as const) {
      for (const time of [at * 1000, cutoff]) {
        assert.deepEqual(await queueRecoveryCheckedCommand(db, command(`old-${kind}-${time}`, kind, agent, time)),
          { ok: false, why: "recovery" });
      }
      assert.deepEqual(await queueRecoveryCheckedCommand(db, command(`fresh-${kind}`, kind, agent, cutoff + 1)), { ok: true });
    }
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(r => { entered = r; }), go = new Promise<void>(r => { release = r; });
    const lock = withFleetRecoveryLock(db, agent, async locked => {
      entered(); await go;
      await locked.prepare("UPDATE fleet_recovery_health SET held=1,checked_at=? WHERE smart_account=?").run(at + 20, agent);
    });
    await held;
    const queued = queueRecoveryCheckedCommand(db, command("delayed", "selftest", agent, cutoff + 1));
    release(); await lock;
    assert.deepEqual(await queued, { ok: false, why: "recovery" });
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM agent_commands WHERE id='delayed'").get()!.n, 0);
  } finally { raw.close(); }
});

test("older deployments can admit after the missing optional table read without creating schema", async () => {
  const { raw, db } = fixture();
  try {
    assert.deepEqual(await queueRecoveryCheckedCommand(db, command("legacy", "selftest")), { ok: true });
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='fleet_recovery_health'").get()!.n, 0);
    assert.deepEqual(raw.prepare("SELECT claimed_at,done_at,result FROM agent_commands").get(),
      Object.assign(Object.create(null), { claimed_at: null, done_at: null, result: null }));
  } finally { raw.close(); }
});

test("unreadable recovery metadata, failed insert and missing database cannot report queued", async () => {
  const { raw, db } = fixture();
  try {
    await db.exec(FLEET_RECOVERY_SCHEMA);
    raw.prepare("INSERT INTO fleet_recovery_health VALUES(?,?,?,0,'source-continuity',?,?)").run(scope.tenant, agent, 4663, at, -1);
    assert.deepEqual(await queueRecoveryCheckedCommand(db, command("bad-state")), { ok: false, why: "unreachable" });
    raw.exec("DROP TABLE fleet_recovery_health");
    const broken: Db = { prepare: sql => db.prepare(sql), exec: sql => db.exec(sql), tx: async () => { throw new Error("private failure"); } };
    assert.deepEqual(await queueRecoveryCheckedCommand(broken, command("failed-insert")), { ok: false, why: "unreachable" });
    assert.deepEqual(await queueRecoveryCheckedCommand(null, command("absent")), { ok: false, why: "unreachable" });
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM agent_commands").get()!.n, 0);
  } finally { raw.close(); }
});

test("invalid command kinds, IDs, timestamps and accounts refuse without any database work", async () => {
  let touched = false;
  const unavailable: Db = {
    prepare: () => { touched = true; throw new Error("must not read"); },
    exec: async () => { touched = true; }, tx: async () => { touched = true; throw new Error("must not write"); },
  };
  for (const bad of [{ ...command("id"), id: "../foreign" }, { ...command("id"), kind: "trade" },
    { ...command("id"), at: Number.NaN }, { ...command("id"), at: 0 }, { ...command("id"), agent: "foreign" }]) {
    assert.deepEqual(await queueRecoveryCheckedCommand(unavailable, bad as Parameters<typeof queueRecoveryCheckedCommand>[1]),
      { ok: false, why: "unreachable" });
  }
  assert.equal(touched, false);
});

test("the existing Start over kill ordering survives a recovery refusal", async () => {
  // Static route linkage complements the real helper tests: no Next server,
  // grant cache, signing key or real ledger is initialized by this test.
  const start = readFileSync(new URL("./start-over.ts", import.meta.url), "utf8");
  const selftest = readFileSync(new URL("../app/api/selftest/route.ts", import.meta.url), "utf8");
  const reset = readFileSync(new URL("../app/api/paper-reset/route.ts", import.meta.url), "utf8");
  assert.ok(start.indexOf("await deps.remove()") < start.indexOf("await deps.queueReset(account)"));
  assert.match(start, /queueRecoveryCheckedCommand\(db, \{ id, agent, kind: "paper-reset"/);
  assert.match(selftest, /queueRecoveryCheckedCommand\(db,/);
  assert.doesNotMatch(start + selftest, /INSERT INTO agent_commands/);
  assert.match(reset, /queued\.status \?\? 503/);
});
