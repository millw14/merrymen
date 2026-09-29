import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { hostedPerpKeyFile, loadPerpPrivateKey, perpKeyFileFor, perpKeySecretForms, perpKeysDir, PerpKeystoreError, writePerpKeyFile, type PerpKeyPair } from "./keystore";
import { redactSecrets } from "../telegram/agent";

const ROOT = mkdtempSync(path.join(os.tmpdir(), "merrymen-perp-keystore-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const home = () => {
  const h = path.join(ROOT, `home-${n++}`);
  mkdirSync(h, { recursive: true });
  return h;
};

/** Canonical 40-byte keys: five little-endian limbs, each small (< p). */
const pub = (b: number) => `0x${(b.toString(16).padStart(2, "0") + "00".repeat(7)).repeat(5)}` as `0x${string}`;
const priv = (b: number) => `0x${b.toString(16).padStart(2, "0").repeat(40)}` as `0x${string}`;
const PAIR: PerpKeyPair = { privateKey: priv(0xab), publicKey: pub(1) };
const POSIX = process.platform !== "win32";

function throwsReason(fn: () => unknown, reason: string, secret?: string): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof PerpKeystoreError, String(e));
    assert.equal(e.reason, reason, e.message);
    if (secret !== undefined) assert.ok(!e.message.includes(secret.slice(2, 20)), "the key leaked into an error");
    return true;
  });
}

test("write then load: 0600, keyed by the public key, round-trips", () => {
  const h = home();
  const file = writePerpKeyFile(h, PAIR);
  assert.equal(file, path.join(perpKeysDir(h), `${PAIR.publicKey.slice(2)}.json`));
  assert.equal(file, perpKeyFileFor(h, PAIR.publicKey.toUpperCase().replace("0X", "0x")));
  if (POSIX) {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(perpKeysDir(h)).mode & 0o077, 0);
  }
  assert.deepEqual(loadPerpPrivateKey({ home: h, apiPublicKey: PAIR.publicKey }), PAIR);
  // No temp files left behind.
  assert.deepEqual(readdirSync(perpKeysDir(h)), [path.basename(file)]);
});

test("writing the same pair again is a no-op; a different key for the same public key is refused", () => {
  const h = home();
  const file = writePerpKeyFile(h, PAIR);
  const before = readFileSync(file, "utf8");
  assert.equal(writePerpKeyFile(h, PAIR), file);
  throwsReason(() => writePerpKeyFile(h, { privateKey: priv(0xcd), publicKey: PAIR.publicKey }), "conflict", priv(0xcd));
  assert.equal(readFileSync(file, "utf8"), before);
  assert.deepEqual(loadPerpPrivateKey({ home: h, apiPublicKey: PAIR.publicKey }), PAIR);
});

test("write refuses malformed pairs without echoing them", () => {
  const h = home();
  throwsReason(() => writePerpKeyFile(h, { privateKey: "0x1234" as `0x${string}`, publicKey: PAIR.publicKey }), "malformed");
  throwsReason(() => writePerpKeyFile(h, { privateKey: `0x${"0".repeat(80)}`, publicKey: PAIR.publicKey }), "malformed");
  throwsReason(() => writePerpKeyFile(h, { privateKey: PAIR.privateKey, publicKey: `0x${"ff".repeat(40)}` }), "malformed", PAIR.privateKey);
  assert.equal(existsSync(perpKeysDir(h)), false);
});

test("the hosted child's perp-key.json is read when there is no self-hosted file", () => {
  const h = home();
  writeFileSync(hostedPerpKeyFile(h), JSON.stringify(PAIR), { mode: 0o600 });
  assert.deepEqual(loadPerpPrivateKey({ home: h, apiPublicKey: PAIR.publicKey }), PAIR);
  // Upper-case hex in the file is normalised; the pairing is what matters.
  writeFileSync(hostedPerpKeyFile(h), JSON.stringify({ privateKey: PAIR.privateKey.toUpperCase().replace("0X", "0x"), publicKey: PAIR.publicKey.toUpperCase().replace("0X", "0x") }), { mode: 0o600 });
  assert.deepEqual(loadPerpPrivateKey({ home: h, apiPublicKey: PAIR.publicKey }), PAIR);
});

test("a key file for another public key is refused — the sealed key decides", () => {
  const h = home();
  writeFileSync(hostedPerpKeyFile(h), JSON.stringify({ privateKey: PAIR.privateKey, publicKey: pub(2) }), { mode: 0o600 });
  throwsReason(() => loadPerpPrivateKey({ home: h, apiPublicKey: PAIR.publicKey }), "pubkey-mismatch", PAIR.privateKey);
  // Even under the right file name.
  mkdirSync(perpKeysDir(h), { recursive: true });
  writeFileSync(perpKeyFileFor(h, PAIR.publicKey), JSON.stringify({ privateKey: PAIR.privateKey, publicKey: pub(3) }), { mode: 0o600 });
  throwsReason(() => loadPerpPrivateKey({ home: h, apiPublicKey: PAIR.publicKey }), "pubkey-mismatch", PAIR.privateKey);
});

