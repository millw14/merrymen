/** Grant shapes shared by web (issuer) and worker (consumer). */

import {
  CASH,
  LEGACY_TRADEABLE_SYMBOLS,
  STOCK_TOKENS,
  TRADEABLE_SYMBOLS,
  type CustomToken,
} from "./tokens";

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
 * grantFeatures marker meaning "this signature can swap NATIVE ETH → an
 * allowlisted asset" (the auto-convert flow: exactInputSingle with WETH as
 * tokenIn and msg.value attached).
 *
 * The wall carries this only since nativeSwapValueLimitWei existed — every key
 * signed before it has valueLimit 0n on the router rule, so a convert from one
 * reverts at the wall. The worker and /grant check for this marker rather than
 * attempting the op and reading the failure.
 */
export const GRANT_NATIVE_SWAP = "native-swap";

/** Can this signature actually run the native-ETH auto-convert swap? */
export function grantHasNativeSwap(
  grant: Pick<StoredGrant, "grantFeatures"> | null | undefined,
): boolean {
  return grant?.grantFeatures?.includes(GRANT_NATIVE_SWAP) ?? false;
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
export function bindingMessage(args: {
  origin: string;
  nonce: string;
  owner: `0x${string}`;
  smartAccount: `0x${string}`;
  chainId: number;
}): string {
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
    /** The nonce both signatures were made over. Server-issued, single-use. */
    nonce: string;
    /** personal_sign by the signed-in wallet — must recover to the tenant. */
    walletSignature: `0x${string}`;
    /** personal_sign by the generated owner key — must recover to `owner`. */
    ownerSignature: `0x${string}`;
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
    (sellable.has(t.address.toLowerCase()) ? covered : uncovered).push(t);
  }
  return { covered, uncovered };
}

/**
 * Registry symbols the owner has selected that this grant cannot sell.
 *
 * The settings UI offers every symbol in the registry, but only the ones baked
 * into the signature can be approved for a sell — and approving USDG is generic,
 * so the buy side works regardless. That asymmetry is what let someone pick AAPL
 * and end up holding it forever. Reported, and refused at the wall.
 */
export function uncoveredBasketSymbols(
  basketSymbols: readonly string[],
  grant: Pick<StoredGrant, "grantFeatures" | "grantTokens"> | null | undefined,
): string[] {
  const sellable = sellableAssets(grant ?? null);
  return STOCK_TOKENS.filter(
    (t) => basketSymbols.includes(t.symbol) && !sellable.has(t.address.toLowerCase()),
  ).map((t) => t.symbol);
}
