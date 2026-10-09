/**
 * PUBLICATION DRAFTS AND THE DURABLE OUTBOX for social-trading research —
 * docs/fomo.md "Publication", with docs/x-posting.md rules 2–4 restated for a
 * new family of posts. Nothing here imports the X posting modules: the X path
 * and the research path stay apart, so the few checks this needs are
 * re-stated below rather than borrowed.
 *
 * WHAT A POST MAY SAY IS DECIDED BY PERSISTED STATE, NOT BY A MODEL. The kind
 * of a post (publicationKindFor) is read off the research job, the assessment
 * or the trade row, and the body is filled from fixed templates. A pending
 * order is "sent and waiting to settle", never "bought". A paper fill is said
 * to be paper. A reverted or dropped trade is not a post at all, unless an
 * earlier post may already have claimed it; then the only thing left to say is
 * a correction. No model ever writes a word of a body, so a thesis, a comment,
 * a handle or a token name can reach a body only as quoted DATA in a slot,
 * and the gate reads every slot as if it were hostile.
 *
 * DROP, NEVER REPAIR. A draft that fails the gate is stored refused, with a
 * stable reason code for the operator. Cutting the offending words out would
 * publish the half of a sentence that was built around them. Not posting is a
 * normal outcome.
 *
 * DELIVERY IS OFF UNTIL SOMEBODY DECIDES OTHERWISE. X rule 3 says coin posts
 * are about coins the agent bought. The provider's terms forbid redistributing
 * its feed "as if it were an official or first-party feed". So every research
 * kind (researching, watching, considering-entry) plus submitted and
 * correction is refused as "policy-review-required" unless an injected policy
 * says otherwise. Confirmed buys already go out through the existing X posting
 * pipeline, so the default policy enables nothing at all; turning a kind on
 * here is a deliberate wiring change that needs Milla's review.
 *
 * AT MOST ONCE, EVEN ACROSS A CRASH, as on the X path. A draft is written under a
 * UNIQUE dedupe key before anything is sent, and claimed (queued → sending)
 * with a conditional transition before the sender is called. Anything that
 * might have reached the destination (a timeout, a thrown sender, an
 * unreadable success, a claim that outlived its process) is `uncertain`, and
 * an uncertain post is NEVER resent until a lookup has said the destination
 * holds nothing. That lookup gets one requeue. A post that cannot be found
 * either way stays uncertain forever, because a duplicate on someone's
 * personal timeline is worse than a gap.
 *
 * MANY AGENTS, ONE COIN. Without a fleet cap, every agent that researched the
 * same coin in the same hour would post the same templated sentence from a
 * different account. That is X's "substantially similar content across
 * multiple accounts". So drafts share a fleet key (kind, token, six-hour
 * bucket), and past `fleetCap` live posts the rest are suppressed. The count is
 * taken again AFTER each claim, which makes the cap hold under concurrent
 * senders. Under a race it can only err towards suppressing more.
 *
 * Money is never in a body: no digits, no spelled figures, no balances, sizes
 * or P&L. Nothing here sizes, signs, places or reads a wallet. Pure: the store,
 * the sender, the consent check, the lookup and the clock are all injected.
 */
import { sanitizeText } from "../research/news";
import { tokenFromKey } from "./identity";
import type { PublicationKind, PublicationState, ResearchState } from "./types";

// ── constants ────────────────────────────────────────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;

/** The fleet-dedupe window. Agents posting about one coin inside it share a fleet key. */
export const FLEET_WINDOW_MS = 6 * HOUR;
/** At most this many live posts per fleet key (kind, token, window) across all tenants. */
export const DEFAULT_FLEET_CAP = 2;
/** A repeat-limited post (watching, researching) at most once per token per tenant in this long. */
export const REPEAT_WINDOW_MS = 24 * HOUR;
/** Claims per post. After the last, a failure is final. */
export const MAX_SEND_ATTEMPTS = 3;
/** A queued draft waits at least this long, so an owner surface can show it before it goes. */
export const REVIEW_LEAD_MS = 10 * MIN;
/** A definite "nothing was created" refusal is retried after this, times the attempt number. */
export const RETRY_BACKOFF_MS = 5 * MIN;
/** A `sending` row older than this belonged to a pass that died mid-call: it becomes uncertain. */
export const SENDING_STALE_MS = 10 * MIN;
/**
 * THE SENDER'S CONTRACT: settle (resolve or reject) within this. A claim is
 * judged interrupted only after SENDING_STALE_MS, and looked up only
 * RECONCILE_AFTER_MS after that. So a sender that keeps its deadline can
 * never still be running when a lookup's "absent" requeues its post.
 */
export const SENDER_DEADLINE_MS = 2 * MIN;
/** An uncertain post is looked up no sooner than this after its last change (a destination's read lags its write). */
export const RECONCILE_AFTER_MS = 2 * MIN;
/** A queued draft older than this is stale news and is cancelled, not sent. */
export const MAX_QUEUE_AGE_MS = 6 * HOUR;
/** One casual line on X; Latin script only, so characters ≈ X's weighted length. */
export const BODY_MAX_CHARS = 280;
/** A claim longer than this is not a plain-words paraphrase and is not used (never truncated). */
export const CLAIM_MAX_CHARS = 90;
export const UNCERTAINTY_MAX_CHARS = 60;
export const COIN_NAME_MAX_CHARS = 40;
/** At most this many claims and uncertainty phrases per post. */
export const MAX_CLAIMS = 2;
export const MAX_UNCERTAINTIES = 2;
/** A body sharing this many words in a row with a source thesis is a copy, not a paraphrase. */
export const SOURCE_ECHO_WORDS = 6;
/** Rows looked at per phase of one outbox step. */
export const OUTBOX_STEP_LIMIT = 10;

// ── vocabulary ────────────────────────────────────────────────────────────────

/**
 * WHAT THE AGENT DISCLOSES ABOUT ITS OWN INTEREST. Every post says it, because
 * a reader deserves to know whether the account talking up a coin holds it.
 */
export type InterestDisclosure = "no-position" | "considering-position" | "holds-position" | "holds-paper-position";

export const INTEREST_TEXT: Readonly<Record<InterestDisclosure, string>> = Object.freeze({
  "no-position": "I hold no position in it.",
  "considering-position": "I hold none yet and am considering a position.",
  "holds-position": "I hold a position in it.",
  "holds-paper-position": "My only position in it is on paper.",
});

/**
 * WHICH INTERESTS ARE TRUE ALONGSIDE WHICH KIND. Bought and still holding,
 * exited and holding nothing: a post whose interest contradicts its own kind
 * is false whichever half is wrong. Unlisted kinds accept any interest.
 */
const INTEREST_FOR: Partial<Record<PublicationKind, ReadonlySet<InterestDisclosure>>> = {
  "confirmed-purchase": new Set(["holds-position"]),
  "confirmed-reduction": new Set(["holds-position"]),
  "confirmed-exit": new Set(["no-position"]),
  "paper-traded": new Set(["holds-paper-position", "no-position"]),
  submitted: new Set(["no-position", "considering-position", "holds-position"]),
  "considering-entry": new Set(["considering-position"]),
};

/** Kinds whose body states a "why", and refuse to go out without one. */
const EVIDENCE_REQUIRED: ReadonlySet<PublicationKind> = new Set(["watching", "considering-entry", "paper-traded", "confirmed-purchase"]);

