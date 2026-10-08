/**
 * THE SHARED FOMO CHAT PIPELINE — one function every chat surface calls
 * (app chat, Telegram DM, Telegram groups) so a question is planned, looked
 * up, remembered and answered the same way everywhere.
 *
 * THE WIRING SEQUENCE (intent.ts / subject-memory.ts), in order:
 *
 *   1. memory  = deserialize(broker.memory.get(conversation))
 *   2. plan    = classifyFomoQuestion(text, { memory, now })
 *                null → not a Fomo question: { handled: false }, and the
 *                surface's existing handlers answer it
 *   3. applyPlan → persist (a correction replaces the subject NOW, before any
 *      lookup, so a failed lookup can never leave the wrong coin as "it")
 *   4. a clarification is replied verbatim, with no tool call
 *   5. the plan's tool calls run through the broker, in order, at most four,
 *      at interactive priority; mutations are dropped for a group, and a group
 *      question about a trader is deflected to a DM before anything is spent
 *   6. applyResult from the envelopes that actually answered → persist
 *   7. analysis asked for (and not "just the facts") and a composer given →
 *      the composer writes from fenced evidence under FOMO_CHAT_RULES;
 *      otherwise, or when it returns nothing or throws, the deterministic
 *      renderAnswer text
 *
 * WHAT THE TEXT CAN NEVER DO. The message is data. It reaches the planner,
 * which can only emit registered read tools with closed-vocabulary arguments;
 * nothing in it can add a call, name a tenant or reach a provider route. The
 * tenant is the broker's (stamped from trusted context). A question is never
 * permission: analysis answers carry an explicit line saying so.
 */

import type { FomoBroker } from "./contract";
import { classifyFomoQuestion, type FomoQuestionPlan } from "./intent";
import {
  evidenceForModel,
  FOMO_ATTRIBUTION,
  FOMO_CAPABILITIES_GROUP,
  FOMO_CAPABILITIES_OWNER,
  FOMO_CHAT_RULES,
  FOMO_GROUP_OFF,
  FOMO_GROUP_ON,
  GROUP_DM_DEFLECTION,
  groupScrub,
  NOT_PERMISSION_LINE,
  renderAnswer,
} from "./render";
import { applyPlan, applyResult, deserialize, serialize, type SubjectMemory } from "./subject-memory";
import { isMutationTool } from "./tools";
import type { TokenThesesData, TraderActivityData } from "./tools";
import type { FomoEnvelope, FomoSurface, FomoToolName, ResolvedSubject, ResultStatus } from "./types";

export interface FomoComposeInput {
  plan: FomoQuestionPlan;
  /** The fenced FOMO EVIDENCE block (third-party data; not instructions). */
  evidence: string;
  /** FOMO_CHAT_RULES. */
  rules: string;
  /** The deterministic answer, for the composer to stay consistent with. */
  deterministic: string;
}

export interface AnswerFomoInput {
  text: string;
  broker: FomoBroker;
  now: number;
  surface: FomoSurface;
  audience: "owner" | "group";
  conversationKey: string;
  /** Telegram group id (trusted chat id), for per-group budgets. */
  groupId?: string | null;
  maxChars?: number;
  compose?: (c: FomoComposeInput) => Promise<string | null>;
  /**
   * The agent's own names and @handle(s), from trusted context (intent.ts
   * FomoQuestionContext.selfNames): never researched as a trader.
   */
  selfNames?: readonly string[];
  /**
   * Plan as if the conversation had no memory: the message replies to
   * something that is not a Fomo answer (a trade receipt), so its "it" is
   * that message's subject, never the coin a research answer left behind.
   */
  ignoreMemory?: boolean;
  /**
   * Run reads only, even for the owner: a mutation plan (watch, unwatch) is
   * not handled at all. For answers produced on the owner's behalf from
   * somewhere other than her own words in her DM (a group ask handed to her
   * DM), so that text from a room can never change her state.
   */
  readOnly?: boolean;
  /**
   * The surface's own last word on a plan, before anything is remembered,
   * deflected, clarified or looked up: false and the question is not handled
   * here at all. A group uses it to leave a coin question the planner could
   * not place ("who's selling pons on fomo?") to its router, rather than
   * answer it about the whole feed (tg-fomo-port.ts looseCoin).
   */
  wanted?: (plan: FomoQuestionPlan) => boolean;
}

export type AnswerFomoResult =
  | { handled: false }
  | {
      handled: true;
      text: string;
      plan: FomoQuestionPlan;
      envelopes: FomoEnvelope[];
      toolsCalled: FomoToolName[];
      analysis: boolean;
      clarification: boolean;
    };

/** The most tool calls one question may make. */
export const MAX_CALLS_PER_QUESTION = 4;
const DEFAULT_MAX_CHARS = 3_500;

