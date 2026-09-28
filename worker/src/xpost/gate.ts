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
 *      posting from a phone rather than a bot: no error or operations words,
 *      no alert or call-to-action shape, no hype or advice, no ALL-CAPS, no
 *      claim of a human life, the paper said out loud, the intro saying it is
 *      an AI that trades, and nothing another account on the fleet already
 *      said (X: never "identical or substantially similar content across
 *      multiple accounts").
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
 *
 * WHAT THE VOCABULARY LISTS DELIBERATELY DO NOT DO: refuse ordinary casual
 * English. "can't", "honestly", "curve looked early", "on paper", "picked up",
 * "real liquidity" all pass (gate.test.ts pins realistic lines both ways). A
 * word that is BOTH ordinary and a tell ("balance", "moon", "stuck") is on the
 * list because the tell is what a reader sees first on a trading account; the
 * glue keeps such words out of the seeds a model is handed (vocabularyRefusal)
 * so the gate rarely has to drop a draft for one.
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
    ].join("|") +
    ")\\b",
  "i",
);

/**
 * THE SHAPE OF AN ALERT. A buy post is a person saying what they picked up and
 * why; "BUY ALERT 🚨 entered at …, target …" is a signal channel, and a signal
 * channel on somebody's personal account is exactly what X's automation rules
 * and this product's owners do not want.
 */
