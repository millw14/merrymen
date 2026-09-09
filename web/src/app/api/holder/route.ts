/**
 * /api/holder — link a wallet that holds $MERRYMEN, by proving you control it.
 *
 * THE CASE. Raised by a tester: "it can happen that you don't own tokens in
 * your privy based wallet and you have them somewhere else… the app should have
 * the possibility to define the holder address if it's not the 'default' privy
 * wallet address."
 *
 * He is right, and the reason it could not simply be typed in is the reason
 * this route exists. `settings.holderAddress` is self-declared — shape-checked
 * and nothing else — so anyone could name a whale's wallet and take their tier.
 * /api/alpha says so outright: "fine for a fee discount an owner claims for
 * themselves, never an authorisation input." The orchestrator then started
 * overwriting the field with the session-verified tenant, which made the tier
 * earnable at all and, in the same stroke, shut out everyone holding the token
 * anywhere but their login wallet.
 *
 * A CLAIM BECOMES AN AUTHORISATION WHEN IT IS PROVEN, so the wallet signs. The
 * address is RECOVERED from the signature; the caller never gets to say who
 * they are. That is the same instrument the login itself rests on.
 *
 * WHAT THE LINKED WALLET CAN DO: nothing. It is read with `balanceOf` by
 * circle.ts and never again. It is not a spend key, not an owner, not a signer,
 * and it is deliberately kept out of the grant entirely — the signed text says
 * so, because somebody asked to sign by a trading app deserves to know.
 *
 * ONE PROOF PER ACCOUNT, and re-linking replaces it. A list would be a way to
 * sum balances across wallets, which is a different feature with a different
 * abuse story (borrowing a friend's wallet for an afternoon); one proven wallet
 * answers the reported case and nothing more.
 */
import { NextResponse } from "next/server";
import { recoverMessageAddress } from "viem";
import { getSettingsStore } from "@merrymen/settings-store";
import { holderProofMessage, isHolderProof, isHostedMode } from "@merrymen/core";
import {
  consumeChallengeNonce,
  issueChallengeNonce,
  requestOrigin,
  tenantOf,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * SELF-HOSTED HAS NO SESSION AND NO OTHER TENANT.
 *
 * There, `settings.holderAddress` is the operator's own field and always has
 * been — there is nobody to claim somebody else's balance from. This route is a
 * hosted-only answer to a hosted-only problem, and saying so is better than
 * pretending to work with a null tenant.
 */
function requireTenant(req: Request): `0x${string}` | null {
  if (!isHostedMode()) return null;
  return tenantOf(req);
}

/** GET — the exact message this account's chosen wallet should sign. */
export async function GET(req: Request) {
  const tenant = requireTenant(req);
  if (!tenant) {
    return NextResponse.json(
      { error: isHostedMode() ? "not signed in" : "self-hosted: set holderAddress in settings instead" },
      { status: isHostedMode() ? 401 : 400 },
    );
  }
  const holder = new URL(req.url).searchParams.get("holder")?.trim() ?? "";
  if (!ADDRESS.test(holder)) {
    return NextResponse.json({ error: "holder must be a 0x address" }, { status: 400 });
  }
  const origin = requestOrigin(req);
  const nonce = issueChallengeNonce(origin);
  return NextResponse.json({
    origin,
    nonce,
    message: holderProofMessage({ holder, tenant, origin, nonce }),
  });
}

interface LinkBody {
  holder?: unknown;
  signature?: unknown;
  nonce?: unknown;
}

/** POST — verify the signature and record the proof. */
export async function POST(req: Request) {
  const tenant = requireTenant(req);
  if (!tenant) {
    return NextResponse.json(
      { error: isHostedMode() ? "not signed in" : "self-hosted: set holderAddress in settings instead" },
      { status: isHostedMode() ? 401 : 400 },
    );
  }

  let body: LinkBody;
  try {
    body = (await req.json()) as LinkBody;
  } catch {
    return NextResponse.json({ error: "body is not JSON" }, { status: 400 });
  }

  const holder = typeof body.holder === "string" ? body.holder.trim() : "";
  const signature = typeof body.signature === "string" ? body.signature.trim() : "";
  const nonce = typeof body.nonce === "string" ? body.nonce : "";
  if (!ADDRESS.test(holder)) {
    return NextResponse.json({ error: "holder must be a 0x address" }, { status: 400 });
  }
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
    return NextResponse.json({ error: "signature must be 0x-hex" }, { status: 400 });
  }

  const origin = requestOrigin(req);
  /**
   * THE NONCE IS BURNED BEFORE THE SIGNATURE IS EVEN LOOKED AT.
   *
   * Single-use, expiring and origin-bound, so a signature captured on another
   * site or an hour ago is not a signature here. Consumed first because a
   * failed verification must not leave a live nonce behind for a second
   * attempt with a different address.
   */
  const gate = consumeChallengeNonce(nonce, origin);
  if (!gate.ok) return NextResponse.json({ error: gate.why }, { status: 400 });

  /**
   * THE TENANT IS IN THE SIGNED TEXT, so this signature is worthless to anyone
   * else. Built here from the SESSION's tenant rather than from the body: a
   * caller who could name the account in the message could link a wallet to
   * somebody else's.
   */
  const message = holderProofMessage({ holder, tenant, origin, nonce });

  let recovered: string;
  try {
    recovered = await recoverMessageAddress({ message, signature: signature as `0x${string}` });
  } catch {
    return NextResponse.json({ error: "could not read that signature" }, { status: 400 });
  }
  if (recovered.toLowerCase() !== holder.toLowerCase()) {
    return NextResponse.json(
      { error: "that signature is from a different wallet than the one named" },
      { status: 400 },
    );
  }

  const store = getSettingsStore();
  const stored = (await store.get(tenant)) ?? {};
  await store.put(tenant, {
    ...stored,
    holderProof: { address: holder.toLowerCase(), at: Date.now() },
  });
  return NextResponse.json({ ok: true, holder: holder.toLowerCase() });
}

/** DELETE — unlink. The tier falls back to the login wallet, which always works. */
export async function DELETE(req: Request) {
  const tenant = requireTenant(req);
  if (!tenant) {
    return NextResponse.json(
      { error: isHostedMode() ? "not signed in" : "self-hosted: set holderAddress in settings instead" },
      { status: isHostedMode() ? 401 : 400 },
    );
  }
  const store = getSettingsStore();
  const stored = (await store.get(tenant)) ?? {};
  const { holderProof: _gone, ...rest } = stored;
  await store.put(tenant, rest);
  return NextResponse.json({ ok: true });
}

/** What the settings screen shows — the linked wallet, or nothing. */
export async function PATCH(req: Request) {
  const tenant = requireTenant(req);
  if (!tenant) return NextResponse.json({ linked: null });
  const stored = (await getSettingsStore().get(tenant)) ?? {};
  const proof = stored.holderProof;
  return NextResponse.json({ linked: isHolderProof(proof) ? proof : null });
}
