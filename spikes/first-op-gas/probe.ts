/**
 * WHY AA21, AND DOES A BALANCE OVERRIDE FIX IT?
 *
 * Twenty-four consecutive live swap attempts by tenant 0x42773b died on
 * `AA21 didn't pay prefund` during ESTIMATION — before anything was signed or
 * sent. `boundGas` never received a number, so the three limits were never
 * logged and the 8M ceiling was never reached.
 *
 * THE HYPOTHESIS. viem's `estimateUserOperationGas` prepares only
 * `factory, fees, nonce, paymaster, signature` — never `gas` — and passes no
 * `stateOverride`. So the operation reaches Pimlico with NO gas limits at all,
 * Pimlico substitutes its own for the simulation, and the EntryPoint's prefund
 * check then runs against the account's real balance. On chain 4663 the block
 * gas limit is 1.125e15, so a bundler seeding a search from it demands a
 * prefund no account could ever hold. If that is what is happening, the account
 * is underfunded for the SIMULATION, not for the operation.
 *
 * WHAT THIS PROBE DOES. Builds a throwaway Kernel account with the identical
 * wall shape (same buildWallPolicies, same WALL_POLICY_FLAG, same
 * KERNEL_V3_3 / EntryPoint 0.7), confirms it is undeployed and holds nothing,
 * and asks Pimlico to estimate the same shape of first operation twice: once as
 * the worker asks today, and once with a balance-only `stateOverride`.
 *
 * NOTHING IS SIGNED AND NOTHING IS BROADCAST. `eth_estimateUserOperationGas` is
 * a simulation. The keys are generated here, used for nothing else, never
 * written to disk, and never funded. The override exists only inside the
 * estimation RPC call — it cannot reach a signed operation, because this script
 * never produces one.
 *
 * Run: railway run --service orchestrator -- npx tsx spikes/first-op-gas/probe.ts
 * (railway supplies MERRYMEN_BUNDLER_API_KEY; the Pimlico host is public.)
 */
import { createPublicClient, encodeFunctionData, erc20Abi, http, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getEntryPoint, KERNEL_V3_3 } from "@zerodev/sdk/constants";
import { createKernelAccount } from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { toPermissionValidator } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import {
  buildWallPolicies,
  CASH,
  chainForId,
  pimlicoBundlerUrl,
  UNISWAP,
  STOCK_TOKENS,
  TRADEABLE_SYMBOLS,
  UNISWAP_SWAP_ROUTER_ABI,
  WALL_POLICY_FLAG,
} from "../../packages/core/src/index";

const CHAIN_ID = 4663;
const RPC = "https://rpc.mainnet.chain.robinhood.com";

/** The landed-deploy anchors, decoded from handleOps calldata on 4663. */
const LANDED = {
  verificationGasLimit: 358_217n,
  callGasLimit: 50_180n,
  preVerificationGas: 54_538n,
  signedTotal: 462_935n,
  actualGasUsed: 359_497n,
  note: "owner-signed sudo deploy + ERC-20 transfer (tx 0xc6562c38…, block 51207025)",
};

const gwei = (n: bigint) => `${(Number(n) / 1e9).toFixed(6)} gwei`;

async function rpc(url: string, method: string, params: unknown[]): Promise<{ result?: unknown; error?: unknown }> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await r.json()) as { result?: unknown; error?: unknown };
}

function errText(e: unknown): string {
  const o = e as { message?: string; data?: unknown; code?: unknown } | null;
  const parts = [o?.code !== undefined ? `code ${String(o.code)}` : "", o?.message ?? "", typeof o?.data === "string" ? o.data : ""];
  return parts.filter(Boolean).join(" · ").slice(0, 400);
}

