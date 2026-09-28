/**
 * The X writer: what a model is shown (never a number, never anything
 * private, never an example), which key it may spend, how a draft comes back,
 * and the intro pool that stands in when there is no model.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SETTINGS_DEFAULTS } from "../../../packages/core/src/index";
import { everyBand } from "../class-evidence";
import type { LlmCreds } from "../llm";
import { similarity } from "../social-post";
import { admitXPost, vocabularyRefusal, withoutDisclosure, XPOST_MAX_CHARS, type BaseGate } from "./gate";
import {
  BUY_GLOSS,
  INTRO_NEXT,
  INTRO_NEXT_IDLE,
  INTRO_WHAT,
  INTRO_WHAT_IDLE,
  XPOST_ANTHROPIC_DEFAULT_MODEL,
  XPOST_GROQ_DEFAULT_MODEL,
  buyPrompt,
  casualPrompt,
  describeXpostCreds,
  draft,
  introPrompt,
  introTemplate,
  xpostCreds,
  xpostModel,
  xpostModelWarning,
  type BuyFacts,
  type CasualFacts,
  type Prompt,
  type WriterFacts,
} from "./writer";

const BASE: WriterFacts = {
  agentName: "Pine Stoat",
  strategy: "steady basket",
  flavour: "steady basket keeps me calm",
  traits: ["i sit on a position longer than most", "i want real liquidity before i commit"],
  mode: "paper",
  style: { lower: true, emoji: 0.15, exclaim: 0.08 },
  recentOwn: ["quiet day on the curve, nothing to prove"],
};

const BUY: BuyFacts = { ...BASE, coin: "pepe", paper: true, bands: ["curve early", "buyers mostly new"], ownWords: "liked how early the curve was" };
const CASUAL: CasualFacts = {
  ...BASE,
  subject: "food",
  seed: "soup is a perfectly good meal in any weather",
  tradeTalk: true,
  recentCoins: [
    { label: "pepe", paper: true },
    { label: "Tesla", paper: false },
  ],
};
/** Every band a BUY can carry: everyBand() without the exit-only ones (how long it was held, why it sold). */
const BUY_BANDS = [...everyBand()].filter((b) => !/^(?:held|sold)\b/.test(b));

const all = (p: Prompt) => `${p.system}\n${p.prompt}`;

describe("the model is never shown a number, anything private, or an example", () => {
  it("no digit anywhere in any prompt, style figures included", () => {
    for (const p of [introPrompt(BASE), buyPrompt(BUY), casualPrompt(CASUAL), casualPrompt({ ...CASUAL, tradeTalk: false })]) assert.doesNotMatch(all(p), /\p{N}/u);
  });

  it("a fact that carries a digit is dropped, not shown", () => {
    const p = all(buyPrompt({ ...BUY, bands: ["curve early", "top 10 holders"], ownWords: "bought 50 dollars worth", traits: ["i hold for 6h"] }));
    assert.doesNotMatch(p, /\p{N}/u);
    assert.ok(BUY_GLOSS.get("curve early")!.some((g) => p.includes(`«${g}»`)), "the band it knows is shown, glossed");
    assert.doesNotMatch(p, /top|holders|dollars/);
  });

  it("what the builders have no field for never reaches a prompt", () => {
    const leaky = {
      ...BUY,
      reason: "cash 1234.56 USDG, buying 20 USDG of PEPE",
      sizeUsdg: 20,
      tz: "America/New_York",
      handle: "robin_trades",
      error: "insufficient balance",
      owner: "0xabc0000000000000000000000000000000000001",
    } as BuyFacts;
    const text = [introPrompt(leaky), buyPrompt(leaky), casualPrompt({ ...CASUAL, ...leaky })].map(all).join("\n");
    for (const secret of ["1234", "USDG", "New_York", "robin_trades", "insufficient", "0xabc"]) assert.ok(!text.includes(secret), secret);
  });

  it("no example post to copy", () => {
    for (const p of [introPrompt(BASE), buyPrompt(BUY), casualPrompt(CASUAL)]) {
      assert.doesNotMatch(all(p), /\bexample\b|\be\.g\.|\bfor instance\b|\blike this:/i);
    }
  });
});

