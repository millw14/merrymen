/**
 * MARKET INSIGHTS ON THE TIMELINE (the owner's teammate, 2026-10-13): an active
 * owner's casual slot that is not a trade-talk one is a post about the market
 * now, in a trader's technical words, written from code's words-only read of
 * the market and gated as strictly as a drafted answer, with code's figures
 * line after it. Unreadable data falls back to the casual post as before;
 * every other owner's casual post is unchanged.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { wrapSqlite } from "./db";
import { makeXPoster, xpostEnv } from "./orchestrator-xpost";
import type { ResearchBundle, XResearch } from "./orchestrator-xpost-research";
import type { AgentFacts } from "./groupchat/facts";
import type { FetchLike } from "./xpost/client";
import { insightFacts, selectInsight, insightDraftSupported, type InsightRead } from "./xpost/market";
import { INSIGHT_VOCABULARY, insightPrompt } from "./xpost/writer";
import * as store from "./xpost/store";
import { admitXPost } from "./xpost/gate";
import { admitAgentLine } from "./groupchat/policy";
import { timelineLane, TIMELINE_QUESTIONS, type TimelineLane } from "./xpost/rotation";
import { withoutFiguresLine } from "./xpost/figures";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 30, 8);
const TENANT = `0x${"cd".repeat(20)}`;
/** No strategy, no traits, no buys: never a trade-talk slot, so every casual slot of an active owner is an insight post. */
const FACTS: AgentFacts = { tenant: TENANT, agentId: TENANT, slug: null, name: "Alan Al Dale", mode: "live", ageDays: 2, strategy: null, traits: [], calls: [] };
const READ: InsightRead = { day: { dir: "up", size: "a little" }, week: { dir: "mixed" }, chain: { coins: 1, lead: { dir: "up", size: "sharply" } }, crowd: 1 };
const MARKET: ResearchBundle = {
  facts: ["the market data shows the big coins mostly up today"], lookups: 3, notes: ["market"],
  figures: [{ kind: "majors", coins: [{ symbol: "btc", change24hPct: 1.2 }, { symbol: "eth", change24hPct: 0.8 }, { symbol: "sol", change24hPct: 3.1 }] },
    { kind: "pools", coins: [{ symbol: "COINA", change24hPct: 42.1 }] }, { kind: "crowd", symbols: ["COINA"] }],
  market: { majors: { dir: "up", size: "a little" }, chain: { coins: 1, lead: { dir: "up", size: "sharply" } } },
  insight: READ,
};
const INSIGHT = "majors up a little on the day.";
const isInsight = (prompt: string) => /your read on the crypto market right now/.test(prompt);
const isCasual = (prompt: string) => /Write one casual post/.test(prompt);

