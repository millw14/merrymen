/**
 * PERPETUALS ON LIGHTER (ROBINHOOD CHAIN) — THE PURE HALF.
 *
 * docs/perps.md is the contract; this file is the part of it every tier shares:
 * the frozen venue route, the market table, the API-key shape the wall seals,
 * the integer arithmetic every risk check is made of, and the words and report
 * shapes the owner reads. Nothing here talks to the network or holds a key.
 *
 * WHY THE ARITHMETIC LIVES HERE AND NOT IN THE WORKER. The same numbers are
 * computed in four places — policy (may this open go out?), the paper engine
 * (what would the venue have done?), protect.ts (how close is liquidation?) and
 * the dashboard (what does the owner see?). Four copies of "notional" is how a
 * cap judged on one rounding and a display shown on another come to disagree
 * by a tick, and the disagreement always lands on the side that lets something
 * through. So each quantity is computed once, in bigint, and each function
 * NAMES its rounding direction. The rule for choosing it: a risk check rounds
 * toward the answer that refuses sooner — exposure and margin up, a
 * liquidation price toward the entry, a stop never farther than the owner set,
 * gains down and costs up.
 *
 * UNITS, ONCE. Money is bigint micro-USDG (6 dp). A price is the venue's integer
 * price (`mark × 10^priceDecimals`); a size is the venue's integer base amount
 * (`size × 10^sizeDecimals`). Every live perp on the instance has
 * sizeDecimals + priceDecimals = 6 (orderBookDetails?filter=perp, 2026-09-29),
 * which makes base × price exactly micro-USDG — but nothing below relies on
 * that, because a market listed tomorrow need not keep it.
 */

// ── the route ───────────────────────────────────────────────────────────────

/**
 * grantFeatures marker: "this signature may post USDG margin to Lighter over
 * LIGHTER_ROUTE_V1, register exactly the sealed API key at the route's key
 * index, and claim payouts back to itself".
 *
 * VERSIONED for the reason GRANT_ENERGY is: the wall's four permissions are
 * built from the route below, not from values sealed on the grant. A marker
 * names a route FOREVER. If any literal below has to change, that is
 * "perp-lighter-v2", and grants signed against v1 keep meaning v1 — editing v1
 * in place would leave old walls and new calldata describing different venues.
 */
export const GRANT_PERP_LIGHTER = "perp-lighter-v1";

/**
 * The venue, FROZEN LITERALS (lowercase). Each value, and the probe that
 * established it (2026-09-29, recorded in docs/perps.md's venue table):
 *
 *   chainId 4663     Robinhood Chain mainnet. /api/v1/layer1BasicInfo on this
 *                    instance names L1 = 4663. There is NO Lighter on testnet
 *                    46630 (the testnet API's contract has no code there), so
 *                    perps are paper-only off mainnet.
 *   proxy            ZkLighter proxy: GET api.rh.lighter.xyz/info returns it,
 *                    docs.robinhood.com/chain/lighter-domains names it, and
 *                    eth_getCode on 4663 returns the 1367-byte proxy. Its user
 *                    functions (deposit, changePubKey, withdraw…) are
 *                    delegated to AdditionalZkLighter; selectors were checked
 *                    against the deployed bytecode (abis.ts).
 *   apiBase / wsUrl  Lighter's ROBINHOOD instance — its own rollup, sequencer
 *                    and liquidity. Not zkLighter on Ethereum; nothing here
 *                    ever talks to that one.
 *   l2ChainId 466324 The signing chain id (apidocs.rh.lighter.xyz get-started).
 *                    The official signer defaults to 304; with a frozen clock it
 *                    reproduced the tx_hash of 14/14 live mainnet txs under
 *                    466324 and none under 304.
 *   usdg             Lighter asset 3's l1_address (/api/v1/assetDetails) and
 *                    tokenToAssetIndex(USDG) = 3 on the proxy; equal to
 *                    CASH.USDG in tokens.ts (perps.test.ts pins it).
 *   assetIndex 3     tokenToAssetIndex(USDG) eth_call; the quote/collateral
 *                    asset, not converted to USDC on this instance.
 *   routePerps 0     RH deposit docs (0 perps, 1 spot) and a decoded live
 *                    ERC-4337 deposit, `deposit(self, 3, 0, 82973191)`, that
 *                    created account 22149 (tx 0x28144cb2…).
 *   usdgTickSize 1   assetConfigs(3).tickSize. A claim pays baseAmount ×
 *                    tickSize, so payout recognition multiplies by this.
 *   minDepositMicro  assetConfigs(3).minDepositTicks = 1_000_000 at tick 1: one
 *                    USDG. A smaller deposit reverts.
 *   apiKeyIndex 16   A fixed index outside the set Robinhood's instance
 *                    reserves for its own apps ({0,1,2,3,157},
 *                    apidocs.rh.lighter.xyz api-keys), at most the signer's
 *                    MaxApiKeyIndex 254, and never 255 (NilApiKeyIndex — in
 *                    the Go signer 255 selects "the last client created").
 *                    Which in-range value is immaterial; that it never changes
 *                    is not, because the wall pins it EQUAL in changePubKey.
 *   topics           topic0 of the proxy's Deposit and WithdrawPending events
 *                    (lighter-contracts IEvents.sol; WithdrawPending seen in
 *                    the relayer's claim receipt 0x0f82c519…). The classifier's
 *                    venue-margin arm and payout recognition match on these;
 *                    perps.test.ts recomputes both with viem.
 */
export const LIGHTER_ROUTE_V1 = Object.freeze({
  chainId: 4663,
  proxy: "0x94bab9693ba2f6358507effcbd372b0660afff9d" as `0x${string}`,
  apiBase: "https://api.rh.lighter.xyz",
  wsUrl: "wss://api.rh.lighter.xyz/stream",
  l2ChainId: 466324,
  usdg: "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as `0x${string}`,
  assetIndex: 3,
  routePerps: 0,
  usdgTickSize: 1,
  minDepositMicro: 1_000_000n,
  apiKeyIndex: 16,
  reservedKeyIndexes: Object.freeze([0, 1, 2, 3, 157] as const),
  topics: Object.freeze({
    /** keccak256("Deposit(uint48,address,uint16,uint8,uint128)") — nothing indexed. */
    deposit: "0x493c3b8240368e8343bcd42cac5f4b8b161c06d061710e542a72f06a40ddd9d1" as `0x${string}`,
    /** keccak256("WithdrawPending(address,uint16,uint128)") — `owner` is indexed (topic1). */
    withdrawPending: "0xef80235b5f4cf1822ad6a8621af41ac64372ff672c402874f507fc63dbe5e06f" as `0x${string}`,
  }),
});

export type LighterRoute = typeof LIGHTER_ROUTE_V1;

// A literal edit that lands the key index in the reserved set, or on 255,
// would register the agent's key on top of the owner's own Robinhood Wallet
// session — or, through the signer, on whichever client was created last. A
// test catches that too; this makes the module refuse to load at all, so no
// build carrying the mistake can mint a wall.
{
  const k = LIGHTER_ROUTE_V1.apiKeyIndex;
  if (!Number.isInteger(k) || k < 0 || k > 254 || (LIGHTER_ROUTE_V1.reservedKeyIndexes as readonly number[]).includes(k)) {
    throw new Error(`LIGHTER_ROUTE_V1.apiKeyIndex ${k} is reserved or out of range`);
  }
}

// ── markets ─────────────────────────────────────────────────────────────────

/**
 * What kind of thing a perp tracks. Descriptive: it groups markets for the
 * owner and names what "BTC-PERP" is. Venue limits (decimals, minimums, margin
 * fractions) are READ LIVE per market and never inferred from the class.
 */
export type PerpMarketClass = "crypto" | "equity" | "etf" | "metal" | "pre-ipo" | "meme";

/**
 * A perp market's key. ALWAYS suffixed: many Lighter perp symbols (TSLA, AAPL,
 * SPY, PONS…) equal Robinhood stock-token or spot symbols, and every spot map in
 * the worker — lastPrices, holdings, positions, cost_basis — is keyed by bare
 * symbol. A perp mark leaking into those under "TSLA" would re-value a spot
 * holding and move the high-water mark on a number that is not its price.
 */
export type PerpKey = `${string}-PERP`;

export interface PerpMarket {
  readonly key: PerpKey;
  /** Lighter market_id — what orders are signed against. */
  readonly marketId: number;
  /** The venue's own symbol, as orderBookDetails spells it. */
  readonly symbol: string;
  readonly cls: PerpMarketClass;
}

function market(marketId: number, symbol: string, cls: PerpMarketClass): PerpMarket {
  return Object.freeze({ key: `${symbol}-PERP` as PerpKey, marketId, symbol, cls });
}

