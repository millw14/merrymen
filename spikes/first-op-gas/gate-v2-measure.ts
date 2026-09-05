/**
 * MEASURE AND ADVERSARIALLY TEST THE REDESIGNED GATE (gate-v2.ts).
 *
 * READ-ONLY. eth_call / eth_getCode / eth_getStorageAt /
 * eth_estimateUserOperationGas only. Nothing is signed for broadcast, nothing is
 * broadcast, no account is funded or deployed, no real grant is read or mutated.
 * Every key is generated in-process, never funded, never written to disk. The
 * only thing the throwaway owner key signs is an EIP-712 enable blob that exists
 * solely inside an estimation request.
 *
 * SECTIONS
 *   0  owner-slot formula check (the override C-arm depends on)
 *   1  FREE: enable-blob byte length vs wall size, on a live deployed account
 *   2  BUNDLER: raw gas vs blob bytes on that same live account (the fit data)
 *   3  the least-squares fit, its residuals, and the proposed C5 constants
 *   4  ADVERSARIAL TESTS of chooseGasCeiling, with controls
 *   5  the wei arithmetic: what a 12M ceiling costs vs a 3M one, per payer
 *
 * Run: railway run --service orchestrator -- npx tsx spikes/first-op-gas/gate-v2-measure.ts
 */
import {
  createPublicClient, custom, encodeFunctionData, erc20Abi, http, keccak256,
  encodeAbiParameters, type Address, type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getEntryPoint, KERNEL_V3_3 } from "@zerodev/sdk/constants";
import { createKernelAccount } from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { CallPolicyVersion, toCallPolicy, toTimestampPolicy } from "@zerodev/permissions/policies";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { toPermissionValidator as toPV } from "@zerodev/permissions";
import {
  buildCallPermissions, buildWallPolicies, CASH, chainForId, pimlicoBundlerUrl,
  UNISWAP, WALL_POLICY_FLAG,
} from "../../packages/core/src/index";
import {
  chooseGasCeiling, enableCeilingFor, ENABLE_GAS_FIT, ENABLE_MIN_BYTES,
  FIRST_ENABLE_ABSOLUTE_CAP, GAS_BOUNDS, isFirstEnable, noncePermissionId,
  nonceSequence, permissionIdInstalled, stubBytes,
} from "./gate-v2";

const CHAIN_ID = 4663;
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const CAPS = { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 };
const ECDSA_VALIDATOR = "0x845ADb2C711129d4f3966735eD98a9F09fC4cE57" as Address;

/** merrymen's own live Kernel v3.3 account, 61 bytes of code, deployed block 51,207,025. */
const LIVE = "0x032Da6A0Ccf866474e45854E7fDEF9afd1509036" as Address;
/** A second live v3.3 account that ALREADY carries an installed permission id. */
const LIVE_WITH_PERM = "0xa48cE91e2F3237E69660C1543042c007B8D33e75" as Address;
const INSTALLED_PID = "0x3ca1cec8" as Hex;

type RpcOut = { result?: any; error?: { message?: string; code?: unknown; data?: unknown } };
async function rpc(url: string, method: string, params: unknown[]): Promise<RpcOut> {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j = (await r.json()) as RpcOut;
      if (/too many requests|rate limit/i.test(String(j.error?.message ?? "")) && a < 3) {
        await new Promise((s) => setTimeout(s, 900 * 2 ** a)); continue;
      }
      return j;
    } catch (e) {
      if (a === 3) return { error: { message: e instanceof Error ? e.message : String(e) } };
      await new Promise((s) => setTimeout(s, 900 * 2 ** a));
    }
  }
  return { error: { message: "unreachable" } };
}
const errText = (e: RpcOut["error"]) =>
  [e?.code !== undefined ? `code ${String(e.code)}` : "", e?.message ?? "", typeof e?.data === "string" ? e.data : ""]
    .filter(Boolean).join(" · ").slice(0, 220);
