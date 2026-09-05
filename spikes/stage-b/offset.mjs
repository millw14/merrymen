/**
 * The candidate offset function, standalone so it can be tested without
 * importing anything from worker/.
 *
 * This is byte-for-byte what the proposed patch adds to worker/src/tick-phase.ts.
 */
import { createHash } from "node:crypto";

/** FNV-1a 32. */
export function fnv1a32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** djb2 (xor variant). */
export function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

/** Naive baseline — deliberately bad, included to show the metric can fail. */
export function bytesum(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h + s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

/** SHA-256, first 4 bytes big-endian. */
export function sha256u32(s) {
  return createHash("sha256").update(s, "utf8").digest().readUInt32BE(0);
}

/** SHA-256, first 6 bytes (48 bits) — kills modulo bias at any sane period. */
export function sha256u48(s) {
  const d = createHash("sha256").update(s, "utf8").digest();
  return d.readUIntBE(0, 6); // < 2^48, exact in a double
}

export const HASHES = { bytesum, djb2, fnv1a32, sha256u32, sha256u48 };

/**
 * offsetMsFor(identity, periodMs) — the phase this identity always ticks on.
 * Pure, no I/O, no clock, no coordination.
 */
export function offsetMsFor(hash, identity, periodMs) {
  const key = String(identity).trim().toLowerCase();
  return hash(key) % periodMs;
}
