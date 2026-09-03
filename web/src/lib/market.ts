/**
 * Market data layer — server-side only.
 *
 * Sources, in order of trust:
 *  - Chainlink feeds (on-chain, multicall): price + updatedAt. THE price source.
 *    DEX-derived prices (GeckoTerminal etc.) are junk while stock pools are shallow.
 *  - Stock contracts (on-chain, multicall): tokenPaused, uiMultiplier.
 *  - Blockscout API: official Robinhood logo (cdn.robinhood.com), holders, 24h volume.
 *  - Rialto /tokens (public): whether Rialto considers the token liquid.
 */

import { createPublicClient } from "viem";
import { rpcTransportFor } from "./rpc";
import {
  CHAINLINK_ABI,
  RIALTO,
  STOCK_ABI,
  STOCK_TOKENS,
  robinhoodChain,
} from "@merrymen/core";

export interface MarketToken {
  symbol: string;
  name: string;
  kind: "stock" | "etf" | "memecoin";
  address: string;
  logo: string;
  priceUsd: number | null;
  /** Unix seconds of the last Chainlink update; null when the token has no feed. */
  priceUpdatedAt: number | null;
  /**
   * Trading halted on the token contract. NULL WHEN THE READ FAILED.
   *
   * It fell back to `false`, so one refused multicall leg published "trading
   * normally" for a token nobody had asked. A halt is the single most
   * consequential thing this row says; it may only be asserted when the chain
   * actually answered.
   */
  paused: boolean | null;
  /** 1.0 = no pending corporate action. */
  uiMultiplier: number | null;
  /** Whether Rialto considers it liquid. Null when Rialto could not be asked. */
  rialtoLiquid: boolean | null;
  volume24hUsd: number | null;
  holders: number | null;
}

export interface MarketData {
  fetchedAt: number;
  tokens: MarketToken[];
}

// MODULE-LEVEL AND DELIBERATELY SO: one client, one connection pool, reused for
// the life of the process. Resolved through lib/rpc.ts so it honours
// MERRYMEN_RPC_MAINNET instead of the chain default.
const client = createPublicClient({
  chain: robinhoodChain,
  transport: rpcTransportFor(robinhoodChain.id, "market"),
});

const BLOCKSCOUT = "https://robinhoodchain.blockscout.com/api/v2";
const LOGO_CDN = (address: string) =>
  `https://cdn.robinhood.com/ncw_assets/logos/${address.toLowerCase()}.png`;

async function fetchRialtoLiquidity(): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  try {
    const res = await fetch(`${RIALTO.apiBase}/tokens`, { next: { revalidate: 300 } });
    if (!res.ok) return map;
    const j = (await res.json()) as { tokens?: { address: string; liquid: boolean }[] };
    for (const t of j.tokens ?? []) map.set(t.address.toLowerCase(), t.liquid);
  } catch {
    // Rialto being down must not take the market table down.
  }
  return map;
}

interface BlockscoutStats {
  iconUrl: string | null;
  volume24hUsd: number | null;
  holders: number | null;
}

async function fetchBlockscoutStats(address: string): Promise<BlockscoutStats> {
  try {
    const res = await fetch(`${BLOCKSCOUT}/tokens/${address}`, { next: { revalidate: 300 } });
    if (!res.ok) return { iconUrl: null, volume24hUsd: null, holders: null };
    const j = await res.json();
    return {
      iconUrl: typeof j.icon_url === "string" ? j.icon_url : null,
      volume24hUsd: j.volume_24h != null ? Number(j.volume_24h) : null,
      holders: j.holders_count != null ? Number(j.holders_count) : null,
    };
  } catch {
    return { iconUrl: null, volume24hUsd: null, holders: null };
  }
}

export async function fetchMarket(): Promise<MarketData> {
  const withFeed = STOCK_TOKENS.filter((t) => t.chainlinkFeed !== null);

  const feedCalls = withFeed.flatMap((t) => [
    { address: t.chainlinkFeed!, abi: CHAINLINK_ABI, functionName: "latestRoundData" } as const,
    { address: t.chainlinkFeed!, abi: CHAINLINK_ABI, functionName: "decimals" } as const,
  ]);
  const stateCalls = STOCK_TOKENS.flatMap((t) => [
    { address: t.address, abi: STOCK_ABI, functionName: "tokenPaused" } as const,
    { address: t.address, abi: STOCK_ABI, functionName: "uiMultiplier" } as const,
  ]);

  const [feedResults, stateResults, rialtoLiquid, blockscout] = await Promise.all([
    client.multicall({ contracts: feedCalls }),
    client.multicall({ contracts: stateCalls }),
    fetchRialtoLiquidity(),
    Promise.all(STOCK_TOKENS.map((t) => fetchBlockscoutStats(t.address))),
  ]);

  const prices = new Map<string, { priceUsd: number; updatedAt: number }>();
  withFeed.forEach((t, i) => {
    const round = feedResults[i * 2];
    const dec = feedResults[i * 2 + 1];
    if (round?.status !== "success" || dec?.status !== "success") return;
    const [, answer, , updatedAt] = round.result as readonly [bigint, bigint, bigint, bigint, bigint];
    prices.set(t.symbol, {
      priceUsd: Number(answer) / 10 ** Number(dec.result as number),
      updatedAt: Number(updatedAt),
    });
  });

  const tokens: MarketToken[] = STOCK_TOKENS.map((t, i) => {
    const pausedRes = stateResults[i * 2];
    const multRes = stateResults[i * 2 + 1];
    const price = prices.get(t.symbol);
    const stats = blockscout[i]!;
    return {
      symbol: t.symbol,
      name: t.name,
      kind: t.kind,
      address: t.address,
      logo: stats.iconUrl ?? LOGO_CDN(t.address),
      priceUsd: price?.priceUsd ?? null,
      priceUpdatedAt: price?.updatedAt ?? null,
      paused: pausedRes?.status === "success" ? (pausedRes.result as boolean) : null,
      uiMultiplier:
        multRes?.status === "success" ? Number(multRes.result as bigint) / 1e18 : null,
      // fetchRialtoLiquidity returns an EMPTY MAP when Rialto is down, so a
      // `?? false` stamped "illiquid" on all 25 tokens during one outage.
      rialtoLiquid: rialtoLiquid.get(t.address.toLowerCase()) ?? null,
      volume24hUsd: stats.volume24hUsd,
      holders: stats.holders,
    };
  });

  // Unknown volume sorts LAST rather than as zero: `?? 0` ranked a token
  // Blockscout did not answer for identically to one that genuinely did no
  // trade, which is the same conflation this file just removed from `paused`.
  tokens.sort((a, b) => {
    if (a.volume24hUsd === b.volume24hUsd) return 0;
    if (a.volume24hUsd === null) return 1;
    if (b.volume24hUsd === null) return -1;
    return b.volume24hUsd - a.volume24hUsd;
  });

  return { fetchedAt: Math.floor(Date.now() / 1000), tokens };
}
