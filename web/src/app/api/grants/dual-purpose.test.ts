/**
 * ONE LOGIN, TWO WALLETS, HOSTED: POST /api/grants?wallet=perps (perps slice 5b).
 *
 * The Perps wallet is wallet authority, and every rule here is one a skipped
 * check would break:
 *
 * - it is made only while MERRYMEN_PERPS is paper (D1), and refused with
 *   nothing written otherwise — creation and renewal alike, the renewal's
 *   first step (its permission-replacement stop) included; the kill is not a
 *   renewal and still stops it;
 * - its account is the owner's own Kernel account at index 1: the owner's
 *   index-0 (Spot) account, or anyone's, is refused 403, and a derivation that
 *   cannot be made is a 503, never a pass;
 * - its claim is bound to the wallet in the signed text: a Spot binding
 *   replayed onto a Perps grant, or the reverse, is refused 403 with its nonce
 *   unspent;
 * - it is owned by the login's own wallet (D4), so a browser-key owner is
 *   refused 403 by name, before the nonce;
 * - it lands in the Perps store and nowhere else, beside a Spot grant it
 *   leaves byte for byte, and NEVER joins the public identity (D2);
 * - a store that refuses answers 409 with its code or a fixed 503, never a 500.
 *
 * Driven through the real route over the real file-backed stores (the
 * single-service hosted deploy), a real session, real Privy access tokens
 * (ES256, verified offline against a pinned key, exactly as production can be
 * configured), real owner signatures, grants sealed by the canonical-wall
 * fixture, and a stub chain whose EntryPoint derives each Kernel account from
 * its initCode, so index 0 and index 1 are two real, different addresses. Only
 * the single-use nonce store, which needs Postgres hosted, is stood in (it
 * counts what it spends).
 *
 * Adapted from the perps branch's dual-purpose.test.ts (112dbeb6) for main:
 * `?wallet=`, the store's owner rule (the branch's legacy-binding owner is
 * refused here), the store's conflict codes, and an identity that must NOT
 * gain the Perps account (the branch asserted it did).
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it, mock } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { LocalAccount } from "viem";
import { bindingMessage, type GrantPurpose, type StoredGrant } from "@merrymen/core";
import {
  RENEWAL_PERPS_OWNER_DIFFERS, RENEWAL_PERPS_UNREAD, RESTORE_PERPS_HOSTED, RESTORE_PERPS_UNREAD_HOSTED, renewalPerpsRefusal, restorePerpsRefusal,
} from "@/lib/restore-perps-owner";

const ORIGIN = "https://app.merrymen.dev";
const APP = "merrymen-test-app";
const ENV = [
  "MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "MERRYMEN_STORE_DEK", "DATABASE_URL", "MERRYMEN_PUBLIC_ORIGIN",
  "MERRYMEN_PERPS", "NEXT_PUBLIC_PRIVY_APP_ID", "PRIVY_APP_SECRET", "PRIVY_VERIFICATION_KEY",
] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

let home = "";
let route: typeof import("./route");
let auth: typeof import("@/lib/auth");
let fixture: typeof import("@/lib/canonical-wall-fixture");
let stores: typeof import("../../../../../worker/src/grant-store");
let identities: typeof import("../../../../../worker/src/identity-store");
let chain: ReturnType<typeof import("@/lib/canonical-wall-fixture").derivingChain>;
let derive: typeof import("@/lib/derive-account").deriveKernelAccountAddress;
let nonces = 0;

// ── Privy, for real: an ES256 key pair the deployment pins ───────────────────
const privy = generateKeyPairSync("ec", { namedCurve: "P-256" });
function privyToken(did: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const signed = `${b64({ alg: "ES256", typ: "JWT" })}.${b64({ sid: `s-${did}`, sub: did, iss: "privy.io", aud: APP, iat: now, exp: now + 600 })}`;
  return `${signed}.${sign("sha256", Buffer.from(signed), { key: privy.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

/** A Privy login: its embedded wallet is the session, the owner key and the tenant. */
interface Login { account: LocalAccount; did: string; spot: `0x${string}`; perps: `0x${string}` }
async function login(name: string): Promise<Login> {
  const account = privateKeyToAccount(generatePrivateKey());
  const at = async (wallet: GrantPurpose) => {
    const d = await derive(account.address, 4663, wallet);
    assert.ok(d.ok, "the stub chain derives");
    return d.address;
  };
  return { account, did: `did:privy:${name}`, spot: await at("spot"), perps: await at("perps") };
}