/**
 * Every perp on the instance at ship time: orderBookDetails?filter=perp on
 * 2026-09-29 returned exactly these 57 (ids 0–56, all `status: active`). Spot
 * books (27 of them, ids ≥ 2048) are absent on purpose — this route never
 * touches spot, and lighter-go warns that the id split is no longer a
 * guarantee, so perp-ness is this table's membership, never an id range.
 *
 * FROZEN AT SHIP TIME, like the route: an owner's `perpsMarkets` names keys in
 * this table, and a market Lighter lists later is not tradable until a release
 * adds it here — a new listing never widens what an agent may trade on its own.
 *
 * Classes that needed a judgement, with the evidence:
 *   LIT, VVV           crypto — Lighter's and Venice's own tokens (Lighter's
 *                      frontend: CRYPTO/DEFI), though in the 2000 margin tier.
 *   CASHCAT, ANSEM, AI meme — tagged MEMES by Lighter's frontend ("Cash Cat",
 *                      "The Black Bull", "Artificial Inu"); 3333 tier (3x).
 *   PONS               meme — the Pons launchpad's token. Lighter tags it only
 *                      CRYPTO/NEW; it is classed with the memecoins because it
 *                      trades like one and sits in their 3333 (3x) tier.
 *   ANTHROPIC, OPENAI  pre-ipo — tagged PRE_IPO by Lighter.
 *   SHEIN              pre-ipo — Lighter tags it STOCK, but the company has no
 *                      public listing, and it sits in the pre-IPO names' 2000
 *                      tier rather than the listed stocks' 500–1000.
 *   SPCX               equity — NOT the SpaceX pre-IPO market: Lighter lists
 *                      that separately as SPACEX (tagged PRE_IPO, not on this
 *                      instance); SPCX is tagged STOCK and sits in the 500 tier
 *                      with the listed large caps.
 *   SKHY               equity — "SK Hynix ADR".
 *   SPY, QQQ, SOXL, SGOV, SLV, USO   etf — SLV and USO are funds holding silver
 *                      and oil, so they are ETFs here, not metal.
 *   XAU, XAG           metal.
 */
export const LIGHTER_MARKETS_V1: readonly PerpMarket[] = Object.freeze([
  market(0, "ETH", "crypto"),
  market(1, "BTC", "crypto"),
  market(2, "HYPE", "crypto"),
  market(3, "SOL", "crypto"),
  market(4, "ZEC", "crypto"),
  market(5, "LIT", "crypto"),
  market(6, "XRP", "crypto"),
  market(7, "NEAR", "crypto"),
  market(8, "VVV", "crypto"),
  market(9, "SUI", "crypto"),
  market(10, "AAPL", "equity"),
  market(11, "AMZN", "equity"),
  market(12, "GOOGL", "equity"),
  market(13, "META", "equity"),
  market(14, "MSFT", "equity"),
  market(15, "NVDA", "equity"),
  market(16, "TSLA", "equity"),
  market(17, "ORCL", "equity"),
  market(18, "SPCX", "equity"),
  market(19, "BABA", "equity"),
  market(20, "BE", "equity"),
  market(21, "USAR", "equity"),
  market(22, "USO", "etf"),
  market(23, "COIN", "equity"),
  market(24, "CRCL", "equity"),
  market(25, "QQQ", "etf"),
  market(26, "SPY", "etf"),
  market(27, "SGOV", "etf"),
  market(28, "SLV", "etf"),
  market(29, "AMD", "equity"),
  market(30, "INTC", "equity"),
  market(31, "MU", "equity"),
  market(32, "SNDK", "equity"),
  market(33, "CRWV", "equity"),
  market(34, "PLTR", "equity"),
  market(35, "SOXL", "etf"),
  market(36, "CASHCAT", "meme"),
  market(37, "SKHY", "equity"),
  market(38, "ANTHROPIC", "pre-ipo"),
  market(39, "ANSEM", "meme"),
  market(40, "XAU", "metal"),
  market(41, "XAG", "metal"),
  market(42, "OPENAI", "pre-ipo"),
  market(43, "SHEIN", "pre-ipo"),
  market(44, "PONS", "meme"),
  market(45, "AI", "meme"),
  market(46, "TSM", "equity"),
  market(47, "ASTS", "equity"),
  market(48, "CLSK", "equity"),
  market(49, "IREN", "equity"),
  market(50, "LUNR", "equity"),
  market(51, "QBTS", "equity"),
  market(52, "RGTI", "equity"),
  market(53, "SMCI", "equity"),
  market(54, "SOFI", "equity"),
  market(55, "WULF", "equity"),
  market(56, "AMC", "equity"),
]);

const MARKET_BY_KEY: ReadonlyMap<string, PerpMarket> = new Map(LIGHTER_MARKETS_V1.map((m) => [m.key, m]));
const MARKET_BY_ID: ReadonlyMap<number, PerpMarket> = new Map(LIGHTER_MARKETS_V1.map((m) => [m.marketId, m]));

/** The market for a key, or null. Exact match — "btc-perp" and "BTC" are not keys. */
export function perpMarketByKey(key: string): PerpMarket | null {
  return MARKET_BY_KEY.get(key) ?? null;
}

/** The market for a venue market_id, or null — including every spot id. */
export function perpMarketById(id: number): PerpMarket | null {
  return MARKET_BY_ID.get(id) ?? null;
}

/**
 * True only for a key IN LIGHTER_MARKETS_V1, not for anything shaped like one.
 * Settings refuse an unknown key rather than ignoring it, and a guard that
 * passed "FOO-PERP" would let the refusal be skipped by spelling.
 */
export function isPerpKey(s: unknown): s is PerpKey {
  return typeof s === "string" && MARKET_BY_KEY.has(s);
}

/** The deterministic `perp-trend` producer's whole universe (docs/perps.md, the perps route). */
export const PERP_TREND_UNIVERSE = ["BTC-PERP", "ETH-PERP", "SOL-PERP"] as const;

// ── the API key the wall seals ──────────────────────────────────────────────

/**
 * The perp block a grant carries. PUBLIC KEY ONLY on every path a signer or
 * a GET can see; `apiKeySealed` is the hosted AES-GCM blob of the private key
 * (AAD = tenant|smartAccount|pubkey|keyIndex), opaque to everything but the
 * orchestrator. There is deliberately no field a plaintext private key fits in.
 */
export interface PerpGrant {
  route: typeof GRANT_PERP_LIGHTER;
  apiKeyIndex: number;
  apiPublicKey: `0x${string}`;
  apiKeySealed?: string;
}

/**
 * The perp block this grant may trade with, or null.
 *
 * ALL of: the marker, chain 4663, a perp block naming the same route, the
 * route's key index, and a canonical public key. Any one missing is "perps not
 * granted" — never a partial grant. The chain term is for the reason
 * grantEnergyRoute has it: on any other chain the proxy is codeless, a CALL to
 * it succeeds with empty returndata, and a deposit would "land" having posted
 * nothing.
 *
 * STRUCTURAL parameter on purpose: grant.ts takes PerpGrant from this file
 * (for StoredGrant.perp), so importing StoredGrant here would be a cycle.
 */
export function grantPerp(
  grant: { grantFeatures?: readonly string[]; chainId: number; perp?: unknown } | null | undefined,
): PerpGrant | null {
  if (!grant?.grantFeatures?.includes(GRANT_PERP_LIGHTER)) return null;
  if (grant.chainId !== LIGHTER_ROUTE_V1.chainId) return null;
  const perp = grant.perp;
  if (typeof perp !== "object" || perp === null) return null;
  const p = perp as Record<string, unknown>;
  if (p.route !== GRANT_PERP_LIGHTER) return null;
  if (p.apiKeyIndex !== LIGHTER_ROUTE_V1.apiKeyIndex) return null;
  if (typeof p.apiPublicKey !== "string") return null;
  const apiPublicKey = validatePerpPubKey(p.apiPublicKey);
  if (apiPublicKey === null) return null;
  // A present-but-malformed sealed blob is a corrupted grant, not an absent
  // one: refusing it keeps a bad write from reading as "self-hosted, no blob".
  if (p.apiKeySealed !== undefined && (typeof p.apiKeySealed !== "string" || p.apiKeySealed === "")) return null;
  const out: PerpGrant = { route: GRANT_PERP_LIGHTER, apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey };
  if (typeof p.apiKeySealed === "string") out.apiKeySealed = p.apiKeySealed;
  return out;
}

/** The Goldilocks prime, 2^64 − 2^32 + 1 — the field Lighter's Schnorr keys live in. */
export const GOLDILOCKS_P = 2n ** 64n - 2n ** 32n + 1n;

/**
 * A Lighter API public key, canonicalised to `0x` + 80 lowercase hex, or null.
 *
 * 40 bytes = five 8-byte LITTLE-ENDIAN limbs, each a Goldilocks field element
 * (< p), not all zero. That is what lighter-contracts' changePubKey checks and
 * what the signer's GenerateAPIKey produces (the spike found every limb of
 * every generated key canonical). Checking it here, before the key is sealed
 * into a wall, matters because the wall pins the exact bytes: a key the
 * contract would reject is a grant whose registration can never land, found
 * out only after the owner has signed.
 */
export function validatePerpPubKey(hex: string): `0x${string}` | null {
  if (typeof hex !== "string") return null;
  const bare = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{80}$/.test(bare)) return null;
  const lower = bare.toLowerCase();
  let allZero = true;
  for (let limb = 0; limb < 5; limb++) {
    // Little-endian: byte 0 of the limb is its least significant byte.
    let v = 0n;
    for (let b = 7; b >= 0; b--) {
      const i = (limb * 8 + b) * 2;
      v = (v << 8n) | BigInt(parseInt(lower.slice(i, i + 2), 16));
    }
    if (v >= GOLDILOCKS_P) return null;
    if (v !== 0n) allZero = false;
  }
  if (allZero) return null;
  return `0x${lower}`;
}

/**
 * The two calldata words of `changePubKey(uint48, uint8, bytes)` that carry the
 * key, for the two places that must agree on them: the wall (EQUAL w4, EQUAL
 * w5) and the worker's final fence.
 *
 *   w0 accountIndex · w1 keyIndex · w2 offset of pubKey (0x60) ·
 *   w3 pubKey.length (40) · w4 pk[0:32] · w5 pk[32:40] ++ 24 zero bytes
 *
 * w5 is RIGHT-padded because ABI `bytes` pads its tail with zeros after the
 * data; a left-padded w5 would pin a word the encoder never produces and the
 * permission would silently match nothing. perps.test.ts proves both words
 * against viem's encoder. Throws on a non-canonical key: a word pair for a key
 * the contract would reject is never the right answer.
 */
