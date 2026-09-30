import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { TrenchBrainReview, TrenchTapeReader, fetchTrenchTape, type TrenchBrainOrder, highVolumePools, trenchBrainPersona, trenchBrainSignals, HELD_REVIEW_MAX_GAP_MS, NOMINATED_PAGES_MAX, PRIORITY_RETRY_MS, TRENCH_REVIEW_INTERVAL_MS } from "./trencher-brain";
import { chooseFocus } from "./brain-focus";
import { emptyGeckoBuckets, type GeckoPool } from "./venues/geckoterminal";
import type { ShadowInputs, ShadowOutcome } from "./brain-shadow";
import { makeTrencher, TRENCHER_FAST, type Candidate, type OpenPosition } from "./strategies/trencher";
import { takeTick, type Snapshot } from "./strategies/types";
import { applyPaperIntent } from "./paper";
import { applyFill, ZERO_BASIS } from "./basis";
import { checkPolicy, type AgentLimits } from "./policy";
import { CASH } from "../../packages/core/src/index";
import { NominationBook } from "./trencher-nominate";

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

test("partial tape refresh retains fresh failed pages without renewing them, then expires them", async () => {
  let now = 1000, round = 0;
  const reader = new TrenchTapeReader(async (feed, opts) => {
    if (feed !== "pools" || opts?.page !== 1) return { failed: false, pools: [] };
    return round === 0 ? { failed: false, pools: [pool()] } : { failed: true, pools: [], failure: "http-429" };
  }, () => now);
  assert.equal((await reader.refresh()).pools.length, 1);
  round++; now += 60_000;
  const partial = await reader.refresh();
  assert.equal(partial.pools.length, 1);
  assert.equal(partial.observedAt, 1000);
  assert.deepEqual(partial.failures, ["pools:1=http-429"]);
  now = 121001;
  assert.equal(reader.snapshot().pools.length, 0, "expiry applies between refreshes too");
});

test("healthy empty and newer ineligible observations remove old opportunities", async () => {
  let now = 1000, round = 0;
  const reader = new TrenchTapeReader(async (feed) => {
    if (round === 0) return { failed: false, pools: [pool()] };
    if (feed === "pools") return { failed: true, pools: [] };
    return { failed: false, pools: round === 1 ? [pool({ volume24hUsd: 0 })] : [] };
  }, () => now);
  await reader.refresh();
  round = 1; now += 1000;
  assert.equal((await reader.refresh()).pools.length, 0, "newer failing screen wins over older high volume");
  round = 2; now = 122001;
  assert.equal((await reader.refresh()).pools.length, 0);
});

test("shared feed cache hits cannot renew the tape's observation time", async () => {
  let now = 60_000;
  const reader = new TrenchTapeReader(async () => ({ failed: false, pools: [pool()], observedAt: 1000 }), () => now);
  assert.equal((await reader.refresh()).observedAt, 1000);
  now = 121001;
  assert.equal((await reader.refresh()).pools.length, 0);
});

test("Brain receives short-window momentum and depth in dollars without fabricating missing measurements", () => {
  const p = pool({ reserveUsd: 5_000_000, fdvUsd: 400_000_000 });
  const s = trenchBrainSignals(p, 120_000, 250_000);
  const technical = JSON.parse(s.technical), social = JSON.parse(s.social), liquidity = JSON.parse(s.liquidity);
  assert.equal(technical.windows.m5.changePct, 2);
  assert.equal(technical.windows.h1.changePct, null);
  assert.equal(social.windows.m5.buys, 10);
  assert.equal(social.windows.m5.sellers, 8);
  assert.equal(liquidity.onchainRouteDepthUsd, 250_000);
  assert.equal(liquidity.maxEntryAsPercentOfRouteDepth, .002);
  for (const depth of [null, NaN, Infinity, -1]) {
    const l = JSON.parse(trenchBrainSignals(p, 120_000, depth).liquidity);
    assert.equal(l.onchainRouteDepthUsd, null);
    assert.equal(l.maxEntryAsPercentOfRouteDepth, null);
  }
});

test("discovery includes later pages, deduplicates pools and survives partial outages", async () => {
  const calls: string[] = [];
  const later = pool({ tokenAddress: ROUTER, poolAddress: ROUTER });
  const tape = await fetchTrenchTape(async (feed, opts) => {
    calls.push(`${feed}:${opts?.page}`);
    if (opts?.page === 3) throw new Error("page unavailable");
    return { failed: false, pools: opts?.page === 2 ? [later] : [pool()] };
  });
  assert.equal(calls.length, 6);
  assert.equal(new Set(calls).size, 6);
  assert.equal(tape.length, 2);
  assert.ok(tape.some(p => p.tokenAddress === ROUTER));
  await assert.rejects(fetchTrenchTape(async () => ({ failed: true, pools: [] })), /All Trencher/);
});

