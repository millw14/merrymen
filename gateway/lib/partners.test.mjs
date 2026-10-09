/**
 * Partner credentials, exercised for real against a temp directory.
 *
 * `node --test lib/partners.test.mjs` — no framework, matching signups.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(tmpdir(), "merrymen-partners-"));
process.env.MERRYMEN_DATA_DIR = dir;
delete process.env.MERRYMEN_PARTNER_KEYS;

const { createPartners, FileBusy, hashSecret, loadRegistry, makeKey, parseKey, repairTail, withAppendLock, writeRecord, SCOPES, DEFAULT_SCOPES } =
  await import("./partners.mjs");

const SECRET = "x".repeat(40);
const FILE = path.join(dir, "partners.jsonl");

async function issue({ name = "prism", scopes = [...DEFAULT_SCOPES], status = "active", appId } = {}) {
  const { key, keyId, secret } = makeKey();
  await writeRecord({ keyId, appId, name, hash: hashSecret(SECRET, secret), scopes, status });
  return { key, keyId, secret };
}

test("a key round-trips, and the plaintext secret is never written down", async () => {
  const { key, keyId, secret } = await issue({ name: "prism" });
  assert.match(key, /^mmp_[0-9a-hjkmnp-tv-z]{12}_[A-Za-z0-9_-]+$/);

  const raw = await readFile(FILE, "utf8");
  // The whole point of storing an HMAC: a stolen registry must not be a stolen key.
  assert.ok(!raw.includes(secret), "the plaintext secret reached the registry file");
  assert.ok(!raw.includes(key), "the full key reached the registry file");
  assert.ok(raw.includes(keyId), "the key id should be stored — it is not secret");

  const p = createPartners({ secret: SECRET });
  const v = await p.verify(key);
  assert.equal(v.ok, true);
  assert.equal(v.key.name, "prism");
});

test("the key id alphabet has no i, l, o or u", () => {
  for (let i = 0; i < 200; i++) {
    const { keyId } = makeKey();
    assert.ok(!/[ilou]/.test(keyId), `ambiguous character in ${keyId}`);
  }
});

test("a wrong secret against a real key id is refused", async () => {
  const { keyId } = await issue();
  const p = createPartners({ secret: SECRET });
  const v = await p.verify(`mmp_${keyId}_${"A".repeat(43)}`);
  assert.equal(v.ok, false);
  assert.equal(v.code, "unauthorized");
});

test("an unknown key id is refused as unauthorized, not as a 404", async () => {
  const p = createPartners({ secret: SECRET });
  const v = await p.verify(`mmp_${"a".repeat(12)}_${"B".repeat(43)}`);
  assert.equal(v.ok, false);
  assert.equal(v.status, 401);
  assert.equal(v.code, "unauthorized");
});

test("anything that is not an mmp_ key is NOT OURS — 404, never 401", async () => {
  const p = createPartners({ secret: SECRET });
  for (const raw of ["", "Bearer", "mmk_abc.def", "mmp_short_x", null, undefined, "mmp__"]) {
    const v = await p.verify(raw);
    assert.equal(v.ok, false, `accepted ${JSON.stringify(raw)}`);
    // A 401 would confirm that a partner system exists here to someone probing
    // with a holder token. 404 teaches nothing.
    assert.equal(v.notOurs, true, `leaked existence for ${JSON.stringify(raw)}`);
    assert.equal(v.status, 404);
  }
});

test("revocation is an appended line, and the last record wins", async () => {
  const { key, keyId } = await issue({ name: "goner" });
  const p = createPartners({ secret: SECRET });
  assert.equal((await p.verify(key)).ok, true);

  const before = (await readFile(FILE, "utf8")).trim().split("\n").length;
  const rec = (await loadRegistry()).get(keyId);
  await writeRecord({ ...rec, status: "revoked" });
  const after = (await readFile(FILE, "utf8")).trim().split("\n").length;
  assert.equal(after, before + 1, "revocation must append, never rewrite");

  p.reload();
  const v = await p.verify(key);
  assert.equal(v.ok, false);
  assert.equal(v.code, "key_revoked");
});

test("scopes are enforced, and an unknown scope in a record is dropped", async () => {
  const { key } = await issue({ scopes: ["read:agents", "read:everything"] });
  const p = createPartners({ secret: SECRET });
  const v = await p.verify(key);
  assert.equal(v.ok, true);
  assert.deepEqual(v.key.scopes, ["read:agents"], "an unknown scope must not survive the load");
  assert.equal(p.allows(v.key, "read:agents"), true);
  assert.equal(p.allows(v.key, "read:trades"), false);
});

test("the consent-gated scopes are not handed out by default", () => {
  // read:book and read:trades expose real users' positions. A new key must not
  // carry them because someone forgot to pass --scopes.
  assert.ok(!DEFAULT_SCOPES.includes("read:book"));
  assert.ok(!DEFAULT_SCOPES.includes("read:trades"));
  assert.ok(!DEFAULT_SCOPES.includes("write:agents"));
  assert.ok(!DEFAULT_SCOPES.includes("chat:agents"));
  for (const s of DEFAULT_SCOPES) assert.ok(SCOPES.includes(s));
});

test("stable app identity survives key rotation and legacy keys retain their identity", async () => {
  const original = await issue({ appId: "stable_partner_app", scopes: ["read:agents", "write:agents", "chat:agents"] });
  const replacement = await issue({ appId: "stable_partner_app" });
  const legacy = await issue({});
  const partners = createPartners({ secret: SECRET });
  assert.equal((await partners.verify(original.key)).key.appId, "stable_partner_app");
  assert.equal((await partners.verify(replacement.key)).key.appId, "stable_partner_app");
  assert.equal((await partners.verify(legacy.key)).key.appId, legacy.keyId);
  assert.deepEqual((await partners.verify(original.key)).key.scopes, ["read:agents", "write:agents", "chat:agents"]);
});

test("a key's name is signed as well-formed text, never half an emoji or a control character", async () => {
  const cut = await issue({ name: `${"a".repeat(63)}\u{1F600}` }); // 65 UTF-16 units; 64 would split the pair
  const odd = await issue({ name: "Bad\u0007 \ud800name" });
  const blank = await issue({ name: "\u0001\u0002" });
  const partners = createPartners({ secret: SECRET });
  const named = (await partners.verify(cut.key)).key.name;
  assert.equal(named, "a".repeat(63));
  assert.ok(named.isWellFormed());
  assert.equal((await partners.verify(odd.key)).key.name, "Bad \ufffdname");
  assert.equal((await partners.verify(blank.key)).key.name, blank.keyId);
});

test("the file overrides the env, so a revocation on the volume always wins", async () => {
  const { key, keyId, secret } = makeKey();
  process.env.MERRYMEN_PARTNER_KEYS = JSON.stringify([
    { keyId, name: "from-env", hash: hashSecret(SECRET, secret), scopes: ["read:agents"], status: "active" },
  ]);
  const live = createPartners({ secret: SECRET });
  assert.equal((await live.verify(key)).ok, true, "env key should work");

  await writeRecord({ keyId, name: "from-env", hash: hashSecret(SECRET, secret), scopes: [], status: "revoked" });
  const after = createPartners({ secret: SECRET });
  const v = await after.verify(key);
  assert.equal(v.ok, false, "a stale env var must not keep a revoked key alive");
  assert.equal(v.code, "key_revoked");
  delete process.env.MERRYMEN_PARTNER_KEYS;
});

test("a malformed MERRYMEN_PARTNER_KEYS does not throw the gateway over", async () => {
  process.env.MERRYMEN_PARTNER_KEYS = "{not json";
  const reg = await loadRegistry();
  assert.ok(reg instanceof Map);
  delete process.env.MERRYMEN_PARTNER_KEYS;
});

test("parseKey splits only well-formed keys", () => {
  const { key, keyId, secret } = makeKey();
  assert.deepEqual(parseKey(` ${key} `), { keyId, secret });
  assert.equal(parseKey("mmp_UPPERCASEID_xxxxxxxxxxxxxxxx"), null);
});

test("verify names the key's owner and creation time, so a request can be metered to its wallet", async () => {
  const { key, keyId, secret } = makeKey();
  const owner = `0x${"Ab".repeat(20)}`;
  await writeRecord({ keyId, name: "owned", owner, hash: hashSecret(SECRET, secret), scopes: ["read:agents"],
    status: "active", created_at: "2026-10-01T12:00:00.000Z" });
  const v = await createPartners({ secret: SECRET }).verify(key);
  assert.equal(v.key.owner, owner.toLowerCase());
  assert.equal(v.key.created_at, "2026-10-01T12:00:00.000Z");
  // An operator key belongs to no wallet: null, which billing never meters.
  const operator = await issue({ name: "operator" });
  assert.equal((await createPartners({ secret: SECRET }).verify(operator.key)).key.owner, null);
});

test("a torn final line is cut before the next append, so a revocation after it is not lost", async () => {
  const { key, keyId } = await issue({ name: "torn" });
  const rec = (await loadRegistry()).get(keyId);
  // A write that died part-way: the first half of a record and no newline.
  await appendFile(FILE, '{"keyId":"half-writ');
  await writeRecord({ ...rec, status: "revoked" });
  const raw = await readFile(FILE, "utf8");
  assert.ok(raw.endsWith("\n") && !raw.includes("half-writ"), "the fragment must be removed, not glued to");
  const v = await createPartners({ secret: SECRET }).verify(key);
  assert.equal(v.ok, false, "the revocation written after a torn line must take effect");
  assert.equal(v.code, "key_revoked");
});

test("a registry line another process is still writing is never cut: writeRecord waits for its lock", async () => {
  const { key, keyId } = await issue({ name: "locked" });
  const rec = (await loadRegistry()).get(keyId);
  const lock = `${FILE}.lock`;
  await writeFile(lock, "", { flag: "wx" }); // partners-cli is mid-append
  const other = makeKey();
  const line = `${JSON.stringify({ keyId: other.keyId, name: "cli", hash: hashSecret(SECRET, other.secret), scopes: ["read:agents"], status: "active" })}\n`;
  await appendFile(FILE, line.slice(0, 30));
  const revoking = writeRecord({ ...rec, status: "revoked" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok((await readFile(FILE, "utf8")).endsWith(line.slice(0, 30)), "the CLI's line is not cut while it is written");
  await appendFile(FILE, line.slice(30));
  await rm(lock);
  await revoking;
  assert.equal((await createPartners({ secret: SECRET }).verify(other.key)).ok, true, "the CLI's key survived");
  assert.equal((await createPartners({ secret: SECRET }).verify(key)).code, "key_revoked", "and the revocation landed after it");
});

test("repairTail keeps a file that ends cleanly, and empties one with no complete line", async () => {
  const clean = path.join(dir, "clean.jsonl"), torn = path.join(dir, "torn.jsonl"), none = path.join(dir, "none.jsonl");
  await writeFile(clean, '{"a":1}\n{"b":2}\n');
  await writeFile(torn, '{"a":1}\n{"b":');
  await writeFile(none, "x".repeat(70_000)); // longer than one read chunk, and no newline anywhere
  assert.equal(await repairTail(clean), 0);
  assert.equal(await readFile(clean, "utf8"), '{"a":1}\n{"b":2}\n');
  assert.equal(await repairTail(torn), 5);
  assert.equal(await readFile(torn, "utf8"), '{"a":1}\n');
  assert.equal(await repairTail(none), 70_000);
  assert.equal(await readFile(none, "utf8"), "");
  assert.equal(await repairTail(path.join(dir, "missing.jsonl")), 0);
});

// Two writers, one stale lock. Each test plays the OTHER writer inside a hook,
// at the exact moment Codex's review described, so the interleaving is not left
// to chance.
const lockOf = (file) => `${file}.lock`;
const staleLock = async (file) => {
  await writeFile(lockOf(file), "dead");
  const old = new Date(Date.now() - 60_000);
  await utimes(lockOf(file), old, old);
};

test("a writer that judged a lock stale never deletes the successor that took it first", async () => {
  const file = path.join(dir, "race-stale.jsonl");
  await staleLock(file);
  let ran = false;
  await assert.rejects(withAppendLock(file, async () => { ran = true; }, { waitMs: 200, hooks: {
    // Between this writer's look and its removal, the other writer breaks the
    // stale lock itself and takes a fresh one.
    staleSeen: async () => { await rm(lockOf(file)); await writeFile(lockOf(file), "successor"); },
  } }), FileBusy);
  assert.equal(ran, false, "it never ran alongside the successor");
  assert.equal(await readFile(lockOf(file), "utf8"), "successor", "the successor's lock is intact");
  assert.deepEqual((await readdir(dir)).filter((n) => n.startsWith("race-stale.jsonl.lock.claim")), [], "no claim left behind");
});

test("a holder whose lock was broken while it stalled releases nothing but its own", async () => {
  const file = path.join(dir, "race-release.jsonl");
  await withAppendLock(file, async () => {}, { hooks: {
    // It stalled past LOCK_STALE_MS: another writer broke its lock and took one.
    beforeRelease: async () => { await rm(lockOf(file)); await writeFile(lockOf(file), "successor"); },
  } });
  assert.equal(await readFile(lockOf(file), "utf8"), "successor", "the successor's lock survives the slow holder's release");
});

test("a stale lock is still broken, and an ordinary append leaves no lock or claim behind", async () => {
  const file = path.join(dir, "race-plain.jsonl");
  await staleLock(file);
  let ran = 0;
  await withAppendLock(file, async () => { ran++; });
  await withAppendLock(file, async () => { ran++; });
  assert.equal(ran, 2);
  assert.deepEqual((await readdir(dir)).filter((n) => n.startsWith("race-plain.jsonl.lock")), []);
});
