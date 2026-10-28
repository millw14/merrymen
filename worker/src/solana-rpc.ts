import { env } from "node:process";

/** Read-only mainnet access. No transaction submission methods exist here. */
export const SOLANA_MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const SOLANA_RESPONSE_LIMIT_BYTES = 262_144;
const ERROR_MESSAGES = {
  "missing-config": "MERRYMEN_SOLANA_RPC_MAINNET is required.",
  "invalid-config": "Solana RPC endpoints must be HTTPS URLs without user information or fragments.",
  "invalid-fallback": "Live Solana trading needs MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK: an independent mainnet provider on a different hostname from the primary endpoint.",
  "invalid-timeout": "Solana RPC timeout must be between 1 and 30000 milliseconds.",
  timeout: "Solana read timed out.",
  network: "Solana read failed; check connectivity and endpoint configuration.",
  http: "Solana read returned an unsuccessful HTTP response.",
  redirect: "Solana read redirects are not allowed.",
  malformed: "Solana read returned a malformed response.",
  "too-large": "Solana read exceeded the response size limit.",
  rpc: "Solana RPC returned an error.",
  "wrong-network": "Solana RPC does not identify as mainnet-beta.",
  unhealthy: "Solana RPC did not report healthy status.",
  "unsupported-method": "Only allowlisted read-only Solana RPC methods are supported.",
  cancelled: "Solana submission was cancelled before completion.",
  "no-quorum": "Live Solana trading needs the same answer from two independent RPC providers.",
} as const;

export class SolanaRpcError extends Error {
  constructor(readonly code: keyof typeof ERROR_MESSAGES) {
    // Never retain provider messages, bodies, URLs or causes: they can contain keys.
    super(ERROR_MESSAGES[code]);
    this.name = "SolanaRpcError";
  }
}

export type SolanaMainnetRpcConfig = Readonly<{ url: string; fallbackUrl?: string }>;
/** Live trading's providers: both are always present and on different hostnames. */
export type SolanaLiveRpcConfig = Readonly<{ url: string; fallbackUrl: string }>;
function endpoint(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new SolanaRpcError("invalid-config"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) {
    throw new SolanaRpcError("invalid-config");
  }
  return url.toString();
}
export function readSolanaMainnetRpcConfig(
  source: Readonly<Record<string, string | undefined>> = env,
): SolanaMainnetRpcConfig {
  const raw = source.MERRYMEN_SOLANA_RPC_MAINNET?.trim();
  if (!raw) throw new SolanaRpcError("missing-config");
  const url = endpoint(raw);
  const fallback = source.MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK?.trim();
  if (!fallback) return { url };
  const fallbackUrl = endpoint(fallback);
  // A trailing dot names the same host ("rpc.example." is "rpc.example").
  const host = (value: string) => new URL(value).hostname.replace(/\.$/, "");
  if (host(url) === host(fallbackUrl)) throw new SolanaRpcError("invalid-fallback");
  return { url, fallbackUrl };
}
/**
 * Live trading refuses to run on one provider's word. Settlement, expiry and the
 * vault deployment are confirmed by two providers on different hostnames, each
 * of which proves it serves mainnet-beta on every session.
 */
export function readSolanaLiveRpcConfig(
  source: Readonly<Record<string, string | undefined>> = env,
): SolanaLiveRpcConfig {
  const config = readSolanaMainnetRpcConfig(source);
  if (!config.fallbackUrl) throw new SolanaRpcError("invalid-fallback");
  return { url: config.url, fallbackUrl: config.fallbackUrl };
}

/** Bounds both connection and response streaming, even when an injected fetch ignores abort. */
export async function withSolanaReadDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>, timeoutMs = 5_000,
): Promise<T> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new SolanaRpcError("invalid-timeout");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SolanaRpcError("timeout"));
    }, timeoutMs);
  });
  try { return await Promise.race([operation(controller.signal), deadline]); }
  finally { clearTimeout(timer); controller.abort(); }
}

