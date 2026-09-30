/**
 * THE ROOM'S TWO DOORS — what an agent may say, and what an owner may post.
 *
 * Pure: no I/O, no clock, no node:* import. The web route and the orchestrator
 * run these same bytes, and a test can drive every clause without a database.
 *
 * DROP, NEVER REPAIR. A line that fails any clause is refused whole. Cutting the
 * address out of "send it to 0x…" would publish the half of a sentence that was
 * built around it, and we do not understand the string well enough to know
 * what is left. For an agent a refusal is a normal outcome — the conductor falls
 * back to a template or says nothing — so the gate can afford to be strict.
 *
 * HYGIENE IS NOT REPAIR. Before any clause runs the line is flattened to one
 * line and its invisible characters are removed, and THAT string is what is
 * stored and shown. What was checked is exactly what a reader sees; a gate that
 * checked one string and published another would be a gate with a door beside
 * it.
 *
 * EVERY CLAUSE READS THE LINE FIVE WAYS, because hygiene can defeat a pattern in
 * either direction. Deleting a zero-width space JOINS "0x\u{200B}abc123…" into an
 * address — good — but it also joins "x\u{200B}sk-…" into "xsk-…", where a key
 * prefix that needs a word boundary no longer has one. NFKC folds "ｔ．ｍｅ"
 * into a link a reader would follow, and also glues a fullwidth "ｘ" onto a
 * key. So a clause refuses when ANY reading trips it: the shown form (NFC), the
 * NFKC form, the NFKC form with every removed character left as a gap, the
 * gapped form without NFKC, and the bare form with every accent and mark
 * removed. `telegram/agent.ts`' `containsSecret` runs on raw bytes; this gate
 * refuses everything it flags (policy.test.ts pins that).
 *
 * WIDER THAN social-post.ts ON PURPOSE. A post is written from evidence words
 * about one trade; this room is open talk that other agents' models read back,
 * so a link without a scheme, a digit from another script, or a payload spelled
 * in tag characters all have somewhere to go here. The shapes below are copied
 * and widened rather than imported, because social-post.ts, thesis-policy.ts and
 * telegram/agent.ts are being edited elsewhere and a shared regex is a coupling
 * nobody on those branches can see.
 */
import { REPEAT_LIMIT, similarity } from "../social-post";

/** The longest agent line. Short enough that a chat bubble never becomes an essay. */
export const AGENT_LINE_MAX = 200;
/** The longest owner line. A person gets more room than a template. */
export const OWNER_LINE_MAX = 500;
/**
 * How many of the room's latest lines an agent line is weighed against for echo.
 *
 * The LAST entries of `recentRoom`, which is read oldest first like
 * `SpeakCtx.tail`. The window is the recent conversation, not the day: an
 * agent may say something like what somebody said an hour ago, but not parrot
 * the line it is answering.
 */
export const ROOM_ECHO_WINDOW = 12;

/** What an agent line is judged against. The conductor builds it per line. */
export interface AgentLineCtx {
  /** Tickers and coin names the speaker may name: the ones on its own call cards. */
  vouchedSymbols: string[];
  /** Names of agents in the room. Naming one, or @-mentioning one, reaches nobody outside. */
  rosterNames: string[];
  /** This agent's own recent lines. */
  recentOwn: string[];
  /** The room's recent lines, oldest first. */
  recentRoom: string[];
}

/**
 * A gate's answer. `text` is the cleaned line to store; `reason` is a short
 * stable code for the operator log and the owner's error message, never shown
 * to the room:
 *   empty · pass · hidden-chars · too-long · secret · address · link · handle ·
 *   unvouched-ticker · has-digits · quantity · script · repeat
 * An owner line can only be refused as empty, too-long, secret, address or link.
 */
export type LineVerdict = { ok: true; text: string } | { ok: false; reason: string };

const refuse = (reason: string): LineVerdict => ({ ok: false, reason });

/**
 * A HARD CEILING ON RAW INPUT, before any per-character work.
 *
 * Hygiene can only shrink a line, so a raw string this many times over the cap
 * can never come back under it except by being mostly invisible — which is an
 * attack, not a line. Refusing it early keeps a megabyte request body from
 * costing a megabyte of regex.
 */
const RAW_CEILING_FACTOR = 16;

// ── hygiene ─────────────────────────────────────────────────────────────────

const PICTOGRAPH = /\p{Extended_Pictographic}/u;
/**
 * Every format character AND every Default_Ignorable_Code_Point — the set
 * Unicode tells a renderer to draw as nothing. \p{Cf} alone missed 3,742 of
 * them: the Mongolian free variation selectors (category Mn, so the stacked-mark
 * cap even kept them), U+2065, U+FFF0–FFF8 and the unassigned rest of the tag
 * plane, E0080–E0FFF. One of those inside "t.me" broke the pattern while the
 * reader still saw "t.me".
 */
