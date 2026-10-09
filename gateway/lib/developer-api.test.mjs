import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeErc6492Signature } from "viem";
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
function fixture({ store = createStore(), ...options } = {}) {
  let time = Date.now();
  const partners = createPartners({ secret: gatewaySecret });
  const partnerApi = createPartnerApi({ partners, store });
  // `restart` is a new process on the same secrets and the same store.
  const start = () => createDeveloperApi({ portalSecret, gatewaySecret, partners, partnerApi, store, now: () => time, ...options });
  let api = start();
  const wallet = privateKeyToAccount(generatePrivateKey());
  // Bodies travel as the server hands them over: raw text. A string is sent verbatim.
  const call = (path, body, session, authorization = `Bearer ${portalSecret}`) => api.handle({ method: body === undefined ? "GET" : "POST", path,
    body: typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body), session, authorization, ip: wallet.address });
  async function login() {
    const challenge = await call("/challenge", { address: wallet.address });
    assert.equal(challenge.status, 200);
    const proof = { challenge: challenge.json.challenge, signature: await wallet.signMessage({ message: challenge.json.message }) };
    const verified = await call("/verify", proof);
    assert.equal(verified.status, 200);
    return { session: verified.json.session, proof };
  }
  return { call, login, partners, wallet, advance: n => { time += n; }, restart: () => { api = start(); } };
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
test("the portal's own secret cannot mint a session or a challenge", async () => {
  // Everything the site's environment holds, used the way the old scheme did:
  // a payload copied from a real token, re-addressed, and MAC'd with the portal
  // secret. Copying every other field (nonce, boot, expiry) from genuine tokens
  // proves the key is what refuses it, not a field the forger could not guess.
  const f = fixture(), victim = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  const payload = token => JSON.parse(Buffer.from(token.split(".")[0], "base64url"));
  const forge = data => { const encoded = Buffer.from(JSON.stringify(data)).toString("base64url");
    return `${encoded}.${createHmac("sha256", portalSecret).update(`developer-v1:${encoded}`).digest("base64url")}`; };
  const { session } = await f.login();
  assert.equal((await f.call("/keys", undefined, forge(payload(session)))).status, 401);
  assert.equal((await f.call("/keys", undefined, forge({ ...payload(session), address: victim }))).status, 401);
  const real = await f.call("/challenge", { address: f.wallet.address });
  const challenge = forge(payload(real.json.challenge));
  assert.equal((await f.call("/verify", { challenge, signature: await f.wallet.signMessage({ message: real.json.message }) })).status, 401);
  // The genuine flow is unaffected, and a gateway without its secret fails closed.
  assert.equal((await f.call("/keys", undefined, session)).status, 200);
  const keyless = createDeveloperApi({ portalSecret, gatewaySecret: "", partners: f.partners, store: createStore() });
  assert.equal((await keyless.handle({ method: "POST", path: "/challenge", body: JSON.stringify({ address: f.wallet.address }), authorization: `Bearer ${portalSecret}` })).status, 503);
});
test("rotating the portal secret signs every developer out, and leaves partner keys working", async () => {
  // The kill switch for a leaked session cookie: before sessions moved to a
  // gateway-derived key, rotating the portal secret did this; it must still.
  const store = createStore();
  Object.defineProperty(store, "durable", { value: true }); // KV: sessions survive restarts, so only the key can end them
  const partners = createPartners({ secret: gatewaySecret });
  const partnerApi = createPartnerApi({ partners, store });
  const wallet = privateKeyToAccount(generatePrivateKey());
  const api = secret => createDeveloperApi({ portalSecret: secret, gatewaySecret, partners, partnerApi, store });
  const call = (target, secret, path, body, session) => target.handle({ method: body === undefined ? "GET" : "POST", path,
    body: body === undefined ? undefined : JSON.stringify(body), session, authorization: `Bearer ${secret}`, ip: wallet.address });
  const before = api(portalSecret);
  const challenge = await call(before, portalSecret, "/challenge", { address: wallet.address });
  const { session } = (await call(before, portalSecret, "/verify", { challenge: challenge.json.challenge, signature: await wallet.signMessage({ message: challenge.json.message }) })).json;
  const minted = await call(before, portalSecret, "/keys", { name: "Survives rotation" }, session);
  assert.equal(minted.status, 201);
  assert.equal((await call(api(portalSecret), portalSecret, "/keys", undefined, session)).status, 200, "an unrotated restart keeps the session");
  const rotated = "rotated-portal-secret-with-at-least-32-bytes";
  const after = api(rotated);
  const refused = await call(after, rotated, "/keys", undefined, session);
  assert.equal(refused.status, 401); assert.equal(refused.json.error.code, "signed_out");
  assert.equal((await partners.verify(minted.json.key)).ok, true, "partner keys do not depend on the portal secret");
});
test("logout revokes that session on the gateway, not just the site's cookie", async () => {
  const f = fixture();
  const first = await f.login(), second = await f.login();
  assert.equal((await f.call("/logout", {}, first.session, "Bearer wrong")).status, 401);
  assert.equal((await f.call("/keys", undefined, first.session)).status, 200);
  assert.equal((await f.call("/logout", {}, first.session)).status, 200);
  assert.equal((await f.call("/keys", undefined, first.session)).status, 401);
  assert.equal((await f.call("/keys", { name: "After logout" }, first.session)).status, 401);
  assert.equal((await f.call("/keys", undefined, second.session)).status, 200, "only that session ends");
  // Idempotent, so the site can call it without knowing the token's state.
  assert.equal((await f.call("/logout", {}, first.session)).status, 200);
  assert.equal((await f.call("/logout", {}, "not-a-session")).status, 200);
});
test("a memory store binds sessions to the process; a durable store keeps sessions and logouts", async () => {
  // The memory store forgets revocations on restart. Were sessions to outlive
  // the process anyway, a deploy would revive every one signed out before it.
  const memory = fixture(), { session } = await memory.login();
  memory.restart();
  assert.equal((await memory.call("/keys", undefined, session)).status, 401);
  const durable = fixture({ store: { ...createStore(), durable: true } });
  const kept = await durable.login(), ended = await durable.login();
  assert.equal((await durable.call("/logout", {}, ended.session)).status, 200);
  durable.restart();
  assert.equal((await durable.call("/keys", undefined, kept.session)).status, 200);
  assert.equal((await durable.call("/keys", undefined, ended.session)).status, 401);
});
test("a store that cannot record a logout fails closed rather than reporting success", async () => {
  const broken = { ...createStore(), revoke: async () => { throw new Error("redis 500"); } };
  const f = fixture({ store: broken }), { session } = await f.login();
  assert.equal((await f.call("/logout", {}, session)).status, 503);
  const unreadable = fixture({ store: { ...createStore(), isRevoked: async () => { throw new Error("redis 500"); } } });
  const challenge = await unreadable.call("/challenge", { address: unreadable.wallet.address });
  const verified = await unreadable.call("/verify", { challenge: challenge.json.challenge, signature: await unreadable.wallet.signMessage({ message: challenge.json.message }) });
  assert.equal((await unreadable.call("/keys", undefined, verified.json.session)).status, 503);
  // A store that cannot spend the sign-in nonce is unavailable, not "already used",
  // and the same proof works once it answers.
  let down = true;
  const memory = createStore();
  const flaky = fixture({ store: { ...memory, spendNonce: async (token, ttl, options) => {
    if (down) { if (options?.throwOnError) throw new Error("redis 500"); return false; }
    return memory.spendNonce(token, ttl, options);
  } } });
  const c = await flaky.call("/challenge", { address: flaky.wallet.address });
  const proof = { challenge: c.json.challenge, signature: await flaky.wallet.signMessage({ message: c.json.message }) };
  const outage = await flaky.call("/verify", proof);
  assert.equal(outage.status, 503); assert.equal(outage.json.error.code, "unavailable");
  down = false;
  assert.equal((await flaky.call("/verify", proof)).status, 200);
});
test("wrong wallet signatures and stale challenges are rejected", async () => {
  const f = fixture(); const challenge = await f.call("/challenge", { address: f.wallet.address });
  const other = privateKeyToAccount(generatePrivateKey());
  const bad = await f.call("/verify", { challenge: challenge.json.challenge, signature: await other.signMessage({ message: challenge.json.message }) });
  assert.equal(bad.status, 401); assert.equal(bad.json.error.code, "signature_invalid");
  f.advance(301_000);
  const stale = await f.call("/verify", { challenge: challenge.json.challenge, signature: await f.wallet.signMessage({ message: challenge.json.message }) });
  assert.equal(stale.status, 401); assert.equal(stale.json.error.code, "challenge_expired");
});