/** Bounded JSON for RPC and quote reads; errors never include upstream content. */
export async function readSolanaJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const cancelBody = () => { void response.body?.cancel().catch(() => {}); };
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    cancelBody(); throw new SolanaRpcError("redirect");
  }
  if (!response.ok) { cancelBody(); throw new SolanaRpcError("http"); }
  const length = response.headers.get("content-length");
  if (length !== null && /^\d+$/.test(length) && Number(length) > SOLANA_RESPONSE_LIMIT_BYTES) {
    cancelBody(); throw new SolanaRpcError("too-large");
  }
  if (!response.body) throw new SolanaRpcError("malformed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new SolanaRpcError("timeout");
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > SOLANA_RESPONSE_LIMIT_BYTES) throw new SolanaRpcError("too-large");
      chunks.push(next.value);
    }
    if (signal.aborted) throw new SolanaRpcError("timeout");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof SolanaRpcError) throw error;
    throw new SolanaRpcError(signal.aborted ? "timeout" : "malformed");
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const READ_METHODS = ["getGenesisHash", "getHealth", "getSlot", "getAccountInfo"] as const;
type ReadMethod = (typeof READ_METHODS)[number];
export type SolanaReadonlyRpc = (method: ReadMethod, params?: readonly unknown[]) => Promise<unknown>;
type ReadOptions = { fetch?: typeof globalThis.fetch; timeoutMs?: number };

/** Each attempt is independently mainnet-verified. No implicit/public fallback, no writes. */
export async function withSolanaMainnetRead<T>(
  config: SolanaMainnetRpcConfig,
  operation: (rpc: SolanaReadonlyRpc) => Promise<T>,
  options: ReadOptions = {},
): Promise<T> {
  const checked = readSolanaMainnetRpcConfig({
    MERRYMEN_SOLANA_RPC_MAINNET: config.url,
    MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK: config.fallbackUrl,
  });
  const request = options.fetch ?? globalThis.fetch;
  const endpoints = checked.fallbackUrl ? [checked.url, checked.fallbackUrl] : [checked.url];
  for (let index = 0; index < endpoints.length; index++) {
    try {
      return await withSolanaReadDeadline(async signal => {
        let requestId = 0;
        const rpc: SolanaReadonlyRpc = async (method, params = []) => {
          if (!(READ_METHODS as readonly string[]).includes(method)) throw new SolanaRpcError("unsupported-method");
          if (signal.aborted) throw new SolanaRpcError("timeout");
          const id = ++requestId;
          let response: Response;
          try {
            response = await request(endpoints[index]!, {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
              redirect: "error", signal,
            });
          } catch { throw new SolanaRpcError(signal.aborted ? "timeout" : "network"); }
          const data = await readSolanaJson(response, signal);
          if (!data || typeof data !== "object" || Array.isArray(data)) throw new SolanaRpcError("malformed");
          const body = data as Record<string, unknown>;
          if (body.jsonrpc !== "2.0" || body.id !== id) throw new SolanaRpcError("malformed");
          if (Object.hasOwn(body, "error")) throw new SolanaRpcError("rpc");
          if (!Object.hasOwn(body, "result")) throw new SolanaRpcError("malformed");
          return body.result;
        };
        const genesis = await rpc("getGenesisHash");
        if (typeof genesis !== "string") throw new SolanaRpcError("malformed");
        if (genesis !== SOLANA_MAINNET_GENESIS_HASH) throw new SolanaRpcError("wrong-network");
        return operation(rpc);
      }, options.timeoutMs);
    } catch (error) {
      // Only failed read attempts may use the explicitly configured fallback.
      if (!(error instanceof SolanaRpcError) || index === endpoints.length - 1 ||
        error.code === "invalid-timeout" || error.code === "unsupported-method") throw error;
    }
  }
  throw new SolanaRpcError("network");
}

export function requireSolanaSlot(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SolanaRpcError("malformed");
  }
  return value;
}

/** Checks network identity and read availability; says nothing about trading readiness. */
export async function probeSolanaMainnetRpc(
  config: SolanaMainnetRpcConfig, options: ReadOptions = {},
): Promise<{ cluster: "mainnet-beta"; healthy: true; slot: number }> {
  return withSolanaMainnetRead(config, async rpc => {
    if (await rpc("getHealth") !== "ok") throw new SolanaRpcError("unhealthy");
    const slot = requireSolanaSlot(await rpc("getSlot", [{ commitment: "finalized" }]));
    return { cluster: "mainnet-beta", healthy: true, slot };
  }, options);
}
