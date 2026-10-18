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
import { insightFacts, type InsightRead } from "./xpost/market";
import { INSIGHT_VOCABULARY, insightPrompt } from "./xpost/writer";
import * as store from "./xpost/store";

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
const LINE = "24h: BTC +1.2%, ETH +0.8%, SOL +3.1%; trending: COINA 24h +42.1%; fomo: most bought COINA.";
const INSIGHT = "majors grinding a little higher on the day while the week stays mixed, breadth narrow and momentum concentrated in the chain's trending names.";
const isInsight = (prompt: string) => /your read on the crypto market right now/.test(prompt);
const isCasual = (prompt: string) => /Write one casual post/.test(prompt);

async function world(t: TestContext, o: { active?: boolean; research?: XResearch | null; draft?: string | (() => Promise<string>); facts?: AgentFacts } = {}) {
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
  const fetch: FetchLike = async (url) => {
    if (url.includes("/mentions?")) return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: [], meta: { result_count: 0 } }) };
    return { status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ data: { id: "1000000000000000990" } }) };
  };
  const prompts: string[] = [];
  const asked: string[] = [];
  const research = o.research === undefined ? null : o.research;
  const env = { ...(o.active === false ? {} : { MERRYMEN_XPOST_ACTIVE_TENANTS: TENANT }), ...(research ? { MERRYMEN_XPOST_RESEARCH: "1" } : {}) };
  const poster = makeXPoster({
    app: { clientId: "client", clientSecret: "secret", redirectUri: "https://app.test/connect/x" }, dek,
    creds: { provider: "groq", transport: "openai", model: "test", apiKey: "private-model", baseUrl: "https://model.test/v1", vision: false },
    knobs: { ...xpostEnv(env), repliesApproved: true },
    deps: { dialect: "sqlite", fetch, monotonic: () => 0, member: async () => ({ tz: null }), facts: async () => new Map([[TENANT, o.facts ?? FACTS]]),
      llm: async (_creds, input) => {
        prompts.push(`${input.system ?? ""}\n\n${input.prompt}`);
        return isInsight(input.prompt) ? (typeof o.draft === "function" ? o.draft() : o.draft ?? INSIGHT) : "PASS";
      },
      ...(research ? { research: { gather: async (input) => { asked.push(input.intent.kind); return research.gather(input); } } } : {}),
    },
  });
  const step = (now: number) => poster.step(db, [{ tenant: TENANT, agentId: TENANT }], new Map(), now);
  const casuals = async () => (await store.postsOf(db, TENANT, 0)).filter((p) => p.kind === "casual");
  /** Pass after pass through the owner's day until its first casual slot is written. */
  const firstCasual = async () => {
    for (let at = NOW; at < NOW + 16 * HOUR; at += 5 * MIN) {
      const r = await step(at);
      const rows = await casuals();
      if (rows.length) return { row: rows[0]!, log: r.log ?? "" };
    }
    assert.fail("no casual slot was written");
  };
  return { db, prompts, asked, firstCasual, step };
}

const reading = (bundle: Partial<ResearchBundle> = MARKET): XResearch => ({ gather: async () => ({ facts: [], lookups: 0, notes: [], ...bundle }) });

test("an active owner's casual slot is a market insight in technical words, with code's figures line after it", async (t) => {
  const w = await world(t, { research: reading() });
  const { row, log } = await w.firstCasual();
  assert.equal(row.status, "scheduled", row.reason ?? "");
  assert.equal(row.body, `${INSIGHT} ${LINE}`);
  assert.match(log, /drafted-insight 1/);
  assert.deepEqual(w.asked, ["market"], "the market read, once");
  // The model was handed code's words only: no digit, no ticker, no source, no chain's name, and never told a line follows.
  const prompt = w.prompts.find(isInsight)!;
  for (const fact of insightFacts(READ)) assert.ok(prompt.includes(fact), fact);
  const task = prompt.slice(prompt.indexOf("Write one post"));
  assert.doesNotMatch(task, /\p{N}|COINA|BTC|ETH|SOL\b|\$/u);
  assert.doesNotMatch(prompt, /coingecko|geckoterminal|bitquery|robinhood chain|figures|added after/i);
  assert.match(prompt, /momentum, volume, liquidity, rotation, breadth, risk-on and risk-off, consolidation/);
  assert.match(prompt, /Never say what comes next/);
  assert.match(prompt, /never tell anyone to buy, sell, long, short/);
  assert.match(prompt, /Never say you hold, bought, sold, are buying or will buy anything/);
  // Tickers bare: never more than one cashtag, here none.
  assert.doesNotMatch(row.body, /\$[A-Z]/);
});

test("an insight that names a source, writes a digit, gives advice, forecasts, claims a buy or names a coin is never posted", async (t) => {
  const refused: [string, RegExp][] = [
    ["per coingecko the majors are up a little on the day, volume thin.", /^gate:source-named$/],
    ["the gecko terminal board shows breadth narrow and momentum concentrated.", /^gate:source-named$/],
    ["bitquery flows look balanced, the majors drift in a tight range.", /^gate:source-named$/],
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
    const { row } = await w.firstCasual();
    assert.equal(row.status, "skipped", draft);
    assert.equal(row.body, "", draft);
    assert.match(row.reason ?? "", reason, `${draft}: ${row.reason}`);
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

test("an insight slot that goes nowhere says why in the pass's line: the model's failure or the gate's code, never its words", async (t) => {
  const cases: [string, Parameters<typeof world>[1], string][] = [
    ["the house model rate-limited", { research: reading(), draft: async () => { throw new Error("groq 429 — rate_limit_exceeded: tokens per day (TPD): Limit 500000, Used 499812"); } }, "insight no-draft:groq-429"],
    ["the house model down", { research: reading(), draft: async () => { throw new Error("groq 503 — service unavailable"); } }, "insight no-draft:groq-503"],
    ["the house model unreachable", { research: reading(), draft: async () => { throw new TypeError("fetch failed"); } }, "insight no-draft:network"],
    ["a PASS", { research: reading(), draft: "PASS" }, "insight no-draft:pass"],
    ["a digit", { research: reading(), draft: "majors up 2% on the day, momentum concentrated onchain." }, "insight gate:has-digits"],
    ["a source named", { research: reading(), draft: "per coingecko the majors are up a little on the day, volume thin." }, "insight gate:source-named"],
    // No market read: the casual post as before, and its skip is a casual one.
    ["no market read", { research: null }, "casual no-draft:pass"],
  ];
  for (const [what, o, why] of cases) {
    const w = await world(t, o);
    const { row, log } = await w.firstCasual();
    assert.equal(row.status, "skipped", what);
    // The whole line, exactly: the kind and the code, and nothing of the draft or the provider's message.
    assert.equal(log, `xpost: not-posted 1 (${why})`, what);
    assert.equal(row.reason, why.slice(why.indexOf(" ") + 1), `${what}: the row keeps the same code`);
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
