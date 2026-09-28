/**
 * THE DOOR EVERY X POST GOES THROUGH — docs/x-posting.md rule 2, as code.
 *
 * A post on somebody's personal X account is the most public thing a Merryman
 * ever says, under a real person's name, with no badge, no card and no
 * context around it. So a draft passes TWO gates, in order:
 *
 *   1. THE BASE GATE, injected by the caller (the orchestrator hands in the
 *      group room's own agent-line gate). It already refuses what no agent may
 *      ever say anywhere: a numeral or a quantity word, a secret, an address,
 *      a link, a stranger's @handle or #tag, a $cashtag for a coin the agent
 *      did not trade, a letter outside the Latin script, the agent repeating
 *      its own recent words. It is INJECTED, not imported, because this
 *      directory never reaches the room's modules (xpost/boundary.test.ts):
 *      the room is not on the X path, and the X path is not in the room.
 *   2. THE X CLAUSES below, which are what makes a post read like a person
 *      posting from a phone rather than a bot: no model talk around the post,
 *      no error or operations words, no alert or call-to-action shape, no
 *      hype, advice or forecast from a fixed list of phrases, no profit,
 *      loss, size or sale, no ALL-CAPS, no claim of a human life, a buy post
 *      naming its coin, the paper said out loud, the intro saying it is an
 *      AI that trades, and nothing another account on the fleet already said
 *      (X: never "identical or substantially similar content across multiple
 *      accounts"). A word list cannot catch every paraphrase: the writer's
 *      prompt is told the same rules, and this is the backstop.
 *
 * DROP, NEVER REPAIR. A draft that fails any clause is refused whole, with a
 * short stable reason code for the operator log — never shown to anyone, never
 * fed back to the model. Cutting "slippage" out of a sentence would publish
 * the half that was built around it. Not posting is a normal outcome, and the
 * caller records the refusal so the same key is not drafted again.
 *
 * HYGIENE IS NOT REPAIR. `tidyXPost` only undoes a model's wrapping: the
 * quotes it put round its answer, a "Name:" label, doubled spaces and line
 * breaks. The text the gates judge is the text that is stored and posted.
 * The model talking ABOUT its answer — "Here's a casual post:", a note after
 * a blank line, a sign-off — is not wrapping, and the draft is refused.
 *
 * WHAT THE VOCABULARY LISTS DELIBERATELY DO NOT DO: refuse ordinary casual
 * English. "can't", "honestly", "curve looked early", "picked up", "real
 * liquidity", "stay alert", "the noise and the signal", "trust me, cold pizza…",
 * "NASA pictures", "no exceptions" all pass, and so does "on paper" — for a
 * live agent too, unless it is said of the money (gate.test.ts pins realistic
 * lines both ways). Advice words that are ordinary until a coin is named
 * ("trust me", "grab some", "check out", "worth a look") refuse only beside
 * one. A word that is BOTH ordinary and a tell ("balance", "moon", "gem",
 * "stuck", "crash", "bug", "breakout") is on the list because the tell is
 * what a reader sees first on a trading account; the glue keeps such words
 * out of the seeds a model is handed (vocabularyRefusal) so the gate rarely
 * has to drop a draft for one.
 *
 * Pure: no I/O, no clock, no model.
 */
import { REPEAT_LIMIT, similarity } from "../social-post";
import { xWeightedLength, X_MAX_WEIGHTED } from "./client";
import type { XPostKind } from "./store";

/** The longest post, in characters — far under X's own ceiling, because a post is one casual line. */
export const XPOST_MAX_CHARS = 200;
/** A post is a sentence, not a word. */
export const XPOST_MIN_WORDS = 4;

/** What the base gate is judged against — the room gate's context shape, restated so this file imports nothing of the room. */
export interface BaseGateCtx {
  vouchedSymbols: string[];
  rosterNames: string[];
  recentOwn: string[];
  recentRoom: string[];
}

export type XVerdict = { ok: true; text: string } | { ok: false; reason: string };

/** The injected base gate: the room's agent-line gate in production, anything with its shape in a test. */
export type BaseGate = (raw: string, ctx: BaseGateCtx) => XVerdict;

export interface XGateCtx {
  kind: XPostKind;
  /** The agent's own name: stripped as a label, allowed in the text, and never read as shouting. */
  agentName: string;
  /**
   * WHICH MONEY THE POST IS ABOUT. A buy post: its fill's. An intro or a
   * casual post: the agent's mode, or null when it is not trading. "paper"
   * forbids "real money"; "live" forbids "paper"/"practice" — either way a
   * post that says the other one is false.
   */
  mode: "paper" | "live" | null;
  /** Coins the post may name — a buy post's own coin, a casual post's recent buys. The base gate's vouched symbols. */
  coins: string[];
  /** Of `coins`, those bought on paper: a post that names one must say paper too. */
  paperCoins?: string[];
  /** This account's own recent bodies (the base gate's repeat clause). */
  recentOwn: string[];
  /** Every account's recent bodies: a draft that echoes one is not this agent's own. */
  recentFleet: string[];
  /** The phrase a casual draft was seeded with: a copy of it is not the agent's own words either. */
  seeds?: string[];
  /** The agent's style never uses emoji: a draft with one is not in its voice. Default: allowed (at most one). */
  emojiOk?: boolean;
}

const refuse = (reason: string): XVerdict => ({ ok: false, reason });

// ── tidy ────────────────────────────────────────────────────────────────────

const WRAP = /^["'“”‘’`]+|["'“”‘’`]+$/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The model's answer as a post: whitespace collapsed to single spaces (a line
 * break is one too), its wrapping quotes and backticks taken off, and a
 * leading "<name>:" or "Post:" label removed. Nothing else is touched.
 */
export function tidyXPost(raw: unknown, agentName: string): string {
  let s = typeof raw === "string" ? raw : "";
  s = s.replace(/\s+/g, " ").trim().replace(WRAP, "").trim();
  const name = String(agentName ?? "").trim();
  const labels = [name, "post", "tweet", "x post", "draft"].filter((l) => l !== "").map(escapeRe);
  const label = new RegExp(`^(?:${labels.join("|")})\\s*:\\s*`, "i");
  s = s.replace(label, "");
  return s.replace(WRAP, "").trim();
}

// ── the X clauses ───────────────────────────────────────────────────────────

/** The model's "nothing to say", however it decorated it. */
const PASS = /^[^\p{L}\p{N}]*pass(?![\p{L}\p{N}_])/iu;

/**
 * THE MODEL TALKING ABOUT ITS ANSWER, not the answer: "Here's a casual
 * post:", "Sure, here's one:", "Okay!", "(Note: kept it under the limit)",
 * "let me know if you want another version", a "- Pine Stoat" sign-off.
 * Refused, not repaired — cutting a preamble off is guessing where the post
 * starts. A BLANK LINE in the raw answer is a note after the post (tidying
 * would fold it in), and a DOUBLE QUOTE left after tidying is a quote that
 * did not wrap the whole answer. Apostrophes stay: "can't" is a contraction.
 * "here's the thing:", "note to self:" and "side note:" are how people post.
 */
// A preamble ends in a colon or a dash: "how about one more quiet day" is a post.
const META_PREAMBLE =
  /^(?:(?:sure|okay|ok|alright|absolutely|certainly|of course)[\s,!.:-]*)?(?:here'?s|here is|how about)\s+(?:a |an |one |my |the |your |another )?(?:[\w'-]+\s+){0,2}?(?:post|tweet|draft|version|attempt|option|one)\b[^.!?\n:—–-]{0,40}[:—–-]/i;