const ALERT = new RegExp(
  "\\b(?:" +
    [
      "alerts?",
      "signals?",
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
      "grab (?:some|it|this|one)",
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
      "trust me",
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
      "(?:ready|set|gonna|going) to (?:run|rip|pop|fly|explode)(?![\\s-]+(?:out|into|through|away|over|off|late|around|errands?|a|an|the|my|some)\\b)",
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
 * any sport worth watching" (a seed) and "plants need room to grow" are
 * ordinary; "check out pepe", "pepe is worth a look" and "pepe has room to
 * grow" tell a reader what to buy. Judged with the names in, since the coin
 * is what makes it advice.
 */
const COIN_ADVICE = /\b(?:check (?:it )?out|room to grow|worth (?:a )?(?:look|watch|peek)|worth (?:looking at|watching|a closer look))\b/i;

/**
 * PROFIT, LOSS, SIZE AND EXITS. The writer is shown what the agent BOUGHT —
 * never a price, a size, a sell, or how a coin has done since — so a post that
 * claims a gain, a loss, a stake or a sale made it up, on a real person's
 * account. The base gate refuses the figures; this is the same claim in
 * words ("half my bag", "took a loss", "sold my Tesla"). Bare "red" is not
 * here: a dip hunter's "red makes me curious" is a taste, not a result.
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
      "cashed out",
      "took (?:profits?|a loss|losses|a hit)",
      "roi",
      "pnl",
      "p\\s*&\\s*l",
    ].join("|") +
    ")\\b",
  "i",
);
/** The idioms that share a word with it, taken out first: "i'm sold on soup", "the selling point", "a loss for words". */
const PNL_IDIOM =
  /\b(?:i'?m|im|i am|totally|completely|fully|pretty|not|never|already|was|wasn'?t)\s+(?:quite\s+|really\s+|so\s+|still\s+)?sold on\b|\bselling points?\b|\b(?:a\s+)?loss for words\b/gi;

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
];

/** Paper said out loud: an X post has no Paper badge, so the words must carry it. */
const SAYS_PAPER = /\b(?:paper|practice)\b/i;
const SAYS_REAL_MONEY = /\breal money\b|\breal cash\b/i;
/** The intro's two facts: what the account's poster is, and what it does. */
const SAYS_AGENT = /\b(?:ai|agent|bot)\b/i;
const SAYS_TRADING = /\btrad(?:e|es|ed|ing|er)\b/i;

/**
 * THE WORDS EVERY INTRO MUST SAY. An intro has to disclose that an AI agent
 * that trades posts here, and that it will post what it buys and why — so two
 * honest intros on two accounts share these words by construction. They are
 * taken out of both sides before the fleet echo is weighed; what is said
 * around them is what must differ.
 */
const INTRO_DISCLOSURE =
  /\b(?:ai|agents?|bots?|trad(?:e|es|ed|ing|er)|merrymen|accounts?|owners?|posts?|posting|buys?|bought|why|paper|practice|real|money|here)\b/gi;

const PICTOGRAPH = /\p{Extended_Pictographic}/gu;
/** Three capitals or more as a word. A $cashtag is the base gate's business (vouched or refused). */
const CAPS_WORD = /(?<![\p{L}\p{N}_$])[A-Z]{3,}(?![\p{L}\p{N}_])/u;

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
  if (OPS.test(t)) return "ops";
  if (ALERT.test(t) || ALERT_CAPS.test(t) || ALERT_EMOJI.test(t)) return "alert";
  if (HYPE.test(t)) return "hype";
  if (PNL.test(t.replace(PNL_IDIOM, " "))) return "pnl";
  if (HUMAN.some((re) => re.test(t))) return "human-claim";
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

/** Shared content words over ALL of both texts' content words; 0 when either has none. */
function sharedOfBoth(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

function strings(list: unknown): string[] {
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
}

/**
 * MAY THIS BE POSTED ON X? Tidy, then the base gate, then every X clause.
 * `ok` carries the exact text to store and post.
 *
 * Reason codes (stable, operator-only): empty · pass · too-short · too-long ·
 * handle · link · markup · emoji · exclaim · caps · ops · alert · hype · pnl ·
 * human-claim · coin-unsaid · paper-unsaid · mode-false · undisclosed · intro-no-trading ·
 * fleet-repeat · seed-echo — plus whatever the base gate says (has-digits,
 * quantity, repeat, unvouched-ticker, address, secret…).
 */
export function admitXPost(raw: unknown, ctx: XGateCtx, baseGate: BaseGate): XVerdict {
  const agentName = String(ctx?.agentName ?? "").trim();
  const tidied = tidyXPost(raw, agentName);
  if (tidied === "") return refuse("empty");
  if (PASS.test(tidied)) return refuse("pass");

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
  if (CAPS_WORD.test(own)) return refuse("caps");

  // A BUY POST NAMES ITS COIN: its label, its ticker or its clean name, as a
  // whole word. Without one, "picked over others on the curve at the exit
  // line" is a line of jargon that reads like a signal bot, and a misspelled
  // name ("pudge penguins") is a coin nobody vouched for — the base gate only
  // checks $cashtags.
  if (ctx.kind === "buy" && !namesCoin) return refuse("coin-unsaid");

  // PAPER IS SAID, AND SO IS NOTHING FALSE ABOUT THE MONEY.
  const paperCoins = strings(ctx.paperCoins);
  const aboutPaper = (ctx.kind === "buy" && ctx.mode === "paper") || paperCoins.some((c) => mentions(text, c));
  if (aboutPaper && !SAYS_PAPER.test(text)) return refuse("paper-unsaid");
  if (ctx.mode === "live" && SAYS_PAPER.test(text) && !aboutPaper) return refuse("mode-false");
  if (ctx.mode === "paper" && SAYS_REAL_MONEY.test(text)) return refuse("mode-false");

  if (ctx.kind === "intro") {
    if (!SAYS_AGENT.test(text)) return refuse("undisclosed");
    if (!SAYS_TRADING.test(text)) return refuse("intro-no-trading");
  }

  // NOT THE FLEET'S WORDS, AND NOT THE SEED'S. Weighed without this agent's
  // own name — two accounts saying the same sentence under different names is
  // still the same sentence.
  const mine = withoutNames(text, [agentName]);
  const fleet = strings(ctx.recentFleet);
  // An intro is weighed without the words every intro must say: two honest
  // intros share those by construction, and what is said around them is what
  // must differ.
  const weigh = (s: string) => (ctx.kind === "intro" ? s.replace(INTRO_DISCLOSURE, " ") : s);
  if (fleet.some((prev) => similarity(weigh(mine), weigh(prev)) >= REPEAT_LIMIT)) return refuse("fleet-repeat");
  if (strings(ctx.seeds).some((seed) => similarity(text, seed) >= REPEAT_LIMIT)) return refuse("seed-echo");

  return { ok: true, text };
}
