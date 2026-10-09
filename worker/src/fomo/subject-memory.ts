/**
 * CONVERSATION SUBJECT MEMORY — what "it", "this coin" and "that trader" mean
 * in a Fomo research conversation, per conversation, as plain JSON.
 *
 * Every chat surface (app chat, Telegram DM, Telegram groups) keeps one of
 * these per conversation and hands it to the planner (intent.ts). The planner
 * reads it; only this module writes it, in two steps that bracket a lookup:
 *
 *   applyPlan    BEFORE the lookup. Records what the user asked about: a
 *                correction replaces the subject, a new explicit subject
 *                replaces it, a follow-up with no subject inherits it. The
 *                window is inherited only when the planner said so.
 *   applyResult  AFTER a successful lookup. Swaps what the user TYPED for
 *                what the provider RESOLVED: token key, address and chain,
 *                trader user id and handle.
 *
 * WHY THE RESOLVED IDENTITY IS WHAT GETS REMEMBERED. A ticker is not an
 * identity (identity.ts rule 1). If memory kept "PEPE", the follow-up "what
 * about the sellers?" would re-resolve PEPE and could land on a different
 * coin with the same ticker on another chain, so the user would get sellers
 * of a coin they never asked about with no sign that anything changed. Once
 * a lookup has resolved the coin, follow-ups carry its address and chain and
 * nothing is resolved again.
 *
 * WHY MEMORY EXPIRES. After thirty minutes "it" is a guess. A stale memory is
 * never used to fill in a subject, window or side; the planner asks one
 * question instead. Stale memory still tells the planner the conversation
 * WAS about Fomo, which is what lets it ask rather than ignore the message.
 *
 * WHAT IS NEVER IN HERE: a tenant, a credential, provider text, a thesis, a
 * price or any money figure (a remembered trader board holds ranks, user ids
 * and public handles only). Symbols and handles are display labels, are
 * sanitised and length-capped, and are never read back as instructions. The
 * serialised form is validated strictly on the way in, because it comes back
 * from a store that another process (or a bug) may have written.
 */

import { sanitizeText } from "../research/news";
import { IDENTITY_GUARDS, tokenFromKey } from "./identity";
import type { FomoQuestionPlan } from "./intent";
import type { ResolvedSubject, SubjectQuery } from "./types";

// ── Vocabulary shared with the planner ──────────────────────────────────
// Kept here rather than in intent.ts so validation can use them without a
// runtime import cycle: intent.ts imports this module, never the reverse.

export const FOMO_INTENTS = [
  "trader-holdings",
  "trader-activity",
  "trader-context",
  "token-theses",
  "token-sellers",
  "token-buyers",
  "token-activity",
  "words-vs-actions",
  "rankings-traders",
  "rankings-tokens",
  "opportunities",
  "compare-theses",
  "changes-since",
  "why-skipped",
  "research-coin",
  "research-status",
  "health",
  "watch",
  "unwatch",
  // What it can do with Fomo: answered from a fixed list (fomo/chat.ts), never remembered.
  "capabilities",
] as const;
export type FomoIntent = (typeof FOMO_INTENTS)[number];

export const PLAN_WINDOWS = ["1h", "24h", "7d", "30d", "all"] as const;
export type PlanWindow = (typeof PLAN_WINDOWS)[number];

export const PLAN_SIDES = ["buy", "sell", "all"] as const;
export type PlanSide = (typeof PLAN_SIDES)[number];

/**
 * How many subjects of each kind an intent consumes. A compare takes two
 * coins; everything else takes at most one of each. Used by the planner and
 * by applyPlan through the same function, so both agree on what was resolved.
 */
export const SUBJECT_SLOTS: Readonly<Record<FomoIntent, { token: number; trader: number }>> = {
  "trader-holdings": { token: 0, trader: 1 },
  "trader-activity": { token: 1, trader: 1 },
  "trader-context": { token: 0, trader: 1 },
  "token-theses": { token: 1, trader: 1 },
  "token-sellers": { token: 1, trader: 0 },
  "token-buyers": { token: 1, trader: 0 },
  "token-activity": { token: 1, trader: 0 },
  "words-vs-actions": { token: 1, trader: 1 },
  "rankings-traders": { token: 0, trader: 0 },
  "rankings-tokens": { token: 0, trader: 0 },
  opportunities: { token: 0, trader: 0 },
  "compare-theses": { token: 2, trader: 0 },
  "changes-since": { token: 1, trader: 0 },
  "why-skipped": { token: 1, trader: 0 },
  "research-coin": { token: 1, trader: 0 },
  "research-status": { token: 1, trader: 0 },
  health: { token: 0, trader: 0 },
  watch: { token: 1, trader: 0 },
  unwatch: { token: 1, trader: 0 },
  capabilities: { token: 0, trader: 0 },
};