export function pubKeyWords(pk: string): readonly [`0x${string}`, `0x${string}`] {
  const canonical = validatePerpPubKey(pk);
  if (canonical === null) throw new RangeError("pubKeyWords: not a canonical Lighter API public key");
  const bare = canonical.slice(2);
  const w4 = `0x${bare.slice(0, 64)}` as `0x${string}`;
  const w5 = `0x${bare.slice(64, 80)}${"0".repeat(48)}` as `0x${string}`;
  return Object.freeze([w4, w5] as const);
}

// ── nonces and client order indexes ─────────────────────────────────────────

/** Legs of one signed venue tx; the low three bits of its client order index. */
export const PERP_LEG = Object.freeze({ entry: 0, sl: 1, tp: 2, close: 3 } as const);
export type PerpLeg = (typeof PERP_LEG)[keyof typeof PERP_LEG];

/** The venue's ceiling for a client order index (lighter-go: 1..2^48−1; 2^48 was rejected in the spike). */
export const PERP_COI_MAX = 2n ** 48n - 1n;

/**
 * Client order index for one leg of the tx signed at `nonce`: nonce × 8 + leg.
 *
 * Derived from the nonce, not counted, because the venue does not make a COI
 * unique (live, one account reused COI 2 for eight different orders in one
 * market) and our ledger can be wiped. Nonces only ever rise — the signer's
 * SkipNonce rule and our high-water both require it — so COIs derived from
 * them never repeat across restarts, epochs or a lost store. Throws rather
 * than wrapping: a COI past 2^48 would be rejected by the venue, and a
 * truncated one would collide with an old order.
 */
export function perpCoi(nonce: bigint, leg: PerpLeg): bigint {
  if (typeof nonce !== "bigint" || nonce <= 0n) throw new RangeError("perpCoi: nonce must be a positive bigint");
  if (leg !== 0 && leg !== 1 && leg !== 2 && leg !== 3) throw new RangeError("perpCoi: leg must be 0..3");
  const coi = nonce * 8n + BigInt(leg);
  if (coi > PERP_COI_MAX) throw new RangeError("perpCoi: client order index would reach 2^48");
  return coi;
}

// ── parsing venue numbers ───────────────────────────────────────────────────

const MICRO_RE = /^-?\d+(\.\d{1,6})?$/;
const DECIMAL_RE = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * A documented 6-dp USDG amount as exact integer micro-USDG, or null.
 *
 * NO FLOATS, EVER. Lighter renders some money fields through a float —
 * total_asset_value arrived as "1679.8316029999999" — and parseFloat on that
 * is a number that was never on the venue's books. Anything that is not
 * `^-?\d+(\.\d{1,6})?$` is unread (null), never rounded into shape: rule 11
 * makes an unread venue field a book gap, and a book gap refuses opens.
 */
export function parseMicroUsdg(s: unknown): bigint | null {
  if (typeof s !== "string" || !MICRO_RE.test(s)) return null;
  return parseDecimalToScaled(s, 6);
}

/**
 * A venue decimal string (price, size, fraction) scaled to an integer at a
 * declared precision, or null. Strict: fewer decimals are padded, MORE are
 * refused, never rounded — a price with more decimals than its market's
 * price_decimals is not a price that market can carry.
 */
export function parseDecimalToScaled(s: unknown, decimals: number): bigint | null {
  if (typeof s !== "string" || s.length > 100) return null;
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const m = DECIMAL_RE.exec(s);
  if (m === null) return null;
  const neg = m[1] === "-";
  const int = m[2] ?? "";
  const frac = m[3] ?? "";
  if (frac.length > decimals) return null;
  const v = BigInt(int + frac.padEnd(decimals, "0"));
  return neg ? -v : v;
}

/**
 * A position's `initial_margin_fraction` in basis points, or null.
 *
 * THE UNIT TRAP. orderBookDetails and trades carry margin fractions as integers
 * in 1/10000; an account position carries the same quantity as a PERCENT
 * string ("8.33" = 833 bp, "20.00" = 2000 bp). Everything stored is normalised
 * to 1/10000 through this.
 */
export function imfPercentToBp(s: unknown): number | null {
  const v = parseDecimalToScaled(s, 2);
  if (v === null || v <= 0n || v > 10_000n) return null;
  return Number(v);
}

// ── market spec and integer math ────────────────────────────────────────────

/**
 * One market's live venue terms, as markets.ts parses them from
 * orderBookDetails. Every fraction is an integer in 1/10000 (bp).
 */
export interface PerpMarketSpec {
  marketId: number;
  sizeDecimals: number;
  priceDecimals: number;
  /** venue base units (size × 10^sizeDecimals) */
  minBaseAmount: bigint;
  minQuoteMicro: bigint;
  minImfBp: number;
  defaultImfBp: number;
  /**
   * A per-MARKET constant — 60% of the market's MINIMUM IMF — not 60% of the
   * IMF the account chose. At 10x on a 10x market that is 6% maintenance, not
   * 6% of 10%; reading it the other way puts liquidation in the wrong place.
   */
  mmfBp: number;
  closeoutBp: number;
  liquidationFeeBp?: number;
  status: "active" | "inactive" | "reduce-only";
}

export type PerpSide = "long" | "short";

/** The highest leverage merrymen ever sets, whatever the owner or venue allows (rule 6). */
export const PERP_MAX_LEVERAGE = 10;

/** lighter-go MaxOrderPrice (uint32). A price above it cannot be signed; one below 1 is nil. */
export const PERP_MAX_ORDER_PRICE = 2n ** 32n - 1n;

const MICRO = 1_000_000n;
const BP = 10_000n;

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/** Floor division for b > 0 (bigint `/` truncates toward zero). */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
}

/** Ceiling division for b > 0. */
function ceilDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a > 0n ? q + 1n : q;
}

function divRound(a: bigint, b: bigint, rounding: "floor" | "ceil"): bigint {
  return rounding === "floor" ? floorDiv(a, b) : ceilDiv(a, b);
}

function assertDecimals(spec: Pick<PerpMarketSpec, "sizeDecimals" | "priceDecimals">): void {
  for (const d of [spec.sizeDecimals, spec.priceDecimals]) {
    if (!Number.isSafeInteger(d) || d < 0 || d > 18) throw new RangeError("perps: market decimals must be integers in 0..18");
  }
}

function assertBps(name: string, v: number, min: number, max: number): void {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new RangeError(`perps: ${name} must be an integer in ${min}..${max}`);
}

/** 10^(sizeDecimals + priceDecimals): the divisor that turns base × price into whole USDG. */
function scaleOf(spec: Pick<PerpMarketSpec, "sizeDecimals" | "priceDecimals">): bigint {
  assertDecimals(spec);
  return pow10(spec.sizeDecimals + spec.priceDecimals);
}

/**
 * base × price in micro-USDG. Rounds UP by default: a notional is judged
 * against caps (per-trade, open-notional, daily), and an exposure rounded down
 * is a cap exceeded by up to a micro every time it binds. "floor" is there for
 * the rare caller that needs the other side, and must say so.
 */
export function notionalMicro(
  baseAmount: bigint,
  price: bigint,
  spec: Pick<PerpMarketSpec, "sizeDecimals" | "priceDecimals">,
  rounding: "floor" | "ceil" = "ceil",
): bigint {
  if (baseAmount < 0n || price < 0n) throw new RangeError("notionalMicro: base and price must be non-negative");
  return divRound(baseAmount * price * MICRO, scaleOf(spec), rounding);
}

/**
 * The base amount (venue units) worth `notionalMicro` at `price`. FLOOR by
 * default — sizing under a cap must never produce a size whose notional is
 * over it. Use "ceil" only to reach a minimum.
 */
export function baseForNotional(
  notional: bigint,
  price: bigint,
  spec: Pick<PerpMarketSpec, "sizeDecimals" | "priceDecimals">,
  rounding: "floor" | "ceil" = "floor",
): bigint {
  if (notional < 0n) throw new RangeError("baseForNotional: notional must be non-negative");
  if (price <= 0n) throw new RangeError("baseForNotional: price must be positive");
  return divRound(notional * scaleOf(spec), price * MICRO, rounding);
}

/**
 * The leverage merrymen sets on a market, and the IMF that encodes it (rule 6).
 *
 *   L = min(perpsMaxLeverage, floor(10000 / minImfBp), 10)
 *   imfBp = ceil(10000 / L)
 *
 * The IMF rounds UP so the leverage the venue applies, 10000 / imfBp, is never
 * above L. The official SDK rounds 10000 / L DOWN, which at 3x gives 3333 bp —
 * 3.0003x, a hair over the owner's cap. Ours is 3334 (2.9994x), and for every
 * market still ≥ the market's minimum IMF because L ≤ 10000 / minImfBp.
 * Throws on a setting that is not a positive integer: settings clamp it to
 * 1..10, so anything else is a bug that must not pick a leverage by accident.
 */
export function leverageTarget(
  maxLeverageSetting: number,
  spec: Pick<PerpMarketSpec, "minImfBp">,
): { leverage: number; imfBp: number } {
  if (!Number.isSafeInteger(maxLeverageSetting) || maxLeverageSetting < 1) {
    throw new RangeError("leverageTarget: perpsMaxLeverage must be a positive integer");
  }
  assertBps("minImfBp", spec.minImfBp, 1, 10_000);
  const venueMax = Math.floor(10_000 / spec.minImfBp);
  const leverage = Math.min(maxLeverageSetting, venueMax, PERP_MAX_LEVERAGE);
  return { leverage, imfBp: Math.ceil(10_000 / leverage) };
}

/** The contract's display rule: leverage shown as floor(1_000_000 / imfBp) / 100 — never overstated. */
export function leverageFromImfBp(imfBp: number): number {
  assertBps("imfBp", imfBp, 1, 10_000);
  return Math.floor(1_000_000 / imfBp) / 100;
}

