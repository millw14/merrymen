/**
 * THE FOMO CHILD TICK — what one tenant's worker does with the research the
 * orchestrator routed to it (docs/fomo.md "Decisions and execution").
 *
 * The child never holds a provider key and never chooses a tenant. It reads
 * `fomo.json` (written by the orchestrator for THIS tenant only), assesses the
 * signals in it with the deterministic selective-following machine
 * (fomo/following.ts), and turns the narrow set of authorised, feasible setups
 * into NOMINATIONS for the Trencher review that already exists:
 *
 *   ENTRY / PROBE          → a follow nomination (FollowBook) and an offer to
 *                            the early-candidate book (early-candidates.ts):
 *                            a tape page, an on-chain verification, a reserved
 *                            review slot and a per-coin CEILING for take().
 *   held + cohort change   → a SOONER review of the held coin through the
 *                            existing held-review rotation. Never a sell: the
 *                            Brain still decides, and the mechanical exits
 *                            (strategies/trencher.ts shouldExit) run first and
 *                            are untouched.
 *   everything else        → research only: assessed, reported, never acted on.
 *
 * WHAT THIS FILE CANNOT DO. It builds no intent, signs nothing and calls no
 * executor. An entry that a follow nomination reached still goes through the
 * Brain, take() (60 s, 2% band, the min of every bound), the strategy's own
 * sizing, the energy claim, checkPolicy, the vault caps and the paper/live
 * rail exactly as before. The only thing added at the entry is a GATE that can
 * drop a follow entry (revalidation, the exploration reservation and the
 * follow-entry day cap) — it can never add one, enlarge one or route one.
 *
 * TRUST. The tenant comes from the process (MERRYMEN_TENANT, set by the
 * orchestrator for the child it spawned; "self" self-hosted), never from the
 * file — the reader refuses a file written for anyone else. The file's access
 * flags can only NARROW the owner's own settings. Thesis, comment, handle and
 * token-name text are untrusted data: nothing here reads them to decide, and
 * the lens attached for Brain is re-checked for anything address-shaped.
 *
 * NEVER FATAL, OFF THE EXIT PATH. `tick` is synchronous and cheap (one bounded
 * file read every few seconds, at most 40 assessments); the ledger reads it
 * needs run in the background and are used by the NEXT tick. Every public
 * method swallows its own failures: research must never cost a trade, an exit
 * or a tick.
 */

import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { CASH, instrumentClassOf, isEnergyReserveToken } from "../../packages/core/src/index";
import { writeFileAtomicSync } from "./atomic-write";
import { tradeConsumesSnapshot } from "./brain-live";
import type { ShadowOutcome } from "./brain-shadow";
import { entryTokenOf, type Classified } from "./decision-funnel";
import type { EarlyOffer, EarlyOfferResult } from "./early-candidates";
import { createDirectBroker, createIpcBroker, type BrokerPort } from "./fomo/broker";
import { readChildFomoFile, type ChildFomoRead, type ChildFomoReadReason } from "./fomo/child-file";
import { SELF_HOSTED_TENANT, type ChildFomoFile, type ChildSignal, type FomoAccess, type FomoBroker } from "./fomo/contract";
import {
  FOLLOW_DEFAULTS,
  FollowBook,
  assessFollow,
  revalidate,
  toExecutionHint,
  type ExecutionHint,
  type FollowCounters,
  type FollowHeld,
  type FollowPermissions,
  type FollowQuote,
  type FollowRoute,
} from "./fomo/following";
import { executionAvailabilityOf, isRobinhoodToken, keyOf, robinhoodChain } from "./fomo/identity";
import { TRADER_FLOW_LENS } from "./fomo/lens";
import { dossierStrength, objectionStrengthened, reviewHeldPosition, thesisStrengthened, type DossierStrength, type HeldReview } from "./fomo/lifecycle";
import { openLocalFomoDb } from "./fomo/local-db";
import { createFomoRuntime } from "./fomo/runtime";
import { AUTONOMOUS_ENTRY_CAP_6, ExplorationReservations, entryCeiling, microUsdgFloor, type EntryCeiling, type ReservationSnapshot } from "./fomo/sizing";
import { ensureFomoSchema } from "./fomo/store";
import type { FollowAssessment, FomoHealthState, FunnelStage, TraderEvent } from "./fomo/types";
import type { Db } from "./db";

// ─── Constants (judgment calls, named so an owner can see them) ────────────

/** The early book's source label for follow nominations (early-candidates.ts SOURCE). */
export const FOLLOW_SOURCE = "fomo-follow";

export const FOMO_CHILD = Object.freeze({
  /** The orchestrator rewrites the file at most every 60 s; reading it more often than this buys nothing. */
  fileReadEveryMs: 10_000,
  /** held-tokens reports, at most this often (contract.ts BrokerReport). */
  heldTokensEveryMs: 5 * 60_000,
  /** A coin's funnel stage is reported again no sooner than this. */
  funnelMinGapMs: 60_000,
  funnelPerTick: 5,
  /** Coins asked of discovery for on-chain verification only (no review, no ceiling): see verifyRequests. */
  verifyMax: 3,
  /**
   * Our own quote counts as "the price at the triggering buy" only when it was
   * read within this long of the trader's event. Later than that it is our
   * price, not theirs, and the move since the signal is UNKNOWN (→ WATCH).
   */
  signalPriceMaxLagMs: 3 * 60_000,
  /** The smallest follow entry worth its gas: 1 USDG. Probes (≤ 2.5 USDG) can pass it; see following.ts open issue. */
  minEconomic6: 1_000_000n,
  /** Exploration may hold at most this share of equity (tighten-only; the scout budget is still the allowance). */
  explorationShareBps: 2_500,
  /** A follow position keeps its triggering traders' activity routed this long (contract.ts position-dependency). */
  dependencyTtlMs: 14 * 86_400_000,
  dependencyMaxTraders: 10,
  /** A held coin's sooner-review request is repeated no more often than this while its reasons stay the same. */
  heldReviewRepeatMs: 15 * 60_000,
  /** Brain's advertised lens keys are re-read at most this often (GET /health). */
  lensProbeEveryMs: 60 * 60_000,
  lensProbeTimeoutMs: 5_000,
  /** A sent lens is matched to the review that used it for this long. */
  lensSentTtlMs: 10 * 60_000,
  lensTraceMax: 50,
  /** A follow nomination's entries stay gated this long past its own expiry (EARLY.capMemoryMs). */
  trackedGraceMs: 15 * 60_000,
  /** A follow entry never observed held is forgotten (as no fill) after this. */
  unsettledGraceMs: 30 * 60_000,
  /** A position seen flat is closed only when it is still flat this much later. */
  flatConfirmMs: 60_000,
  reportedMax: 400,
});

// ─── The broker this child talks through ───────────────────────────────────

export type ChildBrokerKind = "ipc" | "unavailable" | "direct" | "failed";

/**
 * WHICH BROKER, decided from the process and nothing else.
 *
 *   hosted + IPC channel   the orchestrator's service over IPC; it stamps the
 *                          tenant from which child asked.
 *   hosted, no channel     none: every surface answers "unavailable" at once
 *                          (the orchestrator spawned us without the pass).
 *   self-hosted            a local runtime over fomo.sqlite, wrapped in a
 *                          direct broker for the fixed tenant "self".
 */
export async function chooseChildFomoBroker(c: {
  hosted: boolean;
  port: BrokerPort | null;
  selfHosted: () => Promise<FomoBroker>;
  log?: (line: string) => void;
}): Promise<{ broker: FomoBroker | null; kind: ChildBrokerKind }> {
  const log = c.log ?? (() => {});
  if (c.hosted) {
    if (!c.port) return { broker: null, kind: "unavailable" };
    return { broker: createIpcBroker(c.port, { log }), kind: "ipc" };
  }
  try {
    return { broker: await c.selfHosted(), kind: "direct" };
  } catch (e) {
    log(`[fomo] local research runtime could not start: ${e instanceof Error ? e.name : "error"}`);
    return { broker: null, kind: "failed" };
  }
}

/**
 * THE SELF-HOSTED RUNTIME: fomo.sqlite in MERRYMEN_HOME, the install's own key
 * (resolved by settings.ts and passed in), and permissions read from the
 * owner's live settings. Only the fixed tenant "self" is ever served.
 */
export async function selfHostedFomoBroker(o: {
  apiKey: string | null;
  access: () => FomoAccess;
  home?: string;
  /** Tests only. */
  db?: Db;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}): Promise<FomoBroker> {
  const db = o.db ?? openLocalFomoDb(o.home);
  await ensureFomoSchema(db, "sqlite");
  const none: FomoAccess = { dataAccess: false, monitoring: false, follow: false };
  const rt = await createFomoRuntime({
    db,
    dialect: "sqlite",
    apiKey: o.apiKey,
    // One install, one tenant. Anything else asking is nobody.
    access: async (tenant) => (tenant === SELF_HOSTED_TENANT ? o.access() : none),
    log: o.log,
    fetchImpl: o.fetchImpl,
    now: o.now,
  });
  return createDirectBroker(rt.service, SELF_HOSTED_TENANT, { log: o.log, now: o.now });
}

/**
 * THIS CHILD'S TENANT, from trusted process context only. Hosted: the
 * orchestrator's MERRYMEN_TENANT for the child it spawned (absent ⇒ null, and
 * the file is treated as unreadable). Self-hosted: "self".
 */
