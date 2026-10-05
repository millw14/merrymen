/**
 * Pure review preparation, never a recovery writer or an authorization gate.
 * Verified inputs are attestations supplied by separately reviewed evidence
 * collectors. This module validates their shape/binding; it does not verify
 * chain receipts, decrypt memory, establish authority, or inspect a volume.
 * Client-supplied verified flags and raw metadata are not collector evidence.
 * A ready preview still requires human review and fresh checks at any later
 * mutation boundary. Legacy history remains separate from a prospective book.
 */
export const MAX_RECOVERY_FLEET = 256;
export const RECOVERY_PREVIEW_MAX_AGE_MS = 15 * 60_000;
export const RECOVERY_PROOF_MAX_AGE_MS = 5 * 60_000;

export const FINANCIAL_RECOVERY_PROOFS = {
  identity: "authoritative-current-identity",
  authority: "current-grant-and-all-rail-permissions",
  volume: "verified-persistent-volume",
  source: "new-prospective-book-incarnation",
  executions: "all-rails-settled-or-positively-invalidated",
  commands: "legacy-intents-nonexecutable-new-intents-bound",
  budgets: "complete-rolling-windows-and-pending-reservations",
  risk: "carried-risk-period-and-loss-constraints",
  fees: "carried-lifetime-hwm-withdrawals-and-accruals",
  custody: "complete-current-custody-at-boundary",
  basis: "complete-carried-or-receipt-backed-basis",
  floors: "carried-position-and-trench-constraints",
  gas: "current-prefund-and-required-cost-obligations",
  opening: "evidenced-current-observation-opening",
  legacy: "legacy-history-cursors-and-source-barriers-preserved",
} as const;

export type FinancialRecoveryDomain = keyof typeof FINANCIAL_RECOVERY_PROOFS;
export type RecoveryProofKind = typeof FINANCIAL_RECOVERY_PROOFS[FinancialRecoveryDomain]
  | "tenant-bound-quarantined-history"
  | "complete-lifetime-accounting"
  | "authenticated-tenant-memory-envelope"
  | "postcapture-forgets-and-tombstones-covered"
  | "newer-memory-conflicts-excluded";
export type RecoveryBlockedReason = "incomplete-evidence" | "conflict" | "changed-identity"
  | "privacy-gap" | "pending-execution" | "unsupported-source";
export type RecoveryProof =
  | { state: "unknown" }
  | { state: "blocked"; reason: RecoveryBlockedReason }
  | { state: "verified"; kind: RecoveryProofKind; digest: string; bindingDigest: string; observedAtMs: number };

export interface RecoveryIdentity {
  tenant: string;
  account: string;
  chainId: number;
  grantUpdatedAtSec: number;
  grantIncarnation: string;
  grantDigest: string;
}

export interface TenantRecoveryManifest {
  version: 1;
  manifestId: string;
  /** Opaque capture-local tag; identities are never returned in assessments. */
  tenantTag: string;
  capturedAtMs: number;
  /** Per-tenant manifest binding, supplied by the reviewed collector. */
  bindingDigest: string;
  /** Current authority observed when preparing this preview, not the old backup grant. */
  capturedIdentity: RecoveryIdentity;
  currentIdentity: RecoveryIdentity | null;
  history: { evidence: RecoveryProof; lifetimeAccounting: RecoveryProof };
  memory: {
    source: "none" | "durable-sealed" | "historical-live-backup" | "quiescent-backup";
    capturedAtMs: number | null;
    envelope: RecoveryProof;
    privacy: RecoveryProof;
    newerConflict: RecoveryProof;
  };
  target: {
    kind: "prospective-book";
    volumeId: string;
    sourceIdentity: string;
    previousSourceIdentity: string | null;
    highestRetainedEpoch: number | null;
    proposedEpoch: number;
    /** An observation is not a historic deposit or a reconciled epoch-carry. */
    openingKind: "current-observation";
  };
  obligations: {
    pendingExecutions: number | null;
    unresolvedNonces: number | null;
    executableLegacyCommands: number | null;
  };
  financial: Record<FinancialRecoveryDomain, RecoveryProof>;
}

