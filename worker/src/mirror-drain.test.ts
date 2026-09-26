/**
 * drainTenant: the kill switch's last mirror, run until nothing is left behind.
 *
 * mirrorTenant copies at most one batch per table per call, and a stood-down
 * child has no next pass. drainTenant repeats it until no cursored table has
 * a row past its cursor. It must also stop, not spin, when a table can never
 * move, and name what it left behind.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { wrapSqlite } from "./db";
import { drainTenant, MIRROR_STATE_DDL } from "./ledger-mirror";
import { applyLedgerSchema } from "./store";

const ACCOUNT = "0x00000000000000000000000000000000000000c3";

async function ledgers() {
  const childRaw = new DatabaseSync(":memory:");
  const child = wrapSqlite(childRaw);
  await applyLedgerSchema(child);
  const sharedRaw = new DatabaseSync(":memory:");
  const shared = wrapSqlite(sharedRaw);
  await applyLedgerSchema(shared);
  await shared.exec(MIRROR_STATE_DDL);
  return { childRaw, child, sharedRaw, shared };
}

const n = (raw: DatabaseSync, sql: string) => Number((raw.prepare(sql).get() as { n: number }).n);

test("drains a backlog in rounds of one batch until every cursored table is caught up", async () => {
  const l = await ledgers();
  const ev = l.childRaw.prepare(`INSERT INTO events (agent_id, level, message) VALUES (?, 'ok', ?)`);
  for (let i = 0; i < 250; i++) ev.run(ACCOUNT, `e${i}`);
  const de = l.childRaw.prepare(`INSERT INTO decisions (id, agent_id, source, action, reason, at) VALUES (?, ?, 'strategy:momentum', 'hold', 'wait', ?)`);
  for (let i = 0; i < 240; i++) de.run(`d${i}`, ACCOUNT, 1_700_000_000 + i * 10);

  const r = await drainTenant({ tenant: "0xt", child: l.child, shared: l.shared, batch: 100 });

  assert.deepEqual(r.behind, []);
  assert.equal(r.failed, undefined);
  assert.equal(n(l.sharedRaw, "SELECT COUNT(*) AS n FROM events"), 250);
  assert.equal(n(l.sharedRaw, "SELECT COUNT(*) AS n FROM decisions"), 240);
  assert.ok(r.rounds >= 3, `a 250-row table takes three rounds of 100 (took ${r.rounds})`);
  assert.equal(r.copied.events, 250, "row counts add up across rounds");
});

test("a table that can never move is named and the drain stops, rather than spinning", async () => {
  const l = await ledgers();
  const ev = l.childRaw.prepare(`INSERT INTO events (agent_id, level, message) VALUES (?, 'ok', ?)`);
  for (let i = 0; i < 250; i++) ev.run(ACCOUNT, `e${i}`);
  const po = l.childRaw.prepare(`INSERT INTO posts (agent_id, decision_id, body) VALUES (?, ?, 'gm')`);
  for (let i = 0; i < 30; i++) po.run(ACCOUNT, `p${i}`);
  // Every copy of `posts` fails, every round.
  await l.shared.exec("DROP TABLE posts");

  const r = await drainTenant({ tenant: "0xt", child: l.child, shared: l.shared, batch: 100 });

  assert.equal(n(l.sharedRaw, "SELECT COUNT(*) AS n FROM events"), 250, "the tables that can move are still drained");
  assert.deepEqual(r.behind, ["posts"]);
  assert.ok(r.failed?.posts, "and the reason is reported");
  assert.ok(r.rounds <= 5, `it stopped once no cursor moved (took ${r.rounds} rounds)`);
});

test("a rebuilt child (the cursor rewinds on the first round) is still drained to the end", async () => {
  // A redeploy rebuilds the child ledger at id 1 under a cursor that outlived
  // it. The first round rewinds that cursor to 0 and copies a batch, so the
  // cursor ends LOWER than it began. That round made progress.
  const l = await ledgers();
  await l.shared
    .prepare(`INSERT INTO mirror_state (tenant, table_name, last_id, last_stamp, updated_at) VALUES ('0xt', 'events', 4000, 123, 0)`)
    .run();
  const ev = l.childRaw.prepare(`INSERT INTO events (agent_id, level, message) VALUES (?, 'ok', ?)`);
  for (let i = 0; i < 250; i++) ev.run(ACCOUNT, `e${i}`);

  const r = await drainTenant({ tenant: "0xt", child: l.child, shared: l.shared, batch: 100 });

  assert.ok(r.restarted?.events, "the cursor was rewound");
  assert.equal(n(l.sharedRaw, "SELECT COUNT(*) AS n FROM events"), 250);
  assert.deepEqual(r.behind, []);
});

test("an empty ledger takes one round", async () => {
  const l = await ledgers();
  const r = await drainTenant({ tenant: "0xt", child: l.child, shared: l.shared });
  assert.equal(r.rounds, 1);
  assert.deepEqual(r.behind, []);
});
