import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeAbiParameters, pad, toEventSelector, type Hex } from "viem";
import { ENTRYPOINT, GRANT_PERP_LIGHTER, LIGHTER_ROUTE_V1, type PerpRecoveryReference } from "../../../packages/core/src/index";
import type { ReceiptLog } from "../fills";
import { LIGHTER_PRIORITY_REQUEST_TOPIC } from "./legs";
import { verifyOwnerRecoveryProof, type OwnerRecoveryProofDeps, type RecoveryReceipt } from "./owner-recovery-proof";

const address = (byte: string) => `0x${byte.repeat(20)}` as Hex;
const hash = (byte: string) => `0x${byte.repeat(32)}` as Hex;
const key = (byte: string) => `0x${byte.repeat(40)}` as Hex;
const ACCOUNT = address("aa"), OTHER = address("bb"), TX = hash("cc"), OP = hash("dd"), BLOCK = hash("ee");
const EP = ENTRYPOINT.v07;
const BEFORE = toEventSelector("BeforeExecution()");
const USEROP = toEventSelector("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");
const uint48 = (n: number) => n.toString(16).padStart(12, "0");
const packed = (pub = key("02"), index = 123, slot = 16, master = index) => `0x3e${uint48(index)}${uint48(master)}${slot.toString(16).padStart(2, "0")}${pub.slice(2)}` as Hex;
const priority = (i: number, data = packed(), sender = ACCOUNT, type = 62, proxy: string = LIGHTER_ROUTE_V1.proxy): ReceiptLog => ({
  address: proxy, topics: [LIGHTER_PRIORITY_REQUEST_TOPIC], logIndex: i,
  data: encodeAbiParameters([{ type: "address" }, { type: "uint64" }, { type: "uint8" }, { type: "bytes" }, { type: "uint64" }], [sender, 7n, type, data, 1_900_000_000n]),
});
const op = (i: number, opHash = OP, sender = ACCOUNT, success = true): ReceiptLog => ({
  address: EP, topics: [USEROP, opHash, pad(sender), pad(address("00"))], logIndex: i,
  data: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }], [4n, success, 1n, 1n]),
});
function fixture() {
  let now = 1_800_000_000_000;
  const ref: PerpRecoveryReference = {
    v: 1, smartAccount: ACCOUNT, chainId: 4663, route: GRANT_PERP_LIGHTER, accountIndex: 123, apiKeyIndex: 16,
    incidentId: "11111111-2222-4333-8444-555555555555", evidenceDigest: "a".repeat(64),
    txHash: TX, userOpHash: OP, recoveryPublicKey: key("02"), oldPublicKey: key("01"), newPublicKey: key("03"), notAfterMs: now + 600_000,
  };
  const receipt: RecoveryReceipt = { status: "success", transactionHash: TX, blockHash: BLOCK, blockNumber: 100n,
    logs: [{ address: EP, topics: [BEFORE], data: "0x", logIndex: 0 }, priority(1), priority(2, "0x42", ACCOUNT, 66), op(3)] };
  const deps: OwnerRecoveryProofDeps = {
    now: () => now, smartAccount: ACCOUNT, incidentId: ref.incidentId, evidenceDigest: ref.evidenceDigest,
    oldPublicKey: ref.oldPublicKey, newPublicKey: ref.newPublicKey, retiredKeys: [key("01")],
    readChainId: async () => 4663, readReceipt: async () => receipt, readCanonicalBlockHash: async () => BLOCK,
    readAccountIndex: async () => 123n, readSlot: async () => key("02"), readFlat: async () => true,
  };
  return { ref, receipt, deps, expire: () => { now = ref.notAfterMs; } };
}

