/**
 * METHOD B, PART 3 — VALIDATE THE SYNTHETIC DEPLOYMENT AGAINST GROUND TRUTH,
 * AND CHECK IT REPEATS.
 *
 * synth-deployed.ts measured a merrymen renewal on an account that was deployed
 * only inside a state override. That number is worth nothing unless the same
 * harness, pointed at a SMALL wall, reproduces what small walls actually cost
 * when they land on chain 4663 for real.
 *
 * Ground truth (landed-renewals.mjs, read from UserOperationEvent + handleOps
 * calldata, no simulation): 69 real ENABLE ops on already-deployed senders,
 * 18 distinct accounts, all successful, actual gas used 776,920 … 1,344,209,
 * signed verificationGasLimit ~1,392,313.
 *
 * So: sweep the wall size on the SYNTHETIC DEPLOYED account, and see whether the
 * small end lands on the real numbers. If it does, the big end is credible too.
 * Also repeat the full-wall measurement with independent throwaway keys, because
 * a number that only holds for one address is an artifact.
 *
 * READ-ONLY. Estimation and eth_call only; nothing signed for broadcast, nothing
 * sent, no account funded.
 *
 * Run: railway run --service orchestrator -- npx tsx spikes/first-op-gas/synth-validate.ts
 */
import {
  createPublicClient, encodeAbiParameters, encodeFunctionData, erc20Abi, http, keccak256, pad,
  type Address, type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getEntryPoint, KERNEL_V3_3 } from "@zerodev/sdk/constants";
import { createKernelAccount } from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { toPermissionValidator } from "@zerodev/permissions";
import { toCallPolicy, toTimestampPolicy, CallPolicyVersion } from "@zerodev/permissions/policies";
import { toECDSASigner } from "@zerodev/permissions/signers";
import {
  buildCallPermissions, buildWallPolicies, CASH, chainForId, pimlicoBundlerUrl, UNISWAP, WALL_POLICY_FLAG,
} from "../../packages/core/src/index";

const CHAIN_ID = 4663;
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const CAPS = { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 };

const KERNEL_PROXY_RUNTIME =
  "0x363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3" as Hex;
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const IMPL_V33 = "0x000000000000000000000000d6cedde84be40893d153be9d467cd6ad37875b28" as Hex;
const VAL_BASE = "0x7bcaa2ced2a71450ed5a9a1b4848e8e5206dbc3f06011e595f7f55428cc6f84f" as Hex;
const VAL_BASE0_LIVE = "0x000000000000000000000101845adb2c711129d4f3966735ed98a9f09fc4ce57" as Hex;
const ECDSA_VALIDATOR = "0x845ADb2C711129d4f3966735eD98a9F09fC4cE57" as Address;

/** Real landed ENABLE ops on ALREADY-DEPLOYED senders, from landed-renewals.mjs. */
const LANDED_RENEWALS = [
  { tx: "0xea484e247efd67653f80345a5d76388ea77f9705c7ee5e339dd859ce85618a12", sender: "0x0fbf83f16f4bf90c695ca2038904c1d1806c2fa5", verif: 1_401_834n, used: 1_344_209n },
  { tx: "0x51eec985136ea2846cc15a7e1589d4a1e0c78c5b71dbf93c072d0ac71aa2d66f", sender: "0x4986995b4ca6fdc838a01a61967daa50d2b854e9", verif: 1_392_313n, used: 1_214_829n },
  { tx: "0x683f929c1b5a42a7f9908636f9eda1da2050af7d48184ca83d0be8e17b0915b1", sender: "0x8728106010234c705b2c8d8d9fa19adb7c21f90c", verif: 1_392_313n, used: 1_213_718n },
];