test("HOLD rotates review to other eligible tokens without overlapping model calls", async () => {
  let now = 1000;
  const review = new TrenchBrainReview(() => now);
  const candidates = [{ token: TOKEN }, { token: ROUTER }];
  review.reset("live");
  assert.equal(review.candidate(candidates)?.token, TOKEN);
  review.launch("live", input, TOKEN, async () => answer({ action: "hold" }), () => {});
  await setImmediate();
  assert.equal(review.candidate(candidates)?.token, ROUTER);
  let calls = 0;
  review.launch("live", input, ROUTER, async () => { calls++; return answer({ action: "hold" }); }, () => {});
  assert.equal(calls, 0, "cooldown must not consume the next candidate");
  now += TRENCH_REVIEW_INTERVAL_MS;
  review.launch("live", input, ROUTER, async () => { calls++; return answer({ action: "hold" }); }, () => {});
  await setImmediate();
  assert.equal(calls, 1);
  assert.equal(review.candidate(candidates)?.token, TOKEN);
  assert.equal(review.candidate([candidates[1]!])?.token, ROUTER, "ineligible tokens cannot be selected");
  review.reset("new-grant");
  assert.equal(review.candidate(candidates)?.token, TOKEN);
});

test("volume screening rejects missing, thin, inactive and one-sided tape; ranks and deduplicates", () => {
  assert.equal(highVolumePools([pool({ volume24hUsd: null }), pool({ volume24hUsd: 99_999 }), pool({ buyers24h: 19 }), pool({ sells24h: 0 }), pool({ buckets: emptyGeckoBuckets() })]).length, 0);
  const ranked = highVolumePools([pool(), pool({ volume24hUsd: 300_000 }), pool({ tokenAddress: ROUTER, volume24hUsd: 400_000 })]);
  assert.deepEqual(ranked.map(p => p.volume24hUsd), [400_000, 300_000]);
});

test("cash and wrapped native assets cannot enter the memecoin universe even with qualifying volume", () => {
  const ranked = highVolumePools([
    pool({ tokenAddress: CASH.USDG, volume24hUsd: 900_000 }),
    pool({ tokenAddress: CASH.WETH.toLowerCase() as `0x${string}`, volume24hUsd: 800_000 }),
    pool(),
  ]);
  assert.deepEqual(ranked.map(p => p.tokenAddress), [TOKEN]);
});

test("pool tape retains venue alternatives and deduplicates repeated feed rows", () => {
  const v3 = pool({ dex: "uniswap-v3-robinhood", poolAddress: TOKEN });
  const v4 = pool({ dex: "uniswap-v4-robinhood", poolAddress: ROUTER, volume24hUsd: 500_000 });
  const tape = highVolumePools([v3, v4, v3], true);
  assert.equal(tape.length, 2);
  assert.equal(highVolumePools(tape.filter(p => p.dex === "uniswap-v3-robinhood"))[0], v3);
});

