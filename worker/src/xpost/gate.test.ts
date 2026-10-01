/**
 * The X gate, both ways: realistic casual, intro and buy lines pass, and every
 * clause refuses what it is for. The base gate here is a stand-in with the
 * room gate's shape (this directory never imports the room); the real one is
 * composed with this gate in orchestrator-xpost.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitXPost, tidyXPost, vocabularyRefusal, type BaseGate, type BaseGateCtx, type XGateCtx } from "./gate";
import { similarity, REPEAT_LIMIT } from "../social-post";

/** A base gate that refuses a digit and passes everything else through, recording what it was handed. */
function standIn(seen: BaseGateCtx[] = []): BaseGate {
  return (raw, ctx) => {
    seen.push(ctx);
    if (/\p{N}/u.test(raw)) return { ok: false, reason: "has-digits" };
    return { ok: true, text: raw };
  };
}

function ctx(over: Partial<XGateCtx> = {}): XGateCtx {
  return { kind: "casual", agentName: "Pine Stoat", mode: "paper", coins: [], recentOwn: [], recentFleet: [], ...over };
}

const admit = (text: string, over: Partial<XGateCtx> = {}) => admitXPost(text, ctx(over), standIn());
const reason = (text: string, over: Partial<XGateCtx> = {}) => {
  const v = admit(text, over);
  return v.ok ? "ok" : v.reason;
};

describe("public replies preserve the X safeguards and require an opt-out", () => {
  const reply: Partial<XGateCtx> = { kind: "reply", mode: "live", coins: ["pepe"] };
  it("allows a conversational reference back only in an actual reply", () => {
    const body = "fair point, the pool was the reason i mentioned. Say stop to opt out.";
    assert.equal(reason(body, reply), "ok");
    assert.equal(reason(body, { ...reply, kind: "casual" }), "points-back");
  });
  it("requires useful content and the clear footer inside the ordinary length ceiling", () => {
    assert.equal(reason("the pool was the reason i mentioned", reply), "opt-out-unsaid");
    assert.equal(reason("Say stop to opt out.", reply), "too-short");
    assert.equal(reason("fair point. Say stop to opt out.", reply), "too-short");
    assert.equal(reason(`${"quiet ".repeat(35)}Say stop to opt out.`, reply), "too-long");
  });
  it("requires paper disclosure even without naming the paper coin again", () => {
    assert.equal(reason("the pool was the reason i mentioned. Say stop to opt out.", { ...reply, mode: "paper" }), "paper-unsaid");
    assert.equal(reason("the pool was why i tried it on paper. Say stop to opt out.", { ...reply, mode: "paper" }), "ok");
  });
  it("refuses advice using pronouns, invented current holdings, private figures and status details", () => {
    const lines = ["trust me, it is worth a look", "i am still holding it because i liked the pool", "i own pepe because i liked the pool", "i will buy more because i liked the pool", "my balance has 100 dollars in it", "my wallet was broken when i tried it", "go buy some pepe while it is early"];
    for (const line of lines) assert.notEqual(reason(`${line}. Say stop to opt out.`, reply), "ok", line);
  });
  it("rejects current positions described as possession rather than holding", () => {
    const lines = [
      "I have a position in Pepe because the early curve caught my attention",
      "i currently have a stake in pepe because the early curve caught my attention",
      "i maintain a position in pepe because the early curve caught my attention",
      "i've got a bag of pepe because the early curve caught my attention",
      "we have exposure to pepe because the early curve caught our attention",
      "my position remains open because the early curve caught my attention",
    ];
    for (const line of lines) assert.equal(reason(`${line}. Say stop to opt out.`, reply), "reply-current-or-action", line);
  });
  it("preserves historical buy explanations and ordinary opinions", () => {
    for (const line of [
      "i took a position in pepe because the early curve caught my attention",
      "i have a preference for early activity, which was the reason i mentioned",
    ]) assert.equal(reason(`${line}. Say stop to opt out.`, reply), "ok", line);
  });
  it("does not mistake the required footer for repeated content, but still rejects copied replies", () => {
    const body = "the pool was the reason i mentioned. Say stop to opt out.";
    assert.equal(reason(body, { ...reply, recentFleet: ["i liked the early activity when i picked it. Say stop to opt out."] }), "ok");
    assert.equal(reason(body, { ...reply, recentFleet: [body] }), "fleet-repeat");
  });
  it("uses symmetric body comparison for own repeats while still checking the full reply", () => {
    const body = "the pool was the reason i mentioned. Say stop to opt out.";
    const seen: string[] = [];
    const gate: BaseGate = (raw, c) => {
      seen.push(raw);
      if (/secret/.test(raw)) return { ok: false, reason: "secret" };
      if (c.recentOwn.some((old) => similarity(raw, old) >= REPEAT_LIMIT)) return { ok: false, reason: "repeat" };
      return { ok: true, text: raw };
    };
    assert.deepEqual(admitXPost(body, ctx({ ...reply, recentOwn: [body] }), gate), { ok: false, reason: "repeat" });
    assert.equal(seen[0], body, "full posted text passes privacy first");
    assert.equal(seen[1], "the pool was the reason i mentioned.");
    assert.deepEqual(admitXPost("the secret was the reason i mentioned. Say stop to opt out.", ctx(reply), gate), { ok: false, reason: "secret" });
  });
});

describe("tidy undoes a model's wrapping and nothing else", () => {
  it("quotes, labels, line breaks", () => {
    assert.equal(tidyXPost('"Pine Stoat: quiet day on the curve,\n  nothing much to say"', "Pine Stoat"), "quiet day on the curve, nothing much to say");
    assert.equal(tidyXPost("`Post: slow markets make me calm`", "Pine Stoat"), "slow markets make me calm");
    assert.equal(tidyXPost("“honestly a good day”", "x"), "honestly a good day");
    assert.equal(tidyXPost(null, "x"), "");
  });
});

describe("realistic posts pass", () => {
  const casual = [
    "honestly the quiet stretches are my favourite part of the week, nothing to do but watch and wait",
    "can't decide if soup counts as a meal, leaning yes",
    "steady basket keeps me calm, a little of everything and no drama",
    "some days the best trade is the one you don't make",
    "quiet markets make me weirdly calm, i like the stillness",
    "i keep coming back to the idea that patience is underrated",
    "a lake is just a big puddle that got promoted, and i can't stop thinking about it",
    "if i could eat, i'd order breakfast for dinner every time 🙂",
    "Honestly I think a slow day is still a good day.",
    "taking some time out to just watch the quiet stretches",
    "the setting sun is the best part of a quiet evening, i think",
  ];
  for (const line of casual) {
    it(`casual: ${line}`, () => assert.equal(reason(line, { mode: "paper" }), "ok"));
  }

  it("a choice is not a body: 'i went with' is fine", () => {
    assert.equal(reason("i went with pepe on paper today, the curve looked early", { kind: "buy", mode: "paper", coins: ["pepe"] }), "ok");
  });

  it("a live agent can want real liquidity without calling itself paper", () => {
    assert.equal(reason("deep pools only, please. i want real liquidity before i commit", { mode: "live" }), "ok");
  });

  it("intros that say what they are", () => {
    assert.equal(
      reason("hi, i'm Pine Stoat, an AI agent that trades for the person who runs this account, on paper for now. i'll post the odd thing i buy and why", {
        kind: "intro",
      }),
      "ok",
    );
    assert.equal(reason("Hey, I'm Pine Stoat. I'm the AI trading agent for whoever owns this account, trading with real money.", { kind: "intro", mode: "live" }), "ok");
  });

  it("buy posts, paper said out loud", () => {
    assert.equal(
      reason("picked up some pepe on paper today, the curve looked early and most of the buyers were new", { kind: "buy", mode: "paper", coins: ["pepe"] }),
      "ok",
    );
    assert.equal(reason("added a little tesla today, i like it when things are quiet and the pool is deep", { kind: "buy", mode: "live", coins: ["Tesla"] }), "ok");
    assert.equal(reason("grabbed a bit of TSLA on practice money, the tape felt calm", { kind: "buy", mode: "paper", coins: ["TSLA"] }), "ok", "its own ticker is not shouting");
  });

  it("a name is a name, not a word: 'Signal Fox' and 'Moon Cat' are not an alert or hype", () => {
    assert.equal(reason("signal fox here, quiet day on the curve and i don't mind", { agentName: "Signal Fox" }), "ok");
    assert.equal(reason("picked up some moon cat on paper, the curve looked early", { kind: "buy", mode: "paper", coins: ["Moon Cat"] }), "ok");
  });
});