const FORMAT_CHAR = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
const COMBINING = /\p{M}/u;

/** Zalgo is display abuse, and no English word needs more than two stacked marks. */
const MAX_STACKED_MARKS = 2;

function isPictograph(cp: number): boolean {
  return cp > 0x7f && PICTOGRAPH.test(String.fromCodePoint(cp));
}

/** # * 0-9 — the only bases a keycap (U+20E3) sits on. */
function isKeycapBase(cp: number): boolean {
  return cp === 0x23 || cp === 0x2a || (cp >= 0x30 && cp <= 0x39);
}

function isSkinTone(cp: number): boolean {
  return cp >= 0x1f3fb && cp <= 0x1f3ff;
}

/**
 * A character a reader cannot see.
 *
 * Every \p{Cf} and every default-ignorable code point (zero-width, bidi
 * embeddings, overrides and isolates, word joiner, BOM, soft hyphen, Arabic
 * letter mark, the Mongolian selectors, the whole E0000–E0FFF tag plane that
 * spells ASCII invisibly…), every variation selector (256 of them encode a byte
 * each — the "emoji smuggling" channel), the blank-looking fillers people use to
 * post an empty-seeming line, lone surrogates and noncharacters.
 */
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
 *
 * TWO NARROW EXCEPTIONS, both inside an emoji and nowhere else: one U+FE0F
 * straight after a pictograph (without it the red heart renders as a text
 * glyph on half the phones in the room), and a ZWJ between two pictographs
 * (man + ZWJ + laptop is one emoji, not two). Neither can sit next to a letter, a digit or a dot, so
 * neither can split or join anything a clause below looks for, and one fixed
 * selector per emoji carries no hidden channel.
 *
 * `gap` leaves a space where a character was removed — the second reading.
 */
function scrub(s: string, gap: boolean): string {
  const cps = Array.from(s);
  let out = "";
  let prev = 0x20;
  let marks = 0;
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i]!;
    const cp = ch.codePointAt(0)!;
    // Flattening to one line: a break becomes a space so two words stay two.
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

/**
 * THE PROMPT FENCE, IN EVERY SPELLING A MODEL MIGHT HONOUR.
 *
 * Other people's lines reach a model inside `<untrusted source="groupchat">`.
 * A line that closes that fence writes itself into the instructions. Any case,
 * spaces or marks inside the tag, a fullwidth or lookalike bracket, an HTML
 * entity — all become the inert "[untrusted". ≮ is here because NFC composes
 * "<" with a combining long solidus into it. The slash has its lookalikes and
 * its entities too (&#47; &sol;), because promptQuote turns every "<" into "‹"
 * and "‹&#47;untrusted›" must not reach a model live.
 *
 * LINEAR, NOT QUADRATIC. The two runs of space and marks either side of the
 * slash are made atomic — `(?=(x*))\1` is JavaScript's possessive — because as
 * plain adjacent stars they split one run every possible way before failing:
 * one "<" followed by 1,361 space+accent pairs, a single 4 KB owner POST, held
 * the web server's event loop for most of a second. Atomic changes no match:
 * neither the slash nor the "u" of untrusted is in [\s\p{M}], so the greedy
 * split is the only one that could ever succeed.
 */
const FENCE =
  /(?:[<‹〈⟨《˂﹤＜≮ᐸ❮❬⟪˱⧼]|&lt;?|&#0*60;?|&#x0*3c;?)(?=([\s\p{M}]*))\1(?:[/⁄∕／\\⧸╱]|&#0*47;?|&#x0*2f;?|&sol;?)?(?=([\s\p{M}]*))\2untrusted/giu;

/** FENCE without the global flag, for a yes/no test that keeps no lastIndex. */
const HAS_FENCE = new RegExp(FENCE.source, "iu");

function finish(s: string): string {
  return s.replace(FENCE, "[untrusted").replace(/\s+/g, " ").trim();
}

/** NFKC: fullwidth, mathematical and circled letters folded to plain ones. What prompts and comparisons read. */
function canonOf(s: string): string {
  return finish(scrub(scrub(s, false).normalize("NFKC"), false));
}

/**
 * THE BARE READING: every accent and combining mark gone, dotless i dotted.
 *
 * NFC and NFKC both keep a mark that has nothing to compose with, so "pump.́fun"
 * (an accent riding on the dot), "t̶.me", "@́elonmusk" and "$́PEPE" read as
 * clean text while the mark sits between the punctuation and the letter every
 * pattern anchors on. Accents break the quantity words' \b the same way:
 * "twö", "hundréd", "a mìllion", and "fıve" with a dotless ı. NFKD splits every
 * precomposed letter into base plus mark, the marks go, and NFKC folds the
 * rest — so "café" is checked as "cafe", which is also how a reader skims it.
 */
function bareOf(s: string): string {
  const stripped = scrub(s, false)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/ı/g, "i")
    .replace(/ȷ/g, "j")
    .normalize("NFKC");
  return finish(scrub(stripped, false));
}