// ── The memory ───────────────────────────────────────────────────────────

export type StoredSubject =
  | { kind: "token"; tokenKey?: string; address?: string; chain?: string | null; symbol?: string | null }
  | { kind: "trader"; userId?: string; handle?: string | null };

export interface SubjectMemory {
  version: 1;
  subjects: StoredSubject[];
  window: PlanWindow | null;
  side: PlanSide | null;
  lastIntent: FomoIntent | null;
  /** The dossier revision the last research answer was built from, for "what changed since". */
  dossierRevision: { dossierId: string; revision: number } | null;
  lastRequestId: string | null;
  updatedAt: number;
  /** User turns planned in this conversation. */
  turn: number;
  /**
   * THE TRADER BOARD THIS CONVERSATION WAS LAST SHOWN, so "the second one",
   * "#3" and "that guy" mean its rows (intent.ts rowRefOf). Only Fomo's
   * public board, never one cut to Merrymen's watched traders. Absent when
   * none; dropped by any question that is not about the board or one trader.
   */
  board?: BoardMemory;
}

/** What a question about one row asked last, so a bare "and #2?" asks the same of that row. */
export type BoardRowAbout = "earnings" | "trades" | "holdings" | "profile";

export interface BoardMemory {
  /** The board's window. */
  window: PlanWindow | null;
  /** Asked in the singular ("who's the best trader"): a bare "he" is its 1st row. */
  singular: boolean;
  /** What the last question about one of its rows asked; null before any. */
  about: BoardRowAbout | null;
  /** When it was answered: older than MEMORY_TTL_MS, it is no one's "the second one". */
  at: number;
  /** Its rows by rank, at most MAX_BOARD_ROWS: the provider's user id and public handle. */
  rows: BoardRow[];
}

export interface BoardRow {
  rank: number;
  userId: string;
  handle: string | null;
}

/** The most board rows remembered (the owner sees ten; a room four). */
export const MAX_BOARD_ROWS = 10;

/** Older than this, memory names a topic but never fills in a subject. */
export const MEMORY_TTL_MS = 30 * 60_000;
/** A little clock skew between processes is tolerated; a memory from the far future is not. */
const FUTURE_SKEW_MS = 60_000;
export const MAX_STORED_SUBJECTS = 4;
export const MAX_SERIALIZED_LENGTH = 8_192;

const HANDLE = /^[A-Za-z0-9_]{1,30}$/;
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const OPAQUE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SLUG = /^[a-z][a-z0-9-]{0,23}$/;
const SYMBOL_MAX = 24;
const { EVM_ADDRESS, SOLANA_MINT } = IDENTITY_GUARDS;

export function emptyMemory(now: number): SubjectMemory {
  return {
    version: 1,
    subjects: [],
    window: null,
    side: null,
    lastIntent: null,
    dossierRevision: null,
    lastRequestId: null,
    updatedAt: now,
    turn: 0,
  };
}

/** True when the memory may fill in a subject, window or side for this turn. */
export function isMemoryUsable(memory: SubjectMemory | null | undefined, now: number): memory is SubjectMemory {
  if (!memory) return false;
  const age = now - memory.updatedAt;
  return age >= -FUTURE_SKEW_MS && age <= MEMORY_TTL_MS;
}

/** The trader board "the second one" may refer to: fresh, in a usable memory, or null. */
export function rememberedBoard(memory: SubjectMemory | null | undefined, now: number): BoardMemory | null {
  if (!isMemoryUsable(memory, now) || !memory.board) return null;
  const age = now - memory.board.at;
  return age >= -FUTURE_SKEW_MS && age <= MEMORY_TTL_MS && memory.board.rows.length > 0 ? memory.board : null;
}