/** Isolated margin for a notional at an IMF: notional × imf / 10000, rounded UP (margin is money committed). */
export function isolatedMarginMicro(notional: bigint, imfBp: number): bigint {
  if (notional < 0n) throw new RangeError("isolatedMarginMicro: notional must be non-negative");
  assertBps("imfBp", imfBp, 1, 10_000);
  return ceilDiv(notional * BigInt(imfBp), BP);
}

// ── the collateral cap's arithmetic (rule 6) ────────────────────────────────
//
// ONE HOME FOR IT, because three places use it and they drifted. The producers
// (perp-trend, the strategist's boundary) sized an open against free cash PLUS
// the room under perpsMaxCollateralUsdg, while checkPerpOpen judges committed +
// margin ≤ cap — so on paper, with the owner's cap below what paper cash could
// fund, perp-trend proposed an open the wall refused on every signal bar (a bar
// spent, energy claimed and refunded, a decision row and an owner refusal each
// time). And a deposit sized to margin + 10% would, once landed, raise
// `committed` by itself and so refuse the very open it was posted to fund,
// stranding the USDG at the venue. The rule itself is not relaxed here — every
// caller now asks it the same question.
//
// WHAT THE CAP COUNTS: committed = C + ΣM + T_in (cross collateral, isolated
// margin, deposits in transit). An open's margin is judged as NEW commitment —
// the state does not split free cross collateral from committed, so none of it
// is counted free (policy.ts checkPerpOpen) — and a deposit is committed from
// the moment it lands. Hence, with room = cap − committed:
//   an open fits          margin ≤ room
//   a deposit fits        deposit ≤ room
//   a deposit-funded open deposit + margin ≤ room  (the deposit lands first;
//                         the open is then judged with it in `committed`)

/** Lighter's minimum deposit (assetConfigs(3).minDepositTicks): 1 USDG. */
export const PERP_MIN_DEPOSIT_MICRO = 1_000_000n;
/** A deposit funds the open's margin plus this share on top, in percent (docs/perps.md "The perps route": margin + 10%). */
export const PERP_DEPOSIT_BUFFER_PCT = 110n;

/** The room under the collateral cap: cap − committed, never negative. */
export function perpCollateralRoomMicro(committedMicro: bigint, capMicro: bigint): bigint {
  return capMicro > committedMicro ? capMicro - committedMicro : 0n;
}

/** checkPerpOpen's test, word for word: committed + margin ≤ cap. */
export function perpMarginFitsCap(committedMicro: bigint, marginMicro: bigint, capMicro: bigint): boolean {
  return marginMicro >= 0n && committedMicro + marginMicro <= capMicro;
}

/**
 * The deposit that funds `margin` with `free` cross collateral already at the
 * venue: ceil(margin × 1.1) − free, raised to the venue's minimum; 0 when what
 * is there already covers margin + 10%.
 */
export function perpDepositForMarginMicro(marginMicro: bigint, freeMicro: bigint, minDepositMicro: bigint = PERP_MIN_DEPOSIT_MICRO): bigint {
  if (marginMicro < 0n) throw new RangeError("perpDepositForMarginMicro: margin must be non-negative");
  const free = freeMicro > 0n ? freeMicro : 0n;
  const withBuffer = ceilDiv(marginMicro * PERP_DEPOSIT_BUFFER_PCT, 100n);
  if (withBuffer <= free) return 0n;
  const need = withBuffer - free;
  return need < minDepositMicro ? minDepositMicro : need;
}

/**
 * THE MOST ISOLATED MARGIN ONE OPEN MAY TAKE, by the cap's own arithmetic —
 * what a producer sizes to (size ≤ margin budget × L, less its own slack).
 *
 *   paper  min(free, room). Paper margin comes out of the paper book's cash
 *          (`free`) and counts against the cap like any margin (ΣM is in
 *          committed); cash beyond the room is not collateral anyone allowed.
 *   live   the larger of the two ways it can be funded:
 *            from free cross collateral with its 10% buffer, no deposit:
 *              ceil(1.1·M) ≤ free and M ≤ room → M ≤ min(floor(free/1.1), room)
 *            by a deposit D(M) = max(min, ceil(1.1·M) − free), itself
 *            committed: D + M ≤ room → M ≤ room − min and
 *              ceil(1.1·M) + M ≤ room + free, which floor((100·(room+free) − 99)/210)
 *              satisfies exactly (ceil(1.1·M) ≤ (110·M + 99)/100).
 *          What the deposit may draw on (account cash, the sealed per-trade
 *          cap, the day's spend) is depositToFund's to refuse — the open then
 *          waits; it is never resized there.
 */
export function perpOpenMarginBudgetMicro(args: {
  mode: "paper" | "live";
  freeMicro: bigint;
  roomMicro: bigint;
  minDepositMicro?: bigint;
}): bigint {
  const free = args.freeMicro > 0n ? args.freeMicro : 0n;
  const room = args.roomMicro > 0n ? args.roomMicro : 0n;
  if (args.mode === "paper") return free < room ? free : room;
  if (args.mode !== "live") throw new RangeError("perpOpenMarginBudgetMicro: mode must be paper or live");
  const min = args.minDepositMicro ?? PERP_MIN_DEPOSIT_MICRO;
  const fromFreeRaw = (free * 100n) / PERP_DEPOSIT_BUFFER_PCT;
  const fromFree = fromFreeRaw < room ? fromFreeRaw : room;
  const s = (room + free) * 100n - 99n;
  const byBoth = s > 0n ? s / (PERP_DEPOSIT_BUFFER_PCT + 100n) : 0n;
  const underMin = room > min ? room - min : 0n;
  const viaDeposit = byBoth < underMin ? byBoth : underMin;
  return fromFree > viaDeposit ? fromFree : viaDeposit;
}

/**
 * What is left after one open of `margin` is funded — so a producer placing
 * several opens in one window judges each against what the ones before it
 * used. Paper: margin leaves cash (free) and joins ΣM (committed). Live: a
 * deposit, if one is needed, lands and is committed; the margin then moves
 * from free cross collateral into the position, which leaves committed where
 * it was (C before, M after) — so the room falls by the deposit alone, and
 * free by the margin less the deposit.
 */
export function perpCollateralAfterOpen(args: {
  mode: "paper" | "live";
  freeMicro: bigint;
  roomMicro: bigint;
  marginMicro: bigint;
  minDepositMicro?: bigint;
}): { freeMicro: bigint; roomMicro: bigint } {
  const free = args.freeMicro > 0n ? args.freeMicro : 0n;
  const room = args.roomMicro > 0n ? args.roomMicro : 0n;
  const clamp = (x: bigint) => (x > 0n ? x : 0n);
  if (args.mode === "paper") return { freeMicro: clamp(free - args.marginMicro), roomMicro: clamp(room - args.marginMicro) };
  const d = perpDepositForMarginMicro(args.marginMicro, free, args.minDepositMicro);
  return { freeMicro: clamp(free + d - args.marginMicro), roomMicro: clamp(room - d) };
}

/**
 * Isolated liquidation price, shared core. `scaledCost` is |s| × entry in
 * micro-USDG multiplied by 10^(sd+pd) — for an integer entry price that is
 * exactly entry × base × 10^6, with no division anywhere before the last one.
 *
 * Solve AM + uPnL = MMR for the mark P, with uPnL = sign·|s|·(P − entry) and
 * MMR = |s|·P·MMF:
 *   long  P = (entry − AM/|s|) / (1 − MMF)
 *   short P = (entry + AM/|s|) / (1 + MMF)
 * In venue integers that is ((cost ∓ AM)·10^(sd+pd)·10000) / (|s|·10^6·(10000 ∓ mmf)).
 */
function liqCore(
  side: PerpSide,
  scaledCost: bigint,
  baseAmount: bigint,
  allocatedMarginMicro: bigint,
  mmfBp: number,
  k: bigint,
): bigint | null {
  if (baseAmount <= 0n) throw new RangeError("isolatedLiqPrice: baseAmount must be positive (the side carries the sign)");
  if (allocatedMarginMicro < 0n) throw new RangeError("isolatedLiqPrice: allocated margin must be non-negative");
  assertBps("mmfBp", mmfBp, 0, 9_999);
  const mmf = BigInt(mmfBp);
  if (side === "long") {
    const num = (scaledCost - allocatedMarginMicro * k) * BP;
    // A long whose margin covers its whole cost cannot be liquidated at any
    // positive price. That is not "unknown" — there is simply no such price.
    if (num <= 0n) return null;
    // UP: toward the entry. The estimate says liquidation comes sooner than the
    // venue's exact figure, never later.
    return ceilDiv(num, baseAmount * MICRO * (BP - mmf));
  }
  if (side !== "short") throw new RangeError("isolatedLiqPrice: side must be long or short");
  const num = (scaledCost + allocatedMarginMicro * k) * BP;
  // DOWN: toward the entry, for the same reason.
  const p = floorDiv(num, baseAmount * MICRO * (BP + mmf));
  return p > 0n ? p : null;
}

/**
 * The venue's isolated liquidation price for a position opened at an integer
 * `entryPrice`, in venue price units; null when no positive price exists (a
 * long margined at 1x). Rounded toward the entry — up for a long, down for a
 * short — so a check against it errs toward refusing.
 *
 * Checked at open with entry = the IOC's WORST price (rule 7), because that is
 * the entry the position can actually get. perps.test.ts reproduces the
 * venue's liquidation_price for every live isolated position in the fixtures.
 */
