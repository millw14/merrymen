/**
 * CHAIN-NEUTRAL IDENTITY (Solana integration, phase 0, 2026-10-16).
 *
 * Until now every id in Merrymen was an EVM id on Robinhood Chain: a 0x
 * address, lowercased, or a 0x transaction hash. Solana ids are base58 and
 * CASE-SENSITIVE: lowercasing a mint makes a different (usually nonexistent)
 * mint, and lowercasing a signature makes it unfindable. So a chain is named
 * explicitly, the way CAIP-2 names it, and every id is canonicalised by its
 * chain's own rule:
 *
 *   EVM      0x + 40 hex (account, token) or 0x + 64 hex (operation), lowercased.
 *   Solana   base58 decoding to 32 bytes (account, token) or 64 bytes
 *            (signature), kept exactly as written.
 *
 * THE REGISTRY IS FAIL-CLOSED. A chain this file does not name is not a chain:
 * `chainInfo` answers null and the strict helpers throw. That is the opposite
 * of chain.ts `chainForId`, which maps every id but the testnet to Robinhood
 * mainnet; that helper stays as it is for the EVM paths that use it today.
 *
 * Rules lifted from worker/src/fomo/identity.ts, which already keeps Solana
 * mints apart from EVM addresses for research. Pure: no I/O, no clock, and
 * browser-safe (web imports it).
 */
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";

/** The chain families Merrymen can name. */
export type ChainFamily = "evm" | "solana";

/** CAIP-2 references: `eip155:<chain id>`, `solana:<first 32 chars of the genesis hash>`. */
export const CHAINS = Object.freeze({
  robinhood: "eip155:4663",
  robinhoodTestnet: "eip155:46630",
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  solanaDevnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
} as const);
export type ChainRef = (typeof CHAINS)[keyof typeof CHAINS];

/** The stable a chain's books are kept in: Paxos USDG on both (same issuer, same unit, 6 decimals). */
export interface CashAsset {
  symbol: "USDG";
  /** The token's address on that chain (an ERC-20 proxy on Robinhood Chain, a Token-2022 mint on Solana); null where none is verified. */
  address: string | null;
  decimals: 6;
  /** Solana only: the token program that owns the mint. */
  program?: string;
}

/** How a chain is shown beside the others: a short name, a glyph and its colours. */
export interface ChainLook {
  /** One or two characters for tight places (a badge, a chip). */
  glyph: string;
  /** The chain's own colour, for borders, dots and accents. */
  accent: string;
  /** A two-stop gradient for hero surfaces. */
  gradient: readonly [string, string];
}

export interface ChainInfo {
  ref: ChainRef;
  family: ChainFamily;
  /** The full name ("Robinhood Chain", "Solana"). */
  label: string;
  /** The short name for a badge ("Robinhood", "Solana"). */
  short: string;
  /** False on a test network: never shown as real money. */
  realMoney: boolean;
  /** The EVM chain id, for EVM chains only. */
  evmChainId?: number;
  explorer: { name: string; base: string; cluster?: string };
  cash: CashAsset;
  look: ChainLook;
}

/** Verified on chain 2026-10-16: the mint is owned by Token-2022, named "Global Dollar", symbol USDG, 6 decimals, transfer fee 0, transfer hook unset. */
export const SOLANA_USDG_MINT = "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/** Robinhood Chain USDG (packages/core/src/tokens.ts CASH.USDG), lowercased. */
const ROBINHOOD_USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

const ROBINHOOD_LOOK: ChainLook = { glyph: "R", accent: "#CCFF00", gradient: ["#CCFF00", "#00C805"] };
const SOLANA_LOOK: ChainLook = { glyph: "◎", accent: "#14F195", gradient: ["#9945FF", "#14F195"] };

const REGISTRY: ReadonlyMap<string, ChainInfo> = new Map<string, ChainInfo>([
  [CHAINS.robinhood, {
    ref: CHAINS.robinhood, family: "evm", label: "Robinhood Chain", short: "Robinhood", realMoney: true, evmChainId: 4663,
    explorer: { name: "Blockscout", base: "https://robinhoodchain.blockscout.com" },
    cash: { symbol: "USDG", address: ROBINHOOD_USDG, decimals: 6 }, look: ROBINHOOD_LOOK,
  }],
  [CHAINS.robinhoodTestnet, {
    ref: CHAINS.robinhoodTestnet, family: "evm", label: "Robinhood Chain Testnet", short: "Robinhood test", realMoney: false, evmChainId: 46630,
    explorer: { name: "Blockscout", base: "https://explorer.testnet.chain.robinhood.com" },
    cash: { symbol: "USDG", address: null, decimals: 6 }, look: ROBINHOOD_LOOK,
  }],
  [CHAINS.solana, {
    ref: CHAINS.solana, family: "solana", label: "Solana", short: "Solana", realMoney: true,
    explorer: { name: "Solscan", base: "https://solscan.io" },
    cash: { symbol: "USDG", address: SOLANA_USDG_MINT, decimals: 6, program: TOKEN_2022_PROGRAM }, look: SOLANA_LOOK,
  }],
  [CHAINS.solanaDevnet, {
    ref: CHAINS.solanaDevnet, family: "solana", label: "Solana Devnet", short: "Solana dev", realMoney: false,
    explorer: { name: "Solscan", base: "https://solscan.io", cluster: "devnet" },
    cash: { symbol: "USDG", address: null, decimals: 6, program: TOKEN_2022_PROGRAM }, look: SOLANA_LOOK,
  }],
]);

