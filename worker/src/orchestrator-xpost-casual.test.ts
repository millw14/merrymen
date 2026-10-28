/**
 * CODE'S CASUAL ANSWERS CLEAR THE REAL GATE (2026-10-12): a playful decline,
 * its own mood and a friendly fallback for chat, sixty-four lines a kind; and
 * since 2026-10-18 a greeting, a thanks for praise and banter, a hundred and
 * forty-four lines a kind, in Alan's house voice.
 * Every line clears the X gate with the room's base gate composed in, live,
 * paper and idle, with no opt-out notice (the owner's decision, 2026-10-12),
 * and still clears it after every other line of every kind was
 * said; none repeats another; none names a coin, a figure, a direction or a
 * buy. Here, beside the orchestrator, because only orchestrator* files may
 * import the room's gate.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitAgentLine } from "./groupchat/policy";
import { REPEAT_LIMIT, similarity } from "./social-post";
import { admitXPost } from "./xpost/gate";
import { CHAT_SLOTS, CONFUSED_SLOTS, DECLINE_SLOTS, GREETING_SLOTS, REACTION_SLOTS, SELF_SLOTS, SLOT, TRADES_NONE_SLOTS, TRADES_SLOTS, VIBE_SLOTS, WELLBEING_SLOTS, WIDE_SLOT, chatAnswers, confusedAnswers, declineAnswers, greetingAnswers, latinLines, reactionAnswers, selfAnswers, tradesAnswers, vibeAnswers, wellbeingAnswers } from "./xpost/casual";
import { STRATEGY_SPOKEN } from "./groupchat/templates";
import { withoutReplyOptOut } from "./xpost/replies";
import { greetingAnswers as writerGreetings, modelAnswers } from "./xpost/writer";

type Mode = "live" | "paper" | null;
// An active owner's answer, as the answer path gates it (house: no source and never the chain named).
const gate = (text: string, mode: Mode, recentOwn: string[] = []) => admitXPost(text, { kind: "reply", answer: true, house: true, agentName: "Alan Al Dale",
  mode, coins: [], recentOwn, recentFleet: [], emojiOk: false }, (r, c) => admitAgentLine(r, c));

/** Every kind, with its slots and how many parts a slot holds: twelve for the kinds in his house voice (2026-10-18). */
const KINDS = [["decline", declineAnswers, DECLINE_SLOTS, SLOT], ["vibe", vibeAnswers, VIBE_SLOTS, SLOT], ["chat", chatAnswers, CHAT_SLOTS, WIDE_SLOT],
  ["greeting", greetingAnswers, GREETING_SLOTS, WIDE_SLOT], ["reaction", reactionAnswers, REACTION_SLOTS, WIDE_SLOT],
  ["wellbeing", wellbeingAnswers, WELLBEING_SLOTS, WIDE_SLOT], ["confused", confusedAnswers, CONFUSED_SLOTS, WIDE_SLOT]] as const;
/** The kinds in his house voice (2026-10-18; how he is and a confused reply since 2026-10-19). */
const TEXTED = KINDS.filter(([, , , n]) => n === WIDE_SLOT);
/** A text's content words as similarity() counts them: three letters or more, no stopword (a word similar to itself). */
const contentWords = (t: string) => new Set(t.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2 && similarity(w, w) > 0));

