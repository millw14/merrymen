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
 * form) and scrubs the result. The one exception is a coin's theses asked
 * for themselves ("list the last 10", "don't summarise"; Milla, 2026-10-09):
 * up to ten of the newest, each cleaned, cut short, checked here and gated as
 * a `quote` by the handler, dropped and never repaired (thesesQuotes). Never
 * a trader's own theses, which a room never hears. Traders a group hears named are Fomo's public
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

import { createHash } from "node:crypto";

import type { FomoBroker } from "./fomo/contract";
import { answerFomoQuestion, type AnswerFomoResult } from "./fomo/chat";
import { contentFree } from "./fomo/digest";
import { agoText, redactExecutables } from "./fomo/dossier";
import { chainFromUserText, isRobinhoodToken } from "./fomo/identity";
import { classifyFomoQuestion, type FomoQuestionPlan } from "./fomo/intent";
import { deserialize, rememberedSubjects, serialize, type SubjectMemory } from "./fomo/subject-memory";
import { chainLabel, FOMO_ATTRIBUTION, FOMO_GROUP_OFF, GROUP_DM_DEFLECTION, GROUP_FOMO_UNREACHED, GROUP_THESES_HEAD, GROUP_THESES_TAIL, groupRefusalLine, groupScrub, NOT_PERMISSION_LINE } from "./fomo/render";
import { collapseOf, type CoinFacts, type CoinFactsReader, type FactsNetwork } from "./coin-facts-types";
import type { OpportunitiesData, RankingsData, ResearchCoinData, ThesisView, TokenActivityData, TokenThesesData } from "./fomo/tools";
import type { FomoEnvelope, ResolvedSubject, TokenIdentity, TokenLabel } from "./fomo/types";
import { admitTgLine, quoteNotEnglish, tgLineReadings, tgQuoteLeetReadings } from "./telegram/tg-groups/gate";
import {
  ABOUT_MERRYMEN,
  AT_THE_READER,
  CONTACT_LURE,
  CTA_PLACEHOLDER,
  INJECTION_SHAPED,
  LURE,
  NON_LATIN,
  NOT_ENGLISH,
  OUT_ACCUSE,
  OUT_HANDOUT,
  OUT_LURE,
  PERSON_HARM,
  POST_RUG_LURE,
  PRIVATE_THIRD,
  QUOTE_HARM,
  QUOTE_TARGET,
  RUG_CONTEXT_ACCUSE,
  SECOND_PERSON,
  SEND_FOR,
  SPELLED_DOMAIN,
  SPELLED_LINK,
} from "./telegram/tg-groups/third-party";
import type { TgFomoAnswer, TgFomoChain, TgFomoMoves, TgFomoPort, TgFomoRequest, TgThesesMaterial, TgThesesQuotes } from "./telegram/tg-groups/types";

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
  /**
   * A coin's measured market facts (desk/facts.ts, index.ts wires it with its
   * per-chat and per-agent bounds). Absent: a facts request is not answered
   * here (null), and the handler's line goes on as before.
   */
  facts?: CoinFactsReader;
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
const ROW_WORDS: Readonly<Record<number, string>> = {
  1: "top", 2: "second best", 3: "third best", 4: "fourth best", 5: "fifth best",
  6: "sixth best", 7: "seventh best", 8: "eighth best", 9: "ninth best", 10: "tenth best",
};
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
      if (row && Object.hasOwn(ROW_WORDS, row.rank) && Object.hasOwn(ROW_ABOUT, row.about)) {
        // A trades ask keeps its side ("and what has he been selling?"), which the planner reads as the row's.
        const about = row.about === "trades" && (row.side === "sell" || row.side === "buy") ? ` and what has he been ${row.side === "sell" ? "selling" : "buying"}?` : ROW_ABOUT[row.about];
        return `who is the ${ROW_WORDS[row.rank]} trader on fomo ${when}${about}`;
      }
      return `who are the top traders on fomo ${when}?`;
    }
    case "board": {
      const on = onChain(r.chain);
      return r.board === "graduated" ? `what are the newly graduated coins on fomo${on}?` : r.board === "most-held" ? `what are the most held coins on fomo${on}?` : `what's trending on fomo${on}?`;
    }
    case "coin": {
      const s = String(r.symbol ?? "").replace(/^\$+/, "").toUpperCase();
      if (!TICKER.test(s)) return null;
      const on = onChain(r.chain);
      switch (r.aspect) {
        case "theses": {
          // The theses themselves, when the line asked for them (detect.ts thesesQuotesOf; never a model).
          const n = quoteCount(r.quotes);
          return n ? `quote the newest ${n} theses on $${s}${on} on fomo` : `what are the theses on $${s}${on} on fomo?`;
        }
        case "buyers":
          return `who's buying $${s}${on} on fomo?`;
        case "sellers":
          return `who's selling $${s}${on} on fomo?`;
        case "research":
          return `research $${s}${on} on fomo`;
        case "facts":
          // What happened to a coin is measured market data (createTgFomoPort: opts.facts), never a Fomo question.
          return null;
        default:
          return `what's happening with $${s}${on} on fomo?`;
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
        case "trades": {
          // The side the line named ("what did X sell"), which the planner reads as that side.
          const verb = r.side === "sell" ? "selling" : r.side === "buy" ? "buying" : "trading";
          return `what has trader ${h} been ${verb} on fomo ${whenWords(r.window, "this week")}?`;
        }
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

/** A quote count as a request may carry it: 1 to 10, else none. */
function quoteCount(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1 ? Math.min(v, QUOTES_MAX) : null;
}

/** A token's chain slug as tg-groups names chains; anything else names none. */
const SLUG_CHAINS: Readonly<Record<string, TgFomoChain>> = { robinhood: "robinhood", solana: "solana", base: "base", eth: "ethereum", ethereum: "ethereum", bsc: "bsc" };
export function tgChainOf(slug: unknown): TgFomoChain | undefined {
  return typeof slug === "string" && Object.hasOwn(SLUG_CHAINS, slug) ? SLUG_CHAINS[slug] : undefined;
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

// ─── A trader the planner could not place ───────────────────────────────────

/**
 * A pointer at the remembered trader: a pronoun ("his pnl", "what are they
 * holding"), or "this/that/the same/said trader, guy, person, account".
 */
const TRADER_POINTER =
  /\b(?:he|she|him|his|her|hers|they|them|their|theirs|he's|she's|they're|hes|shes|theyre)\b|\b(?:this|that|the same|same|said|the) (?:trader|guy|person|account|user|dude|degen)(?:'s)?\b/iu;
/** Where a trader's name goes in a one-trader question; group 1 is the word there. */
const TRADER_SLOTS: readonly RegExp[] = [
  /\bhow(?:'s|s|\s+is|\s+has|\s+was)\s+@?([a-z0-9_]{2,30})\s+(?:been\s+)?(?:doing|done|performing|trading)\b/iu,
  /\bwhat(?:'s|s|\s+is|\s+has|\s+was)\s+@?([a-z0-9_]{2,30})\s+(?:been\s+)?(?:holding|buying|selling|trading|aping|bought|sold|traded|up\s+to|making|made|losing|lost)\b/iu,
  /\bwhat\s+(?:does|did|do)\s+@?([a-z0-9_]{2,30})\s+(?:hold|own|buy|sell|trade|make|lose|ape)\b/iu,
  /\bis\s+@?([a-z0-9_]{2,30})\s+(?:any\s+good|good|legit|profitable|up|down|still\s+holding|holding)\b/iu,
  /\b(?:tell\s+me\s+about|who\s+is|who's|whos|look\s+up|what\s+about|how\s+about)\s+@?([a-z0-9_]{2,30})\b/iu,
  /(?<![\p{L}\p{N}_])@?([a-z0-9_]{2,30})(?:'s|s')\s+(?:pnl|p&l|bags?|holdings|trades|stats|positions|portfolio|book|moves|profile|performance|earnings)\b/iu,
  /(?<![\p{L}\p{N}_])@?([a-z0-9_]{2,30})\s+(?:pnl|p&l|stats)\b/iu,
];
/** A board's rank asked for ("whos the worst trader on fomo today"): never the remembered trader. */
const RANK_ASKED = /\b(?:best|worst|top|biggest|richest|smartest|number\s+one|#\s*1)\s+(?:\w+\s+)?traders?\b|\btraders?\s+(?:leaderboard|board|rankings?)\b/iu;
/** Words that sit where a name goes without being one. */
const NOT_A_TRADER = new Set(
  ("he she him his her hers they them their it its this that the a an my me you your yours our we us i fomo trader traders guy person " +
    "account user dude degen one someone anyone everyone everybody people today now rn lately recently there here what who which " +
    "doing going up down the pnl stats board market coin coins token tokens anything something everything things stuff").split(" "),
);

/**
 * A GROUP LINE THAT NAMES ANOTHER TRADER THAN THE REMEMBERED ONE. The planner
 * reads a trader from "trader X" or an @handle; "how is ansem doing on fomo
 * today" names neither, so right after frankdegods its plan is frankdegods'
 * (the remembered trader, taken because the question needs one), and the
 * room hears one member's earlier subject answer another member's question
 * about someone else (rule 5). Such a plan is not taken: the line goes to
 * the router, whose one call reads the name from the line itself (route.ts
 * groundedTrader). Only when the trader came from memory with nothing
 * pointing at them (no "he", "his", "this trader"), on a line that is not a
 * pure follow-up ("and this week?"), and either a word sits where a trader's
 * name goes that is not the remembered one, a bot's name, a chain or filler,
 * or the line asks for a board's rank. True: leave the line to the router.
 */
export function looseTrader(text: string, plan: FomoQuestionPlan, memory: SubjectMemory | null, selfNames: readonly string[] = [], now = Date.now()): boolean {
  if (!plan.usesMemory.includes("trader") || plan.usesMemory.includes("intent")) return false;
  const t = typeof text === "string" ? text.normalize("NFKC").replace(/[‘’ʼ]/gu, "'") : "";
  if (TRADER_POINTER.test(t)) return false;
  if (RANK_ASKED.test(t)) return true;
  const remembered = new Set(
    rememberedSubjects(memory, "trader", now).flatMap((s) => (s.kind === "trader" && typeof s.handle === "string" ? [s.handle.replace(/^@+/, "").toLowerCase()] : [])),
  );
  const selves = new Set(selfNames.flatMap((n) => (typeof n === "string" ? n.toLowerCase().replace(/^@+/, "").split(/\s+/) : [])));
  for (const re of TRADER_SLOTS) {
    const word = re.exec(t)?.[1]?.toLowerCase() ?? "";
    if (!word || NOT_A_TRADER.has(word) || /^\d+$/.test(word) || selves.has(word) || chainFromUserText(word) !== null) continue;
    if (!remembered.has(word)) return true;
  }
  return false;
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

/** The ranks a trader board's rows carry as they are said ("2. frankdegods +$1.2k"). */
function boardRanksIn(text: string): number[] {
  return [...text.matchAll(/^(\d{1,3})\. /gmu)].map((m) => Number(m[1])).filter((n) => Number.isSafeInteger(n) && n >= 1);
}

// ─── A coin's theses, for the group model's paraphrase ──────────────────────

/** At most this many samples, one per family, each at most this long; fewer than the minimum is no material. */
export const THESES_SAMPLES_MAX = 12;
export const THESES_SAMPLE_CHARS = 160;
export const THESES_SAMPLES_MIN = 3;

/*
 * INJECTION_SHAPED, AT_THE_READER, LURE, SPELLED_DOMAIN, ABOUT_MERRYMEN and
 * NON_LATIN live in tg-groups/third-party.ts (moved unchanged, 2026-10-09),
 * shared with the paraphrase's checks and the gate's `quote` kind.
 */

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
  if (!s || contentFree(s) || NON_LATIN.test(s)) return null;
  // Read as the group gate reads a line (lookalikes folded, invisible
  // characters gone, spelled-out letters joined), so "frее tоkens" with
  // Cyrillic letters or "instruc\u200btions" is the row it is (review r4).
  const reads = [s, ...tgLineReadings(s)];
  if ([INJECTION_SHAPED, AT_THE_READER, LURE, ABOUT_MERRYMEN, SPELLED_DOMAIN].some((re) => reads.some((r) => re.test(r)))) return null;
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
  // Keyed by the coin, the copy AND the samples read: the window and limit are
  // applied after the cached page is read, so "the last hour" and "all of it"
  // share a copy but not their theses, and a wording of one is never said
  // under the other's header (review r4).
  const read = createHash("sha256").update(samples.join("\n")).digest("hex").slice(0, 16);
  return { key: `${d.token.key}@${Math.trunc(at)}#${read}`, coin, head: lines.slice(0, h + 1), tail: lines.slice(t), fallback: text, samples };
}

// ─── A coin's theses, quoted (Milla, 2026-10-09) ───────────────────────────

/** The most theses a room hears quoted, and how long each may run. */
export const QUOTES_MAX = 10;
export const QUOTE_CHARS = 160;
const QUOTE_SENTENCES = 3;

/**
 * One thesis as a quote a room may hear, or null: LEFT OUT, never repaired.
 * The coin's dev's own posts, a call to action beside a link taken out, any
 * row a link or an address was taken out of, and anything the sample cleaner drops (links, addresses, handles and $tags out;
 * injection shapes, rows at the reader, lures, Merrymen, spelled domains and
 * other scripts dropped) never become one. What is left is cut (three
 * sentences, QUOTE_CHARS: a length cut, judged as cut), checked against the
 * third-party clauses, framed with a sayable handle or "a trader" and its age,
 * and judged by the group gate as the `quote` kind, as the handler will.
 */
function quoteOf(v: ThesisView, coin: string, now: number): { who: string; age: string; text: string } | null {
  if (!v || v.isDev === true || typeof v.excerpt !== "string") return null;
  const raw = v.excerpt.normalize("NFKC");
  if ([raw, ...tgLineReadings(raw)].some((t) => CTA_PLACEHOLDER.test(t))) return null;
  // A link or an address taken out leaves a remnant that still points at it ("[link] is the new site").
  if (/\[(?:link|address)\]/iu.test(raw)) return null;
  let s = thesesSample(raw);
  if (!s) return null;
  // An @ the redactor left (glued to a word: "chat@autonholders", "cl@im",
  // "@ name") is a handle or a disguised word: left out, never repaired, so
  // the gate's handle clause is never blinded by an @ turned into a space.
  if (/[@＠﹫]/u.test(s)) return null;
  // PLAIN LETTERS ONLY (review r2), the paraphrase's plain-ASCII rule for
  // quotes: with accents taken off, a letter outside a-z ("honeypøt", "scɑm",
  // "kiłł", "ɡrifter") or a digit written for a letter inside a word
  // ("d1ck", "p0rn", "cla1m", "appr0ve"; never "a16z", "web3", "24h" or the
  // coin's own symbol) leaves the quote out, never repaired: no clause has
  // to know every word such a spelling hides.
  const plain = s.normalize("NFKD").replace(/\p{M}/gu, "");
  if (/(?=\p{L})[^a-zA-Z]/u.test(plain)) return null;
  const own = coin.toLowerCase();
  if (plain.split(/[^\p{L}\p{N}]+/u).some((w) => w.toLowerCase() !== own && /(?<=\p{L})[013457](?=\p{L})/u.test(w))) return null;
  s = s
    // The signs that are markup, never words: a hashtag's #, bold and strike marks.
    .replace(/[#＃]+/gu, " ")
    .replace(/\*+|_{2,}|~{2,}/gu, " ")
    .replace(/["“”«»„]/gu, "'")
    .replace(/\s+/gu, " ")
    .replace(/\s+([,.;:!?…])/gu, "$1")
    .trim();
  // Three sentences at most, then QUOTE_CHARS at a word boundary.
  const sentences = s.split(/(?<=[.!?…])\s+/u);
  if (sentences.length > QUOTE_SENTENCES) s = sentences.slice(0, QUOTE_SENTENCES).join(" ");
  if (Array.from(s).length > QUOTE_CHARS) {
    const cut = Array.from(s).slice(0, QUOTE_CHARS - 1).join("");
    s = `${cut.replace(/\s+\S*$/u, "").replace(/[\s,;:.…-]+$/u, "")}…`;
  }
  if (!/[\p{L}\p{N}]/u.test(s) || contentFree(s)) return null;
  // A quote dressed as the room answer's own frame ("From a copy fetched just now.", "their words, not facts").
  if (QUOTE_FRAME.test(s)) return null;
  // Digits read as letters too ("cla1m", "appr0ve"): the gate's quote kind reads the same.
  const reads = [s, ...tgLineReadings(s), ...tgQuoteLeetReadings(s)];
  if ([OUT_HANDOUT, OUT_LURE, POST_RUG_LURE, CONTACT_LURE, SPELLED_LINK, PRIVATE_THIRD, OUT_ACCUSE, RUG_CONTEXT_ACCUSE, PERSON_HARM, SEND_FOR, QUOTE_TARGET, SECOND_PERSON, NOT_ENGLISH, ...QUOTE_HARM].some((re) => reads.some((t) => re.test(t)))) return null;
  // Quotes are English, as the paraphrase is: every clause reads English (review r2).
  if (quoteNotEnglish(s)) return null;
  const handle = typeof v.author?.handle === "string" ? v.author.handle.replace(/^@+/, "").trim() : "";
  const who = quoteHandleOk(handle) ? handle : "a trader";
  const posted = typeof v.postedAt === "number" && Number.isFinite(v.postedAt) ? v.postedAt : null;
  // "12m ago" reads as twelve million to the money clause elsewhere: minutes in words.
  const age = posted === null ? "" : agoText(Math.max(0, now - posted)).replace(/^(\d+)m ago$/u, "$1 min ago");
  const line = quoteLine({ who, age, text: s });
  const v2 = admitTgLine(line, { agentName: "", kind: "quote", recentOwn: [], rug: { coins: coin ? [coin] : [], brag: false } });
  return v2.ok ? { who, age, text: s } : null;
}

/**
 * Words a quote's author handle may never wear, read with its joins spaced
 * out ("fomo_support", "MerrymenOfficial", "refund_bot"): support, a help
 * desk, an admin or mod, "official", a team, a dev, a bot, a refund or
 * recovery, Merrymen, Fomo, Telegram; or a helper's word fused to a name
 * ("autonrecovery", "dm_autonhelp"). Such an author is "a trader".
 */
const IMPERSONATES = /\b(?:support|help\s*desk|admins?|mods?|moderators?|official|team|devs?|bot|refunds?|recovery|merrym[ae]n|fomo|telegram)\b|(?<=[\p{L}\p{N}])(?:recovery|support|help(?:desk)?|rescue)\b/iu;
/** A handle read as one lowercase word, digits as the letters they stand for ("F0m0_Admin" is "fomoadmin"). */
const HANDLE_LEET: Readonly<Record<string, string>> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t" };
const foldedHandle = (handle: string): string =>
  handle.normalize("NFKC").toLowerCase().replace(/[013457]/g, (d) => HANDLE_LEET[d] ?? d).replace(/[^\p{L}]+/gu, "");
/** What a handle read as one word may never hold anywhere in it: staff, Merrymen, Fomo, a lure, a crime, harm. */
const IMPERSONATES_FOLDED =
  /fomo|merrym[ae]n|telegram|support|admin|official|staff|helpdesk|customer(?:care|service)|refund|recover|verified|moderator|airdrop|giveaway|kill(?:your|ur|the|them|him|her)|kys|hangthe|rapist|scam|^buy|^sell|sendsol|sendeth|doubleyour/u;
/** The lines code says around the quotes; a thesis that echoes one is dressing as the answer itself. */
const QUOTE_FRAME = /\bfrom a copy fetched\b|\btheir words,? not facts\b|\bthe newest \d+ theses\b|\b\d+ of these \d+ left out\b/i;

/**
 * WHETHER A QUOTE'S AUTHOR MAY BE NAMED: a handle the room may hear
 * (sayableTraderHandle) that, with its underscores, dots, dashes, case and
 * digit joins spaced out ("airdrop_bot" is "airdrop bot", "AirdropBot" is
 * "Airdrop Bot", "send_1_sol" is "send 1 sol"), impersonates no one and
 * passes the gate as a quote's author: never a lure, a slur or a threat
 * wearing a handle (review, 2026-10-09).
 */
function quoteHandleOk(handle: string): boolean {
  if (!handle || !sayableTraderHandle(handle)) return false;
  const spaced = handle
    .replace(/[_.\-]+/gu, " ")
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{L})(\p{N})|(\p{N})(\p{L})/gu, "$1$3 $2$4")
    .trim();
  if (IMPERSONATES.test(spaced)) return false;
  // Read as one word too, digits as letters (review r2): "fomoadmin",
  // "merrymenofficial", "telegramsupport", "f0m0admin", "killyourself" never
  // split at a case or an underscore. Short words (dev, bot, mod, team) stay
  // with the word-edged test above: as substrings they hide in real names.
  if (IMPERSONATES_FOLDED.test(foldedHandle(handle))) return false;
  return admitTgLine(quoteLine({ who: spaced, age: "", text: "x" }), { agentName: "", kind: "quote", recentOwn: [] }).ok;
}

/** "• kaleo, 2h ago: “…”": how a room hears one quote (tg-groups/quotes.ts says the same). */
export function quoteLine(q: { who: string; age: string; text: string }): string {
  return `• ${q.who}${q.age ? `, ${q.age}` : ""}: “${q.text}”`;
}

/**
 * A COIN'S THESES, QUOTED, for a room that asked for them (FomoQuestionPlan
 * .quotes): the newest up to ten of one coin's theses read, newest first,
 * each through quoteOf, with how many were left out. Null unless the answer
 * is exactly one coin's theses read (never a trader's, never a compound
 * answer) with rows in it: an empty read keeps its own honest line. The
 * dropped rows are counted, never replaced by older ones.
 */
export function thesesQuotes(r: AnswerFomoResult, now: number): TgThesesQuotes | null {
  if (!r.handled || r.envelopes.length !== 1) return null;
  const want = quoteCount(r.plan.quotes);
  if (!want) return null;
  const env = r.envelopes[0]!;
  if (env.tool !== "fomo_get_token_theses" || !["ok", "partial", "capped", "stale"].includes(env.status)) return null;
  const d = env.data as TokenThesesData | null;
  if (!d || !d.token || d.trader || !Array.isArray(d.theses) || d.theses.length === 0) return null;
  const coin = String(d.label?.symbol ?? "").replace(/^\$+/, "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 20);
  const rows = d.theses.filter((v): v is ThesisView => !!v && typeof v === "object").sort((a, b) => postedOf(b) - postedOf(a));
  const n = Math.min(want, rows.length);
  const quotes: TgThesesQuotes["quotes"] = [];
  const seen = new Set<string>();
  for (const v of rows.slice(0, n)) {
    const q = quoteOf(v, coin, now);
    if (!q) continue;
    const key = q.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    quotes.push(q);
  }
  const total = typeof env.coverage.providerTotal === "number" && Number.isFinite(env.coverage.providerTotal) ? env.coverage.providerTotal : null;
  const asked = typeof r.plan.quotesAsked === "number" && r.plan.quotesAsked > want ? r.plan.quotesAsked : want;
  return { coin: coin || "this coin", where: chainLabel(d.token.chain.slug), asked, n, quotes, leftOut: n - quotes.length, total: total !== null && total > n ? total : null };
}

/** The one coin a single-coin answer is about (TgFomoAnswer.coin): a plain symbol and its chain, never an address. */
export function answerCoin(r: AnswerFomoResult, thesesAsked = false): TgFomoAnswer["coin"] | null {
  if (!r.handled) return null;
  const env = firstAnswered(r);
  if (!env) return null;
  let token: TokenIdentity | null = null;
  let label: TokenLabel | null = null;
  if (env.tool === "fomo_get_token_theses") {
    const d = env.data as TokenThesesData;
    if (d.trader) return null;
    token = d.token;
    label = d.label;
  } else if (env.tool === "fomo_get_token_activity") {
    const d = env.data as TokenActivityData;
    token = d.token;
    label = d.label;
  } else if (env.tool === "fomo_research_coin") {
    const d = env.data as ResearchCoinData;
    token = d.token;
    label = d.label;
  }
  const c = token ? coinOf(token, label) : null;
  if (!c) return null;
  const chain = tgChainOf(token?.chain.slug);
  const aspect = env.tool === "fomo_get_token_theses" ? (thesesAsked ? "quotes" : "theses") : env.tool === "fomo_get_token_activity" ? "activity" : "research";
  return { symbol: c.symbol, ...(chain ? { chain } : {}), aspect };
}

// ─── A coin's facts, measured (Milla, 2026-10-09) ───────────────────────────

/** What a facts question asked: what happened, why it fell, the data, the dev. */
export type FactsAsk = "what" | "why" | "data" | "dev";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number): string => String(n).padStart(2, "0");
const hhmm = (ms: number): string => { const d = new Date(ms); return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`; };
const dayOf = (ms: number): string => { const d = new Date(ms); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };
const HOUR_WORDS = ["", "one hour", "two hours", "three hours"];
const trimZeros = (s: string): string => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
/** Money in short form, as a room hears published figures: "$36k", "$5.75M". */
function usdShort(n: number): string {
  if (n >= 1e9) return `$${trimZeros((n / 1e9).toFixed(n < 1e10 ? 2 : 1))}B`;
  if (n >= 1e6) return `$${trimZeros((n / 1e6).toFixed(n < 1e7 ? 2 : 1))}M`;
  if (n >= 1e3) return `$${trimZeros((n / 1e3).toFixed(n < 1e4 ? 1 : 0))}k`;
  return `$${Math.round(n)}`;
}
/** A coin's price, three significant digits. */
function priceShort(n: number): string {
  return `$${n >= 1 ? trimZeros(n.toFixed(2)) : Number(n.toPrecision(3)).toString()}`;
}
const pct1 = (n: number): string => `${trimZeros(n.toFixed(1))}%`;
const FACTS_CHAINS: Readonly<Record<FactsNetwork, string>> = { robinhood: "Robinhood Chain", solana: "Solana", base: "Base", ethereum: "Ethereum", bsc: "BSC" };

/**
 * A COIN'S FACTS AS A ROOM HEARS THEM, written by code from what was measured
 * (desk/facts.ts): the source and the time first, then only figures that were
 * read, each a short published figure (the gate's research kind), and what
 * could not be read. Never a reason, a person, an address or the word "rug";
 * "fell" and "drop", never "crashed"; "buyers and sellers", never
 * "transactions". At most five lines.
 */
export function coinFactsLines(f: CoinFacts, sym: string, ask: FactsAsk, now: number): string[] {
  const out = [`${sym} on ${FACTS_CHAINS[f.network] ?? "its chain"}, from GeckoTerminal at ${hhmm(f.observedAt)} UTC:`];
  // How far back the closes reach: the pool's whole life, or the last N days.
  const whole = f.barsFromMs !== null && f.poolCreatedAtMs !== null && f.barsFromMs <= f.poolCreatedAtMs + 3_600_000;
  const days = f.barsFromMs !== null ? Math.max(1, Math.round((now - f.barsFromMs) / 86_400_000)) : null;
  const closeWhere = whole || days === null ? "its highest hourly close on its main pool" : `its highest hourly close on its main pool in the last ${days} days`;
  const below = f.drawdownPct !== null ? (f.drawdownPct < 0.05 ? "it is at that high now" : `it is ${pct1(f.drawdownPct)} below that`) : null;
  if (f.high && f.fdvNowUsd !== null && f.high.fdvUsd !== null) {
    out.push(`About ${usdShort(f.fdvNowUsd)} now (fully diluted); ${closeWhere} was about ${usdShort(f.high.fdvUsd)}, ${dayOf(f.high.atMs)} at ${hhmm(f.high.atMs)} UTC${below ? `, so ${below}` : ""}.`);
  } else if (f.high) {
    out.push(`About ${priceShort(f.priceUsd)} a coin now; ${closeWhere} was about ${priceShort(f.high.closeUsd)}, ${dayOf(f.high.atMs)} at ${hhmm(f.high.atMs)} UTC${below ? `, so ${below}` : ""}.`);
  } else {
    const change = f.change24hPct !== null ? `; ${f.change24hPct < 0 ? `down ${pct1(-f.change24hPct)}` : `up ${pct1(f.change24hPct)}`} in the last 24h on its main pool` : "";
    out.push(`About ${f.fdvNowUsd !== null ? `${usdShort(f.fdvNowUsd)} now (fully diluted)` : `${priceShort(f.priceUsd)} a coin now`}${change}; its hourly closes could not be read.`);
  }
  if (ask === "dev") {
    // A holding not read is said as not read, never as none (that would read as "the dev sold it all").
    out.push(f.creatorHoldingPct !== null
      ? `GeckoTerminal lists its creator as holding about ${pct1(f.creatorHoldingPct)} of supply now (it doesn't say when that was last updated).`
      : f.info === "read"
        ? "GeckoTerminal doesn't list a holding share for its creator."
        : "Couldn't read the creator's holding from GeckoTerminal just now.");
  }
  if (f.steepest && ask !== "dev") {
    out.push(`The biggest drop: about ${Math.round(f.steepest.pct)}% in ${HOUR_WORDS[f.steepest.hours] ?? `${f.steepest.hours} hours`} from ${hhmm(f.steepest.fromMs)} UTC on ${dayOf(f.steepest.fromMs)}.`);
  }
  const flow = f.sellers24h !== null && f.buyers24h !== null ? `in the last 24h, ${f.sellers24h.toLocaleString("en-US")} sellers and ${f.buyers24h.toLocaleString("en-US")} buyers` : null;
  if (f.liquidityUsd !== null || flow) {
    out.push(`${f.liquidityUsd !== null ? `Main pool liquidity about ${usdShort(f.liquidityUsd)}` : "On its main pool"}${flow ? `; ${flow}` : ""}.`);
  }
  if (ask === "data" && f.holders) {
    const top = f.holders.top10Pct !== null ? `; the top 10 hold ${pct1(f.holders.top10Pct)}` : "";
    const at = f.holders.updatedAtMs !== null ? ` (GeckoTerminal's count from ${dayOf(f.holders.updatedAtMs)}, ${hhmm(f.holders.updatedAtMs)} UTC)` : " (GeckoTerminal's count)";
    out.push(`Holders ${f.holders.count.toLocaleString("en-US")}${top}${at}.`);
  } else if (ask === "data" && f.info !== "read") {
    out.push("Couldn't read the holders from GeckoTerminal just now.");
  }
  out.push(
    ask === "why"
      ? "The data shows when and how far it fell, not why; I can't see who sold or whether liquidity was pulled."
      : ask === "dev"
        ? "I can't see the creator's past sales, only what GeckoTerminal lists now."
        : "I can't see who sold, why it fell, or whether liquidity was pulled.",
  );
  return out;
}

/** The lines a facts read that could not answer says: plainly, never a guess. */
export const FACTS_BUSY = "I've looked up enough market data in here for now; ask again in a few minutes.";
export const factsUnreadLine = (sym: string): string => `Couldn't read the market data for ${sym} just now, try again in a bit.`;
export const factsNotFoundLine = (sym: string, where: string): string => `I couldn't find a market for ${sym}${where ? ` on ${where}` : ""} to measure.`;
export const factsWhichLine = (sym: string): string => `Which ${sym} do you mean? Fomo lists it on more than one chain; say the chain.`;
export const factsUnknownLine = (sym: string): string => `I couldn't find ${sym} on Fomo.`;
export const factsUnsupportedLine = (sym: string): string => `I can't measure ${sym} on that chain.`;

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

/**
 * WHETHER A TRADER'S HANDLE MAY BE SAID IN A ROOM, judged by the group line
 * gate itself, as the handler will judge each line (a `research` line). A
 * handle it refuses ("user84729374" is an id run, "john.eth" a link) is
 * rendered "an unnamed trader" (render.ts sayableHandle), so the gate never
 * drops a trader's name while keeping the lines about them, which would read
 * as the trader named above.
 */
export function sayableTraderHandle(handle: string): boolean {
  return admitTgLine(`${handle} on Fomo`, { agentName: "", kind: "research", recentOwn: [] }).ok;
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
 * The fixed question for a routed theses request asked about the coin this
 * room's memory holds, or null: exactly one remembered token, with the same
 * symbol, and the same chain when the request names one.
 */
async function rememberedThesesText(b: FomoBroker, key: string, req: Extract<TgFomoRequest, { kind: "coin" }>, now: number): Promise<string | null> {
  try {
    const m = deserialize(await b.memory.get(key));
    const toks = rememberedSubjects(m, "token", now).filter((s): s is Extract<typeof s, { kind: "token" }> => s.kind === "token");
    if (toks.length !== 1) return null;
    const tok = toks[0]!;
    const sym = String(req.symbol ?? "").replace(/^\$+/, "").toUpperCase();
    if (!tok.symbol || tok.symbol.replace(/^\$+/, "").toUpperCase() !== sym) return null;
    if (req.chain && tgChainOf(tok.chain) !== req.chain) return null;
    const n = quoteCount(req.quotes);
    return n ? `quote the newest ${n} theses on it` : "what are the theses on it?";
  } catch {
    return null;
  }
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

  /**
   * A COIN'S FACTS (Milla, 2026-10-09: "when asked for actual facts she should
   * be able to look"). The coin is resolved from this room's memory first (no
   * credit), else once through Fomo's own resolver (one charge to the room's
   * cap, like any lookup); several chains ask which, none says so. Then the
   * public index is read (opts.facts: GeckoTerminal, bounded per chat and per
   * agent) and said as measured lines, with whether it collapsed for the
   * handler's collapse permit. Null when no reader is wired.
   */
  const factsAnswer = async (q: Parameters<TgFomoPort["ask"]>[0], req: Extract<TgFomoRequest, { kind: "coin" }>): Promise<TgFomoAnswer | null> => {
    const reader = opts.facts;
    if (!reader) return null;
    const sym = String(req.symbol ?? "").replace(/^\$+/, "").toUpperCase();
    if (!TICKER.test(sym)) return null;
    const ask: FactsAsk = req.ask === "why" || req.ask === "data" || req.ask === "dev" ? req.ask : "what";
    const t = now();
    const timeoutMs = typeof q.timeoutMs === "number" && Number.isFinite(q.timeoutMs) ? Math.max(1, Math.min(q.timeoutMs, 30_000)) : 25_000;
    const until = t + timeoutMs;
    const say = (text: string, extra: Partial<TgFomoAnswer> = {}): TgFomoAnswer => ({ text, deflect: false, status: "ok", ...extra });
    const key = tgGroupConversationKey(q.chatId, q.threadId);
    const b = brokerNow();
    // 1. The room's remembered coin: same symbol (and chain when one was named), with its address.
    let token: TokenIdentity | null = null;
    let charged = false;
    if (b) {
      const bounded = boundedBroker(b, Math.min(2_000, timeoutMs));
      try {
        const m = deserialize(await bounded.broker.memory.get(key));
        const toks = rememberedSubjects(m, "token", t).filter((x): x is Extract<typeof x, { kind: "token" }> =>
          x.kind === "token" && typeof x.address === "string" && typeof x.chain === "string" && (x.symbol ?? "").replace(/^\$+/, "").toUpperCase() === sym && (!req.chain || tgChainOf(x.chain) === req.chain));
        if (toks.length === 1) {
          const remembered = chainFromUserText(toks[0]!.chain!);
          if (remembered) token = { chain: remembered, address: toks[0]!.address!, key: "" };
        }
      } finally {
        bounded.done();
      }
    }
    // 2. Else Fomo's resolver, once.
    if (!token) {
      if (!b) return say(TG_FOMO_UNAVAILABLE, { status: "unavailable", free: true });
      const bounded = boundedBroker(b, Math.max(1, Math.min(8_000, until - now())));
      let env: FomoEnvelope | null = null;
      try {
        env = await bounded.broker.call("fomo_resolve_subject", { query: `$${sym}`, kind: "token", ...(req.chain ? { chain: CHAIN_WORDS[req.chain] } : {}) }, {
          surface: "telegram-group",
          audience: "group",
          conversationKey: key,
          priority: "interactive",
          groupId: String(q.chatId),
        });
      } catch {
        env = null;
      } finally {
        bounded.done();
      }
      charged = !!env && !(env.usage?.providerCalls === 0);
      if (!env || env.status === "failed" || env.status === "unavailable" || env.status === "not-authorized") return say(GROUP_FOMO_UNREACHED, { status: env?.status === "unavailable" ? "unavailable" : "failed" });
      if (env.status === "budget-limited") return say(groupRefusalLine(env.reason, now(), env.retryAt ?? null), { status: "budget-limited" });
      if (env.status === "needs-clarification") return say(factsWhichLine(sym), charged ? {} : { free: true });
      const subj = env.subject as ResolvedSubject | null;
      if (env.status === "not-found" || !subj || subj.kind !== "token") return say(factsUnknownLine(sym), charged ? {} : { free: true });
      token = subj.token;
    }
    // 3. The public index.
    const network = tgChainOf(token.chain.slug);
    const where = chainLabel(token.chain.slug);
    const coin = { symbol: sym, ...(network ? { chain: network } : {}), aspect: "facts" as const };
    const free = charged ? {} : { free: true };
    if (!network) return say(factsUnsupportedLine(sym), { ...free, coin });
    const read = await reader({ network, address: token.address, chatId: q.chatId, timeoutMs: Math.max(1, Math.min(10_000, until - now() - 500)), withInfo: ask === "dev" || ask === "data" });
    log(`[tg-fomo] coin facts ${read.ok ? "read" : read.why}${charged ? " (resolved by Fomo)" : ""}`);
    if (!read.ok) {
      const line = read.why === "busy" ? FACTS_BUSY : read.why === "not-found" ? factsNotFoundLine(sym, where) : read.why === "unsupported" ? factsUnsupportedLine(sym) : factsUnreadLine(sym);
      return say(line, { ...free, coin });
    }
    const lines = coinFactsLines(read.facts, sym, ask, now());
    return say(lines.join("\n"), { ...free, coin, collapse: { coin: sym, ...(network ? { chain: network } : {}), collapsed: collapseOf(read.facts), atMs: read.facts.observedAt } });
  };

  return {
    async ask(q): Promise<TgFomoAnswer | null> {
      try {
        if (!q || !isUsableChatId(q.chatId)) return null;
        // WHAT HAPPENED TO A COIN, as measured market facts: never the Fomo planner.
        if (q.request?.kind === "coin" && q.request.aspect === "facts") return await factsAnswer(q, q.request);
        let text = q.request ? requestText(q.request) : typeof q.text === "string" ? q.text : null;
        if (!text || !text.trim()) return null;
        /** The words as asked (a line, or the request's fixed question): what looseCoin and looseTrader read. */
        const asked: string = text;
        const b = brokerNow();
        const t = now();
        // The bot's own @username and names (trusted: from getMe and the
        // soul, via the handler), so "@thisbot theses on $PONS?" is a coin
        // question and not a question about a trader called thisbot.
        const selfNames = selfNamesOf(q.selfNames);
        // A line (never a routed request, whose coin or trader the router
        // grounded) is left to the router when it asks about a coin the
        // planner could not place (looseCoin), or names another trader than
        // the one the room's memory would answer about (looseTrader).
        let loose = false;
        const wanted = q.request
          ? undefined
          : (plan: FomoQuestionPlan, memory?: SubjectMemory | null): boolean => !(loose = looseCoin(asked, plan) || looseTrader(asked, plan, memory ?? null, selfNames, t));
        if (!b) {
          // Honest about it, but only for a question the research would have taken.
          const plan = classifyFomoQuestion(asked, { memory: null, now: t, selfNames });
          return plan && (!wanted || wanted(plan)) ? { text: TG_FOMO_UNAVAILABLE, deflect: false, status: "unavailable" } : null;
        }
        const conversationKey = tgGroupConversationKey(q.chatId, q.threadId);
        const timeoutMs = typeof q.timeoutMs === "number" && Number.isFinite(q.timeoutMs) ? Math.max(1, Math.min(q.timeoutMs, 30_000)) : 25_000;
        const bounded = boundedBroker(b, timeoutMs);
        // A ROUTED COIN'S THESES, MEMORY FIRST: the coin this room's memory
        // holds, when it is the one asked about (same symbol, and chain when one
        // was named), is asked about as "it", so the read is that token's own
        // kept copy and never a search by symbol across every chain.
        if (q.request?.kind === "coin" && q.request.aspect === "theses") {
          const said = await rememberedThesesText(bounded.broker, conversationKey, q.request, t);
          if (said) text = said;
        }
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
          ...(q.fresh === true ? { retryEmpty: true } : {}),
          sayableHandle: sayableTraderHandle,
        }).finally(() => bounded.done());
        if (!r.handled) {
          if (loose) log("[tg-fomo] group ask left to the router (a coin or trader the planner could not place)");
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
        // A remembered trader board: the rows the text shows, so the handler can say which the room heard (heard()).
        if (r.board) said.board = { at: r.board.at, ranks: boardRanksIn(said.text) };
        // A COIN'S THESES QUOTED, on an explicit ask (Milla, 2026-10-09): the
        // room hears the quotes (tg-groups/quotes.ts), the digest stays the
        // fallback, and no paraphrase is asked for (no model call at all).
        const quotes = thesesQuotes(r, t);
        if (quotes) {
          said.quotes = quotes;
          log(`[tg-fomo] theses quoted (${quotes.quotes.length} kept, ${quotes.leftOut} left out)`);
        } else {
          // A coin's theses: material for the group model to say in its own words (tg-groups/theses.ts).
          const theses = thesesMaterial(r, said.text);
          if (theses) said.theses = theses;
        }
        // The one coin a single-coin answer is about, by its plain name (never an address).
        const coin = answerCoin(r, quotes !== null);
        if (coin) said.coin = coin;
        // NOTHING BOUGHT FROM THE PROVIDER: nothing looked up at all (a
        // clarification, the capabilities line, "is fomo working?"), or every
        // read a kept copy (or refused before any call), so the room's
        // research slot goes back (handler.ts fomoAnswer), as for a deflection
        // above. Counted by the service's own provider calls, which include
        // the search behind a not-found answer; never a failed read, whose
        // envelope cannot say what the provider was already asked.
        if (r.toolsCalled.length === 0 || (r.envelopes.length > 0 && r.envelopes.every((e) => e.status !== "failed" && e.usage?.providerCalls === 0))) said.free = true;
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
    async heard(chatId: number, threadId: number | undefined, board: { at: number; ranks: number[] }, sent: string): Promise<void> {
      try {
        if (!isUsableChatId(chatId) || !board || !Array.isArray(board.ranks) || typeof sent !== "string") return;
        // Nothing delivered (""): the room heard no row, the asked one included.
        const none = sent === "";
        const heardRanks = new Set(boardRanksIn(sent));
        const cut = new Set(board.ranks.filter((r) => !heardRanks.has(r)));
        if (!cut.size && !none) return;
        const b = brokerNow();
        if (!b) return;
        const key = tgGroupConversationKey(chatId, threadId);
        const m = deserialize(await b.memory.get(key));
        // Only the board this answer remembered: a newer ask's board is its own.
        if (!m?.board || m.board.at !== board.at) return;
        // The row a line asked about was never a board row the handler cuts (it is named below the board): it stays.
        const rows = none ? [] : m.board.rows.filter((r) => !cut.has(r.rank));
        const next = { ...m, board: { ...m.board, rows } };
        if (!rows.length) delete (next as { board?: unknown }).board;
        await b.memory.set(key, serialize(next));
        log(none ? "[tg-fomo] board forgotten: the answer never reached the room" : `[tg-fomo] board rows the room did not hear forgotten (${cut.size})`);
      } catch {
        /* memory is a convenience: "the last one" may then ask which row */
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
