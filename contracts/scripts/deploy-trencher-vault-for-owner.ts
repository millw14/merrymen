/**
 * Deploy ONE owner's Trencher vault, as an ordinary transaction.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM THE FIRST BUY ────────────────────────
 *
 * `buildTrencherCalls` will deploy the vault itself, as the first leg of a
 * batch that is deploy + approve + buy. That batch cannot be signed on an
 * account whose permission wall is still being installed. Measured on chain
 * 4663, 2026-09-20, for agent 0x05a198a6…5487:
 *
 *   enable half (24-permission wall, padded)   11,911,670
 *   payload deploy + approve + buy (padded)     4,273,702
 *   ------------------------------------------------------
 *   total                                      16,231,829   ceiling 14,000,000
 *
 * The wall install alone takes 85% of the budget, and no wall the owner can
 * configure is small enough to leave room — stripping BOTH optional rails
 * still lands 115,091 over, and that wall cannot trade at all. Deploying the
 * vault beforehand removes 1,524,495 of gas from the batch, and the first buy
 * then fits with roughly 750,000 to spare.
 *
 * ── WHY IT IS SAFE TO RUN FROM ANY KEY ───────────────────────────────────
 *
 * `TrencherVaultFactory.deploy(address owner)` is permissionless and
 * idempotent: it CREATE2s the vault at an address derived from `owner` and
 * returns the existing one if it is already there. The vault's constructor
 * binds `owner` immutably, so the sender gains nothing — it cannot buy, sell
 * or recover, and sale proceeds can only ever reach the owner's account. The
 * caller pays gas and takes no custody.
 *
 * It grants the agent nothing either. Buying still requires the signed grant,
 * the wall, the worker's own caps and the vault's own on-chain limits (5 USDG
 * per buy, 25 USDG per 24h window).
 *
 * ── WHAT IT REFUSES TO DO ────────────────────────────────────────────────
 *
 * Verify the factory's runtime hash against the reviewed deployment before
 * sending, and refuse a different chain. A vault deployed by an unreviewed
 * factory would be a contract nobody has read holding somebody's money.
 */
import hre from "hardhat";
import { keccak256, isAddress, type Address } from "viem";

/** The reviewed factory and its runtime hash — contracts/trencher-deployment.json. */
const FACTORY = "0x32a2a19a9a0ff54ffcaeb40955fd710e77cbbbf7" as Address;
const FACTORY_CODE_HASH = "0xd450d4761ccb39e8b8f623e84884f1424c7b580f91a62822a5f3c024b7b3a1a4";

const ABI = [
  { type: "function", name: "deploy", stateMutability: "nonpayable", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "address" }] },
  { type: "function", name: "vaultFor", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "address" }] },
] as const;

async function main() {
  const owner = process.env.TRENCHER_VAULT_OWNER;
  if (!owner || !isAddress(owner)) {
    throw new Error("Set TRENCHER_VAULT_OWNER to the agent's smart-account address");
  }
  const client = await hre.viem.getPublicClient();
  const chainId = await client.getChainId();
  if (chainId !== 4663) throw new Error("This targets Robinhood mainnet 4663 only");

  const code = await client.getCode({ address: FACTORY });
  if (!code || code === "0x") throw new Error(`No factory at ${FACTORY}`);
  const hash = keccak256(code);
  if (hash.toLowerCase() !== FACTORY_CODE_HASH.toLowerCase()) {
    throw new Error(`Factory runtime hash is ${hash}, not the reviewed ${FACTORY_CODE_HASH}`);
  }

  const predicted = await client.readContract({ address: FACTORY, abi: ABI, functionName: "vaultFor", args: [owner as Address] });
  const existing = await client.getCode({ address: predicted });
  console.log(`owner     ${owner}`);
  console.log(`vault     ${predicted}`);
  if (existing && existing !== "0x") {
    console.log("Already deployed. Nothing to do — the next buy will skip the deploy leg.");
    return;
  }

  const [wallet] = await hre.viem.getWalletClients();
  if (!wallet) throw new Error("Set MERRYMEN_DEPLOYER_PRIVATE_KEY in the operator environment; never use a tenant session key");

  // Simulate first: a CREATE2 that reverts costs the same gas as one that works.
  const { request, result } = await client.simulateContract({
    address: FACTORY, abi: ABI, functionName: "deploy", args: [owner as Address], account: wallet.account,
  });
  if (String(result).toLowerCase() !== predicted.toLowerCase()) {
    throw new Error(`Simulation returns ${result}, not the predicted ${predicted}`);
  }
  const gas = await client.estimateGas({ account: wallet.account, to: FACTORY, data: "0x4c96a389" + owner.slice(2).padStart(64, "0") as `0x${string}` });
  console.log(`gas       ~${gas}`);

  // The explicit flag keeps an inspection run from spending gas, exactly as the
  // factory deployment beside this one does.
  if (process.env.TRENCHER_DEPLOY_VAULT !== "1") {
    console.log("Preflight passed. Set TRENCHER_DEPLOY_VAULT=1 to send it.");
    return;
  }
  const tx = await wallet.writeContract(request);
  console.log(`tx        ${tx}`);
  const receipt = await client.waitForTransactionReceipt({ hash: tx });
  console.log(`status    ${receipt.status}  block ${receipt.blockNumber}  gas used ${receipt.gasUsed}`);
  const now = await client.getCode({ address: predicted });
  if (!now || now === "0x") throw new Error("Transaction landed but the vault has no code");
  console.log("Vault deployed. No agent permission was changed and no grant was touched.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Failed");
  process.exitCode = 1;
});
