/**
 * THE OWNER'S OWN BOOK, READ FOR ONE SLUG AT A TIME.
 *
 * useOwnBookRead is behind the profile's private figures and every stopped
 * card, so "never another slug's answer" is the rule that keeps one owner's
 * figure off a page about anybody else: a change of slug is undefined until
 * that slug's own read lands. A refresh of the same slug keeps the last answer
 * on screen instead of blanking it.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import React, { act } from "react";
import { useOwnBookRead } from "./owner-reads";
import type { OwnBookRead } from "./owner-state";
import { deferred, json, testDom } from "./test-dom";

const originalFetch = globalThis.fetch;
let ui: ReturnType<typeof testDom>;
let pending: Map<string, ReturnType<typeof deferred<Response>>>;
let seen: OwnBookRead | "unset";

const book = (equityUsdg: number) => ({
  recentTrades: [], activityRead: true, topTrades: [], topTradesRead: true, figuresRead: true,
  figures: { book: "paper", equityUsdg, equityAt: 1_795_550_640, held: false, pnlUsdg: 0, pnlAt: null, underReview: false, pnlEstimated: false },
});
function Probe({ slug, refresh }: { slug: string | null; refresh: number }) {
  seen = useOwnBookRead(slug, refresh);
  return null;
}
const settle = async () => { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); };
const answer = async (slug: string, body: Response) => { await act(async () => { pending.get(slug)!.resolve(body); }); await settle(); };
const equity = () => (seen === "unset" ? "unset" : seen?.figures?.equityUsdg);

beforeEach(() => {
  ui = testDom();
  pending = new Map();
  seen = "unset";
  globalThis.fetch = async (input) => {
    const slug = /^\/api\/agents\/([^/]+)\/own$/.exec(String(input))?.[1];
    if (!slug) throw new Error(`Unexpected network boundary: ${String(input)}`);
    const d = deferred<Response>();
    pending.set(slug, d);
    return d.promise;
  };
});
afterEach(async () => { await ui.close(); globalThis.fetch = originalFetch; });

describe("useOwnBookRead", () => {
  it("never answers with another slug's book", async () => {
    await ui.render(React.createElement(Probe, { slug: "alice", refresh: 0 }));
    assert.equal(seen, undefined, "in flight");
    await answer("alice", json(book(1000)));
    assert.equal(equity(), 1000);
    await ui.render(React.createElement(Probe, { slug: "bob", refresh: 0 }));
    await settle();
    assert.equal(seen, undefined, "bob's read is out: nothing, not alice's figure");
    await answer("bob", json(book(25)));
    assert.equal(equity(), 25);
  });

  it("a refresh keeps the last answer until the next one lands, and a refusal is null", async () => {
    await ui.render(React.createElement(Probe, { slug: "alice", refresh: 0 }));
    await answer("alice", json(book(1000)));
    await ui.render(React.createElement(Probe, { slug: "alice", refresh: 1 }));
    await settle();
    assert.equal(equity(), 1000, "not blanked by the refresh");
    await answer("alice", json({ error: "Agent not found" }, 404));
    assert.equal(seen, null);
  });

  it("no slug, no read", async () => {
    await ui.render(React.createElement(Probe, { slug: null, refresh: 0 }));
    await settle();
    assert.equal(seen, undefined);
    assert.equal(pending.size, 0);
  });
});
