/**
 * V1 IS A CANDIDATE AT THE ROUND IN FORCE; V2 IS AN ESTIMATE AND NEVER BOOKABLE.
 *
 * Every refusal below is a way of not knowing a price, and every one of them
 * must come out as a sentence rather than a zero or a nearby round.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CASH, CASH_FEEDS, NATIVE_ASSET, STOCK_TOKENS } from "../../packages/core/src/index.ts";
import {
  createReadOnlyRpc,
  equityStepEstimate,
  feedFor,
  RPC_METHODS,
  valueAtRoundInForce,
  type EquityMark,
  type ExactRound,
  type ValuationReads,
} from "./value.ts";

const TSLA = STOCK_TOKENS.find((t) => t.symbol === "TSLA")!;
const PEPE = "0x0000000000000000000000000000000000000ee0";
const AT = 1_790_000_000;
const PHASE = 1n << 64n;

/** A feed with every aggregator round 1..latest published 20 minutes apart. */
const feed = (opts: { latest: bigint; answer: bigint; decimals?: number; publishedAt: (agg: bigint) => number; holes?: bigint[] }) => {
  const make = (agg: bigint): ExactRound | null =>
    agg < 1n || agg > opts.latest || opts.holes?.includes(agg)
      ? null
      : {
          roundId: PHASE | agg,
          answer: opts.answer,
          decimals: opts.decimals ?? 8,
          priceUsd: Number(opts.answer) / 10 ** (opts.decimals ?? 8),
          updatedAt: opts.publishedAt(agg),
        };
  return {
    latestRound: async () => make(opts.latest),
    round: async (_feed: string, id: bigint) => make(id & ((1n << 64n) - 1n)),
  };
};
const reads = (f: ReturnType<typeof feed>, multiplier: bigint | null = 10n ** 18n): ValuationReads => ({
  latestRound: f.latestRound,
  round: f.round,
  uiMultiplier: async () => multiplier,
});
/** Round 99 published 10 minutes before AT, round 100 ten minutes after. */
const inForce = (answer: bigint) =>
  feed({ latest: 100n, answer, publishedAt: (agg) => AT - 600 - Number(99n - agg) * 1200 });

describe("which feed values which asset", () => {
  it("ETH and WETH by the ETH/USD feed, a stock token by its own feed and multiplier, a memecoin by nothing", () => {
    assert.equal(feedFor(NATIVE_ASSET)?.feed, CASH_FEEDS.ETH_USD);
    assert.equal(feedFor(CASH.WETH.toUpperCase().replace("0X", "0x"))?.feed, CASH_FEEDS.ETH_USD);
    assert.equal(feedFor(TSLA.address)?.feed, TSLA.chainlinkFeed);
    assert.equal(feedFor(TSLA.address)?.multiplier, "erc8056");
    assert.equal(feedFor(PEPE), null);
    const noFeed = STOCK_TOKENS.find((t) => t.chainlinkFeed === null);
    if (noFeed) assert.equal(feedFor(noFeed.address), null);
  });
});

