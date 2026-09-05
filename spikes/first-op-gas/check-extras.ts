/**
 * Do `extraTokens` actually widen the wall's policies, and is the estimation
 * stub the REAL enable blob or a fixed-size dummy?
 *
 * The gas sweep returned an identical 7,418,031 verificationGasLimit at +0, +5,
 * +15 and +40 extra tokens, with the stub pinned at 10,932 bytes. Either the
 * wall's size genuinely does not drive the cost, or the extras never reached
 * `buildWallPolicies`, or the stub is a constant that does not reflect the real
 * enable data. Those three have completely different consequences, so this
 * separates them before any conclusion is drawn.
 *
 * No network writes. Nothing signed, nothing broadcast.
 */
import { createPublicClient, http, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getEntryPoint, KERNEL_V3_3 } from "@zerodev/sdk/constants";
import { createKernelAccount } from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { toPermissionValidator } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { buildWallPolicies, chainForId } from "../../packages/core/src/index";

const CAPS = { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 };

async function main() {
  const publicClient = createPublicClient({
    chain: chainForId(4663),
    transport: http("https://rpc.mainnet.chain.robinhood.com"),
  });
  const entryPoint = getEntryPoint("0.7");

  for (const n of [0, 40]) {
    const extras = Array.from({ length: n }, (_, i) => ({
      // isValidCustomToken requires exactly {symbol, address, decimals} — my
      // first attempt passed the STOCK_TOKENS shape (name/chainlinkFeed/kind,
      // no decimals) and every entry was silently dropped, which made the sweep
      // look like the wall size did not matter when it had never been varied.
      symbol: `X${i}`,
      address: `0x${(i + 0x1000).toString(16).padStart(40, "0")}` as Address,
      decimals: 18,
    }));
    const owner = privateKeyToAccount(generatePrivateKey());
    const ecdsa = await signerToEcdsaValidator(publicClient, {
      signer: owner,
      entryPoint,
      kernelVersion: KERNEL_V3_3,
    });
    const sudoOnly = await createKernelAccount(publicClient, {
      entryPoint,
      kernelVersion: KERNEL_V3_3,
      plugins: { sudo: ecdsa },
    });
    const { policies } = buildWallPolicies({
      caps: CAPS,
      smartAccount: sudoOnly.address,
      ...(n ? { extraTokens: extras as never } : {}),
    });

    // The CALL policy's own serialized data is where the ONE_OF lists live.
    const sizes = policies.map((p: unknown) => {
      const o = p as { policyParams?: { type?: string }; getPolicyData?: () => string };
      let bytes: number | string = "n/a";
      try {
        const d = o.getPolicyData?.();
        if (typeof d === "string") bytes = d.length / 2 - 1;
      } catch {
        bytes = "threw";
      }
      return `${o.policyParams?.type ?? "?"}:${bytes}`;
    });

    const sess = await toECDSASigner({ signer: privateKeyToAccount(generatePrivateKey()) });
    const pv = await toPermissionValidator(publicClient, {
      entryPoint,
      kernelVersion: KERNEL_V3_3,
      signer: sess,
      policies,
      flag: "0x0002",
    });

    let enableBytes: number | string = "n/a";
    try {
      const v = pv as unknown as { getEnableData?: (a: Address) => Promise<string> };
      const e = await v.getEnableData?.(sudoOnly.address);
      if (typeof e === "string") enableBytes = e.length / 2 - 1;
    } catch (err) {
      enableBytes = `threw: ${String(err).slice(0, 40)}`;
    }

    console.log(
      `extras ${String(n).padStart(2)} · policies ${policies.length} · [${sizes.join(" ")}] · enableData ${enableBytes}B`,
    );
  }
}

main().catch((e) => {
  console.error(String(e).slice(0, 400));
  process.exit(1);
});
