/**
 * DOES A RENEWED SESSION KEY STILL CARRY THE ENABLE — ON AN ACCOUNT THAT IS
 * ALREADY DEPLOYED?
 *
 * PR #56 gates the elevated 12M ceiling on `!accountLive && isFirstEnable(nonce)`.
 * The worry is that the expensive thing (the permission-validator enable) is
 * one-time per SESSION KEY, not one-time per ACCOUNT — so a renewal on a live
 * account would carry the same ~7M of verification gas with `accountLive` true,
 * and be refused by the 3M ceiling.
 *
 * This decides it from the chain, read-only:
 *
 *   1. Enumerate every account the EntryPoint has ever deployed on 4663
 *      (eth_getLogs, AccountDeployed) — the population under discussion.
 *   2. For each one, build the account object EXACTLY as the worker does
 *      (sudo + a regular PERMISSION validator, address pinned to the real
 *      deployed account) but with a FRESH session key, and ask it for its
 *      nonce. `getNonceKey` decides the mode by reading the CHAIN
 *      (isPluginEnabled -> permissionConfig(permissionId) on the real account),
 *      so the top two bytes that come back are the real answer for a renewal.
 *   3. Print isFirstEnable(nonce) and accountLive side by side, i.e. exactly
 *      what worker/src/executor.ts:391 computes.
 *
 * NOTHING IS SIGNED AND NOTHING IS BROADCAST. Only eth_getLogs, eth_getCode and
 * eth_call (readContract) are used. The sudo key is generated here, is not the
 * owner of any of these accounts, is never funded and never written to disk —
 * it exists only so the SDK will assemble a plugin manager; no signature it
 * could produce is ever asked for.
 *
 * Run: railway run --service orchestrator -- npx tsx spikes/first-op-gas/renewal.ts
 * (the bundler key is not needed — this touches only the public chain RPC.)
 */
import { createPublicClient, http, keccak256, toHex, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getEntryPoint, KERNEL_V3_3 } from "@zerodev/sdk/constants";
import { createKernelAccount } from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { toPermissionValidator } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { buildWallPolicies, chainForId, WALL_POLICY_FLAG } from "../../packages/core/src/index";

const CHAIN_ID = 4663;
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const ENTRYPOINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;
const CAPS = { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 };

/** worker/src/executor.ts:154, copied verbatim so the spike cannot drift from it. */
function isFirstEnable(nonce: bigint): boolean {
  const mode = (nonce >> 248n) & 0xffn;
  const vType = (nonce >> 240n) & 0xffn;
  return mode === 0x01n && vType === 0x02n;
}

async function rpc(method: string, params: unknown[]): Promise<{ result?: unknown; error?: { message?: string } }> {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await r.json()) as { result?: unknown; error?: { message?: string } };
}

interface Log {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
}

/** Every AccountDeployed the EntryPoint has emitted, chunking the range as needed. */
async function accountsDeployed(latest: bigint): Promise<{ logs: Log[]; scanned: string; failed: string[] }> {
  const topic0 = keccak256(toHex("AccountDeployed(bytes32,address,address,address)"));
  console.log(`  AccountDeployed topic0 = ${topic0}`);
  const failed: string[] = [];

  // Try the whole range first — many RPCs allow it for an address+topic filter.
  const whole = await rpc("eth_getLogs", [
    { address: ENTRYPOINT, topics: [topic0], fromBlock: "0x0", toBlock: toHex(latest) },
  ]);
  if (Array.isArray(whole.result)) {
    console.log(`  full-range eth_getLogs ACCEPTED (0 .. ${latest})`);
    return { logs: whole.result as Log[], scanned: `0..${latest} (single call)`, failed };
  }
  console.log(`  full-range eth_getLogs refused: ${whole.error?.message ?? "unknown"} — chunking`);

  const out: Log[] = [];
  // Chunk size chosen to be polite; widened/narrowed by what the RPC accepts.
  let step = 100_000n;
  let from = 0n;
  while (from <= latest) {
    const to = from + step - 1n > latest ? latest : from + step - 1n;
    const r = await rpc("eth_getLogs", [
      { address: ENTRYPOINT, topics: [topic0], fromBlock: toHex(from), toBlock: toHex(to) },
    ]);
    if (Array.isArray(r.result)) {
      out.push(...(r.result as Log[]));
      from = to + 1n;
      continue;
    }
    if (step > 1_000n) {
      step /= 10n; // narrow and retry the same window
      continue;
    }
    failed.push(`${from}..${to}: ${r.error?.message ?? "unknown"}`);
    from = to + 1n;
    step = 100_000n;
  }
  return { logs: out, scanned: `0..${latest} (chunked)`, failed };
}

