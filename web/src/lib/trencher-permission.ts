import { keccak256, type Address, type PublicClient } from "viem";
import { CASH, UNISWAP, TRENCHER_FACTORY_ABI } from "@merrymen/core";

/** No default deployment: the permission stays unavailable until a verified factory is configured. */
const configuredFactory = process.env.NEXT_PUBLIC_TRENCHER_FACTORY;
const trustedHash = process.env.NEXT_PUBLIC_TRENCHER_FACTORY_CODE_HASH;
export const TRENCHER_FACTORY = trustedHash && /^0x[0-9a-fA-F]{64}$/.test(trustedHash) && configuredFactory && /^0x[0-9a-fA-F]{40}$/.test(configuredFactory) && !/^0x0{40}$/i.test(configuredFactory) ? configuredFactory : undefined;
export async function resolveTrencherPermission(client: PublicClient, factory: Address, owner: Address) {
  const code = await client.getCode({address:factory});
  if (!code || code === "0x") throw new Error("Autonomous Trencher factory is not deployed on this chain");
  if (!trustedHash || keccak256(code).toLowerCase()!==trustedHash.toLowerCase()) throw new Error("Autonomous Trencher factory bytecode is not verified");
  const [cash,bridge,router,poolFactory,vault] = await Promise.all([
    client.readContract({address:factory,abi:TRENCHER_FACTORY_ABI,functionName:"cash"}),
    client.readContract({address:factory,abi:TRENCHER_FACTORY_ABI,functionName:"bridge"}),
    client.readContract({address:factory,abi:TRENCHER_FACTORY_ABI,functionName:"router"}),
    client.readContract({address:factory,abi:TRENCHER_FACTORY_ABI,functionName:"poolFactory"}),
    client.readContract({address:factory,abi:TRENCHER_FACTORY_ABI,functionName:"vaultFor",args:[owner]}),
  ]);
  if (cash.toLowerCase()!==CASH.USDG.toLowerCase() || bridge.toLowerCase()!==CASH.WETH.toLowerCase() || router.toLowerCase()!==UNISWAP.swapRouter02.toLowerCase() || poolFactory.toLowerCase()!==UNISWAP.v3Factory.toLowerCase()) {
    throw new Error("Autonomous Trencher factory does not use the expected cash and router");
  }
  return {trencherFactoryAddress:factory.toLowerCase(),trencherVaultAddress:vault.toLowerCase()};
}