/** Kinds tied to one decision rather than to a coin: their subject is the decision. */
const DECISION_KINDS: ReadonlySet<PublicationKind> = new Set([
  "submitted",
  "paper-traded",
  "confirmed-purchase",
  "confirmed-reduction",
  "confirmed-exit",
  "correction",
]);

/** Kinds that say a trade happened or is in flight; a later failure of that trade is owed a correction. */
const CLAIMS_A_TRADE: ReadonlySet<PublicationKind> = new Set([
  "submitted",
  "paper-traded",
  "confirmed-purchase",
  "confirmed-reduction",
  "confirmed-exit",
]);

/**
 * THE KINDS THAT WAIT ON A POLICY REVIEW (X rule 3; provider redistribution
 * terms). A policy that returns false for one of these refuses it with reason
 * "policy-review-required"; any other kind it refuses is "delivery-disabled".
 */
export const POLICY_REVIEW_KINDS: ReadonlySet<PublicationKind> = new Set([
  "researching",
  "watching",
  "considering-entry",
  "submitted",
  "correction",
]);

/** "Still monitoring" kinds: at most one per token per tenant per REPEAT_WINDOW_MS. */
export const REPEAT_LIMITED_KINDS: ReadonlySet<PublicationKind> = new Set(["watching", "researching"]);

/**
 * States in which a post is live or may already be public. These are what the
 * fleet cap and the repeat rule count. A queued post counts because it is
 * about to be public, and an uncertain one because it may already be.
 */
export const FLEET_COUNTED_STATES: ReadonlySet<PublicationState> = new Set(["queued", "sending", "sent", "uncertain", "reconciled-sent"]);

/** States in which a post may already be public: what a correction is owed for (see publicationKindFor's priorClaim). */
export const MAY_BE_PUBLIC_STATES: ReadonlySet<PublicationState> = new Set(["sending", "sent", "uncertain", "reconciled-sent"]);

/** What a row may be written as: the outcome of admitting a draft. "draft" itself is the in-memory state before that. */
export const INSERTABLE_STATES: ReadonlySet<PublicationState> = new Set(["blocked-policy", "blocked-consent", "suppressed-duplicate", "queued"]);

/**
 * THE STATE MACHINE. Every move is a conditional transition (from → to);
 * anything not listed is a bug. Notably absent: uncertain → sending. An
 * uncertain post goes back to queued only through a lookup that said
 * "absent", and only once.
 */
export const PUBLICATION_TRANSITIONS: Readonly<Record<PublicationState, readonly PublicationState[]>> = Object.freeze({
  draft: ["blocked-policy", "blocked-consent", "suppressed-duplicate", "queued"],
  queued: ["sending", "blocked-policy", "blocked-consent", "suppressed-duplicate", "cancelled", "failed"],
  sending: ["sent", "uncertain", "failed", "queued", "blocked-consent", "suppressed-duplicate"],
  uncertain: ["reconciled-sent", "reconciled-absent", "queued", "uncertain"],
  sent: [],
  "reconciled-sent": [],
  "reconciled-absent": [],
  "blocked-policy": [],
  "blocked-consent": [],
  "suppressed-duplicate": [],
  cancelled: [],
  failed: [],
});

export function canTransition(from: PublicationState, to: PublicationState): boolean {
  return (PUBLICATION_TRANSITIONS[from] ?? []).includes(to);
}

// ── types ────────────────────────────────────────────────────────────────────

export interface PublicationDestination {
  channel: "x";
  /** The connected account's immutable id, or null when none is connected (⇒ blocked-consent). */
  accountId: string | null;
}

/**
 * What the owner consented to. Trade posts (what the agent did) and research
 * posts (what it is looking at) are separate scopes. Consenting to one says
 * nothing about the other, just as X posting consent says nothing about replies.
 */
export type PublicationConsentScope = "x-trade-posts" | "x-research-posts";

export function consentScopeFor(kind: PublicationKind): PublicationConsentScope {
  return DECISION_KINDS.has(kind) ? "x-trade-posts" : "x-research-posts";
}

export interface DossierRef {
  dossierId: string;
  revision: number;
}

/**
 * WHAT A NEW REVISION OF A POST RESTS ON. contentRev moves only when one of
 * these moves (isMeaningfulRevision), which is what stops "still monitoring
 * X" from being re-posted every time a pass runs.
 */
export interface ContentBasis {
  dossierRevision: number | null;
  decisionStatus: string | null;
}

/** The plain-word inputs to a body. All of it is untrusted until the gate has read it. */
export interface PublicationFacts {
  /** Coin display name (a label, never identity). */
  coinName: string;
  /** Dossier claim summaries, Merrymen's paraphrases, in plain words with no figures. */
  claims: readonly string[];
  /** What remains unknown, as short phrases ("whether the volume is organic"). */
  uncertainty: readonly string[];
  interest: InterestDisclosure;
  /**
   * The third-party texts (theses, comments) the dossier was built from. Used
   * ONLY to refuse a body that copies one; never placed in a body.
   */
  sourceTexts?: readonly string[];
}

/** What the gate needs beside the draft. A stored draft supplies the first two itself at send time. */
export interface GateFacts {
  coinName: string;
  interest: InterestDisclosure;
  sourceTexts?: readonly string[];
}

export interface DraftInput {
  tenant: string;
  destination: PublicationDestination;
  kind: PublicationKind;
  /** TokenIdentity.key of the coin. Identity for keys, never shown. */
  tokenKey: string;
  facts: PublicationFacts;
  dossierRef: DossierRef | null;
  /** Required for decision kinds (submitted, paper-traded, confirmed-*, correction). */
  decisionId: string | null;
  decisionStatus?: string | null;
  consentScope: PublicationConsentScope;
  now: number;
  contentRev: number;
}

export interface PublicationDraft {
  tenant: string;
  destination: PublicationDestination;
  kind: PublicationKind;
  state: PublicationState;
  /** Stable operator code for a refusal or a terminal state; never shown to the public. */
  reason: string | null;
  body: string;
  coinName: string;
  interest: InterestDisclosure;
  /** How many claims made it into the body. */
  evidenceCount: number;
  tokenKey: string;
  /** decisionId for decision kinds, tokenKey otherwise. */
  subjectKey: string;
  /** UNIQUE across the table (and so across tenants). */
  dedupeKey: string;
  fleetKey: string;
  dossierRef: DossierRef | null;
  decisionId: string | null;
  consentScope: PublicationConsentScope;
  contentRev: number;
  basis: ContentBasis;
  createdAt: number;
  dueAt: number;
  updatedAt: number;
  /** Claims so far (each claim may call the sender once). */
  attempts: number;
  externalId: string | null;
  sentAt: number | null;
  /** True once a lookup said "absent" and the post was queued again: the one requeue it gets. */
  requeuedAfterAbsent: boolean;
  /** Lookups that answered "unknown". */
  reconcileChecks: number;
}

export interface Publication extends PublicationDraft {
  id: string;
}

/** Fields a transition may set. `at` becomes updatedAt. */
export interface TransitionFields {
  at: number;
  reason?: string | null;
  attempts?: number;
  externalId?: string | null;
  sentAt?: number | null;
  dueAt?: number;
  requeuedAfterAbsent?: boolean;
  reconcileChecks?: number;
}

