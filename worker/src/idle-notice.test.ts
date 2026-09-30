/**
 * THE OWNER IS TOLD WHY THE AGENT STOPPED BUYING — AT A LEVEL THEY SEE.
 *
 * Before the snapshot carried the drawdown, a tripped breaker announced itself:
 * the strategy proposed, the wall refused, and the refusal wrote a WARN event
 * ("policy rejected swap: drawdown-breaker"), which is what the desk notice,
 * the rail and the Android app render. Now the strategy proposes nothing and
 * says `breaker-tripped` on the idle channel instead — which wrote its event at
 * "ok", a level none of those surfaces shows, and suppressed the idle view (the
 * breaker is account state and stays off the public feed). So the one idle
 * reason with no public post also had no owner surface at all: the desk kept
 * showing whatever warn came before, for a Trencher the now-false "no pool
 * passes the entry checks".
 *
 * The rule this pins: AN IDLE REASON THAT DOES NOT BECOME A POST IS TOLD TO THE
 * OWNER AS A WARNING. Still once per change — the channel's de-duplication is
 * what keeps a tripped breaker from being 360 warnings a day.
 *
 * The strategies are run for real, so the idle reason is the one a tripped
 * book actually produces, not a hand-built Why.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { idleNotice, MODE_EMPTIED_REMEDY } from "./idle-notice";
import { makeLlmStrategist } from "./strategist/strategy";
import { publishesIdle, renderWhy, type Why } from "./strategies/reasons";
import { steadyBasketTick, type SteadyBasketConfig } from "./strategies/steady-basket";
import { makeTrencher, TRENCHER_DEFAULTS } from "./strategies/trencher";
import { drawdownOf, takeTick, type Snapshot } from "./strategies/types";

const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const VAULT = "0x2222222222222222222222222222222222222222" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const QQQ = "0x4444444444444444444444444444444444444444" as const;
const NVDA = "0x5555555555555555555555555555555555555555" as const;

const TRIPPED = drawdownOf({ peakUsdg: 1_000_000_000n, equityUsdg: 875_000_000n, equityKnown: true, maxDrawdownBps: 1_000 });

const basket: SteadyBasketConfig = {
  legs: [
    { symbol: "QQQ", token: QQQ, weightBps: 5000 },
    { symbol: "NVDA", token: NVDA, weightBps: 5000 },
  ],
  buyPerTickUsdg: 25_000_000n,
  idleFloorUsdg: 50_000_000n,
  swapRouter: ROUTER,
  vault: VAULT,
  usdg: USDG,
};

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  cashUsdg: 900_000_000n,
  vaultUsdg: 0n,
  holdings: new Map(),
  prices: new Map(),
  pausedTokens: new Set(),
  staleFeeds: new Set(),
  sequencerUp: true,
  spendHeadroomUsdg: 1_000_000_000_000n,
  perTradeCapUsdg: 1_000_000_000_000n,
  ...over,
});

/** The levels the desk notice, the rail and the Android app render. "ok" is not one. */
const OWNER_SEES = new Set(["warn", "err"]);

const tripped: Why = { code: "breaker-tripped", limitBps: 1_000 };
const stale: Why = { code: "all-legs-stale", legs: 2, paused: 0 };

