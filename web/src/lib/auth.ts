/**
 * Wallet-native authentication for HOSTED mode.
 *
 * The tenant IS a wallet address. The browser holds the owner key (exactly as
 * today — it never leaves the device), signs a one-time challenge, and the
 * server recovers the address from the signature. That recovered address is
 * the tenant id, and every mutating route authorizes on IT — never on any
 * self-declared field, because a tenant that could name its own id could
 * install a grant under someone else's account.
 *
 * NO PASSWORDS, NO EMAIL, NO PII. The signature proves control of the key;
 * that is the entire login. A session is a short HMAC-signed cookie carrying
 * the address and an expiry — stateless, so it verifies with no database
 * round-trip, and unforgeable without the server secret.
 *
 * The pure functions here (mint/read/verify) take no Next types so they can be
 * unit-tested against real viem signatures; the request-shaped helpers wrap
 * them for route handlers.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { recoverMessageAddress } from "viem";
import { bindingMessage, sessionSecret } from "@merrymen/core";

/** Challenge nonces live this long. Long enough to sign, short enough to not linger. */
const CHALLENGE_TTL_MS = 5 * 60_000;
/** A session cookie is good for this long before the wallet must re-sign. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
export const SESSION_COOKIE = "mm_session";

function secretOrThrow(): string {
  const s = sessionSecret();
  if (!s) {
    // Boot-time refusal, surfaced as a 500 rather than a silent default — a
    // predictable signing key is a forged session for every tenant.
    throw new Error("MERRYMEN_SESSION_SECRET is not set (hosted mode requires a 32+ char secret)");
  }
  return s;
}

function hmac(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Constant-time compare of two base64url MACs. */
function macEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ── challenge ──────────────────────────────────────────────────────────────

/**
 * A signed, self-describing challenge nonce.
 *
 * The nonce carries its own expiry and origin, HMAC'd so it cannot be forged
 * or its expiry extended. Single-use is enforced separately (see usedNonces):
 * the signature stops forgery, the used-set stops replay.
 */
export function issueChallengeNonce(origin: string, now = Date.now()): string {
  const exp = now + CHALLENGE_TTL_MS;
  const rand = randomBytes(16).toString("base64url");
  // The origin is base64url-encoded before it enters the dot-delimited nonce —
  // a real origin ("https://app.merrymen.dev") is full of dots and would
  // otherwise split into extra fields and read as malformed.
  const org = Buffer.from(origin).toString("base64url");
  const body = `${rand}.${exp}.${org}`;
  return `${body}.${hmac(body, secretOrThrow())}`;
}

/** Nonces already spent, so a captured challenge can't be replayed into a login. */
const usedNonces = new Set<string>();

/**
 * The human-readable message the wallet signs (EIP-4361 shape, trimmed).
 *
 * Binds the origin and the nonce into the signed text, so a signature captured
 * for one site cannot be replayed at another.
 */
export function challengeMessage(origin: string, nonce: string): string {
  return [
    `${origin} wants you to sign in with your merrymen wallet.`,
    "",
    "This proves you control the owner key. It moves no funds and grants no permissions.",
    "",
    `URI: ${origin}`,
    `Nonce: ${nonce}`,
  ].join("\n");
}

/** A parsed, still-valid, not-yet-spent nonce, or a reason it was rejected. */
function checkNonce(nonce: string, origin: string, now: number): { ok: true } | { ok: false; why: string } {
  const parts = nonce.split(".");
  if (parts.length !== 4) return { ok: false, why: "malformed nonce" };
  const [rand, expStr, org, mac] = parts;
  const body = `${rand}.${expStr}.${org}`;
  if (!macEqual(mac, hmac(body, secretOrThrow()))) return { ok: false, why: "bad nonce signature" };
  let decodedOrigin: string;
  try {
    decodedOrigin = Buffer.from(org, "base64url").toString();
  } catch {
    return { ok: false, why: "malformed nonce" };
  }
  if (decodedOrigin !== origin) return { ok: false, why: "nonce origin mismatch" };
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || now > exp) return { ok: false, why: "nonce expired" };
  if (usedNonces.has(nonce)) return { ok: false, why: "nonce already used" };
  return { ok: true };
}

/**
 * Validate a challenge nonce and BURN it, for a caller that signs its own
 * message text rather than the sign-in one.
 *
 * Recovery needs this: its challenge says something different (it is about
 * withdrawing, not signing in) but the nonce discipline must be identical, or a
 * captured signature becomes a permanent bearer credential. Exported rather than
 * duplicated so there is exactly ONE definition of what makes a nonce valid —
 * the origin binding, the HMAC, the expiry and the single-use set.
 */
export function consumeChallengeNonce(
  nonce: string,
  origin: string,
  now = Date.now(),
): { ok: true } | { ok: false; why: string } {
  const gate = checkNonce(nonce, origin, now);
  if (!gate.ok) return gate;
  usedNonces.add(nonce);
  return { ok: true };
}

// ── verify a signed challenge → tenant address ───────────────────────────────

export type VerifyResult =
  | { ok: true; address: `0x${string}` }
  | { ok: false; why: string };

/**
 * Verify a wallet's signature over the challenge and return its address.
 *
 * Burns the nonce on success so the same signature can never be replayed. The
 * address is recovered from the signature itself (viem) — the caller does not
 * get to say who they are.
 */
