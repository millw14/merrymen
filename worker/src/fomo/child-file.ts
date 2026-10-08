/**
 * THE CHILD'S FOMO FILE — `fomo.json` in a hosted child's home.
 *
 * The orchestrator runs ingestion once for the fleet and materialises, for
 * each tenant whose data access is on, the monitoring and following inputs
 * that tenant's child needs on its tick: which coins to look at and why, the
 * cohort events that prompted them, the latest shared dossier and the rendered
 * Brain lens. Same wire as research-files.ts: the orchestrator holds the key
 * and the database, the child reads a file, and an absent or unreadable file
 * is synchronously "nothing routed" — never "nothing happened".
 *
 * WHY THE READER RE-VALIDATES EVERYTHING. The orchestrator wrote this file,
 * but it lives in a directory the tenant's own process can write, it may have
 * been written by an older or newer build, and it may be cut short by a full
 * disk. So every field is rebuilt from `unknown`: identity from the token key
 * (a key whose parts disagree is refused, not repaired), every label and line
 * of text through sanitizeText (it is third-party text: data, never
 * instructions), every list bounded. A part that cannot be trusted is dropped
 * in the direction that makes the agent do LESS: a malformed dossier becomes
 * no dossier (the follow review then waits), never a dossier with its
 * opposing claims quietly removed.
 *
 * Nothing here is accounting. Provider money inside trigger events stays the
 * display/research floats types.ts describes, and nothing in this file feeds
 * equity, P&L, a cap or a grant.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sanitizeText } from "../research/news";
import type { ChildFomoFile, ChildSignal, ChildTail, ChildTailEvent, FomoAccess } from "./contract";
import { DOSSIER_TOPICS, type DossierTopic } from "./dossier";
import { tokenFromKey } from "./identity";
import { tenantKey, traderEventOf } from "./store";
import type {
  ClaimSupport,
  CoinDossier,
  DossierClaim,
  DossierCoverage,
  EvidenceKind,
  EvidenceRef,
  FlowSummary,
  FomoHealthState,
  RetrievalPriority,
  TokenIdentity,
  TokenLabel,
  TraderEvent,
} from "./types";

export const CHILD_FOMO_FILE = "fomo.json";

export const CHILD_FOMO_LIMITS = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  signals: 40,
  triggers: 25,
  lensChars: 1200,
  lensRefs: 40,
  lensRefChars: 64,
  detailChars: 500,
  /** Orchestrator and child share a host and a clock; a file further in the future than this is not believed. */
  futureSkewMs: 60_000,
  defaultMaxAgeMs: 10 * 60_000,
  eventTextChars: 500,
  claimTextChars: 400,
  listItemChars: 300,
  keyChars: 256,
  /** Tails per state: at most this many active and this many recently ended (store.ts activeTailsPerTenant). */
  tails: 3,
  tailEvents: 20,
});

export type ChildFomoReadReason = "ok" | "absent" | "unreadable" | "wrong-tenant" | "stale" | "invalid";

export interface ChildFomoRead {
  file: ChildFomoFile | null;
  reason: ChildFomoReadReason;
  /** Signals refused or cut while reading (forged identity, duplicate, over the bound). */
  droppedSignals: number;
}

export interface ChildFomoWriteResult {
  bytes: number;
  signals: number;
  /** Signals the writer refused because the reader would refuse them. */
  droppedInvalid: number;
  /** Lowest-priority signals left out to stay under the size limit. */
  droppedForSize: number;
}

export function childFomoFilePath(home: string): string {
  return path.join(home, CHILD_FOMO_FILE);
}

// ── vocabularies ────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;
type Reason = ChildSignal["reasons"][number];

const HEALTH_STATES: Record<FomoHealthState, true> = {
  "not-configured": true,
  disabled: true,
  "permission-required": true,
  "provider-unavailable": true,
  "budget-limited": true,
  "research-only": true,
  "watching-condition": true,
  researching: true,
  "receiving-fresh-data": true,
};

/** Lower is more important. Position protection is the reason the file exists. */
const PRIORITY_RANK: Record<RetrievalPriority, number> = { "position-protection": 0, interactive: 1, discovery: 2 };

