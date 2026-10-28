/**
 * An independent price for live Solana trades: Pyth's SOL/USD price account,
 * read through the configured Solana RPC. It is a floor, not a fill price. A
 * live trade whose guaranteed output is far below what SOL is worth is refused,
 * whatever Jupiter quoted, and a sell is charged at least what it is worth.
 *
 * Evidence, and what is left of it. On 2026-10-19 between about 03:19 and
 * 03:25 UTC, an earlier pass on this code made read-only calls to the public
 * endpoint https://api.mainnet-beta.solana.com (getSlot, getMultipleAccounts,
 * getAccountInfo; no key, no transaction), from slot 458681198, and reported:
 * - both generations' receiver and price feed programs exist, are executable,
 *   belong to the upgradeable loader and share one upgrade authority;
 * - each generation's SOL/USD account is its price feed program's shard-0
 *   address for the feed id, is owned by that generation's receiver, is not
 *   executable, is 134 bytes, carries the PriceUpdateV2 discriminator, is its
 *   own write authority, is fully verified and has exponent -8;
 * - over a 21-round sample of about 3.5 minutes, the current account posted
 *   every 52-53 s (oldest seen 50.3 s) and the upgraded one every 10-15 s, and
 *   the two agreed to within 12.4 bp.
 * Only the two getAccountInfo answers in the fixture file were kept
 * (`PYTH_SOL_USD_MAINNET_SNAPSHOT`, `PYTH_SOL_USD_UPGRADED_MAINNET_SNAPSHOT`,
 * fetched 03:21:05 UTC at slots 458681624-5). The other raw captures (program
 * and ProgramData reads, the freshness sample, the Pyth pages read) were not
 * preserved. From the committed bytes alone, tests re-prove the layout, the
 * discriminator, the feed id, the Full level, the write authority, the decoded
 * values and both PDA derivations. The program facts, the owner and
 * executable fields beyond what those two answers record, and the heartbeat
 * and agreement figures rest on that unpreserved check: re-run it read-only,
 * and keep its output, before trusting them for live trading. Whatever was
 * observed, any mismatch, stale or missing price fails closed.
 *
 * Pyth's 2026-08-26 Core upgrade added a second generation of programs on
 * Solana with their own feed accounts, and Pyth recommends it for new
 * integrations. Both generations are pinned in `SOLANA_PYTH_FEEDS`, and
 * MERRYMEN_SOLANA_PYTH_GENERATION ("current" or "upgraded"; unset is
 * `SOLANA_PYTH_DEFAULT_GENERATION`) picks the one every read and every stored
 * bound must come from. It switches all three addresses together; there is no
 * fallback from one generation to the other, and configuration cannot name an
 * address of its own. Only the app runtime reads it, from the env it was built
 * with (`requireSolanaPythGeneration`), and passes that one generation to its
 * reads, the executor's check and the store's admission check; a setting that
 * names no generation refuses live trading as a configuration error. Nothing
 * here reads process.env: a caller that passes no generation gets
 * SOLANA_PYTH_DEFAULT_GENERATION.
 */
import { createHash } from "node:crypto";
import { address, getProgramDerivedAddress } from "@solana/kit";
import { SOLANA_USDG_MINT } from "../../packages/core/src/ids";
import { parseSolanaRawAmount } from "../../packages/core/src/solana";
import { SOLANA_WRAPPED_SOL_MINT } from "../../packages/core/src/solana-live";
import type { SolanaLiveRead } from "./solana-live-rpc";

