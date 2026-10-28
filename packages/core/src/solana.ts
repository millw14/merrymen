/**
 * The Solana paper boundary. These values describe simulated ExactIn swaps;
 * they confer no wallet authority and cannot select a live execution mode.
 * Amounts are SPL base units, kept as strings at the wire and bigint in math.
 */
import { CHAINS, SOLANA_USDG_MINT, canonicalId } from "./ids";

export const SOLANA_SLIPPAGE_BPS_MAX = 100;
export const SOLANA_QUOTE_MAX_AGE_MS = 30_000;
/**
 * Refused activation, for good: the vault's session epoch moved more than this registration's own
 * landing since it was prepared (a revocation landed before it, beside it or outside Merrymen). Epochs
 * only rise, so it is never activated: the page drops its session key. Here, not in the worker's trading
 * store (which says it), so the page can recognise it without importing the store.
 */
export const SOLANA_REGISTERED_AFTER_REVOKE = "A revocation or another permission landed on Solana after this permission was prepared, so it is not activated. If it is still active on Solana, revoke again, then prepare a new permission.";
const U64_MAX = 18_446_744_073_709_551_615n;

/** Safe to show at a CLI boundary; messages never interpolate caller values. */
export class SolanaPaperValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolanaPaperValidationError";
  }
}

export interface SolanaPaperLimits {
  /** Integer micro-USDG (six decimals), not display dollars. */
  perTradeUsdg: string;
  /** Integer micro-USDG over the paper book's rolling 24-hour window. */
  dailyUsdg: string;
  maxOpsPerDay: number;
  maxDrawdownBps: number;
  expiresAtMs: number;
  /**
   * Integer lamports of wrapped SOL one sell may put in, and over the rolling
   * 24 hours. Live vault sessions require both: the vault charges every sell's
   * input against them, so a dust quote cannot empty the position.
   */
  perTradeWsol?: string;
  dailyWsol?: string;
}

export interface SolanaSwapIntent {
  kind: "spl-swap";
  chain: typeof CHAINS.solana;
  mode: "paper";
  /** Unique within the owner's book; the durable ledger enforces replay safety. */
  requestId: string;
  inputMint: string;
  outputMint: string;
  amountRaw: string;
  slippageBps: number;
}

/** A provider-normalized ExactIn quote, never a transaction or fill receipt. */
export interface SolanaQuote {
  source: "jupiter";
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  minOutAmount: string;
  slippageBps: number;
  contextSlot: number;
  quotedAtMs: number;
  expiresAtMs: number;
}

export interface SolanaMint {
  address: string;
  program: string;
  decimals: number;
  slot: number;
  observedAtMs: number;
  buyBlockedReasons: readonly string[];
}

function record(value: unknown, keys: readonly string[], label: string, optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SolanaPaperValidationError(`${label} must be an object`);
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !keys.includes(key) && !optional.includes(key)) || keys.some((key) => !Object.hasOwn(input, key))) {
    throw new SolanaPaperValidationError(`${label} has missing or unsupported fields`);
  }
  return input;
}

function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new SolanaPaperValidationError(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  return integer(value, 0, Number.MAX_SAFE_INTEGER, label);
}

function publicKey(value: unknown, label: string): string {
  // canonicalId deliberately trims UI input; execution boundaries do not.
  if (typeof value !== "string" || value.length > 44 || canonicalId(CHAINS.solana, "account", value) !== value) {
    throw new SolanaPaperValidationError(`${label} must be a canonical Solana public key`);
  }
  return value;
}

/** Bounded before BigInt parsing; numbers, fractions, signs and leading zeros fail. */
export function parseSolanaRawAmount(value: unknown, allowZero = false): bigint {
  if (typeof value !== "string" || value.length > 20 || value.trim() !== value || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new SolanaPaperValidationError("Solana raw amount must be a canonical integer string");
  }
  const amount = BigInt(value);
  if (amount > U64_MAX || (!allowZero && amount === 0n)) {
    throw new SolanaPaperValidationError(`Solana raw amount must be ${allowZero ? "nonnegative" : "positive"} and fit u64`);
  }
  return amount;
}

