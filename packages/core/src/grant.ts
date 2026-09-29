/** Grant shapes shared by web (issuer) and worker (consumer). */

import {
  CASH,
  LEGACY_TRADEABLE_SYMBOLS,
  STOCK_TOKENS,
  TRADEABLE_SYMBOLS,
  type CustomToken,
} from "./tokens";
// energy.ts imports only a TYPE from this file, so this is no runtime cycle.
import { isEnergyReserveToken } from "./energy";
// perps.ts imports nothing at all (its grant reader takes a structural type for
// exactly this reason), so neither is this.
import { GRANT_PERP_LIGHTER, validatePerpPubKey, type PerpGrant } from "./perps";

/**
 * grantFeatures marker meaning "this signature carries the WIDE tradable set".
 *
 * TRADEABLE_SYMBOLS grows as pools are seeded, but a session key signed last
 * month has last month's list sealed into its call policy. Reading the current
 * constant and assuming an old grant covers it is exactly the bug that let a
 * position be bought and never sold — so the grant declares what it carries,
 * and code that needs to know asks the grant, not the constant.
 */
export const TRADEABLE_V2 = "tradeable-v2";

/**
 * grantFeatures marker meaning "this signature can reach Uniswap v4".
 *
 * v4 needs two call-policy permissions v3 never did — Permit2's approve, scoped
 * to the UniversalRouter, and the router's execute. A key signed before those
 * existed has neither, so a v4 swap from it reverts at the wall. The worker
 * checks for this rather than attempting the trade and reading the failure.
 */
export const GRANT_V4 = "v4";

/** Can this signature actually execute a Uniswap v4 swap? */
export function grantHasV4(grant: Pick<StoredGrant, "grantFeatures"> | null | undefined): boolean {
  return grant?.grantFeatures?.includes(GRANT_V4) ?? false;
}

/**
 * grantFeatures marker meaning "this signature can execute a MULTI-HOP swap".
 *
 * A route through WETH is not the same call as a direct one: the router takes
 * `exactInput(bytes path, …)` rather than `exactInputSingle(…)`, and the wall
 * grants exactly one selector on that target. So a via-WETH route quoted fine,
 * logged "simulated ✓ v3 via WETH", was submitted, and reverted on-chain —
 * burning gas every tick with an opaque reason, and invisible in paper mode
 * because paper never builds calldata.
 *
 * Same rule the v4 marker exists for: quoting a route the key cannot reach is
 * worse than never having considered it. Until a grant carries this, the router
 * is asked for single-hop quotes only.
 */
export const GRANT_MULTIHOP = "multihop";

/** Can this signature actually execute a multi-hop (e.g. via-WETH) swap? */
export function grantHasMultihop(grant: Pick<StoredGrant, "grantFeatures"> | null | undefined): boolean {
  return grant?.grantFeatures?.includes(GRANT_MULTIHOP) ?? false;
}

/**
 * grantFeatures marker meaning "this signature can call the V4SelfSwap
 * adapter" — the contract that makes Uniswap v4 constrainable by the wall.
 *
 * DISTINCT FROM GRANT_V4, deliberately. GRANT_V4 means the OLD route: Permit2
 * plus the UniversalRouter, whose `execute(bytes, bytes[])` hides the swap
 * recipient in opaque bytes the policy cannot constrain — which is why neither
 * signer has ever minted it. This marker means the adapter route: one declared
 * selector whose recipient is `msg.sender` in bytecode. The two permission
 * sets are disjoint, so conflating the markers would tell the worker a route
 * exists that the signature does not carry.
 */
export const GRANT_V4_ADAPTER = "v4-adapter";

/**
 * The adapter address this signature can actually call, or null.
 *
 * BOTH the marker and a valid address are required — the GRANT_TRANSFER
 * lesson, applied before the wound this time: a marker alone is a claim, not
 * evidence, and a claim the wall does not back means the worker builds a
 * UserOp the account contract refuses. The address is per-deploy (testnet and
 * mainnet adapters differ), sealed into the signature at signing time; the
 * worker must call THIS address, never whatever settings says at tick time.
 */
export function grantV4Adapter(
  grant: Pick<StoredGrant, "grantFeatures" | "v4AdapterAddress"> | null | undefined,
): `0x${string}` | null {
  if (!grant?.grantFeatures?.includes(GRANT_V4_ADAPTER)) return null;
  const a = grant.v4AdapterAddress;
  if (typeof a !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a)) return null;
  return a.toLowerCase() as `0x${string}`;
}

