/**
 * A MARKET ANSWER'S WORDS ARE CODE'S (red-team review, 2026-10-12): every
 * frame clears the X gate for every read, carries no digit, names no coin,
 * says nothing of itself (but a paper agent's paper clause), and no two
 * frames are a repeat of each other, so the same read is said again in other
 * words.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitAgentLine } from "./groupchat/policy";
import { REPEAT_LIMIT, similarity } from "./social-post";
import { admitXPost } from "./xpost/gate";
import { hotAnswers, hotNoneAnswers, hotUnreadAnswers, majorAnswers, majorsDirOf, majorUnreadAnswers, marketAnswers, moveOf, type HotRead, type MajorRead, type MarketRead, type Move } from "./xpost/market";
import { withoutReplyOptOut } from "./xpost/replies";

const MOVES: (Move | null)[] = [null, { dir: "flat", size: null },
  ...(["up", "down"] as const).flatMap((dir) => (["a little", "a fair bit", "sharply"] as const).map((size) => ({ dir, size })))];
/** Gated as what it is: an active agent's answer, which carries no opt-out line (2026-10-12). */
const gate = (text: string, recentOwn: string[], mode: "live" | "paper") =>
  admitXPost(text, { kind: "reply", answer: true, house: true, agentName: "Alan Al Dale", mode, coins: [], recentOwn, recentFleet: [] }, (r, c) => admitAgentLine(r, c));

