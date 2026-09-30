import { erc20Abi, parseAbi, type Address, type PublicClient } from "viem";
import { CASH, TRENCHER_VAULT_ABI, isEnergyReserveToken, type StockToken, type StoredGrant } from "../../packages/core/src/index";
import { highVolumePools } from "./trencher-brain";
import { NOMINATE } from "./trencher-nominate";
import { verifyTrencherCustody } from "./venues/trencher-vault";
import type { GeckoPool } from "./venues/geckoterminal";

const POOL = parseAbi(["function token0() view returns (address)","function token1() view returns (address)","function fee() view returns (uint24)"]);
const FACTORY = parseAbi(["function getPool(address a,address b,uint24 fee) view returns (address)"]);
/** The busiest verified pools a pass reads on chain. */
export const DISCOVERY_SLICE = 20;
/** Nominated pools verified beyond that slice, at most — the nomination book's own queue bound. */
export const NOMINATED_VERIFY_MAX = NOMINATE.queueMax;

export interface DiscoveryOptions {
  /**
   * Lowercased token addresses somebody nominated (a coin posted in a Telegram
   * group, docs/tg-groups.md) and the book still holds unresolved.
   *
   * WHAT IT CHANGES IS WHICH POOLS ARE CHECKED, NEVER HOW. A nominated coin is
   * usually far from the top of the volume ranking, so the top-slice alone
   * would never read it and the nomination could only ever expire. Its pool is
   * added to this pass's reads — after the slice, up to NOMINATED_VERIFY_MAX —
   * and then runs the loop every other pool runs: Uniswap v3 on this chain, a
   * USDG or WETH quote, the pool the canonical factory's `getPool` returns for
   * its own token0/token1/fee, the decimals bound, never the energy reserve.
   * And it must already be in `highVolumePools`' output to be considered at
   * all, so a quiet coin nominated by a chat is dropped by the same screen that
   * drops a quiet coin on the trending list.
   *
   * The set holds only addresses. The pool, the quote and the factory answer
   * all come from the tape and the chain, exactly as for every other pool:
   * the chat picks what to look at, never what counts as verified.
   */
  nominated?: ReadonlySet<string>;
  /**
   * What earlier passes in this process already proved about pools. Absent,
   * every pool is read from scratch — which is what every pass did before it
   * existed, and what the tests without one still pin.
   */
  cache?: TrencherPoolCache;
}

/** A v3 pool's pair and fee, as the pool itself reports them. */
export interface PoolFacts { token0: Address; token1: Address; fee: number }

/** How long a pool the chain definitively refused is left unread. */
export const POOL_REFUSAL_TTL_MS = 10 * 60_000;
/** Entries kept per map. The tape turns over; a process that runs for weeks must not grow without bound. */
export const POOL_CACHE_MAX = 4096;

/**
 * WHAT A PASS HAS ALREADY PROVED ABOUT A POOL, SO THE NEXT ONE DOES NOT ASK AGAIN.
 *
 * Every pass used to re-read token0, token1, fee and the factory's getPool for
 * all twenty pools in the slice: about 80 of the ~110 calls a pass made, once
 * a minute per trencher agent, measured at roughly a fifth of the whole fleet's
 * reads on 2026-09-27 — for answers that cannot change.
 *
 * WHY A VERIFIED POOL CAN BE REMEMBERED FOREVER. A pool the canonical Uniswap
 * v3 factory returns from `getPool(token0, token1, fee)` was created by that
 * factory: its pair and fee are constructor immutables in the pool's bytecode,
 * and the factory writes `getPool` once, in `createPool`, and never again. So
 * the uncached pass would read the same three values and get the same factory
 * answer every time. The cache holds exactly those facts — never a verdict —
 * and every check that depends on the TAPE (is the coin in this pair, is the
 * other side USDG or WETH) runs again on every pass against them.
 *
 * KEYED BY FACTORY AS WELL AS POOL. The canonical answer is a fact about one
 * factory. A pass reading a different factory shares nothing with this one.
 *
 * A REFUSAL IS NOT A VERIFICATION, and is never stored as one. A pool the chain
 * answered against — not a USDG/WETH pair, or not the pool the factory returns
 * — is left unread for POOL_REFUSAL_TTL_MS and then checked from scratch, so a
 * refusal can only ever cost a pool its place, never grant one. A pool whose
 * read FAILED is not remembered at all: an RPC error is not an answer.
 */
export class TrencherPoolCache {
  private readonly verifiedPools = new Map<string, PoolFacts>();
  private readonly refusedUntil = new Map<string, number>();
  constructor(private readonly opts: { now?: () => number; refusalTtlMs?: number; maxEntries?: number } = {}) {}

