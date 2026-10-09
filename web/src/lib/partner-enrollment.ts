/** Owner-signed embedded enrollment. No browser session or Privy identity is invented. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { recoverMessageAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  accountsMatch, carriesOwnerKey, GRANT_ENERGY, GRANT_PONS_CLASS, GRANT_SCOPED_SPENDERS, officialCoinTokens, PONS_CLASS_VAULT_FACTORY,
  STOCK_TOKENS, TRADEABLE_V2, usableExtraTokens, type Derivation, type MerrymenSettings, type StoredGrant,
} from "@merrymen/core";
import { checkCanonicalWall } from "./canonical-wall";
import {
  canonicalJson, partnerEnrollmentMessage, partnerGrantDigest,
  type PartnerEnrollmentClaim, type PartnerEnrollmentSettings,
} from "../../../packages/core/src/partner-enrollment";
import type { GrantStore } from "../../../worker/src/grant-store";
import type { SettingsStore } from "../../../worker/src/settings-store";
import type { IdentityStore } from "../../../worker/src/identity-store";
import { activatedBy, getPartnerStore, PartnerStoreError, type PartnerConnection, type PartnerStore } from "./partner-store";
import { onlyFields, PartnerError, requirePartnerScope, type PartnerPrincipal } from "./partner-bridge";
import { AGENT_NAME_RE, AGENT_NAME_RULE, normalizeAgentName } from "./agent-name-rule";

export const PARTNER_ENROLLMENT_TTL_MS = 5 * 60_000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const KEY = /^0x[0-9a-fA-F]{64}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ZERO = "0x0000000000000000000000000000000000000000";
const CHAINS = new Set([4663, 46630]);
const SYMBOLS = new Set(STOCK_TOKENS.map(t => t.symbol));
const CONSENT_SCOPES = new Set(["read:agents", "chat:agents"]);
/**
 * WHAT A PARTNER'S PAGE MAY SEAL: exactly what the SDK's prepareMerryman mints
 * from owner, caps and chain alone. A partner grant is built by a third party's
 * code, and the owner approves a permission whose addresses they cannot read.
 * The canonical wall only proves the permission matches the grant's OWN declared
 * routes, and the worker trades through whatever adapter the grant sealed
 * (grantV4Adapter/grantPonsAdapter), so an accepted `ponsAdapterAddress` would
 * route this owner's trades through a contract the partner chose. Adapter routes
 * stay a first-party choice: the owner's own dashboard can still seal them.
 *
 * The class vault is the one sealed address the SDK mints by default, from the
 * platform's own factory. It is accepted only from THAT factory, and only as the
 * vault the factory answers for this account (checked on chain at activation):
 * the wall would otherwise pin, and custody deposit into, a "vault" the partner
 * named beside the real factory's address.
 */
const PARTNER_FEATURES = new Set([TRADEABLE_V2, GRANT_ENERGY, GRANT_SCOPED_SPENDERS, GRANT_PONS_CLASS]);
const PARTNER_SEALED_ROUTES = ["v4AdapterAddress", "ponsAdapterAddress"] as const;
const fail = (status: number, code: string, message: string): never => { throw new PartnerError(status, code, message); };

export interface PartnerActivation {
  connection: PartnerConnection;
  smartAccount: Address;
  chainId: number;
  /** True when this answered a retry of an activation that had already completed; nothing was written. */
  replayed: boolean;
}

