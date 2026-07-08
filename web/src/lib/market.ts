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

import { createPublicClient, http } from "viem";
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
  kind: "stock" | "etf";
  address: string;
  logo: string;
  priceUsd: number | null;
  /** Unix seconds of the last Chainlink update; null when the token has no feed. */
  priceUpdatedAt: number | null;
  paused: boolean;
  /** 1.0 = no pending corporate action. */
  uiMultiplier: number | null;
  rialtoLiquid: boolean;
  volume24hUsd: number | null;
  holders: number | null;
}

export interface MarketData {
  fetchedAt: number;
  tokens: MarketToken[];
}

const client = createPublicClient({ chain: robinhoodChain, transport: http() });

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
      paused: pausedRes?.status === "success" ? (pausedRes.result as boolean) : false,
      uiMultiplier:
        multRes?.status === "success" ? Number(multRes.result as bigint) / 1e18 : null,
      rialtoLiquid: rialtoLiquid.get(t.address.toLowerCase()) ?? false,
      volume24hUsd: stats.volume24hUsd,
      holders: stats.holders,
    };
  });

  tokens.sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));

  return { fetchedAt: Math.floor(Date.now() / 1000), tokens };
}
