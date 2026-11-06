/**
 * A HELD COIN UNREAD, NOTHING NEW — the breaker's stand-in (policy.ts
 * `holding-unread`).
 *
 * A held coin whose balance row failed now makes the book INCOMPLETE instead
 * of freezing the tick, so every other position can still be sold. But an
 * incomplete book is `equityKnown: false`, and that switches the drawdown
 * breaker OFF for every intent. Without the rule here, an account 50% below
 * its peak — five times past its limit — would buy with no loss limit at all
 * for as long as one row kept failing. Today's freeze proposes nothing, so
 * the rule is what keeps the fix from being weaker than the bug.
 *
 * Pinned here: every non-exit refused from every kind (a buy, a vault
 * deposit, an energy buy, a strategist's perp open); every exit of anything
 * else still goes out; the unread coin's own sale refused, exits included;
 * and the rule's registrations, so it is one piece of news and never a post.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LIGHTER_ROUTE_V1,
  baseForNotional,
  effectiveMinNotionalMicro,
  leverageTarget,
  notionalMicro,
  stopPrices,
  worstPriceForTaker,
  type PerpMarketSpec,
} from "../../packages/core/src/perps";
import { classifyStage } from "./decision-funnel";
import { ownerRefusalNotice, ACCOUNT_WIDE_RULES } from "./owner-refusal";
import {
  checkPolicy,
  soldTokenOf,
  type AgentLimits,
  type AgentState,
  type PerpOpenIntent,
  type PerpPolicyState,
  type TradeIntent,
} from "./policy";
import { ACCOUNT_HALT_RULES, publicationNarrowing, publishableThesis, rejectRuleLabel, rejectRuleRemedy, type ThesisRow } from "./thesis-policy";
import { heldUnreadOf } from "./unread-held";

const NOW = 1_800_000_000;
const DAY = 86_400;
const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const VAULT = "0x2222222222222222222222222222222222222222" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const AAPL = "0x4444444444444444444444444444444444444444" as const;
const GATO = "0x436b01e41314d4b010edd24cf7c997a7d111c0ab" as const;
const V2 = "0x5555555555555555555555555555555555555555" as const;
const MERRY = "0x6666666666666666666666666666666666666666" as const;
const HOME = "0x7777777777777777777777777777777777777777" as const;
const PUB = `0x01${"00".repeat(39)}` as `0x${string}`;
const u = (n: number) => BigInt(Math.round(n * 1e6));

const limits: AgentLimits = {
  perTradeUsdg: u(50),
  dailyUsdg: u(500),
  allowedTargets: [ROUTER, VAULT, USDG],
  allowedAssets: [USDG, AAPL, GATO],
  maxDrawdownBps: 1_000,
  expiresAt: NOW + 30 * DAY,
  maxOpsPerDay: 48,
  cashToken: USDG,
  energy: { router: V2, token: MERRY },
  perp: { proxy: LIGHTER_ROUTE_V1.proxy, apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: PUB },
};

/** BTC on Lighter (sd 5, pd 1, min 0.0002, MMF 1.2%), as perp-policy.test.ts shapes it. */
const BTC: PerpMarketSpec = {
  marketId: 1,
  sizeDecimals: 5,
  priceDecimals: 1,
  minBaseAmount: 20n,
  minQuoteMicro: u(10),
  minImfBp: 200,
  defaultImfBp: 5_000,
  mmfBp: 120,
  closeoutBp: 80,
  status: "active",
};
const MARK = 830_000n;
const IMF = leverageTarget(2, BTC).imfBp;

const perpState = (positions: PerpPolicyState["positions"] = new Map()): PerpPolicyState => ({
  mode: "live",
  refuseRule: null,
  settings: {
    markets: ["BTC-PERP"],
    maxLeverage: 2,
    perTradeMicro: u(25),
    maxOpenNotionalMicro: u(50),
    maxCollateralMicro: u(30),
    maxOpensPerDay: 4,
    stopLossBps: 500,
    stopSlipBps: 200,
    liqBufferBps: 200,
    maxSlippageBps: 50,
  },
  openNotionalMicro: 0n,
  committedCollateralMicro: 0n,
  opensToday: 0,
  positions,
  markets: new Map([
    [
      1,
      {
        status: "active",
        effMinNotionalMicro: effectiveMinNotionalMicro(BTC, MARK),
        imfBpTarget: IMF,
        venueImfBp: IMF,
        venueMarginMode: "isolated",
        mmfBp: BTC.mmfBp,
        spec: BTC,
      },
    ],
  ]),
  unresolvedMarkets: new Set(),
  closeInFlightMarkets: new Set(),
  incident: false,
  entriesHalted: false,
  grantExpiresAtSec: NOW + 30 * DAY,
  nowSec: NOW,
});

