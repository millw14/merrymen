#!/usr/bin/env node
// Owner release step (core/A3, release half): run this locally before recording
// or deploying a release hash of the vault program.
//
//   node contracts/solana/scripts/check-release-id.mjs <program public key> [--so <path>] [--source <path>]
//
// <program public key> is the deploy keypair's PUBLIC key, as printed by
// `solana-keygen pubkey <keypair file>`. Never pass the keypair file or its
// contents: this script refuses anything that looks like one and reads no key
// material. It checks, and exits non-zero unless both hold:
//   1. declare_id!("...") in the program source (default
//      programs/merrymen-vault/src/lib.rs) is exactly that public key, and
//   2. the built program (default target/deploy/merrymen_vault.so, from
//      build.sh) holds that key's 32 bytes, as declare_id! embeds them.
// A binary built for any other id fails every instruction once deployed at
// that address, and an immutable deployment can never be fixed. CI has no
// deploy keypair, so it cannot make this check; it checks lib.rs against
// Anchor.toml and the id's bytes against the .so it built.
//
// It reads two local files and makes no network call. Node built-ins only.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SOURCE = path.join(HERE, "..", "programs", "merrymen-vault", "src", "lib.rs");
export const DEFAULT_SO = path.join(HERE, "..", "target", "deploy", "merrymen_vault.so");
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export class ReleaseIdError extends Error {
  constructor(message, exitCode = 1) { super(message); this.name = "ReleaseIdError"; this.exitCode = exitCode; }
}

/** Base58 to bytes, or null when the text is not canonical base58. */
export function base58Decode(text) {
  if (typeof text !== "string" || !text.length || text.length > 128) return null;
  let value = 0n;
  for (const char of text) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  const bytes = [];
  while (value > 0n) { bytes.unshift(Number(value % 256n)); value /= 256n; }
  for (const char of text) { if (char !== "1") break; bytes.unshift(0); }
  return Buffer.from(bytes);
}

/**
 * The deploy keypair's public key as 32 bytes. Anything that looks like the
 * keypair itself (a file path, a JSON byte array, a 64-byte secret key) is
 * refused before it is used, and never echoed.
 */
export function releasePublicKey(argument) {
  if (typeof argument !== "string" || !argument.length) throw new ReleaseIdError("Pass the program's public key: solana-keygen pubkey <deploy keypair file>.", 2);
  if (/\s/.test(argument)) throw new ReleaseIdError("The public key must not contain spaces or line breaks.", 2);
  if (/[\\/[\],{}"]/.test(argument) || /\.json$/i.test(argument)) {
    throw new ReleaseIdError("That looks like a keypair file or its contents. Pass only the public key, as printed by `solana-keygen pubkey <deploy keypair file>`; this check never needs the keypair. Nothing was read.", 2);
  }
  const bytes = base58Decode(argument);
  if (bytes && bytes.length === 64) throw new ReleaseIdError("That is a 64-byte secret key, not a public key. Never paste it anywhere; pass the output of `solana-keygen pubkey` instead.", 2);
  if (!bytes || bytes.length !== 32) throw new ReleaseIdError("The program public key must be 32 bytes of base58, as printed by `solana-keygen pubkey`.", 2);
  return bytes;
}

/** The one declare_id!("…") in the program source, or a refusal. */
export function declaredProgramId(source) {
  const found = [...source.matchAll(/\bdeclare_id!\s*\(\s*"([^"]*)"\s*\)/g)].map((match) => match[1]);
  if (found.length !== 1) throw new ReleaseIdError(`The program source must hold exactly one declare_id!("…"); it holds ${found.length}.`);
  return found[0];
}

/**
 * Both checks, from the public key and the two files' contents. Returns what
 * the owner records; throws ReleaseIdError when either does not hold.
 */
export function checkReleaseId({ publicKey, source, binary }) {
  const key = releasePublicKey(publicKey);
  const declared = declaredProgramId(source);
  // The argument is never echoed: a pasted 32-byte secret seed in base58 looks like a public
  // key. Only the declared id, which comes from the public source, is named; once it equals
  // the argument, naming it names nothing new.
  if (declared !== publicKey) {
    throw new ReleaseIdError(`declare_id in the program source is ${declared}, not the public key you passed. Set declare_id! (and Anchor.toml) to the deploy key, rebuild with build.sh, and check again. Do not record or deploy this build.`);
  }
  if (!Buffer.isBuffer(binary) || !binary.length) throw new ReleaseIdError("The built program is empty or missing; build it with build.sh first.");
  if (binary.indexOf(key) < 0) {
    throw new ReleaseIdError(`The built program does not hold ${declared}'s 32 bytes, so it was not built from this source's declare_id. Rebuild with build.sh, and check again. Do not record or deploy this build.`);
  }
  return { programId: publicKey, bytes: binary.length, sha256: createHash("sha256").update(binary).digest("hex") };
}

function parseArgs(argv) {
  const options = { source: DEFAULT_SOURCE, so: DEFAULT_SO };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--so" || arg === "--source") {
      if (i + 1 >= argv.length) throw new ReleaseIdError(`${arg} needs a path.`, 2);
      options[arg.slice(2)] = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      throw new ReleaseIdError("Usage: check-release-id.mjs <program public key> [--so <merrymen_vault.so>] [--source <lib.rs>]", 2);
    } else if (arg.startsWith("--")) {
      throw new ReleaseIdError(`Unknown option ${arg.split("=")[0]}.`, 2);
    } else positional.push(arg);
  }
  if (positional.length !== 1) throw new ReleaseIdError("Pass exactly one program public key: solana-keygen pubkey <deploy keypair file>.", 2);
  return { publicKey: positional[0], ...options };
}

export function main(argv = process.argv.slice(2), io = { out: (line) => process.stdout.write(`${line}\n`), err: (line) => process.stderr.write(`${line}\n`) }) {
  try {
    const { publicKey, source, so } = parseArgs(argv);
    // The key first: a pasted keypair is refused before any file is opened.
    releasePublicKey(publicKey);
    let sourceText, binary;
    try { sourceText = readFileSync(source, "utf8"); } catch { throw new ReleaseIdError(`Cannot read the program source at ${source}.`); }
    try { binary = readFileSync(so); } catch { throw new ReleaseIdError(`Cannot read the built program at ${so}; build it with build.sh first.`); }
    const result = checkReleaseId({ publicKey, source: sourceText, binary });
    io.out(`OK: declare_id in ${source} is ${result.programId}, the deploy key.`);
    io.out(`OK: ${so} (${result.bytes} bytes, sha256 ${result.sha256}) holds its 32 bytes.`);
    io.out("This .so's SHA-256 is the deployed binary's only if ProgramData holds exactly these bytes (deployed without extra --max-len).");
    return 0;
  } catch (error) {
    if (!(error instanceof ReleaseIdError)) throw error;
    io.err(`error: ${error.message}`);
    return error.exitCode;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