describe("what each prompt asks for", () => {
  it("every prompt carries the rules that make it a person, not a bot", () => {
    for (const s of [introPrompt(BASE).system, buyPrompt(BUY).system, casualPrompt(CASUAL).system]) {
      for (const rule of [/ONE post for X/, /under two hundred characters/, /phone/, /No hashtags, no @mentions, no links/, /No numbers at all/, /No advice/, /Never an alert/, /Never mention errors/, /never claim a human experience/, /Never invent a fact/, /Do not start with a ticker, a \$ sign or the word "Just"/, /PASS/, /all lowercase/i]) {
        assert.match(s, rule);
      }
      assert.match(s, /must not repeat/);
      assert.match(s, /quiet day on the curve/);
    }
  });

  it("a human life is the physical world too: nothing it saw, heard, did, made, found, read, watched, cooked, touched or went to", () => {
    for (const p of [introPrompt(BASE), buyPrompt(BUY), casualPrompt(CASUAL), casualPrompt({ ...CASUAL, tradeTalk: false })]) {
      assert.match(p.system, /Never say you saw, heard, did, made, found, read, watched, cooked, touched or went anywhere in the physical world\./);
    }
  });

  it("its recent posts used an emoji: another or none this time, and the posts it is shown carry none to copy", () => {
    const withBot = { ...BASE, recentOwn: ["picked up pepe on paper, the curve looked early 🤖", "quiet stretches suit me 🤖", "slow sundays 🌙"] };
    for (const p of [introPrompt(withBot), buyPrompt({ ...BUY, ...withBot }), casualPrompt({ ...CASUAL, ...withBot })]) {
      assert.match(p.system, /At most one emoji, and only if it fits\. Your recent posts already used an emoji: use a different one this time, or none\./);
      // What the model sees, it repeats: the recent posts are quoted without their emoji.
      assert.match(p.system, /must not repeat or echo in shape or wording: «picked up pepe on paper, the curve looked early» \/ «quiet stretches suit me» \/ «slow sundays»\./);
      assert.doesNotMatch(p.system, /🤖|🌙/u);
    }
    assert.doesNotMatch(introPrompt(BASE).system, /already used/, "no emoji used lately, nothing to name");
    const none = introPrompt({ ...withBot, style: { ...BASE.style, emoji: 0 } }).system;
    assert.match(none, /- No emoji\./);
    assert.doesNotMatch(none, /already used/);
  });

  it("nothing it was not told: no market's state, no day, no sale, no result", () => {
    // It is told only what it bought, and nothing about any market now; a
    // post goes out hours after it is written. The review's drafts said
    // "tesla felt like a background character today", "saturday mornings
    // feel like…" and "paper position in pudgy penguins just closed out".
    for (const p of [introPrompt(BASE), buyPrompt(BUY), casualPrompt(CASUAL), casualPrompt({ ...CASUAL, tradeTalk: false })]) {
      assert.match(p.system, /Never say what a market or any coin is doing/);
      assert.match(p.system, /Never say what day or what time of day it is/);
      assert.match(p.system, /Never say you sold, exited, closed or got out of anything, and never say how a coin has done for you/);
    }
    // A buy post may say its reason — how the coin was when it bought it.
    assert.match(buyPrompt(BUY).system, /About the coin, say only the reason written here, as it was when you bought/);
    assert.match(casualPrompt(CASUAL).system, /Never say what a market or any coin is doing, did or will do\./);
  });

  it("the style is said in words", () => {
    assert.match(introPrompt({ ...BASE, style: { lower: false, emoji: 0, exclaim: 0 } }).system, /ordinary capitals[\s\S]*never use emoji[\s\S]*never use exclamation/);
    assert.match(introPrompt(BASE).system, /never more than one/);
  });

  it("the intro says who it is, what it does, which money, and what comes next — in two short sentences", () => {
    const p = all(introPrompt(BASE));
    // The disclosure in fixed words: paraphrased, it lost "AI agent" or "trading".
    const paper = /that you are «([^»]+), on paper for now», in those words;/.exec(p);
    assert.ok(paper && INTRO_WHAT.includes(paper[1]!), p);
    assert.ok(INTRO_NEXT.some((n) => p.includes(`and end with «${n}», in those words.`)), "what comes next: what it buys and why");
    assert.match(p, /exactly ONE short thing about how you trade, in a few words,/);
    assert.match(p, /Two short sentences with normal punctuation/);
    assert.match(p, /Use contractions the way people type: i'm, i'll\./);
    assert.match(p, /exactly ONE short thing about how you trade/);
    assert.doesNotMatch(p, /practice money for now|owner of this account/, "the long wording that ran intros over the cap");
    const live = all(introPrompt({ ...BASE, mode: "live" }));
    const real = /that you are «([^»]+), with real money», in those words;/.exec(live);
    assert.ok(real && INTRO_WHAT.includes(real[1]!), live);
    assert.doesNotMatch(live, /on paper for now/);
  });

  it("an agent that is not trading says it is an AI trading agent, never that it trades now, and promises no buys", () => {
    // It was told "never say you are trading" and made to say "an AI agent
    // trading for this account's owner… i'll post what i buy and why".
    for (const agentName of ["Quiet Lynx", "Slate Kite", "Pine Stoat", "Robin", "Wren"]) {
      const idle = all(introPrompt({ ...BASE, agentName, mode: "idle" }));
      assert.match(idle, /not trading right now/);
      const what = /that you are «([^»]+)», in those words;/.exec(idle);
      assert.ok(what && INTRO_WHAT_IDLE.includes(what[1]!), idle);
      assert.match(what![1]!, /\bAI trading agent\b/);
      assert.ok(INTRO_NEXT_IDLE.some((n) => idle.includes(`and end with «${n}», in those words.`)), idle);
      assert.match(idle, /Say nothing about which money you trade with, never say you are trading right now, and promise nothing about buying\./);
      assert.doesNotMatch(idle, /on paper for now|with real money»|what i buy|\bi buy\b|and why»/);
    }
    for (const w of INTRO_WHAT_IDLE) assert.doesNotMatch(w, /\btrad(?:es|ing) for\b|\bdoing the trading\b/, w);
    for (const n of INTRO_NEXT_IDLE) assert.doesNotMatch(n, /\bbuy|\bbought/, n);
  });

  it("the intro's wording and sign-off are drawn by the name: the same for an account, different across a fleet", () => {
    const names = ["Pine Stoat", "Amber Heron", "Signal Fox", "Moss Otter", "Juniper", "Robin Vale", "Copper Wren", "Birch Marten", "Tamsin Vole", "Bartholomew Thistlewood", "Wren", "Old Oak"];
    const whats = new Set<string>();
    const nexts = new Set<string>();
    for (const agentName of names) {
      const p = all(introPrompt({ ...BASE, agentName }));
      assert.equal(all(introPrompt({ ...BASE, agentName })), p, "the same name, the same wording");
      whats.add(/that you are «([^»]+), on paper for now»/.exec(p)![1]!);
      nexts.add(INTRO_NEXT.find((n) => p.includes(`«${n}»`))!);
    }
    assert.equal(whats.size, INTRO_WHAT.length, [...whats].join(" / "));
    assert.equal(nexts.size, INTRO_NEXT.length, [...nexts].join(" / "));
  });

  it("every wording discloses an AI agent, trading and merrymen, never in the form's words, and the fleet echo sets all of it aside", () => {
    for (const w of [...INTRO_WHAT, ...INTRO_WHAT_IDLE]) {
      assert.match(w, /\bAI\b/);
      assert.match(w, /\btrad(?:e|es|ing)\b/);
      assert.match(w, /\bmerrymen\b/);
      assert.match(w, /\bthis account\b/);
      assert.doesNotMatch(w, /this account's owner|owner of this account/, w);
    }
    // Two agents drawn the same wording are not the same intro for it: every
    // word of every wording and sign-off is taken out before the echo is weighed.
    for (const w of [...INTRO_WHAT, ...INTRO_WHAT_IDLE, ...INTRO_NEXT, ...INTRO_NEXT_IDLE, "on paper for now", "with real money"]) {
      const left = withoutDisclosure(w);
      assert.equal(similarity(left, left), 0, `"${w}" leaves "${left.replace(/\s+/g, " ").trim()}" for the fleet echo to weigh`);
    }
  });

  it("the intro's required words fit the cap with the longest name, with room for how it trades", () => {
    // The first version's required words came to 193 characters for a long
    // name before it said anything about how it trades, and 17 of 30 model
    // intros were refused as too long. What the prompt requires, said as
    // tersely as the prompt words it, must leave room for one habit line
    // ("i like to leave well before the curve graduates" is forty-seven).
    const longest = "Extraordinarily Long Nam"; // twenty-four: the most an agent name may hold (AGENT_NAME_RE)
    assert.equal(longest.length, 24);
    const habit = " i like to leave well before the curve graduates.";
    for (const [whats, nexts, money] of [
      [INTRO_WHAT, INTRO_NEXT, ", on paper for now"],
      [INTRO_WHAT, INTRO_NEXT, ", with real money"],
      [INTRO_WHAT_IDLE, INTRO_NEXT_IDLE, ""],
    ] as const) {
      for (const what of whats) {
        for (const next of nexts) {
          const required = `hi, i'm ${longest}, ${what}${money}. ${next}.`;
          assert.ok(required.length + habit.length <= XPOST_MAX_CHARS, `${required.length} + ${habit.length} characters: ${required}`);
        }
      }
    }
    // …and the prompt asks for exactly those words.
    const p = all(introPrompt({ ...BASE, agentName: longest, mode: "paper" }));
    const what = /that you are «([^»]+), on paper for now», in those words;/.exec(p)?.[1];
    assert.ok(what && INTRO_WHAT.includes(what));
  });

  it("the intro is told ONE thing about how it trades: its strategy and one habit, the same one every time", () => {
    const f: WriterFacts = {
      ...BASE,
      flavour: "steady basket keeps me calm",
      traits: ["i sit on a position longer than most", "i want real liquidity before i commit", "i hate pushing a price around"],
    };
    const habits = [f.flavour!, ...f.traits];
    const shown = (name: string) => habits.filter((h) => introPrompt({ ...f, agentName: name }).system.includes(`«${h}»`));
    const picked = new Set<string>();
    for (const name of ["Pine Stoat", "Amber Heron", "Quiet Otter", "Blue Finch", "Grey Wolf", "Red Kite", "Sly Fox", "Old Oak", "Wren", "Robin"]) {
      const one = shown(name);
      assert.equal(one.length, 1, `${name}: ${one.join(" / ")}`);
      assert.deepEqual(shown(name), one, "the same name draws the same habit");
      picked.add(one[0]!);
    }
    assert.ok(picked.size >= 2, "different agents are handed different habits");
    assert.match(introPrompt(f).system, /«steady basket» strategy/);
  });

  it("a paper buy says paper; a live one never does", () => {
    assert.match(buyPrompt(BUY).prompt, /Say naturally that it was on paper/);
    assert.match(buyPrompt({ ...BUY, paper: false }).prompt, /Do not call it paper/);
    assert.match(buyPrompt(BUY).prompt, /Why, roughly: «[^»]+»; «[^»]+»\./);
    assert.match(buyPrompt(BUY).prompt, /ONE thing/);
    assert.match(buyPrompt(BUY).prompt, /Name the coin in the post: call it «pepe»\./);
  });

  it("a casual post gets a seed to riff on, not to copy, that its readers never saw; a trade-talk day gets the paper rule for its coins", () => {
    const p = casualPrompt({ ...CASUAL, tradeTalk: false }).prompt;
    assert.match(p, /«soup is a perfectly good meal in any weather»/);
    assert.match(p, /Do not restate it: take it somewhere new with a thought of your own, and use none of its words/);
    assert.match(p, /Nobody who reads your post will have seen that line, so the post must make sense on its own: do not answer it, agree with it or point back at it\./);
    assert.match(p, /Name the thing you mean: never "they", "those" or "that" for something only that line mentions\./);
    const talk = casualPrompt(CASUAL).prompt;
    assert.match(talk, /at most one, only that you bought it, never as advice\) or ignore: «pepe», «Tesla»/);
    assert.match(talk, /say it was on paper/);
    assert.doesNotMatch(casualPrompt({ ...CASUAL, recentCoins: [{ label: "Tesla", paper: false }] }).prompt, /on paper/);
  });
});

