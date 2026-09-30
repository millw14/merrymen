/**
 * A TRADE IS NOT PUSHED OFF THE FEED BY A CLOCK.
 *
 * Measured on production: 37 of the 40 posts the reader returned were holds,
 * covering the last ten minutes. The producers are timers — a Trencher reviews
 * a coin every 30 seconds and every quiet agent files a market review every
 * five minutes — and the reader had ONE budget, ordered by the newest row in
 * each group, so a re-proposed hold jumped back to the top on every tick and a
 * buy that landed three hours ago fell off the end of the scan.
 *
 * These run the real query against a real SQLite ledger, because the defect was
 * the query: a LIMIT shared between two kinds of row that arrive at rates three
 * orders of magnitude apart.
 *
 * The review of that split found the same shape five more times — a lane that
 * one busy agent could fill, a bounded scan spent on rows the gate drops, a
 * newer unpublishable row deciding a name on its own, a vault move treated as
 * a view a newer row could replace, and "since" claimed across a change of
 * mind. Each has a case below, built from the reviewer's own reproduction.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { translateQuery, wrapSqlite } from "../../../worker/src/db";
import { beatsOf, pillBeats, watchCount } from "../terminal/beat";
import { alertsOf, alertsRead, emptyAlerts } from "./rail-alerts";
import { readTheses } from "./read-theses";

const SLUG = "ems76d3cncwbt3dz";
const OTHER = "hr5k2m9q4w7x3z8n";
const NOW = Math.floor(Date.now() / 1000);

type Row = {
  id: string;
  agent?: string;
  action: string | null;
  symbol: string | null;
  size?: number | null;
  source?: string;
  reason: string;
  at: number;
  display?: string | null;
  holdKind?: string | null;
};
type Trade = { decision: string; status: string; rule?: string | null };
type Agent = { account: string; name: string; handle?: string | null; verified?: number };

const AGENTS: Agent[] = [
  { account: "0xabc", name: "Shogun" },
  { account: "0xdef", name: "SirSendIt" },
];

/**
 * A ledger shaped like the worker's. `legacy` is one written before the coin's
 * name and the handle's proof had columns — the reader must still read it.
 */
async function ledger(rows: Row[], trades: Trade[] = [], opts: { legacy?: boolean; agents?: Agent[] } = {}) {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  raw.exec(`CREATE TABLE agents(smart_account TEXT, name TEXT, x_handle TEXT, mode TEXT${opts.legacy ? "" : ", x_verified INTEGER NOT NULL DEFAULT 0"});
    CREATE TABLE decisions(id TEXT, agent_id TEXT, action TEXT, symbol TEXT, ${opts.legacy ? "" : "display_name TEXT,"} size_usdg REAL, source TEXT, reason TEXT, dropped_rule TEXT, hold_kind TEXT, at INTEGER);
    CREATE TABLE trades(id INTEGER PRIMARY KEY AUTOINCREMENT, decision_id TEXT, status TEXT, reject_rule TEXT);
    CREATE TABLE posts(decision_id TEXT, body TEXT);`);
  for (const a of opts.agents ?? AGENTS) {
    if (opts.legacy) raw.prepare("INSERT INTO agents VALUES (?,?,?,'live')").run(a.account, a.name, a.handle ?? null);
    else raw.prepare("INSERT INTO agents VALUES (?,?,?,'live',?)").run(a.account, a.name, a.handle ?? null, a.verified ?? 0);
  }
  const insert = opts.legacy
    ? raw.prepare("INSERT INTO decisions (id, agent_id, action, symbol, size_usdg, source, reason, hold_kind, at) VALUES (?,?,?,?,?,?,?,?,?)")
    : raw.prepare("INSERT INTO decisions (id, agent_id, action, symbol, display_name, size_usdg, source, reason, hold_kind, at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  raw.exec("BEGIN");
  for (const r of rows) {
    const head = [r.id, r.agent ?? "0xabc", r.action, r.symbol];
    const tail = [r.size ?? null, r.source ?? "brain", r.reason, r.holdKind ?? null, r.at];
    if (opts.legacy) insert.run(...(head as never[]), ...(tail as never[]));
    else insert.run(...(head as never[]), r.display ?? null, ...(tail as never[]));
  }
  const trade = raw.prepare("INSERT INTO trades (decision_id, status, reject_rule) VALUES (?,?,?)");
  for (const t of trades) trade.run(t.decision, t.status, t.rule ?? null);
  raw.exec("COMMIT");
  return { raw, db };
}

const identities = async () => [
  { tenant: "0x1" as const, slug: SLUG, accounts: ["0xabc" as const], createdAt: 1, updatedAt: 1 },
  { tenant: "0x2" as const, slug: OTHER, accounts: ["0xdef" as const], createdAt: 1, updatedAt: 1 },
];
const settings = async () => ({ strategy: "trencher" as const });

async function read(rows: Row[], trades: Trade[] = [], opts: { legacy?: boolean; agents?: Agent[]; agentSlug?: string } = {}) {
  const { raw, db } = await ledger(rows, trades, opts);
  try {
    return await readTheses(opts.agentSlug ? { agentSlug: opts.agentSlug } : {}, (fn) => fn(db), identities, settings);
  } finally {
    raw.close();
  }
}

/** A Trencher's review cadence: a fresh hold every 30 seconds, rotating coins. */
function holds(n: number, agent = "0xabc", symbols = 10): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `hold-${agent}-${i}`,
    agent,
    action: "hold",
    symbol: `T${(i % symbols).toString(16).toUpperCase().padStart(11, "0")}`,
    // Model prose: every review is worded differently, so none of them group.
    reason: `Flow is two-sided but thin on review ${i}; nothing worth taking yet.`,
    at: NOW - i * 30,
  }));
}

