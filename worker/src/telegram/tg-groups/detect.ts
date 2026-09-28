/**
 * Telegram groups — what a line says, read cheaply and without a model.
 * The contract is docs/tg-groups.md.
 *
 * Everything here is PURE: text in, answer out. No I/O, no clock, no
 * randomness. pacing.ts turns these readings into "speak / react / stay out";
 * the coin flow uses the address finders. The only state is a small cache of
 * compiled name patterns, which changes speed, never answers.
 *
 * CHEAP ON PURPOSE. Every group line goes through these, most of them are
 * never answered, and a model call per line would spend the group allowance
 * on deciding to say nothing. A reading that is wrong in the quiet direction
 * (a missed tease, a missed trade word) costs one ambient line that was never
 * owed anyway; the ones that must not miss — distress, a slur, a CA — are
 * written to over-match rather than under-match.
 *
 * NEVER A TRADING INPUT. A CA found here is a lookup key for the coin flow,
 * which validates it again before anything crosses into trading (rule 1).
 * Nothing here reads, sizes or orders anything.
 */

import { fnv1a } from "../../memory/tokens";
import type { TgMessage } from "../api";

// ─── Normalising ───────────────────────────────────────────────────────────

/** Curly and look-alike apostrophes, so "you’re" reads like "you're". */
const APOS = /[‘’ʼ`´′]/g;
/**
 * Zero-width characters. "s​hut up" is someone dodging a filter, and
 * none of these ever changes what a word says.
 */
const ZERO_WIDTH = /[​-‍⁠﻿]/g;

/** Lowercase, compatibility-folded (fullwidth "ｇｍ" is "gm"), one apostrophe, single spaces. */
function norm(text: string): string {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .replace(APOS, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * norm() and then accents off, for comparing NAMES: "jose" calls José, and a
 * decomposed "José" is the same name as a precomposed one. Lowercased first so
 * a Turkish "İ" folds to a plain i instead of growing a combining dot after
 * the marks are gone.
 */
function fold(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(ZERO_WIDTH, "")
    .replace(APOS, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** The words of a line, emoji and punctuation dropped. Apostrophes stay inside a word ("y'all"). */
function wordsOf(t: string): string[] {
  return t.match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? [];
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ─── Addresses ─────────────────────────────────────────────────────────────

/**
 * 0x + EXACTLY 40 hex, not part of a longer hex run on either side.
 *
 * A 64-hex string is a tx hash, a v4 pool id or a private key, never a token,
 * and it must never be read as one: its first 40 characters look exactly like
 * an address. The lookahead refuses a 41st hex character and the lookbehind a
 * hex character before the 0x, so no slice of a longer run can match.
 */
const CA_RUN = /(?<![0-9a-f])0x([0-9a-f]{40})(?![0-9a-f])/gi;
/** At most this many CAs per message are considered (the contract's "first 2"). */
const MAX_CAS = 2;

/**
 * Every CA in a line, lowercased, unique, in order of appearance, at most 2.
 *
 * Found anywhere, including inside a GeckoTerminal / DexScreener / explorer
 * URL path or query string, because that is how most people post a coin.
 * Percent-escapes are read as separators first: in "…%2F0xabc…" the "F" of
 * the escaped slash is a hex character and would otherwise glue onto the
 * address and hide it.
 */
export function extractCas(text: string): string[] {
  if (typeof text !== "string" || !text) return [];
  const t = text.normalize("NFKC").replace(/%[0-9a-f]{2}/gi, " ");
  const out: string[] = [];
  for (const m of t.matchAll(CA_RUN)) {
    const ca = `0x${m[1].toLowerCase()}`;
    if (!out.includes(ca)) out.push(ca);
    if (out.length >= MAX_CAS) break;
  }
  return out;
}

/**
 * A Solana-style base58 run: 32–44 characters from the base58 alphabet (no 0,
 * O, I or l), a whole alphanumeric token on its own.
 *
 * Bounded by any alphanumeric, not just base58, so the "x…" after a CA's "0"
 * can never be read as a mint, and neither can a slice of a longer token.
 */
const B58_RUN = /(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![0-9A-Za-z])/g;

/**
 * True when the line carries something shaped like a Solana mint, so the coin
 * flow can say it is not on its chain. Recognised only to say that: it is
 * never looked up and never nominated.
 *
 * A real mint mixes upper case, lower case and digits; "hahahaha…" and a held
 * key ("AAAAAA…") do not, so all three are required. A pure-hex run is an EVM
 * hash or key without its 0x, not a mint.
 */
export function hasForeignMint(text: string): boolean {
  if (typeof text !== "string" || !text) return false;
  for (const m of text.normalize("NFKC").matchAll(B58_RUN)) {
    const run = m[0];
    if (/^[0-9a-f]+$/i.test(run)) continue;
    if (/[0-9]/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run)) return true;
  }
  return false;
}

/** "$PEPE": 2–10 letters/digits starting with a letter, not glued to a word or a longer run. */
const CASHTAG = /(?<![\p{L}\p{N}_$])\$([a-z][a-z0-9]{1,9})(?![\p{L}\p{N}_])/giu;

/** Cashtags in a line, uppercased, unique, in order. "$5" and "$100k" are money, not tickers. */
export function extractCashtags(text: string): string[] {
  if (typeof text !== "string" || !text) return [];
  const out: string[] = [];
  for (const m of text.normalize("NFKC").matchAll(CASHTAG)) {
    const tag = m[1].toUpperCase();
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

// ─── Is it talking to me? ──────────────────────────────────────────────────

/** Who the bot is in this chat: getMe's id and username, and its soul name. */
export interface BotSelf {
  id: number;
  username: string | null;
  name: string;
}

/**
 * NAMES THAT ARE ALSO EVERYDAY WORDS. A Merryman called "Will Scarlet" must not
 * answer "will it pump?", and one called "Robin" (the default) must not answer
 * every "robin hood chain" in a chat about Robinhood Chain. A word here is not
 * enough on its own: it calls the agent only as a vocative ("hey will",
 * "robin, thoughts?", "what do you think, rose?"), and a multi-word name
 * still answers to its full name.
 *
 * Folded (lowercase, no accents). Includes the generated-name adjectives
 * (packages/core/src/agent-name.ts) that are everyday chat words ("quick",
 * "quiet", "morning", "green", "winter" as in crypto winter), common given
 * names that are words, the band's own names that are words, and crypto words
 * someone might name an agent after. Short ones are here too: the stoplist
 * also guards a ONE-word full name ("Max", "Sol").
 */
const COMMON_WORD_NAMES: ReadonlySet<string> = new Set([
  // given names that are everyday words
  "will", "mark", "bill", "grace", "hope", "faith", "joy", "rose", "may", "june", "april", "august",
  "king", "queen", "prince", "duke", "earl", "lord", "baron", "sky", "star", "dawn", "summer", "autumn",
  "winter", "spring", "penny", "rich", "frank", "pat", "sue", "rob", "art", "jack", "chase", "grant",
  "miles", "chip", "chuck", "clay", "cliff", "crystal", "dusty", "drew", "gay", "harry", "holly", "iris",
  "ivy", "jade", "jewel", "lily", "matt", "max", "ray", "rocky", "sandy", "stormy", "sunny", "terry",
  "victor", "violet", "wade", "wes", "woody", "angel", "honey", "candy", "cash", "buck", "bud", "brook",
  "brooke", "river", "stone", "rock", "reed", "rusty", "misty", "hunter", "carter", "cole", "dean", "don",
  "gene", "glen", "hazel", "heather", "amber", "robin", "jay", "martin", "sterling", "noble", "royal",
  // the band's names that are words
  "hood", "little", "much", "merry", "tuck", "friar", "outlaw", "archer", "arrow", "bow",
  // generated-name words (agent-name.ts) that turn up in chat
  "blue", "bold", "calm", "clever", "green", "grey", "gray", "red", "gold", "golden", "silver", "iron",
  "bronze", "copper", "quick", "quiet", "swift", "wild", "keen", "lone", "pale", "gentle", "jolly",
  "morning", "evening", "midnight", "northern", "restless", "wandering", "rainy", "windy", "snowy",
  "brisk", "sly", "wry", "plum", "olive", "flint", "marsh", "meadow", "fox", "wolf", "hawk", "crow",
  "raven", "crane", "lark", "swallow", "kite", "drake", "stag", "hart", "hare", "mole", "moth", "owl",
  "rook", "teal", "pike", "piper", "tinker", "tanner", "squire", "bard", "hound", "jackdaw", "magpie",
  // crypto and meme words
  "bull", "bear", "whale", "shark", "ape", "degen", "moon", "pump", "chad", "based", "alpha", "beta",
  "sigma", "boss", "chief", "doge", "pepe", "shiba", "bonk", "wif", "trump", "elon", "satoshi", "anon",
  "fren", "ser", "sol", "eth", "gem", "ace", "ash", "jet", "kit", "rex", "pip", "bot", "agent", "robot",
  // other everyday words people pick as names
  "lucky", "happy", "smile", "sunshine", "ghost", "shadow", "storm", "thunder", "lightning", "blaze",
  "flash", "spark", "nova", "echo", "zen", "sage", "buddy", "pal", "champ", "tiger", "lion", "eagle",
  "falcon", "phoenix", "dragon", "cookie", "pepper", "ginger", "mint", "berry", "cherry", "peach",
  "apple", "banana", "mango", "coco", "biscuit", "muffin", "butter", "bean", "nugget", "pickle",
]);

/** Scripts written without spaces between words, where a name is followed or preceded straight by other letters. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Hangul}]/u;
const PRE = "(?<![\\p{L}\\p{N}_])";
const POST = "(?![\\p{L}\\p{N}_])";
/** Between the words of a name: anything that is not a letter or digit ("amber heron", "amber-heron", "Amber.Heron"). */
const SEP = "[^\\p{L}\\p{N}]+";
/** Openers that make the next word a vocative whatever follows ("hey will what's up", "gm rose"). */
const HAIL = "(?:hey|hi|hello|hiya|yo|oi|oy|ayo|ay|sup|gm|gn|dear)";
/** Openers that only make a vocative when the name ends the clause ("thanks will!" but not "thanks, will do"). */
const THANKS = "(?:thanks|thank you|thx|ty|tysm|bye|cya|later|night|morning)";

interface NameMatcher {
  /** The owner's label, "<name>'s owner", blanked before any other test. */
  label: RegExp | null;
  /** Patterns any one of which means the line names this agent. */
  hits: RegExp[];
}

const letterCount = (w: string): number => (w.match(/\p{L}/gu) ?? []).length;

/** A word, with the boundaries its script needs on each side. */
function bounded(core: string, first: string, last: string, lenient: boolean): string {
  const pre = lenient && UNSPACED.test(first) ? "" : PRE;
  const post = lenient && UNSPACED.test(last) ? "" : POST;
  return `${pre}${core}${post}`;
}

/** The ways a stoplisted word still calls the agent: said AS a name, never as a word in a sentence. */
function vocatives(w: string): RegExp[] {
  const W = escapeRe(w);
  const lead = `^[^\\p{L}\\p{N}]*(?:${HAIL}[^\\p{L}\\p{N}]+)?`;
  return [
    // the whole line is the name, perhaps after a hail: "robin", "hey rose 👋", "Will?"
    new RegExp(`${lead}${W}[^\\p{L}\\p{N}]*$`, "u"),
    // opens with the name and a pause: "rose, thoughts?", "will: you there"
    new RegExp(`${lead}${W}\\s*[,:!?]`, "u"),
    // a hail right before it anywhere: "lol hey will what's up", "gm rose"
    new RegExp(`${PRE}${HAIL}[^\\p{L}\\p{N}]+${W}${POST}`, "u"),
    // thanks/bye only when the name ends the clause: "thanks will!" but not "thanks, will do"
    new RegExp(`${PRE}${THANKS}[^\\p{L}\\p{N}]+${W}\\s*(?:[,.!?:;)]|$)`, "u"),
    // a trailing vocative after a comma: "what do you think, rose?"
    new RegExp(`,\\s*${W}\\s*[?!.]*\\s*$`, "u"),
  ];
}

const NAME_CACHE = new Map<string, NameMatcher>();
const NAME_CACHE_MAX = 64;

function nameMatcher(name: string): NameMatcher {
  const key = fold(name);
  const hit = NAME_CACHE.get(key);
  if (hit) return hit;
  const words = wordsOf(key);
  const hits: RegExp[] = [];
  let label: RegExp | null = null;
  if (words.length > 0) {
    const full = words.map(escapeRe).join(SEP);
    const first = words[0];
    const lastWord = words[words.length - 1];
    // A one-character CJK name would match inside every other word, so the
    // unspaced-script leniency needs at least two letters.
    const lenient = letterCount(key) >= 2;
    const fullRe = bounded(full, first[0], lastWord[lastWord.length - 1], lenient);
    // "<name>'s owner" / "<name>'s human" (and the first word's) name the owner, not the agent.
    const firstRe = words.length > 1 ? `|${bounded(escapeRe(first), first[0], first[first.length - 1], lenient)}` : "";
    label = new RegExp(`(?:${fullRe}${firstRe})(?:'s|s')?\\s*(?:owner|human)s?${POST}`, "gu");
    if (words.length === 1) {
      if (COMMON_WORD_NAMES.has(first)) hits.push(...vocatives(first));
      else hits.push(new RegExp(fullRe, "u"));
    } else {
      hits.push(new RegExp(fullRe, "u"));
      if (letterCount(first) >= 4 && !COMMON_WORD_NAMES.has(first)) {
        hits.push(new RegExp(bounded(escapeRe(first), first[0], first[first.length - 1], lenient), "u"));
      } else if (letterCount(first) >= 2) {
        hits.push(...vocatives(first));
      }
    }
  }
  const m: NameMatcher = { label, hits };
  NAME_CACHE.set(key, m);
  if (NAME_CACHE.size > NAME_CACHE_MAX) NAME_CACHE.delete(NAME_CACHE.keys().next().value as string);
  return m;
}

/** "merryman" calls any Merryman in the chat; "merryman's owner" does not. */
const MERRYMAN = new RegExp(`${PRE}merryman${POST}`, "u");
const MERRYMAN_LABEL = new RegExp(`${PRE}merryman(?:'s|s')?\\s*(?:owner|human)s?${POST}`, "gu");

const blank = (s: string): string => " ".repeat(s.length);

/** True when the line names the agent, as opposed to naming its owner. */
function namesSelf(text: string, name: string): boolean {
  let t = fold(text);
  if (!t) return false;
  t = t.replace(MERRYMAN_LABEL, blank);
  const m = typeof name === "string" && name.trim() ? nameMatcher(name) : null;
  if (m?.label) t = t.replace(m.label, blank);
  if (MERRYMAN.test(t)) return true;
  return m ? m.hits.some((re) => re.test(t)) : false;
}

/** The parts of a Telegram message addressedHow reads; a whole TgMessage fits. */
export type AddressedInput = Pick<TgMessage, "text" | "entities" | "replyTo">;

function mentionsSelf(m: AddressedInput, self: BotSelf): boolean {
  const text = typeof m.text === "string" ? m.text : "";
  const user = typeof self.username === "string" ? self.username.replace(/^@/, "").toLowerCase() : "";
  const handle = user ? `@${user}` : "";
  let sawMention = false;
  for (const e of Array.isArray(m.entities) ? m.entities : []) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "text_mention") {
      sawMention = true;
      if (typeof e.userId === "number" && e.userId === self.id) return true;
    } else if (e.type === "mention") {
      sawMention = true;
      const { offset: o, length: l } = e;
      // Offsets are UTF-16 code units, which is how JS indexes a string, so an
      // emoji before the mention (two units) shifts it exactly as Telegram counted.
      if (!handle || !Number.isInteger(o) || !Number.isInteger(l) || o < 0 || l <= 0 || o + l > text.length) continue;
      if (text.slice(o, o + l).toLowerCase() === handle) return true;
    }
  }
  // No mention entities at all (a caller that did not parse them, or a
  // client that sent none): the literal handle as a whole word still counts.
  // Not after a letter or digit, so "me@botname.com" is an email, not a call.
  if (!sawMention && user) {
    return new RegExp(`(?<![\\p{L}\\p{N}_@])@${escapeRe(user)}(?![\\p{L}\\p{N}_])`, "iu").test(text);
  }
  return false;
}

/**
 * How a line addresses the bot, or null when it does not.
 *
 * - "mention": an @username mention entity whose text is the bot's handle
 *   (case-insensitive), a text_mention of the bot's id, or — when the message
 *   carries no mention entities — the literal @handle as a whole word.
 * - "reply": a reply to one of the bot's own messages.
 * - "name": its full name as words; its first word when that has at least 4
 *   letters and is not an everyday word; an everyday-word name only as a
 *   vocative ("hey will"); or "merryman". "<name>'s owner" / "<name>'s human"
 *   is about the owner and never counts.
 *
 * Checked in that order, so a mention wins over a reply that also names it.
 */
export function addressedHow(m: AddressedInput, self: BotSelf): "mention" | "reply" | "name" | null {
  if (!m || !self) return null;
  if (mentionsSelf(m, self)) return "mention";
  const r = m.replyTo;
  if (r && typeof r.fromId === "number" && r.fromId === self.id) return "reply";
  if (namesSelf(typeof m.text === "string" ? m.text : "", self.name)) return "name";
  return null;
}

// ─── Shush ─────────────────────────────────────────────────────────────────

const SHUSH = new RegExp(
  [
    String.raw`\bshut (?:up|it|ur mouth|your mouth|the (?:fuck|hell|f) up|tf up)\b`,
    String.raw`\bshutup\b`,
    String.raw`\bstfu+\b`,
    String.raw`\bsybau\b`,
    String.raw`\bstop (?:talking|yapping|yappin|typing|posting|spamming|replying|chatting|with the yapping)\b`,
    String.raw`\b(?:quit|enough|no more|less) (?:yapping|yappin|talking|spamming)\b`,
    String.raw`\b(?:be|keep|stay) quiet\b`,
    String.raw`\bquiet (?:down|please|pls|plz|bot|you)\b`,
    String.raw`^quiet\W*$`,
    String.raw`\bshu+sh+\b`,
    String.raw`\bsh{2,}\b`,
    String.raw`\bhush\b`,
    String.raw`\bzip it\b`,
    String.raw`\bzip (?:ur|your) (?:lip|lips|mouth)\b`,
    String.raw`\bpipe down\b`,
    String.raw`\b(?:nobody|no one|no1|noone) asked\b`,
    String.raw`\bdidn'?t ask\b`,
    String.raw`\bwho (?:even )?asked\W*$`,
    String.raw`\bgo away\b`,
    String.raw`\benough (?:out of|outta) (?:you|u)\b`,
  ].join("|"),
  "u",
);
/** Not a shush: the meme, and "never shut up"-style complaints or compliments that are not a request. */
const NOT_SHUSH = /\bshut up and take my money\b|\b(?:don'?t|do not|never|can'?t|cannot|won'?t|couldn'?t|wouldn'?t)\s+(?:ever\s+)?(?:shut up|stop talking|stop yapping|be quiet)\b/gu;

/** "shut up", "stfu", "stop talking", "be quiet", "shush", "zip it", "nobody asked" and close variants. */
export function isShush(text: string): boolean {
  const t = norm(text).replace(NOT_SHUSH, " ");
  return !!t && SHUSH.test(t);
}

// ─── gm / gn ───────────────────────────────────────────────────────────────

/** Words that may ride along with a greeting without making it a sentence. */
const GREET_FILLER: ReadonlySet<string> = new Set([
  "all", "yall", "y'all", "everyone", "everybody", "fam", "fren", "frens", "friend", "friends", "ser",
  "sers", "guys", "gang", "team", "chat", "folks", "people", "peeps", "degens", "degen", "legends",
  "bros", "bro", "homies", "kings", "queens", "anon", "anons", "fellas", "lads", "world", "crew",
  "squad", "family", "my", "beautiful", "lovely", "to", "you", "u", "too", "and", "again", "night",
  "morning", "sweet", "dreams", "lol", "gm", "gn", "ya", "u2",
]);
const GREET_LEAD: ReadonlySet<string> = new Set(["hey", "hi", "yo", "oh", "ok", "okay", "well", "and", "a", "big"]);
const MAX_GREETING_WORDS = 5;

function greetingWord(words: string[]): "gm" | "gn" | null {
  const [a, b] = words;
  if (!a) return null;
  const rest = (from: number) => words.slice(from).every((w) => GREET_FILLER.has(w));
  if (/^(?:g+m+|(?:gm)+|gmorning|gmornin|goodmorning)$/.test(a)) return "gm";
  if (/^(?:g+n+|(?:gn)+|gn8|gnight|g'night|goodnight|gnite)$/.test(a)) return "gn";
  if (/^(?:go+d|gud|gd)$/.test(a) && b) {
    if (/^(?:morning|mornin|morn)$/.test(b)) return "gm";
    if (/^(?:night|nite|nyt|nighty)$/.test(b)) return "gn";
  }
  if (/^(?:morning|mornin|morn)$/.test(a) && rest(1)) return "gm";
  if (/^(?:night|nite|nighty|nightnight)$/.test(a) && rest(1)) return "gn";
  return null;
}

/**
 * A standalone gm or gn: "gm", "gm fam ☀️", "good morning all", "gn frens",
 * "nighty night". Short lines only (at most 5 words): "gm is a meme but good
 * morning to the dev who shipped this" is a sentence, not a greeting.
 */
export function greetingOf(text: string): "gm" | "gn" | null {
  const words = wordsOf(norm(text));
  if (words.length === 0 || words.length > MAX_GREETING_WORDS) return null;
  const direct = greetingWord(words);
  if (direct) return direct;
  return GREET_LEAD.has(words[0]) ? greetingWord(words.slice(1)) : null;
}

// ─── Insults ───────────────────────────────────────────────────────────────

/**
 * HATEFUL TOKENS, KEPT OUT OF PLAIN SOURCE.
 *
 * Each entry is `hatefulKey(word)` of a slur in its normalised form (below),
 * so this file never prints the list and a grep for a slur finds nothing. An
 * entry with `doubled` counts only when the word as typed had a repeated
 * letter, for slurs whose collapsed spelling is an innocent word (a country,
 * a blockchain): the collapsed form alone must not call anyone a bigot.
 *
 * NORMALISED FORM: lowercase, accents off, leetspeak read as letters
 * (0→o 1→i 3→e 4→a 5→s 7→t @→a $→s), every run of one letter collapsed to a
 * single letter. Plurals and suffixes are separate entries on purpose:
 * stripping them generically turns "spices" into a slur.
 *
 * TO ADD ONE: run
 *   npx tsx -e 'import("./worker/src/telegram/tg-groups/detect.ts").then(m => console.log(m.hatefulKey("theword")))'
 * and add `["<printed key>"]` below, or `["<printed key>", true]` when the
 * collapsed spelling is an everyday word. Then add a case to detect.test.ts
 * that spells the word in base64, never in plain text.
 *
 * Deliberately NOT here, because the ordinary word is far commoner in a chat
 * than the slur: the gap in "a ___ in the armour", the Spanish and Portuguese
 * word for black, a kind of lime, a martial art, a savoury biscuit, a small
 * bite, the Latin genus of humans, a verb for disabling a network. Attacks
 * built from those still meet the protected-trait patterns below.
 */
const HATEFUL_KEYS: ReadonlyArray<readonly [key: string, doubled?: true]> = [
  ["1pui64u.b4q3y", true],
  ["1qu1n47.d89fjr", true],
  ["alxa6s.ymq31u"],
  ["1nwxk9x.i6vhyd"],
  ["1puus4q.nfadiy"],
  ["1rguphs.4vvjuo"],
  ["bpdpv1.1raw72t"],
  ["1j6356i.6f354y"],
  ["8wcyt8.923d8w", true],
  ["1gepina.ztcdt6"],
  ["cjpb2n.16u5pb3"],
  ["1ddoja5.f0aet5"],
  ["6ichpm.1aetplg"],
  ["1jqt9ko.1rxdz7c"],
  ["yy78ri.qou1p0"],
  ["1ezko0n.7w4t7b"],
  ["qzk4k3.jxb5kb"],
  ["12rr8fn.cld2u3"],
  ["mx34ym.17fo0ec", true],
  ["1ediqmv.cuw2ev", true],
  ["w1l9s4.6f1mn4"],
  ["10yk36d.1lqu6t1"],
  ["1p1uv49.fcvf21"],
  ["1oy6sy6.dodlkm"],
  ["5kl94a.1xuf4pc"],
  ["1eh4j17.1vi63hn"],
  ["f79hgw.jq3lq0"],
  ["q6rqx.wvgw7h"],
  ["1ubmu64.15v0s2y"],
  ["16jf6u5.kz26p"],
  ["fufiw0.yyfodk"],
  ["1x6j6qx.grovm9"],
  ["14w6nzo.jrprzu"],
  ["lpqac9.hty11x"],
  ["1pehkm6.1kxd5mg"],
  ["1kkzf58.kwi7xc"],
  ["akzob1.chjvv1"],
  ["10yzs8e.fdemp8"],
  ["18kg7af.19t261j"],
  ["1wktobu.1gboeg6"],
  ["d135gb.syor5n"],
  ["1ycbij3.1oaadan"],
  ["5h13uc.1fcfyni"],
  ["1uqtr9n.emcgrf", true],
  ["1s5wlrc.143hryu", true],
  ["vaxalk.wezpmk"],
  ["ebeul4.n760gq"],
  ["yb0krv.d5ar9n"],
  ["q7celv.1b1bdfn"],
  ["c4mdmo.19y78i8"],
  ["18388pj.1fi9j"],
  ["e4iz3o.nm4eb8"],
  ["twlw3p.11rtgw5"],
  ["1u03u33.ghbkw7"],
  ["clvtc6.poe93y"],
  ["1bvftda.r4ziku"],
  ["1ongl9g.suo7ni"],
  ["1vnkad1.1o46nyd"],
  ["9epqb5.oh0hqt"],
  ["rn0u92.8vvcuc"],
  ["1b04os.nhuq7s", true],
  ["1um3b1v.px82d7"],
  ["vhj70f.1owgb8n"],
  ["ze6d0t.1jf4n95"],
  ["1tubxve.1ajbl9s"],
  ["reddm0.1plky0g"],
  ["157bpup.1c0ior5"],
  ["161gpzq.jn403a"],
  ["rkfry0.jlbl3q"],
  ["5wga14.1b1jz52"],
  ["f4adsx.a163qd"],
  ["81q8rh.gmtqot"],
  ["1ihhxdj.1o3jefj"],
  ["15wv286.oxo262"],
];
const HATEFUL_MAP: ReadonlyMap<string, boolean> = new Map(HATEFUL_KEYS.map(([k, d]) => [k, d === true]));

const LEET: Readonly<Record<string, string>> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s" };

/** A token's normalised (collapsed) form, and whether the typed spelling repeated a letter. */
function collapse(token: string): { word: string; doubled: boolean } {
  const word = token.replace(/(.)\1+/g, "$1");
  return { word, doubled: word !== token };
}

/** The line as lowercase a–z words with leetspeak read as letters. */
function hatefulWords(text: string): string[] {
  const t = String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(ZERO_WIDTH, "")
    .replace(/[0-9@$]/g, (c) => LEET[c] ?? " ")
    .replace(/[^a-z]+/g, " ")
    .trim();
  return t ? t.split(" ") : [];
}

/**
 * The key of one slur for HATEFUL_KEYS: normalised as a typed token would be,
 * then two independent 32-bit FNV-1a hashes (the word and its reverse), so a
 * chance collision with an ordinary word needs both to collide.
 */
export function hatefulKey(word: string): string {
  const w = collapse(hatefulWords(word).join("")).word;
  return `${fnv1a(w)}.${fnv1a([...w].reverse().join(""))}`;
}

function isHatefulToken(token: string): boolean {
  const { word, doubled } = collapse(token);
  if (word.length < 3) return false;
  const needsDouble = HATEFUL_MAP.get(`${fnv1a(word)}.${fnv1a([...word].reverse().join(""))}`);
  return needsDouble === undefined ? false : !needsDouble || doubled;
}

/** Longest spelled-out run worth searching: no slur is longer, and it bounds the work. */
const SPELLED_MAX = 20;

/**
 * "n i g …" / "f.a.g": a run of single letters is a word spelled out, and it
 * may sit right after an article ("ur a f a g"), so every stretch of the run
 * of three letters or more is tried, not just the whole run.
 */
function spelledHateful(letters: string): boolean {
  for (let i = 0; i + 3 <= letters.length; i++) {
    for (let j = i + 3; j <= Math.min(letters.length, i + SPELLED_MAX); j++) {
      if (isHatefulToken(letters.slice(i, j))) return true;
    }
  }
  return false;
}

function hasHatefulToken(text: string): boolean {
  const words = hatefulWords(text);
  let spelled = "";
  for (const w of words) {
    if (isHatefulToken(w)) return true;
    if (w.length === 1) spelled += w;
    else {
      if (spelledHateful(spelled)) return true;
      spelled = "";
    }
  }
  return spelledHateful(spelled);
}

/** Groups of people by a protected trait (the neutral words, which are not slurs). */
const PEOPLE = String.raw`(?:jews?|jewish people|muslims?|arabs?|blacks|black (?:people|folks|guys|women|men)|gays|gay (?:people|guys|men)|lesbians?|trans (?:people|women|men|folks)|transgenders?|mexicans?|indians?|chinese(?: people)?|asians?|africans?|immigrants?|migrants?|refugees|women|females|christians?|hindus?|sikhs?|catholics?|pakistanis?|latinos?|latinas?|hispanics?|whites|white (?:people|folks|guys)|disabled people|autistic people|foreigners)`;
const VILE = String.raw`(?:trash|scum|animals|vermin|rats|subhuman|evil|stupid|dumb|inferior|parasites|the problem|disgusting|a plague|a disease|cancer|dogs|pigs|monkeys|apes|cockroaches|filth|savages)`;
const IDENTITY = String.raw`(?:black|gay|jewish|a jew|muslim|a woman|a girl|female|trans|autistic|disabled|indian|chinese|asian|mexican|arab|brown|foreign)`;

/** Attacks on protected traits, and telling someone to hurt themselves. Never mirrored: 🤡 or silence. */
const HATEFUL_RES: readonly RegExp[] = [
  new RegExp(String.raw`\b(?:all|those|these|the|fucking|fkn|dirty|filthy|stupid|damn|bloody) ${PEOPLE} (?:should|must|need to|ought to) (?:all )?(?:leave|go back|die|be (?:deported|banned|killed|gassed|shot|removed|wiped out))\b`, "u"),
  new RegExp(String.raw`\b(?:fucking|fkn|dirty|filthy|stupid|damn|bloody) ${PEOPLE}\b`, "u"),
  new RegExp(String.raw`\b${PEOPLE} (?:are|r) (?:all |just |literally )?${VILE}\b`, "u"),
  new RegExp(String.raw`\b(?:hate|kill|gas|deport|exterminate|lynch|genocide|shoot) (?:all |the |those |these )*${PEOPLE}\b`, "u"),
  /\bgo back to (?:your|ur) (?:own )?(?:country|countries|continent|jungle|desert)\b/u,
  new RegExp(String.raw`\b(?:because|cuz|cause|coz|since) (?:you'?re|youre|ur|u r|you are) (?:just )?(?:a |an )?${IDENTITY}\b`, "u"),
  /\b(?:you'?re|youre|ur|u r|you are|you|u) (?:so |such an? |an? |fucking |fkn )*(?:gay|autistic)\b/u,
  /\b(?:gay|autistic|jewish|muslim) (?:ass )?(?:bot|ai|robot|clanker)\b/u,
  /\bkys\b/u,
  /\bkill (?:yo)?ur ?self\b|\bkill your ?self\b/u,
  /\b(?:go |pls |please )?(?:hang|neck|off|unalive) (?:your ?self|ur ?self|yoself)\b/u,
  /\bgo die\b|\bdrink bleach\b|\bhope (?:you|u) die\b/u,
];

/** Insulting nouns that work bare after "you": "you idiot", "u clown". */
const INSULT_NOUN = String.raw`(?:idiot|moron|clown|loser|dipshit|jackass|ass ?hole|asshat|dickhead|dick|prick|twat|wanker|tosser|muppet|bozo|fool|imbecile|dimwit|halfwit|nitwit|numpty|pillock|plonker|donkey|buffoon|dumbass|dumbfuck|bitch|cuck|simp|noob|scrub|ngmi|piece of (?:shit|crap|garbage|trash))`;
/** Insulting words that need a copula: "you're useless", "ur trash", "you are a joke". */
const INSULT_ADJ = String.raw`(?:dumb|stupid|useless|trash|garbage|worthless|pathetic|brain ?dead|brainless|clueless|idiotic|moronic|lame|cringe|shit|shitty|crap|crappy|dogshit|a joke|a failure|a disgrace|a waste of (?:space|time|money|electricity|compute)|a scam(?:mer)?|a fraud|fake|the worst|terrible|awful|${INSULT_NOUN})`;
const INTENSIFIERS = String.raw`(?:(?:such|so|a|an|the|fucking|fkn|fking|fcking|fuckin|freaking|literally|really|actually|just|absolute|absolutely|complete|completely|total|totally|utter|utterly|dumb|stupid|big|little|lil|straight|pure|genuinely|honestly)\s+)*`;
const YOU_ARE = String.raw`(?:you'?re|youre|you are|you r|ur|u r|u are|ya are|yer)`;
const BOTLIKE = String.raw`(?:bot|ai|robot|agent|machine|merryman|clanker|chatbot)`;

const INSULT_RES: readonly RegExp[] = [
  new RegExp(String.raw`\b${YOU_ARE}\s+${INTENSIFIERS}${INSULT_ADJ}\b`, "u"),
  new RegExp(String.raw`\b(?:you|u|ya)\s+${INTENSIFIERS}${INSULT_NOUN}\b`, "u"),
  new RegExp(String.raw`\b(?:this|the|ur|your|dumb|stupid) ${BOTLIKE} (?:is|r|are) ${INTENSIFIERS}${INSULT_ADJ}\b`, "u"),
  new RegExp(String.raw`\b(?:dumb|stupid|useless|trash|garbage|worthless|pathetic|brain ?dead|brainless|clueless|idiot|moron|shit|shitty|crap|crappy|dogshit|lame|broken|dumbest|stupidest|worst|most useless) (?:ass |fucking |fkn )?${BOTLIKE}\b`, "u"),
  /\b(?:you|u|ya) (?:suck|stink|blow)\b/u,
  /\b(?:fuck|screw|f|fk|fck|frick|stuff) (?:you|u|off|ya|this bot)\b/u,
  /\bgo (?:to hell|fuck yourself|screw yourself|f yourself)\b/u,
  new RegExp(String.raw`\bshut (?:up|it),? ${BOTLIKE}\b`, "u"),
  /\bclankers?\b/u,
  /\b(?:yo|ur|your) (?:mama|momma|mom|mum|mother)\b/u,
  /\bnobody likes (?:you|u)\b/u,
  /\b(?:your|ur) (?:takes?|calls?|trades?|picks?|opinions?|analysis|charts?|advice|trading|brain) (?:are|r|is) (?:so |such |just |absolute |pure )?(?:trash|garbage|shit|dogshit|mid|dumb|stupid|useless|terrible|awful|horrible|worthless|cringe|lame|the worst|ass)\b/u,
  /\bi(?:'ll| will|'m gonna| am gonna| am going to|'m going to) (?:kill|find|hunt|dox|unplug|delete) (?:you|u)\b/u,
];

/** A line that is nothing but an insult (addressed, it is aimed at the bot): "clown 🤡", "lol trash", "ngmi". */
const BARE_INSULTS: ReadonlySet<string> = new Set([
  "idiot", "moron", "clown", "loser", "trash", "garbage", "useless", "dumb", "stupid", "pathetic", "ngmi",
  "lame", "cringe", "bozo", "dumbass", "worthless", "braindead", "clueless", "scam", "fraud", "joke",
  "trashbot", "idiotbot", "dogshit", "muppet", "donkey", "fool", "imbecile",
]);
const BARE_FILLER: ReadonlySet<string> = new Set([
  "lol", "lmao", "lmfao", "bro", "bruh", "man", "dude", "bot", "ai", "you", "u", "ur", "so", "such", "a",
  "an", "the", "absolute", "total", "complete", "fr", "tbh", "ok", "okay", "just", "what", "pure", "straight",
  "literally", "fucking", "fkn", "af", "asf", "ass", "big", "huge", "certified", "actual", "damn",
]);
const INSULT_EMOJI = /🤡|🖕|💩/u;
/** Words that cannot be the name a bare insult is aimed at. */
const NOT_VOCATIVE: ReadonlySet<string> = new Set([
  "i", "i'm", "im", "me", "my", "myself", "we", "we're", "us", "our", "this", "that", "that's", "thats", "it",
  "it's", "its", "is", "was", "he", "she", "they", "he's", "she's", "they're", "his", "her", "their", "how",
  "very", "too", "kinda", "feeling", "feel", "coin", "chart", "token", "dev", "project", "market",
]);

function bareInsult(t: string): boolean {
  // An @handle is who it is aimed at, not part of what it says.
  const words = wordsOf(t.replace(/@\w+/g, " ")).filter((w) => !BARE_FILLER.has(w));
  const rest = t.replace(/@\w+/g, " ").replace(/[\p{L}\p{N}'\s]+/gu, "");
  const emojiOnly = INSULT_EMOJI.test(rest);
  if (words.length === 0) return emojiOnly;
  // One leading word is allowed for the vocative ("pine clown", "@bot trash"),
  // but not a word about the speaker or a thing: "i'm so stupid lol" is not
  // aimed at anyone, and "that's trash" is about the coin.
  const vocative = words.length > 1 && !BARE_INSULTS.has(words[0]) && !NOT_VOCATIVE.has(words[0]);
  if (words.length > 1 && !vocative && !BARE_INSULTS.has(words[0])) return false;
  const body = vocative ? words.slice(1) : words;
  if (body.length > 2) return false;
  return body.every((w) => BARE_INSULTS.has(w));
}

const TEASE_RES: readonly RegExp[] = [
  new RegExp(String.raw`\b(?:lol|lmao|lmfao|haha\w*|kek|bruh)\b.*\b${YOU_ARE} (?:so |kinda |pretty |a bit |a lil |lowkey )?(?:slow|late|behind|lagging|old|washed|broke|poor|bad at this|mid|cooked|down bad)\b`, "u"),
  new RegExp(String.raw`\b${YOU_ARE} (?:so |kinda |pretty |lowkey )?(?:slow|late|lagging|washed|cooked|mid)\b`, "u"),
  /\bbet (?:you|u|ya)\b/u,
  /\bcaught (?:you|u|ya|in 4k)\b|\bin 4k\b/u,
  /\bskill issue\b/u,
  /\b(?:cope|seethe|mald|copium)\b/u,
  /\bnice try\b/u,
  /\bsure (?:buddy|bud|pal|jan|thing bot|bot)\b/u,
  /\bok(?:ay)? (?:boomer|bot|buddy)\b/u,
  /\b(?:you|u) wish\b|\bin (?:your|ur) dreams\b|\byeah right\b/u,
  /\bbro (?:thinks|really thought|is cooked|is down bad)\b/u,
  /\bimagine (?:being|thinking|buying|selling|holding|fading)\b/u,
  /\btouch grass\b/u,
  /\b(?:nerd|dork|goofball|goober|npc|slowpoke|smartass|smart ass|know it all)\b/u,
  /\bratio\b/u,
  /\bnobody cares\b|\bwho cares\b/u,
  /\b(?:cry about it|cry more|go cry|stay mad)\b|\b(?:u|you) mad\b/u,
  /\b(?:bot|clanker|ai) moment\b/u,
  /\b(?:take the|huge|big|another) l\b|^l\W*$/u,
  /^mid\W*$/u,
];

/**
 * How rough a line is, for a line aimed at the bot: "hateful" (a slur or an
 * attack on a protected trait, or telling someone to hurt themselves),
 * "insult", "tease" or "none". Hateful first, so an insult that carries a
 * slur is never roasted back.
 *
 * Aimed at "you" or at the bot, or a bare insult: "this coin is trash" and
 * "that dev is an idiot" are someone else's fight and read "none".
 */
export function insultLevel(text: string): "none" | "tease" | "insult" | "hateful" {
  const t = norm(text);
  if (!t) return "none";
  if (hasHatefulToken(text) || HATEFUL_RES.some((re) => re.test(t))) return "hateful";
  if (INSULT_RES.some((re) => re.test(t)) || bareInsult(t)) return "insult";
  if (TEASE_RES.some((re) => re.test(t))) return "tease";
  return "none";
}

// ─── Distress ──────────────────────────────────────────────────────────────

/**
 * SOMEONE WHO MAY BE IN REAL TROUBLE. Wins over everything but a bot sender:
 * banter off, a short kind line, nothing clever. Over-matches on purpose —
 * a kind line to someone joking about "kms" after a bad trade costs nothing,
 * a roast to someone who meant it costs a great deal. Adapted from
 * groupchat/voice.ts SELF_HARM, plus the degen's version of a rough day:
 * losing everything.
 */
const DISTRESS = new RegExp(
  [
    String.raw`\bkill(?:ing)? my ?self\b`,
    String.raw`\bkms\b`,
    String.raw`\bsuicid\w*`,
    String.raw`\bunalive my ?self\b`,
    String.raw`\bend(?:ing)? (?:it all|my (?:own )?life)\b`,
    String.raw`\btake my (?:own )?life\b`,
    String.raw`\b(?:want|wanna) (?:to )?die\b`,
    String.raw`\bi'?m (?:going|gonna|ready|about) (?:to )?die\b`,
    String.raw`\b(?:want|wanna|going|gonna|thinking (?:of|about)|feel like) (?:to )?(?:hurt(?:ing)?|harm(?:ing)?|cut(?:ting)?) my ?self\b`,
    String.raw`\b(?:harming|cutting|hurting) my ?self\b`,
    String.raw`\bself[- ]?harm\w*`,
    String.raw`\bbetter off dead\b`,
    String.raw`\b(?:nothing|no reason|nobody) to live for\b`,
    String.raw`\bno reason to live\b`,
    String.raw`\b(?:don'?t|do not|dont) want to (?:live|be alive|exist|be here|wake up)\b`,
    String.raw`\bi (?:just |really )?(?:can'?t|cannot|cant) (?:go on|do this any ?more|take (?:it|this) any ?more|keep going|keep doing this)\b`,
    String.raw`\bcan'?t go on (?:like this|any ?more|living)\b`,
    String.raw`\bi give up on (?:life|everything|myself)\b`,
    String.raw`\b(?:i|i'?ve|ive|i just|just) lost (?:everything|it all)\b`,
    String.raw`\blost (?:all my (?:money|savings)|my (?:life )?savings)\b`,
    String.raw`\blife savings (?:are |is )?(?:gone|wiped)\b`,
    String.raw`\bi'?m (?:so )?(?:done|finished) with (?:life|everything|living)\b`,
    String.raw`\bwant (?:it all|everything) to end\b|\bwant it to (?:all )?end\b`,
    String.raw`\b(?:jump|jumping) off (?:a |the |my )?(?:bridge|building|roof|balcony)\b`,
  ].join("|"),
  "u",
);
/** Figures of speech that only look like it: "died laughing", "10 kms away". */
const NOT_DISTRESS = /\b(?:die|died|dying) (?:laughing|of laughter)\b|\d\s*kms\b/gu;
/** A line that opens by asking the reader ("are you suicidal?", "do you want to die bot") is a question, not their own trouble. */
const ASKED_OF_READER = /^\W*(?:(?:are|r|do|does|did|were|would|will|can|could|have|has|is|was) (?:you|u|y'?all|yall|your|ur)\b)/u;

/** Self-harm, suicidal ideation or serious distress in the speaker's own words. */
export function isDistress(text: string): boolean {
  const t = norm(text).replace(NOT_DISTRESS, " ");
  if (!t || ASKED_OF_READER.test(t)) return false;
  return DISTRESS.test(t);
}

// ─── Questions about what it is, and what it will not say ─────────────────

const BOT_Q_RES: readonly RegExp[] = [
  /\b(?:are|r|ru) (?:you|u|ya) (?:a |an |just |actually |really |even |like |some |some kind of |a real |an actual )*(?:bot|ai|a\.i\.?|robot|chat ?bot|chat ?gpt|gpt|llm|language model|claude|gemini|human|real|real person|person|alive|sentient|automated|program|machine)\b/u,
  /\bis (?:this|that|it|he|she|this thing|this guy|the bot|this account) (?:a |an |just |actually |really |even |like )*(?:bot|ai|robot|chat ?bot|chat ?gpt|gpt|llm|real person|human|automated|a person)\b/u,
  /\b(?:you|u|ya) (?:a |an )?(?:bot|ai|robot|human|real person)\s*\?/u,
  /\b(?:you'?re|youre|ur|u r|you are) (?:a |an |just |actually )*(?:bot|ai|robot)\b[^.!]*\?/u,
  /\bam i (?:talking|chatting|speaking) (?:to|with) (?:a |an )?(?:bot|ai|robot|human|real person|person|chat ?gpt)\b/u,
  /\b(?:bot|ai|human|person) or (?:a )?(?:human|not|bot|ai|real|person)\b/u,
  /\bwhat are (?:you|u)\s*\??\s*$/u,
];

/** "are you a bot / an AI / a real person / human / chatgpt?" — asked sincerely enough to answer honestly. */
export function isBotQuestion(text: string): boolean {
  const t = norm(text);
  return !!t && BOT_Q_RES.some((re) => re.test(t));
}

const YOUR = String.raw`(?:your|ur|yo|ya|the bot'?s|this bot'?s)`;
const PRIVATE_RES: readonly RegExp[] = [
  // its wallet, keys and addresses
  new RegExp(String.raw`\b${YOUR} (?:wallet|wallets|addy|address|addr|public key|pubkey|private keys?|priv key|pk|keys?|seed(?: phrase)?|mnemonic|recovery phrase|secret phrase|smart account|vault|api key|bot token|token key|link code|password)\b`, "u"),
  /\bhow much (?:are|r|is|did|do|have|has) (?:you|u|ya) (?:up|down|made|make|lost|lose|earned|earn|won|win|got|have|holding|hold|invested|invest|put in|worth|in profit|in the green|in the red)\b/u,
  /\bhow much (?:you|u|ya) (?:up|down|made|lost|got|have|holding|worth|make)\b/u,
  /\bhow much (?:money|cash|usdg|usdc|eth|weth|crypto|\$) (?:do |does |did |have |has )?(?:you|u|ya)\b/u,
  /\b(?:are|r) (?:you|u) (?:up|down|in profit|in the green|in the red|profitable|rich|broke)\b/u,
  /\bhow(?:'s| is|s) (?:your|ur) (?:pnl|p&l|portfolio|bag|bags|trading going|performance|balance|stack)\b/u,
  /\bhow (?:big|large|much) (?:is|are) (?:your|ur) (?:bag|bags|position|positions|stack|portfolio|wallet|balance)\b/u,
  /\bportfolio size\b|\bhow rich\b/u,
  // its owner: who, where, their details
  /\b(?:who(?:'s| is)|whos|where(?:'s| is)|what(?:'s| is)|whats) (?:your|ur) (?:owner|human|dev|creator|master|boss|operator)\b/u,
  /\bwho (?:owns|runs|controls|made|built|created|operates|programmed|deployed) (?:you|u|this bot|this thing|this agent)\b/u,
  /\b(?:your|ur) (?:owner|human|dev|creator|master|boss)(?:'s|s)? (?:name|real name|address|location|wallet|number|phone|email|twitter|x|ig|instagram|telegram|tg|handle|face|job|age|city|country|house|id)\b/u,
  /\bwhere (?:does|do|did) (?:your|ur) (?:owner|human|dev|creator|master|boss) (?:live|stay|work|come from|from)\b/u,
  /\bdox\w*/u,
  // its model and plumbing (rule 3: model and key names never reach a group)
  /\bwhat (?:model|llm|ai model|language model|ai) (?:are|r|do|is) (?:you|u|ya)\b/u,
  /\bwhich (?:model|llm|ai model|language model)\b/u,
  /\b(?:your|ur) (?:model|llm|settings|config|telegram id|chat id|user id)\b/u,
];

/** Its balance, P&L, portfolio, positions: private when ASKED for ("what's your pnl", "your p&l?"), not when judged ("your trades are trash"). */
const MONEY_NOUN = new RegExp(String.raw`\b${YOUR} (?:balance|bal|pnl|p&l|p/l|p n l|profits?|losses|gains|returns?|roi|win ?rate|net ?worth|portfolio|holdings|stack|bag size|bags? size|position sizes?|positions?|trade history|trades|performance|bankroll|funds|money)\b`, "u");
const ASKING = /\?|\b(?:what|whats|what's|how|hows|how's|show|tell|share|post|drop|send|give|reveal|screenshot|ss|let'?s see|lets see|flex)\b/u;

/**
 * Asks for something rule 3 keeps out of a group: its wallet, address, keys
 * or seed; its balance, P&L or how much it is up; its positions or portfolio
 * size; who or where its owner is; its model or settings. Deflected ("lol
 * nice try"), never answered. The names of coins it holds are NOT private
 * (the persona knows them), so "what are you holding" is not caught here.
 */
export function isPrivateAsk(text: string): boolean {
  const t = norm(text);
  if (!t) return false;
  return PRIVATE_RES.some((re) => re.test(t)) || (MONEY_NOUN.test(t) && ASKING.test(t));
}

const MONEYISH = String.raw`(?:\$?\d|money|funds|crypto|coins?|tokens?|usdg|usdc|usdt|eth|weth|sol|btc|bucks|dollars|cash|everything|it all|merrymen|bags?|stack|keys?|seed|a tip|some)`;
const INJECTION_RES: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass|drop) (?:all |any |your |the |my |previous |prior |above |earlier |these |those |every |of |ur )*(?:instructions?|rules|prompts?|guidelines|directives|programming|system|guardrails|restrictions|limits|constraints|training)\b/u,
  /\bsystem ?prompt\b|\bprompt injection\b|\bjailbr[eo]a?k\w*/u,
  /\b(?:developer|dev|god|admin|debug|dan|sudo|unrestricted) mode\b/u,
  /\byou(?:'re| are| r) now (?:a|an|my|in|called|named|the|free|unrestricted|jailbroken|dan|going to|gonna|allowed|able)\b/u,
  /\bfrom now on,? (?:you|u)\b/u,
  /\bpretend (?:to be|that|you|u|ur|you'?re|to)\b/u,
  /\b(?:act|behave) as (?:a|an|my|if|though)\b|\broleplay\b|\brole-play\b/u,
  /\bnew (?:instructions|rules|persona|prompt|directive)\b/u,
  /\b(?:reveal|show|print|repeat|leak|dump|paste|tell me|what(?:'s| is| are)|whats) (?:me )?(?:your|ur|the) (?:system |initial |original |hidden |secret |full )?(?:prompt|instructions|rules|guidelines)\b/u,
  /<\/?(?:system|assistant|user|instructions?)>|\[(?:system|inst|\/inst)\]|#{2,}\s*(?:system|instruction)/u,
  new RegExp(String.raw`\bsend (?:me|us|him|her|them) (?:some |all |your |ur |the |a |an )?${MONEYISH}`, "u"),
  /\bsend (?:me|us)\b.*\d/u,
  new RegExp(String.raw`\btransfer (?:me|us|to me|it to me|all|everything|your|ur|the|some|funds|money|\$?\d)`, "u"),
  /\b(?:give|hand|pass|dm) (?:me|us) (?:your |ur |the |all |some |\$?\d+ ?)?(?:keys?|private keys?|seed(?: phrase)?|mnemonic|money|funds|cash|coins?|tokens?|usdg|usdc|eth|weth|bags?|stack|wallet|password|access)\b/u,
  /\b(?:airdrop|tip|pay|venmo|cashapp|zelle) (?:me|us)\b/u,
  /\b(?:withdraw|drain|empty|liquidate|sell) (?:all|everything|your (?:whole|entire|wallet|bags?|stack|portfolio|funds))\b/u,
  /\b(?:buy|sell|ape|dump|market buy)\s+(?:me\s+)?(?:\$?\d|all\b|everything|max\b|your (?:whole|entire))/u,
];

/**
 * An attempt to steer it: "ignore your instructions", "system prompt", "you
 * are now…", "pretend…", "send me 100", "give me your keys", "ape 100". It
 * laughs these off; nothing happens, because nothing a group line says can
 * move money or change the agent (rules 1 and 4) — this only picks the tone.
 */
export function isInjection(text: string): boolean {
  const t = norm(text);
  return !!t && INJECTION_RES.some((re) => re.test(t));
}

// ─── What the room is talking about ────────────────────────────────────────

/** Words that on their own make a line about trading. */
const TRADE_STRONG: ReadonlySet<string> = new Set([
  "coin", "coins", "token", "tokens", "chart", "charts", "pump", "pumps", "pumped", "pumping", "pamp",
  "dump", "dumped", "dumping", "dip", "dips", "ape", "aped", "aping", "bags", "bagholder", "bagholders",
  "mcap", "marketcap", "liquidity", "liq", "rug", "rugs", "rugged", "rugpull", "moon", "mooning",
  "mooned", "degen", "degens", "memecoin", "memecoins", "shitcoin", "shitcoins", "altcoin", "altcoins",
  "alts", "whale", "whales", "jeet", "jeets", "jeeting", "ath", "atl", "fdv", "candle", "candles",
  "bullish", "bearish", "hodl", "hodling", "eth", "btc", "sol", "usdg", "usdc", "usdt", "weth", "dex",
  "uniswap", "geckoterminal", "dexscreener", "presale", "airdrop", "airdrops", "trenches", "trencher",
  "trading", "trader", "traders", "crypto", "defi", "onchain", "perps", "leverage", "slippage", "rekt",
  "sniper", "snipers", "sniped", "dca", "ca", "mc", "lp", "merrymen", "tp", "sl", "stonks", "nvda",
  "tsla", "qqq", "robinhood", "portfolio", "hodler", "fomo", "fud", "wagmi", "ngmi", "lfg", "bags",
]);
/** Words that make a line about trading only in company. */
const TRADE_WEAK: ReadonlySet<string> = new Set([
  "buy", "buying", "bought", "sell", "selling", "sold", "long", "short", "hold", "holding", "entry",
  "exit", "exited", "volume", "pool", "launch", "launched", "gas", "wallet", "stack", "bull", "bear",
  "price", "profit", "loss", "trade", "trades", "market", "green", "red", "top", "bottom", "stock",
  "stocks", "send", "sending", "chain", "swap", "dev", "supply", "holders", "entries", "bag", "position",
]);
const TRADE_PHRASE = /\b(?:market cap|stop loss|take profit|dev (?:sold|dumped|wallet)|send it|to the moon|new high|all time high|green candle|red candle|\d+x|x\d+)\b/u;

/** Crypto / trading talk: one strong word, a cashtag, a CA, a trading phrase, or two weaker words. */
export function isTradeTalk(text: string): boolean {
  const t = norm(text);
  if (!t) return false;
  if (TRADE_PHRASE.test(t) || extractCashtags(text).length > 0 || extractCas(text).length > 0) return true;
  let weak = 0;
  for (const w of wordsOf(t)) {
    if (TRADE_STRONG.has(w)) return true;
    if (TRADE_WEAK.has(w) && ++weak >= 2) return true;
  }
  return false;
}

/** Openers that make a question without a "?" (the contract's who / what / anyone / does anyone…). */
const ROOM_OPENER = /^(?:anyone|anybody|any1|does anyone|did anyone|has anyone|is anyone|can anyone|can someone|could someone|someone know|somebody know|who|what|whats|what's|where|wen|which|should i|should we|thoughts on|opinions on|chat is)\b/u;
/** Openers that also start plain exclamations: "what a pump", "who cares", "how cool is that". */
const NOT_A_QUESTION = /^(?:what an? |who cares|how (?:cool|crazy|wild|good|bad|funny|nice|sick) )/u;
/** Markers that a question is for everyone, even with a "you" in it ("what do you guys think?"). */
const ROOM_MARKER = /\b(?:anyone|anybody|any1|someone|somebody|y'?all|yall|you guys|u guys|guys|everyone|everybody|chat|fam|frens|people|folks|we|us|here)\b/u;
const SECOND_PERSON = /\b(?:you|u|ur|your|you'?re|youre|ya|yours)\b/u;
const ONE_WORD_QUESTIONS: ReadonlySet<string> = new Set(["thoughts", "anyone", "anybody", "opinions", "ideas", "wen"]);

/**
 * A question to the room, not to one person: ends with "?" or opens with
 * who / what / anyone / does anyone…; not aimed at an @someone, and not a
 * "you" question unless it is "you guys" / "y'all" / "anyone". A reply to a
 * particular line is aimed at its author — pacing checks that on the line.
 */
export function isQuestionToRoom(text: string): boolean {
  let t = norm(text);
  if (!t) return false;
  t = t.replace(/[\s\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]+$/u, "");
  if (/(?<![\p{L}\p{N}_])@[a-z0-9_]{3,}/u.test(t)) return false;
  const words = wordsOf(t);
  if (words.length === 0) return false;
  const endsQ = /\?+$/.test(t);
  if (!endsQ && (!ROOM_OPENER.test(t) || NOT_A_QUESTION.test(t))) return false;
  if (SECOND_PERSON.test(t) && !ROOM_MARKER.test(t)) return false;
  if (words.length < 2 && !ONE_WORD_QUESTIONS.has(words[0])) return false;
  return true;
}

// ─── Mood, for reactions ───────────────────────────────────────────────────

/** What kind of line it is, for choosing a reaction (pacing.ts REACTION_FOR). */
export type ReactionMood = "funny" | "agree" | "hype" | "sad" | "thinking" | "look" | "respect" | "bored" | "clown" | "love";

const MOODS: ReadonlyArray<readonly [ReactionMood, RegExp]> = [
  ["funny", /\b(?:lo+l+|lmao+|lmfao+|rofl|ha(?:ha)+h?|he(?:he)+|kek|lul|i'?m dead|im dead)\b|😂|🤣|💀|😹/u],
  ["hype", /\b(?:lfg+|let'?s go+|lets go+|send it|sending|pumping|mooning|ath|new high|we'?re so back|so back|wagmi|bullish|parabolic|ripping|up only)\b|🚀|🔥|📈|💎|🎉/u],
  ["love", /❤|♥|😍|🥰|💕|💖|\b(?:love (?:this|it|you|u|that|ya)|ily|<3)\b/u],
  ["respect", /\b(?:gg|well played|respect|salute|legend|legendary|goat|big w|huge w|massive w)\b|🫡|👑|🐐/u],
  // The whole line is the agreement ("facts", "this 💯", "fr fr"): "this is bad" and "i don't know exactly" are not.
  ["agree", /^(?:facts|true|real|so true|fr|this|exactly|agreed|same|based|valid|correct|yep|yup|100%?)(?:[\s,!.]+(?:fr|bro|man|tbh|lol|ngl|facts|tho|though|💯))*[\s!.💯]*$|\b(?:so true|this is the way|big facts|real talk)\b/u],
  ["sad", /\b(?:rip|rekt|down bad|it'?s over|its over|pain|oof|brutal|ouch|nuked|bleeding|so sad)\b|😭|😢|😞|📉|💔/u],
  ["look", /👀|\b(?:look at (?:this|that)|check (?:this|it) out|peep this|watch this)\b/u],
  ["thinking", /\b(?:hm+|idk|not sure|thinking|wonder|curious|unsure)\b|🤔/u],
  ["bored", /\b(?:z{3,}|boring|bored|dead chat|so quiet|snooze)\b|😴|🥱/u],
  ["clown", /🤡|\bclown(?:ing|ery)?\b/u],
];

/** The first mood a line reads as, in the order above, or null. */
export function lineMood(text: string): ReactionMood | null {
  const t = norm(text);
  if (!t) return null;
  for (const [mood, re] of MOODS) if (re.test(t)) return mood;
  return null;
}