/**
 * grantFeatures marker meaning "this signature can call the PonsSelfTrade
 * adapter" — the contract that makes a bonding curve constrainable by the wall.
 *
 * DISTINCT FROM GRANT_V4_ADAPTER, and the distinction is the point. The two
 * adapters reach different venues, carry different risks, and are granted by
 * separate opt-ins; one marker covering both would tell the worker a route
 * exists that the signature does not carry. It would also make the owner's
 * only choice all-or-nothing.
 *
 * What this marker does NOT mean, so nobody reads more into it than is there:
 * it does not mean native-quoted curves are reachable — they are 53.6% of the
 * launchpad and the adapter is non-payable, so they are not — and it does not
 * mean the wall vouches for the curve, which it structurally cannot.
 */
export const GRANT_PONS_ADAPTER = "pons-adapter";

/**
 * The Pons adapter address this signature can actually call, or null.
 *
 * BOTH the marker and a valid address are required, for the same reason
 * grantV4Adapter demands both: a marker alone is a claim, not evidence, and a
 * claim the wall does not back means the worker builds a UserOp the account
 * contract refuses — gas spent to be told no, with a revert reason that
 * explains nothing. The address is per-deploy and sealed into the signature at
 * signing time; the worker must call THIS address, never whatever settings says
 * at tick time.
 */
export function grantPonsAdapter(
  grant: Pick<StoredGrant, "grantFeatures" | "ponsAdapterAddress"> | null | undefined,
): `0x${string}` | null {
  if (!grant?.grantFeatures?.includes(GRANT_PONS_ADAPTER)) return null;
  const a = grant.ponsAdapterAddress;
  if (typeof a !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a)) return null;
  return a.toLowerCase() as `0x${string}`;
}

/**
 * The CLASS permission: this signature can trade Pons tokens it never named.
 *
 * DISTINCT FROM GRANT_PONS_ADAPTER, and the distinction carries the whole
 * security difference. `pons-adapter` lets the agent trade the curve tokens the
 * owner ENUMERATED at signing time. This one lets it trade tokens that did not
 * exist when the grant was signed — which is what a sniper needs and what no
 * enumerated list can express. An owner may hold the first without the second,
 * and the separate marker is what makes that choice available.
 *
 * WHAT THE OWNER IS ACTUALLY OPTING INTO, said plainly because a marker name
 * cannot say it: an agent that may convert up to the per-trade USDG cap,
 * repeatedly until expiry, into ANY token reachable through a curve — one
 * nobody enumerated or reviewed. What still bounds it: the funding leg stays
 * the enumerated quote asset, the amount stays under the capped USDG approve,
 * and the vault can pay nobody but the account. What does NOT bound it: the
 * chain cannot check the curve's provenance (a curve self-reports its factory
 * and the Pons factory publishes no registry), so for the class case the CHAIN
 * IS LOOSER THAN THE OFF-CHAIN MIRROR and `knownCurves` is the only provenance
 * gate. That inversion is the price of the capability.
 */
export const GRANT_PONS_CLASS = "pons-class";

/**
 * The per-account class vault this signature can call, or null.
 *
 * BOTH the marker and a valid address are required, for exactly the reason
 * grantPonsAdapter demands both: a marker alone is a claim, not evidence.
 *
 * WHY AN ADDRESS AT ALL, when the vault is derivable from the owner: because
 * the wall pins it as a literal `target`, and the worker must call THE ADDRESS
 * THE SIGNATURE SEALED rather than one it re-derives at tick time. A derivation
 * that drifted — a different factory, a changed init code — would send the
 * agent's money to a contract the wall never authorised, and the failure would
 * look like a revert with no explanation. Sealing it makes the two agree by
 * construction.
 */
export function grantPonsClassVault(
  grant: Pick<StoredGrant, "grantFeatures" | "ponsClassVaultAddress"> | null | undefined,
): `0x${string}` | null {
  if (!grant?.grantFeatures?.includes(GRANT_PONS_CLASS)) return null;
  const a = grant.ponsClassVaultAddress;
  if (typeof a !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a)) return null;
  return a.toLowerCase() as `0x${string}`;
}

/**
 * The FACTORY this signature's `deploy` permission was sealed against, or null.
 *
 * SAME MARKER as the vault, deliberately, and not a second one. `wall.ts` emits
 * all three class permissions from one branch, so a separate marker would allow
 * a grant that claims a class route, can buy through a vault, and has no way to
 * CREATE the vault it buys through — "a marker alone is a claim" wearing a new
 * costume. One decision, one marker, three permissions.
 *
 * The address is sealed for the same reason the vault's is: the worker must call
 * the factory the SIGNATURE covers, not one it re-derives or reads from settings.
 * A settings-sourced factory would let a settings write redirect where a vault
 * gets created — and since the vault address is a CREATE2 function OF the
 * factory, that silently moves the account's custody somewhere the wall never
 * pinned.
 */
