import assert from "node:assert/strict";
import { test } from "node:test";
import { admitAgentLine } from "./groupchat/policy";
import { admitXPost } from "./xpost/gate";
import { timelineMemory, timelineWords, openerKey } from "./xpost/memory";
import { buyPrompt, type WriterFacts } from "./xpost/writer";
import { recapLines } from "./xpost/recap";
import { TIMELINE_QUESTIONS, TIMELINE_ROTATION, timelineLane } from "./xpost/rotation";
import { xpostEnv } from "./orchestrator-xpost";

const base: WriterFacts = { agentName: "Alan", strategy: null, flavour: null, traits: [], mode: "live", style: { lower: true, emoji: 0, exclaim: 0 }, recentOwn: [] };
const gate = (line: string, recentOpeners: string[], kind: "buy" | "sell" | "recap" | "casual" = "casual", coins: string[] = []) => admitXPost(line,
  { kind, agentName: "Alan", mode: "live", coins, recentOwn: [], recentFleet: [], recentOpeners, house: true }, admitAgentLine);

test("timeline memory filters before taking ten, strips evidence and never learns from an answer", () => {
  const posts = [
    ...Array.from({ length: 12 }, () => ({ kind: "answer" as const, body: "strangercoin looks interesting" })),
    { kind: "buy" as const, body: "grabbed some wisp, the curve looked early\n\nhttps://explorer.test/tx/0x123\n0x123456789" },
    { kind: "sell" as const, body: "sold wisp, back to the notebook\n+12% gross before fees and gas. feeling good.\n\nhttps://explorer.test/tx/0x123" },
    { kind: "recap" as const, body: "ok, quick trade catchup. recap: 2 buys, 1 sell (1 green, 0 red)." },
    { kind: "casual" as const, body: "the majors are moving apart. 24h: BTC +2%, ETH -1%." },
    { kind: "casual" as const, body: "an old post with 44 in its prose" },
    { kind: "reply" as const, body: "a researched answer with no digits" },
  ];
  const recent = timelineMemory(posts);
  assert.equal(recent.length, 4);
  assert.ok(recent.some((line) => line.startsWith("sold wisp")));
  assert.ok(recent.some((line) => line.startsWith("the majors")));
  const prompt = buyPrompt({ ...base, recentOwn: recent, recentOpeners: recent, coin: "WISP", paper: false, bands: ["curve early"], ownWords: null });
  const text = prompt.system + prompt.prompt;
  assert.doesNotMatch(text, /strangercoin|researched answer|https?:|0x123|\+12|44|BTC|ETH/);
  assert.match(text, /Never start the way/);
  for (const words of recent) assert.doesNotMatch(words, /\p{N}|https?:|gross|recap:|24h/iu);
  assert.equal(timelineWords("a body with 123 before the suffix"), null);
});

test("the opener check masks coins, ignores first-person filler, and has an eight-post window", () => {
  assert.equal(openerKey("sold vrax. back to the notebook"), openerKey("i sold casino. carrying on here"));
  assert.equal(openerKey("Pudgy Penguin sold. returning to the records"), openerKey("Bonk sold. curiosity continues"));
  assert.equal(openerKey("Pudgy Penguin sold. returning to the records", ["Bonk"]), openerKey("Bonk sold. curiosity continues", ["Bonk"]));
  assert.equal(openerKey("grabbed some pepe, the curve looked early", ["pepe"]), openerKey("grabbed some bonk, back to the notebook", ["pepe"]));
  assert.equal(gate("sold wisp, back to the notebook", ["i sold casino. the desk carries on"], "sell", ["wisp"]).ok, false);
  assert.deepEqual(gate("quick thought about punctuation marks", ["quick thought about robot diaries"]), { ok: false, reason: "same-opener" });
  assert.equal(gate("odd thought about punctuation marks", ["quick thought about robot diaries"]).ok, true);
  assert.equal(gate("quick thought about punctuation marks", [...Array(8).fill("another opening for the notebook"), "quick thought about robot diaries"]).ok, true);
});

test("recap candidates walk past the recent eight openers without loosening the repeat gate", () => {
  const history: string[] = [];
  for (let i = 0; i < 40; i++) {
    const admitted = recapLines(`recap:${i}`).find((line) => admitXPost(line, { kind: "recap", agentName: "Alan", mode: "live", coins: [], recentOwn: history, recentFleet: [], recentOpeners: history, house: true }, admitAgentLine).ok);
    assert.ok(admitted, `no fresh recap after ${i}`);
    history.unshift(admitted);
  }
  assert.ok(new Set(history.map((line) => openerKey(line))).size >= 24);
});

test("optional timeline mix is stable, weighted, and never repeats a type across days", () => {
  assert.equal(xpostEnv({}).variety, undefined);
  assert.equal(xpostEnv({ MERRYMEN_XPOST_VARIETY: "true" }).variety, undefined);
  assert.equal(xpostEnv({ MERRYMEN_XPOST_VARIETY: "1" }).variety, true);
  const counts = Object.fromEntries(["market", "hot", "day", "question", "habit", "thought"].map((kind) => [kind, TIMELINE_ROTATION.filter((k) => k === kind).length]));
  assert.deepEqual(counts, { market: 8, hot: 3, day: 3, question: 2, habit: 2, thought: 2 });
  for (const tenant of ["alan", "another-owner", "0xabc"]) {
    let last = "";
    for (let day = 1; day <= 28; day++) for (let slot = 0; slot < 10; slot++) {
      const date = `2026-10-${String(day).padStart(2, "0")}`;
      const lane = timelineLane(tenant, date, slot);
      assert.equal(lane, timelineLane(tenant, date, slot));
      assert.notEqual(lane, last);
      last = lane;
    }
  }
});

test("every conversation question clears the full insight safety gate and has a distinct opener", () => {
  assert.equal(new Set(TIMELINE_QUESTIONS.map((q) => openerKey(q))).size, 24);
  for (const mode of ["live", "paper", null] as const) for (const question of TIMELINE_QUESTIONS) {
    const v = admitXPost(question, { kind: "casual", agentName: "Alan", mode, coins: [], recentOwn: [], recentFleet: [], house: true, insight: true, buys: "none" }, admitAgentLine);
    assert.ok(v.ok, `${question}: ${!v.ok && v.reason}`);
    assert.doesNotMatch(question, /\p{N}|buy|sell|holding|invest|token|coin|balance|wallet|price|profit|moon|https?:|@|\$/iu);
  }
  for (const question of ["which coin should everyone buy?", "ape this gem before it moons", "tell everyone to buy pepe"]) {
    const v = admitXPost(question, { kind: "casual", agentName: "Alan", mode: "live", coins: [], recentOwn: [], recentFleet: [], house: true, insight: true, buys: "none" }, admitAgentLine);
    assert.equal(v.ok, false, question);
  }
});