/** Intents that keep the board: the board itself, and one trader (a row of it, or another). */
const BOARD_INTENTS: ReadonlySet<FomoIntent> = new Set(["rankings-traders", "trader-holdings", "trader-activity", "trader-context"]);

/** What a one-trader plan asked, in board-row words; null for anything else. */
function rowAboutOf(plan: FomoQuestionPlan): BoardRowAbout | null {
  if (plan.rowAsk) return plan.rowAsk.about;
  if (plan.intent === "trader-holdings") return "holdings";
  if (plan.intent === "trader-activity") return plan.earnings === true ? "earnings" : "trades";
  if (plan.intent === "trader-context") return "profile";
  return null;
}

/**
 * Remembered subjects of one kind, as queries the tools accept. Empty when
 * the memory is stale: a stale "it" is never silently resolved.
 *
 * A token resolved by a lookup comes back as its address and the chain slug
 * it resolved on, so a follow-up names the same coin on the same chain.
 */
export function rememberedSubjects(memory: SubjectMemory | null | undefined, kind: "token" | "trader", now: number): SubjectQuery[] {
  if (!isMemoryUsable(memory, now)) return [];
  const out: SubjectQuery[] = [];
  for (const s of memory.subjects) {
    if (s.kind !== kind) continue;
    const q = toQuery(s);
    if (q) out.push(q);
  }
  return out;
}

function toQuery(s: StoredSubject): SubjectQuery | null {
  if (s.kind === "trader") {
    const q: { kind: "trader"; userId?: string; handle?: string } = { kind: "trader" };
    if (s.userId) q.userId = s.userId;
    if (s.handle) q.handle = s.handle;
    return q.userId || q.handle ? q : null;
  }
  const q: { kind: "token"; address?: string; chain?: string; symbol?: string } = { kind: "token" };
  const resolved = s.tokenKey ? tokenFromKey(s.tokenKey) : null;
  if (resolved) {
    q.address = resolved.address;
    const chain = resolved.chain.slug ?? s.chain ?? null;
    if (chain) q.chain = chain;
  } else {
    if (s.address) q.address = s.address;
    if (s.chain) q.chain = s.chain;
  }
  if (s.symbol) q.symbol = s.symbol;
  return q.address || q.symbol ? q : null;
}

/** Same subject, compared on what identifies it (address over symbol, user id over handle). */
export function sameSubject(a: SubjectQuery, b: SubjectQuery): boolean {
  if (a.kind === "token" && b.kind === "token") {
    if (a.address && b.address) {
      if (normAddress(a.address) !== normAddress(b.address)) return false;
      return !a.chain || !b.chain || a.chain === b.chain;
    }
    if (a.address || b.address) return false;
    return !!a.symbol && !!b.symbol && a.symbol.toUpperCase() === b.symbol.toUpperCase() && (!a.chain || !b.chain || a.chain === b.chain);
  }
  if (a.kind === "trader" && b.kind === "trader") {
    if (a.userId && b.userId) return a.userId.toLowerCase() === b.userId.toLowerCase();
    return !!a.handle && !!b.handle && a.handle.toLowerCase() === b.handle.toLowerCase();
  }
  return false;
}

function normAddress(a: string): string {
  // EVM hex is case-insensitive; a Solana mint is not and keeps its case.
  return EVM_ADDRESS.test(a) ? a.toLowerCase() : a;
}

/**
 * The subjects a plan is about: this message's explicit ones, plus remembered
 * ones of each kind the plan says it took from memory, capped by the intent's
 * slots. The planner builds its tool calls from exactly this list and
 * applyPlan returns exactly this list, so the two cannot disagree.
 */
export function mergeResolved(
  explicit: readonly SubjectQuery[],
  memory: SubjectMemory | null | undefined,
  usesMemory: readonly string[],
  intent: FomoIntent,
  now: number,
): SubjectQuery[] {
  const slots = SUBJECT_SLOTS[intent];
  const out: SubjectQuery[] = [];
  for (const kind of ["token", "trader"] as const) {
    const cap = slots[kind];
    if (cap === 0) continue;
    const mine = explicit.filter((s) => s.kind === kind);
    const picked: SubjectQuery[] = [...mine];
    if (usesMemory.includes(kind)) {
      for (const r of rememberedSubjects(memory, kind, now)) {
        if (picked.length >= cap) break;
        if (!picked.some((p) => sameSubject(p, r))) picked.push(r);
      }
    }
    out.push(...picked.slice(0, cap));
  }
  return out;
}