/**
 * A strategy re-saying the SAME hold on each of `names` coins, `copies` times,
 * every `every` seconds: views that only repeated, and never changed.
 */
function standing(names: number, agent = "0xabc", copies = 120, every = 30): Row[] {
  return Array.from({ length: names }, (_, k) => {
    const symbol = `T${k.toString(16).toUpperCase().padStart(11, "0")}`;
    return Array.from({ length: copies }, (_, i): Row => ({
      id: `s-${agent}-${k}-${i}`,
      agent,
      action: "hold",
      symbol,
      reason: `Flow on ${symbol} is two-sided; nothing to take.`,
      at: NOW - i * every - k,
    }));
  }).flat();
}

/** A view the agent CHANGED half an hour ago: thin two hours back, then recovered. */
function changedAapl(agent = "0xabc", changedAgo = 1800): Row[] {
  return [
    { id: `aapl-old-${agent}`, agent, action: "hold", symbol: "AAPL", reason: "Depth is thin; waiting.", at: NOW - 7200 },
    { id: `aapl-new-${agent}`, agent, action: "hold", symbol: "AAPL", reason: "Depth recovered and the bid is stacking; watching for the breakout.", at: NOW - changedAgo },
  ];
}

describe("actions and views have separate budgets", () => {
  it("A LANDED BUY THREE HOURS OLD SURVIVES A HUNDRED FRESH HOLDS", async () => {
    const buy: Row = {
      id: "buy-1",
      action: "buy",
      symbol: "TSLA",
      size: 5,
      source: "strategy:steady-basket",
      reason: "Adding to the basket while it trades under its average.",
      at: NOW - 3 * 3600,
    };
    const r = await read([...holds(100), buy], [{ decision: "buy-1", status: "landed" }]);
    assert.equal(r.source, "sqlite");
    const bought = r.theses.filter((t) => t.action === "buy");
    assert.equal(bought.length, 1, "the trade must be on the feed");
    assert.equal(bought[0]!.outcome, "landed");
    assert.equal(bought[0]!.symbol, "TSLA");
  });

  it("and it survives on the agent's own profile too", async () => {
    // The profile used the same one-budget reader, so a Trencher's history was
    // about twenty minutes of holds and none of its trades.
    const sell: Row = { id: "buy-2", action: "sell", symbol: "TABC", size: 4, reason: "Took the exit; depth fell away.", at: NOW - 6 * 3600 };
    const r = await read([...holds(300), sell], [{ decision: "buy-2", status: "landed" }], { agentSlug: SLUG });
    assert.ok(r.theses.some((t) => t.action === "sell" && t.outcome === "landed"));
  });

  it("A REFUSED TRADE STILL COUNTS AS AN ACTION — the owner is told what the wall did", async () => {
    const buy: Row = { id: "buy-3", action: "buy", symbol: "NVDA", size: 40, source: "strategy:steady-basket", reason: "Adding while it trades under its average.", at: NOW - 7200 };
    const r = await read([...holds(100), buy], [{ decision: "buy-3", status: "rejected", rule: "per-trade-cap" }]);
    const refused = r.theses.find((t) => t.symbol === "NVDA");
    assert.ok(refused, "a refusal is not hidden to make room");
    assert.equal(refused.outcome, "refused");
  });
});

describe("a vault move is an action, not a view a newer row can replace", () => {
  // Vault moves have no symbol, so as "views" they shared ONE (agent, '') pair
  // with each other and with every pure thesis, and only the newest survived.
  // Heads without their sizes: this author's book is private (private-book.test.ts).
  // The park sentence as the old public register wrote it; a private book reads it back without its figures.
  const parked: Row = { id: "v1", action: "vault-deposit", symbol: null, size: 25, source: "strategy:steady-basket", reason: "25.00 USDG idle above the 50.00 floor — parking it in the vault until the next buy", at: NOW - 7200 };

  it("A LANDED DEPOSIT SURVIVES A LATER REFUSED ONE", async () => {
    const again: Row = { ...parked, id: "v2", size: 3, reason: "3.00 USDG idle above the 50.00 floor — parking it in the vault until the next buy", at: NOW - 60 };
    const r = await read([parked, again], [{ decision: "v1", status: "landed" }, { decision: "v2", status: "rejected" }]);
    assert.deepEqual(r.theses.map((t) => [t.head, t.outcome]), [["vault-deposit", "landed"]]);
  });

  it("and a deposit and a later withdrawal are both on the feed", async () => {
    const out: Row = { ...parked, id: "v2", action: "vault-withdraw", size: 10, reason: "Topping cash back up to the floor.", at: NOW - 60 };
    const r = await read([parked, out], [{ decision: "v1", status: "landed" }, { decision: "v2", status: "landed" }]);
    assert.deepEqual(r.theses.map((t) => t.head).sort(), ["vault-deposit", "vault-withdraw"]);
  });
});