/** Which of Pyth's two Solana Core deployments the reference is read from. */
export type SolanaPythGeneration = "current" | "upgraded";
/** One generation's pinned identities. Each one is checked on every read; none is ever taken from configuration. */
export interface SolanaPythFeed {
  generation: SolanaPythGeneration;
  /** Pyth Solana Receiver: owner of every PriceUpdateV2 account this generation posts. */
  receiverProgram: string;
  /** Pyth push oracle ("Price Feed" program): its PDAs are the sponsored price feed accounts. */
  priceFeedProgram: string;
  /**
   * The sponsored SOL/USD price feed account: `priceFeedProgram`'s PDA for shard 0
   * and the feed id (`derivePythPriceFeedAccount`). Pinned so admission stays
   * synchronous; a test re-derives it. Pinning matters: anyone can post a fully
   * verified PriceUpdateV2 owned by the receiver to an account of their own.
   */
  account: string;
}
/**
 * Both generations, pinned. "current" is the pre-upgrade deployment; "upgraded"
 * is the one Pyth's 2026-08-26 Core upgrade added, which Pyth recommends for new
 * integrations. The layout, feed id and shard are the same; the three addresses
 * all change together, and only together.
 */
export const SOLANA_PYTH_FEEDS: Readonly<Record<SolanaPythGeneration, Readonly<SolanaPythFeed>>> = Object.freeze({
  current: Object.freeze({ generation: "current", receiverProgram: "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
    priceFeedProgram: "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT", account: "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE" }),
  upgraded: Object.freeze({ generation: "upgraded", receiverProgram: "rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp",
    priceFeedProgram: "pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou", account: "7AviUf9nL62mcxNbQGKm4nKDQnPjswo6c5MX4D57HmyE" }),
} satisfies Record<SolanaPythGeneration, SolanaPythFeed>);
/**
 * The generation read when MERRYMEN_SOLANA_PYTH_GENERATION is unset, and by
 * any caller that passes no generation: "current", the conservative choice and
 * the owner's to change. It is the generation this module was first built and
 * checked against, and the tests replay a recorded read of it. The alternative, "upgraded", is the one Pyth recommends for new
 * integrations; the unpreserved 2026-10-19 sample saw it post every 10-15 s
 * against the current account's 52-53 s, and it trusts a different receiver
 * program. Switching is one setting, with no fallback either way; give every
 * service that runs the Solana runtime (web and worker) the same value, so all
 * live trades are bounded by one oracle.
 */
export const SOLANA_PYTH_DEFAULT_GENERATION: SolanaPythGeneration = "current";
/** The default generation's receiver, price feed program and SOL/USD account. */
export const PYTH_RECEIVER_PROGRAM = SOLANA_PYTH_FEEDS[SOLANA_PYTH_DEFAULT_GENERATION].receiverProgram;
export const PYTH_PUSH_ORACLE_PROGRAM = SOLANA_PYTH_FEEDS[SOLANA_PYTH_DEFAULT_GENERATION].priceFeedProgram;
export const PYTH_SOL_USD_ACCOUNT = SOLANA_PYTH_FEEDS[SOLANA_PYTH_DEFAULT_GENERATION].account;
/** Pyth sponsors shard 0 of each feed; other shards are posted by whoever pays for them. */
export const PYTH_SPONSORED_SHARD = 0;
/** Crypto.SOL/USD. */
export const PYTH_SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
/**
 * Sponsored feeds post on a heartbeat and on price moves; older than this is unproven.
 * One limit for both generations, and the [alert] says only this number: how many
 * posts it spans depends on the generation. Pyth documents a 55 s heartbeat or 0.5%
 * move for SOL/USD; the 2026-10-19 sample (not preserved; see the module comment) saw
 * the current account post every 52-53 s (about two posts in this window) and the
 * upgraded one every 10-15 s (about eight to twelve).
 */
export const SOLANA_REFERENCE_MAX_AGE_MS = 120_000;
export const SOLANA_REFERENCE_MAX_FUTURE_MS = 5_000;
/** Confidence interval at most 1% of price. */
export const SOLANA_REFERENCE_MAX_CONF_BPS = 100;
export const SOLANA_REFERENCE_DEFAULT_TOLERANCE_BPS = 300;
export const SOLANA_REFERENCE_MIN_TOLERANCE_BPS = 50;
export const SOLANA_REFERENCE_MAX_TOLERANCE_BPS = 1_000;
const DISCRIMINATOR = createHash("sha256").update("account:PriceUpdateV2").digest().subarray(0, 8);
// 8 discriminator + 32 write authority + 2 verification level (1 when Full) + 32 feed id
// + price i64, conf u64, exponent i32, publish/prev publish i64, ema price i64, ema conf u64, posted slot u64.
// The account is sized for Partial (2 level bytes), so a Full update leaves its last byte unused.
const PRICE_UPDATE_LEN = 134;
const FULL = 1;

