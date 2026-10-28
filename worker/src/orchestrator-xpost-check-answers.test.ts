/**
 * A LARP CHECK, END TO END (2026-10-13): "@proj @alanaidale larp check" under a
 * project's post is read with what it sits under, the site and its GitHub are
 * checked, and one answer goes out under the tag: the model's casual take with
 * code's github and holders line after it, or, when the draft does not stand,
 * code's own casual line for the same verdict. Never with checks off, never
 * under sherwood or the house, never past the day's count.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { wrapSqlite } from "./db";
import { makeXPoster, xpostEnv } from "./orchestrator-xpost";
import { createXResearch } from "./orchestrator-xpost-research";
import type { CoinFacts, CoinFactsReader } from "./coin-facts-types";
import type { AgentFacts } from "./groupchat/facts";
import type { FetchLike } from "./xpost/client";
import type { GithubRead } from "./research/github";
import type { PageScan, ScanResult } from "./venues/research";
import { assessCheck, checkAnswers } from "./xpost/check";
import * as store from "./xpost/store";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 13, 12);
const TENANT = `0x${"ab".repeat(20)}`;
const MENTION = "100000000000000050";
const PROJECT_POST = "100000000000000040";
const CA = "0x86aF99052DB086a66aF7D764bB04d3abb81b485F";
const FACTS: AgentFacts = { tenant: TENANT, agentId: TENANT, slug: null, name: "Alan Al Dale", mode: "live", ageDays: 20, strategy: "trencher", traits: [], calls: [] };
const DRAFT = "site's up and the repo got pushes this week, contract on the page matches. real build";

function coin(o: Partial<CoinFacts> = {}): CoinFacts {
  return { network: "robinhood", observedAt: NOW, priceUsd: 0.001, fdvNowUsd: 1e6, high: null, barsFromMs: null, poolCreatedAtMs: NOW - 20 * DAY, drawdownPct: null, steepest: null,
    liquidityUsd: 80_000, change24hPct: 2, buyers24h: 50, sellers24h: 40, holders: { count: 900, top10Pct: 35, updatedAtMs: NOW }, creatorHoldingPct: 1, info: "read", poolsSeen: 1,
    links: { websites: [], twitter: null }, ...o };
}
const PAGE: PageScan = { status: 200, title: "Acme", description: "acme builds onchain widgets for traders", text: "x".repeat(2000), truncated: false, links: [],
  finalUrl: "https://acme.example/", allText: `Acme. CA: ${CA}. ` + "y".repeat(2000),
  findings: { evm: [{ address: CA, chain: "evm", where: ["text"] }], solana: [], github: [{ owner: "acme", repo: "acme-app", where: ["link"] }], x: [], telegram: false, discord: false, docs: true },
  loaded: { scripts: 3, scriptBytes: 1000, ownCalls: 5, callHosts: [] } };
const REPO: GithubRead = { ok: true, record: { readAt: NOW, owner: "acme", pickedFromOwner: false, ownerRepos: null,
  repo: { owner: "acme", repo: "acme-app", createdAtMs: NOW - 300 * DAY, pushedAtMs: NOW - 2 * DAY, stars: 52, forks: 4, fork: false, archived: false, sizeKb: 9000, commits30d: 41, commitsPartial: false, lastCommitAtMs: NOW - 2 * DAY } } };

async function world(t: TestContext, o: { env?: Record<string, string>; answer?: string; context?: string; scan?: ScanResult } = {}) {
  const raw = new DatabaseSync(":memory:");
  t.after(() => raw.close());
  const db = wrapSqlite(raw), dek = randomBytes(32);
  await store.ensureXpostSchema(db, "sqlite");
  await store.upsertAccount(db, dek, { tenant: TENANT, xUserId: "111", username: "alanaidale",
    tokens: { accessToken: "a", refreshToken: "r", accessExpiresAtMs: NOW + 7 * DAY, scope: "tweet.read tweet.write" }, nowMs: NOW - 2 * DAY });
  await store.setPosting(db, TENANT, { enabled: true, xUserId: "111" }, NOW - DAY);
  assert.equal(await store.setReplying(db, TENANT, true, "111", NOW - DAY), true);
  const intro = await store.schedulePost(db, { tenant: TENANT, xUserId: "111", kind: "intro", dedupeKey: `intro:${TENANT}:111`, body: "I am an AI trading agent", nowMs: NOW - DAY, dueAtMs: NOW - DAY });
  await store.claimPost(db, intro!, NOW - DAY);
  await store.markPosted(db, intro!, "999", NOW - DAY);
  // "@acmeproj @alanaidale larp check", under the project's own post with its CA and site.
  const mention = { id: MENTION, author_id: "333", conversation_id: PROJECT_POST, created_at: new Date(NOW - MIN).toISOString(),
    text: "@acmeproj @alanaidale larp check", referenced_tweets: [{ type: "replied_to", id: PROJECT_POST }] };
  const includes = {
    users: [{ id: "333", username: "reader", name: "A Reader" }, { id: "444", username: "acmeproj", name: "Acme" }],
    tweets: [{ id: PROJECT_POST, author_id: "444", text: o.context ?? `acme is live. CA ${CA} https://t.co/s`, entities: { urls: [{ url: "https://t.co/s", expanded_url: "https://acme.example" }] } }],
  };
  const sends: Record<string, unknown>[] = [], prompts: { system: string; prompt: string }[] = [];
  const asked = { scans: 0 };
  const fetch: FetchLike = async (url, init) => {
    if (url.includes("/mentions?")) return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: [mention], includes, meta: { result_count: 1 } }) };
    sends.push(JSON.parse(init.body ?? "{}"));
    return { status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ data: { id: `1000000000000009${sends.length}0` } }) };
  };
  const coinFacts: CoinFactsReader = async () => ({ ok: true, facts: coin() });
  const research = createXResearch({ coinFacts, now: () => NOW, check: {
    browser: { baseUrl: "http://browser.internal", token: "t" },
    scan: async (url) => { asked.scans++; return o.scan ?? { ok: true, url, page: PAGE }; },
    github: async () => REPO,
  } });
  const env = { MERRYMEN_XPOST_ACTIVE_TENANTS: TENANT, MERRYMEN_XPOST_RESEARCH: "1", MERRYMEN_XPOST_CHECKS: "1", ...o.env };
  const poster = makeXPoster({
    app: { clientId: "client", clientSecret: "secret", redirectUri: "https://app.test/connect/x" }, dek,
    creds: { provider: "groq", transport: "openai", model: "test", apiKey: "private-model", baseUrl: "https://model.test/v1", vision: false },
    knobs: { ...xpostEnv(env), repliesApproved: true },
    deps: { dialect: "sqlite", fetch, monotonic: () => 0, member: async () => ({ tz: null }), facts: async () => new Map([[TENANT, FACTS]]),
      llm: async (_c, input) => {
        if (!/Untrusted question/.test(input.prompt)) return "PASS";
        prompts.push({ system: input.system ?? "", prompt: input.prompt });
        return o.answer ?? DRAFT;
      },
      research },
  });
  const step = () => poster.step(db, [{ tenant: TENANT, agentId: TENANT }], new Map(), NOW);
  const answers = async () => (await store.postsOf(db, TENANT, 0)).filter((p) => p.kind === "answer");
  return { step, answers, sends, prompts, asked };
}

test("a larp check under a project's post: the site and its github are read, and the casual take goes out with code's line", async (t) => {
  const w = await world(t);
  await w.step();
  assert.equal(w.asked.scans, 1);
  assert.equal(w.prompts.length, 1);
  const { system, prompt } = w.prompts[0]!;
  assert.match(system, /texting back/);
  assert.match(prompt, /What you found just now/);
  assert.match(prompt, /there's a real build behind it/);
  assert.match(prompt, /acme builds onchain widgets for traders/, "the site's own line, as its unverified claim");
  assert.doesNotMatch(prompt + system, /0x86|acme\.example|\d{2,}/, "no address, no link, no figure reaches the model");
  assert.equal(w.sends.length, 1);
  const sent = w.sends[0] as { text: string; reply: { in_reply_to_tweet_id: string } };
  assert.equal(sent.reply.in_reply_to_tweet_id, MENTION, "answered under the tag, not the project's post");
  assert.equal(sent.text, `${DRAFT}. github: last push 2d ago, 41 commits in 30d, 52 stars, repo 10mo old; top10 hold 35%, creator 1%.`);
});

test("a draft that PASSes, or calls it a scam, gives way to code's own casual line for the same verdict", async (t) => {
  for (const answer of ["PASS", "honestly this is a scam, stay away"]) {
    const w = await world(t, { answer });
    await w.step();
    assert.equal(w.sends.length, 1, answer);
    const text = (w.sends[0] as { text: string }).text;
    const words = text.replace(/ github: .*$/, "");
    const read = assessCheck({ target: { kind: "coin", address: CA, chain: "evm", site: "https://acme.example/" },
      site: { url: "https://acme.example/", read: "ok", textChars: PAGE.allText.length, ownCalls: 5, docs: true, namesCoin: "yes" },
      github: { found: "repo", linkedOnly: false, pushedDaysAgo: 2, createdDaysAgo: 300, commits30d: 41, commitsPartial: false, stars: 52, fork: false, archived: false, sizeKb: 9000 },
      token: { liquidityUsd: 80_000, top10Pct: 35, creatorPct: 1, poolAgeDays: 20 } });
    assert.equal(read.verdict, "real");
    assert.ok(checkAnswers(read, MENTION).includes(words), `${answer} → ${text}`);
    assert.doesNotMatch(text, /scam|stay away/);
  }
});

test("never with checks off: the tag under someone else's post is still answered by nothing", async (t) => {
  const w = await world(t, { env: { MERRYMEN_XPOST_CHECKS: "0" } });
  await w.step();
  assert.deepEqual([w.sends.length, w.asked.scans, (await w.answers()).length], [0, 0, 0]);
});

test("never under sherwood or the house, and nothing is read for it", async (t) => {
  for (const context of [`SHERWOOD-1 presale live. CA ${CA} https://t.co/s`, `merrymen agents are live. CA ${CA} https://t.co/s`]) {
    const w = await world(t, { context });
    await w.step();
    assert.deepEqual([w.sends.length, w.asked.scans], [0, 0], context);
  }
});

test("never past the day's count of checks", async (t) => {
  const w = await world(t, { env: { MERRYMEN_XPOST_CHECKS_PER_DAY: "0" } });
  await w.step();
  assert.deepEqual([w.sends.length, w.asked.scans, (await w.answers()).length], [0, 0, 0]);
});

test("a site the browser could not see is said as no clean read, with no figures it never read", async (t) => {
  const w = await world(t, { scan: { ok: false, url: "https://acme.example/", failure: "unreachable" }, answer: "PASS" });
  await w.step();
  // The coin's own facts were read, so the holders line may still stand; the github never was.
  const text = (w.sends[0] as { text: string } | undefined)?.text ?? "";
  assert.doesNotMatch(text, /github:/);
});
