/**
 * Partner credentials, exercised for real against a temp directory.
 *
 * `node --test lib/partners.test.mjs` — no framework, matching signups.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(tmpdir(), "merrymen-partners-"));
process.env.MERRYMEN_DATA_DIR = dir;
delete process.env.MERRYMEN_PARTNER_KEYS;

const { createPartners, hashSecret, loadRegistry, makeKey, parseKey, writeRecord, SCOPES, DEFAULT_SCOPES } =
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
