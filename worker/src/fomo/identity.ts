/**
 * TOKEN AND CHAIN IDENTITY for social-trading research.
 *
 * The rest of the worker assumes one chain (Robinhood Chain, 4663) and keys a
 * token by its lowercased address. That is fine for what the worker can
 * trade, and wrong for what a social-trading feed reports: the same feed
 * carries Solana mints, Arc and Hyperliquid rows, and EVM addresses from
 * networks it does not always number. So identity here is explicit:
 *
 *   (namespace, network id AS RETURNED, address)
 *
 * THREE RULES THAT ARE EASY TO BREAK BY ACCIDENT
 *
 *   1. A symbol is never identity. Two coins called PEPE are two coins.
 *   2. The same 0x hex on two EVM networks is two tokens. Nothing here merges
 *      them, and a row whose network is unknown keeps `networkId: null`
 *      rather than being assumed to be the chain we asked for.
 *   3. Solana mints are base58 and CASE-SENSITIVE. Lowercasing one makes a
 *      different (usually nonexistent) mint. Only EVM addresses are lowercased.
 *
 * WHY THIS DOES NOT CALL packages/core chainForId: that helper maps every id
 * other than the testnet to Robinhood mainnet, which is right for the
 * product's own chain selection and catastrophic for a Solana row. Nothing
 * from the provider is allowed near it; `isRobinhoodToken` is the only door
 * from research identity toward anything executable, and it demands the
 * network id the provider actually returned.
 */

import type { ChainIdentity, ChainNamespace, ExecutionAvailability, TokenIdentity } from "./types";

/** Robinhood Chain mainnet: Merrymen's only executable network, and the provider's "robinhood". */
export const ROBINHOOD_NETWORK_ID = 4663;
/** The provider's slug for it, used for chain-scoped queries. */
export const ROBINHOOD_SLUG = "robinhood";

/**
 * Network ids the provider DOCUMENTS (fetched 2026-10-04). Only these slugs map
 * to a number. Other EVM slugs the provider names (base, bsc, eth, monad,
 * polygon, arbitrum) have no documented id in its namespace, so they resolve
 * with `networkId: null` unless a row carries the number itself.
 */
const DOCUMENTED: ReadonlyArray<{ slugs: readonly string[]; namespace: ChainNamespace; networkId: number; slug: string }> = [
  { slugs: ["robinhood", "hood", "rh"], namespace: "eip155", networkId: ROBINHOOD_NETWORK_ID, slug: "robinhood" },
  { slugs: ["solana", "sol"], namespace: "solana", networkId: 1_399_811_149, slug: "solana" },
  { slugs: ["arc"], namespace: "eip155", networkId: 5042, slug: "arc" },
  { slugs: ["hyperliquid", "hl"], namespace: "hyperliquid", networkId: 1337, slug: "hyperliquid" },
];

/** EVM networks the provider names without a documented id in its own namespace. */
const EVM_SLUGS_UNNUMBERED: ReadonlyMap<string, string> = new Map([
  ["base", "base"],
  ["bsc", "bsc"],
  ["bnb", "bsc"],
  ["eth", "eth"],
  ["ethereum", "eth"],
  ["monad", "monad"],
  ["polygon", "polygon"],
  ["arbitrum", "arbitrum"],
]);

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Base58 alphabet (no 0, O, I, l), 32–44 characters: the shape of a Solana mint. */
const SOLANA_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SLUG_SHAPE = /^[a-z][a-z0-9-]{0,23}$/;

function cleanSlug(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  return SLUG_SHAPE.test(s) ? s : null;
}