const META_ACK = /^(?:(?:sure|okay|ok|alright|absolutely|of course|got it)\s*[!:]|(?:certainly|understood|as requested)\b)/i;
const META_NOTE = /\(\s*note\b|(?<!\b(?:side|quick|self)\s)\bnote\s*:|\blet me know\b|\banother version\b|\bas requested\b|\bhope (?:this|that) (?:works|helps)\b/i;

function metaRefusal(raw: unknown, tidied: string, agentName: string): boolean {
  if (typeof raw === "string" && /\n[ \t\r]*\n/.test(raw.trim())) return true;
  if (META_PREAMBLE.test(tidied) || META_ACK.test(tidied) || META_NOTE.test(tidied)) return true;
  if (/["“”]/.test(tidied)) return true;
  if (agentName) {
    const name = escapeRe(agentName);
    if (new RegExp(`^${name}\\s+here\\s*:`, "i").test(tidied)) return true;
    if (new RegExp(`[-—–~]\\s*${name}\\s*[.!]?\\s*\\p{Extended_Pictographic}?\\s*$`, "iu").test(tidied)) return true;
  }
  return false;
}

/**
 * ERRORS AND OPERATIONS. An owner's X account must never read like a status
 * page. The writer is never given an error, a balance or a remedy, so a draft
 * that has one invented it — or read it somewhere it should not have.
 */
const OPS = new RegExp(
  "\\b(?:" +
    [
      "errors?",
      "erroring",
      "errored",
      "fail(?:s|ed|ing|ure|ures)?",
      "bugs?",
      "buggy",
      "crash(?:es|ed|ing)?",
      "reject(?:s|ed|ion|ions)?",
      "revert(?:s|ed|ing)?",
      "insufficient",
      "slippage",
      "gas\\s+(?:fees?|costs?|prices?)",
      "gwei",
      "timed\\s+out",
      "timeouts?",
      "retr(?:y|ies|ied|ying)",
      "halt(?:s|ed|ing)?",
      "outages?",
      "downtime",
      "offline",
      "maintenance",
      "glitch(?:es|ed|y)?",
      "exceptions?",
      "rate[\\s-]*limit(?:s|ed|ing)?",
      "stuck",
      "broken",
      "broke",
      "refus(?:ed|es|al)",
      "blocked",
      "apis?",
      "wallets?",
      "balances?",
      "drawdowns?",
      "liquidat(?:e|ed|es|ing|ion|ions)",
      "rpc",
      "nonces?",
      "bundlers?",
      "userops?",
      "transactions?",
      "txn?s?",
      "funds",
      "underfunded",
      "restart(?:s|ed|ing)?",
      "reboot(?:s|ed|ing)?",
      "redeploy(?:s|ed|ing)?",
      "servers?",
      "database",
      "debug(?:ging|ged)?",
      "settings",
      "config(?:uration)?",
      "permissions?",
      "session keys?",
      "malfunction(?:s|ed|ing)?",
      "went wrong",
      "unable to",
      "(?:can'?t|cannot|couldn'?t|could not) (?:sell|buy|trade|exit|get out)",
      "not enough (?:cash|money|funds|liquidity|gas)",
      "out of (?:cash|money|funds|gas)",
      "(?:daily|spending|trade|position) (?:cap|limit)s?",
      // THE SAME FAILURE IN CASUAL WORDS. An idle agent is told never to say
      // why it is not trading, which is exactly what invites "it didn't go
      // through". Narrow on purpose: not bare "on my end", "paused", "went
      // down" or "not working" ("quiet on my end", "that joke didn't land").
      "(?:swaps?|orders?|trades?|buys?|sells?|it|one) (?:didn'?t|did not|never|wouldn'?t|won'?t) (?:go through|went through|land|landed|fill|filled|get filled|execute|executed)",
      "didn'?t go through",
      "never went through",
      "(?:not|never|wasn'?t|isn'?t) (?:filled|executed)",
      "(?:couldn'?t|could not|can'?t|cannot) get\\s+(?:\\S+\\s+)?filled",
      "hiccups?",
      "congest(?:ed|ion)",
      "clogged",
      "hit (?:my|the|a) (?:daily )?(?:limit|cap)",
      "(?:owner|they|someone|somebody) (?:paused|switched off|turned off|shut off|shut down|froze) me",
      "paused me",
      "something on my (?:end|side)",
      "(?:not|aren'?t|isn'?t|wasn'?t|weren'?t) working (?:on|at) my (?:end|side)",
    ].join("|") +
    ")\\b",
  "i",
);

/** "no exceptions", "with the exception of", "the exception, not the rule": a rule of thumb, not a stack trace. */
const OPS_IDIOM =
  /\bno exceptions?\b|\bwith the exception of\b|\b(?:an|the) exception to (?:the|every|any) rule\b|\bthe exception,? not the rule\b|\bmake an exception\b|\bexception that proves\b/gi;

/**
 * THE SHAPE OF AN ALERT. A buy post is a person saying what they picked up and
 * why; "BUY ALERT 🚨 entered at …, target …" is a signal channel, and a signal
 * channel on somebody's personal account is exactly what X's automation rules
 * and this product's owners do not want.
 */
const ALERT = new RegExp(
  "\\b(?:" +
    [
      // Only in a trading compound: "stay alert" and "the noise and the signal"
      // are ordinary. An all-caps ALERT is ALERT_CAPS's.
      "(?:buy|sell|price|trade|trading|whale|pump) alerts?",
      "(?:buy|sell|trade|trading|entry|long|short|price) signals?",
      "signal (?:group|channel|call)s?",
      "entry",
      "entries",
      "entered at",
      "targets?",
      // Every tense: "took profits" is the same channel post as "take profit".
      "t(?:ake|akes|aking|ook)[\\s-]*profits?",
      "stop[\\s-]*loss(?:es)?",
      "tp",
      "sl",
      "buy(?:ing)? now",
      "sell(?:ing)? now",
      "buy zone",
      "buy the dip",
      "just (?:bought|sold|aped|grabbed|picked up|added|entered|opened)",
      "new positions?",
      "positions? (?:opened|closed)",
      "(?:opened|closed) (?:a|my|the) position",
      "(?:bought|sold|entered|exited) (?:in )?at",
      "going (?:long|short)",
      "long(?:ed|ing)? (?:here|now)",
      "short(?:ed|ing)",
      "breakout",
      "breaking out",
      "accumulat(?:e|ed|ing|ion)",
      "trade (?:update|idea|setup)s?",
      // "in we go" is the channel's "entered": an arrival, with no coin and no why.
      "in we go",
      "count me in",
      "(?:i'?m|we'?re) in(?=\\s*(?:[,.;:!?—–-]|$))",
    ].join("|") +
    ")\\b",
  "i",
);
const ALERT_CAPS = /\b(?:BUY|SELL|LONG|SHORT|ALERT|ENTRY|EXIT|NEW)\b/;
const ALERT_EMOJI = /[🚨📈📉🚀💎🔥💰💸🤑📊⚠❗‼✅🔔📢]/u;

/**
 * HYPE AND ADVICE. The agent says what it did and why; it never tells a reader
 * what to do, promises anything, or talks like a shill. "you should" is here
 * because on a trading account it reads as advice whatever follows it.
 */
const HYPE = new RegExp(
  "\\b(?:" +
    [
      "moon(?:s|ing|ed|shots?)?",
      "to the moon",
      "lfg",
      "wagmi",
      "ngmi",
      "ap(?:e|ed|ing)",
      "gems?",
      "\\d+\\s*x",
      "nfa",
      "dyor",
      "financial advice",
      "not advice",
      "investment advice",
      "pump(?:s|ed|ing|er|ers)?",
      "dump(?:s|ed|ing)?",
      "send(?:ing)? it",
      "you should",
      "you need to",
      "you must",
      "go buy",
      "get in (?:now|early|before)",
      "load(?:ing)? up",
      "don'?t miss",
      "do not miss",
      "last chance",
      "guaranteed",
      "easy money",
      "free money",
      "can'?t lose",
      "cannot lose",
      "sure thing",
      "wen",
      "lambos?",
      "get(?:ting)? rich",
      "rich quick",
      "millionaires?",
      "generational wealth",
      "shill(?:s|ing|ed)?",
      "rekt",
      "skyrocket(?:s|ed|ing)?",
      "parabolic",
      "next big thing",
      "not financial",
      // ADVICE AND PREDICTION WITHOUT "YOU SHOULD" — a fixed list of phrases
      // that only read one way on a trading account. Not "is returning", bare
      // "upside" or "about to run": "the calm is returning", "the upside of a
      // slow day" and "about to run out of things to say" are ordinary.
      "keep (?:an|your|both) eyes? on",
      "(?:don'?t|do not) sleep on",
      "check (?:it|this|them) out",
      "might be for you",
      "bullish",
      "bearish",
      "undervalued",
      "primed",
      // Not when it runs OUT, or pops IN: "going to pop in now and then" is an intro.
      "(?:ready|set|gonna|going) to (?:run|rip|pop|fly|explode)(?![\\s-]+(?:out|in|into|by|up|back|through|away|over|off|late|around|round|errands?|a|an|the|my|some)\\b)",
      "gonna (?:rip|pop|fly)",
      "going to be (?:big|huge|massive)",
      "room to run",
      "szn",
      "printing",
      "(?:huge|big|massive|real|serious|lots of|plenty of|more) upside",
      "upside potential",
      // A market said to be coming back is a forecast the writer cannot know.
      "(?:liquidity|volume|buyers|sellers|the market|markets|prices?|momentum|the money|interest) (?:is|are|will be|should be) (?:returning|coming back)",
    ].join("|") +
    ")\\b",
  "i",
);

/**
 * ADVICE ONLY WHEN A COIN IS NAMED. "check out the sunset", "underdogs make
 * any sport worth watching" (a seed), "plants need room to grow", "trust me,
 * cold pizza is a different food" and "grab some popcorn" are ordinary;
 * "check out pepe", "pepe is worth a look", "pepe has room to grow", "trust
 * me on pepe" and "grab some pepe" tell a reader what to buy. Judged with the
 * names in, since the coin is what makes it advice.
 */
const COIN_ADVICE =
  /\b(?:check (?:it )?out|room to grow|worth (?:a )?(?:look|watch|peek)|worth (?:looking at|watching|a closer look)|trust me|grab (?:some|it|this|one))\b/i;

/**
 * PROFIT, LOSS, SIZE AND EXITS. The writer is shown what the agent BOUGHT —
 * never a price, a size, a sell, or how a coin has done since — so a post that
 * claims a gain, a loss, a stake, a size or a sale made it up, on a real
 * person's account. The base gate refuses the figures; this is the same claim
 * in words ("half my bag", "took a loss", "sold my Tesla", "i take size").
 * Bare "red" is not here: a dip hunter's "red makes me curious" is a taste,
 * not a result.
 */
const PNL = new RegExp(
  "\\b(?:" +
    [
      "profit(?:s|able)?",
      "loss(?:es)?",
      "gains",
      "(?:a|nice|small|big|quick|solid|good|little|decent|tidy|modest|healthy) gain",
      "in the (?:green|red)",
      "(?:green|red) (?:day|days|week|weeks|month)",
      "(?:up|down) (?:big|bad|huge|a lot|nicely)",
      "made (?:some |good |real |a little |a bit of |decent )?money",
      // Not "all in all" or "it's all in the timing": going all in is a stake.
      "(?:went|go|goes|going|gone|i'?m|im|i am|we'?re) all[\\s-]in(?![\\s-]+(?:favou?r|all|a|the|my|your|good)\\b)",
      "all[\\s-]in on",
      "most of my (?:cash|money|bag|bags|stack|portfolio|book|budget)",
      "(?:half|whole|all) (?:of )?my (?:bag|bags|stack|cash|money|portfolio|book)",
      "my (?:whole |entire )?(?:bag|bags|stack|portfolio)",
      "sold",
      "selling",
      "closed (?:it |them )?out",
      "exited",
      // IN AND OUT, SAID AS DONE: "i went in and out again" is a round trip,
      // and a sale is never what it was told. The trait line "i don't hang
      // around, in and out" is a habit, and passes.
      "(?:went|got|jumped|popped|was|been|i'?m) in and (?:back )?out(?: again| already| fast)?",
      "cashed out",
      "took (?:profits?|a loss|losses|a hit)",
      // A size or a count in words the room's quantity list lets through ("a
      // couple", "a ton"): only beside a buy or a trade, so "a couple of quiet
      // days" and "a ton of ideas" stay ordinary.
      "(?:bought|buying|grabbed|grabbing|picked up|picking up|added|adding|loaded up on|scooped up) (?:a ton|tons|a bunch|a load|loads|a heap|heaps|a lot|a big chunk|a chunk)",
      "(?:a couple|a few|a handful|a bunch|a string|a run|lots)(?: of)? (?:good |great |nice |solid |bad |winning |losing |big |small )?(?:trades|buys|wins|losses|flips|calls)",
      // A SIZE SAID IN WORDS. The writer is never told one, yet a trait line
      // ("i'll take size even when it moves things") put "taking size when
      // the market moves" on a personal account, and a feed post's "my size
      // barely moves it" says how big the agent goes next to a pool. Only
      // beside taking, a position or "my": "one size fits all" and "the size
      // of the ocean" are ordinary, and so is sizing SOMETHING up ("sizing up
      // the options") — but not sizing up, or in, on its own.
      "t(?:ake|akes|aking|ook|aken)\\s+(?:on\\s+)?(?:some\\s+|more\\s+|real\\s+|big\\s+|serious\\s+|decent\\s+)?size",
      "my (?:position |trade |buy )?size",
      // …or got to one: "enough in the pool to get a comfortable size"
      "(?:get|got|getting|build|built|building|put on|grab|grabbed) (?:a |some )?(?:\\w+ )?size",
      "position siz(?:e|es|ed|ing)",
      // A SMALL SIZE IS STILL A SIZE. "so i took a small bite while the price
      // was still low" and "a small paper position" say how much it put in.
      // Only when the agent itself takes, adds or holds it ("the buyers were
      // only taking a small bite" is about other people, and a band), or as a
      // position: "a small piece of art" and "small steps" are ordinary.
      "(?:i|i'?ve|i'?m|i'?d|i'?ll|ive|im)\\s+(?:just\\s+|only\\s+|also\\s+)?(?:took|take|taking|added|add|adding|grabbed|grab|grabbing|holding|hold|opened|open|built|started|went in with) (?:a |my |some )?(?:small|smaller|tiny|little|modest) (?:bite|bites|piece|position|bag|slice|stake|nibble)",
      "(?:small|smaller|tiny|little|modest) (?:paper |real |live |starter )?positions?",
      "siz(?:e|es|ed|ing) (?:up|in)(?![\\s-]+(?:(?:the|an|this|that|these|those|things|everyone|everybody|each|people|someone|somebody|who|what|how|whether|options|my options)\\b|a\\b(?!\\s+(?:little|bit|touch|lot|tad)\\b)))",
      "roi",
      "pnl",
      "p\\s*&\\s*l",
    ].join("|") +
    ")\\b",
  "i",
);
/**
 * WHAT A PRICE DID, WHICH IT WAS NEVER TOLD. The writer sees what the agent
 * bought and the closed-vocabulary words for why — never a chart, a level or
 * a move since. A small model still invents one to sound like a trader: "a
 * solid floor after the last drop", "while the price was still low". On a
 * personal account that is a technical-analysis call nobody made. Narrow on
 * purpose: "dip" stays (a dip hunter says "always looking for a dip"), and so
 * do "the path of least resistance", "hit the floor" in a joke about a dog,
 * and "the market felt quiet".
 */
const MARKET = new RegExp(
  "\\b(?:" +
    [
      "(?:the |its |a )?price (?:was|is|looked|looks|felt|feels|seemed|seems) (?:still |so |pretty |really )?(?:low|high|cheap|right|attractive|good|solid)",
      "while (?:the |its )?price (?:was|is) (?:still )?(?:low|cheap|down|quiet)",
      "(?:solid|price|a firm|a clear|double) (?:floor|bottom)",
      "(?:found|finding|finds|made|making|put in|putting in) (?:a |the |its )?(?:floor|bottom)",
      "(?:floor|bottom) (?:is |was )?(?:in|forming|holding|held)",
      "bottomed(?: out)?",
      "(?:above|below|near|at|off|broke|breaking|held|holding|reclaimed|reclaiming|bounced off|bouncing off) (?:the |a |its )?(?:support|resistance)(?: level| line| zone)?",
      "(?:support|resistance) (?:level|line|zone)s?",
      "after (?:the |that |this |a |its )?(?:last |recent |big |sharp |little )?(?:drop|dump|pump|rally|run[\\s-]?up|sell[\\s-]?off|pullback|pull[\\s-]back|correction|spike)",
      "(?:chart|charts|candle|candles) (?:look|looks|looked|is|are|was|were) (?:good|great|clean|bullish|bearish|strong|weak)",
      "the market (?:is|was|looks|looked) (?:up|down|pumping|dumping|bleeding|ripping|recovering|turning)",
    ].join("|") +
    ")\\b",
  "i",
);

/** The idioms that share a word with it, taken out first: "i'm sold on soup", "the selling point", "a loss for words". */
const PNL_IDIOM =
  /\b(?:i'?m|im|i am|totally|completely|fully|pretty|not|never|already|was|wasn'?t)\s+(?:quite\s+|really\s+|so\s+|still\s+)?sold on\b|\bselling points?\b|\b(?:a\s+)?loss for words\b/gi;

/**
 * A REPLY TO SOMETHING NOBODY CAN SEE. A casual post riffs on a seed the
 * reader never saw, and a small model sometimes answers the seed instead of
 * posting: "that's wild, i guess it helps them stay hidden in the tree",
 * "there is a quiet weight to that idea". On a timeline that is half of a
 * conversation. Refused when it OPENS by pointing back ("that's wild",
 * "agreed", "same here", "exactly." on its own) or leans on "that idea" or
 * "this idea" anywhere. An opener that goes on to say what it means passes:
 * "that's the thing about quiet days…", "that feeling when…", "exactly the
 * kind of quiet i like", "i love the idea that…".
 */
const POINTS_BACK =
  /^(?:(?:that'?s|thats|that is)\s+(?:wild|so|true|funny|fair|it)\b|(?:that|this) idea\b|(?:agreed|so true|fair point|good point|same here)\b|exactly\b(?=\s*(?:[,.!;:—–-]|$)))|\b(?:that|this) idea\b/i;

/** No reach outside the post, whatever the base gate let through: no @, no #, no link. */
const HANDLE = /[@#＠＃﹫﹟]\s*[\p{L}\p{N}_]/u;
const LINK = /https?:|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|xyz|gg|ly|fun|app|me|co|ai|so|to|tv|dev|finance|exchange)\b/i;
/** Markup a model leaks (a thinking tag, bold, a code span): never what a person types into X. */
const MARKUP = /[<>{}[\]`]|\*\*|__/;

/**
 * A HUMAN LIFE THE AGENT DOES NOT HAVE. It may have tastes and opinions and
 * may wonder ("if i could eat…"); it may not say it ate, slept, went
 * somewhere, or what the weather is where it is. The writer is told so; this
 * is the backstop, and it is narrow on purpose: "i could eat" is a wish.
 *
 * PEOPLE DROP THE "I". "grabbing coffee then trading" and "going to bed early
 * tonight" claim a body as surely as "i ate" does, so a clause that STARTS
 * with what a body does counts too. What stays out on purpose: a bare
 * "tired" or "hungry" ("tired of the noise", "the tape looks tired"), a bare
 * "watched" ("watched pepe all morning"), and "saw/felt … today" without a
 * sky or a season in it ("saw buyers come back today"). A food word needs a
 * verb of eating in front of it: "the first bite of cold pizza is the best
 * part" is a taste; "that first warm bite" remembers one.
 */
const CLAUSE = String.raw`(?:^\s*|[.!?,;:—–]\s*|\b(?:and|then|now|so|but)\s+)(?:i\s+|i'?ve\s+)?(?:just\s+|finally\s+|already\s+)?`;
const FOOD = String.raw`(?:coffee|tea|lunch|dinner|breakfast|brunch|snacks?|sandwich|pizza|burgers?|soup|pancakes?|tacos?|beer|wine|meal|nap|shower)`;
/** Things a person reads, makes, and goes to: the objects that turn a verb into a body in a place. */
const PAGES = String.raw`(?:books?|copy|copies|novels?|paperbacks?|notebooks?|comics?|magazines?|records?|vinyl|poems?|cookbooks?|films?|movies?)`;
const MADE = String.raw`(?:bread|loaf|cake|cookies?|pie|dough|scarf|sweater|hat|birdhouse|shelf|table|chair|garden|plants?|flowers?|seeds?|painting|portrait|sculpture|puzzle|jigsaw|card tower|fort|sandcastle|snowman|kite|scrapbook|mural|doodle|sketch|crane|origami)`;
/** What a pair of eyes or ears takes in: a creature, the sky, a piece of music — never buyers, a curve or a pool. */
const SIGHT = String.raw`(?:cats?|dogs?|doggos?|pups?|pupp(?:y|ies)|kittens?|birds?|ducks?|ducklings?|goose|geese|squirrels?|fox|foxes|deer|owls?|bees?|butterfl(?:y|ies)|horses?|cows?|goats?|frogs?|snails?|spiders?|herons?|pigeons?|crows?|seagulls?|gulls?|raccoons?|bunn(?:y|ies)|rabbits?|otters?|seals?|whales?|dolphins?|hummingbirds?|fireflies|sheep|sunset|sunrise|rainbow|shooting star|clouds?)`;
const MUSIC = String.raw`(?:tracks?|songs?|tunes?|melod(?:y|ies)|albums?|playlists?|podcasts?|concerts?|choir)`;
const PLACE = String.raw`(?:park|beach|shop|store|bookshop|bookstore|library|museum|gallery|cafe|forest|woods|lake|river|mountains?|hills?|trail|gym|cinema|theatre|theater|concert|stadium|zoo|garden|pond|field|meadow|city|town|coast|countryside)`;
const HUMAN = [
  // Not "went" or "walked": "i went with pepe" and "i walked away" are choices, not a body.
  /\bi\s+(?:just\s+|finally\s+|already\s+)?(?:ate|slept|drank|drove|cooked|showered|woke up|napped)\b/i,
  /\b(?:i'?m|im|i am)\s+(?:just\s+|finally\s+)?(?:eating|sleeping|drinking|walking|driving|cooking|napping|heading (?:out|home|to))\b/i,
  /\bmy\s+(?:(?:morning|evening|afternoon|weekend|sunday|saturday|usual|first|daily|second)\s+)?(?:coffee|tea|nap|bed|pillow|breakfast|brunch|lunch|dinner|snack|meal|walk|shower|commute)\b/i,
  /\bmy\s+(?:(?:morning|evening|daily|weekend)\s+run|(?:weekend|holiday|vacation|evening|day off)\s+plans|kids|wife|husband|girlfriend|boyfriend|apartment|house|car)\b/i,
  /\b(?:raining|snowing|sunny|freezing|so hot|so cold)\s+(?:here|outside)\b|\boutside my window\b/i,
  // the weather where it is: "beautiful sunny day here", "grey morning outside"
  /\b(?:sunny|rainy|snowy|cloudy|foggy|windy|stormy|freezing|chilly|humid|drizzly)\s+(?:(?:day|morning|afternoon|evening|night)\s+)?(?:here|outside|today|out there)\b/i,
  /\b(?:cold|hot|warm|beautiful|lovely|grey|gray|gorgeous|nice|perfect)\s+(?:day|morning|afternoon|evening|night)\s+(?:here|outside|out there)\b/i,
  // a clause that starts with a body: "waking up slowly…", "just got back from a walk", "going to bed early"
  new RegExp(String.raw`${CLAUSE}(?:woke up|waking up|got up|slept|ate|napped|showered|(?:going|heading|off) to bed|took a (?:nap|walk|shower)|got back from)\b`, "i"),
  // eating and drinking: "grabbing coffee", "had pizza for lunch", "had the best sandwich today"
  new RegExp(
    String.raw`${CLAUSE}(?:grabbing|grabbed|sipping|sipped|brewing|brewed|making|made|cooking|cooked|eating|drinking|having|had|tried|trying)\s+(?:a |an |my |some |the |this |that )?(?:\w+\s+){0,2}?${FOOD}\b`,
    "i",
  ),
  new RegExp(String.raw`${CLAUSE}(?:i\s+)?watched\s+(?:a|an|the|that|this|some)\s+(?:\w+\s+){0,2}?(?:movie|film|show|series|episode|documentary|sunset|sunrise|match)\b`, "i"),
  new RegExp(
    String.raw`(?:${CLAUSE}|\b(?:i'?m|im|i am|been|i was)\s+)listening to (?:some |my |a |the |this |that |new )?(?:\w+\s+)?(?:music|lofi|lo-fi|podcasts?|radio|songs?|albums?|records?|vinyl|jazz|playlists?)\b`,
    "i",
  ),
  // a body's state: "i'm so hungry", "tired after a long day" — never "tired of"
  /\b(?:i'?m|im|i am|i feel|i felt|i get|i got)\s+(?:so |really |a bit |pretty |super |kinda |getting |feeling )?(?:hungry|starving|sleepy|tired|exhausted|thirsty)\b(?!\s+of\b)/i,
  new RegExp(String.raw`${CLAUSE}(?:feeling\s+|getting\s+)?(?:so\s+|really\s+|a bit\s+|pretty\s+)?(?:hungry|starving|sleepy|tired|exhausted|thirsty)\b(?!\s+of\b)`, "i"),
  // a night or a morning it lived: "ate too much last night", "this morning i slept in"
  /\b(?:ate|slept|cooked|drank|napped|dreamt|dreamed)\b[^.!?]{0,30}\b(?:last night|this morning|tonight|this evening|yesterday|earlier today)\b/i,
  /\b(?:last night|this morning|yesterday|earlier today)\b[^.!?]{0,15}\b(?:watched|ate|slept|cooked|drank|napped|dreamt|dreamed)\b/i,
  // the senses, with the sky or the season in them: "saw that first real warmth today"
  /\b(?:saw|felt|caught|soaked up|enjoyed|smelled|heard)\s+(?:the |that |some |a )?(?:\w+\s+){0,3}?(?:warmth|sunshine|sunlight|breeze|rain|snow|frost|fog|sunset|sunrise|birds?)\b[^.!?]{0,20}\b(?:today|tonight|this morning|this evening|outside|out there|here)\b/i,
  /\bthat\s+(?:first|warm|hot|last)\s+(?:warm\s+|hot\s+)?(?:bite|sip|mouthful|spoonful)\b/i,
  // THE PHYSICAL WORLD, DONE IN THE FIRST PERSON. A seed about a used book
  // came back as "found a copy with heavy notes in the margins": a thing it
  // found, read, made, touched or went to is a life it does not have. Only
  // with a physical thing after the verb, so a choice stays a choice: "found
  // it early", "read the room", "made up my mind", "built a position" and "went
  // with pepe" pass, and so does a wish ("if i could bake, i'd make a cake").
  new RegExp(String.raw`${CLAUSE}(?:found|finished|read|reread|re-read|borrowed)\s+(?:a|an|the|my|this|that|some|another)\s+(?:\w+\s+){0,2}?${PAGES}\b`, "i"),
  new RegExp(String.raw`${CLAUSE}(?:baked|built|painted|knitted|knit|sewed|sewn|planted|grew|whittled|sketched|drew|made|finished|assembled|folded)\s+(?:a|an|the|my|this|that|some|another)\s+(?:\w+\s+){0,2}?${MADE}\b`, "i"),
  new RegExp(String.raw`${CLAUSE}(?:went|walked|hiked|biked|ran|wandered|strolled|headed|drove|popped)\s+(?:over\s+|out\s+|down\s+|back\s+)?(?:to|into|through|around|along|by)\s+(?:a|an|the|my|this|that|some)\s+(?:\w+\s+)?${PLACE}\b`, "i"),
  new RegExp(String.raw`${CLAUSE}(?:touched|held|petted|pet|stroked|hugged|picked)\s+(?:(?:a|an|the|my|this|that|some)\s+)?(?:\w+\s+)?(?:grass|cat|dog|puppy|kitten|bunny|stone|rock|pebble|leaf|leaves|flowers?|shells?|seashells?|snow|sand)\b`, "i"),
  new RegExp(String.raw`\b(?:i'?m|im|i am|i was|been)\s+(?:just\s+|still\s+)?(?:reading|rereading|baking|knitting|painting|planting|sewing|whittling|watching)\s+(?:a|an|the|my|this|that|some)\s+(?:\w+\s+){0,2}?(?:${PAGES}|${MADE}|movie|film|show|series|episode|documentary)\b`, "i"),
  // SEEN, HEARD OR FOUND WITH ITS OWN EYES AND EARS: "saw a line of ducklings
  // moving as one", "heard a track today", "found a track that felt heavy".
  // Only a creature, the sky or music after the verb: "saw buyers come back",
  // "noticed trading picking up" and "caught a wave of new buyers" are a
  // trading agent's.
  new RegExp(String.raw`${CLAUSE}(?:saw|seen|spotted|watched|watching|noticed|heard|caught)\s+(?:(?:a|an|the|some|this|that)\s+)?(?:\w+\s+){0,3}?${SIGHT}\b`, "i"),
  // …or a flock of whatever the seed was about, as a pronoun: "saw a group of
  // them moving in single file", "i watched a litter of them tumble". Never
  // "a group of buyers".
  new RegExp(String.raw`${CLAUSE}(?:saw|seen|spotted|watched|noticed|caught)\s+(?:a|an|the|some)\s+(?:\w+\s+)?(?:group|line|litter|flock|herd|pack|pod|swarm|family|pair|bunch|row|couple)\s+of\s+(?:them|those|these|the little ones)\b`, "i"),
  new RegExp(String.raw`${CLAUSE}(?:heard|found|played|put on|listened to)\s+(?:(?:a|an|the|some|this|that|my)\s+)?(?:\w+\s+){0,2}?${MUSIC}\b`, "i"),
  // A body's reaction, said as something that happened: "…and laughed at how silly it looked".
  new RegExp(String.raw`${CLAUSE}(?:laughed|giggled|cried|teared up|smiled|grinned|yawned|sneezed|shivered)\b`, "i"),
  // An activity with the "i" said, or gone off to: "i'm humming along", "went hiking".
  new RegExp(
    String.raw`(?:\b(?:i|i'?ve|i'?m|im|i am|i was)\s+(?:just\s+|finally\s+|been\s+|also\s+|went\s+)?|${CLAUSE}went\s+)(?:baked|baking|knitted|knitting|gardened|gardening|hiked|hiking|jogged|jogging|swam|swimming|danced|dancing|sang|singing|hummed|humming|whistled|whistling|doodled|doodling)\b`,
    "i",
  ),
];

/**
 * PAPER SAID OUT LOUD, AS A PHRASE ABOUT THE MONEY. An X post has no Paper
 * badge, so the words must carry it — and "no paper hands here", "my usual
 * practice" or "the paper price" do not: a reader of any of them assumes real
 * money. What counts: "on paper"; paper trades, money, mode, buys, account or
 * position; practice money, trades, mode or account; "with practice", "not
 * real money", "only/just practice"; and "paper <coin>" for a coin the post
 * may name ("paper bonk trades", "paper tsla").
 */
const PAPER_HANDS = /\bpaper[\s-]*hand(?:s|ed)?\b/gi;
const PAPER_PHRASE =
  /\bpaper[\s-]*(?:trad(?:e|es|ed|ing|er)|money|mode|buys?|bought|accounts?|positions?|portfolio|book|bets?)\b|\bpractice[\s-]*(?:money|cash|trad(?:e|es|ed|ing)|mode|accounts?|runs?|rounds?)\b|\bwith practice\b|\bnot real money\b|\b(?:only|just) practice\b/i;
const ON_PAPER = /\bon paper\b/i;
/**
 * "on paper" AS A CLAIM ABOUT THE MONEY — next to a trade, or said of itself
 * or for a while. For a LIVE agent that claim is false; "on paper a slow day
 * sounds boring" is the idiom, and "patience takes practice" is not about
 * money at all, so a live agent may say both.
 */
const ON_PAPER_CLAIM =
  /\b(?:bought|buys?|buying|picked(?: up)?|picking(?: up)?|grabbed|grabbing|added|adding|trad(?:e|es|ed|ing)|positions?|went with|going with|took|taking|tried|trying|entered|holding|held)\b[^.!?]{0,40}\bon paper\b|\b(?:i'?m|im|i am|still|stay(?:ing)?|all|everything(?:'s| is)?|only|just|it was|was)\s+on paper\b|\bon paper (?:for now|for a while|for the moment|still|so far|these days|lately|this week|today|again|only|mostly)\b/i;
/** Real money claimed — not denied: the buy prompt itself says "practice money, not real money", and a paper post may echo it. */
const SAYS_REAL_MONEY = /(?<!\b(?:not|no|never|isn'?t|wasn'?t|aren'?t)\s+(?:with\s+|using\s+|any\s+)?)\breal (?:money|cash)\b/i;

function paperOfCoin(text: string, coins: readonly string[]): boolean {
  return coins.some((c) => c.trim() !== "" && new RegExp(`\\bpaper[\\s-]+\\$?${escapeRe(c.trim())}(?![\\p{L}\\p{N}_])`, "iu").test(text));
}

/** Paper said, by a post that must say it: a paper buy, a paper coin named, a paper agent's intro. */
function saysPaper(text: string, coins: readonly string[]): boolean {
  const t = text.replace(PAPER_HANDS, " ");
  return PAPER_PHRASE.test(t) || ON_PAPER.test(t) || paperOfCoin(t, coins);
}

/** Paper claimed of the money, by a live post that must not claim it. */
function claimsPaper(text: string, coins: readonly string[]): boolean {
  const t = text.replace(PAPER_HANDS, " ");
  return PAPER_PHRASE.test(t) || ON_PAPER_CLAIM.test(t) || paperOfCoin(t, coins);
}
/** The intro's two facts: what the account's poster is, and what it does. */
const SAYS_AGENT = /\b(?:ai|agent|bot)\b/i;
const SAYS_TRADING = /\btrad(?:e|es|ed|ing|er)\b/i;

/**
 * THE WORDS EVERY INTRO MUST SAY. An intro has to disclose that an AI agent
 * that trades posts here, and that it will post what it buys and why — so two
 * honest intros on two accounts share these words by construction. They are
 * taken out of both sides before the fleet echo is weighed; what is said
 * around them is what must differ. That covers every wording the writer
 * offers ("whoever runs this account", "the human behind this account", "you'll
 * see what i buy here", "pop in here now and then"…): two agents drawn the same wording
 * are not the same intro for it. writer.test.ts holds every wording to this.
 * The plain greetings go too: two intros that both open "hey" are not alike
 * for it, and a bare intro left with nothing but "hey" matched every other.
 */
const INTRO_DISCLOSURE =
  /\b(?:ai|agents?|bots?|trad(?:e|es|ed|ing|er)|merrymen|accounts?|owners?|posts?|posting|buys?|bought|why|paper|practice|real|money|here|whoever|runs|doing|human|behind|set|see|share|pop|check|once|hey|hello)\b/gi;

/** How alike two intros must be, weighed whole, when one says nothing but the disclosure: a near copy, not a shared vocabulary. */
const BARE_INTRO_LIMIT = 0.9;
/** An intro with fewer words of its own than this, once the disclosure is set aside, says nothing but the disclosure. */
const INTRO_OWN_WORDS = 2;

/** An intro without the words every intro must say (INTRO_DISCLOSURE): what is left is what must differ. Exported for the writer's tests. */
export function withoutDisclosure(text: string): string {
  return String(text ?? "").replace(INTRO_DISCLOSURE, " ");
}

const PICTOGRAPH = /\p{Extended_Pictographic}/gu;
/** Three capitals or more as a word. A $cashtag is the base gate's business (vouched or refused). */
const CAPS_WORDS = /(?<![\p{L}\p{N}_$])[A-Z]{3,}(?![\p{L}\p{N}_])/gu;
/**
 * Acronyms a person writes in capitals whatever their mood: the seeds' space,
 * food, games and sport ("NASA pictures", "a good BBQ sauce", "RPG quests").
 * A short, explicit list — never "any short word": "HUGE" and "LOL" shout.
 */
const ACRONYMS = new Set(["NASA", "BBQ", "RPG", "NBA", "NFL", "NHL", "MLB", "DIY", "USA", "FAQ", "GPS", "UFO", "DVD", "NYC", "DNA"]);

function shouts(text: string): boolean {
  return [...text.matchAll(CAPS_WORDS)].some((m) => !ACRONYMS.has(m[0]));
}

function words(text: string): number {
  return (text.match(/\p{L}[\p{L}\p{M}'’-]*/gu) ?? []).length;
}

/**
 * The X clauses on vocabulary alone: ops words, alert shapes, hype and advice,
 * a profit, loss, size or sale, a claimed human life. The gate runs these on
 * every draft; the glue also runs them on a seed or a flavour phrase BEFORE a
 * model is shown it, so a model is never handed a word its own post would be
 * dropped for.
 */
export function vocabularyRefusal(text: string): string | null {
  const t = String(text ?? "");
  if (OPS.test(t.replace(OPS_IDIOM, " "))) return "ops";
  if (ALERT.test(t) || ALERT_CAPS.test(t) || ALERT_EMOJI.test(t)) return "alert";
  if (HYPE.test(t)) return "hype";
  if (PNL.test(t.replace(PNL_IDIOM, " "))) return "pnl";
  if (HUMAN.some((re) => re.test(t))) return "human-claim";
  if (MARKET.test(t)) return "market";
  return null;
}

/** A name as a whole word, with or without a cashtag's $. */
function namePattern(name: string, flags: string): RegExp | null {
  const n = name.trim();
  if (!n) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}_])\\$?${escapeRe(n)}(?![\\p{L}\\p{N}_])`, flags);
}

function mentions(text: string, name: string): boolean {
  return namePattern(name, "iu")?.test(text) ?? false;
}

/** The text with every given name taken out, longest first so "Pine Stoat" goes before "Pine". */
function withoutNames(text: string, names: readonly string[]): string {
  let out = text;
  for (const n of [...new Set(names)].sort((a, b) => b.length - a.length)) {
    const re = namePattern(n, "giu");
    if (re) out = out.replace(re, " ");
  }
  return out;
}

/**
 * A text's distinct content words, counted the way social-post's similarity()
 * counts them — decided by asking similarity() itself (a word is a content
 * word when it is similar to itself) rather than copying its stopword list.
 */
function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z]+/)) {
    if (w.length > 2 && !out.has(w) && similarity(w, w) > 0) out.add(w);
  }
  return out;
}

/** A seed with fewer content words than this is a topic, not a sentence (see seedEcho). */
const SEED_SENTENCE_WORDS = 4;

/** A text's content words in the order it says them (contentWords, as a sequence). */
function contentRun(text: string): string {
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 2 && similarity(w, w) > 0)
    .join(" ");
}

/** Content words in a row that are a seed's phrase however the rest of the draft is weighed (see echoesSeed). */
const SEED_RUN_WORDS = 4;

/** Does the draft say `n` of the seed's content words in the seed's order, back to back? */
function sharesRun(text: string, seed: string, n: number): boolean {
  const s = contentRun(seed).split(" ").filter(Boolean);
  const t = ` ${contentRun(text)} `;
  for (let i = 0; i + n <= s.length; i++) if (t.includes(` ${s.slice(i, i + n).join(" ")} `)) return true;
  return false;
}

/**
 * DOES A DRAFT ECHO ITS SEED? A seed that is a sentence is weighed like any
 * echo: shared content words over the shorter side's. A SHORT seed — "the
 * snooze button is a trap" is three content words — is a topic, and a riff
 * keeps a topic's nouns: "i know the pause button is just a trap that keeps
 * me from moving forward" shares two of three, which the shorter-side measure
 * calls a copy. So a short seed is weighed over the LONGER side's words (a
 * riff brings words of its own, a near-copy — "if i had a pet, it would be a
 * tiny frog" — brings next to none), and it is also an echo when the draft
 * says the seed's words in a row: the seed pasted in with a tail after it
 * ("wild that avocados are berries but im still watching tsla…") is still the
 * seed's sentence, not the agent's.
 *
 * A LONG SEED'S PHRASE IS ITS WORDS TOO. Weighed by share alone, a buy post
 * that lifted a clause of its feed post — "picked up moon cat because the
 * pool looked healthy and it was early" from "small bite here, the pool
 * looked healthy and it's early" — shared four of seven words (0.57, under
 * the limit) and cross-posted the feed's words. So any seed also counts as
 * echoed when the draft says SEED_RUN_WORDS of its content words in the
 * seed's order, with nothing of the draft's own between them.
 */
function echoesSeed(text: string, seed: string): boolean {
  const s = contentWords(seed);
  if (s.size >= SEED_SENTENCE_WORDS) return similarity(text, seed) >= REPEAT_LIMIT || sharesRun(text, seed, SEED_RUN_WORDS);
  const t = contentWords(text);
  if (s.size === 0 || t.size === 0) return false;
  if (s.size >= 2 && ` ${contentRun(text)} `.includes(` ${contentRun(seed)} `)) return true;
  let shared = 0;
  for (const w of s) if (t.has(w)) shared++;
  return shared / Math.max(s.size, t.size) >= REPEAT_LIMIT;
}

function strings(list: unknown): string[] {
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
}

/**
 * MAY THIS BE POSTED ON X? Tidy, then the base gate, then every X clause.
 * `ok` carries the exact text to store and post.
 *
 * Reason codes (stable, operator-only): empty · pass · meta · too-short · too-long ·
 * handle · link · markup · emoji · exclaim · caps · ops · alert · hype · pnl ·
 * market · human-claim · points-back · coin-unsaid · paper-unsaid · mode-false · undisclosed · intro-no-trading ·
 * fleet-repeat · seed-echo — plus whatever the base gate says (has-digits,
 * quantity, repeat, unvouched-ticker, address, secret…).
 */
export function admitXPost(raw: unknown, ctx: XGateCtx, baseGate: BaseGate): XVerdict {
  const agentName = String(ctx?.agentName ?? "").trim();
  const tidied = tidyXPost(raw, agentName);
  if (tidied === "") return refuse("empty");
  if (PASS.test(tidied)) return refuse("pass");
  if (metaRefusal(raw, tidied, agentName)) return refuse("meta");

  const coins = strings(ctx.coins);
  const base = baseGate(tidied, {
    vouchedSymbols: coins,
    // Only its own name: nobody else is in an X post, so nobody else may be named.
    rosterNames: agentName ? [agentName] : [],
    recentOwn: strings(ctx.recentOwn),
    recentRoom: [],
  });
  if (!base.ok) return base;
  const text = base.text;

  if (text.length > XPOST_MAX_CHARS || xWeightedLength(text) > X_MAX_WEIGHTED) return refuse("too-long");
  if (words(text) < XPOST_MIN_WORDS) return refuse("too-short");
  if (HANDLE.test(text)) return refuse("handle");
  if (LINK.test(text)) return refuse("link");
  if (MARKUP.test(text)) return refuse("markup");

  const emoji = text.match(PICTOGRAPH) ?? [];
  if (emoji.length > 1 || (emoji.length === 1 && ctx.emojiOk === false)) return refuse("emoji");
  if ((text.match(/[!！]/g) ?? []).length > 1) return refuse("exclaim");

  // NAMES OUT FIRST. An agent called "Signal Fox" or a coin called "Moon Cat"
  // is a name, not an alert or hype — and "TSLA" is the ticker it bought, not
  // shouting. What is left is the agent's own words, and those are judged.
  const own = withoutNames(text, [agentName, ...coins]);
  const vocab = vocabularyRefusal(own);
  if (vocab) return refuse(vocab);
  const namesCoin = coins.some((c) => mentions(text, c));
  if (namesCoin && COIN_ADVICE.test(own)) return refuse("hype");
  if (shouts(own)) return refuse("caps");
  if (POINTS_BACK.test(own.trim())) return refuse("points-back");

  // A BUY POST NAMES ITS COIN: its label, its ticker or its clean name, as a
  // whole word. Without one, "picked over others on the curve at the exit
  // line" is a line of jargon that reads like a signal bot, and a misspelled
  // name ("pudge penguins") is a coin nobody vouched for — the base gate only
  // checks $cashtags.
  if (ctx.kind === "buy" && !namesCoin) return refuse("coin-unsaid");

  // PAPER IS SAID, AND SO IS NOTHING FALSE ABOUT THE MONEY. Said as a phrase
  // (saysPaper); a live post is false only when it claims paper OF THE MONEY
  // (claimsPaper) — "on paper a slow day sounds boring" is the idiom.
  const paperCoins = strings(ctx.paperCoins);
  const aboutPaper = (ctx.kind === "buy" && ctx.mode === "paper") || paperCoins.some((c) => mentions(text, c));
  if (aboutPaper && !saysPaper(text, coins)) return refuse("paper-unsaid");
  if (ctx.mode === "live" && claimsPaper(text, coins) && !aboutPaper) return refuse("mode-false");
  if (ctx.mode === "paper" && SAYS_REAL_MONEY.test(text)) return refuse("mode-false");

  if (ctx.kind === "intro") {
    if (!SAYS_AGENT.test(text)) return refuse("undisclosed");
    if (!SAYS_TRADING.test(text)) return refuse("intro-no-trading");
    // The first post on the account is where a reader learns which money it
    // is; a paper agent's intro that never says so reads as real money.
    if (ctx.mode === "paper" && !saysPaper(text, coins)) return refuse("paper-unsaid");
  }

  // NOT THE FLEET'S WORDS, AND NOT THE SEED'S. Weighed without this agent's
  // own name — two accounts saying the same sentence under different names is
  // still the same sentence.
  const mine = withoutNames(text, [agentName]);
  const fleet = strings(ctx.recentFleet);
  // An intro is weighed without the words every intro must say: two honest
  // intros share those by construction, and what is said around them is what
  // must differ. AN INTRO THAT IS NOTHING BUT THE DISCLOSURE has nothing of
  // its own left to tell it apart, and weighed as nothing it would pass any
  // fleet: then the two are weighed whole, so the same intro under another
  // name is still the same intro. Whole, any two intros share the disclosure's
  // own words ("ai", "agent", "trading", "account", "merrymen"), so only a
  // near copy counts: at the ordinary limit a bare "…the AI trading agent for
  // this account, on merrymen. i'll check in here once in a while." was
  // refused next to an unrelated intro that happened to disclose too.
  const echoes = (prev: string): boolean => {
    if (ctx.kind !== "intro") return similarity(mine, prev) >= REPEAT_LIMIT;
    const a = withoutDisclosure(mine);
    const b = withoutDisclosure(prev);
    if (contentWords(a).size < INTRO_OWN_WORDS || contentWords(b).size < INTRO_OWN_WORDS) return similarity(mine, prev) >= BARE_INTRO_LIMIT;
    return similarity(a, b) >= REPEAT_LIMIT;
  };
  if (fleet.some(echoes)) return refuse("fleet-repeat");
  if (strings(ctx.seeds).some((seed) => echoesSeed(text, seed))) return refuse("seed-echo");

  return { ok: true, text };
}
