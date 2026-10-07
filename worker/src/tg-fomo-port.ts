/**
 * THE SOCIAL-TRADING RESEARCH, AS A TELEGRAM GROUP MAY HEAR IT
 * (docs/fomo.md "Telegram groups"; docs/tg-groups.md rules 2 and 3).
 *
 * The group handler (telegram/tg-groups/) may not import anything under
 * fomo/ (tg-groups/boundary.test.ts), so it reaches the research through
 * `TgFomoPort`, and this root-level adapter implements it over the research
 * broker, as tg-trade-facts.ts implements the public trade projection.
 *
 * WHAT IT DECIDES FROM TRUSTED CONTEXT ONLY. The tenant is the broker's (the
 * orchestrator stamps it from which child asked; self-hosted, the install's
 * own). The audience is fixed: "group". The group id is the chat id Telegram
 * delivered the line in, which the handler passes from the update, never from
 * the text. The conversation key is built from that same chat id and topic.
 * The asker's words reach only the deterministic planner, as data.
 *
 * WHAT A GROUP NEVER HEARS. The planner deflects a question about one trader
 * or the owner's own research state before anything is spent; the renderer
 * gives a group coin-level aggregates (no wallets, addresses, links, cashtags
 * or quoted third-party text, money in short form) and scrubs the result. The
 * one place a group hears traders named is Fomo's public leaderboard: its
 * handles and their P&L, never as @mentions, never who Merrymen follows
 * (Milla's call, 2026-10-07). A group answer carries no source line and no
 * skill caveat: the room has had a post about where the data comes from
 * (Milla, 2026-10-07), so the renderer leaves both to the owner's answers.
 * This file rewrites the renderer's fixed wording into words the group gate
 * admits (no money figure for the feed's size floor, no "P&L"). The handler
 * still gates every line before it is sent, as a `research` line, and drops
 * what the gate refuses rather than bending the gate.
 *
 * NO MODEL. A group answer is deterministic: no compose, so no model can be
 * talked into wording a trader's wallet into a room.
 */

import type { FomoBroker } from "./fomo/contract";
import { answerFomoQuestion, type AnswerFomoResult } from "./fomo/chat";
import { classifyFomoQuestion, type FomoQuestionPlan } from "./fomo/intent";
import { FOMO_ATTRIBUTION, FOMO_GROUP_OFF, GROUP_DM_DEFLECTION, groupScrub, NOT_PERMISSION_LINE } from "./fomo/render";
import type { OpportunitiesData, RankingsData, ResearchCoinData, TokenActivityData, TokenThesesData } from "./fomo/tools";
import type { FomoEnvelope, TokenIdentity, TokenLabel } from "./fomo/types";
import type { TgFomoAnswer, TgFomoMoves, TgFomoPort, TgFomoRequest, TgTraderAbout } from "./telegram/tg-groups/types";

/** The most a group answer may run to, before the handler's own line gate. */
export const TG_FOMO_MAX_CHARS = 600;

/** NOT_PERMISSION_LINE in group words: the original names a dashboard setting, which the group gate refuses. */
export const TG_FOMO_NOT_PERMISSION = "This is research, not a signal to buy or sell.";

/**
 * A question a group never hears answered: a trader, or the owner's own
 * research state. GROUP_DM_DEFLECTION says "I'll answer that in a direct
 * message", and nothing here sends that message, so the room is told where
 * the question belongs instead of being promised an answer.
 */
export const TG_FOMO_DEFLECTION = "That one is for a direct message, not the group.";

/** Said for a research question when no research is reachable from this agent: the same words as "is fomo working?" off. */
export const TG_FOMO_UNAVAILABLE = FOMO_GROUP_OFF;

export interface TgFomoPortOptions {
  /** Milliseconds. */
  now?: () => number;
  maxChars?: number;
  /** Counts and kinds only, never text, ids or names. */
  log?: (line: string) => void;
  /**
   * Whether `/buy SYMBOL` would resolve for this agent (index.ts: the same
   * watch-set resolution /buy uses). Only then do the owner's moves offer it.
   */
  buyable?: (symbol: string) => boolean;
}

