/**
 * MAY A RENEWAL SKIP REVOKING THE OLD KEY ON CHAIN? Only for a paper Perps
 * wallet whose old wall is empty (decision D6). Everywhere else, no.
 *
 * Main's renewal (Wallet.tsx) stops the old grant on the server, then revokes
 * its key on chain from the browser (revoke-client.ts revokeFromBrowser: an
 * owner-signed invalidateNonce userOp) before the new grant is minted. That
 * userOp costs gas, deploys an undeployed account, and the relay has no
 * paymaster, so assertRevocationFunded refuses an account holding no ETH. A
 * paper Perps wallet holds none and never needs any: its book starts from a
 * paper balance. So every paper Perps renewal would be refused with "needs ETH
 * … Nothing was stopped or signed", forever.
 *
 * THE EXEMPTION IS NARROW, AND IT IS SAFE BECAUSE OF WHAT IT COVERS. A key
 * whose wall is empty can do nothing on chain — no call is permitted — so
 * revoking it removes no authority, and leaving it in place leaves none. The
 * server's fence still applies: a replacement stop retires the old session
 * key's hash, and the store refuses that key for good (grant-store
 * retiredSessionKeyHashes), so the old key can never be armed again here.
 *
 * "EMPTY" IS DECIDED BY REBUILDING THE WALL, not by reading a flag: the wall
 * the grant's own signed purpose, markers, chain and perp block rebuild to
 * (core grantWallOptions, buildCallPermissions — the rebuild POST /api/grants
 * compared byte for byte at intake, canonical-wall.ts) must hold no
 * permission. A Spot grant, a Perps grant carrying the energy buy or a perp
 * block, or anything this cannot read, keeps the revocation — the answer that
 * costs gas, never the one that leaves authority behind.
 *
 * Pure, and NO CALLER YET. The dashboard renewal (Wallet.tsx renewKey) renews
 * Spot only and refuses a Perps grant before anything is read or stopped: its
 * account read is Spot's and its revocation derives index 0. The Perps
 * renewal (perps slice 5, PR 3) asks this before assertRevocationFunded, of
 * the server's view of the old grant (GET /api/grants?wallet=perps) and of the
 * page's own copy; when the server holds none (null: an earlier renewal's stop
 * was accepted and its POST never landed), the page's copy alone decides, since
 * every Perps key the server accepted had an empty wall. A revocation it does
 * make derives at accountIndexForPurpose("perps").
 */
import { buildCallPermissions, grantPurpose, grantWallOptions, type GrantCaps } from "@merrymen/core";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function renewalSkipsRevocation(previous: unknown): boolean {
  if (typeof previous !== "object" || previous === null) return false;
  const g = previous as {
    purpose?: unknown;
    smartAccount?: unknown;
    caps?: unknown;
    chainId?: unknown;
    grantFeatures?: unknown;
    grantTokens?: unknown;
    perp?: unknown;
  };
  try {
    if (grantPurpose(g) !== "perps") return false;
  } catch {
    return false;
  }
  // The markers a wall is rebuilt from, as a list. Absent is not "none": a
  // grant whose markers cannot be read cannot be shown to have an empty wall.
  if (!Array.isArray(g.grantFeatures) || g.grantFeatures.some((f) => typeof f !== "string")) return false;
  if (g.grantTokens !== undefined && !Array.isArray(g.grantTokens)) return false;
  if (typeof g.smartAccount !== "string" || !ADDRESS.test(g.smartAccount)) return false;
  if (typeof g.caps !== "object" || g.caps === null) return false;
  try {
    const wall = buildCallPermissions(
      g.caps as GrantCaps,
      g.smartAccount as `0x${string}`,
      grantWallOptions({
        purpose: g.purpose,
        grantFeatures: g.grantFeatures as string[],
        grantTokens: g.grantTokens as string[] | undefined,
        chainId: typeof g.chainId === "number" ? g.chainId : undefined,
        perp: g.perp,
      }),
    );
    // A perp block the rebuild could not read is not "no perps": refuse it.
    return wall.length === 0 && g.perp === undefined;
  } catch {
    return false;
  }
}
