/**
 * A COIN POSTED IN A TELEGRAM GROUP, SEEN FROM THE TRADING SIDE.
 *
 * The contract is docs/tg-groups.md ("The coin flow", "Nomination caps"). The
 * chat side (telegram/tg-groups/) never imports anything that trades; it holds
 * a `TgCoinsPort`, and this file is what index.ts builds that port from:
 *
 *   - `createCoinLook` — the quick look (step 4): what kind of address was
 *     posted, cheapest reads first (is it on Robinhood Chain at all, before
 *     GeckoTerminal is asked), cached, and rate-capped so a busy group cannot
 *     spend the process's RPC governor or the fleet's GeckoTerminal quota;
 *   - `createTgCoinsPort` — the port object itself, whose every method is safe
 *     to call at any time and never throws;
 *   - three small rules the trencher tick applies at its own seams (the group
 *     entry claim, what a review of a nominated coin reports, and which sale is
 *     an exit worth one line), kept here so a test can run them.
 *
 * NOTHING HERE CAN MAKE A TRADE HAPPEN. The look reads; the port hands a
 * validated address to the nomination book; the entry claim can only REFUSE an
 * entry. The Brain still decides, the trencher entry path still sizes, and
 * checkPolicy and the TrencherVault still bound every buy exactly as before.
 *
 * NAMING: the web room's name never appears in code here (see
 * worker/src/groupchat/boundary.test.ts). This is "Telegram groups".
 */
import { parseAbi, type PublicClient } from "viem";
import { CASH, STOCK_TOKENS, UNISWAP, isEnergyReserveToken } from "../../packages/core/src/index";
import type { BrainDecision } from "./brain-client";
import { coinDisplayName } from "./coin-name";
import { PONS_CURVE_DEX } from "./discovery";
import { TRENCHER_FAST, shouldEnter, type Candidate } from "./strategies/trencher";
import { highVolumePools } from "./trencher-brain";
import { isCaAddress, type EntryClaim, type NominationBook, type ReviewedDecision } from "./trencher-nominate";
import type { GeckoPool } from "./venues/geckoterminal";
import { aggregate3, parseTokenMeta } from "./venues/pons-meta";
import type {
  CoinKind,
  CoinLook,
  CoinOutcome,
  NominateResult,
  Nomination,
  TgCoinsPort,
  TrencherReadiness,
} from "./telegram/tg-groups/types";

const MIN = 60_000;

/** The look's clocks and bounds. */
export const COIN_LOOK = {
  /** A definite answer about an address is reused this long (the contract's 30 min). */
  cacheMs: 30 * MIN,
  /**
   * Full looks, per process, per rolling window: the ones that read
   * GeckoTerminal and the chain probe, for an address the presence probe
   * found code at. Beyond it the answer is `unknown`. Six in ten minutes is a
   * busy group's worth of fresh coins, and at most ~6 GeckoTerminal slots and
   * ~6 batched RPC requests against a governor the stop-loss tick shares — a
   * price worth paying for chatter, and no more. A chart link is two looks
   * (the pool, then the coin it trades), and the pool's costs one read more
   * (the factory's getPool).
   */
  maxUncached: 6,
  /**
   * Presence probes, per process, per rolling window, counted apart from the
   * full looks: ONE getCode on Robinhood Chain, before anything else is read.
   * An address posted from Ethereum, BNB or Base has no code here and is
   * answered `wallet` by it alone, so a chat full of other chains' CAs spends
   * these and never the six full looks a real Robinhood coin needs. Thirty in
   * ten minutes is one single-request read every twenty seconds; beyond it
   * the answer is `unknown`.
   */
  maxProbes: 30,
  windowMs: 10 * MIN,
  /** Addresses remembered at once; the oldest answer goes first. */
  cacheMax: 500,
  /**
   * One chain read is given this long: the presence probe's getCode, the
   * probe's multicall, the canonical factory's getPool, the local ledger's
   * curve lookup. Past it the read FAILED — never "no code", never "no
   * pool" — and the look goes on without it. The governed client can decline,
   * the provider can rate-limit, and a transport can retry for most of a
   * minute; without a bound, a read that never answered was a promise every
   * later look at that address joined (the in-flight map), forever.
   */
  readMs: 4_000,
  /**
   * GeckoTerminal's token page is given this long, its turn at the fleet's
   * shared request slot included (venues/fleet-feed-cache.ts). A presence
   * probe that timed out plus this still fits inside the chat side's bound on
   * the whole look (tg-groups/coins.ts COIN_FLOW.lookMs, 10 s).
   */
  poolsMs: 5_000,
} as const;

/** What `within` answers when the wait ran out first. */
const TIMED_OUT: unique symbol = Symbol("timed out");

