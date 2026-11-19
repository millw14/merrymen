/**
 * THE BALANCE OF THE WALLET AN OWNER SENDS FROM, so Max can keep a reserve.
 *
 * Read in the browser, from a public RPC for that one network. The read sends
 * only the address the owner chose to fill in, and only for Max. The server is
 * not involved: nothing here proxies through Merrymen. That leaves no endpoint
 * a stranger could use to spend our provider credits.
 *
 * Each URL was checked on 2026-11-19 to answer a browser origin (CORS) for a
 * balance read. Solana's own api.mainnet-beta refused one with 403, which is
 * why Solana goes to publicnode.
 *
 * `null` IS THE ANSWER FOR ANY FAILURE: a refused request, a timeout, a
 * malformed reply, an address that is not one. The panel then says it could
 * not read the balance and leaves Max off. A failed read never becomes 0, which
 * would read as "this wallet is empty".
 */
import { robinhoodChain } from "@merrymen/core";
import type { DepositSource, SourceId } from "./deposit-math";

export const SOURCE_RPC: Readonly<Record<SourceId, string>> = Object.freeze({
  "eth-robinhood": robinhoodChain.rpcUrls.default.http[0]!,
  "eth-ethereum": "https://ethereum-rpc.publicnode.com",
  "eth-base": "https://mainnet.base.org",
  "eth-arbitrum": "https://arb1.arbitrum.io/rpc",
  "sol-solana": "https://solana-rpc.publicnode.com",
});

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Is `address` the right shape for this source's network? Shape only. */
export function isSourceAddress(source: DepositSource, address: string): boolean {
  return source.family === "evm" ? EVM_ADDRESS.test(address) : SOLANA_ADDRESS.test(address);
}

/** The balance in base units, or null for anything short of a clean answer. */
export async function readSourceBalance(
  source: DepositSource,
  address: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<bigint | null> {
  if (!isSourceAddress(source, address)) return null;
  const body = source.family === "evm"
    ? { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }
    : { jsonrpc: "2.0", id: 1, method: "getBalance", params: [address, { commitment: "confirmed" }] };
  try {
    const response = await fetchImpl(SOURCE_RPC[source.id], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) return null;
    const json = (await response.json()) as { result?: unknown; error?: unknown };
    if (json.error !== undefined) return null;
    if (source.family === "evm") {
      return typeof json.result === "string" && /^0x[0-9a-fA-F]+$/.test(json.result) ? BigInt(json.result) : null;
    }
    const value = (json.result as { value?: unknown } | null | undefined)?.value;
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  } catch {
    return null;
  }
}
