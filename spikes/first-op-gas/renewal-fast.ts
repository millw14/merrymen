/**
 * THE SAME QUESTION AS renewal.ts, ANSWERED WITHOUT SCANNING 53M BLOCKS.
 *
 * probe.ts anchors on a landed sudo deploy: tx 0xc6562c38…, block 51207025. Pull
 * that transaction's receipt, read the EntryPoint's AccountDeployed log out of
 * it to get a REAL deployed Kernel account on 4663, and then ask: with a FRESH
 * session key (what a renewal mints), what does that account's nonce say?
 *
 * Also scans a bounded window of recent blocks for other AccountDeployed events,
 * so the population question gets whatever answer the RPC will actually give.
 *
 * READ-ONLY: eth_getTransactionReceipt, eth_getLogs, eth_getCode, eth_call.
 * Nothing is signed, nothing is broadcast, no key here is ever funded.
 *
 * Run: railway run --service orchestrator -- npx tsx spikes/first-op-gas/renewal-fast.ts
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
const ANCHOR_BLOCK = 51_207_025n; // probe.ts LANDED note

function isFirstEnable(nonce: bigint): boolean {
  return ((nonce >> 248n) & 0xffn) === 0x01n && ((nonce >> 240n) & 0xffn) === 0x02n;
}

async function rpc(method: string, params: unknown[]) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await r.json()) as { result?: unknown; error?: { message?: string } };
}

interface Log { topics: string[]; blockNumber: string; transactionHash: string }

async function main() {
  const chain = chainForId(CHAIN_ID);
  const publicClient = createPublicClient({ chain, transport: http(RPC) });
  const entryPoint = getEntryPoint("0.7");
  const topic0 = keccak256(toHex("AccountDeployed(bytes32,address,address,address)"));

  const latest = BigInt((await rpc("eth_blockNumber", [])).result as string);
  console.log(`chain ${CHAIN_ID} · latest ${latest} · AccountDeployed topic0 ${topic0}`);

  // ── find deployed accounts, in whatever window the RPC will serve ────────
  const found = new Map<string, string>(); // account -> "block <n> tx <hash>"
  const windows: Array<[bigint, bigint]> = [];
  // Widening windows around the anchor and up to head. Each is small enough that
  // the node will not time out the way the full range did.
  for (let b = ANCHOR_BLOCK - 200_000n; b < latest; b += 200_000n) {
    windows.push([b, b + 199_999n > latest ? latest : b + 199_999n]);
  }
  console.log(`\n── SCANNING ${windows.length} windows of 200k blocks, ${ANCHOR_BLOCK - 200_000n} .. ${latest} ──`);
  const unread: string[] = [];
  for (const [from, to] of windows) {
    const r = await rpc("eth_getLogs", [
      { address: ENTRYPOINT, topics: [topic0], fromBlock: toHex(from), toBlock: toHex(to) },
    ]);
    if (!Array.isArray(r.result)) {
      unread.push(`${from}..${to}: ${r.error?.message ?? "unknown"}`);
      continue;
    }
    for (const l of r.result as Log[]) {
      const acct = (`0x${l.topics[2]!.slice(26)}`).toLowerCase();
      if (!found.has(acct)) found.set(acct, `block ${BigInt(l.blockNumber)} tx ${l.transactionHash}`);
    }
  }
  console.log(`  distinct accounts deployed in this window: ${found.size}`);
  if (unread.length) {
    console.log(`  WINDOWS THAT COULD NOT BE READ (${unread.length}) — unreadable, NOT empty:`);
    for (const u of unread.slice(0, 8)) console.log(`    ${u}`);
  }
  for (const [a, where] of found) console.log(`    ${a}  ${where}`);

  if (!found.size) {
    console.log("\n  NO ACCOUNTS FOUND IN THE SCANNED WINDOW. That is a statement about the window, not the chain.");
    return;
  }

  // ── the renewal question, per real deployed account ──────────────────────
  const sudoSigner = privateKeyToAccount(generatePrivateKey()); // throwaway, never signs
  const ecdsa = await signerToEcdsaValidator(publicClient, {
    signer: sudoSigner,
    entryPoint,
    kernelVersion: KERNEL_V3_3,
  });

  console.log(`\n── A RENEWED KEY'S FIRST OP, ON AN ACCOUNT THAT IS ALREADY DEPLOYED ──`);
  console.log(`  ${"account".padEnd(44)} ${"code".padEnd(6)} mode  vType  isFirstEnable  PR#56 firstEnable  ceiling`);
  for (const addr of [...found.keys()] as Address[]) {
    const sessionSigner = await toECDSASigner({ signer: privateKeyToAccount(generatePrivateKey()) });
    const { policies } = buildWallPolicies({ caps: CAPS, smartAccount: addr });
    const permission = await toPermissionValidator(publicClient, {
      entryPoint, kernelVersion: KERNEL_V3_3, signer: sessionSigner, policies, flag: WALL_POLICY_FLAG,
    });
    let code = "UNREAD";
    try {
      const c = await publicClient.getCode({ address: addr });
      code = c && c !== "0x" ? "YES" : "no";
    } catch { /* stays UNREAD — not "no" */ }
    try {
      const account = await createKernelAccount(publicClient, {
        entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ecdsa, regular: permission }, address: addr,
      });
      const nonce = await account.getNonce();
      const mode = (nonce >> 248n) & 0xffn;
      const vType = (nonce >> 240n) & 0xffn;
      const fe = isFirstEnable(nonce);
      const live = code === "YES";
      const gate = !live && fe; // worker/src/executor.ts:391
      console.log(
        `  ${addr.padEnd(44)} ${code.padEnd(6)} 0x${mode.toString(16).padStart(2, "0")}  0x${vType.toString(16).padStart(2, "0")}   ` +
          `${String(fe).padEnd(13)} ${String(gate).padEnd(17)} ${gate ? "12,000,000" : "3,000,000  <-- REFUSES A ~7.4M RENEWAL"}`,
      );
    } catch (e) {
      console.log(`  ${addr.padEnd(44)} ${code.padEnd(6)} NONCE UNREADABLE — ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`);
    }
  }

  // ── control: undeployed, the case PR #56 measured ────────────────────────
  const o = privateKeyToAccount(generatePrivateKey());
  const oe = await signerToEcdsaValidator(publicClient, { signer: o, entryPoint, kernelVersion: KERNEL_V3_3 });
  const so = await createKernelAccount(publicClient, { entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: oe } });
  const ss = await toECDSASigner({ signer: privateKeyToAccount(generatePrivateKey()) });
  const { policies: p } = buildWallPolicies({ caps: CAPS, smartAccount: so.address });
  const pv = await toPermissionValidator(publicClient, { entryPoint, kernelVersion: KERNEL_V3_3, signer: ss, policies: p, flag: WALL_POLICY_FLAG });
  const fa = await createKernelAccount(publicClient, { entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: oe, regular: pv } });
  const fc = await publicClient.getCode({ address: fa.address }).catch(() => undefined);
  const fn = await fa.getNonce();
  console.log(`\n── CONTROL: brand-new undeployed account ──`);
  console.log(
    `  ${fa.address}  code ${fc && fc !== "0x" ? "YES" : "no"}  mode 0x${((fn >> 248n) & 0xffn).toString(16).padStart(2, "0")}  ` +
      `vType 0x${((fn >> 240n) & 0xffn).toString(16).padStart(2, "0")}  isFirstEnable ${isFirstEnable(fn)}  PR#56 firstEnable ${isFirstEnable(fn)}  ceiling 12,000,000`,
  );
}

main().catch((e) => {
  console.error("failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