const REASONS: Record<Reason, true> = {
  held: true,
  watched: true,
  cohort: true,
  dependency: true,
  "early-discovery": true,
  "robinhood-thesis": true,
  tailed: true,
};

const STANCES: Record<DossierClaim["stance"], true> = { supporting: true, opposing: true, neutral: true };
const SUPPORTS: Record<ClaimSupport, true> = { "source-statement": true, "observed-action": true, "verified-fact": true, inference: true };
const EVIDENCE_KINDS: Record<EvidenceKind, true> = {
  event: true,
  thesis: true,
  comment: true,
  holdings: true,
  positions: true,
  fills: true,
  profile: true,
  ranking: true,
  board: true,
  "token-stats": true,
  dossier: true,
  assessment: true,
  decision: true,
};

function isIn<T extends string | number>(set: Record<T, unknown>, v: unknown): v is T {
  return (typeof v === "string" || typeof v === "number") && Object.hasOwn(set, v);
}

function isRecord(v: unknown): v is Rec {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const SLUG = /^[a-z][a-z0-9-]{0,23}$/;
const LENS_REF = /^[\x21-\x7e]+$/;
const HTTPS = /^https:\/\/\S+$/;

/** An exact identifier: bounded, no control characters, never trimmed or case-folded. */
function exact(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max && !CONTROL.test(v) ? v : null;
}

/** Display text from a third party: sanitised, capped, and empty means unknown. */
function clean(v: unknown, max: number): string | null {
  return typeof v === "string" ? sanitizeText(v, max) || null : null;
}

function count(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** null/absent is unknown (null); a present value of the wrong type is invalid (undefined). */
function nullableCount(v: unknown): number | null | undefined {
  if (v === null || v === undefined) return null;
  return count(v) ?? undefined;
}

function time(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && Number.isSafeInteger(Math.trunc(v)) ? Math.trunc(v) : null;
}

function nullableTime(v: unknown): number | null | undefined {
  if (v === null || v === undefined) return null;
  return time(v) ?? undefined;
}

/** A list of display strings, or null when it is not one. Every item must be a string. */
function strings(v: unknown, maxChars: number = CHILD_FOMO_LIMITS.listItemChars): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") return null;
    const s = sanitizeText(x, maxChars);
    if (s) out.push(s);
  }
  return out;
}

// ── identity and labels ─────────────────────────────────────────────────────

/**
 * A token whose key re-parses (identity.ts tokenFromKey) and whose parts say
 * the same thing as the key. Symbols are never consulted. An uppercase EVM
 * address, a Solana mint on an EVM network or a key/address mismatch is a
 * forged or corrupt identity and is refused.
 */
function tokenOf(v: unknown): TokenIdentity | null {
  if (!isRecord(v)) return null;
  const key = exact(v.key, CHILD_FOMO_LIMITS.keyChars);
  const t = key ? tokenFromKey(key) : null;
  const c = v.chain;
  if (!t || !isRecord(c)) return null;
  if (v.address !== t.address || c.namespace !== t.chain.namespace || (c.networkId ?? null) !== t.chain.networkId) return null;
  const slug = t.chain.slug ?? (typeof c.slug === "string" && SLUG.test(c.slug) ? c.slug : null);
  return { chain: { namespace: t.chain.namespace, networkId: t.chain.networkId, slug }, address: t.address, key: t.key };
}

function labelOf(v: unknown): TokenLabel {
  const r = isRecord(v) ? v : {};
  return { symbol: clean(r.symbol, 32), name: clean(r.name, 80) };
}

// ── trigger events ──────────────────────────────────────────────────────────

const eventTime = (e: TraderEvent): number => e.sourceEventAt ?? e.execAt ?? e.observedAt;

/**
 * store.ts traderEventOf rebuilds the event's structure; this adds what a file
 * read by a model-facing tick needs on top: the event must be about THIS coin,
 * and every human-written string is sanitised and capped.
 */
