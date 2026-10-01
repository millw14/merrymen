import { recoverMessageAddress } from "viem";
import { bindingMessage } from "@merrymen/core";
import type { Grant } from "./session";

type Session = { hosted: boolean; address: string | null };
const RECOVERY_PREFIX = "merrymen.permission-recovery.v1.";

/** Historical signature evidence for recovery display, never fresh grant authorization. */
export async function trustedSavedGrant(grant: Grant | null, session: Session, origin: string): Promise<boolean> {
  if (!grant) return false;
  if (!session.hosted) return true;
  if (!session.address || !grant.binding) return false;
  try {
    const binding = grant.binding;
    const version = binding.version ?? "legacy-wallet-owner-v1";
    if (version !== "legacy-wallet-owner-v1" && version !== "privy-did-owner-v1") return false;
    if (grant.chainId !== 4663 && grant.chainId !== 46630) return false;
    const common = { origin, nonce: binding.nonce, owner: grant.owner, smartAccount: grant.smartAccount, chainId: grant.chainId };
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

/** Separate public snapshot keeps adopted grants recoverable after the server stop. */
export function saveRecoveryGrant(grant: Grant): void {
  // Whitelist public renewal inputs; never duplicate a root/session secret or
  // overwrite the full local grant held under merrymen.grant.v1.
  const { smartAccount, owner, sessionKeyAddress, caps, grantedAt, expiresAt, chainId, grantFeatures, grantTokens, binding, v4AdapterAddress, ponsAdapterAddress, ponsClassVaultAddress, ponsClassVaultFactoryAddress, trencherVaultAddress, trencherFactoryAddress } = grant;
  localStorage.setItem(`${RECOVERY_PREFIX}${chainId}.${smartAccount.toLowerCase()}`, JSON.stringify({
    smartAccount, owner, sessionKeyAddress, caps, grantedAt, expiresAt, chainId, grantFeatures, grantTokens, binding, v4AdapterAddress, ponsAdapterAddress, ponsClassVaultAddress, ponsClassVaultFactoryAddress, trencherVaultAddress, trencherFactoryAddress,
  }));
}

/** Every returned object still requires trustedSavedGrant against the fresh session. */
export function loadRecoveryGrants(): Grant[] {
  const grants: Grant[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(RECOVERY_PREFIX)) continue;
      const value = JSON.parse(localStorage.getItem(key) ?? "null") as Grant | null;
      if (!value?.smartAccount || !value.owner || !value.caps) throw new Error();
      grants.push(value);
    }
  } catch {
    throw new Error("Saved wallet recovery details could not be read. No new permission was signed. Keep your recovery keys and contact support before creating another grant.");
  }
  return grants.sort((a, b) => b.grantedAt - a.grantedAt);
}