/** The single-use nonce store is Postgres hosted; it is stood in for the length of one POST. */
async function withNonceStore<T>(fn: () => Promise<T>): Promise<T> {
  process.env.DATABASE_URL = "postgres://127.0.0.1:1/nonces-only";
  try {
    return await fn();
  } finally {
    delete process.env.DATABASE_URL;
  }
}

/**
 * POST `grant` as `who`, under `query`, with a `privy-did-owner-v1` binding its
 * owner signed over the claim for `signedFor` (the wallet the request names,
 * unless a test replays it onto the other).
 */
async function privyPost(grant: StoredGrant, query: string, who: Login, signedFor: GrantPurpose) {
  const nonce = auth.issueChallengeNonce(ORIGIN);
  const message = bindingMessage({
    version: "privy-did-owner-v1", origin: ORIGIN, nonce, owner: grant.owner, smartAccount: grant.smartAccount,
    chainId: grant.chainId, did: who.did, purpose: signedFor,
  });
  const res = await withNonceStore(async () => route.POST(new Request(`${ORIGIN}/api/grants${query}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(who.account.address)}`,
      authorization: `Bearer ${privyToken(who.did)}`,
    },
    body: JSON.stringify({ ...grant, binding: { version: "privy-did-owner-v1", nonce, did: who.did, ownerSignature: await who.account.signMessage({ message }) } }),
  })));
  return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string; code?: string; ownerFacing?: boolean } };
}

const tenantFile = (dir: "tenants" | "tenants-perps", who: Login) => path.join(home, dir, `${who.account.address.toLowerCase()}.json`);
const read = (file: string): string | null => { try { return readFileSync(file, "utf8"); } catch { return null; } };
const perpsGrantOf = async (who: Login) => stores.getGrantStore("perps").get(who.account.address);
const perpsGrant = async (who: Login, account = who.perps, owner = who.account) =>
  (await fixture.signerGrant({ owner, account, purpose: "perps" })).grant;