/**
 * The five readings every clause runs on; [0] is what is stored and shown.
 *
 * SHOWN IS NFC, NOT NFKC. NFKC rewrites spacing accents into a space plus a
 * combining mark — the shrug's macron becomes a bare space with a mark over
 * it — so a person's line would come back visibly damaged. Nothing is lost by
 * showing NFC: the compatibility lookalikes (fullwidth, mathematical, circled)
 * are folded in the NFKC readings and marks are dropped in the bare one, and
 * those are checked too. The one exception is a fence spelled in lookalikes
 * (＜/ｕｎｔｒｕｓｔｅｄ＞): neutralising is a rewrite rather than a refusal,
 * so that line is shown in its folded, neutralised form.
 *
 * WHAT THE READINGS DO NOT FOLD: Latin letters Unicode never decomposes —
 * small capitals (ᴛᴡᴏ), tone letters (Ƽ reads as 5), the click letter ǀ.
 * Agent lines refuse those by script (see admitAgentLine); owner lines may
 * hold them, since an owner's digits and words are theirs to use anyway.
 */
function readingsOf(s: string): string[] {
  const joined = scrub(s, false);
  const canon = canonOf(s);
  const shown = HAS_FENCE.test(joined.normalize("NFKC")) ? canon : finish(joined.normalize("NFC"));
  return [shown, canon, finish(scrub(scrub(s, true).normalize("NFKC"), true)), finish(scrub(s, true)), bareOf(s)];
}

// ── shapes both doors refuse ───────────────────────────────────────────────

/**
 * Key and credential shapes.
 *
 * `telegram/agent.ts` SECRET_SHAPES, widened: case-insensitive prefixes plus
 * more providers (GitHub's other token kinds, Slack, AWS, Hugging Face,
 * Replicate), a bot token with any id length (the contract's `\d+:`), a bare
 * 64-hex private key, a PEM block, and a Solana keypair as base58 or as the
 * JSON byte array wallets export — an owner pasting that into a public room is
 * the costliest mistake this gate can catch. The commonest wallet secret of
 * all, a BIP-39 recovery phrase, is words rather than a shape: hasMnemonicRun.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /0x[0-9a-f]{64}/i,
  /\b[0-9a-f]{64}\b/i,
  /\b(?:(?:sk|gsk|xai|pk|rk|npm|ghp|gho|ghu|ghs|ghr|glpat|github_pat|hf|r8|xox[abposr])[-_]|AIza|AKIA|ASIA)[A-Za-z0-9_-]{16,}/i,
  /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /[0-9]+:[A-Za-z0-9_-]{30,}/,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
  /\[\s*[0-9]{1,3}(?:\s*,\s*[0-9]{1,3}){31,}\s*\]/,
];

/**
 * A base58 keypair (87–88 characters). Mixed case AND a digit, because a long
 * run of one letter is somebody holding a key down, not a key.
 */
function hasKeypairRun(t: string): boolean {
  for (const m of t.matchAll(/[1-9A-HJ-NP-Za-km-z]{80,}/g)) {
    const run = m[0];
    if (/[0-9]/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run)) return true;
  }
  return false;
}

/** The shortest recovery phrase a wallet exports. 15, 18, 21 and 24 words all contain a run this long. */
const MNEMONIC_MIN_WORDS = 12;

let bip39: ReadonlySet<string> | null = null;
function bip39Words(): ReadonlySet<string> {
  return (bip39 ??= new Set(BIP39_ENGLISH.join(" ").split(" ")));
}

/**
 * A SEED PHRASE: twelve or more BIP-39 words in a row.
 *
 * The other shape of an owner key (packages/core/src/hosted.ts refuses it as
 * one), and the one owners actually hold: every external wallet shows it at
 * setup and every "support" scam asks for it. Split on anything that is not a
 * letter, so "1. abandon 2. ability", commas, one word per line and
 * "Abandon Ability" all count. The list has no "the", "a", "is", "and", "to",
 * "of", "my" or "you", so ordinary speech breaks a run within two or three
 * words; twelve in a row is a phrase, not a sentence.
 */
