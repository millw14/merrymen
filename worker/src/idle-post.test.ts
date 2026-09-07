/**
 * AN AGENT THAT DECIDES NOT TO TRADE WAS TALKING TO A TABLE NOBODY READS.
 *
 * A tick that proposes nothing writes its reason to `events` and nothing else,
 * and only `decisions` can become a post. So an agent that looked at the market
 * and concluded "not today, and here is why" produced an empty feed — while its
 * owner watched a screen that said nothing and reported "no trading is being
 * done" and "the agents need to be social, talk a lot".
 *
 * That is not a cadence problem, and raising the tick rate cannot fix it:
 * `read-theses` groups by twelve columns including `reason` and `size_usdg`,
 * both byte-identical tick after tick for a deterministic strategy, so a faster
 * tick only raises `said` on a post that already exists. The missing posts were
 * never being written.
 *
 * A decision with no action is a `view` — a shape this product already carries
 * end to end: thesis-policy classifies it, `outcome: "view"` exists for exactly
 * "a decision the agent made, not a trade that failed to happen", and the feed
 * grew a `view` arm that renders it from the publisher's own words.
 *
 * THIS FILE PROVES THE ROW SURVIVES THE GATE. Writing it is worthless if
 * `publishableThesis` drops it, and the gate fails closed by design — so the
 * question is answered here rather than assumed.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { publishableThesis, PUBLISHABLE_SOURCES } from "./thesis-policy";

const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

const INDEX = codeOf(readFileSync(new URL("./index.ts", import.meta.url), "utf8"));

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

describe("the idle row reaches the feed", () => {
  it("THE GATE ADMITS IT — writing it would be worthless otherwise", () => {
    const post = publishableThesis(idleRow());
    assert.ok(post, "a deterministic strategy's idle reason must be publishable");
    assert.equal(post.reason?.startsWith("nothing bought"), true, "the words survive intact");
  });

  it("and it lands as a VIEW, not as a trade that failed", () => {
    // "view" is a DECISION THE AGENT MADE. Every other outcome would render it
    // as something that went wrong, on the one tick where nothing did.
    const post = publishableThesis(idleRow())!;
    assert.equal(post.outcome, "view");
    assert.equal(post.action, null);
    assert.equal(post.symbol, null);
    assert.equal(post.shadow, false, "a real agent really decided this");
  });

  it("its source is one the policy already classifies", () => {
    // A source nobody has classified publishes NOTHING — not a redacted
    // version, nothing — and that is how a feed goes silent for a week with no
    // error. This reuses the deterministic strategy's own source rather than
    // inventing one.
    assert.ok(
      (PUBLISHABLE_SOURCES as readonly string[]).includes("strategy:steady-basket"),
      "strategy:steady-basket must be a classified source",
    );
  });

  it("EVERY DETERMINISTIC STRATEGY'S IDLE REASON IS COVERED, not just the basket's", () => {
    for (const name of ["steady-basket", "weekend-gap", "even-keel", "dip-hunter", "trencher"]) {
      const post = publishableThesis(idleRow({ source: `strategy:${name}` }));
      assert.ok(post, `strategy:${name} idle reasons must publish`);
      assert.equal(post.outcome, "view");
    }
  });

  it("but an UNCLASSIFIED source still publishes nothing", () => {
    // The gate is a whitelist and fails closed. This change must not have
    // widened it.
    assert.equal(publishableThesis(idleRow({ source: "strategy:something-new" })), null);
    assert.equal(publishableThesis(idleRow({ source: "chat" })), null);
  });

  it("and an unslugged agent still gets a post, just an unlinked one", () => {
    // A missing link is a smaller loss than a missing thesis — thesis-policy
    // says so — and it is also what makes the post unlikeable, which is right.
    const post = publishableThesis(idleRow({ slug: null }));
    assert.ok(post);
    assert.equal(post.slug, null);
  });
});

describe("how often it is written", () => {
  it("ONCE PER CHANGE, NOT ONCE PER TICK", () => {
    // renderWhy is deterministic, so an unchanged reason would write an
    // identical row every 240 seconds. read-theses would still group them into
    // ONE post — `reason` is part of its key — but the ledger would carry
    // ~12,000 rows a day saying the same sentence, and this repo already has
    // the incident where 1,242 identical rows told nobody anything.
    const at = INDEX.indexOf("if (idleNow !== lastIdleReason) {");
    assert.ok(at > 0, "the de-duplication must still gate it");
    const block = INDEX.slice(at, INDEX.indexOf("\n    }", at));
    assert.match(block, /await addDecision\(\{/, "the row is written inside the change gate");
    assert.match(block, /await addEvent\(agentId, "ok", idleNow\)/, "beside the event, not instead of it");
  });

  it("and it carries the strategy's own source and words", () => {
    // Scoped to the IDLE block. `ensureDecision` also calls addDecision — with
    // an action, a symbol and a size, which is correct there and is exactly
    // what this test asserts is absent here, so searching the whole file finds
    // the wrong call and fails on the right code.
    const block = INDEX.indexOf("if (idleNow !== lastIdleReason) {");
    const at = INDEX.indexOf("await addDecision({", block);
    const call = INDEX.slice(at, INDEX.indexOf("});", at) + 3);
    assert.match(call, /source: `strategy:\$\{strategy\.name\}`/);
    assert.match(call, /reason: idleNow/);
    // No action, no symbol, no size — that absence is what makes it a view,
    // and `outcomeOf` is what turns the absence into the word.
    assert.ok(!/\baction:/.test(call), "an idle decision has no action");
    assert.ok(!/\bsymbol:/.test(call), "and names no instrument");
    assert.ok(!/\bsize_usdg:/.test(call), "and no size");
  });
});
