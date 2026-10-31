import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { wrapSqlite, type Db } from "../db";
import { getPerpsPilotStore, PERPS_PILOT_INVITE_MAX_TTL_MS, setPerpsPilotStoreForTest, SqlPerpsPilotStore } from "./pilot-store";

const NOW = 1_900_000_000_000;
const owner = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const;
const ADMIN = owner(999);
function fixture(t: TestContext, bootstrap = "") {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  let now = NOW, env = bootstrap;
  const options = { bootstrapOwners: () => env, now: () => now };
  const store = new SqlPerpsPilotStore(db, options);
  t.after(() => raw.close());
  const invite = (maxUses = 2, expiresAt = now + 60_000) => store.createInvite({ actor: ADMIN, maxUses, expiresAt });
  const change = async (who: string, status: "allowed" | "revoked") => store.setAdmission({ actor: ADMIN, owner: who, status, expectedRevision: (await store.snapshot()).revision });
  return { raw, db, store, options, invite, change, clock: (value: number) => { now = value; }, environment: (value: string) => { env = value; } };
}

test("strict environment bootstrap is durable once, including an explicitly empty initial cohort", async t => {
  const f = fixture(t, ` ${owner(1).toUpperCase().replace("0X", "0x")} , ${owner(1)},${owner(2)}`);
  assert.deepEqual(await f.store.snapshot(), { owners: [owner(1), owner(2)], revision: 1 });
  f.environment(owner(3));
  const otherReplica = new SqlPerpsPilotStore(f.db, f.options);
  assert.deepEqual(await otherReplica.snapshot(), await f.store.snapshot());
  assert.equal((await f.store.get(owner(3))).status, "not-admitted");
  assert.equal(f.raw.prepare("SELECT count(*) AS n FROM perps_pilot_audit WHERE action='bootstrap'").get()!.n, 1);
  const empty = fixture(t);
  assert.deepEqual((await empty.store.snapshot()).owners, []);
  empty.environment(owner(8));
  assert.deepEqual((await new SqlPerpsPilotStore(empty.db, empty.options).snapshot()).owners, []);
});

test("invalid or over-cap bootstrap fails closed without committing initialization and can be repaired", async t => {
  for (const raw of ["garbage", owner(0), `${owner(1)},`, Array.from({ length: 101 }, (_, i) => owner(i + 1)).join(",")]) {
    const f = fixture(t, raw);
    await assert.rejects(f.store.snapshot());
    assert.equal(f.raw.prepare("SELECT initialized_at FROM perps_pilot_cohort").get()!.initialized_at, null);
    assert.equal(f.raw.prepare("SELECT count(*) AS n FROM perps_pilot_admissions").get()!.n, 0);
    f.environment(owner(1));
    assert.deepEqual((await f.store.snapshot()).owners, [owner(1)]);
  }
});

test("invite codes have high entropy, canonical encoding, hash-only storage, and private metadata", async t => {
  const f = fixture(t);
  const a = await f.invite(), b = await f.invite();
  assert.match(a.code, /^mmp_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.code, b.code);
  const rows = f.raw.prepare("SELECT * FROM perps_pilot_invites").all();
  assert.equal(rows[0]!.code_hash, createHash("sha256").update(a.code).digest("hex"));
  assert.ok(!JSON.stringify(rows).includes(a.code));
  const listed = JSON.stringify(await f.store.list());
  assert.ok(!listed.includes(a.code));
  assert.ok(!listed.includes(String(rows[0]!.code_hash)));
  assert.ok(!listed.includes("code_hash"));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const alternate = a.code.slice(0, -1) + alphabet[alphabet.indexOf(a.code.at(-1)!) + 1];
  assert.deepEqual(Buffer.from(a.code.slice(4), "base64url"), Buffer.from(alternate.slice(4), "base64url"));
  for (const code of [alternate, ` ${a.code}`, `${a.code}=`, a.code.toUpperCase(), "mmp_short"]) {
    assert.equal((await f.store.redeem({ owner: owner(1), code })).outcome, "invalid-invite");
  }
  assert.equal((await f.store.list()).invites.find(i => i.id === a.invite.id)!.uses, 0);
});

