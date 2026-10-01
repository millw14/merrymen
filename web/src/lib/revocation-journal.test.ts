import assert from "node:assert/strict";
import { it } from "node:test";
import { encodeCallDataEpV07 } from "@zerodev/sdk";
import { getEntryPoint } from "@zerodev/sdk/constants";
import { encodeFunctionData } from "viem";
import { formatUserOperation, getUserOperationHash, type RpcUserOperation } from "viem/account-abstraction";
import { KERNEL_REVOCATION_ABI } from "./permission-revocation";
import { readRevocationRecord } from "./revocation-journal";
import { sdkRevocationCall } from "./permission-revocation-fixture";

const ACCOUNT = `0x${"ab".repeat(20)}` as const;
const CHAIN = 4663;
async function record(raw = false) {
  const operation: RpcUserOperation<"0.7"> = {
    sender: ACCOUNT, nonce: "0x0", signature: "0x",
    callData: raw ? await sdkRevocationCall(ACCOUNT, 8) : await encodeCallDataEpV07([{ to: ACCOUNT, value: 0n, data: encodeFunctionData({ abi: KERNEL_REVOCATION_ABI, functionName: "invalidateNonce", args: [8] }) }]),
    callGasLimit: "0x1", verificationGasLimit: "0x1", preVerificationGas: "0x1", maxFeePerGas: "0x1", maxPriorityFeePerGas: "0x1",
  };
  const hash = getUserOperationHash({ userOperation: formatUserOperation(operation), chainId: CHAIN, entryPointAddress: getEntryPoint("0.7").address, entryPointVersion: "0.7" });
  return { hash, nonce: 8, operation };
}

it("verifies the exact saved transaction and its invalidation threshold", async () => {
  const value = await record();
  assert.deepEqual(readRevocationRecord(JSON.stringify(value), ACCOUNT, CHAIN), value);
  assert.throws(() => readRevocationRecord(JSON.stringify(value), ACCOUNT, 46630), /cannot be verified/);
  for (const mutation of [
    { hash: `0x${"12".repeat(32)}` }, { nonce: 2 },
    { operation: { ...value.operation, maxFeePerGas: "0x2" } },
    { previousOperations: [{ ...value, hash: `0x${"12".repeat(32)}` }] },
    { previousOperations: [{ ...value, operation: { ...value.operation, nonce: "0x1" } }] },
  ]) assert.throws(() => readRevocationRecord(JSON.stringify({ ...value, ...mutation }), ACCOUNT, CHAIN), /cannot be verified/);
});

it("resumes an actual SDK raw revocation only for its exact sender, chain, nonce and receipt hash", async () => {
  const value = await record(true);
  assert.deepEqual(readRevocationRecord(JSON.stringify(value), ACCOUNT, CHAIN), value);
  assert.throws(() => readRevocationRecord(JSON.stringify(value), `0x${"cd".repeat(20)}`, CHAIN), /cannot be verified/);
  assert.throws(() => readRevocationRecord(JSON.stringify(value), ACCOUNT, 46630), /cannot be verified/);
  for (const mutation of [
    { nonce: 2 }, { hash: `0x${"12".repeat(32)}` },
    { operation: { ...value.operation, callData: `${value.operation.callData}00` } },
    { operation: { ...value.operation, sender: `0x${"cd".repeat(20)}` } },
  ]) assert.throws(() => readRevocationRecord(JSON.stringify({ ...value, ...mutation }), ACCOUNT, CHAIN), /cannot be verified/);
});
