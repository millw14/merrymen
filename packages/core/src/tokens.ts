/**
 * Token registry — Robinhood Chain mainnet (4663).
 * Token addresses from the official registry (docs.robinhood.com/chain/contracts),
 * Chainlink feeds from the Chainlink reference data directory
 * (reference-data-directory.vercel.app/feeds-robinhood-mainnet.json).
 * Cross-checked against Rialto /tokens; core addresses probed via eth_getCode 2026-07-09.
 *
 * Stock Tokens are OpenZeppelin BeaconProxies sharing ONE beacon: the issuer can
 * upgrade every stock token in a single tx, pause any token (or all of them via the
 * shared AccessControlsRegistry), and adminBurn from any address. Treat holdings as
 * issuer-trust-class assets (like USDC) and bound per-asset exposure accordingly.
 *
 * Stock Tokens implement ERC-8056 (Scaled UI Amount): raw ERC-20 balances never
 * rebase; corporate actions (splits/dividends) change uiMultiplier(). ALL position
 * math must go through the multiplier — a split is not a crash.
 *
 * Chainlink stock feeds run 24/5 (underlying markets) even though tokens trade 24/7:
 * weekend prices are stale by design — strategies must treat staleness as expected
 * on weekends, not as an error, and must check the sequencer-uptime feed.
 *
 * More tokens are staged: Chainlink already publishes feeds for GME, MSTR, RKLB,
 * IONQ, TSM, ASML, EWY, NBIS, CLSK, RGTI with no token in the registry yet.
 * Poll the docs page / RDD JSON rather than assuming this list is final.
 */

export interface StockToken {
  symbol: string;
  name: string;
  address: `0x${string}`;
  /** Chainlink AggregatorV3 feed (USD). null = no feed published yet. */
  chainlinkFeed: `0x${string}` | null;
  /**
   * "stock"/"etf" are issuer-backed Stock Tokens with Chainlink feeds and
   * ERC-8056 multipliers. "memecoin" is any other ERC-20 on the chain: no feed,
   * no multiplier, priced from a DEX pool and only when the pool is deep enough
   * to be worth trusting (see worker/src/venues/pool-price.ts).
   */
  kind: "stock" | "etf" | "memecoin";
  /** ERC-20 decimals. Stock tokens and WETH are 18; a memecoin can be anything,
   * and the asset model needs the real figure to value it at all. */
  decimals?: number;
  /**
   * How this token reaches USD. Live pool data for Robinhood Chain (2026-07)
   * shows ~75% of pools quote against WETH rather than USDG, so most memecoins
   * price via TOKEN/WETH × WETH/USDG. Stock tokens have direct USDG pairs.
   * Undefined means "try direct, then WETH" — the routing default.
   */
  quote?: "usdg" | "weth";
}

/**
 * User-added tokens live in settings, not here — this file is the curated,
 * issuer-backed registry and stays that way. A memecoin the owner adds is
 * their choice and their risk, so it is stored with their config and must pass
 * the same liquidity/divergence guards as anything else before it is valued.
 */
export interface CustomToken {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
}

/**
 * A price AND where it came from.
 *
 * Chainlink, a Uniswap pool, and a brokerage quote are not the same evidential
 * quality: the first is an external feed that costs real money to move, the
 * second is a pool balance, the third is the venue's own last-trade print. All
 * three end up as an 8dp number, and once they're just numbers nothing
 * downstream can tell them apart — so the provenance travels with the price.
 *
 * `source` is REQUIRED, never optional with a default. A field someone forgot to
 * set must not silently read as "trustworthy". It is also load-bearing for
 * VALUATION, not just display: chainlink quotes USD per ERC-8056 UI share (the
 * multiplier applies), while pool and broker quote the market's own unit, which
 * already reflects any split (the multiplier must NOT apply) — see
 * worker/src/positions.ts, valuationMultiplierFor.
 */