test("redemption atomically consumes one use and replays safely across instances and invite expiry", async t => {
  const f = fixture(t), { code, invite } = await f.invite(1);
  const other = new SqlPerpsPilotStore(f.db, f.options);
  const results = await Promise.all([f.store.redeem({ owner: owner(1), code }), other.redeem({ owner: owner(1), code })]);
  assert.deepEqual(results.map(r => r.outcome).sort(), ["already-pending", "pending"]);
  assert.equal((await f.store.list()).invites[0]!.uses, 1);
  assert.equal(f.raw.prepare("SELECT count(*) AS n FROM perps_pilot_redemptions").get()!.n, 1);
  assert.equal((await f.store.redeem({ owner: owner(2), code })).outcome, "invalid-invite");
  f.clock(invite.expiresAt + 1);
  assert.equal((await other.redeem({ owner: owner(1), code })).outcome, "already-pending");
  assert.deepEqual(await f.store.get(owner(1)), { owner: owner(1), status: "pending", revision: 1, updatedAt: NOW });
});

test("expiry, bounded use counts and invite revocation never grant a new membership", async t => {
  const f = fixture(t), limited = await f.invite(2), expired = await f.invite(1, NOW + 1), revoked = await f.invite();
  assert.deepEqual(await f.store.revokeInvite({ actor: ADMIN, id: revoked.invite.id }), { revoked: true });
  assert.deepEqual(await f.store.revokeInvite({ actor: ADMIN, id: revoked.invite.id }), { revoked: true });
  f.clock(NOW + 1);
  assert.equal((await f.store.redeem({ owner: owner(1), code: expired.code })).outcome, "invalid-invite");
  assert.equal((await f.store.redeem({ owner: owner(1), code: revoked.code })).outcome, "invalid-invite");
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => f.store.redeem({ owner: owner(i + 1), code: limited.code })));
  assert.equal(results.filter(r => r.outcome === "pending").length, 2);
  assert.equal((await f.store.snapshot()).owners.length, 0);
  for (const maxUses of [0, 101, 1.5, NaN]) await assert.rejects(f.store.createInvite({ actor: ADMIN, maxUses, expiresAt: NOW + 60_000 }));
  for (const expiresAt of [NOW, NOW + PERPS_PILOT_INVITE_MAX_TTL_MS + 2, Infinity]) await assert.rejects(f.invite(1, expiresAt));
});

test("explicit wallet revocation beats every invite and changed environment; only a fresh admin decision reallows", async t => {
  const f = fixture(t, owner(1)), first = await f.invite(), second = await f.invite();
  const staleRevision = (await f.store.snapshot()).revision;
  assert.equal((await f.change(owner(1), "revoked")).outcome, "updated");
  f.environment(`${owner(1)},${owner(2)}`);
  const another = new SqlPerpsPilotStore(f.db, f.options);
  for (const code of [first.code, second.code]) assert.equal((await another.redeem({ owner: owner(1), code })).outcome, "revoked");
  assert.deepEqual((await another.snapshot()).owners, []);
  assert.equal((await f.store.setAdmission({ actor: ADMIN, owner: owner(1), status: "allowed", expectedRevision: staleRevision })).outcome, "stale");
  assert.equal((await f.change(owner(1), "allowed")).outcome, "updated");
  assert.deepEqual((await f.store.snapshot()).owners, [owner(1)]);
  assert.equal((await f.store.list()).invites.reduce((sum, i) => sum + i.uses, 0), 0);
  assert.equal((await f.change(owner(99), "revoked")).outcome, "updated", "revoking a never-admitted owner creates a persistent denial");
  assert.equal((await f.store.redeem({ owner: owner(99), code: first.code })).outcome, "revoked");
});