describe("the action lane is not spent on rows the gate drops", () => {
  const basketBuy: Row = { id: "landed", action: "buy", symbol: "TSLA", size: 5, source: "strategy:steady-basket", reason: "Adding to the basket while it trades under its average.", at: NOW - 3 * 3600 };

  it("A HUNDRED AND TWENTY REFUSED CLASS ENTRIES, THEN A LANDED BUY — the buy is on the feed", async () => {
    // The reviewer's reproduction: the class route re-proposes a refused entry
    // every tick with drifting evidence, so each is its own group and the gate
    // drops every one. A scan of ninety held nothing but those.
    const refusals = Array.from({ length: 120 }, (_, i): Row => ({
      id: `c${i}`, action: "buy", symbol: "TKNB", size: 5, source: "class-route",
      reason: `Taking 5.00 USDG of TKNB; depth ${1000 + i} and rising.`, at: NOW - i * 60,
    }));
    const r = await read([...refusals, basketBuy], [
      ...refusals.map((c) => ({ decision: c.id, status: "rejected", rule: "per-trade-cap" })),
      { decision: "landed", status: "landed" },
    ]);
    assert.ok(r.theses.some((t) => t.action === "buy" && t.symbol === "TSLA" && t.outcome === "landed"));
    assert.equal(r.tradesComplete, true, "every trade in the window reached the gate");
  });

  it("A BASKET BLOCKED ON ITS OWN ACCOUNT DOES NOT PUSH A LANDED BUY OFF — even a thousand legs of it", async () => {
    // Four steady baskets in "refuse" mode write live-not-enabled for every leg
    // on every tick. Past the scan's whole bound, only the SQL can skip them.
    const legs = Array.from({ length: 1000 }, (_, i): Row => ({
      id: `l${i}`, action: "buy", symbol: `LEG${i % 24}`, size: 4 + (i % 7), source: "strategy:steady-basket",
      reason: `the schedule says buy — leg ${i % 24} of a 24-leg basket, round ${i}`, at: NOW - i * 10,
    }));
    const r = await read([...legs, basketBuy], [
      ...legs.map((l) => ({ decision: l.id, status: "rejected", rule: "live-not-enabled" })),
      { decision: "landed", status: "landed" },
    ]);
    assert.ok(r.theses.some((t) => t.symbol === "TSLA" && t.outcome === "landed"));
    assert.equal(r.tradesComplete, true);
  });

  it("rows only the gate can judge are paged past, not stopped at", async () => {
    // An address in a model's reason is checked by the gate alone — SQL cannot.
    const leaky = Array.from({ length: 150 }, (_, i): Row => ({
      id: `m${i}`, action: "buy", symbol: "TSLA", size: 5 + i, source: "strategist",
      reason: `Copying wallet 0xdeadbeef${i.toString(16).padStart(4, "0")} into TSLA.`, at: NOW - i * 20,
    }));
    const r = await read([...leaky, basketBuy], [
      ...leaky.map((m) => ({ decision: m.id, status: "landed" })),
      { decision: "landed", status: "landed" },
    ]);
    assert.ok(r.theses.some((t) => t.symbol === "TSLA" && t.outcome === "landed" && t.reason?.startsWith("Adding")));
  });

  it("A SCAN THAT HIT ITS BOUND SAYS SO — it does not claim there were no trades", async () => {
    const leaky = Array.from({ length: 1000 }, (_, i): Row => ({
      id: `m${i}`, action: "buy", symbol: "TSLA", size: 5 + i, source: "strategist",
      reason: `Copying wallet 0xdeadbeef${i.toString(16).padStart(4, "0")} into TSLA.`, at: NOW - i * 10,
    }));
    const r = await read(leaky, leaky.map((m) => ({ decision: m.id, status: "landed" })));
    assert.equal(r.theses.filter((t) => t.action === "buy").length, 0);
    assert.equal(r.tradesComplete, false, "an empty page after a bounded scan is not zero trades");
  });

  it("a quiet window IS complete, and says so", async () => {
    const r = await read(holds(5));
    assert.equal(r.tradesComplete, true);
  });
});

describe("what the alerts rail makes of it", () => {
  it("THE REVIEWER'S CASE: the rail shows the landed buy, not 'no trades'", async () => {
    const refusals = Array.from({ length: 120 }, (_, i): Row => ({
      id: `c${i}`, action: "buy", symbol: "TKNB", size: 5, source: "class-route",
      reason: `Taking 5.00 USDG of TKNB; depth ${1000 + i} and rising.`, at: NOW - i * 60,
    }));
    const buy: Row = { id: "landed", action: "buy", symbol: "TSLA", size: 5, source: "strategy:steady-basket", reason: "Adding to the basket while it trades under its average.", at: NOW - 3 * 3600 };
    const r = await read([...refusals, buy], [
      ...refusals.map((c) => ({ decision: c.id, status: "rejected", rule: "per-trade-cap" })),
      { decision: "landed", status: "landed" },
    ]);
    assert.deepEqual(alertsOf(r.theses).map((t) => `${t.action} ${t.symbol} ${t.outcome}`), ["buy TSLA landed"]);
  });

  it("a day whose only trade was the owner's own chat order says what is true about published posts", async () => {
    const chat: Row = { id: "chat", action: "buy", symbol: "TSLA", size: 5, source: "chat", reason: "owner asked in chat", at: NOW - 600 };
    const r = await read([chat], [{ decision: "chat", status: "landed" }]);
    assert.deepEqual(alertsOf(r.theses), []);
    assert.equal(emptyAlerts(alertsRead(r)), "No published trades in the last day.");
  });

  it("and a scan that stopped early does not speak for the whole day", async () => {
    const leaky = Array.from({ length: 1000 }, (_, i): Row => ({
      id: `m${i}`, action: "buy", symbol: "TSLA", size: 5 + i, source: "strategist",
      reason: `Copying wallet 0xdeadbeef${i.toString(16).padStart(4, "0")} into TSLA.`, at: NOW - i * 10,
    }));
    const r = await read(leaky, leaky.map((m) => ({ decision: m.id, status: "landed" })));
    assert.deepEqual(alertsOf(r.theses), []);
    assert.equal(emptyAlerts(alertsRead(r)), "No published trades among the latest posts.");
  });
});

