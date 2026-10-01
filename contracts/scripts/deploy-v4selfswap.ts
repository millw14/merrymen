/**
 * Deploy V4SelfSwap — the one contract that makes Uniswap v4 constrainable by
 * the permission wall.
 *
 * RUN BY THE OWNER, deliberately. Deployment spends real gas from a real key,
 * and this repo's agent never handles owner keys or moves funds on its own.
 * The key is read from the environment by hardhat.config.ts and is never
 * logged, written, or echoed by this script — only the ADDRESS it derives to.
 *
 *   $env:MERRYMEN_DEPLOYER_PRIVATE_KEY = "0x…"   # shell-only; close it after
 *   npm run deploy:v4:testnet
 *   npm run deploy:v4:mainnet
 *
 * The two runs may produce different addresses; verify each on its own chain.
 * Paste each into /settings as `v4AdapterAddress` on the machine that signs
 * grants for that chain, then RE-SIGN the grant — the address is sealed into
 * the signature, so the setting alone changes nothing.
 */
import hre from "hardhat";
import path from "node:path";
import { formatEther, getContractAddress, type Hex } from "viem";
import { V4_POOL_MANAGER, v4DeploymentBuild, verifyV4Runtime } from "./lib/v4-build";
import { readDeploymentManifest, recordDeployment } from "./lib/deployment-manifest";
import { claimDeploymentAttempt } from "./lib/deployment-attempt";

/**
 * The canonical Uniswap v4 PoolManager, same address on 46630 and 4663
 * (verified live on both, 2026-08-26). Pinned here rather than imported
 * because the contracts package deliberately has no dependency on
 * packages/core — cross-reference: packages/core/src/protocols.ts
 * UNISWAP.v4PoolManager. Confirm this address against the official Uniswap deployment table before
 * deployment; the post-deploy check establishes binding, not registry authority.
 */
const POOL_MANAGER = V4_POOL_MANAGER;

/** The only chains this should ever touch. Anything else is a mistake. */
const KNOWN_CHAINS: Record<number, string> = {
  46630: "Robinhood Chain testnet",
  4663: "Robinhood Chain MAINNET — real funds",
};

async function main() {
  const publicClient = await hre.viem.getPublicClient();
  const chainId = await publicClient.getChainId();

  if (!(chainId in KNOWN_CHAINS)) {
    throw new Error(
      `refusing to deploy to unknown chain ${chainId} — this script only knows ` +
        `Robinhood Chain testnet (46630) and mainnet (4663). Check --network.`,
    );
  }

  const manifest = path.join(hre.config.paths.root, "deployments.json");
  const book = readDeploymentManifest(manifest);
  if (Object.hasOwn(book[String(chainId)] ?? {}, "V4SelfSwap")) {
    throw new Error("A V4SelfSwap deployment is already recorded for this chain. Verify/reuse it; do not silently replace it.");
  }
  const build = await v4DeploymentBuild(hre, POOL_MANAGER);
  const wallets = await hre.viem.getWalletClients();
  if (wallets.length === 0) {
    throw new Error(
      "no deployer account. Set MERRYMEN_DEPLOYER_PRIVATE_KEY in this shell " +
        "(it is read by hardhat.config.ts and never logged), then re-run.",
    );
  }
  const deployer = wallets[0]!.account.address;
  console.log(`chain    : ${chainId} (${KNOWN_CHAINS[chainId]})`);
  console.log(`deployer : ${deployer}`);

  // Fail BEFORE gas is spent when the PoolManager is not where we think it is.
  // The constructor checks too (NotAContract), but a refusal here is free.
  const pmCode = await publicClient.getCode({ address: POOL_MANAGER });
  if (pmCode === undefined || pmCode === "0x") {
    throw new Error(`PoolManager ${POOL_MANAGER} has no code on chain ${chainId} — wrong chain or wrong registry.`);
  }

  const balance = await publicClient.getBalance({ address: deployer });
  console.log(`balance  : ${formatEther(balance)} ETH`);
  if (balance === 0n) {
    throw new Error("deployer has no ETH — fund it first (testnet: https://faucet.testnet.chain.robinhood.com).");
  }

  // Claim the deployment before broadcasting. A crash, timeout, or failed
  // verification leaves this journal in place and a rerun refuses to spend
  // again. The owner can inspect this nonce/address even if no hash was logged.
  const nonce = await publicClient.getTransactionCount({ address: deployer, blockTag: "pending" });
  const expectedAddress = getContractAddress({ from: deployer, nonce: BigInt(nonce) });
  const journal = path.join(hre.config.paths.root, `deployments.v4-${chainId}.attempt.json`);
  const attempt = { chainId, deployer, nonce, expectedAddress, runtimeHash: build.runtimeHash, transactionHash: "" };
  const claim = claimDeploymentAttempt(journal, attempt);
  console.log("deploying V4SelfSwap…");
  let hash: Hex;
  try {
    hash = await wallets[0]!.deployContract({
      abi: build.abi, bytecode: build.bytecode, args: [POOL_MANAGER], nonce,
    });
    attempt.transactionHash = hash;
    claim.save(attempt);
  } finally { claim.close(); }
  // Print immediately so an interrupted receipt wait does not lose the transaction.
  console.log(`transaction: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`Deployment failed: ${hash}`);
  }
  const address = receipt.contractAddress;
  if (address.toLowerCase() !== expectedAddress.toLowerCase()) throw new Error("Deployment address differs from the claimed nonce");
  const code = await publicClient.getCode({ address });
  verifyV4Runtime(code, build.expectedRuntime);
  const bound = await publicClient.readContract({ address, abi: build.abi, functionName: "poolManager" }) as string;
  if (bound.toLowerCase() !== POOL_MANAGER.toLowerCase()) {
    throw new Error(`adapter is bound to ${bound}, expected ${POOL_MANAGER} — do NOT use this deployment.`);
  }
  await recordDeployment(manifest, chainId, "V4SelfSwap", {
    address, transactionHash: hash, blockNumber: receipt.blockNumber.toString(),
    deployedAt: new Date().toISOString(), codeBytes: (code!.length - 2) / 2,
    poolManager: POOL_MANAGER, runtimeHash: build.runtimeHash,
    compiler: build.compiler, compilerInputSha256: build.compilerInputSha256,
    optimizer: build.optimizer, evmVersion: build.evmVersion,
  });

  console.log("");
  console.log(`✓ V4SelfSwap deployed at ${address}`);
  console.log(`  code           : ${(code!.length - 2) / 2} bytes`);
  console.log(`  poolManager()  : ${bound}`);
  console.log(`  runtime hash   : ${build.runtimeHash}`);
  console.log(`  recorded in    : ${manifest}`);
  console.log("");
  console.log("next steps:");
  console.log(`  1. paste ${address} into /settings as "v4 adapter contract" (v4AdapterAddress)`);
  console.log("  2. RE-SIGN the grant at /grant — the address is sealed into the signature,");
  console.log("     so the setting alone changes nothing");
  console.log("  3. unset MERRYMEN_DEPLOYER_PRIVATE_KEY / close this shell");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
