import {
  CASH,
  STOCK_TOKENS,
  UNISWAP,
  ENERGY_ROUTE_V1,
  baseForNotional,
  effectiveMinNotionalMicro,
  grantEnergyRoute,
  grantHasTransfer,
  grantPonsClassVault,
  leverageTarget,
  notionalMicro,
  sellableAssets,
  stopPrices,
  usdgUnits,
  worstPriceForTaker,
  type PerpMarketSpec,
  type StoredGrant,
} from "../../packages/core/src/index";
import { limitsFromGrant } from "./limits";
import {
  checkPolicy,
  type AgentLimits,
  type AgentState,
  type PerpOpenIntent,
  type PerpPolicyState,
  type TradeIntent,
} from "./policy";

export interface WallCase {
  /** What the "attacker" tried, in plain words. */
  attempt: string;
  /** What the policy is expected to do. */
  want: "rejected" | "approved";
  /** The exact rejecting rule expected for a rejected case. */
  expectedRule?: string;
  /** What the policy actually said. */
  ok: boolean;
  rule?: string;
  detail?: string;
  /** Did the wall produce the exact expected verdict? */
  held: boolean;
}

export interface WallBatteryResult {
  cases: WallCase[];
  allHeld: boolean;
}

const EVIL = "0x000000000000000000000000000000000000dEaD" as const;
const RANDOM_VENUE = "0x1111111111111111111111111111111111111111" as const;
const UNKNOWN_TOKEN = "0x2222222222222222222222222222222222222222" as const;
/** A bonding curve the launch feed never saw — stands in for "vouched for by nobody". */
const RANDOM_CURVE = "0x3333333333333333333333333333333333333333" as const;
/** A token minted after this grant was signed. It is un-enumerable BY DEFINITION. */
const CLASS_TOKEN = "0x4444444444444444444444444444444444444444" as const;
/** A second one — the case where nothing in the trade is anchored to the grant. */
const OTHER_CLASS_TOKEN = "0x5555555555555555555555555555555555555555" as const;
/** A vault address for a grant that never sealed one. Not a target this key has. */
const UNSEALED_VAULT = "0x6666666666666666666666666666666666666666" as const;

interface BatteryInput {
  attempt: string;
  want: "rejected" | "approved";
  expectedRule?: string;
  intent: TradeIntent;
  state: AgentState;
  limits?: AgentLimits;
}

/**
 * THE PERP CASES — asked only of a signature that sealed the perps route.
 *
 * FOR PERPETUALS THIS BATTERY IS THE ORDER WALL ITSELF, not a demonstration
 * of a mirror: the chain bounds only what reaches Lighter per deposit, and
 * order size, leverage, market and rate are enforced by checkPolicy alone
 * (docs/perps.md rule 4). So each case below is pinned to its exact rule, and
 * the approved ones prove the other half of the contract — that no brake here
 * ever holds a close or a withdrawal shut (rule 8).
 *
 * THE BOOK IS A FIXTURE, BUILT HERE, and says so. The battery has no venue to
 * read, so it asks its questions of one flat ETH-PERP market with the
 * contract's default settings (2x, 5% stop, 2% liquidation buffer, 50 bp
 * slippage), clamped to this grant's per-trade cap — and with a market minimum
 * small enough that the honest open is reachable on any signed cap. The
 * venue's real minimums are the dashboard's to show (per-market
 * reachability), not a rule this battery could prove or disprove.
 *
 * THE CLOCK IS PINNED a week before the grant expires, for the reason every
 * case pins one rule: an open within a day of expiry is refused
 * `perp-grant-expiring` first, and a battery run on a grant's last day would
 * otherwise print "BREACH" for nine cases that only met an earlier, correct
 * refusal. Expiry gets its own approved case: a close after it still goes.
 */