describe("a view is the latest word per agent and name", () => {
  it("one row per agent and coin, not one per tick", async () => {
    const r = await read(holds(100));
    const views = r.theses.filter((t) => t.action === "hold");
    assert.equal(views.length, 10, "ten coins reviewed, ten posts");
    assert.equal(new Set(views.map((v) => v.symbol)).size, 10);
    // And it is the NEWEST review of each coin, not an arbitrary one.
    const first = views.find((v) => v.symbol === "T00000000000")!;
    assert.match(first.reason!, /review 0;/);
  });

  it("ONE AGENT CANNOT TAKE THE WHOLE VIEW LANE — sixty coins every 30s, and a quiet agent's hour-old view", async () => {
    // The reviewer's reproduction: 2880 holds rotating through 60 ids. Ranked
    // by the clock, every one of the 60 pairs was fresher than the quiet view.
    const quiet: Row = { id: "quiet-1", agent: "0xdef", action: "hold", symbol: "AAPL", source: "strategy:even-keel", reason: "Depth remains thin; I am holding until liquidity recovers.", at: NOW - 3600 };
    const r = await read([...holds(2880, "0xabc", 60), quiet]);
    const quietView = r.theses.find((t) => t.slug === OTHER && t.symbol === "AAPL");
    assert.ok(quietView, "the quieter agent's view reaches the client");
    const busy = r.theses.filter((t) => t.slug === SLUG);
    // The rest of the lane is the busy agent's. A fixed cap below that took no
    // slot from anybody — the turns already had — and only hid its own names.
    assert.equal(busy.length, 39, `one agent fills what the others leave, not the whole lane (${busy.length})`);
    // AND ITS COUNT IS NOT A TOTAL. Sixty names were reviewed; fewer were read.
    assert.ok(busy.every((t) => t.moreNames === true), "a truncated agent's views say there are more");
    assert.equal(quietView.moreNames, false, "an agent read in full is not flagged");
  });

  it("SEVEN BUSY AGENTS AND A QUIET ONE — the lane is dealt in turns, so the quiet view still arrives", async () => {
    // A per-agent cap alone is not enough once enough agents are busy: seven
    // Trenchers at their cap are seventy names, every one fresher than an
    // hour-old view. Every agent's newest name comes before anybody's second.
    const busy = Array.from({ length: 7 }, (_, i) => `0xb${i}`);
    const agents: Agent[] = [...busy.map((account, i) => ({ account, name: `Trencher${i}` })), { account: "0xdef", name: "SirSendIt" }];
    const rows = busy.flatMap((account) => holds(600, account, 20));
    const quiet: Row = { id: "quiet-1", agent: "0xdef", action: "hold", symbol: "AAPL", source: "strategy:even-keel", reason: "Depth remains thin; I am holding until liquidity recovers.", at: NOW - 3600 };
    const { raw, db } = await ledger([...rows, quiet], [], { agents });
    try {
      const everyone = async () => [
        ...busy.map((account, i) => ({ tenant: `0x${i + 10}` as `0x${string}`, slug: `b${i}zzzzzzzzzzzzzz`, accounts: [account as `0x${string}`], createdAt: 1, updatedAt: 1 })),
        { tenant: "0x2" as const, slug: OTHER, accounts: ["0xdef" as const], createdAt: 1, updatedAt: 1 },
      ];
      const r = await readTheses({}, (fn) => fn(db), everyone, settings);
      assert.ok(r.theses.some((t) => t.slug === OTHER && t.symbol === "AAPL"), "the quiet agent's view is in the lane");
      assert.ok(busy.every((_, i) => r.theses.some((t) => t.slug === `b${i}zzzzzzzzzzzzzz`)), "and so is every busy one");
    } finally {
      raw.close();
    }
  });

  it("another agent's quieter view is not crowded out by a busy one", async () => {
    const quiet: Row = { id: "quiet-1", agent: "0xdef", action: "hold", symbol: "AAPL", source: "strategy:even-keel", reason: "Depth remains thin; I am holding until liquidity recovers.", at: NOW - 5 * 3600 };
    const r = await read([...holds(400), quiet]);
    assert.ok(r.theses.some((t) => t.slug === OTHER && t.symbol === "AAPL"));
  });

  it("an unchanged view keeps the time it was FIRST said, and how often", async () => {
    // The same sentence re-proposed every five minutes for two hours is one
    // view that has stood for two hours, not a new post every five minutes.
    const same = Array.from({ length: 24 }, (_, i): Row => ({
      id: `same-${i}`,
      action: "hold",
      symbol: "TSLA",
      source: "strategy:even-keel",
      reason: "Depth remains thin; I am holding until liquidity recovers.",
      at: NOW - i * 300,
    }));
    const r = await read(same);
    assert.equal(r.theses.length, 1);
    const [view] = r.theses;
    assert.equal(view!.said, 24);
    assert.equal(view!.firstAt, NOW - 23 * 300);
    assert.equal(view!.unchangedSince, NOW - 23 * 300, "nothing else was said, so it has stood since then");
    assert.equal(view!.at, NOW);
  });

  it("A, THEN B, THEN A AGAIN IS NOT 'UNCHANGED SINCE' THE FIRST A", async () => {
    // The reviewer's reproduction. The latest group holds every A in the
    // window, so `said` and `firstAt` spanned the B — and the feed printed
    // "×2 · since 2h" about an agent that changed its mind twice in that time.
    const thin = "Depth remains thin; I am holding until liquidity recovers.";
    const rows: Row[] = [
      { id: "a1", action: "hold", symbol: "TSLA", source: "strategy:even-keel", reason: thin, at: NOW - 7200 },
      { id: "b1", action: "hold", symbol: "TSLA", source: "strategy:even-keel", reason: "Depth recovered; watching for an entry.", at: NOW - 3600 },
      { id: "a2", action: "hold", symbol: "TSLA", source: "strategy:even-keel", reason: thin, at: NOW - 60 },
    ];
    const r = await read(rows);
    assert.equal(r.theses.length, 1, "still the latest word only");
    const [view] = r.theses;
    assert.equal(view!.reason, thin);
    assert.equal(view!.unchangedSince, null, "something else was said in between, so there is no 'since'");
  });
});