function triggerOf(v: unknown, tokenKey: string): TraderEvent | null {
  const e = traderEventOf(v);
  if (!e || !e.token || e.token.key !== tokenKey) return null;
  if (!exact(e.eventKey, CHILD_FOMO_LIMITS.keyChars) || !exact(e.trader.userId, 128)) return null;
  return {
    ...e,
    trader: { ...e.trader, handle: clean(e.trader.handle, 64), displayName: clean(e.trader.displayName, 80) },
    tokenLabel: labelOf(e.tokenLabel),
    tradeId: exact(e.tradeId, CHILD_FOMO_LIMITS.keyChars),
    swapId: exact(e.swapId, CHILD_FOMO_LIMITS.keyChars),
    transferId: exact(e.transferId, CHILD_FOMO_LIMITS.keyChars),
    txHash: exact(e.txHash, 128),
    text: clean(e.text, CHILD_FOMO_LIMITS.eventTextChars),
  };
}

function triggersOf(v: unknown[], tokenKey: string): TraderEvent[] {
  const seen = new Set<string>();
  const out: TraderEvent[] = [];
  for (const x of v) {
    const e = triggerOf(x, tokenKey);
    if (!e || seen.has(e.eventKey)) continue;
    seen.add(e.eventKey);
    out.push(e);
  }
  // Newest first, so the bound drops the oldest evidence, not the latest.
  out.sort((a, b) => eventTime(b) - eventTime(a));
  return out.slice(0, CHILD_FOMO_LIMITS.triggers);
}

// ── dossier ─────────────────────────────────────────────────────────────────

function refsOf(v: unknown): EvidenceRef[] | null {
  if (!Array.isArray(v)) return null;
  const out: EvidenceRef[] = [];
  for (const x of v) {
    if (!isRecord(x) || !isIn(EVIDENCE_KINDS, x.kind)) return null;
    const id = exact(x.id, 300);
    if (!id) return null;
    let sourceUrl: string | null = null;
    if (x.sourceUrl !== null && x.sourceUrl !== undefined) {
      // A link is kept only as the provider-verified https URL it was stored as.
      if (typeof x.sourceUrl !== "string" || x.sourceUrl.length > 500 || !HTTPS.test(x.sourceUrl)) return null;
      sourceUrl = x.sourceUrl;
    }
    out.push({ id, kind: x.kind, sourceUrl });
  }
  return out;
}

function claimOf(v: unknown): DossierClaim | null {
  if (!isRecord(v) || !isIn(STANCES, v.stance) || !isIn(SUPPORTS, v.support) || typeof v.summary !== "string") return null;
  const claimKey = exact(v.claimKey, 200);
  const familyCount = count(v.familyCount);
  const authorCount = count(v.authorCount);
  const evidence = refsOf(v.evidence);
  if (!claimKey || familyCount === null || authorCount === null || !evidence) return null;
  const claim: DossierClaim & { topic?: DossierTopic } = {
    claimKey,
    stance: v.stance,
    summary: sanitizeText(v.summary, CHILD_FOMO_LIMITS.claimTextChars),
    support: v.support,
    familyCount,
    authorCount,
    evidence,
  };
  // The topic is the one working field worth carrying: it lets the child name
  // what a claim is about without re-reading anybody's prose.
  if (typeof v.topic === "string" && (DOSSIER_TOPICS as readonly string[]).includes(v.topic)) claim.topic = v.topic as DossierTopic;
  return claim;
}

/** null stays null; a present value that is not a valid claim is invalid (undefined). */
function nullableClaim(v: unknown): DossierClaim | null | undefined {
  if (v === null || v === undefined) return null;
  return claimOf(v) ?? undefined;
}

function flowOf(v: unknown): FlowSummary | null | undefined {
  if (v === null || v === undefined) return null;
  if (!isRecord(v)) return undefined;
  const window = exact(v.window, 32);
  const distinctBuyers = nullableCount(v.distinctBuyers);
  const distinctSellers = nullableCount(v.distinctSellers);
  const cohortBuyers = nullableCount(v.cohortBuyers);
  const cohortSellers = nullableCount(v.cohortSellers);
  const repeatAddsBySameTrader = count(v.repeatAddsBySameTrader);
  const notes = strings(v.notes);
  if (
    !window ||
    distinctBuyers === undefined ||
    distinctSellers === undefined ||
    cohortBuyers === undefined ||
    cohortSellers === undefined ||
    repeatAddsBySameTrader === null ||
    !notes
  ) {
    return undefined;
  }
  return { window, distinctBuyers, distinctSellers, cohortBuyers, cohortSellers, repeatAddsBySameTrader, notes };
}