export function childFomoTenant(env: NodeJS.ProcessEnv, hosted: boolean): string | null {
  if (!hosted) return SELF_HOSTED_TENANT;
  const t = (env.MERRYMEN_TENANT ?? "").trim().toLowerCase();
  return /^[a-z0-9:_.-]{1,128}$/.test(t) ? t : null;
}

/**
 * LIVE FOLLOW ENTRIES ARE A SEPARATE CONSENT, and an operator's: named agents
 * in MERRYMEN_FOMO_FOLLOW_LIVE (prefix match, or `all`). DEFAULT EMPTY — nobody.
 * The same shape as brainLiveEnabledFor. Paper follow needs no entry here.
 */
export function fomoFollowLiveEnabledFor(agentId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.MERRYMEN_FOMO_FOLLOW_LIVE ?? "").trim();
  if (!raw) return false;
  const want = (agentId ?? "").trim().toLowerCase();
  if (!want) return false;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((p) => p === "all" || want.startsWith(p));
}

/** The file can only NARROW the owner's settings; data access gates the other two. */
export function effectiveAccess(owner: FomoAccess, file: FomoAccess | null): FomoAccess {
  const dataAccess = owner.dataAccess === true && file?.dataAccess === true;
  return {
    dataAccess,
    monitoring: dataAccess && owner.monitoring === true && file?.monitoring === true,
    follow: dataAccess && owner.follow === true && file?.follow === true,
  };
}

// ─── Durable follow-entry day counter (FollowCounters) ─────────────────────

/**
 * FOLLOW ENTRIES PER UTC DAY, ON DISK. A take writes before it returns true;
 * any failure is a refusal. An unreadable file is read as "today's allowance
 * is used up" and rewritten that way, so a damaged counter costs at most the
 * rest of one day — never a fresh allowance.
 */
export function fileFollowCounters(file: string, log: (line: string) => void = () => {}): FollowCounters {
  type Rec = { day: string; taken: number };
  const read = (): Rec | "corrupt" => {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { day: "", taken: 0 };
      return "corrupt";
    }
    try {
      const v = JSON.parse(text) as Partial<Rec>;
      if (typeof v.day === "string" && Number.isSafeInteger(v.taken) && (v.taken as number) >= 0) return { day: v.day, taken: v.taken as number };
    } catch {
      // fall through
    }
    return "corrupt";
  };
  const write = (r: Rec): void => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomicSync(file, JSON.stringify(r), 0o600);
  };
  return {
    takeFollowEntry(day, limit) {
      try {
        const cur = read();
        if (cur === "corrupt") {
          log("[fomo] follow-entry counter unreadable; today's follow entries are treated as used");
          write({ day, taken: limit });
          return false;
        }
        const taken = cur.day === day ? cur.taken : 0;
        if (taken >= limit) return false;
        write({ day, taken: taken + 1 });
        return true;
      } catch {
        return false;
      }
    },
    refundFollowEntry(day) {
      try {
        const cur = read();
        if (cur === "corrupt" || cur.day !== day || cur.taken <= 0) return;
        write({ day, taken: cur.taken - 1 });
      } catch {
        // Not refunded: under-spends by one, the safe side.
      }
    },
  };
}

/** Where this child keeps its follow-entry day count and its exploration ledger (its own home). */
export const FOMO_FOLLOW_COUNTER_FILE = "fomo-follow-entries.json";
export const FOMO_EXPLORATION_FILE = "fomo-exploration.json";

export function childFollowCounters(home: string, log?: (line: string) => void): FollowCounters {
  return fileFollowCounters(path.join(home, FOMO_FOLLOW_COUNTER_FILE), log);
}

export function childExplorationStore(home: string): ExplorationLedgerStore {
  return fileExplorationStore(path.join(home, FOMO_EXPLORATION_FILE));
}

// ─── The exploration ledger ────────────────────────────────────────────────

/**
 * WHAT EXPLORATION HOLDS AND HAS LOST, per rail.
 *
 * Exploration spends the owner's EXISTING scout budget (scoutEnabled,
 * scoutBudgetUsdg, scoutPerTokenUsdg) — there is no new allowance. Two figures
 * bound it, and both come from this agent's own book:
 *
 *   held     the cost basis still held in positions whose entry came from a
 *            follow (or early-candidate) decision; an unsettled entry counts
 *            its full cost until it is seen held or forgotten.
 *   lost     realised loss on those positions, since the AUTHORISATION EPOCH.
 *
 * THE EPOCH is the moment this worker first saw the owner's current scout
 * settings (enabled, budget, per-token). Changing any of them is a new
 * authorisation and starts a new epoch at zero loss; nothing else does. A
 * position's loss is max(0, entry cost − cost still held − proceeds), counted
 * per position and NEVER offset by another position's profit: a loss consumes
 * the allowance until the owner authorises again. Closing a losing position
 * moves its cost out of "held" and its loss into "lost", so the total it
 * consumes never shrinks below what it cost minus what came back.
 *
 * Proceeds are read from this worker's own trade rows (fill_cash_usdg) and are
 * floored to the micro-USDG; a sale whose cash leg is unknown counts as zero
 * proceeds — the loss is over-counted, never under-counted.
 *
 * Persisted beside the ledger in this child's home and written only by this
 * process. An unreadable file makes every figure UNKNOWN (no follow entry
 * sizes above zero) until the owner's next re-authorisation starts afresh.
 */
export type RailBook = "paper" | "live";

export interface ExplorationPosition {
  /** The cost-basis ledger's symbol for the coin. */
  symbol: string;
  /** Lowercased address. */
  token: string;
  source: "follow" | "early";
  decisionId: string | null;
  assessmentId: string | null;
  openedAt: number;
  entryCost6: bigint;
  proceeds6: bigint;
  /** Last basis read; null = unknown. Starts at the entry cost. */
  heldCost6: bigint | null;
  /** A fill was seen (paper/landed, a basis with quantity, or a sale). */
  everHeld: boolean;
  /**
   * First basis read that found it flat after a fill. It is closed one read
   * later (at least `flatConfirmMs` on), so a sale's proceeds — written by the
   * same trade path just after the basis — are counted before its loss is.
   */
  flatSince: number | null;
  setupExpiresAt: number | null;
  horizonEndsAt: number | null;
  strengthAtEntry: DossierStrength | null;
  traders: string[];
}

interface Book {
  positions: ExplorationPosition[];
  closedLoss6: bigint;
}

export interface ExplorationState {
  epochKey: string;
  epochSince: number;
  books: Record<RailBook, Book>;
}

export interface ExplorationLedgerStore {
  /** null = nothing stored yet; "corrupt" = unreadable. */
  load(): ExplorationState | null | "corrupt";
  save(s: ExplorationState): boolean;
}

const bigOf = (v: unknown): bigint | null => (typeof v === "string" && /^-?\d{1,30}$/.test(v) ? BigInt(v) : null);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function positionOf(v: unknown): ExplorationPosition | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const entryCost6 = bigOf(r.entryCost6);
  const proceeds6 = bigOf(r.proceeds6);
  const heldCost6 = r.heldCost6 === null ? null : bigOf(r.heldCost6);
  if (typeof r.symbol !== "string" || typeof r.token !== "string" || entryCost6 === null || proceeds6 === null) return null;
  if (r.heldCost6 !== null && heldCost6 === null) return null;
  if (r.source !== "follow" && r.source !== "early") return null;
  const openedAt = numOrNull(r.openedAt);
  if (openedAt === null) return null;
  const s = r.strengthAtEntry as Record<string, unknown> | null | undefined;
  const strength: DossierStrength | null =
    s && typeof s === "object"
      ? {
          strongSupport: Number(s.strongSupport) || 0,
          supportFamilies: Number(s.supportFamilies) || 0,
          supportAuthors: Number(s.supportAuthors) || 0,
          strongOpposition: Number(s.strongOpposition) || 0,
          opposeFamilies: Number(s.opposeFamilies) || 0,
        }
      : null;
  return {
    symbol: r.symbol,
    token: r.token.toLowerCase(),
    source: r.source,
    decisionId: typeof r.decisionId === "string" ? r.decisionId : null,
    assessmentId: typeof r.assessmentId === "string" ? r.assessmentId : null,
    openedAt,
    entryCost6,
    proceeds6,
    heldCost6,
    everHeld: r.everHeld === true,
    flatSince: numOrNull(r.flatSince),
    setupExpiresAt: numOrNull(r.setupExpiresAt),
    horizonEndsAt: numOrNull(r.horizonEndsAt),
    strengthAtEntry: strength,
    traders: Array.isArray(r.traders) ? r.traders.filter((x): x is string => typeof x === "string").slice(0, FOMO_CHILD.dependencyMaxTraders) : [],
  };
}

export function serializeExploration(s: ExplorationState): string {
  return JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

export function parseExploration(text: string): ExplorationState | "corrupt" {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    if (!v || typeof v !== "object" || typeof v.epochKey !== "string" || numOrNull(v.epochSince) === null) return "corrupt";
    const books = v.books as Record<string, unknown> | undefined;
    const out: ExplorationState = { epochKey: v.epochKey, epochSince: v.epochSince as number, books: { paper: emptyBook(), live: emptyBook() } };
    for (const mode of ["paper", "live"] as const) {
      const b = books?.[mode] as Record<string, unknown> | undefined;
      if (!b) continue;
      const loss = bigOf(b.closedLoss6);
      if (loss === null || loss < 0n || !Array.isArray(b.positions)) return "corrupt";
      const positions: ExplorationPosition[] = [];
      for (const p of b.positions) {
        const pos = positionOf(p);
        if (!pos) return "corrupt";
        positions.push(pos);
      }
      out.books[mode] = { positions, closedLoss6: loss };
    }
    return out;
  } catch {
    return "corrupt";
  }
}