// ── Before the lookup ────────────────────────────────────────────────────

/**
 * Record a planned question. Returns the new memory and the subjects the
 * lookup should use (empty when the plan is a clarification: nothing is
 * looked up until the user answers).
 *
 * Pass the same memory the planner saw; the plan's `usesMemory` and `window`
 * were computed against it.
 */
export function applyPlan(
  memory: SubjectMemory | null,
  plan: FomoQuestionPlan,
  now: number,
): { memory: SubjectMemory; resolved: SubjectQuery[] } {
  const priorTurn = memory?.turn ?? 0;
  const usable = isMemoryUsable(memory, now);
  // A stale memory contributes nothing but its turn count. Refreshing its
  // timestamp while keeping its subjects would make an hour-old "it" usable again.
  const base: SubjectMemory = usable ? memory : { ...emptyMemory(now), turn: priorTurn };

  const explicit = plan.subjects.filter((s): s is Exclude<SubjectQuery, { kind: "market" }> => s.kind !== "market");
  let subjects: StoredSubject[];
  if (explicit.length > 0) {
    const kinds = new Set(explicit.map((s) => s.kind));
    const stated = explicit.map((q) => storedFromQuery(q, base.subjects));
    // Other kinds survive only when this turn actually used them.
    const carried = base.subjects.filter((s) => !kinds.has(s.kind) && plan.usesMemory.includes(s.kind));
    subjects = [...stated, ...carried];
  } else if (plan.correction) {
    // "Wrong coin" with no replacement: the old subject is known to be wrong,
    // so it must not answer the next "it".
    subjects = [];
  } else {
    subjects = base.subjects;
  }
  subjects = dedupeStored(subjects).slice(0, MAX_STORED_SUBJECTS);

  const tokensBefore = tokenSignature(base.subjects);
  const tokensAfter = tokenSignature(subjects);
  // The board stays only while the conversation is about it or one trader;
  // a new board replaces it once that board has answered (applyResult).
  const board = usable && base.board && BOARD_INTENTS.has(plan.intent) && plan.intent !== "rankings-traders"
    ? { ...base.board, rows: base.board.rows.map((r) => ({ ...r })), about: rowAboutOf(plan) ?? base.board.about }
    : null;
  const next: SubjectMemory = {
    version: 1,
    subjects,
    window: plan.window,
    side: plan.side,
    lastIntent: plan.intent,
    // A revision belongs to one coin. A different coin starts with none.
    dossierRevision: tokensBefore === tokensAfter ? base.dossierRevision : null,
    lastRequestId: base.lastRequestId,
    updatedAt: now,
    turn: base.turn + 1,
    ...(board ? { board } : {}),
  };
  const resolved = plan.clarification ? [] : mergeResolved(explicit, usable ? memory : null, plan.usesMemory, plan.intent, now);
  return { memory: next, resolved };
}

/**
 * A typed subject becomes a stored one. When the user restates a coin or
 * trader that memory already resolved, the resolved form is kept, so saying
 * "0xabc" again does not throw away the chain a lookup established.
 */
function storedFromQuery(q: Exclude<SubjectQuery, { kind: "market" }>, existing: readonly StoredSubject[]): StoredSubject {
  for (const s of existing) {
    const prior = toQuery(s);
    if (!prior || !sameSubject(prior, q)) continue;
    // A typed symbol never adopts a remembered address on its own say-so: same
    // ticker is not same coin. Only a restated address (or handle) keeps the resolution.
    if (q.kind === "token" && prior.kind === "token" && !!q.address !== !!prior.address) continue;
    // The user has now said which chain a still-unplaced coin is on ("PEPE on
    // base", or "on base" in answer to "which one?"). Keeping the chain-less
    // entry would make the next "it" ask the same question again whenever
    // this lookup does not complete. A resolved coin (tokenKey) keeps its own.
    if (s.kind === "token" && q.kind === "token" && !s.tokenKey && !s.chain && q.chain && SLUG.test(q.chain)) {
      return { ...s, chain: q.chain };
    }
    return s;
  }
  if (q.kind === "trader") {
    const t: StoredSubject = { kind: "trader" };
    if (q.userId && USER_ID.test(q.userId)) t.userId = q.userId;
    if (q.handle && HANDLE.test(q.handle)) t.handle = q.handle;
    return t;
  }
  const t: { kind: "token"; address?: string; chain?: string | null; symbol?: string | null } = { kind: "token" };
  if (q.address && (EVM_ADDRESS.test(q.address) || SOLANA_MINT.test(q.address))) t.address = normAddress(q.address);
  t.chain = q.chain && SLUG.test(q.chain) ? q.chain : null;
  t.symbol = q.symbol ? cleanSymbol(q.symbol) : null;
  return t;
}

