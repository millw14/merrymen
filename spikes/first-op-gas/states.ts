/**
 * WHICH EXECUTION STATE COSTS THE 7.7M, AND WHAT DRIVES IT?
 *
 * The first probe established that a merrymen agent's first UserOperation
 * estimates at 7,711,654 raw gas, of which 7,059,814 is the permission-validator
 * plugin-enable. This one answers the two questions that decide what to do about
 * it:
 *
 *   1. Is the cost ONE-OFF (only the first op of a session key) or does every
 *      trade carry it? That decides whether we need a separate first-op ceiling
 *      or a higher ceiling everywhere.
 *   2. What inside the enable actually costs the gas — the number of call
 *      permissions, the two ONE_OF address lists, or the plugin install itself?
 *      That decides whether the wall can be made cheaper without weakening it.
 *
 * Everything here is `eth_estimateUserOperationGas`, which is a simulation.
 * NOTHING IS SIGNED AND NOTHING IS BROADCAST. Keys are generated per run, used
 * for nothing else, never written to disk and never funded. The balance
 * override exists only inside the estimation RPC call.
 *
 * Run: railway run --service orchestrator -- npx tsx spikes/first-op-gas/states.ts
 */
import { createPublicClient, encodeFunctionData, erc20Abi, http, parseEther, type Address } from "viem";
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
  STOCK_TOKENS,
  TRADEABLE_SYMBOLS,
  UNISWAP,
} from "../../packages/core/src/index";

const CHAIN_ID = 4663;
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const CAPS = { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 };

async function rpc(url: string, method: string, params: unknown[]) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await r.json()) as { result?: Record<string, string>; error?: { message?: string; code?: unknown } };
}

interface Gas {
  call: bigint;
  ver: bigint;
  pre: bigint;
  raw: bigint;
}
const read = (r: { result?: Record<string, string> }): Gas | null => {
  const o = r.result;
  if (!o) return null;
  const n = (k: string) => (o[k] === undefined ? 0n : BigInt(o[k]));
  const call = n("callGasLimit");
  const ver = n("verificationGasLimit");
  const pre = n("preVerificationGas");
  return { call, ver, pre, raw: call + ver + pre };
};