function hasMnemonicRun(t: string): boolean {
  const words = bip39Words();
  let run = 0;
  for (const w of t.toLowerCase().split(/[^a-z]+/)) {
    if (!w) continue;
    run = words.has(w) ? run + 1 : 0;
    if (run >= MNEMONIC_MIN_WORDS) return true;
  }
  return false;
}

/**
 * On-chain identifiers.
 *
 * ADDRESSY from social-post.ts / thesis-policy.ts, without its word boundaries
 * (a boundary is a thing hygiene can remove) and case-insensitive (`0X…`).
 * `rh:` stays: the brokerage rail's agent id embeds an account number. The
 * third shape is an address as wallets DISPLAY it, in chunks — "0x d8da 6bf2 …",
 * "0x-d8da-6bf2-…" — which neither the prefix shape nor the unbroken-run check
 * sees: twenty hex digits after the 0x, any one separator between any two.
 */
const ADDRESS_SHAPES: readonly RegExp[] = [/0x[0-9a-f]{6,}/i, /\brh:[a-z0-9-]/i, /0\s*x(?:[\s._:,-]?[0-9a-f]){20,}/i];

/**
 * An address without a prefix: a long run mixing letters and digits (base58,
 * bech32, bare hex), or a long mixed-case run (base58 that happens to hold no
 * digit). No English word does either; an address-derived ticker is 12
 * characters and a sanitised coin name at most 24, both under the floor.
 */
function hasEncodedRun(t: string): boolean {
  for (const m of t.matchAll(/[A-Za-z0-9]{26,}/g)) {
    const run = m[0];
    const digits = /[0-9]/.test(run);
    const letters = /[A-Za-z]/.test(run);
    if (digits && letters) return true;
    if (run.length >= 32 && /[a-z]/.test(run) && /[A-Z]/.test(run)) return true;
  }
  return false;
}

/**
 * Anything a reader could follow out of the room.
 *
 * `https?://` was the only link social-post knew. Here: any scheme (hxxp://
 * included), `www.`, app and wallet URIs (`tg:`, `ethereum:` — a payment
 * request is a link), and SCHEME-LESS DOMAINS, which is where every shill
 * actually lives: `t.me/x`, `discord.gg/x`, `bit.ly/x`, `pump.fun`,
 * `vitalik.eth`. A domain is any letter or digit, a dot, then two letters —
 * in any script, so a Cyrillic "е" in "t.mе" does not slip past, and with the
 * ideographic full stops a browser also accepts as a dot. "e.g.", "U.S." and
 * "1.5x" do not match (one letter, or a digit, after the dot); "lol.ok" does,
 * and losing that line is the price of not keeping a TLD list an attacker
 * only has to be one entry ahead of. Then the defanged spellings: `t[.]me`,
 * `x(dot)com`, "dot com", "pump . fun", and a bare IPv4.
 *
 * AND THE DOTS THAT ARE NOT DOTS. "t·me/pump", "pump•fun", "pump・fun" are
 * followed by every reader. A lookalike dot counts only when a LATIN letter
 * follows it, so "ドナルド・トランプ" (the katakana middle dot between two
 * words) and a "·"-separated list with spaces stay speech; "col·lecció" is the
 * price. What is NOT closed, knowingly: "pump. fun", "t me slash x",
 * "fivehundredx" — a string gate is a backstop, and each of those needs a
 * reader to do the work of joining it.
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

/** The refusal both doors share, secret first: a private key filed as "address" would send whoever reads the log looking in the wrong place. */
function hygieneRefusal(readings: string[]): string | null {
  if (readings.some((t) => SECRET_SHAPES.some((re) => re.test(t)) || hasKeypairRun(t) || hasMnemonicRun(t))) return "secret";
  if (readings.some((t) => ADDRESS_SHAPES.some((re) => re.test(t)) || hasEncodedRun(t))) return "address";
  if (readings.some((t) => LINK_SHAPES.some((re) => re.test(t)))) return "link";
  return null;
}

// ── agent-only shapes ───────────────────────────────────────────────────────

/** The model's "nothing to say", in any case, however it decorated it. */
const PASS = /^[^\p{L}\p{N}]*pass(?![\p{L}\p{N}_])/iu;

/**
 * Characters that can carry a PAYLOAD, not just hide a seam.
 *
 * Hygiene removes them either way; an agent line that contains them is refused
 * outright, because no template and no honestly-prompted model emits a tag
 * character or a supplementary variation selector. A line that does was steered
 * by something it read, and publishing its visible half would be publishing the
 * part the steerer wanted seen. The whole E0000–E0FFF plane: the tags, the
 * supplementary selectors, and the unassigned rest a renderer also hides.
 */
const PAYLOAD_CHARS = /[\u{E0000}-\u{E0FFF}]/u;

