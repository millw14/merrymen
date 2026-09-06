/**
 * SIGN IN WITH X (or email, or a wallet) — the Privy half of authentication.
 *
 * TWO PROOFS, EXACTLY AS THE LEGACY PATH HAS ALWAYS DEMANDED, just made of
 * different evidence:
 *
 *   authentication   a Privy access token this server verified. The DID comes
 *                    out of the token; the browser never gets to say who it is.
 *   possession       a signature over a server-issued challenge, recovered to
 *                    the embedded wallet address. That address becomes the
 *                    tenant, and a tenant is an address everywhere else in this
 *                    codebase, so the session cookie keeps its existing shape.
 *
 * WHY BOTH. The DID alone would let a verified login claim any address it named
 * — the session cookie authorizes every mutating route, so an address nobody
 * proved possession of is an account takeover with a valid token attached. The
 * signature alone would be the legacy path with no identity. Neither half is
 * optional and neither is inferred: `binding_version` names which model applies.
 *
 * THIS ROUTE NEVER CHANGES OWNERSHIP. It mints a session and, for a DID never
 * seen before, records the mapping. It does not create a Merryman, does not
 * touch a grant, and cannot move a smart account between tenants — the account
 * claim that would be required to do so lives in the identity store and is not
 * reachable from here.
 */

import { NextResponse } from "next/server";
import { recoverMessageAddress } from "viem";
import { getIdentityStore, type IdentityProvider } from "@merrymen/identity-store";
import {
  challengeMessage,
  consumeChallengeNonce,
  issueChallengeNonce,
  mintSession,
  requestOrigin,
  sessionCookieOptions,
  SESSION_COOKIE,
} from "@/lib/auth";
import { privyConfigured, privyTokenOf, verifyPrivyToken } from "@/lib/privy";

export const runtime = "nodejs";

const isAddr = (v: unknown): v is `0x${string}` => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

/** The same nonce discipline as the wallet login. One definition, in lib/auth. */
export async function GET(req: Request) {
  if (!privyConfigured()) {
    return NextResponse.json({ error: "privy login is not configured here" }, { status: 501 });
  }
  const origin = requestOrigin(req);
  const nonce = issueChallengeNonce(origin);
  return NextResponse.json({ nonce, message: challengeMessage(origin, nonce) });
}

/** Which login route Privy used, normalised. Display and routing, never authorization. */
function providerOf(v: unknown): IdentityProvider {
  const s = String(v ?? "").toLowerCase();
  if (s === "twitter" || s === "twitter_oauth" || s === "x") return "twitter";
  if (s === "google" || s === "google_oauth") return "google";
  if (s === "email") return "email";
  return "wallet";
}

export async function POST(req: Request) {
  if (!privyConfigured()) {
    return NextResponse.json({ error: "privy login is not configured here" }, { status: 501 });
  }
  const origin = requestOrigin(req);

  // ── 1. authentication: the token, verified here and nowhere else ──────────
  const verdict = await verifyPrivyToken(privyTokenOf(req));
  if (!verdict.ok) return NextResponse.json({ error: verdict.why }, { status: 401 });
  const { did } = verdict.identity;

  let body: { nonce?: unknown; signature?: unknown; address?: unknown; provider?: unknown;
    subject?: unknown; handle?: unknown; displayName?: unknown; avatarUrl?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "malformed request" }, { status: 400 });
  }

  const nonce = typeof body.nonce === "string" ? body.nonce : "";
  const signature = typeof body.signature === "string" ? body.signature : "";
  if (!nonce) return NextResponse.json({ error: "missing nonce" }, { status: 400 });
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return NextResponse.json({ error: "missing or malformed signature" }, { status: 400 });
  }

  // ── 2. possession: the wallet signs the challenge, and we RECOVER it ──────
  //
  // `body.address` is never trusted. It is not even read: the address is the
  // one the signature recovers to, so a request naming somebody else's wallet
  // proves nothing and gets nowhere.
  const gate = consumeChallengeNonce(nonce, origin);
  if (!gate.ok) return NextResponse.json({ error: gate.why }, { status: 401 });

  let wallet: `0x${string}`;
  try {
    wallet = await recoverMessageAddress({
      message: challengeMessage(origin, nonce),
      signature: signature as `0x${string}`,
    });
  } catch {
    return NextResponse.json({ error: "signature did not recover" }, { status: 401 });
  }
  if (!isAddr(wallet)) return NextResponse.json({ error: "signature did not recover" }, { status: 401 });
  const tenantFromWallet = wallet.toLowerCase() as `0x${string}`;

  // ── 3. the DID decides which Merryman this is ─────────────────────────────
  //
  // A DID already mapped returns ITS tenant, whatever wallet arrived with this
  // login. That is the property that makes logging out and back in return the
  // same Merryman instead of minting a second one — and it holds even if Privy
  // ever hands the same person a different embedded wallet.
  const subject = typeof body.subject === "string" && body.subject.trim() !== "" ? body.subject.trim() : did;
  let resolved;
  try {
    resolved = await getIdentityStore().resolveOrClaimDid(tenantFromWallet, {
      did,
      provider: providerOf(body.provider),
      subject,
      handle: typeof body.handle === "string" ? body.handle.slice(0, 64) : null,
      displayName: typeof body.displayName === "string" ? body.displayName.slice(0, 96) : null,
      avatarUrl: typeof body.avatarUrl === "string" && /^https:\/\//.test(body.avatarUrl)
        ? body.avatarUrl.slice(0, 512)
        : null,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not resolve this identity" },
      { status: 503 },
    );
  }
  if (!resolved.ok) return NextResponse.json({ error: resolved.why }, { status: 409 });

  // ── 4. the session, for the tenant the DID owns ───────────────────────────
  const res = NextResponse.json({
    ok: true,
    address: resolved.tenant,
    // TRUE ONLY WHEN THE WALLET THAT SIGNED IS THE TENANT. A returning user
    // whose DID maps to a LEGACY tenant gets a session for that tenant, and
    // this embedded wallet is not its owner — the terminal uses this to say so
    // rather than offering to arm something it cannot sign for.
    ownerHere: resolved.tenant === tenantFromWallet,
    created: resolved.created,
  });
  res.cookies.set(SESSION_COOKIE, mintSession(resolved.tenant), sessionCookieOptions());
  return res;
}
