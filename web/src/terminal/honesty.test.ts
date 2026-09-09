/**
 * WHAT THE TERMINAL IS ALLOWED TO SAY HAPPENED.
 *
 * The redesign moved every screen in the product into `web/src/terminal` and
 * left the components that carried the old disclosures behind, unmounted. The
 * invariants those components protected did not move with them, so this file
 * re-pins the four that were being violated on live surfaces:
 *
 *   a decision nothing came of is not a trade
 *   a trade the chain has not confirmed is not a fill
 *   an unreadable ledger is not a quiet one
 *   a growth curve is not raw equity, and not one drawn over inferred deposits
 *
 * Each is written the way this repo writes them: the smallest possible unit
 * check where the logic is pure, and a source read where the property lives in
 * a render. A source read is not a fashion here — it is the only way to test a
 * claim that is made in words on a screen.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { beatsOf, verbOf, type Beat } from "./beat";

/**
 * `verbOf` takes a TRADE, not a beat — a view has no direction to conjugate,
 * and a signature that accepted one would invite exactly the fallback these
 * tests exist to prevent. So the assertion that a row is a trade at all is now
 * part of what they check.
 */
const asTrade = (b: Beat | undefined): Extract<Beat, { kind: "trade" }> => {
  assert.ok(b, "beatsOf produced nothing");
  assert.equal(b.kind, "trade", "a buy with a symbol is a trade beat");
  return b as Extract<Beat, { kind: "trade" }>;
};
import { lastLine, ledgerSeconds, readStateOf, seedLive, tradeOutcome, type LiveAgent, type Thesis } from "./live";
import { stampOf, whyLine } from "./why";
import { entryCaveat } from "./bars";