// ── After the lookup ─────────────────────────────────────────────────────

export interface LookupSummary {
  /** What the lookup resolved. Market subjects are ignored. */
  subjects: ResolvedSubject[];
  /** The dossier revision the answer used; null or absent keeps the remembered one for the same coin. */
  dossierRevision?: { dossierId: string; revision: number } | null;
  requestId: string;
  /** A public trader board that answered (fomo/chat.ts): its rows become "the second one". */
  board?: BoardMemory | null;
}

/**
 * Record what a successful lookup resolved. Each kind the lookup resolved
 * replaces that kind in memory; kinds it did not touch are kept (a trader
 * lookup filtered to a coin leaves the coin remembered).
 */
export function applyResult(memory: SubjectMemory | null, summary: LookupSummary, now: number): SubjectMemory {
  const base = memory ?? emptyMemory(now);
  const tokens: StoredSubject[] = [];
  const traders: StoredSubject[] = [];
  for (const s of summary.subjects) {
    if (s.kind === "token") {
      const t = storedFromResolved(s);
      if (t) tokens.push(t);
    } else if (s.kind === "trader") {
      const t: StoredSubject = { kind: "trader" };
      if (USER_ID.test(s.trader.userId)) t.userId = s.trader.userId;
      if (s.trader.handle) {
        const h = s.trader.handle.replace(/^@/, "");
        if (HANDLE.test(h)) t.handle = h;
      }
      if (t.userId || t.handle) traders.push(t);
    }
  }
  let subjects = base.subjects;
  if (tokens.length) subjects = [...tokens, ...subjects.filter((s) => s.kind !== "token")];
  if (traders.length) subjects = [...subjects.filter((s) => s.kind !== "trader"), ...traders];
  subjects = dedupeStored(subjects).slice(0, MAX_STORED_SUBJECTS);

  const given = validRevision(summary.dossierRevision);
  const sameTokens = tokenSignature(base.subjects) === tokenSignature(subjects);
  const board = summary.board ? validBoard(summary.board) : null;
  return {
    ...base,
    subjects,
    dossierRevision: given ?? (sameTokens ? base.dossierRevision : null),
    lastRequestId: typeof summary.requestId === "string" && OPAQUE_ID.test(summary.requestId) ? summary.requestId : base.lastRequestId,
    updatedAt: now,
    ...(board ? { board } : {}),
  };
}

/**
 * A board as this module would store it, or null: rows with a valid rank
 * (1..MAX_BOARD_ROWS, each once), a provider user id and a handle that is one
 * (else none), at most MAX_BOARD_ROWS of them. Read back from a store, a
 * tampered row is dropped, never trusted.
 */
function validBoard(b: unknown): BoardMemory | null {
  if (!isPlainObject(b) || !onlyKeys(b, ["window", "singular", "about", "at", "rows"])) return null;
  const window = b.window === null ? null : (PLAN_WINDOWS as readonly unknown[]).includes(b.window) ? (b.window as PlanWindow) : undefined;
  if (window === undefined || typeof b.singular !== "boolean") return null;
  const about = b.about === null || b.about === undefined ? null : ROW_ABOUTS.includes(b.about as BoardRowAbout) ? (b.about as BoardRowAbout) : undefined;
  if (about === undefined) return null;
  if (typeof b.at !== "number" || !Number.isSafeInteger(b.at) || b.at < 0) return null;
  if (!Array.isArray(b.rows)) return null;
  const rows: BoardRow[] = [];
  for (const r of b.rows.slice(0, MAX_BOARD_ROWS * 2)) {
    if (!isPlainObject(r) || !onlyKeys(r, ["rank", "userId", "handle"])) continue;
    if (typeof r.rank !== "number" || !Number.isSafeInteger(r.rank) || r.rank < 1 || r.rank > MAX_BOARD_ROWS || rows.some((x) => x.rank === r.rank)) continue;
    if (typeof r.userId !== "string" || !USER_ID.test(r.userId)) continue;
    const handle = typeof r.handle === "string" && HANDLE.test(r.handle.replace(/^@/, "")) ? r.handle.replace(/^@/, "") : null;
    rows.push({ rank: r.rank, userId: r.userId, handle });
    if (rows.length >= MAX_BOARD_ROWS) break;
  }
  return rows.length ? { window, singular: b.singular, about, at: b.at, rows } : null;
}