/**
 * Why a reference was refused. The account-read reasons (from `missing` to
 * `posted-slot`) describe what the RPC served; `config` is a setting that
 * names no generation or tolerance; `bound` and `evidence` are a trade or a
 * stored bound that the reference cannot vouch for.
 */
export type SolanaReferenceRefusal = "config" | "input" | "response" | "rpc-slot" | "missing" | "foreign" | "layout" | "unverified" | "feed" |
  "price" | "confidence" | "timestamp" | "stale" | "future" | "posted-slot" | "bound" | "evidence";
export class SolanaReferencePriceError extends Error {
  /** Numbers only (ages, slots), so they can go into a log line as they are. */
  readonly detail: Readonly<Record<string, number>>;
  constructor(readonly reason: SolanaReferenceRefusal, detail: Record<string, number> = {}) {
    super("The independent SOL price is unavailable or unproven; no live trade was admitted.");
    this.name = "SolanaReferencePriceError"; this.detail = Object.freeze({ ...detail });
  }
}
function fail(reason: SolanaReferenceRefusal, detail?: Record<string, number>): never { throw new SolanaReferencePriceError(reason, detail); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function safe(value: unknown, reason: SolanaReferenceRefusal): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fail(reason); return value;
}

type Env = Readonly<Record<string, string | undefined>>;
/**
 * MERRYMEN_SOLANA_PYTH_GENERATION: "current" or "upgraded", exactly; unset or
 * empty is SOLANA_PYTH_DEFAULT_GENERATION. Anything else refuses every live
 * trade rather than guess which oracle was meant.
 */
export function solanaPythGeneration(env: Env): SolanaPythGeneration {
  const raw = env.MERRYMEN_SOLANA_PYTH_GENERATION;
  if (raw === undefined || raw === "") return SOLANA_PYTH_DEFAULT_GENERATION;
  if (raw === "current" || raw === "upgraded") return raw;
  return fail("config");
}
/** One generation's pinned identities; anything that is not a generation is refused. */
export function solanaPythFeed(generation: SolanaPythGeneration): Readonly<SolanaPythFeed> {
  if (generation !== "current" && generation !== "upgraded") return fail("config");
  return SOLANA_PYTH_FEEDS[generation];
}
/*
 * Nothing here reads process.env. MERRYMEN_SOLANA_PYTH_GENERATION is read only
 * by `solanaPythGeneration`/`requireSolanaPythGeneration`, from the env a
 * caller hands them: the app runtime's own, which it then passes to every
 * read and check. A caller that passes no generation gets
 * SOLANA_PYTH_DEFAULT_GENERATION, whatever the process's env says, so a value
 * exported in a shell cannot silently change what an unconfigured caller (a
 * test, a tool) reads or accepts; a bound from the other generation is still
 * refused, never translated.
 */

export interface SolanaReferencePrice {
  source: "pyth"; account: string; feedId: string;
  /** USD per SOL is price × 10^exponent. */
  price: string; conf: string; exponent: number;
  publishTimeMs: number; postedSlot: number; slot: number;
}
export interface SolanaReferenceBound {
  reference: SolanaReferencePrice;
  toleranceBps: number;
  /** What the trade's input is worth at the reference, in output base units. */
  referenceOut: string;
  /** The lowest guaranteed output a live trade may sign for. */
  minOutFloor: string;
  /** USDG notional at the reference: a buy's input, a sell's reference proceeds. */
  valueUsdg: string;
}

/**
 * A push-oracle price feed account: the PDA of `program` for seeds
 * [shard as u16 little-endian, 32-byte feed id]. For shard 0 and the SOL/USD feed id
 * it gives each generation's pinned account, the ones the fixture file's two
 * recorded reads came from (tests check both).
 */
