/**
 * A ROW SAYS WHAT WAS TRADED, NOT WHAT THE LEDGER CALLS IT.
 *
 * Trencher coins are named `T` plus the last eleven hex of their contract, and
 * the rail, the alerts column and every trade line printed exactly that —
 * "Shogun bought T3139F043B88" — while the publisher had the coin's name the
 * whole time and only ever put it inside the head. And the "Trench thesis"
 * byline came from the author's CURRENT strategy, so a TSLA hold read as a
 * trench call once its author switched modes.
 *
 * Built from the real publisher's output, so the name travels the whole way:
 * decision row → publishableThesis → beatsOf.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { publishableThesis } from "@merrymen/thesis";
import { beatsOf, whoOf, type FeedRow } from "./beat";
import type { LiveAgent } from "./live";
import { coinName } from "../lib/rail-alerts";

const NOW = 1_790_000_000;
const ID = "T3139F043B88";

const published = (over: Record<string, unknown> = {}, extra: Partial<FeedRow> = {}): FeedRow => {
  const post = publishableThesis({
    agent_id: "0xabc",
    name: "Shogun",
    slug: "shgn2345678abcde",
    source: "brain",
    action: "hold",
    symbol: ID,
    display_name: "JUGGERNAUT",
    size_usdg: 0,
    reason: "Flow is two-sided and the book is deep enough for the size.",
    said: 1,
    last_at: NOW,
    first_at: NOW,
    mode: "live",
    ...over,
  });
  assert.ok(post, "the fixture must be publishable");
  return { ...post, ...extra } as FeedRow;
};

const agents = [
  { slug: "shgn2345678abcde", name: "Shogun", handle: "@shogun", owner: null, pnlBps: null, curve: [], landed: 0, last: null, glance: { id: "custom", label: "Strategy" }, thesis: "" },
] as unknown as LiveAgent[];

describe("the coin is called by its name", () => {
  it("a trade line reads the name, and keeps the id for logos and the tooltip", () => {
    const [beat] = beatsOf([published({ action: "buy", size_usdg: 5 })], agents);
    assert.ok(beat && beat.kind === "trade");
    assert.equal(beat.label, "JUGGERNAUT");
    assert.equal(beat.symbol, ID, "the id is what logos and links resolve against");
  });

  it("a view reads the publisher's sentence without the id it adds for /why", () => {
    const [beat] = beatsOf([published()], agents);
    assert.ok(beat && beat.kind === "view");
    assert.equal(beat.head, "hold JUGGERNAUT");
    assert.ok(!beat.head.includes(ID));
  });

  it("with no name, the id is what there is — never a placeholder", () => {
    const [beat] = beatsOf([published({ display_name: null })], agents);
    assert.ok(beat && beat.kind === "view");
    assert.equal(beat.label, ID);
    assert.equal(beat.head, `hold ${ID}`);
  });

  it("a stock is untouched", () => {
    const [beat] = beatsOf([published({ symbol: "TSLA", display_name: null, action: "buy", size_usdg: 5 })], agents);
    assert.equal(beat!.label, "TSLA");
  });

  it("the alerts column names the coin too, with the id one hover away", () => {
    assert.deepEqual(coinName({ symbol: ID, displayName: "JUGGERNAUT" }), { shown: "JUGGERNAUT", id: ID });
    assert.deepEqual(coinName({ symbol: "TSLA", displayName: null }), { shown: "TSLA", id: null });
    assert.deepEqual(coinName({ symbol: ID, displayName: ID }), { shown: ID, id: null });
    assert.equal(coinName({ symbol: null, displayName: null }), null);
  });
});

describe("the trench byline comes from the row, not from the author's current mode", () => {
  it("A STOCK HOLD FROM AN AGENT NOW IN TRENCHER MODE IS NOT A TRENCH THESIS", () => {
    const [beat] = beatsOf([published({ symbol: "TSLA", display_name: null }, { trencher: true })], agents);
    assert.equal(beat!.actor.trencher, true, "the author really is in Trencher mode now");
    assert.equal(beat!.trench, false, "but this row is about a stock");
  });

  it("and a trench coin stays a trench row after its author switches away", () => {
    const [beat] = beatsOf([published({}, { trencher: false })], agents);
    assert.equal(beat!.trench, true);
  });
});

describe("a row is about the agent, and names its owner only on proof", () => {
  // The subject of every feed row was `handle ?? name` — the owner's X
  // handle, which the owner typed and nothing checked. Any agent could head
  // each of its posts with somebody else's name.
  it("AN UNPROVEN HANDLE IS NOT SHOWN AT ALL — the agent's name heads the row", () => {
    const [beat] = beatsOf([published({ x_handle: "elonmusk" })], agents);
    assert.equal(whoOf(beat!), "Shogun");
    assert.equal(beat!.actor.owner, null, "no proof flag, no handle");
  });

  it("a proven handle is carried, beside the name rather than instead of it", () => {
    const [beat] = beatsOf([published({ x_handle: "shogun_x" }, { handleVerified: true })], agents);
    assert.equal(whoOf(beat!), "Shogun");
    assert.equal(beat!.actor.owner, "@shogun_x");
  });

  it("and a proof flag on something that is not a handle links nothing", () => {
    const [beat] = beatsOf([published({ x_handle: "javascript:alert(1)" }, { handleVerified: true })], agents);
    assert.equal(beat!.actor.owner, null);
  });
});
