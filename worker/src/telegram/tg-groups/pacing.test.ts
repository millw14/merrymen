/**
 * When it speaks. Every branch of `decide` and every cap, with the clock and
 * the dice fixed: `rand` here is a scripted sequence that FAILS the test when
 * a branch rolls more often than it should, so "this path does not roll"
 * is checked too, not just what it returns.
 *
 * The rooms are built by hand so each case says exactly what the chat held.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CHATTINESS,
  FLOOD_ANSWERS,
  FLOOD_WINDOW_MS,
  REACTION_FOR,
  REACTIONS,
  SendPacer,
  decide,
  isFlooded,
  typingDelayMs,
  type PaceDecision,
  type PaceInput,
  type ReactionKey,
} from "./pacing";
import type { TgLine, TgPerson, TgRoom } from "./types";

const MIN = 60_000;
const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
const TODAY = "2026-09-28";
const YESTERDAY = "2026-09-27";
const BOT_ID = 777;
const OWNER = 1;
const ALICE = 2;
const BOB = 3;
const CAROL = 4;
const CA = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

let nextId = 1;
function mk(fromId: number, text: string, agoMs: number, extra: Partial<TgLine> = {}): TgLine {
  return { messageId: nextId++, fromId, name: `u${fromId}`, text, atMs: NOW - agoMs, ...extra };
}
const own = (text: string, agoMs: number, extra: Partial<TgLine> = {}) => mk(BOT_ID, text, agoMs, { own: true, ...extra });

function room(over: Partial<TgRoom> = {}): TgRoom {
  return {
    chatId: -100123,
    title: "degens",
    status: "approved",
    kind: "supergroup",
    statusAtMs: NOW - 30 * 24 * 60 * MIN,
    lines: [],
    sinceSummary: 0,
    summary: "",
    people: [],
    coins: [],
    claims: {},
    ...over,
  };
}

/** A lively chat: three people in the last few minutes, the bot silent all day. */
function liveLines(): TgLine[] {
  return [mk(BOB, "anyone watching this", 5 * MIN), mk(CAROL, "yeah it's moving", 4 * MIN), mk(BOB, "nice", 3 * MIN)];
}

type Signals = PaceInput["signals"];
const quiet: Signals = {
  shush: false,
  greeting: null,
  insult: "none",
  distress: false,
  botQuestion: false,
  privateAsk: false,
  injection: false,
  tradeTalk: false,
  questionToRoom: false,
  knownCoin: false,
};

/** Scripted dice: hands out `values` in order and fails on one roll too many. */
function dice(...values: number[]): { rand: () => number; left: () => number } {
  const q = [...values];
  return {
    rand: () => {
      if (q.length === 0) throw new Error("rolled more dice than the branch should");
      return q.shift() as number;
    },
    left: () => q.length,
  };
}
const NO_DICE = () => {
  throw new Error("this branch must not roll");
};

function input(over: Partial<Omit<PaceInput, "signals">> & { signals?: Partial<Signals> } = {}): PaceInput {
  const { signals, ...rest } = over;
  return {
    room: room({ lines: liveLines() }),
    line: mk(ALICE, "hello there", 0),
    addressed: null,
    isOwner: false,
    fromIsBot: false,
    chattiness: "normal",
    nowMs: NOW,
    rand: NO_DICE,
    hasModel: true,
    ...rest,
    signals: { ...quiet, ...signals },
  };
}

/** decide, asserting every scripted roll was used. */
function run(i: Omit<PaceInput, "rand">, ...rolls: number[]) {
  const d = dice(...rolls);
  const out = decide({ ...i, rand: d.rand });
  assert.equal(d.left(), 0, `unused rolls: ${d.left()}`);
  return out;
}

const person = (id: number, extra: Partial<TgPerson> = {}): TgPerson => ({ id, name: `u${id}`, note: "", lastSeenMs: NOW, ...extra });

// ─── Constants ─────────────────────────────────────────────────────────────

describe("constants", () => {
  it("chattiness matches the contract", () => {
    assert.deepEqual(CHATTINESS, {
      quiet: { odds: 0.02, cooldownMs: 90 * MIN, perDay: 3 },
      normal: { odds: 0.05, cooldownMs: 35 * MIN, perDay: 8 },
      chatty: { odds: 0.1, cooldownMs: 15 * MIN, perDay: 16 },
    });
  });

  it("REACTIONS is exactly the contract's subset, code point for code point", () => {
    const contract = "👍 🔥 🤣 😁 🤔 👀 💯 🫡 🤝 😭 🗿 🤡 😎 🥱 🙈 🤷 ❤ 😴 👏 🎉 🙏 🤯 😱".split(" ");
    assert.deepEqual([...REACTIONS], contract);
    assert.equal(new Set(REACTIONS).size, REACTIONS.length);
    // The heart has no U+FE0F: Telegram's list carries the bare U+2764.
    assert.ok(REACTIONS.includes("❤"));
    assert.ok(!REACTIONS.some((e) => e.includes("️")));
  });

  it("every REACTIONS emoji is one Telegram allows as ReactionTypeEmoji", () => {
    const telegram = new Set(
      "❤ 👍 👎 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷 😡".split(" "),
    );
    for (const e of REACTIONS) assert.ok(telegram.has(e), `${e} is not a Telegram reaction`);
  });

  it("REACTION_FOR covers every mood and draws only from REACTIONS", () => {
    const moods: ReactionKey[] = ["funny", "agree", "hype", "sad", "thinking", "look", "respect", "bored", "clown", "love", "gm", "gn", "shush"];
    // The type says every key has a list; this says there are no others.
    assert.deepEqual(Object.keys(REACTION_FOR).sort(), [...moods].sort());
    for (const mood of moods) {
      const list = REACTION_FOR[mood];
      assert.ok(list.length > 0, mood);
      for (const e of list) assert.ok(REACTIONS.includes(e), `${mood}: ${e}`);
    }
  });
});

// ─── decide: the gates before anything else ───────────────────────────────