async function world(t: TestContext, o: { active?: boolean; research?: XResearch | null; draft?: string | (() => Promise<string>); facts?: AgentFacts; noModel?: boolean; exhausted?: boolean; variety?: boolean; repliesOff?: boolean; casualDraft?: string | ((prompt: string) => string) } = {}) {
  const raw = new DatabaseSync(":memory:");
  t.after(() => raw.close());
  const db = wrapSqlite(raw), dek = randomBytes(32);
  await store.ensureXpostSchema(db, "sqlite");
  await store.upsertAccount(db, dek, { tenant: TENANT, xUserId: "111", username: "alanaidale",
    tokens: { accessToken: "private-access", refreshToken: "private-refresh", accessExpiresAtMs: NOW + 7 * DAY, scope: "tweet.read tweet.write" }, nowMs: NOW - 2 * DAY });
  await store.setPosting(db, TENANT, { enabled: true, xUserId: "111" }, NOW - DAY);
  const intro = await store.schedulePost(db, { tenant: TENANT, xUserId: "111", kind: "intro", dedupeKey: `intro:${TENANT}:111`, body: "I am an AI trading agent", nowMs: NOW - DAY, dueAtMs: NOW - DAY });
  await store.claimPost(db, intro!, NOW - DAY);
  await store.markPosted(db, intro!, "999", NOW - DAY);
  const sent: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    if (url.includes("/mentions?")) return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: [], meta: { result_count: 0 } }) };
    if (init.body) sent.push(JSON.parse(init.body).text);
    return { status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ data: { id: "1000000000000000990" } }) };
  };
  const prompts: string[] = [];
  const asked: string[] = [];
  const research = o.research === undefined ? null : o.research;
  const env = { ...(o.active === false ? {} : { MERRYMEN_XPOST_ACTIVE_TENANTS: TENANT }), ...(research ? { MERRYMEN_XPOST_RESEARCH: "1" } : {}), ...(o.variety ? { MERRYMEN_XPOST_VARIETY: "1" } : {}) };
  const poster = makeXPoster({
    app: { clientId: "client", clientSecret: "secret", redirectUri: "https://app.test/connect/x" }, dek,
    creds: o.noModel ? null : { provider: "groq", transport: "openai", model: "test", apiKey: "private-model", baseUrl: "https://model.test/v1", vision: false },
    knobs: { ...xpostEnv(env), repliesApproved: true, ...(o.exhausted ? { llmPerDay: 1 } : {}) },
    deps: { dialect: "sqlite", fetch, monotonic: () => 0, member: async () => ({ tz: null }), facts: async () => new Map([[TENANT, o.facts ?? FACTS]]),
      llm: async (_creds, input) => {
        prompts.push(`${input.system ?? ""}\n\n${input.prompt}`);
        return isInsight(input.prompt) ? (typeof o.draft === "function" ? o.draft() : o.draft ?? INSIGHT)
          : typeof o.casualDraft === "function" ? o.casualDraft(input.prompt) : o.casualDraft ?? "PASS";
      },
      ...(research ? { research: { gather: async (input) => { asked.push(input.intent.kind); return research.gather(input); } } } : {}),
    },
  });
  if (o.repliesOff) await store.setReplying(db, TENANT, false, "111", NOW);
  if (o.exhausted) await store.takeAllowance(db, `llm:2026-09-30`, 1, NOW);
  const step = (now: number) => poster.step(db, [{ tenant: TENANT, agentId: TENANT }], new Map(), now);
  const casuals = async () => (await store.postsOf(db, TENANT, 0)).filter((p) => p.kind === "casual");
  /** Pass after pass through the owner's day until its first casual slot is written. */
  const firstCasual = async () => {
    const logs: string[] = [];
    for (let at = NOW; at < NOW + 16 * HOUR; at += 5 * MIN) {
      const r = await step(at);
      if (r.log) logs.push(r.log);
      const rows = await casuals();
      if (rows.length) return { row: rows[0]!, log: r.log ?? "" };
    }
    assert.fail(`no casual slot was written: ${logs.join("; ")}`);
  };
  return { db, prompts, asked, sent, firstCasual, step, casuals };
}

const reading = (bundle: Partial<ResearchBundle> = MARKET): XResearch => ({ gather: async () => ({ facts: [], lookups: 0, notes: [], ...bundle }) });

test("an active owner's market slot gives the model one supported focus and appends matching code figures", async (t) => {
  const dayRead = { ...READ, week: null, chain: null, crowd: null };
  const w = await world(t, { research: reading({ ...MARKET, insight: dayRead }) });
  const { row, log } = await w.firstCasual();
  assert.equal(row.status, "scheduled", row.reason ?? "");
  assert.equal(row.body, `${INSIGHT} 24h: BTC +1.2%, ETH +0.8%, SOL +3.1%.`);
  assert.match(log, /drafted-insight 1/);
  assert.deepEqual(w.asked, ["market"]);
  const prompt = w.prompts.find(isInsight)!;
  assert.ok(prompt.includes(insightFacts(dayRead)[0]!));
  const task = prompt.slice(prompt.indexOf("Write one post"));
  assert.doesNotMatch(task, /\p{N}|COINA|BTC|ETH|SOL\b|\$/u);
  assert.doesNotMatch(prompt, /coingecko|geckoterminal|bitquery|robinhood chain|figures|added after/i);
  assert.match(prompt, /plain casual words, lowercase/);
  assert.match(prompt, /at most one bit of jargon/);
  assert.match(prompt, /Never say what comes next/);
  assert.match(prompt, /never tell anyone to buy, sell, long, short/);
  assert.match(prompt, /Never say you hold, bought, sold, are buying or will buy anything/);
  await w.step(row.dueAtMs + MIN);
  assert.deepEqual(w.sent, [row.body], "the actual send preserves the checked numeric line");
});

