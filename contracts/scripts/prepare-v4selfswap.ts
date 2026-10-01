/** Read-only: build an unsigned deployment; never obtains a wallet or sends a transaction. */
import hre from "hardhat";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatEther, keccak256 } from "viem";
import { V4_CHAINS, V4_POOL_MANAGER, v4DeploymentBuild } from "./lib/v4-build";

async function main() {
  const client = await hre.viem.getPublicClient();
  const chainId = await client.getChainId();
  if (!V4_CHAINS.has(chainId)) throw new Error(`Unsupported chain ${chainId}`);
  const managerCode = await client.getCode({ address: V4_POOL_MANAGER });
  if (!managerCode || managerCode === "0x") throw new Error("Canonical PoolManager has no code on this chain");
  const build = await v4DeploymentBuild(hre, V4_POOL_MANAGER);
  const gas = await client.estimateGas({ data: build.data });
  const gasPrice = await client.getGasPrice();
  const output = process.env.MERRYMEN_V4_PREPARE_OUTPUT ||
    path.join(tmpdir(), `merrymen-v4-${chainId}-${Date.now()}.json`);
  writeFileSync(output, JSON.stringify({
    kind: "unsigned-contract-deployment",
    preparedAt: new Date().toISOString(),
    chainId,
    poolManager: V4_POOL_MANAGER,
    observedPoolManagerRuntimeHash: keccak256(managerCode),
    compiler: build.compiler,
    compilerInputSha256: build.compilerInputSha256,
    optimizer: build.optimizer,
    evmVersion: build.evmVersion,
    expectedRuntime: build.expectedRuntime,
    expectedRuntimeHash: build.runtimeHash,
    // Contract creation has no `to`. Fee and nonce must be refreshed by the owner's wallet.
    transaction: { chainId, data: build.data, value: "0x0" },
    estimate: { gas: gas.toString(), gasPriceWei: gasPrice.toString(), gasCostEth: formatEther(gas * gasPrice) },
    note: "Unsigned; nothing deployed. Gas estimate may change and may exclude chain-specific data fees. Verify runtime after owner-signed deployment before granting permission.",
  }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(`Prepared unsigned V4SelfSwap deployment for chain ${chainId}`);
  console.log(`PoolManager: ${V4_POOL_MANAGER}`);
  console.log(`Estimated gas: ${gas}; gas component: ${formatEther(gas * gasPrice)} ETH`);
  console.log(`Expected runtime hash: ${build.runtimeHash}`);
  console.log(`Review file: ${output}`);
  console.log("No transaction sent. An owner must review and sign the deployment.");
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