describe("verified owner recovery evidence", () => {
  it("accepts an exact owner rotation with adjacent cancellation in the same operation", async () => {
    const f = fixture();
    const result = await verifyOwnerRecoveryProof(f.ref, f.deps);
    assert.equal(result.ok, true);
    if (result.ok) { assert.equal(result.verified.rotationLogIndex, 1); assert.deepEqual(result.verified.reference, f.ref); }
  });
  for (const [name, mutate] of [
    ["wrong owner", (f: ReturnType<typeof fixture>) => { f.deps.smartAccount = OTHER; }],
    ["changed incident", f => { f.deps.incidentId = "22222222-2222-4333-8444-555555555555"; }],
    ["new unacknowledged evidence", f => { f.deps.evidenceDigest = "b".repeat(64); }],
    ["different old key", f => { f.deps.oldPublicKey = key("04"); }],
    ["different newly signed key", f => { f.deps.newPublicKey = key("04"); }],
    ["retired target key", f => { f.deps.retiredKeys = [f.ref.newPublicKey]; }],
    ["expired request", f => { f.expire(); }],
    ["unbounded expiry", f => { f.ref.notAfterMs += 900_001; }],
    ["wrong chain", f => { f.deps.readChainId = async () => 1; }],
    ["failed transaction", f => { f.receipt.status = "reverted"; }],
    ["different transaction", f => { f.receipt.transactionHash = hash("ff"); }],
    ["reorged receipt", f => { f.deps.readCanonicalBlockHash = async () => hash("ff"); }],
    ["removed receipt log", f => { Object.assign(f.receipt.logs[1]!, { removed: true }); }],
    ["log from another transaction", f => { Object.assign(f.receipt.logs[1]!, { transactionHash: hash("ff") }); }],
    ["wrong mapping", f => { f.deps.readAccountIndex = async () => 124n; }],
    ["changed slot", f => { f.deps.readSlot = async () => key("04"); }],
    ["unread slot", f => { f.deps.readSlot = async () => null; }],
    ["open exposure", f => { f.deps.readFlat = async () => false; }],
    ["unread exposure", f => { f.deps.readFlat = async () => null; }],
    ["expires during reads", f => { f.deps.readFlat = async () => { f.expire(); return true; }; }],
    ["RPC failure", f => { f.deps.readReceipt = async () => { throw new Error("private RPC diagnostics"); }; }],
  ] as [string, (f: ReturnType<typeof fixture>) => void][]) {
    it(`refuses ${name}`, async () => { const f = fixture(); mutate(f); assert.equal((await verifyOwnerRecoveryProof(f.ref, f.deps)).ok, false); });
  }
  for (const [name, logs] of [
    ["missing before-execution boundary", [priority(1), op(2)]],
    ["failed own operation", [{ address: EP, topics: [BEFORE], data: "0x", logIndex: 0 }, priority(1), op(2, OP, ACCOUNT, false)]],
    ["foreign own operation", [{ address: EP, topics: [BEFORE], data: "0x", logIndex: 0 }, priority(1), op(2, OP, OTHER)]],
    ["another bundled operation's rotation", [{ address: EP, topics: [BEFORE], data: "0x", logIndex: 0 }, priority(1), op(2, hash("ff")), op(3)]],
    ["duplicate rotation", [{ address: EP, topics: [BEFORE], data: "0x", logIndex: 0 }, priority(1), priority(2), op(3)]],
    ["duplicate log index", [{ address: EP, topics: [BEFORE], data: "0x", logIndex: 0 }, priority(1), op(1)]],
    ["forged proxy", [{ address: EP, topics: [BEFORE], data: "0x", logIndex: 0 }, priority(1, packed(), ACCOUNT, 62, OTHER), op(2)]],
    ["foreign priority sender", [{ address: EP, topics: [BEFORE], data: "0x", logIndex: 0 }, priority(1, packed(), OTHER), op(2)]],
    ["wrong account in pubdata", [{ address: EP, topics: [BEFORE], data: "0x", logIndex: 0 }, priority(1, packed(key("02"), 124)), op(2)]],
    ["wrong master account", [{ address: EP, topics: [BEFORE], data: "0x", logIndex: 0 }, priority(1, packed(key("02"), 123, 16, 124)), op(2)]],
    ["wrong slot in pubdata", [{ address: EP, topics: [BEFORE], data: "0x", logIndex: 0 }, priority(1, packed(key("02"), 123, 17)), op(2)]],
    ["different recovery key", [{ address: EP, topics: [BEFORE], data: "0x", logIndex: 0 }, priority(1, packed(key("04"))), op(2)]],
    ["malformed pubdata", [{ address: EP, topics: [BEFORE], data: "0x", logIndex: 0 }, priority(1, "0x3e"), op(2)]],
    ["two own operation events", [{ address: EP, topics: [BEFORE], data: "0x", logIndex: 0 }, priority(1), op(2), op(3)]],
  ] as [string, ReceiptLog[]][]) {
    it(`refuses ${name}`, async () => { const f = fixture(); f.receipt.logs = logs; assert.equal((await verifyOwnerRecoveryProof(f.ref, f.deps)).ok, false); });
  }
});
