/**
 * `merrymen recover` worker entry — invoked by cli/bin.mjs via tsx. Kept out of
 * the CLI itself because rebuilding a ZeroDev Kernel account needs viem +
 * @zerodev, which the zero-dependency CLI doesn't carry.
 *
 * Contract with bin.mjs:
 *   argv:  <plan|sweep> <destination> [chainId]
 *   env:   MERRYMEN_RECOVER_OWNER_KEY   the owner private key (never logged)
 *          MERRYMEN_RECOVER_EXPECT      optional expected smart-account address
 *
 * Human progress → stderr (streamed live). One machine result line → stdout:
 *   __RESULT__{json}
 * so the CLI can decide what to do next without scraping prose.
 */

import { chainForId, pimlicoBundlerUrl, robinhoodChain } from "../../packages/core/src/index";
import { resolveConfig } from "./settings";
import { planRecovery, recoverFunds } from "./recover";

const say = (s: string) => process.stderr.write(`${s}\n`);
const emit = (obj: unknown) => process.stdout.write(`__RESULT__${JSON.stringify(obj)}\n`);

async function main() {
  const mode = process.argv[2];
  const to = process.argv[3] as `0x${string}` | undefined;
  const chainId = Number(process.argv[4] || robinhoodChain.id);

  const ownerKey = process.env.MERRYMEN_RECOVER_OWNER_KEY as `0x${string}` | undefined;
  const expect = (process.env.MERRYMEN_RECOVER_EXPECT || undefined) as `0x${string}` | undefined;

  if (mode !== "plan" && mode !== "sweep") {
    say("recover-cli: mode must be plan|sweep");
    emit({ ok: false, error: "bad-mode" });
    process.exit(2);
  }
  if (!ownerKey || !/^0x[0-9a-fA-F]{64}$/.test(ownerKey)) {
    say("recover-cli: MERRYMEN_RECOVER_OWNER_KEY missing or not a 32-byte hex key");
    emit({ ok: false, error: "bad-owner-key" });
    process.exit(2);
  }
  if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to)) {
    say("recover-cli: destination is not a valid address");
    emit({ ok: false, error: "bad-destination" });
    process.exit(2);
  }

  const cfg = resolveConfig();
  const chain = chainForId(chainId);
  const rpcUrl = chainId === robinhoodChain.id ? cfg.rpcMainnet : cfg.rpcTestnet;

  try {
    if (mode === "plan") {
      const plan = await planRecovery({ chain, ownerPrivateKey: ownerKey, rpcUrl, expectedSmartAccount: expect });
      say(`  smart account : ${plan.smartAccount}`);
      say(`  owner EOA     : ${plan.ownerAddress}   ${"<- what MetaMask shows when you import the key"}`);
      say(`  native gas    : ${(Number(plan.gasWei) / 1e18).toFixed(6)} ETH`);
      if (plan.balances.length === 0) {
        say("  holdings      : none — this account is empty");
      } else {
        say("  holdings:");
        for (const b of plan.balances) say(`    • ${b.amount} ${b.symbol}`);
      }
      emit({
        ok: true,
        smartAccount: plan.smartAccount,
        ownerAddress: plan.ownerAddress,
        gasWei: plan.gasWei.toString(),
        balances: plan.balances.map((b) => ({ symbol: b.symbol, amount: b.amount })),
      });
      process.exit(0);
    }

    // sweep
    const bundlerUrl =
      cfg.bundlerUrl || (cfg.bundlerApiKey ? pimlicoBundlerUrl(chainId, cfg.bundlerApiKey) : undefined);
    if (!bundlerUrl) {
      say("recover-cli: no bundler configured — cannot submit the recovery transaction");
      emit({ ok: false, error: "no-bundler" });
      process.exit(3);
    }
    say(`  sweeping to ${to} …`);
    const res = await recoverFunds({
      chain,
      ownerPrivateKey: ownerKey,
      bundlerUrl,
      rpcUrl,
      to,
      expectedSmartAccount: expect,
    });
    if (!res.txHash) {
      say("  nothing to sweep — account is empty");
      emit({ ok: true, txHash: null, balances: [] });
      process.exit(0);
    }
    say(`  ✓ swept — tx ${res.txHash}`);
    emit({
      ok: true,
      txHash: res.txHash,
      to: res.to,
      smartAccount: res.smartAccount,
      balances: res.balances.map((b) => ({ symbol: b.symbol, amount: b.amount })),
    });
    process.exit(0);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    say(`  ✗ ${msg}`);
    emit({ ok: false, error: msg });
    process.exit(1);
  }
}

void main();