export function grantPonsClassVaultFactory(
  grant: Pick<StoredGrant, "grantFeatures" | "ponsClassVaultFactoryAddress"> | null | undefined,
): `0x${string}` | null {
  if (!grant?.grantFeatures?.includes(GRANT_PONS_CLASS)) return null;
  const a = grant.ponsClassVaultFactoryAddress;
  if (typeof a !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a)) return null;
  return a.toLowerCase() as `0x${string}`;
}

export const GRANT_TRANSFER = "transfer";

/**
 * Does this signature carry an on-chain USDG transfer permission?
 *
 * READ, NEVER WRITTEN — and that asymmetry is the whole point.
 * buildCallPermissions emits a transfer permission ONLY for withdrawal
 * addresses registered at signing time, and neither signer registers any. So
 * no grant minted today carries this marker, and none should: a grant that
 * claims it while the wall omits the permission is a mirror LOOSER than the
 * chain, which is the one direction that is never safe. The worker believes
 * it can send, builds the UserOp, and the account contract refuses it — gas
 * spent to be told no, with a revert reason that explains nothing.
 *
 * It is still honoured for grants signed BEFORE the withdrawal allowlist
 * landed, whose transfer permission had a free-form recipient. Absent means
 * absent; it does not mean legacy.
 */
/**
 * When the withdrawal allowlist landed (e950ea5, 2026-08-02) and the wall's
 * USDG transfer permission became conditional on registering a recipient.
 *
 * THE MARKER ALONE IS NOT EVIDENCE, and that is why this constant exists. From
 * that commit until 2026-08-26 both signers kept writing "transfer" into
 * grantFeatures while passing no withdrawal addresses — so every grant minted
 * in that 24-day window carries the marker AND has zero on-chain transfer
 * permission. With a 14-day default expiry, that window is essentially the
 * whole population of currently-armed grants, while the genuinely pre-allowlist
 * ones the marker was meant to protect are mostly expired.
 *
 * Reading the marker on its own would leave exactly those grants with a mirror
 * LOOSER than the chain: the worker offers the transfer, builds the UserOp, and
 * the account contract refuses it — gas spent to be told no.
 */
export const WITHDRAWAL_ALLOWLIST_LANDED_AT = 1_785_630_924;

export function grantHasTransfer(
  grant: Pick<StoredGrant, "grantFeatures" | "grantedAt"> | null | undefined,
): boolean {
  if (!grant?.grantFeatures?.includes(GRANT_TRANSFER)) return false;
  // Signed before the allowlist existed: the permission really is there, with a
  // free-form recipient. Tightening these would make the mirror STRICTER than
  // the chain and break a working wallet.
  return (grant.grantedAt ?? 0) < WITHDRAWAL_ALLOWLIST_LANDED_AT;
}

export interface GrantCaps {
  perTradeUsdg: number;
  dailyUsdg: number;
  expiryDays: number;
  maxDrawdownPct: number;
  maxOpsPerDay: number;
}

/**
 * The message both signatures are made over when a tenant claims an account.
 *
 * SHARED ON PURPOSE. The browser signs this text and the server reconstructs it
 * to recover the signatures; if the two ever built it differently every claim
 * would fail with nothing obviously wrong. One definition, imported by both —
 * the same reason the wall itself lives in this package.
 *
 * DELIBERATELY NOT CONFUSABLE WITH THE LOGIN CHALLENGE (`challengeMessage` in
 * web/src/lib/auth.ts). Both are plain `personal_sign` over the same key, so if
 * the texts could be mistaken for one another a signature captured for one
 * purpose could be replayed as the other. The opening line names a different
 * action in different words, and every bound value appears literally — EIP-191
 * has no domain separator to carry them.
 *
 * Each field earns its place:
 *   origin  — a claim signed for one deployment cannot be replayed at another
 *   nonce   — server-issued, expiring, single-use; stops replay of this claim
 *   owner   — the key being vouched for
 *   account — the smart account claimed, i.e. which ledger partition is at stake
 *   chainId — merrymen runs testnet 46630 and mainnet 4663; without it one
 *             signature would bind on both
 */
