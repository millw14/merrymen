import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { encodeCallDataEpV07 } from "@zerodev/sdk";
import { getEntryPoint } from "@zerodev/sdk/constants";
import { encodeFunctionData, numberToHex, pad } from "viem";
import { formatUserOperation, getUserOperationHash, type RpcUserOperation } from "viem/account-abstraction";
import { KERNEL_REVOCATION_ABI } from "./permission-revocation";
import { assertRevocationFunded } from "./revoke-client";

const ACCOUNT = `0x${"ab".repeat(20)}` as const;
const CHAIN = 4663;
const KEY = `merrymen.permission-revocation.v1.${CHAIN}.${ACCOUNT}`;
const realFetch = globalThis.fetch;
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let stored: Map<string, string>;
let rpc: { balance: bigint; deposit: bigint } | "down";
let rpcCalls: string[];

async function savedRevocation() {
  const operation: RpcUserOperation<"0.7"> = {
    sender: ACCOUNT, nonce: "0x0", signature: "0x",
    callData: await encodeCallDataEpV07([{ to: ACCOUNT, value: 0n, data: encodeFunctionData({ abi: KERNEL_REVOCATION_ABI, functionName: "invalidateNonce", args: [2] }) }]),
    callGasLimit: "0x1", verificationGasLimit: "0x1", preVerificationGas: "0x1", maxFeePerGas: "0x1", maxPriorityFeePerGas: "0x1",
  };
  const hash = getUserOperationHash({ userOperation: formatUserOperation(operation), chainId: CHAIN, entryPointAddress: getEntryPoint("0.7").address, entryPointVersion: "0.7" });
  return JSON.stringify({ hash, nonce: 2, operation });
}

beforeEach(() => {
  stored = new Map();
  rpc = { balance: 0n, deposit: 0n };
  rpcCalls = [];
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); },
    removeItem: (key: string) => { stored.delete(key); },
  } });
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { id, method } = JSON.parse(String(init?.body)) as { id: number; method: string };
    rpcCalls.push(method);
    if (rpc === "down") throw new TypeError("fetch failed");
    const result = method === "eth_getBalance" ? numberToHex(rpc.balance)
      : method === "eth_call" ? pad(numberToHex(rpc.deposit))
      : null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("the revocation fee check that runs before the agent is stopped", () => {
  it("refuses an account with no ETH and no EntryPoint deposit, naming it and its network", async () => {
    await assert.rejects(assertRevocationFunded({ smartAccount: ACCOUNT, chainId: CHAIN }),
      new RegExp(`Robinhood Chain \\(4663\\), and account ${ACCOUNT} has none\\..*Nothing was stopped or signed\\.`));
    assert.deepEqual(rpcCalls.sort(), ["eth_call", "eth_getBalance"]);
  });

  it("lets ETH in the account or a deposit at the EntryPoint pay", async () => {
    rpc = { balance: 1n, deposit: 0n };
    await assertRevocationFunded({ smartAccount: ACCOUNT, chainId: CHAIN });
    rpc = { balance: 0n, deposit: 1n };
    await assertRevocationFunded({ smartAccount: ACCOUNT, chainId: CHAIN });
  });

  it("does not read an unreachable network as an empty account", async () => {
    rpc = "down";
    await assertRevocationFunded({ smartAccount: ACCOUNT, chainId: CHAIN });
  });

  it("lets a verified saved revocation through without a balance read, since it may already be mined", async () => {
    stored.set(KEY, await savedRevocation());
    await assertRevocationFunded({ smartAccount: ACCOUNT, chainId: CHAIN });
    assert.deepEqual(rpcCalls, []);
  });

  it("refuses a saved revocation it cannot verify before the stop, as the revocation itself would after it", async () => {
    for (const raw of ["{not json", (await savedRevocation()).replace(/"nonce":2/, '"nonce":3')]) {
      stored.set(KEY, raw);
      rpc = { balance: 10n ** 18n, deposit: 0n };
      await assert.rejects(assertRevocationFunded({ smartAccount: ACCOUNT, chainId: CHAIN }), /pending revocation record cannot be verified/);
    }
    assert.deepEqual(rpcCalls, []);
  });
});