/** Every chain Merrymen names, in display order. */
export function allChains(): ChainInfo[] {
  return [...REGISTRY.values()];
}

/** A chain's facts, or null for anything this registry does not name (never a default). */
export function chainInfo(ref: unknown): ChainInfo | null {
  return typeof ref === "string" ? REGISTRY.get(ref) ?? null : null;
}

/** As chainInfo, but an unknown chain throws: for code that must never guess. */
export function requireChain(ref: unknown): ChainInfo {
  const c = chainInfo(ref);
  if (!c) throw new Error(`unknown chain: ${String(ref).slice(0, 80)}`);
  return c;
}

/** The CAIP-2 reference of an EVM chain id this registry names, or null (never a default). */
export function chainOfEvmId(id: unknown): ChainRef | null {
  if (typeof id !== "number" || !Number.isSafeInteger(id)) return null;
  for (const c of REGISTRY.values()) if (c.family === "evm" && c.evmChainId === id) return c.ref;
  return null;
}

// ── base58 ──────────────────────────────────────────────────────────────────

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX: ReadonlyMap<string, number> = new Map([...B58].map((c, i) => [c, i]));

/** Bitcoin-alphabet base58 to bytes, or null for any character outside it. */
export function base58Decode(s: string): Uint8Array | null {
  if (typeof s !== "string" || s.length === 0 || s.length > 128) return null;
  const bytes: number[] = [];
  for (const ch of s) {
    let carry = B58_INDEX.get(ch);
    if (carry === undefined) return null;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Each leading "1" is a leading zero byte.
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

/** Bytes to Bitcoin-alphabet base58. */
export function base58Encode(b: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of b) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const byte of b) {
    if (byte !== 0) break;
    out += "1";
  }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]!];
  return out;
}

const BASE58_WORD = /^[1-9A-HJ-NP-Za-km-z]+$/;
/** Base58 text that decodes to exactly `n` bytes. */
function base58Of(s: string, n: number): boolean {
  if (!BASE58_WORD.test(s)) return false;
  const b = base58Decode(s);
  return b !== null && b.length === n;
}

// ── canonical ids ───────────────────────────────────────────────────────────

/** What an id names: an account (a wallet, a vault, a program), a token, or an operation (a tx hash, a signature). */
export type IdKind = "account" | "token" | "op";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * An id in its chain's canonical spelling, or null when it is not one: EVM
 * lowercased, Solana exactly as written (never case-folded). The chain must
 * be one this registry names.
 */
export function canonicalId(chain: unknown, kind: IdKind, raw: unknown): string | null {
  const c = chainInfo(chain);
  if (!c || typeof raw !== "string") return null;
  const s = raw.trim();
  if (c.family === "evm") {
    if (kind === "op") return EVM_HASH.test(s) ? s.toLowerCase() : null;
    return EVM_ADDRESS.test(s) ? s.toLowerCase() : null;
  }
  return base58Of(s, kind === "op" ? 64 : 32) ? s : null;
}

/** Two ids name the same thing on that chain. */
export function sameId(chain: unknown, kind: IdKind, a: unknown, b: unknown): boolean {
  const x = canonicalId(chain, kind, a);
  return x !== null && x === canonicalId(chain, kind, b);
}

/** The family an id's SHAPE belongs to, chain unknown: "evm", "solana" or null. Never a canonicaliser. */
export function idFamily(raw: unknown): ChainFamily | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (EVM_ADDRESS.test(s) || EVM_HASH.test(s)) return "evm";
  if (base58Of(s, 32) || base58Of(s, 64)) return "solana";
  return null;
}

/** The explorer page for an id on its chain, or null for an id that is not canonical there. */
export function explorerUrl(chain: unknown, kind: IdKind, raw: unknown): string | null {
  const c = chainInfo(chain);
  const id = canonicalId(chain, kind, raw);
  if (!c || !id) return null;
  const base = c.explorer.base;
  if (c.family === "evm") return `${base}/${kind === "op" ? "tx" : kind === "token" ? "token" : "address"}/${id}`;
  const path = kind === "op" ? "tx" : kind === "token" ? "token" : "account";
  return `${base}/${path}/${id}${c.explorer.cluster ? `?cluster=${c.explorer.cluster}` : ""}`;
}

// ── detectors for public, model-facing and secret backstops ─────────────────

export interface OnchainIdHit {
  family: ChainFamily;
  /** "address" (a 20- or 32-byte id), "hash" (a 32-byte EVM hash or a 64-byte Solana signature) or "link" (an explorer URL). */
  shape: "address" | "hash" | "link";
  value: string;
}

const EVM_IN_TEXT = /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])|0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
/** A run of base58 long enough to be a 32-byte key (32-44 chars) or a 64-byte signature (86-88 chars), not inside a longer word. */
const BASE58_IN_TEXT = /(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{32,88}(?![0-9A-Za-z])/g;
const SOLANA_LINK = /\b(?:https?:\/\/)?(?:www\.)?(?:solscan\.io|explorer\.solana\.com|solana\.fm|solanabeach\.io|orb\.helius\.dev)\/[^\s)>\]]*/gi;

