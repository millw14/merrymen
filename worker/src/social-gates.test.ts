/**
 * WHAT MAY NOT BECOME A POST — the four gates, each with the failure it exists
 * to prevent, and each pinned on behaviour rather than on source text.
 *
 *   1. A refused, dropped, reverted or pending class decision is not social
 *      content. It stays in the ledger; it does not reach the feed.
 *   2. The social writer never runs for a trade that did not land.
 *   3. An owner remedy — "re-sign to raise it", "add funds", "change the mode in
 *      Settings" — goes to the owner and never to the public row.
 *   4. A historical class row with nothing recorded publishes NOTHING it does
 *      not have: no invented reason, no invented post, no invented ticker.
 *
 * Every one of these was found live, not imagined. The class-route refusal
 * shape is the 27-row template failure measured from the real feed; the
 * remedies are quoted from the live feed as of 2026-09-17; and the historical
 * rows are the two canaries' actual round trips, which have no evidence column
 * because it did not exist when they were written.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { publishableThesis, TRADED_ONLY_SOURCES, type ThesisRow } from "./thesis-policy";
import { postableStatus } from "./social-post";
import { renderWhy, type Why } from "./strategies/reasons";

const classRow = (over: Partial<ThesisRow> = {}): ThesisRow => ({
  name: "Shogun",
  slug: "0123456789abcdef",
  source: "class-route",
  action: "buy",
  symbol: "MOON",
  size_usdg: 5,
  reason: "taking 5.00 USDG of MOON — early on the curve",
  status: "landed",
  said: 1,
  last_at: 1_700_000_000,
  first_at: 1_700_000_000,
  mode: "live",
  ...over,
});

describe("1. a class decision that did not land is not a post", () => {
  it("publishes a landed one", () => {
    assert.ok(publishableThesis(classRow()) !== null);
  });

  it("drops a refusal by the wall", () => {
    // THE 27-ROW SHAPE. Entries re-propose every tick with a fresh row, and the
    // deterministic sentence shifts a little as the tape moves, so the feed's
    // GROUP BY does not collapse them — every refused tick would be its own post.
    const t = publishableThesis(classRow({ status: "rejected", reject_rule: "drawdown-breaker" }));
    assert.equal(t, null, "a refused class trade must not publish");
  });

  it("drops a proposal dropped before the wall", () => {
    assert.equal(publishableThesis(classRow({ status: null, dropped_rule: "#0 MOON: too thin" })), null);
  });

  it("drops one that reverted on-chain", () => {
    assert.equal(publishableThesis(classRow({ status: "reverted" })), null);
  });

  it("drops one still pending", () => {
    assert.equal(publishableThesis(classRow({ status: "submitted" })), null);
    assert.equal(publishableThesis(classRow({ status: null })), null);
  });

  it("does NOT apply the rule to the strategist, whose refusals are its thesis", () => {
    // "I wanted to buy X because Y and the wall said no" is the model's real view
    // with an honest badge on it. The rule is per-source and this is the proof
    // it did not leak sideways.
    const t = publishableThesis(
      classRow({ source: "strategist", status: "rejected", reject_rule: "per-trade-cap", reason: "Depth cleared the floor." }),
    );
    assert.ok(t !== null, "a strategist refusal still publishes");
    assert.equal(t.outcome, "refused");
  });

  it("names exactly the sources it governs", () => {
    assert.deepEqual([...TRADED_ONLY_SOURCES], ["class-route"]);
  });
});

describe("2. the writer only runs for money that moved", () => {
  it("admits a landed fill and a paper fill", () => {
    assert.equal(postableStatus("landed"), true);
    assert.equal(postableStatus("paper"), true);
  });

  it("refuses everything else, including the absence of a status", () => {
    for (const s of ["rejected", "reverted", "submitted", "pending", "", null, undefined]) {
      assert.equal(postableStatus(s), false, `status ${String(s)} must not reach the writer`);
    }
  });
});

describe("3. owner remedies stay with the owner", () => {
  const remedy = /re-sign|add funds|lower the size|in settings|at \/grant|change the mode/i;

  const cases: Why[] = [
    { code: "under-one-buy", cashRaw: 23_660_000n, needRaw: 25_000_000n, vaultRaw: 0n },
    { code: "budget-spent", capRaw: 25_000_000n },
    { code: "keel-top", symbol: "AAPL", underRaw: 270_000n, capped: true },
    { code: "keel-seed", usdgRaw: 8_330_000n, legs: 3, capped: true },
    { code: "dip", symbol: "NVDA", dipBps: 240, priced: 4, usdgRaw: 5_000_000n, capped: true },
  ];

  it("the owner register carries the remedy", () => {
    // The other half of the proof. If the owner copy ever lost the remedy too,
    // this feature would have silenced the one reader who can act on it.
    for (const w of cases) assert.match(renderWhy(w, "owner"), remedy, `owner copy of ${w.code} lost its remedy`);
  });

  it("the public register does not", () => {
    for (const w of cases) {
      const s = renderWhy(w, "public");
      assert.doesNotMatch(s, remedy, `a remedy reached the public row for ${w.code}: "${s}"`);
      assert.ok(s.length > 20, `public copy of ${w.code} must still say something: "${s}"`);
    }
  });

  it("the default register is the owner's, so no existing call site changed", () => {
    for (const w of cases) assert.equal(renderWhy(w), renderWhy(w, "owner"));
  });

  it("the two registers agree on the fact and differ only in the advice", () => {
    // The public sentence is a PREFIX of the owner sentence in spirit: the same
    // fact, minus the instruction. Asserted loosely — the public copy's first
    // clause appears verbatim in the owner copy — so a rewrite that changed
    // the FACT between registers is caught, not just one that dropped it.
    for (const w of cases) {
      const pub = renderWhy(w, "public");
      const own = renderWhy(w, "owner");
      const firstClause = pub.split(/[—.,]/)[0]!.trim();
      // Less the book's own figures, which the public copy never carries
      // (reasons.ts, the public register): "AAPL is 0.27 USDG under" and
      // "AAPL is under" state the same fact.
      const fact = own.replace(/ ?-?[\d,]+\.\d{2}(?: USDG)?/g, "");
      assert.ok(fact.includes(firstClause), `${w.code}: registers disagree on the fact — "${firstClause}" not in owner copy`);
    }
  });
});

describe("4. a historical class row publishes only what it has", () => {
  /**
   * THE TWO CANARIES' ACTUAL ROUND TRIPS. Written before `evidence_json`
   * existed and before the producer threaded a reason or a symbol, so the row
   * is: source class-route, action sell, size, status landed — and nothing
   * else. The owner's instruction is that these are NOT backfilled: a reason
   * invented after the fact for a trade whose evidence was never recorded is the
   * one thing this feature must never do.
   */
  const historical = classRow({ symbol: null, reason: null, post: null, action: "sell", size_usdg: 3.6 });

  it("stays in the owner's ledger when no thesis was recorded", () => {
    assert.equal(publishableThesis(historical), null, "a fill alone is not a public thesis");
    assert.equal(publishableThesis({ ...historical, mode: "paper", status: "paper" }), null);
  });

  it("never backfills the historical record, while admitting a separately recorded substantive post", () => {
    const before = { ...historical };
    assert.equal(publishableThesis(historical), null);
    assert.deepEqual(historical, before, "publication must not invent a ticker, reason or post in the owner record");
    const body = "Buyer breadth narrowed while depth held; broader buying would improve my view.";
    const withPost = publishableThesis(classRow({ reason: null, post: body }))!;
    assert.ok(withPost);
    assert.equal(withPost.reason, null);
    assert.equal(withPost.post, body);
    assert.equal(withPost.outcome, "landed");
  });
});