export async function derivePythPriceFeedAccount(feedIdHex: string, shard: number = PYTH_SPONSORED_SHARD,
  program: string = PYTH_PUSH_ORACLE_PROGRAM): Promise<string> {
  if (typeof feedIdHex !== "string" || !/^[0-9a-f]{64}$/.test(feedIdHex) || !Number.isSafeInteger(shard) || shard < 0 || shard > 0xffff) return fail("input");
  const seed = new Uint8Array(2); new DataView(seed.buffer).setUint16(0, shard, true);
  return (await getProgramDerivedAddress({ programAddress: address(program), seeds: [seed, Buffer.from(feedIdHex, "hex")] }))[0];
}

/**
 * Parse and check one PriceUpdateV2 account as returned by getAccountInfo base64:
 * owned by `generation`'s receiver (default: SOLANA_PYTH_DEFAULT_GENERATION),
 * and read from that generation's account.
 */
export function parsePythSolUsd(raw: unknown, contextSlot: number, nowMs: number,
  generation: SolanaPythGeneration = SOLANA_PYTH_DEFAULT_GENERATION): SolanaReferencePrice {
  safe(contextSlot, "input"); safe(nowMs, "input");
  const feed = solanaPythFeed(generation);
  // A closed or never-created account: the RPC answers `value: null`.
  if (raw === null) return fail("missing");
  if (!object(raw) || raw.owner !== feed.receiverProgram || raw.executable !== false) return fail("foreign");
  if (!Array.isArray(raw.data) || raw.data[1] !== "base64" || typeof raw.data[0] !== "string") return fail("layout");
  const data = Buffer.from(raw.data[0], "base64");
  if (data.toString("base64") !== raw.data[0] || data.length !== PRICE_UPDATE_LEN || !data.subarray(0, 8).equals(DISCRIMINATOR)) return fail("layout");
  // Partial verification has fewer guardian signatures behind it; only Full counts.
  if (data[40] !== FULL) return fail("unverified");
  const feedId = data.subarray(41, 73).toString("hex");
  if (feedId !== PYTH_SOL_USD_FEED_ID) return fail("feed");
  const price = data.readBigInt64LE(73), conf = data.readBigUInt64LE(81), exponent = data.readInt32LE(89);
  const publishTime = data.readBigInt64LE(93), postedSlot = data.readBigUInt64LE(125);
  if (price <= 0n || exponent < -12 || exponent > 0) return fail("price");
  if (conf * 10_000n > price * BigInt(SOLANA_REFERENCE_MAX_CONF_BPS)) return fail("confidence");
  if (publishTime <= 0n || publishTime > BigInt(Number.MAX_SAFE_INTEGER) / 1000n) return fail("timestamp");
  const publishTimeMs = Number(publishTime) * 1000, ageMs = nowMs - publishTimeMs;
  if (publishTimeMs > nowMs + SOLANA_REFERENCE_MAX_FUTURE_MS) return fail("future", { ageMs, contextSlot });
  if (ageMs > SOLANA_REFERENCE_MAX_AGE_MS) return fail("stale", { ageMs, maxAgeMs: SOLANA_REFERENCE_MAX_AGE_MS, contextSlot });
  if (postedSlot < 1n || postedSlot > BigInt(contextSlot)) return fail("posted-slot", { contextSlot });
  return { source: "pyth", account: feed.account, feedId, price: price.toString(), conf: conf.toString(), exponent,
    publishTimeMs, postedSlot: Number(postedSlot), slot: contextSlot };
}