function cleanNetworkId(raw: unknown): number | null {
  // The provider sends numbers; a numeric string from a looser route is accepted.
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d{1,12}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * A chain identity from whatever a provider row carried: a numeric id, a slug,
 * both or neither. When the two DISAGREE the row is not trusted for either:
 * the namespace becomes `unknown` and the id is dropped, so it can never be
 * treated as executable.
 */
export function chainFromProvider(networkId: unknown, slug: unknown): ChainIdentity {
  const id = cleanNetworkId(networkId);
  const s = cleanSlug(slug);
  const bySlug = s ? DOCUMENTED.find((d) => d.slugs.includes(s)) : undefined;
  const byId = id !== null ? DOCUMENTED.find((d) => d.networkId === id) : undefined;
  if (bySlug && id !== null && bySlug.networkId !== id) {
    return { namespace: "unknown", networkId: null, slug: s };
  }
  if (byId && s && !byId.slugs.includes(s) && (bySlug || EVM_SLUGS_UNNUMBERED.has(s))) {
    return { namespace: "unknown", networkId: null, slug: s };
  }
  if (bySlug) return { namespace: bySlug.namespace, networkId: bySlug.networkId, slug: bySlug.slug };
  if (byId) return { namespace: byId.namespace, networkId: byId.networkId, slug: byId.slug };
  if (s && EVM_SLUGS_UNNUMBERED.has(s)) {
    // A numbered row on a named EVM network: keep the number the row carried.
    return { namespace: "eip155", networkId: id, slug: EVM_SLUGS_UNNUMBERED.get(s)! };
  }
  // An id we do not know and no recognisable slug. Keep the id (it is what the
  // provider said) but not a namespace we would have to guess.
  return { namespace: "unknown", networkId: id, slug: s };
}

/** A user-typed chain ("rh", "Robinhood", "sol", "base") → identity, or null when it is not a chain word. */
export function chainFromUserText(raw: string): ChainIdentity | null {
  const s = cleanSlug(raw.replace(/\s+chain$/i, ""));
  if (!s) return null;
  const d = DOCUMENTED.find((x) => x.slugs.includes(s));
  if (d) return { namespace: d.namespace, networkId: d.networkId, slug: d.slug };
  if (EVM_SLUGS_UNNUMBERED.has(s)) return { namespace: "eip155", networkId: null, slug: EVM_SLUGS_UNNUMBERED.get(s)! };
  return null;
}

export function robinhoodChain(): ChainIdentity {
  return { namespace: "eip155", networkId: ROBINHOOD_NETWORK_ID, slug: ROBINHOOD_SLUG };
}

export function keyOf(chain: ChainIdentity, address: string): string {
  return `${chain.namespace}:${chain.networkId ?? "?"}:${address}`;
}

/**
 * A token identity, or null when the address does not fit the chain.
 *
 * An EVM-shaped address on an `unknown` chain is kept as `eip155` with a null
 * network: we know it is an EVM contract, not which network, and the null
 * stops it from ever being treated as executable.
 */
export function tokenIdentity(chain: ChainIdentity, rawAddress: unknown): TokenIdentity | null {
  if (typeof rawAddress !== "string") return null;
  const address = rawAddress.trim();
  if (!address) return null;
  if (EVM_ADDRESS.test(address)) {
    if (chain.namespace === "solana" || chain.namespace === "hyperliquid") return null;
    const c: ChainIdentity = chain.namespace === "eip155" ? chain : { namespace: "eip155", networkId: null, slug: chain.slug };
    const a = address.toLowerCase();
    return { chain: c, address: a, key: keyOf(c, a) };
  }
  if (SOLANA_MINT.test(address)) {
    if (chain.namespace !== "solana") {
      // A base58 string on a chain that is not Solana (or an unknown one) cannot
      // be placed. Treated as unresolved rather than guessed onto Solana.
      if (chain.namespace !== "unknown") return null;
      const c: ChainIdentity = { namespace: "solana", networkId: null, slug: chain.slug };
      return { chain: c, address, key: keyOf(c, address) };
    }
    return { chain, address, key: keyOf(chain, address) };
  }
  return null;
}

/** Parse a stored key back. Null for anything that is not a key this module wrote. */
export function tokenFromKey(key: string): TokenIdentity | null {
  const m = /^(eip155|solana|hyperliquid|unknown):(\d+|\?):(.+)$/.exec(key);
  if (!m) return null;
  const namespace = m[1] as ChainNamespace;
  const networkId = m[2] === "?" ? null : Number(m[2]);
  const documented = networkId !== null ? DOCUMENTED.find((d) => d.networkId === networkId) : undefined;
  const chain: ChainIdentity = { namespace, networkId, slug: documented?.slug ?? null };
  const t = tokenIdentity(chain, m[3]);
  return t && t.key === key ? t : null;
}

/** True only for a token the provider placed on Robinhood Chain mainnet by NUMBER. */
export function isRobinhoodToken(t: TokenIdentity | null | undefined): t is TokenIdentity & { address: `0x${string}` } {
  return !!t && t.chain.namespace === "eip155" && t.chain.networkId === ROBINHOOD_NETWORK_ID && EVM_ADDRESS.test(t.address);
}

/**
 * Whether Merrymen could act on this token, separately from whether it can
 * research it (always). The caller supplies the two facts it alone knows:
 * whether a supported route was verified on chain, and whether the owner's
 * signed permission covers it. Unknown route is not a supported route.
 */
export function executionAvailabilityOf(
  t: TokenIdentity | null | undefined,
  facts: { routeVerified: boolean | null; permitted: boolean },
): ExecutionAvailability {
  if (!t || t.chain.namespace === "unknown" || t.chain.networkId === null) return "unresolved-identity";
  if (!isRobinhoodToken(t)) return "unsupported-chain";
  if (facts.routeVerified !== true) return "unsupported-venue";
  if (!facts.permitted) return "supported-permission-missing";
  return "supported-authorized";
}

/**
 * Did a chain-filtered request actually come back filtered?
 *
 * The provider accepting `?chain=robinhood` proves nothing; only the network
 * ids on the returned rows do. `honoured` is null when no row carried a
 * network at all (nothing to check), false when ANY row is on another
 * network or carries none while others do.
 */
export function verifyChainFilter(
  requested: ChainIdentity | null,
  rows: ReadonlyArray<TokenIdentity | null>,
): { honoured: boolean | null; offending: number; unplaced: number } {
  if (!requested || requested.networkId === null) return { honoured: null, offending: 0, unplaced: 0 };
  let offending = 0;
  let unplaced = 0;
  let placed = 0;
  for (const r of rows) {
    if (!r || r.chain.networkId === null) {
      unplaced++;
      continue;
    }
    placed++;
    if (r.chain.networkId !== requested.networkId || r.chain.namespace !== requested.namespace) offending++;
  }
  if (placed === 0) return { honoured: null, offending, unplaced };
  return { honoured: offending === 0 && unplaced === 0, offending, unplaced };
}

/** Short display form, never used for identity: `0x1234…abcd` / `So1a…xyz9`. */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export const IDENTITY_GUARDS = { EVM_ADDRESS, SOLANA_MINT, DOCUMENTED } as const;