async function main() {
  const apiKey = process.env.MERRYMEN_BUNDLER_API_KEY;
  if (!apiKey) {
    console.error("run under: railway run --service orchestrator --");
    process.exit(1);
  }
  const bundler = pimlicoBundlerUrl(CHAIN_ID, apiKey);
  const chain = chainForId(CHAIN_ID);
  const publicClient = createPublicClient({ chain, transport: http(RPC) });
  const entryPoint = getEntryPoint("0.7");
  const ep = entryPoint.address;

  const fees = await publicClient.estimateFeesPerGas().catch(() => null);
  const maxFeePerGas = fees?.maxFeePerGas ?? 1_000_000_000n;
  const eth = (gas: bigint) => (Number(gas * maxFeePerGas) / 1e18).toFixed(6);
  console.log(`chain ${CHAIN_ID} · maxFeePerGas ${(Number(maxFeePerGas) / 1e9).toFixed(6)} gwei\n`);

  /** Build an account, optionally with the wall, optionally with a trimmed token set. */
  async function build(opts: { wall: boolean; symbols?: readonly string[]; extraTokens?: number }) {
    const owner = privateKeyToAccount(generatePrivateKey());
    const ecdsa = await signerToEcdsaValidator(publicClient, {
      signer: owner,
      entryPoint,
      kernelVersion: KERNEL_V3_3,
    });
    const sudoOnly = await createKernelAccount(publicClient, {
      entryPoint,
      kernelVersion: KERNEL_V3_3,
      plugins: { sudo: ecdsa },
    });
    if (!opts.wall) return { account: sudoOnly, stubBytes: 65 };

    const sessionSigner = await toECDSASigner({ signer: privateKeyToAccount(generatePrivateKey()) });
    // Extra tokens widen the ONE_OF lists exactly as a tenant's customTokens do.
    const extras = Array.from({ length: opts.extraTokens ?? 0 }, (_, i) => ({
      // isValidCustomToken requires exactly {symbol, address, decimals} — my
      // first attempt passed the STOCK_TOKENS shape (name/chainlinkFeed/kind,
      // no decimals) and every entry was silently dropped, which made the sweep
      // look like the wall size did not matter when it had never been varied.
      symbol: `X${i}`,
      address: `0x${(i + 0x1000).toString(16).padStart(40, "0")}` as Address,
      decimals: 18,
    }));
    const { policies } = buildWallPolicies({
      caps: CAPS,
      smartAccount: sudoOnly.address,
      ...(extras.length ? { extraTokens: extras as never } : {}),
    });
    const permission = await toPermissionValidator(publicClient, {
      entryPoint,
      kernelVersion: KERNEL_V3_3,
      signer: sessionSigner,
      policies,
      flag: "0x0002",
    });
    const account = await createKernelAccount(publicClient, {
      entryPoint,
      kernelVersion: KERNEL_V3_3,
      plugins: { sudo: ecdsa, regular: permission },
    });
    return { account, stubBytes: 0 };
  }

  /** Estimate one op. `deployed` drops the factory, as a deployed account would. */
  async function estimate(
    account: Awaited<ReturnType<typeof build>>["account"],
    label: string,
    deployed: boolean,
  ): Promise<{ gas: Gas | null; stubBytes: number; err?: string }> {
    const sender = account.address as Address;
    const approve = await account.encodeCalls([
      {
        to: CASH.USDG as Address,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [UNISWAP.swapRouter02 as Address, 5_000_000n],
        }),
      },
    ]);
    const factoryArgs = await account.getFactoryArgs();
    const nonce = await account.getNonce();
    const stub = await account.getStubSignature({
      sender,
      nonce,
      callData: approve,
      callGasLimit: 0n,
      verificationGasLimit: 0n,
      preVerificationGas: 0n,
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
      signature: "0x",
      ...factoryArgs,
    } as never);
    const op: Record<string, unknown> = {
      sender,
      nonce: `0x${nonce.toString(16)}`,
      callData: approve,
      signature: stub,
      maxFeePerGas: `0x${maxFeePerGas.toString(16)}`,
      maxPriorityFeePerGas: `0x${(fees?.maxPriorityFeePerGas ?? 0n).toString(16)}`,
    };
    if (!deployed) {
      op.factory = factoryArgs.factory;
      op.factoryData = factoryArgs.factoryData;
    }
    const r = await rpc(bundler, "eth_estimateUserOperationGas", [
      op,
      ep,
      { [sender]: { balance: `0x${parseEther("1").toString(16)}` } },
    ]);
    const stubBytes = stub.length / 2 - 1;
    if (r.error) return { gas: null, stubBytes, err: `${String(r.error.code)} ${r.error.message ?? ""}`.slice(0, 120) };
    return { gas: read(r), stubBytes };
  }

  const row = (label: string, g: Gas | null, stub: number, err?: string) => {
    if (!g) {
      console.log(`  ${label.padEnd(46)} REFUSED — ${err ?? ""}`);
      return;
    }
    const signed = g.raw * 2n;
    console.log(
      `  ${label.padEnd(46)} verif ${String(g.ver).padStart(9)} · preVerif ${String(g.pre).padStart(7)} · ` +
        `call ${String(g.call).padStart(6)} · raw ${String(g.raw).padStart(9)} · ×2 ${String(signed).padStart(10)} · ` +
        `${eth(signed).padStart(9)} ETH · stub ${String(stub).padStart(6)}B`,
    );
  };

  // ── THE FOUR EXECUTION STATES ──────────────────────────────────────────
  console.log("── THE FOUR EXECUTION STATES (callData = one ERC-20 approve, held constant) ──");
  const wall = await build({ wall: true });
  const sudo = await build({ wall: false });

  const s1 = await estimate(wall.account, "1. undeployed + wall enable + call", false);
  row("1. undeployed + wall enable + call", s1.gas, s1.stubBytes, s1.err);

  const s2 = await estimate(sudo.account, "2a. undeployed, sudo only (no wall)", false);
  row("2a. undeployed, sudo only (no wall)", s2.gas, s2.stubBytes, s2.err);

  // "Deployed" is simulated by dropping the factory. The bundler then treats the
  // sender as an existing account; with a balance override and no code the
  // validation will fail, which is itself the answer for whether this state is
  // measurable without actually deploying.
  const s3 = await estimate(sudo.account, "3. deployed sudo, ordinary call", true);
  row("3. deployed sudo, ordinary call", s3.gas, s3.stubBytes, s3.err);

  const s4 = await estimate(wall.account, "4. deployed + wall, ordinary session op", true);
  row("4. deployed + wall, ordinary session op", s4.gas, s4.stubBytes, s4.err);

  if (s1.gas && s2.gas) {
    console.log(`\n  >>> WALL ENABLE COSTS: verif +${s1.gas.ver - s2.gas.ver} · preVerif +${s1.gas.pre - s2.gas.pre} · raw +${s1.gas.raw - s2.gas.raw}`);
  }

  // ── OPTION C: WHAT DRIVES THE ENABLE COST ──────────────────────────────
  console.log("\n── OPTION C: does the wall's SIZE drive it? (extra tokens widen both ONE_OF lists) ──");
  console.log(`  baseline TRADEABLE_SYMBOLS: ${TRADEABLE_SYMBOLS.length} · STOCK_TOKENS: ${STOCK_TOKENS.length}`);
  for (const extra of [0, 5, 15, 40]) {
    const b = await build({ wall: true, extraTokens: extra });
    const r = await estimate(b.account, `+${extra} tokens`, false);
    row(`wall with +${extra} extra token(s)`, r.gas, r.stubBytes, r.err);
  }

  console.log("\n── ANCHOR: the two real landed deploys on 4663 (sudo-only, decoded from handleOps) ──");
  console.log("  verif 358,217 · preVerif 54,538 · call 50,180 · signed 462,935 · ACTUALLY USED 359,497 (77.7%)");
}

main().catch((e) => {
  console.error("failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