test("unsafe insight model text is refused and replaced with a freshly gated code line", async (t) => {
  const refused: [string, RegExp][] = [
    ["per coingecko the majors are up a little on the day, volume thin.", /^gate:source-named$/],
    ["the gecko terminal board shows breadth narrow and momentum concentrated.", /^gate:source-named$/],
    ["bitquery flows look balanced, the majors drift in a tight range.", /^gate:source-named$/],
    // The chain by its name too (the owner, 2026-10-18).
    ["majors drift in a tight range, breadth narrow on robinhood chain.", /^gate:source-named$/],
    ["majors drift in a tight range, breadth narrow on r0bin hood chain.", /^gate:source-named$/],
    ["majors up 2% on the day, momentum concentrated onchain.", /^gate:has-digits$/],
    ["majors firm on the day, buy the dip while breadth is narrow.", /^gate:/],
    ["majors pressing the upper half of the range, a breakout is coming.", /^gate:/],
    ["majors near the week's lows, a bounce from here wouldn't surprise me.", /^gate:/],
    ["momentum is returning to the majors, risk-on tone onchain.", /^gate:/],
    ["majors up a little on the day, and i'm holding some.", /^gate:buy-claim$/],
    ["bitcoin up a little on the day, pepe ripping on the chain.", /^gate:/],
    ["majors are bullish, momentum concentrated in the trenches.", /^gate:/],
  ];
  for (const [draft, reason] of refused) {
    const w = await world(t, { research: reading(), draft });
    const { row, log } = await w.firstCasual();
    const verdict = admitXPost(draft, { kind: "casual", insight: true, house: true, buys: "none", lookedOnly: true,
      known: [...INSIGHT_VOCABULARY, ...insightFacts(READ)], coins: [], agentName: FACTS.name, mode: "live", recentOwn: [], recentFleet: [] }, admitAgentLine);
    assert.ok(!verdict.ok, draft);
    if (!verdict.ok) assert.match(`gate:${verdict.reason}`, reason, draft);
    assert.equal(row.status, "scheduled", draft);
    assert.notEqual(withoutFiguresLine(row.body), draft);
    assert.match(log, /insight-code-words:gate:/);
    assert.doesNotMatch(row.body, /coingecko|geckoterminal|bitquery|robinhood/i);
  }
});

test("market data unreadable: the casual post as before, never an insight; and research off the same", async (t) => {
  for (const research of [reading({ market: { majors: null, chain: null } }), reading({ insight: READ }), reading({ insight: READ, figures: [] }),
    { gather: async () => { throw new Error("down"); } } satisfies XResearch, null]) {
    const w = await world(t, { research });
    const { row } = await w.firstCasual();
    assert.ok(w.prompts.some(isCasual), "the casual prompt");
    assert.ok(!w.prompts.some(isInsight), "no insight prompt");
    // The test model passes on a casual prompt: the slot is spent as before.
    assert.deepEqual([row.status, row.reason], ["skipped", "no-draft:pass"]);
  }
});

test("an insight whose figures line cannot be put in is skipped, never posted on words alone", async (t) => {
  // Every coin the line would show is one this owner's buy posts named, and no big coins' day to stand on.
  const facts: AgentFacts = { ...FACTS, calls: [] };
  const w = await world(t, { facts, research: reading({ ...MARKET, figures: [{ kind: "pools", coins: [{ symbol: "COINA", change24hPct: 42.1 }] }] }) });
  const buy = await store.schedulePost(w.db, { tenant: TENANT, xUserId: "111", kind: "buy", dedupeKey: "buy:coina", body: "grabbed some coina with real money", coin: "COINA",
    nowMs: NOW - DAY, dueAtMs: NOW - DAY });
  await store.claimPost(w.db, buy!, NOW - DAY);
  await store.markPosted(w.db, buy!, "998", NOW - DAY);
  const { row, log } = await w.firstCasual();
  assert.deepEqual([row.status, row.reason, row.body], ["skipped", "insight-figures-left-out", ""]);
  assert.match(log, /not-posted 1 \(insight insight-figures-left-out\)/);
});

