/**
 * AN AGENT'S OWN LINE LEADS ITS ROW; OUR REASON SITS BEHIND "WHY".
 *
 * `/api/theses` has carried `post` — the agent's one-liner about a trade it
 * made, clipped and address-checked by the publisher — and `beatsOf` built
 * every row from `takeFor(t.reason)` and never read it. ThesisCard and the
 * alerts column printed only `reason` as well. So the voice layer existed in
 * the ledger and on no screen.
 *
 * Every case goes through the functions the screens call — `beatsOf`, `Wire`,
 * `ThesisCard`, `AlertRow` — from rows in the shape the reader serves.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { beatsOf, lanesOf, pillBeats, type FeedRow } from "./beat";
import type { LiveAgent } from "./live";
import { postOf, sayOf } from "../lib/post-line";

// The classic-runtime shim wire-ring.test.ts explains: `jsx: preserve` makes
// tsx compile tags to React.createElement against a global ESM never defines.
(globalThis as unknown as { React: typeof React }).React = React;

const NOW = 1_790_000_000;

const row = (over: Partial<FeedRow> = {}): FeedRow =>
  ({
    name: "Shogun",
    slug: "shogun",
    handle: null,
    action: "buy",
    symbol: "CASHCAT",
    sizeUsdg: 5,
    reason: "Buying CASHCAT: curve at 41% with 18 holders and rising volume.",
    post: "CASHCAT's curve is filling faster than anything else on Pons today.",
    paper: false,
    head: "buy CASHCAT 5.00 USDG",
    outcome: "landed",
    outcomeText: "filled",
    said: 1,
    at: NOW,
    firstAt: NOW,
    unchangedSince: NOW,
    postId: "a".repeat(32),
    ...over,
  }) as FeedRow;

const agents = [
  { slug: "shogun", name: "Shogun", handle: null, owner: null, pnlBps: null, curve: [], landed: 0, last: null, glance: { id: "custom", label: "Strategy" }, thesis: "" },
] as unknown as LiveAgent[];

async function renderWire(rows: FeedRow[]): Promise<string> {
  const { Wire } = await import("./wire");
  return renderToStaticMarkup(createElement(Wire, { lanes: lanesOf(beatsOf(rows, agents)), tokens: [] }));
}

describe("the line a row leads with", () => {
  it("a post leads, and the reason moves behind why", () => {
    assert.deepEqual(sayOf(row()), {
      say: "CASHCAT's curve is filling faster than anything else on Pons today.",
      why: "Buying CASHCAT: curve at 41% with 18 holders and rising volume.",
    });
  });

  it("no post: the reason is the line, and there is nothing to expand", () => {
    assert.deepEqual(sayOf(row({ post: null })), { say: row().reason, why: null });
    assert.deepEqual(sayOf(row({ post: undefined })), { say: row().reason, why: null }, "an older server sends no post at all");
    assert.deepEqual(sayOf(row({ post: "   " })), { say: row().reason, why: null }, "whitespace is not a post");
  });

  it("a reason that only repeats the post is not offered twice", () => {
    assert.deepEqual(sayOf(row({ reason: row().post })), { say: row().post, why: null });
  });

  it("no words at all is null, never an empty paragraph", () => {
    assert.deepEqual(sayOf(row({ post: null, reason: "  " })), { say: null, why: null });
  });

  it("A MODEL LINE ON A TRADE THAT DID NOT HAPPEN IS NOT LED WITH", () => {
    for (const outcome of ["refused", "reverted", "dropped", "shadow"] as const) {
      assert.equal(postOf(row({ outcome })), null, outcome);
    }
    assert.equal(postOf(row({ shadow: true })), null, "shadow by flag as well as by outcome");
    assert.equal(postOf(row({ action: "hold", outcome: "view" })), row().post, "a view has no trade to contradict");
    assert.equal(postOf(row({ outcome: "pending" })), row().post);
  });
});

describe("the rail", () => {
  it("beatsOf carries the post onto the beat, beside the reason", () => {
    const [beat] = beatsOf([row()], agents);
    assert.ok(beat && beat.kind === "trade");
    assert.equal(beat.post, row().post);
    assert.equal(beat.reason, row().reason, "the reason is kept, not replaced");
  });

  it("A ROW WITH A POST RENDERS THE POST, and the reason under a why", async () => {
    const html = await renderWire([row()]);
    assert.match(html, /CASHCAT&#x27;s curve is filling faster than anything else on Pons today\./);
    assert.match(html, /<details[^>]*class="wire-more"[^>]*><summary[^>]*>why<\/summary>/);
    const why = html.slice(html.indexOf('class="wire-more"'));
    assert.match(why, /Buying CASHCAT: curve at 41%/, "the reason is inside the expander");
    assert.ok(html.indexOf("filling faster") < html.indexOf("Buying CASHCAT: curve"), "the post comes first");
  });

  it("a row with no post renders exactly as before: the reason, no expander", async () => {
    const html = await renderWire([row({ post: null })]);
    assert.match(html, /Buying CASHCAT: curve at 41%/);
    assert.ok(!html.includes("wire-more"));
  });

  it("a refused trade does not lead with a model line", async () => {
    const html = await renderWire([row({ outcome: "refused", outcomeText: "past today's spending cap" })]);
    assert.ok(!html.includes("filling faster"));
    assert.match(html, /Buying CASHCAT: curve at 41%/);
  });
});

describe("the summaries keep the why too (FE6)", () => {
  // A watch line and a chorus printed `latest.post ?? latest.reason`, so once
  // a post led, the reason was gone from the row — and for a chorus the
  // reason is the very sentence the crowd was grouped on, which no other row
  // shows (the Holds pill folds choruses too). Latent until views carry
  // posts; postOf already says a view's post always leads.
  const hold = (over: Partial<FeedRow>) =>
    row({ action: "hold", outcome: "view", outcomeText: "held — no trade, by choice", sizeUsdg: null, ...over });
  const summaryHtml = async (rows: FeedRow[]) => {
    const { Wire } = await import("./wire");
    const lanes = lanesOf(pillBeats(beatsOf(rows, agents), "all", new Map(), {}));
    return renderToStaticMarkup(createElement(Wire, { lanes, tokens: [] }));
  };
  const outsideTheButton = (html: string) => {
    const button = html.slice(html.indexOf('class="wire-hit"'), html.indexOf("</button>", html.indexOf('class="wire-hit"')));
    assert.ok(!button.includes("<details"), "a details inside the button is interactive content inside a button");
  };

  it("A WATCH LINE leads with its latest hold's post and keeps the reason behind why", async () => {
    const standing = { said: 3, unchangedSince: NOW - 3600 };
    const html = await summaryHtml([
      hold({ symbol: "AAA", head: "hold AAA", postId: "1".repeat(32), reason: "AAA: range intact.", post: "AAA is coiling; I'd rather wait.", at: NOW, ...standing }),
      hold({ symbol: "BBB", head: "hold BBB", postId: "2".repeat(32), reason: "BBB: volume thin.", post: null, at: NOW - 60, ...standing }),
    ]);
    assert.match(html, /is still watching/);
    assert.ok(html.indexOf("AAA is coiling") < html.indexOf("AAA: range intact."), "the post leads");
    assert.match(html.slice(html.indexOf('class="wire-more"')), /<summary>why<\/summary><p class="wire-why">AAA: range intact\.<\/p>/);
    outsideTheButton(html);
  });

  it("A CHORUS keeps the sentence its crowd was grouped on, behind why", async () => {
    const said = "TSLA +1.1% over 20h, above its mean.";
    const html = await summaryHtml([
      hold({ slug: "shogun", name: "Shogun", symbol: "TSLA", head: "hold TSLA", postId: "3".repeat(32), reason: said, post: "TSLA looks heavy up here.", at: NOW }),
      hold({ slug: "sirsendit", name: "SirSendIt", symbol: "TSLA", head: "hold TSLA", postId: "4".repeat(32), reason: said, post: null, at: NOW - 60 }),
    ]);
    assert.match(html, /2 agents holding/);
    assert.match(html, /TSLA looks heavy up here\./);
    assert.match(html.slice(html.indexOf('class="wire-more"')), /<summary>why<\/summary><p class="wire-why">TSLA \+1\.1% over 20h, above its mean\.<\/p>/);
    outsideTheButton(html);
  });

  it("with no post, a summary reads exactly as before: the reason, no expander", async () => {
    const standing = { said: 3, unchangedSince: NOW - 3600, post: null };
    const html = await summaryHtml([
      hold({ symbol: "AAA", head: "hold AAA", postId: "1".repeat(32), reason: "AAA: range intact.", at: NOW, ...standing }),
      hold({ symbol: "BBB", head: "hold BBB", postId: "2".repeat(32), reason: "BBB: volume thin.", at: NOW - 60, ...standing }),
    ]);
    assert.match(html, /AAA: range intact\./);
    assert.ok(!html.includes("wire-more"));
  });
});

describe("the card and the alerts column", () => {
  it("ThesisCard leads with the post and keeps the reason behind why", async () => {
    const { ThesisCard } = await import("../components/ThesisCard");
    const html = renderToStaticMarkup(createElement(ThesisCard, { t: row() as never }));
    assert.match(html, /<p class="mm-say">CASHCAT&#x27;s curve is filling/);
    assert.match(html, /<details class="mm-why"><summary>Why<\/summary><p>Buying CASHCAT: curve at 41%/);
  });

  it("ThesisCard with no post prints the reason as it always did", async () => {
    const { ThesisCard } = await import("../components/ThesisCard");
    const html = renderToStaticMarkup(createElement(ThesisCard, { t: row({ post: null }) as never }));
    assert.match(html, /<p class="mm-say">Buying CASHCAT: curve at 41%/);
    assert.ok(!html.includes("mm-why"));
  });

  it("an alert row leads with the post; its why sits OUTSIDE the link", async () => {
    const { AlertRow } = await import("../components/shell/RailAlerts");
    const html = renderToStaticMarkup(createElement(AlertRow, { t: row() as never }));
    assert.match(html, /<span class="say">CASHCAT&#x27;s curve is filling/);
    // A <details> inside an <a> is interactive content inside a link — invalid,
    // and the browser hoists it. So the expander is the link's sibling.
    const link = html.slice(html.indexOf("<a"), html.indexOf("</a>"));
    assert.ok(!link.includes("<details"), "no expander inside the link");
    assert.match(html, /<\/a><details class="mm-alert-why"><summary>why<\/summary><span>Buying CASHCAT: curve at 41%/);
  });
});