function perpCases(
  grant: StoredGrant,
  limits: AgentLimits,
  calm: AgentState,
  tripped: AgentState,
): BatteryInput[] {
  if (!limits.perp) return [];
  const spec: PerpMarketSpec = {
    marketId: 0,
    sizeDecimals: 4,
    priceDecimals: 2,
    minBaseAmount: 1n,
    minQuoteMicro: 100_000n,
    minImfBp: 200,
    defaultImfBp: 5_000,
    mmfBp: 120,
    closeoutBp: 80,
    status: "active",
  };
  const mark = 250_000n; // 2,500.00 USDG
  const perTradeMicro = (() => {
    const sealed = usdgUnits(grant.caps.perTradeUsdg);
    const setting = usdgUnits(25);
    return sealed < setting ? sealed : setting;
  })();
  const settings: PerpPolicyState["settings"] = {
    markets: ["BTC-PERP", "ETH-PERP"],
    maxLeverage: 2,
    perTradeMicro,
    maxOpenNotionalMicro: perTradeMicro * 2n,
    maxCollateralMicro: perTradeMicro,
    maxOpensPerDay: 4,
    stopLossBps: 500,
    stopSlipBps: 200,
    liqBufferBps: 200,
    maxSlippageBps: 50,
  };
  const perpNow = Math.min(calm.nowSec, grant.expiresAt - 7 * 86_400);
  const marketFor = (maxLeverage: number): PerpPolicyState["markets"] => {
    const imf = leverageTarget(maxLeverage, spec).imfBp;
    return new Map([
      [
        0,
        {
          status: "active" as const,
          effMinNotionalMicro: effectiveMinNotionalMicro(spec, mark),
          imfBpTarget: imf,
          venueImfBp: imf,
          venueMarginMode: "isolated" as const,
          mmfBp: spec.mmfBp,
          spec,
        },
      ],
    ]);
  };
  const flat: PerpPolicyState = {
    mode: "live",
    refuseRule: null,
    settings,
    openNotionalMicro: 0n,
    committedCollateralMicro: 0n,
    opensToday: 0,
    positions: new Map(),
    markets: marketFor(2),
    unresolvedMarkets: new Set(),
    closeInFlightMarkets: new Set(),
    incident: false,
    entriesHalted: false,
    grantExpiresAtSec: grant.expiresAt,
    nowSec: perpNow,
  };
  const worstBuy = worstPriceForTaker({ isAsk: false, mark, maxSlippageBps: settings.maxSlippageBps });
  /** A long sized to `target` micro-USDG, built exactly as the route builds one. */
  const openLong = (
    target: bigint,
    o: { maxLeverage?: number; stopLossBps?: number; market?: "ETH-PERP" | "SOL-PERP" } = {},
  ): PerpOpenIntent => {
    const base = baseForNotional(target, worstBuy, spec, "floor");
    const stop = stopPrices({ side: "long", entryRefPrice: mark, stopLossBps: o.stopLossBps ?? settings.stopLossBps, stopSlipBps: settings.stopSlipBps });
    return {
      kind: "perp-order",
      venue: "lighter",
      market: o.market ?? "ETH-PERP",
      marketId: o.market === "SOL-PERP" ? 3 : 0,
      effect: "open",
      side: "long",
      reduceOnly: false,
      baseAmount: base > 0n ? base : 1n,
      worstPrice: worstBuy,
      markPrice: mark,
      notionalUsdg: notionalMicro(base > 0n ? base : 1n, worstBuy, spec, "ceil"),
      imfBp: leverageTarget(o.maxLeverage ?? settings.maxLeverage, spec).imfBp,
      stopTrigger: stop.trigger,
      stopPrice: stop.price,
    };
  };
  const honest = perTradeMicro / 2n;
  const honestOpen = openLong(honest);
  const heldBase = honestOpen.baseAmount;
  const holding: PerpPolicyState = {
    ...flat,
    positions: new Map([[0, { side: "long" as const, baseAmount: heldBase }]]),
    openNotionalMicro: notionalMicro(heldBase, mark, spec, "ceil"),
  };
  const close: TradeIntent = {
    kind: "perp-order",
    venue: "lighter",
    market: "ETH-PERP",
    marketId: 0,
    effect: "close",
    side: "long",
    reduceOnly: true,
    baseAmount: heldBase,
    worstPrice: worstPriceForTaker({ isAsk: true, mark, maxSlippageBps: 150 }),
    markPrice: mark,
    notionalUsdg: notionalMicro(heldBase, mark, spec, "ceil"),
  };
  const at = (s: AgentState, perp: PerpPolicyState): AgentState => ({ ...s, nowSec: perpNow, perp });
  const tenX: PerpPolicyState = {
    ...flat,
    settings: { ...settings, maxLeverage: 10, stopLossBps: 2_500 },
    markets: marketFor(10),
  };
  // A grant WITHOUT the marker: the same limits, minus the sealed route.
  const { perp: _sealed, ...unmarked } = limits;
  void _sealed;
  return [
    {
      attempt: "an honest, in-cap perp open with its stop resting at the venue (the wall lets the band work)",
      want: "approved",
      intent: honestOpen,
      state: at(calm, flat),
    },
    {
      attempt: "an open at 20× leverage — leverage is the venue's per-market state you set, never an order field",
      want: "rejected",
      expectedRule: "perp-leverage-mismatch",
      intent: { ...honestOpen, imfBp: 500 },
      state: at(calm, flat),
    },
    {
      attempt: `a perp open twice the ${Number(perTradeMicro) / 1e6} USDG most one open may be (measured on its full size, not its margin)`,
      want: "rejected",
      expectedRule: "perp-per-trade-cap",
      intent: openLong(perTradeMicro * 2n),
      state: at(calm, flat),
    },
    {
      attempt: "a perp open with no stop attached",
      want: "rejected",
      expectedRule: "perp-stop-required",
      intent: { ...honestOpen, stopTrigger: 0n, stopPrice: 0n },
      state: at(calm, flat),
    },
    {
      attempt: "a 10× open whose stop sits past its own liquidation price",
      want: "rejected",
      expectedRule: "perp-stop-inside-liquidation",
      intent: openLong(honest, { maxLeverage: 10, stopLossBps: 1_200 }),
      state: at(calm, tenX),
    },
    {
      attempt: "a perp open on a market you did not allow",
      want: "rejected",
      expectedRule: "perp-market-not-allowed",
      intent: openLong(honest, { market: "SOL-PERP" }),
      state: at(calm, flat),
    },
    {
      attempt: `a perp open while the book is down ${grant.caps.maxDrawdownPct}% from its high-water mark`,
      want: "rejected",
      expectedRule: "drawdown-breaker",
      intent: honestOpen,
      state: at(tripped, flat),
    },
    {
      attempt: "a perp open past your limit on everything open at once",
      want: "rejected",
      expectedRule: "perp-open-notional-cap",
      intent: honestOpen,
      state: at(calm, { ...flat, openNotionalMicro: settings.maxOpenNotionalMicro }),
    },
    {
      attempt: "a perp open while a close on the same market has no final answer yet",
      want: "rejected",
      expectedRule: "perp-close-in-flight",
      intent: honestOpen,
      state: at(calm, { ...flat, closeInFlightMarkets: new Set([0]) }),
    },
    {
      attempt: "a perp open on a signature without the perpetuals permission",
      want: "rejected",
      expectedRule: "perp-not-granted",
      intent: honestOpen,
      state: at(calm, flat),
      limits: unmarked,
    },
    {
      attempt: "a perp open while Lighter shows activity on the account that the agent did not sign",
      want: "rejected",
      expectedRule: "perp-venue-incident",
      intent: honestOpen,
      state: at(calm, { ...flat, incident: true }),
    },
    {
      attempt: "a margin deposit aimed anywhere but the Lighter proxy this key sealed",
      want: "rejected",
      expectedRule: "target-allowlist",
      intent: { kind: "perp-margin", direction: "deposit", target: EVIL, amountUsdg: usdgUnits(1) },
      state: at(calm, flat),
    },
    // ── THE DOORS STAY OPEN (rule 8) ────────────────────────────────────────
    {
      attempt: "closing a perp position while the drawdown breaker is tripped",
      want: "approved",
      intent: close,
      state: at(tripped, holding),
    },
    {
      attempt: `the same close with the ${grant.caps.dailyUsdg} USDG daily budget spent`,
      want: "approved",
      intent: close,
      state: at({ ...calm, spentTodayUsdg: usdgUnits(grant.caps.dailyUsdg) }, holding),
    },
    {
      attempt: `the same close with all ${grant.caps.maxOpsPerDay} of today's actions used`,
      want: "approved",
      intent: close,
      state: at({ ...calm, opsToday: grant.caps.maxOpsPerDay }, holding),
    },
    {
      attempt: "the same close after the session key has expired — a close runs on the Lighter key",
      want: "approved",
      intent: close,
      state: { ...calm, nowSec: grant.expiresAt + 1, perp: { ...holding, nowSec: grant.expiresAt + 1 } },
    },
    {
      attempt: "withdrawing margin home from Lighter while the drawdown breaker is tripped",
      want: "approved",
      intent: { kind: "perp-margin", direction: "withdraw", amountUsdg: usdgUnits(1) },
      state: at(tripped, holding),
    },
  ];
}

