/**
 * Live RPC transport. Two providers on different hostnames are required, and
 * every session with either one first proves it serves mainnet-beta.
 *
 * - read: one provider's answer, failing over to the other on transport errors.
 * - readEach / readSolanaQuorum: every provider's answer. Booking a fill or an
 *   expiry needs both to agree; one provider's word is never enough.
 * - send: the identical signed bytes to both providers, rebroadcast until the
 *   signature is finalized, the blockhash is no longer valid or the caller's
 *   window ends. The bytes are never re-signed, so a rebroadcast can land at most once.
 */
import { createHmac, randomBytes } from "node:crypto";
import {
  getCompiledTransactionMessageDecoder, getSignatureFromTransaction, getTransactionDecoder,
  isFullySignedTransaction, isSignature,
} from "@solana/kit";
import {
  readSolanaJson, readSolanaLiveRpcConfig, readSolanaMainnetRpcConfig, SOLANA_MAINNET_GENESIS_HASH,
  SolanaRpcError, withSolanaReadDeadline,
} from "./solana-rpc";

const READ_METHODS = ["getAccountInfo", "getMultipleAccounts", "getSlot", "getLatestBlockhash",
  "getBlockHeight", "getEpochInfo", "isBlockhashValid", "getFeeForMessage", "getMinimumBalanceForRentExemption",
  "getRecentPrioritizationFees", "simulateTransaction", "getSignatureStatuses", "getTransaction"] as const;
export type SolanaLiveReadMethod = typeof READ_METHODS[number];
export type SolanaLiveRead = (method: SolanaLiveReadMethod, params?: readonly unknown[]) => Promise<unknown>;
export interface SolanaSendOptions {
  /**
   * Keep rebroadcasting the same bytes until this wall-clock time (ms). One round
   * is always sent; 0 sends exactly one round. Without it the window is
   * SOLANA_DEFAULT_REBROADCAST_MS. A finalized signature or an expired
   * blockhash ends it sooner.
   */
  untilMs?: number;
}
export interface SolanaLiveRpc {
  read<T>(operation: (rpc: SolanaLiveRead) => Promise<T>): Promise<T>;
  /**
   * Runs `operation` once against every configured provider (primary first),
   * each in its own mainnet-verified session. Rejects if any provider fails.
   * The live transport always has two; use readSolanaQuorum to compare. Optional
   * only so a narrow test double can omit it: without it every quorum or
   * every-provider read refuses with "no-quorum".
   */
  readEach?<T>(operation: (rpc: SolanaLiveRead) => Promise<T>): Promise<T[]>;
  send(signedTransactionBase64: string, minContextSlot: number, signal?: AbortSignal, options?: SolanaSendOptions): Promise<string>;
  /**
   * In-process cache key for this provider pair. Not derived reversibly from the
   * URLs. Absent for an owner-run single endpoint: its checks are never reused.
   */
  readonly providerKey?: string;
  /**
   * True only for createSolanaLiveRpc({ singleEndpoint: true }): an owner-run tool
   * that talks to the one RPC the owner chose. It may verify a deployment on that
   * one provider; nothing the live runtime books ever accepts it.
   */
  readonly singleEndpoint?: boolean;
}

export const SOLANA_DEFAULT_REBROADCAST_MS = 15_000;
const MAX_REBROADCAST_MS = 120_000;
const PROCESS_SALT = randomBytes(32);

/**
 * Every provider's answer, for checks one lying provider must not pass alone
 * (the vault deployment). At least two providers, or "no-quorum": a transport
 * without readEach, or with one provider behind it, is refused. The only
 * exception is an owner-run single endpoint (createSolanaLiveRpc's
 * singleEndpoint), which checks against the one RPC its owner chose.
 */
export async function readSolanaEachProvider<T>(rpc: SolanaLiveRpc, operation: (rpc: SolanaLiveRead) => Promise<T>): Promise<T[]> {
  const single = rpc.singleEndpoint === true;
  if (typeof rpc.readEach !== "function") {
    if (!single) throw new SolanaRpcError("no-quorum");
    return [await rpc.read(operation)];
  }
  const values = await rpc.readEach(operation);
  if (!Array.isArray(values) || values.length < (single ? 1 : 2)) throw new SolanaRpcError("no-quorum");
  return values;
}

export type SolanaQuorum<T> =
  | { agreed: true; value: T; values: readonly T[] }
  | { agreed: false; values: readonly T[] };
/**
 * Quorum read for anything that books money or frees a reservation.
 *
 * Runs `operation` independently on every provider (at least two, or it throws
 * "no-quorum") and compares the answers by `key`. `agreed` is true only when
 * every key is identical; `value` is then the primary's answer. Disagreement is
 * not an error: the caller keeps the record pending and asks again later. A
 * provider that errors makes the whole read reject, which also keeps it pending.
 *
 * Choose `key` to cover everything the booking depends on and nothing that
 * legitimately differs between providers (for example, each provider's own
 * current block height in an expiry proof).
 */