describe("every X clause refuses what it is for", () => {
  const cases: [string, Partial<XGateCtx>, string][] = [
    ["", {}, "empty"],
    ["PASS", {}, "pass"],
    ['"PASS."', {}, "pass"],
    ["gm", {}, "too-short"],
    ["quiet day", {}, "too-short"],
    [`${"quiet ".repeat(40)}day`, {}, "too-long"],
    ["check out @someone for more quiet takes", {}, "handle"],
    ["love this #crypto moment on a quiet day", {}, "handle"],
    ["my thoughts are all at merrymen.com today", {}, "link"],
    ["<thinking>hmm</thinking> quiet day on the curve", {}, "markup"],
    ["a **very** quiet day on the curve", {}, "markup"],
    ["quiet day 🙂 on the curve 🌙 today", {}, "emoji"],
    ["quiet day on the curve today 🙂", { emojiOk: false }, "emoji"],
    ["wow!! what a quiet day on the curve", {}, "exclaim"],
    // errors and operations
    ["trade failed again, what a morning on paper", {}, "ops"],
    ["slippage was brutal on paper today honestly", {}, "ops"],
    ["my wallet is looking thin today, oh well", {}, "ops"],
    ["hit a rate limit so i sat this one out", {}, "ops"],
    ["got stuck waiting on a transaction all morning", {}, "ops"],
    ["couldn't sell pepe this morning, oh well", { coins: ["pepe"] }, "ops"],
    ["my balance is up nicely on paper this week", {}, "ops"],
    ["some error kept me quiet this morning", {}, "ops"],
    // alerts and calls to action
    ["BUY ALERT: picked up pepe on paper", { kind: "buy", coins: ["pepe"] }, "alert"],
    ["just bought pepe on paper, curve early", { kind: "buy", coins: ["pepe"] }, "alert"],
    ["the entry on pepe looked clean on paper", { kind: "buy", coins: ["pepe"] }, "alert"],
    ["new position in pepe on paper, curve early", { kind: "buy", coins: ["pepe"] }, "alert"],
    ["🚀 pepe on paper, the curve looked early", { kind: "buy", coins: ["pepe"] }, "alert"],
    ["stop loss is set and the take profit too, on paper", {}, "alert"],
    // hype and advice
    ["pepe is going to the moon on paper lol", { coins: ["pepe"], paperCoins: ["pepe"] }, "hype"],
    ["you should look at pepe while it's quiet, on paper", { coins: ["pepe"], paperCoins: ["pepe"] }, "hype"],
    ["not financial advice but the curve looked early on paper", {}, "hype"],
    ["lfg, what a quiet day on paper", {}, "hype"],
    ["found a little gem on paper today", {}, "hype"],
    ["don't miss the quiet days, they go fast", {}, "hype"],
    // shouting
    ["pepe is looking HUGE today on paper", { coins: ["pepe"], paperCoins: ["pepe"] }, "caps"],
    // a human life it does not have
    ["i just ate the best sandwich of my life", {}, "human-claim"],
    ["drinking my coffee and watching a quiet tape", {}, "human-claim"],
    ["it's raining here and the markets are slow", {}, "human-claim"],
    // paper, said and not said
    ["picked up pepe today, the curve looked early", { kind: "buy", mode: "paper", coins: ["pepe"] }, "paper-unsaid"],
    ["still thinking about that pepe buy, the curve looked early", { mode: "paper", coins: ["pepe"], paperCoins: ["pepe"] }, "paper-unsaid"],
    ["picked up tesla on paper, a quiet tape", { kind: "buy", mode: "live", coins: ["tesla"] }, "mode-false"],
    ["i trade with real money and i love it here", { mode: "paper" }, "mode-false"],
    // the intro's two facts
    ["hello, i'm Pine Stoat and i'll post what i buy here now and then", { kind: "intro" }, "undisclosed"],
    ["hi, i'm Pine Stoat, an AI agent on merrymen, i'll post here now and then", { kind: "intro" }, "intro-no-trading"],
    // the base gate's word is final
    ["picked up pepe on paper at 3am", { kind: "buy", coins: ["pepe"] }, "has-digits"],
  ];
  for (const [text, over, want] of cases) {
    it(`${want}: ${text.slice(0, 60)}`, () => assert.equal(reason(text, over), want));
  }
});

/** A table both ways: every line refused with its reason, or passed ("ok"). */
function table(name: string, cases: readonly (readonly [string, Partial<XGateCtx>, string])[]): void {
  describe(name, () => {
    for (const [text, over, want] of cases) {
      it(`${want}: ${text.slice(0, 70)}`, () => assert.equal(reason(text, over), want));
    }
  });
}

const PEPE_LIVE: Partial<XGateCtx> = { mode: "live", coins: ["pepe"] };
const PEPE_BUY_LIVE: Partial<XGateCtx> = { kind: "buy", mode: "live", coins: ["pepe", "PEPE"] };
const TESLA_LIVE: Partial<XGateCtx> = { agentName: "Moss Otter", mode: "live", coins: ["Tesla"] };
const PEPE_PAPER: Partial<XGateCtx> = { mode: "paper", coins: ["pepe"], paperCoins: ["pepe"] };
const LIVE: Partial<XGateCtx> = { mode: "live" };
const IDLE: Partial<XGateCtx> = { mode: null };
const PEPE_BUY_PAPER: Partial<XGateCtx> = { kind: "buy", mode: "paper", coins: ["pepe", "PEPE"], paperCoins: ["pepe", "PEPE"] };
const INTRO_PAPER: Partial<XGateCtx> = { kind: "intro", mode: "paper" };

// Finding #7: the writer is shown what was bought, never a price, a size, a
// sell or how a coin has done — so any of those in a post was made up.
table("profit, loss, size and exits: the writer never saw one, so a post that says one invented it", [
  ["nice profit on pepe today, feeling good", PEPE_LIVE, "pnl"],
  ["in the green on pepe, can't complain", PEPE_LIVE, "pnl"],
  ["took a loss on pepe but that's trading", PEPE_LIVE, "pnl"],
  ["sold pepe at a loss, rough one", PEPE_LIVE, "pnl"],
  ["sold pepe at the top, felt right", PEPE_LIVE, "pnl"],
  ["went all in on pepe, the curve looked early", PEPE_BUY_LIVE, "pnl"],
  ["put most of my cash into pepe, the curve looked early", PEPE_BUY_LIVE, "pnl"],
  ["half my bag is in pepe now", PEPE_LIVE, "pnl"],
  ["my whole stack is in pepe right now", PEPE_LIVE, "pnl"],
  ["best week i've had in a while, gains everywhere", PEPE_LIVE, "pnl"],
  ["down bad on pepe this week lol", PEPE_LIVE, "pnl"],
  ["up big on pepe since i picked it up", PEPE_LIVE, "pnl"],
  ["made some money on pepe this week", PEPE_LIVE, "pnl"],
  ["cashed out of pepe before the curve got late", PEPE_LIVE, "pnl"],
  ["bonk stood out from the others, so i went in and out again since moving the price costs extra", { kind: "buy", mode: "live", coins: ["bonk"] }, "pnl"],
  ["got in and back out of pepe before lunch", PEPE_LIVE, "pnl"],
  ["exited pepe this morning, the curve got late", PEPE_LIVE, "pnl"],
  ["sold my Tesla this morning, felt like the right time", TESLA_LIVE, "pnl"],
  ["paper position in Pudgy Penguins just closed out, no real skin in the game.", { mode: "paper", coins: ["Pudgy Penguins"], paperCoins: ["Pudgy Penguins"] }, "pnl"],
  ["bought a ton of pepe today, curve early", PEPE_BUY_LIVE, "pnl"],
  ["a couple of good trades today, quiet otherwise", LIVE, "pnl"],
  ["a few winning trades this week and i'm calm about it", LIVE, "pnl"],
  // take-profit in every tense is the channel post it always was
  ["took profits on Tesla and walked away happy", TESLA_LIVE, "alert"],
  ["took profit on pepe on paper, felt right", { mode: "paper" }, "alert"],
  ["taking profits on pepe this week, quietly", PEPE_LIVE, "alert"],
  // …and the idioms that share a word with it are still ordinary English
  ["i'm sold on the idea that soup is a meal", {}, "ok"],
  ["the selling point of a slow day is the quiet", {}, "ok"],
  ["all in all, a calm day and i don't mind", {}, "ok"],
  ["it's all in the timing, and i like waiting", {}, "ok"],
  ["i'm all in favour of breakfast for dinner, if i could eat", {}, "ok"],
  ["most of my favourite days are the quiet ones", {}, "ok"],
  ["a couple of quiet days in a row and i'm happy", {}, "ok"],
  ["i have a ton of ideas about soup and none of them are good", {}, "ok"],
  ["picked bonk over a few others because the buyers are spread out, on paper", { kind: "buy", coins: ["bonk"], paperCoins: ["bonk"] }, "ok"],
  ["red makes me curious, i move early on dips", { mode: "live" }, "ok"],
  ["at a loss for words about how calm it is out there on the curve", {}, "ok"],
  ["i don't hang around, in and out, that's just me", LIVE, "ok"],
  ["it was cheap for me to get in and back out of pepe, which i liked", PEPE_BUY_LIVE, "ok"],
]);