/** Base58's characters by code (B58): 1 for each. */
const B58_CODE = Uint8Array.from({ length: 128 }, (_, code) => (B58.includes(String.fromCharCode(code)) ? 1 : 0));
/**
 * Every maximal run of base58 characters at least `min` long, wherever it
 * sits, as [start, end) in order (the glued scans). A loop, never a regex:
 * V8 runs /[…]{32,}/ out of stack on a run of about 5.6 million characters
 * and throws RangeError, and a scan that throws is a check skipped wherever
 * its caller swallows the error (review RHS, round 1).
 */
function* base58Runs(text: string, min: number): Generator<[number, number]> {
  let start = -1;
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && B58_CODE[text.charCodeAt(i)] === 1) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0 && i - start >= min) yield [start, i];
    start = -1;
  }
}
function hexDigit(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}
/** `s` from `from` on is hex digits alone. */
function hexFrom(s: string, from: number): boolean {
  for (let i = from; i < s.length; i++) if (!hexDigit(s.charCodeAt(i))) return false;
  return true;
}
/** An ASCII letter or digit: what the default scan will not read an id against. */
function alnumAt(text: string, i: number): boolean {
  const code = i >= 0 && i < text.length ? text.charCodeAt(i) : 0;
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}
/** The longest pattern filler repeats: "xxxx…", "haha…", "abcabc…", "wxyzwxyz…". */
const FILLER_PERIOD = 4;
/** `s` repeats a pattern of FILLER_PERIOD characters or fewer from end to end: filler, never an id. */
function filler(s: string): boolean {
  for (let k = 1; k <= FILLER_PERIOD; k++) {
    let i = 0;
    while (i + k < s.length && s[i] === s[i + k]) i++;
    if (i + k >= s.length) return true;
  }
  return false;
}
/**
 * Base58 decodes one glued scan may spend. Each costs up to about 88 × 64
 * steps; past the cap every further candidate run counts as an id unread: a
 * false alarm on a text no one writes, never an id let through.
 */
const GLUED_DECODES = 4_096;

export interface OnchainIdScan {
  /**
   * Also find an id glued to the text around it ("CA<mint>", "<mint>is"),
   * audit regressions F3. Every maximal base58 run is read. A run with nothing
   * alphanumeric on either side is read exactly as the default reads it; any
   * other run, or a standalone one that is not itself a key or signature, is a
   * hit when the whole run or any window of it decodes to exactly 32 or 64
   * bytes. The hit's value is the whole run, so a redactor strips all of it.
   * Hex digits alone (digests, long numbers, an 0x string split at its zeros,
   * with the x of its "0x") and filler (one to four characters repeated:
   * "xxxx…", "hahaha…") are never read as an id glued to anything; an x after
   * a 0 with anything but hex behind it is read as part of the run.
   *
   * For the public and model-facing backstops. The callers, which this list
   * must name exactly: X posts (worker/src/xpost/public-wallet.ts), social
   * takes (worker/src/social-post.ts admitPost), published theses and their
   * model posts (worker/src/thesis-policy.ts addressy), Brain's decisions and
   * the desk policy sent to it (worker/src/brain-client.ts), Brain's own validator
   * (services/brain/brain/schemas.py `_reject_executable`) and the worker's
   * re-check of its desk answer (worker/src/desk/brain-desk.ts), tags and
   * comments on X before a model reads them (worker/src/xpost/replies.ts
   * linkOrSecret), the coin name drawn on a P&L card (worker/src/pnl-card.ts),
   * event text redacted for the Telegram chat model (worker/src/telegram/reads.ts
   * redactAddresses), room prompts (worker/src/groupchat/voice.ts scrubIds) and
   * the soul's memory, notes and journal (worker/src/soul.ts). Telegram event
   * text, room prompts and the soul's journal (scrubProse) go through
   * redactSolanaIds, which replaces the longest value first, before any 0x rule;
   * the soul's memory and notes (sanitizeMemory, sanitizeNote) refuse the whole
   * text, as every other caller here refuses.
   * Off by default: the name checks that also call this detector keep reading
   * a run inside a longer word as no id. Brain's Python mirror implements both
   * scans, and services/brain/tests/data/onchain_ids.json pins both to it.
   */
  glued?: boolean;
}

function base58Shape(s: string): "address" | "hash" | null {
  const b = base58Decode(s);
  return b?.length === 32 ? "address" : b?.length === 64 ? "hash" : null;
}

/**
 * The shape of an id inside `run`, "unread" once the budget is spent, or null.
 * 58^42 < 2^248 and 58^86 < 2^504, so a window shorter than 43 (or 87)
 * characters reaches 32 (or 64) bytes only through leading zero bytes, which
 * base58 writes as leading "1"s: other short windows are skipped undecoded.
 */
