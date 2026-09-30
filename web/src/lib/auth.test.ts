/**
 * Wallet-native auth — the login that decides which tenant a request is.
 *
 * These test the pure core against REAL viem signatures, not mocks: a wallet
 * signs the actual challenge message, and the server recovers the address the
 * same way production does. The failure modes that matter for a money service
 * — a forged session, a replayed challenge, an expired token, a tampered
 * address — each get their own assertion, because any one of them passing is a
 * tenant boundary that isn't there.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Set BEFORE the auth functions are called (they read the secret at call time,
// not at import), so a static import is safe and the CJS test target is happy.
process.env.MERRYMEN_SESSION_SECRET = "test-secret-at-least-thirty-two-characters-long";
const testHome = mkdtempSync(join(tmpdir(), "merrymen-auth-"));
process.env.MERRYMEN_HOME = testHome;
delete process.env.DATABASE_URL;
delete process.env.MERRYMEN_HOSTED;
after(() => rmSync(testHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

import {
  challengeMessage,
  consumeChallengeNonce,
  issueChallengeNonce,
  mintSession,
  readSession,
  verifySignedChallenge,
} from "./auth";

const ORIGIN = "https://app.merrymen.dev";

async function signIn(origin = ORIGIN, now?: number) {
  const account = privateKeyToAccount(generatePrivateKey());
  const nonce = issueChallengeNonce(origin, now);
  const signature = await account.signMessage({ message: challengeMessage(origin, nonce) });
  return { account, nonce, signature };
}

test("a real wallet signature logs in as its own address", async () => {
  const { account, nonce, signature } = await signIn();
  const r = await verifySignedChallenge({ origin: ORIGIN, nonce, signature });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.address, account.address.toLowerCase(), "tenant = the recovered address, nobody else's");
});

test("a nonce is SINGLE-USE — a captured challenge cannot be replayed", async () => {
  const { nonce, signature } = await signIn();
  assert.equal((await verifySignedChallenge({ origin: ORIGIN, nonce, signature })).ok, true);
  const replay = await verifySignedChallenge({ origin: ORIGIN, nonce, signature });
  assert.equal(replay.ok, false);
  assert.equal(replay.ok === false && replay.why, "nonce already used");
});

test("concurrent replays accept exactly one signature", async () => {
  const args = { origin: ORIGIN, ...await signIn() };
  const results = await Promise.all(Array.from({ length: 8 }, () => verifySignedChallenge(args)));
  assert.equal(results.filter((result) => result.ok).length, 1);
  for (const result of results.filter((result) => !result.ok)) {
    assert.equal(result.why, "nonce already used");
  }
});

test("direct nonce consumers share the same atomic boundary", async () => {
  const nonce = issueChallengeNonce(ORIGIN);
  const results = await Promise.all(Array.from({ length: 8 }, () => consumeChallengeNonce(nonce, ORIGIN)));
  assert.equal(results.filter((result) => result.ok).length, 1);
});

test("a nonce expires at its exact deadline", async () => {
  const now = Date.now();
  const nonce = issueChallengeNonce(ORIGIN, now - 5 * 60_000);
  assert.deepEqual(await consumeChallengeNonce(nonce, ORIGIN, now), { ok: false, why: "nonce expired" });
});

test("unreadable nonce storage fails closed and can recover", async () => {
  const args = { origin: ORIGIN, ...await signIn() };
  const blockedHome = join(testHome, "not-a-directory");
  writeFileSync(blockedHome, "test fixture");
  process.env.MERRYMEN_HOME = blockedHome;
  try {
    assert.deepEqual(await verifySignedChallenge(args), {
      ok: false, why: "challenge store unavailable — please try again",
    });
  } finally {
    process.env.MERRYMEN_HOME = testHome;
  }
  assert.equal((await verifySignedChallenge(args)).ok, true);
});

test("hosted verification never falls back to instance-local storage", async () => {
  const args = { origin: ORIGIN, ...await signIn() };
  process.env.MERRYMEN_HOSTED = "1";
  try {
    assert.deepEqual(await verifySignedChallenge(args), {
      ok: false, why: "challenge store unavailable — please try again",
    });
  } finally {
    delete process.env.MERRYMEN_HOSTED;
  }
});

test("a signature for one origin does not verify at another", async () => {
  const { nonce, signature } = await signIn(ORIGIN);
  // The verifier is told a different origin; the nonce is origin-bound.
  const r = await verifySignedChallenge({ origin: "https://evil.example", nonce, signature });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.why, "nonce origin mismatch");
});

test("an expired nonce is refused even with a valid signature", async () => {
  const past = Date.now() - 10 * 60_000;
  const { nonce, signature } = await signIn(ORIGIN, past);
  const r = await verifySignedChallenge({ origin: ORIGIN, nonce, signature, now: Date.now() });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.why, "nonce expired");
});

test("a forged nonce (right shape, wrong MAC) is refused before any signature check", async () => {
  // Well-formed four fields with a base64url origin, but a MAC we made up — the
  // shape a naive forger produces without the server secret.
  const org = Buffer.from(ORIGIN).toString("base64url");
  const forged = `${Buffer.from("x").toString("base64url")}.${Date.now() + 60_000}.${org}.notarealmac`;
  const account = privateKeyToAccount(generatePrivateKey());
  const signature = await account.signMessage({ message: challengeMessage(ORIGIN, forged) });
  const r = await verifySignedChallenge({ origin: ORIGIN, nonce: forged, signature });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.why, "bad nonce signature");
});

test("a session cookie round-trips to its address", () => {
  const addr = "0x00000000000000000000000000000000000000a1" as const;
  const token = mintSession(addr);
  assert.equal(readSession(token), addr);
});

test("a tampered session address is rejected — the MAC covers it", () => {
  const addr = "0x00000000000000000000000000000000000000a1" as const;
  const token = mintSession(addr);
  const [, exp, mac] = token.split(".");
  const swapped = `0x00000000000000000000000000000000000000ff.${exp}.${mac}`;
  assert.equal(readSession(swapped), null, "you cannot keep the MAC and change the address");
});

test("an expired session is null", () => {
  const addr = "0x00000000000000000000000000000000000000a1" as const;
  const token = mintSession(addr, Date.now() - 8 * 24 * 60 * 60_000);
  assert.equal(readSession(token), null);
});

test("garbage and absent tokens are null, never a throw", () => {
  for (const t of [undefined, null, "", "a.b", "a.b.c.d", "not-a-token"]) {
    assert.equal(readSession(t as string | null | undefined), null);
  }
});

test("two logins from the same wallet mint independent, both-valid sessions", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const mk = async () => {
    const nonce = issueChallengeNonce(ORIGIN);
    const signature = await account.signMessage({ message: challengeMessage(ORIGIN, nonce) });
    return verifySignedChallenge({ origin: ORIGIN, nonce, signature });
  };
  const a = await mk();
  const b = await mk();
  assert.equal(a.ok && b.ok, true, "distinct nonces, both accepted — one wallet, many devices");
});