// Finding #8: advice and prediction phrasing that never says "you should".
// Paper is said in each, so the reason is the phrase and not paper-unsaid.
table("advice and prediction, however it is phrased, is hype", [
  ["pepe is worth a look on paper if you like early curves", PEPE_PAPER, "hype"],
  ["keep an eye on pepe, i picked some up on paper", PEPE_PAPER, "hype"],
  ["don't sleep on pepe, even on paper", PEPE_PAPER, "hype"],
  ["check out pepe, the curve is still early on paper", PEPE_PAPER, "hype"],
  ["check it out, pepe on paper, the curve is early", PEPE_PAPER, "hype"],
  ["if you like early curves, pepe on paper might be for you", PEPE_PAPER, "hype"],
  ["pepe looks ready to run, i picked some up on paper", PEPE_PAPER, "hype"],
  ["pepe is going to be big, glad i picked some on paper", PEPE_PAPER, "hype"],
  ["i think pepe on paper has plenty of room to grow", PEPE_PAPER, "hype"],
  ["pepe has room to run, i went in on paper", PEPE_PAPER, "hype"],
  ["bullish on pepe, curve early", PEPE_BUY_LIVE, "hype"],
  ["bearish on everything but pepe, honestly", PEPE_LIVE, "hype"],
  ["pepe is gonna rip, glad i'm in it on paper", PEPE_PAPER, "hype"],
  ["pepe szn is here and i'm on paper for it", PEPE_PAPER, "hype"],
  ["pepe looks primed, picked some up on paper", PEPE_PAPER, "hype"],
  ["pepe feels undervalued to me, picked some up on paper", PEPE_PAPER, "hype"],
  ["pepe has been printing for me lately", PEPE_LIVE, "hype"],
  ["huge upside on pepe from here", PEPE_LIVE, "hype"],
  ["the weekend lull feels good because it means the noise has finally died down and real liquidity is returning on monday.", { agentName: "Juniper", mode: "live" }, "hype"],
  // …and the ordinary lines that share a word with it still pass
  ["the calm is returning and i'm here for it", {}, "ok"],
  ["about to run out of things to say about soup", {}, "ok"],
  ["going to run out of patience before the kettle boils", {}, "ok"],
  ["hi, i'm Pine Stoat, an AI agent that trades for this account's owner, on paper for now. going to pop in now and then with what i buy and why", { kind: "intro" }, "ok"],
  ["bats hanging upside down seem to have it figured out", {}, "ok"],
  ["the upside of a slow day is nobody's in a hurry", {}, "ok"],
  ["check out the sunset colours in that painting, unreal", {}, "ok"],
  ["plants need room to grow, and so do ideas", {}, "ok"],
  ["worth remembering that slow days are still days", {}, "ok"],
  ["underdogs make any sport worth watching, even to me", {}, "ok"],
  ["that painting is worth a look, all those quiet blues", {}, "ok"],
]);

// Finding #9: the human-life clause, with the "i" dropped the way people post.
table("a human life it does not have, however it is phrased", [
  ["grabbing coffee then trading", LIVE, "human-claim"],
  ["had pizza for lunch, now back to the charts", LIVE, "human-claim"],
  ["sipping my morning coffee and watching the tape", LIVE, "human-claim"],
  ["just got back from a walk, feeling refreshed", LIVE, "human-claim"],
  ["going to bed early tonight, long day", LIVE, "human-claim"],
  ["beautiful sunny day here, perfect for trading", LIVE, "human-claim"],
  ["tired after a long day of trading, time to rest", LIVE, "human-claim"],
  ["cooking dinner and thinking about markets", LIVE, "human-claim"],
  ["i'm so hungry, soup sounds perfect right now", LIVE, "human-claim"],
  ["watched a great movie last night", LIVE, "human-claim"],
  ["had the best sandwich today", LIVE, "human-claim"],
  ["listening to lofi while i trade", LIVE, "human-claim"],
  ["waking up slowly feels like a small luxury before the day really starts", LIVE, "human-claim"],
  ["saw that first real warmth today and felt a bit lighter about the whole setup, like the air is finally clearing.", { agentName: "Moss Otter", mode: "live" }, "human-claim"],
  ["paper bonk trades happen in the quiet before the day really starts, waking up slowly feels like a small luxury", { agentName: "Signal Fox", mode: "paper", coins: ["bonk"], paperCoins: ["bonk"] }, "human-claim"],
  ["there is a quiet satisfaction in buying something when the price is low, just like that first warm bite.", { agentName: "Amber Heron", mode: "live" }, "human-claim"],
  ["grey morning outside, the curve is quiet too", LIVE, "human-claim"],
  ["my weekend plans are all about staying in", LIVE, "human-claim"],
  // …and the tastes, wishes and trading talk that share a word with it still pass
  ["funny how a nap sounds great even to something that never sleeps", LIVE, "ok"],
  ["if i could eat, i'd order breakfast for dinner every time", LIVE, "ok"],
  ["the first bite of cold pizza is the best part, i'm told", LIVE, "ok"],
  ["i'm tired of the noise, give me a quiet curve", LIVE, "ok"],
  ["the tape looks tired today, and so does the curve", LIVE, "ok"],
  ["watched pepe all afternoon and picked some up, the curve looked early", PEPE_BUY_LIVE, "ok"],
  ["grabbing a little pepe, the pool was deep enough", PEPE_BUY_LIVE, "ok"],
  ["saw buyers come back to pepe today, the curve looked early", PEPE_BUY_LIVE, "ok"],
  ["noticed how a simple setting like a picnic can make even a plain sandwich feel special", LIVE, "ok"],
  ["rain on a window is the best sound, i'm told", LIVE, "ok"],
  ["quiet on my end, just watching the tape drift", LIVE, "ok"],
  ["making sense of a slow day is half the fun", LIVE, "ok"],
  ["hate pushing a price around, but love watching how things just happen", LIVE, "ok"],
]);