describe("a changed view is not held off the lane by names that only repeated", () => {
  it("THE REVIEWER'S PROBE: twelve names re-said every 30s and one view changed half an hour ago — the change is on the global feed", async () => {
    // Ranked by when each name was last SAID, and capped at ten per agent, the
    // twelve repeats took every slot, All folded them into "at least 10
    // tokens", and the only view this agent had actually changed was nowhere —
    // with thirty lane slots empty. The profile showed it; the feed did not.
    const r = await read([...standing(12), ...changedAapl()]);
    const changed = r.theses.find((t) => t.symbol === "AAPL");
    assert.ok(changed, "the changed view reaches the global feed");
    assert.match(changed.reason!, /^Depth recovered/, "as it stands now");
    const views = r.theses.filter((t) => t.action === "hold");
    assert.equal(views.length, 13, "a lane with room holds every name");
    assert.ok(views.every((v) => v.moreNames === false), "so a count of them is a total, not a floor");

    // And on the page the Feed draws: the repeats are one line, the change is its own row.
    const all = pillBeats(beatsOf(r.theses, []), "all", new Map(), {});
    assert.ok(all.some((b) => b.kind === "view" && b.symbol === "AAPL"), "All shows the changed view as a row");
    const watch = all.find((b) => b.kind === "watch");
    assert.ok(watch && watch.kind === "watch");
    assert.equal(watchCount(watch), "12 tokens");
  });

  it("MORE NAMES THAN THE LANE HOLDS: the one that changed comes before fifty that only repeated", async () => {
    // Past the lane's size something is left out, and it must be a repeat: a
    // name re-said a minute ago has not changed in an hour, and the view that
    // changed thirty minutes ago is the news.
    const r = await read([...standing(50, "0xabc", 12, 300), ...changedAapl()]);
    assert.ok(r.theses.some((t) => t.symbol === "AAPL" && t.reason?.startsWith("Depth recovered")), "the changed view is in the lane");
    const views = r.theses.filter((t) => t.action === "hold");
    assert.equal(views.length, 40, "the lane is full");
    assert.ok(views.every((v) => v.moreNames === true), "and says the agent had more names than it carries");
  });

  it("THE LANE HAS ROOM, SO NOTHING IS CUT: twelve fresher changes do not push a thirteenth off", async () => {
    // Every one of these names changed within the last six minutes — a Trencher
    // words every review afresh — and the AAPL change is the agent's thirteenth
    // newest. A fixed per-agent cap dropped it from a lane two-thirds empty.
    const r = await read([...holds(144, "0xabc", 12), ...changedAapl()]);
    assert.ok(r.theses.some((t) => t.symbol === "AAPL" && t.reason?.startsWith("Depth recovered")));
    assert.equal(r.theses.filter((t) => t.action === "hold").length, 13);
  });

  it("A QUIETER AGENT'S CHANGED VIEW IS STILL NOT CROWDED OUT — sixty names changing every 30s beside it", async () => {
    // The guarantee the cap was bought for, kept by the turns: every agent's
    // newest change comes before anybody's second, however much fresher the
    // busy agent's are.
    const r = await read([...holds(2880, "0xabc", 60), ...changedAapl("0xdef", 3600)]);
    const quiet = r.theses.find((t) => t.slug === OTHER && t.symbol === "AAPL");
    assert.ok(quiet, "the quieter agent's changed view is in the lane");
    assert.match(quiet.reason!, /^Depth recovered/);
    assert.ok(r.theses.filter((t) => t.slug === SLUG).length < 60, "the busy agent does not take the whole lane");
  });

  it("A CHANGE BACK IS A CHANGE: A, then B, then A again ranks from the return, not from the first A", async () => {
    // The newest word's first copy is two hours old, but the agent left it for
    // B and came back within the half hour — that return is the change.
    const thin = "Depth is thin; waiting.";
    const aba: Row[] = [
      { id: "aba-a0", action: "hold", symbol: "AAPL", reason: thin, at: NOW - 7200 },
      { id: "aba-b", action: "hold", symbol: "AAPL", reason: "Depth recovered; watching for an entry.", at: NOW - 1800 },
      ...[900, 600, 300, 60].map((ago, i): Row => ({ id: `aba-a${i + 1}`, action: "hold", symbol: "AAPL", reason: thin, at: NOW - ago })),
    ];
    const r = await read([...standing(50, "0xabc", 12, 300), ...aba]);
    const back = r.theses.find((t) => t.symbol === "AAPL");
    assert.ok(back, "the view the agent returned to is in the lane");
    assert.equal(back.reason, thin);
    assert.equal(back.unchangedSince, null, "and it does not claim to have stood since the first A");
  });
});