/** Where the [alert] and recovery lines go. A sink that throws is ignored: logging never changes an outcome. */
export interface SolanaReferenceAlertSink { alert(line: string): void; info(line: string): void }
/** Tracks refused reference reads in one process and says when to tell an operator. */
export interface SolanaReferenceAlerts {
  refused(event: { error: SolanaReferencePriceError; generation: string; nowMs: number }): void;
  read(event: { generation: SolanaPythGeneration; nowMs: number }): void;
}
/** While reads keep being refused for the same reason, the [alert] is repeated at most this often. */
export const SOLANA_REFERENCE_ALERT_REPEAT_MS = 60_000;
/**
 * The first refused read says one `[alert] solana-reference-price refused:`
 * line at once, ending in what clears it: a fresh price, or for `config` (a
 * Pyth generation setting that names no generation) a corrected setting; later refusals for the same reason are counted and said again
 * at most every `repeatMs`, and a new reason is said at once. The next good
 * read says one recovery line and clears the count. Every field is a constant
 * or a number, so nothing the RPC served is ever echoed into the log.
 */
export function createSolanaReferenceAlerts(sink: SolanaReferenceAlertSink = {
  alert: line => console.error(line), info: line => console.log(line),
}, repeatMs: number = SOLANA_REFERENCE_ALERT_REPEAT_MS): SolanaReferenceAlerts {
  type Failing = { reason: SolanaReferenceRefusal; sinceMs: number | null; saidAtMs: number | null; unsaid: number; refused: number };
  let failing: Failing | null = null;
  const say = (kind: "alert" | "info", line: string) => { try { sink[kind](line); } catch { /* Logging never changes an outcome. */ } };
  // A clock that stepped back since the first refusal gives no honest duration.
  const forMs = (nowMs: number | null) => nowMs !== null && failing?.sinceMs != null && nowMs >= failing.sinceMs ? nowMs - failing.sinceMs : "unknown";
  const clock = (nowMs: unknown) => typeof nowMs === "number" && Number.isSafeInteger(nowMs) ? nowMs : null;
  return {
    refused({ error, generation, nowMs }) {
      const at = clock(nowMs);
      if (failing && failing.reason === error.reason && at !== null && failing.saidAtMs !== null && at >= failing.saidAtMs &&
          at - failing.saidAtMs < repeatMs) { failing.unsaid++; failing.refused++; return; }
      const suppressed = failing?.unsaid ?? 0;
      failing = { reason: error.reason, sinceMs: failing ? failing.sinceMs : at, saidAtMs: at, unsaid: 0, refused: (failing?.refused ?? 0) + 1 };
      const known = generation === "current" || generation === "upgraded";
      const fields = [`reason=${error.reason}`, `generation=${known ? generation : "invalid"}`,
        ...(known ? [`account=${SOLANA_PYTH_FEEDS[generation].account}`] : []),
        ...Object.entries(error.detail).filter(([, v]) => typeof v === "number" && Number.isFinite(v)).map(([k, v]) => `${k}=${v}`),
        `failingForMs=${forMs(at)}`, `refused=${failing.refused}`, `suppressed=${suppressed}`];
      // The remedy fits the reason: a refused read clears with the next good price, a
      // setting that names no generation only when an operator corrects it.
      const remedy = error.reason === "config"
        ? `MERRYMEN_SOLANA_PYTH_GENERATION must be current or upgraded (unset is ${SOLANA_PYTH_DEFAULT_GENERATION}); ` +
          "no live Solana trade is admitted until the setting is fixed"
        // The age limit alone: how many Pyth posts it spans differs by generation (see SOLANA_REFERENCE_MAX_AGE_MS).
        : `no live Solana trade is admitted until a fresh, fully verified SOL/USD price is read (max age ${SOLANA_REFERENCE_MAX_AGE_MS / 1000} s)`;
      say("alert", `[alert] solana-reference-price refused: ${fields.join(" ")} — ${remedy}`);
    },
    read({ generation, nowMs }) {
      if (!failing) return;
      say("info", `[solana-reference-price] read again: generation=${generation} account=${SOLANA_PYTH_FEEDS[generation].account} ` +
        `after refused=${failing.refused} failingForMs=${forMs(clock(nowMs))}`);
      failing = null;
    },
  };
}
/** This process's alerts: what the runtime's reads report to unless a caller passes its own. */
const processReferenceAlerts = createSolanaReferenceAlerts();