  private now(): number { return (this.opts.now ?? Date.now)(); }
  private static key(...parts: string[]): string { return parts.map(p => p.toLowerCase()).join(":"); }
  private bound<V>(m: Map<string, V>): void {
    const max = this.opts.maxEntries ?? POOL_CACHE_MAX;
    // Map iteration is insertion order: the first key is the oldest.
    while (m.size > max) m.delete(m.keys().next().value as string);
  }

  verified(factory: string, pool: string): PoolFacts | undefined {
    return this.verifiedPools.get(TrencherPoolCache.key(factory, pool));
  }
  rememberVerified(factory: string, pool: string, facts: PoolFacts): void {
    const k = TrencherPoolCache.key(factory, pool);
    this.refusedUntil.delete(TrencherPoolCache.key(factory, pool, facts.token0));
    this.refusedUntil.delete(TrencherPoolCache.key(factory, pool, facts.token1));
    this.verifiedPools.set(k, { ...facts });
    this.bound(this.verifiedPools);
  }
  /** Keyed by the coin the tape claimed too: a refusal is an answer to that exact question. */
  refused(factory: string, pool: string, token: string): boolean {
    const k = TrencherPoolCache.key(factory, pool, token);
    const until = this.refusedUntil.get(k);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.refusedUntil.delete(k);
    return false;
  }
  rememberRefused(factory: string, pool: string, token: string): void {
    const k = TrencherPoolCache.key(factory, pool, token);
    this.refusedUntil.delete(k); // re-insert at the back, so eviction stays oldest-first
    this.refusedUntil.set(k, this.now() + (this.opts.refusalTtlMs ?? POOL_REFUSAL_TTL_MS));
    this.bound(this.refusedUntil);
  }
  /** Entry counts, for tests. */
  size(): { verified: number; refused: number } {
    return { verified: this.verifiedPools.size, refused: this.refusedUntil.size };
  }
}