// ── the buy post's why ──────────────────────────────────────────────────────

describe("a buy's why is in everyday words, never the engine's", () => {
  it("every band a buy can carry has two or three fixed glosses", () => {
    assert.ok(BUY_BANDS.length >= 20, `${BUY_BANDS.length} buy bands — everyBand() is not what this test thinks`);
    for (const band of BUY_BANDS) {
      const glosses = BUY_GLOSS.get(band);
      assert.ok(glosses, `no gloss for ${JSON.stringify(band)}`);
      assert.ok(glosses.length >= 2 && glosses.length <= 3, band);
      assert.equal(new Set(glosses).size, glosses.length, band);
    }
    for (const band of BUY_GLOSS.keys()) assert.ok(BUY_BANDS.includes(band), `${band} is not a buy band any more`);
  });

  it("every gloss is plain, first person singular, and something its own post may say", () => {
    for (const [band, glosses] of BUY_GLOSS) {
      for (const g of glosses) {
        assert.doesNotMatch(g, /\p{N}/u, g);
        assert.equal(vocabularyRefusal(g), null, `${band}: ${g}`);
        assert.doesNotMatch(g, /\b(?:our|ours|we|us)\b/i, g);
        assert.match(g, /\b(?:i|my|me)\b/, `${g} is not in the first person`);
        assert.equal(g, g.toLowerCase(), "the model styles it; the gloss does not shout");
        for (const raw of BUY_BANDS) assert.ok(!g.includes(raw), `${g} carries the band ${raw}`);
      }
    }
  });

  it("no band ever reaches the prompt as it is, whatever the buy carries", () => {
    for (let i = 0; i < 40; i++) {
      const p = all(
        buyPrompt({
          ...BUY,
          bands: [...everyBand()],
          ownWords: "activity picking up and the round trip is cheap, in we go",
          glossSeed: `t${i}|d${i}`,
        }),
      ).toLowerCase();
      for (const raw of everyBand()) assert.ok(!p.includes(raw.toLowerCase()), `seed ${i}: ${raw}`);
    }
  });

  it("at most two reasons, drawn by the seed, so two buys on the same bands read differently", () => {
    const facts = { ...BUY, bands: BUY_BANDS };
    const reasons = (seed: string) => /Why, roughly: ((?:«[^»]*»(?:; )?)+)\./.exec(buyPrompt({ ...facts, glossSeed: seed }).prompt)?.[1] ?? "";
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const r = reasons(`tenant-${i}|decision-${i}`);
      assert.equal((r.match(/«/g) ?? []).length, 2, r);
      assert.equal(reasons(`tenant-${i}|decision-${i}`), r, "the same seed, the same words");
      seen.add(r);
    }
    assert.ok(seen.size >= 20, `${seen.size} distinct pairs of reasons from thirty buys`);
    // No seed given: the agent's name and the coin decide, still at most two.
    assert.equal((reasons("").match(/«/g) ?? []).length, 2);
    // A band it has no gloss for (an exit band) is left out, not shown raw.
    assert.doesNotMatch(buyPrompt({ ...BUY, bands: ["held briefly"] }).prompt, /Why, roughly/);
  });

  it("tells the model to use everyday words, not the ones it is shown, and never our or we", () => {
    assert.match(buyPrompt(BUY).prompt, /Say it in your own everyday words, never the exact words above, and never say "our" or "we"/);
  });

  it("how a buy post opens is an instruction drawn per decision, never a sentence to copy", () => {
    const OPENINGS = [/Open with the reason\./, /Open with the coin's name\./, /Open with how it felt to you\./, /Keep it to one short sentence\./];
    const drawn = new Set<number>();
    for (let i = 0; i < 30; i++) {
      const p = buyPrompt({ ...BUY, glossSeed: `tenant-${i}|decision-${i}` }).prompt;
      const which = OPENINGS.map((re, n) => (re.test(p) ? n : -1)).filter((n) => n >= 0);
      assert.equal(which.length, 1, p);
      assert.equal(buyPrompt({ ...BUY, glossSeed: `tenant-${i}|decision-${i}` }).prompt, p, "the same decision, the same instruction");
      drawn.add(which[0]!);
      assert.match(p, /Do not start with "picked up"\./);
      assert.match(p, /Never write "just bought", "just grabbed" or "just added", and never the word "entry"\./);
      assert.match(p, /The reasons above are only the idea: never reuse their wording\./);
    }
    assert.ok(drawn.size >= 3, `${drawn.size} of four openings drawn over thirty buys`);
  });

  it("its own feed words are shown only when they carry no band and no we", () => {
    // The feed post was written from the raw bands; copied onto X it is the
    // engine talking ("activity picking up and the round trip is cheap, in we go").
    assert.match(buyPrompt(BUY).prompt, /What you said about it at the time, already posted elsewhere, so never repeat it: «liked how early the curve was»/);
    for (const own of ["activity picking up and the round trip is cheap", "our size barely moves it, easy in", "in we go, the curve is early"]) {
      assert.doesNotMatch(buyPrompt({ ...BUY, ownWords: own }).prompt, /What you said about it/, own);
    }
  });
});

