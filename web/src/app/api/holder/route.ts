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
 *
 * AND ONE ACCOUNT PER WALLET. The proof above bound a wallet to an account and
 * nothing bound it back: any number of accounts could link the same
 * 100,000-token wallet and each agent read the whole bag as its own. So the
 * wallet is CLAIMED (settings-store holder_claims) before the proof is stored,
 * and a store that cannot answer refuses rather than letting a second account
 * in (the grants route's FIRST CLAIM WINS, same reasoning). Unlinking releases
 * the claim. effectiveHolder (packages/core/src/holder-proof.ts) is how the
 * claim is read.
 *
 * AND THE WALLET'S OWN KEY DECIDES WHERE. Every POST here carries a fresh
 * signature BY the wallet, over text naming this account — so when another
 * account holds the claim, it MOVES here (takeHolder) rather than meeting a
 * 409 nobody could get past: a claim made with a phished or borrowed
 * signature, or held by an account its owner can no longer sign in to, would
 * otherwise lock the wallet's real holder out for good. At most one move per
 * wallet per UTC day, so a bag cannot be passed round a string of agents; a
 * second answers 429 with when it can move. An unlink does not give the day's
 * move back: the next account to claim the wallet that day is making the move
 * (settings-store HolderRelease). Two moves are never refused, so a phished
 * move cannot lock the owner out until midnight: back to the wallet's own
 * sign-in account, and back to the account it was last moved from
 * (settings-store moveBarredUntil).
 */
import { NextResponse } from "next/server";
import { recoverMessageAddress } from "viem";
import { getSettingsStore, type HolderTake } from "@merrymen/settings-store";
import { effectiveHolder, holderProofMessage, isHolderProof, isHostedMode } from "@merrymen/core";
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
  const gate = await consumeChallengeNonce(nonce, origin);
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

  const wallet = holder.toLowerCase();
  const store = getSettingsStore();

  /**
   * CLAIMED — OR MOVED HERE — BEFORE THE PROOF IS STORED, and only now:
   * after the nonce is burned and the signature recovered, so nobody can
   * squat or take a wallet they cannot sign for, and only someone who can
   * sign for it ever learns where it is claimed. Taken first, a claim can
   * only ever be undone; a proof alone counts nowhere (effectiveHolder).
   */
  let claim: HolderTake;
  try {
    claim = await store.takeHolder(wallet, tenant);
  } catch {
    return NextResponse.json(
      // Unreadable is not "free": refuse, as the grants route does.
      { error: "couldn't check whether another account already uses this wallet — nothing was linked, please try again", ownerFacing: true },
      { status: 503 },
    );
  }
  if (!claim.ok) {
    // Never who: that account is somebody's login. `held` only says whether
    // it powers one right now — an account that let it go earlier today does
    // not give the day's move back.
    const retryAfter = Math.max(1, Math.ceil((claim.movableAt - Date.now()) / 1000));
    return NextResponse.json(
      {
        error:
          (claim.held
            ? "This wallet powers another merrymen account, and it already moved once today"
            : "Another merrymen account used this wallet earlier today, and it already moved once today") +
          " — a wallet can move between accounts once per day (UTC). " +
          `Sign again from ${utcStamp(claim.movableAt)} to ${claim.held ? "move it here" : "link it here"}.`,
        ownerFacing: true,
        movableAt: claim.movableAt,
      },
      { status: 429, headers: { "retry-after": String(retryAfter) } },
    );
  }

  try {
    const stored = (await store.get(tenant)) ?? {};
    // RE-LINKING MOVES THE CLAIM, AND AN ACCOUNT HOLDS ONE. Every other claim
    // this account holds is released first — by the claims, not by the stored
    // proof, which a stale settings write can have put back (a claim keyed on
    // it would strand the one it missed). A failure below leaves at worst an
    // unclaimed old proof, which counts nowhere, and a retry finishes the move.
    await store.releaseHolderClaims(tenant, wallet);
    await store.put(tenant, {
      ...stored,
      holderProof: { address: wallet, at: Date.now() },
    });
  } catch {
    // Undo what THIS call took, so a failed link does not hold the wallet
    // hostage: a fresh claim is removed and a move is put back, each exactly
    // as it was — the other account's claim, the wallet's release record,
    // the day's move allowance. Never a release: that would record this
    // account as the last holder and spend a move that never happened. One
    // this account already held stays: it may back a stored proof.
    if (claim.from) await store.undoTakeHolder(wallet, tenant, claim.was).catch(() => {});
    else if (claim.fresh) await store.undoTakeHolder(wallet, tenant, null).catch(() => {});
    return NextResponse.json(
      { error: "couldn't save that link just now — nothing changed, please try again", ownerFacing: true },
      { status: 503 },
    );
  }
  // `moved` tells the signer it came from another account — never which.
  return NextResponse.json({ ok: true, holder: wallet, ...(claim.from ? { moved: true } : {}) });
}