// ─── A model's checked choice, as the planner's own question ───────────────

const TICKER = /^[A-Z0-9][A-Z0-9_-]{0,19}$/;

/**
 * THE FIXED QUESTION FOR A REQUEST. Each one plans exactly the intended read
 * through the deterministic planner (tg-fomo-port.test.ts pins every one), so
 * the model's choice reaches the provider only as that planner's arguments.
 * Null: nothing to ask (a trader, or a ticker that is not one).
 */
export function requestText(r: TgFomoRequest): string | null {
  switch (r.kind) {
    case "leaderboard": {
      const when = r.window === "7d" ? "this week" : r.window === "30d" ? "this month" : r.window === "all" ? "of all time" : "in the last 24h";
      return `who are the top traders on fomo ${when}?`;
    }
    case "board":
      return r.board === "graduated" ? "what are the newly graduated coins on fomo?" : r.board === "most-held" ? "what are the most held coins on fomo?" : "what's trending on fomo?";
    case "coin": {
      const s = String(r.symbol ?? "").replace(/^\$+/, "").toUpperCase();
      if (!TICKER.test(s)) return null;
      switch (r.aspect) {
        case "theses":
          return `what are the theses on $${s} on fomo?`;
        case "buyers":
          return `who's buying $${s} on fomo?`;
        case "sellers":
          return `who's selling $${s} on fomo?`;
        case "research":
          return `research $${s} on fomo`;
        default:
          return `what's happening with $${s} on fomo?`;
      }
    }
    case "crowd": {
      const when = r.window === "7d" ? " this week" : r.window === "30d" ? " this month" : "";
      return `what are traders ${r.side === "sell" ? "selling" : "buying"} on fomo${when}?`;
    }
    case "small-coins":
      return "what small coins are getting attention on fomo?";
    case "about":
      return "what can you do with fomo?";
    case "status":
      return "is fomo working?";
    default:
      return null;
  }
}

/**
 * The one trader a deflected plan was about, and what about them; null for
 * anything else (two traders, the owner's own state, a cohort board).
 */
export function traderAsked(plan: FomoQuestionPlan | null | undefined): { handle: string; about: TgTraderAbout } | null {
  if (!plan || !["trader-context", "trader-holdings", "trader-activity"].includes(plan.intent)) return null;
  const handles = plan.subjects.flatMap((s) => (s.kind === "trader" && typeof s.handle === "string" ? [s.handle.replace(/^@/, "")] : []));
  if (handles.length !== 1 || !ASKABLE_HANDLE.test(handles[0]!)) return null;
  const about: TgTraderAbout = plan.intent === "trader-holdings" ? "holdings" : plan.intent === "trader-activity" ? "trades" : "profile";
  return { handle: handles[0]!, about };
}

// ─── The owner's moves ──────────────────────────────────────────────────────

const escHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** A handle the planner can be asked about by name ("what is trader X holding"). */
const ASKABLE_HANDLE = /^[A-Za-z0-9_]{1,30}$/;
const MOVES_ROWS = 3;

function chainWords(t: TokenIdentity | null): string {
  const slug = t?.chain.slug ?? "";
  return slug === "robinhood" ? "Robinhood Chain" : slug ? slug : "an unnamed chain";
}

interface MoveCoin {
  symbol: string;
  token: TokenIdentity | null;
}

function coinOf(token: TokenIdentity | null | undefined, label: TokenLabel | null | undefined): MoveCoin | null {
  const s = String(label?.symbol ?? "").replace(/^\$+/, "").toUpperCase();
  return TICKER.test(s) ? { symbol: s, token: token ?? null } : null;
}