describe("code's casual answers", () => {
  it("each kind is sixty-four lines, or a hundred and forty-four in his house voice, this mention's own first, the same mention the same order", () => {
    for (const [kind, make, slots, n] of KINDS) {
      const a = make("100000000000000001", { lower: true }), b = make("100000000000000002", { lower: true });
      assert.ok(slots.every((slot) => slot.length === n), kind);
      assert.equal(a.length, n * n, kind);
      assert.equal(new Set(a).size, n * n, `${kind}: every cell once`);
      assert.deepEqual([...a].sort(), [...b].sort(), kind);
      assert.notEqual(a[0], b[0], `${kind}: two mentions start apart`);
      assert.deepEqual(make("100000000000000001", { lower: true }), a, kind);
    }
    assert.deepEqual(latinLines([["a"], ["b", "c"], ["d"]], "1", (x, y, z) => x + y + z), [], "slots of unequal size make nothing");
  });

  it("no word is in two parts of a kind, so two lines share at most one part and are never each other's repeat", () => {
    for (const [kind, , slots] of KINDS) {
      const seen = new Map<string, string>();
      for (const part of slots.flat()) {
        for (const w of contentWords(part)) {
          assert.ok(!seen.has(w), `${kind}: "${w}" is in "${part}" and "${seen.get(w)}"`);
          seen.set(w, part);
        }
      }
    }
    // An agent's lines are all live or all paper: each set against itself, every kind together, and code's model lines.
    for (const paper of [false, true]) {
      const every = [...KINDS.flatMap(([, make]) => make("1", { lower: true }, { paper })), ...modelAnswers("1", { lower: true }, { paper })];
      const words = every.map((l) => withoutReplyOptOut(l));
      assert.equal(new Set(words).size, words.length);
      for (let i = 0; i < words.length; i++) {
        for (let j = i + 1; j < words.length; j++) assert.ok(similarity(words[i]!, words[j]!) < REPEAT_LIMIT, `${words[i]}\n${words[j]}`);
      }
    }
  });

  it("every line clears the real gate as an answer, live, paper and idle, and none carries an opt-out line (2026-10-12)", () => {
    for (const [kind, make] of KINDS) {
      for (const mode of ["live", "paper", null] as const) {
        for (const lower of [true, false]) {
          for (const line of make("7", { lower }, { paper: mode === "paper" })) {
            const v = gate(line, mode, []);
            assert.ok(v.ok, `${kind} ${mode} ${lower}: ${line} → ${v.ok ? "" : v.reason}`);
            assert.equal(v.ok && v.text, line, "posted exactly as built");
            assert.doesNotMatch(line, /opt out|\bstop\b|unsubscribe/i);
          }
        }
      }
    }
  });

  it("all of them can be said one after another, after code's model lines, and none is refused as a repeat", () => {
    for (const mode of ["live", "paper"] as const) {
      const said: string[] = [...modelAnswers("3", { lower: true }, { paper: mode === "paper" })];
      for (const [kind, make] of KINDS) {
        for (const line of make("3", { lower: true }, { paper: mode === "paper" })) {
          const v = gate(line, mode, said);
          assert.ok(v.ok, `${kind} ${mode} after ${said.length} lines: ${line} → ${v.ok ? "" : v.reason}`);
          said.unshift(line);
        }
      }
    }
  });

  it("no line names a coin, a figure, a direction, a buy, a holding or a stock deflection, and none claims to be trading now", () => {
    for (const [kind, make] of KINDS) {
      for (const line of [...make("9", { lower: true }), ...make("9", { lower: true }, { paper: true })]) {
        const words = withoutReplyOptOut(line);
        assert.doesNotMatch(words, /\p{N}|\$|@|#|https?:|0x/u, `${kind}: ${line}`);
        assert.doesNotMatch(words, /\b(?:pepe|bonk|wif|doge|shib|btc|eth|sol|bitcoin|ether|solana|sherwood|robinhood|groq|qwen|gpt|claude|llama)\b/i, `${kind}: ${line}`);
        assert.doesNotMatch(words, /\b(?:bullish|bearish|moon|wen|wagmi|pump|dump|up only|going up|going down|higher|lower|bounce|bottom|top|rally|crash|green|red)\b/i, `${kind}: no direction: ${line}`);
        assert.doesNotMatch(words, /\b(?:bought|buy|buying|sell|selling|hold|holding|bag|position|entry|target|profit|loss|price)\b/i, `${kind}: no buy, no holding: ${line}`);
        assert.doesNotMatch(words, /\b(?:i trade|i'm trading|i am trading|trading right now)\b/i, `${kind}: never trading now: ${line}`);
        assert.doesNotMatch(words, /i don'?t comment|no comment|as an? (?:ai|bot)|financial advice|great question/i, `${kind}: ${line}`);
      }
    }
  });

  it("how it trades and what it bought, in code's words: every line clears the real gate, never repeats another, and says nothing but that (red-team review of daaae961)", () => {
    const strategies = [...Object.values(STRATEGY_SPOKEN), null];
    const coinSets: string[][] = [["Pepe"], ["PEPE", "Bonk"], ["pepe", "bonk", "wif"], []];
    // No word in two parts of a kind.
    for (const [kind, slots] of [["self", SELF_SLOTS], ["trades", TRADES_SLOTS], ["trades-none", TRADES_NONE_SLOTS]] as const) {
      const seen = new Map<string, string>();
      for (const part of slots.flat()) {
        for (const w of contentWords(part.replace(/\{[sc]\}/g, " "))) {
          assert.ok(!seen.has(w), `${kind}: "${w}" is in "${part}" and "${seen.get(w)}"`);
          seen.set(w, part);
        }
      }
    }
    for (const mode of ["live", "paper", null] as const) {
      const paper = mode === "paper";
      const lines = [...strategies.flatMap((s) => selfAnswers(s, "7", { lower: true }, { paper })), ...coinSets.flatMap((c) => tradesAnswers(c, "7", { lower: true }, { paper }))];
      for (const line of lines) {
        const coins = coinSets.flat().filter((c) => line.includes(c));
        const v = admitXPost(line, { kind: "reply", answer: true, agentName: "Alan Al Dale", mode, coins, paperCoins: paper ? coins : [], recentOwn: [], recentFleet: [] },
          (r, c) => admitAgentLine(r, c));
        assert.ok(v.ok, `${mode}: ${line} → ${v.ok ? "" : v.reason}`);
        assert.equal(v.ok && v.text, line, "posted exactly as built");
        const words = withoutReplyOptOut(line);
        assert.doesNotMatch(words, /\p{N}|\$|@|#|https?:|0x/u, line);
        assert.doesNotMatch(words, /\b(?:hot|trending|next|soon|tonight|tomorrow|later today|early|bullish|bearish|moon|pump|up only|higher|lower|top|bottom|green|red|profit|loss|size|hold|holding|sell|selling|best|biggest|fund|merrymen|robinhood|sherwood)\b/i, line);
        assert.doesNotMatch(words, /\b(?:you should|should you|i'?d buy|buy it|get in)\b/i, line);
      }
    }
    // Every self line of one strategy, and every trades line of one set of coins, can be said one after another.
    for (const lines of [selfAnswers("trencher", "3", { lower: true }), tradesAnswers(["pepe"], "3", { lower: true }), tradesAnswers([], "3", { lower: true })]) {
      const said: string[] = [];
      for (const line of lines) {
        const v = admitXPost(line, { kind: "reply", answer: true, agentName: "Alan Al Dale", mode: "live", coins: ["pepe"], recentOwn: said, recentFleet: [] }, (r, c) => admitAgentLine(r, c));
        assert.ok(v.ok, `after ${said.length}: ${line} → ${v.ok ? "" : v.reason}`);
        said.unshift(line);
      }
    }
    // A name a line may not say is never put in one.
    assert.deepEqual(tradesAnswers(["$PEPE", "pe pe 2"], "1", { lower: true }), tradesAnswers([], "1", { lower: true }));
    // With none to name it says only that, never that it bought nothing or was quiet: it may have bought coins it cannot name.
    for (const line of tradesAnswers([], "5", { lower: true })) {
      assert.doesNotMatch(line, /\b(?:quiet|idle|calm|slow|nothing (?:bought|new)|no (?:recent )?buys|haven'?t bought|didn'?t buy|bought nothing)\b/, line);
    }
  });

  it("his house voice (2026-10-18): lowercase, no full stop at the end, light slang, and never an emoji, a figure, \"it\", an outcome or what comes next", () => {
    assert.deepEqual(writerGreetings("5", { lower: true }), greetingAnswers("5", { lower: true }), "writer.ts hands out the same greetings");
    for (const [kind, make] of TEXTED) {
      for (const paper of [false, true]) {
        for (const line of make("13", { lower: true }, { paper })) {
          const words = paper ? line.replace(/\. my [^.]*$/, "") : line;
          assert.equal(line, line.toLowerCase(), `${kind}: ${line}`);
          assert.doesNotMatch(line, /\.$/, `${kind}: no full stop at the end: ${line}`);
          assert.doesNotMatch(line, /\p{Extended_Pictographic}|[^\x20-\x7e]/u, `${kind}: plain characters, no emoji: ${line}`);
          assert.doesNotMatch(line, /\p{N}|\$|@|#|https?:|0x|!/u, `${kind}: ${line}`);
          // Never "it" or "this one": under a buy or a sale it would be the coin. Never how it went, nor what comes next.
          assert.doesNotMatch(words, /\b(?:it|its|this one|that one|same one|the one|this coin|coin|token|trade|trades|trading|win|wins|won|winner|gain|gains|profit|loss|net|result|results|green|red|up|down|pnl|will|gonna|going to|next|soon|tomorrow|later|tonight|another one)\b/i, `${kind}: ${line}`);
          // Nor hype the gate refuses, nor a source or the chain (gate.ts sourceNamed, house).
          assert.doesNotMatch(words, /\b(?:lfg|wen|gg|wagmi|moon|send it|robinhood|coingecko|geckoterminal|bitquery|chain)\b/i, `${kind}: ${line}`);
        }
      }
    }
    // Each part is two or three words the repeat check counts, and none is a paper clause's: so two lines that share a part
    // are at most three in seven alike live, and five in nine on paper (the same part brings the same clause), under REPEAT_LIMIT.
    for (const [kind, , slots] of TEXTED) {
      for (const part of slots.flat()) {
        const n = contentWords(part).size;
        assert.ok(n >= 2 && n <= 3, `${kind}: "${part}" counts ${n}`);
      }
    }
    // The slang is there, a word here and there, never in every line.
    const all = TEXTED.flatMap(([, make]) => make("1", { lower: true }));
    const slang = all.filter((l) => /\b(?:ngl|tbh|lol|kinda|lowkey|fr|heh|haha)\b/.test(l)).length;
    assert.ok(slang > 0 && slang < all.length / 2, String(slang));
  });

  it("a confused reply ends its thread, so none of its lines asks for a reply under it (review of PR #350)", () => {
    for (const paper of [false, true]) {
      for (const line of confusedAnswers("17", { lower: true }, { paper })) {
        assert.doesNotMatch(line, /\?|\b(?:ask me|ask away|reply|replies|questions?|tell me|hear (?:yours|from you)|keep talking|let'?s talk|chat more|your (?:turn|move|court)|shoot your|all ears|go on|holler)\b/, line);
      }
    }
  });

  it("a paper agent's clause is about its own book: no pronoun or verb the tag's coin could take", () => {
    for (const [kind, make] of KINDS) {
      for (const line of make("11", { lower: true }, { paper: true })) {
        // His house voice ends with no full stop, like a text (2026-10-18).
        const clause = /\. ((?:my|all of my|this agent's) [^.]*)\.?$/.exec(line)?.[1];
        assert.ok(clause, `${kind}: ${line}`);
        assert.doesNotMatch(clause!, /\b(?:it|its|it's|them|they|that|this one|one|i|i'm|play|plays|playing|hold|holding|buy|buying)\b/, clause);
        assert.match(clause!, /\b(?:paper|practice)\b/);
      }
    }
  });
});