export async function verifySignedChallenge(args: {
  origin: string;
  nonce: string;
  signature: `0x${string}`;
  now?: number;
}): Promise<VerifyResult> {
  const now = args.now ?? Date.now();
  const gate = checkNonce(args.nonce, args.origin, now);
  if (!gate.ok) return { ok: false, why: gate.why };
  const message = challengeMessage(args.origin, args.nonce);
  let address: `0x${string}`;
  try {
    address = await recoverMessageAddress({ message, signature: args.signature });
  } catch {
    return { ok: false, why: "signature did not recover" };
  }
  usedNonces.add(args.nonce);
  // The used-set is bounded by the TTL — a swept-out entry is one whose nonce
  // would already fail the expiry check, so forgetting it re-opens nothing.
  if (usedNonces.size > 10_000) {
    for (const n of usedNonces) {
      const exp = Number(n.split(".")[1]);
      if (!Number.isFinite(exp) || now > exp) usedNonces.delete(n);
    }
  }
  return { ok: true, address: address.toLowerCase() as `0x${string}` };
}

// ── grant binding: proving an account belongs to a tenant ────────────────────

/**
 * The origin a signed message is bound to.
 *
 * Trust the deployment's own configured origin over a client-settable Host —
 * the signed text binds to THIS, so it must be the real public origin. Shared
 * by every route that issues or verifies a nonce: the challenge issues one
 * origin-bound nonce and the grant route verifies it, so if the two computed
 * this differently every claim would fail with nothing obviously wrong.
 */
export function requestOrigin(req: Request): string {
  const configured = process.env.MERRYMEN_PUBLIC_ORIGIN;
  if (configured) return configured.replace(/\/$/, "");
  return new URL(req.url).origin;
}

export type BindingResult =
  | { ok: true; tenant: `0x${string}` }
  | { ok: false; why: string };

/**
 * Verify that a tenant legitimately claims this (owner, smartAccount) pair.
 *
 * Reconstructs the canonical message from the values the grant actually carries
 * and recovers both signatures over it. That is what makes the bound values
 * trustworthy without parsing anything: alter `owner`, `smartAccount`, `chainId`
 * or `origin` in the request and the reconstructed text differs from what was
 * signed, so neither signature recovers to the expected address and the claim
 * fails. The caller never gets to assert who they are.
 *
 * Two signatures, two different jobs:
 *   walletSignature must recover to the SESSION TENANT — intent.
 *   ownerSignature  must recover to `owner` — possession.
 *
 * Dropping the second would leave both remaining checks pure functions of
 * public addresses, so anyone could claim anyone's account. It is the whole
 * reason this function takes two signatures instead of one.
 *
 * Burns the nonce only on full success, so a partially-valid claim cannot spend
 * someone else's nonce.
 */
export async function verifyGrantBinding(args: {
  origin: string;
  tenant: `0x${string}`;
  nonce: string;
  owner: `0x${string}`;
  smartAccount: `0x${string}`;
  chainId: number;
  walletSignature: `0x${string}`;
  ownerSignature: `0x${string}`;
  now?: number;
}): Promise<BindingResult> {
  const now = args.now ?? Date.now();
  const gate = checkNonce(args.nonce, args.origin, now);
  if (!gate.ok) return { ok: false, why: gate.why };

  const message = bindingMessage({
    origin: args.origin,
    nonce: args.nonce,
    owner: args.owner,
    smartAccount: args.smartAccount,
    chainId: args.chainId,
  });

  let walletSigner: `0x${string}`;
  let ownerSigner: `0x${string}`;
  try {
    [walletSigner, ownerSigner] = await Promise.all([
      recoverMessageAddress({ message, signature: args.walletSignature }),
      recoverMessageAddress({ message, signature: args.ownerSignature }),
    ]);
  } catch {
    return { ok: false, why: "binding signature did not recover" };
  }

  if (walletSigner.toLowerCase() !== args.tenant.toLowerCase()) {
    return { ok: false, why: "the authorization was not signed by the signed-in wallet" };
  }
  if (ownerSigner.toLowerCase() !== args.owner.toLowerCase()) {
    return { ok: false, why: "the agent wallet did not co-sign — its owner key is not held here" };
  }

  usedNonces.add(args.nonce);
  return { ok: true, tenant: args.tenant.toLowerCase() as `0x${string}` };
}

// ── session cookie ───────────────────────────────────────────────────────────

/** Mint a stateless session token for an authenticated address. */
export function mintSession(address: `0x${string}`, now = Date.now()): string {
  const addr = address.toLowerCase();
  const exp = now + SESSION_TTL_MS;
  const body = `${addr}.${exp}`;
  return `${body}.${hmac(body, secretOrThrow())}`;
}

/** The address a session cookie authenticates, or null if absent/forged/expired. */
export function readSession(token: string | undefined | null, now = Date.now()): `0x${string}` | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [addr, expStr, mac] = parts;
  const body = `${addr}.${expStr}`;
  if (!macEqual(mac, hmac(body, secretOrThrow()))) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || now > exp) return null;
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return null;
  return addr as `0x${string}`;
}

/** Cookie attributes for the session — httpOnly so JS can't read it, SameSite=Strict, Secure. */
export function sessionCookieOptions(): {
  httpOnly: true;
  secure: true;
  sameSite: "strict";
  path: "/";
  maxAge: number;
} {
  return { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: Math.floor(SESSION_TTL_MS / 1000) };
}

// ── route-handler helper ─────────────────────────────────────────────────────

/**
 * The authenticated tenant for a request, or null.
 *
 * Every mutating hosted route calls this FIRST and refuses on null. The address
 * it returns is the tenant id, recovered from a signature the server verified —
 * the one authorization fact nothing downstream may override.
 */
export function tenantOf(req: Request): `0x${string}` | null {
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return readSession(m ? decodeURIComponent(m[1]) : null);
}
