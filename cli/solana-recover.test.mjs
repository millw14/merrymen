import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";

const BIN = fileURLToPath(new URL("./bin.mjs", import.meta.url));
const PROGRAM = "EUzYVniKtgNNgFweMtRA9vciTWtE8MDTRfh6ai6VvXoU";
const RPC = "https://rpc.example.invalid/?api-key=cli-fixture-rpc-secret";
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`), out = "";
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; out = `1${out}`; }
  return out;
}
const SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 53 + 7) & 255);
const SECRET = base58(new Uint8Array([...SEED, ...ed25519.getPublicKey(SEED)]));
const OWNER = base58(ed25519.getPublicKey(SEED));

/** The real CLI and its real TS child. Every network attempt is recorded and refused. */
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "msr-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = path.join(directory, "home");
  const attempts = path.join(directory, "network-attempts");
  const guard = path.join(directory, "offline-guard.mjs");
  writeFileSync(guard, `
import { appendFileSync } from "node:fs";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
const refuse = (what) => { appendFileSync(${JSON.stringify(attempts)}, what + "\\n"); throw new Error("Network is disabled in this test"); };
globalThis.fetch = async (input, init) => refuse("fetch " + String(input) + " " + (init && init.body ? String(init.body) : ""));
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if ((typeof options === "object" && typeof options?.path === "string" && options.port === undefined) ||
      (typeof options === "string" && !/^[0-9]+$/.test(options))) return connect.apply(this, args);
  return refuse("socket");
};
syncBuiltinESMExports();
`);
  const env = { MERRYMEN_HOME: home, NODE_OPTIONS: `--import=${pathToFileURL(guard).href}`, NO_COLOR: "1" };
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  function run(args, input, extraEnv = {}) {
    const result = spawnSync(process.execPath, [BIN, "solana-recover", ...args], {
      cwd: directory, env: { ...env, ...extraEnv }, encoding: "utf8", shell: false, timeout: 30_000, maxBuffer: 1024 * 1024, input,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null);
    for (const text of [result.stdout, result.stderr]) {
      assert.ok(!text.includes(SECRET) && !text.includes(base58(SEED)), "the secret key was printed");
      assert.ok(!text.includes("cli-fixture-rpc-secret"), "the RPC URL's API key was printed");
    }
    return result;
  }
  return { home, run, attempts: () => existsSync(attempts) ? readFileSync(attempts, "utf8").trim().split("\n") : [] };
}

test("merrymen solana-recover help works offline and creates nothing", t => {
  const { home, run, attempts } = fixture(t);
  for (const args of [[], ["--help"]]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Solana vault recovery: withdraw everything from your Merrymen Solana vault/);
    assert.match(result.stdout, /never from the command line/);
    assert.match(result.stdout, /If someone sent you a command with --unlisted-program,\nstop: Merrymen never asks for it\./);
  }
  assert.equal(existsSync(home), false, "no EVM onboarding or home directory");
  assert.deepEqual(attempts(), []);
});

test("a key pasted into the arguments is refused without being echoed or used", t => {
  const { run, attempts } = fixture(t);
  for (const args of [["--program", PROGRAM, "--rpc", RPC, "--key", SECRET, "--send"], ["--program", PROGRAM, "--rpc", RPC, SECRET]]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /never from the command line.*clear it from your shell history/);
  }
  assert.deepEqual(attempts(), [], "refused before any network request");
});

test("the key reaches the recovery child through standard input, and is checked before any request", t => {
  const { run, attempts } = fixture(t);
  const unlisted = ["--program-sha256", "a".repeat(64), "--unlisted-program"];
  const bad = run(["--program", PROGRAM, "--rpc", RPC, "--key-file", "-", "--send", ...unlisted], "not a key\n");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /does not contain a Solana secret key/);
  assert.deepEqual(attempts(), []);
  const mismatch = run(["--program", PROGRAM, "--rpc", RPC, "--key-file", "-", "--owner", PROGRAM, "--send", ...unlisted], `${SECRET}\n`);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, new RegExp(`The key belongs to ${OWNER}`));
  assert.deepEqual(attempts(), []);
});

test("a send for a program that is not released is refused before any request", t => {
  const { run, attempts } = fixture(t);
  for (const extra of [[], ["--program-sha256", "a".repeat(64)], ["--unlisted-program"]]) {
    const result = run(["--program", PROGRAM, "--rpc", RPC, "--key-file", "-", "--send", ...extra], `${SECRET}\n`);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /is not a released Merrymen vault program \(none is released yet\)\. Nothing was signed or sent\./);
  }
  assert.deepEqual(attempts(), [], "refused before any network request");
});

test("with the network down, a send stops on a fixed message and only the supplied RPC is tried", t => {
  const { run, attempts } = fixture(t);
  // The documented path: the keyed URL from MERRYMEN_SOLANA_RECOVER_RPC, not the command line.
  const result = run(["--program", PROGRAM, "--key-file", "-", "--send", "--program-sha256", "a".repeat(64), "--unlisted-program"], `${SECRET}\n`,
    { MERRYMEN_SOLANA_RECOVER_RPC: RPC });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Solana read failed; check connectivity and endpoint configuration\.\n$/);
  const tried = attempts();
  assert.ok(tried.length > 0);
  for (const line of tried) {
    assert.ok(line.startsWith(`fetch ${RPC} `), "only the RPC the owner supplied");
    assert.doesNotMatch(line, /sendTransaction/, "nothing was submitted");
    assert.ok(!line.includes(SECRET), "the key never leaves the process");
  }
});

test("a keyed URL given with --rpc still works, with a warning that does not repeat it", t => {
  const { run, attempts } = fixture(t);
  const result = run(["--program", PROGRAM, "--rpc", RPC, "--owner", OWNER]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Warning: the --rpc URL looks like it carries an API key\. It is not printed.*MERRYMEN_SOLANA_RECOVER_RPC instead.*\nSolana read failed; check connectivity and endpoint configuration\.\n$/);
  assert.ok(attempts().length > 0 && attempts().every((line) => line.startsWith(`fetch ${RPC} `)));
});