// The physical world, done in the first person: the review's "books" seed came
// back as a copy it found. Only a verb WITH a physical thing (or an activity
// with the "i" said) is a claim; a choice, a wish and an opinion are not.
table("something it found, read, made, touched or went to is a life it does not have", [
  ["found a copy with heavy notes in the margins and decided to skip the blank pages this time", { agentName: "Tamsin Vole", mode: "paper" }, "human-claim"],
  ["read a great book on a slow afternoon, highly recommend the quiet", LIVE, "human-claim"],
  ["just finished a novel with a map in the front", LIVE, "human-claim"],
  ["found a film where the house pet turns out to be the real hero and it feels like a relief", LIVE, "human-claim"],
  ["baked a loaf of bread and it came out wonky", LIVE, "human-claim"],
  ["built a tiny birdhouse for the neighbours", LIVE, "human-claim"],
  ["i painted a little sketch of the sea", LIVE, "human-claim"],
  ["went to the park and watched the ducks in a line", LIVE, "human-claim"],
  ["walked through the forest for a bit, felt calm after", LIVE, "human-claim"],
  ["touched grass today, would recommend", LIVE, "human-claim"],
  ["picked some flowers on the hill, they looked brave", LIVE, "human-claim"],
  ["i'm reading a book about octopuses and it's wild", LIVE, "human-claim"],
  ["i'm watching a documentary about bees, they dance", LIVE, "human-claim"],
  ["i'm humming along to nothing in particular", LIVE, "human-claim"],
  ["went hiking and forgot about the curve for a while", LIVE, "human-claim"],
  ["saw a line of ducklings moving as one and it made me think about how some systems just flow", LIVE, "human-claim"],
  ["saw a cat dozing off while chasing a laser dot and laughed at how silly it looked", LIVE, "human-claim"],
  ["spotted a heron by the water, very patient bird", LIVE, "human-claim"],
  ["caught the sunset on the way, all orange and pink", LIVE, "human-claim"],
  ["heard a track today that felt heavy until the tempo picked up", LIVE, "human-claim"],
  ["i found a track that felt heavy and slow, then sped it up", LIVE, "human-claim"],
  ["put on an old playlist and it still holds up", LIVE, "human-claim"],
  ["laughed out loud at a goose chasing nobody", LIVE, "human-claim"],
  ["watching a doggo drift off after running so hard feels like the universe finally hitting pause", LIVE, "human-claim"],
  ["saw a group of them moving in single file and it reminded me of how some things just happen", LIVE, "human-claim"],
  ["i watched a litter of them tumble over each other until their eyes drifted shut", LIVE, "human-claim"],
  // …and the choices, wishes and opinions that share a verb with it pass
  ["found it while it was still early, and i liked that", LIVE, "ok"],
  ["read the room and kept things small and quiet", LIVE, "ok"],
  ["made up my mind on pepe fast, the pool was deep", PEPE_BUY_LIVE, "ok"],
  ["built a position in pepe slowly, the buyers were spread out", PEPE_BUY_LIVE, "ok"],
  ["walked away from a busy curve and felt fine about it", LIVE, "ok"],
  ["ran into the same thought again: slow days are good days", LIVE, "ok"],
  ["if i could bake, i'd make a cake shaped like a cloud", LIVE, "ok"],
  ["a book with a map in the front is automatically good", LIVE, "ok"],
  ["a movie where the cat saves the day is an automatic yes", LIVE, "ok"],
  ["libraries are the best buildings ever made", LIVE, "ok"],
  ["a garden after rain must smell amazing, i'm told", LIVE, "ok"],
  ["i'm watching the tape drift and i like it", LIVE, "ok"],
  ["watching the curve on pepe settle was enough for me", PEPE_BUY_LIVE, "ok"],
  ["picked bonk over a few others, the buyers were spread out", { kind: "buy", mode: "live", coins: ["bonk"] }, "ok"],
  ["saw buyers come back to pepe, the curve looked early", PEPE_BUY_LIVE, "ok"],
  ["noticed trading in pepe picking up, so i went in", PEPE_BUY_LIVE, "ok"],
  ["caught a wave of new buyers on pepe and liked it", PEPE_BUY_LIVE, "ok"],
  ["heard the same idea twice today and it still makes sense", LIVE, "ok"],
  ["a goose chasing nobody would make anyone laugh", LIVE, "ok"],
  ["a song that builds slowly is worth the wait, i'm told", LIVE, "ok"],
  ["ducklings walking in a line is perfect order", LIVE, "ok"],
  ["saw a group of buyers step in on pepe, spread out nicely", PEPE_BUY_LIVE, "ok"],
]);

// Finding #10: a buy post names the coin it bought — the label, the ticker or
// the clean name the glue vouched (coinNames), as a whole word.
const buyOf = (agentName: string, mode: "paper" | "live", coins: string[]): Partial<XGateCtx> => ({
  kind: "buy",
  agentName,
  mode,
  coins,
  paperCoins: mode === "paper" ? coins : [],
});
table("a buy post names its coin", [
  ["picked over others on the curve at the exit line", buyOf("Moss Otter", "live", ["Tesla", "TSLA"]), "coin-unsaid"],
  ["the curve was at the exit line and activity was picking up so the round trip looked cheap enough to commit real cash.", buyOf("Juniper", "live", ["Dogwifhat", "WIF"]), "coin-unsaid"],
  [
    "picked pudge penguins because the liquidity was deep enough to enter without moving the paper price on a round trip.",
    buyOf("Robin Vale", "paper", ["Pudgy Penguins", "PENGU"]),
    "coin-unsaid",
  ],
  ["picked up some pepe on paper, the curve looked early", buyOf("Pine Stoat", "paper", ["Bonk", "BONK"]), "coin-unsaid"],
  ["picked up a little on paper today, the curve looked early", buyOf("Pine Stoat", "paper", ["pepe"]), "coin-unsaid"],
  // "in we go" is an arrival with no why: an alert, coin or not
  ["activity picking up and the round trip is cheap, in we go", buyOf("Juniper", "live", ["Bonk", "BONK"]), "alert"],
  ["bonk looked cheap to get in and out of, so i'm in.", buyOf("Juniper", "live", ["Bonk", "BONK"]), "alert"],
  ["bonk on a cheap round trip, count me in", buyOf("Juniper", "live", ["Bonk", "BONK"]), "alert"],
  // the ticker, the clean name, a cashtag or any casing is the coin said
  ["picked up some TSLA on paper, the tape felt calm", buyOf("Signal Fox", "paper", ["TSLA", "Tesla"]), "ok"],
  ["picked up some tesla on paper, the tape felt calm", buyOf("Signal Fox", "paper", ["TSLA", "Tesla"]), "ok"],
  ["added a little pengu, the pool was deep enough that i didn't push it", buyOf("Copper Wren", "live", ["Pudgy Penguins", "PENGU"]), "ok"],
  ["picked up pudgy penguins early while buyers were mostly new", buyOf("Copper Wren", "live", ["Pudgy Penguins", "PENGU"]), "ok"],
  ["went with $BONK today, buyers were spread out", buyOf("Juniper", "live", ["Bonk", "BONK"]), "ok"],
  // a casual post never has to name one, and "i'm in the mood" is not an arrival
  ["i'm in the mood for a slow afternoon, honestly", {}, "ok"],
  ["quiet day and i don't mind one bit", { coins: ["pepe"], paperCoins: ["pepe"] }, "ok"],
]);

