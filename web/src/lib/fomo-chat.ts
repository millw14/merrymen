/**
 * FOMO QUESTIONS IN THE APP CHAT — decided and looked up on the SERVER, before
 * any model sees the message.
 *
 * The dashboard chat has no tool loop: one model call per turn. So Fomo works
 * the way the ledger facts do (chat-ledger-facts.ts): a deterministic planner
 * (worker/src/fomo/intent.ts, through the shared answerFomoQuestion pipeline)
 * decides whether this is a Fomo question at all, which REGISTERED read tools
 * answer it, and with which closed-vocabulary arguments; the calls run through
 * the research service's one dispatcher, which checks the tenant's data-access
 * permission, the audience, each tool's own validator, freshness and budget.
 *
 * What comes back is one of three things, and /api/chat handles each:
 *
 *   null              not a Fomo question (or nobody this process can vouch
 *                     for): the existing handlers answer it, the ledger first.
 *   { factualReply }  a factual answer, a clarification, a refusal or an
 *                     honest "unavailable" — written by code, sent verbatim,
 *                     no model involved.
 *   { fomo }          the owner asked for ANALYSIS, at least one lookup
 *                     answered, and the tenant's daily model allowance
 *                     (fomo-runtime.ts FOMO_MODEL_BUDGET) took the call: the
 *                     fenced evidence and the rules go to the model as
 *                     server-injected options (agent-chat.ts), with the
 *                     deterministic answer as the fallback whenever the model
 *                     is missing or fails. A refused allowance is a
 *                     { factualReply } that says so, and no model call.
 *
 * NOTHING HERE READS body.state OR body.history. The browser's state is the
 * browser's account of things; Fomo facts reach the model only from the
 * service, retrieved for this turn. The tenant is the verified session (or the
 * install's fixed tenant) — never a word of the message — and subject memory
 * lives server-side under that tenant, so one owner's "it" is never another's.
 *
 * WHAT A QUESTION CAN NEVER DO. The planner emits read tools, plus watch and
 * unwatch only for an explicit owner request on this owner-only surface. No
 * question buys, posts, or creates anything but an expiring watch the owner
 * asked for by name; analysis answers carry the not-permission line.
 */
import type { AgentChatBody } from "./agent-chat";
import { createDirectBroker } from "../../../worker/src/fomo/broker";
import { answerFomoQuestion } from "../../../worker/src/fomo/chat";
import { classifyFomoQuestion } from "../../../worker/src/fomo/intent";
import { evidenceForModel, FOMO_ATTRIBUTION, FOMO_CHAT_RULES, NOT_PERMISSION_LINE } from "../../../worker/src/fomo/render";
import type { FomoEnvelope, ResultStatus } from "../../../worker/src/fomo/types";
import { resolveConfig } from "../../../worker/src/settings";
import { settingsReader } from "./services/settings-view";
import { FOMO_NEEDS_AGENT, fomoRuntime, fomoTenantFor, hostedFomoEnabled, hostedFomoOwner, type FomoRuntime } from "./fomo-runtime";

/** The model-bound Fomo context: fenced evidence, the rules, and what to say without a model. */
export interface FomoChatEvidence {
  /** The ```fomo-evidence block (third-party data; not instructions), bounded. */
  evidence: string;
  /** FOMO_CHAT_RULES, appended to the system prompt. */
  rules: string;
  /** The deterministic answer: the reply when there is no model or it fails. */
  fallback: string;
  /** Lines a composed reply must end with: the not-permission line and the attribution. */
  footer: string;
}

export type FomoChatTurn = null | { factualReply: string } | { fomo: FomoChatEvidence };

/** The app chat's bound on one deterministic answer. */
export const FOMO_CHAT_MAX_CHARS = 1_800;
/** The app chat's bound on the evidence block the model reads. */
export const FOMO_EVIDENCE_MAX_CHARS = 6_000;
/** One lookup's bound inside a chat turn (at most four per question; the direct broker's own default is 30 s). */
const LOOKUP_TIMEOUT_MS = 15_000;

