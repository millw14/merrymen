/**
 * INDEPENDENT POST-DEPLOY VERIFICATION OF A PonsClassVaultFactoryV2 ADDRESS.
 *
 *   npx tsx scripts/verify-classfactoryv2.mts 0x<factory> [--rpc url] [--owner 0x..]
 *
 * READ-ONLY AND KEYLESS. Every call is `eth_call` or `eth_getCode`. Nothing is
 * signed, no UserOperation is built, no private key is read from anywhere. It
 * may be run from any shell, including one that never held the deployer key.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS WHEN THE DEPLOY SCRIPT ALREADY GATES ITSELF
 *
 * contracts/scripts/deploy-ponsclassvaultfactoryv2.ts runs four gates in the
 * SAME PROCESS that did the deploy, and reports the result as console output.
 * Every one of those gates is therefore a claim by the process under test. A
 * script with a wrong QUOTES row, a mis-set env var, a bad merge, or an edit
 * made between compile and run produces exactly the same green output. And the
 * factory is immutable: no setter, no admin, no upgrade. There is no second
 * chance to notice.
 *
 * So this re-establishes the same facts from the chain, from a separate
 * process, from different sources:
 *
 *   - the factory's own deployed bytecode is compared to the compiled artifact,
 *     which the deploy script never does (it only checks code != "0x")
 *   - the seed is decoded back into DOLLARS from packages/core's token registry
 *     and each asset's own live feed, so the operator reads the ceiling as money
 *     rather than as a 17-digit raw integer
 *   - the vault init code hash is RECOMPUTED locally from the on-chain seed and
 *     the local artifact, and the CREATE2 address is recomputed from that hash,
 *     rather than trusting the factory's own `vaultInitCodeHash`
 *   - `deploy()` is simulated for the REAL owners who will use this factory —
 *     the deploy script only ever simulated it for the deployer EOA
 *
 * The quote table comes from packages/core/src/tokens.ts, NOT from the deploy
 * script's own duplicated QUOTES map. Checking a table against itself proves
 * nothing; the point is that two independently maintained lists agree.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  concat,
  createPublicClient,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  type Address,
} from "viem";
import { robinhoodChain } from "../packages/core/src/chain";
import { CASH, STOCK_TOKENS, TRADEABLE_SYMBOLS, USDG_DECIMALS } from "../packages/core/src/tokens";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

/** Shogun's smart account — the canary, and the address the signer passes to
 *  `vaultFor` (web/src/lib/session.ts:536 passes `sudoOnlyAccount.address`).
 *  Source: scripts/probe-kernel-batch-atomicity.mts:52. */
const SHOGUN: Address = "0x05a198A677Fbcd8f5c168d397Fa7ef5eB6D65487";
/** A second and third owner, so `vaultFor` is shown to be a function of the
 *  owner and not a constant. Simulating `deploy` for them is an `eth_call` and
 *  consumes nothing. */
const EXTRA_OWNERS: Address[] = [
  "0x000000000000000000000000000000000000dEaD",
  "0x1111111111111111111111111111111111111111",
];

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : fallback;
};
const argAll = (name: string) => {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--")) out.push(process.argv[i + 1]!);
  });
  return out;
};

