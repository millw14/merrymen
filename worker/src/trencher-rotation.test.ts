/**
 * WHICH COIN GETS THE NEXT REVIEW.
 *
 * A review runs at most every 30s, so with ten eligible coins strict
 * least-recently-reviewed made a given one wait about five minutes for its turn
 * no matter how it looked — the loudest tape on the chain sat behind nine quiet
 * ones because they happened to be older in the queue. Measured 2026-09-20:
 * entries arrived 2m50s to 5m43s after the previous trade, essentially one
 * rotation.
 *
 * The fix orders WITHIN the round-robin pass rather than replacing it, and the
 * two properties below are why. Ranking by volume alone would starve: one coin
 * with a permanently fat tape would take every slot forever, and a position the
 * desk already HOLDS is reviewed through this same path — so a quiet coin it
 * owns could stop being watched.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TrenchBrainReview } from "./trencher-brain";

const coin = (token: string, volume24hUsd?: number) => ({ token, volume24hUsd });

/**
 * Drive one review of whatever `candidate` picks, and report which it was.
 *
 * ASYNC ON PURPOSE. `launch` sets a `pending` flag that is only cleared when
 * its run promise settles, so a synchronous loop launches once and every
 * later call returns early without stamping a sequence — which makes the
 * rotation look starved when it is the harness that never advanced.
 */
const review = async (r: TrenchBrainReview, pool: ReturnType<typeof coin>[]): Promise<string> => {
  const pick = r.candidate(pool);
  assert.ok(pick, "a non-empty pool must always yield a candidate");
  r.launch("ctx", { market: { symbol: "X" } } as never, pick.token, async () => ({ ran: false }) as never, () => {});
  // Let the launch's own promise settle so `pending` clears before the next.
  await new Promise((resolve) => setImmediate(resolve));
  return pick.token;
};

/** A fresh reviewer with its interval defeated, so each call can pick again. */
const reviewer = () => {
  let t = 0;
  return new TrenchBrainReview(() => (t += 60_000));
};

describe("the busiest coin is looked at first", () => {
  it("picks the fat tape over an older quiet one", async () => {
    const r = reviewer();
    const pool = [coin("0xquiet", 1_000), coin("0xbusy", 900_000)];
    assert.equal(await review(r, pool), "0xbusy");
  });

  it("sorts an unknown tape last, not first", async () => {
    // Absent volume is not evidence of a busy market. It must not jump the
    // queue on the strength of a missing field.
    const r = reviewer();
    assert.equal(await review(r, [coin("0xunknown"), coin("0xknown", 5_000)]), "0xknown");
  });
});

describe("nobody is starved", () => {
  it("reviews every coin once before repeating any", async () => {
    // The property that ranking-by-volume alone would break.
    const r = reviewer();
    const pool = [coin("0xa", 10), coin("0xb", 900_000), coin("0xc", 500), coin("0xd", 7_000)];
    const seen = [await review(r, pool), await review(r, pool), await review(r, pool), await review(r, pool)];
    assert.deepEqual([...seen].sort(), ["0xa", "0xb", "0xc", "0xd"], `saw ${seen.join(",")}`);
  });

  it("puts the busiest first WITHIN the pass", async () => {
    const r = reviewer();
    const pool = [coin("0xa", 10), coin("0xb", 900_000), coin("0xc", 500), coin("0xd", 7_000)];
    assert.equal(await review(r, pool), "0xb", "busiest opens the pass");
    assert.equal(await review(r, pool), "0xd", "then the next busiest");
  });

  it("starts a fresh pass once everyone has been seen", async () => {
    const r = reviewer();
    const pool = [coin("0xa", 10), coin("0xb", 900_000)];
    await review(r, pool);
    await review(r, pool);
    // Both are due again; the busiest leads the new pass.
    assert.equal(await review(r, pool), "0xb");
  });

  it("keeps watching a quiet coin the desk may still hold", async () => {
    // A held position is reviewed through this same path. A coin with almost no
    // tape must still come round, or nothing would ever decide to exit it.
    const r = reviewer();
    const pool = [coin("0xheld", 1), coin("0xloud", 5_000_000)];
    const seen = [await review(r, pool), await review(r, pool), await review(r, pool), await review(r, pool)];
    assert.ok(seen.filter((t) => t === "0xheld").length >= 2, `held coin was skipped: ${seen.join(",")}`);
  });
});

describe("the bookkeeping still holds", () => {
  it("returns nothing for an empty pool", async () => {
    assert.equal(reviewer().candidate([]), undefined);
  });

  it("forgets a coin that leaves the eligible set", async () => {
    // Otherwise a delisted coin's sequence would keep skewing the pass floor.
    const r = reviewer();
    await review(r, [coin("0xgone", 5), coin("0xstay", 6)]);
    const only = [coin("0xstay", 6)];
    assert.equal(await review(r, only), "0xstay");
    assert.equal(await review(r, only), "0xstay");
  });

  it("is deterministic when two coins are identical", async () => {
    // The tiebreak must not depend on the order discovery happened to return.
    const pool = [coin("0xa", 100), coin("0xb", 100)];
    assert.equal(await review(reviewer(), pool), await review(reviewer(), pool));
  });
});