const ROW_ABOUTS: readonly BoardRowAbout[] = ["earnings", "trades", "holdings", "profile"];

function storedFromResolved(s: Extract<ResolvedSubject, { kind: "token" }>): StoredSubject | null {
  // Only a key this codebase would write is kept; anything else is not an identity.
  const t = tokenFromKey(s.token.key);
  if (!t) return null;
  const chain = s.token.chain.slug && SLUG.test(s.token.chain.slug) ? s.token.chain.slug : t.chain.slug;
  return { kind: "token", tokenKey: t.key, address: t.address, chain: chain ?? null, symbol: cleanSymbol(s.label.symbol) };
}

/** Provider symbols are untrusted display text: sanitised, capped, never identity. */
function cleanSymbol(raw: unknown): string | null {
  const s = sanitizeText(raw, SYMBOL_MAX).replace(/^\$/, "");
  return s ? s : null;
}

function validRevision(r: unknown): { dossierId: string; revision: number } | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  if (typeof o.dossierId !== "string" || !OPAQUE_ID.test(o.dossierId)) return null;
  if (typeof o.revision !== "number" || !Number.isSafeInteger(o.revision) || o.revision < 0) return null;
  return { dossierId: o.dossierId, revision: o.revision };
}

/**
 * A comparable fingerprint of the remembered coins: the resolved key when
 * there is one, so the same hex on another network is a different coin and
 * its dossier revision does not carry over.
 */
function tokenSignature(subjects: readonly StoredSubject[]): string {
  return subjects
    .filter((s): s is Extract<StoredSubject, { kind: "token" }> => s.kind === "token")
    .map((s) => s.tokenKey ?? (s.address ? `addr:${normAddress(s.address)}` : `sym:${(s.symbol ?? "").toUpperCase()}`))
    .sort()
    .join("|");
}

function dedupeStored(subjects: readonly StoredSubject[]): StoredSubject[] {
  const out: StoredSubject[] = [];
  const queries: SubjectQuery[] = [];
  for (const s of subjects) {
    const q = toQuery(s);
    if (!q) continue;
    if (queries.some((p) => sameSubject(p, q))) continue;
    queries.push(q);
    out.push(s);
  }
  return out;
}

// ── Persistence ──────────────────────────────────────────────────────────

export function serialize(memory: SubjectMemory): string {
  // Re-validated on the way out too, so a memory built by hand elsewhere
  // cannot persist something deserialize would later refuse.
  const clean = deserialize(memory);
  return JSON.stringify(clean ?? emptyMemory(Number.isFinite(memory?.updatedAt) ? memory.updatedAt : 0));
}

/**
 * Strict: anything that is not exactly a memory this module would write is
 * null, never a partially trusted object. Unknown keys are refused rather
 * than carried, so the stored shape stays bounded.
 */