const emptyBook = (): Book => ({ positions: [], closedLoss6: 0n });

export function fileExplorationStore(file: string): ExplorationLedgerStore {
  return {
    load() {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch (e) {
        return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? null : "corrupt";
      }
      return parseExploration(text);
    },
    save(s) {
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileAtomicSync(file, serializeExploration(s), 0o600);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function memoryExplorationStore(initial: ExplorationState | null | "corrupt" = null): ExplorationLedgerStore & { saved: number; last: ExplorationState | null } {
  let text: string | "corrupt" | null = initial === null ? null : initial === "corrupt" ? "corrupt" : serializeExploration(initial);
  const s = {
    saved: 0,
    last: null as ExplorationState | null,
    load(): ExplorationState | null | "corrupt" {
      if (text === null) return null;
      if (text === "corrupt") return "corrupt";
      return parseExploration(text);
    },
    save(st: ExplorationState): boolean {
      text = serializeExploration(st);
      s.saved++;
      s.last = parseExploration(text) as ExplorationState;
      return true;
    },
  };
  return s;
}

const max0 = (v: bigint) => (v > 0n ? v : 0n);

export interface ExplorationFigures {
  held6: bigint | null;
  loss6: bigint | null;
  tokenHeld6(token: string): bigint | null;
}

export class ExplorationLedger {
  private state: ExplorationState | null;
  private unknown: boolean;
  /** While unknown: the scout settings in force when it became unknown. A change is a re-authorisation. */
  private unknownKey: string | null = null;

  constructor(
    private readonly store: ExplorationLedgerStore,
    private readonly log: (line: string) => void = () => {},
  ) {
    const loaded = store.load();
    this.unknown = loaded === "corrupt";
    this.state = loaded === "corrupt" ? null : loaded;
    if (this.unknown) log("[fomo] exploration ledger unreadable; follow entries size to zero until the scout budget is re-authorised");
  }

  /** The owner's scout settings as an authorisation: a change is a new epoch. */
  syncEpoch(key: string, now: number): void {
    if (this.unknown) {
      if (this.unknownKey === null || this.unknownKey === key) {
        this.unknownKey = key;
        return;
      }
      this.log("[fomo] scout budget re-authorised; the exploration ledger starts afresh");
      this.unknown = false;
      this.unknownKey = null;
      this.state = { epochKey: key, epochSince: now, books: { paper: emptyBook(), live: emptyBook() } };
      this.store.save(this.state);
      return;
    }
    if (this.state && this.state.epochKey === key) return;
    if (this.state) {
      // A NEW AUTHORISATION. Losses before it are not counted against it; the
      // positions still open keep counting what they hold now.
      for (const mode of ["paper", "live"] as const) {
        const b = this.state.books[mode];
        b.closedLoss6 = 0n;
        for (const p of b.positions) {
          if (p.heldCost6 !== null) p.entryCost6 = p.heldCost6;
          p.proceeds6 = 0n;
        }
      }
      this.state.epochKey = key;
      this.state.epochSince = now;
    } else {
      this.state = { epochKey: key, epochSince: now, books: { paper: emptyBook(), live: emptyBook() } };
    }
    this.store.save(this.state);
  }

  figures(mode: RailBook): ExplorationFigures {
    if (this.unknown) return { held6: null, loss6: null, tokenHeld6: () => null };
    // Nothing stored yet is a fact, not a gap: a position is only ever opened
    // into a stored ledger, so none exists and nothing has been lost.
    const book = this.state ? this.state.books[mode] : emptyBook();
    let held: bigint | null = 0n;
    let loss: bigint | null = book.closedLoss6;
    for (const p of book.positions) {
      if (p.heldCost6 === null || held === null || loss === null) {
        held = null;
        loss = null;
        break;
      }
      held += p.heldCost6;
      loss += max0(p.entryCost6 - p.heldCost6 - p.proceeds6);
    }
    return {
      held6: held,
      loss6: loss,
      tokenHeld6: (token) => {
        const t = token.toLowerCase();
        let sum = 0n;
        for (const p of book.positions) {
          if (p.token !== t) continue;
          if (p.heldCost6 === null) return null;
          sum += p.heldCost6;
        }
        return sum;
      },
    };
  }

  position(mode: RailBook, token: string): ExplorationPosition | null {
    const t = token.toLowerCase();
    return this.state?.books[mode].positions.find((p) => p.token === t) ?? null;
  }

  positions(mode: RailBook): readonly ExplorationPosition[] {
    return this.state?.books[mode].positions ?? [];
  }

  open(mode: RailBook, p: ExplorationPosition): void {
    if (!this.state || this.unknown) return;
    this.state.books[mode].positions.push(p);
    this.store.save(this.state);
  }

  /** A sale of a coin exploration holds. Unknown cash counts as zero proceeds. */
  noteSell(mode: RailBook, token: string, cash6: bigint | null): void {
    if (!this.state || this.unknown) return;
    const p = this.position(mode, token);
    if (!p) return;
    p.everHeld = true;
    if (cash6 !== null && cash6 > 0n) p.proceeds6 += cash6;
    this.store.save(this.state);
  }

  /**
   * One pass over the open positions against this agent's own basis: still
   * held → its cost now; flat after a fill → closed, its loss kept; never seen
   * filled past the grace → forgotten as no fill.
   */
  async refresh(mode: RailBook, basisOf: (symbol: string) => Promise<{ qtyRaw: bigint; costUsdg: bigint } | null>, now: number): Promise<void> {
    if (!this.state || this.unknown) return;
    const book = this.state.books[mode];
    let changed = false;
    for (const p of [...book.positions]) {
      let b: { qtyRaw: bigint; costUsdg: bigint } | null = null;
      try {
        b = await basisOf(p.symbol);
      } catch {
        b = null;
      }
      if (!this.state || this.state.books[mode] !== book) return;
      if (b === null) {
        if (p.heldCost6 !== null) changed = true;
        p.heldCost6 = null;
        continue;
      }
      if (b.qtyRaw > 0n) {
        if (p.heldCost6 !== b.costUsdg || !p.everHeld || p.flatSince !== null) changed = true;
        p.heldCost6 = b.costUsdg;
        p.everHeld = true;
        p.flatSince = null;
        continue;
      }
      if (p.everHeld) {
        if (p.flatSince === null) {
          // Flat now: nothing is held, and until the sale's proceeds arrive
          // the whole entry cost reads as lost — the conservative side.
          p.flatSince = now;
          p.heldCost6 = 0n;
          changed = true;
        } else if (now - p.flatSince >= FOMO_CHILD.flatConfirmMs) {
          book.closedLoss6 += max0(p.entryCost6 - p.proceeds6);
          book.positions = book.positions.filter((x) => x !== p);
          changed = true;
        }
      } else if (now - p.openedAt > FOMO_CHILD.unsettledGraceMs) {
        book.positions = book.positions.filter((x) => x !== p);
        changed = true;
      } else if (p.heldCost6 !== p.entryCost6) {
        p.heldCost6 = p.entryCost6;
        changed = true;
      }
    }
    if (changed) this.store.save(this.state);
  }
}

// ─── Brain's advertised lenses ─────────────────────────────────────────────

/**
 * DOES THIS BRAIN ACCEPT `trader-flow`? Every DecideRequest model forbids
 * unknown keys, so an older Brain would 422 every decision we sent it — the
 * whole review, not just the lens. Asked of GET <brainUrl>/health (lens_keys),
 * at most once an hour per URL, never on the review's own clock: a review
 * asks `advertises()`, gets the cached answer (false until known) and, when
 * due, starts a read in the background.
 */
export class BrainLensProbe {
  private url = "";
  private checkedAt = Number.NEGATIVE_INFINITY;
  private value = false;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly fetchImpl: typeof fetch | undefined,
    private readonly now: () => number = Date.now,
    private readonly everyMs: number = FOMO_CHILD.lensProbeEveryMs,
    private readonly timeoutMs: number = FOMO_CHILD.lensProbeTimeoutMs,
  ) {}

  advertises(brainUrl: string | null | undefined): boolean {
    const u = typeof brainUrl === "string" ? brainUrl.trim().replace(/\/+$/, "") : "";
    if (!/^https?:\/\/\S+$/.test(u)) return false;
    if (u !== this.url) {
      this.url = u;
      this.checkedAt = Number.NEGATIVE_INFINITY;
      this.value = false;
    }
    const t = this.now();
    if (!this.inflight && t - this.checkedAt >= this.everyMs) {
      this.checkedAt = t;
      this.inflight = this.probe(u).finally(() => {
        this.inflight = null;
      });
    }
    return this.value;
  }

  /** Resolves when no read is in flight (tests, shutdown). */
  settled(): Promise<void> {
    return this.inflight ?? Promise.resolve();
  }

  private async probe(u: string): Promise<void> {
    let ok = false;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    try {
      const res = await (this.fetchImpl ?? fetch)(`${u}/health`, { method: "GET", signal: ctl.signal, headers: { accept: "application/json" } });
      if (res.ok) {
        const text = await res.text();
        if (text.length <= 64_000) {
          const j = JSON.parse(text) as { lens_keys?: unknown };
          ok = Array.isArray(j?.lens_keys) && j.lens_keys.includes(TRADER_FLOW_LENS);
        }
      }
    } catch {
      ok = false;
    } finally {
      clearTimeout(timer);
    }
    if (this.url === u) this.value = ok;
  }
}

// ─── Ports ──────────────────────────────────────────────────────────────────

/** What the early-candidate book offers (EarlyCandidateBook satisfies it). */
export interface EarlyOfferPort {
  offer(address: string, o: EarlyOffer): EarlyOfferResult;
  active(): readonly Readonly<{ address: string; source: string; state: string; decisionId: string | null }>[];
  maxUsdgFor(address: string): number | null;
}

/** The decision funnel (decision-funnel.ts): filing a follow drop, and reading a coin's latest stage. */
export interface FunnelPort {
  note(address: string, symbol: string | null, c: Classified): void;
  latest(address: string): { stage: string; detail: string; decisionId: string | null; at: number } | null;
}

export interface FomoChildSettings {
  dataAccess: boolean;
  monitoring: boolean;
  follow: boolean;
  strategy: string;
  trencherFast: boolean;
  scoutEnabled: boolean;
  scoutBudgetUsdg: number;
  scoutPerTokenUsdg: number;
}

/** Our OWN price for a coin, from this worker's pricing pass. Never a provider figure. */
export interface OwnPrice {
  price8: bigint;
  source: string;
  stale: boolean;
}

/**
 * Everything read at the moment of asking, from trusted in-process state
 * (settings, the pause marker, the rail verdict, the grant's limits, this
 * tick's prices and verified pools). Synchronous and cheap.
 */
export interface FomoLiveFacts {
  agentId: string | null;
  settings: FomoChildSettings;
  rail: "paper" | "live" | "refuse";
  paused: boolean;
  liveFollowAllowed: boolean;
  /** sponsoredFlow: this rail plans sponsored gas; available: the sponsor quoted at arm (null = unknown). */
  sponsorship: { sponsoredFlow: boolean; available: boolean | null };
  /** The signed per-trade cap (grant limits), micro-USDG. */
  perTrade6: bigint | null;
  /** What today's daily cap still allows, from the existing budget counters. */
  dailyHeadroom6: bigint | null;
  /** The grant carries a Trencher vault (the autonomous custody path). */
  vault: boolean;
  /** The vault's chain-verified asset list covers this coin. */
  knownAsset(address: string): boolean;
  /** Discovery verified this coin's pool on chain this pass (null = discovery has not answered). */
  routeVerified(address: string): boolean | null;
  /** In-range depth from our own pool pricing, USD (null = unknown). */
  depthUsd(address: string): number | null;
  price(address: string): OwnPrice | null;
  /** When `price` was read (ms). */
  pricesAt: number | null;
}

export interface HeldCoin {
  token: string;
  symbol: string;
  decimals: number;
  valueUsdg6: bigint;
  price8: bigint;
  priceStale: boolean;
}

export interface FomoTickInput {
  now?: number;
  /** The Trencher review context; a change resets every follow nomination. */
  context: string;
  /** Composed equity, or null when the book is incomplete (unknown is not permission). */
  equity6: bigint | null;
  held: readonly HeldCoin[];
  basis(symbol: string): Promise<{ qtyRaw: bigint; costUsdg: bigint } | null>;
  entrySec(symbol: string): Promise<number | null>;
}

export interface FomoChildDeps {
  broker(): FomoBroker | null;
  /** Trusted: childFomoTenant(). Never the file's, never a message's. */
  ownTenant(): string | null;
  home(): string;
  live(): FomoLiveFacts;
  earlyBook(): EarlyOfferPort | null;
  counters: FollowCounters;
  ledgerStore: ExplorationLedgerStore;
  funnel?: FunnelPort;
  readFile?: (home: string, tenant: string, now: number) => ChildFomoRead;
  /** The cost-basis ledger's symbol for a coin (index.ts: the watch set). */
  symbolOf?: (token: string) => string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

export type FomoChildReadReason = ChildFomoReadReason | "tenant-unknown" | "not-read";

export interface FomoChildHealth {
  at: number | null;
  read: FomoChildReadReason;
  state: FomoHealthState | null;
  detail: string | null;
  cohortSize: number | null;
  cohortTarget: number | null;
  lastEventAt: number | null;
  signals: number;
  access: FomoAccess;
  followNominations: number;
  heldReviews: number;
  brokerConfigured: boolean | null;
}

/** What the entry gate decided for one intent. */
export type FollowGate =
  | { kind: "none" }
  | { kind: "early"; token: string; mode: RailBook; size6: bigint }
  | {
      kind: "follow";
      token: string;
      tokenKey: string;
      reservationId: string;
      size6: bigint;
      assessment: FollowAssessment;
      mode: RailBook;
    }
  | { kind: "dropped"; token: string; reason: string; stage: FunnelStage };

export interface LensTrace {
  at: number;
  decisionId: string;
  token: string;
  dossierRevision: { dossierId: string; revision: number } | null;
  refsSent: string[];
  cited: string[];
  /** Cited refs Brain was never sent: recorded, never treated as evidence. */
  unverified: string[];
}

// ─── Small pure helpers ────────────────────────────────────────────────────

const lower = (a: unknown) => (typeof a === "string" ? a.trim().toLowerCase() : "");
const EVM = /^0x[0-9a-f]{40}$/;
const robinhoodKey = (address: string) => keyOf(robinhoodChain(), lower(address));

/** A coin the desk could ever hold as a speculative position: a memecoin, not cash, not the energy reserve. */
export function tradableCoin(address: string): boolean {
  const a = lower(address);
  if (!EVM.test(a)) return false;
  if ([CASH.USDG, CASH.WETH].some((c) => c.toLowerCase() === a)) return false;
  if (isEnergyReserveToken(a)) return false;
  return instrumentClassOf(a) === "memecoin";
}

const eventTime = (e: TraderEvent): number | null => {
  const t = typeof e.sourceEventAt === "number" && Number.isFinite(e.sourceEventAt) ? e.sourceEventAt : e.observedAt;
  return typeof t === "number" && Number.isFinite(t) ? t : null;
};

/** Distinct cohort traders by their LATEST buy/sell since `since` (ties go to the sell). */
export function cohortSince(triggers: readonly TraderEvent[], tokenKey: string, since: number | null): { buyers: number; sellers: number; newestSell: string | null } {
  const latest = new Map<string, { kind: "buy" | "sell"; at: number }>();
  let newestSell: { key: string; at: number } | null = null;
  for (const e of triggers) {
    if (!e?.token || e.token.key !== tokenKey || (e.kind !== "buy" && e.kind !== "sell")) continue;
    const at = eventTime(e);
    if (at === null || (since !== null && at < since)) continue;
    const uid = lower(e.trader?.userId);
    if (!uid) continue;
    const prev = latest.get(uid);
    if (!prev || at > prev.at || (at === prev.at && e.kind === "sell")) latest.set(uid, { kind: e.kind, at });
    if (e.kind === "sell" && (!newestSell || at > newestSell.at)) newestSell = { key: e.eventKey, at };
  }
  let buyers = 0;
  let sellers = 0;
  for (const v of latest.values()) v.kind === "buy" ? buyers++ : sellers++;
  return { buyers, sellers, newestSell: newestSell?.key ?? null };
}

/** costUsdg(6dp) / qty(10^dec) → USD per whole token at 8dp. Null when either is missing. */
export function entryPrice8Of(cost6: bigint | null, qtyRaw: bigint | null, decimals: number): bigint | null {
  if (cost6 === null || qtyRaw === null || cost6 <= 0n || qtyRaw <= 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  return (cost6 * 10n ** BigInt(decimals) * 100n) / qtyRaw;
}

const HORIZON_MS: Readonly<Record<string, number>> = { "30m": 30 * 60_000, "1h": 3_600_000, "4h": 4 * 3_600_000, "24h": 86_400_000 };

const ADDRESSY = /0x[0-9a-fA-F]{6,}|[1-9A-HJ-NP-Za-km-z]{32,}/;
const VENDOR = /fomo/i;
const REF = /\[ref:[A-Za-z0-9._:-]{1,64}\]/g;

/** Which funnel stage a follow drop is filed under. */
export function followDropStage(reason: string): FunnelStage {
  switch (reason) {
    case "sponsorship-unavailable":
      return "SPONSORSHIP_UNAVAILABLE";
    case "follow-disabled":
    case "entries-paused":
    case "rail-refused":
    case "live-follow-not-allowed":
    case "permission-missing":
    case "rail-mode-changed":
    case "execution-unavailable":
      return "PERMISSION_BLOCKED";
    case "size-below-floor":
      return "SIZE_BELOW_ECONOMIC_FLOOR";
    case "exploration-exhausted":
    case "follow-entry-cap":
      return "BUDGET_EXHAUSTED";
    default:
      return "RESEARCH_INCOMPLETE";
  }
}

const FUNNEL_STAGES: ReadonlySet<string> = new Set<FunnelStage>([
  "NOT_DISCOVERED",
  "DISCOVERY_SCREENED_OUT",
  "RESEARCH_INCOMPLETE",
  "MODEL_HOLD",
  "GATE_FORCED_HOLD",
  "PERMISSION_BLOCKED",
  "UNSUPPORTED_ROUTE",
  "SIZE_BELOW_ECONOMIC_FLOOR",
  "SPONSORSHIP_UNAVAILABLE",
  "BUDGET_EXHAUSTED",
  "SUBMISSION_FAILED",
  "SETTLEMENT_PENDING",
  "LANDED",
]);

const NO_ACCESS: FomoAccess = Object.freeze({ dataAccess: false, monitoring: false, follow: false });

// ─── The child ──────────────────────────────────────────────────────────────

interface Tracked {
  assessment: FollowAssessment;
  until: number;
  triggers: TraderEvent[];
  strength: DossierStrength | null;
}

export class FomoChild {
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  readonly followBook: FollowBook;
  readonly reservations: ExplorationReservations;
  readonly ledger: ExplorationLedger;
  readonly lensProbe: BrainLensProbe;

  private file: ChildFomoFile | null = null;
  private fileReason: FomoChildReadReason = "not-read";
  private fileReadAt = Number.NEGATIVE_INFINITY;
  private lastTickAt: number | null = null;
  private access: FomoAccess = NO_ACCESS;
  private context: string | null = null;
  private equity6: bigint | null = null;
  private held = new Map<string, HeldCoin>();
  private heldFacts = new Map<string, { entrySec: number | null; qtyRaw: bigint | null; cost6: bigint | null }>();
  private tracked = new Map<string, Tracked>();
  private signalPrices = new Map<string, { eventKey: string; price: number | null }>();
  private assessments = new Map<string, FollowAssessment>();
  private reportedAssessments = new Map<string, string>();
  private heldReviewSent = new Map<string, { sig: string; at: number }>();
  private funnelSent = new Map<string, { sig: string; at: number }>();
  private heldTokensAt = Number.NEGATIVE_INFINITY;
  private verify: string[] = [];
  private lensSent = new Map<string, { at: number; refs: string[]; dossierRevision: { dossierId: string; revision: number } | null }>();
  private traces: LensTrace[] = [];
  private refreshing: Promise<void> | null = null;
  private logged = new Set<string>();
  private seq = 0;

  constructor(private readonly deps: FomoChildDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.followBook = new FollowBook(deps.counters, this.now);
    this.reservations = new ExplorationReservations({ now: this.now });
    this.ledger = new ExplorationLedger(deps.ledgerStore, this.log);
    this.lensProbe = new BrainLensProbe(deps.fetchImpl, this.now);
  }

  // ── the tick ───────────────────────────────────────────────────────────

  /**
   * One pass. Synchronous: reads the file (bounded, at most every few
   * seconds), assesses its signals, nominates, asks for sooner held reviews and
   * reports. The ledger and entry-fact reads it needs are started in the
   * background and serve the NEXT pass. Never throws.
   */
  tick(input: FomoTickInput): void {
    const now = input.now ?? this.now();
    try {
      this.lastTickAt = now;
      const live = this.deps.live();
      this.equity6 = input.equity6;
      this.held = new Map(input.held.map((h) => [lower(h.token), h]));
      this.syncContext(input.context);
      // The authorisation epoch is tracked only while following is on in the
      // owner's settings (nothing is written for an owner who never uses it); a
      // scout change made meanwhile is still seen as a new epoch when it is.
      if (live.settings.follow === true) this.ledger.syncEpoch(scoutKey(live.settings), now);
      this.readFileMaybe(now);
      const owner: FomoAccess = { dataAccess: live.settings.dataAccess, monitoring: live.settings.monitoring, follow: live.settings.follow };
      this.access = effectiveAccess(owner, this.file?.access ?? null);
      this.followBook.expire();
      for (const [a, t] of this.tracked) if (now >= t.until) this.tracked.delete(a);
      this.verify = [];
      if (this.file && this.access.dataAccess && (this.access.monitoring || this.access.follow)) {
        this.assessAll(this.file, live, now);
      }
      // Reports go only where the OWNER has research on: nothing tenant-private
      // leaves this process for an owner who turned it off.
      if (owner.dataAccess && (owner.monitoring || owner.follow)) {
        this.reportHeldTokens(now, input.held);
        this.reportFunnel(now);
      }
      this.kickRefresh(input, live, now);
    } catch (e) {
      this.once(`tick:${e instanceof Error ? e.name : "error"}`, `[fomo] child tick skipped (${e instanceof Error ? e.name : "error"})`);
    }
  }

  /** Resolves when the background reads started by the last tick have finished (tests, shutdown). */
  settled(): Promise<void> {
    return Promise.all([this.refreshing ?? Promise.resolve(), this.lensProbe.settled()]).then(() => undefined);
  }

  private syncContext(context: string): void {
    if (this.context !== null && this.context !== context) {
      // A paper/live flip, a new grant, a new Brain: every pending follow
      // nomination is over; nothing is replayed. Caps and reservations survive.
      this.followBook.reset();
      this.tracked.clear();
    }
    this.context = context;
  }

  private readFileMaybe(now: number): void {
    if (now - this.fileReadAt < FOMO_CHILD.fileReadEveryMs && this.fileReason !== "not-read") return;
    this.fileReadAt = now;
    const tenant = this.deps.ownTenant();
    if (!tenant) {
      this.file = null;
      this.fileReason = "tenant-unknown";
      return;
    }
    const read = (this.deps.readFile ?? readChildFomoFile)(this.deps.home(), tenant, now);
    this.file = read.reason === "ok" ? read.file : null;
    this.fileReason = read.reason;
  }

  /**
   * Following may act only when the owner's setting AND the file's access say
   * so, on a fast-Trencher strategy — read at the moment of asking, so an owner
   * who turns it off between a tick and an entry is obeyed at the entry.
   */
  private followAllowed(live: FomoLiveFacts): boolean {
    const owner: FomoAccess = { dataAccess: live.settings.dataAccess, monitoring: live.settings.monitoring, follow: live.settings.follow };
    return effectiveAccess(owner, this.file?.access ?? null).follow && live.settings.strategy === "trencher" && live.settings.trencherFast === true;
  }

  private ownQuote(address: string, live: FomoLiveFacts): FollowQuote | null {
    const p = live.price(address);
    // POOL-GRADE ONLY, as trenchCandidates requires for an entry: a curve or v4
    // mark values a holding and does not authorise a buy.
    if (!p || p.stale || p.source !== "pool" || typeof p.price8 !== "bigint" || p.price8 <= 0n || live.pricesAt === null) return null;
    return { price8: p.price8, at: live.pricesAt, source: "pool" };
  }

  private route(address: string, live: FomoLiveFacts, quote: FollowQuote | null, now: number): FollowRoute {
    const depth = live.depthUsd(address);
    return {
      verified: live.routeVerified(address),
      depthUsd: typeof depth === "number" && Number.isFinite(depth) && depth >= 0 ? depth : null,
      quoteAgeMs: quote ? Math.max(0, now - quote.at) : null,
      impactBps: null,
    };
  }

  private permissions(live: FomoLiveFacts, address: string): FollowPermissions {
    return {
      followEnabled: this.followAllowed(live),
      paused: live.paused === true,
      railMode: live.rail,
      liveFollowAllowed: live.liveFollowAllowed === true,
      grantCoversToken: live.vault === true && live.knownAsset(address) === true,
    };
  }

  private mode(live: FomoLiveFacts): RailBook {
    return live.rail === "paper" ? "paper" : "live";
  }

  /** The follow ceiling for one coin NOW, from this agent's own limits, book and route. */
  ceilingFor(address: string, now: number, live: FomoLiveFacts = this.deps.live()): EntryCeiling {
    const tokenKey = robinhoodKey(address);
    const f = this.ledger.figures(this.mode(live));
    const pending = this.reservations.pendingAgainst(now, tokenKey);
    const depth = live.depthUsd(address);
    const routeCapacity6 =
      typeof depth === "number" && Number.isFinite(depth) && depth >= 0 ? BigInt(Math.floor((depth * 1e6) / FOLLOW_DEFAULTS.minDepthMultiple)) : null;
    return entryCeiling({
      perTradeLimit6: live.perTrade6,
      dailyHeadroom6: live.dailyHeadroom6,
      scout: {
        enabled: live.settings.scoutEnabled === true,
        budget6: microUsdgFloor(live.settings.scoutBudgetUsdg),
        perToken6: microUsdgFloor(live.settings.scoutPerTokenUsdg),
      },
      explorationHeldCost6: f.held6,
      explorationPending6: pending.exploration6,
      realizedExplorationLoss6: f.loss6,
      tokenHeldCost6: f.tokenHeld6(address),
      tokenPending6: pending.token6,
      equity6: this.equity6,
      maxExplorationShareBps: FOMO_CHILD.explorationShareBps,
      routeCapacity6,
      // Every follow entry is a vault-custody (autonomous) entry: grantCoversToken requires the vault.
      autonomousCap6: AUTONOMOUS_ENTRY_CAP_6,
      minEconomic6: FOMO_CHILD.minEconomic6,
    });
  }

  /**
   * OUR PRICE AT THE TRIGGERING BUY, or null. Recorded the first time a newest
   * cohort buy is seen, and only when our own pool quote was read within
   * `signalPriceMaxLagMs` of that buy. A buy first seen too late keeps a null:
   * the move since the signal is unknown, which the machine reads as WATCH.
   */
  private signalPrice(s: ChildSignal, quote: FollowQuote | null, now: number): number | null {
    let newest: TraderEvent | null = null;
    for (const e of s.triggers) {
      if (e.kind !== "buy" || !e.token || e.token.key !== s.token.key) continue;
      const at = eventTime(e);
      if (at === null || now - at > FOLLOW_DEFAULTS.breadthWindowMs) continue;
      if (!newest || at > (eventTime(newest) ?? -Infinity)) newest = e;
    }
    if (!newest) return null;
    const prior = this.signalPrices.get(s.token.key);
    if (prior && prior.eventKey === newest.eventKey) return prior.price;
    const at = eventTime(newest)!;
    const price = quote && Math.abs(quote.at - at) <= FOMO_CHILD.signalPriceMaxLagMs ? Number(quote.price8) / 1e8 : null;
    this.signalPrices.set(s.token.key, { eventKey: newest.eventKey, price });
    if (this.signalPrices.size > 200) this.signalPrices.delete(this.signalPrices.keys().next().value as string);
    return price;
  }

  private assessAll(file: ChildFomoFile, live: FomoLiveFacts, now: number): void {
    const tenant = this.deps.ownTenant();
    if (!tenant) return;
    const follow = this.followAllowed(live);
    const mode = this.mode(live);
    for (const s of file.signals.slice(0, 40)) {
      try {
        const address = lower(s.token.address);
        const robinhood = isRobinhoodToken(s.token);
        const quote = robinhood ? this.ownQuote(address, live) : null;
        const route = robinhood ? this.route(address, live, quote, now) : { verified: null, depthUsd: null, quoteAgeMs: null, impactBps: null };
        const permissions = this.permissions(live, address);
        const availability = executionAvailabilityOf(s.token, { routeVerified: route.verified, permitted: permissions.grantCoversToken });
        const holding = robinhood ? this.held.get(address) : undefined;
        let held: FollowHeld = { held: false, costBasis6: null, unrealizedPct: null, entryAssessmentId: null };
        let review: HeldReview | null = null;
        let heldSell: string | null = null;
        if (holding) {
          const facts = this.heldFacts.get(holding.symbol);
          // Not read yet: nothing is assessed for this held coin this pass,
          // rather than a "missing data" review raised by our own cold cache.
          if (!facts) continue;
          const pos = this.ledger.position(mode, address);
          const nowStrength = dossierStrength(s.dossier);
          const entryAt = facts.entrySec !== null ? facts.entrySec * 1000 : pos?.openedAt ?? null;
          const entryPrice8 = entryPrice8Of(facts.cost6, facts.qtyRaw, holding.decimals);
          const flow = cohortSince(s.triggers, s.token.key, entryAt);
          const seen = flow.buyers + flow.sellers > 0;
          review = reviewHeldPosition({
            now,
            entryAt,
            entryPrice8,
            quote: !holding.priceStale && holding.price8 > 0n && live.pricesAt !== null ? { price8: holding.price8, at: live.pricesAt } : null,
            positionValueUsd: Number(holding.valueUsdg6) / 1e6,
            routeDepthUsd: route.depthUsd,
            horizonEndsAt: pos?.horizonEndsAt ?? null,
            setupExpiresAt: pos?.setupExpiresAt ?? null,
            cohort: { sellers: seen ? flow.sellers : null, buyers: seen ? flow.buyers : null },
            flowReversed: seen ? flow.sellers > flow.buyers : null,
            objectionStrengthened: objectionStrengthened(pos?.strengthAtEntry ?? null, nowStrength),
          });
          const unrealizedPct =
            entryPrice8 !== null && entryPrice8 > 0n && !holding.priceStale && holding.price8 > 0n
              ? Math.round((Number(holding.price8 - entryPrice8) / Number(entryPrice8)) * 1_000_000) / 10_000
              : null;
          held = {
            held: true,
            costBasis6: facts.cost6,
            unrealizedPct,
            entryAssessmentId: pos?.assessmentId ?? null,
            thesisStrengthened: thesisStrengthened(pos?.strengthAtEntry ?? null, nowStrength),
            review,
          };
          heldSell = flow.newestSell;
        }
        const sizing = robinhood ? this.ceilingFor(address, now, live) : zeroCeiling();
        const a = assessFollow({
          tenant,
          token: s.token,
          label: s.label,
          triggers: s.triggers,
          dossier: s.dossier,
          now,
          quote,
          signalPriceUsd: robinhood ? this.signalPrice(s, quote, now) : null,
          held,
          permissions,
          availability,
          route,
          sizing,
        });
        this.assessments.set(s.token.key, a);
        if (this.assessments.size > FOMO_CHILD.reportedMax) this.assessments.delete(this.assessments.keys().next().value as string);
        this.reportAssessment(a);
        const hint = toExecutionHint(a);
        if (hint.kind === "nominate" && follow && !live.paused) this.nominate(hint, a, s);
        // A SOONER REVIEW, NEVER A SELL — whether or not following is on: a
        // held coin's protection does not wait for permission to buy.
        if (holding && review) this.maybeRequestHeldReview(address, review, heldSell, now, a, hint);
        // VERIFICATION ONLY. A coin with cohort buying that discovery has not
        // verified cannot become an entry candidate (route unverified ⇒
        // research only), and it cannot be verified unless someone asks. So
        // it is asked of discovery's early verification — a tape page and an
        // on-chain pool check, never a review slot and never a ceiling: it is
        // not offered to the early book, so it never becomes a candidate.
        if (follow && live.vault && robinhood && !holding && tradableCoin(address) && this.verify.length < FOMO_CHILD.verifyMax) {
          if (cohortSince(s.triggers, s.token.key, now - FOLLOW_DEFAULTS.breadthWindowMs).buyers > 0) this.verify.push(address);
        }
      } catch (e) {
        this.once(`assess:${e instanceof Error ? e.name : "error"}`, `[fomo] one signal could not be assessed (${e instanceof Error ? e.name : "error"})`);
      }
    }
  }

  private nominate(hint: Extract<ExecutionHint, { kind: "nominate" }>, a: FollowAssessment, s: ChildSignal): void {
    const book = this.deps.earlyBook();
    if (!book) {
      this.once("early-not-ready", "[fomo] early-candidate book not ready; follow nominations wait");
      return;
    }
    const r = this.followBook.offer(hint);
    if (!r.ok) {
      if (r.reason !== "duplicate") this.once(`follow-offer:${r.reason}`, `[fomo] follow nomination refused: ${r.reason}`);
      return;
    }
    const address = lower(hint.tokenAddress);
    this.tracked.set(address, {
      assessment: a,
      until: hint.expiresAt + FOMO_CHILD.trackedGraceMs,
      triggers: s.triggers.filter((e) => a.triggerEventKeys.includes(e.eventKey)),
      strength: dossierStrength(s.dossier),
    });
    const res = book.offer(address, {
      source: FOLLOW_SOURCE,
      priority: hint.priority,
      maxUsdg6: hint.maxUsdg6,
      probe: hint.probe,
      expiresAt: hint.expiresAt,
      ref: hint.assessmentId,
    });
    if (res.startsWith("refused:")) this.once(`early-offer:${res}`, `[fomo] early book refused a follow nomination: ${res.slice(8)}`);
    else this.log(`[fomo] follow nomination ${res} (${hint.probe ? "probe" : "entry"}, ceiling ${(Number(hint.maxUsdg6) / 1e6).toFixed(2)} USDG)`);
  }

  /**
   * A SOONER REVIEW OF A HELD COIN, never a sell. Raised when the lifecycle
   * verdict is review / reduce / exit, edge-triggered: again only when its
   * reasons (or the newest cohort sale) change, or after `heldReviewRepeatMs`.
   */
  private maybeRequestHeldReview(address: string, review: HeldReview, newestSell: string | null, now: number, a: FollowAssessment, hint: ExecutionHint): void {
    if (review.action === "hold") return;
    const sig = `${review.action}|${[...review.reasons].sort().join(",")}|${newestSell ?? ""}`;
    const prev = this.heldReviewSent.get(address);
    if (prev && prev.sig === sig && now - prev.at < FOMO_CHILD.heldReviewRepeatMs) return;
    const urgency: "normal" | "soon" =
      hint.kind === "review-held" ? hint.urgency : review.action !== "review" || review.urgency === "soon" || review.urgency === "immediate" ? "soon" : "normal";
    const h: ExecutionHint = { kind: "review-held", tokenAddress: address as `0x${string}`, urgency, assessmentId: a.id };
    if (this.followBook.requestHeldReview(h)) {
      this.heldReviewSent.set(address, { sig, at: now });
      if (this.heldReviewSent.size > FOMO_CHILD.reportedMax) this.heldReviewSent.delete(this.heldReviewSent.keys().next().value as string);
    }
  }

  /** Addresses whose held review should come sooner (the existing held-review rotation reads this). */
  heldReviewDue(token: string): boolean {
    try {
      const a = lower(token);
      return this.followBook.heldReviewRequests().some((r) => r.address === a);
    } catch {
      return false;
    }
  }

  /** Coins asked of discovery for on-chain verification only (bounded; see assessAll). */
  verifyRequests(): string[] {
    return [...this.verify];
  }

  // ── reports (best effort, never awaited into the trading path) ─────────

  private reportAssessment(a: FollowAssessment): void {
    const broker = this.deps.broker();
    if (!broker) return;
    const sig = `${a.state}|${[...a.reasonCodes].sort().join(",")}`;
    if (this.reportedAssessments.get(a.token.key) === sig) return;
    this.reportedAssessments.set(a.token.key, sig);
    if (this.reportedAssessments.size > FOMO_CHILD.reportedMax) this.reportedAssessments.delete(this.reportedAssessments.keys().next().value as string);
    void broker.report({ kind: "assessment", assessment: a }).catch(() => {});
  }

  private reportHeldTokens(now: number, held: readonly HeldCoin[]): void {
    const broker = this.deps.broker();
    if (!broker || now - this.heldTokensAt < FOMO_CHILD.heldTokensEveryMs) return;
    this.heldTokensAt = now;
    const keys = [...new Set(held.map((h) => lower(h.token)).filter((a) => EVM.test(a) && ![CASH.USDG, CASH.WETH].some((c) => c.toLowerCase() === a) && !isEnergyReserveToken(a)))]
      .slice(0, 200)
      .map(robinhoodKey);
    void broker.report({ kind: "held-tokens", tokenKeys: keys, atMs: now }).catch(() => {});
  }

  private reportFunnel(now: number): void {
    const broker = this.deps.broker();
    const funnel = this.deps.funnel;
    if (!broker || !funnel) return;
    const coins = new Set<string>(this.tracked.keys());
    try {
      for (const e of this.deps.earlyBook()?.active() ?? []) coins.add(lower(e.address));
    } catch {
      // the book's own failure is not the funnel's
    }
    let sent = 0;
    for (const a of coins) {
      if (sent >= FOMO_CHILD.funnelPerTick) break;
      const l = funnel.latest(a);
      if (!l || !FUNNEL_STAGES.has(l.stage)) continue;
      const sig = `${l.stage}|${l.detail}`;
      const prev = this.funnelSent.get(a);
      if (prev && (prev.sig === sig || now - prev.at < FOMO_CHILD.funnelMinGapMs)) continue;
      this.funnelSent.set(a, { sig, at: now });
      sent++;
      void broker
        .report({ kind: "funnel", tokenKey: robinhoodKey(a), stage: l.stage as FunnelStage, detail: l.detail, decisionId: l.decisionId, atMs: Math.floor(l.at) })
        .catch(() => {});
    }
    if (this.funnelSent.size > FOMO_CHILD.reportedMax) this.funnelSent.delete(this.funnelSent.keys().next().value as string);
  }

  private kickRefresh(input: FomoTickInput, live: FomoLiveFacts, now: number): void {
    if (this.refreshing) return;
    const mode = this.mode(live);
    const signalled = new Set((this.file?.signals ?? []).map((s) => lower(s.token.address)));
    const heldWithSignals = input.held.filter((h) => signalled.has(lower(h.token)));
    this.refreshing = (async () => {
      try {
        await this.ledger.refresh(mode, input.basis, now);
        const next = new Map<string, { entrySec: number | null; qtyRaw: bigint | null; cost6: bigint | null }>();
        for (const h of heldWithSignals.slice(0, 40)) {
          let b: { qtyRaw: bigint; costUsdg: bigint } | null = null;
          let entrySec: number | null = null;
          try {
            b = await input.basis(h.symbol);
          } catch {
            b = null;
          }
          try {
            entrySec = await input.entrySec(h.symbol);
          } catch {
            entrySec = null;
          }
          next.set(h.symbol, { entrySec, qtyRaw: b?.qtyRaw ?? null, cost6: b && b.qtyRaw > 0n ? b.costUsdg : null });
        }
        this.heldFacts = next;
      } catch {
        // the next pass tries again
      } finally {
        this.refreshing = null;
      }
    })();
  }

  // ── the entry gate (strategy intent loop) ──────────────────────────────

  /**
   * RIGHT BEFORE AN ENTRY IS SUBMITTED. A follow-nominated coin's entry is
   * revalidated against its assessment (fresh own quote within the 2% band,
   * permissions, rail, sponsorship, setup expiry, the ceiling NOW), claims
   * one of the day's follow entries and reserves its exploration headroom.
   * Any failure DROPS the entry and files why. Anything else passes through
   * untouched. It can only drop, never add, enlarge or route.
   */
  gateEntry(intent: { kind: string; sellToken?: string; buyToken?: string; notionalUsdg?: bigint; decisionId?: string }): FollowGate {
    let token = "";
    try {
      token = entryTokenOf(intent) ?? "";
      if (!token) return { kind: "none" };
      const open = this.followBook.nominated(token);
      const tracked = this.tracked.get(token);
      let earlyFollow = false;
      let early = false;
      try {
        const book = this.deps.earlyBook();
        earlyFollow = !!book?.active().some((e) => lower(e.address) === token && e.source === FOLLOW_SOURCE);
        early = book ? book.maxUsdgFor(token) !== null : false;
      } catch {
        earlyFollow = false;
      }
      if (!open && !tracked && !earlyFollow) {
        const size6 = typeof intent.notionalUsdg === "bigint" && intent.notionalUsdg > 0n ? intent.notionalUsdg : null;
        return early && size6 !== null ? { kind: "early", token, mode: this.mode(this.deps.live()), size6 } : { kind: "none" };
      }
      const now = this.now();
      const live = this.deps.live();
      const mode = this.mode(live);

      const drop = (reason: string): FollowGate => this.drop(token, reason, intent.decisionId);
      const a = tracked && (!open || open.assessmentId === tracked.assessment.id) ? tracked.assessment : null;
      if (!a || !open) return drop("nomination-lapsed");
      const quote = this.ownQuote(token, live);
      const sizing = this.ceilingFor(token, now, live);
      const r = revalidate(a, {
        now,
        quote,
        permissions: this.permissions(live, token),
        sizing,
        sponsorshipAvailable: live.rail === "live" ? live.sponsorship.available : true,
        sponsoredFlow: live.rail === "live" && live.sponsorship.sponsoredFlow === true,
      });
      if (!r.ok) return drop(r.reason);
      const size6 = typeof intent.notionalUsdg === "bigint" ? intent.notionalUsdg : null;
      if (size6 === null || size6 <= 0n) return drop("size-unknown");
      if (size6 > r.maxUsdg6) return drop("above-ceiling");
      if (size6 < sizing.floor6) return drop("size-below-floor");
      const claim = this.followBook.claimEntry(token);
      if (claim === "cap") return drop("follow-entry-cap");
      if (claim !== "taken") return drop("nomination-lapsed");
      const tokenKey = robinhoodKey(token);
      const reservationId = `follow:${intent.decisionId ?? `${tokenKey}:${now}`}:${++this.seq}`;
      if (!this.reservations.reserve(reservationId, tokenKey, size6, this.snapshot(token, now, live))) {
        this.followBook.refundEntry(token);
        return drop("exploration-exhausted");
      }
      return { kind: "follow", token, tokenKey, reservationId, size6, assessment: a, mode };
    } catch (e) {
      // Unanswerable is not "not a follow entry" when it was one: drop.
      if (token && (this.tracked.has(token) || this.safeNominated(token))) return this.drop(token, "gate-error", intent.decisionId);
      this.once(`gate:${e instanceof Error ? e.name : "error"}`, `[fomo] entry gate error (${e instanceof Error ? e.name : "error"})`);
      return { kind: "none" };
    }
  }

  private safeNominated(token: string): boolean {
    try {
      return this.followBook.nominated(token) !== null;
    } catch {
      return true;
    }
  }

  private snapshot(token: string, now: number, live: FomoLiveFacts): ReservationSnapshot {
    const f = this.ledger.figures(this.mode(live));
    return {
      asOf: now,
      enabled: live.settings.scoutEnabled === true,
      budget6: microUsdgFloor(live.settings.scoutBudgetUsdg),
      perToken6: microUsdgFloor(live.settings.scoutPerTokenUsdg),
      explorationHeldCost6: f.held6,
      realizedExplorationLoss6: f.loss6,
      tokenHeldCost6: f.tokenHeld6(token),
    };
  }

  private drop(token: string, reason: string, decisionId: string | undefined): FollowGate {
    const stage = followDropStage(reason);
    try {
      this.deps.funnel?.note(token, null, { stage, detail: `follow-${reason}`, decisionId: decisionId ?? null });
    } catch {
      // filing is best effort
    }
    try {
      // The nomination has its answer: this BUY will not become an order.
      if (decisionId) this.followBook.onFill(decisionId, "dropped", false);
    } catch {
      // the book's TTL answers it otherwise
    }
    this.log(`[fomo] follow entry dropped: ${reason}`);
    return { kind: "dropped", token, reason, stage };
  }

  /**
   * THE ENTRY'S OUTCOME. A fill (paper / landed / submitted) commits the
   * reservation, opens the exploration position and records the follow
   * dependency; anything else releases the reservation and refunds the day's
   * follow entry. Never throws.
   */
  settleEntry(gate: FollowGate | null | undefined, status: string | null | undefined, decisionId?: string | null): void {
    if (!gate || gate.kind === "none" || gate.kind === "dropped") return;
    try {
      const now = this.now();
      const filled = tradeConsumesSnapshot(status);
      const live = this.deps.live();
      const symbol = this.symbolOf(gate.token);
      if (gate.kind === "early") {
        if (filled && symbol) {
          this.ledger.open(gate.mode, this.newPosition(gate.token, symbol, "early", decisionId ?? null, null, now, gate.size6, status, null));
        }
        return;
      }
      if (!filled) {
        this.reservations.release(gate.reservationId);
        this.followBook.refundEntry(gate.token);
        if (decisionId) this.followBook.onFill(decisionId, status ?? "not-sent", live.rail === "paper");
        return;
      }
      if (decisionId) this.followBook.onFill(decisionId, status!, live.rail === "paper");
      const tracked = this.tracked.get(gate.token);
      if (symbol) {
        // Committed and opened together: from this moment the ledger counts the
        // cost, and the reservation counts only for snapshots older than it.
        this.reservations.commit(gate.reservationId, { at: now, amount6: gate.size6 });
        this.ledger.open(gate.mode, this.newPosition(gate.token, symbol, "follow", decisionId ?? null, gate.assessment, now, gate.size6, status, tracked ?? null));
      } else {
        // No ledger name to follow it by: the reservation stays PENDING, so its
        // cost keeps counting for the rest of this process — the safe side.
        this.once("ledger-no-symbol", "[fomo] a follow fill had no ledger symbol; its exploration cost stays reserved this session");
      }
      this.reportDependencies(gate.token, tracked ?? null, now);
    } catch (e) {
      this.once(`settle:${e instanceof Error ? e.name : "error"}`, `[fomo] follow entry settle error (${e instanceof Error ? e.name : "error"})`);
    }
  }

  private symbolOf(token: string): string | null {
    for (const h of this.held.values()) if (lower(h.token) === token) return h.symbol;
    try {
      return this.deps.symbolOf?.(token) ?? null;
    } catch {
      return null;
    }
  }

  private newPosition(
    token: string,
    symbol: string,
    source: "follow" | "early",
    decisionId: string | null,
    a: FollowAssessment | null,
    now: number,
    cost6: bigint,
    status: string | null | undefined,
    tracked: Tracked | null,
  ): ExplorationPosition {
    const horizon = a?.horizon ? HORIZON_MS[a.horizon] ?? null : null;
    return {
      symbol,
      token,
      source,
      decisionId,
      assessmentId: a?.id ?? null,
      openedAt: now,
      entryCost6: cost6,
      proceeds6: 0n,
      heldCost6: cost6,
      everHeld: status === "paper" || status === "landed",
      flatSince: null,
      setupExpiresAt: a?.setupExpiresAt ?? null,
      horizonEndsAt: horizon !== null ? now + horizon : null,
      strengthAtEntry: tracked?.strength ?? null,
      traders: [...new Set((tracked?.triggers ?? []).map((e) => lower(e.trader.userId)).filter(Boolean))].slice(0, FOMO_CHILD.dependencyMaxTraders),
    };
  }

  /** The triggering traders' activity keeps routing while the position is open (bounded, expiring). */
  private reportDependencies(token: string, tracked: Tracked | null, now: number): void {
    const broker = this.deps.broker();
    if (!broker || !tracked) return;
    const users = [...new Set(tracked.triggers.filter((e) => e.kind === "buy").map((e) => e.trader.userId).filter((u) => typeof u === "string" && u.length > 0))].slice(
      0,
      FOMO_CHILD.dependencyMaxTraders,
    );
    for (const userId of users) {
      void broker
        .report({ kind: "position-dependency", userId, tokenKey: robinhoodKey(token), reason: "follow-entry", expiresAtMs: now + FOMO_CHILD.dependencyTtlMs })
        .catch(() => {});
    }
  }

  /** A trade row this worker wrote (recordTrade): sales of an exploration coin feed its realised loss. */
  noteTradeRow(row: { status: string; fill_side?: string; sell_token?: string; fill_cash_usdg?: number }): void {
    try {
      if ((row.status !== "landed" && row.status !== "paper") || row.fill_side !== "sell") return;
      const token = lower(row.sell_token);
      if (!EVM.test(token)) return;
      const cash = typeof row.fill_cash_usdg === "number" && Number.isFinite(row.fill_cash_usdg) && row.fill_cash_usdg >= 0 ? BigInt(Math.floor(row.fill_cash_usdg * 1e6)) : null;
      this.ledger.noteSell(row.status === "paper" ? "paper" : "live", token, cash);
    } catch {
      // the next basis read still closes the position; unknown proceeds count as zero
    }
  }

  // ── Brain review hooks ─────────────────────────────────────────────────

  /**
   * THE TRADER-FLOW LENS, when there is one to send and Brain accepts it.
   * Set AFTER the Trencher signals so nothing overwrites it. Never a lens with
   * anything address-shaped or vendor-named in it. Returns whether it was set.
   */
  attachLens(signals: Record<string, string>, token: string, brainUrl: string | null | undefined): boolean {
    try {
      if (!this.file || !this.access.dataAccess || !(this.access.monitoring || this.access.follow)) return false;
      const a = lower(token);
      const s = this.file.signals.find((x) => isRobinhoodToken(x.token) && lower(x.token.address) === a);
      if (!s || !s.lens) return false;
      if (ADDRESSY.test(s.lens) || VENDOR.test(s.lens)) return false;
      if (!this.lensProbe.advertises(brainUrl)) return false;
      signals[TRADER_FLOW_LENS] = s.lens;
      this.lensSent.set(a, {
        at: this.now(),
        refs: [...s.lensRefs],
        dossierRevision: s.dossier ? { dossierId: s.dossier.dossierId, revision: s.dossier.revision } : null,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A TRENCHER REVIEW FINISHED (trenchBrain.onReviewed). Held: its sooner
   * review is answered. Not held: the follow book hears the decision. And when
   * a lens went out, the citations are checked against the refs that were
   * sent: one Brain was never sent is recorded as UNVERIFIED, never evidence.
   */
  onReviewed(r: { token: string; held: boolean; outcome: ShadowOutcome }): void {
    try {
      const a = lower(r.token);
      const ok = r.outcome.ran && r.outcome.result.ok ? r.outcome.result.decision : null;
      if (r.held) {
        if (r.outcome.ran) {
          this.followBook.clearHeldReview(a);
        }
      } else if (ok) {
        const action = ok.action === "buy" || ok.action === "sell" || ok.action === "hold" ? ok.action : "hold";
        this.followBook.onReviewed(a, { action, decisionId: typeof ok.decision_id === "string" ? ok.decision_id : null });
      }
      const sent = this.lensSent.get(a);
      if (sent && ok) {
        this.lensSent.delete(a);
        if (this.now() - sent.at <= FOMO_CHILD.lensSentTtlMs) this.traceCitations(a, ok, sent);
      }
    } catch {
      // a review report never breaks a review
    }
  }

  private traceCitations(
    token: string,
    d: { decision_id: string; thesis?: string; bull_case?: string; bear_case?: string; evidence?: { ref?: string; claim?: string }[] },
    sent: { refs: string[]; dossierRevision: { dossierId: string; revision: number } | null },
  ): void {
    const texts: string[] = [d.thesis ?? "", d.bull_case ?? "", d.bear_case ?? ""];
    for (const e of Array.isArray(d.evidence) ? d.evidence : []) texts.push(String(e?.ref ?? ""), String(e?.claim ?? ""));
    const cited = [...new Set(texts.flatMap((t) => (typeof t === "string" ? t.match(REF) ?? [] : [])))].slice(0, 40);
    const allowed = new Set(sent.refs);
    const trace: LensTrace = {
      at: this.now(),
      decisionId: String(d.decision_id).slice(0, 96),
      token,
      dossierRevision: sent.dossierRevision,
      refsSent: [...sent.refs],
      cited,
      unverified: cited.filter((c) => !allowed.has(c)),
    };
    this.traces.push(trace);
    if (this.traces.length > FOMO_CHILD.lensTraceMax) this.traces.shift();
    this.log(`[fomo] trader-flow lens: ${trace.refsSent.length} ref(s) sent, ${cited.length} cited, ${trace.unverified.length} unverified`);
  }

  /** Recent lens traces (decision → dossier revision, refs sent, cited, unverified). Copies. */
  lensTraces(): LensTrace[] {
    return this.traces.map((t) => ({ ...t, refsSent: [...t.refsSent], cited: [...t.cited], unverified: [...t.unverified] }));
  }

  // ── status ─────────────────────────────────────────────────────────────

  latestAssessment(tokenKey: string): FollowAssessment | null {
    return this.assessments.get(tokenKey) ?? null;
  }

  health(): FomoChildHealth {
    const f = this.file;
    let configured: boolean | null = null;
    try {
      configured = this.deps.broker()?.configured() ?? null;
    } catch {
      configured = null;
    }
    let heldReviews = 0;
    try {
      heldReviews = this.followBook.heldReviewRequests().length;
    } catch {
      heldReviews = 0;
    }
    return {
      at: this.lastTickAt,
      read: this.fileReason,
      state: f?.health.state ?? null,
      detail: f?.health.detail ?? null,
      cohortSize: f?.health.cohortSize ?? null,
      cohortTarget: f?.health.cohortTarget ?? null,
      lastEventAt: f?.health.lastEventAt ?? null,
      signals: f?.signals.length ?? 0,
      access: { ...this.access },
      followNominations: this.tracked.size,
      heldReviews,
      brokerConfigured: configured,
    };
  }

  private once(key: string, line: string): void {
    if (this.logged.has(key)) return;
    if (this.logged.size > 100) this.logged.clear();
    this.logged.add(key);
    this.log(line);
  }
}

function scoutKey(s: FomoChildSettings): string {
  return `${s.scoutEnabled === true}:${microUsdgFloor(s.scoutBudgetUsdg) ?? "?"}:${microUsdgFloor(s.scoutPerTokenUsdg) ?? "?"}`;
}

function zeroCeiling(): EntryCeiling {
  return { ceiling6: 0n, binding: "not-executable", parts: {}, economic: "below-floor", floor6: FOMO_CHILD.minEconomic6, reason: "not an executable chain" };
}

// ─── Process-wide accessor (status surfaces) ───────────────────────────────

let installed: FomoChild | null = null;

/** index.ts main() installs this process's child; status surfaces read health through it. */
export function installFomoChild(c: FomoChild | null): void {
  installed = c;
}

export function fomoChild(): FomoChild | null {
  return installed;
}
