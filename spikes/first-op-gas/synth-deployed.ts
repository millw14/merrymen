/**
 * METHOD B — MEASURE THE RENEWAL DIRECTLY, ON A SYNTHETICALLY *DEPLOYED* ACCOUNT.
 *
 * Method A could never estimate the case that matters. A renewal is an ENABLE-mode
 * op sent from an account that ALREADY HAS CODE, and you cannot estimate one
 * against a real merrymen account without that account's real owner key. So
 * method A measured the UNDEPLOYED enable and subtracted a deploy, i.e. inferred.
 *
 * THIS SCRIPT DOES NOT SUBTRACT ANYTHING. It manufactures a deployed Kernel v3.3
 * account whose owner key I generated myself, using eth state overrides:
 *
 *   on the ACCOUNT address S:  code      = the real 61-byte Kernel ERC-1967 proxy
 *                                          runtime, cloned from a live v3.3 account
 *                              stateDiff = ERC-1967 impl slot -> the real v3.3 impl
 *                                          kernel.v3.validation base+0 -> rootValidator
 *                              balance   = enough to clear the prefund check
 *   on the shared ECDSAValidator: stateDiff = ecdsaValidatorStorage[S] -> MY owner EOA
 *
 * S then behaves, to the EVM, exactly like a deployed merrymen account that has
 * never installed a permission validator — which is precisely the renewal state.
 * No factory, no initCode, real code, empty permissionConfig.
 *
 * TWO INDEPENDENT GAS ORACLES, so the answer does not rest on one estimator:
 *   ORACLE 1  Pimlico  eth_estimateUserOperationGas   (same oracle as method A,
 *                                                      but a state it never reached)
 *   ORACLE 2  the chain node  eth_estimateGas of EntryPoint -> S.validateUserOp(...)
 *             This is the bundler-free measurement. It prices the verification
 *             phase directly on a Nitro node, with no Pimlico heuristics at all.
 *
 * CONTROL MATRIX (every arm is printed, including the ones that must fail):
 *   2x2 factorial   {undeployed, synthetically deployed} x {sudo-only, walled}
 *   negative controls: drop the code override / drop the owner override / drop the
 *   rootValidator word -> each must break, or the synthetic deployment is a fiction.
 *
 * READ-ONLY. eth_call, eth_estimateGas, eth_getCode, eth_getStorageAt and
 * eth_estimateUserOperationGas are all simulations. No transaction and no
 * UserOperation is ever broadcast. The keys are generated in this process, never
 * funded, never written to disk. The overrides live only inside the RPC calls.
 *
 * Run: railway run --service orchestrator -- npx tsx spikes/first-op-gas/synth-deployed.ts
 */
import {
  createPublicClient, encodeAbiParameters, encodeFunctionData, erc20Abi, http, keccak256,
  pad, type Address, type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getUserOperationHash, toPackedUserOperation } from "viem/account-abstraction";
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

/** Cloned from live Kernel v3.3 accounts on 4663 (0x032Da6A0… and 0xa48cE91e… — byte-identical). */
const KERNEL_PROXY_RUNTIME =
  "0x363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3" as Hex;
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const IMPL_V33 = "0x000000000000000000000000d6cedde84be40893d153be9d467cd6ad37875b28" as Hex;
/** keccak256("kernel.v3.validation") - 1. base+0 = rootValidator(21B) | currentNonce | validNonceFrom */
const VAL_BASE = "0x7bcaa2ced2a71450ed5a9a1b4848e8e5206dbc3f06011e595f7f55428cc6f84f" as Hex;
const VAL_BASE0_LIVE = "0x000000000000000000000101845adb2c711129d4f3966735ed98a9f09fc4ce57" as Hex;
const ECDSA_VALIDATOR = "0x845ADb2C711129d4f3966735eD98a9F09fC4cE57" as Address;

