/**
 * AN ACTIVE AGENT'S TRADES, SEEN (the owner's ask, 2026-10-14): a burst of
 * buys is said in one recap with code's figures, even when the model passes
 * on every single post; a buy at three in the morning goes out that night;
 * every recap line clears the real gate, live and paper.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, it, test, type TestContext } from "node:test";
import { wrapSqlite } from "./db";
import { admitAgentLine } from "./groupchat/policy";
import type { AgentFacts, CallFact } from "./groupchat/facts";
import { makeXPoster, xpostEnv } from "./orchestrator-xpost";
import type { FetchLike } from "./xpost/client";
import { admitXPost } from "./xpost/gate";
import { recapLines } from "./xpost/recap";
import { RECAP_CALLS_PER_AGENT, RECAP_WINDOW_MS, buyKey, recapCoverOf, sellKey, type PlanSell } from "./xpost/planner";
import * as store from "./xpost/store";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const TENANT = `0x${"ab".repeat(20)}`;

function calls(nowMs: number, hoursAgo: number[], paper = false, symbols = ["CAPITOL", "WISP", "INDEX"]): CallFact[] {
  return hoursAgo.map((h, i) => ({ decisionId: `fill-${i}`, side: "buy", symbol: symbols[i % symbols.length]!, name: null, token: null,
    paper, atSec: (nowMs - h * HOUR) / 1000, bands: ["curve early"], ownWords: null }));
}
const sale = (nowMs: number, hoursAgo: number, n: number, outcome: PlanSell["outcome"], gainPct: number | null = null): PlanSell =>
  ({ decisionId: `sale-${n}`, side: "sell", symbol: "WISP", name: null, paper: false, atSec: (nowMs - hoursAgo * HOUR) / 1000,
    operationKey: `0x${String(n).padStart(64, "e")}`, token: `0x${"c".repeat(40)}`, outcome, gainPct });

async function world(t: TestContext, o: { now: number; calls: CallFact[]; tz?: string | null; draft?: string; sales?: () => PlanSell[]; zoneFails?: () => boolean; name?: string; factsOpts?: unknown[]; replies?: boolean; standard?: boolean }) {
  const raw = new DatabaseSync(":memory:");
  t.after(() => raw.close());
  const db = wrapSqlite(raw), dek = randomBytes(32);
  await store.ensureXpostSchema(db, "sqlite");
  await store.upsertAccount(db, dek, { tenant: TENANT, xUserId: "111", username: "alanaidale",
    tokens: { accessToken: "a", refreshToken: "r", accessExpiresAtMs: o.now + 7 * DAY, scope: "tweet.read tweet.write" }, nowMs: o.now - 3 * DAY });
  await store.setPosting(db, TENANT, { enabled: true, xUserId: "111" }, o.now - 2 * DAY);
  const intro = await store.schedulePost(db, { tenant: TENANT, xUserId: "111", kind: "intro", dedupeKey: `intro:${TENANT}:111`, body: "I am an AI trading agent", nowMs: o.now - 2 * DAY, dueAtMs: o.now - 2 * DAY });
  await store.claimPost(db, intro!, o.now - 2 * DAY);
  await store.markPosted(db, intro!, "999", o.now - 2 * DAY);
  const sends: { text: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    if (url.includes("/mentions?")) return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ meta: { result_count: 0 } }) };
    sends.push(JSON.parse(init.body ?? "{}"));
    return { status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ data: { id: `1000000000000007${sends.length}0` } }) };
  };
  const facts: AgentFacts = { tenant: TENANT, agentId: TENANT, slug: null, name: o.name ?? "Alan Al Dale", mode: "live", ageDays: 20, strategy: "trencher", traits: [], calls: o.calls };
  const poster = makeXPoster({
    app: { clientId: "client", clientSecret: "secret", redirectUri: "https://app.test/connect/x" }, dek,
    creds: { provider: "groq", transport: "openai", model: "test", apiKey: "k", baseUrl: "https://model.test/v1", vision: false },
    knobs: { ...xpostEnv(o.standard ? {} : { MERRYMEN_XPOST_ACTIVE_TENANTS: TENANT }), repliesApproved: o.replies ?? true },
    deps: { dialect: "sqlite", fetch, monotonic: () => 0, facts: async (...args) => { o.factsOpts?.push(args[4]); return new Map([[TENANT, facts]]); },
      member: async () => { if (o.zoneFails?.()) throw new Error("member read failed"); return { tz: o.tz ?? null }; },
      // The model passes on everything unless a draft is given: a recap needs none.
      llm: async () => o.draft ?? "PASS",
      ...(o.sales ? {
        socialProfile: async () => ({ xTradeResults: true, currentAgent: { address: TENANT, chainId: 4663 } }),
        saleResults: async () => o.sales!(),
      } : {}) },
  });
  const step = (now: number) => poster.step(db, [{ tenant: TENANT, agentId: TENANT }], new Map(), now);
  const rows = async () => (await store.postsOf(db, TENANT, 0)).filter((p) => p.kind !== "intro");
  return { step, rows, sends };
}

test("a burst of buys is said in one recap, with code's figures, though the model passed on every single post", async (t) => {
  const now = Date.UTC(2026, 9, 13, 9);
  const w = await world(t, { now, calls: calls(now, [3, 2.8, 2.6, 2.4, 2.2, 2, 1.5, 1]) });
  await w.step(now);
  const recap = (await w.rows()).find((p) => p.kind === "recap");
  assert.ok(recap, "a recap is planned");
  assert.equal(recap!.status, "scheduled", recap!.reason ?? "");
  assert.match(recap!.body, /\. recap: 8 buys; traded (?:[A-Z]+(?:, )?){3}\.$/);
  // It records exactly the trades it said (review, 2026-10-14).
  assert.deepEqual(recapCoverOf(recap!.coin).sort(), Array.from({ length: 8 }, (_, i) => buyKey(`fill-${i}`)).sort());
  // It goes out when due, as it was written.
  await w.step(recap!.dueAtMs + MIN);
  assert.ok(w.sends.some((s) => s.text === recap!.body), "and is sent");
});

test("a buy at three in the morning is posted that night", async (t) => {
  const now = Date.UTC(2026, 9, 13, 3);
  const w = await world(t, { now, calls: calls(now, [0.2]), tz: "UTC", draft: "grabbed some capitol, the curve looked early" });
  await w.step(now);
  const [buy] = (await w.rows()).filter((p) => p.kind === "buy");
  assert.ok(buy, "planned in the night");
  assert.equal(buy!.status, "scheduled", buy!.reason ?? "");
  await w.step(buy!.dueAtMs + MIN);
  assert.equal(w.sends.length, 1, "and sent in it");
  assert.equal((await w.rows()).filter((p) => p.kind === "casual").length, 0, "no casual post at night");
});

describe("every recap line clears the real gate", () => {
  for (const mode of ["live", "paper"] as const) {
    it(`${mode}`, () => {
      for (const seed of ["recap:a:1", "recap:b:2"]) {
        for (const line of recapLines(seed, { paper: mode === "paper" })) {
          const v = admitXPost(line, { kind: "recap", agentName: "Alan Al Dale", mode, coins: [], recentOwn: [], recentFleet: [], house: true }, (r, c) => admitAgentLine(r, c));
          assert.ok(v.ok, `${line} → ${v.ok ? "" : v.reason}`);
        }
      }
    });
  }
});

test("a recap's sale results are read again at send time: a changed outcome withholds it (review, 2026-10-14)", async (t) => {
  const now = Date.UTC(2026, 9, 13, 9);
  // Past a single post's six hours, so its wins are the recap's to count, not posts of their own (2026-10-14).
  let sales = [sale(now, 7, 1, "profit", 12.4), sale(now, 6.8, 2, "loss"), sale(now, 6.6, 3, "profit", 3)];
  const w = await world(t, { now, calls: calls(now, [3, 2.8, 2.6]), sales: () => sales });
  await w.step(now);
  const recap = (await w.rows()).find((p) => p.kind === "recap");
  assert.ok(recap, "a recap is planned");
  assert.match(recap!.body, /recap: 3 buys, 3 sells \(2 green, 1 red\), best \+12\.4%/);
  assert.ok(recapCoverOf(recap!.coin).includes(sellKey(TENANT, sales[0]!.operationKey)));
  // The best sale's evidence changes before the recap is due: it is withheld, never sent saying what is no longer true.
  sales = [{ ...sales[0]!, gainPct: 4 }, sales[1]!, sales[2]!];
  await w.step(recap!.dueAtMs + MIN);
  assert.ok(!w.sends.some((s) => s.text === recap!.body), "not sent");
  const after = (await w.rows()).find((p) => p.id === recap!.id)!;
  assert.notEqual(after.status, "posted");
});

test("a night trade post still waits when the owner's zone cannot be read (review, 2026-10-14)", async (t) => {
  const now = Date.UTC(2026, 9, 13, 3);
  let fails = false;
  const w = await world(t, { now, calls: calls(now, [0.2]), tz: "UTC", draft: "grabbed some capitol, the curve looked early", zoneFails: () => fails });
  await w.step(now);
  const [buy] = (await w.rows()).filter((p) => p.kind === "buy");
  assert.equal(buy?.status, "scheduled", "planned in the night while the zone read");
  // At send time the zone cannot be read: the night exception reads the owner's day, so it holds.
  fails = true;
  await w.step(buy!.dueAtMs + MIN);
  assert.equal(w.sends.length, 0);
});

test("a coin the ticker screens refuse costs the recap its coins, never the recap (review, 2026-10-14)", async (t) => {
  const now = Date.UTC(2026, 9, 13, 9);
  // "STOAT" clears the ticker cleaner but is this agent's own name, which the line never shows. The rest of the recap still goes.
  const w = await world(t, { now, calls: calls(now, [3, 2.8, 2.6, 2.4, 2.2, 2], false, ["STOAT", "WISP"]), name: "Pine Stoat" });
  await w.step(now);
  const recap = (await w.rows()).find((p) => p.kind === "recap");
  assert.equal(recap?.status, "scheduled", recap?.reason ?? "no recap");
  assert.match(recap!.body, /recap: 6 buys\.$/);
  assert.doesNotMatch(recap!.body, /STOAT/);
});

test("the plan pass reads a recap's window of calls with no mention batch to read (third review, 2026-10-14)", async (t) => {
  // Without one it read six hours, so trades six to eight hours old, which only a recap can say, were never seen.
  const now = Date.UTC(2026, 9, 13, 9);
  const factsOpts: unknown[] = [];
  // Replies not approved: no mention is read on any pass.
  const w = await world(t, { now, calls: calls(now, [7.5, 7.2, 7]), factsOpts, replies: false });
  await w.step(now);
  assert.ok(factsOpts.length > 0, "the plan pass read facts");
  for (const opts of factsOpts) assert.ok(((opts as { callWindowSec?: number })?.callWindowSec ?? 0) >= RECAP_WINDOW_MS / 1000, JSON.stringify(opts));
});

test("an active agent's plan pass reads its whole recap window of fills; a standard owner's keeps the default cut (review of PR #334, 2026-10-14)", async (t) => {
  const now = Date.UTC(2026, 9, 13, 9);
  const per = (o: unknown) => (o as { callsPerAgent?: number } | undefined)?.callsPerAgent;
  const active: unknown[] = [], standard: unknown[] = [];
  await (await world(t, { now, calls: calls(now, [7.5, 7.2, 7]), factsOpts: active })).step(now);
  await (await world(t, { now, calls: calls(now, [7.5, 7.2, 7]), factsOpts: standard, standard: true })).step(now);
  assert.ok(active.length > 0 && standard.length > 0, "both passes read facts");
  assert.ok(active.some((o) => per(o) === RECAP_CALLS_PER_AGENT), JSON.stringify(active));
  assert.ok(standard.every((o) => per(o) === undefined), JSON.stringify(standard));
});