export interface PriceQuote {
  /** USD per whole token, 8dp — the same unit Chainlink feeds emit. */
  price8: bigint;
  /** Chainlink feed older than 2h. Expected on weekends (feeds run 24/5). */
  stale: boolean;
  /**
   * "broker" = Robinhood get_equity_quotes on the Agentic-account rail.
   * "v4" = a Uniswap v4 pool. Its own class for the same reason "curve" is:
   * v4 moved TWAP into hooks, so a vanilla pool has no oracle and the spot-vs-
   * TWAP divergence check cannot be run. It passed a DEPTH floor, an LP-FEE
   * ceiling and a round-trip cost check instead — good enough to value a
   * holding, and still inside the scout budget on the buy side.
   * "curve" = a Pons bonding curve. A DIFFERENT EVIDENTIAL CLASS from "pool":
   * a pool quote passed a depth floor AND a spot-vs-TWAP divergence band, and
   * a curve quote passed neither because a curve has no oracle to diverge
   * from. It is good enough to value something already held; it is not good
   * enough to authorise a new buy, and the scout ceiling still applies to it.
   */
  source: "chainlink" | "pool" | "broker" | "curve" | "v4";
  /** For pool prices: route + depth, so a human can judge the number. */
  detail?: string;
  /**
   * Depth behind this price, raw USDG (6dp) — the same unit as
   * `PriceGuard.minLiquidityUsdg` and `Discovery.liquidityUsdg`.
   *
   * OPTIONAL, AND ABSENCE IS A REAL VALUE. Chainlink and broker quotes have no
   * depth concept at all, and downstream is written so that null SKIPS the
   * liquidity-drain check while 0 FIRES it — so collapsing "I could not read
   * depth" into "the pool is empty" would turn a missing fact into a forced
   * liquidation. Never write 0n to mean unknown.
   *
   * This exists because the number used to be recovered by running a regex over
   * `detail`, which is prose formatted with `toLocaleString`. On any host whose
   * locale groups with dots or uses non-Latin digits — de-DE, fr-FR, ru-RU,
   * ar-EG — that match failed for every pool over $1,000, silently emptying the
   * depth map. Two live consequences: trencher's rug defence was off, and the
   * trench entry baseline was stamped 0 through an ON CONFLICT DO NOTHING
   * upsert, so it stayed 0 for the position's whole life. A number should never
   * have been round-tripped through a sentence.
   */
  liquidityUsdg?: bigint;
}

/** Reject anything that isn't a plausible ERC-20 entry before it can reach a
 * policy allowlist or a price lookup. Shape only — depth is checked on-chain. */
export function isValidCustomToken(t: unknown): t is CustomToken {
  if (!t || typeof t !== "object") return false;
  const c = t as Partial<CustomToken>;
  if (typeof c.symbol !== "string" || !/^[A-Za-z0-9._-]{1,16}$/.test(c.symbol)) return false;
  if (typeof c.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(c.address)) return false;
  if (typeof c.decimals !== "number" || !Number.isInteger(c.decimals) || c.decimals < 0 || c.decimals > 36) {
    return false;
  }
  return true;
}

/** Shared upgrade beacon behind every Stock Token BeaconProxy. */
export const STOCK_BEACON = "0xe10b6f6b275de231345c20d14ab812db62151b00" as const;

/** Current Stock implementation the beacon points at (verified source, Solidity 0.8.33). */
export const STOCK_IMPLEMENTATION =
  "0xb35490d6f9163de4f80d88dc75c3516eb64c5ae2" as const;

/** Cash + gas legs. NOTE: USDG is 6 decimals (verified on-chain), stock tokens/WETH are 18. */
export const CASH = {
  /** Paxos Global Dollar — ERC-1967 proxy (impl 0x68184c...f8f). Issuer-controlled. 6 decimals. */
  USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
} as const;

export const USDG_DECIMALS = 6;

export const CASH_FEEDS = {
  ETH_USD: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9",
  USDG_USD: "0x61B7e5650328764B076A108EFF5fa7282a1B9aD2",
} as const;

