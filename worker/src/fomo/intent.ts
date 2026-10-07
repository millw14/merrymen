/**
 * FOMO QUESTION PLANNING — is this message a request for social-trading
 * research, and if so, which registered tool answers it with the least
 * retrieval?
 *
 * Every chat surface (app chat, Telegram DM, Telegram groups) asks this one
 * deterministic planner before anything else touches the provider. There is
 * no model call here: a model deciding which paid upstream reads to make, and
 * with what arguments, is a model that can be talked into making them.
 *
 * ── WHAT A PLAN CAN AND CANNOT DO ───────────────────────────────────────
 *
 * A plan names READ tools (and the two watch mutations, which the caller
 * offers only to the owner) with arguments drawn from a closed vocabulary:
 * subject references, window, side, limit, freshness, cohort scope, a dossier
 * revision, a depth and a focus. Never a tenant, a credential, a URL, a path
 * or a host: the tenant comes from trusted server context, and anything else
 * is refused by `sanitizePlanArgs` even if a rule here were wrong.
 *
 * `tradePermission` is the literal `false`. "Should we follow this?" asks for
 * analysis. A trader buying a coin is a reason to investigate, never an
 * instruction, and no phrasing reaching this file changes that. An imperative
 * order ("buy PEPE", "copy @x") is not planned at all: it belongs to the
 * existing command gates.
 *
 * ── WHAT IT MUST LEAVE ALONE ─────────────────────────────────────────────
 *
 *   The owner's OWN book. "What did you buy today?", "how much did I make",
 *   "show my trades" are ledger questions (web/src/lib/chat-ledger-facts.ts).
 *   Answering them from a social feed would describe somebody else's trades
 *   as ours.
 *
 *   "fomo" the feeling. "I have fomo lol" is not a research request. The word
 *   counts as the platform only in a platform position ("on fomo", "fomo
 *   app", "is fomo working").
 *
 *   General market questions. "Analyse PEPE" with no Fomo context is the
 *   market planner's (telegram/question-context.ts). Here it needs a Fomo
 *   mention or a live Fomo conversation (fresh subject memory).
 *
 * ── SUBJECTS ─────────────────────────────────────────────────────────────
 *
 * This message's subjects are what it literally contains: addresses, mints,
 * $TICKERs and UPPERCASE tickers, @handles, "trader X", "X's bags". Pronouns
 * resolve against subject memory (subject-memory.ts), and only while it is
 * fresh. When an ambiguity would change the answer (two coins for a
 * one-coin question, a pronoun with nothing to point at, a ticker with two
 * chains) the plan carries ONE question and no tool calls.
 *
 * Message text is untrusted: thesis-style prose, handles and ticker-looking
 * words are data. Nothing extracted here is ever more than a regex-shaped
 * identifier, and nothing in the text can add a tool or an argument.
 */

import { sanitizeText } from "../research/news";
import { chainFromUserText, IDENTITY_GUARDS, shortAddress } from "./identity";
import {
  FOMO_INTENTS,
  isMemoryUsable,
  mergeResolved,
  PLAN_WINDOWS,
  rememberedSubjects,
  sameSubject,
  type FomoIntent,
  type PlanSide,
  type PlanWindow,
  type SubjectMemory,
} from "./subject-memory";
import type { FomoMutationToolName, FomoReadToolName, FreshnessMode, SubjectQuery } from "./types";

export { FOMO_INTENTS, PLAN_WINDOWS, type FomoIntent, type PlanSide, type PlanWindow };

export interface FomoToolCall {
  tool: FomoReadToolName | FomoMutationToolName;
  args: Record<string, unknown>;
}

export interface FomoQuestionPlan {
  intent: FomoIntent;
  /** The user wants Merrymen's evaluation, not just the facts. */
  analysisRequested: boolean;
  /** The user explicitly asked for facts without an opinion. Wins over analysis. */
  infoOnly: boolean;
  /** Always false: a question is never permission to trade. */
  tradePermission: false;
  freshness: FreshnessMode;
  /** Effective window: stated in this message, or inherited when `usesMemory` includes "window". */
  window: PlanWindow | null;
  side: PlanSide | null;
  /** Subjects named in THIS message (0..2). Remembered ones are not listed here. */
  subjects: SubjectQuery[];
  /** What was taken from memory: "intent", "token", "trader", "window", "side", "dossierRevision". */
  usesMemory: string[];
  correction: boolean;
  cohortScope: boolean;
  /** One focused question; when set, `toolCalls` is empty. */
  clarification: string | null;
  toolCalls: FomoToolCall[];
}

export interface FomoQuestionContext {
  memory: SubjectMemory | null;
  now: number;
  /**
   * The agent's own names (soul name, aliases) and @handle(s), from trusted
   * context (getName(), getMe), never from the message. WHY: a group line
   * almost always carries the bot's @username, and "Robin's trades" asks
   * about the owner's own agent (Robin is the default name). Without these
   * the planner reads the bot as a Fomo trader: the room is deflected, a
   * paid trader search runs, or a stranger's book answers a question about
   * our own.
   */
  selfNames?: readonly string[];
}

/** The only argument names a plan may emit. */
export const PLAN_ARG_KEYS = [
  "trader",
  "token",
  "chain",
  "window",
  "side",
  "limit",
  "freshness",
  "cohort_only",
  "since_revision",
  "depth",
  "focus",
  "board",
] as const;

export const RANKING_BOARDS = ["traders", "trending-tokens", "graduated-tokens", "most-held-tokens"] as const;
export type RankingBoard = (typeof RANKING_BOARDS)[number];
export const RESEARCH_DEPTHS = ["quick", "standard", "deep"] as const;

const MAX_TEXT = 600;
const MAX_LIMIT = 50;
const FOLLOW_UP_MAX_WORDS = 12;
const { EVM_ADDRESS, SOLANA_MINT } = IDENTITY_GUARDS;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const HANDLE = /^[A-Za-z0-9_]{1,30}$/;
const SYMBOL = /^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/;
const SLUG = /^[a-z][a-z0-9-]{0,23}$/;

// ── Words ────────────────────────────────────────────────────────────────

interface Word {
  /** As typed, edge punctuation removed. Case kept: tickers and mints need it. */
  bare: string;
  /** Lowercase, contractions expanded, misspellings of our keywords corrected. */
  canon: string;
  /** Punctuation right after it ("pine, ...", "...on fomo? robin"): where a vocative can start or end. */
  pause?: boolean;
}

const CONTRACTIONS: Readonly<Record<string, string>> = {
  "what's": "what is", whats: "what is", "who's": "who is", whos: "who is", "it's": "it is", "that's": "that is",
  "there's": "there is", "here's": "here is", "where's": "where is", "how's": "how is", "let's": "let us",
  "he's": "he is", "she's": "she is", "didn't": "did not", didnt: "did not", "don't": "do not", dont: "do not",
  "doesn't": "does not", doesnt: "does not", "haven't": "have not", havent: "have not", "hasn't": "has not",
  "isn't": "is not", isnt: "is not", "wasn't": "was not", "aren't": "are not", "weren't": "were not",
  "won't": "will not", "can't": "can not", cant: "can not", "couldn't": "could not", "shouldn't": "should not",
  "wouldn't": "would not", "i'm": "i am", "we're": "we are", "they're": "they are", "you're": "you are",
  "i've": "i have", "we've": "we have", "you've": "you have", "they've": "they have", "i'd": "i would",
  "we'd": "we would", "you'd": "you would", "i'll": "i will", "we'll": "we will", "you'll": "you will",
};

/**
 * Curated misspellings. "foom" is here, not in the fuzzy pass: it is only
 * four letters, and it still counts as the platform only where "fomo" would
 * (a platform position), so "the foom is near" stays chat.
 */
const VARIANTS: Readonly<Record<string, string>> = {
  thesis: "theses", theses: "theses", thesises: "theses", thesisses: "theses", thesiss: "theses", thesies: "theses",
  theseses: "theses", teses: "theses", thesus: "theses", thesi: "theses",
  tradder: "trader", traider: "trader", trador: "trader", tradr: "trader",
  tradders: "traders", traiders: "traders", tradors: "traders", tradrs: "traders",
  holdigns: "holdings", holdins: "holdings", holdngs: "holdings", hodlings: "holdings",
  bougth: "bought", bougt: "bought", boght: "bought", baught: "bought", bougut: "bought",
  seling: "selling", sellling: "selling", sellin: "selling",
  fomo: "fomo", fommo: "fomo", fomoo: "fomo", foom: "fomo", foomo: "fomo", fomoapp: "fomo app",
  analyze: "analyse", analyzed: "analysed", analyzing: "analysing", analysis: "analysis",
};

/**
 * Keywords worth correcting by edit distance (Damerau-Levenshtein 1, words of
 * five letters or more). Short or common keywords are deliberately absent:
 * "watch" is one edit from "match", and "does that match what they said"
 * must not become a watch request.
 */
const FUZZY_TARGETS: Readonly<Record<string, string>> = {
  theses: "theses", thesis: "theses", trader: "trader", traders: "traders", holdings: "holdings",
  bought: "bought", selling: "selling", sellers: "sellers", buyers: "buyers", leaderboard: "leaderboard",
  trending: "trending", contradict: "contradict", contradicts: "contradicts", opportunities: "opportunities",
  opportunity: "opportunity", refresh: "refresh", research: "research", analyse: "analyse",
};

/**
 * Real words one edit from a target (checked against a dictionary when this
 * list was written). They are words, not typos, and are never "corrected":
 * "these" is not "theses", "trades" is not "traders", "telling" is not "selling".
 */
const NOT_TYPOS = new Set([
  "these", "theres", "themes", "thebes", "trade", "trades", "traded", "tracer", "tracers", "grader", "graders",
  "treader", "treaders", "holding", "folding", "foldings", "molding", "moldings", "holing", "brought", "fought",
  "sought", "ought", "nought", "bough", "boughs", "belling", "celling", "felling", "gelling", "jelling", "telling",
  "welling", "yelling", "sealing", "shelling", "smelling", "spelling", "swelling", "selfing", "salting", "silting",
  "seller", "sealers", "fellers", "tellers", "spellers", "smellers", "cellars", "buyer", "bayers", "boyers",
  "rending", "tending", "treading", "presearch", "analyses", "analyst", "analysed", "analyser", "researcher",
  "researched", "refreshed", "contradicted", "trending", "trader", "traders", "sellers", "buyers", "theses",
]);

function damerauWithin1(a: string, b: string): boolean {
  if (a === b) return true;
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 1) return false;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[m]![n]! <= 1;
}

function correctWord(lower: string): string {
  const variant = VARIANTS[lower];
  if (variant) return variant;
  if (lower.length < 5 || !/^[a-z]+$/.test(lower) || NOT_TYPOS.has(lower) || FUZZY_TARGETS[lower]) return lower;
  const hits = new Set<string>();
  for (const [target, canon] of Object.entries(FUZZY_TARGETS)) if (damerauWithin1(lower, target)) hits.add(canon);
  // Two different keywords within one edit: guessing would be worse than not.
  return hits.size === 1 ? [...hits][0]! : lower;
}

