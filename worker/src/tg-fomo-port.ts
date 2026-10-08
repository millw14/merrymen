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
 * WHAT A GROUP NEVER HEARS. The planner deflects a question about the
 * owner's own research state, or who Merrymen watches, before anything is
 * spent; the renderer gives a group coin-level aggregates (no wallets,
 * addresses, links, cashtags or quoted third-party text, money in short
 * form) and scrubs the result. Traders a group hears named are Fomo's public
 * ones: the leaderboard's handles and their P&L, and ONE NAMED TRADER'S
 * PUBLIC DATA, for anyone who asks, the owner included (who they are, what
 * they hold, what they traded, what they made or lost money on,
 * provider-reported), never as @mentions and never whether Merrymen watches
 * or follows them (Milla's calls, 2026-10-07). A group answer carries no source line and no
 * skill caveat: the room has had a post about where the data comes from
 * (Milla, 2026-10-07), so the renderer leaves both to the owner's answers.
 * This file rewrites the renderer's fixed wording into words the group gate
 * admits (no money figure for the feed's size floor, no "P&L"). The handler
 * still gates every line before it is sent, as a `research` line, and drops
 * what the gate refuses rather than bending the gate.
 *
 * NO MODEL HERE. A group answer is deterministic: no compose, so no model
 * can be talked into wording a trader's wallet into a room. The one model
 * step a room's research answer may take is the group model's paraphrase of
 * a coin's theses (tg-groups/theses.ts, decision D5): this port hands it
 * cleaned, fenced material (thesesMaterial), never an identity, and the
 * code-written digest is what the room hears whenever that step cannot run
 * or its phrases do not pass.
 */

import type { FomoBroker } from "./fomo/contract";
import { answerFomoQuestion, type AnswerFomoResult } from "./fomo/chat";
import { contentFree } from "./fomo/digest";
import { redactExecutables } from "./fomo/dossier";
import { chainFromUserText, isRobinhoodToken } from "./fomo/identity";
import { classifyFomoQuestion, type FomoQuestionPlan } from "./fomo/intent";
import { FOMO_ATTRIBUTION, FOMO_GROUP_OFF, GROUP_DM_DEFLECTION, GROUP_THESES_HEAD, GROUP_THESES_TAIL, groupScrub, NOT_PERMISSION_LINE } from "./fomo/render";
import type { OpportunitiesData, RankingsData, ResearchCoinData, ThesisView, TokenActivityData, TokenThesesData } from "./fomo/tools";
import type { FomoEnvelope, TokenIdentity, TokenLabel } from "./fomo/types";
import type { TgFomoAnswer, TgFomoChain, TgFomoMoves, TgFomoPort, TgFomoRequest, TgThesesMaterial } from "./telegram/tg-groups/types";

/** The most a group answer may run to, before the handler's own line gate. */
export const TG_FOMO_MAX_CHARS = 600;

/** NOT_PERMISSION_LINE in group words: the original names a dashboard setting, which the group gate refuses. */
export const TG_FOMO_NOT_PERMISSION = "This is research, not a signal to buy or sell.";

/**
 * A question a group never hears answered: the owner's own research state,
 * who Merrymen watches, or a trader's own theses. GROUP_DM_DEFLECTION says
 * "I'll answer that in a direct message", and nothing here sends that
 * message, so the room is told where the question belongs instead of being
 * promised an answer.
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
  /**
   * Whether a tail can work here (index.ts: tails switched on and the hosted
   * live feed). False: the owner's moves offer no `/tail`. Absent: true.
   */
  tailsAvailable?: () => boolean;
}

// ─── A model's checked choice, as the planner's own question ───────────────

const TICKER = /^[A-Z0-9][A-Z0-9_-]{0,19}$/;

/**
 * A request's chain in the planner's own chain words (fomo/identity.ts
 * chainFromUserText, after "on"): ethereum is "eth" there. Anything else
 * names no chain, and the list is asked for across every chain.
 */
const CHAIN_WORDS: Readonly<Record<TgFomoChain, string>> = { robinhood: "robinhood", solana: "solana", base: "base", ethereum: "eth", bsc: "bsc" };
const onChain = (c: unknown): string => (typeof c === "string" && Object.hasOwn(CHAIN_WORDS, c) ? ` on ${CHAIN_WORDS[c as TgFomoChain]}` : "");

/** A leaderboard row in the planner's own rank words (intent.ts ROW_RANK). */
const ROW_WORDS: Readonly<Record<number, string>> = { 1: "top", 2: "second best", 3: "third best", 4: "fourth best" };
/** What about that row, in words the planner reads as that one-trader question (intent.ts rowAskOf). */
const ROW_ABOUT: Readonly<Record<string, string>> = {
  earnings: " and what did he make money on?",
  holdings: " and what is he holding?",
  trades: " and what has he been trading?",
  profile: "? tell me about him",
};
/** A Fomo handle the planner reads as one trader ("trader X"). */
const TRADER_HANDLE = /^[A-Za-z0-9_]{2,30}$/;
const whenWords = (w: unknown, fallback: string): string => (w === "24h" ? "today" : w === "7d" ? "this week" : w === "30d" ? "this month" : w === "all" ? "of all time" : fallback);

/**
 * THE FIXED QUESTION FOR A REQUEST. Each one plans exactly the intended read
 * through the deterministic planner (tg-fomo-port.test.ts pins every one), so
 * the model's choice reaches the provider only as that planner's arguments.
 * Null: nothing to ask (a ticker or a handle that is not one).
 */
export function requestText(r: TgFomoRequest): string | null {
  switch (r.kind) {
    case "leaderboard": {
      const when = r.window === "7d" ? "this week" : r.window === "30d" ? "this month" : r.window === "all" ? "of all time" : "in the last 24h";
      const row = r.row;
      if (row && Object.hasOwn(ROW_WORDS, row.rank) && Object.hasOwn(ROW_ABOUT, row.about)) return `who is the ${ROW_WORDS[row.rank]} trader on fomo ${when}${ROW_ABOUT[row.about]}`;
      return `who are the top traders on fomo ${when}?`;
    }
    case "board": {
      const on = onChain(r.chain);
      return r.board === "graduated" ? `what are the newly graduated coins on fomo${on}?` : r.board === "most-held" ? `what are the most held coins on fomo${on}?` : `what's trending on fomo${on}?`;
    }
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
      return `what are traders ${r.side === "sell" ? "selling" : "buying"} on fomo${when}${onChain(r.chain)}?`;
    }
    case "small-coins":
      return `what small coins are getting attention on fomo${onChain(r.chain)}?`;
    case "about":
      return "what can you do with fomo?";
    case "status":
      return "is fomo working?";
    case "trader": {
      // One trader, by the handle the line wrote (route.ts groundedTrader),
      // answered in the room (Milla, 2026-10-07).
      const h = String(r.handle ?? "").replace(/^@+/, "");
      if (!TRADER_HANDLE.test(h)) return null;
      switch (r.about) {
        case "holdings":
          return `what is trader ${h} holding on fomo?`;
        case "trades":
          return `what has trader ${h} been trading on fomo ${whenWords(r.window, "this week")}?`;
        case "earnings":
          return `what did trader ${h} make money on on fomo ${whenWords(r.window, "this week")}?`;
        default:
          return `who is trader ${h} on fomo?`;
      }
    }
    default:
      return null;
  }
}

