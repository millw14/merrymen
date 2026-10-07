/**
 * THE INTEGRATION CONTRACT — how the processes and surfaces reach Fomo research.
 *
 * Three process shapes ask the same questions:
 *
 *   orchestrator (hosted)   holds the key and the shared database. Runs the
 *                           FomoService for the whole fleet and answers its
 *                           children over IPC.
 *   web (hosted or local)   holds the key and the database (Postgres hosted,
 *                           fomo.sqlite self-hosted). Runs its own FomoService
 *                           for app chat and MCP.
 *   tenant child (hosted)   holds NEITHER. Its Telegram surfaces reach the
 *                           orchestrator's service through an IPC FomoBroker;
 *                           the orchestrator stamps the tenant from WHICH CHILD
 *                           asked, so the child never chooses whose permissions,
 *                           budget or memory apply.
 *   self-hosted worker      holds both, and wraps its own service in a direct
 *                           broker with the fixed tenant "self".
 *
 * Every surface calls `FomoBroker.call(tool, args, opts)`. Nothing in `opts`
 * names a tenant, a credential, a host, a path or a URL; the model-facing
 * `args` are validated by the service against each tool's own schema.
 */

import type {
  CoinDossier,
  FollowAssessment,
  FomoCallContext,
  FomoEnvelope,
  FomoHealthState,
  FomoSurface,
  FomoToolName,
  FunnelStage,
  RetrievalPriority,
  TokenIdentity,
  TokenLabel,
  TraderEvent,
} from "./types";

/** The tenant id a self-hosted install uses everywhere a tenant is required. */
export const SELF_HOSTED_TENANT = "self";

/** Per-tenant Fomo permissions, resolved from TRUSTED settings by the hosting process. */
export interface FomoAccess {
  dataAccess: boolean;
  monitoring: boolean;
  follow: boolean;
}