export async function readSolanaQuorum<T>(
  rpc: SolanaLiveRpc, operation: (rpc: SolanaLiveRead) => Promise<T>, key: (value: T) => string = value => JSON.stringify(value),
): Promise<SolanaQuorum<T>> {
  if (typeof rpc.readEach !== "function") throw new SolanaRpcError("no-quorum");
  const values = await rpc.readEach(operation);
  if (!Array.isArray(values) || values.length < 2) throw new SolanaRpcError("no-quorum");
  const keys = values.map(key);
  return keys.every(item => item === keys[0]) ? { agreed: true, value: values[0]!, values } : { agreed: false, values };
}

function nonNegative(value: unknown): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new SolanaRpcError("malformed");
  return BigInt(value);
}
/**
 * Compute-unit price (micro-lamports) from getRecentPrioritizationFees over the
 * accounts a transaction writes: the 75th percentile of recent slots, never
 * below `minimum` and never above `maximum`. The caller still bounds the whole
 * fee (getFeeForMessage) by its own budget.
 */
export async function readSolanaPriorityFee(
  read: SolanaLiveRead, writableAccounts: readonly string[], bounds: { minimum: bigint; maximum: bigint },
): Promise<bigint> {
  if (bounds.minimum < 0n || bounds.maximum < bounds.minimum) throw new SolanaRpcError("malformed");
  const accounts = [...new Set(writableAccounts)];
  if (accounts.length > 128) throw new SolanaRpcError("malformed");
  const raw = await read("getRecentPrioritizationFees", [accounts]);
  if (!Array.isArray(raw) || raw.length > 1024) throw new SolanaRpcError("malformed");
  const fees = raw.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new SolanaRpcError("malformed");
    nonNegative((row as Record<string, unknown>).slot);
    return nonNegative((row as Record<string, unknown>).prioritizationFee);
  }).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const percentile = fees.length ? fees[Math.ceil(fees.length * 0.75) - 1]! : 0n;
  return percentile < bounds.minimum ? bounds.minimum : percentile > bounds.maximum ? bounds.maximum : percentile;
}