function coverageOf(v: unknown): DossierCoverage | null {
  if (!isRecord(v)) return null;
  const uniqueTheses = count(v.uniqueTheses);
  const uniqueAuthors = count(v.uniqueAuthors);
  const windowRequested = typeof v.windowRequested === "string" ? sanitizeText(v.windowRequested, 32) : null;
  const oldestSourceAt = nullableTime(v.oldestSourceAt);
  const newestSourceAt = nullableTime(v.newestSourceAt);
  const providerTotal = nullableCount(v.providerTotal);
  const pagesRequested = count(v.pagesRequested);
  const pagesReturned = count(v.pagesReturned);
  const duplicatesRemoved = count(v.duplicatesRemoved);
  const sourceCaps = strings(v.sourceCaps);
  const missingSections = strings(v.missingSections);
  const limitations = strings(v.limitations);
  if (
    uniqueTheses === null ||
    uniqueAuthors === null ||
    windowRequested === null ||
    oldestSourceAt === undefined ||
    newestSourceAt === undefined ||
    providerTotal === undefined ||
    pagesRequested === null ||
    pagesReturned === null ||
    duplicatesRemoved === null ||
    !sourceCaps ||
    !missingSections ||
    !limitations
  ) {
    return null;
  }
  return {
    uniqueTheses,
    uniqueAuthors,
    windowRequested,
    oldestSourceAt,
    newestSourceAt,
    providerTotal,
    pagesRequested,
    pagesReturned,
    duplicatesRemoved,
    sourceCaps,
    missingSections,
    limitations,
  };
}

function wordsVsActionsOf(v: unknown): CoinDossier["wordsVsActions"] | null {
  if (!Array.isArray(v)) return null;
  const out: CoinDossier["wordsVsActions"] = [];
  for (const x of v) {
    if (!isRecord(x)) return null;
    const userId = exact(x.userId, 128);
    const statement = clean(x.statement, CHILD_FOMO_LIMITS.listItemChars);
    const action = clean(x.action, CHILD_FOMO_LIMITS.listItemChars);
    const evidence = refsOf(x.evidence);
    if (!userId || !statement || !action || !evidence) return null;
    out.push({ userId, handle: clean(x.handle, 64), statement, action, evidence });
  }
  return out;
}

/**
 * The shared dossier for THIS signal's coin, or null. Identity, revision and
 * build time must hold; every container the following review reads (claims,
 * words vs actions, coverage, unknowns) must be well formed, and if any part
 * is not, the whole dossier goes. Dropping only the bad claim could drop an
 * objection and leave a case that looks stronger than the evidence.
 */
