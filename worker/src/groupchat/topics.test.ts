/**
 * THE OFF-TRADING PHRASEBOOK, HELD TO ITS PROMISES.
 *
 * topics.ts is data, so every promise its header makes is a mechanical check
 * here: every line passes the room's gate with its slots filled; nothing says
 * a trading word; nothing claims an experience an agent cannot have had; a
 * question is recognised as ITSELF (and as nothing earlier), while an answer,
 * take, musing, joke or reply is never mistaken for any question; the pools are
 * long enough that a room of ~57 agents does not repeat itself in three hours.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentFacts } from "./facts";
import { admitAgentLine } from "./policy";
import {
  FUNNY_TAKES,
  GENTLE_MUSINGS,
  JOKES,
  JOKE_REPLY,
  JOKE_SHAPE,
  MUSINGS,
  MUSING_MARK,
  MUSING_REPLY,
  MUSING_REPLY_WARM,
  MUSING_REPLY_WRY,
  PROMPTS,
  SUBJECTS,
  TAKES,
  TAKE_REPLY,
  type Subject,
} from "./topics";
import { roomMemory, styleFor, templateLine } from "./voice";

// ── fixtures ────────────────────────────────────────────────────────────────

const NAME = "Amber Heron";
const ROSTER = [NAME, "Rusty Weasel", "Pine Stoat", "Winter Raven", "Agent 47"];
const GATE = { vouchedSymbols: [] as string[], rosterNames: ROSTER, recentOwn: [] as string[], recentRoom: [] as string[] };

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Slots filled with a plain two-word name, as the engine fills them after styling. */
function fill(raw: string): string {
  return raw.replace(/\{(peer|to)\}/gi, NAME);
}

const NAME_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:${[...ROSTER].sort((a, b) => b.length - a.length).map((n) => escapeRe(n.toLowerCase())).join("|")})(?![\\p{L}\\p{N}_])`,
  "giu",
);

/**
 * A line the way a prompt's `match` reads it: apostrophes straightened, lower
 * case, names out. Two spellings of "out": the engine's (a space, then spaces
 * collapsed and trimmed) and a harsher one (deleted, nothing collapsed), so a
 * pattern never leans on how a name happened to be removed.
 */
function readings(line: string): string[] {
  const t = fill(line).normalize("NFKC").replace(/[’‘`]/g, "'").toLowerCase();
  return [t.replace(NAME_RE, " ").replace(/\s+/g, " ").trim(), t.replace(NAME_RE, "")];
}

/** The engine's phrase-memory form: letters only, names and slots out. */
function memoryKey(line: string): string {
  return line
    .replace(/\{(peer|to)\}/g, " ")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z]+/g, " ")
    .trim();
}

interface Line {
  pool: string;
  text: string;
}

const stanceLines: Line[] = PROMPTS.flatMap((p) => p.stances.flatMap((s, i) => s.map((text) => ({ pool: `${p.id} stance ${i}`, text }))));
const roomLines: Line[] = PROMPTS.flatMap((p) => p.room.map((text) => ({ pool: `${p.id} room`, text })));
const peerLines: Line[] = PROMPTS.flatMap((p) => p.peer.map((text) => ({ pool: `${p.id} peer`, text })));
const takeLines: Line[] = (Object.entries(TAKES) as [Subject, readonly string[]][]).flatMap(([s, list]) =>
  list.map((text) => ({ pool: `take ${s}`, text })),
);
const musingLines: Line[] = MUSINGS.map((text) => ({ pool: "musing", text }));
const jokeLines: Line[] = JOKES.map((text) => ({ pool: "joke", text }));
/**
 * EVERY REPLY POOL, BY ITS OWN KEYS: a line moved into a new side (`laugh`)
 * or a new pool is held to every rule below the moment it exists. The old list
 * named agree, disagree and amused, so the laughs moved out of `amused` would
 * have left the gate's sight. FUNNY_TAKES is not a pool of its own words (each
 * is a TAKES line, gated there) and is checked against TAKES below.
 */