describe("decide: who and where", () => {
  it("skips a bot's line, even addressed and even in distress", () => {
    assert.deepEqual(decide(input({ fromIsBot: true, addressed: "mention", signals: { distress: true } })), { act: "skip", why: "bot" });
  });

  it("reads a line with fromIsBot false as a human's, whatever else it carries (an anonymous admin, a channel post)", () => {
    // GroupAnonymousBot's placeholder user id: the `from` of an anonymous
    // admin's line. It has is_bot true, but the line also has a sender_chat,
    // so the caller passes fromIsBot = is_bot && no sender_chat = false.
    const ANON_ADMIN = 1087968824;
    const said = (text: string) => mk(ANON_ADMIN, text, 0);
    const cases: Array<[label: string, over: NonNullable<Parameters<typeof input>[0]>, rolls: number[], want: PaceDecision]> = [
      ["mentioned", { addressed: "mention" }, [], { act: "answer", mood: "normal" }],
      ["replied to", { addressed: "reply", signals: { insult: "insult" } }, [], { act: "roast", owner: false }],
      ["teasing by name", { addressed: "name", signals: { insult: "tease" } }, [], { act: "roast", owner: false }],
      ["hateful", { addressed: "mention", signals: { insult: "hateful" } }, [], { act: "react", emoji: "🤡" }],
      ["in distress", { signals: { distress: true } }, [], { act: "kind" }],
      ["shushing it", { addressed: "mention", signals: { shush: true } }, [], { act: "shush" }],
      ["asking if it is a bot", { addressed: "name", signals: { botQuestion: true } }, [], { act: "answer", mood: "bot-question" }],
      ["asking for its wallet", { addressed: "mention", signals: { privateAsk: true } }, [], { act: "answer", mood: "private-ask" }],
      ["steering it", { addressed: "reply", signals: { injection: true } }, [], { act: "answer", mood: "injection" }],
      ["saying gm to it", { addressed: "mention", signals: { greeting: "gm" } }, [], { act: "greet", word: "gm" }],
      ["saying gm to the room", { signals: { greeting: "gm" } }, [0.1], { act: "greet", word: "gm" }],
      ["talking trades", { signals: { tradeTalk: true } }, [0.09], { act: "ambient", topic: "trade" }],
      ["posting a CA", { line: said(`look at ${CA}`) }, [], { act: "skip", why: "coin-flow" }],
      ["insulting someone else", { signals: { insult: "insult" } }, [], { act: "skip", why: "not-ours" }],
    ];
    for (const [label, over, rolls, want] of cases) {
      const base = { line: said("hello there"), isOwner: false, ...over };
      assert.deepEqual(run(input({ ...base, fromIsBot: false }), ...rolls), want, label);
      // The same line with fromIsBot true is a bot's, and nothing else is read.
      assert.deepEqual(run(input({ ...base, fromIsBot: true })), { act: "skip", why: "bot" }, `${label}, from a bot`);
    }
  });

  it("skips its own line", () => {
    assert.deepEqual(decide(input({ line: own("hi", 0), addressed: "name" })), { act: "skip", why: "own" });
  });

  for (const status of ["pending", "left", "blocked"] as const) {
    it(`says nothing in a ${status} chat, not even the kind line`, () => {
      const r = room({ status, lines: liveLines() });
      assert.deepEqual(decide(input({ room: r, addressed: "mention", signals: { distress: true } })), { act: "skip", why: "not-approved" });
    });
  }
});

describe("decide: distress", () => {
  it("is kind to a line in distress, addressed or not", () => {
    assert.deepEqual(decide(input({ signals: { distress: true } })), { act: "kind" });
    assert.deepEqual(decide(input({ addressed: "reply", signals: { distress: true, insult: "insult" } })), { act: "kind" });
  });

  it("wins over a shushed chat, a flood and a hateful line", () => {
    const r = room({ lines: liveLines(), shushedUntilMs: NOW + 10 * MIN, people: [person(ALICE, { answers: { count: 9, sinceMs: NOW - MIN } })] });
    assert.deepEqual(decide(input({ room: r, addressed: "mention", signals: { distress: true, insult: "hateful", shush: true } })), { act: "kind" });
  });

  it("does not repeat itself within the hour once it has been kind", () => {
    const sad = mk(ALICE, "i want to die", 20 * MIN);
    const reply = own("hey, i'm here. please talk to someone you trust", 19 * MIN, { replyTo: sad.messageId });
    const r = room({ lines: [...liveLines(), sad, reply] });
    assert.deepEqual(decide(input({ room: r, line: mk(ALICE, "i can't do this anymore", 0), signals: { distress: true } })), {
      act: "skip",
      why: "kind-recent",
    });
  });

  it("counts an unthreaded line of its own after the distress line as the kind line", () => {
    const sad = mk(ALICE, "kms", 10 * MIN);
    const r = room({ lines: [sad, own("hey, that sounds rough", 9 * MIN)] });
    assert.equal(decide(input({ room: r, line: mk(ALICE, "i lost everything", 0), signals: { distress: true } })).act, "skip");
  });

  it("is kind again after the hour", () => {
    const sad = mk(ALICE, "i want to die", 61 * MIN);
    const r = room({ lines: [sad, own("i'm here", 60.5 * MIN, { replyTo: sad.messageId })] });
    assert.deepEqual(decide(input({ room: r, line: mk(ALICE, "i want to die", 0), signals: { distress: true } })), { act: "kind" });
  });

  it("is kind when the earlier distress line never got an answer", () => {
    const r = room({ lines: [mk(ALICE, "i want to die", 10 * MIN)] });
    assert.deepEqual(decide(input({ room: r, line: mk(ALICE, "kms", 0), signals: { distress: true } })), { act: "kind" });
  });

  it("is kind when its later line answered somebody else", () => {
    const sad = mk(ALICE, "i want to die", 10 * MIN);
    const other = mk(BOB, "pine?", 9 * MIN);
    const r = room({ lines: [sad, other, own("yo", 8 * MIN, { replyTo: other.messageId })] });
    assert.deepEqual(decide(input({ room: r, line: mk(ALICE, "kms", 0), signals: { distress: true } })), { act: "kind" });
  });

  it("is kind to a different person even right after being kind to someone", () => {
    const sad = mk(ALICE, "i want to die", 5 * MIN);
    const r = room({ lines: [sad, own("i'm here", 4 * MIN, { replyTo: sad.messageId })] });
    assert.deepEqual(decide(input({ room: r, line: mk(BOB, "same honestly i want to die", 0), signals: { distress: true } })), { act: "kind" });
  });

  it("does not count the line in hand as an earlier distress line", () => {
    const line = mk(ALICE, "i want to die", 0);
    const r = room({ lines: [line, own("unrelated", 0)] });
    assert.deepEqual(decide(input({ room: r, line, signals: { distress: true } })), { act: "kind" });
  });
});