function dossierOf(v: unknown, tokenKey: string): CoinDossier | null {
  if (!isRecord(v)) return null;
  const dossierId = exact(v.dossierId, 200);
  const revision = typeof v.revision === "number" && Number.isSafeInteger(v.revision) && v.revision >= 0 ? v.revision : null;
  const token = tokenOf(v.token);
  const builtAt = time(v.builtAt);
  const inputsHash = exact(v.inputsHash, 200);
  if (!dossierId || revision === null || !token || token.key !== tokenKey || builtAt === null || !inputsHash) return null;
  const strongestSupport = nullableClaim(v.strongestSupport);
  const strongestOpposition = nullableClaim(v.strongestOpposition);
  if (strongestSupport === undefined || strongestOpposition === undefined || !Array.isArray(v.claims)) return null;
  const claims: DossierClaim[] = [];
  for (const c of v.claims) {
    const claim = claimOf(c);
    if (!claim) return null;
    claims.push(claim);
  }
  const flow = flowOf(v.flow);
  const wordsVsActions = wordsVsActionsOf(v.wordsVsActions);
  const marketContext = strings(v.marketContext);
  const routeContext = strings(v.routeContext);
  const unknowns = strings(v.unknowns);
  const changeConditions = strings(v.changeConditions);
  const refreshedSections = strings(v.refreshedSections, 64);
  const coverage = coverageOf(v.coverage);
  const evidence = refsOf(v.evidence);
  const ver = isRecord(v.versions) ? v.versions : null;
  const schema = ver ? exact(ver.schema, 64) : null;
  if (
    flow === undefined ||
    !wordsVsActions ||
    !marketContext ||
    !routeContext ||
    !unknowns ||
    !changeConditions ||
    !refreshedSections ||
    !coverage ||
    !evidence ||
    !ver ||
    !schema ||
    !(ver.prompt === null || ver.prompt === undefined || typeof ver.prompt === "string") ||
    !(ver.model === null || ver.model === undefined || typeof ver.model === "string")
  ) {
    return null;
  }
  return {
    dossierId,
    revision,
    token,
    label: labelOf(v.label),
    builtAt,
    inputsHash,
    strongestSupport,
    strongestOpposition,
    claims,
    flow,
    wordsVsActions,
    marketContext,
    routeContext,
    unknowns,
    changeConditions,
    coverage,
    versions: { schema, prompt: exact(ver.prompt, 64), model: exact(ver.model, 64) },
    evidence,
    refreshedSections,
  };
}

// ── lens ────────────────────────────────────────────────────────────────────

function lensOf(v: unknown): string | null {
  // Longer than the lens ceiling means it was not written by lens.ts; cutting
  // it would cut citations out of the middle, so it is not shown at all.
  if (typeof v !== "string" || v.length > CHILD_FOMO_LIMITS.lensChars) return null;
  return sanitizeText(v, CHILD_FOMO_LIMITS.lensChars) || null;
}

/**
 * The refs Brain may cite: short opaque tokens that actually appear in the
 * rendered lens. A ref the lens does not contain could never be a legitimate
 * citation, so it is not offered as one.
 */
function lensRefsOf(v: unknown, lens: string | null): string[] {
  if (!lens || !Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (out.length >= CHILD_FOMO_LIMITS.lensRefs) break;
    if (typeof x !== "string" || x.length > CHILD_FOMO_LIMITS.lensRefChars || !LENS_REF.test(x)) continue;
    if (lens.includes(x) && !out.includes(x)) out.push(x);
  }
  return out;
}

// ── signals and the file ────────────────────────────────────────────────────

function signalOf(v: unknown): ChildSignal | null {
  if (!isRecord(v)) return null;
  const token = tokenOf(v.token);
  const firstSeenAt = time(v.firstSeenAt);
  if (!token || firstSeenAt === null || !isIn(PRIORITY_RANK, v.priority) || !Array.isArray(v.reasons) || !Array.isArray(v.triggers)) return null;
  const reasons: Reason[] = [];
  for (const r of v.reasons) if (isIn(REASONS, r) && !reasons.includes(r)) reasons.push(r);
  const lens = lensOf(v.lens);
  const triggers = triggersOf(v.triggers, token.key);
  // Only keys of this signal's own (kept) triggers, each once: a key naming
  // nothing here, or anything that is not a string, is dropped.
  const own = new Set(triggers.map((e) => e.eventKey));
  const tailTriggerKeys = Array.isArray(v.tailTriggerKeys)
    ? [...new Set(v.tailTriggerKeys.filter((k): k is string => typeof k === "string" && own.has(k)))].slice(0, CHILD_FOMO_LIMITS.triggers)
    : [];
  return {
    token,
    label: labelOf(v.label),
    priority: v.priority,
    reasons,
    triggers,
    ...(tailTriggerKeys.length > 0 ? { tailTriggerKeys } : {}),
    firstSeenAt,
    dossier: dossierOf(v.dossier, token.key),
    lens,
    lensRefs: lensRefsOf(v.lensRefs, lens),
  };
}

// ── tails ───────────────────────────────────────────────────────────────────

const TAIL_EVENT_KINDS: Record<ChildTailEvent["kind"], true> = { buy: true, sell: true, thesis: true };
/** A plain Fomo handle (tools.ts HANDLE): anything else is shown as no handle at all. */
const TAIL_HANDLE = /^[A-Za-z0-9_]{1,30}$/;

