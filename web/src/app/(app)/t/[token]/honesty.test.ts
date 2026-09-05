import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * WHAT THE TOKEN PAGE IS ALLOWED TO SAY.
 *
 * This page took a product that showed no market figures at all and gave it
 * several, which is exactly the change that invents claims. Each assertion here
 * is a sentence the page would otherwise state without evidence — most of them
 * arrived as one-line conveniences that looked like formatting choices.
 *
 * Source scans rather than renders, in the idiom the discoveries panel already
 * uses: these are properties of how the page is WRITTEN, and a render test
 * would pass on a page that had simply not hit the branch yet.
 */

const at = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

/**
 * The same source with its comments removed.
 *
 * Every "must not contain" assertion below runs against THIS, because the
 * property is about what the page renders and this codebase explains its
 * refusals at length right where it makes them. Scanning the raw file, a
 * comment saying why a token is never labelled "market cap" fails the test
 * forbidding that label — which teaches the next person to delete the
 * explanation rather than keep the rule.
 */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const PAGE = at("./page.tsx");
const SCREEN = at("../../../../terminal/screens/Token.tsx");
const FACTS = at("../../../../components/TokenFacts.tsx");
const FACTS_CODE = code(FACTS);
const TIMELINE = at("../../../../components/EntryTimeline.tsx");
const READ_TOKEN = at("../../../../lib/read-token.ts");
const MARKET = at("../../../../lib/market.ts");

describe("the strip only prints figures it has", () => {
  it("calls fully-diluted value FDV, never market cap", () => {
    // The index substitutes FDV for market cap whenever it lacks a circulating
    // supply, so the label is the only thing separating the two numbers.
    assert.ok(!/Market cap/i.test(FACTS_CODE), "FDV must not be labelled market cap");
    assert.match(FACTS, /label="FDV"/);
  });

  it("never shows an on-curve coin's reserve as depth", () => {
    // A fresh curve reports about $4,100 of reserve while holding none of it.
    assert.match(FACTS, /onCurve \?[\s\S]{0,120}?pre-graduation/);
  });

  it("has no 4H cell, because the index has no 4H bucket", () => {
    // The reference product's grid reads 5M / 1H / 4H / 1D. Relabelling the
    // six-hour bucket "4H" is a fabrication nothing downstream could detect.
    assert.ok(!/\b4H\b/i.test(FACTS_CODE), "there is no four-hour window to show");
    assert.ok(!/\bh4\b/.test(FACTS_CODE), "the index publishes no h4 key");
    assert.match(FACTS, /h6: "6h"/);
  });

  it("distinguishes a token with no feed from a read that failed", () => {
    // "no feed" is a fact about the token. A dash is a fact about us.
    assert.match(FACTS, /const noFeed =/);
    assert.match(FACTS, /noFeed \?[\s\S]{0,120}?no feed/);
  });

  it("checks UNREADABLE before ABSENT", () => {
    // The same ordering the launchpad panel is pinned to. Reversed, a refused
    // read renders as "the index has nothing", which is a claim about the
    // market made out of our own outage.
    const unread = FACTS.indexOf('read === "unread"');
    const absent = FACTS.indexOf('read === "absent"');
    assert.ok(unread > 0 && absent > 0, "both states must be handled");
    assert.ok(unread < absent, "the unreadable case must be checked first");
  });

  it("says nothing about what the INDEX knows, only about its feeds", () => {
    // What we hold is page one of three feeds, not the index's knowledge, so
    // "not indexed" would be a claim we are in no position to make.
    assert.ok(!/not indexed/i.test(FACTS_CODE));
    assert.match(FACTS, /trending, new or top lists/);
  });
});

describe("a proportion needs both of its numbers", () => {
  it("renders no bar at all when either side is missing", () => {
    assert.match(FACTS, /if \(lo === null \|\| hi === null\) return null;/);
  });

  it("guards the zero split by name", () => {
    // lo / (lo + hi) is NaN when nothing traded, and the obvious fallback
    // paints half the track green — an even split asserted about a window with
    // no trades in it.
    assert.match(FACTS, /const nothingTraded = total === 0;/);
    assert.match(FACTS, /nothingTraded \? 0 :/);
  });

  it("refuses the dollar buy/sell split in writing", () => {
    // Volume arrives as one scalar per window with no side attached. The
    // refusal is recorded so the next person does not go looking for it.
    assert.match(FACTS, /TWO BARS AND NOT THREE/);
  });
});

