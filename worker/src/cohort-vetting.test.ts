/**
 * PICKING A COHORT FROM BALANCES IS HOW YOU LEARN NOTHING.
 *
 * The first shadow cohort was one agent, and it spent a day producing forced
 * holds: its book could not be sized, so every model call bought an outcome
 * that was decided before the analysts ran. An agent with capital and no
 * evidenced contributions is exactly that trap, and it looks like a good
 * candidate from the outside.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STOCK_TOKENS } from "../../packages/core/src/index";
import { cohortLines, vetCandidate, type CandidateInput, type CandidatePosition } from "./cohort-vetting";

const NOW = 1_788_600_000;
const EQUITY_TOKEN = STOCK_TOKENS.find((t) => t.kind === "stock")!;
const POOL_TOKEN = "0x1111111111111111111111111111111111111111";

const pos = (over: Partial<CandidatePosition> = {}): CandidatePosition => ({
  symbol: EQUITY_TOKEN.symbol,
  token: EQUITY_TOKEN.address,
  valueUsdg: 6.5,
  priceStale: false,
  priceSource: "chainlink",
  updatedAt: NOW - 60,
  ...over,
});

const cand = (over: Partial<CandidateInput> = {}): CandidateInput => ({
  account: "0xabcdef0123456789",
  name: "Much",
  epoch: 1,
  mode: "live",
  beatAt: NOW - 30,
  netContributionsUsdg: 10,
  legacyRows: 0,
  positions: [pos()],
  lastEquityPositionsUsdg: 6.5,
  landedTrades: 4,
  decisions: 12,
  ...over,
});

describe("a candidate has to clear the gate before it is worth a model call", () => {
  it("accepts a live, funded, freshly-priced agent", () => {
    const v = vetCandidate(cand(), NOW);
    assert.equal(v.verdict, "READY");
    assert.equal(v.focus!.symbol, EQUITY_TOKEN.symbol);
    assert.equal(v.focusClass, "equity-token");
  });

  it("rejects capital with no evidenced contributions — the trap", () => {
    // The whole reason this module exists. Money in the account, nothing on
    // record about where it came from, so `computePnl` refuses, `may_size` is
    // false, and every decision is a forced hold decided before the analysts ran.
    const v = vetCandidate(cand({ netContributionsUsdg: 0 }), NOW);
    assert.equal(v.verdict, "BLOCKED-NO-CAPITAL");
    assert.match(v.why, /nothing can be sized against it/);
  });

  it("tells a zero we measured from a question we failed to ask", () => {
    assert.equal(vetCandidate(cand({ netContributionsUsdg: null }), NOW).verdict, "BLOCKED-CONTRIBUTIONS-UNKNOWN");
  });

  it("rejects a book holding pre-cutover rows", () => {
    assert.equal(vetCandidate(cand({ legacyRows: 3 }), NOW).verdict, "BLOCKED-LEGACY-HISTORY");
  });

  it("rejects an agent that is not running", () => {
    assert.equal(vetCandidate(cand({ beatAt: NOW - 4000 }), NOW).verdict, "BLOCKED-IDLE");
    assert.equal(vetCandidate(cand({ beatAt: null }), NOW).verdict, "BLOCKED-IDLE");
  });

  it("tells an empty book from one the mirror has not repopulated yet", () => {
    // The mirror REPLACES positions per agent — DELETE then INSERT — so between
    // a child restarting and its first tick, shared Postgres holds zero rows
    // for an agent that plainly has holdings. This report runs at orchestrator
    // startup, which is exactly that window: its first live run said the canary
    // held nothing while it held 6.26 USDG of TSLA.
    const v = vetCandidate(cand({ positions: [], lastEquityPositionsUsdg: 6.26 }), NOW);
    assert.equal(v.verdict, "UNKNOWN-POSITIONS-NOT-MIRRORED");
    assert.match(v.why, /ask again after a tick/);
  });

  it("an empty book is now a CANDIDATE question, not a rejection", () => {
    assert.equal(vetCandidate(cand({ positions: [], lastEquityPositionsUsdg: 0 }), NOW).verdict, "READY-CANDIDATE-ONLY");
    assert.equal(
      vetCandidate(cand({ positions: [pos({ valueUsdg: 0 })], lastEquityPositionsUsdg: 0 }), NOW).verdict,
      "READY-CANDIDATE-ONLY",
    );
  });

  it("checks the reasons in the order they actually bite", () => {
    // An idle agent with unknown contributions and a legacy history reports
    // IDLE: nothing else matters if nothing runs, and reporting the wrong one
    // sends whoever reads it to the wrong place.
    const v = vetCandidate(cand({ beatAt: null, netContributionsUsdg: null, legacyRows: 5 }), NOW);
    assert.equal(v.verdict, "BLOCKED-IDLE");
  });
});

describe("a stale price means two different things", () => {
  it("a shut equity market is NOT a blocked agent", () => {
    // TSLA on a 24/5 Chainlink feed, outside US market hours. The agent is
    // sound and the only thing missing is trading hours — collapsing this into
    // "blocked" would exclude every tokenised equity permanently, which is most
    // of the fleet.
    const v = vetCandidate(cand({ positions: [pos({ priceStale: true })] }), NOW);
    assert.equal(v.verdict, "READY-WHEN-MARKET-OPENS");
    assert.equal(v.focusIsContinuous, false);
    assert.match(v.why, /sound agent, wrong hour/);
  });

  it("does NOT read a pool row's stale flag, because it is a hardcoded literal", () => {
    // Every non-Chainlink source hardcodes `stale: false`, and says why: a TWAP
    // is time-averaged by construction and "flagging it stale would make every
    // memecoin look broken on a weekend for no reason". A rule that read that
    // as "this market is live" would be reading a constant. So even set true it
    // must not decide anything — a pool that stopped being readable loses the
    // POSITION, which the previous check already catches.
    const v = vetCandidate(
      cand({ positions: [pos({ token: POOL_TOKEN, symbol: "PONS", priceSource: "pool", priceStale: true })] }),
      NOW,
    );
    assert.equal(v.verdict, "READY", "judged by the position's presence, not by that flag");
    assert.equal(v.focusIsContinuous, true);
    assert.match(v.why, /removed the position rather than flagged it/);
  });

  it("marks a fresh pool-priced agent as the one that can be observed at any hour", () => {
    const v = vetCandidate(
      cand({ positions: [pos({ token: POOL_TOKEN, symbol: "PONS", priceSource: "pool" })] }),
      NOW,
    );
    assert.equal(v.verdict, "READY");
    assert.equal(v.focusClass, "memecoin");
    assert.equal(v.focusIsContinuous, true);
    assert.match(v.why, /trades around the clock/);
  });
});

describe("the focus is the position a run would actually be about", () => {
  it("is the largest holding, not the first row", () => {
    const v = vetCandidate(
      cand({
        positions: [
          pos({ symbol: "SMALL", valueUsdg: 1 }),
          pos({ symbol: "BIG", valueUsdg: 9 }),
        ],
      }),
      NOW,
    );
    assert.equal(v.focus!.symbol, "BIG");
    assert.equal(v.equityUsdg, 10, "but equity is the whole book");
  });
});

describe("the report says when a cohort cannot be observed after hours", () => {
  it("warns when nothing in the cohort trades continuously", () => {
    const all = [vetCandidate(cand(), NOW), vetCandidate(cand({ account: "0xb" }), NOW)];
    const text = cohortLines(all).join("\n");
    assert.match(text, /2 READY · 0 of those trade 24\/7/);
    assert.match(text, /the cohort will be idle outside market hours/);
  });

  it("does not warn when one of them does", () => {
    const all = [
      vetCandidate(cand(), NOW),
      vetCandidate(cand({ account: "0xb", positions: [pos({ token: POOL_TOKEN, symbol: "PONS" })] }), NOW),
    ];
    const text = cohortLines(all).join("\n");
    assert.match(text, /1 of those trade 24\/7/);
    assert.ok(!/idle outside market hours/.test(text));
  });
});

describe("the report speaks the ledger's units", () => {
  it("renders whole USDG, because that is what the columns hold", () => {
    // `flows.amount_usdg` and `positions.value_usdg` are REAL columns of WHOLE
    // USDG; the tick multiplies by 1e6 on its way into a snapshot. Dividing
    // here made the canary's 10 USDG book render as 0.00 and turned an entire
    // 24-agent cohort report into a page of zeroes.
    const text = cohortLines([vetCandidate(cand({ netContributionsUsdg: 10, positions: [pos({ valueUsdg: 6.5 })] }), NOW)]).join("\n");
    assert.match(text, /equity\s+6\.50/);
    assert.match(text, /contrib\s+10\.00/);
    assert.match(text, /6\.50 USDG/, "and the focus line too");
  });
});

describe("the report actually says why", () => {
  it("renders the reason, not an empty indent", () => {
    // The first live run printed a blank line under every agent. A shell
    // substitution had eaten the template interpolation, so 24 agents were
    // reported with no reason attached — a report that says a verdict and not
    // its evidence is a report nobody can act on.
    const text = cohortLines([vetCandidate(cand({ netContributionsUsdg: 0 }), NOW)]).join("\n");
    assert.match(text, /nothing can be sized against it/);
    assert.ok(!/\n\s+$/.test(text), "no line may be bare indentation");
  });

  it("renders warning text, not a bare marker", () => {
    const text = cohortLines([vetCandidate(cand({ decisions: 0 }), NOW)]).join("\n");
    assert.match(text, /! no decisions on record/);
  });
});