export interface TenantRecoveryAssessment {
  manifestId: string;
  tenantTag: string;
  legacyHistory: "readable-candidate" | "unknown" | "blocked";
  legacyLifetimeAccounting: "verified" | "unknown" | "blocked";
  sinceRecoveryAccounting: "not-started";
  memory: {
    /** Authenticated sealed candidate only; not permission to disclose old chats. */
    readableCandidate: boolean;
    restore: "ready-for-review" | "unknown" | "blocked";
    /** A live backup never becomes a lossless handover through this evaluator. */
    losslessHandover: false;
    reasons: string[];
  };
  financial: { state: "ready-for-review" | "held"; reasons: string[] };
  evidenceStates: Record<FinancialRecoveryDomain, RecoveryProof["state"]>;
  authorizesTrading: false;
  authorizesReads: false;
  originalSourceRecovered: false;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TAG = /^[0-9a-f]{16,64}$/;
const BLOCKED_REASONS = new Set<RecoveryBlockedReason>([
  "incomplete-evidence", "conflict", "changed-identity", "privacy-gap", "pending-execution", "unsupported-source",
]);
const refuse = (): never => { throw new Error("Recovery preview refused: invalid, oversized or conflicting evidence."); };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return refuse();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return refuse();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== Object.keys(descriptors).length
      || Object.values(descriptors).some(d => !Object.hasOwn(d, "value"))) return refuse();
  return value as Record<string, unknown>;
}

function keys(value: unknown, wanted: readonly string[]): Record<string, unknown> {
  const o = object(value);
  const actual = Object.keys(o);
  if (actual.length !== wanted.length || actual.some(k => !wanted.includes(k))) return refuse();
  return o;
}

function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) refuse();
}
function text(value: unknown, pattern: RegExp): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) refuse();
}
function identity(value: unknown): void {
  const i = keys(value, ["tenant", "account", "chainId", "grantUpdatedAtSec", "grantIncarnation", "grantDigest"]);
  text(i.tenant, ADDRESS); text(i.account, ADDRESS); integer(i.chainId, 1, 0xffff_ffff);
  integer(i.grantUpdatedAtSec, 1); text(i.grantIncarnation, /^[1-9][0-9]{0,19}$/); text(i.grantDigest, DIGEST);
}
function proof(value: unknown, expected: RecoveryProofKind): void {
  const p = object(value);
  if (p.state === "unknown") { keys(p, ["state"]); return; }
  if (p.state === "blocked") {
    keys(p, ["state", "reason"]);
    if (!BLOCKED_REASONS.has(p.reason as RecoveryBlockedReason)) refuse();
    return;
  }
  if (p.state !== "verified") return refuse();
  keys(p, ["state", "kind", "digest", "bindingDigest", "observedAtMs"]);
  if (p.kind !== expected) refuse();
  text(p.digest, DIGEST); text(p.bindingDigest, DIGEST); integer(p.observedAtMs, 1);
}
function validate(value: unknown): TenantRecoveryManifest {
  const m = keys(value, ["version", "manifestId", "tenantTag", "capturedAtMs", "bindingDigest", "capturedIdentity",
    "currentIdentity", "history", "memory", "target", "obligations", "financial"]);
  if (m.version !== 1) refuse();
  text(m.manifestId, UUID); text(m.tenantTag, TAG); integer(m.capturedAtMs, 1); text(m.bindingDigest, DIGEST);
  identity(m.capturedIdentity);
  if (m.currentIdentity !== null) {
    identity(m.currentIdentity);
    if ((m.currentIdentity as RecoveryIdentity).tenant.toLowerCase() !== (m.capturedIdentity as RecoveryIdentity).tenant.toLowerCase()) refuse();
  }
  const h = keys(m.history, ["evidence", "lifetimeAccounting"]);
  proof(h.evidence, "tenant-bound-quarantined-history"); proof(h.lifetimeAccounting, "complete-lifetime-accounting");
  const mem = keys(m.memory, ["source", "capturedAtMs", "envelope", "privacy", "newerConflict"]);
  if (!["none", "durable-sealed", "historical-live-backup", "quiescent-backup"].includes(mem.source as string)) refuse();
  if (mem.capturedAtMs !== null) integer(mem.capturedAtMs, 1);
  if ((mem.source === "none") !== (mem.capturedAtMs === null)) refuse();
  proof(mem.envelope, "authenticated-tenant-memory-envelope");
  proof(mem.privacy, "postcapture-forgets-and-tombstones-covered");
  proof(mem.newerConflict, "newer-memory-conflicts-excluded");
  const target = keys(m.target, ["kind", "volumeId", "sourceIdentity", "previousSourceIdentity", "highestRetainedEpoch", "proposedEpoch", "openingKind"]);
  if (target.kind !== "prospective-book" || target.openingKind !== "current-observation") refuse();
  text(target.volumeId, UUID); text(target.sourceIdentity, UUID);
  if (target.previousSourceIdentity !== null) text(target.previousSourceIdentity, UUID);
  if (target.highestRetainedEpoch !== null) integer(target.highestRetainedEpoch, 0, 1_000_000_000);
  integer(target.proposedEpoch, 1, 1_000_000_000);
  const obligations = keys(m.obligations, ["pendingExecutions", "unresolvedNonces", "executableLegacyCommands"]);
  for (const count of Object.values(obligations)) if (count !== null) integer(count, 0, 1_000_000_000);
  const f = keys(m.financial, Object.keys(FINANCIAL_RECOVERY_PROOFS));
  for (const domain of Object.keys(FINANCIAL_RECOVERY_PROOFS) as FinancialRecoveryDomain[]) {
    proof(f[domain], FINANCIAL_RECOVERY_PROOFS[domain]);
  }
  return m as unknown as TenantRecoveryManifest;
}

