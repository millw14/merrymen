/**
 * WHAT MOVES THE permissionId — AND THEREFORE WHAT COUNTS AS A "NEW" VALIDATOR?
 *
 * toPermissionValidator derives the id as
 *   slice(keccak256(abi.encode([toPolicyId(policies), flag, toSignerId(signer)])), 0, 4)
 * (@zerodev/permissions/toPermissionValidator.ts:71-80)
 *
 * So the id is a hash of the POLICIES and the SESSION KEY. The account address is
 * not an input. This spike varies one input at a time and prints the resulting id,
 * plus the ValidationId that toInitConfig would install for it.
 *
 * It matters because merrymen's wall includes a TIMESTAMP policy built from
 * `now` (packages/core/src/wall.ts:693-698). If the timestamps are part of the
 * hash, then every re-grant — even one that reuses the same session key — is a
 * different permissionId, and therefore a fresh install.
 *
 * ZERO CHAIN CALLS. The viem client is given a static chain so the SDK never
 * needs eth_chainId; nothing is read, signed, sent or funded.
 *
 * Run: npx tsx spikes/first-op-gas/enable-pid-inputs.ts
 */
import { concat, createPublicClient, http, pad, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getEntryPoint, KERNEL_V3_3, VALIDATOR_TYPE } from "@zerodev/sdk/constants";
import { toPermissionValidator } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { buildWallPolicies, chainForId } from "../../packages/core/src/index";

const CAPS = { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 };
const ACCOUNT = "0x032da6a0ccf866474e45854e7fdef9afd1509036" as Address;
const T0 = 1_760_000_000; // a fixed "now", so the only moving part is the one under test

const client = createPublicClient({ chain: chainForId(4663), transport: http("http://127.0.0.1:1/never-called") });
const entryPoint = getEntryPoint("0.7");

/** The ValidationId Kernel installs for a permission — toInitConfig.ts:24-32. */
const validationId = (pId: Hex) => pad(concat([VALIDATOR_TYPE.PERMISSION, pId]), { size: 21, dir: "right" });

async function pid(opts: { key: Hex; now: number; account?: Address }) {
  const signer = await toECDSASigner({ signer: privateKeyToAccount(opts.key) });
  const { policies } = buildWallPolicies({ caps: CAPS, smartAccount: opts.account ?? ACCOUNT, now: opts.now });
  const permission = await toPermissionValidator(client, {
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    signer,
    policies,
    flag: "0x0002",
  });
  const enableData = await permission.getEnableData(opts.account ?? ACCOUNT);
  return {
    id: permission.getIdentifier(),
    policies: policies.length,
    enableBytes: enableData.length / 2 - 1,
    session: signer.account.address,
  };
}

async function main() {
  console.log("ZERO CHAIN CALLS. Nothing read, signed, sent or funded.\n");

  const keyA = generatePrivateKey();
  const keyB = generatePrivateKey();

  const base = await pid({ key: keyA, now: T0 });
  const sameEverything = await pid({ key: keyA, now: T0 });
  const newKey = await pid({ key: keyB, now: T0 });
  const laterGrant = await pid({ key: keyA, now: T0 + 1 }); // same key, one second later
  const otherAccount = await pid({ key: keyA, now: T0, account: "0x00000000000000000000000000000000000000A1" });

  const row = (label: string, r: Awaited<ReturnType<typeof pid>>) =>
    console.log(`  ${label.padEnd(40)} pId ${r.id}  vId ${validationId(r.id)}`);

  console.log(`── permissionId under one-at-a-time variation ────────────────`);
  console.log(`  wall shape: ${base.policies} policies, enableData ${base.enableBytes} bytes\n`);
  row("baseline (key A, t=T0, account X)", base);
  row("IDENTICAL rebuild", sameEverything);
  row("NEW SESSION KEY (key B, t=T0)", newKey);
  row("SAME KEY, grant 1 second later", laterGrant);
  row("SAME KEY, different smart account", otherAccount);

  console.log(`\n── what actually moves it ────────────────────────────────────`);
  const say = (what: string, moved: boolean) => console.log(`  ${what.padEnd(40)} ${moved ? "CHANGES the pId" : "does NOT change the pId"}`);
  say("nothing (determinism check)", base.id !== sameEverything.id);
  say("a new session key", base.id !== newKey.id);
  say("a later grant timestamp", base.id !== laterGrant.id);
  say("a different smart-account address", base.id !== otherAccount.id);

  console.log(`\n=> A renewal is a NEW permissionId ${
    base.id !== newKey.id && base.id !== laterGrant.id
      ? "under BOTH a new key and a re-dated grant"
      : "— see above"
  }, so Kernel must install it from scratch.`);
  console.log(`   The account address is ${base.id === otherAccount.id ? "NOT" : ""} an input to the id${
    base.id === otherAccount.id ? " — the id says nothing about which account it is for." : " (via the call policy's pinned recipient)."
  }`);
}

main().catch((e) => {
  console.error("spike failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
