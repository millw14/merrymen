/**
 * Actual PostgreSQL verification, opt-in with MERRYMEN_TEST_POSTGRES_URL.
 * Uses a unique schema and two independent pools to exercise cross-replica
 * locks. Never reads DATABASE_URL or permits a non-loopback database host.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getActionSelector } from "@zerodev/sdk";
import { buildWallPolicies, derivationOf, type StoredGrant } from "@merrymen/core";
import { makePgDb } from "../../../worker/src/db";
import { partnerGrantDigest } from "../../../packages/core/src/partner-enrollment";
import { SqlPartnerStore, PartnerStoreError, PARTNER_HISTORY_EXCHANGES, type PartnerConnection } from "./partner-store";
import { createPartnerEnrollmentService, type PartnerEnrollmentDependencies } from "./partner-enrollment";
import { createPartnerService } from "./partner-service";
import type { PartnerPrincipal } from "./partner-bridge";
import type { PartnerRuntime } from "./partner-runtime";

const url = process.env.MERRYMEN_TEST_POSTGRES_URL;
const A = `0x${"aa".repeat(20)}` as const;
const B = `0x${"bb".repeat(20)}` as const;
const SCOPES = ["read:agents", "chat:agents"];
const secret = () => "isolated-postgres-test-secret-at-least-32-chars";
function barrier() {
  let resolve!: () => void;
  return { promise: new Promise<void>(r => { resolve = r; }), release: () => resolve() };
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const ACCOUNT = "0x1111111111111111111111111111111111111111" as const;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v)).toString("base64");

/** A real owner-signed embedded activation (as partner-enrollment.test.ts builds one) over the given store. */
function enrollment(store: SqlPartnerStore, overrides: Partial<PartnerEnrollmentDependencies> = {}) {
  const owner = privateKeyToAccount(generatePrivateKey());
  const sessionKey = generatePrivateKey();
  const seconds = Math.floor(Date.now() / 1000);
  const caps = { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 7, maxDrawdownPct: 5, maxOpsPerDay: 24 };
  const wall = buildWallPolicies({ caps, smartAccount: ACCOUNT, now: seconds });
  const grant: StoredGrant = {
    owner: owner.address, smartAccount: ACCOUNT, sessionKeyAddress: privateKeyToAccount(sessionKey).address,
    demoSessionPrivateKey: sessionKey, caps, grantedAt: seconds, expiresAt: wall.expiresAt, chainId: 4663, grantFeatures: ["tradeable-v2"],
    serialized: encode({
      privateKey: sessionKey, accountParams: { accountAddress: ACCOUNT, initCode: "0x1234" },
      permissionParams: { policies: wall.policies.map(policy => ({ policyParams: policy.policyParams })) },
      enableSignature: `0x${"12".repeat(65)}`, action: { selector: getActionSelector("0.7"), address: "0x0000000000000000000000000000000000000000" },
      validityData: { validAfter: 0, validUntil: 0 }, isPreInstalled: false,
    }),
  };
  const events: string[] = [];
  const grants = new Map<string, StoredGrant>();
  const service = createPartnerEnrollmentService({
    store, secret: secret, now: Date.now, derive: async () => derivationOf(ACCOUNT),
    grants: { get: async t => grants.get(t) ?? null, tenantForAccount: async () => null, put: async (t, g) => { events.push("grant"); grants.set(t, g); } },
    settings: { get: async () => null, put: async () => { events.push("settings"); } },
    identities: { ensure: async (tenant, account) => ({ tenant, slug: "0000000000000001", accounts: [account], createdAt: seconds, updatedAt: seconds }) },
    ...overrides,
  });
  const settings = { name: "Robin", strategy: "steady-basket" as const, basket_symbols: ["QQQ"], live_trading_enabled: false };
  const sign = async (principal: PartnerPrincipal, connection: PartnerConnection) => {
    const challenge = await service.challenge(principal, connection, {
      owner: grant.owner, smart_account: grant.smartAccount, chain_id: grant.chainId, grant_hash: partnerGrantDigest(grant), settings,
    });
    return { grant, challenge_token: challenge.challenge_token, signature: await owner.signMessage({ message: challenge.message }) };
  };
  return { service, owner: owner.address.toLowerCase() as `0x${string}`, events, sign };
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

    await t.test("concurrent reconnects after a disconnect mint one fresh authorization; the revoked row stays revoked", async () => {
      const original = await first.create(create("reconnect"));
      await first.bind(original.token!, A, SCOPES);
      await first.appendExchange(original.connection.id, { requestId: "old-turn", message: "private", reply: "history" });
      assert.equal(await second.revoke("reconnect", original.connection.id), true);
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? first : second).create(create("reconnect"))));
      assert.equal(results.filter(r => r.created).length, 1);
      assert.equal(new Set(results.map(r => r.connection.id)).size, 1);
      assert.equal(new Set(results.map(r => r.token)).size, 1);
      const fresh = results[0].connection;
      assert.notEqual(fresh.id, original.connection.id);
      assert.equal(fresh.status, "pending");
      assert.deepEqual(await second.readMessages(fresh.id), []);
      assert.equal((await second.byId("reconnect", original.connection.id))?.status, "revoked");
      await assert.rejects(first.bindAuthorized(original.connection.id, "reconnect", A, SCOPES),
        (e: unknown) => e instanceof PartnerStoreError && e.code === "connection_revoked");
      // The existing UNIQUE (partner_id, external_user_id) is untouched: the retired
      // row only gave up its slot, and its record still names the real user.
      const rows = await databases[0].prepare("SELECT id, external_user_id, status, record_json FROM partner_connections WHERE partner_id = ? ORDER BY id").all("reconnect") as Array<{ id: string; external_user_id: string; status: string; record_json: string }>;
      const retired = rows.find(r => r.id === original.connection.id)!;
      assert.equal(retired.external_user_id, `\u001fretired:${original.connection.id}`);
      assert.equal(JSON.parse(retired.record_json).externalUserId, "user-1");
      assert.equal(rows.find(r => r.id === fresh.id)!.external_user_id, "user-1");
      // The same wallet can consent again through the new connection only.
      assert.equal((await second.bind(results[0].token!, A, SCOPES)).id, fresh.id);
      assert.equal((await first.byTenant("reconnect", A))?.id, fresh.id);
    });

    await t.test("list orders by creation time, then id, reading createdAt from the stored record", async () => {
      let now = 1_800_000_000;
      const clocked = new SqlPartnerStore(async () => databases[0], "postgres", () => now, secret);
      const made: string[] = [];
      for (let n = 0; n < 6; n++) {
        made.push((await clocked.create(create("ordered", `user-${n}`))).connection.id);
        now += 1;
      }
      const twins = [(await clocked.create(create("ordered", "twin-a"))).connection.id, (await clocked.create(create("ordered", "twin-b"))).connection.id].sort();
      assert.deepEqual((await second.list("ordered")).map(c => c.id), [...made, ...twins]);
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

    await t.test("another replica waits for a held conversation, then sees the reply it saved", async () => {
      const pending = await first.create(create("conversation-lock"));
      await first.bind(pending.token!, A, SCOPES);
      const entered = barrier(), release = barrier();
      const order: string[] = [];
      const holder = first.withConversationLock(pending.connection.id, async () => {
        entered.release();
        await release.promise;
        assert.equal((await first.byId("conversation-lock", pending.connection.id))?.status, "linked");
        return first.appendExchange(pending.connection.id, { requestId: "request-one", message: "hello", reply: "hello back" });
      });
      await entered.promise;
      const waiter = second.withConversationLock(pending.connection.id, async () => {
        order.push("waiter runs");
        return second.appendExchange(pending.connection.id, { requestId: "request-one", message: "hello", reply: "new answer discarded" });
      });
      await delay(300);
      order.push("holder releases");
      release.release();
      assert.equal((await holder).created, true);
      const retry = await waiter;
      assert.deepEqual(order, ["holder releases", "waiter runs"], "the second replica waited instead of failing");
      assert.equal(retry.created, false);
      assert.equal(retry.exchange.reply, "hello back");
      assert.equal((await first.readMessages(pending.connection.id)).length, 2);
    });

    await t.test("past its bound a waiter answers busy with a retry hint, having run nothing", async () => {
      const pending = await first.create(create("conversation-busy"));
      const impatient = new SqlPartnerStore(async () => databases[1], "postgres", undefined, secret, { conversation: 150, enrollment: 150 });
      for (const kind of ["conversation", "enrollment"] as const) {
        const entered = barrier(), release = barrier();
        const take = (store: SqlPartnerStore, fn: () => Promise<unknown>) =>
          kind === "conversation" ? store.withConversationLock(pending.connection.id, fn) : store.withEnrollmentLock(A, fn);
        const holder = take(first, async () => { entered.release(); await release.promise; });
        await entered.promise;
        let ran = false;
        try {
          await assert.rejects(take(impatient, async () => { ran = true; }),
            (e: unknown) => e instanceof PartnerStoreError && e.status === 409 && e.code === `${kind}_busy` && e.retryAfter! > 0);
        } finally { release.release(); }
        await holder;
        assert.equal(ran, false);
        await take(impatient, async () => { ran = true; });
        assert.equal(ran, true, "the lock is free again once its holder is done");
      }
    });

    await t.test("writes under a lock commit on their own; a failed holder releases the lock", async () => {
      // The lock pins a connection, not a transaction: nothing stays open
      // through a model call, and a nonce spent under the enrollment lock is
      // not rolled back by a failure after it. Chat's only write is its last.
      const pending = await first.create(create("own-commits"));
      await first.bind(pending.token!, A, SCOPES);
      await assert.rejects(first.withConversationLock(pending.connection.id, async () => {
        await first.appendExchange(pending.connection.id, { requestId: "saved-first", message: "hello", reply: "committed" });
        assert.equal((await second.getExchange(pending.connection.id, "saved-first"))?.reply, "committed", "visible to another replica while the lock is held");
        throw new Error("deliberate failure after the write");
      }), /deliberate failure/);
      assert.equal((await second.getExchange(pending.connection.id, "saved-first"))?.reply, "committed");
      const nonce = `enrollment:${randomBytes(24).toString("hex")}`;
      await assert.rejects(first.withEnrollmentLock(A, async () => {
        assert.equal(await first.consumeNonce(nonce, Math.floor(Date.now() / 1000) + 60), true);
        throw new Error("deliberate enrollment failure");
      }), /deliberate enrollment failure/);
      assert.equal(await second.consumeNonce(nonce, Math.floor(Date.now() / 1000) + 60), false, "a spent nonce stays spent");
      await second.withConversationLock(pending.connection.id, async () => {
        await second.appendExchange(pending.connection.id, { requestId: "after-failure", message: "hello", reply: "committed" });
      });
    });

    await t.test("more holders than pool connections finish: nested statements reuse the lock's connection", async () => {
      // pg pools ten connections. If a holder's own reads or writes asked the
      // pool for a second one, ten holders would wait on each other for ever.
      const ids = await Promise.all(Array.from({ length: 12 }, async (_, i) => {
        const pending = await first.create(create("pool", `user-${i}`));
        await first.bind(pending.token!, `0x${(i + 1).toString(16).padStart(40, "0")}`, SCOPES);
        return pending.connection.id;
      }));
      let inside = 0;
      const tenHeld = barrier();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const results = await Promise.race([Promise.all(ids.map(id => first.withConversationLock(id, async () => {
        if (++inside === 10) tenHeld.release();
        await tenHeld.promise;
        assert.equal((await first.byId("pool", id))?.status, "linked");
        return (await first.appendExchange(id, { requestId: "pool-turn", message: "hello", reply: "hi" })).created;
      }))), new Promise<"deadlocked">(resolve => { timer = setTimeout(() => resolve("deadlocked"), 15_000); })]).finally(() => clearTimeout(timer));
      assert.notEqual(results, "deadlocked", "lock holders waited on the pool for a second connection");
      assert.ok((results as boolean[]).every(Boolean));
    });

    await t.test("enrollment locks serialize wallet ownership across replicas", async () => {
      const pending = await first.create(create("enrollment"));
      const other = await second.create(create("enrollment", "user-2"));
      const entered = barrier(), release = barrier();
      const holder = first.withEnrollmentLock(A, async () => {
        entered.release();
        await release.promise;
        return first.bindAuthorized(pending.connection.id, "enrollment", A, SCOPES);
      });
      await entered.promise;
      const waiter = second.withEnrollmentLock(A, async () => {
        // The lock exists so this read sees the owner the first activation bound.
        const owner = await second.byTenant("enrollment", A);
        return owner ? `already linked to ${owner.id}` : (await second.bindAuthorized(other.connection.id, "enrollment", A, SCOPES)).id;
      });
      await delay(300);
      release.release();
      assert.equal((await holder).tenant, A);
      assert.equal(await waiter, `already linked to ${pending.connection.id}`);
    });

    const appPrincipal = (app_id: string): PartnerPrincipal => ({ app_id, key_id: "abcdefghjkmn", name: "Test app", scopes: ["read:agents", "write:agents", "chat:agents"] });

    await t.test("a chat retry sent to another replica mid-generation waits and returns the saved reply", async () => {
      const pending = await first.create(create("chat-retry"));
      await first.bind(pending.token!, A, SCOPES);
      let started!: () => void, finish!: () => void;
      const generating = new Promise<void>(resolve => { started = resolve; });
      const finished = new Promise<void>(resolve => { finish = resolve; });
      let generated = 0;
      const runtime = { status: "running" } as PartnerRuntime;
      const [one, two] = [first, second].map(store => createPartnerService({ store, readRuntime: async () => runtime,
        reply: async () => { generated++; started(); await finished; return { reply: "The one answer.", generation: "model" as const, runtime }; } }));
      const path = `/agents/${pending.connection.id}/messages`, body = JSON.stringify({ message: "status?", request_id: "request_retry_1" });
      const original = one.dispatch(appPrincipal("chat-retry"), "POST", path, body);
      await generating;
      const retry = two.dispatch(appPrincipal("chat-retry"), "POST", path, body);
      await delay(300);
      finish();
      const [answered, retried] = await Promise.all([original, retry]);
      assert.equal(answered.status, 200);
      assert.deepEqual(retried, answered, "the retry waited and answered with the first request's saved reply");
      assert.equal(generated, 1);
    });

    await t.test("an activation contended across replicas never spends the owner's signature", async () => {
      const principal = appPrincipal("enroll-race");
      const impatient = new SqlPartnerStore(async () => databases[1], "postgres", undefined, secret, { conversation: 150, enrollment: 150 });
      const pending = await first.create(create(principal.app_id));
      const e = enrollment(impatient);
      const activation = await e.sign(principal, pending.connection);
      const entered = barrier(), release = barrier();
      // Another activation for the same owner, still running on the other replica past the wait.
      const holder = first.withEnrollmentLock(e.owner, async () => { entered.release(); await release.promise; });
      await entered.promise;
      try {
        await assert.rejects(e.service.activate(principal, pending.connection, activation),
          (error: unknown) => error instanceof PartnerStoreError && error.code === "enrollment_busy" && error.retryAfter! > 0);
      } finally { release.release(); }
      await holder;
      assert.deepEqual(e.events, []);
      const done = await e.service.activate(principal, pending.connection, activation);
      assert.equal(done.connection.tenant, e.owner);
      assert.equal((await first.byTenant(principal.app_id, e.owner))?.id, pending.connection.id);
      // A lost response: the same authorization is answered from the recorded proof, writing nothing.
      const applied = [...e.events];
      const again = await e.service.activate(principal, pending.connection, activation);
      assert.equal(again.replayed, true);
      assert.deepEqual(again.connection, done.connection);
      assert.deepEqual(e.events, applied);
    });

    await t.test("a failure after the nonce is spent under the lock does not reopen the signed token", async () => {
      const principal = appPrincipal("enroll-failure");
      const pending = await first.create(create(principal.app_id));
      const e = enrollment(second, { identities: { ensure: async () => { throw new Error("private storage failure"); } } });
      const activation = await e.sign(principal, pending.connection);
      const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
      await assert.rejects(e.service.activate(principal, pending.connection, activation), code("enrollment_storage_failed"));
      await assert.rejects(e.service.activate(principal, pending.connection, activation), code("challenge_used"));
      assert.equal((await first.byId(principal.app_id, pending.connection.id))?.status, "pending");
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
