/**
 * AN OWNERSHIP CHECK THAT COULD NOT RUN IS TOLD TO THE OWNER IN WORDS.
 *
 * First claim wins: a grant for an account another login already holds is
 * refused, and a grant store that cannot be read refuses too, rather than
 * assume the account is free. That refusal is a 503, and the shell shows a 5xx
 * body only when the route marked it `ownerFacing` (terminal/request-json.ts).
 * Unmarked, the owner who just signed a grant is told "merrymen answered with
 * an error (503)" and nothing about trying again.
 *
 * Driven through POST in hosted mode with real signatures, so the claim
 * passes the real binding check and reaches the ownership read. Only the two
 * Postgres-backed stores are stood in for: the nonce store (hosted refuses a
 * local one) and the grant store's read, which is made to fail.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, it, mock } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bindingMessage } from "@merrymen/core";
import { signerGrant } from "@/lib/canonical-wall-fixture";

const ORIGIN = "https://app.merrymen.dev";
const SMART = "0x00000000000000000000000000000000000000a1" as const;
const CHAIN = 4663;
const OWNERSHIP_UNREADABLE = "couldn't check this account's ownership — please try again";

const saved = Object.fromEntries(
  ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_PUBLIC_ORIGIN", "MERRYMEN_STORE_DEK"].map((k) => [k, process.env[k]]),
);
let home: string;
let POST: (req: Request) => Promise<Response>;
let auth: typeof import("@/lib/auth");

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-grants-owner-facing-"));
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_SESSION_SECRET = "test-secret-at-least-thirty-two-characters-long";
  // Hosted stores refuse to hold secrets in the clear.
  process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");
  // Never connected to: both stores that would use it are stood in for below.
  process.env.DATABASE_URL = "postgres://127.0.0.1:1/never-connected";
  delete process.env.MERRYMEN_PUBLIC_ORIGIN;
  auth = await import("@/lib/auth");
  // THROUGH require, ON PURPOSE. The route reaches these worker modules by
  // require, and the ESM loader keeps a second instance of the same file: a
  // stub on that one is a stub the route never calls, and the claim fails at
  // the nonce store instead of reaching the ownership read.
  const { SqlNonceStore } = createRequire(import.meta.url)("../../../../../worker/src/auth-nonce-store.ts") as typeof import("../../../../../worker/src/auth-nonce-store");
  mock.method(SqlNonceStore.prototype, "consume", async () => true);
  const grants = createRequire(import.meta.url)("../../../../../worker/src/grant-store.ts") as typeof import("../../../../../worker/src/grant-store");
  grants.resetGrantStoreForTest();
  mock.method(grants.getGrantStore(), "tenantForAccount", async () => {
    throw new Error("Connection terminated unexpectedly");
  });
  ({ POST } = await import("./route"));
});
after(() => {
  mock.restoreAll();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** A hosted grant a signed-in wallet legitimately claims: the wallet authorizes, the owner key co-signs. */
async function claim() {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const owner = privateKeyToAccount(generatePrivateKey());
  const nonce = auth.issueChallengeNonce(ORIGIN);
  const message = bindingMessage({ origin: ORIGIN, nonce, owner: owner.address, smartAccount: SMART, chainId: CHAIN });
  // A REAL PERMISSION, because the route now refuses anything that is not the
  // canonical wall before it reaches the ownership read this file is about.
  const { grant: signed } = await signerGrant({ account: SMART, owner });
  const grant = {
    ...signed,
    binding: {
      nonce,
      walletSignature: await wallet.signMessage({ message }),
      ownerSignature: await owner.signMessage({ message }),
    },
  };
  return new Request(`${ORIGIN}/api/grants`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(wallet.address)}`,
    },
    body: JSON.stringify(grant),
  });
}

it("an unreadable grant store refuses the claim, marked as written for the owner", async () => {
  const res = await POST(await claim());
  const body = (await res.json()) as { error?: string; ownerFacing?: unknown };
  assert.equal(res.status, 503, JSON.stringify(body));
  assert.equal(body.error, OWNERSHIP_UNREADABLE);
  assert.equal(body.ownerFacing, true);
});

it("and the shell shows the owner that sentence, not a bare status", async () => {
  const { requestJson } = await import("@/terminal/request-json");
  const res = await POST(await claim());
  const fetch = mock.method(globalThis, "fetch", async () => res);
  try {
    await assert.rejects(requestJson("/api/grants", { method: "POST" }), (e: Error) => {
      assert.equal(e.message, OWNERSHIP_UNREADABLE);
      return true;
    });
  } finally {
    fetch.mock.restore();
  }
});
