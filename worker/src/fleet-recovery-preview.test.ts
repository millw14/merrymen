import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  assessFleetRecoveryPreview, evaluateTenantRecoveryPreview, FINANCIAL_RECOVERY_PROOFS,
  MAX_RECOVERY_FLEET, type FinancialRecoveryDomain, type RecoveryProof, type RecoveryProofKind, type TenantRecoveryManifest,
} from "./fleet-recovery-preview";

const NOW = 1_791_115_200_000;
const SHA = "a".repeat(64);
const BINDING = "b".repeat(64);
const unknown = (): RecoveryProof => ({ state: "unknown" });
const verified = (kind: RecoveryProofKind): RecoveryProof => ({
  state: "verified", kind, digest: SHA, bindingDigest: BINDING, observedAtMs: NOW - 500,
});
function manifest(): TenantRecoveryManifest {
  const identity = { tenant: `0x${"1".repeat(40)}`, account: `0x${"2".repeat(40)}`, chainId: 4663,
    grantUpdatedAtSec: Math.floor((NOW - 5000) / 1000), grantIncarnation: "1234", grantDigest: SHA };
  return {
    version: 1, manifestId: "00000001-0000-4000-8000-000000000001", tenantTag: "a1".repeat(16), capturedAtMs: NOW - 1000,
    bindingDigest: BINDING, capturedIdentity: { ...identity }, currentIdentity: { ...identity },
    history: { evidence: verified("tenant-bound-quarantined-history"), lifetimeAccounting: unknown() },
    memory: { source: "historical-live-backup", capturedAtMs: NOW - 7 * 86400_000,
      envelope: verified("authenticated-tenant-memory-envelope"), privacy: verified("postcapture-forgets-and-tombstones-covered"),
      newerConflict: verified("newer-memory-conflicts-excluded") },
    target: { kind: "prospective-book", volumeId: "00000002-0000-4000-8000-000000000002",
      sourceIdentity: "00000003-0000-4000-8000-000000000003", previousSourceIdentity: null,
      highestRetainedEpoch: 12, proposedEpoch: 14, openingKind: "current-observation" },
    obligations: { pendingExecutions: 0, unresolvedNonces: 0, executableLegacyCommands: 0 },
    financial: Object.fromEntries(Object.entries(FINANCIAL_RECOVERY_PROOFS).map(([key, kind]) => [key, verified(kind)])) as Record<FinancialRecoveryDomain, RecoveryProof>,
  };
}
const evaluate = (m: unknown) => evaluateTenantRecoveryPreview(m, { nowMs: NOW });

test("complete attestations prepare review, never reads/trading authorization or original recovery", () => {
  const m = manifest(), before = JSON.stringify(m), result = evaluate(m);
  assert.equal(result.financial.state, "ready-for-review");
  assert.equal(result.memory.restore, "ready-for-review");
  assert.equal(result.memory.losslessHandover, false);
  assert.equal(result.authorizesTrading, false);
  assert.equal(result.authorizesReads, false);
  assert.equal(result.originalSourceRecovered, false);
  assert.equal(result.sinceRecoveryAccounting, "not-started");
  assert.equal(result.legacyLifetimeAccounting, "unknown");
  assert.equal(JSON.stringify(m), before, "the pure evaluator does not alter its inputs");
  assert.ok(!JSON.stringify(result).includes(m.capturedIdentity.tenant));
  assert.ok(!JSON.stringify(result).includes(m.capturedIdentity.account));
});

test("legacy history and memory remain readable candidates when every financial proof is unknown", () => {
  const m = manifest();
  for (const domain of Object.keys(FINANCIAL_RECOVERY_PROOFS) as FinancialRecoveryDomain[]) m.financial[domain] = unknown();
  const result = evaluate(m);
  assert.equal(result.legacyHistory, "readable-candidate");
  assert.equal(result.memory.readableCandidate, true);
  assert.equal(result.memory.restore, "unknown", "memory restore still requires fresh authoritative identity proof");
  assert.equal(result.financial.state, "held");
  assert.equal(result.financial.reasons.length, Object.keys(FINANCIAL_RECOVERY_PROOFS).length);
});

