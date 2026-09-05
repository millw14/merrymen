/**
 * METHOD C — MEASURE THE *SHAPE*, NOT THE COST.
 *
 * The claim under test has two halves:
 *   (i)  a DEPLOYED account + a FRESH session key still produces an ENABLE-mode nonce
 *   (ii) that operation is expensive
 *
 * (ii) needs a bundler. (i) does not — it is decided entirely by
 * `isPluginEnabled(validator, id)` inside @zerodev/sdk, which is one eth_call.
 * So this spike nails (i) exhaustively with pure RPC READS, and it also tests
 * the two things nobody has tested yet:
 *
 *   THE CONVERSE. For an account where a permission validator IS already
 *   installed, does the nonce drop back to mode 0x00? That is the steady-state
 *   the 3,000,000 ceiling actually exists for, and any fix must keep it working.
 *
 *   THE FAILURE MODE. isPluginEnabled's on-chain read is wrapped in a
 *   `try { … } catch { return false }`. So what does a transient RPC error do to
 *   the nonce mode — claim ENABLE (fail-open, a cheap op gets the wide ceiling)
 *   or claim DEFAULT (fail-closed, a real renewal gets refused by a blip)?
 *   Proven here from source AND by surgical fault injection.
 *
 * READ-ONLY, ABSOLUTELY. Every chain call is eth_call or eth_getCode. Nothing is
 * signed, nothing is broadcast, no grant is read or mutated, no account is
 * funded, nothing is deployed. The sudo/session keys are generated per run,
 * never funded, never written to disk — they exist only so the SDK will build a
 * plugin manager we can interrogate. The fault injection is LOCAL: it makes our
 * own client throw before the request leaves the process.
 *
 * A read that never succeeded prints UNREAD. "I could not read it" is never
 * reported as "there is nothing there".
 *
 * Run: npx tsx spikes/first-op-gas/shape.ts        (no bundler key needed)
 */
import { createPublicClient, custom, http, toFunctionSelector, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getEntryPoint, KERNEL_V3_3 } from "@zerodev/sdk/constants";
import { createKernelAccount } from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { toPermissionValidator } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { buildWallPolicies, buildCallPermissions, chainForId, WALL_POLICY_FLAG } from "../../packages/core/src/index";
// The repo's OWN ceiling logic, imported rather than retyped, so section 5 is
// the real verdict and not a reconstruction of one.
import { boundGas, GAS_BOUNDS, FIRST_ENABLE_GAS_BOUNDS } from "../../worker/src/gas-limits";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const CAPS = { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 };
const entryPoint = getEntryPoint("0.7");

/** The exact PR #56 predicates, copied from worker/src/executor.ts:154-158 and :389-392. */
const isFirstEnable = (n: bigint) => ((n >> 248n) & 0xffn) === 0x01n && ((n >> 240n) & 0xffn) === 0x02n;
const GAS_ABS_MAX = 3_000_000n;
const FIRST_ENABLE_ABS_MAX = 12_000_000n;

const modeOf = (n: bigint) => Number((n >> 248n) & 0xffn);
const vTypeOf = (n: bigint) => Number((n >> 240n) & 0xffn);
const identOf = (n: bigint) => `0x${((n >> 80n) & ((1n << 160n) - 1n)).toString(16).padStart(40, "0")}`;
const hx = (n: number) => `0x${n.toString(16).padStart(2, "0")}`;

/** permissionConfig(bytes4) — the ONE call isPluginEnabled makes for a permission validator. */
const PERMISSION_CONFIG_SELECTOR = toFunctionSelector("permissionConfig(bytes4)");

/**
 * The signer contract `isEnabled` compares the stored config against. Filled in
 * at runtime from a real `toECDSASigner`, so it is literally
 * `signer.signerContractAddress` — the same value toPermissionValidator.ts:154
 * tests — rather than a constant retyped by hand here.
 */
let ECDSA_SIGNER_CONTRACT = "0x0000000000000000000000000000000000000000";

// ─────────────────────────────────────────────────────────────────────────────
// A transport we can count and, on demand, break — locally, before the wire.
// ─────────────────────────────────────────────────────────────────────────────
type Req = { method: string; params: unknown };
let LOG: Req[] = [];
/** When set, any request this returns a string for is thrown instead of sent. */
let FAULT: ((r: Req) => string | null) | null = null;