/** "00:00 UTC on 29 Sep 2026" — when a wallet can move again. */
function utcStamp(ms: number): string {
  const d = new Date(ms);
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC on ${d.getUTCDate()} ${month} ${d.getUTCFullYear()}`;
}

/** DELETE — unlink, and free the wallet for another account. */
export async function DELETE(req: Request) {
  const tenant = requireTenant(req);
  if (!tenant) {
    return NextResponse.json(
      { error: isHostedMode() ? "not signed in" : "self-hosted: set holderAddress in settings instead" },
      { status: isHostedMode() ? 401 : 400 },
    );
  }
  const store = getSettingsStore();
  try {
    const stored = (await store.get(tenant)) ?? {};
    const { holderProof: _gone, ...rest } = stored;
    // EVERY CLAIM THIS ACCOUNT HOLDS, whatever the stored proof names. A
    // stale settings write can leave the proof naming one wallet while the
    // claim sits on another; releasing by the proof would free the wrong one
    // and leave the other held by an account whose screen cannot show it.
    // RELEASED BEFORE THE PROOF IS DROPPED, so a failure at either step is
    // safe to retry: a released claim with its proof still stored counts
    // nowhere, and asking again finishes the job.
    await store.releaseHolderClaims(tenant);
    await store.put(tenant, rest);
  } catch {
    return NextResponse.json(
      { error: "couldn't unlink that wallet just now — please try again", ownerFacing: true },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true });
}

/**
 * What the settings screen shows — the linked wallet, or nothing — which
 * wallet this account's tier actually reads (`linked`, `login`, or `none`
 * when another account holds the claim on every candidate), and WHY the
 * linked wallet does or does not count:
 *
 *   counting           its claim names this account.
 *   claimed-elsewhere  another account holds its claim. Signing again moves
 *                      it here (once a day).
 *   unclaimed          nobody holds it — linked before claims existed and not
 *                      yet backfilled, or an unlink / re-link that failed
 *                      half-way. Signing again claims it; there is no other
 *                      account to go and unlink it from.
 *
 * `reads` alone could not tell the last two apart, and the screen told an
 * owner with an unclaimed proof that it "already powers another account".
 *
 * ONE CLAIMS READ answers both, through effectiveHolder — the rule
 * holderWalletFor applies for the tier screens — so they cannot disagree with
 * each other. Nulls when the claims could not be read; the screen then says
 * nothing about it rather than guess.
 */
export async function PATCH(req: Request) {
  const tenant = requireTenant(req);
  if (!tenant) return NextResponse.json({ linked: null, reads: null, proof: null });
  const store = getSettingsStore();
  let stored: Awaited<ReturnType<typeof store.get>>;
  try {
    stored = await store.get(tenant);
  } catch {
    // Settings that will not read are not "nothing linked": say nothing.
    return NextResponse.json({ linked: null, reads: null, proof: null });
  }
  const storedProof = stored?.holderProof;
  const proof = isHolderProof(storedProof) ? storedProof : null;
  let reads: "linked" | "login" | "none" | null = null;
  let standing: "counting" | "claimed-elsewhere" | "unclaimed" | null = null;
  try {
    const claims = await store.holderClaims(proof ? [tenant, proof.address] : [tenant]);
    reads = effectiveHolder(tenant, proof, (w) => claims.get(w))?.source ?? "none";
    if (proof) {
      const holder = claims.get(proof.address);
      standing = holder === tenant.toLowerCase() ? "counting" : holder ? "claimed-elsewhere" : "unclaimed";
    }
  } catch {
    reads = null;
    standing = null;
  }
  return NextResponse.json({ linked: proof, reads, proof: standing });
}