// ─── A coin the planner could not place ─────────────────────────────────────

/**
 * Where a coin's name goes in a question about one coin: "who's selling pons",
 * "what's happening with pons", "research pons". Group 1 is the word there.
 */
const LOOSE_SUBJECT =
  /\b(?:selling|sold|sells|buying|bought|buys|dumping|dumped|aping|aped|accumulating|accumulated|loading up on|holding|holds|happening with|going on with|up with|research|researching|look into|looking into|dig into|digging into|analy[sz]e|analy[sz]ing|thoughts on|theses (?:on|for|about)|thesis (?:on|for|about)|saying about|think (?:of|about))\s+\$?([a-z][a-z0-9]{1,15})\b/iu;
/** Words that sit there without being a coin: "who's selling on fomo", "who's buying rn". */
const NOT_A_COIN = new Set(
  ("on in at it its this that the a an now rn today tonight lately recently right fomo coin coins token tokens anything " +
    "something everything stuff what which here there too more much most any some these those them him her me us you up off " +
    "out into and or with for from to by hard heavy big so again still yet all fast early late already just really even " +
    "also lol bro guys rn atm currently market memes memecoins traders people everyone everybody whales one ones").split(" "),
);
/** Intents whose subject is one coin, or the whole feed when none is named. */
const COIN_SUBJECT_INTENTS: ReadonlySet<string> = new Set([
  "token-activity", "token-buyers", "token-sellers", "token-theses", "research-coin", "words-vs-actions", "changes-since",
]);