test("pending requests do not occupy admission slots; concurrent admin approvals respect the cohort cap", async t => {
  const f = fixture(t, Array.from({ length: 99 }, (_, i) => owner(i + 1)).join(","));
  const a = await f.invite(), b = await f.invite();
  const other = new SqlPerpsPilotStore(f.db, f.options);
  const pending = await Promise.all([f.store.redeem({ owner: owner(200), code: a.code }), other.redeem({ owner: owner(201), code: b.code })]);
  assert.ok(pending.every(r => r.outcome === "pending"));
  const revision = (await f.store.snapshot()).revision;
  assert.equal((await f.store.snapshot()).owners.length, 99);
  const approvals = await Promise.all([f.store.setAdmission({ actor: ADMIN, owner: owner(200), status: "allowed", expectedRevision: revision }), other.setAdmission({ actor: ADMIN, owner: owner(201), status: "allowed", expectedRevision: revision })]);
  assert.deepEqual(approvals.map(r => r.outcome).sort(), ["stale", "updated"]);
  const remaining = (await f.store.list()).requests[0]!;
  assert.equal((await f.change(remaining.owner, "allowed")).outcome, "full");
  assert.equal((await f.store.snapshot()).owners.length, 100);
  assert.equal((await f.store.list()).invites.reduce((sum, i) => sum + i.uses, 0), 2);
  await f.change(owner(1), "revoked");
  assert.equal((await f.change(remaining.owner, "allowed")).outcome, "updated");
  assert.equal((await f.store.snapshot()).owners.length, 100);
  assert.equal((await f.store.list()).requests.length, 0);
});

test("failed guesses consume a shared owner budget that survives store recreation and leaves other owners independent", async t => {
  const f = fixture(t), invite = await f.invite();
  for (let i = 0; i < 10; i++) assert.equal((await new SqlPerpsPilotStore(f.db, f.options).redeem({ owner: owner(1), code: "bad" })).outcome, "invalid-invite");
  assert.deepEqual(await f.store.redeem({ owner: owner(1), code: invite.code }), { outcome: "limited", revision: 1, retryAfterSec: 60 });
  assert.equal((await f.store.redeem({ owner: owner(2), code: invite.code })).outcome, "pending");
  f.clock(NOW + 60_000);
  const fresh = await f.invite();
  assert.equal((await f.store.redeem({ owner: owner(1), code: fresh.code })).outcome, "pending");
});

function auditFailure(db: Db, action = "request-submitted"): Db {
  return { exec: sql => db.exec(sql), tx: fn => db.tx(tx => fn(auditFailure(tx, action))), prepare(sql) {
    const stmt = db.prepare(sql);
    return { ...stmt, run: async (...args) => {
      if (sql.startsWith("INSERT INTO perps_pilot_audit") && args[1] === action) throw new Error("audit unavailable");
      return stmt.run(...args);
    } };
  } };
}
test("an audit failure rolls back the pending request, invite use and redemption receipt together", async t => {
  const f = fixture(t), { code } = await f.invite();
  const broken = new SqlPerpsPilotStore(auditFailure(f.db), f.options);
  await assert.rejects(broken.redeem({ owner: owner(1), code }), /audit unavailable/);
  assert.deepEqual(await f.store.snapshot(), { owners: [], revision: 1 });
  assert.equal((await f.store.list()).invites[0]!.uses, 0);
  assert.equal((await f.store.list()).requests.length, 0);
  assert.equal(f.raw.prepare("SELECT count(*) AS n FROM perps_pilot_redemptions").get()!.n, 0);
  assert.equal((await f.store.redeem({ owner: owner(1), code })).outcome, "pending");
});

test("an unknown committed submission replays as already pending without consuming another use", async t => {
  const f = fixture(t), { code } = await f.invite();
  let loseReply = false;
  const db: Db = { prepare: sql => f.db.prepare(sql), exec: sql => f.db.exec(sql), tx: async fn => {
    const answer = await f.db.tx(fn);
    if (loseReply) { loseReply = false; throw new Error("commit answer lost"); }
    return answer;
  } };
  const uncertain = new SqlPerpsPilotStore(db, f.options);
  await uncertain.snapshot(); loseReply = true;
  await assert.rejects(uncertain.redeem({ owner: owner(1), code }), /commit answer lost/);
  assert.equal((await f.store.redeem({ owner: owner(1), code })).outcome, "already-pending");
  assert.equal((await f.store.list()).invites[0]!.uses, 1);
});