const VALIDATE_USER_OP_ABI = [
  {
    type: "function",
    name: "validateUserOp",
    stateMutability: "payable",
    inputs: [
      {
        name: "userOp", type: "tuple",
        components: [
          { name: "sender", type: "address" }, { name: "nonce", type: "uint256" },
          { name: "initCode", type: "bytes" }, { name: "callData", type: "bytes" },
          { name: "accountGasLimits", type: "bytes32" }, { name: "preVerificationGas", type: "uint256" },
          { name: "gasFees", type: "bytes32" }, { name: "paymasterAndData", type: "bytes" },
          { name: "signature", type: "bytes" },
        ],
      },
      { name: "userOpHash", type: "bytes32" },
      { name: "missingAccountFunds", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const ROOT_VALIDATOR_ABI = [
  { type: "function", name: "rootValidator", stateMutability: "view", inputs: [], outputs: [{ type: "bytes21" }] },
] as const;
const ECDSA_STORAGE_ABI = [
  { type: "function", name: "ecdsaValidatorStorage", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
] as const;

type Ov = Record<string, { balance?: Hex; code?: Hex; stateDiff?: Record<string, Hex> }>;

async function rpc(url: string, method: string, params: unknown[]) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j = (await r.json()) as { result?: unknown; error?: { message?: string; code?: unknown; data?: unknown } };
      // Only retry transport-ish failures; a real revert is an answer, not a flake.
      if (j.error && /Too Many Requests|rate|timeout|502|503/i.test(String(j.error.message))) {
        await new Promise((s) => setTimeout(s, 1500 * (i + 1)));
        continue;
      }
      return j;
    } catch (e) {
      if (i === 3) return { error: { message: `transport: ${e instanceof Error ? e.message : String(e)}` } };
      await new Promise((s) => setTimeout(s, 1500 * (i + 1)));
    }
  }
  return { error: { message: "exhausted retries — UNREAD, not empty" } };
}

function err(e: unknown): string {
  const o = e as { message?: string; data?: unknown; code?: unknown } | null | undefined;
  if (!o) return "unknown";
  return [o.code !== undefined ? `code ${String(o.code)}` : "", o.message ?? "", typeof o.data === "string" ? o.data : ""]
    .filter(Boolean).join(" · ").slice(0, 220);
}

const readEst = (r: { result?: unknown }) => {
  const o = r.result as Record<string, string> | undefined;
  if (!o || o.verificationGasLimit === undefined) return null;
  const n = (k: string) => (o[k] === undefined ? 0n : BigInt(o[k]));
  const call = n("callGasLimit"), ver = n("verificationGasLimit"), pre = n("preVerificationGas");
  return { call, ver, pre, total: call + ver + pre };
};
const fmt = (n: bigint) => n.toLocaleString("en-US");

async function main() {
  const apiKey = process.env.MERRYMEN_BUNDLER_API_KEY;
  const bundler = apiKey ? pimlicoBundlerUrl(CHAIN_ID, apiKey) : null;
  console.log(`bundler: ${bundler ? `${new URL(bundler).host} (key present, ${apiKey!.length} chars)` : "NO KEY — oracle 1 will be skipped and reported as UNREAD"}`);

  const chain = chainForId(CHAIN_ID);
  const publicClient = createPublicClient({ chain, transport: http(RPC) });
  const entryPoint = getEntryPoint("0.7");
  const ep = entryPoint.address as Address;

  // ── the account under test: throwaway owner, real merrymen wall shape ──────
  const owner = privateKeyToAccount(generatePrivateKey());
  const ecdsa = await signerToEcdsaValidator(publicClient, { signer: owner, entryPoint, kernelVersion: KERNEL_V3_3 });
  console.log(`\nECDSAValidator in use: ${ecdsa.address}  ${ecdsa.address.toLowerCase() === ECDSA_VALIDATOR.toLowerCase() ? "== the one live on 4663 (2,110 accounts)" : "!! DIFFERS from the chain's — overrides below would be aimed at the wrong contract"}`);

  const sudoOnly = await createKernelAccount(publicClient, { entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ecdsa } });
  const sessionSigner = await toECDSASigner({ signer: privateKeyToAccount(generatePrivateKey()) });
  const { policies } = buildWallPolicies({ caps: CAPS, smartAccount: sudoOnly.address });
  const permission = await toPermissionValidator(publicClient, {
    entryPoint, kernelVersion: KERNEL_V3_3, signer: sessionSigner, policies, flag: WALL_POLICY_FLAG,
  });
  const account = await createKernelAccount(publicClient, {
    entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ecdsa, regular: permission },
  });
  const S = account.address as Address;
  console.log(`wall: ${policies.length} policies · permissionId ${permission.getIdentifier()}`);
  console.log(`account S = ${S}   (sudo-only derivation ${sudoOnly.address} — ${sudoOnly.address === S ? "SAME address, as merrymen asserts" : "DIFFERENT (unexpected)"})`);

  const realCode = await publicClient.getCode({ address: S }).catch(() => "UNREAD" as const);
  console.log(`S on chain: ${realCode === "UNREAD" ? "UNREAD (getCode failed)" : realCode && realCode !== "0x" ? `${(realCode.length - 2) / 2} bytes (UNEXPECTED)` : "no code — counterfactual, as required"}`);

  // ── the synthetic deployment ──────────────────────────────────────────────
  const ownerSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [S, 0n]));
  const bigBalance = `0x${(10n ** 18n).toString(16)}` as Hex;
  const accountOv = {
    balance: bigBalance,
    code: KERNEL_PROXY_RUNTIME,
    stateDiff: { [IMPL_SLOT]: IMPL_V33, [VAL_BASE]: VAL_BASE0_LIVE },
  };
  const validatorOv = { stateDiff: { [ownerSlot]: pad(owner.address) as Hex } };
  const DEPLOYED: Ov = { [S]: accountOv, [ECDSA_VALIDATOR]: validatorOv };
  const UNDEPLOYED: Ov = { [S]: { balance: bigBalance } };

  console.log(`\n── THE SYNTHETIC DEPLOYMENT ──────────────────────────────────`);
  console.log(`  S.code            <- ${(KERNEL_PROXY_RUNTIME.length - 2) / 2}-byte Kernel ERC-1967 proxy, cloned from 0x032Da6A0… / 0xa48cE91e…`);
  console.log(`  S[implSlot]       <- ${IMPL_V33}`);
  console.log(`  S[valBase+0]      <- ${VAL_BASE0_LIVE}  (rootValidator 0x01||${ECDSA_VALIDATOR})`);
  console.log(`  validator[${ownerSlot.slice(0, 12)}…] <- ${owner.address}  (ecdsaValidatorStorage[S] = my throwaway owner)`);

  // ── CONTROLS ON THE CLONE ITSELF (chain node, eth_call) ───────────────────
  console.log(`\n── CONTROL A: does the clone actually behave like a Kernel? ──`);
  const callOv = async (to: Address, data: Hex, ov: Ov | null) =>
    rpc(RPC, "eth_call", ov ? [{ to, data }, "latest", ov] : [{ to, data }, "latest"]);

  const rootData = encodeFunctionData({ abi: ROOT_VALIDATOR_ABI, functionName: "rootValidator" });
  const a1 = await callOv(S, rootData, DEPLOYED);
  console.log(`  S.rootValidator() WITH overrides   -> ${a1.error ? `ERR ${err(a1.error)}` : a1.result}`);
  const a2 = await callOv(S, rootData, null);
  console.log(`  S.rootValidator() WITHOUT (control)-> ${a2.error ? `ERR ${err(a2.error)}` : `${a2.result} ${a2.result === "0x" ? "(empty — no code, as expected)" : ""}`}`);
  const a3 = await callOv(S, rootData, { [S]: { balance: bigBalance, code: KERNEL_PROXY_RUNTIME, stateDiff: { [VAL_BASE]: VAL_BASE0_LIVE } } });
  console.log(`  …code but NO impl slot (control)   -> ${a3.error ? `ERR ${err(a3.error)}` : `${a3.result} ${a3.result === "0x" ? "(delegatecall to 0x0 — clone is impl-driven, good)" : ""}`}`);

  const ownerData = encodeFunctionData({ abi: ECDSA_STORAGE_ABI, functionName: "ecdsaValidatorStorage", args: [S] });
  const b1 = await callOv(ECDSA_VALIDATOR, ownerData, DEPLOYED);
  console.log(`  validator.ecdsaValidatorStorage(S) WITH   -> ${b1.error ? `ERR ${err(b1.error)}` : b1.result}  ${typeof b1.result === "string" && b1.result.toLowerCase().endsWith(owner.address.slice(2).toLowerCase()) ? "== my owner ✓" : "!! not my owner"}`);
  const b2 = await callOv(ECDSA_VALIDATOR, ownerData, null);
  console.log(`  …WITHOUT overrides (control)             -> ${b2.error ? `ERR ${err(b2.error)}` : `${b2.result} ${/^0x0*$/.test(String(b2.result)) ? "(zero — S is a stranger to the real validator, as expected)" : ""}`}`);

  // ── the operation. approve-only callData, exactly as probe.ts section 5. ──
  const approveCall = {
    to: CASH.USDG as Address, value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [UNISWAP.swapRouter02 as Address, 5_000_000n] }),
  };
  const walledCallData = await account.encodeCalls([approveCall]);
  const sudoCallData = await sudoOnly.encodeCalls([approveCall]);

  const fees = await publicClient.estimateFeesPerGas().catch(() => null);
  const maxFeePerGas = fees?.maxFeePerGas ?? 1_000_000_000n;
  const maxPriorityFeePerGas = fees?.maxPriorityFeePerGas ?? 0n;

  const walledNonce = await account.getNonce();
  const sudoNonce = await sudoOnly.getNonce();
  const factoryArgs = await account.getFactoryArgs();
  const sudoFactoryArgs = await sudoOnly.getFactoryArgs();

  const hx = (n: bigint) => `0x${n.toString(16)}`;
  const nonceHex = hx(walledNonce);
  const mode = `0x${(walledNonce >> 248n).toString(16).padStart(2, "0")}`;
  const vType = `0x${((walledNonce >> 240n) & 0xffn).toString(16).padStart(2, "0")}`;
  console.log(`\n── THE OPERATION ────────────────────────────────────────────`);
  console.log(`  walled nonce ${nonceHex}`);
  console.log(`  mode ${mode} ${mode === "0x01" ? "(ENABLE)" : "(NOT enable!)"} · vType ${vType} ${vType === "0x02" ? "(PERMISSION)" : ""}  -> isFirstEnable(nonce) = ${mode === "0x01" && vType === "0x02"}`);
  console.log(`  sudo   nonce ${hx(sudoNonce)}  mode 0x${(sudoNonce >> 248n).toString(16).padStart(2, "0")}`);

  const walledStub = await account.getStubSignature({
    sender: S, nonce: walledNonce, callData: walledCallData,
    callGasLimit: 0n, verificationGasLimit: 0n, preVerificationGas: 0n,
    maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, signature: "0x", ...factoryArgs,
  } as never);
  const sudoStub = await sudoOnly.getStubSignature({
    sender: S, nonce: sudoNonce, callData: sudoCallData,
    callGasLimit: 0n, verificationGasLimit: 0n, preVerificationGas: 0n,
    maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, signature: "0x", ...sudoFactoryArgs,
  } as never);
  console.log(`  walled stub signature ${(walledStub.length - 2) / 2} bytes (the plugin-enable blob) · sudo stub ${(sudoStub.length - 2) / 2} bytes`);

  // ═══ ORACLE 1 — Pimlico, 2x2 factorial ═══════════════════════════════════
  console.log(`\n═══ ORACLE 1 · Pimlico eth_estimateUserOperationGas · 2x2 ════`);
  const base = { maxFeePerGas: hx(maxFeePerGas), maxPriorityFeePerGas: hx(maxPriorityFeePerGas), sender: S };
  const arms: Record<string, { op: Record<string, unknown>; ov: Ov | null; must: string }> = {
    "U-S  undeployed · sudo-only": {
      op: { ...base, nonce: hx(sudoNonce), factory: sudoFactoryArgs.factory, factoryData: sudoFactoryArgs.factoryData, callData: sudoCallData, signature: sudoStub },
      ov: UNDEPLOYED, must: "succeed",
    },
    "U-W  undeployed · WALLED": {
      op: { ...base, nonce: nonceHex, factory: factoryArgs.factory, factoryData: factoryArgs.factoryData, callData: walledCallData, signature: walledStub },
      ov: UNDEPLOYED, must: "succeed",
    },
    "D-S  synth-deployed · sudo-only": {
      op: { ...base, nonce: hx(sudoNonce), callData: sudoCallData, signature: sudoStub },
      ov: DEPLOYED, must: "succeed (proves the clone is a working account)",
    },
    "D-W  synth-deployed · WALLED  <<< THE RENEWAL": {
      op: { ...base, nonce: nonceHex, callData: walledCallData, signature: walledStub },
      ov: DEPLOYED, must: "succeed",
    },
    "N1   synth-deployed · WALLED · NO code override": {
      op: { ...base, nonce: nonceHex, callData: walledCallData, signature: walledStub },
      ov: UNDEPLOYED, must: "FAIL — no code, no factory",
    },
    "N2   synth-deployed · sudo-only · NO owner override": {
      op: { ...base, nonce: hx(sudoNonce), callData: sudoCallData, signature: sudoStub },
      ov: { [S]: accountOv }, must: "FAIL or differ — validator does not know S's owner",
    },
    "N3   synth-deployed · WALLED · NO rootValidator word": {
      op: { ...base, nonce: nonceHex, callData: walledCallData, signature: walledStub },
      ov: { [S]: { balance: bigBalance, code: KERNEL_PROXY_RUNTIME, stateDiff: { [IMPL_SLOT]: IMPL_V33 } }, [ECDSA_VALIDATOR]: validatorOv },
      must: "FAIL — enable sig has no root validator to check against",
    },
  };
  const o1: Record<string, ReturnType<typeof readEst>> = {};
  for (const [label, { op, ov, must }] of Object.entries(arms)) {
    if (!bundler) { console.log(`  ${label.padEnd(48)} UNREAD (no bundler key)`); continue; }
    const r = await rpc(bundler, "eth_estimateUserOperationGas", ov ? [op, ep, ov] : [op, ep]);
    const v = readEst(r);
    o1[label] = v;
    console.log(`  ${label}`);
    console.log(`      expect: ${must}`);
    console.log(v
      ? `      verif ${fmt(v.ver).padStart(11)} · preVerif ${fmt(v.pre).padStart(9)} · call ${fmt(v.call).padStart(8)} · RAW ${fmt(v.total)}`
      : `      REFUSED: ${err(r.error)}`);
  }

  // ═══ ORACLE 2 — the chain node, no bundler at all ════════════════════════
  // eth_estimateGas of EntryPoint -> S.validateUserOp(op, hash, 0). This prices
  // the verification phase directly: the enable (installValidations + every
  // policy's onInstall) plus the signature checks. Nothing Pimlico-shaped in it.
  console.log(`\n═══ ORACLE 2 · chain node · eth_estimateGas(EntryPoint -> S.validateUserOp) ══`);
  const packFor = (nonce: bigint, callData: Hex, signature: Hex) => {
    const uo = {
      sender: S, nonce, callData, signature,
      callGasLimit: 200_000n, verificationGasLimit: 20_000_000n, preVerificationGas: 300_000n,
      maxFeePerGas, maxPriorityFeePerGas,
    } as never;
    const hash = getUserOperationHash({ chainId: CHAIN_ID, entryPointAddress: ep, entryPointVersion: "0.7", userOperation: uo });
    const packed = toPackedUserOperation(uo);
    return { data: encodeFunctionData({ abi: VALIDATE_USER_OP_ABI, functionName: "validateUserOp", args: [packed as never, hash, 0n] }), hash };
  };

  const g = async (label: string, nonce: bigint, callData: Hex, signature: Hex, ov: Ov | null, must: string) => {
    const { data } = packFor(nonce, callData, signature);
    const r = await rpc(RPC, "eth_estimateGas", ov ? [{ from: ep, to: S, data }, "latest", ov] : [{ from: ep, to: S, data }, "latest"]);
    const val = typeof r.result === "string" ? BigInt(r.result) : null;
    console.log(`  ${label}`);
    console.log(`      expect: ${must}`);
    console.log(val === null ? `      REFUSED: ${err(r.error)}` : `      gas ${fmt(val)}`);
    return val;
  };

  const gWalledDeployed = await g("E1  synth-deployed · WALLED validateUserOp  <<< the enable, priced alone", walledNonce, walledCallData, walledStub, DEPLOYED, "succeed — this is the renewal's verification work");
  const gSudoDeployed = await g("E2  synth-deployed · sudo-only validateUserOp (baseline)", sudoNonce, sudoCallData, sudoStub, DEPLOYED, "succeed — root-validator path, no enable");
  await g("E3  CONTROL · WALLED validateUserOp · NO code override", walledNonce, walledCallData, walledStub, UNDEPLOYED, "FAIL — S has no code");
  await g("E4  CONTROL · WALLED validateUserOp · NO owner override", walledNonce, walledCallData, walledStub, { [S]: accountOv }, "FAIL or cheaper — enable sig cannot verify");
  await g("E5  CONTROL · caller is NOT the EntryPoint", walledNonce, walledCallData, walledStub, DEPLOYED, "FAIL — Kernel gates validateUserOp on msg.sender")
    .catch(() => null);
  {
    const { data } = packFor(walledNonce, walledCallData, walledStub);
    const r = await rpc(RPC, "eth_estimateGas", [{ from: "0x000000000000000000000000000000000000dEaD", to: S, data }, "latest", DEPLOYED]);
    console.log(`  E5b from 0x…dEaD instead of the EntryPoint -> ${typeof r.result === "string" ? `gas ${fmt(BigInt(r.result))} (UNEXPECTED — no gate?)` : `REFUSED: ${err(r.error)} (correct)`}`);
  }

  // ── VERDICT ───────────────────────────────────────────────────────────────
  console.log(`\n═══ VERDICT ════════════════════════════════════════════════`);
  const dW = o1["D-W  synth-deployed · WALLED  <<< THE RENEWAL"];
  const uW = o1["U-W  undeployed · WALLED"];
  const dS = o1["D-S  synth-deployed · sudo-only"];
  const uS = o1["U-S  undeployed · sudo-only"];
  if (dW && uW) {
    console.log(`  RENEWAL (deployed + enable)  RAW ${fmt(dW.total)}   verif ${fmt(dW.ver)}`);
    console.log(`  FIRST OP (undeployed+enable) RAW ${fmt(uW.total)}   verif ${fmt(uW.ver)}`);
    console.log(`  deployment saves only ${fmt(uW.total - dW.total)} raw gas (${((Number(uW.total - dW.total) / Number(uW.total)) * 100).toFixed(1)}% of the first op)`);
  } else console.log(`  one of the walled arms is UNREAD — see above; not treating that as zero`);
  if (dW && dS) console.log(`  enable premium ON A DEPLOYED ACCOUNT (oracle 1): raw +${fmt(dW.total - dS.total)} · verif +${fmt(dW.ver - dS.ver)}`);
  if (uW && uS) console.log(`  enable premium on an UNDEPLOYED account (oracle 1): raw +${fmt(uW.total - uS.total)} · verif +${fmt(uW.ver - uS.ver)}`);
  if (gWalledDeployed !== null && gSudoDeployed !== null)
    console.log(`  enable premium ON A DEPLOYED ACCOUNT (oracle 2, bundler-free): +${fmt(gWalledDeployed - gSudoDeployed)} gas  (E1 ${fmt(gWalledDeployed)} − E2 ${fmt(gSudoDeployed)})`);

  // boundGas, applied exactly as worker/src/gas-limits.ts does.
  const bound = (v: { call: bigint; ver: bigint; pre: bigint }) =>
    (v.call * 20_000n) / 10_000n + (v.ver * 12_500n) / 10_000n + (v.pre * 12_500n) / 10_000n;
  if (dW) {
    const b = bound(dW);
    console.log(`\n  boundGas(renewal) = ${fmt(b)}`);
    console.log(`    vs GAS_BOUNDS.absoluteMax        3,000,000  -> ${b > 3_000_000n ? `REFUSED, ${(Number(b) / 3e6).toFixed(2)}x over` : "accepted"}`);
    console.log(`    vs FIRST_ENABLE_GAS_BOUNDS      12,000,000  -> ${b > 12_000_000n ? "REFUSED" : `accepted, ${((Number(b) / 12e6) * 100).toFixed(1)}% of ceiling`}`);
    const feeCeiling = maxFeePerGas;
    console.log(`  and PR #56 hands a renewal a balance override of 3,000,000 x ${feeCeiling} x 2 = ${fmt(3_000_000n * feeCeiling * 2n)} wei,`);
    console.log(`  which buys ${fmt((3_000_000n * feeCeiling * 2n) / feeCeiling)} gas for an op needing ${fmt(dW.total)} -> the estimate itself cannot complete.`);
  }
}

main().catch((e) => {
  console.error("synth-deployed failed:", e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