test("each missing financial proof independently holds the proposed book", () => {
  for (const domain of Object.keys(FINANCIAL_RECOVERY_PROOFS) as FinancialRecoveryDomain[]) {
    const m = manifest(); m.financial[domain] = unknown();
    const result = evaluate(m);
    assert.equal(result.financial.state, "held", domain);
    assert.deepEqual(result.financial.reasons, [`${domain}:unknown`]);
    assert.equal(result.legacyHistory, "readable-candidate");
  }
});

test("pending executions, missing nonce evidence and executable legacy commands never age out", () => {
  for (const field of ["pendingExecutions", "unresolvedNonces", "executableLegacyCommands"] as const) {
    for (const count of [null, 1, 100]) {
      const m = manifest(); m.obligations[field] = count;
      const result = evaluate(m);
      assert.equal(result.financial.state, "held");
      assert.ok(result.financial.reasons.includes(`obligation:${field}:${count === null ? "unknown" : "unresolved"}`));
      assert.equal(result.memory.readableCandidate, true);
    }
  }
});

test("changed or removed current grant holds financial and memory restore while preserving legacy reads", () => {
  for (const field of ["account", "chainId", "grantUpdatedAtSec", "grantIncarnation", "grantDigest"] as const) {
    const m = manifest();
    if (field === "account") m.currentIdentity!.account = `0x${"3".repeat(40)}`;
    else if (field === "chainId") m.currentIdentity!.chainId = 46630;
    else if (field === "grantUpdatedAtSec") m.currentIdentity!.grantUpdatedAtSec++;
    else if (field === "grantIncarnation") m.currentIdentity!.grantIncarnation = "1235";
    else m.currentIdentity!.grantDigest = "c".repeat(64);
    const result = evaluate(m);
    assert.equal(result.financial.state, "held", field);
    assert.equal(result.memory.restore, "blocked", field);
    assert.equal(result.legacyHistory, "readable-candidate");
  }
  const m = manifest(); m.currentIdentity = null;
  assert.equal(evaluate(m).financial.state, "held");
  assert.equal(evaluate(m).memory.restore, "blocked");
});

test("old live backup is candidate-only until postcapture erasure and newer conflicts are covered", () => {
  const m = manifest(); m.memory.privacy = unknown(); m.memory.newerConflict = unknown();
  let result = evaluate(m);
  assert.equal(result.memory.readableCandidate, true);
  assert.equal(result.memory.restore, "unknown");
  assert.equal(result.memory.losslessHandover, false);
  assert.equal(result.financial.state, "ready-for-review", "privacy/readiness cannot manufacture or remove financial proof");
  m.memory.privacy = { state: "blocked", reason: "privacy-gap" };
  result = evaluate(m);
  assert.equal(result.memory.restore, "blocked");
  m.memory.privacy = verified("postcapture-forgets-and-tombstones-covered");
  m.memory.newerConflict = { state: "blocked", reason: "conflict" };
  assert.equal(evaluate(m).memory.restore, "blocked");
});

test("different tenant envelopes and stale privacy checks cannot restore private memory", () => {
  const m = manifest();
  m.memory.envelope = { ...verified("authenticated-tenant-memory-envelope"), bindingDigest: "c".repeat(64) } as RecoveryProof;
  assert.equal(evaluate(m).memory.readableCandidate, false);
  assert.equal(evaluate(m).memory.restore, "blocked");
  m.memory.envelope = verified("authenticated-tenant-memory-envelope");
  m.memory.privacy = { ...verified("postcapture-forgets-and-tombstones-covered"), observedAtMs: NOW - 300_001 } as RecoveryProof;
  assert.equal(evaluate(m).memory.restore, "blocked");
});

test("a new reporting epoch cannot replace original IDs or reuse an occupied epoch/source", () => {
  const m = manifest(); m.target.proposedEpoch = 12;
  assert.ok(evaluate(m).financial.reasons.includes("opening:epoch-already-retained"));
  m.target.proposedEpoch = 13; m.target.highestRetainedEpoch = null;
  assert.ok(evaluate(m).financial.reasons.includes("opening:retained-epoch-coverage-unknown"));
  m.target.highestRetainedEpoch = 12; m.target.previousSourceIdentity = m.target.sourceIdentity;
  assert.ok(evaluate(m).financial.reasons.includes("source:incarnation-reused"));
  const invalid = { ...manifest(), target: { ...manifest().target, openingKind: "epoch-carry" } };
  assert.throws(() => evaluate(invalid), /Recovery preview refused/);
});