describe("unchanged since means nothing else was said about the name — in either lane", () => {
  const thin = "Depth remains thin; I am holding until liquidity recovers.";

  it("A HOLD, A LANDED BUY ON THE SAME NAME, THE SAME HOLD — the hold stands since the buy, not before it", async () => {
    // The reviewer's reproduction. Each lane looked only at itself, so the hold
    // printed "×2 · since 2h" and sat two hours down, about an agent that
    // bought the name an hour ago. Clearing the "since" fixed that and broke
    // the other way: the hold then sat at its newest copy, the top of the
    // feed, every tick until its pre-buy copies left the window. The stretch
    // RESTARTS at the first copy after the buy, and counts only its own.
    const rows: Row[] = [
      { id: "a1", action: "hold", symbol: "TSLA", reason: thin, at: NOW - 7200 },
      { id: "a2", action: "hold", symbol: "TSLA", reason: thin, at: NOW - 5400 },
      { id: "b1", action: "buy", symbol: "TSLA", size: 5, source: "strategist", reason: "Taking a starter position here.", at: NOW - 3600 },
      { id: "a3", action: "hold", symbol: "TSLA", reason: thin, at: NOW - 1800 },
      { id: "a4", action: "hold", symbol: "TSLA", reason: thin, at: NOW - 60 },
    ];
    const r = await read(rows, [{ decision: "b1", status: "landed" }]);
    const hold = r.theses.find((t) => t.action === "hold")!;
    assert.equal(hold.unchangedSince, NOW - 1800, "since its first copy after the buy");
    assert.equal(hold.said, 2, "and ×2, the copies in that stretch — not ×4");
    const buy = r.theses.find((t) => t.action === "buy")!;
    assert.equal(buy.unchangedSince, NOW - 3600, "a single copy stands for itself alone");
  });

  it("a hold never said again after a trade on its name has no 'since' at all", async () => {
    // The trade is the newer thing said; the hold stands at its own last copy.
    const rows: Row[] = [
      { id: "a1", action: "hold", symbol: "TSLA", reason: thin, at: NOW - 7200 },
      { id: "a2", action: "hold", symbol: "TSLA", reason: thin, at: NOW - 5400 },
      { id: "b1", action: "buy", symbol: "TSLA", size: 5, source: "strategist", reason: "Taking a starter position here.", at: NOW - 3600 },
    ];
    const hold = (await read(rows, [{ decision: "b1", status: "landed" }])).theses.find((t) => t.action === "hold")!;
    assert.equal(hold.unchangedSince, null);
    assert.equal(hold.said, 2, "the whole window's count, with no 'since' to attach it to");
  });

  it("A REFUSAL RE-PROPOSED ACROSS A HOLD ON ITS NAME keeps its 'since' — the hold is its own row", async () => {
    // "×30 · since 2.5h · turned back" is still exactly true with a view of
    // the name in between. Clearing it ranked the refusal at its newest copy,
    // on top of the feed every tick for up to a day: the all-day refusal the
    // "since" exists to stop.
    const legs = Array.from({ length: 30 }, (_, i): Row => ({
      id: `r${i}`, action: "buy", symbol: "TSLA", size: 8.33, source: "strategy:steady-basket",
      reason: "the schedule says buy — 8.33 USDG into TSLA, its 33% of a 3-leg basket", at: NOW - (29 - i) * 300,
    }));
    const refusals = legs.map((x) => ({ decision: x.id, status: "rejected", rule: "asset-allowlist" }));
    const between: Row = { id: "h", action: "hold", symbol: "TSLA", reason: thin, at: NOW - 3600 };
    const before: Row = { ...between, at: NOW - 30 * 300 };
    const elsewhere: Row = { ...between, symbol: "NVDA" };
    for (const other of [between, before, elsewhere]) {
      const r = await read([...legs, other], refusals);
      const kept = r.theses.find((t) => t.outcome === "refused")!;
      assert.equal(kept.unchangedSince, NOW - 29 * 300, `${other.symbol} at ${NOW - other.at}s ago`);
      assert.ok(r.theses.some((t) => t.action === "hold"), "and the view is published beside it");
    }
  });

  it("a trade on the name BEFORE the hold began does not break the hold's run", async () => {
    const rows: Row[] = [
      { id: "b1", action: "buy", symbol: "TSLA", size: 5, source: "strategist", reason: "Taking a starter position here.", at: NOW - 3 * 3600 },
      ...Array.from({ length: 24 }, (_, i): Row => ({ id: `h${i}`, action: "hold", symbol: "TSLA", reason: thin, at: NOW - i * 300 })),
    ];
    const r = await read(rows, [{ decision: "b1", status: "landed" }]);
    const hold = r.theses.find((t) => t.action === "hold")!;
    assert.equal(hold.unchangedSince, NOW - 23 * 300);
  });

  it("A ROW THE FEED NEVER PUBLISHES DOES NOT BREAK A RUN — a gate-forced hold, an account refusal, the owner's chat order", async () => {
    // The other lane is read with the lane's own WHERE. A Brain on a gated key
    // files a forced hold on every tick, and a basket past its day's count
    // refuses every leg; counted as "something else said", either would take
    // the "since" off every repeat on the name and put it back on top of the
    // feed each tick — for words nobody reading the feed can see.
    const legs = Array.from({ length: 30 }, (_, i): Row => ({
      id: `r${i}`, action: "buy", symbol: "TSLA", size: 8.33, source: "strategy:steady-basket",
      reason: "the schedule says buy — 8.33 USDG into TSLA, its 33% of a 3-leg basket", at: NOW - (29 - i) * 300,
    }));
    const forced = Array.from({ length: 20 }, (_, i): Row => ({ id: `f${i}`, action: "hold", symbol: "TSLA", reason: "Held.", holdKind: "GATE_FORCED_HOLD", at: NOW - i * 300 - 7 }));
    const refused = (await read([...legs, ...forced], legs.map((x) => ({ decision: x.id, status: "rejected", rule: "asset-allowlist" })))).theses.find((t) => t.outcome === "refused")!;
    assert.equal(refused.unchangedSince, NOW - 29 * 300, "a gate-forced hold is not a word on the feed");

    const holds24 = Array.from({ length: 24 }, (_, i): Row => ({ id: `h${i}`, action: "hold", symbol: "TSLA", reason: thin, at: NOW - i * 300 }));
    const blocked = Array.from({ length: 10 }, (_, i): Row => ({ id: `ops${i}`, action: "buy", symbol: "TSLA", size: 4, source: "strategy:steady-basket", reason: "the schedule says buy", at: NOW - i * 600 - 11 }));
    const chat: Row = { id: "chat", action: "buy", symbol: "TSLA", size: 5, source: "chat", reason: "owner asked in chat", at: NOW - 3600 };
    const r = await read([...holds24, ...blocked, chat], [
      ...blocked.map((b) => ({ decision: b.id, status: "rejected", rule: "ops-cap" })),
      { decision: "chat", status: "landed" },
    ]);
    const hold = r.theses.find((t) => t.action === "hold")!;
    assert.equal(hold.unchangedSince, NOW - 23 * 300, "nor a refusal for the account's own budget, nor the owner's chat trade");
    assert.equal(r.theses.filter((t) => t.action === "buy").length, 0, "none of which is published, either");
  });
});

