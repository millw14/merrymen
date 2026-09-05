/**
 * Can we PROVE, from the operation itself, that it carries a permission-validator
 * enable — rather than inferring it from "the account has no code"?
 *
 * Kernel v3 packs the validator mode into the nonce key:
 *   nonce = key(24 bytes) ‖ seq(8 bytes),  key = mode(1) ‖ vType(1) ‖ validator(20) ‖ id(2)
 * and @zerodev/sdk sets VALIDATOR_MODE.ENABLE (0x01) exactly when the regular
 * validator is not yet enabled on-chain (toKernelPluginManager.ts:388-395).
 *
 * If that holds, the nonce is a structural proof of the enable and the elevated
 * ceiling can be gated on it instead of on "undeployed", which is what the spec
 * asks for. Nothing signed, nothing broadcast.
 */
import { createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getEntryPoint, KERNEL_V3_3 } from "@zerodev/sdk/constants";
import { createKernelAccount } from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { toPermissionValidator } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { buildWallPolicies, chainForId } from "../../packages/core/src/index";

const CAPS = { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 };

/** The candidate predicate, exactly as it would ship. */
const modeOf = (nonce: bigint) => Number((nonce >> 248n) & 0xffn);

async function main() {
  const publicClient = createPublicClient({ chain: chainForId(4663), transport: http("https://rpc.mainnet.chain.robinhood.com") });
  const entryPoint = getEntryPoint("0.7");
  const owner = privateKeyToAccount(generatePrivateKey());
  const ecdsa = await signerToEcdsaValidator(publicClient, { signer: owner, entryPoint, kernelVersion: KERNEL_V3_3 });

  const sudoOnly = await createKernelAccount(publicClient, { entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ecdsa } });
  const sudoNonce = await sudoOnly.getNonce();
  console.log(`sudo-only  nonce 0x${sudoNonce.toString(16).padStart(64, "0")}`);
  console.log(`           top byte (mode) = 0x${modeOf(sudoNonce).toString(16).padStart(2, "0")}`);

  const sess = await toECDSASigner({ signer: privateKeyToAccount(generatePrivateKey()) });
  const { policies } = buildWallPolicies({ caps: CAPS, smartAccount: sudoOnly.address });
  const pv = await toPermissionValidator(publicClient, { entryPoint, kernelVersion: KERNEL_V3_3, signer: sess, policies, flag: "0x0002" });
  const walled = await createKernelAccount(publicClient, { entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ecdsa, regular: pv } });
  const wallNonce = await walled.getNonce();
  console.log(`walled     nonce 0x${wallNonce.toString(16).padStart(64, "0")}`);
  console.log(`           top byte (mode) = 0x${modeOf(wallNonce).toString(16).padStart(2, "0")}`);

  console.log("");
  console.log(`sudo-only is ENABLE-mode?  ${modeOf(sudoNonce) === 1 ? "YES" : "no"}   (want: no)`);
  console.log(`walled    is ENABLE-mode?  ${modeOf(wallNonce) === 1 ? "YES" : "no"}   (want: YES)`);
  console.log(`\n=> the nonce ${modeOf(wallNonce) === 1 && modeOf(sudoNonce) !== 1 ? "IS" : "is NOT"} a usable structural proof of the enable`);
}
main().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