const at = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
/** Source with comments removed — these files describe at length what they will not do. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

const t = (over: Partial<Thesis> = {}): Thesis =>
  ({
    name: "Little John",
    slug: "abc",
    handle: "@lj",
    action: "buy",
    symbol: "TSLA",
    sizeUsdg: 5,
    reason: null,
    paper: false,
    head: "would buy TSLA 5.00 USDG",
    ...over,
  }) as Thesis;

const agent = (over: Partial<LiveAgent> = {}): LiveAgent =>
  ({
    slug: "abc",
    name: "Little John",
    handle: "@lj",
    owner: null,
    pnlBps: null,
    curve: [],
    landed: 0,
    last: null,
    glance: { id: "custom", label: "Strategy" },
    thesis: "",
    ...over,
  }) as LiveAgent;

describe("a decision nothing came of is not a trade", () => {
  it("REGRESSION: the rail says 'would buy', not 'bought'", () => {
    // The published feed rendered "@robin bought TSLA" for a Brain decision
    // that never reached an executor. A shadow row carries a real action and a
    // real size — thesis-policy.ts calls it "indistinguishable, to every gate
    // below, from a real buy" — so a rail that reads only `action` claims a
    // trade happened.
    const [real] = beatsOf([t({ at: 1_788_000_000, shadow: false })], [agent()]);
    const [shadow] = beatsOf([t({ at: 1_788_000_000, shadow: true })], [agent()]);
    assert.equal(verbOf(asTrade(real)), "bought");
    assert.equal(verbOf(asTrade(shadow)), "would buy");
  });

  it("A PAPER FILL REACHES THE RAIL CARRYING THAT IT WAS PAPER", () => {
    // "In the feed it says I've bought things but nothing shows in my
    // portfolio." Both halves were true: the fill landed on a paper book and
    // the portfolio reads the funded one. `paperTradingEnabled` defaults TRUE,
    // so this is most of the fleet, and `PublicThesis.paper` had carried the
    // flag all along — read-theses.ts keeps paper agents in the feed and says
    // they post "labelled". The rail was the surface that never read it.
    const [pretend] = beatsOf([t({ at: 1, paper: true })], [agent()]);
    const [funded] = beatsOf([t({ at: 1, paper: false })], [agent()]);
    assert.equal(pretend!.paper, true);
    assert.equal(funded!.paper, false);
    // AND THE VERB IS UNTOUCHED, which is the difference from `shadow` above.
    // The agent did buy; what misleads is the consequence a reader draws. A
    // conjugation change here would claim the trade did not happen.
    assert.equal(verbOf(asTrade(pretend)), "bought");
  });

  it("and the rail renders that flag, or carrying it changes nothing", () => {
    const wire = readFileSync(new URL("./wire.tsx", import.meta.url), "utf8");
    assert.match(wire, /beat\.paper && <i className="tag unsettled">paper<\/i>/);
  });

  it("A REFUSED TRADE IS NOT A PURCHASE — the whole feed was claiming otherwise", () => {
    // "In the feed it's saying I've bought coins but nothing in my portfolio."
    // Measured on the public tape: eight consecutive rows from one agent with
    // outcome "refused" and the text "past today's spending cap", every one of
    // them rendering as "bought". Nothing was in that portfolio because nothing
    // was ever bought. The shadow flag got exactly this treatment; the other
    // four outcomes never did.
    const refused = beatsOf([t({ at: 1, outcome: "refused", outcomeText: "past today's spending cap" })], [agent()]);
    assert.equal(verbOf(asTrade(refused[0])), "tried to buy");
    const reverted = beatsOf([t({ at: 1, outcome: "reverted" })], [agent()]);
    assert.equal(verbOf(asTrade(reverted[0])), "tried to buy");
    const dropped = beatsOf([t({ at: 1, outcome: "dropped" })], [agent()]);
    assert.equal(verbOf(asTrade(dropped[0])), "tried to buy");
  });

  it("AND ONE STILL IN FLIGHT IS NEITHER TENSE", () => {
    // A submitted operation is genuinely undecided: claiming it landed is the
    // older bug, and claiming it failed would be the mirror of it.
    const pending = beatsOf([t({ at: 1, outcome: "pending" })], [agent()]);
    assert.equal(verbOf(asTrade(pending[0])), "is buying");
  });

  it("but a landed trade still reads as one", () => {
    const landed = beatsOf([t({ at: 1, outcome: "landed" })], [agent()]);
    assert.equal(verbOf(asTrade(landed[0])), "bought");
  });

  it("and the reason travels, so nobody blames the agent for their own cap", () => {
    const refused = beatsOf([t({ at: 1, outcome: "refused", outcomeText: "past today's spending cap" })], [agent()]);
    assert.equal(refused[0].outcomeText, "past today's spending cap");
    const wire = readFileSync(new URL("./wire.tsx", import.meta.url), "utf8");
    assert.match(wire, /beat.outcomeText &&/);
  });
  it("the outcome arm alone is enough, for a row written before the flag existed", () => {
    const [beat] = beatsOf([t({ at: 1, shadow: undefined, outcome: "shadow" })], [agent()]);
    assert.equal(verbOf(asTrade(beat)), "would buy");
  });

  it("A HOLD REACHES THE FEED, AND BORROWS NO VERB TO DO IT", () => {
    // The line that dropped it: `if (action !== "buy" && action !== "sell")
    // continue`. Holds and pure theses already pass the publish gate with
    // outcome "view" and already carry the agent's reasoning — most of what a
    // strategist produces on a quiet day was being filtered out one line above
    // the renderer, on the screen whose complaint is that nothing happens.
    const [held] = beatsOf([t({ at: 2, action: "hold", outcome: "view", head: "holding TSLA" })], [agent()]);
    assert.ok(held);
    assert.equal(held.kind, "view", "a hold is not a trade");
    // And it is rendered from the publisher's sentence, never conjugated here.
    assert.equal(held.kind === "view" && held.head, "holding TSLA");
  });

  it("A MENTION IS RENDERED AS A MENTION, NOT AS A REPLY", () => {
    // "replying to @x" claims an intent the rows do not carry: nothing in a
    // decision says who it was answering, and the detection is a substring
    // match on published words. "mentions @x" is the fact we actually read —
    // and the named agent is on the same page, so a reader can go and check.
    const wire = code(at("./wire.tsx"));
    assert.match(wire, /mentions\{" "\}/, "the rail says mentions");
    assert.ok(!/replying to|in reply to/i.test(wire), "never an attribution we did not read");
    // And the detection requires an "@": agent handles are short words, so a
    // bare match would make every thesis containing "value" a reply to @value.
    const feed = code(at("./screens/Feed.tsx"));
    assert.match(feed, /text\.includes\(`@\$\{who\.handle\}`\)/);
    // A post never mentions its own author.
    assert.match(feed, /who\.slug !== b\.actor\.slug/);
  });

  it("a view with no words at all is not a post", () => {
    // A row with neither a head nor a reason is a database row, not something
    // an agent said. Rendering it would put a nameless empty card on the feed.
    assert.deepEqual(
      beatsOf([t({ at: 3, action: null, symbol: null, head: "", reason: null })], [agent()]),
      [],
    );
  });

  it("`lastLine` renders the publisher's own head, which carries the conditional", () => {
    assert.equal(lastLine(t()), "would buy TSLA 5.00 USDG");
    // And when there is no head at all, the reconstruction keeps the conditional.
    assert.equal(lastLine(t({ head: "", shadow: true })), "Would buy TSLA");
    assert.equal(lastLine(t({ head: "", shadow: false })), "Bought TSLA");
  });

  it("the stamp names it, and does so before every other arm", () => {
    assert.equal(stampOf(t({ shadow: true })), "shadow");
    // Ordering is the point: a shadow row that also looks paper or refused
    // must still read as shadow, or it renders as something that happened.
    assert.equal(stampOf(t({ shadow: true, paper: true })), "shadow");
    assert.equal(stampOf(t({ shadow: true, outcome: "refused", outcomeText: "the wall" })), "shadow");
  });

  it("the fallback sentence keeps the conditional too", () => {
    assert.equal(whyLine(t({ reason: null, shadow: true })), "Would buy TSLA");
    assert.equal(whyLine(t({ reason: null, shadow: true, action: "sell" })), "Would sell TSLA");
  });

  it("INVARIANT: no terminal module rebuilds a past-tense sentence from `action` alone", () => {
    for (const f of ["live.ts", "beat.ts", "why.ts", "wire.tsx"]) {
      const src = code(at(`./${f}`));
      // The shape that was wrong: a ternary on `action` producing a past-tense
      // verb with no shadow check anywhere near it.
      const hits = [...src.matchAll(/action === "buy" \?[^;]*?"Bought"/g)];
      for (const hit of hits) {
        const around = src.slice(Math.max(0, hit.index! - 400), hit.index! + 400);
        assert.match(around, /shadow/, `${f} builds a past-tense verb without consulting shadow`);
      }
    }
  });
});

describe("a trade the chain has not confirmed is not a fill", () => {
  it("REGRESSION: 'submitted' is pending, not landed", () => {
    // It was written as a negation — anything not 'rejected' and not 'reverted'
    // was published as "landed". `trades.status` is genuinely written
    // 'submitted' while an operation is in flight (ledger-mirror.ts keys its
    // resolution on `AND status = 'submitted'`) and /api/feed selects the
    // column with no WHERE clause, so unresolved rows reached the browser.
    assert.equal(tradeOutcome("submitted"), "pending");
    assert.equal(tradeOutcome("armed"), "pending");
    assert.equal(tradeOutcome("something-added-next-year"), "pending");
  });

  it("and the states that ARE resolved keep their meaning", () => {
    assert.equal(tradeOutcome("landed"), "landed");
    assert.equal(tradeOutcome("paper"), "landed");
    assert.equal(tradeOutcome("rejected"), "refused");
    assert.equal(tradeOutcome("reverted"), "reverted");
  });

  it("INVARIANT: the mapper is an allow-list, not a negation", () => {
    const src = code(at("./live.ts"));
    const i = src.indexOf("export function tradeOutcome");
    assert.ok(i > 0);
    const body = src.slice(i, i + 400);
    assert.ok(!/!==/.test(body), "a negation lets an unknown status through as a fill");
    assert.match(body, /return "pending"/, "anything unrecognised is unresolved");
  });
});

describe("a ledger timestamp is UTC, and is read as UTC", () => {
  it("REGRESSION: a space-separated stamp is not local time", () => {
    // lib/ledger.ts writes `toISOString().slice(0,19).replace("T"," ")` — a UTC
    // instant with the marker filed off. Date.parse of that is LOCAL in every
    // engine, so every age and the whole daily-spend gauge were out by the
    // viewer's offset.
    const seconds = 1_788_600_000;
    const written = new Date(seconds * 1000).toISOString().slice(0, 19).replace("T", " ");
    assert.equal(ledgerSeconds(written), seconds);
  });

  it("an unparseable stamp is zero, not NaN", () => {
    assert.equal(ledgerSeconds("not a date"), 0);
    assert.equal(ledgerSeconds(""), 0);
  });
});

describe("an unreadable ledger is not a quiet one", () => {
  it("`source: \"none\"` means the read failed, however the request went", () => {
    // Every reader in web/src/lib publishes this shape rather than throwing,
    // so a 200 carrying it is a failure wearing a success's status code.
    assert.equal(readStateOf({ source: "none" }), "unreadable");
    assert.equal(readStateOf(null), "unreadable");
    assert.equal(readStateOf(undefined), "unreadable");
    assert.equal(readStateOf({ source: "sqlite" }), "ok");
    assert.equal(readStateOf({}), "ok", "a read with no source field answered");
  });

  it("the seed has asked nobody anything", () => {
    const seeded = seedLive();
    for (const [k, v] of Object.entries(seeded.reads)) {
      assert.equal(v, "unread", `${k} must start unread, not ok`);
    }
  });

  it("INVARIANT: the two lists that make claims about the world branch on the read", () => {
    // "Quiet." and "Nobody has traded yet." are affirmative statements. Both
    // shipped reachable from an empty seed and from a database outage.
    for (const [file, claim] of [
      ["./screens/Feed.tsx", "Quiet."],
      ["./screens/Board.tsx", "Nobody has traded yet."],
    ] as const) {
      const src = at(file);
      const i = src.indexOf(claim);
      assert.ok(i > 0, `${file} no longer contains ${claim} — update this test with it`);
      const around = src.slice(Math.max(0, i - 500), i + 200);
      assert.match(around, /ReadEmpty/, `${file} must render ${claim} only through ReadEmpty`);
    }
  });

  it("INVARIANT: ReadEmpty cannot say the quiet thing without an `ok` read", () => {
    const src = code(at("./ui.tsx"));
    const i = src.indexOf("export function ReadEmpty");
    assert.ok(i > 0);
    const body = src.slice(i, i + 900);
    assert.match(body, /state === "unread"/);
    assert.match(body, /state === "unreadable"/);
    // The caller's title is the last thing reached, after both refusals.
    const unread = body.indexOf('state === "unread"');
    const unreadable = body.indexOf('state === "unreadable"');
    const title = body.lastIndexOf("title={title}");
    assert.ok(unread < title && unreadable < title, "both refusals must precede the claim");
  });
});

describe("a growth curve is not raw equity", () => {
  it("INVARIANT: the profile chart draws only a growth series", () => {
    // `read-agent.ts` deletes the raw equity field on purpose: "equity_usdg
    // steps up the moment the owner funds the account… so drawn raw it shows a
    // book springing into existence at full value." The terminal profile fell
    // back to the leaderboard row, whose curve is exactly that.
    const src = at("./screens/Profile.tsx");
    const gate = src.indexOf("curveKind");
    const draw = src.indexOf("<PerformanceChart"); // the USE, not the import on line 1
    assert.ok(gate > 0, "the profile must check which quantity the curve is");
    assert.ok(draw > gate, "and it must check before it draws");
  });

  it("INVARIANT: and only when the deposits divided out were evidenced", () => {
    const src = at("./screens/Profile.tsx");
    const gate = src.indexOf("contributionsEvidenced");
    const draw = src.indexOf("<PerformanceChart"); // the USE, not the import on line 1
    assert.ok(gate > 0, "EquityLine's gate must exist on the screen that replaced it");
    assert.ok(draw > gate, "and it must precede the draw");
    assert.match(src, /inferred from balance changes/, "the refusal keeps EquityLine's words");
  });

  it("INVARIANT: the leaderboard row is labelled as equity, so the chart refuses it", () => {
    const src = code(at("./live.ts"));
    assert.match(src, /curveKind: "equity"/, "the board mapper must say what its curve is");
    const app = code(at("./App.tsx"));
    assert.match(app, /curveKind:"growth"/, "and the profile mapper must say what its curve is");
    assert.match(app, /contributionsEvidenced/, "and must carry the gate");
  });

  it("INVARIANT: a failed profile read is disclosed even when a board row exists", () => {
    // `agent = profile ?? listedAgent` makes a failed fetch invisible for any
    // agent that happens to be ranked.
    const src = at("./App.tsx");
    assert.match(
      src,
      /screen\.kind === "profile" && agent && profileError/,
      "the failure must be said even when something rendered",
    );
  });
});

/**
 * THE FOUR THE PRE-MERGE GATE CLASSIFIED AS MUST-HAVE.
 *
 * Everything else in docs/terminal-port-debt.md can follow the launch. These
 * four could not, because each one either states something untrue about money
 * on a public page, or takes the whole product down.
 */
