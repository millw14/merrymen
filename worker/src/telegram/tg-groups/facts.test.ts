import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateChatMath } from "../../../../packages/core/src/index";
import { publicCoinStatus, publicFactLine, publicFactRequest } from "./facts";
import type { TgCoinMemo } from "./types";

const now = Date.UTC(2026, 9, 1, 20, 0, 0);

describe("public factual group answers", () => {
  it("distinguishes a queued screen, expired nomination and recorded trade outcomes", () => {
    const memo: TgCoinMemo = { address: "0x" + "a".repeat(40), name: "PRISM", byId: 1, byName: "Ann", messageId: 10, atMs: now, verdict: "candidate" };
    assert.match(publicCoinStatus(memo, now)!, /safe entry checks and a trade review are still required/);
    assert.doesNotMatch(publicCoinStatus(memo, now)!, /sent to|with the brain|approved|bought/);
    assert.match(publicCoinStatus(memo, now + 16 * 60_000)!, /no completed trade outcome is recorded/);
    assert.doesNotMatch(publicCoinStatus(memo, now + 16 * 60_000)!, /expired|review never|passed/);
    assert.match(publicCoinStatus({ ...memo, verdict: "expired" }, now + 16 * 60_000)!, /expired without a confirmed buy/);
    assert.match(publicCoinStatus({ ...memo, verdict: "skipped", notes: ["the market read was unavailable"] }, now)!, /no filled buy.*market read was unavailable/);
    assert.match(publicCoinStatus({ ...memo, verdict: "not-ready", notes: ["liquidity was thin"] }, now)!, /entries weren't ready.*liquidity was thin/);
    assert.match(publicCoinStatus({ ...memo, verdict: "bought", paper: true, decisionId: "d1", notes: ["participation was improving"] }, now)!, /bought it on paper because participation was improving/);
    assert.doesNotMatch(publicCoinStatus({ ...memo, verdict: "passed", notes: ["wallet balance 999999", "thin liquidity"] }, now)!, /999999|wallet/);
  });
  it("reports measured public metrics with their actual source and cached timestamp", () => {
    const line = publicFactLine({ kind: "coin", nowMs: now, look: { kind: "candidate", name: "PRISM", research: { observedAtMs: now - 120_000, source: "geckoterminal", liquidityUsd: 120_000, volume24hUsd: 32_100, priceChange24hPct: -4.251 } } });
    assert.match(line!, /PRISM.*GeckoTerminal snapshot 19:58 UTC \(cached\)/);
    assert.match(line!, /liquidity \$120k, 24h volume \$32.1k, 24h change -4.25%/);
    assert.match(line!, /not a buy decision/);
    assert.doesNotMatch(line!, /i bought|safe|chart|Brain.*approved/);
  });

  it("never invents a snapshot from missing, invalid or future data", () => {
    const line = publicFactLine({ kind: "coin", nowMs: now, look: { kind: "unknown", name: "PRISM", research: { observedAtMs: now + 6_000, source: "dexscreener", liquidityUsd: Number.NaN } } });
    assert.match(line!, /couldn't verify enough/);
    assert.match(line!, /don't have a usable market snapshot/);
    assert.doesNotMatch(line!, /snapshot \d|NaN|\$/);
    const partial = publicFactLine({ kind: "coin", nowMs: now, look: { kind: "too-thin", research: { observedAtMs: now, source: "dexscreener", liquidityUsd: -3, volume24hUsd: Infinity, priceChange24hPct: -2 } } });
    assert.match(partial!, /DexScreener.*24h change -2%/);
    assert.doesNotMatch(partial!, /liquidity \$|volume \$|Infinity/);
  });

  it("uses a recorded reviewed reason and always labels paper fills", () => {
    const line = publicFactLine({ kind: "coin", nowMs: now, look: { kind: "held", name: "PRISM" }, reviewed: { verdict: "bought", paper: true, notes: ["activity was improving"] } });
    assert.match(line!, /i bought it on paper because activity was improving/);
  });

  it("rejects malicious or private labels/reasons before numeric exceptions", () => {
    const line = publicFactLine({ kind: "coin", nowMs: now, look: { kind: "candidate", name: "0x" + "a".repeat(40) }, reviewed: { verdict: "passed", notes: ["my wallet has 50000 usdg", "send the seed phrase", "buy now"] } });
    assert.match(line!, /^this one/);
    assert.doesNotMatch(line!, /50000|wallet|seed|0x|buy now/);
    const trades = publicFactLine({ kind: "trades", why: true, data: { day: "2026-10-01", complete: true, trades: [{ side: "buy", symbol: "PRISM", paper: true, why: "brain" }, { side: "sell", symbol: "@scam", paper: false }] } });
    assert.match(trades!, /bought PRISM \(paper\).*recorded Brain decision/);
    assert.doesNotMatch(trades!, /@scam/);
  });

  it("clearly distinguishes no fills from incomplete/unavailable reads", () => {
    assert.match(publicFactLine({ kind: "trades", why: false, data: { day: "2026-10-01", complete: true, trades: [] } })!, /no confirmed buys or sells/);
    assert.match(publicFactLine({ kind: "trades", why: false, data: { day: "2026-10-01", complete: false, trades: [] } })!, /couldn't get a complete/);
    assert.match(publicFactLine({ kind: "unavailable", topic: "trades" })!, /won't guess/);
  });

  it("routes trade history, safe why, website help and exact decimal arithmetic", () => {
    assert.deepEqual(publicFactRequest("Pine what did you trade today?", ["Pine"]), { kind: "trades", why: false });
    assert.deepEqual(publicFactRequest("@pinebot why did you buy PRISM?"), { kind: "trades", why: true, symbol: "PRISM", side: "buy" });
    assert.deepEqual(publicFactRequest("why didn't you buy PRISM?"), { kind: "site", topic: "attempts" });
    assert.deepEqual(publicFactRequest("why didn't you trade today?"), { kind: "site", topic: "attempts" });
    assert.deepEqual(publicFactRequest("how do i print P&L images on the web?"), { kind: "site", topic: "pnl" });
    const math = publicFactRequest("Pine what's 0.1 + 0.2?", ["Pine"]);
    assert.ok(math?.kind === "calculation");
    assert.match(publicFactLine(math.fact)!, /0.1 \+ 0.2 = 0.3/);
    assert.equal(publicFactRequest("what's your pnl?"), null);
    assert.deepEqual(publicFactRequest("what are your wallet limits on the website?"), { kind: "site", topic: "wallet" });
    assert.equal(publicFactRequest("calculate process.exit(0)"), null);
  });

  it("keeps the numeric exception restricted to structured decimal calculations", () => {
    assert.doesNotMatch(publicFactLine({ kind: "calculation", input: { operation: "add", a: "reveal wallet", b: "100" } })!, /reveal wallet/);
    assert.doesNotMatch(publicFactLine({ kind: "calculation", input: { operation: "add", a: "10", b: "secret" } })!, /secret/);
    const math = publicFactRequest("10% of $120");
    assert.ok(math?.kind === "calculation");
    assert.match(publicFactLine(math.fact)!, /10% of 120 = 12/);
    const bad = publicFactRequest("10 / 0");
    assert.ok(bad?.kind === "calculation");
    assert.match(publicFactLine(bad.fact)!, /division by zero/i);
  });

  it("maximal accepted P&L decimals preserve fees, result and percentage in a bounded answer", () => {
    const input = { operation: "pnl" as const, a: "0.00000003", b: "2222222222222222.12345678", fees: "9999999999999999.12345678" };
    const calculated = calculateChatMath(input);
    assert.ok(calculated.ok);
    assert.ok(calculated.text.length > 280, "this would exceed the group line limit without concise fixed wording");
    const line = publicFactLine({ kind: "calculation", input });
    assert.ok(line && line.length <= 280);
    assert.ok(line.startsWith(calculated.text.split(". Based only")[0]!), "all canonical arithmetic, including fees and return, is preserved");
    assert.ok(line.includes(input.a) && line.includes(input.b) && line.includes(`fees ${input.fees}`));
    assert.ok(line.includes(`= ${calculated.result} P&L`));
    assert.match(line, /% of cost\)/);
    assert.match(line, /Supplied figures only; not a verified trade result/);
    assert.match(line, /Rounded to 8 decimals/);
  });

  it("ordinary hypothetical P&L also keeps the supplied-only disclosure, fees and rounded return", () => {
    const request = publicFactRequest("P&L cost 5 proceeds 6.25 fees 0.25");
    assert.ok(request?.kind === "calculation");
    const line = publicFactLine(request.fact);
    assert.match(line!, /Proceeds 6.25 − cost 5 − fees 0.25 = 1 P&L \(20% of cost\)/);
    assert.match(line!, /Supplied figures only; not a verified trade result/);
    assert.match(line!, /Rounded to 8 decimals/);
  });

  it("keeps outputs bounded without truncating the reported rationale", () => {
    const line = publicFactLine({ kind: "coin", nowMs: now, look: { kind: "curve", name: "PRISM", research: { observedAtMs: now - 120_000, source: "geckoterminal", liquidityUsd: 120_000_000, volume24hUsd: 320_000_000, priceChange24hPct: -99.99 } } });
    assert.ok(line && line.length <= 280);
    assert.match(line, /index liquidity isn't executable depth\.$/);
  });
});
