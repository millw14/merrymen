/**
 * AN ACCOUNT'S OWN LIMITS ARE THE OWNER'S NEWS, NOT THE FEED'S.
 *
 * The public feed carried "Robin tried to buy TSLA · past today's number of
 * trades" once a tick, all day. Every word of it was true and none of it was a
 * view about TSLA: the strategy re-proposed its legs on schedule and the wall
 * refused each one on a rule about the ACCOUNT — its trade count, its money,
 * whether its key is armed. A stranger learns nothing from that about the
 * market and a great deal that reads like a broken agent.
 *
 * But the refusal is exactly what the OWNER must hear, and hiding it from them
 * is the one thing this repo never does. So the tests below hold both halves at
 * once, against the real functions each surface uses:
 *
 *   - the PUBLIC gate (`publishableThesis`) drops a deterministic strategy's
 *     refusal when the rule is about the account;
 *   - the OWNER's event line (`ownerRefusalNotice`) still fires for that same
 *     refusal, once per change, and the owner's desk still has a sentence for
 *     the rule on the trade row it reads.
 *
 * And the boundary: a refusal about the TRADE (an asset the key does not cover,
 * a price that moved) still publishes, and so does a model's refused thesis —
 * "I wanted X because Y, and the wall said no" is the model's actual view.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RefuseRule } from "../../packages/core/src/autonomy";
import { ownerRefusalNotice } from "./owner-refusal";
import { checkPolicy, type AgentLimits, type TradeIntent } from "./policy";
import { publishableThesis, rejectRuleLabel, type ThesisRow } from "./thesis-policy";

/**
 * EVERY rule the execution fork can write into `reject_rule`, as a record so
 * the compiler refuses this file when the union grows and this list does not.
 * An arming rule missing here is one that would go back to posting every tick.
 */
const ARMING: Record<RefuseRule, true> = {
  "not-armed": true,
  "dead-policy": true,
  "grant-too-wide": true,
  "no-executor": true,
  "live-not-enabled": true,
  "wrong-chain": true,
  "no-gas": true,
  "no-cash": true,
};
const BUDGET = ["ops-cap", "daily-cap", "deposit-cap"] as const;
const ACCOUNT_RULES = [...BUDGET, ...(Object.keys(ARMING) as RefuseRule[])];

/** A deterministic strategy's buy, refused by the wall on `rule`. */
const refused = (rule: string, over: Partial<ThesisRow> = {}): ThesisRow => ({
  agent_id: "0xabcabcabcabcabcabcabcabcabcabcabcabcabca",
  name: "Robin",
  source: "strategy:steady-basket",
  action: "buy",
  symbol: "TSLA",
  size_usdg: 8.33,
  reason: "the schedule says buy — 8.33 USDG into TSLA, its 33% of a 3-leg basket",
  status: "rejected",
  reject_rule: rule,
  said: 40,
  last_at: 1_800_000_000,
  first_at: 1_799_990_000,
  mode: "paper",
  ...over,
});

describe("the public feed", () => {
  it("DROPS a strategy's refusal on every account-wide rule", () => {
    for (const rule of ACCOUNT_RULES) {
      assert.equal(publishableThesis(refused(rule)), null, `${rule} is the owner's fact, not a post`);
    }
  });

  it("drops it for every deterministic strategy, not just the default one", () => {
    for (const source of ["strategy:even-keel", "strategy:dip-hunter", "strategy:trencher", "strategy:weekend-gap"]) {
      assert.equal(publishableThesis(refused("ops-cap", { source })), null, source);
    }
  });

  it("KEEPS a refusal about the trade itself — that one says something about the market", () => {
    for (const rule of ["asset-allowlist", "no-exit", "slippage", "no-liquidity", "per-trade-cap"]) {
      const post = publishableThesis(refused(rule));
      assert.ok(post, `${rule} is about this trade and still publishes`);
      assert.equal(post!.outcome, "refused");
    }
  });

  it("KEEPS a model's refused thesis on a budget or arming rule", () => {
    // The strategist's reason is its own view; the refusal is its honest
    // outcome. That is a post, and thesis-policy says so at the TRADED_ONLY rule.
    // (The one exception is a rule that halts every buy from every producer —
    // the drawdown breaker — pinned in drawdown-halt.test.ts.)
    const post = publishableThesis(
      refused("ops-cap", { source: "strategist", reason: "NVDA held its level through the open; adding" }),
    );
    assert.ok(post);
    assert.equal(post!.outcome, "refused");
  });

  it("KEEPS the same strategy's trades when they land", () => {
    const post = publishableThesis(refused("ops-cap", { status: "paper", reject_rule: null }));
    assert.ok(post);
    assert.equal(post!.outcome, "landed");
  });

  it("and keys on the OUTCOME, not the column — a fill is a fill even if a rule rides along", () => {
    // The drop is for a trade the wall turned back. A row that landed has
    // moved money, and a stray rule on it must not take the post down with it.
    for (const status of ["landed", "paper"]) {
      const post = publishableThesis(refused("ops-cap", { status }));
      assert.ok(post, `a ${status} fill still publishes`);
      assert.equal(post!.outcome, "landed");
    }
  });
});

