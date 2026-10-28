/**
 * The pool client packs reads into aggregate3 (snapshot.ts, POOL_READ_BATCH).
 *
 * A metered provider bills every call inside a JSON-RPC batch at that call's
 * own price, so the twenty-to-a-request batching the transport already did
 * saved nothing on the bill. These pin the two things the change is for and the
 * one it must not break: concurrent reads leave as ONE eth_call, a pricing pass
 * costs a fraction of what it did, and a new pool's "OLD" still reads as OLD.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  multicall3Abi,
  parseAbi,
  type Hex,
  type PublicClient,
} from "viem";
import { CASH, UNISWAP, robinhoodChain, type StockToken } from "../../packages/core/src/index";
import { POOL_READ_BATCH } from "./snapshot";
import { createPoolPriceReader } from "./venues/pool-prices";
import { revertedOld } from "./venues/pool-price";

const ABI = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128)",
  "function token0() view returns (address)",
  "function liquidity() view returns (uint128)",
]);
const OLD = encodeErrorResult({
  abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }],
  errorName: "Error",
  args: ["OLD"],
});
const MULTICALL3 = robinhoodChain.contracts!.multicall3!.address.toLowerCase();
const ZERO = "0x0000000000000000000000000000000000000000";
const USDG = (CASH.USDG as string).toLowerCase();

const token = (i: number): StockToken => ({
  symbol: `T${i}`,
  name: `T${i}`,
  address: `0x${(0xc100 + i).toString(16).padStart(40, "0")}` as `0x${string}`,
  chainlinkFeed: null,
  kind: "memecoin",
  decimals: 18,
});
const poolOf = (t: string) => `0x${"ee"}${t.slice(4)}` as `0x${string}`;

/**
 * A chain with one 0.3% USDG pool per token. `noHistory` pools answer
 * observe() with Uniswap's "OLD". Counts every eth_call the node is sent.
 */
function fakeChain(tokens: StockToken[], noHistory = new Set<string>()) {
  const pools = new Map(tokens.map((t) => [poolOf(t.address.toLowerCase()).toLowerCase(), t.address.toLowerCase()]));
  const one = (to: string, data: Hex): { success: boolean; returnData: Hex } => {
    const { functionName, args } = decodeFunctionData({ abi: ABI, data });
    const ok = (result: unknown) => ({ success: true, returnData: encodeFunctionResult({ abi: ABI, functionName, result } as never) });
    switch (functionName) {
      case "getPool": {
        const [a, b, fee] = (args as [string, string, number]).map((x) => (typeof x === "string" ? x.toLowerCase() : x));
        const t = a === USDG ? b : b === USDG ? a : null;
        return ok(fee === 3000 && t && tokens.some((x) => x.address.toLowerCase() === t) ? poolOf(t as string) : ZERO);
      }
      case "balanceOf":
        return ok(10n ** 12n);
      case "token0":
        return ok(pools.get(to));
      case "slot0":
        return ok([2n ** 96n, 0, 0, 50, 50, 0, true]);
      case "liquidity":
        return ok(10n ** 12n);
      case "observe":
        return noHistory.has(to) ? { success: false, returnData: OLD } : ok([[0n, 0n], [0n, 0n]]);
    }
    throw new Error(`unexpected ${functionName}`);
  };
  const sent = { ethCalls: 0, aggregated: 0 };
  const transport = custom({
    async request({ method, params }: { method: string; params: unknown[] }) {
      if (method === "eth_chainId") return `0x${robinhoodChain.id.toString(16)}`;
      if (method !== "eth_call") throw new Error(`unexpected ${method}`);
      sent.ethCalls += 1;
      const { to, data } = params[0] as { to: string; data: Hex };
      if (to.toLowerCase() === MULTICALL3) {
        const { args } = decodeFunctionData({ abi: multicall3Abi, data });
        const calls = (args as unknown as [readonly { target: string; callData: Hex }[]])[0];
        sent.aggregated += calls.length;
        return encodeFunctionResult({
          abi: multicall3Abi,
          functionName: "aggregate3",
          result: calls.map((c) => one(c.target.toLowerCase(), c.callData)),
        });
      }
      const r = one(to.toLowerCase(), data);
      if (!r.success) throw Object.assign(new Error("execution reverted"), { code: 3, data: r.returnData });
      return r.returnData;
    },
  });
  return {
    sent,
    batched: createPublicClient({ chain: robinhoodChain, transport, batch: POOL_READ_BATCH }) as PublicClient,
    plain: createPublicClient({ chain: robinhoodChain, transport }) as PublicClient,
  };
}

const GUARD = { minLiquidityUsdg: 0n, maxDivergenceBps: 10_000 };

describe("the pool client packs concurrent reads into one eth_call", () => {
  it("thirty getPool reads issued together leave as ONE eth_call", async () => {
    const tokens = Array.from({ length: 30 }, (_, i) => token(i));
    const chain = fakeChain(tokens);
    const pools = await Promise.all(
      tokens.map((t) =>
        chain.batched.readContract({
          address: UNISWAP.v3Factory as `0x${string}`,
          abi: ABI,
          functionName: "getPool",
          args: [t.address, CASH.USDG as `0x${string}`, 3000],
        }),
      ),
    );
    assert.equal(chain.sent.ethCalls, 1, "one billed call, not thirty");
    assert.equal(chain.sent.aggregated, 30);
    assert.deepEqual(pools.map((p) => p.toLowerCase()), tokens.map((t) => poolOf(t.address.toLowerCase()).toLowerCase()), "and each read gets its own answer");
  });

  it("a pricing pass over twenty tokens costs a fraction of what it did — and prices the same", async () => {
    const tokens = Array.from({ length: 20 }, (_, i) => token(i));
    const before = fakeChain(tokens);
    const old = await createPoolPriceReader().read({ client: before.plain, tokens, guard: GUARD, nowSec: 1_000 });
    const after = fakeChain(tokens);
    const now = await createPoolPriceReader().read({ client: after.batched, tokens, guard: GUARD, nowSec: 1_000 });

    assert.equal(now.quotes.size, 20);
    assert.deepEqual([...now.quotes.entries()], [...old.quotes.entries()], "the same quotes, read more cheaply");
    assert.ok(before.sent.ethCalls >= 20 * 10, `the unbatched pass sent ${before.sent.ethCalls}`);
    assert.ok(
      after.sent.ethCalls * 20 <= before.sent.ethCalls,
      `batched ${after.sent.ethCalls} eth_call against ${before.sent.ethCalls} — expected at least 20x fewer`,
    );
  });

  it("a new pool's observe() still fails as OLD from inside an aggregate", async () => {
    // pool-price.ts tells "no history yet" from "the read failed" by the
    // revert reason. Packed into aggregate3, the failure comes back as a slot
    // that did not succeed; viem must still raise it as that call's revert.
    const t = token(1);
    const pool = poolOf(t.address.toLowerCase());
    const chain = fakeChain([t], new Set([pool.toLowerCase()]));
    const [ok, err] = await Promise.all([
      chain.batched.readContract({ address: pool, abi: ABI, functionName: "slot0" }),
      chain.batched.readContract({ address: pool, abi: ABI, functionName: "observe", args: [[900, 0]] }).then(
        () => null,
        (e: unknown) => e,
      ),
    ]);
    assert.equal(chain.sent.ethCalls, 1, "both rode in one aggregate");
    assert.equal((ok as readonly unknown[])[0], 2n ** 96n, "the read beside it is untouched");
    assert.ok(err, "observe must fail");
    assert.equal(revertedOld(err), true, "and read as OLD, so the pool is treated as new rather than unreadable");
  });
});