/**
 * WHICH SECURITY MODEL A BINDING WAS MADE UNDER. Never inferred.
 *
 * Both versions prove the same two things — that the person is who they say
 * they are, and that they hold the key the account derives from — but they
 * prove them with different evidence, and the evidence is not interchangeable:
 *
 *   legacy-wallet-owner-v1  the login wallet signs (authentication) and a
 *                           SEPARATE browser-held owner key co-signs the same
 *                           text (owner authority). Two keys, two signatures.
 *
 *   privy-did-owner-v1      a verified Privy access token carries the DID
 *                           (authentication) and the embedded owner wallet
 *                           signs the challenge (owner authority). One key may
 *                           serve as both the identity anchor and the owner —
 *                           the proofs are still separate, because one of them
 *                           is a JWT the server verified and the other is a
 *                           signature over a server-issued nonce.
 *
 * They are versioned rather than merged because a validator that accepted both
 * shapes would have to decide, per request, which evidence it was looking at —
 * and the wrong guess in either direction is a downgrade. A binding whose
 * version this deployment does not recognise is refused, not best-guessed.
 */
export type BindingVersion = "legacy-wallet-owner-v1" | "privy-did-owner-v1";

/**
 * What an absent `version` means, and why that is a fact rather than a guess.
 *
 * Every grant signed before this field existed was made under the two-signature
 * browser-owner model, because that was the only model there was. So absent
 * resolves to legacy by CONSTRUCTION, not by falling through a default — and it
 * resolves to the STRICTER of the two, which needs two independent signatures.
 * An unrecognised version string is a refusal.
 */
export const DEFAULT_BINDING_VERSION: BindingVersion = "legacy-wallet-owner-v1";

export function isBindingVersion(v: unknown): v is BindingVersion {
  return v === "legacy-wallet-owner-v1" || v === "privy-did-owner-v1";
}

/** What a claim binds, by version. `did` exists on exactly the arm that needs it. */
export type BindingClaim =
  | {
      version?: "legacy-wallet-owner-v1";
      origin: string;
      nonce: string;
      owner: `0x${string}`;
      smartAccount: `0x${string}`;
      chainId: number;
    }
  | {
      version: "privy-did-owner-v1";
      origin: string;
      nonce: string;
      owner: `0x${string}`;
      smartAccount: `0x${string}`;
      chainId: number;
      /** The Privy DID the access token was verified to carry. */
      did: string;
    };

export function bindingMessage(args: BindingClaim): string {
  if (args.version === "privy-did-owner-v1") {
    // THE DID IS IN THE SIGNED TEXT. Without it the owner signature would say
    // "this key authorizes account X" and name no identity at all — it would
    // verify just as well when replayed under somebody else's login. Under the
    // legacy version the second signature carries that job; here the text does.
    return [
      `${args.origin} wants you to authorize a merrymen agent account.`,
      "",
      "You are linking the agent wallet below to your merrymen identity. It moves no funds.",
      "",
      `Agent account: ${args.smartAccount.toLowerCase()}`,
      `Owner key: ${args.owner.toLowerCase()}`,
      `Identity: ${args.did}`,
      `Chain ID: ${args.chainId}`,
      `URI: ${args.origin}`,
      `Nonce: ${args.nonce}`,
    ].join("\n");
  }
  // THE LEGACY TEXT IS FROZEN, BYTE FOR BYTE. Grants signed by a browser that
  // has not reloaded are still in flight, and a signature is over the exact
  // bytes — change a space here and every one of them stops verifying.
  return [
    `${args.origin} wants you to authorize a merrymen agent account.`,
    "",
    "You are linking the agent wallet below to this login. It moves no funds.",
    "",
    `Agent account: ${args.smartAccount.toLowerCase()}`,
    `Owner key: ${args.owner.toLowerCase()}`,
    `Chain ID: ${args.chainId}`,
    `URI: ${args.origin}`,
    `Nonce: ${args.nonce}`,
  ].join("\n");
}

