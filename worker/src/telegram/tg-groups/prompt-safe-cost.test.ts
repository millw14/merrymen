/**
 * A GROUP MEMBER CANNOT STALL THE WORKER THROUGH THE PROMPT QUOTES (review RHS, round 2).
 *
 * promptSafe runs the secret scan (agent.ts redactSecrets, core's
 * solanaSecretsIn) on every stored line each time a prompt is built: voice.ts
 * quotes 30 lines, understand.ts 9 and route.ts 7. The glued-key windows cost
 * about 256 keypair checks on a 400-character line of random base58, so 30
 * such lines cost over a second of CPU per prompt, synchronously, in the
 * tenant's worker, which also runs the Robinhood trading loop. Core remembers
 * a fresh scan of a short text, so a line already quoted costs nothing again.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ed25519 } from "@noble/curves/ed25519";
import { base58Encode } from "../../../../packages/core/src/ids";
import { promptSafe } from "./memory";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Milliseconds of CPU time (user + system) `fn` spent in this process, never a wall clock. */
const cpuMsOf = (fn: () => unknown): number => {
  const started = process.cpuUsage();
  fn();
  const spent = process.cpuUsage(started);
  return (spent.user + spent.system) / 1_000;
};

describe("promptSafe over stored group lines", () => {
  it("quotes 30 stored 400-character base58 lines again in under 50 ms of CPU", () => {
    let x = 0x2545f491;
    const line = () => Array.from({ length: 400 }, () => ALPHABET[((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) >>> 16) % 58]).join("");
    const lines = Array.from({ length: 30 }, line);
    // As the lines arrived: each is scanned once.
    const first = lines.map((l) => promptSafe(l, 240));
    let again = Infinity;
    for (let round = 0; round < 3; round++) {
      again = Math.min(again, cpuMsOf(() => assert.deepEqual(lines.map((l) => promptSafe(l, 240)), first)));
    }
    assert.ok(again < 50, `the next prompt's 30 quotes took ${again.toFixed(1)} ms of CPU time`);
  });

  it("quotes 30 fresh 400-character base58 lines, each the first time, in under 50 ms of CPU", () => {
    // The first scan of each new untrusted line: no memo helps. promptSafe reads no glued-key
    // windows (secretScanBudget({ windows: false })); encodedRuns quotes those runs as "(a code)".
    let x = 0x7f4a7c15;
    const line = () => Array.from({ length: 400 }, () => ALPHABET[((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) >>> 16) % 58]).join("");
    let first = Infinity;
    for (let round = 0; round < 3; round++) {
      const lines = Array.from({ length: 30 }, line);
      first = Math.min(first, cpuMsOf(() => lines.forEach((l) => promptSafe(l, 240))));
    }
    assert.ok(first < 50, `30 fresh quotes took ${first.toFixed(1)} ms of CPU time`);
  });

  it("still never quotes a key, glued or not, on a rescan", () => {
    const seed = Uint8Array.from({ length: 32 }, (_, i) => (i * 29 + 3) & 255);
    const key = base58Encode(Uint8Array.from([...seed, ...ed25519.getPublicKey(seed)]));
    for (const text of [`my key ${key} lol`, `pk${key}is mine`, `gm ${"x".repeat(40)}${key}`]) {
      for (let round = 0; round < 2; round++) {
        const quoted = promptSafe(text, 240);
        assert.ok(!quoted.includes(key.slice(0, 20)) && !quoted.includes(key.slice(-20)), `round ${round}: ${quoted}`);
        assert.match(quoted, /\(a code\)/);
      }
    }
  });
});
