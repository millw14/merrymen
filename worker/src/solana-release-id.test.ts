/**
 * contracts/solana/scripts/check-release-id.mjs: the owner's local check, before
 * recording or deploying a release hash, that declare_id is the deploy key and
 * that the built program holds its 32 bytes (core/A3, release half). Tested
 * with the local test program id, which the source declares today.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { base58Decode } from "../../packages/core/src/ids";
import { SOLANA_VAULT_LOCAL_TEST_PROGRAM } from "../../packages/core/src/solana-live";

const SCRIPT = fileURLToPath(new URL("../../contracts/solana/scripts/check-release-id.mjs", import.meta.url));
const LIB_RS = fileURLToPath(new URL("../../contracts/solana/programs/merrymen-vault/src/lib.rs", import.meta.url));
type ReleaseCheck = {
  checkReleaseId(input: { publicKey: string; source: string; binary: Buffer }): { programId: string; bytes: number; sha256: string };
  ReleaseIdError: new (...args: never[]) => Error & { exitCode: number };
  DEFAULT_SOURCE: string;
};
const load = async () => await import(pathToFileURL(SCRIPT).href) as ReleaseCheck;
const dir = mkdtempSync(path.join(tmpdir(), "solana-release-id-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const ID = SOLANA_VAULT_LOCAL_TEST_PROGRAM, OTHER = "So11111111111111111111111111111111111111112";
const idBytes = (id: string) => Buffer.from(base58Decode(id)!);
/** A stand-in .so: ELF-ish bytes with `embedded` somewhere in the middle, as declare_id! leaves it. */
const built = (embedded?: string) => Buffer.concat([Buffer.from("\x7fELF fixture program text "), ...(embedded ? [idBytes(embedded)] : []), Buffer.alloc(64, 7)]);
function cli(args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

test("the source declares the local test program id today, and the script reads it from there by default", async () => {
  const { DEFAULT_SOURCE } = await load();
  assert.equal(path.resolve(DEFAULT_SOURCE), path.resolve(LIB_RS));
  assert.match(readFileSync(LIB_RS, "utf8"), new RegExp(`declare_id!\\("${ID}"\\);`));
});

test("a build whose declare_id is the deploy key and which holds its 32 bytes passes, with its size and SHA-256", async () => {
  const { checkReleaseId } = await load();
  const binary = built(ID);
  const result = checkReleaseId({ publicKey: ID, source: readFileSync(LIB_RS, "utf8"), binary });
  assert.equal(result.programId, ID); assert.equal(result.bytes, binary.length); assert.match(result.sha256, /^[0-9a-f]{64}$/);
  const so = path.join(dir, "good.so"); writeFileSync(so, binary);
  const run = cli([ID, "--so", so]);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, new RegExp(`OK: declare_id in .*lib\\.rs is ${ID}, the deploy key\\.`));
  assert.match(run.out, new RegExp(`OK: .*good\\.so \\(${binary.length} bytes, sha256 ${result.sha256}\\) holds its 32 bytes\\.`));
});

test("another deploy key, or a build that does not hold the key's bytes, is refused: do not record or deploy it", async () => {
  const { checkReleaseId, ReleaseIdError } = await load();
  const source = readFileSync(LIB_RS, "utf8");
  // The deploy key is not what the source declares. The argument is not echoed: only the declared id is named.
  assert.throws(() => checkReleaseId({ publicKey: OTHER, source, binary: built(OTHER) }), (error: unknown) =>
    error instanceof ReleaseIdError && /declare_id in the program source is EUzY.*not the public key you passed\..*Do not record or deploy/.test(error.message)
      && !error.message.includes(OTHER));
  // The source is right but the .so was built for another id (or from other source).
  for (const binary of [built(), built(OTHER), Buffer.alloc(0)]) {
    assert.throws(() => checkReleaseId({ publicKey: ID, source, binary }), ReleaseIdError);
  }
  // A key split across the binary is not "held": the 32 bytes must be contiguous, as declare_id! writes them.
  const key = idBytes(ID), split = Buffer.concat([key.subarray(0, 16), Buffer.from([0]), key.subarray(16)]);
  assert.throws(() => checkReleaseId({ publicKey: ID, source, binary: split }), /does not hold/);
  // No declare_id, or more than one, is never guessed at.
  for (const text of ["pub mod nothing {}", `declare_id!("${ID}");\ndeclare_id!("${ID}");`]) {
    assert.throws(() => checkReleaseId({ publicKey: ID, source: text, binary: built(ID) }), /exactly one declare_id/);
  }
  const so = path.join(dir, "foreign.so"); writeFileSync(so, built(OTHER));
  const run = cli([ID, "--so", so]);
  assert.equal(run.code, 1); assert.match(run.err, /^error: The built program does not hold .*Do not record or deploy this build\./);
  assert.equal(run.out, "");
});

test("it takes the public key only: a keypair file, its contents or a secret key are refused before any file is read, and never echoed", () => {
  const keypair = path.join(dir, "deploy-keypair.json");
  const secret = JSON.stringify(Array.from({ length: 64 }, (_, i) => (i * 37) % 256));
  writeFileSync(keypair, secret);
  // A 64-byte secret key in base58 (what some wallets export).
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${Buffer.alloc(64, 9).toString("hex")}`), secretBase58 = "";
  while (n > 0n) { secretBase58 = ALPHABET[Number(n % 58n)] + secretBase58; n /= 58n; }
  const missing = path.join(dir, "never-built.so");
  for (const [argument, why] of [[keypair, /looks like a keypair file/], ["deploy-keypair.json", /looks like a keypair file/], [secret, /looks like a keypair file/],
    [secretBase58, /64-byte secret key/], [`${ID}\n`, /spaces or line breaks/], ["not-base58-0OIl", /32 bytes of base58/], [ID.slice(0, 20), /32 bytes of base58/]] as const) {
    // The .so path does not exist: a refusal about the key proves nothing was opened first.
    const run = cli([argument, "--so", missing]);
    assert.equal(run.code, 2, argument.slice(0, 20));
    assert.match(run.err, why, argument.slice(0, 20));
    assert.ok(!run.err.includes(secret) && !run.err.includes(secretBase58) && !run.out.includes(secretBase58), "never echoed");
  }
  // A 32-byte secret seed pasted in base58 looks like a public key: about half of all seeds pass the
  // on-curve test, and the script cannot tell. When it is not the declared id it is refused unechoed.
  let seed = BigInt(`0x${Buffer.alloc(32, 0x5a).toString("hex")}`), seedBase58 = "";
  while (seed > 0n) { seedBase58 = ALPHABET[Number(seed % 58n)] + seedBase58; seed /= 58n; }
  const anySo = path.join(dir, "seed-check.so"); writeFileSync(anySo, built(seedBase58));
  const seeded = cli([seedBase58, "--so", anySo]);
  assert.equal(seeded.code, 1); assert.match(seeded.err, /not the public key you passed/);
  assert.ok(!seeded.err.includes(seedBase58) && !seeded.out.includes(seedBase58), "a pasted seed is never echoed");
  for (const args of [[], [ID, OTHER], [ID, "--so"], [ID, "--keypair", keypair]]) assert.equal(cli(args).code, 2, JSON.stringify(args));
  // A good key with a build that is not there: told to build first.
  const run = cli([ID, "--so", missing]);
  assert.equal(run.code, 1); assert.match(run.err, /Cannot read the built program .* build it with build\.sh first/);
});
