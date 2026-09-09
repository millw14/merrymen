/**
 * LIVE CHECK: chainRead with the governor at the fetch layer still batches.
 *
 * The governor's first version wrapped the transport's `request`, which is
 * ABOVE viem's batcher — throttling logical calls would have stopped them
 * landing in the same 20ms window and turned one request into twenty. This
 * proves the placement, against the real endpoint, in the real transport.
 */
import { createPublicClient } from "viem";
import { chainRead, rpcSummaryLines } from "../worker/src/rpc-meter";

let fetches = 0;
const real = globalThis.fetch;
globalThis.fetch = ((...a: Parameters<typeof real>) => {
  fetches += 1;
  return real(...a);
}) as typeof real;

const client = createPublicClient({ transport: chainRead("https://rpc.mainnet.chain.robinhood.com") });
const addrs = Array.from({ length: 12 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as `0x${string}`);

const t0 = Date.now();
const [block, ...codes] = await Promise.all([
  client.getBlockNumber(),
  ...addrs.map((address) => client.getCode({ address })),
]);
console.log(`13 logical calls -> ${fetches} HTTP request(s) in ${Date.now() - t0}ms`);
console.log(`head=${block}  codes read=${codes.length}`);
console.log(rpcSummaryLines().join("\n"));
