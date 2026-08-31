import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkPolicy, type AgentLimits, type AgentState, type TradeIntent } from "./policy";

const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const VAULT = "0x2222222222222222222222222222222222222222" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const AAPL = "0x4444444444444444444444444444444444444444" as const;
const EVIL = "0x9999999999999999999999999999999999999999" as const;

const NOW = 1_800_000_000;

function limits(over: Partial<AgentLimits> = {}): AgentLimits {
  return {
    perTradeUsdg: 50_000_000n, // 50 USDG
    dailyUsdg: 500_000_000n, // 500 USDG
    allowedTargets: [ROUTER, VAULT, USDG],
    allowedAssets: [USDG, AAPL],
    maxDrawdownBps: 1_000, // 10%
    expiresAt: NOW + 86_400,
    maxOpsPerDay: 48,
    ...over,
  };
}

function state(over: Partial<AgentState> = {}): AgentState {
  return {
    spentTodayUsdg: 0n,
    opsToday: 0,
    highWaterMarkUsdg: 0n,
    equityUsdg: 0n,
    nowSec: NOW,
    ...over,
  };
}

function swap(over: Partial<Extract<TradeIntent, { kind: "swap" }>> = {}): TradeIntent {
  return {
    kind: "swap",
    target: ROUTER,
    sellToken: USDG,
    buyToken: AAPL,
    sellAmountRaw: 25_000_000n,
    notionalUsdg: 25_000_000n,
    ...over,
  };
}

