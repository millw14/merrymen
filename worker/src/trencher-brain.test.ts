import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { TrenchBrainReview, highVolumePools } from "./trencher-brain";
import { emptyGeckoBuckets, type GeckoPool } from "./venues/geckoterminal";
import type { ShadowInputs, ShadowOutcome } from "./brain-shadow";
import { makeTrencher, TRENCHER_FAST, type Candidate, type OpenPosition } from "./strategies/trencher";
import { takeTick, type Snapshot } from "./strategies/types";
import { applyPaperIntent } from "./paper";
import { applyFill, ZERO_BASIS } from "./basis";
import { checkPolicy, type AgentLimits } from "./policy";

const TOKEN = "0x0000000000000000000000000000000000000011" as const;
const USDG = "0x0000000000000000000000000000000000000022" as const;
const ROUTER = "0x0000000000000000000000000000000000000033" as const;
const AGENT = "0x0000000000000000000000000000000000000044";
const input = { agentId: AGENT, market: { instrumentId: "merrymen:meme", symbol: "MEME", priceUsd: "0.01" } } as ShadowInputs;
const answer = (over = {}) => ({ ran: true, result: { ok: true, decision: {
  decision_id: "decision-1", agent_id: AGENT, instrument_id: "merrymen:meme", symbol: "MEME", action: "buy", suggested_delta_usdg: 5e6, gate_verdict: "proceed", ...over,
} } }) as ShadowOutcome;
const pool = (over: Partial<GeckoPool> = {}): GeckoPool => ({
  tokenAddress: TOKEN, volume24hUsd: 200_000, buyers24h: 50, buys24h: 100, sells24h: 80,
  buckets: { ...emptyGeckoBuckets(), m5: { changePct: 2, volumeUsd: 1000, buys: 10, sells: 8, buyers: 9, sellers: 8 } }, ...over,
} as GeckoPool);

test("volume screening rejects missing, thin, inactive and one-sided tape; ranks and deduplicates", () => {
  assert.equal(highVolumePools([pool({ volume24hUsd: null }), pool({ volume24hUsd: 99_999 }), pool({ buyers24h: 19 }), pool({ sells24h: 0 }), pool({ buckets: emptyGeckoBuckets() })]).length, 0);
  const ranked = highVolumePools([pool(), pool({ volume24hUsd: 300_000 }), pool({ tokenAddress: ROUTER, volume24hUsd: 400_000 })]);
  assert.deepEqual(ranked.map(p => p.volume24hUsd), [400_000, 300_000]);
});

test("Brain runs in background, cannot overlap, and approval is one-use", async () => {
  const review = new TrenchBrainReview(() => 1000);
  let finish!: (v: ShadowOutcome) => void;
  let calls = 0;
  const run = () => { calls++; return new Promise<ShadowOutcome>(r => { finish = r; }); };
  review.launch("paper", input, TOKEN, run, () => {});
  review.launch("paper", input, TOKEN, run, () => {});
  assert.equal(calls, 1);
  assert.equal(review.take("MEME", TOKEN, 1_000_000n, 5), null);
  finish(answer()); await setImmediate();
  assert.equal(review.take("MEME", TOKEN, 1_000_000n, 5)?.side, "buy");
  assert.equal(review.take("MEME", TOKEN, 1_000_000n, 5), null);
});

test("stale, repriced, wrong-token, wrong-owner and refused decisions cannot trade", async () => {
  for (const scenario of ["stale", "price", "token", "owner", "gate", "mode"]) {
    let now = 1000;
    const review = new TrenchBrainReview(() => now);
    review.launch("paper", input, TOKEN, async () => answer(scenario === "owner" ? { agent_id: USDG } : scenario === "gate" ? { gate_verdict: "refuse" } : scenario === "size" ? { suggested_delta_usdg: 6e6 } : {}), () => {});
    await setImmediate();
    if (scenario === "stale") now += 60_001;
    if (scenario === "mode") review.reset("live");
    assert.equal(review.take("MEME", scenario === "token" ? USDG : TOKEN, scenario === "price" ? 1_030_000n : 1_000_000n, 5), null, scenario);
  }
});

test("Brain sizing is capped to the owner's existing maximum", async () => {
  const review = new TrenchBrainReview();
  review.launch("paper", input, TOKEN, async () => answer({ suggested_delta_usdg: 50e6 }), () => {});
  await setImmediate();
  assert.equal(review.take("MEME", TOKEN, 1_000_000n, 5)?.usdgAmount, 5);
});