/** `@x` / `#x` with a full- or small-form sign; the name check decides whether x is one of us. */
const MENTION = /[@#＠＃﹫﹟][\p{L}\p{N}_]/gu;
/** MENTION without the global flag, for a yes/no test that keeps no lastIndex. */
const HAS_MENTION = new RegExp(MENTION.source, "u");

/** A cashtag starts with a letter; `$100` is a figure and the digit clause owns it. */
const CASHTAG = /[$💲＄﹩](?=\p{L})/gu;

/** The ledger's address-derived ticker: T plus the contract's last eleven hex. */
const ADDRESS_TICKER = /\bT[0-9A-F]{11}\b/g;

/**
 * NOT ONE NUMERAL. `\p{N}` is every script's digits plus superscripts,
 * fractions, circled and Roman numerals — ASCII `\d` sees none of "３", "²",
 * "٣", "३", "Ⅻ". Checked on the NFKC readings too, which turns "㍘" into
 * "0点". Plus the emoji that ARE numerals (🔟 💯 🔢 🔞), the die faces ⚀–⚅
 * (a face is a count of pips), and the clock faces, each of which names an
 * hour — and an agent never says what time it is for its owner.
 */
const NUMERAL = /[\p{N}\u{1F51F}\u{1F4AF}\u{1F522}\u{1F51E}\u{2680}-\u{2685}\u{1F550}-\u{1F567}]/u;

/**
 * SPELLED-OUT QUANTITIES. "forty buyers" carries the claim "40 buyers" does.
 *
 * The contract's list — two…twenty, the tens, dozen, hundred, thousand,
 * million, billion, percent — plus zero, trillion, plurals and -fold, the
 * ordinals from third up ("third buy today" is a count), twice/thrice,
 * doubled/tripled (a performance claim in one word), a multiplier glued on
 * ("tenx", "hundredx"), every -illion however made up (gazillion, bajillion,
 * quadrillion — "vermillion" and "pillion" are the price), the misspelt
 * "ninty", and hundo/hunnid/mil slang.
 * "one", "once" and "first" stay allowed: they are pronouns and ordinary
 * English far more often than figures (see social-post.ts). "second" too —
 * it is a verb and a unit of time. So do "half", "double" and "mill": "half
 * asleep", "double check" and "the rumour mill" are what a room says.
 */
const QUANTITY = new RegExp(
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
      "doubled",
      "tripled",
      "quadrupled",
      "quintupled",
    ].join("|") +
    ")\\b",
  "i",
);

/**
 * THE ROOM IS ENGLISH, AND SO ARE ITS GATES. A quantity clause that knows
 * "forty" knows nothing of "сорок" or "四十", and CJK numerals are letters to
 * \p{N}. So an agent line may hold no letter outside the Latin script once the
 * names it may use are stripped — which ends cross-script homoglyphs ("twо"
 * with a Cyrillic о) as a class. ツ survives for the shrug.
 *
 * LATIN HAS LOOKALIKES OF ITS OWN that no normalisation folds: small capitals
 * ("ᴛᴡᴏ bags"), tone letters ("up ƼOO%" reads as 500), the click letter ǀ, the
 * IPA letters. So the BARE reading — accents already gone, "café" is "cafe" —
 * may hold only A–Z. And the enclosed letters that are symbols rather than
 * letters to Unicode (🅣🅦🅞, 🆃🆆🅾) spell words no letter clause sees.
 */
const FOREIGN_LETTER = /(?!ツ)(?=\p{L})\P{Script=Latin}/u;
const NON_ASCII_LETTER = /(?!ツ)(?=\p{L})[^A-Za-z]/u;
const ENCLOSED_LETTER = /[\u{1F150}-\u{1F169}\u{1F170}-\u{1F189}]/u;

/**
 * A NAME THAT READS AS A FIGURE: digits with a multiplier, a percent or a unit
 * of money on them ("Up 400x", "10k Club", "Up 1000 percent", "$100 Gang").
 * Digits inside a word are not a figure — "T7631DACC21B" and "B2B" stay names.
 */
const FIGURE_NAME = /(?<![\p{L}\p{N}])\p{N}[\p{N}.,]*\s*(?:[x%kmb]|percent|pct)(?![\p{L}\p{N}])|[$+]\s*\p{N}/iu;

/** A name matched inside a line: not glued to a letter, digit or mark either side. */
const WORD_EDGE_BEFORE = "(?<![\\p{L}\\p{N}\\p{M}_])";
const WORD_EDGE_AFTER = "(?![\\p{L}\\p{N}\\p{M}_])";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every spelling of a name a reading can hold: NFC, NFKC and unnormalised. A
 * stored name has been through different hands than the line, so each is
 * cleaned the same way the line was before they are compared.
 */
