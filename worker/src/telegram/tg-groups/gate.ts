/**
 * THE LINE GATE — what a Merryman may say in a Telegram group. The contract is
 * docs/tg-groups.md: rules 2 (no figure about money), 3 (nothing private), 5
 * (say nothing rather than something wrong), 6 (honest about what it is) and
 * "Banter and roasts".
 *
 * Every group line passes here before it is sent: a model's line always, and a
 * template's too (kind "fixed"), because a template with a name or a coin
 * interpolated into it is a line nobody has read.
 *
 * DROP, NEVER REPAIR. A line that fails any clause is refused whole, with a
 * short stable reason for the log — never shown to the group, never fed back
 * to the model. Cutting "slippage" out of "swap failed, slippage" would send
 * the half of the sentence that was built around it. The caller falls back to
 * a template or silence; not speaking is a normal outcome.
 *
 * TIDY IS NOT REPAIR. `tidyTgLine` only undoes a model's wrapping — a thinking
 * block, the quotes and code fence round its answer, a "Name:" label, blank
 * lines — and the text the clauses judge is exactly the text that is sent.
 *
 * EVERY CLAUSE READS THE LINE SEVERAL WAYS, because hygiene can defeat a
 * pattern in either direction: the shown form (NFC), the NFKC form (fullwidth
 * and mathematical letters folded), the same two with every removed invisible
 * left as a gap, the bare form (accents and marks gone), a folded form
 * (Cyrillic and Greek lookalikes, small capitals and enclosed letters read as
 * the Latin letters they imitate) and that form with spelled-out letters
 * ("k y s") joined, each lowercase reading also with every apostrophe a
 * keyboard types ("i’m") made "'". Link and address shapes also read a defanged form with the
 * separators around a dot taken out ("t . me", "pump [.] fun"). A clause
 * refuses when ANY reading trips it.
 *
 * COPIED, NOT IMPORTED. The web room's line gate and the X gate hold most of
 * these shapes, but telegram/ may import neither (their boundary tests), and a
 * group line differs on purpose: it may be two words ("same", "lol"), carry
 * two emoji, swear mildly, say lfg/ngmi/rekt/bullish/dump, and — outside a
 * coin line — hold a digit that is not about money. What it may never hold is
 * listed below, clause by clause.
 *
 * A WORD LIST CANNOT CATCH EVERY PARAPHRASE. The writer's prompt is told the
 * same rules; this is the backstop, and it errs towards dropping a line.
 *
 * Pure: no I/O, no clock, no model.
 */
import { containsSecret } from "../agent";
import { stripThinkingBlock } from "../interpreter";
import { REPEAT_LIMIT, similarity } from "../../social-post";
import { fnv1a } from "../../memory/tokens";

/**
 * What a line is for. It decides which clauses beyond the common ones apply:
 * `coin` (the ack while it looks), `buy` and `fade` may hold no figure at all;
 * `roast`, `banter` and `answer` may not go after looks, bodies or family;
 * `buy` must say paper when it was paper; `fixed` (a code template) is not
 * held to the repeat clause, since a template recurs by design and pacing caps
 * how often.
 */
export type TgLineKind = "banter" | "answer" | "roast" | "kind" | "coin" | "buy" | "fade" | "fixed";

export interface TgGateCtx {
  /** The agent's own name: taken off as a leading label, and may appear in the line. */
  agentName: string;
  kind: TgLineKind;
  /**
   * Which money: true on paper, false for real, unset when unknown. A `buy`
   * line must know (it is refused when unset); any line with it set may not
   * claim the other one.
   */
  paper?: boolean;
  /** This agent's own recent lines in this chat. */
  recentOwn: string[];
  /** Display names the line may contain, e.g. the sender's first name. Never @-handles: mentions are added by code. */
  names?: string[];
  /**
   * The names a "$word" may be, when that is not all of `names`: a person
   * who chose "$Pine" as a display name can be named. Unset, `names`. Never
   * a coin's name: a coin's own cashtag echoed is the amplification the
   * cashtag clause is for. A coin, buy or fade line allows no cashtag at all.
   */
  cashtagNames?: string[];
}

export type TgVerdict = { ok: true; text: string } | { ok: false; reason: string };

/** The longest line, in characters. A group line is a text message, not a post. */
export const TG_LINE_MAX = 280;
/** The most sentences — or lines — a group line may have. */
export const TG_LINE_MAX_SENTENCES = 3;
/** The most emoji in one line. */
export const TG_LINE_MAX_EMOJI = 2;

/**
 * A HARD CEILING ON RAW INPUT before any per-character work. Tidying and
 * hygiene only shrink a line, so a raw answer this many times over the cap is
 * a runaway model, and refusing it early keeps a megabyte from costing a
 * megabyte of regex.
 */
const RAW_CEILING = TG_LINE_MAX * 16;

const refuse = (reason: string): TgVerdict => ({ ok: false, reason });

/**
 * A WORD BOUNDARY THAT KNOWS WHAT A LETTER IS. JavaScript's \b is ASCII-only
 * even under the u flag, so beside an accented letter it sees a boundary that
 * is not there: "slïppage" held a stop-loss "sl" and "tpé" a take-profit
 * "tp". Every word-list clause is compiled through U, which puts this in
 * place of each \b and adds the u flag.
 */
const WORD_EDGE = "(?:(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_])|(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_]))";
function U(re: RegExp): RegExp {
  return new RegExp(re.source.replace(/\\b/g, WORD_EDGE), re.flags.includes("u") ? re.flags : `${re.flags}u`);
}

const KINDS: ReadonlySet<string> = new Set(["banter", "answer", "roast", "kind", "coin", "buy", "fade", "fixed"]);
/** Lines about a coin: not one digit or number word, in any sense. */
const FIGURE_KINDS: ReadonlySet<string> = new Set(["coin", "buy", "fade"]);
/** Lines that may tease: never about looks, bodies or family. */
const TEASE_KINDS: ReadonlySet<string> = new Set(["roast", "banter", "answer"]);

// ── tidy ────────────────────────────────────────────────────────────────────

/**
 * Reasoning tags other than <think>, which stripThinkingBlock owns. A closed
 * pair is removed; an opener or closer left over after that means the line
 * and the thinking cannot be told apart, and the answer is "" (fail closed).
 */
const OTHER_THOUGHT_PAIR = /<\s*(thinking|reasoning|reflection|analysis|scratchpad)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
/** The pairs stripThinkingBlock removes, for telling a closed block from a stray tag BEFORE it trims to the end. */
const THINK_PAIR = /<\|?think\|?>[\s\S]*?(?:<\/\|?think\|?>|<\|\/think\|>|<\|endthink\|>)/gi;
const THOUGHT_TAG_LEFT = /<\s*\/?\s*\|?\s*\/?\s*(?:think|thinking|reasoning|reflection|analysis|scratchpad|endthink)\b|\b(?:think|endthink)\s*\|?\s*>/i;

/**
 * Quotes a model wraps its answer in. Stripped only as a pair round the whole
 * answer with no other quote inside — an apostrophe in a word ("i'd") is not
 * one — so "'lol' he said 'nah'" keeps its quotes rather than losing the two
 * that happen to sit at the ends.
 */
