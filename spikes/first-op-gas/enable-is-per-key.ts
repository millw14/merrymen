/**
 * IS THE ENABLE ONE-TIME PER ACCOUNT, OR ONE-TIME PER SESSION KEY?
 *
 * PR #56 gates the elevated 12M ceiling on `!accountLive && isFirstEnable(nonce)`.
 * The `!accountLive` half assumes ENABLE-mode nonces only ever come from accounts
 * with no code. This spike tests that assumption against the chain.
 *
 * The subject is a REAL, ALREADY-DEPLOYED merrymen Kernel v3.3 account on 4663 —
 * 0x032da6a0…, deployed at block 51207025 by tx 0xc6562c38…, which is the same
 * landed deploy probe.ts anchors its numbers to. We point a FRESH permission
 * validator (new session key, real wall policies) at that live address and read
 * the nonce mode the SDK computes.
 *
 * READ-ONLY. Every chain call here is eth_getCode or eth_call. Nothing is signed,
 * nothing is broadcast, no grant is touched, no account is funded. The sudo and
 * session keys are generated per run and never leave memory — they exist only so
 * the SDK will construct a plugin manager we can interrogate.
 *
 * The public 4663 RPC rate-limits hard, so every read retries with backoff and a
 * read that never succeeded is reported as UNREAD — never as "absent".
 *
 * Run: npx tsx spikes/first-op-gas/enable-is-per-key.ts
 */
import { createPublicClient, http, zeroAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getEntryPoint, KERNEL_V3_3 } from "@zerodev/sdk/constants";
import { createKernelAccount, KernelV3AccountAbi } from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { toPermissionValidator } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { buildWallPolicies, chainForId } from "../../packages/core/src/index";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const CAPS = { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 };

/** A real deployed merrymen Kernel v3.3 account (EntryPoint 0.7 AccountDeployed log). */
const LIVE_ACCOUNT = "0x032da6a0ccf866474e45854e7fdef9afd1509036" as Address;
const LIVE_NOTE = "deployed block 51207025, tx 0xc6562c389d676471e09b56b01a129ef31f816b659f7322c452dcf9bcf43c4a60";

const modeOf = (n: bigint) => Number((n >> 248n) & 0xffn);
const vTypeOf = (n: bigint) => Number((n >> 240n) & 0xffn);
const hx = (n: number) => `0x${n.toString(16).padStart(2, "0")}`;

/** The exact PR #56 predicate, copied from worker/src/executor.ts:154-158. */
const isFirstEnable = (nonce: bigint) => ((nonce >> 248n) & 0xffn) === 0x01n && ((nonce >> 240n) & 0xffn) === 0x02n;

/** Retry anything that throws, so a 429 storm is a delay and not a false negative. */
async function patient<T>(label: string, fn: () => Promise<T>, tries = 14): Promise<{ ok: true; value: T } | { ok: false; why: string }> {
  let last = "";
  for (let i = 0; i < tries; i++) {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      last = String(e instanceof Error ? e.message : e).split("\n")[0]!.slice(0, 140);
      await new Promise((s) => setTimeout(s, Math.min(1000 * 2 ** i, 15_000)));
    }
  }
  console.log(`  UNREAD (${tries} attempts): ${label} — ${last}`);
  return { ok: false, why: last };
}

const publicClient = createPublicClient({
  chain: chainForId(4663),
  transport: http(RPC, { retryCount: 10, retryDelay: 1500, timeout: 30_000 }),
});
const entryPoint = getEntryPoint("0.7");

