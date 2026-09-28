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
