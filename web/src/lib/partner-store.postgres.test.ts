/**
 * Actual PostgreSQL verification, opt-in with MERRYMEN_TEST_POSTGRES_URL.
 * Uses a unique schema and two independent pools to exercise cross-replica
 * locks. Never reads DATABASE_URL or permits a non-loopback database host.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { makePgDb } from "../../../worker/src/db";
import { SqlPartnerStore, PartnerStoreError, PARTNER_HISTORY_EXCHANGES } from "./partner-store";

const url = process.env.MERRYMEN_TEST_POSTGRES_URL;
const A = `0x${"aa".repeat(20)}` as const;
const B = `0x${"bb".repeat(20)}` as const;
const SCOPES = ["read:agents", "chat:agents"];
const secret = () => "isolated-postgres-test-secret-at-least-32-chars";
function barrier() {
  let resolve!: () => void;
  return { promise: new Promise<void>(r => { resolve = r; }), release: () => resolve() };
}

test("PostgreSQL partner store: real transactions and independent-replica locks", { skip: !url, timeout: 60_000 }, async t => {
  const target = new URL(url!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "Only an explicit disposable local PostgreSQL instance is allowed");
  const admin = await makePgDb(target.toString());
  const schema = `mm_partner_test_${randomBytes(8).toString("hex")}`;
  assert.match(schema, /^mm_partner_test_[a-f0-9]{16}$/);
  await admin.exec(`CREATE SCHEMA ${schema}`);
  try {
    const databases = await Promise.all([1, 2].map(async replica => {
      const scoped = new URL(target);
      scoped.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000`);
      scoped.searchParams.set("application_name", `merrymen-partner-test-${replica}`);
      const db = await makePgDb(scoped.toString());
      assert.equal((await db.prepare("SELECT current_schema() AS schema").get() as { schema: string }).schema, schema);
      return db;
    }));
    const [first, second] = databases.map(db => new SqlPartnerStore(async () => db, "postgres", undefined, secret));
    const create = (partnerId: string, externalUserId = "user-1") => ({ partnerId, partnerName: "Test app", externalUserId, name: "Robin", scopes: SCOPES });

    await t.test("concurrent first create across replicas mints one id and one recoverable token", async () => {
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? first : second).create(create("create-race"))));
      assert.equal(results.filter(r => r.created).length, 1);
      assert.equal(new Set(results.map(r => r.connection.id)).size, 1);
      assert.equal(new Set(results.map(r => r.token)).size, 1);
      assert.equal((await second.list("create-race")).length, 1);
      assert.equal(await second.byId("different-app", results[0].connection.id), null);
    });

    await t.test("one-time consent and unique owner binding hold under concurrent transactions", async () => {
      const pending = await first.create(create("bind-race"));
      const results = await Promise.allSettled([
        first.bind(pending.token!, A, SCOPES), second.bind(pending.token!, B, SCOPES),
      ]);
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
      assert.equal(results.filter(r => r.status === "rejected").length, 1);
      assert.equal(await second.byToken(pending.token!), null);
      const linked = await second.byId("bind-race", pending.connection.id);
      const other = await second.create(create("bind-race", "another-user"));
      await assert.rejects(first.bind(other.token!, linked!.tenant!, SCOPES),
        (e: unknown) => e instanceof PartnerStoreError && e.code === "wallet_already_linked");
      assert.equal((await first.byToken(other.token!))?.status, "pending", "failed unique update rolls back token consumption");
    });

    await t.test("nonce insert row count identifies exactly one winner", async () => {
      const nonce = `nonce_${randomBytes(16).toString("hex")}`;
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? first : second).consumeNonce(nonce, Math.floor(Date.now() / 1000) + 60)));
      assert.equal(results.filter(Boolean).length, 1);
    });

    await t.test("conversation lock rejects another replica and nested appends use its pinned transaction", async () => {
      const pending = await first.create(create("conversation-lock"));
      await first.bind(pending.token!, A, SCOPES);
      const entered = barrier(), release = barrier();
      const holder = first.withConversationLock(pending.connection.id, async () => {
        entered.release();
        await release.promise;
        assert.equal((await first.byId("conversation-lock", pending.connection.id))?.status, "linked");
        return first.appendExchange(pending.connection.id, { requestId: "request-one", message: "hello", reply: "hello back" });
      });
      await entered.promise;
      try {
        await assert.rejects(second.withConversationLock(pending.connection.id, async () => "should not run"),
          (e: unknown) => e instanceof PartnerStoreError && e.code === "conversation_busy");
      } finally { release.release(); }
      assert.equal((await holder).created, true);
      assert.equal((await second.getExchange(pending.connection.id, "request-one"))?.reply, "hello back");
      await second.withConversationLock(pending.connection.id, async () => {
        const retry = await second.appendExchange(pending.connection.id, { requestId: "request-one", message: "hello", reply: "new answer discarded" });
        assert.equal(retry.created, false);
        assert.equal(retry.exchange.reply, "hello back");
      });
      assert.equal((await first.readMessages(pending.connection.id)).length, 2);
    });

    await t.test("failed conversation work rolls back writes and releases the advisory lock", async () => {
      const pending = await first.create(create("rollback"));
      await first.bind(pending.token!, A, SCOPES);
      await assert.rejects(first.withConversationLock(pending.connection.id, async () => {
        await first.appendExchange(pending.connection.id, { requestId: "rollback-me", message: "hello", reply: "not committed" });
        throw new Error("deliberate test rollback");
      }), /deliberate test rollback/);
      assert.equal(await second.getExchange(pending.connection.id, "rollback-me"), null);
      await second.withConversationLock(pending.connection.id, async () => {
        await second.appendExchange(pending.connection.id, { requestId: "after-rollback", message: "hello", reply: "committed" });
      });
    });

    await t.test("enrollment locks serialize wallet ownership across apps and preserve one transaction", async () => {
      const pending = await first.create(create("enrollment"));
      const entered = barrier(), release = barrier();
      const holder = first.withEnrollmentLock(A, async () => {
        entered.release();
        await release.promise;
        return first.bindAuthorized(pending.connection.id, "enrollment", A, SCOPES);
      });
      await entered.promise;
      try {
        await assert.rejects(second.withEnrollmentLock(A, async () => "should not run"),
          (e: unknown) => e instanceof PartnerStoreError && e.code === "enrollment_busy");
      } finally { release.release(); }
      assert.equal((await holder).tenant, A);
      await second.withEnrollmentLock(A, async () => {
        assert.equal((await second.byTenant("enrollment", A))?.id, pending.connection.id);
      });
    });

    await t.test("revocation during generation prevents the conversation from being committed", async () => {
      const pending = await first.create(create("revoke-race"));
      await first.bind(pending.token!, A, SCOPES);
      const entered = barrier(), release = barrier();
      const holder = first.withConversationLock(pending.connection.id, async () => {
        assert.equal((await first.byId("revoke-race", pending.connection.id))?.status, "linked");
        entered.release();
        await release.promise;
        return first.appendExchange(pending.connection.id, { requestId: "late-answer", message: "hello", reply: "must not persist" });
      });
      await entered.promise;
      assert.equal(await second.revokeByTenant(pending.connection.id, A), true);
      release.release();
      await assert.rejects(holder, (e: unknown) => e instanceof PartnerStoreError && e.code === "connection_inactive");
      assert.equal((await second.readMessages(pending.connection.id)).length, 0);
    });

    await t.test("concurrent appends keep unique ordinals and bounded chronological history", async () => {
      const pending = await first.create(create("history"));
      await first.bind(pending.token!, A, SCOPES);
      await Promise.all(Array.from({ length: PARTNER_HISTORY_EXCHANGES + 4 }, (_, i) => (i % 2 ? first : second).appendExchange(pending.connection.id,
        { requestId: `request-${i}`, message: `question ${i}`, reply: `answer ${i}` })));
      const history = await first.readMessages(pending.connection.id);
      assert.equal(history.length, PARTNER_HISTORY_EXCHANGES * 2);
      const rows = await databases[0].prepare("SELECT ordinal FROM partner_exchanges WHERE connection_id = ? ORDER BY ordinal").all(pending.connection.id) as { ordinal: number }[];
      assert.equal(new Set(rows.map(r => r.ordinal)).size, PARTNER_HISTORY_EXCHANGES);
      assert.equal(rows[0].ordinal, 5);
      assert.equal(rows.at(-1)!.ordinal, PARTNER_HISTORY_EXCHANGES + 4);
      assert.ok(rows.every(r => typeof r.ordinal === "number"), "production int8 coercion must preserve ordinal arithmetic");
    });
  } finally {
    // The generated identifier was checked before creation; only this test's
    // schema is deleted, never public or another deployment's table.
    await admin.exec(`DROP SCHEMA ${schema} CASCADE`);
  }
});