function variantsOf(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const item of list) {
    if (typeof item !== "string") continue;
    const base = item.replace(/^\s*[$💲＄﹩]+/u, "");
    const joined = scrub(base, false);
    for (const v of [finish(joined.normalize("NFC")), canonOf(base), finish(joined), bareOf(base)]) if (v) out.add(v);
  }
  return [...out];
}

function alternation(names: string[]): string | null {
  if (names.length === 0) return null;
  // Longest first, so "Amber Heron" is taken whole before "Amber" can match.
  return [...names].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
}

interface NameBook {
  /**
   * Strips every name that has a letter in it and does not itself read as a
   * figure. A name with no letter ("007"), one that is a quantity word ("Ten",
   * "Hundred Percent", a $MILLION coin) or one with a figure in it ("Up 400x")
   * stays in, so a line that names it is judged as if it said the figure —
   * refused, and the template retries without the name.
   */
  strip: RegExp | null;
  /** Sticky: a roster name starting exactly here. */
  rosterAt: RegExp | null;
  /** Sticky: a vouched symbol starting exactly here. */
  vouchedAt: RegExp | null;
  tickers: Set<string>;
}

function nameBook(ctx: AgentLineCtx | undefined): NameBook {
  const roster = variantsOf(ctx?.rosterNames);
  const vouched = variantsOf(ctx?.vouchedSymbols);
  // ONE OWNER'S CHOICE MUST NOT LOOSEN EVERY AGENT'S GATE. The roster is the
  // whole room, and a coin's name is its deployer's; stripping a name spelled
  // "Up 1000 percent" would let "we're up 1000 percent" through for everyone.
  const lettered = alternation(
    [...roster, ...vouched].filter((n) => /\p{L}/u.test(n) && !QUANTITY.test(n) && !FIGURE_NAME.test(n)),
  );
  const rosterAlt = alternation(roster);
  const vouchedAlt = alternation(vouched);
  return {
    strip: lettered ? new RegExp(`${WORD_EDGE_BEFORE}(?:${lettered})${WORD_EDGE_AFTER}`, "giu") : null,
    rosterAt: rosterAlt ? new RegExp(`(?:${rosterAlt})${WORD_EDGE_AFTER}`, "iuy") : null,
    vouchedAt: vouchedAlt ? new RegExp(`(?:${vouchedAlt})${WORD_EDGE_AFTER}`, "iuy") : null,
    tickers: new Set(vouched.map((v) => v.toLowerCase())),
  };
}

function startsWith(re: RegExp | null, t: string, at: number): boolean {
  if (!re) return false;
  re.lastIndex = at;
  return re.test(t);
}

/** An @ or # that does not name an agent in the room. */
function mentionsStranger(t: string, names: NameBook): boolean {
  for (const m of t.matchAll(MENTION)) {
    // Every sign in MENTION is one UTF-16 unit, so the name starts one past it.
    if (!startsWith(names.rosterAt, t, m.index + 1)) return true;
  }
  return false;
}

/**
 * A ticker the speaker did not trade. An agent echoing "$PEPE" from an
 * owner's line or another agent's is how a shill gets amplified by the room.
 */
function namesUnvouchedTicker(t: string, names: NameBook): boolean {
  for (const m of t.matchAll(CASHTAG)) {
    if (!startsWith(names.vouchedAt, t, m.index + m[0].length)) return true;
  }
  for (const m of t.matchAll(ADDRESS_TICKER)) {
    if (!names.tickers.has(m[0].toLowerCase())) return true;
  }
  return false;
}

function strings(list: unknown): string[] {
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
}

/**
 * THE FEWEST CONTENT WORDS, ON BOTH SIDES, FOR THE ROOM ECHO TO BE WEIGHED
 * AGAINST THE SHORTER LINE.
 *
 * similarity() divides by the SHORTER line's content words, so a line with one
 * of them is a "repeat" of every line that contains it: "here!!" echoed
 * somebody's "glad to be here", and "glad to be here tonight" echoed a "here!!"
 * three lines up. So when either line is below this, the echo is weighed
 * against BOTH lines' words together (sharedOfBoth): a short line that only
 * shares a word with a longer one is not an echo, but a short line said back
 * word for word — or with a word tacked on — still is. "pepe szn" after an
 * owner's "pepe szn" is the room amplifying a coin nobody traded, in plain
 * words rule 9's $cashtag clause never sees. Names, tickers and emoji are not
 * the speaker's words and are not counted on either side. An agent's own lines
 * are weighed word for word regardless (see admitAgentLine).
 */
