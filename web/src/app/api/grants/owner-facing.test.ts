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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, it, mock } from "node:test";
import { encodeErrorResult, toFunctionSelector } from "viem";
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
  mock.method(grants.getGrantStore("spot"), "tenantForAccount", async () => {
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

/**
 * The real derivation still runs, but its EntryPoint view call is answered
 * offline. No network or signing authority is needed to reach the store.
 * Returns the stub, so a test can put fetch back before the signer reads.
 */
function answerDerivationOffline(t: import("node:test").TestContext) {
  const result = encodeErrorResult({
    abi: [{ type: "error", name: "SenderAddressResult", inputs: [{ name: "sender", type: "address" }] }],
    errorName: "SenderAddressResult",
    args: [SMART],
  });
  return t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body));
    const answer = (rpc: { id: number; method: string; params: [{ data?: string }] }) => {
      if (rpc.method === "eth_chainId") return { jsonrpc: "2.0", id: rpc.id, result: `0x${CHAIN.toString(16)}` };
      assert.equal(rpc.method, "eth_call");
      assert.ok(rpc.params[0].data?.startsWith(toFunctionSelector("getSenderAddress(bytes)")));
      return { jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: "execution reverted", data: result } };
    };
    return Response.json(Array.isArray(payload) ? payload.map(answer) : answer(payload));
  });
}

it("a full replacement history is an owner-facing 409 that explains the support path", async t => {
  const grants = createRequire(import.meta.url)("../../../../../worker/src/grant-store.ts") as typeof import("../../../../../worker/src/grant-store");
  const store = grants.getGrantStore("spot");
  t.mock.method(store, "tenantForAccount", async () => null);
  t.mock.method(store, "put", async () => { throw new grants.GrantReplacementConflict(); });
  answerDerivationOffline(t);
  const res = await POST(await claim());
  const body = await res.json() as { error?: string; ownerFacing?: unknown };
  assert.equal(res.status, 409, JSON.stringify(body));
  assert.equal(body.ownerFacing, true);
  assert.match(body.error ?? "", /history is full.*contact support/);
});

// ── what the browser signer shows for those 503s (session.ts postGrant) ─────
//
// The signer that hands a grant over — every web mint, the iOS create engine
// (createPrivyOwnedWallet, bundled from session.ts) and a retried handoff —
// reads a refusal through refusalMessage. Its 503 arm said "Couldn't verify
// the account on-chain" for EVERY 503, so the two owner-facing 503s above were
// thrown away: a Spot owner whose permission the store could not save (the
// other wallet's grant could not be read or verified, the lock was busy, the
// database failed — a 500 carrying the store's own text before PR 1) was told
// the chain had failed, and kept signing again for a fault that was never the
// chain's. The route's real answer is handed to the real postGrant here.

/** postGrant on `res`, reached as a retried handoff of a grant that carries no binding (session.ts retryGrantHandoff). */
async function signerShows(t: import("node:test").TestContext, res: Response, grant: Record<string, unknown>) {
  const { retryGrantHandoff } = await import("@/lib/session");
  const asked: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => (asked.push(String(input)), res));
  const handoff = await retryGrantHandoff(grant as never);
  assert.deepEqual(asked, ["/api/grants"], "the Spot grant went to the Spot wallet's intake, and only there");
  return handoff;
}

const ON_CHAIN = "Couldn't verify the account on-chain just now — try again in a moment.";
const NOT_SAVED = "Your permission could not be saved, and neither wallet was changed. Please try again.";

it("A STORE WRITE THAT FAILED WITH A PLAIN ERROR: a redacted owner-facing 503, and the signer shows THAT sentence, never the on-chain one", async t => {
  const grants = createRequire(import.meta.url)("../../../../../worker/src/grant-store.ts") as typeof import("../../../../../worker/src/grant-store");
  const store = grants.getGrantStore("spot");
  t.mock.method(store, "tenantForAccount", async () => null);
  // One of the store's own plain Errors (grant-store.ts assertIndependentWallets'
  // reader): the login's Perps record would not verify.
  t.mock.method(store, "put", async () => {
    throw new Error("Your other wallet's grant could not be verified. Neither wallet was changed.");
  });
  const rpc = answerDerivationOffline(t);
  const req = await claim();
  const { binding: _binding, ...grant } = (await req.clone().json()) as Record<string, unknown>;
  const res = await POST(req);
  rpc.mock.restore();
  const body = (await res.clone().json()) as { error?: string; ownerFacing?: unknown };
  assert.equal(res.status, 503, JSON.stringify(body));
  assert.deepEqual(body, { error: NOT_SAVED, ownerFacing: true }, "the store's text is never sent: it can name the database");
  const again = res.clone();
  const handoff = await signerShows(t, res, grant);
  assert.deepEqual(handoff, { ok: false, error: NOT_SAVED });
  assert.notEqual(handoff.ok ? "" : handoff.error, ON_CHAIN);
  // THE WALLET SCREEN'S RE-ARM, the other grant POST, reads the same answer
  // the same way (session.ts refusalOfResponse). Its own copy of the read once
  // dropped the marker in a revert that every suite let through.
  const { refusalOfResponse } = await import("@/lib/session");
  assert.equal(await refusalOfResponse(again), NOT_SAVED);
  const wallet = readFileSync(path.join(process.cwd(), "web", "src", "terminal", "screens", "Wallet.tsx"), "utf8");
  assert.match(wallet, /setError\(await refusalOfResponse\(r\)\);/, "the re-arm shows refusalOfResponse's sentence");
  assert.doesNotMatch(wallet, /refusalMessage\(/, "and reads no refusal by hand");
});

it("and the ownership read that could not run reaches the signer in its own words", async t => {
  const req = await claim();
  const { binding: _binding, ...grant } = (await req.clone().json()) as Record<string, unknown>;
  const res = await POST(req);
  assert.equal(res.status, 503);
  assert.deepEqual(await signerShows(t, res, grant), { ok: false, error: OWNERSHIP_UNREADABLE });
});
