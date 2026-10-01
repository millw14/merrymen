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
 * sponsorship additionally requires a durable account history on this deployment
 * and a server-held spending policy. A ticket alone never qualifies for gas.
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
export function recoveryChallengeMessage(origin: string, nonce: string, ownerActions = false): string {
  return [
    ownerActions ? `${origin} — recover your merrymen account.` : `${origin} — withdraw from your merrymen account.`,
    "",
    ownerActions
      ? "This proves you control the owner key so the site can relay withdrawals and permission revocations."
      : "This proves you control the owner key so the site will relay your withdrawal.",
    ownerActions
      ? "It moves no funds by itself and grants no permissions: each operation"
      : "It moves no funds by itself and grants no permissions: the withdrawal itself",
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
   * This account's class vaults, resolved at mint time. EMPTY when there are
   * none on this chain, or when no factory would answer.
   *
   * A SET, BECAUSE AFTER v2 AN ACCOUNT HAS TWO. The vault address is a CREATE2
   * function of the factory, so a second factory means a second vault — and an
   * owner who has re-signed onto v2 may still have a balance sitting in their
   * v1 one. A ticket that blesses one of them tells the other's owner their own
   * vault is "something other than this account's own class vault".
   *
   * IN THE TICKET, NOT DERIVED PER REQUEST, and that is still the point. The
   * relay admits a `sweep(address)` leg ONLY when its target is IN this set —
   * so the pinning is carried by the same HMAC that already binds the account,
   * and the relay needs no chain read on a money path to know which vaults are
   * legitimate for this caller. A ticket that names none admits no sweep at all.
   *
   * It is a closed set decided by the SERVER from the account. Nothing a caller
   * sends can add to it, which is the property that survives going plural.
   */
  classVaults: readonly `0x${string}`[];
  /** Server-derived owner, deployment and cross-chain family; never caller input. */
  sponsorship?: {
    owner: `0x${string}`;
    factory: `0x${string}`;
    factoryData: `0x${string}`;
    accounts: readonly `0x${string}`[];
  };
  exp: number;
}

/** The wire spelling of "this ticket names no vault". */
const NO_VAULT = "none";
/**
 * Separates vaults INSIDE the third body field.
 *
 * Not a dot: the body is dot-delimited and a fourth field would change the wire
 * shape for every reader. Addresses are hex, so a hyphen cannot occur inside
 * one and the split is unambiguous.
 */
const VAULT_SEP = "-";

/** Stateless: the ticket IS its own proof, so no server-side store to keep or leak. */
export function mintTicket(t: Omit<Ticket, "exp">, now = Date.now()): string {
  const exp = now + TICKET_TTL_MS;
  // The vault is INSIDE the signed body. Appending it outside the hmac would
  // let a caller edit which vault their ticket blesses, which is the whole
  // thing this field exists to prevent.
  const vault =
    t.classVaults.length > 0 ? t.classVaults.map((v) => v.toLowerCase()).join(VAULT_SEP) : NO_VAULT;
  const capability = t.sponsorship
    ? `.${Buffer.from(JSON.stringify(t.sponsorship)).toString("base64url")}` : "";
  const body = `${t.smartAccount.toLowerCase()}.${t.chainId}.${vault}.${exp}${capability}`;
  return `${body}.${hmac(body, secretOrThrow())}`;
}

/** Verify and parse, or null. Constant-time on the signature compare. */
export function readTicket(token: string | undefined | null, now = Date.now()): Ticket | null {
  if (!token) return null;
  const parts = token.split(".");
  // Existing five-field tickets retain their unsponsored recovery authority.
  // The sixth field carries additional server-derived sponsorship proof; an
  // old ticket must be refreshed before it can request any house-paid gas.
  if (parts.length !== 5 && parts.length !== 6) return null;
  const [account, chain, vault, exp] = parts as [string, string, string, string];
  const sig = parts.at(-1)!;
  const body = parts.slice(0, -1).join(".");
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
  // anything here that is neither an address list nor the literal absence marker
  // means this codec and its minter disagree — and silently reading that as
  // "no class sweep" would strand a vault rather than fail loudly. ONE bad entry
  // fails the whole ticket for the same reason: dropping it would quietly shrink
  // the set the owner was shown.
  let classVaults: `0x${string}`[] = [];
  if (vault !== NO_VAULT) {
    const parsed = vault.split(VAULT_SEP);
    if (parsed.some((v) => !/^0x[0-9a-f]{40}$/.test(v))) return null;
    classVaults = parsed as `0x${string}`[];
  }
  let sponsorship: Ticket["sponsorship"];
  if (parts.length === 6) {
    try {
      const value = JSON.parse(Buffer.from(parts[4]!, "base64url").toString("utf8"));
      const address = (v: unknown) => typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v);
      if (!value || !address(value.owner) || !address(value.factory) ||
          typeof value.factoryData !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(value.factoryData) ||
          !Array.isArray(value.accounts) || value.accounts.length < 1 || value.accounts.length > 2 ||
          !value.accounts.every(address) || !value.accounts.some((a: string) => a.toLowerCase() === account)) return null;
      sponsorship = value;
    } catch { return null; }
  }
  return {
    smartAccount: account as `0x${string}`,
    chainId,
    classVaults,
    exp: expMs,
    ...(sponsorship ? { sponsorship } : {}),
  };
}