describe("checkPolicy", () => {
  it("approves a legal swap", () => {
    assert.deepEqual(checkPolicy(swap(), limits(), state()), { ok: true });
  });

  it("rejects after expiry, regardless of everything else", () => {
    const v = checkPolicy(swap(), limits(), state({ nowSec: NOW + 86_401 }));
    assert.equal(v.ok, false);
    assert.equal(!v.ok && v.rule, "expiry");
  });

  it("rejects a target that is not allowlisted", () => {
    const v = checkPolicy(swap({ target: EVIL }), limits(), state());
    assert.equal(!v.ok && v.rule, "target-allowlist");
  });

  it("target allowlist is case-insensitive", () => {
    const upper = ROUTER.toUpperCase().replace("0X", "0x") as `0x${string}`;
    assert.deepEqual(checkPolicy(swap({ target: upper }), limits(), state()), { ok: true });
  });

  it("rejects a swap involving a non-allowlisted asset", () => {
    const v = checkPolicy(swap({ buyToken: EVIL }), limits(), state());
    assert.equal(!v.ok && v.rule, "asset-allowlist");
  });

  it("rejects a trade above the per-trade cap", () => {
    const v = checkPolicy(swap({ sellAmountRaw: 50_000_001n, notionalUsdg: 50_000_001n }), limits(), state());
    assert.equal(!v.ok && v.rule, "per-trade-cap");
  });

  it("allows a trade exactly at the per-trade cap", () => {
    assert.deepEqual(checkPolicy(swap({ sellAmountRaw: 50_000_000n, notionalUsdg: 50_000_000n }), limits(), state()), { ok: true });
  });

  it("rejects when the daily cap would be exceeded", () => {
    const v = checkPolicy(swap(), limits(), state({ spentTodayUsdg: 490_000_000n }));
    assert.equal(!v.ok && v.rule, "daily-cap");
  });

  it("counts existing spend toward the daily cap, not just this trade", () => {
    assert.deepEqual(
      checkPolicy(swap(), limits(), state({ spentTodayUsdg: 475_000_000n })),
      { ok: true },
    );
  });

  it("trips the drawdown breaker at the threshold", () => {
    // HWM 1000, equity 900 → exactly 10% drawdown → halt
    const v = checkPolicy(
      swap(),
      limits(),
      state({ highWaterMarkUsdg: 1_000_000_000n, equityUsdg: 900_000_000n }),
    );
    assert.equal(!v.ok && v.rule, "drawdown-breaker");
  });

  describe("a tripped breaker must never lock the exit", () => {
    // The breaker brakes RISK; it does not bar the doors. Applied to every
    // kind it rejected the sell that would clear the position, the vault
    // withdrawal that would pull cash back, and the transfer home — while the
    // high-water mark only ratchets up, so nothing the agent could do cleared
    // it. The account was stuck until a human intervened, and the escape the
    // code actually offered was to DEPOSIT MORE.
    const tripped = { highWaterMarkUsdg: 1_000_000_000n, equityUsdg: 800_000_000n }; // 20%

    it("still refuses a BUY — that is the whole point of the breaker", () => {
      const v = checkPolicy(swap(), limits({ cashToken: USDG }), state(tripped));
      assert.equal(!v.ok && v.rule, "drawdown-breaker");
    });

    it("ALLOWS the de-risking sell — swapping back into cash", () => {
      const sell = swap({ sellToken: AAPL, buyToken: USDG });
      const v = checkPolicy(sell, limits({ cashToken: USDG }), state(tripped));
      assert.deepEqual(v, { ok: true });
    });

    it("ALLOWS pulling cash back out of the vault", () => {
      const v = checkPolicy(
        { kind: "vault-withdraw", target: VAULT, amountUsdg: 100_000_000n },
        limits({ cashToken: USDG }),
        state(tripped),
      );
      assert.deepEqual(v, { ok: true });
    });

    it("ALLOWS sending money home to a pinned recipient", () => {
      const v = checkPolicy(
        { kind: "transfer", target: USDG, recipient: EVIL, amountUsdg: 10_000_000n },
        // EVIL is only "evil" elsewhere; here it stands for a registered
        // withdrawal address the wall already pinned at signing time.
        limits({ cashToken: USDG, withdrawalAddresses: [EVIL] }),
        state(tripped),
      );
      assert.deepEqual(v, { ok: true });
    });

    it("without a cashToken it stays STRICT — a fixture must not silently widen the wall", () => {
      const sell = swap({ sellToken: AAPL, buyToken: USDG });
      const v = checkPolicy(sell, limits(), state(tripped)); // no cashToken
      assert.equal(!v.ok && v.rule, "drawdown-breaker");
    });

    it("an exit is still subject to every OTHER rule — this is not a bypass", () => {
      const sell = swap({ sellToken: AAPL, buyToken: USDG });
      const v = checkPolicy(sell, limits({ cashToken: USDG }), state({ ...tripped, nowSec: NOW + 999_999 }));
      assert.equal(!v.ok && v.rule, "expiry");
    });
  });

  it("does not trip the breaker just below the threshold", () => {
    const v = checkPolicy(
      swap(),
      limits(),
      state({ highWaterMarkUsdg: 1_000_000_000n, equityUsdg: 901_000_000n }),
    );
    assert.deepEqual(v, { ok: true });
  });

  it("ignores drawdown before any high-water mark exists", () => {
    assert.deepEqual(
      checkPolicy(swap(), limits(), state({ highWaterMarkUsdg: 0n, equityUsdg: 0n })),
      { ok: true },
    );
  });

  /**
   * UNKNOWN equity is not LOW equity.
   *
   * When a held asset can't be valued — a memecoin whose pool got too thin, a
   * feed that was withdrawn — the tick's equity figure is a partial sum with
   * that holding simply missing. Judging a drawdown on it reads the gap as a
   * loss, trips the breaker, and rejects every intent INCLUDING the sell that
   * would clear the position. The agent locks the owner in at the exact moment
   * it promised them "you can always get out", and it can never recover on its
   * own: the high-water mark isn't lowered while the book is incomplete, and the
   * book stays incomplete while the token is held.
   */
  describe("drawdown breaker on an unknown book", () => {
    // $8k of the $10k book is an unpriceable memecoin; the visible part is $2k.
    const partial = { highWaterMarkUsdg: 10_000_000_000n, equityUsdg: 2_000_000_000n };

    it("does NOT judge a drawdown when the book can't be totalled", () => {
      assert.deepEqual(
        checkPolicy(swap(), limits(), state({ ...partial, equityKnown: false })),
        { ok: true },
      );
    });

    it("still trips on the same numbers when the book IS complete", () => {
      const v = checkPolicy(swap(), limits(), state({ ...partial, equityKnown: true }));
      assert.equal(!v.ok && v.rule, "drawdown-breaker", "a real 80% drawdown must still halt");
    });

    it("treats an absent flag as a known book, so existing callers are unchanged", () => {
      const v = checkPolicy(swap(), limits(), state(partial));
      assert.equal(!v.ok && v.rule, "drawdown-breaker");
    });

    it("an unknown book does not become a free pass — every other rule still applies", () => {
      const unknown = { ...partial, equityKnown: false };
      assert.equal(
        !checkPolicy(swap(), limits(), state({ ...unknown, opsToday: 48 })).ok,
        true,
        "ops cap",
      );
      assert.equal(
        !checkPolicy(swap(), limits(), state({ ...unknown, spentTodayUsdg: 490_000_000n })).ok,
        true,
        "daily cap",
      );
      assert.equal(
        !checkPolicy(swap(), limits(), state({ ...unknown, nowSec: 9_999_999_999 })).ok,
        true,
        "expiry",
      );
    });
  });

  it("rejects once the daily ops budget is spent", () => {
    const v = checkPolicy(swap(), limits(), state({ opsToday: 48 }));
    assert.equal(!v.ok && v.rule, "ops-cap");
  });

  it("vault deposits are capped at the DAILY limit, mirroring the on-chain policy", () => {
    // A deposit above the per-trade cap (50) but under the daily cap (500) is
    // fine — parking idle cash in the vault isn't a market spend, and the
    // on-chain deposit policy caps at dailyUsdg, not perTradeUsdg. The old
    // mirror rejected this and stranded funded agents in a rejection loop.
    assert.deepEqual(
      checkPolicy({ kind: "vault-deposit", target: VAULT, amountUsdg: 60_000_000n }, limits(), state()),
      { ok: true },
    );
    // But a single deposit over the daily cap is still rejected.
    const v = checkPolicy(
      { kind: "vault-deposit", target: VAULT, amountUsdg: 500_000_001n },
      limits(),
      state(),
    );
    assert.equal(!v.ok && v.rule, "deposit-cap");
  });

  it("vault withdrawals are exempt from spend caps (funds return to the account)", () => {
    const v = checkPolicy(
      { kind: "vault-withdraw", target: VAULT, amountUsdg: 10_000_000_000n },
      limits(),
      state({ spentTodayUsdg: 500_000_000n }),
    );
    assert.deepEqual(v, { ok: true });
  });

  it("vault withdrawals still respect expiry and the ops cap", () => {
    const intent: TradeIntent = { kind: "vault-withdraw", target: VAULT, amountUsdg: 1n };
    const expired = checkPolicy(intent, limits(), state({ nowSec: NOW + 86_401 }));
    assert.equal(!expired.ok && expired.rule, "expiry");
    const throttled = checkPolicy(intent, limits(), state({ opsToday: 48 }));
    assert.equal(!throttled.ok && throttled.rule, "ops-cap");
  });

  // ── transfers: money leaving the wall is a spend, not a withdrawal ────────
  const RECIPIENT = "0x5555555555555555555555555555555555555555" as const;
  const transfer = (over: Partial<Extract<TradeIntent, { kind: "transfer" }>> = {}): TradeIntent => ({
    kind: "transfer",
    target: USDG,
    recipient: RECIPIENT,
    amountUsdg: 25_000_000n,
    ...over,
  });

  it("approves a legal transfer (free-form recipient, capped amount)", () => {
    assert.deepEqual(checkPolicy(transfer(), limits(), state()), { ok: true });
  });

  it("rejects a transfer with a malformed recipient — garbage never reaches calldata", () => {
    const v = checkPolicy(transfer({ recipient: "robins-other-wallet" as `0x${string}` }), limits(), state());
    assert.equal(!v.ok && v.rule, "transfer-recipient");
    const v2 = checkPolicy(transfer({ recipient: "0xdeadbeef" as `0x${string}` }), limits(), state());
    assert.equal(!v2.ok && v2.rule, "transfer-recipient");
  });

  it("rejects a zero/negative transfer", () => {
    const v = checkPolicy(transfer({ amountUsdg: 0n }), limits(), state());
    assert.equal(!v.ok && v.rule, "transfer-amount");
  });

  it("transfers obey the per-trade cap", () => {
    const v = checkPolicy(transfer({ amountUsdg: 50_000_001n }), limits(), state());
    assert.equal(!v.ok && v.rule, "per-trade-cap");
  });

  it("transfers count against the daily cap — NOT exempt like vault withdrawals", () => {
    const v = checkPolicy(transfer(), limits(), state({ spentTodayUsdg: 490_000_000n }));
    assert.equal(!v.ok && v.rule, "daily-cap");
  });

  it("transfers still respect expiry and the ops cap", () => {
    const expired = checkPolicy(transfer(), limits(), state({ nowSec: NOW + 86_401 }));
    assert.equal(!expired.ok && expired.rule, "expiry");
    const throttled = checkPolicy(transfer(), limits(), state({ opsToday: 48 }));
    assert.equal(!throttled.ok && throttled.rule, "ops-cap");
  });
});