async function wire(method: string, params: unknown): Promise<unknown> {
  let last = "";
  for (let i = 0; i < 12; i++) {
    try {
      const r = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j = (await r.json()) as { result?: unknown; error?: { message?: string } };
      if (j.error) {
        last = j.error.message ?? "rpc error";
        if (/too many requests|rate/i.test(last)) {
          await new Promise((s) => setTimeout(s, Math.min(700 * 2 ** i, 12_000)));
          continue;
        }
        throw new Error(last);
      }
      return j.result;
    } catch (e) {
      last = String(e instanceof Error ? e.message : e).split("\n")[0]!.slice(0, 160);
      if (!/fetch|network|too many|rate|timeout|ECONN/i.test(last)) throw e;
      await new Promise((s) => setTimeout(s, Math.min(700 * 2 ** i, 12_000)));
    }
  }
  throw new Error(`UNREAD after 12 attempts: ${method} — ${last}`);
}

const transport = custom(
  {
    async request({ method, params }: { method: string; params?: unknown }) {
      const r: Req = { method, params };
      LOG.push(r);
      const f = FAULT?.(r);
      if (f) throw new Error(f);
      return wire(method, params);
    },
  },
  { retryCount: 0 },
);

const publicClient = createPublicClient({ chain: chainForId(4663), transport });