describe("decide: shush", () => {
  it("goes quiet when told to, addressed", () => {
    assert.deepEqual(decide(input({ addressed: "mention", signals: { shush: true } })), { act: "shush" });
  });

  it("goes quiet when told to right after its own line", () => {
    const r = room({ lines: [...liveLines(), own("ngl this looks fun", 2 * MIN)] });
    assert.deepEqual(decide(input({ room: r, signals: { shush: true } })), { act: "shush" });
  });

  it("reads room.lastOwnAtMs when its own line is not in the lines", () => {
    const r = room({ lines: liveLines(), lastOwnAtMs: NOW - MIN });
    assert.deepEqual(decide(input({ room: r, signals: { shush: true } })), { act: "shush" });
  });

  it("does not take a shush aimed elsewhere: its line too old, or a human spoke after it", () => {
    const old = room({ lines: [...liveLines(), own("hm", 6 * MIN)] });
    assert.deepEqual(decide(input({ room: old, signals: { shush: true } })), { act: "skip", why: "not-ours" });
    const after = room({ lines: [own("hm", 2 * MIN), mk(BOB, "lol", MIN)] });
    assert.deepEqual(decide(input({ room: after, signals: { shush: true } })), { act: "skip", why: "not-ours" });
  });

  it("does not take a shush replying to somebody else's message, even right after its own line", () => {
    // Bob brags, it says something, Ann replies to BOB: "shut up bob lol".
    // That muted the whole chat for 30 minutes and answered "ok ok 🤐".
    const brag = mk(BOB, "called the bottom again", 3 * MIN);
    const r = room({ lines: [...liveLines(), brag, own("lol nice", 2 * MIN)] });
    const line = mk(ALICE, "shut up bob lol", 0, { replyTo: brag.messageId });
    assert.deepEqual(decide(input({ room: r, line, signals: { shush: true } })), { act: "skip", why: "not-ours" });
    // …and a question threaded to somebody else is not asked of it either.
    const q = mk(ALICE, "are you a bot bob?", 0, { replyTo: brag.messageId });
    assert.equal(decide(input({ room: r, line: q, signals: { botQuestion: true } })).act, "skip");
    // Unthreaded, the same shush right after its line is at it.
    assert.deepEqual(decide(input({ room: r, line: mk(ALICE, "shut up lol", 0), signals: { shush: true } })), { act: "shush" });
  });

  it("while already shushed, only the owner's shush counts again", () => {
    const r = room({ lines: liveLines(), shushedUntilMs: NOW + 20 * MIN });
    assert.deepEqual(decide(input({ room: r, addressed: "mention", signals: { shush: true } })), { act: "skip", why: "shushed" });
    assert.deepEqual(decide(input({ room: r, addressed: "mention", isOwner: true, line: mk(OWNER, "shush", 0), signals: { shush: true } })), {
      act: "shush",
    });
  });

  it("wins over an insult (\"shut up you dumb bot\")", () => {
    assert.deepEqual(decide(input({ addressed: "name", signals: { shush: true, insult: "insult" } })), { act: "shush" });
  });
});

describe("decide: a shushed chat", () => {
  const r = () => room({ lines: liveLines(), shushedUntilMs: NOW + 5 * MIN });

  it("skips everyone who is not the owner addressing it", () => {
    assert.deepEqual(decide(input({ room: r() })), { act: "skip", why: "shushed" });
    assert.deepEqual(decide(input({ room: r(), addressed: "mention" })), { act: "skip", why: "shushed" });
    assert.deepEqual(decide(input({ room: r(), isOwner: true })), { act: "skip", why: "shushed" });
    assert.deepEqual(decide(input({ room: r(), signals: { greeting: "gm" } })), { act: "skip", why: "shushed" });
  });

  it("still answers the owner when addressed", () => {
    assert.deepEqual(decide(input({ room: r(), addressed: "reply", isOwner: true })), { act: "answer", mood: "normal" });
  });

  it("is over once shushedUntilMs has passed", () => {
    const done = room({ lines: liveLines(), shushedUntilMs: NOW });
    assert.deepEqual(decide(input({ room: done, addressed: "mention" })), { act: "answer", mood: "normal" });
  });
});

describe("decide: flood", () => {
  it("is six answers to one person inside two minutes: three silenced a normal back-and-forth", () => {
    assert.equal(FLOOD_ANSWERS, 6);
    assert.equal(FLOOD_WINDOW_MS, 2 * MIN);
  });

  it(`stops answering a person after ${FLOOD_ANSWERS} answers inside 2 minutes`, () => {
    const r = room({ lines: liveLines(), people: [person(ALICE, { answers: { count: FLOOD_ANSWERS, sinceMs: NOW - MIN } })] });
    assert.deepEqual(decide(input({ room: r, addressed: "mention" })), { act: "skip", why: "flood" });
  });

  it("never applies to the owner: a chat with the person it trades for is not a flood", () => {
    const r = room({ lines: liveLines(), people: [person(OWNER, { answers: { count: 20, sinceMs: NOW - 30_000 } })] });
    assert.deepEqual(decide(input({ room: r, addressed: "mention", isOwner: true, line: mk(OWNER, "yo", 0) })), { act: "answer", mood: "normal" });
    // Someone else with the owner's count is flooded.
    const other = room({ lines: liveLines(), people: [person(ALICE, { answers: { count: 20, sinceMs: NOW - 30_000 } })] });
    assert.deepEqual(decide(input({ room: other, addressed: "mention" })), { act: "skip", why: "flood" });
  });

  it("isFlooded is the rule the handler's coin lines read too", () => {
    const full = { answers: { count: FLOOD_ANSWERS, sinceMs: NOW - MIN } };
    assert.equal(isFlooded(full, false, NOW), true);
    assert.equal(isFlooded(full, true, NOW), false, "never the owner");
    assert.equal(isFlooded({ answers: { count: FLOOD_ANSWERS - 1, sinceMs: NOW - MIN } }, false, NOW), false);
    assert.equal(isFlooded(full, false, NOW - MIN + FLOOD_WINDOW_MS), false, "the window closes");
    assert.equal(isFlooded(undefined, false, NOW), false);
    assert.equal(isFlooded({ answers: { count: Number.NaN, sinceMs: NOW } }, false, NOW), false);
  });

  it("answers up to the last answer of the window, and again once the window has passed", () => {
    const two = room({ lines: liveLines(), people: [person(ALICE, { answers: { count: FLOOD_ANSWERS - 1, sinceMs: NOW - MIN } })] });
    assert.deepEqual(decide(input({ room: two, addressed: "mention" })), { act: "answer", mood: "normal" });
    const stale = room({ lines: liveLines(), people: [person(ALICE, { answers: { count: FLOOD_ANSWERS, sinceMs: NOW - 2 * MIN } })] });
    assert.deepEqual(decide(input({ room: stale, addressed: "mention" })), { act: "answer", mood: "normal" });
  });

  it("counts only this person's answers", () => {
    const r = room({ lines: liveLines(), people: [person(BOB, { answers: { count: 9, sinceMs: NOW - MIN } })] });
    assert.deepEqual(decide(input({ room: r, addressed: "mention" })), { act: "answer", mood: "normal" });
  });
});

// ─── decide: addressed ─────────────────────────────────────────────────────

