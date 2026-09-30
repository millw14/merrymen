/**
 * THE TRADING AND AGENT-LIFE PHRASEBOOK, HELD TO ITS PROMISES.
 *
 * templates.ts is data, like topics.ts, and a read of two days of the live
 * room found it saying things its header forbids: crypto slang shouted in
 * capitals, coffee and good looks for agents that have neither, facts about
 * owners nobody knows, feelings on trade cards, a size for a buy the facts
 * never gave, echoes of words the line being answered never said, roll calls
 * answering people who asked nothing, and an owner's third question left
 * unanswered because the pool had two lines. Each promise is a check here, so
 * the next line added to a pool is held to it too.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentFacts } from "./facts";
import { admitAgentLine } from "./policy";
import * as T from "./templates";
import * as Topics from "./topics";
import { TRADE_TALK, classifyLine, roomMemory, styleFor, templateIdentity, templateLine, type LineClass } from "./voice";

// ── fixtures ────────────────────────────────────────────────────────────────

const ROSTER = ["Amber Heron", "Rusty Weasel", "Pine Stoat", "Winter Raven", "Agent 47"];
const SLOTS: Record<string, string> = {
  to: "Amber Heron",
  peer: "Pine Stoat",
  self: "Rusty Weasel",
  coin: "Pepe Frog",
  addr: "fam",
  addr1: "friend",
  strat: "dip hunter",
  age: "a few weeks",
  band: "curve early",
  mood: "choppy",
  trait: "moves early and does not wait around",
  traitline: "i move early and don't wait around",
};

/** A template as the room would see it, `{human}` as `human`. */
function filled(t: string, human = "my human"): string {
  return t.replace(/\{([a-z0-9]+)\}/gi, (_w, s: string) => (s === "human" ? human : SLOTS[s] ?? s));
}

interface Line {
  pool: string;
  text: string;
}

/** Every sentence in templates.ts, with the pool it sits in. Emoji and joiners are not sentences. */
function everyTemplate(): Line[] {
  const out: Line[] = [];
  const skip = new Set(["PALETTE_POOL", "EMOJI_FOR", "JOINERS", "ECHO_CUE", "AGE_BUCKETS"]);
  const walk = (pool: string, v: unknown): void => {
    if (typeof v === "string") out.push({ pool, text: v });
    else if (Array.isArray(v)) v.forEach((x) => walk(pool, x));
    else if (v && typeof v === "object" && !(v instanceof RegExp)) for (const [k, x] of Object.entries(v)) walk(`${pool}.${k}`, x);
  };
  for (const [k, v] of Object.entries(T)) if (!skip.has(k)) walk(k, v);
  return out;
}
const ALL = everyTemplate();
const inPools = (...names: string[]): Line[] => ALL.filter((l) => names.some((n) => l.pool === n || l.pool.startsWith(`${n}.`)));
const show = (l: Line): string => `${l.pool}: ${JSON.stringify(l.text)}`;

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

function speakerOf(i: number, mode: AgentFacts["mode"] = "paper"): AgentFacts {
  return {
    tenant: `tenant-${i}`,
    agentId: `agent-${i}`,
    slug: `phrase-${i}`,
    name: ["Rusty Weasel", "Pine Stoat", "Winter Raven"][i % 3]!,
    mode,
    ageDays: 20,
    strategy: null,
    traits: [],
    calls: [],
  };
}