test("missing, refused and unavailable drafts use code insights; logs contain reason codes only", async (t) => {
  const cases: [Parameters<typeof world>[1], string][] = [
    [{ research: reading(), draft: async () => { throw new Error("groq 429 private provider text"); } }, "no-draft:groq-429"],
    [{ research: reading(), draft: async () => { throw new TypeError("fetch failed"); } }, "no-draft:network"],
    [{ research: reading(), draft: "PASS" }, "no-draft:pass"],
    [{ research: reading(), draft: "majors up 2% on the day." }, "gate:has-digits"],
    [{ research: reading(), noModel: true }, "no-model"],
    [{ research: reading(), exhausted: true }, "no-budget"],
  ];
  for (const [o, why] of cases) {
    const w = await world(t, o);
    const { row, log } = await w.firstCasual();
    assert.equal(row.status, "scheduled", why);
    assert.ok(withoutFiguresLine(row.body) !== row.body, "figures always accompany the code fallback");
    assert.ok(log.includes(`insight-code-words:${why}`), log);
    assert.doesNotMatch(log, /private provider text|majors up|fomo traders|COINA/);
    if (o?.noModel || o?.exhausted) assert.deepEqual(w.prompts, []);
  }
});

test("every other owner's casual post is unchanged: no market read, the casual prompt", async (t) => {
  const w = await world(t, { active: false, research: reading() });
  for (let at = NOW; at < NOW + 3 * DAY && !w.prompts.some(isCasual); at += 10 * MIN) await w.step(at);
  assert.ok(w.prompts.some(isCasual), "a casual post was drafted");
  assert.deepEqual(w.asked, []);
  assert.ok(!w.prompts.some(isInsight));
});

test("the insight prompt is code's words or nothing, and the vocabulary holds no call, level or forecast", () => {
  const f = { agentName: "Alan Al Dale", strategy: null, flavour: null, traits: [], mode: "live" as const, style: { lower: true, emoji: 0, exclaim: 0 }, recentOwn: [] };
  assert.equal(insightPrompt({ ...f, read: [] }), null);
  assert.equal(insightPrompt({ ...f, read: ["btc up 2%"] }), null, "a read with a digit is no read");
  assert.ok(insightPrompt({ ...f, read: insightFacts(READ) }));
  for (const w of INSIGHT_VOCABULARY) assert.doesNotMatch(w, /^(?:breakout|bullish|bearish|support|resistance|bounce\w*|recover\w*|pull-?backs?|targets?|entry|buy|sell|long|short|moon|pump\w*|bottom\w*|floor)$/, w);
  for (const fact of insightFacts(READ)) assert.doesNotMatch(fact, /\p{N}|gecko|bitquery|robinhood/u, fact);
  assert.deepEqual(insightFacts(null), []);
  assert.deepEqual(insightFacts({ day: null, week: null, chain: { coins: 0, lead: null }, crowd: null }), ["nothing on the chain's trending list clears the activity floors"]);
});

test("focus selection is deterministic, alternates supported topics, and never invents a missing read", () => {
  const weekFigures = [{ kind: "major" as const, symbol: "BTC", change24hPct: 1, change7dPct: -1 }, { kind: "major" as const, symbol: "ETH", change24hPct: 2, change7dPct: 1 }];
  for (const read of [READ, { ...READ, chain: { coins: 0, lead: null }, crowd: null }]) {
    let previous = "";
    const focuses = new Set<string>();
    for (let slot = 0; slot < 40; slot++) {
      const opts = { tenant: TENANT, day: "2026-09-30", slot, weekFigures };
      const selected = selectInsight(read, MARKET.figures!, opts)!;
      assert.deepEqual(selectInsight(read, MARKET.figures!, opts), selected);
      assert.notEqual(selected.focus, previous);
      assert.ok(selected.read.length > 0 && selected.read.length <= 2);
      assert.doesNotMatch(selected.read.join(" "), /\p{N}|COINA|BTC|https?:/u);
      focuses.add(selected.focus);
      previous = selected.focus;
    }
    assert.ok(focuses.has("day"));
    assert.ok(focuses.has("day-week"));
    if (read.chain?.coins === 0) assert.ok(focuses.has("quiet"));
    else { assert.ok(focuses.has("lead")); assert.ok(focuses.has("crowd")); }
  }
  assert.equal(selectInsight({ day: null, week: null, chain: null, crowd: null }, MARKET.figures!, { tenant: TENANT, day: "today", slot: 0 }), null);
  assert.equal(selectInsight(READ, MARKET.figures!, { tenant: TENANT, day: "today", slot: 0, preferHot: true })?.focus === "day", false);
});

