/** Browser-only wallet preparation. Partner API keys belong on your server. */
import { type LocalAccount } from "viem";
import { type StoredGrant } from "../packages/core/src/grant";
import { carriesOwnerKey } from "../packages/core/src/hosted";
import {
  canonicalJson,
  partnerGrantDigest,
  partnerEnrollmentMessage,
  type PartnerEnrollmentClaim,
  type PartnerEnrollmentSettings,
} from "../packages/core/src/partner-enrollment";
import { prepareAgentGrant, type PrepareAgentOptions } from "../web/src/lib/session";

export type { PartnerEnrollmentSettings, PartnerEnrollmentClaim };
export type { StoredGrant, GrantCaps } from "../packages/core/src/grant";
export type { LocalAccount } from "viem";

export interface PrepareMerrymanOptions extends Omit<PrepareAgentOptions, "onStatus"> {
  owner: LocalAccount;
  onStatus?: (status: string) => void;
}

/** Derive and sign the same permission wall the Merrymen dashboard uses. */
export async function prepareMerryman({ owner, onStatus = () => {}, ...options }: PrepareMerrymanOptions): Promise<StoredGrant> {
  const grant = await prepareAgentGrant(owner, { ...options, onStatus });
  if (carriesOwnerKey(grant)) throw new Error("An owner private key must never be included in a partner grant.");
  return grant;
}

export interface MerrymanAuthorizationChallenge {
  claim: PartnerEnrollmentClaim;
  message: string;
  challenge_token: string;
}

export interface SignMerrymanAuthorizationOptions {
  owner: LocalAccount;
  grant: StoredGrant;
  challenge: MerrymanAuthorizationChallenge;
  /** The choices the owner just approved in your application's form. */
  settings: PartnerEnrollmentSettings;
  /** Pin to your application/agent, never to identifiers copied from a challenge. */
  expectedAppId: string;
  expectedAgentId: string;
  expectedExternalUserId: string;
  /** Exact capabilities the user approved: read:agents and optionally chat:agents. */
  expectedScopes: readonly string[];
}

/**
 * Sign only a challenge that binds this exact grant, app, agent and settings.
 * The returned session grant goes to your backend for activation. No request
 * is sent here, and the owner wallet's private key is never requested.
 */
export async function signMerrymanAuthorization({
  owner, grant, challenge, settings, expectedAppId, expectedAgentId, expectedExternalUserId, expectedScopes,
}: SignMerrymanAuthorizationOptions): Promise<{
  grant: StoredGrant;
  challenge_token: string;
  signature: `0x${string}`;
}> {
  if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner.address) || typeof owner.signMessage !== "function") {
    throw new Error("An explicit wallet signer is required.");
  }
  if (carriesOwnerKey(grant)) throw new Error("An owner private key must never be included in a partner grant.");
  const claim = challenge?.claim;
  if (!claim || claim.v !== 1 || !expectedAppId || !expectedAgentId
      || claim.app_id !== expectedAppId || claim.agent_id !== expectedAgentId) {
    throw new Error("The authorization challenge belongs to a different app or agent.");
  }
  if (!expectedExternalUserId || claim.external_user_id !== expectedExternalUserId) {
    throw new Error("The authorization challenge belongs to a different user in this app.");
  }
  const scopes = (values: readonly string[]) => [...new Set(values)].sort();
  const allowed = new Set(["read:agents", "chat:agents"]);
  if (!Array.isArray(claim.scopes) || !Array.isArray(expectedScopes)
      || claim.scopes.some((scope) => !allowed.has(scope))
      || canonicalJson(scopes(claim.scopes)) !== canonicalJson(scopes(expectedScopes))) {
    throw new Error("The authorization challenge changes the app access you approved.");
  }
  if (claim.owner.toLowerCase() !== owner.address.toLowerCase()
      || grant.owner.toLowerCase() !== owner.address.toLowerCase()
      || claim.smart_account.toLowerCase() !== grant.smartAccount.toLowerCase()
      || claim.chain_id !== grant.chainId
      || claim.grant_hash !== partnerGrantDigest(grant)) {
    throw new Error("The authorization challenge does not match the wallet and signed permission grant.");
  }
  if (canonicalJson(claim.settings) !== canonicalJson(settings)) {
    throw new Error("The authorization challenge changes the agent settings you approved.");
  }
  if (!Number.isFinite(claim.expires_at) || claim.expires_at <= Date.now()
      || claim.expires_at > Date.now() + 15 * 60_000 || !claim.nonce
      || typeof challenge.challenge_token !== "string" || !challenge.challenge_token) {
    throw new Error("The authorization challenge is expired or invalid. Request a new one.");
  }
  const message = partnerEnrollmentMessage(claim);
  if (challenge.message !== message) throw new Error("The authorization message does not match its signed fields.");
  return { grant, challenge_token: challenge.challenge_token, signature: await owner.signMessage({ message }) };
}

/** Send this digest, never an owner key, when your backend requests a challenge. */
export { partnerGrantDigest };
