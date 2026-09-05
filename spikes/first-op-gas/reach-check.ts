/**
 * REACHABILITY CHECK (adversarial verifier, read-only).
 *
 * Question: on a REAL already-deployed Kernel v3.3 account that ALREADY carries
 * an installed permission validator (i.e. the exact post-first-op state a
 * merrymen renewal lands on), does a FRESH merrymen wall + FRESH session key
 * still produce an ENABLE-mode nonce — so PR #56's `!accountLive && isFirstEnable`
 * evaluates FALSE and the op is handed the 3,000,000 ceiling?
 *
 * Reads only: eth_getCode, eth_call. Nothing signed, sent, funded or deployed.
 * Keys are generated here and never used for anything else.
 *
 * Run: npx tsx spikes/first-op-gas/reach-check.ts   (no bundler key needed)
 */
import { createPublicClient, http, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getEntryPoint, KERNEL_V3_3 } from "@zerodev/sdk/constants";
import { createKernelAccount } from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { toPermissionValidator } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { buildWallPolicies, chainForId, WALL_POLICY_FLAG } from "../../packages/core/src/index";
import { isFirstEnable } from "../../worker/src/executor";
import { GAS_BOUNDS, FIRST_ENABLE_GAS_BOUNDS } from "../../worker/src/gas-limits";

const CHAIN_ID = 4663;
const RPC = "https://rpc.mainnet.chain.robinhood.com";

/** Real deployed Kernel v3.3 accounts on 4663. The first has an installed wall. */
const TARGETS: { addr: Address; note: string; installedPid?: `0x${string}` }[] = [
  {
    addr: "0xa48cE91e2F3237E69660C1543042c007B8D33e75",
    note: "deployed AND already carries an installed permission validator",
    installedPid: "0x3ca1cec8",
  },
  {
    addr: "0x032Da6A0Ccf866474e45854E7fDEF9afd1509036",
    note: "merrymen's own account (sudo deploy only, no wall ever installed)",
  },
];

const caps = { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 };

async function main() {
  const chain = chainForId(CHAIN_ID);
  const publicClient = createPublicClient({ chain, transport: http(RPC) });
  const entryPoint = getEntryPoint("0.7");
  const ownerKey = generatePrivateKey();
  const ecdsa = await signerToEcdsaValidator(publicClient, {
    signer: privateKeyToAccount(ownerKey),
    entryPoint,
    kernelVersion: KERNEL_V3_3,
  });

  for (const t of TARGETS) {
    console.log(`\n=== ${t.addr}  (${t.note})`);
    let code: string | undefined;
    try {
      code = await publicClient.getCode({ address: t.addr });
    } catch (e) {
      console.log(`  UNREAD: eth_getCode failed — ${(e as Error).message.slice(0, 120)}`);
      continue;
    }
    const live = code !== undefined && code !== "0x";
    console.log(`  code ${code === undefined ? "undefined" : `${(code.length - 2) / 2} bytes`} · isDeployed() -> ${live}`);

    const build = async (pid?: `0x${string}`) => {
      const sessionSigner = await toECDSASigner({ signer: privateKeyToAccount(generatePrivateKey()) });
      const { policies } = buildWallPolicies({ caps, smartAccount: t.addr });
      const permission = await toPermissionValidator(publicClient, {
        entryPoint,
        kernelVersion: KERNEL_V3_3,
        signer: sessionSigner,
        policies,
        flag: WALL_POLICY_FLAG,
        ...(pid ? { permissionId: pid } : {}),
      } as never);
      const account = await createKernelAccount(publicClient, {
        entryPoint,
        kernelVersion: KERNEL_V3_3,
        plugins: { sudo: ecdsa, regular: permission },
        address: t.addr,
      });
      return { account, pid: permission.getIdentifier() };
    };

    // (1) THE RENEWAL: a brand-new session key on this live account.
    try {
      const { account, pid } = await build();
      const nonce = await account.getNonce();
      const mode = (nonce >> 248n) & 0xffn;
      const vType = (nonce >> 240n) & 0xffn;
      const fe = isFirstEnable(nonce);
      const gate = !live && fe;
      console.log(
        `  RENEWAL  pid ${pid} · nonce 0x${nonce.toString(16).padStart(64, "0")}\n` +
          `           mode 0x${mode.toString(16).padStart(2, "0")} vType 0x${vType.toString(16).padStart(2, "0")} · ` +
          `isFirstEnable=${fe} accountLive=${live} · PR#56 firstEnable=${gate} · ` +
          `ceiling ${(gate ? FIRST_ENABLE_GAS_BOUNDS : GAS_BOUNDS).absoluteMax}`,
      );
    } catch (e) {
      console.log(`  UNREAD: renewal nonce probe failed — ${(e as Error).message.slice(0, 200)}`);
    }

    // (2) CONTROL: the permissionId this account PROVABLY installed already.
    if (t.installedPid) {
      try {
        const { account, pid } = await build(t.installedPid);
        const nonce = await account.getNonce();
        const mode = (nonce >> 248n) & 0xffn;
        console.log(
          `  INSTALLED pid ${pid} · mode 0x${mode.toString(16).padStart(2, "0")} · ` +
            `isFirstEnable=${isFirstEnable(nonce)}  (expect mode 0x00 — steady state)`,
        );
      } catch (e) {
        console.log(`  UNREAD: installed-pid probe failed — ${(e as Error).message.slice(0, 200)}`);
      }
    }

    // (3) CONTROL: a bogus permissionId — proves the SDK really reads storage.
    try {
      const { account } = await build("0xdeadbeef");
      const nonce = await account.getNonce();
      const mode = (nonce >> 248n) & 0xffn;
      console.log(`  BOGUS pid 0xdeadbeef · mode 0x${mode.toString(16).padStart(2, "0")}  (expect 0x01)`);
    } catch (e) {
      console.log(`  UNREAD: bogus-pid probe failed — ${(e as Error).message.slice(0, 200)}`);
    }
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