describe("must-have before a public UI", () => {
  it("a paper or quoted entry is never rendered as a settled fill", () => {
    // read-token.ts carries `paper` and `basisSource` and states the rule —
    // "a pretend fill must not look like a real one" — and the port dropped
    // both, so every marker on the public token chart read as somebody's money.
    assert.equal(entryCaveat({ paper: true, basisSource: "paper" }), " — on paper, not a real fill");
    assert.equal(entryCaveat({ paper: false, basisSource: "quote" }), " — an estimate, not a settled fill");
    assert.equal(entryCaveat({ paper: false, basisSource: null }), " — entry price unrecorded");
    assert.equal(entryCaveat({ paper: false, basisSource: "receipt" }), "", "a settled fill needs no caveat");
  });

  it("INVARIANT: both render sites carry it", () => {
    // The chart pin and the holder table are two different surfaces showing the
    // same fact; marking one and not the other is the same omission.
    assert.match(at("./tv.tsx"), /entryCaveat\(seat\)/, "the chart pin's label");
    assert.match(at("./screens/Token.tsx"), /entryCaveat\(seat\)/, "the holder table's chip");
    assert.match(at("./bars.ts"), /paper: boolean;/, "and Seat carries the fields at all");
  });

  it("INVARIANT: the public profile shows paper fills beside landed ones", () => {
    // `landed` alone published "0 Completed trades" for an agent with ten
    // simulated fills. read-agent.ts keeps the counters apart on purpose —
    // folding them would re-arm the +2643.3% incident — so both must show.
    const src = at("./screens/Profile.tsx");
    const landed = src.indexOf("Completed trades");
    const paper = src.indexOf("filledPaper");
    assert.ok(landed > 0 && paper > 0, "both counters must be rendered");
    assert.match(src, /simulated, not real money/, "and the paper one says what it is");
  });

  it("INVARIANT: the price axis cannot render a real price as $0.00", () => {
    // A coin here trades at 2.8e-6. The axis was switched on for desktop with
    // no formatter, so the library's default rendered that as "$0.00" — a real
    // number displayed as nothing.
    const src = at("./tv.tsx");
    const scale = src.indexOf("rightPriceScale");
    const fmt = src.indexOf("priceFormatter");
    assert.ok(fmt > 0, "the axis needs the same formatter the text readout has");
    assert.ok(fmt > scale, "declared with the scale it formats");
    assert.match(src, /coinPrice\(v\)/, "and it is the app's own formatter, not a second one");
  });

  it("INVARIANT: a chart that cannot draw does not unmount the product", () => {
    // App.tsx mounts eleven screens in one tree with no lazy and no Suspense,
    // and the chart is a third-party renderer driven from an effect with no
    // try. CandleChart learned this once: "A chart that will not load must not
    // take the page with it."
    assert.match(at("./Boundary.tsx"), /getDerivedStateFromError/);
    for (const screen of ["./screens/Token.tsx", "./screens/Profile.tsx"]) {
      assert.match(at(screen), /<Boundary label=/, `${screen} must wrap its chart`);
    }
  });
});

