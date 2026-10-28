/**
 * The Telegram agent's secret screen strips a Solana secret key glued to the
 * text around it, as it strips one standing alone (audit: "pk<K>",
 * "%22<K>%22", "<K>is mine" and "secret:<K>x" were left readable), and keeps
 * what was glued to it. A signature, glued or not, is never a secret.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519";
import { base58Encode } from "../../../packages/core/src/ids";
import { containsSecret, redactSecrets } from "./agent";

const seed = new Uint8Array(32).fill(41);
const KEY = base58Encode(new Uint8Array([...seed, ...ed25519.getPublicKey(seed)]));
const SIG = base58Encode(ed25519.sign(new TextEncoder().encode("merrymen"), seed));
const keyOf = (byte: number) => {
  const s = new Uint8Array(32).fill(byte);
  return base58Encode(new Uint8Array([...s, ...ed25519.getPublicKey(s)]));
};

test("a glued Solana secret key is redacted and refused, and only the key goes", () => {
  for (const [text, safe] of [
    [`pk${KEY}`, "pk[redacted]"],
    [`url %22${KEY}%22 end`, "url %22[redacted]%22 end"],
    [`${KEY}is mine`, "[redacted]is mine"],
    [`secret:${KEY}x`, "secret:[redacted]x"],
  ] as const) {
    assert.equal(redactSecrets(text, []), safe);
    assert.equal(containsSecret(text, []), true, text.slice(0, 12));
  }
  for (const text of [`landed tx${SIG}done`, `sig ${SIG}`]) {
    assert.equal(redactSecrets(text, []), text);
    assert.equal(containsSecret(text, []), false);
  }
});

test("keys glued deep in a run, or written together, are redacted every one (review RHS, round 1)", () => {
  const [K2, K3] = [keyOf(43), keyOf(47)];
  for (const [text, safe] of [
    [`${KEY}${K2}${K3}`, "[redacted][redacted][redacted]"],
    [`mysecretkeyis${KEY}thankyoumybro`, "mysecretkeyis[redacted]thankyoumybro"],
    [`${SIG}${KEY}${SIG}`, `${SIG}[redacted]${SIG}`],
  ] as const) {
    assert.equal(redactSecrets(text, []), safe);
    assert.equal(containsSecret(text, []), true, text.slice(0, 16));
  }
});

test("send_file's screen finishes on a file of one 6-million-character run and still finds the 0x key in it", () => {
  // Review RHS, round 1: the base58 run regex threw RangeError here, and send_file swallowed it and sent the file.
  const file = `${"a".repeat(6_000_000)}\n0x${"ab".repeat(32)}\n`;
  assert.equal(containsSecret(file, []), true);
  assert.equal(redactSecrets(file, []).endsWith("\n[redacted]\n"), true);
});

test("the key, JWT and bot-token shapes finish on a 6-million-character run, and still find what they find (review RHS, round 1)", () => {
  // Unbounded, each threw RangeError (Maximum call stack size exceeded) on Node 26, and send_file sent the file unscanned.
  const run = "a".repeat(6_000_000);
  for (const [text, found] of [[`sk-${run}`, true], [`123456:${run}`, true], [`eyJ${run}`, false], ["1".repeat(6_000_000), false]] as const) {
    assert.equal(containsSecret(text, []), found, text.slice(0, 8));
    const redacted = redactSecrets(text, []);
    assert.equal(redacted.startsWith("[redacted]"), found, text.slice(0, 8));
  }
  // A JWT whose claims run to kilobytes is still one.
  const jwt = `eyJhbGciOiJSUzI1NiJ9.${"c".repeat(20_000)}.${"s".repeat(342)}`;
  assert.equal(containsSecret(`token ${jwt} end`, []), true);
  assert.equal(redactSecrets(`token ${jwt} end`, []), "token [redacted] end");
});

test("a notebook's base64 is not refused as secret-shaped (review RHS, round 1)", () => {
  let x = 0x51ed270b;
  const bytes = Uint8Array.from({ length: 3_000_000 }, () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) >>> 24);
  const notebook = JSON.stringify({ cells: [{ outputs: [{ data: { "image/png": Buffer.from(bytes).toString("base64") } }] }] });
  assert.equal(containsSecret(notebook, []), false);
  assert.equal(redactSecrets(notebook, []), notebook);
});