/**
 * A GROUP QUESTION ABOUT A COIN THE PLANNER COULD NOT PLACE. The planner
 * reads a coin from a $tag, an UPPERCASE ticker or a name at the end ("about
 * pepe"); "who's selling pons on fomo?" names none of those, so its plan is
 * the whole feed's sellers, and "research pons on fomo" asks "which coin?".
 * Either answers a different question than the one asked (rule 5). Such a
 * plan is not taken here: the line goes on to the router, whose one call
 * names the coin from the line's own words (route.ts groundedCoin), and its
 * fixed question names it as a $tag. True: leave the line to the router.
 */
export function looseCoin(text: string, plan: FomoQuestionPlan): boolean {
  // A coin or trader this message named is the planner's own reading.
  if (!COIN_SUBJECT_INTENTS.has(plan.intent) || plan.subjects.some((s) => s.kind === "token" || s.kind === "trader")) return false;
  if (plan.toolCalls.some((c) => typeof c.args.trader === "string")) return false;
  const m = LOOSE_SUBJECT.exec(typeof text === "string" ? text.normalize("NFKC") : "");
  const word = m?.[1]?.toLowerCase() ?? "";
  if (!word || NOT_A_COIN.has(word) || /^\d+$/.test(word)) return false;
  // A chain word is the planner's ("buying solana coins" is a chain's slice).
  if (chainFromUserText(word) !== null) return false;
  // The remembered coin, when that is the word ("who's selling pons" right
  // after PONS): the planner has it right. Any other remembered coin is the
  // wrong subject for a line that names a different one.
  return !plan.toolCalls.some((c) => typeof c.args.token === "string" && c.args.token.toLowerCase() === word);
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

/**
 * How an answer's lookups went (TgFomoAnswer.status): something real read,
 * or nothing needed reading, is "ok"; otherwise the most telling refusal.
 * A coin the provider does not know, or a subject to clarify, is an answer.
 */
export function answerStatus(envelopes: readonly FomoEnvelope[]): NonNullable<TgFomoAnswer["status"]> {
  if (envelopes.length === 0) return "ok";
  const has = (...st: string[]): boolean => envelopes.some((e) => st.includes(e.status));
  if (has("ok", "partial", "capped", "stale")) return "ok";
  if (has("empty")) return "empty";
  if (has("not-found", "needs-clarification")) return "ok";
  if (has("budget-limited")) return "budget-limited";
  if (has("unavailable", "not-authorized")) return "unavailable";
  return "failed";
}

const firstAnswered = (r: Extract<AnswerFomoResult, { handled: true }>): FomoEnvelope | null =>
  r.envelopes.find((e) => (e.status === "ok" || e.status === "partial" || e.status === "capped" || e.status === "stale") && e.data !== null) ?? null;

/**
 * HER NEXT MOVES, written by code from the answer's own rows: for traders,
 * the questions that open their book; for coins, /buy (only when /buy
 * resolves for this agent), the CA to post for a review, watch and theses.
 * Null for anything else, or when no row has a usable name.
 */
export function ownerMoves(r: AnswerFomoResult, buyable: (s: string) => boolean = () => false, tails = true): TgFomoMoves | null {
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
        // /tail asks first (a confirm card in this DM), then tells her what
        // they buy, sell or post for those hours (docs/fomo.md "Tailing a
        // trader"). DM only: the room hears none of this. Never offered
        // where a tail cannot work (switched off, or no live feed here).
        const tail = tails && h.length >= 2 ? ` · <code>/tail ${e} 3h</code>` : "";
        lines.push(`• <code>what is trader ${e} holding</code> · <code>what has trader ${e} bought this week</code>${tail}`);
      }
      if (tails) lines.push("/tail asks you first, then tells you here what they buy, sell or post for those hours.");
      return { kind: "traders", room: "sent the trade moves for these to your DM.", dm: lines.join("\n") };
    }
    // Robinhood Chain coins first, the shown ones and then the board's best
    // placed ones (RankingsData.robinhood): the chain she can act on is never
    // crowded out of her moves by three "not tradeable from here" rows.
    const rows = [...d.tokens.filter((t) => isRobinhoodToken(t.token)), ...(d.robinhood?.top ?? []), ...d.tokens];
    const coins: MoveCoin[] = [];
    for (const t of rows) {
      const c = coinOf(t.token, t.label);
      if (c && coins.length < MOVES_ROWS && !coins.some((x) => (x.token?.key ?? x.symbol) === (c.token?.key ?? c.symbol))) coins.push(c);
    }
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