async function rpc(url: string, method: string, params: unknown[]) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j = (await r.json()) as { result?: unknown; error?: { message?: string; code?: unknown; data?: unknown } };
      if (j.error && /Too Many Requests|rate limit|timeout/i.test(String(j.error.message))) {
        await new Promise((s) => setTimeout(s, 1500 * (i + 1))); continue;
      }
      return j;
    } catch (e) {
      if (i === 3) return { error: { message: `transport: ${e instanceof Error ? e.message : String(e)}` } };
      await new Promise((s) => setTimeout(s, 1500 * (i + 1)));
    }
  }
  return { error: { message: "exhausted retries — UNREAD, not empty" } };
}
const errT = (e: unknown) => {
  const o = e as { message?: string; code?: unknown } | undefined;
  return o ? `${o.code !== undefined ? `code ${String(o.code)} · ` : ""}${o.message ?? ""}`.slice(0, 160) : "unknown";
};
const readEst = (r: { result?: unknown }) => {
  const o = r.result as Record<string, string> | undefined;
  if (!o || o.verificationGasLimit === undefined) return null;
  const n = (k: string) => (o[k] === undefined ? 0n : BigInt(o[k]));
  const call = n("callGasLimit"), ver = n("verificationGasLimit"), pre = n("preVerificationGas");
  return { call, ver, pre, total: call + ver + pre };
};
const f = (n: bigint | number) => Number(n).toLocaleString("en-US");