test("unowned SELL decisions cannot become executable orders and explain why", async () => {
  const review = new TrenchBrainReview();
  const notes: string[] = [];
  review.launch("live", input, TOKEN, async () => answer({ action: "sell", suggested_delta_usdg: -5e6 }), n => notes.push(n));
  await setImmediate();
  assert.equal(review.take("MEME", TOKEN, 1_000_000n, 5), null);
  assert.match(notes.join(" "), /no position is held/);
  assert.match(trenchBrainPersona("MEME", false), /hold zero MEME.*BUY or HOLD/);
  assert.match(trenchBrainPersona("MEME", true), /hold MEME.*HOLD or SELL/);
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

// ─── Nominated coins (Telegram groups, docs/tg-groups.md) ─────────────────

const NOMINATED = "0x00000000000000000000000000000000000000aa" as const;

test("a nominated coin that is ELIGIBLE goes ahead of the rotation; one that is not gets nothing", async () => {
  let now = 1000;
  const review = new TrenchBrainReview(() => now);
  review.reset("live");
  const busy = { token: TOKEN, volume24hUsd: 900_000 };
  const quiet = { token: NOMINATED, volume24hUsd: 150_000 };
  // No hint: busiest first, as before.
  assert.equal(review.candidate([busy, quiet])?.token, TOKEN);
  // The hint, spelled in any case, moves the eligible nominated coin first.
  assert.equal(review.candidate([busy, quiet], new Set([NOMINATED.toUpperCase().replace("0X", "0x")]))?.token, NOMINATED);
  // Not eligible (filtered out by the caller: not verified, fails shouldEnter,
  // paused, held) → the hint cannot put it on the queue.
  assert.equal(review.candidate([busy], new Set([NOMINATED]))?.token, TOKEN);
  assert.equal(review.candidate([], new Set([NOMINATED])), undefined);
  // An empty hint is no hint.
  assert.equal(review.candidate([busy, quiet], new Set())?.token, TOKEN);
});

test("a nominated coin cannot take every review slot: it is re-preferred only after PRIORITY_RETRY_MS", async () => {
  let now = 1000;
  const review = new TrenchBrainReview(() => now);
  review.reset("live");
  const eligible = [{ token: TOKEN, volume24hUsd: 900_000 }, { token: NOMINATED, volume24hUsd: 150_000 }];
  const priority = new Set([NOMINATED]);
  assert.equal(review.candidate(eligible, priority)?.token, NOMINATED);
  // The review of it produced no decision (Brain down): the nomination stays.
  review.launch("live", input, NOMINATED, async () => ({ ran: true, result: { ok: false, kind: "unavailable", detail: "down" } }) as unknown as ShadowOutcome, () => {});
  await setImmediate();
  now += TRENCH_REVIEW_INTERVAL_MS;
  assert.equal(review.candidate(eligible, priority)?.token, TOKEN, "the next slot goes to the rotation");
  now = 1000 + PRIORITY_RETRY_MS;
  assert.equal(review.candidate(eligible, priority)?.token, NOMINATED, "and the one after may ask again");
  assert.equal(PRIORITY_RETRY_MS, 2 * TRENCH_REVIEW_INTERVAL_MS, "at most every other slot");
});

const HEAD = "0x00000000000000000000000000000000000000bb" as const;
const SECOND = "0x00000000000000000000000000000000000000cc" as const;
const noDecision = async () => ({ ran: true, result: { ok: false, kind: "unavailable", detail: "down" } }) as unknown as ShadowOutcome;

test("an ineligible head of the queue does not hold the preference: the first ELIGIBLE nomination, in queue order, goes first", () => {
  // The chat-side look does not pre-screen depth, flow or discovery's
  // verification, so the oldest nomination may never be eligible at the tick.
  const review = new TrenchBrainReview(() => 1000);
  review.reset("live");
  // Discovery happened to return NOMINATED before SECOND; HEAD is filtered out.
  const eligible = [{ token: TOKEN, volume24hUsd: 900_000 }, { token: NOMINATED, volume24hUsd: 300_000 }, { token: SECOND, volume24hUsd: 150_000 }];
  assert.equal(review.candidate(eligible, new Set([HEAD, SECOND, NOMINATED]))?.token, SECOND, "queue order, not discovery order");
});

test("the book's hint names every waiting nomination, so the coin behind an ineligible head is looked at first", () => {
  let now = 1_000_000;
  const book = new NominationBook({ takeNomination: () => true, takeGroupEntry: () => true, refundGroupEntry: () => {} }, () => now);
  assert.ok(book.nominate({ address: HEAD, chatId: -1, messageId: 1, senderId: 1, atMs: now }, "ready-paper").ok);
  now += 60_000;
  assert.ok(book.nominate({ address: SECOND, chatId: -2, messageId: 2, senderId: 2, atMs: now }, "ready-paper").ok);
  const review = new TrenchBrainReview(() => now);
  review.reset("live");
  const tape = [{ token: TOKEN, volume24hUsd: 900_000 }, { token: SECOND, volume24hUsd: 150_000 }];
  assert.equal(review.candidate(tape, book.priority())?.token, SECOND);
});

test("nominations TOGETHER hold at most every other slot, and one that resolved on its review still took its slot", async () => {
  let now = 1000;
  const review = new TrenchBrainReview(() => now);
  review.reset("live");
  const eligible = [{ token: TOKEN, volume24hUsd: 900_000 }, { token: ROUTER, volume24hUsd: 800_000 }, { token: NOMINATED, volume24hUsd: 150_000 }, { token: SECOND, volume24hUsd: 100_000 }];
  let priority = new Set<string>([NOMINATED, SECOND]);
  assert.equal(review.candidate(eligible, priority)?.token, NOMINATED);
  review.launch("live", input, NOMINATED, noDecision, () => {});
  await setImmediate();
  now += TRENCH_REVIEW_INTERVAL_MS;
  assert.equal(review.candidate(eligible, priority)?.token, TOKEN, "the other nomination does not take the very next slot");
  review.launch("live", input, TOKEN, noDecision, () => {});
  await setImmediate();
  now += TRENCH_REVIEW_INTERVAL_MS;
  assert.equal(review.candidate(eligible, priority)?.token, NOMINATED, "the slot after that is a nomination's again");
  review.launch("live", input, NOMINATED, noDecision, () => {});
  await setImmediate();
  // That review answered it, so it left the hint; its slot still counts.
  priority = new Set([SECOND]);
  now += TRENCH_REVIEW_INTERVAL_MS;
  assert.equal(review.candidate(eligible, priority)?.token, ROUTER, "the rotation's slot: its busiest coin not yet seen this pass");
  now += TRENCH_REVIEW_INTERVAL_MS;
  assert.equal(review.candidate(eligible, priority)?.token, SECOND);
});

test("the hint picks the ENTRY candidate only: an overdue held position still wins the focus", () => {
  // chooseFocus is untouched: the nominated candidate is just the universe it
  // is offered, and a holding past its review gap takes the slot regardless.
  const review = new TrenchBrainReview(() => 1_000_000);
  review.reset("live");
  const cand = review.candidate([{ token: NOMINATED }], new Set([HEAD, NOMINATED]));
  assert.equal(cand?.token, NOMINATED);
  const focus = chooseFocus({
    agentId: AGENT,
    positions: [{ symbol: "HELD", token: TOKEN, valueUsdg: 5_000_000, price8: 1_000_000n, priceStale: false, priceSource: "pool" }],
    universe: [{ symbol: "NOM", address: NOMINATED }],
    prices: new Map([["HELD", { price8: 1_000_000n, stale: false, source: "pool" }], ["NOM", { price8: 1_000_000n, stale: false, source: "pool" }]]) as never,
    paused: new Set(),
    alternate: { lastReviewedAtMs: new Map(), nowMs: 1_000_000, maxGapMs: HELD_REVIEW_MAX_GAP_MS },
  });
  assert.equal(focus?.symbol, "HELD", "never reviewed counts as overdue, and overdue wins");
});

test("reset says whether the context changed; a dropped order names its decision", async () => {
  let now = 1000;
  const review = new TrenchBrainReview(() => now);
  assert.equal(review.reset("paper"), true);
  assert.equal(review.reset("paper"), false);
  const drops: [string, string | undefined][] = [];
  review.onDrop = (why, id) => drops.push([why, id]);
  review.launch("paper", input, TOKEN, async () => answer(), () => {});
  await setImmediate();
  now += 60_001;
  assert.equal(review.take("MEME", TOKEN, 1_000_000n, 5), null);
  assert.equal(drops.length, 1);
  assert.match(drops[0]![0], /past the 60s/);
  assert.equal(drops[0]![1], "decision-1");
  assert.equal(review.reset("live"), true);
});

test("every refusal after the ready slot is cleared is reported with its decision id", async () => {
  // A nominated coin's group waits for this id: a silent null left it waiting
  // out the whole TTL for an answer that could no longer come.
  const cases: [string, (r: TrenchBrainReview) => TrenchBrainOrder | null, RegExp][] = [
    ["held changed", (r) => r.take("MEME", TOKEN, 1_000_000n, 5, true), /held changed/],
    ["no usable mark", (r) => r.take("MEME", TOKEN, 0n, 5), /no usable mark/],
    ["another token", (r) => r.take("MEME", ROUTER, 1_000_000n, 5), /does not match/],
  ];
  for (const [name, take, why] of cases) {
    const review = new TrenchBrainReview(() => 1000);
    review.reset("paper");
    const drops: [string, string | undefined][] = [];
    review.onDrop = (w, id) => drops.push([w, id]);
    review.launch("paper", input, TOKEN, async () => answer(), () => {});
    await setImmediate();
    assert.equal(take(review), null, name);
    assert.equal(drops.length, 1, name);
    assert.match(drops[0]![0], why, name);
    assert.equal(drops[0]![1], "decision-1", name);
  }
  // The order itself refused (the gate said refuse): reported too.
  const review = new TrenchBrainReview(() => 1000);
  review.reset("paper");
  const drops: [string, string | undefined][] = [];
  review.onDrop = (w, id) => drops.push([w, id]);
  review.launch("paper", input, TOKEN, async () => answer({ gate_verdict: "refuse" }), () => {});
  await setImmediate();
  assert.equal(review.take("MEME", TOKEN, 1_000_000n, 5), null);
  assert.equal(drops.length, 1);
  assert.equal(drops[0]![1], "decision-1");
  // A HOLD was never an order: nothing is dropped, nothing is said.
  const hold = new TrenchBrainReview(() => 1000);
  hold.reset("paper");
  const holdDrops: unknown[] = [];
  hold.onDrop = (w, id) => holdDrops.push([w, id]);
  hold.launch("paper", input, TOKEN, async () => answer({ action: "hold", suggested_delta_usdg: 0 }), () => {});
  await setImmediate();
  assert.equal(hold.take("MEME", TOKEN, 1_000_000n, 5), null);
  assert.deepEqual(holdDrops, []);
});

test("a nominated coin's own page rides the tape: read with it, screened like it, dropped when it resolves", async () => {
  let now = 1000;
  const tokenReads: string[] = [];
  let feedReads = 0;
  const nominatedPool = pool({ tokenAddress: NOMINATED, poolAddress: NOMINATED, dex: "uniswap-v3-robinhood" });
  const quietPool = pool({ tokenAddress: ROUTER, poolAddress: ROUTER, volume24hUsd: 1 });
  const reader = new TrenchTapeReader(
    async () => { feedReads++; return { failed: false, pools: [] }; },
    () => now,
    async (address) => {
      tokenReads.push(address);
      // A page may carry pools where the coin is the QUOTE; only its own count.
      if (address === NOMINATED) return { failed: false, pools: [nominatedPool, pool({ tokenAddress: USDG, poolAddress: USDG })], observedAt: now };
      return { failed: false, pools: [quietPool], observedAt: now };
    },
  );
  assert.equal((await reader.refresh()).pools.length, 0, "nothing nominated: nothing extra read");
  assert.deepEqual(tokenReads, []);

  reader.setNominated([NOMINATED.toUpperCase().replace("0X", "0x"), ROUTER, "not-an-address", NOMINATED]);
  const failures = await reader.refreshNominated();
  assert.deepEqual(failures, []);
  assert.deepEqual(tokenReads.sort(), [NOMINATED, ROUTER.toLowerCase()].sort());
  assert.equal(feedReads, 6, "a nomination's own refresh does not re-read the six feed pages");
  const snap = reader.snapshot();
  assert.deepEqual(snap.pools.map(p => p.tokenAddress), [NOMINATED], "the quiet nominated coin fails highVolumePools like any tape row");

  // Refreshed WITH the tape.
  tokenReads.length = 0;
  now += 60_000;
  await reader.refresh();
  assert.equal(tokenReads.length, 2);

  // Same 120s freshness: an unrefreshed page expires.
  now += 120_001;
  assert.equal(reader.snapshot().pools.length, 0);

  // Resolved → the page goes now, not at its freshness limit.
  now += 1;
  await reader.refreshNominated();
  assert.equal(reader.snapshot().pools.length, 1);
  reader.setNominated([]);
  assert.equal(reader.snapshot().pools.length, 0);
  tokenReads.length = 0;
  await reader.refresh();
  assert.deepEqual(tokenReads, []);
});

test("a nominated page failure is reported, never erases the tape, and a resolved read cannot come back", async () => {
  const now = 1000;
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const reader = new TrenchTapeReader(
    async () => ({ failed: false, pools: [pool()] }),
    () => now,
    async (address) => {
      if (address === ROUTER.toLowerCase()) return { failed: true, pools: [], failure: "http-429" };
      await gate;
      return { failed: false, pools: [pool({ tokenAddress: NOMINATED, poolAddress: NOMINATED })], observedAt: now };
    },
  );
  reader.setNominated([ROUTER]);
  const r = await reader.refresh();
  assert.deepEqual(r.failures, ["nominated=http-429"], "the kind of page, never the coin's address");
  assert.equal(r.pools.length, 1, "the feed pages are untouched by a failed token page");

  reader.setNominated([NOMINATED]);
  const inFlight = reader.refreshNominated();
  reader.setNominated([]); // resolved while the read was in flight
  release();
  await inFlight;
  assert.ok(!reader.snapshot().pools.some(p => p.tokenAddress === NOMINATED));
});

test("at most NOMINATED_PAGES_MAX nominated pages are ever read", async () => {
  const reads: string[] = [];
  const reader = new TrenchTapeReader(async () => ({ failed: false, pools: [] }), () => 1000,
    async (address) => { reads.push(address); return { failed: false, pools: [], observedAt: 1000 }; });
  reader.setNominated(Array.from({ length: NOMINATED_PAGES_MAX + 3 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`));
  await reader.refreshNominated();
  assert.equal(reads.length, NOMINATED_PAGES_MAX);
});
