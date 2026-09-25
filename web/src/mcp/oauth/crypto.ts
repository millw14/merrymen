/**
 * The only cryptography the MCP authorization server does, all of it standard:
 *
 * - credentials are 256-bit values from the OS CSPRNG, base64url-encoded;
 * - they are stored as SHA-256 hashes (a 256-bit random value needs no salt or
 *   slow hash — it cannot be guessed, only stolen, and the hash is useless);
 * - PKCE is RFC 7636 S256: BASE64URL(SHA256(ASCII(code_verifier))) compared in
 *   constant time.
 *
 * Access tokens are opaque and looked up on every request, so revocation is
 * immediate and no token-signing key exists that could be stolen or confused
 * with the dashboard's session secret.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function randomCredential(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString("base64url")}`;
}

export function randomId(prefix: string): string {
  return `${prefix}${randomBytes(16).toString("hex")}`;
}

export function sha256hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/** RFC 7636 §4.1: 43-128 characters from the unreserved set. */
export const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
/** An S256 challenge is the base64url SHA-256: exactly 43 characters. */
export const PKCE_CHALLENGE = /^[A-Za-z0-9\-_]{43}$/;

export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function verifyPkce(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== "string" || !PKCE_VERIFIER.test(verifier)) return false;
  return constantTimeEqual(pkceS256(verifier), challenge);
}