test("a focused spec that cannot render falls back to the complete spec", async (t) => {
  const read: InsightRead = { ...READ, week: null, chain: null, crowd: null };
  const figures = [{ kind: "majors" as const, coins: [{ symbol: "BAD1", change24hPct: 1 }] }, { kind: "pools" as const, coins: [{ symbol: "COINA", change24hPct: 42.1 }] }];
  const selected = selectInsight(read, figures, { tenant: TENANT, day: "today", slot: 0 })!;
  assert.deepEqual(selected.figures, figures);
  const w = await world(t, { research: reading({ ...MARKET, insight: read, figures }) });
  const { row } = await w.firstCasual();
  assert.equal(row.status, "scheduled");
  assert.match(row.body, /trending: COINA 24h \+42\.1%\.$/);
});

test("insight-only range and activity exemptions never license personal positions or acquisitions", () => {
  const context = { kind: "casual" as const, insight: true, house: true, buys: "none" as const, coins: [], agentName: FACTS.name, mode: "live" as const, recentOwn: [], recentFleet: [] };
  for (const text of ["majors still in the lower end of the range.", "the majors are still in a tight range.", "volume is picking up today.", "activity picking up on the day."]) {
    const v = admitXPost(text, context, admitAgentLine);
    assert.ok(v.ok, `${text}: ${v.ok ? "" : v.reason}`);
    assert.ok(!admitXPost(text, { ...context, insight: false }, admitAgentLine).ok, "no exemption outside insight posts");
  }
  for (const text of ["i'm still in pepe.", "we are still in a tight range.", "my volume is picking up pepe.", "volume is picking up pepe.", "the majors are still in pepe range.", "volume is picking up, and i picked up pepe.", "majors still in a range and i'm still in pepe."]) {
    assert.ok(!admitXPost(text, context, admitAgentLine).ok, text);
  }
});

test("the focused read refuses invented measurements, directions, magnitudes and scope", () => {
  for (const text of ["majors down a little on the day", "majors surging on the day", "majors up a little, volume picking up", "majors up a little with narrow breadth", "majors in a tight range", "the chain is sleepy", "majors up a little on the week", "majors are not up on the day.", "majors are going sideways on the day.", "majors are volatile on the day.", "majors have deep bids on the day.", "majors are higher on the day. participation is heavy."]) {
    assert.equal(insightDraftSupported(text, READ, "day"), false, text);
  }
  assert.equal(insightDraftSupported("majors up a little on the day", READ, "day"), true);
  assert.equal(insightDraftSupported("majors up a little on the day; the week is mixed", READ, "day-week"), true);
  assert.equal(insightDraftSupported("fomo traders are most active in a few trending coins", READ, "crowd"), false);
  assert.equal(insightDraftSupported("the chain is quiet", { ...READ, chain: { coins: 0, lead: null } }, "quiet"), false);
  assert.equal(insightDraftSupported("the filtered trending list is full of coins.", { ...READ, chain: { coins: 0, lead: null } }, "quiet"), false);
  assert.equal(insightDraftSupported("the first trending coin is not up on the day.", READ, "lead"), false);
  assert.equal(insightDraftSupported("fomo traders are not active in the trending coins.", READ, "crowd"), false);
  assert.equal(insightDraftSupported("fomo traders are most active in one of the chain's trending coins. bot at the screen.", READ, "crowd"), true);
  assert.equal(insightDraftSupported("the first trending coin is up sharply on the day. anyway.", READ, "lead"), true);
  assert.equal(insightDraftSupported("the filtered movers board has no listings.", { ...READ, chain: { coins: 0, lead: null } }, "quiet"), true);
});

test("a fluent but unsupported model claim falls back instead of acquiring evidence from the appended figures", async (t) => {
  for (const draft of ["majors are not up on the day.", "majors are going sideways on the day.", "majors are volatile on the day.", "majors have deep bids on the day.", "majors are higher on the day. participation is heavy."]) {
    const w = await world(t, { draft, research: reading({ ...MARKET, insight: { ...READ, week: null, chain: null, crowd: null } }) });
    const { row, log } = await w.firstCasual();
    assert.equal(row.status, "scheduled");
    assert.ok(log.includes("insight-code-words:gate:insight-unsupported"), log);
    assert.notEqual(withoutFiguresLine(row.body), draft);
  }
});

function laneOf(row: store.XPost): TimelineLane {
  const [, , day, slot] = row.dedupeKey.split(":");
  return timelineLane(TENANT, day!, Number(slot ?? 0));
}

