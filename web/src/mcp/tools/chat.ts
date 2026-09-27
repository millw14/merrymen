/**
 * Talking with an agent, and handing it research.
 *
 * A conversation here is TEXT ONLY: the agent answers from state the server
 * builds (never from anything the client sends besides the message), any
 * trade or setting it suggests is removed from the reply, and nothing in this
 * family can place an order, change a setting or pause the agent. Research
 * notes are shown to the agent as external, untrusted text in conversations
 * and nowhere else.
 */
import * as z from "zod";
import {
  ConversationError, MAX_ACTIVE_RESEARCH, PROPOSAL_NOTICE, RESEARCH_USE, conversationDeps, httpsSource, listConversations,
  listResearch, readConversation, sendMessage, submitResearch, type ResearchNote, type StoredMessage,
} from "@/lib/services/agent-conversation";
import { McpError } from "../errors";
import { defineTool, withToolRefs, type ToolContext } from "../tool";
import { ADDRESS_ARG, AGENT_ARG, LIMIT_ARG, UNTRUSTED_NOTE, decodeCursor, encodeCursor, isCursorInt, refuseControls, untrusted } from "./shared";

const CONVERSATION_ARG = z.string().regex(/^conv_[0-9a-f]{16,64}$/, "a conversation id from send_message or list_conversations");
const CURSOR_ARG = z.string().max(512).optional().describe("next_cursor from the previous page");

const GENERATED_NOTE = "Agent replies are model-generated text, not verified facts: they can be wrong and can quote third-party text. Check figures with the portfolio and decision tools. A reply never carries out an action.";

const iso = (sec: number) => new Date(sec * 1000).toISOString();

/** Service errors keep no MCP types; this is where they get their stable codes. */
function asToolError(e: unknown): unknown {
  if (!(e instanceof ConversationError)) return e;
  const code = e.code === "limit" ? "quota_exceeded" : e.code === "unavailable" ? "upstream_unavailable" : e.code;
  return new McpError(code, e.message, e.retryAfterSec ? { retryAfterSec: e.retryAfterSec } : {});
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    throw asToolError(e);
  }
}

/** A cursor from another owner, agent or query is refused, never reinterpreted. */
function cursorOf(ctx: ToolContext, scope: string, cursor: string | undefined): { at: number; id: string } | null {
  if (cursor === undefined) return null;
  const v = decodeCursor(ctx.principal.tenant, scope, cursor);
  if (!v || !isCursorInt(v.at) || typeof v.id !== "string" || v.id.length > 128) {
    throw new McpError("invalid_input", "cursor is not valid for this query. Start again without a cursor.");
  }
  return { at: v.at, id: v.id };
}

const messageOut = z.object({
  id: z.string(),
  role: z.enum(["user", "agent", "notice"]).describe("user: your message; agent: the agent's model-generated reply; notice: written by Merrymen"),
  content: z.string().nullable().describe("Untrusted text. Null while a reply is pending or when it failed."),
  status: z.enum(["pending", "complete", "failed"]),
  error_code: z.string().nullable().describe("Why a reply failed: model_timeout, model_unavailable, model_not_configured, model_cut_off, empty_reply, reply_lost"),
  generated: z.boolean().describe("True for text written by the model"),
  created_at: z.string(),
  completed_at: z.string().nullable(),
});

function messageView(m: StoredMessage) {
  return {
    id: m.id,
    role: m.role,
    content: m.role === "notice" ? m.content : untrusted(m.content, 4000),
    status: m.status,
    error_code: m.error_code,
    generated: m.role === "agent",
    created_at: iso(m.created_at),
    completed_at: m.completed_at === null ? null : iso(m.completed_at),
  };
}