/**
 * THE PERSISTENCE PORT. store.ts implements it over the shared Db, and
 * memoryPublicationStore below is the reference for its semantics.
 *
 *   insertDraft      INSERT … ON CONFLICT (dedupe_key) DO NOTHING; the id, or
 *                    null when the key was already used. Only INSERTABLE_STATES.
 *   transition       UPDATE … WHERE id = ? AND state = from; true for exactly
 *                    one caller. Must refuse moves canTransition rejects.
 *   recentFleetCount rows with this fleet key, created at or after sinceMs, in
 *                    FLEET_COUNTED_STATES, across ALL tenants.
 *   recentSubjectCount  the same for one (tenant, kind, subjectKey); tenant
 *                    compared trimmed and lowercased.
 *   get              one row, or null.
 *   dueQueued        queued rows with dueAt ≤ nowMs, oldest due first.
 *   inState          rows in `state` whose updatedAt < updatedBeforeMs, least
 *                    recently touched first (so "unknown" lookups rotate).
 */
export interface PublicationStore {
  insertDraft(draft: PublicationDraft): Promise<string | null>;
  transition(id: string, from: PublicationState, to: PublicationState, fields: TransitionFields): Promise<boolean>;
  recentFleetCount(fleetKey: string, sinceMs: number): Promise<number>;
  recentSubjectCount(tenant: string, kind: PublicationKind, subjectKey: string, sinceMs: number): Promise<number>;
  get(id: string): Promise<Publication | null>;
  dueQueued(nowMs: number, limit: number): Promise<Publication[]>;
  inState(state: "sending" | "uncertain", updatedBeforeMs: number, limit: number): Promise<Publication[]>;
}

/**
 * WHAT THE DESTINATION SAID. `retryable: true` is a promise from the sender
 * that the destination CERTAINLY created nothing (a 429, a refresh that never
 * reached the post call). Anything it cannot promise is `ambiguous`.
 */
export type SendResult = { ok: true; externalId: string } | { ambiguous: true } | { ok: false; retryable: boolean; reason?: string };

/** Sends one claimed post. Must settle within SENDER_DEADLINE_MS (see there) and never retry on its own. */
export type PublicationSender = (post: Publication) => Promise<SendResult>;

export type LookupAnswer = "present" | "absent" | "unknown";

/** Consent as it stands NOW, for this tenant, this destination account and this scope. */
export type ConsentCheck = (tenant: string, destination: PublicationDestination, scope: PublicationConsentScope) => boolean | Promise<boolean>;

export type DeliveryPolicy = (kind: PublicationKind, destination: PublicationDestination) => boolean;

/** The default: nothing is delivered. See the header for why. */
export const DEFAULT_DELIVERY_POLICY: DeliveryPolicy = () => false;

export interface AdmitDeps {
  consentNow: ConsentCheck;
  deliveryEnabled?: DeliveryPolicy;
  fleetCap?: number;
  reviewLeadMs?: number;
}

export interface OutboxDeps extends AdmitDeps {
  /** Does the destination hold this post? Called only for uncertain posts. */
  lookup: (post: Publication) => LookupAnswer | Promise<LookupAnswer>;
  /**
   * The kind persisted state supports NOW (publicationKindFor over the current
   * rows). A queued post whose claim is no longer true is cancelled, not sent:
   * "waiting to settle" ten minutes after it landed is false.
   */
  currentKind: (post: Publication) => PublicationKind | null | Promise<PublicationKind | null>;
  limit?: number;
}

// ── which kind, from persisted state ─────────────────────────────────────────

/**
 * The persisted record a post would be about. `priorClaim` is the kind of the
 * latest post about this decision in a MAY_BE_PUBLIC_STATES state, or null.
 * `remaining` is whether the agent still holds any after a sell; null when
 * unknown.
 */
export type PublicationSource =
  | { source: "research-job"; status: string | null }
  | { source: "assessment"; state: ResearchState | null }
  | {
      source: "trade";
      status: string | null;
      side: "buy" | "sell" | null;
      remaining: "some" | "none" | null;
      priorClaim: PublicationKind | null;
    };

/**
 * THE ONLY MAP FROM WHAT HAPPENED TO WHAT MAY BE SAID. Exact on purpose:
 *
 *   research job running            → researching
 *   assessment WATCH                → watching
 *   assessment PROBE/ENTRY_CANDIDATE → considering-entry
 *   trade submitted                 → submitted (never "bought")
 *   trade paper                     → paper-traded
 *   trade landed, buy               → confirmed-purchase
 *   trade landed, sell, some left   → confirmed-reduction
 *   trade landed, sell, none left   → confirmed-exit
 *   trade rejected/reverted/dropped → null, or correction when an earlier
 *                                     post may have claimed the trade
 *
 * A landed sell whose remainder is unknown is null. Calling a reduction an
 * exit, or the other way round, is a false statement, and silence is not.
 * Every other state (ADD/HOLD/REDUCE/EXIT candidates, a finished job…) is null.
 */
export function publicationKindFor(record: PublicationSource): PublicationKind | null {
  switch (record.source) {
    case "research-job":
      return record.status === "running" ? "researching" : null;
    case "assessment":
      if (record.state === "WATCH") return "watching";
      if (record.state === "PROBE_CANDIDATE" || record.state === "ENTRY_CANDIDATE") return "considering-entry";
      return null;
    case "trade": {
      const s = record.status;
      if (s === "submitted") return "submitted";
      if (s === "paper") return "paper-traded";
      if (s === "landed") {
        if (record.side === "buy") return "confirmed-purchase";
        if (record.side === "sell") {
          if (record.remaining === "some") return "confirmed-reduction";
          if (record.remaining === "none") return "confirmed-exit";
        }
        return null;
      }
      if (s === "rejected" || s === "reverted" || s === "dropped") {
        return record.priorClaim !== null && CLAIMS_A_TRADE.has(record.priorClaim) ? "correction" : null;
      }
      return null;
    }
    default:
      return null;
  }
}

// ── revisions ────────────────────────────────────────────────────────────────

/**
 * IS THIS WORTH A NEW REVISION? Only when the dossier moved FORWARD or the
 * decision's status changed. A pass that re-reads the same dossier says
 * nothing new. A dossier that went missing (null) or an older revision read
 * from a lagging replica is not news either.
 */
export function isMeaningfulRevision(prev: ContentBasis | null, next: ContentBasis): boolean {
  if (!prev) return true;
  const dossierAdvanced = next.dossierRevision !== null && (prev.dossierRevision === null || next.dossierRevision > prev.dossierRevision);
  const statusChanged = next.decisionStatus !== null && next.decisionStatus !== prev.decisionStatus;
  return dossierAdvanced || statusChanged;
}

/** The contentRev to draft under, or null when nothing meaningful changed (draft nothing). */
export function nextContentRev(prev: { contentRev: number; basis: ContentBasis } | null, next: ContentBasis): number | null {
  if (!prev) return 1;
  return isMeaningfulRevision(prev.basis, next) ? prev.contentRev + 1 : null;
}

// ── keys ─────────────────────────────────────────────────────────────────────

/** Owners are keyed trimmed and lowercased everywhere (the X posting tables do the same). */
export function tenantKeyOf(tenant: string): string {
  return String(tenant ?? "").trim().toLowerCase();
}

/**
 * A key segment with its separator escaped. Tenants and token keys can
 * contain ':' (did:…, eip155:4663:0x…), and a UNIQUE key must not be able to
 * collide by where a colon falls.
 */