const positional = process.argv.slice(2).find((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
if (!positional) {
  console.error("usage: npx tsx scripts/verify-classfactoryv2.mts 0x<factory> [--rpc url] [--owner 0x..]");
  process.exit(2);
}
const FACTORY = getAddress(positional);
const RPC = arg("rpc", process.env.MERRYMEN_RPC_MAINNET ?? robinhoodChain.rpcUrls.default.http[0])!;
const client = createPublicClient({ chain: robinhoodChain, transport: http(RPC) });

const FACTORY_ABI = parseAbi([
  "function FACTORY_VERSION() view returns (uint8)",
  "function vaultFor(address) view returns (address)",
  "function vaultInitCodeHash(address) view returns (bytes32)",
  "function seedQuoteSet() view returns (address[], uint256[])",
  "function deploy(address) returns (address)",
]);
const TOKEN_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function uiMultiplier() view returns (uint256)",
  "function tokenPaused() view returns (bool)",
]);
const FEED_ABI = parseAbi([
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);

const UI_ONE = 10n ** 18n;
const MAX_CAP = 2n ** 96n - 1n;
const MAX_QUOTES = 8;
const FEED_STALE_AFTER_SEC = 2 * 3600;

let failures = 0;
let warnings = 0;
const ok = (s: string) => console.log(`  PASS  ${s}`);
const bad = (s: string) => {
  failures++;
  console.log(`  FAIL  ${s}`);
};
const warn = (s: string) => {
  warnings++;
  console.log(`  WARN  ${s}`);
};

/** The inverse of scripts/lib/quote-caps.ts `rawCapFor`, to six decimal places.
 *  Rounds the same way the forward direction does, so a cap sealed from this
 *  exact price and multiplier decodes back to the dollar figure that was typed,
 *  less at most one micro-dollar of the forward division's truncation. */
function dollarsForRaw(raw: bigint, decimals: number, price8: bigint, uiMultiplier: bigint): number {
  return Number((raw * price8 * uiMultiplier * 1_000_000n) / (10n ** BigInt(decimals) * 100_000_000n * UI_ONE)) / 1e6;
}

function artifact(name: "PonsClassVaultV2" | "PonsClassVaultFactoryV2") {
  const p = path.join(REPO, "contracts", "artifacts", "contracts", "PonsClassVaultV2.sol", `${name}.json`);
  return JSON.parse(readFileSync(p, "utf8")) as { bytecode: `0x${string}`; deployedBytecode: `0x${string}` };
}

/** packages/core's own view of a quote asset, which is the list the wall, the
 *  producer and the ledger all read. Deliberately not the deploy script's map. */
function registryFor(addr: Address): { symbol: string; feed: Address | null } | null {
  if (addr.toLowerCase() === CASH.USDG.toLowerCase()) return { symbol: "USDG", feed: null };
  if (addr.toLowerCase() === CASH.WETH.toLowerCase()) return { symbol: "WETH", feed: null };
  const s = STOCK_TOKENS.find((t) => t.address.toLowerCase() === addr.toLowerCase());
  return s ? { symbol: s.symbol, feed: (s.chainlinkFeed as Address | null) ?? null } : null;
}

async function main() {
  const chainId = await client.getChainId();
  console.log("");
  console.log(`VERIFYING PonsClassVaultFactoryV2 at ${FACTORY}`);
  console.log(`  chain ${chainId} via ${RPC}`);
  console.log(`  ${new Date().toISOString()}`);
  console.log("");

  if (chainId !== 4663 && chainId !== 46630) bad(`unknown chain ${chainId} — check --rpc`);

  // ── 1. CODE, AND WHOSE CODE ──────────────────────────────────────────────
  console.log("1. bytecode");
  const code = await client.getCode({ address: FACTORY });
  if (!code || code === "0x") {
    bad(`${FACTORY} has NO CODE. Nothing else below can mean anything.`);
    return verdict();
  }
  const size = (code.length - 2) / 2;
  ok(`code present, ${size} bytes`);
  const fArt = artifact("PonsClassVaultFactoryV2");
  const expected = (fArt.deployedBytecode.length - 2) / 2;
  if (code.toLowerCase() === fArt.deployedBytecode.toLowerCase()) {
    ok(`deployed bytecode is byte-identical to the locally compiled artifact (${expected} bytes)`);
  } else {
    bad(
      `deployed bytecode DIFFERS from the local artifact (on chain ${size} bytes, local ${expected}). ` +
        `This working tree did not compile what is deployed. Recompile (cd contracts && npx hardhat compile) ` +
        `and re-run before concluding anything — a stale artifact reads the same as a foreign factory.`,
    );
  }

  // ── 2. VERSION ───────────────────────────────────────────────────────────
  console.log("");
  console.log("2. version");
  let version: number | null = null;
  try {
    version = Number(await client.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: "FACTORY_VERSION" }));
  } catch {
    bad("FACTORY_VERSION REVERTS — that is what a v1 factory looks like. Do NOT pin this as v2.");
  }
  if (version !== null) {
    if (version === 2) ok("FACTORY_VERSION == 2");
    else bad(`FACTORY_VERSION answered ${version}, not 2`);
  }

  // ── 3. THE SEED, READ BACK AS MONEY ──────────────────────────────────────
  console.log("");
  console.log("3. seed quote set");
  let quotes: readonly Address[] = [];
  let caps: readonly bigint[] = [];
  try {
    const seed = (await client.readContract({
      address: FACTORY, abi: FACTORY_ABI, functionName: "seedQuoteSet",
    })) as readonly [readonly Address[], readonly bigint[]];
    quotes = seed[0];
    caps = seed[1];
  } catch (e) {
    bad(`seedQuoteSet() would not read (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`);
    return verdict();
  }
  if (quotes.length !== caps.length) bad(`${quotes.length} assets but ${caps.length} caps`);
  if (quotes.length === 0) bad("EMPTY SEED — every vault this factory makes can buy nothing");
  if (quotes.length > MAX_QUOTES) bad(`${quotes.length} quotes, past the vault's MAX_QUOTES of ${MAX_QUOTES}`);
  const seen = new Set<string>();
  for (const q of quotes) {
    const k = q.toLowerCase();
    if (seen.has(k)) bad(`DUPLICATE seed quote ${q} — every deploy() reverts, for every owner, for ever`);
    seen.add(k);
  }
  const now = Math.floor(Date.now() / 1000);
  const decoded: { symbol: string; address: Address; raw: bigint; usd: number | null }[] = [];

  for (let i = 0; i < quotes.length; i++) {
    const addr = quotes[i]!;
    const raw = caps[i]!;
    const reg = registryFor(addr);
    if (!reg) {
      bad(`seed asset ${addr} is in NO packages/core registry entry — the wall and the producer do not know it`);
      decoded.push({ symbol: "?", address: addr, raw, usd: null });
      continue;
    }
    if (raw === 0n) bad(`${reg.symbol}: cap is ZERO, and in this vault zero means refused`);
    if (raw > MAX_CAP) bad(`${reg.symbol}: cap ${raw} is past the vault's uint96 slot — every deploy() reverts`);

    let dp: number;
    try {
      dp = Number(await client.readContract({ address: addr, abi: TOKEN_ABI, functionName: "decimals" }));
    } catch {
      bad(`${reg.symbol} at ${addr}: decimals() would not read — is this an ERC-20?`);
      decoded.push({ symbol: reg.symbol, address: addr, raw, usd: null });
      continue;
    }

    if (reg.feed === null) {
      if (reg.symbol === "USDG" && dp !== USDG_DECIMALS) bad(`USDG reports ${dp} decimals, not ${USDG_DECIMALS}`);
      const usd = dollarsForRaw(raw, dp, 100_000_000n, UI_ONE);
      decoded.push({ symbol: reg.symbol, address: addr, raw, usd });
      console.log(`        ${reg.symbol.padEnd(6)} cap ${raw.toString().padStart(20)} raw  =  $${usd.toFixed(2)}  (${dp}dp, a dollar by definition)`);
      continue;
    }

    const round = (await client.readContract({ address: reg.feed, abi: FEED_ABI, functionName: "latestRoundData" })) as
      readonly [bigint, bigint, bigint, bigint, bigint];
    const price8 = round[1];
    const ageMin = Math.round((now - Number(round[3])) / 60);
    const ui = (await client.readContract({ address: addr, abi: TOKEN_ABI, functionName: "uiMultiplier" })) as bigint;
    const paused = (await client.readContract({ address: addr, abi: TOKEN_ABI, functionName: "tokenPaused" })) as boolean;
    const usd = price8 > 0n && ui > 0n ? dollarsForRaw(raw, dp, price8, ui) : null;
    decoded.push({ symbol: reg.symbol, address: addr, raw, usd });
    console.log(
      `        ${reg.symbol.padEnd(6)} cap ${raw.toString().padStart(20)} raw  =  ` +
        `${usd === null ? "?" : "$" + usd.toFixed(2)}  ` +
        `(${(Number(raw) / 10 ** dp).toFixed(6)} shares @ $${(Number(price8) / 1e8).toFixed(2)}, ` +
        `multiplier ${ui === UI_ONE ? "1.0" : ui.toString()}, feed ${ageMin}m old${paused ? ", PAUSED" : ""})`,
    );
    // The decode is only as good as the price it decodes with. Say so.
    if (now - Number(round[3]) > FEED_STALE_AFTER_SEC) {
      warn(
        `${reg.symbol}'s feed is ${ageMin}m old, past the ${FEED_STALE_AFTER_SEC / 3600}h rule — the dollar figure ` +
          `above is what this cap is worth AT A STALE PRICE, not at a price anyone can trade`,
      );
    }
    if (paused) warn(`${reg.symbol} is PAUSED by its issuer right now`);
    // A seed entry for an asset with no pool is a ceiling for a leg that cannot
    // be entered or exited. packages/core/src/tokens.ts:208-211 lists the ones
    // with no v3 pool at all (META among them), and worker/src/policy.ts refuses
    // a buy whose sell the key cannot sign — so the cap would simply never bind.
    if (!(TRADEABLE_SYMBOLS as readonly string[]).includes(reg.symbol)) {
      warn(
        `${reg.symbol} is NOT in TRADEABLE_SYMBOLS — it has no verified v3 pool in either direction, ` +
          `so this seed slot is a ceiling for a leg nothing can route`,
      );
    }
  }

  // The one structural rule the signer itself enforces (web/src/lib/session.ts:516-530).
  const usdgIdx = quotes.findIndex((q) => q.toLowerCase() === CASH.USDG.toLowerCase());
  if (usdgIdx < 0) {
    bad(
      "the seed carries NO USDG cap. The wall only ever permits a class buy funded in USDG, so every buy " +
        "would revert QuoteNotApproved AFTER the approve leg had landed. The signer refuses this factory.",
    );
  } else if (caps[usdgIdx] === 0n) {
    bad("the seed carries USDG at a cap of ZERO, which in this vault is how an asset is refused. The signer refuses this factory.");
  } else {
    ok(`USDG is seeded at $${decoded[usdgIdx]?.usd?.toFixed(2) ?? "?"} — the route the fleet already uses stays open`);
  }

  // ── 4. AGAINST THE DEPLOY'S OWN RECORD ───────────────────────────────────
  console.log("");
  console.log("4. against contracts/deployments.json");
  try {
    const book = JSON.parse(readFileSync(path.join(REPO, "contracts", "deployments.json"), "utf8")) as Record<
      string, Record<string, { address?: string; seed?: { symbol: string; usd: number; address: string; capRaw: string }[] }>
    >;
    const rec = book[String(chainId)]?.PonsClassVaultFactoryV2;
    if (!rec?.address) {
      warn(`no PonsClassVaultFactoryV2 record for chain ${chainId} — the deploy script did not get as far as writing one`);
    } else if (rec.address.toLowerCase() !== FACTORY.toLowerCase()) {
      bad(`deployments.json records ${rec.address}, NOT the address being verified. One of the two is not what you deployed.`);
    } else {
      ok("deployments.json names this exact address");
      for (const r of rec.seed ?? []) {
        const i = quotes.findIndex((q) => q.toLowerCase() === r.address.toLowerCase());
        if (i < 0) bad(`the record claims a ${r.symbol} cap, but the chain's seed has no such asset`);
        else if (caps[i]!.toString() !== r.capRaw) {
          bad(`${r.symbol}: recorded capRaw ${r.capRaw} but the chain holds ${caps[i]}`);
        } else {
          const drift = decoded[i]?.usd;
          console.log(
            `        ${r.symbol.padEnd(6)} sealed as $${r.usd} at deploy time; worth ` +
              `${drift === null || drift === undefined ? "?" : "$" + drift.toFixed(2)} at the price right now`,
          );
        }
      }
      if ((rec.seed ?? []).length !== quotes.length) {
        bad(`the record lists ${(rec.seed ?? []).length} seed entries, the chain holds ${quotes.length}`);
      }
    }
  } catch {
    warn("contracts/deployments.json is unreadable or absent");
  }

  // ── 5. ADDRESS PREDICTION, RE-DERIVED LOCALLY ────────────────────────────
  console.log("");
  console.log("5. vault address prediction");
  const vaultArt = artifact("PonsClassVaultV2");
  const owners: Address[] = [
    SHOGUN,
    ...argAll("owner").map((o) => getAddress(o)),
    ...EXTRA_OWNERS,
  ].filter((o, i, a) => a.findIndex((x) => x.toLowerCase() === o.toLowerCase()) === i);

  let shogunVault: Address | null = null;
  for (const owner of owners) {
    const label = owner.toLowerCase() === SHOGUN.toLowerCase() ? `${owner} (Shogun)` : owner;

    const predicted = (await client.readContract({
      address: FACTORY, abi: FACTORY_ABI, functionName: "vaultFor", args: [owner],
    })) as Address;
    if (/^0x0{40}$/i.test(predicted)) {
      bad(`vaultFor(${label}) answered the zero address`);
      continue;
    }

    // Recomputed here rather than read: keccak(vault creationCode ++ abi.encode(owner, quotes, caps)).
    const localHash = keccak256(
      concat([
        vaultArt.bytecode,
        encodeAbiParameters(
          [{ type: "address" }, { type: "address[]" }, { type: "uint256[]" }],
          [owner, quotes as Address[], caps as bigint[]],
        ),
      ]),
    );
    const onChainHash = (await client.readContract({
      address: FACTORY, abi: FACTORY_ABI, functionName: "vaultInitCodeHash", args: [owner],
    })) as `0x${string}`;
    if (onChainHash.toLowerCase() !== localHash.toLowerCase()) {
      bad(
        `vaultInitCodeHash(${label}) is ${onChainHash} but this tree's artifact and the chain's own seed ` +
          `hash to ${localHash} — the factory will CREATE2 bytecode nobody here compiled`,
      );
    }

    // And the CREATE2 address computed from OUR hash, not from the factory's.
    const salt = `0x${owner.slice(2).toLowerCase().padStart(64, "0")}` as `0x${string}`;
    const localAddr = getAddress(
      `0x${keccak256(concat(["0xff", FACTORY, salt, localHash])).slice(-40)}`,
    );
    if (localAddr.toLowerCase() !== predicted.toLowerCase()) {
      bad(`vaultFor(${label}) says ${predicted}, but CREATE2 recomputed locally is ${localAddr}`);
    }

    // The gate the deploy script only ran for the deployer EOA: does deploy()
    // actually WORK for this owner, and does it land where vaultFor promised?
    // eth_call, so the vault is created in a simulated state and discarded.
    let simulated: Address | null = null;
    try {
      const res = await client.call({
        to: FACTORY,
        data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "deploy", args: [owner] }),
      });
      simulated = decodeFunctionResult({ abi: FACTORY_ABI, functionName: "deploy", data: res.data! }) as Address;
    } catch (e) {
      bad(
        `deploy(${label}) REVERTS (${e instanceof Error ? e.message.split("\n")[0] : String(e)}). ` +
          `The seed is the only thing a vault is given, so this is the seed — and it is unfixable.`,
      );
    }
    if (simulated && simulated.toLowerCase() !== predicted.toLowerCase()) {
      bad(`deploy(${label}) would produce ${simulated} but vaultFor predicts ${predicted}`);
    }

    const existing = await client.getCode({ address: predicted });
    const note = existing && existing !== "0x" ? ` [ALREADY DEPLOYED, ${(existing.length - 2) / 2} bytes]` : "";
    if (simulated && simulated.toLowerCase() === predicted.toLowerCase() && localAddr.toLowerCase() === predicted.toLowerCase()) {
      ok(`vaultFor(${label}) = ${predicted} — predicted, recomputed and simulated all agree${note}`);
    }
    if (owner.toLowerCase() === SHOGUN.toLowerCase()) shogunVault = predicted;
  }

  if (shogunVault) {
    console.log("");
    console.log("   THE NUMBER TO CHECK AFTER RE-SIGNING:");
    console.log(`     Shogun ${SHOGUN}`);
    console.log(`     vault  ${shogunVault}`);
    console.log("     The grant must seal exactly this. worker/src/enable-class.ts:238 compares the");
    console.log("     sealed vault against the one the factory derives and refuses on any difference.");
  }

  return verdict();
}

function verdict() {
  console.log("");
  if (failures === 0 && warnings === 0) {
    console.log(`VERDICT: PASS — ${FACTORY} is a v2 factory this working tree compiled, its seed decodes to`);
    console.log("         the money it was meant to be, and its vault prediction is provable three ways.");
    console.log("         Safe to pin in PONS_CLASS_VAULT_FACTORY_V2 and re-sign against.");
  } else if (failures === 0) {
    console.log(`VERDICT: PASS WITH ${warnings} WARNING(S) — read them above before pinning. A warning is`);
    console.log("         usually a stale feed, which makes the dollar figures approximate, not the caps wrong.");
  } else {
    console.log(`VERDICT: FAIL — ${failures} check(s) failed. DO NOT pin this address in`);
    console.log("         packages/core/src/protocols.ts and DO NOT re-sign any grant against it.");
    console.log("         The factory is immutable; the only remedy is a different deploy.");
  }
  console.log("");
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