export function deserialize(json: unknown): SubjectMemory | null {
  let raw: unknown = json;
  if (typeof json === "string") {
    if (json.length > MAX_SERIALIZED_LENGTH) return null;
    try {
      raw = JSON.parse(json);
    } catch {
      return null;
    }
  }
  if (!isPlainObject(raw)) return null;
  if (!onlyKeys(raw, ["version", "subjects", "window", "side", "lastIntent", "dossierRevision", "lastRequestId", "updatedAt", "turn", "board"])) return null;
  if (raw.version !== 1) return null;
  if (!Array.isArray(raw.subjects) || raw.subjects.length > MAX_STORED_SUBJECTS) return null;
  const subjects: StoredSubject[] = [];
  for (const s of raw.subjects) {
    const v = validStored(s);
    if (!v) return null;
    subjects.push(v);
  }
  const window = raw.window === null ? null : (PLAN_WINDOWS as readonly unknown[]).includes(raw.window) ? (raw.window as PlanWindow) : undefined;
  const side = raw.side === null ? null : (PLAN_SIDES as readonly unknown[]).includes(raw.side) ? (raw.side as PlanSide) : undefined;
  const lastIntent = raw.lastIntent === null ? null : (FOMO_INTENTS as readonly unknown[]).includes(raw.lastIntent) ? (raw.lastIntent as FomoIntent) : undefined;
  if (window === undefined || side === undefined || lastIntent === undefined) return null;
  let dossierRevision: SubjectMemory["dossierRevision"] = null;
  if (raw.dossierRevision !== null) {
    if (!isPlainObject(raw.dossierRevision) || !onlyKeys(raw.dossierRevision, ["dossierId", "revision"])) return null;
    dossierRevision = validRevision(raw.dossierRevision);
    if (!dossierRevision) return null;
  }
  const lastRequestId = raw.lastRequestId === null ? null : typeof raw.lastRequestId === "string" && OPAQUE_ID.test(raw.lastRequestId) ? raw.lastRequestId : undefined;
  if (lastRequestId === undefined) return null;
  if (typeof raw.updatedAt !== "number" || !Number.isSafeInteger(raw.updatedAt) || raw.updatedAt < 0) return null;
  if (typeof raw.turn !== "number" || !Number.isSafeInteger(raw.turn) || raw.turn < 0) return null;
  // A board that is not one this module would write is dropped; the rest of the memory stands.
  const board = raw.board === undefined ? null : validBoard(raw.board);
  return { version: 1, subjects, window, side, lastIntent, dossierRevision, lastRequestId, updatedAt: raw.updatedAt, turn: raw.turn, ...(board ? { board } : {}) };
}

function validStored(s: unknown): StoredSubject | null {
  if (!isPlainObject(s)) return null;
  if (s.kind === "trader") {
    if (!onlyKeys(s, ["kind", "userId", "handle"])) return null;
    const t: StoredSubject = { kind: "trader" };
    if (s.userId !== undefined) {
      if (typeof s.userId !== "string" || !USER_ID.test(s.userId)) return null;
      t.userId = s.userId;
    }
    if (s.handle !== undefined && s.handle !== null) {
      if (typeof s.handle !== "string" || !HANDLE.test(s.handle)) return null;
      t.handle = s.handle;
    } else if (s.handle === null) t.handle = null;
    return t.userId || t.handle ? t : null;
  }
  if (s.kind === "token") {
    if (!onlyKeys(s, ["kind", "tokenKey", "address", "chain", "symbol"])) return null;
    const t: { kind: "token"; tokenKey?: string; address?: string; chain?: string | null; symbol?: string | null } = { kind: "token" };
    if (s.tokenKey !== undefined) {
      if (typeof s.tokenKey !== "string" || s.tokenKey.length > 160) return null;
      const id = tokenFromKey(s.tokenKey);
      if (!id) return null;
      t.tokenKey = id.key;
      // A key and an address that disagree are two claims about identity; neither is trusted.
      if (s.address !== undefined && s.address !== id.address) return null;
    }
    if (s.address !== undefined) {
      if (typeof s.address !== "string" || !(EVM_ADDRESS.test(s.address) || SOLANA_MINT.test(s.address))) return null;
      if (EVM_ADDRESS.test(s.address) && s.address !== s.address.toLowerCase()) return null;
      t.address = s.address;
    }
    if (s.chain !== undefined) {
      if (s.chain !== null && (typeof s.chain !== "string" || !SLUG.test(s.chain))) return null;
      t.chain = s.chain;
    }
    if (s.symbol !== undefined) {
      if (s.symbol !== null && (typeof s.symbol !== "string" || !s.symbol || cleanSymbol(s.symbol) !== s.symbol)) return null;
      t.symbol = s.symbol;
    }
    return t.tokenKey || t.address || t.symbol ? t : null;
  }
  return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(o).every((k) => allowed.includes(k));
}