export function parseSolanaSwapIntent(value: unknown): SolanaSwapIntent {
  const input = record(value, ["kind", "chain", "mode", "requestId", "inputMint", "outputMint", "amountRaw", "slippageBps"], "Solana swap intent");
  if (input.kind !== "spl-swap" || input.chain !== CHAINS.solana || input.mode !== "paper") {
    throw new SolanaPaperValidationError("Solana swaps require spl-swap, Solana mainnet and paper mode");
  }
  if (typeof input.requestId !== "string" || input.requestId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(input.requestId) || input.requestId.trim() !== input.requestId) {
    throw new SolanaPaperValidationError("Solana requestId must contain 1–128 ASCII letters, digits, hyphens or underscores, starting with a letter or digit");
  }
  const inputMint = publicKey(input.inputMint, "inputMint");
  const outputMint = publicKey(input.outputMint, "outputMint");
  if ((inputMint === SOLANA_USDG_MINT) === (outputMint === SOLANA_USDG_MINT)) {
    throw new SolanaPaperValidationError("Solana paper swaps require exactly one USDG leg");
  }
  parseSolanaRawAmount(input.amountRaw);
  return {
    kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: input.requestId,
    inputMint, outputMint, amountRaw: input.amountRaw as string,
    slippageBps: integer(input.slippageBps, 0, SOLANA_SLIPPAGE_BPS_MAX, "slippageBps"),
  };
}

/**
 * The vault program's daily operation cap (risk.rs MAX_OPS, solana-live
 * SOLANA_VAULT_MAX_DAILY_OPS). A live session cannot be created above it.
 */
export const SOLANA_MAX_OPS_PER_DAY = 96;
/** The longest trading permission Merrymen grants: 168 hours. */
export const SOLANA_MAX_PERMISSION_MS = 168 * 3_600_000;
/** A duration picked against the browser's clock may run this far past the cap. */
export const SOLANA_PERMISSION_CLOCK_SKEW_MS = 5 * 60_000;
/**
 * The least a live trade may be worth, in raw USDG at the independent
 * reference price: 1 USDG. One shared, platform-funded fee payer pays every
 * live swap's signature and priority fees, so no tenant trades dust at its
 * expense. A sale of the whole booked SOL position is exempt, so a position
 * that fell below it can still be exited.
 */
export const SOLANA_LIVE_MIN_TRADE_USDG_RAW = 1_000_000n;
export const SOLANA_LIVE_BELOW_MINIMUM = "A live Solana trade must be worth at least 1 USDG, unless it sells the whole recorded SOL position.";
/**
 * Live limits and strategies that could only make trades below the live
 * minimum are refused where they are saved and registered, never later at a
 * trade: a per-trade USDG limit under 1 USDG lets no buy through and no sale
 * but a whole small position (requireSolanaLiveTradeMinimum, at the settings
 * route and prepareLive), and a strategy trade under 1 USDG is refused the
 * same way (the strategy route). The SOL sold per trade is checked against
 * the independent price at registration (prepareLive). Admission never reads
 * these: limits already signed keep every exit they allow.
 */
export const SOLANA_LIVE_PER_TRADE_BELOW_MINIMUM = "A live trade must be worth at least 1 USDG: set USDG per trade to at least 1.";
export const SOLANA_LIVE_STRATEGY_BELOW_MINIMUM = "A live strategy trade must be at least 1 USDG: set the maximum USDG per strategy trade to at least 1.";
/** Refuse live limits whose per-trade USDG limit is under SOLANA_LIVE_MIN_TRADE_USDG_RAW (SOLANA_LIVE_PER_TRADE_BELOW_MINIMUM). */
export function requireSolanaLiveTradeMinimum(limits: SolanaPaperLimits): void {
  if (parseSolanaRawAmount(limits.perTradeUsdg) < SOLANA_LIVE_MIN_TRADE_USDG_RAW) throw new SolanaPaperValidationError(SOLANA_LIVE_PER_TRADE_BELOW_MINIMUM);
}