/** Every line of one read: each clears the gate alone and after all the others were said, and none repeats another. */
function judged(lines: string[], paper: boolean): void {
  assert.equal(lines.length, 8);
  const said: string[] = [];
  for (const [i, line] of lines.entries()) {
    assert.doesNotMatch(line, /\p{N}|\$|@|#|https?:/u, line);
    const alone = gate(line, [], paper ? "paper" : "live");
    assert.ok(alone.ok, `${line} → ${alone.ok ? "" : alone.reason}`);
    const after = gate(line, said, paper ? "paper" : "live");
    assert.ok(after.ok, `${line} after the others → ${after.ok ? "" : after.reason}`);
    said.unshift(line);
    for (const other of lines.slice(i + 1)) {
      assert.ok(similarity(withoutReplyOptOut(line), withoutReplyOptOut(other)) < REPEAT_LIMIT, `${line}\n${other}`);
    }
    const words = withoutReplyOptOut(line).replace(/\. (?:all my|my|every) [^.]*\.$/, ".");
    assert.doesNotMatch(words, /\b(?:i|i'?m|i'?d|i'?ve|me|my|mine|we|our|buy|buying|bought|sell|early|pick|play|own|hold|holding|long|target|should|worth)\b/i, words);
  }
}

describe("what's hot in code's words", () => {
  it("moves by code's own thresholds: flat under half a percent, a little under three, a fair bit under ten, sharply past it", () => {
    assert.deepEqual(moveOf(0.4), { dir: "flat", size: null });
    assert.deepEqual(moveOf(-2.9), { dir: "down", size: "a little" });
    assert.deepEqual(moveOf(9.9), { dir: "up", size: "a fair bit" });
    assert.deepEqual(moveOf(412.4), { dir: "up", size: "sharply" });
    for (const bad of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, "12"]) assert.equal(moveOf(bad), null);
  });

  it("eight frames for every read, live or on paper: each clears the gate, none repeats another, none says a name, a figure or a pick", () => {
    for (const paper of [false, true]) {
      for (const coins of [1, 2, 3]) {
        for (const lead of MOVES) judged(hotAnswers({ coins, lead }, "1000000000000000123", { lower: false }, { paper }), paper);
      }
    }
  });

  it("nothing past the floors, and nothing read: eight lines each, never a draft, never a guess (red-team 2026-10-12)", () => {
    for (const paper of [false, true]) {
      judged(hotNoneAnswers("1000000000000000123", { lower: false }, { paper }), paper);
      judged(hotUnreadAnswers("1000000000000000123", { lower: false }, { paper }), paper);
    }
  });

  it("a major: eight frames for every whole read, live or on paper, none repeating another; a partial read still clears the gate (red-team 2026-10-12)", () => {
    const moves = MOVES.filter((m): m is Move => m !== null);
    for (const paper of [false, true]) {
      for (const rank of ["top", "large", "mid"] as const) {
        for (const day of moves) {
          for (const week of [moves[1]!, moves[4]!, moves[7]!]) {
            for (const volume of ["heavy", "light", "ordinary"] as const) judged(majorAnswers({ rank, day, week, volume }, "1000000000000000123", { lower: false }, { paper }), paper);
          }
        }
      }
      for (const read of [{ rank: null, day: moves[2]!, week: null, volume: null }, { rank: "mid", day: null, week: null, volume: "light" }] as MajorRead[]) {
        for (const line of majorAnswers(read, "7", { lower: false }, { paper })) assert.ok(gate(line, [], paper ? "paper" : "live").ok, line);
      }
      judged(majorUnreadAnswers("1000000000000000123", { lower: false }, { paper }), paper);
    }
    assert.deepEqual(majorAnswers({ rank: null, day: null, week: null, volume: null }, "1", { lower: false }), [], "nothing to say: no answer");
    for (const line of majorAnswers({ rank: "top", day: moves[0]!, week: moves[0]!, volume: "heavy" }, "1", { lower: false })) assert.doesNotMatch(line, /gecko|bitquery|robinhood/i, "no source named (2026-10-13)");
  });

  it("a paper agent's clause is about its own trading, never a pronoun or a verb the coin just described could take (red-team 2026-10-12)", () => {
    // At fbcf8756: "coingecko's view: a heavyweight, rising solidly lately, … a snapshot. i play it on paper. coingecko: ETH #2, …".
    const lines = [
      ...majorAnswers({ rank: "top", day: { dir: "up", size: "a fair bit" }, week: { dir: "up", size: "a little" }, volume: "ordinary" }, "1000000000000000903", { lower: true }, { paper: true }),
      ...majorUnreadAnswers("1000000000000000903", { lower: true }, { paper: true }),
      ...hotAnswers({ coins: 3, lead: { dir: "up", size: "sharply" } }, "1000000000000000903", { lower: true }, { paper: true }),
    ];
    for (const line of lines) {
      const clause = /\. ((?:all my|my|every) [^.]*)\.$/.exec(line)?.[1];
      assert.ok(clause, line);
      // Its own book is the subject: no pronoun the coin could be, and no verb it could be the object of.
      assert.doesNotMatch(clause!, /\b(?:it|its|it's|them|they|that|this|one|i|i'm|play|plays|playing|hold|holding|buy|buying)\b/, clause);
      assert.match(clause!, /\b(?:paper|practice)\b/);
    }
    assert.ok(lines.every((l) => !/i play it on paper|i trade on paper|i'm trading on paper/.test(l)));
  });

  it("this mention's own frame first, every frame once, no opt-out line in either casing (2026-10-12); no coin, no answer", () => {
    const read: HotRead = { coins: 3, lead: { dir: "up", size: "sharply" } };
    const a = hotAnswers(read, "1", { lower: false }), b = hotAnswers(read, "2", { lower: false });
    assert.notEqual(a[0], b[0]);
    assert.deepEqual([...a].sort(), [...b].sort());
    assert.ok(a.every((l) => l.endsWith(".") && !/opt out|\bstop\b/i.test(l)));
    assert.deepEqual(hotAnswers(read, "1", { lower: true }), a);
    assert.deepEqual(hotAnswers({ coins: 0, lead: null }, "1", { lower: false }), []);
  });

  it("how's the market, in code's casual words: every line of every read clears the gate, none repeats another of its read, none names a coin or a figure (2026-10-12)", () => {
    const told = (text: string, mode: "live" | "paper" | null, recentOwn: string[]) => admitXPost(text, { kind: "reply", answer: true,
      agentName: "Alan Al Dale", mode, coins: [], recentOwn, recentFleet: [] }, (r, c) => admitAgentLine(r, c));
    const majorsReads: MarketRead["majors"][] = [...(["up", "down"] as const).flatMap((dir) => (["a little", "a fair bit", "sharply", "uneven"] as const).map((size) => ({ dir, size }))),
      { dir: "mixed" }, { dir: "flat" }, null];
    const chainReads: MarketRead["chain"][] = [{ coins: 3, lead: { dir: "up", size: "sharply" } }, { coins: 1, lead: null }, { coins: 0, lead: null }, null];
    for (const majors of majorsReads) {
      for (const chain of chainReads) {
        for (const mode of ["live", "paper", null] as const) {
          const lines = marketAnswers({ majors, chain }, "1000000000000000777", { lower: true }, { paper: mode === "paper" });
          assert.equal(lines.length, 64);
          assert.equal(new Set(lines).size, 64);
          const said: string[] = [];
          for (const line of lines) {
            const words = withoutReplyOptOut(line);
            assert.doesNotMatch(words, /\p{N}|\$|@|#|https?:|0x/u, line);
            assert.doesNotMatch(words, /\b(?:btc|eth|sol|bitcoin|ether|ethereum|solana|pepe|bonk|wif|doge)\b/i, line);
            assert.doesNotMatch(words, /\b(?:buy|buying|bought|sell|hold|holding|entry|target|bullish|bearish|moon|pump|bounce|bottom|recover\w*|cheap|from here)\b/i, line);
            assert.doesNotMatch(line, /opt out|\bstop\b/i, line);
            const v = told(line, mode, said);
            assert.ok(v.ok, `${JSON.stringify(majors)} ${JSON.stringify(chain)} ${mode}: ${line} → ${v.ok ? "" : v.reason}`);
            said.unshift(line);
          }
        }
      }
    }
    // The words say what was read, and only that.
    const up = marketAnswers({ majors: { dir: "up", size: "a little" }, chain: { coins: 3, lead: null } }, "1", { lower: true });
    assert.ok(up.every((l) => /board|chain|onchain|screener|trenches|index|trending|over there/.test(l)), "it says where the movers are");
    const unread = marketAnswers({ majors: null, chain: null }, "1", { lower: true });
    assert.ok(unread.every((l) => /\bno (?:read|view|glimpse|data|word|signal)\b|can't spot|zilch from/.test(l)), "no read is said as none");
    assert.equal(majorsDirOf([1.2, 3.4, 0.6])?.dir, "up");
    assert.equal(majorsDirOf([-1.2, -0.1, -4])?.dir, "down");
    assert.equal(majorsDirOf([1.2, -3.4, null])?.dir, "mixed");
    assert.equal(majorsDirOf([0.04, -0.04, null])?.dir, "flat", "both shown as +0%");
    assert.equal(majorsDirOf([null, null]), null);
  });

  it("the big coins' words agree with the figures beside them: read as the line rounds them, and never of one coin (red-team 2026-10-12)", () => {
    // Read as "up" at 58ba9fd0 beside "$BTC +0.5%, $ETH -0.5%, $SOL -0.5%".
    assert.equal(majorsDirOf([0.5, -0.49, -0.49])?.dir, "mixed");
    assert.equal(majorsDirOf([2.4, -0.45, -0.48])?.dir, "mixed");
    assert.equal(majorsDirOf([0.6, -0.4, -0.4])?.dir, "mixed");
    assert.equal(majorsDirOf([0.5, -0.49, null])?.dir, "mixed");
    // A tiny move the line still shows with its sign is that sign; one it shows as +0% is flat.
    assert.equal(majorsDirOf([-1.2, 0.1, -4])?.dir, "mixed");
    assert.equal(majorsDirOf([0.2, -0.3, null])?.dir, "mixed");
    assert.equal(majorsDirOf([0.12, 0.3])?.dir, "up");
    assert.equal(majorsDirOf([0.04, 0.2])?.dir, "mixed");
    // One coin is no "majors": no read.
    assert.equal(majorsDirOf([0.5, null, null]), null);
    assert.equal(majorsDirOf([0.5]), null);
  });

  it("the big coins' words are as big as the move, and the chain's words count without a direction (red-team review of a964a74c, 2026-10-12)", () => {
    // POSTED at a964a74c: "the giants dipped slightly ... $BTC -15.2%, $ETH -21.7%, $SOL -28.3%", "the leaders are taking a breather",
    // "the bellwethers are inching forward ... $BTC +18.4%, $ETH +24.9%, $SOL +31%", and "a solo runner", "several runners",
    // "a pack running" beside $CHUMP -62.5% and chain coins down by half.
    assert.deepEqual(majorsDirOf([-15.2, -21.7, -28.3]), { dir: "down", size: "sharply" });
    assert.deepEqual(majorsDirOf([18.4, 24.9, 31]), { dir: "up", size: "sharply" });
    assert.deepEqual(majorsDirOf([3.2, 4.4, 8.8]), { dir: "up", size: "a fair bit" });
    assert.deepEqual(majorsDirOf([-0.6, -1.1, -2.94]), { dir: "down", size: "a little" });
    // Read as the line shows it: -3% is a fair bit, so the three are in different bands (red-team review of 1ed46625).
    assert.deepEqual(majorsDirOf([-0.6, -1.1, -2.96]), { dir: "down", size: "uneven" }, "read as the line shows it: -3%");
    assert.deepEqual(majorsDirOf([-3.04, -9.96]), { dir: "down", size: "uneven" }, "read as the line shows it: -10%");
    assert.deepEqual(majorsDirOf([-3.04, -9.94]), { dir: "down", size: "a fair bit" }, "read as the line shows it: -9.9%");
    const small = /\b(?:slightly|a touch|gently|inching|a little|a hair|mildly|breather|perky|nudged|tired|easing|softening|drifting|sagging|lean green|edging)\b/;
    for (const majors of [{ dir: "down", size: "sharply" }, { dir: "up", size: "sharply" }, { dir: "down", size: "a fair bit" }, { dir: "up", size: "a fair bit" }] as const) {
      for (const chain of [{ coins: 1, lead: { dir: "down", size: "sharply" } }, { coins: 2, lead: { dir: "down", size: "sharply" } }, { coins: 3, lead: { dir: "up", size: "sharply" } }] as const) {
        for (const id of ["100000000000000775", "100000000000000780", "100000000000000781", "100000000000000770", "100000000000000776"]) {
          for (const line of marketAnswers({ majors, chain }, id, { lower: true })) {
            const words = withoutReplyOptOut(line);
            assert.doesNotMatch(words, small, `${JSON.stringify(majors)}: ${line}`);
            assert.doesNotMatch(words, /\b(?:runners?|runaway|standout|running|lively|buzz\w*|brewing|busy|moving|movers?|action|heating|hot)\b/, `${JSON.stringify(chain)}: ${line}`);
            if (majors.dir === "down") assert.doesNotMatch(words, /\b(?:up|higher|climb\w*|green|perky|forward|ahead|surging|soaring)\b/, line);
            if (majors.dir === "up") assert.doesNotMatch(words, /\b(?:down|lower|dipped|sliding|falling|plunging|tumbling)\b/, line);
          }
        }
      }
    }
  });

  it("one coin's big day sets no size for all the big coins: in different bands they are only up or down, with no size (red-team review of 1ed46625, 2026-10-12)", () => {
    // POSTED at 1ed46625: "majors are plunging" beside $BTC -1.2%, $ETH -2%, $SOL -10.5%; "majors are surging" beside +0.8%, +1.1%, +10.3%;
    // "the giants fell steeply" beside -0.1%, -0.2%, -14%; "the heavyweights lost solid ground" beside -1.2%, -2%, -4.5%.
    assert.deepEqual(majorsDirOf([-1.2, -2.0, -10.5]), { dir: "down", size: "uneven" });
    assert.deepEqual(majorsDirOf([0.8, 1.1, 10.3]), { dir: "up", size: "uneven" });
    assert.deepEqual(majorsDirOf([-0.1, -0.2, -14]), { dir: "down", size: "uneven" });
    assert.deepEqual(majorsDirOf([-1.2, -2, -4.5]), { dir: "down", size: "uneven" });
    // All in one band: that band.
    assert.deepEqual(majorsDirOf([-1.2, -2, -2.5]), { dir: "down", size: "a little" });
    assert.deepEqual(majorsDirOf([12, 15, 30]), { dir: "up", size: "sharply" });
    const big = /\b(?:plung\w*|beating|tumbl\w*|steep\w*|surg\w*|soar\w*|racing|leapt|heavily|hammered|sharply|dramatic\w*|fast|sinking|spiked|shot)\b/;
    const sized = /\b(?:slightly|a touch|gently|inching|a hair|mildly|breather|perky|nudged|tired|easing|softening|drifting|sagging|edging|lean green|solid ground|steadily|decently|noticeably|a fair way|front foot|back foot|grinding|pushing ahead|retreating)\b/;
    for (const dir of ["up", "down"] as const) {
      for (const id of ["1", "7", "100000000000000775", "100000000000000780"]) {
        for (const line of marketAnswers({ majors: { dir, size: "uneven" }, chain: { coins: 2, lead: null } }, id, { lower: true })) {
          const words = withoutReplyOptOut(line);
          assert.doesNotMatch(words, big, line);
          assert.doesNotMatch(words, sized, line);
          if (dir === "down") assert.doesNotMatch(words, /\b(?:up|upward|higher|climb\w*|green|rose|gained|advanced)\b/, line);
          if (dir === "up") assert.doesNotMatch(words, /\b(?:down|downward|lower|fell|red|lost|slid|retreated)\b/, line);
        }
      }
    }
  });

  it("a paper agent's market line closes with a clause about its own book, never one the coins could take (2026-10-12)", () => {
    for (const line of marketAnswers({ majors: { dir: "up", size: "a fair bit" }, chain: { coins: 2, lead: null } }, "5", { lower: true }, { paper: true })) {
      const clause = /\. ((?:all my|my|every) [^.]*)\.$/.exec(line)?.[1];
      assert.ok(clause, line);
      assert.doesNotMatch(clause!, /\b(?:it|its|it's|them|they|that|this|one|i|i'm|play|plays|playing|hold|holding|buy|buying)\b/, clause);
    }
  });

  it("no frame carries an opt-out line, and every one clears the gate as an answer, live and on paper (the owner's decision, 2026-10-12)", () => {
    const gate = (text: string, paper: boolean) => admitXPost(text, { kind: "reply", answer: true, agentName: "Alan Al Dale", mode: paper ? "paper" : "live",
      coins: [], recentOwn: [], recentFleet: [] }, (r, c) => admitAgentLine(r, c));
    for (const paper of [false, true]) {
      const sets = [
        hotAnswers({ coins: 2, lead: { dir: "down", size: "a little" } }, "7", { lower: true }, { paper }),
        hotNoneAnswers("7", { lower: true }, { paper }), hotUnreadAnswers("7", { lower: true }, { paper }),
        majorAnswers({ rank: "large", day: { dir: "up", size: "a fair bit" }, week: null, volume: "light" }, "7", { lower: true }, { paper }),
        majorUnreadAnswers("7", { lower: true }, { paper }),
      ];
      for (const line of sets.flat()) {
        assert.doesNotMatch(line, /opt out|\bstop\b/i, line);
        const v = gate(line, paper);
        assert.ok(v.ok, `${line} → ${v.ok ? "" : v.reason}`);
        assert.equal(v.ok && v.text, line, "posted exactly as built");
      }
    }
  });
});

describe("code's market words name no source (the owner's teammate, 2026-10-13)", () => {
  it("no what's hot, major or market line, read or unread, live or paper, says coingecko, geckoterminal, bitquery or robinhood chain", () => {
    const hot: HotRead[] = [{ coins: 1, lead: null }, { coins: 3, lead: { dir: "up", size: "sharply" } }];
    const majors: MarketRead["majors"][] = [null, { dir: "mixed" }, { dir: "flat" }, { dir: "up", size: "a little" }, { dir: "down", size: "uneven" }];
    for (const paper of [false, true]) {
      const lines = [
        ...hot.flatMap((h) => hotAnswers(h, "1", { lower: true }, { paper })), ...hotNoneAnswers("1", { lower: true }, { paper }), ...hotUnreadAnswers("1", { lower: true }, { paper }),
        ...majorAnswers({ rank: "top", day: MOVES[2]!, week: MOVES[3]!, volume: "heavy" }, "1", { lower: true }, { paper }), ...majorUnreadAnswers("1", { lower: true }, { paper }),
        ...majors.flatMap((m) => [null, ...hot].flatMap((chain) => marketAnswers({ majors: m, chain }, "1", { lower: true }, { paper }))),
      ];
      assert.ok(lines.length > 60);
      for (const line of lines) assert.doesNotMatch(line, /gecko|bitquery|robinhood chain/i, line);
    }
  });
});

// Timeline fallback: exact typed market bands with independent opener variety.
describe("code insight posts", () => {
  it("every candidate in every direction/size/focus band passes the complete prose gate in live and paper mode", async () => {
    const { insightLines } = await import("./xpost/market");
    const { openerKey } = await import("./xpost/memory");
    const majors: NonNullable<MarketRead["majors"]>[] = [{ dir: "flat" }, { dir: "mixed" },
      ...(["up", "down"] as const).flatMap((dir) => (["a little", "a fair bit", "sharply", "uneven"] as const).map((size) => ({ dir, size })))];
    const base = { day: majors[0]!, week: majors[1]!, chain: { coins: 1, lead: { dir: "flat" as const, size: null } }, crowd: 1 };
    const cases = [
      ...majors.flatMap((day, i) => [{ read: { ...base, day }, focus: "day" as const }, { read: { ...base, day, week: majors[(i + 1) % majors.length]! }, focus: "day-week" as const }]),
      ...MOVES.filter((m): m is Move => m !== null).map((lead) => ({ read: { ...base, chain: { coins: 1, lead } }, focus: "lead" as const })),
      ...[1, 2].map((crowd) => ({ read: { ...base, crowd }, focus: "crowd" as const })),
      { read: { ...base, chain: { coins: 0, lead: null }, crowd: 0 }, focus: "quiet" as const },
    ];
    for (const { read, focus } of cases) for (const paper of [false, true]) {
      const lines = insightLines(read, "sample", { focus, paper });
      assert.equal(lines.length, 576);
      assert.equal(new Set(lines).size, 576);
      assert.ok(new Set(lines.map((line) => openerKey(line))).size >= 24);
      for (const line of lines) {
        const v = admitXPost(line, { kind: "casual", insight: true, house: true, buys: "none", lookedOnly: false,
          agentName: "Alan Al Dale", mode: paper ? "paper" : "live", coins: [], recentOwn: [], recentFleet: [] }, admitAgentLine);
        assert.ok(v.ok, `${focus}: ${line} → ${v.ok ? "" : v.reason}`);
        assert.doesNotMatch(line, /\p{N}|\$|https?:|coingecko|bitquery|robinhood|bitcoin|ethereum|solana/iu);
      }
    }
  });
  it("fallback selection walks past recently used openers and repeated prose", async () => {
    const { insightLines } = await import("./xpost/market");
    const { openerKey } = await import("./xpost/memory");
    const read = { day: { dir: "up" as const, size: "a little" as const }, week: null, chain: null, crowd: null };
    const lines = insightLines(read, "repeat");
    const recent = lines.filter((line, i) => lines.findIndex((other) => openerKey(other) === openerKey(line)) === i).slice(0, 8);
    const line = lines.find((candidate) => admitXPost(candidate, { kind: "casual", insight: true, house: true, buys: "none",
      agentName: "Alan Al Dale", mode: "live", coins: [], recentOwn: recent, recentOpeners: recent, recentFleet: [] }, admitAgentLine).ok);
    assert.ok(line);
    assert.ok(!recent.some((old) => openerKey(old) === openerKey(line!)));
  });
});
