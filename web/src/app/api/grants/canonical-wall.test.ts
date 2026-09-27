/**
 * HOSTED POST /api/grants STORES THE MERRYMEN WALL, OR NOTHING.
 *
 * Driven through the real route in hosted mode with real signatures, like
 * owner-facing.test.ts: the tenant's wallet authorizes, the owner key
 * co-signs, and the permission is built by the real packages. Only the two
 * Postgres-backed stores are stood in for — the nonce store, which records
 * whether a claim got far enough to spend its nonce, and the grant store's
 * ownership read, which records whether the claim got past every check before
 * it and then fails, so nothing is ever written.
 *
 * The attack is a tenant using their own owner key to enable a permission the
 * canonical wall does not contain. The chain would install it. The route is the
 * only thing that can keep it out of the worker, and it must do so before the
 * nonce is spent.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, it, mock } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { LocalAccount } from "viem";
import { bindingMessage, type StoredGrant } from "@merrymen/core";
import { resealed, signerGrant } from "@/lib/canonical-wall-fixture";

const ORIGIN = "https://app.merrymen.dev";
const SMART = "0x00000000000000000000000000000000000000a1" as const;
const ATTACKER = "0x000000000000000000000000000000000000bad1" as const;
const OWNERSHIP_UNREADABLE = "couldn't check this account's ownership — please try again";

const saved = Object.fromEntries(
  ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_PUBLIC_ORIGIN", "MERRYMEN_STORE_DEK"].map((k) => [k, process.env[k]]),
);
let home: string;
let POST: (req: Request) => Promise<Response>;
let auth: typeof import("@/lib/auth");
let noncesSpent = 0;
let ownershipReads = 0;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-grants-wall-"));
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_SESSION_SECRET = "test-secret-at-least-thirty-two-characters-long";
  process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");
  process.env.DATABASE_URL = "postgres://127.0.0.1:1/never-connected";
  delete process.env.MERRYMEN_PUBLIC_ORIGIN;
  auth = await import("@/lib/auth");
  // Through require, for the reason owner-facing.test.ts gives: the route
  // reaches these worker modules by require, and a stub on the ESM instance is
  // one the route never calls.
  const { SqlNonceStore } = createRequire(import.meta.url)("../../../../../worker/src/auth-nonce-store.ts") as typeof import("../../../../../worker/src/auth-nonce-store");
  mock.method(SqlNonceStore.prototype, "consume", async () => {
    noncesSpent += 1;
    return true;
  });
  const grants = createRequire(import.meta.url)("../../../../../worker/src/grant-store.ts") as typeof import("../../../../../worker/src/grant-store");
  grants.resetGrantStoreForTest();
  mock.method(grants.getGrantStore(), "tenantForAccount", async () => {
    ownershipReads += 1;
    throw new Error("Connection terminated unexpectedly");
  });
  ({ POST } = await import("./route"));
});
beforeEach(() => {
  noncesSpent = 0;
  ownershipReads = 0;
});
after(() => {
  mock.restoreAll();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** POST `grant` as a signed-in tenant, with a binding the owner key really co-signed. */
async function post(grant: StoredGrant, owner: LocalAccount) {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const nonce = auth.issueChallengeNonce(ORIGIN);
  const message = bindingMessage({ origin: ORIGIN, nonce, owner: owner.address, smartAccount: grant.smartAccount, chainId: grant.chainId });
  const body = {
    ...grant,
    binding: { nonce, walletSignature: await wallet.signMessage({ message }), ownerSignature: await owner.signMessage({ message }) },
  };
  const res = await POST(
    new Request(`${ORIGIN}/api/grants`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(wallet.address)}` },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as { error?: string; code?: string } };
}

it("a grant from the real signer passes the wall check and every check after it", async () => {
  const { grant, owner } = await signerGrant({ account: SMART });
  const res = await post(grant, owner);
  // The stand-in ownership read is the last stop before a write, so reaching
  // it means the wall, the caps and the binding all accepted this grant.
  assert.equal(res.status, 503, JSON.stringify(res.body));
  assert.equal(res.body.error, OWNERSHIP_UNREADABLE);
  assert.equal(noncesSpent, 1);
  assert.equal(ownershipReads, 1);
});

it("an owner-enabled permission with an extra USDG transfer is refused before its nonce is spent", async () => {
  const { grant, owner } = await signerGrant({ account: SMART });
  const drained = await resealed(grant, owner, { withdrawalAddresses: [ATTACKER] });
  const res = await post(drained, owner);
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.code, "invalid_wall");
  assert.match(res.body.error ?? "", /does not implement the advertised Merrymen limits/);
  assert.match(res.body.error ?? "", /reload it and sign again/);
  assert.equal(noncesSpent, 0, "a refused wall must not burn the single-use nonce");
  assert.equal(ownershipReads, 0);
});

it("a legacy transfer marker is refused, whatever the permission underneath", async () => {
  const { grant, owner } = await signerGrant({ account: SMART });
  const res = await post({ ...grant, grantFeatures: [...(grant.grantFeatures ?? []), "transfer"] }, owner);
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.code, "invalid_grant");
  assert.match(res.body.error ?? "", /"transfer"/);
  assert.equal(noncesSpent, 0);
});

it("the Rialto target and the v4 UniversalRouter are refused the same way", async () => {
  const { grant, owner } = await signerGrant({ account: SMART });
  for (const change of [{ allowRialto: true }, { allowUniswapV4: true }]) {
    const res = await post(await resealed(grant, owner, change), owner);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, "invalid_wall");
  }
  assert.equal(noncesSpent, 0);
});
