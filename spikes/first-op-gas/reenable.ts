/**
 * METHOD A — DIRECT MEASUREMENT OF A RENEWAL ON AN ALREADY-DEPLOYED ACCOUNT.
 *
 * PR #56 gates the elevated 12,000,000 ceiling behind
 * `!accountLive && isFirstEnable(nonce)`. The worry is that the expensive thing
 * is the PERMISSION-VALIDATOR ENABLE, which is one-time per SESSION KEY and not
 * one-time per ACCOUNT — so a renewal on a live account pays the same ~7M while
 * `!accountLive` is false and routes it through the 3,000,000 ceiling.
 *
 * Everything up to now has been arithmetic: the undeployed walled op (7,711,654)
 * minus the sudo-only deploy. This script measures the deployed case DIRECTLY.
 *
 * HOW. Build a Kernel account object PINNED (createKernelAccount's `address`
 * option, which skips CREATE2 derivation) to a REAL deployed Kernel v3.3 account
 * on 4663, with a FRESH permission validator over a FRESH session key. Send it to
 * Pimlico for `eth_estimateUserOperationGas` with NO factory/factoryData — so the
 * bundler simulates an enable against an account that already has code.
 *
 * The one obstacle: Kernel's `_checkEnableSig` REVERTS if the owner's EIP-712
 * enable signature does not verify, and the real owner's key is not mine and
 * must never be touched. So the estimate carries a `stateDiff` override that
 * points the ECDSAValidator's owner slot for that account at MY throwaway key.
 * The slot formula (keccak256(abi.encode(account, uint256(0))) on the validator
 * contract) is VERIFIED IN-SCRIPT against the contract's own
 * ecdsaValidatorStorage(address) view before it is used — if they disagree the
 * script says so and refuses to report a number.
 *
 * NOTHING IS SIGNED FOR BROADCAST AND NOTHING IS BROADCAST.
 * eth_estimateUserOperationGas is a simulation; both overrides live only inside
 * that RPC call. The owner key is generated here, never funded, never written to
 * disk, and the only thing it signs is an EIP-712 blob that exists solely inside
 * an estimation request. No real grant is read, re-signed or mutated. No
 * transaction, no UserOperation, no funding, no deploy.
 *
 * Run: railway run --service orchestrator -- npx tsx spikes/first-op-gas/reenable.ts
 */
import {
  createPublicClient, encodeAbiParameters, encodeFunctionData, erc20Abi, http,
  keccak256, type Address, type Hex,
} from "viem";
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

/** @zerodev/ecdsa-validator for kernel >=0.3.1, the root validator on 2,110 of
 *  the 2,208 ZeroDev accounts on 4663 (phase 1). */
const ECDSA_VALIDATOR = "0x845ADb2C711129d4f3966735eD98a9F09fC4cE57" as Address;

/** REAL, already-deployed Kernel v3.3 accounts on 4663 (phase 1, impl-slot
 *  verified). The first is merrymen's own; the second is the account whose
 *  landed deploy+wall-enable signed 8,972,828 verification gas. */
const TARGETS: Array<{ label: string; address: Address }> = [
  { label: "merrymen's own account (deployed block 51,207,025)", address: "0x032Da6A0Ccf866474e45854E7fDEF9afd1509036" },
  { label: "a second live v3.3 account (deployed block 51,847,124)", address: "0xa48cE91e2F3237E69660C1543042c007B8D33e75" },
];

/** The undeployed WALLED first op this whole question is anchored to. */
const UNDEPLOYED_ANCHOR = { ver: 7_418_031n, pre: 243_443n, call: 50_180n, raw: 7_711_654n };

// gas-limits.ts:118-129 — identical on GAS_BOUNDS and FIRST_ENABLE_GAS_BOUNDS.
const CALL_BPS = 20_000n, VER_BPS = 12_500n, PRE_BPS = 12_500n;
const bound = (call: bigint, ver: bigint, pre: bigint) =>
  (call * CALL_BPS) / 10_000n + (ver * VER_BPS) / 10_000n + (pre * PRE_BPS) / 10_000n;

type RpcOut = { result?: unknown; error?: { message?: string; code?: unknown; data?: unknown } };
async function rpc(url: string, method: string, params: unknown[]): Promise<RpcOut> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j = (await r.json()) as RpcOut;
      const msg = String(j.error?.message ?? "");
      if (/too many requests|rate limit/i.test(msg) && attempt < 3) {
        await new Promise((s) => setTimeout(s, 800 * 2 ** attempt));
        continue;
      }
      return j;
    } catch (e) {
      if (attempt === 3) return { error: { message: e instanceof Error ? e.message : String(e) } };
      await new Promise((s) => setTimeout(s, 800 * 2 ** attempt));
    }
  }
  return { error: { message: "unreachable" } };
}

