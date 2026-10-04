import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeCallDataEpV07 } from "@zerodev/sdk";
import { createPublicClient, custom, encodeFunctionData, type Hex } from "viem";
import { invalidatePermissions, KERNEL_REVOCATION_ABI, nextRevocationNonce, readConfirmedRevocationCutoff, type PendingRevocation, type RevocationIO, type RevocationReceipt } from "./permission-revocation";
import { isPermissionRevocationShape, permissionRevocationNonce } from "./recovery-shape";
import { sdkRevocationCall } from "./permission-revocation-fixture";

const HASH = `0x${"12".repeat(32)}` as Hex;
const TX = `0x${"34".repeat(32)}` as Hex;
const RECEIPT_BLOCK = 79_425_180n;
const ACCOUNT = `0x${"ab".repeat(20)}` as const;
function fixture() {
  let pending: PendingRevocation | null = null;
  const events: string[] = [];
  const io: RevocationIO = {
    readNonce: async () => 7,
    prepare: async (nonce) => { events.push(`prepare:${nonce}`); return { hash: HASH, operation: { sender: ACCOUNT, nonce: "0x0", callData: "0x", callGasLimit: "0x1", verificationGasLimit: "0x1", preVerificationGas: "0x1", maxFeePerGas: "0x1", maxPriorityFeePerGas: "0x1", signature: "0x" } }; },
    reprice: async (saved) => ({ hash: saved.hash, operation: saved.operation }),
    nonceConsumed: async () => false,
    send: async () => { events.push("send"); return HASH; },
    receipt: async () => null,
    wait: async () => { events.push("receipt"); return { success: true, transactionHash: TX, blockNumber: RECEIPT_BLOCK }; },
    readValidNonceFrom: async () => { events.push("verify"); return 8; },
    waitForState: async () => {},
    pending: () => pending,
    save: (value) => { events.push("save"); pending = value; },
    clear: () => { events.push("clear"); pending = null; },
    status: () => {},
  };
  return { io, events };
}