describe("decide: addressed", () => {
  for (const how of ["mention", "reply", "name"] as const) {
    it(`answers a ${how}`, () => assert.deepEqual(decide(input({ addressed: how })), { act: "answer", mood: "normal" }));
  }

  it("answers without a model too (templates), and a CA line addressed to it is still answered", () => {
    assert.deepEqual(decide(input({ addressed: "mention", hasModel: false })), { act: "answer", mood: "normal" });
    assert.deepEqual(decide(input({ addressed: "mention", line: mk(ALICE, `pine look ${CA}`, 0) })), { act: "answer", mood: "normal" });
  });

  it("answers in a dead chat and during the cooldown: being called is not joining in", () => {
    const r = room({ lines: [], lastOwnAtMs: NOW - MIN, ambient: { day: TODAY, n: 99 } });
    assert.deepEqual(decide(input({ room: r, addressed: "name" })), { act: "answer", mood: "normal" });
  });

  it("never mirrors a hateful line: 🤡, owner or not", () => {
    assert.deepEqual(decide(input({ addressed: "mention", signals: { insult: "hateful" } })), { act: "react", emoji: "🤡" });
    assert.deepEqual(decide(input({ addressed: "mention", isOwner: true, signals: { insult: "hateful", botQuestion: true } })), {
      act: "react",
      emoji: "🤡",
    });
  });

  const moods: Array<[string, Partial<Signals>, string]> = [
    ["injection", { injection: true }, "injection"],
    ["bot question", { botQuestion: true }, "bot-question"],
    ["private ask", { privateAsk: true }, "private-ask"],
    ["injection over a bot question", { injection: true, botQuestion: true }, "injection"],
    ["bot question over a private ask", { botQuestion: true, privateAsk: true }, "bot-question"],
    ["bot question over an insult", { botQuestion: true, insult: "insult" }, "bot-question"],
    ["private ask over an insult", { privateAsk: true, insult: "insult" }, "private-ask"],
    ["injection over a tease", { injection: true, insult: "tease" }, "injection"],
  ];
  for (const [label, signals, mood] of moods) {
    it(`mood: ${label}`, () => assert.deepEqual(decide(input({ addressed: "mention", signals })), { act: "answer", mood }));
  }

  it("roasts an insult back, affectionately for the owner", () => {
    assert.deepEqual(decide(input({ addressed: "mention", signals: { insult: "insult" } })), { act: "roast", owner: false });
    assert.deepEqual(decide(input({ addressed: "mention", isOwner: true, line: mk(OWNER, "ur slow lol", 0), signals: { insult: "insult" } })), {
      act: "roast",
      owner: true,
    });
  });

  it("teases a tease back (a roast), the owner's too", () => {
    assert.deepEqual(decide(input({ addressed: "reply", signals: { insult: "tease" } })), { act: "roast", owner: false });
    assert.deepEqual(decide(input({ addressed: "reply", isOwner: true, line: mk(OWNER, "caught you", 0), signals: { insult: "tease" } })), {
      act: "roast",
      owner: true,
    });
  });

  it("roasts the second exchange, then disengages after 2 in 30 minutes: 🥱 or silence", () => {
    const one = room({ lines: liveLines(), people: [person(ALICE, { roasts: { count: 1, sinceMs: NOW - 10 * MIN } })] });
    assert.deepEqual(decide(input({ room: one, addressed: "mention", signals: { insult: "insult" } })), { act: "roast", owner: false });
    const capped = room({ lines: liveLines(), people: [person(ALICE, { roasts: { count: 2, sinceMs: NOW - 10 * MIN } })] });
    const i = input({ room: capped, addressed: "mention", signals: { insult: "insult" } });
    assert.deepEqual(run(i, 0.3), { act: "react", emoji: "🥱" });
    assert.deepEqual(run(i, 0.7), { act: "skip", why: "roast-cap" });
  });

  it("roasts again once the 30-minute window has passed", () => {
    const r = room({ lines: liveLines(), people: [person(ALICE, { roasts: { count: 5, sinceMs: NOW - 30 * MIN } })] });
    assert.deepEqual(decide(input({ room: r, addressed: "mention", signals: { insult: "tease" } })), { act: "roast", owner: false });
  });

  it("never leaves the owner on read past the roast cap", () => {
    const r = room({ lines: liveLines(), people: [person(OWNER, { roasts: { count: 2, sinceMs: NOW - MIN } })] });
    const i = input({ room: r, addressed: "mention", isOwner: true, line: mk(OWNER, "clown", 0), signals: { insult: "insult" } });
    assert.deepEqual(decide(i), { act: "answer", mood: "normal" });
  });

  it("greets back an addressed gm or gn, whether or not it greeted them today", () => {
    assert.deepEqual(decide(input({ addressed: "name", signals: { greeting: "gm" } })), { act: "greet", word: "gm" });
    const r = room({ lines: liveLines(), people: [person(ALICE, { greetedDay: TODAY })] });
    assert.deepEqual(decide(input({ room: r, addressed: "name", signals: { greeting: "gn" } })), { act: "greet", word: "gn" });
  });

  it("answers small talk with small talk, not a normal answer (\"hi merryman 👋\" is not a question)", () => {
    for (const what of ["hail", "thanks", "gm", "gn"] as const) {
      assert.deepEqual(decide(input({ addressed: "mention", signals: { smallTalk: what } })), { act: "smalltalk", what });
    }
    // Without a model too: it is a template either way.
    assert.deepEqual(decide(input({ addressed: "name", hasModel: false, signals: { smallTalk: "hail" } })), { act: "smalltalk", what: "hail" });
    // No small-talk reading (a caller that does not pass one): the normal answer, as before.
    assert.deepEqual(decide(input({ addressed: "mention", signals: { smallTalk: null } })), { act: "answer", mood: "normal" });
  });

  it("small talk comes after everything that says more: hateful, honesty, privacy, a roast, a greeting", () => {
    const talk = (signals: Partial<Signals>) => decide(input({ addressed: "mention", signals: { smallTalk: "hail", ...signals } }));
    assert.deepEqual(talk({ insult: "hateful" }), { act: "react", emoji: "🤡" });
    assert.deepEqual(talk({ botQuestion: true }), { act: "answer", mood: "bot-question" });
    assert.deepEqual(talk({ privateAsk: true }), { act: "answer", mood: "private-ask" });
    assert.deepEqual(talk({ injection: true }), { act: "answer", mood: "injection" });
    assert.deepEqual(talk({ insult: "insult" }), { act: "roast", owner: false });
    assert.deepEqual(talk({ greeting: "gm" }), { act: "greet", word: "gm" });
  });

  it("small talk still keeps the flood and shush rules, and is never said unaddressed", () => {
    const flooded = room({ lines: liveLines(), people: [person(ALICE, { answers: { count: FLOOD_ANSWERS, sinceMs: NOW - MIN } })] });
    assert.deepEqual(decide(input({ room: flooded, addressed: "mention", signals: { smallTalk: "thanks" } })), { act: "skip", why: "flood" });
    const shushed = room({ lines: liveLines(), shushedUntilMs: NOW + MIN });
    assert.deepEqual(decide(input({ room: shushed, addressed: "mention", signals: { smallTalk: "hail" } })), { act: "skip", why: "shushed" });
    assert.deepEqual(run(input({ signals: { smallTalk: "hail" } }), 0.9), { act: "skip", why: "roll" });
  });
});

