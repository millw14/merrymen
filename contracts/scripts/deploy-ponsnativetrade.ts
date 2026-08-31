/**
 * Deploy PonsNativeTrade — the native-ETH-quoted half of the Pons launchpad,
 * which PonsSelfTrade refuses because it is non-payable.
 *
 * RUN BY THE OWNER, deliberately, for the same reason as its sibling:
 * deployment spends real gas from a real key, and this repo's agent never
 * handles owner keys or moves funds on its own. The key is read from the
 * environment by hardhat.config.ts and is never logged, written or echoed by
 * this script — only the ADDRESS it derives to.
 *
 *   $env:MERRYMEN_DEPLOYER_PRIVATE_KEY = "0x…"   # shell-only; close it after
 *   npx hardhat run scripts/deploy-ponsnativetrade.ts --network robinhood
 *
 * DEPLOY THIS SEPARATELY FROM PonsSelfTrade, and grant it separately. They are
 * two contracts because they carry two different worst cases, and a deployment
 * that treated them as one thing would undo that on the first re-sign.
 */

import hre from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const KNOWN_CHAINS: Record<number, string> = {
  46630: "Robinhood Chain testnet",
  4663: "Robinhood Chain MAINNET — real funds",
};

/**
 * The Pons launch factory, as a SANITY probe only — same as the sibling script.
 * The adapter does not reference it and nothing here authenticates a curve. What
 * it catches is being on the wrong chain, before gas is spent.
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
  console.log(`chain ${chainId} — ${KNOWN_CHAINS[chainId]}`);

  const factoryCode = await publicClient.getCode({ address: PONS_FACTORY });
  if (!factoryCode || factoryCode === "0x") {
    // Not fatal on testnet, where Pons does not exist at all — but say so,
    // because a testnet deploy of this cannot be exercised against a real curve.
    console.log(
      `WARNING: no Pons factory at ${PONS_FACTORY} on this chain. ` +
        `Nothing here can be tested against a real curve.`,
    );
  }

  const adapter = await hre.viem.deployContract("PonsNativeTrade");
  const code = await publicClient.getCode({ address: adapter.address });
  if (!code || code === "0x") throw new Error("deployed but no code at the address — do NOT use this.");

  // VERIFY THE SHAPE, not just that something deployed. Two functions, and the
  // sell MUST be non-payable: that is the property the wall relies on to grant
  // the exit at valueLimit 0 alongside every other permission.
  const fns = adapter.abi.filter((f: { type: string }) => f.type === "function") as {
    name: string;
    stateMutability: string;
  }[];
  const names = fns.map((f) => f.name).sort();
  if (names.length !== 2 || names[0] !== "buyWithNative" || names[1] !== "sellForNative") {
    throw new Error(`unexpected ABI: ${names.join(", ")} — do NOT use this deployment.`);
  }
  const sell = fns.find((f) => f.name === "sellForNative")!;
  const buy = fns.find((f) => f.name === "buyWithNative")!;
  if (sell.stateMutability !== "nonpayable") {
    throw new Error("sellForNative is not non-payable — do NOT use this deployment.");
  }
  if (buy.stateMutability !== "payable") {
    throw new Error("buyWithNative is not payable — do NOT use this deployment.");
  }

  // Record it. The sibling script only printed its address, which is exactly why
  // "is the adapter deployed?" could not be answered from the repo.
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
    PonsNativeTrade: {
      address: adapter.address,
      deployedAt: new Date().toISOString(),
      codeBytes: (code.length - 2) / 2,
    },
  };
  writeFileSync(file, JSON.stringify(book, null, 2) + "\n");

  console.log("");
  console.log(`✓ PonsNativeTrade deployed at ${adapter.address}`);
  console.log(`  code : ${(code.length - 2) / 2} bytes`);
  console.log(`  recorded in contracts/deployments.json under chain ${chainKey} — COMMIT THIS`);
  console.log("");
  console.log("next steps:");
  console.log(`  1. paste ${adapter.address} into /settings as "native curve adapter"`);
  console.log("  2. RE-SIGN the grant at /grant — the address is sealed into the signature,");
  console.log("     so the setting alone changes nothing");
  console.log("  3. unset MERRYMEN_DEPLOYER_PRIVATE_KEY / close this shell");
  console.log("");
  console.log("what re-signing grants, and what it does NOT:");
  console.log("  - the EXIT (sellForNative) comes with the adapter, at valueLimit 0. The account");
  console.log("    sends no value; the curve pays it directly. An exit can only ADD native ETH.");
  console.log("  - the ENTRY (buyWithNative) needs a SEPARATE opt-in. It is the only permission");
  console.log("    in the wall that can move the account's native ETH, capped per call.");
  console.log("  - under gas sponsorship the account holds little or no ETH, so the entry both");
  console.log("    risks less and buys less. Consider whether you want it at all.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