/** A bounded discovery pass. Feed text never chooses contract addresses or executable calldata. */
export async function discoverTrencherUniverse(client: PublicClient, grant: StoredGrant, pools: readonly GeckoPool[], opts: DiscoveryOptions = {}) {
  // CUSTODY IS VERIFIED ON EVERY PASS, deliberately NOT cached with the pools.
  //
  // It could be, on paper: the factory's cash/bridge/router/poolFactory are
  // immutables inside the bytecode the code-hash check pins, vaultFor is a
  // CREATE2 prediction, and the vault's owner and VERSION never change. What
  // decides it is the rest:
  //
  //  - `deployed` flips from false to true on the first buy, and it decides
  //    whether `tokens()` — the holdings read — happens at all. A remembered
  //    `false` would skip that read and hand back an empty book, the one
  //    outcome this pass must never produce.
  //  - It is the pass's authorization anchor. Re-reading it means a rotated or
  //    mis-set TRENCHER_FACTORY_CODE_HASH, or a replaced grant, stops discovery
  //    on the next pass instead of whenever a cache happens to be invalidated.
  //  - It is cheap. The six factory reads leave together as one batched request,
  //    then the vault's code, then owner+VERSION together: about nine calls in
  //    three requests. Caching it would save under 2% of the fleet's reads.
  //
  // Pools are the other ~80 calls, and they are the part that cannot change.
  const custody = await verifyTrencherCustody(client,grant);
  const factory = await client.readContract({address:custody.vault,abi:TRENCHER_VAULT_ABI,functionName:"poolFactory"}).catch(async()=>{
    const { TRENCHER_FACTORY_ABI } = await import("../../packages/core/src/index");
    return client.readContract({address:custody.factory,abi:TRENCHER_FACTORY_ABI,functionName:"poolFactory"});
  });
  // Failure to read existing holdings aborts the entire pass; it never becomes an empty book.
  const held = custody.deployed ? await client.readContract({address:custody.vault,abi:TRENCHER_VAULT_ABI,functionName:"tokens"}) : [];
  const qualified: GeckoPool[] = [];
  // Filter supported venues before token deduplication: a larger V2/V4 pool
  // must not erase an otherwise eligible V3 route for the same token.
  const ranked = highVolumePools(pools.filter(p => p.dex === "uniswap-v3-robinhood"));
  const nominated = new Set([...(opts.nominated ?? [])].map(a => String(a).toLowerCase()));
  const beyond = nominated.size
    ? ranked.slice(DISCOVERY_SLICE).filter(p => nominated.has(p.tokenAddress.toLowerCase())).slice(0, NOMINATED_VERIFY_MAX)
    : [];
  for (const p of [...ranked.slice(0,DISCOVERY_SLICE), ...beyond]) {
    if (p.dex !== "uniswap-v3-robinhood" || !p.poolAddress || !/^0x[0-9a-fA-F]{40}$/.test(p.poolAddress)) continue;
    // The energy reserve is never a trencher candidate: it is held as energy,
    // never watched, bought or sold as a coin. Excluded here, where a NEW token
    // would enter; `held` is left alone — the vault's own tokens() cannot hold
    // a coin it never bought, and a held-token read must never be narrowed.
    if (isEnergyReserveToken(p.tokenAddress)) continue;
    try {
      const address = p.poolAddress as Address;
      const cache = opts.cache;
      // Facts, never a verdict: a remembered pool goes through every check
      // below that the tape can change. Only the factory's answer is skipped,
      // and only for a pool it already answered for with these exact facts.
      let facts = cache?.verified(factory, address);
      const fresh = !facts;
      if (!facts) {
        if (cache?.refused(factory, address, p.tokenAddress)) continue;
        const [token0,token1,fee] = await Promise.all([
          client.readContract({address,abi:POOL,functionName:"token0"}),
          client.readContract({address,abi:POOL,functionName:"token1"}),
          client.readContract({address,abi:POOL,functionName:"fee"}),
        ]);
        facts = {token0,token1,fee};
      }
      const {token0:a,token1:b,fee} = facts;
      if (![a,b].some(t=>t.toLowerCase()===p.tokenAddress.toLowerCase())) continue;
      const quote = a.toLowerCase()===p.tokenAddress.toLowerCase()?b:a;
      if (![CASH.USDG.toLowerCase(),CASH.WETH.toLowerCase()].includes(quote.toLowerCase())) {
        if (fresh) cache?.rememberRefused(factory, address, p.tokenAddress);
        continue;
      }
      if (fresh) {
        const canonical = await client.readContract({address:factory,abi:FACTORY,functionName:"getPool",args:[a,b,fee]});
        if (canonical.toLowerCase()!==address.toLowerCase()) { cache?.rememberRefused(factory, address, p.tokenAddress); continue; }
        cache?.rememberVerified(factory, address, facts);
      }
      qualified.push(p);
    } catch { /* A failed new-candidate read excludes it; it does not authorize a guess. */ }
  }
  const addresses = [...new Set([...held,...qualified.map(p=>p.tokenAddress as Address)].map(a=>a.toLowerCase() as Address))];
  const tokens: StockToken[] = [];
  const symbols = new Set<string>();
  // DECIMALS ARE READ FRESH ON EVERY PASS — in one Multicall3 call, not cached.
  //
  // A pool's pair is immutable because Uniswap's bytecode makes it so. A
  // token's `decimals()` is whatever the token's own code says today, and the
  // coins here are arbitrary contracts. A remembered 18 would let through a
  // token that now answers 40, or no longer answers at all — both of which the
  // uncached pass refuses, and the second of which, for a HELD coin, aborts
  // the pass. So the read stays, and what changes is its cost: one call for
  // every address instead of one call each.
  //
  // Per-address outcomes are exactly the loop's old ones. A failed or
  // undecodable result is that address's read failing, and a failed batch is
  // every address's read failing.
  const reads: readonly ({status:"success";result:number}|{status:"failure";error:unknown})[] = addresses.length
    ? await client.multicall({contracts:addresses.map(address=>({address,abi:erc20Abi,functionName:"decimals"}) as const),allowFailure:true,batchSize:0})
        .then(r=>r as readonly ({status:"success";result:number}|{status:"failure";error:unknown})[])
        .catch((error: unknown)=>addresses.map(()=>({status:"failure" as const,error})))
    : [];
  for (const [i,address] of addresses.entries()) {
    try {
      const read = reads[i];
      if (!read) throw new Error("Token metadata unavailable");
      if (read.status!=="success") throw read.error;
      const decimals = read.result;
      if (decimals>36) throw new Error("Unsupported token precision");
      // Address-derived identity cannot change when a token edits its symbol or impersonates a stock.
      const symbol = `T${address.slice(-11).toUpperCase()}`;
      if (symbols.has(symbol)) throw new Error("Token identity collision");
      symbols.add(symbol);
      const label = qualified.find(p=>p.tokenAddress.toLowerCase()===address)?.name;
      tokens.push({symbol,name:label?.slice(0,100)||symbol,address,decimals,kind:"memecoin",chainlinkFeed:null});
    } catch (error) {
      if (held.some(t=>t.toLowerCase()===address)) throw error;
    }
  }
  return {custody,tokens,held,qualified:qualified.filter(p=>tokens.some(t=>t.address.toLowerCase()===p.tokenAddress.toLowerCase()))};
}