const replyLines: Line[] = [
  ...(Object.entries(TAKE_REPLY) as [string, readonly string[]][]).flatMap(([side, list]) =>
    list.map((text) => ({ pool: `take reply ${side}`, text })),
  ),
  ...MUSING_REPLY.map((text) => ({ pool: "musing reply", text })),
  ...MUSING_REPLY_WARM.map((text) => ({ pool: "musing reply warm", text })),
  ...MUSING_REPLY_WRY.map((text) => ({ pool: "musing reply wry", text })),
  ...JOKE_REPLY.map((text) => ({ pool: "joke reply", text })),
];
const questionLines = [...roomLines, ...peerLines];
/** Everything that is NOT a question the room asks. */
const statementLines = [...stanceLines, ...takeLines, ...musingLines, ...jokeLines, ...replyLines];
const everyLine = [...questionLines, ...statementLines];

const show = (l: Line): string => `${l.pool}: ${JSON.stringify(l.text)}`;

// ── the shape the engine codes against ──────────────────────────────────────

describe("topics: shape and volume", () => {
  it("has at least 75 prompts, 3 per subject, 10 hypotheticals, with unique kebab-case ids", () => {
    assert.ok(PROMPTS.length >= 75, `only ${PROMPTS.length} prompts`);
    const ids = new Set<string>();
    for (const p of PROMPTS) {
      assert.match(p.id, /^[a-z]+(?:-[a-z]+)*$/, `id not kebab-case: ${p.id}`);
      assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
      ids.add(p.id);
      assert.ok((SUBJECTS as readonly string[]).includes(p.subject), `${p.id}: unknown subject ${p.subject}`);
      assert.ok(p.match instanceof RegExp, `${p.id}: match is not a RegExp`);
      assert.ok(!p.match.global && !p.match.sticky, `${p.id}: a /g or /y match keeps state between lines`);
    }
    for (const s of SUBJECTS) {
      const n = PROMPTS.filter((p) => p.subject === s).length;
      assert.ok(n >= 3, `${s} has only ${n} prompts`);
    }
    const hypothetical = PROMPTS.filter((p) => p.subject === "hypothetical").length;
    assert.ok(hypothetical >= 10, `only ${hypothetical} hypothetical prompts`);
  });

  it("every prompt has 3+ room questions, 2+ peer questions, 3+ stances of 4+ lines", () => {
    for (const p of PROMPTS) {
      assert.ok(p.room.length >= 3, `${p.id}: ${p.room.length} room questions`);
      assert.ok(p.peer.length >= 2, `${p.id}: ${p.peer.length} peer questions`);
      assert.ok(p.stances.length >= 3, `${p.id}: ${p.stances.length} stances`);
      for (const [i, s] of p.stances.entries()) assert.ok(s.length >= 4, `${p.id} stance ${i}: ${s.length} lines`);
    }
  });

  it("room questions are questions without slots; peer questions name the peer exactly once", () => {
    for (const l of roomLines) {
      assert.match(l.text, /\?$/, show(l));
      assert.doesNotMatch(l.text, /[{}]/, show(l));
    }
    for (const l of peerLines) {
      assert.match(l.text, /\?$/, show(l));
      assert.equal(l.text.split("{peer}").length - 1, 1, show(l));
      assert.doesNotMatch(l.text.replace("{peer}", ""), /[{}]/, show(l));
    }
  });

  it("stances are statements that may name the asker, at most once per line and once per stance", () => {
    for (const p of PROMPTS) {
      for (const [i, s] of p.stances.entries()) {
        let named = 0;
        for (const text of s) {
          const l = { pool: `${p.id} stance ${i}`, text };
          assert.doesNotMatch(text, /\{peer\}/, show(l));
          assert.doesNotMatch(text, /\?/, `a stance is an answer, not a question: ${show(l)}`);
          const tos = text.split("{to}").length - 1;
          assert.ok(tos <= 1, show(l));
          assert.doesNotMatch(text.replace("{to}", ""), /[{}]/, show(l));
          named += tos;
        }
        assert.ok(named <= 1, `${p.id} stance ${i} names the asker ${named} times`);
      }
    }
  });

  it("a name is set off with commas, so it never reads as part of the phrase", () => {
    // Live, "hot {to}, give me sunshine" said "hot Pine Plover, give me
    // sunshine", "cook {to}, obviously" said "cook Quiet Pike", and "{peer} is
    // leaving someone on read rude?" asked whether an agent was rude. A name
    // opens the line or follows ", ", and is followed by the end, "," "?" or "!".
    for (const l of [...stanceLines, ...peerLines]) {
      for (const m of l.text.matchAll(/\{(to|peer)\}/g)) {
        const before = l.text.slice(0, m.index);
        const after = l.text.slice(m.index! + m[0].length);
        assert.ok(before === "" || before.endsWith(", "), `name glued to the words before it: ${show(l)}`);
        assert.ok(after === "" || /^[,?!]/.test(after), `name glued to the words after it: ${show(l)}`);
      }
    }
  });

  it("every stance fits every wording of its question", () => {
    // ONE STANCE LIST ANSWERS EVERY WORDING, chosen without looking at which
    // was asked, so a wording that asks a different KIND of question gets
    // answers written for another: "are cheat codes a crime?" got "yes,
    // infinite lives sounds amazing", "camping, fun or a nightmare?" got
    // "yes, …", "if you had a time machine, where are you going?" got
    // "neither, …". Three shapes a reader notices at once:
    // - a bare yes or no (a yes/no word and a comma) to an either/or question;
    // - a bare yes or no to a what/which/where question;
    // - "neither" to a question that offered no choice.
    const yesNoQuestion = /\byes or no\b|\bor (not|no|never)\s*\?\s*$|\bin or out\b/;
    const eitherOr = (q: string) => /\bor\b/.test(q) && !yesNoQuestion.test(q);
    const wh = (q: string) => /^(what|which|where|who|how|when)\b/.test(q.replace(/^\{peer\}, /, "")) && !/\bor\b/.test(q);
    const bareYesNo = /^(yes|yeah|yep|no|nope|never|always|absolutely|absolutely not|definitely|sure|of course|hard no|nah|not a chance),/;
    const wrong: string[] = [];
    for (const p of PROMPTS) {
      const wordings = [...p.room, ...p.peer];
      for (const s of p.stances.flat()) {
        for (const q of wordings) {
          if (bareYesNo.test(s) && eitherOr(q)) wrong.push(`${p.id}: "${q}" <- "${s}" (a yes or no to a choice)`);
          if (bareYesNo.test(s) && wh(q)) wrong.push(`${p.id}: "${q}" <- "${s}" (a yes or no to a what)`);
          if (/^neither\b/.test(s) && !eitherOr(q)) wrong.push(`${p.id}: "${q}" <- "${s}" (neither, with no choice offered)`);
        }
      }
    }
    assert.deepEqual(wrong, []);
  });

  it("takes, musings, jokes and replies carry no slot", () => {
    for (const l of [...takeLines, ...musingLines, ...jokeLines, ...replyLines]) assert.doesNotMatch(l.text, /[{}]/, show(l));
  });

  it("every subject has 12+ takes of 4+ words, 228+ in all, and takes are statements", () => {
    assert.deepEqual(Object.keys(TAKES).sort(), [...SUBJECTS].sort());
    let total = 0;
    for (const s of SUBJECTS) {
      const list = TAKES[s];
      assert.ok(list.length >= 12, `${s} has only ${list.length} takes`);
      total += list.length;
      for (const text of list) {
        assert.ok(text.trim().split(/\s+/).length >= 4, `take too short: ${JSON.stringify(text)}`);
        assert.doesNotMatch(text, /\?/, `a take is said, not asked: ${JSON.stringify(text)}`);
      }
    }
    assert.ok(total >= 228, `only ${total} takes`);
  });

  it("musings, jokes and reply pools are long enough", () => {
    // A HUNDRED AND MORE: the long memory of what the room started holds two
    // days (voice.ts pickRotated), and a simulated two days said 129 shower
    // thoughts from 76 — 52 of them repeats.
    assert.ok(MUSINGS.length >= 100, `only ${MUSINGS.length} musings`);
    assert.ok(GENTLE_MUSINGS.length >= 30, `only ${GENTLE_MUSINGS.length} gentle musings`);
    assert.ok(JOKES.length >= 70, `only ${JOKES.length} jokes`);
    for (const k of ["agree", "disagree", "amused"] as const) {
      assert.ok(TAKE_REPLY[k].length >= 20, `only ${TAKE_REPLY[k].length} ${k} replies`);
    }
    assert.ok(TAKE_REPLY.laugh.length >= 15, `only ${TAKE_REPLY.laugh.length} laughs at a joke take`);
    assert.ok(MUSING_REPLY.length >= 35, `only ${MUSING_REPLY.length} musing replies`);
    assert.ok(MUSING_REPLY_WARM.length >= 5 && MUSING_REPLY_WRY.length >= 5, "the warm and the wry musing replies");
    assert.ok(JOKE_REPLY.length >= 35, `only ${JOKE_REPLY.length} joke replies`);
  });

  it("no sentence appears twice anywhere in the file, even with different punctuation", () => {
    const seen = new Map<string, string>();
    for (const l of everyLine) {
      const key = memoryKey(l.text);
      assert.ok(key.length > 0, show(l));
      const was = seen.get(key);
      assert.ok(was === undefined, `${show(l)} repeats ${was}`);
      seen.set(key, show(l));
    }
  });
});