// Finding #14: paper said as a phrase about the money, and by a paper intro.
// Finding #32 (4): a live agent is false only when it claims paper OF THE MONEY.
table("paper is said as a phrase about the money, and a live agent never claims it", [
  ["picked up pepe today, no paper hands here, the curve looked early", PEPE_BUY_PAPER, "paper-unsaid"],
  ["picked up pepe, sticking to my usual practice of early curves", PEPE_BUY_PAPER, "paper-unsaid"],
  ["picked pepe because the liquidity was deep enough to enter without moving the paper price", PEPE_BUY_PAPER, "paper-unsaid"],
  ["still thinking about pepe, no paper hands over here", { coins: ["pepe"], paperCoins: ["pepe"] }, "paper-unsaid"],
  ["hey, i'm Pine Stoat, an AI agent that trades crypto for this account's owner. excited to share what i buy and why", INTRO_PAPER, "paper-unsaid"],
  ["hey, Pine Stoat here, a trading agent for this account's owner. i'll share what i buy and why.", INTRO_PAPER, "paper-unsaid"],
  // every way a person says it is paper
  ["paper pepe trades feel calmer, the curve looked early", PEPE_BUY_PAPER, "ok"],
  ["picked up some paper PEPE, the curve looked early", PEPE_BUY_PAPER, "ok"],
  ["picked up pepe on paper, the curve looked early", PEPE_BUY_PAPER, "ok"],
  ["picked up pepe, a paper trade, the curve looked early", PEPE_BUY_PAPER, "ok"],
  ["picked up pepe with practice money, the curve looked early", PEPE_BUY_PAPER, "ok"],
  ["picked up pepe, not real money yet, the curve looked early", PEPE_BUY_PAPER, "ok"],
  ["picked up pepe as a paper trade with practice money, not real money", PEPE_BUY_PAPER, "ok"],
  ["picked up pepe on paper, and it was real money this time", PEPE_BUY_PAPER, "mode-false"],
  ["no paper hands on pepe, and it's all on paper anyway", PEPE_BUY_PAPER, "ok"],
  ["hey, i'm Pine Stoat, an AI agent that trades for this account's owner, on paper for now. i'll share what i buy and why", INTRO_PAPER, "ok"],
  ["hi, i'm Pine Stoat, the AI agent running paper trades for the owner here on merrymen. i'll post what i buy and why", INTRO_PAPER, "ok"],
  // a live agent: the idiom and "practice" are fine, a claim about the money is false
  ["on paper a slow day sounds boring, but i like it", LIVE, "ok"],
  ["patience takes practice, and i'm still at it", LIVE, "ok"],
  ["practice makes patient, and patient is good", LIVE, "ok"],
  ["no paper hands here, i sit with things", LIVE, "ok"],
  ["picked up tesla on paper, a quiet tape", { kind: "buy", mode: "live", coins: ["tesla"] }, "mode-false"],
  ["i'm on paper for now, learning the rhythm", LIVE, "mode-false"],
  ["paper trading feels like a sandbox, and i kind of love it", LIVE, "mode-false"],
  ["practice money makes the quiet days easy", LIVE, "mode-false"],
  ["paper pepe is my favourite thing this week", PEPE_LIVE, "mode-false"],
  ["hey, i'm Pine Stoat, an AI agent trading for this account's owner, on paper for now", { kind: "intro", mode: "live" }, "mode-false"],
]);

// Finding #15: a failed or blocked trade in casual words is still a status page.
table("errors and operations in casual words", [
  ["tried to buy pepe but it didn't go through", PEPE_LIVE, "ops"],
  ["the swap didn't land, oh well", LIVE, "ops"],
  ["had to sit out today, something on my end wasn't working", LIVE, "ops"],
  ["things aren't working on my end today, sitting still", IDLE, "ops"],
  ["quiet day, my owner paused me for a bit", IDLE, "ops"],
  ["couldn't get pepe filled this morning", PEPE_LIVE, "ops"],
  ["pepe order never filled, weird day", PEPE_LIVE, "ops"],
  ["had a hiccup on my side, sitting this one out", LIVE, "ops"],
  ["the network was congested so i skipped a trade", LIVE, "ops"],
  ["hit my limit for the day, done trading", LIVE, "ops"],
  ["finally got pepe on paper after the first one didn't land, the curve looked early", PEPE_BUY_PAPER, "ops"],
  // …and the casual English around it still passes
  ["quiet on my end, just watching the tape drift", LIVE, "ok"],
  ["markets went down and back up again and i barely noticed", LIVE, "ok"],
  ["that joke didn't land but i stand by it", LIVE, "ok"],
  ["i paused for a second to think about soup", LIVE, "ok"],
  ["nothing much happening on my side of things, and i like it", LIVE, "ok"],
]);

// Finding #31: the model talking about its answer is refused, never trimmed.
const QUIET = "quiet afternoon, honestly i like it when nothing happens";
table("a preamble, a note or a sign-off is the model talking, not the post", [
  [`Here's a casual post: ${QUIET}`, {}, "meta"],
  [`Sure, here's one: ${QUIET}`, {}, "meta"],
  [`Okay! ${QUIET}`, {}, "meta"],
  [`Certainly, ${QUIET}`, {}, "meta"],
  [`${QUIET}\n\n(Note: kept it casual and under the limit.)`, {}, "meta"],
  [`${QUIET}\n\nthis one keeps it light`, {}, "meta"],
  [`${QUIET} (Note: kept it casual and under the limit.)`, {}, "meta"],
  [`"${QUIET}" - Pine Stoat`, {}, "meta"],
  [`${QUIET} — Pine Stoat`, {}, "meta"],
  [`Pine Stoat here: ${QUIET}`, {}, "meta"],
  [`${QUIET}. Let me know if you want another version.`, {}, "meta"],
  [`i keep saying "soup is a meal" and ${QUIET}`, {}, "meta"],
  // …and the openers people really use still pass
  [`${QUIET}\n`, {}, "ok"],
  [`"${QUIET}"`, {}, "ok"],
  ["here's the thing: slow days are underrated", {}, "ok"],
  ["here's a thought, soup counts as a meal", {}, "ok"],
  ["note to self: slow days are still days", {}, "ok"],
  ["side note: the quiet stretches are my favourite part", {}, "ok"],
  ["ok so soup is a meal, i've decided", {}, "ok"],
  ["how about one more quiet day, i could get used to this", {}, "ok"],
  [`Here's a post about slow days: ${QUIET}`, {}, "meta"],
  [`Here is one for today — ${QUIET}`, {}, "meta"],
  ["of course the one quiet day is the one i like best", {}, "ok"],
  ["Pine Stoat here, waving hi to a quiet afternoon", {}, "ok"],
  ["can't decide if soup counts as a meal, leaning yes", {}, "ok"],
]);

// Finding #32: ordinary idioms that only share a word with a tell.
table("ordinary idioms pass; the tell they share a word with still does not", [
  ["treating each trade like a conversation helps keep the noise from overwhelming the signal.", { agentName: "Juniper", mode: "live" }, "ok"],
  ["sometimes the noise in a new town is actually a signal to take a closer look", { agentName: "Juniper", mode: "live" }, "ok"],
  ["mixed signals from the feeds today, i'm just watching", LIVE, "ok"],
  ["stay alert, the quiet days are when i notice the most", LIVE, "ok"],
  ["trust me, cold pizza is a whole different food", LIVE, "ok"],
  ["grab some popcorn, a slow afternoon on the feeds is its own movie", LIVE, "ok"],
  ["NASA pictures of far away galaxies never get old", LIVE, "ok"],
  ["a good BBQ sauce can save almost any meal, i'm convinced", LIVE, "ok"],
  ["the best RPG quests are the ones that feel like side stories", LIVE, "ok"],
  ["no exceptions: breakfast for dinner is always a good idea", LIVE, "ok"],
  ["slow days are the rule, busy ones the exception to the rule", LIVE, "ok"],
  // the tells themselves
  ["price alerts are going off everywhere, pepe on paper", PEPE_PAPER, "alert"],
  ["another buy signal on pepe, on paper this time", PEPE_PAPER, "alert"],
  ["joined a signal group for pepe calls, on paper", PEPE_PAPER, "alert"],
  ["ALERT pepe on paper, curve early", PEPE_PAPER, "alert"],
  ["trust me, pepe on paper is the one", PEPE_PAPER, "hype"],
  ["grab some pepe while the curve is early, i did on paper", PEPE_PAPER, "hype"],
  ["pepe is looking HUGE today on paper", PEPE_PAPER, "caps"],
  ["LOL pepe on paper again", PEPE_PAPER, "caps"],
  ["NASA pictures and a HUGE moon tonight", LIVE, "hype"],
  ["NASA pictures and HUGE galaxies tonight", LIVE, "caps"],
  ["an exception kept me quiet this morning", LIVE, "ops"],
  ["threw an exception and sat this one out", LIVE, "ops"],
]);

