/** Offline journal/submission tests. No signer, RPC, relay or broadcasts. */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { encodeCallDataEpV07 } from "@zerodev/sdk";
import { generateReceiveKey, makeBoundNotePoseidon } from "@gloamtrade/sdk";
import type { Hex } from "viem";
import { formatUserOperationRequest, type RpcUserOperation } from "viem/account-abstraction";
import { sealGloamShieldNote } from "./gloam-proof";
import { GLOAM_WITHDRAWAL_USDG } from "./gloam-withdrawal-contracts";
import {
  gloamOperationHash, gloamWithdrawalAmount, gloamWithdrawalCalls, readGloamWithdrawal, submitSavedGloamWithdrawal,
  type GloamSubmissionDependencies, type GloamWithdrawalReceipt, type GloamWithdrawalRecord,
} from "./gloam-withdrawal";

const ACCOUNT = `0x${"ab".repeat(20)}` as const;
const OTHER = `0x${"cd".repeat(20)}` as const;
const TX = `0x${"12".repeat(32)}` as const;
const OTHER_HASH = `0x${"34".repeat(32)}` as const;
// Structurally valid proof and signature only. They cannot authorize payment.
const PROOF = `0x${"00".repeat(256)}` as Hex;
const SIGNATURE = `0x${"11".repeat(65)}` as Hex;
const confirmed: GloamWithdrawalReceipt = { success: true, transactionHash: TX };
let fixture: GloamWithdrawalRecord;
let noteSecret: Hex;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const record = () => clone(fixture);

before(async () => {
  const receiver = await generateReceiveKey();
  const note = await makeBoundNotePoseidon(12_345_678n, GLOAM_WITHDRAWAL_USDG);
  noteSecret = note.secret;
  const memo = await sealGloamShieldNote(note, 12_345_678n, receiver.tag);
  const callData = await encodeCallDataEpV07(gloamWithdrawalCalls(12_345_678n, { commitment: note.commitment, proof: PROOF, memo }));
  const operation = formatUserOperationRequest({
    sender: ACCOUNT, nonce: 0n, signature: SIGNATURE, callData,
    callGasLimit: 400_000n, verificationGasLimit: 300_000n, preVerificationGas: 60_000n,
    maxFeePerGas: 2n, maxPriorityFeePerGas: 1n,
  }) as RpcUserOperation<"0.7">;
  fixture = {
    version: 1, account: ACCOUNT, chainId: 4663, amount: "12345678", receiveTag: receiver.tag,
    commitment: note.commitment, memo, operation, hash: gloamOperationHash(operation), state: "signed",
    createdAt: "2026-10-29T12:00:00.000Z",
  };
});

function harness(r: GloamWithdrawalRecord, overrides: Partial<GloamSubmissionDependencies> = {}) {
  const events: string[] = [];
  const saved: GloamWithdrawalRecord[] = [];
  const sent: string[] = [];
  const deps: GloamSubmissionDependencies = {
    save(value) { events.push(`save:${value.state}`); saved.push(clone(value)); },
    async receipt(hash) { events.push("receipt"); assert.equal(hash, r.hash); return null; },
    async commitmentSeen(commitment) { events.push("commitment"); assert.equal(commitment, r.commitment); return false; },
    async nonceConsumed(operation) { events.push("nonce"); assert.deepEqual(operation, r.operation); return false; },
    async send(operation) { events.push("send"); sent.push(JSON.stringify(operation)); return r.hash; },
    async wait(hash) { events.push("wait"); assert.equal(hash, r.hash); return confirmed; },
    ...overrides,
  };
  return { deps, events, saved, sent };
}

const read = (value: unknown, account = ACCOUNT) => readGloamWithdrawal(JSON.stringify(value), account);
const cannotVerify = /saved Gloam withdrawal could not be verified/;

describe("USDG amount input and exact calls", () => {
  it("accepts only positive decimal amounts of at most 500 USDG and six decimal places", () => {
    for (const [input, expected] of [["0.000001", 1n], ["12.345678", 12_345_678n], [" 12.5 ", 12_500_000n], ["500", 500_000_000n], ["500.000000", 500_000_000n]] as const) {
      assert.equal(gloamWithdrawalAmount(input), expected);
    }
    for (const input of ["", "0", "0.000000", "-1", "+1", "01", "1e2", "1,000", ".5", "1.", "0.0000001", "500.000001", "501", "NaN", "Infinity"]) {
      assert.throws(() => gloamWithdrawalAmount(input), /Enter /, input);
    }
    for (const amount of [0n, -1n, 500_000_001n]) {
      assert.throws(() => gloamWithdrawalCalls(amount, { commitment: fixture.commitment, proof: PROOF, memo: fixture.memo }), /Invalid Gloam withdrawal amount/);
    }
  });

  it("round-trips a real Gloam encrypted envelope inside the installed Kernel encoder's atomic batch", () => {
    assert.deepEqual(read(fixture), fixture);
    const json = JSON.stringify(fixture);
    assert.ok(!json.includes(noteSecret));
    assert.ok(!json.includes('"secret"'));
    assert.ok(!json.includes('"ownerKey"'));
  });
});

