/**
 * THE STRATEGIST IS TOLD WHAT ITS KEY WILL NOT BUY, AND IS HELD TO IT.
 *
 * A model offered a coin the signed key cannot sell back would propose it,
 * the window would journal it — a public decision row — and the wall would
 * refuse it `no-exit`. Every window, for the life of the grant, at the price
 * of a model call. Now:
 *
 *   - `cannotBuy` names those symbols in the signals, routed the way
 *     proposalsToIntents routes them (a curve leg asks the curve gate);
 *   - a buy of one is withheld before it is journaled, with a note to the
 *     owner, and counted as the key's refusal if nothing else went out;
 *   - a SELL of one is untouched — the gate is never asked about an exit;
 *   - an absent hint changes nothing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { entryGatesOf } from "../entry-gates";
import type { Snapshot, Strategy, Tick } from "../strategies/types";
import type { ProposalDriver, Signals } from "./driver";
import type { CurveLeg } from "./proposals";
import { makeLlmStrategist, type StrategistDecision } from "./strategy";

const TSLA = "0x0000000000000000000000000000000000000001" as const;
const MEME = "0x0000000000000000000000000000000000000002" as const;
const PEPE = "0x0000000000000000000000000000000000000003" as const;
const USDG = "0x00000000000000000000000000000000000000dd" as const;
const ROUTER = "0x00000000000000000000000000000000000000ff" as const;

/** Every leg watched; MEME is the coin the signature does not cover. */
const GATES = entryGatesOf({ allowedAssets: [USDG, TSLA, MEME, PEPE], sellableAssets: [USDG, TSLA, PEPE] });

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  cashUsdg: 100_000_000n,
  vaultUsdg: 0n,
  holdings: new Map(),
  prices: new Map(),
  pausedTokens: new Set(),
  staleFeeds: new Set(),
  sequencerUp: true,
  spendHeadroomUsdg: 1_000_000_000n,
  perTradeCapUsdg: 10_000_000n,
  entryGates: GATES,
  ...over,
});

function build(actions: unknown[], over: { curve?: boolean } = {}) {
  let seen: Signals | null = null;
  const decisions: StrategistDecision[] = [];
  const notes: string[] = [];
  const levels: string[] = [];
  const driver: ProposalDriver = {
    name: "spy",
    propose: async (signals) => {
      seen = signals;
      return { actions };
    },
  };
  const s = makeLlmStrategist({
    driver,
    universe: {
      legs: new Map([["TSLA", TSLA], ["MEME", MEME]]),
      swapRouter: ROUTER,
      usdg: USDG,
      maxPerActionUsdg: 10_000_000n,
      maxActionsPerTick: 4,
    },
    ...(over.curve
      ? {
          curveLegsNow: () => ({
            legs: new Map([["PEPE", curveLeg()]]),
            tokens: new Map([["PEPE", PEPE as `0x${string}`]]),
            slippageBps: 100,
            maxImpactBps: 10_000,
          }),
        }
      : {}),
    decisionIntervalMs: 0,
    onDecision: (d) => void decisions.push(d),
    onNote: (level, m) => {
      notes.push(m);
      levels.push(level);
    },
  });
  return { s, decisions, notes, levels, signals: () => seen as Signals | null };
}

const tickOf = async (s: Strategy, sn: Snapshot): Promise<Tick> => {
  const r = await s.tick(sn);
  return Array.isArray(r) ? { intents: r, why: r.map(() => null) } : r;
};

describe("the model is told", () => {
  it("CANNOTBUY NAMES THE GATED SYMBOL, and it stays tradable for a sell", async () => {
    const b = build([]);
    await tickOf(b.s, snap());
    assert.deepEqual(b.signals()?.cannotBuy, ["MEME"]);
    assert.ok(b.signals()?.tradableSymbols.includes("MEME"));
  });

  it("a curve leg asks the CURVE gate — the venue proposalsToIntents would route it to", async () => {
    const narrow = entryGatesOf({ allowedAssets: [USDG, TSLA, MEME, PEPE], sellableAssets: [USDG, TSLA, MEME] });
    const b = build([], { curve: true });
    await tickOf(b.s, snap({ entryGates: narrow }));
    assert.deepEqual(b.signals()?.cannotBuy, ["PEPE"]);
  });

  it("and NOT the swap gate: a curve leg in the grant but not watched is buyable, as the wall says", async () => {
    // The case above gates PEPE on both venues, so it cannot tell which one
    // was asked. Here only the swap gate would refuse PEPE (`asset-allowlist`,
    // not watched); the curve branch never reads the watch list, and the
    // wall accepts the curve buy. Asking the swap gate would withhold a buy
    // the wall lets through — this mirror going stricter than the chain.
    const signedNotWatched = entryGatesOf({ allowedAssets: [USDG, TSLA, MEME], sellableAssets: [USDG, TSLA, MEME, PEPE] });
    const b = build([], { curve: true });
    await tickOf(b.s, snap({ entryGates: signedNotWatched }));
    assert.equal(b.signals()?.cannotBuy, undefined);
  });

  it("omitted when nothing is gated, and when the hint was never read", async () => {
    const clear = build([]);
    await tickOf(clear.s, snap({ entryGates: entryGatesOf({ allowedAssets: [USDG, TSLA, MEME], sellableAssets: [USDG, TSLA, MEME] }) }));
    assert.equal(clear.signals()?.cannotBuy, undefined);
    const unread = build([]);
    await tickOf(unread.s, snap({ entryGates: undefined }));
    assert.equal(unread.signals()?.cannotBuy, undefined);
  });
});

