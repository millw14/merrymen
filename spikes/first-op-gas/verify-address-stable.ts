/** READ-ONLY. Does a RENEWAL change the smart-account address?
 * Derives the Kernel v3.3 account from ONE throwaway owner key three ways:
 * sudo-only, sudo+wall(session key A), sudo+wall(session key B).
 * Only eth_call (getSenderAddress). Nothing signed, sent, funded or deployed. */
import { createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getEntryPoint, KERNEL_V3_3 } from "@zerodev/sdk/constants";
import { createKernelAccount } from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { toPermissionValidator } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { buildWallPolicies, chainForId, WALL_POLICY_FLAG } from "../../packages/core/src/index";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const caps = { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 };

async function main() {
  const publicClient = createPublicClient({ chain: chainForId(4663), transport: http(RPC) });
  const entryPoint = getEntryPoint("0.7");
  const owner = privateKeyToAccount(generatePrivateKey());
  const ecdsa = await signerToEcdsaValidator(publicClient, { signer: owner, entryPoint, kernelVersion: KERNEL_V3_3 });
  const sudoOnly = await createKernelAccount(publicClient, { entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ecdsa } });
  console.log("sudo-only address        ", sudoOnly.address);

  const walled = async (label: string) => {
    const sk = privateKeyToAccount(generatePrivateKey());
    const signer = await toECDSASigner({ signer: sk });
    const { policies } = buildWallPolicies({ caps, smartAccount: sudoOnly.address });
    const permission = await toPermissionValidator(publicClient, {
      entryPoint, kernelVersion: KERNEL_V3_3, signer, policies, flag: WALL_POLICY_FLAG,
    });
    const acct = await createKernelAccount(publicClient, {
      entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ecdsa, regular: permission },
    });
    console.log(`${label} pId ${permission.getIdentifier()} address ${acct.address}  same-as-sudo-only? ${acct.address.toLowerCase() === sudoOnly.address.toLowerCase() ? "YES" : "NO"}`);
    return acct.address;
  };
  const a = await walled("grant #1 (session key A)");
  await new Promise((r) => setTimeout(r, 1500));
  const b = await walled("grant #2 (session key B) = THE RENEWAL");
  console.log("\nRENEWAL CHANGES THE ADDRESS?", a.toLowerCase() === b.toLowerCase() ? "NO — identical" : "YES");
}
main().catch((e) => { console.error("FAILED (unread, not empty):", e); process.exit(1); });