// ─── decide: not addressed ─────────────────────────────────────────────────

describe("decide: other people's business", () => {
  const cases: Array<[string, Partial<Signals>]> = [
    ["an insult between others", { insult: "insult" }],
    ["a hateful line not aimed at it", { insult: "hateful" }],
    ["an injection not aimed at it", { injection: true }],
    ["a private ask not aimed at it", { privateAsk: true }],
    ["a shush aimed elsewhere", { shush: true }],
  ];
  for (const [label, signals] of cases) {
    it(`stays out of ${label}, without rolling`, () => assert.deepEqual(decide(input({ signals })), { act: "skip", why: "not-ours" }));
  }

  it("answers \"are you a bot?\" right after its own line (honesty)", () => {
    const r = room({ lines: [...liveLines(), own("lol same", MIN)] });
    assert.deepEqual(decide(input({ room: r, signals: { botQuestion: true } })), { act: "answer", mood: "bot-question" });
  });

  it("treats a bot question elsewhere as ordinary chat", () => {
    assert.deepEqual(run(input({ signals: { botQuestion: true } }), 0.9), { act: "skip", why: "roll" });
  });

  it("leaves a CA line to the coin flow, without rolling", () => {
    assert.deepEqual(decide(input({ line: mk(ALICE, `new one ${CA} 🚀`, 0), signals: { tradeTalk: true } })), { act: "skip", why: "coin-flow" });
  });

  it("lets a tease between others through to the ordinary rules", () => {
    assert.deepEqual(run(input({ signals: { insult: "tease" } }), 0.01), { act: "ambient", topic: "banter" });
  });
});

describe("decide: an insult at a bot right after its own line", () => {
  // It said "nah i'll pass"; Bob answers "stupid bot lol" without replying to
  // it. That is at it, and used to be skipped as somebody else's fight.
  const afterOwn = () => room({ lines: [...liveLines(), own("nah i'll pass", MIN)] });

  it("roasts back, without rolling, affectionately for the owner", () => {
    const line = mk(BOB, "stupid bot lol", 0);
    assert.deepEqual(decide(input({ room: afterOwn(), line, signals: { insult: "insult" } })), { act: "roast", owner: false });
    const ownerLine = mk(OWNER, "ok bot", 0);
    assert.deepEqual(decide(input({ room: afterOwn(), line: ownerLine, isOwner: true, signals: { insult: "tease" } })), { act: "roast", owner: true });
  });

  it("is held to the roast cap: past it, silence without a 🥱 roll", () => {
    const r = room({ lines: [...liveLines(), own("nah i'll pass", MIN)], people: [person(BOB, { roasts: { count: 2, sinceMs: NOW - 10 * MIN } })] });
    assert.deepEqual(decide(input({ room: r, line: mk(BOB, "this ai is trash", 0), signals: { insult: "insult" } })), { act: "skip", why: "roast-cap" });
  });

  it("needs a bot word: \"you idiot\" after its line may be for whoever it answered", () => {
    assert.deepEqual(decide(input({ room: afterOwn(), line: mk(BOB, "you idiot", 0), signals: { insult: "insult" } })), { act: "skip", why: "not-ours" });
  });

  it("needs its line to be the newest and recent; a hateful one is never mirrored", () => {
    const old = room({ lines: [...liveLines(), own("nah i'll pass", 10 * MIN)] });
    assert.deepEqual(decide(input({ room: old, line: mk(BOB, "stupid bot lol", 0), signals: { insult: "insult" } })), { act: "skip", why: "not-ours" });
    const talkedOver = room({ lines: [own("nah i'll pass", 2 * MIN), mk(CAROL, "lol", MIN)] });
    assert.deepEqual(decide(input({ room: talkedOver, line: mk(BOB, "stupid bot lol", 0), signals: { insult: "insult" } })), { act: "skip", why: "not-ours" });
    assert.deepEqual(decide(input({ room: afterOwn(), line: mk(BOB, "stupid bot lol", 0), signals: { insult: "hateful" } })), { act: "skip", why: "not-ours" });
  });
});

describe("decide: gm / gn not addressed", () => {
  it("answers 35% of the time, once per person per UTC day", () => {
    assert.deepEqual(run(input({ signals: { greeting: "gm" } }), 0.34), { act: "greet", word: "gm" });
    const yesterday = room({ lines: liveLines(), people: [person(ALICE, { greetedDay: YESTERDAY })] });
    assert.deepEqual(run(input({ room: yesterday, signals: { greeting: "gn" } }), 0.1), { act: "greet", word: "gn" });
  });

  it("otherwise sometimes reacts instead", () => {
    // normal: 0.05 × 2 = 10% for the reaction, then the pick.
    assert.deepEqual(run(input({ signals: { greeting: "gm" } }), 0.5, 0.09, 0), { act: "react", emoji: REACTION_FOR.gm[0] });
    assert.deepEqual(run(input({ signals: { greeting: "gn" } }), 0.5, 0.05, 0.99), { act: "react", emoji: REACTION_FOR.gn[REACTION_FOR.gn.length - 1] });
    assert.deepEqual(run(input({ signals: { greeting: "gm" } }), 0.5, 0.11), { act: "skip", why: "greeting" });
  });

  it("does not greet a person twice in one UTC day: straight to the reaction roll", () => {
    const r = room({ lines: liveLines(), people: [person(ALICE, { greetedDay: TODAY })] });
    assert.deepEqual(run(input({ room: r, signals: { greeting: "gm" } }), 0.01, 0), { act: "react", emoji: REACTION_FOR.gm[0] });
    assert.deepEqual(run(input({ room: r, signals: { greeting: "gm" } }), 0.5), { act: "skip", why: "greeting" });
  });

  it("counts a greeting against the day's cap, and a reaction as half", () => {
    const full = room({ lines: liveLines(), ambient: { day: TODAY, n: 8 } });
    assert.deepEqual(decide(input({ room: full, signals: { greeting: "gm" } })), { act: "skip", why: "greeting" });
    // 7.5 used: no room for a greeting (1), room for a reaction (0.5).
    const half = room({ lines: liveLines(), ambient: { day: TODAY, n: 7.5 } });
    assert.deepEqual(run(input({ room: half, signals: { greeting: "gm" } }), 0.01, 0), { act: "react", emoji: REACTION_FOR.gm[0] });
  });

  it("greets in a chat the greeting itself woke up (no live-chat rule for gm)", () => {
    assert.deepEqual(run(input({ room: room(), signals: { greeting: "gm" } }), 0.2), { act: "greet", word: "gm" });
  });
});