async function main() {
  const apiKey = process.env.MERRYMEN_BUNDLER_API_KEY;
  if (!apiKey) { console.error("no MERRYMEN_BUNDLER_API_KEY — run under `railway run --service orchestrator --`"); process.exit(1); }
  const bundler = pimlicoBundlerUrl(CHAIN_ID, apiKey);
  const publicClient = createPublicClient({ chain: chainForId(CHAIN_ID), transport: http(RPC) });
  const entryPoint = getEntryPoint("0.7");
  const ep = entryPoint.address as Address;
  const fees = await publicClient.estimateFeesPerGas().catch(() => null);
  const maxFeePerGas = fees?.maxFeePerGas ?? 1_000_000_000n;
  const maxPriorityFeePerGas = fees?.maxPriorityFeePerGas ?? 0n;
  const hx = (n: bigint) => `0x${n.toString(16)}`;

  // ── how big is the enable blob on the REAL landed renewals? ───────────────
  console.log(`── ground truth: enable-blob size of the real landed renewals ──`);
  for (const l of LANDED_RENEWALS) {
    const tx = await rpc(RPC, "eth_getTransactionByHash", [l.tx]);
    const input = (tx.result as { input?: string } | undefined)?.input;
    if (!input) { console.log(`  ${l.tx.slice(0, 12)}… UNREAD (tx not returned) — not treating as absent`); continue; }
    const d = input.slice(10);
    const target = l.sender.slice(2).padStart(64, "0");
    let at = -1;
    for (let i = 0; i + 64 <= d.length; i += 64) if (d.slice(i, i + 64) === target) { at = i; break; }
    if (at < 0) { console.log(`  ${l.tx.slice(0, 12)}… sender word not located — UNDECODED`); continue; }
    // struct field 8 is the signature offset, relative to the struct start
    const sigOff = Number(BigInt("0x" + d.slice(at + 8 * 64, at + 9 * 64)));
    const lenAt = at + sigOff * 2;
    const sigLen = Number(BigInt("0x" + d.slice(lenAt, lenAt + 64)));
    console.log(`  ${l.sender}  enable blob ${f(sigLen)} bytes · signed verif ${f(l.verif)} · actual used ${f(l.used)}`);
  }

  // ── the synthetic deployment, reused for every arm below ─────────────────
  const approve = (to: Address) => ({
    to: CASH.USDG as Address, value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [UNISWAP.swapRouter02 as Address, 5_000_000n] }),
  });

  type Arm = { label: string; policies: readonly unknown[] };
  const measure = async (label: string, policies: readonly unknown[], ownerKey?: Hex) => {
    const owner = privateKeyToAccount(ownerKey ?? generatePrivateKey());
    const ecdsa = await signerToEcdsaValidator(publicClient, { signer: owner, entryPoint, kernelVersion: KERNEL_V3_3 });
    const sudoOnly = await createKernelAccount(publicClient, { entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ecdsa } });
    const sess = await toECDSASigner({ signer: privateKeyToAccount(generatePrivateKey()) });
    const pv = await toPermissionValidator(publicClient, {
      entryPoint, kernelVersion: KERNEL_V3_3, signer: sess, policies: policies as never, flag: WALL_POLICY_FLAG,
    });
    const account = await createKernelAccount(publicClient, { entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ecdsa, regular: pv } });
    const S = account.address as Address;

    const live = await publicClient.getCode({ address: S }).catch(() => "UNREAD" as const);
    const preexisting = live === "UNREAD" ? "UNREAD" : live && live !== "0x" ? "HAS CODE (!)" : "none";

    const ownerSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [S, 0n]));
    const bal = `0x${(10n ** 18n).toString(16)}` as Hex;
    const DEPLOYED = {
      [S]: { balance: bal, code: KERNEL_PROXY_RUNTIME, stateDiff: { [IMPL_SLOT]: IMPL_V33, [VAL_BASE]: VAL_BASE0_LIVE } },
      [ECDSA_VALIDATOR]: { stateDiff: { [ownerSlot]: pad(owner.address) as Hex } },
    };
    const UNDEPLOYED = { [S]: { balance: bal } };

    const callData = await account.encodeCalls([approve(S)]);
    const nonce = await account.getNonce();
    const fa = await account.getFactoryArgs();
    const stubD = await account.getStubSignature({
      sender: S, nonce, callData, callGasLimit: 0n, verificationGasLimit: 0n, preVerificationGas: 0n,
      maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, signature: "0x",
    } as never);
    const stubU = await account.getStubSignature({
      sender: S, nonce, callData, callGasLimit: 0n, verificationGasLimit: 0n, preVerificationGas: 0n,
      maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, signature: "0x", ...fa,
    } as never);

    const common = { sender: S, nonce: hx(nonce), callData, maxFeePerGas: hx(maxFeePerGas), maxPriorityFeePerGas: hx(maxPriorityFeePerGas) };
    const rD = await rpc(bundler, "eth_estimateUserOperationGas", [{ ...common, signature: stubD }, ep, DEPLOYED]);
    const rU = await rpc(bundler, "eth_estimateUserOperationGas", [{ ...common, factory: fa.factory, factoryData: fa.factoryData, signature: stubU }, ep, UNDEPLOYED]);
    const vD = readEst(rD), vU = readEst(rU);
    const mode = `0x${(nonce >> 248n).toString(16).padStart(2, "0")}/0x${((nonce >> 240n) & 0xffn).toString(16).padStart(2, "0")}`;
    console.log(`  ${label}`);
    console.log(`      S ${S} · pre-existing code ${preexisting} · nonce mode/vType ${mode} · blob ${f((stubD.length - 2) / 2)} B`);
    console.log(`      DEPLOYED   ${vD ? `verif ${f(vD.ver).padStart(11)} · preVerif ${f(vD.pre).padStart(9)} · call ${f(vD.call).padStart(8)} · RAW ${f(vD.total)}` : `REFUSED: ${errT(rD.error)}`}`);
    console.log(`      UNDEPLOYED ${vU ? `verif ${f(vU.ver).padStart(11)} · preVerif ${f(vU.pre).padStart(9)} · call ${f(vU.call).padStart(8)} · RAW ${f(vU.total)}` : `REFUSED: ${errT(rU.error)}`}`);
    return { vD, vU, blob: (stubD.length - 2) / 2, S };
  };

  // ── 1. REPEATABILITY: the full merrymen wall, three independent accounts ──
  console.log(`\n── 1. REPEATABILITY · full merrymen wall · 3 independent throwaway accounts ──`);
  const reps: Array<{ vD: ReturnType<typeof readEst>; vU: ReturnType<typeof readEst>; blob: number }> = [];
  for (let i = 0; i < 3; i++) {
    const ownerKey = generatePrivateKey();
    const own = privateKeyToAccount(ownerKey);
    const ec = await signerToEcdsaValidator(publicClient, { signer: own, entryPoint, kernelVersion: KERNEL_V3_3 });
    const so = await createKernelAccount(publicClient, { entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ec } });
    const { policies } = buildWallPolicies({ caps: CAPS, smartAccount: so.address });
    reps.push(await measure(`rep ${i + 1}`, policies, ownerKey));
  }
  const spread = (xs: bigint[]) => (xs.length ? `${f(xs.reduce((a, b) => (a < b ? a : b)))} … ${f(xs.reduce((a, b) => (a > b ? a : b)))}` : "none");
  console.log(`  deployed RAW across reps:   ${spread(reps.map((r) => r.vD?.total).filter((x): x is bigint => x !== undefined && x !== null))}`);
  console.log(`  undeployed RAW across reps: ${spread(reps.map((r) => r.vU?.total).filter((x): x is bigint => x !== undefined && x !== null))}`);

  // ── 2. WALL-SIZE SWEEP on the synthetic deployed account ─────────────────
  // The small end is the validation: real small-wall renewals landed at
  // ~1.39M signed verification / ~1.21M actual gas used.
  console.log(`\n── 2. WALL-SIZE SWEEP · synthetic deployed account · does the small end match the chain? ──`);
  const ownerKey2 = generatePrivateKey();
  const own2 = privateKeyToAccount(ownerKey2);
  const ec2 = await signerToEcdsaValidator(publicClient, { signer: own2, entryPoint, kernelVersion: KERNEL_V3_3 });
  const so2 = await createKernelAccount(publicClient, { entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ec2 } });
  const all = buildCallPermissions(CAPS, so2.address, {});
  console.log(`  merrymen's full wall carries ${all.length} call permissions`);
  const now = Math.floor(Date.now() / 1000);
  const curve: Array<{ n: number; blob: number; ver: bigint | null; raw: bigint | null }> = [];
  for (const keep of [all.length, 8, 4, 2, 1]) {
    const policies = [
      toTimestampPolicy({ validAfter: now, validUntil: now + CAPS.expiryDays * 86400 }),
      toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions: all.slice(0, keep) as never }),
    ];
    const m = await measure(`${String(keep).padStart(2)} permissions`, policies, ownerKey2);
    curve.push({ n: keep, blob: m.blob, ver: m.vD?.ver ?? null, raw: m.vD?.total ?? null });
  }

  console.log(`\n── 3. THE CURVE, DEPLOYED-ACCOUNT ENABLE ────────────────────`);
  console.log(`  perms  blob(B)   verif        RAW          boundGas     vs 3,000,000`);
  const bound = (v: { call: bigint; ver: bigint; pre: bigint }) =>
    (v.call * 20_000n) / 10_000n + (v.ver * 12_500n) / 10_000n + (v.pre * 12_500n) / 10_000n;
  for (const c of curve) {
    const rep = curve.find((x) => x.n === c.n);
    console.log(`  ${String(c.n).padStart(5)}  ${String(c.blob).padStart(7)}  ${c.ver === null ? "UNREAD".padStart(11) : f(c.ver).padStart(11)}  ${c.raw === null ? "UNREAD".padStart(11) : f(c.raw).padStart(11)}`);
    void rep;
  }
  const twoPt = curve.filter((c) => c.ver !== null);
  if (twoPt.length >= 2) {
    const hi = twoPt[0]!, lo = twoPt[twoPt.length - 1]!;
    const slope = (hi.ver! - lo.ver!) / BigInt(hi.n - lo.n);
    console.log(`  per-permission verification slope, measured on a DEPLOYED account: ${f(slope)} gas/permission`);
    console.log(`  (over ${lo.n} -> ${hi.n} permissions)`);
  }
  console.log(`\n  VALIDATION: the real landed small-wall renewals signed ~1,392,313 verification`);
  console.log(`  and burned 776,920 … 1,344,209 actual gas. Compare the small end of the sweep above.`);
}

main().catch((e) => { console.error("synth-validate failed:", e instanceof Error ? (e.stack ?? e.message) : String(e)); process.exit(1); });