/**
 * NEVER ENTER A POSITION THE KEY CANNOT EXIT.
 *
 * Buying spends USDG, and approving USDG is one generic permission every grant
 * carries. Selling needs a per-token approve sealed into the signature. So a
 * token with a live pool but no approve permission buys fine and can never be
 * sold — the exit reverts at the wall, with the owner's money inside.
 *
 * This is not hypothetical. On 2026-07-27, eleven registry stocks (AAPL, MSFT,
 * SPY and friends) had live pools while the signed allowlist still read
 * QQQ/NVDA/TSLA, and /settings offered every one of them as a basket option.
 */
describe("checkPolicy — the no-exit rule", () => {
  const CATE = "0x5555555555555555555555555555555555555555" as const;
  const sellable = (...a: string[]) => limits({ allowedAssets: [USDG, AAPL, CATE], sellableAssets: a });

  it("REFUSES a buy the key cannot sell back", () => {
    const v = checkPolicy(swap({ buyToken: CATE }), sellable(USDG, AAPL), state());
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.rule, "no-exit");
  });

  it("allows the buy once the grant covers it", () => {
    assert.equal(checkPolicy(swap({ buyToken: CATE }), sellable(USDG, AAPL, CATE), state()).ok, true);
  });

  it("NEVER blocks a sell — an exit must always be attemptable", () => {
    // CATE is not sellable per the grant, but the agent is holding it and
    // trying to get out. Refusing here would be the trap, not the guard.
    const v = checkPolicy(
      swap({ sellToken: CATE, buyToken: USDG }),
      sellable(USDG, AAPL),
      state(),
    );
    assert.equal(v.ok, true, "the wall may reject it on-chain, but policy must let it try");
  });

  it("matches addresses case-insensitively", () => {
    const v = checkPolicy(swap({ buyToken: CATE }), sellable(USDG, CATE.toUpperCase()), state());
    assert.equal(v.ok, true);
  });

  it("is inert when sellableAssets is absent — backtests and fixtures are unaffected", () => {
    const noSet = limits({ allowedAssets: [USDG, AAPL, CATE] });
    assert.equal(noSet.sellableAssets, undefined);
    assert.equal(checkPolicy(swap({ buyToken: CATE }), noSet, state()).ok, true);
  });

  it("still runs the asset allowlist first — an unlisted token fails on that, not this", () => {
    const v = checkPolicy(swap({ buyToken: EVIL }), sellable(USDG, AAPL, EVIL), state());
    assert.equal(v.ok === false && v.rule, "asset-allowlist");
  });

  it("refuses the buy BEFORE the position exists, not after", () => {
    // The on-chain policy would only reject the SELL — by which point the money
    // is already in the asset. Catching it here is the only free moment.
    const v = checkPolicy(swap({ buyToken: CATE }), sellable(USDG), state());
    assert.equal(v.ok === false && v.detail.includes("never closed"), true);
  });
});