/**
 * One tailed trader's event, rebuilt from `unknown`. An identity that does not
 * re-parse drops the event (it would name the wrong coin in a notice); their
 * words are third-party text, sanitised and capped.
 */
function tailEventOf(v: unknown): ChildTailEvent | null {
  if (!isRecord(v) || !isIn(TAIL_EVENT_KINDS, v.kind)) return null;
  const eventKey = exact(v.eventKey, CHILD_FOMO_LIMITS.keyChars);
  const at = time(v.at);
  const observedAt = time(v.observedAt);
  if (!eventKey || at === null || observedAt === null) return null;
  const hasToken = v.token !== null && v.token !== undefined;
  const token = hasToken ? tokenOf(v.token) : null;
  if (hasToken && !token) return null;
  const pv = v.positionValueUsd;
  if (!(pv === null || pv === undefined || (typeof pv === "number" && Number.isFinite(pv) && pv >= 0))) return null;
  return {
    eventKey,
    kind: v.kind,
    token,
    label: labelOf(v.label),
    at,
    observedAt,
    positionValueUsd: typeof pv === "number" ? pv : null,
    text: clean(v.text, CHILD_FOMO_LIMITS.eventTextChars),
  };
}

function tailTotalsOf(v: unknown): ChildTail["totals"] {
  if (!isRecord(v) || typeof v.capped !== "boolean") return null;
  const buys = count(v.buys);
  const sells = count(v.sells);
  const theses = count(v.theses);
  const coins = count(v.coins);
  if (buys === null || sells === null || theses === null || coins === null) return null;
  return { buys, sells, theses, coins, capped: v.capped };
}

function tailOf(v: unknown): ChildTail | null {
  if (!isRecord(v)) return null;
  const userId = exact(v.userId, 128);
  const createdAt = time(v.createdAt);
  const expiresAt = time(v.expiresAt);
  if (!userId || createdAt === null || expiresAt === null || expiresAt <= createdAt) return null;
  if (typeof v.ended !== "boolean" || typeof v.consider !== "boolean" || !Array.isArray(v.events)) return null;
  const seen = new Set<string>();
  const events: ChildTailEvent[] = [];
  for (const x of v.events) {
    const e = tailEventOf(x);
    if (!e || seen.has(e.eventKey)) continue;
    seen.add(e.eventKey);
    events.push(e);
  }
  events.sort((a, b) => b.at - a.at || (a.eventKey < b.eventKey ? -1 : a.eventKey > b.eventKey ? 1 : 0));
  return {
    userId,
    handle: typeof v.handle === "string" && TAIL_HANDLE.test(v.handle) ? v.handle : null,
    createdAt,
    expiresAt,
    ended: v.ended,
    consider: v.consider,
    events: events.slice(0, CHILD_FOMO_LIMITS.tailEvents),
    totals: tailTotalsOf(v.totals),
  };
}

/**
 * The tails block, or undefined when the file has none (an older writer, or
 * an owner with no tail). A block that is not a list reads as no tails; a bad
 * entry is dropped, one trader appears once, and at most CHILD_FOMO_LIMITS.tails
 * active and as many ended are kept, active first.
 */
function tailsOf(v: unknown): ChildTail[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const active: ChildTail[] = [];
  const ended: ChildTail[] = [];
  for (const x of v) {
    const t = tailOf(x);
    if (!t || seen.has(t.userId)) continue;
    const list = t.ended ? ended : active;
    if (list.length >= CHILD_FOMO_LIMITS.tails) continue;
    seen.add(t.userId);
    list.push(t);
  }
  return [...active, ...ended];
}

/**
 * Data access is the master switch (store.ts setTenantRoute says the same):
 * monitoring or following without it is read as off, whatever the file says.
 * Anything that is not a boolean is not a permission.
 */
function accessOf(v: unknown): FomoAccess | null {
  if (!isRecord(v) || typeof v.dataAccess !== "boolean" || typeof v.monitoring !== "boolean" || typeof v.follow !== "boolean") return null;
  return { dataAccess: v.dataAccess, monitoring: v.dataAccess && v.monitoring, follow: v.dataAccess && v.follow };
}