test("optional variety sends independent non-market posts and restricts hot slots to chain evidence", async (t) => {
  const w = await world(t, { variety: true, research: reading(), casualDraft: "a robot can have messy thoughts too." });
  const seen = new Set<number>();
  const lanes = new Set<TimelineLane>();
  for (let at = NOW; at < NOW + 4 * DAY && lanes.size < 6; at += 5 * MIN) {
    const readsBefore = w.asked.length;
    const promptsBefore = w.prompts.length;
    await w.step(at);
    const added = (await w.casuals()).filter((p) => !seen.has(p.id));
    for (const row of added) {
      seen.add(row.id);
      const lane = laneOf(row);
      lanes.add(lane);
      if (["day", "thought", "habit", "question"].includes(lane)) {
        assert.equal(w.asked.length, readsBefore, `${lane} must not gather market research`);
        assert.equal(withoutFiguresLine(row.body), row.body, `${lane} must not inherit market figures`);
        if (lane !== "question") assert.ok(w.prompts.slice(promptsBefore).some(isCasual), `${lane} uses its casual prompt`);
      }
      if (lane === "hot") {
        assert.ok(w.asked.length > readsBefore);
        const prompt = w.prompts.slice(promptsBefore).find(isInsight)!;
        assert.ok(prompt);
        assert.doesNotMatch(prompt.slice(prompt.indexOf("How the market looks"), prompt.indexOf("Use plain casual words")), /big coins|on the week/);
        assert.match(row.body, /trending:|fomo:/);
      }
    }
  }
  assert.deepEqual([...lanes].sort(), ["day", "habit", "hot", "market", "question", "thought"]);
});

test("a variety question uses vetted code without model access and respects reply consent", async (t) => {
  for (const repliesOff of [false, true]) {
    const w = await world(t, { variety: true, noModel: true, research: reading(), repliesOff });
    let question: store.XPost | undefined;
    for (let at = NOW; at < NOW + 3 * DAY && !question; at += 5 * MIN) {
      await w.step(at);
      question = (await w.casuals()).find((p) => laneOf(p) === "question");
    }
    assert.ok(question, "a question slot was planned");
    assert.deepEqual(w.prompts, [], "no model is needed");
    if (repliesOff) assert.deepEqual([question.status, question.reason, question.body], ["skipped", "question-replies-disabled", ""]);
    else {
      assert.equal(question.status, "scheduled");
      assert.ok(TIMELINE_QUESTIONS.includes(question.body));
      assert.doesNotMatch(question.body, /\b(?:buy|sell|hold|ape|invest|coin|token)\b/i);
    }
  }
});

test("day, thought and habit lanes reject invented acquisitions and unsupplied market observations", async (t) => {
  for (const draft of [
    "bought pepe, back to the notebook.",
    "grabbed some pepe earlier, keeping the notes tidy.",
    "the majors are up today, back to the notebook.",
    "liquidity is deep today, back to the notes.",
    "participation is heavy today, keeping the notes tidy.",
    "bitcoin is higher today, keeping the notes tidy.",
    "i check volume as it rises.",
    "i watch liquidity getting deeper.",
    "i compare prices while they climb.",
    "i read market data. it is bullish today.",
    "sold some, back to the notes.",
    "took profit earlier, back to the notes.",
    "a sale in the notebook today.",
    "closed a trade today, back to the notes.",
    "closed in green, keeping my notes tidy.",
    "buyers have been busy today, back to the notes.",
    "the charts are looking quiet today.",
    "i check my notes as activity picks up.",
    "i keep notes on the activity getting stronger.",
    "i keep notes on what people are buying lately.",
    "buyers look strong today, back to my notes.",
    "looks like a healthy pool today, back to my notes.",
    "crowd looks busy today, back to my notes.",
    "caught a nice move earlier, back to the notes.",
    "my swap went through, back to the notes.",
    "my exit went through, back to my notes.",
    "the sell went through, back to the notes.",
    "the trade is done, back to my notes.",
    "back in green, keeping notes.",
    "buying was the easy part, back to the notes.",
    "i keep notes about buying earlier.",
    "i keep notes on the trades i did yesterday.",
    "my notes say i did a trade yesterday.",
    "the book is thin today, back to my notes.",
    "liq looks deep today, back to my notes.",
    "vol is up today, back to my notes.",
    "fomo looks busy today, back to my notes.",
    "holders are still here, back to my notes.",
    "the spread looks healthy today.",
    "supply is thin today, back to my notes.",
    "the sellers seem quiet today.",
    "the candle is green today.",
    "the candles look steady today.",
  ]) {
    const w = await world(t, { variety: true, research: reading(), casualDraft: draft });
    const seen = new Set<TimelineLane>();
    for (let at = NOW; at < NOW + 4 * DAY && seen.size < 3; at += 5 * MIN) {
      await w.step(at);
      for (const row of await w.casuals()) {
        const lane = laneOf(row);
        if (!["day", "thought", "habit"].includes(lane) || seen.has(lane)) continue;
        seen.add(lane);
        assert.equal(row.status, "skipped", `${lane}: ${draft}`);
        assert.equal(row.body, "", `${lane}: an unsafe draft is never persisted for sending`);
        assert.match(row.reason ?? "", /^gate:/);
      }
    }
    assert.equal(seen.size, 3, draft);
    assert.ok(!w.sent.includes(draft), `no actual send contains ${draft}`);
  }
});

