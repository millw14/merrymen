/**
 * THE LIGHTER SIGNER — the only code in merrymen that can produce a venue
 * transaction, and the narrowest door we could build around it.
 *
 * docs/perps.md is the contract ("signer.ts" under Worker). What sits behind
 * this file is Lighter's own Go signer compiled to WebAssembly (lighter-go
 * v1.0.9 `lighter-signer.wasm`, vendored under worker/vendor/lighter with the
 * go1.25.6 `wasm_exec.js` that matches it). There is no other implementation
 * of Lighter's Schnorr-over-ECgFp5 / Poseidon2 signature in JS, and a port
 * would be unaudited code on the money path, so we run theirs — and treat it
 * as a component that will do exactly what it is told, including the wrong
 * thing.
 *
 * WHY EVERY ARGUMENT IS OURS. The WASM does not validate JS numbers. Its
 * `safeInt*` helpers reject `undefined` and then cast `v.Int()`: a float is
 * truncated, a negative price wraps to 2^32−1 (an unbounded worst price for a
 * buy), market 65537 becomes market 1, marginMode 256 becomes CROSS, key index
 * 255 silently signs with whichever client was created last, and nonce −1 makes
 * it fetch a nonce over HTTP (spike-node22.json "coercion", coerce2.mjs). Its
 * own Validate() then passes the wrapped values, because they are in range. So
 * the guard lives here, in front of every call, and it is written against the
 * FIELD's meaning, not the Go type's range.
 *
 * WHY EVERY RESULT IS CHECKED. A guard in front proves what we asked for; it
 * does not prove what came back. After every signature the returned `tx_info`
 * is parsed and compared field by field — exact key set, exact values, the
 * nonce, the attributes — before anything may persist it (rule 9 writes the
 * exact bytes, so bytes that say something else would be persisted and sent).
 *
 * WHY A SANDBOX. `wasm_exec.js` installs the Go runtime's `globalThis`, and the
 * Go program registers ~24 functions on it — including SignTransfer,
 * SignCreateSubAccount, SignApproveIntegrator and SignChangePubKey, the very tx
 * types rule 2 says the worker never signs. Run in the worker's own realm,
 * every module in the process could call them. So both files run inside a
 * fresh `node:vm` context: its global has no `fetch`, no `require`, no real
 * `process` (wasm_exec installs a stub that throws ENOSYS) and no string eval.
 * The nine functions this module wraps are captured by reference and EVERY
 * registered global is deleted from the sandbox, so the only way to reach the
 * signer is the typed wrappers below. The sandbox also owns its own `Date`,
 * which is how the known-answer test freezes the signer's clock without
 * touching the worker's.
 *
 * WHAT THIS FILE DOES NOT PROVE. The binary has no public-key derivation
 * export, so nothing here can show a private key belongs to the sealed public
 * key; that proof is the arm-time read of /apikeys plus an authenticated read
 * (onboard.ts). The KAT proves the binary and chain id 466324 together; it
 * cannot prove anything about a key.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  LIGHTER_ROUTE_V1,
  PERP_COI_MAX,
  PERP_LEG,
  PERP_MAX_LEVERAGE,
  PERP_MAX_ORDER_PRICE,
  perpCoi,
  perpMarketById,
  validatePerpPubKey,
  type PerpLeg,
  type PerpSide,
} from "../../../packages/core/src/index";

// ── the artifact ────────────────────────────────────────────────────────────

/**
 * The pinned signer. Changing ANY of these is a signer upgrade, which is a
 * reviewed change with its own procedure (worker/vendor/lighter/README.md):
 * new hashes, a reproduce-from-source check, and the known-answer vectors
 * re-run against the new binary.
 *
 * v1.0.9 because it is the LAST release that ships the Node/Go-js build;
 * v1.0.10 only has the promise-style web build. `wasm/main.go` and the tx types
 * are unchanged between the two apart from the cancel-all market-index maximum.
 */
export const LIGHTER_SIGNER_ARTIFACT = Object.freeze({
  release: "lighter-go v1.0.9",
  commit: "8854554703385766c73410b43e93075447f36a4c",
  goVersion: "go1.25.6",
  wasmFile: "lighter-signer.wasm",
  wasmSha256: "781ba28b5e7fca1ea816f516f28fe2adbe704b734828e0c941025f8133bd7b4b",
  wasmBytes: 13_964_645,
  execFile: "wasm_exec.js",
  execSha256: "0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14",
});

/** worker/vendor/lighter, resolved from this file so it is right in a checkout, the npm package and the image. */
export const LIGHTER_VENDOR_DIR = fileURLToPath(new URL("../../vendor/lighter/", import.meta.url));

/** Lighter tx types this module can produce. Nothing else is reachable. */
export const LIGHTER_TX = Object.freeze({
  withdraw: 13,
  createOrder: 14,
  cancelOrder: 15,
  cancelAllOrders: 16,
  updateLeverage: 20,
  createGroupedOrders: 28,
} as const);
export type LighterTxType = (typeof LIGHTER_TX)[keyof typeof LIGHTER_TX];

/**
 * The URL handed to CreateClient. The Go client keeps it for the only two
 * paths that touch the network — a nonce of −1 and CheckClient — neither of
 * which this module can reach. `.invalid` never resolves (RFC 2606), so if a
 * future binary did find a way out, it would find nowhere to go.
 */
const SIGNER_URL = "https://signer.invalid";

/**
 * lighter-go's DefaultExpireTime: every Sign* call sets ExpiredAt to the WASM's
 * wall clock + 10 min − 1 s and takes no argument for it. Measured 598 997 ms
 * in the spike; the post-sign check accepts a second either side of it.
 */
const EXPIRED_AT_OFFSET_MS = 599_000;

/** The venue's 5% fat-finger band for a trigger order's execution price (errors 21733/21735). */
const TRIGGER_BAND_BPS = 500n;

/**
 * Order-expiry window for a stop or take-profit, in ms from our clock.
 *
 * The venue takes 5 min … 30 days, judged when the tx EXECUTES, which can be up
 * to ExpiredAt (≈10 min) after we sign. So the floor is 5 + 10 min: an expiry
 * that clears 5 min now can fail it by the time the sequencer reads it. The
 * ceiling gives back an hour for our clock running ahead of the sequencer's.
 * Contract stops use 28 days, well inside both. The signer itself enforces
 * neither bound (a 60-day child signed locally in the spike), so this is the
 * only place they are enforced before the venue.
 */
export const ORDER_EXPIRY_MIN_MS = 15 * 60_000;
export const ORDER_EXPIRY_MAX_MS = 30 * 86_400_000 - 3_600_000;

/**
 * Auth tokens: the venue refuses a deadline more than 8 h out. The WASM signs
 * any deadline, and a 0 deadline makes it pick now + 7 h by itself — so 0 is
 * refused like any other value we did not choose.
 */
export const AUTH_TOKEN_MAX_SEC = 8 * 3600;

/** Master accounts are < 2^47; sub-accounts start there. Rule 2: we never operate a sub-account. */
const MAX_MASTER_ACCOUNT_INDEX = 2n ** 47n - 1n;
/** With SkipNonce the venue requires 2^47 − 1 > nonce. */
const NONCE_CEILING = 2n ** 47n - 1n;
const MAX_BASE_AMOUNT = 2n ** 48n - 1n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
/** Our IMF floor from rule 6's 10x ceiling: ceil(10000 / 10). */
const MIN_IMF_BP = Math.ceil(10_000 / PERP_MAX_LEVERAGE);

// ── errors ──────────────────────────────────────────────────────────────────

/**
 * Hex runs long enough to be a key (a private key is 80 hex) or a signature.
 * Go error strings and console output pass through this before they reach an
 * Error message or a log line: nothing the signer says is trusted not to echo
 * an argument back.
 */
