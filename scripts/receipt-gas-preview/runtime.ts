import { custom, createPublicClient } from "viem";
import { gasRecoveryChain, recoverGasProof } from "./receipt-proof.ts";

export { recoverGasProof };
export const RPC_METHODS = Object.freeze([
  "eth_chainId", "eth_blockNumber", "eth_getTransactionReceipt", "eth_getBlockByNumber", "eth_call",
]);
/** The exported client exposes only the tested receipt reader and blocks every other RPC method. */
export function createReadOnlyChain(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Unsupported RPC URL");
  let id = 0;
  const client = createPublicClient({ transport: custom({
    request: async ({ method, params }) => {
      if (!RPC_METHODS.includes(method)) throw new Error("RPC method is outside the receipt read allowlist");
      const requestId = ++id;
      const response = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
      });
      if (!response.ok) throw new Error("Receipt RPC unavailable");
      const result = await response.json();
      if (result.jsonrpc !== "2.0" || result.id !== requestId || result.error ||
        !Object.hasOwn(result, "result")) throw new Error("Receipt RPC read failed");
      return result.result;
    },
  }, { retryCount: 0 }) });
  return gasRecoveryChain(client);
}