describe("persisted operation integrity", () => {
  it("refuses malformed, cross-account, wrong-chain and operation-bound metadata changes", () => {
    assert.throws(() => readGloamWithdrawal("not json", ACCOUNT), cannotVerify);
    assert.throws(() => readGloamWithdrawal("null", ACCOUNT), cannotVerify);
    assert.throws(() => read(fixture, OTHER), cannotVerify);
    for (const mutation of [
      { version: 2 }, { account: OTHER }, { chainId: 46630 }, { state: "pending" },
      { amount: "12345679" }, { amount: "12.345678" }, { amount: "-1" },
      { commitment: OTHER_HASH }, { memo: `${fixture.memo}00` }, { hash: OTHER_HASH },
      { createdAt: "yesterday" }, { receiveTag: OTHER }, { receiveTag: "gloamr1." },
      { transactionHash: "0x1234" },
    ]) assert.throws(() => read({ ...record(), ...mutation }), cannotVerify, JSON.stringify(mutation));
  });

  it("rejects changed calldata, nonce, sender or gas without a matching saved operation hash", () => {
    for (const mutation of [
      { callData: `${fixture.operation.callData}00` as Hex }, { nonce: "0x1" as Hex },
      { sender: OTHER }, { maxFeePerGas: "0x3" as Hex }, { callGasLimit: "0x2" as Hex },
    ]) assert.throws(() => read({ ...record(), operation: { ...fixture.operation, ...mutation } }), cannotVerify);
  });

  it("still rejects a different sender or session/enable nonce even if a corrupt record updates its hash", () => {
    for (const mutation of [
      { sender: OTHER },
      { nonce: `0x${(2n << 240n).toString(16)}` as Hex },
      { nonce: `0x${(1n << 248n).toString(16)}` as Hex },
    ]) {
      const r = record();
      r.operation = { ...r.operation, ...mutation };
      r.hash = gloamOperationHash(r.operation);
      assert.throws(() => read(r), cannotVerify);
    }
  });

  it("requires a nonempty even-length hex signature in every persisted state", () => {
    for (const state of ["prepared", "signed", "confirmed", "reverted"] as const) {
      for (const signature of [undefined, "0x", "0x1", "0xgg", "signature"]) {
        assert.throws(() => read({ ...record(), state, operation: { ...fixture.operation, signature } }), cannotVerify);
      }
    }
  });

  it("accepts explicit absent-paymaster fields but rejects nonzero sponsorship and packed paymaster data", () => {
    const zeros = {
      paymasterData: "0x" as Hex, paymasterVerificationGasLimit: "0x0" as Hex, paymasterPostOpGasLimit: "0x0" as Hex,
    };
    const empty = record();
    empty.operation = { ...empty.operation, ...zeros };
    empty.hash = gloamOperationHash(empty.operation);
    assert.deepEqual(read(empty), empty);
    for (const mutation of [
      { paymaster: OTHER }, { paymasterData: "0x01" }, { paymasterAndData: "0x01" },
      { paymasterVerificationGasLimit: "0x1" }, { paymasterPostOpGasLimit: "0x1" },
      { paymasterVerificationGasLimit: "unreadable" },
    ]) assert.throws(() => read({ ...empty, operation: { ...empty.operation, ...mutation } }), cannotVerify);
  });
});

