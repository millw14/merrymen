import assert from "node:assert/strict";
import { test } from "node:test";
import type { RpcUserOperation } from "viem/account-abstraction";
import { approveGloamWithdrawal, prepareGloamWithdrawal } from "./gloam-withdrawal-client";
import { FIXTURE_GLOAM_COMMITMENT, FIXTURE_GLOAM_MEMO, fixtureGloamBatch } from "./gloam-withdrawal-fixture";
import { gloamOperationHash, type GloamWithdrawalRecord } from "./gloam-withdrawal";
import type { BrowserWallet } from "./recover-client";

test("Perps cannot prepare or approve a Gloam withdrawal or touch an owner signer or network", async () => {
  const account = `0x${"ab".repeat(20)}` as const;
  const operation: RpcUserOperation<"0.7"> = {
    sender: account, nonce: "0x0", callData: await fixtureGloamBatch(), signature: "0x11",
    callGasLimit: "0x186a0", verificationGasLimit: "0x186a0", preVerificationGas: "0x186a0",
    maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x1",
  };
  const record: GloamWithdrawalRecord = {
    version: 1, account, chainId: 4663, amount: "20000000", receiveTag: "gloamr1.fixture",
    commitment: FIXTURE_GLOAM_COMMITMENT, memo: FIXTURE_GLOAM_MEMO, operation,
    hash: gloamOperationHash(operation), state: "prepared", createdAt: "2026-10-29T12:00:00.000Z",
  };
  let saved: string | null = null;
  let sideEffects = 0;
  const forbidden = () => { sideEffects += 1; throw new Error("Unexpected signer, storage write or network access"); };
  const wallet: BrowserWallet = {
    purpose: "perps", smartAccount: account, chainId: 4663,
    get ownerKey() { return forbidden(); },
    get ownerAccount() { return forbidden(); },
  };
  const globals = {
    navigator: { locks: { request: async (_key: string, _options: unknown, run: (lock: object) => Promise<unknown>) => run({}) } },
    localStorage: { getItem: () => saved, setItem: forbidden, removeItem: forbidden },
    fetch: forbidden,
  };
  const originals = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  try {
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true });
    await assert.rejects(prepareGloamWithdrawal(wallet, record.receiveTag, "20", () => {}), /Spot wallet only/);
    for (const state of ["prepared", "signed"] as const) {
      saved = JSON.stringify({ ...record, state });
      await assert.rejects(approveGloamWithdrawal(wallet, record.hash, () => {}), /Spot wallet only/);
      assert.equal(saved, JSON.stringify({ ...record, state }), "a rejected wallet must preserve its journal");
    }
    assert.equal(sideEffects, 0);
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