/**
 * The state the tick hands over while GATO is unread: equity unknown, and 50%
 * under the peak — five times past the 10% limit sealed above. With the
 * breaker running, every buy here would be `drawdown-breaker`.
 */
const blind = (over: Partial<AgentState> = {}): AgentState => ({
  spentTodayUsdg: 0n,
  opsToday: 0,
  highWaterMarkUsdg: u(1_000),
  equityUsdg: u(500),
  equityKnown: false,
  heldUnread: heldUnreadOf(["GATO"], [{ symbol: "GATO", address: GATO }, { symbol: "AAPL", address: AAPL }]),
  perp: perpState(),
  nowSec: NOW,
  ...over,
});

const buy: TradeIntent = { kind: "swap", target: ROUTER, sellToken: USDG, buyToken: AAPL, sellAmountRaw: u(25), notionalUsdg: u(25) };
const sellAapl: TradeIntent = { kind: "swap", target: ROUTER, sellToken: AAPL, buyToken: USDG, sellAmountRaw: 10n ** 18n, notionalUsdg: u(25) };
const sellGato: TradeIntent = { kind: "swap", target: ROUTER, sellToken: GATO, buyToken: USDG, sellAmountRaw: 2_842n * 10n ** 18n, notionalUsdg: u(25) };
const deposit: TradeIntent = { kind: "vault-deposit", target: VAULT, amountUsdg: u(25) };
const withdraw: TradeIntent = { kind: "vault-withdraw", target: VAULT, amountUsdg: u(25) };
const transfer: TradeIntent = { kind: "transfer", target: USDG, recipient: HOME, amountUsdg: u(25) };
const energy: TradeIntent = { kind: "energy-buy", target: V2, sellToken: USDG, buyToken: MERRY, sellAmountRaw: u(10), notionalUsdg: u(10) };

/** A strategist's open, built exactly as the perp route builds one. */
function perpOpen(): PerpOpenIntent {
  const worst = worstPriceForTaker({ isAsk: false, mark: MARK, maxSlippageBps: 50 });
  const ref = worst > MARK ? worst : MARK;
  const base = baseForNotional(u(20), ref, BTC, "floor");
  const stop = stopPrices({ side: "long", entryRefPrice: MARK, stopLossBps: 500, stopSlipBps: 200 });
  return {
    kind: "perp-order",
    venue: "lighter",
    market: "BTC-PERP",
    marketId: 1,
    effect: "open",
    side: "long",
    reduceOnly: false,
    baseAmount: base,
    worstPrice: worst,
    markPrice: MARK,
    notionalUsdg: notionalMicro(base, ref, BTC, "ceil"),
    imfBp: IMF,
    stopTrigger: stop.trigger,
    stopPrice: stop.price,
  };
}
const perpClose: TradeIntent = {
  kind: "perp-order",
  venue: "lighter",
  market: "BTC-PERP",
  marketId: 1,
  effect: "close",
  side: "long",
  reduceOnly: true,
  baseAmount: 23n,
  worstPrice: worstPriceForTaker({ isAsk: true, mark: MARK, maxSlippageBps: 150 }),
  markPrice: MARK,
  notionalUsdg: notionalMicro(23n, MARK, BTC, "ceil"),
};

