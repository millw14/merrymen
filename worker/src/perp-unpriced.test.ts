/**
 * LIGHTER DARK, NOTHING NEW — docs/perps.md rule 11, and the accounting finding
 * unknown-venue-disables-spot-breaker.
 *
 * An unread venue makes the book untotallable, and an untotallable book turns
 * the drawdown breaker OFF (policy.ts runs it only while `equityKnown`). For a
 * quarantined dust token that is the right trade; for a venue that may be
 * carrying a leveraged loss the breaker cannot see, it would let every spot buy
 * out with no loss limit at all. So while Lighter is unread and money was there
 * when it last read, every NON-EXIT is refused as `perp-unpriced`, and every
 * exit still goes out.
 *
 * Pinned here: the verdicts, that an agent with no perps is untouched, that a
 * read zero is the one carve-out, and that the refusal is the owner's fact and
 * never a public post (rule 17).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkPolicy, type AgentLimits, type AgentState, type TradeIntent } from "./policy";
import { ownerRefusalNotice } from "./owner-refusal";
import { ownerRejectRuleLabel, publicationNarrowing, publishableThesis, rejectRuleLabel, rejectRuleRemedy, type ThesisRow } from "./thesis-policy";

const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const VAULT = "0x2222222222222222222222222222222222222222" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const AAPL = "0x4444444444444444444444444444444444444444" as const;
const NOW = 1_800_000_000;

const limits: AgentLimits = {
  perTradeUsdg: 50_000_000n,
  dailyUsdg: 500_000_000n,
  allowedTargets: [ROUTER, VAULT, USDG],
  allowedAssets: [USDG, AAPL],
  maxDrawdownBps: 1_000,
  expiresAt: NOW + 86_400,
  maxOpsPerDay: 48,
  cashToken: USDG,
};

/** The tick's state with Lighter unread: equity unknown, as index.ts hands it over. */
const dark = (over: Partial<AgentState> = {}): AgentState => ({
  spentTodayUsdg: 0n,
  opsToday: 0,
  highWaterMarkUsdg: 1_000_000_000n,
  equityUsdg: 400_000_000n, // the spot half only — partial, and judged as unknown
  equityKnown: false,
  perpVenueUnread: true,
  perpLastKnownMicro: 600_000_000n,
  nowSec: NOW,
  ...over,
});

const buy: TradeIntent = { kind: "swap", target: ROUTER, sellToken: USDG, buyToken: AAPL, sellAmountRaw: 25_000_000n, notionalUsdg: 25_000_000n };
const sell: TradeIntent = { kind: "swap", target: ROUTER, sellToken: AAPL, buyToken: USDG, sellAmountRaw: 1_000_000_000_000_000_000n, notionalUsdg: 25_000_000n };
const deposit: TradeIntent = { kind: "vault-deposit", target: VAULT, amountUsdg: 25_000_000n } as TradeIntent;
const withdraw: TradeIntent = { kind: "vault-withdraw", target: VAULT, amountUsdg: 25_000_000n } as TradeIntent;

describe("while Lighter is unread", () => {
  it("A SPOT BUY IS REFUSED — the breaker cannot see the venue, so nothing new goes on in the dark", () => {
    const v = checkPolicy(buy, limits, dark());
    assert.equal(v.ok, false);
    assert.equal(!v.ok && v.rule, "perp-unpriced");
    assert.match(!v.ok ? v.detail : "", /Exits still go out/);
  });

  it("and so is a vault deposit — every non-exit, not just trades", () => {
    const v = checkPolicy(deposit, limits, dark());
    assert.equal(!v.ok && v.rule, "perp-unpriced");
  });

  it("EXITS STILL GO OUT: the sell into cash and the vault withdrawal", () => {
    assert.deepEqual(checkPolicy(sell, limits, dark()), { ok: true });
    assert.deepEqual(checkPolicy(withdraw, limits, dark()), { ok: true });
  });

  it("UNKNOWN IS NOT ZERO: a venue never read, or read to an unknown figure, refuses like a funded one", () => {
    assert.equal(checkPolicy(buy, limits, dark({ perpLastKnownMicro: null })).ok, false);
    assert.equal(checkPolicy(buy, limits, dark({ perpLastKnownMicro: undefined })).ok, false);
  });

  it("A READ ZERO is the one carve-out — nothing was there to lose when it last read", () => {
    assert.deepEqual(checkPolicy(buy, limits, dark({ perpLastKnownMicro: 0n })), { ok: true });
  });

  it("a cap the trade breaks is still named first — the more useful fact about it", () => {
    const v = checkPolicy({ ...buy, sellAmountRaw: 60_000_000n, notionalUsdg: 60_000_000n } as TradeIntent, limits, dark());
    assert.equal(!v.ok && v.rule, "per-trade-cap");
  });
});

describe("an agent with no perps is untouched", () => {
  it("perpVenueUnread false or absent refuses nothing it did not refuse before", () => {
    const plain: AgentState = { spentTodayUsdg: 0n, opsToday: 0, highWaterMarkUsdg: 0n, equityUsdg: 0n, nowSec: NOW };
    assert.deepEqual(checkPolicy(buy, limits, plain), { ok: true });
    assert.deepEqual(checkPolicy(buy, limits, { ...plain, perpVenueUnread: false, perpLastKnownMicro: 5n }), { ok: true });
  });

  it("and the breaker is untouched too: a read book in drawdown trips it exactly as before", () => {
    const v = checkPolicy(buy, limits, { spentTodayUsdg: 0n, opsToday: 0, highWaterMarkUsdg: 1_000_000_000n, equityUsdg: 850_000_000n, nowSec: NOW });
    assert.equal(!v.ok && v.rule, "drawdown-breaker");
  });
});

describe("the refusal is the owner's fact, never a post (rule 17)", () => {
  const row = (over: Partial<ThesisRow> = {}): ThesisRow => ({
    agent_id: "0xabcabcabcabcabcabcabcabcabcabcabcabcabca",
    name: "Robin",
    source: "strategist",
    action: "buy",
    symbol: "AAPL",
    size_usdg: 25,
    reason: "Earnings drift, small entry.",
    status: "rejected",
    reject_rule: "perp-unpriced",
    said: 1,
    last_at: NOW,
    first_at: NOW,
    mode: "live",
    ...over,
  });

  it("DROPS the refused post from every producer — a model's and a strategy's alike", () => {
    assert.equal(publishableThesis(row()), null);
    assert.equal(publishableThesis(row({ source: "strategy:steady-basket", reason: "the schedule says buy" })), null);
  });

  it("and the SQL half drops it too, so a bounded scan does not spend itself on it", () => {
    const narrow = publicationNarrowing("d", "t");
    assert.ok(narrow.args.includes("perp-unpriced"));
  });

  it("has no PUBLIC words, and the owner gets words and a remedy", () => {
    assert.equal(rejectRuleLabel("perp-unpriced"), null);
    assert.match(ownerRejectRuleLabel("perp-unpriced") ?? "", /Lighter/);
    assert.ok((rejectRuleRemedy("perp-unpriced") ?? "").length > 0);
  });

  it("is ONE piece of news for the owner, not one per coin — it is about the account", () => {
    const verdict = { rule: "perp-unpriced", detail: "Lighter could not be read" };
    const a = ownerRefusalNotice(null, verdict, "swap", { sell_token: USDG, buy_token: AAPL });
    const b = ownerRefusalNotice(a.key, verdict, "swap", { sell_token: USDG, buy_token: ROUTER });
    assert.ok(a.line);
    assert.equal(b.line, null);
  });
});