/** One sign-in attempt against a challenge for `address`, which may be a contract. */
async function attempt(f, address, sign) {
  const challenge = await f.call("/challenge", { address });
  return { challenge, verified: await f.call("/verify", { challenge: challenge.json.challenge, signature: await sign(challenge.json.message) }) };
}
test("a smart-contract wallet is refused by name, and no chain is ever asked to vouch for a signature", async () => {
  // A chain client that would vouch for anything. Handed in, it must be ignored:
  // trusting one let a lying RPC sign in as any address and mint keys there.
  const calls = [];
  const lying = { getCode: async () => { calls.push("getCode"); return "0x6080"; }, verifyMessage: async () => { calls.push("verifyMessage"); return true; } };
  const f = fixture({ publicClient: lying });
  const victim = `0x${"11".repeat(20)}`;
  const wrapped = serializeErc6492Signature({ address: `0x${"fa".repeat(20)}`, data: "0x1234", signature: `0x${"5a".repeat(300)}` });
  for (const proof of [wrapped, `0x${"5a".repeat(400)}`]) {
    const { verified } = await attempt(f, victim, async () => proof);
    assert.equal(verified.status, 401); assert.equal(verified.json.error.code, "wallet_unsupported");
  }
  // A 65-byte signature from some other key (a one-owner Safe's owner) is simply not this wallet's.
  const owner = privateKeyToAccount(generatePrivateKey());
  const safe = await attempt(f, victim, message => owner.signMessage({ message }));
  assert.equal(safe.verified.json.error.code, "signature_invalid");
  assert.deepEqual(calls, []);
  // A refused proof leaves the challenge usable for the wallet's real signature.
  const challenge = await f.call("/challenge", { address: f.wallet.address });
  assert.equal((await f.call("/verify", { challenge: challenge.json.challenge, signature: wrapped })).json.error.code, "wallet_unsupported");
  assert.equal((await f.call("/verify", { challenge: challenge.json.challenge, signature: await f.wallet.signMessage({ message: challenge.json.message }) })).status, 200);
});
test("each sign-in refusal names its cause", async () => {
  const f = fixture();
  const challenge = (await f.call("/challenge", { address: f.wallet.address })).json.challenge;
  const verify = async signature => (await f.call("/verify", { challenge, signature })).json.error?.code;
  for (const signature of [`0x${"ab".repeat(3001)}`, "0xabc", "0x", `0x${"zz".repeat(65)}`, 42, undefined]) {
    assert.equal(await verify(signature), "signature_malformed", String(signature).slice(0, 12));
  }
  // The largest accepted proof still fits the 8 KiB body cap with its challenge.
  assert.ok(JSON.stringify({ challenge, signature: `0x${"ab".repeat(3000)}` }).length < 8192);
  const [encoded, mac] = challenge.split(".");
  const tampered = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(encoded, "base64url")), expires: Date.now() + 9e9 })).toString("base64url")}.${mac}`;
  assert.equal((await f.call("/verify", { challenge: tampered, signature: "0x00" })).json.error.code, "challenge_invalid");
  assert.equal((await f.call("/verify", { challenge: `${challenge}.`, signature: "0x00" })).json.error.code, "challenge_invalid");
  f.restart();
  assert.equal((await f.call("/verify", { challenge, signature: "0x00" })).json.error.code, "challenge_expired");
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
test("an app name that is not well-formed text is refused, not stored", async () => {
  const f = fixture(), { session } = await f.login();
  const refused = await f.call("/keys", '{"name":"App \\ud800"}', session);
  assert.equal(refused.status, 400); assert.equal(refused.json.error.code, "invalid_name");
  assert.equal((await f.call("/keys", { name: "App \u{1F600}" }, session)).status, 201, "a whole emoji is fine");
});
test("a body that is JSON but not an object is a 400, after authentication", async () => {
  const f = fixture(), { session } = await f.login();
  for (const raw of ["null", "5", "[]", '"text"', "{", ""]) {
    for (const path of ["/challenge", "/verify", "/keys", "/revoke", "/test", "/logout"]) {
      assert.equal((await f.call(path, raw, session)).status, 400, `${path} ${raw}`);
    }
  }
  assert.equal((await f.call("/challenge", "null", undefined, "Bearer wrong")).status, 401);
});

/**
 * The real entrypoint on a free localhost port, for what only the HTTP plumbing
 * decides. It gets its three required settings and reaches nothing else: the
 * RPC is a closed local port, and no route here touches the chain unless a
 * signature fails its local check.
 */
async function startGateway() {
  const port = await new Promise(resolve => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
  const child = spawn(process.execPath, [fileURLToPath(new URL("../server.mjs", import.meta.url))], { stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, PORT: String(port), MERRYMEN_DATA_DIR: dir, MERRYMEN_GATEWAY_UPSTREAM_KEY: "unused",
      MERRYMEN_GATEWAY_SECRET: gatewaySecret, MERRYMEN_GATEWAY_RPC: "http://127.0.0.1:9", MERRYMEN_DEVELOPER_PORTAL_SECRET: portalSecret } });
  let output = "";
  await new Promise((resolve, reject) => {
    child.stdout.on("data", chunk => { output += chunk; if (output.includes("listening")) resolve(); });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("exit", code => reject(new Error(`gateway exited ${code}: ${output}`)));
  });
  return { origin: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}
test("the server hands the developer API raw text, so a null body is a 400 rather than a 503", async () => {
  const gateway = await startGateway();
  try {
    const post = (path, body) => fetch(`${gateway.origin}/developer/v1${path}`, { method: "POST", body,
      headers: { authorization: `Bearer ${portalSecret}`, "content-type": "application/json" } });
    for (const body of ["null", "[]", "7", "{"]) assert.equal((await post("/challenge", body)).status, 400, body);
    assert.equal((await post("/challenge", JSON.stringify({ address: `0x${"ab".repeat(20)}` }))).status, 200);
    for (const size of [8193, 300 * 1024]) {
      const tooLarge = await post("/challenge", "x".repeat(size));
      assert.equal(tooLarge.status, 413, `${size} bytes`); assert.equal((await tooLarge.json()).error.code, "request_too_large");
    }
  } finally { gateway.stop(); }
});
