/**
 * THE PRIVY TRUST BOUNDARY. Server-only.
 *
 * A browser sends an access token. Everything downstream — which tenant it is,
 * which Merryman it opens, whether a grant may be installed — hangs on the DID
 * inside it, so the DID is only ever read from a token this file has VERIFIED.
 * A `privyUserId`, a wallet address or a tenant supplied in a request body is
 * decoration; it never becomes an identity.
 *
 * TWO CLAIMS ARE PINNED, not one. `issuer` must be `privy.io` and `audience`
 * must be OUR app id. Checking only the signature would accept a token minted
 * for any other Privy application, because they are signed by the same issuer —
 * a valid token from somebody else's app would log its holder into ours.
 *
 * THE SECRET NEVER LEAVES THIS SERVICE. `PRIVY_APP_SECRET` is read here and
 * nowhere else; `CHILD_SECRET_STRIP` removes it at fork so no worker child
 * inherits it, Brain has no environment to receive it, and it appears in no
 * prompt, decision record or log line. `privy-boundary.test.ts` asserts each of
 * those rather than trusting this paragraph.
 */

import { PrivyClient } from "@privy-io/node";

export interface PrivyIdentity {
  /** The canonical identity. `did:privy:...`, opaque, case-preserved. */
  did: string;
  /** Privy's session id for this token. Logged nowhere; carried for tracing. */
  sessionId: string;
  expiresAt: number;
}

export type PrivyVerdict =
  | { ok: true; identity: PrivyIdentity }
  | { ok: false; why: string };

export function privyAppId(): string {
  return (process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "").trim();
}

/** Is Privy login configured on this deployment at all? */
export function privyConfigured(): boolean {
  return privyAppId() !== "" && (process.env.PRIVY_APP_SECRET ?? "").trim() !== "";
}

let cached: PrivyClient | null = null;
function client(): PrivyClient {
  if (cached) return cached;
  const appId = privyAppId();
  const appSecret = (process.env.PRIVY_APP_SECRET ?? "").trim();
  if (!appId || !appSecret) {
    // Boot-time refusal rather than a permissive default. A deployment with no
    // Privy credentials must refuse Privy logins, not accept unverified ones.
    throw new Error("Privy is not configured (NEXT_PUBLIC_PRIVY_APP_ID and PRIVY_APP_SECRET)");
  }
  cached = new PrivyClient({
    appId,
    appSecret,
    // Optional. With it, verification is offline against a pinned ES256 public
    // key; without it the SDK fetches this app's JWKS. Both verify the same
    // signature — pinning only removes a network round trip and a dependency on
    // Privy being reachable at login time.
    ...(process.env.PRIVY_VERIFICATION_KEY?.trim()
      ? { jwtVerificationKey: process.env.PRIVY_VERIFICATION_KEY.trim() }
      : {}),
  });
  return cached;
}

/** Test seam: drop the memoised client so a test can change the environment. */
export function resetPrivyClientForTest(): void {
  cached = null;
}

/**
 * Verify an access token and return the identity it carries.
 *
 * NEVER THROWS FOR A BAD TOKEN. An expired, forged, malformed or foreign-app
 * token is a typed refusal, because the caller's correct response to all four
 * is the same 401 and an exception would tempt a catch-all that swallows the
 * difference between "not signed in" and "our verifier is broken".
 */
export async function verifyPrivyToken(token: string | null | undefined): Promise<PrivyVerdict> {
  const t = (token ?? "").trim();
  if (!t) return { ok: false, why: "no privy access token" };
  if (!privyConfigured()) return { ok: false, why: "privy login is not configured on this deployment" };

  let claims: { user_id?: unknown; session_id?: unknown; expiration?: unknown; app_id?: unknown };
  try {
    // SNAKE_CASE, and the docs say otherwise. @privy-io/node returns
    // { app_id, issuer, issued_at, expiration, session_id, user_id }; the
    // deprecated @privy-io/server-auth returned camelCase. Destructuring the
    // wrong shape yields `undefined` rather than an error, which would read as
    // a verified token with no subject.
    claims = (await client().utils().auth().verifyAccessToken(t)) as typeof claims;
  } catch (e) {
    return { ok: false, why: `privy token rejected: ${e instanceof Error ? e.message : "unverifiable"}` };
  }

  const did = typeof claims.user_id === "string" ? claims.user_id.trim() : "";
  if (!did) {
    // A token that verifies but carries no subject is not an identity. Refusing
    // is the only safe reading: the alternative is a session for "".
    return { ok: false, why: "privy token carries no user id" };
  }
  // Belt and braces on the audience. The SDK checks it, and a future version
  // that stopped would silently accept another app's tokens — the one failure
  // here that looks like a successful login.
  const audience = typeof claims.app_id === "string" ? claims.app_id : "";
  if (audience && audience !== privyAppId()) {
    return { ok: false, why: "privy token was issued for a different application" };
  }
  const expiration = Number(claims.expiration);
  if (Number.isFinite(expiration) && expiration * 1000 <= Date.now()) {
    return { ok: false, why: "privy token has expired" };
  }

  return {
    ok: true,
    identity: {
      did,
      sessionId: typeof claims.session_id === "string" ? claims.session_id : "",
      expiresAt: Number.isFinite(expiration) ? expiration : 0,
    },
  };
}

/** The bearer token on a request, from the header Privy's client sets. */
export function privyTokenOf(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1]!.trim() : null;
}
