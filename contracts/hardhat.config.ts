import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-viem";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  // Deploy targets (deployment itself waits for a funded key):
  // Robinhood Chain testnet 46630 / mainnet 4663.
  networks: {
    robinhoodTestnet: {
      url: "https://rpc.testnet.chain.robinhood.com",
      chainId: 46630,
    },
    robinhood: {
      url: "https://rpc.mainnet.chain.robinhood.com",
      chainId: 4663,
    },
  },
};

export default config;