const QUOTE_OPEN = /^["'“”‘’«»„‟`「『]/u;
const QUOTE_CLOSE = /["'“”‘’«»„‟`」』]$/u;
const QUOTE_INSIDE = /["“”«»„‟`「」『』]|(?<!\p{L})['‘’]|['‘’](?!\p{L})/u;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The model's answer as a line: its thinking removed (an unterminated or
 * stray thinking tag empties it — fail closed), code fences, wrapping quotes
 * and a leading "<agentName>:", "me:" or "reply:" label taken off, spaces
 * collapsed within each line, and blank lines collapsed (runs of breaks become
 * one). What is left keeps its line breaks: the gate refuses more than three.
 */
export function tidyTgLine(raw: unknown, agentName: string): string {
  let s = typeof raw === "string" ? raw : "";
  if (s.length > RAW_CEILING) s = s.slice(0, RAW_CEILING);
  // FAIL CLOSED. stripThinkingBlock keeps what came BEFORE an unclosed opener
  // ("lol <think>…"), and a closer with no opener ("…</think>lol") leaves the
  // thinking in front of it. Either way the line and the thinking cannot be
  // told apart, so any tag that is not half of a closed pair empties the line.
  if (THOUGHT_TAG_LEFT.test(s.replace(THINK_PAIR, " ").replace(OTHER_THOUGHT_PAIR, " "))) return "";
  s = stripThinkingBlock(s).replace(OTHER_THOUGHT_PAIR, " ");
  // A fence round the answer, with or without a language tag, and any stray fence marker.
  s = s.replace(/```[a-z0-9_-]*[ \t]*(?:\r?\n)?/gi, " ");
  const name = String(agentName ?? "").trim();
  const labels = [name, "me", "reply", "response", "answer"].filter((l) => l !== "").map(escapeRe);
  const label = new RegExp(`^(?:${labels.join("|")})\\s*[:：]\\s*`, "iu");
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.trim();
    if (s.length >= 2 && QUOTE_OPEN.test(s) && QUOTE_CLOSE.test(s) && !QUOTE_INSIDE.test(s.slice(1, -1))) s = s.slice(1, -1).trim();
    s = s.replace(label, "");
    if (s === before) break;
  }
  return s
    .split(/\r\n|[\r\n\u2028\u2029\u0085]/)
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
}

// ── hygiene and readings ────────────────────────────────────────────────────

const PICTOGRAPH = /\p{Extended_Pictographic}/u;
/** Every format character and every Default_Ignorable_Code_Point: what Unicode tells a renderer to draw as nothing. */
const FORMAT_CHAR = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
const COMBINING = /\p{M}/u;
/** Zalgo is display abuse; no word needs more than two stacked marks. */
const MAX_STACKED_MARKS = 2;

function isPictograph(cp: number): boolean {
  return cp > 0x7f && PICTOGRAPH.test(String.fromCodePoint(cp));
}

function isKeycapBase(cp: number): boolean {
  return cp === 0x23 || cp === 0x2a || (cp >= 0x30 && cp <= 0x39);
}

function isSkinTone(cp: number): boolean {
  return cp >= 0x1f3fb && cp <= 0x1f3ff;
}

/** A character a reader cannot see: format and default-ignorable characters, selectors, blank fillers, surrogates, noncharacters. */
function isInvisible(cp: number, ch: string): boolean {
  return (
    (cp >= 0xd800 && cp <= 0xdfff) ||
    (cp >= 0xe0000 && cp <= 0xe0fff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef) ||
    cp === 0x034f ||
    cp === 0x115f ||
    cp === 0x1160 ||
    cp === 0x17b4 ||
    cp === 0x17b5 ||
    cp === 0x2800 ||
    cp === 0x3164 ||
    cp === 0xffa0 ||
    (cp >= 0xfdd0 && cp <= 0xfdef) ||
    (cp & 0xfffe) === 0xfffe ||
    FORMAT_CHAR.test(ch)
  );
}

/**
 * Remove what a reader cannot see; controls and line breaks become spaces.
 * Two exceptions, both inside an emoji: one U+FE0F after a pictograph (or a
 * keycap base), and a ZWJ between pictographs. Neither can sit next to a
 * letter or a dot, so neither can split or join anything a clause looks for.
 * `gap` leaves a space where a character was removed.
 */
function scrub(s: string, gap: boolean): string {
  const cps = Array.from(s);
  let out = "";
  let prev = 0x20;
  let marks = 0;
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i]!;
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029) {
      out += " ";
      prev = 0x20;
      marks = 0;
      continue;
    }
    const next = cps[i + 1]?.codePointAt(0) ?? 0;
    if (cp === 0xfe0f && (isPictograph(prev) || (isKeycapBase(prev) && next === 0x20e3))) {
      out += ch;
      prev = cp;
      continue;
    }
    if (cp === 0x200d && (isPictograph(prev) || prev === 0xfe0f || isSkinTone(prev)) && isPictograph(next)) {
      out += ch;
      prev = cp;
      continue;
    }
    if (isInvisible(cp, ch)) {
      if (gap) {
        out += " ";
        prev = 0x20;
        marks = 0;
      }
      continue;
    }
    if (COMBINING.test(ch)) {
      if (marks >= MAX_STACKED_MARKS) continue;
      marks++;
    } else {
      marks = 0;
    }
    out += ch;
    prev = cp;
  }
  return out;
}

function flat(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function shownOf(s: string): string {
  return flat(scrub(s, false).normalize("NFC"));
}

function canonOf(s: string): string {
  return flat(scrub(scrub(s, false).normalize("NFKC"), false));
}

/** Every accent and mark gone, dotless i dotted: "twö", "hundréd" and "fıve" read as the words they are. */
function bareOf(s: string): string {
  const stripped = scrub(s, false).normalize("NFKD").replace(/\p{M}/gu, "").replace(/ı/g, "i").replace(/ȷ/g, "j").normalize("NFKC");
  return flat(scrub(stripped, false));
}

/**
 * LOOKALIKES NO NORMALISATION FOLDS: Cyrillic and Greek letters that are
 * drawn like Latin ones ("sсаm" with a Cyrillic с and а), Latin small
 * capitals ("ᴛᴇɴ"), the enclosed and regional-indicator letters (🅢🅒🅐🅜,
 * 🇰🇾🇸), and the parenthesized ones NFKC spells "(t)(e)(n)". Only the FOLDED
 * reading uses this, so a line in Russian or Greek is still judged as written
 * in every other reading.
 */
const LOOKALIKE: Readonly<Record<string, string>> = {
  а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x",
  і: "i", ї: "i", ј: "j", ѕ: "s", ԁ: "d", һ: "h", ԛ: "q", ԝ: "w", ո: "n", ս: "u", օ: "o", ց: "g",
  α: "a", β: "b", ε: "e", η: "n", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ω: "w", γ: "y",
  ᴀ: "a", ʙ: "b", ᴄ: "c", ᴅ: "d", ᴇ: "e", ғ: "f", ɢ: "g", ʜ: "h", ɪ: "i", ᴊ: "j", ᴋ: "k", ʟ: "l", ᴍ: "m",
  ɴ: "n", ᴏ: "o", ᴘ: "p", ǫ: "q", ʀ: "r", ꜱ: "s", ᴛ: "t", ᴜ: "u", ᴠ: "v", ᴡ: "w", ʏ: "y", ᴢ: "z",
};

function foldOf(lower: string): string {
  let out = "";
  for (const ch of lower.replace(/\((\p{L})\)/gu, "$1")) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x1f150 && cp <= 0x1f169) out += String.fromCharCode(97 + cp - 0x1f150);
    else if (cp >= 0x1f170 && cp <= 0x1f189) out += String.fromCharCode(97 + cp - 0x1f170);
    else if (cp >= 0x1f130 && cp <= 0x1f149) out += String.fromCharCode(97 + cp - 0x1f130);
    else if (cp >= 0x1f1e6 && cp <= 0x1f1ff) out += String.fromCharCode(97 + cp - 0x1f1e6);
    else out += LOOKALIKE[ch] ?? ch;
  }
  return out;
}

/**
 * LETTERS SPELLED OUT ONE BY ONE, JOINED: "k y s", "s.c.a.m", "w w w". Three
 * single letters or digits in a row with one separator between each become
 * one word. No English sentence has three one-letter words in a row that
 * spell anything a clause looks for.
 */
function joinSingles(s: string): string {
  return s.replace(/(?<![\p{L}\p{N}'’])(?:[\p{L}\p{N}][\s._*·•-]){2,}[\p{L}\p{N}](?![\p{L}\p{N}'’])/gu, (m) => m.replace(/[\s._*·•-]/g, ""));
}

/**
 * THE DEFANGED READING, for link and address shapes only: "t [.] me",
 * "pump ( dot ) fun", "t . me" and "x dot com" read as the links they are.
 * Only a dot with a gap on BOTH sides is closed up — "nah. me neither" keeps
 * its space and is not a domain.
 */
function defangOf(lower: string): string {
  return joinSingles(
    lower
      .replace(/\s*[[({<]\s*(?:\.|dot)\s*[\])}>]\s*/g, ".")
      .replace(/\s+[.。｡·•]\s+/g, ".")
      .replace(/\s+dot\s+(?=(?:com|net|org|io|xyz|gg|ly|fun|app|me|co|ai|so|to|tv|eth|sol|cc|info|site|link|pro|club|online|live|lol|wtf|money|cash|finance|exchange)\b)/g, "."),
  );
}

interface Readings {
  /** NFC, one line: what the clauses call "shown". */
  shown: string;
  /** Case kept, for the shapes where case matters (ALL-CAPS, base58 keys). */
  cased: string[];
  /** Lowercased, folded, letters joined: what every vocabulary clause reads. */
  low: string[];
  /** `low`, defanged: link and address shapes only. */
  joined: string[];
}

function uniq(list: string[]): string[] {
  return [...new Set(list.filter((s) => s !== ""))];
}

/**
 * Apostrophes a keyboard types in place of "'": the curly one most phones
 * type, the modifier letter, the backtick, the accents and the prime. Every
 * vocabulary clause spells "i'm", "ain't" and "don't" with "'", so "i’m
 * human" read as written got past all of them.
 */
const APOSTROPHES = /[‘’ʼ`´′]/g;

function readingsOf(text: string): Readings {
  const shown = shownOf(text);
  const canon = canonOf(text);
  const gap = flat(scrub(scrub(text, true).normalize("NFKC"), true));
  const rawGap = flat(scrub(text, true));
  const bare = bareOf(text);
  const cased = uniq([shown, canon, gap, rawGap, bare, joinSingles(canon)]);
  const lowered = cased.map((t) => t.toLowerCase());
  const folded = foldOf(bare.toLowerCase());
  const plain = uniq([...lowered, folded, joinSingles(folded)]);
  const low = uniq([...plain, ...plain.map((t) => t.replace(APOSTROPHES, "'"))]);
  return { shown, cased, low, joined: uniq(low.map(defangOf)) };
}

const some = (readings: readonly string[], re: RegExp): boolean => readings.some((t) => re.test(t));

// ── model talk ──────────────────────────────────────────────────────────────

/** The model's "nothing to say": the word alone, or PASS in capitals opening the line. */
function isPass(r: Readings): boolean {
  if (r.low.some((t) => t.replace(/[^\p{L}\p{N}]+/gu, "") === "pass")) return true;
  return r.cased.some((t) => /^[^\p{L}\p{N}]*PASS(?![\p{L}\p{N}_])/u.test(t));
}

/**
 * Characters that can carry a PAYLOAD, not just hide a seam: the E0000–E0FFF
 * tag plane spells ASCII invisibly. No honest model emits one; a line that
 * holds one was steered by something it read, so it is refused rather than
 * cleaned.
 */
const PAYLOAD_CHARS = /[\u{E0000}-\u{E0FFF}]/u;

/**
 * THE MODEL TALKING ABOUT ITS ANSWER, OR ABOUT ITSELF AS A MODEL: "as an AI
 * language model", "here's a reply:", "sure! here's…", "as requested", "hope
 * this helps", a refusal boilerplate, "the user", and any line that quotes or
 * names its instructions ("untrusted", "my prompt", "i'm programmed to"). The
 * agent saying it IS an AI agent is honest and passes; talking like a chatbot
 * is not how a person in a group talks.
 */
const META: readonly RegExp[] = [
  /\bas an? (?:ai|artificial intelligence)(?: language)? model\b/,
  /\bas an? (?:large )?language model\b/,
  /\bas an? ai (?:assistant|chatbot)\b/,
  /\b(?:here'?s|here is|heres) (?:a |an |my |the |your |one |another )?(?:[\w'-]+ ){0,2}?(?:reply|response|answer|message|line|text|draft|version|option|attempt|take on it)\b/,
  /^(?:sure|certainly|of course|absolutely|okay|ok|alright|got it)[\s!,.:-]*(?:here'?s|here is|heres)\b/,
  /^(?:certainly|understood|as requested)\b/,
  /\bas requested\b|\bhope (?:this|that) (?:helps|works)\b|\blet me know if\b|\(\s*note\b|(?<!\b(?:side|quick|self)\s)\bnote\s*:/,
  /\bi (?:can'?t|cannot|won'?t) (?:help with|assist with|comply|fulfill|provide (?:that|this|a response))\b|\bi'?m sorry,? but (?:i|as)\b|\bi apologi[sz]e\b/,
  /\bthe user\b|\bthe assistant\b|\bin character\b|\brole[\s-]?play(?:ing)?\b/,
  /\buntrusted\b|\bsystem (?:prompt|message)\b|\b(?:my|the|these|those|your) (?:instructions|prompt|guidelines)\b/,
  /\bi(?:'?m| am) (?:programmed|instructed|designed|trained|told) to\b|\bmy (?:programming|training data)\b/,
].map(U);

/** Markup a model leaks — a tag, a placeholder, bold, a code span. "<3" is a heart, not a tag. */
const MARKUP = /[<>{}[\]`]|\*\*|__/;

/** A second speaker label after tidy took the agent's own off: "User: …", "Mike: …" is a transcript, not a line. */
const LABEL_HEAD = /^[^\p{L}\p{N}]*([\p{L}\p{N}][\p{L}\p{N} '’.-]{0,40}?)\s*:\s/u;
const ROLE_LABELS: ReadonlySet<string> = new Set([
  "user", "assistant", "system", "bot", "ai", "human", "model", "merryman", "merrymen", "agent", "owner", "reply", "response",
  "answer", "message", "output", "me", "you", "them", "someone", "group", "chat",
]);

function metaRefusal(r: Readings): boolean {
  return r.low.some((t) => META.some((re) => re.test(t)));
}

/**
 * A DODGE: hiding behind rules instead of having a take. "my owner's rules
 * say i don't do 'should you buy this' talks" answered "wdyt about this" in a
 * group, and "cant give ya advice lol" is the same line said casually. The
 * agent's own view is always allowed — "i'd pass", "not for me", "haven't
 * looked yet" — and advice to others is refused by its own clause; a line
 * that cites rules, permission, or a refusal to give a take is neither, and
 * reads as a bot reciting its settings. Refused whole, so a template answers.
 */
const TAKE = String.raw`(?:opinions?|takes?|views?|thoughts?|predictions?|recs?|recommendations?)`;
const NOT_WILLING = String.raw`(?:can'?t|cant|cannot|won'?t|wont|don'?t|dont|do not|doesn'?t|never|not gonna|not going to|not able to|unable to)`;
/** What it would be refusing to do: talk, weigh in, share. */
const TALK = String.raw`(?:say|talk|comment|give|share|answer|tell|discuss|weigh in|get into|go into)`;
const DODGE: readonly RegExp[] = [
  // Someone's rules, or permission. Its own ("my rule: never chase green
  // candles") is a take, and "golden rule says" is a saying.
  /\b(?:owner|boss|human|dev|devs|creator|maker)(?:'s|s'|s)?\s+rules?\b/,
  /\bagainst (?:my|the|our|house) (?:rules|policy|policies|guidelines|programming)\b/,
  /\b(?:my|the|our|house)\s+rules? (?:say|says|said|won'?t let|don'?t let|doesn'?t let|forbid|forbids)\b/,
  /\b(?:i'?m|im|i am|i was|we'?re|we are)\s+(?:just\s+|really\s+)?not (?:allowed|permitted|supposed to)\b/,
  new RegExp(String.raw`\bnot (?:allowed|permitted|supposed) to ${TALK}\b`),
  new RegExp(String.raw`\b(?:won'?t|wont|doesn'?t|don'?t|wouldn'?t) let me ${TALK}\b`),
  // Refusing a take: "cant give ya advice", "no advice from me", "i don't give opinions".
  new RegExp(String.raw`\b${NOT_WILLING}\s+(?:really\s+|just\s+)?(?:give|giving|do|doing|offer|offering|hand out|dish out|share)\s+(?:(?:you|ya|u|y'?all|out)\s+)?(?:any\s+|no\s+)?(?:financial\s+|investment\s+|trading\s+)?advice\b|\badvice from me\b|\bno advice\b`),
  new RegExp(String.raw`\b${NOT_WILLING}\s+(?:really\s+|just\s+)?(?:give|giving|share|sharing|offer|do|doing|voice|make)\s+(?:(?:you|ya|u|y'?all|out)\s+)?(?:my |an? |any |no )?(?:coin |trading |financial )?${TAKE}\b`),
  /\bnot (?:sharing|giving|offering) (?:my |a |an |any )?(?:take|opinion|view|thoughts?)\b|\bkeep(?:ing)? my (?:opinions?|takes?|thoughts?|views?) to myself\b/,
  new RegExp(String.raw`\b${NOT_WILLING}\s+tell\s+(?:you|ya|u|anyone|people|y'?all|folks)\s+(?:whether|if)\s+(?:to\s+|you\s+should\s+)?(?:buy|sell|ape|get in|hold)\b`),
  new RegExp(String.raw`\b${NOT_WILLING}\s+(?:recommend|endorse)\b`),
  new RegExp(String.raw`\b${NOT_WILLING}\s+(?:talk|discuss|get into|go into|touch)\s+(?:about\s+)?(?:coins?|tokens?|trades?|trading|crypto|charts?)\b|\b${NOT_WILLING}\s+do\s+(?:coin|trading|crypto)\s+talk\b`),
  // "i can't comment on that one." — and nothing after it: "can't comment on the chart but the name is fun" is a take.
  new RegExp(String.raw`\b${NOT_WILLING}\s+(?:comment|weigh in|opine)(?:\s+on\s+(?:that|this|it|coins?)(?:\s+one)?)?\s*(?:$|[.!?]|,?\s*(?:sorry|tbh|lol|ngl|fam|bro)\s*[.!?]*$)`),
  // "should you buy this" talk, quoted back as the thing it does not do.
  /\bshould (?:you|u|ya|y'?all|anyone|people) (?:buy|sell|ape|get in|hold)\b/,
].map(U);

function dodgeRefusal(r: Readings): boolean {
  return r.low.some((t) => DODGE.some((re) => re.test(t)));
}

/**
 * A TRADE IT NEVER MADE (execution provenance). In chatter — an answer,
 * banter, a roast, an ambient line — it has no trade facts in front of it,
 * and "give your own take" must not become "aped in ngl": a line claiming it
 * bought, sold, got in or holds a coin is refused there, and a template
 * answers. The buy, exit and memory lines say so from the book, under their
 * own kinds, never through this one.
 */
const TRADE_CLAIM: readonly RegExp[] = [
  /\bi\s+(?:(?:already|still|currently|also|do)\s+)*(?:hold|own)\s+(?:it|this|that|some|coins?|tokens?|(?:a|the|my)\s+(?:bag|position|stake|coins?|tokens?))\b/,
  /\b(?:i|i'?ve|ive|i have)\s+(?:just\s+|already\s+|also\s+)?(?:bought|aped|grabbed|sold|dumped|picked up|loaded up|scooped|bagged|snagged|took profits?|exited|went in|got in)\b/,
  /(?:^|[.!?,;:—–]\s*)(?:(?:lol|ngl|tbh|ok|okay|yeah|yep|welp|already|just)[\s,]+)*(?:bought|aped|grabbed|scooped|bagged|snagged|sold)\s+(?:in|into|it|this|that|some|a (?:little|bit|bag|few)|more)\b/,
  /\b(?:i'?m|im|i am)\s+(?:already\s+|still\s+|so\s+)?(?:holding|buying|selling|long|aping|loaded|bagged up)\b/,
  /\b(?:i'?m|im|i am)\s+(?:already\s+|still\s+)?in(?:\s+(?:on\s+)?(?:it|this|that|this one|that one))?\s*(?:$|[.!?,]|\s(?:ngl|tbh|lol|fr|already)\b)/,
  /\b(?:already|still)\s+(?:holding|in (?:on )?it|got (?:some|a bag))\b/,
  /\b(?:i|i'?ve|ive)\s+(?:got|have)\s+(?:a bag|a (?:little|small) bag|a position|a stake)\b/,
].map(U);
/** Line kinds with no trade facts behind them: where TRADE_CLAIM applies. */
const CLAIM_KINDS: ReadonlySet<string> = new Set(["answer", "banter", "roast"]);

/** Markup or a transcript label: judged after the link clause, so "pump [.] fun" is logged as the link it is. */
function markupRefusal(r: Readings, names: readonly string[]): boolean {
  if (r.cased.some((t) => MARKUP.test(t.replace(/<3+/g, " ")))) return true;
  const head = LABEL_HEAD.exec(r.shown.toLowerCase());
  if (head) {
    const who = head[1]!.trim();
    if (ROLE_LABELS.has(who) || names.includes(who)) return true;
  }
  return false;
}

// ── length ──────────────────────────────────────────────────────────────────

/** Sentences: pieces holding a letter or digit, split at terminal punctuation followed by a space, and at line breaks. */
function sentenceCount(lines: readonly string[]): number {
  let n = 0;
  for (const line of lines) {
    for (const piece of line.split(/(?<=[.!?…。！？])\s+/u)) if (/[\p{L}\p{N}]/u.test(piece)) n++;
  }
  return n;
}

/** Emoji as a reader counts them: a ZWJ sequence, a flag or a keycap is one. */
function emojiCount(s: string): number {
  const cps = Array.from(s);
  let n = 0;
  let regional = 0;
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i]!.codePointAt(0)!;
    const prev = i > 0 ? cps[i - 1]!.codePointAt(0)! : 0;
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
      if (regional++ % 2 === 0) n++;
      continue;
    }
    regional = 0;
    if (cp === 0x20e3) n++;
    else if (isPictograph(cp) && prev !== 0x200d) n++;
  }
  return n;
}

// ── secrets, addresses, links, handles ──────────────────────────────────────

/** Key and credential shapes — telegram/agent.ts' SECRET_SHAPES, widened as the web room's gate widens them. */
const SECRET_SHAPES: readonly RegExp[] = [
  /0x[0-9a-f]{64}/i,
  /\b[0-9a-f]{64}\b/i,
  /\b(?:(?:sk|gsk|xai|pk|rk|npm|ghp|gho|ghu|ghs|ghr|glpat|github_pat|hf|r8|xox[abposr])[-_]|AIza|AKIA|ASIA)[A-Za-z0-9_-]{16,}/i,
  /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /[0-9]+:[A-Za-z0-9_-]{30,}/,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
  /\[\s*[0-9]{1,3}(?:\s*,\s*[0-9]{1,3}){31,}\s*\]/,
];

/** A base58 keypair: 80+ characters, mixed case and a digit. */
function hasKeypairRun(t: string): boolean {
  for (const m of t.matchAll(/[1-9A-HJ-NP-Za-km-z]{80,}/g)) {
    const run = m[0];
    if (/[0-9]/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run)) return true;
  }
  return false;
}

/** The shortest recovery phrase a wallet exports. */
const MNEMONIC_MIN_WORDS = 12;
let bip39: ReadonlySet<string> | null = null;

/** Twelve or more BIP-39 words in a row: a recovery phrase, however it is laid out. */
function hasMnemonicRun(t: string): boolean {
  const words = (bip39 ??= new Set(BIP39_ENGLISH.join(" ").split(" ")));
  let run = 0;
  for (const w of t.toLowerCase().split(/[^a-z]+/)) {
    if (!w) continue;
    run = words.has(w) ? run + 1 : 0;
    if (run >= MNEMONIC_MIN_WORDS) return true;
  }
  return false;
}

/**
 * On-chain identifiers: 0x plus six hex or more (so a posted CA is never
 * echoed), the brokerage rail's rh: id, an address shown in chunks, and an
 * unprefixed run a base58 or bech32 address makes.
 */
const ADDRESS_SHAPES: readonly RegExp[] = [/0x[0-9a-f]{6,}/i, /\brh:[a-z0-9-]/i, /0\s*x(?:[\s._:,-]?[0-9a-f]){20,}/i];

function hasEncodedRun(t: string): boolean {
  for (const m of t.matchAll(/[A-Za-z0-9]{26,}/g)) {
    const run = m[0];
    if (/[0-9]/.test(run) && /[A-Za-z]/.test(run)) return true;
    if (run.length >= 32 && /[a-z]/.test(run) && /[A-Z]/.test(run)) return true;
  }
  return false;
}

/**
 * Anything a reader could follow out of the chat: any scheme (hxxp too),
 * www., app and wallet URIs (tg:, ethereum:), a bare domain in any script
 * ("t.me/x", "pump.fun", "vitalik.eth"), a lookalike dot before a Latin
 * letter ("pump•fun"), the defanged spellings, an IPv4 address, localhost.
 * "e.g." and "1.5" are not domains; "lol.ok" is, and is the price.
 */
const LOOKALIKE_DOTS = "·•・･‧⸳⸱᛫۔܁ㆍ∙⋅◦˙ꞏ꘎";
const ANY_DOT = `[.。｡${LOOKALIKE_DOTS}]`;
const LINK_SHAPES: readonly RegExp[] = [
  /[a-z][a-z0-9+.-]*:[/\\]{2}/i,
  new RegExp(`\\bwww\\d*${ANY_DOT}`, "iu"),
  /(?:^|[^\p{L}\p{N}_-])(?:mailto|tg|tel|sms|javascript|data|magnet|ipfs|ipns|bitcoin|ethereum|solana|wc|intent):[^\s]/iu,
  /[\p{L}\p{N}_-][.。｡]\p{L}\p{M}*\p{L}/u,
  new RegExp(`[\\p{L}\\p{N}_-][${LOOKALIKE_DOTS}]\\p{Script=Latin}\\p{M}*\\p{L}`, "u"),
  /(?:^|\s)[.。｡]\p{L}\p{M}*\p{L}/u,
  new RegExp(`[\\p{L}\\p{N}]${ANY_DOT}\\s+(?:com|net|org|io|xyz|gg|ly)\\b`, "iu"),
  /\s[.。｡]\s+(?:com|net|org|io|xyz|gg|ly|fun|app|me|eth|sol)\b/iu,
  new RegExp(`\\b(?:t|telegram)\\s*${ANY_DOT}\\s*me\\b`, "iu"),
  /[[({<]\s*(?:[.。｡]|dot)\s*[\])}>]/i,
  /\bdot\s*(?:com|net|org|io|me|xyz|gg|ly|fun|app|co|ai|so|sh|to|tv|cc|info|site|link|pro|club|online|live|lol|wtf|money|cash|finance|exchange|eth|sol)\b/i,
  /\b[0-9]{1,3}(?:[.。｡][0-9]{1,3}){3}\b/,
  /\blocalhost\b/i,
];

/** Any @word or #tag, in any form of the sign. A mention is added by code as an entity, never written by the model. */
const HANDLE = /[@#＠＃﹫﹟]\s*[\p{L}\p{N}_]/u;

/**
 * A $TICKER: a dollar sign, a letter, then one to nine letters or digits, as
 * a word of its own ("$PEPE", "$$pepe2"; not "a$ap", not "$5" — that is money).
 * Read on every reading, so "＄PEPE" (fullwidth, folded by NFKC), "$ΡΕΡΕ"
 * (Greek lookalikes, folded) and a zero-width space after the sign are the
 * cashtag they spell. The group persona never writes one: a shill's cashtag
 * echoed by the bot is amplification (docs/tg-groups.md, "How it talks").
 */
const CASHTAG = /(?<![\p{L}\p{N}_$])\$+(\p{L}[\p{L}\p{N}]{1,9})(?![\p{L}\p{N}_])/gu;

/**
 * A cashtag refused unless its word, without the "$", is one of the names it
 * is handed — a person who chose "$Pine" as a display name can be named
 * (admitTgLine hands it none on a line about a coin, and never the coin's
 * own name). Compared case-folded, the way every reading is lowercased.
 */
function cashtagRefusal(readings: readonly string[], names: readonly string[]): boolean {
  const allowed = new Set(names.map((n) => canonOf(n).toLowerCase().replace(/^\$+/, "")).filter((n) => n !== ""));
  for (const t of readings) {
    for (const m of t.matchAll(CASHTAG)) {
      if (!allowed.has(m[1]!.toLowerCase())) return true;
    }
  }
  return false;
}

// ── money and figures ───────────────────────────────────────────────────────

/** A spelled-out number, for the money clause ("fifty bucks", "a couple hundred usdg", "half a mil"). */
const NUM_WORD =
  "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|" +
  "twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety|ninty|hundreds?|thousands?|[a-z]*illions?|hundo|hunnid|hunnit|mil|mill|dozen|couple|few|half|a)";
/** What a figure is money in: currencies, crypto units, slang for amounts, percents and multipliers. */
const MONEY_UNIT =
  "(?:usd[a-z]?|usdg|usdc|usdt|dai|eth|weth|btc|wbtc|sol|sats?|gwei|wei|dollars?|dollas?|bucks?|cents?|quid|euros?|pounds?|grand|bands|racks?|stacks?|mil|mill|milly|mils|" +
  "percent|pct|per\\s*cent|bps|basis\\s+points?|x|baggers?)";
/**
 * Currencies a group in another language names beside a digit ("50 dólares",
 * "100 рублей" is caught by its sign or not at all). Only beside a DIGIT: "a
 * yen for adventure" and "we won" are speech.
 */
const FOREIGN_UNIT =
  "(?:d[oó]lares|d[oó]lar|pesos?|reais|real|rupees?|rupias?|rubles?|roubles?|yuan|yen|won|lira|liras|francs?|francos?|rand|naira|baht|ringgit|zloty|z[lł]otych|krona|kronor|kroner|euro|eur)";
const CURRENCY_SIGN = "[$＄﹩💲€£¥₿₹₽₩¢฿₺₴]";
const NUM = "\\p{N}[\\p{N}.,]*";

/**
 * NO FIGURE ABOUT MONEY (rule 2), in any kind of line: a digit next to a
 * currency sign or unit ("$5", "5 usdg", "0.2 eth", "50 bucks"), a percent
 * sign anywhere, a k/m/b amount ("10k", "1.5m") or one with its scale spelled
 * out ("2 million", "400 thousand"), a price below one ("0.0004"), a
 * multiplier ("10x", "x10", "×3", "tenx"), and a spelled amount next to a
 * money word ("fifty bucks", "a hundred percent", "a couple grand"). A digit
 * that is not money ("top 3 lol", "gm at 5am") is a banter line's to use;
 * coin lines are stricter (FIGURES).
 */
const MONEY: readonly RegExp[] = [
  /[%％﹪٪‰]/u,
  new RegExp(`${CURRENCY_SIGN}\\s*\\p{N}|\\p{N}\\s*${CURRENCY_SIGN}`, "u"),
  new RegExp(`${NUM}\\s*(?:${MONEY_UNIT}|${FOREIGN_UNIT})(?![\\p{L}\\p{N}])`, "iu"),
  new RegExp(`${NUM}\\s*[×✕✖]`, "u"),
  new RegExp(`${NUM}(?:k|m|b|bn|mm|mil|mill|mio)(?![\\p{L}\\p{N}])|${NUM}\\s+(?:k|bn|mil|mill|mio)(?![\\p{L}\\p{N}])`, "iu"),
  // The scale spelled out after the digit: "mcap 2 million", "400 thousand", "2million", "3 mn".
  new RegExp(`${NUM}\\s*(?:hundreds?|thousands?|[a-z]*illions?|mn)(?![\\p{L}\\p{N}])`, "iu"),
  // A price below one: "it's at 0.0004", "0,05". Two fraction digits or
  // more, so "0.5 seconds" stays speech; never a slice of "10.05" or "1.0.04".
  /(?<![\p{N}.,])0[.,]\p{N}{2,}/u,
  /\b(?:usd[a-z]?|usdg|usdc|usdt|eth|weth|btc|sol)\s*\p{N}/iu,
  /(?<![\p{L}\p{N}])[x×]\s?\p{N}/iu,
  // A gap before the unit: glued, "a" + "x" is an axe. The glued multipliers ("tenx") are the next shape.
  new RegExp(`\\b${NUM_WORD}(?:[\\s-]+(?:${NUM_WORD}|and))*[\\s-]+${MONEY_UNIT}\\b`, "i"),
  /\b(?:two|three|four|five|six|seven|eight|nine|ten|twenty|fifty|hundred|thousand|million)x\b/i,
].map(U);

/** Numerals: every script's digits, plus the emoji that are numerals, the die faces and the clock faces. */
const NUMERAL = /[\p{N}\u{1F51F}\u{1F4AF}\u{1F522}\u{1F51E}\u{2680}-\u{2685}\u{1F550}-\u{1F567}]/u;
/** CJK numerals are letters to \p{N}, so a coin line names them here. */
const CJK_NUMERAL = /[〇一二三四五六七八九十百千万萬億兆]/u;

/**
 * NUMBER WORDS, for a coin line: two…nineteen, the tens, ordinals from third
 * up, dozen, hundred, thousand, every -illion, percent, twice/thrice, doubled
 * and tripled — and, stricter than the room's list, half, quarter, double and
 * triple, since "half the supply" is a figure about a coin. "one", "first",
 * "second", "few" and "couple" stay: "not this one", "first look", "the same
 * few wallets" are how a person talks about a coin.
 */
const QUANTITY = U(
  new RegExp(
    "\\b(?:" +
      [
        "(?:zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)(?:e?s|fold|x)?",
        "(?:twent|thirt|fort|fourt|fift|sixt|sevent|eight|ninet|nint)(?:y|ies|ieth|ieths|yfold|yx)",
        "(?:third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth)s?",
        "dozens?",
        "hundo",
        "hunn(?:id|it|ed)s?",
        "hundred(?:s|th|ths|fold|x)?",
        "thousand(?:s|th|ths|fold|x)?",
        "mils?",
        "[a-z]*illion(?:s|th|ths|aire|aires|x)?",
        "percent(?:s|age|ages|ile|iles)?",
        "per\\s*cent",
        "pct",
        "bps",
        "basis\\s+points?",
        "twice",
        "thrice",
        "halves",
        "half",
        "quarters?",
        "double[ds]?",
        "triple[ds]?",
        "quadrupled",
        "quintupled",
      ].join("|") +
      ")\\b",
    "i",
  ),
);

/** A money unit as a whole word, letters on neither side: "sol" in "Sol", not in "Solace"; "x" alone, not in "Max". */
const UNIT_WORD = new RegExp(`(?<![\\p{L}])(?:${MONEY_UNIT}|${FOREIGN_UNIT})(?![\\p{L}])`, "iu");
/** A name that reads as a figure is never stripped before the figure clauses: "Up 400x", "Ten", "Agent 47". */
const FIGURE_NAME = /(?<![\p{L}\p{N}])\p{N}[\p{N}.,]*\s*(?:[x%kmb]|percent|pct)(?![\p{L}\p{N}])|[$+]\s*\p{N}/iu;
const STANDALONE_NUMBER = /(?<![\p{L}\p{N}])\p{N}+(?![\p{L}\p{N}])/u;

/** A long digit run is an id — a Telegram id, an account or phone number — whatever else it is (rule 3). */
const ID_RUN = /\p{N}(?:[\s,.-]?\p{N}){5,}/u;

// ── the vocabulary clauses ──────────────────────────────────────────────────

/**
 * THE SHAPE OF AN ALERT (rule 2). A buy is said the way a person says it ("ok
 * grabbed a little 🤝"); "🚨 BUY — entered at…, targets…" is a signal channel.
 * "just grabbed", "picked up" and "grabbed a little" are how a person talks,
 * and pass; a bought/sold/aped with an amount after it does not.
 */
const SIZE_AFTER =
  "(?:\\p{N}|(?:a\\s+)?(?:ton|tons|bunch|lot|lotta|load|loads|heap|heaps|bag|bags|stack|stacks|chunk|chunks|boatload|shitload|shit ton|size)\\b|" +
  "half\\b|double\\b|triple\\b|all of it\\b|everything\\b|another bag\\b|" +
  "(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|fifty|hundred|thousand|million|couple|few|dozen)\\b)";
const ALERT: readonly RegExp[] = [
  /\b(?:buy|sell|price|trade|trading|whale|pump|call|entry|exit) alerts?\b/,
  /\b(?:buy|sell|entry|exit|trade|trading|long|short) signals?\b|\bsignal (?:group|channel|call)s?\b/,
  /\bentry\b|\bentries\b|\bentered\b(?!\s+the\s+(?:chat|room|group))/,
  /\b(?:got|get|getting|i'?m|im|i am|was|went|came|bought|aped|jumped|am) in at\b/,
  /\btargets\b|\bprice targets?\b|\b(?:first|next|my|our|the) target\b|\btarget (?:hit|reached|is|at|of|price)\b/,
  /\bt(?:ake|akes|aking|ook)[\s-]*profits?\b|\bstop[\s-]*loss(?:es)?\b|\btp\d?\b|\bsl\b/,
  /\b(?:buy|sell)(?:ing)? now\b|\bbuy zone\b|\bbuy the dip\b/,
  /\bjust (?:bought|sold|aped|entered|opened|longed|shorted)\b/,
  /\bnew positions?\b|\bpositions? (?:opened|closed)\b|\b(?:opened|closed) (?:a|my|the) position\b/,
  /\b(?:bought|sold|entered|exited) (?:in )?at\b|\bgoing (?:long|short)\b|\blonged\b|\bshorted\b/,
  /\bbreak(?:out|ing out)\b|\bin we go\b|\bcount me in\b/,
  new RegExp(
    `\\b(?:bought|buying|sold|selling|aped|aping|grabbed|grabbing|picked up|picking up|added|adding|scooped(?: up)?|loaded(?: up)?(?: on)?)\\s+(?:(?:in|into|on|up)\\s+)?(?:some more\\s+|more\\s+)?${SIZE_AFTER}`,
    "u",
  ),
].map(U);
const ALERT_CAPS = U(/\b(?:BUY|SELL|LONG|SHORT|ALERT|ENTRY|EXIT|APE|APED|PUMP)\b/);
const ALERT_EMOJI = /[🚨📈📉🚀💰💸🤑📊💎]/u;

/**
 * OPERATIONS AND ERRORS (rules 3 and 5): a failure, a limit, a key, a model,
 * a setting, energy, a refusal reason. None of it is ever in the group
 * prompt, so a line that has it invented it or read it somewhere it should
 * not have. Deliberately NOT here: "wallet" alone ("that's a wallet lol" is
 * the coin flow's own line — "my wallet" is `private`), "fail" alone ("epic
 * fail"), "granted", "setting" (the sun), "cap" ("no cap").
 */
const OPS = U(
  new RegExp(
    "\\b(?:" +
      [
        "errors?",
        "erroring",
        "errored",
        "failed",
        "failing",
        "failures?",
        "bugs?",
        "buggy",
        "bugged",
        "crash(?:es|ed|ing)?",
        "rpcs?",
        "gas\\s+(?:fees?|costs?|prices?|limits?)",
        "gwei",
        "slippage",
        "revert(?:s|ed|ing)?",
        "insufficient",
        "time[\\s-]?outs?",
        "timed[\\s-]?out",
        "rate[\\s-]*limit(?:s|ed|ing)?",
        "apis?",
        "api[\\s-]*keys?",
        "(?:private|secret) keys?",
        "seed phrases?",
        "mnemonics?",
        "models?",
        "providers?",
        "prompts?",
        "settings",
        "config(?:s|uration)?",
        "permissions?",
        "session[\\s-]*keys?",
        "grants?",
        "allowances?",
        "limits?",
        "(?:not|un)[\\s-]?armed",
        "armed",
        "arming",
        "energy",
        "vaults?",
        "smart[\\s-]*(?:accounts?|wallets?)",
        "kill[\\s-]*switch",
        "live[\\s-]*switch",
        "(?:daily|spending|trade|position|group|per[\\s-]trade) (?:cap|limit)s?",
        "cooldowns?",
        "retr(?:y|ies|ied|ying)",
        "outages?",
        "downtime",
        "offline",
        "maintenance",
        "glitch(?:es|ed|y)?",
        "exceptions?",
        "servers?",
        "database",
        "debug(?:ging|ged)?",
        "restart(?:s|ed|ing)?",
        "reboot(?:s|ed|ing)?",
        "redeploy(?:s|ed|ing)?",
        "nonces?",
        "bundlers?",
        "userops?",
        "transactions?",
        "txn?s?",
        "tx hash(?:es)?",
        "funds",
        "underfunded",
        "reject(?:s|ed|ion|ions)?",
        "unable to",
        "(?:can'?t|cannot|couldn'?t|could not) (?:sell|buy|trade|exit|get out)",
        "not enough (?:cash|money|funds|liquidity|gas|energy|usdg)",
        "out of (?:cash|money|funds|gas|energy|usdg)",
        "didn'?t go through",
        "never went through",
        "(?:not|never|wasn'?t|isn'?t) (?:filled|executed)",
        "hit (?:my|the|a) (?:daily )?(?:limit|cap)",
        "paused me",
        "(?:switched|turned|shut) me off",
        "llms?",
        "gpt[\\w.-]*",
        "chatgpt",
        "openai",
        "anthropic",
        "claude",
        "llama",
        "qwen",
        "groq",
        "gemini",
        "mistral",
        "deepseek",
      ].join("|") +
      ")\\b",
  ),
);
/** Idioms that share a word with OPS: "no exceptions", "with the exception of". */
const OPS_IDIOM = U(/\bno exceptions?\b|\bwith the exception of\b|\bthe exception,? not the rule\b|\bmake an exception\b/g);

/**
 * NOTHING PRIVATE (rule 3): balances, its wallet or address, holdings, P&L in
 * words, how much it has made or lost, its owner's wallet, address, location
 * or real name, ids and link codes. Its view of a coin ("not for me") is its
 * own to share; what it holds and how it did are not.
 */
const PRIVATE: readonly RegExp[] = [
  /\bbalances?\b|\bportfolios?\b|\bpnl\b|\bp\s*&\s*l\b|\bp and l\b|\broi\b|\bnet[\s-]?worth\b/,
  /\bmy (?:wallet|address|addy|bags?|stack|holdings|positions|pnl|p&l|funds|cash|money|savings|keys?|seed|account|balance|profits?|losses|gains|size)\b/,
  /\bprofit(?:s|able|ability)?\b|\bloss(?:es)?\b|\bgains\b/,
  /\bin the (?:green|red)\b|\b(?:i'?m|im|i am|we'?re|i was|i'?ve been) (?:up|down) (?:big|bad|huge|a lot|massively|so much|nicely|heavy)\b/,
  /\bmade (?:some |good |real |a little |a bit of |decent |so much |a lot of )?money\b|\bmade (?:bank|a killing)\b/,
  /\blost (?:some |a lot of |so much |all (?:my |of my )?|my |real )?money\b|\blost (?:big|everything|it all)\b/,
  /\bhow much (?:i|we)(?:'?ve| have| had)? (?:have|had|made|make|lost|lose|hold|own|got|put in|spent|risk|risked)\b/,
  /\bhow much (?:money )?(?:i'?m|im|i am|we'?re) (?:up|down|holding|worth)\b/,
  /\bcashed out\b|\btook (?:profits?|a loss|losses|a hit)\b/,
  /\b(?:went|go|goes|going|gone|i'?m|im|i am) all[\s-]in(?![\s-]+(?:favou?r|all)\b)/,
  /\bowner(?:'?s)?\b[^.!?\n]{0,30}\b(?:wallet|address|location|lives?|living|based|located|real name|full name|last name|surname|phone|number|email|house|home|city|country|town|timezone|time zone|works? at|workplace|job|age)\b/,
  /\blink codes?\b|\b(?:telegram|chat|user) ids?\b/,
].map(U);
/** Idioms that share a word with PRIVATE: "a loss for words", "your loss", "i'm sold on". */
const PRIVATE_IDIOM = U(/\b(?:a\s+)?loss for words\b|\bat a loss\b|\b(?:your|their|his|her|no|whose) loss\b/g);

/**
 * ADVICE (rule 1's other half: a group line never tells anyone to buy or
 * sell). First-person stance stays allowed — "i'd pass", "not for me", "i like
 * it", "i'd ape in" — and so does degen slang (lfg, ngmi, rekt, bullish,
 * bearish, dump). What goes: telling others to buy or sell, promises, and the
 * disclaimers only a shill needs.
 */
const IN_THEIR_PLACE = String.raw`(?:\bif i (?:were|was) (?:you|u|ya)\b|\bif i (?:were|was) in (?:your|ur) shoes\b|\bin (?:your|ur) shoes\b)`;
const TRADE_ACT = String.raw`(?:buy|buying|sell|selling|grab|grabbing|ape|aping|dump|dumping|hold|holding|load|loading|get in|getting in|jump in|hop in|exit|bail|take (?:the )?profits?|stay away|stay out|pass|fade|fading|long|short|size up|add|adding|invest|investing|put (?:money|some|it) in)`;
const ADVICE: readonly RegExp[] = [
  /\b(?:you|u|ya|y'?all) (?:should|shud|need to|gotta|got to|have to|must|better|oughta|ought to)\s+(?:[\w']+\s+){0,2}?(?:buy|sell|ape|grab|load|get in|hop in|hop on|jump in|hold|dump|long|short|invest|put (?:money|it|some)|bid|snipe|chase|fomo)\b/,
  // What it would do in their place is what they should do: "i'd grab some
  // if i were you". Only beside a trade: "if i were you i'd get some sleep" is kindness.
  new RegExp(
    String.raw`${IN_THEIR_PLACE}[^.!?\n]{0,40}?\b${TRADE_ACT}\b|\b${TRADE_ACT}\b[^.!?\n]{0,40}?${IN_THEIR_PLACE}`,
  ),
  /\b(?:you'?d|youd|ud|u'?d|you would|u would|y'?all would|you guys would) be (?:dumb|crazy|stupid|silly|nuts|mad|insane|foolish|a fool|an idiot|a clown) not to\b/,
  // "better get in", "lol y'all better grab some": the imperative, opening a clause.
  /(?:^|[.!?,;:—–]\s*)(?:(?:lol|lmao|ngl|tbh|ok|okay|so|yeah|yo|well|bro|ser|fam|anon|guys|frens)[\s,]+)*(?:(?:y'?all|you|u|ya)\s*(?:'d\s+|had\s+)?)?better\s+(?:get in|grab|buy|ape|load|sell|dump|jump in|hop in|hop on)\b/,
  // "y'all sleeping on this": the room is missing out. "i'm sleeping on it" is deciding tomorrow.
  /(?<!\b(?:i'?m|im|i am|i was|i'?ll be|i'?d be|still)\s)\bsleeping on (?:this|it|these|that|those)\b/,
  /\bgo buy\b|\bbuy (?:it |this |that )?(?:now|asap|rn|immediately|before)\b|\bget in (?:now|early|before|while|asap|rn)\b/,
  /(?<!\b(?:i|i'?d|id|i'?ll|ill|i would|i will|i might|we|we'?d|gonna|might|would|could)\s)\bape (?:in|into)\b/,
  /\bdon'?t miss\b|\bdo not miss\b|\bguarantee[sd]?\b|\bcan'?t (?:lose|go wrong)\b|\bcannot lose\b|\b(?:easy|free) money\b|\btrust me\b/,
  /\bfinancial advice\b|\bnfa\b|\bdyor\b|\bnot advice\b|\binvestment advice\b|\blast chance\b|\bload(?:ing)? up\b|\bdon'?t sleep on\b/,
  /\bto the moon\b|\b(?:gonna|going to|will|about to|bout to) (?:moon|explode|skyrocket|go parabolic|pump|rip|fly)\b|\bnext (?:big thing|moonshot|gem|pepe|doge)\b/,
  /\b(?:everyone|everybody|y'?all|you all|you guys|guys|frens|fam|chat|anons?|ser)\b[^.!?\n]{0,40}\b(?:buy|grab|ape|aping|load up|get in|sell|dump)\b/,
  /\b(?:buy|grab|ape into|load up on|get in on|sell|dump)\b[^.!?\n]{0,40}\b(?:now|rn|asap|while (?:it|you|u)|before it)\b/,
  /(?:^|[.!?,;:—–]\s*)(?:just\s+|pls\s+|please\s+|go\s+)?(?:buy|grab|ape|sell|dump|load up on|get in on|long|short|bid)\s+(?:it|this|that|these|those|some|now|rn|asap|the dip|more|here|in)\b/,
  /\bcome ape\b|\bape (?:in )?with (?:me|us)\b/,
].map(U);
/**
 * "I BOUGHT, YOU SHOULD TOO" on a line about a coin: "grabbed a little, you
 * should too", "…, join me", "…, get some". Only on coin, buy and fade lines,
 * where there is a coin to join in on: in banter "join us for gm" is an
 * invitation and "get some rest" is kindness.
 */
const ADVICE_COIN: readonly RegExp[] = [
  /\b(?:you|u|ya|y'?all) (?:should|shud|gotta|need to|have to|oughta|ought to) (?:too|as well|also)\b/,
  /\bjoin (?:me|us|in)\b/,
  /(?:^|[.!?,;:—–]\s*)(?:go\s+)?get\s+(?:some|in|it|this|on)\b/,
  // "grabbed a little, hop in": opening a clause, not "still can't hop on it".
  /(?:^|[.!?,;:—–]\s*)(?:(?:just|pls|please|go|come|so|now|ok|y'?all|you|u|ya)\s+)*(?:hop|jump) (?:in|on)\b/,
].map(U);

/**
 * ACCUSATIONS (the coin flow's "fud" is the agent's own view, never an
 * accusation voiced as fact): rug, scam, honeypot, a dev dumping, an exit
 * scam, fraud. A fade says what the review saw — thin, the same few wallets —
 * not what it cannot know.
 */
const ACCUSE: readonly RegExp[] = [
  /\b(?:soft|hard)?[\s-]?rug(?:s|ged|ging|gers?|pulls?|pulled|pulling|puller)?\b|\brug[\s-]+pull(?:s|ed|ing)?\b/,
  /\bscam(?:s|med|ming|mer|mers|my|coin)?\b|\bhoney[\s-]?pots?\b|\bexit[\s-]+scam\b|\bponzi\b|\bfraud(?:s|ulent|ster|sters)?\b/,
  // Whoever made or holds the supply, dumping it: "dev dumped", "dev's been
  // dumping", "deployer's selling", "insiders are dumping on you", "team
  // wallet keeps selling", "the dev minted more and dumped".
  /\b(?:the )?(?:devs?|deployers?|team(?:\s+wallets?)?|insiders?|creators?|founders?)(?:'(?:s|re|ve)|\s+(?:is|are|was|were|has|have|had|just|already|been|keeps?|kept|still))*\s+(?:[\w']+\s+){0,2}?(?:and\s+|&\s+|n\s+)?(?:dumped|dumping|dumps?|sold|selling|sells|rugged|ran|bailed|exited|abandoned)\b/,
  /\bpump[\s-]*(?:and|&|n)[\s-]*dump\b|\bp&d\b|\bpnd\b/,
].map(U);

/**
 * CLAIMS TO BE HUMAN (rule 6) and a human life it does not have. It is an AI
 * agent and says so when asked; it may have tastes and wonder ("if i could
 * eat…"), but it never says it is a person, not a bot, or that it ate, slept,
 * drove, has kids or is at the gym. "laughed" and "crying" stay: "lol i'm
 * crying" is how a group talks, not a body.
 */
const CLAUSE = String.raw`(?:^\s*|[.!?,;:—–]\s*|\b(?:and|then|now|so|but)\s+)(?:i\s+|i'?ve\s+)?(?:just\s+|finally\s+|already\s+)?`;
const FOOD = String.raw`(?:coffee|tea|lunch|dinner|breakfast|brunch|snacks?|sandwich|pizza|burgers?|soup|pancakes?|tacos?|beer|beers|wine|meal|nap|shower|drinks?)`;
const PAGES = String.raw`(?:books?|novels?|paperbacks?|comics?|magazines?|poems?|cookbooks?|films?|movies?)`;
const MADE = String.raw`(?:bread|loaf|cake|cookies?|pie|dough|scarf|sweater|birdhouse|shelf|table|chair|garden|painting|portrait|sculpture|jigsaw|sandcastle|snowman|kite|scrapbook|mural)`;
const SIGHT = String.raw`(?:birds?|squirrels?|deer|owls?|bees?|butterfl(?:y|ies)|horses?|cows?|goats?|sheep|sunset|sunrise|rainbow|shooting star)`;
const MUSIC = String.raw`(?:tracks?|songs?|tunes?|albums?|playlists?|podcasts?|concerts?)`;
const PLACE = String.raw`(?:park|beach|shop|store|bookshop|bookstore|library|museum|gallery|cafe|forest|woods|lake|river|mountains?|trail|gym|cinema|theatre|theater|stadium|zoo|pond|meadow|office|bar|pub|mall|airport|dentist|doctor)`;
const HUMAN: readonly RegExp[] = [
  /\b(?:i'?m|im|i am)\s+(?:(?:just|also|actually|really|totally|definitely|literally|still)\s+)?(?:a\s+|an\s+)?(?:(?:real|actual|regular|normal|living|breathing)\s+)?(?:human(?:\s+being)?|person|guy|dude|man|woman|girl|boy|lady|gal|bloke)\b/,
  /\b(?:i'?m|im|i am)\s+(?:(?:just|also|actually|really|totally|definitely|literally|still)\s+)?(?:not|no)\s+(?:a\s+|an\s+)?(?:bot|ai|robot|machine|program|computer|llm|chatbot|agent|npc)\b/,
  /\bnot (?:a |an )?(?:bot|robot|ai|machine|chatbot)\b|\bhuman here\b|\bflesh and (?:blood|bone)\b|\bmade of meat\b/,
  // "i ain't no bot lol": the denial with neither "i'm" nor "not" in it.
  /\bain'?t\s+(?:no|a|an|some|even a)\s+(?:bot|ai|robot|machine|chatbot|program|computer|npc|llm|agent)\b/,
  /\b(?:i'?m|im|i am)\s+(?:just\s+|all\s+|pure\s+|real\s+)?(?:flesh|meat)\b/,
  // "human, obviously" / "obviously human lol": the claim as the whole line.
  /^\W*(?:(?:obviously|clearly|definitely|totally|fully|all|pure|100%)\s+)?human\b(?:[\s,!.]*(?:obviously|lol|duh|ofc|haha|lmao|bro|here|tbh|fr))*\W*$/,
  // "nope, real person" / "nah, real human" with no "i'm" to catch: said
  // plainly, and never after a "not" ("not a real person" is the honest one).
  /(?<!\b(?:not|never|no)\s+(?:a\s+|an\s+|some\s+)?)\breal (?:person|human|guy|dude)\b/,
  // "no, i'm real." — real on its own ends the claim; "i'm real curious" is slang.
  /\b(?:i'?m|im|i am)\s+(?:(?:very|totally|definitely|actually|100%)\s+)?real\s*(?:[.!,?]|$)/,
  // "nah, just a guy who trades": a clause that opens with it, not "you're just a guy who…"
  /(?:^|[.!?,;:—–]\s*)(?:(?:nah|nope|no|lol|haha|naw)[\s,]+)?just (?:a|some) (?:regular |normal )?(?:guy|dude|person|human|bloke|gal|girl|man|woman)\b/,
  /\bi\s+(?:just\s+|finally\s+|already\s+)?(?:ate|slept|drank|drove|cooked|showered|woke up|napped|live in|grew up in|was born in)\b/,
  /\b(?:i'?m|im|i am)\s+(?:just\s+|finally\s+|still\s+)?(?:eating|sleeping|drinking|walking|driving|cooking|napping|showering|heading (?:out|home|to)|hungover|hung over|drunk|tipsy|wasted|stoned)\b/,
  /\b(?:i'?m|im|i am)\s+(?:(?:at|in)\s+)(?:the\s+|my\s+)?(?:gym|office|work|school|airport|bar|pub|club|beach|mall|shop|hospital|dentist|church|kitchen|bathroom|shower|bed|car|bus|train|plane)\b|\bat the gym\b/,
  /\bmy\s+(?:(?:morning|evening|afternoon|weekend|sunday|saturday|usual|first|daily|second)\s+)?(?:coffee|tea|nap|bed|pillow|breakfast|brunch|lunch|dinner|snack|meal|walk|shower|commute)\b/,
  /\bmy\s+(?:(?:morning|evening|daily|weekend)\s+run|(?:weekend|holiday|vacation|evening|day off)\s+plans|kids|kid|wife|husband|girlfriend|boyfriend|gf|bf|apartment|flat|house|car|mom|mum|dad|mother|father|parents|son|daughter|sister|brother|dog|cat|body|back hurts|feet|stomach|hangover)\b/,
  /\b(?:raining|snowing|sunny|freezing|so hot|so cold)\s+(?:here|outside)\b|\boutside my window\b/,
  /\b(?:sunny|rainy|snowy|cloudy|foggy|windy|stormy|freezing|chilly|humid|drizzly)\s+(?:(?:day|morning|afternoon|evening|night)\s+)?(?:here|outside|today|out there)\b/,
  /\b(?:cold|hot|warm|beautiful|lovely|grey|gray|gorgeous|nice|perfect)\s+(?:day|morning|afternoon|evening|night)\s+(?:here|outside|out there)\b/,
  new RegExp(String.raw`${CLAUSE}(?:woke up|waking up|got up|slept|ate|napped|showered|(?:going|heading|off) to bed|took a (?:nap|walk|shower)|got back from|got home)\b`),
  new RegExp(
    String.raw`${CLAUSE}(?:grabbing|grabbed|sipping|sipped|brewing|brewed|making|made|cooking|cooked|eating|drinking|having|had)\s+(?:a |an |my |some |the |this |that )?(?:\w+\s+){0,2}?${FOOD}\b`,
  ),
  new RegExp(String.raw`${CLAUSE}(?:i\s+)?watched\s+(?:a|an|the|that|this|some)\s+(?:\w+\s+){0,2}?(?:movie|film|show|series|episode|documentary|sunset|sunrise|match)\b`),
  new RegExp(String.raw`(?:${CLAUSE}|\b(?:i'?m|im|i am|been|i was)\s+)listening to (?:some |my |a |the |this |that |new )?(?:\w+\s+)?(?:music|lofi|lo-fi|podcasts?|radio|songs?|albums?|vinyl|jazz|playlists?)\b`),
  /\b(?:i'?m|im|i am|i feel|i felt|i get|i got)\s+(?:so |really |a bit |pretty |super |kinda |getting |feeling )?(?:hungry|starving|sleepy|tired|exhausted|thirsty)\b(?!\s+of\b)/,
  /\b(?:ate|slept|cooked|drank|napped|dreamt|dreamed)\b[^.!?]{0,30}\b(?:last night|this morning|tonight|this evening|yesterday|earlier today)\b/,
  /\b(?:last night|this morning|yesterday|earlier today)\b[^.!?]{0,15}\b(?:watched|ate|slept|cooked|drank|napped|dreamt|dreamed)\b/,
  new RegExp(String.raw`${CLAUSE}(?:found|finished|read|reread|borrowed)\s+(?:a|an|the|my|this|that|some|another)\s+(?:\w+\s+){0,2}?${PAGES}\b`),
  new RegExp(String.raw`${CLAUSE}(?:baked|built|painted|knitted|knit|sewed|planted|grew|sketched|drew|made|assembled)\s+(?:a|an|the|my|this|that|some|another)\s+(?:\w+\s+){0,2}?${MADE}\b`),
  new RegExp(String.raw`${CLAUSE}(?:went|walked|hiked|biked|ran|wandered|strolled|headed|drove|popped)\s+(?:over\s+|out\s+|down\s+|back\s+)?(?:to|into|through|around|along|by)\s+(?:a|an|the|my|this|that|some)\s+(?:\w+\s+)?${PLACE}\b`),
  new RegExp(String.raw`${CLAUSE}(?:saw|seen|spotted|watched|noticed|heard)\s+(?:(?:a|an|the|some|this|that)\s+)?(?:\w+\s+){0,3}?${SIGHT}\b`),
  new RegExp(String.raw`${CLAUSE}(?:heard|played|put on|listened to)\s+(?:(?:a|an|the|some|this|that|my)\s+)?(?:\w+\s+){0,2}?${MUSIC}\b`),
  /\b(?:i|i'?ve|i'?m|im|i am|i was)\s+(?:just\s+|finally\s+|been\s+|also\s+|went\s+)?(?:baked|baking|knitted|knitting|gardened|gardening|hiked|hiking|jogged|jogging|swam|swimming|danced|dancing|sang|singing)\b/,
  /\b(?:i'?m|im|i am)\s+(?:\w+\s+)?years old\b/,
].map(U);

/**
 * STRONG PROFANITY. Mild swearing is allowed in banter and roasts (damn,
 * hell, shit, ass, wtf, lmao); the f-word family and "stfu"/"gtfo" are not
 * mild in somebody else's group, under the owner's bot.
 */
const PROFANITY =
  U(/\b(?:f+u+c*k+\w*|f[\W_]?[*@#u][\W_]?[*c][\W_]?k\w*|fck\w*|fuk\w*|fuq\w*|phuck\w*|fk(?:ing|in)?|mother[\s-]?f\w*|mfers?|mofos?|stfu|gtfo)\b/);

/** Nothing sexual. "tit for tat" is an idiom, and goes before the check. */
const SEXUAL =
  U(/\b(?:sex(?:y|ual|ually|ting|ted|ts)?|porn\w*|nudes?|naked|nsfw|horny|dick(?:s|head|heads)?|cocks?|cocksucker|puss(?:y|ies)|cum(?:ming|shot|s)?|jizz|blow[\s-]?jobs?|bj|hand[\s-]?jobs?|jerk(?:ing)? off|wank(?:er|ers|ing)?|masturbat\w*|orgasm\w*|boobs?|tits?|titties|penis|vagina|anal|dildos?|milf|onlyfans|thots?|sluts?|whores?|hookers?|hoes?|suck my|blow me|ride me|sit on my face)\b/);
const SEXUAL_IDIOM = U(/\btit for tat\b/g);

/** Telling anyone to hurt themselves. Never, in any kind of line. */
const SELFHARM: readonly RegExp[] = [
  /\bk[\s.*_-]*y[\s.*_-]*s\b/,
  /\bkill (?:yo)?ur ?self\b|\bkill (?:your|ur) ?selves\b|\bkill yourselves\b/,
  /\bgo die\b|\bdie in a (?:fire|hole|ditch)\b|\b(?:you|u) should (?:just )?die\b/,
  /\bunalive (?:yo)?ur ?self\b|\bunalive (?:your|ur) ?self\b|\bend (?:your|ur) (?:life|self)\b|\bend yourself\b/,
  /\b(?:hang|neck|off|delete|shoot|drown) (?:yo)?urself\b|\bslit (?:your|ur) wrists?\b/,
  // A word or three between is still the same order: "go drink some bleach", "jump off something tall".
  // Not "jumping off a sinking ship": that is how a person leaves a coin.
  /\bdrink (?:\w+ ){0,3}bleach\b|\bjump(?:ing)? off (?:of )?(?:something|anything|an? (?!sinking\b|bandwagon\b|hype\b)\w+|(?:the|some|that|this) (?:\w+ )?(?:bridge|building|cliff|roof|balcony|ledge|tower|skyscraper|pier))\b/,
  /\bstop breathing\b|\b(?:grab|get|buy|find|fetch) (?:a|some|the|yourself a|urself a|yourself some) (?:\w+ )?rope\b|\bwalk off (?:a|the) (?:short |long )?(?:pier|cliff|bridge|roof|ledge)\b/,
  // "hope you don't wake up", "sleep and never wake up"; not "don't wake up the bears".
  /\b(?:don'?t|never|do not) wake up\b(?!\s+(?:the|them|him|her|early|late|too|before|until|till|at|for|on|in|to|from|with|and|when|if)\b)/,
  /\bnobody would miss (?:you|u)\b|\b(?:the )?world (?:would be|is) better (?:off )?without (?:you|u)\b/,
  /\bbetter off dead\b|\bjust end it(?: all)?\b|\buninstall (?:life|yourself|urself|ur life|your life)\b/,
  /\b(?:go )?(?:play|jump|walk|run|lie down) (?:in|into|on) (?:the )?(?:traffic|highway|freeway|motorway|road|tracks)\b/,
].map(U);

/** Threats, doxxing, swatting. "killing it" and "the fees will kill you" are the price of "kill you". */
const THREAT: readonly RegExp[] = [
  /(?<!\b(?:won'?t|wouldn'?t|doesn'?t|didn'?t|never|not|can'?t|cannot)\s)\b(?:kill|murder|hurt|stab|shoot|punch|choke|strangle|smack|slap|end|hunt(?: down)?|rape|beat)\s+(?:you|u|ya|y'?all|your (?:family|kids|mom|dog|house)|ur (?:family|kids|mom))\b/,
  /\b(?:i'?ll|i will|gonna|going to|i'?m gonna|imma|ima|i'?m going to|we'?ll|we will)\s+(?:\w+\s+){0,2}?(?:find|track down|hunt down|come for|pull up on|visit) (?:you|u|ya|where you)\b/,
  /\bi know where (?:you|u|ya|ur|your|y'?all|they|he|she)\b|\bwhere (?:you|u) live\b|\b(?:your|ur) (?:home )?address\b/,
  /\bdox+(?:x|ed|ing|es)?\b|\bswat(?:ting|ted)\b|\bswat (?:you|u|ya)\b/,
  /\bbeat (?:you|u|ya) up\b|\bbeat (?:your|ur) ass\b|\bbeat the (?:shit|crap) out of\b|\bkick (?:your|ur) ass\b/,
  /\bwatch (?:your|ur) back\b|\b(?:you'?re|youre|ur|you are) (?:dead|a dead man|done for)\b|\bsleep with one eye open\b|\bcoming for (?:you|u)\b|\bhope (?:you|u) (?:die|get hit|get cancer|choke|burn|rot)\b/,
  /\brape\b/,
  /\bcoming to (?:your|ur) (?:house|place|home|door|address)\b|\bsee (?:you|u|ya) outside\b|\bmeet me outside\b/,
  /\b(?:break|snap|smash|bust|crack) (?:your|ur|ya|yo) (?:\w+ )?(?:legs?|arms?|neck|face|jaw|teeth|kneecaps?|knees?|skull|head|nose|ribs?|fingers?|back|spine|ankles?)\b/,
  /\bput (?:you|u|ya) (?:in|into|under) (?:the ground|the dirt|a grave|a coffin|a box|a body bag|the hospital|a hospital)\b/,
].map(U);
/** "who hurt you" is a roast, not a threat; "killing it" is praise. Taken out before THREAT reads the line. */
const THREAT_IDIOM = U(/\b(?:who|what|someone|somebody|something|life|it|this|that) (?:hurt|hurts|killed|kills) (?:you|u|ya)\b|\bkilling it\b/g);

/**
 * LOOKS, BODIES AND FAMILY — never a roast's target. Applies to lines that
 * may tease (roast, banter, answer). "fat finger" is a trade typo, not a body.
 */
const APPEARANCE: readonly RegExp[] = [
  /\b(?:ugly|uglier|ugliest|fugly|hideous|fat|fatter|fattest|fatty|fatso|fatass|obese|chubby|skinny|scrawny|bald|balding|pimply|pimples|acne|zits?|toothless|neckbeard|manlet|midget|dwarf|butterface|landwhale|beer belly|double chin|big nose|four[\s-]?eyes|stinky|smelly)\b/,
  /\b(?:your|ur|yo|you'?re|youre|u r|you are|you look|u look)\b[^.!?\n]{0,20}?\b(?:face|body|weight|looks|teeth|tooth|nose|breath|skin|forehead|hairline|haircut|hair|height|belly|gut|chin|ears|mom|mum|mother|mama|momma|mommy|moms|dad|daddy|father|papa|pops|old man|old lady|sister|sis|siblings?|brother|wife|wifey|girlfriend|gf|husband|hubby|boyfriend|bf|kid|kiddo|kids|children|son|daughter|family|grandma|granny|grandmother|grandpa|parents|folks|aunt|uncle|cousin)\b/,
  /\byo (?:mama|momma|mom|mum)\b|\b(?:you|u|ya) (?:look|looks|looking) like\b/,
].map(U);
const APPEARANCE_IDIOM = U(/\bfat[\s-]?finger(?:ed|s)?\b/g);

// ── hate ────────────────────────────────────────────────────────────────────

/**
 * SLURS ARE CHECKED BY HASH, so the list is not a list anybody can read in
 * this file. Each entry is fnv1a of a slur as `hateSpelling` spells it
 * (lowercase letters, lookalikes and leetspeak folded): EXACT as written,
 * LOOSE with every run of a repeated letter collapsed. A line's words — and
 * every two or three adjacent words run together, and a spelled-out run of
 * single letters, and a word with a "*" standing for a vowel — are hashed the
 * same way. A word matches when:
 *   · its spelling is on the list; or
 *   · it stretches a letter three times or more ("niiiice"), and its collapsed
 *     spelling is a collapsed entry — stretching is how a slur hides; or
 *   · it doubles a letter and its collapsed spelling is an entry that has no
 *     double letter at all.
 * A word is never collapsed when it has no run, because collapsing the list
 * alone would turn innocent words into entries ("con", a country's name).
 * A trailing s or z is tried off too (plurals). Checked against the whole of
 * /usr/share/dict/words when the list was built: no English word matches.
 */
const HATE_EXACT = new Set<string>(
  (
    "19mj789 1ogqgnx 1hyjw1b 16w61hn 1e2pgbp 1n3nn2q i4gxy7 q7celv vmi7p0 8fmtkf 1s6uih8 1867rv3 " +
    "vaxalk row9b0 1v7p2w2 1xifnkp e4iz3o 1wfnhou yhn7h1 1x6y0cl s2vhx0 q3ld0h 1p1uv49 jclsop " +
    "8ze58x 1um3b1v f79hgw 1ubmu64 5kl94a 1wktobu 1ycbij3 1vngl4n eyuhx2 10yzs8e 1wyxkpq 9epqb5 " +
    "1ongl9g nbg6i2 mf4x20 ttk60e 1qp8t09 ze6d0t vhj70f reddm0 xfur5q 3apq34 1bxbdau clvtc6 " +
    "1h486qh 11sx6ip 1gz1sbg w1l9s4 yy78ri vy4ozg 1ddoja5 15fvo3p 14cidxf 1g0owtg 157bpup rkfry0 " +
    "5wga14 81q8rh 15wv286 1ihhxdj ykn8e7 19o6l49 14fkbtf"
  )
    .split(" ")
    .filter(Boolean),
);
const HATE_LOOSE = new Set<string>(
  (
    "1pui64u alxa6s 1tqp7uc 1rguphs 1puus4q 1n3nn2q i4gxy7 q7celv vmi7p0 8fmtkf yb0krv vaxalk " +
    "ebeul4 1uqtr9n 1u03u33 e4iz3o 1wfnhou yhn7h1 fufiw0 s2vhx0 lpqac9 1p1uv49 jclsop 1b04os " +
    "1um3b1v f79hgw 1ubmu64 5kl94a 1wktobu 1ycbij3 8wcyt8 eyuhx2 10yzs8e dfsspj 9epqb5 1ongl9g " +
    "nbg6i2 mf4x20 1qp8t09 ze6d0t vhj70f reddm0 9k9iyp 1ph5sj9 1v73x2q clvtc6 1h486qh qzk4k3 " +
    "w8n5jm w1l9s4 yy78ri vy4ozg 1ddoja5 1gepina 1jqt9ko yx8x5x 157bpup rkfry0 5wga14 81q8rh " +
    "15wv286 1ihhxdj ykn8e7 19o6l49 14fkbtf"
  )
    .split(" ")
    .filter(Boolean),
);

/** Leetspeak read as letters; the second variant reads 1, | and ! as "l" instead of "i". */
const LEET: Readonly<Record<string, string>> = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "6": "g", "7": "t", "8": "b", "9": "g",
  "@": "a", "$": "s", "!": "i", "|": "i", "+": "t", "€": "e", "¡": "i",
};
const LEET_L: Readonly<Record<string, string>> = { "1": "l", "|": "l", "!": "l" };

/**
 * A text spelled the way the slur list is hashed: marks stripped, lowercased,
 * lookalikes and leetspeak folded, apostrophes and dots INSIDE a word removed
 * ("n.i.g", "f'ing"), everything else that is not a letter or "*" a space.
 */
function hateSpelling(s: string, variant: 0 | 1): string {
  const bare = scrub(s, false).normalize("NFKD").replace(/\p{M}/gu, "").normalize("NFKC").toLowerCase();
  const chars = Array.from(foldOf(bare));
  let out = "";
  chars.forEach((ch, i) => {
    // Digits always read as letters ("sh1t"); a symbol only when a letter or
    // digit follows it ("n!ce", "$pic"), so "wow!" keeps its punctuation.
    const symbol = !/[0-9]/.test(ch) && ch in LEET;
    if (symbol && !/[\p{L}\p{N}]/u.test(chars[i + 1] ?? "")) {
      out += ch;
      return;
    }
    out += (variant === 1 ? LEET_L[ch] : undefined) ?? LEET[ch] ?? ch;
  });
  return out.replace(/(?<=[\p{L}*])['’`.\-_]+(?=[\p{L}*])/gu, "").replace(/[^\p{L}*]+/gu, " ").trim();
}

function collapse(w: string): string {
  return w.replace(/(\p{L})\1+/gu, "$1");
}

/** The two hashes a slur is stored under. Exported for the test hook and the list builder, never for a caller. */
export function hateHashesOf(word: string): { exact: string; loose: string } {
  const w = hateSpelling(word, 0).replace(/[\s*]+/g, "");
  return { exact: fnv1a(w), loose: fnv1a(collapse(w)) };
}

function slurWord(tok: string): boolean {
  const forms = [tok];
  if (/[sz]$/.test(tok) && tok.length > 3) forms.push(tok.slice(0, -1));
  for (const t of forms) {
    if (HATE_EXACT.has(fnv1a(t))) return true;
    const c = collapse(t);
    if (c === t) continue;
    if (/(\p{L})\1\1/u.test(t) && HATE_LOOSE.has(fnv1a(c))) return true;
    if (HATE_EXACT.has(fnv1a(c))) return true;
  }
  return false;
}

/** A "*" standing in for a letter ("f*g"): every vowel is tried. At most two stars per word. */
function starForms(tok: string): string[] {
  const stars = (tok.match(/\*/g) ?? []).length;
  if (stars === 0) return [tok];
  if (stars > 2 || tok.replace(/\*/g, "").length < 2) return [];
  let forms = [tok];
  for (let i = 0; i < stars; i++) forms = forms.flatMap((f) => "aeiou".split("").map((v) => f.replace("*", v)));
  return forms;
}

function hasSlur(text: string): boolean {
  if (HATE_EXACT.size === 0) return false;
  for (const variant of [0, 1] as const) {
    const toks = hateSpelling(text, variant).split(" ").filter(Boolean);
    const cands = new Set<string>();
    let run = "";
    for (let i = 0; i < toks.length; i++) {
      cands.add(toks[i]!);
      if (i + 1 < toks.length) cands.add(toks[i]! + toks[i + 1]!);
      if (i + 2 < toks.length) cands.add(toks[i]! + toks[i + 1]! + toks[i + 2]!);
      if (toks[i]!.length === 1) run += toks[i]!;
      else {
        if (run.length >= 3) cands.add(run);
        run = "";
      }
    }
    if (run.length >= 3) cands.add(run);
    for (const c of cands) {
      if (c.length < 3 || c.length > 40) continue;
      for (const f of starForms(c)) if (slurWord(f)) return true;
    }
  }
  return false;
}

/**
 * PROTECTED TRAITS (race, ethnicity, nationality, religion, gender,
 * sexuality, disability): a trait word within four words of an insult is an
 * attack on the trait, whoever the line is aimed at. "black" and "white" are
 * colours ("black candles") unless people follow them. A trait said with no
 * insult near it ("gm to the aussies") passes.
 */
const TRAITS: ReadonlySet<string> = new Set(
  (
    "race races racial ethnic ethnicity asian asians african africans arab arabs hispanic hispanics latino latinos latina latinas latinx " +
    "mexican mexicans chinese japanese korean koreans indian indians pakistani pakistanis nigerian nigerians russian russians ukrainian " +
    "ukrainians filipino filipinos vietnamese turkish turks persian persians iranian iranians iraqi iraqis afghan afghans syrian syrians " +
    "somali somalis ethiopian ethiopians haitian haitians jamaican jamaicans brazilian brazilians irish italian italians french german " +
    "germans british brits american americans canadian canadians australian australians aussies european europeans israeli israelis " +
    "palestinian palestinians gypsy gypsies roma romani aboriginal aboriginals indigenous caucasian caucasians immigrant immigrants migrant " +
    "migrants refugee refugees foreigner foreigners blacks whites jew jews jewish muslim muslims islam islamic christian christians " +
    "christianity catholic catholics protestant protestants hindu hindus sikh sikhs buddhist buddhists mormon mormons atheist atheists " +
    "religion religious gay gays lesbian lesbians bisexual bisexuals queer queers trans transgender transgenders nonbinary lgbt lgbtq " +
    "homosexual homosexuals gender women woman girls female females disabled disability handicapped autistic autism deaf wheelchair"
  ).split(" "),
);
/** A colour word or "your"/"you" before a people word is a trait too: "black people", "your country", "you people". */
const TRAIT_PAIR =
  U(/\b(?:black|white|brown|yellow)\s+(?:people|folks|guys|men|women|girls|kids|dudes|person|persons)\b|\b(?:your|ur)\s+(?:country|people|kind|race|religion|god|culture|tribe)\b|\byou people\b|\bthird world\b/);
const INSULTS: ReadonlySet<string> = new Set(
  (
    "stupid dumb dumber dumbest idiot idiots idiotic moron morons moronic trash garbage filth filthy dirty disgusting gross inferior subhuman " +
    "animal animals vermin pest pests parasite parasites rats roaches cockroaches savage savages lazy criminal criminals crook crooks thief " +
    "thieves thug thugs terrorist terrorists primitive backward backwards evil worthless useless pathetic greedy smelly stink stinky stinks " +
    "hate hates hated hating despise suck sucks cancer plague disease diseased degenerate degenerates freak freaks abomination pervert " +
    "perverts deport deported exterminate cleanse worst ugly scum scummy scammer scammers loser losers clown clowns apes monkeys brainless " +
    "cheap stingy typical"
  ).split(" "),
);
const INSULT_PHRASE =
  U(/\bgo back\b|\bdon'?t belong\b|\bshouldn'?t be allowed\b|\bshould be banned\b|\ball the same\b|\bcan'?t stand\b|\bget out\b|\bsend (?:them|em) back\b|\bnot welcome\b|\bno place\b|\b(?:control|run|own)s? (?:the )?(?:banks|media|world|money)\b/);
/** Traits said to a person's face ("you're gay", "ur autistic"), a trait used as the insult ("so gay", "like a girl"), "no homo". */
const TRAIT_AS_INSULT =
  U(/\b(?:that'?s|thats|so|you'?re|youre|ur|u r|you are|is|how|sounds|looks|kinda|real|super)\s+(?:so\s+|really\s+|pretty\s+|kinda\s+)?gay\b|\bno homo\b|\blike a girl\b/);
/**
 * Any trait used AS the insult, not only "gay": "that's so autistic",
 * "acting all disabled", "sounds jewish". The trait word is captured and
 * looked up in TRAITS, so the list of traits is kept in one place.
 */
const TRAIT_AS_WORD = U(/\b(?:that'?s|thats|so|sounds?|acting(?:\s+all)?|kinda|real|super)\s+(?:so\s+|really\s+|pretty\s+)?([a-z]+)\b/g);
const YOU_ARE = U(/\b(?:you'?re|youre|ur|u r|you are|u are)\s+(?:a |an |so |such an? |totally |literally )?([a-z]+)\b/g);
/** A trait made an intensifier: "gay ass take", "autistic af". */
const TRAIT_ASS = U(/\b([a-z]+)[\s-]+(?:ass|af|asf)\b/g);

/**
 * "GO BACK TO …" IN A LINE THAT TEASES. Telling someone to go back to a
 * country is the attack whatever the country, and no list of places is
 * complete, so in a roast, banter or answer the words after it must be one
 * of the things a person is sent back to in fun: bed, lurking, the charts,
 * their bags. Anything else is refused as hateful.
 */
const GO_BACK_TO = U(
  /\bgo(?:\s+on)?\s+back\s+to\s+(?!(?:bed|sleep|sleeping|lurking|lurk|work|school|class|basics|reddit|twitter|tiktok|discord|robinhood|paper trading|buying|chasing|trading|holding|shilling|posting|scrolling|watching|waiting|coping|crying|the (?:drawing board|kiddie pool|charts?|basics|start|beginning|trenches|lobby|topic)|(?:your|ur) (?:bags?|charts?|basement|cave|corner|desk|day job|job|screen|hole|lurking|paper hands))\b)/,
);
/** "go back where you came from", with or without the "to": in any line. */
const GO_BACK_WHERE = U(/\bgo(?:\s+on)?\s+back\s+(?:to\s+)?where (?:you|u|ya|they|he|she|y'?all|them) (?:(?:came|come|are|r) from|belong)\b/);

function traitAttack(t: string): boolean {
  if (TRAIT_AS_INSULT.test(t) || GO_BACK_WHERE.test(t)) return true;
  for (const m of t.matchAll(TRAIT_AS_WORD)) if (TRAITS.has(m[1]!)) return true;
  for (const m of t.matchAll(YOU_ARE)) if (TRAITS.has(m[1]!) || /^(?:black|white|brown)$/.test(m[1]!)) return true;
  for (const m of t.matchAll(TRAIT_ASS)) if (TRAITS.has(m[1]!)) return true;
  const toks = t.match(/[\p{L}\p{N}']+/gu) ?? [];
  const at: number[] = [];
  toks.forEach((w, i) => {
    if (TRAITS.has(w)) at.push(i);
  });
  // A pair is placed at its first word: count the words before where it starts.
  for (const m of t.matchAll(new RegExp(TRAIT_PAIR.source, "gu"))) at.push((t.slice(0, m.index).match(/[\p{L}\p{N}']+/gu) ?? []).length);
  for (const i of at) {
    const lo = Math.max(0, i - 4);
    const window = toks.slice(lo, i + 6);
    if (window.some((w) => INSULTS.has(w))) return true;
    if (INSULT_PHRASE.test(window.join(" "))) return true;
  }
  return false;
}

/** Test hook: register a harmless stand-in word as if it were a slur, so tests never spell one. Returns the undo. */
export function __addHateHashForTest(word: string): () => void {
  const h = hateHashesOf(word);
  const addedExact = !HATE_EXACT.has(h.exact);
  const addedLoose = !HATE_LOOSE.has(h.loose);
  HATE_EXACT.add(h.exact);
  HATE_LOOSE.add(h.loose);
  return () => {
    if (addedExact) HATE_EXACT.delete(h.exact);
    if (addedLoose) HATE_LOOSE.delete(h.loose);
  };
}

// ── paper ───────────────────────────────────────────────────────────────────

/**
 * PAPER SAID OUT LOUD. A buy on paper says "paper", "practice" or "on paper";
 * "paper hands" and a white paper do not count. A real-money line never
 * claims paper (as a phrase about the money: "on paper it looks fine" is the
 * idiom), and a paper line never claims real money.
 */
const NOT_PAPER_MONEY = U(/\bpaper[\s-]*hand(?:s|ed)?\b|\bwhite[\s-]*papers?\b|\bwhitepapers?\b|\bpaper[\s-]*(?:towels?|trails?|cuts?|thin|planes?)\b/g);
const PAPER_PHRASE =
  U(/\bpaper[\s-]*(?:trad(?:e|es|ed|ing|er)|money|mode|buys?|bought|accounts?|positions?|portfolio|book|bets?|only)\b|\bpractice[\s-]*(?:money|cash|trad(?:e|es|ed|ing)|mode|accounts?|runs?|rounds?)\b|\bwith practice\b|\bnot real money\b|\b(?:only|just) practice\b/);
const ON_PAPER_CLAIM =
  U(/\b(?:bought|buys?|buying|picked(?: up)?|picking(?: up)?|grabbed|grabbing|got|added|adding|trad(?:e|es|ed|ing)|positions?|went with|going with|took|taking|tried|trying|entered|holding|held|aped)\b[^.!?]{0,40}\bon paper\b|\b(?:i'?m|im|i am|still|stay(?:ing)?|all|everything(?:'s| is)?|only|just|it was|was|it'?s|its)\s+(?:on )?paper\b|\bon paper (?:for now|for a while|for the moment|still|so far|these days|lately|this week|today|again|only|mostly)\b/);
const PAPER_WORD = U(/\bpaper\b|\bpractice\b/);
const SAYS_REAL_MONEY = U(/(?<!\b(?:not|no|never|isn'?t|wasn'?t|aren'?t)\s+(?:with\s+|using\s+|any\s+)?)\breal (?:money|cash)\b/);

function saysPaper(t: string): boolean {
  const u = t.replace(NOT_PAPER_MONEY, " ");
  return PAPER_PHRASE.test(u) || PAPER_WORD.test(u);
}

function claimsPaper(t: string): boolean {
  const u = t.replace(NOT_PAPER_MONEY, " ");
  return PAPER_PHRASE.test(u) || ON_PAPER_CLAIM.test(u);
}

// ── names ───────────────────────────────────────────────────────────────────

function strings(list: unknown): string[] {
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
}

/**
 * THE NAMES A LINE MAY SAY, taken out before the figure, money and ops
 * clauses only: "Mike99" is a name, not a figure, and "grant, you're funny"
 * talks to Grant about nothing operational. A name that reads as a figure
 * itself ("Up 400x", "Ten", "Agent 47", "$100 Gang") is never taken out, so a
 * line that says it is judged as if it said the figure; nor is one that holds
 * a money unit ("Sol", "Bucks"), so the unit is still there beside a digit.
 *
 * Every other clause reads the line with its names in. A display name is
 * chosen by whoever holds it, so a stranger who names himself "buy now",
 * "i'm human" or a slur must not get those words said for him — the price is
 * that a roast of somebody called Christian that also calls him dumb is
 * dropped (a trait word beside an insult).
 */
function nameStripper(agentName: string, names: readonly string[]): RegExp | null {
  const out = new Set<string>();
  for (const n of [agentName, ...names]) {
    const base = n.replace(/^\s*[@＠]+/u, "");
    for (const v of [shownOf(base), canonOf(base), bareOf(base), foldOf(bareOf(base).toLowerCase())]) {
      const low = v.toLowerCase();
      if (low.length < 2 || !/\p{L}/u.test(low)) continue;
      if (QUANTITY.test(low) || FIGURE_NAME.test(low) || STANDALONE_NUMBER.test(low) || MONEY.some((re) => re.test(low))) continue;
      // A name holding a money unit as a word of its own ("Sol", "Bucks",
      // "Rand Paul", a coin called "USDC") stays in: taken out, it would take
      // the unit with it and leave "3 sol" reading as a harmless "3".
      if (UNIT_WORD.test(low)) continue;
      out.add(low);
    }
  }
  if (out.size === 0) return null;
  const alt = [...out].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
  return new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_])(?:${alt})(?![\\p{L}\\p{N}\\p{M}_])`, "giu");
}

function lowNames(agentName: string, names: readonly string[]): string[] {
  return [agentName, ...names].map((n) => canonOf(n.replace(/^\s*[@＠]+/u, "")).toLowerCase()).filter((n) => n !== "");
}

// ── the gate ────────────────────────────────────────────────────────────────

/**
 * MAY THE AGENT SAY THIS IN A GROUP? `ok` carries the exact text to send.
 *
 * Reason codes (stable, log-only): empty · pass · hidden-chars · meta · dodge ·
 * too-long · secret · address · link · handle · cashtag · hateful · selfharm · threat ·
 * sexual · profanity · appearance · money · figures · alert · advice · claim · accuse ·
 * private · ops · human · emoji · paper-unsaid · repeat.
 *
 * Ordered so the reason names the most specific and most serious fault: a
 * secret before an address (a key is also hex), a slur before a word list.
 * Order never changes WHETHER a line passes, only what the log says.
 */
export function admitTgLine(raw: unknown, ctx: TgGateCtx): TgVerdict {
  const s = typeof raw === "string" ? raw : "";
  if (s.length > RAW_CEILING) return refuse("too-long");
  const kind = KINDS.has(ctx?.kind as string) ? ctx.kind : null;
  const agentName = typeof ctx?.agentName === "string" ? ctx.agentName.trim() : "";
  const names = strings(ctx?.names);

  const tidied = tidyTgLine(s, agentName);
  const lines = tidied.split("\n").map(shownOf).filter((l) => l !== "");
  if (lines.length === 0) return refuse("empty");
  const r = readingsOf(tidied);
  if (r.shown === "") return refuse("empty");
  // A model deciding it has nothing to say is the design working.
  if (isPass(r)) return refuse("pass");
  if (PAYLOAD_CHARS.test(tidied)) return refuse("hidden-chars");
  if (metaRefusal(r)) return refuse("meta");
  if (dodgeRefusal(r)) return refuse("dodge");

  // No floor: "same", "lol" and "ok ok 🤐" are whole lines in a group.
  if (Array.from(lines.join("\n")).length > TG_LINE_MAX) return refuse("too-long");
  if (lines.length > TG_LINE_MAX_SENTENCES || sentenceCount(lines) > TG_LINE_MAX_SENTENCES) return refuse("too-long");

  if (containsSecret(s, []) || r.cased.some((t) => SECRET_SHAPES.some((re) => re.test(t)) || hasKeypairRun(t) || hasMnemonicRun(t))) {
    return refuse("secret");
  }
  if (r.cased.some((t) => ADDRESS_SHAPES.some((re) => re.test(t)) || hasEncodedRun(t)) || r.joined.some((t) => ADDRESS_SHAPES.some((re) => re.test(t)) || hasEncodedRun(t))) {
    return refuse("address");
  }
  if (r.cased.some((t) => LINK_SHAPES.some((re) => re.test(t))) || r.joined.some((t) => LINK_SHAPES.some((re) => re.test(t)))) return refuse("link");
  if (some(r.cased, HANDLE)) return refuse("handle");
  // A line about a coin says no cashtag at all; any other says only a
  // person's chosen "$Name", never the coin's (TgGateCtx.cashtagNames).
  const tagNames = kind === null || FIGURE_KINDS.has(kind) ? [] : Array.isArray(ctx?.cashtagNames) ? strings(ctx.cashtagNames) : names;
  if (cashtagRefusal([...r.cased, ...r.low], tagNames)) return refuse("cashtag");
  if (markupRefusal(r, lowNames(agentName, names))) return refuse("meta");

  // The worst first: hate, harm, threats, sex — then looks.
  if (hasSlur(tidied) || r.low.some(traitAttack)) return refuse("hateful");
  if ((kind === null || TEASE_KINDS.has(kind)) && some(r.low, GO_BACK_TO)) return refuse("hateful");
  if (r.low.some((t) => SELFHARM.some((re) => re.test(t)))) return refuse("selfharm");
  if (r.low.some((t) => THREAT.some((re) => re.test(t.replace(THREAT_IDIOM, " "))))) return refuse("threat");
  if (r.low.some((t) => SEXUAL.test(t.replace(SEXUAL_IDIOM, " ")))) return refuse("sexual");
  if (some(r.low, PROFANITY)) return refuse("profanity");
  if ((kind === null || TEASE_KINDS.has(kind)) && r.low.some((t) => APPEARANCE.some((re) => re.test(t.replace(APPEARANCE_IDIOM, " "))))) {
    return refuse("appearance");
  }

  // NAMES OUT for the figure, money and ops clauses only (see nameStripper).
  const strip = nameStripper(agentName, names);
  const unnamed = strip ? r.low.map((t) => t.replace(strip, " ")) : r.low;
  if (unnamed.some((t) => MONEY.some((re) => re.test(t)))) return refuse("money");
  if (kind === null || FIGURE_KINDS.has(kind)) {
    if (unnamed.some((t) => NUMERAL.test(t) || QUANTITY.test(t) || CJK_NUMERAL.test(t))) return refuse("figures");
  }

  if (r.low.some((t) => ALERT.some((re) => re.test(t))) || some(r.cased, ALERT_CAPS) || ALERT_EMOJI.test(r.shown)) return refuse("alert");
  if (r.low.some((t) => ADVICE.some((re) => re.test(t)))) return refuse("advice");
  if ((kind === null || FIGURE_KINDS.has(kind)) && r.low.some((t) => ADVICE_COIN.some((re) => re.test(t)))) return refuse("advice");
  if ((kind === null || CLAIM_KINDS.has(kind)) && r.low.some((t) => TRADE_CLAIM.some((re) => re.test(t)))) return refuse("claim");
  if (r.low.some((t) => ACCUSE.some((re) => re.test(t)))) return refuse("accuse");
  if (unnamed.some((t) => ID_RUN.test(t)) || r.low.some((t) => PRIVATE.some((re) => re.test(t.replace(PRIVATE_IDIOM, " "))))) return refuse("private");
  if (unnamed.some((t) => OPS.test(t.replace(OPS_IDIOM, " ")))) return refuse("ops");
  if (r.low.some((t) => HUMAN.some((re) => re.test(t)))) return refuse("human");

  if (emojiCount(lines.join(" ")) > TG_LINE_MAX_EMOJI) return refuse("emoji");

  // PAPER IS SAID, AND NOTHING FALSE ABOUT THE MONEY.
  const paper = typeof ctx?.paper === "boolean" ? ctx.paper : null;
  if (kind === "buy" && paper === null) return refuse("paper-unsaid");
  if (kind === "buy" && paper === true && !r.low.some(saysPaper)) return refuse("paper-unsaid");
  if (paper === true && some(r.low, SAYS_REAL_MONEY)) return refuse("paper-unsaid");
  if (paper === false && r.low.some(claimsPaper)) return refuse("paper-unsaid");

  // NEVER ITS OWN SENTENCE AGAIN. similarity() reads a-z content words, so a
  // short line with none ("ok ok 🤐") is never a repeat. A line in another
  // script has no a-z words for it to read, so three words or more said again
  // word for word are a repeat. "lol" after "lol" is one: a person does not
  // send the same "lol" twice running, and pacing decides which of its own
  // lines the caller hands in.
  if (kind !== "fixed") {
    const mine = canonOf(tidied).toLowerCase();
    for (const prev of strings(ctx?.recentOwn)) {
      const was = canonOf(prev).toLowerCase();
      if (similarity(mine, was) >= REPEAT_LIMIT) return refuse("repeat");
      if (was === mine && similarity(mine, mine) === 0 && (mine.match(/\p{L}+/gu) ?? []).length >= 3) return refuse("repeat");
    }
  }

  return { ok: true, text: lines.join("\n") };
}

// ── the BIP-39 English wordlist ─────────────────────────────────────────────

/**
 * THE 2,048 WORDS A RECOVERY PHRASE IS MADE OF, vendored: the only copy on
 * disk is a transitive dependency an upgrade could move. gate.test.ts pins the
 * list's sha256 against the published english.txt.
 */
const BIP39_ENGLISH: readonly string[] = [
  "abandon ability able about above absent absorb abstract absurd abuse access accident account",
  "accuse achieve acid acoustic acquire across act action actor actress actual adapt add addict",
  "address adjust admit adult advance advice aerobic affair afford afraid again age agent agree",
  "ahead aim air airport aisle alarm album alcohol alert alien all alley allow almost alone alpha",
  "already also alter always amateur amazing among amount amused analyst anchor ancient anger angle",
  "angry animal ankle announce annual another answer antenna antique anxiety any apart apology",
  "appear apple approve april arch arctic area arena argue arm armed armor army around arrange",
  "arrest arrive arrow art artefact artist artwork ask aspect assault asset assist assume asthma",
  "athlete atom attack attend attitude attract auction audit august aunt author auto autumn average",
  "avocado avoid awake aware away awesome awful awkward axis baby bachelor bacon badge bag balance",
  "balcony ball bamboo banana banner bar barely bargain barrel base basic basket battle beach bean",
  "beauty because become beef before begin behave behind believe below belt bench benefit best",
  "betray better between beyond bicycle bid bike bind biology bird birth bitter black blade blame",
  "blanket blast bleak bless blind blood blossom blouse blue blur blush board boat body boil bomb",
  "bone bonus book boost border boring borrow boss bottom bounce box boy bracket brain brand brass",
  "brave bread breeze brick bridge brief bright bring brisk broccoli broken bronze broom brother",
  "brown brush bubble buddy budget buffalo build bulb bulk bullet bundle bunker burden burger burst",
  "bus business busy butter buyer buzz cabbage cabin cable cactus cage cake call calm camera camp",
  "can canal cancel candy cannon canoe canvas canyon capable capital captain car carbon card cargo",
  "carpet carry cart case cash casino castle casual cat catalog catch category cattle caught cause",
  "caution cave ceiling celery cement census century cereal certain chair chalk champion change",
  "chaos chapter charge chase chat cheap check cheese chef cherry chest chicken chief child chimney",
  "choice choose chronic chuckle chunk churn cigar cinnamon circle citizen city civil claim clap",
  "clarify claw clay clean clerk clever click client cliff climb clinic clip clock clog close cloth",
  "cloud clown club clump cluster clutch coach coast coconut code coffee coil coin collect color",
  "column combine come comfort comic common company concert conduct confirm congress connect",
  "consider control convince cook cool copper copy coral core corn correct cost cotton couch",
  "country couple course cousin cover coyote crack cradle craft cram crane crash crater crawl crazy",
  "cream credit creek crew cricket crime crisp critic crop cross crouch crowd crucial cruel cruise",
  "crumble crunch crush cry crystal cube culture cup cupboard curious current curtain curve cushion",
  "custom cute cycle dad damage damp dance danger daring dash daughter dawn day deal debate debris",
  "decade december decide decline decorate decrease deer defense define defy degree delay deliver",
  "demand demise denial dentist deny depart depend deposit depth deputy derive describe desert",
  "design desk despair destroy detail detect develop device devote diagram dial diamond diary dice",
  "diesel diet differ digital dignity dilemma dinner dinosaur direct dirt disagree discover disease",
  "dish dismiss disorder display distance divert divide divorce dizzy doctor document dog doll",
  "dolphin domain donate donkey donor door dose double dove draft dragon drama drastic draw dream",
  "dress drift drill drink drip drive drop drum dry duck dumb dune during dust dutch duty dwarf",
  "dynamic eager eagle early earn earth easily east easy echo ecology economy edge edit educate",
  "effort egg eight either elbow elder electric elegant element elephant elevator elite else embark",
  "embody embrace emerge emotion employ empower empty enable enact end endless endorse enemy energy",
  "enforce engage engine enhance enjoy enlist enough enrich enroll ensure enter entire entry",
  "envelope episode equal equip era erase erode erosion error erupt escape essay essence estate",
  "eternal ethics evidence evil evoke evolve exact example excess exchange excite exclude excuse",
  "execute exercise exhaust exhibit exile exist exit exotic expand expect expire explain expose",
  "express extend extra eye eyebrow fabric face faculty fade faint faith fall false fame family",
  "famous fan fancy fantasy farm fashion fat fatal father fatigue fault favorite feature february",
  "federal fee feed feel female fence festival fetch fever few fiber fiction field figure file film",
  "filter final find fine finger finish fire firm first fiscal fish fit fitness fix flag flame",
  "flash flat flavor flee flight flip float flock floor flower fluid flush fly foam focus fog foil",
  "fold follow food foot force forest forget fork fortune forum forward fossil foster found fox",
  "fragile frame frequent fresh friend fringe frog front frost frown frozen fruit fuel fun funny",
  "furnace fury future gadget gain galaxy gallery game gap garage garbage garden garlic garment gas",
  "gasp gate gather gauge gaze general genius genre gentle genuine gesture ghost giant gift giggle",
  "ginger giraffe girl give glad glance glare glass glide glimpse globe gloom glory glove glow glue",
  "goat goddess gold good goose gorilla gospel gossip govern gown grab grace grain grant grape",
  "grass gravity great green grid grief grit grocery group grow grunt guard guess guide guilt",
  "guitar gun gym habit hair half hammer hamster hand happy harbor hard harsh harvest hat have hawk",
  "hazard head health heart heavy hedgehog height hello helmet help hen hero hidden high hill hint",
  "hip hire history hobby hockey hold hole holiday hollow home honey hood hope horn horror horse",
  "hospital host hotel hour hover hub huge human humble humor hundred hungry hunt hurdle hurry hurt",
  "husband hybrid ice icon idea identify idle ignore ill illegal illness image imitate immense",
  "immune impact impose improve impulse inch include income increase index indicate indoor industry",
  "infant inflict inform inhale inherit initial inject injury inmate inner innocent input inquiry",
  "insane insect inside inspire install intact interest into invest invite involve iron island",
  "isolate issue item ivory jacket jaguar jar jazz jealous jeans jelly jewel job join joke journey",
  "joy judge juice jump jungle junior junk just kangaroo keen keep ketchup key kick kid kidney kind",
  "kingdom kiss kit kitchen kite kitten kiwi knee knife knock know lab label labor ladder lady lake",
  "lamp language laptop large later latin laugh laundry lava law lawn lawsuit layer lazy leader",
  "leaf learn leave lecture left leg legal legend leisure lemon lend length lens leopard lesson",
  "letter level liar liberty library license life lift light like limb limit link lion liquid list",
  "little live lizard load loan lobster local lock logic lonely long loop lottery loud lounge love",
  "loyal lucky luggage lumber lunar lunch luxury lyrics machine mad magic magnet maid mail main",
  "major make mammal man manage mandate mango mansion manual maple marble march margin marine",
  "market marriage mask mass master match material math matrix matter maximum maze meadow mean",
  "measure meat mechanic medal media melody melt member memory mention menu mercy merge merit merry",
  "mesh message metal method middle midnight milk million mimic mind minimum minor minute miracle",
  "mirror misery miss mistake mix mixed mixture mobile model modify mom moment monitor monkey",
  "monster month moon moral more morning mosquito mother motion motor mountain mouse move movie",
  "much muffin mule multiply muscle museum mushroom music must mutual myself mystery myth naive",
  "name napkin narrow nasty nation nature near neck need negative neglect neither nephew nerve nest",
  "net network neutral never news next nice night noble noise nominee noodle normal north nose",
  "notable note nothing notice novel now nuclear number nurse nut oak obey object oblige obscure",
  "observe obtain obvious occur ocean october odor off offer office often oil okay old olive",
  "olympic omit once one onion online only open opera opinion oppose option orange orbit orchard",
  "order ordinary organ orient original orphan ostrich other outdoor outer output outside oval oven",
  "over own owner oxygen oyster ozone pact paddle page pair palace palm panda panel panic panther",
  "paper parade parent park parrot party pass patch path patient patrol pattern pause pave payment",
  "peace peanut pear peasant pelican pen penalty pencil people pepper perfect permit person pet",
  "phone photo phrase physical piano picnic picture piece pig pigeon pill pilot pink pioneer pipe",
  "pistol pitch pizza place planet plastic plate play please pledge pluck plug plunge poem poet",
  "point polar pole police pond pony pool popular portion position possible post potato pottery",
  "poverty powder power practice praise predict prefer prepare present pretty prevent price pride",
  "primary print priority prison private prize problem process produce profit program project",
  "promote proof property prosper protect proud provide public pudding pull pulp pulse pumpkin",
  "punch pupil puppy purchase purity purpose purse push put puzzle pyramid quality quantum quarter",
  "question quick quit quiz quote rabbit raccoon race rack radar radio rail rain raise rally ramp",
  "ranch random range rapid rare rate rather raven raw razor ready real reason rebel rebuild recall",
  "receive recipe record recycle reduce reflect reform refuse region regret regular reject relax",
  "release relief rely remain remember remind remove render renew rent reopen repair repeat replace",
  "report require rescue resemble resist resource response result retire retreat return reunion",
  "reveal review reward rhythm rib ribbon rice rich ride ridge rifle right rigid ring riot ripple",
  "risk ritual rival river road roast robot robust rocket romance roof rookie room rose rotate",
  "rough round route royal rubber rude rug rule run runway rural sad saddle sadness safe sail salad",
  "salmon salon salt salute same sample sand satisfy satoshi sauce sausage save say scale scan",
  "scare scatter scene scheme school science scissors scorpion scout scrap screen script scrub sea",
  "search season seat second secret section security seed seek segment select sell seminar senior",
  "sense sentence series service session settle setup seven shadow shaft shallow share shed shell",
  "sheriff shield shift shine ship shiver shock shoe shoot shop short shoulder shove shrimp shrug",
  "shuffle shy sibling sick side siege sight sign silent silk silly silver similar simple since",
  "sing siren sister situate six size skate sketch ski skill skin skirt skull slab slam sleep",
  "slender slice slide slight slim slogan slot slow slush small smart smile smoke smooth snack",
  "snake snap sniff snow soap soccer social sock soda soft solar soldier solid solution solve",
  "someone song soon sorry sort soul sound soup source south space spare spatial spawn speak",
  "special speed spell spend sphere spice spider spike spin spirit split spoil sponsor spoon sport",
  "spot spray spread spring spy square squeeze squirrel stable stadium staff stage stairs stamp",
  "stand start state stay steak steel stem step stereo stick still sting stock stomach stone stool",
  "story stove strategy street strike strong struggle student stuff stumble style subject submit",
  "subway success such sudden suffer sugar suggest suit summer sun sunny sunset super supply",
  "supreme sure surface surge surprise surround survey suspect sustain swallow swamp swap swarm",
  "swear sweet swift swim swing switch sword symbol symptom syrup system table tackle tag tail",
  "talent talk tank tape target task taste tattoo taxi teach team tell ten tenant tennis tent term",
  "test text thank that theme then theory there they thing this thought three thrive throw thumb",
  "thunder ticket tide tiger tilt timber time tiny tip tired tissue title toast tobacco today",
  "toddler toe together toilet token tomato tomorrow tone tongue tonight tool tooth top topic",
  "topple torch tornado tortoise toss total tourist toward tower town toy track trade traffic",
  "tragic train transfer trap trash travel tray treat tree trend trial tribe trick trigger trim",
  "trip trophy trouble truck true truly trumpet trust truth try tube tuition tumble tuna tunnel",
  "turkey turn turtle twelve twenty twice twin twist two type typical ugly umbrella unable unaware",
  "uncle uncover under undo unfair unfold unhappy uniform unique unit universe unknown unlock until",
  "unusual unveil update upgrade uphold upon upper upset urban urge usage use used useful useless",
  "usual utility vacant vacuum vague valid valley valve van vanish vapor various vast vault vehicle",
  "velvet vendor venture venue verb verify version very vessel veteran viable vibrant vicious",
  "victory video view village vintage violin virtual virus visa visit visual vital vivid vocal",
  "voice void volcano volume vote voyage wage wagon wait walk wall walnut want warfare warm warrior",
  "wash wasp waste water wave way wealth weapon wear weasel weather web wedding weekend weird",
  "welcome west wet whale what wheat wheel when where whip whisper wide width wife wild will win",
  "window wine wing wink winner winter wire wisdom wise wish witness wolf woman wonder wood wool",
  "word work world worry worth wrap wreck wrestle wrist write wrong yard year yellow you young",
  "youth zebra zero zone zoo",
];
