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
 * nowhere on hosted. The GET says it is hosted by echoing the tenant.
 *
 * Browser-safe: a fetch and a comparison, nothing else.
 */
import { walletUrl } from "./wallet-param";

export const RESTORE_PERPS_OWNER_DIFFERS =
  "Your Perps wallet uses another owner key, and both of a login's wallets must use the same one. Restore with that owner key; to change keys, Kill all agents stops both wallets first. Nothing was stopped or signed.";

export const RESTORE_PERPS_HOSTED =
  "Your Perps wallet is owned by the wallet you sign in with, and a restored owner key cannot sit beside it, so no key can be restored while you hold a Perps wallet. Nothing was stopped or signed.";

export const RESTORE_PERPS_UNREAD =
  "Your Perps wallet could not be read, so this restore cannot be checked against it. Nothing was stopped or signed. Try again in a moment; if it keeps failing, Kill all agents stops both wallets and says whether it removed this one, and once it has, your Perps wallet no longer stands in the way of a restore.";

/** Said after the renewal's own "This attempt kept your existing permission unchanged." */
export const RENEWAL_PERPS_OWNER_DIFFERS =
  "Your Perps wallet uses another owner key, and both of a login's wallets must use the same one, so the renewed permission would be refused.";

/** Said after the renewal's own "This attempt kept your existing permission unchanged." */
export const RENEWAL_PERPS_UNREAD =
  "Your Perps wallet could not be read, so this renewal cannot be checked against it. Try again in a moment.";

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
  const body = (await res.json().catch(() => null)) as { exists?: unknown; tenant?: unknown; stored?: unknown; grant?: { owner?: unknown } } | null;
  const hosted = typeof body?.tenant === "string";
  const owner = body?.exists === false
    ? body.stored === true ? body.tenant : null
    : body?.exists === true ? body.grant?.owner : undefined;
  if (owner === null) return { kind: "none" };
  if (typeof owner !== "string") return { kind: "unread" };
  return { kind: "owned", owner, hosted };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The refusal for restoring a Spot wallet owned by `ownerAddress`, or null when the Perps wallet allows it (none, or self-hosted under the same owner). */
export async function restorePerpsRefusal(ownerAddress: string, read: typeof fetch = fetch): Promise<string | null> {
  const perps = await readPerpsOwner(read);
  if (perps.kind === "none") return null;
  if (perps.kind === "unread") return RESTORE_PERPS_UNREAD;
  if (perps.hosted) return RESTORE_PERPS_HOSTED;
  return same(perps.owner, ownerAddress) ? null : RESTORE_PERPS_OWNER_DIFFERS;
}

/** The refusal for renewing the Spot wallet under `ownerAddress` (the key it re-signs with), or null when the Perps wallet allows it. */
export async function renewalPerpsRefusal(ownerAddress: string, read: typeof fetch = fetch): Promise<string | null> {
  const perps = await readPerpsOwner(read);
  if (perps.kind === "none") return null;
  if (perps.kind === "unread") return RENEWAL_PERPS_UNREAD;
  return same(perps.owner, ownerAddress) ? null : RENEWAL_PERPS_OWNER_DIFFERS;
}
