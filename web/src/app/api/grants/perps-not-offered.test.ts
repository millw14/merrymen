/**
 * PERPS SLICE 1: THE SIGNERS CAN CARRY A LIGHTER KEY, BUT NO SERVER TAKES ONE YET.
 *
 * Until the slice that lands keygen and perp-custody's intake, a grant naming
 * the perps marker, a `perp` block or a `perpRecovery` reference is refused
 * exactly as a perps-off server refuses a new opt-in (403 perp-not-offered),
 * and nothing is written.
 *
 * Self-hosted first, against grant.json. Then hosted, through the real route
 * with a real signed-in tenant and a real owner co-signature, like
 * canonical-wall.test.ts: the refusal must land before the single-use nonce is
 * spent, before the ownership read, and before the store is written.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { LocalAccount } from "viem";
import { bindingMessage, carriesOwnerKey, type StoredGrant } from "@merrymen/core";

const saved = { home: process.env.MERRYMEN_HOME, hosted: process.env.MERRYMEN_HOSTED, grant: process.env.MERRYMEN_GRANT_FILE };
let home = "";
let POST: (req: Request) => Promise<Response>;
const A = "0x00000000000000000000000000000000000000a1";
const KEY = `0x${"1a".repeat(40)}`;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-grants-perps-off-"));
  process.env.MERRYMEN_HOME = home;
  delete process.env.MERRYMEN_HOSTED;
  delete process.env.MERRYMEN_GRANT_FILE;
  ({ POST } = await import("./route"));
});
after(() => {
  for (const [k, v] of [["MERRYMEN_HOME", saved.home], ["MERRYMEN_HOSTED", saved.hosted], ["MERRYMEN_GRANT_FILE", saved.grant]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
const grantFile = () => path.join(home, "grant.json");
beforeEach(() => rmSync(grantFile(), { force: true }));
const post = (g: unknown) =>
  POST(new Request("http://localhost/api/grants", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(g) }));
const base = { smartAccount: A, serialized: "0xserialized", chainId: 4663, grantFeatures: ["tradeable-v2"] };
const perp = { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: KEY };
/**
 * A well-formed recovery reference. Its validity is beside the point: the
 * refusal is on its PRESENCE, because this server has no intake to verify it
 * against and no incident to clear with it.
 */
const perpRecovery = {
  v: 1,
  smartAccount: A,
  chainId: 4663,
  route: "perp-lighter-v1",
  accountIndex: 7,
  apiKeyIndex: 16,
  incidentId: "incident-1",
  evidenceDigest: `0x${"ee".repeat(32)}`,
  txHash: `0x${"aa".repeat(32)}`,
  userOpHash: `0x${"bb".repeat(32)}`,
  recoveryPublicKey: `0x${"4d".repeat(40)}`,
  oldPublicKey: `0x${"2b".repeat(40)}`,
  newPublicKey: KEY,
  notAfterMs: Date.now() + 60_000,
};

describe("POST /api/grants refuses perps until the intake slice lands", () => {
  for (const [what, g] of [
    ["marker and block", { ...base, grantFeatures: ["tradeable-v2", "perp-lighter-v1"], perp }],
    ["marker alone", { ...base, grantFeatures: ["tradeable-v2", "perp-lighter-v1"] }],
    ["block alone", { ...base, perp }],
    // No signer writes a recovery reference without the key it re-enables
    // (session.ts spreads it only under wallOpts.perpLighter), so this is a
    // hand-built POST. It is still refused on its own: stored unverified, it
    // would sit on the record as evidence the intake slice could later read as
    // already accepted, for an incident this server never saw.
    ["recovery reference alone", { ...base, perpRecovery }],
  ] as const) {
    it(`${what}: 403 perp-not-offered, nothing written`, async () => {
      writeFileSync(grantFile(), "{\"smartAccount\":\"0x00000000000000000000000000000000000000b2\"}\n");
      const res = await post(g);
      assert.equal(res.status, 403);
      const body = (await res.json()) as { code?: string };
      assert.equal(body.code, "perp-not-offered");
      assert.equal(readFileSync(grantFile(), "utf8"), "{\"smartAccount\":\"0x00000000000000000000000000000000000000b2\"}\n");
    });
  }
  // A feature list that is not a list of names is refused by name, never a
  // 500 from `.includes` on a number or object, and never a substring match on
  // a string that happens to contain the marker.
  for (const [what, grantFeatures] of [
    ["an object", {}],
    ["a number", 7],
    ["a string naming the marker", "perp-lighter-v1"],
    ["a list holding a non-name", ["tradeable-v2", 7]],
  ] as const) {
    it(`grantFeatures as ${what}: 400, nothing written`, async () => {
      writeFileSync(grantFile(), "{\"smartAccount\":\"0x00000000000000000000000000000000000000b2\"}\n");
      const res = await post({ ...base, grantFeatures });
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as { error: string }).error, /grant features must be a list of names/);
      assert.equal(readFileSync(grantFile(), "utf8"), "{\"smartAccount\":\"0x00000000000000000000000000000000000000b2\"}\n");
    });
  }
  it("a grant without perps is untouched by it", async () => {
    const res = await post(base);
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    assert.ok(existsSync(grantFile()));
  });
});