function redact(s: string): string {
  return s.replace(/(0x)?[0-9a-fA-F]{64,}/g, "[redacted-hex]").slice(0, 300);
}

export type SignerUnavailableReason = "artifact-missing" | "hash-mismatch" | "load-failed" | "kat-failed" | "exited" | "stale-client";

/**
 * The signer cannot be used: not loaded, not the pinned bytes, failed its
 * known-answer test, or its Go runtime has exited — or this client handle was
 * superseded by a newer createClient for the same account. Live perps stay
 * unarmed on any of these (the contract's "or live perps stay unarmed").
 */
export class SignerUnavailable extends Error {
  override readonly name = "SignerUnavailable";
  readonly kind = "signer-unavailable" as const;
  constructor(
    readonly reason: SignerUnavailableReason,
    message: string,
  ) {
    super(`lighter signer unavailable (${reason}): ${redact(message)}`);
  }
}

/** An argument failed a guard. Thrown BEFORE the WASM is called; nothing was signed. */
export class SignerArgumentError extends Error {
  override readonly name = "SignerArgumentError";
  readonly kind = "signer-argument" as const;
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`lighter signer refused ${field}: ${message}`);
  }
}

/**
 * The WASM returned something other than what was asked for. The signed bytes
 * are discarded — they must never reach the rule-9 row, let alone sendTx.
 */
export class SignerOutputMismatch extends Error {
  override readonly name = "SignerOutputMismatch";
  readonly kind = "signer-mismatch" as const;
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`lighter signer output mismatch at ${field}: ${redact(message)}`);
  }
}

/** The WASM's own validation refused the call (it returned {error}). */
export class SignerRejected extends Error {
  override readonly name = "SignerRejected";
  readonly kind = "signer-rejected" as const;
  constructor(readonly detail: string) {
    super(`lighter signer rejected the call: ${redact(detail)}`);
  }
}

// ── argument guards ─────────────────────────────────────────────────────────

type IntLike = number | bigint;

/**
 * One integer argument, as a JS number the WASM cannot mangle.
 *
 * number: Number.isSafeInteger or refused — no floats, NaN, ±Infinity. bigint:
 * range-checked FIRST, then converted, so a value past 2^53 is refused rather
 * than rounded. Anything else (strings, booleans, undefined) is refused: the
 * WASM panics on a string and treats `true` as 1.
 */
function int(field: string, v: unknown, min: bigint, max: bigint): number {
  let b: bigint;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new SignerArgumentError(field, "must be a safe integer");
    b = BigInt(v);
  } else if (typeof v === "bigint") {
    b = v;
  } else {
    throw new SignerArgumentError(field, `must be a number or bigint, got ${typeof v}`);
  }
  if (max > MAX_SAFE) max = MAX_SAFE;
  if (b < min || b > max) throw new SignerArgumentError(field, `out of range ${min}..${max}`);
  return Number(b);
}

function bool(field: string, v: unknown): 0 | 1 {
  if (typeof v !== "boolean") throw new SignerArgumentError(field, "must be a boolean");
  return v ? 1 : 0;
}

/** A market id this route may sign against: membership in LIGHTER_MARKETS_V1, never an id range. */
function marketId(field: string, v: unknown): number {
  const id = int(field, v, 0n, 32_767n);
  if (perpMarketById(id) === null) throw new SignerArgumentError(field, `market ${id} is not in LIGHTER_MARKETS_V1`);
  return id;
}

function price(field: string, v: unknown): number {
  return int(field, v, 1n, PERP_MAX_ORDER_PRICE);
}

function orderExpiry(field: string, v: unknown, nowMs: number): number {
  const now = Math.floor(nowMs);
  return int(field, v, BigInt(now + ORDER_EXPIRY_MIN_MS), BigInt(now + ORDER_EXPIRY_MAX_MS));
}

/**
 * A trigger order's execution bound against its trigger: a sell executes at or
 * below it, a buy at or above, and never more than the venue's 5% band away.
 * perps.ts' stopPrices/takePrices produce exactly this shape; anything else is
 * a price that was mangled on the way here, and the venue would reject it at
 * best — at worst, execute it.
 */
function triggerBand(field: string, isAsk: 0 | 1, trigger: number, px: number): void {
  const t = BigInt(trigger);
  const p = BigInt(px);
  const gap = isAsk === 1 ? t - p : p - t;
  if (gap < 0n) throw new SignerArgumentError(field, isAsk === 1 ? "a sell's price must be at or below its trigger" : "a buy's price must be at or above its trigger");
  if (gap * 10_000n > t * TRIGGER_BAND_BPS) throw new SignerArgumentError(field, "price is outside the venue's 5% band of the trigger");
}

export interface SignContext {
  /** Must equal the account the client was created for — a cross-check against a mixed-up handle. */
  accountIndex: IntLike;
  /** The nonce reserved for this tx, committed to the high-water BEFORE this call (rule 9). */
  nonce: IntLike;
  /** The persisted high-water the nonce was reserved against; the nonce must exceed it. */
  nonceHighWater: IntLike;
}

// ── what a signature returns ────────────────────────────────────────────────

export interface SignedLegIndex {
  role: "entry" | "sl" | "tp" | "close";
  leg: PerpLeg;
  clientOrderIndex: number;
}

/**
 * One signed venue tx, ready for the rule-9 `submitted` row. `txInfo` is the
 * exact string the WASM returned (signature included) — the only bytes that
 * may ever be sent, and the only ones that can be (the signature is
 * randomised, so a re-sign is a different tx with the same hash).
 */
export interface SignedLighterTx {
  txType: LighterTxType;
  txInfo: string;
  /** Poseidon2 digest, 80 lowercase hex, no 0x; known before sending. */
  txHash: string;
  accountIndex: number;
  apiKeyIndex: number;
  nonce: number;
  /** ms; parsed from txInfo, never computed by us (the WASM sets it). */
  expiredAt: number;
  marketId: number | null;
  /** Every client order index inside the tx, in tx order (rule 9 persists them all). */
  clientOrderIndexes: SignedLegIndex[];
}

// ── the raw functions and the sandbox ───────────────────────────────────────

export type RawName =
  | "GenerateAPIKey"
  | "CreateClient"
  | "CreateAuthToken"
  | "SignCreateOrder"
  | "SignCreateGroupedOrders"
  | "SignCancelOrder"
  | "SignCancelAllOrders"
  | "SignUpdateLeverage"
  | "SignWithdraw";

const RAW_NAMES: readonly RawName[] = [
  "GenerateAPIKey",
  "CreateClient",
  "CreateAuthToken",
  "SignCreateOrder",
  "SignCreateGroupedOrders",
  "SignCancelOrder",
  "SignCancelAllOrders",
  "SignUpdateLeverage",
  "SignWithdraw",
];

type RawFn = (...args: unknown[]) => unknown;
export type RawOut = Record<string, unknown>;

/**
 * TEST-ONLY seam: wraps each raw WASM call, seeing its arguments. The tests
 * use it to hand back a tampered `tx_info` (and prove the post-sign comparison
 * catches it) and to assert what actually crossed into the WASM — chain id
 * 466324, never a nonce of −1, never key index 255. Production never passes
 * it; it can only make the signer refuse more, because every check below runs
 * on whatever it returns.
 */
export type RawInterceptor = (name: RawName, args: readonly unknown[], call: () => unknown) => unknown;

export interface SignerOptions {
  /** Directory holding the pinned files; defaults to worker/vendor/lighter. */
  vendorDir?: string;
  /** The clock the guards AND the WASM read (default Date.now). */
  now?: () => number;
  /** See RawInterceptor. */
  interceptRaw?: RawInterceptor;
}