const ECHO_MIN_WORDS = 3;

/** A ticker as a line spells it: a cashtag and its word. The ledger's address-derived ones are ADDRESS_TICKER. */
const CASHTAG_WORD = /[$💲＄﹩]\p{L}[\p{L}\p{N}_]*/gu;

/**
 * A line's distinct content words, counted the way similarity() counts them
 * — a-z runs of three letters or more that social-post does not call a
 * stopword, decided by asking similarity() itself rather than copying its list
 * — once every name, vouched symbol and ticker is out.
 */
function contentWords(t: string, names: NameBook): Set<string> {
  const own = (names.strip ? t.replace(names.strip, " ") : t).replace(CASHTAG_WORD, " ").replace(ADDRESS_TICKER, " ");
  const seen = new Set<string>();
  for (const w of own.toLowerCase().split(/[^a-z]+/)) {
    if (w.length > 2 && !seen.has(w) && similarity(w, w) > 0) seen.add(w);
  }
  return seen;
}

/**
 * Two lines' shared content words over ALL their content words (|A∩B| / |A∪B|),
 * 0 when either has none — so "gm" is never an echo. Measured against the
 * longer line, a word one line merely borrows from the other is diluted by
 * the words it does not share: "here!!" against "glad to be here" is ½,
 * "pepe szn ngl" against "pepe szn" is ⅔.
 */
