/** Explicit operator deployment. No tenant/session keys are read by this script. */
import hre from "hardhat";
import { keccak256, erc20Abi } from "viem";
import { writeFileSync } from "node:fs";

const infrastructure = [
  "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", // USDG
  "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", // WETH
  "0xcaf681a66d020601342297493863e78c959e5cb2", // SwapRouter02
  "0x1f7d7550b1b028f7571e69a784071f0205fd2efa", // V3 factory
] as const;

async function main() {
  const client=await hre.viem.getPublicClient();
  const chainId=await client.getChainId();
  if (chainId!==4663) throw new Error("This deployment manifest targets Robinhood mainnet 4663 only");
  const [deployer]=await hre.viem.getWalletClients();
  if (!deployer) throw new Error("Set MERRYMEN_DEPLOYER_PRIVATE_KEY in the operator environment; never use a tenant session key");
  for (const address of infrastructure) {
    const code=await client.getCode({address});
    if (!code||code==="0x") throw new Error(`Infrastructure is absent at ${address}`);
  }
  if (await client.readContract({address:infrastructure[0],abi:erc20Abi,functionName:"decimals"})!==6) throw new Error("Unexpected cash precision");
  // The explicit flag avoids an inspection command accidentally spending deployment gas.
  if (process.env.TRENCHER_DEPLOY!=="1") throw new Error("Preflight passed. Set TRENCHER_DEPLOY=1 to deploy the reviewed contract");
  const factory=await hre.viem.deployContract("TrencherVaultFactory",[...infrastructure]);
  const code=await client.getCode({address:factory.address});
  if (!code||code==="0x") throw new Error("Deployment has no runtime bytecode");
  const codeHash=keccak256(code);
  const manifest={chainId,factory:factory.address,codeHash,infrastructure,compiler:"0.8.28",perBuyUsdg:5,dailyBuysUsdg:25};
  writeFileSync("trencher-deployment.json",JSON.stringify(manifest,null,2)+"\n");
  console.log(JSON.stringify(manifest,null,2));
  console.log("Publish the factory address and runtime hash together after verifying the deployed source. No agent permissions were changed.");
}
main().catch(error=>{console.error(error instanceof Error?error.message:"Deployment failed");process.exitCode=1;});