describe("the fixtures are honest", () => {
  it("with every balance read, a buy here IS the breaker's — so what refuses below is the stand-in, not a broken intent", () => {
    const read = blind({ equityKnown: true, heldUnread: undefined });
    for (const intent of [buy, deposit, energy, perpOpen()]) {
      const v = checkPolicy(intent, limits, read);
      assert.equal(!v.ok && v.rule, "drawdown-breaker", `${intent.kind}: ${JSON.stringify(v)}`);
    }
  });

  it("and with equity unknown and no stand-in, the breaker is OFF: every one of them would go out", () => {
    // This is the hazard the rule exists for (policy.ts runs the breaker only
    // while equityKnown). Left in, it is what the book-incomplete path did to
    // an unread holding before holding-unread.
    const off = blind({ heldUnread: undefined });
    for (const intent of [buy, deposit, energy, perpOpen()]) {
      assert.deepEqual(checkPolicy(intent, limits, off), { ok: true }, intent.kind);
    }
  });
});

describe("KEY REGRESSION: equity unknown, 50% under the peak, one holding unread", () => {
  it("A BUY, A VAULT DEPOSIT, AN ENERGY BUY AND A STRATEGIST'S PERP OPEN are each refused holding-unread — never ok", () => {
    for (const intent of [buy, deposit, energy, perpOpen()]) {
      const v = checkPolicy(intent, limits, blind());
      assert.equal(v.ok, false, `${intent.kind} went out with the breaker off`);
      assert.equal(!v.ok && v.rule, "holding-unread", `${intent.kind}: ${JSON.stringify(v)}`);
      assert.match(!v.ok ? v.detail : "", /GATO/);
      assert.match(!v.ok ? v.detail : "", /Exits still go out/);
    }
  });

  it("with no peak at all it still refuses — it is the read gap that refuses, not a drawdown", () => {
    const v = checkPolicy(buy, limits, blind({ highWaterMarkUsdg: 0n, equityUsdg: 0n }));
    assert.equal(!v.ok && v.rule, "holding-unread");
  });

  it("EXITS OF OTHER COINS STILL GO OUT: a sell into USDG, a transfer, a vault withdrawal, a reduce-only perp close", () => {
    assert.deepEqual(checkPolicy(sellAapl, limits, blind()), { ok: true });
    assert.deepEqual(checkPolicy(transfer, limits, blind()), { ok: true });
    assert.deepEqual(checkPolicy(withdraw, limits, blind()), { ok: true });
    const held = blind({ perp: perpState(new Map([[1, { side: "long", baseAmount: 23n }]])) });
    assert.deepEqual(checkPolicy(perpClose, limits, held), { ok: true });
  });

  it("A SALE OF THE UNREAD COIN ITSELF IS REFUSED, exit or not — its size could only be a guess", () => {
    const v = checkPolicy(sellGato, limits, blind());
    assert.equal(!v.ok && v.rule, "holding-unread");
    assert.match(!v.ok ? v.detail : "", /GATO/);
    assert.match(!v.ok ? v.detail : "", /cannot be sized/);
    // By address, whatever its case: a checksummed intent is the same coin.
    const upper = { ...sellGato, sellToken: "0x436B01E41314D4B010EDD24CF7C997A7D111C0AB" } as TradeIntent;
    assert.equal((checkPolicy(upper, limits, blind()) as { rule: string }).rule, "holding-unread");
    // And deliberately even when it would be read in another custody: the
    // coin left the tick's book whole, so no size for it was read this tick.
    const vaultLimits = { ...limits, trencherVault: VAULT, knownTrencherAssets: [GATO] };
    const custody = { ...sellGato, custody: "trencher", target: VAULT } as TradeIntent;
    assert.deepEqual(checkPolicy(custody, vaultLimits, blind({ heldUnread: undefined })), { ok: true }, "the fixture is a sale the vault may make");
    assert.equal((checkPolicy(custody, vaultLimits, blind()) as { rule: string }).rule, "holding-unread");
  });

  it("a cap the trade breaks is still named first — the more useful fact about it", () => {
    const big = { ...buy, sellAmountRaw: u(60), notionalUsdg: u(60) } as TradeIntent;
    assert.equal((checkPolicy(big, limits, blind()) as { rule: string }).rule, "per-trade-cap");
  });

  it("an unread Lighter is still named as such — perp-unpriced sits first", () => {
    const v = checkPolicy(buy, limits, blind({ perpVenueUnread: true, perpLastKnownMicro: u(600) }));
    assert.equal(!v.ok && v.rule, "perp-unpriced");
  });

  it("nothing unread refuses nothing new: empty and absent are today's behaviour", () => {
    const read = blind({ equityKnown: true, highWaterMarkUsdg: 0n, heldUnread: undefined });
    assert.deepEqual(checkPolicy(buy, limits, read), { ok: true });
    assert.deepEqual(checkPolicy(buy, limits, { ...read, heldUnread: heldUnreadOf([], []) }), { ok: true });
    assert.deepEqual(checkPolicy(sellGato, limits, read), { ok: true });
  });
});

