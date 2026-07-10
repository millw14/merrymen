/**
 * Real on-chain reads for the tick loop.
 *
 * Market safety data (pause states, feed staleness, sequencer health) always
 * comes from MAINNET — that's where the tokens and feeds live. Account balances
 * come from whichever chain the grant was issued on (testnet during the demo).
 */

import { createPublicClient, http, parseAbi, type PublicClient } from "viem";
import {
  CASH,
  CHAINLINK_ABI,
  MORPHO,
  STOCK_ABI,
  STOCK_TOKENS,
  robinhoodChain,
} from "@merrymen/core";

const ERC20_READS = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);
const VAULT_READS = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
]);

const mainnet = createPublicClient({ chain: robinhoodChain, transport: http() });

export interface MarketSafety {
  pausedTokens: Set<string>;
  /** Symbols whose Chainlink feed is >2h old (expected on weekends — 24/5 feeds). */
  staleFeeds: Set<string>;
  /** Latest Chainlink USD price per symbol (8dp), stale or not — for valuation. */
  prices: Map<string, { price8: bigint; stale: boolean }>;
  sequencerUp: boolean;
  blockNumber: bigint;
}

export async function readMarketSafety(): Promise<MarketSafety> {
  const withFeed = STOCK_TOKENS.filter((t) => t.chainlinkFeed !== null);

  const [block, pausedResults, feedResults] = await Promise.all([
    mainnet.getBlock({ blockTag: "latest" }),
    mainnet.multicall({
      contracts: STOCK_TOKENS.map(
        (t) => ({ address: t.address, abi: STOCK_ABI, functionName: "tokenPaused" }) as const,
      ),
    }),
    mainnet.multicall({
      contracts: withFeed.map(
        (t) =>
          ({ address: t.chainlinkFeed!, abi: CHAINLINK_ABI, functionName: "latestRoundData" }) as const,
      ),
    }),
  ]);

  const now = Math.floor(Date.now() / 1000);

  const pausedTokens = new Set<string>();
  STOCK_TOKENS.forEach((t, i) => {
    const r = pausedResults[i];
    if (r?.status === "success" && (r.result as boolean)) pausedTokens.add(t.address.toLowerCase());
  });

  const staleFeeds = new Set<string>();
  const prices = new Map<string, { price8: bigint; stale: boolean }>();
  withFeed.forEach((t, i) => {
    const r = feedResults[i];
    if (r?.status !== "success") {
      staleFeeds.add(t.symbol);
      return;
    }
    const [, answer, , updatedAt] = r.result as readonly [bigint, bigint, bigint, bigint, bigint];
    const stale = now - Number(updatedAt) > 2 * 3600;
    if (stale) staleFeeds.add(t.symbol);
    // Stale prices still value positions — a weekend AAPL holding isn't worth
    // zero, it's worth Friday's close until Monday.
    if (answer > 0n) prices.set(t.symbol, { price8: answer, stale });
  });

  // Sequencer heuristic until the Chainlink sequencer-uptime feed address is
  // confirmed for 4663: a healthy sequencer produces blocks continuously.
  const sequencerUp = now - Number(block.timestamp) < 120;

  return { pausedTokens, staleFeeds, prices, sequencerUp, blockNumber: block.number };
}

export interface AccountBalances {
  ethWei: bigint;
  /** USDG in wallet (6dp). 0 on chains where USDG isn't deployed. */
  cashUsdg: bigint;
  /** USDG value of Morpho vault shares (6dp). 0 where the vault isn't deployed. */
  vaultUsdg: bigint;
}

export async function readAccountBalances(
  client: PublicClient,
  account: `0x${string}`,
): Promise<AccountBalances> {
  const ethWei = await client.getBalance({ address: account });

  const results = await client
    .multicall({
      contracts: [
        { address: CASH.USDG as `0x${string}`, abi: ERC20_READS, functionName: "balanceOf", args: [account] },
        { address: MORPHO.steakhouseUsdgVault as `0x${string}`, abi: VAULT_READS, functionName: "balanceOf", args: [account] },
      ],
    })
    .catch(() => null);

  const cashUsdg =
    results?.[0]?.status === "success" ? (results[0].result as bigint) : 0n;
  const shares =
    results?.[1]?.status === "success" ? (results[1].result as bigint) : 0n;

  let vaultUsdg = 0n;
  if (shares > 0n) {
    vaultUsdg = (await client
      .readContract({
        address: MORPHO.steakhouseUsdgVault as `0x${string}`,
        abi: VAULT_READS,
        functionName: "convertToAssets",
        args: [shares],
      })
      .catch(() => 0n)) as bigint;
  }

  return { ethWei, cashUsdg, vaultUsdg };
}
