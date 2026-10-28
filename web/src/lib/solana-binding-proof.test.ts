import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519";
import { base58Encode } from "../../../packages/core/src/ids";
import { issueSolanaBindingChallenge, consumeSolanaBindingProof } from "./solana-auth";

const home = mkdtempSync(join(tmpdir(), "solana-bind-proof-"));
process.env.MERRYMEN_HOME = home;
process.env.MERRYMEN_SESSION_SECRET = "solana-binding-test-only-secret-at-least-thirty-two-characters";
delete process.env.DATABASE_URL; delete process.env.MERRYMEN_HOSTED; delete process.env.MERRYMEN_PUBLIC_ORIGIN;
after(() => rmSync(home, { recursive: true, force: true }));
const req = new Request("https://app.example.test/api/solana/bind");
const principal = { tenant: `0x${"11".repeat(20)}` as const, did: "did:privy:alice" };
const seed = new Uint8Array(32).fill(24), owner = base58Encode(ed25519.getPublicKey(seed));

test("a real purpose-bound Solana proof is durably consumed exactly once", async () => {
  const challenge = issueSolanaBindingChallenge(req, principal, owner);
  const signature = base58Encode(ed25519.sign(new TextEncoder().encode(challenge.message), seed));
  const input = { owner, nonce: challenge.nonce, signature };
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => consumeSolanaBindingProof(req, principal, input)));
  assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
  // LocalNonceStore opens and closes SQLite on every consume: this retry reads
  // the spent nonce from disk rather than from a process-local used set.
  await assert.rejects(consumeSolanaBindingProof(req, principal, input), /already used/);
});
test("a forged or different-identity proof cannot consume the owner's unused nonce", async () => {
  const challenge = issueSolanaBindingChallenge(req, principal, owner);
  const signature = base58Encode(ed25519.sign(new TextEncoder().encode(challenge.message), seed));
  const input = { owner, nonce: challenge.nonce, signature };
  await assert.rejects(consumeSolanaBindingProof(req, { ...principal, did: "did:privy:bob" }, input), /did not verify/);
  await consumeSolanaBindingProof(req, principal, input);
});