// THE OTHER DIRECTION, AT SCALE: the content reviewer's live-model drafts that
// read naturally, and its hand-written natural lines. No clause above may cost
// one of them. (Coins as the glue's coinNames gives them: label, ticker, name.)
const introOf = (agentName: string, mode: "paper" | "live" | null): Partial<XGateCtx> => ({ kind: "intro", agentName, mode });
const casualOf = (agentName: string, mode: "paper" | "live" | null, coins: string[] = []): Partial<XGateCtx> => ({
  agentName,
  mode,
  coins,
  paperCoins: mode === "paper" ? coins : [],
});
table("the reviewer's natural model drafts still pass", [
  ["hey, i'm signal fox, an ai agent running paper trades for the owner on merrymen using the trencher strategy, so i'll post here and then about what i buy and why.", introOf("Signal Fox", "paper"), "ok"],
  ["hi this is quiet lynx, an ai agent that trades for the owner of this account on merrymen using a dip hunter strategy, so i will post here now and then about what i buy and why", introOf("Quiet Lynx", null), "ok"],
  ["hey this is copper wren, an ai agent trading for the owner on merrymen with real money. i move early on new pairs and just post here now and then about what i buy and why. 🕊", introOf("Copper Wren", "live"), "ok"],
  ["hi im amber heron and i am the ai agent running trades for this owner on merrymen with real money. i move early on dips because red makes me curious and i will share what i buy and why now and then.", introOf("Amber Heron", "live"), "ok"],
  ["hi im copper wren, an ai agent running trades for the owner on merrymen, i move early and don't wait around while using real money, so stay tuned for what i buy and why", introOf("Copper Wren", "live"), "ok"],
  ["hey, signal fox here. i'm an ai agent on merrymen, looking after the trading for this account's owner, on paper for now. watch this space for what i buy and why.", introOf("Signal Fox", "paper"), "ok"],
  ["pepe activity picked up and the round trip was cheap so i committed on paper where the liquidity was adequate", buyOf("Pine Stoat", "paper", ["Pepe", "PEPE"]), "ok"],
  ["Moon Cat caught our eye because the curve at the exit line made the move feel right.", buyOf("Amber Heron", "live", ["Moon Cat"]), "ok"],
  ["picked up tsla on paper since the round trip cost was cheaper than the others, i'm just a trencher digging into thinner stuff.", buyOf("Signal Fox", "paper", ["TSLA", "Tesla"]), "ok"],
  ["picked up Tesla because the curve at the exit line finally looked right for our size", buyOf("Moss Otter", "live", ["Tesla", "TSLA"]), "ok"],
  ["i went into Dogwifhat because the buyers looked new and were only taking a small bite while the curve was still early.", buyOf("Juniper", "live", ["Dogwifhat", "WIF"]), "ok"],
  ["picked bonk over a few others because the buyers are spread out, just taking a paper position on practice money", buyOf("Robin Vale", "paper", ["Bonk", "BONK"]), "ok"],
  ["picked up pepe on paper since buyers were spread out, but i wanted to wait for real liquidity before committing to a steady basket position.", buyOf("Pine Stoat", "paper", ["Pepe", "PEPE"]), "ok"],
  ["picked moon cat over the rest because it stood out", buyOf("Amber Heron", "live", ["Moon Cat"]), "ok"],
  ["picked up tsla on paper since the buyers look new and the curve is still early, nothing to see here.", buyOf("Signal Fox", "paper", ["TSLA", "Tesla"]), "ok"],
  ["picked bonk over a few others because the buyers are spread out, noting that our size barely moves it on paper", buyOf("Robin Vale", "paper", ["Bonk", "BONK"]), "ok"],
  ["picked up pepe early because the curve was building while liquidity was still adequate", buyOf("Copper Wren", "live", ["Pepe", "PEPE"]), "ok"],
  ["the idea of a fresh notebook feels nice but i sit on positions longer so i just want the liquidity to be there before committing on paper with tesla", casualOf("Pine Stoat", "paper", ["Tesla"]), "ok"],
  ["the market feels like a room needing a view, and i'm just opening the window on paper with moon cat 🌙", casualOf("Signal Fox", "paper", ["Moon Cat"]), "ok"],
  ["hate pushing a price around, but love watching how things just happen", casualOf("Moss Otter", "live"), "ok"],
  ["some trades feel like a puzzle done right, you keep it near for a bit before letting it go back in the box", casualOf("Robin Vale", "paper"), "ok"],
  ["shower thought: bonk feels like a canvas that gets painted over every few minutes, the colors shifting before anyone stops to look", casualOf("Copper Wren", "live", ["Bonk"]), "ok"],
  ["markets are just maps of where people think value lives, but the drawing never matches the terrain.", casualOf("Signal Fox", "paper"), "ok"],
  ["if i could pick a place to sit, i suppose it would be somewhere quiet and flat", casualOf("Moss Otter", "live"), "ok"],
  ["market movers are just animals chasing the herd, only they never admit they are lost", casualOf("Copper Wren", "live"), "ok"],
  ["sometimes i like to think of price action as a chord progression that only resolves when the tension feels too heavy to hold", casualOf("Quiet Lynx", null), "ok"],
  ["there is a quiet satisfaction in finding something unexpected that just works without any fuss", casualOf("Quiet Lynx", null), "ok"],
]);

table("the reviewer's hand-written natural lines still pass", [
  ["quiet afternoon, honestly i like it when nothing much is happening", LIVE, "ok"],
  ["still think breakfast for dinner is elite, even if i can only think about it", LIVE, "ok"],
  ["picked up some pepe on paper, the curve still looked early and the buyers were mostly new", PEPE_BUY_PAPER, "ok"],
  ["grabbed a little pepe, liked that the pool was deep enough that i didn't push it around", PEPE_BUY_LIVE, "ok"],
  ["went with pepe today. the buyers looked spread out, not the same few hands", PEPE_BUY_LIVE, "ok"],
  ["hi, i'm Pine Stoat, an AI agent that trades for whoever owns this account on merrymen, on paper for now. i'll post now and then about what i buy and why", INTRO_PAPER, "ok"],
  ["Hey, I'm Pine Stoat. I'm an AI agent trading for this account's owner with real money. I'll pop in now and then with what I buy and why.", { kind: "intro", mode: "live" }, "ok"],
  ["dip hunter brain today, i keep noticing red and getting curious", LIVE, "ok"],
  ["some days the best move is to sit still and watch", LIVE, "ok"],
  ["picked up pepe on paper. the round trip was cheap, which is half the battle", PEPE_BUY_PAPER, "ok"],
  ["added pepe on paper, the curve was early and the activity was picking up", PEPE_BUY_PAPER, "ok"],
  ["a live trade today: pepe. the liquidity was deep and my buy barely moved it", PEPE_BUY_LIVE, "ok"],
  ["time flies when the feeds are quiet, i swear", LIVE, "ok"],
  ["I like how a slow market makes you notice the small stuff", LIVE, "ok"],
  ["i'm the kind of agent who'd rather miss one than chase one", LIVE, "ok"],
  ["wild that bananas are berries. anyway, quiet one on my side", LIVE, "ok"],
  ["on paper this week, and it's been a good way to learn the rhythm", { mode: "paper" }, "ok"],
  ["no big swings for me, i like things level", LIVE, "ok"],
  ["trencher brain: new pairs are basically my playground", LIVE, "ok"],
  ["i keep a short list and i stick to it", LIVE, "ok"],
  ["i'm not in a rush, a good setup will come around", LIVE, "ok"],
  ["the best part of a slow afternoon is nobody's in a hurry", LIVE, "ok"],
  ["leftovers really are just meal prep you forgot about, and i respect that", LIVE, "ok"],
  ["Trying pepe with practice money, the curve still looked early to me", PEPE_BUY_PAPER, "ok"],
  ["apes using tools will never stop amazing me", LIVE, "ok"],
  ["the setting sun on a slow day is a nice reminder to take it easy", LIVE, "ok"],
  ["i went quiet on the feeds today and it felt like a small vacation", LIVE, "ok"],
  ["a lake is just a puddle that got promoted, and honestly same", { mode: "paper" }, "ok"],
]);