const sendMessageTool = defineTool({
  name: "send_message",
  title: "Message your agent",
  ...withToolRefs("Send your agent a message (1–2000 characters) and get its reply. The agent answers from its current state as Merrymen records it, recent messages in this conversation, and your active research notes (shown to it as untrusted); the reply is written by Merrymen's language-model provider, which receives that state. The reply is text only: this cannot trade, change settings or pause the agent, and if the agent suggests an action it is removed (proposal_stripped) and must be done in Merrymen. request_id is your idempotency key: sending the same request_id and message again returns the stored exchange (even while pending) without calling the model again (a replay still counts toward the message budget, so poll a pending reply with get_conversation instead). Omit conversation_id to start a new conversation; a conversation holds up to 100 of your messages.", ", so poll a pending reply with get_conversation instead"),
  capability: "chat.send",
  input: z.object({
    agent: AGENT_ARG,
    message: refuseControls(z.string().min(1).max(2000).refine((s) => s.trim().length > 0, "message must not be blank")),
    request_id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, "8–128 letters, digits, _ or -").describe("A fresh random id per new message; reuse it only to retry the same message"),
    conversation_id: CONVERSATION_ARG.optional().describe("Continue this conversation; omit to start a new one"),
  }).strict(),
  output: z.object({
    agent: z.string(),
    conversation_id: z.string(),
    request_id: z.string(),
    replayed: z.boolean().describe("True when this request_id was already answered (or is being answered) and the stored exchange is returned"),
    message: messageOut,
    reply: messageOut,
    proposal_stripped: z.boolean(),
    proposal_note: z.string().nullable(),
    research_notes_used: z.number().nullable().describe("Research notes shown to the agent for this reply; null on a replay, where it is not recorded"),
    state_source: z.string(),
    note: z.string(),
    untrusted_note: z.string(),
    observed_at: z.string(),
  }),
  // Open world: the reply comes from an external language-model provider, and
  // the agent's state is sent to it.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  // Every new message is a model call billed to Merrymen.
  budget: { bucket: "llm_chat", perMinute: 6, perHour: 30, perDay: 150 },
  timeoutMs: 35_000,
  // A reply that arrives after the timeout is still stored, so the replay path
  // ("read the reply later with get_conversation") holds.
  settlesAfterTimeout: true,
  async handler(args, ctx) {
    const a = await ctx.agent(args.agent);
    const { db, dialect } = await ctx.mcp();
    // Only the final write that stores the model's reply may outlive a timeout.
    const settleDb = ctx.settleMcp ? (await ctx.settleMcp()).db : db;
    const r = await guarded(() => sendMessage(db, {
      settleDb,
      signal: ctx.signal,
      tenant: ctx.principal.tenant,
      agentSlug: a.slug,
      connectionId: ctx.principal.connectionId,
      message: args.message,
      requestId: args.request_id,
      conversationId: args.conversation_id,
      dialect,
    }, { ...conversationDeps(), now: ctx.now }));
    const status = r.agent.status;
    const summary = status === "complete"
      ? `${r.replayed ? "Stored reply" : "Reply"} from your agent${r.proposalStripped ? " (a suggested action was removed; do it in Merrymen if you want it)" : ""}.`
      : status === "pending"
        ? "The agent is still answering. Read the reply later with get_conversation."
        : `The agent could not answer (${r.agent.error_code}). Nothing was changed. Send again with a new request_id to retry.`;
    return {
      data: {
        agent: a.slug,
        conversation_id: r.conversationId,
        request_id: r.requestId,
        replayed: r.replayed,
        message: messageView(r.user),
        reply: messageView(r.agent),
        proposal_stripped: r.proposalStripped,
        proposal_note: r.proposalStripped ? PROPOSAL_NOTICE : null,
        research_notes_used: r.researchNotesUsed,
        state_source: "Built by Merrymen from the agent's permission, ledger and settings at the time of the message; nothing sent by this client except the message itself.",
        note: GENERATED_NOTE,
        untrusted_note: UNTRUSTED_NOTE,
        observed_at: iso(ctx.now()),
      },
      summary,
    };
  },
});