const spotGrant = async (who: Login) => (await fixture.signerGrant({ owner: who.account, account: who.spot })).grant;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-grants-dual-purpose-"));
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_SESSION_SECRET = "test-secret-at-least-thirty-two-characters-long";
  process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");
  delete process.env.DATABASE_URL;
  delete process.env.MERRYMEN_PUBLIC_ORIGIN;
  process.env.MERRYMEN_PERPS = "paper";
  process.env.NEXT_PUBLIC_PRIVY_APP_ID = APP;
  // WRITTEN, never read, and so not as `process.env.PRIVY_APP_SECRET`: that
  // spelling is how privy-boundary.test.ts finds a reader of the secret, and
  // only web/src/lib/privy.ts may be one.
  Object.assign(process.env, { PRIVY_APP_SECRET: "privy-secret-for-tests" });
  process.env.PRIVY_VERIFICATION_KEY = privy.publicKey.export({ type: "spki", format: "pem" }).toString();
  // Through require: the route reaches the worker's stores by require, and a
  // stub on the ESM instance is one the route never calls. Every store is made
  // here, file-backed, before DATABASE_URL is ever set for a nonce.
  const require = createRequire(import.meta.url);
  stores = require("../../../../../worker/src/grant-store.ts") as typeof stores;
  identities = require("../../../../../worker/src/identity-store.ts") as typeof identities;
  const settings = require("../../../../../worker/src/settings-store.ts") as typeof import("../../../../../worker/src/settings-store");
  stores.resetGrantStoreForTest();
  identities.resetIdentityStoreForTest();
  settings.resetSettingsStoreForTest();
  stores.getGrantStore("spot");
  stores.getGrantStore("perps");
  identities.getIdentityStore();
  settings.getSettingsStore("spot");
  settings.getSettingsStore("perps");
  const { SqlNonceStore } = require("../../../../../worker/src/auth-nonce-store.ts") as typeof import("../../../../../worker/src/auth-nonce-store");
  mock.method(SqlNonceStore.prototype, "consume", async () => {
    nonces += 1;
    return true;
  });
  fixture = await import("@/lib/canonical-wall-fixture");
  chain = fixture.derivingChain();
  chain.install();
  auth = await import("@/lib/auth");
  ({ deriveKernelAccountAddress: derive } = await import("@/lib/derive-account"));
  route = await import("./route");
});
after(() => {
  chain?.restore();
  mock.restoreAll();
  stores?.resetGrantStoreForTest();
  identities?.resetIdentityStoreForTest();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("hosted: a Perps wallet is made beside the Spot one, and only as itself", () => {
  let alice: Login;
  before(async () => { alice = await login("alice"); });

  it("one login makes both: the Perps grant lands in the Perps store at index 1; the Spot record and the public identity do not move", async () => {
    assert.notEqual(alice.perps.toLowerCase(), alice.spot.toLowerCase(), "premise: index 1 is another account");
    const spot = await privyPost(await spotGrant(alice), "", alice, "spot");
    assert.equal(spot.status, 200, JSON.stringify(spot.body));
    const spotRecord = read(tenantFile("tenants", alice));
    const identity = await identities.getIdentityStore().get(alice.account.address);
    assert.ok(identity?.slug, "the Spot grant minted the public id");
    assert.deepEqual(identity.accounts.map((a) => a.toLowerCase()), [alice.spot.toLowerCase()]);

    const grant = await perpsGrant(alice);
    const made = await privyPost(grant, "?wallet=perps", alice, "perps");
    assert.deepEqual(made, { status: 200, body: { ok: true } });
    const stored = await perpsGrantOf(alice);
    assert.equal(stored?.smartAccount.toLowerCase(), alice.perps.toLowerCase());
    assert.equal(stored?.purpose, "perps");
    assert.equal(stored?.demoSessionPrivateKey, grant.demoSessionPrivateKey, "its own session key, sealed in its own store");
    assert.equal(read(tenantFile("tenants", alice)), spotRecord, "the Spot record is byte for byte what it was");
    assert.equal((await stores.getGrantStore("spot").get(alice.account.address))?.smartAccount.toLowerCase(), alice.spot.toLowerCase());
    // D2: THE PERPS WALLET NEVER JOINS THE PUBLIC IDENTITY.
    assert.deepEqual(await identities.getIdentityStore().get(alice.account.address), identity, "the identity is unchanged by a Perps intake");

    // A renewal replaces it, in the Perps store only.
    const renewed = await perpsGrant(alice);
    assert.equal((await privyPost(renewed, "?wallet=perps", alice, "perps")).status, 200);
    assert.equal((await perpsGrantOf(alice))?.demoSessionPrivateKey, renewed.demoSessionPrivateKey);
    assert.equal(read(tenantFile("tenants", alice)), spotRecord);
    assert.deepEqual(await identities.getIdentityStore().get(alice.account.address), identity);
  });

  it("a Spot binding replayed onto the Perps grant, and a Perps binding onto the Spot grant: 403, nonce unspent, nothing stored", async () => {
    const before = { spot: read(tenantFile("tenants", alice)), perps: read(tenantFile("tenants-perps", alice)), spent: nonces };
    const asPerps = await privyPost(await perpsGrant(alice), "?wallet=perps", alice, "spot");
    assert.equal(asPerps.status, 403, JSON.stringify(asPerps.body));
    const asSpot = await privyPost(await spotGrant(alice), "", alice, "perps");
    assert.equal(asSpot.status, 403, JSON.stringify(asSpot.body));
    assert.equal(nonces, before.spent, "a refused claim spends no nonce");
    assert.equal(read(tenantFile("tenants", alice)), before.spot);
    assert.equal(read(tenantFile("tenants-perps", alice)), before.perps);
  });

  it("D6: a Perps renewal's stopped key stays fenced — no on-chain revocation needed for the server to refuse it again", async () => {
    // The renewal's first step stops the Perps grant on the server (a
    // permission replacement naming the wallet); the stopped session key's hash
    // is retired in the Perps store, so the same grant posted again is refused,
    // whatever the chain says about the old key.
    const current = await perpsGrantOf(alice);
    assert.ok(current);
    const stop = await route.DELETE(new Request(`${ORIGIN}/api/grants?wallet=perps`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(alice.account.address)}` },
      body: JSON.stringify({ purpose: "permission-replacement", expectedTenant: alice.account.address, expectedAccount: current.smartAccount }),
    }));
    assert.equal(stop.status, 200, await stop.clone().text());
    assert.equal(await perpsGrantOf(alice), null, "the Perps key is stopped");
    assert.ok(await stores.getGrantStore("spot").get(alice.account.address), "and the Spot one is not");
    const replayed = await privyPost(current, "?wallet=perps", alice, "perps");
    assert.equal(replayed.status, 409, JSON.stringify(replayed.body));
    assert.equal(await perpsGrantOf(alice), null);
    // A fresh key renews it.
    assert.equal((await privyPost(await perpsGrant(alice), "?wallet=perps", alice, "perps")).status, 200);
  });

  it("the store's refusals answer 409 with their code, and anything else a fixed 503 — never a 500 or the error's own text", async () => {
    // owner-differs: the Spot wallet already belongs to a key made in the browser.
    const carol = await login("carol");
    const browserKey = privateKeyToAccount(generatePrivateKey());
    await stores.getGrantStore("spot").put(carol.account.address, (await fixture.signerGrant({ owner: browserKey, account: carol.spot })).grant);
    const differs = await privyPost(await perpsGrant(carol), "?wallet=perps", carol, "perps");
    assert.equal(differs.status, 409, JSON.stringify(differs.body));
    assert.equal(differs.body.code, "owner-differs");
    assert.equal(await perpsGrantOf(carol), null);

    // legacy-perps: the Spot wallet still carries the perpetuals marker.
    const dave = await login("dave");
    const legacy = await spotGrant(dave);
    await stores.getGrantStore("spot").put(dave.account.address, { ...legacy, grantFeatures: [...(legacy.grantFeatures ?? []), "perp-lighter-v1"] });
    const retired = await privyPost(await perpsGrant(dave), "?wallet=perps", dave, "perps");
    assert.equal(retired.status, 409);
    assert.equal(retired.body.code, "legacy-perps");

    // Anything else: the service failed, not the owner.
    const erin = await login("erin");
    const put = mock.method(stores.getGrantStore("perps"), "put", async () => {
      throw new Error("connect ECONNREFUSED 10.1.2.3:5432 (postgres://admin:hunter2@db.internal)");
    });
    try {
      const failed = await privyPost(await perpsGrant(erin), "?wallet=perps", erin, "perps");
      assert.equal(failed.status, 503);
      assert.equal(failed.body.ownerFacing, true);
      assert.equal(failed.body.error, "Your permission could not be saved. Please try again.");
      // It may answer a renewal or restore after that flow's own stop: never that neither wallet changed.
      assert.doesNotMatch(failed.body.error ?? "", /neither wallet/i);
      assert.doesNotMatch(JSON.stringify(failed.body), /ECONNREFUSED|hunter2|10\.1\.2\.3/);
    } finally {
      put.mock.restore();
    }
  });
});

describe("hosted: the account is the owner's own, at index 1", () => {
  it("THE OWNER'S INDEX-0 ACCOUNT UNDER wallet=perps: 403, nothing stored — the derivation alone refuses it", async () => {
    // A fresh login with no Spot grant, so no store rule stands in the way:
    // only the derivation at the Perps index tells the two accounts apart.
    const bob = await login("bob");
    const atSpot = await perpsGrant(bob, bob.spot);
    const refused = await privyPost(atSpot, "?wallet=perps", bob, "perps");
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.match(refused.body.error ?? "", /does not match|derive/i);
    assert.equal(await perpsGrantOf(bob), null);
    assert.equal(read(tenantFile("tenants-perps", bob)), null);
    // And somebody else's Perps account, signed for by bob's own key: refused too.
    const mallory = await login("mallory");
    assert.equal((await privyPost(await perpsGrant(bob, mallory.perps), "?wallet=perps", bob, "perps")).status, 403);
    assert.equal(await perpsGrantOf(bob), null);
    // The honest one goes through, so the refusals above were the account.
    assert.equal((await privyPost(await perpsGrant(bob), "?wallet=perps", bob, "perps")).status, 200);
  });

  it("A DERIVATION THAT CANNOT BE MADE: 503, nothing stored — never a pass", async () => {
    const frank = await login("frank");
    const grant = await perpsGrant(frank);
    chain.state.down = true;
    try {
      const down = await privyPost(grant, "?wallet=perps", frank, "perps");
      assert.equal(down.status, 503, JSON.stringify(down.body));
    } finally {
      chain.state.down = false;
    }
    assert.equal(await perpsGrantOf(frank), null);
    assert.equal(read(tenantFile("tenants-perps", frank)), null);
  });
});

describe("hosted: refused before anything, with nothing written", () => {
  it("PERPS OFF (unset, off, a typo, or live): creation AND renewal 403 perps-wallet-not-offered — no store, no identity, no nonce", async () => {
    const grace = await login("grace");
    assert.equal((await privyPost(await spotGrant(grace), "", grace, "spot")).status, 200);
    const identity = await identities.getIdentityStore().get(grace.account.address);
    const tryAll = async (what: string) => {
      for (const ceiling of [undefined, "off", "papr", "live", "on"]) {
        if (ceiling === undefined) delete process.env.MERRYMEN_PERPS;
        else process.env.MERRYMEN_PERPS = ceiling;
        const before = { perps: read(tenantFile("tenants-perps", grace)), spot: read(tenantFile("tenants", grace)), spent: nonces };
        const res = await privyPost(await perpsGrant(grace), "?wallet=perps", grace, "perps");
        assert.equal(res.status, 403, `${what} at ${String(ceiling)}`);
        assert.equal(res.body.code, "perps-wallet-not-offered");
        assert.match(res.body.error ?? "", /Nothing was saved/);
        assert.equal(nonces, before.spent, "no nonce spent");
        assert.equal(read(tenantFile("tenants-perps", grace)), before.perps, "the Perps store is untouched");
        assert.equal(read(tenantFile("tenants", grace)), before.spot, "and the Spot one");
        assert.deepEqual(await identities.getIdentityStore().get(grace.account.address), identity, "and the identity");
      }
      process.env.MERRYMEN_PERPS = "paper";
    };
    await tryAll("creation");
    assert.equal(await perpsGrantOf(grace), null);
    // A Perps wallet made while paper was on is not renewed once it is off.
    assert.equal((await privyPost(await perpsGrant(grace), "?wallet=perps", grace, "perps")).status, 200);
    await tryAll("renewal");
  });

  it("PERPS OFF: a Perps renewal's FIRST STEP is refused too — the stop changes nothing, and the kill still stops the wallet", async () => {
    // THE STATE THIS CLOSES: the renewal's stop (a permission replacement on
    // ?wallet=perps) was accepted with perps off, the Perps key was stopped and
    // retired, and the POST that should have followed was refused 403. The
    // owner was left with a stopped Perps wallet nobody could renew until the
    // lever came back. A renewal that cannot finish must not start.
    const nina = await login("nina");
    assert.equal((await privyPost(await spotGrant(nina), "", nina, "spot")).status, 200);
    assert.equal((await privyPost(await perpsGrant(nina), "?wallet=perps", nina, "perps")).status, 200);
    const held = await perpsGrantOf(nina);
    assert.ok(held);
    const del = (query: string, body: Record<string, unknown>) => route.DELETE(new Request(`${ORIGIN}/api/grants${query}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(nina.account.address)}` },
      body: JSON.stringify({ expectedTenant: nina.account.address, ...body }),
    }));
    const before = { perps: read(tenantFile("tenants-perps", nina)), spot: read(tenantFile("tenants", nina)) };
    try {
      for (const ceiling of [undefined, "off", "papr", "live"]) {
        if (ceiling === undefined) delete process.env.MERRYMEN_PERPS;
        else process.env.MERRYMEN_PERPS = ceiling;
        const res = await del("?wallet=perps", { purpose: "permission-replacement", expectedAccount: held.smartAccount, expectedSession: held.sessionKeyAddress });
        assert.equal(res.status, 403, String(ceiling));
        const body = (await res.json()) as { code?: string; error?: string; ownerFacing?: boolean };
        assert.equal(body.code, "perps-wallet-not-offered");
        assert.equal(body.ownerFacing, true);
        assert.match(body.error ?? "", /was not stopped[\s\S]*Nothing was changed/);
        assert.equal(read(tenantFile("tenants-perps", nina)), before.perps, `the Perps record is byte for byte what it was (${String(ceiling)})`);
        assert.equal(read(tenantFile("tenants", nina)), before.spot, "and the Spot one");
        assert.equal((await perpsGrantOf(nina))?.demoSessionPrivateKey, held.demoSessionPrivateKey, "the Perps key still signs");
      }
      // The kill is not a renewal: it names no wallet and stops the Perps one
      // whatever the lever says.
      delete process.env.MERRYMEN_PERPS;
      const kill = await del("", { purpose: "delete-agent" });
      const killed = await kill.text();
      assert.equal(kill.status, 200, killed);
      assert.deepEqual(JSON.parse(killed), { ok: true, perps: "stopped" });
      assert.equal(await perpsGrantOf(nina), null);
      assert.equal(await stores.getGrantStore("spot").get(nina.account.address), null);
    } finally {
      process.env.MERRYMEN_PERPS = "paper";
    }
  });

  it("D4: a Perps wallet owned by a key made in the browser: 403 perps-owner, by name, before the nonce", async () => {
    const heidi = await login("heidi");
    const browserKey = privateKeyToAccount(generatePrivateKey());
    const d = await derive(browserKey.address, 4663, "perps");
    assert.ok(d.ok);
    const grant = await perpsGrant(heidi, d.address, browserKey);
    // A legacy binding: the login authorizes, the browser key co-signs.
    const nonce = auth.issueChallengeNonce(ORIGIN);
    const message = bindingMessage({ origin: ORIGIN, nonce, owner: browserKey.address, smartAccount: grant.smartAccount, chainId: 4663, purpose: "perps" });
    const spent = nonces;
    const res = await withNonceStore(async () => route.POST(new Request(`${ORIGIN}/api/grants?wallet=perps`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(heidi.account.address)}` },
      body: JSON.stringify({ ...grant, binding: { nonce, walletSignature: await heidi.account.signMessage({ message }), ownerSignature: await browserKey.signMessage({ message }) } }),
    })));
    assert.equal(res.status, 403);
    const body = (await res.json()) as { code?: string; error?: string; ownerFacing?: boolean };
    assert.equal(body.code, "perps-owner");
    assert.equal(body.ownerFacing, true);
    assert.match(body.error ?? "", /owned by the wallet you sign in with/);
    assert.equal(nonces, spent);
    assert.equal(await perpsGrantOf(heidi), null);
  });

  it("a Perps wallet on any chain but Robinhood Chain mainnet: 400 perps-chain, before the nonce", async () => {
    const ivan = await login("ivan");
    const spent = nonces;
    const res = await privyPost({ ...(await perpsGrant(ivan)), chainId: 46630 }, "?wallet=perps", ivan, "perps");
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "perps-chain");
    assert.equal(nonces, spent);
    assert.equal(await perpsGrantOf(ivan), null);
  });

  it("a Perps grant sealed over the Spot wall: 400 invalid_wall, before the nonce", async () => {
    const judy = await login("judy");
    const grant = await perpsGrant(judy);
    const overSpot = await fixture.resealed(grant, judy.account, { perpsOnly: false });
    const spent = nonces;
    const res = await privyPost(overSpot, "?wallet=perps", judy, "perps");
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "invalid_wall");
    assert.equal(nonces, spent);
    assert.equal(await perpsGrantOf(judy), null);
  });
});