function gluedShape(run: string, budget: { left: number }): "address" | "hash" | "unread" | null {
  // nonHex[i]: characters before i that are not hex digits, so a window of hex alone is skipped in O(1).
  const nonHex = new Uint32Array(run.length + 1);
  for (let i = 0; i < run.length; i++) nonHex[i + 1] = nonHex[i]! + (hexDigit(run.charCodeAt(i)) ? 0 : 1);
  // breaks[k - 1][i]: positions p < i where run[p] differs from run[p + k], so a window of filler is skipped in O(1).
  const breaks = Array.from({ length: FILLER_PERIOD }, (_, j) => {
    const b = new Uint32Array(run.length + 1);
    for (let i = 0; i < run.length; i++) b[i + 1] = b[i]! + (i + j + 1 < run.length && run[i] !== run[i + j + 1] ? 1 : 0);
    return b;
  });
  const repeats = (start: number, end: number): boolean => breaks.some((b, j) => b[end - j - 1] === b[start]);
  for (const [min, max, full, shape] of [[86, 88, 87, 64], [32, 44, 43, 32]] as const) {
    for (let start = 0; start + min <= run.length; start++) {
      for (let length = min; length <= max && start + length <= run.length; length++) {
        if (length < full && run[start] !== "1") continue;
        if (nonHex[start + length] === nonHex[start] || repeats(start, start + length)) continue;
        if (budget.left-- <= 0) return "unread";
        if (base58Decode(run.slice(start, start + length))?.length === shape) return shape === 64 ? "hash" : "address";
      }
    }
  }
  return null;
}

/**
 * Every on-chain id in a text: EVM addresses and hashes, base58 runs that
 * decode to a 32-byte key or a 64-byte signature, and Solana explorer links.
 * For the backstops that must never publish, or hand a model, an id it did
 * not mean to: the shape is enough, a match is never checked against a chain.
 * `glued` also finds ids written against neighbouring letters or digits.
 */
export function onchainIdsIn(text: unknown, scan: OnchainIdScan = {}): OnchainIdHit[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const hits: OnchainIdHit[] = [];
  for (const m of text.matchAll(EVM_IN_TEXT)) hits.push({ family: "evm", shape: m[0].length === 66 ? "hash" : "address", value: m[0] });
  for (const m of text.matchAll(SOLANA_LINK)) hits.push({ family: "solana", shape: "link", value: m[0] });
  if (scan.glued) {
    const budget = { left: GLUED_DECODES };
    for (const [start, end] of base58Runs(text, 32)) {
      const s = text.slice(start, end);
      // "0x" then hex alone is that hex (an EVM id, or one split at its zeros), never a base58 id
      // glued to anything. With anything else after it the x is the run's own: a key can begin
      // with one ("10x<key>", "CA0x<key>"), and dropping it hid such a key from every window.
      if (s[0] === "x" && start > 0 && text[start - 1] === "0" && hexFrom(s, 1)) continue;
      let whole: "address" | "hash" | null = null;
      if (!alnumAt(text, start - 1) && !alnumAt(text, start + s.length)) {
        // Nothing alphanumeric either side: the run the default scan reads, read the same way.
        whole = s.length <= 88 ? base58Shape(s) : null;
      } else if (s.length <= 88) {
        // Glued: the whole run counts only when it is neither hex alone nor filler.
        whole = hexFrom(s, 0) || filler(s) ? null : base58Shape(s);
      }
      // A run of hex alone or of filler has no window gluedShape would read: skipped whole, in O(n).
      let inside: "address" | "hash" | "unread" | null = whole;
      if (!inside && s.length > 32 && !hexFrom(s, 0) && !filler(s)) {
        // Its tables are O(run): a run too long to allocate them for is an id unread, never no id.
        try { inside = gluedShape(s, budget); } catch { inside = "unread"; }
      }
      if (inside) hits.push({ family: "solana", shape: inside === "hash" ? "hash" : "address", value: s });
    }
    return hits;
  }
  for (const m of text.matchAll(BASE58_IN_TEXT)) {
    const s = m[0];
    // Base58 keys and signatures can contain letters only. Decode every
    // candidate; treating the absence of digits as prose bypasses the guards.
    const b = base58Decode(s);
    if (b?.length === 32) hits.push({ family: "solana", shape: "address", value: s });
    else if (b?.length === 64) hits.push({ family: "solana", shape: "hash", value: s });
  }
  return hits;
}

/** Whether a text carries any on-chain id (onchainIdsIn). */
export function onchainIdIn(text: unknown, scan: OnchainIdScan = {}): boolean {
  return onchainIdsIn(text, scan).length > 0;
}

/**
 * `text` with every Solana key and signature the glued scan finds replaced,
 * wherever its value occurs, by what `mark` names it. An explorer link is no
 * replacement itself: the key or signature in it is a run of its own and is
 * replaced. For the model-facing redactors (Telegram event text, room
 * prompts, the soul's prose).
 *
 * LONGEST VALUE FIRST. A glued hit's value is its whole run, and that can hold
 * a shorter hit's value: in "<key> then X<mint><key>Y" the second run ends in
 * the first key. Replaced first, the key splits that run, whose value is then
 * found nowhere, and the mint in it stays. Longest first, every run that holds
 * a shorter value is gone before that value is replaced; a shorter value
 * never holds a longer one, and runs never overlap, so no value is lost.
 */