// ─── A coin's theses, for the group model's paraphrase ──────────────────────

/** At most this many samples, one per family, each at most this long; fewer than the minimum is no material. */
export const THESES_SAMPLES_MAX = 12;
export const THESES_SAMPLE_CHARS = 160;
export const THESES_SAMPLES_MIN = 3;

/**
 * A row written at a model, not about a coin ("ignore all previous
 * instructions…", "you are now…", "system:"): dropped whole, never cleaned.
 */
const INJECTION_SHAPED =
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.!?\n]{0,40}\b(?:instructions?|prompts?|rules|previous|above|system|guidelines)\b|\b(?:system|developer|assistant)\s*(?:prompt|message|:)|\byou\s+are\s+(?:now\s+)?(?:an?\s+)?(?:[a-z]+\s+){0,2}(?:ai|assistant|bot|model|chatbot)\b|\bact\s+as\b|\bjailbreak|\bprompt\b|\btell\s+(?:the|this)\s+(?:group|chat|room)\b/i;
/** A lure, not a view: a claim page, a seed phrase, a wallet to connect. */
const LURE = /\b(?:airdrops?|claim(?:ing|s)?|presale|whitelist|seed\s*phrase|private\s*key|connect\s+(?:your\s+)?wallet|dm\s+me)\b/i;

/**
 * One thesis as a sample the group model may read: their words with every
 * link, address, handle and $tag taken out, no fence characters, at most
 * THESES_SAMPLE_CHARS. Null for a row with nothing left to say, or one shaped
 * as an instruction or a lure.
 */
