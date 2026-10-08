/** Browser-only wallet preparation. Partner API keys belong on your server. */
import { type LocalAccount } from "viem";
import { robinhoodChain, robinhoodTestnet } from "../packages/core/src/chain";
import { type GrantCaps, type StoredGrant } from "../packages/core/src/grant";
import { carriesOwnerKey } from "../packages/core/src/hosted";
import {
  canonicalJson,
  partnerGrantDigest,
  partnerEnrollmentMessage,
  type PartnerEnrollmentClaim,
  type PartnerEnrollmentSettings,
} from "../packages/core/src/partner-enrollment";
import { prepareAgentGrant } from "../web/src/lib/session";

export type { PartnerEnrollmentSettings, PartnerEnrollmentClaim };
export type { StoredGrant, GrantCaps } from "../packages/core/src/grant";
export type { LocalAccount } from "viem";

/**
 * WHICH SDK THIS IS. The bundle compiles in the dashboard's own signer
 * (web/src/lib/session.ts), so a dashboard change is an SDK change that nothing
 * else announces. PARTNER_API_VERSION is the contract this SDK speaks: the
 * api_version GET /partner/v1/meta reports. SDK_VERSION adds the build, a
 * fingerprint of the bundle's own bytes stamped by sdk/build.mjs, so builds of
 * different code never share a version. "+source" means it is running unbundled.
 */
export const PARTNER_API_VERSION = "2026-09-18";
declare const __MERRYMEN_SDK_BUILD__: string | undefined;
export const SDK_VERSION = `${PARTNER_API_VERSION}+${typeof __MERRYMEN_SDK_BUILD__ === "string" ? __MERRYMEN_SDK_BUILD__ : "source"}`;

/**
 * WHAT A PARTNER CHOOSES: the owner, the limits and the chain. Nothing else.
 *
 * The dashboard signer also takes a v4 or Pons adapter, a class vault factory
 * and extra tokens, and seals whatever address it is given into the
 * owner-signed wall as a call target or approved spender. Partner activation
 * rebuilds that wall from the grant's own declared addresses, so it cannot tell
 * a partner's contract from the deployed one: a partner that named its own
 * "adapter" got the owner's one opaque signature approving it as a USDG
 * spender, and activation linked the grant. Left out, the signer seals only the
 * platform's own class vault factory and listed tokens.
 *
 * NO TRENCHER either. `trencherFactory` seals `trencherFactoryAddress` and
 * `trencherVaultAddress`, which activation refuses (validGrant in
 * web/src/lib/partner-enrollment.ts): enrollment grants no Trencher permission,
 * so the option let an owner approve a permission that then failed with a 400.
 */
export interface PrepareMerrymanOptions {
  owner: LocalAccount;
  caps: GrantCaps;
  /** Robinhood Chain 4663, the default and real funds, or its testnet 46630. */
  chainId?: number;
  onStatus?: (status: string) => void;
}
const OPTIONS: readonly string[] = ["owner", "caps", "chainId", "onStatus"];

/**
 * PARTNER ACTIVATION'S LIMITS, BEFORE THE OWNER SIGNS. The signer seals whatever
 * numbers it is given (a missing maxOpsPerDay, a 366-day expiry, a per-trade cap
 * above the daily one) and activation, validGrant in
 * web/src/lib/partner-enrollment.ts, then refuses the signed grant. These are
 * its rules; sdk/browser.test.ts puts every case through both, so the two
 * cannot drift apart unnoticed.
 */
const CAP_FIELDS: readonly string[] = ["perTradeUsdg", "dailyUsdg", "expiryDays", "maxDrawdownPct", "maxOpsPerDay"];
function activatableCaps(caps: unknown): boolean {
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) return false;
  const c = caps as Record<string, unknown>;
  if (Object.keys(c).some((field) => !CAP_FIELDS.includes(field))) return false;
  if (CAP_FIELDS.some((field) => typeof c[field] !== "number" || !Number.isFinite(c[field]) || (c[field] as number) < 1)) return false;
  const { perTradeUsdg, dailyUsdg, expiryDays, maxDrawdownPct, maxOpsPerDay } = c as unknown as GrantCaps;
  return perTradeUsdg <= dailyUsdg && maxDrawdownPct <= 100
    && Number.isSafeInteger(expiryDays) && expiryDays <= 365 && Number.isSafeInteger(maxOpsPerDay);
}

/**
 * Derive and sign the same permission wall the Merrymen dashboard uses.
 *
 * Anything partner activation would refuse is refused HERE, before a chain read
 * or a signature: the owner must never approve a permission that activation
 * then throws away, nor one naming a contract nobody verified.
 */
export async function prepareMerryman(options: PrepareMerrymanOptions): Promise<StoredGrant> {
  const { owner, caps, onStatus = () => {} } = options;
  // The type offers nothing else; plain-JavaScript callers can still pass it.
  // Refused rather than dropped, so an integrator who asked for a route learns
  // it was not sealed. Only the four fields below ever reach the signer.
  const unoffered = Object.keys(options).filter((key) => !OPTIONS.includes(key) && (options as unknown as Record<string, unknown>)[key] !== undefined);
  if (unoffered.includes("trencherFactory")) {
    throw new Error("Partner enrollment does not grant Trencher permissions: remove trencherFactory. Nothing was signed.");
  }
  if (unoffered.length) {
    throw new Error(
      `prepareMerryman takes only owner, caps, chainId and onStatus; remove ${unoffered.join(", ")}. ` +
        "Partner enrollment seals the platform's own routes and listed tokens. Nothing was signed.",
    );
  }
  // ONLY THE CHAINS ACTIVATION ACCEPTS, and checked here because the signer
  // cannot: it maps every id but the testnet's to MAINNET (chainForId), so a
  // typo like 46631, another network's 1 or the string "46630" sealed a
  // real-funds Robinhood Chain permission without a word.
  const chainId = options.chainId ?? robinhoodChain.id;
  if (chainId !== robinhoodChain.id && chainId !== robinhoodTestnet.id) {
    throw new Error(`chainId ${JSON.stringify(options.chainId)} is not a partner enrollment chain: use Robinhood Chain ${robinhoodChain.id} or its testnet ${robinhoodTestnet.id}. Nothing was signed.`);
  }
  if (!activatableCaps(caps)) {
    throw new Error(
      "These limits cannot be activated: caps takes exactly perTradeUsdg, dailyUsdg, expiryDays, maxDrawdownPct and " +
        "maxOpsPerDay, each a number of at least 1, with perTradeUsdg at most dailyUsdg, maxDrawdownPct at most 100, " +
        "a whole expiryDays of at most 365 and a whole maxOpsPerDay. Nothing was signed.",
    );
  }
  const grant = await prepareAgentGrant(owner, { caps, chainId, onStatus });
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