describe("durable same-operation submission", () => {
  it("requires owner approval before invoking any dependency", async () => {
    const r = { ...record(), state: "prepared" as const };
    const h = harness(r);
    await assert.rejects(submitSavedGloamWithdrawal(r, h.deps), /owner wallet first/);
    assert.deepEqual(h.events, []);
  });

  it("checks for a landed receipt before any resend or nonce/commitment gate", async () => {
    const r = record();
    const h = harness(r);
    h.deps.receipt = async hash => { h.events.push("receipt"); assert.equal(hash, r.hash); return confirmed; };
    const result = await submitSavedGloamWithdrawal(r, h.deps);
    assert.equal(result.state, "confirmed");
    assert.equal(result.transactionHash, TX);
    assert.deepEqual(h.events, ["receipt", "save:confirmed"]);
    assert.equal(h.sent.length, 0);
  });

  it("saves the signed bytes before sending and persists the confirmed result afterward", async () => {
    const r = record();
    const h = harness(r);
    const result = await submitSavedGloamWithdrawal(r, h.deps);
    assert.deepEqual(h.events, ["receipt", "commitment", "nonce", "save:signed", "send", "wait", "save:confirmed"]);
    assert.deepEqual(h.saved[0], r);
    assert.deepEqual(h.saved[1], result);
    assert.deepEqual(h.sent, [JSON.stringify(r.operation)]);
  });

  it("never sends when durable storage fails", async () => {
    const r = record();
    const h = harness(r, { save() { throw new Error("Quota exceeded"); } });
    await assert.rejects(submitSavedGloamWithdrawal(r, h.deps), /Quota exceeded/);
    assert.equal(h.sent.length, 0);
    assert.ok(!h.events.includes("wait"));
  });

  it("retries exactly the same signed bytes after a lost send response", async () => {
    const r = record();
    const h = harness(r);
    let attempts = 0;
    h.deps.send = async op => {
      h.sent.push(JSON.stringify(op));
      if (++attempts === 1) throw new Error("Connection lost after sending");
      return r.hash;
    };
    await assert.rejects(submitSavedGloamWithdrawal(r, h.deps), /Connection lost/);
    assert.equal(h.saved[0]?.state, "signed");
    const result = await submitSavedGloamWithdrawal(read(h.saved[0]!), h.deps);
    assert.equal(result.state, "confirmed");
    assert.deepEqual(h.sent, [JSON.stringify(r.operation), JSON.stringify(r.operation)]);
    assert.deepEqual(r, fixture, "the caller's original record is not mutated");
  });

  it("does not resend a lost-response operation once its receipt appears", async () => {
    const r = record();
    const h = harness(r);
    h.deps.send = async op => { h.sent.push(JSON.stringify(op)); throw new Error("Response lost"); };
    await assert.rejects(submitSavedGloamWithdrawal(r, h.deps), /Response lost/);
    h.deps.receipt = async () => confirmed;
    const result = await submitSavedGloamWithdrawal(read(h.saved[0]!), h.deps);
    assert.equal(result.state, "confirmed");
    assert.equal(h.sent.length, 1);
  });

  it("keeps the signed record recoverable after wait timeout or a mismatched returned hash", async () => {
    for (const overrides of [
      { wait: async () => { throw new Error("Receipt timeout"); } },
      { send: async () => OTHER_HASH },
    ]) {
      const r = record();
      const h = harness(r, overrides);
      await assert.rejects(submitSavedGloamWithdrawal(r, h.deps), /Receipt timeout|different transaction identifier/);
      assert.equal(h.saved.length, 1);
      assert.equal(h.saved[0]!.state, "signed");
      assert.equal(h.saved[0]!.hash, r.hash);
    }
  });

  it("refuses another submission when the note exists or its owner nonce was consumed", async () => {
    for (const overrides of [
      { commitmentSeen: async () => true }, { nonceConsumed: async () => true },
    ]) {
      const r = record();
      const h = harness(r, overrides);
      await assert.rejects(submitSavedGloamWithdrawal(r, h.deps), /note already exists|nonce has already been used/);
      assert.equal(h.sent.length, 0);
      assert.equal(h.saved.length, 0);
    }
  });

  it("holds on read failures and never converts an outage into permission to resend", async () => {
    for (const overrides of [
      { receipt: async () => { throw new Error("Receipt unavailable"); } },
      { commitmentSeen: async () => { throw new Error("Pool unavailable"); } },
      { nonceConsumed: async () => { throw new Error("EntryPoint unavailable"); } },
    ]) {
      const r = record();
      const h = harness(r, overrides);
      await assert.rejects(submitSavedGloamWithdrawal(r, h.deps), /unavailable/);
      assert.equal(h.sent.length, 0);
      assert.equal(h.saved.length, 0);
    }
  });

  it("records a reverted receipt as reverted, never as a successful payout", async () => {
    const r = record();
    const h = harness(r, { wait: async () => ({ success: false, transactionHash: TX }) });
    const result = await submitSavedGloamWithdrawal(r, h.deps);
    assert.equal(result.state, "reverted");
    assert.equal(result.transactionHash, TX);
    assert.equal(h.saved.at(-1)!.state, "reverted");
  });

  it("requires a fresh receipt even when storage says confirmed or reverted", async () => {
    for (const state of ["confirmed", "reverted"] as const) {
      const r = { ...record(), state, transactionHash: TX };
      const h = harness(r);
      await assert.rejects(submitSavedGloamWithdrawal(r, h.deps), /saved receipt is not currently available/);
      assert.deepEqual(h.events, ["receipt"]);
    }
  });

  it("recovers a landed operation when persisting the final receipt previously failed", async () => {
    const r = record();
    const h = harness(r);
    const realSave = h.deps.save;
    h.deps.save = value => {
      if (value.state === "confirmed") throw new Error("Disk full after inclusion");
      realSave(value);
    };
    await assert.rejects(submitSavedGloamWithdrawal(r, h.deps), /Disk full/);
    assert.equal(h.saved[0]!.state, "signed");
    h.deps.receipt = async () => confirmed;
    h.deps.save = realSave;
    const result = await submitSavedGloamWithdrawal(read(h.saved[0]!), h.deps);
    assert.equal(result.state, "confirmed");
    assert.equal(h.sent.length, 1, "a receipt-save retry must never pay twice");
  });
});