describe("owner permission revocation", () => {
  it("invalidates every earlier generation, including an undeployed account's first enable signature", () => {
    assert.equal(nextRevocationNonce(0), 2);
    assert.equal(nextRevocationNonce(1), 2);
    assert.equal(nextRevocationNonce(7), 8);
    for (const value of [-1, NaN, 1.5, 0xffff_ffff]) assert.throws(() => nextRevocationNonce(value));
  });
  it("journals the exact signed operation before broadcast and requires receipt plus chain state", async () => {
    const { io, events } = fixture();
    const result = await invalidatePermissions(io);
    assert.deepEqual(events, ["prepare:8", "save", "send", "receipt", "verify", "clear"]);
    assert.equal(result.transactionHash, TX);
    assert.equal(result.validNonceFrom, 8);
    assert.equal(io.pending(), null);
  });
  it("retains an uncertain broadcast and resubmits the same operation on retry without signing another", async () => {
    const { io, events } = fixture();
    io.send = async () => { events.push("send"); throw new Error("network lost after submission"); };
    io.wait = async () => { throw new Error("timeout"); };
    await assert.rejects(invalidatePermissions(io), /network lost/);
    assert.equal(io.pending()?.hash, HASH);
    io.send = async (saved) => { events.push("send"); assert.equal(saved.hash, HASH); return HASH; };
    io.wait = async () => ({ success: true, transactionHash: TX, blockNumber: RECEIPT_BLOCK });
    await invalidatePermissions(io);
    assert.equal(events.filter(e => e === "send").length, 2);
    assert.equal(events.filter(e => e.startsWith("prepare")).length, 1);
  });
  it("keeps older fee-replacement hashes and accepts the receipt that actually won", async () => {
    const { io } = fixture();
    io.wait = async () => { throw new Error("timeout"); };
    await assert.rejects(invalidatePermissions(io), /timeout/);
    const replacementHash = `0x${"99".repeat(32)}` as Hex;
    io.send = async saved => saved.hash;
    io.reprice = async saved => ({ hash: replacementHash, operation: { ...saved.operation, maxFeePerGas: "0x2" } });
    await assert.rejects(invalidatePermissions(io), /timeout/);
    assert.equal(io.pending()?.hash, replacementHash);
    assert.deepEqual(io.pending()?.previousOperations?.map(previous => previous.hash), [HASH]);
    io.receipt = async hash => hash === HASH ? { success: true, transactionHash: TX, blockNumber: RECEIPT_BLOCK } : null;
    io.prepare = io.reprice = io.send = async () => { throw new Error("A mined saved operation must never sign or broadcast again"); };
    io.nonceConsumed = async () => { throw new Error("A saved successful receipt precedes transaction-nonce checks"); };
    let reads = 0;
    io.readValidNonceFrom = async receipt => {
      assert.equal(receipt.blockNumber, RECEIPT_BLOCK);
      assert.deepEqual(io.pending()?.previousOperations?.map(previous => previous.hash), [HASH]);
      return ++reads === 1 ? 7 : 8;
    };
    assert.equal((await invalidatePermissions(io)).userOpHash, HASH);
    assert.equal(reads, 2);
  });
  it("prepares a fresh revocation only with chain proof the old transaction nonce is consumed", async () => {
    const { io, events } = fixture();
    io.wait = async () => { throw new Error("timeout"); };
    await assert.rejects(invalidatePermissions(io), /timeout/);
    io.nonceConsumed = async () => true;
    io.wait = async () => ({ success: true, transactionHash: TX, blockNumber: RECEIPT_BLOCK });
    await invalidatePermissions(io);
    assert.equal(events.filter(e => e.startsWith("prepare")).length, 2);
  });
  it("refuses a replacement changing the sender, call or EntryPoint nonce", async () => {
    for (const patch of [{ nonce: "0x1" }, { callData: "0x12" }, { sender: `0x${"cd".repeat(20)}` }]) {
      const { io, events } = fixture();
      io.wait = async () => { throw new Error("timeout"); };
      await assert.rejects(invalidatePermissions(io), /timeout/);
      io.reprice = async saved => ({ hash: saved.hash, operation: { ...saved.operation, ...patch } as typeof saved.operation });
      await assert.rejects(invalidatePermissions(io), /changed the revocation/);
      assert.equal(events.filter(e => e === "send").length, 1);
    }
  });
  it("does not broadcast without a durable pending record", async () => {
    const { io, events } = fixture();
    io.save = () => { throw new Error("storage unavailable"); };
    await assert.rejects(invalidatePermissions(io), /storage unavailable/);
    assert.ok(!events.includes("send"));
  });
  it("does not turn a timeout or stale RPC into a revocation claim", async () => {
    const { io } = fixture();
    io.wait = async () => { throw new Error("timeout"); };
    await assert.rejects(invalidatePermissions(io), /timeout/);
    assert.equal(io.pending()?.hash, HASH);
    io.wait = async () => ({ success: true, transactionHash: TX, blockNumber: RECEIPT_BLOCK });
    io.readValidNonceFrom = async () => 7;
    await assert.rejects(invalidatePermissions(io), /not confirmed/);
    assert.equal(io.pending()?.hash, HASH);
  });
  it("waits through a stale head, stale cutoff and an RPC error, then confirms at a pinned post-receipt block", async () => {
    const { io, events } = fixture();
    const heads: Array<bigint | Error> = [RECEIPT_BLOCK - 1n, RECEIPT_BLOCK, new Error("RPC unavailable"), RECEIPT_BLOCK + 1n];
    const stateBlocks: bigint[] = [];
    const delays: number[] = [];
    io.readValidNonceFrom = receipt => readConfirmedRevocationCutoff(receipt, {
      head: async () => {
        const head = heads.shift();
        if (head instanceof Error) throw head;
        return head!;
      },
      validNonceFrom: async blockNumber => {
        assert.equal(io.pending()?.hash, HASH, "the journal stays until the cutoff is confirmed");
        stateBlocks.push(blockNumber);
        return blockNumber === RECEIPT_BLOCK ? 7 : 8;
      },
    });
    io.waitForState = async delayMs => { delays.push(delayMs); };
    const result = await invalidatePermissions(io);
    assert.deepEqual(stateBlocks, [RECEIPT_BLOCK, RECEIPT_BLOCK + 1n]);
    assert.deepEqual(delays, [1_000, 1_000, 1_000]);
    assert.equal(events.filter(event => event === "send").length, 1);
    assert.equal(events.filter(event => event.startsWith("prepare")).length, 1);
    assert.equal(result.validNonceFrom, 8);
    assert.equal(io.pending(), null);
  });
  it("bounds failed confirmation and keeps the journal for a receipt-only retry", async () => {
    const { io, events } = fixture();
    let reads = 0;
    io.readValidNonceFrom = async () => { reads++; throw new Error("RPC unavailable"); };
    await assert.rejects(invalidatePermissions(io), /saved revocation was kept/);
    assert.equal(reads, 4);
    assert.equal(io.pending()?.hash, HASH);
    assert.ok(!events.includes("clear"));
    io.receipt = async () => ({ success: true, transactionHash: TX, blockNumber: RECEIPT_BLOCK });
    io.prepare = io.reprice = io.send = async () => { throw new Error("No second signature or broadcast"); };
    io.readValidNonceFrom = async () => 8;
    await invalidatePermissions(io);
    assert.equal(events.filter(event => event === "send").length, 1);
    assert.equal(io.pending(), null);
  });
  it("never clears a saved receipt with malformed success or block metadata", async () => {
    for (const patch of [
      { success: undefined }, { success: "true" }, { success: 1 },
      { blockNumber: undefined }, { blockNumber: Number(RECEIPT_BLOCK) }, { blockNumber: -1n },
      { transactionHash: "0x" },
    ]) {
      const { io, events } = fixture();
      io.wait = async () => ({ success: true, transactionHash: TX, blockNumber: RECEIPT_BLOCK, ...patch }) as RevocationReceipt;
      await assert.rejects(invalidatePermissions(io), /receipt could not be verified/);
      assert.equal(io.pending()?.hash, HASH);
      assert.ok(!events.includes("clear"));
      assert.ok(!events.includes("verify"));
    }
  });
  it("rejects invalid or out-of-range cutoff values without discarding the operation", async () => {
    for (const cutoff of [NaN, 7, 8.5, 0x1_0000_0000]) {
      const { io } = fixture();
      io.readValidNonceFrom = async () => cutoff;
      await assert.rejects(invalidatePermissions(io), /not confirmed/);
      assert.equal(io.pending()?.hash, HASH);
    }
  });
  it("allows a new attempt only after an explicitly failed receipt", async () => {
    const { io } = fixture();
    io.wait = async () => ({ success: false, transactionHash: TX, blockNumber: RECEIPT_BLOCK });
    await assert.rejects(invalidatePermissions(io), /transaction failed/);
    assert.equal(io.pending(), null);
  });
});

