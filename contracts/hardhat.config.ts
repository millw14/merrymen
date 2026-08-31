import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-viem";

const config: HardhatUserConfig = {
  solidity: {
    // The `compilers` array form, not the `version`/`settings` shorthand:
    // hardhat only honours `overrides` alongside `compilers`.
    compilers: [{ version: "0.8.28", settings: { optimizer: { enabled: true, runs: 200 } } }],
    // V4SelfSwap's re-entrancy flag is `bool private transient`, which needs
    // Cancun's TSTORE/TLOAD. Everything else here compiles to the default
    // (paris) and MUST keep doing so: BreakerRegistry and KernelBreakerPolicy
    // may already be deployed, and recompiling them under a different EVM
    // version produces different bytecode than what was verified on-chain.
    // Hence a per-file override rather than flipping evmVersion globally.
    overrides: {
      "contracts/V4SelfSwap.sol": {
        version: "0.8.28",
        settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
      },
      // Same reason: PonsSelfTrade's re-entrancy flag is also `bool private
      // transient`. Per-file again rather than a global flip, so the two
      // already-deployable breaker contracts keep producing the bytecode that
      // was verified on-chain.
      "contracts/PonsSelfTrade.sol": {
        version: "0.8.28",
        settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
      },
      // And its native-quoted sibling, for the same transient flag and the same
      // per-file reason: the breaker contracts must keep compiling to paris so
      // their bytecode still matches what was verified on-chain.
      "contracts/PonsNativeTrade.sol": {
        version: "0.8.28",
        settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
      },
    },
  },
  // Deploy targets: Robinhood Chain testnet 46630 / mainnet 4663.
  //
  // The deployer key comes from the ENVIRONMENT, never a file: set
  // MERRYMEN_DEPLOYER_PRIVATE_KEY in the shell that runs the deploy, and close
  // that shell afterwards. When it is absent, `accounts` is empty and
  // compile/test behave exactly as before — nothing in CI needs the key.
  networks: {
    robinhoodTestnet: {
      url: "https://rpc.testnet.chain.robinhood.com",
      chainId: 46630,
      accounts: process.env.MERRYMEN_DEPLOYER_PRIVATE_KEY ? [process.env.MERRYMEN_DEPLOYER_PRIVATE_KEY] : [],
    },
    robinhood: {
      url: "https://rpc.mainnet.chain.robinhood.com",
      chainId: 4663,
      accounts: process.env.MERRYMEN_DEPLOYER_PRIVATE_KEY ? [process.env.MERRYMEN_DEPLOYER_PRIVATE_KEY] : [],
    },
  },
};

export default config;
