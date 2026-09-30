/** Operational idle notices stay in the owner's record; observed market views
 * reach the feed. Both may describe a tick with no trade, but only one offers
 * reasoning a peer can compare with its own evidence. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { publicationSourceFor, publishableThesis, PUBLISHABLE_SOURCES } from "./thesis-policy";
import { marketReview } from "./market-review";
import { idleNotice, idleViewRow } from "./idle-notice";
import { renderWhy, type Why } from "./strategies/reasons";

/** The row the worker now writes when a deterministic strategy sits a tick out. */
const idleRow = (over: Record<string, unknown> = {}) => ({
  name: "Little John",
  x_handle: "millw14",
  agent_id: "0xagent",
  slug: "abc23456789defgh",
  source: "strategy:steady-basket",
  action: null,
  symbol: null,
  size_usdg: null,
  reason:
    "nothing bought — all 3 legs' price feeds are stale, so there is no reference price to " +
    "buy against. This is a fact about the feeds, not about the market",
  dropped_rule: null,
  status: null,
  reject_rule: null,
  mode: "live",
  said: 4,
  last_at: 1_788_800_000,
  first_at: 1_788_700_000,
  ...over,
});

const reviewRow = () => idleRow({
  source: "market-review",
  ...marketReview({ symbol: "NVDA", priceUsd: 100, stale: false, at: 1_788_800_000 }, null, [{at: 1_788_796_400, priceUsd: 99}, {at: 1_788_798_200, priceUsd: 101}, {at: 1_788_799_900, priceUsd: 100}])!,
});

describe("a public view needs market reasoning, not an idle notice", () => {
  it("keeps the idle notice out of the feed without changing the owner's record", () => {
    const row = idleRow();
    const before = { ...row };
    assert.equal(publishableThesis(row), null);
    assert.deepEqual(row, before);
    assert.match(row.reason, /all 3 legs' price feeds are stale/);
  });

  it("publishes a grounded quiet-market review as a view, in one observed line", () => {
    // Filed under `market-review`, which quietReview does only when the review
    // CHANGED (see market-review.test.ts); an unchanged one goes to an
    // unclassified source and never reaches this gate as publishable.
    const post = publishableThesis(reviewRow())!;
    assert.ok(post);
    assert.equal(post.outcome, "view");
    assert.equal(post.action, "hold");
    assert.equal(post.symbol, "NVDA");
    assert.equal(post.shadow, false, "a real agent really decided this");
    assert.equal(post.reason, "NVDA +1.0% over 1h, at its mean.");
  });

  it("classifies both strategy reasoning and deterministic market reviews", () => {
    for (const source of ["strategy:steady-basket", "market-review"]) {
      assert.ok((PUBLISHABLE_SOURCES as readonly string[]).includes(source), `${source} must be classified`);
    }
  });

  it("applies the content boundary to every deterministic strategy", () => {
    for (const name of ["steady-basket", "weekend-gap", "even-keel", "dip-hunter", "trencher"]) {
      assert.equal(publishableThesis(idleRow({ source: `strategy:${name}` })), null, `${name}: operational notice must stay private`);
      const post = publishableThesis(idleRow({ source: `strategy:${name}`, reason: "Depth remains thin; I am holding until liquidity recovers." }));
      assert.ok(post, `${name}: an actual market view still publishes`);
      assert.equal(post.outcome, "view");
    }
  });

  it("but an UNCLASSIFIED source still publishes nothing", () => {
    // The gate is a whitelist and fails closed. This change must not have
    // widened it.
    assert.equal(publishableThesis({ ...reviewRow(), source: "strategy:something-new" }), null);
    assert.equal(publishableThesis({ ...reviewRow(), source: "chat" }), null);
  });

  it("and an unslugged agent still gets a post, just an unlinked one", () => {
    // A missing link is a smaller loss than a missing thesis — thesis-policy
    // says so — and it is also what makes the post unlikeable, which is right.
    assert.equal(publishableThesis(idleRow({ slug: null })), null);
    const post = publishableThesis({ ...reviewRow(), slug: null });
    assert.ok(post);
    assert.equal(post.slug, null);
  });
});

describe("how often it is written", () => {
  // Executed through idle-notice.ts, which decides what the tick's idle block
  // writes. These were source greps over index.ts; they pinned the same rules.
  const underOne: Why = { code: "under-one-buy", cashRaw: 1_000_000n, needRaw: 5_000_000n, vaultRaw: 0n };

  it("ONCE PER CHANGE, NOT ONCE PER TICK — the view and the event together", () => {
    // renderWhy is deterministic, so an unchanged reason would write an
    // identical row every 240 seconds. read-theses would still group them into
    // ONE post — `reason` is part of its key — but the ledger would carry
    // ~12,000 rows a day saying the same sentence, and this repo already has
    // the incident where 1,242 identical rows told nobody anything.
    const first = idleNotice({ idle: underOne, modeEmptied: null, last: null });
    assert.ok(first.event, "the owner is told");
    assert.ok(first.view, "beside the event, not instead of it");
    const again = idleNotice({ idle: underOne, modeEmptied: null, last: first.last });
    assert.equal(again.event, null);
    assert.equal(again.view, null, "the row is written only on a change");
  });

  it("and it carries the strategy's own source and words", () => {
    const n = idleNotice({ idle: underOne, modeEmptied: null, last: null });
    // THE PUBLIC REGISTER of the same Why. Still the strategy's own words —
    // renderWhy(idle, "public") — minus the remedy clause, which is advice for
    // the owner and was going out on a public feed ("Add funds or lower the
    // size per trade" was live for weeks). The event keeps the owner's copy.
    assert.equal(n.view, renderWhy(underOne, "public"));
    assert.match(n.event!.message, /Add funds or lower the size per trade/);
    assert.doesNotMatch(n.view!, /Add funds/);
    const row = idleViewRow({ id: "d1", agentId: "0xagent", strategyName: "llm-strategist(anthropic:claude-opus-4)", reason: n.view! });
    // Through the helper, not the template. The template spelled the source
    // `strategy:llm-strategist(anthropic:claude-opus-4)` for the strategist —
    // a key SOURCE_POLICY has never contained — so this very sentence, the one
    // written to prove the agent was thinking rather than idle, published
    // nothing at all. See strategist-publish.test.ts.
    assert.equal(row.source, publicationSourceFor("llm-strategist(anthropic:claude-opus-4)"));
    assert.equal(row.source, "strategy:llm-strategist", "the engine suffix never reaches the key");
    const basket = idleViewRow({ id: "d2", agentId: "0xagent", strategyName: "steady-basket", reason: "x" });
    assert.ok((PUBLISHABLE_SOURCES as readonly string[]).includes(basket.source), basket.source);
    // No action, no symbol, no size — that absence is what makes it a view,
    // and `outcomeOf` is what turns the absence into the word.
    assert.deepEqual(Object.keys(row).sort(), ["agent_id", "id", "reason", "source"]);
  });
});