test("only admin approval prepares entry-off; a failed preparation preserves the pending request", async t => {
  const f = fixture(t), { code } = await f.invite();
  assert.equal((await f.store.redeem({ owner: owner(1), code })).outcome, "pending");
  let calls = 0;
  const fail = async () => { calls++; throw new Error("entry settings cannot be disabled"); };
  const revision = (await f.store.snapshot()).revision;
  await assert.rejects(f.store.setAdmission({ actor: ADMIN, owner: owner(1), status: "allowed", expectedRevision: revision, beforeAdmit: fail }), /cannot be disabled/);
  assert.equal((await f.store.get(owner(1))).status, "pending");
  assert.equal((await f.store.list()).requests.length, 1);
  assert.equal((await f.store.list()).invites[0]!.uses, 1);
  assert.equal((await f.store.snapshot()).revision, revision);
  assert.equal(calls, 1);
  const beforeAdmit = async () => {
    calls++;
    assert.equal(f.raw.prepare("SELECT owner FROM perps_pilot_admissions WHERE owner=?").get(owner(1)), undefined);
    assert.equal(f.raw.prepare("SELECT owner FROM perps_pilot_requests WHERE owner=?").get(owner(1))!.owner, owner(1));
  };
  assert.equal((await f.store.setAdmission({ actor: ADMIN, owner: owner(1), status: "allowed", expectedRevision: revision, beforeAdmit })).outcome, "updated");
  assert.equal(calls, 2);
  assert.equal((await f.store.list()).requests.length, 0);
  assert.equal((await f.store.get(owner(1))).status, "allowed");
  assert.equal((await f.store.redeem({ owner: owner(1), code })).outcome, "already-admitted");
});

test("stale, full and already-admitted admin decisions never invoke admission preparation", async t => {
  const f = fixture(t, Array.from({ length: 100 }, (_, i) => owner(i + 1)).join(","));
  const { code } = await f.invite();
  const revision = (await f.store.snapshot()).revision;
  const beforeAdmit = async () => { assert.fail("no entry settings write is authorized"); };
  assert.equal((await f.store.setAdmission({ actor: ADMIN, owner: owner(1), status: "allowed", expectedRevision: revision, beforeAdmit })).outcome, "unchanged");
  assert.equal((await f.store.setAdmission({ actor: ADMIN, owner: owner(200), status: "allowed", expectedRevision: 0, beforeAdmit })).outcome, "stale");
  assert.equal((await f.store.setAdmission({ actor: ADMIN, owner: owner(200), status: "allowed", expectedRevision: revision, beforeAdmit })).outcome, "full");
  assert.equal((await f.store.redeem({ owner: owner(200), code })).outcome, "pending", "a full admitted cohort can still collect requests");
  assert.equal((await f.store.redeem({ owner: owner(1), code })).outcome, "already-admitted");
  await f.change(owner(1), "revoked");
  assert.equal((await f.store.redeem({ owner: owner(1), code })).outcome, "revoked");
});

test("a pending request grants no authority; expiry and invite revocation do not erase its review history", async t => {
  const f = fixture(t), { code, invite } = await f.invite(1, NOW + 1000);
  const result = await f.store.redeem({ owner: owner(1), code });
  assert.equal(result.outcome, "pending");
  assert.deepEqual(await f.store.snapshot(), { owners: [], revision: 1 });
  assert.deepEqual(await f.store.withAdmission(owner(1), async () => assert.fail("pending is never authority")), { allowed: false });
  f.clock(NOW + 1000);
  await f.store.revokeInvite({ actor: ADMIN, id: invite.id });
  assert.equal((await f.store.redeem({ owner: owner(1), code })).outcome, "already-pending");
  assert.deepEqual((await f.store.list()).requests, [{ owner: owner(1), inviteId: invite.id, submittedAt: NOW }]);
  assert.equal((await f.change(owner(1), "revoked")).outcome, "updated");
  assert.equal((await f.store.get(owner(1))).status, "revoked");
  assert.equal((await f.store.list()).requests.length, 0);
  assert.equal((await f.store.redeem({ owner: owner(1), code })).outcome, "revoked");
});