/** Did this request go to `to` with our permissionConfig selector? */
function isPermissionConfigCall(r: Req, to?: Address): boolean {
  if (r.method !== "eth_call") return false;
  const p = (r.params as [{ to?: string; data?: string }] | undefined)?.[0];
  if (!p?.data || !p.data.toLowerCase().startsWith(PERMISSION_CONFIG_SELECTOR.toLowerCase())) return false;
  return to ? (p.to ?? "").toLowerCase() === to.toLowerCase() : true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Subjects
// ─────────────────────────────────────────────────────────────────────────────

/**
 * REAL, ALREADY-DEPLOYED accounts on 4663. Provenance: EntryPoint 0.7
 * AccountDeployed logs, ERC-1967 impl slot read (spikes/first-op-gas/impl-sweep.mjs).
 * The first is merrymen's own account.
 */
const DEPLOYED: { addr: Address; note: string }[] = [
  { addr: "0x032da6a0ccf866474e45854e7fdef9afd1509036", note: "merrymen's own account, kernel v3.3, deployed block 51207025" },
  { addr: "0x26e1b523189ec668654680178ad7ab07ff2c71ae", note: "kernel v3.3, deployed block 52240294" },
  { addr: "0x4460f7926eb4979b27f171464691cf8374f02240", note: "kernel v3.3, deployed block 52456590" },
  { addr: "0xfd58500678406d33293ecad9976c6c5ee653eca1", note: "kernel v3.3, deployed block 51367467" },
];

/**
 * Accounts with a permission validator PROVABLY INSTALLED — each landed a
 * successful mode 0x01 / vType 0x02 UserOperation carrying this permissionId
 * (spikes/first-op-gas/perm-ops.json). The install is verified again on-chain
 * below by reading permissionConfig directly.
 */
const INSTALLED: { addr: Address; pid: Hex; note: string }[] = [
  { addr: "0xa48ce91e2f3237e69660c1543042c007b8d33e75", pid: "0x3ca1cec8", note: "kernel v3.3, enable landed block 51847124" },
  { addr: "0x26e1b523189ec668654680178ad7ab07ff2c71ae", pid: "0xad16ecaa", note: "kernel v3.3, enable landed block 52240294" },
  { addr: "0xd535491c7cf0e72ac9151b94a1feebd3942d8af7", pid: "0x39c384a8", note: "kernel v3.3, enable landed block 46988297" },
  { addr: "0x4986995b4ca6fdc838a01a61967daa50d2b854e9", pid: "0xecd39ec5", note: "kernel v3.1, enable landed block 53045103 (most recent on chain)" },
];

/** Synthetic "owner-added token" addresses. Never called, never funded — they only widen the wall. */
const FAKE_TOKEN = (i: number) => ({
  symbol: `EX${i}`,
  address: `0x${(0xe0000000000000000000000000000000000000n + BigInt(i)).toString(16).padStart(40, "0")}` as Address,
  decimals: 18,
});

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("METHOD C — SHAPE, NOT COST.  READ-ONLY: eth_call / eth_getCode only.");
  console.log("Nothing signed. Nothing broadcast. No grant touched. No account funded.\n");
  ECDSA_SIGNER_CONTRACT = (await toECDSASigner({ signer: privateKeyToAccount(generatePrivateKey()) })).signerContractAddress;
  console.log(`permissionConfig(bytes4) selector = ${PERMISSION_CONFIG_SELECTOR}`);
  console.log(`signer.signerContractAddress      = ${ECDSA_SIGNER_CONTRACT}  (read off a real toECDSASigner)\n`);

  // one sudo validator, reused, to keep RPC load down
  const ecdsa = await signerToEcdsaValidator(publicClient, {
    signer: privateKeyToAccount(generatePrivateKey()),
    entryPoint,
    kernelVersion: KERNEL_V3_3,
  });

  const code = new Map<string, string | null>();
  const getCode = async (a: Address) => {
    const k = a.toLowerCase();
    if (code.has(k)) return code.get(k)!;
    try {
      const c = (await wire("eth_getCode", [a, "latest"])) as string;
      code.set(k, c);
      return c;
    } catch (e) {
      console.log(`  UNREAD eth_getCode ${a}: ${String(e).slice(0, 120)}`);
      code.set(k, null);
      return null;
    }
  };

  /**
   * Build the account the WORKER would build against `addr`, with a given
   * session key / wall / (optionally) an explicit permissionId, and read the
   * nonce the SDK computes. Returns null only if a read failed.
   */
  const probe = async (opts: {
    addr: Address;
    sessionKey: Hex;
    extraTokens?: { symbol: string; address: Address; decimals: number }[];
    permissionId?: Hex;
    now?: number;
  }) => {
    const signer = await toECDSASigner({ signer: privateKeyToAccount(opts.sessionKey) });
    const { policies } = buildWallPolicies({
      caps: CAPS,
      smartAccount: opts.addr,
      now: opts.now,
      extraTokens: opts.extraTokens,
    });
    const permission = await toPermissionValidator(publicClient, {
      entryPoint,
      kernelVersion: KERNEL_V3_3,
      signer,
      policies,
      flag: WALL_POLICY_FLAG,
      ...(opts.permissionId ? { permissionId: opts.permissionId } : {}),
    });
    const account = await createKernelAccount(publicClient, {
      entryPoint,
      kernelVersion: KERNEL_V3_3,
      address: opts.addr,
      plugins: { sudo: ecdsa, regular: permission },
    });
    const pid = permission.getIdentifier();
    const perms = buildCallPermissions(CAPS, opts.addr, { extraTokens: opts.extraTokens });
    LOG = [];
    const nonce = await account.getNonce();
    const calls = LOG.filter((r) => isPermissionConfigCall(r, opts.addr)).length;
    return { pid, nonce, permCalls: calls, nPermissions: perms.length, validatorAddress: permission.address as Address };
  };

  const verdict = (accountLive: boolean, nonce: bigint) => {
    const first = isFirstEnable(nonce);
    const pr56 = !accountLive && first;
    return {
      first,
      pr56,
      ceiling: pr56 ? FIRST_ENABLE_ABS_MAX : GAS_ABS_MAX,
      boundsName: pr56 ? "FIRST_ENABLE_GAS_BOUNDS" : "GAS_BOUNDS",
    };
  };

  const row = (label: string, live: boolean | null, pid: Hex, nonce: bigint, permCalls: number, nPerm: number) => {
    const v = verdict(live === true, nonce);
    console.log(
      `  ${label.padEnd(46)} pId ${pid}  perms ${String(nPerm).padStart(2)}  ` +
        `mode ${hx(modeOf(nonce))} vType ${hx(vTypeOf(nonce))}  ` +
        `${modeOf(nonce) === 1 ? "ENABLE " : "DEFAULT"}  ` +
        `permissionConfig calls ${permCalls}  ` +
        `isFirstEnable ${String(v.first).padEnd(5)}  PR#56 firstEnable ${String(v.pr56).padEnd(5)}  ceiling ${v.ceiling.toLocaleString("en-US")}`,
    );
  };

  // ═══ SECTION 1 ════════════════════════════════════════════════════════════
  // DEPLOYED ACCOUNT + FRESH SESSION KEY. Vary the wall, the key, and repeat.
  console.log("── 1. REAL DEPLOYED ACCOUNTS + A FRESH PERMISSION VALIDATOR ─────────────────\n");

  const keyA = generatePrivateKey();
  const keyB = generatePrivateKey();
  const FIXED_NOW = 1_756_800_000; // pinned so "same key twice" is genuinely identical

  for (const s of DEPLOYED) {
    const c = await getCode(s.addr);
    const live = c === null ? null : c !== "0x" && c.length > 2;
    console.log(`${s.addr}  (${s.note})`);
    console.log(`  code: ${c === null ? "UNREAD — not 'absent'" : `${(c.length - 2) / 2} bytes`}   isDeployed() would return: ${live === null ? "UNREAD" : live ? "TRUE" : "FALSE"}`);
    if (live === null) {
      console.log("  skipping the nonce probes for this account — its deployment state is UNREAD, not false.\n");
      continue;
    }

    const cases: { label: string; o: Parameters<typeof probe>[0] }[] = [
      { label: "full wall, session key A", o: { addr: s.addr, sessionKey: keyA, now: FIXED_NOW } },
      { label: "full wall, session key A (repeat, identical)", o: { addr: s.addr, sessionKey: keyA, now: FIXED_NOW } },
      { label: "full wall, session key B", o: { addr: s.addr, sessionKey: keyB, now: FIXED_NOW } },
      { label: "SAME key A, grant 1 second later", o: { addr: s.addr, sessionKey: keyA, now: FIXED_NOW + 1 } },
      { label: "wall +1 custom token, key A", o: { addr: s.addr, sessionKey: keyA, now: FIXED_NOW, extraTokens: [FAKE_TOKEN(1)] } },
      { label: "wall +5 custom tokens, key A", o: { addr: s.addr, sessionKey: keyA, now: FIXED_NOW, extraTokens: [1, 2, 3, 4, 5].map(FAKE_TOKEN) } },
      { label: "wall +20 custom tokens, key A", o: { addr: s.addr, sessionKey: keyA, now: FIXED_NOW, extraTokens: Array.from({ length: 20 }, (_, i) => FAKE_TOKEN(i + 1)) } },
    ];
    for (const cse of cases) {
      try {
        const r = await probe(cse.o);
        row(cse.label, live, r.pid, r.nonce, r.permCalls, r.nPermissions);
      } catch (e) {
        console.log(`  ${cse.label.padEnd(46)} UNREAD: ${String(e instanceof Error ? e.message : e).slice(0, 120)}`);
      }
    }
    console.log("");
  }

  // CONTROL: the same shapes against an account that is genuinely undeployed.
  console.log("── 1b. CONTROL: a counterfactual (undeployed) account, same shapes ──────────\n");
  {
    // Derived on a PLAIN http client: getSenderAddress reads the address out of
    // an EntryPoint revert, and our instrumented transport turns RPC errors into
    // thrown Errors, which that path cannot parse. Purely a plumbing detail —
    // the address is the same one the worker would derive.
    const plain = createPublicClient({ chain: chainForId(4663), transport: http(RPC, { retryCount: 6, retryDelay: 1500, timeout: 30_000 }) });
    const cfSudo = await createKernelAccount(plain, { entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ecdsa } });
    const addr = cfSudo.address as Address;
    const c = await getCode(addr);
    const live = c === null ? null : c !== "0x" && c.length > 2;
    console.log(`${addr}  (counterfactual — derived, never deployed)`);
    console.log(`  code: ${c === null ? "UNREAD" : `${(c.length - 2) / 2} bytes`}   isDeployed() would return: ${live === null ? "UNREAD" : live ? "TRUE" : "FALSE"}`);
    if (live !== null) {
      for (const [label, o] of [
        ["full wall, session key A", { addr, sessionKey: keyA, now: FIXED_NOW }],
        ["full wall, session key B", { addr, sessionKey: keyB, now: FIXED_NOW }],
      ] as const) {
        const r = await probe(o as Parameters<typeof probe>[0]);
        row(label, live, r.pid, r.nonce, r.permCalls, r.nPermissions);
      }
    }
    console.log("");
  }

  // ═══ SECTION 2 ════════════════════════════════════════════════════════════
  // THE CONVERSE. An ALREADY-INSTALLED permission validator must give mode 0x00.
  console.log("── 2. THE CONVERSE — permission validator ALREADY INSTALLED ─────────────────");
  console.log("   (steady state: the case the 3,000,000 ceiling actually exists for)\n");
  console.log("   Method: toPermissionValidator accepts an explicit `permissionId`");
  console.log("   (toPermissionValidator.ts:71-73 short-circuits getPermissionId), so we can");
  console.log("   point a validator at a pId this account PROVABLY installed and let the SDK");
  console.log("   decide the mode by its own on-chain read. The signer contract still has to");
  console.log("   match — isEnabled compares permissionConfig(pId).signer against");
  console.log("   ECDSA_SIGNER_CONTRACT — so this is not a rubber stamp.\n");

  for (const s of INSTALLED) {
    const c = await getCode(s.addr);
    const live = c === null ? null : c !== "0x" && c.length > 2;
    console.log(`${s.addr}  pId ${s.pid}  (${s.note})`);
    console.log(`  code: ${c === null ? "UNREAD" : `${(c.length - 2) / 2} bytes`}   isDeployed() would return: ${live === null ? "UNREAD" : live ? "TRUE" : "FALSE"}`);

    // read permissionConfig ourselves so the install is a fact, not an assumption
    try {
      const data = (PERMISSION_CONFIG_SELECTOR + s.pid.slice(2).padEnd(64, "0")) as Hex;
      const raw = (await wire("eth_call", [{ to: s.addr, data }, "latest"])) as string;
      // Returns ONE struct { bytes2 permissionFlag; address signer; bytes22[] policyData }.
      // policyData is dynamic, so the struct itself is dynamic: word 0 is the
      // offset to it, word 1 is the flag, word 2 is the signer.
      const words = raw.slice(2).match(/.{64}/g) ?? [];
      const flag = words[1] ? `0x${words[1].slice(0, 4)}` : "?";
      const signer = words[2] ? `0x${words[2].slice(24)}` : "?";
      const installed = signer.toLowerCase() === ECDSA_SIGNER_CONTRACT.toLowerCase();
      console.log(`  permissionConfig(${s.pid}): flag ${flag} signer ${signer}  -> ${installed ? "INSTALLED (signer == ECDSA_SIGNER_CONTRACT)" : "NOT the ECDSA signer"}`);
    } catch (e) {
      console.log(`  permissionConfig(${s.pid}): UNREAD — ${String(e instanceof Error ? e.message : e).slice(0, 120)}`);
    }

    if (live === null) {
      console.log("  skipping nonce probes — deployment state UNREAD.\n");
      continue;
    }
    try {
      const r = await probe({ addr: s.addr, sessionKey: keyA, permissionId: s.pid, now: FIXED_NOW });
      row("INSTALLED pId (steady state)", live, r.pid, r.nonce, r.permCalls, r.nPermissions);
      const rc = await probe({ addr: s.addr, sessionKey: keyA, permissionId: "0xdeadbeef", now: FIXED_NOW });
      row("CONTROL: bogus pId 0xdeadbeef", live, rc.pid, rc.nonce, rc.permCalls, rc.nPermissions);
      const rf = await probe({ addr: s.addr, sessionKey: keyB, now: FIXED_NOW });
      row("CONTROL: fresh key, derived pId (renewal)", live, rf.pid, rf.nonce, rf.permCalls, rf.nPermissions);
    } catch (e) {
      console.log(`  UNREAD: ${String(e instanceof Error ? e.message : e).slice(0, 140)}`);
    }
    console.log("");
  }

  // ═══ SECTION 3 ════════════════════════════════════════════════════════════
  // Does isPluginEnabled make a real on-chain call, and what does a FAILED read do?
  console.log("── 3. THE ON-CHAIN CALL, AND WHAT HAPPENS WHEN IT FAILS ─────────────────────\n");
  console.log("   SOURCE (node_modules/@zerodev/sdk/accounts/utils/toKernelPluginManager.ts:390-393):");
  console.log("     const validatorMode = !regular || (await isPluginEnabled(...)) ? DEFAULT : ENABLE");
  console.log("   :175-180  isEnabled = (await regular_.isEnabled(...)) || (await isPluginInitialized(...))");
  console.log("   node_modules/@zerodev/permissions/toPermissionValidator.ts:137-156");
  console.log("     isEnabled: try { readContract permissionConfig(pId) … } catch (error) { return false }");
  console.log("   toPermissionValidator.ts:86  address: zeroAddress   -> the isPluginInitialized");
  console.log("     disjunct calls a codeless address, throws, and is caught to false as well");
  console.log("     (isPluginInitialized.ts:11-23).");
  console.log("   => BOTH disjuncts collapse to FALSE on any error, so a FAILED READ YIELDS ENABLE.\n");

  const target = INSTALLED[0]!;
  const tCode = await getCode(target.addr);
  const tLive = tCode === null ? null : tCode !== "0x" && tCode.length > 2;
  console.log(`   Subject: ${target.addr} (installed pId ${target.pid}, deployed: ${tLive === null ? "UNREAD" : tLive}).`);
  console.log("   This account's steady-state nonce is mode 0x00 (section 2). Now break ONLY");
  console.log("   its permissionConfig read — locally, inside our own transport, before the");
  console.log("   request leaves the process — and read the nonce again.\n");

  if (tLive !== null) {
    // 3a: healthy — establish the baseline again, and count the calls
    try {
      const healthy = await probe({ addr: target.addr, sessionKey: keyA, permissionId: target.pid, now: FIXED_NOW });
      row("3a healthy RPC", tLive, healthy.pid, healthy.nonce, healthy.permCalls, healthy.nPermissions);
      console.log(`      ^ permissionConfig calls = ${healthy.permCalls} -> isPluginEnabled DOES hit the chain (${healthy.permCalls === 0 ? "NO — unexpected" : "yes, a real eth_call"})`);
    } catch (e) {
      console.log(`   3a UNREAD: ${String(e).slice(0, 140)}`);
    }

    // 3b: the permissionConfig read fails
    FAULT = (r) => (isPermissionConfigCall(r, target.addr) ? "injected fault: permissionConfig read failed (simulated RPC error)" : null);
    try {
      const broken = await probe({ addr: target.addr, sessionKey: keyA, permissionId: target.pid, now: FIXED_NOW });
      row("3b permissionConfig read FAILS", tLive, broken.pid, broken.nonce, broken.permCalls, broken.nPermissions);
      const flipped = modeOf(broken.nonce) === 0x01;
      console.log(
        `      ^ VERDICT: a failed read makes the SDK claim ${flipped ? "ENABLE (0x01)" : "DEFAULT (0x00)"}. ` +
          `${flipped ? "FAIL-TOWARD-ENABLE." : "FAIL-TOWARD-DEFAULT."}`,
      );
    } catch (e) {
      console.log(`   3b threw instead of degrading: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
    } finally {
      FAULT = null;
    }

    // 3b': the SAME fault on a RENEWAL (pId genuinely not installed). If the
    // failure direction were DEFAULT, a blip would refuse a renewal. It is not.
    FAULT = (r) => (isPermissionConfigCall(r, target.addr) ? "injected fault: permissionConfig read failed (simulated RPC error)" : null);
    try {
      const r = await probe({ addr: target.addr, sessionKey: keyB, now: FIXED_NOW });
      row("3b' RENEWAL + permissionConfig read FAILS", tLive, r.pid, r.nonce, r.permCalls, r.nPermissions);
      console.log("      ^ a renewal is ENABLE either way, so an RPC blip can never REFUSE one on this path.");
      console.log("        The blip only ever moves a STEADY-STATE op from DEFAULT to ENABLE (3b).");
    } catch (e) {
      console.log(`   3b' UNREAD: ${String(e).slice(0, 140)}`);
    } finally {
      FAULT = null;
    }

    // 3c: EVERY read fails (whole RPC down) — does getNonce throw, or silently produce a nonce?
    FAULT = () => "injected fault: RPC unreachable";
    try {
      const dead = await probe({ addr: target.addr, sessionKey: keyA, permissionId: target.pid, now: FIXED_NOW });
      row("3c WHOLE RPC down", tLive, dead.pid, dead.nonce, dead.permCalls, dead.nPermissions);
      console.log("      ^ getNonce returned a nonce with the RPC entirely down — that would be surprising.");
    } catch (e) {
      console.log(`   3c WHOLE RPC down: account.getNonce() THREW — ${String(e instanceof Error ? e.message : e).split("\n")[0]!.slice(0, 160)}`);
      console.log("      ^ so a total outage is loud (the executor's estimate would fail anyway).");
      console.log("        The dangerous case is 3b: the EntryPoint getNonce read succeeds while the");
      console.log("        permissionConfig read fails, which is one flaky call, not an outage.");
    } finally {
      FAULT = null;
    }
  }

  // ═══ SECTION 3d ═══════════════════════════════════════════════════════════
  // DOES MERRYMEN ITSELF HAVE A DEPLOYED ACCOUNT WITH A LIVE WALL?
  console.log("\n── 3d. DOES MERRYMEN HAVE A DEPLOYED ACCOUNT WITH A LIVE WALL? ──────────────\n");
  console.log("   NO — and the section-2 subjects are therefore other people's accounts, not ours.");
  console.log("   merrymen's own account 0x032da6a0…9036 has executed exactly ONE UserOperation in");
  console.log("   its life: mode 0x00 / vType 0x00 (SUDO, DEFAULT), seq 0, block 51207025, success.");
  console.log("   Source: per-sender UserOperationEvent scan over all 2,208 ZeroDev-factory accounts");
  console.log("   on 4663 (spikes/first-op-gas/perm-ops.json, 0 accounts unreadable) — that account");
  console.log("   appears exactly once and never with vType 0x02.");
  console.log("   So no merrymen wall has ever been installed on chain, and the steady-state DEFAULT");
  console.log("   branch is demonstrated on the closest available subjects: real Kernel v3.3 accounts");
  console.log("   on the same chain whose permission validators DID land. That is a property of the");
  console.log("   Kernel/SDK mechanism, not of who owns the account.\n");

  // ═══ SECTION 4 ════════════════════════════════════════════════════════════
  console.log("── 4. WHAT worker/src/executor.ts ON fix/first-enable-gas COMPUTES ──────────");
  console.log("   const accountLive = await isDeployed();            // executor.ts:389");
  console.log("   const nonce       = await account.getNonce();      // executor.ts:390");
  console.log("   const firstEnable = !accountLive && isFirstEnable(nonce);  // :391");
  console.log("   const bounds      = firstEnable ? FIRST_ENABLE_GAS_BOUNDS : GAS_BOUNDS;  // :392");
  console.log("   (the tables above already print every one of those four values per case)\n");
  console.log("   ALSO NOTE executor.ts ~:325 — the estimate's stateOverride balance is");
  console.log("   `bounds.absoluteMax * feeCeiling * 2n`, i.e. sized FROM the chosen ceiling.");
  console.log("   So the 3,000,000 branch also hands the bundler too little imaginary ETH,");
  console.log("   and the refusal arrives as `gas-unreadable` (AA21) rather than `gas-absurd`.\n");

  // ═══ SECTION 5 ════════════════════════════════════════════════════════════
  // boundGas's ACTUAL verdict, from the repo's own function, on the measured op.
  console.log("── 5. boundGas()'s VERDICT — the repo's own function, run here ──────────────\n");
  console.log("   Gas inputs are the MEASURED walled first op on 4663, Pimlico, 2026-09-03");
  console.log("   (spikes/first-op-gas/renewal-override.ts): verif 7,418,031 · preVerif 243,380 · call 50,180.");
  console.log("   A deployed re-enable is the same op minus a ~360k deploy, so it is if anything");
  console.log("   SMALLER — the verdict below does not depend on that difference.\n");
  const MEASURED = { callGasLimit: 50_180n, verificationGasLimit: 7_418_031n, preVerificationGas: 243_380n };
  const show = (label: string, v: ReturnType<typeof boundGas>) =>
    console.log(
      v.ok
        ? `  ${label.padEnd(52)} ACCEPTED  signed total ${v.total.toLocaleString("en-US")}`
        : `  ${label.padEnd(52)} REFUSED   rule "${v.rule}"\n      ${v.detail.slice(0, 300)}`,
    );
  show("undeployed first op -> FIRST_ENABLE_GAS_BOUNDS", boundGas(MEASURED, MEASURED, FIRST_ENABLE_GAS_BOUNDS, false));
  show("renewal, estimate SUCCEEDS -> GAS_BOUNDS", boundGas(MEASURED, MEASURED, GAS_BOUNDS, false));
  show("renewal, override too small -> estimate null", boundGas(null, null, GAS_BOUNDS, false));
  show("steady-state op (mode 0x00) -> GAS_BOUNDS", boundGas({ callGasLimit: 60_000n, verificationGasLimit: 657_108n, preVerificationGas: 60_000n }, { callGasLimit: 60_000n, verificationGasLimit: 657_108n, preVerificationGas: 60_000n }, GAS_BOUNDS, false));
  console.log("\n   (the steady-state row uses verificationGasLimit 657,108 — the SIGNED value on");
  console.log("    0xa48ce91e…'s post-enable ops, tx 0x66e4f2d6…, decoded from handleOps calldata.");
  console.log("    It is comfortably inside 3,000,000, which is what that ceiling is sized for.)\n");
}

main().catch((e) => {
  console.error("shape probe failed:", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
