/**
 * A SPOT RESTORE OR RENEWAL THE PERPS WALLET WOULD REFUSE IS REFUSED BEFORE
 * ANYTHING IS STOPPED OR SIGNED.
 *
 * A login's two wallets must share one owner key (grant-store.ts
 * assertIndependentWallets), and the grant POST refuses a Spot grant whose
 * owner differs from the Perps wallet's, or one it cannot check against an
 * unreadable Perps wallet. The Wallet screen's restore and its renewal both
 * send that POST last: their stop has already removed the running Spot grant
 * (and, self-hosted, stopped the Solana strategy) and their on-chain
 * revocation has been paid for. Refused only then, the owner was left with a
 * stopped Spot agent, nothing armed and a re-arm refused the same way. So each
 * asks here first, of the server's own view of the Perps wallet (GET
 * /api/grants?wallet=perps, whose grant carries its owner address), and stops
 * before its first step when the key it would sign with is not that wallet's.
 *
 * A Perps wallet that cannot be read refuses too: it is exactly the wallet the
 * rule is about, and the POST would refuse it after the stop. Self-hosted the
 * GET reads the Perps grant.json as the POST does (only a missing file is
 * none); hosted it answers 503 when the store cannot, and `stored` for a
 * record the store holds but will not show (one stopped for a renewal whose
 * POST has not landed, or, on the file store, one it cannot parse), which the
 * store's put still compares, or refuses on.
 *
 * HOSTED, NO RESTORE CAN BE MADE WHILE A PERPS WALLET EXISTS OR IS STORED.
 * A hosted Perps wallet's owner is always the login (perps-owner), and a
 * restore always signs its claim as a legacy owner key, which the server
 * refuses when that key is the login itself (one key, two proofs; auth.ts).
 * Every key is therefore either another owner, refused by the store, or the
 * login, refused by the binding, each after the stop. So the restore is
 * refused here whatever the key, in words true there: the self-hosted advice
 * (restore with the Perps wallet's key, or Kill all to change keys) leads
 * nowhere on hosted, where a login that can hold a Perps wallet (an embedded
 * Privy one) has no browser wallet to sign a restore's legacy claim with at
 * all. So the hosted sentences name no way out: they say the restore was
 * refused and why, never that removing the Perps wallet would let it through.
 * The GET says it is hosted by echoing the tenant; a 503 echoes nothing, so
 * the screen says it (`hosted`).
 *
 * THE RENEWAL ASKS WITH THE KEY IT RE-SIGNS WITH, and only when that key is
 * the Spot grant's own owner: a browser whose signer is another (another
 * Privy login's embedded wallet) is the preflight's to refuse, in its own
 * words, before anything is stopped, and the Perps wallet is no part of it.
 *
 * Browser-safe: a fetch and a comparison, nothing else.
 */
import { walletUrl } from "./wallet-param";

export const RESTORE_PERPS_OWNER_DIFFERS =
  "Your Perps wallet uses another owner key, and both of a login's wallets must use the same one. Restore with that owner key; to change keys, Kill all agents stops both wallets first. Nothing was stopped or signed.";

export const RESTORE_PERPS_HOSTED =
  "Your Perps wallet is owned by the wallet you sign in with, and a restored owner key cannot sit beside it, so this restore was refused. Nothing was stopped or signed.";

/** Hosted: no Kill-all way out, which leads nowhere there (see the header). */
export const RESTORE_PERPS_UNREAD_HOSTED =
  "Your Perps wallet could not be read just now, so this restore cannot be checked against it. Nothing was stopped or signed. While you hold a Perps wallet, a restored owner key cannot sit beside it: it is owned by the wallet you sign in with.";

export const RESTORE_PERPS_UNREAD =
  "Your Perps wallet could not be read, so this restore cannot be checked against it. Nothing was stopped or signed. Try again in a moment; if it keeps failing, Kill all agents stops both wallets and says whether it removed this one, and once it has, your Perps wallet no longer stands in the way of a restore.";

/** Said after the renewal's own "This attempt kept your existing permission unchanged." */
export const RENEWAL_PERPS_OWNER_DIFFERS =
  "Your Perps wallet uses another owner key, and both of a login's wallets must use the same one, so the renewed permission would be refused.";

/** Said after the renewal's own "This attempt kept your existing permission unchanged." */
export const RENEWAL_PERPS_UNREAD =
  "Your Perps wallet could not be read, so this renewal cannot be checked against it. Your current permission keeps running until it expires. Try again in a moment; if it keeps failing, Kill all agents stops both wallets and says whether it removed the Perps one.";

/** What the server says of the login's Perps wallet: none, unreadable, or held by `owner`. */
type PerpsOwner = { kind: "none" } | { kind: "unread" } | { kind: "owned"; owner: string; hosted: boolean };

async function readPerpsOwner(read: typeof fetch): Promise<PerpsOwner> {
  let res: Response;
  try {
    res = await read(walletUrl("/api/grants", "perps"), { cache: "no-store" });
  } catch {
    return { kind: "unread" };
  }
  if (!res.ok) return { kind: "unread" };
  const body = (await res.json().catch(() => null)) as { exists?: unknown; tenant?: unknown; stored?: unknown; storedOwner?: unknown; grant?: { owner?: unknown } } | null;
  const hosted = typeof body?.tenant === "string";
  const owner = body?.exists === false
    ? body.stored === true ? body.tenant ?? body.storedOwner : null
    : body?.exists === true ? body.grant?.owner : undefined;
  if (owner === null) return { kind: "none" };
  if (typeof owner !== "string") return { kind: "unread" };
  return { kind: "owned", owner, hosted };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The refusal for restoring a Spot wallet owned by `ownerAddress`, or null when
 * the Perps wallet allows it (none, or self-hosted under the same owner).
 * `hosted`: the session's, for an answer that echoes no tenant (a 503).
 */
export async function restorePerpsRefusal(ownerAddress: string, read: typeof fetch = fetch, hosted = false): Promise<string | null> {
  const perps = await readPerpsOwner(read);
  if (perps.kind === "none") return null;
  if (perps.kind === "unread") return hosted ? RESTORE_PERPS_UNREAD_HOSTED : RESTORE_PERPS_UNREAD;
  if (perps.hosted) return RESTORE_PERPS_HOSTED;
  return same(perps.owner, ownerAddress) ? null : RESTORE_PERPS_OWNER_DIFFERS;
}

/**
 * The refusal for renewing the Spot wallet owned by `grantOwner` with the key
 * `resigner`, or null when the Perps wallet allows it. Null, with nothing
 * read, when the re-signing key is not the grant's owner: the preflight
 * refuses that signer in its own words, before anything is stopped.
 */
export async function renewalPerpsRefusal(resigner: string | null, grantOwner: string, read: typeof fetch = fetch): Promise<string | null> {
  if (!resigner || !same(resigner, grantOwner)) return null;
  const ownerAddress = resigner;
  const perps = await readPerpsOwner(read);
  if (perps.kind === "none") return null;
  if (perps.kind === "unread") return RENEWAL_PERPS_UNREAD;
  return same(perps.owner, ownerAddress) ? null : RENEWAL_PERPS_OWNER_DIFFERS;
}