test("unknown lifetime costs are not declared exact since-recovery performance", () => {
  const result = evaluate(manifest());
  assert.equal(result.legacyLifetimeAccounting, "unknown");
  assert.equal(result.sinceRecoveryAccounting, "not-started");
  const m = manifest(); m.financial.gas = unknown(); m.financial.fees = unknown(); m.financial.budgets = unknown();
  assert.deepEqual(evaluate(m).financial.reasons, ["budgets:unknown", "fees:unknown", "gas:unknown"]);
});

test("proofs are closed, bound to this manifest, fresh and no older than its current authority capture", () => {
  const m = manifest();
  m.financial.authority = { ...verified(FINANCIAL_RECOVERY_PROOFS.authority), bindingDigest: "c".repeat(64) } as RecoveryProof;
  assert.ok(evaluate(m).financial.reasons.includes("authority:binding-conflict"));
  assert.equal(evaluate(m).evidenceStates.authority, "blocked", "an invalid bound attestation is not reported verified");
  for (const observedAtMs of [NOW + 1, NOW - 300_001, NOW - 1001]) {
    m.financial.authority = { ...verified(FINANCIAL_RECOVERY_PROOFS.authority), observedAtMs } as RecoveryProof;
    assert.equal(evaluate(m).financial.state, "held");
  }
  const wrong = manifest(); wrong.financial.authority = verified(FINANCIAL_RECOVERY_PROOFS.custody);
  assert.throws(() => evaluate(wrong), /Recovery preview refused/);
  const future = manifest(); future.capturedAtMs = NOW + 1;
  assert.equal(evaluate(future).financial.state, "held");
});

test("metadata, unknown extra fields, unsafe counts and malicious objects are sanitized refusals", () => {
  for (const value of [null, {}, { ...manifest(), privateNotes: "DO NOT DISCLOSE" },
    { ...manifest(), obligations: { ...manifest().obligations, pendingExecutions: -1 } },
    { ...manifest(), bindingDigest: "DO NOT DISCLOSE" },
    { ...manifest(), capturedIdentity: { ...manifest().capturedIdentity, grantUpdatedAtSec: Number.MAX_SAFE_INTEGER + 1 } }]) {
    assert.throws(() => evaluate(value), error => error instanceof Error
      && error.message === "Recovery preview refused: invalid, oversized or conflicting evidence.");
  }
  const getter = { ...manifest() };
  Object.defineProperty(getter, "bindingDigest", { get() { throw new Error("private"); }, enumerable: true });
  assert.throws(() => evaluate(getter), /Recovery preview refused/);
  const missing = manifest(); delete (missing.financial as Partial<typeof missing.financial>).fees;
  assert.throws(() => evaluate(missing), /Recovery preview refused/);
});

test("fleet rejects duplicate tenants/tags/manifests/accounts and excessive input before partial approval", () => {
  assert.throws(() => assessFleetRecoveryPreview([manifest(), manifest()], { nowMs: NOW }), /Recovery preview refused/);
  const second = manifest();
  second.manifestId = "00000004-0000-4000-8000-000000000004"; second.tenantTag = "c1".repeat(16);
  second.bindingDigest = "d".repeat(64); second.capturedIdentity.tenant = `0x${"4".repeat(40)}`;
  second.currentIdentity = { ...second.capturedIdentity };
  assert.throws(() => assessFleetRecoveryPreview([manifest(), second], { nowMs: NOW }), /Recovery preview refused/);
  assert.throws(() => assessFleetRecoveryPreview(Array(MAX_RECOVERY_FLEET + 1).fill(manifest()), { nowMs: NOW }), /Recovery preview refused/);
  second.currentIdentity.tenant = `0x${"5".repeat(40)}`;
  assert.throws(() => assessFleetRecoveryPreview([second], { nowMs: NOW }), /Recovery preview refused/);
});