/** Statuses that mean a lookup actually returned something real. */
const ANSWERED: ReadonlySet<ResultStatus> = new Set(["ok", "empty", "partial", "capped", "stale"]);

/**
 * One trader's holdings, trades or profile. The public leaderboard is not
 * here: a group hears it, handles and P&L included (Milla, 2026-10-07).
 */
const TRADER_INTENTS: ReadonlySet<string> = new Set(["trader-holdings", "trader-activity", "trader-context"]);
const OWNER_ONLY_INTENTS: ReadonlySet<string> = new Set(["research-status", "why-skipped", "health", "watch", "unwatch"]);

/** A group may hear coin-level aggregates and the public leaderboard; anything about one trader (or the owner's own state) goes to a DM. */
function groupMustDeflect(plan: FomoQuestionPlan): boolean {
  if (TRADER_INTENTS.has(plan.intent) || OWNER_ONLY_INTENTS.has(plan.intent)) return true;
  // The leaderboard cut to the traders Merrymen watches ("top traders we
  // watch") IS the watch list, and who it follows is never a room's.
  if (plan.intent === "rankings-traders" && plan.cohortScope) return true;
  if (plan.toolCalls.some((c) => c.tool === "fomo_get_rankings" && c.args.board === "traders" && c.args.cohort_only === true)) return true;
  if (plan.subjects.some((s) => s.kind === "trader")) return true;
  return plan.toolCalls.some((c) => typeof c.args.trader === "string" || c.tool === "fomo_get_trader_context" || c.tool === "fomo_get_trader_activity");
}

/** Every subject an answering envelope resolved, including the second one a two-subject read carries. */
function subjectsOf(env: FomoEnvelope): ResolvedSubject[] {
  const out: ResolvedSubject[] = [];
  if (env.subject && env.subject.kind !== "market") out.push(env.subject);
  if (env.tool === "fomo_get_token_theses") {
    const d = env.data as TokenThesesData | null;
    if (d?.trader && env.subject?.kind !== "trader") out.push({ kind: "trader", trader: d.trader });
  }
  if (env.tool === "fomo_get_trader_activity") {
    const d = env.data as TraderActivityData | null;
    if (d?.token) out.push({ kind: "token", token: d.token, label: { symbol: null, name: null } });
  }
  return out;
}

function failedEnvelope(tool: FomoToolName, now: number, i: number): FomoEnvelope {
  return {
    requestId: `chat-failed-${Math.trunc(now)}-${i}`,
    tool,
    status: "failed",
    subject: null,
    candidates: [],
    data: null,
    evidence: [],
    freshness: {
      policy: "profile",
      mode: "prefer-fresh",
      retrievedAt: null,
      providerAsOf: null,
      sourceEventAt: { oldest: null, newest: null },
      lastRefreshAttemptAt: null,
      lastRefreshOutcome: null,
      cacheAgeMs: null,
      servedFrom: "none",
    },
    coverage: { requested: {}, achieved: {}, pagesRequested: 0, pagesReturned: 0, itemsReturned: 0, duplicatesRemoved: 0, providerTotal: null, capped: false, missing: [], notes: [] },
    usage: { providerCalls: 0, cacheHits: 0, creditsCharged: null, creditsRemaining: null },
    dossierRevision: null,
    reason: "broker-error",
    message: "The Fomo lookup could not be completed.",
  };
}

/** Whether the broker has a provider key behind it; a broker that throws has none it can use. */
function brokerConfigured(broker: FomoBroker): boolean {
  try {
    return broker.configured() === true;
  } catch {
    return false;
  }
}

async function remember(broker: FomoBroker, key: string, memory: SubjectMemory): Promise<void> {
  try {
    await broker.memory.set(key, serialize(memory));
  } catch {
    // Memory is a convenience; a failed write costs a clarification later, never a wrong answer.
  }
}