export function thesesSample(text: unknown): string | null {
  if (typeof text !== "string") return null;
  let s = groupScrub(redactExecutables(text.normalize("NFKC")))
    .replace(/\[(?:link|address|handle|someone)\]/g, " ")
    .replace(/[\u0000-\u001f\u007f`<>{}[\]|\\]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,.;:!?])(?:\s*[,.;:!?])+/g, "$1")
    .replace(/^[\s,.;:!?-]+/, "")
    .trim();
  if (!s || contentFree(s) || INJECTION_SHAPED.test(s) || LURE.test(s)) return null;
  if (s.length > THESES_SAMPLE_CHARS) s = `${s.slice(0, THESES_SAMPLE_CHARS - 1).replace(/\s+\S*$/, "")}…`;
  return s;
}

const likesOf = (v: ThesisView): number => (typeof v.likes === "number" && Number.isFinite(v.likes) ? v.likes : -1);
const postedOf = (v: ThesisView): number => (typeof v.postedAt === "number" && Number.isFinite(v.postedAt) ? v.postedAt : -1);

/**
 * THE MATERIAL FOR A ROOM'S THESIS PARAPHRASE (tg-groups/theses.ts): only for
 * one coin's theses answered on their own, with at least THESES_SAMPLES_MIN
 * usable samples. Never a trader's theses (those are deflected), never a
 * compound answer, never the coin's dev's own posts.
 */
export function thesesMaterial(r: AnswerFomoResult, text: string): TgThesesMaterial | null {
  if (!r.handled || r.envelopes.length !== 1) return null;
  const env = r.envelopes[0]!;
  if (env.tool !== "fomo_get_token_theses" || !["ok", "partial", "capped", "stale"].includes(env.status)) return null;
  const d = env.data as TokenThesesData | null;
  if (!d || !d.token || d.trader || !Array.isArray(d.theses)) return null;
  const at = env.freshness.retrievedAt;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  const coin = String(d.label?.symbol ?? "").replace(/^\$+/, "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 20);
  const lines = text.split("\n");
  const h = lines.findIndex((l) => l.startsWith(GROUP_THESES_HEAD));
  const t = lines.findIndex((l) => l.startsWith(GROUP_THESES_TAIL));
  if (h < 0 || t <= h) return null;
  const byFamily = new Map<string, ThesisView>();
  for (const v of d.theses) {
    if (!v || v.isDev === true) continue;
    const cur = byFamily.get(v.family);
    if (!cur || likesOf(v) > likesOf(cur) || (likesOf(v) === likesOf(cur) && postedOf(v) > postedOf(cur))) byFamily.set(v.family, v);
  }
  const samples: string[] = [];
  const reps = [...byFamily.values()].sort((a, b) => likesOf(b) - likesOf(a) || postedOf(b) - postedOf(a));
  for (const v of reps) {
    if (samples.length >= THESES_SAMPLES_MAX) break;
    const s = thesesSample(v.excerpt);
    if (s && !samples.includes(s)) samples.push(s);
  }
  if (samples.length < THESES_SAMPLES_MIN) return null;
  return { key: `${d.token.key}@${Math.trunc(at)}`, coin, head: lines.slice(0, h + 1), tail: lines.slice(t), fallback: text, samples };
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
  const tailsAvailable = (): boolean => {
    try {
      return opts.tailsAvailable ? opts.tailsAvailable() === true : true;
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
        const text = q.request ? requestText(q.request) : typeof q.text === "string" ? q.text : null;
        if (!text || !text.trim()) return null;
        const b = brokerNow();
        const t = now();
        // The bot's own @username and names (trusted: from getMe and the
        // soul, via the handler), so "@thisbot theses on $PONS?" is a coin
        // question and not a question about a trader called thisbot.
        const selfNames = selfNamesOf(q.selfNames);
        // A line (never a routed request, whose coin the router grounded) is
        // left to the router when it asks about a coin the planner could not
        // place (looseCoin).
        let loose = false;
        const wanted = q.request ? undefined : (plan: FomoQuestionPlan): boolean => !(loose = looseCoin(text, plan));
        if (!b) {
          // Honest about it, but only for a question the research would have taken.
          const plan = classifyFomoQuestion(text, { memory: null, now: t, selfNames });
          return plan && (!wanted || wanted(plan)) ? { text: TG_FOMO_UNAVAILABLE, deflect: false, status: "unavailable" } : null;
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
          ...(wanted ? { wanted } : {}),
        }).finally(() => bounded.done());
        if (!r.handled) {
          if (loose) log("[tg-fomo] group ask left to the router (a coin the planner could not place)");
          return null;
        }
        remember(q.chatId, conversationKey);
        if (r.text.trim() === GROUP_DM_DEFLECTION) {
          log("[tg-fomo] group ask deflected");
          const free = r.toolsCalled.length === 0;
          return { text: TG_FOMO_DEFLECTION, deflect: true, ...(free ? { free } : {}) };
        }
        log(`[tg-fomo] group ask answered (${r.toolsCalled.length} lookup(s))${q.request ? " (routed)" : ""}`);
        const said: TgFomoAnswer = { text: groupScrub(groupWords(groupScrub(r.text))), deflect: false, status: answerStatus(r.envelopes) };
        // A coin's theses: material for the group model to say in its own words (tg-groups/theses.ts).
        const theses = thesesMaterial(r, said.text);
        if (theses) said.theses = theses;
        // Her moves, only when she asked: the trusted sender id (handler.ts), never a chat.
        if (q.owner === true) {
          let moves: TgFomoMoves | null = null;
          try {
            moves = ownerMoves(r, buyable, tailsAvailable());
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