interface GoInstance {
  importObject: WebAssembly.Imports;
  exited: boolean;
  run(instance: WebAssembly.Instance): Promise<void>;
}

/**
 * The sandbox's console. wasm_exec routes Go's stdout/stderr here (a fatal
 * error or an exit code is worth seeing), redacted like everything else the
 * signer says.
 */
function sandboxConsole(): Record<string, (...a: unknown[]) => void> {
  const say = (...a: unknown[]) => {
    const line = a.map((x) => (typeof x === "string" ? x : String(x))).join(" ");
    console.warn(`[lighter-signer] ${redact(line)}`);
  };
  return { log: say, info: say, warn: say, error: say, debug: () => {} };
}

function sha256Hex(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

// ── known-answer vectors ────────────────────────────────────────────────────

export interface KnownAnswerVector {
  name: string;
  accountIndex: number;
  apiKeyIndex: number;
  marketIndex: number;
  clientOrderIndex: number;
  baseAmount: number;
  price: number;
  isAsk: 0 | 1;
  type: number;
  timeInForce: number;
  reduceOnly: 0 | 1;
  triggerPrice: number;
  orderExpiry: number;
  skipNonce: 0 | 1;
  nonce: number;
  expiredAt: number;
  txHash: string;
}

/**
 * Two LIVE Robinhood-instance CreateOrder txs, fetched from /api/v1/tx on
 * 2026-09-29 (worker/src/perps/fixtures/tx_*.json carry the full responses and
 * signer.test.ts pins these literals to them). One with SkipNonce {"4":1} —
 * the form we sign — and one with no attributes, so the attribute-hash path
 * and the plain path are both covered.
 *
 * WHY THIS PROVES THE CHAIN ID. The tx hash is Poseidon2 over (chainId, type,
 * nonce, ExpiredAt, fields…) and does not depend on the key or the (randomised)
 * signature. Signing the same fields with any key under 466324, with the
 * signer's clock frozen at ExpiredAt − 599 s, reproduces the venue's hash
 * exactly; under the binary's default 304 it does not. A wrong binary, a wrong
 * wasm_exec pairing or a wrong chain id all fail here, before a key is loaded.
 */
export const SIGNER_KNOWN_ANSWERS: readonly KnownAnswerVector[] = Object.freeze([
  Object.freeze({
    name: "rh-mainnet 1d806b89… (SkipNonce)",
    accountIndex: 6560,
    apiKeyIndex: 6,
    marketIndex: 26,
    clientOrderIndex: 696714356,
    baseAmount: 341171,
    price: 76473,
    isAsk: 1,
    type: 0,
    timeInForce: 0,
    reduceOnly: 0,
    triggerPrice: 0,
    orderExpiry: 0,
    skipNonce: 1,
    nonce: 1790696714356,
    expiredAt: 1790697314357,
    txHash: "1d806b896ed335c5c943e0beac9b5ab886a460c62c6aacdee5035b087ac5f4bb5e32507566babdd0",
  }),
  Object.freeze({
    name: "rh-mainnet 43de174b… (no attributes)",
    accountIndex: 26085,
    apiKeyIndex: 25,
    marketIndex: 1,
    clientOrderIndex: 37383932236154,
    baseAmount: 500,
    price: 831306,
    isAsk: 1,
    type: 0,
    timeInForce: 0,
    reduceOnly: 0,
    triggerPrice: 0,
    orderExpiry: 0,
    skipNonce: 0,
    nonce: 3063,
    expiredAt: 1790697120582,
    txHash: "43de174b14e98b35fce519602dee70feb317bc2950e49e685b5a5bc87e8d4b1eea2c598006acc8e2",
  }),
] as KnownAnswerVector[]);

// ── tx_info comparison ──────────────────────────────────────────────────────

type Expected = Record<string, number | Record<string, number> | ReadonlyArray<Record<string, number>> | null>;

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function sameKeys(field: string, got: Record<string, unknown>, want: readonly string[]): void {
  const g = Object.keys(got).sort();
  const w = [...want].sort();
  if (g.length !== w.length || g.some((k, i) => k !== w[i])) {
    throw new SignerOutputMismatch(field, `keys [${g.join(",")}] ≠ [${w.join(",")}]`);
  }
}

/**
 * Compare a parsed tx_info against the fields we asked for. EXACT key set at
 * every level, so a future binary that adds a field — or drops one — is a
 * mismatch rather than an unexamined byte in a signed tx. `Sig` and
 * `ExpiredAt` are the two fields we cannot predict, and are checked for shape
 * and window instead.
 */
function compareTxInfo(info: unknown, want: Expected): void {
  if (!isPlainObject(info)) throw new SignerOutputMismatch("txInfo", "not a JSON object");
  sameKeys("txInfo", info, [...Object.keys(want), "ExpiredAt", "Sig"]);
  for (const [k, w] of Object.entries(want)) {
    const g = info[k];
    if (w === null) {
      if (g !== null) throw new SignerOutputMismatch(k, `expected null, got ${JSON.stringify(g)}`);
    } else if (typeof w === "number") {
      if (g !== w) throw new SignerOutputMismatch(k, `expected ${w}, got ${JSON.stringify(g)}`);
    } else if (Array.isArray(w)) {
      if (!Array.isArray(g) || g.length !== w.length) throw new SignerOutputMismatch(k, "order list differs in length");
      w.forEach((wo, i) => {
        const go = g[i];
        if (!isPlainObject(go)) throw new SignerOutputMismatch(`${k}[${i}]`, "not an object");
        sameKeys(`${k}[${i}]`, go, Object.keys(wo));
        for (const [ok, ov] of Object.entries(wo)) {
          if (go[ok] !== ov) throw new SignerOutputMismatch(`${k}[${i}].${ok}`, `expected ${ov}, got ${JSON.stringify(go[ok])}`);
        }
      });
    } else {
      if (!isPlainObject(g)) throw new SignerOutputMismatch(k, `expected an object, got ${JSON.stringify(g)}`);
      const wo = w as Record<string, number>;
      sameKeys(k, g, Object.keys(wo));
      for (const [ok, ov] of Object.entries(wo)) {
        if (g[ok] !== ov) throw new SignerOutputMismatch(`${k}.${ok}`, `expected ${ov}, got ${JSON.stringify(g[ok])}`);
      }
    }
  }
  const sig = info.Sig;
  // 80-byte Schnorr signature, base64: 108 characters with one '=' of padding.
  if (typeof sig !== "string" || !/^[A-Za-z0-9+/]{107}=$/.test(sig) || Buffer.from(sig, "base64").length !== 80) {
    throw new SignerOutputMismatch("Sig", "not an 80-byte base64 signature");
  }
}

/** L2TxAttributes for everything we sign: SkipNonce only, plus the cancel-all market when scoped. */
function attrs(cancelAllMarket?: number): Record<string, number> {
  return cancelAllMarket === undefined ? { "4": 1 } : { "4": 1, "5": cancelAllMarket };
}

// ── the signer ──────────────────────────────────────────────────────────────

/** A client registered for one (account, route key index); created with chain id 466324, always. */
export interface LighterSignerClient {
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  /** The sealed public key this client was created for (recorded, not proven — see header). */
  readonly apiPublicKey: `0x${string}`;
  createAuthToken(deadlineSec: IntLike): string;
  signCreateOrder(order: CreateOrderArgs, ctx: SignContext): SignedLighterTx;
  signCreateGroupedOrders(open: GroupedOpenArgs, ctx: SignContext): SignedLighterTx;
  signCancelOrder(args: { marketId: IntLike; orderIndex: IntLike }, ctx: SignContext): SignedLighterTx;
  signCancelAllOrders(args: { marketId: IntLike }, ctx: SignContext): SignedLighterTx;
  signCancelAllOrdersAccountWide(args: { acknowledge: "removes-every-resting-stop" }, ctx: SignContext): SignedLighterTx;
  signUpdateLeverage(args: { marketId: IntLike; imfBp: IntLike; minImfBp: IntLike }, ctx: SignContext): SignedLighterTx;
  signWithdraw(args: { amountMicro: bigint; freeCollateralMicro: bigint }, ctx: SignContext): SignedLighterTx;
}

/**
 * A single order. There is deliberately NO opening variant: rule 7 makes every
 * open a grouped tx that carries its own stop, so the one door that could sign
 * a bare open does not exist. Everything here is reduce-only.
 *
 *   close        MARKET IOC reduce-only, worst price bound (leg 3). Exits,
 *                protective closes and stand-down.
 *   stop-loss /  a STOP_LOSS (2) / TAKE_PROFIT (4) IOC trigger, reduce-only.
 *   take-profit  baseAmount 0 (the default) is the position-tied form that
 *                closes the whole position — what protect.ts re-places.
 */
export type CreateOrderArgs =
  | { kind: "close"; marketId: IntLike; isAsk: boolean; baseAmount: IntLike; worstPrice: IntLike }
  | {
      kind: "stop-loss" | "take-profit";
      marketId: IntLike;
      isAsk: boolean;
      triggerPrice: IntLike;
      price: IntLike;
      orderExpiry: IntLike;
      baseAmount?: IntLike;
    };

/** A child of a grouped open: the venue sizes it to the executed parent (BaseAmount 0, reduce-only). */
export interface GroupedChildArgs {
  triggerPrice: IntLike;
  price: IntLike;
  orderExpiry: IntLike;
}

/**
 * An open (rule 7): OTO [IOC entry, SL] or, with a take-profit, OTOCO
 * [IOC entry, SL, TP]. `side` is the position being opened; the children sit
 * on the other side of the book.
 */
export interface GroupedOpenArgs {
  marketId: IntLike;
  side: PerpSide;
  baseAmount: IntLike;
  worstPrice: IntLike;
  stopLoss: GroupedChildArgs;
  takeProfit?: GroupedChildArgs;
}

export class LighterSigner {
  readonly #fns: Readonly<Record<RawName, RawFn>>;
  readonly #go: GoInstance;
  readonly #setFrozen: (ms: number | null) => void;
  readonly #now: () => number;
  readonly #intercept: RawInterceptor | undefined;
  readonly #clients = new Map<string, LighterSignerClient>();
  #dead: string | null = null;

  /** @internal — construct through instantiateSigner / loadSigner. */
  constructor(parts: {
    fns: Record<RawName, RawFn>;
    go: GoInstance;
    setFrozen: (ms: number | null) => void;
    now: () => number;
    intercept?: RawInterceptor;
    exited: Promise<unknown>;
  }) {
    this.#fns = Object.freeze({ ...parts.fns });
    this.#go = parts.go;
    this.#setFrozen = parts.setFrozen;
    this.#now = parts.now;
    this.#intercept = parts.intercept;
    // The Go program never returns on its own (main ends in `select {}`), so
    // this resolving means the runtime died — a fatal error, an OOM. Every
    // later call must refuse: a dead runtime throws on resume, and a half-dead
    // one is not something to sign money with.
    void parts.exited.then(
      () => this.#die("the Go runtime exited"),
      (e: unknown) => this.#die(`the Go runtime failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  get alive(): boolean {
    return this.#dead === null && !this.#go.exited;
  }

  #die(why: string): void {
    if (this.#dead === null) this.#dead = why;
    this.#clients.clear();
  }

  /**
   * The one path to the WASM. A returned {error} is the Go side refusing (its
   * own validation) and leaves the runtime healthy. A THROW is not: it is a
   * trap or a resume of an exited program, and the instance is condemned.
   */
  #invoke(name: RawName, args: unknown[]): RawOut {
    if (this.#dead !== null || this.#go.exited) {
      this.#die(this.#dead ?? "the Go runtime exited");
      throw new SignerUnavailable("exited", this.#dead ?? "the Go runtime exited");
    }
    const fn = this.#fns[name];
    let out: unknown;
    try {
      out = this.#intercept ? this.#intercept(name, Object.freeze([...args]), () => fn(...args)) : fn(...args);
    } catch (e) {
      this.#die(`${name} threw: ${e instanceof Error ? e.message : String(e)}`);
      throw new SignerUnavailable("exited", this.#dead ?? name);
    }
    if (this.#go.exited) {
      this.#die("the Go runtime exited during a call");
      throw new SignerUnavailable("exited", this.#dead ?? name);
    }
    if (!isPlainObject(out)) throw new SignerOutputMismatch(name, "the signer returned a non-object");
    if (typeof out.error === "string") throw new SignerRejected(out.error);
    return out;
  }

  /**
   * A fresh API key pair from the official signer (keygen route only).
   * The public key must pass validatePerpPubKey — the same canonical check the
   * wall seals with — or it is refused here rather than after an owner signs.
   */
  generateApiKey(): { privateKey: `0x${string}`; publicKey: `0x${string}` } {
    const out = this.#invoke("GenerateAPIKey", []);
    const priv = out.privateKey;
    const pub = out.publicKey;
    if (typeof priv !== "string" || !/^0x[0-9a-fA-F]{80}$/.test(priv) || /^0x0+$/.test(priv)) {
      throw new SignerOutputMismatch("privateKey", "not 0x + 80 hex");
    }
    const canonical = typeof pub === "string" ? validatePerpPubKey(pub) : null;
    if (canonical === null) throw new SignerOutputMismatch("publicKey", "not a canonical Lighter API public key");
    return { privateKey: priv.toLowerCase() as `0x${string}`, publicKey: canonical };
  }

  /** The registered client for an account, or null. */
  client(accountIndex: number): LighterSignerClient | null {
    return this.#clients.get(`${accountIndex}:${LIGHTER_ROUTE_V1.apiKeyIndex}`) ?? null;
  }

  /**
   * Register the key for (account, route key index) with chain id 466324.
   *
   * CreateClient does no network I/O and accepts a corrupted key silently
   * (0xff×40 returned {}), so the key is shape-checked here and never echoed:
   * no error from this function carries a byte of it. Re-creating a client
   * for the same pair replaces it (key rotation); the Go side does the same.
   */
  createClient(args: { accountIndex: IntLike; apiKeyIndex: IntLike; privateKey: string; apiPublicKey: string }): LighterSignerClient {
    const accountIndex = int("accountIndex", args.accountIndex, 1n, MAX_MASTER_ACCOUNT_INDEX);
    const apiKeyIndex = int("apiKeyIndex", args.apiKeyIndex, 0n, 254n);
    // Never 255: in the Go client that selects "the last client created for
    // this account" — a signature under whatever key happened to be loaded
    // last. Never anything but the route's index, which the wall pins.
    if (apiKeyIndex !== LIGHTER_ROUTE_V1.apiKeyIndex) {
      throw new SignerArgumentError("apiKeyIndex", `must be the route's key index ${LIGHTER_ROUTE_V1.apiKeyIndex}`);
    }
    if (typeof args.privateKey !== "string" || !/^0x[0-9a-fA-F]{80}$/.test(args.privateKey) || /^0x0+$/.test(args.privateKey)) {
      throw new SignerArgumentError("privateKey", "must be 0x followed by 80 hex characters (value not shown)");
    }
    const apiPublicKey = typeof args.apiPublicKey === "string" ? validatePerpPubKey(args.apiPublicKey) : null;
    if (apiPublicKey === null) throw new SignerArgumentError("apiPublicKey", "not a canonical Lighter API public key");
    this.#invoke("CreateClient", [SIGNER_URL, args.privateKey.toLowerCase(), LIGHTER_ROUTE_V1.l2ChainId, apiKeyIndex, accountIndex]);
    const client = this.#makeClient(accountIndex, apiKeyIndex, apiPublicKey);
    this.#clients.set(`${accountIndex}:${apiKeyIndex}`, client);
    return client;
  }

  /**
   * Re-sign the known-answer vectors with the signer's clock frozen and
   * require the live hashes (and every field, and ExpiredAt) byte for byte.
   * Uses a throwaway key: the hash does not depend on it. The KAT clients sit
   * at the vectors' own (account, key) pairs, which no wrapper can address
   * (they only ever pass the route's key index).
   */
  knownAnswerTest(): { ok: true } | { ok: false; detail: string } {
    try {
      const key = this.#invoke("GenerateAPIKey", []);
      if (typeof key.privateKey !== "string") return { ok: false, detail: "GenerateAPIKey returned no key" };
      for (const v of SIGNER_KNOWN_ANSWERS) {
        this.#invoke("CreateClient", [SIGNER_URL, key.privateKey, LIGHTER_ROUTE_V1.l2ChainId, v.apiKeyIndex, v.accountIndex]);
        let out: RawOut;
        this.#setFrozen(v.expiredAt - EXPIRED_AT_OFFSET_MS);
        try {
          out = this.#invoke("SignCreateOrder", [
            v.marketIndex,
            v.clientOrderIndex,
            v.baseAmount,
            v.price,
            v.isAsk,
            v.type,
            v.timeInForce,
            v.reduceOnly,
            v.triggerPrice,
            v.orderExpiry,
            0,
            0,
            0,
            0,
            0,
            v.skipNonce,
            v.nonce,
            v.apiKeyIndex,
            v.accountIndex,
          ]);
        } finally {
          this.#setFrozen(null);
        }
        if (out.txHash !== v.txHash) return { ok: false, detail: `${v.name}: tx_hash ${String(out.txHash).slice(0, 16)}… ≠ live ${v.txHash.slice(0, 16)}…` };
        if (out.txType !== LIGHTER_TX.createOrder) return { ok: false, detail: `${v.name}: txType ${String(out.txType)}` };
        if (typeof out.txInfo !== "string") return { ok: false, detail: `${v.name}: no txInfo` };
        const info: unknown = JSON.parse(out.txInfo);
        compareTxInfo(info, {
          AccountIndex: v.accountIndex,
          ApiKeyIndex: v.apiKeyIndex,
          MarketIndex: v.marketIndex,
          ClientOrderIndex: v.clientOrderIndex,
          BaseAmount: v.baseAmount,
          Price: v.price,
          IsAsk: v.isAsk,
          Type: v.type,
          TimeInForce: v.timeInForce,
          ReduceOnly: v.reduceOnly,
          TriggerPrice: v.triggerPrice,
          OrderExpiry: v.orderExpiry,
          Nonce: v.nonce,
          L2TxAttributes: v.skipNonce === 1 ? attrs() : null,
        });
        if (isPlainObject(info) && info.ExpiredAt !== v.expiredAt) return { ok: false, detail: `${v.name}: ExpiredAt ${String(info.ExpiredAt)}` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  #makeClient(accountIndex: number, apiKeyIndex: number, apiPublicKey: `0x${string}`): LighterSignerClient {
    const signer = this;
    const ensureCurrent = () => {
      if (!signer.alive) throw new SignerUnavailable("exited", "this client's signer has died; load a new signer and create a new client");
      if (signer.#clients.get(`${accountIndex}:${apiKeyIndex}`) !== client) {
        throw new SignerUnavailable("stale-client", "this client handle was replaced by a newer createClient for the same account");
      }
    };
    const checkCtx = (ctx: SignContext): number => {
      if (!isPlainObject(ctx)) throw new SignerArgumentError("ctx", "a sign context is required");
      const acct = int("ctx.accountIndex", ctx.accountIndex, 1n, MAX_MASTER_ACCOUNT_INDEX);
      if (acct !== accountIndex) throw new SignerArgumentError("ctx.accountIndex", `this client signs for account ${accountIndex}, not ${acct}`);
      // Nonce: explicit, strictly above the persisted high-water, below the
      // venue's SkipNonce ceiling. Never −1: that is the WASM's cue to fetch
      // one over HTTP (tx_client.go), and the only nonce that is not ours.
      const hw = int("ctx.nonceHighWater", ctx.nonceHighWater, 0n, NONCE_CEILING);
      const nonce = int("ctx.nonce", ctx.nonce, 1n, NONCE_CEILING - 1n);
      if (nonce <= hw) throw new SignerArgumentError("ctx.nonce", `must exceed the persisted high-water ${hw}`);
      return nonce;
    };
    const coi = (nonce: number, leg: PerpLeg): number => {
      try {
        return Number(perpCoi(BigInt(nonce), leg));
      } catch (e) {
        throw new SignerArgumentError("ctx.nonce", e instanceof Error ? e.message : "no client order index for this nonce");
      }
    };

    /**
     * Sign, then bind: the returned tx must be exactly the one requested. Any
     * difference throws SignerOutputMismatch and the bytes are dropped here.
     */
    const finish = (
      name: RawName,
      args: unknown[],
      txType: LighterTxType,
      nonce: number,
      want: Expected,
      marketIdOut: number | null,
      clientOrderIndexes: SignedLegIndex[],
    ): SignedLighterTx => {
      ensureCurrent();
      const before = signer.#now();
      const out = signer.#invoke(name, args);
      const after = signer.#now();
      if (out.txType !== txType) throw new SignerOutputMismatch("txType", `expected ${txType}, got ${String(out.txType)}`);
      const txInfo = out.txInfo;
      const txHash = out.txHash;
      if (typeof txInfo !== "string" || txInfo.length > 4096) throw new SignerOutputMismatch("txInfo", "missing or oversized");
      if (typeof txHash !== "string" || !/^[0-9a-f]{80}$/.test(txHash)) throw new SignerOutputMismatch("txHash", "not 80 lowercase hex");
      let info: unknown;
      try {
        info = JSON.parse(txInfo);
      } catch {
        throw new SignerOutputMismatch("txInfo", "not JSON");
      }
      compareTxInfo(info, want);
      const expiredAt = (info as Record<string, unknown>).ExpiredAt;
      // ExpiredAt is the WASM's clock + 599 s, and the WASM reads the same
      // clock the guards do. Outside the window means the binary's clock or its
      // expiry rule is not the one the replay model (rule 9) was built on.
      if (
        typeof expiredAt !== "number" ||
        !Number.isSafeInteger(expiredAt) ||
        expiredAt < before + EXPIRED_AT_OFFSET_MS - 1_000 ||
        expiredAt > after + EXPIRED_AT_OFFSET_MS + 1_000
      ) {
        throw new SignerOutputMismatch("ExpiredAt", `${String(expiredAt)} is not the signer clock + 599 s`);
      }
      return { txType, txInfo, txHash, accountIndex, apiKeyIndex, nonce, expiredAt, marketId: marketIdOut, clientOrderIndexes };
    };

    const orderFields = (o: {
      market: number;
      coi: number;
      base: number;
      px: number;
      isAsk: 0 | 1;
      type: number;
      tif: number;
      ro: 0 | 1;
      trig: number;
      exp: number;
    }) => ({
      MarketIndex: o.market,
      ClientOrderIndex: o.coi,
      BaseAmount: o.base,
      Price: o.px,
      IsAsk: o.isAsk,
      Type: o.type,
      TimeInForce: o.tif,
      ReduceOnly: o.ro,
      TriggerPrice: o.trig,
      OrderExpiry: o.exp,
    });

    const client: LighterSignerClient = Object.freeze({
      accountIndex,
      apiKeyIndex,
      apiPublicKey,

      createAuthToken(deadlineSec: IntLike): string {
        ensureCurrent();
        const nowSec = Math.floor(signer.#now() / 1000);
        const deadline = int("deadlineSec", deadlineSec, BigInt(nowSec + 1), BigInt(nowSec + AUTH_TOKEN_MAX_SEC));
        const out = signer.#invoke("CreateAuthToken", [deadline, apiKeyIndex, accountIndex]);
        const token = out.authToken;
        // "<deadline>:<account>:<keyIndex>:<160 hex>". A token naming another
        // account, key or deadline would authenticate something we did not ask
        // for; the message never includes the token.
        const parts = typeof token === "string" ? token.split(":") : [];
        if (
          parts.length !== 4 ||
          parts[0] !== String(deadline) ||
          parts[1] !== String(accountIndex) ||
          parts[2] !== String(apiKeyIndex) ||
          !/^[0-9a-f]{160}$/.test(parts[3] ?? "")
        ) {
          throw new SignerOutputMismatch("authToken", "not <deadline>:<account>:<keyIndex>:<160 hex> for this client");
        }
        return token as string;
      },

      signCreateOrder(order: CreateOrderArgs, ctx: SignContext): SignedLighterTx {
        const nonce = checkCtx(ctx);
        if (!isPlainObject(order)) throw new SignerArgumentError("order", "required");
        const market = marketId("marketId", order.marketId);
        const isAsk = bool("isAsk", order.isAsk);
        let f: Parameters<typeof orderFields>[0];
        let role: SignedLegIndex["role"];
        let leg: PerpLeg;
        if (order.kind === "close") {
          // MARKET (1), IOC (0), no trigger, no expiry: lighter-go requires
          // exactly that shape for a market order. Base > 0: a close names a size.
          leg = PERP_LEG.close;
          role = "close";
          f = {
            market,
            coi: coi(nonce, leg),
            base: int("baseAmount", order.baseAmount, 1n, MAX_BASE_AMOUNT),
            px: price("worstPrice", order.worstPrice),
            isAsk,
            type: 1,
            tif: 0,
            ro: 1,
            trig: 0,
            exp: 0,
          };
        } else if (order.kind === "stop-loss" || order.kind === "take-profit") {
          leg = order.kind === "stop-loss" ? PERP_LEG.sl : PERP_LEG.tp;
          role = order.kind === "stop-loss" ? "sl" : "tp";
          const trig = price("triggerPrice", order.triggerPrice);
          const px = price("price", order.price);
          triggerBand("price", isAsk, trig, px);
          f = {
            market,
            coi: coi(nonce, leg),
            // 0 is the position-tied form (closes whatever is held); it is only
            // legal because this order is reduce-only, which it always is.
            base: order.baseAmount === undefined ? 0 : int("baseAmount", order.baseAmount, 0n, MAX_BASE_AMOUNT),
            px,
            isAsk,
            type: order.kind === "stop-loss" ? 2 : 4,
            tif: 0,
            ro: 1,
            trig,
            exp: orderExpiry("orderExpiry", order.orderExpiry, signer.#now()),
          };
        } else {
          throw new SignerArgumentError("kind", "must be close, stop-loss or take-profit (opens are grouped orders only)");
        }
        const args = [f.market, f.coi, f.base, f.px, f.isAsk, f.type, f.tif, f.ro, f.trig, f.exp, 0, 0, 0, 0, 0, 1, nonce, apiKeyIndex, accountIndex];
        return finish(
          "SignCreateOrder",
          args,
          LIGHTER_TX.createOrder,
          nonce,
          { AccountIndex: accountIndex, ApiKeyIndex: apiKeyIndex, ...orderFields(f), Nonce: nonce, L2TxAttributes: attrs() },
          market,
          [{ role, leg, clientOrderIndex: f.coi }],
        );
      },

      signCreateGroupedOrders(open: GroupedOpenArgs, ctx: SignContext): SignedLighterTx {
        const nonce = checkCtx(ctx);
        if (!isPlainObject(open)) throw new SignerArgumentError("open", "required");
        const market = marketId("marketId", open.marketId);
        if (open.side !== "long" && open.side !== "short") throw new SignerArgumentError("side", "must be long or short");
        // The entry buys to open a long, sells to open a short; the children
        // sit on the other side (lighter-go rejects a same-side child).
        const entryAsk: 0 | 1 = open.side === "short" ? 1 : 0;
        const childAsk: 0 | 1 = entryAsk === 1 ? 0 : 1;
        const worst = price("worstPrice", open.worstPrice);
        const base = int("baseAmount", open.baseAmount, 1n, MAX_BASE_AMOUNT);
        const now = signer.#now();
        if (!isPlainObject(open.stopLoss)) throw new SignerArgumentError("stopLoss", "every open carries a stop (rule 7)");
        const slTrig = price("stopLoss.triggerPrice", open.stopLoss.triggerPrice);
        const slPx = price("stopLoss.price", open.stopLoss.price);
        const slExp = orderExpiry("stopLoss.orderExpiry", open.stopLoss.orderExpiry, now);
        triggerBand("stopLoss.price", childAsk, slTrig, slPx);
        // The stop must sit on the LOSING side of the worst entry price: a
        // long's stop below it, a short's above. A stop on the other side fires
        // the moment the position exists and closes it at a loss.
        if (open.side === "long" ? slTrig >= worst : slTrig <= worst) {
          throw new SignerArgumentError("stopLoss.triggerPrice", "must be on the losing side of the entry's worst price");
        }
        const entry = { market, coi: coi(nonce, PERP_LEG.entry), base, px: worst, isAsk: entryAsk, type: 1, tif: 0, ro: 0 as const, trig: 0, exp: 0 };
        const sl = { market, coi: coi(nonce, PERP_LEG.sl), base: 0, px: slPx, isAsk: childAsk, type: 2, tif: 0, ro: 1 as const, trig: slTrig, exp: slExp };
        const legs = [entry, sl];
        const indexes: SignedLegIndex[] = [
          { role: "entry", leg: PERP_LEG.entry, clientOrderIndex: entry.coi },
          { role: "sl", leg: PERP_LEG.sl, clientOrderIndex: sl.coi },
        ];
        let grouping = 1; // OTO
        if (open.takeProfit !== undefined) {
          if (!isPlainObject(open.takeProfit)) throw new SignerArgumentError("takeProfit", "must be an object when present");
          const tpTrig = price("takeProfit.triggerPrice", open.takeProfit.triggerPrice);
          const tpPx = price("takeProfit.price", open.takeProfit.price);
          const tpExp = orderExpiry("takeProfit.orderExpiry", open.takeProfit.orderExpiry, now);
          triggerBand("takeProfit.price", childAsk, tpTrig, tpPx);
          if (open.side === "long" ? tpTrig <= worst : tpTrig >= worst) {
            throw new SignerArgumentError("takeProfit.triggerPrice", "must be on the winning side of the entry's worst price");
          }
          // Siblings expire together, so the stop never outlives its take (or
          // the reverse) and protect.ts has one date to watch.
          if (tpExp !== slExp) throw new SignerArgumentError("takeProfit.orderExpiry", "must equal the stop's orderExpiry");
          const tp = { market, coi: coi(nonce, PERP_LEG.tp), base: 0, px: tpPx, isAsk: childAsk, type: 4, tif: 0, ro: 1 as const, trig: tpTrig, exp: tpExp };
          legs.push(tp);
          indexes.push({ role: "tp", leg: PERP_LEG.tp, clientOrderIndex: tp.coi });
          grouping = 3; // OTOCO
        }
        const orders = legs.map(orderFields);
        return finish(
          "SignCreateGroupedOrders",
          [grouping, orders.map((o) => ({ ...o })), 0, 0, 0, 0, 0, 1, nonce, apiKeyIndex, accountIndex],
          LIGHTER_TX.createGroupedOrders,
          nonce,
          { AccountIndex: accountIndex, ApiKeyIndex: apiKeyIndex, GroupingType: grouping, Orders: orders, Nonce: nonce, L2TxAttributes: attrs() },
          market,
          indexes,
        );
      },

      signCancelOrder(args: { marketId: IntLike; orderIndex: IntLike }, ctx: SignContext): SignedLighterTx {
        const nonce = checkCtx(ctx);
        if (!isPlainObject(args)) throw new SignerArgumentError("args", "required");
        const market = marketId("marketId", args.marketId);
        // A venue order index (≥ 2^48) or a client order index (1..2^48−1). The
        // WASM takes it as a JS number, so an index past 2^53 cannot be passed
        // exactly and is refused; cancel-all for the market covers that case.
        const index = int("orderIndex", args.orderIndex, 1n, MAX_SAFE);
        return finish(
          "SignCancelOrder",
          [market, index, 1, nonce, apiKeyIndex, accountIndex],
          LIGHTER_TX.cancelOrder,
          nonce,
          { AccountIndex: accountIndex, ApiKeyIndex: apiKeyIndex, MarketIndex: market, Index: index, Nonce: nonce, L2TxAttributes: attrs() },
          market,
          [],
        );
      },

      signCancelAllOrders(args: { marketId: IntLike }, ctx: SignContext): SignedLighterTx {
        const nonce = checkCtx(ctx);
        if (!isPlainObject(args)) throw new SignerArgumentError("args", "required");
        const market = marketId("marketId", args.marketId);
        // Immediate (TimeInForce 0) and scoped to one market (attribute 5):
        // the stand-down cancels a market's leftovers only once that market
        // reads flat (rule 13), and a scoped cancel cannot reach another
        // market's stops. The scheduled form (TIF 1, the dead-man switch) is
        // never signed: it would remove every stop while positions stay open.
        // 255 is lighter-go's "no market"; no market in the table is 255.
        return finish(
          "SignCancelAllOrders",
          [0, 0, market, 1, nonce, apiKeyIndex, accountIndex],
          LIGHTER_TX.cancelAllOrders,
          nonce,
          { AccountIndex: accountIndex, ApiKeyIndex: apiKeyIndex, TimeInForce: 0, Time: 0, Nonce: nonce, L2TxAttributes: attrs(market) },
          market,
          [],
        );
      },

      /**
       * EVERY order on the account, every market — resting stops included.
       *
       * For the incident stand-down (rule 16) only: a compromised key may have
       * left orders in markets this worker never trades, and a scoped cancel
       * cannot reach them. It is a separate function with a literal
       * acknowledgement so no call site can reach it by passing the wrong
       * market. Call it only once every market reads flat, or after the owner
       * has accepted losing the stops — rule 13 never removes a stop from an
       * open position.
       */
      signCancelAllOrdersAccountWide(args: { acknowledge: "removes-every-resting-stop" }, ctx: SignContext): SignedLighterTx {
        const nonce = checkCtx(ctx);
        if (!isPlainObject(args) || args.acknowledge !== "removes-every-resting-stop") {
          throw new SignerArgumentError("acknowledge", 'must be "removes-every-resting-stop"');
        }
        return finish(
          "SignCancelAllOrders",
          [0, 0, 255, 1, nonce, apiKeyIndex, accountIndex],
          LIGHTER_TX.cancelAllOrders,
          nonce,
          { AccountIndex: accountIndex, ApiKeyIndex: apiKeyIndex, TimeInForce: 0, Time: 0, Nonce: nonce, L2TxAttributes: attrs() },
          null,
          [],
        );
      },

      signUpdateLeverage(args: { marketId: IntLike; imfBp: IntLike; minImfBp: IntLike }, ctx: SignContext): SignedLighterTx {
        const nonce = checkCtx(ctx);
        if (!isPlainObject(args)) throw new SignerArgumentError("args", "required");
        const market = marketId("marketId", args.marketId);
        const minImf = int("minImfBp", args.minImfBp, 1n, 10_000n);
        // Never above 10x (rule 6), never below the market's own minimum IMF.
        const floor = Math.max(minImf, MIN_IMF_BP);
        const imf = int("imfBp", args.imfBp, BigInt(floor), 10_000n);
        // MarginMode is always 1 (isolated) and not a parameter: the WASM casts
        // it with uint8(), so 256 would be signed as CROSS, silently undoing
        // the isolated-per-market model every margin number here assumes.
        return finish(
          "SignUpdateLeverage",
          [market, imf, 1, 1, nonce, apiKeyIndex, accountIndex],
          LIGHTER_TX.updateLeverage,
          nonce,
          { AccountIndex: accountIndex, ApiKeyIndex: apiKeyIndex, MarketIndex: market, InitialMarginFraction: imf, MarginMode: 1, Nonce: nonce, L2TxAttributes: attrs() },
          market,
          [],
        );
      },

      signWithdraw(args: { amountMicro: bigint; freeCollateralMicro: bigint }, ctx: SignContext): SignedLighterTx {
        const nonce = checkCtx(ctx);
        if (!isPlainObject(args)) throw new SignerArgumentError("args", "required");
        if (typeof args.freeCollateralMicro !== "bigint" || args.freeCollateralMicro < 1n) {
          throw new SignerArgumentError("freeCollateralMicro", "must be a positive bigint (the last venue read)");
        }
        // A SECURE withdrawal (tx 13): it has no destination field and can only
        // pay the account's L1 address — our own smart account. USDG (asset 3)
        // on the perps route (0), from the frozen route, never parameters.
        const amount = int("amountMicro", args.amountMicro, 1n, args.freeCollateralMicro);
        return finish(
          "SignWithdraw",
          [LIGHTER_ROUTE_V1.assetIndex, LIGHTER_ROUTE_V1.routePerps, amount, 1, nonce, apiKeyIndex, accountIndex],
          LIGHTER_TX.withdraw,
          nonce,
          {
            FromAccountIndex: accountIndex,
            ApiKeyIndex: apiKeyIndex,
            AssetIndex: LIGHTER_ROUTE_V1.assetIndex,
            RouteType: LIGHTER_ROUTE_V1.routePerps,
            Amount: amount,
            Nonce: nonce,
            L2TxAttributes: attrs(),
          },
          null,
          [],
        );
      },
    });
    return client;
  }
}

// ── loading ─────────────────────────────────────────────────────────────────

async function readPinned(file: string, expected: string): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(file));
  } catch (e) {
    throw new SignerUnavailable("artifact-missing", `${path.basename(file)} unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }
  const got = sha256Hex(bytes);
  if (got !== expected) throw new SignerUnavailable("hash-mismatch", `${path.basename(file)} sha256 ${got} ≠ pinned ${expected}`);
  return bytes;
}

/**
 * Build a signer from the pinned files: hash both, run exactly the bytes that
 * were hashed (no second read between check and use), instantiate inside a
 * fresh vm context, strip the context's globals, and pass the KAT — or throw
 * SignerUnavailable. ~50 ms and ~70 MB RSS, which is why it is lazy (paper
 * perps never call this; see loadSigner).
 */
export async function instantiateSigner(opts: SignerOptions = {}): Promise<LighterSigner> {
  const dir = opts.vendorDir ?? LIGHTER_VENDOR_DIR;
  const execBytes = await readPinned(path.join(dir, LIGHTER_SIGNER_ARTIFACT.execFile), LIGHTER_SIGNER_ARTIFACT.execSha256);
  const wasmBytes = await readPinned(path.join(dir, LIGHTER_SIGNER_ARTIFACT.wasmFile), LIGHTER_SIGNER_ARTIFACT.wasmSha256);
  const now = opts.now ?? (() => Date.now());

  let go: GoInstance;
  let exited: Promise<unknown>;
  let fns: Record<RawName, RawFn>;
  let setFrozen: (ms: number | null) => void;
  try {
    // What the Go runtime gets to see. Timers are unref'd so a loaded signer
    // never keeps the worker (or a test process) alive by itself.
    const sandbox: Record<string, unknown> = {
      crypto: globalThis.crypto,
      performance: globalThis.performance,
      TextEncoder,
      TextDecoder,
      console: sandboxConsole(),
      setTimeout: (fn: () => void, ms: number) => {
        const t = setTimeout(fn, ms);
        t.unref();
        return t;
      },
      clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
    };
    const ctx = vm.createContext(sandbox, { name: "lighter-signer", codeGeneration: { strings: false, wasm: true } });

    // The sandbox's own Date, driven by our clock, freezable for the KAT. The
    // Go runtime reads wall time through `new Date` and `Date.now` (wasm_exec
    // runtime.walltime), which is where ExpiredAt comes from.
    let frozen: number | null = null;
    const installClock = vm.runInContext(
      `(function (clock) {
        const RealDate = Date;
        class SignerDate extends RealDate {
          constructor(...a) { if (a.length === 0) super(clock()); else super(...a); }
          static now() { return clock(); }
        }
        globalThis.Date = SignerDate;
      })`,
      ctx,
    ) as (clock: () => number) => void;
    installClock(() => (frozen !== null ? frozen : now()));
    setFrozen = (ms) => {
      frozen = ms;
    };

    vm.runInContext(new TextDecoder().decode(execBytes), ctx, { filename: "wasm_exec.js" });
    const GoCtor = vm.runInContext("Go", ctx) as new () => GoInstance;
    go = new GoCtor();
    // The sandbox's WebAssembly, because wasm_exec checks
    // `instance instanceof WebAssembly.Instance` against its own realm.
    const SandboxWasm = vm.runInContext("WebAssembly", ctx) as typeof WebAssembly;
    const { instance } = await SandboxWasm.instantiate(wasmBytes as BufferSource, go.importObject);
    const g = ctx as Record<string, unknown>;
    const before = new Set(Object.keys(g));
    exited = go.run(instance);

    const captured: Partial<Record<RawName, RawFn>> = {};
    for (const n of RAW_NAMES) {
      const f = g[n];
      if (typeof f !== "function") throw new Error(`the signer did not register ${n}`);
      captured[n] = f as RawFn;
    }
    // Strip EVERYTHING the Go program put on its global — Transfer,
    // sub-accounts, ChangePubKey, ModifyOrder, integrators, pools, CheckClient
    // — and the nine we keep. By difference, not by name, so a function a
    // future binary adds is removed without anyone listing it. What is not on
    // the sandbox global cannot be called by anything that reaches the context.
    for (const k of Object.keys(g)) {
      if (!before.has(k)) delete g[k];
    }
    fns = captured as Record<RawName, RawFn>;
  } catch (e) {
    if (e instanceof SignerUnavailable) throw e;
    throw new SignerUnavailable("load-failed", e instanceof Error ? e.message : String(e));
  }

  const signer = new LighterSigner({ fns, go, setFrozen, now, intercept: opts.interceptRaw, exited });
  const kat = signer.knownAnswerTest();
  // A wrong answer from a live runtime is the bytes disagreeing with the
  // venue — deterministic, and final (see signerLoader). A runtime that DIED
  // during the KAT (an OOM, a trap) proved nothing about the bytes, so it is
  // reported as the transient failure it is and the next load may retry.
  if (!kat.ok) throw new SignerUnavailable(signer.alive ? "kat-failed" : "exited", kat.detail);
  return signer;
}

/** The load-time known-answer test, callable on any signer (tests, `doctor`). */
export function runSignerKnownAnswerTest(signer: LighterSigner): { ok: true } | { ok: false; detail: string } {
  return signer.knownAnswerTest();
}

/**
 * How long a retryable load failure is served from cache before the next call
 * builds again. Short, because an exit (rule 8, 8a, 13) must stay attemptable
 * — protect.ts, owner closes, the stand-down and the secure withdrawal all sign
 * through this — but not zero, so a broken host does not re-read and re-hash
 * 14 MB on every tick of every lane.
 */
export const SIGNER_RETRY_AFTER_MS = 15_000;

export interface SignerLoaderOptions extends SignerOptions {
  /** The clock the retry backoff reads (default Date.now). */
  loaderNow?: () => number;
  /** Default SIGNER_RETRY_AFTER_MS. */
  retryAfterMs?: number;
}

/**
 * A lazy, shared signer: instantiated on first use and handed to every caller
 * after that. Exported for tests; the process uses `loadSigner`.
 *
 * Which failures are final. Only `kat-failed`: the bytes were hash-verified,
 * the runtime was alive, and the venue's own answers still did not come out —
 * the same bytes and the same code give the same wrong answer on every retry,
 * so it is kept for the life of the process and live perps stay unarmed.
 * Everything else is retried after SIGNER_RETRY_AFTER_MS, because none of it
 * is a property of the pinned bytes: `artifact-missing` is any readFile error
 * (EMFILE, EIO, a file absent for a moment during an in-place upgrade);
 * `load-failed` includes a WebAssembly allocation failure; `exited` is a
 * runtime that died; and even `hash-mismatch` can be a file read half-way
 * through being replaced. A retry can never accept wrong bytes — it re-hashes
 * and re-runs the KAT from scratch — so retrying only costs IO, while caching
 * a transient rejection would leave every exit unsignable until a restart
 * (only the stops already resting at the venue would remain).
 *
 * A signer whose Go runtime has since died is NOT reused — the next call
 * builds a fresh one (fresh hashes, fresh KAT), and callers re-create their
 * clients from the keystore.
 */
export function signerLoader(opts: SignerLoaderOptions = {}): () => Promise<LighterSigner> {
  const { loaderNow, retryAfterMs, ...signerOpts } = opts;
  const clock = loaderNow ?? (() => Date.now());
  const backoff = retryAfterMs ?? SIGNER_RETRY_AFTER_MS;
  let shared: Promise<LighterSigner> | null = null;
  // When the cached (retryable) failure in `shared` may be retried. Set by the
  // attempt's own rejection handler, which runs before any caller's handler
  // because it is attached first.
  let retryAt = 0;

  const start = (): Promise<LighterSigner> => {
    const attempt = instantiateSigner(signerOpts).catch((e: unknown) => {
      retryAt = clock() + backoff;
      throw e;
    });
    shared = attempt;
    return attempt;
  };

  return () => {
    const current = shared;
    if (current === null) return start();
    return current.then(
      (s) => {
        if (s.alive) return s;
        // Another caller may already have started the replacement; share it.
        if (shared !== null && shared !== current) return shared;
        return start();
      },
      (e: unknown) => {
        if (shared !== null && shared !== current) return shared;
        if (e instanceof SignerUnavailable && e.reason === "kat-failed") throw e;
        if (clock() < retryAt) throw e;
        return start();
      },
    );
  };
}

/** The process's signer. See signerLoader for what is shared and what is retried. */
export const loadSigner: () => Promise<LighterSigner> = signerLoader();