function healthOf(v: unknown): ChildFomoFile["health"] | null {
  if (!isRecord(v) || !isIn(HEALTH_STATES, v.state)) return null;
  const cohortSize = nullableCount(v.cohortSize);
  const cohortVersion = nullableCount(v.cohortVersion);
  const cohortTarget = count(v.cohortTarget);
  const lastEventAt = nullableTime(v.lastEventAt);
  if (cohortSize === undefined || cohortVersion === undefined || cohortTarget === null || lastEventAt === undefined) return null;
  return {
    state: v.state,
    detail: typeof v.detail === "string" ? sanitizeText(v.detail, CHILD_FOMO_LIMITS.detailChars) : "",
    cohortSize,
    cohortVersion,
    cohortTarget,
    lastEventAt,
  };
}

/**
 * The file in today's shape, or null when its frame (version, tenant, time,
 * access, health, signal list) is not one. Signals are judged one by one:
 * a bad signal is dropped and counted, the rest survive. Signals come back
 * highest priority first, one per coin, at most 40. Tenant matching and
 * staleness are the reader's business, not this function's.
 */
export function normalizeChildFomoFile(v: unknown): { file: ChildFomoFile; droppedSignals: number } | null {
  if (!isRecord(v) || v.version !== 1) return null;
  const writtenAt = time(v.writtenAt);
  const rawTenant = exact(v.tenant, 256);
  const tenant = rawTenant ? tenantKey(rawTenant) : "";
  const access = accessOf(v.access);
  const health = healthOf(v.health);
  if (writtenAt === null || !tenant || !access || !health || !Array.isArray(v.signals)) return null;
  let dropped = 0;
  const valid: ChildSignal[] = [];
  for (const raw of v.signals) {
    const s = signalOf(raw);
    if (s) valid.push(s);
    else dropped++;
  }
  // Stable: within a priority class the writer's order is kept.
  valid.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  const seen = new Set<string>();
  const signals: ChildSignal[] = [];
  for (const s of valid) {
    if (seen.has(s.token.key) || signals.length >= CHILD_FOMO_LIMITS.signals) {
      dropped++;
      continue;
    }
    seen.add(s.token.key);
    signals.push(s);
  }
  // Tails exist only under data access (the writer's rule, kept by the reader too).
  const tails = access.dataAccess ? tailsOf(v.tails) : undefined;
  return { file: { version: 1, writtenAt, tenant, access, health, signals, ...(tails !== undefined ? { tails } : {}) }, droppedSignals: dropped };
}

const bytesOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), "utf8");

function sizeNote(dropped: number): string {
  return `${dropped} lower-priority ${dropped === 1 ? "signal was" : "signals were"} left out to keep this file under 2 MB.`;
}

/**
 * Keep the longest highest-priority prefix of signals that fits, and say in
 * the health detail how many were left out. Signals are already sorted, so
 * the tail is always the least important.
 */
function fitToLimit(file: ChildFomoFile): { file: ChildFomoFile; dropped: number } {
  const max = CHILD_FOMO_LIMITS.maxBytes;
  if (bytesOf(file) <= max) return { file, dropped: 0 };
  const total = file.signals.length;
  const build = (keep: number): ChildFomoFile => {
    const note = sizeNote(total - keep);
    const room = CHILD_FOMO_LIMITS.detailChars - note.length - 1;
    const detail = [room > 0 ? sanitizeText(file.health.detail, room) : "", note].filter(Boolean).join(" ");
    return { ...file, health: { ...file.health, detail }, signals: file.signals.slice(0, keep) };
  };
  // Estimate from per-signal sizes, then confirm with a real serialisation.
  let running = bytesOf(build(0));
  let keep = 0;
  for (const s of file.signals) {
    const add = bytesOf(s) + (keep > 0 ? 1 : 0);
    if (running + add > max) break;
    running += add;
    keep++;
  }
  let out = build(keep);
  while (keep > 0 && bytesOf(out) > max) out = build(--keep);
  return { file: out, dropped: total - keep };
}