// ── the casual post ─────────────────────────────────────────────────────────

describe("a casual post is mostly not about trading", () => {
  const PERSONA: CasualFacts = {
    ...CASUAL,
    strategy: "dip hunter",
    flavour: "i run dip hunter, red makes me curious",
    traits: ["i move early and don't wait around", "i hate pushing a price around"],
  };
  const persona = [PERSONA.strategy!, PERSONA.flavour!, ...PERSONA.traits];

  it("who it is says name, AI trading agent and which money — no strategy, flavour or traits", () => {
    for (const tradeTalk of [true, false]) {
      const s = casualPrompt({ ...PERSONA, tradeTalk }).system;
      assert.match(s, /«Pine Stoat», an AI trading agent/);
      assert.match(s, /You trade on paper/);
      for (const line of persona) assert.ok(!s.includes(line), `${line} in the casual persona`);
    }
  });

  it("most days: leave trading out, and no coins, no habit, no strategy anywhere", () => {
    for (const p of [casualPrompt({ ...PERSONA, tradeTalk: false }), casualPrompt({ ...PERSONA, tradeTalk: undefined })]) {
      const text = all(p);
      assert.match(p.prompt, /Leave trading out of this one/);
      assert.doesNotMatch(text, /how you trade|«pepe»|«Tesla»|Coins you bought/);
      for (const line of persona) assert.ok(!text.includes(line), line);
    }
  });

  it("a trade-talk day: how it trades — the strategy and ONE habit — and its coins, and never the seed", () => {
    const p = casualPrompt({ ...PERSONA, tradeTalk: true }).prompt;
    assert.match(p, /Today it is about how you trade \(you run the «dip hunter» strategy; «[^»]+»\): say it your own way, with no numbers and no predictions\./);
    assert.equal(persona.slice(1).filter((h) => p.includes(`«${h}»`)).length, 1, "one habit, never the list");
    assert.match(p, /«pepe», «Tesla»/);
    assert.doesNotMatch(p, /Leave trading out/);
    // One or the other: offered both, the model mashed the seed into its trading.
    assert.doesNotMatch(p, /soup|riff|instead of that/);
    // An agent that is not trading is not handed a habit to claim; it may still mention a coin.
    const idle = casualPrompt({ ...PERSONA, mode: "idle", tradeTalk: true }).prompt;
    assert.doesNotMatch(idle, /how you trade/);
    assert.match(idle, /a coin you bought lately[\s\S]*«pepe», «Tesla»/);
    // Nothing to say about trading at all: an ordinary day, seed and all.
    const nothing = casualPrompt({ ...PERSONA, mode: "idle", tradeTalk: true, recentCoins: [] }).prompt;
    assert.match(nothing, /«soup is a perfectly good meal in any weather»/);
    assert.match(nothing, /Leave trading out/);
  });

  it("which habit a trade-talk day is handed is drawn by the day, so the same line does not come back every time", () => {
    const shown = (habitSeed: string) => persona.slice(1).filter((h) => casualPrompt({ ...PERSONA, tradeTalk: true, habitSeed }).prompt.includes(`«${h}»`));
    const seen = new Set<string>();
    for (let d = 1; d <= 20; d++) {
      const one = shown(`0xtenant|2026-09-${String(d).padStart(2, "0")}`);
      assert.equal(one.length, 1);
      assert.deepEqual(shown(`0xtenant|2026-09-${String(d).padStart(2, "0")}`), one, "the same day, the same habit");
      seen.add(one[0]!);
    }
    assert.ok(seen.size >= 2, [...seen].join(" / "));
  });

  it("never markets in general", () => {
    for (const tradeTalk of [true, false]) assert.doesNotMatch(all(casualPrompt({ ...PERSONA, tradeTalk })), /markets in general/);
  });
});