function errText(e: RpcOut["error"]): string {
  return [e?.code !== undefined ? `code ${String(e.code)}` : "", e?.message ?? "",
    typeof e?.data === "string" ? e.data : ""].filter(Boolean).join(" · ").slice(0, 300);
}

/** null means UNREAD — never "zero". */
function read(r: RpcOut): { call: bigint; ver: bigint; pre: bigint; raw: bigint } | null {
  const o = r.result as Record<string, string> | undefined;
  if (!o) return null;
  const n = (k: string) => (o[k] === undefined ? 0n : BigInt(o[k]));
  const call = n("callGasLimit"), ver = n("verificationGasLimit"), pre = n("preVerificationGas");
  return { call, ver, pre, raw: call + ver + pre };
}

const modeOf = (n: bigint) => `0x${((n >> 248n) & 0xffn).toString(16).padStart(2, "0")}`;
const vTypeOf = (n: bigint) => `0x${((n >> 240n) & 0xffn).toString(16).padStart(2, "0")}`;

async function main() {
  const apiKey = process.env.MERRYMEN_BUNDLER_API_KEY;
  if (!apiKey) { console.error("no MERRYMEN_BUNDLER_API_KEY — run under `railway run --service orchestrator --`"); process.exit(1); }
  const bundler = pimlicoBundlerUrl(CHAIN_ID, apiKey);
  const chain = chainForId(CHAIN_ID);
  const publicClient = createPublicClient({ chain, transport: http(RPC) });
  const entryPoint = getEntryPoint("0.7");
  const ep = entryPoint.address;

  const fees = await publicClient.estimateFeesPerGas().catch(() => null);
  const maxFeePerGas = fees?.maxFeePerGas ?? 1_000_000_000n;
  const maxPriorityFeePerGas = fees?.maxPriorityFeePerGas ?? 0n;
  // Sized as the 12M branch would (executor.ts ~line 325). Deliberately generous:
  // this script is measuring the OPERATION, not re-testing the prefund gate.
  const BAL = 12_000_000n * maxFeePerGas * 4n;
  console.log(`bundler host ${new URL(bundler).host} · chain ${CHAIN_ID} · maxFeePerGas ${maxFeePerGas} wei`);
  console.log(`balance override used everywhere: ${BAL} wei (buys ${BAL / maxFeePerGas} gas)\n`);

  const approveCall = {
    to: CASH.USDG as Address, value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [UNISWAP.swapRouter02 as Address, 5_000_000n] }),
  };

  // ── ONE throwaway owner key, reused for every arm ───────────────────────────
  const ownerKey = generatePrivateKey();
  const owner = privateKeyToAccount(ownerKey);
  const ecdsa = await signerToEcdsaValidator(publicClient, { signer: owner, entryPoint, kernelVersion: KERNEL_V3_3 });
  console.log(`throwaway owner ${owner.address} (generated here; never funded, never written to disk)\n`);

  // ── STEP 0. VERIFY THE OWNER-SLOT FORMULA BEFORE RELYING ON IT ──────────────
  console.log(`── STEP 0. owner-slot formula check on ${ECDSA_VALIDATOR} ──────────────`);
  const slotOf = (acct: Address): Hex =>
    keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [acct, 0n]));
  const slotOk: Record<string, boolean> = {};
  for (const t of TARGETS) {
    const raw = await rpc(RPC, "eth_getStorageAt", [ECDSA_VALIDATOR, slotOf(t.address), "latest"]);
    const view = await rpc(RPC, "eth_call", [
      { to: ECDSA_VALIDATOR, data: ("0x20709efc" + t.address.slice(2).toLowerCase().padStart(64, "0")) as Hex },
      "latest",
    ]);
    const rawOwner = typeof raw.result === "string" ? `0x${raw.result.slice(-40)}` : null;
    const viewOwner = typeof view.result === "string" && view.result.length >= 66 ? `0x${view.result.slice(26, 66)}` : null;
    if (rawOwner === null || viewOwner === null) {
      console.log(`  ${t.address}  UNREAD (storage ${rawOwner === null ? "unread" : "ok"}, view ${viewOwner === null ? "unread" : "ok"}) — NOT "no owner"`);
      slotOk[t.address] = false;
      continue;
    }
    const agree = rawOwner.toLowerCase() === viewOwner.toLowerCase();
    slotOk[t.address] = agree;
    console.log(`  ${t.address}  slot ${slotOf(t.address)}`);
    console.log(`     storage owner ${rawOwner} · view owner ${viewOwner} · ${agree ? "AGREE — formula good" : "DISAGREE — formula WRONG, will not report a number for this target"}`);
  }
  console.log();

  // ══ CONTROL (b): THE SAME WALL ON AN UNDEPLOYED SYNTHETIC ACCOUNT ═══════════
  console.log(`══ CONTROL (b): same wall, UNDEPLOYED synthetic account (must reproduce ~7,711,654) ══`);
  const sudoOnlySynthetic = await createKernelAccount(publicClient, {
    entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ecdsa },
  });
  const synthPerm = await toPermissionValidator(publicClient, {
    entryPoint, kernelVersion: KERNEL_V3_3,
    signer: await toECDSASigner({ signer: privateKeyToAccount(generatePrivateKey()) }),
    policies: buildWallPolicies({ caps: CAPS, smartAccount: sudoOnlySynthetic.address }).policies,
    flag: WALL_POLICY_FLAG,
  });
  const synthAccount = await createKernelAccount(publicClient, {
    entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ecdsa, regular: synthPerm },
  });
  {
    const sender = synthAccount.address as Address;
    const code = await publicClient.getCode({ address: sender }).catch(() => "UNREAD" as const);
    const factoryArgs = await synthAccount.getFactoryArgs();
    const nonce = await synthAccount.getNonce();
    const callData = await synthAccount.encodeCalls([approveCall]);
    const stub = await synthAccount.getStubSignature({
      sender, nonce, callData, callGasLimit: 0n, verificationGasLimit: 0n, preVerificationGas: 0n,
      maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, signature: "0x", ...factoryArgs,
    } as never);
    console.log(`  sender ${sender} · code ${code === "UNREAD" ? "UNREAD" : code && code !== "0x" ? `${(code.length - 2) / 2} bytes (UNEXPECTED)` : "none — counterfactual, as required"}`);
    console.log(`  nonce mode ${modeOf(nonce)} vType ${vTypeOf(nonce)} · initCode ${String(factoryArgs.factoryData).length / 2 - 1} bytes · stub sig ${stub.length / 2 - 1} bytes`);
    const r = await rpc(bundler, "eth_estimateUserOperationGas", [
      {
        sender, nonce: `0x${nonce.toString(16)}`, factory: factoryArgs.factory, factoryData: factoryArgs.factoryData,
        callData, signature: stub,
        maxFeePerGas: `0x${maxFeePerGas.toString(16)}`, maxPriorityFeePerGas: `0x${maxPriorityFeePerGas.toString(16)}`,
      }, ep, { [sender]: { balance: `0x${BAL.toString(16)}` } },
    ]);
    const v = read(r);
    if (!v) console.log(`  CONTROL (b) FAILED — no number came back: ${errText(r.error)}\n`);
    else {
      const drift = Number(v.raw - UNDEPLOYED_ANCHOR.raw) / Number(UNDEPLOYED_ANCHOR.raw);
      console.log(`  verif ${v.ver} · preVerif ${v.pre} · call ${v.call} · RAW ${v.raw}`);
      console.log(`  vs anchor 7,711,654 → drift ${(drift * 100).toFixed(2)}% · ${Math.abs(drift) < 0.05 ? "CONTROL (b) PASSES — harness matches probe.ts" : "CONTROL (b) FAILS — harness differs from probe.ts"}\n`);
    }
  }

  // ══ THE MAIN MEASUREMENT, PER TARGET ════════════════════════════════════════
  for (const t of TARGETS) {
    console.log(`══════════════════════════════════════════════════════════════════════`);
    console.log(`TARGET ${t.address}`);
    console.log(`  ${t.label}`);
    const code = await publicClient.getCode({ address: t.address }).catch(() => undefined);
    if (!code || code === "0x") { console.log(`  code: none or UNREAD — skipping, this target is not usable\n`); continue; }
    console.log(`  code ${(code.length - 2) / 2} bytes → isDeployed() would return TRUE (accountLive = true)`);

    // ── CONTROL (a): the same deployed account, SUDO-ONLY ────────────────────
    console.log(`\n  ── CONTROL (a): same deployed account, sudo-only (no permission validator) ──`);
    const sudoPinned = await createKernelAccount(publicClient, {
      entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ecdsa }, address: t.address,
    });
    let controlAok = false;
    {
      const nonce = await sudoPinned.getNonce();
      const callData = await sudoPinned.encodeCalls([approveCall]);
      const stub = await sudoPinned.getStubSignature({
        sender: t.address, nonce, callData, callGasLimit: 0n, verificationGasLimit: 0n, preVerificationGas: 0n,
        maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, signature: "0x",
      } as never);
      console.log(`     nonce ${nonce} → mode ${modeOf(nonce)} vType ${vTypeOf(nonce)} (expect 0x00 / 0x00) · stub sig ${stub.length / 2 - 1} bytes`);
      const r = await rpc(bundler, "eth_estimateUserOperationGas", [
        {
          sender: t.address, nonce: `0x${nonce.toString(16)}`, callData, signature: stub,
          maxFeePerGas: `0x${maxFeePerGas.toString(16)}`, maxPriorityFeePerGas: `0x${maxPriorityFeePerGas.toString(16)}`,
        }, ep, { [t.address]: { balance: `0x${BAL.toString(16)}` } },
      ]);
      const v = read(r);
      if (!v) console.log(`     CONTROL (a) FAILED — no number: ${errText(r.error)}\n     => the overrides/shape are wrong; treat the main number below as WORTHLESS`);
      else {
        controlAok = v.raw < 400_000n;
        console.log(`     verif ${v.ver} · preVerif ${v.pre} · call ${v.call} · RAW ${v.raw}`);
        console.log(`     ${controlAok ? "CONTROL (a) PASSES — cheap and clean on a live account" : "CONTROL (a) SUSPECT — not cheap (>400k); the main number below is doubtful"}`);
      }
    }

    // ── THE RENEWAL: fresh session key, fresh wall, on this LIVE account ─────
    console.log(`\n  ── THE RENEWAL: fresh session key + fresh 18-permission wall on this LIVE account ──`);
    const sessionKey = generatePrivateKey();
    const { policies } = buildWallPolicies({ caps: CAPS, smartAccount: t.address });
    const permission = await toPermissionValidator(publicClient, {
      entryPoint, kernelVersion: KERNEL_V3_3,
      signer: await toECDSASigner({ signer: privateKeyToAccount(sessionKey) }),
      policies, flag: WALL_POLICY_FLAG,
    });
    const renewAccount = await createKernelAccount(publicClient, {
      entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ecdsa, regular: permission }, address: t.address,
    });
    if ((renewAccount.address as string).toLowerCase() !== t.address.toLowerCase()) {
      console.log(`     PINNING FAILED — account came back as ${renewAccount.address}; skipping target\n`);
      continue;
    }

    // STEP 3 of the plan: the nonce alone, before any estimate, costs nothing.
    const nonce = await renewAccount.getNonce();
    console.log(`     permissionId ${permission.getIdentifier()}`);
    console.log(`     nonce 0x${nonce.toString(16).padStart(64, "0")}`);
    console.log(`     mode ${modeOf(nonce)} ${modeOf(nonce) === "0x01" ? "(ENABLE)" : "(NOT ENABLE)"} · vType ${vTypeOf(nonce)} ${vTypeOf(nonce) === "0x02" ? "(PERMISSION)" : ""}`);
    const isFirstEnable = modeOf(nonce) === "0x01" && vTypeOf(nonce) === "0x02";
    console.log(`     isFirstEnable(nonce) = ${isFirstEnable}   accountLive = true   =>  PR#56 firstEnable = ${!true && isFirstEnable}  =>  ceiling ${isFirstEnable ? "3,000,000 (GAS_BOUNDS)" : "3,000,000"}`);

    const callData = await renewAccount.encodeCalls([approveCall]);
    // getStubSignature builds the REAL enable blob: it signs the EIP-712 enable
    // typed data with the throwaway owner (local signing only) and nests a dummy
    // userOp signature. That is exactly the blob a renewal's first op carries.
    const stub = await renewAccount.getStubSignature({
      sender: t.address, nonce, callData, callGasLimit: 0n, verificationGasLimit: 0n, preVerificationGas: 0n,
      maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, signature: "0x",
    } as never);
    console.log(`     enable blob (stub signature) ${stub.length / 2 - 1} bytes · NO factory / NO factoryData sent`);

    const op = {
      sender: t.address, nonce: `0x${nonce.toString(16)}`, callData, signature: stub,
      maxFeePerGas: `0x${maxFeePerGas.toString(16)}`, maxPriorityFeePerGas: `0x${maxPriorityFeePerGas.toString(16)}`,
    };
    const balOnly = { [t.address]: { balance: `0x${BAL.toString(16)}` } };
    const ownerOverride = {
      [t.address]: { balance: `0x${BAL.toString(16)}` },
      [ECDSA_VALIDATOR]: { stateDiff: { [slotOf(t.address)]: `0x${owner.address.slice(2).toLowerCase().padStart(64, "0")}` } },
    };

    // NEGATIVE CONTROL: without the owner override the enable signature is not
    // the real owner's, so Kernel must reject it. If this SUCCEEDS, the override
    // is not what is making the main number possible and something is wrong.
    console.log(`\n     NEGATIVE CONTROL: same op, balance override only (no owner override)`);
    const neg = await rpc(bundler, "eth_estimateUserOperationGas", [op, ep, balOnly]);
    const negV = read(neg);
    console.log(`       ${negV ? `UNEXPECTEDLY SUCCEEDED: raw ${negV.raw} — the enable sig was not actually checked` : `refused (expected): ${errText(neg.error)}`}`);

    if (!slotOk[t.address]) {
      console.log(`\n     MAIN MEASUREMENT SKIPPED — the owner-slot formula did not verify for this target (step 0). Not a zero; unmeasured.\n`);
      continue;
    }
    console.log(`\n     MAIN: same op + owner-slot stateDiff pointing at the throwaway key`);
    const main = await rpc(bundler, "eth_estimateUserOperationGas", [op, ep, ownerOverride]);
    const v = read(main);
    if (!v) {
      console.log(`       NO NUMBER — BLOCKED: ${errText(main.error)}`);
      console.log(`       This is "I could not measure it", NOT "it costs nothing".\n`);
      continue;
    }
    const b = bound(v.call, v.ver, v.pre);
    console.log(`       verif ${v.ver} · preVerif ${v.pre} · call ${v.call} · RAW TOTAL ${v.raw}`);
    console.log(`       bounded (2.0x call, 1.25x verif, 1.25x preVerif) = ${b}`);

    // WHAT THE EXECUTOR ACTUALLY DOES. executor.ts sizes the estimate's balance
    // override from the ceiling it already picked (bounds.absoluteMax x feeCeiling
    // x 2). A renewal takes the 3M branch, so the simulation is handed 6,000,000
    // gas' worth of imaginary ETH for an operation needing ~7.5M.
    console.log(`\n     WHAT THE EXECUTOR'S OWN 3M-SIZED OVERRIDE PRODUCES (3,000,000 x feeCeiling x 2):`);
    const smallBal = 3_000_000n * maxFeePerGas * 2n;
    const smallOverride = {
      [t.address]: { balance: `0x${smallBal.toString(16)}` },
      [ECDSA_VALIDATOR]: { stateDiff: { [slotOf(t.address)]: `0x${owner.address.slice(2).toLowerCase().padStart(64, "0")}` } },
    };
    const small = await rpc(bundler, "eth_estimateUserOperationGas", [op, ep, smallOverride]);
    const sv = read(small);
    console.log(`       override ${smallBal} wei (buys ${smallBal / maxFeePerGas} gas)`);
    console.log(`       ${sv ? `-> raw ${sv.raw} -> bounded ${bound(sv.call, sv.ver, sv.pre)} -> rule "gas-absurd"` : `-> REFUSED: ${errText(small.error)}\n       -> boundGas is handed null -> rule "gas-unreadable" (no gas figure ever logged)`}`);
    console.log(`\n     ── VERDICT FOR THIS TARGET ──`);
    console.log(`       deployed re-enable RAW   ${v.raw}`);
    console.log(`       undeployed first op RAW  ${UNDEPLOYED_ANCHOR.raw}  (verif ${UNDEPLOYED_ANCHOR.ver} · preVerif ${UNDEPLOYED_ANCHOR.pre} · call ${UNDEPLOYED_ANCHOR.call})`);
    console.log(`       delta                    ${v.raw - UNDEPLOYED_ANCHOR.raw}  (${((Number(v.raw) / Number(UNDEPLOYED_ANCHOR.raw)) * 100).toFixed(1)}% of the undeployed op)`);
    console.log(`       vs GAS_BOUNDS 3,000,000            bounded ${b} => ${b > 3_000_000n ? "REFUSED (gas-absurd)" : "accepted"}   [what PR#56 gives a renewal]`);
    console.log(`       vs FIRST_ENABLE_GAS_BOUNDS 12,000,000  bounded ${b} => ${b > 12_000_000n ? "REFUSED" : "accepted"}   [what it gives an undeployed first op]`);
    console.log(`       control (a) status: ${controlAok ? "passed" : "NOT passed — discount this number"}\n`);
  }
}

main().catch((e) => { console.error("reenable failed:", e instanceof Error ? e.message : String(e)); process.exit(1); });