export function isolatedLiqPrice(args: {
  side: PerpSide;
  entryPrice: bigint;
  baseAmount: bigint;
  allocatedMarginMicro: bigint;
  mmfBp: number;
  spec: Pick<PerpMarketSpec, "sizeDecimals" | "priceDecimals">;
}): bigint | null {
  const k = scaleOf(args.spec);
  if (args.entryPrice <= 0n) throw new RangeError("isolatedLiqPrice: entryPrice must be positive");
  return liqCore(args.side, args.entryPrice * args.baseAmount * MICRO, args.baseAmount, args.allocatedMarginMicro, args.mmfBp, k);
}

/**
 * The same price for a position the VENUE holds, from its exact cost basis.
 *
 * WHY A SECOND ENTRY POINT. A position's avg_entry_price is displayed rounded
 * to the market's tick, and the venue computes liquidation from the unrounded
 * average — so the rounded entry alone can land ~1.5 ticks off. The cost basis
 * is exact: |s| × entry = position_value − sign × unrealized_pnl, both exact
 * 6-dp fields from the same account read. From it this reproduces the venue's
 * liquidation_price to within the one tick of rounding (perps.test.ts).
 */
export function isolatedLiqPriceFromCost(args: {
  side: PerpSide;
  entryCostMicro: bigint;
  baseAmount: bigint;
  allocatedMarginMicro: bigint;
  mmfBp: number;
  spec: Pick<PerpMarketSpec, "sizeDecimals" | "priceDecimals">;
}): bigint | null {
  const k = scaleOf(args.spec);
  if (args.entryCostMicro <= 0n) throw new RangeError("isolatedLiqPriceFromCost: entry cost must be positive");
  return liqCore(args.side, args.entryCostMicro * k, args.baseAmount, args.allocatedMarginMicro, args.mmfBp, k);
}

/**
 * How far mark is from liquidation, in bp of mark, rounded DOWN (a distance
 * is a margin of safety and is never overstated). Negative once mark has
 * crossed. null when the position has no positive liquidation price.
 */
export function liqDistanceBps(args: { side: PerpSide; markPrice: bigint; liqPrice: bigint | null }): number | null {
  if (args.liqPrice === null) return null;
  if (args.markPrice <= 0n) throw new RangeError("liqDistanceBps: markPrice must be positive");
  const gap = args.side === "long" ? args.markPrice - args.liqPrice : args.liqPrice - args.markPrice;
  return Number(floorDiv(gap * BP, args.markPrice));
}

/**
 * The venue stop for an open: trigger and execution bound (rule 7).
 *
 * A long's stop SELLS below the entry reference; a short's BUYS above it.
 *   long  trigger = ref × (1 − sl) rounded UP     price = trigger × (1 − slip) rounded UP
 *   short trigger = ref × (1 + sl) rounded DOWN   price = trigger × (1 + slip) rounded DOWN
 *
 * Both roundings go TOWARD the entry, so neither the trigger nor the worst fill
 * ever sits farther away than the owner set — a stop rounded outward would lose
 * more than the owner agreed to, a tick at a time. The execution price is a
 * slippage bound, not a fill: in a gap past it the triggered IOC cancels and
 * the position stays open (the protective loop is the backstop), and it must
 * sit inside the venue's 5% band of the trigger, which settings keep by
 * bounding slip to 50–450 bp.
 *
 * Throws when the result is degenerate (a trigger that rounds onto the entry, a
 * price outside 1..2^32−1): an unplaceable stop means an unprotected open, and
 * the caller must refuse the open rather than send it without one. `spec` is
 * accepted for call-site symmetry; prices are already venue integers.
 */
export function stopPrices(args: {
  side: PerpSide;
  entryRefPrice: bigint;
  stopLossBps: number;
  stopSlipBps: number;
  spec?: Pick<PerpMarketSpec, "priceDecimals">;
}): { trigger: bigint; price: bigint } {
  const { side, entryRefPrice: ref } = args;
  assertBps("stopLossBps", args.stopLossBps, 1, 9_999);
  assertBps("stopSlipBps", args.stopSlipBps, 0, 9_999);
  if (ref <= 0n || ref > PERP_MAX_ORDER_PRICE) throw new RangeError("stopPrices: entry reference out of range");
  const sl = BigInt(args.stopLossBps);
  const slip = BigInt(args.stopSlipBps);
  let trigger: bigint;
  let price: bigint;
  if (side === "long") {
    trigger = ceilDiv(ref * (BP - sl), BP);
    price = ceilDiv(trigger * (BP - slip), BP);
    if (!(trigger < ref && price >= 1n && price <= trigger)) throw new RangeError("stopPrices: stop rounds onto the entry or below 1");
  } else if (side === "short") {
    trigger = floorDiv(ref * (BP + sl), BP);
    price = floorDiv(trigger * (BP + slip), BP);
    if (!(trigger > ref && price >= trigger && price <= PERP_MAX_ORDER_PRICE)) {
      throw new RangeError("stopPrices: stop rounds onto the entry or above the venue's maximum price");
    }
  } else {
    throw new RangeError("stopPrices: side must be long or short");
  }
  return { trigger, price };
}

/**
 * A take-profit child: the mirror of the stop, on the winning side.
 *   long  trigger = ref × (1 + tp) rounded DOWN   price = trigger × (1 − slip) rounded UP
 *   short trigger = ref × (1 − tp) rounded UP     price = trigger × (1 + slip) rounded DOWN
 *
 * The trigger rounds toward the entry (the take is never farther than the
 * owner set) and the execution bound toward the trigger (never more slippage
 * than set), as for the stop. A short cannot take profit at or beyond a 100%
 * fall, so takeProfitBps ≥ 10000 on a short throws; callers skip the take (the
 * open is then OTO) rather than send one that can never fire.
 */
export function takePrices(args: {
  side: PerpSide;
  entryRefPrice: bigint;
  takeProfitBps: number;
  stopSlipBps: number;
  spec?: Pick<PerpMarketSpec, "priceDecimals">;
}): { trigger: bigint; price: bigint } {
  const { side, entryRefPrice: ref } = args;
  assertBps("takeProfitBps", args.takeProfitBps, 1, side === "short" ? 9_999 : 1_000_000);
  assertBps("stopSlipBps", args.stopSlipBps, 0, 9_999);
  if (ref <= 0n || ref > PERP_MAX_ORDER_PRICE) throw new RangeError("takePrices: entry reference out of range");
  const tp = BigInt(args.takeProfitBps);
  const slip = BigInt(args.stopSlipBps);
  let trigger: bigint;
  let price: bigint;
  if (side === "long") {
    trigger = floorDiv(ref * (BP + tp), BP);
    price = ceilDiv(trigger * (BP - slip), BP);
    if (!(trigger > ref && trigger <= PERP_MAX_ORDER_PRICE && price >= 1n)) throw new RangeError("takePrices: take rounds onto the entry or out of range");
  } else if (side === "short") {
    trigger = ceilDiv(ref * (BP - tp), BP);
    price = floorDiv(trigger * (BP + slip), BP);
    if (!(trigger < ref && trigger >= 1n && price <= PERP_MAX_ORDER_PRICE)) throw new RangeError("takePrices: take rounds onto the entry or out of range");
  } else {
    throw new RangeError("takePrices: side must be long or short");
  }
  return { trigger, price };
}

/**
 * The worst price an IOC taker accepts: a sell (isAsk) no lower than
 * mark × (1 − slip), a buy no higher than mark × (1 + slip) — each rounded
 * TOWARD the mark, so the bound never allows more slippage than the owner set.
 * This is also the price an open's notional is judged at (rule 6).
 */
export function worstPriceForTaker(args: {
  isAsk: boolean;
  mark: bigint;
  maxSlippageBps: number;
  spec?: Pick<PerpMarketSpec, "priceDecimals">;
}): bigint {
  assertBps("maxSlippageBps", args.maxSlippageBps, 0, 9_999);
  if (args.mark <= 0n || args.mark > PERP_MAX_ORDER_PRICE) throw new RangeError("worstPriceForTaker: mark out of range");
  const slip = BigInt(args.maxSlippageBps);
  const p = args.isAsk ? ceilDiv(args.mark * (BP - slip), BP) : floorDiv(args.mark * (BP + slip), BP);
  if (p < 1n || p > PERP_MAX_ORDER_PRICE) throw new RangeError("worstPriceForTaker: worst price outside 1..2^32−1");
  return p;
}

/**
 * The smallest order the market takes, in micro-USDG:
 * max(min_quote_amount, min_base_amount × price). On 2026-09-29 the second term
 * bound for a dozen markets (BTC ≈ 16.6 USDG, ETH ≈ 13.4) — reading the
 * 10 USDG quote minimum alone would size orders the venue rejects. Rounded UP
 * with notionalMicro: an order that clears this estimate clears the venue.
 */
export function effectiveMinNotionalMicro(
  spec: Pick<PerpMarketSpec, "sizeDecimals" | "priceDecimals" | "minBaseAmount" | "minQuoteMicro">,
  price: bigint,
): bigint {
  const byBase = notionalMicro(spec.minBaseAmount, price, spec, "ceil");
  return byBase > spec.minQuoteMicro ? byBase : spec.minQuoteMicro;
}

/** The smallest base amount that clears both venue minimums at `price` (rounded UP). */
export function minOpenBase(
  spec: Pick<PerpMarketSpec, "sizeDecimals" | "priceDecimals" | "minBaseAmount" | "minQuoteMicro">,
  price: bigint,
): bigint {
  const byQuote = baseForNotional(spec.minQuoteMicro, price, spec, "ceil");
  return byQuote > spec.minBaseAmount ? byQuote : spec.minBaseAmount;
}

/**
 * Unrealized P&L at mark, micro-USDG, rounded DOWN (toward −∞): a gain is
 * never overstated and a loss never understated. Live equity uses the venue's
 * own `unrealized_pnl`; this is the paper engine's and the display's number.
 */