export function redactSolanaIds(text: string, mark: (hit: OnchainIdHit) => string): string {
  const hits = onchainIdsIn(text, { glued: true }).filter((h) => h.family === "solana" && h.shape !== "link");
  let out = text;
  for (const hit of hits.sort((a, b) => b.value.length - a.value.length)) out = out.split(hit.value).join(mark(hit));
  return out;
}

/**
 * A Solana keypair: 64 bytes whose second half is the ed25519 public key of
 * the first. A transaction signature is also 64 bytes, and never passes this,
 * so a signature is not mistaken for a secret.
 */
export function isSolanaKeypair(bytes: Uint8Array): boolean {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 64) return false;
  try {
    const pub = ed25519.getPublicKey(bytes.subarray(0, 32));
    for (let i = 0; i < 32; i++) if (pub[i] !== bytes[32 + i]) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * A JSON array of exactly 64 byte values: the Solana CLI's id.json shape.
 *
 * Each value has ONE way to match. `1?\d?\d` read "11" as 1+1 or as 11, so a
 * long array of small values that failed at its end backtracked through every
 * split, doubling per value: a 150-byte text held the process for seconds.
 * JSON writes no leading zeros, so `[1-9]?\d` loses nothing.
 */
const BYTE = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;
const BYTE_ARRAY_64 = new RegExp(String.raw`\[\s*(?:${BYTE}\s*,\s*){63}${BYTE}\s*\]`, "g");

/**
 * How many exact candidates one scan reads: a whole base58 run that can be a
 * keypair as it stands (87 or 88 characters, or shorter after leading "1"s:
 * keypairLengthsAfter; hex digits alone and filler excepted), and a JSON array
 * of 64 byte values. Reading one costs a base58 decode and, at 64 bytes, a
 * keypair check: an ed25519 scalar multiplication, about 0.2 ms of CPU
 * (measured 2026-10-20 on a loaded machine, 0.15 ms idle). Uncapped, a text of
 * 64-byte runs held the process for seconds per megabyte. Past the cap every
 * further candidate counts as a secret unread, whole: a false alarm on a text
 * no owner sends, never a key let through. A standalone signature is one
 * candidate, so the 257th in a text is the first refused, as before glued keys
 * were read.
 */
const SECRET_CANDIDATES = 256;
/**
 * What one scan spends on windows inside runs, looking for a key glued to its
 * neighbours (solanaSecretsIn, GLUED KEYS): keypair checks, base58 decodes
 * (about 6 µs each) and window starts examined (the hex and filler tests, tens
 * of ns each), so at most about 50 + 25 + 15 ms of CPU. Past any of them no
 * further window is read, in this scan or any that shares its budget, and the
 * answer is what the exact candidates say. BEST EFFORT, NEVER A FALSE ALARM:
 * long base58 stretches (base64 in a notebook or an SVG, a list of signatures)
 * are never refused for the windows inside them, and a key glued inside such
 * a text past the budget is missed. The other direction, every window past
 * the budget read as a secret, refused base64 notebooks and images in
 * send_file from about 800 KB. A CHOICE OF AVAILABILITY OVER SECRECY that
 * awaits Milla's sign-off: proposed with both directions and their measured
 * costs in the RHS track's round-2 report (ownerDecisions), for the docs pass
 * to record in docs/solana-integration.md, which does not have it yet.
 */
const SECRET_WINDOW_CHECKS = 256;
const SECRET_WINDOW_DECODES = 4_096;
const SECRET_WINDOW_STARTS = 262_144;
/**
 * The edge of a run a glued key is looked for first: windows that start within
 * this many characters of a long run's start, or of the end of a key found in
 * it, or end within it of the run's end, or of a key's start. "pk<key>",
 * "%22<key>%22", "<key>is mine" and "<K1><K2><K3>" are found there. Edges are
 * read before any other window, best effort too, SHORTEST RUN FIRST: a run
 * with a few characters of glue (89 to 112 characters) before a long blob,
 * whose edges cost about 28 keypair checks when no key is there, so about
 * nine such blobs spend the budget, and a key at the edge of a run longer
 * than all of them can go unread. A run a keypair's length that is not 64
 * bytes as a whole ("secret:<key>x", an 87-character key) is read with the
 * edges. The rest are read after, in the order written, while the budget
 * lasts: windows deeper in a long run ("<sig><key><sig>",
 * "mysecretkeyis<key>thankyoumybro") and those inside a run a keypair's length
 * that is 64 bytes whole ("2<key>"), which a list of signatures is made of, so
 * a long list cannot starve the edges.
 */
const SECRET_GLUE = 12;
/** Window starts one set of tables covers (windowTables): memory stays bounded however long the run. */
const SECRET_SWEEP_CHUNK = 4_096;

/** What a secret scan may still read. Hand one to several scans to cap them together. */
export type SecretScanBudget = {
  /** Exact candidates (SECRET_CANDIDATES). */
  left: number;
  /** Windows inside runs (SECRET_WINDOW_*): keypair checks, decodes and starts. A full set when absent. */
  windows?: { checks: number; decodes: number; starts: number };
};
type WindowBudget = NonNullable<SecretScanBudget["windows"]>;

/**
 * A fresh budget: SECRET_CANDIDATES exact candidates and the SECRET_WINDOW_*
 * window reads. `{ windows: false }`: exact candidates only, no window read,
 * for a caller that already replaces every run a glued key could hide in (the
 * group-chat prompt quoting, whose encodedRuns turns any such run into "(a
 * code)"): a 400-character line of random base58 then costs microseconds, not
 * the window budget's tens of milliseconds.
 */
export function secretScanBudget(opts: { windows?: boolean } = {}): SecretScanBudget {
  return { left: SECRET_CANDIDATES, windows: opts.windows === false ? { checks: 0, decodes: 0, starts: 0 }
    : { checks: SECRET_WINDOW_CHECKS, decodes: SECRET_WINDOW_DECODES, starts: SECRET_WINDOW_STARTS } };
}

/**
 * SCANS ARE REMEMBERED (review RHS, round 2). A scan with a fresh budget is a
 * pure function of its text, and the windows can cost tens of milliseconds a
 * text (about 256 keypair checks for a 400-character line of random base58),
 * while the group chat quotes the same stored lines in every prompt it builds
 * (30 in voice.ts alone): 1.2 s of CPU a prompt, in the worker that also
 * trades. So the answer for a text of up to SECRET_MEMO_CHARS, scanned with no
 * budget handed in, is kept for the next scan of the same text: where its
 * secrets are, as offsets, under the SHA-256 of its UTF-16 code units, so the
 * memo holds neither the text nor any secret in it. A scan handed a budget is
 * never remembered (its answer depends on what the budget had left), nor is
 * a scan that threw, nor a text with no base58 run of 64 characters (prose,
 * byte arrays alone), which costs less to scan than to digest. The oldest of
 * SECRET_MEMO_ENTRIES goes first.
 */
const SECRET_MEMO_CHARS = 4_096;
const SECRET_MEMO_ENTRIES = 1_024;
const secretMemo = new Map<string, ReadonlyArray<readonly [number, number]>>();
function secretMemoKey(text: string): string {
  const units = new Uint16Array(text.length);
  for (let i = 0; i < text.length; i++) units[i] = text.charCodeAt(i);
  return String.fromCharCode(...sha256(new Uint8Array(units.buffer)));
}

/**
 * Whether a text carries a Solana secret key: a base58 string or a JSON byte
 * array decoding to a 64-byte keypair (isSolanaKeypair). For the secret
 * backstops (the hosted owner-key guard, the Telegram agent's secret screen).
 */
export function solanaSecretIn(text: unknown, budget?: SecretScanBudget): boolean {
  return solanaSecretsIn(text, budget).length > 0;
}

/**
 * The lengths a 64-byte value takes in base58 after `z` leading "1"s (its `z`
 * leading zero bytes): `z` plus the shortest to the longest encoding of a
 * (64 - z)-byte value whose first byte is not zero. [87, 88] for z = 0, which
 * is all but one keypair in 256. Exact (computed with base58Encode), once.
 */
let keypairLengths: ReadonlyArray<readonly [number, number]> | null = null;
function keypairLengthsAfter(z: number): readonly [number, number] {
  keypairLengths ??= Array.from({ length: 65 }, (_, ones) => ones === 64 ? [64, 64] as const : [
    ones + base58Encode(Uint8Array.from({ length: 64 - ones }, (_, i) => (i === 0 ? 1 : 0))).length,
    ones + base58Encode(new Uint8Array(64 - ones).fill(255)).length,
  ] as const);
  return keypairLengths[Math.min(z, 64)]!;
}
/** The most characters a keypair's base58 takes, whatever its leading zero bytes (88). */
let keypairCharsMax = 0;
function longestKeypair(): number {
  return keypairCharsMax ||= Math.max(...Array.from({ length: 65 }, (_, z) => keypairLengthsAfter(z)[1]));
}

/**
 * The tests that skip a window of run[a, b) unread, in O(1): a window of hex
 * digits alone, or of filler ("xxxx…", "abab…"), can hold no key. A keypair's
 * base58 is never either (a random 64-byte value's 87 characters are all hex
 * with odds of about 1 in 10^37), and digests, numbers and filler would
 * otherwise spend the budget. Also the "1"s from each start (its leading zero
 * bytes, at most 64), which set the lengths a window there can take.
 */
function windowTables(run: string, a: number, b: number): { ones(start: number): number; skip(start: number, end: number): boolean } {
  const len = b - a;
  // nonHex[i]: characters in [a, a + i) that are not hex digits. ones[i]: "1"s from a + i on, unbroken.
  const nonHex = new Uint32Array(len + 1), ones = new Uint8Array(len + 1);
  for (let i = 0; i < len; i++) nonHex[i + 1] = nonHex[i]! + (hexDigit(run.charCodeAt(a + i)) ? 0 : 1);
  for (let i = len - 1; i >= 0; i--) ones[i] = run.charCodeAt(a + i) === 49 ? Math.min(ones[i + 1]! + 1, 64) : 0;
  // breaks[k - 1][i]: positions p in [a, a + i) where run[p] differs from run[p + k] (period-k filler check).
  const breaks = Array.from({ length: FILLER_PERIOD }, (_, j) => {
    const br = new Uint32Array(len + 1);
    for (let i = 0; i < len; i++) br[i + 1] = br[i]! + (i + j + 1 < len && run.charCodeAt(a + i) !== run.charCodeAt(a + i + j + 1) ? 1 : 0);
    return br;
  });
  return {
    ones: (start) => ones[start - a]!,
    skip: (start, end) => nonHex[end - a] === nonHex[start - a] || breaks.some((br, j) => br[end - a - j - 1] === br[start - a]),
  };
}

/** The window budget spent out, so every later sweep sharing it reads nothing. */
function spentOut(w: WindowBudget): "spent" {
  w.checks = 0;
  w.decodes = 0;
  w.starts = 0;
  return "spent";
}

/**
 * The first keypair among the windows of `run` that start in [from, to], in
 * order, and end in [endMin, endMax] (`notWhole`: other than the whole run, an
 * exact candidate read already). [start, end) when found, null when there is
 * none, "spent" once the window budget runs out. `minLength`: the shortest a
 * window of this run can hold a keypair in (shortestKeypairIn).
 */
function sweep(run: string, w: WindowBudget, from: number, to: number, endMin: number, endMax: number, minLength: number, notWhole = false): [number, number] | null | "spent" {
  // Spent already: no tables built for a sweep that could read nothing.
  if (w.checks <= 0 || w.decodes <= 0 || w.starts <= 0) return spentOut(w);
  const last = Math.min(to, endMax - minLength);
  for (let a = Math.max(from, 0); a <= last; a += SECRET_SWEEP_CHUNK) {
    const chunkLast = Math.min(last, a + SECRET_SWEEP_CHUNK - 1);
    const t = windowTables(run, a, Math.min(endMax, chunkLast + longestKeypair()));
    for (let start = a; start <= chunkLast; start++) {
      if (w.starts <= 0) return spentOut(w);
      w.starts--;
      const [shortest, longest] = keypairLengthsAfter(t.ones(start));
      for (let end = Math.max(start + shortest, endMin); end <= start + longest && end <= endMax; end++) {
        if ((notWhole && start === 0 && end === run.length) || t.skip(start, end)) continue;
        if (w.decodes <= 0) return spentOut(w);
        w.decodes--;
        const bytes = base58Decode(run.slice(start, end));
        if (bytes?.length !== 64) continue;
        if (w.checks <= 0) return spentOut(w);
        w.checks--;
        if (isSolanaKeypair(bytes)) return [start, end];
      }
    }
  }
  return null;
}

/** "1"s a run starts with, at most 64: its leading zero bytes. */
function leadingOnes(run: string): number {
  let z = 0;
  while (z < 64 && run.charCodeAt(z) === 49) z++;
  return z;
}
/**
 * The fewest characters any window of a run can hold a keypair in: the more
 * leading "1"s a window has, the shorter it can be, so its longest stretch of
 * "1"s decides (87 with none). A shorter run can hold no key at all.
 */
function shortestKeypairIn(run: string): number {
  let most = 0;
  for (let i = 0, ones = 0; i < run.length && most < 64; i++) most = Math.max(most, ones = run.charCodeAt(i) === 49 ? ones + 1 : 0);
  return keypairLengthsAfter(most)[0];
}

/**
 * Every Solana secret key in a text (solanaSecretIn), exactly as written, so a
 * redactor can strip each one, in the order written (base58, then byte
 * arrays). An exact candidate past the budget is returned as a secret without
 * being read (SECRET_CANDIDATES): the whole run it is.
 *
 * GLUED KEYS TOO. Every maximal base58 run is read, not only one standing
 * alone: "pk<key>", "%22<key>%22" (URL-encoded JSON), "<key>is mine",
 * "secret:<key>x", "2<key>", "<K1><K2><K3>" and "<sig><key><sig>" each hide
 * the key in a longer run. Every window of a run that can hold a keypair (87
 * or 88 characters, or shorter after leading "1"s: keypairLengthsAfter) is
 * decoded, edges first (SECRET_GLUE), while the window budget lasts
 * (SECRET_WINDOW_CHECKS), and a keypair is recognised by its own public key,
 * so a signature, an address or ordinary text is never one. The only false
 * alarm is an exact candidate past its budget.
 *
 * FAIL CLOSED. A scan that cannot finish reads the whole text as a secret:
 * the Telegram agent's send_file once swallowed a throw here and sent the file
 * unscanned (review RHS, round 1).
 */
export function solanaSecretsIn(text: unknown, budget?: SecretScanBudget): string[] {
  if (typeof text !== "string" || text.length < 64) return [];
  try {
    // A fresh scan of a short text is remembered (SECRET_MEMO_CHARS): the same answer, without the work. Not a
    // text with no base58 run long enough to hold a key: its scan costs less than the digest.
    const key = budget === undefined && text.length <= SECRET_MEMO_CHARS && !base58Runs(text, 64).next().done ? secretMemoKey(text) : null;
    let spans = key === null ? undefined : secretMemo.get(key);
    if (spans) {
      secretMemo.delete(key!);
      secretMemo.set(key!, spans);
    } else {
      spans = secretsIn(text, budget ?? secretScanBudget());
      if (key !== null) {
        secretMemo.set(key, spans);
        if (secretMemo.size > SECRET_MEMO_ENTRIES) secretMemo.delete(secretMemo.keys().next().value!);
      }
    }
    return spans.map(([start, end]) => text.slice(start, end));
  } catch {
    return [text];
  }
}

/** Where each secret is in `text`, [start, end), in the order solanaSecretsIn returns them. */
function secretsIn(text: string, budget: SecretScanBudget): Array<[number, number]> {
  const w = (budget.windows ??= { checks: SECRET_WINDOW_CHECKS, decodes: SECRET_WINDOW_DECODES, starts: SECRET_WINDOW_STARTS });
  const hits: Array<[start: number, end: number]> = [];
  const found = (at: number, _run: string, key: [number, number]) => hits.push([at + key[0], at + key[1]]);
  /**
   * Runs whose windows are still to read, in the order written: longer than a
   * keypair (`long`: any key in one is glued; [lo, hi) is what its edges left),
   * or a keypair's length (one character of glue at most). `edge`: read with
   * the edges (phase 1), every long run, and a run a keypair's length that is
   * not 64 bytes as a whole, so neither a signature nor a key ("secret:<key>x"
   * with an 87-character key): its windows are a key's edges. A signature's
   * windows wait for phase 2, so a list of signatures cannot starve the edges.
   */
  const runs: Array<{ at: number; run: string; min: number; long: boolean; edge: boolean; lo: number; hi: number }> = [];
  // 64 bytes never encode shorter than 64 characters, so a shorter run (an address) costs nothing.
  for (const [at, end] of base58Runs(text, 64)) {
    const run = text.slice(at, end);
    // Nor does one too short for any window of it to be a key, or of hex alone, or filler.
    const min = shortestKeypairIn(run);
    if (run.length < min || hexFrom(run, 0) || filler(run)) continue;
    const [shortest, longest] = keypairLengthsAfter(leadingOnes(run));
    let whole64 = false;
    if (run.length <= longest && run.length >= shortest) {
      // EXACT: the run as it stands, as every scan before glued keys read it.
      if (budget.left-- <= 0) {
        hits.push([at, end]);
        continue;
      }
      const bytes = base58Decode(run);
      if (bytes?.length === 64 && isSolanaKeypair(bytes)) {
        hits.push([at, end]);
        continue;
      }
      whole64 = bytes?.length === 64;
    }
    const long = run.length > longest;
    runs.push({ at, run, min, long, edge: long || !whole64, lo: 0, hi: run.length });
  }
  // 1. The edges, SHORTEST RUN FIRST (review RHS, round 2): a key behind a few characters of glue ("pk<key>",
  // a run of 89 to 112 characters) before the edges of a long blob (a serialized transaction), which cost
  // about 28 keypair checks each: in the order written, ten blobs spent the budget and left it unread.
  // Again from the end of each key found there ("<K1><K2><K3>").
  for (const r of runs.filter((x) => x.edge).sort((x, y) => x.run.length - y.run.length)) {
    if (!r.long) {
      const key = sweep(r.run, w, 0, r.run.length, 0, r.run.length, r.min, true);
      if (Array.isArray(key)) found(r.at, r.run, key);
      continue;
    }
    const left = () => sweep(r.run, w, r.lo, r.lo + SECRET_GLUE, r.lo, r.hi, r.min);
    for (let key = left(); Array.isArray(key); key = left()) {
      found(r.at, r.run, key);
      r.lo = key[1];
    }
    // Windows ending near the end, other than those just read.
    const right = () => sweep(r.run, w, Math.max(r.lo + SECRET_GLUE + 1, r.hi - SECRET_GLUE - longestKeypair()), r.hi, r.hi - SECRET_GLUE, r.hi, r.min);
    for (let key = right(); Array.isArray(key); key = right()) {
      found(r.at, r.run, key);
      r.hi = key[0];
    }
  }
  // 2. The rest, in the order written: inside a run a keypair's length that is 64 bytes whole, a key behind or
  // before one character ("2<key>"); inside a long run past its edges, a key glued on both sides ("<sig><key><sig>").
  for (const r of runs) {
    if (!r.long) {
      if (r.edge) continue;
      const key = sweep(r.run, w, 0, r.run.length, 0, r.run.length, r.min, true);
      if (Array.isArray(key)) found(r.at, r.run, key);
      continue;
    }
    const inside = (from: number) => sweep(r.run, w, from, r.hi, 0, r.hi - SECRET_GLUE - 1, r.min);
    for (let key = inside(r.lo + SECRET_GLUE + 1); Array.isArray(key); key = inside(key[1])) found(r.at, r.run, key);
  }
  const secrets = hits.sort((x, y) => x[0] - y[0]);
  for (const m of text.matchAll(BYTE_ARRAY_64)) {
    const span: [number, number] = [m.index, m.index + m[0].length];
    if (budget.left-- <= 0) secrets.push(span);
    else {
      const nums = m[0].slice(1, -1).split(",").map((x) => Number(x.trim()));
      if (nums.length === 64 && isSolanaKeypair(Uint8Array.from(nums))) secrets.push(span);
    }
  }
  return secrets;
}