/** What a surface may say about the call. Never a tenant. */
export interface BrokerCallOptions {
  surface: FomoSurface;
  audience: "owner" | "group";
  conversationKey: string | null;
  priority: RetrievalPriority;
  /** Telegram group id for per-group budgets (group surface only). */
  groupId?: string | null;
  /** Upper bound for the whole call, including IPC. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Tenant-private facts a child reports for persistence in the shared store.
 * The receiving process stamps the tenant; a report can only ever be about the
 * reporter's own book.
 */
export type BrokerReport =
  | { kind: "assessment"; assessment: FollowAssessment }
  | { kind: "funnel"; tokenKey: string; stage: FunnelStage; detail: string; decisionId: string | null; atMs: number }
  | { kind: "position-dependency"; userId: string; tokenKey: string; reason: string; expiresAtMs: number }
  | { kind: "outcome"; assessmentId: string; horizonLabel: string; observedAtMs: number; price8: string | null; note: string | null }
  /** The coins this tenant holds now, so ingestion can prioritise position protection. */
  | { kind: "held-tokens"; tokenKeys: string[]; atMs: number };

/**
 * A STRICT memory read: what the store itself answered, or that it did not
 * answer. `ok` with `value: null` means the store was asked and holds nothing
 * under the key; every failure is `ok: false`, never a null.
 */
export type MemoryRead = { ok: true; value: string | null } | { ok: false; reason: string };

export interface FomoBroker {
  /** One registered tool call. Always resolves (a failure is an envelope with a failed status). */
  call(tool: FomoToolName, args: Record<string, unknown>, opts: BrokerCallOptions): Promise<FomoEnvelope>;
  /** Conversation subject memory (subject-memory.ts serialize() strings), tenant-scoped by the host. */
  memory: {
    /** LENIENT: null for "nothing stored" AND for any failure. Fine for chat memory; never for money state. */
    get(conversationKey: string): Promise<string | null>;
    /**
     * STRICT, for money state (fomo-child.ts brokerDurableState): `ok` with
     * `value: null` ONLY when the store answered that nothing is stored. No
     * channel, the child's in-flight cap, a refusal or rate limit, a timeout,
     * a store error or a malformed answer is `ok: false`. Never throws.
     * Optional so a chat-only wrapper may leave it out; a broker without it
     * can never prove that a key is absent.
     */
    read?(conversationKey: string): Promise<MemoryRead>;
    set(conversationKey: string, json: string): Promise<void>;
    clear(conversationKey: string): Promise<void>;
  };
  /** Persist a tenant-private fact. Best effort; never throws. */
  report(r: BrokerReport): Promise<void>;
  /** Whether a provider key is configured at all (a missing key answers "not configured", honestly). */
  configured(): boolean;
}

/**
 * The service a hosting process runs. `invoke` is the ONE dispatcher every
 * surface reaches: it checks the tenant's data-access permission and the
 * audience, validates `args` against the named tool's schema, applies
 * freshness, budget and single-flight rules, and returns an envelope.
 */
export interface FomoService {
  invoke(ctx: FomoCallContext, tool: FomoToolName, args: Record<string, unknown>): Promise<FomoEnvelope>;
  /** LENIENT: a store error is logged and answered as null (chat memory). */
  memoryGet(tenant: string, conversationKey: string): Promise<string | null>;
  /**
   * STRICT (FomoBroker.memory.read): a store error is `ok: false`, never a
   * null. Optional; a service without it cannot prove a key absent, so the
   * brokers answer `ok: false` for it.
   */
  memoryRead?(tenant: string, conversationKey: string): Promise<MemoryRead>;
  memorySet(tenant: string, conversationKey: string, json: string, nowMs: number): Promise<void>;
  memoryClear(tenant: string, conversationKey: string): Promise<void>;
  report(tenant: string, r: BrokerReport, nowMs: number): Promise<void>;
  configured(): boolean;
  /**
   * Background dossier refresh for shared research (orchestrator passes).
   * Public evidence only; no tenant. Respects the discovery/protection budget
   * class it is given.
   */
  refreshDossier(
    token: TokenIdentity,
    label: TokenLabel,
    opts: { priority: RetrievalPriority; depth: "quick" | "standard" | "deep"; now: number; signal?: AbortSignal },
  ): Promise<{ dossier: CoinDossier | null; changed: boolean; status: FomoEnvelope["status"]; reason: string | null }>;
  /** Health for owners and operators. */
  health(now: number): Promise<FomoServiceHealth>;
}

export interface FomoServiceHealth {
  state: FomoHealthState;
  configured: boolean;
  /** Plain sentence an owner can read. */
  detail: string;
  lastProviderOkAt: number | null;
  lastProviderFailure: { at: number; reason: string } | null;
  creditsRemaining: number | null;
  budgetLimited: boolean;
}

// ── The child's research file (orchestrator → hosted child) ─────────────

/**
 * `fomo.json` in a child's home: the monitoring and following inputs for ONE
 * tenant, written by the orchestrator (temp-then-rename, mode 0600) only for a
 * tenant whose data access is on, and read by the child each tick with a
 * never-throwing, re-validating reader. Absent means "nothing routed", never
 * "nothing happened".
 */
export interface ChildFomoFile {
  version: 1;
  writtenAt: number;
  /** Sanity only: the reader refuses a file written for another tenant. */
  tenant: string;
  access: FomoAccess;
  health: {
    state: FomoHealthState;
    detail: string;
    cohortSize: number | null;
    cohortVersion: number | null;
    cohortTarget: number;
    lastEventAt: number | null;
  };
  /** Bounded (≤ 40), highest priority first. */
  signals: ChildSignal[];
  /**
   * The owner's tails (store.ts fomo_tails): at most 3 active and 3 that
   * ended in the last 15 minutes, each with the tailed trader's recent buys,
   * sells and theses from the shared store, for the owner's DM notices
   * (tail-notices.ts). Written only while data access is on and tails are not
   * switched off (MERRYMEN_FOMO_TAILS=0). Absent in files from older writers
   * and for owners with no tail: read as none.
   */
  tails?: ChildTail[];
}

/** One tailed trader, as the child's notices read it. Display and notice data only: never an order, never a size. */
export interface ChildTail {
  userId: string;
  /** A plain Fomo handle, or null when unknown. */
  handle: string | null;
  createdAt: number;
  expiresAt: number;
  /** True for a tail that expired in the last 15 minutes (its end summary is due). */
  ended: boolean;
  /** The owner asked for the trader's buys to be one signal into the normal follow review. */
  consider: boolean;
  /** Buys, sells and theses since max(createdAt, now − 2 h), newest first, at most 20. */
  events: ChildTailEvent[];
  /**
   * The whole tail's tally from the shared store, for the end summary; null
   * while the tail runs. `capped` when the read hit its bound (a floor).
   */
  totals: { buys: number; sells: number; theses: number; coins: number; capped: boolean } | null;
}

export interface ChildTailEvent {
  eventKey: string;
  kind: "buy" | "sell" | "thesis";
  token: TokenIdentity | null;
  label: TokenLabel;
  /** The provider's event time when it gave one, else when Merrymen observed it. */
  at: number;
  observedAt: number;
  /** The trader's position mark after the event (never the buy's size); null when unknown. */
  positionValueUsd: number | null;
  /** Their words (a thesis or alert text): untrusted, sanitised, at most 500 characters. */
  text: string | null;
}

export interface ChildSignal {
  token: TokenIdentity;
  label: TokenLabel;
  priority: RetrievalPriority;
  reasons: ("held" | "watched" | "cohort" | "dependency" | "early-discovery" | "robinhood-thesis" | "tailed")[];
  /**
   * Cohort (and dependency) trader events for this token inside the breadth
   * window, newest first, ≤ 25; plus a tailed trader's, only for a tail the
   * owner asked to have considered (and never a cohort member marked not
   * followable).
   */
  triggers: TraderEvent[];
  /** When Merrymen first saw cohort activity on this token. */
  firstSeenAt: number;
  /** The latest shared dossier for the token, when one has been built. */
  dossier: CoinDossier | null;
  /** Rendered Brain lens text (lens.ts) and the refs it emits, so Brain citations can be validated. */
  lens: string | null;
  lensRefs: string[];
}

/** The IPC wire format (broker.ts). Exported so both ends validate the same shape. */
export type BrokerRequest =
  | { fomo: 1; id: string; op: "call"; tool: FomoToolName; args: Record<string, unknown>; opts: Omit<BrokerCallOptions, "signal"> }
  | { fomo: 1; id: string; op: "memory-get"; conversationKey: string }
  /** The strict read: answered `{ value: string | null }` only when the store answered; refused otherwise. */
  | { fomo: 1; id: string; op: "memory-read"; conversationKey: string }
  | { fomo: 1; id: string; op: "memory-set"; conversationKey: string; json: string }
  | { fomo: 1; id: string; op: "memory-clear"; conversationKey: string }
  | { fomo: 1; id: string; op: "report"; report: BrokerReport }
  | { fomo: 1; id: string; op: "configured" };

export type BrokerResponse =
  | { fomo: 1; id: string; ok: true; result: unknown }
  | { fomo: 1; id: string; ok: false; error: string };