export function unrealizedPnlMicro(args: {
  side: PerpSide;
  baseAmount: bigint;
  entryPrice: bigint;
  markPrice: bigint;
  spec: Pick<PerpMarketSpec, "sizeDecimals" | "priceDecimals">;
}): bigint {
  if (args.baseAmount < 0n || args.entryPrice <= 0n || args.markPrice <= 0n) {
    throw new RangeError("unrealizedPnlMicro: base must be non-negative and prices positive");
  }
  let move: bigint;
  if (args.side === "long") move = args.markPrice - args.entryPrice;
  else if (args.side === "short") move = args.entryPrice - args.markPrice;
  else throw new RangeError("unrealizedPnlMicro: side must be long or short");
  return floorDiv(args.baseAmount * move * MICRO, scaleOf(args.spec));
}

/**
 * One hourly funding payment for a position, signed from the HOLDER's view:
 * negative when it pays, positive when it receives.
 *
 * Lighter's /fundings gives `value` (= index × rate / 100, USDG per ONE WHOLE
 * base unit) and `direction`, the side that PAYS. `valuePerBase` is that value
 * scaled by 10^valueDecimals (default 6: micro-USDG per whole base unit; pass
 * the venue string's own precision, e.g. 8 for "0.00141704", to lose nothing).
 * The payer is charged the ceiling and the receiver credited the floor, so a
 * paper book never earns a rounding micro the venue would not pay.
 *
 * Throws on a negative value: which side pays a negative rate has never been
 * observed on this instance, and booking a guess is worse than booking nothing.
 */
export function fundingPaymentMicro(args: {
  side: PerpSide;
  baseAmount: bigint;
  valuePerBase: bigint;
  direction: PerpSide;
  spec: Pick<PerpMarketSpec, "sizeDecimals">;
  valueDecimals?: number;
}): bigint {
  const valueDecimals = args.valueDecimals ?? 6;
  if (!Number.isSafeInteger(valueDecimals) || valueDecimals < 0 || valueDecimals > 18) {
    throw new RangeError("fundingPaymentMicro: valueDecimals must be an integer in 0..18");
  }
  if (!Number.isSafeInteger(args.spec.sizeDecimals) || args.spec.sizeDecimals < 0 || args.spec.sizeDecimals > 18) {
    throw new RangeError("fundingPaymentMicro: sizeDecimals must be an integer in 0..18");
  }
  if (args.baseAmount < 0n) throw new RangeError("fundingPaymentMicro: baseAmount must be non-negative");
  if (args.valuePerBase < 0n) throw new RangeError("fundingPaymentMicro: a negative funding value has no observed sign convention");
  if ((args.side !== "long" && args.side !== "short") || (args.direction !== "long" && args.direction !== "short")) {
    throw new RangeError("fundingPaymentMicro: side and direction must be long or short");
  }
  const num = args.baseAmount * args.valuePerBase * MICRO;
  const den = pow10(args.spec.sizeDecimals + valueDecimals);
  return args.side === args.direction ? -ceilDiv(num, den) : floorDiv(num, den);
}

/**
 * The equity every PEAK ratchets on (rule 12): equity − Σ max(0, Uᵢ), per
 * position, never on the net. An open winner is not yet money; a peak — the
 * lifetime high-water mark the fee is charged above, the breaker's risk-period
 * peak — lifted on it would charge a fee on, or measure a drawdown from, a gain
 * that can still evaporate. Losers stay in (they are real until they recover).
 */
export function peakBasisMicro(equityMicro: bigint, unrealizedPerPosition: readonly bigint[]): bigint {
  let open = 0n;
  for (const u of unrealizedPerPosition) if (u > 0n) open += u;
  return equityMicro - open;
}

/**
 * Does the stop's WORST price beat the estimated liquidation price by at least
 * `bufferBps` of the entry (rule 7)? A stop that fills only after the venue has
 * liquidated protects nothing and adds the liquidation fee on top.
 *
 *   long  stop > liq  and  (stop − liq) × 10000 ≥ entry × buffer
 *   short stop < liq  and  (liq − stop) × 10000 ≥ entry × buffer
 *
 * `liqPrice: null` is isolatedLiqPrice's "no positive liquidation price": a 1x
 * long, which the stop beats trivially. A short always has one, so a null there
 * is not that — it is treated as unknown and refused. Malformed input, or a
 * stop on the winning side of the entry, is false: this gate lets an open
 * through, so anything it cannot judge keeps the open out.
 */
export function stopBeatsLiquidation(args: {
  side: PerpSide;
  stopPrice: bigint;
  liqPrice: bigint | null;
  entryPrice: bigint;
  bufferBps: number;
}): boolean {
  const { side, stopPrice, liqPrice, entryPrice, bufferBps } = args;
  if (!Number.isSafeInteger(bufferBps) || bufferBps < 0) return false;
  if (stopPrice <= 0n || entryPrice <= 0n) return false;
  const need = entryPrice * BigInt(bufferBps);
  if (side === "long") {
    if (stopPrice >= entryPrice) return false;
    if (liqPrice === null) return true;
    return stopPrice > liqPrice && (stopPrice - liqPrice) * BP >= need;
  }
  if (side === "short") {
    if (stopPrice <= entryPrice) return false;
    if (liqPrice === null || liqPrice <= 0n) return false;
    return liqPrice > stopPrice && (liqPrice - stopPrice) * BP >= need;
  }
  return false;
}

/**
 * The per-trade fee merrymen charges on a perp fill: none.
 *
 * A v1 decision (docs/perps.md, "Decisions that need Milla": any future
 * turnover fee is hers to decide). The performance fee still applies, through
 * rule 12 — perp gains reach the high-water mark once they are realized, which
 * is where every other strategy's fee comes from. Lighter's own standard-account
 * fee is 0% maker and taker as well, so a paper perp fill is fee-free on both
 * counts.
 */
export const PERP_TRADE_FEE_BPS = 0;

// ── what the owner is told ──────────────────────────────────────────────────

/**
 * Why an agent's perps are not trading. SEPARATE from RefuseRule on purpose:
 * that union drives the red BLOCKED pill for the whole agent, and an agent
 * whose spot rail is healthy is not blocked because its perps are off.
 *
 * The union is DERIVED from this list, so the list the report parser accepts
 * and the union perpsBlockerText must cover cannot drift apart.
 */
export const PERP_BLOCKERS = Object.freeze([
  "perps-off",
  "perps-live-off",
  "account-not-live",
  "perps-not-granted",
  "perps-cap-below-min",
  "perps-awaiting-deposit",
  "perps-key-pending",
  "perps-key-mismatch",
  "perps-venue-unreachable",
  "perps-no-collateral",
  "perps-grant-expiring",
  "perps-unknown-activity",
  "perps-entries-halted",
  "breaker-tripped",
] as const);

export type PerpBlocker = (typeof PERP_BLOCKERS)[number];

export function isPerpBlocker(x: unknown): x is PerpBlocker {
  return typeof x === "string" && (PERP_BLOCKERS as readonly string[]).includes(x);
}

/**
 * A blocker in words an owner can act on. `remedy` is null when there is
 * nothing for the owner to do — the state clears by itself — because an
 * invented chore is how an owner comes to "fix" a working agent.
 */
export function perpsBlockerText(b: PerpBlocker): { what: string; remedy: string | null } {
  switch (b) {
    case "perps-off":
      return { what: "Perpetuals are off for this agent.", remedy: "Turn them on in Settings, under Perpetuals, on the dashboard." };
    case "perps-live-off":
      // Never "paper": a live account does not run a practice perps book beside
      // its real one (rule 14), so saying paper here would describe nothing.
      return {
        what: "Real-money perpetuals are not switched on, so this live account does not trade them.",
        remedy: "Switch on real perpetuals in Settings, under Perpetuals, on the dashboard.",
      };
    case "account-not-live":
      return {
        what: "Real perpetuals need the account itself to be trading for real, and it is not.",
        remedy: "Turn on live trading for the account on the dashboard first.",
      };
    case "perps-not-granted":
      return {
        what: "The permission you signed does not include perpetuals.",
        remedy: "Re-sign the permission on the dashboard with perpetuals included.",
      };
    case "perps-cap-below-min":
      return {
        what: "Your signed per-trade limit is below the smallest order Lighter accepts on the markets you picked.",
        remedy: "Choose markets whose minimum fits your existing limits, or use paper trading. You can review your settings and signed permission on the dashboard.",
      };
    case "perps-awaiting-deposit":
      return { what: "Waiting for the first USDG deposit to arrive at Lighter.", remedy: null };
    case "perps-key-pending":
      return { what: "The agent's Lighter trading key is being registered.", remedy: null };
    case "perps-key-mismatch":
      return {
        what: "Lighter holds a different trading key for this agent than the one you signed.",
        remedy: "If you did not change it yourself, treat the key as compromised and use `merrymen recover` with your owner key. Once Lighter is flat, use Wallet → Re-enable perpetuals to verify the recovery receipt and sign a fresh permission.",
      };
    case "perps-venue-unreachable":
      // No remedy: it retries by itself, and resting stops at the venue keep
      // working whether or not we can reach it.
      return { what: "Lighter cannot be reached right now, so no new positions are opened.", remedy: null };
    case "perps-no-collateral":
      return { what: "There is no USDG available to post as margin.", remedy: "Add USDG to the agent's account." };
    case "perps-grant-expiring":
      return {
        what: "Your signed permission expires within a day, so no new positions are opened. Closes and stops still run.",
        remedy: "Re-sign the permission on the dashboard.",
      };
    case "perps-unknown-activity":
      return {
        what: "Lighter shows activity on the agent's account that the agent did not do. New positions are stopped and open ones are being closed.",
        remedy: "Use `merrymen recover` with your owner key to replace the trading key and recover available funds. Once Lighter is flat, use Wallet → Re-enable perpetuals to verify the recovery receipt and sign a fresh permission.",
      };
    case "perps-entries-halted":
      return {
        what: "New perpetual positions are paused. Closes and stops still run.",
        remedy: "Resume them on the dashboard when you are ready.",
      };
    case "breaker-tripped":
      return {
        what: "The loss breaker has tripped, so no new positions are opened. Closes and stops still run.",
        remedy: "Review the losses, then reset the breaker on the dashboard.",
      };
  }
}