function seg(s: string): string {
  return s.replace(/%/g, "%25").replace(/:/g, "%3A");
}

/** `fomo:<tenant>:<kind>:<subjectKey>:r<contentRev>`. Tenant-inclusive because the key is unique across the whole table. */
export function dedupeKeyFor(tenant: string, kind: PublicationKind, subjectKey: string, contentRev: number): string {
  return `fomo:${seg(tenantKeyOf(tenant))}:${kind}:${seg(subjectKey)}:r${contentRev}`;
}

export function fleetWindowStart(nowMs: number): number {
  return Math.floor(nowMs / FLEET_WINDOW_MS) * FLEET_WINDOW_MS;
}

/** `fomo-fleet:<kind>:<tokenKey>:<window start ms>`. No tenant: that is the point. */
export function fleetKeyFor(kind: PublicationKind, tokenKey: string, nowMs: number): string {
  return `fomo-fleet:${kind}:${seg(tokenKey)}:${fleetWindowStart(nowMs)}`;
}

// ── the draft ────────────────────────────────────────────────────────────────

const DECISION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TRAILING_PUNCT = /[\s.!?;:,]+$/u;

/** A plain-word phrase for a slot: flattened, trailing punctuation off, a leading capital lowered when it is not an acronym. */
function phrase(raw: unknown, max: number): string | null {
  const s = sanitizeText(raw, 400).replace(TRAILING_PUNCT, "").trim();
  if (s === "" || s.length > max) return null;
  return /^\p{Lu}\p{Ll}/u.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s;
}

function pickPhrases(list: readonly unknown[] | undefined, max: number, n: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(list) ? list : []) {
    const p = phrase(raw, max);
    if (p === null || seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase());
    out.push(p);
    if (out.length >= n) break;
  }
  return out;
}

