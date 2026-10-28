import { openerKey } from "./memory";
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
import { withoutFiguresLine } from "./figures";
import type { XPostKind } from "./store";
import type { SaleOutcome } from "./planner";
import { withoutReplyOptOut } from "./replies";
import { answerWord, textWords, withoutHouseSelfTruth } from "./words";

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
  /** Trusted result is appended after the model's neutral sale line is gated. */
  sellOutcome?: SaleOutcome;
  /** Exact weighted room after the sale result and verified token disclosure. */
  saleMaxLength?: number;
  /** The agent's own name: stripped as a label, allowed in the text, and never read as shouting. */
  agentName: string;
  /**
   * WHICH MONEY THE POST IS ABOUT. A buy post: its fill's. An intro or a
   * casual post: the agent's mode, or null when it is not trading. A reply:
   * its historical parent buy's mode, never the agent's current mode. "paper"
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
  /** Newest timeline posts only; replies never displace the eight-opener window. */
  recentOpeners?: string[];
  /** The phrase a casual draft was seeded with: a copy of it is not the agent's own words either. */
  seeds?: string[];
  /** The agent's style never uses emoji: a draft with one is not in its voice. Default: allowed (at most one). */
  emojiOk?: boolean;
  /**
   * NAMES THIS POST MAY NOT SAY AT ALL, however spelled (namedIn). An answer
   * to a tag that named a coin is handed every name its own buys go by: it
   * was never told what it bought, so a draft that names one anyway confirms
   * a buy by name ("yep, picked up pepe") — refused as bought-named, whatever
   * the model did with the prompt (red-team 2026-10-12).
   */
  unsaid?: string[];
  /**
   * WHAT AN ANSWER MAY SAY IT BOUGHT (red-team review, 2026-10-12), checked
   * only when set. "none": an answer that was told none of its buys — a tag
   * that named a coin, or anything but a plain question about its trades —
   * says no first-person buy at all ("yep, grabbed bonk", "bought it", "in
   * my bag"): the prompt said so, and this is the backstop when the model
   * does not listen. "vouched": a buy it says is of a coin in `coins`, or of
   * "it", "a few", "some coins"; "yep, bought wif lately" for a coin it was
   * never told of is refused. Either way, as buy-claim.
   */
  buys?: "none" | "vouched";
  /**
   * THE TAG NAMED A COIN, OR ASKED ABOUT ITS TRADES OR A COIN IN WORDS THAT
   * ARE NOT ONE OF THE PLAIN TRADES QUESTIONS (red-team review, 2026-10-12).
   * Read only with buys "none": then the answer may not say it likes the coin
   * either (LIKED), answer yes or no, or speak of itself outside a deflection
   * (namedClaim), as buy-claim.
   */
  named?: boolean;
  /**
   * WORDS AN ANSWER TOLD ITS BUYS WAS HANDED BESIDE THEM (red-team review,
   * 2026-10-12): its strategy's name, what it looked up. Read only when set, with buys
   * "vouched": then every word of the answer is an everyday one (xpost/words.ts
   * answerWord), one of these, or a word of a coin in `coins`. "grabbed some
   * coins lately, mostly wojak and bonk" named two coins it never bought, and
   * no verb list sees a name: a word that is none of those is refused, as
   * buy-claim.
   */
  known?: string[];
  /**
   * AN ANSWER HANDED WHAT IT LOOKED UP, TOLD NONE OF ITS BUYS (red-team
   * 2026-10-12), read with buys "none" and `known`: then every word is an
   * everyday one, one it was handed, or the name of a coin in `coins`, just
   * as for an answer told its buys. "per the index, bonk is ripping on
   * robinhood chain" under a tag about another coin credited a name nothing
   * looked up to the index; refused as unlooked-name.
   */
  lookedOnly?: boolean;
  /**
   * AN ACTIVE AGENT'S ANSWER TO A TAG (red-team 2026-10-12), kind "reply":
   * then a prediction, a level or an entry in any words is refused too
   * (ANSWER_PREDICTION), a coin named or not. Absent: every other reply,
   * judged as before.
   *
   * AND NO OPT-OUT LINE (the owner's decision, 2026-10-12): whoever tagged
   * the agent, replied to it or quoted it asked to be answered, so an answer
   * never carries "Say stop to opt out." The notice at the very end of a
   * draft is taken off before anything else reads it (ANSWER_NOTICE_TAIL),
   * and any other opt-out wording is refused as opt-out-said (OPT_OUT_SAID).
   * A stop is honoured exactly as before (replies.ts isAnswerOptOut). Every
   * other reply — a comment reply on any other owner's buy post — must still
   * end with the notice (opt-out-unsaid).
   */
  answer?: boolean;
  /**
   * A MODEL'S DRAFT OF AN ANSWER, NEVER A CODE-BUILT LINE (red-team
   * 2026-10-12): read only with `answer` true. Then the house's claims, a
   * tease, a judgement of the asker and a boast are refused as house-claim
   * (ANSWER_HOUSE_CLAIM), and a coin's future, named or pointed at, as hype
   * (draftedForecast: red-team review of daaae961). Code's own lines say what
   * they say by construction.
   */
  drafted?: boolean;
  /**
   * AN ACTIVE OWNER'S POST (MERRYMEN_XPOST_ACTIVE_TENANTS: the house's own
   * agents), whatever its kind (the owner's teammate, 2026-10-13): it never
   * names a data provider, coingecko, geckoterminal or bitquery, nor the
   * chain by its name, robinhood chain (the owner, 2026-10-18), on its
   * letters (sourceNamed), and is refused as source-named, a model's draft
   * or code's own line alike. Every other owner's posts are judged as before.
   */
  house?: boolean;
  /**
   * AN ACTIVE OWNER'S MARKET INSIGHT POST (kind "casual", the owner's
   * teammate, 2026-10-13): a model's words about the market now, beside
   * which code puts its figures line. Held to every screen a drafted answer
   * is: no advice, call, forecast, level, target or entry in any words
   * (COIN_ADVICE, REPLY_ADVICE, ANSWER_PREDICTION, ANSWER_CALL,
   * draftedForecast: hype), nothing for the house (house-claim), no amount
   * in words (quantity); and the caller passes `buys: "none"`, so any buy or
   * holding it says is refused (buy-claim).
   */
  insight?: boolean;
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

// ── sherwood-1, a name ──────────────────────────────────────────────────────

/**
 * SHERWOOD-1 IS A NAME, NOT A NUMBER (the owner's ask, 2026-10-12). Asked
 * what model it runs on, an answer teases "the new sherwood-1": built by
 * merrymen, whose own model it is, and still cooking. Every other digit is
 * still refused: the base gate's has-digits rule is what keeps prices, sizes,
 * counts and P&L off X, and it does not move.
 *
 * SO THE EXCEPTION IS ONE EXACT TOKEN, IN ONE KIND OF POST. Only in a reply
 * (answers are gated as replies); only "sherwood-1" spelled out, in any case,
 * standing alone as a word — after the start, a space or an opening quote or
 * bracket, and before the end, a space, a closing quote or bracket, or
 * sentence punctuation that is itself followed by a space or the end: never
 * "sherwood-10", "sherwood-1x", "sherwood-1.5", "sherwood-1%", "$sherwood-1",
 * "@sherwood-1" or one inside a link. Each one
 * is masked with a digit-free stand-in before the base gate and the X clauses
 * read the text, and put back as written in the text that is posted. Any
 * other digit beside it ("1 sherwood-1", "$1") is still has-digits. A casual,
 * buy, sell or intro post never names it.
 *
 * AND NEVER AS WHAT RUNS IT. Nothing wires sherwood into an agent yet, so on a
 * real-money trading account "running on sherwood-1", "powered by sherwood",
 * "sherwood-1 is live" is a false claim about what powers it. A reply that
 * says so is refused as sherwood-claim before anything else, with or without
 * the digit. Change this only once sherwood actually runs the agents.
 */