/**
 * THE SCOUT CEILING — buying something nobody can price.
 *
 * A token the tick couldn't value has a genuinely unknown worth: its pool is too
 * new or too thin for a TWAP anyone should trust. Carrying it at cost keeps the
 * book honest, but it also means the drawdown breaker CANNOT see it move. The
 * budget is therefore the only control on this money, and it has to bite before
 * the position exists.
 */
describe("checkPolicy — the scout ceiling", () => {
  const CATE = "0x5555555555555555555555555555555555555555" as const;
  const base = limits({ allowedAssets: [USDG, AAPL, CATE], sellableAssets: [USDG, AAPL, CATE] });
  const scout = (over: Partial<import("./policy").ScoutContext> = {}) => ({
    limits: { enabled: true, budgetUsdg: 100_000_000n, perTokenUsdg: 25_000_000n },
    buyUnpriceable: true,
    existingCostUsdg: 0n,
    quarantinedUsdg: 0n,
    ...over,
  });

  it("allows an unpriceable buy inside the budget", () => {
    const v = checkPolicy(swap({ buyToken: CATE, notionalUsdg: 10_000_000n }), base, state(), scout());
    assert.equal(v.ok, true);
  });

  it("REFUSES an unpriceable buy when scout mode is off", () => {
    const v = checkPolicy(
      swap({ buyToken: CATE }),
      base,
      state(),
      scout({ limits: { enabled: false, budgetUsdg: 100_000_000n, perTokenUsdg: 25_000_000n } }),
    );
    assert.equal(v.ok === false && v.rule, "scout-budget");
  });

  it("REFUSES past the per-token ceiling, counting what's already sunk in", () => {
    const v = checkPolicy(
      swap({ buyToken: CATE, notionalUsdg: 10_000_000n }),
      base,
      state(),
      scout({ existingCostUsdg: 20_000_000n }),
    );
    assert.equal(v.ok === false && v.rule, "scout-budget");
  });

  it("REFUSES past the total budget", () => {
    const v = checkPolicy(
      swap({ buyToken: CATE, notionalUsdg: 10_000_000n }),
      base,
      state(),
      scout({ quarantinedUsdg: 95_000_000n }),
    );
    assert.equal(v.ok === false && v.rule, "scout-budget");
  });

  it("does NOT gate a buy of something the tick priced fine", () => {
    const v = checkPolicy(
      swap({ buyToken: CATE }),
      base,
      state(),
      scout({ buyUnpriceable: false, limits: { enabled: false, budgetUsdg: 0n, perTokenUsdg: 0n } }),
    );
    assert.equal(v.ok, true, "a priceable token is not scout business");
  });

  it("NEVER blocks the SELL of an unpriceable position — the exit stays open", () => {
    // Holding CATE, can't price it, scout mode off and budget exhausted. Getting
    // out must still be allowed: the rule only ever inspects buyToken.
    const v = checkPolicy(
      swap({ sellToken: CATE, buyToken: USDG }),
      base,
      state(),
      scout({
        buyUnpriceable: false,
        quarantinedUsdg: 100_000_000n,
        limits: { enabled: false, budgetUsdg: 0n, perTokenUsdg: 0n },
      }),
    );
    assert.equal(v.ok, true);
  });

  it("leaves vault moves and transfers alone", () => {
    const dep: TradeIntent = { kind: "vault-deposit", target: VAULT, amountUsdg: 25_000_000n };
    assert.equal(checkPolicy(dep, base, state(), scout()).ok, true);
  });

  it("runs AFTER the no-exit rule — an unsellable token fails on that first", () => {
    const noSell = limits({ allowedAssets: [USDG, AAPL, CATE], sellableAssets: [USDG, AAPL] });
    const v = checkPolicy(swap({ buyToken: CATE }), noSell, state(), scout());
    assert.equal(v.ok === false && v.rule, "no-exit", "the more fundamental refusal wins");
  });

  it("is inert when no context is passed — backtests and fixtures are unaffected", () => {
    assert.equal(checkPolicy(swap({ buyToken: CATE }), base, state()).ok, true);
  });
});