describe("receipt-anchored public RPC state", () => {
  it("does not read account state from a head behind the receipt", async () => {
    let stateReads = 0;
    const receipt = { success: true, transactionHash: TX, blockNumber: RECEIPT_BLOCK };
    for (const head of [RECEIPT_BLOCK - 1n, undefined, -1n]) {
      await assert.rejects(readConfirmedRevocationCutoff(receipt, {
        head: async () => head as bigint,
        validNonceFrom: async () => { stateReads++; return 8; },
      }), /behind the revocation receipt/);
    }
    assert.equal(stateReads, 0);
  });
  it("fetches each head without caching and sends eth_call with that exact block", async () => {
    let head = RECEIPT_BLOCK;
    let headReads = 0;
    const callBlocks: unknown[] = [];
    const client = createPublicClient({ cacheTime: 0, transport: custom({
      async request({ method, params }) {
        if (method === "eth_blockNumber") { headReads++; return `0x${(head++).toString(16)}`; }
        if (method === "eth_call") { callBlocks.push((params as unknown[])[1]); return `0x${"0".repeat(63)}8`; }
        throw new Error(`Unexpected RPC: ${method}`);
      },
    }) });
    const receipt = { success: true, transactionHash: TX, blockNumber: RECEIPT_BLOCK };
    const state = {
      head: () => client.getBlockNumber({ cacheTime: 0 }),
      validNonceFrom: (blockNumber: bigint) => client.readContract({ address: ACCOUNT, abi: KERNEL_REVOCATION_ABI, functionName: "validNonceFrom", blockNumber }),
    };
    assert.equal(await readConfirmedRevocationCutoff(receipt, state), 8);
    assert.equal(await readConfirmedRevocationCutoff(receipt, state), 8);
    assert.equal(headReads, 2);
    assert.deepEqual(callBlocks, [`0x${RECEIPT_BLOCK.toString(16)}`, `0x${(RECEIPT_BLOCK + 1n).toString(16)}`]);
  });
});

