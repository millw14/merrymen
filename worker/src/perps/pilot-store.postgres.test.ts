/** Real independent-pool locking; disposable LOCAL PostgreSQL only. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { makePgDb } from "../db";
import { SqlPerpsPilotStore } from "./pilot-store";

const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;
const NOW = 1_900_000_000_000;
const owner = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const;
const ADMIN = owner(999);
interface Client {
  connect(): Promise<void>; end(): Promise<void>;
  query(sql: string, args?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

test("Postgres: pilot bootstrap, capacity, invite receipts and revocation serialize across replicas", { skip: !url, timeout: 60_000 }, async t => {
  const target = new URL(url!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "only disposable LOCAL PostgreSQL is allowed");
  const pg = createRequire(import.meta.url)("pg") as { Client: new (args: { connectionString: string }) => Client };
  const admin = new pg.Client({ connectionString: target.toString() });
  await admin.connect();
  const schema = `mm_pilot_store_${randomBytes(8).toString("hex")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const scoped = (name: string) => {
    const value = new URL(target);
    value.searchParams.set("options", `-c search_path=${schema}`);
    value.searchParams.set("application_name", name);
    return value.toString();
  };
  const a = await makePgDb(scoped("pilot-store-a")), b = await makePgDb(scoped("pilot-store-b"));
  const stores = (bootstrap = "") => [a, b].map(db => new SqlPerpsPilotStore(db, { bootstrapOwners: () => bootstrap, now: () => NOW }));
  const reset = async () => {
    await a.exec(`DELETE FROM perps_pilot_redemptions; DELETE FROM perps_pilot_invites;
      DELETE FROM perps_pilot_admissions; DELETE FROM perps_pilot_attempts; DELETE FROM perps_pilot_audit;
      UPDATE perps_pilot_cohort SET initialized_at=NULL,bootstrap_digest=NULL,revision=0 WHERE id=1;`);
  };
  const invite = (store: SqlPerpsPilotStore, maxUses = 1) => store.createInvite({ actor: ADMIN, maxUses, expiresAt: NOW + 60_000 });
  try {
    await t.test("concurrent first boots create one schema and one authoritative bootstrap, ignoring later environment changes", async () => {
      const first = new SqlPerpsPilotStore(a, { bootstrapOwners: () => owner(1), now: () => NOW });
      const second = new SqlPerpsPilotStore(b, { bootstrapOwners: () => owner(2), now: () => NOW });
      const results = await Promise.all([first.snapshot(), second.snapshot()]);
      assert.deepEqual(results[0], results[1]);
      assert.equal(results[0]!.owners.length, 1);
      assert.equal(results[0]!.revision, 1);
      assert.ok([owner(1), owner(2)].includes(results[0]!.owners[0]!));
      assert.equal((await a.prepare("SELECT count(*) AS n FROM perps_pilot_audit WHERE action='bootstrap'").get() as { n: number }).n, 1);
      assert.deepEqual(await new SqlPerpsPilotStore(a, { bootstrapOwners: () => "malformed later configuration" }).snapshot(), results[0]);
    });
    await t.test("independent pools cannot overspend an invite or duplicate a redeemed owner's receipt", async () => {
      await reset(); const [first, second] = stores(); const generated = await invite(first!, 3);
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? first! : second!).redeem({ owner: owner(i + 1), code: generated.code })));
      assert.equal(results.filter(r => r.outcome === "admitted").length, 3);
      assert.equal((await first!.snapshot()).owners.length, 3);
      assert.equal((await first!.list()).invites[0]!.uses, 3);
      assert.equal((await a.prepare("SELECT count(*) AS n FROM perps_pilot_redemptions").get() as { n: number }).n, 3);
      const admitted = (await first!.snapshot()).owners[0]!;
      const replay = await Promise.all([first!.redeem({ owner: admitted, code: generated.code }), second!.redeem({ owner: admitted, code: generated.code })]);
      assert.ok(replay.every(r => r.outcome === "already-admitted"));
      assert.equal((await first!.list()).invites[0]!.uses, 3);
    });
    await t.test("two different invites racing for the final cohort place cannot create 101 active owners", async () => {
      await reset();
      const [first, second] = stores(Array.from({ length: 99 }, (_, i) => owner(i + 1)).join(","));
      const one = await invite(first!), two = await invite(second!);
      const results = await Promise.all([first!.redeem({ owner: owner(200), code: one.code }), second!.redeem({ owner: owner(201), code: two.code })]);
      assert.deepEqual(results.map(r => r.outcome).sort(), ["admitted", "full"]);
      const listing = await first!.list();
      assert.equal(listing.admissions.filter(row => row.status === "allowed").length, 100);
      assert.equal(listing.invites.reduce((n, i) => n + i.uses, 0), 1);
      assert.equal((await first!.setAdmission({ actor: ADMIN, owner: owner(202), status: "allowed", expectedRevision: listing.revision })).outcome, "full");
    });
    await t.test("durable revoke defeats another invite and a stale admin approval; fresh approval is explicit", async () => {
      await reset(); const [first, second] = stores(owner(1));
      const code = (await invite(first!)).code, prior = (await first!.snapshot()).revision;
      const revoked = await second!.setAdmission({ actor: ADMIN, owner: owner(1), status: "revoked", expectedRevision: prior });
      assert.equal(revoked.outcome, "updated");
      assert.equal((await first!.redeem({ owner: owner(1), code })).outcome, "revoked");
      assert.equal((await first!.setAdmission({ actor: ADMIN, owner: owner(1), status: "allowed", expectedRevision: prior })).outcome, "stale");
      assert.deepEqual((await new SqlPerpsPilotStore(a, { bootstrapOwners: () => owner(1) }).snapshot()).owners, []);
      assert.equal((await first!.setAdmission({ actor: ADMIN, owner: owner(1), status: "allowed", expectedRevision: revoked.revision })).outcome, "updated");
      assert.equal((await second!.get(owner(1))).status, "allowed");
    });
    await t.test("the owner attempt budget is shared across pools and failed guesses commit it", async () => {
      await reset(); const [first, second] = stores();
      const generated = await invite(first!);
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? first! : second!).redeem({ owner: owner(1), code: "wrong" })));
      assert.equal(results.filter(r => r.outcome === "invalid-invite").length, 10);
      assert.equal(results.filter(r => r.outcome === "limited").length, 2);
      assert.equal((await second!.redeem({ owner: owner(1), code: generated.code })).outcome, "limited");
      assert.equal((await first!.redeem({ owner: owner(2), code: generated.code })).outcome, "admitted");
    });
    await t.test("a final protected write and revocation serialize across replicas; failed callbacks release the lock", async () => {
      await reset(); const [first, second] = stores(owner(1));
      const prior = await first!.snapshot();
      await second!.snapshot();
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      const ordering: string[] = [];
      const write = first!.withAdmission(owner(1), async () => {
        enter(); await wait; ordering.push("write"); return "saved";
      });
      await entered;
      const revoke = second!.setAdmission({ actor: ADMIN, owner: owner(1), status: "revoked", expectedRevision: prior.revision })
        .then(value => { ordering.push("revoke"); return value; });
      try {
        await delay(40);
        assert.deepEqual(ordering, [], "revocation cannot commit through a running protected write");
      } finally { release(); }
      assert.deepEqual(await write, { allowed: true, value: "saved" });
      assert.equal((await revoke).outcome, "updated");
      assert.deepEqual(ordering, ["write", "revoke"]);
      assert.deepEqual(await first!.withAdmission(owner(1), async () => assert.fail("a committed revoke must win")), { allowed: false });
      const revoked = await first!.snapshot();
      await second!.setAdmission({ actor: ADMIN, owner: owner(1), status: "allowed", expectedRevision: revoked.revision });
      const restored = await first!.snapshot();
      await assert.rejects(first!.withAdmission(owner(1), async () => { throw new Error("protected write failed"); }), /protected write failed/);
      assert.deepEqual(await second!.snapshot(), restored, "failed callback leaves no pilot revision or membership change");
      assert.equal((await second!.setAdmission({ actor: ADMIN, owner: owner(1), status: "revoked", expectedRevision: restored.revision })).outcome, "updated");
    });
    await t.test("a contended mutation times out and rolls back while bounded snapshots remain readable", async () => {
      await reset(); const [first] = stores(); const snapshot = await first!.snapshot();
      const blocker = new pg.Client({ connectionString: scoped("pilot-store-lock-holder") });
      await blocker.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query("UPDATE perps_pilot_cohort SET revision=revision WHERE id=1");
        assert.deepEqual(await first!.snapshot(), snapshot);
        const started = Date.now();
        await assert.rejects(first!.setAdmission({ actor: ADMIN, owner: owner(1), status: "allowed", expectedRevision: snapshot.revision }), error => (error as { code?: string }).code === "55P03");
        assert.ok(Date.now() - started < 3500, "the singleton wait is bounded by transaction-local lock_timeout");
      } finally { await blocker.query("ROLLBACK"); await blocker.end(); }
      assert.deepEqual(await first!.snapshot(), snapshot);
      assert.equal((await first!.list()).audit.length, 1, "no partial approval or audit escaped the timeout");
    });
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
