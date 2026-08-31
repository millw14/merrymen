/**
 * Deploy PonsSelfTrade — the contract that makes a Pons bonding curve
 * constrainable by the permission wall.
 *
 * RUN BY THE OWNER, deliberately. Deployment spends real gas from a real key,
 * and this repo's agent never handles owner keys or moves funds on its own.
 * The key is read from the environment by hardhat.config.ts and is never
 * logged, written, or echoed by this script — only the ADDRESS it derives to.
 *
 *   $env:MERRYMEN_DEPLOYER_PRIVATE_KEY = "0x…"   # shell-only; close it after
 *   npx hardhat run scripts/deploy-ponsselftrade.ts --network robinhoodTestnet
 *   npx hardhat run scripts/deploy-ponsselftrade.ts --network robinhood
 *
 * The two runs produce two DIFFERENT addresses (independent nonces per chain).
 * Paste each into /settings as `ponsAdapterAddress` on the machine that signs
 * grants for that chain, then RE-SIGN the grant — the address is sealed into
 * the signature, so the setting alone changes nothing.
 *
 * NO CONSTRUCTOR ARGUMENTS, and that is worth noticing rather than glossing.
 * V4SelfSwap pins its PoolManager as an immutable because there is exactly one
 * singleton to trust. There is no equivalent here: a Pons buy goes to a
 * per-token curve, ~475 new addresses an hour, so the curve is a call argument
 * and the contract cannot pin anything. That is stated in the contract header
 * and in the wall's permission, and it means this script has one less thing to
 * verify — and the deployment one less thing to get wrong.
 */
import hre from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ESM has no __dirname; deployments.json sits beside contracts/scripts.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The only chains this should ever touch. Anything else is a mistake. */
const KNOWN_CHAINS: Record<number, string> = {
  46630: "Robinhood Chain testnet",
  4663: "Robinhood Chain MAINNET — real funds",
};

/**
 * The Pons launch factory, checked as a SANITY probe and nothing more.
 *
 * The adapter does not reference it — deliberately, since a curve's own
 * `factory()` is self-attested and the factory publishes no registry view, so
 * neither direction authenticates anything. What this check IS good for: if
 * the factory has no code here, this is not the chain you think it is, and
 * that is worth learning before spending gas.
 */
const PONS_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as const;

async function main() {
  const publicClient = await hre.viem.getPublicClient();
  const chainId = await publicClient.getChainId();

  if (!(chainId in KNOWN_CHAINS)) {
    throw new Error(
      `refusing to deploy to unknown chain ${chainId} — this script only knows ` +
        `Robinhood Chain testnet (46630) and mainnet (4663). Check --network.`,
    );
  }

  const wallets = await hre.viem.getWalletClients();
  if (wallets.length === 0) {
    throw new Error(
      "no deployer account. Set MERRYMEN_DEPLOYER_PRIVATE_KEY in this shell " +
        "(it is read by hardhat.config.ts and never logged), then re-run.",
    );
  }
  const deployer = wallets[0]!.account.address;
  console.log(`chain    : ${chainId} (${KNOWN_CHAINS[chainId]})`);
  console.log(`deployer : ${deployer}`);

  const factoryCode = await publicClient.getCode({ address: PONS_FACTORY });
  if (factoryCode === undefined || factoryCode === "0x") {
    console.log(
      `! the Pons factory ${PONS_FACTORY} has no code on chain ${chainId}. ` +
        `The adapter does not depend on it, so this is not fatal — but check you are on the chain you meant.`,
    );
  }

  const balance = await publicClient.getBalance({ address: deployer });
  console.log(`balance  : ${Number(balance) / 1e18} ETH`);
  if (balance === 0n) {
    throw new Error("deployer has no ETH — fund it first (testnet: https://faucet.testnet.chain.robinhood.com).");
  }

  console.log("deploying PonsSelfTrade…");
  const adapter = await hre.viem.deployContract("PonsSelfTrade");

  // POST-VERIFY against the chain rather than against hope.
  const code = await publicClient.getCode({ address: adapter.address });
  if (code === undefined || code === "0x") {
    throw new Error(`deploy reported ${adapter.address} but there is no code there — inspect the transaction.`);
  }
  // The ABI is the surface the wall pins, so check it is the one we think:
  // exactly one function, non-payable. A payable entry point would mean the
  // permission's `valueLimit: 0` was guarding a door that had moved.
  const fns = (adapter.abi as { type: string; name?: string; stateMutability?: string }[]).filter(
    (e) => e.type === "function",
  );
  if (fns.length !== 1 || fns[0]!.name !== "tradeExactIn") {
    throw new Error(`unexpected ABI: ${fns.map((f) => f.name).join(", ")} — do NOT use this deployment.`);
  }
  if (fns[0]!.stateMutability !== "nonpayable") {
    throw new Error("tradeExactIn is not non-payable — do NOT use this deployment.");
  }

  // PERSIST THE ADDRESS. This script only ever printed it, which is why the
  // question "is the adapter deployed?" could not be answered from the repo, from
  // git history on any branch, or from a running worker's home -- an audit had to
  // conclude "there is no candidate address to even check". A deployment that
  // exists only in a shell's scrollback is a deployment nobody can verify, and
  // re-deploying to find out produces a DIFFERENT address that invalidates any
  // grant already sealed against the old one.
  //
  // Keyed by chain id, because one flat value cannot serve two chains that
  // produce different addresses and /grant offers a two-click chain switch.
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
    PonsSelfTrade: {
      address: adapter.address,
      deployedAt: new Date().toISOString(),
      codeBytes: (code.length - 2) / 2,
    },
  };
  writeFileSync(file, JSON.stringify(book, null, 2) + "\n");

  console.log("");
  console.log(`✓ PonsSelfTrade deployed at ${adapter.address}`);
  console.log(`  recorded in contracts/deployments.json under chain ${chainKey} — COMMIT THIS`);
  console.log(`  code : ${(code.length - 2) / 2} bytes`);
  console.log("");
  console.log("next steps:");
  console.log(`  1. paste ${adapter.address} into /settings as "Pons adapter contract" (ponsAdapterAddress)`);
  console.log("  2. RE-SIGN the grant at /grant — the address is sealed into the signature,");
  console.log("     so the setting alone changes nothing");
  console.log("  3. unset MERRYMEN_DEPLOYER_PRIVATE_KEY / close this shell");
  console.log("");
  console.log("what this does NOT unlock, so it is not a surprise later:");
  console.log("  - native-ETH-quoted curves (~47% of launches, measured over 5,730 across four");
  console.log("    those need a different selector and a different threat model.");
  console.log("  - any curve whose token you have not added in /settings and re-signed for.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