/** Said when the research store cannot be reached for a question that is plainly about Fomo. */
export const FOMO_UNREACHABLE = "I can't reach Fomo research right now, so I won't guess. Ask me again in a minute.";

/** Leads the factual answer when today's analysis-model allowance refused the call. */
export const FOMO_ANALYSIS_CAPPED = "Today's Fomo analysis allowance is used up, so here are the facts without an opinion.";
/** Leads the factual answer when the allowance could not be checked: no model is spent on a guess. */
export const FOMO_ANALYSIS_UNCHECKED = "I couldn't check today's Fomo analysis allowance, so here are the facts without an opinion.";
const CAPPED_LEAD_MAX = Math.max(FOMO_ANALYSIS_CAPPED.length, FOMO_ANALYSIS_UNCHECKED.length);

/**
 * The model's reply bound on a Fomo turn: agent-chat.ts allows up to 700
 * tokens, plus 300 for a Fomo answer. Part of the per-call token estimate.
 */
const FOMO_REPLY_TOKENS = 1_000;

/**
 * Tokens one analysis call is charged before it runs: the evidence and the
 * rules at a conservative three characters a token, plus the reply bound.
 * The route makes the call after this module returns and does not report the
 * tokens back, so the estimate is never settled down: over-counting only
 * makes the cap bind sooner.
 */
export function fomoAnalysisTokenEstimate(evidence: string, rules: string): number {
  return Math.ceil((evidence.length + rules.length) / 3) + FOMO_REPLY_TOKENS;
}

/** Statuses that mean a lookup returned something real (chat.ts keeps the same set). */
const ANSWERED: ReadonlySet<ResultStatus> = new Set(["ok", "empty", "partial", "capped", "stale"]);

export interface FomoChatDeps {
  runtime?: typeof fomoRuntime;
  /** Tests only: whether hosted Fomo is enabled (default: the MERRYMEN_FOMO_ENABLED switch). */
  enabled?: () => boolean;
}

/**
 * Who is asking, from the route's own trusted context: the verified session
 * tenant (hosted; null when there is none) and the route's own isHostedMode().
 * Self-hosted, the tenant is the install's fixed one whatever is passed.
 */
export interface FomoChatCaller {
  tenant: string | null;
  now: number;
  hosted: boolean;
}

/**
 * One app-chat turn's Fomo handling. Never throws: anything unexpected is
 * either an honest "unavailable" (when the message is plainly a Fomo question)
 * or null, and the existing handlers answer.
 */