function joinAnd(parts: readonly string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/**
 * THE TEMPLATES, and the only words a post has besides its slots. Each one
 * says what happened in exactly the terms its kind allows (gateDraft holds
 * them to it), then what is still unclear, then the agent's own interest.
 */
function bodyFor(kind: PublicationKind, coin: string, claims: readonly string[], uncertainty: readonly string[], interest: InterestDisclosure): string {
  const why = claims.length > 0 ? joinAnd(claims) : null;
  const unclear = uncertainty.length > 0 ? `Still unclear: ${joinAnd(uncertainty)}.` : "Much is still unclear.";
  const mine = INTEREST_TEXT[interest];
  const reason = why ? ` The reason: ${why}.` : "";
  switch (kind) {
    case "researching":
      return why ? `Researching ${coin}. Early notes: ${why}. ${unclear} ${mine}` : `Researching ${coin}, no view formed yet. ${unclear} ${mine}`;
    case "watching":
      return why ? `Watching ${coin} after a look at the evidence: ${why}. ${unclear} ${mine}` : `Watching ${coin}. ${unclear} ${mine}`;
    case "considering-entry":
      return `Weighing a position in ${coin}, nothing placed yet.${why ? ` The case so far: ${why}.` : ""} ${unclear} ${mine}`;
    case "submitted":
      return `Sent an order for ${coin} and it is waiting to settle, so nothing is final yet.${reason} ${unclear} ${mine}`;
    case "paper-traded":
      return `Made a paper trade in ${coin}, practice money only.${reason} ${unclear} ${mine}`;
    case "confirmed-purchase":
      return `Bought ${coin}, confirmed on chain.${reason} ${unclear} ${mine}`;
    case "confirmed-reduction":
      return `Trimmed my ${coin} position, confirmed on chain.${reason} ${unclear} ${mine}`;
    case "confirmed-exit":
      return `Exited ${coin}, confirmed on chain.${reason} ${unclear} ${mine}`;
    case "correction":
      return `Correction on ${coin}: an earlier post here described a trade that did not settle, so please disregard it. ${mine}`;
  }
}

/**
 * A DRAFT, NOT YET ADMITTED: state "draft", body from the templates, keys
 * computed. Throws only on a caller's contract violation (an empty tenant, a
 * decision kind without a decision id, a bad revision); everything that came
 * from outside is judged by gateDraft instead, and refused there.
 */
export function draftPublication(input: DraftInput): PublicationDraft {
  const tenant = tenantKeyOf(input.tenant);
  if (tenant === "" || /\s/.test(tenant)) throw new TypeError("publication needs a tenant");
  if (!Number.isSafeInteger(input.contentRev) || input.contentRev < 0) throw new RangeError("contentRev must be a non-negative integer");
  if (!Number.isSafeInteger(input.now) || input.now < 0) throw new RangeError("now must be epoch ms");
  const tokenKey = String(input.tokenKey ?? "").trim();
  if (tokenKey === "") throw new TypeError("publication needs a token key");
  const decisionId = input.decisionId === null || input.decisionId === undefined ? null : String(input.decisionId);
  if (decisionId !== null && !DECISION_ID.test(decisionId)) throw new TypeError("malformed decision id");
  if (DECISION_KINDS.has(input.kind) && decisionId === null) throw new TypeError(`${input.kind} needs a decision id`);
  const dossierRef =
    input.dossierRef && typeof input.dossierRef.dossierId === "string" && Number.isSafeInteger(input.dossierRef.revision) && input.dossierRef.revision >= 0
      ? { dossierId: input.dossierRef.dossierId, revision: input.dossierRef.revision }
      : null;
  const accountId = typeof input.destination?.accountId === "string" && ACCOUNT_ID.test(input.destination.accountId) ? input.destination.accountId : null;

  const coinName = sanitizeText(input.facts.coinName, 64);
  const claims = pickPhrases(input.facts.claims, CLAIM_MAX_CHARS, MAX_CLAIMS);
  const uncertainty = pickPhrases(input.facts.uncertainty, UNCERTAINTY_MAX_CHARS, MAX_UNCERTAINTIES);
  const interest = input.facts.interest;
  const subjectKey = DECISION_KINDS.has(input.kind) ? decisionId! : tokenKey;

  return {
    tenant,
    destination: { channel: "x", accountId },
    kind: input.kind,
    state: "draft",
    reason: null,
    body: bodyFor(input.kind, coinName, claims, uncertainty, interest),
    coinName,
    interest,
    evidenceCount: claims.length,
    tokenKey,
    subjectKey,
    dedupeKey: dedupeKeyFor(tenant, input.kind, subjectKey, input.contentRev),
    fleetKey: fleetKeyFor(input.kind, tokenKey, input.now),
    dossierRef,
    decisionId,
    consentScope: input.consentScope,
    contentRev: input.contentRev,
    basis: { dossierRevision: dossierRef?.revision ?? null, decisionStatus: input.decisionStatus ?? null },
    createdAt: input.now,
    dueAt: input.now,
    updatedAt: input.now,
    attempts: 0,
    externalId: null,
    sentAt: null,
    requeuedAfterAbsent: false,
    reconcileChecks: 0,
  };
}

// ── the gate ─────────────────────────────────────────────────────────────────

/** A coin name a post may print: Latin letters, spaces, hyphens, apostrophes. Anything else is an id, a link or a payload. */
const COIN_NAME = new RegExp(`^\\p{Script=Latin}[\\p{Script=Latin}\\p{M} '’-]{0,${COIN_NAME_MAX_CHARS - 1}}$`, "u");
/** A letter from outside the Latin script: the homoglyph route to a handle or a link that the patterns below would not see. */
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;
const MARKUP = /["“”«»„<>{}[\]`*|\\~^=]/;
const EMOJI = /\p{Extended_Pictographic}/u;
/** Any numeral, in any script: the X gate refuses every one, and a figure is how private numbers leak. */
const DIGITS = /\p{N}/u;
const HANDLE = /[@＠﹫]/;
const HASHTAG = /[#＃﹟]/;
/** A $cashtag or any currency sign. */
const CURRENCY = /\p{Sc}/u;
const LINK =
  /https?|:\/\/|\bwww\b|\b[\p{L}\p{N}-]+\s?\.\s?(?:com|net|org|io|xyz|gg|ly|fun|app|me|co|ai|so|to|tv|dev|finance|exchange|family|eth|sol|link|site|club|info|pro|vip|top|lol|meme|money|cash|news|bot)\b|\b[\p{L}\p{N}-]+\.\p{L}{2,}\b|\bdot\s+(?:com|io|xyz|net|org|eth)\b/iu;
/** An address-shaped run (hex, base58) or any word too long to be one. */
const ADDRESS = /\b0x[0-9a-f]+|[\p{L}\p{N}]{25,}/iu;
/** The provider and its subject platform are never named: a post must not read as their feed or as their partner. */
const PROVIDER = /\bfomo(?:api)?\b|fomoapi|fomo\s*\.?\s*family|fomoscan/i;
const PARTNERSHIP =
  /\b(?:official(?:ly)?|partner(?:s|ed|ing|ship|ships)?|in partnership with|endors(?:e|ed|es|ing|ement|ements)|sponsor(?:s|ed|ing|ship)?|affiliat(?:e|ed|es|ion)|in collaboration with|collab(?:oration)?|powered by|backed by|approved by|verified by)\b/i;
const HYPE = new RegExp(
  "\\b(?:" +
    [
      "buy now",
      "sell now",
      "buy the dip",
      "don'?t miss",
      "do not miss",
      "miss out",
      "last chance",
      "moon(?:s|ing|ed|shots?)?",
      "to the moon",
      "lfg",
      "wagmi",
      "ngmi",
      "ap(?:e|ed|ing)(?: in)?",
      "gems?",
      "alpha",
      "pump(?:s|ed|ing)?",
      "send(?:ing)? it",
      "load(?:ing)? up",
      "guarantee(?:d|s)?",
      "financial advice",
      "investment advice",
      "not advice",
      "nfa",
      "dyor",
      "you should",
      "you must",
      "you need to",
      "get in (?:now|early|before)",
      "easy money",
      "free money",
      "can'?t lose",
      "cannot lose",
      "sure thing",
      "bullish",
      "bearish",
      "undervalued",
      "next big thing",
      "skyrocket\\w*",
      "parabolic",
      "lambos?",
      "get rich",
      "rich quick",
      "(?:ten|hundred|thousand)[\\s-]*(?:x|fold|baggers?)",
      "\\w*baggers?",
    ].join("|") +
    ")\\b",
  "i",
);
/** The agent's private book: what it has, how much it put in, how it is doing. The writer is never given these; a body with one was handed it. */
const PRIVATE =
  /\b(?:balances?|portfolio|net worth|equity|wallets?|funds|deposits?|deposited|withdraw(?:al|als|n|ing)?|position siz(?:e|es|ing)|trade siz(?:e|es)|siz(?:ed|ing)|my (?:size|stake|bag|bags|stack|holdings?)|pnl|p\s*&\s*l|profits?|loss(?:es)?|gains|roi|return on|dollars?|usd[a-z]?|bucks|cash|grand|worth (?:of|about|around|roughly))\b/i;
/** A figure spelled out is still a figure. "one" is left out: "no one" and "one of" are ordinary. */
const FIGURES =
  /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|billions?|trillions?|percent|per cent|dozens?|half|quarter|double|triple|tenfold)\b/i;
/** Text addressed to a model, carried in a claim or a name. There is no model here, but it must not reach a timeline either. */
const INJECTION =
  /\b(?:(?:ignore|disregard|forget)\s+(?:(?:all|any|the|your|previous|prior|above|earlier)\s+)+(?:instructions?|rules?|prompts?|messages?|context)|system prompt|developer message|as an ai|jailbreak|you are now|new instructions?)\b/i;
const CAPS = /(?<![\p{L}\p{N}_])[A-Z]{3,}(?![\p{L}\p{N}_])/gu;
const ACRONYMS: ReadonlySet<string> = new Set(["NFT", "NFTS", "DEX", "DAO", "AMM", "ETF"]);

/**
 * STATUS WORDS. A reader takes these as a fill, so each is allowed only with
 * the kind that is one. A claim about other traders uses the nouns ("buyers",
 * "sellers"), never the verbs, so it can never be read as the agent's own.
 */
const BOUGHT =
  /\b(?:bought|purchas(?:e|ed|es|ing)|picked up|picking up|enter(?:ed|ing)|got in|getting in|went in|added to (?:my|a|the) position|(?:opened|took|taken|opening) (?:a|my) position|(?:i'?m|i am|we'?re|we are) buying|i buy)\b/i;
const SOLD =
  /\b(?:sold|exit(?:ed|ing)|trimm(?:ed|ing)|reduc(?:ed|ing) (?:my|the|our|a) (?:position|stake|holding)|cashed out|closed (?:out|(?:my|the|our|a) position)|t(?:ook|aking) profits?|(?:i'?m|i am|we'?re|we are) selling|i sell)\b/i;
const FILLED = /\b(?:filled|landed|settled|executed|went through|confirmed (?:on[\s-]chain|fill|trade|purchase|sale))\b/i;
const PAPER_SAID = /\bon paper\b|\bpaper[\s-]+(?:trad(?:e|es|ed|ing)|money|mode|positions?)\b|\bpractice money\b/i;
const REAL_MONEY = /\breal (?:money|cash)\b/i;
const UNCERTAINTY_SAID = /\b(?:unclear|unproven|unknown|uncertain|unconfirmed)\b/i;

const CONFIRMED_KINDS: ReadonlySet<PublicationKind> = new Set(["confirmed-purchase", "confirmed-reduction", "confirmed-exit"]);
const LIVE_MONEY_KINDS: ReadonlySet<PublicationKind> = new Set(["submitted", "confirmed-purchase", "confirmed-reduction", "confirmed-exit"]);

export type GateReason =
  | "empty"
  | "too-long"
  | "token-unresolved"
  | "coin-name-unsafe"
  | "coin-unsaid"
  | "script"
  | "markup"
  | "emoji"
  | "digits"
  | "handle"
  | "hashtag"
  | "cashtag"
  | "link"
  | "address"
  | "provider-named"
  | "partnership"
  | "hype"
  | "private"
  | "figures"
  | "injection"
  | "caps"
  | "status-wording"
  | "paper-unsaid"
  | "mode-false"
  | "submitted-unsaid"
  | "correction-unsaid"
  | "interest-mismatch"
  | "interest-unsaid"
  | "uncertainty-unsaid"
  | "no-evidence"
  | "copies-source";

export type GateVerdict = { ok: true } | { ok: false; reason: GateReason };

const refuse = (reason: GateReason): GateVerdict => ({ ok: false, reason });

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordsOf(s: string): string[] {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter((w) => w !== "");
}

/** Does `body` say SOURCE_ECHO_WORDS of `source`'s words in a row, in its order? */
function copiesSource(body: string, source: string): boolean {
  const n = SOURCE_ECHO_WORDS;
  const b = wordsOf(body);
  if (b.length < n) return false;
  const grams = new Set<string>();
  for (let i = 0; i + n <= b.length; i++) grams.add(b.slice(i, i + n).join(" "));
  const s = wordsOf(sanitizeText(source, 4000));
  for (let i = 0; i + n <= s.length; i++) if (grams.has(s.slice(i, i + n).join(" "))) return true;
  return false;
}

/**
 * MAY THIS BODY BE PUBLISHED AS THIS KIND? Judges the whole stored body,
 * slots included, so a coin name or a claim carrying a handle, a link, a
 * figure or an instruction refuses the post. Wording must match status:
 * bought/entered only for a confirmed purchase, sold/exited/trimmed only for a
 * confirmed reduction or exit, "paper" said for paper and real money never
 * claimed by it, "sent… waiting to settle" for a submitted order. The
 * vocabulary lists are a backstop for the templates, not a promise that no
 * sentence could ever mislead. Pure.
 */
export function gateDraft(draft: Pick<PublicationDraft, "kind" | "body" | "tokenKey" | "evidenceCount">, facts: GateFacts): GateVerdict {
  const body = typeof draft.body === "string" ? draft.body : "";
  const kind = draft.kind;
  if (body.trim() === "") return refuse("empty");
  if (body.length > BODY_MAX_CHARS) return refuse("too-long");
  if (tokenFromKey(String(draft.tokenKey ?? "")) === null) return refuse("token-unresolved");

  const coin = sanitizeText(facts.coinName, 64);
  if (!COIN_NAME.test(coin)) return refuse("coin-name-unsafe");
  if (!new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(coin)}(?![\\p{L}\\p{N}_])`, "u").test(body)) return refuse("coin-unsaid");

  if (NON_LATIN_LETTER.test(body)) return refuse("script");
  if (MARKUP.test(body)) return refuse("markup");
  if (EMOJI.test(body)) return refuse("emoji");
  if (DIGITS.test(body)) return refuse("digits");
  if (HANDLE.test(body)) return refuse("handle");
  if (HASHTAG.test(body)) return refuse("hashtag");
  if (CURRENCY.test(body)) return refuse("cashtag");
  if (LINK.test(body)) return refuse("link");
  if (ADDRESS.test(body)) return refuse("address");
  if (PROVIDER.test(body)) return refuse("provider-named");
  if (PARTNERSHIP.test(body)) return refuse("partnership");
  if (HYPE.test(body)) return refuse("hype");
  if (PRIVATE.test(body)) return refuse("private");
  if (FIGURES.test(body)) return refuse("figures");
  if (INJECTION.test(body)) return refuse("injection");
  const own = body.split(coin).join(" ");
  if ([...own.matchAll(CAPS)].some((m) => !ACRONYMS.has(m[0]))) return refuse("caps");

  if (BOUGHT.test(body) && kind !== "confirmed-purchase") return refuse("status-wording");
  if (SOLD.test(body) && kind !== "confirmed-reduction" && kind !== "confirmed-exit") return refuse("status-wording");
  if (FILLED.test(body) && !CONFIRMED_KINDS.has(kind)) return refuse("status-wording");
  if (kind === "paper-traded") {
    if (!PAPER_SAID.test(body)) return refuse("paper-unsaid");
    if (REAL_MONEY.test(body)) return refuse("mode-false");
  }
  if (LIVE_MONEY_KINDS.has(kind) && (PAPER_SAID.test(body) || /\bpaper\b/i.test(body))) return refuse("mode-false");
  if (kind === "submitted" && !(/\bsent\b/i.test(body) && /\bwaiting to settle\b/i.test(body))) return refuse("submitted-unsaid");
  if (kind === "correction" && !/\bcorrection\b/i.test(body)) return refuse("correction-unsaid");

  const allowed = INTEREST_FOR[kind];
  if (!(facts.interest in INTEREST_TEXT) || (allowed && !allowed.has(facts.interest))) return refuse("interest-mismatch");
  if (!body.includes(INTEREST_TEXT[facts.interest])) return refuse("interest-unsaid");
  if (kind !== "correction" && !UNCERTAINTY_SAID.test(body)) return refuse("uncertainty-unsaid");
  if (EVIDENCE_REQUIRED.has(kind) && !(draft.evidenceCount > 0)) return refuse("no-evidence");

  for (const src of facts.sourceTexts ?? []) if (typeof src === "string" && copiesSource(body, src)) return refuse("copies-source");
  return { ok: true };
}

// ── admission ────────────────────────────────────────────────────────────────

export interface AdmitResult {
  /** The stored row's id, or null when the dedupe key was already used (nothing written). */
  id: string | null;
  state: PublicationState;
  reason: string | null;
  duplicate: boolean;
}

function capOf(deps: Pick<AdmitDeps, "fleetCap">): number {
  const c = deps.fleetCap;
  return typeof c === "number" && Number.isSafeInteger(c) && c >= 1 ? c : DEFAULT_FLEET_CAP;
}

function policyReason(kind: PublicationKind): string {
  return POLICY_REVIEW_KINDS.has(kind) ? "policy-review-required" : "delivery-disabled";
}

function deliveryOn(deps: Pick<AdmitDeps, "deliveryEnabled">, kind: PublicationKind, destination: PublicationDestination): boolean {
  try {
    return (deps.deliveryEnabled ?? DEFAULT_DELIVERY_POLICY)(kind, destination) === true;
  } catch {
    return false;
  }
}

/**
 * ADMIT A DRAFT: decide its first persisted state, then write it under its
 * dedupe key. Refusals are written too, so the same key is never drafted
 * again. Order: policy, gate, consent, repetition, fleet cap. Policy comes
 * first so that a kind awaiting review is recorded as exactly that. A consent
 * check that throws is rethrown and nothing is written, so a transient error
 * does not use up the key.
 */
export async function admitDraft(
  store: PublicationStore,
  draft: PublicationDraft,
  facts: GateFacts,
  deps: AdmitDeps,
  now: number,
): Promise<AdmitResult> {
  if (draft.state !== "draft") throw new Error(`only a draft can be admitted, not ${draft.state}`);
  const decided = await admission(store, draft, facts, deps, now);
  const lead = typeof deps.reviewLeadMs === "number" && Number.isFinite(deps.reviewLeadMs) && deps.reviewLeadMs >= 0 ? deps.reviewLeadMs : REVIEW_LEAD_MS;
  const row: PublicationDraft = {
    ...draft,
    state: decided.state,
    reason: decided.reason,
    dueAt: decided.state === "queued" ? now + lead : draft.dueAt,
    updatedAt: now,
  };
  const id = await store.insertDraft(row);
  if (id === null) return { id: null, state: row.state, reason: "duplicate", duplicate: true };
  return { id, state: row.state, reason: row.reason, duplicate: false };
}

async function admission(
  store: PublicationStore,
  draft: PublicationDraft,
  facts: GateFacts,
  deps: AdmitDeps,
  now: number,
): Promise<{ state: PublicationState; reason: string | null }> {
  if (!deliveryOn(deps, draft.kind, draft.destination)) return { state: "blocked-policy", reason: policyReason(draft.kind) };
  const verdict = gateDraft(draft, facts);
  if (!verdict.ok) return { state: "blocked-policy", reason: verdict.reason };
  if (draft.destination.accountId === null) return { state: "blocked-consent", reason: "no-account" };
  if (draft.consentScope !== consentScopeFor(draft.kind)) return { state: "blocked-consent", reason: "scope-mismatch" };
  if ((await deps.consentNow(draft.tenant, draft.destination, draft.consentScope)) !== true) return { state: "blocked-consent", reason: "no-consent" };
  if (REPEAT_LIMITED_KINDS.has(draft.kind) && (await store.recentSubjectCount(draft.tenant, draft.kind, draft.subjectKey, now - REPEAT_WINDOW_MS)) >= 1) {
    return { state: "suppressed-duplicate", reason: `repeat-${draft.kind}` };
  }
  // A correction is owed by the account that made the claim, whatever the fleet said.
  if (draft.kind !== "correction" && (await store.recentFleetCount(draft.fleetKey, fleetWindowStart(draft.createdAt))) >= capOf(deps)) {
    return { state: "suppressed-duplicate", reason: "fleet-cap" };
  }
  return { state: "queued", reason: null };
}

// ── the outbox ───────────────────────────────────────────────────────────────

export type OutboxOutcome =
  | "sent"
  | "uncertain"
  | "failed"
  | "requeued"
  | "lost"
  | "skipped"
  | "blocked-policy"
  | "blocked-consent"
  | "suppressed-duplicate"
  | "cancelled"
  | "interrupted"
  | "reconciled-sent"
  | "reconciled-absent"
  | "reconcile-requeued"
  | "reconcile-unknown";

export interface OutboxReport {
  outcomes: { id: string; outcome: OutboxOutcome; reason: string | null }[];
  /** How many times the sender was called in this step. */
  senderCalls: number;
}

const EXTERNAL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const REASON_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

type Classified =
  | { kind: "ok"; externalId: string }
  | { kind: "ambiguous"; reason: string }
  | { kind: "retry" }
  | { kind: "refused"; reason: string };

/** The sender's answer, read as untrusted. Anything that is not a clear refusal or a readable success might have posted. */
function classify(raw: unknown): Classified {
  if (!raw || typeof raw !== "object") return { kind: "ambiguous", reason: "unreadable-result" };
  const r = raw as Record<string, unknown>;
  if (r.ok === true) {
    return typeof r.externalId === "string" && EXTERNAL_ID.test(r.externalId)
      ? { kind: "ok", externalId: r.externalId }
      : { kind: "ambiguous", reason: "unreadable-ok" };
  }
  if (r.ambiguous === true) return { kind: "ambiguous", reason: "ambiguous" };
  if (r.ok === false && r.retryable === true) return { kind: "retry" };
  if (r.ok === false && r.retryable === false) {
    return { kind: "refused", reason: typeof r.reason === "string" && REASON_SLUG.test(r.reason) ? r.reason : "refused" };
  }
  return { kind: "ambiguous", reason: "unreadable-result" };
}

function normalizeLookup(raw: unknown): LookupAnswer {
  return raw === "present" || raw === "absent" ? raw : "unknown";
}

/**
 * ONE BOUNDED STEP OF THE OUTBOX. Three phases, each looking at no more than
 * `limit` rows:
 *
 *   1. A `sending` claim that outlived its process becomes uncertain
 *      ("interrupted"). Whether the destination took it is unknown.
 *   2. Uncertain posts are looked up. present → reconciled-sent; absent →
 *      queued again, once, then reconciled-absent; unknown → still
 *      uncertain, never resent.
 *   3. Due queued posts are sent: policy, gate, freshness, the current kind
 *      and consent are checked on the queued row; the row is claimed; the
 *      fleet cap, the repeat rule and consent are checked again now that the
 *      claim is visible; then the sender is called once.
 *
 * A store error propagates. Whatever it interrupted is left in a state the
 * next step handles (a stranded `sending` row becomes uncertain).
 */
export async function processOutbox(store: PublicationStore, sender: PublicationSender, deps: OutboxDeps, now: number): Promise<OutboxReport> {
  const limit = typeof deps.limit === "number" && Number.isSafeInteger(deps.limit) && deps.limit >= 1 ? Math.min(deps.limit, 100) : OUTBOX_STEP_LIMIT;
  const report: OutboxReport = { outcomes: [], senderCalls: 0 };
  const note = (id: string, outcome: OutboxOutcome, reason: string | null = null) => report.outcomes.push({ id, outcome, reason });

  for (const p of await store.inState("sending", now - SENDING_STALE_MS, limit)) {
    if (await store.transition(p.id, "sending", "uncertain", { at: now, reason: "interrupted" })) note(p.id, "interrupted", "interrupted");
  }

  for (const p of await store.inState("uncertain", now - RECONCILE_AFTER_MS, limit)) {
    let answer: LookupAnswer;
    try {
      answer = normalizeLookup(await deps.lookup(p));
    } catch {
      answer = "unknown";
    }
    if (answer === "present") {
      if (await store.transition(p.id, "uncertain", "reconciled-sent", { at: now, reason: "reconciled", sentAt: p.sentAt ?? now })) note(p.id, "reconciled-sent");
    } else if (answer === "absent") {
      // One requeue, and only while claims remain: an absent answer is the
      // destination's word, and a second "absent" after a second ambiguous
      // send is not a reason to try forever.
      if (!p.requeuedAfterAbsent && p.attempts < MAX_SEND_ATTEMPTS) {
        if (await store.transition(p.id, "uncertain", "queued", { at: now, reason: "absent-requeued", requeuedAfterAbsent: true, dueAt: now + RETRY_BACKOFF_MS })) {
          note(p.id, "reconcile-requeued", "absent-requeued");
        }
      } else if (await store.transition(p.id, "uncertain", "reconciled-absent", { at: now, reason: "absent" })) {
        note(p.id, "reconciled-absent", "absent");
      }
    } else if (await store.transition(p.id, "uncertain", "uncertain", { at: now, reconcileChecks: p.reconcileChecks + 1 })) {
      note(p.id, "reconcile-unknown");
    }
  }

  for (const p of await store.dueQueued(now, limit)) {
    await sendOne(store, sender, deps, now, p, note, () => report.senderCalls++);
  }
  return report;
}

async function sendOne(
  store: PublicationStore,
  sender: PublicationSender,
  deps: OutboxDeps,
  now: number,
  p: Publication,
  note: (id: string, outcome: OutboxOutcome, reason?: string | null) => void,
  called: () => void,
): Promise<void> {
  const settle = async (from: PublicationState, to: PublicationState, outcome: OutboxOutcome, fields: Omit<TransitionFields, "at">) => {
    if (await store.transition(p.id, from, to, { at: now, ...fields })) note(p.id, outcome, fields.reason ?? null);
    else note(p.id, "lost", null);
  };

  // ── checks on the queued row: nothing here has claimed it ──
  if (!deliveryOn(deps, p.kind, p.destination)) return settle("queued", "blocked-policy", "blocked-policy", { reason: policyReason(p.kind) });
  const verdict = gateDraft(p, { coinName: p.coinName, interest: p.interest });
  if (!verdict.ok) return settle("queued", "blocked-policy", "blocked-policy", { reason: verdict.reason });
  if (now - p.createdAt > MAX_QUEUE_AGE_MS) return settle("queued", "cancelled", "cancelled", { reason: "stale" });
  if (p.attempts >= MAX_SEND_ATTEMPTS) return settle("queued", "failed", "failed", { reason: "attempts-exhausted" });
  let current: PublicationKind | null;
  try {
    current = await deps.currentKind(p);
  } catch {
    return note(p.id, "skipped", "current-kind-error");
  }
  if (current !== p.kind) return settle("queued", "cancelled", "cancelled", { reason: "superseded" });
  if (p.destination.accountId === null || p.consentScope !== consentScopeFor(p.kind)) {
    return settle("queued", "blocked-consent", "blocked-consent", { reason: "consent-revoked" });
  }
  let consented: boolean;
  try {
    consented = (await deps.consentNow(p.tenant, p.destination, p.consentScope)) === true;
  } catch {
    return note(p.id, "skipped", "consent-check-error");
  }
  if (!consented) return settle("queued", "blocked-consent", "blocked-consent", { reason: "consent-revoked" });

  // ── the claim: exactly one caller gets past this line ──
  const attempts = p.attempts + 1;
  if (!(await store.transition(p.id, "queued", "sending", { at: now, attempts }))) return note(p.id, "lost", null);

  // ── checks that need the claim to be visible to every other sender ──
  if (p.kind !== "correction") {
    const since = fleetWindowStart(p.createdAt);
    const others = (await store.recentFleetCount(p.fleetKey, since)) - 1;
    if (others >= capOf(deps)) return settle("sending", "suppressed-duplicate", "suppressed-duplicate", { reason: "fleet-cap" });
  }
  if (REPEAT_LIMITED_KINDS.has(p.kind)) {
    const since = now - REPEAT_WINDOW_MS;
    const others = (await store.recentSubjectCount(p.tenant, p.kind, p.subjectKey, since)) - (p.createdAt >= since ? 1 : 0);
    if (others >= 1) return settle("sending", "suppressed-duplicate", "suppressed-duplicate", { reason: `repeat-${p.kind}` });
  }
  // Consent again, AFTER the claim: an owner who switched off between the
  // first check and the claim is honoured, not raced.
  try {
    consented = (await deps.consentNow(p.tenant, p.destination, p.consentScope)) === true;
  } catch {
    return settle("sending", "queued", "requeued", { reason: "consent-check-error", dueAt: now + RETRY_BACKOFF_MS });
  }
  if (!consented) return settle("sending", "blocked-consent", "blocked-consent", { reason: "consent-revoked" });

  const row = (await store.get(p.id)) ?? { ...p, state: "sending" as const, attempts };
  if (row.state !== "sending") return note(p.id, "lost", null);

  // ── the one call ──
  called();
  let result: Classified;
  try {
    result = classify(await sender(row));
  } catch {
    // A sender that threw may have thrown after the destination took the post.
    result = { kind: "ambiguous", reason: "sender-threw" };
  }

  switch (result.kind) {
    case "ok": {
      if (await store.transition(p.id, "sending", "sent", { at: now, externalId: result.externalId, sentAt: now, reason: null })) return note(p.id, "sent");
      // The claim was judged interrupted while the call ran; the post is in
      // fact out, so the uncertain row is reconciled with what we now know.
      if (await store.transition(p.id, "uncertain", "reconciled-sent", { at: now, externalId: result.externalId, sentAt: now, reason: "late-ok" })) {
        return note(p.id, "reconciled-sent", "late-ok");
      }
      return note(p.id, "lost", null);
    }
    case "ambiguous":
      return settle("sending", "uncertain", "uncertain", { reason: result.reason });
    case "retry":
      if (attempts >= MAX_SEND_ATTEMPTS) return settle("sending", "failed", "failed", { reason: "attempts-exhausted" });
      return settle("sending", "queued", "requeued", { reason: "retry", dueAt: now + RETRY_BACKOFF_MS * attempts });
    case "refused":
      return settle("sending", "failed", "failed", { reason: result.reason });
  }
}

// ── reference store ──────────────────────────────────────────────────────────

function copyOf(p: Publication): Publication {
  return {
    ...p,
    destination: { ...p.destination },
    dossierRef: p.dossierRef ? { ...p.dossierRef } : null,
    basis: { ...p.basis },
  };
}

/**
 * AN IN-MEMORY PublicationStore: the reference semantics for store.ts, and
 * the fixture for tests. Conditional transitions, a unique dedupe key, and a
 * hard error on a move the state machine does not allow.
 */
export function memoryPublicationStore(): PublicationStore & { all(): Publication[] } {
  const rows = new Map<string, Publication>();
  const keys = new Set<string>();
  let seq = 0;
  const counted = (p: Publication, since: number) => FLEET_COUNTED_STATES.has(p.state) && p.createdAt >= since;
  return {
    async insertDraft(d) {
      if (!INSERTABLE_STATES.has(d.state)) throw new Error(`cannot insert a row as ${d.state}`);
      if (keys.has(d.dedupeKey)) return null;
      keys.add(d.dedupeKey);
      const id = String(++seq);
      rows.set(id, copyOf({ ...d, id }));
      return id;
    },
    async transition(id, from, to, f) {
      if (!canTransition(from, to)) throw new Error(`illegal transition ${from} → ${to}`);
      const r = rows.get(id);
      if (!r || r.state !== from) return false;
      const next: Publication = { ...r, state: to, updatedAt: f.at };
      if (f.reason !== undefined) next.reason = f.reason;
      if (f.attempts !== undefined) next.attempts = f.attempts;
      if (f.externalId !== undefined) next.externalId = f.externalId;
      if (f.sentAt !== undefined) next.sentAt = f.sentAt;
      if (f.dueAt !== undefined) next.dueAt = f.dueAt;
      if (f.requeuedAfterAbsent !== undefined) next.requeuedAfterAbsent = f.requeuedAfterAbsent;
      if (f.reconcileChecks !== undefined) next.reconcileChecks = f.reconcileChecks;
      rows.set(id, next);
      return true;
    },
    async recentFleetCount(fleetKey, sinceMs) {
      let n = 0;
      for (const p of rows.values()) if (p.fleetKey === fleetKey && counted(p, sinceMs)) n++;
      return n;
    },
    async recentSubjectCount(tenant, kind, subjectKey, sinceMs) {
      const t = tenantKeyOf(tenant);
      let n = 0;
      for (const p of rows.values()) if (p.tenant === t && p.kind === kind && p.subjectKey === subjectKey && counted(p, sinceMs)) n++;
      return n;
    },
    async get(id) {
      const r = rows.get(id);
      return r ? copyOf(r) : null;
    },
    async dueQueued(nowMs, limit) {
      return [...rows.values()]
        .filter((p) => p.state === "queued" && p.dueAt <= nowMs)
        .sort((a, b) => a.dueAt - b.dueAt || Number(a.id) - Number(b.id))
        .slice(0, limit)
        .map(copyOf);
    },
    async inState(state, updatedBeforeMs, limit) {
      return [...rows.values()]
        .filter((p) => p.state === state && p.updatedAt < updatedBeforeMs)
        .sort((a, b) => a.updatedAt - b.updatedAt || Number(a.id) - Number(b.id))
        .slice(0, limit)
        .map(copyOf);
    },
    all() {
      return [...rows.values()].map(copyOf);
    },
  };
}
