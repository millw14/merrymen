import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  FilePartnerStore, getPartnerStore, ONBOARDING_TTL_SECONDS, PARTNER_HISTORY_EXCHANGES,
  PartnerStoreError, type PartnerCreate,
} from "./partner-store";

const A = "0x00000000000000000000000000000000000000a1" as const;
const B = "0x00000000000000000000000000000000000000b2" as const;
const SECRET = "test-only-partner-bridge-secret-32-or-more-characters";
const fixtures: Array<{ store: FilePartnerStore; home: string }> = [];
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "merrymen-partner-store-"));
  let now = 1_800_000_000;
  const store = new FilePartnerStore(home, () => now, () => SECRET);
  fixtures.push({ store, home });
  return { store, home, advance: (seconds: number) => { now += seconds; } };
}
const input = (externalUserId = "user-1", partnerId = "partner-a"): PartnerCreate => ({
  partnerId, partnerName: "Partner A", externalUserId, name: "Robin", scopes: ["read:agent", "chat:agent"],
});
/**
 * Windows releases a WAL database's -shm mapping ASYNCHRONOUSLY. node:sqlite's
 * close() returns while SQLite is still clearing PARTNER-CONNECTIONS.SQLITE-SHM.tmp,
 * so an rmSync at its default maxRetries of 0 reads the directory, unlinks what it
 * sees, and then rmdir's into ENOTEMPTY. It only loses that race on a loaded
 * machine, which is why this file passed alone and failed in the full suite.
 * Retrying is what maxRetries is for. Close every store before removing anything
 * and keep going past a failure: aborting the loop on the first stuck directory
 * left every later fixture's database handle open for the life of the process.
 */