const read = (r: RpcOut) => {
  const o = r.result as Record<string, string> | undefined;
  if (!o) return null;
  const n = (k: string) => (o[k] === undefined ? 0n : BigInt(o[k]));
  const call = n("callGasLimit"), ver = n("verificationGasLimit"), pre = n("preVerificationGas");
  return { call, ver, pre, raw: call + ver + pre };
};
const com = (n: bigint | number) => n.toLocaleString("en-US");
const hex2 = (n: number) => `0x${n.toString(16).padStart(2, "0")}`;
/** boundGas's per-field headroom, gas-limits.ts:312-320. */
const bound = (c: bigint, v: bigint, p: bigint) => (c * 20_000n) / 10_000n + (v * 12_500n) / 10_000n + (p * 12_500n) / 10_000n;

const slotOf = (a: Address): Hex => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [a, 0n]));

async function main() {
  const apiKey = process.env.MERRYMEN_BUNDLER_API_KEY;
  if (!apiKey) { console.error("no MERRYMEN_BUNDLER_API_KEY — run under `railway run --service orchestrator --`"); process.exit(1); }
  const bundler = pimlicoBundlerUrl(CHAIN_ID, apiKey);
  const chain = chainForId(CHAIN_ID);
  const pc = createPublicClient({ chain, transport: http(RPC) });
  const entryPoint = getEntryPoint("0.7");
  const ep = entryPoint.address;

  const fees = await pc.estimateFeesPerGas().catch(() => null);
  const maxFee = fees?.maxFeePerGas ?? 1_000_000_000n;
  const prio = fees?.maxPriorityFeePerGas ?? 0n;
  const BAL = 14_000_000n * maxFee * 4n;

  console.log(`bundler ${new URL(bundler).host} · chain ${CHAIN_ID} · maxFeePerGas ${maxFee} wei (${(Number(maxFee) / 1e9).toFixed(6)} gwei)\n`);

  const owner = privateKeyToAccount(generatePrivateKey());
  const ecdsa = await signerToEcdsaValidator(pc, { signer: owner, entryPoint, kernelVersion: KERNEL_V3_3 });
  console.log(`throwaway owner ${owner.address} (generated here, never funded, never on disk)\n`);

  const approveCall = {
    to: CASH.USDG as Address, value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [UNISWAP.swapRouter02 as Address, 5_000_000n] }),
  };

  // ══ 0. OWNER-SLOT FORMULA ═════════════════════════════════════════════════
  console.log("══ 0. owner-slot formula check (the estimate arm depends on it) ══");
  const slotOk: Record<string, boolean> = {};
  for (const t of [LIVE, LIVE_WITH_PERM]) {
    const raw = await rpc(RPC, "eth_getStorageAt", [ECDSA_VALIDATOR, slotOf(t), "latest"]);
    const view = await rpc(RPC, "eth_call", [{ to: ECDSA_VALIDATOR, data: ("0x20709efc" + t.slice(2).toLowerCase().padStart(64, "0")) as Hex }, "latest"]);
    const a = typeof raw.result === "string" ? `0x${raw.result.slice(-40)}` : null;
    const b = typeof view.result === "string" && view.result.length >= 66 ? `0x${view.result.slice(26, 66)}` : null;
    if (!a || !b) { console.log(`  ${t}  UNREAD — not "no owner"`); slotOk[t] = false; continue; }
    slotOk[t] = a.toLowerCase() === b.toLowerCase();
    console.log(`  ${t}  storage ${a} · view ${b} · ${slotOk[t] ? "AGREE" : "DISAGREE — will not report numbers for this target"}`);
  }
  const code = await pc.getCode({ address: LIVE }).catch(() => undefined);
  console.log(`  ${LIVE} code ${code && code !== "0x" ? `${(code.length - 2) / 2} bytes -> accountLive TRUE` : "NONE/UNREAD"}\n`);

  // ── build a wall of exactly `keep` call permissions, pinned to `target` ───
  const allPerms = buildCallPermissions(CAPS, LIVE, {});
  const now = Math.floor(Date.now() / 1000);
  async function walled(target: Address, keep: number) {
    const policies = [
      toTimestampPolicy({ validAfter: now, validUntil: now + CAPS.expiryDays * 86_400 }),
      toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions: allPerms.slice(0, keep) as never }),
    ];
    const pv = await toPV(pc, {
      entryPoint, kernelVersion: KERNEL_V3_3, policies, flag: WALL_POLICY_FLAG,
      signer: await toECDSASigner({ signer: privateKeyToAccount(generatePrivateKey()) }),
    });
    const acct = await createKernelAccount(pc, {
      entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ecdsa, regular: pv }, address: target,
    });
    const nonce = await acct.getNonce();
    const callData = await acct.encodeCalls([approveCall]);
    const stub = await acct.getStubSignature({
      sender: target, nonce, callData, callGasLimit: 0n, verificationGasLimit: 0n,
      preVerificationGas: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, signature: "0x",
    } as never);
    return { acct, pv, nonce, callData, stub, bytes: stubBytes(stub as Hex) };
  }

  // ══ 1. FREE — blob bytes vs wall size ═════════════════════════════════════
  console.log("══ 1. enable-blob byte length vs wall size (no bundler; free) ══");
  console.log("  perms  blob bytes  nonce mode/vType  seq  pId");
  const SIZES = [1, 2, 3, 4, 6, 8, 12, 18, 24, 32];
  const shapes: Record<number, { bytes: number; pid: Hex }> = {};
  for (const k of SIZES) {
    if (k > allPerms.length) { console.log(`  ${String(k).padStart(5)}  (only ${allPerms.length} permissions exist — skipped)`); continue; }
    const w = await walled(LIVE, k);
    shapes[k] = { bytes: w.bytes, pid: noncePermissionId(w.nonce) };
    console.log(`  ${String(k).padStart(5)}  ${String(w.bytes).padStart(10)}  ${hex2(Number((w.nonce >> 248n) & 0xffn))}/${hex2(Number((w.nonce >> 240n) & 0xffn))}          ${String(nonceSequence(w.nonce)).padStart(3)}  ${noncePermissionId(w.nonce)}`);
  }
  console.log(`  full wall = ${allPerms.length} call permissions + 1 timestamp policy\n`);

  // C3's threshold, against the smallest blob that exists
  const smallest = Math.min(...Object.values(shapes).map((s) => s.bytes));
  console.log(`  smallest enable blob measured: ${com(smallest)} bytes · ENABLE_MIN_BYTES ${ENABLE_MIN_BYTES} · ` +
    `${ENABLE_MIN_BYTES < smallest ? `OK — threshold is ${(smallest / ENABLE_MIN_BYTES).toFixed(1)}x below it` : "THRESHOLD TOO HIGH — would reject a real enable"}`);

  // and against a NON-enable stub on the same live account (sudo-only)
  const sudoPinned = await createKernelAccount(pc, { entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ecdsa }, address: LIVE });
  const sudoNonce = await sudoPinned.getNonce();
  const sudoCallData = await sudoPinned.encodeCalls([approveCall]);
  const sudoStub = await sudoPinned.getStubSignature({
    sender: LIVE, nonce: sudoNonce, callData: sudoCallData, callGasLimit: 0n, verificationGasLimit: 0n,
    preVerificationGas: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, signature: "0x",
  } as never);
  console.log(`  sudo-only stub on the same account: ${stubBytes(sudoStub as Hex)} bytes (mode ${hex2(Number((sudoNonce >> 248n) & 0xffn))}) · ` +
    `${stubBytes(sudoStub as Hex) < ENABLE_MIN_BYTES ? "OK — below the threshold" : "PROBLEM"}\n`);

  if (!slotOk[LIVE]) { console.log("owner slot unverified for the live target — sections 2-4 cannot run honestly. Stopping."); return; }

  const ownerWord = `0x${owner.address.slice(2).toLowerCase().padStart(64, "0")}`;
  const overrideFor = (t: Address) => ({
    [t]: { balance: `0x${BAL.toString(16)}` },
    [ECDSA_VALIDATOR]: { stateDiff: { [slotOf(t)]: ownerWord } },
  });

  // ══ 2. BUNDLER — raw gas vs blob bytes, on a LIVE deployed account ════════
  console.log("══ 2. raw gas vs blob bytes — REAL deployed account, no factory, owner-slot override ══");
  console.log("  perms  blob bytes      verif   preVerif   call        RAW     bounded");
  const fit: Array<{ k: number; bytes: number; raw: bigint; ver: bigint; pre: bigint; call: bigint }> = [];
  for (const k of [1, 2, 4, 8, 18]) {
    if (k > allPerms.length) continue;
    const w = await walled(LIVE, k);
    const op = {
      sender: LIVE, nonce: `0x${w.nonce.toString(16)}`, callData: w.callData, signature: w.stub,
      maxFeePerGas: `0x${maxFee.toString(16)}`, maxPriorityFeePerGas: `0x${prio.toString(16)}`,
    };
    const r = await rpc(bundler, "eth_estimateUserOperationGas", [op, ep, overrideFor(LIVE)]);
    const v = read(r);
    if (!v) { console.log(`  ${String(k).padStart(5)}  ${String(w.bytes).padStart(10)}  UNREAD — ${errText(r.error)}`); continue; }
    fit.push({ k, bytes: w.bytes, raw: v.raw, ver: v.ver, pre: v.pre, call: v.call });
    console.log(`  ${String(k).padStart(5)}  ${String(w.bytes).padStart(10)}  ${com(v.ver).padStart(9)}  ${com(v.pre).padStart(9)}  ${com(v.call).padStart(6)}  ${com(v.raw).padStart(9)}  ${com(bound(v.call, v.ver, v.pre)).padStart(10)}`);
  }
  console.log();

  // NEGATIVE CONTROL — the same op without the owner override must be refused.
  {
    const w = await walled(LIVE, 18);
    const op = {
      sender: LIVE, nonce: `0x${w.nonce.toString(16)}`, callData: w.callData, signature: w.stub,
      maxFeePerGas: `0x${maxFee.toString(16)}`, maxPriorityFeePerGas: `0x${prio.toString(16)}`,
    };
    const r = await rpc(bundler, "eth_estimateUserOperationGas", [op, ep, { [LIVE]: { balance: `0x${BAL.toString(16)}` } }]);
    const v = read(r);
    console.log(`  NEGATIVE CONTROL (no owner override): ${v ? `UNEXPECTEDLY SUCCEEDED raw ${com(v.raw)} — the enable sig was not checked, discount section 2` : `refused as expected — ${errText(r.error)}`}\n`);
  }

  // ══ 3. THE FIT ════════════════════════════════════════════════════════════
  console.log("══ 3. least-squares fit of RAW total against blob bytes, and the C5 constants ══");
  if (fit.length < 3) { console.log("  fewer than 3 usable points — cannot fit. UNREAD, not absent.\n"); }
  else {
    const n = fit.length;
    const xs = fit.map((f) => f.bytes), ys = fit.map((f) => Number(f.raw));
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    const slope = num / den, intercept = my - slope * mx;
    console.log(`  raw ≈ ${Math.round(intercept).toLocaleString()} + ${slope.toFixed(3)} × blobBytes   (n=${n})`);
    console.log("  residuals:");
    let worst = 0;
    for (const f of fit) {
      const pred = intercept + slope * f.bytes;
      const err = (pred - Number(f.raw)) / Number(f.raw);
      worst = Math.max(worst, Math.abs(err));
      console.log(`    ${String(f.k).padStart(2)} perms  ${String(f.bytes).padStart(6)} B  actual ${com(f.raw).padStart(9)}  fitted ${Math.round(pred).toLocaleString().padStart(9)}  ${(err * 100).toFixed(2)}%`);
    }
    console.log(`  worst residual ${(worst * 100).toFixed(2)}%`);
    console.log(`\n  PROPOSED CONSTANTS for gate-v2.ts ENABLE_GAS_FIT:`);
    console.log(`    intercept:             ${Math.round(intercept)}n`);
    console.log(`    slopeMilliGasPerByte:  ${Math.round(slope * 1000)}n`);
    console.log(`    safetyBps:             ${ENABLE_GAS_FIT.safetyBps}  (${(ENABLE_GAS_FIT.safetyBps / 10_000).toFixed(2)}x — ${(ENABLE_GAS_FIT.safetyBps / 10_000 - 1) / Math.max(worst, 1e-9) | 0}x the worst residual)`);
    console.log(`\n  WHAT THAT CEILING WOULD BE, per wall size (current constants in gate-v2.ts):`);
    console.log(`    perms  blob B    actual bounded   sized ceiling   verdict         flat-12M slack removed`);
    for (const f of fit) {
      const b = bound(f.call, f.ver, f.pre);
      const c = enableCeilingFor(f.bytes, false);
      console.log(`    ${String(f.k).padStart(5)}  ${String(f.bytes).padStart(6)}  ${com(b).padStart(14)}  ${com(c).padStart(14)}   ${b <= c ? "fits" : "REFUSED"}${" ".repeat(b <= c ? 12 : 9)}${com(FIRST_ENABLE_ABSOLUTE_CAP - c).padStart(10)}`);
    }
    console.log();
  }

  // ══ 4. ADVERSARIAL TESTS OF THE GATE ══════════════════════════════════════
  console.log("══ 4. adversarial tests of chooseGasCeiling ══");
  const goodClient = { call: pc.call.bind(pc), getCode: pc.getCode.bind(pc) };
  const deadClient = { call: async () => { throw new Error("simulated RPC outage"); },
                       getCode: pc.getCode.bind(pc) };
  /** getCode itself fails — must be UNREAD, never "no code". */
  const codeDeadClient = { call: pc.call.bind(pc),
                           getCode: async () => { throw new Error("simulated getCode outage"); } };
  /** A client that answers every permissionConfig with empty returndata — the
   *  shape a call to a codeless address takes, and the shape that must NOT be
   *  read as "not installed". */
  const emptyClient = { call: async () => ({ data: "0x" as Hex }), getCode: pc.getCode.bind(pc) };

  const results: Array<[string, string, string, boolean]> = [];
  const say = (name: string, d: Awaited<ReturnType<typeof chooseGasCeiling>>, expect: string) => {
    const got = d.kind === "refuse" ? `refuse/${d.rule}` : d.kind;
    const ceil = d.kind === "refuse" ? "-" : com(d.bounds.absoluteMax);
    const ok = got === expect;
    results.push([name, `${got} · ceiling ${ceil}`, expect, ok]);
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
    console.log(`        -> ${got} · ceiling ${ceil} · expected ${expect}`);
    console.log(`        -> ${d.kind === "refuse" ? d.detail.slice(0, 150) : d.why}`);
    console.log(`        -> evidence: mode ${hex2(d.evidence.mode)} vType ${hex2(d.evidence.vType)} seq ${d.evidence.seq} pId ${d.evidence.permissionId} blob ${d.evidence.blobBytes}B installed ${d.evidence.installed === null ? "UNREAD" : d.evidence.installed} accountLive ${d.evidence.accountLive}`);
  };

  // (a) THE RENEWAL — deployed account, fresh session key. MUST elevate.
  {
    const w = await walled(LIVE, 18);
    say("(a) renewal: deployed account + fresh session key + full wall",
      await chooseGasCeiling({ client: goodClient, account: LIVE, nonce: w.nonce, stub: w.stub as Hex, accountLive: true }),
      "elevated");
  }
  // (b) SUDO-ONLY on the same deployed account. MUST NOT elevate (C1).
  say("(b) control: sudo-only op on the same deployed account (C1 must reject)",
    await chooseGasCeiling({ client: goodClient, account: LIVE, nonce: sudoNonce, stub: sudoStub as Hex, accountLive: true }),
    "ordinary");

  // (c) STEADY STATE — a permission id that IS installed on a live account.
  //     The SDK itself drops to mode 0x00, so C1 rejects.
  {
    const pv = await toPV(pc, {
      entryPoint, kernelVersion: KERNEL_V3_3, flag: WALL_POLICY_FLAG,
      policies: buildWallPolicies({ caps: CAPS, smartAccount: LIVE_WITH_PERM }).policies,
      signer: await toECDSASigner({ signer: privateKeyToAccount(generatePrivateKey()) }),
      permissionId: INSTALLED_PID,
    } as never);
    const acct = await createKernelAccount(pc, {
      entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ecdsa, regular: pv }, address: LIVE_WITH_PERM,
    });
    const nonce = await acct.getNonce();
    const cd = await acct.encodeCalls([approveCall]);
    const stub = await acct.getStubSignature({
      sender: LIVE_WITH_PERM, nonce, callData: cd, callGasLimit: 0n, verificationGasLimit: 0n,
      preVerificationGas: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, signature: "0x",
    } as never);
    say("(c) steady state: installed permission id on a live account",
      await chooseGasCeiling({ client: goodClient, account: LIVE_WITH_PERM, nonce, stub: stub as Hex, accountLive: true }),
      "ordinary");
  }

  // (d) THE FAIL-OPEN PR #56 CANNOT SEE, forced.
  //     A single failed permissionConfig read inside the SDK makes it build an
  //     ENABLE nonce AND attach a full enable blob for an ALREADY-INSTALLED id.
  //     C1 and C3 both pass. Only C4's independent read stops it.
  {
    let faults = 0;
    const base = http(RPC)({ chain });
    const faultyClient = createPublicClient({
      chain,
      transport: custom({
        request: (async (a: { method: string; params?: unknown[] }) => {
          const p = a.params?.[0] as { to?: string; data?: string } | undefined;
          if (a.method === "eth_call" && p?.data?.startsWith("0xc3e58978") &&
              p.to?.toLowerCase() === LIVE_WITH_PERM.toLowerCase()) {
            faults++; throw new Error("injected permissionConfig failure");
          }
          return base.request(a as never);
        }) as never,
      }),
    });
    const pv = await toPV(faultyClient, {
      entryPoint, kernelVersion: KERNEL_V3_3, flag: WALL_POLICY_FLAG,
      policies: buildWallPolicies({ caps: CAPS, smartAccount: LIVE_WITH_PERM }).policies,
      signer: await toECDSASigner({ signer: privateKeyToAccount(generatePrivateKey()) }),
      permissionId: INSTALLED_PID,
    } as never);
    const acct = await createKernelAccount(faultyClient, {
      entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ecdsa, regular: pv }, address: LIVE_WITH_PERM,
    });
    const nonce = await acct.getNonce();
    const cd = await acct.encodeCalls([approveCall]);
    const stub = await acct.getStubSignature({
      sender: LIVE_WITH_PERM, nonce, callData: cd, callGasLimit: 0n, verificationGasLimit: 0n,
      preVerificationGas: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, signature: "0x",
    } as never);
    console.log(`  [fault injection: ${faults} permissionConfig calls made to fail; nonce mode ${hex2(Number((nonce >> 248n) & 0xffn))}, blob ${stubBytes(stub as Hex)} B]`);
    say("(d) FAIL-OPEN: RPC blip forges an ENABLE nonce + blob for an INSTALLED id (C4 must catch it)",
      await chooseGasCeiling({ client: goodClient, account: LIVE_WITH_PERM, nonce, stub: stub as Hex, accountLive: true }),
      "ordinary");

    // (d2) same operation, but OUR read also fails -> must refuse, never elevate.
    // C2 alone already rejects (d): the EntryPoint reports sequence 1 for that
    // enable key, because the landed enable of 0x3ca1cec8 advanced it. That is
    // direct chain evidence for C2's premise rather than an assumption.
    say("(d2) same op with C4's read dead too — C2 already rejected it, so no eth_call is needed",
      await chooseGasCeiling({ client: deadClient, account: LIVE_WITH_PERM, nonce, stub: stub as Hex, accountLive: true }),
      "ordinary");
  }

  // (d3) ISOLATE C4: a genuinely-uninstalled id on a LIVE account (so C1/C2/C3
  //      all pass) with the permissionConfig read dead. Must refuse — never
  //      elevate, and never silently narrow into an opaque AA21.
  {
    const w = await walled(LIVE, 18);
    say("(d3) C4 isolated: fresh id on a live account, permissionConfig read dead (must refuse)",
      await chooseGasCeiling({ client: deadClient, account: LIVE, nonce: w.nonce, stub: w.stub as Hex, accountLive: true }),
      "refuse/enable-unverified");
    say("(d4) same, but getCode itself is dead — a failed code read must be UNREAD, never 'no code'",
      await chooseGasCeiling({ client: codeDeadClient, account: LIVE, nonce: w.nonce, stub: w.stub as Hex, accountLive: true }),
      "refuse/enable-unverified");
  }

  // (e) EMPTY RETURNDATA — the codeless-address shape. Must be UNREAD, not false.
  {
    const w = await walled(LIVE, 18);
    say("(e) C4 gets empty returndata (codeless-address shape) — must NOT read as 'not installed'",
      await chooseGasCeiling({ client: emptyClient, account: LIVE, nonce: w.nonce, stub: w.stub as Hex, accountLive: true }),
      "refuse/enable-unverified");
  }

  // (f) SEQUENCE > 0 on an enable key. Synthesised, because producing one
  //     requires landing an enable. C2 must reject it.
  {
    const w = await walled(LIVE, 18);
    say("(f) enable-shaped nonce at sequence 1 (C2 must reject — the id is already installed)",
      await chooseGasCeiling({ client: goodClient, account: LIVE, nonce: w.nonce + 1n, stub: w.stub as Hex, accountLive: true }),
      "ordinary");
  }

  // (g) ENABLE nonce with a BARE signature — the other half of the race
  //     (C1's read failed, C3's succeeded). C3 must reject without an eth_call.
  {
    const w = await walled(LIVE, 18);
    say("(g) enable-shaped nonce carrying only a 65-byte signature (C3 must reject)",
      await chooseGasCeiling({ client: goodClient, account: LIVE, nonce: w.nonce, stub: sudoStub as Hex, accountLive: true }),
      "ordinary");
  }

  // (h) THE UNDEPLOYED FIRST OP still works — the case PR #56 was written for.
  {
    const sudoOnly = await createKernelAccount(pc, { entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ecdsa } });
    const pv = await toPV(pc, {
      entryPoint, kernelVersion: KERNEL_V3_3, flag: WALL_POLICY_FLAG,
      policies: buildWallPolicies({ caps: CAPS, smartAccount: sudoOnly.address }).policies,
      signer: await toECDSASigner({ signer: privateKeyToAccount(generatePrivateKey()) }),
    });
    const acct = await createKernelAccount(pc, { entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ecdsa, regular: pv } });
    const fa = await acct.getFactoryArgs();
    const nonce = await acct.getNonce();
    const cd = await acct.encodeCalls([approveCall]);
    const stub = await acct.getStubSignature({
      sender: acct.address, nonce, callData: cd, callGasLimit: 0n, verificationGasLimit: 0n,
      preVerificationGas: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, signature: "0x", ...fa,
    } as never);
    say("(h) regression: the UNDEPLOYED first op PR #56 was written for still elevates",
      await chooseGasCeiling({ client: goodClient, account: acct.address as Address, nonce, stub: stub as Hex, accountLive: false }),
      "elevated");
  }

  console.log(`\n  TALLY: ${results.filter((r) => r[3]).length}/${results.length} passed` +
    (results.some((r) => !r[3]) ? `  FAILURES: ${results.filter((r) => !r[3]).map((r) => r[0]).join(" | ")}` : ""));
  console.log();

  // ══ 5. THE WEI ARITHMETIC ═════════════════════════════════════════════════
  console.log("══ 5. what a wider ceiling actually costs, in wei ══");
  const ETH = (w: bigint) => `${(Number(w) / 1e18).toFixed(9)} ETH`;
  console.log(`  fee used: ${maxFee} wei/gas (live estimateFeesPerGas, the same call executor.ts makes)\n`);
  console.log(`  THE CEILING IS A REFUSAL THRESHOLD, NOT AN ALLOWANCE. gas-limits.ts:312-331 applies`);
  console.log(`  headroom to the ESTIMATE and then compares the total to absoluteMax; absoluteMax never`);
  console.log(`  enters a signed limit. So raising it cannot make any operation cost one wei more —`);
  console.log(`  it can only stop refusing operations that genuinely estimate between the two numbers.\n`);
  const d3 = 3_000_000n * maxFee, d12 = 12_000_000n * maxFee;
  console.log(`  ceiling-sized PREFUND (EntryPoint requires the payer to HOLD total x maxFeePerGas):`);
  console.log(`     3,000,000 gas -> ${com(d3)} wei = ${ETH(d3)}`);
  console.log(`    12,000,000 gas -> ${com(d12)} wei = ${ETH(d12)}`);
  console.log(`    delta          -> ${com(d12 - d3)} wei = ${ETH(d12 - d3)}\n`);
  const measured = fit.find((f) => f.k === 18);
  if (measured) {
    const b = bound(measured.call, measured.ver, measured.pre);
    const sized = enableCeilingFor(measured.bytes, false);
    console.log(`  WORST CASE AN ATTACKER CAN ACTUALLY DRAW, per (account, permissionId):`);
    console.log(`    the widest operation the gate admits is one whose ESTIMATE clears the ceiling.`);
    console.log(`    measured full-wall renewal: raw ${com(measured.raw)}, bounded ${com(b)}`);
    console.log(`    signed prefund at that size: ${com(b * maxFee)} wei = ${ETH(b * maxFee)}`);
    console.log(`    gas actually BURNED is what execution uses, not the limit; the landed 10,964-byte`);
    console.log(`    enable on 4663 (tx 0x323e8050…) used 5,867,332 = ${ETH(5_867_332n * maxFee)}.\n`);
    console.log(`    SELF-PAYING (no sponsor): every wei of that is the ATTACKER'S OWN. The house's`);
    console.log(`      exposure from widening the ceiling is 0 wei. executor.ts's prefund check`);
    console.log(`      (held >= bounded.total x feeCeiling) still refuses an account that cannot cover it.`);
    console.log(`    SPONSORED (cfg.sponsorGasEnabled): the house pays. Exposure per admitted enable is`);
    console.log(`      the gas USED, ~${com(5_867_332n)} -> ${ETH(5_867_332n * maxFee)}, versus 0 if refused.`);
    console.log(`      Under the flat 12M ceiling the worst admissible op is 12,000,000 -> ${ETH(d12)}.`);
    console.log(`      Under the sized ceiling for THIS blob it is ${com(sized)} -> ${ETH(sized * maxFee)},`);
    console.log(`      removing ${com(FIRST_ENABLE_ABSOLUTE_CAP - sized)} gas = ${ETH((FIRST_ENABLE_ABSOLUTE_CAP - sized) * maxFee)} of unused authority per operation.\n`);
    console.log(`    HOW OFTEN: at most ONCE per (account, permissionId), and only on INCLUSION.`);
    console.log(`      An operation that is never included costs nobody anything. One that IS included`);
    console.log(`      installs the id, so C4 reads true and the EntryPoint's sequence for that key`);
    console.log(`      becomes 1, so C2 fails. Both close permanently, from two independent sources.`);
    console.log(`      A second paid elevated op therefore requires a NEW permission id, i.e. a new`);
    console.log(`      signed grant POSTed by the tenant.`);
    console.log(`      The gate on the branch today bounds it at once per ADDRESS — and a fresh address`);
    console.log(`      costs one generatePrivateKey(), so that is the same bound obtained on a key that`);
    console.log(`      also excludes every honest renewal.\n`);
  }
  console.log(`  paymaster fields are counted against the ceiling too (gas-limits.ts:200-208) and are`);
  console.log(`  capped at ${com(500_000n)} each by PAYMASTER_GAS_MAX, so a sponsor cannot enlarge the`);
  console.log(`  admissible band by more than ${com(1_000_000n)} gas = ${ETH(1_000_000n * maxFee)}.`);
}

main().catch((e) => { console.error("gate-v2-measure failed:", e instanceof Error ? e.stack : String(e)); process.exit(1); });