/**
 * `f()`, or TIMED_OUT once `ms` have passed, whichever comes first. A reader
 * that throws before it returns a promise rejects like one that rejects. The
 * timer never keeps the process up and is cleared as soon as the read settles.
 */
function within<T>(f: () => Promise<T> | T, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise<T | typeof TIMED_OUT>((resolve, reject) => {
    let read: Promise<T>;
    try {
      read = Promise.resolve(f());
    } catch (e) {
      reject(e);
      return;
    }
    const t = setTimeout(() => resolve(TIMED_OUT), ms);
    t.unref?.();
    read.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const DEX_V3 = "uniswap-v3-robinhood";
const ZERO_ADDRESS = "0x" + "0".repeat(40);

/** What one multicall says an address with code is. */
export interface TokenProbe {
  /** Answers the Pons template's metadata getter (venues/pons-meta.ts). */
  pons: boolean;
  /** Answers `decimals()` with a uint8 — an ERC-20, or something shaped like one. */
  erc20: boolean;
  /**
   * Answers `token0()`, `token1()` and `fee()` the way a Uniswap v3 pool does:
   * its two tokens, lowercased, and `canonical`, the pool the CANONICAL v3
   * factory (UNISWAP.v3Factory) names for those two tokens at that fee,
   * lowercased — null when that read failed. Absent when the address is not
   * shaped like a pool.
   */
  pool?: { token0: string; token1: string; canonical: string | null };
}

/**
 * The readers a look is built from, injected so every branch is testable and
 * so the look itself owns no client, no ledger and no clock.
 */
export interface CoinLookReaders {
  /** This agent's own money: `bookAddresses` of the active grant (account + vaults). Read on every look. */
  own: () => readonly string[];
  /** The memecoin currently held at this address, with its display name when known; null when not held. */
  held: (address: string) => { name?: string | null } | null;
  /** GeckoTerminal's token-pools page (venues/geckoterminal.ts readTokenPools). null = could not be read. */
  tokenPools: (address: string) => Promise<GeckoPool[] | null>;
  /**
   * eth_getCode on Robinhood Chain (index.ts: the governed mainnet client).
   * undefined or "0x" = no code. A rejection is a failed read, never "no code".
   */
  getCode: (address: `0x${string}`) => Promise<string | undefined>;
  /** One multicall: Pons template + ERC-20 shape. null = the batch could not be read. */
  probe: (address: `0x${string}`) => Promise<TokenProbe | null>;
  /** Pons curve provenance from the local ledger (0 RPC). A rejection counts as "not known here". */
  curveFor?: (address: string) => Promise<unknown>;
  now?: () => number;
}

/** The address-derived id discovery gives a coin (trencher-discovery.ts), used only to reject it as a name. */
const addressSymbol = (address: string) => `T${address.slice(-11).toUpperCase()}`;

/**
 * Names a memecoin may not be called in a group: a launchpad coin calling
 * itself TSLA or USDG is exactly the impersonation the address-first identity
 * exists to defeat, and a bot that says "tsla" about it misleads the room.
 * Such a coin is "this one".
 */
const TRUSTED_NAMES = new Set(
  [...STOCK_TOKENS.map((t) => t.symbol), "USDG", "WETH", "ETH", "MERRYMEN"].map((s) => s.toUpperCase()),
);

function displayName(address: string, pools: readonly GeckoPool[]): string | undefined {
  for (const p of pools) {
    const n = coinDisplayName({ symbol: addressSymbol(address), name: p.name, kind: "memecoin" });
    if (n && !TRUSTED_NAMES.has(n.toUpperCase())) return n;
  }
  return undefined;
}

const UNKNOWN: CoinLook = Object.freeze({ kind: "unknown" });
/** The presence probe's "the chain could not be asked" (step 3b): not an answer about the address. */
const UNREAD: unique symbol = Symbol("unread");
const NOT_TOKEN: CoinLook = Object.freeze({ kind: "not-token" });
const WALLET: CoinLook = Object.freeze({ kind: "wallet" });

/** The quote side a pool must have to be a coin's pool — discovery's own rule (trencher-discovery.ts). */
const CASH_SIDES: ReadonlySet<string> = new Set([CASH.USDG.toLowerCase(), CASH.WETH.toLowerCase()]);

/**
 * THE QUICK LOOK — `(address) => CoinLook`, cheapest first, every read bounded
 * (COIN_LOOK.readMs, COIN_LOOK.poolsMs) so a look always settles.
 *
 * 1. FREE: its own wallet or vault, cash, the energy reserve, a stock token,
 *    a coin it already holds. Answered every time, never cached, so a coin
 *    bought since the last look is `held` and not a stale `candidate`.
 * 2. CACHED: a definite answer from the last 30 minutes.
 * 3. ON ROBINHOOD CHAIN AT ALL? ONE getCode on Robinhood Chain, before any
 *    GeckoTerminal request, under its own allowance (COIN_LOOK.maxProbes;
 *    past it, `unknown`). No code → `wallet`, cached like any definite
 *    answer: a Robinhood wallet, or a token that lives on Ethereum, BNB or
 *    Base (the same 0x + 40 hex, and nothing deployed at it here). That is
 *    the whole look for such an address, so other chains' CAs never spend
 *    the full looks below. Code found is remembered for the cache's 30
 *    minutes, so a coin refused a full look is not probed again.
 * 3b. THE CHAIN COULD NOT BE ASKED. A getCode that failed — declined by the
 *    governor, rate-limited by the provider, timed out (COIN_LOOK.readMs) —
 *    is not "no code". Then GeckoTerminal's Robinhood token page stands in as
 *    the presence signal, under the full-look allowance: pools listed there
 *    for this address make it a Robinhood Chain coin, classified from those
 *    pools exactly as in step 5; no pools there, or the page unreadable too,
 *    is `unknown` (a wallet, another chain's token and a coin nobody has
 *    traded yet all look alike to the index). Nothing is relaxed by it: a
 *    `candidate` from here is still only a nomination, and discovery still
 *    verifies its pool on chain before anything can be bought.
 * 4. RATE-CAPPED: past the full-look allowance the answer is `unknown`.
 * 5. GeckoTerminal's page for the token. When pools are known they decide:
 *    a Pons curve pool → `curve`; only 32-byte pool ids → `v4-only`; no
 *    Uniswap v3 pool at all → `no-pool`; a v3 pool that fails
 *    `highVolumePools` → `too-quiet`; fails `shouldEnter(TRENCHER_FAST)` on
 *    depth or size → `too-thin`, on age → `too-new`; else `candidate`.
 * 6. No pool known: local curve provenance, then ONE multicall probe: a Pons
 *    template → `curve`; an ERC-20 → `no-pool`; a Uniswap v3 pool → step 7;
 *    anything else → `not-token`.
 * 7. A CHART LINK CARRIES THE POOL. A GeckoTerminal `/pools/…` or DexScreener
 *    pair link is how most coins get posted, and the only address in it is
 *    the pool's. The index has no token page for a pool, so it lands here.
 *    It is looked at as the coin it trades only when that is PROVEN on chain:
 *    exactly one side is USDG or WETH, and the canonical v3 factory's
 *    `getPool(token0, token1, fee)` is this very address. Then the answer is
 *    the look at the OTHER token, carrying that token's `address` so the chat
 *    side remembers and nominates the coin, never the pool. A pool of two
 *    coins, or one the factory does not name, stays `not-token`; a factory
 *    read that failed is `unknown`. The index's labels never resolve
 *    anything: the address is the identity, and a label is a claim about it.
 *    The coin's look is a look of its own — the free checks, its own cache,
 *    its own presence probe and its own slot of the allowance — and a pool
 *    is remembered only as WHICH coin it trades, so a coin bought since is
 *    `held` through its chart link too.
 *
 * UNREADABLE IS NOT ABSENT. A page, a getCode or a probe that could not be
 * read (or did not answer in time) is `unknown` — never `wallet` (viem's
 * undefined-for-no-code conflation, recover.ts) and never `no-pool` — and
 * `unknown` is not cached, so the next look can succeed. The one read that
 * can stand in for another is the index page for a failed getCode (3b),
 * because pools on Robinhood Chain's own page are a positive signal; nothing
 * ever reads a failure as an absence.
 *
 * `wallet`, `not-token` and `unknown` are the answers that do not show a
 * Robinhood Chain coin; the chat side says nothing about them (coins.ts).
 *
 * `candidate` IS A PRE-SCREEN, NOT A VERDICT. The depth tested here is the
 * index's pool reserve, which is at least the on-chain route depth the tick
 * enters on (the route's shallowest leg is part of it): a coin this refuses as
 * thin would be refused by the tick too, and one it passes still has to pass
 * discovery's on-chain verification, the tick's pool-grade price and depth,
 * `shouldEnter`, a fresh Brain BUY and the wall.
 */
export function createCoinLook(d: CoinLookReaders): (address: string) => Promise<CoinLook> {
  const now = d.now ?? Date.now;
  const cache = new Map<string, { look: CoinLook; at: number }>();
  const pending = new Map<string, Promise<CoinLook>>();
  /** Addresses the presence probe found code at, and when (step 3). */
  const present = new Map<string, number>();
  let started: number[] = [];
  let probed: number[] = [];

  const free = (a: string): CoinLook | null => {
    if (d.own().some((x) => typeof x === "string" && x.toLowerCase() === a)) return { kind: "own" };
    if (a === CASH.USDG.toLowerCase()) return { kind: "cash", name: "USDG" };
    if (a === CASH.WETH.toLowerCase()) return { kind: "cash", name: "WETH" };
    if (isEnergyReserveToken(a)) return { kind: "energy" };
    const stock = STOCK_TOKENS.find((t) => t.address.toLowerCase() === a);
    if (stock) return { kind: "stock", name: stock.symbol };
    const held = d.held(a);
    if (held) {
      const name = typeof held.name === "string" && held.name && !TRUSTED_NAMES.has(held.name.toUpperCase()) ? held.name : null;
      return name ? { kind: "held", name } : { kind: "held" };
    }
    return null;
  };

  /**
   * The coin's look, as the answer about the pool that trades it. One level
   * only: a coin that is itself resolved to something else is not a coin.
   */
  const asToken = (token: string, l: CoinLook): CoinLook => {
    if (l.kind === "unknown") return UNKNOWN;
    if (l.address !== undefined) return NOT_TOKEN;
    return { ...l, address: token };
  };

  /** Step 7: the coin a canonical v3 pool against USDG or WETH trades, looked at in its place. */
  const poolLook = async (a: string, p: NonNullable<TokenProbe["pool"]>): Promise<CoinLook> => {
    const t0 = typeof p.token0 === "string" ? p.token0.toLowerCase() : "";
    const t1 = typeof p.token1 === "string" ? p.token1.toLowerCase() : "";
    const cash0 = CASH_SIDES.has(t0);
    // Exactly one cash side: two coins, or USDG against WETH, is not a coin's pool.
    if (cash0 === CASH_SIDES.has(t1)) return NOT_TOKEN;
    const token = cash0 ? t1 : t0;
    if (!isCaAddress(token) || token === ZERO_ADDRESS || token === a) return NOT_TOKEN;
    // Provenance: a contract answering token0/token1/fee proves nothing by
    // itself, anyone can deploy one. The canonical factory naming THIS address
    // for that pair and fee is what makes it that coin's pool.
    if (typeof p.canonical !== "string") return UNKNOWN;
    if (p.canonical.toLowerCase() !== a) return NOT_TOKEN;
    return asToken(token, await lookAt(token, 1));
  };

  /** The full-look allowance (COIN_LOOK.maxUncached): one slot, or false when it is spent. */
  const takeFullLook = (): boolean => {
    const t = now();
    started = started.filter((s) => t - s < COIN_LOOK.windowMs);
    if (started.length >= COIN_LOOK.maxUncached) return false;
    started.push(t);
    return true;
  };

  /** GeckoTerminal's page for this token, bounded: this token's own pools, or null when it could not be read in time. */
  const poolsOf = async (a: string): Promise<GeckoPool[] | null> => {
    try {
      const pools = await within(() => d.tokenPools(a), COIN_LOOK.poolsMs);
      if (pools === TIMED_OUT || !Array.isArray(pools)) return null;
      return pools.filter((p) => p.tokenAddress.toLowerCase() === a);
    } catch {
      return null;
    }
  };

  /**
   * Step 3: is anything deployed at this address on Robinhood Chain? `wallet`
   * when not, null when it is (go on to the full look), `unknown` when the
   * probe allowance is spent, UNREAD when the chain could not be asked (the
   * read failed or timed out: step 3b). Synchronous up to its one read, so
   * two looks begun together cannot both pass the allowance.
   */
  const presence = async (a: `0x${string}`): Promise<CoinLook | typeof UNREAD | null> => {
    const t = now();
    const seen = present.get(a);
    if (seen !== undefined && t - seen < COIN_LOOK.cacheMs) return null;
    if (seen !== undefined) present.delete(a);
    probed = probed.filter((s) => t - s < COIN_LOOK.windowMs);
    if (probed.length >= COIN_LOOK.maxProbes) return UNKNOWN;
    probed.push(t);
    let code: string | undefined | typeof TIMED_OUT;
    try {
      code = await within(() => d.getCode(a), COIN_LOOK.readMs);
    } catch {
      return UNREAD;
    }
    if (code === TIMED_OUT) return UNREAD;
    if (typeof code !== "string" || code === "0x" || code === "") return WALLET;
    if (present.size >= COIN_LOOK.cacheMax) present.delete(present.keys().next().value!);
    present.set(a, now());
    return null;
  };

  /**
   * Step 3b: the chain could not be asked whether anything is deployed here.
   * GeckoTerminal's Robinhood page is asked instead, under the full-look
   * allowance: this token's pools there make it a Robinhood Chain coin, read
   * like any (classifyPools); no pools, or no page, is `unknown`. The multicall
   * probe is not tried: the chain it reads is the one that just failed.
   */
  const indexOnly = async (a: string): Promise<CoinLook> => {
    if (!takeFullLook()) return UNKNOWN;
    const mine = await poolsOf(a);
    if (mine === null || mine.length === 0) return UNKNOWN;
    return classifyPools(a, mine, Math.floor(now() / 1000));
  };

  /** Steps 4–7, for an address with code on Robinhood Chain. */
  const read = async (a: `0x${string}`, depth: number): Promise<CoinLook> => {
    if (!takeFullLook()) return UNKNOWN;
    const mine = await poolsOf(a);
    if (mine === null) return UNKNOWN;
    if (mine.length > 0) return classifyPools(a, mine, Math.floor(now() / 1000));
    if (d.curveFor) {
      // A ledger that cannot be read, or not in time, is "not known here".
      const curve = await within(() => d.curveFor!(a), COIN_LOOK.readMs).catch(() => null);
      if (curve !== TIMED_OUT && curve) return { kind: "curve" };
    }
    // A multicall and, for a pool-shaped answer, the factory's one more read.
    const probe = await within(() => d.probe(a), 2 * COIN_LOOK.readMs).catch(() => null);
    if (probe === null || probe === TIMED_OUT) return UNKNOWN;
    if (probe.pons) return { kind: "curve" };
    if (probe.erc20) return { kind: "no-pool" };
    if (depth === 0 && probe.pool) return poolLook(a, probe.pool);
    return NOT_TOKEN;
  };

  /** Steps 1–7 for one lowercased, well-formed address. `depth` 1 is a pool's coin, which never resolves again. */
  const lookAt = async (a: string, depth: number): Promise<CoinLook> => {
    const quick = free(a);
    if (quick) return quick;
    const t = now();
    const hit = cache.get(a);
    if (hit && t - hit.at < COIN_LOOK.cacheMs) {
      // A pool is remembered as the coin it trades, and that coin is looked
      // at afresh: free checks first, then its own cache.
      const token = hit.look.address;
      if (token === undefined) return hit.look;
      return depth === 0 ? asToken(token, await lookAt(token, 1)) : NOT_TOKEN;
    }
    if (hit) cache.delete(a);
    const joining = pending.get(a);
    if (joining) return await joining;
    const addr = a as `0x${string}`;
    const job = presence(addr)
      .then((p) => (p === UNREAD ? indexOnly(a) : (p ?? read(addr, depth))))
      .catch(() => UNKNOWN)
      .then((look) => {
        if (look.kind !== "unknown") {
          if (cache.size >= COIN_LOOK.cacheMax) cache.delete(cache.keys().next().value!);
          cache.set(a, { look, at: now() });
        }
        return look;
      })
      .finally(() => pending.delete(a));
    pending.set(a, job);
    return await job;
  };

  return async (address: string): Promise<CoinLook> => {
    try {
      const a = typeof address === "string" ? address.toLowerCase() : "";
      if (!isCaAddress(a) || a === ZERO_ADDRESS) return UNKNOWN;
      return await lookAt(a, 0);
    } catch {
      return UNKNOWN;
    }
  };
}

function classifyPools(a: string, mine: readonly GeckoPool[], nowSec: number): CoinLook {
  const name = displayName(a, mine);
  const as = (kind: CoinKind): CoinLook => (name ? { kind, name } : { kind });
  // Trencher v1 buys through a Uniswap v3 pool CONTRACT and nothing else
  // (venues/trencher-vault.ts refuses v4 routes), so that is what is looked for.
  const v3 = mine.filter((p) => p.dex === DEX_V3 && p.poolAddress !== null);
  if (v3.length === 0) {
    if (mine.some((p) => p.dex === PONS_CURVE_DEX)) return as("curve");
    if (mine.every((p) => p.poolAddress === null)) return as("v4-only");
    return as("no-pool");
  }
  const busy = highVolumePools(v3);
  if (busy.length === 0) return as("too-quiet");
  const best = busy[0]!;
  // A figure the index left out is a look that could not be made, not a pass.
  if (best.reserveUsd === null || best.fdvUsd === null || best.createdAt === null || best.createdAt > nowSec) return UNKNOWN;
  const c: Candidate = {
    symbol: addressSymbol(a),
    token: a as `0x${string}`,
    decimals: 18,
    // Priceability is the tick's question (pool-grade, on chain), not this one's.
    priceable: true,
    liquidityUsd: best.reserveUsd,
    fdvUsd: best.fdvUsd,
    ageSec: nowSec - best.createdAt,
    price8: 1n,
  };
  if (shouldEnter(c, TRENCHER_FAST, nowSec).enter) return as("candidate");
  // Named by WHICH bound refused, in shouldEnter's own order; the prose it
  // returns carries dollar figures and is never repeated.
  if (c.liquidityUsd < TRENCHER_FAST.minLiquidityUsd || c.fdvUsd < TRENCHER_FAST.minFdvUsd) return as("too-thin");
  if (c.ageSec < TRENCHER_FAST.minAgeSec) return as("too-new");
  return UNKNOWN;
}

/** Pons template metadata getter — the selector venues/pons-meta.ts reads. */
const PONS_METADATA_SELECTOR = "0xabb1dc44" as const;
/** ERC-20 `decimals()`. */
const DECIMALS_SELECTOR = "0x313ce567" as const;
/** Uniswap v3 pool `token0()`, `token1()`, `fee()`. */
const TOKEN0_SELECTOR = "0x0dfe1681" as const;
const TOKEN1_SELECTOR = "0xd21220a7" as const;
const FEE_SELECTOR = "0xddca3f43" as const;

const V3_FACTORY_ABI = parseAbi(["function getPool(address a,address b,uint24 fee) view returns (address)"]);

type SubCall = { success: boolean; returnData: `0x${string}` } | undefined;

/** One ABI word, when the sub-call answered exactly one. */
function word(r: SubCall): bigint | null {
  if (!r?.success || !/^0x[0-9a-f]{64}$/i.test(r.returnData)) return null;
  try {
    return BigInt(r.returnData);
  } catch {
    return null;
  }
}

/** An `address` return: one word with nothing above its low 20 bytes, and not zero. */
function wordAddress(r: SubCall): `0x${string}` | null {
  const w = word(r);
  if (w === null || w === 0n || w >> 160n !== 0n) return null;
  return `0x${w.toString(16).padStart(40, "0")}`;
}

/**
 * The probe `createCoinLook` wants, over the chain: ONE Multicall3 aggregate3
 * with five sub-calls, so "is it a Pons coin", "is it a token at all" and "is
 * it a Uniswap v3 pool" cost one eth_call. aggregate3 returns [] when the
 * batch itself failed, which is the one answer that means "could not read" — a
 * sub-call that reverts is an ordinary "no".
 *
 * Only for an address that answered like a pool, ONE more read: what the
 * canonical v3 factory (UNISWAP.v3Factory, the factory trencher-vault.ts pins)
 * says the pool for those two tokens at that fee is. That read failing is
 * `canonical: null` — unknown to the look, never "not that coin's pool".
 *
 * Each read is bounded (COIN_LOOK.readMs): a batch that does not answer in
 * time is null, a factory read that does not is `canonical: null`.
 */
export function chainTokenProbe(client: PublicClient): (address: `0x${string}`) => Promise<TokenProbe | null> {
  return async (address) => {
    const batch = await within(
      () =>
        aggregate3(client, [
          { target: address, callData: PONS_METADATA_SELECTOR },
          { target: address, callData: DECIMALS_SELECTOR },
          { target: address, callData: TOKEN0_SELECTOR },
          { target: address, callData: TOKEN1_SELECTOR },
          { target: address, callData: FEE_SELECTOR },
        ]),
      COIN_LOOK.readMs,
    );
    // No answer in time is a batch that could not be read.
    if (batch === TIMED_OUT) return null;
    const r = batch;
    if (r.length !== 5) return null;
    const pons = !!r[0]?.success && parseTokenMeta(address, r[0].returnData) !== null;
    const dec = word(r[1]);
    const erc20 = dec !== null && dec <= 255n;
    const token0 = wordAddress(r[2]);
    const token1 = wordAddress(r[3]);
    const fee = word(r[4]);
    if (token0 === null || token1 === null || fee === null || fee > 0xffffffn) return { pons, erc20 };
    let canonical: string | null = null;
    try {
      const got: unknown = await within(
        () =>
          client.readContract({
            address: UNISWAP.v3Factory as `0x${string}`,
            abi: V3_FACTORY_ABI,
            functionName: "getPool",
            args: [token0, token1, Number(fee)],
          }),
        COIN_LOOK.readMs,
      );
      // Not in time is a read that failed: unknown to the look, never "not that coin's pool".
      canonical = typeof got === "string" && /^0x[0-9a-f]{40}$/i.test(got) ? got.toLowerCase() : null;
    } catch {
      canonical = null;
    }
    return { pons, erc20, pool: { token0, token1, canonical } };
  };
}

// ─── The port ───────────────────────────────────────────────────────────────

export interface TgCoinsPortDeps {
  readiness: () => TrencherReadiness;
  look: (address: string) => Promise<CoinLook>;
  book: Pick<NominationBook, "nominate">;
  /** Told the lowercased address after an accepted nomination (its tape page). Its errors are swallowed. */
  onNominated?: (address: string) => void;
  heldNames: () => readonly string[];
  paper: () => boolean;
  log?: (line: string) => void;
}

/** The port, plus the one thing only the trading side may do with it: deliver outcomes. */
export interface TgCoinsHub extends TgCoinsPort {
  emit(outcomes: CoinOutcome | readonly CoinOutcome[] | null | undefined): void;
}

const READINESS_UNREADABLE: TrencherReadiness = {
  kind: "off",
  ownerReason: "I couldn't check my Trencher settings just now, so I left that coin alone. I'll check again with the next one.",
};

/**
 * THE PORT index.ts HANDS TO startTelegram — every method safe at any time.
 *
 * A method that fails answers the way that does nothing: readiness `off`, a
 * look `unknown`, a nomination refused `invalid`, no held names, and `paper`
 * for the mode — a group told a practice trade was real is the mistake that
 * must not happen, so an unreadable mode never claims real money.
 *
 * `emit` never throws either: a subscriber that throws is skipped and the
 * others still hear the outcome, because one broken chat handler must not
 * cost another chat its answer, and the trading tick that emits must never
 * see a chat's error.
 */
export function createTgCoinsPort(d: TgCoinsPortDeps): TgCoinsHub {
  const listeners = new Set<(o: CoinOutcome) => void>();
  const readiness = (): TrencherReadiness => {
    try {
      const r = d.readiness();
      return r && typeof r.kind === "string" ? r : READINESS_UNREADABLE;
    } catch {
      return READINESS_UNREADABLE;
    }
  };
  return {
    readiness,
    look(address: string): Promise<CoinLook> {
      try {
        return d.look(address).catch(() => UNKNOWN);
      } catch {
        return Promise.resolve(UNKNOWN);
      }
    },
    nominate(n: Nomination): NominateResult {
      let r: NominateResult;
      try {
        r = d.book.nominate(n, readiness().kind);
      } catch {
        return { ok: false, reason: "invalid" };
      }
      if (r.ok) {
        try {
          d.onNominated?.(n.address.toLowerCase());
        } catch {
          // The nomination stands; its tape page arrives with the next refresh.
        }
      }
      return r;
    },
    onOutcome(cb: (o: CoinOutcome) => void): () => void {
      if (typeof cb !== "function") return () => {};
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    heldNames(): string[] {
      try {
        return [...d.heldNames()].filter((n) => typeof n === "string" && n.length > 0);
      } catch {
        return [];
      }
    },
    mode(): "paper" | "live" {
      try {
        return d.paper() === false ? "live" : "paper";
      } catch {
        return "paper";
      }
    },
    emit(outcomes) {
      const list = outcomes == null ? [] : Array.isArray(outcomes) ? outcomes : [outcomes as CoinOutcome];
      for (const o of list) {
        if (!o) continue;
        // The kind only: no address, no name, no chat — this line is the log.
        try {
          d.log?.(`[tg-groups] coin outcome: ${o.kind}`);
        } catch {
          // A log that throws is not a reason to lose the outcome.
        }
        for (const cb of [...listeners]) {
          try {
            cb(o);
          } catch {
            // One subscriber's failure is its own.
          }
        }
      }
    },
  };
}

// ─── The tick's seams ─────────────────────────────────────────────────────

/**
 * WHAT A BRAIN REVIEW TELLS THE NOMINATION BOOK.
 *
 * The decision's own action, with one correction: a BUY the portfolio gate
 * refused or downgraded can never become an order (brain-live.ts
 * orderFromDecision refuses it), so it is reported as the gate-forced hold it
 * is — `skipped`, never a take voiced as the agent's view, and never a buy
 * left waiting for a fill that cannot come.
 */
export function reviewedDecisionOf(d: Pick<BrainDecision, "action" | "decision_id" | "thesis" | "bull_case" | "bear_case" | "risks" | "hold_kind" | "gate_verdict">): ReviewedDecision {
  const gated = d.action === "buy" && (d.gate_verdict === "refuse" || d.gate_verdict === "downgrade-to-hold");
  return {
    action: gated ? "hold" : d.action,
    decisionId: d.decision_id,
    holdKind: gated ? "GATE_FORCED_HOLD" : d.hold_kind ?? null,
    thesis: d.thesis ?? null,
    bullCase: d.bull_case ?? null,
    bearCase: d.bear_case ?? null,
    risks: Array.isArray(d.risks) ? d.risks : null,
  };
}

export type GroupEntryClaim =
  | { group: false }
  | { group: true; address: string; ok: true }
  | { group: true; address: string; ok: false; why: "cap" | "resolved" };

/**
 * THE GROUP-ENTRY CAP, ASKED ONCE PER ENTRY — before the energy claim, before
 * ensureDecision, before anything is built.
 *
 * An entry is GROUP-SOURCED when the coin it buys is an unresolved nomination,
 * or when the Brain decision it carries came from a review of a coin that was
 * nominated at the time. Anything else is not this cap's business and gets
 * `{ group: false }`: every other gate applies to it exactly as before.
 *
 * A group-sourced entry must win a claim (3 per UTC day, NominationBook
 * claimEntry, written durably before it returns). Refused → that entry is
 * skipped and nothing else is. And an entry whose decision came from a
 * nominated review but whose nomination has since RESOLVED (its TTL ran out, a
 * reset) is refused too: there is no nomination left to claim against, and
 * letting it through uncounted is the one way this cap could be walked past.
 * Fail closed; the coin can still be bought later on its own tape merits.
 */
export function claimGroupEntry(
  book: Pick<NominationBook, "nominated" | "claimEntry">,
  intent: { kind: string; buyToken?: string; decisionId?: string },
  reviewedFor: (decisionId: string) => string | undefined,
): GroupEntryClaim {
  if (intent.kind !== "swap" || typeof intent.buyToken !== "string") return { group: false };
  const address = intent.buyToken.toLowerCase();
  let pendingNow = false;
  try {
    pendingNow = book.nominated(address) !== null;
  } catch {
    pendingNow = false;
  }
  const fromReview = typeof intent.decisionId === "string" && reviewedFor(intent.decisionId) === address;
  if (!pendingNow && !fromReview) return { group: false };
  if (!pendingNow) return { group: true, address, ok: false, why: "resolved" };
  let claim: EntryClaim | "failed" = "failed";
  try {
    claim = book.claimEntry(address);
  } catch {
    claim = "failed";
  }
  if (claim === "taken") return { group: true, address, ok: true };
  // Each book call reads the clock once, so the TTL can run out between
  // nominated() above and claimEntry(): the nomination resolved in between
  // and nothing was taken. That is the same fail-closed `resolved` — an ok
  // here would let the entry go uncounted, and its no-fill refund would give
  // back an older entry's claim.
  if (claim === "not-nominated") return { group: true, address, ok: false, why: "resolved" };
  return { group: true, address, ok: false, why: "cap" };
}

/**
 * Worker-written, figure-free notes on why a position was left, by the exit
 * rule's CODE (strategies/reasons.ts `trench-exit`). The rule's own sentence
 * carries percentages and is never used. Deliberately no direction words that
 * would read as a result ("up", "profit", "loss").
 */
const EXIT_NOTES: Record<string, string> = {
  unpriceable: "couldn't get a clean price on it anymore",
  drain: "the liquidity was leaving",
  stop: "it kept sliding",
  take: "it had its run",
  aged: "it ran out of steam",
};
const BRAIN_EXIT_NOTE = "the setup stopped looking good";

/**
 * IS THIS SALE AN EXIT — the whole position, not a trim?
 *
 * "Out of that one" after a partial sale would be a lie, so only two shapes
 * count: a mechanical trencher exit (`trench-exit`, which always sells the
 * whole position — strategies/trencher.ts exitSize with `forced`), or a sale
 * of at least everything the tick's book showed held for that token. Anything
 * else is silence. Returns the token and the notes for the one line.
 */
export function groupExitOf(
  intent: { kind: string; sellToken?: string; buyToken?: string; sellAmountRaw?: bigint },
  why: { code: string; cause?: unknown } | null | undefined,
  heldRaw: bigint | null | undefined,
): { address: string; notes: string[] } | null {
  if (intent.kind !== "swap" || typeof intent.sellToken !== "string" || typeof intent.buyToken !== "string") return null;
  const address = intent.sellToken.toLowerCase();
  if (address === CASH.USDG.toLowerCase() || address === CASH.WETH.toLowerCase()) return null;
  if (intent.buyToken.toLowerCase() !== CASH.USDG.toLowerCase()) return null;
  if (why?.code === "trench-exit") {
    const note = typeof why.cause === "string" && Object.hasOwn(EXIT_NOTES, why.cause) ? EXIT_NOTES[why.cause]! : BRAIN_EXIT_NOTE;
    return { address, notes: [note] };
  }
  if (typeof intent.sellAmountRaw === "bigint" && typeof heldRaw === "bigint" && heldRaw > 0n && intent.sellAmountRaw >= heldRaw) {
    return { address, notes: [BRAIN_EXIT_NOTE] };
  }
  return null;
}