/**
 * The generation `env` selects, for a caller that checks it before reading
 * anything: the app runtime, next to the tolerance, with the env it was built
 * with. A setting that names no generation is said as the same [alert] a
 * refused read gives (reason=config generation=invalid, never the value) and
 * rethrown, so the caller can refuse it as configuration.
 */
export function requireSolanaPythGeneration(env: Env, nowMs: number, alerts: SolanaReferenceAlerts = processReferenceAlerts): SolanaPythGeneration {
  try { return solanaPythGeneration(env); } catch (error) {
    if (error instanceof SolanaReferencePriceError) { try { alerts.refused({ error, generation: "invalid", nowMs }); } catch { /* Still refused. */ } }
    throw error;
  }
}

/**
 * Read the reference at or after `minContextSlot` from `generation`'s pinned
 * account (default: SOLANA_PYTH_DEFAULT_GENERATION; the app runtime passes
 * the one its env names). Never touches Jupiter.
 * A refusal (stale, missing, foreign, unverified, misconfigured …) is
 * reported to `alerts` (default: this process's, logged as an [alert]) and
 * rethrown; an RPC transport error is rethrown untouched, since the caller
 * may fail over to the other provider.
 */
export async function readSolanaReferencePrice(read: SolanaLiveRead, minContextSlot: number, nowMs: number,
  options: { generation?: SolanaPythGeneration; alerts?: SolanaReferenceAlerts } = {}): Promise<SolanaReferencePrice> {
  const alerts = options.alerts ?? processReferenceAlerts;
  let generation: SolanaPythGeneration | undefined, price: SolanaReferencePrice;
  try {
    // Anything passed that is not a generation is refused here, and said as generation=invalid.
    const chosen = options.generation ?? SOLANA_PYTH_DEFAULT_GENERATION, feed = solanaPythFeed(chosen);
    generation = chosen;
    const result = await read("getAccountInfo", [feed.account, { encoding: "base64", commitment: "finalized", minContextSlot }]);
    if (!object(result) || !object(result.context) || !Object.hasOwn(result, "value")) return fail("response");
    const slot = safe(result.context.slot, "response");
    if (slot < minContextSlot) return fail("rpc-slot", { contextSlot: slot, minContextSlot });
    price = parsePythSolUsd(result.value, slot, nowMs, chosen);
  } catch (error) {
    if (error instanceof SolanaReferencePriceError) {
      try { alerts.refused({ error, generation: generation ?? "invalid", nowMs }); } catch { /* Still refused. */ }
    }
    throw error;
  }
  try { alerts.read({ generation, nowMs }); } catch { /* Still a good read. */ }
  return price;
}

export function solanaReferenceToleranceBps(env: Env): number {
  const raw = env.MERRYMEN_SOLANA_REFERENCE_TOLERANCE_BPS;
  if (raw === undefined || raw === "") return SOLANA_REFERENCE_DEFAULT_TOLERANCE_BPS;
  const value = Number(raw);
  if (!/^[0-9]+$/.test(raw) || value < SOLANA_REFERENCE_MIN_TOLERANCE_BPS || value > SOLANA_REFERENCE_MAX_TOLERANCE_BPS) return fail("config");
  return value;
}

/**
 * Bound a USDG↔WSOL ExactIn trade by the reference. USDG is taken as $1; a depeg
 * beyond the tolerance refuses trading rather than guessing. The tolerance must
 * exceed the trade's own slippage, or no honest fill could pass.
 */