describe("a halt is never guessed at", () => {
  it("market.ts does not fall back to a false paused flag", () => {
    assert.ok(
      !/paused:[^,\n]*:\s*false/.test(MARKET),
      "an unread pause state must be null, not 'trading normally'",
    );
    assert.match(MARKET, /paused: boolean \| null;/);
  });

  it("rialtoLiquid does not fall back to false either", () => {
    // fetchRialtoLiquidity returns an EMPTY MAP when Rialto is down, so the
    // fallback stamped "illiquid" on every token during one outage.
    assert.ok(!/rialtoLiquid:[^,\n]*\?\?\s*false/.test(MARKET));
    assert.match(MARKET, /rialtoLiquid: boolean \| null;/);
  });

  it("the strip asserts halted only when paused is TRUE", () => {
    assert.match(FACTS, /stock\.paused === true/);
    assert.ok(!/\{stock\.paused &&/.test(FACTS_CODE), "a null must not read as halted");
  });
});

describe("the timeline says why it is empty", () => {
  it("checks fillsRead BEFORE claiming the ledger forgot", () => {
    // "the position is real, the trade that opened it is older than what the
    // ledger keeps" is a positive claim about ledger RETENTION. It used to be
    // printed whenever the list was empty, including when the query had thrown.
    const gate = TIMELINE.indexOf("if (!fillsRead)");
    const claim = TIMELINE.indexOf("older than what the ledger keeps");
    assert.ok(gate > 0 && claim > 0);
    assert.ok(gate < claim, "the unread case must be checked first");
  });

  it("fillsRead is set only after the query returns", () => {
    // Set before the await, it would be true on the path that throws — which
    // is the only path it exists to detect.
    assert.match(READ_TOKEN, /\.all\(token\.toLowerCase\(\)\)\)[\s\S]{0,220}?fillsRead = true;/);
  });

  it("carries the evidence class beside the fill price", () => {
    // A pretend fill must not look like a real one, and the price alone cannot
    // say which it is.
    assert.match(READ_TOKEN, /SELECT agent_id, created_at, fill_price_usd, basis_source/);
    assert.match(TIMELINE, /paper \? " unsettled" : ""/);
  });
});

describe("the page does not attribute words to the wrong token", () => {
  it("symbolClash gates the thesis read entirely", () => {
    // Both tickers are attacker-chosen: the index's label is a string the pool
    // carries, the ledger's comes from the contract's own symbol(). Matching
    // theses by symbol without this gate prints an agent's real reasoning about
    // the listed token on an impostor's page, attributed to a holder of the
    // impostor.
    assert.match(SCREEN, /thesis:data\.market\.symbolClash \? "" : theses\.find/);
  });

  it("distinguishes 'said nothing' from 'cannot be matched'", () => {
    // An agent with no slug cannot be looked up at all. Printing "nothing said"
    // for it puts words in its mouth on the strength of a failed join.
    assert.match(SCREEN, /holders\.filter\(h=>h\.slug\)/);
    assert.match(SCREEN, /symbolClash &&[\s\S]{0,120}reasoning cannot be matched/);
  });
});

describe("the page is dynamic, because its data can be degraded", () => {
  it("no ISR on a page carrying the discoveries read", () => {
    // One degraded render was served as a cache HIT for six consecutive polls
    // in production. The memo underneath decides what is worth keeping; a fixed
    // revalidate cannot.
    assert.ok(!/^export const revalidate/m.test(PAGE));
    assert.match(PAGE, /^export const dynamic = "force-dynamic";/m);
  });
});

describe("a token page does not wait for the discovery panel", () => {
  const MARKET = at("../../../../lib/read-token-market.ts");
  const DISC = at("../../../../lib/read-discoveries.ts");

  it("reads the pools, not the built payload", () => {
    // Building the panel sweeps the launchpad over chain logs, makes three
    // enrichment reads and runs the scout's MODEL. A cold memo therefore made a
    // token page view block on an LLM call to show four figures about one
    // token, none of which that work says anything about.
    assert.match(MARKET, /readPoolFor/);
    assert.ok(
      !/sharedRead\(\)/.test(code(MARKET)),
      "a token page must not await the panel build",
    );
  });

  it("the light read has no model in it", () => {
    // Pinned on the function rather than the comment: the scout must stay on
    // the far side of the split, where only the panel waits for it.
    const light = DISC.slice(
      DISC.indexOf("async function readPools()"),
      DISC.indexOf("async function build()"),
    );
    assert.ok(light.length > 0, "readPools must exist and precede build");
    assert.ok(!/rankForDisplay/.test(light), "no verdict pass inside the pool read");
    assert.ok(!/readFresh/.test(light), "no launchpad sweep inside the pool read");
  });

  it("still shares one fetch between the two paths", () => {
    // The split must not double the index requests it was made to protect.
    assert.match(DISC, /await sharedPools\(\)/);
  });
});