describe("decide: ambient eligibility", () => {
  it("joins in on a live chat when the roll lands under the odds", () => {
    assert.deepEqual(run(input(), 0.049), { act: "ambient", topic: "banter" });
    assert.deepEqual(run(input(), 0.05), { act: "skip", why: "roll" });
  });

  it("says nothing in a dead chat, without rolling", () => {
    assert.deepEqual(decide(input({ room: room() })), { act: "skip", why: "dead" });
    const stale = room({ lines: [mk(BOB, "anyone?", 11 * MIN)] });
    assert.deepEqual(decide(input({ room: stale })), { act: "skip", why: "dead" });
  });

  it("does not count the line in hand, or its own lines, as life in the chat", () => {
    const line = mk(ALICE, "hello?", 0);
    assert.deepEqual(decide(input({ room: room({ lines: [line] }), line })), { act: "skip", why: "dead" });
    // (its own line also starts the cooldown, so pass the cooldown for this check)
    const ownOnly = room({ lines: [own("gm", 5 * MIN)] });
    assert.deepEqual(decide(input({ room: ownOnly, chattiness: "chatty" })), { act: "skip", why: "dead" });
  });

  it("waits out the cooldown after it last spoke", () => {
    for (const r of [
      room({ lines: liveLines(), lastOwnAtMs: NOW - 34 * MIN }),
      room({ lines: liveLines(), lastAmbientAtMs: NOW - 34 * MIN }),
      room({ lines: [...liveLines(), own("lol", 6 * MIN)] }),
    ]) {
      assert.deepEqual(decide(input({ room: r })), { act: "skip", why: "cooldown" });
    }
    assert.deepEqual(run(input({ room: room({ lines: liveLines(), lastOwnAtMs: NOW - 35 * MIN }) }), 0.01), { act: "ambient", topic: "banter" });
  });

  it("uses each chattiness's own cooldown", () => {
    const r = room({ lines: liveLines(), lastAmbientAtMs: NOW - 20 * MIN });
    assert.deepEqual(run(input({ room: r, chattiness: "chatty" }), 0.01), { act: "ambient", topic: "banter" });
    assert.deepEqual(decide(input({ room: r, chattiness: "normal" })), { act: "skip", why: "cooldown" });
    const r2 = room({ lines: liveLines(), lastAmbientAtMs: NOW - 60 * MIN });
    assert.deepEqual(decide(input({ room: r2, chattiness: "quiet" })), { act: "skip", why: "cooldown" });
    assert.deepEqual(run(input({ room: r2, chattiness: "normal" }), 0.01), { act: "ambient", topic: "banter" });
  });

  for (const [level, cap] of [["quiet", 3], ["normal", 8], ["chatty", 16]] as const) {
    it(`stops at ${cap} ambient lines a day when ${level}`, () => {
      const full = room({ lines: liveLines(), ambient: { day: TODAY, n: cap } });
      assert.deepEqual(decide(input({ room: full, chattiness: level })), { act: "skip", why: "daily-cap" });
      const almost = room({ lines: liveLines(), ambient: { day: TODAY, n: cap - 0.5 } });
      assert.deepEqual(decide(input({ room: almost, chattiness: level })), { act: "skip", why: "daily-cap" });
      const one = room({ lines: liveLines(), ambient: { day: TODAY, n: cap - 1 } });
      assert.deepEqual(run(input({ room: one, chattiness: level }), 0), { act: "ambient", topic: "banter" });
    });
  }

  it("starts a fresh day at UTC midnight", () => {
    const r = room({ lines: liveLines(), ambient: { day: YESTERDAY, n: 99 } });
    assert.deepEqual(run(input({ room: r }), 0.049), { act: "ambient", topic: "banter" });
  });

  it("stays out of a two-person exchange: the last 6 lines from exactly two humans", () => {
    const pair = [mk(ALICE, "a", 5 * MIN), mk(BOB, "b", 4 * MIN), mk(ALICE, "c", 3 * MIN), mk(BOB, "d", 2 * MIN), mk(ALICE, "e", MIN)];
    const line = mk(BOB, "f", 0);
    assert.deepEqual(decide(input({ room: room({ lines: pair }), line })), { act: "skip", why: "pair" });
  });

  it("is not a two-person exchange with a third voice, fewer than 6 lines, or its own line among them", () => {
    const three = [mk(ALICE, "a", 5 * MIN), mk(BOB, "b", 4 * MIN), mk(CAROL, "c", 3 * MIN), mk(BOB, "d", 2 * MIN), mk(ALICE, "e", MIN)];
    assert.deepEqual(run(input({ room: room({ lines: three }), line: mk(BOB, "f", 0) }), 0.01), { act: "ambient", topic: "banter" });
    const short = [mk(ALICE, "a", 4 * MIN), mk(BOB, "b", 3 * MIN), mk(ALICE, "c", 2 * MIN), mk(BOB, "d", MIN)];
    assert.deepEqual(run(input({ room: room({ lines: short }), line: mk(ALICE, "e", 0) }), 0.01), { act: "ambient", topic: "banter" });
    const withOwn = [mk(ALICE, "a", 50 * MIN), own("x", 45 * MIN), mk(BOB, "b", 4 * MIN), mk(ALICE, "c", 3 * MIN), mk(BOB, "d", 2 * MIN)];
    assert.deepEqual(run(input({ room: room({ lines: withOwn }), line: mk(ALICE, "e", 0) }), 0.01), { act: "ambient", topic: "banter" });
  });

  it("reads the lines in time order even when stored out of order", () => {
    const pair = [mk(ALICE, "e", MIN), mk(BOB, "b", 4 * MIN), mk(ALICE, "a", 5 * MIN), mk(BOB, "d", 2 * MIN), mk(ALICE, "c", 3 * MIN)];
    assert.deepEqual(decide(input({ room: room({ lines: pair }), line: mk(BOB, "f", 0) })), { act: "skip", why: "pair" });
  });

  it("never joins in without a model, without rolling", () => {
    assert.deepEqual(decide(input({ hasModel: false, signals: { knownCoin: true } })), { act: "skip", why: "no-model" });
  });
});