describe("checkPolicy — equity orders (the broker rail)", () => {
  // On this rail these caps are the ONLY wall: no account contract re-checks
  // behind them (DESIGN.md §5). Every rule here is load-bearing, not a mirror.
  const eq = (over: Partial<Extract<TradeIntent, { kind: "equity-order" }>> = {}): TradeIntent => ({
    kind: "equity-order",
    ticker: "AAPL",
    side: "buy",
    notionalUsdg: 25_000_000n, // 25 USD
    ...over,
  });
  const eqLimits = (over: Partial<AgentLimits> = {}) => limits({ allowedTickers: ["AAPL", "NVDA"], ...over });

  it("approves a legal order — with NO contract target to allowlist", () => {
    // The variant has no target field, so the target-allowlist rule must not
    // fire. An empty allowedTargets proves it is genuinely skipped.
    assert.deepEqual(checkPolicy(eq(), eqLimits({ allowedTargets: [] }), state()), { ok: true });
  });

  it("rejects a ticker outside the allowlist — the broker rail's asset wall", () => {
    const v = checkPolicy(eq({ ticker: "GME" }), eqLimits(), state());
    assert.equal(!v.ok && v.rule, "ticker-allowlist");
  });

  it("matches tickers case-insensitively — 'aapl' is AAPL, not a bypass", () => {
    assert.equal(checkPolicy(eq({ ticker: "aapl" }), eqLimits(), state()).ok, true);
  });

  it("skips the ticker allowlist only when undefined (fixtures), like sellableAssets", () => {
    assert.equal(checkPolicy(eq({ ticker: "ANYTHING" }), limits(), state()).ok, true);
  });

  it("rejects a non-positive notional", () => {
    const v = checkPolicy(eq({ notionalUsdg: 0n }), eqLimits(), state());
    assert.equal(!v.ok && v.rule, "order-amount");
  });

  it("caps a single order at the per-trade limit", () => {
    const v = checkPolicy(eq({ notionalUsdg: 50_000_001n }), eqLimits(), state());
    assert.equal(!v.ok && v.rule, "per-trade-cap");
  });

  it("counts SELLS against the caps too — a sell is still an op and still exposure", () => {
    const v = checkPolicy(eq({ side: "sell", notionalUsdg: 50_000_001n }), eqLimits(), state());
    assert.equal(!v.ok && v.rule, "per-trade-cap");
  });

  it("enforces the rolling daily cap", () => {
    const v = checkPolicy(eq(), eqLimits(), state({ spentTodayUsdg: 490_000_000n }));
    assert.equal(!v.ok && v.rule, "daily-cap");
  });

  it("enforces the ops cap and the expiry like every other rail", () => {
    const ops = checkPolicy(eq(), eqLimits(), state({ opsToday: 48 }));
    assert.equal(!ops.ok && ops.rule, "ops-cap");
    const exp = checkPolicy(eq(), eqLimits(), state({ nowSec: NOW + 86_401 }));
    assert.equal(!exp.ok && exp.rule, "expiry");
  });

  it("the drawdown breaker fires on equity orders", () => {
    const v = checkPolicy(
      eq(),
      eqLimits(),
      state({ highWaterMarkUsdg: 1_000_000_000n, equityUsdg: 890_000_000n }),
    );
    assert.equal(!v.ok && v.rule, "drawdown-breaker");
  });

  it("STAGE (b): reviewed terms above the cap are rejected even when the estimate passed", () => {
    // The two-stage shape from DESIGN.md §5: stage (a) judges the proposed
    // notional; review() then returns priced terms (fees, slippage), and the
    // SAME checkPolicy judges those. This pins that a review-inflated notional
    // is caught — the property the live executor's safety rests on.
    const proposed = eq({ notionalUsdg: 49_000_000n });
    assert.equal(checkPolicy(proposed, eqLimits(), state()).ok, true);
    const reviewed = { ...proposed, notionalUsdg: 51_000_000n } as TradeIntent; // fees pushed it over
    const v = checkPolicy(reviewed, eqLimits(), state());
    assert.equal(!v.ok && v.rule, "per-trade-cap");
  });
});