const EDGE = /^[\s"“”'‘’()[\]{}<>,.;:!?¿¡…*~`]+|[\s"“”'‘’()[\]{}<>,.;:!?¿¡…*~`]+$/g;

function canonOf(bare: string): string {
  const lower = bare.toLowerCase();
  const contraction = CONTRACTIONS[lower];
  if (contraction) return contraction;
  const possessive = /^(.+)'s$/.exec(lower);
  if (possessive) return `${correctWord(possessive[1]!)}'s`;
  return correctWord(lower);
}

const PAUSE = /[,;:!?.…|–—]/;
const TAIL = /[\s"“”'‘’()[\]{}<>,.;:!?¿¡…*~`]+$/;

function words(text: string): Word[] {
  const cleaned = sanitizeText(text.normalize("NFKC"), MAX_TEXT).replace(/[‘’ʼ]/g, "'");
  const out: Word[] = [];
  // Odd entries are the separators: kept only to see where the writer paused.
  const parts = cleaned.split(/([\s,;|]+|\/(?!\/))/);
  for (let i = 0; i < parts.length; i += 2) {
    const piece = parts[i]!;
    const bare = piece.replace(EDGE, "");
    const prev = out[out.length - 1];
    // A lone "?", "-" or "—" between words is a pause after the previous one.
    if (prev && ((!bare && PAUSE.test(piece)) || /^[-–—]+$/.test(bare))) prev.pause = true;
    if (!bare) continue;
    const after = `${TAIL.exec(piece)?.[0] ?? ""}${parts[i + 1] ?? ""}`;
    out.push(PAUSE.test(after) ? { bare, canon: canonOf(bare), pause: true } : { bare, canon: canonOf(bare) });
  }
  return out;
}

// ── Phrases (matched on the canonical text) ─────────────────────────────

/** The owner's own book. Never answered from a social feed. */
const OWN_LEDGER: readonly RegExp[] = [
  /\b(?:what|which)(?: \S+){0,3} (?:did|have|has) (?:you|u|we|i) (?:ever |actually |already |just |really )?(?:buy|bought|sell|sold|trade|traded|make|made|lose|lost|earn|earned|win|won)\b/,
  /\bhow much (?:did|have|has|do|am|are) (?:you|u|we|i) (?:\S+ )?(?:make|made|lose|lost|earn|earned|win|won|up|down)\b/,
  /\b(?:show|list|give|tell)(?: me| us)? (?:my|our|your) (?:\S+ )?(?:trades|trade history|positions|holdings|portfolio|bags|pnl|p&l|history|book|balance|fills|orders|profits?|losses)\b/,
  /\b(?:my|our|your) (?:pnl|p&l|profit|profits|loss|losses|trades|trade history|portfolio|holdings|bags|positions|balance|wallet|book|fills|orders|equity|returns?)\b/,
  /\bwhat (?:are|is) (?:you|we|i) (?:currently |still |now )?(?:holding|buying|selling|trading|long|short|in)\b/,
  /\b(?:did|have|has) (?:you|u|we|i) (?:ever |actually |already |just |really )?(?:buy|bought|sell|sold|trade|traded)\b/,
  /\b(?:are|were) (?:you|we) (?:still )?(?:buying|selling|holding|trading)\b/,
  /\btrade #|\btrade number\b/,
  /\b(?:i|we) (?:made|lost|earned)\b/,
];

/**
 * Managing the owner's OWN position: "should we take profit?", "should I
 * exit my PEPE?", "where's the stop loss?", "is it worth holding?". These are
 * about the owner's book, cost basis and the market read (the answer loop's
 * job, which resolves the coin from the replied-to message first). A fresh
 * Fomo conversation is not enough to make them research: answered from
 * social theses they would describe a possibly different coin, with none of
 * the owner's numbers. Only an explicit Fomo cue (the platform, theses,
 * traders, a named trader) keeps them here.
 */
const OWN_POSITION: readonly RegExp[] = [
  /\bshould (?:we|i|you) (?:\S+ )?(?:sell|hold|exit|trim|add|close|cut|keep|dump|bail|stay|average|top up|scale out|scale in|take (?:some |the |a )?(?:profits?|gains?|loss)|buy more|get out|stop out)\b/,
  /\b(?:our|my|your) (?:position|bag|stack|entry|exit|stop|stops|stop loss|stop-loss|take profit|tp|sl|cost basis|average)\b/,
  /\bstop[- ]?loss(?:es)?\b|\btake[- ]?profits?\b|\btrailing stop\b|\bcut (?:my|our|the) loss(?:es)?\b/,
  /\b(?:worth|keep|continue|still) holding\b|\bhold or (?:sell|fold|exit)\b|\b(?:sell|exit) or hold\b/,
  /\b(?:sell|exit|close|trim|dump) (?:my|our|your)\b/,
];

/**
 * An order is not a question. These go to the existing command gates, which
 * own confirmation and permission; a research planner must not intercept them.
 */
const ORDER = /^(?:(?:please|pls|plz|ok|okay|yes|yeah|now|then|so|go ahead and|can you|could you|will you|would you|i want you to|i want to|i need you to|i would like you to)\s+)*(?:buy|sell|ape|swap|long|short|send|transfer|snipe|copy|copytrade|mirror|follow|dca|market buy|market sell)\b/;

/** "fomo" in a platform position. "I have fomo" is a feeling. */
const FOMO_PLATFORM: readonly RegExp[] = [
  /\b(?:on|from|via|through|using|at|inside|within|in the) (?:the )?fomo\b(?! (?:into|in|buy|buying|bought|mode)\b)/,
  /\bfomo (?:app|traders?|users?|people|leaderboards?|feed|data|api|status|health|research|rankings?|trending|theses|community|platform|family|accounts?|profiles?|handles?|tokens?|coins?|holders?|watch ?list|alerts?|activity|top|integration|connection|stream)\b/,
  /\bfomo's (?:leaderboard|top|traders?|data|feed|trending|theses|users?|rankings?|community|app)\b/,
  /\bfomo\.family\b|\bfomoapi\b/,
  /\b(?:is|does) (?:the )?fomo(?: \S+)? (?:still )?(?:working|work|up|down|ok|okay|alive|connected|live|running|broken|healthy|online|offline)\b/,
];

const COHORT = /\bour (?:\d{1,4} )?(?:traders|cohort|trader list|watched traders|tracked traders)\b|\btraders (?:that |who )?(?:we|you) (?:watch|monitor|track|follow|are watching|are tracking|are monitoring)\b|\b(?:watched|tracked|monitored) traders\b|\bcohort\b/;
const TRADERS_WORD = /\btraders?\b/;

const HEALTH: readonly RegExp[] = [
  /\b(?:is|does) (?:the )?fomo(?: (?:feed|api|data|stream|connection|integration|app))? (?:still )?(?:working|work|up|down|ok|okay|alive|connected|live|running|broken|healthy|online|offline)\b/,
  /\bfomo (?:feed |api |data |stream |connection |integration )?(?:status|health|uptime|outage|down|broken|offline)\b/,
  /\bfomo (?:is )?not working\b/,
  /\b(?:status|health) (?:of|for) (?:the )?fomo\b/,
  /\b(?:are you|is it|are we) (?:still )?(?:connected to|receiving|getting data from|reading from|hooked up to|seeing) (?:the )?fomo\b/,
];

const UNWATCH = /\b(?:stop|quit|cease|pause) (?:watching|monitoring|tracking)\b|\bunwatch\b|\b(?:remove|drop|take) (?:\S+ ){0,4}?(?:off|from) (?:the |your |my |our )?watch ?list\b|\bno longer (?:watch|monitor|track)\b|\bdo not (?:watch|monitor|track) (?:it|this|that)\b/;
const WATCH = /^(?:(?:please|pls|plz|ok|okay|yes|yeah|then|so|now|go ahead and|can you|could you|will you|would you)\s+)*(?:start )?(?:watch|monitor|track)\b(?! (?:list|record))|\badd (?:\S+ ){0,4}?to (?:the |your |my |our )?watch ?list\b|\bput (?:\S+ ){0,4}?on (?:the |your |my |our )?watch ?list\b|\bkeep (?:an |a close )?eye on\b|\bstart (?:watching|monitoring|tracking)\b/;

const WHY_SKIPPED: readonly RegExp[] = [
  /\bwhy (?:did|have|has|do) (?:you|we|u|it) (?:not |never )?(?:skip|skipped|pass|passed|ignore|ignored|miss|missed|reject|rejected|drop|dropped|avoid|avoided)\b/,
  /\bwhy (?:did|have|has|do|does) not (?:you|we|u) (?:buy|follow|take|trade|enter|copy|ape|touch|act on)\b/,
  /\bwhy (?:did|have|do) (?:you|we|u) not (?:buy|follow|take|trade|enter|copy|ape|touch|act on)\b/,
  /\bwhy (?:was|is|were|has) (?:it|this|that|the coin|this coin|that coin|the token|\S+) (?:been )?(?:skipped|rejected|ignored|passed on|not bought|filtered|screened out)\b/,
  /\bwhy (?:no|not) (?:entry|buy|position|trade)\b/,
  /\bwhat (?:stopped|blocked|kept) (?:you|us) from (?:buying|entering|following)\b/,
];

const CHANGES_SINCE: readonly RegExp[] = [
  /\b(?:anything|something|what|much) (?:has |have )?(?:changed|new|different)\b(?: \S+){0,6} since\b/,
  /\b(?:has|have) (?:anything|something|much|it|this|that|the picture|the setup) changed\b/,
  /\b(?:changed|changes|different|new) since\b/,
  /\bsince (?:your|the|my|our) (?:last|previous) (?:analysis|look|check|report|review|update|research|dossier|time|answer|run)\b/,
  /\bcompare (?:this|that|it|these|them|the \S+) (?:with|to|against|vs|versus) (?:yesterday|last time|earlier|before|your last|the last|the previous)\b/,
  /\b(?:vs|versus|compared to|compared with|relative to) (?:yesterday|last time|earlier|before)\b/,
  /\bwhat (?:is|has) (?:new|changed) (?:with|on|for) (?:it|this|that)\b/,
];

const WORDS_VS_ACTIONS: readonly RegExp[] = [
  /\bcontradict(?:s|ed|ing|ion|ions)?\b/,
  /\bwords (?:vs|versus|and|against) (?:actions|deeds|trades)\b/,
  /\bsay(?:ing)? (?:vs|versus) do(?:ing)?\b/,
  /\bwalk(?:ing)? the talk\b|\bmoney where (?:their|his|her) mouth\b|\btalk(?:ing)? (?:their|his|her) book\b/,
  /\b(?:match|matches|line up with|lines up with|consistent with|back up|backs up|square with|agree with) what (?:they|those traders|those people|he|she|the traders|people|the authors) (?:said|say|wrote|posted|claim|claimed|think)\b/,
  /\bsaid\b.*\bbut (?:sold|is selling|are selling|dumped|dumping|exited)\b/,
  /\bshill(?:ing|ed)? (?:it )?(?:but|while|and then) (?:selling|sold|dumping|dumped)\b/,
];

const COMPARE = /\bcompare\b|\bcomparison\b|\bvs\b|\bversus\b|\bdifference between\b|\bboth\b/;
const TWO_DEIXIS = /\b(?:these|those|the) two\b/;

const RESEARCH_STATUS: readonly RegExp[] = [
  /\b(?:status|progress) (?:of|on) (?:your|the|our) research\b/,
  /\bresearch status\b/,
  /\b(?:are|were) you (?:still )?(?:watching|monitoring|tracking|researching)\b/,
  /\bwhat (?:coins |tokens )?are you (?:watching|monitoring|tracking|researching)\b/,
  /\bwhat is on (?:your|the|our) watch ?list\b/,
  /\b(?:show|list)(?: me)? (?:your |the |our )?watch ?list\b/,
  /\bhave you (?:researched|looked into|analysed|analysed) (?:it|this|that)\b/,
  /\bwhat did (?:you|your research) (?:find|conclude|decide)\b/,
];

const THESES = /\btheses\b/;
const OWN_THESES = /\b(?:your|my|our) theses\b|\btheses (?:for|behind) (?:buying|selling|the trade|this trade|that trade|entering|exiting|your)\b/;
const SAYING: readonly RegExp[] = [
  /\bwhat (?:are|is|do|does|did|has|have) (?!you\b|u\b|i\b|we\b)(?:\S+ ){0,3}?(?:saying|say|said|think|thinking|posting|posted|writing|wrote|feel|feeling)(?: (?:about|on|of|regarding)\b|$)/,
  /\b(?:sentiment|narrative|chatter|buzz|bull case|bear case|takes|opinions|comments|posts) (?:on|about|for|around|of|behind)\b/,
  /\bwhy (?:are|is) (?:people|traders|everyone|they) (?:so )?(?:bullish|bearish|excited)\b/,
];

const HOLDINGS = /\b(?:holdings|bags|bag|portfolio|positions|position|holding|hold|holds|own|owns|wallet|sitting on|loaded up on)\b/;
const TRADER_CONTEXT = /\bhow (?:is|has|did) \S+ (?:been )?(?:doing|done|performing|performed)\b|\bwho is\b|\btell me about\b|\bprofile\b|\btrack record\b|\bhow good\b|\bany good\b|\bperformance\b|\bperforming\b|\bpnl\b|\bp&l\b|\bwin ?rate\b|\bfollowers\b|\bstats\b|\breputation\b|\blegit\b|\brank(?:ed|ing)?\b/;
const TRADER_ACTIVITY = /\b(?:bought|buying|buys|buy|sold|selling|sells|sell|trades|trading|traded|trade|activity|been up to|up to|doing|moves|aped|aping|accumulating|accumulated|dumping|dumped|swaps|fills|entries|exits|entered|exited)\b/;

const SELLERS = /\bsellers\b|\bwho (?:is |are |has been |have been |was |were )?(?:selling|sold|dumping|dumped|exiting|exited|taking profits?)\b|\b(?:which|what) (?:traders|wallets|people|of (?:our|the|these|those) (?:\d{1,4} )?traders) (?:are |have |has |is |were )?(?:selling|sold|dumped|dumping|exited|exiting)\b|\bselling pressure\b/;
const BUYERS = /\bbuyers\b|\bwho (?:is |are |has been |have been |was |were )?(?:buying|bought|aping|aped|accumulating|loading up)\b|\b(?:which|what) (?:traders|wallets|people|of (?:our|the|these|those) (?:\d{1,4} )?traders) (?:are |have |has |is |were )?(?:buying|bought|aped|aping|accumulating|accumulated)\b/;
const HOLDERS = /\bholders\b|\bwho (?:is |are )?(?:holding|holds)\b|\b(?:which|what) (?:traders|wallets|people|of (?:our|the|these|those) (?:\d{1,4} )?traders) (?:still )?(?:hold|holds|holding|own|owns)\b/;
const GLOBAL_FLOW = /\bwhat (?:are|have|did|is) (?:the )?(?:top |best |smart |our (?:\d{1,4} )?|fomo |watched |other )?(?:traders|people|wallets|whales|users|everyone|smart money)(?: \S+){0,4}? (?:been )?(?:buying|selling|trading|aping|bought|sold|into|accumulating)\b|^(?:are|is|have|has) (?:the |our |any )?(?:\d{1,4} )?(?:traders|people|wallets|whales)(?: \S+){0,4}? (?:been )?(?:buying|selling|trading|aping|accumulating|dumping)\b/;

/**
 * Ranking traders. "Who" asks about people, so "who's the top on fomo today"
 * and "who's #1 on fomo" are the leaderboard without the word "trader";
 * "who's the top coin" is not.
 */
const RANK_TRADERS = /\b(?:top|best|leading|biggest|most profitable|highest earning|winning|hottest|smartest|top performing|best performing|strongest|richest) (?:\d{1,3} )?(?:fomo )?(?:traders|trader|performers|wallets|earners|winners|accounts)\b|\b(?:trader|traders) (?:leaderboard|rankings?|board)\b|\bleaderboard\b|\brank(?:ed|ing|ings)? (?:of )?(?:the )?traders\b|\bwho (?:is|are) (?:the )?(?:top|best|leading) (?:\d{1,3} )?(?:traders?|performers?)\b|\bwho (?:is|are) (?:the )?(?:top|best|leading|number one|#1|no 1|winning|on top|killing it|up the most|printing)(?! (?:\d{1,3} )?(?:fomo )?(?:coins?|tokens?|memecoins?|memes?|tickers?|cas?|plays?|picks?)\b)(?=\s|$)/;
const RANK_TOKENS = /\btrending\b|\b(?:top|hot|hottest|popular|most popular|most held|graduated|newly graduated|most bought|most traded|biggest) (?:\d{1,3} )?(?:fomo )?(?:coins|tokens|memecoins|memes|tickers)\b|\bmost[- ]held\b|\bgraduat(?:ed|ing|ions?)\b/;

const SMALL_COINS = /\b(?:smaller|small|low ?cap|lower ?cap|micro ?cap|microcap|lowcap|tiny|early|earlier|new|newer|under the radar|overlooked|hidden|emerging|undiscovered|lesser known|up and coming) (?:\S+ ){0,2}?(?:coins|tokens|caps|gems|plays|names|projects|memecoins|memes|tickers)\b/;
const ATTENTION = /\b(?:getting|gaining|attracting|drawing|picking up|with) (?:\S+ )?(?:attention|traction|interest|buzz|momentum)\b/;
const OPPORTUNITIES = /\bopportunit(?:y|ies)\b|\bgems\b|\bfind (?:me )?(?:some |new |early |small |smaller )?(?:coins|tokens|plays|ideas)\b|\banything (?:interesting|worth (?:a )?look(?:ing at)?)\b/;

const ANALYSIS = /\bshould (?:we|i|you) (?:\S+ )?(?:follow|copy|buy|ape|enter|get in|get into|trade|take|consider|sell|hold|exit|add|trim)\b|\banaly(?:se|sis|sing|sed)\b|\bevaluate\b|\bassess(?:ment)?\b|\bdeep dive\b|\bdig into\b|\b(?:your|an?) (?:honest )?(?:opinion|take|view|read|verdict|assessment|recommendation)\b|\bwhat do you (?:think|make) (?:of|about)\b|\bwhat is your (?:take|view|opinion|read)\b|\bis (?:it|this|that)(?: coin| token| one| trade)? (?:\S+ )?(?:worth|good|any good|legit|bullish|bearish|a buy)\b|\bworth (?:following|buying|it|a look|copying|watching)\b/;
const RESEARCH_VERB = /\bresearch (?:on |into )?(?:it|this|that|the|\$\S+|0x\S+|[a-z0-9]{2,})\b|\blook into\b|\binvestigate\b|\bdo (?:some |a )?research\b|\brun (?:the |a )?research\b/;
const DEEP = /\b(?:deep dive|in depth|in-depth|thorough|full|detailed|deep)\b/;
const QUICK = /\b(?:quick|brief|short|fast|tldr|tl;dr|summary)\b/;

const TOKEN_ACTIVITY = /\b(?:activity|flow|flows|what is happening|happening with|going on with|volume|trades on|buys and sells|buying and selling|trading activity|smart money|who is trading|any action)\b/;

const INFO_ONLY = /\bjust (?:give me |show me |tell me )?(?:the )?(?:info|information|facts|data|numbers|evidence)\b|\b(?:no|not a|not an|without an?|without any)(?: trading)? (?:opinion|advice|recommendation|take|analysis|verdict|call)s?\b|\b(?:facts|info|data) only\b|\bjust the facts\b|\bdo not (?:analyse|give me (?:an? )?(?:opinion|take|advice))\b/;

const FORCE_REFRESH = /\brefresh(?:ed|ing)?\b|\blatest\b|\bcheck (?:it |again |that )?now\b|\bright now\b|\bup[- ]to[- ]date\b|\bcurrently\b|\bcurrent\b|\bnow\b|\bre-?check\b|\breload\b|\bfresh(?:est)? (?:data|numbers|look|read)\b|\bupdate (?:it|that|this)\b|\bpull (?:it|that) again\b/;
const CACHED_OK = /\bcached\b|\bfrom (?:the )?cache\b|\bdo not refresh\b|\bno need to refresh\b|\bwhatever you (?:already )?have\b|\bdo not bother refreshing\b/;

const CORRECTION_STRONG = /^(?:no|nope|nah|sorry|oops|wait|err|erm|uh|hmm)\b(?: (?:no|sorry|wait))*(?: i)? (?:meant|mean)\b|\bi meant\b|\bnot that one\b|\bnot that (?:coin|token|trader|address|one)\b|\bwrong (?:coin|token|trader|one|address|ticker|chain|guy)\b|\bi was (?:asking|talking) about\b/;
const CORRECTION_SOFT = /^(?:actually|no|nope|nah|i mean|rather)\b|\binstead\b/;

const TOKEN_DEIXIS = /\b(?:this|that|the same|said|these|those) (?:coin|token|one|ticker|project|memecoin|meme|contract|address)s?\b|\bthe (?:coin|token|ticker|project|contract)\b|\b(?:it|its)\b|\bthis\b(?! (?:trader|guy|person|account|user|wallet|dude|week|month|year|morning|afternoon|evening|hour|time|weekend))/;
const TOKEN_DEIXIS_WEAK = /\bthe (?:sellers|buyers|holders|theses|flow|activity|trades)\b/;
const TRADER_DEIXIS = /\b(?:this|that|the same|said|the) (?:trader|guy|person|account|user|dude|degen)(?:'s)?\b|\b(?:he|she|him|his|her|hers)\b/;
/**
 * Singular "they": the usual way to refer to a handle. Trader deixis only
 * while a trader is remembered and nothing points at a coin, so "what are
 * they saying about it?" stays about the coin. Without it, "show their
 * trades" after a trader answer fell through to the ledger patterns and was
 * answered with the OWNER's fills.
 */
const THEY_DEIXIS = /\b(?:they|them|their|theirs|themselves|themself)\b/;
/**
 * But "they" is just as often the crowd: "who is buying $WIF and what are
 * they paying", "are they buying", "who are they", "what are they saying".
 * It is the remembered trader only when the message asks what one person
 * did ("what did they buy today?", "have they sold?", "how much did they
 * make?"), holds ("what are they holding?") or has on record ("show their
 * trades", "their bags", "their pnl"), and names no coin, crowd or board.
 * Otherwise it is not pinned on the trader (a wrong subject, and in a group
 * a needless deflection to DM).
 */
const THEY_TRADER = /\b(?:did|have|has|had) they (?:\S+ )?(?:buy|sell|trade|make|lose|take|ape|dump|exit|enter|hold|own|bought|sold|traded|made|lost|took|aped|dumped|exited|entered|held|owned)\b|\bthey (?:just |already |recently |also |still )?(?:bought|sold|traded|aped|dumped|exited|entered|took profits?)\b|\b(?:are|were) they (?:still )?holding\b|\b(?:do|does) they (?:still )?(?:hold|own)\b|\btheirs?(?: own)? (?:trades|trade history|buys|sells|bags|bag|holdings|wallet|positions|portfolio|moves|activity|book|fills|entries|exits|pnl|p&l|stats|performance|track record|win ?rate|history|profile|followers)\b|\bhow (?:are|have|did) they (?:been )?(?:doing|done|performing|performed)\b|\b(?:are|were) they (?:any good|legit|profitable)\b/;
/** Nouns for many people (crowdQuestion adds boards and "who is buying"): never one remembered trader. */
const CROWD = /\b(?:people|traders|wallets|whales|holders|buyers|sellers|everyone|everybody|anyone|anybody|others|users|investors|degens|folks|smart money)\b/;

const WINDOW_RULES: ReadonlyArray<readonly [PlanWindow, RegExp]> = [
  ["1h", /\b(?:(?:past|last|previous|this) hour|(?:1|one) ?(?:h|hr|hrs|hour)|60 ?(?:m|min|mins|minutes))\b/],
  ["24h", /\b(?:today|yesterday|tonight|overnight|this morning|24 ?(?:h|hr|hrs|hours?)|(?:past|last|previous) (?:day|24 hours)|1 ?d|one day)\b/],
  ["7d", /\b(?:this week|(?:past|last|previous) (?:week|7 days|seven days)|7 ?(?:d|days)|seven days|weekly)\b/],
  ["30d", /\b(?:this month|(?:past|last|previous) (?:month|30 days|thirty days)|30 ?(?:d|days)|thirty days|monthly)\b/],
  ["all", /\b(?:all[- ]time|all of time|ever|lifetime|since (?:the )?(?:start|beginning))\b/],
];
const TIME_PHRASES = /\bthis (?:week|month|year|morning|afternoon|evening|hour|weekend|time)\b/g;

const BUY_WORDS = /\b(?:buy|buys|buying|bought|buyers?|aped|aping|accumulat\w*|loading up|entries|entered)\b/;
const SELL_WORDS = /\b(?:sell|sells|selling|sold|sellers?|dumping|dumped|dump|exits?|exited|exiting|taking profits?|took profits?)\b/;
const LIMIT = /\b(?:top|first|last|latest) (\d{1,3})\b(?! ?(?:h|d|hr|hrs|hours?|days?|weeks?|months?|mins?|minutes?)\b)|\b(\d{1,3}) (?:most|top|best|biggest|latest)\b/;

// ── Subject extraction ───────────────────────────────────────────────────

/** Uppercase words that are not coins. ETH, SOL and BTC are coins and are not here. */
const NOT_TICKERS = new Set([
  "FOMO", "USD", "USDG", "USDC", "USDT", "I", "AI", "API", "PNL", "OK", "ATH", "ATL", "TA", "TP", "SL", "EMA", "SMA",
  "RSI", "ATR", "MACD", "VWAP", "UTC", "PC", "CEO", "DM", "DMS", "FYI", "LOL", "LMAO", "IMO", "IMHO", "TBH", "NFT",
  "NFTS", "DEX", "CEX", "KOL", "KOLS", "ROI", "APY", "APR", "FDV", "TVL", "MC", "MCAP", "CA", "PLS", "PLZ", "PM", "AM",
  "US", "USA", "UK", "EU", "GM", "GN", "WAGMI", "NGMI", "GMI", "DYOR", "NFA", "ASAP", "FAQ", "ID", "URL", "OG", "HODL",
  "IRL", "TLDR", "RN", "BTW", "AKA", "ETA", "TV", "VS", "EVM", "RH", "HL", "IDK", "JK", "OMG", "WTF", "FUD", "LFG",
  "TG", "CT", "DD", "AMA", "ICO", "IDO", "IPO", "TGE", "KYC", "AML", "YES", "NO", "NOT", "THE", "AND", "OR", "BUT",
  "WHO", "WHAT", "WHY", "HOW", "WHEN", "WHERE", "WHICH", "NOW", "ALL", "ANY", "BUY", "SELL", "HOLD", "TOP", "NEW",
  "HOT", "CHECK", "SHOW", "TELL", "GIVE", "PLEASE", "THIS", "THAT", "IT", "IS", "ARE", "ON", "IN", "OF", "TO", "FOR",
  "ME", "MY", "WE", "OUR", "YOU", "YOUR", "HE", "SHE", "THEY", "TRADER", "TRADERS", "THESIS", "THESES", "COIN",
  "COINS", "TOKEN", "TOKENS", "SOLANA", "ROBINHOOD", "HOOD", "BASE", "ARC", "TWITTER", "DOWN", "UP", "PNL", "P",
  "L", "X", "AT", "BY", "IF", "SO", "DO", "BE", "GO", "AN", "AS", "AM", "RT", "PR", "QA", "UI", "UX", "DEV", "DEVS",
  // Machine words a PC watcher names ("watch CPU", "monitor RAM"): never a coin to watch.
  "CPU", "GPU", "RAM", "SSD", "HDD", "PID", "OS",
]);

/** Words that follow "trader" without being a handle. */
const NOT_HANDLES = new Set(
  ("a an the this that these those who whom whose which what is was are were be been has have had did does do said says say " +
    "posted posts wrote writes bought buy buys buying sold sell sells selling hold holds holding holdings bags just recently " +
    "today yesterday now on in at from with and or but of for to x you we i he she they it me us him her them my our your his " +
    "their its named called account profile rankings ranking leaderboard list cohort activity trades trading traded theses " +
    "here there also still really actually apparently lately again then so if when mentioned above below earlier before after " +
    "follow following watch watching track tracking stats pnl performance wallet wallets positions portfolio aped aping " +
    "thinks think thought likes liked into about been being doing up out over more most top best leading big biggest").split(" "),
);

/** "X's bags": the nouns that make X a trader. */
const POSSESSED = new Set([
  "bags", "bag", "holdings", "portfolio", "positions", "position", "trades", "buys", "sells", "wallet", "moves", "activity",
  "book", "theses", "calls", "picks", "profile", "pnl", "stats", "performance", "track", "followers", "history",
]);
const NOT_POSSESSORS = new Set([
  "it", "that", "this", "what", "who", "there", "here", "let", "he", "she", "one", "everyone", "everybody", "someone",
  "somebody", "anyone", "today", "yesterday", "week", "month", "year", "fomo", "trader", "coin", "token", "market",
  "merrymen", "merryman", "agent", "bot", "the", "today's", "my", "your", "our", "their", "his", "her",
  // People and things in the owner's own life ("my wife's bags"), never a Fomo handle on their own.
  "you", "we", "they", "them", "us", "me", "mine", "yours", "ours", "theirs", "owner", "wife", "husband", "mom", "mum",
  "dad", "mother", "father", "brother", "sister", "bro", "sis", "friend", "buddy", "boss", "partner", "girlfriend",
  "boyfriend", "gf", "bf", "son", "daughter", "family", "team", "whale", "whales", "people", "nobody",
]);
/** A determiner before "X's": "my wife's bags", "the whale's bags", "a friend's trades" name a person or thing, not a handle. */
const POSSESSOR_DETERMINER = /^(?:my|your|our|his|her|their|the|a|an|some|this|that|these|those)$/;

/** Words that are never a coin name after "about"/"on". */
const NOT_NAMES = new Set([
  ...NOT_HANDLES, "fomo", "coin", "coins", "token", "tokens", "sellers", "buyers", "holders", "traders", "trader",
  "week", "month", "hour", "day", "yet", "lately", "people", "everyone", "anything", "something", "nothing",
  "chain", "network", "app", "telegram", "twitter", "here", "there", "one", "ones", "same", "other", "others", "base",
]);

/** Filler that a pure follow-up ("and this week?", "refresh it") may consist of. */
const FILLER = new Set(
  ("what is about how and but also the for same with instead then please pls plz now ok okay so just only again it its " +
    "this that these those one ones coin coins token tokens do does can could would will you u me us show give tell try " +
    "check look i mean meant no nope nah not actually yeah yes sure a an of on in to are was were there any side sides " +
    "chain network refresh refreshed latest update updated reload recheck re-check current currently fresh right up date " +
    "up-to-date pull get fetch rerun run more buys sells buying selling buy sell bought sold info information facts data " +
    "opinion opinions trading advice recommendation take stuff thing them they other wrong rather hmm cool thanks").split(" "),
);

interface Extracted {
  tokens: Array<Extract<SubjectQuery, { kind: "token" }>>;
  traders: Array<Extract<SubjectQuery, { kind: "trader" }>>;
  /** Distinct chain slugs the user named. */
  chains: string[];
  /** Word indexes consumed by subjects or chain hints (excluded from the follow-up residue). */
  consumed: Set<number>;
  /** "this trader's" etc. */
  traderPossessiveDeixis: boolean;
  /**
   * A trader named on its own terms: an @handle, a user id or "trader X". A
   * bare "X's bags" is a trader only inside a Fomo context: "Robin's trades"
   * is as likely the owner's own agent, and "my wife's bags" nobody on Fomo.
   */
  traderNamed: boolean;
  /** "Robin's trades" with Robin one of the agent's own names: the owner's book. */
  selfPossessive: boolean;
  /** "my wife's bags", "our friend's trades": somebody in the owner's own circle, never a Fomo subject. */
  ownerCircle: boolean;
}

function isAllCaps(ws: readonly Word[]): boolean {
  const alpha = ws.filter((w) => /^[A-Za-z]{2,}$/.test(w.bare));
  if (alpha.length < 4) return false;
  return alpha.filter((w) => w.bare === w.bare.toUpperCase()).length / alpha.length >= 0.6;
}

function chainSlug(word: string): string | null {
  const c = chainFromUserText(word);
  return c?.slug ?? null;
}

function extract(ws: readonly Word[], self: SelfRef): Extracted {
  const tokens: Extracted["tokens"] = [];
  const traders: Extracted["traders"] = [];
  const chains: string[] = [];
  const consumed = new Set<number>();
  let traderPossessiveDeixis = false;
  let selfPossessive = false;
  let ownerCircle = false;
  /** Lowercased handles named by @, "trader X" (not just "X's"). */
  const named = new Set<string>();
  const shouting = isAllCaps(ws);

  const addToken = (t: Extract<SubjectQuery, { kind: "token" }>) => {
    const dup = tokens.some((x) => (t.address ? x.address === t.address : !x.address && x.symbol === t.symbol));
    if (!dup) tokens.push(t);
  };
  const addTrader = (t: Extract<SubjectQuery, { kind: "trader" }>) => {
    const dup = traders.some((x) => (t.userId ? x.userId === t.userId : !!t.handle && x.handle?.toLowerCase() === t.handle.toLowerCase()));
    if (!dup) traders.push(t);
  };

  // Chain hints first, so "on sol" is a chain and not the SOL coin.
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!;
    const prev = ws[i - 1]?.canon;
    const prev2 = ws[i - 2]?.canon;
    const next = ws[i + 1]?.canon;
    const slug = chainSlug(w.canon);
    if (!slug) continue;
    // "Theses on SOL" asks about the coin; "on sol", "on solana", "on SOL chain" name the chain.
    const shoutedTicker = /^[A-Z0-9]{2,6}$/.test(w.bare) && !NOT_TICKERS.has(w.bare) && !shouting;
    if (shoutedTicker && next !== "chain" && next !== "network") continue;
    const positioned = prev === "on" || prev === "via" || prev === "from" || prev === "across"
      || (prev === "the" && (prev2 === "on" || prev2 === "via" || prev2 === "from"))
      || next === "chain" || next === "network"
      || ((prev === "or" || prev === "and" || prev === "vs" || prev === "versus") && chains.length > 0);
    if (!positioned) continue;
    consumed.add(i);
    if (next === "chain" || next === "network") consumed.add(i + 1);
    if (!chains.includes(slug)) chains.push(slug);
  }

  for (let i = 0; i < ws.length; i++) {
    if (consumed.has(i)) continue;
    const w = ws[i]!;
    const b = w.bare.replace(/'s$/i, "");
    if (EVM_ADDRESS.test(b)) {
      addToken({ kind: "token", address: b.toLowerCase() });
      consumed.add(i);
      continue;
    }
    if (SOLANA_MINT.test(b) && (/\d/.test(b) || (/[a-z]/.test(b) && /[A-Z]/.test(b)))) {
      // Base58 is case-sensitive: the mint is kept exactly as typed.
      addToken({ kind: "token", address: b });
      consumed.add(i);
      continue;
    }
    if (UUID.test(b)) {
      addTrader({ kind: "trader", userId: b.toLowerCase() });
      consumed.add(i);
      continue;
    }
    const dollar = /^\$([A-Za-z][A-Za-z0-9_-]{0,19})$/.exec(b);
    if (dollar) {
      addToken({ kind: "token", symbol: dollar[1]!.toUpperCase() });
      consumed.add(i);
      continue;
    }
    const at = /^@([A-Za-z0-9_]{1,30})$/.exec(b);
    if (at) {
      addTrader({ kind: "trader", handle: at[1]! });
      named.add(at[1]!.toLowerCase());
      consumed.add(i);
      continue;
    }
    // "X's bags" — a trader, unless X is a pronoun, a shouted ticker, the
    // agent itself or somebody in the owner's own life.
    const poss = /^([A-Za-z0-9_]{2,30})'s$/i.exec(w.bare);
    if (poss && POSSESSED.has(ws[i + 1]?.canon ?? "")) {
      const who = poss[1]!;
      const lower = who.toLowerCase();
      if (lower === "trader" || lower === "guy" || lower === "account") {
        if (/^(?:this|that|the|same|said)$/.test(ws[i - 1]?.canon ?? "")) traderPossessiveDeixis = true;
        continue;
      }
      // "Robin's holdings" where Robin is this agent: the owner's own book,
      // which the ledger answers. Never a stranger's Fomo profile.
      if (self.words.has(lower)) {
        selfPossessive = true;
        consumed.add(i);
        continue;
      }
      const det = ws[i - 1]?.canon ?? "";
      if (/^(?:my|our|your)$/.test(det)) {
        ownerCircle = true;
        continue;
      }
      if (POSSESSOR_DETERMINER.test(det)) continue;
      if (!NOT_POSSESSORS.has(lower)) {
        if (/^[A-Z0-9]+$/.test(who) && !NOT_TICKERS.has(who)) addToken({ kind: "token", symbol: who });
        else addTrader({ kind: "trader", handle: who });
        consumed.add(i);
        continue;
      }
    }
    // "trader X" / "trader named X".
    if (w.canon === "trader" || w.canon === "trader's") {
      let j = i + 1;
      if (ws[j]?.canon === "named" || ws[j]?.canon === "called") j++;
      const cand = ws[j];
      if (cand && !consumed.has(j)) {
        const h = cand.bare.replace(/^@/, "").replace(/'s$/i, "");
        if (HANDLE.test(h) && h.length >= 2 && !NOT_HANDLES.has(h.toLowerCase()) && !EVM_ADDRESS.test(h) && !/^\d+$/.test(h)) {
          addTrader({ kind: "trader", handle: h });
          named.add(h.toLowerCase());
          consumed.add(j);
        }
      }
      continue;
    }
    // A chain word is a coin unless it sits in a chain position (consumed above): "ETH" is a coin, "on eth" a chain.
    if (!shouting && /^[A-Z][A-Z0-9]{1,9}$/.test(b) && !NOT_TICKERS.has(b)) {
      addToken({ kind: "token", symbol: b });
      consumed.add(i);
    }
  }

  // A chain hint applies to every coin named without an address of its own shape.
  if (chains.length === 1) {
    for (const t of tokens) t.chain = chains[0]!;
  }
  const traderNamed = traders.some((t) => !!t.userId || (!!t.handle && named.has(t.handle.toLowerCase())));
  return { tokens, traders, chains, consumed, traderPossessiveDeixis, traderNamed, selfPossessive, ownerCircle };
}

// ── The agent's own names ───────────────────────────────────────────────

interface SelfRef {
  /** @usernames, lowercased, without the @. */
  handles: ReadonlySet<string>;
  /** Each name as lowercased words ("pine heron" → ["pine", "heron"]). */
  names: ReadonlyArray<readonly string[]>;
  /** Every word of every name, lowercased: "X's bags" with X one of these is the agent's own book. */
  words: ReadonlySet<string>;
}

const NO_SELF: SelfRef = { handles: new Set(), names: [], words: new Set() };

function selfRefOf(raw: readonly unknown[] | undefined): SelfRef {
  if (!Array.isArray(raw) || raw.length === 0) return NO_SELF;
  const handles = new Set<string>();
  const names: string[][] = [];
  const words = new Set<string>();
  for (const r of raw.slice(0, 16)) {
    if (typeof r !== "string") continue;
    const t = sanitizeText(r.normalize("NFKC"), 64).trim();
    const h = /^@([A-Za-z0-9_]{1,32})$/.exec(t);
    if (h) {
      handles.add(h[1]!.toLowerCase());
      continue;
    }
    const parts = t.toLowerCase().split(/\s+/).map((p) => p.replace(EDGE, "")).filter(Boolean);
    if (parts.length === 0 || parts.length > 4 || !parts.every((p) => /^[\p{L}\p{N}_-]{1,30}$/u.test(p))) continue;
    names.push(parts);
    for (const p of parts) if (p.length >= 2) words.add(p);
  }
  return { handles, names, words };
}

/** Greetings that make the next word a vocative ("hey pine ..."). */
const GREETING = new Set(["hey", "hi", "hello", "yo", "oi", "gm", "sup", "ser"]);
const TIME_WORDS = new Set([
  "morning", "afternoon", "evening", "night", "tonight", "overnight", "midnight", "today", "yesterday", "weekend",
  "week", "month", "year", "hour", "day",
]);

/**
 * A word the question itself may need, whoever is named after it: the
 * platform ("on fomo"), a chain ("on sol"), a time ("this morning") or
 * planner vocabulary. Never dropped as the agent's name.
 */
function plannerWord(w: string): boolean {
  return canonOf(w).startsWith("fomo") || FILLER.has(w) || NOT_NAMES.has(w) || TIME_WORDS.has(w) || chainSlug(w) !== null;
}

/**
 * The message without the agent's own @handle (anywhere: it addresses us,
 * it is never a subject) and without its name used as a VOCATIVE: after a
 * greeting or followed by a pause at the start ("hey pine ...", "pine, theses
 * on $PONS?"), or the full name after a pause at the end ("trending on fomo,
 * robin?"). A bare name inside the question is content, never a vocative:
 * an agent called Pepe is asked "what are people saying about pepe" about
 * the coin. Names are owner-chosen or generated ("Morning Wren", "Sol"), so a
 * name word the question may need (plannerWord) is never dropped on its own.
 */
function withoutSelf(ws: readonly Word[], self: SelfRef): { ws: Word[]; selfPossessive: boolean } {
  if (self === NO_SELF) return { ws: [...ws], selfPossessive: false };
  let selfPossessive = false;
  let out: Word[] = [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!;
    const m = /^@([A-Za-z0-9_]{1,32})('s)?$/i.exec(w.bare);
    if (m && self.handles.has(m[1]!.toLowerCase())) {
      if (m[2] && POSSESSED.has(ws[i + 1]?.canon ?? "")) selfPossessive = true;
      continue;
    }
    out.push(w);
  }
  // Full names (a one-word name only when the question could not need it),
  // and the first or last word of a longer name ("pine" for "Pine Heron").
  const full: string[][] = [];
  const parts: string[][] = [];
  for (const n of self.names) {
    if (n.length > 1) {
      full.push([...n]);
      for (const one of [n[0]!, n[n.length - 1]!]) if (one.length >= 3 && !plannerWord(one)) parts.push([one]);
    } else if (!plannerWord(n[0]!)) {
      full.push([...n]);
    }
  }
  const leading = [...full, ...parts].sort((a, b) => b.length - a.length);
  full.sort((a, b) => b.length - a.length);
  // A ticker-shaped word ("ROBIN theses?") is a coin before it is a vocative.
  const nameAt = (w: Word | undefined, x: string): boolean => !!w && w.bare.toLowerCase() === x && !/^[A-Z0-9]{2,}$/.test(w.bare);
  const at = (list: readonly Word[], from: number, seqs: readonly string[][]): number => {
    for (const q of seqs) {
      if (from + q.length > list.length) continue;
      if (q.every((x, k) => nameAt(list[from + k], x))) return q.length;
    }
    return 0;
  };
  // Leading: "hey pine ...", "pine, ...". Something must be left to plan.
  const greet = out.length > 1 && GREETING.has(out[0]!.canon) ? 1 : 0;
  const lead = at(out, greet, leading);
  if (lead > 0 && out.length > greet + lead && (greet > 0 || out[lead - 1]!.pause)) out = out.slice(greet + lead);
  // Trailing: "..., pine heron?" — the full name, after a pause.
  for (const q of full) {
    const from = out.length - q.length;
    if (from > 0 && out[from - 1]!.pause && at(out, from, [q]) === q.length) {
      out = out.slice(0, from);
      break;
    }
  }
  return { ws: out, selfPossessive };
}

/** "what are people saying about pepe" — a lowercase coin name in the last position. */
function trailingName(c: string): string | null {
  const m = /\b(?:about|on|for|of|regarding) \$?([a-z][a-z0-9]{1,15})(?: (?:on|in|from) (?:the )?fomo(?: app)?)?$/.exec(c);
  if (!m) return null;
  const name = m[1]!;
  if (NOT_NAMES.has(name) || FILLER.has(name) || chainSlug(name)) return null;
  return name.toUpperCase();
}

// ── The planner ──────────────────────────────────────────────────────────

interface Detected {
  intent: FomoIntent;
  /** Fomo-specific on its own (no platform mention or live conversation needed). */
  inherent: boolean;
  board?: RankingBoard;
}

const any = (rules: readonly RegExp[], c: string) => rules.some((r) => r.test(c));

function windowOf(c: string): PlanWindow | null {
  let best: { w: PlanWindow; at: number } | null = null;
  for (const [w, re] of WINDOW_RULES) {
    const m = re.exec(c);
    if (m && (!best || m.index < best.at)) best = { w, at: m.index };
  }
  return best?.w ?? null;
}

function sideOf(c: string): PlanSide | null {
  const buy = BUY_WORDS.test(c);
  const sell = SELL_WORDS.test(c);
  return buy && sell ? "all" : buy ? "buy" : sell ? "sell" : null;
}

function limitOf(c: string): number | null {
  const m = LIMIT.exec(c);
  const n = m ? Number(m[1] ?? m[2]) : NaN;
  return Number.isSafeInteger(n) && n >= 1 ? Math.min(n, MAX_LIMIT) : null;
}

function freshnessOf(c: string): FreshnessMode {
  if (CACHED_OK.test(c)) return "cached-ok";
  return FORCE_REFRESH.test(c) ? "force-refresh" : "prefer-fresh";
}

interface Signals {
  c: string;
  fomo: boolean;
  cohort: boolean;
  traderSubject: boolean;
  /** A trader named by @handle, user id or "trader X" (Extracted.traderNamed). */
  traderNamed: boolean;
  traderDeixis: boolean;
  tokenDeixis: boolean;
  tokenCount: number;
  memoryTrader: boolean;
  memoryToken: boolean;
  /** About many people or a board (crowdQuestion): never the remembered trader by default. */
  crowd: boolean;
}

/** "What are people holding?", "who is the top trader?", "which wallets sold?": a crowd or a board, not one trader. */
function crowdQuestion(c: string): boolean {
  return CROWD.test(c) || COHORT.test(c) || SELLERS.test(c) || BUYERS.test(c) || HOLDERS.test(c) || GLOBAL_FLOW.test(c)
    || RANK_TRADERS.test(c) || RANK_TOKENS.test(c);
}

function detectIntent(s: Signals): Detected | null {
  const { c } = s;
  const tradersWord = TRADERS_WORD.test(c);
  const theses = THESES.test(c) && !OWN_THESES.test(c);
  const saying = any(SAYING, c);
  if (any(HEALTH, c)) return { intent: "health", inherent: true };
  if (UNWATCH.test(c)) return { intent: "unwatch", inherent: false };
  if (WATCH.test(c)) return { intent: "watch", inherent: false };
  if (any(WHY_SKIPPED, c)) return { intent: "why-skipped", inherent: tradersWord || s.traderNamed };
  if (any(CHANGES_SINCE, c)) return { intent: "changes-since", inherent: false };
  if (any(WORDS_VS_ACTIONS, c)) return { intent: "words-vs-actions", inherent: tradersWord || s.traderNamed || theses };
  if (COMPARE.test(c) && (theses || saying || s.tokenCount >= 2 || TWO_DEIXIS.test(c) || (s.tokenCount === 1 && s.tokenDeixis))) {
    return { intent: "compare-theses", inherent: theses };
  }
  if (any(RESEARCH_STATUS, c)) return { intent: "research-status", inherent: false };

  // A specific third-party trader: their words, holdings, trades or profile.
  const traderTopic = s.traderSubject || s.traderDeixis
    || (s.memoryTrader && !s.memoryToken && s.tokenCount === 0 && !s.crowd && (HOLDINGS.test(c) || TRADER_CONTEXT.test(c)));
  if (traderTopic) {
    // "This trader" names a third party as clearly as a handle does; "he"
    // does not, and neither does a bare "X's bags" (the agent's own name, a
    // friend): those need a Fomo mention or a live Fomo conversation.
    const inherent = s.traderNamed || /\b(?:this|that) trader\b/.test(c);
    if (theses || saying) return { intent: "token-theses", inherent };
    if (HOLDINGS.test(c)) return { intent: "trader-holdings", inherent };
    if (BUY_WORDS.test(c) || SELL_WORDS.test(c)) return { intent: "trader-activity", inherent };
    if (TRADER_CONTEXT.test(c)) return { intent: "trader-context", inherent };
    if (TRADER_ACTIVITY.test(c)) return { intent: "trader-activity", inherent };
    return { intent: "trader-context", inherent };
  }

  if (theses) return { intent: "token-theses", inherent: true };
  if (saying) return { intent: "token-theses", inherent: tradersWord };
  if (GLOBAL_FLOW.test(c) && s.tokenCount === 0 && !TOKEN_DEIXIS.test(c.replace(TIME_PHRASES, ""))) {
    return { intent: "token-activity", inherent: tradersWord || s.cohort };
  }
  const sellers = SELLERS.test(c);
  const buyers = BUYERS.test(c);
  if (sellers && buyers) return { intent: "token-activity", inherent: tradersWord };
  if (sellers) return { intent: "token-sellers", inherent: tradersWord };
  if (buyers) return { intent: "token-buyers", inherent: tradersWord };
  if (HOLDERS.test(c)) return { intent: "token-activity", inherent: tradersWord };
  if (RANK_TRADERS.test(c)) return { intent: "rankings-traders", inherent: tradersWord };
  if (RANK_TOKENS.test(c)) {
    return { intent: "rankings-tokens", inherent: false, board: boardOf(c) };
  }
  const small = SMALL_COINS.test(c);
  if ((small && (ATTENTION.test(c) || tradersWord)) || OPPORTUNITIES.test(c) || (small && s.fomo)) {
    return { intent: "opportunities", inherent: small && (ATTENTION.test(c) || tradersWord) };
  }
  if (ANALYSIS.test(c) || RESEARCH_VERB.test(c)) return { intent: "research-coin", inherent: false };
  if (TOKEN_ACTIVITY.test(c)) return { intent: "token-activity", inherent: tradersWord };
  return null;
}

/** Residue after removing subjects, chain hints, time phrases and filler. Empty → a pure follow-up. */
function residue(ws: readonly Word[], consumed: ReadonlySet<number>): string[] {
  const kept = ws.filter((_, i) => !consumed.has(i)).map((w) => w.canon).join(" ");
  let c = kept;
  for (const [, re] of WINDOW_RULES) c = c.replace(new RegExp(re.source, "g"), " ");
  return c.split(" ").filter((w) => w && !FILLER.has(w));
}

/** The words a watch or unwatch command is made of, beyond filler: what may surround "it" in one. */
const WATCH_WORDS = new Set(
  ("watch watching watched monitor monitoring track tracking start stop quit cease pause keep eye close closely add put " +
    "remove drop take off from list watchlist watch-list unwatch longer my our your fomo app go ahead day days week weeks " +
    "month months should we let maybe").split(" "),
);
const DURATION = /\b\d{1,3} (?:days?|weeks?|months?)\b/g;

/** What is left of a watch/unwatch message once its command words are gone. Non-empty: something else is being watched. */
function watchResidue(ws: readonly Word[], consumed: ReadonlySet<number>): string[] {
  const kept = ws.filter((_, i) => !consumed.has(i)).map((w) => w.canon).join(" ").replace(DURATION, " ");
  return residue(words(kept), new Set()).filter((w) => !WATCH_WORDS.has(w));
}

function label(q: SubjectQuery): string {
  if (q.kind === "token") {
    if (q.symbol && SYMBOL.test(q.symbol)) return q.symbol;
    if (q.address) return shortAddress(q.address);
    return "that coin";
  }
  if (q.kind === "trader") return q.handle && HANDLE.test(q.handle) ? `@${q.handle}` : "that trader";
  return "the market";
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Plan a message, or null when it is not a Fomo information request.
 *
 * Pass the conversation's memory as it stood BEFORE this message, then give
 * the plan to `applyPlan` with the same memory.
 */
export function classifyFomoQuestion(text: string, ctx: FomoQuestionContext): FomoQuestionPlan | null {
  if (typeof text !== "string" || !text.trim()) return null;
  const self = selfRefOf(ctx.selfNames);
  // The agent's own @handle anywhere, and its name as a vocative, address
  // US: read as a subject they would research (or deflect) the bot itself.
  const unaddressed = withoutSelf(words(text), self);
  let ws = unaddressed.ws;
  // "@merrymen_bot what is @x holding": a leading @mention followed by a
  // question addresses US even when the caller could not say which handle is
  // ours. Treating it as the subject would research the bot.
  if (ws.length > 2 && /^@[A-Za-z0-9_]{1,30}$/.test(ws[0]!.bare) && VOCATIVE_NEXT.test(ws[1]!.canon)) ws = ws.slice(1);
  const c = ws.map((w) => w.canon).join(" ");
  if (!c || ORDER.test(c) || OWN_LEDGER.some((re) => re.test(c))) return null;

  const memory = ctx.memory;
  const usable = isMemoryUsable(memory, ctx.now);
  const history = !!memory?.lastIntent;
  const stale = history && !usable;
  const ex = extract(ws, self);
  // "Robin's trades" / "@ourbot's holdings": the owner's own book. "My
  // wife's bags": not a Fomo subject, and not the remembered trader either.
  if (unaddressed.selfPossessive || ex.selfPossessive || (ex.ownerCircle && !ex.traderNamed)) return null;
  const fomo = any(FOMO_PLATFORM, c);
  const cohort = COHORT.test(c);
  const memTokens = rememberedSubjects(memory, "token", ctx.now);
  const memTraders = rememberedSubjects(memory, "trader", ctx.now);
  const deixisText = c.replace(TIME_PHRASES, " ");
  const tokenDeixis = TOKEN_DEIXIS.test(deixisText);
  const tokenDeixisWeak = TOKEN_DEIXIS_WEAK.test(deixisText);
  const crowd = crowdQuestion(c);
  // "they" with a trader remembered; it is that trader only in a trader-shaped question (THEY_TRADER).
  const theyPronoun = memTraders.length > 0 && THEY_DEIXIS.test(deixisText);
  const theyTrader = theyPronoun && !tokenDeixis && ex.tokens.length === 0 && !crowd && !/\bwho\b/.test(c) && THEY_TRADER.test(c);
  const traderDeixis = TRADER_DEIXIS.test(c) || ex.traderPossessiveDeixis || theyTrader;
  // Position management on the owner's own holding stays with the ledger and
  // the answer loop unless the message itself is about Fomo or a third party
  // ("did he take profit?"). A watch ("should we keep an eye on it?") is not
  // position management.
  if (any(OWN_POSITION, c) && !WATCH.test(c) && !UNWATCH.test(c)
    && !(fomo || cohort || THESES.test(c) || TRADERS_WORD.test(c) || ex.traderNamed || traderDeixis)) {
    return null;
  }
  const explicitCount = ex.tokens.length + ex.traders.length;
  const correction = CORRECTION_STRONG.test(c) || (CORRECTION_SOFT.test(c) && explicitCount > 0);
  const statedWindow = windowOf(c);
  const statedSide = sideOf(c);
  const freshness = freshnessOf(c);
  const infoOnly = INFO_ONLY.test(c);
  const short = c.split(" ").length <= FOLLOW_UP_MAX_WORDS;

  const detected = detectIntent({
    c,
    fomo,
    cohort,
    traderSubject: ex.traders.length > 0,
    traderNamed: ex.traderNamed,
    traderDeixis,
    tokenDeixis,
    tokenCount: ex.tokens.length,
    memoryTrader: memTraders.length > 0,
    memoryToken: memTokens.length > 0,
    crowd,
  });
  // A continuation: nothing left once subjects, time, chain and filler are
  // removed, and something substantive was said ("and this week?", "refresh it").
  const pureFollowUp = short && residue(ws, ex.consumed).length === 0
    && (explicitCount > 0 || statedWindow !== null || statedSide !== null || freshness !== "prefer-fresh"
      || infoOnly || correction || ex.chains.length > 0);

  const usesMemory: string[] = [];
  let intent: FomoIntent;
  let board = detected?.board;
  if (detected) {
    // Generic wording ("who is selling?", "should we follow this?") counts as
    // a Fomo question only inside a Fomo conversation or with a Fomo mention.
    // A stale conversation still counts for a short subject-less follow-up,
    // so the answer can be a question rather than silence.
    const context = detected.inherent || fomo || cohort || (usable && history) || (history && short && explicitCount === 0);
    if (!context) return null;
    intent = detected.intent;
  } else if (history && (pureFollowUp || (correction && short))
    // "are they buying?" after a trader answer: a "they" that is not the trader does not continue a trader question.
    && !(theyPronoun && !theyTrader && TRADER_INTENTS.has(memory!.lastIntent!))) {
    intent = memory!.lastIntent!;
    usesMemory.push("intent");
  } else if (fomo && ex.tokens.length > 0) {
    intent = "token-activity";
  } else if (fomo && ex.traders.length > 0) {
    intent = "trader-context";
  } else if (fomo && FOMO_WHATS_UP.test(c)) {
    intent = "token-activity";
  } else {
    return null;
  }
  const fromMemory = usesMemory.includes("intent");
  if (intent === "rankings-tokens" && !board) board = boardOf(c);

  const analysisCue = ANALYSIS.test(c.replace(PRIOR_ANALYSIS, " ")) || RESEARCH_VERB.test(c);
  const analysisRequested = !infoOnly && (analysisCue || intent === "research-coin");

  const mutation = intent === "watch" || intent === "unwatch";
  const explicitTokens = [...ex.tokens];
  // A lowercase trailing word is a guess at a coin name ("what are people
  // saying about pepe"). Fine for a read; a write ("keep an eye on battery")
  // takes it only when the message also names Fomo.
  if (SUBJECT_NEEDS[intent].token > 0 && explicitTokens.length === 0 && !tokenDeixis && (!mutation || fomo)) {
    const name = trailingName(c);
    if (name) explicitTokens.push(ex.chains.length === 1 ? { kind: "token", symbol: name, chain: ex.chains[0]! } : { kind: "token", symbol: name });
  }
  // "Should we follow this?" about a remembered trader (and no coin) asks
  // about the trader, not for a coin dossier.
  if (intent === "research-coin" && explicitTokens.length === 0 && !/\b(?:coin|token)\b/.test(c)
    && (ex.traders.length > 0 || (memTokens.length === 0 && memTraders.length > 0))) {
    intent = "trader-context";
  }
  const subjects: SubjectQuery[] = [...explicitTokens, ...ex.traders].slice(0, 2);

  let window: PlanWindow | null = statedWindow;
  let side: PlanSide | null = null;
  const plan = (clarification: string | null, toolCalls: FomoToolCall[]): FomoQuestionPlan => ({
    intent,
    analysisRequested,
    infoOnly,
    tradePermission: false,
    freshness,
    window,
    side,
    subjects,
    usesMemory: [...usesMemory],
    correction,
    cohortScope: cohort,
    clarification,
    toolCalls: clarification ? [] : toolCalls,
  });
  const ask = (question: string) => plan(question, []);

  // A WATCH IS A WRITE, so it never infers its subject. It takes an explicit
  // coin, or an explicit reference to the remembered one ("watch this coin",
  // "stop watching it") with nothing else in the message. "watch cpu>80",
  // "track my order", "unwatch 2", "watch @alice", "monitor him", "watch
  // out" are not Fomo coin watches at all (a PC watcher, an order, a
  // trader): not planned, so the existing command path still gets them.
  if (mutation) {
    // "watch them" with a trader remembered is about that trader (or a crowd), never a coin watch.
    if (ex.traders.length > 0 || traderDeixis || (theyPronoun && !tokenDeixis)) return null;
    if (explicitTokens.length === 0) {
      if (watchResidue(ws, ex.consumed).length > 0) return null;
      if (!tokenDeixis) return ask(intent === "watch" ? ASK_WATCH : ASK_UNWATCH);
    }
  }

  // A correction that names nothing: the remembered subject is wrong and
  // there is no replacement, so nothing may be looked up yet.
  if (correction && explicitTokens.length === 0 && ex.traders.length === 0 && !detected) {
    return ask(TRADER_INTENTS.has(intent) || /\b(?:trader|guy)\b/.test(c) ? ASK_TRADER_CORRECTION : ASK_TOKEN_CORRECTION);
  }

  const need = SUBJECT_NEEDS[intent];

  // Two chains, or an address that cannot live on the named chain, change
  // which coin the answer is about.
  if (need.token > 0 || need.chainMatters) {
    if (ex.chains.length > 1) return ask(`Which chain do you mean: ${ex.chains.slice(0, 2).map(titleCase).join(" or ")}?`);
    if (ex.chains.length === 1) {
      const slug = ex.chains[0]!;
      const chain = chainFromUserText(slug);
      for (const t of ex.tokens) {
        if (!t.address || !chain) continue;
        const fits = EVM_ADDRESS.test(t.address) ? chain.namespace === "eip155" : chain.namespace === "solana";
        if (!fits) return ask(`That address can't be on ${titleCase(slug)}. Which chain is it on?`);
      }
    }
  }

  let tokenFromMemory = false;
  let traderFromMemory = false;
  const traderAvailable = ex.traders.length > 0 || (traderDeixis && memTraders.length === 1);
  // The remembered coin is still unplaced (a ticker the provider found on
  // several chains, so it asked "which one?"), and this message names one
  // chain: that chain IS the answer ("on base", "the one on base"). Without
  // it the follow-up re-sent the bare ticker and got the same question back.
  const onlyMem = memTokens.length === 1 && memTokens[0]!.kind === "token" ? memTokens[0]! : null;
  const answersChain = ex.chains.length === 1 && explicitTokens.length === 0 && onlyMem !== null && !onlyMem.chain;
  let chained: Extract<SubjectQuery, { kind: "token" }> | null = null;

  if (need.token === 2) {
    if (explicitTokens.length > 2) return ask("I can compare two coins at a time. Which two?");
    const pool: SubjectQuery[] = [...explicitTokens];
    for (const m of memTokens) {
      if (pool.length >= 2) break;
      if (!pool.some((p) => sameSubject(p, m))) {
        pool.push(m);
        tokenFromMemory = true;
      }
    }
    if (pool.length < 2) return ask(stale && explicitTokens.length === 0 ? ASK_TWO_STALE : ASK_TWO);
  } else if (need.token === 1 && explicitTokens.length > 1) {
    return ask(`Which coin do you mean: ${label(explicitTokens[0]!)} or ${label(explicitTokens[1]!)}?`);
  } else if (need.token === 1 && explicitTokens.length === 0 && !(need.traderSuffices && traderAvailable && !tokenDeixis)) {
    // A required coin always falls back to the remembered one; an optional
    // coin ("who is selling?") only when something points at it.
    const pointed = !need.tokenOptional || tokenDeixis || tokenDeixisWeak || fromMemory || correction || answersChain;
    if (!pointed) {
      if (intent === "token-sellers" || intent === "token-buyers") intent = "token-activity";
    } else if (ex.chains.length === 1 && memTokens.length > 0 && memTokens.every((m) => m.kind === "token" && !!m.chain && m.chain !== ex.chains[0])) {
      return ask(`Which coin on ${titleCase(ex.chains[0]!)} do you mean? Send its ticker or contract address.`);
    } else if (memTokens.length === 1) {
      if (answersChain && onlyMem?.kind === "token") {
        const slug = ex.chains[0]!;
        const chain = chainFromUserText(slug);
        if (onlyMem.address && chain) {
          const fits = EVM_ADDRESS.test(onlyMem.address) ? chain.namespace === "eip155" : chain.namespace === "solana";
          if (!fits) return ask(`That address can't be on ${titleCase(slug)}. Which chain is it on?`);
        }
        chained = { ...onlyMem, chain: slug };
      }
      tokenFromMemory = true;
    } else if (memTokens.length > 1) {
      return ask(`Which coin do you mean: ${label(memTokens[0]!)} or ${label(memTokens[1]!)}?`);
    } else if (need.tokenOptional && !tokenDeixis && !history) {
      // "The sellers" with no conversation behind it is the whole feed.
      if (intent === "token-sellers" || intent === "token-buyers") intent = "token-activity";
    } else {
      return ask(stale ? ASK_TOKEN_STALE : ASK_TOKEN);
    }
  }
  // "Did he buy it?" narrows a trader's activity to the remembered coin.
  if (intent === "trader-activity" && explicitTokens.length === 0 && tokenDeixis && memTokens.length === 1) tokenFromMemory = true;

  if (need.trader === 1) {
    if (ex.traders.length > 1) return ask(`Which trader do you mean: ${label(ex.traders[0]!)} or ${label(ex.traders[1]!)}?`);
    if (ex.traders.length === 0) {
      const wants = need.traderRequired || traderDeixis;
      if (wants && memTraders.length === 1) traderFromMemory = true;
      else if (wants && memTraders.length > 1) return ask(`Which trader do you mean: ${label(memTraders[0]!)} or ${label(memTraders[1]!)}?`);
      else if (need.traderRequired) return ask(stale ? ASK_TRADER_STALE : ASK_TRADER);
    }
  }
  if (tokenFromMemory) usesMemory.push("token");
  if (traderFromMemory) usesMemory.push("trader");
  // The placed coin is this message's subject from here on: the lookup
  // carries the chain, and applyPlan remembers it on the stored coin.
  if (chained) {
    explicitTokens.push(chained);
    if (subjects.length < 2) subjects.unshift(chained);
  }

  // Window and side carry over only when this message continues the last
  // question. A new question with its own subject starts from defaults.
  const continues = usable && (fromMemory || correction || tokenFromMemory || traderFromMemory);
  if (window === null && continues && memory!.window) {
    window = memory!.window;
    usesMemory.push("window");
  }
  side = intent === "token-sellers" ? "sell" : intent === "token-buyers" ? "buy" : ACTIVITY_INTENTS.has(intent) ? statedSide : null;
  if (side === null && continues && fromMemory && memory!.side && ACTIVITY_INTENTS.has(intent)) {
    side = memory!.side;
    usesMemory.push("side");
  }
  if (intent === "rankings-traders" && window === "1h") return ask(ASK_RANK_WINDOW);

  const resolved = mergeResolved([...explicitTokens, ...ex.traders], memory, usesMemory, intent, ctx.now);
  let sinceRevision: number | null = null;
  if (intent === "changes-since" && usable && memory!.dossierRevision) {
    const t = resolved.find((r) => r.kind === "token");
    if (t && memTokens.some((m) => sameSubject(m, t))) {
      sinceRevision = memory!.dossierRevision.revision;
      usesMemory.push("dossierRevision");
    }
  }

  const calls = buildCalls(intent, resolved, {
    window,
    side,
    freshness,
    limit: limitOf(c),
    cohort,
    board,
    sinceRevision,
    depth: DEEP.test(c) ? "deep" : QUICK.test(c) ? "quick" : "standard",
    chain: ex.chains.length === 1 ? ex.chains[0]! : null,
  });
  if (!calls) return ask(TRADER_INTENTS.has(intent) ? ASK_TRADER : ASK_TOKEN);
  return plan(null, calls);
}

const VOCATIVE_NEXT = /^(?:what|who|why|how|which|is|are|can|could|do|does|did|should|please|pls|hey|show|tell|give|find|any|has|have)\b/;
const FOMO_WHATS_UP = /\bwhat is (?:happening|going on|new|hot|up)\b|\banything (?:happening|new)\b/;
/** "Since your last analysis" refers to an old answer; it does not ask for a new opinion. */
const PRIOR_ANALYSIS = /\b(?:your |the |my |our )?(?:last|previous|prior) analysis\b/g;
const TRADER_INTENTS: ReadonlySet<FomoIntent> = new Set(["trader-holdings", "trader-activity", "trader-context"]);

const ASK_TOKEN = "Which coin do you mean? Send its ticker or contract address.";
const ASK_TOKEN_STALE = "It has been a while since we looked at a coin. Which one do you mean? Send its ticker or contract address.";
const ASK_TOKEN_CORRECTION = "Which coin did you mean? Send its ticker or contract address.";
const ASK_TRADER = "Which trader do you mean? Send their Fomo handle.";
const ASK_TRADER_STALE = "It has been a while since we looked at a trader. Which one do you mean? Send their Fomo handle.";
const ASK_TRADER_CORRECTION = "Which trader did you mean? Send their Fomo handle.";
const ASK_TWO = "Which two coins should I compare?";
const ASK_TWO_STALE = "It has been a while since we looked at those coins. Which two should I compare?";
const ASK_RANK_WINDOW = "Trader rankings cover 24h, 7d, 30d or all time. Which window do you want?";
const ASK_WATCH = "Which coin should I watch? Send its ticker or contract address.";
const ASK_UNWATCH = "Which coin should I stop watching? Send its ticker or contract address.";

function boardOf(c: string): RankingBoard {
  return /\bgraduat/.test(c) ? "graduated-tokens" : /\bmost[- ]held\b/.test(c) ? "most-held-tokens" : "trending-tokens";
}

/** Intents whose answer is a list of trades, where a side filter means something. */
const ACTIVITY_INTENTS: ReadonlySet<FomoIntent> = new Set(["trader-activity", "token-activity", "token-sellers", "token-buyers"]);

interface Need {
  token: 0 | 1 | 2;
  trader: 0 | 1;
  /** No coin means the whole feed, not a missing subject. */
  tokenOptional?: boolean;
  /** A trader without a coin is a complete subject (their theses). */
  traderSuffices?: boolean;
  traderRequired?: boolean;
  /** A chain hint changes the answer even with no coin (boards, discovery). */
  chainMatters?: boolean;
}

const SUBJECT_NEEDS: Readonly<Record<FomoIntent, Need>> = {
  "trader-holdings": { token: 0, trader: 1, traderRequired: true },
  "trader-activity": { token: 0, trader: 1, traderRequired: true },
  "trader-context": { token: 0, trader: 1, traderRequired: true },
  "token-theses": { token: 1, trader: 1, traderSuffices: true },
  "token-sellers": { token: 1, trader: 0, tokenOptional: true },
  "token-buyers": { token: 1, trader: 0, tokenOptional: true },
  "token-activity": { token: 1, trader: 0, tokenOptional: true },
  "words-vs-actions": { token: 1, trader: 0 },
  "rankings-traders": { token: 0, trader: 0 },
  "rankings-tokens": { token: 0, trader: 0, chainMatters: true },
  opportunities: { token: 0, trader: 0, chainMatters: true },
  "compare-theses": { token: 2, trader: 0 },
  "changes-since": { token: 1, trader: 0 },
  "why-skipped": { token: 1, trader: 0 },
  "research-coin": { token: 1, trader: 0 },
  "research-status": { token: 1, trader: 0, tokenOptional: true },
  health: { token: 0, trader: 0 },
  watch: { token: 1, trader: 0 },
  unwatch: { token: 1, trader: 0 },
};

// ── Tool calls ───────────────────────────────────────────────────────────

interface CallOptions {
  window: PlanWindow | null;
  side: PlanSide | null;
  freshness: FreshnessMode;
  limit: number | null;
  cohort: boolean;
  board: RankingBoard | undefined;
  sinceRevision: number | null;
  depth: (typeof RESEARCH_DEPTHS)[number];
  chain: string | null;
}

function tokenRef(q: SubjectQuery | undefined): Record<string, unknown> | null {
  if (!q || q.kind !== "token") return null;
  const out: Record<string, unknown> = {};
  if (q.address && (EVM_ADDRESS.test(q.address) || SOLANA_MINT.test(q.address))) out.token = q.address;
  else if (q.symbol && SYMBOL.test(q.symbol)) out.token = q.symbol.toUpperCase();
  else return null;
  if (q.chain && SLUG.test(q.chain)) out.chain = q.chain;
  return out;
}

function traderRef(q: SubjectQuery | undefined): string | null {
  if (!q || q.kind !== "trader") return null;
  // The user id survives a rename; the handle is only a label.
  if (q.userId && UUID.test(q.userId)) return q.userId;
  if (q.handle && HANDLE.test(q.handle)) return q.handle;
  return null;
}

/**
 * The smallest retrieval that answers the intent. Null when a required
 * subject could not become a valid argument.
 */
function buildCalls(intent: FomoIntent, resolved: readonly SubjectQuery[], o: CallOptions): FomoToolCall[] | null {
  const tokens = resolved.filter((s) => s.kind === "token");
  const trader = traderRef(resolved.find((s) => s.kind === "trader"));
  const token = tokenRef(tokens[0]);
  const fresh = o.freshness !== "prefer-fresh" ? { freshness: o.freshness } : {};
  const win = o.window ? { window: o.window } : {};
  const lim = o.limit ? { limit: o.limit } : {};
  const sideArg = o.side === "buy" || o.side === "sell" ? { side: o.side } : {};
  const cohortArg = o.cohort ? { cohort_only: true } : {};
  const chainOnly = o.chain && SLUG.test(o.chain) ? { chain: o.chain } : {};
  const call = (tool: FomoToolCall["tool"], args: Record<string, unknown>): FomoToolCall => ({ tool, args: sanitizePlanArgs(args) });

  switch (intent) {
    case "trader-holdings":
      return trader ? [call("fomo_get_trader_context", { trader, ...fresh })] : null;
    case "trader-context":
      return trader ? [call("fomo_get_trader_context", { trader, ...win, ...fresh })] : null;
    case "trader-activity":
      return trader ? [call("fomo_get_trader_activity", { trader, ...(token ?? {}), ...sideArg, ...win, ...lim, ...fresh })] : null;
    case "token-theses":
      if (!token && !trader) return null;
      return [call("fomo_get_token_theses", { ...(token ?? {}), ...(trader ? { trader } : {}), ...win, ...lim, ...fresh })];
    case "token-sellers":
    case "token-buyers":
      if (!token) return null;
      return [call("fomo_get_token_activity", { ...token, side: intent === "token-sellers" ? "sell" : "buy", ...win, ...cohortArg, ...lim, ...fresh })];
    case "token-activity":
      return [call("fomo_get_token_activity", { ...(token ?? chainOnly), ...sideArg, ...win, ...cohortArg, ...lim, ...fresh })];
    case "words-vs-actions":
      return token ? [call("fomo_research_coin", { ...token, focus: "words-vs-actions", ...win, ...fresh })] : null;
    case "rankings-traders":
      return [call("fomo_get_rankings", { board: "traders", ...win, ...lim, ...cohortArg, ...fresh })];
    case "rankings-tokens":
      return [call("fomo_get_rankings", { board: o.board ?? "trending-tokens", ...chainOnly, ...lim, ...fresh })];
    case "opportunities":
      return [call("fomo_find_opportunities", { ...chainOnly, ...win, ...lim, ...cohortArg, ...fresh })];
    case "compare-theses": {
      const refs = tokens.slice(0, 2).map(tokenRef);
      if (refs.length < 2 || refs.some((r) => !r)) return null;
      return refs.map((r) => call("fomo_get_token_theses", { ...r!, ...win, ...fresh }));
    }
    case "changes-since":
      return token ? [call("fomo_research_coin", { ...token, ...(o.sinceRevision !== null ? { since_revision: o.sinceRevision } : {}), ...win, ...fresh })] : null;
    case "why-skipped":
      return token ? [call("fomo_get_research_status", { ...token })] : null;
    case "research-coin":
      return token ? [call("fomo_research_coin", { ...token, depth: o.depth, ...win, ...fresh })] : null;
    case "research-status":
      return [call("fomo_get_research_status", { ...(token ?? {}) })];
    case "health":
      return [call("fomo_get_research_status", {})];
    case "watch":
      return token ? [call("fomo_watch_coin", { ...token })] : null;
    case "unwatch":
      return token ? [call("fomo_unwatch_coin", { ...token })] : null;
  }
}

const FRESHNESS_MODES: readonly FreshnessMode[] = ["cached-ok", "prefer-fresh", "force-refresh"];

/**
 * The last line of defence on arguments: only known names, only values of
 * the expected shape. A tenant, URL, path, host or credential has no key
 * here and no value shape that admits it, so it cannot leave this module in
 * a plan even if a rule above were wrong.
 */
export function sanitizePlanArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of PLAN_ARG_KEYS) {
    const v = args[key];
    if (v === undefined) continue;
    switch (key) {
      case "trader":
        if (typeof v === "string" && (UUID.test(v) || HANDLE.test(v))) out[key] = v;
        break;
      case "token":
        if (typeof v === "string" && (EVM_ADDRESS.test(v) || SOLANA_MINT.test(v) || SYMBOL.test(v))) out[key] = v;
        break;
      case "chain":
        if (typeof v === "string" && SLUG.test(v)) out[key] = v;
        break;
      case "window":
        if ((PLAN_WINDOWS as readonly unknown[]).includes(v)) out[key] = v;
        break;
      case "side":
        if (v === "buy" || v === "sell") out[key] = v;
        break;
      case "limit":
        if (typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= MAX_LIMIT) out[key] = v;
        break;
      case "freshness":
        if ((FRESHNESS_MODES as readonly unknown[]).includes(v)) out[key] = v;
        break;
      case "cohort_only":
        if (v === true) out[key] = v;
        break;
      case "since_revision":
        if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) out[key] = v;
        break;
      case "depth":
        if ((RESEARCH_DEPTHS as readonly unknown[]).includes(v)) out[key] = v;
        break;
      case "focus":
        if (v === "words-vs-actions") out[key] = v;
        break;
      case "board":
        if ((RANKING_BOARDS as readonly unknown[]).includes(v)) out[key] = v;
        break;
    }
  }
  return out;
}

/** Type guard for an intent name read back from storage or another module. */
export function isFomoIntent(v: unknown): v is FomoIntent {
  return (FOMO_INTENTS as readonly unknown[]).includes(v);
}
