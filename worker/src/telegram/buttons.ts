/**
 * CONFIRM / CANCEL BUTTONS FOR A PARKED ACTION.
 *
 * A button press is only ever the answer to ONE question. The data carries a
 * random nonce minted when the question was asked, never the action itself:
 * Telegram clients can send any callback_data they like, so the data is a
 * lookup key and nothing more. The service checks the nonce against the action
 * parked for THAT sender; a stale button — an older question, or someone
 * else's — finds nothing and changes nothing.
 *
 * Kept at 64 bytes or fewer, which is Telegram's hard limit.
 */

import { randomBytes } from "node:crypto";

import type { InlineKeyboard } from "./api";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Ten base-32 characters — 50 bits, far past guessing inside a ten-minute window. */
export function mintNonce(): string {
  const bytes = randomBytes(10);
  let out = "";
  for (const b of bytes) out += B32[b & 31];
  return out;
}

const DATA_RE = /^mm:(y|n):([a-z2-7]{10})$/;

/** The keyboard under a question. */
export function confirmKeyboard(nonce: string, yes = "✅ Yes, do it", no = "✖ No"): InlineKeyboard {
  return [[{ text: yes, callbackData: `mm:y:${nonce}` }, { text: no, callbackData: `mm:n:${nonce}` }]];
}

/** A press, read back. Null for anything we did not mint. */
export function parseConfirmData(data: string): { yes: boolean; nonce: string } | null {
  const m = DATA_RE.exec(data);
  return m ? { yes: m[1] === "y", nonce: m[2]! } : null;
}
