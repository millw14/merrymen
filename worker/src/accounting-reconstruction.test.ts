import assert from "node:assert/strict";
import { test } from "node:test";
import { totalCapital } from "../../packages/core/src/capital-classify";
import type { AccountCapital, CapitalMovement } from "./chain-capital";
import { flowFingerprintOf, planReconstruction, reconstructionLines } from "./accounting-reconstruction";

const ACCOUNT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TX = `0x${"1".repeat(64)}`;
const flow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 421, agent_id: ACCOUNT, direction: "in", amount_usdg: 299, tx_hash: null,
  block_number: null, log_index: null, source: "inferred", epoch: 1, chain_id: 4663, at: 123,
  ...over,
});

function reconstruct(epoch: number, flows = [flow()]) {
  const movements: CapitalMovement[] = [{
    txHash: TX, blockNumber: 76889897, logIndex: 16, at: 1790800000, direction: "in", amountRaw: "299000000",
    counterparty: OWNER,
    classification: { kind: "capital-in", why: "external receipt", evidence: {
      counterparty: OWNER, direction: "in", txLegCount: 1, rule: "no-pair-external",
    } },
  }];
  const cap: AccountCapital = { account: ACCOUNT, movements, totals: totalCapital(movements), complete: true, notes: [] };
  return planReconstruction({
    agents: [{ smart_account: ACCOUNT, owner_address: OWNER, epoch, mode: "live", contributions_known: 0 }],
    flows, equityByAccountEpoch: new Map([[`${ACCOUNT}#${epoch}`, 299]]),
    chain: new Map([[ACCOUNT, cap]]), onchainCash: new Map([[ACCOUNT, 299]]),
  })[0]!;
}

test("a lifetime reconstruction captures the exact complete flow history before proposing a receipt", () => {
  const rows = [flow()];
  const p = reconstruct(1, rows);
  assert.equal(p.blocked, null);
  assert.equal(p.flowFingerprint, flowFingerprintOf(rows));
  assert.equal(p.flowFingerprint?.length, 64);
  assert.equal(p.contributionsAfterUsdg, 299);
  assert.deepEqual(p.quarantine.map((q) => q.id), [421]);
  assert.equal(p.insert[0]!.txHash, TX);
  assert.equal(p.insert[0]!.at, 1790800000);
  assert.match(reconstructionLines([p]).join("\n"), /blk 76889897 log 16 at 1790800000/);
});

test("lifetime receipts cannot be assigned to a later epoch without an evidenced boundary", () => {
  const p = reconstruct(2, [flow({ epoch: 2 })]);
  assert.match(p.blocked!, /requires epoch 1/);
  assert.equal(p.contributionsKnownAfter, false);
  assert.equal(p.pnlPublishableAfter, false);
});

test("the snapshot normalizes database integers but notices every stored field changing", () => {
  const initial = flow();
  const fingerprint = flowFingerprintOf([initial]);
  assert.equal(flowFingerprintOf([flow({ id: "421", epoch: "1", chain_id: "4663", at: "123" })]), fingerprint);
  const changed: Record<string, unknown> = { id: 422, agent_id: OWNER, direction: "out", amount_usdg: 298,
    tx_hash: TX, block_number: 76889897, log_index: 16, source: "chain-log", epoch: 2, chain_id: 46630, at: 124 };
  for (const [key, value] of Object.entries(changed)) {
    assert.notEqual(flowFingerprintOf([flow({ [key]: value })]), fingerprint, `${key} is part of the snapshot`);
  }
  assert.equal(flowFingerprintOf([flow({ block_number: undefined })]), null);
  const { chain_id: omitted, ...partial } = initial;
  assert.equal(flowFingerprintOf([partial]), null, "a projection missing identity columns is not a complete snapshot");
});

test("flow order does not change a snapshot, while offsetting rows do", () => {
  const a = flow();
  const b = flow({ id: 422, direction: "out" });
  assert.equal(flowFingerprintOf([a, b]), flowFingerprintOf([b, a]));
  assert.notEqual(flowFingerprintOf([a, b]), flowFingerprintOf([]), "equal net does not mean equal history");
});