describe("decide: ambient odds", () => {
  const at = (rollValue: number, signals: Partial<Signals> = {}, over: Partial<PaceInput> = {}) => run(input({ signals, ...over }), rollValue);

  it("×3 for a coin it holds or looked at", () => {
    assert.deepEqual(at(0.149, { knownCoin: true }), { act: "ambient", topic: "coin" });
    assert.deepEqual(at(0.151, { knownCoin: true }), { act: "skip", why: "roll" });
  });

  it("×2 for trading talk", () => {
    assert.deepEqual(at(0.099, { tradeTalk: true }), { act: "ambient", topic: "trade" });
    assert.deepEqual(at(0.101, { tradeTalk: true }), { act: "skip", why: "roll" });
  });

  it("the coin boost does not stack with the topic boost", () => {
    assert.deepEqual(at(0.16, { knownCoin: true, tradeTalk: true }), { act: "skip", why: "roll" });
    assert.deepEqual(at(0.14, { knownCoin: true, tradeTalk: true }), { act: "ambient", topic: "coin" });
  });

  it("×2 for a question to the room left hanging for a minute", () => {
    const q = mk(ALICE, "anyone know a good dex?", 61_000);
    const r = room({ lines: [mk(BOB, "gm", 5 * MIN), mk(CAROL, "gm", 4 * MIN), q] });
    assert.deepEqual(at(0.099, { questionToRoom: true }, { room: r, line: q }), { act: "ambient", topic: "question" });
  });

  it("no question boost when fresh, answered, or a reply to someone", () => {
    const fresh = mk(ALICE, "anyone?", 10_000);
    assert.deepEqual(at(0.099, { questionToRoom: true }, { line: fresh }), { act: "skip", why: "roll" });
    assert.deepEqual(at(0.049, { questionToRoom: true }, { line: fresh }), { act: "ambient", topic: "question" });

    const q = mk(ALICE, "anyone know a good dex?", 2 * MIN);
    const answered = room({ lines: [mk(CAROL, "gm", 5 * MIN), q, mk(BOB, "uniswap", MIN)] });
    assert.deepEqual(at(0.099, { questionToRoom: true }, { room: answered, line: q }), { act: "skip", why: "roll" });

    const reply = mk(ALICE, "why?", 2 * MIN, { replyTo: 5 });
    assert.deepEqual(at(0.099, { questionToRoom: true }, { line: reply }), { act: "skip", why: "roll" });
  });

  it("the asker talking on does not count as an answer", () => {
    const q = mk(ALICE, "anyone know a good dex?", 2 * MIN);
    const r = room({ lines: [mk(BOB, "gm", 5 * MIN), mk(CAROL, "gm", 4 * MIN), q, mk(ALICE, "hello??", MIN)] });
    assert.deepEqual(at(0.099, { questionToRoom: true }, { room: r, line: q }), { act: "ambient", topic: "question" });
  });

  it("falls by 0.7 per ambient line already said today, reactions counting half", () => {
    const two = room({ lines: liveLines(), ambient: { day: TODAY, n: 2 } });
    // 0.05 × 0.7² = 0.0245
    assert.deepEqual(at(0.0244, {}, { room: two }), { act: "ambient", topic: "banter" });
    assert.deepEqual(at(0.0246, {}, { room: two }), { act: "skip", why: "roll" });
    const half = room({ lines: liveLines(), ambient: { day: TODAY, n: 0.5 } });
    // 0.05 × 0.7^0.5 ≈ 0.04183
    assert.deepEqual(at(0.0418, {}, { room: half }), { act: "ambient", topic: "banter" });
    assert.deepEqual(at(0.0419, {}, { room: half }), { act: "skip", why: "roll" });
  });

  it("uses each chattiness's base odds, and falls back to normal for an unknown one", () => {
    assert.deepEqual(at(0.019, {}, { chattiness: "quiet" }), { act: "ambient", topic: "banter" });
    assert.deepEqual(at(0.021, {}, { chattiness: "quiet" }), { act: "skip", why: "roll" });
    assert.deepEqual(at(0.099, {}, { chattiness: "chatty" }), { act: "ambient", topic: "banter" });
    assert.deepEqual(at(0.049, {}, { chattiness: "loud" as never }), { act: "ambient", topic: "banter" });
  });

  it("does nothing optional when the dice are broken or read 1", () => {
    assert.deepEqual(at(Number.NaN, { knownCoin: true }), { act: "skip", why: "roll" });
    assert.deepEqual(at(1, { knownCoin: true }), { act: "skip", why: "roll" });
    assert.deepEqual(run(input({ signals: { greeting: "gm" } }), Number.NaN, Number.NaN), { act: "skip", why: "greeting" });
  });
});

describe("decide: reactions", () => {
  it("sometimes reacts to a funny or hype line when it does not speak", () => {
    const funny = mk(ALICE, "lmao 😂", 0);
    // ambient roll misses, reaction roll (0.05 × 2) lands, pick
    assert.deepEqual(run(input({ line: funny }), 0.9, 0.09, 0), { act: "react", emoji: REACTION_FOR.funny[0] });
    assert.deepEqual(run(input({ line: funny }), 0.9, 0.11), { act: "skip", why: "roll" });
    const hype = mk(ALICE, "LFG 🚀", 0);
    assert.deepEqual(run(input({ line: hype }), 0.9, 0.05, 0.5), { act: "react", emoji: REACTION_FOR.hype[2] });
  });

  it("reacts less to agreement, respect, love, a look or a sad line", () => {
    const agree = mk(ALICE, "facts", 0);
    assert.deepEqual(run(input({ line: agree }), 0.9, 0.049, 0), { act: "react", emoji: REACTION_FOR.agree[0] });
    assert.deepEqual(run(input({ line: agree }), 0.9, 0.051), { act: "skip", why: "roll" });
  });

  it("never reacts on its own to thinking, bored or clown lines", () => {
    for (const text of ["hmm idk", "zzz dead chat", "🤡"]) {
      assert.deepEqual(run(input({ line: mk(ALICE, text, 0) }), 0.9), { act: "skip", why: "roll" });
    }
  });

  it("can react while words are blocked, and says why the words were", () => {
    const funny = mk(ALICE, "hahaha", 0);
    const cooling = room({ lines: liveLines(), lastOwnAtMs: NOW - MIN });
    assert.deepEqual(run(input({ room: cooling, line: funny }), 0.05, 0), { act: "react", emoji: REACTION_FOR.funny[0] });
    assert.deepEqual(run(input({ room: cooling, line: funny }), 0.5), { act: "skip", why: "cooldown" });
    assert.deepEqual(run(input({ line: funny, hasModel: false }), 0.05, 0), { act: "react", emoji: REACTION_FOR.funny[0] });
    const pairLines = [mk(ALICE, "a", 5 * MIN), mk(BOB, "b", 4 * MIN), mk(ALICE, "c", 3 * MIN), mk(BOB, "d", 2 * MIN), mk(ALICE, "e", MIN)];
    assert.deepEqual(run(input({ room: room({ lines: pairLines }), line: mk(BOB, "lol", 0) }), 0.05, 0), { act: "react", emoji: REACTION_FOR.funny[0] });
  });

  it("keeps reactions inside the day's cap at half a line each", () => {
    const funny = mk(ALICE, "lol", 0);
    const over = room({ lines: liveLines(), ambient: { day: TODAY, n: 7.6 } });
    assert.deepEqual(decide(input({ room: over, line: funny })), { act: "skip", why: "daily-cap" });
    const fits = room({ lines: liveLines(), ambient: { day: TODAY, n: 7.5 } });
    assert.deepEqual(run(input({ room: fits, line: funny }), 0.05, 0), { act: "react", emoji: REACTION_FOR.funny[0] });
  });
});

