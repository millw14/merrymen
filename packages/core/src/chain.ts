import { defineChain } from "viem";

/**
 * Robinhood Chain constants.
 * Every address below was verified on-chain via eth_getCode / storage probes on 2026-07-09,
 * except where marked. Do not add addresses here without probing them first.
 */

export const robinhoodChain = defineChain({
  id: 4663, // 0x1237
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://robinhoodchain.blockscout.com",
      apiUrl: "https://robinhoodchain.blockscout.com/api",
    },
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

export const robinhoodTestnet = defineChain({
  id: 46630, // 0xb626
  name: "Robinhood Chain Testnet",
  testnet: true,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://explorer.testnet.chain.robinhood.com",
    },
  },
});

/** ERC-4337 EntryPoints — all deployed on both mainnet and testnet (probed 2026-07-09). */
export const ENTRYPOINT = {
  v06: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
  v07: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  v08: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
} as const;

/** Canonical infra verified deployed on mainnet 4663. */
export const INFRA = {
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  create2Deployer: "0x4e59b44847b379578588920cA78FbF26c0B4956C",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
} as const;

/** Data-source identifiers. */
export const DATA = {
  geckoTerminalSlug: "robinhood",
  dexScreenerChainId: "robinhood",
  sequencerFeed: "wss://feed.mainnet.chain.robinhood.com",
} as const;