export interface StoredGrant {
  smartAccount: `0x${string}`;
  owner: `0x${string}`;
  sessionKeyAddress: `0x${string}`;
  /** ZeroDev serialized permission account — everything the worker needs to act. */
  serialized: string;
  caps: GrantCaps;
  grantedAt: number;
  expiresAt: number;
  chainId: number;
  /**
   * Capabilities baked into this grant's on-chain call policy beyond the
   * original set (e.g. "transfer"). Lets the worker tell a pre-transfer grant
   * apart from a new one instead of letting the UserOp revert at the wall.
   */
  grantFeatures?: string[];
  /**
   * Owner-added token addresses (lowercase) whose approve() this grant's
   * on-chain call policy actually covers, beyond the built-in tradable set.
   *
   * Recorded so the worker can tell "you added CATE in settings" apart from
   * "the signed key is allowed to sell CATE" — those are different facts, and
   * only the second one is true without a re-sign. Without this the mismatch
   * would only surface as a UserOp reverting at the wall, long after the owner
   * thought they'd enabled it.
   */
  grantTokens?: string[];
  /**
   * The V4SelfSwap adapter this signature's `swapExactIn` permission was
   * sealed against, lowercased. Per-deploy and per-chain, so it lives on the
   * grant rather than in a registry constant — see grantV4Adapter, which is
   * the only reader and requires the GRANT_V4_ADAPTER marker alongside it.
   */
  v4AdapterAddress?: string;
  /**
   * The PonsSelfTrade adapter this signature's `tradeExactIn` permission was
   * sealed against, lowercased. Per-deploy and per-chain like its v4 sibling,
   * so it lives on the grant rather than in a registry constant — see
   * grantPonsAdapter, which is the only reader and requires the
   * GRANT_PONS_ADAPTER marker alongside it.
   */
  ponsAdapterAddress?: string;
  /**
   * The PonsClassVault this signature's class `buy`/`sell` permissions were
   * sealed against, lowercased. PER ACCOUNT, not per deploy — unlike its two
   * adapter siblings, every account has its own vault, so this address is
   * unique to this grant.
   *
   * It is knowable before the vault exists (CREATE2, owner as salt), which is
   * the only reason a class permission can be written at all: the wall has to
   * name the target at signing time, and at signing time the vault has usually
   * not been deployed. See grantPonsClassVault, its only reader, which requires
   * the GRANT_PONS_CLASS marker alongside it.
   */
  ponsClassVaultAddress?: string;
  /**
   * The PonsClassVaultFactory this signature's `deploy` permission was sealed
   * against, lowercased.
   *
   * A DEPLOY CONSTANT, unlike the vault above — the same address for every
   * account on a chain. Sealed anyway, because the vault address is a CREATE2
   * function OF this one: a factory read from settings could silently relocate
   * where the account's custody gets created, to somewhere the wall never
   * pinned. See grantPonsClassVaultFactory.
   */
  ponsClassVaultFactoryAddress?: string;
  /** Explicit autonomous pool-token custody permission, sealed at signing. */
  trencherVaultAddress?: string;
  trencherFactoryAddress?: string;
  /**
   * The Lighter API key this signature's `changePubKey` permission was sealed
   * against — `{ route, apiKeyIndex, apiPublicKey, apiKeySealed? }`, read only
   * through `grantPerp` (perps.ts), which requires the GRANT_PERP_LIGHTER
   * marker, chain 4663, the route's key index and a canonical key alongside it.
   *
   * THE PUBLIC KEY, AND AT MOST A SEALED BLOB OF THE PRIVATE ONE. There is no
   * field in this type a plaintext private key fits in, and that is the
   * design, not an omission: signers only ever see the public key (keygen
   * returns it), self-hosted keeps the private key in its own 0600 file beside
   * the home, and hosted carries it only as `apiKeySealed` — AES-256-GCM under
   * a key the child never holds, bound to tenant|smartAccount|pubkey|keyIndex.
   * An API key can hand every dollar at the venue to a counterparty and the
   * wall cannot bound it (docs/perps.md rule 4), so it is custody exactly as
   * the session key is.
   *
   * AND EVEN THE SEALED BLOB NEVER LEAVES IN A RESPONSE. `publicGrantView`
   * below is how a grant becomes JSON for anybody, and it copies
   * `route`, `apiKeyIndex` and `apiPublicKey` — never `apiKeySealed`.
   */
  perp?: PerpGrant;
  /**
   * HOSTED ONLY — the two signatures that bind this account to a tenant.
   *
   * The account's owner key is generated in the browser, so `owner` can never
   * equal the signed-in wallet and the server cannot authorize on it directly.
   * Instead the browser proves the pairing with two signatures over ONE
   * server-issued nonce:
   *
   *   wallet — the signed-in wallet authorizes this (owner, smartAccount) pair.
   *            Proves INTENT: this tenant meant to claim this account.
   *   owner  — the generated owner key signs the same message, locally.
   *            Proves POSSESSION: whoever claimed it actually holds the key.
   *
   * BOTH are required, and the second is the load-bearing one. With only the
   * wallet signature the server's checks reduce to functions of PUBLIC
   * addresses — anyone could authorize someone else's pair and squat their
   * ledger partition, which keys on smart_account. The co-signature is what
   * makes the claim unforgeable. See verifyGrantBinding in web/src/lib/auth.ts.
   *
   * Both are `personal_sign` (EIP-191), deliberately: it carries no domain and
   * no chainId, so it needs no network switch and works in wallets that cannot
   * reach this chain at all — Phantom among them, which supports Robinhood
   * Chain for assets but refuses dApp connections on it.
   *
   * Absent on self-hosted grants, where localhost is the perimeter and there is
   * no tenant to bind to.
   */
  binding?: {
    /**
     * Which security model this claim was made under. ABSENT MEANS LEGACY, and
     * that is a statement about history rather than a default: the field did
     * not exist when those grants were signed, and the only model that existed
     * then was the two-signature one. See DEFAULT_BINDING_VERSION.
     */
    version?: BindingVersion;
    /** The nonce the signature(s) were made over. Server-issued, single-use. */
    nonce: string;
    /**
     * personal_sign by the signed-in wallet — must recover to the tenant.
     * LEGACY ONLY. Under `privy-did-owner-v1` authentication is the verified
     * access token, so there is no second signature and this is absent.
     */
    walletSignature?: `0x${string}`;
    /** personal_sign by the owner key — must recover to `owner`. Both versions. */
    ownerSignature: `0x${string}`;
    /**
     * The Privy DID this account is being bound to, echoed so the server can
     * reconstruct the signed text. NEVER TRUSTED AS AN IDENTITY — the server
     * compares it to the DID it verified out of the access token and refuses on
     * any difference. `privy-did-owner-v1` only.
     */
    did?: string;
  };
  /** TESTNET ONLY — production signers live in a TEE, never serialized. */
  demoSessionPrivateKey: `0x${string}`;
  /**
   * TESTNET ONLY — the generated owner key that controls the account. When the
   * wallet is created in-browser (no external wallet connected) this is the ONLY
   * way to recover funds, so the UI forces the user to back it up before
   * funding. Absent when an external wallet (MetaMask) was the owner.
   */
  demoOwnerPrivateKey?: `0x${string}`;
}

