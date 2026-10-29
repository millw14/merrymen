/**
 * A SPOT RESTORE UNDER ANOTHER OWNER KEY IS REFUSED BEFORE ANYTHING IS STOPPED
 * OR SIGNED WHILE THE LOGIN HAS A PERPS WALLET.
 *
 * A login's two wallets must share one owner key (grant-store.ts
 * assertIndependentWallets), and the grant POST refuses a Spot grant whose
 * owner differs from the Perps wallet's. The Wallet screen's restore sends
 * that POST last: its stop has already removed the running Spot grant (and,
 * self-hosted, stopped the Solana strategy) and its on-chain revocation has
 * been paid for. Refused only then, the owner was left with a stopped Spot
 * agent, nothing armed and a re-arm refused the same way. So the restore asks
 * here first, of the server's own view of the Perps wallet (GET
 * /api/grants?wallet=perps, whose grant carries its owner address), and stops
 * before the first step when the key being restored is not that wallet's.
 *
 * A Perps wallet that cannot be read refuses too: it is exactly the wallet the
 * rule is about, and the POST would refuse it after the stop.
 *
 * Browser-safe: a fetch and a comparison, nothing else.
 */
import { walletUrl } from "./wallet-param";

export const RESTORE_PERPS_OWNER_DIFFERS =
  "Your Perps wallet uses another owner key, and both of a login's wallets must use the same one. Restore with that owner key; to change keys, Kill all agents stops both wallets first. Nothing was stopped or signed.";

export const RESTORE_PERPS_UNREAD =
  "Your Perps wallet could not be read, so this restore cannot be checked against it. Nothing was stopped or signed; try again.";

/** The refusal for restoring a Spot wallet owned by `ownerAddress`, or null when the Perps wallet allows it (none, or the same owner). */
export async function restorePerpsRefusal(ownerAddress: string, read: typeof fetch = fetch): Promise<string | null> {
  let res: Response;
  try {
    res = await read(walletUrl("/api/grants", "perps"), { cache: "no-store" });
  } catch {
    return RESTORE_PERPS_UNREAD;
  }
  if (!res.ok) return RESTORE_PERPS_UNREAD;
  const body = (await res.json().catch(() => null)) as { exists?: unknown; grant?: { owner?: unknown } } | null;
  if (body?.exists === false) return null;
  if (body?.exists !== true || typeof body.grant?.owner !== "string") return RESTORE_PERPS_UNREAD;
  return body.grant.owner.toLowerCase() === ownerAddress.toLowerCase() ? null : RESTORE_PERPS_OWNER_DIFFERS;
}