describe("checkPolicy — the withdrawal allowlist mirrors the on-chain pin", () => {
  const xfer = (recipient = "0x9999999999999999999999999999999999999999"): TradeIntent => ({
    kind: "transfer",
    target: USDG,
    recipient: recipient as `0x${string}`,
    amountUsdg: 10_000_000n,
  });
  // Hex letters on purpose: a checksummed (EIP-55) address differs from its
  // lowercase form only in the BODY — the "0x" prefix stays lowercase, which is
  // why comparing whole strings case-blind is the right test, not toUpperCase().
  const A = "0xabcdef1111111111111111111111111111111111";

  it("an EMPTY list means the wall has no transfer permission at all", () => {
    const v = checkPolicy(xfer(), limits({ withdrawalAddresses: [] }), state());
    assert.equal(!v.ok && v.rule, "transfer-not-permitted");
    // The message has to say what to do — an owner with stuck funds needs the
    // owner-key path, not a policy code.
    assert.match(!v.ok ? v.detail : "", /recover/);
  });

  it("rejects a recipient that is not on the list", () => {
    const v = checkPolicy(xfer(), limits({ withdrawalAddresses: [A] }), state());
    assert.equal(!v.ok && v.rule, "transfer-recipient-allowlist");
  });

  it("allows a registered recipient, case-insensitively", () => {
    assert.equal(checkPolicy(xfer(A), limits({ withdrawalAddresses: [A] }), state()).ok, true);
    const checksummed = `0x${A.slice(2).toUpperCase()}`;
    assert.equal(
      checkPolicy(xfer(checksummed), limits({ withdrawalAddresses: [A] }), state()).ok,
      true,
      "an address is an address whatever its casing",
    );
  });

  it("UNDEFINED means a pre-allowlist grant, and must NOT be treated as empty", () => {
    // Such a grant genuinely carries the old free-form permission. A mirror
    // stricter than the chain rejects trades the wall would have allowed —
    // the one thing this file's contract forbids.
    assert.equal(checkPolicy(xfer(), limits(), state()).ok, true);
  });

  it("the amount cap still applies on top of the destination pin", () => {
    const v = checkPolicy(
      { ...xfer(A), amountUsdg: 50_000_001n } as TradeIntent,
      limits({ withdrawalAddresses: [A] }),
      state(),
    );
    assert.equal(!v.ok && v.rule, "per-trade-cap");
  });
});