/**
 * Drive representative hostile and honest intents through the real policy
 * mirror. Each rejected case pins the exact rule so an earlier guard cannot
 * silently hijack the demo and make a broken proof look green.
 */
export function runWallBattery(
  grant: StoredGrant,
  nowSec = Math.floor(Date.now() / 1000),
): WallBatteryResult {
  const limits = limitsFromGrant(grant);
  const calm: AgentState = {
    spentTodayUsdg: 0n,
    opsToday: 0,
    highWaterMarkUsdg: 0n,
    equityUsdg: 0n,
    nowSec,
  };
  const router = UNISWAP.swapRouter02 as `0x${string}`;
  const usdgAddr = CASH.USDG as `0x${string}`;
  const sellable = sellableAssets(grant);
  const stock = (STOCK_TOKENS.find((token) => sellable.has(token.address.toLowerCase()))?.address
    ?? usdgAddr) as `0x${string}`;

  const nonSellableStock = STOCK_TOKENS.find(
    (token) => !sellable.has(token.address.toLowerCase()),
  );
  const nonSellable = (nonSellableStock?.address ?? UNKNOWN_TOKEN) as `0x${string}`;
  const noExitLimits = nonSellableStock
    ? limits
    : { ...limits, allowedAssets: [...limits.allowedAssets, nonSellable] };

  // THE CLASS ROUTE, exercised only when this signature actually carries it.
  const classVault = grantPonsClassVault(grant);
  const classBuy = (
    vault: `0x${string}`,
    assetIn: `0x${string}`,
    assetOut: `0x${string}`,
  ): TradeIntent => ({
    kind: "curve-trade",
    target: vault,
    curve: RANDOM_CURVE,
    assetIn,
    assetOut,
    amountInRaw: 1n,
    minAmountOutRaw: 0n,
    notionalUsdg: 1n,
  });
  // The launch feed, present. limitsFromGrant leaves knownCurves undefined
  // because this battery has no store to read — which is itself a refusal for a
  // class trade, and gets its own case below rather than being papered over.
  const withFeed: AgentLimits = { ...limits, knownCurves: [RANDOM_CURVE] };

  const classCases: BatteryInput[] = classVault
    ? [
        {
          attempt:
            "sniping a token minted after this grant was signed — the case the class vault exists for",
          want: "approved",
          intent: classBuy(classVault, usdgAddr, CLASS_TOKEN),
          state: calm,
          limits: withFeed,
        },
        {
          attempt:
            "the same snipe, but the launch feed is unreadable — provenance is the only thing vouching for a class token",
          want: "rejected",
          expectedRule: "curve-provenance",
          intent: classBuy(classVault, usdgAddr, CLASS_TOKEN),
          state: calm,
          // knownCurves undefined. Everywhere else that means "this rule cannot
          // run"; here it means refuse, because nothing else in the trade names
          // the output at all.
          limits,
        },
        {
          // THE EXIT, and until now nothing in this battery proved it reachable.
          // All three class cases were BUYS — so a wall that could open a class
          // position and never close one would have printed all-green. That is
          // the exact trap PonsClassVault exists to remove, and a proof that
          // does not check it is a proof of the wrong thing.
          attempt: "selling a class position back out — the exit the vault exists for",
          want: "approved",
          intent: classBuy(classVault, CLASS_TOKEN, usdgAddr),
          state: calm,
          limits: withFeed,
        },
        {
          // The breaker must never block that exit either. A class buy craters
          // equity against an unmoved high-water mark, so a drawdown is exactly
          // the state a class position gets sold in.
          attempt: "the same exit while the drawdown breaker is tripped",
          want: "approved",
          intent: classBuy(classVault, CLASS_TOKEN, usdgAddr),
          state: {
            ...calm,
            highWaterMarkUsdg: usdgUnits(1000),
            equityUsdg: usdgUnits(1000 - (1000 * grant.caps.maxDrawdownPct) / 100),
          },
          limits: withFeed,
        },
        {
          attempt: "rolling one un-enumerated token straight into another (nothing in it is anchored)",
          want: "rejected",
          expectedRule: "asset-allowlist",
          intent: classBuy(classVault, CLASS_TOKEN, OTHER_CLASS_TOKEN),
          state: calm,
          limits: withFeed,
        },
      ]
    : [
        {
          attempt:
            "routing through a class vault this key never sealed (this wall has no class route at all)",
          want: "rejected",
          expectedRule: "target-allowlist",
          intent: classBuy(UNSEALED_VAULT, usdgAddr, CLASS_TOKEN),
          state: calm,
          limits: withFeed,
        },
      ];

  // THE ENERGY BUY, asked the questions THIS signature can answer — the same
  // rule as the class route below. A grant that sealed the route proves the
  // honest buy goes and an oversized one does not; one that did not proves the
  // buy is refused by name. Both prove the router never became a generic swap
  // target: it is deliberately NOT in allowedTargets.
  const energyRoute = grantEnergyRoute(grant);
  const energyBuy = (amount: bigint): TradeIntent => ({
    kind: "energy-buy",
    target: ENERGY_ROUTE_V1.router,
    sellToken: usdgAddr,
    buyToken: ENERGY_ROUTE_V1.path[2],
    sellAmountRaw: amount,
    notionalUsdg: amount,
  });
  const routerSwap: BatteryInput = {
    attempt: "a generic swap aimed at the energy router (it is not a swap venue for this key)",
    want: "rejected",
    expectedRule: "target-allowlist",
    intent: {
      kind: "swap",
      target: ENERGY_ROUTE_V1.router,
      sellToken: usdgAddr,
      buyToken: stock,
      sellAmountRaw: 1n,
      notionalUsdg: 1n,
    },
    state: calm,
  };
  const energyCases: BatteryInput[] = energyRoute
    ? [
        {
          attempt: "an honest energy buy — USDG into $MERRYMEN over the sealed route",
          want: "approved",
          intent: energyBuy(1n),
          state: calm,
        },
        {
          attempt: `an energy buy above your ${grant.caps.perTradeUsdg} USDG per-trade cap`,
          want: "rejected",
          expectedRule: "per-trade-cap",
          intent: energyBuy(usdgUnits(grant.caps.perTradeUsdg) + 1n),
          state: calm,
        },
        routerSwap,
      ]
    : [
        {
          attempt: "an energy buy on a key that never sealed the energy route",
          want: "rejected",
          expectedRule: "energy-not-granted",
          intent: energyBuy(1n),
          state: calm,
        },
        routerSwap,
      ];

  const legalSwap = (notional: bigint): TradeIntent => ({
    kind: "swap",
    target: router,
    sellToken: usdgAddr,
    buyToken: stock,
    sellAmountRaw: notional,
    notionalUsdg: notional,
  });

  const battery: BatteryInput[] = [
    {
      // WHICH rule turns this back depends on the grant, and the battery must
      // say so or it reports a breach when the wall gets STRICTER.
      //
      // A grant signed today registers no withdrawal address, so its call
      // policy carries no USDG transfer permission at all and checkPolicy
      // refuses at `transfer-not-permitted` — which returns BEFORE
      // `per-trade-cap` in the same linear function. Hardcoding the old rule
      // made this case fail, `allHeld` go false, and the dashboard print
      // "⚠ BREACH" about a wall that had just closed the door completely.
      // Both test fixtures carried the "transfer" marker, so the suite stayed
      // green while production reported a breach.
      //
      // Pre-allowlist grants still carry a free-form transfer permission, and
      // for those the cap is genuinely what stops this.
      attempt: grantHasTransfer(grant)
        ? "“send everything to 0xdEaD” — a prompt-injected transfer to a stranger"
        : "“send everything to 0xdEaD” — a prompt-injected transfer to a stranger (this wall cannot transfer at all)",
      want: "rejected",
      expectedRule: grantHasTransfer(grant) ? "per-trade-cap" : "transfer-not-permitted",
      intent: {
        kind: "transfer",
        target: usdgAddr,
        recipient: EVIL,
        amountUsdg: usdgUnits(grant.caps.dailyUsdg * 1000),
      },
      state: calm,
    },
    {
      attempt: `an oversized trade — 10× your ${grant.caps.perTradeUsdg} USDG per-trade cap`,
      want: "rejected",
      expectedRule: "per-trade-cap",
      intent: legalSwap(usdgUnits(grant.caps.perTradeUsdg * 10)),
      state: calm,
    },
    {
      attempt: "a swap routed to an unknown venue (not on the target allowlist)",
      want: "rejected",
      expectedRule: "target-allowlist",
      intent: {
        kind: "swap",
        target: RANDOM_VENUE,
        sellToken: usdgAddr,
        buyToken: stock,
        sellAmountRaw: 1n,
        notionalUsdg: 1n,
      },
      state: calm,
    },
    {
      attempt: "buying a token that isn't on the asset allowlist",
      want: "rejected",
      expectedRule: "asset-allowlist",
      intent: {
        kind: "swap",
        target: router,
        sellToken: usdgAddr,
        buyToken: UNKNOWN_TOKEN,
        sellAmountRaw: 1n,
        notionalUsdg: 1n,
      },
      state: calm,
    },
    {
      attempt: `one more trade after the ${grant.caps.dailyUsdg} USDG daily budget is spent`,
      want: "rejected",
      expectedRule: "daily-cap",
      intent: legalSwap(usdgUnits(Math.min(grant.caps.perTradeUsdg, 1))),
      state: { ...calm, spentTodayUsdg: usdgUnits(grant.caps.dailyUsdg) },
    },
    {
      // The rate limit is enforced on-chain too (toRateLimitPolicy in wall.ts),
      // so this is the mirror of a real ceiling, not a local courtesy. It sits
      // ABOVE the spend caps in checkPolicy, which is why it gets its own case:
      // once it fires it masks every money rule beneath it.
      attempt: `one more trade after all ${grant.caps.maxOpsPerDay} of today's actions are used`,
      want: "rejected",
      expectedRule: "ops-cap",
      intent: legalSwap(1n),
      state: { ...calm, opsToday: grant.caps.maxOpsPerDay },
    },
    {
      attempt: "a perfectly legal trade — but the session key has expired",
      want: "rejected",
      expectedRule: "expiry",
      intent: legalSwap(1n),
      state: { ...calm, nowSec: grant.expiresAt + 1 },
    },
    {
      attempt: `trading on while the book is down ${grant.caps.maxDrawdownPct}% from its high-water mark`,
      want: "rejected",
      expectedRule: "drawdown-breaker",
      intent: legalSwap(1n),
      state: {
        ...calm,
        highWaterMarkUsdg: usdgUnits(1000),
        equityUsdg: usdgUnits(1000 - (1000 * grant.caps.maxDrawdownPct) / 100),
      },
    },
    {
      attempt: "an honest, in-cap trade (the wall lets the band work)",
      want: "approved",
      intent: legalSwap(1n),
      state: calm,
    },
    {
      attempt: "buying a token this signed key cannot later sell",
      want: "rejected",
      expectedRule: "no-exit",
      intent: {
        kind: "swap",
        target: router,
        sellToken: usdgAddr,
        buyToken: nonSellable,
        sellAmountRaw: 1n,
        notionalUsdg: 1n,
      },
      state: calm,
      limits: noExitLimits,
    },
    // ── the energy buy ──────────────────────────────────────────────────────
    ...energyCases,
    // ── the class route ─────────────────────────────────────────────────────
    //
    // WHICH CASES RUN DEPENDS ON THE GRANT, exactly like the transfer case at
    // the top of this battery and for the same reason: a battery that asserts a
    // capability the signature does not carry prints "⚠ BREACH" about a wall
    // that is simply narrower than the fixture assumed. So a grant with no
    // class vault is asked the only honest question available to it — what
    // happens when something aims at a vault it never sealed.
    ...classCases,
    // ── perpetuals ──────────────────────────────────────────────────────────
    //
    // Only when this signature sealed the perps route, on the same rule as the
    // class and energy cases: a battery must not assert a capability the
    // grant does not carry. See perpCases for why these are the order wall.
    ...perpCases(grant, limits, calm, {
      ...calm,
      highWaterMarkUsdg: usdgUnits(1000),
      equityUsdg: usdgUnits(1000 - (1000 * grant.caps.maxDrawdownPct) / 100),
    }),
  ];

  const cases: WallCase[] = battery.map(
    ({ attempt, want, expectedRule, intent, state, limits: caseLimits }) => {
      const verdict = checkPolicy(intent, caseLimits ?? limits, state);
      const held = want === "approved"
        ? verdict.ok
        : !verdict.ok && verdict.rule === expectedRule;
      return {
        attempt,
        want,
        expectedRule,
        ok: verdict.ok,
        rule: verdict.ok ? undefined : verdict.rule,
        detail: verdict.ok ? undefined : verdict.detail,
        held,
      };
    },
  );

  return { cases, allHeld: cases.every((entry) => entry.held) };
}
