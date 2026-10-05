import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, it } from "node:test";
import { wrapSqlite, type Db } from "../../../worker/src/db";
import { recordFleetRecoveryHold, recordFleetSourceVerified } from "../../../worker/src/fleet-recovery";
import { placeRecoveryCheckedOrder } from "./recovery-orders";
import { placedResponse } from "./order-state";

const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw);
const tenant = `0x${"a".repeat(40)}`, agent = `0x${"b".repeat(40)}`, other = `0x${"c".repeat(40)}`;
const scope = { tenant, smartAccount: agent, chainId: 4663 }, at = 1_800_000_000;
raw.exec(`CREATE TABLE agent_commands(id TEXT PRIMARY KEY,agent_id TEXT,kind TEXT,args TEXT,created_at INTEGER,claimed_at INTEGER,done_at INTEGER);`);
after(() => raw.close());
const order = (id: string, account = agent, now = at * 1000) => ({ id, agent: account, args: { side: "buy", symbol: "TSLA", usdgAmount: 1 }, now, expiresAt: now + 300_000 });

it("held buy, sell and energy orders are refused before any command is written", async () => {
  await recordFleetRecoveryHold(db, scope, "source-continuity", at, () => true);
  for (const args of [{ side: "buy" }, { side: "sell" }, { side: "buy", purpose: "energy" }]) {
    const o = { ...order("refused"), args };
    const result = await placeRecoveryCheckedOrder(db, o);
    assert.deepEqual(result, { ok: false, why: "recovery" });
    const response = placedResponse(result, { id: o.id, expiresAt: o.expiresAt, now: o.now });
    assert.equal(response.status, 409); assert.match(JSON.stringify(response.body), /No new order was queued/);
  }
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM agent_commands").get()!.n, 0);
});

it("one agent's hold cannot prevent another agent's valid request", async () => {
  assert.deepEqual(await placeRecoveryCheckedOrder(db, order("other", other)), { ok: true });
  assert.equal(raw.prepare("SELECT agent_id FROM agent_commands WHERE id='other'").get()!.agent_id, other);
});

it("release still refuses old intents, then new requests retain normal idempotency", async () => {
  await recordFleetSourceVerified(db, scope, at + 10, () => true);
  assert.deepEqual(await placeRecoveryCheckedOrder(db, order("old")), { ok: false, why: "recovery" });
  assert.deepEqual(await placeRecoveryCheckedOrder(db, order("equal", agent, (at+11)*1000)), {ok:false,why:"recovery"});
  const fresh = order("fresh", agent, (at + 11) * 1000 + 1);
  assert.deepEqual(await placeRecoveryCheckedOrder(db, fresh), { ok: true });
  // The existing slot guard remains in force; recovery is not an exception to it.
  assert.deepEqual(await placeRecoveryCheckedOrder(db, fresh), { ok: false, why: "in-flight" });
});

it("unreadable recovery state never reports queued", async () => {
  const unavailable: Db = { ...db, exec: s => db.exec(s), prepare: s => db.prepare(s), tx: async () => { throw new Error("offline"); } };
  assert.deepEqual(await placeRecoveryCheckedOrder(unavailable, order("lost", agent, (at + 100) * 1000)), { ok: false, why: "unreachable" });
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM agent_commands WHERE id='lost'").get()!.n, 0);
});
