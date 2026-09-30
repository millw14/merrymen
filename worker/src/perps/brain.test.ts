import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { brainFingerprint, brainMarketStillQualified, buildPerpsBrainRequest, perpsBrainEstimatedCostBps, PerpsBrainReview, requestPerpsBrain, validatePerpsBrainResponse, PERPS_BRAIN_TTL_MS, type PerpsBrainResponse, type PerpsBrainRequest } from "./brain";
import { perpTrendTick } from "./perp-trend";
import { NOW_SEC, ctx, settings, view } from "./testkit-perps";
import type { LighterFeedRead } from "./feed-reader";

function fixture(key: "BTC-PERP" | "ETH-PERP" | "SOL-PERP" = "BTC-PERP", halfSpread = 1n) {
  const v = view({}, [key]);
  const trend = perpTrendTick(v, settings({ perpsMarkets: [key] }), ctx());
  assert.ok(trend.entry);
  const c = trend.entry, m = v.markets.get(c.market)!;
  const markets = new Map(v.markets);
  markets.set(c.market, { ...m, bestBid: m.markPrice - halfSpread, bestAsk: m.markPrice + halfSpread });
  const feed = { markets: new Map([[c.marketId, { fresh: true, bookFresh: true, takerFeePpm: 100,
    bids: [{ price: m.markPrice - halfSpread, baseAmount: 10000000n }], asks: [{ price: m.markPrice + halfSpread, baseAmount: 10000000n }] }]]) } as unknown as LighterFeedRead;
  const args = { agentId: "agent-a", runId: "run-a", nowMs: NOW_SEC * 1000, context: "settings-grant-a", view: { ...v, markets }, candidate: c, candleT: trend.entryCandleT!, feed };
  const request = buildPerpsBrainRequest(args); assert.ok(request);
  return { args, request, candidate: c, mark: m.markPrice };
}
function approval(r: PerpsBrainRequest): PerpsBrainResponse {
  return { schema_version: r.schema_version, run_id: r.run_id, agent_id: r.agent_id, snapshot_id: r.snapshot_id, market: r.market, as_of_ms: r.as_of_ms, expires_at_ms: r.expires_at_ms,
    strategy_version: "merrymenbrain-perps-analogs-v1", candidate_bar_t: r.candidate.bar_t, candidate_side: r.candidate.side, action: r.candidate.side, reason_codes: ["evidence-qualified"], features: {},
    forecast: { method: "causal-regime-analogs-v1", horizon_bars: 3, target: "signed-mark-return-after-estimated-costs", samples: 40,
      win_probability: .7, lower_95: .55, upper_95: .85, mean_net_bps: 60, mean_lower_95_bps: 10, cost_bps: perpsBrainEstimatedCostBps(r), calibrated: false },
    committee: ["bull", "bear", "risk"].map(lens => ({ lens, verdict: "accept", reason: "measured evidence supports candidate" })) };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

describe("MerrymenBrain perps binding and measured material", () => {
  it("binds exact evidence, owner context and capped candidate; excludes random run id", () => {
    const f = fixture();
    assert.equal(buildPerpsBrainRequest({ ...f.args, runId: "another" })?.snapshot_id, f.request.snapshot_id);
    assert.equal(buildPerpsBrainRequest({ ...f.args, agentId: "Agent-AbC" })?.agent_id, "Agent-AbC", "preserves the exact ledger tenant id");
    assert.notEqual(buildPerpsBrainRequest({ ...f.args, context: "new-grant" })?.snapshot_id, f.request.snapshot_id);
    assert.notEqual(buildPerpsBrainRequest({ ...f.args, candidate: { ...f.candidate, notionalUsdg: f.candidate.notionalUsdg - 1n } })?.snapshot_id, f.request.snapshot_id);
    assert.equal(f.request.taker_fee_bps, 1);
    assert.ok(f.request.depth_ratio > 1);
    assert.equal(f.request.candles.at(-1)?.t, f.request.candidate.bar_t);
    assert.equal(brainFingerprint({ a: 1, b: 2 }), brainFingerprint({ b: 2, a: 1 }));
  });
  it("unread feed, stale view, unknown funding, missing history, or empty executable depth never invents evidence", () => {
    const f = fixture();
    assert.equal(buildPerpsBrainRequest({ ...f.args, feed: null }), null);
    assert.equal(buildPerpsBrainRequest({ ...f.args, nowMs: f.args.nowMs + 31_000 }), null);
    for (const over of [{ closed4h: null }, { fundingPpmPerHour: null }, { indexPrice: null }]) {
      const markets = new Map(f.args.view.markets); markets.set(f.candidate.market, { ...markets.get(f.candidate.market)!, ...over });
      assert.equal(buildPerpsBrainRequest({ ...f.args, view: { ...f.args.view, markets } }), null);
    }
    const tape = f.args.feed.markets.get(f.candidate.marketId)!;
    const feed = { ...f.args.feed, markets: new Map([[f.candidate.marketId, { ...tape, asks: [], bids: [] }]]) };
    assert.equal(buildPerpsBrainRequest({ ...f.args, feed }), null, "insufficient observable entry or exit liquidity is unread");
  });
  it("measures both sides of executable depth instead of charging the default 50bp IOC allowance", () => {
    const f = fixture();
    assert.ok(f.request.slippage_bps > 0 && f.request.slippage_bps < 1, "actual best-quote cost relative to mark is priced even without walking deeper");
    assert.ok(2 * (f.request.slippage_bps + f.request.spread_bps + f.request.taker_fee_bps) < .15 * f.request.candidate.stop_bps,
      "ordinary liquid default candidates are not mathematically forced to hold");
    const tape = f.args.feed.markets.get(f.candidate.marketId)!;
    const feedWith = (bids: typeof tape.bids, asks = tape.asks) => ({ ...f.args.feed, markets: new Map([[f.candidate.marketId, { ...tape, bids, asks }]]) });
    assert.equal(buildPerpsBrainRequest({ ...f.args, feed: feedWith([{ price: f.mark - 1n, baseAmount: 1n }]) }), null,
      "deep entry liquidity cannot hide insufficient observed exit liquidity");
    const impacted = buildPerpsBrainRequest({ ...f.args, feed: feedWith([
      { price: f.mark - 1n, baseAmount: 1n }, { price: f.mark * 996n / 1000n, baseAmount: 10000000n },
    ]) });
    assert.ok(impacted && impacted.slippage_bps > 30, "the thinner side's measured impact drives the estimate");
    assert.equal(brainMarketStillQualified(f.request, impacted), false);
  });
  it("charges a book premium versus mark even when the spread and book-walk impact are tiny", () => {
    const f = fixture(), tape = f.args.feed.markets.get(f.candidate.marketId)!;
    const bid = f.mark * 10025n / 10000n, ask = bid + 1n;
    const market = f.args.view.markets.get(f.candidate.market)!;
    const v = { ...f.args.view, markets: new Map([[f.candidate.market, { ...market, bestBid: bid, bestAsk: ask }]]) };
    const feed = { ...f.args.feed, markets: new Map([[f.candidate.marketId, { ...tape,
      bids: [{ price: bid, baseAmount: 10000000n }], asks: [{ price: ask, baseAmount: 10000000n }] }]]) };
    const request = buildPerpsBrainRequest({ ...f.args, view: v, feed });
    assert.ok(request && request.slippage_bps >= 25 && request.spread_bps < .1);
    assert.equal(brainMarketStillQualified(f.request, request), false);
  });
  it("a completed review never covers wider stops, higher costs, dislocated basis or insufficient depth", () => {
    const { request: r } = fixture();
    assert.equal(brainMarketStillQualified(r, { ...r }), true);
    for (const over of [{ spread_bps: r.spread_bps + 1 }, { taker_fee_bps: r.taker_fee_bps + 1 },
      { slippage_bps: r.slippage_bps + 1 }, { funding_ppm_per_hour: r.funding_ppm_per_hour + 1 },
      { depth_ratio: 1.24 }, { index_price: String(BigInt(r.index_price) / 2n) },
      { candidate: { ...r.candidate, stop_bps: r.candidate.stop_bps + 1 } }])
      assert.equal(brainMarketStillQualified(r, { ...r, ...over }), false, JSON.stringify(over));
  });
  it("realistic next-frame BTC, ETH and SOL candidates retain approval within the frozen risk and cost budget", () => {
    for (const key of ["BTC-PERP", "ETH-PERP", "SOL-PERP"] as const) {
      const f = fixture(key, 2n), m = f.args.view.markets.get(key)!;
      const movement = { "BTC-PERP": 100n, "ETH-PERP": 10n, "SOL-PERP": 1n }[key];
      const mark = m.markPrice - movement;
      const markets = new Map([[key, { ...m, markPrice: mark, indexPrice: m.indexPrice! - movement,
        bestBid: mark - 1n, bestAsk: mark + 1n }]]);
      const v = { ...f.args.view, markets };
      const trend = perpTrendTick(v, settings({ perpsMarkets: [key] }), ctx()); assert.ok(trend.entry);
      const tape = f.args.feed.markets.get(m.marketId)!;
      const feed = { ...f.args.feed, markets: new Map([[m.marketId, { ...tape,
        bids: tape.bids.map(l => ({ ...l, price: mark - 1n })), asks: tape.asks.map(l => ({ ...l, price: mark + 1n })) }]]) };
      const current = buildPerpsBrainRequest({ ...f.args, nowMs: f.args.nowMs + 1000, view: v, feed, candidate: trend.entry }); assert.ok(current);
      assert.equal(brainMarketStillQualified(f.request, current, approval(f.request)), true, key);
      const expensive = { ...current, taker_fee_bps: current.taker_fee_bps + 5 };
      assert.equal(brainMarketStillQualified(f.request, expensive, approval(f.request)), false, key);
    }
  });
  it("rejects every mismatched binding, unknown schema, expired window and future observation", () => {
    const { request: r } = fixture(); const good = approval(r);
    assert.ok(validatePerpsBrainResponse(good, r, r.as_of_ms + 1));
    for (const over of [{ run_id: "other" }, { agent_id: "other" }, { snapshot_id: "other" }, { market: "SOL-PERP" },
      { schema_version: "spot" }, { as_of_ms: r.as_of_ms - 1 }, { expires_at_ms: r.expires_at_ms + 1 }, { candidate_bar_t: r.candidate.bar_t - 1 },
      { candidate_side: "short" }, { action: "short" }]) assert.equal(validatePerpsBrainResponse({ ...good, ...over }, r, r.as_of_ms + 1), null, JSON.stringify(over));
    assert.equal(validatePerpsBrainResponse(good, r, r.expires_at_ms), null);
    assert.equal(validatePerpsBrainResponse(good, r, r.as_of_ms - 1), null);
  });
  it("a malformed forecast, unsupported probability, or incomplete/vetoed committee never approves", () => {
    const { request: r } = fixture(); const good = approval(r);
    for (const over of [{ samples: 0 }, { mean_lower_95_bps: 0 }, { cost_bps: -1 }, { win_probability: 2 }, { calibrated: true }, { method: "trust-me" }, { mean_net_bps: NaN }, { mean_net_bps: -100 }, { cost_bps: 0 }])
      assert.equal(validatePerpsBrainResponse({ ...good, forecast: { ...good.forecast, ...over } }, r, r.as_of_ms), null);
    for (const committee of [undefined, [], good.committee!.slice(0, 2), [good.committee![0], good.committee![0], good.committee![0]], good.committee!.map(x => ({ ...x, verdict: "veto" }))])
      assert.equal(validatePerpsBrainResponse({ ...good, committee }, r, r.as_of_ms), null);
    assert.ok(validatePerpsBrainResponse({ ...good, action: "hold", committee: [] }, r, r.as_of_ms));
  });
});

describe("background perps Brain review", () => {
  it("never blocks, deduplicates paid work and consumes an approval once", async () => {
    const f = fixture(); let clock = f.request.as_of_ms; let calls = 0;
    const review = new PerpsBrainReview(() => clock);
    let finish!: (r: PerpsBrainResponse) => void;
    const work = () => { calls++; return new Promise<PerpsBrainResponse>(resolve => { finish = resolve; }); };
    review.launch("c", f.request, f.candidate, work, () => {});
    review.launch("c", f.request, f.candidate, work, () => {});
    assert.equal(calls, 1); assert.equal(review.take("c", f.candidate, f.args.candleT, f.mark), null);
    finish(approval(f.request)); await flush();
    assert.ok(review.take("c", f.candidate, f.args.candleT, f.mark));
    assert.equal(review.take("c", f.candidate, f.args.candleT, f.mark), null);
    clock++; review.launch("c", f.request, f.candidate, work, () => {}); assert.equal(calls, 1);
    assert.equal(new PerpsBrainReview(() => clock).take("c", f.candidate, f.args.candleT, f.mark), null, "restart cannot replay approval");
  });
  it("discards old settings/grant context, excessive price drift, bigger positions or expired results", async () => {
    const f = fixture();
    for (const kind of ["context", "drift", "size", "expiry"] as const) {
      let clock = f.request.as_of_ms; const review = new PerpsBrainReview(() => clock);
      review.launch("c", f.request, f.candidate, async () => approval(f.request), () => {}); await flush();
      if (kind === "expiry") clock += PERPS_BRAIN_TTL_MS;
      assert.equal(review.take(kind === "context" ? "new" : "c", kind === "size" ? { ...f.candidate, notionalUsdg: f.candidate.notionalUsdg + 1n } : f.candidate,
        f.args.candleT, kind === "drift" ? f.mark * 101n / 100n : f.mark), null, kind);
    }
  });
  it("late in-flight result is rejected after settings change", async () => {
    const f = fixture(); const review = new PerpsBrainReview(() => f.request.as_of_ms);
    let finish!: (r: PerpsBrainResponse) => void;
    review.launch("old", f.request, f.candidate, () => new Promise(resolve => { finish = resolve; }), () => {});
    review.reset("new"); finish(approval(f.request)); await flush();
    assert.equal(review.take("new", f.candidate, f.args.candleT, f.mark), null);
  });
});

it("HTTP client is authenticated, response-bounded and keeps its deadline through a stalled body", async () => {
  const f = fixture(); const request = { ...f.request, as_of_ms: Date.now(), expires_at_ms: Date.now() + PERPS_BRAIN_TTL_MS };
  let hits = 0;
  const server = createServer((req, res) => { hits++; assert.equal(req.url, "/v1/perps/decide"); assert.equal(req.headers.authorization, "Bearer test-token"); res.writeHead(200, { "content-type": "application/json" }); res.write('{"ok":true'); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const addr = server.address(); assert.ok(addr && typeof addr !== "string");
    assert.equal(await requestPerpsBrain({ url: `http://127.0.0.1:${addr.port}`, token: "test-token", timeoutMs: 1000 }, request), null);
    assert.equal(hits, 1, "never retries");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