describe("and held to it", () => {
  const BUY_MEME = { action: "buy", symbol: "MEME", sizeUsdg: 5, reason: "it is moving" };
  const BUY_TSLA = { action: "buy", symbol: "TSLA", sizeUsdg: 5, reason: "breadth is back" };

  it("A GATED BUY IS WITHHELD BEFORE IT IS JOURNALED — no intent, no public row, one owner note", async () => {
    const b = build([BUY_MEME, BUY_TSLA]);
    const t = await tickOf(b.s, snap());
    assert.deepEqual(
      t.intents.map((i) => (i.kind === "swap" ? i.buyToken : null)),
      [TSLA],
      "the ungated buy still goes",
    );
    assert.ok(!b.decisions.some((d) => d.symbol === "MEME"), "never journaled — a published buy that could not happen");
    assert.ok(!b.decisions.some((d) => d.dropped_rule?.includes("MEME")), "and not as a published drop either");
    assert.ok(b.notes.some((n) => /1 buy proposal\(s\) withheld — the signed key can't sell MEME back/.test(n)));
  });

  it("THE OWNER IS WARNED ONCE PER CHANGE — at warn, where a refusal used to be, and not every window", async () => {
    const b = build([BUY_MEME]);
    const lockedLevels = () => b.levels.filter((_, i) => /can't sell MEME back/.test(b.notes[i] ?? ""));
    for (let window = 0; window < 3; window++) await tickOf(b.s, snap());
    // The first window replaces the `no-exit` refusal the owner used to see at
    // warn; the repeats still log, at ok, which no owner surface renders.
    assert.deepEqual(lockedLevels(), ["warn", "ok", "ok"]);
    // A re-sign covers MEME, then a later one drops it again: a new fact.
    await tickOf(b.s, snap({ entryGates: entryGatesOf({ allowedAssets: [USDG, TSLA, MEME], sellableAssets: [USDG, TSLA, MEME] }) }));
    await tickOf(b.s, snap());
    assert.deepEqual(lockedLevels(), ["warn", "ok", "ok", "warn"]);
  });

  it("A SELL OF THE SAME COIN IS UNTOUCHED — the gate is never asked about an exit", async () => {
    const holdings = new Map([["MEME", { token: MEME, rawBalance: 10n ** 18n, valueUsdg: 8_000_000n, priceStale: false }]]);
    const b = build([{ action: "sell", symbol: "MEME", sizeUsdg: 8, reason: "done with it" }]);
    const t = await tickOf(b.s, snap({ holdings }));
    assert.equal(t.intents.length, 1);
    assert.equal(t.intents[0]?.kind === "swap" && t.intents[0].sellToken, MEME);
  });

  it("A WINDOW OF NOTHING BUT GATED BUYS says the key's limits refused them — never 'I put 0 ideas up'", async () => {
    const b = build([BUY_MEME]);
    const t = await tickOf(b.s, snap());
    assert.equal(t.intents.length, 0);
    assert.deepEqual(t.idle, { code: "model-held", held: 0, considered: 1, dropped: 1 });
  });

  it("an absent hint changes nothing: the buy goes to the wall exactly as it used to", async () => {
    const b = build([BUY_MEME]);
    const t = await tickOf(b.s, snap({ entryGates: undefined }));
    assert.equal(t.intents.length, 1);
  });
});

function curveLeg(): CurveLeg {
  return {
    curve: "0x00000000000000000000000000000000000000c0",
    quoteToken: USDG,
    adapter: "0x00000000000000000000000000000000000000ad",
    reserves: {
      quoteRaw: 400_000_000n,
      tokenRaw: 4_000_000_000_000_000_000_000n,
      quoteDecimals: 6,
      tokenDecimals: 18,
      graduationThresholdRaw: 5_000_000_000n,
    },
  } as CurveLeg;
}