describe("soldTokenOf — what a trade sells, and only the sold leg", () => {
  it("a swap sells its sellToken and a curve trade its assetIn", () => {
    assert.equal(soldTokenOf(sellGato), GATO);
    const curve: TradeIntent = {
      kind: "curve-trade",
      target: ROUTER,
      curve: VAULT,
      assetIn: GATO,
      assetOut: USDG,
      amountInRaw: 1n,
      minAmountOutRaw: 1n,
      notionalUsdg: 1n,
    };
    assert.equal(soldTokenOf(curve), GATO);
    // A curve exit from a readable coin INTO an unread quote sizes nothing from it.
    assert.equal(soldTokenOf({ ...curve, assetIn: AAPL, assetOut: GATO } as TradeIntent), AAPL);
  });

  it("nothing else sells a watched coin: a transfer is USDG, vault and margin moves are USDG, an energy buy spends USDG", () => {
    for (const intent of [transfer, deposit, withdraw, energy, perpOpen(), perpClose]) assert.equal(soldTokenOf(intent), null, intent.kind);
    assert.equal(soldTokenOf({ kind: "equity-order", ticker: "AAPL", side: "sell", notionalUsdg: u(5) }), null);
    assert.equal(soldTokenOf({ kind: "perp-margin", direction: "withdraw", amountUsdg: u(5) }), null);
  });
});

describe("the refusal is one piece of news for the owner, and never a post", () => {
  const row = (over: Partial<ThesisRow> = {}): ThesisRow => ({
    agent_id: "0xabcabcabcabcabcabcabcabcabcabcabcabcabca",
    name: "Robin",
    source: "strategist",
    action: "buy",
    symbol: "AAPL",
    size_usdg: 25,
    reason: "Earnings drift, small entry.",
    status: "rejected",
    reject_rule: "holding-unread",
    said: 1,
    last_at: NOW,
    first_at: NOW,
    mode: "live",
    ...over,
  });

  it("is account-wide: one line for the owner, whichever coin was proposed", () => {
    assert.ok(ACCOUNT_WIDE_RULES.has("holding-unread"));
    const verdict = { rule: "holding-unread", detail: "the balance of GATO could not be read" };
    const a = ownerRefusalNotice(null, verdict, "swap", { sell_token: USDG, buy_token: AAPL });
    const b = ownerRefusalNotice(a.key, verdict, "swap", { sell_token: USDG, buy_token: MERRY });
    assert.ok(a.line);
    assert.equal(b.line, null);
  });

  it("is an account halt: the refused post drops from every producer, and the SQL half drops it too", () => {
    assert.ok((ACCOUNT_HALT_RULES as readonly string[]).includes("holding-unread"));
    assert.equal(publishableThesis(row()), null);
    assert.equal(publishableThesis(row({ source: "strategy:steady-basket", reason: "the schedule says buy" })), null);
    assert.ok(publicationNarrowing("d", "t").args.includes("holding-unread"));
  });

  it("says the read gap, never the slug, and gives the owner a remedy that names both cases", () => {
    const say = rejectRuleLabel("holding-unread") ?? "";
    assert.ok(say.length > 0);
    assert.ok(!say.includes("holding-unread"));
    assert.doesNotMatch(say, /\/settings|\/grant|https?:/, "a public sentence carries no URL");
    const remedy = rejectRuleRemedy("holding-unread") ?? "";
    assert.match(remedy, /\/settings/);
    assert.match(remedy, /Trencher vault/);
    assert.match(remedy, /selling everything else still works/);
  });

  it("files as research incomplete in the funnel — unread is not spent", () => {
    assert.equal(classifyStage({ kind: "policy", rule: "holding-unread" }).stage, "RESEARCH_INCOMPLETE");
  });
});