export function createSolanaLiveRpc(options: {
  env?: Readonly<Record<string, string | undefined>>; fetch?: typeof globalThis.fetch; timeoutMs?: number;
  /** Rebroadcast pacing, injectable for tests. */
  now?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; rebroadcastIntervalMs?: number;
  /**
   * Owner-run tools (merrymen solana-recover) talk only to the one endpoint the
   * owner chose. The live runtime never sets this: it needs two providers. Such
   * a transport has no providerKey (no deployment check is reused) and, unless
   * the caller asks for a window, sends one round: the tool resolves an unknown
   * outcome by reading the chain.
   */
  singleEndpoint?: boolean;
} = {}): SolanaLiveRpc {
  const config = options.singleEndpoint
    ? { url: readSolanaMainnetRpcConfig(options.env).url, fallbackUrl: undefined }
    : readSolanaLiveRpcConfig(options.env);
  const fallbackUrl = config.fallbackUrl;
  const endpoints = fallbackUrl ? [config.url, fallbackUrl] : [config.url];
  const request = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const interval = options.rebroadcastIntervalMs ?? 2_000;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 10_000) throw new SolanaRpcError("invalid-timeout");
  const sleep = options.sleep ?? ((ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
    if (signal?.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms); signal?.addEventListener("abort", done, { once: true });
  }));
  const endpoint = async <T>(url: string, operation: (rpc: (method: string, params?: readonly unknown[]) => Promise<unknown>) => Promise<T>, cancellation?: AbortSignal) =>
    withSolanaReadDeadline(async deadlineSignal => {
      const signal = cancellation ? AbortSignal.any([deadlineSignal, cancellation]) : deadlineSignal;
      const checkAbort = () => { if (signal.aborted) throw new SolanaRpcError(cancellation?.aborted ? "cancelled" : "timeout"); };
      let nextId = 0;
      const rpc = async (method: string, params: readonly unknown[] = []): Promise<unknown> => {
        checkAbort();
        const id = ++nextId;
        let response: Response;
        try {
          response = await request(url, { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), redirect: "error", signal });
        } catch { throw new SolanaRpcError(cancellation?.aborted ? "cancelled" : signal.aborted ? "timeout" : "network"); }
        checkAbort();
        const value = await readSolanaJson(response, signal);
        checkAbort();
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new SolanaRpcError("malformed");
        const data = value as Record<string, unknown>;
        if (data.id !== id || data.jsonrpc !== "2.0") throw new SolanaRpcError("malformed");
        // A JSON-RPC error carries no result: a refused preflight is the provider's
        // answer ("rpc"), not an unreadable one. Its text is never kept.
        if (Object.hasOwn(data, "error")) throw new SolanaRpcError("rpc");
        if (!Object.hasOwn(data, "result")) throw new SolanaRpcError("malformed");
        return data.result;
      };
      if (await rpc("getGenesisHash") !== SOLANA_MAINNET_GENESIS_HASH) throw new SolanaRpcError("wrong-network");
      checkAbort();
      return operation(rpc);
    }, options.timeoutMs ?? 10_000);
  const reader = (url: string) => <T>(operation: (rpc: SolanaLiveRead) => Promise<T>) => endpoint(url, rpc => operation((method, params) => {
    if (!(READ_METHODS as readonly string[]).includes(method)) throw new SolanaRpcError("unsupported-method");
    return rpc(method, params);
  }));
  return {
    ...(options.singleEndpoint ? { singleEndpoint: true }
      : { providerKey: createHmac("sha256", PROCESS_SALT).update(`${config.url}\n${fallbackUrl ?? ""}`).digest("hex") }),
    async read(operation) {
      try { return await reader(config.url)(operation); }
      catch (error) {
        if (!fallbackUrl || !(error instanceof SolanaRpcError) || error.code === "unsupported-method") throw error;
        return reader(fallbackUrl)(operation);
      }
    },
    async readEach(operation) {
      return Promise.all(endpoints.map(url => reader(url)(operation)));
    },
    async send(wire, minContextSlot, signal, sendOptions = {}) {
      if (signal?.aborted) throw new SolanaRpcError("cancelled");
      const bytes = Buffer.from(wire, "base64");
      if (!wire || wire.length > 1644 || bytes.length > 1232 || bytes.toString("base64") !== wire ||
          !Number.isSafeInteger(minContextSlot) || minContextSlot < 1) throw new SolanaRpcError("malformed");
      let signature: string, blockhash: string;
      try {
        const transaction = getTransactionDecoder().decode(bytes);
        const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
        if (!isFullySignedTransaction(transaction) || message.version !== 0) throw new Error();
        signature = getSignatureFromTransaction(transaction); blockhash = message.lifetimeToken;
      } catch { throw new SolanaRpcError("malformed"); }
      const started = now();
      const requested = sendOptions.untilMs ?? (options.singleEndpoint ? 0 : started + SOLANA_DEFAULT_REBROADCAST_MS);
      if (!Number.isSafeInteger(requested) || requested < 0) throw new SolanaRpcError("malformed");
      const until = Math.min(requested, started + MAX_REBROADCAST_MS);
      let accepted = false, lastError: unknown = new SolanaRpcError("network");
      for (let round = 0; round <= Math.ceil(MAX_REBROADCAST_MS / interval); round++) {
        // Both providers, identical bytes, preflight on: a doomed copy is refused
        // before it can cost a fee, and a landed one is refused as processed.
        const results = await Promise.allSettled(endpoints.map(url => endpoint(url, async rpc => {
          const result = await rpc("sendTransaction", [wire, { encoding: "base64", skipPreflight: false,
            preflightCommitment: "finalized", maxRetries: 0, minContextSlot }]);
          if (typeof result !== "string" || !isSignature(result) || result !== signature) throw new SolanaRpcError("malformed");
          return result;
        }, signal)));
        for (const result of results) {
          if (result.status === "fulfilled") accepted = true; else lastError = result.reason;
        }
        if (signal?.aborted) throw new SolanaRpcError("cancelled");
        if (now() >= until) break;
        await sleep(Math.min(interval, Math.max(1, until - now())), signal);
        if (signal?.aborted) throw new SolanaRpcError("cancelled");
        // Stop once any provider reports the signature finalized, or "confirmed",
        // which since Alpenglow is the same state and is still reported until Agave
        // removes it (a processed block can still be abandoned with its fork), or
        // every provider says the blockhash can no longer land. Unanswered checks
        // just rebroadcast.
        const checks = await Promise.allSettled(endpoints.map(url => endpoint(url, async rpc => {
          const statuses = await rpc("getSignatureStatuses", [[signature]]);
          const value = statuses && typeof statuses === "object" ? (statuses as { value?: unknown }).value : undefined;
          const status = Array.isArray(value) && value.length === 1 ? value[0] as { confirmationStatus?: unknown } | null : null;
          if (status && typeof status === "object" && ["confirmed", "finalized"].includes(String(status.confirmationStatus))) return "seen" as const;
          const valid = await rpc("isBlockhashValid", [blockhash, { commitment: "processed", minContextSlot }]);
          return valid && typeof valid === "object" && (valid as { value?: unknown }).value === false ? "expired" as const : "pending" as const;
        }, signal)));
        if (checks.some(check => check.status === "fulfilled" && check.value === "seen")) { accepted = true; break; }
        if (checks.every(check => check.status === "fulfilled" && check.value === "expired")) break;
        if (now() >= until) break;
      }
      if (!accepted) throw lastError instanceof SolanaRpcError ? lastError : new SolanaRpcError("network");
      return signature;
    },
  };
}
