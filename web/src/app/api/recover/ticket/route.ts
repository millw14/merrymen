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
 * for accounts nobody has funded. Sponsorship therefore checks whether we have
 * actually SEEN the account rather than trusting the ticket alone. It requires
 * durable account history plus the house policy;
 * the ticket by itself never entitles its holder to sponsored gas.
 */

import { NextResponse } from "next/server";
import { createPublicClient, http, recoverMessageAddress } from "viem";
import { consumeChallengeNonce, issueChallengeNonce, requestOrigin } from "@/lib/auth";
import { deriveKernelRecoveryAccount } from "@/lib/derive-account";
import { mintTicket, recoveryChallengeMessage, TICKET_TTL_MS } from "@/lib/recovery-ticket";
import {
  PONS_CLASS_VAULT_FACTORY,
  PONS_CLASS_VAULT_FACTORY_V2,
  resolveClassVault,
  robinhoodChain,
  robinhoodTestnet,
} from "@merrymen/core";

export const runtime = "nodejs";

const KNOWN_CHAINS = new Set<number>([robinhoodChain.id, robinhoodTestnet.id]);
const OWNER_ACTIONS_SCOPE = "owner-actions";
const nonceOrigin = (origin: string, ownerActions: boolean) => ownerActions ? `${origin}|recovery-owner-actions-v2` : origin;

export async function GET(req: Request) {
  const origin = requestOrigin(req);
  const scopes = new URL(req.url).searchParams.getAll("scope");
  if (scopes.length > 1 || (scopes.length === 1 && scopes[0] !== OWNER_ACTIONS_SCOPE)) {
    return NextResponse.json({ error: "unknown recovery scope" }, { status: 400 });
  }
  const ownerActions = scopes[0] === OWNER_ACTIONS_SCOPE;
  // Installed native clients enforce the legacy text exactly. New clients
  // opt into owner actions, with a distinct nonce namespace to prevent mixing.
  const nonce = issueChallengeNonce(nonceOrigin(origin, ownerActions));
  return NextResponse.json({ nonce, message: recoveryChallengeMessage(origin, nonce, ownerActions) });
}

export async function POST(req: Request) {
  const origin = requestOrigin(req);

  let body: { nonce?: unknown; signature?: unknown; chainId?: unknown; scope?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "malformed request" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "malformed request" }, { status: 400 });
  if (body.scope !== undefined && body.scope !== OWNER_ACTIONS_SCOPE) return NextResponse.json({ error: "unknown recovery scope" }, { status: 400 });
  const ownerActions = body.scope === OWNER_ACTIONS_SCOPE;

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
  const gate = await consumeChallengeNonce(nonce, nonceOrigin(origin, ownerActions));
  if (!gate.ok) return NextResponse.json({ error: gate.why }, { status: 401 });

  // Reconstruct the exact text that was signed. Nothing the caller sends is
  // trusted as an identity — the address falls out of the signature or the
  // request fails.
  const message = recoveryChallengeMessage(origin, nonce, ownerActions);
  let owner: `0x${string}`;
  try {
    owner = await recoverMessageAddress({ message, signature: signature as `0x${string}` });
  } catch {
    return NextResponse.json({ error: "signature did not recover" }, { status: 401 });
  }

  // Owner ADDRESS only. deriveKernelAccountAddress builds a view-only signer
  // whose signing methods throw, so this path cannot handle key material even
  // by accident.
  //
  // A FAILED DERIVATION MUST NOT MINT A TICKET. The zero address is what this
  // call returns when the Kernel factory does not answer, and a ticket naming
  // 0x0000...0000 would send a recovery sweep at an account nobody owns — the
  // relay's `sender === ticket.smartAccount` check would even pass for it.
  let smartAccount: `0x${string}`;
  let sponsorship: import("@/lib/recovery-ticket").Ticket["sponsorship"];
  try {
    const derived = await deriveKernelRecoveryAccount(owner, chainId);
    if (!derived.ok) return NextResponse.json({ error: derived.why }, { status: 502 });
    smartAccount = derived.address;
    if (derived.factory && derived.factoryData) {
      const accounts = [smartAccount];
      // A destination account can be undeployed during migration. Its owner's
      // source account is the durable enrollment proof, even after a kill.
      for (const otherChain of KNOWN_CHAINS) {
        if (otherChain === chainId) continue;
        try {
          const other = await deriveKernelRecoveryAccount(owner, otherChain);
          if (other.ok && !accounts.some((a) => a.toLowerCase() === other.address.toLowerCase())) accounts.push(other.address);
        } catch { /* Missing family proof declines sponsorship, never owner-funded recovery. */ }
      }
      sponsorship = { owner, factory: derived.factory, factoryData: derived.factoryData, accounts };
    }
  } catch {
    return NextResponse.json({ error: "could not derive the account for that owner" }, { status: 502 });
  }

  /**
   * THIS ACCOUNT'S CLASS VAULT, resolved here so the relay never has to.
   *
   * The relay admits a `sweep(address)` leg only when its target equals this,
   * and it reads it out of the ticket's own hmac-signed body — so the pinning
   * costs no chain read on the money path and cannot be edited by the caller.
   *
   * A FAILURE HERE MUST NOT BLOCK AN ORDINARY WITHDRAWAL. `vaultFor` is a view
   * on a factory that may be absent on this chain (testnet has none) or simply
   * unreachable this second. Either way the right answer is a ticket that
   * blesses no vault: the USDG and ETH still sweep, and only the class leg —
   * which most owners do not have — is refused, with a reason that says so.
   */
  /**
   * BOTH FACTORIES, because after v2 an account has two vaults.
   *
   * The vault address is a CREATE2 function of the factory, so a second factory
   * means a second address — and an owner who has re-signed onto v2 may still
   * have a balance in their v1 vault, which the session key can no longer
   * reach. A ticket that blesses one of them tells the other's owner that their
   * own vault is "something other than this account's own class vault".
   *
   * A CLOSED SET DECIDED HERE, from the account and the pinned constants alone.
   * Nothing the caller sends contributes to it, which is the property that has
   * to survive going plural.
   *
   * One factory failing does not remove the other: the per-factory try is not a
   * nicety, it is what stops a blinking v1 read from hiding a live v2 vault.
   */
  const classVaults: `0x${string}`[] = [];
  const chain = chainId === robinhoodChain.id ? robinhoodChain : robinhoodTestnet;
  for (const factory of [PONS_CLASS_VAULT_FACTORY_V2[chainId], PONS_CLASS_VAULT_FACTORY[chainId]]) {
    if (!factory) continue;
    try {
      const client = createPublicClient({ chain, transport: http() });
      const vault = await resolveClassVault(client, factory as `0x${string}`, smartAccount);
      if (!classVaults.some((v) => v.toLowerCase() === vault.toLowerCase())) classVaults.push(vault);
    } catch {
      // A factory that will not answer yields no vault rather than an error —
      // the USDG and ETH must still sweep. Unchanged from the single-factory
      // rule, now applied per factory.
    }
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
  res.cookies.set("merrymen_recovery", mintTicket({ smartAccount, chainId, classVaults, sponsorship }), {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/api/bundler",
    maxAge: Math.floor(TICKET_TTL_MS / 1000),
  });
  return res;
}