describe("a tripped breaker reaches the owner", () => {
  it("THE BASKET'S OWN IDLE REASON ON A TRIPPED BOOK IS A WARNING, and no post", () => {
    const tick = takeTick(steadyBasketTick(basket, snap({ drawdown: TRIPPED })));
    assert.equal(tick.intents.length, 0);
    assert.equal(tick.idle?.code, "breaker-tripped");
    const n = idleNotice({ idle: tick.idle, modeEmptied: null, last: null });
    assert.ok(n.event && OWNER_SEES.has(n.event.level), `told at ${n.event?.level}, which no owner surface shows`);
    assert.equal(n.event!.message, renderWhy(tick.idle!), "the owner's register, remedy and all");
    assert.equal(n.view, null, "account state stays off the public feed");
  });

  it("A FAST TRENCHER'S TOO — its entry checks are skipped, so this is the only thing that can say why", async () => {
    let asked = 0;
    const trencher = makeTrencher({
      cfg: TRENCHER_DEFAULTS,
      brainRequired: true,
      candidates: async () => {
        asked++;
        return [];
      },
      open: async () => [],
      liquidityOf: () => null,
      swapRouter: ROUTER,
      usdgToken: USDG,
    });
    const tick = takeTick(await trencher.tick(snap({ drawdown: TRIPPED })));
    assert.equal(asked, 0, "no candidate was looked at");
    assert.equal(tick.idle?.code, "breaker-tripped");
    const n = idleNotice({ idle: tick.idle, modeEmptied: null, last: null });
    assert.equal(n.event?.level, "warn");
  });

  it("AND THE STRATEGIST'S, which no longer asks its model while flat and tripped", async () => {
    const strategist = makeLlmStrategist({
      driver: { name: "never", propose: async () => ({ actions: [] }) } as never,
      universe: { legs: new Map([["NVDA", NVDA]]), swapRouter: ROUTER, usdg: USDG, maxPerActionUsdg: 10_000_000n, maxActionsPerTick: 4 },
      decisionIntervalMs: 60_000,
    });
    const tick = takeTick(await strategist.tick(snap({ drawdown: TRIPPED })));
    assert.equal(idleNotice({ idle: tick.idle, modeEmptied: null, last: null }).event?.level, "warn");
  });

  it("ONCE PER CHANGE: a breaker that stays tripped is one warning, not one a tick", () => {
    const first = idleNotice({ idle: tripped, modeEmptied: null, last: null });
    const again = idleNotice({ idle: tripped, modeEmptied: null, last: first.last });
    assert.ok(first.event);
    assert.equal(again.event, null);
    assert.equal(again.view, null);
    assert.equal(again.last, first.last);
  });

  it("a tick that traded in between resets it, so a breaker that trips again is said again", () => {
    const first = idleNotice({ idle: tripped, modeEmptied: null, last: null });
    const traded = idleNotice({ idle: null, modeEmptied: null, last: first.last });
    assert.equal(traded.event, null, "a tick with intents says nothing here");
    assert.equal(traded.last, null);
    assert.equal(idleNotice({ idle: tripped, modeEmptied: null, last: traded.last }).event?.level, "warn");
  });
});

describe("every other idle reason is unchanged", () => {
  it("A REASON THAT POSTS stays at ok, and its post is the public register", () => {
    assert.equal(publishesIdle(stale), true);
    const n = idleNotice({ idle: stale, modeEmptied: null, last: null });
    assert.deepEqual(n.event, { level: "ok", message: renderWhy(stale) });
    assert.equal(n.view, renderWhy(stale, "public"));
  });

  it("AN EMPTIED MODE: the remedy to the owner, the plain fact to the feed", () => {
    const fact = "nothing in your basket is a coin, and your asset mode is Crypto only — so there is nothing to trade";
    const n = idleNotice({ idle: null, modeEmptied: fact, last: null });
    assert.deepEqual(n.event, { level: "ok", message: `${fact}. ${MODE_EMPTIED_REMEDY}` });
    assert.equal(n.view, fact, "no instruction to a stranger about somebody else's settings");
  });

  it("a strategy's own reason wins over the mode's", () => {
    const n = idleNotice({ idle: stale, modeEmptied: "nothing in your basket is a stock", last: null });
    assert.equal(n.event?.message, renderWhy(stale));
  });

  it("nothing to say is nothing written", () => {
    assert.deepEqual(idleNotice({ idle: null, modeEmptied: null, last: null }), { last: null, event: null, view: null });
    assert.deepEqual(idleNotice({ idle: undefined, modeEmptied: null, last: null }), { last: null, event: null, view: null });
  });
});
