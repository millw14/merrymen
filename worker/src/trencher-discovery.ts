import { erc20Abi, parseAbi, type Address, type PublicClient } from "viem";
import { CASH, TRENCHER_VAULT_ABI, isEnergyReserveToken, type StockToken, type StoredGrant } from "../../packages/core/src/index";
import { highVolumePools } from "./trencher-brain";
import { verifyTrencherCustody } from "./venues/trencher-vault";
import type { GeckoPool } from "./venues/geckoterminal";

const POOL = parseAbi(["function token0() view returns (address)","function token1() view returns (address)","function fee() view returns (uint24)"]);
const FACTORY = parseAbi(["function getPool(address a,address b,uint24 fee) view returns (address)"]);
/** A bounded discovery pass. Feed text never chooses contract addresses or executable calldata. */
export async function discoverTrencherUniverse(client: PublicClient, grant: StoredGrant, pools: readonly GeckoPool[]) {
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
  for (const p of highVolumePools(pools.filter(p => p.dex === "uniswap-v3-robinhood")).slice(0,20)) {
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