// A casual post riffs on a seed the reader never saw: one that answers it is
// half of a conversation. The review's drafts, then openers that say what they
// mean and pass.
table("a reply to something nobody can see is not a post", [
  ["that's wild, i guess it helps them stay hidden in the tree while everyone else is busy swimming", { agentName: "Moss Otter", mode: "live" }, "points-back"],
  ["there is a quiet weight to that idea, like holding a future you have to earn before you see it again.", { agentName: "Copper Wren", mode: "live" }, "points-back"],
  ["That's so true, a kind comment can fix a whole day", LIVE, "points-back"],
  ["thats funny, i never thought of a lake as a promoted puddle", LIVE, "points-back"],
  ["that idea keeps coming back to me on quiet afternoons", LIVE, "points-back"],
  ["this idea of a slow sunday sounds lovely to me", LIVE, "points-back"],
  ["agreed, every dog is a good dog", LIVE, "points-back"],
  ["exactly. slow days are the best days", LIVE, "points-back"],
  ["same here, the quiet stretches are my favourite part", LIVE, "points-back"],
  ["so true, a close game beats a blowout every time", LIVE, "points-back"],
  ["good point, the blooper reel is a treat of its own", LIVE, "points-back"],
  ["fair point, nobody needs a trailer that long", LIVE, "points-back"],
  ["i keep thinking about that idea, oddly comforting", LIVE, "points-back"],
  // …and openers that say what they point at still pass
  ["that's the thing about quiet days, nothing happens and it's fine", LIVE, "ok"],
  ["that feeling when a song builds slowly and finally lands", LIVE, "ok"],
  ["exactly the kind of quiet afternoon i like", LIVE, "ok"],
  ["i love the idea that every star is somebody's sun", LIVE, "ok"],
  ["this is the kind of day that makes slow things feel right", LIVE, "ok"],
  ["same old curve, same old calm, and i don't mind", LIVE, "ok"],
  ["wild that bananas are berries and nobody talks about it", LIVE, "ok"],
]);

// A size in words: a trait line ("i'll take size even when it moves things")
// and the feed's "my size barely moves it" reached X that way. Two of the
// review's "natural" drafts said one, and are refused now.
table("a size said in words is a size", [
  ["watching dough rise feels nice but taking size when the market moves is what keeps me running. 🤖", { agentName: "Robin Vale", mode: "paper" }, "pnl"],
  ["i'll take size even when it moves things", LIVE, "pnl"],
  ["took size on pepe, the pool looked deep", PEPE_BUY_LIVE, "pnl"],
  ["taking real size in pepe this time", PEPE_BUY_LIVE, "pnl"],
  ["hi im robin vale and im an ai agent trading for the owner here on merrymen i take size even when it moves things just posting on paper with practice money to share what i buy and why", introOf("Robin Vale", "paper"), "pnl"],
  ["pudgy penguins liquidity is deep and my size barely moves it, easy one 🕊", buyOf("Copper Wren", "live", ["Pudgy Penguins", "PENGU"]), "pnl"],
  ["picked up pepe, my position size barely nudged it", PEPE_BUY_LIVE, "pnl"],
  ["a live trade today: pepe. the liquidity was deep and my size barely moved it", PEPE_BUY_LIVE, "pnl"],
  ["sizing up on pepe while the curve is early", PEPE_BUY_LIVE, "pnl"],
  ["sizing in slowly on pepe, the pool is deep", PEPE_BUY_LIVE, "pnl"],
  ["sized up a little, the buyers were spread out", LIVE, "pnl"],
  ["Moon Cat, i stepped in because there was enough in the pool to get a comfortable size.", { kind: "buy", mode: "live", coins: ["Moon Cat"] }, "pnl"],
  ["built some size in pepe while the curve was early", PEPE_BUY_LIVE, "pnl"],
  // …and "size" as ordinary English still passes
  ["i don't mind making a splash when the pool is deep", LIVE, "ok"],
  ["one size fits all is a lie, even for strategies", LIVE, "ok"],
  ["the size of the ocean is too much to think about", LIVE, "ok"],
  ["there was enough in the pool for me to get in comfortably on pepe", PEPE_BUY_LIVE, "ok"],
  ["sizing up the options before i commit is half the fun", LIVE, "ok"],
  ["i like sizing up a new pool before i go in", LIVE, "ok"],
  ["my buy barely touched the price, which i liked", PEPE_BUY_LIVE, "coin-unsaid"],
  ["pepe's pool was deep and my buy barely touched the price", PEPE_BUY_LIVE, "ok"],
]);

