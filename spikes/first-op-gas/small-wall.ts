/**
 * MEASURE A SMALLER WALL, rather than extrapolating from the extras slope.
 *
 * The extras sweep gave ~342k gas per additional permitted token, consistently
 * across two points. If that slope holds downward, trimming the tradeable set is
 * the single largest lever on the ~7.06M enable cost. Extrapolation is not
 * measurement, so this builds the call policy directly from a FILTERED
 * permission list and estimates it.
 *
 * Nothing signed, nothing broadcast.
 */
import { createPublicClient, encodeFunctionData, erc20Abi, http, parseEther, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getEntryPoint, KERNEL_V3_3 } from "@zerodev/sdk/constants";
import { createKernelAccount } from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { toPermissionValidator } from "@zerodev/permissions";
import { toCallPolicy, toTimestampPolicy, CallPolicyVersion } from "@zerodev/permissions/policies";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { buildCallPermissions, CASH, chainForId, pimlicoBundlerUrl, UNISWAP } from "../../packages/core/src/index";

const CAPS = { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 };

async function rpc(url: string, params: unknown[]) {
  const r = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_estimateUserOperationGas", params }),
  });
  return (await r.json()) as { result?: Record<string, string>; error?: { message?: string; code?: unknown } };
}

async function main() {
  const apiKey = process.env.MERRYMEN_BUNDLER_API_KEY;
  if (!apiKey) { console.error("run under railway run"); process.exit(1); }
  const bundler = pimlicoBundlerUrl(4663, apiKey);
  const publicClient = createPublicClient({ chain: chainForId(4663), transport: http("https://rpc.mainnet.chain.robinhood.com") });
  const entryPoint = getEntryPoint("0.7");
  const fees = await publicClient.estimateFeesPerGas().catch(() => null);
  const maxFee = fees?.maxFeePerGas ?? 1_000_000_000n;
  console.log(`maxFeePerGas ${(Number(maxFee) / 1e9).toFixed(6)} gwei\n`);

  const owner = privateKeyToAccount(generatePrivateKey());
  const ecdsa = await signerToEcdsaValidator(publicClient, { signer: owner, entryPoint, kernelVersion: KERNEL_V3_3 });
  const sudoOnly = await createKernelAccount(publicClient, { entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ecdsa } });

  const all = buildCallPermissions(CAPS, sudoOnly.address, {});
  console.log(`full wall: ${all.length} permissions`);

  const now = Math.floor(Date.now() / 1000);
  for (const keep of [all.length, 8, 5, 3, 2]) {
    const perms = all.slice(0, keep);
    const policies = [
      toTimestampPolicy({ validAfter: now, validUntil: now + 14 * 86400 }),
      toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions: perms as never }),
    ];
    const sess = await toECDSASigner({ signer: privateKeyToAccount(generatePrivateKey()) });
    const pv = await toPermissionValidator(publicClient, { entryPoint, kernelVersion: KERNEL_V3_3, signer: sess, policies, flag: "0x0002" });
    const account = await createKernelAccount(publicClient, { entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ecdsa, regular: pv } });

    const sender = account.address as Address;
    const callData = await account.encodeCalls([{
      to: CASH.USDG as Address, value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [UNISWAP.swapRouter02 as Address, 5_000_000n] }),
    }]);
    const fa = await account.getFactoryArgs();
    const nonce = await account.getNonce();
    const stub = await account.getStubSignature({
      sender, nonce, callData, callGasLimit: 0n, verificationGasLimit: 0n, preVerificationGas: 0n,
      maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, signature: "0x", ...fa,
    } as never);
    const r = await rpc(bundler, [
      { sender, nonce: `0x${nonce.toString(16)}`, factory: fa.factory, factoryData: fa.factoryData, callData, signature: stub,
        maxFeePerGas: `0x${maxFee.toString(16)}`, maxPriorityFeePerGas: `0x${(fees?.maxPriorityFeePerGas ?? 0n).toString(16)}` },
      entryPoint.address,
      { [sender]: { balance: `0x${parseEther("1").toString(16)}` } },
    ]);
    if (r.error) { console.log(`  ${String(keep).padStart(2)} permissions  REFUSED — ${String(r.error.code)} ${r.error.message?.slice(0, 60)}`); continue; }
    const o = r.result!;
    const n = (k: string) => BigInt(o[k] ?? "0x0");
    const raw = n("callGasLimit") + n("verificationGasLimit") + n("preVerificationGas");
    console.log(
      `  ${String(keep).padStart(2)} permissions  verif ${String(n("verificationGasLimit")).padStart(9)} · raw ${String(raw).padStart(9)} · ` +
      `×2 ${String(raw * 2n).padStart(10)} · ${(Number(raw * 2n * maxFee) / 1e18).toFixed(6)} ETH · stub ${stub.length / 2 - 1}B` +
      `${raw * 2n <= 8_000_000n ? "   <= UNDER the 8M ceiling" : ""}`,
    );
  }
}
main().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