test("missing storage and corrupt over-cap membership fail closed; factory has only an explicit test seam", async t => {
  const f = fixture(t);
  await f.store.snapshot();
  for (let i = 0; i < 101; i++) f.raw.prepare("INSERT INTO perps_pilot_admissions VALUES(?,'allowed','admin',1,?,?)").run(owner(i + 1), NOW, ADMIN);
  await assert.rejects(f.store.snapshot(), /exceeds/);
  f.raw.exec("DROP TABLE perps_pilot_cohort");
  await assert.rejects(f.store.snapshot());
  const before = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    assert.throws(() => getPerpsPilotStore(), /shared database/);
    setPerpsPilotStoreForTest(f.store);
    assert.equal(getPerpsPilotStore(), f.store);
  } finally {
    setPerpsPilotStoreForTest(null);
    if (before === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = before;
  }
});

test("a cached store revalidates durable initialization evidence on every authorization read", async t => {
  const f = fixture(t, owner(1));
  await f.store.snapshot();
  f.raw.exec("UPDATE perps_pilot_cohort SET initialized_at=-1");
  await assert.rejects(f.store.snapshot(), /Unreadable/);
  await assert.rejects(f.store.get(owner(1)), /Unreadable/);
  await assert.rejects(f.store.withAdmission(owner(1), async () => assert.fail("corrupt admission cannot authorize a write")), /Unreadable/);
  await assert.rejects(f.store.createInvite({ actor: ADMIN, maxUses: 1, expiresAt: NOW + 60_000 }), /Unreadable/);
  f.raw.prepare("UPDATE perps_pilot_cohort SET initialized_at=?").run(NOW);
  assert.deepEqual((await f.store.snapshot()).owners, [owner(1)]);
});

test("final protected writes require current admission and propagate callback failure without changing membership", async t => {
  const f = fixture(t, owner(1));
  const before = await f.store.snapshot();
  let calls = 0;
  assert.deepEqual(await f.store.withAdmission(owner(1), async () => { calls++; return "saved"; }), { allowed: true, value: "saved" });
  await assert.rejects(f.store.withAdmission(owner(1), async () => { calls++; throw new Error("protected write failed"); }), /protected write failed/);
  assert.deepEqual(await f.store.snapshot(), before);
  assert.deepEqual(await f.store.withAdmission(owner(2), async () => assert.fail("unknown owner cannot write")), { allowed: false });
  await f.change(owner(1), "revoked");
  assert.deepEqual(await f.store.withAdmission(owner(1), async () => assert.fail("revoked owner cannot write")), { allowed: false });
  assert.equal(calls, 2);
  await assert.rejects(f.store.withAdmission(owner(0), async () => assert.fail("zero owner cannot write")), /Invalid/);
});

test("a corrupt over-cap cohort refuses protected writes even for a stored admitted owner", async t => {
  const f = fixture(t, owner(1));
  await f.store.snapshot();
  for (let i = 2; i <= 101; i++) f.raw.prepare("INSERT INTO perps_pilot_admissions VALUES(?,'allowed','admin',1,?,?)").run(owner(i), NOW, ADMIN);
  await assert.rejects(f.store.withAdmission(owner(1), async () => assert.fail("over-cap membership cannot write")), /exceeds/);
});

test("the pending queue is bounded independently, and resolving one request frees exactly one place", async t => {
  const f = fixture(t), { code, invite } = await f.invite(2);
  for (let i = 1; i <= 999; i++) f.raw.prepare("INSERT INTO perps_pilot_requests VALUES(?,?,?)").run(owner(i), invite.id, NOW);
  assert.equal((await f.store.redeem({ owner: owner(2000), code })).outcome, "pending");
  assert.equal((await f.store.redeem({ owner: owner(2001), code })).outcome, "full");
  let listing = await f.store.list();
  assert.equal(listing.requestLimit, 1000);
  assert.equal(listing.requests.length, 1000);
  assert.equal(listing.invites[0]!.uses, 1);
  assert.deepEqual((await f.store.snapshot()).owners, []);
  await f.change(owner(1), "revoked");
  assert.equal((await f.store.redeem({ owner: owner(2001), code })).outcome, "pending");
  listing = await f.store.list();
  assert.equal(listing.requests.length, 1000);
  assert.equal(listing.invites[0]!.uses, 2);
});