describe("revocation relay scope", () => {
  const data = encodeFunctionData({ abi: KERNEL_REVOCATION_ABI, functionName: "invalidateNonce", args: [8] });
  it("accepts the installed account SDK's raw self-call, as sent by renewal", async () => {
    const callData = await sdkRevocationCall(ACCOUNT, 2);
    assert.equal(callData, `0x1f1b92e3${"0".repeat(63)}2`, "the real account encoder skips execute for a self-call");
    assert.equal(permissionRevocationNonce(callData, ACCOUNT), 2);
  });
  it("retains the wrapped single self-call encoding", async () => {
    const callData = await encodeCallDataEpV07([{ to: ACCOUNT, value: 0n, data }]);
    assert.equal(isPermissionRevocationShape(callData, ACCOUNT), true);
  });
  it("rejects another account, value, batches, extra calldata and try mode", async () => {
    const other = `0x${"cd".repeat(20)}` as const;
    const encoded = await encodeCallDataEpV07([{ to: ACCOUNT, value: 0n, data }]);
    assert.equal(isPermissionRevocationShape(encoded, other), false);
    for (const calls of [
      [{ to: ACCOUNT, value: 1n, data }],
      [{ to: ACCOUNT, value: 0n, data }, { to: ACCOUNT, value: 0n, data }],
      [{ to: ACCOUNT, value: 0n, data: `${data}00` as Hex }],
    ]) assert.equal(isPermissionRevocationShape(await encodeCallDataEpV07(calls), ACCOUNT), false);
    // bytes32 mode starts immediately after the execute selector; byte 1 is execution type.
    const tryMode = `${encoded.slice(0, 12)}01${encoded.slice(14)}` as Hex;
    assert.equal(isPermissionRevocationShape(tryMode, ACCOUNT), false);
    assert.equal(isPermissionRevocationShape(`${encoded}00`, ACCOUNT), false, "outer trailing bytes are not canonical either");
  });
  it("rejects malformed or noncanonical direct calls without widening the selector allowlist", () => {
    for (const bad of [
      `${data}00`, data.slice(0, -2), `${data.slice(0, -1)}g`,
      `0x1f1b92e3${"0".repeat(64)}`,
      `0x1f1b92e3${"0".repeat(55)}100000000`,
      `0x095ea7b3${"0".repeat(63)}2`,
      encodeFunctionData({ abi: KERNEL_REVOCATION_ABI, functionName: "currentNonce" }),
    ]) assert.equal(isPermissionRevocationShape(bad as Hex, ACCOUNT), false, bad);
  });
});
