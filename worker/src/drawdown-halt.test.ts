/**
 * A TRIPPED BREAKER IS THE OWNER'S NEWS, WHOEVER PROPOSED THE BUY.
 *
 * Seen on the live feed 2026-09-23: a Trencher whose drawdown breaker had
 * tripped published thirty refused buys in fifteen minutes, every one "the
 * drawdown breaker was tripped", and filled thirty of the forty trade slots.
 * Its buys ride the Brain's own decision row (the order carries the review's
 * decision id), so each refusal arrived in fresh model words under the `brain`
 * source — and the account-state rule only ever dropped STRATEGY refusals, so
 * none of them collapsed and none of them left.
 *
 * The breaker is not a view about the coin. While it is tripped every buy from
 * every producer is refused for the same reason, so a model re-reviewing every
 * thirty seconds writes the same fact in new words forever. These hold both
 * halves: the public gate (and its SQL half) drops it for every source, and
 * the owner still hears it through the real wall and the real notice.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { wrapSqlite } from "./db";
import { ownerRefusalNotice } from "./owner-refusal";
import { checkPolicy, type AgentLimits, type TradeIntent } from "./policy";
import { publicationNarrowing, publishableThesis, rejectRuleLabel, type ThesisRow } from "./thesis-policy";

/** The Trencher's refused entry, as the feed reader hands it to the gate. */
const trencherBuy = (over: Partial<ThesisRow> = {}): ThesisRow => ({
  agent_id: "0xabcabcabcabcabcabcabcabcabcabcabcabcabca",
  name: "Shogun",
  source: "brain",
  action: "buy",
  symbol: "T3139F043B88",
  display_name: "JUGGERNAUT",
  size_usdg: 5,
  reason: "Five-minute flow flipped to net buying on rising volume; small entry, invalidated if sellers return.",
  status: "rejected",
  reject_rule: "drawdown-breaker",
  said: 1,
  last_at: 1_800_000_000,
  first_at: 1_800_000_000,
  mode: "live",
  ...over,
});

describe("the public feed", () => {
  it("DROPS a model's buy the tripped breaker refused — the Trencher case", () => {
    assert.equal(publishableThesis(trencherBuy()), null);
  });

  it("drops it for a deterministic strategy too", () => {
    assert.equal(publishableThesis(trencherBuy({ source: "strategy:trencher", reason: "entry: flow and depth cleared" })), null);
    assert.equal(publishableThesis(trencherBuy({ source: "strategy:steady-basket", reason: "the schedule says buy" })), null);
  });

  it("KEEPS a model's refused thesis on any other account rule — that boundary is unchanged", () => {
    const post = publishableThesis(trencherBuy({ reject_rule: "ops-cap" }));
    assert.ok(post, "a model's refused view on ops-cap still publishes");
    assert.equal(post!.outcome, "refused");
  });

  it("KEEPS the same buy when it lands — the rule is about refusals, not the column", () => {
    const post = publishableThesis(trencherBuy({ status: "landed" }));
    assert.ok(post);
    assert.equal(post!.outcome, "landed");
  });

  it("and the SQL half drops it too, so a day of them cannot fill a bounded scan", async () => {
    const raw = new DatabaseSync(":memory:");
    const db = wrapSqlite(raw);
    try {
      await db.exec(`CREATE TABLE decisions(id TEXT, source TEXT, action TEXT);
        CREATE TABLE trades(id INTEGER PRIMARY KEY AUTOINCREMENT, decision_id TEXT, status TEXT, reject_rule TEXT);`);
      const rows: [string, string, string, string | null][] = [
        ["tripped", "brain", "rejected", "drawdown-breaker"],
        ["tripped-strategy", "strategy:trencher", "rejected", "drawdown-breaker"],
        ["capped", "brain", "rejected", "ops-cap"],
        ["landed", "brain", "landed", null],
      ];
      for (const [id, source, status, rule] of rows) {
        await db.prepare("INSERT INTO decisions VALUES (?, ?, 'buy')").run(id, source);
        await db.prepare("INSERT INTO trades (decision_id, status, reject_rule) VALUES (?, ?, ?)").run(id, status, rule);
      }
      const narrow = publicationNarrowing("d", "t");
      const kept = new Set(
        ((await db
          .prepare(`SELECT d.id AS id FROM decisions d LEFT JOIN trades t ON t.decision_id = d.id WHERE ${narrow.sql}`)
          .all(...narrow.args)) as { id: string }[]).map((r) => r.id),
      );
      assert.ok(!kept.has("tripped"), "a model's breaker refusal never reaches the gate");
      assert.ok(!kept.has("tripped-strategy"));
      assert.ok(kept.has("capped"), "a model's ops-cap refusal still reaches it");
      assert.ok(kept.has("landed"));
    } finally {
      raw.close();
    }
  });
});

describe("the owner still hears it", () => {
  const USDG = "0x3333333333333333333333333333333333333333" as const;
  const COIN = "0x6666666666666666666666666666666666666666" as const;
  const ROUTER = "0x1111111111111111111111111111111111111111" as const;
  const limits: AgentLimits = {
    perTradeUsdg: 1_000_000_000n,
    dailyUsdg: 1_000_000_000n,
    allowedTargets: [ROUTER],
    allowedAssets: [USDG, COIN],
    cashToken: USDG,
    maxDrawdownBps: 500,
    expiresAt: 2_000_000_000,
    maxOpsPerDay: 100,
  };
  const buy: TradeIntent = {
    kind: "swap",
    target: ROUTER,
    sellToken: USDG,
    buyToken: COIN,
    sellAmountRaw: 5_000_000n,
    notionalUsdg: 5_000_000n,
  };
  // Twenty percent under the high-water mark against a five percent limit.
  const verdict = checkPolicy(buy, limits, {
    spentTodayUsdg: 0n,
    opsToday: 0,
    highWaterMarkUsdg: 100_000_000n,
    equityUsdg: 80_000_000n,
    nowSec: 1_800_000_000,
  });

  it("the real wall refuses on the breaker — the premise", () => {
    assert.equal(verdict.ok, false);
    assert.equal(!verdict.ok && verdict.rule, "drawdown-breaker");
  });

  it("THE OWNER'S EVENT LINE FIRES for the refusal the feed now drops", () => {
    assert.ok(!verdict.ok);
    const notice = ownerRefusalNotice(null, verdict, buy.kind, { sell_token: USDG, buy_token: COIN });
    assert.ok(notice.line, "the owner is told");
    assert.match(notice.line!, /drawdown-breaker/);
    assert.equal(publishableThesis(trencherBuy({ reject_rule: verdict.rule })), null, "and the public post is not");
  });

  it("once per change, keyed by the account — thirty coins are one line, not thirty", () => {
    assert.ok(!verdict.ok);
    const first = ownerRefusalNotice(null, verdict, "swap", { sell_token: USDG, buy_token: COIN });
    const next = ownerRefusalNotice(first.key, verdict, "swap", { sell_token: USDG, buy_token: "0x5555555555555555555555555555555555555555" });
    assert.equal(next.line, null);
  });

  it("and the owner's desk still has words for it on the trade row", () => {
    assert.equal(rejectRuleLabel("drawdown-breaker"), "the drawdown breaker was tripped");
  });
});
