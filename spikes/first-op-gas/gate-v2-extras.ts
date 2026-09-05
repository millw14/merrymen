/**
 * DOES `extraTokens` MOVE THE ENABLE BLOB THE SAME WAY PERMISSION COUNT DOES?
 *
 * The C5 fit in gate-v2.ts was taken by varying the number of CALL PERMISSIONS.
 * Tenants widen a wall by adding CUSTOM TOKENS, which is a different lever, and
 * spikes/first-op-gas/check-extras.ts records an extras sweep that came back
 * FLAT — an identical 7,418,031 verificationGasLimit at +0, +5, +15 and +40
 * extras with the stub pinned at 10,932 bytes — and names three incompatible
 * explanations without settling between them.
 *
 * If extras genuinely do not move the blob, then sizing the ceiling by blob
 * bytes would let a tenant grow the ESTIMATE without growing the CEILING, and
 * legitimate custom-token grants would be refused. That is the one way the sized
 * ceiling could be worse than the flat one, so it has to be settled.
 *
 * FREE — no bundler, no estimate, no chain write. Just builds the walls and
 * measures the blob the SDK produces.
 */
import { createPublicClient, http, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getEntryPoint, KERNEL_V3_3 } from "@zerodev/sdk/constants";
import { createKernelAccount } from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { toPermissionValidator } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { buildWallPolicies, buildCallPermissions, chainForId, WALL_POLICY_FLAG } from "../../packages/core/src/index";
import { enableCeilingFor } from "./gate-v2";

const CAPS = { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 };
const LIVE = "0x032Da6A0Ccf866474e45854E7fDEF9afd1509036" as Address;
const com = (n: bigint | number) => n.toLocaleString("en-US");

/** A well-formed CustomToken. Passing a BARE ADDRESS here is silently dropped by
 *  usableExtraTokens -> isValidCustomToken, which is almost certainly what made
 *  spikes/first-op-gas/check-extras.ts read FLAT: the extras never reached the
 *  wall builder, so the sweep varied nothing. */
const tok = (i: number) => ({
  symbol: `TK${i}`,
  address: `0x${(0xf0000000 + i).toString(16).padStart(40, "0")}` as Address,
  decimals: 18,
});

async function main() {
  const pc = createPublicClient({ chain: chainForId(4663), transport: http("https://rpc.mainnet.chain.robinhood.com") });
  const entryPoint = getEntryPoint("0.7");
  const ecdsa = await signerToEcdsaValidator(pc, { signer: privateKeyToAccount(generatePrivateKey()), entryPoint, kernelVersion: KERNEL_V3_3 });
  const now = Math.floor(Date.now() / 1000);

  console.log("extras  permissions  blob bytes   Δ bytes vs +0   sized ceiling   fitted raw");
  let base = 0;
  for (const extras of [0, 1, 5, 15, 40]) {
    const extraTokens = Array.from({ length: extras }, (_, i) => tok(i));
    const { policies } = buildWallPolicies({ caps: CAPS, smartAccount: LIVE, now, extraTokens } as never);
    const perms = buildCallPermissions(CAPS, LIVE, { extraTokens } as never);
    const pv = await toPermissionValidator(pc, {
      entryPoint, kernelVersion: KERNEL_V3_3, policies, flag: WALL_POLICY_FLAG,
      signer: await toECDSASigner({ signer: privateKeyToAccount(generatePrivateKey()) }),
    });
    const acct = await createKernelAccount(pc, {
      entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo: ecdsa, regular: pv }, address: LIVE,
    });
    const nonce = await acct.getNonce();
    const callData = await acct.encodeCalls([{ to: LIVE, value: 0n, data: "0x" }]);
    const stub = await acct.getStubSignature({
      sender: LIVE, nonce, callData, callGasLimit: 0n, verificationGasLimit: 0n,
      preVerificationGas: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, signature: "0x",
    } as never);
    const bytes = (stub.length - 2) / 2;
    if (extras === 0) base = bytes;
    const fittedRaw = -169_701n + (700_945n * BigInt(bytes)) / 1_000n;
    console.log(`${String(extras).padStart(6)}  ${String(perms.length).padStart(11)}  ${String(bytes).padStart(10)}  ${String(bytes - base).padStart(14)}   ${com(enableCeilingFor(bytes, false)).padStart(13)}   ${com(fittedRaw).padStart(10)}`);
  }
  console.log(`
  READING. If Δ bytes is 0 across the sweep, extras never reach buildWallPolicies
  and the sized ceiling cannot be moved by a tenant — but neither can the cost,
  so the fit stands and check-extras.ts's flat result is explained. If Δ bytes
  grows, extras DO widen the blob and the ceiling grows with the cost, which is
  exactly what C5 needs. Either answer is fine for the gate; not knowing which is
  not.`);
}
main().catch((e) => { console.error("failed:", e instanceof Error ? e.message : String(e)); process.exit(1); });