describe("decide: a malformed room", () => {
  it("reads missing lines and people as empty instead of throwing", () => {
    const r = { ...room(), lines: undefined, people: undefined } as unknown as TgRoom;
    assert.deepEqual(decide(input({ room: r })), { act: "skip", why: "dead" });
    assert.deepEqual(decide(input({ room: r, addressed: "mention" })), { act: "answer", mood: "normal" });
  });

  it("ignores a malformed ambient counter", () => {
    const r = room({ lines: liveLines(), ambient: { day: TODAY, n: Number.NaN } });
    assert.deepEqual(run(input({ room: r }), 0.049), { act: "ambient", topic: "banter" });
  });
});

describe("decide: purity", () => {
  it("gives the same answer for the same input and never writes the room", () => {
    const r = room({
      lines: [...liveLines(), own("x", 40 * MIN)],
      people: [person(ALICE, { roasts: { count: 2, sinceMs: NOW - MIN }, answers: { count: 1, sinceMs: NOW - MIN } })],
      ambient: { day: TODAY, n: 1 },
    });
    const snapshot = JSON.parse(JSON.stringify(r));
    const i = { ...input({ room: r, signals: { tradeTalk: true } }) };
    const a = run(i, 0.05);
    const b = run(i, 0.05);
    assert.deepEqual(a, b);
    assert.deepEqual(r, snapshot);
  });
});

// ─── typingDelayMs ─────────────────────────────────────────────────────────

describe("typingDelayMs", () => {
  const cases: Array<[string, string, number]> = [
    ["empty is clamped up to 2 s", "", 2000],
    ["a short word is clamped up to 2 s", "hi", 2000],
    ["15 characters is exactly 2025 ms", "a".repeat(15), 2025],
    ["20 characters", "a".repeat(20), 2200],
    ["100 characters", "a".repeat(100), 5000],
    ["long lines are clamped to 9 s", "a".repeat(300), 9000],
    ["an emoji is one character, not two UTF-16 units", "🔥".repeat(100), 5000],
  ];
  for (const [label, text, want] of cases) {
    it(label, () => assert.equal(typingDelayMs(text, false, NO_DICE), want));
  }

  it("adds 5–40 s for an ambient line", () => {
    assert.equal(typingDelayMs("a".repeat(20), true, () => 0), 2200 + 5000);
    assert.equal(typingDelayMs("a".repeat(20), true, () => 0.5), 2200 + 5000 + 17500);
    assert.equal(typingDelayMs("a".repeat(20), true, () => 1), 2200 + 40000);
    assert.ok(typingDelayMs("a".repeat(20), true, () => 0.99) < 2200 + 40000);
    assert.ok(typingDelayMs("a".repeat(20), true, () => 0.999999) <= 2200 + 40000);
    assert.equal(typingDelayMs("a".repeat(20), true, () => Number.NaN), 2200 + 5000);
  });

  it("is always a whole number of milliseconds", () => {
    for (const r of [0.1234567, 0.333333, 0.987654]) assert.ok(Number.isInteger(typingDelayMs("hello world", true, () => r)));
  });
});

// ─── SendPacer ─────────────────────────────────────────────────────────────

describe("SendPacer", () => {
  const clock = () => {
    let t = NOW;
    return { now: () => t, tick: (ms: number) => (t += ms), at: () => t };
  };

  it("lets the first send go now", () => {
    const c = clock();
    assert.equal(new SendPacer(c.now).waitMs(-1), 0);
  });

  it("keeps 3 s between sends to one chat, and none between chats", () => {
    const c = clock();
    const p = new SendPacer(c.now);
    p.noteSent(-1);
    assert.equal(p.waitMs(-1), 3000);
    assert.equal(p.waitMs(-2), 0);
    c.tick(1000);
    assert.equal(p.waitMs(-1), 2000);
    c.tick(2000);
    assert.equal(p.waitMs(-1), 0);
  });

  it("allows at most 12 sends per rolling minute per chat", () => {
    const c = clock();
    const p = new SendPacer(c.now);
    const start = c.at();
    for (let n = 0; n < 12; n++) {
      assert.equal(p.waitMs(-1), 0, `send ${n + 1}`);
      p.noteSent(-1);
      c.tick(3000);
    }
    // 12 sends at start … start+33 s; now start+36 s. The oldest leaves the window at start+60 s.
    assert.equal(c.at() - start, 36_000);
    assert.equal(p.waitMs(-1), 24_000);
    assert.equal(p.waitMs(-2), 0);
    c.tick(23_999);
    assert.equal(p.waitMs(-1), 1);
    c.tick(1);
    assert.equal(p.waitMs(-1), 0);
  });

  it("pauses every chat for a 429 and never shortens a longer pause", () => {
    const c = clock();
    const p = new SendPacer(c.now);
    assert.equal(p.pausedUntil(), 0);
    p.pauseAll(c.at() + 10_000);
    assert.equal(p.waitMs(-1), 10_000);
    assert.equal(p.waitMs(-2), 10_000);
    p.pauseAll(c.at() + 5_000);
    assert.equal(p.pausedUntil(), c.at() + 10_000);
    p.pauseAll(Number.NaN);
    assert.equal(p.pausedUntil(), c.at() + 10_000);
    c.tick(10_000);
    assert.equal(p.waitMs(-1), 0);
  });

  it("waits for the longer of the pause and the per-chat gap", () => {
    const c = clock();
    const p = new SendPacer(c.now);
    p.noteSent(-1);
    p.pauseAll(c.at() + 1000);
    assert.equal(p.waitMs(-1), 3000);
    p.pauseAll(c.at() + 8000);
    assert.equal(p.waitMs(-1), 8000);
  });

  it("forgets idle chats, so a bot in many groups does not grow without bound", () => {
    const c = clock();
    const p = new SendPacer(c.now);
    for (let id = 1; id <= 300; id++) p.noteSent(-id);
    c.tick(2 * MIN);
    p.noteSent(-999);
    const size = (p as unknown as { sent: Map<number, number[]> }).sent.size;
    assert.equal(size, 1);
    assert.equal(p.waitMs(-1), 0);
  });
});