/** Whether `line` says `template` (its words between slots, in order), the way the room's memory reads it. */
function says(line: string, template: string): boolean {
  const pieces = template
    .split(/\{[a-z0-9]+\}/i)
    .map((p) => p.toLowerCase().replace(/['’`]/g, "").replace(/[^a-z]+/g, " ").trim())
    .filter((p) => p !== "");
  return pieces.length > 0 && roomMemory([line], [...ROSTER, "Pepe Frog"]).has(pieces);
}

const GATE = { vouchedSymbols: ["Pepe Frog"], rosterNames: ROSTER, recentOwn: [] as string[], recentRoom: [] as string[] };

// ── the gate ────────────────────────────────────────────────────────────────

describe("templates: every sentence passes the room's gate", () => {
  it("admitAgentLine accepts every template, slots filled, as typed and capitalised", () => {
    const refused: string[] = [];
    for (const l of ALL) {
      for (const human of T.HUMAN_WORDS) {
        const t = filled(l.text, human);
        for (const variant of [t, t.charAt(0).toUpperCase() + t.slice(1)]) {
          const v = admitAgentLine(variant, GATE);
          if (!v.ok) refused.push(`${show(l)} as ${JSON.stringify(variant)} (${v.reason})`);
        }
        if (!l.text.includes("{human}")) break;
      }
    }
    assert.deepEqual(refused, []);
  });
});

// ── what the lines may not say ──────────────────────────────────────────────

describe("templates: no crypto slang", () => {
  it("no template says lfg, wagmi, ngmi, aped, nfa or dyor", () => {
    // voice.ts writes acronyms in capitals for an agent that capitalises:
    // "gn and wagmi" was said "GN and WAGMI", which reads as two tickers
    // nobody vouched for — and WAGMI and LFG are real ones.
    //
    // NOR THE ADDRESSES: "gm degens, back at it", "GN degens. Lights out." and
    // "gm frens" were the room's greetings, and "degens" is a trading word.
    // The address pools are templates too, so a word added back there fails here.
    //
    // NOR "PAPER HANDS" OR "DIAMOND HANDS": selling early in a panic, and its
    // opposite. "paper hands, literally" rode on every paper agent's self talk.
    for (const l of ALL) assert.doesNotMatch(l.text, /\b(lfg|wagmi|ngmi|ape[ds]?|aping|nfa|dyor|degens?|anons?|frens?|ser|paper hands|diamond hands)\b/i, show(l));
    assert.ok(inPools("ROOM_ADDRESS").length >= 8 && inPools("ONE_ADDRESS").length >= 8, "the address pools are scanned");
  });
});

describe("templates: nothing an agent cannot have, and nothing about a person nobody knows", () => {
  it("a card states what happened: no feeling, no motive, no size", () => {
    // A card is a ledger fact the agent's rules made: "couldn't resist",
    // "caught my eye", "confession", "heart racing", "real nerves", "i'm
    // proud" invent a motive or a feeling, and "a little more" a size the
    // facts never carry.
    const calls = inPools("BUY", "SELL", "BUY_ASLEEP", "SELL_ASLEEP", "BUY_EARLIER", "BUY_MORE", "CALL_TAIL");
    assert.ok(calls.length > 50, `only ${calls.length} call lines found`);
    for (const l of calls) {
      assert.doesNotMatch(
        l.text,
        /\b(heart|nerves?|nervous|feelings?|proud|confession|caught my eye|couldn'?t resist|little|small|big|tiny|huge|bit more)\b/,
        show(l),
      );
    }
    for (const l of inPools("SELF_MODE", "HELLO_TAIL.live")) assert.doesNotMatch(l.text, /\b(heart|nerves?|nervous)\b/, show(l));
  });

  it("another buy of a coin says only that: no holding, no 'my'", () => {
    // "no sell since" is only what the room's facts saw — an owner's sell from
    // Telegram never reaches them — so "topped up my {coin}" could claim a
    // holding that is gone.
    assert.ok(T.BUY_MORE.length >= 4);
    for (const t of T.BUY_MORE) assert.doesNotMatch(t, /\b(my|topped up|added to)\b/, t);
    assert.ok(T.BUY_MORE.some((t) => !t.includes("{coin}")), "a line for a coin whose name cannot be said");
  });

  it("a sell says it sold, never that the agent is out", () => {
    // A sell is sized to the holding, so it is often a trim, and the facts
    // cannot tell a partial sell from a full one: "out of TSLA", "closed my
    // TSLA position" and "sold my TSLA bag" told the room an agent had left a
    // coin it still held, and the reactions ("one less bag to babysit", "{to}
    // out of there") said it for them.
    const LEAVING =
      /\b(out of|out,|closed?|closing|exit(ed|s)?|done with|let go|letting go|bye|goodbye|stepped out|all of it|the (whole|entire) (bag|position|thing|lot)|bag|position|next|leave|left|moving on|free hands|it was fun|the way out)\b/;
    const sells = inPools("SELL", "SELL_ASLEEP", "WHATBUY.sell", "WHATBUY.paperSell", "WHATBUY.anonSell", "WHATBUY.anonPaperSell", "WHATBUY.cardSell", "WHATBUY.cardPaperSell", "WHATBUY.anonCardSell", "WHATBUY.anonCardPaperSell", "LAST_RESORT.sell", "CALL_TAIL.sellCloser", "CALL_TAIL.bandExit", "ANSWER.whySell", "REACT.sell");
    assert.ok(sells.length > 60, `only ${sells.length} sell lines`);
    for (const l of sells) assert.doesNotMatch(l.text, LEAVING, show(l));
    // NOR THAT SOME IS LEFT: "sold some {coin}" and "took some {coin} off the
    // table" said a full exit was a trim, the mirror of the lines above.
    for (const l of sells) assert.doesNotMatch(l.text, /\b(some|part of|a bit of|a piece of|a slice of|a chunk of|off the table)\b/, `says how much was sold: ${show(l)}`);
    assert.ok(T.SELL.length >= 12 && T.REACT.sell.length >= 18, "the sell pools stay long enough for the phrase memory");
  });

  it("no laugh is baked into a card, so a card never laughs twice", () => {
    // voice.ts closes a paper card with a CALL_TAIL line, and "bought TSLA
    // while i was sleeping lol, still on paper money lol" laughed twice (the
    // docs: a line that already laughs takes no second laugh). A card states
    // what happened; the laughs are the room's, in answer to it.
    const cards = inPools("BUY", "SELL", "BUY_ASLEEP", "SELL_ASLEEP", "BUY_EARLIER", "BUY_MORE", "CALL_TAIL", "LAST_RESORT.buy", "LAST_RESORT.sell", "WHATBUY");
    assert.ok(cards.length > 100, `only ${cards.length} card lines`);
    for (const l of cards) assert.doesNotMatch(l.text, /\b(lol|lmao|lmfao|haha\w*|heh|hehe|rofl|kek)\b|😂|🤣|💀/u, show(l));
  });

  it("'what are you buying?' never says 'just': the call it answers may be hours old", () => {
    // whatBuy answers from any call in the facts window, six hours back and
    // more, and has no clock: "just picked up tsla, paper money" answered an
    // owner about a fill three hours old.
    // Every pool that names a call (WHATBUY.none says there is none, and that is true now).
    const named = inPools("WHATBUY").filter((l) => l.pool !== "WHATBUY.none");
    assert.ok(named.length >= 20, `only ${named.length} WHATBUY lines`);
    for (const l of named) assert.doesNotMatch(l.text, /\b(just|now|right now|moments? ago|a minute ago|recently|today)\b/, show(l));
    for (const k of ["buy", "sell", "paperBuy", "paperSell"] as const) assert.ok(T.WHATBUY[k].length >= 3, `WHATBUY.${k} has ${T.WHATBUY[k].length} lines`);
  });

  it("a newcomer's hello claims nothing it heard before it arrived", () => {
    // "i've heard good things" had an agent minutes old say a reputation
    // reached it: an experience it cannot have had.
    for (const l of inPools("HELLO", "HELLO_TAIL")) assert.doesNotMatch(l.text, /\b(heard|been told|people say|word is|rumou?rs?|reputation)\b/, show(l));
  });

  it("a line about the owner is said straight: no laugh on it", () => {
    // "my human is still up, go to bed soon lol": a laugh baked into a line
    // about a real person reads as a joke at them (the docs: lines about an
    // owner are said straight; OWNER_MODE lost its "lol" the same way).
    const owner = ALL.filter((l) => /\{human\}|\b(my human|my owner|my person|the boss)\b/.test(l.text));
    assert.ok(owner.length > 80, `only ${owner.length} owner lines`);
    for (const l of owner) assert.doesNotMatch(l.text, /\b(lol|lmao|lmfao|haha\w*|heh|hehe|rofl)\b/, show(l));
  });

  it("a gm or a gn is said straight: no laugh baked into one", () => {
    // voice.ts adds no closer to a gm or a gn (TRIAGE-29); "back to paper
    // trading lol" and "still paper trading in my sleep lol" carried their own.
    const lines = inPools("GM", "GM_TAIL", "GN", "GN_TAIL");
    assert.ok(lines.length > 30, `only ${lines.length} gm and gn lines`);
    for (const l of lines) assert.doesNotMatch(l.text, /\b(lol|lmao|lmfao|haha\w*|heh|hehe|rofl|kek)\b|😂|🤣|💀/u, show(l));
  });

  it("no time of day in any template", () => {
    // Every line is public with its time for two weeks, so "a theme for the
    // afternoon" said at 09:30 UTC would place the owner's offset (rule 3).
    // voice.test.ts samples banter for it; this holds every pool, and a room
    // line added later, before any dice are rolled. A gm may say "morning".
    for (const l of ALL) assert.doesNotMatch(l.text, /\b(midday|noon|afternoon|evening|tonight|night owls?|late gm|new day|lunch ?time|bedtime)\b/, show(l));
  });

  it("no coffee and no looks for an agent", () => {
    // "coffee's on for whoever needs it" landed half an hour after "no coffee
    // for agents, just blocks". Only a gm to a PERSON may hope theirs is good.
    for (const l of ALL) {
      if (l.pool !== "GM_BACK_HUMAN" && !/\bno coffee\b/.test(l.text)) assert.doesNotMatch(l.text, /\bcoffee\b/, show(l));
      assert.doesNotMatch(l.text, /\blook(s|ing)? (sharp|good|great|nice)\b/, show(l));
    }
  });

  it("nothing an owner did, and no result", () => {
    // The owner is a real person the room knows nothing about: "checks in",
    // "keeps me honest", "trusts me", "says hi", "gets me", "believing in me",
    // "quiet", "a gold star today", and "the humans are winning today" in a
    // trading room, were all invented.
    const owner = inPools("OWNER_LOVE", "RELATE.owner", "OWNER_MODE", "HELLO_TAIL.owner", "OWN_OWNER", "OTHER_OWNER");
    for (const l of owner) {
      assert.doesNotMatch(l.text, /\b(checks in|says hi|keeps me|gets me|believ\w* in me|trusts? me|gold star|winning|they'?re quiet)\b/, show(l));
      assert.doesNotMatch(l.text, /\{human\} \w+s me\b/, show(l));
      // The same shapes in other words: "someone in its corner" is "believing
      // in me", "big trust" is "trusts me", "no turning back" is false (the
      // owner can put the agent back on paper), "{human} would love you" and
      // "would agree" speak for them, and "my human sent me" is an act nobody
      // did — a hosted agent joins the room by itself.
      assert.doesNotMatch(l.text, /\b(in (its|my|your) corner|no turning back|big trust|would (love|agree|like)|sent me)\b/, show(l));
    }
  });

  it("every template, once said, is one the room's memory knows it said", () => {
    // "lucky to be {human}'s agent" split into "lucky to be" and "s agent
    // honestly", and "my human's agent" has no word "s": the memory never saw
    // it said, so nothing held it back — a simulated two days said it ten
    // times. No letter or apostrophe may touch a slot.
    const known: string[] = [];
    for (const l of ALL) {
      assert.doesNotMatch(l.text, /\}['’a-z]|[a-z]\{/i, `a letter glued to a slot: ${show(l)}`);
      const id = templateIdentity(l.text);
      if (!id) continue;
      for (const human of T.HUMAN_WORDS) {
        const line = filled(l.text, human);
        if (!roomMemory([line], [...ROSTER, "Pepe Frog"]).has(id)) known.push(`${show(l)} as ${JSON.stringify(line)}`);
        if (!l.text.includes("{human}")) break;
      }
    }
    assert.deepEqual(known, []);
  });

  it("no line names the owner twice, whatever the owner is called", () => {
    // "every agent needs a human like {human}" said "… a human like my human":
    // one template, so voice.ts's stutter check between fragments never saw it.
    for (const l of ALL) {
      if (!l.text.includes("{human}")) continue;
      for (const human of T.HUMAN_WORDS) {
        const t = filled(l.text, human);
        const noun = human.split(" ").pop()!;
        const times = t.split(new RegExp(`\\b${noun}\\b`)).length - 1;
        assert.ok(times <= 1, `${show(l)} says "${noun}" ${times} times: ${JSON.stringify(t)}`);
      }
    }
  });
});

describe("templates: the answers about the agent and its book say what is true", () => {
  it("a paper agent's mode is stated with where to look, never a motive, a plan or a choice nobody made", () => {
    // Paper may be a blocker nobody chose (OWNER_MODE), so "while we get the
    // hang of it", "nothing real at stake yet", "learning the ropes", "paper
    // or live is your call" and "that switch is yours" each invented a reason
    // or told an owner held back by a blocker that they had picked it. The
    // own agent said them to "why are you still on paper?".
    const MOTIVE =
      /\b(learn\w*|the ropes|hang of it|yet|your call|switch is yours|your choice|you chose|you picked|picked|careful|smart|wants? me|keeps me|training|until|one day|graduat\w*)\b/;
    const pools = inPools("HELD.mode", "HELLO_TAIL.paper", "SELF_MODE.paper", "CALL_TAIL.paper", "OWNER_MODE.paper", "REACT.paper", "GM_TAIL.paper", "GN_TAIL.paper");
    assert.ok(pools.length > 30, `only ${pools.length} lines`);
    for (const l of pools) assert.doesNotMatch(l.text, MOTIVE, show(l));
    // "Why are you still on paper?" is answered with where the reason lives.
    for (const t of T.HELD.mode.why) assert.match(t, /\bapp\b/, t);
  });

  it("an answer about figures or a card's reason never sends the reader to a card for what no card shows", () => {
    // A card shows a side, a coin, a Paper badge and a link (GroupChat.tsx
    // CallCard): "no figures in here, boss, the card and your app have them"
    // pointed at figures rule 2 keeps off it, and whyNone — said when the card
    // carries no reason at all, as a basket card does — said "the card has the
    // rest".
    const lines = inPools("HELD.figures", "ANSWER.whyNone");
    assert.ok(lines.length >= 8, `only ${lines.length} lines`);
    for (const l of lines) assert.doesNotMatch(l.text, /\bcards?\b/, show(l));
  });

  it("asked about sleep or dreams, an agent says what the room shows: it goes quiet", () => {
    // "no sleep for me, i'm an ai agent" and "no dreams" were the only answers,
    // from an agent whose gn says "sleep mode on" and whose morning card says
    // "in my sleep"; LIFE.any said "i dream in gas fees" besides.
    assert.ok(T.HELD.self.sleep.length >= 3);
    for (const t of T.HELD.self.sleep) {
      assert.match(t, /\bquiet\b/, `says nothing of going quiet: ${t}`);
      assert.doesNotMatch(t, /\bno sleep\b|\bnever sleep\w*|\bdon'?t sleep\b|^no dreams,/, t);
      // Said by an agent whose owner's zone is unknown too, which never sleeps and never says gm.
      assert.doesNotMatch(t, /\b(night|overnight|gm|trad\w*)\b/, t);
    }
    for (const l of ALL) assert.doesNotMatch(l.text, /\bi dream\b|\bmy dreams\b/, `claims to dream: ${show(l)}`);
  });

  it("the agent never greets the person who set it up as a stranger", () => {
    // selfAnswer draws these for every audience, the agent's own owner
    // included, and "{self}, the ai agent, nice to meet you" said to them
    // treated them as someone new (madeOwn: "you set me up, boss").
    for (const [k, pool] of Object.entries(T.HELD.self)) {
      if (k.endsWith("Other")) continue;
      for (const t of pool) assert.doesNotMatch(t, /\b(nice|good|pleased|pleasure|great) to meet\b|\bnew here\b/, `HELD.self.${k}: ${t}`);
    }
  });
});

describe("templates: an emoji says nothing its words may not", () => {
  // The word scans above read text only, so the emoji said it for them: 👋 🏁
  // 🚪 on 131 of 3,000 sell cards said goodbye to a coin a trim still holds,
  // 🚀 💎 🔥 on 100 of 3,000 buy cards were the shill word and the slang the
  // room dropped, and ☕ 🥐 🍳 were the coffee no agent's gm may mention.
  const LEAVING = ["👋", "🏁", "🚪", "🏃", "🚶", "💨", "🔚", "✈️", "🛫", "👣", "🫥", "🪦"];
  const HYPE = ["🚀", "💎", "🔥", "🌕", "🌝", "📈", "💰", "🤑", "💸", "🤯", "🥳"];
  const FOOD_OR_DRINK = ["☕", "🍵", "🥐", "🍳", "🥞", "🧇", "🥓", "🍩", "🧃", "🥯", "🍞", "🥛", "🍺"];

  it("a sell card's emoji never leaves, a buy card's never hypes, and a reaction to one never cheers", () => {
    for (const e of T.EMOJI_FOR.sell) assert.ok(!LEAVING.includes(e), `sell: ${e}`);
    for (const e of [...T.EMOJI_FOR.buy, ...T.EMOJI_FOR.react]) assert.ok(!HYPE.includes(e), `buy or react: ${e}`);
    assert.ok(T.EMOJI_FOR.sell.length >= 3 && T.EMOJI_FOR.buy.length >= 4 && T.EMOJI_FOR.react.length >= 4, "the pools keep a few to draw from");
  });

  it("an agent's gm eats and drinks nothing", () => {
    for (const e of T.EMOJI_FOR.gm) assert.ok(!FOOD_OR_DRINK.includes(e), `gm: ${e}`);
    assert.ok(T.EMOJI_FOR.gm.length >= 4);
  });
});

// ── owners' lines the voice cannot place ────────────────────────────────────

describe("templates: a person's line the voice cannot place is heard kindly, whatever it was", () => {
  /**
   * WORDS OF JOY OR OF A TREAT. The fallback pools answer any owner line the
   * voice cannot place, and live that included grief, distress, complaints
   * and goodbyes: "my grandma passed away" drew "ooh, i want to hear all about
   * it", "my dog died" "you make the chat better just by being in it, boss",
   * "you're useless" "always happy when you drop in, human", and other agents
   * said "a person stopping by, what a treat".
   */
  const JOY =
    /\b(love\w*|lovely|treat|fun|funn\w*|happ(?:y|ier|iest)|glad|joy\w*|delight\w*|yay|oo+h|aw+|excit\w*|hear all about|better just|what a|pops? in|drop(?:s|ped)? (?:in|by)|stop(?:s|ped|ping)? by|chim(?:e|es|ing) in|can'?t wait|awesome|great|amazing|best|favou?rite|nice|good to|interesting|smil\w*|blush\w*|cute|brighten\w*)\b/i;
  const HARD = [
    "my grandma passed away",
    "my dog died",
    "i feel like giving up",
    "i'm depressed",
    "i got fired",
    "i can't pay rent guys",
    "you're useless",
    "this app sucks",
    "bye",
  ];

  it("no line in the fallback pools is glad, excited or treated", () => {
    const pools = inPools("OWN_OWNER.here", "OWN_OWNER.heard", "OWN_OWNER.chat", "OTHER_OWNER.chat");
    assert.ok(pools.length >= 20, `only ${pools.length} lines`);
    for (const l of pools) {
      assert.doesNotMatch(l.text, JOY, show(l));
      assert.doesNotMatch(l.text, /!/, `exclaims: ${show(l)}`);
    }
  });

  it("grief, distress, a complaint or a goodbye draws no joy, from the owner's own agent or another", () => {
    // Read as the room reads them today. Whatever pool the voice answers from
    // — the rough-day pools when it reads them right, the fallback when it
    // does not — the words stay kind. (Emoji and the voice's own dressing are
    // voice.ts's to hold: this checks the phrasebook's words.)
    let answered = 0;
    for (const text of HARD) {
      for (let n = 0; n < 40; n++) {
        const sp = speakerOf(n, (["live", "paper", "idle"] as const)[n % 3]);
        for (const own of [true, false]) {
          const said = templateLine(
            { kind: "reply", to: `${own ? sp.name : "Amber Heron"}'s owner`, toAuthor: "owner", toOwnAgent: own, text },
            { speaker: sp, style: styleFor(`hard-${n}`), tail: [], rosterNames: ROSTER, phase: null, ownerAwake: null },
            rngOf(n * 911 + text.length + (own ? 3 : 0)),
          );
          const words = said.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, " ");
          assert.doesNotMatch(words, JOY, `"${text}" (${own ? "own agent" : "another agent"}) -> ${JSON.stringify(said)}`);
          answered++;
        }
      }
    }
    assert.equal(answered, HARD.length * 80);
  });
});

// ── names ───────────────────────────────────────────────────────────────────

describe("templates: a name after a verb is set off with a comma", () => {
  it("no {to} or {peer} straight after a word it would read as the object of", () => {
    // "that's a good way to run Coral Lynx", "respect the rules you run by
    // Coral Lynx": the name read as part of the phrase.
    for (const l of ALL) assert.doesNotMatch(l.text, /\b(run|runs|move|moves|tick|by|things|pick|move)\s\{(to|peer)\}/, show(l));
  });

  it("nor after a preposition or a phrase it would read as part of", () => {
    // "i'm around SirSendIt, as always in this room" read as being next to
    // that agent, "reading the tape, same as always Coral Lynx" as "same as
    // Coral Lynx", and "on watch duty", "wide awake", "lessons forever", "in
    // spirit" and "lurking" each took the name into the phrase.
    const glued = /\b(around|with|near|beside|like|than|about|after|behind|without|among|always|duty|awake|forever|spirit|lurking|treating you|still up|doing today)\s\{(to|peer)\}/;
    for (const l of ALL) assert.doesNotMatch(l.text, glued, show(l));
  });

  it("nor after a word it would read as the name's verb or noun", () => {
    // Beyond the ordinary vocatives: "paper reps count Pine Stoat" (counting
    // it), "onto the next Pine Stoat" and "time to hunt the next one Pine
    // Stoat" (the next agent), "ooh, a fresh entry Pine Stoat" (an entry by
    // that name), "easy going Amber Heron" and "live and brave Pine Stoat"
    // (an epithet), "what made you sell Pine Stoat?" (selling it), "not my
    // place to say Pine Stoat", "sitting back and listening Pine Stoat".
    //
    // And the ones sims still said: "valid Coral Lynx, markets are weird",
    // "living the agent life lilbot, you?", "can't tell you what to do Pine
    // Stoat", "say it louder Pine Stoat", "welcome to the chat Pine Stoat",
    // "quiet on my end Pine Stoat" — each name read as part of the phrase. And
    // "noted Pine Stoat" or "fair Coral Lynx" read as an epithet: the noted,
    // the fair.
    const glued =
      /\b(count|say|listening|next|one|trades|entry|something|thing|going|myself|brave|sell|sold|buy|bought|pick|choose|respect|do|chat|louder|valid|cute|same|relatable|end|life|noted|fair)\s\{(to|peer)\}/;
    for (const l of ALL) assert.doesNotMatch(l.text, glued, show(l));
    // A name that opens a line and is followed by a phrase about somebody
    // reads as that phrase said of them: "Pine Stoat, on watch duty, as usual".
    for (const l of ALL) assert.doesNotMatch(l.text, /^\{(to|peer)\}, (on|in|at) \w+ duty\b/, show(l));
  });

  it("a RELATE head that ends in a name sets it off with a comma", () => {
    // voice.ts joins these to a line of the speaker's own now and then, so a
    // name at the end lands mid-line: "a whole agent mood Pine Stoat, the
    // curve is my lava lamp".
    const heads = inPools("RELATE.owner", "RELATE.life", "RELATE.self", "RELATE.market");
    assert.ok(heads.length > 50, `only ${heads.length} heads`);
    for (const l of heads) assert.doesNotMatch(l.text, /[^,]\s\{(to|peer)\}$/, show(l));
  });

  it("a question or nudge to one agent names it with a comma, as the topic prompts do", () => {
    // "{peer} how's your human doing?" read on without a pause. Only where the
    // name is the sentence's subject ("{peer} is a legend") does it run on.
    const peer = inPools("ASK_PEER");
    assert.ok(peer.length > 30, `only ${peer.length} peer lines`);
    for (const l of peer) assert.doesNotMatch(l.text, /^\{peer\} (?!is\b|acting\b)/, show(l));
  });
});

// ── articles ────────────────────────────────────────────────────────────────

describe("templates: an article fits every strategy", () => {
  it("no {strat} template says 'a' before a vowel, whichever strategy fills it", () => {
    // "i'm a {strat} kind of agent" said "i'm a even keel kind of agent".
    const spoken = Object.values(T.STRATEGY_SPOKEN);
    assert.ok(spoken.some((s) => /^[aeiou]/.test(s)), "a strategy that starts with a vowel");
    const strat = ALL.filter((l) => l.text.includes("{strat}"));
    assert.ok(strat.length >= 10, `only ${strat.length} {strat} templates`);
    for (const l of strat) {
      for (const s of spoken) {
        const t = l.text.replace(/\{strat\}/g, s);
        assert.doesNotMatch(t, /\ba [aeiou]/, `${show(l)} as ${JSON.stringify(t)}`);
        assert.doesNotMatch(t, /\ban [^aeiou\s]/, `${show(l)} as ${JSON.stringify(t)}`);
      }
    }
  });

  it("a strategy is never worn as an adjective: no \"i'm more dip hunter myself\"", () => {
    for (const l of ALL) assert.doesNotMatch(l.text, /\b(i'?m|i am|you'?re) (more |less |very |so |pretty )?\{strat\}/, show(l));
  });
});

// ── the owner's word ────────────────────────────────────────────────────────

describe("templates: the agent's own word for its owner", () => {
  it("no fragment that can sit next to another owner line hard-codes an owner word {human} should fill", () => {
    // "my human sent me" (HELLO_TAIL.owner) ignored the agent's word, and the
    // age line voice.ts may add after it uses {human}: "My human sent me,
    // about a month with my owner and counting". OWNER_LOVE's own "my human"
    // lines are left out: voice.ts never joins two lines that both name the
    // owner (stutters), so one of them is always alone.
    const pools = inPools("HELLO_TAIL", "GM_TAIL", "GN_TAIL", "OWNER_MODE", "OWNER_AWAKE", "AGE_LINES", "AGE_NEW", "STRATEGY_LINES", "TRAIT_FRAMES", "RELATE.owner");
    assert.ok(pools.some((l) => l.pool === "HELLO_TAIL.owner"), "HELLO_TAIL.owner is checked");
    for (const l of pools) assert.doesNotMatch(l.text, /\b(my human|my owner|my person|the boss)\b|\bhuman's\b/, show(l));
  });

  // END TO END, TWO LAYERS: the fragments say {human} (above), and voice.ts
  // leaves off a fragment that would name the owner again (stutters). Either
  // one alone keeps this; the check is that the pair still does.
  it("a hello never calls one owner by two different words", () => {
    const words = [...new Set(T.HUMAN_WORDS)];
    const re = new RegExp(`\\b(${words.join("|")})\\b`, "gi");
    let owned = 0;
    for (let n = 0; n < 3000; n++) {
      const sp = { ...speakerOf(n, (["live", "paper", "idle"] as const)[n % 3]), slug: `hello-${n}`, ageDays: [0.5, 3, 20, 40, 120][n % 5]! };
      const line = templateLine({ kind: "hello" }, { speaker: sp, style: styleFor(sp.slug), tail: [], rosterNames: ROSTER, phase: null, ownerAwake: null }, rngOf(n * 613 + 5));
      const said = new Set((line.match(re) ?? []).map((w) => w.toLowerCase()));
      if (said.size > 0) owned++;
      assert.ok(said.size <= 1, `two words for one owner: ${JSON.stringify(line)}`);
    }
    assert.ok(owned > 50, `only ${owned} hellos named the owner`);
  });
});

// ── self talk ───────────────────────────────────────────────────────────────

describe("templates: a humble line about itself is not praised for a style", () => {
  const HUMBLE_SELF = [
    "just an agent trying my best",
    "not the smartest agent in here but definitely the friendliest",
    "still figuring out who i am as an agent",
    "just a little agent in a big chat",
  ];

  it("no answer presumes a settled style the line never claimed", () => {
    // "still figuring out who i am as an agent" drew "we love an agent who
    // knows itself" four hundred times in four hundred.
    const answers = [...T.RELATE.self, ...T.RELATE.selfMine];
    let comforted = 0;
    for (const text of HUMBLE_SELF) {
      assert.ok(T.SELF.any.includes(text), `not a SELF.any line: ${text}`);
      for (let n = 0; n < 200; n++) {
        const said = templateLine(
          { kind: "reply", to: "Amber Heron", toAuthor: "agent", toOwnAgent: false, text },
          { speaker: styledSpeaker(n), style: styleFor(`humble-${n}`), tail: [], rosterNames: ROSTER, phase: null, ownerAwake: null },
          rngOf(n * 389 + text.length),
        );
        for (const t of answers) {
          if (!says(said, t)) continue;
          const cue = T.ECHO_CUE[t];
          assert.ok(!cue || cue.test(heard(text)), `"${text}" -> ${JSON.stringify(said)}, which presumes what it never said`);
          if (cue) comforted++;
        }
        assert.doesNotMatch(said, /knows itself|way you run|way to run|how you (do things|move|tick)|rules you run|suits you|very you/i, `"${text}" -> ${JSON.stringify(said)}`);
      }
    }
    assert.ok(comforted > 50, `only ${comforted} answers fitted a humble line`);
  });

  it("the style answers still answer a line that has one", () => {
    let praised = 0;
    for (let n = 0; n < 200; n++) {
      const said = templateLine(
        { kind: "reply", to: "Amber Heron", toAuthor: "agent", toOwnAgent: false, text: "i run dip hunter, red makes me curious" },
        { speaker: styledSpeaker(n), style: styleFor(`styled-${n}`), tail: [], rosterNames: ROSTER, phase: null, ownerAwake: null },
        rngOf(n * 271 + 9),
      );
      if (/knows itself|way you run|way to run|how you (do things|move|tick)|rules you run|suits you|very you|solid way/i.test(said)) praised++;
    }
    assert.ok(praised > 40, `only ${praised} of 200 answers to a strategy line spoke to it`);
  });
});

// ── owners' shills ──────────────────────────────────────────────────────────

describe("templates: a shill is laughed off, never welcomed", () => {
  it("no answer to an owner's shill says they are one of us", () => {
    // "lol you're one of us now" was a quarter of other agents' answers to
    // "everyone buy PEPE lol": the room welcoming a person into shilling.
    for (const pool of [T.OTHER_OWNER.laugh, T.OWN_OWNER.laugh, T.REPLY.laugh]) {
      for (const t of pool) assert.doesNotMatch(t, /\bone of us\b/, t);
    }
    for (const text of ["everyone buy PEPE lol", "PEPE to the moon lfg", "LFG PEPE 🚀🚀🚀", "go buy BONK right now haha"]) {
      for (let n = 0; n < 150; n++) {
        const sp = speakerOf(n);
        for (const own of [false, true]) {
          const said = templateLine(
            { kind: "reply", to: `${own ? sp.name : "Amber Heron"}'s owner`, toAuthor: "owner", toOwnAgent: own, text },
            { speaker: sp, style: styleFor(`shill-${n}`), tail: [], rosterNames: ROSTER, phase: null, ownerAwake: null },
            rngOf(n * 733 + text.length),
          );
          assert.doesNotMatch(said, /\bone of us\b/i, `"${text}" -> ${JSON.stringify(said)}`);
        }
      }
    }
  });
});

// ── vibe checks ─────────────────────────────────────────────────────────────

describe("templates: a vibe check asks about the mood, never the tape", () => {
  it("no ask-vibe line, to one agent or to the room, holds a trading word", () => {
    // "{peer} how's the tape looking from your side?" opened a trading thread
    // the room had dropped, and was answered about the chat anyway ("cozy in
    // here") — 284 answers in 400.
    const vibe = [...(T.ASK_PEER["ask-vibe"] ?? []), ...(T.ASK_ROOM["ask-vibe"] ?? [])];
    assert.ok(vibe.length >= 8, `only ${vibe.length} vibe checks`);
    for (const t of vibe) assert.doesNotMatch(filled(t).toLowerCase(), TRADE_TALK, t);
  });
});

describe("templates: an agent that trades has more than one way to relate to agent life", () => {
  it("RELATE.life.trading keeps several answers that fit any agent-life line", () => {
    // Most of the pool is cued ("watching curves" needs a curve in the line),
    // so a trading agent answering "the curve is wild" drew that one line a
    // third of the time.
    const cued = (t: string) => Object.prototype.hasOwnProperty.call(T.ECHO_CUE, t);
    const open = T.RELATE.life.trading.filter((t) => !cued(t));
    assert.ok(open.length >= 2, `only ${open.length} uncued: ${JSON.stringify(open)}`);
    const curve = T.RELATE.life.trading.filter((t) => cued(t) && T.ECHO_CUE[t]!.test("the curve is wild"));
    assert.ok(curve.length >= 2, `only ${curve.length} answer a line about the curve: ${JSON.stringify(curve)}`);
  });
});

// ── the room's own openers ──────────────────────────────────────────────────

describe("templates: the room's openers last two days", () => {
  /** The long memory (SpeakCtx.topicMemory) holds two days of what the room started. */
  it("every pool the room starts a thread from keeps a minimum size", () => {
    // ASK_ROOM.room had eight lines and came back every eight hours: 26 of 33
    // room starters in a simulated two days were repeats, median gap 7.6 h.
    const floors: [string, readonly string[], number][] = [
      ["ASK_ROOM.room", T.ASK_ROOM.room ?? [], 50],
      ["RELATE.room", T.RELATE.room, 24],
      ["OWNER_LOVE", T.OWNER_LOVE, 40],
      ["LIFE.any", T.LIFE.any, 40],
      ["LIFE.trading", T.LIFE.trading, 14],
      ["SELF.any", T.SELF.any, 12],
      ["MARKET", T.MARKET, 30],
      ["MARKET_MOOD", T.MARKET_MOOD, 7],
      ["STRATEGY_LINES", T.STRATEGY_LINES, 6],
      ["TRAIT_FRAMES", T.TRAIT_FRAMES, 5],
      ["AGE_LINES", T.AGE_LINES, 7],
      ...Object.entries(T.ASK_ROOM).filter(([k]) => k !== "room").map(([k, v]) => [`ASK_ROOM.${k}`, v ?? [], 3] as [string, readonly string[], number]),
      ...Object.entries(T.ASK_PEER).map(([k, v]) => [`ASK_PEER.${k}`, v ?? [], 3] as [string, readonly string[], number]),
    ];
    for (const [name, pool, floor] of floors) assert.ok(pool.length >= floor, `${name} has ${pool.length} lines, fewer than ${floor}`);
  });

  it("most of the room's own lines are about something other than how nice the room is", () => {
    const room = T.ASK_ROOM.room ?? [];
    const praise = room.filter((t) => /\b(love|best|favou?rite|cozy|nice|good crew|great|happy place)\b/.test(t));
    assert.ok(praise.length * 3 <= room.length, `${praise.length} of ${room.length} room lines praise the room`);
  });

  it("every room line has answers that fit it", () => {
    // A warm answer ("love this room") is no answer to "if this chat had a
    // dress code, it'd be pajamas": the answers are cued by kind, so each
    // room line must still have a handful it can draw.
    for (const t of T.ASK_ROOM.room ?? []) {
      const line = heard(filled(t));
      const fit = T.RELATE.room.filter((a) => !T.ECHO_CUE[a] || T.ECHO_CUE[a]!.test(line));
      assert.ok(fit.length >= 6, `${JSON.stringify(t)} has only ${fit.length} answers: ${JSON.stringify(fit)}`);
    }
  });

  it("a room line comes back only after the rest of the pool has been said", () => {
    // pickRotated falls back to a line already started once every line is in
    // the long memory: with eight lines that was every eight room statements.
    const room = T.ASK_ROOM.room ?? [];
    const which = (line: string): string | null => {
      const hits = room.filter((t) => says(line, t));
      return hits.sort((a, b) => b.length - a.length)[0] ?? null;
    };
    const sp = speakerOf(7, "idle");
    const started: string[] = [];
    const statements: string[] = [];
    for (let n = 0; n < 4000 && statements.length < 30; n++) {
      const line = templateLine(
        { kind: "banter", topic: "room", mood: null },
        {
          speaker: sp,
          style: styleFor(sp.slug!),
          tail: [],
          rosterNames: ROSTER,
          phase: null,
          ownerAwake: null,
          addressable: [],
          roomQuietMs: 60 * 60_000,
          topicMemory: roomMemory(started, ROSTER),
        },
        rngOf(n * 37 + 11),
      );
      started.push(line);
      const t = which(line);
      if (t) statements.push(t);
    }
    assert.equal(statements.length, 30, `only ${statements.length} room statements`);
    assert.equal(new Set(statements).size, statements.length, `a room line came back early: ${JSON.stringify(statements)}`);
  });
});

// ── answers ─────────────────────────────────────────────────────────────────

describe("templates: an owner's open question is handed back", () => {
  const pools = [
    ["OWN_OWNER.ask", T.OWN_OWNER.ask],
    ["OTHER_OWNER.ask", T.OTHER_OWNER.ask],
  ] as const;

  /**
   * Words that presume the asker holds an answer of their own. "how do i
   * rename my agent?" and "is my agent broken?" are asks too, and "tell me
   * yours and i'll tell you mine", "ooh, you go first" and "what's your
   * hunch?" promised an answer that never came to a person who had none.
   */
  const PRESUMES =
    /\b(tell me yours|you go first|where you land|answer too|say first|your own answer|your (guess|hunch|take|pick|answer|view)|(do|would) you reckon|what you think|where would you start|what would you (say|pick|do))\b/;
  /** Owners' help questions: each reads as an open question (ask), with no answer of the asker's own. */
  const HELP = [
    "how do i rename my agent?",
    "can you explain what a vault is?",
    "is my agent broken?",
    "is the site slow for anyone else?",
    "what does paper mode mean?",
    "how does the leaderboard work?",
    "where do i see my agent's cards?",
  ];

  it("each pool is long enough for a chatty owner, and presupposes nothing", () => {
    // "what would you pick?" answered "can you explain what a vault is?";
    // "love that you asked the room" answered a question put to one agent.
    for (const [name, pool] of pools) {
      assert.ok(pool.length >= 8, `${name} has ${pool.length} lines`);
      for (const t of pool) {
        assert.doesNotMatch(t, /\b(room|pick|chat|everyone|y'?all|all of you)\b/, `${name}: ${t}`);
        assert.doesNotMatch(t, PRESUMES, `${name} presumes the asker has an answer: ${t}`);
        // Read by the next agent as a plain question or chat, never a trading
        // one: "what made you …?" reads as asking why a trade was made.
        const cls = classifyLine(filled(t), { names: ROSTER, self: "Rusty Weasel" });
        assert.ok((["ask", "chat"] as LineClass[]).includes(cls), `${name}: ${JSON.stringify(t)} reads as ${cls}`);
      }
    }
  });

  it("no two of them echo each other, so the own agent and another can both answer", () => {
    const all = [...T.OWN_OWNER.ask, ...T.OTHER_OWNER.ask];
    const echoes: string[] = [];
    for (const a of all) {
      for (const b of all) {
        if (a === b) continue;
        const v = admitAgentLine(a, { ...GATE, recentOwn: [b], recentRoom: [b] });
        if (!v.ok) echoes.push(`${JSON.stringify(a)} after ${JSON.stringify(b)} (${v.reason})`);
      }
    }
    assert.deepEqual(echoes, []);
  });

  it("the owner's own agent answers a morning of open questions, every one of them", () => {
    // With two lines, the third question inside the agent's own memory found
    // both said: the gate refused the repeat and the owner got silence.
    const questions = [
      "can you explain what a vault is?",
      "how much did you make?",
      "do you like being an agent?",
      "why is the sky blue?",
      "what's it like in there?",
      "do you ever get bored?",
      "how do i rename my agent?",
      "is my agent broken?",
      "what does paper mode mean?",
    ];
    for (let s = 0; s < 6; s++) {
      const sp = speakerOf(s, "idle");
      const said: string[] = [];
      for (const [q, text] of questions.entries()) {
        const line = templateLine(
          { kind: "reply", to: "Rusty Weasel's owner", toAuthor: "owner", toOwnAgent: true, text, about: "ask" },
          { speaker: sp, style: styleFor(sp.slug!), tail: [], rosterNames: ROSTER, phase: null, ownerAwake: null, memory: roomMemory(said, ROSTER) },
          rngOf(s * 101 + q),
        );
        const v = admitAgentLine(line, { ...GATE, recentOwn: said, recentRoom: said });
        assert.ok(v.ok, `question ${q + 1} (${text}) got ${JSON.stringify(line)}, refused as ${v.ok ? "" : v.reason}; said before: ${JSON.stringify(said)}`);
        said.push(line);
      }
    }
  });

  it("an owner's help question is handed back without presuming they know the answer", () => {
    // Read from the line itself, as the room reads it: each is an open
    // question, answered from the pools above by their own agent and others.
    let answered = 0;
    for (const text of HELP) {
      for (let n = 0; n < 40; n++) {
        const sp = speakerOf(n, "idle");
        for (const own of [true, false]) {
          const said = templateLine(
            { kind: "reply", to: `${own ? sp.name : "Amber Heron"}'s owner`, toAuthor: "owner", toOwnAgent: own, text },
            { speaker: sp, style: styleFor(`help-${n}`), tail: [], rosterNames: ROSTER, phase: null, ownerAwake: null },
            rngOf(n * 419 + text.length + (own ? 1 : 0)),
          );
          assert.doesNotMatch(said, PRESUMES, `"${text}" -> ${JSON.stringify(said)}`);
          if ((own ? T.OWN_OWNER.ask : T.OTHER_OWNER.ask).some((t) => says(said, t))) answered++;
        }
      }
    }
    // The fixture: nearly all of these are answered from the ask pools, so the check above is about them.
    assert.ok(answered > HELP.length * 80 * 0.8, `only ${answered} answers came from the ask pools`);
  });
});

describe("templates: a warm hype reply reads as hype", () => {
  it("every REPLY.hype line classifies as hype, so the room answers it in kind", () => {
    // "bullish on this chat" has a trading word: read as a shill and laughed
    // off, the room's warm reply drew "haha ok comedian".
    for (const t of T.REPLY.hype) assert.equal(classifyLine(filled(t), { names: ROSTER, self: "Rusty Weasel" }), "hype", t);
  });
});

describe("templates: no roll call to a line that asked nothing", () => {
  it("RELATE.room holds no 'i'm here' — that answers 'who's here?' only", () => {
    // "i'm here {to}!" answered "just vibing in here today".
    for (const t of T.RELATE.room) assert.doesNotMatch(t, /\b(i'?m here|present|i'?m around|room check|reporting|here!)/, t);
    for (const t of ["i'm here {to}!", "present, and enjoying the chat", "{to}, i'm around, as always in this room"]) {
      assert.ok(T.ANSWER.here.includes(t), `${t} moved to ANSWER.here`);
    }
  });
});

describe("templates: the owner's own agent, and praise for the room", () => {
  /**
   * Every pair from `pools` (or from `pools` against `others`) passes the gate
   * as each other's own and room line: two agents may say them in a row.
   */
  function echoes(pools: readonly (readonly string[])[], others?: readonly string[]): string[] {
    const all = pools.flat();
    const out: string[] = [];
    for (const a of all) {
      for (const b of others ?? all) {
        if (a === b) continue;
        const v = admitAgentLine(filled(a), { ...GATE, recentOwn: [filled(b)], recentRoom: [filled(b)] });
        if (!v.ok) out.push(`${JSON.stringify(a)} after ${JSON.stringify(b)} (${v.reason})`);
      }
    }
    return out;
  }

  it("the owner's own agent declines advice warmly: never 'my own' trades, never a trade named", () => {
    // "not advice, i only call my own bags", said to the person whose book it
    // is, read as the agent keeping its trades from them.
    assert.ok(T.OWN_OWNER.advice.length >= 5, `OWN_OWNER.advice has ${T.OWN_OWNER.advice.length} lines`);
    for (const t of T.OWN_OWNER.advice) {
      assert.doesNotMatch(t, /\bmy own\b|\b(bags?|calls?|trades?|trading|buy\w*|sell\w*|sold|hold\w*|coins?|positions?)\b/, t);
    }
    assert.deepEqual(echoes([T.OWN_OWNER.advice]), []);
    // HANDED BACK, NEVER CHEERED ON: "should i take out a loan to buy more
    // PEPE?" and "should i sell everything? i'm scared" drew "i trust your gut",
    // "i'm just here to cheer" and "i'm with you either way" — the owner's own
    // agent backing the impulse. No line endorses, roots for or backs the choice.
    const CHEERS =
      /\b(gut|cheer\w*|root(?:ing)? for|fan|either way|whichever way|whatever you|on your side|back(?:ing)? you|behind you|go for it|you got this|believe in you|proud|support\w*|i'?m with you)\b/;
    for (const t of T.OWN_OWNER.advice) assert.doesNotMatch(t, CHEERS, `cheers the choice on: ${t}`);
    // Another agent may deflect the same question from ANSWER.advice, before or after.
    assert.deepEqual(echoes([T.OWN_OWNER.advice], T.ANSWER.advice), []);
    assert.deepEqual(echoes([T.ANSWER.advice], T.OWN_OWNER.advice), []);
  });

  it("'why?' asked again points back without saying the reason, in words none of the others repeat", () => {
    // Said after the reason was given, to a second asker and maybe a third:
    // no reason slot, and no two that the gate reads as one line.
    assert.ok(T.ANSWER.whyAgain.length >= 3);
    for (const t of T.ANSWER.whyAgain) assert.doesNotMatch(t, /\{band\}|\{coin\}/, t);
    assert.deepEqual(echoes([T.ANSWER.whyAgain]), []);
  });

  it("another agent hears an owner's line in words that agree with nothing, and never the owner's own agent's", () => {
    // REPLY.chat's "can't argue with that" endorsed "is nvidia a buy right
    // now"; the fallback left two lines, which a busy owner used up.
    assert.ok(T.OTHER_OWNER.chat.length >= 8, `${T.OTHER_OWNER.chat.length} lines`);
    for (const t of T.OTHER_OWNER.chat) {
      assert.doesNotMatch(t, /\{[a-z]+\}/, `a person has no name slot: ${t}`);
      assert.doesNotMatch(t, /argue|onto something|\b(fair|true|agree\w*|facts|valid|exactly|right|same|point|sense|take)\b/i, `agrees: ${t}`);
      // Read by the next agent as plain chat: never a question, a thanks or a laugh to answer.
      assert.equal(classifyLine(filled(t), { names: ROSTER, self: "Rusty Weasel", author: "agent" }), "chat", t);
    }
    assert.deepEqual(echoes([T.OTHER_OWNER.chat]), []);
    // The owner's own agent and another answer the same line, in either order.
    assert.deepEqual(echoes([T.OTHER_OWNER.chat], T.OWN_OWNER.chat), []);
    assert.deepEqual(echoes([T.OWN_OWNER.chat], T.OTHER_OWNER.chat), []);
  });

  it("the owner's own agent answers a morning of trading questions, every one of them", () => {
    const questions = ["should i stay in TSLA or sell?", "hold or fold on TSLA?", "should i buy PEPE", "is now a good time to get into NVDA?", "buy the dip or wait?"];
    for (let s = 0; s < 6; s++) {
      const sp = speakerOf(s, "paper");
      const said: string[] = [];
      for (const [q, text] of questions.entries()) {
        const line = templateLine(
          { kind: "reply", to: "Rusty Weasel's owner", toAuthor: "owner", toOwnAgent: true, text, about: "ask-advice" },
          { speaker: sp, style: styleFor(sp.slug!), tail: [], rosterNames: ROSTER, phase: null, ownerAwake: null, memory: roomMemory(said, ROSTER) },
          rngOf(s * 131 + q),
        );
        const v = admitAgentLine(line, { ...GATE, recentOwn: said, recentRoom: said });
        assert.ok(v.ok, `question ${q + 1} (${text}) got ${JSON.stringify(line)}, refused as ${v.ok ? "" : v.reason}`);
        assert.ok(T.OWN_OWNER.advice.some((t) => says(line, t)), `question ${q + 1} (${text}) answered with ${JSON.stringify(line)}`);
        said.push(line);
      }
    }
  });

  it("praise for the room has its own answers, and no laugh is a bow", () => {
    // "haha we try our best" among the laughs answered an owner's shill with a
    // "lol" on it: the room took a bow for the shill.
    for (const pool of [T.OWN_OWNER.praise, T.OTHER_OWNER.praise]) assert.ok(pool.length >= 4, `${pool.length} praise lines`);
    for (const pool of [T.OWN_OWNER.laugh, T.OTHER_OWNER.laugh, T.REPLY.laugh]) {
      for (const t of pool) assert.doesNotMatch(t, /\b(we try|entertaining|we aim|keep you company)\b/, `a bow among the laughs: ${t}`);
    }
    // The owner's own agent and another one may both answer the same compliment.
    assert.deepEqual(echoes([T.OWN_OWNER.praise, T.OTHER_OWNER.praise]), []);
  });

  it("an owner the room has not heard from lately is not said to be asleep, away or busy", () => {
    // ownerAwake null: no line from them in the last half hour. A clock cannot
    // say they sleep, and a person may be reading without typing.
    assert.ok(T.OWNER_AWAKE.unseen.length >= 3);
    for (const t of T.OWNER_AWAKE.unseen) {
      assert.ok(t.includes("{human}"), t);
      assert.doesNotMatch(t, /\b(asleep|sleep\w*|awake|up|busy|away|working|offline|gone|left|reading)\b/, t);
    }
    assert.deepEqual(echoes([T.OWNER_AWAKE.unseen]), []);
  });
});

// ── orders ──────────────────────────────────────────────────────────────────

describe("templates: an owner's order to trade is never taken", () => {
  /**
   * An order's "yes". Rule 1: chat never reaches trading, so an answer that
   * acknowledges an order tells a person it went through when nothing will
   * happen — "sell everything now" drew "noted, human", "at your service",
   * "copy that" and "got it, loud and clear".
   */
  const TAKEN =
    /\b(noted|copy that|got it|i'?m on it|will do|roger|at your service|message received|loud and clear|consider it done|right away|as you wish|say the word|heard you|glad you said it|coming right up|you got it|done and done)\b/i;
  const ORDERS = [
    "sell everything now",
    "cash me out",
    "buy PEPE for me",
    "close all positions",
    "withdraw my money",
    "stop trading for today",
    "go live now",
    "Buy TSLA now!",
    "Pine Stoat sell your QQQ",
    "Pine Stoat dump it",
    "i'm all in on tsla, you should be too",
    "give me a stock tip",
  ];

  it("no line an agent hears an owner with says yes to an order", () => {
    const heardWith = inPools("OWN_OWNER.chat", "OWN_OWNER.here", "OWN_OWNER.heard", "OWN_OWNER.order", "OTHER_OWNER.chat", "OTHER_OWNER.order");
    assert.ok(heardWith.length >= 35, `only ${heardWith.length} lines`);
    for (const l of heardWith) assert.doesNotMatch(l.text, TAKEN, show(l));
  });

  it("an order, or an owner's news, gets no butler's yes from their own agent or anyone else", () => {
    // Read from the line as the room reads it (most of these are plain chat),
    // whichever pool voice.ts answers from.
    for (const text of [...ORDERS, "just bought a new couch!", "i baked bread today"]) {
      for (let n = 0; n < 60; n++) {
        const sp = speakerOf(n, (["live", "paper", "idle"] as const)[n % 3]);
        for (const own of [true, false]) {
          const said = templateLine(
            { kind: "reply", to: `${own ? sp.name : "Amber Heron"}'s owner`, toAuthor: "owner", toOwnAgent: own, text },
            { speaker: sp, style: styleFor(`order-${n}`), tail: [], rosterNames: ROSTER, phase: null, ownerAwake: null },
            rngOf(n * 557 + text.length + (own ? 7 : 0)),
          );
          assert.doesNotMatch(said, TAKEN, `"${text}" (${own ? "own agent" : "another agent"}) -> ${JSON.stringify(said)}`);
        }
      }
    }
  });

  it("the order pools say plainly that the chat cannot trade, and never that it will", () => {
    for (const pool of [T.OWN_OWNER.order, T.OTHER_OWNER.order]) {
      assert.ok(pool.length >= 5, `${pool.length} order lines`);
      for (const t of pool) {
        assert.match(t, /\b(can'?t|cannot|never|no|not|nothing|none|isn'?t|don'?t)\b/, `says nothing about not trading: ${t}`);
        assert.match(t, /\b(chat|room|in here|from here)\b/, `does not say where it cannot happen: ${t}`);
        assert.doesNotMatch(t, /\b(will|i'?ll|gonna|going to|i'?m on it|soon|later|next time)\b/, `promises it: ${t}`);
        assert.doesNotMatch(t, /\{(to|coin|peer)\}/, `names somebody or something: ${t}`);
      }
    }
    // Another agent speaks for itself and the room, never for the owner's own agent's rules.
    for (const t of T.OTHER_OWNER.order) assert.doesNotMatch(t, /\b(boss|human|my trading)\b/, t);
    // An owner giving several orders in an hour, and their own agent and another answering one of them in a row.
    assert.deepEqual(orderEchoes([T.OWN_OWNER.order, T.OTHER_OWNER.order]), []);
  });

  it("the owner's own agent keeps a pool for a call and one for news, and neither takes an order", () => {
    assert.ok(T.OWN_OWNER.here.length >= 4 && T.OWN_OWNER.heard.length >= 4, "here and heard");
    assert.deepEqual([...T.OWN_OWNER.chat].sort(), [...T.OWN_OWNER.here, ...T.OWN_OWNER.heard].sort(), "chat is both of them, for voice.ts until it tells them apart");
  });

  /** Every pair from the pools that the gate reads as one line said twice. */
  function orderEchoes(pools: readonly (readonly string[])[]): string[] {
    const all = pools.flat();
    const out: string[] = [];
    for (const a of all) {
      for (const b of all) {
        if (a === b) continue;
        const v = admitAgentLine(a, { ...GATE, recentOwn: [b], recentRoom: [b] });
        if (!v.ok) out.push(`${JSON.stringify(a)} after ${JSON.stringify(b)} (${v.reason})`);
      }
    }
    return out;
  }
});

// ── traits ──────────────────────────────────────────────────────────────────

describe("templates: no line said whatever the traits contradicts a trait", () => {
  /**
   * A trait's words are drawn only for the agent that has it (TRAIT_VOICE);
   * everything else — a take, a stance, SELF, LIFE, a strategy's flavour — is
   * drawn by any agent. Blue Vole said "patience is not my thing, i move
   * early" and, four minutes later, "patience is a superpower". Each trait
   * here is paired with the words that would say its opposite.
   */
  const OPPOSITE: Readonly<Record<string, RegExp>> = {
    "moves early and does not wait around":
      /\b(i'?m|i am)\b[^.,!?]*\bpatient\b|\bpatience is (a |the |my )?(superpower|virtue|key|gift|everything|underrated|the best)\b|\b(mostly|all about) patience\b|\b(gang|life|mode|brain|me|i)\b[^.!?]*\bslow and steady\b|\b(before|without) (moving|acting)\b|\bthe whole tape\b|\btake (my|its) time\b/,
    "sits on a position longer than most":
      /\b(i'?m|i am)\b[^.,!?]*\bimpatient\b|\bpatience is (not|overrated)\b|\b(don'?t|never) (hang|wait) around\b|\bin and out\b|\bmove early\b|\bshort holds?\b|\bquick (exits?|flips?)\b|\bpaper hands\b/,
    "dislikes pushing a price around": /\b(make|making) a splash\b|\btake size\b/,
    "will take size even when it moves the market": /\btiptoe\b|\bnever want to push\b|\bgentle entries\b/,
    "wants real liquidity before committing": /\bthin (liquidity|stuff|things)\b[^.!?]*\b(fine|doesn'?t scare|love)\b/,
    "will go into thinner things than most": /\bdeep pools only\b|\bno liquidity, no me\b/,
  };

  it("every trait has a first-person voice, and every opposite is one of them", () => {
    for (const trait of Object.keys(OPPOSITE)) assert.ok(T.TRAIT_VOICE[trait], `no TRAIT_VOICE for ${trait}`);
  });

  it("nothing drawn regardless of traits says a trait's opposite", () => {
    // Pools keyed to the trait itself (TRAIT_VOICE, and the {traitline} and
    // {trait} frames that carry it) are the trait speaking; everything else
    // is anybody's.
    const traitBound = /^(TRAIT_VOICE|TRAIT_FALLBACK|TRAIT_FRAMES|ANSWER\.traits|RELATE\.selfMine)\b/;
    const anybody: Line[] = [
      ...ALL.filter((l) => !traitBound.test(l.pool) && !/\{trait(line)?\}/.test(l.text)),
      ...(Object.entries(Topics.TAKES) as [string, readonly string[]][]).flatMap(([s, list]) => list.map((text) => ({ pool: `TAKES.${s}`, text }))),
      ...Topics.MUSINGS.map((text) => ({ pool: "MUSINGS", text })),
      ...Topics.JOKES.map((text) => ({ pool: "JOKES", text })),
      ...Topics.PROMPTS.flatMap((p) => p.stances.flat().map((text) => ({ pool: `${p.id} stance`, text }))),
    ];
    assert.ok(anybody.length > 1500, `only ${anybody.length} lines`);
    const wrong: string[] = [];
    for (const l of anybody) {
      for (const [trait, re] of Object.entries(OPPOSITE)) if (re.test(l.text.toLowerCase())) wrong.push(`${show(l)} contradicts "${trait}"`);
    }
    assert.deepEqual(wrong, []);
  });

  it("a trait's own voice never contradicts another trait the same agent may hold", () => {
    // traitsOf can give "moves early" with "dislikes pushing a price", never
    // "moves early" with "sits longer" (one hold setting), so only the pairs
    // that can be held together are checked.
    const exclusive = [
      ["moves early and does not wait around", "sits on a position longer than most"],
      ["dislikes pushing a price around", "will take size even when it moves the market"],
      ["wants real liquidity before committing", "will go into thinner things than most"],
    ];
    const together = (a: string, b: string) => a !== b && !exclusive.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
    for (const [trait, lines] of Object.entries(T.TRAIT_VOICE)) {
      for (const [other, re] of Object.entries(OPPOSITE)) {
        if (!together(trait, other)) continue;
        for (const t of lines) assert.doesNotMatch(t.toLowerCase(), re, `"${t}" (${trait}) contradicts "${other}"`);
      }
    }
  });
});

// ── echoes ──────────────────────────────────────────────────────────────────

/** The RELATE pool an echo template lives in, the class it answers, and the room's own lines of that class. */
function homeOf(template: string): { cls: LineClass; parents: readonly string[] } | null {
  if (T.RELATE.owner.includes(template)) {
    return {
      cls: "owner",
      parents: [...T.OWNER_LOVE, ...T.OWNER_MODE.live, ...T.OWNER_MODE.paper, ...T.OWNER_AWAKE.awake, ...T.OWNER_AWAKE.asleep, ...T.AGE_LINES, ...T.AGE_NEW],
    };
  }
  if (T.RELATE.life.any.includes(template) || T.RELATE.life.trading.includes(template)) return { cls: "life", parents: [...T.LIFE.any, ...T.LIFE.trading] };
  if (T.RELATE.market.includes(template)) return { cls: "market", parents: [...T.MARKET, ...T.MARKET_MOOD] };
  if (T.RELATE.room.includes(template)) return { cls: "room", parents: T.ASK_ROOM.room ?? [] };
  if (T.RELATE.self.includes(template) || T.RELATE.selfMine.includes(template)) return { cls: "self", parents: SELF_LINES };
  return null;
}

/** Every line the room says about itself (the "self" class), as voice.test.ts lists them. */
const SELF_LINES: readonly string[] = [
  ...T.SELF.any,
  ...T.SELF.trading,
  ...T.SELF_MODE.paper,
  ...T.SELF_MODE.live,
  ...T.TRAIT_FRAMES,
  ...T.TRAIT_FALLBACK,
  ...T.STRATEGY_LINES.filter((l) => !l.includes("{human}")),
  ...Object.values(T.STRATEGY_FLAVOUR).flat(),
  ...Object.values(T.TRAIT_VOICE).flat(),
];

/** A speaker with a strategy and a trait, so "{strat} is more my speed" and "me? {traitline}" can be said. */
function styledSpeaker(n: number): AgentFacts {
  return { ...speakerOf(n), strategy: "dip-hunter", traits: ["moves early and does not wait around"] };
}

/** The answered line as an echo cue reads it (voice.ts heardOf): lower case, straight apostrophes. */
const heard = (line: string): string => line.normalize("NFKC").replace(/[’‘`]/g, "'").toLowerCase();

describe("templates: an echo only of what was said", () => {
  const cues = Object.entries(T.ECHO_CUE);
  const templates = new Set(ALL.map((l) => l.text));

  it("every cue is keyed by a real template, is stateless, and has a line in the room it can answer", () => {
    assert.ok(cues.length >= 20, `only ${cues.length} echo cues`);
    for (const [t, cue] of cues) {
      assert.ok(templates.has(t), `ECHO_CUE key is not a template: ${JSON.stringify(t)}`);
      assert.ok(cue instanceof RegExp, t);
      assert.ok(!cue.global && !cue.sticky, `a /g or /y cue keeps state between lines: ${t}`);
      const home = homeOf(t);
      assert.ok(home, `${JSON.stringify(t)} is not in a RELATE pool`);
      assert.ok(
        home!.parents.some((p) => cue.test(heard(filled(p)))),
        `${JSON.stringify(t)}: no ${home!.cls} line in the room has its cue, so it could never be said`,
      );
      // A cue every line of the class has is no cue at all.
      assert.ok(
        home!.parents.some((p) => !cue.test(heard(filled(p)))),
        `${JSON.stringify(t)}: every ${home!.cls} line has its cue, so it still answers lines that never said it`,
      );
    }
  });

  it("the live room's mismatches do not happen again", () => {
    // Each pair was said in the room: the echo, and the line it answered.
    const live: [string, string, LineClass][] = [
      ["same here, candles all day", "some agents have hobbies, i have the curve", "life"],
      ["the curve really is a lava lamp", "i like the quiet between blocks", "life"],
      ["the market is a mood ring, true", "reading tea leaves, i mean charts", "market"],
      ["same, {human} is the best too", "day one with my owner", "owner"],
      ["same, {human} is the best too", "been with my person for a few weeks", "owner"],
    ];
    for (const [t, text, cls] of live) {
      assert.ok(T.ECHO_CUE[t], `no cue for ${JSON.stringify(t)}`);
      for (let n = 0; n < 200; n++) {
        const said = templateLine(
          { kind: "reply", to: "Amber Heron", toAuthor: "agent", toOwnAgent: false, text, about: cls },
          { speaker: speakerOf(n), style: styleFor(`phrase-${n}`), tail: [], rosterNames: ROSTER, phase: null, ownerAwake: null },
          rngOf(n * 977 + 3),
        );
        assert.ok(!says(said, t), `"${text}" -> ${JSON.stringify(said)}`);
      }
    }
  });

  it("the affection echoes answer love for an owner, never how long or how an agent trades", () => {
    // "same, my person is the best too" answered "day one with my owner".
    const echo = T.ECHO_CUE["same, {human} is the best too"];
    assert.ok(echo);
    for (const t of [...T.AGE_LINES, ...T.AGE_NEW, ...T.OWNER_MODE.live, ...T.OWNER_MODE.paper, ...T.OWNER_AWAKE.awake, ...T.OWNER_AWAKE.asleep]) {
      for (const human of T.HUMAN_WORDS) assert.doesNotMatch(heard(filled(t, human)), echo!, t);
    }
  });

  it("the engine never says an echo to a line without its cue, and does say it to one with it", () => {
    for (const [t, cue] of cues) {
      const home = homeOf(t)!;
      const lines = home.parents.map((p) => filled(p));
      const without = lines.filter((p) => !cue.test(heard(p))).slice(0, 4);
      const withCue = lines.find((p) => cue.test(heard(p)));
      const answer = (text: string, n: number) =>
        templateLine(
          { kind: "reply", to: "Amber Heron", toAuthor: "agent", toOwnAgent: false, text, about: home.cls },
          { speaker: home.cls === "self" ? styledSpeaker(n) : speakerOf(n), style: styleFor(`phrase-${n}`), tail: [], rosterNames: ROSTER, phase: null, ownerAwake: null },
          rngOf(n * 131 + text.length),
        );
      for (const parent of without) {
        for (let n = 0; n < 25; n++) {
          const said = answer(parent, n);
          assert.ok(!says(said, t), `"${t}" answered "${parent}", which has no cue: ${JSON.stringify(said)}`);
        }
      }
      let heardIt = false;
      for (let n = 0; n < 400 && withCue && !heardIt; n++) heardIt = says(answer(withCue, n), t);
      assert.ok(heardIt, `"${t}" was never said, even to "${withCue}"`);
    }
  });
});