/** The lines for one coin: what she can say to act on it, and where. */
function coinMoves(c: MoveCoin, buyable: (s: string) => boolean): string[] {
  const out = [`<b>${escHtml(c.symbol)}</b> (${escHtml(chainWords(c.token))})`];
  const robinhood = c.token?.chain.slug === "robinhood";
  if (robinhood && /^[A-Za-z]{1,6}$/.test(c.symbol) && buyable(c.symbol)) {
    out.push(`• <code>/buy ${escHtml(c.symbol)} 5</code>: buys 5 USDG of it now, inside your limits (no confirm step)`);
  }
  if (robinhood && c.token?.address && /^0x[0-9a-fA-F]{40}$/.test(c.token.address)) {
    out.push(`• post its CA in a group I'm in and I'll review it for a buy: <code>${escHtml(c.token.address)}</code>`);
  } else if (!robinhood) {
    out.push("• not tradeable from here (I only trade Robinhood Chain coins)");
  }
  out.push(`• <code>watch ${escHtml(c.symbol)} on fomo</code>: I research it first when Fomo traders touch it`);
  out.push(`• <code>theses on ${escHtml(c.symbol)}</code>: what Fomo traders are saying`);
  return out;
}

const firstAnswered = (r: Extract<AnswerFomoResult, { handled: true }>): FomoEnvelope | null =>
  r.envelopes.find((e) => (e.status === "ok" || e.status === "partial" || e.status === "capped" || e.status === "stale") && e.data !== null) ?? null;

/**
 * HER NEXT MOVES, written by code from the answer's own rows: for traders,
 * the questions that open their book; for coins, /buy (only when /buy
 * resolves for this agent), the CA to post for a review, watch and theses.
 * Null for anything else, or when no row has a usable name.
 */
export function ownerMoves(r: AnswerFomoResult, buyable: (s: string) => boolean = () => false): TgFomoMoves | null {
  if (!r.handled || r.clarification) return null;
  const env = firstAnswered(r);
  if (!env) return null;
  if (env.tool === "fomo_get_rankings") {
    const d = env.data as RankingsData;
    if (d.board === "traders") {
      const handles = d.traders.map((t) => String(t.trader.handle ?? "").replace(/^@/, "")).filter((h) => ASKABLE_HANDLE.test(h)).slice(0, MOVES_ROWS);
      if (!handles.length) return null;
      const lines = ["<b>Your moves on these Fomo traders</b> (ask me here):"];
      for (const h of handles) {
        const e = escHtml(h);
        lines.push(`• <code>what is trader ${e} holding</code> · <code>what has trader ${e} bought this week</code>`);
      }
      return { kind: "traders", room: "sent the trade moves for these to your DM.", dm: lines.join("\n") };
    }
    const coins = d.tokens.map((t) => coinOf(t.token, t.label)).filter((c): c is MoveCoin => c !== null).slice(0, MOVES_ROWS);
    if (!coins.length) return null;
    return { kind: "coins", room: "sent the trade moves for these to your DM.", dm: ["<b>Your moves on these coins</b>:", ...coins.flatMap((c) => ["", ...coinMoves(c, buyable)])].join("\n") };
  }
  if (env.tool === "fomo_find_opportunities") {
    const d = env.data as OpportunitiesData;
    const coins = d.rows.map((row) => coinOf(row.token, row.label)).filter((c): c is MoveCoin => c !== null).slice(0, MOVES_ROWS);
    if (!coins.length) return null;
    return { kind: "coins", room: "sent the trade moves for these to your DM.", dm: ["<b>Your moves on these coins</b>:", ...coins.flatMap((c) => ["", ...coinMoves(c, buyable)])].join("\n") };
  }
  let one: MoveCoin | null = null;
  if (env.tool === "fomo_get_token_activity") {
    const d = env.data as TokenActivityData;
    one = d.token ? coinOf(d.token, d.label) : null;
  } else if (env.tool === "fomo_get_token_theses") {
    const d = env.data as TokenThesesData;
    one = d.token && !d.trader ? coinOf(d.token, d.label) : null;
  } else if (env.tool === "fomo_research_coin") {
    const d = env.data as ResearchCoinData;
    one = coinOf(d.token, d.label);
  }
  if (!one) return null;
  return { kind: "coin", room: "sent the trade moves for it to your DM.", dm: [`<b>Your moves on ${escHtml(one.symbol)}</b>:`, ...coinMoves(one, buyable).slice(1)].join("\n") };
}