describe("V1 — the Chainlink round in force", () => {
  it("values 13 TSLA at the round in force, as a CANDIDATE, exactly", async () => {
    const v = await valueAtRoundInForce({
      asset: TSLA.address,
      amountRaw: (13n * 10n ** 18n).toString(),
      at: AT,
      reads: reads(inForce(250_00000000n)),
    });
    assert.equal(v.status, "candidate");
    if (v.status !== "candidate") return;
    assert.equal(v.label, "candidate");
    assert.equal(v.valueUsdgRaw, "3250000000", "13 × $250 = 3,250.000000 USDG, in base units");
    assert.equal(v.roundId, (PHASE | 99n).toString());
    assert.equal(v.lagSec, 600);
    assert.equal(v.boundary, "successor-published-after");
    assert.deepEqual(v.multiplier, { raw: (10n ** 18n).toString(), readAt: "head" });
    assert.match(v.why, /multiplier is today's/);
  });

  it("applies a split multiplier, because the stock feed quotes per UI share", async () => {
    const v = await valueAtRoundInForce({
      asset: TSLA.address,
      amountRaw: (10n ** 18n).toString(),
      at: AT,
      reads: reads(inForce(100_00000000n), 2n * 10n ** 18n),
    });
    assert.equal(v.status === "candidate" && v.valueUsdgRaw, "200000000");
  });

  it("native ETH needs no multiplier", async () => {
    const v = await valueAtRoundInForce({ asset: NATIVE_ASSET, amountRaw: (5n * 10n ** 16n).toString(), at: AT, reads: reads(inForce(4000_00000000n), null) });
    assert.equal(v.status, "candidate");
    assert.equal(v.status === "candidate" && v.valueUsdgRaw, "200000000", "0.05 ETH × $4,000 = 200 USDG");
    assert.equal(v.status === "candidate" && v.multiplier, null);
  });

  it("the latest round, when it was already in force, needs no successor", async () => {
    const f = feed({ latest: 100n, answer: 4000_00000000n, publishedAt: (agg) => AT - 60 - Number(100n - agg) * 1200 });
    const v = await valueAtRoundInForce({ asset: NATIVE_ASSET, amountRaw: "1000000000000000000", at: AT, reads: reads(f) });
    assert.equal(v.status === "candidate" && v.boundary, "latest-round");
  });

  it("a memecoin has no V1 at all — only the never-bookable V2", async () => {
    const v = await valueAtRoundInForce({ asset: PEPE, amountRaw: "1", at: AT, reads: reads(inForce(1n)) });
    assert.equal(v.status, "unavailable");
    assert.match(v.why, /never bookable/);
  });

  it("a weekend-stale stock round is refused rather than used", async () => {
    // Round 99 is 60 hours old at the movement: the feed was closed.
    const f = feed({ latest: 100n, answer: 250_00000000n, publishedAt: (agg) => (agg === 100n ? AT + 600 : AT - 60 * 3600 - Number(99n - agg) * 1200) });
    const v = await valueAtRoundInForce({ asset: TSLA.address, amountRaw: "1", at: AT, reads: reads(f) });
    assert.equal(v.status, "unavailable");
    assert.match(v.why, /60h old/);
  });

  it("a successor that cannot be read cannot prove the round was still in force", async () => {
    // Round 100 is the latest and reads fine as latest; getRoundData(100)
    // refuses. The search finds 99, and nothing proves 99 still governed AT.
    const base = inForce(250_00000000n);
    const v = await valueAtRoundInForce({
      asset: NATIVE_ASSET,
      amountRaw: "1000000000000000000",
      at: AT,
      reads: { ...reads(base), round: async (f, id) => ((id & ((1n << 64n) - 1n)) === 100n ? null : base.round(f, id)) },
    });
    assert.equal(v.status, "unavailable");
    assert.match(v.why, /could not prove/);
  });

  it("an unread block time, an unread latest round and an unread multiplier are each their own refusal", async () => {
    const noTime = await valueAtRoundInForce({ asset: NATIVE_ASSET, amountRaw: "1", at: undefined, reads: reads(inForce(1n)) });
    assert.match(noTime.why, /block time/);
    const noLatest = await valueAtRoundInForce({
      asset: NATIVE_ASSET, amountRaw: "1", at: AT,
      reads: { latestRound: async () => null, round: async () => null, uiMultiplier: async () => null },
    });
    assert.match(noLatest.why, /latest round/);
    const noMultiplier = await valueAtRoundInForce({ asset: TSLA.address, amountRaw: "1", at: AT, reads: reads(inForce(1n), null) });
    assert.match(noMultiplier.why, /multiplier/);
  });
});

describe("V2 — the equity step, never bookable", () => {
  const mark = (at: number, equityUsdg: number, extra: Partial<EquityMark> = {}): EquityMark => ({ at, equityUsdg, epoch: 1, mode: "live", ...extra });

  it("is the last mark before against the first after, and says it is never bookable", () => {
    const v = equityStepEstimate([mark(AT - 900, 4000), mark(AT - 300, 5000), mark(AT + 300, 1750), mark(AT + 900, 1700)], AT);
    assert.equal(v.label, "estimate, never bookable");
    assert.equal(v.bookable, false);
    assert.equal(v.status, "estimate");
    if (v.status !== "estimate") return;
    assert.equal(v.stepUsdg, -3250);
    assert.equal(v.intervalSec, 600);
    assert.equal(v.sameEpoch, true);
    assert.match(v.why, /circular/);
  });

  it("ignores paper marks and marks at the movement's own second", () => {
    const v = equityStepEstimate([mark(AT - 300, 5000), mark(AT, 9999), mark(AT + 100, 1000, { mode: "paper" }), mark(AT + 300, 1750)], AT);
    assert.equal(v.status === "estimate" && v.stepUsdg, -3250);
  });

  it("says when an epoch carry sits inside the step", () => {
    const v = equityStepEstimate([mark(AT - 300, 5000, { epoch: 1 }), mark(AT + 300, 1750, { epoch: 2 })], AT);
    assert.equal(v.status === "estimate" && v.sameEpoch, false);
    assert.match(v.why, /different epochs/);
  });

  it("with a side missing, there is no estimate — and still no bookable flag anywhere", () => {
    for (const v of [equityStepEstimate([mark(AT + 300, 1)], AT), equityStepEstimate([mark(AT - 300, 1)], AT), equityStepEstimate([], undefined)]) {
      assert.equal(v.status, "unavailable");
      assert.equal(v.bookable, false);
      assert.equal(v.label, "estimate, never bookable");
    }
  });
});

describe("the read-only transport", () => {
  it("refuses anything off the read allowlist before a request leaves the process", async () => {
    let fetched = 0;
    const rpc = createReadOnlyRpc("https://rpc.example", (async () => {
      fetched++;
      return new Response("{}");
    }) as typeof fetch);
    for (const m of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "personal_sign", "debug_traceTransaction"]) {
      await assert.rejects(rpc(m, []), /rpc-method-outside-read-allowlist/);
    }
    assert.equal(fetched, 0);
    assert.ok(!RPC_METHODS.some((m) => /send|sign/i.test(m)));
  });

  it("returns a result only from a matching JSON-RPC envelope, and never echoes the node's words", async () => {
    const respond = (body: unknown, status = 200) =>
      createReadOnlyRpc("https://user:secret@rpc.example/key", (async () => new Response(JSON.stringify(body), { status })) as typeof fetch);
    assert.equal(await respond({ jsonrpc: "2.0", id: 1, result: "0x1237" })("eth_chainId", []), "0x1237");
    await assert.rejects(respond({ jsonrpc: "2.0", id: 9, result: "0x1" })("eth_chainId", []), /^Error: rpc-read-failed$/);
    await assert.rejects(
      respond({ jsonrpc: "2.0", id: 1, error: { message: "bad key https://user:secret@rpc.example/key" } })("eth_chainId", []),
      (e: Error) => e.message === "rpc-read-failed" && !e.message.includes("secret"),
    );
    // The two refusals the scanner's backoff must still recognise.
    await assert.rejects(respond({}, 429)("eth_getLogs", []), /429/);
    await assert.rejects(respond({ jsonrpc: "2.0", id: 1, error: { message: "logs matched by query exceeds limit of 10000" } })("eth_getLogs", []), /exceeds limit/);
  });

  it("refuses a non-http URL", () => {
    assert.throws(() => createReadOnlyRpc("file:///etc/passwd"), /unsupported-rpc-url/);
  });
});
