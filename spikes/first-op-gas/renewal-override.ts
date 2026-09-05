/**
 * WHICH REFUSAL DOES A RENEWAL ACTUALLY GET — gas-absurd, OR gas-unreadable?
 *
 * worker/src/executor.ts:389-398 picks the ceiling BEFORE it estimates, because
 * the simulation's balance override is sized from that ceiling:
 *
 *   stateOverride: [{ address, balance: bounds.absoluteMax * feeCeiling * 2n }]
 *
 * A renewal on a live account takes the GAS_BOUNDS branch, so the simulation is
 * handed 3,000,000 x feeCeiling x 2 = 6,000,000 gas' worth of imaginary ETH —
 * while the operation it is simulating needs roughly 7.4M. If that is short, the
 * EntryPoint's prefund check fails inside the SIMULATION, the bundler answers
 * AA21 instead of a number, boundGas is handed null, and the refusal is
 * `gas-unreadable` — the exact opaque shape PR #56 was written to end — rather
 * than the honest `gas-absurd`.
 *
 * This measures both sizings against the SAME walled operation.
 *
 * NOTHING IS SIGNED AND NOTHING IS BROADCAST. eth_estimateUserOperationGas is a
 * simulation; the balance override lives only inside that RPC call. Keys are
 * generated here, never funded, never written to disk.
 *
 * Run: railway run --service orchestrator -- npx tsx spikes/first-op-gas/renewal-override.ts
 */
import { createPublicClient, encodeFunctionData, erc20Abi, http, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getEntryPoint, KERNEL_V3_3 } from "@zerodev/sdk/constants";
import { createKernelAccount } from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { toPermissionValidator } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import {
  buildWallPolicies, CASH, chainForId, pimlicoBundlerUrl, UNISWAP, WALL_POLICY_FLAG,
} from "../../packages/core/src/index";

const CHAIN_ID = 4663;
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const CAPS = { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 };

async function rpc(url: string, method: string, params: unknown[]) {
  const r = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await r.json()) as { result?: Record<string, string>; error?: { message?: string; code?: unknown } };
}