async function main() {
  const apiKey = process.env.MERRYMEN_BUNDLER_API_KEY;
  if (!apiKey) {
    console.error("no MERRYMEN_BUNDLER_API_KEY — run this under `railway run --service orchestrator --`");
    process.exit(1);
  }
  const bundler = pimlicoBundlerUrl(CHAIN_ID, apiKey);
  console.log(`bundler host: ${new URL(bundler).host} (key present, ${apiKey.length} chars — value never printed)`);

  const chain = chainForId(CHAIN_ID);
  const publicClient = createPublicClient({ chain, transport: http(RPC) });
  const entryPoint = getEntryPoint("0.7");

  // ── a throwaway account with the REAL wall shape ────────────────────────
  const ownerKey = generatePrivateKey();
  const owner = privateKeyToAccount(ownerKey);
  const ecdsa = await signerToEcdsaValidator(publicClient, { signer: owner, entryPoint, kernelVersion: KERNEL_V3_3 });
  const sudoOnly = await createKernelAccount(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    plugins: { sudo: ecdsa },
  });

  const sessionKey = generatePrivateKey();
  const sessionSigner = await toECDSASigner({ signer: privateKeyToAccount(sessionKey) });
  const { policies } = buildWallPolicies({
    caps: { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 },
    smartAccount: sudoOnly.address,
  });
  const permission = await toPermissionValidator(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    signer: sessionSigner,
    policies,
    flag: WALL_POLICY_FLAG,
  });
  const account = await createKernelAccount(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    plugins: { sudo: ecdsa, regular: permission },
  });

  const sender = account.address as Address;
  const code = await publicClient.getCode({ address: sender }).catch(() => undefined);
  const balance = await publicClient.getBalance({ address: sender }).catch(() => null);
  console.log(`\nsynthetic account ${sender}`);
  console.log(`  deployed: ${code && code !== "0x" ? "YES (unexpected)" : "NO — counterfactual, as required"}`);
  console.log(`  balance:  ${balance === null ? "unread" : `${balance} wei`}`);
  if (balance !== null && balance !== 0n) console.log("  NOTE: not zero — this address has been used before");

  // ── the same first operation the worker builds: approve + exactInputSingle ─
  const amountIn = 5_000_000n; // 5 USDG
  const minOut = 1n;
  // WALL-LEGAL BOTH LEGS. buildCallPermissions pins tokenIn and tokenOut to
  // ONE_OF adapterAssets = USDG + the TRADEABLE stock tokens. WETH is NOT in
  // that set, so a WETH leg is refused by the permission validator itself —
  // which is the wall working, and not the thing this probe is measuring.
  const outToken = STOCK_TOKENS.find((t) => (TRADEABLE_SYMBOLS as readonly string[]).includes(t.symbol))!
    .address as Address;
  console.log(`  swapping USDG -> ${STOCK_TOKENS.find((t) => t.address === outToken)!.symbol} (both legs in adapterAssets)`);
  const calls = [
    {
      to: CASH.USDG as Address,
      value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [UNISWAP.swapRouter02 as Address, amountIn] }),
    },
    {
      to: UNISWAP.swapRouter02 as Address,
      value: 0n,
      data: encodeFunctionData({
        abi: UNISWAP_SWAP_ROUTER_ABI,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: CASH.USDG as Address,
            tokenOut: outToken,
            fee: 500,
            recipient: sender,
            amountIn,
            amountOutMinimum: minOut,
            sqrtPriceLimitX96: 0n,
          } as never,
        ],
      }),
    },
  ];
  const callData = await account.encodeCalls(calls);

  const factoryArgs = await account.getFactoryArgs();
  const nonce = await account.getNonce();
  // The permission validator derives its stub from the operation (the
  // plugin-enable blob is signed over the op), so it must be handed one.
  const stub = await account.getStubSignature({
    sender,
    nonce,
    callData,
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    maxFeePerGas: 0n,
    maxPriorityFeePerGas: 0n,
    signature: "0x",
    ...factoryArgs,
  } as never);

  // Fees from the chain, in the same shape the worker signs against.
  const fees = await publicClient.estimateFeesPerGas().catch(() => null);
  const maxFeePerGas = fees?.maxFeePerGas ?? 1_000_000_000n;
  const maxPriorityFeePerGas = fees?.maxPriorityFeePerGas ?? 1_000_000n;

  const userOp = {
    sender,
    nonce: `0x${nonce.toString(16)}`,
    factory: factoryArgs.factory,
    factoryData: factoryArgs.factoryData,
    callData,
    maxFeePerGas: `0x${maxFeePerGas.toString(16)}`,
    maxPriorityFeePerGas: `0x${maxPriorityFeePerGas.toString(16)}`,
    signature: stub,
  };

  console.log(`\n── THE OPERATION SENT FOR ESTIMATION ─────────────────────────`);
  console.log(`  sender                ${userOp.sender}`);
  console.log(`  nonce                 ${nonce}`);
  console.log(`  factory               ${userOp.factory}`);
  console.log(`  factoryData           ${String(userOp.factoryData).length / 2 - 1} bytes`);
  console.log(`  callData              ${callData.length / 2 - 1} bytes (approve + exactInputSingle)`);
  console.log(`  signature (stub)      ${stub.length / 2 - 1} bytes  ← the plugin-enable blob`);
  console.log(`  maxFeePerGas          ${gwei(maxFeePerGas)}`);
  console.log(`  maxPriorityFeePerGas  ${gwei(maxPriorityFeePerGas)}`);
  console.log(`  callGasLimit          (ABSENT — viem never sends one)`);
  console.log(`  verificationGasLimit  (ABSENT)`);
  console.log(`  preVerificationGas    (ABSENT)`);
  console.log(`  stateOverride         (ABSENT)`);

  const ep = entryPoint.address;

  // ── 1. exactly as the worker asks today ────────────────────────────────
  console.log(`\n── 1. ESTIMATE AS THE WORKER ASKS TODAY (no override) ────────`);
  const a = await rpc(bundler, "eth_estimateUserOperationGas", [userOp, ep]);
  if (a.error) console.log(`  REFUSED: ${errText(a.error)}`);
  else console.log(`  ${JSON.stringify(a.result)}`);

  // ── 2. the same op, with a balance-only override ───────────────────────
  console.log(`\n── 2. SAME OP, balance-only stateOverride (1 ETH) ────────────`);
  // Pimlico rejected the array form with "expected object, received array at
  // params[2]", so the shape is the eth_call one: keyed by address.
  const override = { [sender]: { balance: `0x${parseEther("1").toString(16)}` } };
  const b = await rpc(bundler, "eth_estimateUserOperationGas", [userOp, ep, override]);
  if (b.error) console.log(`  REFUSED: ${errText(b.error)}`);
  else console.log(`  ${JSON.stringify(b.result)}`);

  // ── 3. does Pimlico honour the override at all, or ignore it? ──────────
  // An override of a DIFFERENT, irrelevant address should change nothing. If
  // result 2 differs from result 1 but result 3 matches result 1, the override
  // is genuinely being applied rather than the difference being noise.
  console.log(`\n── 3. CONTROL: override an unrelated address ─────────────────`);
  const control = { "0x000000000000000000000000000000000000dEaD": { balance: `0x${parseEther("1").toString(16)}` } };
  const c = await rpc(bundler, "eth_estimateUserOperationGas", [userOp, ep, control]);
  if (c.error) console.log(`  REFUSED: ${errText(c.error)}`);
  else console.log(`  ${JSON.stringify(c.result)}`);

  // ── 4. the fallback, if Pimlico will not override ──────────────────────
  // simulateHandleOp against the chain RPC with the same override. This does
  // not need the bundler at all.
  console.log(`\n── 4. FALLBACK: EntryPoint.simulateHandleOp via eth_call + override ──`);
  const d = await rpc(RPC, "eth_call", [
    { to: ep, data: "0x", from: "0x0000000000000000000000000000000000000000" },
    "latest",
    { [sender]: { balance: `0x${parseEther("1").toString(16)}` } },
  ]);
  console.log(`  does this RPC accept a 3rd state-override param at all? ${d.error ? `NO — ${errText(d.error)}` : "YES (empty call returned)"}`);

  // ── 5. REAL NUMBERS: balance override + a callData that needs no funds ──
  // The swap above reverts on the synthetic account for a legitimate reason —
  // it holds no USDG (STF = SAFE_TRANSFER_FROM_FAILED). An approve costs no
  // balance, so this isolates the terms that actually dominate a first op:
  // the account deployment, the plugin-enable, and the enable-signature check.
  console.log(`
── 5. balance override + approve-only callData (needs no USDG) ──`);
  const approveOnly = await account.encodeCalls([calls[0]!]);
  const stub2 = await account.getStubSignature({
    sender, nonce, callData: approveOnly,
    callGasLimit: 0n, verificationGasLimit: 0n, preVerificationGas: 0n,
    maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, signature: "0x", ...factoryArgs,
  } as never);
  const e = await rpc(bundler, "eth_estimateUserOperationGas", [
    { ...userOp, callData: approveOnly, signature: stub2 },
    ep,
    override,
  ]);
  if (e.error) console.log(`  REFUSED: ${errText(e.error)}`);
  else console.log(`  ${JSON.stringify(e.result)}`);

  // ── 6. DOES THE ESTIMATE SCALE WITH THE OVERRIDDEN BALANCE? ────────────
  // If it does, then 1 ETH is not a neutral simulation aid — it hands the
  // bundler an unbounded search space (block gas limit on 4663 is 1.125e15) and
  // the number that comes back describes the override, not the operation.
  // The right override would then be the SMALLEST one that clears the prefund
  // for the gas WE are willing to sign, so the estimate stays inside our policy.
  const read = (r: { result?: unknown }) => {
    const o = r.result as Record<string, string> | undefined;
    if (!o) return null;
    const n2 = (k: string) => (o[k] === undefined ? 0n : BigInt(o[k]));
    const call = n2("callGasLimit"), ver = n2("verificationGasLimit"), pre = n2("preVerificationGas");
    return { call, ver, pre, total: call + ver + pre };
  };
  console.log(`
── 6. estimate vs overridden balance (approve-only) ───────────`);
  for (const eth of ["0.003738797702007072", "0.01", "0.05", "0.2", "1"]) {
    const wei = BigInt(Math.round(Number(eth) * 1e18));
    const r = await rpc(bundler, "eth_estimateUserOperationGas", [
      { ...userOp, callData: approveOnly, signature: stub2 },
      ep,
      { [sender]: { balance: `0x${wei.toString(16)}` } },
    ]);
    const v = read(r);
    const affordable = wei / maxFeePerGas;
    console.log(
      `  ${eth.padEnd(22)} ETH (buys ${String(affordable).padStart(12)} gas) -> ` +
        (v ? `verif ${String(v.ver).padStart(9)} · preVerif ${String(v.pre).padStart(7)} · raw ${v.total}` : `REFUSED: ${errText(r.error).slice(0, 60)}`),
    );
  }

  // ── 7. DECOMPOSE: how much of the 7.4M is the DEPLOY, and how much the
  //       PLUGIN-ENABLE? The two landed ops on 4663 were sudo-only (65-byte
  //       signature, no permission validator) and signed 462,935 total. Estimate
  //       the identical deploy WITHOUT the wall, and the difference is the
  //       enable.
  console.log(`
── 7. sudo-only deploy (no wall) vs the same deploy WITH the wall ──`);
  const sudoNonce = await sudoOnly.getNonce();
  const sudoFactory = await sudoOnly.getFactoryArgs();
  const sudoCallData = await sudoOnly.encodeCalls([calls[0]!]);
  const sudoStub = await sudoOnly.getStubSignature({
    sender: sudoOnly.address, nonce: sudoNonce, callData: sudoCallData,
    callGasLimit: 0n, verificationGasLimit: 0n, preVerificationGas: 0n,
    maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, signature: "0x", ...sudoFactory,
  } as never);
  console.log(`  sudo-only stub signature: ${sudoStub.length / 2 - 1} bytes (vs ${stub2.length / 2 - 1} with the wall)`);
  const g = await rpc(bundler, "eth_estimateUserOperationGas", [
    {
      sender: sudoOnly.address, nonce: `0x${sudoNonce.toString(16)}`,
      factory: sudoFactory.factory, factoryData: sudoFactory.factoryData,
      callData: sudoCallData, signature: sudoStub,
      maxFeePerGas: `0x${maxFeePerGas.toString(16)}`,
      maxPriorityFeePerGas: `0x${maxPriorityFeePerGas.toString(16)}`,
    },
    ep,
    { [sudoOnly.address]: { balance: `0x${parseEther("1").toString(16)}` } },
  ]);
  const sv = read(g);
  if (sv) {
    console.log(`  sudo-only (deploy + approve):  verif ${sv.ver} · preVerif ${sv.pre} · call ${sv.call} · raw ${sv.total}`);
    const wv = read(e);
    if (wv) {
      console.log(`  with wall (deploy + enable + approve): verif ${wv.ver} · preVerif ${wv.pre} · call ${wv.call} · raw ${wv.total}`);
      console.log(`  >>> THE WALL ENABLE COSTS: verif +${wv.ver - sv.ver} · preVerif +${wv.pre - sv.pre} · raw +${wv.total - sv.total}`);
    }
  } else console.log(`  REFUSED: ${errText(g.error)}`);

  // ── comparison ─────────────────────────────────────────────────────────
  console.log(`\n── COMPARISON ────────────────────────────────────────────────`);
  // (declared above experiment 6)
  const _unusedRead = (r: { result?: unknown }) => {
    const o = r.result as Record<string, string> | undefined;
    if (!o) return null;
    const n = (k: string) => (o[k] === undefined ? 0n : BigInt(o[k]));
    const call = n("callGasLimit");
    const ver = n("verificationGasLimit");
    const pre = n("preVerificationGas");
    return { call, ver, pre, total: call + ver + pre };
  };
  const withOut = read(a);
  const withOv = read(b);
  const row = (label: string, v: { call: bigint; ver: bigint; pre: bigint; total: bigint } | null) =>
    console.log(
      `  ${label.padEnd(28)} ${v ? `call ${v.call} · verif ${v.ver} · preVerif ${v.pre} · raw total ${v.total} · ×2 headroom ${v.total * 2n}` : "REFUSED"}`,
    );
  row("no override", withOut);
  row("balance override (swap)", withOv);
  row("balance override (approve)", read(e));
  console.log(
    `  ${"landed sudo deploy".padEnd(28)} call ${LANDED.callGasLimit} · verif ${LANDED.verificationGasLimit} · preVerif ${LANDED.preVerificationGas} · signed ${LANDED.signedTotal} · used ${LANDED.actualGasUsed}`,
  );
  console.log(`    (${LANDED.note})`);
  if (withOv) {
    const signed = withOv.total * 2n;
    console.log(`\n  DEPLOY_GAS_BOUNDS.absoluteMax is 8,000,000.`);
    console.log(`  This op signs ${signed} — ${signed > 8_000_000n ? "OVER the ceiling" : `${((Number(signed) / 8e6) * 100).toFixed(1)}% of it`}.`);
    console.log(`  ETH required to hold: ${signed} × ${gwei(maxFeePerGas)} = ${(Number(signed * maxFeePerGas) / 1e18).toFixed(6)} ETH`);
  }
}

main().catch((e) => {
  console.error("probe failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
