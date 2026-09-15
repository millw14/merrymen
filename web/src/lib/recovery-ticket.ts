/**
 * A RECOVERY TICKET — an anti-abuse token, and nothing more.
 *
 * WHAT IT IS NOT: a fund-safety control. What protects an owner's money is the
 * EntryPoint's signature check over the userOpHash, which binds sender, nonce,
 * callData, gas fields, chain and entryPoint. A ticket cannot authorise a
 * transfer, cannot alter one, and cannot be used to move anything. It exists so
 * that a stranger cannot point the house's paid bundler account at arbitrary
 * traffic. Stating that plainly here because a token that sits in front of a
 * money path invites the assumption that it is guarding the money.
 *
 * WHY NOT JUST USE THE TENANT SESSION. Because the recoveries that matter most
 * are exactly the ones with no session. The hosted grants table is one row per
 * tenant and the kill switch DELETES it, so after a kill the server no longer
 * knows the account — and "I killed my agent and now I want my money" is the
 * single most likely reason someone reaches for recovery. Binding to a session
 * would refuse precisely those cases. So the ticket is minted from a signature
 * instead, which works signed out, after a kill, and for superseded wallets.
 *
 * WHAT THE SIGNATURE PROVES, HONESTLY: that the caller holds SOME private key
 * whose derived Kernel address is the one named. It does not prove the account
 * has ever existed here. That is a real limit — a stranger can generate keys in
 * a loop and mint tickets for accounts nobody has ever funded — and it is why
 * the relay tiers its quota on whether this deployment has actually SEEN the
 * account rather than trusting the ticket alone.
 *
 * THE SIGNED TEXT BINDS ORIGIN AND NONCE, reusing the same shape sign-in uses.
 * A fixed message would make the signature a permanent bearer credential: anyone
 * who ever saw it — a log line, a support paste, a screenshot — could mint
 * tickets for that account forever.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Long enough to plan, read, confirm and submit; short enough to be worthless if leaked. */
export const TICKET_TTL_MS = 15 * 60 * 1000;

function secretOrThrow(): string {
  const s = process.env.MERRYMEN_SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error("MERRYMEN_SESSION_SECRET is not set (hosted mode requires a 32+ char secret)");
  }
  return s;
}

const hmac = (payload: string, secret: string) =>
  createHmac("sha256", secret).update(payload).digest("base64url");

/**
 * The message the OWNER KEY signs, in the browser, to prove control.
 *
 * Deliberately says what it does and does not do, because a user is being asked
 * to sign something with the key that controls all their money and deserves to
 * read a sentence rather than a hex blob.
 */
export function recoveryChallengeMessage(origin: string, nonce: string): string {
  return [
    `${origin} — withdraw from your merrymen account.`,
    "",
    "This proves you control the owner key so the site will relay your withdrawal.",
    "It moves no funds by itself and grants no permissions: the withdrawal itself",
    "is a separate operation you sign next.",
    "",
    `URI: ${origin}`,
    `Nonce: ${nonce}`,
  ].join("\n");
}

export interface Ticket {
  smartAccount: `0x${string}`;
  chainId: number;
  /**
   * This account's class vault, resolved at mint time. Null when there is none
   * on this chain, or when the factory would not answer.
   *
   * IN THE TICKET, NOT DERIVED PER REQUEST, and that is the point. The relay
   * admits a `sweep(address)` leg ONLY when its target equals this — so the
   * pinning is carried by the same HMAC that already binds the account, and the
   * relay needs no chain read on a money path to know which vault is legitimate
   * for this caller. A ticket that names no vault admits no sweep at all.
   */
  classVault: `0x${string}` | null;
  exp: number;
}

/** The wire spelling of "this ticket names no vault". */
const NO_VAULT = "none";

/** Stateless: the ticket IS its own proof, so no server-side store to keep or leak. */
export function mintTicket(t: Omit<Ticket, "exp">, now = Date.now()): string {
  const exp = now + TICKET_TTL_MS;
  // The vault is INSIDE the signed body. Appending it outside the hmac would
  // let a caller edit which vault their ticket blesses, which is the whole
  // thing this field exists to prevent.
  const vault = t.classVault ? t.classVault.toLowerCase() : NO_VAULT;
  const body = `${t.smartAccount.toLowerCase()}.${t.chainId}.${vault}.${exp}`;
  return `${body}.${hmac(body, secretOrThrow())}`;
}

/** Verify and parse, or null. Constant-time on the signature compare. */
export function readTicket(token: string | undefined | null, now = Date.now()): Ticket | null {
  if (!token) return null;
  const parts = token.split(".");
  // FIVE FIELDS SINCE THE VAULT JOINED THE BODY. A ticket in the old four-field
  // shape does not parse and the owner signs the challenge again — which costs
  // them one click, bounded by a 15-minute TTL, and is the correct treatment
  // for a credential whose meaning changed.
  if (parts.length !== 5) return null;
  const [account, chain, vault, exp, sig] = parts as [string, string, string, string, string];
  const body = `${account}.${chain}.${vault}.${exp}`;
  let want: Buffer;
  let got: Buffer;
  try {
    want = Buffer.from(hmac(body, secretOrThrow()));
    got = Buffer.from(sig);
  } catch {
    return null;
  }
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;

  const expMs = Number(exp);
  const chainId = Number(chain);
  if (!Number.isFinite(expMs) || expMs <= now) return null;
  if (!Number.isFinite(chainId)) return null;
  if (!/^0x[0-9a-f]{40}$/.test(account)) return null;
  // A MALFORMED VAULT IS NOT "NO VAULT". The hmac already proves we wrote it, so
  // anything here that is neither an address nor the literal absence marker
  // means this codec and its minter disagree — and silently reading that as
  // "no class sweep" would strand a vault rather than fail loudly.
  if (vault !== NO_VAULT && !/^0x[0-9a-f]{40}$/.test(vault)) return null;
  return {
    smartAccount: account as `0x${string}`,
    chainId,
    classVault: vault === NO_VAULT ? null : (vault as `0x${string}`),
    exp: expMs,
  };
}