function sameIdentity(a: RecoveryIdentity, b: RecoveryIdentity | null): boolean {
  return !!b && a.tenant.toLowerCase() === b.tenant.toLowerCase() && a.account.toLowerCase() === b.account.toLowerCase()
    && a.chainId === b.chainId && a.grantUpdatedAtSec === b.grantUpdatedAtSec
    && a.grantIncarnation === b.grantIncarnation && a.grantDigest === b.grantDigest;
}
function proofReason(p: RecoveryProof, binding: string, nowMs: number, fresh: boolean): string | null {
  if (p.state !== "verified") return p.state === "blocked" ? `blocked:${p.reason}` : "unknown";
  if (p.bindingDigest !== binding) return "binding-conflict";
  if (p.observedAtMs > nowMs || (fresh && nowMs - p.observedAtMs > RECOVERY_PROOF_MAX_AGE_MS)) return "observation-stale-or-future";
  return null;
}

/** Pure classification of reviewed collector attestations, never permission. */
export function evaluateTenantRecoveryPreview(input: unknown, options: { nowMs: number }): TenantRecoveryAssessment {
  const o = keys(options, ["nowMs"]); integer(o.nowMs, 1);
  const nowMs = o.nowMs, m = validate(input);
  const unchanged = sameIdentity(m.capturedIdentity, m.currentIdentity);
  const identityTimeValid = m.capturedIdentity.grantUpdatedAtSec <= Math.floor(nowMs / 1000)
    && (!m.currentIdentity || m.currentIdentity.grantUpdatedAtSec <= Math.floor(nowMs / 1000));
  const previewFresh = m.capturedAtMs <= nowMs && nowMs - m.capturedAtMs <= RECOVERY_PREVIEW_MAX_AGE_MS;
  const historyReason = proofReason(m.history.evidence, m.bindingDigest, nowMs, false);
  const lifetimeReason = proofReason(m.history.lifetimeAccounting, m.bindingDigest, nowMs, false);
  const readableHistory = historyReason === null;
  const historyState = readableHistory ? "readable-candidate" : historyReason === "unknown" ? "unknown" : "blocked";
  const memoryReasons: string[] = [];
  const envelopeReason = proofReason(m.memory.envelope, m.bindingDigest, nowMs, false);
  const memoryPresent = m.memory.source !== "none" && m.memory.capturedAtMs !== null && m.memory.capturedAtMs <= nowMs;
  if (!memoryPresent) memoryReasons.push("memory:absent-or-future-capture");
  if (envelopeReason) memoryReasons.push(`memory-envelope:${envelopeReason}`);
  if (m.memory.envelope.state === "verified" && m.memory.capturedAtMs !== null
      && m.memory.envelope.observedAtMs < m.memory.capturedAtMs) memoryReasons.push("memory-envelope:predates-memory-capture");
  if (!unchanged) memoryReasons.push("current-identity:changed-or-unavailable");
  if (!identityTimeValid) memoryReasons.push("current-identity:future-grant-update");
  if (!previewFresh) memoryReasons.push("preview:stale-or-future");
  const identityReason = proofReason(m.financial.identity, m.bindingDigest, nowMs, true);
  if (identityReason) memoryReasons.push(`memory-current-identity-proof:${identityReason}`);
  if (m.financial.identity.state === "verified" && m.financial.identity.observedAtMs < m.capturedAtMs) {
    memoryReasons.push("memory-current-identity-proof:predates-current-authority-capture");
  }
  for (const field of ["privacy", "newerConflict"] as const) {
    const reason = proofReason(m.memory[field], m.bindingDigest, nowMs, true);
    if (reason) memoryReasons.push(`memory-${field}:${reason}`);
    const p = m.memory[field];
    if (p.state === "verified" && p.observedAtMs < m.capturedAtMs) memoryReasons.push(`memory-${field}:predates-current-authority-capture`);
  }
  const memoryBlocked = memoryReasons.some(r => !r.endsWith(":unknown"));
  const financialReasons: string[] = [];
  if (!unchanged) financialReasons.push("current-identity:changed-or-unavailable");
  if (!identityTimeValid) financialReasons.push("current-identity:future-grant-update");
  if (!previewFresh) financialReasons.push("preview:stale-or-future");
  if (m.target.highestRetainedEpoch === null) financialReasons.push("opening:retained-epoch-coverage-unknown");
  else if (m.target.proposedEpoch <= m.target.highestRetainedEpoch) financialReasons.push("opening:epoch-already-retained");
  if (m.target.sourceIdentity === m.target.previousSourceIdentity) financialReasons.push("source:incarnation-reused");
  for (const [name, count] of Object.entries(m.obligations)) {
    if (count === null || count !== 0) financialReasons.push(`obligation:${name}:${count === null ? "unknown" : "unresolved"}`);
  }
  const states = {} as Record<FinancialRecoveryDomain, RecoveryProof["state"]>;
  for (const domain of Object.keys(FINANCIAL_RECOVERY_PROOFS) as FinancialRecoveryDomain[]) {
    const p = m.financial[domain];
    const reason = proofReason(p, m.bindingDigest, nowMs, true);
    const predatesCapture = p.state === "verified" && p.observedAtMs < m.capturedAtMs;
    states[domain] = reason === null && !predatesCapture ? "verified" : p.state === "unknown" ? "unknown" : "blocked";
    if (reason) financialReasons.push(`${domain}:${reason}`);
    // A current proof cannot predate the preview's captured current authority.
    if (predatesCapture) financialReasons.push(`${domain}:predates-current-authority-capture`);
  }
  return {
    manifestId: m.manifestId, tenantTag: m.tenantTag,
    legacyHistory: historyState,
    legacyLifetimeAccounting: lifetimeReason === null ? "verified" : lifetimeReason === "unknown" ? "unknown" : "blocked",
    sinceRecoveryAccounting: "not-started",
    memory: { readableCandidate: memoryPresent && envelopeReason === null
        && m.memory.envelope.state === "verified" && m.memory.envelope.observedAtMs >= m.memory.capturedAtMs!,
      restore: memoryReasons.length === 0 ? "ready-for-review" : memoryBlocked ? "blocked" : "unknown",
      losslessHandover: false, reasons: memoryReasons },
    financial: { state: financialReasons.length === 0 ? "ready-for-review" : "held", reasons: financialReasons },
    evidenceStates: states, authorizesTrading: false, authorizesReads: false, originalSourceRecovered: false,
  };
}