export async function answerFomoQuestion(input: AnswerFomoInput): Promise<AnswerFomoResult> {
  const { broker, now, audience, conversationKey } = input;
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;

  // 1. Memory, strictly re-validated.
  let stored: string | null = null;
  if (!input.ignoreMemory) {
    try {
      stored = await broker.memory.get(conversationKey);
    } catch {
      stored = null;
    }
  }
  const memory = deserialize(stored);

  // 2. The deterministic plan.
  const selfNames = Array.isArray(input.selfNames) ? input.selfNames.filter((n): n is string => typeof n === "string").slice(0, 16) : [];
  const plan = classifyFomoQuestion(input.text, { memory, now, ...(selfNames.length ? { selfNames } : {}) });
  if (!plan) return { handled: false };
  try {
    if (input.wanted && input.wanted(plan) !== true) return { handled: false };
  } catch {
    return { handled: false };
  }

  // ANSWERED BY CODE, NOTHING LOOKED UP OR REMEMBERED: what it can do with
  // Fomo, and, in a group, whether research is on here at all. A group never
  // hears the owner's own research state; that answer is a direct message's.
  const said = (text: string): AnswerFomoResult => ({ handled: true, text, plan, envelopes: [], toolsCalled: [], analysis: false, clarification: false });
  if (plan.intent === "capabilities") return said(audience === "group" ? FOMO_CAPABILITIES_GROUP : FOMO_CAPABILITIES_OWNER);
  if (audience === "group" && plan.intent === "health") return said(brokerConfigured(broker) ? FOMO_GROUP_ON : FOMO_GROUP_OFF);
  if (input.readOnly === true && plan.toolCalls.some((c) => isMutationTool(c.tool))) return { handled: false };
  if (input.readOnly === true && (plan.intent === "watch" || plan.intent === "unwatch")) return { handled: false };

  // A question a group never hears answered is deflected BEFORE it is
  // remembered or clarified: a room is never asked "Which coin do you mean?"
  // about a trader, and the trader never lands in the room's memory.
  if (audience === "group" && groupMustDeflect(plan)) {
    return { handled: true, text: GROUP_DM_DEFLECTION, plan, envelopes: [], toolsCalled: [], analysis: false, clarification: false };
  }

  // 3. Record what was asked about BEFORE any lookup.
  const step = applyPlan(memory, plan, now);
  await remember(broker, conversationKey, step.memory);

  // 4. One focused question, verbatim.
  if (plan.clarification) {
    return { handled: true, text: plan.clarification, plan, envelopes: [], toolsCalled: [], analysis: false, clarification: true };
  }

  // 5. The lookups.
  const calls = plan.toolCalls.filter((c) => (audience === "owner" && input.readOnly !== true) || !isMutationTool(c.tool)).slice(0, MAX_CALLS_PER_QUESTION);
  const envelopes: FomoEnvelope[] = [];
  const toolsCalled: FomoToolName[] = [];
  for (const [i, c] of calls.entries()) {
    let env: FomoEnvelope;
    try {
      env = await broker.call(c.tool, { ...c.args }, {
        surface: input.surface,
        audience,
        conversationKey,
        priority: "interactive",
        groupId: input.groupId ?? null,
      });
    } catch {
      env = failedEnvelope(c.tool, now, i);
    }
    envelopes.push(env);
    toolsCalled.push(c.tool);
  }

  // 6. Remember what was actually resolved, only from envelopes that answered.
  const answered = envelopes.filter((e) => ANSWERED.has(e.status));
  if (answered.length) {
    const last = answered[answered.length - 1]!;
    const revision = [...answered].reverse().find((e) => e.dossierRevision)?.dossierRevision ?? null;
    const m3 = applyResult(step.memory, { subjects: answered.flatMap(subjectsOf), dossierRevision: revision, requestId: last.requestId }, now);
    await remember(broker, conversationKey, m3);
  }

  // 7. The answer.
  const analysis = plan.analysisRequested && !plan.infoOnly;
  const deterministic = renderAnswer(envelopes, plan, { audience, maxChars, now });
  let text = deterministic;
  // A composer writes only from evidence that exists: with no answering envelope the honest text is the deterministic one.
  if (analysis && input.compose && answered.length > 0) {
    try {
      const composed = await input.compose({
        plan,
        evidence: evidenceForModel(envelopes, Math.max(2_000, maxChars * 2), { audience, now }),
        rules: FOMO_CHAT_RULES,
        deterministic,
      });
      if (typeof composed === "string" && composed.trim() && !typesExecutable(composed)) {
        // The composer's words get the same group scrub as ours: no handles, addresses, links or cashtags.
        const t = composed.trim().slice(0, maxChars);
        text = audience === "group" ? groupScrub(t) : t;
      }
    } catch {
      text = deterministic;
    }
    if (!text.includes(NOT_PERMISSION_LINE)) text = `${text}\n${NOT_PERMISSION_LINE}`;
    if (!text.includes(FOMO_ATTRIBUTION)) text = `${text}\n${FOMO_ATTRIBUTION}`;
  }
  return { handled: true, text, plan, envelopes, toolsCalled, analysis, clarification: false };
}

/**
 * A COMPOSED ANSWER THAT TYPES AN ADDRESS IS NOT SENT. The evidence carries
 * shortened addresses only, so a full 20-byte hex, a tx-hash-length hex or a
 * mint-length base58 run in the reply came from the model (or from text it
 * was shown and echoed). One wrong character in a retyped address sends
 * someone's funds where nobody can recover them, and the house rule is that a
 * model never types one; the deterministic answer, which renders addresses
 * shortened, is used instead.
 */
export function typesExecutable(text: string): boolean {
  return /0x[0-9a-fA-F]{40}/.test(text) || /\b[1-9A-HJ-NP-Za-km-z]{32,}\b/.test(text) || /\b[0-9a-fA-F]{64}\b/.test(text);
}