/** Official Stock Token registry as of 2026-07-09. */
export const STOCK_TOKENS: StockToken[] = [
  { symbol: "AAPL", name: "Apple", address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", chainlinkFeed: "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0", kind: "stock" },
  { symbol: "AMD", name: "AMD", address: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC", chainlinkFeed: "0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72", kind: "stock" },
  { symbol: "AMZN", name: "Amazon", address: "0x12f190a9F9d7D37a250758b26824B97CE941bF54", chainlinkFeed: "0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C", kind: "stock" },
  { symbol: "BABA", name: "Alibaba", address: "0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4", chainlinkFeed: "0x62Cc8F9b5f56a33c9C8A60c8B92779f523c4E984", kind: "stock" },
  { symbol: "BE", name: "Bloom Energy", address: "0x822CC93fFD030293E9842c30BBD678F530701867", chainlinkFeed: null, kind: "stock" },
  { symbol: "COIN", name: "Coinbase", address: "0x6330D8C3178a418788dF01a47479c0ce7CCF450b", chainlinkFeed: "0xA3a468A452940B7D6b69991207B508c609a98Ef2", kind: "stock" },
  { symbol: "CRCL", name: "Circle", address: "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5", chainlinkFeed: "0x6652eDf64bA3731C4F2D3ce821A0Fb1f1f6b482a", kind: "stock" },
  { symbol: "CRWV", name: "CoreWeave", address: "0x5f10A1C971B69e47e059e1dC91901B59b3fB49C3", chainlinkFeed: "0xe1b3aABCAFAd1c94708dc1367dcfF8Aa4407487C", kind: "stock" },
  { symbol: "GOOGL", name: "Alphabet", address: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", chainlinkFeed: "0xF6f373a037c30F0e5010d854385cA89185AE638b", kind: "stock" },
  { symbol: "INTC", name: "Intel", address: "0xc72b96e0E48ecd4DC75E1e45396e26300BC39681", chainlinkFeed: "0x3f390C5C24628Ac7C489515402235FeAD71D1913", kind: "stock" },
  { symbol: "META", name: "Meta", address: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", chainlinkFeed: "0x7C38C00C30BEe9378381E7B6135d7283356D71b1", kind: "stock" },
  { symbol: "MSFT", name: "Microsoft", address: "0xe93237C50D904957Cf27E7B1133b510C669c2e74", chainlinkFeed: "0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E", kind: "stock" },
  { symbol: "MU", name: "Micron", address: "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD", chainlinkFeed: "0x425EEFdCf05ed6526C3cE61Af99429A228a6d596", kind: "stock" },
  { symbol: "NVDA", name: "NVIDIA", address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", chainlinkFeed: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15", kind: "stock" },
  { symbol: "ORCL", name: "Oracle", address: "0xb0992820E760d836549ba69BC7598b4af75dEE03", chainlinkFeed: "0x0e6a64a2B58A6693a531E6c555f3A5d042eEA844", kind: "stock" },
  { symbol: "PLTR", name: "Palantir", address: "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A", chainlinkFeed: "0x820ABedFF239034956B7A9d2F0a331f9F075eB4c", kind: "stock" },
  { symbol: "SNDK", name: "Sandisk", address: "0xB90A19fF0Af67f7779afF50A882A9CfF42446400", chainlinkFeed: "0xfb133Fa4B7b385802B693a293606682Df47109A3", kind: "stock" },
  { symbol: "SPCX", name: "SpaceX", address: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", chainlinkFeed: "0xB265810950ba6c5C0Ff821c9963014a56fD8Bffb", kind: "stock" },
  { symbol: "TSLA", name: "Tesla", address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", chainlinkFeed: "0x4A1166a659A55625345e9515b32adECea5547C38", kind: "stock" },
  { symbol: "USAR", name: "USA Rare Earth", address: "0xd917B029C761D264c6A312BBbcDA868658eF86a6", chainlinkFeed: "0xA994d3684e8400A6c8078226925779FdeE682DD9", kind: "stock" },
  { symbol: "QQQ", name: "Invesco QQQ", address: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68", chainlinkFeed: "0x80901d846d5D7B030F26B480776EE3b29374C2ae", kind: "etf" },
  { symbol: "SGOV", name: "iShares 0-3mo Treasury", address: "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5", chainlinkFeed: "0xa0DF4ee0fFf975306345875E3548Fcc519577A11", kind: "etf" },
  { symbol: "SLV", name: "iShares Silver", address: "0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f", chainlinkFeed: "0x209b73908e92Ae021826eD79609845451Ecba2ce", kind: "etf" },
  { symbol: "SPY", name: "SPDR S&P 500", address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", chainlinkFeed: "0x319724394D3A0e3669269846abE664Cd621f9f6A", kind: "etf" },
  { symbol: "USO", name: "United States Oil", address: "0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344", chainlinkFeed: "0x75a9c76Ef439e2C7c2E5a34Ab105EcFe3766431c", kind: "etf" },
];

/**
 * Stock tokens the grant's call policy may approve for a SELL. Every entry was
 * verified via QuoterV2 across the 500/3000/10000 fee tiers on **2026-07-27**,
 * in BOTH directions — a buy that quotes and a sell that doesn't is a trap, not
 * a feature.
 *
 * THIS LIST GOES STALE, AND THAT USED TO COST PEOPLE MONEY. It last read
 * QQQ/NVDA/TSLA (checked 2026-07-16); eleven days later AAPL, AMZN, GOOGL,
 * MSFT, MU, SPCX, USAR, SGOV, SLV, SPY and USO all had live pools. Meanwhile
 * /settings offered every registry symbol as a basket option and approving USDG
 * is generic, so an owner could pick AAPL, watch the agent buy it, and never be
 * able to sell — the exit reverted at the wall, silently, until they tried.
 *
 * Widening the list fixes today. What stops it recurring is the runtime rule in
 * worker/src/policy.ts: a BUY is refused unless the signed key can sell that
 * token back. Never enter a position you cannot exit — so the next pool seeded
 * on this chain is a missed opportunity, never a trapped position.
 *
 * Re-verify with `npx tsx scripts/probe-tradability.mts` and extend as pools
 * appear. Tokens still absent (BABA, BE, COIN, CRCL, CRWV, INTC, META, ORCL,
 * PLTR, SNDK) have no v3 pool at all, so they no-route on both sides — visibly
 * skipped, never held.
 */
export const TRADEABLE_SYMBOLS = [
  "AAPL", "AMZN", "GOOGL", "MSFT", "MU", "NVDA", "SPCX", "TSLA", "USAR",
  "QQQ", "SGOV", "SLV", "SPY", "USO",
] as const;

/**
 * What grants issued BEFORE 2026-07-27 baked into their call policy.
 *
 * The tradable set is sealed into a signed session key, so widening the list
 * above does nothing for a key that was already signed — and assuming otherwise
 * is precisely the trap this release fixes. A grant declares which set it
 * carries via the "tradeable-v2" entry in grantFeatures; without it, this is the
 * set, and the worker says so instead of letting a sell revert at the wall.
 */
export const LEGACY_TRADEABLE_SYMBOLS = ["QQQ", "NVDA", "TSLA"] as const;

/**
 * What a FRESH agent buys out of the box — deliberately not the whole tradable
 * set. These are two different questions and coupling them was a shortcut: the
 * allowlist should cover everything with an exit, while the default basket stays
 * a handful of the deepest names rather than spreading a first deposit across
 * fourteen legs. Owners widen it themselves in /settings.
 */
export const DEFAULT_BASKET_SYMBOLS = ["QQQ", "NVDA", "TSLA"] as const;

/** Minimal Stock ABI — the surface merrymen reads. Extracted from verified source 2026-07-09. */
export const STOCK_ABI = [
  // Standard ERC-20 reads
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  // ERC-8056 Scaled UI Amount
  { type: "function", name: "uiMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "newUIMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "effectiveAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOfUI", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalSupplyUI", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  // Pause state — agents must check before trading
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "tokenPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "oraclePaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  // Events
  { type: "event", name: "Transfer", inputs: [{ name: "from", type: "address", indexed: true }, { name: "to", type: "address", indexed: true }, { name: "value", type: "uint256", indexed: false }] },
  { type: "event", name: "UIMultiplierUpdated", inputs: [{ name: "oldMultiplier", type: "uint256", indexed: false }, { name: "newMultiplier", type: "uint256", indexed: false }, { name: "effectiveAtTimestamp", type: "uint256", indexed: false }] },
] as const;

/**
 * Short provenance tag for a price, for anywhere a human or a model reads one.
 *
 * Exists because the display sites all used to ask `source === "pool"` with an
 * implicit else meaning "Chainlink-grade". That is fine while there are two
 * sources and silently wrong the moment there are four: a bonding-curve mark
 * would have rendered with the feed's colour, no tag, and — worst of the three
 * — no marker in the ledger string handed to the strategist, which would then
 * narrate an unoracled number as if a feed had published it.
 *
 * Chainlink returns "" because it is the baseline every other source is being
 * distinguished FROM; tagging it would put a label on every row and so label
 * nothing.
 */
export function priceSourceTag(source: string): string {
  switch (source) {
    case "pool":
      return "pool px";
    case "broker":
      return "broker px";
    case "curve":
      // Deliberately not "pool px". A curve price passed no divergence band and
      // has no oracle behind it; showing it as a pool price would overstate
      // what is known about it.
      return "curve px";
    default:
      return "";
  }
}

/**
 * One sentence explaining what a price source's tag means.
 *
 * Kept beside `priceSourceTag` so a tag can never be shown with the wrong
 * explanation. That is not hypothetical: widening a `=== "pool"` test to
 * `!== "chainlink"` without touching the label showed a bonding-curve mark as
 * "pool px" under a tooltip asserting it had passed depth AND divergence
 * checks — two guards that cannot even run on a curve.
 */
export function priceSourceNote(source: string): string {
  switch (source) {
    case "pool":
      return "pool px = a Uniswap time-averaged price, not a Chainlink feed — it passed the depth and divergence checks, but it's a thinner claim.";
    case "broker":
      return "broker px = the venue's own last-trade print, not a Chainlink feed.";
    case "curve":
      return "curve px = read straight off a bonding curve. There is no oracle behind it and no divergence check — the reserves are the entire market, so one trade can move it a long way.";
    default:
      return "";
  }
}

/**
 * The four research desks Brain can run. Merrymen decides this, never the model.
 *
 * A desk is a set of analyst lenses: an equity has earnings, a memecoin has
 * liquidity and a crowd. Running a fundamentals analyst on a memecoin produces
 * confident text about nothing, which is worse than no analyst at all — it
 * arrives looking like evidence.
 */
export type InstrumentClass = "equity-token" | "crypto-native" | "memecoin" | "stablecoin";

/**
 * Which desk this token gets, from what the token actually IS.
 *
 * THE RULE IS THE TABLE. `STOCK_TOKENS` is the issuer-backed set: Chainlink
 * feeds, ERC-8056 multipliers, and a price that updates 24/5 because the
 * underlying market is open 24/5. Anything else on this chain arrived from
 * discovery — no feed, no multiplier, priced from a DEX pool, and trading
 * around the clock. That distinction is not a taxonomy preference; it decides
 * whether "the price is stale" means "the market is shut" or "something is
 * wrong".
 *
 * WHY ADDRESS AND NOT SYMBOL. A discovered token may call itself AAPL. The
 * address is the identity, and matching on the name would let a launchpad token
 * pick its own research desk.
 *
 * Unknown address ⇒ `memecoin`, which is the CAUTIOUS arm rather than the
 * lenient one: it routes to liquidity and on-chain lenses and away from
 * fundamentals, which is the right treatment for something nobody has verified.
 */
export function instrumentClassOf(address: string): InstrumentClass {
  const a = address.trim().toLowerCase();
  const known = STOCK_TOKENS.find((t) => t.address.toLowerCase() === a);
  if (!known) return "memecoin";
  switch (known.kind) {
    case "stock":
    case "etf":
      return "equity-token";
    case "memecoin":
      return "memecoin";
  }
}

/**
 * Does this instrument's price come from a market that closes?
 *
 * A tokenised equity tracks a 24/5 Chainlink feed, so outside US market hours
 * its price is legitimately hours old and `staleFeeds` says so. A pool-priced
 * token trades continuously and a stale reading there means the POOL stopped
 * being readable — a fault, not a weekend.
 *
 * The same flag, two entirely different facts. Anything reasoning about
 * staleness has to know which one it is looking at.
 */
export function tradesAroundTheClock(address: string): boolean {
  return instrumentClassOf(address) !== "equity-token";
}