export function solanaReferenceBound(intent: { inputMint: string; outputMint: string; amountRaw: string; slippageBps: number },
  reference: SolanaReferencePrice, toleranceBps: number): SolanaReferenceBound {
  if (!Number.isSafeInteger(toleranceBps) || toleranceBps < SOLANA_REFERENCE_MIN_TOLERANCE_BPS || toleranceBps > SOLANA_REFERENCE_MAX_TOLERANCE_BPS ||
      !Number.isSafeInteger(intent.slippageBps) || intent.slippageBps < 0 || toleranceBps <= intent.slippageBps) return fail("bound");
  const amount = parseSolanaRawAmount(intent.amountRaw), price = BigInt(reference.price), exponent = reference.exponent;
  if (price <= 0n || !Number.isSafeInteger(exponent) || exponent < -12 || exponent > 0) return fail("bound");
  // USDG has 6 decimals and wrapped SOL 9, so one lamport is worth price × 10^(exponent - 3) micro-USDG.
  const scale = 10n ** BigInt(3 - exponent);
  let referenceOut: bigint, valueUsdg: bigint;
  if (intent.inputMint === SOLANA_WRAPPED_SOL_MINT && intent.outputMint === SOLANA_USDG_MINT) {
    referenceOut = amount * price / scale; valueUsdg = referenceOut;
  } else if (intent.inputMint === SOLANA_USDG_MINT && intent.outputMint === SOLANA_WRAPPED_SOL_MINT) {
    referenceOut = amount * scale / price; valueUsdg = amount;
  } else return fail("bound");
  // A trade too small to value at the reference cannot be bounded by it.
  if (referenceOut <= 0n) return fail("bound");
  const minOutFloor = referenceOut * BigInt(10_000 - toleranceBps) / 10_000n;
  if (minOutFloor <= 0n) return fail("bound");
  return { reference: structuredClone(reference), toleranceBps, referenceOut: referenceOut.toString(), minOutFloor: minOutFloor.toString(), valueUsdg: valueUsdg.toString() };
}

/**
 * Of one trade's bounds, one per provider that served the reference (each read
 * at or after the same slot), the stricter: the highest reference output. That
 * is the higher floor for the guaranteed output (a buy is held to the lower SOL
 * price, a sell to the higher) and, for a sell, the higher USDG value charged
 * against the limits. A provider serving a fabricated price can therefore make a
 * trade harder to admit, never easier. Ties keep the first (the primary's).
 */
export function solanaStrictestReferenceBound(bounds: readonly SolanaReferenceBound[]): SolanaReferenceBound {
  if (!bounds.length) return fail("bound");
  return bounds.reduce((best, bound) => parseSolanaRawAmount(bound.referenceOut) > parseSolanaRawAmount(best.referenceOut) ? bound : best);
}
/**
 * Of several providers' bounds for one amount, the lowest reference output:
 * what an owner withdrawal's valuation keeps, so that no one provider can lower
 * the high-water mark by more than the SOL was worth.
 */
export function solanaLowestReferenceBound(bounds: readonly SolanaReferenceBound[]): SolanaReferenceBound {
  if (!bounds.length) return fail("bound");
  return bounds.reduce((low, bound) => parseSolanaRawAmount(bound.referenceOut) < parseSolanaRawAmount(low.referenceOut) ? bound : low);
}

/**
 * Recompute a stored bound from its own reference and the intent, and check it
 * is still fresh. Admission calls this so a bound can't be edited or replayed.
 * The reference must come from `generation`'s account (default:
 * SOLANA_PYTH_DEFAULT_GENERATION; the app runtime's executor and store pass the
 * one its env names): a bound read from the other generation is refused, never
 * translated.
 *
 * `toleranceBps`: the tolerance the bound must have been built with, the app
 * runtime's MERRYMEN_SOLANA_REFERENCE_TOLERANCE_BPS (the executor and the store
 * pass it, by default SOLANA_REFERENCE_DEFAULT_TOLERANCE_BPS). A bound carrying
 * any other tolerance is refused, so evidence cannot widen its own floor. Left
 * out, any tolerance in the allowed range is recomputed as before (the owner's
 * withdrawal valuation, which only ever lowers the high-water mark less).
 */