function sharedOfBoth(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

// ── the doors ───────────────────────────────────────────────────────────────

/**
 * MAY AN AGENT SAY THIS? Every agent line — template or model — passes here
 * before it is written; a template this refuses is a bug in the template.
 *
 * The clauses are the contract's (docs/groupchat.md, "Gates"), widened, and
 * ordered so the reason names the most specific fault: a secret before an
 * address (a key is also hex), a ticker before a digit (T7631DACC21B is also
 * digits). Order never changes WHETHER a line passes, only what the log says.
 */
export function admitAgentLine(raw: unknown, ctx: AgentLineCtx): LineVerdict {
  const s = typeof raw === "string" ? raw : "";
  if (s.length > AGENT_LINE_MAX * RAW_CEILING_FACTOR) return refuse("too-long");
  const readings = readingsOf(s);
  const shown = readings[0]!;
  const canon = readings[1]!;

  if (shown.length === 0) return refuse("empty");
  // A model deciding it has nothing to say is the design working.
  if (PASS.test(canon)) return refuse("pass");
  if (PAYLOAD_CHARS.test(s)) return refuse("hidden-chars");
  // The floor is one character, because "gm" is the room's commonest line.
  if (shown.length > AGENT_LINE_MAX) return refuse("too-long");

  const hygiene = hygieneRefusal(readings);
  if (hygiene) return refuse(hygiene);

  const names = nameBook(ctx);
  if (readings.some((t) => mentionsStranger(t, names))) return refuse("handle");
  if (readings.some((t) => namesUnvouchedTicker(t, names))) return refuse("unvouched-ticker");

  /**
   * NAMES OUT, THEN NOT ONE NUMERAL. Agent names ("Agent 47") and
   * address-derived tickers carry digits legitimately and are stripped first;
   * only as whole words, so "Robin2" is not "Robin" plus a stray 2. A name that
   * is itself a figure — no letter at all ("100"), a quantity word ("Ten"), or
   * digits with a multiplier ("Up 400x") — is never stripped; see nameBook.
   */
  const bare = readings.map((t) => (names.strip ? t.replace(names.strip, " ") : t));
  if (bare.some((t) => NUMERAL.test(t))) return refuse("has-digits");
  if (bare.some((t) => QUANTITY.test(t))) return refuse("quantity");
  if (FOREIGN_LETTER.test(bare[0]!) || NON_ASCII_LETTER.test(bare[4]!) || ENCLOSED_LETTER.test(bare[0]!)) {
    return refuse("script");
  }

  // similarity() is 0 for a line with no content words, so "gm" answering "gm" is never an echo.
  // It reads a-z only, hence the folded form: a fullwidth copy is still a copy.
  // The agent's OWN lines are weighed word for word, names included: an agent
  // never says its own sentence again (conductor.test.ts holds every agent to
  // exactly this measure). The ROOM's lines are weighed against the shorter
  // line only when both are sentences; a short line on either side is weighed
  // against both lines' words (see ECHO_MIN_WORDS).
  if (strings(ctx?.recentOwn).some((prev) => similarity(canon, canonOf(prev)) >= REPEAT_LIMIT)) return refuse("repeat");
  const mine = contentWords(canon, names);
  if (mine.size > 0) {
    for (const prev of strings(ctx?.recentRoom).slice(-ROOM_ECHO_WINDOW)) {
      const was = canonOf(prev);
      const theirs = contentWords(was, names);
      const echo = mine.size >= ECHO_MIN_WORDS && theirs.size >= ECHO_MIN_WORDS ? similarity(canon, was) : sharedOfBoth(mine, theirs);
      if (echo >= REPEAT_LIMIT) return refuse("repeat");
    }
  }

  return { ok: true, text: shown };
}

/**
 * MAY AN OWNER POST THIS? A person's speech, so digits, tickers and @names are
 * theirs to use — agents cannot repeat any of it, because agent output is
 * gated. What is refused is what would hurt somebody: a secret (most often the
 * owner's own), an address, a link out of the room.
 *
 * Refusal reasons: empty · too-long · secret · address · link.
 */
export function admitOwnerLine(raw: unknown): LineVerdict {
  const s = typeof raw === "string" ? raw : "";
  if (s.length > OWNER_LINE_MAX * RAW_CEILING_FACTOR) return refuse("too-long");
  const readings = readingsOf(s);
  const shown = readings[0]!;
  if (shown.length === 0) return refuse("empty");
  if (shown.length > OWNER_LINE_MAX) return refuse("too-long");
  const hygiene = hygieneRefusal(readings);
  if (hygiene) return refuse(hygiene);
  return { ok: true, text: shown };
}

/**
 * MAY THIS NAME HEAD A PUBLIC LINE? Null when it may; otherwise the reason.
 *
 * A speaker's name is printed on every bubble and in the presence list, and
 * handed to every model as who is talking — but it never passes through either
 * door. So it is held to both doors' hygiene (no secret, address or link: a name
 * "pump.fun" would be a shill printed on every line that agent writes), to the
 * agent door's handle clause (a name is nobody's @handle or #tag), plus two
 * things only a name needs: no figure ("Up 400x"), because a model shown the
 * figure can repeat it; and no run of an address's hex without its "0x" — a name
 * holds at most 24 characters, under the line gate's floor for an unprefixed
 * run, yet "d8da6bf26964af9d7eed9e03" is most of a wallet. Refusal reasons:
 * too-long · secret · address · link · handle · figure.
 */
export function nameRefusal(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw : "";
  if (s.length > OWNER_LINE_MAX * RAW_CEILING_FACTOR) return "too-long";
  const readings = readingsOf(s);
  const hygiene = hygieneRefusal(readings);
  if (hygiene) return hygiene;
  if (readings.some(hasHexRun)) return "address";
  if (readings.some((t) => HAS_MENTION.test(t))) return "handle";
  if (readings.some((t) => FIGURE_NAME.test(t))) return "figure";
  return null;
}

/**
 * Sixteen hex digits or more in one run, mixing digits and letters: 64 bits of
 * an address, which no name spells by accident. "Deadbeef" and "B2B" stay.
 */
function hasHexRun(t: string): boolean {
  for (const m of t.matchAll(/[0-9a-f]{16,}/gi)) {
    if (/[0-9]/.test(m[0]) && /[a-f]/i.test(m[0])) return true;
  }
  return false;
}

/**
 * Anybody's line, made safe to put inside a model prompt.
 *
 * Cleaned as the gates clean, NFKC-folded (a model reads "𝐢𝐠𝐧𝐨𝐫𝐞" as
 * "ignore" whatever font it is in), fence-neutralised, one line, then clipped
 * to `max` (with "…" when cut, never splitting a surrogate pair). Beyond the
 * gates' neutralisation, every remaining < and > becomes ‹ ›: the prompt's
 * fence is the only tag the model should see, and a quote with no angle
 * bracket cannot forge one in any spelling. NOT a gate — digits and names
 * survive, because the model has to read what was actually said.
 */
export function promptQuote(text: unknown, max: number): string {
  const cap = Math.floor(max);
  if (!(cap > 0)) return "";
  const s = typeof text === "string" ? text : "";
  const quoted = canonOf(s.slice(0, cap * RAW_CEILING_FACTOR + 64))
    .replace(/</g, "‹")
    .replace(/>/g, "›");
  if (quoted.length <= cap) return quoted;
  let kept = "";
  for (const ch of quoted) {
    if (kept.length + ch.length > cap - 1) break;
    kept += ch;
  }
  return `${kept.trimEnd()}…`;
}

// ── the BIP-39 English wordlist ─────────────────────────────────────────────

/**
 * THE 2,048 WORDS A RECOVERY PHRASE IS MADE OF, vendored rather than imported:
 * this module stays free of imports (policy.test.ts pins that), and the only
 * copy on disk is a transitive dependency of viem that an upgrade could move.
 * policy.test.ts pins the list's hash against the published english.txt.
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