/**
 * Generic limit shape. Limits that carry SOL sell caps are the ones a live vault
 * session is made from, so they must also fit the program and the permission
 * cap (validateSolanaAccountLimits). The standalone paper CLI, which never sets
 * sell caps, keeps its wider simulation ranges.
 */
export function validateSolanaPaperLimits(value: unknown, nowMs: number): SolanaPaperLimits {
  return limitsWithin(value, nowMs, false);
}

/**
 * Limits for a tenant's Solana account, paper or live: the generic shape, at
 * most SOLANA_MAX_OPS_PER_DAY operations a day, and a permission that ends
 * within SOLANA_MAX_PERMISSION_MS (plus clock skew) of now.
 */
export function validateSolanaAccountLimits(value: unknown, nowMs: number): SolanaPaperLimits {
  return limitsWithin(value, nowMs, true);
}

function limitsWithin(value: unknown, nowMs: number, account: boolean): SolanaPaperLimits {
  timestamp(nowMs, "nowMs");
  const input = record(value, ["perTradeUsdg", "dailyUsdg", "maxOpsPerDay", "maxDrawdownBps", "expiresAtMs"], "Solana paper limits", ["perTradeWsol", "dailyWsol"]);
  const perTrade = parseSolanaRawAmount(input.perTradeUsdg);
  const daily = parseSolanaRawAmount(input.dailyUsdg);
  if (perTrade > daily) throw new SolanaPaperValidationError("Solana per-trade limit must not exceed the daily limit");
  const expiresAtMs = timestamp(input.expiresAtMs, "expiresAtMs");
  if (expiresAtMs <= nowMs) throw new SolanaPaperValidationError("Solana paper limits have expired");
  if (Object.hasOwn(input, "perTradeWsol") !== Object.hasOwn(input, "dailyWsol")) {
    throw new SolanaPaperValidationError("Solana SOL sell limits need both a per-trade and a daily amount");
  }
  const wsol = Object.hasOwn(input, "perTradeWsol");
  if (wsol && parseSolanaRawAmount(input.perTradeWsol) > parseSolanaRawAmount(input.dailyWsol)) {
    throw new SolanaPaperValidationError("Solana per-trade SOL sell limit must not exceed the daily SOL sell limit");
  }
  const bounded = account || wsol;
  const maxOpsPerDay = integer(input.maxOpsPerDay, 1, bounded ? SOLANA_MAX_OPS_PER_DAY : Number.MAX_SAFE_INTEGER, "maxOpsPerDay");
  if (bounded && expiresAtMs > nowMs + SOLANA_MAX_PERMISSION_MS + SOLANA_PERMISSION_CLOCK_SKEW_MS) {
    throw new SolanaPaperValidationError("Solana trading permission must end within 168 hours");
  }
  return {
    perTradeUsdg: input.perTradeUsdg as string, dailyUsdg: input.dailyUsdg as string,
    maxOpsPerDay,
    maxDrawdownBps: integer(input.maxDrawdownBps, 1, 10_000, "maxDrawdownBps"),
    expiresAtMs,
    ...(wsol ? { perTradeWsol: input.perTradeWsol as string, dailyWsol: input.dailyWsol as string } : {}),
  };
}

/** Live vault sessions are bounded on sell input; refuse limits that would leave it open. */
export function requireSolanaLiveSellLimits(limits: SolanaPaperLimits): { perTradeWsol: bigint; dailyWsol: bigint } {
  if (limits.perTradeWsol === undefined || limits.dailyWsol === undefined) {
    throw new SolanaPaperValidationError("Live Solana trading needs per-trade and daily SOL sell limits");
  }
  return { perTradeWsol: parseSolanaRawAmount(limits.perTradeWsol), dailyWsol: parseSolanaRawAmount(limits.dailyWsol) };
}