test("group- or world-readable key files are refused, with the fix", { skip: !POSIX }, () => {
  const h = home();
  const file = writePerpKeyFile(h, PAIR);
  const warn = console.warn;
  const said: string[] = [];
  console.warn = (...a: unknown[]) => void said.push(a.join(" "));
  try {
    for (const mode of [0o640, 0o604, 0o644, 0o660]) {
      chmodSync(file, mode);
      throwsReason(() => loadPerpPrivateKey({ home: h, apiPublicKey: PAIR.publicKey }), "insecure-mode", PAIR.privateKey);
    }
  } finally {
    console.warn = warn;
  }
  assert.ok(said.some((s) => s.includes(`chmod 600 ${file}`)));
  assert.ok(said.every((s) => !s.includes(PAIR.privateKey.slice(2, 20))));
  chmodSync(file, 0o600);
  assert.deepEqual(loadPerpPrivateKey({ home: h, apiPublicKey: PAIR.publicKey }), PAIR);
  chmodSync(file, 0o400);
  assert.deepEqual(loadPerpPrivateKey({ home: h, apiPublicKey: PAIR.publicKey }), PAIR);
});

test("a symlinked key file is refused", { skip: !POSIX }, () => {
  const h = home();
  const elsewhere = path.join(ROOT, `elsewhere-${n++}.json`);
  writeFileSync(elsewhere, JSON.stringify(PAIR), { mode: 0o600 });
  symlinkSync(elsewhere, hostedPerpKeyFile(h));
  throwsReason(() => loadPerpPrivateKey({ home: h, apiPublicKey: PAIR.publicKey }), "not-a-file");
});

test("malformed files are refused, and the parser's message (which quotes the file) never surfaces", () => {
  const h = home();
  const file = hostedPerpKeyFile(h);
  const put = (text: string) => writeFileSync(file, text, { mode: 0o600 });
  put(`{"privateKey": "${PAIR.privateKey}", "publicKey": `);
  throwsReason(() => loadPerpPrivateKey({ home: h, apiPublicKey: PAIR.publicKey }), "malformed", PAIR.privateKey);
  put(JSON.stringify([PAIR]));
  throwsReason(() => loadPerpPrivateKey({ home: h, apiPublicKey: PAIR.publicKey }), "malformed");
  put(JSON.stringify({ publicKey: PAIR.publicKey }));
  throwsReason(() => loadPerpPrivateKey({ home: h, apiPublicKey: PAIR.publicKey }), "malformed");
  put(JSON.stringify({ privateKey: "0xabc", publicKey: PAIR.publicKey }));
  throwsReason(() => loadPerpPrivateKey({ home: h, apiPublicKey: PAIR.publicKey }), "malformed");
  put(JSON.stringify({ privateKey: PAIR.privateKey, publicKey: `0x${"ff".repeat(40)}` }));
  throwsReason(() => loadPerpPrivateKey({ home: h, apiPublicKey: PAIR.publicKey }), "malformed", PAIR.privateKey);
  put(JSON.stringify({ ...PAIR, pad: "x".repeat(5000) }));
  throwsReason(() => loadPerpPrivateKey({ home: h, apiPublicKey: PAIR.publicKey }), "malformed", PAIR.privateKey);
});

test("no key anywhere, or a non-canonical sealed key, is refused", () => {
  const h = home();
  throwsReason(() => loadPerpPrivateKey({ home: h, apiPublicKey: PAIR.publicKey }), "missing");
  throwsReason(() => loadPerpPrivateKey({ home: h, apiPublicKey: `0x${"ff".repeat(40)}` }), "malformed");
  throwsReason(() => loadPerpPrivateKey({ home: h, apiPublicKey: "0x1234" }), "malformed");
});

test("the self-hosted file wins over the hosted slot when both exist", () => {
  const h = home();
  writePerpKeyFile(h, PAIR);
  writeFileSync(hostedPerpKeyFile(h), JSON.stringify({ privateKey: priv(0xee), publicKey: pub(9) }), { mode: 0o600 });
  assert.deepEqual(loadPerpPrivateKey({ home: h, apiPublicKey: PAIR.publicKey }), PAIR);
});

test("perpKeySecretForms lists every spelling of the loaded key for the agent's redactor, and never throws", () => {
  const h = home();
  writePerpKeyFile(h, PAIR);
  const bare = PAIR.privateKey.slice(2);
  const forms = perpKeySecretForms(h, PAIR.publicKey);
  assert.deepEqual(forms, [PAIR.privateKey, `0x${bare.toUpperCase()}`, bare, bare.toUpperCase()]);
  // By value, whatever the shape redactor makes of it (this key is one repeated byte).
  for (const f of forms) assert.equal(redactSecrets(`k=${f}.`, forms), "k=[redacted].");
  // Nothing to list is an empty list, not an error: no perp block, no file, a key that does not pair.
  assert.deepEqual(perpKeySecretForms(h, undefined), []);
  assert.deepEqual(perpKeySecretForms(home(), PAIR.publicKey), []);
  assert.deepEqual(perpKeySecretForms(h, pub(2)), []);
  assert.deepEqual(perpKeySecretForms(h, "not a key"), []);
});