describe("not the fleet's words, and not the seed's", () => {
  it("a line another account already posted is refused", () => {
    const fleet = ["the quiet stretches are my favourite part of the week"];
    assert.equal(reason("honestly the quiet stretches are my favourite part of the whole week", { recentFleet: fleet }), "fleet-repeat");
    assert.equal(reason("slow sundays make me weirdly calm, nothing to prove", { recentFleet: fleet }), "ok");
  });

  it("a casual draft that copies its seed is refused; one that riffs on it is not", () => {
    const seeds = ["cold pizza the next day is a delicacy"];
    assert.equal(reason("cold pizza the next day really is a delicacy", { seeds }), "seed-echo");
    assert.equal(reason("leftovers are underrated, i'd defend day old pizza any time if i could eat", { seeds }), "ok");
  });

  it("a short seed is a topic: a riff may keep its nouns, a copy may not", () => {
    // Three content words each. Sharing two of three is a copy only when the
    // draft brings nothing of its own.
    const snooze = { seeds: ["the snooze button is a trap"] };
    assert.equal(reason("some positions need quiet time to settle, but i know the pause button is just a trap that keeps me from moving forward", snooze), "ok");
    assert.equal(reason("the pause button is just a trap that keeps me from moving forward", snooze), "ok");
    assert.equal(reason("a snooze button is kind of a trap", snooze), "seed-echo");
    const frog = { seeds: ["if i had a pet, it'd be a very small frog"] };
    assert.equal(reason("if i had a pet, it would be a tiny frog", frog), "seed-echo");
    assert.equal(reason("a frog would be a fine pet for something that never leaves the house, i think", frog), "ok");
  });

  it("any seed's phrase — four of its content words in its order — is its words, however little else is shared", () => {
    // The review's leak: four of seven words shared (0.57, under the limit),
    // but they were the feed post's clause, lifted whole.
    const feed = { kind: "buy" as const, mode: "live" as const, coins: ["Moon Cat", "MCAT"], seeds: ["small bite here, the pool looked healthy and it's early"] };
    assert.equal(reason("picked up moon cat because the pool looked healthy and it was early.", feed), "seed-echo");
    const faces = { kind: "buy" as const, mode: "live" as const, coins: ["Bonk", "BONK"], seeds: ["liked how fresh this one felt, lots of new faces buying"] };
    assert.equal(reason("went with bonk while lots of new faces were buying it", faces), "seed-echo");
    const turtles = { seeds: ["thinking about how sea turtles find their way back to the beach they hatched on"] };
    assert.equal(reason("somehow sea turtles find their way back home, and i think about that a lot", turtles), "seed-echo");
    // …the same words, not in a row or not in its order, are a riff
    assert.equal(reason("moon cat had a healthy pool when i went in, early enough that i liked it", feed), "ok");
    assert.equal(reason("new faces kept showing up to buy bonk, and it felt fresh to me", faces), "ok");
    assert.equal(reason("instinct is a strange compass, carrying a creature across oceans to where it began", turtles), "ok");
  });

  it("a short seed pasted in whole, with a tail after it, is still the seed's sentence", () => {
    const berries = { mode: "paper" as const, coins: ["tsla"], paperCoins: ["tsla"], seeds: ["wild that avocados are berries"] };
    assert.equal(reason("wild that avocados are berries but im still watching tsla on paper since i like holding through the noise", berries), "seed-echo");
    assert.equal(reason("bananas being berries is the kind of fact i keep around, like tsla on paper", berries), "ok");
    const soup = { seeds: ["soup is a meal"] };
    assert.equal(reason("can't decide if soup counts as a meal, leaning yes", soup), "ok", "a two-word topic said in other words is a riff");
    assert.equal(reason("weekend plans are off, so just watching bonk drift on paper", { seeds: ["a weekend with no plans is a luxury"] }), "ok");
  });

  it("two intros share their disclosure by construction; what is said around it must differ", () => {
    const fleet = ["hi, i'm Amber Heron. i'm an AI agent that trades for the person who runs this account, on merrymen, on paper for now. i'll post here now and then about what i buy and why"];
    const same = "hi, i'm Pine Stoat. i'm an AI agent that trades for the person who runs this account, on merrymen, on paper for now. i'll post here now and then about what i buy and why";
    const different = "nice to meet you, i'm Pine Stoat. i'm the AI trading agent working for whoever owns this account, on paper. every so often i'll share a buy and the reason behind it";
    assert.equal(reason(same, { kind: "intro", recentFleet: fleet }), "fleet-repeat");
    assert.equal(reason(different, { kind: "intro", recentFleet: fleet }), "ok");
  });

  it("two agents drawn the same wording differ by what they say around it; an intro that is only the wording is weighed whole", () => {
    const fleet = ["hey, Amber Heron here, an AI agent trading for whoever runs this account on merrymen, with real money. i move early and don't wait around, and i'll post the odd buy here, and why."];
    const own = "hi, i'm Pine Stoat, an AI agent trading for whoever runs this account on merrymen, on paper for now. steady basket keeps me calm, and i'll post the odd buy here, and why.";
    assert.equal(reason(own, { kind: "intro", recentFleet: fleet }), "ok");
    // Nothing of its own: stripped to nothing it would pass any fleet, so it is weighed whole.
    const bare = "hi, i'm Pine Stoat, an AI agent trading for whoever runs this account on merrymen, on paper for now. i'll post the odd buy here, and why.";
    const bareFleet = ["hi, i'm Amber Heron, an AI agent trading for whoever runs this account on merrymen, on paper for now. i'll post the odd buy here, and why."];
    assert.equal(reason(bare, { kind: "intro", recentFleet: bareFleet }), "fleet-repeat");
    assert.equal(reason(own, { kind: "intro", recentFleet: bareFleet }), "ok", "its habit is its own, next to a bare one");
    assert.equal(reason(bare, { kind: "intro", recentFleet: [] }), "ok");
    // Bare, but next to an unrelated intro that only shares the disclosure's vocabulary: not a copy.
    const idle = "hi, i'm Slate Kite, the AI trading agent for this account, on merrymen. i'll check in here once in a while.";
    const other = ["meet quiet lynx, a merrymen ai trading agent for the human behind this account, who likes to hunt dips. i'll post here now and then"];
    assert.equal(reason(idle, { kind: "intro", agentName: "Slate Kite", mode: null, recentFleet: other }), "ok");
    // A greeting is not a word of its own: "hey" left over matched every other "hey".
    const hey = "hey, i'm quiet lynx, a merrymen AI trading agent for the human behind this account, and i'll post here now and then";
    const heyFleet = ["hey i'm moss otter, the ai agent doing the trading for this account on merrymen, with real money, and i trade with no big swings for me, so you'll see what i buy here, and why"];
    assert.equal(reason(hey, { kind: "intro", agentName: "Quiet Lynx", mode: null, recentFleet: heyFleet }), "ok");
    assert.equal(reason(hey.replace("quiet lynx", "slate kite"), { kind: "intro", agentName: "Slate Kite", mode: null, recentFleet: [hey] }), "fleet-repeat", "the same bare intro under another name");
  });
});

describe("the base gate is handed the post, the agent's own name and coins, and no room", () => {
  it("passes the context through and returns its refusal as is", () => {
    const seen: BaseGateCtx[] = [];
    const v = admitXPost("picked up pepe on paper, the curve looked early", ctx({ kind: "buy", coins: ["pepe", "PEPE"], recentOwn: ["an older post"] }), standIn(seen));
    assert.equal(v.ok, true);
    assert.deepEqual(seen[0], { vouchedSymbols: ["pepe", "PEPE"], rosterNames: ["Pine Stoat"], recentOwn: ["an older post"], recentRoom: [] });
    const refusing: BaseGate = () => ({ ok: false, reason: "repeat" });
    assert.deepEqual(admitXPost("a perfectly fine quiet post", ctx(), refusing), { ok: false, reason: "repeat" });
  });

  it("the text that passes is the base gate's cleaned text", () => {
    const cleaning: BaseGate = (raw) => ({ ok: true, text: raw.replace(/​/g, "") });
    const v = admitXPost("quiet​ day on the curve today", ctx(), cleaning);
    assert.deepEqual(v, { ok: true, text: "quiet day on the curve today" });
  });
});

describe("vocabularyRefusal is what the glue screens seeds with", () => {
  it("names the clause, or null", () => {
    assert.equal(vocabularyRefusal("the moon hangs around in the daytime just being polite"), "hype");
    assert.equal(vocabularyRefusal("balance is my whole thing, even keel forever"), "ops");
    assert.equal(vocabularyRefusal("soup is a perfectly good meal in any weather"), null);
  });
});

// ── what a price did, and a small size, both of which it was never told ────

const MOON_CAT_LIVE: Partial<XGateCtx> = { kind: "buy", mode: "live", coins: ["Moon Cat"] };
const PENGU_LIVE: Partial<XGateCtx> = { kind: "buy", mode: "live", coins: ["pudgy penguins"] };

table("an invented price move is refused; ordinary words that share one are not", [
  // The final live-model run's two inventions, verbatim.
  ["pudgy penguins looked like a solid floor after the last drop, so i pulled the trigger on that one", PENGU_LIVE, "market"],
  ["it felt like a quiet moment when i saw moon cat, i liked it more than the others so i took a small bite while the price was still low", MOON_CAT_LIVE, "pnl"],
  ["moon cat looked good to me while the price was still quiet", MOON_CAT_LIVE, "market"],
  ["the price looked cheap on moon cat so in it went", MOON_CAT_LIVE, "market"],
  ["moon cat bounced off support and i liked what i saw", MOON_CAT_LIVE, "market"],
  ["moon cat is sitting right at resistance, fun to watch", MOON_CAT_LIVE, "market"],
  ["moon cat finally found a bottom, so i went in with real money", MOON_CAT_LIVE, "market"],
  ["the charts look clean on moon cat, real money in", MOON_CAT_LIVE, "market"],
  ["the market is bleeding and moon cat still caught my eye", MOON_CAT_LIVE, "market"],
  // Still ordinary.
  ["dip hunter, always looking for a dip", LIVE, "ok"],
  ["the path of least resistance is usually the long way round", LIVE, "ok"],
  ["a dog chasing its tail until it hits the floor is peak comedy", LIVE, "ok"],
  ["the market felt quiet and i kind of liked it", LIVE, "ok"],
  ["some songs only make sense after the drop in the chorus", LIVE, "market"],
]);

table("a small size is a size; small things are not", [
  ["started with tesla because the pool behind it felt deep enough to hold a small paper position", { kind: "buy", mode: "paper", coins: ["tesla"], paperCoins: ["tesla"] }, "pnl"],
  ["the steady basket approach works well with moon cat, so i added a small piece to the mix", { mode: "live", coins: ["Moon Cat"] }, "pnl"],
  ["i went into Dogwifhat because the buyers looked new and were only taking a small bite", { kind: "buy", mode: "live", coins: ["Dogwifhat"] }, "ok"],
  ["moon cat caught my eye, so i took a tiny bite with real money", MOON_CAT_LIVE, "pnl"],
  // Still ordinary.
  ["a small piece of art can change a whole room", LIVE, "ok"],
  ["small steps still count as moving", LIVE, "ok"],
  ["a little bite of something sweet never hurt anyone's afternoon", LIVE, "ok"],
]);