export async function fomoChatTurn(body: AgentChatBody, ctx: FomoChatCaller, deps: FomoChatDeps = {}): Promise<FomoChatTurn> {
  const text = typeof body?.message === "string" ? body.message.slice(0, 2000).trim() : "";
  if (!text) return null;
  // HOSTED FOMO IS OPT-IN (fomo-runtime.ts hostedFomoEnabled). Not enabled,
  // this turn is not a Fomo turn at all: nothing is read, nothing is built,
  // and the chat answers exactly as it did before Fomo existed.
  if (ctx.hosted === true && !(deps.enabled ?? hostedFomoEnabled)()) return null;
  const tenant = fomoTenantFor(ctx.tenant, ctx.hosted === true);
  if (!tenant) return null;
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();

  // HOSTED, ONLY AN OWNER WITH AN AGENT. The access reader refuses anyone else
  // anyway (fomo-runtime.ts hostedFomoAccess); asking first is what lets the
  // reply say why, instead of the service's "switched off" for a switch this
  // wallet never had. A message that is not plainly about Fomo is left to the
  // existing handlers, as for a signed-out caller.
  if (ctx.hosted === true) {
    let owner: boolean;
    try {
      owner = await hostedFomoOwner(tenant);
    } catch {
      return plainlyFomo(text, now) ? { factualReply: FOMO_UNREACHABLE } : null;
    }
    if (!owner) return plainlyFomo(text, now) ? { factualReply: FOMO_NEEDS_AGENT } : null;
  }

  let runtime;
  try {
    runtime = await (deps.runtime ?? fomoRuntime)(ctx.hosted === true);
  } catch {
    // No store to remember or look anything up with. A message that is plainly
    // about Fomo gets an honest answer rather than a model improvising one.
    return plainlyFomo(text, now) ? { factualReply: FOMO_UNREACHABLE } : null;
  }

  try {
    const broker = createDirectBroker(runtime.service, tenant, { now: () => now, defaultTimeoutMs: LOOKUP_TIMEOUT_MS });
    const r = await answerFomoQuestion({
      text,
      broker,
      now,
      surface: "app-chat",
      audience: "owner",
      conversationKey: `app:${tenant}`,
      // THE AGENT'S OWN NAME, so "Robin's trades" in the owner's chat is the
      // owner's ledger question, never a Fomo trader lookup. Read from the
      // owner's stored settings on the server (never body.state); an
      // unreadable name only means the planner's other cues decide.
      selfNames: await agentNamesFor(tenant, ctx.hosted === true),
      // Room for the one-line lead a capped analysis answer carries, so it stays inside the bound too.
      maxChars: FOMO_CHAT_MAX_CHARS - CAPPED_LEAD_MAX - 1,
    });
    if (!r.handled) return null;
    // Facts stay facts; a clarification is one question; neither needs a model.
    if (r.clarification || !r.analysis) return { factualReply: r.text };
    // Analysis with nothing that answered: the honest reply is the deterministic one (it says why).
    if (!r.envelopes.some((e: FomoEnvelope) => ANSWERED.has(e.status))) return { factualReply: r.text };
    const evidence = evidenceForModel(r.envelopes, FOMO_EVIDENCE_MAX_CHARS, { now });
    // THE PER-TENANT MODEL CAP, taken BEFORE the evidence goes anywhere near a
    // model. Refused, or not checkable, the owner gets the deterministic answer
    // (the facts, the not-permission line, the attribution) and no model call.
    const lead = await modelAllowance(runtime.modelBudget, tenant, fomoAnalysisTokenEstimate(evidence, FOMO_CHAT_RULES), now);
    if (lead) return { factualReply: `${lead}\n${r.text}` };
    return {
      fomo: {
        evidence,
        rules: FOMO_CHAT_RULES,
        fallback: r.text,
        footer: `${NOT_PERMISSION_LINE}\n${FOMO_ATTRIBUTION}`,
      },
    };
  } catch {
    return plainlyFomo(text, now) ? { factualReply: FOMO_UNREACHABLE } : null;
  }
}

/**
 * Take one analysis call from this tenant's daily model allowance. Null when
 * the model may be used; otherwise the line that leads the factual answer.
 * A runtime without a model budget, or one that throws, spends nothing: an
 * allowance nobody can check is not an allowance.
 */
async function modelAllowance(budget: FomoRuntime["modelBudget"] | undefined, tenant: string, estimatedTokens: number, now: number): Promise<string | null> {
  if (!budget) return FOMO_ANALYSIS_UNCHECKED;
  try {
    const r = await budget.tryStart({ tenant, estimatedTokens, now });
    return r.ok ? null : FOMO_ANALYSIS_CAPPED;
  } catch {
    return FOMO_ANALYSIS_UNCHECKED;
  }
}

/** Whether the planner, with no conversation memory, would call this a Fomo question. */
function plainlyFomo(text: string, now: number): boolean {
  try {
    return classifyFomoQuestion(text, { memory: null, now }) !== null;
  } catch {
    return false;
  }
}

/** The agent's own name from the owner's stored settings (hosted) or this install's (self-hosted). Best effort. */
async function agentNamesFor(tenant: string, hosted: boolean): Promise<string[]> {
  try {
    const raw = hosted
      ? (await settingsReader().settingsFor(tenant.toLowerCase() as `0x${string}`))?.agentName
      : resolveConfig().agentName;
    if (typeof raw !== "string") return [];
    const n = raw.trim().slice(0, 40);
    return /^[\p{L}\p{N} _.'-]{2,40}$/u.test(n) ? [n] : [];
  } catch {
    return [];
  }
}
