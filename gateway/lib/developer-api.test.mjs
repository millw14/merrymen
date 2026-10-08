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
import { createBilling, openLedger } from "./billing.mjs";
import { ONE_TOKEN } from "./billing-plans.mjs";
import { createPartners, hashSecret, loadRegistry, makeKey, writeRecord } from "./partners.mjs";
import { createPartnerApi } from "./partner-api.mjs";
import { createStore } from "./store.mjs";
const dir = await mkdtemp(join(tmpdir(), "merrymen-developer-test-"));
process.env.MERRYMEN_DATA_DIR = dir;
delete process.env.MERRYMEN_PARTNER_KEYS;
const dirs = [dir];
after(() => Promise.all(dirs.map(d => rm(d, { recursive: true, force: true }))));
const portalSecret = "portal-test-secret-with-at-least-32-bytes";
const gatewaySecret = "gateway-test-secret-with-at-least-32-bytes";
/** A billing core on its own ledger, as server.mjs builds it; off by default, as it ships. */
async function billingFor({ mode = "off", now = Date.now, ...extra } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "merrymen-developer-billing-"));
  dirs.push(dataDir);
  return { dataDir, billing: await createBilling({ dataDir, mode, now, log: () => {}, timers: false, ...extra }) };
}
async function fixture({ store = createStore(), mode, billingOptions = {}, ...options } = {}) {
  let time = Date.now();
  const { billing, dataDir } = await billingFor({ mode, now: () => time, ...billingOptions });
  const partners = createPartners({ secret: gatewaySecret });
  const partnerApi = createPartnerApi({ partners, store, billing });
  // `restart` is a new process on the same secrets and the same store.
  const start = () => createDeveloperApi({ portalSecret, gatewaySecret, partners, partnerApi, store, billing, now: () => time, ...options });
  let api = start();
  const wallet = privateKeyToAccount(generatePrivateKey());
  const f = { ip: null };
  // Bodies travel as the server hands them over: raw text. A string is sent verbatim.
  const call = (path, body, session, authorization = `Bearer ${portalSecret}`) => api.handle({ method: body === undefined ? "GET" : "POST", path,
    body: typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body), session, authorization, ip: f.ip ?? wallet.address });
  async function login(who = wallet) {
    const challenge = await call("/challenge", { address: who.address });
    assert.equal(challenge.status, 200);
    const proof = { challenge: challenge.json.challenge, signature: await who.signMessage({ message: challenge.json.message }) };
    const verified = await call("/verify", proof);
    assert.equal(verified.status, 200);
    return { session: verified.json.session, proof };
  }
  /** Sign in and create the account a new key needs. */
  async function onboard(who = wallet) {
    const signedIn = await login(who);
    const created = await call("/account", { name: "Acme" }, signedIn.session);
    assert.equal(created.status, 201, JSON.stringify(created.json));
    return signedIn;
  }
  /** Credit the way an operator grants it: billing-cli's adjustment, picked up by the gateway's tail. */
  async function grant(tokens, who = wallet) {
    const ledger = await openLedger({ dataDir, log: () => {} });
    const acct = ledger.state.byOwner.get(who.address.toLowerCase());
    await ledger.enqueue(() => ledger.append({ type: "adjustment", account_id: acct.account_id, amount_raw: (BigInt(tokens) * ONE_TOKEN).toString(), note: "test", operator: true }));
    await billing.tail();
  }
  return Object.assign(f, { call, login, onboard, grant, billing, partners, wallet, advance: n => { time += n; }, restart: () => { api = start(); } });
}
test("portal credential and real wallet proof are required; proofs cannot replay", async () => {
  const f = await fixture();
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
  const f = await fixture(), victim = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
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
  const { billing } = await billingFor();
  const partnerApi = createPartnerApi({ partners, store, billing });
  const wallet = privateKeyToAccount(generatePrivateKey());
  const api = secret => createDeveloperApi({ portalSecret: secret, gatewaySecret, partners, partnerApi, store, billing });
  const call = (target, secret, path, body, session) => target.handle({ method: body === undefined ? "GET" : "POST", path,
    body: body === undefined ? undefined : JSON.stringify(body), session, authorization: `Bearer ${secret}`, ip: wallet.address });
  const before = api(portalSecret);
  const challenge = await call(before, portalSecret, "/challenge", { address: wallet.address });
  const { session } = (await call(before, portalSecret, "/verify", { challenge: challenge.json.challenge, signature: await wallet.signMessage({ message: challenge.json.message }) })).json;
  assert.equal((await call(before, portalSecret, "/account", { name: "Rotation" }, session)).status, 201);
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
  const f = await fixture();
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
  const memory = await fixture(), { session } = await memory.login();
  memory.restart();
  assert.equal((await memory.call("/keys", undefined, session)).status, 401);
  const durable = await fixture({ store: { ...createStore(), durable: true } });
  const kept = await durable.login(), ended = await durable.login();
  assert.equal((await durable.call("/logout", {}, ended.session)).status, 200);
  durable.restart();
  assert.equal((await durable.call("/keys", undefined, kept.session)).status, 200);
  assert.equal((await durable.call("/keys", undefined, ended.session)).status, 401);
});
test("a store that cannot record a logout fails closed rather than reporting success", async () => {
  const broken = { ...createStore(), revoke: async () => { throw new Error("redis 500"); } };
  const f = await fixture({ store: broken }), { session } = await f.login();
  assert.equal((await f.call("/logout", {}, session)).status, 503);
  const unreadable = await fixture({ store: { ...createStore(), isRevoked: async () => { throw new Error("redis 500"); } } });
  const challenge = await unreadable.call("/challenge", { address: unreadable.wallet.address });
  const verified = await unreadable.call("/verify", { challenge: challenge.json.challenge, signature: await unreadable.wallet.signMessage({ message: challenge.json.message }) });
  assert.equal((await unreadable.call("/keys", undefined, verified.json.session)).status, 503);
  // A store that cannot spend the sign-in nonce is unavailable, not "already used",
  // and the same proof works once it answers.
  let down = true;
  const memory = createStore();
  const flaky = await fixture({ store: { ...memory, spendNonce: async (token, ttl, options) => {
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
  const f = await fixture(); const challenge = await f.call("/challenge", { address: f.wallet.address });
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
  const f = await fixture({ publicClient: lying });
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
  const f = await fixture();
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
  const f = await fixture(); const { session } = await f.onboard();
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
  // Both have accounts, so every refusal below is about whose key it is.
  const owner = await fixture(), other = await fixture();
  const a = await owner.onboard(), b = await other.onboard();
  const issued = await owner.call("/keys", { name: "Private app" }, a.session);
  assert.equal((await other.call("/keys", undefined, b.session)).json.keys.length, 0);
  assert.equal((await other.call("/keys", { name: "Takeover", app_id: issued.json.app_id }, b.session)).status, 403);
  assert.equal((await other.call("/revoke", { key_id: issued.json.key_id }, b.session)).status, 404);
  assert.equal((await other.call("/test", { key: issued.json.key }, b.session)).status, 403);
});
test("concurrent creation enforces the active-key cap", async () => {
  const f = await fixture(), { session } = await f.onboard();
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => f.call("/keys", { name: `App ${i}` }, session)));
  assert.equal(results.filter(r => r.status === 201).length, 5);
  assert.equal(results.filter(r => r.status === 409).length, 3);
});
test("an app name that is not well-formed text is refused, not stored", async () => {
  const f = await fixture(), { session } = await f.onboard();
  const refused = await f.call("/keys", '{"name":"App \\ud800"}', session);
  assert.equal(refused.status, 400); assert.equal(refused.json.error.code, "invalid_name");
  assert.equal((await f.call("/keys", { name: "App \u{1F600}" }, session)).status, 201, "a whole emoji is fine");
});
test("a body that is JSON but not an object is a 400, after authentication", async () => {
  const f = await fixture(), { session } = await f.login();
  for (const raw of ["null", "5", "[]", '"text"', "{", ""]) {
    for (const path of ["/challenge", "/verify", "/keys", "/revoke", "/test", "/logout", "/account", "/plan", "/payments"]) {
      assert.equal((await f.call(path, raw, session)).status, 400, `${path} ${raw}`);
    }
  }
  assert.equal((await f.call("/challenge", "null", undefined, "Bearer wrong")).status, 401);
});

/** A key minted before accounts existed, straight into the registry. */
async function legacyKey(owner, extra = {}) {
  const { key, keyId, secret } = makeKey();
  await writeRecord({ keyId, appId: `app_${keyId}`, owner: owner.toLowerCase(), name: "Legacy", hash: hashSecret(gatewaySecret, secret),
    scopes: ["read:agents"], rpm: 30, status: "active", created_at: new Date().toISOString(), ...extra });
  return { key, keyId };
}
test("a new key needs an account while billing meters keys; keys from before accounts are still listed, tested and revoked", async () => {
  const f = await fixture({ mode: "observe" }), { session } = await f.login();
  // Refused before the issuance limit, so asking costs nothing: ten an hour would refuse the eleventh.
  for (let i = 0; i < 12; i++) {
    const refused = await f.call("/keys", { name: "Before an account" }, session);
    assert.equal(refused.status, 409); assert.equal(refused.json.error.code, "account_required");
  }
  const legacy = await legacyKey(f.wallet.address);
  f.partners.reload();
  assert.equal((await f.call("/keys", undefined, session)).json.keys.length, 1);
  assert.equal((await f.call("/test", { key: legacy.key }, session)).status, 200);
  assert.equal((await f.call("/keys", { name: "Rotated", app_id: `app_${legacy.keyId}` }, session)).json.error.code, "account_required");
  assert.equal((await f.call("/revoke", { key_id: legacy.keyId }, session)).status, 200);
  assert.equal((await f.call("/account", { name: "Acme" }, session)).status, 201);
  assert.equal((await f.call("/keys", { name: "After an account" }, session)).status, 201);
});
test("one account per wallet, named like an app; one address makes at most three a day", async () => {
  const f = await fixture();
  f.ip = "198.51.100.7";
  const wallets = [f.wallet, ...Array.from({ length: 3 }, () => privateKeyToAccount(generatePrivateKey()))];
  const sessions = [];
  for (const w of wallets) sessions.push((await f.login(w)).session);
  // Refusals before the limit cost nothing, or three typos would lock an office out for a day.
  for (const name of ["", "   ", "x".repeat(49), "Tab\there", 42, undefined]) {
    const r = await f.call("/account", { name }, sessions[0]);
    assert.equal(r.status, 400, JSON.stringify(name)); assert.equal(r.json.error.code, "invalid_name");
  }
  assert.equal((await f.call("/account", '{"name":"Half \\ud800"}', sessions[0])).json.error.code, "invalid_name");
  const first = await f.call("/account", { name: "  Acme Labs " }, sessions[0]);
  assert.equal(first.status, 201);
  assert.deepEqual([first.json.account.name, first.json.account.wallet, first.json.plan.id], ["Acme Labs", f.wallet.address.toLowerCase(), "free"]);
  for (let i = 0; i < 3; i++) {
    const again = await f.call("/account", { name: "Again" }, sessions[0]);
    assert.equal(again.status, 409); assert.equal(again.json.error.code, "account_exists");
  }
  assert.equal((await f.call("/account", { name: "Second" }, sessions[1])).status, 201);
  assert.equal((await f.call("/account", { name: "Third" }, sessions[2])).status, 201);
  const fourth = await f.call("/account", { name: "Fourth" }, sessions[3]);
  assert.equal(fourth.status, 429); assert.equal(fourth.json.error.code, "rate_limited");
  assert.equal((await f.call("/account", undefined, sessions[3])).json.error.code, "account_missing");
  f.ip = "198.51.100.8";
  assert.equal((await f.call("/account", { name: "Fourth" }, sessions[3])).status, 201, "the limit is per address");
  assert.equal((await f.call("/account", undefined, sessions[3])).json.account.name, "Fourth");
});
test("the price list needs the portal but no session; account, plan and payment answers are billing's", async () => {
  const f = await fixture({ mode: "observe" });
  const plans = await f.call("/plans");
  assert.equal(plans.status, 200);
  assert.deepEqual(plans.json.billing, { mode: "observe", enforced: false });
  assert.equal(plans.json.treasury, null, "no treasury configured, so nothing to pay to");
  assert.deepEqual(plans.json.plans.map(p => [p.id, p.price_tokens, p.requests, p.rpm]),
    [["free", "0", 1000, 30], ["crumbs", "100000", 50000, 60], ["loaf", "400000", 250000, 120], ["feast", "1000000", 1000000, 300]]);
  assert.equal((await f.call("/plans", undefined, undefined, "Bearer wrong")).status, 401);
  assert.equal((await f.call("/account")).json.error.code, "signed_out");
  const { session } = await f.login();
  const hash = `0x${"ab".repeat(32)}`;
  for (const [path, body] of [["/account", undefined], ["/plan", { tier: "crumbs" }], ["/payments", { tx_hash: hash }]]) {
    const r = await f.call(path, body, session);
    assert.equal(r.status, 404, path); assert.equal(r.json.error.code, "account_missing");
  }
  assert.equal((await f.call("/account", { name: "Acme" }, session)).status, 201);
  const preview = await f.call("/plan", { tier: "crumbs" }, session);
  assert.equal(preview.status, 200);
  assert.deepEqual([preview.json.preview, preview.json.effect, preview.json.charge_now_tokens, preview.json.due_tokens], [true, "waiting_for_payment", "0", "100000"]);
  assert.equal((await f.call("/account", undefined, session)).json.plan.selected, "free", "a preview chooses nothing");
  const chosen = await f.call("/plan", { tier: "crumbs", confirm: true }, session);
  assert.deepEqual([chosen.status, chosen.json.plan.id, chosen.json.plan.selected, chosen.json.due_tokens], [200, "free", "crumbs", "100000"]);
  assert.equal((await f.call("/plan", { tier: "gold", confirm: true }, session)).json.error.code, "invalid_tier");
  assert.equal((await f.call("/payments", { tx_hash: "0x123" }, session)).json.error.code, "invalid_tx_hash");
  assert.equal((await f.call("/payments", { tx_hash: hash }, session)).json.error.code, "payments_unavailable");
});
test("payment checks are limited to 30 a minute per wallet", async () => {
  const f = await fixture({ mode: "observe" }), { session } = await f.onboard();
  const hash = `0x${"ab".repeat(32)}`;
  for (let i = 0; i < 30; i++) assert.equal((await f.call("/payments", { tx_hash: hash }, session)).json.error.code, "payments_unavailable");
  const limited = await f.call("/payments", { tx_hash: hash }, session);
  assert.equal(limited.status, 429); assert.equal(limited.json.error.code, "rate_limited");
  const other = await f.onboard(privateKeyToAccount(generatePrivateKey()));
  assert.equal((await f.call("/payments", { tx_hash: hash }, other.session)).json.error.code, "payments_unavailable", "each wallet has its own");
});
test("a payment check waiting on the chain holds up no key: its reads stay out of the key-mutation queue", async () => {
  // The receipt read stays open until the test answers it. Nothing here waits
  // on the chain's own timeout, which is set far beyond the one below.
  let answer;
  const receipt = new Promise((_, reject) => { answer = () => reject(Object.assign(new Error("not mined"), { name: "TransactionReceiptNotFoundError" })); });
  let asked = 0;
  const publicClient = { getChainId: async () => 4663, getTransactionReceipt: () => { asked += 1; return receipt; } };
  const f = await fixture({ mode: "enforce", billingOptions: { treasury: `0x${"7e".repeat(20)}`, startBlock: 1, publicClient, readTimeoutMs: 60_000 } });
  const { session } = await f.onboard();
  const paying = f.call("/payments", { tx_hash: `0x${"ab".repeat(32)}` }, session);
  try {
    for (let i = 0; i < 100 && asked === 0; i++) await new Promise(setImmediate); // bounded by count
    assert.equal(asked, 1, "the payment check is waiting on its receipt");
    let timer;
    const late = new Promise(resolve => { timer = setTimeout(() => resolve("still waiting"), 2_000); });
    const minted = await Promise.race([f.call("/keys", { name: "While paying" }, session), late]);
    clearTimeout(timer);
    assert.equal(minted.status, 201, "a key is minted while a payment check waits on the chain");
    assert.equal((await f.call("/revoke", { key_id: minted.json.key_id }, session)).status, 200);
  } finally {
    answer();
  }
  const pending = await paying;
  assert.deepEqual([pending.status, pending.json.code, pending.json.stage], [202, "payment_pending", "not_found_yet"]);
});
test("a key lists the rate its account's plan gives it, not the one stored when it was minted", async () => {
  // Billing off: what was stored, as before billing.
  const off = await fixture(), { session } = await off.onboard();
  await legacyKey(off.wallet.address, { rpm: 7 });
  assert.deepEqual((await off.call("/keys", undefined, session)).json.keys.map(k => k.rate_per_min), [7]);

  const f = await fixture({ mode: "observe" }), s = await f.onboard();
  const minted = await f.call("/keys", { name: "App" }, s.session);
  assert.equal(minted.json.rate_per_min, 30, "Free's rate");
  await f.grant(400_000);
  assert.equal((await f.call("/plan", { tier: "loaf", confirm: true }, s.session)).json.plan.id, "loaf");
  assert.deepEqual((await f.call("/keys", undefined, s.session)).json.keys.map(k => k.rate_per_min), [120]);
  assert.equal((await f.call("/test", { key: minted.json.key }, s.session)).json.rate_per_min, 120, "the list and the key test agree");
  const next = await f.call("/keys", { name: "Second app" }, s.session);
  assert.deepEqual([next.status, next.json.rate_per_min], [201, 120], "a key minted on a paid plan is answered with the plan's rate, not the 30 it stores");

  // Under enforce, the same: one per-account rate, whichever key asks.
  const e = await fixture({ mode: "enforce" }), es = await e.onboard();
  await e.grant(400_000);
  assert.equal((await e.call("/plan", { tier: "loaf", confirm: true }, es.session)).json.plan.id, "loaf");
  const enforced = await e.call("/keys", { name: "App" }, es.session);
  assert.deepEqual([enforced.status, enforced.json.rate_per_min], [201, 120]);
});
test("with billing off, a key is minted without an account, exactly as before billing", async () => {
  // Gateway and site deploy separately. A gateway on billing off, behind a
  // site that cannot create accounts yet, must still mint keys; such a key is
  // one from before accounts once billing meters it.
  for (const mode of ["off", "observe", "enforce"]) {
    const f = await fixture({ mode }), { session } = await f.login();
    const r = await f.call("/keys", { name: "Before an account" }, session);
    if (mode === "off") {
      assert.equal(r.status, 201, JSON.stringify(r.json));
      assert.equal((await f.partners.verify(r.json.key)).ok, true);
      assert.equal(r.json.rate_per_min, 30, "the rate a key got before billing");
    } else {
      assert.deepEqual([r.status, r.json.error.code], [409, "account_required"], mode);
    }
  }
});
test("without a billing service, accounts and plans answer 503; keys are listed and minted as before billing", async () => {
  const f = await fixture({ billing: null }), { session } = await f.login();
  assert.equal((await f.call("/plans")).json.error.code, "billing_unavailable");
  for (const [path, body] of [["/account", undefined], ["/account", { name: "Acme" }], ["/plan", { tier: "free" }], ["/payments", { tx_hash: "0x" }]]) {
    const r = await f.call(path, body, session);
    assert.equal(r.status, 503, path); assert.equal(r.json.error.code, "billing_unavailable");
  }
  assert.equal((await f.call("/keys", { name: "App" }, session)).status, 201, "nothing is metered, so nothing needs an account");
  assert.equal((await f.call("/keys", undefined, session)).status, 200);
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