/**
 * What is at the venue, as far as we know. "unread" is not "none": a Lighter
 * account we could not read may hold positions, and treating it as empty is
 * how a kill message comes to say the money is home while it is not.
 */
export type PerpExposure =
  | { kind: "none" }
  | {
      kind: "known";
      collateralMicro: bigint;
      openPositions: number;
      openOrders: number;
      pendingWithdrawalsMicro: bigint;
      /**
       * Rule 12's T_in: margin deposits landed on chain and not yet credited
       * at the venue. Money in transit INTO Lighter is still on its way there,
       * not home.
       */
      depositsInTransitMicro: bigint;
      /** Public-pool share entries (rule 4: how a stolen key parks money; rule 5 counts them). */
      poolShareCount: number;
      /**
       * Spot-route balances and pending unlocks on our account (PerpAccountRead
       * spotHoldings + pendingUnlockCount): money outside the perps account
       * the worker never puts there (rule 16).
       */
      spotBalanceCount: number;
      /**
       * Other Lighter accounts under our L1 address — sub-accounts, which we
       * never create (rules 4 and 16). `count` is those not provably empty;
       * `valueMicro` their summed venue value, null when it could not be
       * summed. The whole field null means they were NOT READ, which is
       * unknown, never none.
       */
      otherAccounts: { count: number; valueMicro: bigint | null } | null;
      withdrawalDelaySec: number | null;
      standdown?: {
        closed: string[];
        residual: string[];
        withdrawRequestedMicro: bigint | null;
        failedSteps: string[];
      };
    }
  | { kind: "unread" };

/** micro-USDG for an owner's eyes, rounded UP to the cent: custody text may overstate by under a cent, never understate. */
function usdgText(micro: bigint): string {
  const neg = micro < 0n;
  const cents = ceilDiv(neg ? -micro : micro, 10_000n);
  const whole = (cents / 100n).toLocaleString("en-US");
  return `${neg ? "-" : ""}${whole}.${(cents % 100n).toString().padStart(2, "0")} USDG`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function delayText(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec) || sec <= 0) return "after Lighter's withdrawal delay and a claim";
  return `after Lighter's withdrawal delay (about ${Math.ceil(sec / 60)} min) and a claim`;
}

/**
 * The custody sentence every kill, expiry and stand-down message is built from
 * (rule 13). NEVER a constant: the one sentence that says the funds are home
 * is reserved for `none`, the only state in which it is true. `known` names
 * what is still on Lighter and that resting stops stay in place; `unread` says
 * plainly that we could not look, and names the owner's way to look and unwind.
 *
 * `opts.recover` lets a surface name its own recover path (the CLI's command
 * is the default).
 */
export function custodySentence(exposure: PerpExposure, opts?: { recover?: string }): string {
  const recover = opts?.recover ?? "run `merrymen recover`";
  if (exposure.kind === "none") {
    return "Nothing is held on Lighter, so your funds stay in your smart account.";
  }
  if (exposure.kind === "unread") {
    return (
      "Lighter could not be read, so what is still there is unknown: positions, their resting stops and USDG may " +
      `remain on Lighter. To see it and unwind it with your owner key, ${recover}.`
    );
  }
  if (exposure.kind !== "known") {
    // An exposure this function does not know is as good as unread.
    return `Lighter's state is unknown. To see it and unwind it with your owner key, ${recover}.`;
  }
  const e = exposure;
  const parts: string[] = [];
  const held: string[] = [];
  if (e.openPositions > 0) held.push(plural(e.openPositions, "open position", "open positions"));
  if (e.openOrders > 0) held.push(plural(e.openOrders, "resting order", "resting orders"));
  if (e.collateralMicro !== 0n) held.push(`${usdgText(e.collateralMicro)} of collateral`);
  if (e.poolShareCount > 0) held.push(`shares in ${plural(e.poolShareCount, "public pool", "public pools")}`);
  if (e.spotBalanceCount > 0) held.push(plural(e.spotBalanceCount, "balance in its spot account or unlocking", "balances in its spot account or unlocking"));
  const other = e.otherAccounts;
  if (other !== null && other.count > 0) {
    const worth = other.valueMicro !== null && other.valueMicro !== 0n ? ` holding ${usdgText(other.valueMicro)}` : "";
    held.push(`${plural(other.count, "other Lighter account", "other Lighter accounts")} under your smart account${worth}`);
  }
  if (held.length > 0) parts.push(`Still on Lighter: ${held.join(", ")}.`);
  if (other === null) {
    parts.push("Other Lighter accounts under your smart account could not be read, so whether they hold anything is unknown.");
  }
  if (e.depositsInTransitMicro > 0n) {
    parts.push(`${usdgText(e.depositsInTransitMicro)} deposited to Lighter has landed on chain and is not yet credited there.`);
  }
  if (e.openPositions > 0) parts.push("Any stops resting at Lighter stay in place until those positions close.");
  const sd = e.standdown;
  if (sd) {
    if (sd.closed.length > 0) parts.push(`Closed: ${sd.closed.join(", ")}.`);
    if (sd.residual.length > 0) parts.push(`Could not be closed: ${sd.residual.join(", ")}.`);
    if (sd.withdrawRequestedMicro !== null && sd.withdrawRequestedMicro > 0n) {
      parts.push(`A withdrawal of ${usdgText(sd.withdrawRequestedMicro)} was requested; it reaches your smart account ${delayText(e.withdrawalDelaySec)}.`);
    }
    if (sd.failedSteps.length > 0) parts.push(`Steps that did not complete: ${sd.failedSteps.join("; ")}.`);
  }
  if (e.pendingWithdrawalsMicro > 0n) {
    parts.push(`${usdgText(e.pendingWithdrawalsMicro)} is on its way back to your smart account, arriving ${delayText(e.withdrawalDelaySec)}.`);
  }
  const somethingLeft =
    held.length > 0 ||
    other === null ||
    e.depositsInTransitMicro > 0n ||
    e.pendingWithdrawalsMicro > 0n ||
    (sd !== undefined && (sd.residual.length > 0 || sd.failedSteps.length > 0));
  if (!somethingLeft) {
    // Known and empty is true, and worth saying — but not as "your funds stay
    // in your smart account": that sentence belongs to an account that never
    // had a venue leg, and this one did. Every field above is zero here,
    // including money on its way in, pool shares, spot balances and every
    // other account under the L1 address (read, not assumed).
    parts.unshift("Lighter reads empty: no positions, orders, collateral, pool shares or other accounts are left there.");
    return parts.join(" ");
  }
  parts.push(`To unwind it yourself with your owner key, ${recover}.`);
  return parts.join(" ");
}

// ── the report the worker writes and the web reads ──────────────────────────

import { getPerpsStyle, isPerpsStyle, type PerpsStyleId } from "./perps-styles";

export interface PerpsReportPosition {
  /** Immutable entry profile recovered from the position's durable fills. */
  entryStyle?: PerpsStyleId;
  styleOpenedAtSec?: number;
  /** Requests a reduce-only close; not a promised fill time. */
  holdDeadlineSec?: number;
  market: PerpKey;
  side: PerpSide;
  /** Venue values rendered in the market's own decimals, e.g. "0.00020". */
  baseAmount: string;
  entryPrice: string;
  markPrice: string | null;
  leverage: number | null;
  /** micro-USDG as a decimal integer string */
  marginMicro: string;
  liqPrice: string | null;
  unrealizedMicro: string | null;
  stopTrigger: string | null;
  fundingMicro: string | null;
}

/**
 * `agents.perps` — the worker's perps status, which the web and apps only
 * read. JSON-safe: money is micro-USDG as decimal integer strings (a bigint
 * does not survive JSON, and a float loses cents at scale), and every nullable
 * field means "not said", never zero. The mobile banner keys on this: anything
 * but a report reading no exposure keeps "Leveraged positions on Lighter…" or
 * "Lighter could not be read…" on screen.
 */
export interface PerpsReport {
  v: 1;
  mode: "off" | "paper" | "live" | "refuse";
  blocker: PerpBlocker | null;
  venueReadAt: number | null;
  protectAt: number | null;
  accountIndex: number | null;
  positions: PerpsReportPosition[];
  openNotionalMicro: string | null;
  collateralMicro: string | null;
  inTransitMicro: string | null;
  minLiqDistanceBps: number | null;
  stopsMissing: number;
  incident: boolean;
  /** Owner's durable Close-all halt, separate from the operator's entry halt. */
  entriesHalted?: boolean;
  /** Current worker observations for configured entry markets; absent means unreported. */
  entryMinimums?: { market: PerpKey; minNotionalMicro: string }[];
}

/** Shared by the autonomous trend rule and owner setup readiness. */
export const PERP_TREND_MAX_HOLD_HOURS = 168;

