/**
 * REGRESSION PROBE FOR THE PROPOSED FIX.
 *
 * The proposed fix drops `!accountLive` and gates the 12,000,000 ceiling on
 * isFirstEnable(nonce) alone. This asks what ELSE reaches an ENABLE-mode nonce
 * on a DEPLOYED account, and what it costs.
 *
 * The SDK decides ENABLE vs DEFAULT from ONE eth_call: permissionConfig(pId) on
 * the account. toPermissionValidator.isEnabled wraps it in try/catch and returns
 * FALSE on any error, and the other disjunct (isPluginInitialized) is called with
 * zeroAddress so it always throws to false too. So a single failed eth_call turns
 * a STEADY-STATE op -- permission already installed, would have been mode 0x00 and
 * ~1M gas -- into an ENABLE-mode op carrying the whole 10.9KB enable blob.
 *
 * Under the CURRENT gate that op is deployed => 3,000,000 => refused.
 * Under the PROPOSED gate it is isFirstEnable => 12,000,000 => signed, if it
 * estimates. This measures whether it estimates, and for how much.
 *
 * READ-ONLY. eth_call / eth_getStorageAt / eth_getCode / eth_estimateUserOperationGas
 * only. Nothing signed for broadcast, nothing broadcast, nothing funded, no real
 * grant touched. Keys are generated here and never used again.
 *
 * Run: railway run --service orchestrator -- npx tsx spikes/first-op-gas/reenable-blip.ts
 */
import {
  createPublicClient, custom, encodeAbiParameters, encodeFunctionData, erc20Abi, http,
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
const ECDSA_VALIDATOR = "0x845ADb2C711129d4f3966735eD98a9F09fC4cE57" as Address;

/** Real deployed Kernel v3.3 account on 4663 with a REAL installed permissionId. */
const TARGET = "0xa48cE91e2F3237E69660C1543042c007B8D33e75" as Address;
const INSTALLED_PID = "0x3ca1cec8" as Hex;

const PERM_CONFIG_SEL = "0xc3e58978"; // permissionConfig(bytes4)

async function rpc(url: string, method: string, params: unknown[]) {
  const r = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await r.json()) as { result?: unknown; error?: unknown };
}
const errText = (e: unknown) => {
  const o = e as { message?: string; data?: unknown; code?: unknown } | null;
  return [o?.code !== undefined ? "code " + String(o.code) : "", o?.message ?? "",
    typeof o?.data === "string" ? o.data : ""].filter(Boolean).join(" | ").slice(0, 300);
};

/** http transport that can throw locally on the ONE call the mode decision reads. */
function faultyTransport(breakPermissionConfig: boolean) {
  const inner = http(RPC)({ chain: undefined, retryCount: 0 });
  let broke = 0;
  const t = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      if (breakPermissionConfig && method === "eth_call") {
        const p = (params as [{ to?: string; data?: string }])?.[0];
        if (p?.data?.startsWith(PERM_CONFIG_SEL)) {
          broke++;
          throw new Error("INJECTED: permissionConfig read failed (simulated RPC blip)");
        }
      }
      return inner.request({ method, params } as never);
    },
  });
  return { transport: t, broken: () => broke };
}

