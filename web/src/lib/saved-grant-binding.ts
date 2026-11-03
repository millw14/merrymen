import { recoverMessageAddress } from "viem";
import { bindingMessage, grantPurpose, isGrantPurpose, type GrantPurpose } from "@merrymen/core";
import type { Grant } from "./session";

type Session = { hosted: boolean; address: string | null };
const RECOVERY_PREFIX = "merrymen.permission-recovery.v1.";

/**
 * Historical signature evidence for recovery display, never fresh grant authorization.
 *
 * THE CLAIM IS REBUILT FOR THE WALLET THE GRANT SIGNED (core bindingMessage
 * adds "Account purpose: perps"; a grant with no purpose is Spot, as it always
 * was). A Perps claim rebuilt as Spot text recovers to nobody, so without the
 * purpose a Perps grant could never be recognised; and a grant that names no
 * wallet this build knows is evidence of nothing.
 */
export async function trustedSavedGrant(grant: Grant | null, session: Session, origin: string): Promise<boolean> {
  if (!grant) return false;
  if (!session.hosted) return true;
  if (!session.address || !grant.binding) return false;
  try {
    const binding = grant.binding;
    const version = binding.version ?? "legacy-wallet-owner-v1";
    if (version !== "legacy-wallet-owner-v1" && version !== "privy-did-owner-v1") return false;
    if (grant.chainId !== 4663 && grant.chainId !== 46630) return false;
    const purpose = grantPurpose(grant);
    const common = { origin, nonce: binding.nonce, owner: grant.owner, smartAccount: grant.smartAccount, chainId: grant.chainId, purpose };
    if (version === "privy-did-owner-v1") {
      if (typeof binding.did !== "string" || !binding.did || grant.owner.toLowerCase() !== session.address.toLowerCase()) return false;
      const message = bindingMessage({ ...common, version, did: binding.did });
      return (await recoverMessageAddress({ message, signature: binding.ownerSignature })).toLowerCase() === session.address.toLowerCase();
    }
    if (!binding.walletSignature || grant.owner.toLowerCase() === session.address.toLowerCase()) return false;
    const message = bindingMessage({ ...common, version });
    const [owner, tenant] = await Promise.all([
      recoverMessageAddress({ message, signature: binding.ownerSignature }),
      recoverMessageAddress({ message, signature: binding.walletSignature }),
    ]);
    return owner.toLowerCase() === grant.owner.toLowerCase() && tenant.toLowerCase() === session.address.toLowerCase();
  } catch { return false; }
}

/**
 * Separate public snapshot keeps adopted grants recoverable after the server stop.
 *
 * THE WALLET IS SAVED WITH IT: a Perps grant's `purpose` is part of what its
 * owner signed (the claim's text, the wall it rebuilds to), so a snapshot
 * without it would be a Spot claim nobody signed, and a Perps screen could not
 * find its own. A Spot grant has none, and its snapshot is byte for byte what
 * it always was. The key is chain and account, and the two wallets are two
 * accounts, so neither snapshot can overwrite the other's.
 */
export function saveRecoveryGrant(grant: Grant): void {
  // Whitelist public renewal inputs; never duplicate a root/session secret or
  // overwrite the full local grant held under merrymen.grant.v1.
  const { purpose, smartAccount, owner, sessionKeyAddress, caps, grantedAt, expiresAt, chainId, grantFeatures, grantTokens, binding, v4AdapterAddress, ponsAdapterAddress, ponsClassVaultAddress, ponsClassVaultFactoryAddress, trencherVaultAddress, trencherFactoryAddress } = grant;
  localStorage.setItem(`${RECOVERY_PREFIX}${chainId}.${smartAccount.toLowerCase()}`, JSON.stringify({
    ...(purpose === undefined ? {} : { purpose }),
    smartAccount, owner, sessionKeyAddress, caps, grantedAt, expiresAt, chainId, grantFeatures, grantTokens, binding, v4AdapterAddress, ponsAdapterAddress, ponsClassVaultAddress, ponsClassVaultFactoryAddress, trencherVaultAddress, trencherFactoryAddress,
  }));
}

/**
 * Every returned object still requires trustedSavedGrant against the fresh session.
 *
 * ONE WALLET'S SNAPSHOTS, the wallet named (required, as the grant slots in
 * session.ts take it): a saved record with no purpose is Spot, as every record
 * saved before Perps is. Without the filter a Spot screen would offer a Perps
 * grant as the one to resume or renew, and sign it as Spot at the wrong index.
 * A record that names no wallet this build knows is unreadable, like any other
 * malformed record, and blocks a fresh mint rather than vanishing.
 */
export function loadRecoveryGrants(wallet: GrantPurpose): Grant[] {
  if (!isGrantPurpose(wallet)) throw new Error("Unrecognised wallet purpose");
  const grants: Grant[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(RECOVERY_PREFIX)) continue;
      const value = JSON.parse(localStorage.getItem(key) ?? "null") as Grant | null;
      if (!value?.smartAccount || !value.owner || !value.caps) throw new Error();
      if (grantPurpose(value) === wallet) grants.push(value);
    }
  } catch {
    throw new Error("Saved wallet recovery details could not be read. No new permission was signed. Keep your recovery keys and contact support before creating another grant.");
  }
  return grants.sort((a, b) => b.grantedAt - a.grantedAt);
}