/** Duplicate tenants, accounts, tags or proof bindings refuse the whole fleet. */
export function assessFleetRecoveryPreview(inputs: unknown, options: { nowMs: number }): {
  state: "review-preparation";
  emptyFleet: boolean;
  tenants: TenantRecoveryAssessment[];
  readyForReview: number;
  held: number;
  authorizesTrading: false;
  authorizesReads: false;
} {
  const o = keys(options, ["nowMs"]); integer(o.nowMs, 1);
  if (!Array.isArray(inputs) || inputs.length > MAX_RECOVERY_FLEET) return refuse();
  const descriptors = Object.getOwnPropertyDescriptors(inputs);
  if (Object.getPrototypeOf(inputs) !== Array.prototype || Reflect.ownKeys(inputs).length !== inputs.length + 1
      || Object.values(descriptors).some(d => !Object.hasOwn(d, "value"))) return refuse();
  for (let i = 0; i < inputs.length; i++) if (!Object.hasOwn(descriptors, String(i))) refuse();
  const seenTenants = new Set<string>(), seenAccounts = new Map<string, string>();
  const seenSources = new Map<string, string>();
  const seenTags = new Set<string>(), seenManifests = new Set<string>(), seenBindings = new Set<string>();
  const manifests = inputs.map(validate);
  for (const m of manifests) {
    const tenant = m.capturedIdentity.tenant.toLowerCase();
    if (seenTenants.has(tenant) || seenTags.has(m.tenantTag) || seenManifests.has(m.manifestId) || seenBindings.has(m.bindingDigest)) refuse();
    seenTenants.add(tenant); seenTags.add(m.tenantTag); seenManifests.add(m.manifestId); seenBindings.add(m.bindingDigest);
    if (m.currentIdentity && m.currentIdentity.tenant.toLowerCase() !== tenant) refuse();
    for (const i of [m.capturedIdentity, m.currentIdentity]) {
      if (!i) continue;
      const account = `${i.chainId}:${i.account.toLowerCase()}`;
      const prior = seenAccounts.get(account);
      if (prior && prior !== tenant) refuse();
      seenAccounts.set(account, tenant);
    }
    for (const source of [m.target.sourceIdentity, m.target.previousSourceIdentity]) {
      if (!source) continue;
      const prior = seenSources.get(source);
      if (prior && prior !== tenant) refuse();
      seenSources.set(source, tenant);
    }
  }
  const tenants = manifests.map(m => evaluateTenantRecoveryPreview(m, options));
  const readyForReview = tenants.filter(t => t.financial.state === "ready-for-review").length;
  return { state: "review-preparation", emptyFleet: tenants.length === 0, tenants,
    readyForReview, held: tenants.length - readyForReview, authorizesTrading: false, authorizesReads: false };
}
