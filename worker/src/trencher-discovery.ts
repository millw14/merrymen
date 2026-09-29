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
}

/** A bounded discovery pass. Feed text never chooses contract addresses or executable calldata. */
export async function discoverTrencherUniverse(client: PublicClient, grant: StoredGrant, pools: readonly GeckoPool[], opts: DiscoveryOptions = {}) {
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
      const [a,b,fee] = await Promise.all([
        client.readContract({address,abi:POOL,functionName:"token0"}),
        client.readContract({address,abi:POOL,functionName:"token1"}),
        client.readContract({address,abi:POOL,functionName:"fee"}),
      ]);
      if (![a,b].some(t=>t.toLowerCase()===p.tokenAddress.toLowerCase())) continue;
      const quote = a.toLowerCase()===p.tokenAddress.toLowerCase()?b:a;
      if (![CASH.USDG.toLowerCase(),CASH.WETH.toLowerCase()].includes(quote.toLowerCase())) continue;
      const canonical = await client.readContract({address:factory,abi:FACTORY,functionName:"getPool",args:[a,b,fee]});
      if (canonical.toLowerCase()!==address.toLowerCase()) continue;
      qualified.push(p);
    } catch { /* A failed new-candidate read excludes it; it does not authorize a guess. */ }
  }
  const addresses = [...new Set([...held,...qualified.map(p=>p.tokenAddress as Address)].map(a=>a.toLowerCase() as Address))];
  const tokens: StockToken[] = [];
  const symbols = new Set<string>();
  for (const address of addresses) {
    try {
      const decimals = await client.readContract({address,abi:erc20Abi,functionName:"decimals"});
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