/**
 * A trade request: the swap intent, plus optionally the owner's floor
 * (`minOutAmount`): the guaranteed output of the quote the owner previewed, in
 * the output mint's base units. A trade whose fresh quote guarantees less is
 * refused before it is signed or recorded ("price moved"), live and paper.
 *
 * The floor is not part of the trade's identity (its request-id fingerprint).
 * It gates a new admission only: a retry of a request that is already recorded
 * returns that trade whatever floor it carries, so an idempotent retry stays
 * idempotent, and a refusal records nothing, so the same request id may be
 * placed again after a new preview.
 */
export interface SolanaTradeRequest { intent: SolanaSwapIntent; minOutAmount: string | null }
export function parseSolanaTradeRequest(value: unknown): SolanaTradeRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SolanaPaperValidationError("Solana swap intent must be an object");
  const { minOutAmount, ...intent } = value as Record<string, unknown>;
  const parsed = parseSolanaSwapIntent(intent);
  if (!Object.hasOwn(value, "minOutAmount")) return { intent: parsed, minOutAmount: null };
  return { intent: parsed, minOutAmount: parseSolanaTradeFloor(minOutAmount) };
}
/** The owner's floor: a positive canonical integer string (a previewed minimum is never zero). */
export function parseSolanaTradeFloor(value: unknown): string {
  try { parseSolanaRawAmount(value); } catch { throw new SolanaPaperValidationError("The previewed minimum output must be a positive whole number of base units"); }
  return value as string;
}
/** Whether a quote's guaranteed output meets the owner's floor. No floor: always. */
export function solanaTradeFloorMet(quoteMinOutAmount: string, floor: string | null): boolean {
  return floor === null || parseSolanaRawAmount(quoteMinOutAmount, true) >= parseSolanaRawAmount(floor);
}

/** Revalidate even typed callers: a network response or stored JSON can lie. */
export function validateSolanaQuote(quote: SolanaQuote, intent: SolanaSwapIntent, nowMs: number): void {
  timestamp(nowMs, "nowMs");
  const expected = parseSolanaSwapIntent(intent);
  const input = record(quote, ["source", "inputMint", "outputMint", "inAmount", "outAmount", "minOutAmount", "slippageBps", "contextSlot", "quotedAtMs", "expiresAtMs"], "Solana quote");
  if (input.source !== "jupiter" || input.inputMint !== expected.inputMint || input.outputMint !== expected.outputMint || input.inAmount !== expected.amountRaw || input.slippageBps !== expected.slippageBps) {
    throw new SolanaPaperValidationError("Solana quote does not match the requested ExactIn swap");
  }
  parseSolanaRawAmount(input.inAmount);
  const out = parseSolanaRawAmount(input.outAmount);
  const minOut = parseSolanaRawAmount(input.minOutAmount);
  const floor = out * BigInt(10_000 - expected.slippageBps) / 10_000n;
  if (minOut > out || minOut < floor) throw new SolanaPaperValidationError("Solana quote minimum output exceeds the requested slippage");
  integer(input.contextSlot, 1, Number.MAX_SAFE_INTEGER, "contextSlot");
  const quotedAtMs = timestamp(input.quotedAtMs, "quotedAtMs");
  const expiresAtMs = timestamp(input.expiresAtMs, "expiresAtMs");
  if (quotedAtMs > nowMs || expiresAtMs <= nowMs || expiresAtMs <= quotedAtMs || expiresAtMs - quotedAtMs > SOLANA_QUOTE_MAX_AGE_MS || nowMs - quotedAtMs >= SOLANA_QUOTE_MAX_AGE_MS) {
    throw new SolanaPaperValidationError("Solana quote is stale, future-dated or has an invalid expiry");
  }
}

/** Namespace the standalone paper book without EVM lowercasing. */
export function solanaPaperAgentId(owner: string): `sol:${string}` {
  return `sol:${publicKey(owner, "owner")}`;
}