test("admin audit failure rolls back the approval and preserves its pending request", async t => {
  const f = fixture(t), { code } = await f.invite();
  await f.store.redeem({ owner: owner(1), code });
  const before = await f.store.snapshot();
  const broken = new SqlPerpsPilotStore(auditFailure(f.db, "admission-allowed"), f.options);
  await assert.rejects(broken.setAdmission({ actor: ADMIN, owner: owner(1), status: "allowed", expectedRevision: before.revision, beforeAdmit: async () => {} }), /audit unavailable/);
  assert.deepEqual(await f.store.snapshot(), before);
  assert.equal((await f.store.get(owner(1))).status, "pending");
  assert.equal((await f.store.list()).requests.length, 1);
  assert.equal((await f.store.list()).invites[0]!.uses, 1);
});

test("upgrade quarantines earlier automatic invite admissions while retaining explicit admin and bootstrap authority", async t => {
  const f = fixture(t, owner(1));
  await f.change(owner(2), "allowed");
  const before = await f.store.snapshot();
  f.raw.prepare("INSERT INTO perps_pilot_admissions VALUES(?,'allowed','invite',?,?,?)").run(owner(3), before.revision, NOW, owner(3));
  const upgraded = new SqlPerpsPilotStore(f.db, f.options);
  assert.deepEqual(await upgraded.snapshot(), { owners: [owner(1), owner(2)], revision: before.revision + 1 });
  assert.equal(f.raw.prepare("SELECT status FROM perps_pilot_admissions WHERE owner=?").get(owner(3))!.status, "revoked", "old readers also see a durable denial");
  assert.equal((await upgraded.get(owner(3))).status, "revoked");
  assert.equal((await upgraded.list()).requests.length, 0);
  assert.equal((await upgraded.list()).audit.filter(row => row.action === "legacy-invite-quarantined" && row.owner === owner(3)).length, 1);
  assert.deepEqual(await new SqlPerpsPilotStore(f.db, f.options).snapshot(), await upgraded.snapshot(), "migration is idempotent");
});

test("late legacy writers cannot grant authority after initialization; explicit approval rewrites source and prepares entries off", async t => {
  const f = fixture(t), { code } = await f.invite();
  const before = await f.store.snapshot();
  f.raw.prepare("INSERT INTO perps_pilot_admissions VALUES(?,'allowed','invite',?,?,?)").run(owner(1), before.revision, NOW, owner(1));
  assert.equal((await f.store.get(owner(1))).status, "revoked");
  assert.deepEqual(await f.store.snapshot(), before);
  assert.deepEqual(await f.store.withAdmission(owner(1), async () => assert.fail("an invite source is never authority")), { allowed: false });
  assert.equal((await f.store.redeem({ owner: owner(1), code })).outcome, "revoked");
  assert.equal((await f.store.list()).admissions[0]!.status, "revoked");
  let prepared = 0;
  await assert.rejects(f.store.setAdmission({ actor: ADMIN, owner: owner(1), status: "allowed", expectedRevision: before.revision, beforeAdmit: async () => { prepared++; throw new Error("off failed"); } }), /off failed/);
  assert.equal((await f.store.get(owner(1))).status, "revoked");
  assert.deepEqual(await f.store.setAdmission({ actor: ADMIN, owner: owner(1), status: "allowed", expectedRevision: before.revision, beforeAdmit: async () => { prepared++; } }), { outcome: "updated", revision: before.revision + 1 });
  assert.equal(prepared, 2);
  assert.equal(f.raw.prepare("SELECT source FROM perps_pilot_admissions WHERE owner=?").get(owner(1))!.source, "admin");
  assert.deepEqual((await f.store.snapshot()).owners, [owner(1)]);
  assert.equal((await f.store.get(owner(1))).status, "allowed");
  assert.deepEqual(await f.store.withAdmission(owner(1), async () => "saved"), { allowed: true, value: "saved" });
});