async function main() {
  console.log("READ-ONLY. eth_getCode / eth_call only. Nothing signed, nothing sent.\n");

  // one sudo validator, reused everywhere, so the RPC sees as few calls as possible
  const ecdsa = await signerToEcdsaValidator(publicClient, {
    signer: privateKeyToAccount(generatePrivateKey()),
    entryPoint,
    kernelVersion: KERNEL_V3_3,
  });

  const wall = async (smartAccount: Address, sessionKey: Hex) => {
    const signer = await toECDSASigner({ signer: privateKeyToAccount(sessionKey) });
    const { policies } = buildWallPolicies({ caps: CAPS, smartAccount });
    const permission = await toPermissionValidator(publicClient, {
      entryPoint,
      kernelVersion: KERNEL_V3_3,
      signer,
      policies,
      flag: "0x0002",
    });
    return { permission, sessionAddress: signer.account.address, policies };
  };

  // ── 0. is the subject really deployed? ────────────────────────────────────
  console.log(`── 0. SUBJECT ────────────────────────────────────────────────`);
  console.log(`  account   ${LIVE_ACCOUNT}`);
  console.log(`  ${LIVE_NOTE}`);
  const codeR = await patient("eth_getCode(live account)", () => publicClient.getCode({ address: LIVE_ACCOUNT }));
  const live = codeR.ok && !!codeR.value && codeR.value !== "0x";
  console.log(`  code      ${!codeR.ok ? "UNREAD — this is 'could not read', NOT 'nothing there'" : `${(codeR.value ?? "0x").length / 2 - 1} bytes`}`);
  console.log(`  isDeployed() would return: ${!codeR.ok ? "UNKNOWN (read failed)" : live ? "TRUE  (accountLive = true)" : "FALSE"}`);
  if (!codeR.ok) {
    console.log(`\n  Cannot continue honestly without knowing the deployment state. Stopping.`);
    process.exit(2);
  }

  // ── 1. the wall's regular validator has NO module address at all ──────────
  const keyA = generatePrivateKey();
  const keyB = generatePrivateKey();
  const a1 = await wall(LIVE_ACCOUNT, keyA);
  const a2 = await wall(LIVE_ACCOUNT, keyA); // same key, same policies — determinism check
  const b1 = await wall(LIVE_ACCOUNT, keyB);

  console.log(`\n── 1. THE PERMISSION VALIDATOR'S MODULE ADDRESS ──────────────`);
  console.log(`  regular.address = ${a1.permission.address}`);
  console.log(`  is zeroAddress? ${a1.permission.address === zeroAddress ? "YES" : "no"}`);
  console.log(`  => isPluginInitialized(client, account, 0x0) can never return true,`);
  console.log(`     so isPluginEnabled reduces entirely to permissionConfig(pId) on the ACCOUNT.`);

  // ── 2. does the permissionId move when the session key moves? ─────────────
  console.log(`\n── 2. permissionId vs SESSION KEY (identical policies, identical account) ──`);
  console.log(`  session key A ${a1.sessionAddress}  ->  pId ${a1.permission.getIdentifier()}`);
  console.log(`  session key A ${a2.sessionAddress}  ->  pId ${a2.permission.getIdentifier()}   (rebuilt)`);
  console.log(`  session key B ${b1.sessionAddress}  ->  pId ${b1.permission.getIdentifier()}`);
  console.log(`  same key => same pId?      ${a1.permission.getIdentifier() === a2.permission.getIdentifier() ? "YES (deterministic)" : "NO"}`);
  console.log(`  new key  => different pId? ${a1.permission.getIdentifier() !== b1.permission.getIdentifier() ? "YES — a renewal is a NEW permission" : "NO"}`);

  // ── 3. is that pId installed on the LIVE account? ─────────────────────────
  console.log(`\n── 3. permissionConfig(pId) ON THE LIVE, DEPLOYED ACCOUNT ────`);
  for (const [label, w] of [["key A", a1], ["key B", b1]] as const) {
    const pId = w.permission.getIdentifier();
    const cfgR = await patient(`permissionConfig(${pId})`, () =>
      publicClient.readContract({
        abi: KernelV3AccountAbi,
        address: LIVE_ACCOUNT,
        functionName: "permissionConfig",
        args: [pId],
      }),
    );
    if (cfgR.ok) {
      const cfg = cfgR.value as unknown as { permissionFlag: Hex; signer: Address; policyData: readonly Hex[] };
      console.log(`  ${label} pId ${pId}: signer=${cfg.signer} policies=${cfg.policyData.length}`);
    } else {
      console.log(`  ${label} pId ${pId}: UNREAD`);
    }
    const enR = await patient(`isEnabled(${pId})`, () => w.permission.isEnabled(LIVE_ACCOUNT, "0x00000000"));
    console.log(`     regular.isEnabled(live account) = ${enR.ok ? enR.value : "UNREAD"}`);
  }

  // ── 4. THE ANSWER: what nonce mode does a DEPLOYED account produce? ───────
  console.log(`\n── 4. NONCE MODE, DEPLOYED ACCOUNT + FRESH SESSION KEY ───────`);
  const liveAcct = await createKernelAccount(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    plugins: { sudo: ecdsa, regular: a1.permission },
    address: LIVE_ACCOUNT,
  });
  const liveNonceR = await patient("getNonce(live account)", () => liveAcct.getNonce());
  if (!liveNonceR.ok) {
    console.log(`  UNREAD — cannot answer. Stopping.`);
    process.exit(2);
  }
  const liveNonce = liveNonceR.value;
  console.log(`  nonce 0x${liveNonce.toString(16).padStart(64, "0")}`);
  console.log(`  mode  ${hx(modeOf(liveNonce))} ${modeOf(liveNonce) === 1 ? "(ENABLE)" : "(DEFAULT)"}`);
  console.log(`  vType ${hx(vTypeOf(liveNonce))} ${vTypeOf(liveNonce) === 2 ? "(PERMISSION)" : ""}`);

  // control: the same wall shape on an account that does NOT exist
  const sudoOnly = await createKernelAccount(publicClient, { entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ecdsa } });
  const cWall = await wall(sudoOnly.address, generatePrivateKey());
  const fresh = await createKernelAccount(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    plugins: { sudo: ecdsa, regular: cWall.permission },
  });
  const freshNonceR = await patient("getNonce(fresh account)", () => fresh.getNonce());
  const freshCodeR = await patient("eth_getCode(fresh)", () => publicClient.getCode({ address: fresh.address }));
  console.log(`\n  CONTROL — undeployed account ${fresh.address}`);
  console.log(`  code  ${!freshCodeR.ok ? "UNREAD" : freshCodeR.value && freshCodeR.value !== "0x" ? "present (unexpected)" : "absent"}`);
  if (freshNonceR.ok) {
    console.log(`  nonce 0x${freshNonceR.value.toString(16).padStart(64, "0")}`);
    console.log(`  mode  ${hx(modeOf(freshNonceR.value))} · vType ${hx(vTypeOf(freshNonceR.value))}`);
  } else console.log(`  nonce UNREAD`);

  // ── 5. run the PR #56 predicate on both ──────────────────────────────────
  console.log(`\n── 5. PR #56's GATE APPLIED TO BOTH ─────────────────────────`);
  const rows: Array<[string, boolean, bigint | null]> = [
    ["DEPLOYED account, new session key", live, liveNonce],
    ["UNDEPLOYED account, new session key", false, freshNonceR.ok ? freshNonceR.value : null],
  ];
  for (const [label, accountLive, nonce] of rows) {
    if (nonce === null) {
      console.log(`  ${label.padEnd(38)} UNREAD`);
      continue;
    }
    const fe = isFirstEnable(nonce);
    const gate = !accountLive && fe;
    console.log(
      `  ${label.padEnd(38)} accountLive=${String(accountLive).padEnd(5)} isFirstEnable=${String(fe).padEnd(5)} => ceiling ${gate ? "12,000,000" : " 3,000,000"}`,
    );
  }

  const broken = live && isFirstEnable(liveNonce);
  console.log(
    `\n=> ${
      broken
        ? "CONFIRMED: a DEPLOYED account produces an ENABLE-mode PERMISSION nonce.\n   The operation carries the same enable work but is routed to the 3M ceiling.\n   PR #56's `!accountLive` half breaks session-key RENEWAL."
        : "NOT reproduced on this account — see the mode byte above."
    }`,
  );
}

main().catch((e) => {
  console.error("spike failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