/**
 * What of a grant may be shown to anybody — a browser tab, the iOS app, a
 * partner, a log line. Addresses, caps, times, markers and PUBLIC keys; no
 * secret of any kind, sealed or not.
 */
export interface PublicGrantView {
  smartAccount?: `0x${string}`;
  owner?: `0x${string}`;
  sessionKeyAddress?: `0x${string}`;
  caps?: GrantCaps;
  grantedAt?: number;
  expiresAt?: number;
  chainId?: number;
  grantFeatures?: string[];
  grantTokens?: string[];
  v4AdapterAddress?: string;
  ponsAdapterAddress?: string;
  ponsClassVaultAddress?: string;
  ponsClassVaultFactoryAddress?: string;
  trencherVaultAddress?: string;
  trencherFactoryAddress?: string;
  /** The security model only. The nonce, the DID and both signatures stay home. */
  binding?: { version?: BindingVersion };
  /** The key's PUBLIC half and where it sits. Never `apiKeySealed`. */
  perp?: { route: typeof GRANT_PERP_LIGHTER; apiKeyIndex: number; apiPublicKey: `0x${string}` };
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** A feature marker's shape: a short word. A 64- or 80-hex run is not one. */
const MARKER_RE = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;
const CAP_FIELDS = ["perTradeUsdg", "dailyUsdg", "expiryDays", "maxDrawdownPct", "maxOpsPerDay"] as const;
const SEALED_ADDRESS_FIELDS = [
  "v4AdapterAddress",
  "ponsAdapterAddress",
  "ponsClassVaultAddress",
  "ponsClassVaultFactoryAddress",
  "trencherVaultAddress",
  "trencherFactoryAddress",
] as const;

/**
 * THE ONLY WAY A GRANT BECOMES A RESPONSE. Built from an ALLOWLIST.
 *
 * GET /api/grants used to strip secrets with a DENYLIST of top-level keys —
 * `serialized`, `demoSessionPrivateKey`, `demoOwnerPrivateKey` — and spread
 * everything else out. That is safe exactly until somebody adds a field, and
 * perps add one: a nested `perp` block whose sealed private key would have
 * gone to every browser tab and into the iOS app's on-disk URL cache, past a
 * type (`Omit<StoredGrant, …top-level keys>`) that cannot see inside it. A
 * denylist fails OPEN on the next field; an allowlist fails closed — a field
 * nobody listed here is simply not shown, and the worst outcome is a screen
 * missing a value.
 *
 * So every field below is named, and COPIED BY TYPE AND SHAPE rather than by
 * reference: addresses must look like addresses, times and chain ids must be
 * finite numbers, markers must be short words, caps are rebuilt field by field,
 * the binding keeps only its version, and the perp block keeps only its route,
 * index and canonical PUBLIC key. A value of the wrong shape is dropped rather
 * than passed through, because a wrong-shaped value in a known field is how a
 * key ends up somewhere it should not (a session private key written into
 * `sessionKeyAddress` by a buggy signer is 64 hex, not 40, and does not get
 * out). The one secret this cannot catch by shape is an API PRIVATE key
 * written into `apiPublicKey` — both halves are 80 hex — which is why the
 * signers never see the private half at all (docs/perps.md rule 5).
 *
 * Untyped input on purpose: grants arrive from JSON files, Postgres and
 * device storage, and the allowlist must hold on whatever is actually there.
 */
export function publicGrantView(grant: unknown): PublicGrantView {
  const g = (typeof grant === "object" && grant !== null ? grant : {}) as Record<string, unknown>;
  const out: PublicGrantView = {};
  const address = (v: unknown): `0x${string}` | undefined =>
    typeof v === "string" && ADDRESS_RE.test(v) ? (v as `0x${string}`) : undefined;
  const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

  const smartAccount = address(g.smartAccount);
  if (smartAccount) out.smartAccount = smartAccount;
  const owner = address(g.owner);
  if (owner) out.owner = owner;
  const sessionKeyAddress = address(g.sessionKeyAddress);
  if (sessionKeyAddress) out.sessionKeyAddress = sessionKeyAddress;

  if (typeof g.caps === "object" && g.caps !== null) {
    const src = g.caps as Record<string, unknown>;
    const caps: Partial<GrantCaps> = {};
    for (const k of CAP_FIELDS) {
      const v = finite(src[k]);
      if (v !== undefined) caps[k] = v;
    }
    out.caps = caps as GrantCaps;
  }

  const grantedAt = finite(g.grantedAt);
  if (grantedAt !== undefined) out.grantedAt = grantedAt;
  const expiresAt = finite(g.expiresAt);
  if (expiresAt !== undefined) out.expiresAt = expiresAt;
  const chainId = finite(g.chainId);
  if (chainId !== undefined) out.chainId = chainId;

  if (Array.isArray(g.grantFeatures)) {
    out.grantFeatures = g.grantFeatures.filter((f): f is string => typeof f === "string" && MARKER_RE.test(f));
  }
  if (Array.isArray(g.grantTokens)) {
    out.grantTokens = g.grantTokens.filter((a): a is string => typeof a === "string" && ADDRESS_RE.test(a));
  }
  for (const k of SEALED_ADDRESS_FIELDS) {
    const a = address(g[k]);
    if (a) out[k] = a;
  }

  // THE BINDING'S VERSION AND NOTHING ELSE. The nonce and the Privy DID are
  // not secrets, but they are not needed by any screen either, and the two
  // signatures are proof material; an allowlist does not ship what nobody asked
  // for. An unrecognised version is dropped rather than echoed.
  if (typeof g.binding === "object" && g.binding !== null) {
    const v = (g.binding as Record<string, unknown>).version;
    out.binding = isBindingVersion(v) ? { version: v } : {};
  }

  // The PUBLIC half of the venue key, so a phone can carry it forward on a
  // re-sign without ever holding the private one. `apiKeySealed` is never read.
  if (typeof g.perp === "object" && g.perp !== null) {
    const p = g.perp as Record<string, unknown>;
    const apiPublicKey = typeof p.apiPublicKey === "string" ? validatePerpPubKey(p.apiPublicKey) : null;
    if (p.route === GRANT_PERP_LIGHTER && typeof p.apiKeyIndex === "number" && Number.isInteger(p.apiKeyIndex) && apiPublicKey) {
      out.perp = { route: GRANT_PERP_LIGHTER, apiKeyIndex: p.apiKeyIndex, apiPublicKey };
    }
  }
  return out;
}

/**
 * Addresses every grant can already approve without being asked to: USDG plus
 * the built-in tradable stock tokens. An owner-added entry that lands here needs
 * no extra permission and is never reported as uncovered.
 *
 * Shared deliberately. web/src/lib/session.ts skips these when baking extra
 * permissions into the call policy, and the worker skips them when deciding what
 * to warn about — if those two lists drifted, the warning would be wrong in one
 * direction or the other.
 */
export function builtinGrantTargets(grant?: Pick<StoredGrant, "grantFeatures"> | null): Set<string> {
  // No grant supplied = "what would a grant signed RIGHT NOW carry" — the
  // issuer's question. With a grant, the answer is whatever THAT signature
  // sealed, which for anything older than 2026-07-27 is the legacy three.
  const symbols =
    grant === undefined || grant?.grantFeatures?.includes(TRADEABLE_V2)
      ? (TRADEABLE_SYMBOLS as readonly string[])
      : (LEGACY_TRADEABLE_SYMBOLS as readonly string[]);
  return new Set<string>([
    (CASH.USDG as string).toLowerCase(),
    ...STOCK_TOKENS.filter((t) => symbols.includes(t.symbol)).map((t) => t.address.toLowerCase()),
  ]);
}

/**
 * Every token address this signature can approve for a SELL: the built-in set
 * it carries, plus any owner-added extras baked in at signing time.
 *
 * This is the set the worker checks a BUY against. Entering a position the key
 * cannot exit is the one outcome no cap protects you from.
 */
export function sellableAssets(grant: Pick<StoredGrant, "grantFeatures" | "grantTokens"> | null): Set<string> {
  const set = builtinGrantTargets(grant);
  for (const a of grant?.grantTokens ?? []) set.add(a.toLowerCase());
  return set;
}

/**
 * Which of the owner's configured tokens this signature actually lets the agent
 * sell. `grantTokens` absent means the grant predates the field entirely — and a
 * grant signed before extras existed genuinely has no extra approve permission
 * in its call policy, so "unknown" and "none" are the same fact here.
 *
 * THE ENERGY RESERVE IS IN NEITHER LIST. $MERRYMEN is energy, not a token the
 * agent trades: every signer drops it from the sealed extras
 * (wall.ts usableExtraTokens), so no signature will ever "cover" it and the
 * worker never watches it. Reported as uncovered it would tell an owner who
 * listed it to "re-sign to cover MERRYMEN" — a signature that changes nothing,
 * asked for again after every one. It is bought only by the agent's
 * get-energy route, and nothing here is advice about it.
 */
export function tokenCoverage(
  configured: readonly CustomToken[],
  grant: Pick<StoredGrant, "grantTokens" | "grantFeatures"> | null | undefined,
): { covered: CustomToken[]; uncovered: CustomToken[] } {
  // Pass the grant through, not `undefined` — asking what THIS signature covers,
  // not what a fresh one would.
  const sellable = sellableAssets(grant ?? null);
  const covered: CustomToken[] = [];
  const uncovered: CustomToken[] = [];
  for (const t of configured) {
    if (isEnergyReserveToken(t.address)) continue;
    (sellable.has(t.address.toLowerCase()) ? covered : uncovered).push(t);
  }
  return { covered, uncovered };
}

/**
 * Basket symbols the owner has selected that this grant cannot sell.
 *
 * Only the tokens baked into the signature can be approved for a sell —
 * approving USDG is generic, so the buy side works regardless. That asymmetry is
 * what let someone pick AAPL and end up holding it forever. Reported, and
 * refused at the wall by the `no-exit` rule.
 *
 * IT LOOKED ONLY AT THE REGISTRY, which made the warning structurally incapable
 * of firing for the case that needs it most. The settings screen has offered
 * CUSTOM symbols as basket entries since `route.ts` widened its validator, and a
 * custom token found no match in `STOCK_TOKENS` and simply fell out of the
 * filter — so the red "update your trading permissions to buy or sell X" banner
 * never appeared for a memecoin, which is exactly the token an owner is most
 * likely to have added after signing.
 *
 * `customTokens` DEFAULTS TO EMPTY on purpose. The two existing callers —
 * `Wallet.tsx` and the worker's coverage note — already union in
 * `tokenCoverage()` themselves, and passing custom tokens here as well would
 * report every one of them twice. Only the Settings screen, which had no such
 * compensation, passes them.
 */
export function uncoveredBasketSymbols(
  basketSymbols: readonly string[],
  grant: Pick<StoredGrant, "grantFeatures" | "grantTokens"> | null | undefined,
  customTokens: readonly { symbol: string; address: string }[] = [],
): string[] {
  const sellable = sellableAssets(grant ?? null);
  const known = [
    ...STOCK_TOKENS.map((t) => ({ symbol: t.symbol, address: t.address })),
    ...customTokens,
  ];
  return known
    .filter(
      (t) =>
        basketSymbols.includes(t.symbol) &&
        !sellable.has(t.address.toLowerCase()) &&
        // Energy, never a leg: no signature covers it, so "re-sign" would be
        // false advice (see tokenCoverage). The worker never watches it either.
        !isEnergyReserveToken(t.address),
    )
    .map((t) => t.symbol);
}