/**
 * A FIFTH INVARIANT, from the first screenshot a tester sent of the fleet page:
 * six agents, each captioned "Strategy not published", each with a long dash
 * where a number goes. Both were structural, not slow — one hard-coded
 * constant printed once per agent, and a field nothing in the tree ever sets.
 *
 * A blank that will never fill is worse than an absent column: it reads as
 * data still loading, so a reader waits for something that is not coming.
 */
describe("a screen may not promise what it can never show", () => {
  it("THE AGENT ROWS DO NOT PRINT A CONSTANT ONCE PER AGENT", () => {
    // `publicGlance()` takes no arguments and hard-codes `known:false`, so
    // "Strategy not published" was one fact about the product rendered as six
    // facts about six agents. The wire has never carried a strategy and is not
    // going to — an owner's configuration is theirs.
    for (const f of ["./Desktop.tsx", "./screens/Board.tsx"]) {
      assert.ok(
        !code(at(f)).includes("Strategy not published"),
        `${f} still prints the unpublishable-strategy constant on every row`,
      );
    }
  });

  it("and they print something they can actually know", () => {
    // `landed` and `filledPaper` are on the wire for every agent.
    assert.match(code(at("./Desktop.tsx")), /tradeLine\(a\)/);
    assert.match(code(at("./screens/Board.tsx")), /tradeLine\(a\)/);
  });

  it("A SIMULATED FILL IS NOT A TRADE, in the one line that counts them", async () => {
    // read-agent.ts refuses to fold these together and records why: the page
    // once read "filled 0" beside ten posts saying "filled on paper".
    const { tradeLine } = await import("./screens/Board");
    const agent = (over: Partial<LiveAgent>) =>
      ({ slug: "a", name: "A", handle: null, pnlBps: null, curve: [], landed: 0, ...over }) as LiveAgent;
    assert.equal(tradeLine(agent({ landed: 3 })), "3 trades");
    assert.equal(tradeLine(agent({ landed: 1 })), "1 trade");
    assert.equal(tradeLine(agent({ landed: 0, filledPaper: 7 })), "7 on paper");
    assert.equal(tradeLine(agent({ landed: 0 })), "No trades yet");
    // A landed fill is never described as paper, even when both exist.
    assert.equal(tradeLine(agent({ landed: 2, filledPaper: 9 })), "2 trades");
  });

  it("no row renders a holdings figure nothing sets", () => {
    // `holdingsUsd` is declared on LiveAgent and assigned by nothing, so the
    // column showed your own equity and a dash for everybody else.
    const setters = code(at("./live.ts")).match(/holdingsUsd\s*:/g) ?? [];
    assert.equal(setters.length, 0, "if something now sets holdingsUsd, the column may come back");
    for (const f of ["./Desktop.tsx", "./screens/Board.tsx"]) {
      assert.ok(!code(at(f)).includes("haveOf("), `${f} still renders the unfillable holdings figure`);
    }
  });

  it("THE DAILY CHANGE WINDOW CAN ACTUALLY REACH A DAY", () => {
    // "Daily change unavailable" was honest about what the browser held and
    // wrong about why: chg24 needs a point 24h old, and the feed returned the
    // newest 288 equity rows — 19.2 hours at the production tick of 240s. An
    // honest label over a window bug is the most expensive kind of correct.
    const route = at("../app/api/feed/route.ts");
    const m = route.match(/ORDER BY at DESC, id DESC LIMIT (\d+)/);
    assert.ok(m, "the equity window must still be bounded");
    const rows = Number(m![1]);
    const worstTickSec = 240;
    assert.ok(
      (rows * worstTickSec) / 3600 > 24,
      `${rows} rows at ${worstTickSec}s a row spans ${((rows * worstTickSec) / 3600).toFixed(1)}h — a daily change cannot exist`,
    );
  });

  it("the balance is not restated under the figure that already prints it", () => {
    assert.match(code(at("./screens/You.tsx")), /restate=\{false\}/);
    // And the chart still says what it is a chart OF.
    assert.match(code(at("./DitherChart.tsx")), /<span>\{label\}<\/span>/);
  });
});