test("fleet summary is preparation even when every tenant is ready for review", () => {
  const result = assessFleetRecoveryPreview([manifest()], { nowMs: NOW });
  assert.equal(result.state, "review-preparation");
  assert.equal(result.readyForReview, 1); assert.equal(result.held, 0);
  assert.equal(result.authorizesTrading, false); assert.equal(result.authorizesReads, false);
  assert.equal(assessFleetRecoveryPreview([], { nowMs: NOW }).emptyFleet, true);
});

test("a held tenant does not hide another tenant's readable history or readiness for review", () => {
  const first = manifest(), second = manifest();
  second.manifestId = "00000004-0000-4000-8000-000000000004"; second.tenantTag = "c1".repeat(16);
  second.bindingDigest = "d".repeat(64); second.capturedIdentity.tenant = `0x${"4".repeat(40)}`;
  second.capturedIdentity.account = `0x${"5".repeat(40)}`; second.currentIdentity = { ...second.capturedIdentity };
  second.target.sourceIdentity = "00000005-0000-4000-8000-000000000005";
  const proofs = [...Object.values(second.financial), second.history.evidence, second.history.lifetimeAccounting,
    second.memory.envelope, second.memory.privacy, second.memory.newerConflict];
  for (const p of proofs) if (p.state === "verified") p.bindingDigest = second.bindingDigest;
  second.financial.fees = unknown();
  const result = assessFleetRecoveryPreview([first, second], { nowMs: NOW });
  assert.equal(result.readyForReview, 1); assert.equal(result.held, 1);
  assert.deepEqual(result.tenants.map(t => t.legacyHistory), ["readable-candidate", "readable-candidate"]);
  assert.deepEqual(result.tenants[1]?.financial.reasons, ["fees:unknown"]);
  assert.equal(result.authorizesTrading, false);
});

test("fleet rejects sparse/accessor arrays and invalid empty-fleet clocks without invoking accessors", () => {
  assert.throws(() => assessFleetRecoveryPreview(new Array(1), { nowMs: NOW }), /Recovery preview refused/);
  const items = [manifest()];
  Object.defineProperty(items, "0", { get() { throw new Error("private accessor"); }, enumerable: true });
  assert.throws(() => assessFleetRecoveryPreview(items, { nowMs: NOW }), /Recovery preview refused/);
  assert.throws(() => assessFleetRecoveryPreview([], { nowMs: -1 }), /Recovery preview refused/);
});

test("privacy checks from before current authority capture and future grant updates remain blocked", () => {
  const m = manifest();
  m.memory.newerConflict = { ...verified("newer-memory-conflicts-excluded"), observedAtMs: NOW - 1001 } as RecoveryProof;
  assert.equal(evaluate(m).memory.restore, "blocked");
  m.currentIdentity!.grantUpdatedAtSec = Math.floor(NOW / 1000) + 1;
  m.capturedIdentity.grantUpdatedAtSec = m.currentIdentity!.grantUpdatedAtSec;
  const result = evaluate(m);
  assert.ok(result.financial.reasons.includes("current-identity:future-grant-update"));
  assert.ok(result.memory.reasons.includes("current-identity:future-grant-update"));
});

test("fleet rejects another tenant's source incarnation even with distinct account/manifest bindings", () => {
  const first = manifest(), second = manifest();
  second.manifestId = "00000004-0000-4000-8000-000000000004"; second.tenantTag = "c1".repeat(16);
  second.bindingDigest = "d".repeat(64); second.capturedIdentity.tenant = `0x${"4".repeat(40)}`;
  second.capturedIdentity.account = `0x${"5".repeat(40)}`; second.currentIdentity = { ...second.capturedIdentity };
  assert.throws(() => assessFleetRecoveryPreview([first, second], { nowMs: NOW }), /Recovery preview refused/);
});

test("preview module has no execution, DB, schema, RPC, crypto, filesystem or signer import", () => {
  const source = readFileSync(new URL("./fleet-recovery-preview.ts", import.meta.url), "utf8");
  assert.equal(/^\s*import\s/m.test(source), false);
  assert.equal(/\b(?:process|fetch|require|setTimeout)\s*(?:\.|\()/m.test(source), false);
});