/** "tg-group:<chatId>:<threadId|0>": per room and forum topic, from the trusted update. */
export function tgGroupConversationKey(chatId: number, threadId?: number): string {
  const topic = typeof threadId === "number" && Number.isSafeInteger(threadId) && threadId > 0 ? threadId : 0;
  return `tg-group:${chatId}:${topic}`;
}

/**
 * The renderer's fixed wording, put into words the group gate admits. Only
 * phrases this code base writes itself are rewritten; third-party text never
 * reaches a group render at all.
 */
export function groupWords(text: string): string {
  return text
    .split("\n")
    // The owner's attribution and skill caveat never reach a room (the renderer
    // leaves them out for a group; this is the second lock).
    .filter((line) => line.trim() !== FOMO_ATTRIBUTION && !/\bnot a (?:measure of skill|skill measure)\b/i.test(line))
    .map((line) => {
      if (line.trim() === NOT_PERMISSION_LINE) return TG_FOMO_NOT_PERMISSION;
      return line
        .replace(/\(positions above (?:about |roughly |around )?\$[\d,]+(?:\.\d+)?; a floor, not a census\)/g, "(large positions only; a floor, not a census)")
        .replace(/positions above (?:about |roughly |around )?\$[\d,]+(?:\.\d+)?/g, "large positions")
        .replace(/\bprovider-reported\b/g, "source-reported")
        .replace(/\bProvider stats\b/g, "Source stats")
        // "2m ago" reads as two million to the gate's money clause.
        .replace(/\b(\d{1,3})m( ago|\b)/g, "$1 min$2");
    })
    .join("\n");
}

const isUsableChatId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v !== 0;

/** The handler's selfNamesOf list, bounded: strings only, at most 16 of 64 characters. */
function selfNamesOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((n): n is string => typeof n === "string" && n.trim() !== "" && n.length <= 64).slice(0, 16);
}

/** One lookup's longest share of a group answer. */
const CALL_MS = 15_000;

/**
 * The broker held to the room's reply deadline: each lookup gets the smaller
 * of its share and what is left, plus an abort at the deadline, so nothing is
 * still being spent after the room has been told the answer is late. Memory
 * reads and writes give up at the deadline too.
 */
function boundedBroker(b: FomoBroker, ms: number): { broker: FomoBroker; done: () => void } {
  const until = Date.now() + ms;
  const left = (): number => until - Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(0, ms));
  (timer as { unref?: () => void }).unref?.();
  const within = <T>(p: Promise<T>, fallback: T): Promise<T> => {
    const t = left();
    if (t <= 0) return Promise.resolve(fallback);
    let h: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([p, new Promise<T>((r) => (h = setTimeout(() => r(fallback), t)))]).finally(() => h && clearTimeout(h));
  };
  return {
    broker: {
      call: (tool, args, opts) => b.call(tool, args, { ...opts, timeoutMs: Math.max(1, Math.min(opts.timeoutMs ?? CALL_MS, CALL_MS, left())), signal: ac.signal }),
      memory: {
        get: (k) => within(Promise.resolve().then(() => b.memory.get(k)), null),
        set: (k, j) => within(Promise.resolve().then(() => b.memory.set(k, j)), undefined),
        clear: (k) => within(Promise.resolve().then(() => b.memory.clear(k)), undefined),
      },
      report: (r) => b.report(r),
      configured: () => b.configured(),
    },
    done: () => {
      clearTimeout(timer);
      ac.abort();
    },
  };
}

/**
 * The group port over a broker getter (index.ts passes the child's broker).
 * Every method resolves; nothing throws into the group handler.
 */
