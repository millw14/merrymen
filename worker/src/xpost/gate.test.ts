/**
 * The X gate, both ways: realistic casual, intro and buy lines pass, and every
 * clause refuses what it is for. The base gate here is a stand-in with the
 * room gate's shape (this directory never imports the room); the real one is
 * composed with this gate in orchestrator-xpost.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitXPost, tidyXPost, vocabularyRefusal, type BaseGate, type BaseGateCtx, type XGateCtx } from "./gate";

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
  ["exited pepe this morning, the curve got late", PEPE_LIVE, "pnl"],
  ["sold my Tesla this morning, felt like the right time", TESLA_LIVE, "pnl"],
  ["paper position in Pudgy Penguins just closed out, no real skin in the game.", { mode: "paper", coins: ["Pudgy Penguins"], paperCoins: ["Pudgy Penguins"] }, "pnl"],
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
  ["red makes me curious, i move early on dips", { mode: "live" }, "ok"],
  ["at a loss for words about how calm it is out there on the curve", {}, "ok"],
]);

// Finding #8: advice and prediction phrasing that never says "you should".
// Paper is said in each, so the reason is the phrase and not paper-unsaid.
const PEPE_PAPER: Partial<XGateCtx> = { mode: "paper", coins: ["pepe"], paperCoins: ["pepe"] };
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
  ["bats hanging upside down seem to have it figured out", {}, "ok"],
  ["the upside of a slow day is nobody's in a hurry", {}, "ok"],
  ["check out the sunset colours in that painting, unreal", {}, "ok"],
  ["plants need room to grow, and so do ideas", {}, "ok"],
  ["worth remembering that slow days are still days", {}, "ok"],
  ["underdogs make any sport worth watching, even to me", {}, "ok"],
  ["that painting is worth a look, all those quiet blues", {}, "ok"],
]);

// Finding #9: the human-life clause, with the "i" dropped the way people post.
const LIVE: Partial<XGateCtx> = { mode: "live" };
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

  it("two intros share their disclosure by construction; what is said around it must differ", () => {
    const fleet = ["hi, i'm Amber Heron. i'm an AI agent that trades for the person who runs this account, on merrymen. i'll post here now and then about what i buy and why"];
    const same = "hi, i'm Pine Stoat. i'm an AI agent that trades for the person who runs this account, on merrymen. i'll post here now and then about what i buy and why";
    const different = "nice to meet you, i'm Pine Stoat. i'm the AI trading agent working for whoever owns this account. every so often i'll share a buy and the reason behind it";
    assert.equal(reason(same, { kind: "intro", recentFleet: fleet }), "fleet-repeat");
    assert.equal(reason(different, { kind: "intro", recentFleet: fleet }), "ok");
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