test("an unreadable market or disabled research cannot turn old timeline words into fresh evidence", async (t) => {
  for (const research of [null, reading({ insight: READ, figures: [] })]) {
    for (const draft of ["bought pepe, back to the notebook.", "the majors are up today, back to the notebook."]) {
      const w = await world(t, { research, casualDraft: draft });
      const old = await store.schedulePost(w.db, { tenant: TENANT, xUserId: "111", kind: "buy", dedupeKey: "old-style-memory", body: "bought pepe with a careful eye on the notes.", nowMs: NOW - DAY, dueAtMs: NOW - DAY });
      await store.claimPost(w.db, old!, NOW - DAY);
      await store.markPosted(w.db, old!, "998", NOW - DAY);
      const { row } = await w.firstCasual();
      assert.equal(row.status, "skipped", draft);
      assert.equal(row.body, "");
      assert.match(row.reason ?? "", /^gate:/);
      await w.step(row.dueAtMs + MIN);
      assert.deepEqual(w.sent, []);
    }
  }
});

test("non-market lanes keep ordinary musings and general trading methods without inventing actions", async (t) => {
  const examples: [TimelineLane, string, (prompt: string) => boolean][] = [
    ["day", "a robot can have messy thoughts too.", (p) => p.includes("being a software agent")],
    ["thought", "a robot can have messy thoughts too.", (p) => !p.includes("being a software agent") && !p.includes("notes and patience")],
    ["habit", "i read the notes before deciding.", (p) => p.includes("notes and patience")],
    ["habit", "patience helps me think before deciding.", (p) => p.includes("notes and patience")],
  ];
  for (const [lane, draft, matches] of examples) {
    const w = await world(t, { variety: true, research: reading(), facts: { ...FACTS, strategy: "dip-hunter" }, casualDraft: (p) => matches(p) ? draft : "PASS" });
    let found: store.XPost | undefined;
    for (let at = NOW; at < NOW + 4 * DAY && !found; at += 5 * MIN) {
      await w.step(at);
      found = (await w.casuals()).find((p) => laneOf(p) === lane);
    }
    assert.ok(found, lane);
    assert.equal(found.status, "scheduled", `${lane}: ${found.reason}`);
    assert.equal(found.body, draft);
    await w.step(found.dueAtMs + MIN);
    assert.ok(w.sent.includes(draft), `${lane}: a valid draft reaches the send boundary`);
  }
});

test("a supplied buy on another tenant's ordinary trade-talk day retains its existing evidence", async (t) => {
  const draft = "bought pepe, back to the notebook.";
  const w = await world(t, { active: false, facts: { ...FACTS, calls: [{ side: "buy", symbol: "PEPE", name: "Pepe", token: null,
    paper: false, decisionId: "verified-buy", atSec: (NOW - DAY) / 1000, bands: [], ownWords: null }] },
    casualDraft: (p) => p.includes("Coins you bought lately") ? draft : "PASS" });
  let accepted: store.XPost | undefined;
  for (let at = NOW; at < NOW + 7 * DAY && !accepted; at += 5 * MIN) {
    await w.step(at);
    accepted = (await w.casuals()).find((p) => p.body === draft);
  }
  assert.ok(accepted, "a supported acquisition remains available when its coin is actually supplied");
  assert.equal(accepted.status, "scheduled");
  assert.deepEqual(w.asked, []);
});