describe("the owner still hears it", () => {
  // The real wall, with the day's count used up — the refusal the feed was
  // carrying once a tick.
  const MAX_OPS = 24;
  const USDG = "0x3333333333333333333333333333333333333333" as const;
  const TSLA = "0x6666666666666666666666666666666666666666" as const;
  const ROUTER = "0x1111111111111111111111111111111111111111" as const;
  const limits: AgentLimits = {
    perTradeUsdg: 1_000_000_000n,
    dailyUsdg: 1_000_000_000n,
    allowedTargets: [ROUTER],
    allowedAssets: [USDG, TSLA],
    cashToken: USDG,
    maxDrawdownBps: 10_000,
    expiresAt: 2_000_000_000,
    maxOpsPerDay: MAX_OPS,
  };
  const buy: TradeIntent = {
    kind: "swap",
    target: ROUTER,
    sellToken: USDG,
    buyToken: TSLA,
    sellAmountRaw: 8_330_000n,
    notionalUsdg: 8_330_000n,
  };
  const verdict = checkPolicy(buy, limits, {
    spentTodayUsdg: 0n,
    opsToday: MAX_OPS,
    highWaterMarkUsdg: 0n,
    equityUsdg: 0n,
    nowSec: 1_800_000_000,
  });

  it("the wall refuses on the count — the premise of every test below", () => {
    assert.equal(verdict.ok, false);
    assert.equal(!verdict.ok && verdict.rule, "ops-cap");
  });

  it("THE OWNER'S EVENT LINE FIRES for the refusal the feed now drops", () => {
    assert.ok(!verdict.ok);
    const first = ownerRefusalNotice(null, verdict, buy.kind, { sell_token: USDG, buy_token: TSLA });
    assert.ok(first.line, "the owner is told");
    assert.match(first.line!, /ops-cap/);
    assert.equal(
      publishableThesis(refused(verdict.rule)),
      null,
      "and the same refusal, as a decision row, is not a public post",
    );
  });

  it("once per change, keyed by the ACCOUNT, so three legs are one line and not three", () => {
    assert.ok(!verdict.ok);
    const tsla = ownerRefusalNotice(null, verdict, "swap", { sell_token: USDG, buy_token: TSLA });
    const nvda = ownerRefusalNotice(tsla.key, verdict, "swap", { sell_token: USDG, buy_token: "0x5555555555555555555555555555555555555555" });
    assert.equal(nvda.line, null, "the second leg is the same news");
    const other = ownerRefusalNotice(nvda.key, { rule: "daily-cap", detail: "x" }, "swap", {});
    assert.ok(other.line, "a different account rule is new news");
  });

  it("while a TOKEN rule is keyed by the token, so a second bad coin is not hidden behind the first", () => {
    const a = ownerRefusalNotice(null, { rule: "asset-allowlist", detail: "a" }, "swap", { buy_token: TSLA });
    const b = ownerRefusalNotice(a.key, { rule: "asset-allowlist", detail: "b" }, "swap", { buy_token: USDG });
    assert.ok(b.line);
  });

  it("and the owner's desk still has words for the rule on the trade row it reads", () => {
    for (const rule of ACCOUNT_RULES) {
      assert.ok(rejectRuleLabel(rule), `${rule} must still render on the owner's own tape`);
    }
  });
});