after(() => {
  const failures: unknown[] = [];
  const attempt = (fn: () => void) => { try { fn(); } catch (error) { failures.push(error); } };
  for (const { store } of fixtures) attempt(() => store.close());
  for (const { home } of fixtures) attempt(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  if (failures.length) throw failures[0];
});

test("concurrent creates produce one connection and recover the same onboarding token", async () => {
  const { store, home } = fixture();
  const results = await Promise.all(Array.from({ length: 12 }, () => store.create(input())));
  assert.equal(results.filter(r => r.created).length, 1);
  assert.equal(new Set(results.map(r => r.connection.id)).size, 1);
  assert.equal(new Set(results.map(r => r.token)).size, 1);
  assert.ok(results[0].token);
  assert.equal((await store.list("partner-a")).length, 1);
  assert.equal((await store.byToken(results[0].token!))?.externalUserId, "user-1");
  const raw = Buffer.concat([readFileSync(join(home, "partner-connections.sqlite")), readFileSync(join(home, "partner-connections.sqlite-wal"))]).toString();
  assert.ok(!raw.includes(results[0].token!), "authorization token is never written to disk");
  assert.ok(!raw.includes(SECRET), "the signing secret is never written to disk");
});

test("partner namespace isolates external ids, lookup, list, and revocation", async () => {
  const { store } = fixture();
  const first = await store.create(input());
  const second = await store.create(input("user-1", "partner-b"));
  assert.notEqual(first.connection.id, second.connection.id);
  assert.equal(await store.byId("partner-b", first.connection.id), null);
  assert.equal(await store.revoke("partner-b", first.connection.id), false);
  assert.deepEqual((await store.list("partner-b")).map(c => c.id), [second.connection.id]);
  assert.equal((await store.byToken(first.token!))?.status, "pending");
});

test("token binding is single-use even with concurrent different tenants", async () => {
  const { store } = fixture();
  const created = await store.create(input());
  const outcomes = await Promise.allSettled([
    store.bind(created.token!, A, ["chat:agent"]),
    store.bind(created.token!, B, ["chat:agent"]),
  ]);
  assert.equal(outcomes.filter(o => o.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(o => o.status === "rejected").length, 1);
  const linked = await store.byId("partner-a", created.connection.id);
  assert.equal(linked?.tenant, A);
  assert.deepEqual(linked?.scopes, ["chat:agent"]);
  assert.equal(linked?.tokenHash, null);
  assert.equal(await store.byToken(created.token!), null);
  assert.equal((await store.create(input())).token, null, "retry never reopens completed consent");
});

test("one partner cannot map the same tenant to competing external users", async () => {
  const { store } = fixture();
  const [first, second] = await Promise.all([store.create(input()), store.create(input("other-user"))]);
  const results = await Promise.allSettled([
    store.bind(first.token!, A, ["read:agent"]), store.bind(second.token!, A, ["read:agent"]),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const failed = results.find(r => r.status === "rejected") as PromiseRejectedResult;
  assert.ok(failed.reason instanceof PartnerStoreError);
  assert.equal(failed.reason.code, "wallet_already_linked");
  assert.equal((await store.byToken(second.token!))?.status, "pending", "failed bind is rolled back, not consumed");
  const elsewhere = await store.create(input("same-owner", "partner-b"));
  assert.equal((await store.bind(elsewhere.token!, A, ["read:agent"])).tenant, A);
});

test("expiry refuses stale tokens and only explicit create refreshes the pending authorization", async () => {
  const { store, advance } = fixture();
  const original = await store.create(input());
  advance(ONBOARDING_TTL_SECONDS);
  assert.equal(await store.byToken(original.token!), null);
  await assert.rejects(store.bind(original.token!, A, ["read:agent"]), (e: unknown) => e instanceof PartnerStoreError && e.status === 410);
  const refreshed = await store.create(input());
  assert.equal(refreshed.created, false);
  assert.equal(refreshed.connection.id, original.connection.id);
  assert.notEqual(refreshed.token, original.token);
  assert.equal(await store.byToken(original.token!), null);
  assert.equal((await store.bind(refreshed.token!, A, ["read:agent"])).status, "linked");
});

test("consent cannot escalate scopes and only the actual owner can revoke", async () => {
  const { store } = fixture();
  const pending = await store.create(input());
  await assert.rejects(store.bind(pending.token!, A, ["trade:agent"]), (e: unknown) => e instanceof PartnerStoreError && e.code === "invalid_scopes");
  await store.bind(pending.token!, A, ["read:agent"]);
  assert.equal(await store.revokeByTenant(pending.connection.id, B), false);
  assert.equal((await store.byId("partner-a", pending.connection.id))?.status, "linked");
  assert.equal(await store.revokeByTenant(pending.connection.id, A), true);
  assert.equal((await store.byId("partner-a", pending.connection.id))?.status, "revoked");
  assert.equal((await store.create(input())).token, null, "a create retry does not silently undo revocation");
  await assert.rejects(store.appendExchange(pending.connection.id, { requestId: "r1", message: "hello", reply: "hello" }), /not active/);
});

test("embedded proof binding scopes the connection to its partner and is idempotent for its owner", async () => {
  const { store } = fixture();
  const pending = await store.create(input());
  await assert.rejects(store.bindAuthorized(pending.connection.id, "partner-b", A, ["chat:agent"]),
    (e: unknown) => e instanceof PartnerStoreError && e.status === 404);
  assert.equal((await store.byId("partner-a", pending.connection.id))?.status, "pending");
  const linked = await store.bindAuthorized(pending.connection.id, "partner-a", A, ["chat:agent"]);
  assert.equal(linked.tenant, A);
  assert.deepEqual(await store.bindAuthorized(pending.connection.id, "partner-a", A, ["chat:agent"]), linked);
  await assert.rejects(store.bindAuthorized(pending.connection.id, "partner-a", B, ["chat:agent"]), /different owner/);
  await assert.rejects(store.bindAuthorized(pending.connection.id, "partner-a", A, ["read:agent", "chat:agent"]), /different owner or consent/);
  assert.equal(await store.byToken(pending.token!), null);
});

test("embedded binding cannot bypass per-partner wallet uniqueness or revive revocation", async () => {
  const { store } = fixture();
  const first = await store.create(input());
  const second = await store.create(input("user-2"));
  await store.bindAuthorized(first.connection.id, "partner-a", A, ["chat:agent"]);
  await assert.rejects(store.bindAuthorized(second.connection.id, "partner-a", A, ["chat:agent"]),
    (e: unknown) => e instanceof PartnerStoreError && e.code === "wallet_already_linked");
  await store.revoke("partner-a", first.connection.id);
  await assert.rejects(store.bindAuthorized(first.connection.id, "partner-a", A, ["chat:agent"]),
    (e: unknown) => e instanceof PartnerStoreError && e.code === "connection_revoked");
  assert.equal((await store.byId("partner-a", second.connection.id))?.status, "pending");
});

test("enrollment lock lets the later activation see the owner claimed by the first", async () => {
  const { store } = fixture();
  const first = await store.create(input());
  const second = await store.create(input("user-2"));
  let runtimeWrites = 0;
  const activate = (id: string) => store.withEnrollmentLock(A, async () => {
    if (await store.byTenant("partner-a", A)) return "already linked";
    runtimeWrites++;
    await Promise.resolve();
    await store.bindAuthorized(id, "partner-a", A, ["chat:agent"]);
    return "activated";
  });
  assert.deepEqual(await Promise.all([activate(first.connection.id), activate(second.connection.id)]), ["activated", "already linked"]);
  assert.equal(runtimeWrites, 1);
  assert.equal((await store.byTenant("partner-a", A))?.id, first.connection.id);
  assert.equal(await store.byTenant("partner-b", A), null);
  assert.equal(await store.byTenant("partner-a", B), null);
});

test("bridge nonce consumption is atomic, expiry checked, and raw nonces not persisted", async () => {
  const { store } = fixture();
  const nonce = "random-request-nonce-at-least-16";
  const claims = await Promise.all(Array.from({ length: 20 }, () => store.consumeNonce(nonce, 1_800_000_060)));
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await store.consumeNonce("different-nonce-is-expired", 1_800_000_000), false);
  assert.equal(await store.consumeNonce("bad", 1_800_000_060), false);
});

test("chat exchanges are idempotent and preserve order when clocks and request ids do not", async () => {
  const { store } = fixture();
  const pending = await store.create(input());
  await store.bind(pending.token!, A, ["chat:agent"]);
  const id = pending.connection.id;
  const first = await store.appendExchange(id, { requestId: "z", message: "hello\nthere", reply: "First reply." });
  const replay = await store.appendExchange(id, { requestId: "z", message: "hello\nthere", reply: "different result" });
  assert.equal(replay.created, false);
  assert.deepEqual(replay.exchange, first.exchange);
  await assert.rejects(store.appendExchange(id, { requestId: "z", message: "changed", reply: "x" }), /different message/);
  await store.appendExchange(id, { requestId: "a", message: "next", reply: "Second reply.", command: { id: "open-settings", args: {} } });
  assert.deepEqual((await store.readMessages(id)).map(m => m.content), ["hello\nthere", "First reply.", "next", "Second reply."]);
  assert.deepEqual(await store.getExchange(id, "z"), first.exchange);
  assert.equal(await store.getExchange("other-agent", "z"), null);
});

test("conversation writes remain bounded and do not evict the newest same-second exchange", async () => {
  const { store } = fixture();
  const pending = await store.create(input());
  await store.bind(pending.token!, A, ["chat:agent"]);
  for (let n = 0; n < PARTNER_HISTORY_EXCHANGES + 3; n++) {
    await store.appendExchange(pending.connection.id, { requestId: String(100 - n), message: `message ${n}`, reply: `reply ${n}` });
  }
  const messages = await store.readMessages(pending.connection.id);
  assert.equal(messages.length, PARTNER_HISTORY_EXCHANGES * 2);
  assert.equal(messages[0].content, "message 3");
  assert.equal(messages.at(-1)?.content, `reply ${PARTNER_HISTORY_EXCHANGES + 2}`);
  assert.equal(await store.getExchange(pending.connection.id, "100"), null);
});

test("conversation lock serializes turns and releases after failure", async () => {
  const { store } = fixture();
  const seen: string[] = [];
  const outcomes = await Promise.allSettled([
    store.withConversationLock("connection", async () => { seen.push("first starts"); await Promise.resolve(); seen.push("first ends"); throw new Error("provider failed"); }),
    store.withConversationLock("connection", async () => { seen.push("second starts"); }),
  ]);
  assert.equal(outcomes[0].status, "rejected");
  assert.equal(outcomes[1].status, "fulfilled");
  assert.deepEqual(seen, ["first starts", "first ends", "second starts"]);
});

test("records and history survive store reopen", async () => {
  const { store, home } = fixture();
  const pending = await store.create(input());
  await store.bind(pending.token!, A, ["chat:agent"]);
  await store.appendExchange(pending.connection.id, { requestId: "persist", message: "remember", reply: "saved" });
  const second = new FilePartnerStore(home, () => 1_800_000_001, () => SECRET);
  try {
    assert.equal((await second.byId("partner-a", pending.connection.id))?.tenant, A);
    assert.equal((await second.readMessages(pending.connection.id))[1].content, "saved");
  } finally { second.close(); }
});

test("hosted deployment fails closed without a shared database", () => {
  const saved = { MERRYMEN_HOSTED: process.env.MERRYMEN_HOSTED, DATABASE_URL: process.env.DATABASE_URL, MERRYMEN_HOME: process.env.MERRYMEN_HOME };
  // This is the one test that reaches getPartnerStore(), and the branch it does NOT
  // take opens a database at merrymenHome(). Point that at a disposable directory so
  // a regression in the guard can never write into the developer's real ~/.merrymen.
  const home = mkdtempSync(join(tmpdir(), "merrymen-partner-hosted-"));
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_HOSTED = "true";
  delete process.env.DATABASE_URL;
  try { assert.throws(() => getPartnerStore(), /require DATABASE_URL/); }
  finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