async function main() {
  const apiKey = process.env.MERRYMEN_BUNDLER_API_KEY;
  if (!apiKey) { console.error("run under: railway run --service orchestrator --"); process.exit(1); }
  const bundler = pimlicoBundlerUrl(CHAIN_ID, apiKey);
  const chain = chainForId(CHAIN_ID);
  const publicClient = createPublicClient({ chain, transport: http(RPC) });
  const entryPoint = getEntryPoint("0.7");
  const ep = entryPoint.address;

  // The executor's own feeCeiling, read exactly as executor.ts:381-384 does.
  const feeCeiling = await publicClient.estimateFeesPerGas().then((f) => f.maxFeePerGas).catch(() => 5_000_000_000n);
  const fees = await publicClient.estimateFeesPerGas().catch(() => null);
  const maxFeePerGas = fees?.maxFeePerGas ?? 1_000_000_000n;
  const maxPriorityFeePerGas = fees?.maxPriorityFeePerGas ?? 1_000_000n;
  console.log(`chain ${CHAIN_ID} · feeCeiling ${feeCeiling} wei/gas (${(Number(feeCeiling) / 1e9).toFixed(6)} gwei)`);

  const owner = privateKeyToAccount(generatePrivateKey());
  const ecdsa = await signerToEcdsaValidator(publicClient, { signer: owner, entryPoint, kernelVersion: KERNEL_V3_3 });
  const sudoOnly = await createKernelAccount(publicClient, { entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ecdsa } });
  const sessionSigner = await toECDSASigner({ signer: privateKeyToAccount(generatePrivateKey()) });
  const { policies } = buildWallPolicies({ caps: CAPS, smartAccount: sudoOnly.address });
  const permission = await toPermissionValidator(publicClient, {
    entryPoint, kernelVersion: KERNEL_V3_3, signer: sessionSigner, policies, flag: WALL_POLICY_FLAG,
  });
  const account = await createKernelAccount(publicClient, {
    entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ecdsa, regular: permission },
  });
  const sender = account.address as Address;

  const callData = await account.encodeCalls([{
    to: CASH.USDG as Address, value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [UNISWAP.swapRouter02 as Address, 5_000_000n] }),
  }]);
  const factoryArgs = await account.getFactoryArgs();
  const nonce = await account.getNonce();
  const stub = await account.getStubSignature({
    sender, nonce, callData, callGasLimit: 0n, verificationGasLimit: 0n, preVerificationGas: 0n,
    maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, signature: "0x", ...factoryArgs,
  } as never);
  const op = {
    sender, nonce: `0x${nonce.toString(16)}`,
    factory: factoryArgs.factory, factoryData: factoryArgs.factoryData,
    callData, signature: stub,
    maxFeePerGas: `0x${maxFeePerGas.toString(16)}`,
    maxPriorityFeePerGas: `0x${maxPriorityFeePerGas.toString(16)}`,
  };
  console.log(`walled account ${sender} · nonce mode 0x${((nonce >> 248n) & 0xffn).toString(16).padStart(2, "0")} vType 0x${((nonce >> 240n) & 0xffn).toString(16).padStart(2, "0")}`);

  // The two sizings executor.ts can produce, and nothing else changes.
  const sizings: Array<[string, bigint]> = [
    ["FIRST_ENABLE_GAS_BOUNDS 12,000,000 (what an undeployed first op gets)", 12_000_000n],
    ["GAS_BOUNDS            3,000,000 (what a RENEWAL on a live account gets)", 3_000_000n],
  ];
  console.log(`\n── SAME OPERATION, OVERRIDE SIZED FROM EACH CEILING (ceiling x feeCeiling x 2) ──`);
  for (const [label, ceiling] of sizings) {
    const balance = ceiling * feeCeiling * 2n;
    const r = await rpc(bundler, "eth_estimateUserOperationGas", [
      op, ep, { [sender]: { balance: `0x${balance.toString(16)}` } },
    ]);
    if (r.error) {
      console.log(`  ${label}`);
      console.log(`    override ${balance} wei (buys ${balance / maxFeePerGas} gas)`);
      console.log(`    -> REFUSED BY THE BUNDLER: ${String(r.error.code ?? "")} ${(r.error.message ?? "").slice(0, 160)}`);
      console.log(`    -> boundGas gets null  =>  rule "gas-unreadable"`);
      continue;
    }
    const n = (k: string) => (r.result?.[k] === undefined ? 0n : BigInt(r.result[k]!));
    const call = n("callGasLimit"), ver = n("verificationGasLimit"), pre = n("preVerificationGas");
    const raw = call + ver + pre;
    // executor's per-field headroom (gas-limits.ts:118-127) — identical on both bounds.
    const bounded = (call * 20_000n) / 10_000n + (ver * 12_500n) / 10_000n + (pre * 12_500n) / 10_000n;
    console.log(`  ${label}`);
    console.log(`    override ${balance} wei (buys ${balance / maxFeePerGas} gas)`);
    console.log(`    -> verif ${ver} · preVerif ${pre} · call ${call} · raw ${raw}`);
    console.log(`    -> bounded ${bounded} vs ceiling ${ceiling}  =>  ${bounded > ceiling ? `rule "gas-absurd" (REFUSED)` : "accepted"}`);
  }

  console.log(`\n── FOR REFERENCE: the deploy's share, so the renewal can be bounded below ──`);
  const sudoNonce = await sudoOnly.getNonce();
  const sudoFactory = await sudoOnly.getFactoryArgs();
  const sudoCallData = await sudoOnly.encodeCalls([{
    to: CASH.USDG as Address, value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [UNISWAP.swapRouter02 as Address, 5_000_000n] }),
  }]);
  const sudoStub = await sudoOnly.getStubSignature({
    sender: sudoOnly.address, nonce: sudoNonce, callData: sudoCallData,
    callGasLimit: 0n, verificationGasLimit: 0n, preVerificationGas: 0n,
    maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, signature: "0x", ...sudoFactory,
  } as never);
  const g = await rpc(bundler, "eth_estimateUserOperationGas", [
    {
      sender: sudoOnly.address, nonce: `0x${sudoNonce.toString(16)}`,
      factory: sudoFactory.factory, factoryData: sudoFactory.factoryData,
      callData: sudoCallData, signature: sudoStub,
      maxFeePerGas: `0x${maxFeePerGas.toString(16)}`, maxPriorityFeePerGas: `0x${maxPriorityFeePerGas.toString(16)}`,
    },
    ep,
    { [sudoOnly.address]: { balance: `0x${(12_000_000n * feeCeiling * 2n).toString(16)}` } },
  ]);
  if (g.error) console.log(`  sudo-only deploy+approve: REFUSED — ${(g.error.message ?? "").slice(0, 120)}`);
  else {
    const n = (k: string) => (g.result?.[k] === undefined ? 0n : BigInt(g.result[k]!));
    const raw = n("callGasLimit") + n("verificationGasLimit") + n("preVerificationGas");
    console.log(`  sudo-only deploy+approve raw total: ${raw}`);
    console.log(`  => the ENTIRE deploy costs at most ${raw}, so a renewal (enable, no deploy) is at least`);
    console.log(`     (walled raw) - ${raw}, which is still far past the 3,000,000 ceiling.`);
  }
}

main().catch((e) => { console.error("failed:", e instanceof Error ? e.message : String(e)); process.exit(1); });