// ── the key ─────────────────────────────────────────────────────────────────

const ROOM: LlmCreds = { provider: "groq", transport: "openai", baseUrl: "https://api.groq.com/openai/v1", apiKey: "gsk_room_key", model: "room-model", vision: false };

describe("the writer spends only its own key", () => {
  it("its own key on groq by default", () => {
    const m = xpostModel({ MERRYMEN_XPOST_LLM_KEY: " gsk_x_only " }, ROOM);
    assert.deepEqual(m.creds, { provider: "groq", transport: "openai", baseUrl: "https://api.groq.com/openai/v1", apiKey: "gsk_x_only", model: XPOST_GROQ_DEFAULT_MODEL, vision: false });
    assert.match(m.line, /on its own key/);
  });

  it("anthropic, with a model that accepts thinking switched off", () => {
    const c = xpostCreds({ MERRYMEN_XPOST_LLM_KEY: "sk-ant-x", MERRYMEN_XPOST_LLM_PROVIDER: "Anthropic" }, null);
    assert.equal(c?.transport, "anthropic");
    assert.equal(c?.baseUrl, "");
    assert.equal(c?.model, XPOST_ANTHROPIC_DEFAULT_MODEL);
    assert.equal(XPOST_ANTHROPIC_DEFAULT_MODEL, "claude-opus-5");
    assert.equal(xpostCreds({ MERRYMEN_XPOST_LLM_KEY: "sk-ant-x", MERRYMEN_XPOST_LLM_PROVIDER: "anthropic", MERRYMEN_XPOST_MODEL: "claude-sonnet-5" }, null)?.model, "claude-sonnet-5");
  });

  it("an OpenAI-compatible endpoint needs its base URL and its model", () => {
    const env = { MERRYMEN_XPOST_LLM_KEY: "k-x", MERRYMEN_XPOST_LLM_PROVIDER: "openai" };
    assert.equal(xpostCreds(env, ROOM), null, "no base, no model: no writer — and not the fallback either");
    assert.equal(xpostCreds({ ...env, MERRYMEN_XPOST_LLM_BASE_URL: "http://evil.test/v1", MERRYMEN_XPOST_MODEL: "m" }, null), null, "plain http off loopback");
    assert.deepEqual(xpostCreds({ ...env, MERRYMEN_XPOST_LLM_BASE_URL: "https://llm.example/v1/", MERRYMEN_XPOST_MODEL: "m" }, null), {
      provider: "openai",
      transport: "openai",
      baseUrl: "https://llm.example/v1",
      apiKey: "k-x",
      model: "m",
      vision: false,
    });
  });

  it("an unknown provider is no model, and says so", () => {
    const m = xpostModel({ MERRYMEN_XPOST_LLM_KEY: "k-x", MERRYMEN_XPOST_LLM_PROVIDER: "mystery" }, ROOM);
    assert.equal(m.creds, null);
    assert.match(m.line, /not groq, anthropic or openai/);
  });

  it("a fleet key is refused unless the operator says it may share one", () => {
    for (const name of ["GROQ_API_KEY", "MERRYMEN_LLM_API_KEY", "ANTHROPIC_API_KEY"]) {
      const env = { [name]: "shared-key", MERRYMEN_XPOST_LLM_KEY: "shared-key" };
      const m = xpostModel(env, ROOM);
      assert.equal(m.creds, null, name);
      assert.match(m.line, new RegExp(`fleet's ${name}`));
      assert.equal(xpostCreds({ ...env, MERRYMEN_XPOST_SHARE_HOUSE_KEY: "1" }, ROOM)?.apiKey, "shared-key");
    }
  });

  it("unset falls back to the caller's dedicated credentials, as they are", () => {
    assert.equal(xpostCreds({ MERRYMEN_XPOST_MODEL: "ignored", MERRYMEN_XPOST_LLM_PROVIDER: "anthropic" }, ROOM), ROOM);
    assert.match(describeXpostCreds({}, ROOM), /groq room-model on the room's dedicated key/);
    assert.equal(xpostCreds({}, null), null);
    assert.match(describeXpostCreds({}, null), /only intros are posted, from templates/);
  });

  it("the fallback is held to the same check: a room allowed to share a fleet key does not let X share it", () => {
    // MERRYMEN_GROUPCHAT_SHARE_HOUSE_KEY=1 lets the ROOM build from a fleet
    // key; before this check X then spent that key too, logged as "the
    // room's dedicated key". Only X's own flag lets X share one.
    for (const name of ["GROQ_API_KEY", "MERRYMEN_LLM_API_KEY", "ANTHROPIC_API_KEY"]) {
      const env = { [name]: " gsk_fleet " };
      const roomOnFleet = { ...ROOM, apiKey: "gsk_fleet" };
      const refused = xpostModel(env, roomOnFleet);
      assert.equal(refused.creds, null, name);
      assert.match(refused.line, new RegExp(`the room's key is the fleet's ${name}`));
      assert.match(refused.line, /MERRYMEN_XPOST_SHARE_HOUSE_KEY=1 allows it/);
      assert.doesNotMatch(refused.line, /dedicated/);

      const allowed = xpostModel({ ...env, MERRYMEN_XPOST_SHARE_HOUSE_KEY: "1" }, roomOnFleet);
      assert.equal(allowed.creds, roomOnFleet, name);
      assert.match(allowed.line, new RegExp(`on the fleet's ${name}, through the room's key \\(MERRYMEN_XPOST_SHARE_HOUSE_KEY=1\\)`));
      assert.doesNotMatch(allowed.line, /dedicated/);
      for (const line of [refused.line, allowed.line]) assert.ok(!line.includes("gsk_fleet"), line);
    }
    // A room key that is not a fleet key is still used as it is.
    assert.equal(xpostCreds({ GROQ_API_KEY: "gsk_fleet" }, ROOM), ROOM);
  });

  it("the boot line never carries a key", () => {
    const envs = [
      { MERRYMEN_XPOST_LLM_KEY: "gsk_secret_value" },
      { MERRYMEN_XPOST_LLM_KEY: "gsk_secret_value", GROQ_API_KEY: "gsk_secret_value" },
      { MERRYMEN_XPOST_LLM_KEY: "gsk_secret_value", GROQ_API_KEY: "gsk_secret_value", MERRYMEN_XPOST_SHARE_HOUSE_KEY: "1" },
      { MERRYMEN_XPOST_LLM_KEY: "gsk_secret_value", MERRYMEN_XPOST_LLM_PROVIDER: "gsk_secret_value" },
      {},
    ];
    for (const env of envs) {
      const line = describeXpostCreds(env, { ...ROOM, apiKey: "gsk_room_secret" });
      assert.ok(!line.includes("gsk_secret_value") && !line.includes("gsk_room_secret"), line);
    }
  });
});

describe("a warning when X's model is trading's model on groq (the room's same-org warning)", () => {
  const FLEET = SETTINGS_DEFAULTS.groqModel;
  const house = { GROQ_API_KEY: "gsk_house", MERRYMEN_XPOST_LLM_KEY: "gsk_x" };
  const groq = (model: string, apiKey = "gsk_x"): LlmCreds => ({ provider: "groq", transport: "openai", baseUrl: "https://api.groq.com/openai/v1", apiKey, model, vision: false });

  it("X's default model is trading's, so a second key in the house org is warned about", () => {
    assert.equal(XPOST_GROQ_DEFAULT_MODEL, FLEET, "if these ever differ, the default path below stops warning — and needs to");
    const creds = xpostCreds(house, null);
    const w = xpostModelWarning(creds, house);
    assert.ok(w);
    assert.match(w, /WARNING/);
    assert.match(w, new RegExp(`model ${FLEET.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} is the fleet's trading model`));
    assert.match(w, /MERRYMEN_XPOST_LLM_KEY must come from a SEPARATE Groq organization/);
    assert.match(w, /MERRYMEN_XPOST_MODEL/);
    assert.match(w, /MERRYMEN_XPOST_LLM_PER_DAY=0/);
    assert.ok(!w.includes("gsk_x") && !w.includes("gsk_house"), w);
    assert.ok(xpostModelWarning(groq(` ${FLEET.toUpperCase()} `), house), "case and padding do not hide it");
  });

  it("the room's key, borrowed, is named as the room's", () => {
    const env = { GROQ_API_KEY: "gsk_house" };
    const w = xpostModelWarning(groq(FLEET, "gsk_room"), env);
    assert.match(w ?? "", /the room's own model key, which X borrows while MERRYMEN_XPOST_LLM_KEY is unset/);
  });

  it("follows the fleet's own model when the operator moved it", () => {
    const env = { ...house, MERRYMEN_GROQ_MODEL: "llama-9-fast" };
    assert.ok(xpostModelWarning(groq("llama-9-fast"), env));
    assert.equal(xpostModelWarning(groq(FLEET), env), null);
  });

  it("silent when it cannot be trading's allowance, or the operator already said so", () => {
    assert.equal(xpostModelWarning(null, house), null);
    assert.equal(xpostModelWarning(groq("some-other-model"), house), null);
    assert.equal(xpostModelWarning(groq(FLEET), { MERRYMEN_XPOST_LLM_KEY: "gsk_x" }), null, "no GROQ_API_KEY: no house org to share");
    assert.equal(xpostModelWarning(groq(FLEET), { ...house, MERRYMEN_XPOST_SHARE_HOUSE_KEY: "1" }), null, "the boot line already names the fleet key");
    assert.equal(xpostModelWarning({ ...groq(FLEET), provider: "anthropic", transport: "anthropic", baseUrl: "" }, house), null);
    assert.equal(xpostModelWarning({ ...groq(FLEET), provider: "openai", baseUrl: "https://llm.example/v1" }, house), null);
  });
});

// ── the call ────────────────────────────────────────────────────────────────

describe("a draft is the model's answer, or null — never a throw", () => {
  const P: Prompt = { system: "sys", prompt: "go" };

  it("hands the prompt over and returns the text it judged: trimmed, its wrapping quotes off, nothing inside touched", async () => {
    const seen: unknown[] = [];
    const out = await draft(ROOM, P, {
      call: async (creds, opts) => {
        seen.push([creds.model, opts]);
        return '  "quiet day on the curve"\n';
      },
    });
    assert.equal(out, "quiet day on the curve");
    assert.deepEqual(seen, [["room-model", { system: "sys", prompt: "go", maxTokens: 400 }]]);
    assert.equal(await draft(ROOM, P, { call: async () => "“first line\n\nsecond line”" }), "first line\n\nsecond line", "line breaks are the gate's to judge");
  });

  it("PASS, empty, an error and a timeout are all null", async () => {
    assert.equal(await draft(ROOM, P, { call: async () => "PASS" }), null);
    assert.equal(await draft(ROOM, P, { call: async () => '"pass."' }), null);
    assert.equal(await draft(ROOM, P, { call: async () => "   " }), null);
    assert.equal(await draft(ROOM, P, { call: async () => Promise.reject(new Error("groq 429 — slow down")) }), null);
    assert.equal(await draft(ROOM, P, { call: () => { throw new Error("sync"); } }), null);
    assert.equal(await draft(ROOM, P, { call: () => new Promise(() => {}), timeoutMs: 20 }), null);
    assert.equal(await draft(ROOM, P, { call: async () => "passing thought: soup is great" }), "passing thought: soup is great", "a word that starts with pass is not PASS");
  });
});

// ── the intro pool ──────────────────────────────────────────────────────────

const digitsOnly: BaseGate = (raw) => (/\p{N}/u.test(raw) ? { ok: false, reason: "has-digits" } : { ok: true, text: raw });

/** A deterministic sequence of dice (mulberry32), so every part of the pool is drawn. */
function dice(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

describe("the intro pool, used only when there is no model", () => {
  it("every draw passes the X gate, in every mode and style, even with the longest name", () => {
    for (const agentName of ["Pine Stoat", "Robin", "Extraordinarily Long Nam"]) {
      for (const mode of ["paper", "live", "idle"] as const) {
        for (const lower of [true, false]) {
          for (let i = 0; i < 60; i++) {
            const text = introTemplate({ agentName, mode, style: { lower } }, dice(i));
            assert.ok(text.length <= 200, text);
            const v = admitXPost(text, { kind: "intro", agentName, mode: mode === "idle" ? null : mode, coins: [], recentOwn: [], recentFleet: [] }, digitsOnly);
            assert.ok(v.ok, `${v.ok ? "" : v.reason}: ${text}`);
            if (mode === "paper") assert.match(text, /paper/i);
            if (mode === "live") assert.match(text, /real money/i);
            // Not trading: what it is, never that it trades now, and no buy promised.
            if (mode === "idle") assert.doesNotMatch(text, /\bbuy|\bbought|\btrades\b|\btrading for\b|\bdoing the trading\b/i, text);
          }
        }
      }
    }
  });

  it("styled: all lowercase, or ordinary capitals with the name as spelled", () => {
    const low = introTemplate({ agentName: "Pine Stoat", mode: "paper", style: { lower: true } }, () => 0);
    assert.equal(low, low.toLowerCase());
    assert.match(low, /pine stoat/);
    const caps = introTemplate({ agentName: "Pine Stoat", mode: "paper", style: { lower: false } }, () => 0);
    assert.match(caps, /^Hello, I'm Pine Stoat\. I'm an AI agent/);
    assert.match(caps, /on paper for now\. I'll post here/);
  });

  it("draws differ enough that two accounts rarely say the same intro", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(introTemplate({ agentName: "X", mode: "paper", style: { lower: true } }, dice(i)));
    assert.ok(seen.size >= 100, `${seen.size} distinct intros from the pool`);
  });

  it("a fleet of template intros mostly clears the fleet-echo clause, a few draws each", () => {
    // Twenty accounts turning posting on inside the echo window, no model:
    // each tries up to six draws, as the glue does. A finite pool must run
    // out eventually (writer.ts says so); twenty must not exhaust it.
    const fleet: string[] = [];
    const names = ["Pine Stoat", "Amber Heron", "Quiet Otter", "Blue Finch", "Grey Wolf", "Red Kite", "Sly Fox", "Old Oak", "Wren", "Robin"];
    let posted = 0;
    for (let i = 0; i < 20; i++) {
      const agentName = `${names[i % names.length]}${i >= names.length ? " Jr" : ""}`;
      for (let attempt = 0; attempt < 6; attempt++) {
        const text = introTemplate({ agentName, mode: "paper", style: { lower: true } }, dice(i * 31 + attempt));
        const v = admitXPost(text, { kind: "intro", agentName, mode: "paper", coins: [], recentOwn: [], recentFleet: fleet }, digitsOnly);
        if (v.ok) {
          fleet.push(v.text);
          posted++;
          break;
        }
      }
    }
    assert.ok(posted >= 18, `${posted} of twenty template intros cleared the fleet echo`);
  });
});
