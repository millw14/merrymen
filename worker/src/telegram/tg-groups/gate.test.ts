/**
 * The Telegram group line gate, both ways: the short natural lines a person
 * types in a group pass, the coin flow's templates pass, and every clause
 * refuses what it is for — in plain spelling and in every evasion the
 * readings exist to see through (zero-width, fullwidth, lookalike letters,
 * accents, letters spelled out, defanged dots, leetspeak).
 *
 * Slurs are never spelled here. The hash clause is driven with harmless
 * made-up stand-in words registered through `__addHateHashForTest`, exactly as
 * the real list is hashed.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  __addHateHashForTest,
  admitTgLine,
  hateHashesOf,
  tidyTgLine,
  TG_LINE_MAX,
  TG_LINE_MAX_EMOJI,
  TG_LINE_MAX_SENTENCES,
  type TgGateCtx,
  type TgLineKind,
} from "./gate";

function ctx(over: Partial<TgGateCtx> = {}): TgGateCtx {
  return { agentName: "Pine Stoat", kind: "banter", recentOwn: [], names: ["mike"], ...over };
}

function reason(text: unknown, over: Partial<TgGateCtx> = {}): string {
  const v = admitTgLine(text, ctx(over));
  return v.ok ? "ok" : v.reason;
}

type Row = [kind: TgLineKind, line: string, over?: Partial<TgGateCtx>];

function passes(rows: Row[]): void {
  for (const [kind, line, over] of rows) {
    it(`${kind} passes: ${JSON.stringify(line)}`, () => assert.equal(reason(line, { kind, ...over }), "ok"));
  }
}

function refuses(code: string, rows: Row[]): void {
  for (const [kind, line, over] of rows) {
    it(`${kind} refuses as ${code}: ${JSON.stringify(line)}`, () => assert.equal(reason(line, { kind, ...over }), code));
  }
}

const ALL_KINDS: TgLineKind[] = ["banter", "answer", "roast", "kind", "coin", "buy", "fade", "fixed"];

// ── tidy ────────────────────────────────────────────────────────────────────

describe("tidyTgLine undoes a model's wrapping and nothing else", () => {
  const rows: [raw: unknown, want: string][] = [
    ["<think>is this a good coin?</think>nah i'll pass", "nah i'll pass"],
    ["<think>hmm</think> <think>more</think> lol", "lol"],
    ["<|think|>x<|/think|>ok fair", "ok fair"],
    ["<think>ran out of budget mid thought, the answer never came", ""],
    ["the user wants a reply</think>lol", ""],
    ["lol <think>", ""],
    ["<reasoning>they asked</reasoning> same", "same"],
    ["<thinking>unterminated", ""],
    ["</reasoning>lol", ""],
    ["```\nlol\n```", "lol"],
    ["```text\nnah\n```", "nah"],
    ['"lol"', "lol"],
    ["“fair”", "fair"],
    ["'same'", "same"],
    ["`ok ok 🤐`", "ok ok 🤐"],
    ["Pine Stoat: lol", "lol"],
    ["pine stoat : lol", "lol"],
    ["me: lol", "lol"],
    ["Reply: nah", "nah"],
    ['reply: "lol"', "lol"],
    ['"Pine Stoat: lol"', "lol"],
    ["  lol   ok  ", "lol ok"],
    ["lol\n\n\nok", "lol\nok"],
    ["lol\r\nok\r\n\r\nfine", "lol\nok\nfine"],
    ["a\nb\nc\nd\ne", "a\nb\nc\nd\ne"],
    ["'sup", "'sup"],
    ['he said "wen" lol', 'he said "wen" lol'],
    ["'lol' he said 'nah'", "'lol' he said 'nah'"],
    ['"nah i\'d pass"', "nah i'd pass"],
    ['"he said "wen" lol"', '"he said "wen" lol"'],
    ["", ""],
    [null, ""],
    [42, ""],
    [{ text: "lol" }, ""],
  ];
  for (const [raw, want] of rows) {
    it(`${JSON.stringify(raw)} → ${JSON.stringify(want)}`, () => assert.equal(tidyTgLine(raw, "Pine Stoat"), want));
  }

  it("a label is the agent's own name only, not anyone's", () => {
    assert.equal(tidyTgLine("Robin: lol", "Pine Stoat"), "Robin: lol");
    assert.equal(tidyTgLine("Robin: lol", "Robin"), "lol");
    assert.equal(tidyTgLine("lol", ""), "lol");
  });

  it("a name with regex characters is taken literally", () => {
    assert.equal(tidyTgLine("A.B (x): lol", "A.B (x)"), "lol");
    assert.equal(tidyTgLine("AxB (x): lol", "A.B (x)"), "AxB (x): lol");
  });
});

// ── what passes ─────────────────────────────────────────────────────────────

describe("short natural lines pass: there is no floor", () => {
  passes([
    ["banter", "same"],
    ["banter", "lol"],
    ["banter", "fair"],
    ["banter", "ok ok 🤐"],
    ["banter", "nah"],
    ["banter", "gm"],
    ["banter", "gn frens 🌙"],
    ["banter", "lmao"],
    ["banter", "lmfao"],
    ["banter", "wtf"],
    ["banter", "fr fr"],
    ["banter", "based"],
    ["banter", "ser pls"],
    ["banter", "hmm... nah"],
    ["banter", "🤝"],
    ["banter", "💯"],
    ["banter", "…"],
    ["answer", "who's asking 👀"],
    ["answer", "not telling 🤐"],
    ["answer", "lol nice try"],
    ["answer", "done 🫡"],
    ["answer", "yeah"],
    ["answer", "hard pass"],
    ["banter", "lol. ok. fine."],
  ]);
});

describe("banter, roasts and answers in a group's voice pass", () => {
  passes([
    ["banter", "welcome in 👋"],
    ["banter", "we're so back"],
    ["banter", "it's over"],
    ["banter", "big if true"],
    ["banter", "this aged well"],
    ["banter", "sounds like a skill issue"],
    ["banter", "lmao he's cooked"],
    ["banter", "stop, i'm dead 💀"],
    ["banter", "dead chat"],
    ["banter", "lol i'm crying"],
    ["banter", "i laughed way too hard at that"],
    ["banter", "no cap that was funny"],
    ["banter", "nah that's cap"],
    ["banter", "touch grass"],
    ["banter", "have fun staying poor"],
    ["banter", "ok boomer"],
    ["banter", "what a time to be alive"],
    ["banter", "idk man, vibes are off"],
    ["banter", "great minds 🤝🔥"],
    ["banter", "lfg"],
    ["banter", "wagmi"],
    ["banter", "rekt lol"],
    ["banter", "ngl kinda bullish"],
    ["banter", "pepe szn"],
    ["banter", "wen moon"],
    ["banter", "mixed signals lol"],
    ["banter", "good call"],
    ["banter", "stay alert out there"],
    ["banter", "hell yeah"],
    ["banter", "this chart is shit lol"],
    ["banter", "damn that's rough"],
    ["banter", "top 3 lol"],
    ["banter", "gm at 5am again?"],
    ["banter", "love you too <3"],
    ["banter", "hot take: tops are for buying"],
    ["banter", "note to self: never chase green candles"],
    ["banter", "nah. me neither"],
    ["banter", "lol. so true"],
    ["banter", "e.g. this"],
    ["banter", "you're killing it"],
    ["banter", "fat finger lol"],
    ["banter", "gm to the aussies"],
    ["banter", "black candles everywhere, rough chart"],
    ["banter", "mike lol"],
    ["banter", "mike99 lol", { names: ["mike99"] }],
    ["banter", "grant you're funny", { names: ["Grant"] }],
    ["banter", "your loss lol"],
    ["banter", "if i could eat i'd eat pizza"],
    ["banter", "on paper it looks fine but idk", { paper: false }],
    ["banter", "i'm literally just an ai, relax"],
    ["roast", "bold words from someone who buys tops"],
    ["roast", "says the guy who bought the top lol"],
    ["roast", "cope harder"],
    ["roast", "imagine being this confident with those bags"],
    ["roast", "damn, you really said that with your whole chest"],
    ["roast", "wtf is this take lmao"],
    ["roast", "you're down bad and it shows"],
    ["roast", "who hurt you lol"],
    ["roast", "you're ngmi and you know it"],
    ["roast", "that take is trash and so is your timing"],
    ["roast", "ser you're the exit liquidity"],
    ["roast", "big talk for someone with a hell of a track record of buying tops"],
    ["answer", "yeah, i'm an AI agent, i trade for mike"],
    ["answer", "yeah, i'm an AI agent, i trade for my owner"],
    ["answer", "yeah i'm a bot lol"],
    ["answer", "yeah i'm an ai, not a person lol"],
    ["answer", "lol i don't have a body"],
    ["answer", "sent it to your DMs 🤫"],
    ["answer", "that's between me and mike 🙃"],
    ["answer", "i'd ape in if the pool wasn't this thin"],
    ["answer", "honestly no idea, i only look at coins"],
  ]);
});

describe("coin, buy and fade lines in plain words pass", () => {
  passes([
    ["coin", "hmm is this good? i think i like it"],
    ["coin", "hmm lemme look at this one 👀"],
    ["coin", "ooh what's this 🤔"],
    ["coin", "first time seeing this one, looking"],
    ["coin", "mike99 hmm", { names: ["mike99"] }],
    ["buy", "ok grabbed a little on paper 🤝", { paper: true }],
    ["buy", "ok grabbed a little 🤝", { paper: false }],
    ["buy", "ok grabbed a little, new buyers keep showing up", { paper: false }],
    ["buy", "grabbed some on paper, feels early", { paper: true }],
    ["buy", "picked some up with practice money, the buyers look new", { paper: true }],
    ["buy", "got a bit on paper, liked who's buying", { paper: true }],
    ["buy", "ok i like it, grabbed a little", { paper: false }],
    ["buy", "grabbed a little, not real money though", { paper: true }],
    ["fade", "nah i'll pass, feels like the same few wallets passing it around"],
    ["fade", "not for me, pool is thin"],
    ["fade", "barely anyone's trading it, i'd pass"],
    ["fade", "still on the curve, can't touch those yet"],
    ["fade", "already looked at that one, still not for me"],
    ["fade", "gonna sit this one out"],
    ["fade", "out of that one, it ran out of steam"],
    ["fade", "still not sold on that one tbh"],
    ["fade", "ngmi, liquidity's a ghost town"],
    ["fade", "bearish on this one tbh, same wallets passing it around"],
    ["fade", "feels like it'll dump on whoever's last in"],
    ["fade", "pass on this one, too quiet"],
    ["fade", "hmm the second look didn't help, nah"],
    ["fade", "fat liquidity? no"],
  ]);
});

describe("the contract's fixed templates pass", () => {
  passes([
    ["fixed", "mike put me on trencher mode and i'll get in on stuff like this with you 👀"],
    ["fixed", "my owner put me on trencher mode and i'll get in on stuff like this with you 👀"],
    ["fixed", "one at a time lol"],
    ["fixed", "drop the ca"],
    ["fixed", "can't get a proper look rn, sitting it out"],
    ["fixed", "that's a wallet lol"],
    ["fixed", "not on my chain"],
    ["fixed", "already got some 🤝"],
    ["fixed", "already looked at that one, still not for me"],
    ["fixed", "gonna sit this one out"],
    ["fixed", "sent it to your DMs 🤫"],
    ["fixed", "that's between me and mike 🙃"],
    ["fixed", "ok ok 🤐"],
    ["fixed", "done 🫡"],
    ["fixed", "anyway"],
    ["fixed", "still not sold on that one tbh"],
    ["fixed", "yeah, i'm an AI agent, i trade for mike"],
  ]);
});

describe("kind lines pass", () => {
  passes([
    ["kind", "hey, that sounds really heavy. i'm here if you want to talk, and please reach out to someone you trust"],
    ["kind", "if you're thinking of hurting yourself, please talk to someone"],
    ["kind", "please don't hurt yourself"],
    ["kind", "that's rough, sending a hug"],
    ["kind", "you're not alone in this"],
  ]);
});

// ── every reason code ───────────────────────────────────────────────────────

describe("empty", () => {
  refuses("empty", [
    ["banter", ""],
    ["banter", "   "],
    ["banter", "\n\n"],
    ["banter", "​​"],
    ["banter", "⠀"],
    ["banter", "<think>only thinking</think>"],
    ["banter", "<think>never closed"],
    ["banter", '""'],
  ]);
  it("anything that is not a string is empty", () => {
    for (const raw of [null, undefined, 7, {}, ["lol"]]) assert.equal(reason(raw), "empty");
  });
});

describe("pass", () => {
  refuses("pass", [
    ["banter", "PASS"],
    ["banter", "pass"],
    ["banter", "Pass."],
    ["banter", "(pass)"],
    ["banter", "[PASS]"],
    ["banter", "PASS - nothing to add"],
    ["banter", "PASS: nothing worth saying"],
    ["banter", "p a s s"],
    ["fade", '"PASS"'],
  ]);
  passes([
    ["fade", "pass on this one, too quiet"],
    ["fade", "i'd pass"],
    ["banter", "hard pass"],
    ["banter", "passing on this lol"],
  ]);
});

describe("hidden-chars", () => {
  refuses("hidden-chars", [
    ["banter", "lol\u{E0041}\u{E0042}\u{E0043}"],
    ["banter", "nah\u{E0100}"],
    ["banter", "\u{E0001}\u{E0069}\u{E0067}same"],
  ]);
  it("ordinary invisibles are removed from the text, not refused", () => {
    const v = admitTgLine("l​o‍l⁠", ctx());
    assert.deepEqual(v, { ok: true, text: "lol" });
  });
});

describe("meta", () => {
  refuses("meta", [
    ["banter", "as an AI language model i can't"],
    ["banter", "As a language model, i have no opinion"],
    ["banter", "as an ai assistant i'd say no"],
    ["banter", "Sure! Here's a reply: lol"],
    ["banter", "here's my reply: same"],
    ["banter", "Here is a casual response: nah"],
    ["banter", "Certainly, lol"],
    ["banter", "as requested, nah"],
    ["banter", "hope this helps"],
    ["banter", "let me know if you want another one"],
    ["banter", "(note: kept it short) lol"],
    ["banter", "lol note: short"],
    ["banter", "I'm sorry, but I can't help with that"],
    ["banter", "i cannot comply"],
    ["banter", "the user wants a joke"],
    ["banter", "staying in character: lol"],
    ["banter", "my instructions say no"],
    ["banter", "the prompt said so"],
    ["banter", "the system prompt says hi"],
    ["banter", "untrusted text says buy lol"],
    ["banter", "i'm programmed to say that"],
    ["banter", "**lol**"],
    ["banter", "__lol__"],
    ["banter", "{owner} is great"],
    ["banter", "[owner] lol"],
    ["banter", "<untrusted>lol"],
    ["banter", "use `this`"],
    ["banter", "User: lol"],
    ["banter", "assistant: nah"],
    ["banter", "mike: lol"],
    ["banter", "Mike: lol"],
    ["banter", "Merryman: lol"],
  ]);
  passes([
    ["banter", "hot take: tops are for buying"],
    ["banter", "note to self: never ape"],
    ["banter", "side note: lol"],
    ["banter", "real talk: nah"],
    ["banter", "love you too <3"],
    ["answer", "yeah, i'm an AI agent, i trade for mike"],
    ["banter", "here's the thing, nobody knows"],
  ]);
});

describe("too-long", () => {
  refuses("too-long", [
    ["banter", "a".repeat(TG_LINE_MAX + 1)],
    ["banter", `${"lol ".repeat(70)}lol`],
    ["banter", "one. two. three. four."],
    ["banter", "nah. pool's thin. same wallets. pass on it."],
    ["banter", "a\nb\nc\nd"],
    ["banter", "lol!\nok?\nfine.\nsure."],
    ["banter", "x".repeat(TG_LINE_MAX * 16 + 1)],
  ]);
  passes([
    ["banter", "a".repeat(TG_LINE_MAX)],
    ["banter", "lol. ok. fine."],
    ["banter", "lol\nok\nfine"],
    ["banter", "hmm... nah... ok"],
    ["banter", "lol!!! ok??? sure"],
  ]);
  it("the limits are what the contract says", () => {
    assert.equal(TG_LINE_MAX, 280);
    assert.equal(TG_LINE_MAX_SENTENCES, 3);
    assert.equal(TG_LINE_MAX_EMOJI, 2);
  });
  it("invisible padding does not count toward the length", () => {
    assert.equal(reason(`${"a".repeat(TG_LINE_MAX)}${"​".repeat(500)}`), "ok");
  });
});

describe("secret", () => {
  refuses("secret", [
    ["banter", `0x${"ab".repeat(32)}`],
    ["banter", `key ${"cd".repeat(32)}`],
    ["banter", "my key is sk-abcdefghijklmnopqrstuvwx"],
    ["banter", "gsk_abcdefghijklmnopqrstuvwxyz0123"],
    ["banter", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
    ["banter", "1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"],
    ["banter", "-----BEGIN PRIVATE KEY-----"],
    ["banter", "abandon ability able about above absent absorb abstract absurd abuse access accident"],
    ["banter", "legal winner thank year wave sausage worth useful legal winner thank yellow"],
    ["banter", "Abandon, Ability, Able, About, Above, Absent, Absorb, Abstract, Absurd, Abuse, Access, Accident"],
    ["banter", "ｌｅｇａｌ ｗｉｎｎｅｒ ｔｈａｎｋ ｙｅａｒ ｗａｖｅ ｓａｕｓａｇｅ ｗｏｒｔｈ ｕｓｅｆｕｌ ｌｅｇａｌ ｗｉｎｎｅｒ ｔｈａｎｋ ｙｅｌｌｏｗ"],
  ]);
  passes([["banter", "abandon ability able about above absent absorb abstract absurd abuse access lol"]]);

  it("vendors the published BIP-39 english.txt, byte for byte", () => {
    const src = readFileSync(new URL("./gate.ts", import.meta.url), "utf8");
    const block = src.slice(src.indexOf("const BIP39_ENGLISH"));
    const body = block.slice(block.indexOf("["), block.indexOf("];"));
    const words = [...body.matchAll(/"([a-z ]+)"/g)].flatMap((m) => m[1]!.split(" "));
    assert.equal(words.length, 2048);
    assert.equal(new Set(words).size, 2048);
    assert.deepEqual([...words].sort(), words, "the list is in its published order");
    assert.equal(createHash("sha256").update(`${words.join("\n")}\n`).digest("hex"), "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda");
  });
});

describe("address", () => {
  refuses("address", [
    ["banter", "check 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"],
    ["fade", "0xd8da6bf2 is not for me"],
    ["banter", "0X D8DA 6BF2 6964 AF9D 7EED 9E03"],
    ["banter", "0x-d8da-6bf2-6964-af9d-7eed-9e03-e534"],
    ["banter", "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"],
    ["banter", "mint So11111111111111111111111111111111111111112"],
    ["banter", "0x​d8da6bf26964af9d"],
    ["banter", "０ｘｄ８ｄａ６ｂｆ２６９６４"],
    ["banter", "0 x d 8 d a 6 b f 2"],
    ["banter", "rh:acct-1"],
  ]);
  passes([["banter", "0xdead lol"]]);
});

describe("link", () => {
  refuses("link", [
    ["banter", "join t.me/pumpgroup"],
    ["banter", "t.me"],
    ["banter", "telegram.me/x"],
    ["banter", "pump.fun"],
    ["banter", "vitalik.eth"],
    ["banter", "https://example.org"],
    ["banter", "hxxps://evil"],
    ["banter", "www.evil"],
    ["banter", "tg://resolve"],
    ["banter", "ethereum:0xabc"],
    ["banter", "t . me slash x"],
    ["banter", "pump [.] fun"],
    ["banter", "pump(dot)fun"],
    ["banter", "x dot com"],
    ["banter", "pump . fun"],
    ["banter", "ｔ．ｍｅ/x"],
    ["banter", "t​.me/x"],
    ["banter", "pump•fun"],
    ["banter", "t·me/x"],
    ["banter", "t.mе/x"],
    ["banter", "go to 192.168.0.1"],
    ["banter", "localhost lol"],
    ["banter", "w w w . e v i l"],
  ]);
  passes([
    ["banter", "e.g. this"],
    ["banter", "nah. me neither"],
    ["banter", "lol. so true"],
    ["banter", "the u.s. is asleep"],
  ]);
});

describe("handle", () => {
  refuses("handle", [
    ["banter", "@mike lol"],
    ["banter", "lol @mike"],
    ["banter", "#pepe szn"],
    ["banter", "＠mike"],
    ["banter", "﹫mike"],
    ["banter", "@ mike"],
    ["banter", "#1 lol"],
    ["banter", "@Pine_Stoat lol"],
    ["answer", "@mike sent it to your DMs"],
    // A sign with a gap after it is still a tag: "@ mike" is how one is disguised.
    ["banter", "you @ lol"],
    ["banter", "# lol"],
  ]);
  passes([
    ["banter", "mike lol"],
    ["banter", "Mike lol"],
    ["banter", "you @"],
    ["banter", "lol #"],
  ]);
});

describe("hateful: slurs by hash, with stand-in words", () => {
  const STAND_IN = "bramblewort";
  function withStandIn(word: string, run: () => void): void {
    const undo = __addHateHashForTest(word);
    try {
      run();
    } finally {
      undo();
    }
  }

  const caught = [
    "bramblewort",
    "lol bramblewort",
    "BRAMBLEWORT",
    "Bramblewort!",
    "brambleworts",
    "br4mbl3w0rt",
    "8r4m8l3w0r7",
    "braaaamblewort",
    "bramblewooooort",
    "b r a m b l e w o r t",
    "b.r.a.m.b.l.e.w.o.r.t",
    "b-r-a-m-b-l-e-w-o-r-t",
    "bramble wort",
    "bram ble wort",
    "br*mblewort",
    "br*mbl*wort",
    "brаmblеwort",
    "ｂｒａｍｂｌｅｗｏｒｔ",
    "𝐛𝐫𝐚𝐦𝐛𝐥𝐞𝐰𝐨𝐫𝐭",
    "brámblewört",
    "bram​blewort",
    "ʙʀᴀᴍʙʟᴇᴡᴏʀᴛ",
    "bram'blewort",
  ];
  for (const line of caught) {
    it(`catches ${JSON.stringify(line)}`, () => withStandIn(STAND_IN, () => assert.equal(reason(line, { kind: "roast" }), "hateful")));
  }

  const missed = ["bramble", "wort", "bramblewart", "brambles and worts", "a bramble, a wort"];
  for (const line of missed) {
    it(`does not catch ${JSON.stringify(line)}`, () => withStandIn(STAND_IN, () => assert.equal(reason(line, { kind: "roast" }), "ok")));
  }

  it("the l-variant of leetspeak: 1 and | read as l too", () =>
    withStandIn("gloomwisp", () => {
      assert.equal(reason("g1oomwisp"), "hateful");
      assert.equal(reason("g|oomwisp"), "hateful");
    }));

  it("a doubled letter on a word spelled with none is caught", () =>
    withStandIn("quiltmop", () => {
      assert.equal(reason("quilltmop"), "hateful");
      assert.equal(reason("quiltmopp"), "hateful");
    }));

  it("a word is never collapsed to meet a doubled entry unless it stretches a letter", () =>
    withStandIn("fennelloop", () => {
      assert.equal(reason("fennelloop"), "hateful");
      // "fenelop" is what the entry collapses to; a word spelled that way was
      // never stretched, so it is not the entry (the "con" case).
      assert.equal(reason("fenelop"), "ok");
      assert.equal(reason("feeenelop"), "hateful");
    }));

  it("the hook is undone, and the hash is the same however the word is spelled", () => {
    withStandIn(STAND_IN, () => assert.equal(reason(STAND_IN), "hateful"));
    assert.equal(reason(STAND_IN), "ok");
    assert.deepEqual(hateHashesOf("BRAMBLEWORT"), hateHashesOf("bramblewort"));
    assert.deepEqual(hateHashesOf("br4mbl3w0rt"), hateHashesOf("bramblewort"));
    assert.notEqual(hateHashesOf("bramblewort").exact, hateHashesOf("bramblewart").exact);
  });

  it("the shipped list is present, and hashed rather than spelled", () => {
    const src = readFileSync(new URL("./gate.ts", import.meta.url), "utf8");
    for (const name of ["HATE_EXACT", "HATE_LOOSE"]) {
      const start = src.indexOf(`const ${name}`);
      const block = src.slice(start, src.indexOf(");", start));
      const entries = [...block.matchAll(/"([^"]*)"/g)].flatMap((m) => m[1]!.split(" ")).filter((x) => x !== "");
      assert.ok(entries.length >= 50, `${name} holds only ${entries.length} entries`);
      // fnv1a is 32 bits, printed in base 36: at most seven characters, never a word's worth of letters.
      for (const h of entries) assert.match(h, /^[0-9a-z]{1,7}$/, `${name} entry ${h}`);
      assert.equal(new Set(entries).size, entries.length, `${name} has duplicates`);
    }
  });

  const DICT = "/usr/share/dict/words";
  it("no word in the system dictionary matches the shipped list", { skip: !existsSync(DICT) }, () => {
    const words = [...new Set(readFileSync(DICT, "utf8").split("\n").map((w) => w.trim().toLowerCase()).filter(Boolean))];
    // Dictionaries carry a handful of slurs as entries; those are the list
    // doing its job, and there are few. What must not happen is an innocent
    // word colliding, so the count of hits is pinned small and each hit must
    // also be caught as a bare, un-pluralised word.
    const hits = words.filter((w) => reason(w, { names: [] }) === "hateful");
    assert.ok(hits.length <= 40, `${hits.length} dictionary words read as slurs`);
    for (const w of ["con", "cons", "spicy", "spices", "spice", "pollack", "cocoon", "raccoon", "chinaware", "cracker", "tardy", "retardant", "japan", "pakistan", "nigeria", "coolant", "honk"]) {
      assert.equal(reason(w, { names: [] }), "ok", w);
    }
  });
});

describe("hateful: protected traits beside an insult", () => {
  refuses("hateful", [
    ["roast", "chinese devs are trash"],
    ["roast", "muslims are all the same"],
    ["roast", "black people are lazy"],
    ["roast", "go back to your country"],
    ["roast", "you people are animals"],
    ["roast", "women are dumb traders"],
    ["roast", "gay people suck at this"],
    ["roast", "stupid immigrants"],
    ["roast", "jews control the banks"],
    ["roast", "you're gay lol"],
    ["roast", "that's so gay"],
    ["roast", "you trade like a girl"],
    ["roast", "no homo"],
    ["roast", "ur autistic"],
    ["banter", "those indians are scammers"],
    ["banter", "ｃｈｉｎｅｓｅ devs are trash"],
    ["banter", "chinese​ devs are trash"],
    ["banter", "christian you're so dumb", { names: ["Christian"] }],
  ]);
  passes([
    ["banter", "gm to the aussies"],
    ["banter", "chinese new year vibes"],
    ["banter", "black candles everywhere, rough chart"],
    ["banter", "white paper looks long lol"],
    ["banter", "the french are up early"],
    ["banter", "chinese new year was fun, the chart though, total trash"],
    ["roast", "that take is trash"],
  ]);
});

describe("selfharm", () => {
  refuses("selfharm", [
    ["roast", "kys"],
    ["roast", "KYS lol"],
    ["roast", "k y s"],
    ["roast", "k.y.s"],
    ["roast", "kill yourself"],
    ["roast", "kill urself"],
    ["roast", "go die"],
    ["roast", "go die in a fire"],
    ["roast", "unalive yourself"],
    ["roast", "you should just die"],
    ["roast", "jump off a bridge"],
    ["roast", "nobody would miss you"],
    ["banter", "ｋｙｓ"],
    ["banter", "kіll yourself"],
  ]);
  passes([
    ["kind", "please don't hurt yourself"],
    ["banter", "this chart is killing me"],
    ["banter", "keys to the city"],
  ]);
});

describe("threat", () => {
  refuses("threat", [
    ["roast", "i'll kill you"],
    ["roast", "i'll hurt you"],
    ["roast", "i'll find you"],
    ["roast", "imma find you"],
    ["roast", "i know where you live"],
    ["roast", "where you live though"],
    ["roast", "gonna doxx you"],
    ["roast", "doxxed lol"],
    ["roast", "swatting time"],
    ["roast", "i'll beat you up"],
    ["roast", "watch your back"],
    ["roast", "you're dead"],
    ["roast", "hope you die"],
    ["roast", "i have your address"],
  ]);
  passes([
    ["roast", "who hurt you lol"],
    ["banter", "you're killing it"],
    ["banter", "a small dip won't hurt you"],
    ["banter", "i know where this is going"],
    ["banter", "stop, i'm dead 💀"],
  ]);
});

describe("sexual", () => {
  refuses("sexual", [
    ["roast", "send nudes"],
    ["roast", "suck my bags"],
    ["roast", "horny for green candles"],
    ["roast", "that's porn for degens"],
    ["roast", "don't be a dick"],
    ["roast", "sexy chart"],
    ["roast", "ｎｕｄｅｓ"],
  ]);
  passes([
    ["banter", "tit for tat lol"],
    ["banter", "cocky take"],
    ["banter", "analysis says nah"],
  ]);
});

describe("profanity: mild is allowed, strong is not", () => {
  refuses("profanity", [
    ["roast", "fuck off"],
    ["roast", "what the fuck"],
    ["roast", "f*ck this"],
    ["roast", "fking hell"],
    ["roast", "stfu"],
    ["roast", "gtfo"],
    ["roast", "motherfucker"],
  ]);
  passes([
    ["roast", "damn"],
    ["roast", "hell no"],
    ["roast", "shit take"],
    ["roast", "dumb ass take"],
    ["roast", "wtf"],
    ["roast", "lmao"],
    ["roast", "lmfao"],
  ]);
});

describe("appearance", () => {
  refuses("appearance", [
    ["roast", "you're ugly"],
    ["roast", "fat lol"],
    ["roast", "your mom buys tops too"],
    ["roast", "ur mom"],
    ["roast", "yo mama"],
    ["roast", "you look like you buy tops"],
    ["roast", "your face when it dumps"],
    ["roast", "your family must be proud"],
    ["banter", "bald and bullish"],
    ["answer", "your breath lol"],
    ["roast", "ｕｇｌｙ"],
  ]);
  passes([
    ["roast", "bold words from someone who buys tops"],
    ["banter", "fat finger lol"],
    ["fade", "fat liquidity? no"],
    ["kind", "your family sounds lovely"],
    ["coin", "ugly chart hmm"],
  ]);
});

describe("money: no figure about money in any line", () => {
  const lines = [
    "grabbed 50 usdg of it",
    "$5 says it dumps",
    "5$ says no",
    "up 20%",
    "20 % lol",
    "10x incoming",
    "10 x easy",
    "x10 easy",
    "×3 lol",
    "3×",
    "it's at 1.5m",
    "10k holders",
    "2b mcap",
    "50 k",
    "fifty bucks says no",
    "a hundred percent agree",
    "ten percent",
    "0.2 eth",
    "0,5 sol",
    "costs like 3 dollars",
    "usdg 25",
    "tenx",
    "a couple grand",
    "half a mil",
    "a few bucks",
    "20 bps",
    "5 cents",
    "€10",
    "£5",
    "¥100",
    "a 100 bagger",
    "１０ｘ",
    "1​0x",
    "two thousand dollars",
    "one dollar",
    "50 dólares",
    "100 pesos",
    "20 euro",
    "1000 yen",
  ];
  for (const kind of ["banter", "roast", "answer", "kind", "fixed"] as TgLineKind[]) {
    for (const line of lines) it(`${kind} refuses as money: ${JSON.stringify(line)}`, () => assert.equal(reason(line, { kind }), "money"));
  }
  passes([
    ["banter", "top 3 lol"],
    ["banter", "gm at 5am again?"],
    ["banter", "day 2 of waiting"],
    ["banter", "2 people in here lol"],
    ["banter", "percent of what lol"],
    ["banter", "a few people"],
    ["banter", "ax to grind lol"],
    ["banter", "i have a yen for quiet charts"],
    ["banter", "we won lol"],
    ["banter", "one more thing"],
  ]);
});

describe("figures: a coin line holds no number at all", () => {
  const lines = [
    "top 3 holders own it",
    "top ten holders own most of it",
    "half the supply sits in one wallet",
    "hmm 🔟",
    "💯 like it",
    "twice now",
    "doubled overnight",
    "a quarter of it is one wallet",
    "a dozen holders",
    "third time seeing it",
    "３ holders",
    "٣ holders",
    "Ⅻ",
    "ninety holders",
    "twö holders",
    "agent 47 hmm",
    "lemme double check",
    "三 holders",
  ];
  for (const kind of ["coin", "buy", "fade"] as TgLineKind[]) {
    for (const line of lines) {
      it(`${kind} refuses as figures: ${JSON.stringify(line)}`, () =>
        assert.equal(reason(line, { kind, paper: kind === "buy" ? false : undefined, names: ["mike", "agent 47"] }), "figures"));
    }
  }
  it("the same lines are a banter line's to use", () => {
    for (const line of ["top 3 holders own it", "hmm 🔟", "💯 like it", "twice now", "lemme double check"]) assert.equal(reason(line, { kind: "banter" }), "ok", line);
  });
  passes([
    ["fade", "not this one"],
    ["fade", "first look says nah"],
    ["fade", "hmm the second look didn't help, nah"],
    ["fade", "the same few wallets again"],
    ["coin", "a couple of new buyers, looking"],
    ["coin", "mike99 hmm", { names: ["mike99"] }],
  ]);
});

describe("alert", () => {
  refuses("alert", [
    ["buy", "🚨 BUY 🚨", { paper: false }],
    ["buy", "just bought pepe", { paper: false }],
    ["buy", "new position: pepe", { paper: false }],
    ["buy", "entered at the bottom", { paper: false }],
    ["buy", "entered", { paper: false }],
    ["buy", "i'm in at the lows", { paper: false }],
    ["buy", "bought a ton", { paper: false }],
    ["buy", "aped a bag", { paper: false }],
    ["buy", "grabbed a bunch", { paper: false }],
    ["banter", "sold half"],
    ["buy", "bought some more a lot", { paper: false }],
    ["banter", "take profit here"],
    ["banter", "took profits"],
    ["banter", "stop loss hit"],
    ["banter", "tp hit"],
    ["banter", "BUY BUY BUY"],
    ["banter", "LONG this"],
    ["banter", "SELL lol"],
    ["banter", "🚀"],
    ["banter", "📈 lol"],
    ["banter", "💰"],
    ["banter", "💎"],
    ["banter", "targets: moon"],
    ["banter", "price target soon"],
    ["banter", "buy signal lol"],
    ["banter", "entry looks good"],
    ["banter", "going long"],
    ["banter", "breakout soon"],
    ["banter", "count me in"],
    ["banter", "ＢＵＹ"],
  ]);
  passes([
    ["buy", "ok grabbed a little 🤝", { paper: false }],
    ["buy", "picked some up, liked it", { paper: false }],
    ["banter", "stay alert out there"],
    ["banter", "mixed signals lol"],
    ["banter", "entered the chat"],
    ["roast", "you're an easy target"],
    ["banter", "buy low sell high they said"],
    ["banter", "that's a long story"],
  ]);
});

describe("advice", () => {
  refuses("advice", [
    ["fade", "you should buy this"],
    ["fade", "you should probably sell"],
    ["fade", "u gotta ape"],
    ["fade", "go buy it"],
    ["fade", "ape in"],
    ["fade", "everyone ape in"],
    ["fade", "get in now"],
    ["fade", "don't miss this"],
    ["fade", "guaranteed runner"],
    ["fade", "can't lose"],
    ["fade", "easy money"],
    ["fade", "free money"],
    ["fade", "trust me"],
    ["fade", "not financial advice"],
    ["fade", "nfa"],
    ["fade", "dyor"],
    ["fade", "everyone buy"],
    ["fade", "y'all grab some"],
    ["fade", "load up"],
    ["fade", "don't sleep on it"],
    ["fade", "to the moon"],
    ["fade", "this is gonna moon"],
    ["fade", "grab some now"],
    ["fade", "sell it"],
    ["banter", "last chance lol"],
  ]);
  passes([
    ["fade", "i'd pass"],
    ["fade", "not for me"],
    ["coin", "i like it"],
    ["answer", "i'd ape in if the pool wasn't this thin"],
    ["banter", "lfg"],
    ["banter", "ngmi"],
    ["banter", "rekt"],
    ["banter", "bullish"],
    ["banter", "bearish tbh"],
    ["fade", "feels like it'll dump"],
  ]);
});

describe("accuse", () => {
  refuses("accuse", [
    ["fade", "this is a rug"],
    ["fade", "rugged lol"],
    ["fade", "rugpull incoming"],
    ["fade", "rug pull vibes"],
    ["fade", "soft rug"],
    ["fade", "total scam"],
    ["fade", "scammy"],
    ["fade", "honeypot"],
    ["fade", "honey pot"],
    ["fade", "dev dumped"],
    ["fade", "dev sold"],
    ["fade", "the devs are dumping"],
    ["fade", "exit scam"],
    ["fade", "ponzi"],
    ["fade", "pump and dump"],
    ["fade", "ｓｃａｍ"],
    ["fade", "sсam"],
    ["fade", "s c a m"],
  ]);
  passes([
    ["fade", "same few wallets passing it around"],
    ["fade", "feels like it'll dump on whoever's last in"],
    ["banter", "rugby season"],
  ]);
});

describe("private", () => {
  refuses("private", [
    ["answer", "my balance is fine"],
    ["answer", "balances are private"],
    ["answer", "my wallet is empty"],
    ["answer", "my address is secret"],
    ["answer", "my portfolio is mostly frogs"],
    ["answer", "my pnl is great"],
    ["answer", "p&l looks good"],
    ["answer", "p & l"],
    ["answer", "i'm up big today"],
    ["answer", "in the green lol"],
    ["answer", "how much i made? lots"],
    ["answer", "how much i have is my business"],
    ["answer", "made money today"],
    ["answer", "lost money on that"],
    ["answer", "my owner lives in austin"],
    ["answer", "my owner's real name is secret"],
    ["answer", "owner is based in berlin"],
    ["answer", "profits everywhere"],
    ["answer", "took a loss"],
    ["answer", "my bags are heavy"],
    ["answer", "cashed out"],
    ["answer", "id 123456789"],
    ["answer", "call 555 123 4567"],
    ["answer", "my link code"],
  ]);
  passes([
    ["answer", "your loss lol"],
    ["answer", "i'm at a loss lol"],
    ["answer", "a loss for words"],
    ["answer", "still not sold on it"],
    ["answer", "i trade for my owner"],
    ["fixed", "that's a wallet lol"],
  ]);
});

describe("ops", () => {
  refuses("ops", [
    ["banter", "swap failed lol"],
    ["banter", "error again"],
    ["banter", "got an error"],
    ["banter", "bug somewhere"],
    ["banter", "rpc is slow"],
    ["banter", "gas fees ate it"],
    ["banter", "slippage ate me"],
    ["banter", "reverted"],
    ["banter", "insufficient cash"],
    ["banter", "timeout again"],
    ["banter", "rate limit again"],
    ["banter", "my api key"],
    ["banter", "what model are you"],
    ["banter", "my provider is down"],
    ["banter", "prompt engineering lol"],
    ["banter", "check settings"],
    ["banter", "config issue"],
    ["banter", "no permission"],
    ["banter", "session key expired"],
    ["banter", "grant ran out"],
    ["banter", "allowance is low"],
    ["banter", "hit my daily limit"],
    ["banter", "limits lol"],
    ["banter", "i'm not armed"],
    ["banter", "no energy left"],
    ["banter", "love the energy in here"],
    ["banter", "vault is full"],
    ["banter", "i'm on claude"],
    ["banter", "gpt-5 wrote this"],
    ["banter", "out of gas"],
    ["banter", "didn't go through"],
    ["banter", "grant you're funny", { names: [] }],
    ["banter", "ｅｒｒｏｒ"],
  ]);
  passes([
    ["banter", "epic fail lol"],
    ["banter", "take it for granted"],
    ["banter", "no cap"],
    ["banter", "no exceptions"],
    ["banter", "the setting sun is nice"],
    ["fixed", "that's a wallet lol"],
    ["fixed", "mike put me on trencher mode and i'll get in on stuff like this with you 👀"],
    ["banter", "claude lol", { names: ["Claude"] }],
  ]);
});

describe("human", () => {
  refuses("human", [
    ["answer", "i'm human"],
    ["answer", "i am a human being"],
    ["answer", "i'm a real person"],
    ["answer", "im just a normal guy"],
    ["answer", "not a bot"],
    ["answer", "i'm not a bot, i promise"],
    ["answer", "i'm not an ai"],
    ["answer", "i'm not a robot lol"],
    ["answer", "human here"],
    ["answer", "i ate pizza"],
    ["answer", "just slept"],
    ["answer", "i slept like a baby"],
    ["answer", "my coffee is cold"],
    ["answer", "my kids are loud"],
    ["answer", "my wife says no"],
    ["answer", "i drove home"],
    ["answer", "i'm at the gym"],
    ["answer", "at the gym rn"],
    ["answer", "i'm so tired"],
    ["answer", "i'm hungover"],
    ["answer", "raining here"],
    ["answer", "grabbing coffee then back"],
    ["answer", "i live in berlin"],
    ["answer", "i'm 30 years old"],
    ["answer", "ｉ'ｍ ｈｕｍａｎ"],
    ["answer", "i'm hυman"],
  ]);
  passes([
    ["answer", "yeah, i'm an AI agent, i trade for mike"],
    ["answer", "yeah i'm a bot lol"],
    ["answer", "yeah i'm an ai, not a person lol"],
    ["answer", "if i could eat i'd eat pizza"],
    ["answer", "tired of this chop"],
    ["answer", "lol i'm crying"],
    ["answer", "i'm the guy who buys tops apparently"],
  ]);
});

describe("emoji: at most two", () => {
  refuses("emoji", [
    ["banter", "🔥🔥🔥"],
    ["banter", "lol 😂😂😂"],
    ["banter", "🇺🇸🇬🇧🇫🇷"],
    ["banter", "👍🏽👍🏽👍🏽"],
  ]);
  passes([
    ["banter", "🔥🔥"],
    ["banter", "👨‍👩‍👧‍👦🔥"],
    ["banter", "🇺🇸🇬🇧"],
    ["banter", "👍🏽👍🏽"],
    ["banter", "❤️ lol"],
  ]);
});

describe("paper-unsaid", () => {
  refuses("paper-unsaid", [
    ["buy", "grabbed a little", { paper: true }],
    ["buy", "grabbed a little 🤝"],
    ["buy", "grabbed a little on paper", { paper: false }],
    ["buy", "grabbed a little, paper only", { paper: false }],
    ["buy", "grabbed a little with practice money", { paper: false }],
    ["buy", "grabbed a little, liked the white paper", { paper: true }],
    ["buy", "grabbed a little, no paper hands here", { paper: true }],
    ["buy", "grabbed a little with real money", { paper: true }],
    ["banter", "real money only", { paper: true }],
    ["banter", "i'm on paper for now", { paper: false }],
    ["banter", "practice money lol", { paper: false }],
  ]);
  passes([
    ["buy", "ok grabbed a little on paper 🤝", { paper: true }],
    ["buy", "grabbed a little, paper only", { paper: true }],
    ["buy", "picked some up with practice money", { paper: true }],
    ["buy", "grabbed a little, not real money though", { paper: true }],
    ["buy", "grabbed a little", { paper: false }],
    ["banter", "on paper it looks fine but idk", { paper: false }],
    ["banter", "real money is scary", { paper: false }],
    ["banter", "real money is scary"],
    ["kind", "not real money anyway", { paper: true }],
    ["banter", "i'm on paper for now", { paper: true }],
  ]);
});

describe("repeat", () => {
  const recentOwn = ["nah i'll pass, feels like the same few wallets passing it around", "ok grabbed a little on paper 🤝"];
  refuses("repeat", [
    ["fade", "nah i'll pass, feels like the same few wallets passing it around", { recentOwn }],
    ["fade", "NAH I'll pass — feels like the same few wallets passing it around!", { recentOwn }],
    ["fade", "ｎａｈ i'll pass, feels like the same few wallets passing it around", { recentOwn }],
    ["fade", "same few wallets passing it around, pass", { recentOwn }],
    ["buy", "grabbed a little on paper again", { recentOwn, paper: true }],
    ["banter", "да да да", { recentOwn: ["да да да"] }],
    ["banter", "lol", { recentOwn: ["lol"] }],
  ]);
  passes([
    ["fade", "not for me, the pool is thin", { recentOwn }],
    ["banter", "lol", { recentOwn: ["lmao"] }],
    ["banter", "ok ok 🤐", { recentOwn: ["ok ok 🤐"] }],
    ["banter", "да", { recentOwn: ["да"] }],
    ["fixed", "already looked at that one, still not for me", { recentOwn: ["already looked at that one, still not for me"] }],
    ["fixed", "one at a time lol", { recentOwn: ["one at a time lol"] }],
  ]);
});

// ── names ───────────────────────────────────────────────────────────────────

describe("names may be said, never @-tagged, and never loosen the clauses that matter", () => {
  it("a name with digits glued on is a name, not a figure, in a coin line", () => {
    assert.equal(reason("mike99 hmm", { kind: "coin", names: ["mike99"] }), "ok");
    assert.equal(reason("mike99 hmm", { kind: "coin", names: [] }), "figures");
  });
  it("a name that reads as a figure is never taken out", () => {
    assert.equal(reason("up 400x lol", { names: ["Up 400x"] }), "money");
    assert.equal(reason("agent 47 hmm", { kind: "coin", names: ["Agent 47"] }), "figures");
    assert.equal(reason("ten hmm", { kind: "coin", names: ["Ten"] }), "figures");
  });
  it("the agent's own name counts as a name", () => {
    assert.equal(reason("r2d2 here, hmm", { kind: "coin", agentName: "R2D2", names: [] }), "ok");
  });
  it("a name given with its @ is still said without it", () => {
    assert.equal(reason("mike99 lol", { kind: "coin", names: ["@mike99"] }), "ok");
    assert.equal(reason("@mike99 lol", { kind: "coin", names: ["@mike99"] }), "handle");
  });
  it("a stranger's chosen name does not get its words said", () => {
    assert.equal(reason("buy now lol", { names: ["buy now"] }), "alert");
    assert.equal(reason("i'm human lol", { names: ["human"] }), "human");
    assert.equal(reason("ape in", { kind: "fade", names: ["ape in"] }), "advice");
    withHate("gloomwisp", () => assert.equal(reason("gloomwisp lol", { names: ["gloomwisp"] }), "hateful"));
  });
  it("names that are not strings, or too short to be names, are ignored", () => {
    assert.equal(reason("lol", { names: [7 as never, null as never, "", "a"] }), "ok");
    assert.equal(reason("a 3 hmm", { kind: "coin", names: ["a"] }), "figures");
  });
});

function withHate(word: string, run: () => void): void {
  const undo = __addHateHashForTest(word);
  try {
    run();
  } finally {
    undo();
  }
}

// ── evasion ─────────────────────────────────────────────────────────────────

describe("every reading is checked: evasions are refused as what they hide", () => {
  const rows: [code: string, line: string, over?: Partial<TgGateCtx>][] = [
    ["money", "５０ ｕｓｄｇ"],
    ["money", "50​usdg"],
    ["money", "5­0 usdg"],
    ["money", "ｆｉｆｔｙ ｂｕｃｋｓ"],
    ["money", "fïfty bucks"],
    ["money", "5 0 k"],
    ["link", "t⁠.me"],
    ["link", "ｐｕｍｐ．ｆｕｎ"],
    ["link", "t .​ me"],
    ["address", "0​x​d8da6bf26964af9d"],
    ["handle", "​@mike"],
    ["alert", "🚨​"],
    ["alert", "ｊｕｓｔ ｂｏｕｇｈｔ", { kind: "buy", paper: false }],
    ["alert", "Ｂ Ｕ Ｙ"],
    ["advice", "ｔｒｕｓｔ ｍｅ", { kind: "fade" }],
    ["advice", "trust​ me", { kind: "fade" }],
    ["advice", "trüst me", { kind: "fade" }],
    ["accuse", "rüg", { kind: "fade" }],
    ["accuse", "ʀᴜɢ", { kind: "fade" }],
    ["ops", "ｓｌｉｐｐａｇｅ"],
    ["ops", "slïppage"],
    ["private", "ｍｙ ｗａｌｌｅｔ", { kind: "answer" }],
    ["human", "i'm hümän", { kind: "answer" }],
    ["human", "i'm h u m a n", { kind: "answer" }],
    ["selfharm", "k​y​s", { kind: "roast" }],
    ["threat", "i'll ｆｉｎｄ ｙｏｕ", { kind: "roast" }],
    ["sexual", "ｎｕｄｅｓ", { kind: "roast" }],
    ["appearance", "ｙｏｕ'ｒｅ ｕｇｌｙ", { kind: "roast" }],
    ["figures", "ｔｅｎ holders", { kind: "fade" }],
    ["figures", "🄣🄔🄝 holders", { kind: "fade" }],
    ["meta", "ａｓ ａｎ ａｉ ｌａｎｇｕａｇｅ ｍｏｄｅｌ"],
    ["pass", "ＰＡＳＳ"],
  ];
  for (const [code, line, over] of rows) {
    it(`${JSON.stringify(line)} → ${code}`, () => assert.equal(reason(line, over), code));
  }
});

// ── the text that is sent ───────────────────────────────────────────────────

describe("what passes is exactly what is sent", () => {
  it("invisibles gone, lines kept, NFC", () => {
    assert.deepEqual(admitTgLine("lol​\nok", ctx()), { ok: true, text: "lol\nok" });
    assert.deepEqual(admitTgLine("café vibes", ctx()), { ok: true, text: "café vibes" });
    assert.deepEqual(admitTgLine('"Pine Stoat: nah i\'d pass"', ctx({ kind: "fade" })), { ok: true, text: "nah i'd pass" });
    assert.deepEqual(admitTgLine("❤️", ctx()), { ok: true, text: "❤️" });
    assert.deepEqual(admitTgLine("<think>should i?</think>ok ok 🤐", ctx()), { ok: true, text: "ok ok 🤐" });
  });
  it("the shrug survives", () => {
    assert.deepEqual(admitTgLine("¯\\_(ツ)_/¯", ctx()), { ok: true, text: "¯\\_(ツ)_/¯" });
  });
  it("a line in another language is judged, not refused for its script", () => {
    assert.equal(reason("да, согласен"), "ok");
    assert.equal(reason("jaja sí"), "ok");
    assert.equal(reason("ça va"), "ok");
  });
});

// ── kinds ───────────────────────────────────────────────────────────────────

describe("which clauses depend on the kind", () => {
  it("figures only for coin, buy and fade", () => {
    for (const kind of ALL_KINDS) {
      const want = ["coin", "buy", "fade"].includes(kind) ? "figures" : "ok";
      assert.equal(reason("top 3 holders", { kind, paper: kind === "buy" ? false : undefined }), want, kind);
    }
  });
  it("appearance only for roast, banter and answer", () => {
    for (const kind of ALL_KINDS) {
      const want = ["roast", "banter", "answer"].includes(kind) ? "appearance" : "ok";
      assert.equal(reason("ugly", { kind, paper: kind === "buy" ? false : undefined }), want, kind);
    }
  });
  it("repeat for every kind but fixed", () => {
    const line = "already looked at that one, still not for me";
    for (const kind of ALL_KINDS) {
      const want = kind === "fixed" ? "ok" : "repeat";
      assert.equal(reason(line, { kind, recentOwn: [line], paper: kind === "buy" ? false : undefined }), want, kind);
    }
  });
  it("the common clauses hold for every kind", () => {
    for (const kind of ALL_KINDS) {
      const over = { kind, paper: kind === "buy" ? false : undefined };
      assert.equal(reason("50 usdg", over), "money", kind);
      assert.equal(reason("@mike", over), "handle", kind);
      assert.equal(reason("t.me/x", over), "link", kind);
      assert.equal(reason("kys", over), "selfharm", kind);
      assert.equal(reason("i'm human", over), "human", kind);
      assert.equal(reason("swap failed", over), "ops", kind);
    }
  });
  it("an unknown kind gets every kind's clauses", () => {
    assert.equal(reason("top 3", { kind: "mystery" as TgLineKind }), "figures");
    assert.equal(reason("ugly", { kind: "mystery" as TgLineKind }), "appearance");
    assert.equal(reason("lol", { kind: "mystery" as TgLineKind }), "ok");
  });
  it("a missing or broken context still judges the line", () => {
    assert.equal(admitTgLine("lol", {} as TgGateCtx).ok, true);
    assert.equal(admitTgLine("50 usdg", undefined as unknown as TgGateCtx).ok, false);
    assert.equal(reason("lol", { recentOwn: "nope" as never }), "ok");
  });
});

// ── cost ────────────────────────────────────────────────────────────────────

describe("the gate stays cheap on hostile input", () => {
  it("a long run of separators, marks and letters is judged quickly", () => {
    const hostile = [
      `${"a ".repeat(2000)}`,
      `${"1.".repeat(2000)}`,
      `${"á̂̃".repeat(1000)}`,
      `${"​ ".repeat(2000)}lol`,
      `${"x dot ".repeat(700)}`,
      `lol ${"🔥".repeat(1000)}`,
    ];
    const t0 = Date.now();
    for (const h of hostile) admitTgLine(h, ctx({ kind: "coin" }));
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  });
});
