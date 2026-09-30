import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createDeveloperApi } from "./developer-api.mjs";
import { createPartners, loadRegistry } from "./partners.mjs";
import { createPartnerApi } from "./partner-api.mjs";
import { createStore } from "./store.mjs";
const dir = await mkdtemp(join(tmpdir(), "merrymen-developer-test-"));
process.env.MERRYMEN_DATA_DIR = dir;
delete process.env.MERRYMEN_PARTNER_KEYS;
after(() => rm(dir, { recursive: true, force: true }));
const portalSecret = "portal-test-secret-with-at-least-32-bytes";
const gatewaySecret = "gateway-test-secret-with-at-least-32-bytes";
function fixture() {
  let time = Date.now();
  const store = createStore(), partners = createPartners({ secret: gatewaySecret });
  const partnerApi = createPartnerApi({ partners, store });
  const api = createDeveloperApi({ portalSecret, gatewaySecret, partners, partnerApi, store, now: () => time });
  const wallet = privateKeyToAccount(generatePrivateKey());
  const call = (path, body, session, authorization = `Bearer ${portalSecret}`) => api.handle({ method: body === undefined ? "GET" : "POST", path, body, session, authorization, ip: wallet.address });
  async function login() {
    const challenge = await call("/challenge", { address: wallet.address });
    assert.equal(challenge.status, 200);
    const proof = { challenge: challenge.json.challenge, signature: await wallet.signMessage({ message: challenge.json.message }) };
    const verified = await call("/verify", proof);
    assert.equal(verified.status, 200);
    return { session: verified.json.session, proof };
  }
  return { call, login, partners, wallet, advance: n => { time += n; } };
}
test("portal credential and real wallet proof are required; proofs cannot replay", async () => {
  const f = fixture();
  assert.equal((await f.call("/challenge", { address: f.wallet.address }, undefined, "Bearer wrong")).status, 401);
  assert.equal((await f.call("/keys", { name: "Unowned" })).status, 401);
  const { session, proof } = await f.login();
  assert.equal((await f.call("/verify", proof)).status, 401);
  assert.equal((await f.call("/keys", undefined, session + "x")).status, 401);
  f.advance(8 * 3600_000);
  assert.equal((await f.call("/keys", undefined, session)).status, 401);
});
test("wrong wallet signatures and stale challenges are rejected", async () => {
  const f = fixture(); const challenge = await f.call("/challenge", { address: f.wallet.address });
  const other = privateKeyToAccount(generatePrivateKey());
  const bad = await f.call("/verify", { challenge: challenge.json.challenge, signature: await other.signMessage({ message: challenge.json.message }) });
  assert.equal(bad.status, 401);
  f.advance(301_000);
  assert.equal((await f.call("/verify", { challenge: challenge.json.challenge, signature: await f.wallet.signMessage({ message: challenge.json.message }) })).status, 401);
});
test("issue, test, list, rotate, and revoke use the actual partner registry", async () => {
  const f = fixture(); const { session } = await f.login();
  const issued = await f.call("/keys", { name: "Example app" }, session);
  assert.equal(issued.status, 201);
  assert.equal((await f.partners.verify(issued.json.key)).ok, true);
  assert.equal((await f.call("/test", { key: issued.json.key }, session)).status, 200);
  const list = await f.call("/keys", undefined, session);
  assert.equal(list.json.keys.length, 1);
  assert.equal(list.json.address, f.wallet.address.toLowerCase());
  assert.ok(!JSON.stringify(list).includes(issued.json.key));
  assert.ok(!JSON.stringify(list.json.keys).includes("hash"));
  assert.ok(!(await readFile(join(dir, "partners.jsonl"), "utf8")).includes(issued.json.key));
  const rotated = await f.call("/keys", { name: "Example app", app_id: issued.json.app_id }, session);
  assert.equal(rotated.status, 201); assert.equal(rotated.json.app_id, issued.json.app_id);
  assert.notEqual(rotated.json.key, issued.json.key);
  assert.equal((await f.call("/revoke", { key_id: issued.json.key_id }, session)).status, 200);
  assert.equal((await f.partners.verify(issued.json.key)).code, "key_revoked");
  assert.equal((await f.partners.verify(rotated.json.key)).ok, true);
  assert.equal((await loadRegistry()).get(issued.json.key_id).owner, f.wallet.address.toLowerCase());
});
test("one developer cannot list, test, replace, or revoke another developer's keys", async () => {
  const owner = fixture(), other = fixture();
  const a = await owner.login(), b = await other.login();
  const issued = await owner.call("/keys", { name: "Private app" }, a.session);
  assert.equal((await other.call("/keys", undefined, b.session)).json.keys.length, 0);
  assert.equal((await other.call("/keys", { name: "Takeover", app_id: issued.json.app_id }, b.session)).status, 403);
  assert.equal((await other.call("/revoke", { key_id: issued.json.key_id }, b.session)).status, 404);
  assert.equal((await other.call("/test", { key: issued.json.key }, b.session)).status, 403);
});
test("concurrent creation enforces the active-key cap", async () => {
  const f = fixture(), { session } = await f.login();
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => f.call("/keys", { name: `App ${i}` }, session)));
  assert.equal(results.filter(r => r.status === 201).length, 5);
  assert.equal(results.filter(r => r.status === 409).length, 3);
});