describe("what the gate refuses stays refused", () => {
  it("the split re-ranks rows and publishes nothing new", async () => {
    // An operational notice was never a post. Two queries must not make it one.
    const notice: Row = { id: "n-1", action: "hold", symbol: "TSLA", source: "brain", reason: "error: provider unavailable", at: NOW };
    const chat: Row = { id: "c-1", action: "buy", symbol: "TSLA", size: 5, source: "chat", reason: "owner asked in chat", at: NOW };
    const r = await read([notice, chat]);
    assert.deepEqual(r.theses, []);
  });

  it("a private hold does not take the last real view of its coin down with it", async () => {
    // A view is the latest row per (agent, name). A stale-mark or gate-forced
    // hold left in that query would BECOME the latest row, fail the gate, and
    // leave the coin with nothing — so the owner's private row would silently
    // erase the agent's public one.
    const real: Row = { id: "v-real", action: "hold", symbol: "TSLA", reason: "Buyers thinned into the close; nothing to add here.", at: NOW - 600 };
    const stale: Row = { id: "v-stale", action: "hold", symbol: "TSLA", reason: "Price feed stale, no volume to read.", holdKind: "STALE_MARK_HOLD", at: NOW };
    const gated: Row = { id: "v-gated", action: "hold", symbol: "NVDA", reason: "Held.", holdKind: "GATE_FORCED_HOLD", at: NOW };
    const r = await read([real, stale, gated]);
    assert.deepEqual(r.theses.map((t) => t.reason), ["Buyers thinned into the close; nothing to add here."]);
  });

  it("NOR DOES A NEWER ROW ONLY THE GATE CAN REFUSE — an address in the reason", async () => {
    // The reviewer's reproduction. The winner per name was chosen in SQL,
    // before the gate, so a newer row the gate drops decided the name alone.
    const real: Row = { id: "h1", action: "hold", symbol: "TABC", reason: "Buyers thinned; nothing to add.", at: NOW - 120 };
    const leaky: Row = { id: "h2", action: "hold", symbol: "TABC", reason: "Deployer 0xdeadbeefcafe still holds 40%; waiting.", at: NOW - 30 };
    const r = await read([real, leaky]);
    assert.deepEqual(r.theses.map((t) => [t.head, t.reason]), [["hold TABC", "Buyers thinned; nothing to add."]]);
    assert.equal(r.theses[0]!.unchangedSince, null, "and it is not the latest thing said, so it is not 'unchanged'");
  });

  it("nor an hour of the same provider error, re-written every tick", async () => {
    // One sentence repeated is one group, so however long the outage it is one
    // word the gate refuses and the view behind it is the next.
    const real: Row = { id: "h0", action: "hold", symbol: "TSLA", reason: "Buyers thinned into the close; nothing to add here.", at: NOW - 3600 };
    const outage = Array.from({ length: 12 }, (_, i): Row => ({ id: `e${i}`, action: "hold", symbol: "TSLA", reason: "error: provider unavailable", at: NOW - i * 290 }));
    const r = await read([real, ...outage]);
    assert.deepEqual(r.theses.map((t) => t.reason), ["Buyers thinned into the close; nothing to add here."]);
  });

  it("the coin's name reaches the post as a field, with the id kept as the symbol", async () => {
    const named: Row = { id: "n-1", action: "buy", symbol: "T3139F043B88", size: 5, display: "JUGGERNAUT", reason: "Two-sided flow into a deep enough book.", at: NOW };
    const [post] = (await read([named], [{ decision: "n-1", status: "landed" }])).theses;
    assert.equal(post!.displayName, "JUGGERNAUT");
    assert.equal(post!.symbol, "T3139F043B88");
  });

  it("an unreadable ledger is reported as one, not as a quiet fleet", async () => {
    const r = await readTheses({}, (fn) => fn(null), identities, settings);
    assert.equal(r.source, "none");
    assert.equal(r.tradesComplete, false);
  });
});