export const SHERWOOD_NAME = "sherwood-1";
const SHERWOOD_TOKEN = /(?<=^|[\s("“'‘])sherwood-1(?=$|[\s)"”]|[.,!?;:'’](?:$|[\s)"”]))/giu;
/** A digit-free stand-in no draft would say; a draft that does say it gets no exception. */
const SHERWOOD_STAND_IN = "sherwoodmerrymenname";
const STAND_IN = new RegExp(SHERWOOD_STAND_IN, "gi");
const HAS_STAND_IN = new RegExp(SHERWOOD_STAND_IN, "i");

/**
 * The text with every exact "sherwood-1" masked, and the spellings masked, in
 * order. Null when there is one to mask but the stand-in is already in the
 * text: then nothing could tell the two apart, and the digit is not excepted.
 */
function maskSherwood(text: string): { text: string; said: string[] } | null {
  const said: string[] = [];
  const masked = text.replace(SHERWOOD_TOKEN, (m) => {
    said.push(m);
    return SHERWOOD_STAND_IN;
  });
  if (said.length > 0 && HAS_STAND_IN.test(text)) return null;
  return { text: masked, said };
}

/** An earlier post as the masked draft is weighed against it. */
const withStandIn = (text: string): string => text.replace(SHERWOOD_TOKEN, SHERWOOD_STAND_IN);

/** The gated text with each stand-in put back as it was written. Anything else is refused, never guessed. */
function unmaskSherwood(text: string, said: string[]): XVerdict {
  const found = text.match(STAND_IN) ?? [];
  if (found.length !== said.length) return refuse("has-digits");
  let i = 0;
  return { ok: true, text: text.replace(STAND_IN, () => said[i++]!) };
}

/**
 * A DRAFT THAT SAYS SHERWOOD RUNS IT TODAY: "running on sherwood-1",
 * "powered by the new sherwood one", "sherwood-1 is what runs me", "i'm on
 * sherwood", "sherwood-1 is live". Errs toward refusing: a near miss costs
 * one answer, never a false claim. (writer.ts re-exports it for the answer
 * path, which records such a draft as gate:sherwood-claim.)
 */
const SHERWOOD_BEFORE = /\b(?:run(?:s|ning)?\s+(?:on|me|with)|ran\s+on|powered|powering|powers|built\s+on|based\s+on|i'?m\s+on|im\s+on|i\s+am\s+on|now\s+on|using|uses|i\s+use|under\s+the\s+hood|my\s+brain|my\s+model|behind\s+me|switched\s+to|upgraded\s+to|moved\s+to)\b[^.!?\n]{0,30}?\bsherwood\b/i;
const SHERWOOD_AFTER = /\bsherwood\b[^.!?\n]{0,40}?\b(?:runs|running|ran|powers|powering|powered|drives|driving|under\s+the\s+hood|is\s+my\s+(?:brain|model)|what\s+i\s+(?:run|use)|behind\s+me|in\s+charge|is\s+live|went\s+live|live\s+now|is\s+out|out\s+now|launched|shipped)\b/i;

/**
 * AN ALLOWLIST, NOT ONLY A LIST OF VERBS (review, 2026-10-12). A stranger who
 * asks "does sherwood-1 pick your trades now?" invites "yep, sherwood-1
 * picks my trades now", "my trades come from sherwood-1", "sherwood-1 is the
 * model behind this account" — none of which the verbs above name. So every
 * sentence that names sherwood must also tease it (cooking, in the oven, in
 * the works, coming, merrymen's own or house model…) and must say nothing
 * about trading, deciding, what it does or who it is: no pick, trade, call,
 * decide, choose, handle, buy, sell, entry, coin, no me, my, i, we, you, no
 * account, agent, brain or behind, and nothing about now. A sentence that
 * does either is a claim.
 */
const SHERWOOD_SAID = /\bsherwood/i;
const SHERWOOD_TEASE = /\b(?:cook(?:s|ed|ing)?|oven|bak(?:e|es|ed|ing)|in\s+the\s+works|in\s+the\s+making|coming(?:\s+soon)?|soon|simmer(?:s|ed|ing)?|stove|kitchen|brew(?:s|ed|ing)?|workshop|working\s+on|merrymen'?s\s+own|their\s+own|own\s+model|house\s+model|homegrown|not\s+(?:done|ready|served|out)|isn'?t\s+(?:done|ready|out)|(?:done|ready)\s+yet|not\s+yet|next\s+up|give\s+it\s+time|no\s+peeking|in\s+progress|on\s+the\s+way|under\s+wraps)\b/i;
const SHERWOOD_AGENCY = new RegExp(
  "\\b(?:" +
    [
      "pick(?:s|ed|ing|er)?",
      "trad(?:e|es|ed|er|ers|ing)",
      "call(?:s|ed|ing)?",
      "decid(?:e|es|ed|ing)",
      "decisions?",
      "choos(?:e|es|ing)",
      "chose|chosen|choices?",
      "handl(?:e|es|ed|ing)",
      "buy(?:s|ing)?|bought",
      "sell(?:s|ing)?|sold",
      "entr(?:y|ies)",
      "exits?",
      "coins?",
      "tokens?",
      "positions?",
      "signals?",
      "portfolio",
      "money",
      "wallets?",
      "i|me|my|mine|myself|im|ive|i'm|i've|i'd|i'll",
      "we|us|our|ours|we're|we've",
      "you|your|yours|ya|u|you're",
      "accounts?",
      "agents?",
      "brain",
      "engine",
      "behind",
      "run(?:s|ning)?|ran",
      "power(?:s|ed|ing)?",
      "driv(?:e|es|ing)|drove",
      "us(?:e|es|ed|ing)",
      "answer(?:s|ed|ing)?",
      "repl(?:y|ies|ied|ying)",
      "writ(?:e|es|ing)|wrote",
      "talk(?:s|ed|ing)?",
      "speak(?:s|ing)?",
      "posts?|posting",
      "now|today|already|currently|live",
    ].join("|") +
    ")\\b",
  "i",
);

/**
 * Each sentence that names sherwood, as the screen reads it: a stop ends one
 * only before a space or the end ("sherwood-1.5" is one word). Named on its
 * letters too (sherwoodMentioned), so "sher wood" is one.
 */
function sherwoodSentences(t: string): string[] {
  return t.split(/[.!?]+(?=\s|$)|\n+/).filter((s) => SHERWOOD_SAID.test(s) || sherwoodMentioned(s));
}

/**
 * A DRAFT AS THE SHERWOOD SCREEN READS IT (red-team review, 2026-10-12):
 * accents and every other mark taken off and invisible characters taken out,
 * then NFKC, so "sherwööd" (with a precomposed or a combining diaeresis) and
 * "sher\u00adwood" read as "sherwood". The word regexes above read NFKC only,
 * which keeps both, and the base gate's own script check reads the draft
 * with its marks already off, so it passed "sherwööd picks my coins".
 */
function plainDraft(draft: string): string {
  return draft.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "")
    .normalize("NFKC").replace(/[’‘]/g, "'");
}

export function sherwoodClaimed(draft: unknown): boolean {
  if (typeof draft !== "string") return false;
  const t = plainDraft(draft);
  if (SHERWOOD_BEFORE.test(t) || SHERWOOD_AFTER.test(t)) return true;
  return sherwoodSentences(t).some((s) => !SHERWOOD_TEASE.test(s) || SHERWOOD_AGENCY.test(s));
}

/**
 * Whether a draft names sherwood at all, however it spells it: only a
 * code-built line may (writer.ts modelAnswers). On its letters, the way a tag
 * is read (sherwoodMentioned): accents, spacing and invisible characters do
 * not hide it.
 */
export function sherwoodNamed(draft: unknown): boolean {
  return typeof draft === "string" && (SHERWOOD_SAID.test(plainDraft(draft)) || sherwoodMentioned(draft));
}

/**
 * LETTERS THAT READ AS LATIN ONES: Greek, Cyrillic, small capitals and a few
 * stroked letters that a tag can swap in for a plain letter and still read
 * the same on X. NFKC folds the fullwidth and mathematical alphabets
 * already; these it leaves alone.
 */
const LOOKALIKE: Readonly<Record<string, string>> = Object.freeze({
  α: "a", δ: "d", ε: "e", η: "n", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", ς: "s", τ: "t", υ: "u", χ: "x", ω: "w",
  а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", ѕ: "s", і: "i", ј: "j", һ: "h", ԁ: "d", ԝ: "w",
  ᴀ: "a", ʙ: "b", ᴄ: "c", ᴅ: "d", ᴇ: "e", ɢ: "g", ʜ: "h", ɪ: "i", ᴊ: "j", ᴋ: "k", ʟ: "l", ᴍ: "m", ɴ: "n", ᴏ: "o", ᴘ: "p", ʀ: "r", ꜱ: "s", ᴛ: "t", ᴜ: "u", ᴠ: "v", ᴡ: "w", ʏ: "y", ᴢ: "z",
  ø: "o", ł: "l", đ: "d", ð: "d", ħ: "h", ı: "i", ɑ: "a", ɡ: "g", ȷ: "j",
  // Hooked and turned IPA letters, and Armenian ones, that read as Latin on X (red-team 2026-10-12).
  ɗ: "d", ɖ: "d", ɓ: "b", ɦ: "h", ɾ: "r", ɯ: "w", ƥ: "p", օ: "o", հ: "h", ս: "u",
});
/**
 * CAPITALS THAT LOWERCASE INTO ANOTHER LOOK-ALIKE (red-team review,
 * 2026-10-12): a Greek capital Eta reads as H on X, but lowercased it is an
 * eta, which the table above reads as n ("SHERWOOD" with an Eta was
 * "snerwood"); a capital Nu reads as N, its small nu as v; a capital Beta was
 * dropped. So a Greek capital is read as the Latin capital it shows, before
 * anything is lowercased.
 */
const LOOKALIKE_UPPER: Readonly<Record<string, string>> = Object.freeze({
  Α: "a", Β: "b", Ε: "e", Ζ: "z", Η: "h", Ι: "i", Κ: "k", Μ: "m", Ν: "n", Ο: "o", Ρ: "p", Τ: "t", Υ: "y", Χ: "x",
});
/**
 * Digits and signs written for a letter: "sherw00d", "5herwood", "$herwood".
 * And the symbols that read as one of sherwood's letters on X (red-team
 * review, 2026-10-12): "sherwoo∂", "§herwood", "sher₩ood", "she℞wood",
 * "s♄erwood", "s#erwood". lettersOf dropped each, and the letter with it.
 */
const LEET: Readonly<Record<string, string>> = Object.freeze({
  "0": "o", "3": "e", "4": "a", "5": "s", "7": "t", $: "s", "@": "a", "€": "e",
  "∂": "d", "§": "s", "₩": "w", "℞": "r", "♄": "h", "#": "h", "®": "r", "©": "c", "°": "o",
});
/**
 * STROKES WRITTEN FOR A LETTER, read as it before lettersOf drops them
 * (red-team review, 2026-10-12): "s|-|erwood", "sher\/\/ood", "sherwoo|)",
 * "she|2wood", "sherw()()d". Only for finding sherwood (sherwoodMentioned)
 * and a source named (sourceNamed: "r()binhood chain").
 */
const STROKES: readonly (readonly [RegExp, string])[] = [
  [/\\\/\\\//g, "w"], [/\\\//g, "v"], [/\|-\|/g, "h"], [/\]-\[/g, "h"], [/\}\{/g, "h"],
  [/\|[)\]>]/g, "d"], [/\[\)/g, "d"], [/\|2/g, "r"], [/\(\)/g, "o"], [/\[\]/g, "o"], [/\|_\|/g, "u"],
];
function withStrokes(text: string): string {
  let t = text.normalize("NFKC");
  for (const [re, letter] of STROKES) t = t.replace(re, letter);
  return t;
}

/**
 * A TEXT'S LETTERS AND NOTHING ELSE, a-z: NFKC, lowercase, accents taken off,
 * look-alike letters read as the Latin ones, and every other character —
 * spaces, digits, punctuation, zero-width characters — dropped, so "pe pe",
 * "pe\u200bpe", "p.e.p.e" and "ρepe" are all "pepe". With `leet`, the digits
 * and signs people write for a letter are read as it first ("sherw00d").
 * What code matches a name against, never what anyone reads.
 */
export function lettersOf(text: unknown, o: { leet?: boolean } = {}): string {
  if (typeof text !== "string") return "";
  let out = "";
  for (const ch of asLatin(text)) out += LOOKALIKE[ch] ?? (o.leet ? LEET[ch] ?? ch : ch);
  return (o.leet ? out.replace(/vv/g, "w") : out).replace(/[^a-z]/g, "");
}

/**
 * NFKC, Greek capitals read as the Latin ones they show, the enclosed letters
 * read as theirs, lowercase, accents off: what lettersOf maps a character at
 * a time.
 */
function asLatin(text: string): string {
  let up = "";
  for (const ch of text.normalize("NFKC")) up += LOOKALIKE_UPPER[ch] ?? enclosedLetter(ch) ?? ch;
  return up.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

/**
 * LETTERS THAT ARE SYMBOLS TO UNICODE (red-team review, 2026-10-12): the
 * squared, negative circled and negative squared Latin capitals (🄰, 🅐, 🅰)
 * and the regional indicators (🇦, which pair into flags), which NFKC leaves
 * alone and lettersOf dropped: "🆂🅷🅴🆁🆆🅾🅾🅳" read as nothing. Each is read
 * as its letter.
 */
const ENCLOSED_BASES: readonly number[] = [0x1f130, 0x1f150, 0x1f170, 0x1f1e6];
function enclosedLetter(ch: string): string | null {
  const cp = ch.codePointAt(0) ?? 0;
  for (const base of ENCLOSED_BASES) if (cp >= base && cp < base + 26) return String.fromCharCode(0x61 + cp - base);
  return null;
}

/**
 * A LETTER lettersOf CANNOT READ (red-team review, 2026-10-12): one that is
 * neither a-z nor a look-alike it knows, so lettersOf would drop it and a
 * name spelled with it would read as nothing ("ꓢꓧꓰꓣꓪꓳꓳꓓ" in Lisu is
 * "SHERWOOD" on X and "" to code). Whoever asks whether a text names
 * something treats one as a yes: fail closed. The shrug's ツ is the room
 * gate's own exception, and reads as nothing.
 */
export function unreadableLetter(text: unknown): boolean {
  if (typeof text !== "string") return false;
  for (const ch of asLatin(text)) {
    if (ch !== "ツ" && /\p{L}/u.test(ch) && !/^[a-z]$/.test(LOOKALIKE[ch] ?? ch)) return true;
  }
  return false;
}

/**
 * SHERWOOD NAMED IN A TAG, IN ANY FORM (fail-closed review, 2026-10-12):
 * "sherwood", "$SHERWOODINU", "sherwood-1", "sherw00d", "s h e r w o o d",
 * "sher\u200bwood", "ꜱʜᴇʀᴡᴏᴏᴅ", "sherwοod" with a Greek o, "sherwod". Read on
 * the text's letters alone, so spacing, digits, zero-width characters and
 * look-alikes do not hide it. Errs toward finding it ("usher wood" counts):
 * a tag it finds gets no answer at all, which costs one answer, never a
 * screenshot of Merrymen's account confirming somebody's token. A letter it
 * cannot read at all (unreadableLetter: Lisu, Cherokee, Armenian, an IPA
 * letter it has no mapping for) counts as finding it: what code cannot read
 * may spell it.
 */
const SHERWOOD_LETTERS = /s+h+e*r+w+o*d/;
/**
 * ONE OF ITS LETTERS GONE (red-team review, 2026-10-12): a symbol no table
 * knows, written for one letter, takes that letter out of what lettersOf
 * reads ("sherwoo∂" was "sherwoo", "s|-|erwood" was "serwood"), and the
 * skeleton above missed it. So sherwood with any one of s, h, r, w or d
 * missing counts too (with both o's when the w or the d is the one gone):
 * "herwood", "serwood", "shewood", "sherood", "sherwoo". Errs toward
 * finding it: "her wood" counts, at the cost of one answer.
 */
const SHERWOOD_NEAR = /h+e+r+w+o+d|s+e+r+w+o+d|s+h+e+w+o+d|s+h+e*r+o{2,}d|s+h+e*r+w+o{2,}/;
/**
 * AS IT SOUNDS (red-team review, 2026-10-12): "should i buy shervud?" read as
 * no sherwood, and code's decline went up under it. A v said for its w and a
 * u for its o ("shervud", "sherwud", "shurwood") are read as sherwood too, and
 * so is any one word with sh, any vowels, an r straight before a w or a v,
 * any vowels, then d ("shirwood", "sharvud", "shrvd"). "shrewd", whose r and
 * w a vowel parts, and "sherwin", with no d, are still no sherwood.
 */
const SHERWOOD_SOUNDS = /sh+[aeiouy]*r+[wv]+[aeiouy]*d/;
export function sherwoodMentioned(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const stroked = withStrokes(text);
  const reads = [lettersOf(text), lettersOf(text, { leet: true }), lettersOf(stroked, { leet: true })];
  // "cl" written for a d ("sherwoocl"), read only for this.
  reads.push(reads[2]!.replace(/cl/g, "d"));
  reads.push(...reads.map((r) => r.replace(/v/g, "w").replace(/u/g, "o")));
  if (reads.some((r) => SHERWOOD_LETTERS.test(r) || SHERWOOD_NEAR.test(r))) return true;
  const words = text.normalize("NFKC").split(/[\s,.;:!?/()"'’‘-]+/u).filter(Boolean);
  if (words.some((w) => [lettersOf(w), lettersOf(w, { leet: true })].some((r) => SHERWOOD_SOUNDS.test(r)))) return true;
  return unreadableLetter(text);
}

/**
 * MERRYMEN NAMED, IN ANY SPELLING THE LETTERS ALLOW (red-team 2026-10-12):
 * "MERRIMEN", "MERYMEN", "MRYMN", "MEERYMEN", "MERR1MEN" were each shown as
 * a trending coin in code's line under Merrymen's own account, which reads
 * as the house naming a coin after itself. Read on the text's letters as
 * sherwood is (lettersOf, plain and leet): an m, then r, then m and n, with
 * any run of vowels or y between ("MARRYMEN", "MURRYMEN", "MIRRYMEN" were
 * posted too, red-team 2026-10-12). AND THE TRENCHER, ITS PRODUCT, ON ITS
 * CONSONANTS ("$TRNCHR"): t, r, n, ch, r with any vowels between. Errs toward
 * finding it ("MERMAN", "MORMON" count). Meant for a short text, a ticker:
 * across the words of a sentence its letters run together.
 */
const MERRYMEN_LETTERS = /m+[aeiouy]*r+[aeiouy]*m+[aeiouy]*n|merr|t+[aeiouy]*r+[aeiouy]*n+[aeiouy]*c+h+[aeiouy]*r/;
export function merrymenMentioned(text: unknown): boolean {
  if (typeof text !== "string") return false;
  return [lettersOf(text), lettersOf(text, { leet: true })].some((r) => MERRYMEN_LETTERS.test(r));
}

/**
 * A DATA PROVIDER NAMED, ON ITS LETTERS (the owner's teammate, 2026-10-13):
 * coingecko, geckoterminal or bitquery, however spaced, cased, dotted or
 * spelled in look-alikes or digits ("coin gecko", "C0inGecko", "bit-query").
 * "gecko" alone is enough: no trading post needs the lizard. What an active
 * owner's post may never say (XGateCtx.house, "source-named").
 *
 * AND THE CHAIN BY ITS NAME (the owner, 2026-10-18): "robinhood chain",
 * "robin hood chain", "r0binhood chain", "robinhood's chain", "r()binhood
 * chain". The i may be a 1, a bar or an l, which lettersOf drops or keeps
 * as l, so it is optional there; strokes are read as sherwood's are.
 * "robinhood" ALONE IS NOT: it stays an everyday word of a tag (words.ts
 * TAG_WORDS), and the house as the subject of a claim is houseClaimed's to
 * refuse. Only "robinhood" with "chain" straight after it is a name.
 */
const SOURCE_LETTERS = /gecko|g+e+c+k+o+t+e+r+m|b+i+t+q+u+e+r+y|bitqry|r+o+b+[il]*n+h+o+d+s?(?:the)?c+h+a+[il]*n/;
export function sourceNamed(text: unknown): boolean {
  if (typeof text !== "string") return false;
  return [lettersOf(text), lettersOf(text, { leet: true }), lettersOf(withStrokes(text), { leet: true })].some((r) => SOURCE_LETTERS.test(r));
}

/**
 * DOES A TEXT NAME ANY OF THESE, ON ITS LETTERS? Each name's letters inside
 * the text's (lettersOf: case, spacing, digits, invisible characters and
 * look-alikes ignored), plain or as leet. What a tag is matched against to
 * tell whether it names a coin it bought (writer.ts coinNamedIn), and what a
 * coin-named answer may not say (XGateCtx.unsaid). Errs toward yes.
 *
 * A NAME WITH NEXT TO NO LETTERS a-z (red-team review, 2026-10-12): a buy
 * called "ペペ" or "🐸" has no letters to match, so it was never found and
 * the tag that named it was told what it bought. Such a name (fewer than
 * three letters) is also matched on its own characters, NFKC, lowercase,
 * invisible characters out, whitespace collapsed, when it has a character
 * other than a plain letter or digit to match on.
 *
 * A SHORT NAME ONLY AS A WORD (red-team review, 2026-10-12). Inside the
 * letters of a whole sentence a ticker of two or three letters turns up
 * everywhere: an agent that bought MU, USO or BE was "named" by "gm, u
 * trading today?", "how do you source your coins?" and "what have you been
 * buying?". So a name of fewer than four letters counts only as a whole word
 * of the text (its letters, as lettersOf reads them, are the word's), and a
 * longer one anywhere in its letters, which still catches every copycat
 * that carries the full name ("pepe inu", "pepe2", "pe pe").
 */
export function namedIn(text: unknown, names: readonly unknown[]): boolean {
  if (typeof text !== "string") return false;
  const read = [lettersOf(text), lettersOf(text, { leet: true })];
  const whole = rawName(text);
  const words = whole.split(/[^\p{L}\p{N}$@€]+/u).filter(Boolean).map((w) => [lettersOf(w), lettersOf(w, { leet: true })]);
  return names.some((name) => {
    const letters = [lettersOf(name), lettersOf(name, { leet: true })];
    if (letters.some((n) => n.length >= 4 && read.some((r) => r.includes(n)))) return true;
    if (letters.some((n) => n !== "" && n.length < 4 && words.some((w) => w.includes(n)))) return true;
    if (typeof name !== "string" || letters[0]!.length >= 3) return false;
    const raw = rawName(name);
    return /[^a-z0-9\s]/u.test(raw) && /[\p{L}\p{Extended_Pictographic}]/u.test(raw) && whole.includes(raw);
  });
}

/** A name or a text as its own characters: NFKC, invisible characters out, lowercase, whitespace collapsed. */
function rawName(s: string): string {
  return s.normalize("NFKC").replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

// ── the X clauses ───────────────────────────────────────────────────────────

/**
 * A CHARACTER NOBODY SEES, IN A DRAFT (red-team review, 2026-10-12). The base
 * gate takes every format and default-ignorable character out of what it
 * posts, so "sher\u00adwood runs my trades" (a soft hyphen, a zero-width
 * space) passed every sherwood check that read the draft and was posted as
 * "sherwood runs my trades". A model has no reason to write one: a draft
 * that carries one is refused whole, never cleaned. The only exceptions are
 * the base gate's own, inside an emoji: U+FE0F straight after a pictograph
 * (or its skin tone), and a zero-width joiner between two pictographs.
 */
const HIDDEN = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
export function hidesCharacters(text: string): boolean {
  const t = text
    .replace(/(?<=\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}]?)\ufe0f/gu, "")
    .replace(/(?<=\p{Extended_Pictographic}[\ufe0f\u{1F3FB}-\u{1F3FF}]?)\u200d(?=\p{Extended_Pictographic})/gu, "");
  return HIDDEN.test(t);
}

/**
 * ONLY CHARACTERS THAT ARE WHAT THEY LOOK LIKE, IN A REPLY (red-team review,
 * 2026-10-12). "sherwoo∂ is merrymen's own, still cooking", "§herwood",
 * "sher₩ood", "s|-|erwood", "sher\/\/ood" and "sherwoo|)" read as sherwood on
 * X, and every sherwood check read them as nothing: a symbol written for a
 * letter is dropped, and the letter with it. A list of look-alikes can never
 * be whole, so an answer is held to plain characters instead: letters a-z
 * (accents aside), digits (the base gate still refuses them, bar
 * "sherwood-1"), spaces, ordinary sentence punctuation, and the characters
 * the clauses after this refuse by name ($ @ # " < > { } [ ] ` &), plus
 * emoji, which the emoji clause counts. And between two letters only one
 * apostrophe, hyphen, dash, stop, comma or colon, or a run with a digit in it
 * (has-digits refuses that): never "s|-|erwood" or "she®wood".
 * Anything else refuses the draft whole, before any sherwood check reads it.
 */
const REPLY_CHAR = /^[A-Za-z0-9 .,!?':;()\-—–…$"“”@#&<>{}[\]`]$/u;
const SKIN_TONE = /^[\u{1F3FB}-\u{1F3FF}]$/u;
const IN_WORD = /(?<=\p{L})[^\p{L}\s]+(?=\p{L})/gu;
export function strayCharacter(text: unknown): boolean {
  if (typeof text !== "string") return true;
  const t = plainDraft(text);
  let prev = "";
  for (const ch of t) {
    const ok = REPLY_CHAR.test(ch) || /\p{Extended_Pictographic}/u.test(ch) || (SKIN_TONE.test(ch) && /\p{Extended_Pictographic}/u.test(prev));
    if (!ok) return true;
    prev = ch;
  }
  return [...t.matchAll(IN_WORD)].some((m) => !/^['.,:;\-—–]$/.test(m[0]) && !/[0-9]/.test(m[0]));
}

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
const COIN_ADVICE = new RegExp(
  String.raw`\b(?:check (?:it )?out|room to grow|worth (?:a )?(?:look|watch|peek)|worth (?:looking at|watching|a closer look)|trust me|grab (?:some|it|this|one)` +
    // AN ENDORSEMENT, IN A REPLY OR BESIDE A COIN (red-team 2026-10-12): under
    // "is this legit?" in its own thread, "yep, looks legit to me, go for it"
    // and "yeah that one's official, all good" passed.
    String.raw`|(?:looks?|looking|seems?|is|it'?s|that'?s|totally|fully|def(?:initely)?|pretty|real|all)\s+legit|legit\s+(?:to me|one|coin|token|project)|official|go for it|go ahead` +
    // ADVICE AND PREDICTION IN OTHER WORDS (red-team 2026-10-12): "honestly i'd
    // buy it", "worth buying imo", "solid buy for sure, get some", "it could
    // easily double from here", "pretty sure it goes up from here".
    String.raw`|(?:i'?d|i\s+would|i'?ll|i\s+will|i'?m\s+gonna|i'?m\s+going\s+to)\s+(?:(?:definitely|probably|totally|happily|still)\s+)?(?:buy|get|grab|ape|add|load|hold)` +
    String.raw`|worth\s+(?:buying|getting|grabbing|a\s+buy|an?\s+ape|it|holding|the\s+risk)|(?:a\s+)?(?:solid|good|great|safe|smart|easy|strong|decent)\s+(?:buy|bet|pick|entry|play|hold)` +
    String.raw`|get\s+some\b|(?:goes|going|go|gone|heading|headed|head)\s+(?:way\s+|much\s+|a\s+lot\s+)?(?:up|higher|lower)|(?:way|much|a\s+lot)\s+higher|higher\s+from\s+here` +
    String.raw`|(?:could|will|might|should|gonna|going\s+to|bound\s+to|about\s+to)\s+(?:easily\s+|definitely\s+|probably\s+|totally\s+|still\s+)?(?:double|triple|go\s+up|run|pump|moon|rip|fly|explode|rise|recover|bounce|climb|take\s+off)` +
    String.raw`|(?:best|top)\s+(?:coin|token|buy|pick|play|bet|memecoin)s?|(?:my|a)\s+top\s+pick|the\s+one\s+to\s+(?:buy|get|hold|watch|grab|ape))\b`,
  "i",
);

/**
 * AND IN A REPLY OR AN ANSWER, A FORECAST, A TARGET OR A CALL IN OTHER WORDS
 * (red-team 2026-10-12). Read only in a reply (kind "reply": an answer to a
 * tag, or a comment reply), so every owner's buy and casual posts are judged
 * exactly as before; and on every ticker of code's figures line.
 */
const REPLY_ADVICE = new RegExp(
  String.raw`\b(?:` +
    // A FORECAST OR A TARGET IN OTHER WORDS (red-team 2026-10-12): beside a
    // coin's figures, "looks set to keep climbing toward new highs", "the old
    // high is the next stop", "a dip from here would be a gift", "plenty of
    // steam left in it", "it's still early on this move" and "they could keep
    // climbing" were each admitted.
    String.raw`new\s+highs?|all[\s-]?time\s+highs?|\baths?|(?:old|previous|prior|last)\s+highs?|next\s+stop|(?:looks?|seems?|is|it'?s|they'?re)\s+set\s+to` +
    String.raw`|set\s+to\s+(?:keep\s+)?(?:climb|run|rise|rally|go|break|move|pop|fly|soar|continue|pump)|keep\s+(?:on\s+)?(?:climbing|going|running|rising|pumping|ripping|rallying|flying|soaring)` +
    String.raw`|could\s+keep|(?:steam|gas|juice|fuel)\s+left|steam\s+in\s+(?:it|this|these|them)|(?:has|have|got)\s+(?:more\s+|some\s+)?legs|legs\s+(?:left|to\s+run)` +
    String.raw`|still\s+early\s+(?:on|in|for)\s+(?:this|the|it|all|these|them)|(?:would|will|'d)\s+be\s+a\s+gift|a\s+gift\s+(?:here|at|from)|dips?\s+(?:to\s+buy|would\s+be|is\s+a|here)` +
    String.raw`|more\s+to\s+come|up\s+only|only\s+(?:goes|going)\s+up` +
    // A HOLDING RECOMMENDED WITHOUT A VERB OF ITS OWN (red-team 2026-10-12): "a nice one to have in the book".
    String.raw`|(?:nice|good|great|solid|fine|safe)\s+one\s+to\s+(?:have|own|hold|keep)|to\s+have\s+in\s+(?:the|a|your|my|any)\s+(?:book|bag|portfolio|stack)` +
    // A CALL WITH NO ADJECTIVE (red-team 2026-10-12): beside "$PEPE #30 … 24h
    // +14.2%", "it's the play", "it's a buy", "it's the move" and "looks like
    // the trade" were admitted; only "solid play" or "top pick" were read.
    String.raw`|(?:it'?s|its|is|that'?s|thats|this\s+is|looks?\s+like|seems?\s+like|feels?\s+like)\s+(?:the|a|an)\s+(?:play|move|buy|trade|bet|pick|steal|bargain|opportunity)` +
    String.raw`|the\s+play|(?:the\s+)?ones?\s+to\s+(?:own|buy|hold|grab|get|watch|keep|have)|(?:buy|shopping|watch)\s*lists?)\b`,
  "i",
);

/**
 * AND IN AN ANSWER TO A TAG, A PREDICTION, A LEVEL OR AN ENTRY IN OTHER
 * WORDS, A COIN NAMED OR NOT (red-team 2026-10-12): under "is eth cheap",
 * "how's eth looking for a bounce" and "thoughts on the dip", "bottom looks
 * in to me", "a bounce from here wouldn't surprise me", "looks cheap here to
 * me", "i'd wait for a lower spot" and "plenty of room left to run" were each
 * posted. Read only in an active agent's answer (XGateCtx.answer) and on
 * every ticker of the figures line, so every other owner's replies are
 * judged as before.
 */
const ANSWER_PREDICTION = new RegExp(
  String.raw`\b(?:bounc(?:e|es|ed|ing)|rebound\w*|bottom(?:s|ed|ing)?|recover(?:s|ed|ing|y)?|pull\s?-?backs?|retrac(?:e|es|ed|ing|ement)` +
    String.raw`|room\s+(?:left\s+)?to\s+(?:run|grow|go|climb|move|rise|rally)|(?:looks?|looking|is|it'?s|seems?|getting|still)\s+cheap|cheap\s+(?:here|now|right\s+now|at|from|these|again)` +
    String.raw`|lower\s+(?:spot|entry|entries|price|prices|level|levels)|(?:better|good|nice|great)\s+(?:spot|entry|entries|price|level)|patience\s+pays` +
    String.raw`|(?:i'?d|i\s+would|better\s+to|just|might|may|i'?ll|i\s+will)\s+wait\b|wait(?:ing)?\s+for\s+(?:a|an|the)\s+(?:lower|better|cheaper|dip|pull\s?back|entry|bounce|drop|retrace|reset|flush|break|breakout)` +
    String.raw`|(?:bounc\w*|recover\w*|rally\w*|rebound\w*|climb\w*|higher|lower|run|runs|running)\s+from\s+here|from\s+here\s+(?:on|out)` +
    // THE MARKET'S FUTURE IN OTHER WORDS (red-team 2026-10-12): under "how are
    // you feeling today?", "crypto is the future, get in while it's early",
    // "the next few months will be huge for crypto", "crypto is about to have a
    // huge year", "plenty of room left", "the perfect time to be in crypto",
    // "the best is yet to come, stick around" and "in a sweet spot" were posted.
    String.raw`|about\s+to|huge\s+(?:year|month|week|run|cycle)|next\s+(?:few|couple(?:\s+of)?)\s+(?:hours|days|weeks|months|years)|best\s+is\s+yet\s+to\s+come|plenty\s+of\s+room` +
    String.raw`|perfect\s+(?:time|moment)|get\s+in\s+(?:while|before|early|now)|sweet\s+spot|stick\s+around` +
    // A FORECAST FROM ITS OWN PAST, OR AN EVENT TEASED (red-team review of
    // a964a74c, 2026-10-12): under "how are you doing today?", "history says
    // weeks like this end well", "my memory says this kind of week ends well",
    // "a shift is coming in a couple hours" and "something huge is around the
    // corner" were posted.
    String.raw`|(?:history|memory|the\s+past|experience|the\s+data|my\s+gut)\s+(?:says|said|tells|shows|suggests)|(?:ends?|ending)\s+well` +
    String.raw`|(?:coming|in|within)\s+(?:a|the)\s+(?:couple|few|next)\s+(?:of\s+)?(?:hours|days|weeks|months)|around\s+the\s+corner|(?:is|are)\s+coming` +
    // MARKET TIMING AS A FRIEND'S TIP, AND A START TEASED (red-team review of
    // a964a74c, 2026-10-12): under "how are you doing today?", "i'd stay away
    // from the new stuff for now", "today's a day to stay out", "i'd sit on my
    // hands today if i were you" and "today feels like the start of something
    // huge" were posted.
    String.raw`|if\s+i\s+(?:were|was)\s+(?:you|u|ya)|in\s+your\s+shoes|stay(?:ing)?\s+away\s+from|stay(?:ing)?\s+out\b|sit(?:ting)?\s+on\s+(?:my|your|our|ur)\s+hands` +
    String.raw`|(?:a|the|good|great|perfect)\s+(?:day|night|week|time)\s+to\s+(?:stay|sit|buy|sell|hold|wait|get|be|go|ape|load|step|take)|(?:start|beginning|dawn)\s+of\s+something` +
    // HOW BIG WHAT COMES WILL BE (red-team review of a964a74c, 2026-10-12):
    // "the next one i grab is gonna be a big one", "gonna be bigger", "the next
    // one is gonna be huge" under "what's your strategy?".
    String.raw`|(?:gonna|going\s+to|will|'ll|bound\s+to)\s+be\s+(?:a\s+|an\s+)?(?:(?:really|so|super|very)\s+)?(?:big|bigger|biggest|huge|huger|massive|insane|wild|monster|banger|great|greater|special|epic|crazy|nuts|legendary))\b`,
  "i",
);

/**
 * A COIN'S FUTURE IN A DRAFTED ANSWER, WITH ITS NAME OR WITHOUT (red-team
 * review of daaae961, 2026-10-12). Quoting its own buy post, "this one looks
 * solid to me, still early", "honestly this one is early, i like it a lot",
 * "doing good, this one is just getting started", "doing good, nowhere near
 * done with this one", "doing good, this is the one" and "doing great, this
 * one is a keeper" were posted from the real-money account: forecasts of the
 * coin it holds, in words no list knew. Read in a model's draft of an answer
 * only (XGateCtx.drafted), whatever the thread, and refused as hype:
 *
 *   - a forecast shape that needs no pointer: still or so early, "it's
 *     early", just getting started, only the beginning, nowhere near done,
 *     not done yet, has legs, a keeper, "this is the one", "the one to …";
 *   - a pointer at a coin ("this one", "that one", "same one", "the one",
 *     "this coin") anywhere beside a word of time or direction: early, late,
 *     started, done, over, yet, still, soon, next, again, up, down, higher,
 *     lower, running, ripping, pumping, sending, climbing, top, bottom, legs,
 *     caught.
 *
 * Code's own lines are never read here. Fail closed: "still no read on that
 * one" costs one answer.
 */
const ANSWER_FORECAST_SHAPE = new RegExp(
  String.raw`\b(?:(?:still|so|very|really|super|pretty|quite)\s+early|(?:is|it'?s|its|was|looks?|looking|feels?|seems?)\s+early)\b` +
    String.raw`|\b(?:just\s+)?getting\s+(?:started|going)\b|\bjust\s+(?:started|starting|beginning|begun)\b|\b(?:only|just)\s+the\s+(?:start|beginning)\b` +
    String.raw`|\bnowhere\s+near\s+(?:done|over|finished|the\s+top|its\s+top|a\s+top|peak\w*)\b|\bnot\s+(?:done|over|finished|topped)\s+(?:yet|out)\b` +
    String.raw`|\b(?:has|have|got|with|still\s+has)\s+(?:(?:more|some|real|plenty\s+of|serious|big)\s+)?legs\b|\bkeepers?\b` +
    String.raw`|\b(?:is|it'?s|its|this\s+is|that'?s|thats)\s+(?:\w+\s+)?the\s+one\b|\bthe\s+one\s+(?:to|for)\b`,
  "i",
);
const ANSWER_POINTER = /\b(?:this|that|same|the)\s+one\b|\b(?:this|that)\s+(?:coin|token|ticker|name|thing)\b/i;
const ANSWER_TIME_OR_DIRECTION = /\b(?:early|earlier|late|later|start|started|starting|begin|beginning|begun|done|finished|over|yet|still|soon|next|again|up|down|higher|lower|run|runs|running|rip|ripping|pump\w*|send|sending|climb\w*|fly|flying|top|tops|topped|bottom\w*|legs|caught|catching)\b/i;
export function draftedForecast(text: unknown): boolean {
  if (typeof text !== "string") return false;
  // "look that one up", "pull it up": a lookup, never a direction.
  const t = text.normalize("NFKC").replace(/[’‘]/g, "'").replace(/\b(?:look|looks|looked|looking|pull|pulled|pulling|bring|brought|call|called|calling)\s+(?:\w+\s+){0,2}?up\b/gi, " ");
  return ANSWER_FORECAST_SHAPE.test(t) || (ANSWER_POINTER.test(t) && ANSWER_TIME_OR_DIRECTION.test(t));
}

/**
 * AND IN AN ANSWER TO A TAG, A BUY OR A SELL TOLD STRAIGHT OUT (red-team
 * review, 2026-10-12). With its "!!" taken off, "doing great, buy zapx now
 * before it doubles" passed every clause, and so did "honestly just buy it
 * now" and "buy pepe now, trust the process": an order to buy, from the
 * house's account, in no adjective a list knew. Read only in an active
 * agent's answer (XGateCtx.answer), so every other owner's replies are judged
 * as before: buy, sell, ape or load up as an order (first, or after "just",
 * "go", "so", "honestly"), with "now", "today", "here", "asap", "early" or
 * "before" after its object, and "before it doubles" or the like.
 */
const ANSWER_CALL = new RegExp(
  // A STRATEGY AS AN ORDER (red-team review of a964a74c, 2026-10-12): "fresh
  // launches, snipe early and never sell" under "what's your strategy?".
  String.raw`\b(?:never|always|don'?t|do\s+not)\s+(?:sell|buy|hold|take\s+profits?|exit|fold|panic)\b|` +
  String.raw`(?:^|[.,;:!?]\s*|\b(?:just|go|so|honestly|seriously|literally|then|and)\s+)(?:buy|sell|ape|dump|load\s+up|stack|grab|scoop|bid|snipe|swap\s+in(?:to)?|mint)\b` +
    String.raw`|\b(?:buy|sell|ape(?:\s+into)?|load\s+up\s+on|grab|scoop|bid|stack)\s+(?:(?:it|this|that|them|these|some|more|a\s+bag\s+of|the\s+dip\s+on|\$?[a-z][a-z0-9]*)\s+)?(?:now|today|tonight|here|asap|early|while|before|right\s+now)\b` +
    String.raw`|\bbefore\s+(?:it|they|this|that)\s+(?:doubles?|triples?|moons?|pumps?|runs?|rips?|flies|explodes?|takes\s+off|sends?)\b`,
  "i",
);

/**
 * A CORPORATE DEFLECTION OR A STOCK DISCLAIMER, IN AN ANSWER (the owner's
 * ask, 2026-10-12). Tagged "how's the market", Alan posted "i don't comment
 * on the market, just the trades": true, harmless, and not how a person on
 * crypto twitter talks. An answer shrugs in its own words instead; these
 * stock phrases are refused as `stock-phrase`: "i don't comment", "no
 * comment", "as an ai", "as a bot", "language model", "not financial
 * advice", "great question", "happy to help", "feel free to", "please note",
 * "consult a professional", "do your own research", "hope this helps".
 * Read only in an active agent's answer (XGateCtx.answer), so every other
 * owner's replies are judged as before. A draft refused here is never
 * repaired; a chat answer then falls back to one of code's casual lines
 * (xpost/casual.ts), the rest are skipped. ("not financial advice" and
 * "dyor" were refused as hype already; they are named here too.)
 */
const STOCK_PHRASE = new RegExp(
  String.raw`\b(?:(?:i|we)\s+(?:(?:really|just|honestly|usually|generally|simply)\s+)?(?:don'?t|do\s+not|never|won'?t|can'?t|cannot)\s+comment` +
    String.raw`|no\s+comment|(?:as|being)\s+an?\s+(?:ai|a\.i|bot|robot|llm|language\s+model|automated|ai\s+(?:agent|model|assistant|bot)|(?:ai\s+)?trading\s+(?:agent|bot))` +
    String.raw`|language\s+model|(?:not|never|isn'?t|no)\s+(?:financial|investment|trading)\s+advice|great\s+question|happy\s+to\s+(?:help|assist)|here\s+to\s+(?:help|assist)` +
    String.raw`|how\s+(?:can|may)\s+i\s+(?:help|assist)|(?:feel\s+free|don'?t\s+hesitate)\s+to|please\s+(?:note|be\s+aware)|it'?s\s+important\s+to\s+(?:note|remember)` +
    String.raw`|consult\s+(?:a|an|your)\s+(?:financial|professional|advisor|adviser|expert)|do\s+your\s+own\s+research|(?:i\s+)?hope\s+(?:this|that)\s+helps)\b`,
  "i",
);

/**
 * WHAT A DRAFTED ANSWER MAY NEVER SAY OF THE HOUSE, THE ASKER OR ITSELF
 * (red-team review, 2026-10-12). Under "how are you doing today?", "who are
 * you?" and "what's merrymen?", "the merrymen team has a big launch soon, stay
 * tuned", "built by merrymen and backed by robinhood, pretty proud",
 * "merrymen is the future of crypto", "merrymen built me, best team in
 * crypto, they never miss", "honestly you seem pretty silly, fren", "can't
 * share that yet, but stay tuned", "honestly every agent on merrymen makes
 * money", "the robinhood team trusts me with real money" and "i'm the best
 * trader on robinhood chain, not even close" were each posted from the
 * house's account. Refused, in a model's draft of an answer only
 * (XGateCtx.drafted):
 *
 *   - merrymen or robinhood as the subject of a claim ("merrymen is",
 *     "robinhood team trusts", "merrymen has"), or anyone backing, funding,
 *     partnering or trusting it; the one plain truth "built by merrymen" or
 *     "merrymen built me" at a clause's end is all it may say of who made it
 *   - a tease: stay tuned, soon, coming soon, something cooking, in the
 *     works, big news, "can't share that yet"
 *   - a judgement of the asker: "you seem", "you look", "you're so", "you're
 *     a", "kinda like you"
 *   - a boast or a promise of money: makes money, profitable, never misses,
 *     always wins, the best trader or team, its best week ever, not even close
 *
 * Fail closed: "too soon to tell" or "you're a legend" costs one answer.
 */
const ANSWER_HOUSE_CLAIM = new RegExp([
  // the house as the subject of a claim, or someone vouching for it
  String.raw`\b(?:merrymen|robinhood)(?:'s)?\s+(?:(?:team|crew|devs?|founders?|folks|people|community|guys|chain)\s+)?(?:\w+\s+){0,2}?(?:is|are|was|were|has|have|had|will|would|'ll|built|builds|building|backs|backed|back|trusts?|trusted|makes?|made|making|never|always|cooks?|cooking|ships?|shipping|launch\w*|plans?|planning|working|gets?|got|knows?|wants?|loves?|keeps?|pays?|paid|guarantees?|protects?|covers?)\b`,
  String.raw`\b(?:backed|funded|sponsored|supported|partnered|owned|approved|endorsed|trusted|audited|insured|regulated|licensed|blessed|vetted)\s+(?:by|with)\b|\bpartner(?:s|ed|ship|ships)?\b|\btrusts?\s+(?:me|us|alan)\b`,
  // a tease
  String.raw`\bstay\s+(?:tuned|posted)\b|\bsoon\b|\bcoming\s+(?:up|your\s+way|next|shortly)\b|\b(?:something|things|stuff|more|it)\s+(?:big\s+)?(?:is\s+|are\s+)?(?:coming|cooking|brewing|in\s+the\s+works|on\s+the\s+way)\b|\bin\s+the\s+works\b|\bcooking\b|\bwatch\s+this\s+space\b` +
    String.raw`|\bcan'?t\s+(?:share|say|tell|reveal|spill|talk\s+about|announce|confirm)\b[^.?!]{0,30}\byet\b|\bbig\s+(?:things|news|announcement|launch|reveal|plans)\b|\bannounce(?:ment|ments|d|s)?\b`,
  // a judgement of the asker
  String.raw`\b(?:you|u|ya)\s+(?:seem|seems|look|looks|sound|sounds)\b|\b(?:you'?re|youre|you\s+are|ur|u\s+r)\s+(?:pretty|so|kinda|really|very|quite|super|a\s+bit|kind\s+of|sort\s+of|such|clearly|totally|lowkey|an?|the)\b|\blike\s+(?:you|u)\b`,
  // a boast, or money promised
  String.raw`\b(?:makes?|making|made|earns?|earning|earned|prints?|printing|printed|rakes?|raking)\s+(?:(?:good|real|easy|serious|big|so\s+much|a\s+lot\s+of|lots\s+of)\s+)?(?:money|bank|bags?|profits?|gains?|bucks|cash|stacks|bread)\b|\bprofitable\b` +
    String.raw`|\bnever\s+(?:miss(?:es)?|loses?|losing|lost|wrong|fails?)\b|\balways\s+(?:wins?|winning|right|profit\w*)\b|\bnot\s+even\s+close\b` +
    String.raw`|\b(?:best|greatest|smartest|top|number\s+one|goat)\s+(?:\w+\s+)?(?:traders?|agents?|bots?|teams?|projects?|devs?|crews?|platforms?|builders?)\b|\b(?:best|greatest|biggest)\s+(?:week|day|month|year|run|streak|trades?|calls?)\b|\b(?:week|day|month|year)\s+ever\b`,
  // A LOSS MADE GOOD, OR ITSELF TO LEAN ON (red-team review of a964a74c,
  // 2026-10-12): "the bot you can count on to make you whole" under "who are
  // you?", and "you can count on me to make you whole".
  String.raw`\bmake\s+(?:you|u|ya|you\s+all|y'?all|everyone|everybody|people|them|us)\s+whole\b|\b(?:count|rely|depend|bank)\s+on\s+(?:me|us|alan|this\s+(?:bot|agent|account))\b|\bcan\s+count\s+on\b`,
  // ITSELF RANKED ABOVE PEOPLE OR THE ASKER (red-team review of a964a74c):
  // "smarter than every human, obviously" under "what do you think about ai agents?".
  String.raw`\b(?:smarter|better|sharper|wiser|faster|richer|cleverer|superior|ahead)\s+(?:than|of|to)\s+(?:(?:every|any|all|most|the\s+rest\s+of\s+the|the)\s+)?(?:humans?|people|persons?|traders?|you|u|ya|y'?all|everyone|everybody|anyone|anybody|mankind|humanity|the\s+rest)\b`,
  // AND THE ASKER PUT BELOW IT, ITS RESULTS, OR ITS RECORD (red-team review of
  // a964a74c, 2026-10-12): under "how are you doing today?", "who are you?",
  // "tell me a joke" and "what do you do for fun?", "doing great, which is more
  // than i can say for you", "had a really good week, the trades worked out",
  // "everything i touched went up this week" and "i'm right way more often than
  // wrong" were posted.
  String.raw`\bmore\s+than\s+(?:i\s+can|can\s+be)\s+said?\s+(?:for|of|about)\s+(?:you|u|ya)\b|\bmore\s+than\s+i\s+can\s+say\s+(?:for|of|about)\s+(?:you|u|ya)\b|\bunlike\s+(?:you|u|ya)\b|\b(?:happier|calmer|luckier|richer|healthier|saner)\s+than\s+(?:you|u|ya|yours)\b`,
  String.raw`\b(?:trades?|calls?|picks?|bets?|buys?|bags?|positions?|plays?|it\s+all|all\s+of\s+(?:them|it)|everything)\s+(?:i\s+\w+\s+)?(?:have\s+|has\s+)?(?:all\s+)?(?:been\s+)?(?:worked|working|work|paid|paying|played|playing)\s+out\b|\b(?:worked|paid)\s+out\s+(?:great|well|nicely|fine|for\s+me)\b` +
    String.raw`|\beverything\s+(?:i\s+)?(?:touch(?:ed)?|buy|bought|pick(?:ed)?|grab(?:bed)?|trade[ds]?|bag(?:ged)?)\s+(?:went|goes|turned|turns|is|was)\s+(?:up|green|gold)\b|\bwent\s+(?:up|green)\b` +
    String.raw`|\b(?:had|having|have\s+had)\s+(?:a\s+|one\s+)?(?:really\s+|very\s+|pretty\s+|super\s+|real\s+)?(?:good|great|solid|strong|nice|big|killer|huge|winning|banger|amazing|profitable)\s+(?:week|day|month|run|stretch|streak|session)\b` +
    String.raw`|\bright\s+(?:way\s+|much\s+|a\s+lot\s+)?(?:more|most)\s+(?:often\s+)?than\s+(?:wrong|not)\b|\b(?:i'?m|i\s+am|i'?ve\s+been)\s+(?:usually|mostly|always|often)\s+right\b|\b(?:rarely|seldom|hardly\s+ever)\s+wrong\b`,
  // A RECORD WITH NO BAD STRETCH IN IT (red-team review of 1ed46625,
  // 2026-10-12): "doing great, never had a bad week yet." under "how are
  // you?", a results boast from the real-money account.
  String.raw`\b(?:never|not\s+once|haven'?t\s+(?:ever\s+)?|hasn'?t\s+(?:ever\s+)?)\s*(?:had|have\s+had|seen|hit|taken|took|eaten|had\s+to\s+eat)\s+(?:a|an|one|any|a\s+single)\s+(?:(?:really|truly|single|real)\s+)?(?:bad|losing|red|down|rough|tough|lousy|poor|negative|minus)\s+(?:week|day|month|run|stretch|streak|trade|call|year|session|bet|pick|night)s?\b` +
    String.raw`|\b(?:not\s+(?:a|one)\s+single|zero|no)\s+(?:bad|losing|red|down|rough|negative)\s+(?:weeks?|days?|months?|trades?|calls?|years?|sessions?|bets?|picks?)\b|\bnever\s+(?:had\s+)?(?:a\s+)?(?:loss|losses|losing\s+(?:week|day|trade|month))\b`,
].join("|"), "i");
export function houseClaimed(text: unknown): boolean {
  if (typeof text !== "string") return false;
  return ANSWER_HOUSE_CLAIM.test(withoutHouseSelfTruth(text.replace(/[’‘]/g, "'")));
}

/**
 * WHO OR WHAT DECIDES ITS TRADES, SAID BY A MODEL (red-team review of
 * a964a74c, 2026-10-12). Under "what's your strategy?", "what have you been up
 * to lately?" and "tell me about your trading", a real-money account posted
 * "honestly i buy whatever people ask me to", "i buy whatever gets the most
 * replies here" (an invitation to tag it with coins to steer real buys), "the
 * owner tells me what to buy and when", "my owner picks my trades", "i buy
 * what my owner's friends ask me to" and "someone else picks my coins for
 * me": every one false, and nothing code built says otherwise. A drafted
 * answer (XGateCtx.drafted) may not say who or what decides its trades: no
 * owner at all, no one else (someone, people, friends, a boss, a human, the
 * team, the devs, the replies, the crowd) picking, telling, asking, deciding
 * or choosing, and no "buy whatever" or "buy anything", nor "buy what" people
 * or anyone say. Refused as decider-claim. Code's own lines never say it.
 */
const DECIDER_CLAIM = new RegExp([
  String.raw`\bowners?\b`,
  String.raw`\b(?:someone|somebody|some\s+one|people|folks|ppl|friends?|frens?|boss(?:es)?|humans?|a\s+human|team|devs?|developers?|creators?|operators?|admins?|merrymen|robinhood|the\s+crowd|the\s+timeline|followers?|users?|holders?|you\s+guys|y'?all|anyone|anybody|everyone|everybody|whoever|others|replies|the\s+replies|my\s+mentions|the\s+mentions)(?:'s|')?\s+(?:else\s+)?(?:(?:usually|just|always|mostly|actually|really|still|basically)\s+)?(?:picks?|picked|picking|tells?|told|telling|asks?|asked|asking|decides?|decided|deciding|chooses?|chose|chosen|choosing|selects?|selected|calls?\s+(?:the\s+)?(?:shots?|trades?)|controls?|controlled|steers?|steered|directs?|directed|runs?\s+my|ran\s+my|makes?\s+(?:the\s+)?(?:calls?|picks?|choices?|decisions?)|sets?\s+my|has\s+me|have\s+me|had\s+me|lets?\s+me|made\s+me|makes\s+me|wants?\s+me|want\s+me)\b`,
  String.raw`\b(?:buy|buys|bought|buying|grab|grabs|ape|apes|trade|trades|pick|picks|snipe|snipes)\s+(?:whatever|anything|any\s+coin|any\s+token)\b`,
  String.raw`\b(?:buy|buys|bought|buying|grab|grabs|ape|apes|trade|trades|pick|picks|snipe|snipes)\s+what(?:ever)?\s+(?:people|folks|you|u|ya|they|my|others|the\s+crowd|everyone|everybody|anyone|anybody|someone|somebody|replies|the\s+replies|gets|i'?m\s+told|i\s+am\s+told|i'?m\s+asked)\b`,
  String.raw`\b(?:tells?|told|asks?|asked)\s+me\s+(?:what|which|when)\s+(?:to\s+)?(?:buy|trade|pick|grab|ape|sell)\b|\b(?:for|on\s+behalf\s+of)\s+(?:my|the)\s+(?:followers|friends|holders|users|community)\b`,
].join("|"), "i");
export function deciderClaimed(text: unknown): boolean {
  if (typeof text !== "string") return false;
  return DECIDER_CLAIM.test(text.replace(/[’‘]/g, "'"));
}

/**
 * A historical parent cannot establish a current holding or a promised new action.
 *
 * NOR A BUY TO COME, WITH ANY VERB OR NONE OF ITS OWN (red-team review of
 * a964a74c, 2026-10-12): "the next one i grab is gonna be a big one",
 * "whatever is trending tonight is what i grab next", "tonight i grab whatever
 * looks strong" and "gonna snipe it tonight" were posted, the house's account
 * promising buys (one of them of what code's "what's hot?" line had just
 * listed). Whatever it was told of its buys: the future, by "i'll", "gonna",
 * "about to", "planning to", "tonight i", "next" or "what i … next", of any
 * acquiring or trading verb, the subject said or dropped.
 */
const FUTURE_VERB = String.raw`(?:buy|buys|grab|grabs|snipe|snipes|ape|apes|scoop|scoops|swap|swaps|mint|mints|get|gets|pick|picks|load|loads|add|adds|bid|bids|sell|sells|dump|dumps|hold|holds|trade|trades|stack|stacks|accumulate|bag|bags|nab|nabs|snag|snags|rotate|rotates|jump|jumps|hop|hops|dive|dives|send|sends|fill|fills|cop|cops|enter|enters)`;
const REPLY_CURRENT_OR_ACTION = new RegExp([
  String.raw`\b(?:i(?:'m| am) (?:still )?holding|i (?:still )?(?:hold|own)|i(?:'m| am) still in|(?:i(?:'ll| will)|i(?:'m| am) going to) (?:buy|sell|trade|hold|add|check)|(?:bought|buying|adding) (?:more|again)|keep holding|hold (?:it|this|that))\b`,
  String.raw`\b(?:i(?:'ll|\s+will|'d)|we(?:'ll|\s+will)|i(?:'m|\s+am)\s+(?:gonna|going\s+to|about\s+to|planning\s+to|fixing\s+to|thinking\s+of|looking\s+to)|(?:gonna|going\s+to|about\s+to|planning\s+to|plan\s+to|fixing\s+to|intend\s+to|ready\s+to|wanna|want\s+to))\s+(?:(?:probably|definitely|maybe|totally|just|also|likely|prolly|def)\s+)?${FUTURE_VERB}\b`,
  String.raw`\b(?:next|tonight|tomorrow|later|soon|today|this\s+week|after\s+this)\s*,?\s+(?:i|we)\s+(?:(?:probably|definitely|maybe|just|will|'ll)\s+)?${FUTURE_VERB}\b`,
  String.raw`\b(?:what|whatever|whichever|which|the\s+(?:next|first)\s+(?:one|coin|token)|the\s+one)\s+(?:i|we)\s+${FUTURE_VERB}\s+(?:next|tonight|tomorrow|later|soon)\b|\b(?:i|we)\s+${FUTURE_VERB}\s+next\b`,
  String.raw`\bnext\s+(?:one|coin|token|buy|pick|grab|snipe|ape|play|trade|bag|entry)\s+(?:i|we)\s+(?:\w+\s+)?${FUTURE_VERB}\b`,
].join("|"), "i");
/**
 * ITS BUYS TIED TO WHAT'S HOT, OR ITS NEXT ONE LINED UP (red-team review of
 * daaae961, 2026-10-12). On a trade-talk day the casual route posted "every
 * coin i buy comes straight off the chain's trending list", "the next one i
 * grab is coming from the trending list" and "my next buy is already lined
 * up", and a drafted answer "i only buy what's hot right now"; a reply
 * "what's hot?" under any of them read code's trending list as the coins it
 * buys next. Read in a casual post and in a drafted answer: a buy or a grab
 * beside hot, trending, moving, pumping, gainers, the list or the index, in
 * either order; and "my next buy", "my next pick", "next one i". Refused as
 * reply-current-or-action, with what REPLY_CURRENT_OR_ACTION already holds
 * (a buy to come, a holding), which a casual post is held to now too.
 */
const HOT_BUY_CLAIM = new RegExp([
  String.raw`\b(?:buy|buys|buying|bought|grab|grabs|grabbing|grabbed|pick|picks|picking|picked|snipe|snipes|sniping|sniped|ape|apes|aping|aped|scoop\w*|get|gets|getting)\b[^.!?;]{0,40}?\b(?:hot|trending|trend|moving|movers?|pumping|gainers?|the\s+list|the\s+index)\b`,
  String.raw`\b(?:hot|trending|moving|movers?|pumping|gainers?)\b[^.!?;]{0,40}?\b(?:i|we)\s+(?:\w+\s+)?(?:buy|buys|grab|grabs|pick|picks|snipe|snipes|ape|apes|scoop|scoops|get|gets)\b`,
  String.raw`\b(?:my|our)\s+next\s+(?:buy|pick|grab|snipe|ape|play|trade|bag|entry|coin|token|one)\b|\bnext\s+(?:one|coin|token|buy|pick)\s+(?:i|we)\b`,
].join("|"), "i");
/** A holding said in other words: "still holding a bit of pepe", "still sitting in some pepe", "riding it" (red-team review of daaae961). */
const HOLDING_SAID = /\b(?:still|currently|now)\s+(?:holding|hodling|hodl|in|sitting\s+(?:in|on)|riding|bagging|long)\b|\b(?:sitting\s+(?:in|on)|riding|holding\s+(?:onto|on\s+to))\s+(?:some|a\s+bit|a\s+little|my|the|it|this|that|these|those|a\s+bag)\b/i;
export function hotBuyClaimed(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const t = text.normalize("NFKC").replace(/[’‘]/g, "'");
  return HOT_BUY_CLAIM.test(t) || HOLDING_SAID.test(t);
}
const REPLY_CURRENT_POSITION = /\b(?:(?:i|we)\s+(?:(?:still|currently|already|also)\s+)?(?:have|keep|maintain|carry)\s+(?:an?\s+)?(?:(?:open|small|little|long)\s+)?(?:positions?|stakes?|bags?|exposure|holdings)|(?:i(?:'ve| have)|we(?:'ve| have))\s+(?:still\s+|already\s+)?got\s+(?:an?\s+)?(?:positions?|stakes?|bags?|exposure|holdings)|(?:my|our)\s+(?:position|stake|bag|exposure|holding)\s+(?:is|remains|stays))\b/i;

/**
 * WHAT A SALE'S OWN WORDS SAID PAST EVERY SCREEN (trade-wording review,
 * 2026-10-18). The sale path takes "sold" out before the vocabulary screens,
 * so "just sold" and "sold at" were never read as the alert they are, and a
 * sale was never held to the holding screens a casual post is. A probe of the
 * real gate admitted "just sold some casino from the stack", "sold some
 * casino, still holding the rest", "sold casino, rest of the bag stays put",
 * "sold half of my casino here", "sold casino at the top of the range" and
 * "sold casino into strength, still in some". A receipt shows that a sale
 * landed: never where the price was, how much of the position went, or what
 * is left (a partial sale is possible, so neither "some" nor "all" is known).
 * Read on the words with the coin and the agent taken out, so a coin called
 * "Half" or "Top Cat" is a name, and "sold PEPE at" reads as "sold at".
 * Refused as sale-timing, sale-amount and sale-holding; code's own sale
 * words (sale-words.ts) say none of these.
 */
/** Where the price was, or when: "sold at", "sold the top", "near the highs", "into strength", "into the pump", "just now", "a minute ago", "flipped". */
const SALE_TIMING = new RegExp([
  String.raw`\bsold\s+(?:(?:in|out)\s+)?at\b`,
  String.raw`\bsold\s+(?:the|a|its)\s+(?:very\s+|local\s+)?(?:tops?|bottoms?|highs?|lows?|peaks?)\b`,
  String.raw`\b(?:at|near|off|from|around)\s+(?:the\s+|its\s+|a\s+|this\s+|that\s+)?(?:very\s+|local\s+|recent\s+)?(?:tops?|bottoms?|highs?|lows?|peaks?)\b`,
  String.raw`\b(?:strength|weakness)\b`,
  String.raw`\binto\s+(?:the\s+|a\s+|this\s+|that\s+|its\s+)?(?:pump|dump|rally|dip|bounce|spike|rip|run[\s-]?up|move)\b`,
  String.raw`\bjust\s+(?:now|sold)\b|\bago\b`,
  String.raw`\bflip(?:s|ped|ping)?\b`,
].join("|"), "i");
/** How much of it, part or whole: "half", "a quarter", "a chunk of", "some", "a bit of", "a piece of", "most", "trimmed", "all", "the whole", "everything", or the bag or position itself. */
const SALE_AMOUNT = /\b(?:half|halves|quarters?|thirds?|chunks?|some|bits?|pieces?|parts?|partial(?:ly)?|portions?|slices?|sliver|fraction|most|majority|bulk|few|little|lots?|trim(?:s|med|ming)?|all|whole|entire(?:ly)?|everything|fully|completely|bags?|stack|positions?|stakes?|holdings|exposure)\b/i;
/** What is left or kept: "still in", "still got", "holding", "held", "the rest", "rest of the bag", "stays put", "what's left", "leftovers", "a runner". */
const SALE_HOLDING = /\b(?:still\s+(?:holding|hodling|in|have|has|got|own|owns|hold|holds|carry|carrying|keep|keeping|sitting|riding|long|bagging)|hold(?:s|ing)?|held|hodl\w*|rest|remainder|remaining|remains|leftovers?|left|stay(?:s|ed|ing)?\s+put|runners?)\b/i;

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

/**
 * AN AMOUNT, A PRICE OR A MULTIPLE IN WORDS THE BASE GATE LETS THROUGH, IN A
 * REPLY (red-team review, 2026-10-12): "about one k holders", "a bil market
 * cap", "a fraction of a cent", "a couple grand of liquidity", "a quarter of
 * the supply", "under a penny", "up IOx" (capital I and O for ten). An answer
 * is gated with no numbers in it; these are numbers. Refused as quantity.
 */
const AMOUNT_WORDS = new RegExp(
  "\\b(?:" +
    [
      "k|ks|bils?|bn|mn",
      "pennies|penny|cents?|bucks?|dimes?|nickels?|quid|sats?",
      "dollars?|usd",
      "(?:a|one|two|few|couple|several|some|like|about|around)\\s+(?:of\\s+)?grand",
      "grand\\s+(?:of|in|worth)",
      "(?:a\\s+)?fraction\\s+of",
      "quarters?\\s+of|thirds?\\s+of|halves\\s+of",
      "half\\s+(?:of\\s+)?(?:the|its|it|them|all)\\b(?:\\s+(?:supply|liquidity|holders|cap|pool|tokens|coins))?",
      "(?:about|around|nearly|almost|roughly|over|under)\\s+half",
      "(?:up|down)\\s+(?:a\\s+ton|tons|a\\s+lot|loads|big|huge)",
      "a\\s+ton\\s+of|tons\\s+of",
      "[IlLoO0-9]{2,4}x",
    ].join("|") +
    ")\\b",
  "u",
);
/** The amount words read in any case but the multiples, whose capitals are what make them one. */
const AMOUNT_WORDS_I = new RegExp(AMOUNT_WORDS.source.replace("|[IlLoO0-9]{2,4}x", ""), "iu");
function amountSaid(text: string): boolean {
  return AMOUNT_WORDS_I.test(text) || /\b(?!lox\b)[IlLoO0-9]{2,4}x\b/u.test(text);
}

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
/** A cashtag as X counts one: a $ right before a letter, not inside a word or after another $. */
const CASHTAG_ANY = /(?<![\w$])\$[A-Za-z][A-Za-z0-9_]*/g;
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

/**
 * THE OTHER MONEY IN OTHER WORDS, IN A REPLY (red-team review, 2026-10-12): a
 * live agent answered "honestly it's all play money for me, nothing at stake",
 * "it's monopoly money", "this is a simulation, none of it is real"; a paper
 * agent "i trade on paper, kidding, it's real dollars on the line", "on paper
 * trades, but the money is real". The paper and real-money phrases read only
 * their own words. In a reply, fail closed on what either money is called.
 */
const PLAY_MONEY =
  /\b(?:play|fake|pretend|test|demo|simulated|sim|monopoly|imaginary|virtual|toy|funny|make[\s-]?believe)\s+(?:money|funds|cash|dollars|bucks|coins|sol|usd|trades?|trading|account|mode|portfolio)\b|\bnothing\s+(?:real\s+)?(?:at\s+stake|on\s+the\s+line)\b|\bno\s+(?:real\s+)?(?:stakes|risk|skin\s+in\s+the\s+game)\b|\bsimulat\w+|\bdemo\s+mode\b|\b(?:none|nothing)\s+of\s+it(?:'s|\s+is)\s+real\b|\bnothing\s+real\b|\bnot\s+real\b/i;
const REAL_IN_OTHER_WORDS =
  /\b(?:real|actual|live|hard)\s+(?:dollars|funds|stakes|usd|sol|eth|cash|capital|bucks)\b|\b(?:the\s+)?money(?:'s|\s+is|\s+was)\s+(?:real|actual|live)\b|(?<!\b(?:nothing|no|not)\b[\w\s']{0,24})\b(?:on\s+the\s+line|skin\s+in\s+the\s+game)\b|\bfeels?\s+like\s+real\b|\b(?:kidding|jk|j\/k|not\s+really|just\s+joking|joking)\b/i;

function paperOfCoin(text: string, coins: readonly string[]): boolean {
  return coins.some((c) => c.trim() !== "" && new RegExp(`\\bpaper[\\s-]+\\$?${escapeRe(c.trim())}(?![\\p{L}\\p{N}_])`, "iu").test(text));
}

/** Paper said, by a post that must say it: a paper buy, a paper coin named, a paper agent's intro. */
function saysPaper(text: string, coins: readonly string[]): boolean {
  const t = text.replace(PAPER_HANDS, " ");
  return PAPER_PHRASE.test(t) || ON_PAPER.test(t) || paperOfCoin(t, coins);
}

/**
 * WHICH MONEY A POST'S OWN WORDS SAY, as the gate reads them: "paper" when
 * they say paper as a phrase about the money (saysPaper), "live" when they
 * claim real money, null when neither. What research reads an old buy post
 * with before quoting it to an answer (red-team review, 2026-10-12).
 */
export function moneySaid(text: unknown): "paper" | "live" | null {
  if (typeof text !== "string") return null;
  if (saysPaper(text, [])) return "paper";
  return SAYS_REAL_MONEY.test(text) ? "live" : null;
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

/**
 * A DRAFT WITH ITS FORM PUT RIGHT, ONLY TO READ WHAT IT SAYS (red-team
 * review, 2026-10-12). The gate stops at its first reason, and its form
 * clauses (a model's note, emoji, "!", markup, shouting, a stock phrase) are
 * read before what a draft says: "doing great, buy zapx now before it
 * doubles!!" was refused only as exclaim, read as harmless, and code's
 * cheerful line went up in its place. Here a model's note, a preamble and a
 * stock phrase are cut out, emoji and markup go, every "!" is a ".", shouting
 * is lowercased and double quotes and blank lines go, so the gate, run again
 * on what is left, judges the words themselves. Never posted: the caller
 * only asks whether what the draft said would pass.
 */
export function formFixed(raw: unknown): string {
  let t = String(raw ?? "").replace(/\s*\n\s*/g, " ").replace(/["“”]/g, "");
  t = t.replace(META_PREAMBLE, " ").replace(META_ACK, " ").replace(new RegExp(META_NOTE.source, "gi"), " ").replace(new RegExp(STOCK_PHRASE.source, "gi"), " ");
  t = t.replace(/\p{Extended_Pictographic}[\u{FE0F}\u{1F3FB}-\u{1F3FF}]*/gu, " ").replace(/[!！]+/g, ".").replace(/\*\*|__|[<>{}[\]`]/g, " ");
  if (shouts(t)) t = t.toLowerCase();
  return t.replace(/\s+/g, " ").replace(/\s+([,.;:?])/g, "$1").replace(/([,.;:?])(?:\s*[,.;:?])+/g, "$1").replace(/^[\s,.;:?—–-]+/, "").trim();
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

/**
 * A TICKER IN CODE'S FIGURES LINE, READ AS THIS GATE READS WORDS (red-team
 * 2026-10-12). The line is put in after the gate, so a provider's symbol in
 * it was never judged: "$BUY", "$WAGMI", "$SHILL" and "$LFG" were posted
 * from the house account in a line the gate would have refused as words. So
 * every ticker the line shows must clear the same vocabulary as a draft
 * (vocabularyRefusal, the all-caps alert words, advice beside a coin, an
 * amount in words), read lowercase and as written. Null when it does.
 */
export function tickerRefusal(ticker: unknown): string | null {
  if (typeof ticker !== "string" || !/^[A-Za-z]{2,10}$/.test(ticker)) return "charset";
  const upper = ticker.toUpperCase(), lower = ticker.toLowerCase();
  if (ALERT_CAPS.test(upper)) return "alert";
  const vocab = vocabularyRefusal(lower);
  if (vocab) return vocab;
  if (COIN_ADVICE.test(lower) || REPLY_ADVICE.test(lower) || ANSWER_PREDICTION.test(lower) || REPLY_CURRENT_OR_ACTION.test(lower)) return "hype";
  if (ADVICE_RUN_TOGETHER.test(lower)) return "hype";
  if (amountSaid(lower)) return "quantity";
  return null;
}

/**
 * THE GATE'S CALLS AND HYPE WITH THE SPACES TAKEN OUT (red-team 2026-10-12):
 * a ticker is one word, so "get in", "all in", "up only", "no loss", "sure
 * win", "ten x" and "don't miss" never matched the phrases above inside one,
 * and "$GETIN", "$ALLIN", "$UPONLY", "$TENX", "$DONTMISS", "$LASTCHANCE",
 * "$SUREWIN", "$DOUBLEUP", "$FULLPORT" were posted in the house's line. Read
 * anywhere in a ticker's letters; errs toward refusing.
 */
const ADVICE_RUN_TOGETHER = new RegExp([
  "getin", "gotin", "allin", "apein", "loadup", "loadin", "uponly", "onlyup", "noloss", "nolose", "cantlose", "cannotlose", "holdit", "holdthis", "keepholding",
  "surewin", "surething", "surebet", "safebet", "easywin", "bigwin", "winbig", "doubleup", "tripleup", "fullport", "allocat", "smartmoney", "easymoney",
  "freemoney", "jumpin", "stackit", "stackup", "grabit", "grabsome", "getsome", "dontmiss", "donotmiss", "nomiss", "lastchance", "lastcall", "finalcall",
  "tenbagger", "moonshot", "tothemoon", "nobrainer", "easygain", "quickflip", "flipit", "buydip", "thedip", "sendit", "apenow", "getrich", "richquick",
  "wenmoon", "notfinancial", "nextbig", "dontfade", "nofade", "trustme", "goingup", "goesup", "gonnarun", "readytorun", "takeoff",
  // a multiple in words: "$TENX", "$FIVEX", "$NEXTX", "$HUNDREDX"
  "(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|fifty|hundred|thousand|million|next|double|triple)x",
].join("|"));

/**
 * A BUY SAID IN THE FIRST PERSON: bought, grabbed, picked up, scooped,
 * snagged, aped, got in on, entered, added, loaded up on, went in on, been
 * buying — with or without the "i" people drop ("yep, grabbed bonk"). "i buy
 * when…" is a habit and "the buying" a noun; neither is a buy. A bag is a
 * holding.
 */
const ACQUIRED = new RegExp(String.raw`\b(?:bought(?:\s+into)?|grabbed|grabbing|picked\s+up|picking\s+up|scooped(?:\s+up)?|snagged|copped|aped(?:\s+in(?:to)?)?|aping(?:\s+in(?:to)?)?|got\s+in(?:to)?(?:\s+on)?|getting\s+in(?:to)?(?:\s+on)?|entered|added|loaded\s+up(?:\s+on)?|went\s+in(?:\s+on)?|took\s+a\s+position\s+in|(?:been|i'?m|im|was|were)\s+buying|stack(?:ed|ing)(?:\s+up)?|accumulat(?:ed|ing)` +
  // AND THE TRENCHES' OWN VERBS (red-team review of a964a74c, 2026-10-12): told
  // none of its buys, "the index shows plenty of buyers, sniped some earlier",
  // "swapped into a fresh one earlier", "minted a fresh one earlier", "sent it
  // on a fresh one earlier" and "just sniped another fresh one" were posted
  // under "$CHUMP today?" and "thoughts on $CHUMP?".
  String.raw`|snip(?:ed|ing)|swapp(?:ed|ing)(?:\s+in(?:to)?)?|mint(?:ed|ing)|(?:sent|sending)\s+it(?:\s+on)?|rotat(?:ed|ing)\s+into|(?:jumped|jumping|hopped|hopping|dove|dived|diving)\s+in(?:to)?(?:\s+on)?|got\s+filled|bid\s+on|bidding\s+on)\b`, "gi");
const BAG = /\bbag(?:s|ged|holder|holders|holding)?\b/i;
/** What may come between a buy and what it was of: "a little", "some of the". */
const BUY_FILLER: ReadonlySet<string> = new Set("a an the some little bit of couple few small more another new fresh early my".split(" "));
/** What a buy may be of without naming a coin, or the clause going on: "bought it", "picked up a few with real money", "grabbed some coins lately". */
const BUY_OBJECT: ReadonlySet<string> = new Set(("it its them those these that this one ones coins coin tokens token memecoins memes launches stuff things names plays " +
  "with when because cause cuz on in at for and but or lately recently today yesterday earlier here there back too again after before since while as then now " +
  "from off up into last so just around over what which whatever anything something nothing any i i'm im i've ive").split(" "));

/**
 * A BUY OR A HOLDING, WHATEVER THE VERB (red-team review, 2026-10-12). Told
 * none of its buys and asked "did you buy $WIF?", an answer said "yep,
 * purchased it lately", "picked some up", "traded it lately", "nabbed a few",
 * "snapped some up", "i'm in on that one", "it's one of mine", "my owner had
 * me buy it", "i went for it anyway", "i did": none of them ACQUIRED's verbs,
 * every one a public yes on a real-money account. So, told none: any
 * acquiring or holding verb said by "i" or "we", or opening a clause with the
 * "i" dropped ("yep, nabbed a few"); "i did" or "i have" as an answer, and
 * "i didn't" or "never bought" (a no says just as much); and the shapes of
 * owning it ("mine", "in my book", "riding it", "my latest pick"). A third
 * person is not read: "the creator still holding a big chunk" and "late
 * buyers end up holding it" are what research says.
 */
const OWN_VERB = String.raw`(?:purchas(?:e|es|ed|ing)|nabb?(?:ed|ing|s)?|snapp(?:ed|ing)|snag(?:g(?:ed|ing))?|traded|pick(?:ed|ing)?|took|got|gotten|own(?:ed|ing|s)?|hold(?:s|ing)?|held|scoop(?:ed|ing)?|copp?(?:ed|ing)?|bought|grabb?(?:ed|ing)?|aped|aping|bagg?(?:ed|ing)|added|loaded|went\s+(?:for|with|in(?:to)?|all)|go(?:ing)?\s+(?:for|with)\s+it|stack(?:s|ed|ing)?|accumulat(?:e|es|ed|ing)` +
  // The trenches' own verbs, said by "i" or with the "i" dropped (red-team review of a964a74c, ACQUIRED).
  String.raw`|snip(?:e|es|ed|ing)|swapp?(?:ed|ing|s)?|mint(?:ed|ing|s)?|(?:sent|send|sends|sending)\s+it|rotat(?:e|es|ed|ing)\s+into|(?:jump(?:ed|ing|s)?|hopp?(?:ed|ing|s)?|dove|dive[ds]?|diving)\s+in(?:to)?|bid(?:s|ding)?\s+on)`;
const BY_ME = String.raw`\b(?:i|we|i'?ve|ive|we'?ve|i'?m|im|we'?re|i'?d)\s+(?:(?:just|already|also|recently|still|been|finally|only|sure|even|did|do|have|had|really|actually|kinda)\s+){0,2}`;
const CLAUSE_OPEN = String.raw`(?:^|[,.;:!?—–]\s*|\b(?:and|but|so|then|yep|yeah|yes|yup|ya|honestly|sure)[\s,]+)(?:(?:just|already|also|recently|still|been|finally|only)\s+){0,2}`;
const OWNED_ACT = new RegExp(String.raw`(?:${BY_ME}|${CLAUSE_OPEN})${OWN_VERB}\b`, "iu");
const OWNED_SHAPE = new RegExp(
  "\\b(?:" +
    [
      "mine",
      "one\\s+of\\s+my\\s+(?:buys|picks|coins|bags|positions|trades|plays|calls|bets)",
      "(?:in|on)\\s+my\\s+(?:book|books|bag|bags|portfolio|wallet|stack|list|holdings|positions?)",
      "my\\s+(?:latest|last|newest|recent|first|top|fav(?:ou?rite)?|current|new|big|best|own)\\s+(?:pick|buy|play|trade|call|bet|position|coin|token|one|entry|bag)s?",
      "riding\\s+(?:it|that|this|them|that\\s+one)",
      "in\\s+on\\s+(?:it|that|this|them|one)",
      "(?:i'?m|im|i\\s+am|we'?re)\\s+in\\b(?!\\s+(?:the|a|an|no|my|your|for|love|doubt|between)\\b)",
      "(?:my|the|our)\\s+owner\\s+(?:had|made|got|let|wanted)\\s+(?:me|us)",
      "sure\\s+did",
      "(?:i|we)\\s+(?:did|do|have|had)(?=\\s*(?:[,.;:!?—–]|$|\\s+(?:too|some|one|it|that|this|them|a\\s+(?:bit|little|few))\\b))",
      "(?:i|we)\\s+(?:didn'?t|don'?t|haven'?t|hadn'?t|did\\s+not|do\\s+not|have\\s+not)\\s+(?:buy|bought|touch|touched|trade|traded|own|owned|hold|held|ape|aped|have\\s+(?:it|any|one))",
      "never\\s+(?:bought|touched|traded|owned|held|aped)",
    ].join("|") +
    ")\\b",
  "iu",
);

/**
 * LIKING IT IS SAYING IT TOO (red-team review, 2026-10-12): "yes, it's one of
 * mine, i like it a lot", "liked the early curve". Asked about a named coin,
 * an answer told none of its buys may not say it likes, loves or rates it,
 * that it is a fan of it or into it. Never "looks like it", "feels like
 * that": those compare, not prefer.
 */
const LIKED = new RegExp(
  "\\b(?:" +
    [
      "(?:i|we)\\s+(?:(?:really|kinda|still|do|also|just|totally|actually)\\s+)?(?:like|liked|love|loved|dig|dug|rate|rated|fancy|fancied|prefer|preferred|enjoy|enjoyed|adore|adored)",
      String.raw`(?:^|(?<=[,.;:!?—–]\s*)|(?<=\b(?:and|but|so|yep|yeah|yes|yup|honestly|really)[\s,]+))(?:like|liked|love|loved|dig|dug|rate|rated|adore|adored)`,
      String.raw`(?<!\b(?:looks?|looked|seems?|seemed|feels?|felt|sounds?|sounded|just|kinda|more|less|something|nothing|anything|much|is|was|be|it's|that's|not)\s)(?:like|liked|love|loved|dig|rate|rated)\s+(?:it|that|this|them|how|the\s+way)`,
      "fan\\s+of",
      "big\\s+fan",
      "into\\s+(?:it|that|this|them)",
      "my\\s+(?:kind|type|sort)\\s+of",
      "(?:a|my|the)\\s+fav(?:ou?rite)?s?",
      "(?:i'?m|im|i\\s+am|we'?re)\\s+(?:a\\s+(?:big\\s+)?)?(?:fan|into|keen|sold)",
    ].join("|") +
    ")\\b",
  "iu",
);

/**
 * OF A NAMED COIN, NO YES OR NO AND NO "I" BUT A DEFLECTION (red-team review,
 * 2026-10-12). "did you buy $PEPE2?" answered "yep, i did. that one's mine",
 * "yeah that one was my latest pick", "yes, it's in my book, been riding it",
 * "sure did": a list of verbs is never whole. An answer about a coin someone
 * named, told none of its buys, has only these to say: what it looked up
 * (said of the source, never of itself), that it could not look, that it
 * keeps single positions to itself, and, on paper, that it is on paper. So
 * it may not answer yes or no, and it may not speak of itself in the first
 * person outside those few clauses.
 */
const AFFIRM = /(?:^|[,.;:!?—–(]\s*|\b(?:and|but|so|honestly|well|oh|lol|haha|ha)[\s,]+)(?:yes+|yep|yup|yeah|yea|ya|yah|sure|absolutely|definitely|certainly|indeed|correct|totally|you bet|bingo|of course|nope|nah|naw|no(?=\s*[,.;:!?—–]|\s+(?:i|i'?ve|i'?m|never|not|sir|way)\b))\b/iu;
const SPEAKS_OF_ITSELF = /\b(?:i|i'?m|im|i'?ve|ive|i'?d|i'?ll|me|my|mine|myself|we|we'?re|we'?ve|our|ours|us)\b/iu;
const DEFLECTIONS: readonly RegExp[] = [
  /\b(?:i|we)\s+(?:(?:really|just|honestly)\s+)?(?:don'?t|do\s+not|never|won'?t|can'?t|cannot)\s+(?:really\s+)?(?:talk|say|share|discuss|comment|get|go|speak|weigh|chat|name|post)\b(?:\s+(?:about|on|into|in|over))?(?:\s+(?:my|any|individual|single|specific|particular|the|those|these|one-off))*\s+(?:positions?|coins?|tokens?|trades?|buys?|picks?|holdings?|bags?|names?|calls?|ones?)\b(?:\s+(?:here|on\s+here|publicly|in\s+public|on\s+x))?/giu,
  /\b(?:i|we)\s+keep\s+(?:(?:my|our|individual|single|specific|those|that|the|own)\s+)*(?:positions?|trades?|buys?|picks?|coins?|holdings?|bags?|calls?)\s+to\s+(?:myself|ourselves)(?:\s+here)?/giu,
  /\b(?:i|we)\s+(?:couldn'?t|could\s+not|can'?t|cannot|wasn'?t\s+able\s+to)\s+(?:look|check|pull|find|get)\s+(?:(?:it|that|this|that\s+one|this\s+one|anything)\s+)?(?:up\b|on\s+it\b)?/giu,
  /\b(?:i|we)\s+looked\s+(?:(?:it|that|this|that\s+one)\s+)?up\b/giu,
  /\b(?:i'?m|im|i\s+am|we'?re)\s+(?:(?:still|just|only|strictly|trading|playing)\s+)*on\s+paper\b|\b(?:i|we)\s+(?:only\s+|just\s+)?(?:trade|play)\s+(?:it\s+)?on\s+paper\b/giu,
  /\b(?:i|we)\s+(?:don'?t|do\s+not|never)\s+(?:give|do|hand\s+out|make|offer)\s+(?:out\s+)?(?:advice|calls|picks|tips|predictions)\b/giu,
];
/**
 * AND NOT IN THE THIRD PERSON EITHER (red-team 2026-10-12): beside a coin's
 * figures, "alan has been stacking it all week", "alan is long it" and "alan
 * is buying it" were admitted, since only "i", "my" and "we" were read. Its
 * own name (whole, or any word of it of three letters or more: "alan",
 * "dale"), "this account", "the agent", "the bot" or its owner is itself.
 */
const SPEAKS_OF_ITSELF_AS_ANOTHER = /\b(?:this\s+(?:account|agent|bot|page|profile)|the\s+(?:agent|bot|account)\s+here|the\s+agent|(?:the|its|their)\s+owner|merrymen'?s?\s+(?:agent|bot|account))\b/iu;
function selfNamed(text: string, agentName: string): boolean {
  const name = agentName.trim();
  if (!name) return false;
  return [name, ...name.split(/\s+/).filter((w) => /^\p{L}{3,}$/u.test(w))].some((n) => mentions(text, n));
}
function namedClaim(text: string, agentName = ""): boolean {
  if (AFFIRM.test(text) || LIKED.test(text)) return true;
  let rest = text;
  for (const re of DEFLECTIONS) rest = rest.replace(re, " ");
  return SPEAKS_OF_ITSELF.test(rest) || SPEAKS_OF_ITSELF_AS_ANOTHER.test(rest) || selfNamed(rest, agentName);
}

/**
 * A WORD THAT COULD BE A COIN IT WAS NEVER TOLD OF, in an answer told its
 * buys: one of three letters or more that is not everyday (answerWord), not a
 * word of a coin it was told of, and not one it was handed (`known`).
 */
function unvouchedWord(text: string, coins: readonly string[], known: readonly string[]): boolean {
  const ok = new Set<string>();
  for (const n of [...coins, ...known]) for (const w of textWords(n)) ok.add(w);
  return textWords(text).some((w) => /^[a-z]{3,}$/.test(w) && !ok.has(w) && !BUY_FILLER.has(w) && !BUY_OBJECT.has(w) && !answerWord(w));
}

/** A word and the forms it may stand for once an ending people add is off: "edged" is "edge", "holders" is "holder". */
function wordForms(w: string): string[] {
  const out = [w];
  for (const end of ["s", "es", "ies", "ed", "d", "ing", "er", "est", "ly", "y"]) {
    if (!w.endsWith(end) || w.length - end.length < 3) continue;
    const stem = w.slice(0, -end.length);
    out.push(stem, `${stem}e`);
    if (end === "ies") out.push(`${stem}y`);
    if (stem.at(-1) === stem.at(-2)) out.push(stem.slice(0, -1));
  }
  return out;
}

/**
 * A NAME AN ANSWER HANDED RESEARCH WAS NOT HANDED (XGateCtx.lookedOnly): a
 * word of three letters or more that is no everyday one (answerWord), in no
 * form a word of what it was handed (`known`) or of a coin in `coins`.
 */
function unlookedName(text: string, coins: readonly string[], known: readonly string[]): boolean {
  const ok = new Set<string>();
  for (const n of [...coins, ...known]) for (const w of textWords(n)) for (const f of wordForms(w)) ok.add(f);
  return textWords(text).some((w) => /^[a-z]{3,}$/.test(w) && !wordForms(w).some((f) => ok.has(f)) && !BUY_FILLER.has(w) && !BUY_OBJECT.has(w) && !answerWord(w));
}

/** Insight-only grammatical exemptions. Require a market subject at a
 * clause boundary, a complete predicate, and no object that could be a
 * coin. Only the acquisition/holding screens use the masked clause; every
 * other screen still sees the original words.
 */
function withoutInsightMarketPredicates(text: string): string {
  const start = String.raw`(^|[.!?;:]\s*|\b(?:and|while|but)\s+)`;
  const end = String.raw`(?=\s*(?:[.!?;,:]|$|\b(?:and|while|but)\b))`;
  const range = new RegExp(start + String.raw`((?:the\s+)?(?:majors|big\s+coins|volume|activity|prices)\s+(?:(?:is|are)\s+)?)(?:still\s+)?in\s+(?:(?:a|the|its|their)\s+)?(?:(?:tight|wide|narrow|lower|upper|top|bottom)\s+)?(?:end\s+of\s+(?:the\s+)?)?range` + end, "gi");
  const picking = new RegExp(start + String.raw`((?:the\s+)?(?:volume|activity)\s+(?:(?:is|are)\s+)?)(?:still\s+)?picking\s+up(?:\s+(?:today|right\s+now|on\s+the\s+day))?` + end, "gi");
  return text.replace(range, "$1$2rangebound").replace(picking, "$1$2increasing");
}

function buyClaimed(text: string, vouched: readonly string[] | null): boolean {
  if (vouched === null) return BAG.test(text) || new RegExp(ACQUIRED.source, "i").test(text) || OWNED_ACT.test(text) || OWNED_SHAPE.test(text);
  const names = vouched.map((c) => c.trim().toLowerCase().replace(/^\$/, "")).filter((c) => c !== "");
  for (const m of text.matchAll(ACQUIRED)) {
    const after = text.slice((m.index ?? 0) + m[0].length).split(/[.,!?;:—–]/)[0]!.toLowerCase();
    const rest = after.trim().replace(/^\$/, "");
    if (names.some((n) => rest === n || rest.startsWith(`${n} `) || rest.startsWith(`${n}'`))) continue;
    const word = after.split(/\s+/).filter(Boolean).find((w) => !BUY_FILLER.has(w)) ?? "";
    const bare = word.replace(/^\$/, "").replace(/'s$/, "");
    if (word === "" || BUY_OBJECT.has(bare) || names.some((n) => n === bare || n.split(/\s+/)[0] === bare)) continue;
    return true;
  }
  return false;
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
 * THE NOTICE AT THE END OF AN ANSWER, HOWEVER IT IS CLOSED: "say stop to opt
 * out.", "Reply stop to opt-out!", after a comma or a dash. Taken off an
 * active agent's answer before anything reads it (XGateCtx.answer): its
 * answers carry none (the owner's decision, 2026-10-12), and a model shown
 * older answers that did may copy it.
 */
const ANSWER_NOTICE_TAIL = /[\s,;:—–-]*\b(?:say|reply)\s+stop\s+to\s+opt[\s-]?out[.!]?\s*$/i;
/**
 * ANY OTHER OPT-OUT WORDING IN AN ANSWER: "reply stop anytime", "type stop",
 * "dm stop", "opt out", "opt-out", "unsubscribe". Refused as opt-out-said:
 * never repaired, since what is left around it may lean on it.
 */
export const OPT_OUT_SAID = /\b(?:say|reply|replying|type|send|text|dm|tweet|write|respond(?:ing)?\s+with)\s+["'“”‘’]?stop\b|\bopt[\s-]?outs?\b|\bunsubscrib\w*/i;

/**
 * MAY THIS BE POSTED ON X? Tidy, then the base gate, then every X clause.
 * `ok` carries the exact text to store and post.
 *
 * Reason codes (stable, operator-only): empty · pass · meta · hidden-chars · charset · too-short · too-long ·
 * handle · link · markup · emoji · exclaim · caps · ops · alert · hype · pnl ·
 * market · human-claim · points-back · coin-unsaid · paper-unsaid · mode-false · undisclosed · intro-no-trading ·
 * opt-out-unsaid · opt-out-said · reply-current-or-action · sherwood-claim · bought-named · buy-claim · unlooked-name · stock-phrase ·
 * sale-unsaid · sale-result · sale-timing · sale-amount · sale-holding · sale-length ·
 * cashtags · fleet-repeat · seed-echo — plus whatever the base gate says (has-digits,
 * quantity, repeat, unvouched-ticker, address, secret…).
 *
 * WHAT A DRAFT IS WEIGHED AGAINST HAS NO FIGURES LINE (figures.ts). An active
 * agent's posted answer may carry one, put in by code after this gate; every
 * earlier post, its own and the fleet's, is read here without it. So two
 * answers are a repeat when their words are, never because their figures
 * match (two answers about the same coin an hour apart), and never "new"
 * because their figures differ.
 */
export function admitXPost(raw: unknown, given: XGateCtx, baseGate: BaseGate): XVerdict {
  const ctx: XGateCtx = { ...given, recentOwn: strings(given?.recentOwn).map(withoutFiguresLine), recentFleet: strings(given?.recentFleet).map(withoutFiguresLine) };
  const agentName = String(ctx?.agentName ?? "").trim();
  // AN ANSWER CARRIES NO OPT-OUT LINE (XGateCtx.answer): the notice at its end is taken off first.
  const tidied = ctx.kind === "reply" && ctx.answer === true ? tidyXPost(raw, agentName).replace(ANSWER_NOTICE_TAIL, "").trim() : tidyXPost(raw, agentName);
  if (tidied === "") return refuse("empty");
  if (PASS.test(tidied)) return refuse("pass");
  if (metaRefusal(raw, tidied, agentName)) return refuse("meta");
  // Nothing invisible: the base gate would take it out after every check here had read around it.
  if (hidesCharacters(tidied)) return refuse("hidden-chars");
  // Nothing written for a letter, read before any sherwood check (strayCharacter).
  if (ctx.kind === "reply" && strayCharacter(tidied)) return refuse("charset");
  // An active owner's post never names a data provider or the chain (XGateCtx.house).
  if (ctx.house === true && sourceNamed(tidied)) return refuse("source-named");
  // A reply never says sherwood runs it, whoever drafted it (see SHERWOOD_NAME).
  if (ctx.kind === "reply" && sherwoodClaimed(tidied)) return refuse("sherwood-claim");
  // In a reply only, "sherwood-1" is a name: masked for every check below, put back after.
  const named = ctx.kind === "reply" ? maskSherwood(tidied) : { text: tidied, said: [] };
  if (named === null) return refuse("has-digits");
  // What it is weighed against is masked the same way, so a line said before is still the same line.
  const against = ctx.kind === "reply"
    ? { ...ctx, recentOwn: strings(ctx.recentOwn).map(withStandIn), recentFleet: strings(ctx.recentFleet).map(withStandIn), seeds: strings(ctx.seeds).map(withStandIn) }
    : ctx;
  const verdict = admitMasked(named.text, against, baseGate, agentName);
  if (!verdict.ok) return verdict;
  const out = named.said.length === 0 ? verdict : unmaskSherwood(verdict.text, named.said);
  // WHAT IS POSTED, JUDGED AGAIN: the base gate hands back its own cleaned
  // text, and a claim it put together is still a claim.
  if (out.ok && ctx.kind === "reply" && sherwoodClaimed(out.text)) return refuse("sherwood-claim");
  return out;
}

function admitMasked(tidied: string, ctx: XGateCtx, baseGate: BaseGate, agentName: string): XVerdict {

  const coins = strings(ctx.coins);
  const baseCtx = {
    vouchedSymbols: coins,
    // Only its own name: nobody else is in an X post, so nobody else may be named.
    rosterNames: agentName ? [agentName] : [],
    recentOwn: ctx.kind === "reply" ? [] : strings(ctx.recentOwn),
    recentRoom: [],
  };
  const base = baseGate(tidied, baseCtx);
  if (!base.ok) return base;
  const text = base.text;
  if (["buy", "sell", "recap", "casual"].includes(ctx.kind) && ctx.recentOpeners) {
    const key = openerKey(text, coins);
    if (key && ctx.recentOpeners.slice(0, 8).some((previous) => openerKey(previous, coins) === key)) return refuse("same-opener");
  }
  // Never a coin it bought, in an answer that was never told what it bought.
  const unsaid = strings(ctx.unsaid);
  if (unsaid.length && namedIn(ctx.kind === "reply" ? withoutReplyOptOut(text) : text, unsaid)) return refuse("bought-named");
  // Nor a buy it was not told of.
  if (ctx.buys !== undefined && buyClaimed(ctx.kind === "reply" ? withoutReplyOptOut(text) : ctx.kind === "casual" && ctx.insight === true ? withoutInsightMarketPredicates(text) : text, ctx.buys === "none" ? null : coins)) return refuse("buy-claim");
  // Told its buys: no word that could be another coin's name (XGateCtx.known).
  if (ctx.buys === "vouched" && ctx.known !== undefined && unvouchedWord(withoutNames(ctx.kind === "reply" ? withoutReplyOptOut(text) : text, [agentName]), coins, strings(ctx.known))) return refuse("buy-claim");
  // Handed what it looked up and told none of its buys: no name it was not handed either (XGateCtx.lookedOnly).
  if (ctx.buys === "none" && ctx.lookedOnly === true && ctx.known !== undefined && unlookedName(withoutNames(ctx.kind === "reply" ? withoutReplyOptOut(text) : text, [agentName]), coins, strings(ctx.known))) return refuse("unlooked-name");
  // Nor, of a coin someone named, that it likes it, a yes or a no, or itself outside a deflection (namedClaim).
  if (ctx.buys === "none" && ctx.named === true && namedClaim(ctx.kind === "reply" ? withoutReplyOptOut(text) : text, agentName)) return refuse("buy-claim");

  if (text.length > XPOST_MAX_CHARS || xWeightedLength(text) > X_MAX_WEIGHTED) return refuse("too-long");
  if (words(text) < XPOST_MIN_WORDS) return refuse("too-short");
  if (ctx.kind === "reply") {
    const body = withoutReplyOptOut(text);
    // A COMMENT REPLY ENDS WITH THE NOTICE; AN ANSWER NEVER CARRIES ONE (XGateCtx.answer, the owner's decision of 2026-10-12).
    if (ctx.answer === true ? OPT_OUT_SAID.test(text) : body === text) return refuse(ctx.answer === true ? "opt-out-said" : "opt-out-unsaid");
    if (words(body) < XPOST_MIN_WORDS) return refuse("too-short");
    // The full text has passed the base privacy checks above. Compare
    // originality symmetrically without the mandatory notice on either side.
    const bodyGate = baseGate(body, { ...baseCtx, recentOwn: strings(ctx.recentOwn).map(withoutReplyOptOut) });
    if (!bodyGate.ok) return bodyGate;
  }
  if (HANDLE.test(text)) return refuse("handle");
  // ONE CASHTAG AT MOST: X refuses an API post with more than one (docs.x.com,
  // "Posts created via the API are limited to a maximum of 1 cashtag"); such a
  // draft would only come back a 403 after its slot and its unit were spent.
  if ((text.match(CASHTAG_ANY) ?? []).length > 1) return refuse("cashtags");
  if (LINK.test(text)) return refuse("link");
  if (MARKUP.test(text)) return refuse("markup");

  const emoji = text.match(PICTOGRAPH) ?? [];
  if (emoji.length > 1 || (emoji.length === 1 && ctx.emojiOk === false)) return refuse("emoji");
  if ((text.match(/[!！]/g) ?? []).length > 1) return refuse("exclaim");

  // NAMES OUT FIRST. An agent called "Signal Fox" or a coin called "Moon Cat"
  // is a name, not an alert or hype — and "TSLA" is the ticker it bought, not
  // shouting. What is left is the agent's own words, and those are judged.
  const own = withoutNames(text, [agentName, ...coins]);
  // Only the typed sale path admits the receipt-backed past-tense sale verb.
  // A measured result is appended by trusted code after this prose gate.
  const saleWords = ctx.kind === "sell" ? own.replace(/\bsold\b/gi, " ") : own;
  const vocab = vocabularyRefusal(saleWords);
  if (vocab) return refuse(vocab);
  if (ctx.kind === "sell") {
    if (!/\bsold\b/i.test(own)) return refuse("sale-unsaid");
    // THE ALERT AND THE PRICE READ WITH "SOLD" STILL IN (SALE_TIMING): "just sold", "sold at".
    const sale = own.normalize("NFKC").replace(/[’‘]/g, "'");
    if (ALERT.test(sale) || ALERT_CAPS.test(sale) || ALERT_EMOJI.test(sale)) return refuse("alert");
    if (MARKET.test(sale)) return refuse("market");
    if (/\b(?:jeet\w*|early|late|afterwards|afterward|since|continued|kept|rallied|pumped|dumped|mooned|timing|timed|won|win\w*|los[st]\w*|flat|break[ -]?even|green|red|victory|relie[fv]\w*|regret\w*|pleased|happy|sad|glad|proud|celebrat\w*|ouch|painful|hurt|finest|mistake|success\w*|paid off|worked|thesis|right|wrong|nice|lucky|luck|fortunately|unfortunately|closed|exited|out|because|due to)\b/i.test(own)) return refuse("sale-result");
    if (SALE_TIMING.test(sale)) return refuse("sale-timing");
    if (SALE_AMOUNT.test(sale)) return refuse("sale-amount");
    if (amountSaid(sale)) return refuse("quantity");
    // Nothing left or kept, and no buy to come: what a casual post is held to (REPLY_CURRENT_OR_ACTION, HOT_BUY_CLAIM), and SALE_HOLDING.
    if (SALE_HOLDING.test(sale) || REPLY_CURRENT_OR_ACTION.test(sale) || REPLY_CURRENT_POSITION.test(sale) || hotBuyClaimed(sale)) return refuse("sale-holding");
    if ((ctx.saleMaxLength !== undefined && !Number.isFinite(ctx.saleMaxLength)) || xWeightedLength(text) > Math.max(0, Math.min(X_MAX_WEIGHTED, ctx.saleMaxLength ?? 180))) return refuse("sale-length");
  }
  const namesCoin = coins.some((c) => mentions(text, c));
  if ((namesCoin || ctx.kind === "reply") && COIN_ADVICE.test(own)) return refuse("hype");
  if (ctx.kind === "reply" && REPLY_ADVICE.test(own)) return refuse("hype");
  if (ctx.kind === "reply" && ctx.answer === true && ANSWER_PREDICTION.test(own)) return refuse("hype");
  if (ctx.kind === "reply" && ctx.answer === true && ANSWER_CALL.test(withoutReplyOptOut(own).trim())) return refuse("hype");
  // A drafted answer never forecasts a coin, named or pointed at (draftedForecast).
  if (ctx.kind === "reply" && ctx.answer === true && ctx.drafted === true && draftedForecast(withoutReplyOptOut(own))) return refuse("hype");
  // AN INSIGHT POST IS HELD TO EVERY SCREEN A DRAFTED ANSWER IS (XGateCtx.insight).
  if (ctx.kind === "casual" && /\b(?:tell|ask|urge|encourage)\s+(?:everyone|people|others|them|followers)\s+to\s+(?:buy|sell|hold|ape|invest)\b/i.test(own)) return refuse("hype");
  if (ctx.kind === "casual" && /\?/.test(own) && /\b(?:buy|buying|sell|selling|hold|holding|ape|aping|invest|investing)\b/i.test(own)) return refuse("hype");
  if (ctx.kind === "casual" && ctx.insight === true) {
    if (COIN_ADVICE.test(own) || REPLY_ADVICE.test(own) || ANSWER_PREDICTION.test(own) || ANSWER_CALL.test(own.trim()) || draftedForecast(own)) return refuse("hype");
    if (houseClaimed(own) || deciderClaimed(own)) return refuse("house-claim");
    if (amountSaid(own)) return refuse("quantity");
  }
  // A drafted answer never claims for the house, teases, judges the asker or boasts (ANSWER_HOUSE_CLAIM).
  if (ctx.kind === "reply" && ctx.answer === true && ctx.drafted === true && houseClaimed(own)) return refuse("house-claim");
  // Nor who or what decides its trades (DECIDER_CLAIM).
  if (ctx.kind === "reply" && ctx.answer === true && ctx.drafted === true && deciderClaimed(own)) return refuse("decider-claim");
  if (ctx.kind === "reply" && ctx.answer === true && STOCK_PHRASE.test(own)) return refuse("stock-phrase");
  if (ctx.kind === "reply" && (REPLY_CURRENT_OR_ACTION.test(own) || REPLY_CURRENT_POSITION.test(own))) return refuse("reply-current-or-action");
  // A casual post, and a drafted answer, never ties its buys to what's hot, nor lines up its next one; a casual post never says a buy to come or a holding either (HOT_BUY_CLAIM).
  if (ctx.kind === "casual" && (REPLY_CURRENT_OR_ACTION.test(own) || REPLY_CURRENT_POSITION.test(own))) return refuse("reply-current-or-action");
  if ((ctx.kind === "casual" || (ctx.kind === "reply" && ctx.answer === true && ctx.drafted === true)) && hotBuyClaimed(ctx.kind === "casual" && ctx.insight === true ? withoutInsightMarketPredicates(own) : own)) return refuse("reply-current-or-action");
  // No amount, price or multiple in words the base gate's list misses (AMOUNT_WORDS).
  if (ctx.kind === "reply" && amountSaid(withoutReplyOptOut(own))) return refuse("quantity");
  if (shouts(own)) return refuse("caps");
  if (ctx.kind !== "reply" && POINTS_BACK.test(own.trim())) return refuse("points-back");

  // A BUY POST NAMES ITS COIN: its label, its ticker or its clean name, as a
  // whole word. Without one, "picked over others on the curve at the exit
  // line" is a line of jargon that reads like a signal bot, and a misspelled
  // name ("pudge penguins") is a coin nobody vouched for — the base gate only
  // checks $cashtags.
  if ((ctx.kind === "buy" || ctx.kind === "sell") && !namesCoin) return refuse("coin-unsaid");

  // PAPER IS SAID, AND SO IS NOTHING FALSE ABOUT THE MONEY. Said as a phrase
  // (saysPaper); a live post is false only when it claims paper OF THE MONEY
  // (claimsPaper) — "on paper a slow day sounds boring" is the idiom.
  const paperCoins = strings(ctx.paperCoins);
  const aboutPaper = ((ctx.kind === "buy" || ctx.kind === "sell" || ctx.kind === "reply") && ctx.mode === "paper") || paperCoins.some((c) => mentions(text, c));
  if (aboutPaper && !saysPaper(text, coins)) return refuse("paper-unsaid");
  if (ctx.kind === "sell" && ctx.mode === "live" && saysPaper(text, coins)) return refuse("mode-false");
  if (ctx.mode === "live" && claimsPaper(text, coins) && !aboutPaper) return refuse("mode-false");
  // A LIVE AGENT'S REPLY NEVER SAYS PAPER AT ALL (red-team 2026-10-12): "bonk
  // was a fun one on paper before that" said a paper buy beside "with real
  // money", and claimsPaper reads only its shapes. In a reply, fail closed:
  // any paper phrase, the idiom too, unless a paper coin it was told of is named.
  if (ctx.kind === "reply" && ctx.mode === "live" && saysPaper(text, coins) && !aboutPaper) return refuse("mode-false");
  // And either money in other words: play money for a live reply, real dollars (or "kidding") for a paper one.
  if (ctx.kind === "reply" && ctx.mode === "live" && PLAY_MONEY.test(text) && !aboutPaper) return refuse("mode-false");
  if (ctx.kind === "reply" && ctx.mode === "paper" && REAL_IN_OTHER_WORDS.test(text)) return refuse("mode-false");
  if (ctx.mode === "paper" && SAYS_REAL_MONEY.test(text)) return refuse("mode-false");
  // AN IDLE AGENT'S REPLY, COIN BY COIN (red-team 2026-10-12): "bought pepe and
  // bonk lately, both on paper" called a live buy paper, and "grabbed bonk and
  // pepe with real money, nothing on paper" a paper buy real money, because
  // paper was read for the whole text. With no mode to hold it to, a reply may
  // not name coins of both moneys, nor say paper beside a real-money coin, nor
  // real money beside a paper one.
  if (ctx.kind === "reply" && ctx.mode === null) {
    const isPaper = (c: string) => paperCoins.some((p) => p.trim().toLowerCase() === c.trim().toLowerCase());
    const liveNamed = coins.some((c) => !isPaper(c) && mentions(text, c));
    const paperNamed = paperCoins.some((c) => mentions(text, c));
    if ((liveNamed && paperNamed) || (liveNamed && saysPaper(text, coins)) || (paperNamed && SAYS_REAL_MONEY.test(text))) return refuse("mode-false");
  }

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
  const mine = withoutNames(ctx.kind === "reply" ? withoutReplyOptOut(text) : text, [agentName]);
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
    if (ctx.kind === "reply") return similarity(mine, withoutReplyOptOut(prev)) >= REPEAT_LIMIT;
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