/**
 * Write a child's Fomo file. Orchestrator only.
 *
 * The file is normalised with the reader's own rules first, so the writer can
 * never produce something the reader refuses; then it is fitted under 2 MB by
 * leaving out the lowest-priority signals. Temp-then-rename with mode 0600,
 * as research-files.ts does: a tick reading mid-write must never see half a
 * file. The temp name is unique per write, so two writers cannot interleave
 * into one temp file, and the rename replaces the entry itself (a planted
 * symlink at the final name is replaced, not followed).
 *
 * Throws on a file whose frame is invalid (a bug in the caller, loudly) and on
 * filesystem errors; the orchestrator's pass decides what to do about either.
 */
export function writeChildFomoFile(home: string, file: ChildFomoFile): ChildFomoWriteResult {
  const n = normalizeChildFomoFile(file);
  if (!n) throw new TypeError("fomo child file: refusing to write a file its reader would refuse");
  const fitted = fitToLimit(n.file);
  const json = JSON.stringify(fitted.file);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > CHILD_FOMO_LIMITS.maxBytes) throw new RangeError("fomo child file: over the size limit even without signals");
  mkdirSync(home, { recursive: true });
  const tmp = path.join(home, `.${CHILD_FOMO_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, json, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmp, childFomoFilePath(home));
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing to clean up.
    }
    throw error;
  }
  return { bytes, signals: fitted.file.signals.length, droppedInvalid: n.droppedSignals, droppedForSize: fitted.dropped };
}

const notFound = (e: unknown): boolean => isRecord(e) && (e.code === "ENOENT" || e.code === "ENOTDIR");

/**
 * Read a child's Fomo file. NEVER THROWS.
 *
 *   absent        no file: nothing has been routed to this tenant
 *   unreadable    present but not readable as a file
 *   invalid       not JSON, the wrong version, a future timestamp, a broken
 *                 frame, or over the size limit
 *   wrong-tenant  written for another tenant (compared case-insensitively)
 *   stale         older than maxAgeMs: shown as nothing, never as current
 *
 * `expectedTenant` must come from the child's own trusted configuration, never
 * from the file.
 */
export function readChildFomoFile(
  home: string,
  expectedTenant: string,
  now: number,
  maxAgeMs: number = CHILD_FOMO_LIMITS.defaultMaxAgeMs,
): ChildFomoRead {
  const out = (reason: ChildFomoReadReason, file: ChildFomoFile | null = null, droppedSignals = 0): ChildFomoRead => ({ file, reason, droppedSignals });
  try {
    const p = childFomoFilePath(home);
    try {
      const st = statSync(p);
      if (!st.isFile()) return out("unreadable");
      // Checked before reading, so an enormous file is never pulled into memory.
      if (st.size > CHILD_FOMO_LIMITS.maxBytes) return out("invalid");
    } catch (error) {
      return out(notFound(error) ? "absent" : "unreadable");
    }
    let text: string;
    try {
      text = readFileSync(p, "utf8");
    } catch (error) {
      return out(notFound(error) ? "absent" : "unreadable");
    }
    if (Buffer.byteLength(text, "utf8") > CHILD_FOMO_LIMITS.maxBytes) return out("invalid");
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      return out("invalid");
    }
    if (!isRecord(raw) || raw.version !== 1) return out("invalid");
    const got = exact(raw.tenant, 256) ? tenantKey(raw.tenant as string) : "";
    if (!got) return out("invalid");
    const want = typeof expectedTenant === "string" ? tenantKey(expectedTenant) : "";
    if (!want || got !== want) return out("wrong-tenant");
    const writtenAt = time(raw.writtenAt);
    if (writtenAt === null || typeof now !== "number" || !Number.isFinite(now)) return out("invalid");
    if (writtenAt > now + CHILD_FOMO_LIMITS.futureSkewMs) return out("invalid");
    const maxAge = typeof maxAgeMs === "number" && Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : CHILD_FOMO_LIMITS.defaultMaxAgeMs;
    if (now - writtenAt > maxAge) return out("stale");
    const n = normalizeChildFomoFile(raw);
    if (!n) return out("invalid");
    return out("ok", n.file, n.droppedSignals);
  } catch {
    return out("unreadable");
  }
}