const REPORT_MODES = ["off", "paper", "live", "refuse"] as const;
const INT_STRING_RE = /^-?\d{1,40}$/;
const POS_DECIMAL_RE = /^\d{1,30}(\.\d{1,30})?$/;
const PERP_KEY_SHAPE_RE = /^[A-Z0-9]{1,24}-PERP$/;
const BAD = Symbol("bad");
type Bad = typeof BAD;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** A nullable field: absent or null is "not said"; present and wrong is BAD. */
function opt<T>(v: unknown, ok: (x: unknown) => x is T): T | null | Bad {
  if (v === undefined || v === null) return null;
  return ok(v) ? v : BAD;
}

const isIntString = (x: unknown): x is string => typeof x === "string" && INT_STRING_RE.test(x);
const isPosDecimal = (x: unknown): x is string => typeof x === "string" && POS_DECIMAL_RE.test(x) && /[1-9]/.test(x);
const isTimestamp = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const isAccountIndex = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const isFiniteNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isLeverage = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;

/** Optional profile metadata cannot make known exposure disappear when a newer producer adds an unknown profile. */
export function perpsPositionStyleReport(entryStyle: unknown, openedAtSec: unknown): Pick<PerpsReportPosition, "entryStyle" | "styleOpenedAtSec" | "holdDeadlineSec"> {
  if (!isPerpsStyle(entryStyle) || typeof openedAtSec !== "number" || !Number.isSafeInteger(openedAtSec) || openedAtSec <= 0) return {};
  const deadline = openedAtSec + getPerpsStyle(entryStyle).maxHoldHours * 3600;
  if (!Number.isSafeInteger(deadline)) return {};
  return { entryStyle, styleOpenedAtSec: openedAtSec, holdDeadlineSec: deadline };
}

function parsePosition(raw: unknown): PerpsReportPosition | Bad {
  if (!isRecord(raw)) return BAD;
  // Shape, not membership: a report naming a market this build does not list
  // is still exposure, and showing it beats hiding it behind "unread".
  if (typeof raw.market !== "string" || !PERP_KEY_SHAPE_RE.test(raw.market)) return BAD;
  if (raw.side !== "long" && raw.side !== "short") return BAD;
  if (!isPosDecimal(raw.baseAmount) || !isPosDecimal(raw.entryPrice)) return BAD;
  if (!isIntString(raw.marginMicro)) return BAD;
  const markPrice = opt(raw.markPrice, isPosDecimal);
  const leverage = opt(raw.leverage, isLeverage);
  const liqPrice = opt(raw.liqPrice, isPosDecimal);
  const unrealizedMicro = opt(raw.unrealizedMicro, isIntString);
  const stopTrigger = opt(raw.stopTrigger, isPosDecimal);
  const fundingMicro = opt(raw.fundingMicro, isIntString);
  if (
    markPrice === BAD ||
    leverage === BAD ||
    liqPrice === BAD ||
    unrealizedMicro === BAD ||
    stopTrigger === BAD ||
    fundingMicro === BAD
  ) {
    return BAD;
  }
  const style = perpsPositionStyleReport(raw.entryStyle, raw.styleOpenedAtSec);
  return {
    ...(style.holdDeadlineSec === raw.holdDeadlineSec ? style : {}),
    market: raw.market as PerpKey,
    side: raw.side,
    baseAmount: raw.baseAmount,
    entryPrice: raw.entryPrice,
    markPrice,
    leverage,
    marginMicro: raw.marginMicro,
    liqPrice,
    unrealizedMicro,
    stopTrigger,
    fundingMicro,
  };
}

/**
 * Strict whitelist parse of `agents.perps`, or null (= unread).
 *
 * Unknown keys are dropped; a wrong type ANYWHERE rejects the whole report,
 * including one malformed position. Dropping just that position would render
 * a book with a leveraged position missing from it — the "No positions" the
 * mobile banner exists to prevent. A reader that gets null must say Lighter's
 * state is unknown, never that there is nothing there.
 */
export function parsePerpsReport(raw: unknown): PerpsReport | null {
  if (!isRecord(raw) || raw.v !== 1) return null;
  if (typeof raw.mode !== "string" || !(REPORT_MODES as readonly string[]).includes(raw.mode)) return null;
  if (!Array.isArray(raw.positions)) return null;
  if (typeof raw.stopsMissing !== "number" || !Number.isSafeInteger(raw.stopsMissing) || raw.stopsMissing < 0) return null;
  if (typeof raw.incident !== "boolean") return null;
  const blocker = opt(raw.blocker, isPerpBlocker);
  const venueReadAt = opt(raw.venueReadAt, isTimestamp);
  const protectAt = opt(raw.protectAt, isTimestamp);
  const accountIndex = opt(raw.accountIndex, isAccountIndex);
  const openNotionalMicro = opt(raw.openNotionalMicro, isIntString);
  const collateralMicro = opt(raw.collateralMicro, isIntString);
  const inTransitMicro = opt(raw.inTransitMicro, isIntString);
  const minLiqDistanceBps = opt(raw.minLiqDistanceBps, isFiniteNumber);
  if (
    blocker === BAD ||
    venueReadAt === BAD ||
    protectAt === BAD ||
    accountIndex === BAD ||
    openNotionalMicro === BAD ||
    collateralMicro === BAD ||
    inTransitMicro === BAD ||
    minLiqDistanceBps === BAD
  ) {
    return null;
  }
  const positions: PerpsReportPosition[] = [];
  for (const p of raw.positions) {
    const parsed = parsePosition(p);
    if (parsed === BAD) return null;
    positions.push(parsed);
  }
  if (raw.entriesHalted !== undefined && typeof raw.entriesHalted !== "boolean") return null;
  let entryMinimums: PerpsReport["entryMinimums"];
  if (raw.entryMinimums !== undefined) {
    if (!Array.isArray(raw.entryMinimums) || raw.entryMinimums.length > LIGHTER_MARKETS_V1.length) return null;
    entryMinimums = [];
    const seen = new Set<string>();
    for (const item of raw.entryMinimums) {
      if (!isRecord(item) || !isPerpKey(item.market) || seen.has(item.market) || !isIntString(item.minNotionalMicro) || BigInt(item.minNotionalMicro) <= 0n) return null;
      seen.add(item.market);
      entryMinimums.push({ market: item.market, minNotionalMicro: item.minNotionalMicro });
    }
  }
  return {
    v: 1,
    mode: raw.mode as PerpsReport["mode"],
    blocker,
    venueReadAt,
    protectAt,
    accountIndex,
    positions,
    openNotionalMicro,
    collateralMicro,
    inTransitMicro,
    minLiqDistanceBps,
    stopsMissing: raw.stopsMissing,
    incident: raw.incident,
    ...(raw.entriesHalted === undefined ? {} : { entriesHalted: raw.entriesHalted }),
    ...(entryMinimums === undefined ? {} : { entryMinimums }),
  };
}

/** Public evidence requested by an owner who re-enables perps after key recovery.
 * This reference is NOT authority by itself: intake and the worker verify the receipt,
 * current slot, incident identity and the fresh key sealed in the owner's grant.
 */
export interface PerpRecoveryReference {
  v: 1;
  smartAccount: `0x${string}`;
  chainId: number;
  route: typeof GRANT_PERP_LIGHTER;
  accountIndex: number;
  apiKeyIndex: number;
  incidentId: string;
  evidenceDigest: string;
  txHash: `0x${string}`;
  userOpHash: `0x${string}`;
  recoveryPublicKey: `0x${string}`;
  oldPublicKey: `0x${string}`;
  newPublicKey: `0x${string}`;
  notAfterMs: number;
}
export function readPerpRecoveryReference(value: unknown): PerpRecoveryReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as PerpRecoveryReference;
  const fields = ["v", "smartAccount", "chainId", "route", "accountIndex", "apiKeyIndex", "incidentId", "evidenceDigest", "txHash", "userOpHash", "recoveryPublicKey", "oldPublicKey", "newPublicKey", "notAfterMs"];
  if (Object.keys(r).length !== fields.length || Object.keys(r).some(k => !fields.includes(k)) || r.v !== 1 || !/^0x[a-f0-9]{40}$/.test(r.smartAccount) || r.chainId !== LIGHTER_ROUTE_V1.chainId || r.route !== GRANT_PERP_LIGHTER || !Number.isSafeInteger(r.accountIndex) || r.accountIndex < 1 || r.apiKeyIndex !== LIGHTER_ROUTE_V1.apiKeyIndex || !/^[a-f0-9-]{36}$/.test(r.incidentId) || !/^[a-f0-9]{64}$/.test(r.evidenceDigest) || !/^0x[a-f0-9]{64}$/.test(r.txHash) || !/^0x[a-f0-9]{64}$/.test(r.userOpHash) || !Number.isSafeInteger(r.notAfterMs) || r.notAfterMs < 1) return null;
  for (const key of [r.recoveryPublicKey, r.oldPublicKey, r.newPublicKey]) if (validatePerpPubKey(key) !== key) return null;
  if (new Set([r.recoveryPublicKey, r.oldPublicKey, r.newPublicKey]).size !== 3) return null;
  return { v: r.v, smartAccount: r.smartAccount, chainId: r.chainId, route: r.route, accountIndex: r.accountIndex, apiKeyIndex: r.apiKeyIndex, incidentId: r.incidentId, evidenceDigest: r.evidenceDigest, txHash: r.txHash, userOpHash: r.userOpHash, recoveryPublicKey: r.recoveryPublicKey, oldPublicKey: r.oldPublicKey, newPublicKey: r.newPublicKey, notAfterMs: r.notAfterMs };
}

/** The same prepared recovery may be re-proved after expiry, never silently extended. */
export function samePerpRecoveryAttempt(a: unknown, b: unknown): boolean {
  const left = readPerpRecoveryReference(a), right = readPerpRecoveryReference(b);
  if (!left || !right) return false;
  return JSON.stringify({ ...left, notAfterMs: 0 }) === JSON.stringify({ ...right, notAfterMs: 0 });
}