async function main() {
  const chain = chainForId(CHAIN_ID);
  const publicClient = createPublicClient({ chain, transport: http(RPC) });
  const entryPoint = getEntryPoint("0.7");

  const latestHex = (await rpc("eth_blockNumber", [])).result as string | undefined;
  if (!latestHex) {
    console.error("could not read eth_blockNumber — cannot say anything about the population.");
    process.exit(1);
  }
  const latest = BigInt(latestHex);
  console.log(`chain ${CHAIN_ID} · latest block ${latest}`);

  console.log(`\n── 1. EVERY ACCOUNT THE ENTRYPOINT HAS DEPLOYED ON 4663 ──────`);
  const { logs, scanned, failed } = await accountsDeployed(latest);
  const senders = [...new Set(logs.map((l) => (`0x${l.topics[2]!.slice(26)}` as Address).toLowerCase()))];
  console.log(`  range scanned: ${scanned}`);
  console.log(`  AccountDeployed events: ${logs.length}`);
  console.log(`  distinct accounts:      ${senders.length}`);
  if (failed.length) {
    console.log(`  RANGES THAT COULD NOT BE READ (${failed.length}) — this is "unreadable", NOT "empty":`);
    for (const f of failed.slice(0, 10)) console.log(`    ${f}`);
  }
  for (const s of senders) console.log(`    ${s}`);

  // ── 2. a FRESH session key, the shape a renewal mints ────────────────────
  // The sudo signer is a throwaway. It is not the owner of any account below,
  // and nothing here ever asks it for a signature — createKernelAccount only
  // needs a validator object to assemble the plugin manager, and getNonce()
  // reads the chain rather than signing.
  const sudoSigner = privateKeyToAccount(generatePrivateKey());
  const ecdsa = await signerToEcdsaValidator(publicClient, {
    signer: sudoSigner,
    entryPoint,
    kernelVersion: KERNEL_V3_3,
  });

  console.log(`\n── 2. WHAT A RENEWED KEY'S FIRST OP LOOKS LIKE, PER ACCOUNT ──`);
  console.log(`  (fresh session key each time — exactly what mintGrant does)`);
  console.log(
    `  ${"account".padEnd(44)} ${"code".padEnd(6)} ${"mode".padEnd(5)} ${"vType".padEnd(6)} ${"permissionId".padEnd(12)} isFirstEnable  firstEnable(PR#56)  ceiling`,
  );

  const targets: Address[] = senders as Address[];
  for (const addr of targets) {
    // A NEW session key per account, because that is what a renewal is.
    const sessionKey = generatePrivateKey();
    const sessionSigner = await toECDSASigner({ signer: privateKeyToAccount(sessionKey) });
    const { policies } = buildWallPolicies({ caps: CAPS, smartAccount: addr });
    const permission = await toPermissionValidator(publicClient, {
      entryPoint,
      kernelVersion: KERNEL_V3_3,
      signer: sessionSigner,
      policies,
      flag: WALL_POLICY_FLAG,
    });

    let code = "?";
    try {
      const c = await publicClient.getCode({ address: addr });
      code = c && c !== "0x" ? "YES" : "no";
    } catch (e) {
      code = "UNREAD"; // an unread answer is not "no"
      console.log(`    (getCode failed for ${addr}: ${e instanceof Error ? e.message : String(e)})`);
    }

    try {
      const account = await createKernelAccount(publicClient, {
        entryPoint,
        kernelVersion: KERNEL_V3_3,
        plugins: { sudo: ecdsa, regular: permission },
        // PIN to the real deployed account. Without this the SDK derives the
        // counterfactual address of the throwaway sudo key and the chain read
        // below would be about an account that does not exist.
        address: addr,
      });
      const nonce = await account.getNonce();
      const mode = (nonce >> 248n) & 0xffn;
      const vType = (nonce >> 240n) & 0xffn;
      const fe = isFirstEnable(nonce);
      const accountLive = code === "YES";
      // worker/src/executor.ts:391-392
      const prGate = !accountLive && fe;
      console.log(
        `  ${addr.padEnd(44)} ${code.padEnd(6)} 0x${mode.toString(16).padStart(2, "0")}  0x${vType
          .toString(16)
          .padStart(2, "0")}   ${permission.getIdentifier().padEnd(12)} ${String(fe).padEnd(13)} ${String(prGate).padEnd(19)} ${prGate ? "12,000,000" : "3,000,000"}`,
      );
    } catch (e) {
      console.log(`  ${addr.padEnd(44)} ${code.padEnd(6)} NONCE UNREADABLE — ${e instanceof Error ? e.message.slice(0, 90) : String(e)}`);
    }
  }

  // ── 3. CONTROL: the same construction on an UNDEPLOYED account ───────────
  // If the deployed rows above read 0x01/0x02, this must too — otherwise the
  // reading is an artefact of pinning an address rather than a fact about the
  // enable.
  console.log(`\n── 3. CONTROL: a brand-new, undeployed account (the case PR #56 measured) ──`);
  const freshOwner = privateKeyToAccount(generatePrivateKey());
  const freshEcdsa = await signerToEcdsaValidator(publicClient, {
    signer: freshOwner,
    entryPoint,
    kernelVersion: KERNEL_V3_3,
  });
  const sudoOnly = await createKernelAccount(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    plugins: { sudo: freshEcdsa },
  });
  const freshSession = await toECDSASigner({ signer: privateKeyToAccount(generatePrivateKey()) });
  const { policies: freshPolicies } = buildWallPolicies({ caps: CAPS, smartAccount: sudoOnly.address });
  const freshPermission = await toPermissionValidator(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    signer: freshSession,
    policies: freshPolicies,
    flag: WALL_POLICY_FLAG,
  });
  const freshAccount = await createKernelAccount(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    plugins: { sudo: freshEcdsa, regular: freshPermission },
  });
  const freshCode = await publicClient.getCode({ address: freshAccount.address }).catch(() => undefined);
  const freshNonce = await freshAccount.getNonce();
  console.log(
    `  ${freshAccount.address}  code ${freshCode && freshCode !== "0x" ? "YES" : "no"}  ` +
      `mode 0x${((freshNonce >> 248n) & 0xffn).toString(16).padStart(2, "0")}  ` +
      `vType 0x${((freshNonce >> 240n) & 0xffn).toString(16).padStart(2, "0")}  ` +
      `isFirstEnable ${isFirstEnable(freshNonce)}  ->  PR#56 firstEnable ${isFirstEnable(freshNonce)}  ceiling 12,000,000`,
  );

  // ── 4. SECOND CONTROL: does a SECOND op of the SAME key drop the enable? ──
  // The nonce mode is a function of whether the plugin is enabled on chain, not
  // of the sequence, so this reads the same until the enable actually lands.
  // Printed so nobody mistakes "one-time" for "one-time per account".
  console.log(`\n── 4. the sequence is not consulted (executor.ts:154 comment, checked) ──`);
  console.log(`  nonce           ${freshNonce}`);
  console.log(`  nonce + 7 (seq) ${freshNonce + 7n}  isFirstEnable ${isFirstEnable(freshNonce + 7n)}`);
}

main().catch((e) => {
  console.error("renewal spike failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