describe("hosted: GET ?wallet=perps answers for the Perps wallet, and only it", () => {
  let kim: Login;
  let grant: StoredGrant;
  const get = (who: Login | null, query: string) =>
    route.GET(new Request(`${ORIGIN}/api/grants${query}`, who ? { headers: { cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(who.account.address)}` } } : {}));
  before(async () => {
    kim = await login("kim");
    assert.equal((await privyPost(await spotGrant(kim), "", kim, "spot")).status, 200);
    grant = await perpsGrant(kim);
    assert.equal((await privyPost(grant, "?wallet=perps", kim, "perps")).status, 200);
    // The ledger the hosted GET reads: hosted it is the shared Postgres; with
    // no DATABASE_URL (this file-backed deploy) each wallet's read opens its
    // own home's sqlite file (ledger.ts withReadDb).
    const { wrapSqlite } = await import("../../../../../worker/src/db");
    const { applyLedgerSchema } = await import("../../../../../worker/src/store");
    for (const dir of [home, path.join(home, "accounts", "perps")]) {
      mkdirSync(dir, { recursive: true });
      const raw = new DatabaseSync(path.join(dir, "merrymen.db"));
      try { await applyLedgerSchema(wrapSqlite(raw)); } finally { raw.close(); }
    }
  });

  it("the Perps grant through the allowlist, no-store, with the tenant echoed; Spot's answer is its own", async () => {
    const res = await get(kim, "?wallet=perps");
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown> & { grant: Record<string, unknown> };
    assert.equal(body.exists, true);
    assert.equal(body.tenant, kim.account.address.toLowerCase());
    assert.equal(String(body.grant.smartAccount).toLowerCase(), kim.perps.toLowerCase());
    assert.equal(body.grant.purpose, "perps");
    assert.deepEqual(body.grant.binding, { version: "privy-did-owner-v1" }, "the binding's version, and nothing else of it");
    assert.equal("energy" in body, false, "a Perps wallet buys no energy");
    assert.equal(body.perps, null, "no report yet is null, never an empty book");
    for (const secret of [grant.demoSessionPrivateKey, grant.serialized, kim.did]) {
      assert.ok(!text.toLowerCase().includes(String(secret).replace(/^0x/, "").toLowerCase()), "no secret, nonce or DID in the Perps answer");
    }
    assert.equal(body.grant.serialized, undefined);

    const spot = await get(kim, "");
    const spotBody = (await spot.json()) as { grant: Record<string, unknown> };
    assert.equal(String(spotBody.grant.smartAccount).toLowerCase(), kim.spot.toLowerCase(), "the Spot answer is the Spot wallet's");
    assert.equal(spotBody.grant.purpose, undefined);
    // D3: Spot keeps main's denylist view, binding and all.
    assert.equal((spotBody.grant.binding as { did?: string }).did, kim.did);
  });

  it("never another tenant's: a login with no Perps wallet, or none at all, reads none", async () => {
    const leo = await login("leo");
    assert.deepEqual(await (await get(leo, "?wallet=perps")).json(), { exists: false, tenant: leo.account.address.toLowerCase() });
    // A Spot wallet is not a Perps one, stored or shown: no `stored`, and the Wallet screen's restore goes ahead.
    assert.equal((await privyPost(await spotGrant(leo), "", leo, "spot")).status, 200);
    assert.deepEqual(await (await get(leo, "?wallet=perps")).json(), { exists: false, tenant: leo.account.address.toLowerCase() });
    const viaGet = (async (url: string | URL | Request) => get(leo, String(url).replace(/^\/api\/grants/, ""))) as typeof fetch;
    assert.equal(await restorePerpsRefusal(privateKeyToAccount(generatePrivateKey()).address, viaGet), null);
    const out = await get(null, "?wallet=perps");
    assert.deepEqual(await out.json(), { exists: false, tenant: null });
    assert.equal(out.headers.get("cache-control"), "private, no-store");
  });

  it("A PERPS RECORD STOPPED FOR A RENEWAL is `stored`, never none: the Spot put still holds a Spot grant to it, so the Wallet screen's restore and renewal ask it through the login", async () => {
    const mia = await login("mia");
    const current = await perpsGrant(mia);
    assert.equal((await privyPost(current, "?wallet=perps", mia, "perps")).status, 200);
    const viaGet = (async (url: string | URL | Request) => get(mia, String(url).replace(/^\/api\/grants/, ""))) as typeof fetch;
    // Shown, the hosted Perps wallet refuses every restore, the login's own key included (the legacy binding refuses that key).
    assert.equal(await restorePerpsRefusal(mia.account.address, viaGet), RESTORE_PERPS_HOSTED);
    const stop = await route.DELETE(new Request(`${ORIGIN}/api/grants?wallet=perps`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(mia.account.address)}` },
      body: JSON.stringify({ purpose: "permission-replacement", expectedTenant: mia.account.address, expectedAccount: current.smartAccount }),
    }));
    assert.equal(stop.status, 200, await stop.clone().text());
    assert.equal(await perpsGrantOf(mia), null, "set-up: the store will not show it");
    const body = await (await get(mia, "?wallet=perps")).json();
    assert.deepEqual(body, { exists: false, tenant: mia.account.address.toLowerCase(), stored: true });
    // The Wallet screen's restore and renewal read exactly this answer.
    const legacyKey = privateKeyToAccount(generatePrivateKey()).address;
    assert.equal(await restorePerpsRefusal(legacyKey, viaGet), RESTORE_PERPS_HOSTED, "another owner key is refused before its stop and revocation");
    assert.equal(await restorePerpsRefusal(mia.account.address, viaGet), RESTORE_PERPS_HOSTED, "and so is the login's own");
    assert.equal(await renewalPerpsRefusal(mia.account.address, mia.account.address, viaGet), null, "a Spot renewal re-signed by the login goes ahead");
    assert.equal(await renewalPerpsRefusal(legacyKey, legacyKey, viaGet), RENEWAL_PERPS_OWNER_DIFFERS, "a legacy-owned Spot grant's renewal beside it is refused first");
    // And the store's put does hold a Spot grant to that record: another owner key is refused there too.
    const spotUnderLegacy = (await fixture.signerGrant({ owner: privateKeyToAccount(generatePrivateKey()), account: mia.spot })).grant;
    await assert.rejects(stores.getGrantStore("spot").put(mia.account.address, spotUnderLegacy), /same owner key/);
  });

  it("ON THE FILE STORE, A PERPS RECORD THE SPOT PUT WOULD REFUSE ON is a 503, never `stored`: the restore and the renewal are refused before their stop", async () => {
    const nia = await login("nia");
    assert.equal((await privyPost(await spotGrant(nia), "", nia, "spot")).status, 200);
    assert.equal((await privyPost(await perpsGrant(nia), "?wallet=perps", nia, "perps")).status, 200);
    const tenant = nia.account.address.toLowerCase();
    const perpsFile = path.join(home, "tenants-perps", `${tenant}.json`);
    const record = JSON.parse(readFileSync(perpsFile, "utf8")) as { grant: Record<string, unknown> };
    const viaGet = (async (url: string | URL | Request) => get(nia, String(url).replace(/^\/api\/grants/, ""))) as typeof fetch;
    try {
      for (const [what, text] of [
        ["truncated", "{ truncated"],
        ["naming the Spot wallet", readFileSync(path.join(home, "tenants", `${tenant}.json`), "utf8")],
        // Stopped for a renewal (so `get` hides it), and owned by another key than the login: compared through the
        // tenant it would pass for the login's own.
        ["stopped for a renewal, owned by another key than the login", JSON.stringify({ ...record, grant: {
          ...record.grant, owner: privateKeyToAccount(generatePrivateKey()).address,
          replacementStop: { sessionKeyHash: "0".repeat(64), sessionKeyAddress: record.grant.sessionKeyAddress, stoppedAt: 1 },
        } })],
      ] as const) {
        writeFileSync(perpsFile, text);
        const res = await get(nia, "?wallet=perps");
        assert.equal(res.status, 503, `${what}: ${await res.clone().text()}`);
        assert.equal(await restorePerpsRefusal(nia.account.address, viaGet, true), RESTORE_PERPS_UNREAD_HOSTED, `${what}: the login's own key too, before its stop`);
        assert.equal(await renewalPerpsRefusal(nia.account.address, nia.account.address, viaGet), RENEWAL_PERPS_UNREAD, `${what}: the renewal too, before its stop`);
        await assert.rejects(stores.getGrantStore("spot").put(nia.account.address, (await fixture.signerGrant({ owner: nia.account, account: nia.spot })).grant),
          Error, `${what}: which is what the Spot put does after the stop`);
      }
    } finally {
      writeFileSync(perpsFile, JSON.stringify(record));
    }
    assert.equal(((await (await get(nia, "?wallet=perps")).json()) as { exists?: boolean }).exists, true, "the record put back reads again");
  });

  it("D1: answered whatever MERRYMEN_PERPS says, so an owner can always see a Perps wallet they hold", async () => {
    for (const ceiling of [undefined, "off", "live"]) {
      if (ceiling === undefined) delete process.env.MERRYMEN_PERPS;
      else process.env.MERRYMEN_PERPS = ceiling;
      const body = (await (await get(kim, "?wallet=perps")).json()) as { exists?: boolean; grant?: { smartAccount?: string } };
      assert.equal(body.exists, true, String(ceiling));
      assert.equal(body.grant?.smartAccount?.toLowerCase(), kim.perps.toLowerCase());
    }
    process.env.MERRYMEN_PERPS = "paper";
  });

  it("and the kill made for it stops it: the Perps wallet made here is revoked with the Spot one", async () => {
    const res = await route.DELETE(new Request(`${ORIGIN}/api/grants`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(kim.account.address)}` },
      body: JSON.stringify({ purpose: "delete-agent", expectedTenant: kim.account.address }),
    }));
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(await perpsGrantOf(kim), null);
    assert.equal(await stores.getGrantStore("spot").get(kim.account.address), null);
    assert.ok(readdirSync(path.join(home, "tenants-perps")).length > 0, "other logins' Perps wallets are untouched");
  });
});
