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
 *   { fomo }          the owner asked for ANALYSIS and at least one lookup
 *                     answered: the fenced evidence and the rules go to the
 *                     model as server-injected options (agent-chat.ts), with
 *                     the deterministic answer as the fallback whenever the
 *                     model is missing or fails.
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
import { fomoRuntime, fomoTenantFor } from "./fomo-runtime";

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

/** Statuses that mean a lookup returned something real (chat.ts keeps the same set). */
const ANSWERED: ReadonlySet<ResultStatus> = new Set(["ok", "empty", "partial", "capped", "stale"]);

export interface FomoChatDeps {
  runtime?: typeof fomoRuntime;
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
  const tenant = fomoTenantFor(ctx.tenant, ctx.hosted === true);
  if (!tenant) return null;
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();

  let service;
  try {
    service = (await (deps.runtime ?? fomoRuntime)(ctx.hosted === true)).service;
  } catch {
    // No store to remember or look anything up with. A message that is plainly
    // about Fomo gets an honest answer rather than a model improvising one.
    return plainlyFomo(text, now) ? { factualReply: FOMO_UNREACHABLE } : null;
  }

  try {
    const broker = createDirectBroker(service, tenant, { now: () => now, defaultTimeoutMs: LOOKUP_TIMEOUT_MS });
    const r = await answerFomoQuestion({
      text,
      broker,
      now,
      surface: "app-chat",
      audience: "owner",
      conversationKey: `app:${tenant}`,
      maxChars: FOMO_CHAT_MAX_CHARS,
    });
    if (!r.handled) return null;
    // Facts stay facts; a clarification is one question; neither needs a model.
    if (r.clarification || !r.analysis) return { factualReply: r.text };
    // Analysis with nothing that answered: the honest reply is the deterministic one (it says why).
    if (!r.envelopes.some((e: FomoEnvelope) => ANSWERED.has(e.status))) return { factualReply: r.text };
    return {
      fomo: {
        evidence: evidenceForModel(r.envelopes, FOMO_EVIDENCE_MAX_CHARS, { now }),
        rules: FOMO_CHAT_RULES,
        fallback: r.text,
        footer: `${NOT_PERMISSION_LINE}\n${FOMO_ATTRIBUTION}`,
      },
    };
  } catch {
    return plainlyFomo(text, now) ? { factualReply: FOMO_UNREACHABLE } : null;
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
