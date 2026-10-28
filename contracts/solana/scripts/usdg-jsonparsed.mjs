#!/usr/bin/env node
// Writes runtime-tests/fixtures/usdg-mainnet-mint.jsonparsed.json: the mainnet
// USDG mint bytes in runtime-tests/fixtures/usdg-mainnet-mint.json, and every
// variant of them listed there, as Agave's account decoder presents them in
// the jsonParsed encoding that getAccountInfo returns and the worker reads.
//
//   node contracts/solana/scripts/usdg-jsonparsed.mjs <agave release bin dir>
//
// Offline. solana-genesis writes a throwaway local genesis in a temporary
// directory whose primordial accounts are the variants (owner Token-2022, the
// fixture's lamports): the read bytes at the mint's own address, each other
// variant at an address derived from its index. agave-ledger-tool accounts
// --encoding jsonParsed then prints them through encode_ui_account, the code
// an RPC node runs for getAccountInfo with jsonParsed (a mint has no
// additional data there). No network, no RPC, no transaction. The bootstrap
// validator and the faucet are named by public key only and HOME is the
// temporary directory, so no keypair file is read or written. The tool's
// output is kept verbatim, so u64 values keep every digit.
//
// The tools must be the Agave release build.sh pins (AGAVE_VERSION).
// worker/src/solana-usdg-mint.test.ts runs the worker's mint screen on this
// output and checks its own decoding of the bytes against it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "..", "runtime-tests", "fixtures");
export const SOURCE = "usdg-mainnet-mint.json";
export const OUTPUT = "usdg-mainnet-mint.jsonparsed.json";
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let text = "";
  for (; n > 0n; n /= 58n) text = ALPHABET[Number(n % 58n)] + text;
  for (const b of bytes) {
    if (b !== 0) break;
    text = `1${text}`;
  }
  return text;
}
const sha256 = data => createHash("sha256").update(data).digest();
/** A fixed public key for a role, derived from no secret: nothing ever signs with it. */
export const roleKey = role => base58(sha256(`merrymen usdg jsonParsed ${role}`));

/** The read bytes changed by a variant's ops, in order, as custody.rs applies them; checked against its sha256. */
export function variantBytes(fixture, variant) {
  let data = Buffer.from(fixture.dataBase64, "base64");
  for (const op of variant.ops) {
    const bytes = Buffer.from(op.hex, "hex");
    if (op.op === "set") bytes.copy(data, op.at);
    else if (op.op === "append") data = Buffer.concat([data, bytes]);
    else throw new Error(`unknown op ${JSON.stringify(op.op)} in ${variant.name}`);
  }
  if (sha256(data).toString("hex") !== variant.sha256) throw new Error(`${variant.name}: bytes do not hash to its sha256`);
  return data;
}

/** Where each variant is placed: the read bytes at the mint's address, the others at a key from their index. */
export function variantAddresses(fixture) {
  return fixture.variants.map((variant, i) => ({
    name: variant.name,
    sha256: variant.sha256,
    address: i === 0 ? fixture.address : roleKey(`variant ${i}`),
  }));
}

function agaveVersion(bin, tool) {
  const line = execFileSync(path.join(bin, tool), ["--version"], { encoding: "utf8" }).trim();
  const pinned = /^AGAVE_VERSION="([^"]+)"$/m.exec(readFileSync(path.join(HERE, "..", "build.sh"), "utf8"))?.[1];
  if (!pinned || !line.startsWith(`${tool} ${pinned} `)) throw new Error(`need ${tool} ${pinned}, found: ${line}`);
  return line;
}

function main(argv) {
  if (argv.length !== 1) {
    console.error("usage: usdg-jsonparsed.mjs <agave release bin dir>");
    process.exit(2);
  }
  const bin = path.resolve(argv[0]);
  const fixture = JSON.parse(readFileSync(path.join(FIXTURES, SOURCE), "utf8"));
  if (fixture.variants?.[0]?.name !== "as read" || fixture.variants[0].ops.length !== 0) throw new Error("the first variant must be the read bytes");
  const genesisTool = agaveVersion(bin, "solana-genesis");
  const ledgerTool = agaveVersion(bin, "agave-ledger-tool");
  const placed = variantAddresses(fixture);
  const work = mkdtempSync(path.join(tmpdir(), "usdg-jsonparsed-"));
  try {
    const yaml = fixture.variants.flatMap((variant, i) => [
      `${placed[i].address}:`,
      `  balance: ${Number(fixture.lamports)}`,
      `  owner: ${fixture.owner}`,
      `  data: ${variantBytes(fixture, variant).toString("base64")}`,
      "  executable: false",
    ]);
    writeFileSync(path.join(work, "accounts.yml"), `${yaml.join("\n")}\n`);
    const env = { PATH: process.env.PATH ?? "", HOME: work };
    const run = (tool, args) => execFileSync(path.join(bin, tool), args,
      { cwd: work, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    run("solana-genesis", [
      "--ledger", path.join(work, "ledger"),
      "--bootstrap-validator", roleKey("identity"), roleKey("vote"), roleKey("stake"),
      "--faucet-pubkey", roleKey("faucet"), "--faucet-lamports", "1000000000",
      "--primordial-accounts-file", path.join(work, "accounts.yml"),
      "--cluster-type", "development", "--hashes-per-tick", "sleep",
    ]);
    const printed = run("agave-ledger-tool", [
      "accounts", "--ledger", path.join(work, "ledger"), "--encoding", "jsonParsed", "--output", "json",
      ...placed.flatMap(p => ["--account", p.address]),
    ]).trim();
    const accounts = JSON.parse(printed).accounts;
    for (const p of placed) {
      if (accounts.filter(a => a.pubkey === p.address).length !== 1) throw new Error(`the ledger tool did not print ${p.name} once`);
    }
    const head = {
      about: `The bytes of ${SOURCE} and each of its variants, as Agave's account decoder presents them in the jsonParsed encoding `
        + "(getAccountInfo's; a mint has no additional data there). Produced offline by contracts/solana/scripts/usdg-jsonparsed.mjs: "
        + "a throwaway local genesis held each variant as a primordial account at the address below, and agave-ledger-tool printed it. "
        + "No network, RPC, key or transaction. ledgerToolOutput is the tool's output verbatim. Regenerate it only with that script.",
      source: SOURCE,
      solanaGenesis: genesisTool,
      ledgerTool,
      command: "agave-ledger-tool accounts --encoding jsonParsed --output json",
      variants: placed,
    };
    const text = JSON.stringify(head, null, 2);
    writeFileSync(path.join(FIXTURES, OUTPUT), `${text.slice(0, -2)},\n  "ledgerToolOutput": ${printed}\n}\n`);
    console.log(`wrote ${path.join(FIXTURES, OUTPUT)} (${placed.length} variants)`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Real paths on both sides: run through a symlink, the plain comparison would skip main.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