export function createTgFomoPort(broker: () => FomoBroker | null, opts: TgFomoPortOptions = {}): TgFomoPort {
  const now = opts.now ?? Date.now;
  const maxChars = Math.max(200, Math.min(TG_FOMO_MAX_CHARS, Math.trunc(opts.maxChars ?? TG_FOMO_MAX_CHARS)));
  const log = opts.log ?? (() => {});
  const buyable = (s: string): boolean => {
    try {
      return opts.buyable?.(s) === true;
    } catch {
      return false;
    }
  };
  /** The conversation keys used per chat, so the owner's chat-wide forget reaches every topic. Bounded. */
  const keysByChat = new Map<number, Set<string>>();
  const remember = (chatId: number, key: string): void => {
    let keys = keysByChat.get(chatId);
    if (!keys) {
      if (keysByChat.size >= 512) keysByChat.delete(keysByChat.keys().next().value!);
      keys = new Set();
      keysByChat.set(chatId, keys);
    }
    if (keys.size < 64) keys.add(key);
  };

  const brokerNow = (): FomoBroker | null => {
    try {
      return broker() ?? null;
    } catch {
      return null;
    }
  };

  return {
    async ask(q): Promise<TgFomoAnswer | null> {
      try {
        if (!q || !isUsableChatId(q.chatId)) return null;
        // One trader is never answered in a room: deflected before anything is planned or spent.
        if (q.request?.kind === "trader") return { text: TG_FOMO_DEFLECTION, deflect: true };
        const text = q.request ? requestText(q.request) : typeof q.text === "string" ? q.text : null;
        if (!text || !text.trim()) return null;
        const b = brokerNow();
        const t = now();
        // The bot's own @username and names (trusted: from getMe and the
        // soul, via the handler), so "@thisbot theses on $PONS?" is a coin
        // question and not a question about a trader called thisbot.
        const selfNames = selfNamesOf(q.selfNames);
        if (!b) {
          // Honest about it, but only for a question the research would have taken.
          return classifyFomoQuestion(text, { memory: null, now: t, selfNames }) ? { text: TG_FOMO_UNAVAILABLE, deflect: false } : null;
        }
        const conversationKey = tgGroupConversationKey(q.chatId, q.threadId);
        const timeoutMs = typeof q.timeoutMs === "number" && Number.isFinite(q.timeoutMs) ? Math.max(1, Math.min(q.timeoutMs, 30_000)) : 25_000;
        const bounded = boundedBroker(b, timeoutMs);
        const r = await answerFomoQuestion({
          text,
          broker: bounded.broker,
          now: t,
          surface: "telegram-group",
          audience: "group",
          conversationKey,
          // The trusted chat id: per-group budgets are keyed on it, and a
          // group charge without it is refused (fail closed).
          groupId: String(q.chatId),
          maxChars,
          selfNames,
        }).finally(() => bounded.done());
        if (!r.handled) return null;
        remember(q.chatId, conversationKey);
        if (r.text.trim() === GROUP_DM_DEFLECTION) {
          log("[tg-fomo] group ask deflected");
          // HER ASK ABOUT ONE TRADER goes to her DM (handler.ts): the handle
          // as the planner read it, never for anyone else, never for a
          // structured request (the router names its own) or the owner's state.
          const trader = q.owner === true && !q.request ? traderAsked(r.plan) : null;
          return trader ? { text: TG_FOMO_DEFLECTION, deflect: true, trader } : { text: TG_FOMO_DEFLECTION, deflect: true };
        }
        log(`[tg-fomo] group ask answered (${r.toolsCalled.length} lookup(s))${q.request ? " (routed)" : ""}`);
        const said: TgFomoAnswer = { text: groupScrub(groupWords(groupScrub(r.text))), deflect: false };
        // Her moves, only when she asked: the trusted sender id (handler.ts), never a chat.
        if (q.owner === true) {
          let moves: TgFomoMoves | null = null;
          try {
            moves = ownerMoves(r, buyable);
          } catch {
            moves = null;
          }
          if (moves) said.moves = moves;
        }
        return said;
      } catch {
        log("[tg-fomo] group ask failed");
        return null;
      }
    },
    async forget(chatId: number): Promise<void> {
      const keys = keysByChat.get(chatId);
      keysByChat.delete(chatId);
      const b = brokerNow();
      if (!b) return;
      // Topic 0 always: a forget after a restart must still reach the room's main thread.
      const all = new Set([...(keys ?? []), tgGroupConversationKey(chatId)]);
      for (const k of all) {
        try {
          await b.memory.clear(k);
        } catch {
          /* subject memory expires on its own (30 minutes) */
        }
      }
    },
  };
}
