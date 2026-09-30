/**
 * A FEED READ DOES NOT RE-READ THE TOKEN PAGE.
 *
 * The shell reads the feed every ten seconds and hands the token page the new
 * posts each time. The page's holders read listed those posts among its
 * dependencies, so each feed read emptied the holders list, drew the loading
 * skeleton and asked the ledger again.
 *
 * Token.tsx itself cannot be loaded by this runner (it pulls in
 * lightweight-charts, which ships import-only), so the probe below calls the
 * one hook Token.tsx takes its read and its seats from, and is re-rendered with
 * a newer feed the way the shell re-renders the page.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { act, createElement } from "react";

import { testDom } from "./test-dom";
import type { Thesis } from "./live";
import { pageReadOf, useTokenPage } from "./token-page-read";

const TSLA = "0x322f0929c4625ed5bad873c95208d54e1c003b2d";
const post = (reason: string): Thesis =>
  ({ name: "Shogun", slug: "shogun", handle: null, action: "buy", symbol: "TSLA", sizeUsdg: 5, reason, paper: false, head: "" }) as Thesis;

function Probe({ theses, attempt = 0 }: { theses: Thesis[]; attempt?: number }) {
  const page = useTokenPage(TSLA, "TSLA", theses, attempt);
  return createElement("p", null, `${page.holdersRead} ${page.seats.length} ${page.seats.map((s) => s.thesis).join("|")}`);
}

const ledgerAnswer = () => new Response(ledgerBody(), { status: 200 });
const ledgerBody = () =>
  JSON.stringify({
    ledger: {
      symbol: "TSLA",
      fillsRead: true,
      privateHolders: 0,
      holders: [
        { slug: "shogun", name: "Shogun", handle: null, paper: false, valueUsdg: 12, costUsdg: 10, pnlBps: 2000, enteredAt: null, entryPriceUsd: null, basisSource: null },
      ],
    },
    market: { symbolClash: false, coin: null },
    evidence: null,
  });

describe("what one answer of the page read amounts to — unchanged by the move out of Token.tsx", () => {
  const data = (fillsRead: boolean) => ({
    ledger: { symbol: "TSLA", fillsRead, privateHolders: 0, holders: fillsRead ? [{ slug: "a" }] : [] },
    market: { symbolClash: true, coin: null },
    evidence: null,
  }) as unknown as import("./token-page-read").TokenPageData;

  it("a failed read is a failure, said once, with nothing claimed about holders", () => {
    const r = pageReadOf({ ok: false });
    assert.equal(r.holdersRead, "failed");
    assert.equal(r.holderError, "Public holdings are unavailable right now.");
    assert.deepEqual(r.holders, []);
    assert.equal(r.activity.loading, false);
  });

  it("an answer whose fills could not be read is a failure too, and keeps the activity it did carry", () => {
    const r = pageReadOf({ ok: true, data: data(false) });
    assert.equal(r.holdersRead, "failed");
    assert.equal(r.coverage, null);
    assert.equal(r.symbolClash, true);
    assert.equal(r.activity.loading, false);
  });

  it("a read answer carries its holders", () => {
    const r = pageReadOf({ ok: true, data: data(true) });
    assert.equal(r.holdersRead, "ok");
    assert.equal(r.holders.length, 1);
  });
});

describe("the page's seats, as the page draws them", () => {
  // THE CLASH GATE IS APPLIED WHERE THE READ IS, not at Token.tsx's call site.
  // Both tickers are attacker-chosen: an impostor pool can carry "TSLA" too,
  // and matching posts by symbol without the gate prints a real agent's
  // reasoning about the listed token on the impostor's page. Token.tsx passed
  // `symbolClash` to seatsOf by hand, and that file cannot be loaded here, so
  // `seatsOf(..., false)` there left every test green. The page now takes its
  // seats from useTokenPage, and this drives it with the clash coming from the
  // read itself.
  function Page({ theses }: { theses: Thesis[] }) {
    const page = useTokenPage(TSLA, "TSLA", theses, 0);
    return createElement("p", null, `${page.holdersRead} ${page.symbolClash} ${page.seats.map((s) => `${s.slug}:${s.thesis}`).join("|")}`);
  }
  const answer = (symbolClash: boolean) => {
    const body = JSON.parse(ledgerBody()) as { market: { symbolClash: boolean } };
    body.market.symbolClash = symbolClash;
    return new Response(JSON.stringify(body), { status: 200 });
  };

  for (const clash of [true, false]) {
    it(clash ? "a clash the read reports leaves every seat without a thesis" : "and without one, the seat carries its agent's thesis", async () => {
      const t = testDom();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL) =>
        String(input).startsWith("/api/tokens/") ? answer(clash) : new Response("{}", { status: 404 })) as typeof fetch;
      try {
        await t.render(createElement(Page, { theses: [post("cheap into earnings")] }));
        await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
        assert.equal(t.container.textContent, clash ? "ok true shogun:" : "ok false shogun:cheap into earnings");
      } finally {
        globalThis.fetch = originalFetch;
        await t.close();
      }
    });
  }
});

describe("the token page under a live feed", () => {
  it("keeps its holders, and reads them once, while the feed moves", async () => {
    const t = testDom();
    const originalFetch = globalThis.fetch;
    let reads = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/tokens/")) {
        reads++;
        return ledgerAnswer();
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    try {
      await t.render(createElement(Probe, { theses: [post("first take")] }));
      await flush();
      assert.equal(reads, 1);
      assert.equal(t.container.textContent, "ok 1 first take");

      await t.render(createElement(Probe, { theses: [post("second take")] }));
      await t.render(createElement(Probe, { theses: [post("third take")] }));
      await flush();
      assert.equal(reads, 1, "a newer feed must not re-read the ledger");
      assert.equal(t.container.textContent, "ok 1 third take", "nor blank the list, while the thesis follows the feed");

      await t.render(createElement(Probe, { theses: [post("third take")], attempt: 1 }));
      await flush();
      assert.equal(reads, 2, "Try again still reads again");
    } finally {
      globalThis.fetch = originalFetch;
      await t.close();
    }
  });
});
