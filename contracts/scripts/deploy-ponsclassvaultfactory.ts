/**
 * Deploy PonsClassVaultFactory.
 *
 *   $env:MERRYMEN_DEPLOYER_PRIVATE_KEY = "0x…"   # shell-only; close it after
 *   npx hardhat run scripts/deploy-ponsclassvaultfactory.ts --network robinhoodTestnet
 *   npx hardhat run scripts/deploy-ponsclassvaultfactory.ts --network robinhood
 *
 * The two runs produce two DIFFERENT addresses (independent nonces). That is
 * correct and expected.
 *
 * ONE FACTORY, MANY VAULTS. Unlike PonsSelfTrade and V4SelfSwap, this contract
 * is not the thing an agent calls to trade — it is the thing that CREATES the
 * per-account vault an agent trades through. Each account's vault is CREATE2'd
 * with the account as salt, so its address is knowable before it exists, which
 * is the only reason the wall can pin it as a target at signing time.
 *
 * NOBODY NEEDS TO DEPLOY A VAULT BY HAND. `deploy(owner)` is permissionless and
 * the session key carries a permission to call it, pinned to its own account, so
 * the first class buy creates the vault in the same operation. This script
 * deploys the FACTORY once per chain and nothing else.
 *
 * READ docs/owner-runbook-class.md BEFORE RUNNING THIS. It opens with the
 * reasons not to, and they are real.
 */
import hre from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The only chains this should ever touch. Anything else is a mistake. */
const KNOWN_CHAINS: Record<number, string> = {
  46630: "Robinhood Chain testnet",
  4663: "Robinhood Chain MAINNET — real funds",
};

async function main() {
  const publicClient = await hre.viem.getPublicClient();
  const chainId = await publicClient.getChainId();

  if (!(chainId in KNOWN_CHAINS)) {
    throw new Error(
      `refusing to deploy to unknown chain ${chainId} — this script only knows ` +
        `Robinhood Chain testnet (46630) and mainnet (4663). Check --network.`,
    );
  }

  const [deployer] = await hre.viem.getWalletClients();
  if (!deployer) {
    throw new Error("no deployer — set MERRYMEN_DEPLOYER_PRIVATE_KEY in this shell.");
  }
  const balance = await publicClient.getBalance({ address: deployer.account.address });
  if (balance === 0n) {
    throw new Error(
      `deployer ${deployer.account.address} holds no ETH on ${KNOWN_CHAINS[chainId]}. ` +
        `Fund it first — testnet gas is free at https://faucet.testnet.chain.robinhood.com`,
    );
  }

  console.log(`deploying PonsClassVaultFactory to ${KNOWN_CHAINS[chainId]} (${chainId})`);
  console.log(`  from ${deployer.account.address}`);
  const factory = await hre.viem.deployContract("PonsClassVaultFactory");

  // ── POST-VERIFY AGAINST THE CHAIN, NOT AGAINST THE ARTIFACT ──────────────
  const code = await publicClient.getCode({ address: factory.address });
  if (!code || code === "0x") {
    throw new Error(`deployment reported success but ${factory.address} has no code.`);
  }

  // THE PROPERTY THE WALL DEPENDS ON, checked before anyone signs against it.
  // The grant pins a vault address derived from `vaultFor` at signing time, and
  // the vault is created later by `deploy`. If those two ever disagreed, every
  // class permission would name a contract that never comes into existence —
  // and a CALL to a codeless address SUCCEEDS with empty returndata, so the
  // failure would be a silent no-op reported as a landed trade, not a revert.
  const probeOwner = deployer.account.address;
  const predicted = (await publicClient.readContract({
    address: factory.address,
    abi: [
      {
        type: "function",
        name: "vaultFor",
        stateMutability: "view",
        inputs: [{ name: "owner_", type: "address" }],
        outputs: [{ type: "address" }],
      },
    ] as const,
    functionName: "vaultFor",
    args: [probeOwner],
  })) as string;
  if (!/^0x[0-9a-fA-F]{40}$/.test(predicted) || /^0x0{40}$/i.test(predicted)) {
    throw new Error(`vaultFor returned ${predicted} — do NOT use this deployment.`);
  }
  console.log(`  vaultFor(${probeOwner.slice(0, 10)}…) → ${predicted}`);

  const file = path.join(__dirname, "..", "deployments.json");
  let book: Record<string, Record<string, { address: string; deployedAt: string; codeBytes: number }>> = {};
  try {
    book = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    /* first deployment on any chain */
  }
  const chainKey = String(chainId);
  book[chainKey] = {
    ...(book[chainKey] ?? {}),
    PonsClassVaultFactory: {
      address: factory.address,
      deployedAt: new Date().toISOString(),
      codeBytes: (code.length - 2) / 2,
    },
  };
  writeFileSync(file, JSON.stringify(book, null, 2) + "\n");

  console.log("");
  console.log(`✓ PonsClassVaultFactory deployed at ${factory.address}`);
  console.log(`  recorded in contracts/deployments.json under chain ${chainKey} — COMMIT THIS`);
  console.log(`  code : ${(code.length - 2) / 2} bytes`);
  console.log("");
  console.log("next steps:");
  console.log(`  1. paste ${factory.address} into /settings as "Class vault factory contract"`);
  console.log("  2. RE-SIGN the grant at /grant — the address is sealed into the signature,");
  console.log("     and the wall REFUSES to seal a vault without a factory");
  console.log("  3. turn on the class route in /settings (classSnipeEnabled) AND set");
  console.log("     classPerEntryUsdg — both default to off/zero, and both are required");
  console.log("  4. unset MERRYMEN_DEPLOYER_PRIVATE_KEY / close this shell");
  console.log("");
  console.log("what this does NOT unlock, so it is not a surprise later:");
  console.log("  - native-ETH-quoted curves. 53.6% of launches, and the vault refuses them");
  console.log("    by name: every wall permission carries valueLimit 0.");
  console.log("  - curves quoted in anything but USDG — reaching those needs a second hop.");
  console.log("  - any provenance guarantee from the chain. NOTHING on chain vouches for a");
  console.log("    class token; the worker's factory-filtered launch feed is the only check,");
  console.log("    so for this route the chain is LOOSER than the off-chain mirror.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