export interface PartnerEnrollmentDependencies {
  store: PartnerStore;
  grants: Pick<GrantStore, "get" | "put" | "tenantForAccount">;
  settings: Pick<SettingsStore, "get" | "put">;
  identities: Pick<IdentityStore, "ensure">;
  now: () => number;
  secret: () => string;
  derive: (owner: Address, chainId: number) => Promise<Derivation>;
  /** The vault the class factory answers for this account (`vaultFor`), read from the chain. */
  classVault: (factory: Address, smartAccount: Address, chainId: number) => Promise<Address>;
  recover: (args: { message: string; signature: Hex }) => Promise<Address>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return fail(400, "bad_request", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
function asAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !ADDRESS.test(value) || value.toLowerCase() === ZERO) return fail(400, "invalid_grant", `${label} must be a nonzero wallet address`);
  return value.toLowerCase() as Address;
}
function chainId(value: unknown): number {
  if (typeof value !== "number" || !CHAINS.has(value)) return fail(400, "unsupported_chain", "Only Robinhood Chain and its testnet are supported");
  return value;
}
function safeSettings(value: unknown): PartnerEnrollmentSettings {
  const body = object(value, "settings");
  onlyFields(body, ["name", "strategy", "basket_symbols", "live_trading_enabled"]);
  // THE SAME RULE AS EVERY OTHER NAME WRITE. This accepted any 1–24
  // characters, so "007" got a 200 and the soul then refused it: the partner
  // was told one name while the agent ran as Robin. Refused here, out loud.
  const name = typeof body.name === "string" ? normalizeAgentName(body.name) : null;
  if (name === null || !AGENT_NAME_RE.test(name)) return fail(400, "invalid_settings", `Agent name must be ${AGENT_NAME_RULE}`);
  if (body.strategy !== "steady-basket" && body.strategy !== "llm-strategist") return fail(400, "invalid_settings", "Choose steady-basket or llm-strategist");
  if (!Array.isArray(body.basket_symbols) || !body.basket_symbols.length || body.basket_symbols.length > 10 || body.basket_symbols.some(s => typeof s !== "string" || !SYMBOLS.has(s))) {
    return fail(400, "invalid_settings", "basket_symbols must contain 1–10 supported stock symbols");
  }
  if (typeof body.live_trading_enabled !== "boolean") return fail(400, "invalid_settings", "live_trading_enabled must be an explicit boolean");
  return { name, strategy: body.strategy, basket_symbols: [...new Set(body.basket_symbols as string[])], live_trading_enabled: body.live_trading_enabled };
}
function secretDefault(): string {
  const secret = process.env.MERRYMEN_PARTNER_BRIDGE_SECRET ?? "";
  if (Buffer.byteLength(secret) < 32) return fail(503, "upstream_unavailable", "Partner enrollment is not configured");
  return secret;
}
function signToken(claim: PartnerEnrollmentClaim, secret: string): string {
  const encoded = Buffer.from(canonicalJson(claim)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(`partner-enrollment-v1:${encoded}`).digest("base64url")}`;
}
function readToken(raw: unknown, secret: string, now: number): PartnerEnrollmentClaim {
  if (typeof raw !== "string" || raw.length > 8192) return fail(401, "invalid_challenge", "Invalid enrollment challenge");
  const parts = raw.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return fail(401, "invalid_challenge", "Invalid enrollment challenge");
  const expected = createHmac("sha256", secret).update(`partner-enrollment-v1:${parts[0]}`).digest();
  const presented = Buffer.from(parts[1], "base64url");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return fail(401, "invalid_challenge", "Invalid enrollment challenge");
  let claim: PartnerEnrollmentClaim;
  try { claim = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as PartnerEnrollmentClaim; }
  catch { return fail(401, "invalid_challenge", "Invalid enrollment challenge"); }
  if (!claim || claim.v !== 1 || !Number.isSafeInteger(claim.expires_at) || claim.expires_at <= now || claim.expires_at > now + PARTNER_ENROLLMENT_TTL_MS || !/^[a-f0-9]{48}$/.test(claim.nonce)) {
    return fail(401, "challenge_expired", "Enrollment challenge expired; request and sign a fresh challenge");
  }
  return claim;
}
function connectionContext(principal: PartnerPrincipal, connection: PartnerConnection): string[] {
  requirePartnerScope(principal, "write:agents");
  if (connection.partnerId !== principal.app_id) return fail(404, "not_found", "No such agent");
  if (connection.status === "revoked") return fail(409, "connection_revoked", "This agent connection has been revoked");
  const scopes = [...new Set(connection.scopes)].sort();
  if (!scopes.includes("read:agents") || scopes.some(scope => !CONSENT_SCOPES.has(scope))) return fail(400, "invalid_scopes", "Agent consent must include read:agents and optionally chat:agents");
  if (scopes.some(scope => !principal.scopes.includes(scope))) return fail(403, "forbidden_scope", "This key does not carry all of the requested agent scopes");
  return scopes;
}

/** Validate both metadata and the session key actually used by the worker. */
function validGrant(input: unknown, now: number): StoredGrant {
  const body = object(input, "grant");
  if ("demoOwnerPrivateKey" in body || carriesOwnerKey(body)) return fail(422, "owner_key_forbidden", "Owner private keys must stay in the owner's wallet");
  onlyFields(body, ["smartAccount", "owner", "sessionKeyAddress", "serialized", "caps", "grantedAt", "expiresAt", "chainId", "grantFeatures", "grantTokens", "v4AdapterAddress", "ponsAdapterAddress", "ponsClassVaultAddress", "ponsClassVaultFactoryAddress", "binding", "demoSessionPrivateKey"]);
  const owner = asAddress(body.owner, "owner");
  const smartAccount = asAddress(body.smartAccount, "smartAccount");
  const sessionKeyAddress = asAddress(body.sessionKeyAddress, "sessionKeyAddress");
  chainId(body.chainId);
  if (typeof body.demoSessionPrivateKey !== "string" || !KEY.test(body.demoSessionPrivateKey)) return fail(400, "invalid_grant", "The grant needs its session key");
  let derivedSession: Address;
  try { derivedSession = privateKeyToAccount(body.demoSessionPrivateKey as Hex).address.toLowerCase() as Address; }
  catch { return fail(400, "invalid_grant", "The session key is invalid"); }
  if (derivedSession === owner) return fail(422, "owner_key_forbidden", "The session key must be different from the owner key");
  if (derivedSession !== sessionKeyAddress) return fail(400, "invalid_grant", "The session key does not match sessionKeyAddress");
  const caps = object(body.caps, "grant caps");
  onlyFields(caps, ["perTradeUsdg", "dailyUsdg", "expiryDays", "maxDrawdownPct", "maxOpsPerDay"]);
  for (const field of ["perTradeUsdg", "dailyUsdg", "expiryDays", "maxDrawdownPct", "maxOpsPerDay"]) {
    if (typeof caps[field] !== "number" || !Number.isFinite(caps[field]) || Number(caps[field]) < 1) return fail(400, "invalid_grant", `${field} must be at least 1`);
  }
  if (Number(caps.perTradeUsdg) > Number(caps.dailyUsdg) || Number(caps.maxDrawdownPct) > 100 || !Number.isSafeInteger(caps.expiryDays) || Number(caps.expiryDays) > 365 || !Number.isSafeInteger(caps.maxOpsPerDay)) {
    return fail(400, "invalid_grant", "The grant limits are inconsistent or outside supported bounds");
  }
  const seconds = Math.floor(now / 1000);
  if (!Number.isSafeInteger(body.grantedAt) || !Number.isSafeInteger(body.expiresAt) || Number(body.grantedAt) <= 0 || Number(body.grantedAt) > seconds + 60 || Number(body.expiresAt) <= seconds || Number(body.expiresAt) !== Number(body.grantedAt) + Number(caps.expiryDays) * 86_400) {
    return fail(400, "invalid_grant", "The grant expiry must match its signed duration and remain in the future");
  }
  if (typeof body.serialized !== "string" || body.serialized.length < 20 || body.serialized.length > 240_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.serialized)) return fail(400, "invalid_grant", "Invalid serialized permission or permission too large for embedded activation");
  // Before the wall, which would accept these when the permission matches them.
  const unsupported = "Partner enrollment seals only the platform's own routes and listed coins; prepare the grant with prepareMerryman's owner, caps and chainId";
  if (PARTNER_SEALED_ROUTES.some(field => body[field] !== undefined)) return fail(422, "unsupported_permission", unsupported);
  if (body.grantFeatures !== undefined && (!Array.isArray(body.grantFeatures) || body.grantFeatures.some(f => !PARTNER_FEATURES.has(f)))) {
    return fail(422, "unsupported_permission", unsupported);
  }
  if (body.ponsClassVaultAddress !== undefined || body.ponsClassVaultFactoryAddress !== undefined) {
    const platform = PONS_CLASS_VAULT_FACTORY[Number(body.chainId)];
    if (!platform || typeof body.ponsClassVaultFactoryAddress !== "string" || body.ponsClassVaultFactoryAddress.toLowerCase() !== platform.toLowerCase() ||
        typeof body.ponsClassVaultAddress !== "string" || !ADDRESS.test(body.ponsClassVaultAddress)) {
      return fail(422, "unsupported_permission", unsupported);
    }
  }
  if (body.grantTokens !== undefined) {
    const listed = new Set(usableExtraTokens(officialCoinTokens(Number(body.chainId))).map(t => t.address.toLowerCase()));
    if (!Array.isArray(body.grantTokens) || body.grantTokens.some(a => typeof a !== "string" || !listed.has(a.toLowerCase()))) {
      return fail(422, "unsupported_permission", unsupported);
    }
  }
  // The serialized permission and the wall it installs: decoded, checked for
  // owner-key material, and rebuilt from this grant's own caps, times, tokens
  // and sealed addresses, then compared byte for byte. Shared with hosted
  // POST /api/grants so the two doors cannot drift — see canonical-wall.ts.
  const wall = checkCanonicalWall({ ...body, owner, smartAccount });
  if (!wall.ok) return fail(wall.status, wall.code, wall.why);
  // A legacy/Privy binding, if present in the input, is not evidence for this
  // flow. Do not persist unverified DIDs or repurpose their security model.
  const { binding: _binding, ...grant } = body;
  void _binding;
  return { ...grant, owner, smartAccount, sessionKeyAddress } as unknown as StoredGrant;
}

export function createPartnerEnrollmentService(overrides: Partial<PartnerEnrollmentDependencies> = {}) {
  const store = () => overrides.store ?? getPartnerStore();
  const now = overrides.now ?? Date.now;
  const secret = overrides.secret ?? secretDefault;
  const recover = overrides.recover ?? recoverMessageAddress;
  const grants = async () => overrides.grants ?? (await import("../../../worker/src/grant-store")).getGrantStore();
  const settings = async () => overrides.settings ?? (await import("../../../worker/src/settings-store")).getSettingsStore();
  const identities = async () => overrides.identities ?? (await import("../../../worker/src/identity-store")).getIdentityStore();
  const derive = overrides.derive ?? (async (owner, chain) => (await import("./derive-account")).deriveKernelAccountAddress(owner, chain));
  const classVault = overrides.classVault ?? (async (factory: Address, account: Address, chain: number) => {
    const [{ createPublicClient }, { chainForId, resolveClassVault }, { webChainRead }] = await Promise.all([import("viem"), import("@merrymen/core"), import("./chain-read")]);
    return resolveClassVault(createPublicClient({ chain: chainForId(chain), transport: webChainRead() }), factory, account);
  });

  return {
    async challenge(principal: PartnerPrincipal, connection: PartnerConnection, input: unknown) {
      const scopes = connectionContext(principal, connection);
      const body = object(input, "challenge request");
      onlyFields(body, ["owner", "smart_account", "chain_id", "grant_hash", "settings"]);
      if (typeof body.grant_hash !== "string" || !HASH.test(body.grant_hash)) return fail(400, "invalid_grant", "grant_hash must be a keccak256 digest");
      const owner = asAddress(body.owner, "owner");
      if (connection.tenant && connection.tenant !== owner) return fail(409, "connection_already_linked", "This agent belongs to a different owner");
      const claim: PartnerEnrollmentClaim = {
        v: 1, app_id: principal.app_id, app_name: principal.name,
        agent_id: connection.id, external_user_id: connection.externalUserId,
        owner, smart_account: asAddress(body.smart_account, "smart_account"), chain_id: chainId(body.chain_id),
        grant_hash: body.grant_hash.toLowerCase() as Hex, settings: safeSettings(body.settings), scopes,
        nonce: randomBytes(24).toString("hex"), expires_at: now() + PARTNER_ENROLLMENT_TTL_MS,
      };
      return { claim, message: partnerEnrollmentMessage(claim), challenge_token: signToken(claim, secret()) };
    },

    async activate(principal: PartnerPrincipal, connection: PartnerConnection, input: unknown) {
      const scopes = connectionContext(principal, connection);
      const body = object(input, "activation request");
      onlyFields(body, ["grant", "challenge_token", "signature"]);
      const claim = readToken(body.challenge_token, secret(), now());
      if (claim.app_id !== principal.app_id || claim.agent_id !== connection.id || claim.external_user_id !== connection.externalUserId || canonicalJson(claim.scopes) !== canonicalJson(scopes)) {
        return fail(403, "challenge_context_mismatch", "This authorization was signed for a different app, user, agent, or set of scopes");
      }
      if (typeof body.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(body.signature)) return fail(400, "invalid_signature", "An owner wallet signature is required");
      let digest: Hex;
      try { digest = partnerGrantDigest(body.grant); } catch { return fail(400, "invalid_grant", "Grant must contain JSON values only"); }
      if (digest !== claim.grant_hash) return fail(403, "grant_digest_mismatch", "The grant differs from the exact permission the owner authorized");
      const grant = validGrant(body.grant, now());
      if (grant.owner !== claim.owner || grant.smartAccount !== claim.smart_account || grant.chainId !== claim.chain_id) return fail(403, "grant_context_mismatch", "The grant owner, account, or chain differs from this authorization");
      let signer: Address;
      try { signer = await recover({ message: partnerEnrollmentMessage(claim), signature: body.signature as Hex }); }
      catch { return fail(401, "invalid_signature", "The owner signature could not be verified"); }
      if (signer.toLowerCase() !== claim.owner) return fail(403, "wrong_owner", "This authorization was not signed by the grant's owner");
      let derived: Derivation;
      try { derived = await derive(grant.owner, grant.chainId); }
      catch { return fail(503, "derivation_unavailable", "The account derivation could not be verified; retry when the chain is available"); }
      if (!derived.ok) return fail(503, "derivation_unavailable", derived.why);
      if (!accountsMatch(derived, grant.smartAccount).ok) return fail(403, "account_mismatch", "The agent wallet does not derive from this owner");
      // validGrant already pinned the factory to the platform's; this pins the
      // vault to the one that factory gives this account. Before the nonce, so
      // an unreadable chain leaves the signature usable for a retry.
      if (grant.ponsClassVaultAddress) {
        let vault: Address;
        try { vault = await classVault(grant.ponsClassVaultFactoryAddress as Address, grant.smartAccount, grant.chainId); }
        catch { return fail(503, "class_vault_unavailable", "The class vault could not be confirmed on chain; retry when the chain is available"); }
        if (vault.toLowerCase() !== grant.ponsClassVaultAddress.toLowerCase()) return fail(422, "unsupported_permission", "The sealed class vault is not the platform factory's vault for this account");
      }
      // Wait for this owner's enrollment lock BEFORE spending the signature. It
      // was spent first, so a concurrent activation lost it to enrollment_busy
      // and the owner had to sign again; now contention leaves the nonce unused
      // and the same authorization can simply be retried. The lock pins a
      // connection, not a transaction, so the nonce below commits on its own:
      // a later write failure still cannot roll it back and reopen the token.
      return store().withEnrollmentLock(grant.owner, async (): Promise<PartnerActivation> => {
        const proof = { nonce: claim.nonce, grantHash: claim.grant_hash };
        if (!await store().consumeNonce(`enrollment:${claim.nonce}`, Math.ceil(claim.expires_at / 1000))) {
          // The retry of an activation that COMPLETED, its response lost (a
          // timeout, a failed status read): answer with the connection as it is
          // now. Only this exact signed grant matches the recorded proof, and
          // nothing is applied again: no grant, settings or live trading.
          const current = await store().byId(principal.app_id, connection.id);
          if (current?.status === "linked" && current.tenant === grant.owner && activatedBy(current, proof) &&
              canonicalJson(connectionContext(principal, current)) === canonicalJson(claim.scopes)) {
            return { connection: current, smartAccount: grant.smartAccount, chainId: grant.chainId, replayed: true };
          }
          return fail(409, "challenge_used", "This enrollment authorization has already been used");
        }
        const current = await store().byId(principal.app_id, connection.id);
        if (!current) return fail(404, "not_found", "No such agent");
        const currentScopes = connectionContext(principal, current);
        if (current.externalUserId !== claim.external_user_id || canonicalJson(currentScopes) !== canonicalJson(claim.scopes) || (current.tenant && current.tenant !== grant.owner)) return fail(409, "connection_changed", "The agent connection changed; request a fresh authorization");
        const occupied = await store().byTenant(principal.app_id, grant.owner);
        if (occupied && occupied.id !== current.id) return fail(409, "wallet_already_linked", "This wallet is already linked to another user of this app");
        const grantStore = await grants();
        const holder = await grantStore.tenantForAccount(grant.smartAccount);
        if (holder && holder.toLowerCase() !== grant.owner) return fail(409, "account_already_claimed", "This account already belongs to a different Merrymen login");
        const ownGrant = await grantStore.get(grant.owner);
        if (ownGrant && ownGrant.owner.toLowerCase() !== grant.owner) return fail(409, "owner_model_mismatch", "This login already has an agent owned by a different wallet; use that owner's recovery and setup flow");
        const settingsStore = await settings();
        const previous = await settingsStore.get(grant.owner) ?? {};
        const safe: MerrymenSettings = {
          ...previous, agentName: claim.settings.name, strategy: claim.settings.strategy,
          basketSymbols: claim.settings.basket_symbols, paperTradingEnabled: true, liveTradingEnabled: false,
        };
        let bound: PartnerConnection;
        try {
          // Keep the old permission in paper mode until the replacement has
          // been durably installed and the partner's consent has been bound.
          await settingsStore.put(grant.owner, safe);
          await (await identities()).ensure(grant.owner, grant.smartAccount);
          await grantStore.put(grant.owner, grant);
          bound = await store().bindAuthorized(current.id, principal.app_id, grant.owner, claim.scopes);
          if (claim.settings.live_trading_enabled) await settingsStore.put(grant.owner, { ...safe, liveTradingEnabled: true });
        } catch (error) {
          if (error instanceof PartnerError || (error && typeof error === "object" && "status" in error && "code" in error)) throw error;
          return fail(503, "enrollment_storage_failed", "Enrollment could not be fully saved. Request a fresh challenge and retry; inspect agent status before continuing");
        }
        // Last: only an activation that finished every step may later be
        // answered as a lost response instead of challenge_used. Every effect
        // is durable by now, so failing to record that proof is no failure of
        // the activation: answering it enrollment_storage_failed told the
        // partner a completed one (live trading perhaps on) had failed. The
        // only loss is the old answer, challenge_used, to a lost-response retry.
        try {
          const recorded = await store().recordActivation(bound.id, principal.app_id, grant.owner, proof);
          return { connection: recorded, smartAccount: grant.smartAccount, chainId: grant.chainId, replayed: false };
        } catch (error) {
          // Revoked or re-owned meanwhile: that is an answer, not a storage failure.
          if (error instanceof PartnerStoreError) throw error;
          console.error("[partner-enrollment] activation completed; its retry proof was not recorded", error instanceof Error ? error.name : "unknown");
          return { connection: bound, smartAccount: grant.smartAccount, chainId: grant.chainId, replayed: false };
        }
      });
    },
  };
}