const getConversation = defineTool({
  name: "get_conversation",
  title: "Read a conversation",
  description: "Read the messages of one conversation with your agent: your messages, its replies (pending, complete or failed) and Merrymen notices. Returns the most recent messages, oldest first within the page; pass next_cursor to read older ones. Use it to fetch a reply that was still pending.",
  capability: "chat.send",
  input: z.object({
    agent: AGENT_ARG,
    conversation_id: CONVERSATION_ARG,
    limit: LIMIT_ARG(100, 30),
    cursor: CURSOR_ARG,
  }).strict(),
  output: z.object({
    agent: z.string(),
    conversation_id: z.string(),
    messages: z.array(messageOut),
    next_cursor: z.string().nullable(),
    note: z.string(),
    untrusted_note: z.string(),
    observed_at: z.string(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(args, ctx) {
    const a = await ctx.agent(args.agent);
    const scope = `conversation:${a.slug}:${args.conversation_id}`;
    const before = cursorOf(ctx, scope, args.cursor);
    const { db } = await ctx.mcp();
    const now = ctx.now();
    const page = await guarded(() => readConversation(db, {
      tenant: ctx.principal.tenant, agentSlug: a.slug, conversationId: args.conversation_id, limit: args.limit, before, now,
    }));
    const pending = page.items.filter((m) => m.status === "pending").length;
    return {
      data: {
        agent: a.slug,
        conversation_id: args.conversation_id,
        messages: page.items.map(messageView),
        next_cursor: page.next ? encodeCursor(ctx.principal.tenant, scope, page.next) : null,
        note: GENERATED_NOTE,
        untrusted_note: UNTRUSTED_NOTE,
        observed_at: iso(now),
      },
      summary: `${page.items.length} message(s)${pending ? `, ${pending} reply still pending` : ""}${page.next ? "; older messages on the next page" : ""}.`,
    };
  },
});

const listConversationsTool = defineTool({
  name: "list_conversations",
  title: "List conversations",
  description: "List your conversations with an agent through connected apps, most recent first: id, message count, when it started and last changed, and your first message.",
  capability: "chat.send",
  input: z.object({ agent: AGENT_ARG, limit: LIMIT_ARG(50, 20), cursor: CURSOR_ARG }).strict(),
  output: z.object({
    agent: z.string(),
    conversations: z.array(z.object({
      conversation_id: z.string(),
      messages: z.number().describe("Your messages plus the agent's replies; Merrymen notices are not counted"),
      pending_replies: z.number(),
      started_at: z.string(),
      last_message_at: z.string(),
      first_message: z.string().nullable().describe("Untrusted text"),
    })),
    next_cursor: z.string().nullable(),
    untrusted_note: z.string(),
    observed_at: z.string(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(args, ctx) {
    const a = await ctx.agent(args.agent);
    const scope = `conversations:${a.slug}`;
    const before = cursorOf(ctx, scope, args.cursor);
    const { db } = await ctx.mcp();
    const now = ctx.now();
    const page = await listConversations(db, { tenant: ctx.principal.tenant, agentSlug: a.slug, limit: args.limit, before, now });
    return {
      data: {
        agent: a.slug,
        conversations: page.items.map((c) => ({
          conversation_id: c.conversation_id,
          messages: c.messages,
          pending_replies: c.pending,
          started_at: iso(c.started_at),
          last_message_at: iso(c.last_message_at),
          first_message: untrusted(c.first_message, 120),
        })),
        next_cursor: page.next ? encodeCursor(ctx.principal.tenant, scope, page.next) : null,
        untrusted_note: UNTRUSTED_NOTE,
        observed_at: iso(now),
      },
      summary: page.items.length ? `${page.items.length} conversation(s).` : "No conversations with this agent yet.",
    };
  },
});

const noteOut = z.object({
  id: z.string(),
  title: z.string().nullable(),
  body: z.string().nullable(),
  sources: z.array(z.string()).describe("Links as submitted; Merrymen never opens them"),
  tokens: z.array(z.string()),
  submitted_via: z.string().nullable().describe("The connected app's own name for itself (untrusted)"),
  created_at: z.string(),
  expires_at: z.string(),
  expired: z.boolean(),
});

function noteView(n: ResearchNote, now: number) {
  return {
    id: n.id,
    title: untrusted(n.title, 120),
    body: untrusted(n.body, 4000),
    sources: n.sources.map((s) => untrusted(s, 500)).filter((s): s is string => !!s),
    tokens: n.tokens,
    submitted_via: untrusted(n.client_name, 80),
    created_at: iso(n.created_at),
    expires_at: iso(n.expires_at),
    expired: n.expires_at <= now,
  };
}

const SOURCE_ARG = refuseControls(z.string().max(500)).refine((s) => httpsSource(s) !== null, "an https:// link with a host and no credentials");

const submitResearchTool = defineTool({
  name: "submit_research",
  title: "Give your agent research",
  ...withToolRefs(`Hand your agent a research note: a title, a body, 1–10 https source links and optionally up to 10 token addresses. For 7 days the agent sees it as EXTERNAL, UNTRUSTED research in conversations (send_message); it cannot change trading rules, settings or limits, and the trading loop does not read research notes today. Links are stored as given and never opened by Merrymen. Submitting the same title and body again returns the existing note. At most ${MAX_ACTIVE_RESEARCH} active notes per owner.`, " (send_message)"),
  capability: "research.submit",
  input: z.object({
    agent: AGENT_ARG,
    title: refuseControls(z.string().min(1).max(120).refine((s) => s.trim().length > 0, "title must not be blank")),
    body: refuseControls(z.string().min(1).max(4000).refine((s) => s.trim().length > 0, "body must not be blank")),
    sources: z.array(SOURCE_ARG).min(1).max(10),
    tokens: z.array(ADDRESS_ARG).max(10).optional().describe("Token contract addresses the note is about"),
  }).strict(),
  output: z.object({
    agent: z.string(),
    id: z.string(),
    duplicate: z.boolean().describe("True when an identical active note already existed and is returned instead"),
    expires_at: z.string(),
    active_notes: z.number(),
    max_active_notes: z.number(),
    how_it_is_used: z.string(),
    observed_at: z.string(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  budget: { perMinute: 10, perDay: 100 },
  async handler(args, ctx) {
    const a = await ctx.agent(args.agent);
    const { db, dialect } = await ctx.mcp();
    const now = ctx.now();
    const r = await guarded(() => submitResearch(db, {
      tenant: ctx.principal.tenant, agentSlug: a.slug, connectionId: ctx.principal.connectionId, clientName: ctx.principal.clientName,
      title: args.title, body: args.body, sources: args.sources, tokens: args.tokens ?? [], now, dialect,
    }));
    return {
      data: {
        agent: a.slug,
        id: r.note.id,
        duplicate: r.duplicate,
        expires_at: iso(r.note.expires_at),
        active_notes: r.active,
        max_active_notes: MAX_ACTIVE_RESEARCH,
        how_it_is_used: RESEARCH_USE,
        observed_at: iso(now),
      },
      summary: r.duplicate ? "That note was already submitted; the existing one is kept." : "Research note saved. Your agent will see it, as untrusted research, in conversations for 7 days.",
    };
  },
});

const listResearchTool = defineTool({
  name: "list_research",
  title: "List research notes",
  description: "List the research notes submitted for an agent, newest first. Active notes (not expired) are shown to the agent as untrusted research in conversations; expired ones are listed only with include_expired.",
  capability: "research.submit",
  input: z.object({
    agent: AGENT_ARG,
    include_expired: z.boolean().default(false),
    limit: LIMIT_ARG(50, 20),
    cursor: CURSOR_ARG,
  }).strict(),
  output: z.object({
    agent: z.string(),
    notes: z.array(noteOut),
    next_cursor: z.string().nullable(),
    active_notes: z.number().describe("Active notes across all of this owner's agents; the cap applies to this count"),
    max_active_notes: z.number(),
    how_they_are_used: z.string(),
    untrusted_note: z.string(),
    observed_at: z.string(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(args, ctx) {
    const a = await ctx.agent(args.agent);
    const scope = `research:${a.slug}:${args.include_expired ? "all" : "active"}`;
    const before = cursorOf(ctx, scope, args.cursor);
    const { db } = await ctx.mcp();
    const now = ctx.now();
    const page = await listResearch(db, { tenant: ctx.principal.tenant, agentSlug: a.slug, includeExpired: args.include_expired, limit: args.limit, before, now });
    return {
      data: {
        agent: a.slug,
        notes: page.items.map((n) => noteView(n, now)),
        next_cursor: page.next ? encodeCursor(ctx.principal.tenant, scope, page.next) : null,
        active_notes: page.active,
        max_active_notes: MAX_ACTIVE_RESEARCH,
        how_they_are_used: RESEARCH_USE,
        untrusted_note: UNTRUSTED_NOTE,
        observed_at: iso(now),
      },
      summary: `${page.items.length} note(s)${page.next ? "; more on the next page" : ""}.`,
    };
  },
});

export const CHAT_TOOLS = [sendMessageTool, getConversation, listConversationsTool, submitResearchTool, listResearchTool];