describe("hosted: the refusal lands before the nonce, the ownership read and the store", () => {
  // The stand-ins are the ones canonical-wall.test.ts uses, for its reason:
  // only the two Postgres-backed stores are replaced, and each one COUNTS. The
  // nonce store records whether a claim got far enough to spend its single-use
  // nonce; the grant store records the ownership read (which then fails, as the
  // last stop before a write) and any write at all.
  const ORIGIN = "https://app.merrymen.dev";
  const OWNERSHIP_UNREADABLE = "couldn't check this account's ownership — please try again";
  const HOSTED_ENV = ["MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "MERRYMEN_STORE_DEK", "DATABASE_URL", "MERRYMEN_PUBLIC_ORIGIN"] as const;
  const prior = Object.fromEntries(HOSTED_ENV.map((k) => [k, process.env[k]]));
  let auth: typeof import("@/lib/auth");
  let fixture: typeof import("@/lib/canonical-wall-fixture");
  let checkCanonicalWall: typeof import("@/lib/canonical-wall").checkCanonicalWall;
  let grants: typeof import("../../../../../worker/src/grant-store");
  let noncesSpent = 0;
  let ownershipReads = 0;
  let writes = 0;

  before(async () => {
    process.env.MERRYMEN_HOSTED = "1";
    process.env.MERRYMEN_SESSION_SECRET = "test-secret-at-least-thirty-two-characters-long";
    process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");
    process.env.DATABASE_URL = "postgres://127.0.0.1:1/never-connected";
    delete process.env.MERRYMEN_PUBLIC_ORIGIN;
    auth = await import("@/lib/auth");
    fixture = await import("@/lib/canonical-wall-fixture");
    ({ checkCanonicalWall } = await import("@/lib/canonical-wall"));
    // Through require: the route reaches these worker modules by require, and a
    // stub on the ESM instance is one the route never calls.
    const { SqlNonceStore } = createRequire(import.meta.url)("../../../../../worker/src/auth-nonce-store.ts") as typeof import("../../../../../worker/src/auth-nonce-store");
    mock.method(SqlNonceStore.prototype, "consume", async () => {
      noncesSpent += 1;
      return true;
    });
    grants = createRequire(import.meta.url)("../../../../../worker/src/grant-store.ts") as typeof import("../../../../../worker/src/grant-store");
    grants.resetGrantStoreForTest();
    mock.method(grants.getGrantStore(), "tenantForAccount", async () => {
      ownershipReads += 1;
      throw new Error("Connection terminated unexpectedly");
    });
    mock.method(grants.getGrantStore(), "put", async () => {
      writes += 1;
    });
  });
  beforeEach(() => {
    noncesSpent = 0;
    ownershipReads = 0;
    writes = 0;
  });
  after(() => {
    mock.restoreAll();
    grants?.resetGrantStoreForTest();
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** POST `grant` as a signed-in tenant, with a binding the owner key really co-signed. */
  async function hostedPost(grant: StoredGrant, owner: LocalAccount) {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const nonce = auth.issueChallengeNonce(ORIGIN);
    const message = bindingMessage({ origin: ORIGIN, nonce, owner: owner.address, smartAccount: grant.smartAccount, chainId: grant.chainId });
    const res = await POST(
      new Request(`${ORIGIN}/api/grants`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(wallet.address)}` },
        body: JSON.stringify({
          ...grant,
          binding: { nonce, walletSignature: await wallet.signMessage({ message }), ownerSignature: await owner.signMessage({ message }) },
        }),
      }),
    );
    return { status: res.status, body: (await res.json()) as { error?: string; code?: string } };
  }

  it("the harness is live: a bare grant spends its nonce and reaches the ownership read", async () => {
    // Without this, "zero nonces spent" below could be a stand-in nobody calls.
    const { grant, owner } = await fixture.signerGrant({ account: A });
    const res = await hostedPost(grant, owner);
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.equal(res.body.error, OWNERSHIP_UNREADABLE);
    assert.equal(noncesSpent, 1);
    assert.equal(ownershipReads, 1);
  });

  it("the real signer's perps grant: 403 with no nonce spent, no ownership read, nothing stored", async () => {
    const { grant, owner } = await fixture.signerGrant({ account: A, perp: { apiPublicKey: KEY as `0x${string}` } });
    // THE PREMISE: every check before the binding would pass this grant — the
    // canonical wall rebuilds a perps wall, and a 40-byte public key is not an
    // owner key. So the slice-1 refusal is the only thing between it and the
    // nonce; move the refusal later and this test sees a nonce spent.
    assert.deepEqual(checkCanonicalWall(grant as unknown as Record<string, unknown>), { ok: true }, "premise: the wall check passes it");
    assert.equal(carriesOwnerKey(grant), false, "premise: the owner-key scan passes it");
    const res = await hostedPost(grant, owner);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.code, "perp-not-offered");
    assert.equal(noncesSpent, 0, "a refused grant must not burn the single-use nonce");
    assert.equal(ownershipReads, 0, "nor read who owns the account");
    assert.equal(writes, 0, "nor write anything");
  });

  it("a bare grant carrying only a recovery reference: refused as perp-not-offered, first", async () => {
    // The reference's transaction hashes are 64 hex characters, which the
    // owner-key scan further down cannot tell from a raw private key — so
    // without this refusal ahead of it, the owner would be told their grant
    // carries an owner key. They are told the true reason instead, before
    // anything is spent, read or stored.
    const { grant, owner } = await fixture.signerGrant({ account: A });
    const res = await hostedPost({ ...grant, perpRecovery } as StoredGrant, owner);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.code, "perp-not-offered");
    assert.equal(noncesSpent, 0);
    assert.equal(ownershipReads, 0);
    assert.equal(writes, 0);
  });
});
