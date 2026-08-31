/**
 * MINT A RECOVERY TICKET — the anti-abuse token the bundler relay demands.
 *
 * GET  issues an origin-bound, single-use nonce.
 * POST takes a signature over the recovery challenge, recovers the owner
 *      ADDRESS, derives the Kernel account that owner controls, and returns a
 *      short-lived ticket bound to {smartAccount, chainId}.
 *
 * NO OWNER KEY CROSSES THE WIRE, and none can: the request body's only accepted
 * fields are a nonce, a 65-byte signature and a chain id. The signature is over
 * a message that says in words that it moves no funds, and the server can do
 * nothing with it except recover an address.
 *
 * WHY NOT REQUIRE A SESSION. Because the recoveries that matter most have none.
 * The kill switch DELETEs the tenant's grants row, so after a kill the server no
 * longer knows the account at all — and "I killed my agent, now I want my money"
 * is the likeliest reason anyone opens recovery. A session requirement would
 * refuse exactly those people. It also has to work for superseded wallets and
 * from a browser that was never signed in.
 *
 * WHAT THIS DELIBERATELY DOES NOT PROVE: that the account has ever existed on
 * this deployment. A stranger can generate keypairs in a loop and mint tickets
 * for accounts nobody has funded. That is why the relay tiers its quota on
 * whether we have actually SEEN the account rather than trusting the ticket
 * alone — the ticket bounds WHOSE operation may be relayed, not how much of the
 * house's bundler allowance a stranger may spend.
 */

import { NextResponse } from "next/server";
import { recoverMessageAddress } from "viem";
import { consumeChallengeNonce, issueChallengeNonce, requestOrigin } from "@/lib/auth";
import { deriveKernelAccountAddress } from "@/lib/derive-account";
import { mintTicket, recoveryChallengeMessage, TICKET_TTL_MS } from "@/lib/recovery-ticket";
import { robinhoodChain, robinhoodTestnet } from "@merrymen/core";

export const runtime = "nodejs";

const KNOWN_CHAINS = new Set<number>([robinhoodChain.id, robinhoodTestnet.id]);

export async function GET(req: Request) {
  const origin = requestOrigin(req);
  const nonce = issueChallengeNonce(origin);
  return NextResponse.json({ nonce, message: recoveryChallengeMessage(origin, nonce) });
}

export async function POST(req: Request) {
  const origin = requestOrigin(req);

  let body: { nonce?: unknown; signature?: unknown; chainId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "malformed request" }, { status: 400 });
  }

  const nonce = typeof body.nonce === "string" ? body.nonce : "";
  const signature = typeof body.signature === "string" ? body.signature : "";
  const chainId = Number(body.chainId);

  if (!nonce) return NextResponse.json({ error: "missing nonce" }, { status: 400 });
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return NextResponse.json({ error: "missing or malformed signature" }, { status: 400 });
  }
  if (!KNOWN_CHAINS.has(chainId)) {
    return NextResponse.json({ error: "unknown chain" }, { status: 400 });
  }

  // BURN THE NONCE FIRST. The signature alone binds origin (it is in the text)
  // but nothing else — without a single-use, expiring nonce, anyone who ever saw
  // that signature could mint tickets for the account forever.
  const gate = consumeChallengeNonce(nonce, origin);
  if (!gate.ok) return NextResponse.json({ error: gate.why }, { status: 401 });

  // Reconstruct the exact text that was signed. Nothing the caller sends is
  // trusted as an identity — the address falls out of the signature or the
  // request fails.
  const message = recoveryChallengeMessage(origin, nonce);
  let owner: `0x${string}`;
  try {
    owner = await recoverMessageAddress({ message, signature: signature as `0x${string}` });
  } catch {
    return NextResponse.json({ error: "signature did not recover" }, { status: 401 });
  }

  // Owner ADDRESS only. deriveKernelAccountAddress builds a view-only signer
  // whose signing methods throw, so this path cannot handle key material even
  // by accident.
  let smartAccount: `0x${string}`;
  try {
    smartAccount = (await deriveKernelAccountAddress(owner, chainId)) as `0x${string}`;
  } catch {
    return NextResponse.json({ error: "could not derive the account for that owner" }, { status: 502 });
  }

  // SET AS A COOKIE, not returned for the client to attach.
  //
  // The relay is reached through viem's own http transport inside
  // recoverFunds, which the browser does not get to add headers to without
  // monkey-patching global fetch — a racy thing to do around a money path. A
  // cookie is attached automatically by the browser, and is scoped to
  // /api/bundler so it is not sent anywhere else on the origin.
  //
  // httpOnly, so a script on the page cannot read it back out; sameSite strict,
  // so no other site can cause it to be sent; and short-lived by the ticket's
  // own expiry, which is what actually bounds it.
  const res = NextResponse.json({ smartAccount, expiresInMs: TICKET_TTL_MS });
  res.cookies.set("merrymen_recovery", mintTicket({ smartAccount, chainId }), {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/api/bundler",
    maxAge: Math.floor(TICKET_TTL_MS / 1000),
  });
  return res;
}