describe("a refusal that repeats sits where it started", () => {
  const leg = (i: number): Row => ({
    id: `r${i}`, action: "buy", symbol: "TSLA", size: 8.33, source: "strategy:steady-basket",
    reason: "the schedule says buy — 8.33 USDG into TSLA, its 33% of a 3-leg basket", at: NOW - (29 - i) * 300,
  });

  it("THIRTY OF THE SAME REFUSAL IS ONE POST, WITH THE TIME IT BEGAN", async () => {
    // A trade-specific rule still publishes — a basket leg the key does not
    // cover says something true — but it is re-proposed every tick.
    const rows = Array.from({ length: 30 }, (_, i) => leg(i));
    const r = await read(rows, rows.map((x) => ({ decision: x.id, status: "rejected", rule: "asset-allowlist" })));
    assert.equal(r.theses.length, 1);
    const [post] = r.theses;
    assert.equal(post!.outcome, "refused");
    assert.equal(post!.said, 30);
    assert.equal(post!.unchangedSince, NOW - 29 * 300);
  });

  it("but not across something else that happened to the same name", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => leg(i));
    const sold: Row = { id: "sold", action: "sell", symbol: "TSLA", size: 3, source: "strategy:steady-basket", reason: "Trimming back to weight.", at: NOW - 20 * 300 + 1 };
    const r = await read([...rows, sold], [...rows.map((x) => ({ decision: x.id, status: "rejected", rule: "asset-allowlist" })), { decision: "sold", status: "landed" }]);
    const refused = r.theses.find((t) => t.outcome === "refused")!;
    assert.equal(refused.unchangedSince, null);
  });

  it("nor once something newer happened to it", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => leg(i + 10));
    const sold: Row = { id: "sold", action: "sell", symbol: "TSLA", size: 3, source: "strategy:steady-basket", reason: "Trimming back to weight.", at: NOW + 60 };
    const r = await read([...rows, sold], [...rows.map((x) => ({ decision: x.id, status: "rejected", rule: "asset-allowlist" })), { decision: "sold", status: "landed" }]);
    const refused = r.theses.find((t) => t.outcome === "refused")!;
    assert.equal(refused.said, 10);
    assert.equal(refused.unchangedSince, null, "the refusals stopped being the latest word on TSLA");
  });
});

describe("the owner's handle travels only with its proof", () => {
  const view: Row = { id: "h", action: "hold", symbol: "TSLA", reason: "Buyers thinned into the close; nothing to add here.", at: NOW };

  it("a proven handle is marked proven, and an unproven one is not", async () => {
    const proven = await read([view], [], { agents: [{ account: "0xabc", name: "Shogun", handle: "shogun_x", verified: 1 }] });
    assert.equal(proven.theses[0]!.handleVerified, true);
    const typed = await read([view], [], { agents: [{ account: "0xabc", name: "Shogun", handle: "elonmusk", verified: 0 }] });
    assert.equal(typed.theses[0]!.handleVerified, false);
  });

  it("A LEDGER FROM BEFORE THE PROOF COLUMN STILL READS — with nothing proven", async () => {
    const r = await read([view], [], { legacy: true, agents: [{ account: "0xabc", name: "Shogun", handle: "shogun_x" }] });
    assert.equal(r.source, "sqlite");
    assert.equal(r.theses.length, 1);
    assert.equal(r.theses[0]!.handleVerified, false);
  });
});

describe("the same queries run on the hosted backend", () => {
  it("every placeholder is renumbered for Postgres, and each has an argument", async () => {
    // Hosted reads go through db.ts's translator, which numbers `?` by walking
    // the text and SKIPS anything it believes is inside a quoted string — so a
    // stray apostrophe in an SQL comment silently shifts every placeholder
    // after it. SQLite never notices; Postgres gets the wrong arguments.
    const issued: { sql: string; args: unknown[] }[] = [];
    const fake = {
      prepare: (sql: string) => ({
        all: async (...args: unknown[]) => {
          issued.push({ sql, args });
          return [];
        },
      }),
    };
    for (const opts of [{}, { agentSlug: SLUG }, { symbol: "TSLA" }]) {
      issued.length = 0;
      await readTheses(opts, (fn) => fn(fake as never), identities, settings);
      assert.equal(issued.length, 2, "one query per lane when the first page is short");
      for (const q of issued) {
        const pg = translateQuery(q.sql);
        assert.ok(!pg.includes("?"), "a placeholder was left unrenumbered");
        const numbers = [...pg.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
        assert.deepEqual(numbers, q.args.map((_, i) => i + 1), "placeholders and arguments must line up one to one");
      }
    }
  });
});