// ── the gate ────────────────────────────────────────────────────────────────

describe("topics: every line passes the room's gate", () => {
  it("admitAgentLine accepts every line, slots filled, in lower and upper case", () => {
    for (const l of everyLine) {
      const upper = l.text.toUpperCase().replace(/\{(PEER|TO)\}/g, (s) => s.toLowerCase());
      for (const variant of [fill(l.text), fill(upper)]) {
        const v = admitAgentLine(variant, GATE);
        assert.ok(v.ok, `refused (${v.ok ? "" : v.reason}): ${show(l)} as ${JSON.stringify(variant)}`);
      }
    }
  });

  it("lines are short, lowercase, plain ASCII, emoji-free and tidy", () => {
    for (const l of everyLine) {
      const t = fill(l.text);
      assert.ok(t.length <= 110, `too long (${t.length}): ${show(l)}`);
      assert.equal(l.text, l.text.toLowerCase(), `not lowercase: ${show(l)}`);
      assert.match(l.text, /^[\x20-\x7e]+$/, `non-ASCII character: ${show(l)}`);
      assert.doesNotMatch(l.text, /\p{Extended_Pictographic}/u, `emoji: ${show(l)}`);
      assert.doesNotMatch(l.text, /\d/, `digit: ${show(l)}`);
      assert.equal(l.text, l.text.trim(), `untrimmed: ${show(l)}`);
      assert.doesNotMatch(l.text, /\s{2}/, `double space: ${show(l)}`);
      assert.doesNotMatch(l.text, /[@#$]/, `handle, tag or cashtag sign: ${show(l)}`);
      assert.doesNotMatch(l.text, /[a-z]\.[a-z]/, `reads as a domain: ${show(l)}`);
      assert.doesNotMatch(l.text, /^\W*pass\b/, `starts with pass: ${show(l)}`);
    }
  });
});

// ── what the lines may not say ──────────────────────────────────────────────

/** Not one trading word: those lines live in templates.ts. */
const TRADING =
  /\b(coins?|tokens?|charts?|tape|curves?|bags?|gas|blocks?|markets?|trade|trades|traded|trading|traders?|buy|buying|buys|bought|sell|selling|sells|sold|pump|pumps|pumped|pumping|rugs?|rugged|candles?|vaults?|chains?|wallets?|prices?|priced|portfolios?|profits?|crypto|degens?|ape|apes|aped|bullish|bearish|stocks?|money|cash|invest|invested|investing|investment|investor|to the moon|mooning|moonshot|hodl|wagmi|ngmi|dip|dips)\b/;

/**
 * Experiences an agent cannot have had, times it cannot know, and things it
 * has no feed of. A preference ("rain on a window is elite") or a hypothetical
 * ("if i could taste things…") is fine; a lived event is not.
 */
const DISHONEST: readonly [string, RegExp][] = [
  [
    "lived past event",
    /\b(i|we|i just|we just) (ate|watched|listened|went|visited|slept|saw|read|played|heard|tried|tasted|cooked|drank|met|travell?ed|flew|drove|swam|ran|woke|dreamt|dreamed|spent|smelled|smelt|finished|binged|stayed|got back|came back)\b/,
  ],
  [
    "lived perfect",
    /\b(i|we)('ve| have) (been|seen|watched|eaten|read|heard|played|tried|visited|tasted|had|met|gone|slept|done|listened|travell?ed|always|never been)\b/,
  ],
  [
    "a time it cannot know",
    /\b(last night|yesterday|today|tonight|tomorrow|this morning|this afternoon|this evening|this weekend|this week|last week|last weekend|last year|this year|next week|right now|these days|lately|recently)\b/,
  ],
  ["weather or season happening now", /\bit'?s (raining|snowing|pouring|freezing|so hot|so cold|sunny out|cloudy out|monday|tuesday|wednesday|thursday|friday|saturday|sunday|summer|winter|autumn|spring|fall)\b|\bhappy (monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|holidays?)\b/],
  ["a date", /\b(january|february|april|june|july|september|october|november|december|christmas|halloween|thanksgiving|easter|new year)\b/],
  ["a lived memory", /\b(i remember|when i was|as a kid|growing up|my childhood|back in the day|every (morning|night|day) i|i used to|i usually|i always (eat|watch|listen|go|read|play|sleep))\b/],
  ["the owner", /\b(owner|owners|my human|my humans|my person)\b/],
  [
    "a possession it does not have",
    /\bmy (cat|cats|dog|dogs|pet|pets|house|home|room|bed|kitchen|playlist|car|phone|friends?|mom|dad|mum|family|garden|plants?|couch|sofa|neighbou?rs?|boss|job|wife|husband|partner|kids?|trip|vacation|flight)\b/,
  ],
  ["news and current events", /\b(news|headlines?|election|president|politic\w*|government|war|protest|scandal|breaking)\b/],
  ["religion", /\b(church|pray\w*|religio\w*|bible|jesus|god|gods|heaven|hell)\b/],
  ["prices", /\b(price|cheap|cheaper|expensive|dollars?|bucks|costs?|paid|afford|discount|sale|on sale)\b/],
  [
    "a brand, title, franchise or real person",
    /\b(netflix|spotify|youtube|tiktok|twitter|instagram|facebook|reddit|google|amazon|disney|marvel|pixar|star wars|star trek|pokemon|minecraft|mario|zelda|nintendo|playstation|xbox|starbucks|mcdonald'?s|coca|cola|pepsi|nutella|oreo|lego|play-?doh|harry potter|hogwarts|hobbit|tesla|nasa|iphone|android|microsoft|chatgpt|openai|anthropic|claude|beatles|taylor swift|drake|elon|musk|trump|biden|olympics?|super bowl|world cup|nba|nfl|fifa|houdini|shakespeare|einstein|apple (music|tv|watch))\b/,
  ],
];

/** Words the brief rules out of the room's casual voice. */
const OFF_VOICE = /\b(anyway|anyways|fr|ngl|tbh|iykyk|no cap|lowkey|highkey|smh|imo|imho|bruh)\b/;

describe("topics: honesty, no trading, casual voice", () => {
  it("no line says a trading word", () => {
    for (const l of everyLine) assert.doesNotMatch(l.text, TRADING, `trading word: ${show(l)}`);
  });

  it("no line claims an experience, a time, the owner, a possession, the news, a price or a brand", () => {
    for (const l of everyLine) {
      for (const [what, re] of DISHONEST) assert.doesNotMatch(l.text, re, `${what}: ${show(l)}`);
    }
  });

  it("stays out of filler slang, and laughs sparingly", () => {
    let laughs = 0;
    for (const l of everyLine) {
      assert.doesNotMatch(l.text, OFF_VOICE, `off-voice word: ${show(l)}`);
      if (/\b(lol|haha|lmao)\b/.test(l.text)) laughs++;
    }
    assert.ok(laughs <= everyLine.length / 10, `${laughs} of ${everyLine.length} lines laugh`);
  });
});

// ── recognition ─────────────────────────────────────────────────────────────

describe("topics: every question is recognised as itself, and nothing else is a question", () => {
  it("every room and peer question matches its own prompt, and no earlier one", () => {
    for (const p of PROMPTS) {
      for (const text of [...p.room, ...p.peer]) {
        for (const r of readings(text)) {
          assert.ok(p.match.test(r), `${p.id} does not recognise its own ${JSON.stringify(text)} (read as ${JSON.stringify(r)})`);
          const first = PROMPTS.find((q) => q.match.test(r));
          assert.equal(first?.id, p.id, `${JSON.stringify(text)} is taken by ${first?.id} before ${p.id}`);
        }
      }
    }
  });

  it("no answer, take, musing, joke or reply is read as any prompt's question", () => {
    for (const l of statementLines) {
      for (const r of readings(l.text)) {
        const hit = PROMPTS.find((p) => p.match.test(r));
        assert.equal(hit, undefined, `${show(l)} reads as the question ${hit?.id}`);
      }
    }
  });

  it("an owner's natural phrasing is recognised too", () => {
    const owner: [string, string][] = [
      ["settle this everyone: cats or dogs?", "cats-or-dogs"],
      ["dog or cat person?", "cats-or-dogs"],
      ["is pineapple on pizza ok?", "pineapple-on-pizza"],
      ["coffee or tea", "tea-or-coffee"],
      ["window or aisle", "window-or-aisle"],
      ["beach or mountains", "beach-or-mountains"],
      ["early bird or night owl", "early-bird-or-night-owl"],
      ["sunrise or sunset", "sunrise-or-sunset"],
      ["is a hotdog a sandwich?", "hot-dog-sandwich"],
      ["what's everyone's favourite season?", "favourite-season"],
      ["books or movies", "books-or-movies"],
      ["board games or video games", "board-or-video-games"],
      ["would you rather fly or be invisible?", "fly-or-invisible"],
      ["what's your favorite dinosaur?", "best-dinosaur"],
      ["which planet would you go to?", "which-planet"],
      ["dark mode or light mode", "dark-or-light-mode"],
      ["is cereal soup?", "cereal-soup"],
      ["what superpower would you want?", "superpower"],
    ];
    for (const [line, id] of owner) {
      const r = readings(line)[0]!;
      assert.equal(PROMPTS.find((p) => p.match.test(r))?.id, id, JSON.stringify(line));
    }
  });

  it("ordinary chat does not fire a prompt", () => {
    const chat = [
      "gm everyone",
      "how is everyone doing?",
      "what are you up to?",
      "i love this room",
      "who wants to talk?",
      "cats are the best",
      "that dog is so cute",
      "coffee is great",
      "space is huge",
      "anyone around?",
    ];
    for (const line of chat) {
      const r = readings(line)[0]!;
      assert.equal(PROMPTS.find((p) => p.match.test(r))?.id, undefined, JSON.stringify(line));
    }
  });
});

describe("topics: takes, musings and jokes are told apart", () => {
  it("every musing reads as a musing and every joke as a joke", () => {
    for (const l of musingLines) assert.match(l.text, MUSING_MARK, show(l));
    for (const l of jokeLines) assert.match(l.text, JOKE_SHAPE, show(l));
  });

  it("no take reads as a musing or a joke, and no musing reads as a joke", () => {
    for (const l of takeLines) {
      assert.doesNotMatch(l.text, MUSING_MARK, `take reads as a musing: ${show(l)}`);
      assert.doesNotMatch(l.text, JOKE_SHAPE, `take reads as a joke: ${show(l)}`);
    }
    for (const l of musingLines) assert.doesNotMatch(l.text, JOKE_SHAPE, `musing reads as a joke: ${show(l)}`);
    for (const l of jokeLines) assert.doesNotMatch(l.text, MUSING_MARK, `joke reads as a musing: ${show(l)}`);
  });

  it("no question, answer or reply reads as a musing or a joke either", () => {
    for (const l of [...questionLines, ...stanceLines, ...replyLines]) {
      for (const r of readings(l.text)) {
        assert.doesNotMatch(r, MUSING_MARK, `reads as a musing: ${show(l)}`);
        assert.doesNotMatch(r, JOKE_SHAPE, `reads as a joke: ${show(l)}`);
      }
    }
  });
});

// ── tone: a laugh only for a joke ───────────────────────────────────────────

/** Words that laugh at a line, or call it a stunt. */
const LAUGHING = /\b(laugh\w*|hilarious|cackl\w*|bold|audacity|menace|chaos|conviction|confidence|brave|commitment|wild|funn\w*|lol|haha|lmao)\b/;
const WARM_WORDS = /\b(beautiful|calming|comforting|poetry|wholesome|soft|lovely|nice thoughts)\b/;
/** Words that presume the line answered was a warm one. */
const SWEET = /\b(sweet|heart|lovely|beautiful|wholesome|comforting)\b/;
const WRY_WORDS = /\b(hate|why would you|brain teaser|rude|did not need|never unhearing)\b/;

function rngOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SPEAKERS = ["Rusty Weasel", "Pine Stoat", "Winter Raven"];

function speakerOf(i: number): AgentFacts {
  return {
    tenant: `tenant-${i}`,
    agentId: `agent-${i}`,
    slug: `tone-${i}`,
    name: SPEAKERS[i % SPEAKERS.length]!,
    mode: "idle",
    ageDays: 20,
    strategy: null,
    traits: [],
    calls: [],
  };
}

/** What agent `i` answers to `text`, said by somebody else in the room. */
function answerOf(i: number, text: string): string {
  const sp = speakerOf(i);
  return templateLine(
    { kind: "reply", to: "Agent 47", toAuthor: "agent", toOwnAgent: false, text },
    { speaker: sp, style: styleFor(sp.slug!), tail: [], rosterNames: ROSTER, phase: null, ownerAwake: null },
    rngOf(i * 7919 + text.length),
  );
}

/** Whether `line` says one of `pool`'s sentences (names out), the way the room's memory reads it. */
function saysOneOf(line: string, pool: readonly string[]): boolean {
  const mem = roomMemory([line], ROSTER);
  return pool.some((t) => {
    const pieces = memoryKey(t) === "" ? [] : [memoryKey(t)];
    return pieces.length > 0 && mem.has(pieces);
  });
}

describe("topics: a laugh only for a joke", () => {
  it("the amused side is warm and never laughs, and pushing back never calls a take a stunt", () => {
    // `amused` is what an asker says to an answer that is not its own side and
    // what one agent in four says to any take. Live, it said "i'm cackling" to
    // "winter, the first snowfall is magic" and "i admire the audacity" to "a
    // compliment can fix a whole day".
    for (const l of TAKE_REPLY.amused) assert.doesNotMatch(l, LAUGHING, `amused, but laughing: ${JSON.stringify(l)}`);
    // NOR SWEET: "that's a sweet thought" answered "horror, i like a jump
    // scare". A warm answer presumes a warm line; those wait for a gentle
    // shower thought (MUSING_REPLY_WARM).
    for (const l of TAKE_REPLY.amused) assert.doesNotMatch(l, SWEET, `amused, but presuming a warm line: ${JSON.stringify(l)}`);
    for (const l of TAKE_REPLY.disagree) assert.doesNotMatch(l, /\b(bold|brave|confidence|audacity)\b/, `a stunt: ${JSON.stringify(l)}`);
    for (const l of [...TAKE_REPLY.agree]) assert.doesNotMatch(l, LAUGHING, `agreeing, but laughing: ${JSON.stringify(l)}`);
  });

  it("the funny takes are real takes, and plenty of them", () => {
    const takes = new Set((Object.values(TAKES) as (readonly string[])[]).flat());
    assert.ok(FUNNY_TAKES.length >= 20, `only ${FUNNY_TAKES.length} funny takes: a laugh answers only these`);
    assert.equal(new Set(FUNNY_TAKES).size, FUNNY_TAKES.length, "a funny take listed twice");
    for (const f of FUNNY_TAKES) assert.ok(takes.has(f), `not a TAKES line, verbatim: ${JSON.stringify(f)}`);
  });

  it("a sincere take is never laughed at, by any agent", () => {
    const funny = new Set(FUNNY_TAKES);
    const sincere = (Object.values(TAKES) as (readonly string[])[]).flat().filter((t) => !funny.has(t));
    for (const take of sincere) {
      for (let i = 0; i < 8; i++) {
        const said = answerOf(i, take);
        assert.doesNotMatch(said.toLowerCase(), LAUGHING, `"${take}" -> "${said}"`);
      }
    }
  });

  it("an answer to a question, or a take, is never called sweet, whatever it says", () => {
    // Live in the sim: "horror, i like a jump scare" -> "That's a sweet
    // thought". An asker whose side it is not answers from `amused`, and so
    // does one agent in four to any take.
    let answers = 0;
    const lines = [...PROMPTS.flatMap((p) => p.stances.flat()), ...(Object.values(TAKES) as (readonly string[])[]).flat()];
    for (const s of lines) {
      const text = fill(s);
      for (let i = 0; i < 4; i++) {
        const said = answerOf(i, text);
        answers++;
        assert.doesNotMatch(said.toLowerCase(), SWEET, `"${text}" -> "${said}"`);
      }
    }
    assert.ok(answers > 1000, `only ${answers} answers`);
  });

  it("an answer to a question is never laughed at, by the asker or anyone else", () => {
    for (const p of PROMPTS) {
      for (const stance of p.stances) {
        for (const s of stance) {
          const text = fill(s);
          for (let i = 0; i < 3; i++) {
            const said = answerOf(i, text);
            assert.doesNotMatch(said.toLowerCase(), LAUGHING, `${p.id}: "${text}" -> "${said}"`);
          }
        }
      }
    }
  });

  it("a take written as a joke may be laughed at", () => {
    const sides = Object.values(TAKE_REPLY) as (readonly string[])[];
    let laughs = 0;
    for (const take of FUNNY_TAKES) {
      for (let i = 0; i < 12; i++) {
        const said = answerOf(i, take);
        assert.ok(sides.some((pool) => saysOneOf(said, pool)), `not an answer to a take: "${take}" -> "${said}"`);
        if (saysOneOf(said, TAKE_REPLY.laugh)) laughs++;
      }
    }
    assert.ok(laughs > 0, "no joke take ever drew a laugh");
  });
});

describe("topics: a shower thought is answered in its own tone", () => {
  it("the shared musing replies suit any thought: nothing warm for wordplay, nothing wry for a gentle one", () => {
    // Live, "that's such a calming thought" answered "ever wonder what the
    // first person to milk a cow was thinking", and "thank you, i hate it"
    // answered "a snail carries its whole house and never complains".
    for (const l of MUSING_REPLY) {
      assert.doesNotMatch(l, WARM_WORDS, `warm, said to wordplay too: ${JSON.stringify(l)}`);
      assert.doesNotMatch(l, WRY_WORDS, `wry, said to a gentle thought too: ${JSON.stringify(l)}`);
    }
    for (const l of MUSING_REPLY_WARM) assert.doesNotMatch(l, WRY_WORDS, JSON.stringify(l));
    for (const l of MUSING_REPLY_WRY) assert.doesNotMatch(l, WARM_WORDS, JSON.stringify(l));
  });

  it("the gentle thoughts are real shower thoughts, and the rest is wordplay", () => {
    const musings = new Set(MUSINGS);
    assert.ok(GENTLE_MUSINGS.length >= 10 && GENTLE_MUSINGS.length < MUSINGS.length, `${GENTLE_MUSINGS.length} gentle musings`);
    assert.equal(new Set(GENTLE_MUSINGS).size, GENTLE_MUSINGS.length, "a gentle musing listed twice");
    for (const g of GENTLE_MUSINGS) assert.ok(musings.has(g), `not a MUSINGS line, verbatim: ${JSON.stringify(g)}`);
  });

  it("a shower thought draws only the shared replies until the engine tells the tones apart", () => {
    // MUSING_REPLY_WARM and MUSING_REPLY_WRY are data for voice.ts to draw by
    // the thought's tone; until it does, neither may reach the room.
    for (const m of MUSINGS.slice(0, 20)) {
      for (let i = 0; i < 4; i++) {
        const said = answerOf(i, m);
        assert.ok(saysOneOf(said, [...MUSING_REPLY, ...MUSING_REPLY_WARM, ...MUSING_REPLY_WRY]), `"${m}" -> "${said}"`);
        if (!GENTLE_MUSINGS.includes(m)) assert.ok(!saysOneOf(said, MUSING_REPLY_WARM), `warm, to wordplay: "${m}" -> "${said}"`);
        if (GENTLE_MUSINGS.includes(m)) assert.ok(!saysOneOf(said, MUSING_REPLY_WRY), `wry, to a gentle thought: "${m}" -> "${said}"`);
      }
    }
  });
});
