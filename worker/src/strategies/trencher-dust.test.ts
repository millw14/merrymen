/**
 * NO LEFTOVER DUST FROM A TRENCHER EXIT.
 *
 * The case, from Shogun's vault on chain 4663: a Brain exit asked to sell
 * $4.634 of a $4.636 musebook position, the old arithmetic sold exactly that
 * share — 13,300.78 of 13,306.85 tokens — and the 6.06 left behind were sold
 * twelve minutes later for $0.002: a whole operation, a ping reading "0.00"
 * and a P&L card of "-6.5% · 0.00 · 0.00 · 0.00".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DUST_REMAINDER_USDG, TRENCHER_DEFAULTS, exitSize, makeTrencher, type OpenPosition } from "./trencher";
import { takeTick, type Snapshot } from "./types";

const E18 = 10n ** 18n;

describe("exitSize — a partial never strands a sliver", () => {
  it("THE MUSEBOOK CASE: a sell a hair under the position's value sells all of it", () => {
    const raw = 13_306_845_500_000_000_000_000n; // 13,306.8455 tokens
    const r = exitSize(raw, 4_636_202n, 4_634_068n, false);
    assert.equal(r.amount, raw, "the whole position, not 99.95% of it");
    assert.equal(r.notional, 4_636_202n);
  });

  it("a deliberate trim still leaves what it meant to", () => {
    const r = exitSize(10n * E18, 10_000_000n, 5_000_000n, false);
    assert.equal(r.amount, 5n * E18);
    assert.equal(r.notional, 5_000_000n);
  });

  it("a remainder under 1% of the position is not left, however large in dollars", () => {
    // $1,000 position, sell $995: the $5 left is 0.5% — a rounding of intent, not a choice.
    const r = exitSize(1_000n * E18, 1_000_000_000n, 995_000_000n, false);
    assert.equal(r.amount, 1_000n * E18);
  });

  it("a remainder under $0.10 is not left, even when it is over 1%", () => {
    // $1.00 position, sell $0.95: the $0.05 left is 5%, but worth less than the fee to sell it.
    const r = exitSize(E18, 1_000_000n, 950_000n, false);
    assert.equal(r.amount, E18);
    assert.ok(1_000_000n - 950_000n < DUST_REMAINDER_USDG);
  });

  it("a rule exit sells everything, exactly as before", () => {
    assert.deepEqual(exitSize(7n * E18, 5_000_000n, 5_000_000n, true), { amount: 7n * E18, notional: 5_000_000n });
  });

  it("nothing to value, nothing sold", () => {
    assert.equal(exitSize(E18, 0n, 1n, false).amount, 0n);
  });
});

describe("the Trencher tick sells the whole position on a Brain exit that would leave dust", () => {
  const HELD = "0x91a2dae9699f0b82540b5886b0d8759c22820ba3" as const;
  const VAULT = "0x2ca2b5bd3b6635d630419c57a13c6b6a856ec96d" as const;
  const RAW = 13_306_845_500_000_000_000_000n;
  const nowSec = Math.floor(Date.now() / 1000);
  const price8 = 34_841n; // flat since entry, so no rule exit fires — only the Brain's

  const position: OpenPosition = {
    symbol: "MUSE",
    token: HELD,
    custodyVault: VAULT,
    entryPrice8: price8,
    entryLiquidityUsd: 50_000,
    entrySec: nowSec - 60,
    costUsdg: 5_000_000n,
    qtyRaw: RAW,
  };

  const snap = {
    cashUsdg: 10_000_000n,
    vaultUsdg: 0n,
    holdings: new Map([["MUSE", { symbol: "MUSE", token: HELD, rawBalance: RAW, valueUsdg: 4_636_202n, decimals: 18 }]]),
    prices: new Map([["MUSE", { price8, stale: false, source: "pool" as const }]]),
    pausedTokens: new Set<string>(),
    staleFeeds: new Set<string>(),
    sequencerUp: true,
    spendHeadroomUsdg: 100_000_000n,
    perTradeCapUsdg: 10_000_000n,
  } as unknown as Snapshot;

  const tick = async (usdgAmount: number) => {
    const strategy = makeTrencher({
      cfg: TRENCHER_DEFAULTS,
      swapRouter: "0x00000000000000000000000000000000000000f0",
      usdgToken: "0x00000000000000000000000000000000000000aa",
      candidates: async () => [],
      open: async () => [position],
      liquidityOf: () => 50_000,
      unpriceable: () => new Set<string>(),
      brainOrder: () => ({ side: "sell", usdgAmount, decisionId: "d-exit" }),
    });
    return takeTick(await strategy.tick(snap)).intents;
  };

  it("sells all 13,306.85 musebook, not 13,300.78", async () => {
    const [intent] = await tick(4.634068);
    assert.ok(intent?.kind === "swap");
    assert.equal(intent.sellAmountRaw, RAW);
    assert.equal(intent.target, VAULT);
  });

  it("a Brain order for half still sells half", async () => {
    const [intent] = await tick(2.318101);
    assert.ok(intent?.kind === "swap");
    assert.ok(intent.sellAmountRaw < RAW / 2n + E18 && intent.sellAmountRaw > RAW / 2n - E18, "about half");
  });
});
