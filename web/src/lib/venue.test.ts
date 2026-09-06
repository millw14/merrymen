/**
 * THE READER'S SESSION MUST NOT LEAVE THIS ORIGIN.
 *
 * The terminal redesign needed three outside feeds and reached them by adding
 * wildcard `rewrites()` to next.config.mjs. A rewrite is same-origin, so the
 * browser attached the session cookie — set `httpOnly, secure,
 * sameSite:"strict", path:"/"` in lib/auth.ts — to `/yahoo/…`, and Next
 * forwarded the request upstream headers and all. Every chart view on a hosted
 * deployment sent a live merrymen session to Yahoo. They were also open
 * proxies: `:path*` at three hosts, unauthenticated, outside the middleware,
 * which guards only `/api/`.
 *
 * These tests hold the replacement in place. The first one is the one that
 * matters — it reads next.config.mjs and fails if a rewrite ever comes back,
 * because the fix is not "we removed it", it is "it cannot return quietly".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  CHART_WINDOWS,
  chartUrl,
  holdersUrl,
  isChartWindow,
  isJsonType,
  quoteUrl,
  VENUE_HOSTS,
  venueHeaders,
} from "./venue";

const CONFIG = readFileSync(new URL("../../next.config.mjs", import.meta.url), "utf8");

describe("no third-party host is reachable from this origin", () => {
  it("INVARIANT: next.config.mjs declares no rewrites at all", () => {
    // A rewrite is the only way to make a third-party host same-origin, and
    // same-origin is what hands it the session cookie.
    const code = CONFIG.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.ok(!/\brewrites\s*\(/.test(code), "next.config.mjs must declare no rewrites()");
    for (const host of Object.values(VENUE_HOSTS)) {
      assert.ok(!code.includes(host), `${host} must not appear in the Next config`);
    }
  });

  it("INVARIANT: no browser module fetches a venue host or its old proxy path", () => {
    const terminal = new URL("../terminal/", import.meta.url);
    const files = [
      "bars.ts", "quotes.ts", "live.ts", "App.tsx", "Desktop.tsx",
      "screens/Token.tsx", "screens/Home.tsx", "screens/Board.tsx", "screens/Feed.tsx",
    ];
    for (const f of files) {
      const src = readFileSync(new URL(f, terminal), "utf8");
      for (const bad of ["/yahoo/", "/robinhood/", "/blockscout/"]) {
        // Comments explain the history; code must not contain the path.
        const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
        assert.ok(!code.includes(bad), `${f} still fetches ${bad} — that path no longer exists`);
      }
      for (const host of Object.values(VENUE_HOSTS)) {
        assert.ok(!src.includes(host), `${f} must not name ${host}; the route does`);
      }
    }
  });

  it("the outgoing request is built, and carries nothing that identifies a reader", () => {
    const headers = venueHeaders();
    for (const forbidden of ["cookie", "authorization", "referer", "x-forwarded-for", "set-cookie"]) {
      assert.ok(!(forbidden in headers), `venue requests must not carry ${forbidden}`);
    }
    assert.equal(headers.accept, "application/json");
  });
});

describe("what may be asked, and nothing else", () => {
  it("quotes are two named documents", () => {
    assert.equal(quoteUrl("assets"), `https://${VENUE_HOSTS.robinhood}/rhj/assets`);
    assert.equal(quoteUrl("prices"), `https://${VENUE_HOSTS.robinhood}/rhj/prices`);
    for (const bad of ["", "../../etc", "assets?x=1", "accounts", "ASSETS"]) {
      assert.equal(quoteUrl(bad as "assets"), null, `"${bad}" must be refused`);
    }
  });

  it("a chart symbol must be one this chain actually lists", () => {
    assert.ok(chartUrl("TSLA", "1D"));
    assert.ok(chartUrl("tsla", "1D"), "case is normalised, not a second allow-list");
    for (const bad of ["GME", "AAPL.L", "../TSLA", "TSLA?x=1", "", "A B", "0x1234"]) {
      if (bad === "AAPL.L" || bad === "GME") {
        assert.equal(chartUrl(bad, "1D"), null, `${bad} is not listed on this chain`);
      } else {
        assert.equal(chartUrl(bad, "1D"), null, `"${bad}" must be refused`);
      }
    }
  });

  it("a chart window must be one of the six the UI offers", () => {
    for (const w of Object.keys(CHART_WINDOWS)) assert.ok(isChartWindow(w), w);
    for (const bad of ["7D", "2Y", "", "1d", "max"]) {
      assert.equal(isChartWindow(bad), false, `"${bad}" is not a window`);
      assert.equal(chartUrl("TSLA", bad), null);
    }
  });

  it("REGRESSION: the week button is gone, because the venue has no week", () => {
    // Yahoo's range grid is 1d/5d/1mo/3mo/… — there is no 7d. The button said
    // "7D" and fetched `range=5d`, so the chart, its axis and the percentage
    // under it were five days of data wearing a week's name.
    assert.ok(!("7D" in CHART_WINDOWS), "7D must not be offered");
    assert.equal(CHART_WINDOWS["5D"].range, "5d", "and the one that is offered fetches what it says");
    for (const [label, spec] of Object.entries(CHART_WINDOWS)) {
      assert.ok(
        ["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "ytd", "max"].includes(spec.range),
        `${label} asks for range="${spec.range}", which the venue does not offer`,
      );
    }
  });

  it("a holder list needs twenty bytes of hex and nothing else", () => {
    const good = "0x322f0929c4625ed5bad873c95208d54e1c003b2d";
    assert.equal(holdersUrl(good), `https://${VENUE_HOSTS.blockscout}/api/v2/tokens/${good}/holders`);
    assert.equal(holdersUrl(good.toUpperCase().replace("0X", "0x")), holdersUrl(good), "case is normalised");
    for (const bad of [
      "",
      "0x",
      "0x322f",
      "0x322f0929c4625ed5bad873c95208d54e1c003b2dd",
      "0x322f0929c4625ed5bad873c95208d54e1c003b2g",
      "../../../admin",
      "0x322f0929c4625ed5bad873c95208d54e1c003b2d/../../admin",
      "0x322f0929c4625ed5bad873c95208d54e1c003b2d?x=1",
    ]) {
      assert.equal(holdersUrl(bad), null, `"${bad}" must be refused`);
    }
  });

  it("every built URL lands on an allow-listed host", () => {
    const built = [
      quoteUrl("assets"),
      quoteUrl("prices"),
      chartUrl("TSLA", "1M"),
      holdersUrl("0x322f0929c4625ed5bad873c95208d54e1c003b2d"),
    ];
    const hosts = new Set<string>(Object.values(VENUE_HOSTS));
    for (const u of built) {
      assert.ok(u, "every allowed request must build a URL");
      const parsed = new URL(u!);
      assert.equal(parsed.protocol, "https:");
      assert.ok(hosts.has(parsed.host), `${parsed.host} is not allow-listed`);
    }
  });
});

describe("an answer that is not JSON is not data", () => {
  it("recognises the content types a venue actually sends", () => {
    assert.ok(isJsonType("application/json"));
    assert.ok(isJsonType("application/json; charset=utf-8"));
    assert.ok(isJsonType("APPLICATION/JSON"));
    assert.equal(isJsonType("text/html"), false, "an error page must not arrive as data");
    assert.equal(isJsonType(null), false);
  });
});

describe("the route is under /api/, which is where the guards are", () => {
  it("lives at app/api/venue so middleware covers it", () => {
    const route = readFileSync(new URL("../app/api/venue/route.ts", import.meta.url), "utf8");
    // Comments stripped first: the file explains at length what it does NOT
    // forward, using the name of the thing it does not forward.
    const code = route.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    assert.match(code, /headers: venueHeaders\(\)/, "headers are built, never forwarded");
    assert.ok(!/req\.headers/.test(code), "the reader's headers must not reach the upstream fetch");
    assert.match(route, /VENUE_HOSTS/, "the landing host is re-checked after redirects");
    assert.match(route, /MAX_VENUE_BYTES/, "the body is capped");
  });

  it("middleware applies the cross-site block to it", () => {
    const mw = readFileSync(new URL("../middleware.ts", import.meta.url), "utf8");
    assert.match(mw, /pathname\.startsWith\("\/api\/"\)/, "the API guards key on the /api/ prefix");
  });
});