async function main() {
  const chain = chainForId(CHAIN_ID);
  const bundler = pimlicoBundlerUrl(CHAIN_ID, process.env.MERRYMEN_BUNDLER_API_KEY ?? "");
  const entryPoint = getEntryPoint("0.7");
  const plain = createPublicClient({ chain, transport: http(RPC) });

  console.log("chain " + CHAIN_ID + " | target " + TARGET);
  const code = await plain.getCode({ address: TARGET });
  console.log("  code: " + (code && code !== "0x" ? ((code.length - 2) / 2) + " bytes -- DEPLOYED" : "UNREAD/none"));
  if (!code || code === "0x") { console.log("ABORT: target not deployed"); return; }

  // -- the installed permissionConfig, read directly --------------------------
  const pc = await rpc(RPC, "eth_call", [
    { to: TARGET, data: PERM_CONFIG_SEL + INSTALLED_PID.slice(2) + "0".repeat(56) }, "latest",
  ]);
  if (pc.error) { console.log("  permissionConfig UNREAD: " + errText(pc.error)); return; }
  const raw = pc.result as string;
  const flag = "0x" + raw.slice(2 + 64 + 60, 2 + 128);
  const signer = "0x" + raw.slice(2 + 128 + 24, 2 + 192);
  console.log("  permissionConfig(" + INSTALLED_PID + ") -> flag " + flag + " signer " + signer);
  if (/^0x0+$/.test(signer)) { console.log("ABORT: pid not actually installed"); return; }

  // -- the account, pinned to the live target, pId forced to the installed one -
  const ownerKey = generatePrivateKey();
  const owner = privateKeyToAccount(ownerKey);
  const sessionSigner = await toECDSASigner({ signer: privateKeyToAccount(generatePrivateKey()) });
  const { policies } = buildWallPolicies({
    caps: { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 },
    smartAccount: TARGET,
  });

  const build = async (breakIt: boolean) => {
    const { transport, broken } = faultyTransport(breakIt);
    const pub = createPublicClient({ chain, transport });
    const ecdsa = await signerToEcdsaValidator(pub, { signer: owner, entryPoint, kernelVersion: KERNEL_V3_3 });
    const permission = await toPermissionValidator(pub, {
      entryPoint, kernelVersion: KERNEL_V3_3, signer: sessionSigner, policies,
      flag: WALL_POLICY_FLAG,
      // CONTROL: no explicit permissionId -- a FRESH one, i.e. a genuine renewal
    });
    const account = await createKernelAccount(pub, {
      entryPoint, kernelVersion: KERNEL_V3_3, address: TARGET,
      plugins: { sudo: ecdsa, regular: permission },
    });
    return { account, broken };
  };

  const fees = await plain.estimateFeesPerGas().catch(() => null);
  const maxFeePerGas = fees?.maxFeePerGas ?? 1_000_000_000n;
  const maxPriorityFeePerGas = fees?.maxPriorityFeePerGas ?? 0n;

  // owner-slot override so the enable signature verifies (verified 2 ways below)
  const slot = keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }], [TARGET, 0n],
  ));
  const view = await rpc(RPC, "eth_call", [
    { to: ECDSA_VALIDATOR, data: "0x20709efc" + TARGET.slice(2).toLowerCase().padStart(64, "0") }, "latest",
  ]);
  const store = await rpc(RPC, "eth_getStorageAt", [ECDSA_VALIDATOR, slot, "latest"]);
  const fromView = "0x" + String(view.result ?? "").slice(-40);
  const fromStore = "0x" + String(store.result ?? "").slice(-40);
  console.log("  owner slot: view " + fromView + " | storage " + fromStore + " | " + (fromView === fromStore ? "AGREE" : "DISAGREE"));
  if (fromView !== fromStore || /^0x0+$/.test(fromView)) { console.log("ABORT: owner slot unverified"); return; }

  const ownerOverride: Record<string, unknown> = {
    [ECDSA_VALIDATOR]: { stateDiff: { [slot]: "0x" + owner.address.slice(2).toLowerCase().padStart(64, "0") } },
  };

  const cases: Array<[string, boolean]> = [["FRESH pId - GENUINE RENEWAL, healthy RPC", false]];
  for (const [label, breakIt] of cases) {
    console.log("\n-- " + label + " -------------------------------------");
    const { account, broken } = await build(breakIt);
    const nonce = await account.getNonce();
    const mode = (nonce >> 248n) & 0xffn, vType = (nonce >> 240n) & 0xffn;
    const isFE = mode === 0x01n && vType === 0x02n;
    console.log("  injected failures: " + broken());
    console.log("  nonce 0x" + nonce.toString(16).padStart(64, "0"));
    console.log("  mode 0x" + mode.toString(16).padStart(2, "0") + " vType 0x" + vType.toString(16).padStart(2, "0") + " -> isFirstEnable " + isFE);
    console.log("  accountLive TRUE -> PR#56 ceiling 3,000,000 | PROPOSED ceiling " + (isFE ? "12,000,000" : "3,000,000"));

    const callData = await account.encodeCalls([{
      to: CASH.USDG as Address, value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [UNISWAP.swapRouter02 as Address, 5_000_000n] }),
    }]);
    const stub = await account.getStubSignature({
      sender: TARGET, nonce, callData, callGasLimit: 0n, verificationGasLimit: 0n,
      preVerificationGas: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, signature: "0x",
    } as never);
    const sigBytes = (stub.length - 2) / 2;
    console.log("  stub signature: " + sigBytes + " bytes " + (sigBytes > 1000 ? "<- CARRIES AN ENABLE BLOB" : "(no enable blob)"));

    const op = {
      sender: TARGET, nonce: "0x" + nonce.toString(16), callData, signature: stub,
      maxFeePerGas: "0x" + maxFeePerGas.toString(16),
      maxPriorityFeePerGas: "0x" + maxPriorityFeePerGas.toString(16),
    };
    for (const ceiling of [12_000_000n, 3_000_000n]) {
      const bal = ceiling * maxFeePerGas * 2n;
      const ov = { ...ownerOverride, [TARGET]: { balance: "0x" + bal.toString(16) } };
      const r = await rpc(bundler, "eth_estimateUserOperationGas", [op, entryPoint.address, ov]);
      if (r.error) { console.log("  ceiling " + ceiling + ": REFUSED -- " + errText(r.error)); continue; }
      const o = r.result as Record<string, string>;
      const n = (k: string) => (o[k] === undefined ? 0n : BigInt(o[k]));
      const v = n("verificationGasLimit"), p = n("preVerificationGas"), c = n("callGasLimit");
      const rawTotal = v + p + c;
      const bounded = (v * 12500n) / 10000n + (p * 12500n) / 10000n + (c * 20000n) / 10000n;
      console.log("  ceiling " + ceiling + ": verif " + v + " | preVerif " + p + " | call " + c +
        " | raw " + rawTotal + " | bounded " + bounded + " -> " + (bounded > ceiling ? "REFUSED gas-absurd" : "ACCEPTED"));
    }
  }
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