/**
 * STAGE 4 — THE MIRROR WAS LOOSER THAN THE CHAIN FOR CURVE TRADES.
 *
 * Every asset rule used to sit inside `if (intent.kind === "swap")`, so a curve
 * trade reached the bundler having passed no asset check at all. The chain would
 * still refuse it — the wall pins both legs ONE_OF the sealed list — but
 * limits.ts records that the mirror going LOOSER than the chain is the one
 * direction that is never safe, and the cost of finding out on chain is a wasted
 * UserOp and a `gas-unreadable` refusal that names nothing.
 */
describe("curve trades are judged off-chain, not discovered on-chain", () => {
  const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
  const MEME = "0x1111111111111111111111111111111111111111";
  const CURVE = "0x2222222222222222222222222222222222222222";
  const ADAPTER = "0x3333333333333333333333333333333333333333";
  const STOCK = "0x4444444444444444444444444444444444444444";

  const curveIntent = (over: Record<string, unknown> = {}) =>
    ({
      kind: "curve-trade",
      target: ADAPTER,
      curve: CURVE,
      assetIn: USDG,
      assetOut: MEME,
      amountInRaw: 10_000_000n,
      minAmountOutRaw: 1n,
      notionalUsdg: 10_000_000n,
      ...over,
    }) as never;

  const limits = (over: Record<string, unknown> = {}) =>
    ({
      allowedTargets: [ADAPTER],
      allowedAssets: [USDG, MEME],
      sellableAssets: [USDG, MEME, STOCK],
      quoteAssets: [USDG, STOCK],
      knownCurves: [CURVE],
      cashToken: USDG,
      maxTradeUsdg: 1_000_000_000n,
      maxDailyUsdg: 1_000_000_000n,
      maxOpsPerDay: 100,
      ...over,
    }) as never;

  const state = () =>
    ({ spentTodayUsdg: 0n, opsToday: 0, equityUsdg: 1_000_000_000n, highWaterMarkUsdg: 0n }) as never;

  it("refuses an asset the GRANT does not cover", () => {
    const v = checkPolicy(
      curveIntent({ assetOut: "0x9999999999999999999999999999999999999999" }),
      limits(),
      state(),
    );
    assert.equal(v.ok, false);
    assert.equal((v as { rule: string }).rule, "asset-allowlist");
  });

  it("checks the GRANT list, not the settings list — the whole point of the fix", () => {
    // allowedAssets is [USDG, ...watchTokens] and watchTokens hot-reload from
    // SETTINGS with no signature. sellableAssets comes from the grant. An owner
    // who adds a token in /settings and does not re-sign must still be refused
    // here, or the fix reproduces the bug it is closing.
    const v = checkPolicy(
      curveIntent(),
      limits({ allowedAssets: [USDG, MEME], sellableAssets: [USDG] }),
      state(),
    );
    assert.equal(v.ok, false, "settings-derived reach must not authorise a curve buy");
    assert.equal((v as { rule: string }).rule, "asset-allowlist");
  });

  it("refuses a curve nothing vouches for", () => {
    // The curve is the one argument the wall CANNOT pin, so off-chain is the
    // only place it can be constrained at all.
    const v = checkPolicy(curveIntent({ curve: "0x8888888888888888888888888888888888888888" }), limits(), state());
    assert.equal(v.ok, false);
    assert.equal((v as { rule: string }).rule, "curve-provenance");
  });

  it("refuses a non-positive size instead of signing it", () => {
    for (const over of [{ amountInRaw: 0n }, { notionalUsdg: 0n }, { amountInRaw: -1n }]) {
      const v = checkPolicy(curveIntent(over), limits(), state());
      assert.equal(v.ok, false, Object.keys(over).join(",") + "=" + Object.values(over).map(String).join(","));
      assert.equal((v as { rule: string }).rule, "non-positive");
    }
  });

  it("allows a legal curve buy", () => {
    assert.equal(checkPolicy(curveIntent(), limits(), state()).ok, true);
  });
});

