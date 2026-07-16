import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Client, PublicClient } from "viem";
import { userOpGasConfig } from "./gas";

const PIMLICO = "https://api.pimlico.io/v2/4663/rpc?apikey=test";
const OTHER = "https://bundler.example.com/rpc";

/** A bundler client whose `request` is scripted; records every method it's asked for. */
function mockBundler(handler: (method: string) => unknown) {
  const methods: string[] = [];
  const client = {
    request: async ({ method }: { method: string }) => {
      methods.push(method);
      return handler(method);
    },
  } as unknown as Client;
  return { client, methods };
}

function mockPublic(over: Partial<{ estimateFeesPerGas: () => Promise<unknown>; getGasPrice: () => Promise<bigint> }>) {
  return {
    estimateFeesPerGas: over.estimateFeesPerGas ?? (async () => ({ maxFeePerGas: 0n, maxPriorityFeePerGas: 0n })),
    getGasPrice: over.getGasPrice ?? (async () => 0n),
  } as unknown as PublicClient;
}

describe("userOpGasConfig — bundler-agnostic gas price", () => {
  it("Pimlico bundler → uses pimlico_getUserOperationGasPrice, never the ZeroDev method", async () => {
    const { client, methods } = mockBundler(() => ({
      standard: { maxFeePerGas: "0x3b9aca00", maxPriorityFeePerGas: "0x5f5e100" }, // 1e9 / 1e8
    }));
    // publicClient must NOT be consulted when the Pimlico oracle answers.
    const pub = mockPublic({
      estimateFeesPerGas: async () => {
        throw new Error("public RPC should not be called on the Pimlico happy path");
      },
    });
    const cfg = userOpGasConfig(pub, PIMLICO);
    const fees = await cfg.estimateFeesPerGas({ bundlerClient: client });

    assert.equal(fees.maxFeePerGas, 1_000_000_000n);
    assert.equal(fees.maxPriorityFeePerGas, 100_000_000n);
    assert.deepEqual(methods, ["pimlico_getUserOperationGasPrice"]);
    assert.ok(!methods.includes("zd_getUserOperationGasPrice"));
  });

  it("non-Pimlico bundler → derives EIP-1559 fees from the chain (with headroom on maxFee)", async () => {
    const { client, methods } = mockBundler(() => {
      throw new Error("no vendor gas method should be called for a generic bundler");
    });
    const pub = mockPublic({
      estimateFeesPerGas: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }),
    });
    const cfg = userOpGasConfig(pub, OTHER);
    const fees = await cfg.estimateFeesPerGas({ bundlerClient: client });

    assert.equal(fees.maxFeePerGas, 125n); // 100 * 1.25 headroom
    assert.equal(fees.maxPriorityFeePerGas, 10n);
    assert.deepEqual(methods, []); // never touched the bundler for gas
  });

  it("Pimlico oracle failing → falls back to the chain RPC", async () => {
    const { client } = mockBundler(() => {
      throw new Error("pimlico oracle down");
    });
    const pub = mockPublic({
      estimateFeesPerGas: async () => ({ maxFeePerGas: 200n, maxPriorityFeePerGas: 20n }),
    });
    const cfg = userOpGasConfig(pub, PIMLICO);
    const fees = await cfg.estimateFeesPerGas({ bundlerClient: client });

    assert.equal(fees.maxFeePerGas, 250n);
    assert.equal(fees.maxPriorityFeePerGas, 20n);
  });

  it("L3 without EIP-1559 → falls back to legacy gasPrice for both fields", async () => {
    const { client } = mockBundler(() => ({}));
    const pub = mockPublic({
      estimateFeesPerGas: async () => {
        throw new Error("Eip1559FeesNotSupportedError");
      },
      getGasPrice: async () => 80n,
    });
    const cfg = userOpGasConfig(pub, OTHER);
    const fees = await cfg.estimateFeesPerGas({ bundlerClient: client });

    assert.equal(fees.maxFeePerGas, 100n); // 80 * 1.25
    assert.equal(fees.maxPriorityFeePerGas, 100n);
  });

  it("EIP-1559 reporting a zero base fee → also falls back to legacy gasPrice", async () => {
    const { client } = mockBundler(() => ({}));
    const pub = mockPublic({
      estimateFeesPerGas: async () => ({ maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }),
      getGasPrice: async () => 40n,
    });
    const cfg = userOpGasConfig(pub, OTHER);
    const fees = await cfg.estimateFeesPerGas({ bundlerClient: client });

    assert.equal(fees.maxFeePerGas, 50n); // 40 * 1.25
    assert.equal(fees.maxPriorityFeePerGas, 50n);
  });
});