export function verifySolanaReferenceBound(bound: SolanaReferenceBound, intent: Parameters<typeof solanaReferenceBound>[0], nowMs: number,
  generation: SolanaPythGeneration = SOLANA_PYTH_DEFAULT_GENERATION, toleranceBps?: number): SolanaReferenceBound {
  const feed = solanaPythFeed(generation);
  if (!object(bound) || !object(bound.reference)) return fail("evidence");
  if (toleranceBps !== undefined && bound.toleranceBps !== toleranceBps) return fail("evidence");
  const r = bound.reference;
  try { address(r.account); } catch { return fail("evidence"); }
  if (r.source !== "pyth" || r.account !== feed.account || r.feedId !== PYTH_SOL_USD_FEED_ID ||
      typeof r.price !== "string" || typeof r.conf !== "string" || !/^[1-9][0-9]{0,18}$/.test(r.price) || !/^(0|[1-9][0-9]{0,19})$/.test(r.conf) ||
      BigInt(r.conf) * 10_000n > BigInt(r.price) * BigInt(SOLANA_REFERENCE_MAX_CONF_BPS)) return fail("evidence");
  safe(r.publishTimeMs, "evidence"); safe(r.postedSlot, "evidence"); safe(r.slot, "evidence"); safe(nowMs, "input");
  if (r.postedSlot < 1 || r.postedSlot > r.slot || r.publishTimeMs > nowMs + SOLANA_REFERENCE_MAX_FUTURE_MS || nowMs - r.publishTimeMs > SOLANA_REFERENCE_MAX_AGE_MS) return fail("evidence");
  const expected = solanaReferenceBound(intent, r, bound.toleranceBps);
  if (expected.referenceOut !== bound.referenceOut || expected.minOutFloor !== bound.minOutFloor || expected.valueUsdg !== bound.valueUsdg) return fail("evidence");
  return expected;
}

/**
 * MARK DUST (owner decision, round 2): the most held SOL may be worth at the
 * independent Pyth SOL/USD price for Jupiter's zero-output mark to value it at
 * zero: under one US cent, 10,000 USDG base units. Real dust (a remainder no
 * route buys back) is worth far less, so buys beside it go on. A zero-output
 * mark for SOL worth more is an answer that cannot be used, refused like any
 * other mark failure: valuing a real position at zero would trip the persisted
 * drawdown breaker on one anomalous quote. The direction is fail-closed either
 * way (exits stay open); this keeps the refusal to that one buy.
 */
export const SOLANA_MARK_DUST_MAX_USDG_RAW = 10_000n;
/** What `wsolRaw` lamports are worth at the reference, in USDG base units (rounded down). */
export function solanaReferenceWsolValue(wsolRaw: bigint, reference: SolanaReferencePrice): bigint {
  if (!object(reference) || typeof reference.price !== "string" || !/^[1-9][0-9]{0,18}$/.test(reference.price) || wsolRaw < 0n) return fail("bound");
  const exponent = reference.exponent;
  if (!Number.isSafeInteger(exponent) || exponent < -12 || exponent > 0) return fail("bound");
  // As solanaReferenceBound: one lamport is worth price × 10^(exponent - 3) micro-USDG.
  return wsolRaw * BigInt(reference.price) / 10n ** BigInt(3 - exponent);
}
/** Whether a zero-output mark may value `wsolRaw` of held SOL at zero: worth under SOLANA_MARK_DUST_MAX_USDG_RAW at the reference. */
export function solanaMarkDust(wsolRaw: bigint, reference: SolanaReferencePrice): boolean {
  return solanaReferenceWsolValue(wsolRaw, reference) < SOLANA_MARK_DUST_MAX_USDG_RAW;
}

/** The USDG notional admission charges: a buy's input, a sell's quoted or reference proceeds, whichever is larger. */
export function solanaReferenceNotional(intent: { inputMint: string; amountRaw: string }, quotedOut: string, bound: SolanaReferenceBound): bigint {
  if (intent.inputMint === SOLANA_USDG_MINT) return parseSolanaRawAmount(intent.amountRaw);
  const quoted = parseSolanaRawAmount(quotedOut), reference = parseSolanaRawAmount(bound.valueUsdg);
  return quoted > reference ? quoted : reference;
}