test("Brain-approved memecoin entry and fast exit fill the paper book with realized P&L", async () => {
  const review = new TrenchBrainReview();
  const candidate: Candidate = { symbol: "MEME", token: TOKEN, decimals: 18, price8: 1_000_000n, priceable: true, liquidityUsd: 100_000, fdvUsd: 1_000_000, ageSec: 3600 };
  let open: OpenPosition[] = [];
  const strategy = makeTrencher({ cfg: TRENCHER_FAST, brainRequired: true, brainOrder: (s,t,p) => review.take(s,t,p,10), swapRouter: ROUTER, usdgToken: USDG, candidates: () => [candidate], open: () => open, liquidityOf: () => 100_000 });
  const snap = { cashUsdg: 1000_000_000n, vaultUsdg: 0n, holdings: new Map(), prices: new Map(), pausedTokens: new Set(), staleFeeds: new Set(), sequencerUp: true, spendHeadroomUsdg: 100_000_000n, perTradeCapUsdg: 10_000_000n } as Snapshot;
  assert.equal(takeTick(await strategy.tick(snap)).intents.length, 0, "no rule entry without Brain");
  review.launch("paper", input, TOKEN, async () => answer(), () => {}); await setImmediate();
  const intents = takeTick(await strategy.tick(snap)).intents;
  assert.equal(intents.length, 1); assert.equal(intents[0]!.decisionId, "decision-1");
  const nowSec = Math.floor(Date.now()/1000);
  const limits: AgentLimits = { perTradeUsdg: 10_000_000n, dailyUsdg: 100_000_000n, maxOpsPerDay: 20, allowedTargets: [ROUTER], allowedAssets: [USDG, TOKEN], maxDrawdownBps: 1000, expiresAt: nowSec + 1000 };
  const state = { spentTodayUsdg: 0n, opsToday: 0, highWaterMarkUsdg: 1000_000_000n, equityUsdg: 1000_000_000n, nowSec };
  assert.equal(checkPolicy(intents[0]!, limits, state).ok, true);
  assert.equal(checkPolicy(intents[0]!, { ...limits, allowedAssets: [USDG] }, state).ok, false, "Brain cannot authorize a new token");
  assert.equal(checkPolicy(intents[0]!, { ...limits, perTradeUsdg: 1n }, state).ok, false, "Brain cannot expand spending limits");
  const opts = { usdgAddress: USDG, slippageBps: 100, notionalUsdg: 5, symbolOf: () => "MEME", priceUsdOf: () => ({ priceUsd: .01, stale: false }) };
  const bought = applyPaperIntent(intents[0]!, { cashUsdg: 1000, vaultUsdg: 0, hwmUsdg: 1000 }, [], opts);
  assert.ok(bought.ok);
  const qty = BigInt(Math.round(bought.fill!.rawShares * 1e18));
  const basis = applyFill(ZERO_BASIS, { side: "buy", qtyRaw: qty, cashUsdg: 5_000_000n }).basis;
  open = [{ symbol: "MEME", token: TOKEN, qtyRaw: qty, costUsdg: 5_000_000n, entryPrice8: 1_000_000n, entryLiquidityUsd: 100_000, entrySec: Math.floor(Date.now()/1000) }];
  snap.prices.set("MEME", { price8: 1_300_000n, stale: false } as never);
  snap.holdings.set("MEME", { token: TOKEN, rawBalance: qty, valueUsdg: 6_435_000n, priceStale: false });
  const exits = takeTick(await strategy.tick(snap)).intents;
  assert.equal(exits.length, 1, "exit does not wait for another Brain decision");
  const sold = applyPaperIntent(exits[0]!, bought.book, bought.positions, { ...opts, notionalUsdg: 6.435, priceUsdOf: () => ({ priceUsd: .013, stale: false }) });
  assert.ok(sold.ok); assert.equal(sold.positions.length, 0);
  const closed = applyFill(basis, { side: "sell", qtyRaw: qty, cashUsdg: BigInt(Math.round(sold.fill!.cashUsdg * 1e6)) });
  assert.equal(Math.round((sold.book.cashUsdg - 1000)*1e6), Number(closed.realizedUsdg));
  assert.ok(closed.realizedUsdg > 0n);
});

test("Brain can sell early without waiting for a mechanical threshold", async () => {
  const review = new TrenchBrainReview();
  const heldInput = { ...input, positions: [{ symbol: "MEME", qtyRaw: "500000000000000000000" }] } as ShadowInputs;
  review.launch("paper", heldInput, TOKEN, async () => answer({ action: "sell", suggested_delta_usdg: -2e6 }), () => {});
  await setImmediate();
  const strategy = makeTrencher({ cfg: TRENCHER_FAST, brainRequired: true, brainOrder: (s,t,p,h) => review.take(s,t,p,5,h), swapRouter: ROUTER, usdgToken: USDG,
    candidates: () => [], liquidityOf: () => 100_000,
    open: () => [{ symbol: "MEME", token: TOKEN, qtyRaw: 500n*10n**18n, costUsdg: 5_000_000n, entryPrice8: 1_000_000n, entryLiquidityUsd: 100_000, entrySec: Math.floor(Date.now()/1000) }] });
  const snap = { sequencerUp: true, holdings: new Map([["MEME", { token: TOKEN, rawBalance: 500n*10n**18n, valueUsdg: 5_000_000n, priceStale: false }]]), prices: new Map([["MEME", { price8: 1_000_000n, stale: false }]]), pausedTokens: new Set() } as unknown as Snapshot;
  const orders = takeTick(await strategy.tick(snap)).intents;
  assert.equal(orders.length, 1);
  assert.equal(orders[0]!.decisionId, "decision-1");
  assert.ok(orders[0]!.kind === "swap");
  assert.equal(orders[0]!.notionalUsdg, 2_000_000n);
  assert.equal(orders[0]!.sellAmountRaw, 200n*10n**18n);
  assert.equal(takeTick(await strategy.tick(snap)).intents.length, 0, "cannot repeat the same sell approval");
});