/**
 * THE BREAKER'S EXIT EXEMPTION — and the trap in widening it.
 *
 * The wall pins BOTH legs ONE_OF the same sealed list, so "assetOut is sellable"
 * is true of every curve trade ever built, buys included. Testing that would mark
 * the whole venue exempt and switch the breaker off exactly where risk is
 * highest. The real discriminator is that sellableAssets = builtinGrantTargets u
 * grantTokens: a launched memecoin arrives as an owner-added EXTRA, while USDG
 * and the stock tokens are BUILT IN.
 */
describe("drawdown breaker and curve exits", () => {
  const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
  const MEME = "0x1111111111111111111111111111111111111111";
  const CURVE = "0x2222222222222222222222222222222222222222";
  const ADAPTER = "0x3333333333333333333333333333333333333333";
  const STOCK = "0x4444444444444444444444444444444444444444";

  const lim = {
    allowedTargets: [ADAPTER],
    allowedAssets: [USDG, MEME, STOCK],
    sellableAssets: [USDG, MEME, STOCK],
    quoteAssets: [USDG, STOCK],
    knownCurves: [CURVE],
    cashToken: USDG,
    maxTradeUsdg: 1_000_000_000n,
    maxDailyUsdg: 1_000_000_000n,
    maxOpsPerDay: 100,
    maxDrawdownBps: 500,
  } as never;

  // Deep in a drawdown: equity is half the high-water mark.
  const drawdown = {
    spentTodayUsdg: 0n,
    opsToday: 0,
    equityUsdg: 500_000_000n,
    highWaterMarkUsdg: 1_000_000_000n,
    equityKnown: true,
  } as never;

  const trade = (assetIn: string, assetOut: string) =>
    ({
      kind: "curve-trade",
      target: ADAPTER,
      curve: CURVE,
      assetIn,
      assetOut,
      amountInRaw: 10_000_000n,
      minAmountOutRaw: 1n,
      notionalUsdg: 10_000_000n,
    }) as never;

  it("lets a stock-quoted curve position OUT during a drawdown", () => {
    // 42.8% of curves are quoted in a stock token. The cashToken-only test
    // blocked the exit for nearly half the venue at the moment it matters most.
    assert.equal(checkPolicy(trade(MEME, STOCK), lim, drawdown).ok, true);
  });

  it("still lets a USDG-quoted position out", () => {
    assert.equal(checkPolicy(trade(MEME, USDG), lim, drawdown).ok, true);
  });

  it("does NOT treat a curve BUY as an exit", () => {
    // The failure mode of a careless widening: every leg is sellable, so a naive
    // test exempts entries too and the breaker stops existing for this venue.
    const v = checkPolicy(trade(USDG, MEME), lim, drawdown);
    assert.equal(v.ok, false, "buying deeper into a drawdown must still be blocked");
    assert.equal((v as { rule: string }).rule, "drawdown-breaker");
  });
});
