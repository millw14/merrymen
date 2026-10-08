import { readRequestPurpose } from "@/lib/account-purpose";
/**
 * POST /api/perps/keygen — a fresh Lighter API key for the owner opting in to
 * perps (docs/perps.md rule 5).
 *
 * THE SIGNER ONLY EVER SEES THE PUBLIC KEY. The pair is made here, on the
 * server, by the official pinned signer (worker/src/perps/keygen.ts), and the
 * private half goes straight to custody:
 *
 *   self-hosted  $MERRYMEN_HOME/perp-keys/<pubkey>.json, 0600, written before
 *                this answers → `{ apiPublicKey, apiKeyIndex }`
 *   hosted       sealed under the store DEK, bound to (tenant, smartAccount,
 *                pubkey, 16) → `{ apiPublicKey, apiKeyIndex, apiKeySealed }`;
 *                the blob opens for nobody but the orchestrator, for nobody
 *                but this tenant's this account.
 *
 * So a browser, a phone or the SDK seals the public key into the wall and
 * carries at most ciphertext — never a key that can move money at the venue.
 *
 * AUTHENTICATED EXACTLY AS POST /api/grants IS: hosted, the tenant session
 * cookie (tenantOf) or 401; self-hosted, the loopback perimeter middleware.ts
 * enforces on every /api/* request. POST-ONLY (Next answers 405 to anything
 * else), `force-dynamic`, and every answer — refusals included — is
 * `Cache-Control: private, no-store`: the one reply that carries a sealed key
 * must never be kept by a browser or a proxy.
 *
 * OFFERED ONLY WHERE THE OPERATOR OFFERS IT (docs/perps.md rule 1,
 * "Rollout"): 403 `perp-not-offered` unless perpsOptInOffered reads `live` for
 * the account asked about — so a hosted deploy on its default
 * MERRYMEN_PERPS=paper mints and holds no Lighter key for anybody, and live
 * opens there only for the accounts MERRYMEN_PERPS_LIVE_TENANTS names. The
 * grant intake refuses a new block on the same terms.
 *
 * RATE-LIMITED per caller (a few a minute): each call builds a WASM runtime
 * the first time and mints a key every time; nothing an honest dashboard does
 * needs more.
 *
 * NEVER LOGGED. Neither the body nor the answer is written anywhere; refusals
 * name a reason, never bytes.
 */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { purposeHome } from "@merrymen/home";
import { tenantOf } from "@/lib/auth";
import { NO_STORE_HEADERS, PERP_NOT_OFFERED, perpsOptInOffered, perRouteLimiter, storeDek } from "@/lib/perp-custody";
import { hostedPerpKeygen, PerpKeySealError, selfHostedPerpKeygen } from "../../../../../../worker/src/perps/keygen";
import { PerpKeystoreError } from "../../../../../../worker/src/perps/keystore";
import { SignerUnavailable } from "../../../../../../worker/src/perps/signer";

export const dynamic = "force-dynamic";

/** Five keys a minute per caller: a re-sign needs one, a retry after an error one more. */
const limit = perRouteLimiter(5);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function reply(body: Record<string, unknown>, status = 200, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...NO_STORE_HEADERS, ...extra } });
}

export async function POST(req: Request) {
  const hosted = isHostedMode();
  const tenant = hosted ? tenantOf(req) : null;
  if (hosted && !tenant) return reply({ error: "not signed in" }, 401);
  const purpose = readRequestPurpose(req);
  if (!purpose) return reply({ error: "Invalid account purpose" }, 400);

  const allowed = limit(tenant ?? "self-hosted");
  if (!allowed.ok) {
    return reply({ error: "too many keys asked for — wait a minute and try again", code: "rate-limited", ownerFacing: true }, 429, {
      "Retry-After": String(allowed.retryAfterSec),
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return reply({ error: "expected a JSON body { smartAccount }", code: "bad-request" }, 400);
  }
  const b = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!b || Object.keys(b).some((k) => k !== "smartAccount") || typeof b.smartAccount !== "string" || !ADDRESS_RE.test(b.smartAccount)) {
    return reply({ error: "expected exactly { smartAccount: <0x address> }", code: "bad-request" }, 400);
  }
  const smartAccount = b.smartAccount.toLowerCase() as `0x${string}`;
  if (!perpsOptInOffered(smartAccount)) {
    return reply({ error: PERP_NOT_OFFERED.error, code: PERP_NOT_OFFERED.code, ownerFacing: true }, PERP_NOT_OFFERED.status);
  }

  try {
    if (hosted) {
      const dek = storeDek();
      if (!dek) {
        return reply(
          { error: "this service cannot hold a Lighter key right now (its key store is not configured)", code: "perp-key-store-unavailable", ownerFacing: true },
          503,
        );
      }
      return reply({ ...(await hostedPerpKeygen({ tenant: tenant as `0x${string}`, smartAccount, dek })) });
    }
    return reply({ ...(await selfHostedPerpKeygen({ home: purposeHome(purpose) })) });
  } catch (e) {
    if (e instanceof SignerUnavailable) {
      // Named, never a key from anywhere else: the pinned signer is missing,
      // altered, failed its known-answer test, or its runtime died.
      return reply(
        {
          error: "the Lighter signer on this server is not available, so no key was made. Try again later; if it persists, the server's signer needs attention.",
          code: "perp-signer-unavailable",
          reason: e.reason,
          ownerFacing: true,
        },
        503,
      );
    }
    if (e instanceof PerpKeySealError) {
      return reply({ error: "the new key could not be sealed, so it was discarded", code: "perp-key-seal-failed", reason: e.reason, ownerFacing: true }, 503);
    }
    if (e instanceof PerpKeystoreError) {
      return reply({ error: "the new key could not be saved to this install's key store, so it was discarded", code: "perp-keystore-failed", reason: e.reason, ownerFacing: true }, 500);
    }
    return reply({ error: "no key was made — please try again", code: "perp-keygen-failed", ownerFacing: true }, 500);
  }
}
